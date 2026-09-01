// 文件说明：启动前端开发服务器；若3333端口被占用，先终止占用该端口的进程。
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import process from "node:process";

const port = 3333;

function findWindowsPids() {
  try {
    const output = execFileSync("netstat", ["-ano", "-p", "tcp"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pids = new Set();
    for (const line of output.split(/\r?\n/)) {
      const columns = line.trim().split(/\s+/);
      if (
        columns.length >= 5 &&
        columns[0] === "TCP" &&
        columns[1].endsWith(`:${port}`) &&
        columns[3] === "LISTENING"
      ) {
        pids.add(columns[4]);
      }
    }
    return [...pids];
  } catch {
    return [];
  }
}

function findUnixPids() {
  try {
    const output = execFileSync("lsof", ["-ti", `:${port}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return [...new Set(output.split(/\s+/).filter(Boolean))];
  } catch {
    return [];
  }
}

const pids = process.platform === "win32" ? findWindowsPids() : findUnixPids();
for (const pid of pids) {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(Number(pid), "SIGTERM");
    }
    console.log(`已终止占用${port}端口的进程：${pid}`);
  } catch {
    // 进程可能已在检查后自行退出，继续启动即可。
  }
}

const viteBin = process.platform === "win32" ? "node_modules/vite/bin/vite.js" : "node_modules/.bin/vite";
if (!existsSync(viteBin)) {
  console.error("未找到Vite，请先执行 npm install。\n");
  process.exit(1);
}

const child = spawn(process.execPath, [viteBin, "--host", "127.0.0.1"], {
  stdio: "inherit",
  shell: false,
});

child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : code ?? 1);
});
