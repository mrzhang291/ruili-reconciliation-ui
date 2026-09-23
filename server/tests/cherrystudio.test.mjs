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
    basisReason: "扣点对比：结算单 10%；ERP 10%；扣点一致。结算单净营业额按扣点后金额对账。",
    issues: "",
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
  assert.match(result?.basisReason ?? "", /结算单 10%；ERP 10%；扣点一致/);
  assert.deepEqual(result?.issues, []);
  assert.equal(result?.name, "SHNKA2");
  assert.equal(result?.period, "2026-05");
  assert.equal(result?.rawAgentPayload.erpBasis, "net_sales_total");
  assert.equal(result?.rawAgentPayload.salesDifference, 15953);
  assert.equal(result?.rawAgentPayload.netSalesDifference, 0);
});

test("accepts a clean reconciliation with an empty issues string", () => {
  const result = parseAgentResponse(JSON.stringify(contractResult({
    basisReason: "扣点对比：结算单 10%；ERP 10%；扣点一致。",
    issues: "",
  })));

  assert.equal(result?.settlementAmount, 100);
  assert.deepEqual(result?.issues, []);
});

test("requires review when rate evidence is missing or mismatched even if amounts tie out", () => {
  const missing = parseAgentResponse(JSON.stringify(contractResult({ issues: "" })));
  const mismatch = parseAgentResponse(JSON.stringify(contractResult({
    basisReason: "扣点对比：结算单 22%；ERP 0%；扣点不一致。",
    issues: "",
  })));

  assert.equal(missing?.matched, false);
  assert.equal(missing?.issues[0].rowLabel, "扣点信息待确认");
  assert.equal(mismatch?.matched, false);
  assert.equal(mismatch?.issues[0].rowLabel, "扣点不一致");
  assert.match(mismatch?.issues[0].message ?? "", /ERP扣点：0%/);
});

test("requires rate review when an additional settlement deduction has no declared rate", () => {
  const result = parseAgentResponse(JSON.stringify(contractResult({
    settlementAmount: 225111.25,
    settlementAmountLabel: "本期实销金额",
    salesTotal: 225100,
    netSalesTotal: 197000,
    erpBasis: "sales_total",
    erpAmount: 225100,
    difference: -11.25,
    matched: true,
    basisReason: "扣点对比：结算单 12.5%，另列其他扣率金额（未提供档位）；ERP 12.5%。",
    issues: "扣点分档未完整提供。",
    name: "HZAD71",
  })));

  assert.equal(result?.matched, false);
  assert.equal(result?.issues[0].rowLabel, "扣点信息待确认");
  assert.match(result?.issues[0].message ?? "", /扣点分档未完整提供/);
});

test("does not treat an ERP missing-rate explanation as an ERP rate", () => {
  const result = parseAgentResponse(JSON.stringify(contractResult({
    settlementAmount: 199828.3,
    settlementAmountLabel: "本期实销金额（合计）",
    salesTotal: 199825.5,
    netSalesTotal: 161059.35,
    erpBasis: "sales_total",
    erpAmount: 199825.5,
    difference: -2.8,
    basisReason: "扣点对比：结算单19.4%、12%、14%；ERP 19.4%；扣点不一致。",
    issues: "结算单扣点：19.4%、12%、14%；ERP扣点：19.4%。ERP缺少12%、14%档位。",
    name: "NBNK01",
  })));

  assert.equal(result?.matched, false);
  assert.equal(result?.issues[0].rowLabel, "扣点不一致");
  assert.match(result?.issues[0].message ?? "", /ERP缺少12%、14%档/);
});

test("does not treat an ERP unreturned-rate explanation as an ERP rate", () => {
  const result = parseAgentResponse(JSON.stringify(contractResult({
    settlementAmount: 96493,
    settlementAmountLabel: "实际销售合计",
    salesTotal: 96499,
    netSalesTotal: 83431.44,
    erpBasis: "sales_total",
    erpAmount: 96499,
    difference: 6,
    matched: true,
    basisReason: "扣点对比：结算单15%、10%、12%；ERP 15%、10%；扣点不一致。",
    issues: "结算单扣点：15%、10%、12%；ERP扣点：15%、10%。结算单含12%扣点，ERP未返回12%档，可能包含其他合同、柜组或活动。",
    name: "HZSC37",
  })));

  assert.equal(result?.matched, false);
  assert.equal(result?.issues[0].rowLabel, "扣点不一致");
  assert.match(result?.issues[0].message ?? "", /ERP扣点：15%、10%/);
  assert.doesNotMatch(result?.issues[0].message ?? "", /ERP扣点：15%、10%、12%/);
});

test("does not count retention-rate conversion inputs as deduction rates", () => {
  const result = parseAgentResponse(JSON.stringify(contractResult({
    settlementAmount: 102627.9,
    settlementAmountLabel: "实际销售合计（扣点前销售额）",
    salesTotal: 102627.9,
    netSalesTotal: 92779.86,
    erpBasis: "sales_total",
    erpAmount: 102627.9,
    difference: 0,
    matched: true,
    basisReason: "扣点对比：结算单8%、10%（由提成率92%、90%换算）；ERP 8%、10%；扣点一致。",
    issues: "",
    name: "HZNK46",
  })));

  assert.equal(result?.matched, true);
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
  assert.match(result?.issues[0].message ?? "", /金额差：ERP 100\.00 − 结算单 101\.00 = -1\.00 元/);
  assert.match(result?.issues[0].message ?? "", /需确认结算金额是否已扣点/);
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
  assert.match(result?.issues[0].message ?? "", /金额差：ERP 500\.00 − 结算单 100\.00 = 400\.00 元/);
  assert.match(result?.issues[0].message ?? "", /需确认结算金额是否已扣点/);
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
  assert.match(result?.issues[0].message ?? "", /金额差：ERP 411,573\.00 − 结算单 439,496\.00 = -27,923\.00 元/);
  assert.match(result?.issues[0].message ?? "", /需确认结算金额是否已扣点/);
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
  assert.equal(result?.issues[0].differenceAmount, 242622.43);
  assert.equal(result?.issues[0].rowLabel, "销售范围待确认");
  assert.match(result?.issues[0].message ?? "", /金额差：ERP 558,398\.70 − 结算单 315,776\.27 = 242,622\.43 元/);
  assert.match(result?.issues[0].message ?? "", /差异金额仅用于定位，不能直接判定销售额不一致/);
  assert.equal(result?.rawAgentPayload.declaredErpBasis, "net_sales_total");
  assert.equal(result?.rawAgentPayload.appliedErpBasis, "sales_total");
  assert.equal(result?.rawAgentPayload.scopedErpMismatch, true);
});

test("uses the net-revenue plus coupon subtotal as pre-deduction sales", () => {
  const result = parseAgentResponse(JSON.stringify(contractResult({
    settlementAmount: 512047,
    settlementAmountLabel: "本月结算营业额小计（净营业额+券/折扣）",
    salesTotal: 512042,
    netSalesTotal: 424999.01,
    erpBasis: "sales_total",
    erpAmount: 512042,
    difference: -5,
    matched: true,
    basisReason: "扣点对比：结算单17%；ERP17%；扣点一致。本月结算营业额小计由净营业额与券（折扣）组成，属于扣点前销售额。",
    issues: "",
  })));

  assert.equal(result?.matched, true);
  assert.equal(result?.erpBasis, "sales_total");
  assert.equal(result?.erpAmount, 512042);
  assert.equal(result?.difference, -5);
  assert.deepEqual(result?.issues, []);
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
    basisReason: "扣点对比：结算单 11%；ERP 11%；扣点一致。结算单顶部付款金额1532389.00与ERP sales_total一致；下方营业额提成169500.00后得到应开票金额1362889.00。",
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
    basisReason: "扣点对比：结算单 10%；ERP 10%；扣点一致。两份同店同账期结算单合计的本期实销金额为-584.00元，属于销售额口径；ERP sales_total为-584.00元。",
    issues: "",
  })));

  assert.equal(result?.matched, true);
  assert.equal(result?.erpBasis, "sales_total");
  assert.equal(result?.difference, 0);
  assert.deepEqual(result?.issues, []);
});

test("suppresses non-actionable Agent review text when negative sales totals tie out", () => {
  const result = parseAgentResponse(JSON.stringify(contractResult({
    settlementAmount: -584,
    settlementAmountLabel: "合并本期实销金额",
    salesTotal: -584,
    netSalesTotal: -513.92,
    erpBasis: "sales_total",
    erpAmount: -584,
    difference: 0,
    matched: false,
    basisReason: "扣点对比：结算单 10%；ERP 10%；扣点一致。两份同店同账期结算单合计本期实销金额为-584.00，属于扣点前销售口径；ERP sales_total为-584.00。",
    issues: "本次为负数退货/冲销调整场景，第二份文件本期实销及含税结账金额均为0但产生手续费扣款，不能仅因ERP销售额对平而自动一致。ERP sales_total=-584.00，net_sales_total=-513.92；两份合计含税结账金额=-522.68，最终应付款约=-617.10，相关负数销售、扣款及付款差异需人工复核。",
  })));

  assert.equal(result?.matched, true);
  assert.equal(result?.difference, 0);
  assert.deepEqual(result?.issues, []);
  assert.equal(result?.rawAgentPayload.suppressedAgentIssue, true);
});

test("keeps scope mismatch in review even when the selected sales difference is small", () => {
  const result = parseAgentResponse(JSON.stringify(contractResult({
    settlementAmount: 98794.47,
    settlementAmountLabel: "本期实销金额合计",
    salesTotal: 98768.85,
    netSalesTotal: 88204.28,
    erpBasis: "sales_total",
    erpAmount: 98768.85,
    difference: -25.62,
    matched: false,
    basisReason: "两份结算单合计字段为本期实销金额，属于扣点前销售额口径。",
    issues: "两份结算单仅涉及扣率8%和12%的合同，而ERP返回还包含扣率8.5%和7.5%的明细，结算单范围与ERP聚合范围不一致，范围不可比。",
  })));

  assert.equal(result?.matched, false);
  assert.equal(result?.issues.length, 1);
  assert.equal(result?.issues[0].differenceAmount, -25.62);
  assert.match(result?.issues[0].message ?? "", /结算单扣点：8%、12%；ERP扣点：8.5%、7.5%。ERP多出8.5%、7.5%档，ERP缺少8%、12%档/);
  assert.equal(result?.rawAgentPayload.suppressedAgentIssue, false);
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
  assert.match(result?.issues[0].message ?? "", /金额差：ERP 226,706\.40 − 结算单 270,991\.70 = -44,285\.30 元/);
  assert.match(result?.issues[0].message ?? "", /需确认结算金额是否已扣点/);
  assert.equal(result?.rawAgentPayload.appliedErpBasis, "net_sales_total");
});

test("formats scope mismatch as a diagnostic conclusion while retaining the amount", () => {
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
  assert.equal(result?.issues[0].rowLabel, "销售范围待确认");
  assert.match(result?.issues[0].message ?? "", /金额差：ERP 500\.00 − 结算单 100\.00 = 400\.00 元/);
  assert.match(result?.issues[0].message ?? "", /差异金额仅用于定位，不能直接判定销售额不一致/);
  assert.equal(result?.issues[0].suggestion, "差异金额仅用于定位；请按合同、柜组或活动范围核对。");
  assert.equal(result?.issues[0].differenceAmount, 400);
});

test("puts a matched rate comparison before the exact amount difference", () => {
  const result = parseAgentResponse(JSON.stringify(contractResult({
    settlementAmount: 377078.1,
    settlementAmountLabel: "销售额",
    salesTotal: 377748.9,
    netSalesTotal: 328498.87,
    erpBasis: "sales_total",
    erpAmount: 377748.9,
    difference: 670.8,
    matched: false,
    issues: "结算单扣点：10%、15%、12%；ERP扣点：10%、15%、12%。扣点档一致。",
  })));

  assert.equal(result?.issues[0].message, "结算单扣点：10%、15%、12%；ERP扣点：10%、15%、12%。扣点档一致；金额差：ERP 377,748.90 − 结算单 377,078.10 = 670.80 元。");
  assert.equal(result?.issues[0].suggestion, "请核对销售期间、柜组、活动及跨月调整。");
});

test("keeps a derived settlement rate visible", () => {
  const result = parseAgentResponse(JSON.stringify(contractResult({
    settlementAmount: 218576,
    settlementAmountLabel: "销售金额",
    salesTotal: 272540,
    netSalesTotal: 248000,
    erpBasis: "sales_total",
    erpAmount: 272540,
    difference: 53964,
    matched: false,
    basisReason: "扣点对比：结算单 综合扣点约8.81%（按提成金额/销售额推算）；ERP 8%、10%；扣点不一致。",
    issues: "结算单扣点：综合扣点约8.81%（按提成金额/销售额推算）；ERP扣点：8%、10%。ERP多出8%、10%档位。",
  })));

  assert.equal(result?.issues[0].rowLabel, "扣点不一致");
  assert.match(result?.issues[0].message ?? "", /综合扣点约8\.81%（按提成金额\/销售额推算）/);
});

test("labels Chinese date ranges as a period review", () => {
  const result = parseAgentResponse(JSON.stringify(contractResult({
    settlementAmount: 1807041,
    settlementAmountLabel: "销售额",
    salesTotal: 1943494,
    netSalesTotal: 1664378.6,
    erpBasis: "sales_total",
    erpAmount: 1943494,
    difference: 136453,
    matched: false,
    issues: "结算单账期为2026年05月21日至2026年06月20日，ERP按自然月汇总。",
  })));

  assert.match(result?.issues[0].message ?? "", /金额差：ERP 1,943,494\.00 − 结算单 1,807,041\.00 = 136,453\.00 元/);
  assert.match(result?.issues[0].message ?? "", /结算期间与 ERP 取数期间可能不一致/);
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
  assert.equal(result?.issues[0].differenceAmount, 1158);
  assert.match(result?.issues[0].message ?? "", /结算单扣点：未提取；ERP扣点：未提供分档。/);
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
  assert.equal(result?.issues[0].differenceAmount, -622510.28);
  assert.match(result?.issues[0].message ?? "", /结算单扣点：未提取；ERP扣点：未提供分档。/);
});

test("does not turn an invoice-application watermark into a scope mismatch", () => {
  const result = parseAgentResponse(JSON.stringify(contractResult({
    settlementAmount: 100,
    settlementAmountLabel: "本期实销金额",
    salesTotal: 100,
    netSalesTotal: 90,
    erpBasis: "sales_total",
    erpAmount: 100,
    difference: 0,
    matched: false,
    basisReason: "扣点对比：结算单10%；ERP10%；扣点一致。",
    issues: "结算单含“预览页面，请勿用来结算”水印，属于申请开票阶段底纹。",
  })));

  assert.equal(result?.matched, true);
  assert.equal(result?.rawAgentPayload.scopedErpMismatch, false);
  assert.deepEqual(result?.issues, []);
});

test("labels a cross-month sales variance for daily-detail verification", () => {
  const result = parseAgentResponse(JSON.stringify(contractResult({
    settlementAmount: 87935.38,
    settlementAmountLabel: "本期实销金额",
    salesTotal: 99532.13,
    netSalesTotal: 78128.72,
    erpBasis: "sales_total",
    erpAmount: 99532.13,
    difference: 11596.75,
    matched: false,
    basisReason: "扣点对比：结算单21.5%；ERP21.5%；扣点一致。",
    issues: "结算单扣点：21.5%；ERP扣点：21.5%。扣点档一致；补入4月 11,806.05 元，在6月补入 209.30 元。",
  })));

  assert.equal(result?.matched, false);
  assert.equal(result?.rawAgentPayload.scopedErpMismatch, false);
  assert.equal(result?.issues[0].message, "结算单扣点：21.5%；ERP扣点：21.5%。扣点档一致；金额差：ERP 99,532.13 − 结算单 87,935.38 = 11,596.75 元。存在跨月调整，需按日销售和调整台账核验。");
  assert.equal(result?.issues[0].suggestion, "请按日销售、退货和跨月调整台账核验。");
});

test("preserves numeric differences as diagnostic amounts for scope or basis mismatches", () => {
  for (const issues of [
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
    assert.equal(result?.issues[0].differenceAmount, 23905.7);
    assert.match(result?.issues[0].message ?? "", /结算单扣点：/);
    assert.equal(result?.issues[0].rowLabel, issues.includes("扣率") ? "扣点不一致" : "销售范围待确认");
    assert.match(result?.issues[0].message ?? "", /23,905\.70/);
    assert.match(result?.issues[0].message ?? "", /差异金额仅用于定位，不能直接判定销售额不一致/);
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
  assert.match(prompt, /不得手工重输、合并重复空格或改写文件名/);
  assert.doesNotMatch(prompt, /ERP：C:\/files\/erp\.xlsx/);
  assert.match(prompt, /结算单1：C:\/files\/settlement\.xlsx/);
  assert.match(prompt, /SHNKA2/);
  assert.match(prompt, /参考主体：SHNKA2/);
  assert.match(prompt, /参考账期：2026-05/);
  assert.match(prompt, /严禁运行 python3/);
  assert.match(prompt, /首次 MCP 查询优先使用参考主体/);
  assert.match(prompt, /如果结算单是 \.xlsx、\.xls 或 \.xlsm，禁止使用 MinerU、OCR 或 Subagent/);
  assert.match(prompt, /本地 MCP JSON-RPC 命令/);
  assert.match(prompt, /不要调用 CherryStudio 原生工具列表里的 mcp__wd3FCVOL5nMNLODNeRfOr__summarize_store_period/);
  assert.match(prompt, /MCP 没有匹配记录.*不要把金额当成 0/);
  assert.doesNotMatch(prompt, /后端已从文件名确定本次店铺号/);
  assert.match(prompt, /erpBasis/);
  assert.match(prompt, /salesTotal/);
  assert.match(prompt, /netSalesTotal/);
  assert.match(prompt, /matched/);
  assert.match(prompt, /sales_total 表示扣点前销售额/);
  assert.match(prompt, /本月结算营业额小计.*净营业额.*券/);
  assert.match(prompt, /不得根据文件名、备注.*推断税额口径/);
  assert.match(prompt, /底纹本身不影响销售额核对/);
  assert.match(prompt, /按日销售、退货和调整台账核验/);
  assert.match(prompt, /金额为负就判异常/);
  assert.match(prompt, /可输出 matched=true/);
  assert.match(prompt, /提成\/扣点金额 ÷ 销售额 × 100，先精确计算后按四舍五入保留两位小数/);
  assert.match(prompt, /销售额－供应商应得额）÷销售额 × 100/);
  assert.match(prompt, /不得估算，也不得把其他扣项金额混入提成\/扣点金额/);
  assert.match(prompt, /其他扣率金额（未提供档位）/);
  assert.match(prompt, /matched 必须为 false/);
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

test("turns missing ERP rows into a review result instead of an execution failure", async () => {
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
    const result = await sendReconciliationPrompt({ agentId: "agent-1", agentName: "锐力", sessionId: "session-1" }, "prompt");
    assert.equal(result.missingErp, true);
    assert.equal(result.erpAmount, null);
    assert.equal(result.difference, null);
    assert.equal(result.issues.length, 1);
    assert.match(result.issues[0].message, /WHNK59/);
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
