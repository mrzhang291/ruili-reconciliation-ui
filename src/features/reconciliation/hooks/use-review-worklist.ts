// 文件说明：加载只读的“待确认清单”；处理状态统一由“差异处理”页面维护。
import { useCallback, useEffect, useRef, useState } from "react";
import { reconciliationApi } from "../api";
import type { ReconciliationReviewWorklistRow } from "../model/types";
import { requestErrorMessage } from "../model/view-model";

export type ReviewWorklistRow = ReconciliationReviewWorklistRow;

export function useReviewWorklist() {
  const [rows, setRows] = useState<ReviewWorklistRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [errorTitle, setErrorTitle] = useState("");
  const activeRef = useRef(true);
  const latestLoadIdRef = useRef(0);

  const refreshWorklist = useCallback(async () => {
    const loadId = ++latestLoadIdRef.current;
    if (activeRef.current) {
      setLoading(true);
      setError("");
      setErrorTitle("");
    }

    try {
      const result = await reconciliationApi.listReviewWorklist();
      if (activeRef.current && loadId === latestLoadIdRef.current) setRows(result);
    } catch (requestError) {
      if (activeRef.current && loadId === latestLoadIdRef.current) {
        setErrorTitle("待确认事项加载失败");
        setError(requestErrorMessage(requestError, "待确认事项加载失败"));
      }
    } finally {
      if (activeRef.current && loadId === latestLoadIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    activeRef.current = true;
    void refreshWorklist();
    return () => { activeRef.current = false; };
  }, [refreshWorklist]);

  return { rows, loading, error, errorTitle };
}
