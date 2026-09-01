import path from "node:path";
import { extractShopCodesFromFileName } from "./erp-base-query.js";

const rejectedNamePatterns: Array<[RegExp, string]> = [
  [/^thumbs\.db$/i, "系统缩略图文件不是结算单"],
  [/库存.*盘点|盘点表/, "盘点表不是结算单"],
  [/供应商对账统计|对账统计表/, "供应商统计表不是结算单"],
  [/业绩确认/, "业绩确认表不是结算单"],
  [/扣款明细/, "扣款明细请作为人工附件处理，不作为结算单上传"],
  [/明细/, "明细文件请作为人工附件处理，不作为结算单上传"],
  [/费用清单/, "费用清单请作为人工附件处理，不作为结算单上传"],
  [/租赁/, "租赁资料请作为人工附件处理，不作为结算单上传"],
];
const explicitMultiShopDelimiterPattern = /[&＆、,，+＋]/;

function normalizeIncomingFileName(fileName: string) {
  const decoded = /[\u0080-\u00ff]/.test(fileName)
    ? Buffer.from(fileName, "latin1").toString("utf8")
    : fileName;
  return (decoded.includes("�") ? fileName : decoded).normalize("NFKC");
}

export function settlementFileRejectionReason(fileName: string) {
  const baseName = path.basename(normalizeIncomingFileName(fileName));
  const hardRejectedReason = settlementFileHardRejectionReason(fileName);
  if (hardRejectedReason) return hardRejectedReason;

  return null;
}

export function settlementFileHardRejectionReason(fileName: string) {
  const baseName = path.basename(normalizeIncomingFileName(fileName));
  const matchedRule = rejectedNamePatterns.find(([pattern]) => pattern.test(baseName));
  if (matchedRule) return matchedRule[1];

  const shopCodes = extractShopCodesFromFileName(baseName);
  if (shopCodes.length > 1 && explicitMultiShopDelimiterPattern.test(baseName)) {
    return `文件名包含多个店铺号（${shopCodes.join("、")}），请拆成单店铺结算单后再上传`;
  }

  return null;
}
