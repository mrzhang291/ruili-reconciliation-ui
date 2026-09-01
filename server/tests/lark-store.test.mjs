import assert from "node:assert/strict";
import test from "node:test";
import { findCreatedRecordId, findSupersededTaskRecords, formulaChecksReady, isLarkRecordId, resolveTaskCompletionStatus, rowsFromPage, uniqueActionableIssues } from "../dist/lib/lark-store.js";

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

test("treats out-of-threshold or suspicious results as review, not system failure", () => {
  assert.equal(resolveTaskCompletionStatus({ differenceCheck: "通过", reasonablenessCheck: "通过", differenceAmount: 199.99 }, 0), "已一致");
  assert.equal(resolveTaskCompletionStatus({ differenceCheck: "通过", reasonablenessCheck: "不通过", differenceAmount: 201 }, 0), "待审核");
  assert.equal(resolveTaskCompletionStatus({ differenceCheck: "通过", reasonablenessCheck: "通过", differenceAmount: 0 }, 1), "待审核");
  assert.equal(resolveTaskCompletionStatus({ differenceCheck: "不通过", reasonablenessCheck: "通过", differenceAmount: 0 }, 0), "失败");
});

test("validates Feishu record IDs before calling lark-cli", () => {
  assert.equal(isLarkRecordId("recvttJzkzE1uo"), true);
  assert.equal(isLarkRecordId("not-a-real-task"), false);
});

test("deduplicates review issues and ignores empty messages", () => {
  const issues = uniqueActionableIssues([
    { rowLabel: "总差额", fieldName: "ERP销售额", differenceAmount: 300, message: "超过阈值" },
    { rowLabel: "总差额", fieldName: "ERP销售额", differenceAmount: 300, message: "超过阈值" },
    { rowLabel: "Agent 对账提示", fieldName: "结算金额", differenceAmount: 0, message: "   " },
  ]);

  assert.equal(issues.length, 1);
  assert.equal(issues[0].message, "超过阈值");
});

test("finds only older pending tasks for the same settlement file", () => {
  const task = (overrides = {}) => ({
    id: "current",
    taskId: "TASK-CURRENT",
    name: null,
    shopNo: "SZSC32",
    period: "2026-05",
    status: "NEEDS_REVIEW",
    batchId: null,
    ruleVersions: null,
    settlementAmount: null,
    erpAmount: null,
    differenceAmount: null,
    agentDifference: null,
    differenceCheck: null,
    reasonablenessCheck: null,
    failureReason: null,
    cancelReason: null,
    rawAgentJson: null,
    startedAt: null,
    completedAt: null,
    createdAt: "2026-09-01T03:00:00.000Z",
    createdBy: { id: "u", name: "u" },
    settlementFile: { name: "SZSC32-5月结算单.pdf" },
    erpFile: null,
    reviewIds: [],
    ...overrides,
  });

  const matches = findSupersededTaskRecords(task(), [
    task({ id: "older-same", createdAt: "2026-08-31T03:00:00.000Z" }),
    task({ id: "same-time", createdAt: "2026-09-01T03:00:00.000Z" }),
    task({ id: "newer-same", createdAt: "2026-09-02T03:00:00.000Z" }),
    task({ id: "old-success", status: "SUCCEEDED", createdAt: "2026-08-31T03:00:00.000Z" }),
    task({ id: "other-file", settlementFile: { name: "SZSC32-5月租赁.pdf" }, createdAt: "2026-08-31T03:00:00.000Z" }),
    task({ id: "other-shop", shopNo: "SZNK12", createdAt: "2026-08-31T03:00:00.000Z" }),
  ]);

  assert.deepEqual(matches.map((item) => item.id), ["older-same", "same-time"]);
});
