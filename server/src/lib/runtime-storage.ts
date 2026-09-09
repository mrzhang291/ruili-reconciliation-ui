import fs from "node:fs";
import path from "node:path";
import { resolveTaskWorkRoot } from "./config.js";

function assertTaskId(taskId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) {
    throw new Error("任务 ID 含有不安全的路径字符");
  }
}

export function resolveTaskWorkDir(taskId: string) {
  assertTaskId(taskId);
  return path.join(resolveTaskWorkRoot(), taskId);
}

export function prepareTaskWorkDir(taskId: string) {
  const directory = resolveTaskWorkDir(taskId);
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

export function cleanupTaskWorkDir(taskId: string) {
  fs.rmSync(resolveTaskWorkDir(taskId), { recursive: true, force: true });
}

export function resetTaskWorkRoot() {
  const root = resolveTaskWorkRoot();
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
}
