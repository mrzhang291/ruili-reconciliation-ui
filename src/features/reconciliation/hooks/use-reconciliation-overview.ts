// 文件说明：封装总览页的任务查询、统计查询、任务轮询和详情打开逻辑。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { reconciliationApi } from "../api";
import type {
  ReconciliationStatistics,
  ReconciliationTaskSummary,
} from "../model/types";
import {
  requestErrorMessage,
  statusFilters,
  toViewModel,
  type ReconciliationFilter,
  type ReconciliationView,
} from "../model/view-model";

export const reconciliationOverviewPageSize = 20;

const emptyFacets = {
  total: 0,
  byStatus: { QUEUED: 0, PROCESSING: 0, SUCCEEDED: 0, NEEDS_REVIEW: 0, REVIEWED: 0, FAILED: 0, CANCELLED: 0, OBSOLETE: 0 },
};

export function useReconciliationOverview() {
  const [filter, setFilter] = useState<ReconciliationFilter>("all");
  const [query, setQuery] = useState("");
  const [tasks, setTasks] = useState<ReconciliationTaskSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState(emptyFacets);
  const [page, setPage] = useState(1);
  const [statistics, setStatistics] = useState<ReconciliationStatistics | null>(null);
  const [statisticsError, setStatisticsError] = useState("");
  const [selected, setSelected] = useState<ReconciliationView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);
  const [stoppingTaskId, setStoppingTaskId] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const loadTasks = useCallback(async () => {
    const requestNumber = ++requestSequence.current;
    try {
      setError("");
      const result = await reconciliationApi.listTasks({
        status: filter === "all" ? undefined : statusFilters[filter],
        keyword: query.trim() || undefined,
        page,
        pageSize: reconciliationOverviewPageSize,
      });
      if (requestNumber !== requestSequence.current) return;
      setTasks(result.items);
      setTotal(result.total);
      setFacets(result.facets);
    } catch (requestError) {
      if (requestNumber !== requestSequence.current) return;
      setError(requestErrorMessage(requestError, "历史任务加载失败"));
    } finally {
      if (requestNumber === requestSequence.current) setLoading(false);
    }
  }, [filter, page, query]);

  const loadStatistics = useCallback(async () => {
    try {
      setStatistics(await reconciliationApi.getStatistics());
      setStatisticsError("");
    } catch (requestError) {
      setStatistics(null);
      setStatisticsError(requestErrorMessage(requestError, "总览统计加载失败"));
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(loadTasks, query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [loadTasks, query]);

  useEffect(() => {
    let active = true;

    reconciliationApi.getStatistics()
      .then((result) => { if (active) { setStatistics(result); setStatisticsError(""); } })
      .catch((requestError) => { if (active) { setStatistics(null); setStatisticsError(requestErrorMessage(requestError, "总览统计加载失败")); } });

    return () => { active = false; };
  }, []);

  const hasActiveTask = tasks.some((task) => task.status === "QUEUED" || task.status === "PROCESSING");

  useEffect(() => {
    if (!hasActiveTask) return;

    const activeTaskIds = tasks
      .filter((task) => task.status === "QUEUED" || task.status === "PROCESSING")
      .map((task) => task.id);

    const refreshActiveTasks = async () => {
      const results = await Promise.allSettled(activeTaskIds.map((taskId) => reconciliationApi.getTask(taskId)));
      const refreshed = new Map(
        results
          .filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof reconciliationApi.getTask>>> => result.status === "fulfilled")
          .map((result) => [result.value.id, result.value]),
      );
      const transitionedOutOfProcessing = tasks.some((task) => {
        const nextTask = refreshed.get(task.id);
        return nextTask && (task.status === "QUEUED" || task.status === "PROCESSING")
          && nextTask.status !== "QUEUED" && nextTask.status !== "PROCESSING";
      });
      setTasks((current) => current.map((task) => refreshed.get(task.id) ?? task));
      setSelected((current) => {
        if (!current) return null;
        const refreshedTask = refreshed.get(current.id);
        return refreshedTask ? { ...toViewModel(refreshedTask), failure: refreshedTask.failure?.message ?? null } : current;
      });
      if (filter === "processing" && transitionedOutOfProcessing) void loadTasks();
      void loadStatistics();
    };

    const timer = window.setInterval(() => { void refreshActiveTasks(); }, 3_000);
    return () => window.clearInterval(timer);
  }, [filter, hasActiveTask, loadStatistics, loadTasks, tasks]);

  const records = useMemo(() => tasks.map(toViewModel), [tasks]);
  const counts = {
    all: facets.total,
    success: facets.byStatus.SUCCEEDED,
    issue: facets.byStatus.NEEDS_REVIEW,
    failed: facets.byStatus.FAILED,
    processing: facets.byStatus.QUEUED + facets.byStatus.PROCESSING,
    cancelled: facets.byStatus.CANCELLED,
  };
  const trend = statistics?.trend ?? [];
  const maxTrend = Math.max(...trend.map((item) => item.taskCount), 1);

  const openDetails = async (taskId: string) => {
    try {
      const detail = await reconciliationApi.getTask(taskId);
      setSelected({ ...toViewModel(detail), failure: detail.failure?.message ?? null });
    } catch (requestError) {
      setError(requestErrorMessage(requestError, "任务详情加载失败"));
    }
  };

  const deleteTask = async (taskId: string) => {
    setDeletingTaskId(taskId);
    setError("");
    try {
      await reconciliationApi.deleteTask(taskId);
      setSelected((current) => current?.id === taskId ? null : current);
      if (tasks.length === 1 && page > 1) {
        setPage((current) => Math.max(1, current - 1));
      } else {
        await loadTasks();
      }
      await loadStatistics();
    } catch (requestError) {
      setError(requestErrorMessage(requestError, "删除对账任务失败"));
    } finally {
      setDeletingTaskId(null);
    }
  };

  const stopTask = async (taskId: string) => {
    setStoppingTaskId(taskId);
    setError("");
    try {
      await reconciliationApi.stopTask(taskId);
      await Promise.all([loadTasks(), loadStatistics()]);
    } catch (requestError) {
      setError(requestErrorMessage(requestError, "停止对账任务失败"));
    } finally {
      setStoppingTaskId(null);
    }
  };

  return {
    filter,
    setFilter,
    query,
    setQuery,
    total,
    page,
    setPage,
    statistics,
    statisticsError,
    selected,
    closeDetails: () => setSelected(null),
    loading,
    error,
    records,
    counts,
    trend,
    maxTrend,
    openDetails,
    deleteTask,
    deletingTaskId,
    stopTask,
    stoppingTaskId,
    pageSize: reconciliationOverviewPageSize,
  };
}
