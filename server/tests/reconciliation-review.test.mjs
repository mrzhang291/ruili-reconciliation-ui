import assert from "node:assert/strict";
import test from "node:test";
import {
  hasCrossMonthSalesAdjustment,
  isScopedReconciliationIssue,
} from "../dist/lib/reconciliation-review.js";

test("does not classify invoice-application watermarks as scope mismatches", () => {
  assert.equal(isScopedReconciliationIssue("结算单含预览页面，请勿用来结算水印。"), false);
  assert.equal(isScopedReconciliationIssue("ERP 全店汇总与结算单范围不一致。"), true);
});

test("recognizes cross-month sales adjustment evidence", () => {
  assert.equal(hasCrossMonthSalesAdjustment("补入4月 11,806.05 元，在6月补入 209.30 元。"), true);
  assert.equal(hasCrossMonthSalesAdjustment("本月销售额正常。"), false);
});
