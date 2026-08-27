# CherryStudio Agent 调用契约

CherryStudio 请求全部由后端发起。浏览器不持有 API Key，也不直接访问 Agent 或 Session 接口。

## Agent 与 Session

后端调用：

```http
GET /v1/agents?limit=100&offset=0
POST /v1/agents/{agentId}/sessions
POST /v1/agents/{agentId}/sessions/{sessionId}/messages
Authorization: Bearer <CHERRYSTUDIO_API_KEY>
```

Agent 按名称和可选工作目录精确匹配。每次对账创建独立 Session，Session ID 和 Agent ID 会写入任务记录，便于定位执行过程。

## 文件访问

上传文件由后端保存并关联任务。Prompt 使用下面两个后端文件地址供 Agent 读取：

```text
GET /api/tasks/{taskId}/files/SETTLEMENT
GET /api/tasks/{taskId}/files/ERP
```

支持 `.xlsx`、`.xls`、`.pdf`、`.png`、`.jpg`、`.jpeg`，单个文件最大 20 MB。

## 结果 JSON

Agent 最终必须返回：

```json
{
  "matched": false,
  "difference": -5.0,
  "issues": "结算金额比 ERP 多 5 元，疑似存在退款记录未同步。",
  "period": "2026-05",
  "name": "SHNKA2"
}
```

顶层必须且只应返回 `matched`、`difference`、`issues`、`period`、`name` 五个字段。`issues` 必须是字符串；没有疑似原因时返回空字符串。`period` 必须从 DRP 表单读取并使用 `YYYY-MM` 格式；`name` 必须是结算单对应的店铺号，不能为空，也不能用 Agent 名称或任务 ID 代替。后端将 `name` 作为店铺号写入对账任务。

差额方向固定为 `ERP 金额 - 结算金额`。后端会拒绝以下不符合契约或自相矛盾的结果：

- `matched=true` 但总差额非零或 `issues` 不是空字符串。
- `matched=false`、总差额为零且 `issues` 是空字符串。
- 总差额不是有限数字。
- 缺少五个必需字段、包含额外字段、字段类型错误，或 `period` 不是 `YYYY-MM` 格式。

后端会把 `issues` 字符串转换为现有的可审核明细；当 `matched=false` 且 `issues` 为空、但总差额非零时，仍会生成一条汇总明细，避免任务无法处理。

## SSE 事件

Messages 接口实际可能返回 `text/event-stream`。后端支持 `reasoning-*`、`tool-call`、`tool-result`、`tool-error`、`text-delta` 和 `text-end`，并兼容累计式与增量式 `text-delta`。过程日志保存在服务器内存中供前端短期轮询；任务状态、Agent 选择器和执行次数保存在 PostgreSQL 中。

## 失败与恢复

前端轮询遇到瞬时网络错误时会指数退避重连，并在刷新页面后从本地任务 ID 恢复。后端重启后会重新执行 `QUEUED` 或 `PROCESSING` 任务，每个任务最多自动尝试三次。恢复任务会创建新的 CherryStudio Session，并以最新一次完整结果替换可能残留的审核明细。
