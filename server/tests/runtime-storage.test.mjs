import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { config } from "../dist/lib/config.js";
import {
  cleanupTaskWorkDir,
  prepareTaskWorkDir,
  resolveTaskWorkDir,
} from "../dist/lib/runtime-storage.js";

test("creates, resets, and removes an isolated task work directory", () => {
  const originalTaskWorkDir = config.taskWorkDir;
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "billcompare-runtime-"));
  config.taskWorkDir = temporaryRoot;

  try {
    const taskDirectory = prepareTaskWorkDir("task-123");
    fs.writeFileSync(path.join(taskDirectory, "artifact.md"), "temporary");

    assert.equal(prepareTaskWorkDir("task-123"), taskDirectory);
    assert.deepEqual(fs.readdirSync(taskDirectory), []);

    cleanupTaskWorkDir("task-123");
    assert.equal(fs.existsSync(taskDirectory), false);
    assert.throws(() => resolveTaskWorkDir("../outside"), /不安全/);
  } finally {
    config.taskWorkDir = originalTaskWorkDir;
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
