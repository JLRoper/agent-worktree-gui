import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { Writable } from "node:stream";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { sendJson } from "../lib/http/respond.js";

const large = { text: "synthetic state ".repeat(1000) };

function get(port, path, encoding, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { "accept-encoding": encoding } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("JSON HTTP responses retain status, encoding and cache headers with streamed gzip", async (t) => {
  const server = createServer((req, res) => {
    if (req.url === "/large") return sendJson(res, 201, large);
    return sendJson(res, 400, { error: "synthetic" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const compressed = await get(port, "/large", "gzip");
  assert.equal(compressed.status, 201);
  assert.equal(compressed.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(compressed.headers["cache-control"], "no-store");
  assert.equal(compressed.headers.vary, "Accept-Encoding");
  assert.equal(compressed.headers["content-encoding"], "gzip");
  assert.equal(compressed.headers["content-length"], undefined);
  assert.equal(compressed.headers["transfer-encoding"], "chunked");
  assert.deepEqual(JSON.parse(gunzipSync(compressed.body)), large);
  const head = await get(port, "/large", "gzip", "HEAD");
  assert.equal(head.status, 201);
  assert.equal(head.headers["content-encoding"], "gzip");
  assert.equal(head.headers["content-length"], undefined);
  assert.equal(head.body.length, 0);
  const plain = await get(port, "/large", "identity");
  assert.equal(plain.status, 201);
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.equal(Number(plain.headers["content-length"]), plain.body.length);
  assert.deepEqual(JSON.parse(plain.body), large);
  const small = await get(port, "/small", "gzip");
  assert.equal(small.status, 400);
  assert.equal(small.headers["content-encoding"], undefined);
  assert.deepEqual(JSON.parse(small.body), { error: "synthetic" });
});

test("gzip commits headers immediately but completes without blocking the caller", async () => {
  const chunks = [];
  const res = new Writable({ write(chunk, encoding, cb) { chunks.push(chunk); cb(); } });
  res.req = { headers: { "accept-encoding": "gzip" } };
  res.writeHead = function (code, headers) { this.code = code; this.headers = headers; };
  assert.strictEqual(sendJson(res, 202, large), res);
  assert.equal(res.code, 202);
  assert.equal(res.headers["Content-Encoding"], "gzip");
  assert.equal(res.headers["Content-Length"], undefined);
  assert.equal(res.writableFinished, false);
  await once(res, "finish");
  assert.deepEqual(JSON.parse(gunzipSync(Buffer.concat(chunks))), large);
});

test("an aborted compressed response leaves the server able to answer", async (t) => {
  const body = { text: randomBytes(512 * 1024).toString("hex") };
  const server = createServer((req, res) => sendJson(res, 200, req.url === "/big" ? body : { ok: true }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  await new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/big", headers: { "accept-encoding": "gzip" } }, (res) => {
      res.once("close", resolve);
      res.destroy();
    });
    req.once("error", reject);
    req.end();
  });
  const healthy = await get(port, "/health", "identity");
  assert.deepEqual(JSON.parse(healthy.body), { ok: true });
});
