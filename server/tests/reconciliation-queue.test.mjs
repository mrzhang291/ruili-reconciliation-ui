import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  claimNextPersistedReconciliationRun,
  enqueuePersistedReconciliationRun,
  findPersistedReconciliationRun,
  listPersistedReconciliationRuns,
  recoverPersistedReconciliationRuns,
  removePersistedReconciliationRun,
} from "../dist/lib/reconciliation-queue.js";

function queuedRun(taskId) {
  return {
    taskId,
    batchId: "batch-real",
    agentSelector: { name: "锐力" },
    settlements: [],
  };
}

test("persists queued work and returns interrupted work to the queue after restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "billcompare-queue-"));
  const queueFile = path.join(directory, "queue.json");
  try {
    enqueuePersistedReconciliationRun(queuedRun("rec-first"), queueFile);
    enqueuePersistedReconciliationRun(queuedRun("rec-second"), queueFile);

    assert.equal(claimNextPersistedReconciliationRun(queueFile)?.taskId, "rec-first");
    assert.equal(listPersistedReconciliationRuns(queueFile)[0].status, "PROCESSING");

    const recovered = recoverPersistedReconciliationRuns(queueFile);
    assert.deepEqual(recovered.map((item) => [item.taskId, item.status]), [
      ["rec-first", "QUEUED"],
      ["rec-second", "QUEUED"],
    ]);
    assert.equal(claimNextPersistedReconciliationRun(queueFile)?.taskId, "rec-first");
    assert.equal(removePersistedReconciliationRun("rec-first", queueFile)?.taskId, "rec-first");
    assert.deepEqual(listPersistedReconciliationRuns(queueFile).map((item) => item.taskId), ["rec-second"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("finds durable queue work during the gap before it is registered in memory", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "billcompare-queue-"));
  const queueFile = path.join(directory, "queue.json");
  try {
    assert.equal(findPersistedReconciliationRun("rec-durable-gap", queueFile), null);
    enqueuePersistedReconciliationRun(queuedRun("rec-durable-gap"), queueFile);
    assert.equal(findPersistedReconciliationRun("rec-durable-gap", queueFile)?.taskId, "rec-durable-gap");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
