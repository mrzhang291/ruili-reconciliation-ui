import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { config } from "../lib/config.js";
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
const excelExtensions = new Set([".xlsx", ".xls"]);
const excelMimeTypes = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
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

function validateErpUpload(file: Express.Multer.File | undefined): UploadError | null {
  if (!file) return null;
  const fileName = normalizeFileName(file.originalname);
  if (!excelExtensions.has(path.extname(fileName).toLowerCase())
    || Boolean(file.mimetype && file.mimetype !== "application/octet-stream" && !excelMimeTypes.has(file.mimetype))) {
    return { code: "INVALID_ERP_FILE_TYPE", message: "ERP 文件仅支持 Excel" };
  }
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

    const settlementError = validateSettlementUpload(settlement);
    if (settlementError) return res.status(400).json(errorPayload(settlementError));

    const erpError = validateErpUpload(erp);
    if (erpError) return res.status(400).json(errorPayload(erpError));

    const agentSelector = parseAgentSelector(req.body);
    if ("code" in agentSelector) {
      return res.status(400).json(errorPayload(agentSelector));
    }

    const logs: ProgressLog[] = [];
    const task = await createReconciliationTask({
      settlementFile: toCreateTaskFile(settlement),
      erpFile: erp ? toCreateTaskFile(erp) : undefined,
      agentSelector,
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
    },
    createdAt: task.createdAt, completedAt: task.completedAt, createdBy: task.createdBy,
  };
}

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
