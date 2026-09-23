// 文件说明：QQ 邮箱工作台负责保存发件设置、生成预览，并在使用者再次确认后发送邮件。
import { useEffect, useMemo, useRef, useState } from "react";
import { qqMailApi, type QqMailDraftInput, type QqMailPreparedDraft, type QqMailStatus } from "../api/qq-mail-client";
import { useReviewWorklist, type ReviewWorklistRow } from "../hooks/use-review-worklist";

const unconfiguredStatus: QqMailStatus = { configured: false, account: null };

function draftSubject(row: ReviewWorklistRow) {
  const sourceName = row.task.name ?? "对账差异";
  const period = row.task.periodLabel ? `｜${row.task.periodLabel}` : "";
  return `请协助确认对账差异${period}｜${sourceName}`;
}

function emailRecipients(value: string) {
  return [...new Set(value.split(/[;,\n]/).map((item) => item.trim()).filter(Boolean))];
}

function draftText(input: QqMailDraftInput) {
  return [`收件人：${input.to.join("、")}`, `主题：${input.subject}`, "", input.text].join("\n");
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function MailboxView() {
  const { rows, loading, error, errorTitle } = useReviewWorklist();
  const pendingRows = useMemo(() => rows.filter(({ item }) => item.status === "PENDING"), [rows]);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [recipient, setRecipient] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [mailStatus, setMailStatus] = useState<QqMailStatus>(unconfiguredStatus);
  const [statusLoading, setStatusLoading] = useState(true);
  // 失效的状态读取不得覆盖后续保存后回读的结果。
  const statusRequestRevisionRef = useRef(0);
  const [configurationVisible, setConfigurationVisible] = useState(true);
  const [senderAddress, setSenderAddress] = useState("");
  const [authorizationCode, setAuthorizationCode] = useState("");
  const [savingConfiguration, setSavingConfiguration] = useState(false);
  const [configurationFeedback, setConfigurationFeedback] = useState("");
  const [configurationFailed, setConfigurationFailed] = useState(false);
  const [preparedDraft, setPreparedDraft] = useState<QqMailPreparedDraft | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [sending, setSending] = useState(false);
  const [sentAt, setSentAt] = useState("");
  const [actionFeedback, setActionFeedback] = useState("");
  const [actionFailed, setActionFailed] = useState(false);

  useEffect(() => {
    let active = true;
    const loadStatus = async () => {
      const requestRevision = ++statusRequestRevisionRef.current;
      setStatusLoading(true);
      try {
        const status = await qqMailApi.getStatus();
        if (!active || requestRevision !== statusRequestRevisionRef.current) return;
        setMailStatus(status);
        // 服务端只返回脱敏后的 account，不能把它回填为可编辑邮箱地址。
        setSenderAddress("");
        setConfigurationVisible(!status.configured);
      } catch (requestError) {
        if (!active || requestRevision !== statusRequestRevisionRef.current) return;
        setConfigurationFailed(true);
        setConfigurationFeedback(errorMessage(requestError, "无法读取 QQ 邮箱发件设置"));
      } finally {
        if (active && requestRevision === statusRequestRevisionRef.current) setStatusLoading(false);
      }
    };
    void loadStatus();
    return () => { active = false; };
  }, []);

  const selectedRow = pendingRows.find((row) => row.item.id === selectedItemId) ?? null;
  const canSend = mailStatus.configured && preparedDraft !== null && !sending && !sentAt;

  const clearPreview = () => {
    setPreparedDraft(null);
    setSentAt("");
    setActionFeedback("");
    setActionFailed(false);
  };

  const selectSource = (row: ReviewWorklistRow) => {
    if (row.item.id === selectedItemId) return;
    setSelectedItemId(row.item.id);
    setSubject(draftSubject(row));
    setBody(row.confirmation.communicationTemplate);
    clearPreview();
  };

  const selectSourceById = (itemId: string) => {
    if (!itemId) {
      setSelectedItemId(null);
      clearPreview();
      return;
    }
    const row = pendingRows.find((candidate) => candidate.item.id === itemId);
    if (row) selectSource(row);
  };

  const resetDraft = () => {
    if (!selectedRow) return;
    setSubject(draftSubject(selectedRow));
    setBody(selectedRow.confirmation.communicationTemplate);
    clearPreview();
    setActionFeedback("已恢复系统生成的沟通话术，请按实际情况补充后预览。");
  };

  const saveConfiguration = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedAddress = senderAddress.trim();
    if (!normalizedAddress || !authorizationCode.trim()) {
      setConfigurationFailed(true);
      setConfigurationFeedback("请填写 QQ 发件邮箱和 SMTP 授权码。");
      return;
    }

    setSavingConfiguration(true);
    setConfigurationFeedback("");
    setConfigurationFailed(false);
    // 让页面初次加载时尚未完成的状态请求失效，避免它覆盖保存结果。
    const saveRevision = ++statusRequestRevisionRef.current;
    let settingsSaved = false;
    try {
      await qqMailApi.saveConfiguration({
        email: normalizedAddress,
        authorizationCode: authorizationCode.trim(),
      });
      settingsSaved = true;
      // 保存接口只表示写入命令成功；必须重新读取一次持久化状态，不能仅凭即时回执显示“已配置”。
      const persistedStatus = await qqMailApi.getStatus();
      if (saveRevision !== statusRequestRevisionRef.current) return;
      if (!persistedStatus.configured) {
        setMailStatus(unconfiguredStatus);
        setConfigurationVisible(true);
        setConfigurationFailed(true);
        setConfigurationFeedback("未能确认 QQ 发件设置已保存。请重新保存；若仍失败，请检查本机凭据管理器。");
        return;
      }
      setMailStatus(persistedStatus);
      setSenderAddress("");
      setAuthorizationCode("");
      setConfigurationVisible(false);
      setConfigurationFeedback("QQ 发件设置已保存。授权码不会显示在草稿中。");
      clearPreview();
    } catch (requestError) {
      if (saveRevision !== statusRequestRevisionRef.current) return;
      setConfigurationFailed(true);
      setConfigurationFeedback(settingsSaved
        ? errorMessage(requestError, "QQ 发件设置已提交，但无法确认是否已保存，请刷新后重试。")
        : errorMessage(requestError, "QQ 发件设置保存失败"));
    } finally {
      if (saveRevision === statusRequestRevisionRef.current) setSavingConfiguration(false);
    }
  };

  const buildDraftInput = (): QqMailDraftInput | null => {
    const recipients = emailRecipients(recipient);
    if (!recipients.length || !subject.trim() || !body.trim()) {
      setActionFailed(true);
      setActionFeedback("请先填写收件人、主题和邮件正文。");
      return null;
    }
    return { to: recipients, subject: subject.trim(), text: body.trim() };
  };

  const prepareDraft = async () => {
    const input = buildDraftInput();
    if (!input) return;

    setPreparing(true);
    setActionFeedback("");
    setActionFailed(false);
    try {
      const prepared = await qqMailApi.prepare(input);
      setPreparedDraft(prepared);
      setSentAt("");
      setActionFeedback("邮件预览已生成，请核对内容后再发送。");
    } catch (requestError) {
      setActionFailed(true);
      setActionFeedback(errorMessage(requestError, "邮件预览生成失败"));
    } finally {
      setPreparing(false);
    }
  };

  const copyDraft = async () => {
    const input = buildDraftInput();
    if (!input) return;
    setActionFeedback("");
    setActionFailed(false);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(draftText(input));
      setActionFeedback("邮件内容已复制，可粘贴到 QQ 邮箱的新邮件中。");
    } catch {
      setActionFailed(true);
      setActionFeedback("无法自动复制，请手动选择邮件正文复制。");
    }
  };

  const sendDraft = async () => {
    if (!mailStatus.configured) {
      setActionFailed(true);
      setActionFeedback("请先完成 QQ 发件设置，再发送邮件。");
      setConfigurationVisible(true);
      return;
    }
    if (!preparedDraft) {
      setActionFailed(true);
      setActionFeedback("请先预览邮件并核对内容。");
      return;
    }
    const input = buildDraftInput();
    if (!input) return;
    const confirmed = window.confirm(`即将通过 QQ 邮箱向 ${input.to.join("、")} 发送此邮件。请确认收件人、主题和正文均已核对无误。`);
    if (!confirmed) return;

    setSending(true);
    setActionFeedback("");
    setActionFailed(false);
    try {
      const result = await qqMailApi.send(input);
      setSentAt(result.sentAt);
      setActionFeedback(result.acceptedForDelivery ? "邮件已提交至 QQ 邮箱发送。" : "邮件发送结果待确认。");
    } catch (requestError) {
      setActionFailed(true);
      setActionFeedback(errorMessage(requestError, "邮件发送失败，请检查 QQ 发件设置后重试"));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="view-shell mail-view">
      <div className="page-intro page-intro--split">
        <div>
          <span className="eyebrow">QQ MAIL</span>
          <h1>QQ 邮箱</h1>
          <p>从差异处理中的待确认记录生成客户沟通邮件；先预览，再由您主动确认发送。</p>
        </div>
        <div className="mail-assurance">
          <span aria-hidden="true">✓</span>
          <div><strong>发送前始终需要确认</strong><small>系统不会代为点击发送，也不会在草稿中显示授权码。</small></div>
        </div>
      </div>

      <section className="mail-configuration-card" aria-label="QQ 发件设置">
        <div className="mail-configuration-card__head">
          <div>
            <span className="eyebrow">SENDER SETTINGS</span>
            <h2>QQ 发件设置</h2>
            <p>{statusLoading ? "正在读取发件设置…" : mailStatus.configured ? `当前发件邮箱：${mailStatus.account || "已配置"}` : "请配置 QQ 发件邮箱和 SMTP 授权码后再发送邮件。"}</p>
          </div>
          <div className="mail-configuration-card__actions">
            <span className={mailStatus.configured ? "mail-config-state mail-config-state--ready" : "mail-config-state"}>{mailStatus.configured ? "已配置" : "未配置"}</span>
            <button type="button" className="text-button" onClick={() => setConfigurationVisible((current) => !current)}>{configurationVisible ? "收起设置" : "修改设置"}</button>
          </div>
        </div>
        {configurationFeedback && <p className={configurationFailed ? "mail-copy-feedback mail-copy-feedback--error" : "mail-copy-feedback"} role="status">{configurationFeedback}</p>}
        {configurationVisible && (
          <form className="mail-configuration-form" onSubmit={(event) => void saveConfiguration(event)}>
            <label className="mail-field">
              <span>QQ 发件邮箱</span>
              <input type="email" value={senderAddress} onChange={(event) => setSenderAddress(event.target.value)} placeholder="例如：name@qq.com" autoComplete="email" />
            </label>
            <label className="mail-field">
              <span>SMTP 授权码</span>
              <input type="password" value={authorizationCode} onChange={(event) => setAuthorizationCode(event.target.value)} placeholder="QQ 邮箱生成的授权码，不是登录密码" autoComplete="new-password" />
              <small>授权码仅用于发信配置，保存后不会回显。</small>
            </label>
            <button type="submit" className="outline-button" disabled={savingConfiguration}>{savingConfiguration ? "正在保存" : "保存 QQ 设置"}</button>
          </form>
        )}
      </section>

      {error && <div className="api-error overview-error" role="alert"><b>{errorTitle || "邮件草稿加载失败"}</b><span>{error}</span></div>}

      <section className="mail-workbench" aria-label="QQ 邮箱草稿工作台">
        <form className="mail-composer" onSubmit={(event) => event.preventDefault()}>
          <div className="mail-composer__head">
            <div>
              <span className="eyebrow">DRAFT EDITOR</span>
              <h2>邮件草稿</h2>
              {selectedRow
                ? <p>来源：{selectedRow.task.name ?? selectedRow.task.id} · {selectedRow.confirmation.question}</p>
                : <p>填写一封新的邮件；如需带入话术，可从下方选择一条差异。</p>}
            </div>
            {selectedRow && <button type="button" className="text-button" onClick={resetDraft}>恢复话术</button>}
          </div>

          <label className="mail-field mail-source-field">
            <span>加载差异话术（可选）</span>
            <select value={selectedItemId ?? ""} disabled={loading} onChange={(event) => selectSourceById(event.target.value)}>
              <option value="">手动编写邮件</option>
              {pendingRows.map((row) => <option key={`${row.task.id}-${row.item.id}`} value={row.item.id}>{`${row.task.name ?? row.task.id}｜${row.task.periodLabel ?? "账期待确认"}｜${row.classification.label}`}</option>)}
            </select>
            <small>{loading ? "正在读取可用话术…" : error ? "暂时无法加载差异话术，仍可手动编辑邮件。" : `共 ${pendingRows.length} 条可加载话术；完整差异说明请在“差异处理”查看。`}</small>
          </label>

          <div className="mail-form__top">
            <label className="mail-field">
              <span>收件人</span>
              <input type="email" multiple value={recipient} onChange={(event) => { setRecipient(event.target.value); clearPreview(); }} placeholder="例如：finance@example.com" />
              <small>多个收件人请用英文逗号分隔</small>
            </label>
            <label className="mail-field">
              <span>主题</span>
              <input value={subject} onChange={(event) => { setSubject(event.target.value); clearPreview(); }} placeholder="请输入邮件主题" />
            </label>
          </div>

          <label className="mail-field mail-field--body">
            <span>邮件正文</span>
            <textarea value={body} onChange={(event) => { setBody(event.target.value); clearPreview(); }} placeholder="请输入邮件内容" rows={15} />
          </label>

          {preparedDraft && (
            <section className="mail-preview" aria-label="邮件预览">
              <div className="mail-preview__head"><h3>发送预览</h3><span>已核对</span></div>
              <dl>
                <div><dt>发件人</dt><dd>{preparedDraft.from || mailStatus.account || "待配置"}</dd></div>
                <div><dt>收件人</dt><dd>{preparedDraft.to.join("、")}</dd></div>
                <div><dt>主题</dt><dd>{preparedDraft.subject}</dd></div>
              </dl>
              <pre>{preparedDraft.text}</pre>
            </section>
          )}

          <div className="mail-composer__footer">
            <div>
              {actionFeedback && <p className={actionFailed ? "mail-copy-feedback mail-copy-feedback--error" : "mail-copy-feedback"} role="status">{actionFeedback}</p>}
              <small>点击“发送邮件”后仍会出现一次确认提示；请核对收件人、主题和正文。</small>
            </div>
            <div className="mail-actions">
              <button type="button" className="outline-button" onClick={() => void copyDraft()}>复制邮件内容</button>
              <a className="mail-open-link mail-open-link--secondary" href="https://mail.qq.com/" target="_blank" rel="noopener noreferrer">打开 QQ 邮箱</a>
              <button type="button" className="outline-button" disabled={!mailStatus.configured || preparing} title={!mailStatus.configured ? "请先完成 QQ 发件设置" : undefined} onClick={() => void prepareDraft()}>{preparing ? "正在预览" : "预览邮件"}</button>
              <button type="button" className="primary-button mail-send-button" disabled={!canSend} title={!mailStatus.configured ? "请先完成 QQ 发件设置" : !preparedDraft ? "请先预览邮件" : sentAt ? "这封预览邮件已经发送" : undefined} onClick={() => void sendDraft()}>{sending ? "正在发送" : sentAt ? "已发送" : "发送邮件"}</button>
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}
