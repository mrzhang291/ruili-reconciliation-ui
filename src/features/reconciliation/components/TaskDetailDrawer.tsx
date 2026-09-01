// 文件说明：任务详情抽屉组件，展示单个对账任务的文件、金额和失败信息。
import { statusLabels, type ReconciliationView } from "../model/view-model";

type TaskDetailDrawerProps = {
  selected: ReconciliationView;
  onClose: () => void;
};

export function TaskDetailDrawer({ selected, onClose }: TaskDetailDrawerProps) {
  return (
    <div className="drawer-backdrop">
      <button type="button" className="drawer-dismiss" onClick={onClose} aria-label="关闭任务详情" />
      <aside className="detail-drawer" aria-label="对账任务详情">
        <button type="button" className="drawer-close" onClick={onClose} aria-label="关闭详情">×</button>
        <span className="eyebrow">TASK DETAIL</span>
        <h2>{selected.name}</h2>
        <span className={`status status--${selected.status}`}><i />{statusLabels[selected.status]}</span>
        <div className="detail-amount"><span>结算金额</span><strong>{selected.amount}</strong></div>
        <dl>
          <div><dt>任务编号</dt><dd>{selected.id}</dd></div>
          <div><dt>账期</dt><dd>{selected.period}</dd></div>
          <div><dt>匹配条目</dt><dd>{selected.matched}</dd></div>
          <div><dt>差异金额</dt><dd>{selected.variance}</dd></div>
          <div><dt>执行人</dt><dd>{selected.owner}</dd></div>
          <div><dt>结算单</dt><dd>{selected.settlement}</dd></div>
          <div><dt>ERP 资料</dt><dd>{selected.erp}</dd></div>
          {selected.failure && <div><dt>{selected.status === "cancelled" ? "停止原因" : "失败原因"}</dt><dd className="failure-message">{selected.failure}</dd></div>}
        </dl>
      </aside>
    </div>
  );
}
