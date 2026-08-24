import assert from "node:assert/strict";
import test from "node:test";
import { findCreatedRecordId, formulaChecksReady, rowsFromPage } from "../dist/lib/lark-store.js";

test("reads the record ID returned by lark-cli record-upsert", () => {
  assert.equal(findCreatedRecordId({ data: { record: { record_id_list: ["recvsUgd2jAPoR"] } } }), "recvsUgd2jAPoR");
});

test("ignores tombstone rows returned for deleted Feishu records", () => {
  assert.deepEqual(rowsFromPage({ data: {
    data: [[null]], fields: ["任务ID"], record_id_list: ["rec_deleted"], record_not_found: ["rec_deleted"],
  } }), []);
});

test("waits until Feishu formula checks leave their pending state", () => {
  assert.equal(formulaChecksReady({ differenceCheck: "待校验", reasonablenessCheck: "通过", differenceAmount: -5 }), false);
  assert.equal(formulaChecksReady({ differenceCheck: "通过", reasonablenessCheck: "通过", differenceAmount: -5 }), true);
});
