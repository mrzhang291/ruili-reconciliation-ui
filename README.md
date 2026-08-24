# 锐力对账

这是一个 Vite + React 对账工作台。现有页面和 HTTP 接口保持不变，但任务、审核明细、原始附件、金额和规则都直接存放在飞书多维表格，不再连接远程服务器、SSH、PostgreSQL 或 Prisma。本机 Express 进程只作为现有前端与 CherryStudio、飞书之间的兼容桥，不承担持久化。

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

任务创建后，两份原始文件立即上传到任务表附件字段。本机只在上传和 Agent 运行期间保留临时副本，任务结束后自动清理；历史文件下载直接从飞书附件读取。

## 对账流程

1. 前端沿用 `POST /api/tasks` 上传结算资料与 ERP 资料。
2. 本机兼容接口在飞书任务表创建记录，并上传原始附件。
3. 每次任务从飞书知识规则表读取快照，再创建独立 CherryStudio Session。
4. Agent 返回七字段严格 JSON：`matched`、`erpAmount`、`settlementAmount`、`difference`、`issues`、`period`、`name`。
5. 金额写入飞书后，由飞书公式字段计算权威差额并校验 Agent 差额；有差异时写入审核明细表。
6. 列表、详情、统计、审核、下载和删除操作均以飞书 Base 为数据源。

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
