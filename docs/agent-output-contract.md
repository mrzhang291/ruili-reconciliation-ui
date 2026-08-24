# Agent 对账输出契约

Agent 必须只返回一个合法 JSON 对象，不得添加 Markdown 代码块或说明文字。后端会严格校验；不符合契约的返回会判为对账失败。

## 顶层结构

顶层必须且只能包含以下七个字段：

```json
{
  "matched": true,
  "erpAmount": 100,
  "settlementAmount": 100,
  "difference": 0,
  "issues": "",
  "period": "2026-08",
  "name": "京东商城"
}
```

| 字段 | 类型 | 约束 |
|---|---|---|
| `matched` | boolean | `difference` 为 0 时必须为 `true`，否则必须为 `false` |
| `erpAmount` | finite number | ERP/DRP 销售额合计 |
| `settlementAmount` | finite number | 结算单净营业额合计 |
| `difference` | finite number | 固定为 ERP/DRP 销售额合计减结算单净营业额，保留正负号 |
| `issues` | string | 疑似原因的文字说明；没有疑似原因时必须为 `""` |
| `period` | string | 必填，严格使用 `YYYY-MM`，月份范围为 `01` 至 `12` |
| `name` | string | 必填且非空，必须来自 DRP 表单中的商城名称 |

不接受额外顶层字段，不接受 `issues` 数组，也不接受 `period: null`。

## 示例

对账一致：

```json
{"matched":true,"erpAmount":100,"settlementAmount":100,"difference":0,"issues":"","period":"2026-08","name":"京东商城"}
```

存在差异：

```json
{"matched":false,"erpAmount":512042,"settlementAmount":512047,"difference":-5,"issues":"ERP 销售额为 512042 元，结算单净营业额为 512047 元。","period":"2026-08","name":"京东商城"}
```

## 实现位置

- JSON 解析与严格校验：`server/src/lib/cherrystudio.ts` 的 `parseAgentResponse()`
- 结果写入飞书多维表格：`server/src/lib/lark-store.ts` 的 `applyTaskResult()`
- 前后端 Prompt 模板：`src/features/reconciliation/api/prompt.ts` 与 `server/src/services/reconciliation.ts`
