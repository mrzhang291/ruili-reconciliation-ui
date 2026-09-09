import { Router } from "express";
import { getTaskDetail, updateReviewRecord } from "../lib/lark-store.js";
import { toDetail } from "./tasks.js";

export const reviewItemsRouter = Router();

reviewItemsRouter.patch("/:taskId/review-items/:itemId", async (req, res, next) => {
  try {
    const { taskId, itemId } = req.params;
    const status = req.body?.status;
    if (!["PENDING", "APPROVED", "IGNORED"].includes(status)) {
      return res.status(400).json({
        error: { code: "INVALID_STATUS", message: "status 必须是 PENDING / APPROVED / IGNORED", requestId: crypto.randomUUID() },
      });
    }
    if (!await updateReviewRecord(taskId, itemId, status)) {
      return res.status(404).json({ error: { code: "ITEM_NOT_FOUND", message: "未找到该明细", requestId: crypto.randomUUID() } });
    }
    const detail = await getTaskDetail(taskId);
    if (!detail) return res.status(404).json({ error: { code: "TASK_NOT_FOUND", message: "未找到对账任务", requestId: crypto.randomUUID() } });
    return res.json({ data: { task: toDetail(detail.task, detail.reviewItems) }, requestId: crypto.randomUUID() });
  } catch (error) {
    next(error);
  }
});
