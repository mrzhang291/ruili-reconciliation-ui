// 文件说明：应用主壳，负责在开始对账、对账总览、差异处理三个页面之间切换。
// 对账任务执行与处理日志由 ReconciliationTaskProvider 常驻管理，切换页面不丢失。
import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../features/reconciliation/components/AppSidebar";
import { AppTopbar } from "../features/reconciliation/components/AppTopbar";
import { BatchReconciliationView } from "../features/reconciliation/components/BatchReconciliationView";
import { OverviewView } from "../features/reconciliation/components/OverviewView";
import { ReviewView } from "../features/reconciliation/components/ReviewView";
import { StartView } from "../features/reconciliation/components/StartView";
import { ConnectionSettingsView } from "../features/reconciliation/components/ConnectionSettingsView";
import { ErpDetailsView } from "../features/reconciliation/components/ErpDetailsView";
import { ErpImportView } from "../features/reconciliation/components/ErpImportView";
import { ReconciliationTaskProvider } from "../features/reconciliation/hooks/ReconciliationTaskProvider";
import type { ReconciliationTaskSummary } from "../features/reconciliation/model/types";
import type { WorkspaceView } from "../features/reconciliation/model/workspace-types";

function AppShell({
  view,
  onViewChange,
  onErpDirtyChange,
}: {
  view: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
  onErpDirtyChange: (dirty: boolean) => void;
}) {
  return (
    <main className="app-shell">
      <AppSidebar view={view} onViewChange={onViewChange} />

      <section className="workspace">
        <AppTopbar view={view} onStart={() => onViewChange("start")} />
        {view === "start" && <StartView />}
        {view === "batch" && <BatchReconciliationView />}
        {view === "overview" && <OverviewView />}
        {view === "review" && <ReviewView />}
        {view === "erp" && <ErpDetailsView onDirtyChange={onErpDirtyChange} />}
        {view === "erpImport" && <ErpImportView />}
        {view === "settings" && <ConnectionSettingsView />}
      </section>
    </main>
  );
}

export default function Home() {
  const [view, setView] = useState<WorkspaceView>("start");
  const [erpDirty, setErpDirty] = useState(false);

  useEffect(() => {
    void fetch("http://127.0.0.1:3334/api/config")
      .then((response) => response.json())
      .then((payload) => {
        const stored = payload?.data?.stored;
        if (!stored?.cherryApiKey) setView("settings");
      })
      .catch(() => setView("settings"));
  }, []);

  const handleComplete = useCallback((task: ReconciliationTaskSummary) => {
    setView(task.status === "NEEDS_REVIEW" ? "review" : "overview");
  }, []);

  const handleViewChange = useCallback((nextView: WorkspaceView) => {
    if (view === "erp" && nextView !== "erp" && erpDirty) {
      const confirmed = window.confirm("当前有未保存的 ERP 行内修改，离开页面会丢弃这些修改。");
      if (!confirmed) return;
      setErpDirty(false);
    }
    setView(nextView);
  }, [erpDirty, view]);

  return (
    <ReconciliationTaskProvider onComplete={handleComplete}>
      <AppShell view={view} onViewChange={handleViewChange} onErpDirtyChange={setErpDirty} />
    </ReconciliationTaskProvider>
  );
}
