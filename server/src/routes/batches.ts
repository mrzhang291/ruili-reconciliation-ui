import crypto from "node:crypto";
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
import { settlementFileHardRejectionReason } from "../lib/settlement-file-rules.js";
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
import { createReconciliationGroupTask, type ProgressLog } from "../services/reconciliation.js";

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
const readinessIssuePattern = /(文件名未识别到店铺号|未识别到 ERP 月份|未确认结算金额|ERP 明细匹配失败|飞书 ERP 明细表未找到|上传 ERP 文件未找到|候选不唯一|非 Excel 批量单据需要人工确认金额)/;

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
    rebuildBatchGroups(state);
    const readyGroups = state.groups.filter((group) => group.status === "READY");
    if (!readyGroups.length) {
      return res.status(409).json(errorPayload("BATCH_NOT_EXECUTABLE", "没有可执行的批量对账组，请先补全待处理单据"));
    }

    const items: Array<{
      fileName: string;
      groupId: string;
      taskId: string | null;
      status: "PROCESSING" | "REJECTED" | "FAILED";
      error: UploadError | null;
      logs: ProgressLog[];
    }> = [];

    for (const group of readyGroups) {
      const documents = group.documentIds.map((id) => state.documents.find((document) => document.id === id)).filter(isDocument);
      const executableDocuments = documents.filter((document) => (
        document.status === "READY"
        && document.shopNo
        && document.period
        && document.confirmedSettlementAmount !== null
        && document.confirmedSettlementLabel
      ));
      if (executableDocuments.length !== documents.length) {
        items.push({
          fileName: `${group.shopNo} ${group.period}`,
          groupId: group.id,
          taskId: null,
          status: "REJECTED",
          error: { code: "GROUP_NOT_READY", message: "该组仍有单据未确认" },
          logs: [],
        });
        continue;
      }

      const logs: ProgressLog[] = [];
      try {
        const task = await createReconciliationGroupTask({
          batchId: state.id,
          groupId: group.id,
          shopNo: group.shopNo,
          period: group.period,
          erpFile: state.erpFile,
          documents: executableDocuments.map((document) => ({
            id: document.id,
            file: document.file,
            settlementAmount: document.confirmedSettlementAmount ?? 0,
            settlementAmountLabel: document.confirmedSettlementLabel ?? "确认金额",
          })),
          onProgress: (log) => logs.push(log),
          onSettled: async (result) => {
            const latest = readBatchState(state.id);
            if (!latest) return;
            const nextStatus = documentStatusFromTaskStatus(result.status);
            for (const documentId of group.documentIds) {
              const document = latest.documents.find((item) => item.id === documentId);
              if (!document) continue;
              document.status = nextStatus;
              document.taskId = result.taskId;
              document.updatedAt = new Date().toISOString();
              if (result.message && nextStatus === "FAILED") document.issues = [...document.issues, result.message];
            }
            await syncBatchState(latest, group.documentIds);
          },
        });
        for (const document of executableDocuments) {
          document.status = "PROCESSING";
          document.taskId = task.id;
          document.updatedAt = new Date().toISOString();
        }
        await syncBatchState(state, executableDocuments.map((document) => document.id));
        items.push({
          fileName: `${group.shopNo} ${group.period}`,
          groupId: group.id,
          taskId: task.id,
          status: task.status,
          error: null,
          logs,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "创建批量组任务失败";
        items.push({
          fileName: `${group.shopNo} ${group.period}`,
          groupId: group.id,
          taskId: null,
          status: "FAILED",
          error: { code: "CREATE_GROUP_TASK_FAILED", message },
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
    if (shopCodes.length > 1 && documents.length > 1) {
      return Promise.all(documents.map((document, index) => precheckDocumentCandidate({
        context,
        file: stored,
        fileName: `${document.name || `待识别单据${index + 1}`}（${fileName}）`,
        sourceFileName: fileName,
        sha256,
        shopCodes: document.shopCodes,
        period: document.period || period,
        candidates: document.candidates,
        documentNo: document.documentNo,
        documentRange: `${document.sheetName} ${document.rowStart}-${document.rowEnd} 行`,
        issues: [`已从 ${fileName} 自动拆出第 ${index + 1} 张结算单`],
      })));
    }

    const document = documents[0];
    period = document?.period || period;
    if (shopCodes.length > 1) {
      const erpPreview = period ? await describeMultiShopErpPreview(shopCodes, period, context) : "";
      return Promise.all(shopCodes.map((shopCode, index) => completePrecheckDocument({
        batchId: context.batchId,
        file: stored,
        fileName: `${shopCode}（${fileName}）`,
        sourceFileName: fileName,
        sha256,
        shopCodes: [shopCode],
        period,
        documentNo: document?.documentNo ?? null,
        documentRange: document ? `${document.sheetName} ${document.rowStart}-${document.rowEnd} 行` : null,
        candidates: [],
        status: "NEEDS_REVIEW",
        issues: [
          `已按文件名从 ${fileName} 拆出第 ${index + 1} 个店铺号 ${shopCode}`,
          "未找到可靠的店铺级金额边界，请在单据视图为该店铺号手工确认金额",
          erpPreview,
        ].filter(Boolean),
        context,
      })));
    }
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
    issues.push("非 Excel 批量单据需要人工确认金额；批量执行不会让 Agent 代选 PDF/图片金额");
    status = "NEEDS_REVIEW";
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

async function precheckDocumentCandidate(params: {
  context: BatchPrecheckContext;
  file: ReturnType<typeof saveBatchUploadedFile>;
  fileName: string;
  sourceFileName: string;
  sha256: string;
  shopCodes: string[];
  period: string | null;
  candidates: ExcelSettlementCandidate[];
  documentNo: string | null;
  documentRange: string | null;
  issues: string[];
}) {
  let status: BatchDocumentStatus = "READY";
  const issues = [...params.issues];
  if (params.shopCodes.length === 0) {
    issues.push("拆分单据正文未识别到唯一店铺号");
    status = "NEEDS_REVIEW";
  } else if (params.shopCodes.length > 1) {
    issues.push(`拆分单据仍包含多个店铺号（${params.shopCodes.join("、")}）`);
    status = "NEEDS_REVIEW";
  }
  if (!params.period) {
    issues.push("拆分单据未识别到 ERP 月份");
    status = "NEEDS_REVIEW";
  }

  return completePrecheckDocument({
    batchId: params.context.batchId,
    file: params.file,
    fileName: params.fileName,
    sourceFileName: params.sourceFileName,
    sha256: params.sha256,
    shopCodes: params.shopCodes,
    period: params.period,
    documentNo: params.documentNo,
    documentRange: params.documentRange,
    candidates: params.candidates,
    status,
    issues,
    context: params.context,
  });
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
      issues.push("未识别到 ERP 月份");
      status = "NEEDS_REVIEW";
    }
    if (isExcelFileName(params.fileName) && !chosen) {
      issues.push(amountCandidates.length ? "结算金额候选不唯一，必须人工选择" : "Excel 中未识别到净营业额候选");
      status = "NEEDS_REVIEW";
    }
  }

  const erpData = await tryResolveErpData(params.shopCodes, params.period, params.context, issues);
  if (!erpData && status === "READY") status = "NEEDS_REVIEW";

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
    status: chosen && erpData && status === "READY" ? "READY" : status,
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
  if (!document.period) document.issues.push("未识别到 ERP 月份");
  if (document.confirmedSettlementAmount === null) document.issues.push("未确认结算金额");

  if (document.shopNo && document.period) {
    const erpRows = state.erpFile ? await parseErpWorkbook(state.erpFile.absolutePath, state.erpFile.originalName).catch(() => null) : null;
    const erpData = await tryResolveErpData([document.shopNo], document.period, {
      uploadedErpRows: erpRows,
      uploadedErpError: "",
    }, document.issues);
    document.erpRows = erpData?.rows.length ?? document.erpRows;
    document.erpSalesTotal = erpData?.salesTotal ?? document.erpSalesTotal;
  }

  document.status = document.shopNo && document.period && document.confirmedSettlementAmount !== null && document.erpSalesTotal !== null
    ? "READY"
    : "NEEDS_REVIEW";
  document.updatedAt = new Date().toISOString();
}

async function describeMultiShopErpPreview(
  shopCodes: string[],
  period: string,
  context: Pick<BatchPrecheckContext, "uploadedErpRows" | "uploadedErpError">,
) {
  const previews = await Promise.all(shopCodes.map(async (shopCode) => {
    const issues: string[] = [];
    const erpData = await tryResolveErpData([shopCode], period, context, issues);
    return erpData
      ? `${shopCode} 命中 ${erpData.rows.length} 行，ERP销售额 ${erpData.salesTotal.toFixed(2)} 元`
      : `${shopCode} 未就绪：${issues.join("；") || "ERP 明细匹配失败"}`;
  }));
  return `拆分候选 ERP 检查：${previews.join("；")}`;
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
  const rejectedReason = settlementFileHardRejectionReason(file.originalname);
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

function isDocument(document: BatchDocumentState | undefined): document is BatchDocumentState {
  return Boolean(document);
}

function documentStatusFromTaskStatus(status: string): BatchDocumentStatus {
  if (status === "SUCCEEDED") return "SUCCEEDED";
  if (status === "FAILED") return "FAILED";
  if (status === "CANCELLED") return "CANCELLED";
  return "NEEDS_REVIEW";
}
