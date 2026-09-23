import assert from "node:assert/strict";
import test from "node:test";
import { asAttachment, findCreatedRecordId, findSupersededTaskRecords, formulaChecksReady, isLarkRecordId, recordIdBatches, resolveTaskCompletionStatus, rowsFromPage, systemMatchEvidenceFields, uniqueActionableIssues } from "../dist/lib/lark-store.js";
import { buildReviewExportCsv, exportFilterRegion, REVIEW_EXPORT_OTHER_REGION, reviewBusinessConclusion, toDetail, toReviewListRow } from "../dist/routes/tasks.js";

test("reads the record ID returned by lark-cli record-upsert", () => {
  assert.equal(findCreatedRecordId({ data: { record: { record_id_list: ["recvsUgd2jAPoR"] } } }), "recvsUgd2jAPoR");
});

test("ignores tombstone rows returned for deleted Feishu records", () => {
  assert.deepEqual(rowsFromPage({ data: {
    data: [[null]], fields: ["任务ID"], record_id_list: ["rec_deleted"], record_not_found: ["rec_deleted"],
  } }), []);
});

test("summarizes multi-file settlement attachments without hiding the extra files", () => {
  assert.deepEqual(asAttachment([
    { file_token: "file-1", name: "WHAD30 -5月结算单1.pdf", size: 53049 },
    { file_token: "file-2", name: "WHAD30 -5月结算单2.pdf", size: 52238 },
  ]), {
    file_token: "file-1",
    name: "WHAD30 -5月结算单1.pdf 等 2 份",
    size: 105287,
    names: ["WHAD30 -5月结算单1.pdf", "WHAD30 -5月结算单2.pdf"],
  });
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

test("splits record-get selections at Feishu's 200-record limit", () => {
  const ids = Array.from({ length: 201 }, (_, index) => `rec${index}`);
  const batches = recordIdBatches([...ids, ids[0], "not-a-real-task"]);
  assert.deepEqual(batches.map((batch) => batch.length), [200, 1]);
  assert.equal(new Set(batches.flat()).size, 201);
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

test("shows linked task amounts on review rows", () => {
  const task = {
    id: "rec-task",
    taskId: "TASK-202609080720",
    name: "NJSC19 2026-05",
    shopNo: "NJSC19",
    period: "2026-05",
    status: "NEEDS_REVIEW",
    batchId: null,
    ruleVersions: null,
    settlementAmount: 196062,
    erpAmount: 196062,
    differenceAmount: 0,
    agentDifference: 0,
    differenceCheck: "通过",
    reasonablenessCheck: "通过",
    failureReason: null,
    cancelReason: null,
    rawAgentJson: null,
    startedAt: null,
    completedAt: null,
    createdAt: "2026-09-08T07:00:00.000Z",
    createdBy: { id: "u", name: "u" },
    settlementFile: null,
    erpFile: null,
    reviewIds: ["rec-review"],
  };
  const review = {
    id: "rec-review",
    title: "金额待核对",
    taskRecordId: "rec-task",
    taskId: task.taskId,
    shopNo: task.shopNo,
    differenceAmount: 0,
    message: "金额已对平，但范围待确认。",
    suggestion: "请确认范围。",
    status: "PENDING",
    note: null,
    resolvedAt: null,
    createdAt: null,
  };

  const row = toReviewListRow(review, task);
  assert.equal(row.item.settlementValue, "196062");
  assert.equal(row.item.erpValue, "196062");
  assert.equal(row.item.differenceAmount, "0");
  assert.equal(row.task.name, "NJSC19");
  assert.equal(row.task.periodLabel, "2026-05");

  const detail = toDetail(task, [review]);
  assert.equal(detail.reviewItems[0].settlementValue, "196062");
  assert.equal(detail.reviewItems[0].erpValue, "196062");
  assert.equal(detail.reviewItems[0].differenceAmount, "0");
});

test("uses the parent task's comparable difference consistently on review rows", () => {
  const task = {
    id: "rec-task",
    taskId: "TASK-COMPARABLE-DIFFERENCE",
    name: "NJSC19 2026-05",
    shopNo: "NJSC19",
    period: "2026-05",
    status: "NEEDS_REVIEW",
    batchId: null,
    ruleVersions: null,
    settlementAmount: 100000,
    erpAmount: 101000,
    differenceAmount: 1000,
    agentDifference: 1000,
    differenceCheck: "通过",
    reasonablenessCheck: "不通过",
    failureReason: null,
    cancelReason: null,
    rawAgentJson: null,
    startedAt: null,
    completedAt: null,
    createdAt: "2026-09-08T07:00:00.000Z",
    createdBy: { id: "u", name: "u" },
    settlementFile: null,
    erpFile: null,
    reviewIds: ["rec-review"],
  };
  const review = {
    id: "rec-review",
    title: "金额待核对",
    taskRecordId: task.id,
    taskId: task.taskId,
    shopNo: task.shopNo,
    differenceAmount: 25,
    message: "结算单扣点：10%；ERP扣点：10%。扣点档一致。",
    suggestion: "请确认范围。",
    status: "PENDING",
    note: null,
    resolvedAt: null,
    createdAt: null,
  };

  assert.equal(toReviewListRow(review, task).item.differenceAmount, "1000");
  assert.equal(toDetail(task, [review]).reviewItems[0].differenceAmount, "1000");
});

test("exports review rows as traceable CSV", () => {
  const task = {
    id: "rec-task",
    taskId: "TASK-202609080720",
    name: "NJSC19 2026-05",
    shopNo: "NJSC19",
    period: "2026-05",
    status: "NEEDS_REVIEW",
    batchId: "batch-1",
    ruleVersions: null,
    settlementAmount: 196062,
    erpAmount: 196362,
    differenceAmount: 300,
    agentDifference: 300,
    differenceCheck: "通过",
    reasonablenessCheck: "不通过",
    failureReason: null,
    cancelReason: null,
    rawAgentJson: null,
    startedAt: null,
    completedAt: null,
    createdAt: "2026-09-08T07:00:00.000Z",
    createdBy: { id: "u", name: "u" },
    settlementFile: null,
    erpFile: null,
    reviewIds: ["rec-review"],
  };
  const review = {
    id: "rec-review",
    title: "金额待核对",
    taskRecordId: "rec-task",
    taskId: task.taskId,
    shopNo: task.shopNo,
    differenceAmount: 300,
    message: "结算单扣点：10%；ERP扣点：10%。扣点档一致；金额差 300.00 元。",
    suggestion: "请确认销售差异原因。",
    status: "PENDING",
    note: null,
    resolvedAt: null,
    createdAt: null,
  };
  const csv = buildReviewExportCsv([review], new Map([[task.id, task]]), "batch-1");
  assert.match(csv, /"店铺号","账期","字段","业务结论"/);
  assert.match(csv, /"NJSC19","2026-05","金额待核对","销售额差异待核实","196062\.00","196362\.00","300\.00"/);
  assert.match(csv, /"待确认","TASK-202609080720","rec-review"/);
  assert.equal(buildReviewExportCsv([review], new Map([[task.id, task]]), "other-batch").split("\r\n").length, 1);
  assert.equal(buildReviewExportCsv([review], new Map([[task.id, task]]), "batch-1", { region: "NJ", differenceMin: 300, differenceMax: 300 }).split("\r\n").length, 2);
  assert.equal(buildReviewExportCsv([review], new Map([[task.id, task]]), "batch-1", { region: "HZ" }).split("\r\n").length, 1);
  assert.equal(buildReviewExportCsv([review], new Map([[task.id, task]]), "batch-1", { status: "PENDING" }).split("\r\n").length, 2);
  assert.equal(buildReviewExportCsv([review], new Map([[task.id, task]]), "batch-1", { status: "IGNORED" }).split("\r\n").length, 1);
  assert.equal(buildReviewExportCsv([review], new Map([[task.id, task]]), "batch-1", { differenceMax: 299 }).split("\r\n").length, 1);
});

test("exports unclassified shop numbers with the stable OTHER region sentinel", () => {
  const baseTask = {
    id: "rec-task-region",
    taskId: "TASK-REGION",
    name: "待补充店铺 2026-05",
    shopNo: null,
    period: "2026-05",
    status: "NEEDS_REVIEW",
    batchId: "batch-region",
    ruleVersions: null,
    settlementAmount: 100,
    erpAmount: 90,
    differenceAmount: -10,
    agentDifference: -10,
    differenceCheck: "通过",
    reasonablenessCheck: "不通过",
    failureReason: null,
    cancelReason: null,
    rawAgentJson: null,
    startedAt: null,
    completedAt: null,
    createdAt: "2026-09-22T00:00:00.000Z",
    createdBy: { id: "u", name: "u" },
    settlementFile: null,
    erpFile: null,
    reviewIds: ["rec-review-missing"],
  };
  const malformedShopTask = {
    ...baseTask,
    id: "rec-task-malformed-region",
    taskId: "TASK-MALFORMED-REGION",
    shopNo: "9号柜",
    reviewIds: ["rec-review-malformed"],
  };
  const missingShopReview = {
    id: "rec-review-missing",
    title: "金额待核对",
    taskRecordId: baseTask.id,
    taskId: baseTask.taskId,
    shopNo: null,
    differenceAmount: -10,
    message: "结算单扣点：10%；ERP扣点：10%。扣点档一致。",
    suggestion: "请确认销售差异原因。",
    status: "PENDING",
    note: null,
    resolvedAt: null,
    createdAt: null,
  };
  const malformedShopReview = {
    ...missingShopReview,
    id: "rec-review-malformed",
    taskRecordId: malformedShopTask.id,
    taskId: malformedShopTask.taskId,
    shopNo: malformedShopTask.shopNo,
  };

  assert.equal(exportFilterRegion("other"), REVIEW_EXPORT_OTHER_REGION);
  assert.equal(exportFilterRegion("NJ"), "NJ");
  assert.equal(exportFilterRegion("其他"), null);
  assert.equal(
    buildReviewExportCsv(
      [missingShopReview, malformedShopReview],
      new Map([[baseTask.id, baseTask], [malformedShopTask.id, malformedShopTask]]),
      "batch-region",
      { region: REVIEW_EXPORT_OTHER_REGION },
    ).split("\r\n").length,
    3,
  );
});

test("labels old rate-mismatch rows as rate mismatches instead of confirmed sales gaps", () => {
  const item = {
    title: "扣点待核对",
    message: "结算单扣点：5%；ERP扣点：20%。ERP多出20%档，ERP缺少5%档。",
    suggestion: "请核对扣点差异档对应的合同、柜组或活动。",
  };
  assert.equal(reviewBusinessConclusion(item, -272080), "扣点不一致");
  assert.equal(reviewBusinessConclusion({ ...item, message: "结算单扣点：21%；ERP扣点：0%。ERP扣点为0%，结算单扣点为21%。" }, 2224), "扣点不一致");
  assert.equal(reviewBusinessConclusion({ ...item, title: "金额待核对", message: "结算单扣点：10%；ERP扣点：10%。扣点档一致。" }, -1448), "销售额差异待核实");
  assert.equal(reviewBusinessConclusion({ ...item, title: "销售额已对平", message: "结算单扣点：12.5%＋其他扣率金额（未提供档位）；ERP扣点：12.5%。" }, -11.25), "扣点信息待确认");
});

test("keeps a missing ERP amount blank instead of displaying a synthetic difference", () => {
  const task = {
    id: "rec-task",
    taskId: "TASK-ERP-MISSING",
    name: "SHAA01 2026-05",
    shopNo: "SHAA01",
    period: "2026-05",
    status: "NEEDS_REVIEW",
    batchId: "batch-erp-missing",
    ruleVersions: null,
    settlementAmount: 101234.56,
    erpAmount: null,
    differenceAmount: -101234.56,
    agentDifference: null,
    differenceCheck: "待校验",
    reasonablenessCheck: "待校验",
    failureReason: null,
    cancelReason: null,
    rawAgentJson: JSON.stringify({
      salesTotal: null,
      netSalesTotal: null,
      erpAmount: null,
      difference: null,
      missingErp: true,
      basisReason: "ERP/DRP 未找到记录。",
      issues: "ERP/DRP 未找到记录。",
    }),
    startedAt: null,
    completedAt: null,
    createdAt: "2026-09-18T10:00:00.000Z",
    createdBy: { id: "u", name: "u" },
    settlementFile: null,
    erpFile: null,
    reviewIds: ["rec-review"],
  };
  const review = {
    id: "rec-review",
    title: "ERP金额待核对",
    taskRecordId: task.id,
    taskId: task.taskId,
    shopNo: task.shopNo,
    differenceAmount: -101234.56,
    message: "ERP/DRP 未找到记录。",
    suggestion: "请补充 ERP 明细。",
    status: "PENDING",
    note: null,
    resolvedAt: null,
    createdAt: null,
  };

  const detail = toDetail(task, [review]);
  assert.equal(detail.metrics.differenceAmount, null);
  assert.equal(detail.reviewItems[0].differenceAmount, null);
  assert.equal(toReviewListRow(review, task).item.differenceAmount, null);

  const csv = buildReviewExportCsv([review], new Map([[task.id, task]]), task.batchId);
  assert.match(csv, /"SHAA01","2026-05","ERP金额待核对","ERP金额待核对","101234\.56","",""/);
  assert.equal(buildReviewExportCsv([review], new Map([[task.id, task]]), task.batchId, { differenceMin: 0 }).split("\r\n").length, 1);
});

test("keeps a legacy row without an ERP amount blank even when its raw payload is absent", () => {
  const task = {
    id: "rec-task",
    taskId: "TASK-ERP-MISSING-LEGACY",
    name: "SHAA01 2026-05",
    shopNo: "SHAA01",
    period: "2026-05",
    status: "NEEDS_REVIEW",
    batchId: null,
    ruleVersions: null,
    settlementAmount: 101234.56,
    erpAmount: null,
    differenceAmount: -101234.56,
    agentDifference: null,
    differenceCheck: "待校验",
    reasonablenessCheck: "待校验",
    failureReason: null,
    cancelReason: null,
    rawAgentJson: null,
    startedAt: null,
    completedAt: null,
    createdAt: "2026-09-18T10:00:00.000Z",
    createdBy: { id: "u", name: "u" },
    settlementFile: null,
    erpFile: null,
    reviewIds: ["rec-review"],
  };
  const review = {
    id: "rec-review",
    title: "金额待核对",
    taskRecordId: task.id,
    taskId: task.taskId,
    shopNo: task.shopNo,
    differenceAmount: -101234.56,
    message: "ERP 金额待补充。",
    suggestion: "请补充 ERP 明细。",
    status: "PENDING",
    note: null,
    resolvedAt: null,
    createdAt: null,
  };

  assert.equal(toReviewListRow(review, task).item.differenceAmount, null);
  assert.equal(toDetail(task, [review]).reviewItems[0].differenceAmount, null);
});

test("records split-group evidence without auto-confirming a pending item", () => {
  const fields = systemMatchEvidenceFields(
    { message: "单张金额待核对。", suggestion: "请补充销售明细。" },
    { erpAmount: 1000, differenceAmount: 0, rawAgentJson: null },
    "同批同店同账期拆单合计已匹配。",
  );

  assert.deepEqual(fields, {
    差异金额: 0,
    差异描述: "单张金额待核对。 同批同店同账期拆单合计已匹配。",
    处理建议: "请补充销售明细。 系统已记录同批合计匹配证据；该结果仅作为核实依据，仍需收到确认后才能结案。",
  });
  assert.equal(Object.hasOwn(fields, "审核结果"), false);
  assert.equal(Object.hasOwn(fields, "审核时间"), false);
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

test("combined settlement attachments supersede their older split-file tasks", () => {
  const baseTask = {
    id: "current",
    taskId: "TASK-CURRENT",
    name: null,
    shopNo: "WHAD30",
    period: "2026-05",
    status: "SUCCEEDED",
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
    erpFile: null,
    reviewIds: [],
  };
  const current = {
    ...baseTask,
    settlementFile: {
      name: "WHAD30 -5月结算单1.pdf 等 2 份",
      names: ["WHAD30 -5月结算单1.pdf", "WHAD30 -5月结算单2.pdf"],
    },
  };
  const old = (name) => ({
    ...baseTask,
    id: name,
    status: "NEEDS_REVIEW",
    createdAt: "2026-08-31T03:00:00.000Z",
    settlementFile: { name },
  });

  const matches = findSupersededTaskRecords(current, [
    old("WHAD30 -5月结算单1.pdf"),
    old("WHAD30 -5月结算单2.pdf"),
    old("WHAD28-5月结算单1.pdf"),
  ]);

  assert.deepEqual(matches.map((item) => item.id), ["WHAD30 -5月结算单1.pdf", "WHAD30 -5月结算单2.pdf"]);
});
