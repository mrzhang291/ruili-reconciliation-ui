import { execFile } from "node:child_process";
import path from "node:path";
import type { SettlementExtractionResult } from "./cherrystudio.js";
import { extractShopCodesFromFileName } from "./erp-base-query.js";

const excelExtensions = new Set([".xlsx", ".xls"]);
const pythonScript = String.raw`
import json, math, os, sys

path = sys.argv[1]
ext = os.path.splitext(path)[1].lower()
max_rows = int(sys.argv[2]) if len(sys.argv) > 2 else 200
max_cols = int(sys.argv[3]) if len(sys.argv) > 3 else 80

def clean(value):
    if value is None:
        return ""
    if isinstance(value, float) and math.isnan(value):
        return ""
    return str(value)

sheets = []
rows = []

def add_sheet(name, sheet_rows):
    sheets.append({"name": name, "rows": sheet_rows})
    rows.extend(sheet_rows)

if ext == ".xlsx":
    import openpyxl.reader.excel as excel
    try:
        workbook = excel.load_workbook(path, read_only=True, data_only=True)
    except ValueError:
        excel.apply_stylesheet = lambda archive, workbook: None
        workbook = excel.load_workbook(path, read_only=True, data_only=True)
    for sheet in workbook.worksheets:
        sheet_rows = []
        for row in sheet.iter_rows(max_row=max_rows, max_col=max_cols, values_only=True):
            sheet_rows.append([clean(value) for value in row])
        add_sheet(sheet.title, sheet_rows)
else:
    import xlrd
    workbook = xlrd.open_workbook(path)
    for sheet in workbook.sheets():
        sheet_rows = []
        for row_index in range(min(sheet.nrows, max_rows)):
            row = []
            for col_index in range(min(sheet.ncols, max_cols)):
                row.append(clean(sheet.cell_value(row_index, col_index)))
            sheet_rows.append(row)
        add_sheet(sheet.name, sheet_rows)

print(json.dumps({"rows": rows, "sheets": sheets}, ensure_ascii=False))
`;

export type ExcelSettlementCandidate = {
  label: string;
  amount: number;
  priority: number;
  row: number;
  column: number;
};

export type ExcelSettlementDraft = {
  name: string;
  period: string;
  candidates: ExcelSettlementCandidate[];
};

export type ExcelSettlementDocumentDraft = ExcelSettlementDraft & {
  sourceFileName: string;
  sheetName: string;
  rowStart: number;
  rowEnd: number;
  documentNo: string | null;
  shopCodes: string[];
};

export type ExcelWorksheetRows = {
  name: string;
  rows: string[][];
};

type ExcelRowsPayload = {
  rows?: unknown;
  sheets?: unknown;
};

const toCents = (value: number) => Math.round(value * 100);

export function isExcelFileName(fileName: string) {
  return excelExtensions.has(path.extname(fileName).toLowerCase());
}

export async function readExcelSettlementDraft(filePath: string, fileName: string): Promise<ExcelSettlementDraft | null> {
  if (!isExcelFileName(fileName)) return null;
  const documents = await readExcelSettlementDocuments(filePath, fileName).catch(() => []);
  if (documents.length !== 1) return null;
  const document = documents[0];
  if (!document.period || !document.name || document.candidates.length === 0) return null;
  return { name: document.name, period: document.period, candidates: document.candidates };
}

export async function readExcelSettlementDocuments(filePath: string, fileName: string): Promise<ExcelSettlementDocumentDraft[]> {
  if (!isExcelFileName(fileName)) return [];
  const sheets = await readExcelWorksheetRows(filePath).catch(() => []);
  if (!sheets.length) return [];

  const fileShopCodes = extractShopCodesFromFileName(fileName);
  const documents: ExcelSettlementDocumentDraft[] = [];
  for (const sheet of sheets) {
    for (const block of splitRowsIntoDocumentBlocks(sheet.rows)) {
      const rowShopCodes = extractShopCodesFromRows(block.rows);
      const sheetShopCodes = extractShopCodesFromFileName(sheet.name);
      const shopCodes = uniqueShopCodes([...rowShopCodes, ...sheetShopCodes]);
      const fallbackShopCodes = shopCodes.length ? shopCodes : fileShopCodes.length === 1 ? fileShopCodes : [];
      const period = extractPeriodFromRows(fileName, block.rows) ?? "";
      const candidates = extractSettlementCandidates(block.rows);
      const documentNo = extractDocumentNo(block.rows);
      if (!period && !documentNo && !fallbackShopCodes.length && !candidates.length) continue;
      documents.push({
        name: fallbackShopCodes.length === 1 ? fallbackShopCodes[0] : "",
        period,
        candidates,
        sourceFileName: fileName,
        sheetName: sheet.name,
        rowStart: block.start + 1,
        rowEnd: block.end + 1,
        documentNo,
        shopCodes: fallbackShopCodes,
      });
    }
  }
  return documents;
}

export function chooseExcelSettlementCandidate(candidates: ExcelSettlementCandidate[]) {
  const byAmount = new Map<number, ExcelSettlementCandidate[]>();
  for (const candidate of candidates) {
    const cents = toCents(candidate.amount);
    byAmount.set(cents, [...(byAmount.get(cents) ?? []), candidate]);
  }
  if (byAmount.size !== 1) return null;
  return [...byAmount.values()][0]?.sort((a, b) => b.priority - a.priority)[0] ?? null;
}

export function buildExcelSettlementExtraction(
  draft: ExcelSettlementDraft,
  candidate: ExcelSettlementCandidate,
): SettlementExtractionResult {
  const rawAgentPayload = {
    settlementAmount: candidate.amount,
    settlementAmountLabel: candidate.label,
    issues: "",
    period: draft.period,
    name: draft.name,
  };
  return {
    ...rawAgentPayload,
    issues: [],
    rawAgentPayload,
  };
}

export function extractSettlementCandidates(rows: string[][]) {
  const candidates: ExcelSettlementCandidate[] = [];
  rows.forEach((row, rowIndex) => {
    row.forEach((cell, columnIndex) => {
      const priority = labelPriority(cell);
      if (!priority) return;

      const numbers = [
        ...numbersFromText(cell),
        ...numbersToRight(row, columnIndex),
      ];
      for (const amount of numbers) {
        if (amount > 0 && amount < 100_000_000) {
          candidates.push({ label: cleanLabel(cell), amount, priority, row: rowIndex + 1, column: columnIndex + 1 });
        }
      }
    });
  });

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.label}:${candidate.amount}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function numbersToRight(row: string[], columnIndex: number) {
  const numbers: number[] = [];
  for (let index = columnIndex + 1; index < Math.min(row.length, columnIndex + 7); index += 1) {
    if (labelPriority(row[index])) break;
    numbers.push(...numbersFromText(row[index]));
  }
  return numbers;
}

export function readExcelRows(filePath: string, options: { maxRows?: number; maxCols?: number } = {}): Promise<string[][]> {
  return readExcelWorkbookRows(filePath, options).then((payload) => payload.rows);
}

export function readExcelWorksheetRows(filePath: string, options: { maxRows?: number; maxCols?: number } = {}): Promise<ExcelWorksheetRows[]> {
  return readExcelWorkbookRows(filePath, options).then((payload) => payload.sheets);
}

function readExcelWorkbookRows(filePath: string, options: { maxRows?: number; maxCols?: number } = {}) {
  const python = process.env.EXCEL_READER_PYTHON || "python";
  const maxRows = String(options.maxRows ?? 200);
  const maxCols = String(options.maxCols ?? 80);
  return new Promise<{ rows: string[][]; sheets: ExcelWorksheetRows[] }>((resolve, reject) => {
    execFile(
      python,
      ["-c", pythonScript, filePath, maxRows, maxCols],
      {
        encoding: "utf8",
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
        maxBuffer: 8 * 1024 * 1024,
        timeout: 30_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        try {
          const payload = JSON.parse(stdout) as ExcelRowsPayload;
          resolve({
            rows: normalizeRows(payload.rows),
            sheets: normalizeSheets(payload.sheets),
          });
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}

function normalizeRows(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((row) => (
    Array.isArray(row) ? row.map((cell) => normalizeCell(cell)) : []
  ));
}

function normalizeSheets(value: unknown): ExcelWorksheetRows[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((sheet) => {
    if (!sheet || typeof sheet !== "object") return [];
    const record = sheet as Record<string, unknown>;
    const name = normalizeCell(record.name);
    const rows = normalizeRows(record.rows);
    return rows.length ? [{ name, rows }] : [];
  });
}

function normalizeCell(value: unknown) {
  const text = String(value ?? "").normalize("NFKC").trim();
  return /^(undefined|null|nan)$/i.test(text) ? "" : text;
}

export function extractPeriodFromRows(fileName: string, rows: string[][]) {
  const cells = rows.flat();
  const periodTexts = cells.filter((cell) => /(结算|账期|期间|起止|月份)/.test(cell));
  return findSeparatedPeriod(periodTexts.join(" "))
    ?? findSeparatedPeriod(cells.join(" "))
    ?? extractPeriodFromFileName(fileName);
}

export function extractPeriodFromFileName(fileName: string) {
  const normalized = fileName.normalize("NFKC");
  const compact = normalized.match(/(^|\D)(20\d{2})(0[1-9]|1[0-2])(\D|$)/);
  if (compact) return `${compact[2]}-${compact[3]}`;
  return findSeparatedPeriod(normalized);
}

function findSeparatedPeriod(text: string) {
  const separated = text.match(/(20\d{2})\s*[年./-]\s*(0?[1-9]|1[0-2])\s*(?:月|[./-]\s*\d{1,2}|(\s|$))/);
  if (separated) return `${separated[1]}-${separated[2].padStart(2, "0")}`;
  return null;
}

function splitRowsIntoDocumentBlocks(rows: string[][]) {
  const nonEmptyIndexes = rows.flatMap((row, index) => row.some(Boolean) ? [index] : []);
  if (!nonEmptyIndexes.length) return [];
  const first = nonEmptyIndexes[0];
  const last = nonEmptyIndexes[nonEmptyIndexes.length - 1];
  const boundaryIndexes = rows.flatMap((row, index) => {
    const text = cleanLabel(row.join(" "));
    if (!/(结算单号|结算明细单|费用明细单)/.test(text)) return [];
    return [index];
  });
  const boundaries = uniqueNumbers(boundaryIndexes).filter((index) => index >= first && index <= last);
  if (boundaries.length <= 1) return [{ start: first, end: last, rows: rows.slice(first, last + 1) }];
  return boundaries.map((start, index) => {
    const end = (boundaries[index + 1] ?? last + 1) - 1;
    return { start, end, rows: rows.slice(start, end + 1) };
  }).filter((block) => block.rows.some((row) => row.some(Boolean)));
}

function extractShopCodesFromRows(rows: string[][]) {
  return uniqueShopCodes(extractShopCodesFromFileName(rows.flat().join(" ")));
}

function extractDocumentNo(rows: string[][]) {
  const text = rows.flat().join(" ").normalize("NFKC");
  const match = text.match(/结算单号\s*[：:]\s*([A-Z0-9-]{4,})/i)
    ?? text.match(/单据编号\s*[：:]\s*([A-Z0-9-]{4,})/i);
  return match?.[1] ?? null;
}

function uniqueShopCodes(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toUpperCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueNumbers(values: number[]) {
  return [...new Set(values)].sort((a, b) => a - b);
}

function labelPriority(label: string) {
  const value = cleanLabel(label);
  if (!value || /(数量|单号|日期|合同|税号|银行|账户|地址|供应商|品牌|佣金|手续费|费用|费率|扣点|预付款)/.test(value)) return 0;
  if (/(已确认结算单净营业额|结算单净营业额|结算净营业额|净营业额|本月结算营业额小计)/.test(value)) return 30;
  return 0;
}

function cleanLabel(value: string) {
  return value.replace(/[：:]/g, "").replace(/\s+/g, "");
}

function numbersFromText(value: string) {
  return Array.from(value.matchAll(/[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g))
    .map((match) => Number(match[0].replace(/,/g, "")))
    .filter(Number.isFinite);
}
