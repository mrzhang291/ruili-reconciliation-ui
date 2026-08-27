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
  settlementAmount: 100,
  settlementAmountLabel: "结算净营业额",
  issues: "结算单金额字段存在多个候选。",
  period: "2026-05",
  name: "SHNKA2",
  ...overrides,
});

test("parses the exact five-field settlement extraction result", () => {
  const payload = contractResult({ settlementAmount: 512047, issues: "已按规则采用结算净营业额。" });
  const result = parseAgentResponse(JSON.stringify(payload));

  assert.equal(result?.settlementAmount, 512047);
  assert.equal(result?.settlementAmountLabel, "结算净营业额");
  assert.equal(result?.issues[0].settlementAmount, 512047);
  assert.equal(result?.issues[0].message, "已按规则采用结算净营业额。");
  assert.equal(result?.name, "SHNKA2");
  assert.equal(result?.period, "2026-05");
  assert.deepEqual(result?.rawAgentPayload, payload);
});

test("accepts a clean extraction with an empty issues string", () => {
  const result = parseAgentResponse(JSON.stringify(contractResult({
    issues: "",
  })));

  assert.equal(result?.settlementAmount, 100);
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

test("rejects old Agent-computed ERP results", () => {
  assert.equal(parseAgentResponse(JSON.stringify({
    matched: false,
    erpAmount: 99,
    settlementAmount: 100,
    difference: -1,
    issues: "",
    period: "2026-05",
    name: "SHNKA2",
  })), null);
});

test("requires exactly the five documented fields and their documented types", () => {
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ name: "" }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ name: undefined }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ period: "2026年-05月" }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ period: "2026-13" }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ settlementAmount: null }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ settlementAmountLabel: "" }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ issues: [] }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ issues: undefined }))), null);
  assert.equal(parseAgentResponse(JSON.stringify({ ...contractResult(), extra: true })), null);
});

test("keeps Agent artifacts inside the task work directory", () => {
  const prompt = buildReconciliationPrompt({
    settlementFileUrl: "http://127.0.0.1/settlement",
    settlementFilePath: "C:/files/settlement.xlsx",
    settlementFileName: "SHNKA2结算单-202605.pdf",
    shopNo: "SHNKA2",
    submittedAt: new Date(0).toISOString(),
    taskId: "test-task",
    taskWorkDir: "C:/runtime/tasks/test-task",
  });

  assert.doesNotMatch(prompt, /http:\/\/127\.0\.0\.1\/erp/);
  assert.match(prompt, /C:\/runtime\/tasks\/test-task/);
  assert.match(prompt, /不要在项目根目录、源码目录或输入文件旁创建文件/);
  assert.doesNotMatch(prompt, /ERP：C:\/files\/erp\.xlsx/);
  assert.match(prompt, /结算单：C:\/files\/settlement\.xlsx/);
  assert.match(prompt, /SHNKA2/);
  assert.match(prompt, /不要先调用 WindowsApps 里的 python3/);
  assert.match(prompt, /不要读取、计算、猜测或输出 ERP\/DRP 金额/);
  assert.match(prompt, /后端已从文件名确定本次店铺号：SHNKA2/);
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
