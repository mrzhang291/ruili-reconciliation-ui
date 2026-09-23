import fs from "node:fs";
import path from "node:path";
import { resolveReconciliationQueuePath } from "./config.js";
import type { StoredFile } from "./file-storage.js";

export type QueuedSettlementFile = {
  file: StoredFile;
  deleteAfterRun: boolean;
};

export type PersistedReconciliationRun = {
  taskId: string;
  batchId: string;
  agentSelector: { name: string; workspace?: string };
  settlementHint?: {
    name?: string;
    period?: string;
    documentLabel?: string;
    documentLabels?: string[];
  };
  settlements: QueuedSettlementFile[];
  batchDocumentIds?: string[];
  status: "QUEUED" | "PROCESSING";
  attempts: number;
  queuedAt: string;
  updatedAt: string;
};

type QueueSnapshot = {
  version: 1;
  items: PersistedReconciliationRun[];
};

// ponytail: a single-host atomic snapshot is sufficient here; add a shared leased queue only for multi-instance deployment.
const emptySnapshot = (): QueueSnapshot => ({ version: 1, items: [] });

function snapshotPath(filePath?: string) {
  return filePath ?? resolveReconciliationQueuePath();
}

function readSnapshot(filePath?: string): QueueSnapshot {
  const target = snapshotPath(filePath);
  if (!fs.existsSync(target)) return emptySnapshot();
  const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as Partial<QueueSnapshot>;
  if (parsed.version !== 1 || !Array.isArray(parsed.items)) throw new Error("对账队列快照格式不正确");
  return { version: 1, items: parsed.items };
}

function writeSnapshot(snapshot: QueueSnapshot, filePath?: string) {
  const target = snapshotPath(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(snapshot, null, 2));
  fs.renameSync(temporary, target);
}

export function listPersistedReconciliationRuns(filePath?: string) {
  return readSnapshot(filePath).items;
}

export function enqueuePersistedReconciliationRun(
  input: Omit<PersistedReconciliationRun, "status" | "attempts" | "queuedAt" | "updatedAt">,
  filePath?: string,
) {
  const snapshot = readSnapshot(filePath);
  const existing = snapshot.items.find((item) => item.taskId === input.taskId);
  if (existing) return existing;
  const now = new Date().toISOString();
  const item: PersistedReconciliationRun = {
    ...input,
    status: "QUEUED",
    attempts: 0,
    queuedAt: now,
    updatedAt: now,
  };
  snapshot.items.push(item);
  writeSnapshot(snapshot, filePath);
  return item;
}

export function claimNextPersistedReconciliationRun(filePath?: string) {
  const snapshot = readSnapshot(filePath);
  const item = snapshot.items.find((candidate) => candidate.status === "QUEUED");
  if (!item) return null;
  item.status = "PROCESSING";
  item.attempts += 1;
  item.updatedAt = new Date().toISOString();
  writeSnapshot(snapshot, filePath);
  return item;
}

export function recoverPersistedReconciliationRuns(filePath?: string) {
  const snapshot = readSnapshot(filePath);
  let changed = false;
  const now = new Date().toISOString();
  for (const item of snapshot.items) {
    if (item.status !== "PROCESSING") continue;
    item.status = "QUEUED";
    item.updatedAt = now;
    changed = true;
  }
  if (changed) writeSnapshot(snapshot, filePath);
  return snapshot.items;
}

export function removePersistedReconciliationRun(taskId: string, filePath?: string) {
  const snapshot = readSnapshot(filePath);
  const index = snapshot.items.findIndex((item) => item.taskId === taskId);
  if (index < 0) return null;
  const [item] = snapshot.items.splice(index, 1);
  writeSnapshot(snapshot, filePath);
  return item;
}

export function findPersistedReconciliationRun(taskId: string, filePath?: string) {
  return readSnapshot(filePath).items.find((item) => item.taskId === taskId) ?? null;
}
