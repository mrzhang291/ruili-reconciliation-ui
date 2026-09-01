import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveUploadDir } from "./config.js";

const allowedExtensions = [".xlsx", ".xls", ".pdf", ".png", ".jpg", ".jpeg"];

export type StoredFile = {
  id: string;
  extension: string;
  absolutePath: string;
  originalName: string;
  contentType: string;
  sizeBytes: number;
};

export function normalizeFileName(originalName: string) {
  const decoded = /[\u0080-\u00ff]/.test(originalName)
    ? Buffer.from(originalName, "latin1").toString("utf8")
    : originalName;
  const base = path.basename(decoded.includes("�") ? originalName : decoded);
  return base.length > 255 ? base.slice(-255) : base;
}

export function saveUploadedFile(buffer: Buffer, originalName: string, contentType = "application/octet-stream"): StoredFile {
  const directory = resolveUploadDir();
  fs.mkdirSync(directory, { recursive: true });
  const id = crypto.randomUUID();
  const candidate = path.extname(originalName).toLowerCase();
  const extension = allowedExtensions.includes(candidate) ? candidate : "";
  const storedName = normalizeFileName(originalName);
  const fileDirectory = path.join(directory, id);
  fs.mkdirSync(fileDirectory, { recursive: true });
  const absolutePath = path.join(fileDirectory, storedName || `${id}${extension}`);
  fs.writeFileSync(absolutePath, buffer);
  return {
    id,
    extension,
    absolutePath,
    originalName: storedName,
    contentType,
    sizeBytes: buffer.length,
  };
}

export function deleteStoredFilePath(filePath: string) {
  const uploadDirectory = resolveUploadDir();
  const resolvedPath = path.resolve(filePath);
  if (resolvedPath !== uploadDirectory && !resolvedPath.startsWith(`${uploadDirectory}${path.sep}`)) {
    throw new Error(`拒绝删除上传目录之外的文件：${resolvedPath}`);
  }
  try {
    fs.unlinkSync(resolvedPath);
    const parent = path.dirname(resolvedPath);
    if (parent !== uploadDirectory) fs.rmdirSync(parent);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}
