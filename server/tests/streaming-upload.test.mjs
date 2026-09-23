import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import test from "node:test";
import express from "express";
import { createStreamingUpload, deleteStoredFilePath } from "../dist/lib/file-storage.js";

test("writes multipart uploads to disk instead of keeping a file buffer in memory", async () => {
  const app = express();
  const upload = createStreamingUpload(1);
  app.post("/upload", upload.single("settlementFile"), (req, res) => {
    const file = req.file;
    assert.ok(file);
    const result = {
      hasBuffer: Object.hasOwn(file, "buffer"),
      existsBeforeCleanup: fs.existsSync(file.path),
      size: file.size,
    };
    deleteStoredFilePath(file.path);
    res.json(result);
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const form = new FormData();
    form.append("settlementFile", new Blob([new Uint8Array(128 * 1024)]), "SHAD01结算单.pdf");
    const response = await fetch(`http://127.0.0.1:${address.port}/upload`, { method: "POST", body: form });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { hasBuffer: false, existsBeforeCleanup: true, size: 128 * 1024 });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
