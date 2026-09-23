import { Router, type NextFunction, type Response } from "express";
import {
  configureQqMail,
  getQqMailStatus,
  prepareQqMailMessage,
  QqMailError,
  sendQqMailMessage,
} from "../lib/qq-mail.js";

export const mailRouter = Router();

mailRouter.use((req, res, next) => {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    return res.status(403).json({
      error: { code: "MAIL_LOCAL_ONLY", message: "邮箱功能仅允许从本机访问", requestId: crypto.randomUUID() },
    });
  }
  res.set("Cache-Control", "no-store");
  return next();
});

mailRouter.get("/qq/status", async (_req, res, next) => {
  try {
    return res.json({ data: await getQqMailStatus(), requestId: crypto.randomUUID() });
  } catch (error) {
    return handleMailError(error, res, next);
  }
});

mailRouter.post("/qq/configuration", async (req, res, next) => {
  try {
    return res.json({ data: await configureQqMail(req.body), requestId: crypto.randomUUID() });
  } catch (error) {
    return handleMailError(error, res, next);
  }
});

mailRouter.post("/qq/prepare", async (req, res, next) => {
  try {
    return res.json({ data: await prepareQqMailMessage(req.body), requestId: crypto.randomUUID() });
  } catch (error) {
    return handleMailError(error, res, next);
  }
});

mailRouter.post("/qq/send", async (req, res, next) => {
  try {
    return res.json({ data: await sendQqMailMessage(req.body), requestId: crypto.randomUUID() });
  } catch (error) {
    return handleMailError(error, res, next);
  }
});

function handleMailError(error: unknown, res: Response, next: NextFunction) {
  if (error instanceof QqMailError) {
    return res.status(error.statusCode).json({
      error: { code: error.code, message: error.message, requestId: crypto.randomUUID() },
    });
  }
  return next(error);
}

export function isLoopbackAddress(address: string | undefined) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
