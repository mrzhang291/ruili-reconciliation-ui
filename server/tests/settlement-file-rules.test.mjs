import assert from "node:assert/strict";
import test from "node:test";
import { settlementFileRejectionReason } from "../dist/lib/settlement-file-rules.js";

test("rejects files that should not enter settlement reconciliation", () => {
  assert.match(settlementFileRejectionReason("AD15库存商品盘点表-5月.xls") ?? "", /盘点表/);
  assert.match(settlementFileRejectionReason("WXSC11-扣款明细(1).pdf") ?? "", /扣款明细/);
  assert.match(settlementFileRejectionReason("SZSC19-5月明细.pdf.xls") ?? "", /明细文件/);
  assert.match(settlementFileRejectionReason("SZSC32-5月租赁.pdf") ?? "", /租赁/);
  assert.match(settlementFileRejectionReason("SHAD74&SHNK77结算单-202605.xlsx") ?? "", /多个店铺号/);
});

test("rejects mojibake multipart filenames after decoding", () => {
  const rawName = Buffer.from("WXSC11-扣款明细(1).pdf", "utf8").toString("latin1");
  assert.match(settlementFileRejectionReason(rawName) ?? "", /扣款明细/);
});

test("keeps ordinary settlement files uploadable", () => {
  assert.equal(settlementFileRejectionReason("HZAD02-5月结算单.pdf"), null);
  assert.equal(settlementFileRejectionReason("NBAD78.xlsx"), null);
  assert.equal(settlementFileRejectionReason("SHNKA2结算单-202605.pdf"), null);
  assert.equal(settlementFileRejectionReason("NJAD01(NJTM01)结算单-202605.pdf"), null);
});
