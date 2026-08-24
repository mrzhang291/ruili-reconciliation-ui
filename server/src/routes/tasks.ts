import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { config } from "../lib/config.js";
import {
  deleteTaskRecord,
  fileSummary,
  getTaskDetail,
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

tasksRouter.post("/", upload.fields([
  { name: "settlementFile", maxCount: 1 },
  { name: "erpFile", maxCount: 1 },
]), async (req, res, next) => {
  try {
    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
    const settlement = files?.settlementFile?.[0];
    const erp = files?.erpFile?.[0];
    if (!settlement || !erp) {
      return res.status(400).json({ error: { code: "MISSING_FILES", message: "需要上传结算资料和 ERP 资料两份文件", requestId: crypto.randomUUID() } });
    }
    const extensions = new Set([".xlsx", ".xls", ".pdf", ".png", ".jpg", ".jpeg"]);
    const mimeTypes = new Set([
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel",
      "application/pdf", "image/png", "image/jpeg",
    ]);
    if ([settlement, erp].some((file) => !extensions.has(path.extname(file.originalname).toLowerCase())
      || Boolean(file.mimetype && file.mimetype !== "application/octet-stream" && !mimeTypes.has(file.mimetype)))) {
      return res.status(400).json({ error: { code: "INVALID_FILE_TYPE", message: "仅支持 Excel、PDF、PNG 和 JPG 文件", requestId: crypto.randomUUID() } });
    }
    const agentName = typeof req.body?.agentName === "string" ? req.body.agentName.trim() : "";
    if (!agentName) {
      return res.status(400).json({ error: { code: "AGENT_NAME_REQUIRED", message: "agentName 为必填字段", requestId: crypto.randomUUID() } });
    }
    const logs: ProgressLog[] = [];
    const task = await createReconciliationTask({
      settlementFile: { buffer: settlement.buffer, originalName: settlement.originalname, contentType: settlement.mimetype },
      erpFile: { buffer: erp.buffer, originalName: erp.originalname, contentType: erp.mimetype },
      agentSelector: {
        name: agentName,
        workspace: typeof req.body?.agentWorkspace === "string" ? req.body.agentWorkspace.trim() || undefined : undefined,
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
  return {
    id: task.id, name: task.name, status: task.status, periodLabel: task.period, version: 1,
    settlementFile: fileSummary(task.id, "SETTLEMENT", task.settlementFile),
    erpFile: fileSummary(task.id, "ERP", task.erpFile),
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
