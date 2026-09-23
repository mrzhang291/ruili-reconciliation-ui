import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import tls from "node:tls";
import { config } from "./config.js";

const QQ_MAILBOX_PATTERN = /^[a-z0-9._%+-]+@(qq\.com|foxmail\.com)$/i;
const RECIPIENT_PATTERN = /^(?=.{3,254}$)[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const MAX_RECIPIENTS = 20;
const MAX_SUBJECT_LENGTH = 200;
const MAX_TEXT_LENGTH = 50_000;
const POWERSHELL_STDIN_BOOTSTRAP = "$script = [Console]::In.ReadToEnd(); & ([scriptblock]::Create($script))";
const CREDENTIAL_MANAGER_DEFINITION = `
using System;
using System.Runtime.InteropServices;

public static class BillCompareCredentialManager {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("Advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);

  [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credentialPtr);

  [DllImport("Advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr credentialPtr);
}
`;

type CredentialOperation = "status" | "write" | "read-secret";

type CredentialResult = {
  ok: true;
  found: boolean;
  email?: string;
  authorizationCode?: string;
};

type CredentialStatus = Pick<CredentialResult, "found" | "email">;

type QqMailInput = {
  to?: unknown;
  subject?: unknown;
  text?: unknown;
};

type ParsedQqMailInput = {
  to: string[];
  subject: string;
  text: string;
};

type StoredQqMailCredential = {
  email: string;
  authorizationCode: string;
};

export type QqMailStatus = {
  provider: "qq";
  configured: boolean;
  account: string | null;
  credentialStorage: "windows-credential-manager" | "unavailable";
  verification: "not-tested";
  smtp: {
    host: string;
    port: number;
    secure: boolean;
  };
};

export type QqMailDraft = {
  provider: "qq";
  delivery: "NOT_SENT";
  from: string;
  to: string[];
  subject: string;
  text: string;
  smtp: {
    host: string;
    port: number;
    secure: boolean;
  };
};

export type QqMailSendResult = {
  provider: "qq";
  acceptedForDelivery: true;
  from: string;
  to: string[];
  subject: string;
  sentAt: string;
};

export class QqMailError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "QqMailError";
  }
}

export function normalizeQqMailbox(value: unknown) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!QQ_MAILBOX_PATTERN.test(email)) {
    throw new QqMailError("请填写有效的 QQ 邮箱地址（@qq.com 或 @foxmail.com）", "QQ_MAIL_INVALID_ACCOUNT");
  }
  return email;
}

function normalizeAuthorizationCode(value: unknown) {
  const authorizationCode = typeof value === "string" ? value.replace(/\s+/g, "") : "";
  if (!/^[a-z0-9]{6,32}$/i.test(authorizationCode)) {
    throw new QqMailError("请填写 QQ 邮箱生成的 SMTP 授权码", "QQ_MAIL_INVALID_AUTHORIZATION_CODE");
  }
  return authorizationCode;
}

function normalizeRecipients(value: unknown) {
  const rawRecipients = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[;,]/u)
      : [];
  const recipients = rawRecipients.map((recipient) => typeof recipient === "string" ? recipient.trim() : "").filter(Boolean);
  if (!recipients.length || recipients.length > MAX_RECIPIENTS || recipients.some((recipient) => !RECIPIENT_PATTERN.test(recipient))) {
    throw new QqMailError("请填写 1–20 个有效收件人邮箱地址", "QQ_MAIL_INVALID_RECIPIENTS");
  }
  return [...new Set(recipients.map((recipient) => recipient.toLowerCase()))];
}

function normalizeSubject(value: unknown) {
  const subject = typeof value === "string" ? value.trim() : "";
  if (!subject || subject.length > MAX_SUBJECT_LENGTH || /[\r\n]/u.test(subject)) {
    throw new QqMailError("邮件主题不能为空，且不能超过 200 个字符", "QQ_MAIL_INVALID_SUBJECT");
  }
  return subject;
}

function normalizeText(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > MAX_TEXT_LENGTH) {
    throw new QqMailError("邮件正文不能为空，且不能超过 50,000 个字符", "QQ_MAIL_INVALID_TEXT");
  }
  return text;
}

function parseMailInput(input: unknown): ParsedQqMailInput {
  const payload = input && typeof input === "object" ? input as QqMailInput : {};
  return {
    to: normalizeRecipients(payload.to),
    subject: normalizeSubject(payload.subject),
    text: normalizeText(payload.text),
  };
}

function maskMailbox(email: string) {
  const [localPart, domain] = email.split("@");
  if (!localPart || !domain) return "***";
  return `${localPart.slice(0, 2)}***@${domain}`;
}

function smtpSettings() {
  return { host: config.qqMail.host, port: config.qqMail.port, secure: config.qqMail.secure };
}

function statusFor(email?: string): QqMailStatus {
  return {
    provider: "qq",
    configured: Boolean(email),
    account: email ? maskMailbox(email) : null,
    credentialStorage: process.platform === "win32" ? "windows-credential-manager" : "unavailable",
    verification: "not-tested",
    smtp: smtpSettings(),
  };
}

function ensureCredentialStorageAvailable() {
  if (process.platform !== "win32") {
    throw new QqMailError("QQ 邮箱仅支持在 Windows 本机凭据管理器中配置", "QQ_MAIL_CREDENTIAL_STORAGE_UNAVAILABLE", 503);
  }
}

export async function getQqMailStatus(): Promise<QqMailStatus> {
  if (process.platform !== "win32") return statusFor();
  const result = await runCredentialOperation("status");
  if (!result.found || !result.email) return statusFor();
  return statusFor(normalizeQqMailbox(result.email));
}

export async function configureQqMail(input: unknown): Promise<QqMailStatus> {
  ensureCredentialStorageAvailable();
  const payload = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const email = normalizeQqMailbox(payload.email);
  const authorizationCode = normalizeAuthorizationCode(payload.authorizationCode);

  try {
    await runCredentialOperation("write", { email, authorizationCode });
  } finally {
    // The string cannot be forcibly erased in V8, but dropping it immediately limits its lifetime.
    payload.authorizationCode = undefined;
  }

  return statusFor(email);
}

export async function prepareQqMailMessage(input: unknown): Promise<QqMailDraft> {
  const email = await requireConfiguredMailbox();
  return buildQqMailDraft(input, email);
}

export function requireConfiguredQqMailbox(status: CredentialStatus) {
  if (!status.found || !status.email) {
    throw new QqMailError("请先在邮箱设置中配置 QQ 邮箱和 SMTP 授权码", "QQ_MAIL_NOT_CONFIGURED", 409);
  }
  return normalizeQqMailbox(status.email);
}

export function buildQqMailDraft(input: unknown, fromMailbox: string): QqMailDraft {
  const parsed = parseMailInput(input);
  return {
    provider: "qq",
    delivery: "NOT_SENT",
    from: maskMailbox(normalizeQqMailbox(fromMailbox)),
    to: parsed.to,
    subject: parsed.subject,
    text: parsed.text,
    smtp: smtpSettings(),
  };
}

export async function sendQqMailMessage(input: unknown): Promise<QqMailSendResult> {
  const credential = await readConfiguredCredential();
  const parsed = parseMailInput(input);
  const from = normalizeQqMailbox(credential.email);

  try {
    await deliverQqMail({ from, authorizationCode: credential.authorizationCode, ...parsed });
  } finally {
    credential.authorizationCode = "";
  }

  return {
    provider: "qq",
    acceptedForDelivery: true,
    from: maskMailbox(from),
    to: parsed.to,
    subject: parsed.subject,
    sentAt: new Date().toISOString(),
  };
}

export function buildQqSmtpData(
  draft: Pick<QqMailDraft, "to" | "subject" | "text"> & { from: string },
  now = new Date(),
) {
  const from = normalizeQqMailbox(draft.from);
  const recipients = normalizeRecipients(draft.to);
  const subject = encodeHeader(normalizeSubject(draft.subject));
  const plainText = encodeBase64Body(normalizeText(draft.text));
  return [
    `From: <${from}>`,
    `To: ${recipients.join(", ")}`,
    "Subject:",
    ` ${subject}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${randomUUID()}@billcompare.local>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    plainText,
  ].join("\r\n");
}

async function requireConfiguredMailbox() {
  ensureCredentialStorageAvailable();
  const result = await runCredentialOperation("status");
  return requireConfiguredQqMailbox(result);
}

async function readConfiguredCredential(): Promise<StoredQqMailCredential> {
  ensureCredentialStorageAvailable();
  const result = await runCredentialOperation("read-secret");
  const email = requireConfiguredQqMailbox(result);
  if (!result.authorizationCode) throw new QqMailError("请先在邮箱设置中配置 QQ 邮箱和 SMTP 授权码", "QQ_MAIL_NOT_CONFIGURED", 409);
  return {
    email,
    authorizationCode: normalizeAuthorizationCode(result.authorizationCode),
  };
}

async function runCredentialOperation(operation: CredentialOperation, values: Record<string, string> = {}): Promise<CredentialResult> {
  ensureCredentialStorageAvailable();
  const payload = Buffer.from(JSON.stringify({ operation, target: config.qqMail.credentialTarget, ...values }), "utf8").toString("base64");
  const script = buildCredentialManagerScript(payload);

  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", POWERSHELL_STDIN_BOOTSTRAP], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    // Do not preserve or return PowerShell diagnostics: they can contain the script input.
    child.stderr.resume();
    child.once("error", () => reject(new QqMailError("无法访问 Windows 本机凭据管理器", "QQ_MAIL_CREDENTIAL_MANAGER_ERROR", 503)));
    child.once("close", (exitCode) => {
      const result = parseCredentialResult(stdout);
      stdout = "";
      if (exitCode !== 0 || !result) {
        reject(new QqMailError("无法访问 Windows 本机凭据管理器", "QQ_MAIL_CREDENTIAL_MANAGER_ERROR", 503));
        return;
      }
      resolve(result);
    });
    child.stdin.end(script, "utf8");
  });
}

function parseCredentialResult(output: string): CredentialResult | null {
  try {
    const value: unknown = JSON.parse(output.trim());
    if (!value || typeof value !== "object") return null;
    const result = value as Record<string, unknown>;
    if (result.ok !== true || typeof result.found !== "boolean") return null;
    if (result.email !== undefined && typeof result.email !== "string") return null;
    if (result.authorizationCode !== undefined && typeof result.authorizationCode !== "string") return null;
    return {
      ok: true,
      found: result.found,
      email: result.email as string | undefined,
      authorizationCode: result.authorizationCode as string | undefined,
    };
  } catch {
    return null;
  }
}

function buildCredentialManagerScript(encodedPayload: string) {
  const encodedDefinition = Buffer.from(CREDENTIAL_MANAGER_DEFINITION, "utf8").toString("base64");
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $payload = ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPayload}')) | ConvertFrom-Json)
  $definition = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedDefinition}'))
  if ($null -eq ('BillCompareCredentialManager' -as [type])) { Add-Type -TypeDefinition $definition }

  function Read-Credential([string] $target, [bool] $includeSecret) {
    $credentialPtr = [IntPtr]::Zero
    if (-not [BillCompareCredentialManager]::CredRead($target, 1, 0, [ref] $credentialPtr)) {
      if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { return $null }
      throw 'Credential read failed'
    }
    try {
      $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($credentialPtr, [type] [BillCompareCredentialManager+CREDENTIAL])
      $result = @{ email = [string] $credential.UserName }
      if ($includeSecret) {
        # CredentialBlob is an unmanaged pointer. Copy it into managed memory before
        # decoding; Encoding.GetString does not accept an IntPtr overload.
        $secretBytes = New-Object byte[] ([int] $credential.CredentialBlobSize)
        try {
          [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $secretBytes, 0, $secretBytes.Length)
          $result.authorizationCode = [Text.Encoding]::Unicode.GetString($secretBytes)
        } finally {
          [Array]::Clear($secretBytes, 0, $secretBytes.Length)
        }
      }
      return [PSCustomObject] $result
    } finally {
      [BillCompareCredentialManager]::CredFree($credentialPtr)
    }
  }

  if ($payload.operation -eq 'status') {
    $credential = Read-Credential -target ([string] $payload.target) -includeSecret:$false
    if ($null -eq $credential) { [Console]::Out.Write('{"ok":true,"found":false}') }
    else { [Console]::Out.Write((@{ ok = $true; found = $true; email = [string] $credential.email } | ConvertTo-Json -Compress)) }
  } elseif ($payload.operation -eq 'write') {
    $bytes = [Text.Encoding]::Unicode.GetBytes([string] $payload.authorizationCode)
    $blob = [IntPtr]::Zero
    try {
      $blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
      [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
      $credential = New-Object BillCompareCredentialManager+CREDENTIAL
      $credential.Type = 1
      $credential.TargetName = [string] $payload.target
      $credential.CredentialBlobSize = [uint32] $bytes.Length
      $credential.CredentialBlob = $blob
      $credential.Persist = 2
      $credential.UserName = [string] $payload.email
      if (-not [BillCompareCredentialManager]::CredWrite([ref] $credential, 0)) { throw 'Credential write failed' }
      [Console]::Out.Write('{"ok":true,"found":true}')
    } finally {
      if ($blob -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::Copy((New-Object byte[] $bytes.Length), 0, $blob, $bytes.Length)
        [Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
      }
      [Array]::Clear($bytes, 0, $bytes.Length)
      $payload.authorizationCode = $null
    }
  } elseif ($payload.operation -eq 'read-secret') {
    $credential = Read-Credential -target ([string] $payload.target) -includeSecret:$true
    if ($null -eq $credential) { [Console]::Out.Write('{"ok":true,"found":false}') }
    else {
      try {
        [Console]::Out.Write((@{ ok = $true; found = $true; email = [string] $credential.email; authorizationCode = [string] $credential.authorizationCode } | ConvertTo-Json -Compress))
      } finally {
        $credential.authorizationCode = $null
      }
    }
  } else { throw 'Unknown operation' }
} catch {
  [Console]::Out.Write('{"ok":false}')
  exit 1
}`;
}

function encodeHeader(value: string) {
  const chunks: string[] = [];
  let chunk = "";
  let byteLength = 0;
  for (const character of value) {
    const characterLength = Buffer.byteLength(character, "utf8");
    // RFC 2047 caps an encoded-word at 75 characters. 45 raw bytes become 60 base64 characters.
    if (chunk && byteLength + characterLength > 45) {
      chunks.push(chunk);
      chunk = "";
      byteLength = 0;
    }
    chunk += character;
    byteLength += characterLength;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map((part) => {
    const bytes = Buffer.from(part, "utf8");
    try {
      return `=?UTF-8?B?${bytes.toString("base64")}?=`;
    } finally {
      bytes.fill(0);
    }
  }).join("\r\n ");
}

function encodeBase64Body(value: string) {
  const bytes = Buffer.from(value.replace(/\r?\n/gu, "\r\n"), "utf8");
  try {
    const encoded = bytes.toString("base64");
    return encoded.match(/.{1,76}/gu)?.join("\r\n") ?? "";
  } finally {
    bytes.fill(0);
  }
}

async function deliverQqMail(message: { from: string; authorizationCode: string; to: string[]; subject: string; text: string }) {
  const socket = tls.connect({
    host: config.qqMail.host,
    port: config.qqMail.port,
    servername: config.qqMail.host,
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
  });
  const session = new SmtpSession(socket, config.qqMail.timeoutMs);

  try {
    await session.waitForSecureConnection();
    await session.expect([220]);
    await session.command("EHLO billcompare.local", [250]);
    await session.command("AUTH LOGIN", [334]);
    await session.command(encodeSmtpValue(message.from), [334]);
    await session.command(encodeSmtpValue(message.authorizationCode), [235]);
    await session.command(`MAIL FROM:<${message.from}>`, [250]);
    for (const recipient of message.to) await session.command(`RCPT TO:<${recipient}>`, [250, 251]);
    await session.command("DATA", [354]);
    await session.raw(`${buildQqSmtpData(message)}\r\n.\r\n`);
    await session.expect([250]);
    await session.command("QUIT", [221]);
  } catch (error) {
    if (error instanceof QqMailError) throw error;
    throw new QqMailError("QQ 邮箱 SMTP 认证或投递失败，请检查网络和授权码", "QQ_MAIL_DELIVERY_FAILED", 502);
  } finally {
    socket.destroy();
  }
}

function encodeSmtpValue(value: string) {
  const bytes = Buffer.from(value, "utf8");
  try {
    return bytes.toString("base64");
  } finally {
    bytes.fill(0);
  }
}

type SmtpReply = { code: number; lines: string[] };

class SmtpSession {
  private buffer = "";
  private currentReply: SmtpReply | null = null;
  private replies: SmtpReply[] = [];
  private waiting: { resolve: (reply: SmtpReply) => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null;
  private secureWaiting: { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout } | null = null;
  private failure: Error | null = null;
  private secure = false;

  constructor(private readonly socket: tls.TLSSocket, private readonly timeoutMs: number) {
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);
    socket.on("secureConnect", () => {
      this.secure = true;
      if (this.secureWaiting) {
        clearTimeout(this.secureWaiting.timer);
        const { resolve } = this.secureWaiting;
        this.secureWaiting = null;
        resolve();
      }
    });
    socket.on("data", (chunk: string) => this.consume(chunk));
    socket.on("error", () => this.fail());
    socket.on("timeout", () => this.fail());
    socket.on("end", () => this.fail());
  }

  async waitForSecureConnection() {
    if (this.failure) throw this.failure;
    if (this.secure) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new QqMailError("连接 QQ 邮箱 SMTP 超时", "QQ_MAIL_DELIVERY_FAILED", 502)), this.timeoutMs);
      this.secureWaiting = { resolve, reject, timer };
    });
  }

  async command(command: string, expectedCodes: number[]) {
    await this.raw(`${command}\r\n`);
    await this.expect(expectedCodes);
  }

  async raw(value: string) {
    if (this.failure) throw this.failure;
    await new Promise<void>((resolve, reject) => {
      this.socket.write(value, "utf8", (error) => error ? reject(error) : resolve());
    });
  }

  async expect(expectedCodes: number[]) {
    const reply = await this.nextReply();
    if (!expectedCodes.includes(reply.code)) {
      throw new QqMailError("QQ 邮箱 SMTP 认证或投递失败，请检查网络和授权码", "QQ_MAIL_DELIVERY_FAILED", 502);
    }
  }

  private nextReply(): Promise<SmtpReply> {
    if (this.failure) return Promise.reject(this.failure);
    const queued = this.replies.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<SmtpReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new QqMailError("QQ 邮箱 SMTP 响应超时", "QQ_MAIL_DELIVERY_FAILED", 502));
      }, this.timeoutMs);
      this.waiting = { resolve, reject, timer };
    });
  }

  private consume(chunk: string) {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.consumeLine(line);
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  private consumeLine(line: string) {
    const match = /^(\d{3})([ -])(.*)$/u.exec(line);
    if (!match) {
      this.fail();
      return;
    }
    const code = Number(match[1]);
    const divider = match[2];
    const text = match[3];
    if (!this.currentReply) this.currentReply = { code, lines: [text] };
    else if (this.currentReply.code === code) this.currentReply.lines.push(text);
    else {
      this.fail();
      return;
    }
    if (divider === " ") {
      const completed = this.currentReply;
      this.currentReply = null;
      if (this.waiting) {
        clearTimeout(this.waiting.timer);
        const { resolve } = this.waiting;
        this.waiting = null;
        resolve(completed);
      } else {
        this.replies.push(completed);
      }
    }
  }

  private fail(error = new QqMailError("QQ 邮箱 SMTP 连接中断或超时", "QQ_MAIL_DELIVERY_FAILED", 502)) {
    if (this.failure) return;
    this.failure = error;
    if (this.waiting) {
      clearTimeout(this.waiting.timer);
      const { reject } = this.waiting;
      this.waiting = null;
      reject(error);
    }
    if (this.secureWaiting) {
      clearTimeout(this.secureWaiting.timer);
      const { reject } = this.secureWaiting;
      this.secureWaiting = null;
      reject(error);
    }
    this.socket.destroy();
  }
}
