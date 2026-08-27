// 文件说明：集中定义对账任务、金额、上传文件、审核字段等业务类型。
export type ReconciliationStatus =
  | "QUEUED"
  | "PROCESSING"
  | "SUCCEEDED"
  | "NEEDS_REVIEW"
  | "REVIEWED"
  | "FAILED"
  | "CANCELLED"
  | "OBSOLETE";

export type Money = {
  currency: "CNY";
  value: string;
};

export type UploadedFile = {
  id: string;
  name: string;
  size: number;
  type: string;
  extension: string | null;
  uploadedAt: string;
};

export type ReconciliationMetrics = {
  settlementAmount: Money | null;
  erpAmount: Money | null;
  differenceAmount: Money | null;
  totalCount: number | null;
  matchedCount: number | null;
  differenceCount: number | null;
};

export type ReviewItemStatus = "PENDING" | "APPROVED" | "IGNORED";

export type ReconciliationReviewItem = {
  id: string;
  rowLabel: string;
  fieldName: string;
  settlementValue: Money | null;
  erpValue: Money | null;
  differenceAmount: Money | null;
  message: string;
  suggestion: string | null;
  status: ReviewItemStatus;
};

export type ReconciliationTaskSummary = {
  id: string;
  name: string | null;
  status: ReconciliationStatus;
  periodLabel: string | null;
  settlementFile: UploadedFile;
  erpFile: UploadedFile;
  metrics: ReconciliationMetrics;
  createdAt: string;
  completedAt: string | null;
  createdBy: {
    id: string;
    name: string;
  };
};

export type ReconciliationTaskDetail = ReconciliationTaskSummary & {
  reviewItems: ReconciliationReviewItem[];
  progressLogs?: ReconciliationProcessLog[];
  failure: {
    code: string;
    message: string;
  } | null;
};

export type ReconciliationStatistics = {
  month: string;
  totalTasks: number;
  succeededTasks: number;
  needsReviewTasks: number;
  failedTasks: number;
  processingTasks: number;
  reviewedTasks?: number;
  autoMatchRate: number;
  monthOverMonthRate: number;
  totalDifferenceAmount: Money;
  trend: Array<{
    label: string;
    taskCount: number;
  }>;
  updatedAt: string;
};

export type ReconciliationProcessLogLevel = "info" | "success" | "error";

export type ReconciliationProcessLog = {
  id: string;
  timestamp: string;
  level: ReconciliationProcessLogLevel;
  message: string;
  details?: string;
  expanded?: boolean;
};

export type ReconciliationProgressListener = (log: ReconciliationProcessLog) => void;

export type CreateReconciliationTaskInput = {
  settlementFile: File;
  erpFile?: File;
  agentSelector: {
    name: string;
    workspace?: string;
  };
  onProgress?: ReconciliationProgressListener;
};

export type CreateBatchReconciliationTasksInput = {
  batchId: string;
  agentSelector: {
    name: string;
    workspace?: string;
  };
  onProgress?: ReconciliationProgressListener;
};

export type PrecheckBatchInput = {
  settlementFiles: File[];
  erpFile?: File;
};

export type BatchPrecheckItemStatus = "READY" | "NEEDS_REVIEW" | "REJECTED" | "DUPLICATE" | "PROCESSING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export type BatchAmountCandidate = {
  id: string;
  label: string;
  amount: number;
  priority: number;
  row: number;
  column: number;
};

export type BatchPrecheckItem = {
  documentId: string;
  groupId: string | null;
  version: number;
  fileName: string;
  sourceFileName: string | null;
  size: number;
  sha256: string | null;
  shopCodes: string[];
  shopNo: string | null;
  period: string | null;
  documentNo: string | null;
  documentRange: string | null;
  amountCandidateCount: number;
  amountCandidates: BatchAmountCandidate[];
  confirmedCandidateId: string | null;
  confirmedSettlementAmount: number | null;
  confirmedSettlementLabel: string | null;
  erpRows: number | null;
  erpSalesTotal: number | null;
  status: BatchPrecheckItemStatus;
  issues: string[];
  taskId?: string | null;
};

export type BatchGroupSummary = {
  id: string;
  key: string;
  shopNo: string;
  period: string;
  documentIds: string[];
  documentCount: number;
  status: BatchPrecheckItemStatus | "PROCESSING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  taskId: string | null;
  settlementAmount: number | null;
  erpSalesTotal: number | null;
  differenceAmount: number | null;
  version: number;
  issues: string[];
};

export type BatchPrecheckResult = {
  batchId: string;
  status: "DRAFT" | "READY" | "PROCESSING" | "NEEDS_REVIEW" | "COMPLETED" | "FAILED" | "CANCELLED";
  totalFiles: number;
  totalSize: number;
  validFiles: number;
  executableFiles: number;
  executableGroups: number;
  rejectedFiles: number;
  duplicateFiles: number;
  maxFiles: number;
  maxTotalSize: number;
  createdAt: string;
  updatedAt: string;
  groups: BatchGroupSummary[];
  items: BatchPrecheckItem[];
};

export type BatchReconciliationTaskCreateItem = {
  fileName: string;
  groupId?: string;
  taskId: string | null;
  status: "PROCESSING" | "REJECTED" | "FAILED";
  error: { code: string; message: string } | null;
  logs: ReconciliationProcessLog[];
};

export type BatchReconciliationTaskCreateResult = {
  batchId?: string;
  total: number;
  created: number;
  rejected: number;
  failed: number;
  items: BatchReconciliationTaskCreateItem[];
};

export type UpdateBatchDocumentIdentityInput = {
  shopNo?: string;
  period?: string;
};

export type SelectBatchDocumentAmountInput = {
  candidateId?: string;
  amount?: number;
  label?: string;
};

export type ErpImportMode = "preview" | "append" | "replace";

export type ErpSortField = "month" | "shopNo" | "deductionRate" | "salesAmount";
export type ErpSortDirection = "asc" | "desc";

export type ErpRecord = {
  id: string;
  shopNo: string;
  deductionRate: number;
  salesAmount: number;
  month: string;
};

export type ErpRecordInput = Omit<ErpRecord, "id">;

export type ListErpRecordsParams = {
  page?: number;
  pageSize?: number;
  month?: string;
  shopNo?: string;
  keyword?: string;
  sortField?: ErpSortField;
  sortDirection?: ErpSortDirection;
};

export type PaginatedErpRecords = {
  items: ErpRecord[];
  page: number;
  pageSize: number;
  total: number;
};

export type ErpFilterOptions = {
  months: string[];
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
  sampleRows: Array<{
    shopNo: string;
    deductionRate: number;
    salesAmount: number;
    month: string;
    sourceRow?: number;
  }>;
};

export type ErpImportResult = {
  mode: ErpImportMode;
  fileName: string;
  months: ErpImportMonthSummary[];
  totalRows: number;
  written: boolean;
  failedRows: Array<{ row: number; reason: string }>;
};

export type ImportErpFileInput = {
  file: File;
  mode: ErpImportMode;
  month?: string;
};

export type BatchUpdateErpRecordsInput = Array<{ id: string; values: ErpRecordInput }>;

export type BatchUpdateErpRecordsResult = {
  items: Array<{
    id: string;
    success: boolean;
    record: ErpRecord | null;
    error: string | null;
  }>;
};

export type ListReconciliationTasksParams = {
  status?: ReconciliationStatus[];
  keyword?: string;
  page?: number;
  pageSize?: number;
};

export type PaginatedTasks = {
  items: ReconciliationTaskSummary[];
  page: number;
  pageSize: number;
  total: number;
  facets: {
    total: number;
    byStatus: Record<ReconciliationStatus, number>;
  };
};

export type ApiEnvelope<T> = {
  data: T;
  requestId: string;
};

export type ApiErrorPayload = {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
};
