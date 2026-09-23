import { comparableDifferenceAmount, type StoredReviewItem, type StoredTask } from "./lark-store.js";

const scopedMismatchPattern = /聚合范围与结算单范围不一致|销售范围待确认|结算期间待确认|不能将ERP店铺聚合金额直接视为普通差额|ERP全店汇总|结算单与ERP(?:销售)?(?:范围|数据口径).*明显不一致|(?:账期|期间|月份).*?(?:不一致|冲突)|(?:文件名主体|正文主体|结算主体|主体名称).*?(?:不一致|冲突)|(?:字段)?口径.*?(?:不一致|冲突)|无法唯一确定对账口径|金额接近度与字段口径存在冲突|结算单扣率.*?ERP.*?扣率|ERP.*?扣率.*?结算单扣率|ERP.*(?:聚合|汇总|店铺号|店铺|同店|同一店铺|多条|多档|不同扣率).*?(?:范围|不可比|无法确认|无法对应|不能直接|明细范围|合同|专柜|铺位|活动|特卖|本结算单|单一|部分|仅覆盖|未覆盖|口径)|(?:单一合同|单一专柜|单一结算部门|单一客户合同|仅覆盖|仅列示|仅显示).*?ERP/;

export function normalizedReviewText(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, "");
}

export function isScopedReconciliationIssue(value: string) {
  return scopedMismatchPattern.test(normalizedReviewText(value));
}

export function normalizedRateSet(value: string) {
  return [...new Set((value.match(/\d+(?:\.\d+)?%/g) ?? []).map((rate) => `${Number(rate.slice(0, -1))}%`))].sort();
}

export function hasRateMismatchEvidence(value: string) {
  const text = normalizedReviewText(value);
  if (/ERP(?:扣点)?(?:多出|缺少)|结算单(?:扣点)?(?:多出|缺少)|扣点(?:档|率).*(?:不一致|无法比较)/.test(text)) return true;
  const pair = text.match(/结算单扣点[:：]([^；。]+)[；;]ERP扣点[:：]([^。]+)/);
  if (!pair) return false;
  const settlement = normalizedRateSet(pair[1]);
  const erp = normalizedRateSet(pair[2]);
  return settlement.length > 0 && erp.length > 0 && settlement.join("|") !== erp.join("|");
}

export function hasCrossMonthSalesAdjustment(value: string) {
  const text = normalizedReviewText(value);
  return /跨月|跨期|补入\d{1,2}月|(?:在)?\d{1,2}月补入|(?:冲回|冲销).{0,8}月/.test(text);
}

export type ReviewWorklistCategoryCode =
  | "ERP_MISSING"
  | "RATE_INCOMPLETE"
  | "RATE_MISMATCH"
  | "SCOPE_MISMATCH"
  | "CROSS_MONTH_ADJUSTMENT"
  | "BASIS_AMBIGUOUS"
  | "RATE_MATCHED_AMOUNT_MISMATCH"
  | "AMOUNT_MISMATCH"
  | "FIELD_UNCLEAR";

export type ReviewWorklistPriorityLevel = "HIGH" | "MEDIUM" | "LOW";

export type ReviewWorklistClassification = {
  code: ReviewWorklistCategoryCode;
  label: string;
  detail: string;
  tags: string[];
};

export type ReviewWorklistPriority = {
  level: ReviewWorklistPriorityLevel;
  label: string;
  reason: string;
  score: number;
};

export type ReviewWorklistConfirmation = {
  question: string;
  requiredFields: string[];
  communicationTemplate: string;
};

export type ReviewWorklistEvidence = {
  formula: string;
  settlementBasis: string | null;
  erpBasisLabel: string | null;
  basisReason: string | null;
  settlementFileName: string | null;
};

export type ReviewWorklistCandidateRule = {
  label: string;
  occurrences: number;
  confirmedOccurrences: number;
  description: string;
};

export type ReviewWorklistCard = {
  classification: ReviewWorklistClassification;
  priority: ReviewWorklistPriority;
  confirmation: ReviewWorklistConfirmation;
  evidence: ReviewWorklistEvidence;
  candidateRule: ReviewWorklistCandidateRule | null;
};

type ReviewEvidenceInput = Pick<StoredReviewItem, "title" | "message" | "suggestion" | "differenceAmount"> & {
  shopNo?: string | null;
  task?: Pick<StoredTask, "shopNo" | "period" | "settlementAmount" | "erpAmount" | "differenceAmount" | "rawAgentJson" | "settlementFile" | "createdAt"> | null;
};

type ParsedAgentPayload = {
  settlementAmountLabel: string | null;
  erpBasis: string | null;
  appliedErpBasis: string | null;
  basisReason: string | null;
  issues: string | null;
  missingErp: boolean;
};

const missingErpPattern = /ERP金额待核对|ERP\/?DRP.{0,40}(?:未找到|缺失|无匹配|没有匹配|not\s*found)|(?:未找到|缺失|无匹配|没有匹配).{0,40}ERP\/?DRP/i;
const incompleteRatePattern = /其他(?:扣率|扣点|费率)(?:金额)?[^。；\n]{0,50}(?:未(?:提供|提取|标注|明确)|无(?:档位|分档))|扣点分档未完整提供|扣点无法比较|ERP缺少结算单其他(?:扣率|扣点|费率)档/;
const basisAmbiguousPattern = /金额口径待确认|(?:字段|金额)口径|扣点后金额|net_sales_total|无法(?:唯一)?确定对账口径|口径.*(?:待确认|不一致|冲突)/i;

function textValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseAgentPayload(rawAgentJson: string | null | undefined): ParsedAgentPayload {
  if (!rawAgentJson) {
    return { settlementAmountLabel: null, erpBasis: null, appliedErpBasis: null, basisReason: null, issues: null, missingErp: false };
  }
  try {
    const raw = JSON.parse(rawAgentJson) as Record<string, unknown>;
    return {
      settlementAmountLabel: textValue(raw.settlementAmountLabel),
      erpBasis: textValue(raw.erpBasis),
      appliedErpBasis: textValue(raw.appliedErpBasis),
      basisReason: textValue(raw.basisReason),
      issues: textValue(raw.issues),
      missingErp: raw.missingErp === true,
    };
  } catch {
    return { settlementAmountLabel: null, erpBasis: null, appliedErpBasis: null, basisReason: null, issues: null, missingErp: false };
  }
}

function combinedEvidence(item: ReviewEvidenceInput, payload: ParsedAgentPayload) {
  return [item.title, item.message, item.suggestion ?? "", payload.basisReason ?? "", payload.issues ?? ""].join("\n");
}

function rateEvidence(value: string) {
  const text = normalizedReviewText(value);
  const pair = text.match(/结算单扣点[:：]([^；。]+)[；;]ERP扣点[:：]([^。]+)/);
  const settlement = pair ? normalizedRateSet(pair[1]) : [];
  const erp = pair ? normalizedRateSet(pair[2]) : [];
  return {
    settlement,
    erp,
    hasComparablePair: settlement.length > 0 && erp.length > 0,
    multiRate: settlement.length > 1 || erp.length > 1,
  };
}

function comparableDifference(item: ReviewEvidenceInput) {
  if (item.task) return comparableDifferenceAmount(item.task);
  return typeof item.differenceAmount === "number" && Number.isFinite(item.differenceAmount) ? item.differenceAmount : null;
}

function amountText(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "待补充";
}

function erpBasisLabel(payload: ParsedAgentPayload) {
  const basis = payload.appliedErpBasis ?? payload.erpBasis;
  if (basis === "sales_total") return "扣点前销售额";
  if (basis === "net_sales_total") return "扣点后金额";
  if (basis === "ambiguous") return "ERP 口径待确认";
  return null;
}

function categoryDetails(code: ReviewWorklistCategoryCode) {
  const details: Record<ReviewWorklistCategoryCode, { label: string; detail: string }> = {
    ERP_MISSING: { label: "ERP 金额待核对", detail: "系统未找到可用 ERP/DRP 记录，暂不计算业务差额。" },
    RATE_INCOMPLETE: { label: "扣点信息待确认", detail: "存在未提供档位的扣点信息，不能按普通金额差异直接判断。" },
    RATE_MISMATCH: { label: "扣点不一致", detail: "结算单与 ERP 扣点档未对齐，金额仅用于定位。" },
    SCOPE_MISMATCH: { label: "销售范围待确认", detail: "结算单与 ERP 的销售范围可能不同，金额仅用于定位。" },
    CROSS_MONTH_ADJUSTMENT: { label: "跨月调整待核实", detail: "单据提示存在跨月补入、冲回或调整，需按明细核验。" },
    BASIS_AMBIGUOUS: { label: "金额口径待确认", detail: "结算单字段与 ERP 口径尚未完全对应。" },
    RATE_MATCHED_AMOUNT_MISMATCH: { label: "扣点一致，金额待核实", detail: "扣点档已对齐，需进一步核实销售额、退货或调整。" },
    AMOUNT_MISMATCH: { label: "销售额差异待核实", detail: "当前金额差异超过阈值，需核实业务明细。" },
    FIELD_UNCLEAR: { label: "原件字段待确认", detail: "原件字段或业务含义尚不完整，需补充可比口径。" },
  };
  return details[code];
}

export function classifyReviewEvidence(item: ReviewEvidenceInput): ReviewWorklistClassification {
  const payload = parseAgentPayload(item.task?.rawAgentJson);
  const evidence = combinedEvidence(item, payload);
  const text = normalizedReviewText(evidence);
  const rates = rateEvidence(evidence);
  const difference = comparableDifference(item);
  let code: ReviewWorklistCategoryCode;

  if ((item.task && (typeof item.task.erpAmount !== "number" || !Number.isFinite(item.task.erpAmount))) || payload.missingErp || missingErpPattern.test(text)) code = "ERP_MISSING";
  else if (incompleteRatePattern.test(text)) code = "RATE_INCOMPLETE";
  else if (hasRateMismatchEvidence(evidence)) code = "RATE_MISMATCH";
  else if (isScopedReconciliationIssue(evidence)) code = "SCOPE_MISMATCH";
  else if (hasCrossMonthSalesAdjustment(evidence)) code = "CROSS_MONTH_ADJUSTMENT";
  else if ((payload.erpBasis ?? payload.appliedErpBasis) === "ambiguous" || basisAmbiguousPattern.test(text)) code = "BASIS_AMBIGUOUS";
  else if (rates.hasComparablePair && typeof difference === "number" && Math.abs(difference) > 200) code = "RATE_MATCHED_AMOUNT_MISMATCH";
  else if (typeof difference === "number" && Math.abs(difference) > 200) code = "AMOUNT_MISMATCH";
  else code = "FIELD_UNCLEAR";

  const category = categoryDetails(code);
  const tags = [category.label];
  if (rates.multiRate) tags.push("多扣点档");
  if (typeof difference === "number" && Math.abs(difference) <= 200) tags.push("差额在 200 元内");
  return { code, ...category, tags };
}

function periodAgeMonths(period: string | null | undefined, now: Date) {
  const match = period?.match(/^(\d{4})-(\d{2})$/);
  if (!match) return 0;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || month < 1 || month > 12) return 0;
  const age = (now.getFullYear() - year) * 12 + (now.getMonth() + 1 - month);
  return Math.max(0, age);
}

function riskWeight(code: ReviewWorklistCategoryCode) {
  const weights: Record<ReviewWorklistCategoryCode, number> = {
    ERP_MISSING: 96,
    RATE_INCOMPLETE: 92,
    RATE_MISMATCH: 90,
    SCOPE_MISMATCH: 88,
    CROSS_MONTH_ADJUSTMENT: 82,
    BASIS_AMBIGUOUS: 76,
    RATE_MATCHED_AMOUNT_MISMATCH: 58,
    AMOUNT_MISMATCH: 52,
    FIELD_UNCLEAR: 42,
  };
  return weights[code];
}

export function priorityForReviewEvidence(
  item: ReviewEvidenceInput,
  classification = classifyReviewEvidence(item),
  now = new Date(),
): ReviewWorklistPriority {
  const difference = comparableDifference(item);
  const amountScore = typeof difference === "number" ? Math.min(20, Math.round(Math.abs(difference) / 5_000 * 20)) : 8;
  const age = periodAgeMonths(item.task?.period, now);
  const ageScore = Math.min(15, age);
  const score = riskWeight(classification.code) + amountScore + ageScore;
  const level: ReviewWorklistPriorityLevel = score >= 90 ? "HIGH" : score >= 65 ? "MEDIUM" : "LOW";
  const label = level === "HIGH" ? "优先核实" : level === "MEDIUM" ? "建议尽快核实" : "可排期核实";
  const reasons = [classification.label];
  if (typeof difference === "number") reasons.push(`差额 ${amountText(Math.abs(difference))} 元`);
  if (age > 0) reasons.push(`账期已过 ${age} 个月`);
  return { level, label, reason: reasons.join("；"), score };
}

function confirmationForCategory(item: ReviewEvidenceInput, classification: ReviewWorklistClassification, evidence: ReviewWorklistEvidence): ReviewWorklistConfirmation {
  const shop = item.task?.shopNo ?? item.shopNo ?? "该店铺";
  const period = item.task?.period ?? "该账期";
  const subject = `${shop} ${period}`.trim();
  const commonOpening = `您好，${subject} 的结算资料已完成系统预检。为便于继续核实，请协助确认以下信息：`;
  const byCategory: Record<ReviewWorklistCategoryCode, { question: string; requiredFields: string[]; request: string }> = {
    ERP_MISSING: {
      question: "请确认是否存在对应的 ERP/DRP 记录，以及店铺号、账期映射是否正确。",
      requiredFields: ["ERP/DRP 店铺号", "账期", "对应销售额或明细来源"],
      request: "1. 对应 ERP/DRP 店铺号；2. 对应账期；3. 可核对的销售额或明细来源。",
    },
    RATE_INCOMPLETE: {
      question: "请确认未标明档位的扣点对应哪份合同、专柜或活动范围。",
      requiredFields: ["完整扣点档", "合同/专柜/活动范围", "扣点计算依据"],
      request: "1. 完整扣点档；2. 各档对应的合同、专柜或活动范围；3. 扣点计算依据。",
    },
    RATE_MISMATCH: {
      question: "请确认结算单与 ERP 的扣点档是否对应同一合同、专柜或活动范围。",
      requiredFields: ["结算单扣点档", "ERP 扣点档", "合同/专柜/活动范围"],
      request: "1. 结算单与 ERP 各自适用的扣点档；2. 对应合同、专柜或活动范围。",
    },
    SCOPE_MISMATCH: {
      question: "请确认结算单与 ERP 是否覆盖同一销售范围。",
      requiredFields: ["合同/专柜/铺位", "活动范围", "可比销售明细"],
      request: "1. 合同、专柜或铺位；2. 活动范围；3. 同范围的销售明细。",
    },
    CROSS_MONTH_ADJUSTMENT: {
      question: "请确认本账期是否包含跨月补入、冲回或调整，并提供对应明细。",
      requiredFields: ["调整月份", "调整金额", "日销售/退货/调整台账"],
      request: "1. 调整对应月份；2. 调整金额；3. 日销售、退货或调整台账。",
    },
    BASIS_AMBIGUOUS: {
      question: "请确认结算单所选金额字段与 ERP 销售额的对应口径。",
      requiredFields: ["结算单金额字段含义", "ERP 口径", "可比依据"],
      request: "1. 结算单金额字段的业务含义；2. 对应 ERP 口径；3. 可比依据。",
    },
    RATE_MATCHED_AMOUNT_MISMATCH: {
      question: "在扣点档一致的前提下，请核实销售额、退货、跨月调整或活动明细。",
      requiredFields: ["销售额明细", "退货/冲回明细", "活动或调整说明"],
      request: "1. 同账期销售额明细；2. 退货、冲回或跨月调整明细；3. 活动说明（如有）。",
    },
    AMOUNT_MISMATCH: {
      question: "请核实结算单与 ERP 销售额差异的业务原因。",
      requiredFields: ["销售额明细", "退货/调整明细", "业务说明"],
      request: "1. 可比销售额明细；2. 退货或调整明细；3. 业务说明。",
    },
    FIELD_UNCLEAR: {
      question: "请确认结算单金额字段的业务含义及可比销售范围。",
      requiredFields: ["金额字段含义", "销售范围", "可比依据"],
      request: "1. 金额字段含义；2. 销售范围；3. 可比依据。",
    },
  };
  const request = byCategory[classification.code];
  const formulaLine = evidence.formula.includes("待补充") ? "当前 ERP 金额待补充，系统未作业务结论。" : `${evidence.formula}。`;
  return {
    question: request.question,
    requiredFields: request.requiredFields,
    communicationTemplate: `${commonOpening}\n${formulaLine}\n请提供：${request.request}\n收到后将按同一口径继续核实。`,
  };
}

function evidenceForReview(item: ReviewEvidenceInput): ReviewWorklistEvidence {
  const payload = parseAgentPayload(item.task?.rawAgentJson);
  const settlement = item.task?.settlementAmount;
  const erp = item.task?.erpAmount;
  const difference = comparableDifference(item);
  const formula = typeof settlement === "number" && typeof erp === "number" && typeof difference === "number"
    ? `计算差额：ERP 金额 ${amountText(erp)} − 结算单金额 ${amountText(settlement)} = ${amountText(difference)} 元`
    : `计算差额：ERP 金额待补充；结算单金额 ${amountText(settlement)}，暂不计算业务差额`;
  return {
    formula,
    settlementBasis: payload.settlementAmountLabel ?? item.title ?? null,
    erpBasisLabel: erpBasisLabel(payload),
    basisReason: payload.basisReason,
    settlementFileName: item.task?.settlementFile?.name ?? null,
  };
}

function candidateKey(item: ReviewEvidenceInput, classification: ReviewWorklistClassification, evidence: ReviewWorklistEvidence) {
  const payload = parseAgentPayload(item.task?.rawAgentJson);
  const shop = item.task?.shopNo ?? item.shopNo ?? "";
  const basis = evidence.settlementBasis ?? "";
  const erpBasis = payload.appliedErpBasis ?? payload.erpBasis ?? "";
  const rates = rateEvidence(combinedEvidence(item, payload));
  const rateSignature = `${rates.settlement.join(",") || "未提供"}→${rates.erp.join(",") || "未提供"}`;
  return [shop.trim().toUpperCase(), classification.code, normalizedReviewText(basis), erpBasis, rateSignature].join("|");
}

export function buildReviewWorklist(
  entries: Array<{ item: StoredReviewItem; task: StoredTask | null }>,
  now = new Date(),
): Array<{ item: StoredReviewItem; task: StoredTask | null; card: ReviewWorklistCard }> {
  const prepared = entries.map(({ item, task }) => {
    const input: ReviewEvidenceInput = { ...item, task };
    const classification = classifyReviewEvidence(input);
    const evidence = evidenceForReview(input);
    const priority = priorityForReviewEvidence(input, classification, now);
    const confirmation = confirmationForCategory(input, classification, evidence);
    return { item, task, input, classification, evidence, priority, confirmation, key: candidateKey(input, classification, evidence) };
  });

  const groups = new Map<string, typeof prepared>();
  for (const entry of prepared) {
    const current = groups.get(entry.key) ?? [];
    current.push(entry);
    groups.set(entry.key, current);
  }

  return prepared.map((entry) => {
    const repeated = groups.get(entry.key) ?? [];
    const confirmedOccurrences = repeated.filter(({ item }) => item.status === "APPROVED").length;
    const candidateRule = repeated.length >= 2 && confirmedOccurrences > 0
      ? {
          label: `${entry.evidence.settlementBasis ?? "结算单金额"} → ${entry.evidence.erpBasisLabel ?? "ERP 口径待确认"}`,
          occurrences: repeated.length,
          confirmedOccurrences,
          description: `近 ${repeated.length} 条同店同口径的${entry.classification.label}记录中，${confirmedOccurrences} 条已确认；该模式仅作为候选规则保留，不能自动结案。`,
        }
      : null;
    return {
      item: entry.item,
      task: entry.task,
      card: {
        classification: entry.classification,
        priority: entry.priority,
        confirmation: entry.confirmation,
        evidence: entry.evidence,
        candidateRule,
      },
    };
  }).sort((left, right) => {
    if (right.card.priority.score !== left.card.priority.score) return right.card.priority.score - left.card.priority.score;
    const rightDifference = Math.abs(comparableDifference({ ...right.item, task: right.task }) ?? 0);
    const leftDifference = Math.abs(comparableDifference({ ...left.item, task: left.task }) ?? 0);
    if (rightDifference !== leftDifference) return rightDifference - leftDifference;
    return String(left.task?.period ?? "").localeCompare(String(right.task?.period ?? ""));
  });
}
