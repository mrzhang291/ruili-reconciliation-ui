// 文件说明：对账任务执行与处理日志的全局状态提供者。
// 挂在 App 根部，任务执行与日志状态常驻，切换页面不丢失。
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { reconciliationApi, ReconciliationApiError } from "../api";
import { validateErpFile, validateReconciliationFile } from "../model/file-rules";
import type { ReconciliationProcessLog, ReconciliationTaskSummary } from "../model/types";
import { requestErrorMessage } from "../model/view-model";

export type StartReconciliationInput = {
  settlementFile: File;
  erpFile?: File | null;
  agentName: string;
  agentWorkspace: string;
};

export type StartBatchReconciliationInput = {
  batchId: string;
};

type ReconciliationTaskContextValue = {
  running: boolean;
  canStop: boolean;
  stopping: boolean;
  logs: ReconciliationProcessLog[];
  error: string;
  startReconciliation: (input: StartReconciliationInput) => Promise<void>;
  startBatchReconciliation: (input: StartBatchReconciliationInput) => Promise<void>;
  stopReconciliation: () => Promise<void>;
};

const ReconciliationTaskContext = createContext<ReconciliationTaskContextValue | null>(null);
const pollIntervalMs = 1_500;
const pollTimeoutMs = 20 * 60 * 1000;
const maxConsecutivePollFailures = 8;
const activeTaskStorageKey = "billcompare.activeTaskId";

const wait = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

function parseStoredActiveTaskIds(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string" && Boolean(item));
  } catch {
    // 兼容旧版本只存单个 taskId 的格式。
  }
  return [value];
}

function storeActiveTaskIds(taskIds: string[]) {
  if (!taskIds.length) {
    window.localStorage.removeItem(activeTaskStorageKey);
    return;
  }
  window.localStorage.setItem(activeTaskStorageKey, JSON.stringify(taskIds));
}

function decorateTaskLogs(
  taskId: string,
  label: string | undefined,
  serverLogs: ReconciliationProcessLog[] | undefined,
) {
  if (!label) return serverLogs;
  return serverLogs?.map((log) => ({
    ...log,
    id: `${taskId}:${log.id}`,
    message: log.message.startsWith(`[${label}]`) ? log.message : `[${label}] ${log.message}`,
  }));
}

export function useReconciliationTask(): ReconciliationTaskContextValue {
  const value = useContext(ReconciliationTaskContext);
  if (!value) throw new Error("useReconciliationTask 必须在 ReconciliationTaskProvider 内使用");
  return value;
}

type ReconciliationTaskProviderProps = {
  onComplete: (task: ReconciliationTaskSummary) => void;
  children: ReactNode;
};

export function ReconciliationTaskProvider({ onComplete, children }: ReconciliationTaskProviderProps) {
  const [restoredTaskIds] = useState(() => parseStoredActiveTaskIds(window.localStorage.getItem(activeTaskStorageKey)));
  const [running, setRunning] = useState(() => restoredTaskIds.length > 0);
  const [logs, setLogs] = useState<ReconciliationProcessLog[]>(() => restoredTaskIds.length ? [{
    id: "local:1",
    timestamp: new Date().toISOString(),
    level: "info",
    message: restoredTaskIds.length === 1
      ? `正在恢复任务 ${restoredTaskIds[0]} 的处理进度…`
      : `正在恢复 ${restoredTaskIds.length} 个批量对账任务的处理进度…`,
  }] : []);
  const [error, setError] = useState("");
  const [activeTaskIds, setActiveTaskIds] = useState<string[]>(restoredTaskIds);
  const [stopping, setStopping] = useState(false);
  const logIdRef = useRef(restoredTaskIds.length ? 1 : 0);
  const activeTaskIdsRef = useRef<string[]>(restoredTaskIds);
  const restoreStartedRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  const appendLog = useCallback((level: ReconciliationProcessLog["level"], message: string) => {
    const log: ReconciliationProcessLog = {
      id: `local:${++logIdRef.current}`,
      timestamp: new Date().toISOString(),
      level,
      message,
    };
    setLogs((prev) => [...prev, log]);
  }, []);

  const upsertServerLogs = useCallback((serverLogs: ReconciliationProcessLog[] | undefined) => {
    if (!serverLogs?.length) return;
    setLogs((previous) => {
      const next = [...previous];
      for (const log of serverLogs) {
        const index = next.findIndex((item) => item.id === log.id);
        if (index >= 0) next[index] = { ...log, timestamp: next[index].timestamp };
        else next.push(log);
      }
      return next;
    });
  }, []);

  const replaceActiveTaskIds = useCallback((taskIds: string[]) => {
    activeTaskIdsRef.current = taskIds;
    setActiveTaskIds(taskIds);
    storeActiveTaskIds(taskIds);
  }, []);

  const removeActiveTaskId = useCallback((taskId: string) => {
    const nextTaskIds = activeTaskIdsRef.current.filter((id) => id !== taskId);
    replaceActiveTaskIds(nextTaskIds);
    if (!nextTaskIds.length) setRunning(false);
    return nextTaskIds.length;
  }, [replaceActiveTaskIds]);

  const monitorTask = useCallback(async (taskId: string, logLabel?: string, notifyComplete = true) => {
    const deadline = Date.now() + pollTimeoutMs;
    let current = await getTaskWithRetry(taskId, deadline, appendLog);
    const shouldPrefixLogs = Boolean(logLabel);
    let label = logLabel;

    while (current.status === "QUEUED" || current.status === "PROCESSING") {
      if (shouldPrefixLogs) label ??= current.settlementFile.name || current.name || taskId;
      upsertServerLogs(decorateTaskLogs(taskId, label, current.progressLogs));
      if (Date.now() >= deadline) throw new Error("对账处理超时，请在总览中查看任务状态");
      await wait(pollIntervalMs);
      current = await getTaskWithRetry(taskId, deadline, appendLog);
    }

    const displayLabel = label ?? (current.settlementFile.name || current.name || taskId);
    upsertServerLogs(decorateTaskLogs(taskId, label, current.progressLogs));
    const ownsTask = activeTaskIdsRef.current.includes(taskId);
    if (ownsTask) removeActiveTaskId(taskId);
    if (current.status === "FAILED") {
      const message = current.failure?.message || "Agent 对账失败";
      throw new Error(shouldPrefixLogs ? `[${displayLabel}] ${message}` : message);
    }
    if (current.status === "CANCELLED") {
      return;
    }
    if (ownsTask && notifyComplete) onCompleteRef.current(current);
    return current;
  }, [appendLog, removeActiveTaskId, upsertServerLogs]);

  useEffect(() => {
    if (!restoredTaskIds.length || restoreStartedRef.current) return;
    restoreStartedRef.current = true;
    void Promise.allSettled(restoredTaskIds.map(async (taskId) => {
      try {
        await monitorTask(taskId, restoredTaskIds.length > 1 ? taskId : undefined, restoredTaskIds.length === 1);
      } catch (requestError) {
        if (requestError instanceof ReconciliationApiError && requestError.status === 404) removeActiveTaskId(taskId);
        throw requestError;
      }
    })).then((results) => {
      const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (!failed.length) return;
      const message = requestErrorMessage(failed[0].reason, "恢复对账任务失败");
      appendLog("error", failed.length > 1 ? `${message}，另有 ${failed.length - 1} 个任务恢复失败` : message);
      setError(message);
      if (!activeTaskIdsRef.current.length) setRunning(false);
    });
  }, [appendLog, monitorTask, removeActiveTaskId, restoredTaskIds]);

  const startReconciliation = useCallback(async (input: StartReconciliationInput) => {
    if (running) return;
    if (!input.settlementFile) return;
    const validationError = validateReconciliationFile(input.settlementFile);
    if (validationError) {
      setError(validationError);
      return;
    }
    const erpValidationError = input.erpFile ? validateErpFile(input.erpFile) : "";
    if (erpValidationError) {
      setError(erpValidationError);
      return;
    }
    const agentName = input.agentName.trim();
    if (!agentName) {
      setError("请填写 Agent 名称");
      return;
    }

    setRunning(true);
    setError("");
    setLogs([]);
    logIdRef.current = 0;
    appendLog("info", "点击「开始对账」，任务已提交");
    try {
      const task = await reconciliationApi.createTask({
        settlementFile: input.settlementFile,
        erpFile: input.erpFile ?? undefined,
        agentSelector: {
          name: agentName,
          workspace: input.agentWorkspace.trim() || undefined,
        },
        onProgress: (log) => upsertServerLogs([log]),
      });
      replaceActiveTaskIds([task.id]);
      await monitorTask(task.id);
    } catch (requestError) {
      if (requestError instanceof ReconciliationApiError && requestError.status === 404) {
        replaceActiveTaskIds([]);
      }
      const message = requestErrorMessage(requestError, "创建对账任务失败，请稍后重试");
      appendLog("error", message);
      setError(message);
      setRunning(false);
    }
  }, [running, appendLog, monitorTask, replaceActiveTaskIds, upsertServerLogs]);

  const startBatchReconciliation = useCallback(async (input: StartBatchReconciliationInput) => {
    if (running) return;
    if (!input.batchId) {
      setError("请先完成批量预检");
      return;
    }

    setRunning(true);
    setError("");
    setLogs([]);
    logIdRef.current = 0;
    appendLog("info", `确认执行批量对账批次 ${input.batchId}`);
    try {
      const result = await reconciliationApi.createBatchTasks({
        batchId: input.batchId,
        onProgress: (log) => upsertServerLogs([log]),
      });
      const createdItems = result.items.filter((item): item is typeof item & { taskId: string } => Boolean(item.taskId));
      const blockedCount = result.rejected + result.failed;
      if (!createdItems.length) {
        const message = blockedCount ? `批量创建失败：${blockedCount} 个文件未创建任务` : "批量创建失败：没有返回可跟踪任务";
        appendLog("error", message);
        setError(message);
        setRunning(false);
        return;
      }

      replaceActiveTaskIds(createdItems.map((item) => item.taskId));
      appendLog("success", `已创建 ${createdItems.length} 个对账任务，开始跟踪处理结果`);
      if (blockedCount) appendLog("error", `${blockedCount} 个文件未创建任务，已在日志中标出原因`);

      const settled = await Promise.allSettled(
        createdItems.map((item) => monitorTask(item.taskId, item.fileName, false)),
      );
      const failed = settled.filter((item): item is PromiseRejectedResult => item.status === "rejected");
      const needsReview = settled.filter((item) => item.status === "fulfilled" && item.value?.status === "NEEDS_REVIEW");
      if (failed.length) {
        const message = `${failed.length} 个批量任务处理失败，详情见任务总览`;
        appendLog("error", message);
        setError(message);
      } else if (needsReview.length) {
        appendLog("success", `批量对账完成，${needsReview.length} 个任务待审核`);
      } else if (blockedCount) {
        setError(`${blockedCount} 个文件未创建任务，其他任务已完成`);
      } else {
        appendLog("success", "批量对账已完成");
      }
    } catch (requestError) {
      const message = requestErrorMessage(requestError, "批量创建对账任务失败，请稍后重试");
      appendLog("error", message);
      setError(message);
      replaceActiveTaskIds([]);
      setRunning(false);
    }
  }, [running, appendLog, monitorTask, replaceActiveTaskIds, upsertServerLogs]);

  const stopReconciliation = useCallback(async () => {
    const taskIds = activeTaskIds.length ? activeTaskIds : parseStoredActiveTaskIds(window.localStorage.getItem(activeTaskStorageKey));
    if (!taskIds.length || stopping) return;
    setStopping(true);
    setError("");
    appendLog("info", taskIds.length === 1 ? "正在停止对账任务…" : `正在停止 ${taskIds.length} 个批量对账任务…`);
    try {
      const results = await Promise.allSettled(taskIds.map((taskId) => reconciliationApi.stopTask(taskId)));
      const failed = results.filter((result) => result.status === "rejected");
      if (failed.length === taskIds.length) {
        throw failed[0].reason;
      }
      replaceActiveTaskIds([]);
      setRunning(false);
      appendLog("success", failed.length ? `已停止 ${taskIds.length - failed.length} 个对账任务，${failed.length} 个停止失败` : "对账任务已停止");
      if (failed.length) setError(`${failed.length} 个任务停止失败，请在总览中查看状态`);
    } catch (requestError) {
      const message = requestErrorMessage(requestError, "停止对账任务失败");
      appendLog("error", message);
      setError(message);
    } finally {
      setStopping(false);
    }
  }, [activeTaskIds, appendLog, replaceActiveTaskIds, stopping]);

  return (
    <ReconciliationTaskContext.Provider value={{
      running,
      canStop: activeTaskIds.length > 0,
      stopping,
      logs,
      error,
      startReconciliation,
      startBatchReconciliation,
      stopReconciliation,
    }}>
      {children}
    </ReconciliationTaskContext.Provider>
  );
}

async function getTaskWithRetry(
  taskId: string,
  deadline: number,
  appendLog: (level: ReconciliationProcessLog["level"], message: string) => void,
) {
  let failureCount = 0;
  while (true) {
    try {
      const task = await reconciliationApi.getTask(taskId);
      if (failureCount > 0) appendLog("success", "已重新连接后端，继续跟踪任务");
      return task;
    } catch (error) {
      failureCount += 1;
      if (error instanceof ReconciliationApiError && error.status && error.status < 500) throw error;
      if (failureCount === 1) appendLog("info", "后端连接暂时中断，正在自动重连…");
      if (failureCount >= maxConsecutivePollFailures || Date.now() >= deadline) throw error;
      await wait(Math.min(1_000 * 2 ** (failureCount - 1), 8_000));
    }
  }
}
