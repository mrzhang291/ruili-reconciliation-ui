import assert from "node:assert/strict";
import test from "node:test";
import {
  buildErpLookupKeys,
  buildReconciliationResult,
  calculateErpTotals,
  chooseErpBasis,
  extractShopCodesFromFileName,
  matchesLookupKey,
  normalizeShopNo,
  periodToMonthKey,
} from "../dist/lib/erp-base-query.js";

test("normalizes the ERP lookup keys", () => {
  assert.equal(periodToMonthKey("2026-05"), "202605");
  assert.equal(periodToMonthKey("202605"), "202605");
  assert.equal(normalizeShopNo(" shnka2 "), "SHNKA2");
});

test("calculates pre-deduction and post-deduction ERP totals", () => {
  const totals = calculateErpTotals([
    { salesAmount: 100, deductionRate: 0.1 },
    { salesAmount: 200, deductionRate: 16 / 100 },
  ]);

  assert.deepEqual(totals, { salesTotal: 300, netSalesTotal: 258 });
});

test("always compares against ERP sales total", () => {
  assert.deepEqual(chooseErpBasis(258, { salesTotal: 300, netSalesTotal: 258 }), {
    basis: "sales_total",
    label: "ERP销售额",
    erpAmount: 300,
    difference: 42,
    matched: false,
  });
});

test("matches ERP rows by shop number only", () => {
  const row = { shopNo: "SHNKA2" };

  assert.equal(matchesLookupKey(row, "SHNKA2"), true);
  assert.equal(matchesLookupKey(row, "150604"), false);
  assert.equal(matchesLookupKey(row, "0"), false);
});

test("extracts ERP lookup keys from settlement file names", () => {
  assert.deepEqual(extractShopCodesFromFileName("SHAD74&SHNK77结算单-202605.xlsx"), ["SHAD74", "SHNK77"]);
  assert.deepEqual(extractShopCodesFromFileName("HZAD02-5月结算单.pdf"), ["HZAD02"]);
  assert.deepEqual(extractShopCodesFromFileName("Sheet1"), []);
  assert.deepEqual(buildErpLookupKeys("SHNKA2结算单-202605.pdf"), ["SHNKA2"]);
  assert.deepEqual(buildErpLookupKeys("账单1.pdf", "SHNKA2"), []);
});

test("builds the final reconciliation result from Agent extraction and ERP facts", () => {
  const result = buildReconciliationResult({
    name: "SHNKA2",
    period: "2026-05",
    settlementAmount: 259,
    settlementAmountLabel: "结算净营业额",
    issues: [],
    rawAgentPayload: {
      name: "SHNKA2",
      period: "2026-05",
      settlementAmount: 259,
      settlementAmountLabel: "结算净营业额",
      issues: "",
    },
  }, {
    lookupKey: "SHNKA2",
    period: "2026-05",
    month: "202605",
    rows: [],
    salesTotal: 300,
    netSalesTotal: 258,
  });

  assert.equal(result.erpAmount, 300);
  assert.equal(result.difference, 41);
  assert.equal(result.rawAgentPayload.recalculatedDifference, 41);
  assert.equal(result.rawAgentPayload.erpBasis, "sales_total");
  assert.equal(result.issues[0].differenceAmount, 41);
});
