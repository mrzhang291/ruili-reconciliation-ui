import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { config, resolveUploadDir } from "./config.js";

const allowedExtensions = [".xlsx", ".xls", ".xlsm", ".pdf", ".png", ".jpg", ".jpeg", ".webp"];

export type StoredFile = {
  id: string;
  extension: string;
  absolutePath: string;
  originalName: string;
  contentType: string;
  sizeBytes: number;
};

function uploadIncomingDirectory() {
  return path.join(resolveUploadDir(), "incoming");
}

function assertUploadPath(filePath: string) {
  const uploadDirectory = resolveUploadDir();
  const resolvedPath = path.resolve(filePath);
  if (resolvedPath !== uploadDirectory && !resolvedPath.startsWith(`${uploadDirectory}${path.sep}`)) {
    throw new Error(`拒绝处理上传目录之外的文件：${resolvedPath}`);
  }
  return resolvedPath;
}

export function createStreamingUpload(maxFiles: number) {
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, callback) => {
        const directory = path.join(uploadIncomingDirectory(), crypto.randomUUID());
        fs.mkdirSync(directory, { recursive: true });
        callback(null, directory);
      },
      filename: (_req, file, callback) => {
        const name = normalizeFileName(file.originalname);
        callback(null, name || crypto.randomUUID());
      },
    }),
    limits: { fileSize: config.maxUploadBytes, files: maxFiles, parts: maxFiles + 8 },
  });
}

export function storedFileFromUpload(file: Pick<Express.Multer.File, "path" | "filename" | "originalname" | "mimetype" | "size">): StoredFile {
  const absolutePath = assertUploadPath(file.path);
  const originalName = normalizeFileName(file.originalname) || file.filename;
  return {
    id: path.basename(path.dirname(absolutePath)),
    extension: path.extname(originalName).toLowerCase(),
    absolutePath,
    originalName,
    contentType: file.mimetype,
    sizeBytes: file.size,
  };
}

export function moveStoredUploadFile(sourcePath: string, destinationPath: string) {
  const source = assertUploadPath(sourcePath);
  const destination = path.resolve(destinationPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EXDEV")) throw error;
    fs.copyFileSync(source, destination);
    fs.unlinkSync(source);
  }
  const parent = path.dirname(source);
  if (parent !== resolveUploadDir()) {
    try {
      fs.rmdirSync(parent);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOTEMPTY")) throw error;
    }
  }
  return destination;
}

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
  const resolvedPath = assertUploadPath(filePath);
  try {
    fs.unlinkSync(resolvedPath);
    const parent = path.dirname(resolvedPath);
    if (parent !== uploadDirectory) fs.rmdirSync(parent);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}
