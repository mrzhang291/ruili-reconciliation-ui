// 文件说明：CherryStudio 地址未配置时使用的空接口，避免前端误造假数据。
import { ReconciliationApiError } from "./error";
import type { ReconciliationApi } from "./types";
import type {
  PrecheckBatchInput,
  BatchPrecheckResult,
  CreateBatchReconciliationTasksInput,
  CreateReconciliationTaskInput,
  BatchUpdateErpRecordsInput,
  ListReconciliationTasksParams,
  Money,
  ReconciliationStatus,
  ReconciliationTaskSummary,
  ReconciliationTaskDetail,
  ReviewItemStatus,
  SelectBatchDocumentAmountInput,
  UpdateBatchDocumentIdentityInput,
} from "../model/types";
import type { ErpRecordInput, ListErpRecordsParams } from "../model/types";

const money = (value: string): Money => ({ currency: "CNY", value });
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const disabledTasks: ReconciliationTaskSummary[] = [];

export class DisabledReconciliationApi implements ReconciliationApi {
  async createTask(input: CreateReconciliationTaskInput): Promise<ReconciliationTaskSummary> {
    void input;
    await wait(120);
    throw new ReconciliationApiError(
      "未配置真实后端接口，无法创建对账任务",
      "API_BASE_URL_REQUIRED",
      "local-no-api",
      503,
    );
  }

  async precheckBatch(input: PrecheckBatchInput): Promise<BatchPrecheckResult> {
    void input;
    await wait(120);
    throw new ReconciliationApiError(
      "未配置真实后端接口，无法执行批量预检",
      "API_BASE_URL_REQUIRED",
      "local-no-api",
      503,
    );
  }

  async createBatchTasks(input: CreateBatchReconciliationTasksInput): Promise<never> {
    void input;
    await wait(120);
    throw new ReconciliationApiError(
      "未配置真实后端接口，无法批量创建对账任务",
      "API_BASE_URL_REQUIRED",
      "local-no-api",
      503,
    );
  }

  async getBatch(batchId: string): Promise<never> {
    void batchId;
    await wait(120);
    throw new ReconciliationApiError(
      "未配置真实后端接口，无法读取批量对账批次",
      "API_BASE_URL_REQUIRED",
      "local-no-api",
      503,
    );
  }

  async updateBatchDocumentIdentity(documentId: string, input: UpdateBatchDocumentIdentityInput): Promise<never> {
    void documentId;
    void input;
    await wait(120);
    throw new ReconciliationApiError("未配置真实后端接口，无法更新批量单据身份", "API_BASE_URL_REQUIRED", "local-no-api", 503);
  }

  async selectBatchDocumentAmount(documentId: string, input: SelectBatchDocumentAmountInput): Promise<never> {
    void documentId;
    void input;
    await wait(120);
    throw new ReconciliationApiError("未配置真实后端接口，无法确认批量单据金额", "API_BASE_URL_REQUIRED", "local-no-api", 503);
  }

  async exportBatchCsv(batchId: string): Promise<never> {
    void batchId;
    await wait(120);
    throw new ReconciliationApiError("未配置真实后端接口，无法导出批量对账", "API_BASE_URL_REQUIRED", "local-no-api", 503);
  }

  async importErpFile(): Promise<never> {
    await wait(120);
    throw new ReconciliationApiError(
      "未配置真实后端接口，无法更新 ERP 总表",
      "API_BASE_URL_REQUIRED",
      "local-no-api",
      503,
    );
  }

  async listErpRecords(params: ListErpRecordsParams = {}) {
    void params;
    await wait(120);
    return { items: [], page: 1, pageSize: 50, total: 0 };
  }

  async getErpFilterOptions() {
    await wait(120);
    return { months: [] };
  }

  async createErpRecord(input: ErpRecordInput): Promise<never> {
    void input;
    await wait(120);
    throw new ReconciliationApiError("未配置真实后端接口，无法新增 ERP 明细", "API_BASE_URL_REQUIRED", "local-no-api", 503);
  }

  async updateErpRecord(recordId: string, input: ErpRecordInput): Promise<never> {
    void input;
    await wait(120);
    throw new ReconciliationApiError(`未配置真实后端接口，无法更新 ERP 明细 ${recordId}`, "API_BASE_URL_REQUIRED", "local-no-api", 503);
  }

  async batchUpdateErpRecords(input: BatchUpdateErpRecordsInput): Promise<never> {
    void input;
    await wait(120);
    throw new ReconciliationApiError("未配置真实后端接口，无法批量保存 ERP 明细", "API_BASE_URL_REQUIRED", "local-no-api", 503);
  }

  async deleteErpRecord(recordId: string): Promise<never> {
    await wait(120);
    throw new ReconciliationApiError(`未配置真实后端接口，无法删除 ERP 明细 ${recordId}`, "API_BASE_URL_REQUIRED", "local-no-api", 503);
  }

  async listTasks(params: ListReconciliationTasksParams = {}) {
    await wait(120);
    const keyword = params.keyword?.trim().toLowerCase();
    const keywordMatches = disabledTasks.filter((task) => {
      return !keyword || [task.id, task.name ?? "", task.periodLabel ?? "", task.settlementFile.name, task.erpFile.name, task.createdBy.name]
        .some((value) => value.toLowerCase().includes(keyword));
    });
    const filtered = keywordMatches.filter((task) => !params.status?.length || params.status.includes(task.status));
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 20;
    const start = (page - 1) * pageSize;
    const byStatus = keywordMatches.reduce<Record<ReconciliationStatus, number>>(
      (counts, task) => ({ ...counts, [task.status]: counts[task.status] + 1 }),
      { QUEUED: 0, PROCESSING: 0, SUCCEEDED: 0, NEEDS_REVIEW: 0, REVIEWED: 0, FAILED: 0, CANCELLED: 0, OBSOLETE: 0 },
    );
    return {
      items: filtered.slice(start, start + pageSize),
      page,
      pageSize,
      total: filtered.length,
      facets: { total: keywordMatches.length, byStatus },
    };
  }

  async listReviewItems() {
    await wait(120);
    return [];
  }

  async getTask(taskId: string) {
    await wait(120);
    const task = disabledTasks.find((item) => item.id === taskId);
    if (!task) throw new ReconciliationApiError("未找到对账任务", "TASK_NOT_FOUND", "local-no-api", 404);
    return {
      ...task,
      reviewItems: [],
      failure: null,
    };
  }

  async deleteTask(taskId: string): Promise<void> {
    await wait(120);
    throw new ReconciliationApiError(
      `未配置真实后端接口，无法删除任务 ${taskId}`,
      "API_BASE_URL_REQUIRED",
      "local-no-api",
      503,
    );
  }

  async stopTask(taskId: string): Promise<void> {
    await wait(120);
    throw new ReconciliationApiError(
      `未配置真实后端接口，无法停止任务 ${taskId}`,
      "API_BASE_URL_REQUIRED",
      "local-no-api",
      503,
    );
  }

  async updateReviewItem(
    taskId: string,
    itemId: string,
    status: ReviewItemStatus,
  ): Promise<ReconciliationTaskDetail> {
    void itemId;
    void status;
    await wait(120);
    throw new ReconciliationApiError(
      `未配置真实后端接口，无法更新任务 ${taskId}`,
      "API_BASE_URL_REQUIRED",
      "local-no-api",
      503,
    );
  }

  async getStatistics(month = new Date().toISOString().slice(0, 7)) {
    await wait(120);
    const succeededTasks = disabledTasks.filter((task) => task.status === "SUCCEEDED").length;
    const needsReviewTasks = disabledTasks.filter((task) => task.status === "NEEDS_REVIEW").length;
    const failedTasks = disabledTasks.filter((task) => task.status === "FAILED").length;
    const processingTasks = disabledTasks.filter((task) => task.status === "QUEUED" || task.status === "PROCESSING").length;
    return {
      month,
      totalTasks: disabledTasks.length,
      succeededTasks,
      needsReviewTasks,
      failedTasks,
      processingTasks,
      autoMatchRate: disabledTasks.length ? succeededTasks / disabledTasks.length : 0,
      monthOverMonthRate: 0,
      totalDifferenceAmount: money("0.00"),
      trend: [],
      updatedAt: new Date().toISOString(),
    };
  }
}
