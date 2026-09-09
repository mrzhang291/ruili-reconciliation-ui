import type { NextFunction, Request, Response } from "express";
import { LarkCliError } from "../lib/lark-cli.js";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: `接口不存在：${req.method} ${req.path}`,
      requestId: crypto.randomUUID(),
    },
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = crypto.randomUUID();

  if (error instanceof ApiError) {
    return res.status(error.statusCode).json({
      error: { code: error.code, message: error.message, requestId },
    });
  }

  if (error instanceof LarkCliError) {
    console.error("[lark]", error);
    return res.status(502).json({
      error: { code: error.code, message: `飞书操作失败：${error.message}`, requestId },
    });
  }

  // multer 文件大小限制
  if (error instanceof Error && error.name === "MulterError") {
    const status = error.message.includes("File too large") ? 413 : 400;
    return res.status(status).json({
      error: { code: "UPLOAD_ERROR", message: error.message, requestId },
    });
  }

  console.error("[error]", error);
  return res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "服务器内部错误", requestId },
  });
}
