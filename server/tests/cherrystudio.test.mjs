import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAgentResponse,
  readSseFinalText,
  resolveAgentSession,
  sendReconciliationPrompt,
} from "../dist/lib/cherrystudio.js";
import { config } from "../dist/lib/config.js";
import { buildReconciliationPrompt } from "../dist/services/reconciliation.js";

const contractResult = (overrides = {}) => ({
  settlementAmount: 100,
  settlementAmountLabel: "结算净营业额",
  salesTotal: 120,
  netSalesTotal: 100,
  erpBasis: "net_sales_total",
  erpAmount: 100,
  difference: 0,
  matched: true,
  basisReason: "该店结算单净营业额按扣点后金额对账。",
  issues: "结算单金额字段存在多个候选。",
  period: "2026-05",
  name: "SHNKA2",
  ...overrides,
});

test("parses the exact twelve-field Agent reconciliation result", () => {
  const payload = contractResult({
    settlementAmount: 512047,
    salesTotal: 528000,
    netSalesTotal: 512047,
    erpAmount: 512047,
    difference: 0,
    issues: "已按规则采用结算净营业额。",
  });
  const result = parseAgentResponse(JSON.stringify(payload));

  assert.equal(result?.settlementAmount, 512047);
  assert.equal(result?.settlementAmountLabel, "结算净营业额");
  assert.equal(result?.salesTotal, 528000);
  assert.equal(result?.netSalesTotal, 512047);
  assert.equal(result?.erpBasis, "net_sales_total");
  assert.equal(result?.erpAmount, 512047);
  assert.equal(result?.difference, 0);
  assert.equal(result?.matched, true);
  assert.equal(result?.basisReason, "该店结算单净营业额按扣点后金额对账。");
  assert.equal(result?.issues[0].settlementAmount, 512047);
  assert.equal(result?.issues[0].message, "已按规则采用结算净营业额。");
  assert.equal(result?.name, "SHNKA2");
  assert.equal(result?.period, "2026-05");
  assert.equal(result?.rawAgentPayload.erpBasis, "net_sales_total");
  assert.equal(result?.rawAgentPayload.salesDifference, 15953);
  assert.equal(result?.rawAgentPayload.netSalesDifference, 0);
});

test("accepts a clean reconciliation with an empty issues string", () => {
  const result = parseAgentResponse(JSON.stringify(contractResult({
    issues: "",
  })));

  assert.equal(result?.settlementAmount, 100);
  assert.deepEqual(result?.issues, []);
});

test("extracts the final contract JSON when earlier tool JSON is mixed into text", () => {
  const toolOutput = JSON.stringify({ jsonrpc: "2.0", result: { sales_total: 120 } });
  const finalOutput = JSON.stringify(contractResult({ issues: "", name: "NJNK24" }));
  const result = parseAgentResponse(`${toolOutput}\n最终结果：\n${finalOutput}`);

  assert.equal(result?.name, "NJNK24");
  assert.equal(result?.settlementAmount, 100);
});

test("does not accept mixed text without a valid contract JSON object", () => {
  const toolOutput = JSON.stringify({ jsonrpc: "2.0", result: { sales_total: 120 } });
  assert.equal(parseAgentResponse(`${toolOutput}\n已完成。`), null);
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

test("rejects legacy partial Agent results", () => {
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

test("requires exactly the twelve documented fields and their documented types", () => {
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ name: "" }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ name: undefined }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ period: "2026年-05月" }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ period: "2026-13" }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ settlementAmount: null }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ settlementAmountLabel: "" }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ salesTotal: null }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ netSalesTotal: undefined }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ erpBasis: "gross_total" }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ erpAmount: "100" }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ difference: null }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ matched: "true" }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ basisReason: "" }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ issues: [] }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({ issues: undefined }))), null);
  assert.equal(parseAgentResponse(JSON.stringify({ ...contractResult(), extra: true })), null);
});

test("rejects Agent reconciliation arithmetic that does not tie out", () => {
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({
    erpAmount: 99,
  }))), null);
  assert.equal(parseAgentResponse(JSON.stringify(contractResult({
    difference: 1,
  }))), null);
});

test("keeps ambiguous basis as a review item and uses the closest ERP amount", () => {
  const result = parseAgentResponse(JSON.stringify(contractResult({
    settlementAmount: 101,
    salesTotal: 130,
    netSalesTotal: 100,
    erpBasis: "ambiguous",
    erpAmount: 100,
    difference: -1,
    matched: false,
    issues: "",
  })));

  assert.equal(result?.matched, false);
  assert.equal(result?.erpAmount, 100);
  assert.equal(result?.difference, -1);
  assert.match(result?.issues[0].message ?? "", /Agent 未能判断 ERP 对账口径/);
});

test("combines backend basis and threshold checks into one review item", () => {
  const result = parseAgentResponse(JSON.stringify(contractResult({
    settlementAmount: 100,
    settlementAmountLabel: "对账金额",
    salesTotal: 500,
    netSalesTotal: 105,
    erpBasis: "sales_total",
    erpAmount: 500,
    difference: 400,
    matched: false,
    issues: "",
  })));

  assert.equal(result?.matched, false);
  assert.equal(result?.issues.length, 1);
  assert.match(result?.issues[0].message ?? "", /明显更接近/);
  assert.match(result?.issues[0].message ?? "", /超过 200\.00 元阈值/);
});

test("corrects obvious pre-deduction settlement labels back to sales_total", () => {
  const result = parseAgentResponse(JSON.stringify(contractResult({
    settlementAmount: 439496,
    settlementAmountLabel: "实销金额",
    salesTotal: 411573,
    netSalesTotal: 363989.36,
    erpBasis: "net_sales_total",
    erpAmount: 363989.36,
    difference: -75506.64,
    matched: false,
    issues: "",
  })));

  assert.equal(result?.matched, false);
  assert.equal(result?.erpBasis, "sales_total");
  assert.equal(result?.erpAmount, 411573);
  assert.equal(result?.difference, -27923);
  assert.match(result?.issues[0].message ?? "", /更像扣点前销售口径/);
  assert.equal(result?.rawAgentPayload.erpBasis, "net_sales_total");
  assert.equal(result?.rawAgentPayload.declaredErpBasis, "net_sales_total");
  assert.equal(result?.rawAgentPayload.appliedErpBasis, "sales_total");
  assert.equal(result?.rawAgentPayload.appliedErpAmount, 411573);
});

test("keeps sales labels on sales_total even when net_sales_total is closer", () => {
  const result = parseAgentResponse(JSON.stringify(contractResult({
    settlementAmount: 315776.27,
    settlementAmountLabel: "本期实销金额",
    salesTotal: 558398.7,
    netSalesTotal: 470945.26,
    erpBasis: "ambiguous",
    erpAmount: 470945.26,
    difference: 155168.99,
    matched: false,
    issues: "ERP聚合范围与结算单范围不一致。",
  })));

  assert.equal(result?.matched, false);
  assert.equal(result?.erpBasis, "sales_total");
  assert.equal(result?.erpAmount, 558398.7);
  assert.equal(result?.difference, 242622.43);
  assert.equal(result?.issues[0].differenceAmount, null);
  assert.match(result?.issues[0].message ?? "", /更像扣点前销售口径/);
  assert.match(result?.issues[0].message ?? "", /Agent 未能判断 ERP 对账口径/);
  assert.equal(result?.rawAgentPayload.declaredErpBasis, "net_sales_total");
  assert.equal(result?.rawAgentPayload.appliedErpBasis, "sales_total");
  assert.equal(result?.rawAgentPayload.scopedErpMismatch, true);
});

test("does not enlarge standalone zero-sales fee statements to sales_total", () => {
  const result = parseAgentResponse(JSON.stringify(contractResult({
    settlementAmount: 0,
    settlementAmountLabel: "销售金额",
    salesTotal: 583306,
    netSalesTotal: 495810.1,
    erpBasis: "ambiguous",
    erpAmount: 495810.1,
    difference: 495810.1,
    matched: false,
    basisReason: "销售金额为0，销售数量为0；结算单同时包含结算佣金、开票金额、费用项目和扣减项目。",
    issues: "结算单销售金额为0，与ERP扣点前和扣点后金额均存在重大差异，需确认是否为费用调整单。",
  })));

  assert.equal(result?.matched, false);
  assert.equal(result?.erpBasis, "net_sales_total");
  assert.equal(result?.erpAmount, 495810.1);
  assert.equal(result?.difference, 495810.1);
  assert.doesNotMatch(result?.issues[0].message ?? "", /更像扣点前销售口径/);
  assert.equal(result?.rawAgentPayload.appliedErpBasis, "net_sales_total");
  assert.equal(result?.rawAgentPayload.basisCorrectionReason, null);
});

test("treats payable sales amount labels as sales_total", () => {
  const result = parseAgentResponse(JSON.stringify(contractResult({
    settlementAmount: 2094344,
    settlementAmountLabel: "总销售额（应付销售额）",
    salesTotal: 2092945,
    netSalesTotal: 1674356,
    erpBasis: "sales_total",
    erpAmount: 2092945,
    difference: -1399,
    matched: false,
    issues: "",
  })));

  assert.equal(result?.matched, false);
  assert.equal(result?.erpBasis, "sales_total");
  assert.equal(result?.erpAmount, 2092945);
  assert.equal(result?.difference, -1399);
  assert.doesNotMatch(result?.issues[0].message ?? "", /更像扣点后金额口径/);
  assert.equal(result?.rawAgentPayload.appliedErpBasis, "sales_total");
});

test("keeps top payment amounts on sales_total when deductions lead to invoice amount", () => {
  const result = parseAgentResponse(JSON.stringify(contractResult({
    settlementAmount: 1532389,
    settlementAmountLabel: "付款金额",
    salesTotal: 1532389,
    netSalesTotal: 1379150.1,
    erpBasis: "sales_total",
    erpAmount: 1532389,
    difference: 0,
    matched: true,
    basisReason: "结算单顶部付款金额1532389.00与ERP sales_total一致；下方营业额提成169500.00后得到应开票金额1362889.00。",
    issues: "",
  })));

  assert.equal(result?.matched, true);
  assert.equal(result?.erpBasis, "sales_total");
  assert.equal(result?.settlementAmount, 1532389);
  assert.deepEqual(result?.issues, []);
});

test("allows matched non-positive sales totals when the sales basis ties out", () => {
  const result = parseAgentResponse(JSON.stringify(contractResult({
    settlementAmount: -584,
    settlementAmountLabel: "本期实销金额（两份结算单合计）",
    salesTotal: -584,
    netSalesTotal: -513.92,
    erpBasis: "sales_total",
    erpAmount: -584,
    difference: 0,
    matched: true,
    basisReason: "两份同店同账期结算单合计的本期实销金额为-584.00元，属于销售额口径；ERP sales_total为-584.00元。",
    issues: "",
  })));

  assert.equal(result?.matched, true);
  assert.equal(result?.erpBasis, "sales_total");
  assert.equal(result?.difference, 0);
  assert.deepEqual(result?.issues, []);
});

test("keeps invoice labels on net_sales_total even when sales_total is closer", () => {
  const result = parseAgentResponse(JSON.stringify(contractResult({
    settlementAmount: 270991.7,
    settlementAmountLabel: "开票金额",
    salesTotal: 251896,
    netSalesTotal: 226706.4,
    erpBasis: "net_sales_total",
    erpAmount: 226706.4,
    difference: -44285.3,
    matched: false,
    issues: "",
  })));

  assert.equal(result?.matched, false);
  assert.equal(result?.erpBasis, "net_sales_total");
  assert.equal(result?.erpAmount, 226706.4);
  assert.equal(result?.difference, -44285.3);
  assert.match(result?.issues[0].message ?? "", /明显更接近/);
  assert.equal(result?.rawAgentPayload.appliedErpBasis, "net_sales_total");
});

test("merges Agent issue text with backend review text", () => {
  const result = parseAgentResponse(JSON.stringify(contractResult({
    settlementAmount: 100,
    settlementAmountLabel: "对账金额",
    salesTotal: 500,
    netSalesTotal: 105,
    erpBasis: "sales_total",
    erpAmount: 500,
    difference: 400,
    matched: false,
    issues: "ERP聚合范围与结算单范围不一致。",
  })));

  assert.equal(result?.issues.length, 1);
  assert.match(result?.issues[0].message ?? "", /ERP聚合范围与结算单范围不一致/);
  assert.match(result?.issues[0].message ?? "", /范围不可比/);
  assert.match(result?.issues[0].message ?? "", /不作为可结算差额/);
  assert.doesNotMatch(result?.issues[0].message ?? "", /明显更接近/);
  assert.equal(result?.issues[0].differenceAmount, null);
});

test("treats same-shop multi-rate ERP results as incomparable scope", () => {
  const result = parseAgentResponse(JSON.stringify(contractResult({
    settlementAmount: 158549,
    settlementAmountLabel: "销售额",
    salesTotal: 159707,
    netSalesTotal: 139534.05,
    erpBasis: "sales_total",
    erpAmount: 159707,
    difference: 1158,
    matched: false,
    issues: "ERP返回同一店铺号下3条不同扣率明细，无法确认本结算单对应其中哪些合同范围。",
  })));

  assert.equal(result?.matched, false);
  assert.equal(result?.rawAgentPayload.scopedErpMismatch, true);
  assert.equal(result?.issues[0].differenceAmount, null);
  assert.match(result?.issues[0].message ?? "", /范围不可比/);
  assert.doesNotMatch(result?.issues[0].message ?? "", /明显更接近/);
});

test("does not expose huge sales differences when the Agent reports an obvious scope or basis mismatch", () => {
  const result = parseAgentResponse(JSON.stringify(contractResult({
    settlementAmount: 1957326.8,
    settlementAmountLabel: "本期实销金额",
    salesTotal: 1334816.52,
    netSalesTotal: 1065183.58,
    erpBasis: "sales_total",
    erpAmount: 1334816.52,
    difference: -622510.28,
    matched: false,
    issues: "结算单本期实销金额为1957326.80元，ERP sales_total为1334816.52元，差额绝对值622510.28元；结算单与ERP销售范围或数据口径存在明显不一致，需人工审核。",
  })));

  assert.equal(result?.matched, false);
  assert.equal(result?.rawAgentPayload.scopedErpMismatch, true);
  assert.equal(result?.issues[0].differenceAmount, null);
  assert.match(result?.issues[0].message ?? "", /范围不可比/);
  assert.match(result?.issues[0].message ?? "", /不作为可结算差额/);
});

test("does not expose numeric differences for non-final or mismatched settlement documents", () => {
  for (const issues of [
    "结算单含“预览页面，请勿用来结算”水印，需核对正式结算单。",
    "文件名账期 2026-08 与正文账期 2026-05 不一致。",
    "结算单扣率 5% 与 ERP 扣率 20% 不一致，当前金额口径冲突。",
  ]) {
    const result = parseAgentResponse(JSON.stringify(contractResult({
      settlementAmount: 2345196.49,
      settlementAmountLabel: "发票金额(含调整)",
      salesTotal: 2603409,
      netSalesTotal: 2369102.19,
      erpBasis: "net_sales_total",
      erpAmount: 2369102.19,
      difference: 23905.7,
      matched: false,
      issues,
    })));

    assert.equal(result?.matched, false);
    assert.equal(result?.rawAgentPayload.scopedErpMismatch, true);
    assert.equal(result?.issues[0].differenceAmount, null);
    assert.match(result?.issues[0].message ?? "", /当前口径或范围不可比/);
  }
});

test("keeps Agent artifacts inside the task work directory", () => {
  const prompt = buildReconciliationPrompt({
    settlementFileUrl: "http://127.0.0.1/settlement",
    settlementFilePath: "C:/files/settlement.xlsx",
    settlementFileName: "SHNKA2结算单-202605.pdf",
    settlementHint: { name: "SHNKA2", period: "2026-05" },
    submittedAt: new Date(0).toISOString(),
    taskId: "test-task",
    taskWorkDir: "C:/runtime/tasks/test-task",
  });

  assert.doesNotMatch(prompt, /http:\/\/127\.0\.0\.1\/erp/);
  assert.match(prompt, /C:\/runtime\/tasks\/test-task/);
  assert.match(prompt, /不要在项目根目录、源码目录或输入文件旁创建文件/);
  assert.doesNotMatch(prompt, /ERP：C:\/files\/erp\.xlsx/);
  assert.match(prompt, /结算单1：C:\/files\/settlement\.xlsx/);
  assert.match(prompt, /SHNKA2/);
  assert.match(prompt, /参考主体：SHNKA2/);
  assert.match(prompt, /参考账期：2026-05/);
  assert.match(prompt, /严禁运行 python3/);
  assert.match(prompt, /首次 MCP 查询优先使用参考主体/);
  assert.match(prompt, /如果结算单是 \.xlsx 或 \.xls，禁止使用 MinerU、OCR 或 Subagent/);
  assert.match(prompt, /本地 MCP JSON-RPC 命令/);
  assert.match(prompt, /不要调用 CherryStudio 原生工具列表里的 mcp__wd3FCVOL5nMNLODNeRfOr__summarize_store_period/);
  assert.match(prompt, /MCP 没有匹配记录.*不要把金额当成 0/);
  assert.doesNotMatch(prompt, /后端已从文件名确定本次店铺号/);
  assert.match(prompt, /erpBasis/);
  assert.match(prompt, /salesTotal/);
  assert.match(prompt, /netSalesTotal/);
  assert.match(prompt, /matched/);
  assert.match(prompt, /sales_total 表示扣点前销售额/);
  assert.match(prompt, /顶部金额与 ERP\/DRP sales_total 在 200 元内对平/);
  assert.match(prompt, /金额为负就判异常/);
  assert.match(prompt, /可输出 matched=true/);
});

test("multi-file reconciliation prompt requires one combined result", () => {
  const prompt = buildReconciliationPrompt({
    settlementFileUrl: "http://127.0.0.1/settlement",
    settlementFilePath: "C:/files/WHAD28-5月结算单1.pdf",
    settlementFileName: "WHAD28-5月结算单1.pdf",
    settlementFiles: [
      { path: "C:/files/WHAD28-5月结算单1.pdf", name: "WHAD28-5月结算单1.pdf" },
      { path: "C:/files/WHAD28-5月结算单2.pdf", name: "WHAD28-5月结算单2.pdf" },
    ],
    settlementHint: { name: "WHAD28", period: "2026-05", documentLabels: ["WHAD28-5月结算单1.pdf", "WHAD28-5月结算单2.pdf"] },
    submittedAt: new Date(0).toISOString(),
    taskId: "test-task",
    taskWorkDir: "C:/runtime/tasks/test-task",
  });

  assert.match(prompt, /2 份同店同账期结算资料/);
  assert.match(prompt, /作为一份完整结算单一起读取、合计后再对 ERP\/DRP/);
  assert.match(prompt, /不要按单个文件分别对账/);
  assert.match(prompt, /结算单1：C:\/files\/WHAD28-5月结算单1\.pdf/);
  assert.match(prompt, /结算单2：C:\/files\/WHAD28-5月结算单2\.pdf/);
  assert.match(prompt, /同组文件：WHAD28-5月结算单1\.pdf；WHAD28-5月结算单2\.pdf/);
});

test("reports missing ERP rows from an invalid Agent response as a data issue", async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = config.cherryStudio.apiKey;
  config.cherryStudio.apiKey = "test-api-key";
  globalThis.fetch = async () => Response.json({
    settlementAmount: -1831.49,
    settlementAmountLabel: "含税结账金额",
    salesTotal: null,
    netSalesTotal: null,
    erpBasis: "ambiguous",
    erpAmount: null,
    difference: null,
    matched: false,
    basisReason: "ERP/DRP MCP未找到店铺号「WHNK59」在2026-05的记录。",
    issues: "ERP/DRP未找到店铺号「WHNK59」在2026-05的记录。",
    period: "2026-05",
    name: "WHNK59",
  });

  try {
    await assert.rejects(
      () => sendReconciliationPrompt({ agentId: "agent-1", agentName: "锐力", sessionId: "session-1" }, "prompt"),
      (error) => {
        assert.equal(error.code, "CHERRYSTUDIO_AGENT_INVALID_RESPONSE");
        assert.match(error.message, /ERP\/DRP 明细缺失/);
        assert.match(error.message, /WHNK59/);
        assert.doesNotMatch(error.message, /^Agent 返回格式不符合/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    config.cherryStudio.apiKey = originalApiKey;
  }
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
