import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { projectRoot, relativeCliPath, runLarkCli } from "./lark-cli.js";
import { cacheKey, invalidateReadCache, readThroughCache } from "./read-cache.js";
import type { CherryIssue, ReconciliationResult } from "./cherrystudio.js";

const taskFields = [
  "任务ID", "任务名称", "店铺号", "账期", "结算文件", "ERP文件", "ERP金额", "结算金额", "Agent差额",
  "权威差额", "差额校验", "合理性校验", "状态", "处理批次ID", "使用规则版本", "Agent原始JSON",
  "失败原因", "取消原因", "开始时间", "完成时间", "提交人", "创建时间", "审核明细",
] as const;
const reviewFields = [
  "明细ID", "明细标题", "关联任务", "任务ID", "店铺号", "差异金额", "差异描述", "处理建议",
  "审核结果", "审核备注", "审核人", "审核时间", "创建时间",
] as const;

const baseToApiStatus: Record<string, string> = {
  待处理: "QUEUED",
  处理中: "PROCESSING",
  已一致: "SUCCEEDED",
  待审核: "NEEDS_REVIEW",
  已审核: "REVIEWED",
  失败: "FAILED",
  已取消: "CANCELLED",
  已作废: "OBSOLETE",
};
const apiToBaseStatus = Object.fromEntries(Object.entries(baseToApiStatus).map(([base, api]) => [api, base]));
const baseToReviewStatus: Record<string, string> = { 待处理: "PENDING", 已通过: "APPROVED", 已忽略: "IGNORED" };
const apiToReviewStatus = Object.fromEntries(Object.entries(baseToReviewStatus).map(([base, api]) => [api, base]));
const taskListCacheTtlMs = 15_000;
const reviewListCacheTtlMs = 20_000;
const statisticsCacheTtlMs = 30_000;
const reconciliationReviewThresholdAmount = 200;

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
type DataQueryEnvelope = {
  ok?: boolean;
  data?: { main_data?: Array<Record<string, { value?: unknown }>> };
};
type Attachment = { file_token?: string; fileToken?: string; token?: string; name?: string; size?: number; names?: string[] };

export type StoredTask = {
  id: string;
  taskId: string;
  name: string | null;
  shopNo: string | null;
  period: string | null;
  status: string;
  batchId: string | null;
  ruleVersions: string | null;
  settlementAmount: number | null;
  erpAmount: number | null;
  differenceAmount: number | null;
  agentDifference: number | null;
  differenceCheck: string | null;
  reasonablenessCheck: string | null;
  failureReason: string | null;
  cancelReason: string | null;
  rawAgentJson: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  createdBy: { id: string; name: string };
  settlementFile: Attachment | null;
  erpFile: Attachment | null;
  reviewIds: string[];
};

export type StoredReviewItem = {
  id: string;
  title: string;
  taskRecordId: string | null;
  taskId: string;
  shopNo: string | null;
  differenceAmount: number | null;
  message: string;
  suggestion: string | null;
  status: string;
  note: string | null;
  resolvedAt: string | null;
  createdAt: string | null;
};

const asText = (value: unknown) => {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item : "").filter(Boolean).join("、");
  return "";
};
const asNumber = (value: unknown) => {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
};
const asSelect = (value: unknown) => Array.isArray(value) ? asText(value[0]) : asText(value);
const asDateTime = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  const text = asText(value);
  if (!text) return null;
  const parsed = Date.parse(text.includes("T") ? text : text.replace(" ", "T") + "+08:00");
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : text;
};
const asLinks = (value: unknown) => Array.isArray(value)
  ? value.flatMap((item) => item && typeof item === "object" && "id" in item && typeof item.id === "string" ? [item.id] : [])
  : [];
export const asAttachment = (value: unknown): Attachment | null => {
  const attachments = (Array.isArray(value) ? value : [])
    .filter((item): item is Attachment => Boolean(item) && typeof item === "object");
  if (!attachments.length) return null;
  if (attachments.length === 1) return attachments[0];
  const sizes = attachments
    .map((item) => item.size)
    .filter((size): size is number => typeof size === "number" && Number.isFinite(size));
  const names = attachments.map((item) => item.name).filter((name): name is string => Boolean(name));
  return {
    ...attachments[0],
    name: `${attachments[0].name ?? "附件"} 等 ${attachments.length} 份`,
    size: sizes.length ? sizes.reduce((sum, size) => sum + size, 0) : attachments[0].size,
    names,
  };
};
const asUser = (value: unknown) => {
  const item = Array.isArray(value) ? value[0] : value;
  if (!item || typeof item !== "object") return { id: "feishu", name: "飞书用户" };
  const record = item as Record<string, unknown>;
  return {
    id: typeof record.id === "string" ? record.id : "feishu",
    name: typeof record.name === "string" ? record.name : "飞书用户",
  };
};

export function isLarkRecordId(recordId: string) {
  return /^rec[A-Za-z0-9]{1,11}$/.test(recordId);
}

export function rowsFromPage(payload: PageEnvelope) {
  const page = payload.data;
  const fields = page?.fields ?? [];
  const missing = new Set(page?.record_not_found ?? []);
  return (page?.data ?? []).map((row, index) => ({
    id: page?.record_id_list?.[index] ?? "",
    values: Object.fromEntries(fields.map((field, fieldIndex) => [field, row[fieldIndex]])),
  })).filter((row) => row.id && !missing.has(row.id));
}

function taskFromRow(row: ReturnType<typeof rowsFromPage>[number]): StoredTask {
  const value = row.values;
  return {
    id: row.id,
    taskId: asText(value.任务ID) || row.id,
    name: asText(value.任务名称) || null,
    shopNo: asText(value.店铺号) || null,
    period: asText(value.账期) || null,
    status: baseToApiStatus[asSelect(value.状态)] ?? "FAILED",
    batchId: asText(value.处理批次ID) || null,
    ruleVersions: asText(value.使用规则版本) || null,
    settlementAmount: asNumber(value.结算金额),
    erpAmount: asNumber(value.ERP金额),
    differenceAmount: asNumber(value.权威差额),
    agentDifference: asNumber(value.Agent差额),
    differenceCheck: asText(value.差额校验) || null,
    reasonablenessCheck: asText(value.合理性校验) || null,
    failureReason: asText(value.失败原因) || null,
    cancelReason: asText(value.取消原因) || null,
    rawAgentJson: asText(value.Agent原始JSON) || null,
    startedAt: asDateTime(value.开始时间),
    completedAt: asDateTime(value.完成时间),
    createdAt: asDateTime(value.创建时间) ?? new Date().toISOString(),
    createdBy: asUser(value.提交人),
    settlementFile: asAttachment(value.结算文件),
    erpFile: asAttachment(value.ERP文件),
    reviewIds: asLinks(value.审核明细),
  };
}

function reviewFromRow(row: ReturnType<typeof rowsFromPage>[number]): StoredReviewItem {
  const value = row.values;
  return {
    id: row.id,
    title: asText(value.明细标题) || asText(value.明细ID) || "差异明细",
    taskRecordId: asLinks(value.关联任务)[0] ?? null,
    taskId: asText(value.任务ID),
    shopNo: asText(value.店铺号) || null,
    differenceAmount: asNumber(value.差异金额),
    message: asText(value.差异描述),
    suggestion: asText(value.处理建议) || null,
    status: baseToReviewStatus[asSelect(value.审核结果)] ?? "PENDING",
    note: asText(value.审核备注) || null,
    resolvedAt: asDateTime(value.审核时间),
    createdAt: asDateTime(value.创建时间),
  };
}

async function recordGet(tableId: string, recordId: string, fields: readonly string[]) {
  if (!isLarkRecordId(recordId)) return null;
  const args = ["base", "+record-get", "--base-token", config.lark.baseToken, "--table-id", tableId, "--record-id", recordId, "--format", "json", "--as", "user"];
  for (const field of fields) args.push("--field-id", field);
  return rowsFromPage(await runLarkCli<PageEnvelope>(args))[0] ?? null;
}

export function findCreatedRecordId(payload: unknown) {
  const queue: unknown[] = [payload];
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value)) {
      if ((key === "record_id" || key === "id") && typeof child === "string" && child.startsWith("rec")) return child;
      if (key === "record_id_list" && Array.isArray(child)) {
        const createdId = child.find((item): item is string => typeof item === "string" && item.startsWith("rec"));
        if (createdId) return createdId;
      }
      if (child && typeof child === "object") queue.push(child);
    }
  }
  return null;
}

export function formulaChecksReady(task: Pick<StoredTask, "differenceCheck" | "reasonablenessCheck" | "differenceAmount">) {
  const terminal = new Set(["通过", "不通过"]);
  return task.differenceAmount !== null
    && terminal.has(task.differenceCheck ?? "")
    && terminal.has(task.reasonablenessCheck ?? "");
}

export function resolveTaskCompletionStatus(
  task: Pick<StoredTask, "differenceCheck" | "reasonablenessCheck" | "differenceAmount">,
  issueCount: number,
) {
  if (task.differenceCheck !== "通过") return "失败";
  return issueCount > 0
    || task.reasonablenessCheck === "不通过"
    || Math.abs(task.differenceAmount ?? 0) > reconciliationReviewThresholdAmount
    ? "待审核"
    : "已一致";
}

function invalidateTaskReadCaches() {
  invalidateReadCache(["tasks:", "stats:"]);
}

function invalidateReviewReadCaches() {
  invalidateReadCache(["reviews:", "tasks:", "stats:"]);
}

function normalizedFileNames(task: Pick<StoredTask, "settlementFile" | "name">) {
  const names = task.settlementFile?.names?.length ? task.settlementFile.names : [task.settlementFile?.name ?? task.name ?? ""];
  return names.map((name) => name.normalize("NFKC").trim().toUpperCase()).filter(Boolean);
}

export function findSupersededTaskRecords(current: StoredTask, candidates: StoredTask[]) {
  const currentFiles = normalizedFileNames(current);
  const currentCreatedAt = Date.parse(current.createdAt);
  if (!current.shopNo || !current.period || !currentFiles.length || !Number.isFinite(currentCreatedAt)) return [];
  return candidates.filter((task) => (
    task.id !== current.id
    && task.status === "NEEDS_REVIEW"
    && task.shopNo === current.shopNo
    && task.period === current.period
    && normalizedFileNames(task).some((fileName) => currentFiles.includes(fileName))
    && Date.parse(task.createdAt) <= currentCreatedAt
  ));
}

async function recordUpsert(tableId: string, values: Record<string, unknown>, recordId?: string) {
  const args = ["base", "+record-upsert", "--base-token", config.lark.baseToken, "--table-id", tableId];
  if (recordId) args.push("--record-id", recordId);
  args.push("--json", JSON.stringify(values), "--as", "user");
  const payload = await runLarkCli<Record<string, unknown>>(args);
  if (recordId) return recordId;
  const createdId = findCreatedRecordId(payload);
  if (createdId) return createdId;
  throw new Error("飞书创建记录后没有返回 record_id");
}

export async function createTaskRecord(params: { name: string; batchId: string }) {
  const now = formatDateTime(new Date());
  const recordId = await recordUpsert(config.lark.taskTableId, {
    任务名称: params.name,
    状态: "处理中",
    处理批次ID: params.batchId,
    开始时间: now,
  });
  invalidateTaskReadCaches();
  return recordId;
}

export async function updateTaskRecord(recordId: string, values: Record<string, unknown>) {
  await recordUpsert(config.lark.taskTableId, values, recordId);
  invalidateTaskReadCaches();
}

export async function uploadTaskAttachment(recordId: string, field: "结算文件" | "ERP文件", absolutePath: string) {
  await runLarkCli([
    "base", "+record-upload-attachment",
    "--base-token", config.lark.baseToken,
    "--table-id", config.lark.taskTableId,
    "--record-id", recordId,
    "--field-id", field,
    "--file", relativeCliPath(absolutePath),
    "--as", "user",
  ]);
  invalidateTaskReadCaches();
}

export async function getTaskRecord(recordId: string) {
  const row = await recordGet(config.lark.taskTableId, recordId, taskFields);
  return row ? taskFromRow(row) : null;
}

export async function getReviewRecords(recordIds: string[]) {
  if (!recordIds.length) return [];
  const args = ["base", "+record-get", "--base-token", config.lark.baseToken, "--table-id", config.lark.reviewTableId, "--format", "json", "--as", "user"];
  for (const id of recordIds) args.push("--record-id", id);
  for (const field of reviewFields) args.push("--field-id", field);
  return rowsFromPage(await runLarkCli<PageEnvelope>(args)).map(reviewFromRow);
}

function reviewListFilter(params: { statuses: string[]; taskId?: string }) {
  const conditions: unknown[] = [];
  const baseStatuses = params.statuses.map((status) => apiToReviewStatus[status]).filter(Boolean);
  if (baseStatuses.length) conditions.push(["审核结果", "intersects", baseStatuses]);
  if (params.taskId) conditions.push(["任务ID", "==", params.taskId]);
  return conditions.length ? { logic: "and", conditions } : undefined;
}

async function reviewListPage(params: { offset: number; limit: number; statuses: string[]; taskId?: string }) {
  const args = ["base", "+record-list", "--base-token", config.lark.baseToken, "--table-id", config.lark.reviewTableId];
  const filter = reviewListFilter(params);
  if (filter) args.push("--filter-json", JSON.stringify(filter));
  args.push("--sort-json", JSON.stringify([{ field: "创建时间", desc: true }]), "--offset", String(params.offset), "--limit", String(params.limit), "--format", "json", "--as", "user");
  for (const field of reviewFields) args.push("--field-id", field);
  return runLarkCli<PageEnvelope>(args);
}

export async function listReviewRecords(params: { page: number; pageSize: number; statuses: string[]; taskId?: string }) {
  const key = cacheKey("reviews:list", {
    page: params.page,
    pageSize: params.pageSize,
    statuses: [...params.statuses].sort(),
    taskId: params.taskId ?? "",
  });
  return readThroughCache(key, reviewListCacheTtlMs, async () => {
    const offset = (params.page - 1) * params.pageSize;
    const page = await reviewListPage({ offset, limit: params.pageSize, statuses: params.statuses, taskId: params.taskId });
    return {
      items: rowsFromPage(page).map(reviewFromRow),
      hasMore: Boolean(page.data?.has_more),
    };
  });
}

async function listTaskReviewRecords(task: StoredTask) {
  const items: StoredReviewItem[] = [];
  for (let page = 1; ; page += 1) {
    const result = await listReviewRecords({ page, pageSize: 200, statuses: [], taskId: task.taskId });
    items.push(...result.items);
    if (!result.hasMore) break;
  }
  return items;
}

export async function getTaskDetail(recordId: string) {
  const task = await getTaskRecord(recordId);
  if (!task) return null;
  return { task, reviewItems: await listTaskReviewRecords(task) };
}

function listFilter(statuses: string[]) {
  const baseStatuses = statuses.map((status) => apiToBaseStatus[status]).filter(Boolean);
  return baseStatuses.length ? { logic: "and", conditions: [["状态", "intersects", baseStatuses]] } : undefined;
}

async function listPage(params: { offset: number; limit: number; statuses: string[]; keyword?: string }) {
  const command = params.keyword ? "+record-search" : "+record-list";
  const args = ["base", command, "--base-token", config.lark.baseToken, "--table-id", config.lark.taskTableId];
  if (params.keyword) {
    args.push("--keyword", params.keyword);
    for (const field of ["任务ID", "任务名称", "店铺号", "账期"]) args.push("--search-field", field);
  }
  const filter = listFilter(params.statuses);
  if (filter) args.push("--filter-json", JSON.stringify(filter));
  args.push("--sort-json", JSON.stringify([{ field: "创建时间", desc: true }]), "--offset", String(params.offset), "--limit", String(params.limit), "--format", "json", "--as", "user");
  for (const field of taskFields) args.push("--field-id", field);
  return await runLarkCli<PageEnvelope>(args);
}

async function listTaskRecordsByShopPeriod(shopNo: string, period: string) {
  const tasks: StoredTask[] = [];
  const limit = 200;
  for (let offset = 0; ; offset += limit) {
    const args = [
      "base", "+record-list",
      "--base-token", config.lark.baseToken,
      "--table-id", config.lark.taskTableId,
      "--filter-json", JSON.stringify({ logic: "and", conditions: [["店铺号", "==", shopNo], ["账期", "==", period]] }),
      "--sort-json", JSON.stringify([{ field: "创建时间", desc: true }]),
      "--offset", String(offset),
      "--limit", String(limit),
      "--format", "json",
      "--as", "user",
    ];
    for (const field of taskFields) args.push("--field-id", field);
    const page = await runLarkCli<PageEnvelope>(args);
    tasks.push(...rowsFromPage(page).map(taskFromRow));
    if (!page.data?.has_more) return tasks;
  }
}

async function dataQuery(dsl: Record<string, unknown>) {
  return runLarkCli<DataQueryEnvelope>([
    "base", "+data-query", "--base-token", config.lark.baseToken,
    "--dsl", JSON.stringify(dsl), "--as", "user",
  ]);
}

async function statusCounts(statuses: string[] = []) {
  const baseStatuses = statuses.map((status) => apiToBaseStatus[status]).filter(Boolean);
  const conditions = baseStatuses.length ? [{ field_name: "状态", operator: "contains", value: baseStatuses }] : [];
  const payload = await dataQuery({
    datasource: { type: "table", table: { tableId: config.lark.taskTableId } },
    dimensions: [{ field_name: "状态", alias: "status" }],
    measures: [{ field_name: "任务ID", aggregation: "count_all", alias: "count" }],
    ...(conditions.length ? { filters: { type: 1, conjunction: "and", conditions } } : {}),
    shaper: { format: "flat" },
  });
  const counts: Record<string, number> = {};
  for (const row of payload.data?.main_data ?? []) {
    const status = baseToApiStatus[asText(row.status?.value)];
    if (status) counts[status] = asNumber(row.count?.value) ?? 0;
  }
  return counts;
}

export async function listTaskRecords(params: { page: number; pageSize: number; statuses: string[]; keyword?: string }) {
  const key = cacheKey("tasks:list", {
    page: params.page,
    pageSize: params.pageSize,
    statuses: [...params.statuses].sort(),
    keyword: params.keyword ?? "",
  });
  return readThroughCache(key, taskListCacheTtlMs, async () => {
    const offset = (params.page - 1) * params.pageSize;
    if (!params.keyword) {
      const [page, filteredCounts, facets] = await Promise.all([
        listPage({ offset, limit: params.pageSize, statuses: params.statuses }),
        statusCounts(params.statuses),
        statusCounts(),
      ]);
      return {
        items: rowsFromPage(page).map(taskFromRow),
        total: Object.values(filteredCounts).reduce((sum, count) => sum + count, 0),
        facets,
      };
    }

    const matched: StoredTask[] = [];
    for (let searchOffset = 0; ; searchOffset += 200) {
      const page = await listPage({ offset: searchOffset, limit: 200, statuses: [], keyword: params.keyword });
      matched.push(...rowsFromPage(page).map(taskFromRow));
      if (!page.data?.has_more) break;
    }
    const facets: Record<string, number> = {};
    for (const task of matched) facets[task.status] = (facets[task.status] ?? 0) + 1;
    const filtered = params.statuses.length ? matched.filter((task) => params.statuses.includes(task.status)) : matched;
    return { items: filtered.slice(offset, offset + params.pageSize), total: filtered.length, facets };
  });
}

export async function createReviewRecords(task: StoredTask, issues: CherryIssue[]) {
  const uniqueIssues = uniqueActionableIssues(issues);
  if (!uniqueIssues.length) return [];
  const fields = ["明细标题", "关联任务", "任务ID", "店铺号", "差异金额", "差异描述", "处理建议", "审核结果"];
  const rows = uniqueIssues.map((issue, index) => [
    asText(issue.rowLabel ?? issue.fieldName) || `第 ${index + 1} 条差异`,
    [{ id: task.id }],
    task.taskId,
    task.shopNo ?? "",
    asNumber(issue.differenceAmount),
    asText(issue.message),
    asText(issue.suggestion),
    "待处理",
  ]);
  const payload = await runLarkCli<Record<string, unknown>>([
    "base", "+record-batch-create", "--base-token", config.lark.baseToken,
    "--table-id", config.lark.reviewTableId,
    "--json", JSON.stringify({ fields, rows }), "--as", "user",
  ]);
  const queue: unknown[] = [payload];
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== "object") continue;
    for (const [key, child] of Object.entries(value)) {
      if (key === "record_id_list" && Array.isArray(child)) {
        const ids = child.filter((item): item is string => typeof item === "string");
        invalidateReviewReadCaches();
        return ids;
      }
      if (child && typeof child === "object") queue.push(child);
    }
  }
  invalidateReviewReadCaches();
  return [];
}

export async function applyTaskResult(recordId: string, batchId: string, result: ReconciliationResult, ruleVersions: string[]) {
  const current = await getTaskRecord(recordId);
  if (!current || current.status !== "PROCESSING" || current.batchId !== batchId) return false;
  await updateTaskRecord(recordId, {
    任务名称: `${result.name} ${result.period}`,
    店铺号: result.name,
    账期: result.period,
    ERP金额: result.erpAmount,
    结算金额: result.settlementAmount,
    Agent差额: result.difference,
    使用规则版本: ruleVersions.join(", "),
    Agent原始JSON: JSON.stringify(result.rawAgentPayload),
  });

  let verified: StoredTask | null = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    verified = await getTaskRecord(recordId);
    if (verified && formulaChecksReady(verified)) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!verified || verified.status !== "PROCESSING" || verified.batchId !== batchId) return false;
  if (!formulaChecksReady(verified)) {
    const reason = `飞书公式校验超时：差额校验=${verified.differenceCheck ?? "未生成"}，合理性校验=${verified.reasonablenessCheck ?? "未生成"}`;
    await updateTaskRecord(recordId, {
      状态: "失败",
      完成时间: formatDateTime(new Date()),
      失败原因: reason,
    });
    throw new Error(reason);
  }
  const actionableIssues = uniqueActionableIssues(result.issues);
  const status = resolveTaskCompletionStatus(verified, actionableIssues.length);
  await updateTaskRecord(recordId, {
    状态: status,
    完成时间: formatDateTime(new Date()),
    失败原因: status === "失败" ? `飞书差额校验未通过：差额校验=${verified.differenceCheck ?? "未生成"}，合理性校验=${verified.reasonablenessCheck ?? "未生成"}` : null,
  });
  const completed = await getTaskRecord(recordId);
  if (completed && status === "待审核") await createReviewRecords(completed, actionableIssues);
  if (completed && status !== "失败") await obsoleteSupersededTaskRecords(completed);
  return true;
}

export async function obsoleteSupersededTaskRecords(current: StoredTask) {
  const candidates = await listTaskRecordsByShopPeriod(current.shopNo ?? "", current.period ?? "");
  const superseded = findSupersededTaskRecords(current, candidates);
  for (const task of superseded) {
    await markTaskObsolete(task.id, `同店同账期同结算文件已有更新任务 ${current.taskId}，旧任务作废。`);
  }
  return superseded.map((task) => task.id);
}

export function uniqueActionableIssues(issues: CherryIssue[]) {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const message = asText(issue.message);
    if (!message) return false;
    const title = asText(issue.rowLabel ?? issue.fieldName);
    const amount = asNumber(issue.differenceAmount);
    const key = `${title}|${amount ?? ""}|${message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function failTaskRecord(recordId: string, batchId: string, message: string) {
  const current = await getTaskRecord(recordId);
  if (!current || current.status !== "PROCESSING" || current.batchId !== batchId) return;
  await updateTaskRecord(recordId, { 状态: "失败", 失败原因: message, 完成时间: formatDateTime(new Date()) });
}

export async function cancelTaskRecord(recordId: string, reason = "用户取消") {
  const current = await getTaskRecord(recordId);
  if (!current) return null;
  if (!["QUEUED", "PROCESSING"].includes(current.status)) return current;
  await updateTaskRecord(recordId, { 状态: "已取消", 取消原因: reason, 完成时间: formatDateTime(new Date()) });
  return { ...current, status: "CANCELLED" };
}

export async function deleteTaskRecord(recordId: string) {
  const task = await getTaskRecord(recordId);
  if (!task) return false;
  if (["QUEUED", "PROCESSING"].includes(task.status)) throw new Error("TASK_ACTIVE");
  if (task.reviewIds.length) {
    await runLarkCli([
      "base", "+record-delete", "--base-token", config.lark.baseToken,
      "--table-id", config.lark.reviewTableId, "--json", JSON.stringify({ record_id_list: task.reviewIds }),
      "--yes", "--as", "user",
    ]);
  }
  await runLarkCli([
    "base", "+record-delete", "--base-token", config.lark.baseToken,
    "--table-id", config.lark.taskTableId, "--record-id", recordId, "--yes", "--as", "user",
  ]);
  invalidateReviewReadCaches();
  return true;
}

export async function updateReviewRecord(taskId: string, itemId: string, status: string) {
  const item = await recordGet(config.lark.reviewTableId, itemId, reviewFields);
  if (!item || !asLinks(item.values.关联任务).includes(taskId)) return false;
  await recordUpsert(config.lark.reviewTableId, {
    审核结果: apiToReviewStatus[status],
    审核时间: status === "PENDING" ? null : formatDateTime(new Date()),
    审核备注: status === "PENDING" ? null : undefined,
  }, itemId);
  invalidateReviewReadCaches();
  const task = await getTaskRecord(taskId);
  if (!task) return false;
  const reviews = await listTaskReviewRecords(task);
  const allDone = reviews.length > 0 && reviews.every((review) => review.id === itemId ? status !== "PENDING" : review.status !== "PENDING");
  if (allDone && task.status === "NEEDS_REVIEW") await updateTaskRecord(taskId, { 状态: "已审核" });
  if (!allDone && task.status === "REVIEWED") await updateTaskRecord(taskId, { 状态: "待审核" });
  return true;
}

export async function approveTaskPendingReviews(taskId: string, note: string) {
  const task = await getTaskRecord(taskId);
  if (!task) return false;
  const reviews = await listTaskReviewRecords(task);
  const pendingReviews = reviews.filter((review) => review.status === "PENDING");
  if (!pendingReviews.length) return false;

  const now = formatDateTime(new Date());
  for (const review of pendingReviews) {
    await recordUpsert(config.lark.reviewTableId, {
      审核结果: "已通过",
      审核备注: note,
      审核时间: now,
    }, review.id);
  }
  invalidateReviewReadCaches();
  if (task.status === "NEEDS_REVIEW") await updateTaskRecord(taskId, { 状态: "已审核" });
  return true;
}

const scopeMismatchSuggestion = "不要按 ERP 全店汇总或不可比口径差额直接定责；请补充 ERP 合同/专柜/铺位/活动范围键，或核对结算单扣点、其他扣率、变扣和费用扣减后再按同范围复核。";

function appendReviewMessage(message: string, note: string) {
  if (!message) return note;
  return message.includes(note) ? message : `${message} ${note}`;
}

function markRawAgentScopeMismatch(rawAgentJson: string | null, note: string) {
  if (!rawAgentJson) return null;
  try {
    const payload = JSON.parse(rawAgentJson) as Record<string, unknown>;
    return JSON.stringify({
      ...payload,
      issues: appendReviewMessage(asText(payload.issues), note),
      scopedErpMismatch: true,
    });
  } catch {
    return rawAgentJson;
  }
}

export async function markTaskPendingReviewsScopeMismatch(taskId: string, note: string) {
  const task = await getTaskRecord(taskId);
  if (!task) return false;
  const reviews = await listTaskReviewRecords(task);
  const pendingReviews = reviews.filter((review) => review.status === "PENDING");
  if (!pendingReviews.length) return false;

  for (const review of pendingReviews) {
    await recordUpsert(config.lark.reviewTableId, {
      差异金额: null,
      差异描述: appendReviewMessage(review.message, note),
      处理建议: scopeMismatchSuggestion,
    }, review.id);
  }

  const rawAgentJson = markRawAgentScopeMismatch(task.rawAgentJson, note);
  if (rawAgentJson && rawAgentJson !== task.rawAgentJson) {
    await updateTaskRecord(task.id, { Agent原始JSON: rawAgentJson });
  }
  invalidateReviewReadCaches();
  return true;
}

export async function markTaskObsolete(taskId: string, note: string) {
  const task = await getTaskRecord(taskId);
  if (!task || ["QUEUED", "PROCESSING"].includes(task.status)) return false;
  const now = formatDateTime(new Date());
  const reviews = await listTaskReviewRecords(task);
  for (const review of reviews.filter((item) => item.status === "PENDING")) {
    await recordUpsert(config.lark.reviewTableId, {
      审核结果: "已忽略",
      审核备注: note,
      审核时间: now,
    }, review.id);
  }
  await updateTaskRecord(taskId, {
    状态: "已作废",
    取消原因: note,
    完成时间: now,
  });
  invalidateReviewReadCaches();
  return true;
}

export async function downloadTaskAttachment(recordId: string, kind: "SETTLEMENT" | "ERP") {
  const task = await getTaskRecord(recordId);
  if (!task) return null;
  const attachment = kind === "SETTLEMENT" ? task.settlementFile : task.erpFile;
  const token = attachment?.file_token ?? attachment?.fileToken ?? attachment?.token;
  if (!attachment || !token) return null;
  const directory = path.join(projectRoot, ".runtime", "downloads", crypto.randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  const name = path.basename(attachment.name || `${kind.toLowerCase()}.bin`);
  const destination = path.join(directory, name);
  await runLarkCli([
    "base", "+record-download-attachment", "--base-token", config.lark.baseToken,
    "--table-id", config.lark.taskTableId, "--record-id", recordId,
    "--file-token", token, "--output", relativeCliPath(destination), "--overwrite", "--as", "user",
  ]);
  return { absolutePath: destination, name, size: attachment.size ?? fs.statSync(destination).size, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

export async function larkConnectionStatus() {
  const payload = await runLarkCli<{ data?: { base?: { name?: string } } }>([
    "base", "+base-get", "--base-token", config.lark.baseToken, "--as", "user",
  ]);
  return { status: "ok" as const, baseName: payload.data?.base?.name ?? "飞书多维表格" };
}

export function fileSummary(taskId: string, kind: "SETTLEMENT" | "ERP", attachment: Attachment | null) {
  const token = attachment?.file_token ?? attachment?.fileToken ?? attachment?.token ?? `${taskId}:${kind}`;
  return { id: token, name: attachment?.name ?? (kind === "SETTLEMENT" ? "结算文件" : "飞书ERP明细表"), size: attachment?.size ?? 0 };
}

async function allTaskRecords() {
  const tasks: StoredTask[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await listPage({ offset, limit: 200, statuses: [] });
    tasks.push(...rowsFromPage(page).map(taskFromRow));
    if (!page.data?.has_more) return tasks;
  }
}

const shiftMonth = (month: string, offset: number) => {
  const [year, number] = month.split("-").map(Number);
  const absolute = year * 12 + number - 1 + offset;
  return `${Math.floor(absolute / 12)}-${String(absolute % 12 + 1).padStart(2, "0")}`;
};

export async function getTaskStatistics(month: string) {
  return readThroughCache(cacheKey("stats:tasks", { month }), statisticsCacheTtlMs, async () => {
    const tasks = await allTaskRecords();
    const inMonth = (task: StoredTask, target: string) => task.createdAt.slice(0, 7) === target;
    const current = tasks.filter((task) => inMonth(task, month));
    const previousTotal = tasks.filter((task) => inMonth(task, shiftMonth(month, -1))).length;
    const count = (status: string) => current.filter((task) => task.status === status).length;
    const trend = Array.from({ length: 6 }, (_, index) => {
      const label = shiftMonth(month, index - 5);
      return { label, taskCount: tasks.filter((task) => inMonth(task, label)).length };
    });
    return {
      month,
      totalTasks: current.length,
      succeededTasks: count("SUCCEEDED"),
      needsReviewTasks: count("NEEDS_REVIEW"),
      reviewedTasks: count("REVIEWED"),
      failedTasks: count("FAILED"),
      processingTasks: count("PROCESSING") + count("QUEUED"),
      autoMatchRate: current.length ? count("SUCCEEDED") / current.length : 0,
      monthOverMonthRate: previousTotal ? (current.length - previousTotal) / previousTotal : 0,
      totalDifferenceAmount: current.reduce((sum, task) => sum + Math.abs(task.differenceAmount ?? 0), 0).toFixed(2),
      trend,
      updatedAt: new Date().toISOString(),
    };
  });
}

export function formatDateTime(date: Date) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second}`;
}

export { apiToBaseStatus, baseToApiStatus, apiToReviewStatus, baseToReviewStatus };
