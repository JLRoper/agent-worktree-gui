// GET /api/pipeline-doc — the panel reading one document for the map's `?doc=`.
//
// The route exists because a browser will not fetch the factory on :8090 from a page served on :7331 (no CORS
// header), and the drawing must name the bytes it drew. So the assertions are about the WIRE: the exact bytes come
// back as `text`, their sha256 is the hash of those bytes, and every refusal is a real status with a sentence — a
// non-loopback host, a non-http scheme, an oversized body, a dead port, a redirect that leaves loopback.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { freePort, startPanel } from "../tools/panel-testkit.mjs";

const DOC = '[{"id":"poc-breaking-suite","title":"POC-breaking suite — six layer questions, two answered","stageCount":9}]';
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

let panel = null;
let fixture = null;
let base = null;
const big = Buffer.alloc(5 * 1024 * 1024, 0x20);

test.before(async () => {
  fixture = createServer((req, res) => {
    if (req.url === "/doc.json") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      return res.end(DOC);
    }
    if (req.url === "/redirect-me") {
      res.writeHead(302, { location: "/doc.json" });
      return res.end();
    }
    if (req.url === "/redirect-out") {
      res.writeHead(302, { location: "http://example.com/doc.json" });
      return res.end();
    }
    if (req.url === "/big") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(big);
    }
    if (req.url === "/empty") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end();
    }
    res.writeHead(500, { "content-type": "application/json" });
    res.end('{"error":"boom"}');
  });
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${fixture.address().port}`;
  panel = await startPanel({});
});

test.after(async () => {
  if (panel) await panel.stop();
  if (fixture) await new Promise((resolve) => fixture.close(resolve));
});

const read = async (target) => {
  const r = await fetch(`${panel.base}/api/pipeline-doc?url=${encodeURIComponent(target)}`);
  return { status: r.status, body: await r.json() };
};

test("the exact bytes come back as text, with the sha256 the page names", async () => {
  const { status, body } = await read(`${base}/doc.json`);
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.text, DOC, "the document is the source's, byte for byte");
  assert.equal(body.bytes, Buffer.byteLength(DOC));
  assert.equal(body.sha256, sha(Buffer.from(DOC)), "the hash is over the bytes as received");
  assert.equal(body.source, `${base}/doc.json`);
  assert.equal(body.finalUrl, `${base}/doc.json`);
  assert.match(body.contentType, /application\/json/);
});

test("a loopback redirect is followed and the provenance names where the bytes came from", async () => {
  const { status, body } = await read(`${base}/redirect-me`);
  assert.equal(status, 200);
  assert.equal(body.text, DOC);
  assert.equal(body.finalUrl, `${base}/doc.json`);
  assert.equal(body.source, `${base}/redirect-me`, "source stays the URL the reader asked for");
});

test("a host that is not loopback is refused before any request is made", async () => {
  const outside = await read("http://example.com/doc.json");
  assert.equal(outside.status, 403);
  assert.match(outside.body.error, /only a loopback URL is read/);

  const redirected = await read(`${base}/redirect-out`);
  assert.equal(redirected.status, 403, "a loopback URL that redirects off loopback must not be read");
  assert.match(redirected.body.error, /example\.com/);
});

test("a missing, relative or non-http url is a 400", async () => {
  const missing = await fetch(`${panel.base}/api/pipeline-doc`);
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /`url` is required/);

  for (const [bad, re] of [["/doc.json", /absolute http\(s\) URL/], ["not a url", /absolute http\(s\) URL/], ["file:///etc/passwd", /must be http or https/]]) {
    const { status, body } = await read(bad);
    assert.equal(status, 400, `${bad} should be a 400`);
    assert.match(body.error, re);
  }
});

test("a body over the cap is refused whole rather than truncated", async () => {
  const { status, body } = await read(`${base}/big`);
  assert.equal(status, 413);
  assert.match(body.error, /larger than 4096 KiB/);
});

test("a dead port, a 500 and an empty body are each a 502 with the reason", async () => {
  const deadPort = await freePort();
  const dead = await read(`http://127.0.0.1:${deadPort}/doc.json`);
  assert.equal(dead.status, 502);
  assert.match(dead.body.error, /could not reach/);

  const boom = await read(`${base}/boom`);
  assert.equal(boom.status, 502);
  assert.match(boom.body.error, /answered HTTP 500/);

  const empty = await read(`${base}/empty`);
  assert.equal(empty.status, 502);
  assert.match(empty.body.error, /empty body/);
});
