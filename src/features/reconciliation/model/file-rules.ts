// 文件说明：定义对账资料的上传格式、大小限制和文件类型展示规则。
export const reconciliationAcceptedExtensions = [
  ".xlsx",
  ".xls",
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
] as const;

export const reconciliationAcceptedMimeTypes = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/pdf",
  "image/png",
  "image/jpeg",
] as const;

export const reconciliationFileAccept = [
  ...reconciliationAcceptedExtensions,
  ...reconciliationAcceptedMimeTypes,
].join(",");

export const reconciliationMaxFileSizeMb = 20;
export const reconciliationMaxFileSizeBytes = reconciliationMaxFileSizeMb * 1024 * 1024;
export const batchReconciliationMaxFiles = 30;
export const batchReconciliationMaxTotalSizeMb = 200;
export const batchReconciliationMaxTotalSizeBytes = batchReconciliationMaxTotalSizeMb * 1024 * 1024;
export const reconciliationFileHint = "支持 Excel、PDF、PNG/JPG，单个文件不超过 20 MB";
export const reconciliationReadableFileTypes = ".xlsx / .xls / .pdf / .png / .jpg / .jpeg";
export const erpFileAccept = ".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel";
export const erpFileHint = "支持 .xlsx / .xls，单个文件不超过 20 MB";

type UploadFileLike = Pick<File, "name" | "size" | "type">;

const acceptedExtensionSet = new Set<string>(reconciliationAcceptedExtensions);
const acceptedMimeTypeSet = new Set<string>(reconciliationAcceptedMimeTypes);
const extensionLabels: Record<string, string> = {
  ".xlsx": "Excel 工作簿",
  ".xls": "Excel 工作簿",
  ".pdf": "PDF 文档",
  ".png": "PNG 图片",
  ".jpg": "JPEG 图片",
  ".jpeg": "JPEG 图片",
};
const mimeTypeLabels: Record<string, string> = {
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel 工作簿",
  "application/vnd.ms-excel": "Excel 工作簿",
  "application/pdf": "PDF 文档",
  "image/png": "PNG 图片",
  "image/jpeg": "JPEG 图片",
};
const fileBadges: Record<string, string> = {
  ".xlsx": "XLS",
  ".xls": "XLS",
  ".pdf": "PDF",
  ".png": "IMG",
  ".jpg": "IMG",
  ".jpeg": "IMG",
};
const rejectedNamePatterns: Array<[RegExp, string]> = [
  [/^thumbs\.db$/i, "系统缩略图文件不是结算单"],
  [/库存.*盘点|盘点表/, "盘点表不是结算单"],
  [/供应商对账统计|对账统计表/, "供应商统计表不是结算单"],
  [/业绩确认/, "业绩确认表不是结算单"],
  [/扣款明细/, "扣款明细请作为人工附件处理，不作为结算单上传"],
  [/费用清单/, "费用清单请作为人工附件处理，不作为结算单上传"],
  [/租赁/, "租赁资料请作为人工附件处理，不作为结算单上传"],
];
const shopCodePattern = /(^|[^A-Z0-9])([A-Z]{2,5}[A-Z0-9]*\d[A-Z0-9]*)(?=$|[^A-Z0-9])/g;

export function getReconciliationFileExtension(fileName: string) {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex < 0 || dotIndex === fileName.length - 1) return null;
  return fileName.slice(dotIndex).toLowerCase();
}

export function getReconciliationFileTypeLabel(file: Pick<UploadFileLike, "name" | "type">) {
  const extension = getReconciliationFileExtension(file.name);
  if (extension && extensionLabels[extension]) return extensionLabels[extension];
  if (file.type && mimeTypeLabels[file.type]) return mimeTypeLabels[file.type];
  return "对账资料";
}

export function getReconciliationFileBadge(file: Pick<UploadFileLike, "name" | "type">) {
  const extension = getReconciliationFileExtension(file.name);
  if (extension && fileBadges[extension]) return fileBadges[extension];
  if (file.type.startsWith("image/")) return "IMG";
  if (file.type === "application/pdf") return "PDF";
  return "FILE";
}

export function formatFileSize(fileSize: number) {
  return `${(fileSize / 1024 / 1024).toFixed(2)} MB`;
}

export function extractShopCodesFromFileName(fileName: string) {
  const normalized = fileName.normalize("NFKC").toUpperCase();
  const codes: string[] = [];
  for (const match of normalized.matchAll(shopCodePattern)) {
    const code = match[2];
    if (/^20\d{4}$/.test(code) || codes.includes(code)) continue;
    codes.push(code);
  }
  return codes;
}

export function settlementFileRejectionReason(fileName: string) {
  const baseName = fileName.normalize("NFKC").split(/[\\/]/).pop() ?? fileName;
  const hardRejectedReason = settlementFileHardRejectionReason(fileName);
  if (hardRejectedReason) return hardRejectedReason;

  const shopCodes = extractShopCodesFromFileName(baseName);
  if (shopCodes.length > 1) {
    return `文件名包含多个店铺号（${shopCodes.join("、")}），请拆成单店铺结算单后再上传`;
  }

  return null;
}

export function settlementFileHardRejectionReason(fileName: string) {
  const baseName = fileName.normalize("NFKC").split(/[\\/]/).pop() ?? fileName;
  const matchedRule = rejectedNamePatterns.find(([pattern]) => pattern.test(baseName));
  return matchedRule?.[1] ?? null;
}

export function validateReconciliationFile(file: UploadFileLike) {
  const extension = getReconciliationFileExtension(file.name);
  const hasAcceptedExtension = extension ? acceptedExtensionSet.has(extension) : false;
  const hasAcceptedMimeType = file.type ? acceptedMimeTypeSet.has(file.type) : false;

  if (!hasAcceptedExtension && !hasAcceptedMimeType) {
    return `仅支持 ${reconciliationReadableFileTypes} 文件`;
  }

  if (file.size > reconciliationMaxFileSizeBytes) {
    return `单个文件不能超过 ${reconciliationMaxFileSizeMb} MB`;
  }

  const rejectedReason = settlementFileRejectionReason(file.name);
  if (rejectedReason) return rejectedReason;

  return null;
}

export function validateBatchReconciliationFile(file: UploadFileLike) {
  const extension = getReconciliationFileExtension(file.name);
  const hasAcceptedExtension = extension ? acceptedExtensionSet.has(extension) : false;
  const hasAcceptedMimeType = file.type ? acceptedMimeTypeSet.has(file.type) : false;

  if (!hasAcceptedExtension && !hasAcceptedMimeType) {
    return `仅支持 ${reconciliationReadableFileTypes} 文件`;
  }

  if (file.size > reconciliationMaxFileSizeBytes) {
    return `单个文件不能超过 ${reconciliationMaxFileSizeMb} MB`;
  }

  return settlementFileHardRejectionReason(file.name);
}

export function validateErpFile(file: UploadFileLike) {
  const extension = getReconciliationFileExtension(file.name);
  const hasExcelExtension = extension === ".xlsx" || extension === ".xls";
  const hasExcelMimeType = file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    || file.type === "application/vnd.ms-excel";

  if (!hasExcelExtension && !hasExcelMimeType) return "ERP 总表只支持 .xlsx / .xls";
  if (file.size > reconciliationMaxFileSizeBytes) return `单个文件不能超过 ${reconciliationMaxFileSizeMb} MB`;
  return null;
}

export function getReconciliationFileMetadata(file: UploadFileLike) {
  return {
    name: file.name,
    size: file.size,
    type: file.type,
    extension: getReconciliationFileExtension(file.name),
  };
}
