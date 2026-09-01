// 文件说明：把对账业务数据转换成页面更容易展示的文字、金额和状态标签。
import { ReconciliationApiError } from "../api/error";
import type {
  Money,
  ReconciliationStatus,
  ReconciliationTaskSummary,
} from "./types";

export type DisplayStatus = "success" | "issue" | "reviewed" | "failed" | "processing" | "cancelled" | "obsolete";
export type ReconciliationFilter = "all" | DisplayStatus;

export type ReconciliationView = {
  id: string;
  name: string;
  period: string;
  settlement: string;
  erp: string;
  amount: string;
  matched: string;
  variance: string;
  status: DisplayStatus;
  time: string;
  owner: string;
  failure?: string | null;
};

export const statusLabels: Record<DisplayStatus, string> = {
  success: "对账成功",
  issue: "存在差异",
  reviewed: "已复核",
  failed: "对账失败",
  processing: "对账中",
  cancelled: "已停止",
  obsolete: "已作废",
};

export const statusFilters: Record<Exclude<ReconciliationFilter, "all">, ReconciliationStatus[]> = {
  success: ["SUCCEEDED"],
  issue: ["NEEDS_REVIEW"],
  reviewed: ["REVIEWED"],
  failed: ["FAILED"],
  processing: ["QUEUED", "PROCESSING"],
  cancelled: ["CANCELLED"],
  obsolete: ["OBSOLETE"],
};

export function displayStatus(status: ReconciliationStatus): DisplayStatus {
  if (status === "SUCCEEDED") return "success";
  if (status === "NEEDS_REVIEW") return "issue";
  if (status === "REVIEWED") return "reviewed";
  if (status === "FAILED") return "failed";
  if (status === "CANCELLED") return "cancelled";
  if (status === "OBSOLETE") return "obsolete";
  return "processing";
}

export function formatMoney(value: Money | null, pendingLabel = "—") {
  if (!value) return pendingLabel;
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: value.currency,
    minimumFractionDigits: 2,
  }).format(Number(value.value));
}

export function formatTaskTime(value: string) {
  const date = new Date(value);
  if (Date.now() - date.getTime() < 120_000) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date).replace("/", "月").replace(",", "日");
}

export function toViewModel(task: ReconciliationTaskSummary): ReconciliationView {
  const isPending = task.status === "QUEUED" || task.status === "PROCESSING";
  const total = task.metrics.totalCount;
  const matched = task.metrics.matchedCount;
  return {
    id: task.id,
    name: task.name?.trim() || task.settlementFile.name.replace(/\.[^.]+$/, "") || "未命名对账",
    period: task.periodLabel ?? "账期待识别",
    settlement: task.settlementFile.name,
    erp: task.erpFile.name,
    amount: formatMoney(task.metrics.settlementAmount, isPending ? "待计算" : "—"),
    matched: total === null || matched === null ? (isPending ? "正在解析" : "—") : `${matched.toLocaleString()} / ${total.toLocaleString()}`,
    variance: task.metrics.scopeMismatch ? "范围不可比" : formatMoney(task.metrics.differenceAmount),
    status: displayStatus(task.status),
    time: formatTaskTime(task.createdAt),
    owner: task.createdBy.name,
  };
}

export function requestErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ReconciliationApiError) {
    return `${error.message}${error.requestId ? `（请求编号：${error.requestId}）` : ""}`;
  }
  return error instanceof Error ? error.message : fallback;
}
