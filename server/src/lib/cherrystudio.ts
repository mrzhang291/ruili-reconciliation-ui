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

export type AgentErpBasis = "sales_total" | "net_sales_total" | "ambiguous";

export type SettlementExtractionResult = {
  name: string;
  settlementAmount: number;
  settlementAmountLabel: string;
  erpBasis: AgentErpBasis;
  basisReason: string;
  issues: CherryIssue[];
  period: string;
  rawAgentPayload: {
    settlementAmount: number;
    settlementAmountLabel: string;
    erpBasis: AgentErpBasis;
    basisReason: string;
    issues: string;
    period: string;
    name: string;
  };
};

export type AgentReconciliationPayload = {
  settlementAmount: number;
  settlementAmountLabel: string;
  salesTotal: number;
  netSalesTotal: number;
  erpBasis: AgentErpBasis;
  erpAmount: number;
  difference: number;
  matched: boolean;
  basisReason: string;
  issues: string;
  period: string;
  name: string;
};

export type ReconciliationResult = {
  name: string;
  matched: boolean;
  erpAmount: number;
  settlementAmount: number;
  difference: number;
  issues: CherryIssue[];
  period: string;
  settlementAmountLabel: string;
  erpBasis: AgentErpBasis;
  basisReason: string;
  salesTotal: number;
  netSalesTotal: number;
  rawAgentPayload: AgentReconciliationPayload & Record<string, unknown>;
};

export type CherryParseResult = ReconciliationResult;

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
        invalidAgentResponseMessage(finalText),
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
      invalidAgentResponseMessage(text),
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
 * 从各种嵌套结构里提取 Agent 完成 A+B 对账后的业务 JSON。
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

  // 兜底：从后往前找可独立解析的 JSON 对象，避免前面混入 MCP stdout。
  for (const candidate of jsonObjectCandidates(text).reverse()) {
    const extracted = tryParseObject(candidate);
    if (extracted) return extracted;
  }

  return null;
}

function jsonObjectCandidates(text: string) {
  const candidates: string[] = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = inString;
        continue;
      }
      if (char === "\"") {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      if (depth === 0) {
        candidates.push(text.slice(start, index + 1));
        break;
      }
    }
  }
  return candidates;
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

function invalidAgentResponseMessage(text: string) {
  const raw = extractRawContractObject(text);
  if (raw && mentionsMissingErp(raw)) {
    const name = typeof raw.name === "string" && raw.name.trim() ? `「${raw.name.trim()}」` : "该店铺";
    const period = typeof raw.period === "string" && raw.period.trim() ? `在 ${raw.period.trim()} ` : "";
    return `ERP/DRP 明细缺失：Agent 已抽取结算单，但未找到店铺号${name}${period}的 ERP/DRP 记录，不能编造 salesTotal/netSalesTotal。请补 ERP 明细或检查店铺号映射。原始输出：${singleLine(text, 500)}`;
  }
  return `Agent 返回格式不符合 { settlementAmount, settlementAmountLabel, salesTotal, netSalesTotal, erpBasis, erpAmount, difference, matched, basisReason, issues, period, name } 契约。原始输出：${singleLine(text, 500)}`;
}

function extractRawContractObject(text: string) {
  for (const candidate of [text, ...jsonObjectCandidates(text).reverse()]) {
    try {
      const parsed = JSON.parse(candidate.trim()) as unknown;
      if (isRecord(parsed) && "settlementAmount" in parsed) return parsed;
    } catch {
      // Keep scanning; Agent output often contains earlier tool JSON before the final object.
    }
  }
  return null;
}

function mentionsMissingErp(payload: Record<string, unknown>) {
  const combined = [payload.issues, payload.basisReason]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return /ERP|DRP/i.test(combined) && /未找到|缺失|无匹配|没有匹配|not\s*found/i.test(combined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractResult(input: unknown): CherryParseResult | null {
  if (!isRecord(input)) return null;

  // 顶层必须符合飞书文档目标流程的 A+B 对账契约。
  if ("settlementAmount" in input) {
    const expectedKeys = [
      "settlementAmount",
      "settlementAmountLabel",
      "salesTotal",
      "netSalesTotal",
      "erpBasis",
      "erpAmount",
      "difference",
      "matched",
      "basisReason",
      "issues",
      "period",
      "name",
    ];
    const inputKeys = Object.keys(input);
    if (inputKeys.length !== expectedKeys.length || !expectedKeys.every((key) => inputKeys.includes(key))) {
      return null;
    }

    const settlementAmount = finiteNumber(input.settlementAmount);
    const salesTotal = finiteNumber(input.salesTotal);
    const netSalesTotal = finiteNumber(input.netSalesTotal);
    const settlementAmountLabel = extractTaskName(input.settlementAmountLabel);
    const erpBasis = extractErpBasis(input.erpBasis);
    const erpAmount = finiteNumber(input.erpAmount);
    const difference = finiteNumber(input.difference);
    const basisReason = extractReason(input.basisReason);
    const name = extractTaskName(input.name);
    const period = extractPeriod(input);
    if (
      settlementAmount === null
      || salesTotal === null
      || netSalesTotal === null
      || !settlementAmountLabel
      || !erpBasis
      || erpAmount === null
      || difference === null
      || typeof input.matched !== "boolean"
      || !basisReason
      || !name
      || !period
      || typeof input.issues !== "string"
    ) return null;

    const checked = validateAgentArithmetic({
      settlementAmount,
      settlementAmountLabel,
      salesTotal,
      netSalesTotal,
      erpBasis,
      erpAmount,
      difference,
      matched: input.matched,
      basisReason,
      issues: input.issues,
      period,
      name,
    });
    if (!checked) return null;

    const issueSummary = input.issues.trim();
    const rawAgentPayload = {
      settlementAmount,
      settlementAmountLabel,
      salesTotal,
      netSalesTotal,
      erpBasis,
      erpAmount,
      difference,
      matched: input.matched,
      basisReason,
      issues: input.issues,
      period,
      name,
      closestErpBasis: checked.closestBasis,
      declaredErpBasis: checked.declaredBasis,
      appliedErpBasis: checked.basis,
      appliedErpAmount: checked.erpAmount,
      appliedDifference: checked.difference,
      basisCorrectionReason: checked.basisCorrectionReason,
      salesDifference: checked.salesDifference,
      netSalesDifference: checked.netSalesDifference,
      scopedErpMismatch: checked.scopedErpMismatch,
      reviewThresholdAmount: reconciliationReviewThresholdAmount,
    };
    const issues: CherryIssue[] = [];
    if (issueSummary || checked.reviewMessages.length) {
      const backendMessage = checked.reviewMessages.length
        ? formatBackendReviewMessage(checked, basisReason)
        : "";
      issues.push({
        rowLabel: checked.reviewMessages.length ? "总差额" : "Agent 对账提示",
        fieldName: checked.reviewMessages.length ? checked.label : settlementAmountLabel,
        settlementAmount,
        erpAmount: checked.erpAmount,
        differenceAmount: checked.scopedErpMismatch ? null : checked.difference,
        message: [issueSummary, backendMessage].filter(Boolean).join(" "),
        suggestion: checked.scopedErpMismatch
          ? "补充 ERP 的合同、专柜、铺位或活动范围键，或把同范围结算单合并后再复核。"
          : checked.reviewMessages.length ? "复核结算单金额口径，必要时检查 ERP/DRP MCP 查询结果与结算单字段。" : null,
      });
    }

    return {
      name,
      matched: checked.matched,
      erpAmount: checked.erpAmount,
      settlementAmount,
      difference: checked.difference,
      settlementAmountLabel,
      erpBasis: checked.basis,
      basisReason,
      salesTotal,
      netSalesTotal,
      issues,
      period,
      rawAgentPayload,
    };
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

function extractErpBasis(value: unknown): AgentErpBasis | null {
  return value === "sales_total" || value === "net_sales_total" || value === "ambiguous" ? value : null;
}

const reconciliationReviewThresholdAmount = 200;
const basisLabels: Record<Exclude<AgentErpBasis, "ambiguous">, string> = {
  sales_total: "ERP销售额",
  net_sales_total: "ERP扣点后金额",
};

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toCents(value: number) {
  return Math.round(value * 100);
}

function roundMoney(cents: number) {
  return cents / 100;
}

function validateAgentArithmetic(payload: AgentReconciliationPayload) {
  const settlementCents = toCents(payload.settlementAmount);
  const salesCents = toCents(payload.salesTotal);
  const netSalesCents = toCents(payload.netSalesTotal);
  const options = [
    {
      basis: "sales_total" as const,
      label: basisLabels.sales_total,
      erpAmount: roundMoney(salesCents),
      difference: roundMoney(salesCents - settlementCents),
      differenceCents: salesCents - settlementCents,
    },
    {
      basis: "net_sales_total" as const,
      label: basisLabels.net_sales_total,
      erpAmount: roundMoney(netSalesCents),
      difference: roundMoney(netSalesCents - settlementCents),
      differenceCents: netSalesCents - settlementCents,
    },
  ];
  const closest = Math.abs(options[1].differenceCents) < Math.abs(options[0].differenceCents) ? options[1] : options[0];
  const declared = payload.erpBasis === "ambiguous"
    ? closest
    : options.find((option) => option.basis === payload.erpBasis) ?? closest;
  if (toCents(payload.erpAmount) !== toCents(declared.erpAmount)) return null;
  if (toCents(payload.difference) !== toCents(declared.difference)) return null;

  const preferredBasis = preferredBasisFromSettlementLabel(payload);
  const preferred = preferredBasis ? options.find((option) => option.basis === preferredBasis) : undefined;
  const basisCorrection = preferred && preferred.basis !== declared.basis && !isZeroSalesFeeStatement(payload, preferred.basis)
    ? preferred
    : null;
  const selected = basisCorrection ?? declared;

  const thresholdCents = toCents(reconciliationReviewThresholdAmount);
  const reviewMessages: string[] = [];
  const scopedErpMismatch = indicatesScopedErpMismatch(payload.issues);
  if (basisCorrection) {
    const preferredDescription = basisCorrection.basis === "sales_total" ? "扣点前销售口径" : "扣点后金额口径";
    reviewMessages.push(`结算单字段「${payload.settlementAmountLabel}」更像${preferredDescription}，后端改按「${basisCorrection.label}」记录。`);
  }
  if (payload.erpBasis === "ambiguous") {
    reviewMessages.push(`Agent 未能判断 ERP 对账口径，后端暂按差额更小的「${selected.label}」记录。`);
  }
  if (!scopedErpMismatch && selected.basis !== closest.basis && Math.abs(selected.differenceCents) - Math.abs(closest.differenceCents) > thresholdCents) {
    reviewMessages.push(`Agent 选择「${selected.label}」，但「${closest.label}」与结算单金额明显更接近。`);
  }
  if (Math.abs(selected.differenceCents) > thresholdCents) {
    reviewMessages.push(scopedErpMismatch
      ? `ERP/结算单当前口径或范围不可比，直接相减为 ${selected.difference.toFixed(2)} 元；该数仅用于定位问题，不作为可结算差额。`
      : `所选口径差额 ${selected.difference.toFixed(2)} 元，超过 ${reconciliationReviewThresholdAmount.toFixed(2)} 元阈值。`);
  }
  if (!payload.matched && !reviewMessages.length) {
    reviewMessages.push("Agent 标记本次对账未一致。");
  }

  return {
    ...selected,
    matched: payload.matched && reviewMessages.length === 0 && Math.abs(selected.differenceCents) <= thresholdCents,
    closestBasis: closest.basis,
    salesDifference: options[0].difference,
    netSalesDifference: options[1].difference,
    reviewMessages,
    scopedErpMismatch,
    declaredBasis: declared.basis,
    basisCorrectionReason: basisCorrection ? reviewMessages[0] : null,
  };
}

function indicatesScopedErpMismatch(value: string) {
  const text = value.normalize("NFKC").replace(/\s+/g, "");
  return /聚合范围与结算单范围不一致|不能将ERP店铺聚合金额直接视为普通差额|ERP全店汇总|结算单与ERP(?:销售)?(?:范围|数据口径).*明显不一致|(?:预览页面|请勿用来结算)|(?:账期|期间|月份).*?(?:不一致|冲突)|(?:文件名主体|正文主体|结算主体|主体名称).*?(?:不一致|冲突)|(?:字段)?口径.*?(?:不一致|冲突)|无法唯一确定对账口径|金额接近度与字段口径存在冲突|结算单扣率.*?ERP.*?扣率|ERP.*?扣率.*?结算单扣率|ERP.*(?:聚合|汇总|店铺号|店铺|同店|同一店铺|多条|多档|不同扣率).*?(?:范围|不可比|无法确认|无法对应|不能直接|明细范围|合同|专柜|铺位|活动|特卖|本结算单|单一|部分|仅覆盖|未覆盖|口径)|(?:单一合同|单一专柜|单一结算部门|单一客户合同|仅覆盖|仅列示|仅显示).*?ERP/.test(text);
}

function preferredBasisFromSettlementLabel(payload: Pick<AgentReconciliationPayload, "settlementAmount" | "settlementAmountLabel" | "salesTotal" | "basisReason" | "issues">): Exclude<AgentErpBasis, "ambiguous"> | null {
  const label = payload.settlementAmountLabel;
  const normalized = label.normalize("NFKC").replace(/\s+/g, "");
  const evidence = `${label} ${payload.basisReason} ${payload.issues}`.normalize("NFKC").replace(/\s+/g, "");
  if (/付款金额/.test(normalized)
    && toCents(payload.settlementAmount) === toCents(payload.salesTotal)
    && /(?:顶部|汇总区|汇总).*?(?:付款金额|销售金额|销售额).*?(?:营业额提成|销售提成|固定扣款).*?(?:应开票|本期应付)/.test(evidence)) {
    return "sales_total";
  }
  const salesPattern = /(实销|实际销售|本期实销|销售收入|销售金额|销售额|销售总额|本月销售|门店销售|正常销售|营业额)/;
  const netPattern = /(净营业额|扣点后|提成后|分成后|销售成本|结账金额|结帐金额|结算金额|结算净额|结算款|开票|发票|实际应付|实际付款|应付金额|付款金额|得款|供应商应得|供应商应开发票|本期应结|价税合计)/;
  if (salesPattern.test(normalized) && !netPattern.test(normalized)) {
    return "sales_total";
  }
  if (netPattern.test(normalized)) {
    return "net_sales_total";
  }
  if (salesPattern.test(normalized)) {
    return "sales_total";
  }
  return null;
}

function isZeroSalesFeeStatement(payload: AgentReconciliationPayload, preferredBasis: Exclude<AgentErpBasis, "ambiguous">) {
  if (preferredBasis !== "sales_total" || toCents(payload.settlementAmount) !== 0) return false;
  const evidence = `${payload.settlementAmountLabel} ${payload.basisReason} ${payload.issues}`.normalize("NFKC");
  return /(?:销售(?:金额|额|数量)?(?:为|是)?0|0(?:元)?销售|零销售|无销售)/.test(evidence)
    && /(?:费用|扣款|扣减|佣金|开票|发票|应付小写|补扣|调整)/.test(evidence);
}

function formatBackendReviewMessage(
  checked: ReturnType<typeof validateAgentArithmetic> & NonNullable<ReturnType<typeof validateAgentArithmetic>>,
  basisReason: string,
) {
  const agentReason = `Agent 理由：${basisReason}`;
  if (checked.scopedErpMismatch) {
    return `${checked.reviewMessages.join(" ")} ${agentReason}`;
  }
  return `${checked.reviewMessages.join(" ")} 扣点前差额 ${checked.salesDifference.toFixed(2)} 元，扣点后差额 ${checked.netSalesDifference.toFixed(2)} 元。${agentReason}`;
}

function extractReason(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  const hasControlCharacter = Array.from(normalized).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (!normalized || normalized.length > 1000 || hasControlCharacter) return null;
  return normalized;
}

function extractPeriod(input: Record<string, unknown>) {
  if (typeof input.period !== "string") return null;
  const normalized = input.period.trim();
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(normalized) ? normalized : null;
}
