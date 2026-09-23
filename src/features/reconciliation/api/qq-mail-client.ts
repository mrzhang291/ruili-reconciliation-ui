// 文件说明：QQ 邮箱接口的轻量客户端；授权码只随配置请求发送，不在浏览器端持久化。

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:3001").trim().replace(/\/$/, "");

export type QqMailStatus = {
  configured: boolean;
  account: string | null;
};

export type QqMailConfigurationInput = {
  email: string;
  authorizationCode: string;
};

export type QqMailDraftInput = {
  to: string[];
  subject: string;
  text: string;
};

export type QqMailPreparedDraft = {
  delivery: "NOT_SENT";
  from: string;
  to: string[];
  subject: string;
  text: string;
};

export type QqMailSendResult = {
  acceptedForDelivery: true;
  from: string;
  to: string[];
  subject: string;
  sentAt: string;
};

export class QqMailApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QqMailApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new QqMailApiError("暂时无法连接邮件服务");
  }

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // 非 JSON 响应按通用失败处理。
  }

  if (!response.ok) {
    const errorPayload = payload as { error?: { message?: string } } | null;
    throw new QqMailApiError(errorPayload?.error?.message ?? `邮件请求失败（HTTP ${response.status}）`);
  }

  const envelope = payload as { data?: T } | null;
  if (envelope?.data === undefined) throw new QqMailApiError("邮件服务未返回可用结果");
  return envelope.data;
}

export const qqMailApi = {
  getStatus: () => request<QqMailStatus>("/api/mail/qq/status", { cache: "no-store" }),
  saveConfiguration: (input: QqMailConfigurationInput) => request<QqMailStatus>("/api/mail/qq/configuration", {
    method: "POST",
    body: JSON.stringify(input),
  }),
  prepare: (input: QqMailDraftInput) => request<QqMailPreparedDraft>("/api/mail/qq/prepare", {
    method: "POST",
    body: JSON.stringify(input),
  }),
  send: (input: QqMailDraftInput) => request<QqMailSendResult>("/api/mail/qq/send", {
    method: "POST",
    body: JSON.stringify(input),
  }),
};
