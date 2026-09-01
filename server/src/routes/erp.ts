import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { config } from "../lib/config.js";
import { ErpBaseQueryError, queryErpReconciliationData } from "../lib/erp-base-query.js";
import { ErpImportError, importErpWorkbook, type ErpImportMode } from "../lib/erp-import.js";
import { invalidateReadCache } from "../lib/read-cache.js";
import {
  batchUpdateErpRecords,
  createErpRecord,
  deleteErpRecord,
  ErpRecordError,
  getErpFilterOptions,
  listErpRecords,
  updateErpRecord,
  type ErpSortDirection,
  type ErpSortField,
} from "../lib/erp-records.js";
import { normalizeFileName } from "../lib/file-storage.js";

export const erpRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes } });
const excelExtensions = new Set([".xlsx", ".xls"]);
const excelMimeTypes = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);
const sortFields = new Set(["month", "shopNo", "deductionRate", "salesAmount"]);

erpRouter.get("/", async (req, res, next) => {
  try {
    const sortField = sortFields.has(String(req.query.sortField)) ? String(req.query.sortField) as ErpSortField : "month";
    const sortDirection = req.query.sortDirection === "asc" ? "asc" : "desc";
    const data = await listErpRecords({
      page: Math.max(1, Number(req.query.page) || 1),
      pageSize: Math.min(200, Math.max(1, Number(req.query.pageSize) || 50)),
      month: textQuery(req.query.month),
      shopNo: textQuery(req.query.shopNo),
      keyword: textQuery(req.query.keyword),
      sortField,
      sortDirection: sortDirection as ErpSortDirection,
    });
    return res.json({ data, requestId: crypto.randomUUID() });
  } catch (error) {
    next(error);
  }
});

erpRouter.get("/options", async (_req, res, next) => {
  try {
    return res.json({ data: await getErpFilterOptions(), requestId: crypto.randomUUID() });
  } catch (error) {
    next(error);
  }
});

erpRouter.get("/reconciliation", async (req, res, next) => {
  try {
    const lookupKey = firstText(req.query.mall_name, req.query.mallName, req.query.storeCode, req.query.shopNo, req.query.name);
    const period = firstText(req.query.period, req.query.month, periodFromDate(req.query.periodStart));
    if (!lookupKey || !period) {
      return res.status(400).json({
        error: {
          code: "ERP_RECONCILIATION_QUERY_REQUIRED",
          message: "需要提供 mall_name/shopNo/storeCode 与 period",
          requestId: crypto.randomUUID(),
        },
      });
    }

    const data = await queryErpReconciliationData(lookupKey, period);
    return res.json({ data: reconciliationPayload(data), requestId: crypto.randomUUID() });
  } catch (error) {
    if (error instanceof ErpBaseQueryError) {
      return res.status(error.code === "ERP_ROWS_NOT_FOUND" ? 404 : 400).json({
        error: { code: error.code, message: error.message, requestId: crypto.randomUUID() },
      });
    }
    next(error);
  }
});

erpRouter.post("/", async (req, res, next) => {
  try {
    return res.status(201).json({ data: await createErpRecord(req.body), requestId: crypto.randomUUID() });
  } catch (error) {
    if (error instanceof ErpRecordError) {
      return res.status(error.code === "ERP_RECORD_DUPLICATE" ? 409 : 400).json({ error: { code: error.code, message: error.message, requestId: crypto.randomUUID() } });
    }
    next(error);
  }
});

erpRouter.patch("/:id", async (req, res, next) => {
  try {
    return res.json({ data: await updateErpRecord(req.params.id, req.body), requestId: crypto.randomUUID() });
  } catch (error) {
    if (error instanceof ErpRecordError) {
      const status = error.code === "ERP_RECORD_NOT_FOUND" ? 404 : error.code === "ERP_RECORD_DUPLICATE" ? 409 : 400;
      return res.status(status).json({ error: { code: error.code, message: error.message, requestId: crypto.randomUUID() } });
    }
    next(error);
  }
});

erpRouter.post("/batch-update", async (req, res, next) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    return res.json({ data: await batchUpdateErpRecords(items), requestId: crypto.randomUUID() });
  } catch (error) {
    next(error);
  }
});

erpRouter.delete("/:id", async (req, res, next) => {
  try {
    return res.json({ data: { deleted: true, record: await deleteErpRecord(req.params.id) }, requestId: crypto.randomUUID() });
  } catch (error) {
    if (error instanceof ErpRecordError) {
      return res.status(error.code === "ERP_RECORD_NOT_FOUND" ? 404 : 400).json({ error: { code: error.code, message: error.message, requestId: crypto.randomUUID() } });
    }
    next(error);
  }
});

erpRouter.post("/import", upload.single("erpFile"), async (req, res, next) => {
  let tempDir: string | null = null;
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: { code: "ERP_FILE_REQUIRED", message: "需要上传 ERP 总表", requestId: crypto.randomUUID() } });
    }

    const fileName = normalizeFileName(file.originalname);
    const extension = path.extname(fileName).toLowerCase();
    if (!excelExtensions.has(extension)
      || Boolean(file.mimetype && file.mimetype !== "application/octet-stream" && !excelMimeTypes.has(file.mimetype))) {
      return res.status(400).json({ error: { code: "ERP_IMPORT_INVALID_FILE_TYPE", message: "ERP 总表只支持 .xlsx / .xls", requestId: crypto.randomUUID() } });
    }

    const mode = parseMode(req.body?.mode);
    if (!mode) {
      return res.status(400).json({ error: { code: "ERP_IMPORT_INVALID_MODE", message: "mode 只支持 preview、append 或 replace", requestId: crypto.randomUUID() } });
    }

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ruili-erp-"));
    const tempFile = path.join(tempDir, `erp${extension}`);
    await fs.writeFile(tempFile, file.buffer);
    const data = await importErpWorkbook({
      filePath: tempFile,
      fileName,
      mode,
      month: typeof req.body?.month === "string" ? req.body.month.trim() || undefined : undefined,
    });
    if (data.written) invalidateReadCache("erp:");

    return res.json({ data, requestId: crypto.randomUUID() });
  } catch (error) {
    if (error instanceof ErpImportError) {
      return res.status(400).json({ error: { code: error.code, message: error.message, requestId: crypto.randomUUID() } });
    }
    next(error);
  } finally {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function parseMode(value: unknown): ErpImportMode | null {
  if (value === undefined || value === "" || value === "preview") return "preview";
  if (value === "append" || value === "replace") return value;
  return null;
}

function textQuery(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstText(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function periodFromDate(value: unknown) {
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^(20\d{2})-(0[1-9]|1[0-2])(?:-\d{2})?$/);
  return match ? `${match[1]}-${match[2]}` : undefined;
}

function reconciliationPayload(data: Awaited<ReturnType<typeof queryErpReconciliationData>>) {
  const rows = data.rows.map((row) => ({
    id: row.id,
    shopNo: row.shopNo,
    shop_no: row.shopNo,
    deductionRate: row.deductionRate,
    deduction_rate: row.deductionRate,
    salesAmount: row.salesAmount,
    sales_amount: row.salesAmount,
    month: row.month,
  }));
  return {
    lookupKey: data.lookupKey,
    lookup_key: data.lookupKey,
    mallName: data.lookupKey,
    mall_name: data.lookupKey,
    storeCode: data.lookupKey,
    store_code: data.lookupKey,
    period: data.period,
    month: data.month,
    rows,
    rowsCount: rows.length,
    rows_count: rows.length,
    salesTotal: data.salesTotal,
    sales_total: data.salesTotal,
    netSalesTotal: data.netSalesTotal,
    net_sales_total: data.netSalesTotal,
  };
}
