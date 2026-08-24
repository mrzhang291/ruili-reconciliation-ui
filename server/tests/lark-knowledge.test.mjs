import assert from "node:assert/strict";
import test from "node:test";
import { buildKnowledgeInstructions, parseKnowledgeRows } from "../dist/lib/lark-knowledge.js";

test("keeps only effective enabled rules and builds a versioned snapshot", () => {
  const rows = [
    ["RULE-2", "商城规则", ["金额口径"], "仅商城 A 使用", "商城 A, 商城 B", 120, "v2", ["启用"], "2026-08-20T00:00:00+08:00", "2026-08-21T10:00:00+08:00"],
    ["RULE-1", "通用规则", ["金额口径"], "ERP 减结算", null, 100, "v1", ["启用"], "2026-08-20T00:00:00+08:00", "2026-08-21T09:00:00+08:00"],
    ["RULE-3", "草稿", ["异常处理"], "不能加载", null, 999, "v1", ["草稿"], null, null],
    ["RULE-4", "未来规则", ["异常处理"], "尚未生效", null, 999, "v1", ["启用"], "2026-08-22T00:00:00+08:00", null],
  ];
  const rules = parseKnowledgeRows(rows, new Date("2026-08-21T12:00:00+08:00"));

  assert.deepEqual(rules.map((rule) => rule.id), ["RULE-2", "RULE-1"]);
  const instructions = buildKnowledgeInstructions(rules, "商城 A");
  assert.match(instructions, /RULE-2\/v2/);
  assert.match(instructions, /RULE-1\/v1/);
  assert.match(instructions, /仅商城 A 使用/);
  assert.doesNotMatch(instructions, /不能加载|尚未生效/);
});
