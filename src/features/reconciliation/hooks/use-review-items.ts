// 文件说明：封装差异处理表格、待确认沟通话术和本地处理状态。
import { useCallback, useEffect, useRef, useState } from "react";
import { reconciliationApi } from "../api";
import type {
  ReconciliationReviewItem,
  ReconciliationReviewRow,
  ReconciliationReviewWorklistRow,
  ReviewItemStatus,
} from "../model/types";
import { requestErrorMessage } from "../model/view-model";

export type ReviewRow = {
  task: ReconciliationReviewRow["task"];
  item: ReconciliationReviewItem;
  communication?: ReconciliationReviewWorklistRow;
};

function reviewRowKey(row: Pick<ReconciliationReviewRow, "task" | "item">) {
  return `${row.task.id}:${row.item.id}`;
}

export function useReviewItems() {
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [reviewStatuses, setReviewStatuses] = useState<Record<string, ReviewItemStatus>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [errorTitle, setErrorTitle] = useState("");
  const [communicationError, setCommunicationError] = useState("");
  // Count rather than keep only one id: independent rows may save at the same time.
  const [updatingItemCounts, setUpdatingItemCounts] = useState<Record<string, number>>({});
  const updatingItemCountsRef = useRef<Record<string, number>>({});

  const changeUpdatingItemCount = useCallback((itemId: string, increment: number) => {
    const next = { ...updatingItemCountsRef.current };
    const count = (next[itemId] ?? 0) + increment;
    if (count > 0) next[itemId] = count;
    else delete next[itemId];
    updatingItemCountsRef.current = next;
    setUpdatingItemCounts(next);
  }, []);

  const isReviewStatusUpdating = useCallback(
    () => Object.keys(updatingItemCountsRef.current).length > 0,
    [],
  );

  useEffect(() => {
    let active = true;

    async function loadReviewItems() {
      try {
        setLoading(true);
        setError("");
        setErrorTitle("");
        setCommunicationError("");
        const [reviewItemsResult, worklistResult] = await Promise.allSettled([
          reconciliationApi.listReviewItems(),
          reconciliationApi.listReviewWorklist(),
        ]);

        if (reviewItemsResult.status === "rejected") throw reviewItemsResult.reason;

        const communicationByRow = new Map(
          worklistResult.status === "fulfilled"
            ? worklistResult.value.map((row) => [reviewRowKey(row), row])
            : [],
        );

        if (active) {
          setRows(reviewItemsResult.value.map((row) => ({
            ...row,
            communication: communicationByRow.get(reviewRowKey(row)),
          })));
          if (worklistResult.status === "rejected") {
            setCommunicationError(requestErrorMessage(worklistResult.reason, "沟通话术加载失败"));
          }
        }
      } catch (requestError) {
        if (active) {
          setErrorTitle("差异明细加载失败");
          setError(requestErrorMessage(requestError, "差异明细加载失败"));
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadReviewItems();
    return () => { active = false; };
  }, []);

  const pendingCount = rows.filter(({ item }) => (reviewStatuses[item.id] ?? item.status) === "PENDING").length;
  const reviewedCount = rows.length - pendingCount;

  const setReviewStatus = async (taskId: string, itemId: string, status: ReviewItemStatus) => {
    const previous = reviewStatuses[itemId];
    setReviewStatuses((current) => ({ ...current, [itemId]: status }));
    changeUpdatingItemCount(itemId, 1);
    setError("");
    setErrorTitle("");
    try {
      await reconciliationApi.updateReviewItem(taskId, itemId, status);
      setRows((current) => current.map((row) => row.item.id === itemId ? {
        ...row,
        item: { ...row.item, status },
        communication: row.communication
          ? { ...row.communication, item: { ...row.communication.item, status } }
          : undefined,
      } : row));
      setReviewStatuses((current) => {
        const next = { ...current };
        delete next[itemId];
        return next;
      });
    } catch (requestError) {
      setReviewStatuses((current) => {
        const next = { ...current };
        if (previous) next[itemId] = previous;
        else delete next[itemId];
        return next;
      });
      setErrorTitle("处理状态保存失败");
      setError(requestErrorMessage(requestError, "处理状态保存失败"));
    } finally {
      changeUpdatingItemCount(itemId, -1);
    }
  };

  return {
    rows,
    reviewStatuses,
    pendingCount,
    reviewedCount,
    loading,
    error,
    errorTitle,
    communicationError,
    updatingItemIds: Object.keys(updatingItemCounts),
    hasReviewStatusUpdates: Object.keys(updatingItemCounts).length > 0,
    isReviewStatusUpdating,
    setReviewStatus,
  };
}
