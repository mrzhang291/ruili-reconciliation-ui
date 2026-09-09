import { useCallback, useEffect, useMemo, useState } from "react";
import { reconciliationApi } from "../api";
import type {
  ErpRecord,
  ErpRecordInput,
  ErpSortDirection,
  ErpSortField,
  ListErpRecordsParams,
} from "../model/types";
import { requestErrorMessage } from "../model/view-model";

type ErpDetailsViewProps = {
  onDirtyChange: (dirty: boolean) => void;
};

type FilterState = {
  month: string;
  shopNo: string;
};

type Draft = {
  shopNo: string;
  deductionRate: string;
  salesAmount: string;
  month: string;
};

type ModalState = {
  mode: "create" | "edit";
  recordId?: string;
  draft: Draft;
};

const emptyFilters: FilterState = { month: "", shopNo: "" };
const pageSize = 50;
const columns: Array<{ field: ErpSortField; label: string }> = [
  { field: "month", label: "月份" },
  { field: "shopNo", label: "店铺号" },
  { field: "deductionRate", label: "扣点" },
  { field: "salesAmount", label: "销售额" },
];
const numberFormatter = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function ErpDetailsView({ onDirtyChange }: ErpDetailsViewProps) {
  const [filters, setFilters] = useState(emptyFilters);
  const [query, setQuery] = useState(emptyFilters);
  const [sortField, setSortField] = useState<ErpSortField>("month");
  const [sortDirection, setSortDirection] = useState<ErpSortDirection>("desc");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<ErpRecord[]>([]);
  const [months, setMonths] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState("");
  const [error, setError] = useState("");
  const [edits, setEdits] = useState<Record<string, Draft>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [modal, setModal] = useState<ModalState | null>(null);
  const [modalError, setModalError] = useState("");

  const dirty = Object.keys(edits).length > 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const listParams = useMemo<ListErpRecordsParams>(() => ({
    ...query,
    page,
    pageSize,
    sortField,
    sortDirection,
  }), [page, query, sortDirection, sortField]);

  const loadOptions = useCallback(async () => {
    const options = await reconciliationApi.getErpFilterOptions();
    setMonths(options.months);
  }, []);

  const loadRows = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await reconciliationApi.listErpRecords(listParams);
      setRows(result.items);
      setTotal(result.total);
    } catch (requestError) {
      setError(requestErrorMessage(requestError, "ERP 明细加载失败"));
    } finally {
      setLoading(false);
    }
  }, [listParams]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadRows(), 0);
    return () => window.clearTimeout(timer);
  }, [loadRows]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadOptions().catch((requestError) => setError(requestErrorMessage(requestError, "筛选选项加载失败")));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadOptions]);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const confirmDiscard = () => {
    if (!dirty) return true;
    const confirmed = window.confirm("当前有未保存的 ERP 行内修改，继续操作会丢弃这些修改。");
    if (confirmed) {
      setEdits({});
      setRowErrors({});
    }
    return confirmed;
  };

  const runQuery = () => {
    if (!confirmDiscard()) return;
    setQuery(filters);
    setPage(1);
  };

  const resetFilters = () => {
    if (!confirmDiscard()) return;
    setFilters(emptyFilters);
    setQuery(emptyFilters);
    setPage(1);
  };

  const changePage = (nextPage: number) => {
    if (!confirmDiscard()) return;
    setPage(Math.min(pageCount, Math.max(1, nextPage)));
  };

  const changeSort = (field: ErpSortField) => {
    if (!confirmDiscard()) return;
    setSortDirection((current) => (sortField === field && current === "asc" ? "desc" : "asc"));
    setSortField(field);
    setPage(1);
  };

  const updateDraft = (record: ErpRecord, field: keyof Draft, value: string) => {
    setEdits((current) => ({
      ...current,
      [record.id]: { ...toDraft(record), ...current[record.id], [field]: value },
    }));
    setRowErrors((current) => ({ ...current, [record.id]: "" }));
  };

  const saveAll = async () => {
    const entries = Object.entries(edits);
    if (!entries.length) return;

    const validUpdates: Array<{ id: string; values: ErpRecordInput }> = [];
    const clientErrors: Record<string, string> = {};
    for (const [id, draft] of entries) {
      try {
        validUpdates.push({ id, values: draftToInput(draft) });
      } catch (validationError) {
        clientErrors[id] = validationError instanceof Error ? validationError.message : String(validationError);
      }
    }
    setRowErrors(clientErrors);
    if (!validUpdates.length) return;

    setSaving(true);
    try {
      const result = await reconciliationApi.batchUpdateErpRecords(validUpdates);
      const nextErrors = { ...clientErrors };
      const saved = new Map<string, ErpRecord>();
      for (const item of result.items) {
        if (item.success && item.record) {
          saved.set(item.id, item.record);
          delete nextErrors[item.id];
        } else {
          nextErrors[item.id] = item.error ?? "保存失败";
        }
      }
      setRows((current) => current.map((row) => saved.get(row.id) ?? row));
      setEdits((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !saved.has(id))));
      setRowErrors(nextErrors);
      await loadOptions();
    } catch (requestError) {
      setError(requestErrorMessage(requestError, "批量保存失败"));
    } finally {
      setSaving(false);
    }
  };

  const openCreate = () => {
    setModal({ mode: "create", draft: emptyDraft(query.month || currentMonth()) });
    setModalError("");
  };

  const openEdit = (record: ErpRecord) => {
    setModal({ mode: "edit", recordId: record.id, draft: edits[record.id] ?? toDraft(record) });
    setModalError("");
  };

  const saveModal = async () => {
    if (!modal) return;
    setSaving(true);
    setModalError("");
    try {
      const input = draftToInput(modal.draft);
      const saved = modal.mode === "create"
        ? await reconciliationApi.createErpRecord(input)
        : await reconciliationApi.updateErpRecord(modal.recordId ?? "", input);
      if (modal.mode === "edit") {
        setRows((current) => current.map((row) => row.id === saved.id ? saved : row));
        setEdits((current) => {
          const next = { ...current };
          delete next[saved.id];
          return next;
        });
      } else {
        await loadRows();
      }
      await loadOptions();
      setModal(null);
    } catch (requestError) {
      setModalError(requestErrorMessage(requestError, "保存 ERP 明细失败"));
    } finally {
      setSaving(false);
    }
  };

  const deleteRow = async (record: ErpRecord) => {
    const confirmed = window.confirm(
      `确定永久删除这条 ERP 明细吗？\n\n店铺号：${record.shopNo}\n月份：${record.month}\n销售额：${numberFormatter.format(record.salesAmount)}\n\n新增、编辑、删除会影响后续对账，但不会自动重算已经完成的历史对账任务。`,
    );
    if (!confirmed) return;
    setDeletingId(record.id);
    setError("");
    try {
      await reconciliationApi.deleteErpRecord(record.id);
      setRows((current) => current.filter((row) => row.id !== record.id));
      setTotal((current) => Math.max(0, current - 1));
      await loadOptions();
    } catch (requestError) {
      setError(requestErrorMessage(requestError, "删除 ERP 明细失败"));
    } finally {
      setDeletingId("");
    }
  };

  return (
    <div className="view-shell erp-view">
      <div className="page-intro page-intro--split">
        <div>
          <span className="eyebrow">ERP DETAILS</span>
          <h1>ERP 明细</h1>
          <p>直接查看和维护飞书 ERP 明细表；这里的改动只影响后续对账，不自动重算历史任务。</p>
        </div>
        <button type="button" className="compact-primary" onClick={openCreate}>新增明细</button>
      </div>

      <section className="erp-filter-panel">
        <label>
          <span>月份</span>
          <select value={filters.month} onChange={(event) => setFilters((current) => ({ ...current, month: event.target.value }))}>
            <option value="">全部月份</option>
            {months.map((month) => <option key={month} value={month}>{month}</option>)}
          </select>
        </label>
        <label>
          <span>店铺号</span>
          <input value={filters.shopNo} onChange={(event) => setFilters((current) => ({ ...current, shopNo: event.target.value }))} />
        </label>
        <button type="button" className="outline-button" onClick={runQuery}>查询</button>
        <button type="button" className="text-button" onClick={resetFilters}>重置筛选</button>
      </section>

      <section className="records-section erp-records-section">
        <div className="records-head">
          <div><h2>飞书 ERP 明细</h2><span>共 {total} 条，每页 50 条</span></div>
          <div className="erp-record-actions">
            <span>{dirty ? `${Object.keys(edits).length} 行未保存` : "无未保存修改"}</span>
            <button type="button" className="compact-primary" disabled={!dirty || saving} onClick={() => void saveAll()}>
              {saving ? "保存中" : "保存全部"}
            </button>
          </div>
        </div>

        {error && <div className="api-error overview-error" role="alert"><b>ERP 接口错误</b><span>{error}</span></div>}

        <div className="table-wrap">
          <table className="erp-table">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column.field}>
                    <button type="button" onClick={() => changeSort(column.field)}>
                      {column.label}{sortField === column.field ? (sortDirection === "asc" ? " ↑" : " ↓") : ""}
                    </button>
                  </th>
                ))}
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {rows.map((record) => {
                const draft = edits[record.id] ?? toDraft(record);
                return (
                  <tr key={record.id} className={`${edits[record.id] ? "erp-row--dirty" : ""} ${rowErrors[record.id] ? "erp-row--error" : ""}`}>
                    <td><input value={draft.month} onChange={(event) => updateDraft(record, "month", event.target.value)} /></td>
                    <td><input value={draft.shopNo} onChange={(event) => updateDraft(record, "shopNo", event.target.value.toUpperCase())} /></td>
                    <td><input value={draft.deductionRate} inputMode="decimal" onChange={(event) => updateDraft(record, "deductionRate", event.target.value)} /></td>
                    <td>
                      <input value={draft.salesAmount} inputMode="decimal" onChange={(event) => updateDraft(record, "salesAmount", event.target.value)} />
                      {rowErrors[record.id] && <small>{rowErrors[record.id]}</small>}
                    </td>
                    <td>
                      <div className="row-actions">
                        <button type="button" className="row-action" title="弹窗编辑" onClick={() => openEdit(record)}>…</button>
                        <button type="button" className="row-delete" title="删除" disabled={deletingId === record.id} onClick={() => void deleteRow(record)}>
                          {deletingId === record.id ? "…" : "×"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {loading && <div className="empty-state"><b>正在读取 ERP 明细</b><span>请稍候</span></div>}
          {!loading && !error && rows.length === 0 && <div className="empty-state"><b>没有找到 ERP 明细</b><span>试试更换筛选条件</span></div>}
        </div>

        <div className="pagination" aria-label="ERP 明细分页">
          <span>第 {page} / {pageCount} 页</span>
          <div>
            <button type="button" disabled={page === 1} onClick={() => changePage(page - 1)}>上一页</button>
            <button type="button" disabled={page >= pageCount} onClick={() => changePage(page + 1)}>下一页</button>
          </div>
        </div>
      </section>

      {modal && (
        <div className="drawer-backdrop erp-modal" role="presentation">
          <button type="button" className="drawer-dismiss" aria-label="关闭" onClick={() => setModal(null)} />
          <section className="detail-drawer" role="dialog" aria-modal="true" aria-labelledby="erp-modal-title">
            <button type="button" className="drawer-close" onClick={() => setModal(null)}>×</button>
            <h2 id="erp-modal-title">{modal.mode === "create" ? "新增 ERP 明细" : "编辑 ERP 明细"}</h2>
            <p className="erp-modal-note">保存后立即写入飞书；不会自动重算已经完成的历史对账任务。</p>
            <ErpDraftForm draft={modal.draft} onChange={(draft) => setModal((current) => current ? { ...current, draft } : current)} />
            {modalError && <div className="api-error" role="alert"><b>保存失败</b><span>{modalError}</span></div>}
            <button type="button" className="primary-button drawer-button" disabled={saving} onClick={() => void saveModal()}>
              {saving ? "保存中" : "保存"}
            </button>
          </section>
        </div>
      )}
    </div>
  );
}

function ErpDraftForm({ draft, onChange }: { draft: Draft; onChange: (draft: Draft) => void }) {
  const setField = (field: keyof Draft, value: string) => onChange({ ...draft, [field]: field === "shopNo" ? value.toUpperCase() : value });
  return (
    <div className="erp-form-grid">
      <label><span>店铺号</span><input value={draft.shopNo} onChange={(event) => setField("shopNo", event.target.value)} /></label>
      <label><span>扣点</span><input inputMode="decimal" value={draft.deductionRate} onChange={(event) => setField("deductionRate", event.target.value)} /></label>
      <label><span>销售额</span><input inputMode="decimal" value={draft.salesAmount} onChange={(event) => setField("salesAmount", event.target.value)} /></label>
      <label><span>月份</span><input value={draft.month} onChange={(event) => setField("month", event.target.value)} placeholder="YYYYMM" /></label>
    </div>
  );
}

function toDraft(record: ErpRecord): Draft {
  return {
    shopNo: record.shopNo,
    deductionRate: String(record.deductionRate),
    salesAmount: String(record.salesAmount),
    month: record.month,
  };
}

function emptyDraft(month: string): Draft {
  return { shopNo: "", deductionRate: "", salesAmount: "", month };
}

function draftToInput(draft: Draft): ErpRecordInput {
  const deductionRate = Number(draft.deductionRate);
  const salesAmount = Number(draft.salesAmount);
  const month = draft.month.trim();
  const errors = [
    draft.shopNo.trim() ? "" : "店铺号为必填",
    /^20\d{2}(0[1-9]|1[0-2])$/.test(month) ? "" : "月份必须为 YYYYMM",
    Number.isFinite(deductionRate) && deductionRate >= 0 && deductionRate <= 1 ? "" : "扣点必须是 0 到 1 的数字",
    Number.isFinite(salesAmount) ? "" : "销售额必须是数字",
  ].filter(Boolean);
  if (errors.length) throw new Error(errors.join("；"));
  return {
    shopNo: draft.shopNo.trim().toUpperCase(),
    deductionRate,
    salesAmount,
    month,
  };
}

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
}
