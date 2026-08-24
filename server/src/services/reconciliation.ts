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
  settlementFile: { buffer: Buffer; originalName: string; contentType: string };
  erpFile: { buffer: Buffer; originalName: string; contentType: string };
  agentSelector: AgentSelector & { name: string };
  onProgress?: (log: ProgressLog) => void;
};

type ActiveReconciliation = {
  controller: AbortController;
  target?: CherryAgentSession;
  batchId: string;
  files: { settlement: StoredFile; erp: StoredFile };
};

const activeReconciliations = new Map<string, ActiveReconciliation>();

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
  const settlement = saveUploadedFile(input.settlementFile.buffer, input.settlementFile.originalName, input.settlementFile.contentType);
  try {
    return { settlement, erp: saveUploadedFile(input.erpFile.buffer, input.erpFile.originalName, input.erpFile.contentType) };
  } catch (error) {
    deleteStoredFilePath(settlement.absolutePath);
    throw error;
  }
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
      name: `${files.erp.originalName} / ${files.settlement.originalName}`,
      batchId,
    });
  } catch (error) {
    deleteStoredFilePath(files.settlement.absolutePath);
    deleteStoredFilePath(files.erp.absolutePath);
    throw error;
  }

  initializeTaskProgress(taskId, pendingLogs);
  emit(onProgress, "success", `飞书任务已创建（记录 ID：${taskId}）`);
  void runReconciliation(taskId, batchId, files, input.agentSelector, onProgress);
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
    emit(onProgress, "info", "正在把原始文件保存到飞书附件字段…");
    await uploadTaskAttachment(taskId, "结算文件", files.settlement.absolutePath);
    await uploadTaskAttachment(taskId, "ERP文件", files.erp.absolutePath);
    emit(onProgress, "success", "两份原始文件已保存到飞书");

    const current = await getTaskRecord(taskId);
    if (!current || current.status !== "PROCESSING" || current.batchId !== batchId) return;

    emit(onProgress, "info", "正在从飞书知识规则表读取本次规则…");
    const knowledge = await loadKnowledgeInstructions();
    emit(onProgress, "success", `已加载 ${knowledge.ruleVersions.length} 条飞书知识规则`);
    emit(onProgress, "info", "正在连接 CherryStudio Agent…");
    const target = await resolveAgentSession(
      agentSelector,
      knowledge.instructions,
      (level, message, options) => emit(onProgress, level, message, options),
      active.controller.signal,
    );
    active.target = target;

    const prompt = buildReconciliationPrompt({
      settlementFileUrl: `http://127.0.0.1:${config.port}/api/tasks/${taskId}/files/SETTLEMENT`,
      erpFileUrl: `http://127.0.0.1:${config.port}/api/tasks/${taskId}/files/ERP`,
      settlementFilePath: files.settlement.absolutePath,
      erpFilePath: files.erp.absolutePath,
      submittedAt: new Date().toISOString(),
      taskId,
      taskWorkDir,
    });

    emit(onProgress, "info", "提示词已生成，正在提交至 Agent…");
    const result = await sendReconciliationPrompt(
      target,
      prompt,
      (level, message, options) => emit(onProgress, level, message, options),
      active.controller.signal,
    );
    const applied = await applyTaskResult(taskId, batchId, result, knowledge.ruleVersions);
    if (applied) emit(onProgress, "success", `对账完成：${result.name}，Agent 差额 ${result.difference.toFixed(2)} 元`);
  } catch (error) {
    if (active.controller.signal.aborted || (await getTaskRecord(taskId))?.status === "CANCELLED") return;
    const message = error instanceof Error ? error.message : "对账处理失败";
    const code = error instanceof CherryStudioError || error instanceof LarkKnowledgeError ? error.code : "RECONCILIATION_FAILED";
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
      deleteStoredFilePath(files.erp.absolutePath);
    } catch (error) {
      console.error(`[cleanup] 清理任务临时文件 ${taskId} 失败`, error);
    }
    if (activeReconciliations.get(taskId) === active) activeReconciliations.delete(taskId);
  }
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
  erpFileUrl: string;
  settlementFilePath: string;
  erpFilePath: string;
  submittedAt: string;
  taskId: string;
  taskWorkDir: string;
}) {
  const erpUrl = params.erpFileUrl;
  const settlementUrl = params.settlementFileUrl;

  return `我有一个对账任务：

${erpUrl}
这是 ERP 导出单据

${settlementUrl}
这是结算单

本次任务唯一允许使用的临时工作目录：
${params.taskWorkDir}

如需下载文件、拆分 PDF、渲染图片、执行 OCR 或生成 Markdown/JSON，请只写入上述目录。不要在项目根目录、源码目录或输入文件旁创建文件；不要复制原始文件，优先直接读取以下本地路径：
- ERP：${params.erpFilePath}
- 结算单：${params.settlementFilePath}

在过程中，面对图片、PDF 等文件，你可以使用 mineru 这个项目 Subagent 获取 Markdown 格式的内容。

请帮我看看是否能够对上账。

当你完成对账后，最后只输出一个合法的 JSON 对象，不要使用 Markdown 代码块，也不要在 JSON 前后输出其他内容。格式例子如下：

{
  "matched": true,
  "erpAmount": 100.00,
  "settlementAmount": 100.00,
  "difference": 0.00,
  "issues": "",
  "period": "XXXX-XX",
  "name": "商城名称A"
}

其中字段类型必须依次为：
- matched：布尔值
- erpAmount：有限数字，ERP/DRP 销售额合计
- settlementAmount：有限数字，结算单净营业额合计
- difference：有限数字
- issues：字符串；没有内容时输出空字符串
- period: 字符串，对账月份，格式必须为 "YYYY-MM"
- name: 非空字符串，商城名称

字段业务含义、计算口径和适用范围只以本次 Session 中加载的飞书知识规则快照为准，不得自行采用服务器内置口径。`;
}
