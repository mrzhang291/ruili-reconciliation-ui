import { config } from "./config.js";

// CherryStudio agent 调用封装
// 第一版实现：根据 agent 名找 agent 和 session，发送对账 prompt，解析结果

export type CherryIssue = {
  [key: string]: unknown;
  id?: string;
  rowId?: string;
  rowLabel?: string;
  orderNo?: string;
  field?: string;
  fieldName?: string;
  fieldLabel?: string;
  settlementValue?: string | number | null;
  settlementAmount?: string | number | null;
  erpValue?: string | number | null;
  erpAmount?: string | number | null;
  difference?: string | number | null;
  differenceAmount?: string | number | null;
  message?: string;
  suggestion?: string | null;
  status?: "PENDING" | "APPROVED" | "IGNORED";
};

export type CherryParseResult = {
  name: string;
  matched: boolean;
  erpAmount: number;
  settlementAmount: number;
  difference: number;
  issues: CherryIssue[];
  period: string;
  rawAgentPayload: {
    matched: boolean;
    erpAmount: number;
    settlementAmount: number;
    difference: number;
    issues: string;
    period: string;
    name: string;
  };
};

export type CherryAgentSession = {
  agentId: string;
  agentName: string;
  sessionId: string;
};

export type AgentSelector = {
  name?: string;
  workspace?: string;
};

export type CherryLogOptions = {
  id?: string;
  details?: string;
  expanded?: boolean;
};

export type CherryLogEmitter = (
  level: "info" | "success" | "error",
  message: string,
  options?: CherryLogOptions,
) => void;

type CherryListResponse<T> = {
  data?: T[];
  agents?: T[];
  sessions?: T[];
  total?: number;
};

type CherryAgent = { id: string; name: string; accessible_paths?: string[] };
type CherrySession = { id: string; agent_id?: string; name?: string };

export class CherryStudioError extends Error {
  constructor(message: string, readonly code = "CHERRYSTUDIO_ERROR") {
    super(message);
    this.name = "CherryStudioError";
  }
}

function requestSignal(timeoutMs: number, signal?: AbortSignal) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
}

function normalizePath(value: string) {
  const slashPath = value.trim().replace(/\\/g, "/");
  const windowsPath = /^[a-zA-Z]:\//.test(slashPath);
  const drive = windowsPath ? slashPath.slice(0, 2) : "";
  const absolute = windowsPath || slashPath.startsWith("/");
  const pathWithoutRoot = windowsPath ? slashPath.slice(2) : slashPath;
  const segments: string[] = [];

  for (const segment of pathWithoutRoot.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }

  const normalized = `${drive}${absolute ? "/" : ""}${segments.join("/")}`.replace(/\/$/, "");
  return windowsPath ? normalized.toLowerCase() : normalized;
}

async function readJson<T>(response: Response, failureMessage: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new CherryStudioError(
      `${failureMessage}（HTTP ${response.status}）：${text.slice(0, 300)}`,
      "CHERRYSTUDIO_LOOKUP_FAILED",
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CherryStudioError(`${failureMessage}：接口没有返回合法 JSON`);
  }
}

async function fetchAgentList(signal?: AbortSignal) {
  const agents: CherryAgent[] = [];
  const limit = 100;
  let offset = 0;

  while (true) {
    const response = await fetch(`${config.cherryStudio.baseUrl}/v1/agents?limit=${limit}&offset=${offset}`, {
      headers: { Authorization: `Bearer ${config.cherryStudio.apiKey}` },
      signal: requestSignal(config.cherryStudio.lookupTimeoutMs, signal),
    });
    const payload = await readJson<CherryListResponse<CherryAgent>>(response, "查询 Agent 列表失败");
    const page = payload.data ?? payload.agents ?? [];
    agents.push(...page);
    if (
      page.length === 0
      || (payload.total === undefined ? page.length < limit : agents.length >= payload.total)
    ) break;
    offset += page.length;
  }

  return agents;
}

export async function checkCherryStudioConnection() {
  if (!config.cherryStudio.apiKey) {
    throw new CherryStudioError("后端未配置 CherryStudio API Key", "CHERRYSTUDIO_API_KEY_MISSING");
  }
  const agents = await fetchAgentList();
  return { status: "ok" as const, agentCount: agents.length };
}

function buildReconciliationSessionName() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `对账-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

async function createAgentSession(agent: CherryAgent, instructions: string, signal?: AbortSignal) {
  const response = await fetch(
    `${config.cherryStudio.baseUrl}/v1/agents/${encodeURIComponent(agent.id)}/sessions`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.cherryStudio.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: buildReconciliationSessionName(),
        instructions,
      }),
      signal: requestSignal(config.cherryStudio.lookupTimeoutMs, signal),
    },
  );
  const payload = await readJson<unknown>(response, "创建 CherryStudio Session 失败");
  const session = extractSession(payload);
  if (!session?.id) {
    throw new CherryStudioError("CherryStudio 没有返回新 Session 的 ID", "SESSION_CREATE_FAILED");
  }
  return session;
}

function extractSession(input: unknown): CherrySession | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  if (typeof record.id === "string") {
    return {
      id: record.id,
      agent_id: typeof record.agent_id === "string" ? record.agent_id : undefined,
      name: typeof record.name === "string" ? record.name : undefined,
    };
  }
  for (const key of ["data", "session"] as const) {
    const session = extractSession(record[key]);
    if (session) return session;
  }
  if (Array.isArray(record.sessions)) {
    for (const value of record.sessions) {
      const session = extractSession(value);
      if (session) return session;
    }
  }
  return undefined;
}

/**
 * 解析 Agent 选择器，并为每次对账新建独立 Session。
 */
export async function resolveAgentSession(
  selector: AgentSelector,
  instructions: string,
  onLog?: CherryLogEmitter,
  signal?: AbortSignal,
): Promise<CherryAgentSession> {
  onLog?.("info", "正在查找对账 Agent…");
  if (!config.cherryStudio.apiKey) {
    throw new CherryStudioError("后端未配置 CherryStudio API Key", "CHERRYSTUDIO_API_KEY_MISSING");
  }
  const agents = await fetchAgentList(signal);

  if (agents.length === 0) {
    throw new CherryStudioError("没有找到任何 Agent，请检查 CherryStudio 配置", "AGENT_NOT_FOUND");
  }

  const name = (selector.name || config.cherryStudio.defaultAgentName || "").trim();
  const workspace = (selector.workspace || config.cherryStudio.defaultAgentWorkspace || "").trim();
  const normalizedWorkspace = workspace ? normalizePath(workspace) : "";
  const matches = agents.filter((candidate) => {
    const nameMatches = !name || candidate.name === name;
    const workspaceMatches = !normalizedWorkspace || candidate.accessible_paths?.some(
      (candidatePath) => normalizePath(candidatePath) === normalizedWorkspace,
    );
    return nameMatches && Boolean(workspaceMatches);
  });
  if (matches.length === 0) {
    throw new CherryStudioError(
      `没有找到匹配的 Agent：${JSON.stringify({ name: name || undefined, workspace: workspace || undefined })}`,
      "AGENT_NOT_FOUND",
    );
  }
  if (matches.length > 1) {
    throw new CherryStudioError("找到多个匹配 Agent，请同时填写准确名称和工作目录", "AGENT_AMBIGUOUS");
  }

  const agent = matches[0];
  onLog?.("success", `已匹配 Agent：${agent.name}`);
  onLog?.("info", "正在创建本次对账 Session…");
  const session = await createAgentSession(agent, instructions, signal);
  onLog?.("success", `Session 已创建：${session.id}`);

  return { agentId: agent.id, agentName: agent.name, sessionId: session.id };
}

/**
 * 向 agent 发送对账消息，返回解析结果。
 * prompt 中应包含文件 URL。
 * 注意：CherryStudio 消息接口返回 SSE 流，必须流式读取。
 */
export async function sendReconciliationPrompt(
  target: CherryAgentSession,
  prompt: string,
  onLog?: CherryLogEmitter,
  signal?: AbortSignal,
): Promise<CherryParseResult> {
  onLog?.("info", "正在提交对账请求至 Agent…");
  const messageUrl = `${config.cherryStudio.baseUrl}/v1/agents/${encodeURIComponent(target.agentId)}/sessions/${encodeURIComponent(target.sessionId)}/messages`;

  const response = await fetch(messageUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${config.cherryStudio.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content: prompt }),
    signal: requestSignal(config.cherryStudio.requestTimeoutMs, signal),
  });

  if (!response.ok) {
    onLog?.("error", `CherryStudio 请求失败（HTTP ${response.status}）`);
    throw new CherryStudioError(
      `CherryStudio 请求失败（HTTP ${response.status}）`,
      "CHERRYSTUDIO_AGENT_REQUEST_FAILED",
    );
  }

  const contentType = response.headers.get("content-type") ?? "";

  // SSE 流：流式读取，收集 text-delta / text-end
  if (contentType.includes("text/event-stream")) {
    const finalText = await readSseFinalText(response, onLog);
    if (!finalText.trim()) {
      throw new CherryStudioError("Agent 没有返回内容", "CHERRYSTUDIO_AGENT_EMPTY_RESPONSE");
    }
    const parsed = parseAgentResponse(finalText);
    if (!parsed) {
      throw new CherryStudioError(
        "Agent 返回格式不符合 { matched, erpAmount, settlementAmount, difference, issues, period, name } 契约",
        "CHERRYSTUDIO_AGENT_INVALID_RESPONSE",
      );
    }
    onLog?.("success", "Agent 对账完成");
    return parsed;
  }

  // 普通 JSON
  const text = await response.text();
  if (!text.trim()) {
    throw new CherryStudioError("Agent 没有返回内容", "CHERRYSTUDIO_AGENT_EMPTY_RESPONSE");
  }
  const parsed = parseAgentResponse(text);
  if (!parsed) {
    throw new CherryStudioError(
      "Agent 返回格式不符合 { matched, erpAmount, settlementAmount, difference, issues, period, name } 契约",
      "CHERRYSTUDIO_AGENT_INVALID_RESPONSE",
    );
  }
  onLog?.("success", "Agent 对账完成");
  return parsed;
}

export async function deleteAgentSession(target: CherryAgentSession) {
  const response = await fetch(
    `${config.cherryStudio.baseUrl}/v1/agents/${encodeURIComponent(target.agentId)}/sessions/${encodeURIComponent(target.sessionId)}`,
    {
      method: "DELETE",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.cherryStudio.apiKey}`,
      },
      signal: requestSignal(config.cherryStudio.lookupTimeoutMs),
    },
  );
  if (!response.ok && response.status !== 404) {
    const message = (await response.text()).slice(0, 300);
    throw new CherryStudioError(
      `停止 CherryStudio Session 失败（HTTP ${response.status}）：${message}`,
      "CHERRYSTUDIO_SESSION_STOP_FAILED",
    );
  }
}

type SseEvent = {
  type?: string;
  text?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  providerMetadata?: {
    raw?: {
      message?: {
        content?: Array<{ text?: string }>;
      };
    };
  };
};

function singleLine(value: string, maxLength: number) {
  const line = value.split(/\r?\n/).find((item) => item.trim());
  const trimmed = (line ?? value).trim().replace(/\s+/g, " ");
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
}

function toolInputSummary(input: unknown): string {
  if (typeof input === "string") return singleLine(input, 80);
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    const command = typeof record.command === "string" ? record.command : undefined;
    const description = typeof record.description === "string" ? record.description : undefined;
    const first = command ?? description;
    if (typeof first === "string") return singleLine(first, 80);
    const value = Object.values(record).find((item) => typeof item === "string");
    if (typeof value === "string") return singleLine(value, 80);
  }
  return "";
}

function rawDetail(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export async function readSseFinalText(
  response: Response,
  onLog?: CherryLogEmitter,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const decoder = new TextDecoder();
  let chunkBuffer = "";
  let deltaText = "";
  let finalText = "";
  let reasoningText = "";
  let reasoningId: string | undefined;
  let reasoningUpdateTimer: ReturnType<typeof setTimeout> | undefined;

  const updateReasoning = (expanded: boolean) => {
    if (reasoningText.trim() && reasoningId) {
      onLog?.("info", expanded ? "正在思考…" : "思考过程", {
        id: reasoningId,
        details: reasoningText,
        expanded,
      });
    }
  };

  const scheduleReasoningUpdate = () => {
    if (reasoningUpdateTimer) return;
    reasoningUpdateTimer = setTimeout(() => {
      reasoningUpdateTimer = undefined;
      updateReasoning(true);
    }, 100);
  };

  const flushReasoning = () => {
    if (reasoningUpdateTimer) clearTimeout(reasoningUpdateTimer);
    reasoningUpdateTimer = undefined;
    updateReasoning(false);
    reasoningText = "";
    reasoningId = undefined;
  };

  const handleEventData = (data: string) => {
    const trimmed = data.trim();
    if (!trimmed || trimmed === "[DONE]") return;

    let event: SseEvent;
    try {
      event = JSON.parse(trimmed) as SseEvent;
    } catch {
      return;
    }

    switch (event.type) {
      case "start":
        onLog?.("info", "Agent 开始处理…");
        break;
      case "start-step":
        flushReasoning();
        onLog?.("info", "进入新的处理步骤…");
        break;
      case "reasoning-start":
        flushReasoning();
        reasoningId = crypto.randomUUID();
        break;
      case "reasoning-delta":
        if (typeof event.text === "string") {
          reasoningId ??= crypto.randomUUID();
          reasoningText += event.text;
          scheduleReasoningUpdate();
        }
        break;
      case "reasoning-end":
      case "finish-step":
        flushReasoning();
        break;
      case "tool-call": {
        flushReasoning();
        const name = event.toolName ?? "工具";
        const detail = toolInputSummary(event.input);
        onLog?.("info", `调用工具 ${name}${detail ? `：${detail}` : ""}`, {
          details: rawDetail(event.input),
        });
        break;
      }
      case "tool-result": {
        flushReasoning();
        const name = event.toolName ?? "工具";
        const detail = typeof event.output === "string" ? singleLine(event.output, 60) : "";
        onLog?.("success", `${name} 执行完成${detail ? `：${detail}` : ""}`, {
          details: rawDetail(event.output),
        });
        break;
      }
      case "tool-error": {
        flushReasoning();
        const name = event.toolName ?? "工具";
        const detail = typeof event.error === "string" ? singleLine(event.error, 60) : "";
        onLog?.("error", `${name} 执行出错${detail ? `：${detail}` : ""}`, {
          details: rawDetail(event.error),
        });
        break;
      }
      case "finish":
        flushReasoning();
        onLog?.("success", "Agent 处理完成，正在整理最终结果…");
        break;
    }

    if (event.type === "text-delta" && typeof event.text === "string") {
      // CherryStudio providers may emit either cumulative or incremental deltas.
      deltaText = event.text.startsWith(deltaText) ? event.text : deltaText + event.text;
    }
    if (event.type === "text-end") {
      const content = event.providerMetadata?.raw?.message?.content;
      if (Array.isArray(content)) {
        const joined = content.map((block) => block.text ?? "").join("");
        if (joined) finalText = joined;
      }
    }
  };

  const consumeBuffer = () => {
    let sepIndex: number;
    while ((sepIndex = chunkBuffer.search(/\r?\n\r?\n/)) >= 0) {
      const rawEvent = chunkBuffer.slice(0, sepIndex);
      chunkBuffer = chunkBuffer.slice(sepIndex + (chunkBuffer[sepIndex] === "\r" ? 4 : 2));
      for (const line of rawEvent.split(/\r?\n/)) {
        if (line.startsWith("data:")) handleEventData(line.slice(5));
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunkBuffer += decoder.decode(value, { stream: true });
    consumeBuffer();
  }

  if (chunkBuffer.trim()) {
    for (const line of chunkBuffer.split(/\r?\n/)) {
      if (line.startsWith("data:")) handleEventData(line.slice(5));
    }
  }

  flushReasoning();

  return finalText || deltaText;
}

/**
 * 解析 agent 返回的文本（JSON 或 SSE 流中的 JSON）。
 * 从各种嵌套结构里提取 { matched, difference, issues }。
 */
export function parseAgentResponse(text: string): CherryParseResult | null {
  // 尝试从整段文本解析
  const direct = tryParseObject(text);
  if (direct) return direct;

  // SSE：提取 data 行里的 JSON
  const dataLines = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]");

  // 从后往前找最后一段含 { } 的数据
  for (let i = dataLines.length - 1; i >= 0; i--) {
    const parsed = tryParseObject(dataLines[i]);
    if (parsed) return parsed;
  }

  // 尝试拼接所有 delta 文本
  const allDelta = dataLines.join("");
  if (allDelta) {
    const joined = tryParseObject(allDelta);
    if (joined) return joined;
  }

  // 兜底：找文本里第一个 { ... }
  const startIndex = text.indexOf("{");
  const endIndex = text.lastIndexOf("}");
  if (startIndex >= 0 && endIndex > startIndex) {
    const candidate = text.slice(startIndex, endIndex + 1);
    const extracted = tryParseObject(candidate);
    if (extracted) return extracted;
  }

  return null;
}

function tryParseObject(text: string): CherryParseResult | null {
  if (!text.trim()) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return null;
  }

  return extractResult(parsed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractResult(input: unknown): CherryParseResult | null {
  if (!isRecord(input)) return null;

  // 顶层必须符合七字段契约。
  if (typeof input.matched === "boolean") {
    const expectedKeys = [
      "matched",
      "erpAmount",
      "settlementAmount",
      "difference",
      "issues",
      "period",
      "name",
    ];
    const inputKeys = Object.keys(input);
    if (inputKeys.length !== expectedKeys.length || !expectedKeys.every((key) => inputKeys.includes(key))) {
      return null;
    }

    const reportedDifference = typeof input.difference === "number" && Number.isFinite(input.difference)
      ? input.difference
      : null;
    const erpAmount = typeof input.erpAmount === "number" && Number.isFinite(input.erpAmount)
      ? input.erpAmount
      : null;
    const settlementAmount = typeof input.settlementAmount === "number" && Number.isFinite(input.settlementAmount)
      ? input.settlementAmount
      : null;
    const name = extractTaskName(input.name);
    const period = extractPeriod(input);
    if (
      reportedDifference === null
      || erpAmount === null
      || settlementAmount === null
      || !name
      || !period
      || typeof input.issues !== "string"
    ) return null;

    const issueSummary = input.issues.trim();
    const rawAgentPayload = {
      matched: input.matched,
      erpAmount,
      settlementAmount,
      difference: reportedDifference,
      issues: input.issues,
      period,
      name,
    };

    return finalizeAgentResult({
      name,
      matched: input.matched,
      erpAmount,
      settlementAmount,
      difference: reportedDifference,
      issues: issueSummary
        ? [{
            rowLabel: "疑似问题",
            fieldName: "疑似问题",
            differenceAmount: reportedDifference,
            message: issueSummary,
            suggestion: null,
          }]
        : [],
      period,
      rawAgentPayload,
    });
  }

  // 嵌套在 data / result / message.content / choices[0].message.content 里
  const candidates: unknown[] = [];
  if (isRecord(input.data)) candidates.push(input.data);
  if (isRecord(input.result)) candidates.push(input.result);
  if (isRecord(input.message)) candidates.push(input.message);

  for (const candidate of candidates) {
    const extracted = extractResult(candidate);
    if (extracted) return extracted;
  }

  // choices[0].message.content 是字符串，可能是 JSON
  if (Array.isArray(input.choices) && isRecord(input.choices[0]) && isRecord(input.choices[0].message)) {
    const content = input.choices[0].message.content;
    if (typeof content === "string") {
      const nested = tryParseObject(content);
      if (nested) return nested;
    }
  }

  return null;
}

function extractTaskName(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  const hasControlCharacter = Array.from(normalized).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (!normalized || normalized.length > 120 || hasControlCharacter) return null;
  return normalized;
}

function extractPeriod(input: Record<string, unknown>) {
  if (typeof input.period !== "string") return null;
  const normalized = input.period.trim();
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(normalized) ? normalized : null;
}

function finalizeAgentResult(result: CherryParseResult): CherryParseResult | null {
  const hasDifference = Math.abs(result.difference) > 0.005;
  if (result.matched) {
    return !hasDifference && result.issues.length === 0 ? result : null;
  }
  if (!hasDifference && result.issues.length === 0) return null;
  if (result.issues.length > 0) return result;

  return {
    ...result,
    issues: [{
      rowLabel: "总差额",
      fieldName: "ERP - 结算",
      differenceAmount: result.difference,
      message: `Agent 返回总差额 ${result.difference.toFixed(2)} 元，请结合原始资料核对`,
      suggestion: "核对 ERP 与结算资料中的金额汇总及逐笔明细",
    }],
  };
}
