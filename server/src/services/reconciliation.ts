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
  type SettlementExtractionResult,
} from "../lib/cherrystudio.js";
import { cleanupTaskWorkDir, prepareTaskWorkDir } from "../lib/runtime-storage.js";
import { LarkKnowledgeError, loadKnowledgeInstructions } from "../lib/lark-knowledge.js";
import {
  buildExcelSettlementExtraction,
  chooseExcelSettlementCandidate,
  type ExcelSettlementCandidate,
  isExcelFileName,
  readExcelSettlementDraft,
} from "../lib/excel-settlement.js";
import {
  buildErpDataFromParsedRows,
  ErpImportError,
  parseErpWorkbook,
  type ParsedErpImportRow,
} from "../lib/erp-import.js";
import {
  buildErpLookupKeys,
  buildReconciliationResult,
  ErpBaseQueryError,
  type ErpReconciliationData,
  queryErpReconciliationData,
} from "../lib/erp-base-query.js";
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
  settlementFile: { buffer: Buffer; originalName: string; contentType: string };
  erpFile?: { buffer: Buffer; originalName: string; contentType: string };
  agentSelector: AgentSelector & { name: string };
  settlementIdentity?: {
    shopNo: string;
    period: string;
    candidate?: ExcelSettlementCandidate;
    documentLabel?: string;
  };
  onProgress?: (log: ProgressLog) => void;
};

export type CreateReconciliationGroupInput = {
  batchId: string;
  groupId: string;
  shopNo: string;
  period: string;
  documents: Array<{
    id: string;
    file: StoredFile;
    settlementAmount: number;
    settlementAmountLabel: string;
  }>;
  erpFile?: StoredFile | null;
  onProgress?: (log: ProgressLog) => void;
  onSettled?: (result: { taskId: string; status: string; message: string | null }) => void | Promise<void>;
};

type ActiveReconciliation = {
  controller: AbortController;
  target?: CherryAgentSession;
  batchId: string;
  files: { settlement: StoredFile; erp?: StoredFile; settlementIdentity?: CreateReconciliationInput["settlementIdentity"] };
};

const activeReconciliations = new Map<string, ActiveReconciliation>();
const maxConcurrentReconciliations = 3;
const pendingReconciliationRuns: Array<() => Promise<void>> = [];
let runningReconciliationCount = 0;

function scheduleReconciliation(run: () => Promise<void>) {
  pendingReconciliationRuns.push(run);
  drainReconciliationQueue();
}

function drainReconciliationQueue() {
  while (runningReconciliationCount < maxConcurrentReconciliations && pendingReconciliationRuns.length) {
    const next = pendingReconciliationRuns.shift();
    if (!next) return;
    runningReconciliationCount += 1;
    void next().finally(() => {
      runningReconciliationCount -= 1;
      drainReconciliationQueue();
    });
  }
}

export function getActiveTaskFile(taskId: string, kind: "SETTLEMENT" | "ERP") {
  const active = activeReconciliations.get(taskId);
  return kind === "SETTLEMENT" ? active?.files.settlement : active?.files.erp;
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

function saveTaskFiles(input: CreateReconciliationInput) {
  return {
    settlement: saveUploadedFile(input.settlementFile.buffer, input.settlementFile.originalName, input.settlementFile.contentType),
    erp: input.erpFile ? saveUploadedFile(input.erpFile.buffer, input.erpFile.originalName, input.erpFile.contentType) : undefined,
    settlementIdentity: input.settlementIdentity,
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
  const batchId = crypto.randomUUID();
  try {
    taskId = await createTaskRecord({
      name: input.settlementIdentity?.documentLabel ?? files.settlement.originalName,
      batchId,
    });
  } catch (error) {
    deleteStoredFilePath(files.settlement.absolutePath);
    if (files.erp) deleteStoredFilePath(files.erp.absolutePath);
    throw error;
  }

  initializeTaskProgress(taskId, pendingLogs);
  emit(onProgress, "success", `飞书任务已创建（记录 ID：${taskId}）`);
  emit(onProgress, "info", `任务已进入执行队列，最多同时处理 ${maxConcurrentReconciliations} 份结算资料`);
  scheduleReconciliation(() => runReconciliation(taskId, batchId, files, input.agentSelector, onProgress));
  return { id: taskId, status: "PROCESSING" as const };
}

export async function createReconciliationGroupTask(input: CreateReconciliationGroupInput) {
  const firstDocument = input.documents[0];
  if (!firstDocument) throw new Error("批量组没有可执行单据");
  let taskId: string | null = null;
  const pendingLogs: ProgressLog[] = [];
  const onProgress = (log: ProgressLog) => {
    if (taskId) appendTaskProgress(taskId, log);
    else pendingLogs.push(log);
    input.onProgress?.(log);
  };

  emit(onProgress, "info", `开始创建批量组任务 ${input.groupId}…`);
  taskId = await createTaskRecord({
    name: `${input.shopNo} ${input.period} 批量组`,
    batchId: input.batchId,
  });
  initializeTaskProgress(taskId, pendingLogs);
  emit(onProgress, "success", `飞书组任务已创建（记录 ID：${taskId}）`);
  emit(onProgress, "info", `组任务已进入执行队列，最多同时处理 ${maxConcurrentReconciliations} 个任务`);
  scheduleReconciliation(() => runDeterministicGroupReconciliation(taskId, input, onProgress));
  return { id: taskId, status: "PROCESSING" as const };
}

async function runReconciliation(
  taskId: string,
  batchId: string,
  files: ActiveReconciliation["files"],
  agentSelector: AgentSelector,
  onProgress?: CreateReconciliationInput["onProgress"],
) {
  const active: ActiveReconciliation = { controller: new AbortController(), batchId, files };
  activeReconciliations.set(taskId, active);
  let taskWorkDir = "";

  try {
    taskWorkDir = prepareTaskWorkDir(taskId);
    emit(onProgress, "info", "正在把结算原始文件保存到飞书附件字段…");
    await uploadTaskAttachment(taskId, "结算文件", files.settlement.absolutePath);
    emit(onProgress, "success", "结算原始文件已保存到飞书");
    if (files.erp) {
      emit(onProgress, "info", "正在把本次 ERP 文件保存到飞书附件字段…");
      await uploadTaskAttachment(taskId, "ERP文件", files.erp.absolutePath);
      emit(onProgress, "success", "本次 ERP 文件已保存到飞书");
    }

    const current = await getTaskRecord(taskId);
    if (!current || current.status !== "PROCESSING" || current.batchId !== batchId) return;

    const lookupKeys = files.settlementIdentity?.shopNo ? [files.settlementIdentity.shopNo] : buildErpLookupKeys(files.settlement.originalName);
    if (!lookupKeys.length) {
      throw new ErpBaseQueryError("结算单文件名未识别到店铺号，无法按文件名与 ERP 明细表硬匹配", "ERP_LOOKUP_KEY_REQUIRED");
    }
    if (lookupKeys.length > 1) {
      throw new ErpBaseQueryError(`结算单文件名包含多个店铺号（${lookupKeys.join("、")}），请拆成单店铺结算单后再上传`, "ERP_LOOKUP_KEY_AMBIGUOUS");
    }
    const fileShopNo = lookupKeys[0];
    emit(onProgress, "success", `已从文件名识别店铺号 ${fileShopNo}`);

    emit(onProgress, "info", "正在从飞书知识规则表读取本次规则…");
    const knowledge = await loadKnowledgeInstructions(fileShopNo);
    emit(onProgress, "success", `已加载 ${knowledge.ruleVersions.length} 条飞书知识规则`);

    const identity = files.settlementIdentity;
    const identityCandidate = identity?.candidate;
    const excelDraft = identityCandidate ? null : await readExcelSettlementDraft(files.settlement.absolutePath, files.settlement.originalName);
    let result: SettlementExtractionResult;
    let erpData: ErpReconciliationData;
    if (identity && identityCandidate) {
      result = buildExcelSettlementExtraction({
        name: fileShopNo,
        period: identity.period,
        candidates: [identityCandidate],
      }, identityCandidate);
      emit(onProgress, "success", `已采用预检拆单结果「${identityCandidate.label}」=${identityCandidate.amount.toFixed(2)} 元`);
      erpData = await resolveErpData(files, lookupKeys, identity.period, onProgress);
      emit(onProgress, "success", `已按店铺号 ${erpData.lookupKey} 读取 ${erpData.rows.length} 行 ERP 明细，扣点前 ${erpData.salesTotal.toFixed(2)} 元，扣点后 ${erpData.netSalesTotal.toFixed(2)} 元`);
    } else if (excelDraft && chooseExcelSettlementCandidate(excelDraft.candidates)) {
      const excelCandidate = chooseExcelSettlementCandidate(excelDraft.candidates);
      if (!excelCandidate) throw new Error("Excel 没有可用的结算金额候选");
      emit(onProgress, "success", `已从 Excel 本地抽取 ${fileShopNo} ${excelDraft.period}，发现 ${excelDraft.candidates.length} 个金额候选`);
      result = buildExcelSettlementExtraction({ ...excelDraft, name: fileShopNo }, excelCandidate);
      emit(onProgress, "success", `已采用 Excel 字段「${excelCandidate.label}」=${excelCandidate.amount.toFixed(2)} 元`);
      erpData = await resolveErpData(files, lookupKeys, excelDraft.period, onProgress);
      emit(onProgress, "success", `已按店铺号 ${erpData.lookupKey} 读取 ${erpData.rows.length} 行 ERP 明细，扣点前 ${erpData.salesTotal.toFixed(2)} 元，扣点后 ${erpData.netSalesTotal.toFixed(2)} 元`);
    } else {
      if (excelDraft) {
        emit(onProgress, "info", "Excel 本地抽取到的净营业额不唯一，改用 CherryStudio Agent 识别…");
      } else if (isExcelFileName(files.settlement.originalName)) {
        emit(onProgress, "info", "Excel 本地抽取失败，改用 CherryStudio Agent 识别…");
      }
      result = await extractSettlementWithAgent({
        active,
        agentSelector,
        knowledgeInstructions: knowledge.instructions,
        onProgress,
        settlementFileUrl: `http://127.0.0.1:${config.port}/api/tasks/${taskId}/files/SETTLEMENT`,
        settlementFilePath: files.settlement.absolutePath,
        settlementFileName: files.settlement.originalName,
        submittedAt: new Date().toISOString(),
        taskId,
        taskWorkDir,
        shopNo: fileShopNo,
      });
      result = { ...result, name: fileShopNo };
      emit(onProgress, "info", `Agent 已抽取 ${result.period}，正在按文件名店铺号 ${fileShopNo} 读取 ERP 明细…`);
      erpData = await resolveErpData(files, lookupKeys, result.period, onProgress);
      emit(onProgress, "success", `已按店铺号 ${erpData.lookupKey} 读取 ${erpData.rows.length} 行 ERP 明细，扣点前 ${erpData.salesTotal.toFixed(2)} 元，扣点后 ${erpData.netSalesTotal.toFixed(2)} 元`);
    }

    const finalResult = buildReconciliationResult(result, erpData);
    const applied = await applyTaskResult(taskId, batchId, finalResult, knowledge.ruleVersions);
    if (applied) emit(onProgress, "success", `对账完成：${finalResult.name}，权威差额 ${finalResult.difference.toFixed(2)} 元`);
  } catch (error) {
    if (active.controller.signal.aborted || (await getTaskRecord(taskId))?.status === "CANCELLED") return;
    const message = error instanceof Error ? error.message : "对账处理失败";
    const code = error instanceof CherryStudioError || error instanceof LarkKnowledgeError || error instanceof ErpBaseQueryError || error instanceof ErpImportError ? error.code : "RECONCILIATION_FAILED";
    emit(onProgress, "error", message);
    try {
      await failTaskRecord(taskId, batchId, `${code}: ${message}`);
    } catch {
      // 飞书不可用时无法回写失败状态，保留原始错误日志。
    }
  } finally {
    try {
      cleanupTaskWorkDir(taskId);
      deleteStoredFilePath(files.settlement.absolutePath);
      if (files.erp) deleteStoredFilePath(files.erp.absolutePath);
    } catch (error) {
      console.error(`[cleanup] 清理任务临时文件 ${taskId} 失败`, error);
    }
    if (activeReconciliations.get(taskId) === active) activeReconciliations.delete(taskId);
  }
}

async function runDeterministicGroupReconciliation(
  taskId: string,
  input: CreateReconciliationGroupInput,
  onProgress?: CreateReconciliationInput["onProgress"],
) {
  const firstDocument = input.documents[0];
  const active: ActiveReconciliation = {
    controller: new AbortController(),
    batchId: input.batchId,
    files: { settlement: firstDocument.file, erp: input.erpFile ?? undefined },
  };
  activeReconciliations.set(taskId, active);
  let taskWorkDir = "";
  let settled = false;

  const settle = async (status: string, message: string | null) => {
    if (settled) return;
    settled = true;
    try {
      await input.onSettled?.({ taskId, status, message });
    } catch (error) {
      console.error(`[batch] 同步批量组 ${input.groupId} 状态失败`, error);
    }
  };

  try {
    taskWorkDir = prepareTaskWorkDir(taskId);
    emit(onProgress, "info", `正在保存批量组 ${input.groupId} 的首份结算原始文件到飞书…`);
    await uploadTaskAttachment(taskId, "结算文件", firstDocument.file.absolutePath);
    emit(onProgress, "success", "结算原始文件已保存到飞书；完整源文件保留在批量明细表");
    if (input.erpFile) {
      emit(onProgress, "info", "正在把本批次 ERP 文件保存到飞书附件字段…");
      await uploadTaskAttachment(taskId, "ERP文件", input.erpFile.absolutePath);
      emit(onProgress, "success", "本批次 ERP 文件已保存到飞书");
    }

    const current = await getTaskRecord(taskId);
    if (!current || current.status !== "PROCESSING" || current.batchId !== input.batchId) return;

    emit(onProgress, "info", "正在从飞书知识规则表读取本次规则…");
    const knowledge = await loadKnowledgeInstructions(input.shopNo);
    emit(onProgress, "success", `已加载 ${knowledge.ruleVersions.length} 条飞书知识规则`);

    const settlementAmount = input.documents.reduce((sum, document) => sum + document.settlementAmount, 0);
    const settlementLabel = input.documents.length === 1
      ? input.documents[0].settlementAmountLabel
      : `批量组确认金额合计（${input.documents.length} 份单据）`;
    emit(onProgress, "success", `已采用批量明细确认金额 ${settlementAmount.toFixed(2)} 元，不让 Agent 重新判断金额`);

    const erpData = await resolveErpData(
      { settlement: firstDocument.file, erp: input.erpFile ?? undefined, settlementIdentity: { shopNo: input.shopNo, period: input.period } },
      [input.shopNo],
      input.period,
      onProgress,
    );
    emit(onProgress, "success", `已按店铺号 ${erpData.lookupKey} 读取 ${erpData.rows.length} 行 ERP 明细，扣点前 ${erpData.salesTotal.toFixed(2)} 元，扣点后 ${erpData.netSalesTotal.toFixed(2)} 元`);

    const finalResult = buildReconciliationResult({
      name: input.shopNo,
      period: input.period,
      settlementAmount,
      settlementAmountLabel: settlementLabel,
      issues: [],
      rawAgentPayload: {
        settlementAmount,
        settlementAmountLabel: settlementLabel,
        issues: "",
        period: input.period,
        name: input.shopNo,
      },
    }, erpData);
    finalResult.rawAgentPayload = {
      ...finalResult.rawAgentPayload,
      extractionMode: "deterministic_batch_group",
      batchId: input.batchId,
      groupId: input.groupId,
      documents: input.documents.map((document) => ({
        id: document.id,
        fileName: document.file.originalName,
        settlementAmount: document.settlementAmount,
        settlementAmountLabel: document.settlementAmountLabel,
      })),
    };

    const applied = await applyTaskResult(taskId, input.batchId, finalResult, knowledge.ruleVersions);
    const completed = await getTaskRecord(taskId);
    if (applied) emit(onProgress, "success", `批量组对账完成：${finalResult.name}，权威差额 ${finalResult.difference.toFixed(2)} 元`);
    await settle(completed?.status ?? "FAILED", completed?.failureReason ?? null);
  } catch (error) {
    if (active.controller.signal.aborted || (await getTaskRecord(taskId))?.status === "CANCELLED") {
      await settle("CANCELLED", "对账任务已由用户停止");
      return;
    }
    const message = error instanceof Error ? error.message : "批量组对账处理失败";
    const code = error instanceof LarkKnowledgeError || error instanceof ErpBaseQueryError || error instanceof ErpImportError ? error.code : "BATCH_GROUP_RECONCILIATION_FAILED";
    emit(onProgress, "error", message);
    try {
      await failTaskRecord(taskId, input.batchId, `${code}: ${message}`);
    } catch {
      // 飞书不可用时无法回写失败状态，保留原始错误日志。
    }
    await settle("FAILED", `${code}: ${message}`);
  } finally {
    try {
      if (taskWorkDir) cleanupTaskWorkDir(taskId);
    } catch (error) {
      console.error(`[cleanup] 清理批量组临时目录 ${taskId} 失败`, error);
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
  shopNo: string;
  submittedAt: string;
  taskId: string;
  taskWorkDir: string;
}) {
  const prompt = buildReconciliationPrompt(params);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    emit(params.onProgress, "info", attempt === 1 ? "正在连接 CherryStudio Agent…" : "正在重试 CherryStudio Agent（第 2 次）…");
    let target: CherryAgentSession | null = null;

    try {
      target = await resolveAgentSession(
        params.agentSelector,
        params.knowledgeInstructions,
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

async function resolveErpData(
  files: ActiveReconciliation["files"],
  lookupKeys: string[],
  period: string,
  onProgress?: CreateReconciliationInput["onProgress"],
) {
  if (!files.erp) {
    emit(onProgress, "info", "未上传本次 ERP 文件，改查飞书 ERP 明细表…");
    return queryErpWithFallback(lookupKeys, period);
  }

  emit(onProgress, "info", "正在读取本次上传的 ERP 文件…");
  const rows = await parseErpWorkbook(files.erp.absolutePath, files.erp.originalName);
  emit(onProgress, "success", `已解析本次 ERP 文件 ${rows.length} 行明细，优先使用该文件计算 ERP 金额`);
  return queryUploadedErpWithFallback(rows, lookupKeys, period);
}

function queryUploadedErpWithFallback(rows: ParsedErpImportRow[], lookupKeys: string[], period: string) {
  if (!lookupKeys.length) throw new ErpBaseQueryError("结算单未识别到店铺号，无法查询上传 ERP 文件", "ERP_LOOKUP_KEY_REQUIRED");
  const misses: string[] = [];
  for (const key of lookupKeys) {
    try {
      return buildErpDataFromParsedRows(rows, key, period);
    } catch (error) {
      if (error instanceof ErpBaseQueryError && error.code === "ERP_ROWS_NOT_FOUND") {
        misses.push(key);
        continue;
      }
      throw error;
    }
  }
  throw new ErpBaseQueryError(
    `上传 ERP 文件未找到 ${misses.map((key) => `「${key}」`).join("、")} 在 ${period} 的店铺号记录`,
    "ERP_ROWS_NOT_FOUND",
  );
}

async function queryErpWithFallback(lookupKeys: string[], period: string): Promise<ErpReconciliationData> {
  if (!lookupKeys.length) throw new ErpBaseQueryError("结算单未识别到店铺号，无法查询飞书 ERP 明细表", "ERP_LOOKUP_KEY_REQUIRED");
  const misses: string[] = [];
  for (const key of lookupKeys) {
    try {
      return await queryErpReconciliationData(key, period);
    } catch (error) {
      if (error instanceof ErpBaseQueryError && error.code === "ERP_ROWS_NOT_FOUND") {
        misses.push(key);
        continue;
      }
      throw error;
    }
  }
  throw new ErpBaseQueryError(
    `飞书 ERP 明细表未找到 ${misses.map((key) => `「${key}」`).join("、")} 在 ${period} 的店铺号记录`,
    "ERP_ROWS_NOT_FOUND",
  );
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
  shopNo: string;
  submittedAt: string;
  taskId: string;
  taskWorkDir: string;
}) {
  const settlementUrl = params.settlementFileUrl;

  return `我有一个对账任务：

${settlementUrl}
这是结算单

结算单文件名：${params.settlementFileName}
后端已从文件名确定本次店铺号：${params.shopNo}
name 字段请固定输出为该店铺号，不要改写为商场名称、供应商名称或其他别名。

本次任务唯一允许使用的临时工作目录：
${params.taskWorkDir}

如需下载文件、拆分 PDF、渲染图片、执行 OCR 或生成 Markdown/JSON，请只写入上述目录。不要在项目根目录、源码目录或输入文件旁创建文件；不要复制原始文件，优先直接读取以下本地路径：
- 结算单：${params.settlementFilePath}

在过程中，面对图片、PDF 等文件，你可以使用 mineru 这个项目 Subagent 获取 Markdown 格式的内容。
在 Windows 环境执行 Python/MinerU 脚本时，优先使用 PYTHONUTF8=1 PYTHONIOENCODING=utf-8 python ...，不要先调用 WindowsApps 里的 python3 占位命令。

请只从结算单中抽取账期月份和可对账金额。不要读取、计算、猜测或输出 ERP/DRP 金额；ERP 金额会由后端按文件名店铺号查询飞书 Base 明细表并确定性计算。

完成后最后只输出一个合法的 JSON 对象，不要使用 Markdown 代码块，也不要在 JSON 前后输出其他内容。格式例子如下：

{
  "settlementAmount": 100.00,
  "settlementAmountLabel": "结算净营业额",
  "issues": "",
  "period": "XXXX-XX",
  "name": "${params.shopNo}"
}

其中字段类型必须依次为：
- settlementAmount：有限数字，结算单中用于对账的金额
- settlementAmountLabel：非空字符串，结算单中该金额对应的字段名或口径
- issues：字符串；没有内容时输出空字符串
- period: 字符串，对账月份，格式必须为 "YYYY-MM"
- name: 非空字符串，必须等于后端已从文件名确定的店铺号 ${params.shopNo}

字段业务含义、金额口径和适用范围只以本次 Session 中加载的飞书知识规则快照为准；金额或字段缺失时不要编造，后端会拒绝不符合契约的结果。`;
}
