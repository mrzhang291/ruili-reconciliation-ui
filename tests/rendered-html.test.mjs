import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

function extractPromptTemplate(fileSource) {
  const match = fileSource.match(/return `(我有一个对账任务：[\s\S]*?不得自行采用服务器内置口径。)`/);
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
    taskProvider,
    startView,
    processLogPanel,
    modelTypes,
    reviewHook,
    overview,
    serverTasks,
    serverReviewItems,
    serverFiles,
    reconciliationService,
    promptTemplate,
    cherryStudio,
    larkKnowledge,
    larkCli,
    taskProgress,
    agentOutputContract,
    larkStore,
    startAll,
  ] = await Promise.all([
    source("../src/features/reconciliation/api/index.ts"),
    source("../src/features/reconciliation/api/http-client.ts"),
    source("../src/features/reconciliation/hooks/ReconciliationTaskProvider.tsx"),
    source("../src/features/reconciliation/components/StartView.tsx"),
    source("../src/features/reconciliation/components/ProcessLogPanel.tsx"),
    source("../src/features/reconciliation/model/types.ts"),
    source("../src/features/reconciliation/hooks/use-review-items.ts"),
    source("../src/features/reconciliation/components/OverviewView.tsx"),
    source("../server/src/routes/tasks.ts"),
    source("../server/src/routes/review-items.ts"),
    source("../server/src/routes/files.ts"),
    source("../server/src/services/reconciliation.ts"),
    source("../src/features/reconciliation/api/prompt.ts"),
    source("../server/src/lib/cherrystudio.ts"),
    source("../server/src/lib/lark-knowledge.ts"),
    source("../server/src/lib/lark-cli.ts"),
    source("../server/src/lib/task-progress.ts"),
    source("../docs/agent-output-contract.md"),
    source("../server/src/lib/lark-store.ts"),
    source("../scripts/start-all.mjs"),
  ]);

  assert.match(apiEntry, /VITE_API_BASE_URL/);
  assert.match(apiEntry, /HttpReconciliationApi/);
  assert.match(httpClient, /FormData/);
  assert.match(httpClient, /settlementFile/);
  assert.match(httpClient, /erpFile/);
  assert.match(httpClient, /updateReviewItem/);
  assert.match(httpClient, /deleteTask/);
  assert.match(httpClient, /stopTask/);
  assert.match(httpClient, /\/stop/);
  assert.match(httpClient, /method: "DELETE"/);
  assert.match(taskProvider, /progressLogs/);
  assert.match(taskProvider, /pollIntervalMs/);
  assert.match(taskProvider, /`local:\$\{\+\+logIdRef\.current\}`/);
  assert.match(taskProvider, /findIndex\(\(item\) => item\.id === log\.id\)/);
  assert.doesNotMatch(taskProvider, /seenServerLogIds|seenIds\.has/);
  assert.match(processLogPanel, /<details className="process-log__message" open=\{log\.expanded\}>/);
  assert.match(processLogPanel, /<pre>\{log\.details\}<\/pre>/);
  assert.match(processLogPanel, /\[logs, collapsed\]/);
  assert.match(modelTypes, /details\?: string/);
  assert.match(modelTypes, /expanded\?: boolean/);
  assert.doesNotMatch(modelTypes, /apiKey: string/);
  assert.match(reviewHook, /reconciliationApi\.updateReviewItem/);
  assert.match(reviewHook, /\["NEEDS_REVIEW", "REVIEWED"\]/);
  assert.match(overview, /window\.confirm/);
  assert.match(overview, /record\.name/);

  assert.match(serverTasks, /status\(202\)/);
  assert.match(serverTasks, /getTaskProgress/);
  assert.match(serverTasks, /tasksRouter\.delete/);
  assert.match(serverTasks, /tasksRouter\.post\("\/:id\/stop"/);
  assert.match(serverTasks, /deleteTaskRecord/);
  assert.match(serverTasks, /listTaskRecords/);
  assert.match(serverFiles, /toUpperCase\(\)/);
  assert.match(reconciliationService, /files\/SETTLEMENT/);
  assert.match(reconciliationService, /files\/ERP/);
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
  assert.match(cherryStudio, /reasoningId \?\?= crypto\.randomUUID\(\)/);
  assert.match(cherryStudio, /details: rawDetail\(event\.input\)/);
  assert.match(cherryStudio, /details: rawDetail\(event\.output\)/);
  assert.match(taskProgress, /findIndex\(\(item\) => item\.id === log\.id\)/);
  assert.match(taskProgress, /maxLogsPerTask = 300/);
  assert.match(agentOutputContract, /必须且只能包含以下七个字段/);
  assert.match(agentOutputContract, /不接受 `issues` 数组/);
  assert.match(reconciliationService, /飞书知识规则快照/);
  assert.doesNotMatch(reconciliationService, /ERP 金额 - 结算单金额|drp表单中的商城名称/);
  assert.match(reconciliationService, /applyTaskResult/);
  assert.doesNotMatch(reconciliationService, /prisma|pg_advisory/i);
  assert.match(promptTemplate, /飞书知识规则快照/);
  assert.match(promptTemplate, /"issues": ""/);
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
  assert.match(startAll, /testLark/);
  assert.doesNotMatch(startAll, /SSH_|prisma|postgres/i);
  assert.match(httpClient, /startupRetryDelaysMs/);
  assert.match(serverTasks, /AGENT_NAME_REQUIRED/);
  assert.match(serverTasks, /agentName 为必填字段/);
  assert.match(httpClient, /formData\.append\("agentName", agentName\)/);
  assert.match(startView, /Agent 名称（必填）/);
  assert.match(startView, /required/);
});
