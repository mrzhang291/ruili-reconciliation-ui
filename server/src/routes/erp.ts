import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { config } from "../lib/config.js";
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
