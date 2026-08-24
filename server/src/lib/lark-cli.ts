import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export class LarkCliError extends Error {
  constructor(message: string, readonly code = "LARK_CLI_ERROR") {
    super(message);
    this.name = "LarkCliError";
  }
}

function resolveCliEntry() {
  if (process.platform !== "win32") return { command: "lark-cli", prefix: [] as string[] };
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const entry = path.join(directory, "node_modules", "@larksuite", "cli", "scripts", "run.js");
    if (fs.existsSync(entry)) return { command: process.execPath, prefix: [entry] };
  }
  throw new LarkCliError("未找到全局 lark-cli，请先安装并授权 profile aad27213", "LARK_CLI_NOT_FOUND");
}

function errorDetail(error: unknown) {
  if (error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string") {
    try {
      const payload = JSON.parse(error.stderr) as { error?: { message?: string; hint?: string } };
      return [payload.error?.message, payload.error?.hint].filter(Boolean).join("；");
    } catch {
      return error.stderr.trim().slice(0, 500);
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export async function runLarkCli<T = Record<string, unknown>>(args: string[], cwd = projectRoot): Promise<T> {
  const { command, prefix } = resolveCliEntry();
  try {
    const { stdout } = await execFileAsync(command, [...prefix, "--profile", config.lark.profile, ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
      },
    });
    const payload = JSON.parse(stdout) as { ok?: boolean; error?: { message?: string } } & T;
    if (payload.ok !== true) throw new LarkCliError(payload.error?.message || "lark-cli 返回失败");
    return payload;
  } catch (error) {
    if (error instanceof LarkCliError) throw error;
    throw new LarkCliError(errorDetail(error));
  }
}

export function relativeCliPath(absolutePath: string) {
  const relativePath = path.relative(projectRoot, path.resolve(absolutePath));
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new LarkCliError("lark-cli 文件必须位于项目目录内", "LARK_CLI_UNSAFE_PATH");
  }
  return relativePath;
}
