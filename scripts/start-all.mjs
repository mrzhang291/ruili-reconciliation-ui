#!/usr/bin/env node
// 一键启动：本地前后端负责兼容现有页面，任务与附件持久化统一使用飞书多维表格。

import { execFileSync, spawn } from "node:child_process";
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { credentialStatus, readCredentials } from "./local-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_DIR = path.join(ROOT, "server");
const FRONTEND_PORT = 3333;
const CONFIG_PORT = 3334;
const LOG_DIR = path.join(ROOT, ".runtime", "logs");
const NO_BROWSER = process.argv.includes("--no-browser");
const RESTART = process.argv.includes("--restart");
const LARK_PROFILE = "aad27213";
const log = (message) => console.log(`[一键启动] ${message}`);

function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {};
  return Object.fromEntries(readFileSync(filePath, "utf8").split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) return [];
    const index = trimmed.indexOf("=");
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    return [[trimmed.slice(0, index).trim(), value]];
  }));
}

function intSetting(values, key, fallback) {
  const value = Number.parseInt(values[key] || "", 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function loadSettings() {
  const values = parseEnvFile(path.join(SERVER_DIR, ".env"));
  return { values, backendPort: intSetting(values, "PORT", 3001) };
}

export function setEnvValue(content, key, value) {
  if (/[\r\n]/.test(value)) throw new Error(`${key} 不能包含换行符`);
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  return pattern.test(content) ? content.replace(pattern, line) : `${content.trimEnd()}\n${line}\n`;
}

function ensureLocalEnvFiles() {
  const pairs = [
    [path.join(SERVER_DIR, ".env"), path.join(SERVER_DIR, ".env.example")],
    [path.join(ROOT, ".env.local"), path.join(ROOT, ".env.example")],
  ];
  for (const [target, example] of pairs) if (!existsSync(target)) copyFileSync(example, target);
}

export function assertPrivateNodeModules(projectDirectory) {
  const modules = path.join(projectDirectory, "node_modules");
  if (existsSync(modules) && lstatSync(modules).isSymbolicLink()) {
    throw new Error(`不允许共享 node_modules：${modules}。请删除该链接后在此目录执行 npm ci`);
  }
}

function npmInvocation(args) {
  if (process.platform !== "win32") return { command: "npm", args };
  const cli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!existsSync(cli)) throw new Error(`未找到 npm CLI：${cli}`);
  return { command: process.execPath, args: [cli, ...args] };
}

function runNpm(args, cwd, env = process.env) {
  const invocation = npmInvocation(args);
  execFileSync(invocation.command, invocation.args, { cwd, env, stdio: "inherit", windowsHide: false });
}

function ensureDependencies() {
  assertPrivateNodeModules(ROOT);
  assertPrivateNodeModules(SERVER_DIR);
  if (!existsSync(path.join(ROOT, "node_modules", "vite", "bin", "vite.js"))) {
    log("首次安装前端依赖…");
    runNpm(["ci", "--no-audit", "--no-fund"], ROOT);
  }
  if (!existsSync(path.join(SERVER_DIR, "node_modules", "tsx", "dist", "cli.mjs"))) {
    log("首次安装本地兼容接口依赖…");
    runNpm(["ci", "--no-audit", "--no-fund"], SERVER_DIR);
  }
}

export function larkCliInvocation(args = []) {
  if (process.platform !== "win32") return { command: "lark-cli", args };
  const candidates = [
    path.join(path.dirname(process.execPath), "node_modules", "@larksuite", "cli", "scripts", "run.js"),
    process.env.APPDATA && path.join(process.env.APPDATA, "npm", "node_modules", "@larksuite", "cli", "scripts", "run.js"),
  ].filter(Boolean);
  const script = candidates.find(existsSync);
  if (!script) throw new Error("未找到 lark-cli，请先安装并授权飞书命令行工具");
  return { command: process.execPath, args: [script, ...args] };
}

export function testLark(settings = loadSettings()) {
  const token = settings.values.LARK_BASE_TOKEN || "PgrCbbHxyaHtQLsNa8ac1gnLn2f";
  const invocation = larkCliInvocation([
    "--profile", LARK_PROFILE, "base", "+base-get", "--base-token", token, "--as", "user", "--format", "json",
  ]);
  const output = execFileSync(invocation.command, invocation.args, { cwd: ROOT, encoding: "utf8", windowsHide: true });
  const payload = JSON.parse(output);
  if (payload?.ok === false) throw new Error(payload?.error?.message || "飞书 Base 连接失败");
  return payload;
}

function assertPrerequisites() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error(`需要 Node.js 22.13 或更高版本，当前为 ${process.version}`);
  testLark();
}

export function portOpen(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    socket.setTimeout(1500);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
  });
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
function findWindowsPidsByPort(port) {
  try {
    const output = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const pids = new Set();
    for (const line of output.split(/\r?\n/)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length >= 5 && columns[0] === "TCP" && columns[1].endsWith(`:${port}`) && columns[3] === "LISTENING") {
        pids.add(columns[4]);
      }
    }
    return [...pids];
  } catch {
    return [];
  }
}

function stopPort(port) {
  if (process.platform !== "win32") return;
  for (const pid of findWindowsPidsByPort(port)) {
    try {
      execFileSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
      log(`已重启端口 ${port}，终止旧进程 ${pid}`);
    } catch {
      // 进程可能已退出。
    }
  }
}

function stopStaleBackendProcesses() {
  if (process.platform !== "win32") return;
  try {
    const script = [
      "$root = $env:BILLCOMPARE_ROOT",
      "$self = [int]$env:BILLCOMPARE_SELF_PID",
      "Get-CimInstance Win32_Process -Filter \"name = 'node.exe'\" |",
      "  Where-Object { $_.ProcessId -ne $self -and $_.CommandLine -like \"*$root*\" -and ($_.CommandLine -like '*server*tsx*watch src/index.ts*' -or $_.CommandLine -like '*server*dist*index.js*') } |",
      "  Select-Object -ExpandProperty ProcessId",
    ].join("\n");
    const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, BILLCOMPARE_ROOT: ROOT, BILLCOMPARE_SELF_PID: String(process.pid) },
    });
    for (const pid of output.split(/\s+/).filter(Boolean)) {
      try {
        execFileSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
        log(`已清理旧后端进程 ${pid}`);
      } catch {
        // 进程可能已退出。
      }
    }
  } catch {
    // 清理失败不阻塞启动，端口清理仍会兜底。
  }
}

function runtimeLog(name) { mkdirSync(LOG_DIR, { recursive: true }); return path.join(LOG_DIR, name); }
function spawnBackground(command, args, options, logPath) {
  const output = openSync(logPath, "a");
  const child = spawn(command, args, { ...options, detached: true, stdio: ["ignore", output, output], windowsHide: true });
  child.unref();
  closeSync(output);
  return child;
}

async function backendHealth(port, deep = false) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health${deep ? "?deep=1" : ""}`, { signal: AbortSignal.timeout(deep ? 15_000 : 3_000) });
    return response.ok ? (await response.json())?.data : null;
  } catch { return null; }
}

export async function backendHealthy(port) {
  const health = await backendHealth(port, true);
  return health?.service === "billcompare" && health.storage === "lark-base"
    && health.cherryStudio?.status === "ok" && health.larkBase?.status === "ok";
}

export async function ensureBackend(settings, cherryApiKey) {
  if (!cherryApiKey) return false;
  if (RESTART) {
    stopStaleBackendProcesses();
    stopPort(settings.backendPort);
  }
  if (await portOpen(settings.backendPort)) return backendHealthy(settings.backendPort);
  const logPath = runtimeLog("backend.log");
  runNpm(["run", "build"], SERVER_DIR, { ...process.env, CHERRYSTUDIO_API_KEY: cherryApiKey });
  spawnBackground(process.execPath, [path.join(SERVER_DIR, "dist", "index.js")], {
    cwd: SERVER_DIR, env: { ...process.env, CHERRYSTUDIO_API_KEY: cherryApiKey },
  }, logPath);
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await delay(800);
    if (await backendHealthy(settings.backendPort)) return true;
  }
  throw new Error(`本地兼容接口未通过 CherryStudio/飞书检查，详情见 ${logPath}`);
}

async function ensureConfigServer() {
  if (await portOpen(CONFIG_PORT)) return;
  const logPath = runtimeLog("config-server.log");
  spawnBackground(process.execPath, [path.join(ROOT, "scripts", "config-server.mjs")], { cwd: ROOT, env: process.env }, logPath);
  for (let attempt = 0; attempt < 20; attempt += 1) { await delay(250); if (await portOpen(CONFIG_PORT)) return; }
  throw new Error(`配置服务未启动成功，详情见 ${logPath}`);
}

async function ensureFrontend() {
  runNpm(["run", "build"], ROOT);
  if (RESTART) stopPort(FRONTEND_PORT);
  if (await portOpen(FRONTEND_PORT)) return;
  const logPath = runtimeLog("frontend.log");
  spawnBackground(process.execPath, [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "preview", "--host", "127.0.0.1", "--port", String(FRONTEND_PORT)], { cwd: ROOT, env: process.env }, logPath);
  for (let attempt = 0; attempt < 15; attempt += 1) { await delay(700); if (await portOpen(FRONTEND_PORT)) return; }
  throw new Error(`前端未启动成功，详情见 ${logPath}`);
}

function openBrowser() {
  const url = `http://127.0.0.1:${FRONTEND_PORT}/`;
  try {
    if (process.platform === "win32") execFileSync("cmd.exe", ["/c", "start", "", url]);
    else if (process.platform === "darwin") execFileSync("open", [url]);
    else execFileSync("xdg-open", [url]);
  } catch { log(`请手动访问 ${url}`); }
}

async function main() {
  log("===== 锐力对账系统一键启动 =====");
  ensureLocalEnvFiles();
  ensureDependencies();
  assertPrerequisites();
  await ensureConfigServer();
  await ensureFrontend();
  if (!NO_BROWSER) openBrowser();
  const stored = credentialStatus();
  if (!stored.cherryApiKey) { log("请在“连接设置”中填写 CherryStudio API Key"); return; }
  const ready = await ensureBackend(loadSettings(), readCredentials().cherryApiKey);
  if (ready) log("启动完成：任务数据与附件将直接写入飞书多维表格");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error) => { console.error("\n[一键启动] 启动失败：", error instanceof Error ? error.message : error); process.exit(1); });
