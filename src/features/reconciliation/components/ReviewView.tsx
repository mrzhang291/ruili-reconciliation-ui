// 文件说明：差异处理页面保留完整的差异记录和处理状态，作为唯一的状态处理入口。
import { useState } from "react";
import { reconciliationApi } from "../api";
import { useReviewItems } from "../hooks/use-review-items";
import type { ReviewItemStatus } from "../model/types";
import { formatMoney, requestErrorMessage } from "../model/view-model";

const reviewStatusLabels: Record<ReviewItemStatus, string> = {
  PENDING: "待确认",
  APPROVED: "已确认",
  IGNORED: "已暂不处理",
};

type ReviewStatusFilter = "全部" | ReviewItemStatus;

const reviewStatusFilters: Array<{ value: ReviewStatusFilter; label: string }> = [
  { value: "全部", label: "全部" },
  { value: "PENDING", label: "待确认" },
  { value: "IGNORED", label: "已暂不处理" },
  { value: "APPROVED", label: "已确认" },
];

function reviewRegion(shopNo: string | null) {
  const match = shopNo?.trim().match(/^[a-z]{2}/i);
  return match?.[0].toUpperCase() ?? "其他";
}

function inputNumber(value: string) {
  if (!value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function differenceNumber(value: Parameters<typeof formatMoney>[0]) {
  const number = Number(value?.value);
  return Number.isFinite(number) ? number : null;
}

export function ReviewView() {
  const {
    rows,
    reviewStatuses,
    pendingCount,
    reviewedCount,
    loading,
    error,
    errorTitle,
    communicationError,
    updatingItemIds,
    hasReviewStatusUpdates,
    isReviewStatusUpdating,
    setReviewStatus,
  } = useReviewItems();
  const [copiedTemplateId, setCopiedTemplateId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [region, setRegion] = useState("全部");
  const [statusFilter, setStatusFilter] = useState<ReviewStatusFilter>("全部");
  const [differenceMin, setDifferenceMin] = useState("");
  const [differenceMax, setDifferenceMax] = useState("");
  const regions = ["全部", ...Array.from(new Set(rows.map(({ task }) => reviewRegion(task.name)))).sort()];
  const min = inputNumber(differenceMin);
  const max = inputNumber(differenceMax);
  const differenceRangeError = min !== null && max !== null && min > max
    ? "计算差额下限不能大于上限，请调整后再导出。"
    : "";
  const filteredRows = rows.filter(({ task, item }) => {
    const difference = differenceNumber(item.differenceAmount);
    const status = reviewStatuses[item.id] ?? item.status;
    return (region === "全部" || reviewRegion(task.name) === region)
      && (statusFilter === "全部" || status === statusFilter)
      && (min === null || (difference !== null && difference >= min))
      && (max === null || (difference !== null && difference <= max));
  });
  const filtered = region !== "全部" || statusFilter !== "全部" || min !== null || max !== null;

  const exportReviewCsv = async () => {
    // The ref-backed guard also covers the short interval before React redraws a status-save button.
    if (differenceRangeError || isReviewStatusUpdating()) return;
    setExporting(true);
    setExportError("");
    try {
      await reconciliationApi.exportReviewCsv({
        // The interface keeps the customer-friendly label; the API uses a stable sentinel for it.
        region: region === "全部" ? undefined : region === "其他" ? "OTHER" : region,
        status: statusFilter === "全部" ? undefined : statusFilter,
        differenceMin: min ?? undefined,
        differenceMax: max ?? undefined,
      });
    } catch (requestError) {
      setExportError(requestErrorMessage(requestError, "差异事项导出失败"));
    } finally {
      setExporting(false);
    }
  };

  const copyCommunicationTemplate = async (itemId: string, template: string) => {
    setCopyError("");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(template);
      setCopiedTemplateId(itemId);
      window.setTimeout(() => {
        setCopiedTemplateId((current) => current === itemId ? null : current);
      }, 1800);
    } catch {
      setCopyError("无法自动复制，请展开话术后直接选中内容复制。");
    }
  };

  return (
    <div className="view-shell review-view">
      <div className="page-intro page-intro--split">
        <div>
          <span className="eyebrow">RECONCILIATION</span>
          <h1>差异处理</h1>
          <p>集中查看系统识别的差异，逐项核对结算单与 ERP 金额，并在此更新处理状态。</p>
        </div>
        <div className="review-summary">
          <span>待确认 <strong>{pendingCount}</strong></span>
          <span>已处理 <strong>{reviewedCount}</strong></span>
        </div>
      </div>

      {error && <div className="api-error overview-error" role="alert"><b>{errorTitle}</b><span>{error}</span></div>}
      {communicationError && <div className="review-communication-alert" role="status"><b>沟通话术暂未加载</b><span>差异仍可继续处理；{communicationError}</span></div>}
      {copyError && <div className="review-communication-alert" role="status"><b>复制未完成</b><span>{copyError}</span></div>}
      {exportError && <div className="api-error overview-error" role="alert"><b>差异事项导出失败</b><span>{exportError}</span></div>}

      <section className="records-section review-section">
        <div className="records-head">
          <div><h2>差异明细</h2><span>共 {filteredRows.length} 条字段差异{filtered && `（筛选前 ${rows.length} 条）`}</span></div>
          <button type="button" className="outline-button" disabled={loading || filteredRows.length === 0 || exporting || hasReviewStatusUpdates || Boolean(differenceRangeError)} onClick={() => void exportReviewCsv()}>{exporting ? "正在导出" : filtered ? `导出筛选结果（${filteredRows.length}）` : "导出差异报表"}</button>
        </div>
        <nav className="review-filter-bar" aria-label="差异筛选">
          <div className="review-filter-group">
            <span>地区</span>
            <div className="review-region-tabs">
              {regions.map((value) => <button key={value} type="button" className={region === value ? "active" : ""} onClick={() => setRegion(value)}>{value}</button>)}
            </div>
          </div>
          <div className="review-filter-group">
            <span>处理状态</span>
            <div className="review-region-tabs">
              {reviewStatusFilters.map(({ value, label }) => <button key={value} type="button" className={statusFilter === value ? "active" : ""} onClick={() => setStatusFilter(value)}>{label}</button>)}
            </div>
          </div>
          <div className="review-filter-group review-difference-filter">
            <span>计算差额（元）</span>
            <input type="number" inputMode="decimal" step="0.01" aria-label="计算差额下限" placeholder="最小值" value={differenceMin} onChange={(event) => setDifferenceMin(event.target.value)} />
            <b>至</b>
            <input type="number" inputMode="decimal" step="0.01" aria-label="计算差额上限" placeholder="最大值" value={differenceMax} onChange={(event) => setDifferenceMax(event.target.value)} />
          </div>
        </nav>
        {differenceRangeError && <p className="review-filter-feedback review-filter-feedback--error" role="alert">{differenceRangeError}</p>}
        {hasReviewStatusUpdates && <p className="review-filter-feedback" role="status">处理状态正在保存，完成后即可导出差异报表。</p>}
        <div className="table-wrap">
          <table className="review-table">
            <thead>
              <tr>
                <th>任务 / 单据</th>
                <th>字段</th>
                <th>结算单金额</th>
                <th>ERP 金额</th>
                <th>计算差额</th>
                <th>问题说明</th>
                <th>处理状态</th>
                <th aria-label="处理操作" />
              </tr>
            </thead>
            <tbody>
              {filteredRows.map(({ task, item, communication }) => {
                const status = reviewStatuses[item.id] ?? item.status;
                return (
                  <tr key={`${task.id}-${item.id}`}>
                    <td><strong>{task.name ?? task.id}</strong><span>{item.rowLabel}</span></td>
                    <td><strong>{item.fieldName}</strong><span>{task.periodLabel ?? "账期待确认"}</span></td>
                    <td className="number-cell">{formatMoney(item.settlementValue)}</td>
                    <td className="number-cell">{formatMoney(item.erpValue)}</td>
                    <td className="number-cell number-cell--issue">{formatMoney(item.differenceAmount)}</td>
                    <td className="review-message">
                      <strong>{item.message}</strong>
                      <span>{item.suggestion ?? "请确认结算单与 ERP 的可比口径。"}</span>
                      {status === "PENDING" && communication && (
                        <details className="review-communication-inline">
                          <summary>查看沟通话术</summary>
                          <div className="review-communication-inline__content">
                            <p><b>待确认：</b>{communication.confirmation.question}</p>
                            <div className="review-communication-inline__heading">
                              <b>可直接发送</b>
                              <button type="button" onClick={() => void copyCommunicationTemplate(item.id, communication.confirmation.communicationTemplate)}>{copiedTemplateId === item.id ? "已复制" : "复制话术"}</button>
                            </div>
                            <pre>{communication.confirmation.communicationTemplate}</pre>
                          </div>
                        </details>
                      )}
                      {status === "PENDING" && !communication && !communicationError && <span className="review-communication-unavailable">沟通话术正在加载</span>}
                    </td>
                    <td><span className={`review-pill review-pill--${status.toLowerCase()}`}>{reviewStatusLabels[status]}</span></td>
                    <td>
                      <div className="review-actions">
                        <button type="button" disabled={updatingItemIds.includes(item.id)} onClick={() => void setReviewStatus(task.id, item.id, "APPROVED")}>确认</button>
                        <button type="button" disabled={updatingItemIds.includes(item.id)} onClick={() => void setReviewStatus(task.id, item.id, "IGNORED")}>暂不处理</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {loading && <div className="empty-state"><b>正在读取差异明细</b><span>请稍候</span></div>}
          {!loading && !error && filteredRows.length === 0 && <div className="empty-state"><b>{filtered ? "暂无符合筛选条件的差异" : "暂无需要处理的差异"}</b><span>{filtered ? "请调整地区、处理状态或计算差额范围" : "系统发现需要核对的事项后会显示在这里"}</span></div>}
        </div>
      </section>
    </div>
  );
}
