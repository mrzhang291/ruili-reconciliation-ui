import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewWorklist, classifyReviewEvidence } from "../dist/lib/reconciliation-review.js";

function task(overrides = {}) {
  return {
    id: "rec-task",
    taskId: "TASK-1",
    name: "HZSC01 2026-05",
    shopNo: "HZSC01",
    period: "2026-05",
    status: "NEEDS_REVIEW",
    batchId: null,
    ruleVersions: null,
    settlementAmount: 100000,
    erpAmount: 102400,
    differenceAmount: 2400,
    agentDifference: 2400,
    differenceCheck: "通过",
    reasonablenessCheck: "不通过",
    failureReason: null,
    cancelReason: null,
    rawAgentJson: JSON.stringify({
      settlementAmountLabel: "本月销售额",
      erpBasis: "sales_total",
      appliedErpBasis: "sales_total",
      basisReason: "扣点对比：结算单 10%；ERP 10%；扣点一致。",
      issues: "结算单扣点：10%；ERP扣点：10%。扣点档一致；金额差：ERP 102400 − 结算单 100000 = 2400 元。",
    }),
    startedAt: null,
    completedAt: null,
    createdAt: "2026-09-08T07:00:00.000Z",
    createdBy: { id: "u", name: "u" },
    settlementFile: { name: "HZSC01-5月结算单.pdf" },
    erpFile: null,
    reviewIds: [],
    ...overrides,
  };
}

function item(parentTask, overrides = {}) {
  return {
    id: "rec-review",
    title: "金额待核对",
    taskRecordId: parentTask.id,
    taskId: parentTask.taskId,
    shopNo: parentTask.shopNo,
    differenceAmount: parentTask.differenceAmount,
    message: "结算单扣点：10%；ERP扣点：10%。扣点档一致；金额差 2400 元。",
    suggestion: "请确认销售额差异原因。",
    status: "PENDING",
    note: null,
    resolvedAt: null,
    createdAt: "2026-09-08T07:00:00.000Z",
    ...overrides,
  };
}

test("turns a rate-aligned amount gap into a traceable confirmation card", () => {
  const parentTask = task();
  const review = item(parentTask);
  const [worklistItem] = buildReviewWorklist([{ item: review, task: parentTask }], new Date("2026-09-22T00:00:00.000Z"));

  assert.equal(worklistItem.card.classification.code, "RATE_MATCHED_AMOUNT_MISMATCH");
  assert.equal(worklistItem.card.classification.label, "扣点一致，金额待核实");
  assert.equal(worklistItem.card.priority.level, "MEDIUM");
  assert.match(worklistItem.card.evidence.formula, /ERP 金额 102,400\.00 − 结算单金额 100,000\.00 = 2,400\.00 元/);
  assert.deepEqual(worklistItem.card.confirmation.requiredFields, ["销售额明细", "退货/冲回明细", "活动或调整说明"]);
  assert.match(worklistItem.card.confirmation.communicationTemplate, /收到后将按同一口径继续核实/);
  assert.equal(worklistItem.card.candidateRule, null);
  assert.equal(review.status, "PENDING");
});

test("puts ERP gaps ahead of ordinary amount gaps without creating a business conclusion", () => {
  const amountTask = task();
  const missingTask = task({
    id: "rec-missing",
    taskId: "TASK-MISSING",
    shopNo: "HZSC02",
    erpAmount: null,
    differenceAmount: null,
    rawAgentJson: JSON.stringify({
      settlementAmountLabel: "本月销售额",
      erpBasis: "ambiguous",
      basisReason: "ERP/DRP 未找到记录。",
      issues: "ERP/DRP 未找到记录。",
      missingErp: true,
    }),
  });
  const list = buildReviewWorklist([
    { item: item(amountTask), task: amountTask },
    { item: item(missingTask, { id: "rec-missing-review", taskRecordId: missingTask.id, taskId: missingTask.taskId, shopNo: missingTask.shopNo, differenceAmount: null, title: "ERP金额待核对", message: "ERP/DRP 未找到记录。" }), task: missingTask },
  ], new Date("2026-09-22T00:00:00.000Z"));

  assert.equal(list[0].card.classification.code, "ERP_MISSING");
  assert.equal(list[0].card.priority.level, "HIGH");
  assert.match(list[0].card.evidence.formula, /暂不计算业务差额/);
  assert.match(list[0].card.confirmation.question, /店铺号、账期映射/);
});

test("marks repeated historical patterns as candidates only after an item has been confirmed", () => {
  const firstTask = task({ id: "rec-first", taskId: "TASK-FIRST", period: "2026-04" });
  const secondTask = task({ id: "rec-second", taskId: "TASK-SECOND", period: "2026-05" });
  const firstReview = item(firstTask, { id: "rec-first-review", status: "APPROVED" });
  const secondReview = item(secondTask, { id: "rec-second-review", status: "PENDING" });
  const list = buildReviewWorklist([
    { item: firstReview, task: firstTask },
    { item: secondReview, task: secondTask },
  ], new Date("2026-09-22T00:00:00.000Z"));

  for (const result of list) {
    assert.equal(result.card.candidateRule?.occurrences, 2);
    assert.equal(result.card.candidateRule?.confirmedOccurrences, 1);
    assert.match(result.card.candidateRule?.description ?? "", /候选规则/);
    assert.match(result.card.candidateRule?.description ?? "", /已确认/);
    assert.match(result.card.candidateRule?.description ?? "", /不能自动结案/);
  }
  assert.equal(secondReview.status, "PENDING");
});

test("does not promote deferred items into candidate rules", () => {
  const firstTask = task({ id: "rec-deferred-first", taskId: "TASK-DEFERRED-FIRST", period: "2026-04" });
  const secondTask = task({ id: "rec-deferred-second", taskId: "TASK-DEFERRED-SECOND", period: "2026-05" });
  const list = buildReviewWorklist([
    { item: item(firstTask, { id: "rec-deferred-first-review", status: "IGNORED" }), task: firstTask },
    { item: item(secondTask, { id: "rec-deferred-second-review", status: "PENDING" }), task: secondTask },
  ], new Date("2026-09-22T00:00:00.000Z"));

  for (const result of list) assert.equal(result.card.candidateRule, null);
});

test("uses no synthetic difference or amount category when an old task has no ERP amount", () => {
  const missingTask = task({
    id: "rec-legacy-missing",
    taskId: "TASK-LEGACY-MISSING",
    shopNo: "HZSC03",
    erpAmount: null,
    differenceAmount: -100000,
    rawAgentJson: null,
  });
  const [result] = buildReviewWorklist([{
    item: item(missingTask, {
      id: "rec-legacy-missing-review",
      taskRecordId: missingTask.id,
      taskId: missingTask.taskId,
      shopNo: missingTask.shopNo,
      differenceAmount: -100000,
      message: "结算单扣点：10%；ERP扣点：10%。扣点档一致。",
    }),
    task: missingTask,
  }], new Date("2026-09-22T00:00:00.000Z"));

  assert.equal(result.card.classification.code, "ERP_MISSING");
  assert.match(result.card.evidence.formula, /暂不计算业务差额/);
  assert.doesNotMatch(result.card.priority.reason, /差额/);
});

test("detects cross-month adjustments as a separate confirmation category", () => {
  const parentTask = task({ rawAgentJson: JSON.stringify({
    settlementAmountLabel: "本月销售额",
    erpBasis: "sales_total",
    basisReason: "扣点对比：结算单 10%；ERP 10%；扣点一致。补入 4 月销售额。",
    issues: "存在跨月调整，需按日销售、退货和调整台账核验。",
  }) });
  const classification = classifyReviewEvidence({ ...item(parentTask), task: parentTask });
  assert.equal(classification.code, "CROSS_MONTH_ADJUSTMENT");
  assert.equal(classification.label, "跨月调整待核实");
});
