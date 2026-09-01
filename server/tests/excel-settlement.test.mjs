import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExcelSettlementExtraction,
  chooseExcelSettlementCandidate,
  extractPeriodFromFileName,
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
  assert.equal(extractPeriodFromRows("NBSC25-2.xls", [
    ["结算起止日期", "2026-05-01", "至", "2026-05-31"],
    ["合同期", "2022-06-01 至 2029-12-31"],
  ]), "2026-05");
  assert.equal(extractPeriodFromRows("NBSC25-2.xls", [
    ["结算起止日期", "46143.0", "至", "46173.0"],
    ["合同期", "2022-06-01 至 2029-12-31"],
  ]), null);
  assert.equal(extractPeriodFromRows("SHNKA2结算单-202605.pdf", []), "2026-05");
  const currentYear = new Date().getFullYear();
  assert.equal(extractPeriodFromFileName("WHAD28-5月结算单1.pdf"), `${currentYear}-05`);
  assert.equal(extractPeriodFromFileName("WHAD30 -5月结算单2.pdf"), `${currentYear}-05`);
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

test("builds a settlement extraction result from a chosen Excel candidate", () => {
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
  assert.equal(extraction.erpBasis, "ambiguous");
  assert.match(extraction.basisReason, /本地 Excel 快速抽取/);
  assert.deepEqual(extraction.issues, []);
});
