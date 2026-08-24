import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAgentResponse,
  readSseFinalText,
  resolveAgentSession,
} from "../dist/lib/cherrystudio.js";
import { config } from "../dist/lib/config.js";
import { buildReconciliationPrompt } from "../dist/services/reconciliation.js";

const contractResult = (overrides = {}) => ({
  matched: false,
  erpAmount: 99,
  settlementAmount: 100,
  difference: -1,
  issues: "结算单比 ERP 多计 1 元。",
  period: "2026-05",
  name: "京东商城",
  ...overrides,
});

test("parses the exact seven-field Agent result and creates a review item", () => {
  const payload = contractResult({ difference: -5, issues: "结算金额比 ERP 多 5 元。" });
  const result = parseAgentResponse(JSON.stringify(payload));

  assert.equal(result?.difference, -5);
  assert.equal(result?.erpAmount, 99);
  assert.equal(result?.settlementAmount, 100);
  assert.equal(result?.issues[0].differenceAmount, -5);
  assert.equal(result?.issues[0].message, "结算金额比 ERP 多 5 元。");
  assert.equal(result?.name, "京东商城");
  assert.equal(result?.period, "2026-05");
  assert.deepEqual(result?.rawAgentPayload, payload);
});

test("accepts a matched result with an empty issues string", () => {
  const result = parseAgentResponse(JSON.stringify(contractResult({
    matched: true,
    difference: 0,
    issues: "",
  })));

  assert.equal(result?.matched, true);
  assert.deepEqual(result?.issues, []);
});

test("keeps reasoning and tool details in stable process logs", async () => {
  const encoder = new TextEncoder();
  const reasoning = "the JPG using mineru.\n扣点 rates for different sales amounts\n17.00";
  const command = "curl -s -o /tmp/erp.xlsx https://example.test/full-command-that-must-not-be-truncated";
  const processEvents = [];
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode([
        { type: "start" },
        { type: "reasoning-start" },
        { type: "reasoning-delta", text: reasoning.slice(0, 20) },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")));
      setTimeout(() => {
        controller.enqueue(encoder.encode([
          { type: "reasoning-delta", text: reasoning.slice(20) },
          { type: "reasoning-end" },
          { type: "tool-call", toolName: "Bash", input: { command } },
          { type: "tool-result", toolName: "Bash", output: "ERP downloaded: 9952 bytes" },
          { type: "text-delta", text: '{"matched":false}' },
          { type: "finish" },
        ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")));
        controller.close();
      }, 120);
    },
  });

  assert.equal(
    await readSseFinalText(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
      (level, message, options) => processEvents.push({ level, message, options }),
    ),
    '{"matched":false}',
  );

  const thoughtUpdates = processEvents.filter((event) => event.options?.details?.includes("the JPG using mineru"));
  assert.equal(new Set(thoughtUpdates.map((event) => event.options.id)).size, 1);
  assert.equal(thoughtUpdates[0].options.expanded, true);
  assert.equal(thoughtUpdates.at(-1).options.expanded, false);
  assert.equal(thoughtUpdates.at(-1).options.details, reasoning);
  assert.equal(
    processEvents.find((event) => event.message.startsWith("调用工具 Bash")).options.details,
    JSON.stringify({ command }, null, 2),
  );
  assert.equal(
    processEvents.find((event) => event.message.startsWith("Bash 执行完成")).options.details,
    "ERP downloaded: 9952 bytes",
  );
});

test("rejects contradictory matched results", () => {
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ matched: true, difference: 5, issues: "" }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ difference: 0, issues: "" }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ matched: true, difference: 0, issues: "仍有差异" }))), null);
});

test("creates a reviewable summary when only a total difference is returned", () => {
  const result = parseAgentResponse(JSON.stringify(contractResult({ difference: 17, issues: "" })));

  assert.equal(result?.difference, 17);
  assert.equal(result?.issues.length, 1);
  assert.equal(result?.issues[0].differenceAmount, 17);
});

test("does not override the Agent result with server-side business rules", () => {
  const issues = "ERP 中有 16% 和 17% 两档扣点（16%档销售额 86175 元），而结算单全部按 17% 计算；且 ERP 方未体现结算单中的调整项费用（合计 13,272.58 元）。此外 ERP 总销售额 512,042 与结算单净营业额 512,047 存在 5 元差异。";
  const result = parseAgentResponse(JSON.stringify(contractResult({
    difference: 15855.61,
    issues,
  })));

  assert.equal(result?.difference, 15855.61);
  assert.equal(result?.issues[0].differenceAmount, 15855.61);
  assert.equal(result?.rawAgentPayload.difference, 15855.61);
  assert.equal(result?.rawAgentPayload.issues, issues);
});

test("keeps the reported difference even when issues contain other amounts", () => {
  const result = parseAgentResponse(JSON.stringify(contractResult({
    difference: 857.6,
    issues: "两方营业额口径差5元（ERP 512042元、结算单512047元），另有调整项 13272.58 元。",
  })));

  assert.equal(result?.difference, 857.6);
  assert.equal(result?.issues[0].differenceAmount, 857.6);
});

test("requires exactly the seven documented fields and their documented types", () => {
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ name: "" }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ name: undefined }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ period: "2026年-05月" }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ period: "2026-13" }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ difference: "-1" }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ erpAmount: "99" }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ settlementAmount: null }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ issues: [] }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ issues: undefined }))), null);
  assert.equal(parseAgentResponse(JSON.stringify({ ...contractResult(), extra: true })), null);
});

test("keeps Agent artifacts inside the task work directory", () => {
  const prompt = buildReconciliationPrompt({
    settlementFileUrl: "http://127.0.0.1/settlement",
    erpFileUrl: "http://127.0.0.1/erp",
    settlementFilePath: "C:/files/settlement.xlsx",
    erpFilePath: "C:/files/erp.xlsx",
    submittedAt: new Date(0).toISOString(),
    taskId: "test-task",
    taskWorkDir: "C:/runtime/tasks/test-task",
  });

  assert.match(prompt, /http:\/\/127\.0\.0\.1\/erp/);
  assert.match(prompt, /C:\/runtime\/tasks\/test-task/);
  assert.match(prompt, /不要在项目根目录、源码目录或输入文件旁创建文件/);
  assert.match(prompt, /ERP：C:\/files\/erp\.xlsx/);
  assert.match(prompt, /结算单：C:\/files\/settlement\.xlsx/);
});

test("paginates agents and creates a new session", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = config.cherryStudio.apiKey;
  const calls = [];
  const knowledgeInstructions = "来自飞书的本次规则快照";
  config.cherryStudio.apiKey = "test-api-key";
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("offset=0")) {
      return Response.json({
        data: Array.from({ length: 100 }, (_, index) => ({ id: `other-${index}`, name: `其他-${index}` })),
        total: 101,
      });
    }
    if (url.includes("offset=100")) {
      return Response.json({ data: [{ id: "agent-target", name: "锐力" }], total: 101 });
    }
    if (url.endsWith("/v1/agents/agent-target/sessions")) {
      assert.equal(init.method, "POST");
      const body = JSON.parse(String(init.body));
      assert.match(body.name, /^对账-/);
      assert.equal(body.instructions, knowledgeInstructions);
      return Response.json({ data: { session: { id: "session-new" } } }, { status: 201 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const target = await resolveAgentSession({ name: "锐力" }, knowledgeInstructions);
    assert.deepEqual(target, {
      agentId: "agent-target",
      agentName: "锐力",
      sessionId: "session-new",
    });
    assert.equal(calls.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
    config.cherryStudio.apiKey = originalApiKey;
  }
});
