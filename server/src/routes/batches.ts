import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { config } from "../lib/config.js";
import {
  buildErpDataFromParsedRows,
  ErpImportError,
  parseErpWorkbook,
  type ParsedErpImportRow,
} from "../lib/erp-import.js";
import {
  buildErpLookupKeys,
  ErpBaseQueryError,
  normalizeShopNo,
  queryErpReconciliationData,
} from "../lib/erp-base-query.js";
import {
  chooseExcelSettlementCandidate,
  type ExcelSettlementCandidate,
  extractPeriodFromFileName,
  isExcelFileName,
  readExcelSettlementDocuments,
} from "../lib/excel-settlement.js";
import { settlementFileRejectionReason } from "../lib/settlement-file-rules.js";
import {
  buildBatchExportCsv,
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
import { createReconciliationTask, type ProgressLog } from "../services/reconciliation.js";

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
const excelExtensions = new Set([".xlsx", ".xls"]);
const excelMimeTypes = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);
const readinessIssuePattern = /(文件名未识别到店铺号|未识别到 ERP 月份|未确认结算金额|ERP 明细匹配失败|飞书 ERP 明细表未找到|上传 ERP 文件未找到|候选不唯一|执行时将按单文件流程)/;

type UploadError = { code: string; message: string };

type BatchPrecheckContext = {
  batchId: string;
  index: number;
  runningTotalSize: number;
  seenHashes: Set<string>;
  uploadedErpRows: ParsedErpImportRow[] | null;
  uploadedErpError: string;
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

    const erpError = validateErpUpload(erp);
    if (erpError) return res.status(400).json(errorPayload(erpError.code, erpError.message));

    const batchId = crypto.randomUUID();
    const now = new Date().toISOString();
    const erpFile = erp ? saveBatchUploadedFile(batchId, erp.buffer, erp.originalname, erp.mimetype) : null;
    let uploadedErpRows: ParsedErpImportRow[] | null = null;
    let uploadedErpError = "";
    if (erpFile) {
      try {
        uploadedErpRows = await parseErpWorkbook(erpFile.absolutePath, erpFile.originalName);
      } catch (error) {
        uploadedErpError = error instanceof Error ? error.message : "ERP 文件读取失败";
      }
    }

    const state: BatchState = {
      id: batchId,
      recordId: null,
      status: "DRAFT",
      totalFiles: settlements.length,
      totalSize: settlements.reduce((sum, file) => sum + file.size, 0),
      maxFiles: batchMaxFiles,
      maxTotalSize: batchMaxTotalBytes,
      erpFile,
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
        uploadedErpRows,
        uploadedErpError,
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

    rebuildBatchGroups(state);
    const executableDocuments = state.documents.filter(isExecutableDocument);
    if (!executableDocuments.length) {
      return res.status(409).json(errorPayload("BATCH_NOT_EXECUTABLE", "没有可执行的批量对账单据，请先补全店铺号或移除无效文件"));
    }

    const items: Array<{
      fileName: string;
      groupId: string | null;
      taskId: string | null;
      status: "PROCESSING" | "REJECTED" | "FAILED";
      error: UploadError | null;
      logs: ProgressLog[];
    }> = [];

    for (const document of executableDocuments) {
      const logs: ProgressLog[] = [];
      try {
        const task = await createReconciliationTask({
          batchId: state.id,
          settlementFile: toTaskUploadFile(document.file),
          erpFile: state.erpFile ? toTaskUploadFile(state.erpFile) : undefined,
          agentSelector,
          settlementIdentity: document.shopNo ? {
            shopNo: document.shopNo,
            period: document.period ?? "",
            documentLabel: document.fileName,
          } : undefined,
          onProgress: (log) => logs.push(log),
          onSettled: async (result) => {
            const latest = readBatchState(state.id);
            if (!latest) return;
            const nextStatus = documentStatusFromTaskStatus(result.status);
            const target = latest.documents.find((item) => item.id === document.id);
            if (!target) return;
            target.status = nextStatus;
            target.taskId = result.taskId;
            target.updatedAt = new Date().toISOString();
            if (result.message && nextStatus === "FAILED") target.issues = [...target.issues, result.message];
            await syncBatchState(latest, [target.id]);
          },
        });
        document.status = "PROCESSING";
        document.taskId = task.id;
        document.updatedAt = new Date().toISOString();
        await syncBatchState(state, [document.id]);
        items.push({
          fileName: document.fileName,
          groupId: document.groupId,
          taskId: task.id,
          status: task.status,
          error: null,
          logs,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "创建批量组任务失败";
        items.push({
          fileName: document.fileName,
          groupId: document.groupId,
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

async function precheckSettlementFile(
  file: Express.Multer.File,
  stored: ReturnType<typeof saveBatchUploadedFile>,
  context: BatchPrecheckContext,
): Promise<BatchDocumentState[]> {
  const fileName = stored.originalName;
  const issues: string[] = [];
  let status: BatchDocumentStatus = "READY";
  const sha256 = crypto.createHash("sha256").update(file.buffer).digest("hex");

  const fileTypeError = validateSettlementUpload(file);
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
      context,
    })];
  }

  if (status !== "REJECTED" && status !== "DUPLICATE" && !isExcelFileName(fileName)) {
    issues.push("执行时将按单文件流程交给 CherryStudio Agent 抽取结算金额");
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
    context,
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
  context: Pick<BatchPrecheckContext, "uploadedErpRows" | "uploadedErpError">;
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
  let status = params.status;
  const issues = [...params.issues];
  if (status !== "REJECTED" && status !== "DUPLICATE") {
    if (params.shopCodes.length === 0) {
      issues.push("文件名未识别到店铺号");
      status = "NEEDS_REVIEW";
    } else if (params.shopCodes.length > 1) {
      issues.push(`文件名包含多个店铺号（${params.shopCodes.join("、")}），请拆成单店铺结算单或人工确认拆单`);
      status = "NEEDS_REVIEW";
    }
    if (!params.period) {
      issues.push("未从文件名识别到账期，执行时将按单文件流程从结算单正文抽取");
    }
    if (isExcelFileName(params.fileName) && !chosen) {
      issues.push(amountCandidates.length
        ? "Excel 本地金额候选不唯一，执行时将按单文件流程交给 Agent 识别"
        : "Excel 中未识别到净营业额候选，执行时将按单文件流程交给 Agent 识别");
    }
  }

  const erpData = await tryResolveErpData(params.shopCodes, params.period, params.context, issues);

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
    erpRows: erpData?.rows.length ?? null,
    erpSalesTotal: erpData?.salesTotal ?? null,
    status,
    issues,
  });
}

async function tryResolveErpData(
  shopCodes: string[],
  period: string | null,
  context: Pick<BatchPrecheckContext, "uploadedErpRows" | "uploadedErpError">,
  issues: string[],
) {
  if (shopCodes.length !== 1 || !period) return null;
  try {
    if (context.uploadedErpError) throw new ErpImportError(context.uploadedErpError, "ERP_IMPORT_READ_FAILED");
    return context.uploadedErpRows
      ? buildErpDataFromParsedRows(context.uploadedErpRows, shopCodes[0], period)
      : await queryErpReconciliationData(shopCodes[0], period);
  } catch (error) {
    const message = error instanceof ErpBaseQueryError || error instanceof ErpImportError ? error.message : "ERP 明细匹配失败";
    issues.push(message);
    return null;
  }
}

async function refreshDocumentReadiness(state: BatchState, document: BatchDocumentState) {
  document.issues = document.issues.filter((issue) => !readinessIssuePattern.test(issue));
  if (document.status === "REJECTED" || document.status === "DUPLICATE") return;
  if (!document.shopNo) document.issues.push("文件名未识别到店铺号");

  if (document.shopNo && document.period) {
    const erpRows = state.erpFile ? await parseErpWorkbook(state.erpFile.absolutePath, state.erpFile.originalName).catch(() => null) : null;
    const erpData = await tryResolveErpData([document.shopNo], document.period, {
      uploadedErpRows: erpRows,
      uploadedErpError: "",
    }, document.issues);
    document.erpRows = erpData?.rows.length ?? document.erpRows;
    document.erpSalesTotal = erpData?.salesTotal ?? document.erpSalesTotal;
  }

  document.status = document.shopNo
    ? "READY"
    : "NEEDS_REVIEW";
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

function validateSettlementUpload(file: Express.Multer.File): UploadError | null {
  if (!settlementExtensions.has(path.extname(file.originalname).toLowerCase())
    || Boolean(file.mimetype && file.mimetype !== "application/octet-stream" && !settlementMimeTypes.has(file.mimetype))) {
    return { code: "INVALID_FILE_TYPE", message: "仅支持 Excel、PDF、PNG 和 JPG 文件" };
  }
  const rejectedReason = settlementFileRejectionReason(file.originalname);
  if (rejectedReason) return { code: "NOT_SETTLEMENT_FILE", message: rejectedReason };
  return null;
}

function validateErpUpload(file: Express.Multer.File | undefined): UploadError | null {
  if (!file) return null;
  if (!excelExtensions.has(path.extname(file.originalname).toLowerCase())
    || Boolean(file.mimetype && file.mimetype !== "application/octet-stream" && !excelMimeTypes.has(file.mimetype))) {
    return { code: "INVALID_ERP_FILE_TYPE", message: "ERP 文件仅支持 Excel" };
  }
  return null;
}

function isExecutableDocument(document: BatchDocumentState) {
  return !["REJECTED", "DUPLICATE", "PROCESSING", "SUCCEEDED", "CANCELLED"].includes(document.status)
    && !document.taskId
    && Boolean(document.shopNo);
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
