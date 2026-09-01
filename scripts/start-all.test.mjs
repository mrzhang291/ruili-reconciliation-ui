import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertPrivateNodeModules, backendHealthy, setEnvValue } from "./start-all.mjs";
import { friendlyConnectionError } from "./config-server.mjs";
import { keychainArguments, protectSecret, unprotectSecret } from "./local-config.mjs";

test("launcher writes API keys without shell interpolation", () => {
  const secret = "a b@c:/%&!\"'";
  assert.equal(setEnvValue('CHERRYSTUDIO_API_KEY=""\n', "CHERRYSTUDIO_API_KEY", secret), `CHERRYSTUDIO_API_KEY=${secret}\n`);
  assert.throws(() => setEnvValue("", "CHERRYSTUDIO_API_KEY", "line1\nline2"));
});

test("Windows current-user encryption round-trips secrets", { skip: process.platform !== "win32" }, () => {
  const secret = "密钥 a b@c:/%&!\"'";
  const encrypted = protectSecret(secret);
  assert.notEqual(encrypted, secret);
  assert.equal(unprotectSecret(encrypted), secret);
});

test("macOS keychain only accepts the remaining CherryStudio credential", () => {
  const args = keychainArguments("save", "cherryApiKey", "secret");
  assert.equal(args[args.indexOf("-w") + 1], "secret");
  assert.throws(() => keychainArguments("read", "sshPassword"), /未知凭据/);
});

test("connection errors remain actionable", () => {
  assert.equal(friendlyConnectionError("cherry", new Error("HTTP 401")), "API Key 不正确或已失效");
  assert.equal(friendlyConnectionError("lark", new Error("profile auth expired")), "飞书授权失效，请重新授权 aad27213 配置");
});

test("backend success requires CherryStudio and Feishu Base health", async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: {
      service: "billcompare", storage: "lark-base", cherryStudio: { status: "ok" }, larkBase: { status: "ok" },
    } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { assert.equal(await backendHealthy(server.address().port), true); }
  finally { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("launcher rejects shared node_modules and has no database startup path", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "billcompare-dependencies-"));
  const project = path.join(directory, "project");
  const shared = path.join(directory, "shared");
  await mkdir(project); await mkdir(shared);
  await symlink(shared, path.join(project, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  try {
    assert.throws(() => assertPrivateNodeModules(project), /不允许共享 node_modules/);
    const launcher = await readFile(new URL("./start-all.mjs", import.meta.url), "utf8");
    const serverPackage = JSON.parse(await readFile(new URL("../server/package.json", import.meta.url), "utf8"));
    assert.doesNotMatch(launcher, /ssh|prisma|postgres|database_url/i);
    assert.doesNotMatch(launcher, /tsx",\s*"watch"|tsx',\s*'watch'/);
    assert.equal(serverPackage.dependencies?.["@prisma/client"], undefined);
    assert.equal(serverPackage.devDependencies?.prisma, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("platform launchers still delegate to the cross-platform script", async () => {
  const windows = await readFile(new URL("../一键启动.ps1", import.meta.url), "utf8");
  const mac = await readFile(new URL("../一键启动.command", import.meta.url), "utf8");
  assert.match(windows, /scripts\\start-all\.mjs/);
  assert.match(mac, /scripts\/start-all\.mjs/);
});
