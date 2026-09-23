import fs from "node:fs";
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
  startTaskRecord,
  uploadTaskAttachment,
} from "../lib/lark-store.js";
import {
  claimNextPersistedReconciliationRun,
  enqueuePersistedReconciliationRun,
  findPersistedReconciliationRun,
  recoverPersistedReconciliationRuns,
  removePersistedReconciliationRun,
  type PersistedReconciliationRun,
  type QueuedSettlementFile,
} from "../lib/reconciliation-queue.js";

export type ProgressLog = {
  id: string;
  timestamp: string;
  level: "info" | "success" | "error";
  message: string;
  details?: string;
  expanded?: boolean;
};

export type CreateReconciliationInput = {
  settlementFile?: ReconciliationInputFile;
  settlementFiles?: ReconciliationInputFile[];
  agentSelector: AgentSelector & { name: string };
  batchId?: string;
  batchDocumentIds?: string[];
  settlementHint?: {
    name?: string;
    period?: string;
    documentLabel?: string;
    documentLabels?: string[];
  };
  onProgress?: (log: ProgressLog) => void;
};

export type ReconciliationInputFile =
  | { buffer: Buffer; originalName: string; contentType: string; deleteAfterRun?: boolean }
  | { file: StoredFile; deleteAfterRun?: boolean };

type TaskFiles = {
  settlement: StoredFile;
  settlements: Array<QueuedSettlementFile>;
  settlementHint?: CreateReconciliationInput["settlementHint"];
};

type ActiveReconciliation = {
  controller: AbortController;
  target?: CherryAgentSession;
  batchId: string;
  files: TaskFiles;
};

const activeReconciliations = new Map<string, ActiveReconciliation>();
const maxConcurrentReconciliations = config.reconciliation.maxConcurrentTasks;
const queuedReconciliationTaskIds = new Set<string>();
const progressListeners = new Map<string, CreateReconciliationInput["onProgress"]>();
let runningReconciliationCount = 0;

type BatchTaskLifecycle = {
  onQueued?: (params: { batchId: string; documentIds: string[]; taskId: string }) => void | Promise<void>;
  onStarted?: (params: { batchId: string; documentIds: string[]; taskId: string }) => void | Promise<void>;
  onSettled?: (params: { batchId: string; documentIds: string[]; taskId: string; status: string; message: string | null }) => void | Promise<void>;
};

let batchTaskLifecycle: BatchTaskLifecycle | null = null;

export function registerBatchTaskLifecycle(lifecycle: BatchTaskLifecycle) {
  batchTaskLifecycle = lifecycle;
}

function notifyBatchTaskLifecycle(
  event: keyof BatchTaskLifecycle,
  item: Pick<PersistedReconciliationRun, "batchId" | "batchDocumentIds" | "taskId">,
  result?: { status: string; message: string | null },
) {
  const documentIds = item.batchDocumentIds ?? [];
  const callback = batchTaskLifecycle?.[event];
  if (!documentIds.length || !callback) return Promise.resolve();
  const payload = event === "onSettled"
    ? { batchId: item.batchId, documentIds, taskId: item.taskId, status: result?.status ?? "FAILED", message: result?.message ?? null }
    : { batchId: item.batchId, documentIds, taskId: item.taskId };
  return Promise.resolve(callback(payload as never)).catch((error) => {
    console.error(`[reconciliation] 同步批量任务 ${item.taskId} 状态失败`, error);
  });
}

function scheduleReconciliation(taskId: string) {
  queuedReconciliationTaskIds.add(taskId);
  drainReconciliationQueue();
}

function drainReconciliationQueue() {
  while (runningReconciliationCount < maxConcurrentReconciliations) {
    const next = claimNextPersistedReconciliationRun();
    if (!next) return;
    runningReconciliationCount += 1;
    void (async () => {
      queuedReconciliationTaskIds.delete(next.taskId);
      await runReconciliation(next);
    })().finally(() => {
      runningReconciliationCount -= 1;
      drainReconciliationQueue();
    });
  }
}

export function hasInFlightReconciliationTask(taskId: string) {
  // A batch poll can run after the durable enqueue and before scheduleReconciliation
  // updates this process-local set. The persisted queue is the source of truth in
  // that gap (and after a process restart), so do not label the task interrupted.
  return queuedReconciliationTaskIds.has(taskId)
    || activeReconciliations.has(taskId)
    || Boolean(findPersistedReconciliationRun(taskId));
}

export function recoverPersistedReconciliationQueue() {
  const items = recoverPersistedReconciliationRuns();
  for (const item of items) queuedReconciliationTaskIds.add(item.taskId);
  drainReconciliationQueue();
  return items.length;
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

function taskProgressEmitter(taskId: string): CreateReconciliationInput["onProgress"] {
  return (log) => {
    appendTaskProgress(taskId, log);
    progressListeners.get(taskId)?.(log);
  };
}

function settlementFileInputs(input: CreateReconciliationInput) {
  const files = input.settlementFiles?.length ? input.settlementFiles : input.settlementFile ? [input.settlementFile] : [];
  if (!files.length) throw new Error("至少需要一份结算资料");
  return files;
}

function saveTaskFiles(input: CreateReconciliationInput) {
  const settlements = settlementFileInputs(input).map((file) => {
    if ("file" in file) return { file: file.file, deleteAfterRun: file.deleteAfterRun ?? false };
    return {
      file: saveUploadedFile(file.buffer, file.originalName, file.contentType),
      deleteAfterRun: file.deleteAfterRun ?? true,
    };
  });
  return {
    settlement: settlements[0].file,
    settlements,
    settlementHint: input.settlementHint,
  };
}

function deleteOwnedSettlementFiles(files: TaskFiles) {
  for (const settlement of files.settlements) {
    if (settlement.deleteAfterRun) deleteStoredFilePath(settlement.file.absolutePath);
  }
}

function taskFilesFromRun(run: PersistedReconciliationRun): TaskFiles | null {
  const settlement = run.settlements[0]?.file;
  return settlement ? { settlement, settlements: run.settlements, settlementHint: run.settlementHint } : null;
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
    deleteOwnedSettlementFiles(files);
    throw error;
  }

  initializeTaskProgress(taskId, pendingLogs);
  progressListeners.set(taskId, input.onProgress);
  emit(onProgress, "success", `飞书任务已创建（记录 ID：${taskId}）`);
  try {
    emit(onProgress, "info", files.settlements.length > 1
      ? `正在把 ${files.settlements.length} 份结算原始文件保存到飞书附件字段…`
      : "正在把结算原始文件保存到飞书附件字段…");
    for (const settlement of files.settlements) {
      await uploadTaskAttachment(taskId, "结算文件", settlement.file.absolutePath);
    }
    emit(onProgress, "success", files.settlements.length > 1 ? "同组结算原始文件已保存到飞书" : "结算原始文件已保存到飞书");
    const queued = enqueuePersistedReconciliationRun({
      taskId,
      batchId,
      agentSelector: input.agentSelector,
      settlementHint: files.settlementHint,
      settlements: files.settlements,
      batchDocumentIds: input.batchDocumentIds,
    });
    await notifyBatchTaskLifecycle("onQueued", queued);
    emit(onProgress, "info", files.settlements.length > 1
      ? `任务已进入持久化队列，本任务包含 ${files.settlements.length} 份同组结算资料，将合并后一次对账`
      : `任务已进入持久化队列，最多同时处理 ${maxConcurrentReconciliations} 个对账任务`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "任务入队失败";
    try {
      await failTaskRecord(taskId, batchId, `QUEUE_PERSIST_FAILED: ${message}`);
    } catch {
      // 飞书回写失败时保留原始错误，避免把未持久化的任务放进内存队列。
    }
    progressListeners.delete(taskId);
    deleteOwnedSettlementFiles(files);
    throw error;
  }
  scheduleReconciliation(taskId);
  return { id: taskId, status: "QUEUED" as const };
}

async function runReconciliation(run: PersistedReconciliationRun) {
  const taskId = run.taskId;
  const batchId = run.batchId;
  const files = taskFilesFromRun(run);
  if (!files || files.settlements.some((settlement) => !fs.existsSync(settlement.file.absolutePath))) {
    const message = "持久化队列中的结算原件不存在，无法恢复执行";
    try {
      await failTaskRecord(taskId, batchId, `QUEUE_SOURCE_MISSING: ${message}`);
    } catch {
      // 任务状态仍会在下次恢复时再次检查，避免把不存在原件的任务交给 Agent。
    }
    await notifyBatchTaskLifecycle("onSettled", run, { status: "FAILED", message });
    removePersistedReconciliationRun(taskId);
    progressListeners.delete(taskId);
    return;
  }
  const onProgress = taskProgressEmitter(taskId);
  const active: ActiveReconciliation = { controller: new AbortController(), batchId, files };
  activeReconciliations.set(taskId, active);
  let taskWorkDir = "";
  let settled = false;
  const settle = async (status: string, message: string | null) => {
    if (settled) return;
    settled = true;
    await notifyBatchTaskLifecycle("onSettled", run, { status, message });
    removePersistedReconciliationRun(taskId);
  };

  try {
    if (!await startTaskRecord(taskId, batchId)) {
      const current = await getTaskRecord(taskId);
      await settle(current?.status ?? "CANCELLED", current?.cancelReason ?? "对账任务未进入执行状态");
      return;
    }
    await notifyBatchTaskLifecycle("onStarted", run);
    taskWorkDir = prepareTaskWorkDir(taskId);

    const current = await getTaskRecord(taskId);
    if (!current || current.status !== "PROCESSING" || current.batchId !== batchId) return;

    emit(onProgress, "info", "正在从飞书知识规则表读取本次规则…");
    const knowledge = await loadKnowledgeInstructions();
    emit(onProgress, "success", `已加载 ${knowledge.ruleVersions.length} 条飞书知识规则`);

    const result = await extractSettlementWithAgent({
      active,
      agentSelector: run.agentSelector,
      knowledgeInstructions: knowledge.instructions,
      onProgress,
      settlementFileUrl: `http://127.0.0.1:${config.port}/api/tasks/${taskId}/files/SETTLEMENT`,
      settlementFilePath: files.settlement.absolutePath,
      settlementFileName: files.settlement.originalName,
      settlementFiles: files.settlements.map((settlement) => ({
        path: settlement.file.absolutePath,
        name: settlement.file.originalName,
      })),
      settlementHint: files.settlementHint,
      submittedAt: new Date().toISOString(),
      taskId,
      taskWorkDir,
    });

    const applied = await applyTaskResult(taskId, batchId, result, knowledge.ruleVersions);
    if (!applied) {
      const current = await getTaskRecord(taskId);
      if (current?.status === "CANCELLED") {
        await settle("CANCELLED", current.cancelReason ?? "对账任务已由用户停止");
        return;
      }
      throw new Error("对账结果未能完成落库校验，任务状态异常或批次不匹配");
    }
    emit(onProgress, "success", result.missingErp
      ? `对账完成：${result.name}，ERP/DRP 未找到可比明细，已转待审核`
      : `对账完成：${result.name}，权威差额 ${result.difference.toFixed(2)} 元`);
    const completed = await getTaskRecord(taskId);
    await settle(completed?.status ?? "FAILED", completed?.failureReason ?? null);
  } catch (error) {
    let cancelled = active.controller.signal.aborted;
    if (!cancelled) {
      try {
        cancelled = (await getTaskRecord(taskId))?.status === "CANCELLED";
      } catch (statusError) {
        console.error(`[reconciliation] 读取任务 ${taskId} 取消状态失败`, statusError);
      }
    }
    if (cancelled) {
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
      deleteOwnedSettlementFiles(files);
    } catch (error) {
      console.error(`[cleanup] 清理任务临时文件 ${taskId} 失败`, error);
    }
    if (activeReconciliations.get(taskId) === active) activeReconciliations.delete(taskId);
    progressListeners.delete(taskId);
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
      await new Promise((resolve) => setTimeout(resolve, 1_000));
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
salesTotal 和 netSalesTotal 必须来自 ERP/DRP MCP；difference 必须等于 erpAmount - settlementAmount；issues 必须是字符串。仅当 MCP 明确无匹配记录时，salesTotal、netSalesTotal、erpAmount、difference 可同时为 null，erpBasis 必须为 ambiguous、matched 必须为 false，系统会将其作为“ERP金额待核对”而非执行失败。`;
}

export async function cancelReconciliationTask(taskId: string) {
  const task = await getTaskRecord(taskId);
  if (!task) return { outcome: "not_found" as const };
  if (!["PROCESSING", "QUEUED"].includes(task.status)) return { outcome: "already_finished" as const, status: task.status };
  await cancelTaskRecord(taskId, "对账任务已由用户停止");

  const active = activeReconciliations.get(taskId);
  const queued = !active && queuedReconciliationTaskIds.has(taskId)
    ? removePersistedReconciliationRun(taskId)
    : null;
  if (queued) {
    queuedReconciliationTaskIds.delete(taskId);
    for (const settlement of queued.settlements) {
      if (settlement.deleteAfterRun) deleteStoredFilePath(settlement.file.absolutePath);
    }
    await notifyBatchTaskLifecycle("onSettled", queued, { status: "CANCELLED", message: "对账任务已由用户停止" });
    progressListeners.delete(taskId);
  }
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
  const mcpCommand = `cd ${shellProjectRoot} && { printf '%s\\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}'; sleep 1; printf '%s\\n' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"summarize_store_period","arguments":{"mall_name":"<替换为name>","period":"<替换为period>"}}}'; sleep 2; } | RECONCILIATION_API=http://127.0.0.1:${config.port} node scripts/erp-base-mcp.mjs`;
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

如需下载文件、拆分 PDF、渲染图片、执行 OCR 或生成 Markdown/JSON，请只写入上述目录。不要在项目根目录、源码目录或输入文件旁创建文件；不要复制原始文件，优先直接读取以下本地路径。文件路径必须从本提示逐字复制，不得手工重输、合并重复空格或改写文件名：
${settlementFileList}

在过程中，面对图片、PDF 等文件，你可以使用 mineru 这个项目 Subagent 获取 Markdown 格式的内容。
当前项目 MinerU 转换脚本绝对路径：${mineruScriptPath}
如果 mineru Subagent 运行在隔离 worktree 中，'.claude/my_script/mineru_to_markdown.py' 可能不存在；此时必须改用上面的绝对脚本路径。
如果结算单是 .xlsx、.xls 或 .xlsm，禁止使用 MinerU、OCR 或 Subagent 读取；请直接用 PYTHONUTF8=1 PYTHONIOENCODING=utf-8 python ... 调用 openpyxl/xlrd 读取工作表。
在 Windows 或 Git Bash 环境执行 Python/MinerU 脚本时，严禁运行 python3；不要先调用 WindowsApps 里的 python3，本机 python3 指向 WindowsApps 占位命令且会失败。必须使用 PYTHONUTF8=1 PYTHONIOENCODING=utf-8 python ...，如果 python 不可用再用 py ...。如果调用 mineru Subagent，请把这条 Python 约束原文转交给 Subagent。

请按下面三步完成：
1. 使用 MinerU 或视觉能力读取全部结算单，得到合并后的 A：主体、period、与 ERP/DRP 可比的结算金额字段、字段证据和疑点。
2. 统一执行下方“本地 MCP JSON-RPC 命令”查询 ERP/DRP，入参必须是 {"mall_name":"从结算单确定的主体","period":"YYYY-MM"}，得到 B：sales_total、net_sales_total 和必要明细。sales_total 表示扣点前销售额，net_sales_total 表示扣点后金额。若参考主体存在，首次 MCP 查询优先使用参考主体；商场公司名、客户名、客户代码通常不是 ERP 店铺号，只有 MCP 能命中时才采用。MCP 没有匹配记录、非法月份、表头错误或工具失败时，不要把金额当成 0，也不要编造 B；若明确无匹配记录，最终 JSON 中 salesTotal、netSalesTotal、erpAmount、difference 全部填 null，erpBasis 填 ambiguous、matched 填 false，并在 basisReason 和 issues 说明“ERP/DRP 未找到记录”。
3. 本次默认核对“销售额”：先确定结算单的扣点前销售基数，再与 sales_total 比较；net_sales_total 只作扣点后金额的诊断证据。只有飞书知识规则明确指定该店需要按扣点后金额对账时，才可选 net_sales_total。金额接近度不能覆盖明确的字段口径。无法判断时 erpBasis 输出 ambiguous，并将 erpAmount 取两者中与结算金额差额绝对值更小的金额。difference 固定为 erpAmount - settlementAmount；差额绝对值超过 200 元必须在 issues 中说明。

“实销金额”“实际销售”“本期实销”“销售收入”“销售金额”“销售额”“总销售额”“本月销售”“门店销售额”“营业额”等均是扣点前销售口径；“应付销售额”仍是销售额口径，应优先对 sales_total。若表内同时有“净营业额”和“券（折扣）”，且二者相加等于“本月结算营业额小计”，以该小计作为扣点前销售额；没有小计时才计算“净营业额＋券（折扣）”。不要把小计与两个组成项重复相加，settlementAmountLabel 必须写明“本月结算营业额小计（净营业额＋券/折扣）”。
“含税进价金额”“含税/不含税结账金额”“开票金额”“发票金额”“应付/付款金额”“本期应结”等是扣点、费用或税额处理后的字段，只能作为销售额口径和开票金额的辅助证据，不能仅因与 ERP 更接近就替代扣点前销售额。尤其不得根据文件名、备注或“不是含税金额”等字样推断税额口径；只以原件表内的“含税/不含税”字段判断，并在 basisReason 说明实际选取的销售字段。
若结算单含“补入4月”“在6月补入”“跨月冲回/调整”等说明，仍先按扣点前 sales_total 对比；不得把它误写成“范围不可比”。在 issues 第二句注明“存在跨月调整，需按日销售、退货和调整台账核验”，但不得编造系统没有返回的日明细或调整金额。
申请开票阶段出现“预览页面”“请勿用来结算”等底纹本身不影响销售额核对，不要仅因底纹输出审核问题；只有原件明确写有草稿、作废、金额未确认或非正式结算单时才作为审核原因。
如果同组结算单合并后的本期实销/销售额为 0 或负数，不要仅因金额为负就判异常；只要字段口径明确属于销售额口径且与 ERP/DRP sales_total 在 200 元内对平，可输出 matched=true。扣点、手续费、快递费、含税结账金额和最终应付款只作为口径判断证据，除非它们证明 settlementAmount 选错或 ERP/DRP 范围不可比，否则不要写入 issues。
如果 erpBasis 明确、结算单与 ERP 的扣点档完整可比且 difference 绝对值不超过 200 元，才可输出 matched=true；普通舍入、尾差或阈值内自然差额不要写入 issues，issues 只记录需要人工审核的异常。
原件出现“其他扣率”“其他扣点”或“其他费率”且有金额、但没有对应百分比档位、计算依据或合同映射时，这是扣点信息不完整，不是普通手续费：不得忽略。结算单扣点必须写为“已识别档位＋其他扣率金额（未提供档位）”，basisReason 首句写“扣点无法比较”，issues 必须非空，matched 必须为 false，即使金额差绝对值不超过 200 元。只有快递费、手续费、租金、税费、卡费等非扣率费用不会造成扣点档不完整。
金额和口径已经可确定且 difference 绝对值不超过 200 元时，只有会影响 settlementAmount、扣点完整性或 ERP/DRP 口径可信度的异常才写入 issues；不要把不影响本次 sales_total/net_sales_total 对比的普通费用科目说明、内部比例观察写入 issues。
每份对账结果都必须先核对结算单和 ERP 的扣点档位。无论是否有 issues，basisReason 首句固定为“扣点对比：结算单 X%；ERP Y%；扣点一致/不一致/无法比较。”；扣点一致时，首句还必须写“金额差：ERP <erpAmount> − 结算单 <settlementAmount> = <difference> 元。”，后面再简述选用的金额口径。若存在未提供档位的其他扣率，首句必须写“扣点对比：结算单 X%＋其他扣率金额（未提供档位）；ERP Y%；扣点无法比较。”。issues 最多只输出两句：第一句固定为“结算单扣点：X%；ERP扣点：Y%。”，X/Y 写已核实的全部扣点档；第二句必须保留“金额差：ERP <erpAmount> − 结算单 <settlementAmount> = <difference> 元”。如扣点档一致，第二句固定写“扣点档一致；金额差：ERP <erpAmount> − 结算单 <settlementAmount> = <difference> 元。”；存在未提供档位的其他扣率时，第二句写“扣点分档未完整提供；金额差：…；需确认其他扣率对应的合同或活动。”；ERP 多出或缺少档位时，第二句写“ERP 多出/缺少 X 档；金额差：…；扣点/范围未对齐，差异金额仅用于定位，不能直接判定销售额不一致。”。如结算单没有直接列扣点档、但同一销售口径同时明确列出“提成/扣点金额”和“销售额”，可反算一个综合扣点（提成/扣点金额 ÷ 销售额 × 100，先精确计算后按四舍五入保留两位小数；不得估算，也不得把其他扣项金额混入提成/扣点金额）；若同一销售明细明确列出“销售额”和“供应商应得额”，费用和税额另列，且二者差额能由销售额的单一百分比精确解释，也可按（销售额－供应商应得额）÷销售额 × 100 反算。均写成“综合扣点约 X%（按提成金额/销售额推算）”；它只代表综合水平，不得拆成分档或猜测合同档位。其他无法可靠计算的情况才写“未提取/未提供分档”。不要列计算过程、最接近子集、Agent 理由或补资料建议。最终 JSON 的 salesTotal/netSalesTotal 仍必须是 MCP 返回的全店汇总值，difference 仍按 erpAmount - settlementAmount 填写以满足后端契约；仅明确无 ERP/DRP 记录时允许这四个金额字段同时为 null。

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
- salesTotal：有限数字，ERP/DRP MCP 返回的 sales_total，扣点前销售额；仅明确无匹配 ERP/DRP 记录时可为 null
- netSalesTotal：有限数字，ERP/DRP MCP 返回的 net_sales_total，扣点后金额；仅明确无匹配 ERP/DRP 记录时可为 null
- erpBasis：字符串，只能是 "sales_total"、"net_sales_total"、"ambiguous"
- erpAmount：有限数字；erpBasis 为 sales_total 时等于 salesTotal，为 net_sales_total 时等于 netSalesTotal，为 ambiguous 时取更接近 settlementAmount 的一个；仅明确无匹配 ERP/DRP 记录时可为 null
- difference：有限数字，必须等于 erpAmount - settlementAmount；仅明确无匹配 ERP/DRP 记录时可为 null
- matched：布尔值；只有口径明确且差额绝对值不超过 200 元时才可为 true
- basisReason：非空字符串，说明选择该口径的结算单字段、店铺规则或业务证据
- issues：字符串；没有内容时输出空字符串
- period: 字符串，对账月份，格式必须为 "YYYY-MM"
- name: 非空字符串，必须是本次用于查询 ERP/DRP MCP 的结算主体标识

字段业务含义、金额口径和适用范围只以本次 Session 中加载的飞书知识规则快照为准；金额或字段缺失、未调用 MCP、无法得到可靠 A/B 或算不出合法 difference 时不要编造。只有 MCP 已明确返回无匹配记录时才使用上述四个 null 字段组合；其他不符合契约的结果仍会被后端拒绝。`;
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
