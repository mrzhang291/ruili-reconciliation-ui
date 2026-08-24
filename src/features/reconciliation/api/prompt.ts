// 文件说明：保留前端提示词构造契约；业务规则由服务端从飞书知识规则表加载。
import { getReconciliationFileMetadata } from "../model/file-rules";
import type { CreateReconciliationTaskInput } from "../model/types";

export type ReconciliationFileUrls = {
  settlementFileUrl: string;
  erpFileUrl: string;
};

export type ReconciliationPromptPayload = {
  source: "ruili-reconciliation-ui";
  action: "start_reconciliation";
  submittedAt: string;
  files: {
    settlementFile: ReturnType<typeof getReconciliationFileMetadata> & { url: string };
    erpFile: ReturnType<typeof getReconciliationFileMetadata> & { url: string };
  };
  runtime?: {
    taskWorkDir: string;
    settlementFilePath: string;
    erpFilePath: string;
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
      erpFile: {
        ...getReconciliationFileMetadata(input.erpFile),
        url: fileUrls.erpFileUrl,
      },
    },
  };
}

export function buildReconciliationPrompt(payload: ReconciliationPromptPayload): string {
  const erpUrl = payload.files.erpFile.url;
  const settlementUrl = payload.files.settlementFile.url;
  const params = payload.runtime ?? {
    taskWorkDir: ".runtime/tasks/current",
    settlementFilePath: settlementUrl,
    erpFilePath: erpUrl,
  };

  return `我有一个对账任务：

${erpUrl}
这是 ERP 导出单据

${settlementUrl}
这是结算单

本次任务唯一允许使用的临时工作目录：
${params.taskWorkDir}

如需下载文件、拆分 PDF、渲染图片、执行 OCR 或生成 Markdown/JSON，请只写入上述目录。不要在项目根目录、源码目录或输入文件旁创建文件；不要复制原始文件，优先直接读取以下本地路径：
- ERP：${params.erpFilePath}
- 结算单：${params.settlementFilePath}

在过程中，面对图片、PDF 等文件，你可以使用 mineru 这个项目 Subagent 获取 Markdown 格式的内容。

请帮我看看是否能够对上账。

当你完成对账后，最后只输出一个合法的 JSON 对象，不要使用 Markdown 代码块，也不要在 JSON 前后输出其他内容。格式例子如下：

{
  "matched": true,
  "erpAmount": 100.00,
  "settlementAmount": 100.00,
  "difference": 0.00,
  "issues": "",
  "period": "XXXX-XX",
  "name": "商城名称A"
}

其中字段类型必须依次为：
- matched：布尔值
- erpAmount：有限数字，ERP/DRP 销售额合计
- settlementAmount：有限数字，结算单净营业额合计
- difference：有限数字
- issues：字符串；没有内容时输出空字符串
- period: 字符串，对账月份，格式必须为 "YYYY-MM"
- name: 非空字符串，商城名称

字段业务含义、计算口径和适用范围只以本次 Session 中加载的飞书知识规则快照为准，不得自行采用服务器内置口径。`;
}
