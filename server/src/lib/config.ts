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
    defaultAgentName: process.env.CHERRYSTUDIO_DEFAULT_AGENT_NAME || "对账助手",
    defaultAgentWorkspace: process.env.CHERRYSTUDIO_DEFAULT_AGENT_WORKSPACE || "",
    lookupTimeoutMs: intFromEnv("CHERRYSTUDIO_LOOKUP_TIMEOUT_MS", 15_000),
    requestTimeoutMs: intFromEnv("CHERRYSTUDIO_REQUEST_TIMEOUT_MS", 20 * 60 * 1000),
  },
  reconciliation: {
    maxConcurrentTasks: Math.max(1, intFromEnv("RECONCILIATION_MAX_CONCURRENT_TASKS", 2)),
    queueFile: process.env.RECONCILIATION_QUEUE_FILE || "../.runtime/reconciliation-queue.json",
  },
  qqMail: {
    // QQ SMTP 的服务器参数固定，避免把邮件投递到未经确认的主机。
    host: "smtp.qq.com",
    port: 465,
    secure: true,
    credentialTarget: process.env.QQ_MAIL_CREDENTIAL_TARGET || "BillCompare.QQMail.SMTP",
    timeoutMs: Math.max(5_000, intFromEnv("QQ_MAIL_TIMEOUT_MS", 20_000)),
  },
  lark: {
    profile: "aad27213",
    baseToken: process.env.LARK_BASE_TOKEN || "",
    knowledgeTableId: process.env.LARK_KNOWLEDGE_TABLE_ID || "",
    taskTableId: process.env.LARK_TASK_TABLE_ID || "",
    reviewTableId: process.env.LARK_REVIEW_TABLE_ID || "",
    erpTableId: process.env.LARK_ERP_TABLE_ID || "",
  },
  maxUploadBytes: 20 * 1024 * 1024, // 20 MB
};

export function resolveUploadDir() {
  return path.resolve(SERVER_ROOT, config.uploadDir);
}

export function resolveTaskWorkRoot() {
  return path.resolve(SERVER_ROOT, config.taskWorkDir);
}

export function resolveReconciliationQueuePath() {
  return path.resolve(SERVER_ROOT, config.reconciliation.queueFile);
}
