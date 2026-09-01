import cors from "cors";
import express from "express";
import { checkCherryStudioConnection } from "./lib/cherrystudio.js";
import { config } from "./lib/config.js";
import { larkConnectionStatus } from "./lib/lark-store.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { batchesRouter } from "./routes/batches.js";
import { erpRouter } from "./routes/erp.js";
import { filesRouter } from "./routes/files.js";
import { reviewItemsRouter } from "./routes/review-items.js";
import { statisticsRouter } from "./routes/statistics.js";
import { tasksRouter } from "./routes/tasks.js";

async function main() {
  const app = express();
  app.use((req, res, next) => {
    const origin = req.get("origin");
    if (origin && !config.allowedOrigins.includes(origin)) {
      return res.status(403).json({ error: { code: "ORIGIN_FORBIDDEN", message: "不允许的请求来源", requestId: crypto.randomUUID() } });
    }
    next();
  });
  app.use(cors({ origin: config.allowedOrigins }));
  app.use(express.json());

  app.get("/api/health", async (req, res, next) => {
    try {
      const deep = req.query.deep === "1";
      const [cherryStudio, larkBase] = deep
        ? await Promise.all([checkCherryStudioConnection(), larkConnectionStatus()])
        : [{ status: "unchecked" as const }, { status: "unchecked" as const }];
      res.json({
        data: {
          service: "billcompare", apiVersion: 2, status: "ok", storage: "lark-base",
          cherryStudio, larkBase, time: new Date().toISOString(),
        },
        requestId: crypto.randomUUID(),
      });
    } catch (error) {
      next(error);
    }
  });

  app.use("/api/batches", batchesRouter);
  app.use("/api/tasks", tasksRouter);
  app.use("/api/tasks", reviewItemsRouter);
  app.use("/api/tasks", filesRouter);
  app.use("/api/erp", erpRouter);
  app.use("/api/statistics", statisticsRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);

  app.listen(config.port, config.host, () => {
    console.log(`[server] 本地兼容接口已启动: http://${config.host}:${config.port}`);
    console.log(`[server] 持久化存储: 飞书多维表格 ${config.lark.baseToken}`);
  });
}

main().catch((error) => {
  console.error("[server] 启动失败:", error);
  process.exit(1);
});
