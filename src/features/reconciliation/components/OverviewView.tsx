// 文件说明：对账总览页面，展示统计卡片、历史任务表和任务详情抽屉。
import { useReconciliationOverview } from "../hooks/use-reconciliation-overview";
import { formatMoney, formatTaskTime, statusLabels } from "../model/view-model";
import { TaskDetailDrawer } from "./TaskDetailDrawer";

export function OverviewView() {
  const {
    filter,
    setFilter,
    query,
    setQuery,
    total,
    page,
    setPage,
    statistics,
    statisticsError,
    selected,
    closeDetails,
    loading,
    error,
    records,
    counts,
    trend,
    maxTrend,
    openDetails,
    deleteTask,
    deletingTaskId,
    stopTask,
    stoppingTaskId,
    pageSize,
  } = useReconciliationOverview();

  return (
    <div className="view-shell overview-view">
      <div className="page-intro page-intro--split">
        <div>
          <span className="eyebrow">RECONCILIATION OVERVIEW</span>
          <h1>对账总览</h1>
          <p>集中查看后端返回的历史任务、匹配结果与需要进一步处理的差异。</p>
        </div>
        <div className="updated-at"><span /> 数据更新于 {statistics ? formatTaskTime(statistics.updatedAt) : "加载中"}</div>
      </div>

      {statisticsError && <div className="api-error overview-error" role="alert"><b>统计加载失败</b><span>{statisticsError}</span></div>}

      <div className="summary-grid">
        <article className="summary-card summary-card--total">
          <div><span>本月对账</span><b>{statistics?.totalTasks ?? "—"}</b></div>
          <div className="mini-chart" aria-label="近六个月对账任务量">
            {trend.map((item) => <i key={item.label} title={`${item.label}：${item.taskCount}笔`} style={{ height: `${Math.max(18, item.taskCount / maxTrend * 100)}%` }} />)}
          </div>
          <small>较上月 <strong>{statistics ? `${statistics.monthOverMonthRate >= 0 ? "+ " : ""}${(statistics.monthOverMonthRate * 100).toFixed(1)}%` : "—"}</strong></small>
        </article>
        <article className="summary-card">
          <span className="metric-symbol metric-symbol--success">✓</span>
          <div><span>自动对平</span><b>{statistics?.succeededTasks ?? "—"}</b></div>
          <small>自动完成率 {statistics ? `${(statistics.autoMatchRate * 100).toFixed(0)}%` : "—"}</small>
        </article>
        <article className="summary-card">
          <span className="metric-symbol metric-symbol--issue">!</span>
          <div><span>需要处理</span><b>{statistics?.needsReviewTasks ?? "—"}</b></div>
          <small>共 {statistics ? formatMoney(statistics.totalDifferenceAmount) : "—"} 差异</small>
        </article>
        <article className="summary-card">
          <span className="metric-symbol metric-symbol--failed">×</span>
          <div><span>对账失败</span><b>{statistics?.failedTasks ?? "—"}</b></div>
          <small>具体原因以后端错误码为准</small>
        </article>
      </div>

      <section className="records-section">
        <div className="records-head">
          <div><h2>历史对账</h2><span>共 {total} 条任务</span></div>
          <label className="search-box">
            <span aria-hidden="true">⌕</span>
            <input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="搜索商城名称、任务编号或文件" />
          </label>
        </div>

        <div className="filter-tabs" role="tablist" aria-label="按状态筛选">
          {([
            ["all", "全部", counts.all], ["success", "成功", counts.success], ["issue", "有差异", counts.issue],
            ["failed", "失败", counts.failed], ["processing", "进行中", counts.processing],
            ["cancelled", "已停止", counts.cancelled],
          ] as const).map(([value, label, count]) => (
            <button key={value} type="button" className={filter === value ? "active" : ""} onClick={() => { setFilter(value); setPage(1); }}>
              {label}<span>{count}</span>
            </button>
          ))}
        </div>

        <div className="table-wrap">
          <table>
            <thead><tr><th>商城 / 账期</th><th>文件</th><th>结算金额</th><th>匹配条目</th><th>差异金额</th><th>状态</th><th>执行时间</th><th aria-label="操作" /></tr></thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id} onClick={() => void openDetails(record.id)}>
                  <td><strong>{record.name}</strong><span>{record.period}</span></td>
                  <td className="file-cell"><strong>{record.settlement}</strong><span>{record.erp}</span></td>
                  <td className="number-cell">{record.amount}</td>
                  <td className="number-cell">{record.matched}</td>
                  <td className={`number-cell ${record.status === "issue" ? "number-cell--issue" : ""}`}>{record.variance}</td>
                  <td><span className={`status status--${record.status}`}><i />{statusLabels[record.status]}</span></td>
                  <td><strong>{record.time}</strong><span>{record.owner}</span></td>
                  <td className="row-actions-cell">
                    <div className="row-actions">
                      {record.status === "processing" && (
                        <button
                          type="button"
                          className="row-stop"
                          aria-label={`停止 ${record.id}`}
                          title="停止对账"
                          disabled={stoppingTaskId === record.id}
                          onClick={(event) => {
                            event.stopPropagation();
                            const confirmed = window.confirm("确定停止这条对账任务吗？正在执行的 Agent Session 将被终止，已上传文件会保留。\n\n停止后可在总览中删除任务。");
                            if (confirmed) void stopTask(record.id);
                          }}
                        >{stoppingTaskId === record.id ? "…" : "■"}</button>
                      )}
                      <button
                        type="button"
                        className="row-action"
                        aria-label={`查看 ${record.id} 详情`}
                        title="查看详情"
                        onClick={(event) => { event.stopPropagation(); void openDetails(record.id); }}
                      >…</button>
                      <button
                        type="button"
                        className="row-delete"
                        aria-label={`删除 ${record.id}`}
                        title={record.status === "processing" ? "进行中的任务不能删除" : "删除任务"}
                        disabled={record.status === "processing" || deletingTaskId === record.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          const confirmed = window.confirm("确定永久删除这条对账任务吗？相关审核数据和飞书附件也会一并删除，此操作无法撤销。");
                          if (confirmed) void deleteTask(record.id);
                        }}
                      >{deletingTaskId === record.id ? "…" : "×"}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {loading && <div className="empty-state"><b>正在读取对账任务</b><span>请稍候</span></div>}
          {!loading && error && <div className="empty-state empty-state--error"><b>数据加载失败</b><span>{error}</span></div>}
          {!loading && !error && !records.length && <div className="empty-state"><b>没有找到相关任务</b><span>试试更换筛选条件或搜索关键词</span></div>}
        </div>
        {total > pageSize && (
          <div className="pagination" aria-label="历史任务分页">
            <span>第 {page} / {Math.ceil(total / pageSize)} 页</span>
            <div>
              <button type="button" disabled={page === 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>上一页</button>
              <button type="button" disabled={page >= Math.ceil(total / pageSize)} onClick={() => setPage((current) => current + 1)}>下一页</button>
            </div>
          </div>
        )}
      </section>

      {selected && <TaskDetailDrawer selected={selected} onClose={closeDetails} />}
    </div>
  );
}
