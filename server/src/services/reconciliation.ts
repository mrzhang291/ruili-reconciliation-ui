import path from "node:path";
import { deleteStoredFilePath, saveUploadedFile, type StoredFile } from "../lib/file-storage.js";
import { config } from "../lib/config.js";
import { appendTaskProgress, initializeTaskProgress } from "../lib/task-progress.js";
import {
  resolveAgentSession,
  sendReconciliationPrompt,
  deleteAgentSession,
  CherryStudioError,
  type AgentSelector,
  type CherryAgentSession,
  type ReconciliationResult,
} from "../lib/cherrystudio.js";
import { cleanupTaskWorkDir, prepareTaskWorkDir } from "../lib/runtime-storage.js";
import { LarkKnowledgeError, loadKnowledgeInstructions } from "../lib/lark-knowledge.js";
import {
  applyTaskResult,
  cancelTaskRecord,
  createTaskRecord,
  failTaskRecord,
  getTaskRecord,
  uploadTaskAttachment,
} from "../lib/lark-store.js";

export type ProgressLog = {
  id: string;
  timestamp: string;
  level: "info" | "success" | "error";
  message: string;
  details?: string;
  expanded?: boolean;
};

export type CreateReconciliationInput = {
  settlementFile?: { buffer: Buffer; originalName: string; contentType: string };
  settlementFiles?: Array<{ buffer: Buffer; originalName: string; contentType: string }>;
  agentSelector: AgentSelector & { name: string };
  batchId?: string;
  settlementHint?: {
    name?: string;
    period?: string;
    documentLabel?: string;
    documentLabels?: string[];
  };
  onProgress?: (log: ProgressLog) => void;
  onQueued?: (result: { taskId: string; status: "PROCESSING" }) => void | Promise<void>;
  onSettled?: (result: { taskId: string; status: string; message: string | null }) => void | Promise<void>;
};

type ActiveReconciliation = {
  controller: AbortController;
  target?: CherryAgentSession;
  batchId: string;
  files: { settlement: StoredFile; settlements: StoredFile[]; settlementHint?: CreateReconciliationInput["settlementHint"] };
};

const activeReconciliations = new Map<string, ActiveReconciliation>();
const maxConcurrentReconciliations = config.reconciliation.maxConcurrentTasks;
const pendingReconciliationRuns: Array<{ taskId: string; run: () => Promise<void> }> = [];
const queuedReconciliationTaskIds = new Set<string>();
let runningReconciliationCount = 0;

function scheduleReconciliation(taskId: string, run: () => Promise<void>) {
  queuedReconciliationTaskIds.add(taskId);
  pendingReconciliationRuns.push({ taskId, run });
  drainReconciliationQueue();
}

function drainReconciliationQueue() {
  while (runningReconciliationCount < maxConcurrentReconciliations && pendingReconciliationRuns.length) {
    const next = pendingReconciliationRuns.shift();
    if (!next) return;
    runningReconciliationCount += 1;
    void (async () => {
      queuedReconciliationTaskIds.delete(next.taskId);
      await next.run();
    })().finally(() => {
      runningReconciliationCount -= 1;
      drainReconciliationQueue();
    });
  }
}

export function hasInFlightReconciliationTask(taskId: string) {
  return queuedReconciliationTaskIds.has(taskId) || activeReconciliations.has(taskId);
}

export function getActiveTaskFile(taskId: string, kind: "SETTLEMENT" | "ERP") {
  const active = activeReconciliations.get(taskId);
  return kind === "SETTLEMENT" ? active?.files.settlement : undefined;
}

function emit(
  onProgress: CreateReconciliationInput["onProgress"],
  level: ProgressLog["level"],
  message: string,
  options?: Partial<Pick<ProgressLog, "id" | "details" | "expanded">>,
) {
  onProgress?.({
    id: options?.id ?? crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    level,
    message,
    details: options?.details,
    expanded: options?.expanded,
  });
}

function settlementFileInputs(input: CreateReconciliationInput) {
  const files = input.settlementFiles?.length ? input.settlementFiles : input.settlementFile ? [input.settlementFile] : [];
  if (!files.length) throw new Error("至少需要一份结算资料");
  return files;
}

function saveTaskFiles(input: CreateReconciliationInput) {
  const settlements = settlementFileInputs(input).map((file) => saveUploadedFile(file.buffer, file.originalName, file.contentType));
  return {
    settlement: settlements[0],
    settlements,
    settlementHint: input.settlementHint,
  };
}

export async function createReconciliationTask(input: CreateReconciliationInput) {
  let taskId: string | null = null;
  const pendingLogs: ProgressLog[] = [];
  const onProgress = (log: ProgressLog) => {
    if (taskId) appendTaskProgress(taskId, log);
    else pendingLogs.push(log);
    input.onProgress?.(log);
  };
  emit(onProgress, "info", "开始创建飞书对账任务…");

  const files = saveTaskFiles(input);
  const batchId = input.batchId ?? crypto.randomUUID();
  try {
    taskId = await createTaskRecord({
      name: input.settlementHint?.documentLabel ?? files.settlement.originalName,
      batchId,
    });
  } catch (error) {
    for (const settlement of files.settlements) deleteStoredFilePath(settlement.absolutePath);
    throw error;
  }

  initializeTaskProgress(taskId, pendingLogs);
  emit(onProgress, "success", `飞书任务已创建（记录 ID：${taskId}）`);
  emit(onProgress, "info", files.settlements.length > 1
    ? `任务已进入解析队列，本任务包含 ${files.settlements.length} 份同组结算资料，将合并后一次对账`
    : `任务已进入解析队列，最多同时处理 ${maxConcurrentReconciliations} 个对账任务`);
  try {
    await input.onQueued?.({ taskId, status: "PROCESSING" });
  } catch (error) {
    console.error(`[reconciliation] 同步任务 ${taskId} 入队状态失败`, error);
    emit(onProgress, "error", "同步批量任务入队状态失败，任务将继续执行");
  }
  scheduleReconciliation(taskId, () => runReconciliation(taskId, batchId, files, input.agentSelector, onProgress, input.onSettled));
  return { id: taskId, status: "PROCESSING" as const };
}

async function runReconciliation(
  taskId: string,
  batchId: string,
  files: ActiveReconciliation["files"],
  agentSelector: AgentSelector,
  onProgress?: CreateReconciliationInput["onProgress"],
  onSettled?: CreateReconciliationInput["onSettled"],
) {
  const active: ActiveReconciliation = { controller: new AbortController(), batchId, files };
  activeReconciliations.set(taskId, active);
  let taskWorkDir = "";
  let settled = false;
  const settle = async (status: string, message: string | null) => {
    if (settled) return;
    settled = true;
    try {
      await onSettled?.({ taskId, status, message });
    } catch (error) {
      console.error(`[reconciliation] 同步任务 ${taskId} 完成状态失败`, error);
    }
  };

  try {
    taskWorkDir = prepareTaskWorkDir(taskId);
    emit(onProgress, "info", files.settlements.length > 1
      ? `正在把 ${files.settlements.length} 份结算原始文件保存到飞书附件字段…`
      : "正在把结算原始文件保存到飞书附件字段…");
    for (const settlement of files.settlements) {
      await uploadTaskAttachment(taskId, "结算文件", settlement.absolutePath);
    }
    emit(onProgress, "success", files.settlements.length > 1 ? "同组结算原始文件已保存到飞书" : "结算原始文件已保存到飞书");

    const current = await getTaskRecord(taskId);
    if (!current || current.status !== "PROCESSING" || current.batchId !== batchId) return;

    emit(onProgress, "info", "正在从飞书知识规则表读取本次规则…");
    const knowledge = await loadKnowledgeInstructions();
    emit(onProgress, "success", `已加载 ${knowledge.ruleVersions.length} 条飞书知识规则`);

    const result = await extractSettlementWithAgent({
      active,
      agentSelector,
      knowledgeInstructions: knowledge.instructions,
      onProgress,
      settlementFileUrl: `http://127.0.0.1:${config.port}/api/tasks/${taskId}/files/SETTLEMENT`,
      settlementFilePath: files.settlement.absolutePath,
      settlementFileName: files.settlement.originalName,
      settlementFiles: files.settlements.map((settlement) => ({
        path: settlement.absolutePath,
        name: settlement.originalName,
      })),
      settlementHint: files.settlementHint,
      submittedAt: new Date().toISOString(),
      taskId,
      taskWorkDir,
    });

    const applied = await applyTaskResult(taskId, batchId, result, knowledge.ruleVersions);
    if (applied) emit(onProgress, "success", `对账完成：${result.name}，权威差额 ${result.difference.toFixed(2)} 元`);
    const completed = await getTaskRecord(taskId);
    await settle(completed?.status ?? "FAILED", completed?.failureReason ?? null);
  } catch (error) {
    if (active.controller.signal.aborted || (await getTaskRecord(taskId))?.status === "CANCELLED") {
      await settle("CANCELLED", "对账任务已由用户停止");
      return;
    }
    const message = error instanceof Error ? error.message : "对账处理失败";
    const code = error instanceof CherryStudioError || error instanceof LarkKnowledgeError ? error.code : "RECONCILIATION_FAILED";
    emit(onProgress, "error", message);
    const failureMessage = `${code}: ${message}`;
    try {
      await failTaskRecord(taskId, batchId, failureMessage);
    } catch {
      // 飞书不可用时无法回写失败状态，保留原始错误日志。
    }
    await settle("FAILED", failureMessage);
  } finally {
    try {
      cleanupTaskWorkDir(taskId);
      for (const settlement of files.settlements) deleteStoredFilePath(settlement.absolutePath);
    } catch (error) {
      console.error(`[cleanup] 清理任务临时文件 ${taskId} 失败`, error);
    }
    if (activeReconciliations.get(taskId) === active) activeReconciliations.delete(taskId);
  }
}

async function extractSettlementWithAgent(params: {
  active: ActiveReconciliation;
  agentSelector: AgentSelector;
  knowledgeInstructions: string;
  onProgress?: CreateReconciliationInput["onProgress"];
  settlementFileUrl: string;
  settlementFilePath: string;
  settlementFileName: string;
  settlementFiles?: Array<{ path: string; name: string }>;
  settlementHint?: CreateReconciliationInput["settlementHint"];
  submittedAt: string;
  taskId: string;
  taskWorkDir: string;
}): Promise<ReconciliationResult> {
  const prompt = buildReconciliationPrompt(params);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    emit(params.onProgress, "info", attempt === 1 ? "正在连接 CherryStudio Agent…" : "正在重试 CherryStudio Agent（第 2 次）…");
    let target: CherryAgentSession | null = null;

    try {
      target = await resolveAgentSession(
        params.agentSelector,
        buildReconciliationSessionInstructions(params.knowledgeInstructions),
        (level, message, options) => emit(params.onProgress, level, message, options),
        params.active.controller.signal,
      );
      params.active.target = target;
      emit(params.onProgress, "info", "提示词已生成，正在提交至 Agent…");
      return await sendReconciliationPrompt(
        target,
        prompt,
        (level, message, options) => emit(params.onProgress, level, message, options),
        params.active.controller.signal,
      );
    } catch (error) {
      lastError = error;
      if (params.active.controller.signal.aborted || attempt >= 2) throw error;
      emit(params.onProgress, "error", "Agent 本次识别失败，准备自动重试一次", {
        details: error instanceof Error ? error.message : String(error),
        expanded: true,
      });
      if (target) {
        try {
          await deleteAgentSession(target);
        } catch (deleteError) {
          console.error(`[reconciliation] 重试前清理 CherryStudio Session ${target.sessionId} 失败`, deleteError);
        }
      }
      params.active.target = undefined;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Agent 识别失败");
}

function buildReconciliationSessionInstructions(knowledgeInstructions: string) {
  return `${knowledgeInstructions}

【本次对账输出硬性契约】
当前项目由后端负责写入飞书 Base；Agent 不要写入钉钉或飞书，只负责读取结算单、调用 ERP/DRP MCP、返回最终 JSON。
最终回复必须只包含一个合法 JSON 对象，不要 Markdown、标题、解释、工具过程、写入说明或额外字段。
顶层必须且只能包含 settlementAmount、settlementAmountLabel、salesTotal、netSalesTotal、erpBasis、erpAmount、difference、matched、basisReason、issues、period、name 十二个字段。
salesTotal 和 netSalesTotal 必须来自 ERP/DRP MCP；difference 必须等于 erpAmount - settlementAmount；issues 必须是字符串。`;
}

export async function cancelReconciliationTask(taskId: string) {
  const task = await getTaskRecord(taskId);
  if (!task) return { outcome: "not_found" as const };
  if (!["PROCESSING", "QUEUED"].includes(task.status)) return { outcome: "already_finished" as const, status: task.status };
  await cancelTaskRecord(taskId, "对账任务已由用户停止");

  const active = activeReconciliations.get(taskId);
  active?.controller.abort(new Error("对账任务已由用户停止"));
  appendTaskProgress(taskId, {
    id: crypto.randomUUID(), timestamp: new Date().toISOString(), level: "success", message: "对账任务已停止",
  });

  let sessionStopped = false;
  if (active?.target) {
    try {
      await deleteAgentSession(active.target);
      sessionStopped = true;
    } catch (error) {
      console.error(`[reconciliation] 停止 CherryStudio Session ${active.target.sessionId} 失败`, error);
    }
  }
  return { outcome: "cancelled" as const, status: "CANCELLED" as const, sessionStopped };
}

export function buildReconciliationPrompt(params: {
  settlementFileUrl: string;
  settlementFilePath: string;
  settlementFileName: string;
  settlementFiles?: Array<{ path: string; name: string }>;
  settlementHint?: CreateReconciliationInput["settlementHint"];
  submittedAt: string;
  taskId: string;
  taskWorkDir: string;
}) {
  const settlementUrl = params.settlementFileUrl;
  const settlementFiles = params.settlementFiles?.length
    ? params.settlementFiles
    : [{ path: params.settlementFilePath, name: params.settlementFileName }];
  const settlementFileNames = settlementFiles.map((file) => file.name).join("；");
  const settlementFileList = settlementFiles
    .map((file, index) => `- 结算单${index + 1}：${file.path}（文件名：${file.name}${index === 0 ? `；下载入口：${settlementUrl}` : ""}）`)
    .join("\n");
  const multiFileNotice = settlementFiles.length > 1
    ? `本次任务由 ${settlementFiles.length} 份同店同账期结算资料组成；它们是同一账单的拆分文件，必须作为一份完整结算单一起读取、合计后再对 ERP/DRP，只输出一个最终结果。不要按单个文件分别对账，也不要只读取其中一份。`
    : `${settlementUrl}\n这是结算单`;
  const projectRoot = resolveProjectRootFromTaskWorkDir(params.taskWorkDir);
  const mineruScriptPath = path.join(projectRoot, ".claude", "my_script", "mineru_to_markdown.py");
  const shellProjectRoot = toSingleQuotedShellPath(projectRoot);
  const mcpCommand = `cd ${shellProjectRoot} && { printf '%s\\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}'; sleep 1; printf '%s\\n' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"summarize_store_period","arguments":{"mall_name":"<替换为name>","period":"<替换为period>"}}}'; sleep 2; } | RUILI_RECONCILIATION_API=http://127.0.0.1:${config.port} node scripts/erp-base-mcp.mjs`;
  const hints = [
    params.settlementHint?.name ? `- 参考主体：${params.settlementHint.name}` : "",
    params.settlementHint?.period ? `- 参考账期：${params.settlementHint.period}` : "",
    params.settlementHint?.documentLabels?.length ? `- 同组文件：${params.settlementHint.documentLabels.join("；")}` : "",
  ].filter(Boolean);

  return `我有一个对账任务：

${multiFileNotice}

结算单文件名：${settlementFileNames}
请从结算单正文确定本次商城/结算主体和账期。name 字段输出你用于调用 ERP/DRP MCP 的 mall_name 或与 ERP/DRP 更稳定匹配的主体标识。
${hints.length ? `以下信息只是前端或预检提供的参考，必须以结算单正文和 MCP 查询结果校验后再使用：\n${hints.join("\n")}\n` : ""}

本次任务唯一允许使用的临时工作目录：
${params.taskWorkDir}

如需下载文件、拆分 PDF、渲染图片、执行 OCR 或生成 Markdown/JSON，请只写入上述目录。不要在项目根目录、源码目录或输入文件旁创建文件；不要复制原始文件，优先直接读取以下本地路径：
${settlementFileList}

在过程中，面对图片、PDF 等文件，你可以使用 mineru 这个项目 Subagent 获取 Markdown 格式的内容。
当前项目 MinerU 转换脚本绝对路径：${mineruScriptPath}
如果 mineru Subagent 运行在隔离 worktree 中，'.claude/my_script/mineru_to_markdown.py' 可能不存在；此时必须改用上面的绝对脚本路径。
如果结算单是 .xlsx 或 .xls，禁止使用 MinerU、OCR 或 Subagent 读取；请直接用 PYTHONUTF8=1 PYTHONIOENCODING=utf-8 python ... 调用 openpyxl/xlrd 读取工作表。
在 Windows 或 Git Bash 环境执行 Python/MinerU 脚本时，严禁运行 python3；不要先调用 WindowsApps 里的 python3，本机 python3 指向 WindowsApps 占位命令且会失败。必须使用 PYTHONUTF8=1 PYTHONIOENCODING=utf-8 python ...，如果 python 不可用再用 py ...。如果调用 mineru Subagent，请把这条 Python 约束原文转交给 Subagent。

请按下面三步完成：
1. 使用 MinerU 或视觉能力读取全部结算单，得到合并后的 A：主体、period、与 ERP/DRP 可比的结算金额字段、字段证据和疑点。
2. 统一执行下方“本地 MCP JSON-RPC 命令”查询 ERP/DRP，入参必须是 {"mall_name":"从结算单确定的主体","period":"YYYY-MM"}，得到 B：sales_total、net_sales_total 和必要明细。sales_total 表示扣点前销售额，net_sales_total 表示扣点后金额。若参考主体存在，首次 MCP 查询优先使用参考主体；商场公司名、客户名、客户代码通常不是 ERP 店铺号，只有 MCP 能命中时才采用。MCP 没有匹配记录、非法月份、表头错误或工具失败时，不要把金额当成 0，也不要编造 B。
3. 用结算单金额分别比较 sales_total 和 net_sales_total，根据结算单字段、店铺规则和业务证据判断本次应对扣点前还是扣点后；金额接近度只能在字段证据不清楚时作为兜底，不能覆盖明确字段口径。无法判断时 erpBasis 输出 ambiguous，并将 erpAmount 取两者中与结算金额差额绝对值更小的金额。difference 固定为 erpAmount - settlementAmount；差额绝对值超过 200 元必须在 issues 中说明。

结算单字段如果写“实销金额”“实际销售”“本期实销”“销售收入”“销售金额”“销售额”“总销售额”“本月销售”“门店销售额”“营业额”等，通常表示扣点前销售口径；“应付销售额”仍然是销售额口径。商品折扣、促销折让后的实销仍不等于商场扣点/提成/分成后的净额，应优先对 sales_total。只有字段明确为“净营业额”“开票金额”“发票金额”“销售成本”“含税/不含税结账金额”“供应商应得”“应付金额/付款金额”“本期应结”“结算金额”等，且业务证据显示已扣除扣点/提成/分成后，才优先对 net_sales_total。
商场结算单如果同时列出“本期销售/本期实销金额”和“扣率、提成、其他扣率、变扣额、合同变扣、赠券承担、会员折扣、支付手续费、仓储/物业/推广等扣减”，且下方还有“含税进价金额、含税/不含税结账金额、应付/开票金额”等扣后字段，不要机械选择“本期销售/本期实销金额”。必须先复核这些扣减后的可比金额是否更接近 ERP/DRP sales_total 或 net_sales_total；如果 ERP 金额明显更接近扣后/进价/结账字段，或 sales_total 与本期销售差额异常大且说明“结算单与 ERP 销售范围或数据口径明显不一致”，应在 issues 中标明范围/口径不可比，不要把该 full-shop 差额当成普通业务差额。
如果结算单顶部或汇总区有“付款金额/销售金额/销售额”，同时下方有“营业额提成/销售提成/固定扣款”并得到“应开票金额/本期应付金额”，且顶部金额与 ERP/DRP sales_total 在 200 元内对平，应优先选择顶部销售/付款金额对 sales_total；不要选择扣后的应开票金额去对 net_sales_total 制造差额。
结算单中的“实际应付”“实际付款”“本期应结款额”等最终付款金额，如果是在销售额/提成后金额基础上再扣除水电、物业、储值卡、会员、广告、公摊、账扣费用或现金扣款，只能作为审核证据，不能默认作为 settlementAmount。除非飞书知识规则明确该店按最终付款口径对账，settlementAmount 应优先选择能对应 sales_total 或 net_sales_total 的字段，例如销售额、实际销售、销售收入、本期销售额、本期结算、应付金额、销售成本、开票金额等。
如果 erpBasis 明确且 difference 绝对值不超过 200 元，应输出 matched=true；普通舍入、尾差或阈值内自然差额不要写入 issues，issues 只记录需要人工审核的异常。
金额和口径已经可确定且 difference 绝对值不超过 200 元时，只有会影响 settlementAmount 或 ERP/DRP 口径可信度的异常才写入 issues；不要把不影响本次 sales_total/net_sales_total 对比的扣率说明、费用科目说明、内部比例观察写入 issues。
如果 MCP 返回多条明细，而结算单明显只覆盖其中一部分合同、铺位、扣率或活动，不要把店铺号汇总金额强行解释为普通差额。必须先用 MCP rows 按扣率行枚举可疑子集：若某个子集在 200 元内且能被结算单合同/铺位/扣率/活动证据支持，在 issues 中写明“ERP子集可对平，需按该范围复核”；若没有子集可对平，在 issues 开头写明“ERP聚合范围与结算单范围不一致，范围不可比”，列出最接近的扣率子集及其差额，并说明 full-shop difference 仅用于定位范围缺口，不作为可结算差额或业务定责金额。最终 JSON 的 salesTotal/netSalesTotal 仍必须是 MCP 返回的全店汇总值，difference 仍按 erpAmount - settlementAmount 填写以满足后端契约。

当前项目 ERP/DRP MCP 配置：
- server id：wd3FCVOL5nMNLODNeRfOr
- 工具名：summarize_store_period
- 本地配置文件：${path.join(projectRoot, ".mcp.json")}
- 本地服务脚本：${path.join(projectRoot, "scripts", "erp-base-mcp.mjs")}

ERP/DRP MCP 查询必须由当前会话直接完成，不要交给 Subagent。不要调用 CherryStudio 原生工具列表里的 mcp__wd3FCVOL5nMNLODNeRfOr__summarize_store_period；该名称可能指向用户本机历史残留的过期远端配置。请直接执行下面的本地 MCP JSON-RPC 命令，并把 <替换为name> 与 <替换为period> 换成结算单识别出的值：

${mcpCommand}

特别注意：中间分析、工具返回、Subagent 报告都不能替代最终回答。最终回答必须由你合成一个可被后端直接 JSON.parse 的对象；禁止输出报告、列表、标题、Markdown、代码块、工具过程或“已完成”说明。不要调用钉钉或飞书写入工具，后端会负责落库。

完成后最后只输出一个合法的 JSON 对象，不要使用 Markdown 代码块，也不要在 JSON 前后输出其他内容。格式例子如下：

{
  "settlementAmount": 100.00,
  "settlementAmountLabel": "结算净营业额",
  "salesTotal": 120.00,
  "netSalesTotal": 100.00,
  "erpBasis": "net_sales_total",
  "erpAmount": 100.00,
  "difference": 0.00,
  "matched": true,
  "basisReason": "该店结算单净营业额通常按扣点后金额对账",
  "issues": "",
  "period": "XXXX-XX",
  "name": "商城名称或店铺号"
}

其中字段类型必须依次为：
- settlementAmount：有限数字，结算单中与 ERP/DRP sales_total 或 net_sales_total 可比的对账金额
- settlementAmountLabel：非空字符串，结算单中该金额对应的字段名或口径
- salesTotal：有限数字，ERP/DRP MCP 返回的 sales_total，扣点前销售额
- netSalesTotal：有限数字，ERP/DRP MCP 返回的 net_sales_total，扣点后金额
- erpBasis：字符串，只能是 "sales_total"、"net_sales_total"、"ambiguous"
- erpAmount：有限数字；erpBasis 为 sales_total 时等于 salesTotal，为 net_sales_total 时等于 netSalesTotal，为 ambiguous 时取更接近 settlementAmount 的一个
- difference：有限数字，必须等于 erpAmount - settlementAmount
- matched：布尔值；只有口径明确且差额绝对值不超过 200 元时才可为 true
- basisReason：非空字符串，说明选择该口径的结算单字段、店铺规则或业务证据
- issues：字符串；没有内容时输出空字符串
- period: 字符串，对账月份，格式必须为 "YYYY-MM"
- name: 非空字符串，必须是本次用于查询 ERP/DRP MCP 的结算主体标识

字段业务含义、金额口径和适用范围只以本次 Session 中加载的飞书知识规则快照为准；金额或字段缺失、未调用 MCP、无法得到可靠 A/B 或算不出合法 difference 时不要编造，后端会拒绝不符合契约的结果。`;
}

function resolveProjectRootFromTaskWorkDir(taskWorkDir: string) {
  const normalized = path.resolve(taskWorkDir);
  const marker = `${path.sep}.runtime${path.sep}tasks${path.sep}`;
  const index = normalized.indexOf(marker);
  return index >= 0 ? normalized.slice(0, index) : path.resolve(normalized, "..", "..");
}

function toSingleQuotedShellPath(filePath: string) {
  return `'${filePath.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
}
