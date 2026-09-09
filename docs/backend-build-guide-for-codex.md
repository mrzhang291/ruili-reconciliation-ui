# 锐力对账系统 · 后端 + 数据库搭建指南（Codex 任务书）

> **阅读对象**：Codex（AI 编码代理）。
> **目标**：在一个现有 Vite + React 纯前端项目上，新增一个 Node.js + TypeScript + PostgreSQL + Prisma 后端，把当前"内存态对账数据"迁移到数据库，并把调用 CherryStudio agent 的逻辑从前端搬到后端。
> **验收标准**：后端能跑起来，提供 REST API；前端通过 HTTP 调用后端完成对账、列表、详情、审批、统计；数据持久化到 PostgreSQL。

---

## 0. 项目现状（你必须先了解）

### 0.1 技术栈

| 层 | 现状 |
|---|---|
| 前端 | React 19 + TypeScript + Vite 8，纯浏览器应用 |
| 数据 | 全在内存（`CherryStudioReconciliationApi` 类里的数组和 Map），刷新即丢 |
| AI 对账 | 前端直接调 CherryStudio agent（HTTP + SSE），API Key 打包进浏览器（`VITE_CHERRYSTUDIO_API_KEY`） |
| 文件上传 | Vite dev server 的内置插件（`vite.config.ts` 里 `localReconciliationUploadPlugin`），文件暂存系统临时目录 |
| 数据库 | 无（本次要新增 PostgreSQL） |

### 0.2 现有目录结构

```
src/
  app/                     # React 入口
  features/reconciliation/
    api/                   # ★ 前端的数据访问层
      index.ts             # 组装 reconciliationApi（当前在内存/disabled 之间切换）
      cherrystudio-client.ts  # ★ 当前的核心：内存态实现，要替换成后端 HTTP 调用
      disabled-client.ts   # 无配置时的兜底
      file-uploader.ts     # 前端上传文件到 Vite 插件
      agent-resolver.ts    # 前端解析 CherryStudio agent/session
      prompt.ts            # 拼对账提示词
      response-adapter.ts  # 解析 agent 返回的 JSON/SSE
      error.ts             # ReconciliationApiError
      types.ts             # ReconciliationApi 接口
      local-upload-path.ts
    hooks/                 # React hooks，全部通过 reconciliationApi 拿数据
    components/            # 页面组件
    model/
      types.ts             # ★ 全部领域类型
      view-model.ts        # 展示层转换
      file-rules.ts
      workspace-types.ts
  shared/styles.css
```

### 0.3 关键约束

- **前端 `ReconciliationApi` 接口要保持不变**（`api/types.ts`）。后端上线后，只需要把 `cherrystudio-client.ts` 换成 `http-client.ts`（调后端），**组件层和 hooks 一行都不用改**。
- 项目是 **ESM**（`package.json` 有 `"type": "module"`），所有新代码用 ESM 语法。
- Node 版本 `>=22.13`（实际环境 v24.16）。
- 数据库：**PostgreSQL**（云服务器自装，可先用本地 Postgres 开发）。
- ORM：**Prisma**。

---

## 1. 目标架构

```
浏览器 (React, 端口 3333)
   │  HTTP /api/*   ← 所有数据读写走这里
   ▼
后端服务 (Node + Express + Prisma, 建议端口 3001)
   │  ├── PostgreSQL  ← 任务/明细/文件记录（持久化）
   │  ├── 服务器磁盘 /data/files/{fileId} ← 原始文件（存磁盘，库内存 fileId）
   │  └── CherryStudio agent ← 对账/OCR（API Key 只在后端）
```

**职责转移**：
- 前端原来做的：上传文件到 Vite 插件 → 找 agent/session → 拼 prompt → 调 CherryStudio → 解析结果 → 存内存。
- 后端现在做的：接收前端上传 → 存数据库(PROCESSING) → 存文件到磁盘 → 调 CherryStudio → 解析结果 → 回写数据库 → 供前端查询。
- 前端 `ReconciliationApi` 变成：调后端 REST API 即可。

---

## 2. 数据库设计（最终定案，Prisma Schema）

### 2.1 三张表

**`ReconciliationTask`（对账任务表）** —— 对应 `reconciliation_tasks`

| 字段 | Prisma 类型 | 说明 |
|---|---|---|
| id | String @id @default(uuid()) | 任务ID |
| version | Int @default(1) | 账期内版本号，同账期每对一次 +1 |
| status | TaskStatus | 状态机（见 2.2） |
| period | String? | 账期 `YYYY-MM`，OCR 提取失败为 NULL（不参与版本唯一约束） |
| periodRaw | String? | OCR 提取的原始日期文本，追溯用 |
| settlementFileId | String @unique | 结算单文件ID，指向 files.id |
| erpFileId | String @unique | ERP单文件ID，指向 files.id |
| settlementAmount | Decimal? @db.Decimal(14,2) | 结算总额，agent 可能不返回，允许空 |
| erpAmount | Decimal? @db.Decimal(14,2) | ERP总额，同上 |
| differenceAmount | Decimal? @db.Decimal(14,2) | 差额，唯一较稳定的金额 |
| failureCode | String? | 失败码 |
| failureMessage | String? | 失败原因 |
| rawAgentPayload | Json? | ★ agent 完整返回原样留底 |
| createdByName | String? | ★ 操作人，预留字段（登录前不鉴权） |
| createdAt | DateTime @default(now()) | 创建时间 |
| completedAt | DateTime? | 完成时间 |
| resolvedAt | DateTime? | 进入 REVIEWED 的时间 |

**`ReconciliationReviewItem`（差异明细表）** —— 对应 `reconciliation_review_items`

| 字段 | Prisma 类型 | 说明 |
|---|---|---|
| id | String @id @default(uuid()) | 明细ID |
| taskId | String | 所属任务，FK → ReconciliationTask.id，onDelete Cascade |
| label | String | 行标签（这行是什么，列表展示用） |
| differenceAmount | Decimal? @db.Decimal(14,2) | 差额，抽出来列存（排序/统计用） |
| status | ReviewItemStatus @default(PENDING) | 审核状态 |
| payload | Json | ★ 该条完整原始数据，字段再变也不怕 |
| createdAt | DateTime @default(now()) | 创建时间 |
| resolvedAt | DateTime? | 审批时间 |

**`File`（文件表）** —— 对应 `files`

| 字段 | Prisma 类型 | 说明 |
|---|---|---|
| id | String @id @default(uuid()) | 文件ID |
| kind | FileKind | SETTLEMENT \| ERP |
| originalName | String | 原文件名 |
| contentType | String? | MIME 类型 |
| sizeBytes | BigInt | 文件大小 |
| storedPath | String | ★ 服务器磁盘路径，如 `/data/files/{id}.xlsx` |
| createdAt | DateTime @default(now()) | 上传时间 |
| deletedAt | DateTime? | ★ 软删标记，供延迟清理脚本用 |

### 2.2 枚举

```prisma
enum TaskStatus {
  QUEUED
  PROCESSING
  SUCCEEDED      // 自动通过，计入 autoMatchRate
  NEEDS_REVIEW   // 有差异，待逐条审批
  REVIEWED       // 人工复核完成
  FAILED
  OBSOLETE       // 同账期新版产生，旧版作废
}

enum ReviewItemStatus {
  PENDING
  APPROVED
  IGNORED
}

enum FileKind {
  SETTLEMENT
  ERP
}
```

### 2.3 状态机

```
QUEUED ─▶ PROCESSING ─▶ SUCCEEDED（自动通过）
              │
              ├▶ NEEDS_REVIEW ──逐条审批──▶ 全部离开 PENDING ─▶ REVIEWED
              │
              └▶ FAILED

任意终态 ── 同账期出现新版且新版非 FAILED ──▶ OBSOLETE
审批可撤销：某条 APPROVED/IGNORED → PENDING 时，REVIEWED 回退 NEEDS_REVIEW
```

### 2.4 关系

```
ReconciliationTask 1 ── 多 ──> ReconciliationReviewItem
ReconciliationTask 1 ── 2 ──> File（settlementFile + erpFile）
```

### 2.5 关键约束

```prisma
model ReconciliationTask {
  // ...
  @@unique([period, version])   // 同账期同版本全局唯一；NULL 账期天然不冲突
  @@index([status])
  @@index([period])
  @@index([createdAt])
}

model ReconciliationReviewItem {
  // ...
  @@index([taskId])
}
```

---

## 3. 后端项目结构

在项目根目录下新增 `server/` 目录，和后端前端代码分离：

```
server/
  package.json           # 独立 package.json（后端依赖）
  tsconfig.json
  prisma/
    schema.prisma        # 数据库模型
    migrations/          # prisma migrate 生成
  src/
    index.ts             # 入口：创建 Express app、启动
    config.ts            # 环境变量读取
    lib/
      prisma.ts          # PrismaClient 单例
      file-storage.ts    # 文件磁盘读写（save/get/delete，软删清理）
      cherrystudio.ts    # 调用 CherryStudio agent（从前端搬过来并改造）
    routes/
      tasks.ts           # /api/tasks 增查
      task-detail.ts     # /api/tasks/:id 详情
      review-items.ts    # /api/tasks/:id/review-items/:itemId 审批
      files.ts           # /api/tasks/:id/files/:kind 下载
      statistics.ts      # /api/statistics
    services/
      reconciliation.ts  # 核心业务：创建任务、状态流转、版本号、事务
    middleware/
      error-handler.ts   # 统一错误
      not-found.ts
  .env                   # DATABASE_URL、CHERRYSTUDIO_API_KEY 等（不进 git）
```

---

## 4. 后端 API 契约（前端 ReconciliationApi 的映射）

### 4.1 接口总览

| 方法 | 路径 | 前端方法 | 说明 |
|---|---|---|---|
| POST | /api/tasks | createTask | multipart 上传两文件 → 建任务(PROCESSING) → 异步对账 → 回写 |
| GET | /api/tasks | listTasks | 分页列表，支持 status / keyword / page / pageSize |
| GET | /api/tasks/:id | getTask | 任务详情（含 reviewItems） |
| GET | /api/tasks/:id/files/:kind | (下载文件) | 从磁盘流式读文件 |
| PATCH | /api/tasks/:id/review-items/:itemId | (审批) | 更新明细 status，自动流转任务状态 |
| GET | /api/statistics | getStatistics | 总览统计 |

### 4.2 响应格式（要和前端现有 `ApiEnvelope` 对齐）

```json
{
  "data": { ... },
  "requestId": "uuid"
}
```

错误格式（前端 `ApiErrorPayload`）：
```json
{
  "error": {
    "code": "TASK_NOT_FOUND",
    "message": "未找到对账任务",
    "requestId": "uuid",
    "details": {}
  }
}
```

### 4.3 各接口细节

#### POST /api/tasks（创建对账）

请求：`multipart/form-data`，两个文件字段 `settlementFile`、`erpFile`，外加 agent 选择参数（name/workspace，可 JSON 字符串或表单字段）。

后端流程：
1. 接收两文件，写入磁盘 `/data/files/{fileId}.{ext}`。
2. 在数据库创建 `File` 两条记录。
3. 在数据库创建 `ReconciliationTask`，status=PROCESSING，version 按账期计算（见 6.2），记 fileId。
4. **异步**（不阻塞响应）调 CherryStudio agent（见第 5 节）。
5. agent 返回后解析，回写任务状态/金额/明细/rawAgentPayload。
6. 返回任务摘要（对应前端 `ReconciliationTaskSummary`）。

> ⚠️ 前端 `createTask` 依赖 `onProgress` 实时日志（`ReconciliationProcessLog`）。后端需要支持流式进度。**建议**：POST /api/tasks 返回 202 + taskId，前端改轮询 GET /api/tasks/:id 看进度；或后端用 SSE 推送进度。**第一版建议先实现轮询**（前端已有 3 秒轮询逻辑）。

#### GET /api/tasks（列表）

查询参数：`status`（可多个，逗号分隔）、`keyword`、`page`、`pageSize`。

返回：
```json
{
  "data": {
    "items": [ReconciliationTaskSummary...],
    "page": 1,
    "pageSize": 20,
    "total": 100,
    "facets": {
      "total": 100,
      "byStatus": { "QUEUED": 0, "PROCESSING": 0, "SUCCEEDED": 40, "NEEDS_REVIEW": 30, "REVIEWED": 20, "FAILED": 5, "OBSOLETE": 5 }
    }
  }
}
```

> ⚠️ 前端现有 `buildTaskFacets` 的 `byStatus` 只含 5 个状态（无 REVIEWED/OBSOLETE）。**后端 facets 要包含全部状态**，前端 view-model 的 `statusFilters` 需要看是否要加 REVIEWED（可选，第一版可只把 REVIEWED 归入 issue 或单独展示）。

#### GET /api/tasks/:id（详情）

返回 `ReconciliationTaskDetail`（含 `reviewItems` 数组、`failure`）。

#### PATCH /api/tasks/:id/review-items/:itemId（审批）

请求体：`{ "status": "APPROVED" | "IGNORED" | "PENDING" }`

后端逻辑（**必须在事务里**）：
1. 更新该明细 status + resolvedAt。
2. 若该明细从 APPROVED/IGNORED 改回 PENDING → 任务从 REVIEWED 回退 NEEDS_REVIEW。
3. 若该任务下所有明细都离开 PENDING → 任务 NEEDS_REVIEW → REVIEWED（resolvedAt=now）。
4. 返回更新后的任务详情。

#### GET /api/statistics（统计）

按月（默认当前月）统计：
- totalTasks / succeededTasks / needsReviewTasks / failedTasks / processingTasks / reviewedTasks
- autoMatchRate = succeededTasks / totalTasks（**只看 SUCCEEDED，不算 REVIEWED**）
- totalDifferenceAmount = sum(differenceAmount)
- trend：近 N 个月任务数

---

## 5. 调用 CherryStudio（从前端搬移到后端）

### 5.1 搬运清单

前端这几个文件/模块整体搬到后端 `server/src/lib/cherrystudio.ts`（或保留原逻辑改为服务端调用）：

- `src/features/reconciliation/api/agent-resolver.ts` —— 解析 agent/session（**服务端调，无 CORS/Key 暴露问题**）
- `src/features/reconciliation/api/prompt.ts` —— 拼 prompt
- `src/features/reconciliation/api/response-adapter.ts` —— 解析 agent 返回（JSON + SSE）
- `src/features/reconciliation/api/error.ts` —— 错误类型

### 5.2 关键改造点

1. **API Key**：前端 `VITE_CHERRYSTUDIO_API_KEY` → 后端 `CHERRYSTUDIO_API_KEY`（`.env`），不再进浏览器。
2. **文件 URL**：前端原来把文件上传到 Vite 插件拿 URL 塞进 prompt。现在文件在后端磁盘，**后端直接把本地文件路径（或后端自己暴露的 /api/files/:id URL）塞进 prompt**，CherryStudio 需要能访问到。如果 CherryStudio 在本地（127.0.0.1:24333），后端文件 URL 用 `http://127.0.0.1:3001/api/tasks/:id/files/:kind` 即可。
3. **上传**：前端 `ReconciliationFileUploader` 不再需要（文件直接 POST 给后端，后端落盘）。
4. **SSE 解析**：`readCherryStudioJson` 保留，因为 agent 实际返回 SSE 流。

### 5.3 agent 返回解析

`response-adapter.ts` 的 `createTaskFromCherryStudioResponse` 目前只在内存造数据。**后端要改写**：
- 从 agent 返回里提取：`matched`、`difference`、`issues`/`reviewItems`（逐条差异）。
- 每条差异 → `ReconciliationReviewItem`：`label` = rowLabel/fieldName，`differenceAmount` = differenceAmount，`payload` = **整条原始 issue**（原样存 JSONB），`status` = PENDING。
- 任务级：`status` = matched ? SUCCEEDED : NEEDS_REVIEW，`differenceAmount` = difference。
- `settlementAmount` / `erpAmount`：agent 可能不返回，置 NULL。
- `rawAgentPayload`：agent 完整返回 JSON 原样存。
- **不要再生成假的 `totalCount/matchedCount/differenceCount`**（前端现在不需要它们来数，明细表能数出来）。

---

## 6. 核心业务逻辑（服务层）

### 6.1 创建任务的时序

```
POST /api/tasks
  ├─ 落盘两文件
  ├─ $transaction:
  │   ├─ 作废旧版（若同账期已有非 OBSOLETE 任务 → 标 OBSOLETE）
  │   ├─ 计算 version = max(version for period) + 1
  │   ├─ INSERT ReconciliationTask (status=PROCESSING)
  │   └─ INSERT File × 2
  ├─ 异步调 CherryStudio（不阻塞响应）
  └─ 返回 202 + taskId
```

### 6.2 版本号 + 并发（方案 A：事务 + 行锁）

```ts
await prisma.$transaction(async (tx) => {
  // 锁住该账期的行，防并发撞版本号
  const latest = await tx.reconciliationTask.findFirst({
    where: { period },
    orderBy: { version: "desc" },
  });
  const nextVersion = latest ? latest.version + 1 : 1;

  // 作废旧版（新任务成功后才作废；新任务 FAILED 时不要作废旧版）
  if (finalStatus !== "FAILED") {
    await tx.reconciliationTask.updateMany({
      where: { period, status: { not: "OBSOLETE" }, id: { not: newTaskId } },
      data: { status: "OBSOLETE" },
    });
  }

  await tx.reconciliationTask.create({ data: { ... , version: nextVersion } });
});
```

> Prisma 的交互式事务 `$transaction(async (tx) => {...})` 已保证串行化；如需更强并发保护，可配合 `SELECT ... FOR UPDATE`（`$queryRaw`）。**第一版**用交互式事务即可。

### 6.3 状态流转规则（写一个纯函数 `transitionTask`）

```ts
function transitionTask(currentStatus: TaskStatus, action): TaskStatus {
  switch (action) {
    case "START":           // 提交 → PROCESSING
    case "SUCCEED":         // PROCESSING → SUCCEEDED
    case "NEEDS_REVIEW":    // PROCESSING → NEEDS_REVIEW
    case "FAIL":            // PROCESSING → FAILED
    case "ALL_ITEMS_DONE":  // NEEDS_REVIEW → REVIEWED
    case "REOPEN":          // REVIEWED → NEEDS_REVIEW (撤销审批)
    // ...
  }
}
```

### 6.4 审批 + 自动流转（必须在事务里）

```ts
await prisma.$transaction(async (tx) => {
  const item = await tx.reconciliationReviewItem.update({ ... });  // 改明细 status
  const task = await tx.reconciliationTask.findUnique({ where: { id: taskId }, include: { reviewItems: true } });
  const allDone = task.reviewItems.every(i => i.status !== "PENDING");
  if (allDone && task.status === "NEEDS_REVIEW") {
    await tx.reconciliationTask.update({ where: { id: taskId }, data: { status: "REVIEWED", resolvedAt: new Date() } });
  }
  if (item.status === "PENDING" && task.status === "REVIEWED") {
    await tx.reconciliationTask.update({ where: { id: taskId }, data: { status: "NEEDS_REVIEW", resolvedAt: null } });
  }
});
```

### 6.5 服务启动"收尾"

后端启动时，把残留的 `PROCESSING`/`QUEUED` 任务标记为 FAILED（failureMessage="服务中断，任务未完成"）。防止重启后任务永远卡在"对账中"。

---

## 7. 文件存储（磁盘 + 软删清理）

### 7.1 目录约定

```
/data/files/{fileId}.{ext}    # 原始文件，只增不改，ID 即文件名
```

`fileId` = UUID，`ext` = 原文件扩展名（白名单：xlsx/xls/pdf/png/jpg/jpeg）。

### 7.2 文件生命周期

| 操作 | 行为 |
|---|---|
| 上传 | 落盘 → INSERT File 记录 |
| 任务删除 | 软删：`File.deletedAt = now()`（不立即删磁盘） |
| 定时清理 | 每天扫 `deletedAt < now() - 30天` → 删磁盘文件 + 删 File 记录 |

### 7.3 下载

`GET /api/tasks/:id/files/:kind` → 根据 kind (SETTLEMENT/ERP) 找 File 记录 → `createReadStream(storedPath)` 流式返回，`Content-Type` = contentType，`Content-Disposition` inline 保留文件名。

> **绝不暴露磁盘真实路径给前端**，前端只通过 API 访问。

---

## 8. 环境变量（server/.env）

```
DATABASE_URL="postgresql://user:password@localhost:5432/reconciliation?schema=public"
CHERRYSTUDIO_BASE_URL="http://127.0.0.1:24333"
CHERRYSTUDIO_API_KEY="your-key"
CHERRYSTUDIO_DEFAULT_AGENT_NAME="锐力体育"
CHERRYSTUDIO_DEFAULT_AGENT_WORKSPACE=""
UPLOAD_DIR="/data/files"       # 文件磁盘目录
PORT=3001
```

---

## 9. 前端改造（最小改动）

前端 `ReconciliationApi` 接口不变，只换实现。**核心改动**：

### 9.1 新增 `src/features/reconciliation/api/http-client.ts`

实现 `ReconciliationApi`，所有方法改调后端 REST：

- `createTask` → POST /api/tasks（multipart 上传文件 + agent 参数）；onProgress 先发"已提交"日志，之后靠轮询 getTask 更新。
- `listTasks` → GET /api/tasks?status=&keyword=&page=&pageSize=
- `getTask` → GET /api/tasks/:id
- `getStatistics` → GET /api/statistics?month=

### 9.2 改 `api/index.ts`

```ts
export const reconciliationApi: ReconciliationApi = new HttpReconciliationApi({
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3001",
});
```

`usingDisabledApi` 逻辑保留（无 API 地址时用 DisabledClient 兜底）。

### 9.3 删除/停用前端不再需要的

- `cherrystudio-client.ts`（内存实现）→ 删除，换 http-client
- `file-uploader.ts`、`agent-resolver.ts`、`prompt.ts`、`response-adapter.ts` → 逻辑搬到后端，前端不再用
- `vite.config.ts` 的 `localReconciliationUploadPlugin` → 可删（文件改走后端）
- 前端 `VITE_CHERRYSTUDIO_*` 环境变量 → 移除（API Key 不再进浏览器），新增 `VITE_API_BASE_URL`

### 9.4 类型对齐

`model/types.ts` 的 `ReconciliationStatus` 加 `REVIEWED`。`view-model.ts` 的 `statusLabels`/`statusFilters` 决定 REVIEWED 怎么展示（建议：成功类算 success 之外，单独或归入 issue 均可，第一版可归入"已复核"独立标签）。

---

## 10. 实施步骤（Codex 按顺序执行）

### 阶段一：后端脚手架
1. `mkdir server && cd server && npm init -y`
2. 安装依赖：`npm i express cors multer dotenv @prisma/client` + `npm i -D typescript tsx @types/express @types/cors @types/multer prisma @types/node`
3. `server/tsconfig.json`：ESM、`module: "NodeNext"`、`target: "ES2022"`、`strict: true`
4. `server/package.json` scripts：`"dev": "tsx watch src/index.ts"`、`"build": "tsc"`、`"start": "node dist/index.js"`

### 阶段二：Prisma + 数据库
5. `npx prisma init` → 写 `prisma/schema.prisma`（按第 2 节）
6. 本地建 Postgres 库，配 `DATABASE_URL`
7. `npx prisma migrate dev --name init` → 生成表 + Prisma Client

### 阶段三：核心服务
8. 写 `lib/prisma.ts`（单例）
9. 写 `lib/file-storage.ts`（落盘/读流/软删/清理）
10. 写 `lib/cherrystudio.ts`（搬运 + 改造 agent 调用）
11. 写 `services/reconciliation.ts`（创建任务、状态机、版本号、审批事务）

### 阶段四：路由 + 中间件
12. 写 `routes/tasks.ts`（POST/GET）
13. 写 `routes/task-detail.ts`（GET :id）
14. 写 `routes/review-items.ts`（PATCH 审批）
15. 写 `routes/files.ts`（下载）
16. 写 `routes/statistics.ts`
17. 写 `middleware/error-handler.ts` + `not-found.ts`
18. 写 `index.ts`（装配 app，启动时做"收尾"）

### 阶段五：前端对接
19. 写 `http-client.ts`，替换 `api/index.ts`
20. 删前端 `cherrystudio-client.ts` 等不再用的文件
21. 更新 `model/types.ts`（加 REVIEWED）、`view-model.ts`
22. 清理 `vite.config.ts` 上传插件、移除 `VITE_CHERRYSTUDIO_*`

### 阶段六：联调验证
23. 后端起服务，用 curl 测各接口（POST 建任务、GET 列表/详情、PATCH 审批、GET 统计）
24. 前端 `npm run dev`，点"开始对账"，确认：提交即落库、进度可见、结果回写、刷新不丢
25. 验证状态流转：对账成功 → SUCCEEDED；有差异 → NEEDS_REVIEW → 审批全部完成 → REVIEWED
26. 验证版本号：同账期对两遍 → v1 作废 OBSOLETE、v2 生效
27. 跑 `npm test`（现有前端测试）确认组件未破坏

---

## 11. 上线注意事项（别踩坑）

| 事项 | 说明 |
|---|---|
| 文件备份 | `/data/files` 定期 rsync 到别处，否则磁盘坏文件全丢 |
| 后端重启收尾 | 启动时把残留 PROCESSING 标 FAILED（第 6.5 节） |
| 密钥只在后端 | CherryStudio API Key 只在 `server/.env`，不进前端 |
| 数据库备份 | Postgres 定期 `pg_dump`，和文件备份分开做 |
| CORS | 后端要允许前端 `http://localhost:3333` 跨域 |
| 文件大小限制 | multer 限制单文件 20MB，超限返回 413 |
| JSONB 使用 | `rawAgentPayload` / `payload` 用 Prisma `Json` 类型，不要转字符串 |
| 金额精度 | 全部 `Decimal(14,2)`，后端用 `Prisma.Decimal`，不要用 JS number 做运算 |

---

## 12. 验收清单（Codex 自查）

- [ ] `npm run dev` 后端在 3001 启动，连上 Postgres
- [ ] `prisma migrate` 生成三张表 + 索引 + 唯一约束
- [ ] POST /api/tasks 能建任务、落盘文件、返回 202
- [ ] 异步对账完成后，任务状态/明细正确回写数据库
- [ ] GET /api/tasks 分页 + facets 正确
- [ ] GET /api/tasks/:id 返回 reviewItems
- [ ] PATCH 审批后任务自动 REVIEWED；撤销后回退 NEEDS_REVIEW
- [ ] GET /api/statistics 的 autoMatchRate 只算 SUCCEEDED
- [ ] 同账期对两遍版本号正确递增、旧版 OBSOLETE
- [ ] 后端重启后残留 PROCESSING 变 FAILED
- [ ] 前端通过 http-client 调后端，全流程跑通，刷新不丢
- [ ] `npm test` 通过

---

> **给 Codex 的最后提示**：这是"从纯前端 + 内存数据"迁移到"前端 + 后端 + PostgreSQL"的完整任务书。**前端 `ReconciliationApi` 接口是稳定契约，不要改它的方法签名**；数据库 schema、状态机、版本号、审批流转请严格按第 2、6 节实现。遇到任何与本文档不一致的地方，先按文档做，再记录偏差。
