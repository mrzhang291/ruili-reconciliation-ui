import { config } from "./config.js";
import { erpFields, erpUniqueKey, type ParsedErpImportRow } from "./erp-import.js";
import { runLarkCli } from "./lark-cli.js";
import { findCreatedRecordId, isLarkRecordId, rowsFromPage } from "./lark-store.js";
import { cacheKey, invalidateReadCache, readThroughCache } from "./read-cache.js";

type PageEnvelope = {
  ok?: boolean;
  data?: {
    data?: unknown[][];
    fields?: string[];
    record_id_list?: string[];
    record_not_found?: string[];
    has_more?: boolean;
  };
};

export type ErpRecord = ParsedErpImportRow & { id: string };
export type ErpSortField = "month" | "shopNo" | "deductionRate" | "salesAmount";
export type ErpSortDirection = "asc" | "desc";

export type ErpListParams = {
  page: number;
  pageSize: number;
  month?: string;
  shopNo?: string;
  keyword?: string;
  sortField: ErpSortField;
  sortDirection: ErpSortDirection;
};

export class ErpRecordError extends Error {
  constructor(message: string, readonly code = "ERP_RECORD_ERROR") {
    super(message);
    this.name = "ErpRecordError";
  }
}

const sortFields: Record<ErpSortField, string> = {
  month: "月份",
  shopNo: "店铺号",
  deductionRate: "扣点",
  salesAmount: "销售额",
};
const erpListCacheTtlMs = 90_000;
const erpOptionsCacheTtlMs = 5 * 60_000;

function invalidateErpReadCaches() {
  invalidateReadCache("erp:");
}

export async function listErpRecords(params: ErpListParams) {
  return readThroughCache(cacheKey("erp:list", params), erpListCacheTtlMs, async () => {
    const rows = await readErpRows(params);
    const total = rows.length;
    const start = (params.page - 1) * params.pageSize;
    return { items: rows.slice(start, start + params.pageSize), total, page: params.page, pageSize: params.pageSize };
  });
}

export async function getErpFilterOptions() {
  return readThroughCache(cacheKey("erp:options"), erpOptionsCacheTtlMs, async () => {
    const rows = await readErpRows({
      page: 1,
      pageSize: 200,
      sortField: "month",
      sortDirection: "desc",
    });
    return {
      months: unique(rows.map((row) => row.month)).sort((a, b) => b.localeCompare(a)),
    };
  });
}

export async function createErpRecord(input: unknown) {
  const row = normalizeInput(input);
  await assertNoConflict(row);
  const payload = await recordUpsert(row);
  invalidateErpReadCaches();
  const id = findCreatedRecordId(payload);
  if (!id) throw new ErpRecordError("飞书创建 ERP 明细后没有返回记录 ID", "ERP_RECORD_CREATE_FAILED");
  return await getErpRecord(id);
}

export async function updateErpRecord(recordId: string, input: unknown) {
  const existing = await getErpRecord(recordId);
  if (!existing) throw new ErpRecordError("ERP 明细不存在", "ERP_RECORD_NOT_FOUND");
  const row = normalizeInput(input);
  await assertNoConflict(row, recordId);
  await recordUpsert(row, recordId);
  invalidateErpReadCaches();
  return await getErpRecord(recordId);
}

export async function batchUpdateErpRecords(items: Array<{ id?: unknown; values?: unknown }>) {
  const results = [];
  for (const item of items) {
    const id = typeof item.id === "string" ? item.id : "";
    try {
      if (!id) throw new ErpRecordError("缺少记录 ID", "ERP_RECORD_ID_REQUIRED");
      const record = await updateErpRecord(id, item.values);
      results.push({ id, success: true, record, error: null });
    } catch (error) {
      results.push({ id, success: false, record: null, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { items: results };
}

export async function deleteErpRecord(recordId: string) {
  const record = await getErpRecord(recordId);
  if (!record) throw new ErpRecordError("ERP 明细不存在", "ERP_RECORD_NOT_FOUND");
  await runLarkCli([
    "base", "+record-delete",
    "--base-token", config.lark.baseToken,
    "--table-id", config.lark.erpTableId,
    "--record-id", recordId,
    "--yes",
    "--as", "user",
  ]);
  invalidateErpReadCaches();
  return record;
}

export async function getErpRecord(recordId: string) {
  if (!isLarkRecordId(recordId)) return null;
  const args = [
    "base", "+record-get",
    "--base-token", config.lark.baseToken,
    "--table-id", config.lark.erpTableId,
    "--record-id", recordId,
    "--format", "json",
    "--as", "user",
    ...erpFields.flatMap((field) => ["--field-id", field]),
  ];
  const row = rowsFromPage(await runLarkCli<PageEnvelope>(args))[0];
  return row ? rowFromRecord(row) : null;
}

async function readErpRows(params: Partial<ErpListParams>) {
  const records: ErpRecord[] = [];
  const keyword = params.keyword?.trim();
  const command = keyword ? "+record-search" : "+record-list";
  const filter = filterJson(params);
  const sort = sortJson(params.sortField ?? "month", params.sortDirection ?? "desc");

  for (let offset = 0; ; offset += 200) {
    const args = [
      "base", command,
      "--base-token", config.lark.baseToken,
      "--table-id", config.lark.erpTableId,
      "--offset", String(offset),
      "--limit", "200",
      "--sort-json", JSON.stringify(sort),
      "--format", "json",
      "--as", "user",
      ...erpFields.flatMap((field) => ["--field-id", field]),
    ];
    if (filter) args.push("--filter-json", JSON.stringify(filter));
    if (keyword) args.push("--keyword", keyword, "--search-field", "店铺号");
    const page = await runLarkCli<PageEnvelope>(args);
    records.push(...rowsFromPage(page).flatMap((row) => {
      const parsed = rowFromRecord(row);
      return parsed ? [parsed] : [];
    }));
    if (!page.data?.has_more) break;
  }
  return records;
}

function filterJson(params: Partial<ErpListParams>) {
  const conditions: unknown[] = [];
  if (params.month) conditions.push(["月份", "==", normalizeMonth(params.month)]);
  if (params.shopNo) conditions.push(["店铺号", "intersects", params.shopNo.trim().toUpperCase()]);
  return conditions.length ? { logic: "and", conditions } : null;
}

function sortJson(field: ErpSortField, direction: ErpSortDirection) {
  const primary = { field: sortFields[field] ?? "月份", desc: direction === "desc" };
  const fallback = field === "shopNo" ? { field: "月份", desc: true } : { field: "店铺号", desc: false };
  return [primary, fallback];
}

function rowFromRecord(row: ReturnType<typeof rowsFromPage>[number]): ErpRecord | null {
  const values = row.values;
  const normalized = normalizeInput({
    shopNo: text(values.店铺号),
    deductionRate: number(values.扣点),
    salesAmount: number(values.销售额),
    month: text(values.月份),
  }, false);
  return normalized ? { id: row.id, ...normalized } : null;
}

function normalizeInput(input: unknown, throwOnError = true): ParsedErpImportRow {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const shopNo = text(record.shopNo ?? record.店铺号).toUpperCase();
  const month = normalizeMonth(text(record.month ?? record.月份));
  const deductionRate = number(record.deductionRate ?? record.扣点);
  const salesAmount = number(record.salesAmount ?? record.销售额);
  const errors = [
    shopNo ? "" : "店铺号为必填",
    month ? "" : "月份必须为 YYYYMM",
    deductionRate === null || deductionRate < 0 || deductionRate > 1 ? "扣点必须是 0 到 1 的数字" : "",
    salesAmount === null ? "销售额必须是数字" : "",
  ].filter(Boolean);
  if (errors.length) {
    if (!throwOnError) return null as never;
    throw new ErpRecordError(errors.join("；"), "ERP_RECORD_INVALID");
  }
  return {
    shopNo,
    deductionRate: deductionRate ?? 0,
    salesAmount: salesAmount ?? 0,
    month: month ?? "",
  };
}

async function assertNoConflict(row: ParsedErpImportRow, excludeRecordId?: string) {
  const rows = await readErpRows({ month: row.month });
  const duplicate = rows.find((candidate) => candidate.id !== excludeRecordId && erpUniqueKey(candidate) === erpUniqueKey(row));
  if (duplicate) throw new ErpRecordError("该 ERP 明细已存在", "ERP_RECORD_DUPLICATE");
}

async function recordUpsert(row: ParsedErpImportRow, recordId?: string) {
  const args = [
    "base", "+record-upsert",
    "--base-token", config.lark.baseToken,
    "--table-id", config.lark.erpTableId,
    "--json", JSON.stringify({
      店铺号: row.shopNo,
      扣点: row.deductionRate,
      销售额: row.salesAmount,
      月份: row.month,
    }),
    "--as", "user",
  ];
  if (recordId) args.splice(6, 0, "--record-id", recordId);
  return runLarkCli<Record<string, unknown>>(args);
}

function normalizeMonth(value: string) {
  const normalized = value.trim();
  const compact = normalized.match(/^(20\d{2})(0[1-9]|1[0-2])$/);
  if (compact) return `${compact[1]}${compact[2]}`;
  const separated = normalized.match(/^(20\d{2})-(0[1-9]|1[0-2])$/);
  if (separated) return `${separated[1]}${separated[2]}`;
  return null;
}

function text(value: unknown) {
  if (typeof value === "string") return value.normalize("NFKC").trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value).replace(/\.0$/, "");
  return "";
}

function number(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.replace(/[￥¥,\s元%]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
