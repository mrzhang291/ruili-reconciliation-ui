import { config } from "./config.js";
import { LarkCliError, runLarkCli } from "./lark-cli.js";
import { cacheKey, readThroughCache } from "./read-cache.js";
import { rowsFromPage } from "./lark-store.js";
import type { ReconciliationResult, SettlementExtractionResult } from "./cherrystudio.js";

const fields = ["店铺号", "扣点", "销售额", "月份"] as const;
const erpQueryCacheTtlMs = 60_000;

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

export type ErpBaseRow = {
  id: string;
  shopNo: string;
  deductionRate: number;
  salesAmount: number;
  month: string;
};

export type ErpReconciliationData = {
  lookupKey: string;
  period: string;
  month: string;
  rows: ErpBaseRow[];
  salesTotal: number;
  netSalesTotal: number;
};

export type ErpBasis = "sales_total" | "net_sales_total";

export class ErpBaseQueryError extends Error {
  constructor(message: string, readonly code = "ERP_BASE_QUERY_ERROR") {
    super(message);
    this.name = "ErpBaseQueryError";
  }
}

const roundMoney = (cents: number) => cents / 100;
const toCents = (value: number) => Math.round(value * 100);

export function normalizeShopNo(value: string) {
  return value.normalize("NFKC").trim().toUpperCase();
}

export function periodToMonthKey(value: string) {
  const normalized = value.trim();
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(normalized)) return normalized.replace("-", "");
  if (/^\d{4}(0[1-9]|1[0-2])$/.test(normalized)) return normalized;
  throw new ErpBaseQueryError("账期格式必须为 YYYY-MM 或 YYYYMM", "ERP_PERIOD_INVALID");
}

function textValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join("、");
  return "";
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[%￥¥,\s元]/g, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function rateValue(value: unknown) {
  const raw = numberValue(value);
  if (raw === null) return null;
  const rate = raw > 1 ? raw / 100 : raw;
  return rate >= 0 && rate <= 1 ? rate : null;
}

function rowFromRecord(row: ReturnType<typeof rowsFromPage>[number]) {
  const value = row.values;
  const salesAmount = numberValue(value.销售额);
  const deductionRate = rateValue(value.扣点);
  const shopNo = normalizeShopNo(textValue(value.店铺号));
  const month = textValue(value.月份);
  if (!shopNo || !month || salesAmount === null || deductionRate === null) return null;
  return {
    id: row.id,
    shopNo,
    deductionRate,
    salesAmount,
    month,
  };
}

export function matchesLookupKey(row: Pick<ErpBaseRow, "shopNo">, lookupKey: string) {
  return normalizeShopNo(row.shopNo) === normalizeShopNo(lookupKey);
}

export function extractShopCodesFromFileName(fileName: string) {
  const normalized = fileName.normalize("NFKC").toUpperCase();
  const codePattern = /(^|[^A-Z0-9])([A-Z]{2,5}[A-Z0-9]*\d[A-Z0-9]*)(?=$|[^A-Z0-9])/g;
  const codes: string[] = [];
  for (const match of normalized.matchAll(codePattern)) {
    const code = match[2];
    if (/^20\d{4}$/.test(code) || /^SHEET\d+$/i.test(code) || codes.includes(code)) continue;
    codes.push(code);
  }
  return codes;
}

export function buildErpLookupKeys(fileName: string) {
  const keys = extractShopCodesFromFileName(fileName).filter(Boolean);
  const seen = new Set<string>();
  return keys.filter((key) => {
    const normalized = normalizeShopNo(key);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

export function calculateErpTotals(rows: Array<Pick<ErpBaseRow, "salesAmount" | "deductionRate">>) {
  let salesCents = 0;
  let netSalesCents = 0;
  for (const row of rows) {
    const rowSalesCents = toCents(row.salesAmount);
    salesCents += rowSalesCents;
    netSalesCents += Math.round(rowSalesCents * (1 - row.deductionRate));
  }
  return {
    salesTotal: roundMoney(salesCents),
    netSalesTotal: roundMoney(netSalesCents),
  };
}

export function chooseErpBasis(settlementAmount: number, erp: Pick<ErpReconciliationData, "salesTotal" | "netSalesTotal">) {
  const settlementCents = toCents(settlementAmount);
  const erpCents = toCents(erp.salesTotal);
  const diffCents = erpCents - settlementCents;
  return {
    basis: "sales_total" as const,
    label: "ERP销售额",
    erpAmount: roundMoney(erpCents),
    difference: roundMoney(diffCents),
    matched: diffCents === 0,
  };
}

export function buildReconciliationResult(extraction: SettlementExtractionResult, erp: ErpReconciliationData): ReconciliationResult {
  const selected = chooseErpBasis(extraction.settlementAmount, erp);
  const issues = extraction.issues.map((issue) => ({
    ...issue,
    differenceAmount: issue.differenceAmount ?? selected.difference,
  }));
  if (Math.abs(selected.difference) > 0.005 && issues.length === 0) {
    issues.push({
      rowLabel: "总差额",
      fieldName: selected.label,
      settlementAmount: extraction.settlementAmount,
      erpAmount: selected.erpAmount,
      differenceAmount: selected.difference,
      message: `后端按${selected.label}口径计算 ERP 金额 ${selected.erpAmount.toFixed(2)} 元，结算单金额 ${extraction.settlementAmount.toFixed(2)} 元，差额 ${selected.difference.toFixed(2)} 元。`,
      suggestion: "复核结算单金额口径，必要时检查飞书 ERP 明细表的店铺号、月份、扣点和销售额。",
    });
  }

  return {
    name: extraction.name,
    period: extraction.period,
    matched: selected.matched,
    erpAmount: selected.erpAmount,
    settlementAmount: extraction.settlementAmount,
    difference: selected.difference,
    issues,
    rawAgentPayload: {
      agentExtraction: extraction.rawAgentPayload,
      matched: selected.matched,
      erpAmount: selected.erpAmount,
      settlementAmount: extraction.settlementAmount,
      difference: selected.difference,
      recalculatedDifference: selected.difference,
      issues: issues.map((issue) => issue.message).filter(Boolean).join("\n"),
      period: extraction.period,
      name: extraction.name,
      erpBasis: selected.basis,
      erpBasisLabel: selected.label,
      erpQuery: {
        tableId: config.lark.erpTableId,
        lookupKey: erp.lookupKey,
        period: extraction.period,
        month: erp.month,
      },
      erpRows: erp.rows.length,
      salesTotal: erp.salesTotal,
      netSalesTotal: erp.netSalesTotal,
    },
  };
}

export async function queryErpReconciliationData(lookupKey: string, period: string): Promise<ErpReconciliationData> {
  return readThroughCache(cacheKey("erp:query", {
    lookupKey: normalizeShopNo(lookupKey),
    period,
  }), erpQueryCacheTtlMs, () => queryErpReconciliationDataFresh(lookupKey, period));
}

async function queryErpReconciliationDataFresh(lookupKey: string, period: string): Promise<ErpReconciliationData> {
  const month = periodToMonthKey(period);
  const rows: ErpBaseRow[] = [];
  const limit = 200;

  for (let offset = 0; ; offset += limit) {
    const args = [
      "base", "+record-list",
      "--base-token", config.lark.baseToken,
      "--table-id", config.lark.erpTableId,
      "--filter-json", JSON.stringify({ logic: "and", conditions: [["月份", "==", month]] }),
      "--offset", String(offset),
      "--limit", String(limit),
      "--format", "json",
      "--as", "user",
    ];
    for (const field of fields) args.push("--field-id", field);

    let payload: PageEnvelope;
    try {
      payload = await runLarkCli<PageEnvelope>(args);
    } catch (error) {
      const message = error instanceof LarkCliError ? error.message : String(error);
      throw new ErpBaseQueryError(`读取飞书 ERP 明细表失败：${message}`, "ERP_BASE_READ_FAILED");
    }

    for (const record of rowsFromPage(payload)) {
      const row = rowFromRecord(record);
      if (row && matchesLookupKey(row, lookupKey)) rows.push(row);
    }
    if (!payload.data?.has_more) break;
  }

  if (!rows.length) {
    throw new ErpBaseQueryError(`飞书 ERP 明细表未找到店铺号「${lookupKey}」在 ${period} 的记录`, "ERP_ROWS_NOT_FOUND");
  }

  const totals = calculateErpTotals(rows);
  return {
    lookupKey,
    period,
    month,
    rows,
    ...totals,
  };
}
