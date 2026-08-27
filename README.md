# 锐力对账

这是一个 Vite + React 对账工作台。任务、审核明细、原始附件、金额和规则都直接存放在飞书多维表格，不再连接远程服务器、SSH、PostgreSQL 或 Prisma。本机 Express 进程只作为前端与 CherryStudio、飞书之间的兼容桥，不承担持久化。

## 运行条件

- Windows 10/11 或 macOS，Node.js 22.13 或更高版本。
- 已安装 `lark-cli`，并已授权全局 profile `aad27213`。
- CherryStudio 企业版已启动 API 服务，并已创建对账 Agent。
- 飞书 Base `PgrCbbHxyaHtQLsNa8ac1gnLn2f` 对当前授权用户可用。

首次使用时运行 `一键启动.ps1`（Windows）或 `一键启动.command`（macOS），然后在“连接设置”中填写 CherryStudio API Key。飞书凭据由 `lark-cli` 的系统安全存储管理，项目不会保存 App Secret 或访问令牌。

启动器会安装依赖、检查飞书授权、启动本机兼容接口和前端，并打开：

- 前端：`http://127.0.0.1:3333/`
- 健康检查：`http://127.0.0.1:3001/api/health?deep=1`

## 飞书数据表

- 知识规则：`tbliMWw8XUfbWmuX`
- 对账任务：`tblrpKbGxi38PnIU`
- 审核明细：`tblrlpUs9nlY0dCW`
- ERP 明细：`tblx7K2MXNLintEO`
- 批处理汇总：按表名自动定位或首次预检自动创建，默认表名 `批处理汇总表`
- 批量结算单明细：按表名自动定位或首次预检自动创建，默认表名 `批量结算单明细表`

任务创建后，结算单原始文件立即上传到任务表附件字段；如果本次上传了 ERP Excel，也会保存到任务表 `ERP文件` 附件字段并优先用于本次金额计算。本机只在上传和 Agent 运行期间保留临时副本，任务结束后自动清理；历史文件下载直接从飞书附件读取。未上传本次 ERP 文件时，后端按店铺号和账期查询飞书 ERP 明细表后计算金额。

新的 ERP 总表在侧栏“新增 ERP”入口上传。前端先调用 `POST /api/erp/import` 预览文件内月份、行数、已有记录数、销售额汇总、样例明细和失败行；导入时只保留 `店铺号`、`扣点`、`销售额`、`月份` 四个字段，忽略商城名称和供货商编码。确认后可用同一接口的 `append` 模式按唯一键追加/覆盖到飞书 ERP 明细表，或用 `replace` 模式按月份永久删除旧明细后重建。唯一键为 `店铺号 + 扣点 + 月份`；Excel 内部如果出现重复唯一键，整次导入会被拦截并返回重复行号。

“ERP 明细”页面直接维护飞书表 `tblx7K2MXNLintEO`，支持按月份和店铺号查询，按月份、店铺号、扣点、销售额排序，新增、编辑、批量保存行内修改和永久删除。新增、编辑和删除只影响后续对账，不会自动重算历史任务。

## 对账流程

1. 前端通过 `POST /api/tasks` 上传结算资料，可选上传本次 ERP Excel。
2. 本机兼容接口在飞书任务表创建记录，并上传结算单附件。
3. 每次任务从飞书知识规则表读取快照，再创建独立 CherryStudio Session。
4. Agent 只返回结算单抽取 JSON：`settlementAmount`、`settlementAmountLabel`、`issues`、`period`、`name`，其中 `name` 必须优先输出店铺号。
5. 后端优先从本次 ERP Excel 查询 `店铺号 + period`；未上传时查飞书 ERP 明细表，汇总扣点前/扣点后销售额，并固定用扣点前 `ERP销售额` 写入 `ERP金额`。
6. 金额写入飞书后，由飞书公式字段计算权威差额并校验差额；有差异时写入审核明细表。
7. 列表、详情、统计、审核、下载和删除操作均以飞书 Base 为数据源。

## 批量对账

批量入口使用真实批次模型，不再调用旧的 `/api/tasks/batch` 循环创建单任务。

1. `POST /api/batches` 上传结算单文件夹和可选本批次 ERP Excel，后端创建批处理汇总记录、批量结算单明细记录，并保存源文件附件。
2. 预检按文件名店铺号和账期查询 ERP；Excel 会本地读取金额候选，候选金额不唯一或没有候选时必须人工确认。
3. PDF/图片在批量模式下不会让 Agent 代选金额，必须先在单据视图手工填入确认金额，避免多个候选金额被模型误判。
4. 单据视图支持补店铺号、补账期、选择金额候选或手填金额；每次人工修改都会生成新的 `v2/v3` 版本组。
5. `POST /api/batches/:id/execute` 只执行可执行组，每组创建一条对账任务，并把组内确认金额合计与确定性 ERP 金额对账。
6. `GET /api/batches/:id/export` 导出批次 CSV，包含批次、组、单据、金额、差额、任务和版本信息。

## 手动启动

```powershell
npm ci
cd server
npm ci
npm run dev
```

另开终端，在项目根目录执行：

```powershell
npm run dev
```

## 配置

前端：

```env
VITE_API_BASE_URL=http://127.0.0.1:3001
```

后端可配置项见 `server/.env.example`，主要包括 CherryStudio 地址、飞书 Base/table token 和本机端口。不要把 CherryStudio API Key、飞书 App Secret 或访问令牌写入仓库。

## 检查

```powershell
npm test
npm run typecheck
npm run lint
cd server
npm run build
```

服务默认只监听 `127.0.0.1`，并仅接受本机前端来源。
