// 文件说明：开始对账页面，展示结算资料上传入口和提交按钮。
// 文件选择为本地表单状态；任务执行与处理日志由全局 ReconciliationTaskProvider 管理。
import { useStartReconciliation } from "../hooks/use-start-reconciliation";
import { useReconciliationTask } from "../hooks/ReconciliationTaskProvider";
import {
  erpFileAccept,
  formatFileSize,
  reconciliationFileAccept,
  reconciliationFileHint,
} from "../model/file-rules";
import { FileCard } from "./FileCard";
import { ProcessLogPanel } from "./ProcessLogPanel";

export function StartView() {
  const {
    settlementFile,
    taskErpFile,
    agentName,
    agentWorkspace,
    formError,
    setAgentName,
    setAgentWorkspace,
    clearTaskErpFile,
    handleSettlementFileChange,
    handleTaskErpFileChange,
  } = useStartReconciliation();
  const {
    running,
    canStop,
    stopping,
    error,
    logs,
    startReconciliation,
    stopReconciliation,
  } = useReconciliationTask();

  const hasAgentName = Boolean(agentName.trim());
  const filesReady = Boolean(settlementFile);
  const canStart = filesReady && hasAgentName;

  const handleSubmit = () => {
    if (!hasAgentName) return;
    if (!settlementFile) return;
    void startReconciliation({ settlementFile, erpFile: taskErpFile, agentName, agentWorkspace });
  };

  return (
    <div className="view-shell start-view">
      <div className="page-intro page-intro--split">
        <div>
          <span className="eyebrow">NEW RECONCILIATION</span>
          <h1>发起一笔新对账</h1>
          <p>导入渠道结算资料；ERP 可用本次上传文件，未上传时由后端查询飞书明细表计算。</p>
        </div>
        <div className="security-note">
          <span aria-hidden="true">↗</span>
          <div>
            <strong>文件提交后由服务端处理</strong>
            <small>前端不解析、不保存，也不执行任何金额计算</small>
          </div>
        </div>
      </div>

      <div className="flow-strip" aria-label="对账步骤">
        <div className="flow-item flow-item--active"><b>01</b><span>导入结算资料</span></div>
        <i />
        <div className={filesReady ? "flow-item flow-item--active" : "flow-item"}><b>02</b><span>确定 ERP 来源</span></div>
        <i />
        <div className={canStart ? "flow-item flow-item--active" : "flow-item"}><b>03</b><span>提交后端任务</span></div>
      </div>

      <section className="agent-selector" aria-labelledby="agent-selector-title">
        <div className="agent-selector__intro">
          <span>CHERRYSTUDIO TARGET</span>
          <div>
            <h2 id="agent-selector-title">选择对账 Agent</h2>
            <p>Agent 名称为必填项；名称重复时可填写工作目录消除歧义。</p>
          </div>
        </div>
        <div className="agent-selector__fields">
          <label>
            <span>Agent 名称（必填）</span>
            <input
              type="text"
              value={agentName}
              onChange={(event) => setAgentName(event.target.value)}
              placeholder="请输入 CherryStudio Agent 名称"
              required
              autoComplete="off"
            />
          </label>
          <label>
            <span>Agent 工作目录</span>
            <input
              type="text"
              value={agentWorkspace}
              onChange={(event) => setAgentWorkspace(event.target.value)}
              placeholder="可选，用于消除同名 Agent 歧义"
              autoComplete="off"
            />
          </label>
        </div>
      </section>

      <div className="file-grid">
        <FileCard
          eyebrow="01"
          title="导入结算资料"
          description="渠道、平台或门店提供的表格、PDF 或截图资料"
          file={settlementFile}
          accept={reconciliationFileAccept}
          hint={reconciliationFileHint}
          onChange={handleSettlementFileChange}
        />
        <div className="file-card file-card--ready" aria-label="ERP 来源">
          <div className="file-card__head">
            <span className="step-index">02</span>
            <span className="file-state">{taskErpFile ? "已上传" : "总表检索"}</span>
          </div>
          <div className="file-icon" aria-hidden="true">{taskErpFile ? "XLS" : "✓"}</div>
          <h3>ERP 来源</h3>
          <p>上传本次 ERP Excel 时优先使用该文件；未上传时查询飞书 ERP 明细表。</p>
          <div className="selected-file">
            <div>
              <strong>{taskErpFile?.name ?? "飞书 ERP 明细表"}</strong>
              <span>{taskErpFile ? `${formatFileSize(taskErpFile.size)} · 本次任务文件` : "默认数据源：飞书多维表格"}</span>
            </div>
            <div className="file-inline-actions">
              <label className="text-button">
                {taskErpFile ? "更换文件" : "上传 ERP"}
                <input type="file" accept={erpFileAccept} onChange={handleTaskErpFileChange} />
              </label>
              {taskErpFile && (
                <button type="button" className="text-button" onClick={clearTaskErpFile}>用总表</button>
              )}
            </div>
          </div>
          <span className="file-hint">本次 ERP 文件只参与当前任务，不写入总表</span>
        </div>
      </div>

      <section className="launch-bar">
        <div className="launch-copy">
          <span className={`readiness-dot ${canStart ? "ready" : ""}`} />
          <div>
            <strong>{canStart ? "提交信息已准备完成" : filesReady ? "请填写 Agent 名称" : "请先导入结算资料"}</strong>
            <small>{canStart ? (taskErpFile ? "将优先使用本次 ERP 文件计算金额" : "未上传 ERP 时将查询飞书总表") : filesReady ? "Agent 名称是创建对账任务的必填参数" : "ERP 金额将由后端确定性计算"}</small>
          </div>
        </div>
        {running ? (
          <button type="button" className="stop-button" disabled={!canStop || stopping} onClick={() => void stopReconciliation()}>
            <span aria-hidden="true">■</span> {canStop ? (stopping ? "正在停止" : "停止对账") : "正在创建任务"}
          </button>
        ) : (
          <button type="button" className="primary-button" disabled={!canStart} onClick={handleSubmit}>
            开始对账<span>→</span>
          </button>
        )}
      </section>

      {formError && <div className="api-error" role="alert"><b>文件校验失败</b><span>{formError}</span></div>}
      {error && <div className="api-error" role="alert"><b>提交失败</b><span>{error}</span></div>}

      {/* 处理日志：保持在发起对账界面；任务切页不中断，切回仍显示完整日志 */}
      <ProcessLogPanel logs={logs} running={running} />

      <div className="rule-note">
        <span>职责边界</span>
        <p>匹配规则、金额容差和差异分类均来自飞书知识规则表，前端只负责提交和展示。</p>
        <span className="contract-ready">接口已预留</span>
      </div>
    </div>
  );
}
