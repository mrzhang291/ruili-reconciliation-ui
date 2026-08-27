import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

function extractPromptTemplate(fileSource) {
  const match = fileSource.match(/return `(我有一个对账任务：[\s\S]*?后端会拒绝不符合契约的结果。)`/);
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
    overview,
    serverTasks,
    serverBatches,
    serverErp,
    erpRecords,
    erpImport,
    serverReviewItems,
    serverFiles,
    reconciliationService,
    promptTemplate,
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
    source("../src/features/reconciliation/components/OverviewView.tsx"),
    source("../server/src/routes/tasks.ts"),
    source("../server/src/routes/batches.ts"),
    source("../server/src/routes/erp.ts"),
    source("../server/src/lib/erp-records.ts"),
    source("../server/src/lib/erp-import.ts"),
    source("../server/src/routes/review-items.ts"),
    source("../server/src/routes/files.ts"),
    source("../server/src/services/reconciliation.ts"),
    source("../src/features/reconciliation/api/prompt.ts"),
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
  assert.match(createTaskSource, /formData\.append\("erpFile", input\.erpFile\)/);
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
  assert.match(httpClient, /listReviewItems/);
  assert.match(serverTasks, /tasksRouter\.get\("\/review-items"/);
  assert.match(serverTasks, /listReviewRecords/);
  assert.match(reviewHook, /reconciliationApi\.updateReviewItem/);
  assert.match(reviewHook, /reconciliationApi\.listReviewItems/);
  assert.doesNotMatch(reviewHook, /reconciliationApi\.listTasks/);
  assert.match(overview, /window\.confirm/);
  assert.match(overview, /record\.name/);
  assert.match(app, /BatchReconciliationView/);
  assert.match(app, /ErpDetailsView/);
  assert.match(app, /ErpImportView/);
  assert.match(app, /erpDirty/);
  assert.match(serverIndex, /batchesRouter/);
  assert.match(serverIndex, /app\.use\("\/api\/batches", batchesRouter\)/);
  assert.match(sidebar, /批量对账/);
  assert.match(sidebar, /ERP 明细/);
  assert.match(sidebar, /新增 ERP/);
  assert.match(topbar, /batch: "批量对账"/);
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
  assert.match(serverBatches, /settlementFileRejectionReason/);
  assert.doesNotMatch(serverBatches, /describeMultiShopErpPreview/);
  assert.match(serverBatches, /sourceFileName/);
  assert.match(serverBatches, /persistNewBatch/);
  assert.match(serverBatches, /createReconciliationTask/);
  assert.match(serverBatches, /agentName 为必填字段/);
  assert.match(serverBatches, /status = "NEEDS_REVIEW"/);
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
  assert.match(reconciliationService, /files\.erp/);
  assert.match(reconciliationService, /parseErpWorkbook/);
  assert.match(reconciliationService, /resolveErpData/);
  assert.match(reconciliationService, /readExcelSettlementDraft/);
  assert.match(reconciliationService, /chooseExcelSettlementCandidate/);
  assert.match(reconciliationService, /queryErpReconciliationData/);
  assert.match(reconciliationService, /buildReconciliationResult/);
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
  assert.match(agentOutputContract, /必须且只能包含以下五个字段/);
  assert.match(agentOutputContract, /不接受 `issues` 数组/);
  assert.match(erpBaseQuery, /"base", "\+record-list"/);
  assert.match(erpBaseQuery, /config\.lark\.erpTableId/);
  assert.match(erpBaseQuery, /ERP销售额/);
  assert.match(erpBaseQuery, /basis: "sales_total"/);
  assert.match(excelSettlement, /openpyxl/);
  assert.match(excelSettlement, /xlrd/);
  assert.match(excelSettlement, /本月结算营业额小计/);
  assert.doesNotMatch(excelSettlement, /salesTotal\) \| Math\.abs/);
  assert.match(reconciliationService, /飞书知识规则快照/);
  assert.match(reconciliationService, /applyTaskResult/);
  assert.doesNotMatch(reconciliationService, /prisma|pg_advisory/i);
  assert.match(promptTemplate, /飞书知识规则快照/);
  assert.match(promptTemplate, /settlementAmountLabel/);
  assert.match(promptTemplate, /不要读取、计算、猜测或输出 ERP\/DRP 金额/);
  assert.match(promptTemplate, /不要先调用 WindowsApps 里的 python3/);
  assert.match(promptTemplate, /格式必须为 "YYYY-MM"/);
  assert.equal(extractPromptTemplate(reconciliationService), extractPromptTemplate(promptTemplate));
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
  assert.match(startAll, /"watch", "src\/index\.ts"/);
  assert.match(startAll, /--restart/);
  assert.match(startAll, /testLark/);
  assert.doesNotMatch(startAll, /SSH_|prisma|postgres/i);
  assert.match(httpClient, /startupRetryDelaysMs/);
  assert.match(serverTasks, /AGENT_NAME_REQUIRED/);
  assert.match(serverTasks, /agentName 为必填字段/);
  assert.match(httpClient, /formData\.append\("agentName", agentName\)/);
  assert.match(startView, /Agent 名称（必填）/);
  assert.match(startView, /required/);
  assert.match(startView, /ERP 来源/);
  assert.match(startView, /上传 ERP/);
  assert.doesNotMatch(startView, /批量结算单文件夹/);
  assert.doesNotMatch(startView, /新增 ERP 总表/);
  assert.match(batchView, /批量结算单文件/);
  assert.match(batchView, /选择多个文件/);
  assert.doesNotMatch(batchView, /webkitdirectory/);
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
