import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { config } from "../lib/config.js";
import { buildErpLookupKeys, normalizeShopNo } from "../lib/erp-base-query.js";
import {
  chooseExcelSettlementCandidate,
  type ExcelSettlementCandidate,
  extractPeriodFromFileName,
  isExcelFileName,
  readExcelSettlementDocuments,
} from "../lib/excel-settlement.js";
import { settlementFileHardRejectionReason } from "../lib/settlement-file-rules.js";
import {
  buildBatchExportCsv,
  buildBatchExecutionGroups,
  createBatchDocument,
  persistNewBatch,
  readBatchState,
  rebuildBatchGroups,
  saveBatchUploadedFile,
  syncBatchState,
  toBatchApi,
  type BatchAmountCandidate,
  type BatchDocumentState,
  type BatchDocumentStatus,
  type BatchState,
} from "../lib/batch-store.js";
import { approveTaskPendingReviews, failTaskRecord, getTaskDetail, markTaskPendingReviewsScopeMismatch, type StoredReviewItem } from "../lib/lark-store.js";
import { createReconciliationTask, hasInFlightReconciliationTask, type ProgressLog } from "../services/reconciliation.js";

export const batchesRouter = Router();

const batchMaxFiles = 30;
const batchMaxTotalBytes = 200 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes } });
const settlementExtensions = new Set([".xlsx", ".xls", ".pdf", ".png", ".jpg", ".jpeg"]);
const settlementMimeTypes = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/pdf",
  "image/png",
  "image/jpeg",
]);
const readinessIssuePattern = /(文件名未识别到主体|文件名包含多个主体|未从文件名识别到账期|Excel 本地金额候选|执行时将按单文件流程|执行时将由 CherryStudio Agent|执行时将交给 Agent)/;

type UploadError = { code: string; message: string };

type BatchPrecheckContext = {
  batchId: string;
  index: number;
  runningTotalSize: number;
  seenHashes: Set<string>;
};

function errorPayload(code: string, message: string) {
  return { error: { code, message, requestId: crypto.randomUUID() } };
}

function parseAgentSelector(body: unknown): { name: string; workspace?: string } | UploadError {
  const payload = body as Record<string, unknown> | undefined;
  const name = typeof payload?.agentName === "string" && payload.agentName.trim()
    ? payload.agentName.trim()
    : config.cherryStudio.defaultAgentName;
  const workspace = typeof payload?.agentWorkspace === "string" && payload.agentWorkspace.trim()
    ? payload.agentWorkspace.trim()
    : config.cherryStudio.defaultAgentWorkspace;
  if (!name) return { code: "AGENT_NAME_REQUIRED", message: "agentName 为必填字段" };
  return { name, workspace: workspace || undefined };
}

batchesRouter.post("/", upload.fields([
  { name: "settlementFiles", maxCount: 200 },
  { name: "erpFile", maxCount: 1 },
]), async (req, res, next) => {
  try {
    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
    const settlements = files?.settlementFiles ?? [];
    const erp = files?.erpFile?.[0];
    if (!settlements.length) {
      return res.status(400).json(errorPayload("MISSING_FILES", "需要上传至少一份结算资料"));
    }
    if (erp) {
      return res.status(400).json(errorPayload("ERP_FILE_NOT_ALLOWED", "批量对账不再接收 ERP 文件，ERP/DRP 金额由 Agent 通过 MCP 查询"));
    }

    const batchId = crypto.randomUUID();
    const now = new Date().toISOString();

    const state: BatchState = {
      id: batchId,
      recordId: null,
      status: "DRAFT",
      totalFiles: settlements.length,
      totalSize: settlements.reduce((sum, file) => sum + file.size, 0),
      maxFiles: batchMaxFiles,
      maxTotalSize: batchMaxTotalBytes,
      erpFile: null,
      documents: [],
      groups: [],
      createdAt: now,
      updatedAt: now,
    };

    const seenHashes = new Set<string>();
    let runningTotalSize = 0;
    for (const [index, settlement] of settlements.entries()) {
      runningTotalSize += settlement.size;
      const stored = saveBatchUploadedFile(batchId, settlement.buffer, settlement.originalname, settlement.mimetype);
      state.documents.push(...await precheckSettlementFile(settlement, stored, {
        batchId,
        index,
        runningTotalSize,
        seenHashes,
      }));
    }

    await persistNewBatch(state);
    return res.json({ data: toBatchApi(state), requestId: crypto.randomUUID() });
  } catch (error) {
    next(error);
  }
});

batchesRouter.patch("/documents/:documentId/identity", async (req, res, next) => {
  try {
    const found = findDocument(req.params.documentId);
    if (!found) return res.status(404).json(errorPayload("DOCUMENT_NOT_FOUND", "未找到批量结算单明细"));
    const { state, document } = found;
    const shopNo = typeof req.body?.shopNo === "string" ? normalizeShopNo(req.body.shopNo) : "";
    const period = typeof req.body?.period === "string" ? req.body.period.trim() : "";
    if (shopNo && !/^[A-Z]{2,5}[A-Z0-9]*\d[A-Z0-9]*$/.test(shopNo)) {
      return res.status(400).json(errorPayload("INVALID_SHOP_NO", "店铺号格式不正确"));
    }
    if (period && !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
      return res.status(400).json(errorPayload("INVALID_PERIOD", "账期必须为 YYYY-MM"));
    }

    if (shopNo) {
      document.shopNo = shopNo;
      document.shopCodes = [shopNo];
    }
    if (period) document.period = period;
    document.version += 1;
    await refreshDocumentReadiness(state, document);
    await syncBatchState(state, [document.id]);
    await approveResolvedSplitGroupReviews(state, [document.id]);
    return res.json({ data: toBatchApi(state), requestId: crypto.randomUUID() });
  } catch (error) {
    next(error);
  }
});

batchesRouter.patch("/documents/:documentId/amount", async (req, res, next) => {
  try {
    const found = findDocument(req.params.documentId);
    if (!found) return res.status(404).json(errorPayload("DOCUMENT_NOT_FOUND", "未找到批量结算单明细"));
    const { state, document } = found;
    const candidateId = typeof req.body?.candidateId === "string" ? req.body.candidateId : "";
    const manualAmount = typeof req.body?.amount === "number" ? req.body.amount : Number(req.body?.amount);
    const manualLabel = typeof req.body?.label === "string" && req.body.label.trim() ? req.body.label.trim() : "人工确认金额";

    if (candidateId) {
      const candidate = document.amountCandidates.find((item) => item.id === candidateId);
      if (!candidate) return res.status(400).json(errorPayload("CANDIDATE_NOT_FOUND", "未找到该金额候选"));
      document.confirmedCandidateId = candidate.id;
      document.confirmedSettlementAmount = candidate.amount;
      document.confirmedSettlementLabel = candidate.label;
    } else if (Number.isFinite(manualAmount) && manualAmount > 0) {
      document.confirmedCandidateId = null;
      document.confirmedSettlementAmount = Math.round(manualAmount * 100) / 100;
      document.confirmedSettlementLabel = manualLabel;
    } else {
      return res.status(400).json(errorPayload("INVALID_AMOUNT", "确认金额必须是大于 0 的数字"));
    }

    document.version += 1;
    await refreshDocumentReadiness(state, document);
    await syncBatchState(state, [document.id]);
    await approveResolvedSplitGroupReviews(state, [document.id]);
    return res.json({ data: toBatchApi(state), requestId: crypto.randomUUID() });
  } catch (error) {
    next(error);
  }
});

batchesRouter.get("/:id", async (req, res) => {
  const state = readBatchState(req.params.id);
  if (!state) return res.status(404).json(errorPayload("BATCH_NOT_FOUND", "未找到批量对账批次"));
  return res.json({ data: toBatchApi(state), requestId: crypto.randomUUID() });
});

batchesRouter.get("/:id/export", async (req, res) => {
  const state = readBatchState(req.params.id);
  if (!state) return res.status(404).json(errorPayload("BATCH_NOT_FOUND", "未找到批量对账批次"));
  const csv = buildBatchExportCsv(state);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${state.id}-batch-export.csv`)}`);
  return res.send(`\uFEFF${csv}`);
});

batchesRouter.post("/:id/execute", async (req, res, next) => {
  try {
    const state = readBatchState(req.params.id);
    if (!state) return res.status(404).json(errorPayload("BATCH_NOT_FOUND", "未找到批量对账批次"));
    const agentSelector = parseAgentSelector(req.body);
    if ("code" in agentSelector) {
      return res.status(400).json(errorPayload(agentSelector.code, agentSelector.message));
    }

    const recoveredDocumentIds = await recoverInterruptedBatchDocuments(state);
    if (recoveredDocumentIds.length) await syncBatchState(state, recoveredDocumentIds);

    rebuildBatchGroups(state);
    const executableGroups = buildBatchExecutionGroups(state);
    if (!executableGroups.length) {
      return res.status(409).json(errorPayload("BATCH_NOT_EXECUTABLE", "没有可执行的批量对账单据，请移除无效或重复文件"));
    }

    const items: Array<{
      fileName: string;
      groupId: string | null;
      taskId: string | null;
      status: "PROCESSING" | "REJECTED" | "FAILED";
      error: UploadError | null;
      logs: ProgressLog[];
    }> = [];

    for (const unit of executableGroups) {
      const logs: ProgressLog[] = [];
      const unitDocuments = unit.documentIds
        .map((documentId) => state.documents.find((document) => document.id === documentId))
        .filter((document): document is BatchDocumentState => Boolean(document));
      try {
        const task = await createReconciliationTask({
          batchId: state.id,
          settlementFiles: unitDocuments.map((document) => toTaskUploadFile(document.file)),
          agentSelector,
          settlementHint: {
            name: unit.shopNo ?? undefined,
            period: unit.period ?? undefined,
            documentLabel: unit.fileName,
            documentLabels: unitDocuments.map((document) => document.fileName),
          },
          onProgress: (log) => logs.push(log),
          onQueued: async ({ taskId }) => {
            await markDocumentsTaskStarted(state.id, unit.documentIds, taskId);
          },
          onSettled: async (result) => {
            const latest = readBatchState(state.id);
            if (!latest) return;
            const nextStatus = documentStatusFromTaskStatus(result.status);
            const targets = unit.documentIds
              .map((documentId) => latest.documents.find((item) => item.id === documentId))
              .filter((document): document is BatchDocumentState => Boolean(document));
            if (!targets.length) return;
            const completedDetail = await getTaskDetail(result.taskId);
            const isCombinedGroupTask = targets.length > 1;
            for (const target of targets) {
              applySettledTaskToDocument(target, result.taskId, nextStatus, completedDetail, result.message, { groupResult: isCombinedGroupTask });
            }
            await syncBatchState(latest, targets.map((target) => target.id));
            if (isCombinedGroupTask) {
              await approveResolvedSplitGroupReviews(latest, targets.map((target) => target.id));
            } else {
              await markUnresolvedSplitGroupReviews(latest, targets.map((target) => target.id));
            }
          },
        });
        items.push({
          fileName: unit.fileName,
          groupId: unit.groupId,
          taskId: task.id,
          status: task.status,
          error: null,
          logs,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "创建批量组任务失败";
        items.push({
          fileName: unit.fileName,
          groupId: unit.groupId,
          taskId: null,
          status: "FAILED",
          error: { code: "CREATE_BATCH_TASK_FAILED", message },
          logs,
        });
      }
    }

    return res.status(202).json({
      data: {
        batchId: state.id,
        total: items.length,
        created: items.filter((item) => Boolean(item.taskId)).length,
        rejected: items.filter((item) => item.status === "REJECTED").length,
        failed: items.filter((item) => item.status === "FAILED").length,
        items,
      },
      requestId: crypto.randomUUID(),
    });
  } catch (error) {
    next(error);
  }
});

const settledDocumentStatuses = new Set<BatchDocumentStatus>(["SUCCEEDED", "FAILED", "CANCELLED", "NEEDS_REVIEW"]);

export function applyDocumentTaskStarted(
  document: Pick<BatchDocumentState, "status" | "taskId" | "updatedAt">,
  taskId: string,
  now = new Date().toISOString(),
) {
  if (!settledDocumentStatuses.has(document.status)) document.status = "PROCESSING";
  document.taskId ??= taskId;
  document.updatedAt = now;
}

export function applyDocumentTaskInterrupted(
  document: Pick<BatchDocumentState, "status" | "taskId" | "issues" | "updatedAt">,
  message: string,
  now = new Date().toISOString(),
) {
  if (document.status !== "PROCESSING" || !document.taskId) return false;
  document.status = "READY";
  document.taskId = null;
  document.issues = uniqueTexts([...document.issues, message]);
  document.updatedAt = now;
  return true;
}

async function markDocumentsTaskStarted(batchId: string, documentIds: string[], taskId: string) {
  const latest = readBatchState(batchId);
  if (!latest) return;
  const targets = latest.documents.filter((item) => documentIds.includes(item.id));
  if (!targets.length) return;
  for (const target of targets) applyDocumentTaskStarted(target, taskId);
  await syncBatchState(latest, targets.map((target) => target.id));
}

async function recoverInterruptedBatchDocuments(state: BatchState) {
  const changedIds: string[] = [];
  const processingTaskDocumentCounts = new Map<string, number>();
  for (const document of state.documents) {
    if (document.status === "PROCESSING" && document.taskId) {
      processingTaskDocumentCounts.set(document.taskId, (processingTaskDocumentCounts.get(document.taskId) ?? 0) + 1);
    }
  }
  for (const document of state.documents) {
    const taskId = document.taskId;
    if (document.status !== "PROCESSING" || !taskId || hasInFlightReconciliationTask(taskId)) continue;

    const completedDetail = await getTaskDetail(taskId);
    const completedTask = completedDetail?.task;
    if (completedTask && !["PROCESSING", "QUEUED"].includes(completedTask.status)) {
      applySettledTaskToDocument(
        document,
        taskId,
        documentStatusFromTaskStatus(completedTask.status),
        completedDetail,
        completedTask.failureReason,
        { groupResult: (processingTaskDocumentCounts.get(taskId) ?? 0) > 1 },
      );
      changedIds.push(document.id);
      continue;
    }

    await failTaskRecord(taskId, state.id, "BATCH_TASK_INTERRUPTED: 后端服务重启或执行进程中断，内存队列丢失；已释放批量明细以便重新执行");
    if (applyDocumentTaskInterrupted(document, "上一次执行因后端服务重启或进程中断未完成，已自动恢复为可重新执行")) {
      changedIds.push(document.id);
    }
  }
  return changedIds;
}

function applySettledTaskToDocument(
  document: BatchDocumentState,
  taskId: string,
  status: BatchDocumentStatus,
  completedDetail: Awaited<ReturnType<typeof getTaskDetail>>,
  failureMessage: string | null,
  options: { groupResult?: boolean } = {},
) {
  const completedTask = completedDetail?.task;
  if (completedTask) {
    const settlementLabel = extractAgentSettlementLabel(completedTask.rawAgentJson);
    document.shopNo = completedTask.shopNo ?? document.shopNo;
    document.period = completedTask.period ?? document.period;
    if (options.groupResult) {
      document.groupSettlementAmount = completedTask.settlementAmount ?? document.groupSettlementAmount ?? null;
      document.groupSettlementLabel = settlementLabel ?? document.groupSettlementLabel ?? null;
      document.groupErpSalesTotal = completedTask.erpAmount ?? document.groupErpSalesTotal ?? null;
    } else {
      document.confirmedSettlementAmount = completedTask.settlementAmount ?? document.confirmedSettlementAmount;
      document.confirmedSettlementLabel = settlementLabel ?? document.confirmedSettlementLabel;
      const salesSettlement = extractAgentSalesSettlement(
        completedTask.rawAgentJson,
        document.confirmedSettlementAmount,
        document.confirmedSettlementLabel,
      );
      document.salesSettlementAmount = salesSettlement?.amount ?? document.salesSettlementAmount ?? null;
      document.salesSettlementLabel = salesSettlement?.label ?? document.salesSettlementLabel ?? null;
    }
    document.erpSalesTotal = completedTask.erpAmount ?? document.erpSalesTotal;
    const erpTotals = extractAgentErpTotals(completedTask.rawAgentJson);
    document.erpRawSalesTotal = erpTotals.salesTotal ?? document.erpRawSalesTotal ?? null;
    document.erpRawNetSalesTotal = erpTotals.netSalesTotal ?? document.erpRawNetSalesTotal ?? null;
  }
  document.status = status;
  document.taskId = taskId;
  document.issues = settledDocumentIssues(document.issues, status, completedDetail?.reviewItems ?? [], failureMessage);
  document.updatedAt = new Date().toISOString();
}

async function approveResolvedSplitGroupReviews(state: BatchState, changedDocumentIds: string[]) {
  const changedIds = new Set(changedDocumentIds);
  const resolvedGroups = state.groups.filter((group) => (
    group.status === "SUCCEEDED"
    && group.documentCount > 1
    && group.documentIds.some((documentId) => changedIds.has(documentId))
    && Number.isFinite(group.settlementAmount)
    && Number.isFinite(group.erpSalesTotal)
    && Number.isFinite(group.differenceAmount)
  ));
  for (const group of resolvedGroups) {
    const periodLabel = group.period ?? "账期待识别";
    const note = `同批同店同账期拆单合计已匹配：${group.shopNo} ${periodLabel}，${group.documentCount} 份结算单合计 ${group.settlementAmount?.toFixed(2)} 元，ERP 可比金额 ${group.erpSalesTotal?.toFixed(2)} 元，合计差额 ${group.differenceAmount?.toFixed(2)} 元；单张差额属于拆单范围差，不作为异常。`;
    const taskIds = uniqueTexts(group.documentIds
      .map((documentId) => state.documents.find((document) => document.id === documentId)?.taskId));
    for (const taskId of taskIds) await approveTaskPendingReviews(taskId, note);
  }
}

async function markUnresolvedSplitGroupReviews(state: BatchState, changedDocumentIds: string[]) {
  const changedIds = new Set(changedDocumentIds);
  const unresolvedGroups = state.groups.filter((group) => (
    group.status === "NEEDS_REVIEW"
    && group.documentCount > 1
    && group.documentIds.some((documentId) => changedIds.has(documentId))
  ));
  const changedDocuments = new Set<string>();

  for (const group of unresolvedGroups) {
    const documents = group.documentIds
      .map((documentId) => state.documents.find((document) => document.id === documentId))
      .filter((document): document is BatchDocumentState => Boolean(document));
    if (!documents.length || documents.some((document) => !["SUCCEEDED", "NEEDS_REVIEW"].includes(document.status))) continue;

    const note = unresolvedSplitGroupScopeReviewNote(group);
    for (const document of documents.filter((item) => item.status === "NEEDS_REVIEW" && item.taskId)) {
      const taskId = document.taskId;
      if (!taskId) continue;
      document.issues = uniqueTexts([...document.issues, note]);
      document.updatedAt = new Date().toISOString();
      changedDocuments.add(document.id);
      await markTaskPendingReviewsScopeMismatch(taskId, note);
    }
  }

  if (changedDocuments.size) await syncBatchState(state, [...changedDocuments]);
}

export function unresolvedSplitGroupScopeReviewNote(group: Pick<BatchState["groups"][number], "shopNo" | "period" | "documentCount" | "settlementAmount" | "erpSalesTotal" | "differenceAmount">) {
  const settlement = Number.isFinite(group.settlementAmount) ? `${group.settlementAmount?.toFixed(2)} 元` : "未知";
  const erp = Number.isFinite(group.erpSalesTotal) ? `${group.erpSalesTotal?.toFixed(2)} 元` : "组内 ERP 口径/金额不一致";
  const difference = Number.isFinite(group.differenceAmount) ? `组级差额 ${group.differenceAmount?.toFixed(2)} 元` : "无法计算稳定组级差额";
  return `同批同店同账期拆单未能与 ERP 同范围对齐：${group.shopNo} ${group.period ?? "账期待识别"}，${group.documentCount} 份结算单合计 ${settlement}，ERP 可比金额 ${erp}，${difference}；单张 full-shop 差额属于范围差，不作为可结算差额。`;
}

async function precheckSettlementFile(
  file: Express.Multer.File,
  stored: ReturnType<typeof saveBatchUploadedFile>,
  context: BatchPrecheckContext,
): Promise<BatchDocumentState[]> {
  const fileName = stored.originalName;
  const issues: string[] = [];
  let status: BatchDocumentStatus = "READY";
  const sha256 = crypto.createHash("sha256").update(file.buffer).digest("hex");

  const fileTypeError = validateBatchSettlementUpload(stored.originalName, file.mimetype);
  if (fileTypeError) {
    issues.push(fileTypeError.message);
    status = "REJECTED";
  }
  if (context.index >= batchMaxFiles) {
    issues.push(`单次最多 ${batchMaxFiles} 份，超出部分不会执行`);
    status = "REJECTED";
  }
  if (context.runningTotalSize > batchMaxTotalBytes) {
    issues.push("单次总大小不能超过 200 MB，超出部分不会执行");
    status = "REJECTED";
  }
  if (context.seenHashes.has(sha256)) {
    issues.push("文件哈希重复，已去重");
    status = "DUPLICATE";
  } else {
    context.seenHashes.add(sha256);
  }

  const shopCodes = buildErpLookupKeys(fileName);
  let period = extractPeriodFromFileName(fileName);
  if (status !== "REJECTED" && isExcelFileName(fileName)) {
    const documents = await readExcelSettlementDocuments(stored.absolutePath, stored.originalName);
    const document = documents[0];
    period = document?.period || period;
    return [await completePrecheckDocument({
      batchId: context.batchId,
      file: stored,
      fileName,
      sourceFileName: null,
      sha256,
      shopCodes,
      period,
      documentNo: document?.documentNo ?? null,
      documentRange: document ? `${document.sheetName} ${document.rowStart}-${document.rowEnd} 行` : null,
      candidates: document?.candidates ?? [],
      status,
      issues: [
        ...issues,
        ...(document || status === "DUPLICATE" ? [] : ["Excel 中未识别到净营业额候选"]),
      ],
    })];
  }

  if (status !== "REJECTED" && status !== "DUPLICATE" && !isExcelFileName(fileName)) {
    issues.push("执行时将由 CherryStudio Agent 抽取结算金额；同店拆分单据会合并后对账");
  }

  return [await completePrecheckDocument({
    batchId: context.batchId,
    file: stored,
    fileName,
    sourceFileName: null,
    sha256,
    shopCodes,
    period,
    documentNo: null,
    documentRange: null,
    candidates: [],
    status,
    issues,
  })];
}

async function completePrecheckDocument(params: {
  batchId: string;
  file: ReturnType<typeof saveBatchUploadedFile>;
  fileName: string;
  sourceFileName: string | null;
  sha256: string;
  shopCodes: string[];
  period: string | null;
  documentNo: string | null;
  documentRange: string | null;
  candidates: ExcelSettlementCandidate[];
  status: BatchDocumentStatus;
  issues: string[];
}) {
  const amountCandidates = toBatchCandidates(params.candidates);
  const chosenCandidate = chooseExcelSettlementCandidate(amountCandidates);
  const chosen = chosenCandidate
    ? amountCandidates.find((candidate) => (
      candidate.row === chosenCandidate.row
      && candidate.column === chosenCandidate.column
      && candidate.label === chosenCandidate.label
      && candidate.amount === chosenCandidate.amount
    )) ?? null
    : null;
  const status = params.status;
  const issues = [...params.issues];
  if (status !== "REJECTED" && status !== "DUPLICATE") {
    if (params.shopCodes.length === 0) {
      issues.push("文件名未识别到主体，执行时将由 Agent 从结算单正文判断");
    } else if (params.shopCodes.length > 1) {
      issues.push(`文件名包含多个主体候选（${params.shopCodes.join("、")}），执行时将由 Agent 以结算单正文为准`);
    }
    if (!params.period) {
      issues.push("未从文件名识别到账期，执行时将由 Agent 从结算单正文抽取");
    }
    if (isExcelFileName(params.fileName) && !chosen) {
      issues.push(amountCandidates.length
        ? "Excel 本地金额候选不唯一，执行时将交给 Agent 识别"
        : "Excel 中未识别到净营业额候选，执行时将交给 Agent 识别");
    }
  }

  return createBatchDocument({
    batchId: params.batchId,
    file: params.file,
    fileName: params.fileName,
    sourceFileName: params.sourceFileName,
    sha256: params.sha256,
    shopCodes: params.shopCodes,
    period: params.period,
    documentNo: params.documentNo,
    documentRange: params.documentRange,
    amountCandidates,
    confirmedCandidateId: chosen?.id ?? null,
    confirmedSettlementAmount: chosen?.amount ?? null,
    confirmedSettlementLabel: chosen?.label ?? null,
    erpRows: null,
    erpSalesTotal: null,
    status,
    issues,
  });
}

async function refreshDocumentReadiness(state: BatchState, document: BatchDocumentState) {
  document.issues = document.issues.filter((issue) => !readinessIssuePattern.test(issue));
  if (document.status === "REJECTED" || document.status === "DUPLICATE") return;
  if (!document.shopNo) document.issues.push("文件名未识别到主体，执行时将由 Agent 从结算单正文判断");
  if (!document.period) document.issues.push("未从文件名识别到账期，执行时将由 Agent 从结算单正文抽取");
  document.erpRows = null;
  document.erpSalesTotal = null;
  document.status = "READY";
  document.updatedAt = new Date().toISOString();
}

function toBatchCandidates(candidates: ExcelSettlementCandidate[]): BatchAmountCandidate[] {
  return candidates.map((candidate, index) => ({
    id: `${candidate.row}:${candidate.column}:${index}:${Math.round(candidate.amount * 100)}`,
    label: candidate.label,
    amount: candidate.amount,
    priority: candidate.priority,
    row: candidate.row,
    column: candidate.column,
  }));
}

function findDocument(documentId: string) {
  const batchId = documentId.split("-doc-")[0];
  const state = batchId ? readBatchState(batchId) : null;
  const document = state?.documents.find((item) => item.id === documentId);
  return state && document ? { state, document } : null;
}

export function validateBatchSettlementUpload(fileName: string, mimetype = "application/octet-stream"): UploadError | null {
  if (!settlementExtensions.has(path.extname(fileName).toLowerCase())
    || Boolean(mimetype && mimetype !== "application/octet-stream" && !settlementMimeTypes.has(mimetype))) {
    return { code: "INVALID_FILE_TYPE", message: "仅支持 Excel、PDF、PNG 和 JPG 文件" };
  }
  const rejectedReason = settlementFileHardRejectionReason(fileName);
  if (rejectedReason) return { code: "NOT_SETTLEMENT_FILE", message: rejectedReason };
  return null;
}

function isExecutableDocument(document: BatchDocumentState) {
  return !["REJECTED", "DUPLICATE", "PROCESSING", "SUCCEEDED", "CANCELLED"].includes(document.status)
    && !document.taskId;
}

function toTaskUploadFile(file: BatchDocumentState["file"]) {
  return {
    buffer: fs.readFileSync(file.absolutePath),
    originalName: file.originalName,
    contentType: file.contentType,
  };
}

function documentStatusFromTaskStatus(status: string): BatchDocumentStatus {
  if (status === "SUCCEEDED") return "SUCCEEDED";
  if (status === "FAILED") return "FAILED";
  if (status === "CANCELLED") return "CANCELLED";
  return "NEEDS_REVIEW";
}

function extractAgentSettlementLabel(rawAgentJson: string | null | undefined) {
  if (!rawAgentJson) return null;
  try {
    const payload = JSON.parse(rawAgentJson) as { settlementAmountLabel?: unknown };
    return typeof payload.settlementAmountLabel === "string" && payload.settlementAmountLabel.trim()
      ? payload.settlementAmountLabel.trim()
      : null;
  } catch {
    return null;
  }
}

function extractAgentSalesSettlement(
  rawAgentJson: string | null | undefined,
  selectedAmount: number | null,
  selectedLabel: string | null,
) {
  if (isSalesSettlementLabel(selectedLabel) && Number.isFinite(selectedAmount)) {
    return { amount: finiteGroupAmount(selectedAmount), label: selectedLabel };
  }
  if (!rawAgentJson) return null;
  try {
    const payload = JSON.parse(rawAgentJson) as {
      basisReason?: unknown;
      issues?: unknown;
    };
    const issues = Array.isArray(payload.issues)
      ? payload.issues.filter((issue): issue is string => typeof issue === "string")
      : typeof payload.issues === "string" ? [payload.issues] : [];
    const text = [
      typeof payload.basisReason === "string" ? payload.basisReason : "",
      ...issues,
    ].join(" ").normalize("NFKC").replace(/,/g, "");
    const match = /(本期实销金额|本期实销|实销金额|销售金额|销售额|销售收入|营业额)\s*(?:为|是|:|：|人民币)?\s*([+-]?\d+(?:\.\d+)?)/.exec(text);
    const amount = match ? finiteGroupAmount(Number(match[2])) : null;
    return amount !== null ? { amount, label: match?.[1] ?? "本期实销金额" } : null;
  } catch {
    return null;
  }
}

function isSalesSettlementLabel(label: string | null | undefined) {
  const normalized = (label ?? "").normalize("NFKC").replace(/\s+/g, "");
  return /(本期实销金额|本期实销|实销金额|销售金额|销售额|销售收入|营业额)/.test(normalized)
    && !/(净营业额|扣点后|结账金额|结帐金额|结算金额|应付金额|付款金额|开票|发票|含税进价)/.test(normalized);
}

function extractAgentErpTotals(rawAgentJson: string | null | undefined) {
  if (!rawAgentJson) return {};
  try {
    const payload = JSON.parse(rawAgentJson) as {
      salesTotal?: unknown;
      netSalesTotal?: unknown;
    };
    return {
      salesTotal: finiteGroupAmount(payload.salesTotal),
      netSalesTotal: finiteGroupAmount(payload.netSalesTotal),
    };
  } catch {
    return {};
  }
}

function finiteGroupAmount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

export function settledDocumentIssues(
  existingIssues: string[],
  status: BatchDocumentStatus,
  reviewItems: Pick<StoredReviewItem, "title" | "message" | "differenceAmount" | "suggestion">[] = [],
  failureMessage: string | null = null,
) {
  const retained = existingIssues.filter((issue) => !readinessIssuePattern.test(issue));
  if (status === "SUCCEEDED") return [];
  if (status === "FAILED") return uniqueTexts([...retained, failureMessage ?? "对账任务执行失败"]);
  if (status === "CANCELLED") return uniqueTexts([...retained, failureMessage ?? "对账任务已取消"]);
  if (status !== "NEEDS_REVIEW") return retained;

  const reviewMessages = reviewItems.map((item) => {
    const title = item.title?.trim();
    const message = item.message?.trim();
    if (!message) return "";
    const amount = Number.isFinite(item.differenceAmount ?? NaN) ? `（差额 ${Number(item.differenceAmount).toFixed(2)}）` : "";
    return title ? `${title}${amount}：${message}` : `${message}${amount}`;
  }).filter(Boolean);
  return reviewMessages.length ? uniqueTexts(reviewMessages) : uniqueTexts([...retained, failureMessage ?? "任务需要人工复核"]);
}

function uniqueTexts(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}
