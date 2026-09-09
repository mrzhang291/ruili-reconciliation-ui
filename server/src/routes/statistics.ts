import { Router } from "express";
import { getTaskStatistics } from "../lib/lark-store.js";

export const statisticsRouter = Router();

statisticsRouter.get("/", async (req, res, next) => {
  try {
    const month = typeof req.query.month === "string" ? req.query.month : currentShanghaiMonth();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: { code: "INVALID_MONTH", message: "month 必须是 YYYY-MM 格式", requestId: crypto.randomUUID() } });
    }
    return res.json({ data: await getTaskStatistics(month), requestId: crypto.randomUUID() });
  } catch (error) {
    next(error);
  }
});

function currentShanghaiMonth() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).format(new Date());
}
