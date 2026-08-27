# Agent 结算单抽取契约

Agent 必须只返回一个合法 JSON 对象，不得添加 Markdown 代码块或说明文字。后端会严格校验；不符合契约的返回会判为对账失败。ERP/DRP 金额不再由 Agent 读取、计算或输出。

## 顶层结构

顶层必须且只能包含以下五个字段：

```json
{
  "settlementAmount": 100,
  "settlementAmountLabel": "结算净营业额",
  "issues": "",
  "period": "2026-08",
  "name": "SHNKA2"
}
```

| 字段 | 类型 | 约束 |
|---|---|---|
| `settlementAmount` | finite number | 结算单中用于对账的金额 |
| `settlementAmountLabel` | string | 必填且非空，结算单中该金额对应的字段名或口径 |
| `issues` | string | 疑似原因的文字说明；没有疑似原因时必须为 `""` |
| `period` | string | 必填，严格使用 `YYYY-MM`，月份范围为 `01` 至 `12` |
| `name` | string | 必填且非空，必须输出文件名中的店铺号；后端会以文件名店铺号作为最终匹配依据 |

不接受额外顶层字段，不接受 `issues` 数组，也不接受 `period: null`。不接受 `matched`、`erpAmount` 或 `difference`。

## 示例

结算单可明确抽取：

```json
{"settlementAmount":100,"settlementAmountLabel":"结算净营业额","issues":"","period":"2026-08","name":"SHNKA2"}
```

结算单口径存在疑问：

```json
{"settlementAmount":512047,"settlementAmountLabel":"结算净营业额","issues":"结算单同时出现扣点前与扣点后金额，已按规则采用结算净营业额。","period":"2026-08","name":"SHNKA2"}
```

## 实现位置

- JSON 解析与严格校验：`server/src/lib/cherrystudio.ts` 的 `parseAgentResponse()`
- ERP 明细查询与金额口径选择：`server/src/lib/erp-base-query.ts`
- 结果写入飞书多维表格：`server/src/lib/lark-store.ts` 的 `applyTaskResult()`
- 前后端 Prompt 模板：`src/features/reconciliation/api/prompt.ts` 与 `server/src/services/reconciliation.ts`
