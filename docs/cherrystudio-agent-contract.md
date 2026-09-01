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

上传文件由后端保存并关联任务。Prompt 使用下面的后端文件地址供 Agent 读取：

```text
GET /api/tasks/{taskId}/files/SETTLEMENT
```

支持 `.xlsx`、`.xls`、`.pdf`、`.png`、`.jpg`、`.jpeg`，单个文件最大 20 MB。

ERP/DRP 金额不再通过本次上传文件传给后端。Agent 需要在 Session 内使用已配置的 ERP/DRP MCP，按结算单确定的 `mall_name` 和 `period` 查询 `sales_total`、`net_sales_total` 及必要明细。

## 结果 JSON

Agent 最终必须返回：

```json
{
  "settlementAmount": 100,
  "settlementAmountLabel": "结算净营业额",
  "salesTotal": 120,
  "netSalesTotal": 100,
  "erpBasis": "net_sales_total",
  "erpAmount": 100,
  "difference": 0,
  "matched": true,
  "basisReason": "该店结算单净营业额按扣点后金额对账。",
  "issues": "",
  "period": "2026-05",
  "name": "SHNKA2"
}
```

顶层必须且只应返回 `settlementAmount`、`settlementAmountLabel`、`salesTotal`、`netSalesTotal`、`erpBasis`、`erpAmount`、`difference`、`matched`、`basisReason`、`issues`、`period`、`name` 十二个字段。`erpBasis` 只能是 `sales_total`、`net_sales_total` 或 `ambiguous`；`issues` 必须是字符串，没有疑似原因时返回空字符串。`period` 必须从结算单读取并使用 `YYYY-MM` 格式；`name` 必须是本次用于查询 ERP/DRP MCP 的主体标识，不能为空，也不能用 Agent 名称或任务 ID 代替。后端将 `name` 写入对账任务。

后端会按 Agent 返回的 `salesTotal`、`netSalesTotal` 和 `erpBasis` 重新验算 `erpAmount` 与 `difference = erpAmount - settlementAmount`。后端会拒绝以下不符合契约的结果：

- `settlementAmount` 不是有限数字。
- `erpBasis` 不在白名单内，或 `basisReason` 为空。
- 缺少十二个必需字段、包含额外字段、字段类型错误，或 `period` 不是 `YYYY-MM` 格式。
- 未返回可靠的 `salesTotal`、`netSalesTotal`、`erpAmount`、`difference`、`matched`。
- `erpAmount` 或 `difference` 与后端验算结果不一致。

后端会把 `issues` 字符串转换为现有的可审核明细。若 `erpBasis=ambiguous`、所选口径差额超过 200 元，或 Agent 选择的口径与金额接近度明显冲突，后端也会生成一条汇总明细并把任务置为待审核。

## SSE 事件

Messages 接口实际可能返回 `text/event-stream`。后端支持 `reasoning-*`、`tool-call`、`tool-result`、`tool-error`、`text-delta` 和 `text-end`，并兼容累计式与增量式 `text-delta`。过程日志保存在服务器内存中供前端短期轮询；任务状态和最终结果保存在飞书 Base 中。

## 失败与恢复

前端轮询遇到瞬时网络错误时会指数退避重连。后端写入飞书失败时不报告成功；单个任务失败不会阻塞同批次其他任务。
