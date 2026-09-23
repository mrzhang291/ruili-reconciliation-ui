// 文件说明：左侧导航栏组件，负责切换对账工作台页面。
import type { WorkspaceView } from "../model/workspace-types";

type AppSidebarProps = {
  view: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
};

export function AppSidebar({ view, onViewChange }: AppSidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">对</div>
        <div><strong>对账协同工作台</strong><span>财务数据协同平台</span></div>
      </div>
      <nav aria-label="主导航">
        <span className="nav-label">工作台</span>
        <button type="button" className={view === "start" ? "active" : ""} onClick={() => onViewChange("start")}><i>＋</i><span>发起对账</span></button>
        <button type="button" className={view === "batch" ? "active" : ""} onClick={() => onViewChange("batch")}><i>批</i><span>批量对账</span></button>
        <button type="button" className={view === "overview" ? "active" : ""} onClick={() => onViewChange("overview")}><i>览</i><span>对账总览</span></button>
        <button type="button" className={view === "review" ? "active" : ""} onClick={() => onViewChange("review")}><i>审</i><span>差异处理</span></button>
        <button type="button" className={view === "mail" ? "active" : ""} onClick={() => onViewChange("mail")}><i>邮</i><span>QQ 邮箱</span></button>
        <button type="button" className={view === "erp" ? "active" : ""} onClick={() => onViewChange("erp")}><i>表</i><span>ERP 明细</span></button>
        <button type="button" className={view === "erpImport" ? "active" : ""} onClick={() => onViewChange("erpImport")}><i>导</i><span>新增 ERP</span></button>
        <span className="nav-label nav-label--second">系统</span>
        <button type="button" disabled><i>规</i><span>对账规则</span></button>
        <button type="button" className={view === "settings" ? "active" : ""} onClick={() => onViewChange("settings")}><i>连</i><span>连接设置</span></button>
      </nav>
      <div className="sidebar-footer">
        <div className="avatar">管</div>
        <div><strong>系统管理员</strong><span>财务协同中心</span></div>
        <button type="button" aria-label="更多账户选项">•••</button>
      </div>
    </aside>
  );
}
