import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import test from "node:test";

test("project MCP exposes ERP reconciliation totals from the backend", async (t) => {
  const api = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    assert.equal(url.pathname, "/api/erp/reconciliation");
    assert.equal(url.searchParams.get("mall_name"), "SHAA01");
    assert.equal(url.searchParams.get("period"), "2026-05");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      data: {
        lookup_key: "SHAA01",
        lookupKey: "SHAA01",
        mall_name: "SHAA01",
        period: "2026-05",
        month: "202605",
        rows: [{ id: "rec1", shop_no: "SHAA01", deduction_rate: 0.1, sales_amount: 100 }],
        rows_count: 1,
        sales_total: 100,
        salesTotal: 100,
        net_sales_total: 90,
        netSalesTotal: 90,
      },
    }));
  });

  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => api.close());

  const address = api.address();
  const child = spawn(process.execPath, ["../scripts/erp-base-mcp.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      RUILI_RECONCILIATION_API: `http://127.0.0.1:${address.port}`,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());

  const messages = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      messages.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
  });

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "summarize_store_period",
      arguments: { mall_name: "SHAA01", period: "2026-05" },
    },
  })}\n`);

  await waitFor(() => messages.length >= 3);
  assert.equal(messages[0].result.serverInfo.name, "ruili-feishu-base-erp");
  assert.ok(messages[1].result.tools.some((tool) => tool.name === "summarize_store_period"));
  const result = JSON.parse(messages[2].result.content[0].text);
  assert.equal(result.sales_total, 100);
  assert.equal(result.net_sales_total, 90);
});

async function waitFor(predicate) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 3000) throw new Error("Timed out waiting for MCP response");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
