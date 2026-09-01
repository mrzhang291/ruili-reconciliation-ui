import assert from "node:assert/strict";
import test from "node:test";
import { isRetryableLarkCliError } from "../dist/lib/lark-cli.js";

test("treats transient lark-cli failures as retryable", () => {
  assert.equal(isRetryableLarkCliError("request trigger frequency limit"), true);
  assert.equal(isRetryableLarkCliError("API call failed: server time out error"), true);
  assert.equal(isRetryableLarkCliError("HTTP 504 gateway timeout"), true);
});

test("keeps validation failures non-retryable", () => {
  assert.equal(isRetryableLarkCliError("record field does not exist"), false);
  assert.equal(isRetryableLarkCliError("invalid table id"), false);
});
