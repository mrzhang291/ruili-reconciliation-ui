import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExcelSettlementExtraction,
  chooseExcelSettlementCandidate,
  extractPeriodFromRows,
  extractSettlementCandidates,
} from "../dist/lib/excel-settlement.js";

test("extracts labeled settlement amount candidates from Excel rows", () => {
  const rows = [
    ["应付小写", "", "1488674.79", "", "销售金额", "", "2001043.00", "", "结算净营业额", "1677854.64"],
    ["结算佣金", "", "462378.71", "", "销售数量", "", "4301.00"],
  ];

  const candidates = extractSettlementCandidates(rows);

  assert.equal(candidates.some((candidate) => candidate.label === "结算净营业额" && candidate.amount === 1677854.64), true);
  assert.equal(candidates.some((candidate) => candidate.label === "销售金额" && candidate.amount === 2001043), false);
  assert.equal(candidates.some((candidate) => candidate.label === "应付小写" && candidate.amount === 1488674.79), false);
  assert.equal(candidates.some((candidate) => candidate.label === "应付小写" && candidate.amount === 2001043), false);
  assert.equal(candidates.some((candidate) => candidate.label === "销售数量"), false);
});

test("extracts settlement period without treating amounts as YYYYMM", () => {
  assert.equal(extractPeriodFromRows("NBAD78.xlsx", [
    ["打印日期: 2026-06-02"],
    ["结算起止日期：2026-05-01 至 2026-05-31"],
    ["销售金额", "2001043.00"],
  ]), "2026-05");
  assert.equal(extractPeriodFromRows("SHNKA2结算单-202605.pdf", []), "2026-05");
});

test("chooses only a unique net settlement amount without ERP proximity", () => {
  const candidates = extractSettlementCandidates([
    ["销售金额", "2001043.00"],
    ["结算净营业额", "1677854.64"],
  ]);

  const chosen = chooseExcelSettlementCandidate(candidates);

  assert.equal(chosen?.label, "结算净营业额");
  assert.equal(chosen?.amount, 1677854.64);

  const ambiguous = extractSettlementCandidates([
    ["结算净营业额", "100.00"],
    ["本月结算营业额小计", "200.00"],
  ]);
  assert.equal(chooseExcelSettlementCandidate(ambiguous), null);
});

test("builds the five-field extraction result from a chosen Excel candidate", () => {
  const extraction = buildExcelSettlementExtraction({
    name: "NBAD78",
    period: "2026-05",
    candidates: [],
  }, {
    label: "结算净营业额",
    amount: 1677854.64,
    priority: 30,
    row: 11,
    column: 13,
  });

  assert.equal(extraction.name, "NBAD78");
  assert.equal(extraction.period, "2026-05");
  assert.equal(extraction.settlementAmount, 1677854.64);
  assert.equal(extraction.settlementAmountLabel, "结算净营业额");
  assert.deepEqual(extraction.issues, []);
});
