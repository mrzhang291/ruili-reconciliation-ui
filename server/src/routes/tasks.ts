import path from "node:path";
import { Router } from "express";
import { buildErpLookupKeys } from "../lib/erp-base-query.js";
import { extractPeriodFromFileName } from "../lib/excel-settlement.js";
import { createStreamingUpload, deleteStoredFilePath, normalizeFileName, storedFileFromUpload } from "../lib/file-storage.js";
import { buildReviewWorklist, classifyReviewEvidence, isScopedReconciliationIssue } from "../lib/reconciliation-review.js";
import { settlementFileRejectionReason } from "../lib/settlement-file-rules.js";
import {
  deleteTaskRecord,
  fileSummary,
  getTaskDetail,
  getTaskRecords,
  listReviewRecords,
  listTaskRecords,
  comparableDifferenceAmount,
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
const reviewItemStatuses = ["PENDING", "APPROVED", "IGNORED"] as const;
/**
 * Stable API value for `GET /api/tasks/review-items/export?region=OTHER`.
 * It represents shop numbers that do not begin with a two-letter region
 * prefix. Client display labels (for example, "其他") must map to this
 * ASCII sentinel before calling the export endpoint.
 */
export const REVIEW_EXPORT_OTHER_REGION = "OTHER";
const upload = createStreamingUpload(2);
const settlementExtensions = new Set([".xlsx", ".xls", ".xlsm", ".pdf", ".png", ".jpg", ".jpeg"]);
const settlementMimeTypes = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.ms-excel.sheet.macroenabled.12",
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
  const mimeType = file.mimetype.toLowerCase();
  const isImage = mimeType.startsWith("image/");
  if ((!settlementExtensions.has(path.extname(fileName).toLowerCase()) && !isImage)
    || Boolean(mimeType && mimeType !== "application/octet-stream" && !settlementMimeTypes.has(mimeType) && !isImage)) {
    return { code: "INVALID_FILE_TYPE", message: "仅支持 Excel、PDF 和图片文件" };
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
  return { file: storedFileFromUpload(file), deleteAfterRun: true };
}

function discardUploadedFile(file: Express.Multer.File | undefined) {
  if (!file) return;
  try {
    deleteStoredFilePath(file.path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
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
      discardUploadedFile(erp);
      return res.status(400).json(errorPayload({ code: "MISSING_FILES", message: "需要上传结算资料" }));
    }
    if (erp) {
      discardUploadedFile(settlement);
      discardUploadedFile(erp);
      return res.status(400).json(errorPayload({
        code: "ERP_FILE_NOT_ALLOWED",
        message: "单次对账不再接收 ERP 文件，ERP/DRP 金额由 Agent 通过 MCP 查询",
      }));
    }

    const settlementError = validateSettlementUpload(settlement);
    if (settlementError) {
      discardUploadedFile(settlement);
      return res.status(400).json(errorPayload(settlementError));
    }

    const agentSelector = parseAgentSelector(req.body);
    if ("code" in agentSelector) {
      discardUploadedFile(settlement);
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
      return res.status(400).json({ error: { code: "INVALID_REVIEW_STATUS", message: "包含不支持的处理状态", requestId: crypto.randomUUID() } });
    }
    const result = await listReviewRecords({ page, pageSize, statuses, fresh: req.query.fresh === "1" });
    const parentTasks = await getTaskRecords(result.items.flatMap((item) => item.taskRecordId ? [item.taskRecordId] : []));
    const parentTasksById = new Map(parentTasks.map((task) => [task.id, task]));
    return res.json({
      data: {
        items: result.items.map((item) => toReviewListRow(item, parentTasksById.get(item.taskRecordId ?? "") ?? null)),
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

async function loadAllReviewRecords() {
  const items: StoredReviewItem[] = [];
  for (let page = 1; ; page += 1) {
    const result = await listReviewRecords({
      page,
      pageSize: 200,
      statuses: [...reviewItemStatuses],
      fresh: true,
    });
    items.push(...result.items);
    if (!result.hasMore) return items;
  }
}

tasksRouter.get("/review-items/worklist", async (_req, res, next) => {
  try {
    const items = await loadAllReviewRecords();
    const parentTasks = await getTaskRecords([...new Set(items.flatMap((item) => item.taskRecordId ? [item.taskRecordId] : []))]);
    const tasksById = new Map(parentTasks.map((task) => [task.id, task]));
    const worklist = buildReviewWorklist(items.map((item) => ({
      item,
      task: tasksById.get(item.taskRecordId ?? "") ?? null,
    })));
    return res.json({
      data: {
        items: worklist.map(({ item, task, card }) => ({
          ...toReviewListRow(item, task),
          ...card,
        })),
      },
      requestId: crypto.randomUUID(),
    });
  } catch (error) {
    next(error);
  }
});

function csvCell(value: unknown) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function exportAmount(value: number | null | undefined) {
  return typeof value === "number" ? value.toFixed(2) : "";
}

type ReviewExportFilters = {
  region?: string;
  status?: (typeof reviewItemStatuses)[number];
  differenceMin?: number;
  differenceMax?: number;
};

function reviewExportRegion(shopNo: string | null | undefined) {
  return shopNo?.trim().match(/^[a-z]{2}/i)?.[0].toUpperCase() ?? REVIEW_EXPORT_OTHER_REGION;
}

/**
 * Parses the documented two-letter region code or the stable OTHER sentinel
 * used by the CSV export endpoint. Empty input means no region filter.
 */
export function exportFilterRegion(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const region = value.trim().toUpperCase();
  if (!region) return undefined;
  return /^[A-Z]{2}$/.test(region) || region === REVIEW_EXPORT_OTHER_REGION ? region : null;
}

function exportFilterNumber(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function exportFilterStatus(value: unknown): (typeof reviewItemStatuses)[number] | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const status = value.trim().toUpperCase();
  if (!status) return undefined;
  return reviewItemStatuses.includes(status as (typeof reviewItemStatuses)[number])
    ? status as (typeof reviewItemStatuses)[number]
    : null;
}

export function reviewBusinessConclusion(item: Pick<StoredReviewItem, "title" | "message" | "suggestion">, differenceAmount: number | null | undefined) {
  const classification = classifyReviewEvidence({ ...item, differenceAmount: differenceAmount ?? null });
  if (classification.code === "ERP_MISSING") return "ERP金额待核对";
  if (classification.code === "RATE_INCOMPLETE") return "扣点信息待确认";
  if (classification.code === "RATE_MISMATCH") return "扣点不一致";
  if (classification.code === "SCOPE_MISMATCH") return "销售范围待确认";
  if (classification.code === "BASIS_AMBIGUOUS") return "金额口径待确认";
  if (typeof differenceAmount === "number" && Math.abs(differenceAmount) <= 200) return "销售额已对平";
  return "销售额差异待核实";
}

export function buildReviewExportCsv(items: StoredReviewItem[], tasksById: Map<string, StoredTask>, batchId?: string, filters: ReviewExportFilters = {}) {
  const header = [
    "店铺号", "账期", "字段", "业务结论", "结算单金额", "ERP金额", "计算差额", "问题说明", "处理建议", "处理状态", "任务ID", "事项ID",
    "事项分类", "优先级", "优先级依据", "待确认问题", "所需补充信息", "结算原件", "金额口径", "沟通话术", "候选规则",
  ];
  const statusLabel: Record<string, string> = { PENDING: "待确认", APPROVED: "已确认", IGNORED: "已暂不处理" };
  const worklist = buildReviewWorklist(items.map((item) => ({
    item,
    task: tasksById.get(item.taskRecordId ?? "") ?? null,
  })));
  const rows = worklist.flatMap(({ item, task, card }) => {
    if (batchId && task?.batchId !== batchId) return [];
    const difference = task ? comparableDifferenceAmount(task) : item.differenceAmount;
    if (filters.region && reviewExportRegion(task?.shopNo ?? item.shopNo) !== filters.region) return [];
    if (filters.status && item.status !== filters.status) return [];
    if (filters.differenceMin !== undefined && (typeof difference !== "number" || difference < filters.differenceMin)) return [];
    if (filters.differenceMax !== undefined && (typeof difference !== "number" || difference > filters.differenceMax)) return [];
    return [[
      task?.shopNo ?? item.shopNo ?? "",
      task?.period ?? "",
      item.title,
      reviewBusinessConclusion(item, difference),
      exportAmount(task?.settlementAmount),
      exportAmount(task?.erpAmount),
      exportAmount(difference),
      item.message,
      item.suggestion ?? "",
      statusLabel[item.status] ?? item.status,
      task?.taskId ?? item.taskId,
      item.id,
      card.classification.label,
      card.priority.label,
      card.priority.reason,
      card.confirmation.question,
      card.confirmation.requiredFields.join("；"),
      card.evidence.settlementFileName ?? "",
      [card.evidence.settlementBasis, card.evidence.erpBasisLabel, card.evidence.basisReason].filter(Boolean).join("；"),
      card.confirmation.communicationTemplate,
      card.candidateRule?.description ?? "",
    ]];
  });
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

tasksRouter.get("/review-items/export", async (req, res, next) => {
  try {
    const batchId = typeof req.query.batchId === "string" ? req.query.batchId.trim() : "";
    if (batchId && !/^[a-zA-Z0-9_-]+$/.test(batchId)) {
      return res.status(400).json({ error: { code: "INVALID_BATCH_ID", message: "批处理 ID 格式不正确", requestId: crypto.randomUUID() } });
    }
    const region = exportFilterRegion(req.query.region);
    const status = exportFilterStatus(req.query.status);
    const differenceMin = exportFilterNumber(req.query.differenceMin);
    const differenceMax = exportFilterNumber(req.query.differenceMax);
    if (region === null || status === null || differenceMin === null || differenceMax === null) {
      return res.status(400).json({ error: { code: "INVALID_REVIEW_EXPORT_FILTER", message: "差异报表筛选条件不正确", requestId: crypto.randomUUID() } });
    }
    const items = status
      ? await (async () => {
        const matched: StoredReviewItem[] = [];
        for (let page = 1; ; page += 1) {
          const result = await listReviewRecords({ page, pageSize: 200, statuses: [status], fresh: true });
          matched.push(...result.items);
          if (!result.hasMore) return matched;
        }
      })()
      : await loadAllReviewRecords();
    const parentTasks = await getTaskRecords([...new Set(items.flatMap((item) => item.taskRecordId ? [item.taskRecordId] : []))]);
    const csv = buildReviewExportCsv(items, new Map(parentTasks.map((task) => [task.id, task])), batchId || undefined, { region, status, differenceMin, differenceMax });
    const fileName = `${batchId ? `${batchId}-` : ""}差异明细报表.csv`;
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    return res.send(`\uFEFF${csv}`);
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
      differenceAmount: comparableDifferenceAmount(task)?.toString() ?? null,
      scopeMismatch: isScopeMismatchTask(task),
    },
    comparisonNote: comparisonNote(task.rawAgentJson),
    createdAt: task.createdAt, completedAt: task.completedAt, createdBy: task.createdBy,
  };
}

function comparisonNote(rawAgentJson: string | null) {
  if (!rawAgentJson) return null;
  try {
    const basisReason = String((JSON.parse(rawAgentJson) as Record<string, unknown>).basisReason ?? "").trim();
    return basisReason.match(/扣点对比：[^。]{1,260}/)?.[0] ?? null;
  } catch {
    return null;
  }
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
  return isScopedReconciliationIssue(value);
}

export function toDetail(task: StoredTask, reviewItems: StoredReviewItem[]) {
  const differenceAmount = comparableDifferenceAmount(task);
  return {
    ...toSummary(task), resolvedAt: task.status === "REVIEWED" ? task.completedAt : null,
    failure: task.failureReason ? { code: "RECONCILIATION_FAILED", message: task.failureReason } : null,
    reviewItems: reviewItems.map((item) => ({
      id: item.id, rowLabel: item.title, fieldName: item.title,
      settlementValue: task.settlementAmount?.toString() ?? null,
      erpValue: task.erpAmount?.toString() ?? null,
      differenceAmount: differenceAmount?.toString() ?? null,
      status: item.status, message: item.message, suggestion: item.suggestion,
      payload: {
        rowLabel: item.title,
        fieldName: item.title,
        settlementAmount: task.settlementAmount?.toString() ?? null,
        erpAmount: task.erpAmount?.toString() ?? null,
        message: item.message,
        suggestion: item.suggestion,
      },
      resolvedAt: item.resolvedAt,
    })),
    progressLogs: getTaskProgress(task.id),
  };
}

export function toReviewListRow(item: StoredReviewItem, parentTask: StoredTask | null = null) {
  const taskId = parentTask?.id ?? item.taskRecordId ?? item.taskId;
  const differenceAmount = parentTask ? comparableDifferenceAmount(parentTask) : item.differenceAmount;
  return {
    task: {
      id: taskId,
      name: parentTask?.shopNo ?? item.shopNo ?? item.taskId,
      status: parentTask?.status ?? (item.status === "PENDING" ? "NEEDS_REVIEW" : "REVIEWED"),
      periodLabel: parentTask?.period ?? null,
    },
    item: {
      id: item.id,
      rowLabel: item.title,
      fieldName: item.title,
      settlementValue: parentTask?.settlementAmount?.toString() ?? null,
      erpValue: parentTask?.erpAmount?.toString() ?? null,
      differenceAmount: differenceAmount?.toString() ?? null,
      status: item.status,
      message: item.message,
      suggestion: item.suggestion,
    },
  };
}
