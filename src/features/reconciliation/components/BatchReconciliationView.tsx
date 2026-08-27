// 文件说明：批量对账页面，负责批次预检、逐份执行、人工修正和导出。
import { useEffect, useMemo, useState } from "react";
import { reconciliationApi } from "../api";
import { useStartReconciliation } from "../hooks/use-start-reconciliation";
import { useReconciliationTask } from "../hooks/ReconciliationTaskProvider";
import {
  batchReconciliationMaxFiles,
  batchReconciliationMaxTotalSizeMb,
  erpFileAccept,
  formatFileSize,
  reconciliationFileAccept,
  reconciliationFileHint,
} from "../model/file-rules";
import type { BatchPrecheckItem, BatchPrecheckItemStatus, BatchPrecheckResult } from "../model/types";
import { formatMoney, requestErrorMessage } from "../model/view-model";
import { ProcessLogPanel } from "./ProcessLogPanel";

const precheckStatusLabels: Record<BatchPrecheckItemStatus, string> = {
  READY: "可执行",
  NEEDS_REVIEW: "待确认",
  REJECTED: "已拒绝",
  DUPLICATE: "已去重",
  PROCESSING: "处理中",
  SUCCEEDED: "已一致",
  FAILED: "失败",
  CANCELLED: "已取消",
};

const precheckStatusClasses: Record<BatchPrecheckItemStatus, string> = {
  READY: "ready",
  NEEDS_REVIEW: "review",
  REJECTED: "rejected",
  DUPLICATE: "duplicate",
  PROCESSING: "review",
  SUCCEEDED: "ready",
  FAILED: "rejected",
  CANCELLED: "duplicate",
};

type BatchTab = "groups" | "documents";
type ManualDraft = { shopNo: string; period: string; amount: string };

function fileDisplayName(file: File) {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

function moneyText(value: number | null) {
  return value === null ? "—" : formatMoney({ currency: "CNY", value: String(value) });
}

function isRunnableBatchItem(item: BatchPrecheckItem) {
  return !["REJECTED", "DUPLICATE", "PROCESSING", "SUCCEEDED", "CANCELLED"].includes(item.status)
    && !item.taskId
    && Boolean(item.shopNo);
}

function documentDraft(item: BatchPrecheckItem, drafts: Record<string, ManualDraft>) {
  return drafts[item.documentId] ?? {
    shopNo: item.shopNo ?? item.shopCodes[0] ?? "",
    period: item.period ?? "",
    amount: item.confirmedSettlementAmount === null ? "" : String(item.confirmedSettlementAmount),
  };
}

export function BatchReconciliationView() {
  const {
    batchFiles,
    batchRejectedFiles,
    taskErpFile,
    agentName,
    agentWorkspace,
    formError,
    setAgentName,
    setAgentWorkspace,
    clearTaskErpFile,
    clearBatchFiles,
    handleBatchFilesChange,
    handleTaskErpFileChange,
  } = useStartReconciliation();
  const {
    running,
    canStop,
    stopping,
    error,
    logs,
    startBatchReconciliation,
    stopReconciliation,
  } = useReconciliationTask();
  const [precheckResult, setPrecheckResult] = useState<BatchPrecheckResult | null>(null);
  const [precheckSignature, setPrecheckSignature] = useState("");
  const [precheckErrorSignature, setPrecheckErrorSignature] = useState("");
  const [prechecking, setPrechecking] = useState(false);
  const [precheckError, setPrecheckError] = useState("");
  const [batchTab, setBatchTab] = useState<BatchTab>("groups");
  const [manualDrafts, setManualDrafts] = useState<Record<string, ManualDraft>>({});
  const [savingDocumentId, setSavingDocumentId] = useState("");

  const inputSignature = useMemo(() => {
    const settlementSignature = batchFiles
      .map((file) => `${fileDisplayName(file)}:${file.size}:${file.lastModified}`)
      .join("|");
    const erpSignature = taskErpFile ? `${taskErpFile.name}:${taskErpFile.size}:${taskErpFile.lastModified}` : "";
    return `${settlementSignature}::${erpSignature}`;
  }, [batchFiles, taskErpFile]);
  const activePrecheckResult = precheckSignature === inputSignature ? precheckResult : null;
  const activePrecheckError = precheckErrorSignature === inputSignature ? precheckError : "";
  const filesReady = batchFiles.length > 0;
  const hasAgentName = Boolean(agentName.trim());
  const canPrecheck = filesReady && !prechecking;
  const canExecute = Boolean(activePrecheckResult?.executableFiles) && hasAgentName && !prechecking && !savingDocumentId;
  const canStart = activePrecheckResult ? canExecute : canPrecheck;
  const filePreview = batchFiles.slice(0, 10);
  const pendingPrecheckCount = activePrecheckResult?.items.filter((item) => item.status === "NEEDS_REVIEW" && !item.taskId && !isRunnableBatchItem(item)).length ?? 0;
  const totalSize = batchFiles.reduce((sum, file) => sum + file.size, 0);

  useEffect(() => {
    if (!running || !activePrecheckResult?.batchId) return undefined;
    const batchId = activePrecheckResult.batchId;
    const timer = window.setInterval(() => {
      void reconciliationApi.getBatch(batchId).then((result) => {
        setPrecheckResult(result);
        setPrecheckSignature(inputSignature);
      }).catch(() => undefined);
    }, 2_500);
    return () => window.clearInterval(timer);
  }, [activePrecheckResult?.batchId, inputSignature, running]);

  const runPrecheck = async () => {
    if (!filesReady || prechecking) return null;
    const signature = inputSignature;
    setPrechecking(true);
    setPrecheckError("");
    setManualDrafts({});
    try {
      const result = await reconciliationApi.precheckBatch({
        settlementFiles: batchFiles,
        erpFile: taskErpFile ?? undefined,
      });
      setPrecheckResult(result);
      setPrecheckSignature(signature);
      setBatchTab(result.groups.length ? "groups" : "documents");
      return result;
    } catch (requestError) {
      const message = requestErrorMessage(requestError, "批量预检失败，请稍后重试");
      setPrecheckError(message);
      setPrecheckErrorSignature(signature);
      return null;
    } finally {
      setPrechecking(false);
    }
  };

  const patchDraft = (documentId: string, patch: Partial<ManualDraft>) => {
    setManualDrafts((previous) => ({
      ...previous,
      [documentId]: { ...(previous[documentId] ?? { shopNo: "", period: "", amount: "" }), ...patch },
    }));
  };

  const applyBatchUpdate = (result: BatchPrecheckResult) => {
    setPrecheckResult(result);
    setPrecheckSignature(inputSignature);
  };

  const saveIdentity = async (item: BatchPrecheckItem) => {
    const draft = documentDraft(item, manualDrafts);
    setSavingDocumentId(item.documentId);
    setPrecheckError("");
    try {
      applyBatchUpdate(await reconciliationApi.updateBatchDocumentIdentity(item.documentId, {
        shopNo: draft.shopNo,
        period: draft.period,
      }));
    } catch (requestError) {
      setPrecheckError(requestErrorMessage(requestError, "保存店铺号/账期失败"));
      setPrecheckErrorSignature(inputSignature);
    } finally {
      setSavingDocumentId("");
    }
  };

  const saveManualAmount = async (item: BatchPrecheckItem) => {
    const draft = documentDraft(item, manualDrafts);
    setSavingDocumentId(item.documentId);
    setPrecheckError("");
    try {
      applyBatchUpdate(await reconciliationApi.selectBatchDocumentAmount(item.documentId, {
        amount: Number(draft.amount),
        label: "人工确认金额",
      }));
    } catch (requestError) {
      setPrecheckError(requestErrorMessage(requestError, "保存确认金额失败"));
      setPrecheckErrorSignature(inputSignature);
    } finally {
      setSavingDocumentId("");
    }
  };

  const selectCandidate = async (item: BatchPrecheckItem, candidateId: string) => {
    if (!candidateId) return;
    setSavingDocumentId(item.documentId);
    setPrecheckError("");
    try {
      applyBatchUpdate(await reconciliationApi.selectBatchDocumentAmount(item.documentId, { candidateId }));
    } catch (requestError) {
      setPrecheckError(requestErrorMessage(requestError, "选择金额候选失败"));
      setPrecheckErrorSignature(inputSignature);
    } finally {
      setSavingDocumentId("");
    }
  };

  const exportBatch = async () => {
    if (!activePrecheckResult) return;
    try {
      await reconciliationApi.exportBatchCsv(activePrecheckResult.batchId);
    } catch (requestError) {
      setPrecheckError(requestErrorMessage(requestError, "导出批量结果失败"));
      setPrecheckErrorSignature(inputSignature);
    }
  };

  const handleSubmit = () => {
    if (running) return;
    if (!activePrecheckResult) {
      void runPrecheck();
      return;
    }
    if (!canExecute) {
      setPrecheckError("没有可执行组，请先处理待确认单据");
      setPrecheckErrorSignature(inputSignature);
      return;
    }
    void startBatchReconciliation({ batchId: activePrecheckResult.batchId, agentName, agentWorkspace });
  };

  return (
    <div className="view-shell batch-view">
      <div className="page-intro page-intro--split">
        <div>
          <span className="eyebrow">BATCH RECONCILIATION</span>
          <h1>批量对账</h1>
          <p>一次选择多份结算单，系统落批次后逐份走单文件对账链路。</p>
        </div>
        <div className="security-note">
          <span aria-hidden="true">↗</span>
          <div>
            <strong>逐份创建对账任务</strong>
            <small>单批最多 {batchReconciliationMaxFiles} 份，合计不超过 {batchReconciliationMaxTotalSizeMb} MB</small>
          </div>
        </div>
      </div>

      <div className="flow-strip" aria-label="批量对账步骤">
        <div className="flow-item flow-item--active"><b>01</b><span>选择多个文件</span></div>
        <i />
        <div className={filesReady ? "flow-item flow-item--active" : "flow-item"}><b>02</b><span>预检建批次</span></div>
        <i />
        <div className={activePrecheckResult ? "flow-item flow-item--active" : "flow-item"}><b>03</b><span>逐份执行</span></div>
      </div>

      <section className="agent-selector" aria-labelledby="batch-agent-selector-title">
        <div className="agent-selector__intro">
          <span>CHERRYSTUDIO TARGET</span>
          <div>
            <h2 id="batch-agent-selector-title">选择对账 Agent</h2>
            <p>批量中的每份结算单都会使用同一个 Agent，默认使用锐力。</p>
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
        <section className={`file-card ${filesReady ? "file-card--ready" : ""}`} aria-labelledby="batch-upload-title">
          <div className="file-card__head">
            <span className="step-index">01</span>
            <span className="file-state">{filesReady ? "已就绪" : "等待导入"}</span>
          </div>
          <div className="file-icon" aria-hidden="true">{filesReady ? batchFiles.length : "FILES"}</div>
          <h3 id="batch-upload-title">批量结算单文件</h3>
          <p>可一次多选 PDF、Excel 或图片；盘点、统计、扣款和租赁文件会过滤。</p>
          <div className="file-actions">
            <label className="outline-button batch-picker">
              <span aria-hidden="true">＋</span> {filesReady ? "更换文件" : "选择多个文件"}
              <input
                type="file"
                accept={reconciliationFileAccept}
                multiple
                onChange={handleBatchFilesChange}
              />
            </label>
            {filesReady && <button type="button" className="text-button" onClick={clearBatchFiles}>清空批量</button>}
          </div>
          <span className="file-hint">{reconciliationFileHint}</span>
        </section>

        <div className="file-card file-card--ready" aria-label="ERP 来源">
          <div className="file-card__head">
            <span className="step-index">02</span>
            <span className="file-state">{taskErpFile ? "本批次文件" : "总表检索"}</span>
          </div>
          <div className="file-icon" aria-hidden="true">{taskErpFile ? "XLS" : "✓"}</div>
          <h3>ERP 来源</h3>
          <p>上传 ERP Excel 时只服务本批次；未上传时查询飞书 ERP 明细表。</p>
          <div className="selected-file">
            <div>
              <strong>{taskErpFile?.name ?? "飞书 ERP 明细表"}</strong>
              <span>{taskErpFile ? `${formatFileSize(taskErpFile.size)} · 本批次优先` : "默认数据源：飞书多维表格"}</span>
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
          <span className="file-hint">长期维护 ERP 总表请到「新增 ERP」栏目</span>
        </div>
      </div>

      {(filesReady || batchRejectedFiles.length > 0) && (
        <section className={`batch-panel ${filesReady ? "batch-panel--ready" : ""}`} aria-label="批量文件清单">
          <div className="batch-panel__intro">
            <span>BATCH</span>
            <div>
              <h2>批次工作台</h2>
              <p>预检会写入批处理汇总表和批量结算单明细表；执行时逐份创建普通对账任务。</p>
            </div>
          </div>
          <div className="batch-panel__actions">
            {activePrecheckResult && (
              <>
                <button type="button" className="text-button" onClick={() => void reconciliationApi.getBatch(activePrecheckResult.batchId).then(applyBatchUpdate)}>刷新批次</button>
                <button type="button" className="text-button" onClick={() => void exportBatch()}>导出 CSV</button>
              </>
            )}
          </div>
          <div className="batch-panel__meta">
            <span>已选结算资料 {batchFiles.length} 份</span>
            <span>合计 {formatFileSize(totalSize)}</span>
            {activePrecheckResult && <span>批次 {activePrecheckResult.batchId}</span>}
            {batchRejectedFiles.length > 0 && <span>选择时已过滤 {batchRejectedFiles.length} 个文件</span>}
          </div>
          {filePreview.length > 0 && !activePrecheckResult && (
            <div className="batch-file-list" aria-label="批量文件预览">
              {filePreview.map((file, index) => <span key={`${file.name}:${file.size}:${index}`}>{fileDisplayName(file)}</span>)}
              {batchFiles.length > filePreview.length && <span>另有 {batchFiles.length - filePreview.length} 份…</span>}
            </div>
          )}
          {batchRejectedFiles.length > 0 && (
            <div className="batch-rejects">
              {batchRejectedFiles.slice(0, 8).map((file) => <span key={`${file.name}:${file.reason}`}>{file.name}：{file.reason}</span>)}
            </div>
          )}
          {activePrecheckResult && (
            <div className="batch-precheck">
              <div className="batch-precheck__summary">
                <span>可执行单据 {activePrecheckResult.executableFiles}</span>
                <span>对账组 {activePrecheckResult.groups.length}</span>
                <span>待确认 {pendingPrecheckCount}</span>
                <span>拒绝 {activePrecheckResult.rejectedFiles}</span>
                <span>去重 {activePrecheckResult.duplicateFiles}</span>
              </div>
              <div className="batch-tabs" role="tablist" aria-label="批量视图">
                <button type="button" className={batchTab === "groups" ? "active" : ""} onClick={() => setBatchTab("groups")}>组视图</button>
                <button type="button" className={batchTab === "documents" ? "active" : ""} onClick={() => setBatchTab("documents")}>单据视图</button>
              </div>
              {batchTab === "groups" ? (
                <div className="batch-precheck__table-wrap">
                  <table className="batch-precheck-table batch-precheck-table--groups">
                    <thead>
                      <tr>
                        <th>组</th>
                        <th>状态</th>
                        <th>单据数</th>
                        <th>结算金额</th>
                        <th>ERP 销售额</th>
                        <th>差额</th>
                        <th>任务</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activePrecheckResult.groups.map((group) => (
                        <tr key={group.id}>
                          <td className="file-cell">
                            <strong>{group.shopNo} {group.period}</strong>
                            <span>{group.id} · v{group.version}</span>
                          </td>
                          <td>
                            <span className={`batch-status batch-status--${precheckStatusClasses[group.status]}`}>
                              {precheckStatusLabels[group.status]}
                            </span>
                          </td>
                          <td>{group.documentCount}</td>
                          <td>{moneyText(group.settlementAmount)}</td>
                          <td>{moneyText(group.erpSalesTotal)}</td>
                          <td>{moneyText(group.differenceAmount)}</td>
                          <td>{group.taskId ?? "—"}</td>
                        </tr>
                      ))}
                      {!activePrecheckResult.groups.length && (
                        <tr><td colSpan={7}>还没有可生成组的单据，请先处理单据视图里的店铺号、账期和金额。</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="batch-precheck__table-wrap">
                  <table className="batch-precheck-table batch-precheck-table--documents">
                    <thead>
                      <tr>
                        <th>文件</th>
                        <th>状态</th>
                        <th>店铺号/账期</th>
                        <th>金额</th>
                        <th>ERP 销售额</th>
                        <th>说明</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activePrecheckResult.items.map((item, index) => {
                        const draft = documentDraft(item, manualDrafts);
                        const saving = savingDocumentId === item.documentId;
                        return (
                          <tr key={`${item.documentId}:${item.sha256 ?? index}`}>
                            <td className="file-cell">
                              <strong>{item.fileName}</strong>
                              <span>{[item.sourceFileName ? `来源：${item.sourceFileName}` : formatFileSize(item.size), item.documentRange, item.documentNo ? `单号：${item.documentNo}` : "", `v${item.version}`].filter(Boolean).join(" · ")}</span>
                            </td>
                            <td>
                              <span className={`batch-status batch-status--${precheckStatusClasses[item.status]}`}>
                                {precheckStatusLabels[item.status]}
                              </span>
                            </td>
                            <td>
                              <div className="batch-inline-editor">
                                <input value={draft.shopNo} placeholder="店铺号" onChange={(event) => patchDraft(item.documentId, { shopNo: event.target.value })} />
                                <input value={draft.period} placeholder="YYYY-MM" onChange={(event) => patchDraft(item.documentId, { period: event.target.value })} />
                                <button type="button" className="text-button" disabled={saving} onClick={() => void saveIdentity(item)}>保存</button>
                              </div>
                            </td>
                            <td>
                              <div className="batch-inline-editor">
                                {item.amountCandidates.length > 0 && (
                                  <select value={item.confirmedCandidateId ?? ""} disabled={saving} onChange={(event) => void selectCandidate(item, event.target.value)}>
                                    <option value="">选择候选</option>
                                    {item.amountCandidates.map((candidate) => (
                                      <option key={candidate.id} value={candidate.id}>
                                        {candidate.label} {candidate.amount.toFixed(2)}
                                      </option>
                                    ))}
                                  </select>
                                )}
                                <input value={draft.amount} placeholder="确认金额" onChange={(event) => patchDraft(item.documentId, { amount: event.target.value })} />
                                <button type="button" className="text-button" disabled={saving} onClick={() => void saveManualAmount(item)}>保存</button>
                              </div>
                              <small>{item.confirmedSettlementAmount === null ? "—" : `${item.confirmedSettlementLabel ?? "确认金额"}：${moneyText(item.confirmedSettlementAmount)}`}</small>
                            </td>
                            <td>{moneyText(item.erpSalesTotal)}</td>
                            <td className="batch-precheck-issues">{item.issues.length ? item.issues.join("；") : `金额候选 ${item.amountCandidateCount} 个，ERP 明细 ${item.erpRows ?? 0} 行`}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      <section className="launch-bar">
        <div className="launch-copy">
          <span className={`readiness-dot ${canStart ? "ready" : ""}`} />
          <div>
            <strong>
              {activePrecheckResult
                ? (canExecute ? `预检通过 ${activePrecheckResult.executableFiles} 份，可确认执行` : hasAgentName ? "没有可执行单据" : "请填写 Agent 名称")
                : filesReady ? `已选择 ${batchFiles.length} 份，等待预检` : "请先选择结算单文件"}
            </strong>
            <small>
              {activePrecheckResult
                ? (pendingPrecheckCount ? `${pendingPrecheckCount} 份需要补店铺号` : "执行后逐份创建对账任务")
                : filesReady ? "预检阶段会创建批次记录，不会调用 Agent" : "ERP 金额将由后端确定性计算"}
            </small>
          </div>
        </div>
        {running ? (
          <button type="button" className="stop-button" disabled={!canStop || stopping} onClick={() => void stopReconciliation()}>
            <span aria-hidden="true">■</span> {canStop ? (stopping ? "正在停止" : "停止对账") : "正在创建任务"}
          </button>
        ) : (
          <button type="button" className="primary-button" disabled={!canStart} onClick={handleSubmit}>
            {prechecking ? <><i className="spinner" aria-hidden="true" />正在预检</> : activePrecheckResult ? <>确认执行 {activePrecheckResult.executableFiles} 份<span>→</span></> : <>开始预检<span>→</span></>}
          </button>
        )}
      </section>

      {formError && <div className="api-error" role="alert"><b>文件校验失败</b><span>{formError}</span></div>}
      {activePrecheckError && <div className="api-error" role="alert"><b>批量处理失败</b><span>{activePrecheckError}</span></div>}
      {error && <div className="api-error" role="alert"><b>提交失败</b><span>{error}</span></div>}

      <ProcessLogPanel logs={logs} running={running} />
    </div>
  );
}
