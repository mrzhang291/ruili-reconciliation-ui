// 文件说明：对账处理过程日志面板，类似终端控制台，实时滚动显示各阶段输出。
// 运行时自动展开；完成后自动收起，点击标题栏可展开/收起。
import { useEffect, useRef, useState } from "react";
import type { ReconciliationProcessLog } from "../model/types";

type ProcessLogPanelProps = {
  logs: ReconciliationProcessLog[];
  running: boolean;
};

function formatTime(iso: string) {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function ProcessLogPanel({ logs, running }: ProcessLogPanelProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const prevRunningRef = useRef(running);

  useEffect(() => {
    if (running !== prevRunningRef.current) {
      prevRunningRef.current = running;
      setCollapsed(!running);
    }
  }, [running]);

  useEffect(() => {
    const body = bodyRef.current;
    if (body && !collapsed) body.scrollTop = body.scrollHeight;
  }, [logs, collapsed]);

  if (logs.length === 0) return null;

  return (
    <section className={`process-log ${collapsed ? "process-log--collapsed" : ""}`} aria-label="处理过程日志">
      <div className="process-log__header" onClick={() => setCollapsed((prev) => !prev)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setCollapsed((prev) => !prev); } }}>
        <span className="process-log__dot" aria-hidden="true" />
        <strong>处理过程</strong>
        <span className="process-log__status">{running ? "进行中…" : "已完成"}</span>
        <span className="process-log__toggle" aria-hidden="true">{collapsed ? "▶" : "▼"}</span>
      </div>
      {!collapsed && (
        <div className="process-log__body" ref={bodyRef}>
          {logs.map((log) => (
            <div key={log.id} className={`process-log__line process-log__line--${log.level}`}>
              <span className="process-log__time">{formatTime(log.timestamp)}</span>
              <span className="process-log__mark" aria-hidden="true">
                {log.level === "error" ? "✕" : log.level === "success" ? "✓" : "·"}
              </span>
              {log.details === undefined ? (
                <span className="process-log__message">{log.message}</span>
              ) : (
                <details className="process-log__message" open={log.expanded}>
                  <summary>{log.message}</summary>
                  <pre>{log.details}</pre>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
