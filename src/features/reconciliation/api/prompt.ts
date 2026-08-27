// 文件说明：保留前端提示词构造契约；业务规则由服务端从飞书知识规则表加载。
import { getReconciliationFileMetadata } from "../model/file-rules";
import type { CreateReconciliationTaskInput } from "../model/types";

export type ReconciliationFileUrls = {
  settlementFileUrl: string;
};

export type ReconciliationPromptPayload = {
  source: "ruili-reconciliation-ui";
  action: "start_reconciliation";
  submittedAt: string;
  files: {
    settlementFile: ReturnType<typeof getReconciliationFileMetadata> & { url: string };
  };
  runtime?: {
    taskWorkDir: string;
    settlementFilePath: string;
    settlementFileName: string;
    shopNo: string;
  };
};

export function createReconciliationPromptPayload(
  input: CreateReconciliationTaskInput,
  fileUrls: ReconciliationFileUrls,
  submittedAt: string,
): ReconciliationPromptPayload {
  return {
    source: "ruili-reconciliation-ui",
    action: "start_reconciliation",
    submittedAt,
    files: {
      settlementFile: {
        ...getReconciliationFileMetadata(input.settlementFile),
        url: fileUrls.settlementFileUrl,
      },
    },
  };
}

export function buildReconciliationPrompt(payload: ReconciliationPromptPayload): string {
  const settlementUrl = payload.files.settlementFile.url;
  const params = payload.runtime ?? {
    taskWorkDir: ".runtime/tasks/current",
    settlementFilePath: settlementUrl,
    settlementFileName: payload.files.settlementFile.name,
    shopNo: "SHNKA2",
  };

  return `我有一个对账任务：

${settlementUrl}
这是结算单

结算单文件名：${params.settlementFileName}
后端已从文件名确定本次店铺号：${params.shopNo}
name 字段请固定输出为该店铺号，不要改写为商场名称、供应商名称或其他别名。

本次任务唯一允许使用的临时工作目录：
${params.taskWorkDir}

如需下载文件、拆分 PDF、渲染图片、执行 OCR 或生成 Markdown/JSON，请只写入上述目录。不要在项目根目录、源码目录或输入文件旁创建文件；不要复制原始文件，优先直接读取以下本地路径：
- 结算单：${params.settlementFilePath}

在过程中，面对图片、PDF 等文件，你可以使用 mineru 这个项目 Subagent 获取 Markdown 格式的内容。
在 Windows 环境执行 Python/MinerU 脚本时，优先使用 PYTHONUTF8=1 PYTHONIOENCODING=utf-8 python ...，不要先调用 WindowsApps 里的 python3 占位命令。

请只从结算单中抽取账期月份和可对账金额。不要读取、计算、猜测或输出 ERP/DRP 金额；ERP 金额会由后端按文件名店铺号查询飞书 Base 明细表并确定性计算。

完成后最后只输出一个合法的 JSON 对象，不要使用 Markdown 代码块，也不要在 JSON 前后输出其他内容。格式例子如下：

{
  "settlementAmount": 100.00,
  "settlementAmountLabel": "结算净营业额",
  "issues": "",
  "period": "XXXX-XX",
  "name": "${params.shopNo}"
}

其中字段类型必须依次为：
- settlementAmount：有限数字，结算单中用于对账的金额
- settlementAmountLabel：非空字符串，结算单中该金额对应的字段名或口径
- issues：字符串；没有内容时输出空字符串
- period: 字符串，对账月份，格式必须为 "YYYY-MM"
- name: 非空字符串，必须等于后端已从文件名确定的店铺号 ${params.shopNo}

字段业务含义、金额口径和适用范围只以本次 Session 中加载的飞书知识规则快照为准；金额或字段缺失时不要编造，后端会拒绝不符合契约的结果。`;
}
