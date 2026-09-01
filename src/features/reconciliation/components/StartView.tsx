// 文件说明：开始对账页面，展示结算资料上传入口和提交按钮。
// 文件选择为本地表单状态；任务执行与处理日志由全局 ReconciliationTaskProvider 管理。
import { useStartReconciliation } from "../hooks/use-start-reconciliation";
import { useReconciliationTask } from "../hooks/ReconciliationTaskProvider";
import {
  reconciliationFileAccept,
  reconciliationFileHint,
} from "../model/file-rules";
import { FileCard } from "./FileCard";
import { ProcessLogPanel } from "./ProcessLogPanel";

export function StartView() {
  const {
    settlementFile,
    agentName,
    agentWorkspace,
    formError,
    setAgentName,
    setAgentWorkspace,
    handleSettlementFileChange,
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
    void startReconciliation({ settlementFile, agentName, agentWorkspace });
  };

  return (
    <div className="view-shell start-view">
      <div className="page-intro page-intro--split">
        <div>
          <span className="eyebrow">NEW RECONCILIATION</span>
          <h1>发起一笔新对账</h1>
          <p>导入渠道结算资料；Agent 会读取结算单并通过 ERP/DRP MCP 查询业务金额。</p>
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
        <div className={filesReady ? "flow-item flow-item--active" : "flow-item"}><b>02</b><span>Agent 查询 ERP/DRP</span></div>
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
            <span className="file-state">MCP 查询</span>
          </div>
          <div className="file-icon" aria-hidden="true">MCP</div>
          <h3>ERP/DRP 数据源</h3>
          <p>Agent 按结算主体和账期调用 ERP/DRP MCP，返回销售额、扣点后金额和差额。</p>
          <div className="selected-file">
            <div>
              <strong>ERP/DRP MCP</strong>
              <span>后端只校验 Agent JSON 并写入飞书 Base</span>
            </div>
          </div>
          <span className="file-hint">基础 ERP 明细维护请到「新增 ERP」栏目</span>
        </div>
      </div>

      <section className="launch-bar">
        <div className="launch-copy">
          <span className={`readiness-dot ${canStart ? "ready" : ""}`} />
          <div>
            <strong>{canStart ? "提交信息已准备完成" : filesReady ? "请填写 Agent 名称" : "请先导入结算资料"}</strong>
            <small>{canStart ? "Agent 会完成 A+B 对账并返回严格 JSON" : filesReady ? "Agent 名称是创建对账任务的必填参数" : "前端不接收 ERP 文件"}</small>
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
