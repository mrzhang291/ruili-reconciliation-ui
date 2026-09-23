// 文件说明：定义前端统一使用的对账 API 方法形状。
import type {
  BatchPrecheckResult,
  BatchReconciliationTaskCreateResult,
  CreateReconciliationTaskInput,
  CreateBatchReconciliationTasksInput,
  BatchUpdateErpRecordsInput,
  BatchUpdateErpRecordsResult,
  ErpFilterOptions,
  ErpImportResult,
  ErpRecord,
  ErpRecordInput,
  ImportErpFileInput,
  PrecheckBatchInput,
  SelectBatchDocumentAmountInput,
  UpdateBatchDocumentIdentityInput,
  ListErpRecordsParams,
  ListReconciliationTasksParams,
  PaginatedErpRecords,
  PaginatedTasks,
  ReconciliationStatistics,
  ReconciliationReviewRow,
  ReconciliationReviewWorklistRow,
  ReconciliationTaskDetail,
  ReconciliationTaskSummary,
  ReviewItemStatus,
} from "../model/types";

export type ReviewExportFilters = {
  region?: string;
  status?: ReviewItemStatus;
  differenceMin?: number;
  differenceMax?: number;
};

export interface ReconciliationApi {
  createTask(input: CreateReconciliationTaskInput): Promise<ReconciliationTaskSummary>;
  precheckBatch(input: PrecheckBatchInput): Promise<BatchPrecheckResult>;
  getBatch(batchId: string): Promise<BatchPrecheckResult>;
  createBatchTasks(input: CreateBatchReconciliationTasksInput): Promise<BatchReconciliationTaskCreateResult>;
  updateBatchDocumentIdentity(documentId: string, input: UpdateBatchDocumentIdentityInput): Promise<BatchPrecheckResult>;
  selectBatchDocumentAmount(documentId: string, input: SelectBatchDocumentAmountInput): Promise<BatchPrecheckResult>;
  exportBatchCsv(batchId: string): Promise<void>;
  exportReviewCsv(filters?: ReviewExportFilters): Promise<void>;
  listErpRecords(params?: ListErpRecordsParams): Promise<PaginatedErpRecords>;
  getErpFilterOptions(): Promise<ErpFilterOptions>;
  createErpRecord(input: ErpRecordInput): Promise<ErpRecord>;
  updateErpRecord(recordId: string, input: ErpRecordInput): Promise<ErpRecord>;
  batchUpdateErpRecords(input: BatchUpdateErpRecordsInput): Promise<BatchUpdateErpRecordsResult>;
  deleteErpRecord(recordId: string): Promise<{ deleted: boolean; record: ErpRecord }>;
  importErpFile(input: ImportErpFileInput): Promise<ErpImportResult>;
  listTasks(params?: ListReconciliationTasksParams): Promise<PaginatedTasks>;
  listReviewItems(): Promise<ReconciliationReviewRow[]>;
  listReviewWorklist(): Promise<ReconciliationReviewWorklistRow[]>;
  getTask(taskId: string): Promise<ReconciliationTaskDetail>;
  stopTask(taskId: string): Promise<void>;
  deleteTask(taskId: string): Promise<void>;
  updateReviewItem(taskId: string, itemId: string, status: ReviewItemStatus): Promise<ReconciliationTaskDetail>;
  getStatistics(month?: string): Promise<ReconciliationStatistics>;
}
