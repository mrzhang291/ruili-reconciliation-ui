import { useEffect, useState } from "react";

const configBaseUrl = "http://127.0.0.1:3334";
type StoredStatus = { cherryApiKey: boolean };
type CheckResult = { status: "ok" | "error" | "skipped"; message: string };
type Results = { cherry: CheckResult; lark: CheckResult; backend: CheckResult };

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${configBaseUrl}${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `请求失败（HTTP ${response.status}）`);
  return payload.data as T;
}

export function ConnectionSettingsView() {
  const [stored, setStored] = useState<StoredStatus>({ cherryApiKey: false });
  const [secureStorage, setSecureStorage] = useState("系统安全存储");
  const [larkProfile, setLarkProfile] = useState("aad27213");
  const [cherryApiKey, setCherryApiKey] = useState("");
  const [results, setResults] = useState<Results | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void request<{ stored: StoredStatus; secureStorage: string; larkProfile: string }>("/api/config")
      .then((data) => { setStored(data.stored); setSecureStorage(data.secureStorage); setLarkProfile(data.larkProfile); })
      .catch((error) => setMessage(error instanceof Error ? error.message : "无法读取本机配置"))
      .finally(() => setLoaded(true));
  }, []);

  const ready = loaded && Boolean(cherryApiKey || stored.cherryApiKey);
  const testAndSave = async () => {
    setBusy(true); setMessage(""); setResults(null);
    try {
      const data = await request<{ ok: boolean; results: Results; stored: StoredStatus }>("/api/config/test-and-save", { cherryApiKey });
      setResults(data.results); setStored(data.stored);
      setMessage(data.ok ? "连接正常，任务将直接保存到飞书多维表格。" : "连接未全部通过，请按检测结果处理后重试。");
      if (data.ok) setCherryApiKey("");
    } catch (error) { setMessage(error instanceof Error ? error.message : "检测失败"); }
    finally { setBusy(false); }
  };

  return (
    <div className="view-shell settings-view">
      <header className="page-intro page-intro--split">
        <div>
          <span className="eyebrow">LOCAL CONNECTION</span>
          <h1>连接设置</h1>
          <p>只需配置 CherryStudio API Key。飞书使用已授权的全局配置 {larkProfile}，不再连接 SSH 或 PostgreSQL。</p>
        </div>
        <div className="security-note"><span>⌁</span><div><strong>{secureStorage}</strong><small>配置服务仅监听 127.0.0.1</small></div></div>
      </header>

      <section className="settings-card">
        <label>
          <span><b>1</b> CherryStudio API Key <Stored loaded={loaded} saved={stored.cherryApiKey} changed={Boolean(cherryApiKey)} /></span>
          <input type="password" autoComplete="off" value={cherryApiKey} onChange={(event) => { setCherryApiKey(event.target.value); setResults(null); setMessage(""); }} placeholder={stored.cherryApiKey ? "已有本机配置；留空继续使用" : "请输入 API Key"} />
        </label>

        {results && <div className="connection-results">
          <Result label="CherryStudio" result={results.cherry} />
          <Result label="飞书多维表格" result={results.lark} />
          <Result label="本地兼容接口" result={results.backend} />
        </div>}
        {message && <div className={`settings-message settings-message--${results?.cherry.status === "ok" && results?.lark.status === "ok" && results?.backend.status === "ok" ? "success" : "error"}`} role="status">{message}</div>}
        <div className="settings-actions">
          <button type="button" className="primary-button" disabled={busy || !ready} onClick={() => void testAndSave()}>{busy ? "正在检测连接…" : "检测通过并保存"}</button>
          {!ready && loaded && <small>请填写 CherryStudio API Key</small>}
        </div>
      </section>
    </div>
  );
}

function Stored({ loaded, saved, changed }: { loaded: boolean; saved: boolean; changed: boolean }) {
  const text = !loaded ? "读取中" : changed ? "待验证" : saved ? "本机已有值" : "待填写";
  return <em className={!changed && saved ? "stored stored--yes" : "stored"}>{text}</em>;
}

function Result({ label, result }: { label: string; result: CheckResult }) {
  const icon = result.status === "ok" ? "✓" : result.status === "error" ? "×" : "—";
  return <div className={`check-result check-result--${result.status}`}><b>{icon}</b><span><strong>{label}</strong><small>{result.message}</small></span></div>;
}
