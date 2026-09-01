import assert from "node:assert/strict";
import test from "node:test";
import {
  buildErpLookupKeys,
  calculateErpTotals,
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
