// 文件说明：开始对账页的文件选择与表单校验逻辑（纯 UI 层）。
// 任务执行与处理日志由 ReconciliationTaskProvider 统一管理，切换页面不丢失。
import { useState } from "react";
import type { ChangeEvent, Dispatch, SetStateAction } from "react";
import { validateBatchReconciliationFile, validateErpFile, validateReconciliationFile } from "../model/file-rules";

type BatchRejectedFile = { name: string; reason: string };
type FileWithRelativePath = File & { webkitRelativePath?: string };

function displayFileName(file: File) {
  return (file as FileWithRelativePath).webkitRelativePath || file.name;
}

export function useStartReconciliation() {
  const [settlementFile, setSettlementFile] = useState<File | null>(null);
  const [batchFiles, setBatchFiles] = useState<File[]>([]);
  const [batchRejectedFiles, setBatchRejectedFiles] = useState<BatchRejectedFile[]>([]);
  const [taskErpFile, setTaskErpFile] = useState<File | null>(null);
  const [agentName, setAgentName] = useState("");
  const [agentWorkspace, setAgentWorkspace] = useState("");
  const [formError, setFormError] = useState("");

  const createFileChangeHandler = (
    setFile: Dispatch<SetStateAction<File | null>>,
    fieldLabel: string,
    validateFile: (file: File) => string | null = validateReconciliationFile,
  ) => (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0] ?? null;
    if (!selectedFile) {
      setFile(null);
      return;
    }

    const validationError = validateFile(selectedFile);
    if (validationError) {
      setFile(null);
      setFormError(`${fieldLabel}：${validationError}`);
      event.target.value = "";
      return;
    }

    setFormError("");
    setFile(selectedFile);
  };

  const handleSettlementFileChange = createFileChangeHandler(setSettlementFile, "结算资料");

  const handleBatchFilesChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files ?? []);
    const acceptedFiles: File[] = [];
    const rejectedFiles: BatchRejectedFile[] = [];

    for (const file of selectedFiles) {
      const validationError = validateBatchReconciliationFile(file);
      if (validationError) rejectedFiles.push({ name: displayFileName(file), reason: validationError });
      else acceptedFiles.push(file);
    }

    setSettlementFile(null);
    setBatchFiles(acceptedFiles);
    setBatchRejectedFiles(rejectedFiles);
    setFormError(rejectedFiles.length
      ? `批量已过滤 ${rejectedFiles.length} 个文件：${rejectedFiles.slice(0, 3).map((file) => file.name).join("、")}`
      : "");
    event.target.value = "";
  };

  return {
    settlementFile,
    batchFiles,
    batchRejectedFiles,
    taskErpFile,
    agentName,
    agentWorkspace,
    formError,
    setAgentName,
    setAgentWorkspace,
    clearTaskErpFile: () => setTaskErpFile(null),
    clearBatchFiles: () => {
      setBatchFiles([]);
      setBatchRejectedFiles([]);
      setFormError("");
    },
    handleSettlementFileChange: (event: ChangeEvent<HTMLInputElement>) => {
      setBatchFiles([]);
      setBatchRejectedFiles([]);
      handleSettlementFileChange(event);
    },
    handleBatchFilesChange,
    handleTaskErpFileChange: createFileChangeHandler(setTaskErpFile, "ERP 文件", validateErpFile),
  };
}
