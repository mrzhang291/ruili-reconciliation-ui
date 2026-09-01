import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { config } from "../lib/config.js";
import { buildErpLookupKeys } from "../lib/erp-base-query.js";
import { extractPeriodFromFileName } from "../lib/excel-settlement.js";
import { normalizeFileName } from "../lib/file-storage.js";
import { settlementFileRejectionReason } from "../lib/settlement-file-rules.js";
import {
  deleteTaskRecord,
  fileSummary,
  getTaskDetail,
  listReviewRecords,
  listTaskRecords,
  type StoredReviewItem,
  type StoredTask,
} from "../lib/lark-store.js";
import { getTaskProgress, removeTaskProgress } from "../lib/task-progress.js";
import {
  cancelReconciliationTask,
  createReconciliationTask,
  type ProgressLog,
} from "../services/reconciliation.js";

export const tasksRouter = Router();
const taskStatuses = ["QUEUED", "PROCESSING", "SUCCEEDED", "NEEDS_REVIEW", "REVIEWED", "FAILED", "CANCELLED", "OBSOLETE"];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes } });
const settlementExtensions = new Set([".xlsx", ".xls", ".pdf", ".png", ".jpg", ".jpeg"]);
const settlementMimeTypes = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/pdf",
  "image/png",
  "image/jpeg",
]);

type UploadError = { code: string; message: string };

function errorPayload(error: UploadError) {
  return { error: { ...error, requestId: crypto.randomUUID() } };
}

function validateSettlementUpload(file: Express.Multer.File): UploadError | null {
  const fileName = normalizeFileName(file.originalname);
  if (!settlementExtensions.has(path.extname(fileName).toLowerCase())
    || Boolean(file.mimetype && file.mimetype !== "application/octet-stream" && !settlementMimeTypes.has(file.mimetype))) {
    return { code: "INVALID_FILE_TYPE", message: "仅支持 Excel、PDF、PNG 和 JPG 文件" };
  }

  const rejectedReason = settlementFileRejectionReason(fileName);
  if (rejectedReason) return { code: "NOT_SETTLEMENT_FILE", message: rejectedReason };
  return null;
}

function parseAgentSelector(body: unknown): { name: string; workspace?: string } | UploadError {
  const payload = body as Record<string, unknown> | undefined;
  const agentName = typeof payload?.agentName === "string" ? payload.agentName.trim() : "";
  if (!agentName) return { code: "AGENT_NAME_REQUIRED", message: "agentName 为必填字段" };
  const workspace = typeof payload?.agentWorkspace === "string" ? payload.agentWorkspace.trim() : "";
  return { name: agentName, workspace: workspace || undefined };
}

function toCreateTaskFile(file: Express.Multer.File) {
  return { buffer: file.buffer, originalName: file.originalname, contentType: file.mimetype };
}

tasksRouter.post("/", upload.fields([
  { name: "settlementFile", maxCount: 1 },
  { name: "erpFile", maxCount: 1 },
]), async (req, res, next) => {
  try {
    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
    const settlement = files?.settlementFile?.[0];
    const erp = files?.erpFile?.[0];
    if (!settlement) {
      return res.status(400).json(errorPayload({ code: "MISSING_FILES", message: "需要上传结算资料" }));
    }
    if (erp) {
      return res.status(400).json(errorPayload({
        code: "ERP_FILE_NOT_ALLOWED",
        message: "单次对账不再接收 ERP 文件，ERP/DRP 金额由 Agent 通过 MCP 查询",
      }));
    }

    const settlementError = validateSettlementUpload(settlement);
    if (settlementError) return res.status(400).json(errorPayload(settlementError));

    const agentSelector = parseAgentSelector(req.body);
    if ("code" in agentSelector) {
      return res.status(400).json(errorPayload(agentSelector));
    }
    const settlementFileName = normalizeFileName(settlement.originalname);
    const shopCodes = buildErpLookupKeys(settlementFileName);

    const logs: ProgressLog[] = [];
    const task = await createReconciliationTask({
      settlementFile: toCreateTaskFile(settlement),
      agentSelector,
      settlementHint: {
        name: shopCodes.length === 1 ? shopCodes[0] : undefined,
        period: extractPeriodFromFileName(settlementFileName) ?? undefined,
        documentLabel: settlementFileName,
      },
      onProgress: (log) => logs.push(log),
    });
    return res.status(202).json({ data: { taskId: task.id, status: task.status, logs }, requestId: crypto.randomUUID() });
  } catch (error) {
    next(error);
  }
});

tasksRouter.get("/", async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const keyword = typeof req.query.keyword === "string" ? req.query.keyword.trim() : "";
    const statuses = typeof req.query.status === "string" ? req.query.status.split(",").filter(Boolean) : [];
    if (statuses.some((status) => !taskStatuses.includes(status))) {
      return res.status(400).json({ error: { code: "INVALID_STATUS", message: "包含不支持的任务状态", requestId: crypto.randomUUID() } });
    }
    const result = await listTaskRecords({ page, pageSize, statuses, keyword: keyword || undefined });
    const byStatus = Object.fromEntries(taskStatuses.map((status) => [status, result.facets[status] ?? 0]));
    return res.json({
      data: {
        items: result.items.map(toSummary), page, pageSize, total: result.total,
        facets: { total: Object.values(result.facets).reduce((sum, count) => sum + count, 0), byStatus },
      },
      requestId: crypto.randomUUID(),
    });
  } catch (error) {
    next(error);
  }
});

tasksRouter.get("/review-items", async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 100));
    const statuses = typeof req.query.status === "string" ? req.query.status.split(",").filter(Boolean) : ["PENDING", "APPROVED", "IGNORED"];
    if (statuses.some((status) => !["PENDING", "APPROVED", "IGNORED"].includes(status))) {
      return res.status(400).json({ error: { code: "INVALID_REVIEW_STATUS", message: "包含不支持的审核状态", requestId: crypto.randomUUID() } });
    }
    const result = await listReviewRecords({ page, pageSize, statuses });
    return res.json({
      data: {
        items: result.items.map(toReviewListRow),
        page,
        pageSize,
        hasMore: result.hasMore,
      },
      requestId: crypto.randomUUID(),
    });
  } catch (error) {
    next(error);
  }
});

tasksRouter.post("/:id/stop", async (req, res, next) => {
  try {
    const result = await cancelReconciliationTask(req.params.id);
    if (result.outcome === "not_found") {
      return res.status(404).json({ error: { code: "TASK_NOT_FOUND", message: "未找到对账任务", requestId: crypto.randomUUID() } });
    }
    if (result.outcome === "already_finished" && result.status !== "CANCELLED") {
      return res.status(409).json({ error: { code: "TASK_NOT_ACTIVE", message: "任务已结束，无需停止", requestId: crypto.randomUUID() } });
    }
    return res.json({ data: { taskId: req.params.id, status: "CANCELLED", stopped: true, sessionStopped: result.outcome === "cancelled" ? result.sessionStopped : true }, requestId: crypto.randomUUID() });
  } catch (error) {
    next(error);
  }
});

tasksRouter.delete("/:id", async (req, res, next) => {
  try {
    const deleted = await deleteTaskRecord(req.params.id);
    if (!deleted) return res.status(404).json({ error: { code: "TASK_NOT_FOUND", message: "未找到对账任务", requestId: crypto.randomUUID() } });
    removeTaskProgress(req.params.id);
    return res.json({ data: { taskId: req.params.id, deleted: true }, requestId: crypto.randomUUID() });
  } catch (error) {
    if (error instanceof Error && error.message === "TASK_ACTIVE") {
      return res.status(409).json({ error: { code: "TASK_ACTIVE", message: "正在执行的对账任务不能删除", requestId: crypto.randomUUID() } });
    }
    next(error);
  }
});

tasksRouter.get("/:id", async (req, res, next) => {
  try {
    const detail = await getTaskDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: { code: "TASK_NOT_FOUND", message: "未找到对账任务", requestId: crypto.randomUUID() } });
    return res.json({ data: toDetail(detail.task, detail.reviewItems), requestId: crypto.randomUUID() });
  } catch (error) {
    next(error);
  }
});

export function toSummary(task: StoredTask) {
  const settlementFile = fileSummary(task.id, "SETTLEMENT", task.settlementFile);
  const erpFile = fileSummary(task.id, "ERP", task.erpFile);
  const displayName = task.shopNo || settlementFile.name.replace(/\.[^.]+$/, "") || task.name;
  return {
    id: task.id, name: displayName, status: task.status, periodLabel: task.period, version: 1,
    settlementFile,
    erpFile,
    metrics: {
      settlementAmount: task.settlementAmount?.toString() ?? null,
      erpAmount: task.erpAmount?.toString() ?? null,
      differenceAmount: task.differenceAmount?.toString() ?? null,
      scopeMismatch: isScopeMismatchTask(task),
    },
    createdAt: task.createdAt, completedAt: task.completedAt, createdBy: task.createdBy,
  };
}

function isScopeMismatchTask(task: StoredTask) {
  if (!task.rawAgentJson) return false;
  try {
    const payload = JSON.parse(task.rawAgentJson) as Record<string, unknown>;
    return payload.scopedErpMismatch === true || isScopeMismatchText(String(payload.issues ?? ""));
  } catch {
    return false;
  }
}

function isScopeMismatchText(value: string) {
  const text = value.normalize("NFKC").replace(/\s+/g, "");
  return scopedMismatchPattern.test(text);
}

const scopedMismatchPattern = /聚合范围与结算单范围不一致|不能将ERP店铺聚合金额直接视为普通差额|ERP全店汇总|结算单与ERP(?:销售)?(?:范围|数据口径).*明显不一致|(?:预览页面|请勿用来结算)|(?:账期|期间|月份).*?(?:不一致|冲突)|(?:文件名主体|正文主体|结算主体|主体名称).*?(?:不一致|冲突)|(?:字段)?口径.*?(?:不一致|冲突)|无法唯一确定对账口径|金额接近度与字段口径存在冲突|结算单扣率.*?ERP.*?扣率|ERP.*?扣率.*?结算单扣率|ERP.*(?:聚合|汇总|店铺号|店铺|同店|同一店铺|多条|多档|不同扣率).*?(?:范围|不可比|无法确认|无法对应|不能直接|明细范围|合同|专柜|铺位|活动|特卖|本结算单|单一|部分|仅覆盖|未覆盖|口径)|(?:单一合同|单一专柜|单一结算部门|单一客户合同|仅覆盖|仅列示|仅显示).*?ERP/;

export function toDetail(task: StoredTask, reviewItems: StoredReviewItem[]) {
  return {
    ...toSummary(task), resolvedAt: task.status === "REVIEWED" ? task.completedAt : null,
    failure: task.failureReason ? { code: "RECONCILIATION_FAILED", message: task.failureReason } : null,
    reviewItems: reviewItems.map((item) => ({
      id: item.id, rowLabel: item.title, fieldName: item.title,
      differenceAmount: item.differenceAmount?.toString() ?? null,
      status: item.status, message: item.message, suggestion: item.suggestion,
      payload: { rowLabel: item.title, fieldName: item.title, message: item.message, suggestion: item.suggestion },
      resolvedAt: item.resolvedAt,
    })),
    progressLogs: getTaskProgress(task.id),
  };
}

function toReviewListRow(item: StoredReviewItem) {
  const taskId = item.taskRecordId ?? item.taskId;
  return {
    task: {
      id: taskId,
      name: item.shopNo ? `${item.shopNo} 差异` : item.taskId,
      status: item.status === "PENDING" ? "NEEDS_REVIEW" : "REVIEWED",
      periodLabel: null,
    },
    item: {
      id: item.id,
      rowLabel: item.title,
      fieldName: item.title,
      settlementValue: null,
      erpValue: null,
      differenceAmount: item.differenceAmount?.toString() ?? null,
      status: item.status,
      message: item.message,
      suggestion: item.suggestion,
    },
  };
}
