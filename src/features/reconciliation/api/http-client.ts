import { ReconciliationApiError } from "./error";
import type { ReconciliationApi } from "./types";
import type {
  BatchPrecheckResult,
  BatchReconciliationTaskCreateResult,
  CreateBatchReconciliationTasksInput,
  CreateReconciliationTaskInput,
  BatchUpdateErpRecordsInput,
  BatchUpdateErpRecordsResult,
  ErpFilterOptions,
  ErpImportResult,
  ErpRecord,
  ErpRecordInput,
  ImportErpFileInput,
  ListErpRecordsParams,
  ListReconciliationTasksParams,
  PaginatedErpRecords,
  Money,
  PaginatedTasks,
  PrecheckBatchInput,
  ReconciliationProcessLog,
  ReconciliationReviewRow,
  ReconciliationReviewItem,
  ReconciliationStatistics,
  ReconciliationTaskDetail,
  ReconciliationTaskSummary,
  ReconciliationStatus,
  ReviewItemStatus,
  SelectBatchDocumentAmountInput,
  UpdateBatchDocumentIdentityInput,
} from "../model/types";

type HttpConfig = {
  baseUrl: string;
};

const startupRetryDelaysMs = [250, 500, 1_000, 1_500, 2_000];

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const money = (value: string | number | null | undefined): Money | null => {
  if (value === null || value === undefined || value === "") return null;
  return { currency: "CNY", value: String(value) };
};

const payloadMoney = (value: unknown): Money | null => (
  typeof value === "string" || typeof value === "number" ? money(value) : null
);

function statusFromString(status: string): ReconciliationStatus {
  if (
    status === "QUEUED" ||
    status === "PROCESSING" ||
    status === "SUCCEEDED" ||
    status === "NEEDS_REVIEW" ||
    status === "REVIEWED" ||
    status === "FAILED" ||
    status === "CANCELLED" ||
    status === "OBSOLETE"
  ) {
    return status;
  }
  return "FAILED";
}

type RawSummary = {
  id: string;
  name: string | null;
  status: string;
  periodLabel: string | null;
  version: number;
  settlementFile: { id: string; name: string; size: number };
  erpFile: { id: string; name: string; size: number };
  metrics: {
    settlementAmount: string | null;
    erpAmount: string | null;
    differenceAmount: string | null;
  };
  createdAt: string;
  completedAt: string | null;
  createdBy: { id: string; name: string };
};

type RawDetail = RawSummary & {
  resolvedAt: string | null;
  failure: { code: string; message: string } | null;
  reviewItems: Array<{
    id: string;
    rowLabel: string;
    fieldName: string;
    differenceAmount: string | null;
    status: string;
    message: string;
    suggestion: string | null;
    payload: Record<string, unknown>;
  }>;
  progressLogs?: ReconciliationProcessLog[];
};

type RawReviewListRow = {
  task: {
    id: string;
    name: string | null;
    status: string;
    periodLabel: string | null;
  };
  item: {
    id: string;
    rowLabel: string;
    fieldName: string;
    settlementValue: string | null;
    erpValue: string | null;
    differenceAmount: string | null;
    status: string;
    message: string;
    suggestion: string | null;
  };
};

type RawReviewListResponse = {
  items: RawReviewListRow[];
  page: number;
  pageSize: number;
  hasMore: boolean;
};

type RawListResponse = {
  items: RawSummary[];
  page: number;
  pageSize: number;
  total: number;
  facets: {
    total: number;
    byStatus: Record<string, number>;
  };
};

function toSummary(raw: RawSummary): ReconciliationTaskSummary {
  return {
    id: raw.id,
    name: raw.name,
    status: statusFromString(raw.status),
    periodLabel: raw.periodLabel,
    settlementFile: {
      id: raw.settlementFile.id,
      name: raw.settlementFile.name,
      size: raw.settlementFile.size,
      type: "",
      extension: null,
      uploadedAt: raw.createdAt,
    },
    erpFile: {
      id: raw.erpFile.id,
      name: raw.erpFile.name,
      size: raw.erpFile.size,
      type: "",
      extension: null,
      uploadedAt: raw.createdAt,
    },
    metrics: {
      settlementAmount: money(raw.metrics.settlementAmount),
      erpAmount: money(raw.metrics.erpAmount),
      differenceAmount: money(raw.metrics.differenceAmount),
      totalCount: null,
      matchedCount: null,
      differenceCount: null,
    },
    createdAt: raw.createdAt,
    completedAt: raw.completedAt,
    createdBy: raw.createdBy,
  };
}

function toDetail(raw: RawDetail): ReconciliationTaskDetail {
  const summary = toSummary(raw as unknown as RawSummary);
  return {
    ...summary,
    failure: raw.failure,
    progressLogs: raw.progressLogs ?? [],
    reviewItems: raw.reviewItems.map((item) => {
      const settlementValue = payloadMoney(item.payload?.settlementValue)
        ?? payloadMoney(item.payload?.settlementAmount);
      const erpValue = payloadMoney(item.payload?.erpValue)
        ?? payloadMoney(item.payload?.erpAmount);
      return {
        id: item.id,
        rowLabel: item.rowLabel,
        fieldName: item.fieldName,
        settlementValue,
        erpValue,
        differenceAmount: money(item.differenceAmount),
        message: item.message || (typeof item.payload?.message === "string" ? item.payload.message : ""),
        suggestion: item.suggestion ?? null,
        status: item.status as ReconciliationReviewItem["status"],
      };
    }),
  };
}

function toReviewRow(raw: RawReviewListRow): ReconciliationReviewRow {
  return {
    task: {
      id: raw.task.id,
      name: raw.task.name,
      status: statusFromString(raw.task.status),
      periodLabel: raw.task.periodLabel,
    },
    item: {
      id: raw.item.id,
      rowLabel: raw.item.rowLabel,
      fieldName: raw.item.fieldName,
      settlementValue: money(raw.item.settlementValue),
      erpValue: money(raw.item.erpValue),
      differenceAmount: money(raw.item.differenceAmount),
      message: raw.item.message,
      suggestion: raw.item.suggestion,
      status: raw.item.status as ReconciliationReviewItem["status"],
    },
  };
}

export class HttpReconciliationApi implements ReconciliationApi {
  private readonly baseUrl: string;

  constructor(config: HttpConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const method = (init?.method ?? "GET").toUpperCase();
    const retryDelays = method === "GET" ? startupRetryDelaysMs : [];
    let response: Response | undefined;

    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      try {
        response = await fetch(`${this.baseUrl}${path}`, {
          ...init,
          headers: {
            Accept: "application/json",
            ...(init?.body ? { "Content-Type": "application/json" } : {}),
            ...(init?.headers ?? {}),
          },
        });
        break;
      } catch {
        if (attempt >= retryDelays.length) {
          throw new ReconciliationApiError("暂时无法连接对账后端", "NETWORK_ERROR");
        }
        await wait(retryDelays[attempt]);
      }
    }

    if (!response) throw new ReconciliationApiError("暂时无法连接对账后端", "NETWORK_ERROR");
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // 非 JSON 响应
    }

    if (!response.ok) {
      const errorPayload = payload as { error?: { code?: string; message?: string; requestId?: string } } | null;
      throw new ReconciliationApiError(
        errorPayload?.error?.message ?? `请求失败（HTTP ${response.status}）`,
        errorPayload?.error?.code ?? "HTTP_REQUEST_FAILED",
        errorPayload?.error?.requestId,
        response.status,
      );
    }

    const envelope = payload as { data: T } | null;
    return envelope?.data as T;
  }

  async createTask(input: CreateReconciliationTaskInput): Promise<ReconciliationTaskSummary> {
    const agentName = input.agentSelector.name.trim();
    if (!agentName) {
      throw new ReconciliationApiError("请填写 Agent 名称", "AGENT_NAME_REQUIRED", undefined, 400);
    }

    const formData = new FormData();
    formData.append("settlementFile", input.settlementFile);
    if (input.erpFile) formData.append("erpFile", input.erpFile);
    formData.append("agentName", agentName);
    if (input.agentSelector.workspace) formData.append("agentWorkspace", input.agentSelector.workspace);

    input.onProgress?.({
      id: `local:${crypto.randomUUID()}`,
      timestamp: new Date().toISOString(),
      level: "info",
      message: "正在上传文件并创建对账任务…",
    });

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/tasks`, {
        method: "POST",
        body: formData,
      });
    } catch {
      throw new ReconciliationApiError("暂时无法连接对账后端", "NETWORK_ERROR");
    }

    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // ignore
    }

    if (!response.ok) {
      const errorPayload = payload as { error?: { code?: string; message?: string; requestId?: string } } | null;
      input.onProgress?.({
        id: `local:${crypto.randomUUID()}`,
        timestamp: new Date().toISOString(),
        level: "error",
        message: errorPayload?.error?.message ?? `创建任务失败（HTTP ${response.status}）`,
      });
      throw new ReconciliationApiError(
        errorPayload?.error?.message ?? `创建任务失败（HTTP ${response.status}）`,
        errorPayload?.error?.code ?? "CREATE_TASK_FAILED",
        errorPayload?.error?.requestId,
        response.status,
      );
    }

    // 返回 202 + taskId + 日志
    const envelope = payload as {
      data?: {
        taskId?: string;
        status?: string;
        logs?: ReconciliationProcessLog[];
      };
    } | null;

    const logs = envelope?.data?.logs ?? [];
    for (const log of logs) {
      input.onProgress?.(log);
    }

    const taskId = envelope?.data?.taskId;
    if (!taskId) {
      throw new ReconciliationApiError(
        "后端已响应，但没有返回任务 ID",
        "INVALID_CREATE_TASK_RESPONSE",
        undefined,
        response.status,
      );
    }

    // 需要返回 ReconciliationTaskSummary，但异步对账还没完成。
    // 这里返回一个 PROCESSING 的占位摘要，后续靠轮询 getTask 获取真实状态。
    const placeholder: ReconciliationTaskSummary = {
      id: taskId,
      name: null,
      status: "PROCESSING",
      periodLabel: null,
      settlementFile: {
        id: "pending",
        name: input.settlementFile.name,
        size: input.settlementFile.size,
        type: input.settlementFile.type,
        extension: null,
        uploadedAt: new Date().toISOString(),
      },
      erpFile: {
        id: input.erpFile ? "pending" : "feishu-erp-base",
        name: input.erpFile?.name ?? "飞书ERP明细表",
        size: input.erpFile?.size ?? 0,
        type: input.erpFile?.type ?? "",
        extension: null,
        uploadedAt: new Date().toISOString(),
      },
      metrics: {
        settlementAmount: null,
        erpAmount: null,
        differenceAmount: null,
        totalCount: null,
        matchedCount: null,
        differenceCount: null,
      },
      createdAt: new Date().toISOString(),
      completedAt: null,
      createdBy: { id: "system", name: "CherryStudio Agent" },
    };

    return placeholder;
  }

  async precheckBatch(input: PrecheckBatchInput): Promise<BatchPrecheckResult> {
    if (!input.settlementFiles.length) {
      throw new ReconciliationApiError("请至少选择一份结算资料", "MISSING_FILES", undefined, 400);
    }

    const formData = new FormData();
    for (const file of input.settlementFiles) {
      formData.append("settlementFiles", file, (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name);
    }
    if (input.erpFile) formData.append("erpFile", input.erpFile);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/batches`, {
        method: "POST",
        body: formData,
      });
    } catch {
      throw new ReconciliationApiError("暂时无法连接对账后端", "NETWORK_ERROR");
    }

    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // ignore
    }

    if (!response.ok) {
      const errorPayload = payload as { error?: { code?: string; message?: string; requestId?: string } } | null;
      throw new ReconciliationApiError(
        errorPayload?.error?.message ?? `批量预检失败（HTTP ${response.status}）`,
        errorPayload?.error?.code ?? "BATCH_PRECHECK_FAILED",
        errorPayload?.error?.requestId,
        response.status,
      );
    }

    const envelope = payload as { data?: BatchPrecheckResult } | null;
    if (!envelope?.data) {
      throw new ReconciliationApiError("后端已响应，但没有返回批量预检结果", "INVALID_BATCH_PRECHECK_RESPONSE");
    }
    return envelope.data;
  }

  async getBatch(batchId: string): Promise<BatchPrecheckResult> {
    return this.request<BatchPrecheckResult>(`/api/batches/${encodeURIComponent(batchId)}`);
  }

  async createBatchTasks(input: CreateBatchReconciliationTasksInput): Promise<BatchReconciliationTaskCreateResult> {
    if (!input.batchId) {
      throw new ReconciliationApiError("缺少批处理 ID", "BATCH_ID_REQUIRED", undefined, 400);
    }
    const agentName = input.agentSelector.name.trim();
    if (!agentName) {
      throw new ReconciliationApiError("请填写 Agent 名称", "AGENT_NAME_REQUIRED", undefined, 400);
    }

    input.onProgress?.({
      id: `local:${crypto.randomUUID()}`,
      timestamp: new Date().toISOString(),
      level: "info",
      message: `正在执行批处理 ${input.batchId} 的可执行单据…`,
    });

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/batches/${encodeURIComponent(input.batchId)}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentName,
          agentWorkspace: input.agentSelector.workspace ?? "",
        }),
      });
    } catch {
      throw new ReconciliationApiError("暂时无法连接对账后端", "NETWORK_ERROR");
    }

    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // ignore
    }

    if (!response.ok) {
      const errorPayload = payload as { error?: { code?: string; message?: string; requestId?: string } } | null;
      const message = errorPayload?.error?.message ?? `批量创建任务失败（HTTP ${response.status}）`;
      input.onProgress?.({
        id: `local:${crypto.randomUUID()}`,
        timestamp: new Date().toISOString(),
        level: "error",
        message,
      });
      throw new ReconciliationApiError(
        message,
        errorPayload?.error?.code ?? "CREATE_BATCH_TASKS_FAILED",
        errorPayload?.error?.requestId,
        response.status,
      );
    }

    const envelope = payload as { data?: BatchReconciliationTaskCreateResult } | null;
    if (!envelope?.data) {
      throw new ReconciliationApiError("后端已响应，但没有返回批量任务结果", "INVALID_CREATE_BATCH_TASKS_RESPONSE");
    }

    for (const item of envelope.data.items) {
      for (const log of item.logs ?? []) {
        input.onProgress?.({
          ...log,
          id: `${item.taskId ?? item.fileName}:${log.id}`,
          message: `[${item.fileName}] ${log.message}`,
        });
      }
      if (item.error) {
        input.onProgress?.({
          id: `local:${crypto.randomUUID()}`,
          timestamp: new Date().toISOString(),
          level: "error",
          message: `[${item.fileName}] ${item.error.message}`,
        });
      }
    }

    return envelope.data;
  }

  async updateBatchDocumentIdentity(documentId: string, input: UpdateBatchDocumentIdentityInput): Promise<BatchPrecheckResult> {
    return this.request<BatchPrecheckResult>(`/api/batches/documents/${encodeURIComponent(documentId)}/identity`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  async selectBatchDocumentAmount(documentId: string, input: SelectBatchDocumentAmountInput): Promise<BatchPrecheckResult> {
    return this.request<BatchPrecheckResult>(`/api/batches/documents/${encodeURIComponent(documentId)}/amount`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  async exportBatchCsv(batchId: string): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/batches/${encodeURIComponent(batchId)}/export`);
    } catch {
      throw new ReconciliationApiError("暂时无法连接对账后端", "NETWORK_ERROR");
    }
    if (!response.ok) {
      throw new ReconciliationApiError(`导出失败（HTTP ${response.status}）`, "BATCH_EXPORT_FAILED", undefined, response.status);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${batchId}-batch-export.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async listErpRecords(params: ListErpRecordsParams = {}): Promise<PaginatedErpRecords> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") query.set(key, String(value));
    }
    return this.request<PaginatedErpRecords>(`/api/erp?${query.toString()}`);
  }

  async getErpFilterOptions(): Promise<ErpFilterOptions> {
    return this.request<ErpFilterOptions>("/api/erp/options");
  }

  async createErpRecord(input: ErpRecordInput): Promise<ErpRecord> {
    return this.request<ErpRecord>("/api/erp", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async updateErpRecord(recordId: string, input: ErpRecordInput): Promise<ErpRecord> {
    return this.request<ErpRecord>(`/api/erp/${encodeURIComponent(recordId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  async batchUpdateErpRecords(input: BatchUpdateErpRecordsInput): Promise<BatchUpdateErpRecordsResult> {
    return this.request<BatchUpdateErpRecordsResult>("/api/erp/batch-update", {
      method: "POST",
      body: JSON.stringify({ items: input }),
    });
  }

  async deleteErpRecord(recordId: string): Promise<{ deleted: boolean; record: ErpRecord }> {
    return this.request<{ deleted: boolean; record: ErpRecord }>(`/api/erp/${encodeURIComponent(recordId)}`, {
      method: "DELETE",
    });
  }

  async importErpFile(input: ImportErpFileInput): Promise<ErpImportResult> {
    const formData = new FormData();
    formData.append("erpFile", input.file);
    formData.append("mode", input.mode);
    if (input.month) formData.append("month", input.month);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/erp/import`, {
        method: "POST",
        body: formData,
      });
    } catch {
      throw new ReconciliationApiError("暂时无法连接对账后端", "NETWORK_ERROR");
    }

    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // ignore
    }

    if (!response.ok) {
      const errorPayload = payload as { error?: { code?: string; message?: string; requestId?: string } } | null;
      throw new ReconciliationApiError(
        errorPayload?.error?.message ?? `ERP 总表更新失败（HTTP ${response.status}）`,
        errorPayload?.error?.code ?? "ERP_IMPORT_FAILED",
        errorPayload?.error?.requestId,
        response.status,
      );
    }

    const envelope = payload as { data?: ErpImportResult } | null;
    if (!envelope?.data) {
      throw new ReconciliationApiError("后端已响应，但没有返回 ERP 导入结果", "INVALID_ERP_IMPORT_RESPONSE");
    }
    return envelope.data;
  }

  async listTasks(params: ListReconciliationTasksParams = {}): Promise<PaginatedTasks> {
    const query = new URLSearchParams();
    if (params.status?.length) query.set("status", params.status.join(","));
    if (params.keyword) query.set("keyword", params.keyword);
    if (params.page) query.set("page", String(params.page));
    if (params.pageSize) query.set("pageSize", String(params.pageSize));

    const raw = await this.request<RawListResponse>(`/api/tasks?${query.toString()}`);

    const byStatus = {} as Record<ReconciliationStatus, number>;
    const statuses: ReconciliationStatus[] = ["QUEUED", "PROCESSING", "SUCCEEDED", "NEEDS_REVIEW", "REVIEWED", "FAILED", "CANCELLED", "OBSOLETE"];
    for (const s of statuses) byStatus[s] = raw.facets.byStatus[s] ?? 0;

    return {
      items: raw.items.map(toSummary),
      page: raw.page,
      pageSize: raw.pageSize,
      total: raw.total,
      facets: { total: raw.facets.total, byStatus },
    };
  }

  async listReviewItems(): Promise<ReconciliationReviewRow[]> {
    const rows: ReconciliationReviewRow[] = [];
    for (let page = 1; ; page += 1) {
      const query = new URLSearchParams({
        page: String(page),
        pageSize: "200",
        status: "PENDING,APPROVED,IGNORED",
      });
      const raw = await this.request<RawReviewListResponse>(`/api/tasks/review-items?${query.toString()}`);
      rows.push(...raw.items.map(toReviewRow));
      if (!raw.hasMore) break;
    }
    return rows;
  }

  async getTask(taskId: string): Promise<ReconciliationTaskDetail> {
    const raw = await this.request<RawDetail>(`/api/tasks/${encodeURIComponent(taskId)}`);
    return toDetail(raw);
  }

  async stopTask(taskId: string): Promise<void> {
    await this.request<{ stopped: boolean; sessionStopped: boolean }>(
      `/api/tasks/${encodeURIComponent(taskId)}/stop`,
      { method: "POST" },
    );
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.request<{ deleted: boolean; fileCleanupWarnings?: string[] }>(
      `/api/tasks/${encodeURIComponent(taskId)}`,
      { method: "DELETE" },
    );
  }

  async updateReviewItem(taskId: string, itemId: string, status: ReviewItemStatus) {
    const result = await this.request<{ task: RawDetail }>(
      `/api/tasks/${encodeURIComponent(taskId)}/review-items/${encodeURIComponent(itemId)}`,
      { method: "PATCH", body: JSON.stringify({ status }) },
    );
    return toDetail(result.task);
  }

  async getStatistics(month?: string): Promise<ReconciliationStatistics> {
    const query = month ? `?month=${month}` : "";
    const raw = await this.request<ReconciliationStatistics>(`/api/statistics${query}`);
    return {
      ...raw,
      totalDifferenceAmount: money(raw.totalDifferenceAmount as unknown as string) ?? { currency: "CNY", value: "0" },
    };
  }
}
