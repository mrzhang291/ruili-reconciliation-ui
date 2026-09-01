// 文件说明：顶部栏组件，展示当前页面位置和 CherryStudio 接口配置状态。
import { usingDisabledApi } from "../api";
import { useReconciliationTask } from "../hooks/ReconciliationTaskProvider";
import type { WorkspaceView } from "../model/workspace-types";

type AppTopbarProps = {
  view: WorkspaceView;
  onStart: () => void;
};

const viewLabels: Record<WorkspaceView, string> = {
  start: "发起对账",
  batch: "批量对账",
  overview: "对账总览",
  review: "差异处理",
  erp: "ERP 明细",
  erpImport: "新增 ERP",
  settings: "连接设置",
};

export function AppTopbar({ view, onStart }: AppTopbarProps) {
  const { running } = useReconciliationTask();

  return (
    <header className="topbar">
      <div><span>财务运营</span><b>/</b><strong>{viewLabels[view]}</strong>{usingDisabledApi && <em className="api-indicator">接口未配置</em>}</div>
      <div className="topbar-actions">
        {view !== "start" && view !== "settings" && running && (
          <button type="button" className="running-indicator" onClick={onStart} title="任务在处理中，点击回到发起对账查看进度">
            <span className="running-indicator__dot" aria-hidden="true" /> 对账进行中
          </button>
        )}
        <button type="button" className="help-button"><span>?</span> 使用帮助</button>
        {view !== "start" && view !== "settings" && <button type="button" className="compact-primary" onClick={onStart}>＋ 新建对账</button>}
        <button type="button" className="notification-button" aria-label="通知"><span>•</span>⌾</button>
      </div>
    </header>
  );
}
