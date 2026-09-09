import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { credentialStatus, readCredentials, saveCredentials } from "./local-config.mjs";
import { ensureBackend, loadSettings, testLark } from "./start-all.mjs";

const host = "127.0.0.1";
const port = 3334;

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "http://127.0.0.1:3333" });
  res.end(JSON.stringify(data));
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function testCherry(apiKey, settings) {
  if (!apiKey) throw new Error("请填写 CherryStudio API Key");
  const baseUrl = settings.values.CHERRYSTUDIO_BASE_URL || "http://127.0.0.1:23333";
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/agents?limit=1`, {
    headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`CherryStudio HTTP ${response.status}`);
}

export function friendlyConnectionError(target, error) {
  const message = error instanceof Error ? error.message : String(error);
  if (target === "cherry" && /401|403/.test(message)) return "API Key 不正确或已失效";
  if (target === "lark" && /auth|login|授权|token|profile/i.test(message)) return "飞书授权失效，请重新授权 aad27213 配置";
  return message;
}

async function result(operation, success, target) {
  try { await operation; return { status: "ok", message: success }; }
  catch (error) { return { status: "error", message: friendlyConnectionError(target, error) }; }
}

async function testAndSave(input) {
  const settings = loadSettings();
  const saved = readCredentials();
  const cherryApiKey = typeof input.cherryApiKey === "string" && input.cherryApiKey ? input.cherryApiKey : saved.cherryApiKey;
  const [cherry, lark] = await Promise.all([
    result(testCherry(cherryApiKey, settings), "CherryStudio 连接正常", "cherry"),
    result(Promise.resolve().then(() => testLark(settings)), "飞书多维表格连接正常", "lark"),
  ]);
  const credentialsOk = cherry.status === "ok" && lark.status === "ok";
  if (credentialsOk && input.cherryApiKey) saveCredentials({ cherryApiKey: input.cherryApiKey });
  const backend = credentialsOk
    ? await result((async () => {
        if (!await ensureBackend(settings, cherryApiKey)) throw new Error("本地兼容接口未通过健康检查");
      })(), "本地兼容接口已启动", "backend")
    : { status: "skipped", message: "连接检查未全部通过" };
  return {
    ok: credentialsOk && backend.status === "ok", credentialsOk,
    results: { cherry, lark, backend }, stored: credentialStatus(),
  };
}

export function createConfigServer() {
  return http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "http://127.0.0.1:3333",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      });
      return res.end();
    }
    if (req.method === "GET" && req.url === "/api/config") {
      return json(res, 200, { data: {
        stored: credentialStatus(), secureStorage: process.platform === "darwin" ? "macOS 钥匙串" : "Windows 当前用户加密",
        larkProfile: "aad27213",
      } });
    }
    if (req.method === "POST" && req.url === "/api/config/test-and-save") {
      return json(res, 200, { data: await testAndSave(await body(req)) });
    }
    return json(res, 404, { error: "接口不存在" });
  } catch (error) {
    return json(res, 500, { error: error instanceof Error ? error.message : "配置服务异常" });
  }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) createConfigServer().listen(port, host, () => console.log(`[config] http://${host}:${port}`));
