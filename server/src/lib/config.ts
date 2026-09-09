import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// 读取 .env 文件（简单实现，不引入 dotenv 依赖）
function loadEnvFile() {
  const envPath = path.join(SERVER_ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

function intFromEnv(key: string, fallback: number) {
  const value = process.env[key];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: intFromEnv("PORT", 3001),
  host: process.env.HOST || "127.0.0.1",
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "http://127.0.0.1:3333,http://localhost:3333")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  uploadDir: process.env.UPLOAD_DIR || "../.runtime/data/uploads",
  taskWorkDir: process.env.TASK_WORK_DIR || "../.runtime/tasks",
  cherryStudio: {
    baseUrl: (process.env.CHERRYSTUDIO_BASE_URL || "http://127.0.0.1:24333").replace(/\/$/, ""),
    apiKey: process.env.CHERRYSTUDIO_API_KEY || "",
    defaultAgentName: process.env.CHERRYSTUDIO_DEFAULT_AGENT_NAME || "锐力",
    defaultAgentWorkspace: process.env.CHERRYSTUDIO_DEFAULT_AGENT_WORKSPACE || "",
    lookupTimeoutMs: intFromEnv("CHERRYSTUDIO_LOOKUP_TIMEOUT_MS", 15_000),
    requestTimeoutMs: intFromEnv("CHERRYSTUDIO_REQUEST_TIMEOUT_MS", 20 * 60 * 1000),
  },
  reconciliation: {
    maxConcurrentTasks: Math.max(1, intFromEnv("RECONCILIATION_MAX_CONCURRENT_TASKS", 1)),
  },
  lark: {
    profile: "aad27213",
    baseToken: process.env.LARK_BASE_TOKEN || "PgrCbbHxyaHtQLsNa8ac1gnLn2f",
    knowledgeTableId: process.env.LARK_KNOWLEDGE_TABLE_ID || "tbliMWw8XUfbWmuX",
    taskTableId: process.env.LARK_TASK_TABLE_ID || "tblrpKbGxi38PnIU",
    reviewTableId: process.env.LARK_REVIEW_TABLE_ID || "tblrlpUs9nlY0dCW",
    erpTableId: process.env.LARK_ERP_TABLE_ID || "tblx7K2MXNLintEO",
  },
  maxUploadBytes: 20 * 1024 * 1024, // 20 MB
};

export function resolveUploadDir() {
  return path.resolve(SERVER_ROOT, config.uploadDir);
}

export function resolveTaskWorkRoot() {
  return path.resolve(SERVER_ROOT, config.taskWorkDir);
}
