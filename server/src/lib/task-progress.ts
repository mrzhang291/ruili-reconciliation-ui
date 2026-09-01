export type TaskProgressLog = {
  id: string;
  timestamp: string;
  level: "info" | "success" | "error";
  message: string;
  details?: string;
  expanded?: boolean;
};

type ProgressEntry = {
  logs: TaskProgressLog[];
  touchedAt: number;
};

const progressByTask = new Map<string, ProgressEntry>();
const retentionMs = 60 * 60 * 1000;
const maxLogsPerTask = 300;

function removeExpiredEntries() {
  const cutoff = Date.now() - retentionMs;
  for (const [taskId, entry] of progressByTask) {
    if (entry.touchedAt < cutoff) progressByTask.delete(taskId);
  }
}

export function initializeTaskProgress(taskId: string, logs: TaskProgressLog[]) {
  removeExpiredEntries();
  progressByTask.set(taskId, {
    logs: logs.slice(-maxLogsPerTask),
    touchedAt: Date.now(),
  });
}

export function appendTaskProgress(taskId: string, log: TaskProgressLog) {
  removeExpiredEntries();
  const entry = progressByTask.get(taskId) ?? { logs: [], touchedAt: Date.now() };
  const existingIndex = entry.logs.findIndex((item) => item.id === log.id);
  if (existingIndex >= 0) {
    entry.logs[existingIndex] = { ...log, timestamp: entry.logs[existingIndex].timestamp };
  } else {
    entry.logs.push(log);
  }
  if (entry.logs.length > maxLogsPerTask) {
    entry.logs.splice(0, entry.logs.length - maxLogsPerTask);
  }
  entry.touchedAt = Date.now();
  progressByTask.set(taskId, entry);
}

export function getTaskProgress(taskId: string) {
  removeExpiredEntries();
  return progressByTask.get(taskId)?.logs ?? [];
}

export function removeTaskProgress(taskId: string) {
  progressByTask.delete(taskId);
}
