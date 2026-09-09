import assert from "node:assert/strict";
import test from "node:test";
import {
  assertNoDuplicateErpKeys,
  buildErpDataFromParsedRows,
  parseErpRows,
  summarizeParsedErpRows,
} from "../dist/lib/erp-import.js";

test("parses ERP master rows with the Feishu schema", () => {
  const rows = parseErpRows([
    ["商城名称", "店铺号", "供货商编码", "扣点", "销售额", "月份"],
    ["0", "NBSC25", "0", "12.5%", "583,306.00", "2026-05"],
    ["上海百货", "SHNKA2", "086204", "0.1", "100", "202605"],
    ["0", "WXAD58", "0", "0", "-50", "202605"],
  ]);

  assert.deepEqual(rows, [
    { shopNo: "NBSC25", deductionRate: 0.125, salesAmount: 583306, month: "202605", sourceRow: 2 },
    { shopNo: "SHNKA2", deductionRate: 0.1, salesAmount: 100, month: "202605", sourceRow: 3 },
    { shopNo: "WXAD58", deductionRate: 0, salesAmount: -50, month: "202605", sourceRow: 4 },
  ]);
  assert.deepEqual(summarizeParsedErpRows(rows), [{
    month: "202605",
    rows: 3,
    salesTotal: 583356,
    netSalesTotal: 510432.75,
    existingRows: 0,
    deletedRows: 0,
    createdRows: 0,
    updatedRows: 0,
    sampleRows: rows,
  }]);

  const erpData = buildErpDataFromParsedRows(rows, "NBSC25", "2026-05");
  assert.equal(erpData.rows.length, 1);
  assert.equal(erpData.salesTotal, 583306);
});

test("rejects non ERP spreadsheets early", () => {
  assert.throws(
    () => parseErpRows([["店铺号", "销售额"], ["NBSC25", "583306"]]),
    /缺少必要表头/,
  );
  assert.throws(
    () => parseErpRows([
      ["商城名称", "店铺号", "供货商编码", "扣点", "销售额", "月份"],
      ["0", "", "0", "10%", "583306", "202605"],
    ]),
    /店铺号为空/,
  );
});

test("ignores mall and supplier fields when checking ERP keys", () => {
  const splitRows = parseErpRows([
    ["商城名称", "店铺号", "供货商编码", "扣点", "销售额", "月份"],
    ["上海润向贸易有限公司", "SHADB9", "0", "0.12", "155900", "202605"],
    ["0", "NJAD46", "0", "0.13", "495606", "202605"],
    ["0", "NJAD46", "0", "0.14", "100", "202605"],
  ]);
  assert.doesNotThrow(() => assertNoDuplicateErpKeys(splitRows));

  assert.throws(
    () => {
      const rows = parseErpRows([
        ["商城名称", "店铺号", "供货商编码", "扣点", "销售额", "月份"],
        ["0", "NBSC25", "0", "0.1", "1", "202605"],
        ["0", "nbsc25", "0", "0.1", "2", "202605"],
      ]);
      assertNoDuplicateErpKeys(rows);
    },
    /Excel 内部存在重复唯一键/,
  );
});
