import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

function extractPromptTemplate(fileSource) {
  const match = fileSource.match(/return `(我有一个对账任务：[\s\S]*?其他不符合契约的结果仍会被后端拒绝。)`;/);
  assert.ok(match, "未找到对账 Prompt 模板");
  return match[1].replaceAll("\r\n", "\n");
}

async function readBuiltClient() {
  const assetsDirectory = new URL("../dist/assets/", import.meta.url);
  const assetNames = await readdir(assetsDirectory);
  const scripts = await Promise.all(
    assetNames
      .filter((assetName) => assetName.endsWith(".js"))
      .map((assetName) => readFile(new URL(assetName, assetsDirectory), "utf8")),
  );
  return scripts.join("\n");
}

test("builds the Vite reconciliation shell", async () => {
  const html = await source("../dist/index.html");
  const client = await readBuiltClient();

  assert.match(html, /<div id="root"><\/div>/);
  assert.match(html, /<title>锐力对账｜财务协同工作台<\/title>/);
  assert.match(html, /\/assets\/index-[^"]+\.js/);
  assert.doesNotMatch(html, /vinext|cloudflare|worker/i);
  assert.doesNotMatch(client, /vinext|cloudflare|wrangler|next\/headers|next\/font/i);
});

test("routes reconciliation through the HTTP backend", async () => {
  const [
    apiEntry,
    httpClient,
    app,
    serverIndex,
    sidebar,
    topbar,
    taskProvider,
    startView,
    batchView,
    erpDetailsView,
    erpImportView,
    processLogPanel,
    modelTypes,
    reviewHook,
    reviewWorklistHook,
    reviewView,
    mailboxView,
    qqMailClient,
    overview,
    serverTasks,
    serverBatches,
    serverErp,
    erpRecords,
    erpImport,
    serverReviewItems,
    serverFiles,
    serverMail,
    reconciliationService,
    qqMail,
    serverConfig,
    cherryStudio,
    erpBaseQuery,
    excelSettlement,
    settlementFileRules,
    larkKnowledge,
    larkCli,
    taskProgress,
    agentOutputContract,
    larkStore,
    startAll,
  ] = await Promise.all([
    source("../src/features/reconciliation/api/index.ts"),
    source("../src/features/reconciliation/api/http-client.ts"),
    source("../src/app/App.tsx"),
    source("../server/src/index.ts"),
    source("../src/features/reconciliation/components/AppSidebar.tsx"),
    source("../src/features/reconciliation/components/AppTopbar.tsx"),
    source("../src/features/reconciliation/hooks/ReconciliationTaskProvider.tsx"),
    source("../src/features/reconciliation/components/StartView.tsx"),
    source("../src/features/reconciliation/components/BatchReconciliationView.tsx"),
    source("../src/features/reconciliation/components/ErpDetailsView.tsx"),
    source("../src/features/reconciliation/components/ErpImportView.tsx"),
    source("../src/features/reconciliation/components/ProcessLogPanel.tsx"),
    source("../src/features/reconciliation/model/types.ts"),
    source("../src/features/reconciliation/hooks/use-review-items.ts"),
    source("../src/features/reconciliation/hooks/use-review-worklist.ts"),
    source("../src/features/reconciliation/components/ReviewView.tsx"),
    source("../src/features/reconciliation/components/MailboxView.tsx"),
    source("../src/features/reconciliation/api/qq-mail-client.ts"),
    source("../src/features/reconciliation/components/OverviewView.tsx"),
    source("../server/src/routes/tasks.ts"),
    source("../server/src/routes/batches.ts"),
    source("../server/src/routes/erp.ts"),
    source("../server/src/lib/erp-records.ts"),
    source("../server/src/lib/erp-import.ts"),
    source("../server/src/routes/review-items.ts"),
    source("../server/src/routes/files.ts"),
    source("../server/src/routes/mail.ts"),
    source("../server/src/services/reconciliation.ts"),
    source("../server/src/lib/qq-mail.ts"),
    source("../server/src/lib/config.ts"),
    source("../server/src/lib/cherrystudio.ts"),
    source("../server/src/lib/erp-base-query.ts"),
    source("../server/src/lib/excel-settlement.ts"),
    source("../server/src/lib/settlement-file-rules.ts"),
    source("../server/src/lib/lark-knowledge.ts"),
    source("../server/src/lib/lark-cli.ts"),
    source("../server/src/lib/task-progress.ts"),
    source("../docs/agent-output-contract.md"),
    source("../server/src/lib/lark-store.ts"),
    source("../scripts/start-all.mjs"),
  ]);

  assert.match(apiEntry, /VITE_API_BASE_URL/);
  assert.match(apiEntry, /HttpReconciliationApi/);
  const createTaskSource = httpClient.match(/async createTask[\s\S]*?return placeholder;/)?.[0] ?? "";
  assert.match(httpClient, /FormData/);
  assert.match(httpClient, /settlementFile/);
  assert.match(httpClient, /createBatchTasks/);
  assert.match(httpClient, /precheckBatch/);
  assert.match(httpClient, /getBatch/);
  assert.match(httpClient, /updateBatchDocumentIdentity/);
  assert.match(httpClient, /selectBatchDocumentAmount/);
  assert.match(httpClient, /exportBatchCsv/);
  assert.match(httpClient, /settlementFiles/);
  assert.match(httpClient, /\/api\/batches/);
  assert.match(httpClient, /\/execute/);
  assert.doesNotMatch(httpClient, /\/api\/tasks\/batch/);
  assert.doesNotMatch(createTaskSource, /formData\.append\("erpFile"/);
  assert.match(httpClient, /\/api\/erp\/import/);
  assert.match(httpClient, /formData\.append\("erpFile", input\.file\)/);
  assert.match(httpClient, /updateReviewItem/);
  assert.match(httpClient, /listErpRecords/);
  assert.match(httpClient, /batchUpdateErpRecords/);
  assert.match(httpClient, /deleteErpRecord/);
  assert.match(httpClient, /deleteTask/);
  assert.match(httpClient, /stopTask/);
  assert.match(httpClient, /\/stop/);
  assert.match(httpClient, /method: "DELETE"/);
  assert.match(taskProvider, /progressLogs/);
  assert.match(taskProvider, /pollIntervalMs/);
  assert.match(taskProvider, /activeTaskIds/);
  assert.match(taskProvider, /startBatchReconciliation/);
  assert.match(taskProvider, /batchId/);
  assert.match(taskProvider, /`local:\$\{\+\+logIdRef\.current\}`/);
  assert.match(taskProvider, /findIndex\(\(item\) => item\.id === log\.id\)/);
  assert.doesNotMatch(taskProvider, /seenServerLogIds|seenIds\.has/);
  assert.match(processLogPanel, /<details className="process-log__message" open=\{log\.expanded\}>/);
  assert.match(processLogPanel, /<pre>\{log\.details\}<\/pre>/);
  assert.match(processLogPanel, /\[logs, collapsed\]/);
  assert.match(modelTypes, /details\?: string/);
  assert.match(modelTypes, /expanded\?: boolean/);
  assert.match(modelTypes, /CreateBatchReconciliationTasksInput/);
  assert.match(modelTypes, /BatchGroupSummary/);
  assert.match(modelTypes, /BatchAmountCandidate/);
  assert.doesNotMatch(modelTypes, /apiKey: string/);
  assert.match(modelTypes, /ReconciliationReviewRow/);
  assert.match(modelTypes, /ReconciliationReviewWorklistRow/);
  assert.match(httpClient, /listReviewItems/);
  assert.match(httpClient, /listReviewWorklist/);
  assert.match(httpClient, /review-items\/worklist/);
  const worklistSource = httpClient.match(/async listReviewWorklist[\s\S]*?\n {2}}\n\n {2}async getTask/)?.[0] ?? "";
  assert.match(worklistSource, /cache: "no-store"/);
  assert.doesNotMatch(worklistSource, /this\.cached\(/);
  assert.match(httpClient, /exportReviewCsv/);
  assert.match(serverTasks, /tasksRouter\.get\("\/review-items"/);
  assert.match(serverTasks, /review-items\/worklist/);
  assert.match(serverTasks, /buildReviewWorklist/);
  assert.match(serverTasks, /review-items\/export/);
  assert.match(serverTasks, /业务结论/);
  assert.match(serverTasks, /Cache-Control", "no-store/);
  assert.match(serverTasks, /listReviewRecords/);
  assert.match(reviewHook, /reconciliationApi\.updateReviewItem/);
  assert.match(reviewHook, /reconciliationApi\.listReviewItems/);
  assert.match(reviewHook, /reconciliationApi\.listReviewWorklist/);
  assert.match(reviewHook, /Promise\.allSettled/);
  assert.match(reviewWorklistHook, /reconciliationApi\.listReviewWorklist/);
  assert.match(reviewWorklistHook, /refreshWorklist/);
  assert.match(reviewWorklistHook, /latestLoadIdRef/);
  assert.doesNotMatch(reviewWorklistHook, /updateReviewItem/);
  assert.match(reviewView, /差异处理/);
  assert.match(reviewView, /review-table/);
  assert.match(reviewView, /处理状态/);
  assert.match(reviewView, /setReviewStatus/);
  assert.match(reviewView, /查看沟通话术/);
  assert.match(reviewView, /communication\.confirmation\.communicationTemplate/);
  assert.match(reviewView, /copyCommunicationTemplate/);
  assert.match(reviewView, /reconciliationApi\.exportReviewCsv/);
  assert.match(reviewView, /reviewRegion/);
  assert.match(reviewView, /statusFilter/);
  assert.match(reviewView, /计算差额（元）/);
  assert.match(reviewView, /filteredRows/);
  assert.match(reviewView, /导出筛选结果/);
  assert.match(reviewView, /differenceRangeError/);
  assert.match(reviewView, /hasReviewStatusUpdates/);
  assert.match(reviewView, /isReviewStatusUpdating\(\)/);
  assert.match(reviewView, /region === "其他" \? "OTHER"/);
  assert.match(reviewHook, /updatingItemCounts/);
  assert.match(reviewHook, /updatingItemCountsRef/);
  assert.match(httpClient, /errorPayload\?\.error\?\.message/);
  assert.match(httpClient, /errorPayload\?\.error\?\.requestId/);
  assert.match(mailboxView, /QQ 邮箱/);
  assert.match(mailboxView, /SMTP 授权码/);
  assert.match(mailboxView, /statusRequestRevisionRef/);
  assert.match(mailboxView, /const persistedStatus = await qqMailApi\.getStatus\(\)/);
  assert.match(mailboxView, /saveRevision !== statusRequestRevisionRef\.current/);
  assert.match(mailboxView, /未能确认 QQ 发件设置已保存/);
  assert.match(mailboxView, /qqMailApi\.prepare/);
  assert.match(mailboxView, /qqMailApi\.send/);
  assert.match(mailboxView, /window\.confirm/);
  assert.match(mailboxView, /打开 QQ 邮箱/);
  assert.match(qqMailClient, /\/api\/mail\/qq\/status/);
  assert.match(qqMailClient, /authorizationCode/);
  assert.doesNotMatch(qqMailClient, /localStorage|sessionStorage/);
  assert.match(serverMail, /mailRouter\.post\("\/qq\/configuration"/);
  assert.match(serverMail, /mailRouter\.post\("\/qq\/prepare"/);
  assert.match(serverMail, /mailRouter\.post\("\/qq\/send"/);
  assert.match(serverMail, /isLoopbackAddress/);
  assert.match(serverConfig, /host: "smtp\.qq\.com"/);
  assert.match(qqMail, /windows-credential-manager/);
  assert.match(qqMail, /tls\.connect/);
  assert.match(qqMail, /QQ_MAIL_INVALID_RECIPIENTS/);
  assert.match(qqMail, /buildQqSmtpData/);
  assert.match(httpClient, /differenceMin/);
  assert.match(httpClient, /filters\.status/);
  assert.doesNotMatch(reviewHook, /reconciliationApi\.listTasks/);
  assert.match(overview, /window\.confirm/);
  assert.match(overview, /record\.name/);
  assert.match(overview, /ERP金额/);
  assert.match(overview, /待确认/);
  assert.match(app, /BatchReconciliationView/);
  assert.match(app, /ErpDetailsView/);
  assert.match(app, /ErpImportView/);
  assert.match(app, /MailboxView/);
  assert.doesNotMatch(app, /reviewFollowUp/);
  assert.match(app, /erpDirty/);
  assert.match(serverIndex, /batchesRouter/);
  assert.match(serverIndex, /app\.use\("\/api\/batches", batchesRouter\)/);
  assert.match(serverIndex, /app\.use\("\/api\/mail", mailRouter\)/);
  assert.match(sidebar, /批量对账/);
  assert.match(sidebar, /差异处理/);
  assert.match(sidebar, /QQ 邮箱/);
  assert.match(sidebar, /ERP 明细/);
  assert.match(sidebar, /新增 ERP/);
  assert.match(topbar, /batch: "批量对账"/);
  assert.match(topbar, /review: "差异处理"/);
  assert.match(topbar, /mail: "QQ 邮箱"/);
  assert.match(topbar, /erp: "ERP 明细"/);
  assert.match(topbar, /erpImport: "新增 ERP"/);
  assert.match(erpDetailsView, /保存全部/);
  assert.match(erpDetailsView, /batchUpdateErpRecords/);
  assert.match(erpDetailsView, /永久删除这条 ERP 明细/);
  assert.match(erpDetailsView, /beforeunload/);

  assert.match(serverTasks, /status\(202\)/);
  assert.doesNotMatch(serverTasks, /tasksRouter\.post\("\/batch"/);
  assert.match(serverBatches, /batchesRouter\.post\("\/"/);
  assert.match(serverBatches, /batchesRouter\.post\("\/:id\/execute"/);
  assert.match(serverBatches, /batchesRouter\.patch\("\/documents\/:documentId\/identity"/);
  assert.match(serverBatches, /batchesRouter\.patch\("\/documents\/:documentId\/amount"/);
  assert.match(serverBatches, /batchesRouter\.get\("\/:id\/export"/);
  assert.match(serverBatches, /readExcelSettlementDocuments/);
  assert.match(serverBatches, /settlementFileHardRejectionReason/);
  assert.doesNotMatch(serverBatches, /describeMultiShopErpPreview/);
  assert.match(serverBatches, /sourceFileName/);
  assert.match(serverBatches, /persistNewBatch/);
  assert.match(serverBatches, /createReconciliationTask/);
  assert.match(serverBatches, /agentName 为必填字段/);
  assert.match(serverBatches, /settlementHint/);
  assert.match(serverBatches, /ERP_FILE_NOT_ALLOWED/);
  assert.match(serverBatches, /sha256/);
  assert.doesNotMatch(serverBatches, /非 Excel 批量单据需要人工确认金额/);
  assert.match(serverTasks, /getTaskProgress/);
  assert.match(serverTasks, /tasksRouter\.delete/);
  assert.match(serverTasks, /tasksRouter\.post\("\/:id\/stop"/);
  assert.match(serverTasks, /deleteTaskRecord/);
  assert.match(serverTasks, /listTaskRecords/);
  assert.match(serverTasks, /NOT_SETTLEMENT_FILE/);
  assert.match(settlementFileRules, /扣款明细/);
  assert.match(settlementFileRules, /多个店铺号/);
  assert.match(serverFiles, /toUpperCase\(\)/);
  assert.match(reconciliationService, /files\/SETTLEMENT/);
  assert.doesNotMatch(reconciliationService, /files\.erp/);
  assert.doesNotMatch(reconciliationService, /parseErpWorkbook/);
  assert.doesNotMatch(reconciliationService, /resolveErpData/);
  assert.doesNotMatch(reconciliationService, /readExcelSettlementDraft/);
  assert.doesNotMatch(reconciliationService, /chooseExcelSettlementCandidate/);
  assert.doesNotMatch(reconciliationService, /queryErpReconciliationData/);
  assert.doesNotMatch(reconciliationService, /buildReconciliationResult/);
  assert.match(reconciliationService, /本地 MCP JSON-RPC 命令/);
  assert.match(reconciliationService, /onSettled/);
  assert.doesNotMatch(reconciliationService, /createReconciliationGroupTask/);
  assert.doesNotMatch(reconciliationService, /deterministic_batch_group/);
  assert.doesNotMatch(reconciliationService, /attemptCount >= 3/);
  assert.doesNotMatch(reconciliationService, /RETRY_LIMIT_REACHED/);
  assert.doesNotMatch(reconciliationService, /data:\s*\{\s*status:\s*TaskStatus\.OBSOLETE/);
  assert.match(serverReviewItems, /updateReviewRecord/);
  assert.doesNotMatch(serverReviewItems, /prisma|pg_advisory/i);
  assert.match(cherryStudio, /createAgentSession/);
  assert.match(cherryStudio, /method: "POST"/);
  assert.match(cherryStudio, /buildReconciliationSessionName/);
  assert.match(cherryStudio, /AbortSignal\.timeout/);
  assert.doesNotMatch(cherryStudio, /normalizeDifferenceDirection|extractSalesAmountDifference/);
  assert.match(cherryStudio, /extractTaskName/);
  assert.match(cherryStudio, /settlementAmountLabel/);
  assert.match(cherryStudio, /reasoningId \?\?= crypto\.randomUUID\(\)/);
  assert.match(cherryStudio, /details: rawDetail\(event\.input\)/);
  assert.match(cherryStudio, /details: rawDetail\(event\.output\)/);
  assert.match(taskProgress, /findIndex\(\(item\) => item\.id === log\.id\)/);
  assert.match(taskProgress, /maxLogsPerTask = 300/);
  assert.match(agentOutputContract, /必须且只能包含以下十二个字段/);
  assert.match(agentOutputContract, /不接受 `issues` 数组/);
  assert.match(agentOutputContract, /erpBasis/);
  assert.match(agentOutputContract, /salesTotal/);
  assert.match(agentOutputContract, /matched/);
  assert.match(agentOutputContract, /basisReason/);
  assert.match(erpBaseQuery, /"base", "\+record-list"/);
  assert.match(erpBaseQuery, /config\.lark\.erpTableId/);
  assert.match(erpBaseQuery, /calculateErpTotals/);
  assert.doesNotMatch(erpBaseQuery, /buildReconciliationResult/);
  assert.doesNotMatch(erpBaseQuery, /chooseErpBasis/);
  assert.match(excelSettlement, /openpyxl/);
  assert.match(excelSettlement, /xlrd/);
  assert.match(excelSettlement, /本月结算营业额小计/);
  assert.doesNotMatch(excelSettlement, /salesTotal\) \| Math\.abs/);
  assert.match(reconciliationService, /飞书知识规则快照/);
  assert.match(reconciliationService, /applyTaskResult/);
  assert.doesNotMatch(reconciliationService, /prisma|pg_advisory/i);
  const serverPrompt = extractPromptTemplate(reconciliationService);
  for (const pattern of [
    /本地 MCP JSON-RPC/,
    /wd3FCVOL5nMNLODNeRfOr/,
    /summarize_store_period/,
    /不要交给 Subagent/,
    /salesTotal/,
    /netSalesTotal/,
    /matched/,
    /格式必须为 "YYYY-MM"/,
  ]) {
    assert.match(serverPrompt, pattern);
  }
  assert.match(serverPrompt, /本地服务脚本/);
  assert.match(serverPrompt, /不要调用 CherryStudio 原生工具列表/);
  assert.match(serverPrompt, /\$\{mcpCommand\}/);
  assert.doesNotMatch(httpClient, /buildReconciliationPrompt|本地 MCP JSON-RPC|summarize_store_period/);
  assert.match(larkKnowledge, /runLarkCli/);
  assert.match(larkCli, /"--profile", config\.lark\.profile/);
  assert.match(larkKnowledge, /"base", "\+record-list"/);
  assert.match(larkKnowledge, /"--as", "user"/);
  assert.match(larkKnowledge, /状态.*启用/s);

  assert.match(larkStore, /"base", "\+record-upsert"/);
  assert.match(larkStore, /"base", "\+record-upload-attachment"/);
  assert.match(larkStore, /"base", "\+record-download-attachment"/);
  assert.match(larkStore, /getTaskStatistics/);
  assert.doesNotMatch(larkStore, /prisma|postgres/i);
  assert.match(startAll, /npm-cli\.js/);
  assert.match(startAll, /"vite", "bin", "vite\.js"/);
  assert.match(startAll, /"dist", "index\.js"/);
  assert.doesNotMatch(startAll, /"watch", "src\/index\.ts"/);
  assert.match(startAll, /--restart/);
  assert.match(startAll, /testLark/);
  assert.doesNotMatch(startAll, /SSH_|prisma|postgres/i);
  assert.match(httpClient, /startupRetryDelaysMs/);
  assert.match(serverTasks, /AGENT_NAME_REQUIRED/);
  assert.match(serverTasks, /agentName 为必填字段/);
  assert.match(httpClient, /formData\.append\("agentName", agentName\)/);
  assert.match(startView, /Agent 名称（必填）/);
  assert.match(startView, /required/);
  assert.match(startView, /ERP\/DRP 数据源/);
  assert.match(startView, /MCP 查询/);
  assert.doesNotMatch(startView, /上传 ERP/);
  assert.doesNotMatch(startView, /批量结算单文件夹/);
  assert.doesNotMatch(startView, /新增 ERP 总表/);
  assert.match(batchView, /批量结算单文件/);
  assert.match(batchView, /选择多个文件/);
  assert.doesNotMatch(batchView, /webkitdirectory/);
  assert.match(batchView, /ERP\/DRP 数据源/);
  assert.doesNotMatch(batchView, /上传 ERP/);
  assert.match(batchView, /startBatchReconciliation/);
  assert.match(batchView, /开始预检/);
  assert.match(batchView, /确认执行/);
  assert.match(batchView, /batch-precheck-table/);
  assert.match(batchView, /组视图/);
  assert.match(batchView, /单据视图/);
  assert.match(batchView, /selectBatchDocumentAmount/);
  assert.match(batchView, /updateBatchDocumentIdentity/);
  assert.match(batchView, /导出 CSV/);
  assert.match(erpImportView, /新增 ERP 总表/);
  assert.match(erpImportView, /importErpFile/);
  assert.match(erpImportView, /追加到总表/);
  assert.match(erpImportView, /erp-preview-table/);
  assert.match(erpImportView, /确认替换并永久删除旧记录/);
  assert.match(serverErp, /erpRouter\.post\("\/import"/);
  assert.match(serverErp, /erpRouter\.get\("\/"/);
  assert.match(serverErp, /erpRouter\.post\("\/batch-update"/);
  assert.match(serverErp, /erpRouter\.delete\("\/:id"/);
  assert.match(erpRecords, /该 ERP 明细已存在/);
  assert.match(erpRecords, /\+record-delete/);
  assert.match(serverErp, /mode 只支持 preview、append 或 replace/);
  assert.match(serverErp, /importErpWorkbook/);
  assert.match(erpImport, /ERP_IMPORT_DUPLICATE_KEYS/);
  assert.match(erpImport, /summary\.updatedRows/);
});
