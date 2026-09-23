import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { config } from "../dist/lib/config.js";
import {
  buildQqMailDraft,
  buildQqSmtpData,
  configureQqMail,
  getQqMailStatus,
  QqMailError,
  requireConfiguredQqMailbox,
  sendQqMailMessage,
} from "../dist/lib/qq-mail.js";
import { isLoopbackAddress } from "../dist/routes/mail.js";

test("prepares a QQ mail draft without sending it", () => {
  const draft = buildQqMailDraft({
    to: "finance@example.com; account@example.org",
    subject: "2026 年 5 月对账差异待确认",
    text: "请协助确认销售额明细。",
  }, "sender@qq.com");

  assert.equal(draft.delivery, "NOT_SENT");
  assert.equal(draft.from, "se***@qq.com");
  assert.deepEqual(draft.to, ["finance@example.com", "account@example.org"]);
  assert.equal(draft.smtp.host, "smtp.qq.com");
  assert.equal(draft.smtp.port, 465);
  assert.equal(draft.smtp.secure, true);
});

test("rejects unconfigured, non-ASCII, and header-injection mail inputs before SMTP", () => {
  assert.throws(
    () => requireConfiguredQqMailbox({ found: false }),
    (error) => error instanceof QqMailError && error.code === "QQ_MAIL_NOT_CONFIGURED" && error.statusCode === 409,
  );
  for (const recipient of ["财务@example.com", "finance@example.com\r\nBcc: other@example.com"]) {
    assert.throws(
      () => buildQqMailDraft({ to: recipient, subject: "对账确认", text: "正文" }, "sender@qq.com"),
      (error) => error instanceof QqMailError && error.code === "QQ_MAIL_INVALID_RECIPIENTS",
    );
  }
});

test("does not open an SMTP connection when the configured credential target is empty", async () => {
  const originalTarget = config.qqMail.credentialTarget;
  config.qqMail.credentialTarget = `BillCompare.QQMail.test-missing-${randomUUID()}`;
  try {
    await assert.rejects(
      sendQqMailMessage({ to: "finance@example.com", subject: "对账确认", text: "正文" }),
      (error) => error instanceof QqMailError
        && (error.code === "QQ_MAIL_NOT_CONFIGURED" || error.code === "QQ_MAIL_CREDENTIAL_STORAGE_UNAVAILABLE"),
    );
  } finally {
    config.qqMail.credentialTarget = originalTarget;
  }
});

test("persists QQ sender settings across independent credential-manager calls", { skip: process.platform !== "win32" }, async () => {
  const originalTarget = config.qqMail.credentialTarget;
  const probeTarget = `BillCompare.QQMail.persistence-test-${randomUUID()}`;
  config.qqMail.credentialTarget = probeTarget;

  try {
    await configureQqMail({ email: "persistence-probe@qq.com", authorizationCode: "abc123" });
    const status = await getQqMailStatus();

    assert.equal(status.configured, true);
    assert.equal(status.account, "pe***@qq.com");
  } finally {
    config.qqMail.credentialTarget = originalTarget;
    try {
      execFileSync("cmdkey.exe", [`/delete:${probeTarget}`], { stdio: "ignore" });
    } catch {
      // Best effort cleanup for a credential created exclusively by this test.
    }
  }
});

test("folds long UTF-8 subjects into RFC 2047-safe header lines", () => {
  const data = buildQqSmtpData({
    from: "sender@qq.com",
    to: ["finance@example.com"],
    subject: "差异确认".repeat(45),
    text: "请协助确认。",
  }, new Date("2026-09-22T00:00:00.000Z"));
  const headers = data.split("\r\n\r\n")[0];
  const encodedSubjectLines = headers.split("\r\n").filter((line) => line.startsWith(" =?UTF-8?B?"));

  assert.ok(encodedSubjectLines.length > 1);
  assert.ok(encodedSubjectLines.every((line) => Buffer.byteLength(line, "utf8") <= 75));
  assert.doesNotMatch(headers, /\r\nBcc:/i);
});

test("only treats local loopback addresses as eligible for mail routes", () => {
  for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) assert.equal(isLoopbackAddress(address), true);
  for (const address of [undefined, "10.0.0.4", "192.168.1.2", "::ffff:10.0.0.4"]) assert.equal(isLoopbackAddress(address), false);
});

test("copies the credential blob into managed memory before decoding and clearing it", () => {
  const source = fs.readFileSync(new URL("../src/lib/qq-mail.ts", import.meta.url), "utf8");
  const readCredential = source.slice(source.indexOf("function Read-Credential"), source.indexOf("if ($payload.operation -eq 'status')"));

  const copyIndex = readCredential.indexOf("Marshal]::Copy($credential.CredentialBlob, $secretBytes, 0, $secretBytes.Length)");
  const decodeIndex = readCredential.indexOf("GetString($secretBytes)");
  const clearIndex = readCredential.indexOf("[Array]::Clear($secretBytes, 0, $secretBytes.Length)");
  const freeIndex = readCredential.indexOf("CredFree($credentialPtr)");

  assert.ok(copyIndex >= 0);
  assert.ok(copyIndex < decodeIndex);
  assert.ok(decodeIndex < clearIndex);
  assert.ok(clearIndex < freeIndex);
  assert.doesNotMatch(readCredential, /GetString\(\$credential\.CredentialBlob/);
  assert.doesNotMatch(source.slice(source.indexOf("} elseif ($payload.operation -eq 'read-secret')")), /CredentialBlob/);
});
