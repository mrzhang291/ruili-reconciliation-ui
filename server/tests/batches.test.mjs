import assert from "node:assert/strict";
import test from "node:test";
import { buildBatchExecutionGroups, buildBatchExportCsv, mergeTargetDocumentsForSync, rebuildBatchGroups } from "../dist/lib/batch-store.js";
import {
  applyDocumentTaskInterrupted,
  applyDocumentTaskStarted,
  settledDocumentIssues,
  unresolvedSplitGroupScopeReviewNote,
  validateBatchSettlementUpload,
} from "../dist/routes/batches.js";

test("marks pending batch documents as processing when a task starts", () => {
  const document = { status: "READY", taskId: null, updatedAt: "old" };
  applyDocumentTaskStarted(document, "rec123", "now");
  assert.deepEqual(document, { status: "PROCESSING", taskId: "rec123", updatedAt: "now" });
});

test("does not downgrade settled batch documents when a fast task has already completed", () => {
  const document = { status: "SUCCEEDED", taskId: "rec123", updatedAt: "done" };
  applyDocumentTaskStarted(document, "rec123", "later");
  assert.deepEqual(document, { status: "SUCCEEDED", taskId: "rec123", updatedAt: "later" });
});

test("releases interrupted batch documents for retry", () => {
  const document = { status: "PROCESSING", taskId: "rec123", issues: [], updatedAt: "old" };
  assert.equal(applyDocumentTaskInterrupted(document, "服务重启后恢复", "now"), true);
  assert.deepEqual(document, {
    status: "READY",
    taskId: null,
    issues: ["服务重启后恢复"],
    updatedAt: "now",
  });
});

test("targeted batch sync preserves newer statuses from the latest batch state", () => {
  const stale = {
    id: "batch-1",
    recordId: null,
    documents: [
      { id: "doc-a", status: "PROCESSING", taskId: "rec-a" },
      { id: "doc-b", status: "PROCESSING", taskId: "rec-b" },
    ],
  };
  const latest = {
    id: "batch-1",
    recordId: "rec-batch",
    documents: [
      { id: "doc-a", status: "SUCCEEDED", taskId: "rec-a" },
      { id: "doc-b", status: "READY", taskId: null },
    ],
  };

  const merged = mergeTargetDocumentsForSync(stale, ["doc-b"], latest);

  assert.equal(merged.recordId, "rec-batch");
  assert.equal(merged.documents[0].status, "SUCCEEDED");
  assert.equal(merged.documents[1].status, "PROCESSING");
});

test("mixed succeeded and cancelled documents do not mark the batch completed", () => {
  const state = {
    id: "batch-1",
    documents: [
      { id: "doc-a", status: "SUCCEEDED", shopNo: "NJAD01", period: "2026-05", version: 1, confirmedSettlementAmount: 10, erpSalesTotal: 10, taskId: "rec-a", issues: [] },
      { id: "doc-b", status: "CANCELLED", shopNo: "NJAD02", period: "2026-05", version: 1, confirmedSettlementAmount: 20, erpSalesTotal: null, taskId: "rec-b", issues: [] },
    ],
    groups: [],
    status: "PROCESSING",
  };

  rebuildBatchGroups(state);

  assert.equal(state.status, "CANCELLED");
});

test("auto-resolves split documents when the shop-period group total matches ERP", () => {
  const state = {
    id: "batch-1",
    documents: [
      { id: "doc-a", status: "NEEDS_REVIEW", shopNo: "WHAD28", period: "2026-05", version: 1, confirmedSettlementAmount: 69517.25, erpSalesTotal: 98768.85, taskId: "rec-a", issues: ["单张差额较大"] },
      { id: "doc-b", status: "NEEDS_REVIEW", shopNo: "WHAD28", period: "2026-05", version: 1, confirmedSettlementAmount: 29277.22, erpSalesTotal: 98768.85, taskId: "rec-b", issues: ["单张差额较大"] },
    ],
    groups: [],
    status: "PROCESSING",
  };

  rebuildBatchGroups(state);

  assert.equal(state.status, "COMPLETED");
  assert.equal(state.groups[0].status, "SUCCEEDED");
  assert.equal(state.groups[0].settlementAmount, 98794.47);
  assert.equal(state.groups[0].differenceAmount, -25.62);
  assert.deepEqual(state.documents.map((document) => document.status), ["SUCCEEDED", "SUCCEEDED"]);
  assert.deepEqual(state.documents.flatMap((document) => document.issues), []);
});

test("precheck groups same shop-period files into one execution unit", () => {
  const state = {
    id: "batch-1",
    documents: [
      { id: "doc-a", status: "READY", shopNo: "WHAD28", period: "2026-05", version: 1, confirmedSettlementAmount: null, erpSalesTotal: null, taskId: null, issues: [], fileName: "WHAD28-5月结算单1.pdf" },
      { id: "doc-b", status: "READY", shopNo: "WHAD28", period: "2026-05", version: 1, confirmedSettlementAmount: null, erpSalesTotal: null, taskId: null, issues: [], fileName: "WHAD28-5月结算单2.pdf" },
    ],
    groups: [],
    status: "READY",
  };

  rebuildBatchGroups(state);
  const units = buildBatchExecutionGroups(state);

  assert.equal(units.length, 1);
  assert.deepEqual(units[0].documentIds, ["doc-a", "doc-b"]);
  assert.equal(units[0].fileName, "WHAD28 2026-05 合并结算单（2份）");
});

test("combined task group result is counted once", () => {
  const state = {
    id: "batch-1",
    documents: [
      { id: "doc-a", status: "SUCCEEDED", shopNo: "WHAD28", period: "2026-05", version: 1, confirmedSettlementAmount: null, groupSettlementAmount: 98794.47, groupErpSalesTotal: 98768.85, erpSalesTotal: 98768.85, taskId: "rec-a", issues: [] },
      { id: "doc-b", status: "SUCCEEDED", shopNo: "WHAD28", period: "2026-05", version: 1, confirmedSettlementAmount: null, groupSettlementAmount: 98794.47, groupErpSalesTotal: 98768.85, erpSalesTotal: 98768.85, taskId: "rec-a", issues: [] },
    ],
    groups: [],
    status: "PROCESSING",
  };

  rebuildBatchGroups(state);

  assert.equal(state.status, "COMPLETED");
  assert.equal(state.groups[0].status, "SUCCEEDED");
  assert.equal(state.groups[0].settlementAmount, 98794.47);
  assert.equal(state.groups[0].differenceAmount, -25.62);
});

test("keeps combined task group review even when the group difference is within threshold", () => {
  const state = {
    id: "batch-1",
    documents: [
      {
        id: "doc-a",
        status: "NEEDS_REVIEW",
        shopNo: "WHAD28",
        period: "2026-05",
        version: 1,
        confirmedSettlementAmount: null,
        groupSettlementAmount: 98794.47,
        groupErpSalesTotal: 98768.85,
        erpSalesTotal: 98768.85,
        taskId: "rec-a",
        issues: ["ERP聚合范围与结算单范围不一致，范围不可比。"],
      },
      {
        id: "doc-b",
        status: "NEEDS_REVIEW",
        shopNo: "WHAD28",
        period: "2026-05",
        version: 1,
        confirmedSettlementAmount: null,
        groupSettlementAmount: 98794.47,
        groupErpSalesTotal: 98768.85,
        erpSalesTotal: 98768.85,
        taskId: "rec-a",
        issues: ["ERP聚合范围与结算单范围不一致，范围不可比。"],
      },
    ],
    groups: [],
    status: "PROCESSING",
  };

  rebuildBatchGroups(state);

  assert.equal(state.status, "NEEDS_REVIEW");
  assert.equal(state.groups[0].status, "NEEDS_REVIEW");
  assert.equal(state.groups[0].settlementAmount, 98794.47);
  assert.equal(state.groups[0].differenceAmount, -25.62);
  assert.deepEqual(state.documents.map((document) => document.status), ["NEEDS_REVIEW", "NEEDS_REVIEW"]);
  assert.match(state.groups[0].issues.join(" "), /范围不可比/);
});

test("auto-resolves split documents when a matched sibling already succeeded", () => {
  const state = {
    id: "batch-1",
    documents: [
      {
        id: "doc-a",
        status: "SUCCEEDED",
        shopNo: "NBSC25",
        period: "2026-05",
        version: 1,
        confirmedSettlementAmount: 583306,
        confirmedSettlementLabel: "销售金额",
        erpSalesTotal: 583306,
        erpRawSalesTotal: 583306,
        erpRawNetSalesTotal: 495810.1,
        taskId: "rec-a",
        issues: [],
      },
      {
        id: "doc-b",
        status: "NEEDS_REVIEW",
        shopNo: "NBSC25",
        period: "2026-05",
        version: 1,
        confirmedSettlementAmount: 0,
        confirmedSettlementLabel: "销售金额",
        erpSalesTotal: 495810.1,
        erpRawSalesTotal: 583306,
        erpRawNetSalesTotal: 495810.1,
        taskId: "rec-b",
        issues: ["0 销售费用单单张差额较大"],
      },
    ],
    groups: [],
    status: "NEEDS_REVIEW",
  };

  rebuildBatchGroups(state);

  assert.equal(state.status, "COMPLETED");
  assert.equal(state.groups[0].status, "SUCCEEDED");
  assert.equal(state.groups[0].settlementAmount, 583306);
  assert.equal(state.groups[0].differenceAmount, 0);
  assert.deepEqual(state.documents.map((document) => document.status), ["SUCCEEDED", "SUCCEEDED"]);
});

test("auto-resolves split documents using sales candidates when selected bases are mixed", () => {
  const state = {
    id: "batch-1",
    documents: [
      {
        id: "doc-a",
        status: "NEEDS_REVIEW",
        shopNo: "WHAD28",
        period: "2026-05",
        version: 1,
        confirmedSettlementAmount: 60685.26,
        confirmedSettlementLabel: "含税结账金额",
        salesSettlementAmount: 69517.25,
        salesSettlementLabel: "本期实销金额",
        erpSalesTotal: 88204.28,
        erpRawSalesTotal: 98768.85,
        erpRawNetSalesTotal: 88204.28,
        taskId: "rec-a",
        issues: ["单张差额较大"],
      },
      {
        id: "doc-b",
        status: "NEEDS_REVIEW",
        shopNo: "WHAD28",
        period: "2026-05",
        version: 1,
        confirmedSettlementAmount: 29277.22,
        confirmedSettlementLabel: "本期实销金额",
        salesSettlementAmount: 29277.22,
        salesSettlementLabel: "本期实销金额",
        erpSalesTotal: 98768.85,
        erpRawSalesTotal: 98768.85,
        erpRawNetSalesTotal: 88204.28,
        taskId: "rec-b",
        issues: ["单张差额较大"],
      },
    ],
    groups: [],
    status: "NEEDS_REVIEW",
  };

  rebuildBatchGroups(state);

  assert.equal(state.status, "COMPLETED");
  assert.equal(state.groups[0].status, "SUCCEEDED");
  assert.equal(state.groups[0].settlementAmount, 98794.47);
  assert.equal(state.groups[0].erpSalesTotal, 98768.85);
  assert.equal(state.groups[0].differenceAmount, -25.62);
  assert.deepEqual(state.documents.map((document) => document.confirmedSettlementAmount), [69517.25, 29277.22]);
  assert.deepEqual(state.documents.map((document) => document.confirmedSettlementLabel), ["本期实销金额", "本期实销金额"]);
  assert.deepEqual(state.documents.map((document) => document.erpSalesTotal), [98768.85, 98768.85]);
  assert.deepEqual(state.documents.map((document) => document.status), ["SUCCEEDED", "SUCCEEDED"]);
});

test("auto-resolves split documents by recovering sales candidates from issue text", () => {
  const state = {
    id: "batch-1",
    documents: [
      {
        id: "doc-a",
        status: "NEEDS_REVIEW",
        shopNo: "WHAD28",
        period: "2026-05",
        version: 1,
        confirmedSettlementAmount: 60685.26,
        confirmedSettlementLabel: "含税结账金额",
        erpSalesTotal: 88204.28,
        erpRawSalesTotal: 98768.85,
        erpRawNetSalesTotal: 88204.28,
        taskId: "rec-a",
        issues: ["最接近的12%扣率ERP子集销售额为66549，与本期实销金额69517.25相差2968.25；Agent 理由：已扣除12%扣率8342.07元后形成含税结账金额60685.26元。"],
      },
      {
        id: "doc-b",
        status: "NEEDS_REVIEW",
        shopNo: "WHAD28",
        period: "2026-05",
        version: 1,
        confirmedSettlementAmount: 26485.05,
        confirmedSettlementLabel: "含税结账金额",
        erpSalesTotal: 88204.28,
        erpRawSalesTotal: 98768.85,
        erpRawNetSalesTotal: 88204.28,
        taskId: "rec-b",
        issues: ["最接近的8%扣率ERP子集销售额为30463.85，与本期实销金额29277.22相差1186.63；Agent 理由：结算单同时列示扣率2342.18及其他扣率449.99。"],
      },
    ],
    groups: [],
    status: "NEEDS_REVIEW",
  };

  rebuildBatchGroups(state);

  assert.equal(state.status, "COMPLETED");
  assert.equal(state.groups[0].status, "SUCCEEDED");
  assert.equal(state.groups[0].settlementAmount, 98794.47);
  assert.equal(state.groups[0].differenceAmount, -25.62);
  assert.deepEqual(state.documents.map((document) => document.confirmedSettlementAmount), [69517.25, 29277.22]);
  assert.deepEqual(state.documents.map((document) => document.confirmedSettlementLabel), ["本期实销金额", "本期实销金额"]);
});

test("batch export applies split document auto-resolution", () => {
  const state = {
    id: "batch-1",
    documents: [
      { id: "doc-a", status: "NEEDS_REVIEW", shopNo: "WHAD28", period: "2026-05", version: 1, confirmedSettlementAmount: 69517.25, erpSalesTotal: 98768.85, taskId: "rec-a", groupId: null, fileName: "a.pdf", sourceFileName: null, issues: ["单张差额较大"] },
      { id: "doc-b", status: "NEEDS_REVIEW", shopNo: "WHAD28", period: "2026-05", version: 1, confirmedSettlementAmount: 29277.22, erpSalesTotal: 98768.85, taskId: "rec-b", groupId: null, fileName: "b.pdf", sourceFileName: null, issues: ["单张差额较大"] },
    ],
    groups: [],
    status: "FAILED",
  };

  const csv = buildBatchExportCsv(state);

  assert.match(csv, /SUCCEEDED/);
  assert.match(csv, /-25\.62/);
  assert.doesNotMatch(csv, /29251\.6/);
  assert.doesNotMatch(csv, /NEEDS_REVIEW/);
  assert.doesNotMatch(csv, /单张差额较大/);
});

test("keeps split documents in review when the group total still differs from ERP", () => {
  const state = {
    id: "batch-1",
    documents: [
      { id: "doc-a", status: "NEEDS_REVIEW", shopNo: "WHMB03", period: "2026-05", version: 1, confirmedSettlementAmount: 37141.89, erpSalesTotal: 49353, taskId: "rec-a", issues: ["单张差额较大"] },
      { id: "doc-b", status: "NEEDS_REVIEW", shopNo: "WHMB03", period: "2026-05", version: 1, confirmedSettlementAmount: 87001.25, erpSalesTotal: 49353, taskId: "rec-b", issues: ["单张差额较大"] },
    ],
    groups: [],
    status: "PROCESSING",
  };

  rebuildBatchGroups(state);

  assert.equal(state.status, "NEEDS_REVIEW");
  assert.equal(state.groups[0].status, "NEEDS_REVIEW");
  assert.equal(state.groups[0].settlementAmount, 124143.14);
  assert.equal(state.groups[0].differenceAmount, -74790.14);
  assert.deepEqual(state.documents.map((document) => document.status), ["NEEDS_REVIEW", "NEEDS_REVIEW"]);
});

test("explains unresolved split groups as scope mismatches", () => {
  const state = {
    id: "batch-1",
    documents: [
      { id: "doc-a", status: "NEEDS_REVIEW", shopNo: "WHMB03", period: "2026-05", version: 1, confirmedSettlementAmount: 37141.89, erpSalesTotal: 49353, taskId: "rec-a", issues: ["单张差额较大"] },
      { id: "doc-b", status: "NEEDS_REVIEW", shopNo: "WHMB03", period: "2026-05", version: 1, confirmedSettlementAmount: 87001.25, erpSalesTotal: 49353, taskId: "rec-b", issues: ["单张差额较大"] },
    ],
    groups: [],
    status: "PROCESSING",
  };

  rebuildBatchGroups(state);
  const note = unresolvedSplitGroupScopeReviewNote(state.groups[0]);

  assert.match(note, /同批同店同账期拆单未能与 ERP 同范围对齐/);
  assert.match(note, /2 份结算单合计 124143\.14 元/);
  assert.match(note, /组级差额 -74790\.14 元/);
  assert.match(note, /单张 full-shop 差额.*不作为可结算差额/);
});

test("batch export uses group differences for unresolved split documents", () => {
  const state = {
    id: "batch-1",
    documents: [
      { id: "doc-a", status: "NEEDS_REVIEW", shopNo: "WHMB03", period: "2026-05", version: 1, confirmedSettlementAmount: 37141.89, erpSalesTotal: 49353, taskId: "rec-a", groupId: null, fileName: "a.pdf", sourceFileName: null, issues: ["单张差额较大"] },
      { id: "doc-b", status: "NEEDS_REVIEW", shopNo: "WHMB03", period: "2026-05", version: 1, confirmedSettlementAmount: 87001.25, erpSalesTotal: 49353, taskId: "rec-b", groupId: null, fileName: "b.pdf", sourceFileName: null, issues: ["单张差额较大"] },
    ],
    groups: [],
    status: "PROCESSING",
  };

  const csv = buildBatchExportCsv(state);

  assert.match(csv, /-74790\.14/);
  assert.doesNotMatch(csv, /12211\.11/);
  assert.doesNotMatch(csv, /-37648\.25/);
});

test("does not auto-resolve split documents when ERP amounts are inconsistent", () => {
  const state = {
    id: "batch-1",
    documents: [
      { id: "doc-a", status: "NEEDS_REVIEW", shopNo: "WHAD28", period: "2026-05", version: 1, confirmedSettlementAmount: 60, erpSalesTotal: 100, taskId: "rec-a", issues: ["单张差额较大"] },
      { id: "doc-b", status: "NEEDS_REVIEW", shopNo: "WHAD28", period: "2026-05", version: 1, confirmedSettlementAmount: 40, erpSalesTotal: 90, taskId: "rec-b", issues: ["单张差额较大"] },
    ],
    groups: [],
    status: "PROCESSING",
  };

  rebuildBatchGroups(state);

  assert.equal(state.status, "NEEDS_REVIEW");
  assert.equal(state.groups[0].status, "NEEDS_REVIEW");
  assert.equal(state.groups[0].erpSalesTotal, null);
  assert.deepEqual(state.documents.map((document) => document.status), ["NEEDS_REVIEW", "NEEDS_REVIEW"]);
});

test("settled batch documents show task review reasons instead of precheck hints", () => {
  const issues = settledDocumentIssues(
    ["执行时将按单文件流程交给 CherryStudio Agent 抽取结算金额", "人工保留说明"],
    "NEEDS_REVIEW",
    [{ title: "总差额", message: "所选口径差额超过阈值", differenceAmount: 301, suggestion: null }],
  );

  assert.deepEqual(issues, ["总差额（差额 301.00）：所选口径差额超过阈值"]);
  assert.deepEqual(settledDocumentIssues(["执行时将按单文件流程交给 CherryStudio Agent 抽取结算金额"], "SUCCEEDED"), []);
});

test("batch upload validation rejects decoded and mojibake detail files", () => {
  const mojibake = Buffer.from("SZSC19-5月明细.pdf.xls", "utf8").toString("latin1");

  assert.equal(validateBatchSettlementUpload("SZSC19-5月明细.pdf.xls")?.code, "NOT_SETTLEMENT_FILE");
  assert.equal(validateBatchSettlementUpload(mojibake)?.code, "NOT_SETTLEMENT_FILE");
});

test("batch upload validation keeps multi-code settlement files for Agent identity review", () => {
  assert.equal(validateBatchSettlementUpload("NJAD01(NJTM01)结算单-202605.pdf"), null);
  assert.equal(validateBatchSettlementUpload("SHAD74&SHNK77结算单-202605.xlsx")?.code, "NOT_SETTLEMENT_FILE");
});
