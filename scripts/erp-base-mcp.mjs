#!/usr/bin/env node

const apiBase = (process.env.RUILI_RECONCILIATION_API || "http://127.0.0.1:3001").replace(/\/$/, "");

const inputSchema = {
  type: "object",
  properties: {
    mall_name: { type: "string", description: "ERP/DRP lookup key, usually the shop number." },
    mallName: { type: "string", description: "Alias for mall_name." },
    storeCode: { type: "string", description: "Alias for mall_name." },
    shopNo: { type: "string", description: "Alias for mall_name." },
    name: { type: "string", description: "Alias for mall_name." },
    period: { type: "string", description: "Accounting period in YYYY-MM or YYYYMM." },
    month: { type: "string", description: "Alias for period." },
    periodStart: { type: "string", description: "Period start date; YYYY-MM-DD is accepted." },
    periodEnd: { type: "string", description: "Optional period end date." },
    limit: { type: "number", description: "Optional row limit retained for compatibility." },
  },
  additionalProperties: true,
};

const tools = [
  {
    name: "summarize_store_period",
    description: "Return ERP/DRP sales_total and net_sales_total for one shop and accounting period from the Feishu Base source of truth.",
    inputSchema,
  },
  {
    name: "list_settlement_bills",
    description: "Compatibility alias that returns the ERP/DRP reconciliation rows and totals for one shop and period.",
    inputSchema,
  },
  {
    name: "get_settlement_bill",
    description: "Compatibility alias that returns one ERP/DRP reconciliation summary for one shop and period.",
    inputSchema,
  },
  {
    name: "analyze_fee_changes",
    description: "Compatibility alias; returns ERP/DRP totals with an empty fee list because fee judgement remains in the settlement document.",
    inputSchema,
  },
];

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);
    if (line.trim()) void handleLine(line);
  }
});

process.stdin.on("end", () => process.exit(0));

async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    writeError(null, -32700, `Invalid JSON: ${errorMessage(error)}`);
    return;
  }

  if (!message || typeof message !== "object") {
    writeError(null, -32600, "Invalid JSON-RPC message");
    return;
  }

  if (!("id" in message) && typeof message.method === "string" && message.method.startsWith("notifications/")) return;

  try {
    if (message.method === "initialize") {
      writeResult(message.id, {
        protocolVersion: message.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "ruili-feishu-base-erp", version: "1.0.0" },
      });
      return;
    }

    if (message.method === "ping") {
      writeResult(message.id, {});
      return;
    }

    if (message.method === "tools/list") {
      writeResult(message.id, { tools });
      return;
    }

    if (message.method === "tools/call") {
      const name = message.params?.name;
      const args = message.params?.arguments || {};
      if (!tools.some((tool) => tool.name === name)) {
        writeError(message.id, -32602, `Unknown tool: ${name}`);
        return;
      }
      writeResult(message.id, await callTool(name, args));
      return;
    }

    writeError(message.id, -32601, `Method not found: ${message.method}`);
  } catch (error) {
    writeResult(message.id, {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ ok: false, error: errorMessage(error) }) }],
    });
  }
}

async function callTool(name, rawArgs) {
  const summary = await fetchErpSummary(rawArgs);
  const payload = {
    ok: true,
    source: "feishu_base_erp",
    tool: name,
    ...summary,
  };

  if (name === "list_settlement_bills") {
    payload.bills = [{ id: `${summary.lookup_key}:${summary.period}`, ...summary }];
  }
  if (name === "get_settlement_bill") {
    payload.bill = { id: `${summary.lookup_key}:${summary.period}`, ...summary };
  }
  if (name === "analyze_fee_changes") {
    payload.fees = [];
    payload.fee_total = 0;
  }

  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

async function fetchErpSummary(rawArgs) {
  const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
  const lookupKey = firstString(args.mall_name, args.mallName, args.storeCode, args.shopNo, args.name);
  const period = normalizePeriod(firstString(args.period, args.month, args.periodStart));

  if (!lookupKey || !period) {
    throw new Error("Missing mall_name/shopNo/storeCode or period");
  }

  const url = new URL(`${apiBase}/api/erp/reconciliation`);
  url.searchParams.set("mall_name", lookupKey);
  url.searchParams.set("period", period);

  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`Cannot reach reconciliation backend at ${apiBase}: ${errorMessage(error)}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`Backend returned non-JSON response: ${errorMessage(error)}`);
  }

  if (!response.ok) {
    const detail = payload?.error?.message || `HTTP ${response.status}`;
    throw new Error(detail);
  }

  return payload.data;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function normalizePeriod(value) {
  if (!value) return "";
  const compact = value.match(/^(20\d{2})(0[1-9]|1[0-2])$/);
  if (compact) return `${compact[1]}-${compact[2]}`;
  const date = value.match(/^(20\d{2})-(0[1-9]|1[0-2])(?:-\d{2})?$/);
  if (date) return `${date[1]}-${date[2]}`;
  return value;
}

function writeResult(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function writeError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
