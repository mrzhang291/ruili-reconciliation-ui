import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { extractShopCodesFromFileName, queryErpReconciliationData } from "./erp-base-query.js";
import { normalizeFileName, type StoredFile } from "./file-storage.js";
import { findCreatedRecordId, formatDateTime, rowsFromPage } from "./lark-store.js";
import { projectRoot, relativeCliPath, runLarkCli } from "./lark-cli.js";

export type BatchDocumentStatus =
  | "READY"
  | "NEEDS_REVIEW"
  | "REJECTED"
  | "DUPLICATE"
  | "PROCESSING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

export type BatchStatus =
  | "DRAFT"
  | "READY"
  | "PROCESSING"
  | "NEEDS_REVIEW"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type BatchAmountCandidate = {
  id: string;
  label: string;
  amount: number;
  priority: number;
  row: number;
  column: number;
};

export type BatchDocumentState = {
  id: string;
  recordId: string | null;
  file: StoredFile;
  fileName: string;
  sourceFileName: string | null;
  size: number;
  sha256: string | null;
  shopCodes: string[];
  shopNo: string | null;
  period: string | null;
  documentNo: string | null;
  documentRange: string | null;
  amountCandidates: BatchAmountCandidate[];
  confirmedCandidateId: string | null;
  confirmedSettlementAmount: number | null;
  confirmedSettlementLabel: string | null;
  erpRows: number | null;
  erpSalesTotal: number | null;
  groupId: string | null;
  taskId: string | null;
  status: BatchDocumentStatus;
  issues: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type BatchGroupState = {
  id: string;
  key: string;
  shopNo: string;
  period: string;
  documentIds: string[];
  documentCount: number;
  status: BatchDocumentStatus;
  taskId: string | null;
  settlementAmount: number | null;
  erpSalesTotal: number | null;
  differenceAmount: number | null;
  version: number;
  issues: string[];
};

export type BatchState = {
  id: string;
  recordId: string | null;
  status: BatchStatus;
  totalFiles: number;
  totalSize: number;
  maxFiles: number;
  maxTotalSize: number;
  erpFile: StoredFile | null;
  documents: BatchDocumentState[];
  groups: BatchGroupState[];
  createdAt: string;
  updatedAt: string;
};

type TableEnvelope = {
  ok?: boolean;
  data?: { tables?: Array<{ id?: string; name?: string }> };
};

type FieldEnvelope = {
  ok?: boolean;
  data?: { fields?: Array<{ id?: string; name?: string; type?: string }> };
};

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

type FieldSpec = {
  name: string;
  type: "text" | "number" | "datetime" | "attachment";
  style?: Record<string, unknown>;
  description?: string;
};

const batchTableName = "批处理汇总表";
const documentTableName = "批量结算单明细表";

const batchFields: FieldSpec[] = [
  { name: "批处理ID", type: "text" },
  { name: "状态", type: "text" },
  { name: "总文件数", type: "number", style: { type: "plain", precision: 0 } },
  { name: "有效单据数", type: "number", style: { type: "plain", precision: 0 } },
  { name: "可执行组数", type: "number", style: { type: "plain", precision: 0 } },
  { name: "待处理数", type: "number", style: { type: "plain", precision: 0 } },
  { name: "成功数", type: "number", style: { type: "plain", precision: 0 } },
  { name: "待审核数", type: "number", style: { type: "plain", precision: 0 } },
  { name: "失败数", type: "number", style: { type: "plain", precision: 0 } },
  { name: "取消数", type: "number", style: { type: "plain", precision: 0 } },
  { name: "拆单数", type: "number", style: { type: "plain", precision: 0 } },
  { name: "总金额", type: "number", style: { type: "currency", precision: 2, currency_code: "CNY" } },
  { name: "创建时间", type: "datetime", style: { format: "yyyy-MM-dd HH:mm" } },
  { name: "更新时间", type: "datetime", style: { format: "yyyy-MM-dd HH:mm" } },
  { name: "完成时间", type: "datetime", style: { format: "yyyy-MM-dd HH:mm" } },
  { name: "备注", type: "text" },
];

const documentFields: FieldSpec[] = [
  { name: "明细ID", type: "text" },
  { name: "批处理ID", type: "text" },
  { name: "源文件名", type: "text" },
  { name: "单据名称", type: "text" },
  { name: "原始文件", type: "attachment" },
  { name: "文件哈希", type: "text" },
  { name: "文件大小", type: "number", style: { type: "plain", precision: 0 } },
  { name: "店铺号", type: "text" },
  { name: "账期", type: "text" },
  { name: "结算单号", type: "text" },
  { name: "页码范围", type: "text" },
  { name: "金额候选JSON", type: "text" },
  { name: "确认金额", type: "number", style: { type: "currency", precision: 2, currency_code: "CNY" } },
  { name: "确认金额标签", type: "text" },
  { name: "ERP命中行数", type: "number", style: { type: "plain", precision: 0 } },
  { name: "ERP销售额", type: "number", style: { type: "currency", precision: 2, currency_code: "CNY" } },
  { name: "所属组ID", type: "text" },
  { name: "任务ID", type: "text" },
  { name: "状态", type: "text" },
  { name: "问题", type: "text" },
  { name: "版本", type: "number", style: { type: "plain", precision: 0 } },
  { name: "证据", type: "text" },
  { name: "Session信息", type: "text" },
  { name: "重试次数", type: "number", style: { type: "plain", precision: 0 } },
  { name: "创建时间", type: "datetime", style: { format: "yyyy-MM-dd HH:mm" } },
  { name: "更新时间", type: "datetime", style: { format: "yyyy-MM-dd HH:mm" } },
];

let tablePromise: Promise<{ batchTableId: string; documentTableId: string }> | null = null;

function batchRoot() {
  return path.join(projectRoot, ".runtime", "batches");
}

function assertSafeId(value: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("批次 ID 含有不安全的路径字符");
}

export function resolveBatchDirectory(batchId: string) {
  assertSafeId(batchId);
  return path.join(batchRoot(), batchId);
}

function resolveBatchStatePath(batchId: string) {
  return path.join(resolveBatchDirectory(batchId), "batch.json");
}

export function saveBatchUploadedFile(
  batchId: string,
  buffer: Buffer,
  originalName: string,
  contentType = "application/octet-stream",
): StoredFile {
  const directory = path.join(resolveBatchDirectory(batchId), "files");
  fs.mkdirSync(directory, { recursive: true });
  const id = crypto.randomUUID();
  const safeName = normalizeFileName(originalName) || `${id}${path.extname(originalName)}`;
  const fileDirectory = path.join(directory, id);
  fs.mkdirSync(fileDirectory, { recursive: true });
  const absolutePath = path.join(fileDirectory, safeName);
  fs.writeFileSync(absolutePath, buffer);
  return {
    id,
    extension: path.extname(safeName).toLowerCase(),
    absolutePath,
    originalName: safeName,
    contentType,
    sizeBytes: buffer.length,
  };
}

export function readBatchState(batchId: string): BatchState | null {
  const statePath = resolveBatchStatePath(batchId);
  if (!fs.existsSync(statePath)) return null;
  return JSON.parse(fs.readFileSync(statePath, "utf8")) as BatchState;
}

export function writeBatchState(state: BatchState) {
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(resolveBatchDirectory(state.id), { recursive: true });
  const statePath = resolveBatchStatePath(state.id);
  const temporaryPath = `${statePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2));
  fs.renameSync(temporaryPath, statePath);
}

export function findBatchByDocumentId(documentId: string) {
  const root = batchRoot();
  if (!fs.existsSync(root)) return null;
  for (const batchId of fs.readdirSync(root)) {
    const state = readBatchState(batchId);
    const document = state?.documents.find((item) => item.id === documentId);
    if (state && document) return { state, document };
  }
  return null;
}

function fieldJson(specs: FieldSpec[]) {
  return specs.map((field) => ({
    name: field.name,
    type: field.type,
    ...(field.style ? { style: field.style } : {}),
    ...(field.description ? { description: field.description } : {}),
  }));
}

function findTableId(payload: unknown) {
  const queue: unknown[] = [payload];
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value)) {
      if ((key === "id" || key === "table_id") && typeof child === "string" && child.startsWith("tbl")) return child;
      if (child && typeof child === "object") queue.push(child);
    }
  }
  return null;
}

function findRecordIds(payload: unknown) {
  const queue: unknown[] = [payload];
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === "record_id_list" && Array.isArray(child)) {
        return child.filter((item): item is string => typeof item === "string" && item.startsWith("rec"));
      }
      if (child && typeof child === "object") queue.push(child);
    }
  }
  return [];
}

async function listTables() {
  const payload = await runLarkCli<TableEnvelope>([
    "base", "+table-list", "--base-token", config.lark.baseToken, "--format", "json", "--as", "user",
  ]);
  return payload.data?.tables ?? [];
}

async function createTable(name: string, fields: FieldSpec[]) {
  const payload = await runLarkCli<Record<string, unknown>>([
    "base", "+table-create",
    "--base-token", config.lark.baseToken,
    "--name", name,
    "--fields", JSON.stringify(fieldJson(fields)),
    "--format", "json",
    "--as", "user",
  ]);
  const tableId = findTableId(payload);
  if (!tableId) throw new Error(`飞书创建数据表「${name}」后没有返回 table_id`);
  return tableId;
}

async function ensureFields(tableId: string, specs: FieldSpec[]) {
  const payload = await runLarkCli<FieldEnvelope>([
    "base", "+field-list", "--base-token", config.lark.baseToken, "--table-id", tableId, "--format", "json", "--as", "user",
  ]);
  const existing = new Set((payload.data?.fields ?? []).map((field) => field.name).filter(Boolean));
  for (const spec of specs) {
    if (existing.has(spec.name)) continue;
    await runLarkCli([
      "base", "+field-create",
      "--base-token", config.lark.baseToken,
      "--table-id", tableId,
      "--json", JSON.stringify(fieldJson([spec])[0]),
      "--format", "json",
      "--as", "user",
    ]);
  }
}

export async function ensureBatchTables() {
  tablePromise ??= (async () => {
    const configuredBatchTableId = process.env.LARK_BATCH_TABLE_ID || "";
    const configuredDocumentTableId = process.env.LARK_BATCH_DOCUMENT_TABLE_ID || "";
    const tables = await listTables();
    const batchTableId = configuredBatchTableId
      || tables.find((table) => table.name === batchTableName)?.id
      || await createTable(batchTableName, batchFields);
    const documentTableId = configuredDocumentTableId
      || tables.find((table) => table.name === documentTableName)?.id
      || await createTable(documentTableName, documentFields);

    await ensureFields(batchTableId, batchFields);
    await ensureFields(documentTableId, documentFields);
    return { batchTableId, documentTableId };
  })();
  return tablePromise;
}

async function recordUpsert(tableId: string, values: Record<string, unknown>, recordId?: string | null) {
  const args = ["base", "+record-upsert", "--base-token", config.lark.baseToken, "--table-id", tableId];
  if (recordId) args.push("--record-id", recordId);
  args.push("--json", JSON.stringify(values), "--format", "json", "--as", "user");
  const payload = await runLarkCli<Record<string, unknown>>(args);
  if (recordId) return recordId;
  const createdId = findCreatedRecordId(payload);
  if (!createdId) throw new Error("飞书创建批量记录后没有返回 record_id");
  return createdId;
}

async function batchCreateRecords(tableId: string, fields: string[], rows: unknown[][]) {
  if (!rows.length) return [];
  const payload = await runLarkCli<Record<string, unknown>>([
    "base", "+record-batch-create",
    "--base-token", config.lark.baseToken,
    "--table-id", tableId,
    "--json", JSON.stringify({ fields, rows }),
    "--format", "json",
    "--as", "user",
  ]);
  return findRecordIds(payload);
}

function asDate(value: string | null | undefined) {
  if (!value) return null;
  return formatDateTime(new Date(value));
}

function countDocuments(state: BatchState) {
  const valid = state.documents.filter((doc) => doc.status !== "REJECTED" && doc.status !== "DUPLICATE");
  const readyGroups = state.groups.filter((group) => group.status === "READY").length;
  const needsReview = state.documents.filter((doc) => doc.status === "NEEDS_REVIEW").length;
  const succeeded = state.documents.filter((doc) => doc.status === "SUCCEEDED").length;
  const failed = state.documents.filter((doc) => doc.status === "FAILED").length;
  const cancelled = state.documents.filter((doc) => doc.status === "CANCELLED").length;
  return {
    valid: valid.length,
    readyGroups,
    needsReview,
    succeeded,
    failed,
    cancelled,
    splitCount: state.documents.filter((doc) => doc.sourceFileName).length,
    settlementTotal: valid.reduce((sum, doc) => sum + (doc.confirmedSettlementAmount ?? 0), 0),
  };
}

function batchRecordValues(state: BatchState) {
  const counts = countDocuments(state);
  return {
    批处理ID: state.id,
    状态: state.status,
    总文件数: state.totalFiles,
    有效单据数: counts.valid,
    可执行组数: counts.readyGroups,
    待处理数: counts.needsReview,
    成功数: counts.succeeded,
    待审核数: state.documents.filter((doc) => doc.status === "READY" && doc.issues.length).length,
    失败数: counts.failed,
    取消数: counts.cancelled,
    拆单数: counts.splitCount,
    总金额: counts.settlementTotal,
    创建时间: asDate(state.createdAt),
    更新时间: asDate(state.updatedAt),
    完成时间: ["COMPLETED", "FAILED", "CANCELLED"].includes(state.status) ? formatDateTime(new Date()) : null,
    备注: `批次 ${state.id}，组 ${state.groups.length} 个，单据 ${state.documents.length} 份`,
  };
}

function documentRecordValues(document: BatchDocumentState) {
  return {
    明细ID: document.id,
    批处理ID: document.file ? document.id.split("-doc-")[0] : "",
    源文件名: document.sourceFileName ?? document.fileName,
    单据名称: document.fileName,
    文件哈希: document.sha256,
    文件大小: document.size,
    店铺号: document.shopNo ?? document.shopCodes.join("、"),
    账期: document.period,
    结算单号: document.documentNo,
    页码范围: document.documentRange,
    金额候选JSON: JSON.stringify(document.amountCandidates),
    确认金额: document.confirmedSettlementAmount,
    确认金额标签: document.confirmedSettlementLabel,
    ERP命中行数: document.erpRows,
    ERP销售额: document.erpSalesTotal,
    所属组ID: document.groupId,
    任务ID: document.taskId,
    状态: document.status,
    问题: document.issues.join("；"),
    版本: document.version,
    证据: JSON.stringify({
      sha256: document.sha256,
      candidates: document.amountCandidates.map((candidate) => ({
        label: candidate.label,
        amount: candidate.amount,
        row: candidate.row,
        column: candidate.column,
      })),
    }),
    Session信息: document.taskId ? `task=${document.taskId}` : null,
    重试次数: 0,
    创建时间: asDate(document.createdAt),
    更新时间: asDate(document.updatedAt),
  };
}

export function rebuildBatchGroups(state: BatchState) {
  const groups = new Map<string, BatchDocumentState[]>();
  for (const document of state.documents) {
    if (document.status === "REJECTED" || document.status === "DUPLICATE") {
      document.groupId = null;
      continue;
    }
    if (!document.shopNo || !document.period) {
      document.groupId = null;
      continue;
    }
    const version = document.version || 1;
    const key = `${document.shopNo}:${document.period}:v${version}`;
    groups.set(key, [...(groups.get(key) ?? []), document]);
  }

  state.groups = [...groups.entries()].map(([key, documents]) => {
    const [shopNo, period, versionLabel] = key.split(":");
    const version = Number(versionLabel.replace(/^v/, "")) || 1;
    const id = `${state.id}-${shopNo}-${period.replace("-", "")}-v${version}`;
    for (const document of documents) document.groupId = id;
    const statuses = documents.map((document) => document.status);
    const status: BatchDocumentStatus = statuses.includes("PROCESSING") ? "PROCESSING"
      : statuses.includes("FAILED") ? "FAILED"
        : statuses.includes("CANCELLED") ? "CANCELLED"
          : statuses.includes("NEEDS_REVIEW") ? "NEEDS_REVIEW"
            : statuses.every((item) => item === "SUCCEEDED") ? "SUCCEEDED"
              : "READY";
    const settlementAmount = documents.every((doc) => Number.isFinite(doc.confirmedSettlementAmount))
      ? documents.reduce((sum, doc) => sum + (doc.confirmedSettlementAmount ?? 0), 0)
      : null;
    const erpSalesTotal = documents[0]?.erpSalesTotal ?? null;
    return {
      id,
      key,
      shopNo,
      period,
      documentIds: documents.map((document) => document.id),
      documentCount: documents.length,
      status,
      taskId: documents.find((document) => document.taskId)?.taskId ?? null,
      settlementAmount,
      erpSalesTotal,
      differenceAmount: settlementAmount !== null && erpSalesTotal !== null ? erpSalesTotal - settlementAmount : null,
      version,
      issues: [...new Set(documents.flatMap((document) => document.issues))],
    };
  });

  const statuses = state.documents.map((document) => document.status);
  state.status = statuses.includes("PROCESSING") ? "PROCESSING"
    : statuses.every((status) => status === "CANCELLED") ? "CANCELLED"
      : statuses.some((status) => status === "FAILED") && !statuses.some((status) => ["READY", "PROCESSING"].includes(status)) ? "FAILED"
        : statuses.some((status) => status === "READY") ? "READY"
          : statuses.some((status) => status === "NEEDS_REVIEW") ? "NEEDS_REVIEW"
            : statuses.some((status) => status === "SUCCEEDED") ? "COMPLETED"
              : "DRAFT";
}

export async function persistNewBatch(state: BatchState) {
  rebuildBatchGroups(state);
  writeBatchState(state);
  const tables = await ensureBatchTables();
  state.recordId = await recordUpsert(tables.batchTableId, batchRecordValues(state));
  const fields = documentFields.filter((field) => field.name !== "原始文件").map((field) => field.name);
  const rows = state.documents.map((document) => {
    const values = documentRecordValues(document);
    values.批处理ID = state.id;
    return fields.map((field) => values[field as keyof typeof values] ?? null);
  });
  const recordIds = await batchCreateRecords(tables.documentTableId, fields, rows);
  for (const [index, recordId] of recordIds.entries()) state.documents[index].recordId = recordId;
  writeBatchState(state);

  for (const document of state.documents) {
    if (!document.recordId || !fs.existsSync(document.file.absolutePath)) continue;
    await runLarkCli([
      "base", "+record-upload-attachment",
      "--base-token", config.lark.baseToken,
      "--table-id", tables.documentTableId,
      "--record-id", document.recordId,
      "--field-id", "原始文件",
      "--file", relativeCliPath(document.file.absolutePath),
      "--format", "json",
      "--as", "user",
    ]);
  }
  return state;
}

export async function syncBatchState(state: BatchState, documentIds?: string[]) {
  rebuildBatchGroups(state);
  writeBatchState(state);
  const tables = await ensureBatchTables();
  state.recordId = await recordUpsert(tables.batchTableId, batchRecordValues(state), state.recordId);
  const targets = documentIds?.length
    ? state.documents.filter((document) => documentIds.includes(document.id))
    : state.documents;
  for (const document of targets) {
    if (!document.recordId) continue;
    const values = documentRecordValues(document);
    values.批处理ID = state.id;
    await recordUpsert(tables.documentTableId, values, document.recordId);
  }
  writeBatchState(state);
}

export async function queryDocumentErp(document: BatchDocumentState) {
  if (!document.shopNo || !document.period) return;
  const erp = await queryErpReconciliationData(document.shopNo, document.period);
  document.erpRows = erp.rows.length;
  document.erpSalesTotal = erp.salesTotal;
}

export function createBatchDocument(params: {
  batchId: string;
  file: StoredFile;
  fileName: string;
  sourceFileName: string | null;
  sha256: string | null;
  shopCodes: string[];
  period: string | null;
  documentNo: string | null;
  documentRange: string | null;
  amountCandidates: BatchAmountCandidate[];
  confirmedCandidateId: string | null;
  confirmedSettlementAmount: number | null;
  confirmedSettlementLabel: string | null;
  erpRows: number | null;
  erpSalesTotal: number | null;
  status: BatchDocumentStatus;
  issues: string[];
}) {
  const now = new Date().toISOString();
  const shopNo = params.shopCodes.length === 1 ? params.shopCodes[0] : null;
  return {
    id: `${params.batchId}-doc-${crypto.randomUUID().slice(0, 8)}`,
    recordId: null,
    file: params.file,
    fileName: params.fileName,
    sourceFileName: params.sourceFileName,
    size: params.file.sizeBytes,
    sha256: params.sha256,
    shopCodes: params.shopCodes,
    shopNo,
    period: params.period,
    documentNo: params.documentNo,
    documentRange: params.documentRange,
    amountCandidates: params.amountCandidates,
    confirmedCandidateId: params.confirmedCandidateId,
    confirmedSettlementAmount: params.confirmedSettlementAmount,
    confirmedSettlementLabel: params.confirmedSettlementLabel,
    erpRows: params.erpRows,
    erpSalesTotal: params.erpSalesTotal,
    groupId: null,
    taskId: null,
    status: params.status,
    issues: params.issues,
    version: 1,
    createdAt: now,
    updatedAt: now,
  } satisfies BatchDocumentState;
}

export function toBatchApi(state: BatchState) {
  rebuildBatchGroups(state);
  const counts = countDocuments(state);
  return {
    batchId: state.id,
    status: state.status,
    totalFiles: state.totalFiles,
    totalSize: state.totalSize,
    validFiles: counts.valid,
    executableFiles: state.documents.filter((document) => document.status === "READY").length,
    executableGroups: counts.readyGroups,
    rejectedFiles: state.documents.filter((document) => document.status === "REJECTED").length,
    duplicateFiles: state.documents.filter((document) => document.status === "DUPLICATE").length,
    maxFiles: state.maxFiles,
    maxTotalSize: state.maxTotalSize,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    groups: state.groups,
    items: state.documents.map((document) => ({
      documentId: document.id,
      groupId: document.groupId,
      version: document.version,
      fileName: document.fileName,
      sourceFileName: document.sourceFileName,
      size: document.size,
      sha256: document.sha256,
      shopCodes: document.shopCodes,
      shopNo: document.shopNo,
      period: document.period,
      documentNo: document.documentNo,
      documentRange: document.documentRange,
      amountCandidateCount: document.amountCandidates.length,
      amountCandidates: document.amountCandidates,
      confirmedCandidateId: document.confirmedCandidateId,
      confirmedSettlementAmount: document.confirmedSettlementAmount,
      confirmedSettlementLabel: document.confirmedSettlementLabel,
      erpRows: document.erpRows,
      erpSalesTotal: document.erpSalesTotal,
      status: document.status,
      issues: document.issues,
      taskId: document.taskId,
    })),
  };
}

export function buildBatchExportCsv(state: BatchState) {
  const columns = [
    "批处理ID", "组ID", "明细ID", "状态", "店铺号", "账期", "单据名称", "源文件名",
    "确认金额", "ERP销售额", "差额", "任务ID", "版本", "问题",
  ];
  const rows = state.documents.map((document) => {
    const difference = document.confirmedSettlementAmount !== null && document.erpSalesTotal !== null
      ? document.erpSalesTotal - document.confirmedSettlementAmount
      : null;
    return [
      state.id,
      document.groupId ?? "",
      document.id,
      document.status,
      document.shopNo ?? "",
      document.period ?? "",
      document.fileName,
      document.sourceFileName ?? "",
      document.confirmedSettlementAmount ?? "",
      document.erpSalesTotal ?? "",
      difference ?? "",
      document.taskId ?? "",
      `v${document.version}`,
      document.issues.join("；"),
    ];
  });
  return [columns, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

function csvCell(value: unknown) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
}

export async function findBatchByRecordId(batchId: string) {
  const tables = await ensureBatchTables();
  const payload = await runLarkCli<PageEnvelope>([
    "base", "+record-list",
    "--base-token", config.lark.baseToken,
    "--table-id", tables.documentTableId,
    "--filter-json", JSON.stringify({ logic: "and", conditions: [["批处理ID", "==", batchId]] }),
    "--limit", "200",
    "--format", "json",
    "--as", "user",
  ]);
  return rowsFromPage(payload);
}

export function shopCodesFromInput(value: string) {
  const direct = value.trim().toUpperCase();
  return direct ? extractShopCodesFromFileName(direct).concat(/^[A-Z]{2,5}[A-Z0-9]*\d[A-Z0-9]*$/.test(direct) ? [direct] : []) : [];
}
