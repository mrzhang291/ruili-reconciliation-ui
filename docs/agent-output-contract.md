# Agent 对账输出契约

Agent 必须只返回一个合法 JSON 对象，不得添加 Markdown 代码块或说明文字。后端会严格校验；不符合契约的返回会判为对账失败。按飞书需求，Agent 负责完成 A+B 对账：从结算单抽取 A，并调用 ERP/DRP MCP 查询 B；后端只做 JSON、金额算术和飞书落库校验。

## 顶层结构

顶层必须且只能包含以下十二个字段：

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
  "basisReason": "该店结算单净营业额通常按扣点后金额对账",
  "issues": "",
  "period": "2026-08",
  "name": "商城名称或店铺号"
}
```

| 字段 | 类型 | 约束 |
|---|---|---|
| `settlementAmount` | finite number | 结算单中用于对账的金额 |
| `settlementAmountLabel` | string | 必填且非空，结算单中该金额对应的字段名或口径 |
| `salesTotal` | finite number | ERP/DRP MCP 返回的 `sales_total`，扣点前销售额 |
| `netSalesTotal` | finite number | ERP/DRP MCP 返回的 `net_sales_total`，扣点后金额 |
| `erpBasis` | `"sales_total"` / `"net_sales_total"` / `"ambiguous"` | `sales_total` 表示扣点前销售额；`net_sales_total` 表示扣点后金额；无法判断时输出 `ambiguous` |
| `erpAmount` | finite number | `erpBasis=sales_total` 时等于 `salesTotal`；`erpBasis=net_sales_total` 时等于 `netSalesTotal`；`ambiguous` 时取更接近 `settlementAmount` 的一个 |
| `difference` | finite number | 必须等于 `erpAmount - settlementAmount` |
| `matched` | boolean | 只有口径明确且差额绝对值不超过 200 元时才可为 `true` |
| `basisReason` | string | 必填且非空，说明选择该口径的结算单字段、店铺规则或业务证据 |
| `issues` | string | 疑似原因的文字说明；没有疑似原因时必须为 `""` |
| `period` | string | 必填，严格使用 `YYYY-MM`，月份范围为 `01` 至 `12` |
| `name` | string | 必填且非空，必须是本次用于查询 ERP/DRP MCP 的结算主体标识 |

不接受额外顶层字段，不接受 `issues` 数组，也不接受 `period: null`。后端会重新验算 `erpAmount` 和 `difference` 是否与 `erpBasis`、`salesTotal`、`netSalesTotal`、`settlementAmount` 一致。

## 示例

结算单可明确抽取：

```json
{"settlementAmount":100,"settlementAmountLabel":"结算净营业额","salesTotal":120,"netSalesTotal":100,"erpBasis":"net_sales_total","erpAmount":100,"difference":0,"matched":true,"basisReason":"该店规则要求净营业额对扣点后金额。","issues":"","period":"2026-08","name":"SHNKA2"}
```

结算单口径存在疑问：

```json
{"settlementAmount":512047,"settlementAmountLabel":"结算净营业额","salesTotal":530000,"netSalesTotal":512050,"erpBasis":"ambiguous","erpAmount":512050,"difference":3,"matched":false,"basisReason":"结算单同时出现扣点前与扣点后金额，现有店铺规则不足以判断。","issues":"结算单同时出现扣点前与扣点后金额。","period":"2026-08","name":"SHNKA2"}
```

## 实现位置

- JSON 解析与严格校验：`server/src/lib/cherrystudio.ts` 的 `parseAgentResponse()`
- ERP/DRP MCP 查询：由 Agent 在 CherryStudio Session 内执行
- Agent 返回金额验算：`server/src/lib/cherrystudio.ts`
- 结果写入飞书多维表格：`server/src/lib/lark-store.ts` 的 `applyTaskResult()`
- 前后端 Prompt 模板：`src/features/reconciliation/api/prompt.ts` 与 `server/src/services/reconciliation.ts`
