// 文件说明：上传文件卡片组件，展示文件选择入口、已选文件和文件类型提示。
import type { ChangeEvent } from "react";
import {
  formatFileSize,
  getReconciliationFileBadge,
  getReconciliationFileTypeLabel,
} from "../model/file-rules";

type FileCardProps = {
  eyebrow: string;
  title: string;
  description: string;
  file: File | null;
  accept: string;
  hint: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
};

export function FileCard({
  eyebrow,
  title,
  description,
  file,
  accept,
  hint,
  onChange,
}: FileCardProps) {
  return (
    <section className={`file-card ${file ? "file-card--ready" : ""}`}>
      <div className="file-card__head">
        <span className="step-index">{eyebrow}</span>
        <span className="file-state">{file ? "已就绪" : "等待导入"}</span>
      </div>
      <div className="file-icon" aria-hidden="true">{file ? getReconciliationFileBadge(file) : "FILE"}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {file ? (
        <div className="selected-file">
          <div>
            <strong>{file.name}</strong>
            <span>{formatFileSize(file.size)} · {getReconciliationFileTypeLabel(file)}</span>
          </div>
          <label className="text-button">
            更换文件
            <input type="file" accept={accept} onChange={onChange} />
          </label>
        </div>
      ) : (
        <div className="file-actions">
          <label className="outline-button">
            <span aria-hidden="true">＋</span> 选择文件
            <input type="file" accept={accept} onChange={onChange} />
          </label>
        </div>
      )}
      <span className="file-hint">{hint}</span>
    </section>
  );
}
