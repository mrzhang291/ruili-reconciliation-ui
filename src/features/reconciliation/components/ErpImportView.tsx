// 文件说明：新增 ERP 页面，负责导入总表并写入飞书 ERP 明细表。
import { useState } from "react";
import type { ChangeEvent } from "react";
import { reconciliationApi } from "../api";
import {
  erpFileAccept,
  erpFileHint,
  formatFileSize,
  validateErpFile,
} from "../model/file-rules";
import type { ErpImportMode, ErpImportResult } from "../model/types";

const moneyFormatter = new Intl.NumberFormat("zh-CN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function ErpImportView() {
  const [erpMasterFile, setErpMasterFile] = useState<File | null>(null);
  const [erpMonth, setErpMonth] = useState("");
  const [erpImporting, setErpImporting] = useState<ErpImportMode | null>(null);
  const [erpImportError, setErpImportError] = useState("");
  const [erpImportResult, setErpImportResult] = useState<ErpImportResult | null>(null);

  const canPreviewErp = Boolean(erpMasterFile) && !erpImporting;
  const importPreviewReady = erpImportResult?.mode === "preview" && !erpImportResult.written && erpImportResult.failedRows.length === 0;
  const canAppendErp = canPreviewErp && importPreviewReady;
  const canReplaceErp = canPreviewErp && importPreviewReady;

  const handleErpFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0] ?? null;
    if (!selectedFile) {
      setErpMasterFile(null);
      setErpImportResult(null);
      return;
    }

    const validationError = validateErpFile(selectedFile);
    if (validationError) {
      setErpMasterFile(null);
      setErpImportResult(null);
      setErpImportError(validationError);
      event.target.value = "";
      return;
    }

    setErpMasterFile(selectedFile);
    setErpImportError("");
    setErpImportResult(null);
  };

  const handleErpMonthChange = (event: ChangeEvent<HTMLInputElement>) => {
    setErpMonth(event.target.value);
    setErpImportResult(null);
  };

  const runErpImport = async (mode: ErpImportMode) => {
    if (!erpMasterFile) return;
    if (mode === "replace") {
      const affected = erpImportResult?.months.map((month) => `${month.month}：将永久删除 ${month.existingRows} 条旧记录`).join("\n") ?? "";
      const confirmed = window.confirm(`确认替换并永久删除旧记录吗？\n\n${affected}\n\n该操作会影响后续对账，但不会自动重算已经完成的历史对账任务。`);
      if (!confirmed) return;
    }
    setErpImporting(mode);
    setErpImportError("");
    try {
      const result = await reconciliationApi.importErpFile({
        file: erpMasterFile,
        mode,
        month: erpMonth.trim() || undefined,
      });
      setErpImportResult(result);
    } catch (importError) {
      setErpImportResult(null);
      setErpImportError(importError instanceof Error ? importError.message : String(importError));
    } finally {
      setErpImporting(null);
    }
  };

  return (
    <div className="view-shell erp-import-view">
      <div className="page-intro page-intro--split">
        <div>
          <span className="eyebrow">ERP MASTER DATA</span>
          <h1>新增 ERP 总表</h1>
          <p>上传新的 ERP 总表，预览无误后追加或替换飞书 ERP 明细表。</p>
        </div>
        <div className="security-note">
          <span aria-hidden="true">↗</span>
          <div>
            <strong>先预览，再写入</strong>
            <small>只导入店铺号、扣点、销售额和月份</small>
          </div>
        </div>
      </div>

      <section className="erp-import-panel" aria-labelledby="erp-import-title">
        <div className="erp-import-panel__intro">
          <span>IMPORT</span>
          <div>
            <h2 id="erp-import-title">导入总表</h2>
            <p>追加会保留旧记录；替换会先删除本次涉及月份的旧记录，再写入新总表。</p>
          </div>
        </div>
        <div className="erp-import-panel__controls">
          <label className="erp-import-picker">
            <span>{erpMasterFile ? "更换总表" : "选择总表"}</span>
            <input type="file" accept={erpFileAccept} onChange={handleErpFileChange} />
          </label>
          <label className="erp-month-input">
            <span>指定月份</span>
            <input
              type="text"
              value={erpMonth}
              onChange={handleErpMonthChange}
              placeholder="可选：202605"
              autoComplete="off"
            />
          </label>
          <button type="button" className="outline-button" disabled={!canPreviewErp} onClick={() => void runErpImport("preview")}>
            {erpImporting === "preview" ? "正在预览" : "预览"}
          </button>
          <button type="button" className="outline-button" disabled={!canAppendErp} onClick={() => void runErpImport("append")}>
            {erpImporting === "append" ? "正在追加" : "追加到总表"}
          </button>
          <button type="button" className="compact-primary" disabled={!canReplaceErp} onClick={() => void runErpImport("replace")}>
            {erpImporting === "replace" ? "正在写入" : "确认替换并永久删除旧记录"}
          </button>
        </div>
        <div className="erp-import-meta">
          <span>{erpMasterFile ? `${erpMasterFile.name} · ${formatFileSize(erpMasterFile.size)}` : erpFileHint}</span>
        </div>
        {erpImportError && <div className="api-error" role="alert"><b>ERP 更新失败</b><span>{erpImportError}</span></div>}
        {erpImportResult && (
          <div className={`erp-import-result ${erpImportResult.written ? "erp-import-result--written" : ""}`}>
            <strong>{erpImportResult.written ? "已写入飞书 ERP 明细表" : erpImportResult.failedRows.length ? "预览完成，但存在失败行" : "预览完成，尚未写入"}</strong>
            <div>
              {erpImportResult.months.map((month) => (
                <span key={month.month}>
                  {month.month}：有效 {month.rows} 行，已有 {month.existingRows} 行，新增 {month.createdRows} 行，覆盖 {month.updatedRows} 行，删除 {month.deletedRows} 行，销售额 {moneyFormatter.format(month.salesTotal)}，扣点后 {moneyFormatter.format(month.netSalesTotal)}
                </span>
              ))}
            </div>
            {erpImportResult.failedRows.length > 0 && (
              <div className="erp-import-failures">
                {erpImportResult.failedRows.map((row) => <span key={`${row.row}:${row.reason}`}>第 {row.row} 行：{row.reason}</span>)}
              </div>
            )}
            <table className="erp-preview-table">
              <thead>
                <tr>
                  <th>月份</th>
                  <th>源行</th>
                  <th>店铺号</th>
                  <th>扣点</th>
                  <th>销售额</th>
                </tr>
              </thead>
              <tbody>
                {erpImportResult.months.flatMap((month) => month.sampleRows.map((row) => (
                  <tr key={`${row.month}:${row.shopNo}:${row.deductionRate}:${row.salesAmount}`}>
                    <td>{row.month}</td>
                    <td>{row.sourceRow ?? "-"}</td>
                    <td>{row.shopNo}</td>
                    <td>{moneyFormatter.format(row.deductionRate * 100)}%</td>
                    <td>{moneyFormatter.format(row.salesAmount)}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
