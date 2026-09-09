import assert from "node:assert/strict";
import test from "node:test";
import {
  appendTaskProgress,
  getTaskProgress,
  initializeTaskProgress,
  removeTaskProgress,
} from "../dist/lib/task-progress.js";

const log = (id, message, options = {}) => ({
  id,
  timestamp: options.timestamp ?? new Date().toISOString(),
  level: "info",
  message,
  details: options.details,
  expanded: options.expanded,
});

test("updates a stable log in place and keeps its first timestamp", () => {
  const taskId = "stable-log";
  initializeTaskProgress(taskId, [log("reasoning", "正在思考…", {
    timestamp: "2026-08-13T00:00:00.000Z",
    details: "first",
    expanded: true,
  })]);

  appendTaskProgress(taskId, log("reasoning", "思考过程", {
    timestamp: "2026-08-13T00:00:01.000Z",
    details: "first\nsecond",
    expanded: false,
  }));

  assert.deepEqual(getTaskProgress(taskId), [log("reasoning", "思考过程", {
    timestamp: "2026-08-13T00:00:00.000Z",
    details: "first\nsecond",
    expanded: false,
  })]);
  removeTaskProgress(taskId);
});

test("keeps at most 300 task logs", () => {
  const taskId = "bounded-log";
  initializeTaskProgress(taskId, []);
  for (let index = 0; index < 301; index += 1) {
    appendTaskProgress(taskId, log(String(index), String(index)));
  }

  const logs = getTaskProgress(taskId);
  assert.equal(logs.length, 300);
  assert.equal(logs[0].id, "1");
  assert.equal(logs.at(-1).id, "300");
  removeTaskProgress(taskId);
});
