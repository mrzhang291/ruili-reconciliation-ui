import fs from "node:fs";
import { Router } from "express";
import { downloadTaskAttachment } from "../lib/lark-store.js";
import { getActiveTaskFile } from "../services/reconciliation.js";

export const filesRouter = Router();

filesRouter.get("/:taskId/files/:kind", async (req, res, next) => {
  try {
    const normalizedKind = (req.params.kind ?? "").toUpperCase();
    if (normalizedKind !== "SETTLEMENT" && normalizedKind !== "ERP") {
      return res.status(400).json({ error: { code: "INVALID_KIND", message: "kind 必须是 SETTLEMENT / ERP", requestId: crypto.randomUUID() } });
    }
    const kind = normalizedKind as "SETTLEMENT" | "ERP";
    const active = getActiveTaskFile(req.params.taskId, kind);
    const downloaded = active ? null : await downloadTaskAttachment(req.params.taskId, kind);
    const file = active
      ? { absolutePath: active.absolutePath, name: active.originalName, size: active.sizeBytes, cleanup: undefined }
      : downloaded;
    if (!file || !fs.existsSync(file.absolutePath)) {
      file?.cleanup?.();
      return res.status(404).json({ error: { code: "FILE_NOT_FOUND", message: "文件不存在或已清理", requestId: crypto.randomUUID() } });
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    res.setHeader("Content-Length", file.size);
    const cleanup = () => file.cleanup?.();
    res.once("finish", cleanup);
    res.once("close", cleanup);
    const stream = fs.createReadStream(file.absolutePath);
    stream.on("error", (error) => { cleanup(); next(error); });
    stream.pipe(res);
  } catch (error) {
    next(error);
  }
});
