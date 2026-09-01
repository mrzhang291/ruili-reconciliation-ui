import { config } from "./config.js";
import { LarkCliError, runLarkCli } from "./lark-cli.js";
const fields = ["规则ID", "规则标题", "规则分类", "规则内容", "适用店铺号", "优先级", "版本", "状态", "生效时间", "最后修改时间"] as const;

export type KnowledgeRule = {
  id: string;
  title: string;
  category: string;
  content: string;
  shopNos: string[];
  priority: number;
  version: string;
  effectiveAt: string | null;
  updatedAt: string | null;
};

export class LarkKnowledgeError extends Error {
  constructor(message: string, readonly code = "LARK_KNOWLEDGE_ERROR") {
    super(message);
    this.name = "LarkKnowledgeError";
  }
}

type RecordListEnvelope = {
  ok?: boolean;
  data?: {
    data?: unknown[][];
    has_more?: boolean;
  };
  error?: { message?: string };
};

function stringValue(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(String).join("、").trim();
  return "";
}

function includesOption(value: unknown, expected: string) {
  return Array.isArray(value) ? value.includes(expected) : value === expected;
}

function parseShopNos(value: unknown) {
  return stringValue(value).split(/[,，]/).map((item) => item.trim()).filter(Boolean);
}

export function parseKnowledgeRows(rows: unknown[][], now = new Date()): KnowledgeRule[] {
  return rows.flatMap((row) => {
    const [id, title, category, content, shopNos, priority, version, status, effectiveAt, updatedAt] = row;
    const body = stringValue(content);
    const effectiveDate = stringValue(effectiveAt);
    if (!body || !includesOption(status, "启用")) return [];
    if (effectiveDate && new Date(effectiveDate).getTime() > now.getTime()) return [];
    return [{
      id: stringValue(id),
      title: stringValue(title),
      category: stringValue(category),
      content: body,
      shopNos: parseShopNos(shopNos),
      priority: Number(priority) || 0,
      version: stringValue(version),
      effectiveAt: effectiveDate || null,
      updatedAt: stringValue(updatedAt) || null,
    }];
  }).sort((a, b) => b.priority - a.priority || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

export function buildKnowledgeInstructions(rules: KnowledgeRule[], shopNo?: string) {
  const normalizedShopNo = shopNo?.trim();
  const applicable = rules.filter((rule) => !rule.shopNos.length || !normalizedShopNo || rule.shopNos.includes(normalizedShopNo));
  if (!applicable.length) throw new LarkKnowledgeError("飞书知识规则表中没有当前可用的启用规则", "LARK_KNOWLEDGE_EMPTY");

  const lines = applicable.map((rule, index) => {
    const scope = rule.shopNos.length ? `仅适用于店铺号：${rule.shopNos.join("、")}` : "适用于全部店铺";
    return `${index + 1}. [${rule.id || "无ID"}/${rule.version || "无版本"}] ${rule.title || rule.category || "未命名规则"}（优先级 ${rule.priority}，${scope}）\n${rule.content}`;
  });

  return `你是锐力对账 Agent。以下内容是本次任务从飞书“知识规则表”读取的规则快照，已按优先级排序。只应用适用于当前店铺号的规则；业务口径冲突时前面的高优先级规则覆盖后面的规则。知识规则只约束字段识别、金额口径、异常和审核判断，不得覆盖后端和用户消息给出的最终 JSON 字段契约。\n\n${lines.join("\n\n")}\n\n最终结果的字段、格式和输出方式严格遵守用户消息中的要求；如知识规则与用户消息的输出字段数量或字段名冲突，以用户消息为准。`;
}

export async function loadKnowledgeRules(now = new Date()) {
  const rows: unknown[][] = [];
  const limit = 200;
  for (let offset = 0; ; offset += limit) {
    const args = [
      "base", "+record-list",
      "--base-token", config.lark.baseToken,
      "--table-id", config.lark.knowledgeTableId,
      "--as", "user",
      "--offset", String(offset),
      "--limit", String(limit),
      "--format", "json",
    ];
    for (const field of fields) args.push("--field-id", field);
    let payload: RecordListEnvelope;
    try {
      payload = await runLarkCli<RecordListEnvelope>(args);
    } catch (error) {
      const message = error instanceof LarkCliError ? error.message : String(error);
      throw new LarkKnowledgeError(`读取飞书知识规则失败：${message}`, "LARK_KNOWLEDGE_READ_FAILED");
    }
    const page = payload.data;
    rows.push(...(page?.data ?? []));
    if (!page?.has_more) break;
  }
  return parseKnowledgeRows(rows, now);
}

export async function loadKnowledgeInstructions(shopNo?: string) {
  const rules = await loadKnowledgeRules();
  return {
    instructions: buildKnowledgeInstructions(rules, shopNo),
    ruleVersions: rules.map((rule) => `${rule.id}@${rule.version}`),
  };
}
