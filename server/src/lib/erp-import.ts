import path from "node:path";
import { config } from "./config.js";
import {
  calculateErpTotals,
  ErpBaseQueryError,
  matchesLookupKey,
  periodToMonthKey,
  type ErpBaseRow,
  type ErpReconciliationData,
} from "./erp-base-query.js";
import { readExcelRows } from "./excel-settlement.js";
import { runLarkCli } from "./lark-cli.js";
import { rowsFromPage } from "./lark-store.js";

export const erpFields = ["店铺号", "扣点", "销售额", "月份"] as const;
const excelExtensions = new Set([".xlsx", ".xls"]);

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

export type ErpImportMode = "preview" | "append" | "replace";

export type ParsedErpImportRow = {
  shopNo: string;
  deductionRate: number;
  salesAmount: number;
  month: string;
  sourceRow?: number;
};

export type ErpImportMonthSummary = {
  month: string;
  rows: number;
  salesTotal: number;
  netSalesTotal: number;
  existingRows: number;
  deletedRows: number;
  createdRows: number;
  updatedRows: number;
  sampleRows: ParsedErpImportRow[];
};

export type ErpImportResult = {
  mode: ErpImportMode;
  fileName: string;
  months: ErpImportMonthSummary[];
  totalRows: number;
  written: boolean;
  failedRows: Array<{ row: number; reason: string }>;
};

export class ErpImportError extends Error {
  constructor(message: string, readonly code = "ERP_IMPORT_ERROR") {
    super(message);
    this.name = "ErpImportError";
  }
}

const roundMoney = (value: number) => Math.round(value * 100) / 100;

export async function importErpWorkbook(params: {
  filePath: string;
  fileName: string;
  mode: ErpImportMode;
  month?: string;
}): Promise<ErpImportResult> {
  const rows = await parseErpWorkbook(params.filePath, params.fileName);
  const month = params.month ? periodToMonthKey(params.month) : null;
  const scopedRows = month ? rows.filter((row) => row.month === month) : rows;
  if (!scopedRows.length) {
    throw new ErpImportError(`ERP 总表中没有 ${params.month} 的明细`, "ERP_IMPORT_MONTH_EMPTY");
  }
  const summaries = await summarizeRows(scopedRows);
  const duplicateFailures = findDuplicateErpKeyFailures(scopedRows);
  if (params.mode === "preview") {
    return { mode: params.mode, fileName: params.fileName, months: summaries, totalRows: scopedRows.length, written: false, failedRows: duplicateFailures };
  }
  assertNoDuplicateErpKeys(scopedRows);

  await assertErpFields();
  if (params.mode === "append") {
    const existingRows = await listExistingErpRows([...new Set(scopedRows.map((row) => row.month))]);
    const existingByKey = mapExistingRows(existingRows);
    for (const summary of summaries) {
      const monthRows = scopedRows.filter((row) => row.month === summary.month);
      const toCreate: ParsedErpImportRow[] = [];
      for (const row of monthRows) {
        const existing = existingByKey.get(erpUniqueKey(row));
        if (existing) {
          await updateErpRow(existing.id, row);
          summary.updatedRows += 1;
        } else {
          toCreate.push(row);
        }
      }
      summary.createdRows = await createErpRows(toCreate);
    }
    return { mode: params.mode, fileName: params.fileName, months: summaries, totalRows: scopedRows.length, written: true, failedRows: [] };
  }

  for (const summary of summaries) {
    const recordIds = await listExistingErpRecordIds(summary.month);
    summary.existingRows = recordIds.length;
    if (recordIds.length) await deleteErpRecords(recordIds);
    summary.deletedRows = recordIds.length;
    summary.createdRows = await createErpRows(scopedRows.filter((row) => row.month === summary.month));
  }

  return { mode: params.mode, fileName: params.fileName, months: summaries, totalRows: scopedRows.length, written: true, failedRows: [] };
}

export async function parseErpWorkbook(filePath: string, fileName: string) {
  const extension = path.extname(fileName).toLowerCase();
  if (!excelExtensions.has(extension)) {
    throw new ErpImportError("ERP 总表只支持 .xlsx / .xls", "ERP_IMPORT_INVALID_FILE_TYPE");
  }
  const rows = await readExcelRows(filePath, { maxRows: 10_000, maxCols: 80 }).catch((error: unknown) => {
    throw new ErpImportError(error instanceof Error ? error.message : "ERP Excel 读取失败", "ERP_IMPORT_READ_FAILED");
  });
  return parseErpRows(rows);
}

export function parseErpRows(rows: string[][]) {
  const header = findHeader(rows);
  const parsed: ParsedErpImportRow[] = [];
  const errors: string[] = [];

  for (let index = header.rowIndex + 1; index < rows.length; index += 1) {
    const source = rows[index] ?? [];
    const values = Object.fromEntries(erpFields.map((field) => [field, cell(source[header.columns[field]])])) as Record<typeof erpFields[number], string>;
    if (erpFields.every((field) => !values[field])) continue;

    const month = normalizeMonth(values.月份);
    const deductionRate = parseRate(values.扣点);
    const salesAmount = parseAmount(values.销售额);
    const shopNo = values.店铺号.toUpperCase();
    const rowErrors = [
      shopNo ? "" : "店铺号为空",
      month ? "" : "月份格式不对",
      deductionRate === null ? "扣点不是有效数字" : "",
      salesAmount === null ? "销售额不是有效金额" : "",
    ].filter(Boolean);

    if (rowErrors.length) {
      errors.push(`第 ${index + 1} 行：${rowErrors.join("、")}`);
      continue;
    }

    parsed.push({
      shopNo,
      deductionRate: deductionRate ?? 0,
      salesAmount: salesAmount ?? 0,
      month: month ?? "",
      sourceRow: index + 1,
    });
  }

  if (errors.length) {
    throw new ErpImportError(`ERP 总表有 ${errors.length} 行无法导入：${errors.slice(0, 5).join("；")}`, "ERP_IMPORT_INVALID_ROWS");
  }
  if (!parsed.length) throw new ErpImportError("ERP 总表没有可导入明细", "ERP_IMPORT_EMPTY");
  return parsed;
}

export function summarizeParsedErpRows(rows: ParsedErpImportRow[]) {
  const groups = new Map<string, ParsedErpImportRow[]>();
  for (const row of rows) groups.set(row.month, [...(groups.get(row.month) ?? []), row]);
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, monthRows]) => {
    const totals = calculateErpTotals(monthRows);
    return {
      month,
      rows: monthRows.length,
      salesTotal: roundMoney(totals.salesTotal),
      netSalesTotal: roundMoney(totals.netSalesTotal),
      existingRows: 0,
      deletedRows: 0,
      createdRows: 0,
      updatedRows: 0,
      sampleRows: monthRows.slice(0, 10),
    };
  });
}

export function erpUniqueKey(row: Pick<ParsedErpImportRow, "shopNo" | "deductionRate" | "month">) {
  return [
    row.shopNo.trim().toUpperCase(),
    String(row.deductionRate),
    row.month.trim(),
  ].join("\u0000");
}

export function buildErpDataFromParsedRows(
  rows: ParsedErpImportRow[],
  lookupKey: string,
  period: string,
): ErpReconciliationData {
  const month = periodToMonthKey(period);
  const matchedRows: ErpBaseRow[] = rows.map((row, index) => ({
    id: `uploaded:${index}`,
    shopNo: row.shopNo,
    deductionRate: row.deductionRate,
    salesAmount: row.salesAmount,
    month: row.month,
  })).filter((row) => row.month === month && matchesLookupKey(row, lookupKey));

  if (!matchedRows.length) {
    throw new ErpBaseQueryError(`上传 ERP 文件未找到店铺号「${lookupKey}」在 ${period} 的记录`, "ERP_ROWS_NOT_FOUND");
  }

  const totals = calculateErpTotals(matchedRows);
  return {
    lookupKey,
    period,
    month,
    rows: matchedRows,
    ...totals,
  };
}

async function summarizeRows(rows: ParsedErpImportRow[]) {
  const summaries = summarizeParsedErpRows(rows);
  await Promise.all(summaries.map(async (summary) => {
    const recordIds = await listExistingErpRecordIds(summary.month);
    summary.existingRows = recordIds.length;
  }));
  return summaries;
}

export function assertNoDuplicateErpKeys(rows: ParsedErpImportRow[]) {
  const failures = findDuplicateErpKeyFailures(rows);
  if (failures.length) {
    throw new ErpImportError(`Excel 内部存在重复唯一键：${failures.slice(0, 8).map((failure) => `第 ${failure.row} 行：${failure.reason}`).join("；")}`, "ERP_IMPORT_DUPLICATE_KEYS");
  }
}

export function findDuplicateErpKeyFailures(rows: ParsedErpImportRow[]) {
  const seen = new Map<string, ParsedErpImportRow>();
  const failures: Array<{ row: number; reason: string }> = [];
  for (const row of rows) {
    const key = erpUniqueKey(row);
    const previous = seen.get(key);
    if (previous) {
      failures.push({
        row: row.sourceRow ?? 0,
        reason: `与第 ${previous.sourceRow ?? "?"} 行重复唯一键（店铺号 + 扣点 + 月份）`,
      });
    } else {
      seen.set(key, row);
    }
  }
  return failures;
}

function findHeader(rows: string[][]) {
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 20); rowIndex += 1) {
    const columns = {} as Record<typeof erpFields[number], number>;
    const normalized = (rows[rowIndex] ?? []).map(normalizeHeader);
    for (const field of erpFields) {
      const column = normalized.findIndex((value) => value === normalizeHeader(field));
      if (column >= 0) columns[field] = column;
    }
    if (erpFields.every((field) => columns[field] !== undefined)) return { rowIndex, columns };
  }
  throw new ErpImportError(`ERP 总表缺少必要表头：${erpFields.join(" / ")}`, "ERP_IMPORT_HEADER_NOT_FOUND");
}

function normalizeHeader(value: string) {
  return cell(value).replace(/[：:\s]/g, "");
}

function cell(value: unknown) {
  const text = String(value ?? "").normalize("NFKC").trim();
  if (/^(undefined|null|nan)$/i.test(text)) return "";
  return text.replace(/\.0$/, "");
}

function parseAmount(value: string) {
  const parsed = parseNumber(value);
  return parsed;
}

function parseRate(value: string) {
  const parsed = parseNumber(value);
  if (parsed === null || parsed < 0) return null;
  const rate = value.includes("%") ? parsed / 100 : parsed;
  return rate <= 1 ? rate : null;
}

function parseNumber(value: string) {
  const text = cell(value).replace(/[￥¥,\s元%]/g, "");
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeMonth(value: string) {
  const text = cell(value);
  const compact = text.match(/^(20\d{2})(0[1-9]|1[0-2])$/);
  if (compact) return `${compact[1]}${compact[2]}`;
  const separated = text.match(/^(20\d{2})\s*[年./-]\s*(0?[1-9]|1[0-2])\s*月?$/);
  if (separated) return `${separated[1]}${separated[2].padStart(2, "0")}`;
  return null;
}

async function assertErpFields() {
  const payload = await runLarkCli<{ data?: { fields?: Array<{ name?: string; type?: string }> } }>([
    "base", "+field-list", "--base-token", config.lark.baseToken, "--table-id", config.lark.erpTableId, "--as", "user",
  ]);
  const fields = new Map((payload.data?.fields ?? []).map((field) => [field.name, field.type]));
  const missing = erpFields.filter((field) => !fields.has(field));
  if (missing.length) {
    throw new ErpImportError(`飞书 ERP 明细表缺少字段：${missing.join("、")}`, "ERP_IMPORT_BASE_SCHEMA_INVALID");
  }
  for (const field of ["扣点", "销售额"]) {
    if (fields.get(field) !== "number") {
      throw new ErpImportError(`飞书字段「${field}」必须是数字类型`, "ERP_IMPORT_BASE_SCHEMA_INVALID");
    }
  }
}

async function listExistingErpRecordIds(month: string) {
  const recordIds: string[] = [];
  for (let offset = 0; ; offset += 200) {
    const payload = await runLarkCli<PageEnvelope>([
      "base", "+record-list",
      "--base-token", config.lark.baseToken,
      "--table-id", config.lark.erpTableId,
      "--filter-json", JSON.stringify({ logic: "and", conditions: [["月份", "==", month]] }),
      "--offset", String(offset),
      "--limit", "200",
      "--field-id", "月份",
      "--format", "json",
      "--as", "user",
    ]);
    recordIds.push(...rowsFromPage(payload).map((row) => row.id));
    if (!payload.data?.has_more) return recordIds;
  }
}

type ExistingErpRow = ParsedErpImportRow & { id: string };

async function listExistingErpRows(months: string[]) {
  const rows: ExistingErpRow[] = [];
  for (const month of months) {
    for (let offset = 0; ; offset += 200) {
      const payload = await runLarkCli<PageEnvelope>([
        "base", "+record-list",
        "--base-token", config.lark.baseToken,
        "--table-id", config.lark.erpTableId,
        "--filter-json", JSON.stringify({ logic: "and", conditions: [["月份", "==", month]] }),
        "--offset", String(offset),
        "--limit", "200",
        "--format", "json",
        "--as", "user",
        ...erpFields.flatMap((field) => ["--field-id", field]),
      ]);
      rows.push(...rowsFromPage(payload).flatMap((row) => {
        const parsed = existingRowFromRecord(row);
        return parsed ? [parsed] : [];
      }));
      if (!payload.data?.has_more) break;
    }
  }
  return rows;
}

function mapExistingRows(rows: ExistingErpRow[]) {
  const mapped = new Map<string, ExistingErpRow>();
  const duplicates: string[] = [];
  for (const row of rows) {
    const key = erpUniqueKey(row);
    const previous = mapped.get(key);
    if (previous) duplicates.push(`${row.month} / ${row.shopNo} / 扣点 ${row.deductionRate}`);
    else mapped.set(key, row);
  }
  if (duplicates.length) {
    throw new ErpImportError(`飞书 ERP 明细表已有重复唯一键，请先清理：${duplicates.slice(0, 8).join("；")}`, "ERP_IMPORT_BASE_DUPLICATE_KEYS");
  }
  return mapped;
}

function existingRowFromRecord(row: ReturnType<typeof rowsFromPage>[number]): ExistingErpRow | null {
  const values = row.values;
  const month = normalizeMonth(cell(values.月份));
  const deductionRate = parseRate(cell(values.扣点));
  const salesAmount = parseAmount(cell(values.销售额));
  const shopNo = cell(values.店铺号).toUpperCase();
  if (!row.id || !month || !shopNo || deductionRate === null || salesAmount === null) return null;
  return {
    id: row.id,
    shopNo,
    deductionRate,
    salesAmount,
    month,
  };
}

async function deleteErpRecords(recordIds: string[]) {
  for (let index = 0; index < recordIds.length; index += 200) {
    await runLarkCli([
      "base", "+record-delete",
      "--base-token", config.lark.baseToken,
      "--table-id", config.lark.erpTableId,
      "--json", JSON.stringify({ record_id_list: recordIds.slice(index, index + 200) }),
      "--yes",
      "--as", "user",
    ]);
  }
}

async function createErpRows(rows: ParsedErpImportRow[]) {
  let created = 0;
  for (let index = 0; index < rows.length; index += 200) {
    const chunk = rows.slice(index, index + 200);
    await runLarkCli([
      "base", "+record-batch-create",
      "--base-token", config.lark.baseToken,
      "--table-id", config.lark.erpTableId,
      "--json", JSON.stringify({
        fields: erpFields,
        rows: chunk.map((row) => [
          row.shopNo,
          row.deductionRate,
          row.salesAmount,
          row.month,
        ]),
      }),
      "--as", "user",
    ]);
    created += chunk.length;
  }
  return created;
}

async function updateErpRow(recordId: string, row: ParsedErpImportRow) {
  await runLarkCli([
    "base", "+record-upsert",
    "--base-token", config.lark.baseToken,
    "--table-id", config.lark.erpTableId,
    "--record-id", recordId,
    "--json", JSON.stringify(erpRowFields(row)),
    "--as", "user",
  ]);
}

function erpRowFields(row: ParsedErpImportRow) {
  return {
    店铺号: row.shopNo,
    扣点: row.deductionRate,
    销售额: row.salesAmount,
    月份: row.month,
  };
}
