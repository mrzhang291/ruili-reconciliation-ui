import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CREDENTIALS_PATH = path.join(ROOT, ".runtime", "config", "credentials.json");
const credentialNames = ["cherryApiKey"];
const KEYCHAIN_SERVICE = "com.ruili.reconciliation";

function runDpapi(mode, value) {
  if (process.platform !== "win32") throw new Error("本机凭据加密目前仅支持 Windows");
  const script = mode === "protect"
    ? [
        "Add-Type -AssemblyName System.Security",
        "$plain = [Console]::In.ReadToEnd()",
        "$bytes = [Text.Encoding]::UTF8.GetBytes($plain)",
        "$encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
        "[Console]::Out.Write([Convert]::ToBase64String($encrypted))",
      ].join("; ")
    : [
        "Add-Type -AssemblyName System.Security",
        "$encrypted = [Convert]::FromBase64String([Console]::In.ReadToEnd())",
        "$bytes = [Security.Cryptography.ProtectedData]::Unprotect($encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
        "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))",
      ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", script], {
    input: value,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(`无法使用 Windows 当前用户保护本机凭据：${result.stderr.trim()}`);
  return result.stdout;
}

export const protectSecret = (value) => runDpapi("protect", value);
export const unprotectSecret = (value) => runDpapi("unprotect", value);

function runSecurity(args, allowMissing = false) {
  const result = spawnSync("security", args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (!result.error && result.status === 0) return result.stdout;
  const details = result.error?.message || result.stderr.trim();
  if (allowMissing && (result.status === 44 || /could not be found/i.test(details))) return null;
  throw new Error(`无法访问 macOS 钥匙串：${details || `security 退出码 ${result.status}`}`);
}

export function keychainArguments(action, name, value = "") {
  if (!credentialNames.includes(name)) throw new Error(`未知凭据：${name}`);
  if (action === "read") return ["find-generic-password", "-a", name, "-s", KEYCHAIN_SERVICE, "-w"];
  if (action === "status") return ["find-generic-password", "-a", name, "-s", KEYCHAIN_SERVICE];
  if (action === "save") return ["add-generic-password", "-a", name, "-s", KEYCHAIN_SERVICE, "-w", value, "-U"];
  if (action === "delete") return ["delete-generic-password", "-a", name, "-s", KEYCHAIN_SERVICE];
  throw new Error(`未知钥匙串操作：${action}`);
}

function readKeychainCredential(name) {
  const output = runSecurity(keychainArguments("read", name), true);
  return output === null ? "" : output.replace(/\r?\n$/, "");
}

function keychainCredentialExists(name) {
  return runSecurity(keychainArguments("status", name), true) !== null;
}

function readEncryptedCredentials() {
  if (!existsSync(CREDENTIALS_PATH)) return {};
  const payload = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8"));
  if (payload?.version !== 1 || !payload.values || typeof payload.values !== "object") {
    throw new Error("本机凭据文件格式不正确");
  }
  return payload.values;
}

export function readCredentials() {
  if (process.platform === "darwin") {
    return Object.fromEntries(credentialNames.map((name) => [name, readKeychainCredential(name)]));
  }
  if (process.platform !== "win32") throw new Error(`暂不支持 ${process.platform} 的本机凭据存储`);
  const encrypted = readEncryptedCredentials();
  return Object.fromEntries(credentialNames.map((name) => [
    name,
    typeof encrypted[name] === "string" && encrypted[name] ? unprotectSecret(encrypted[name]) : "",
  ]));
}

export function credentialStatus() {
  if (process.platform === "darwin") {
    return Object.fromEntries(credentialNames.map((name) => [name, keychainCredentialExists(name)]));
  }
  if (process.platform !== "win32") throw new Error(`暂不支持 ${process.platform} 的本机凭据存储`);
  const encrypted = readEncryptedCredentials();
  return Object.fromEntries(credentialNames.map((name) => [name, Boolean(encrypted[name])]));
}

export function saveCredentials(next) {
  for (const name of credentialNames) {
    const value = next[name];
    if (value === undefined || value === "") continue;
    if (typeof value !== "string" || value.length > 4096 || /[\r\n\0]/.test(value)) {
      throw new Error(`${name} 格式不正确`);
    }
  }
  if (process.platform === "darwin") {
    for (const name of credentialNames) {
      const value = next[name];
      if (value !== undefined && value !== "") runSecurity(keychainArguments("save", name, value));
    }
    return credentialStatus();
  }
  if (process.platform !== "win32") throw new Error(`暂不支持 ${process.platform} 的本机凭据存储`);
  const encrypted = readEncryptedCredentials();
  for (const name of credentialNames) {
    const value = next[name];
    if (value === undefined || value === "") continue;
    encrypted[name] = protectSecret(value);
  }
  mkdirSync(path.dirname(CREDENTIALS_PATH), { recursive: true });
  writeFileSync(CREDENTIALS_PATH, `${JSON.stringify({ version: 1, values: encrypted }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return credentialStatus();
}

export function clearCredentials(names) {
  if (process.platform === "darwin") {
    for (const name of names) {
      if (credentialNames.includes(name)) runSecurity(keychainArguments("delete", name), true);
    }
    return credentialStatus();
  }
  if (process.platform !== "win32") throw new Error(`暂不支持 ${process.platform} 的本机凭据存储`);
  const encrypted = readEncryptedCredentials();
  for (const name of names) {
    if (credentialNames.includes(name)) delete encrypted[name];
  }
  mkdirSync(path.dirname(CREDENTIALS_PATH), { recursive: true });
  writeFileSync(CREDENTIALS_PATH, `${JSON.stringify({ version: 1, values: encrypted }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return credentialStatus();
}
