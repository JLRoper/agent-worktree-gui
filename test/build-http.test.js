// What the panel answers over HTTP for the versioned bundle: the shell with its URLs stamped and
// no-store, the assets cacheable hard only under the current version, and GET /api/build carrying
// the version, the boot time and the per-file hashes.
//
// Boots the real server.js (tools/panel-testkit.mjs), so this is the wire, not the source.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ROOT, startPanel } from "../tools/panel-testkit.mjs";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// Every local script src and stylesheet href the shell carries, in the order it carries them.
function assetUrls(html) {
  const out = [];
  for (const tag of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const attr = /\b(?:src|href)\s*=\s*(["'])([^"']+)\1/i.exec(tag[0]);
    if (!attr) continue;
    const url = attr[2];
    if (url.startsWith("/") && !url.startsWith("//")) out.push(url);
  }
  return out;
}

test("the shell is served no-store with every asset URL versioned, and /api/build names the build", async (t) => {
  // A token is set on purpose: /api/build is a read, and reads stay open — the page polls it from
  // whichever machine opened the board.
  const panel = await startPanel({ token: "build-test-token" });
  t.after(() => panel.stop());

  const infoResponse = await fetch(`${panel.base}/api/build`);
  assert.equal(infoResponse.status, 200, "/api/build answers without the panel token");
  assert.equal(infoResponse.headers.get("cache-control"), "no-store", "the answer must never be cached by the page");
  const info = await infoResponse.json();
  assert.match(info.version, /^[0-9a-f]{12}$/, "a short hex version");
  assert.ok(!Number.isNaN(Date.parse(info.bootedAt)), "the boot time is a real timestamp");
  assert.ok(Number.isInteger(info.uptimeSeconds) && info.uptimeSeconds >= 0, "and the uptime is derived from it");
  assert.ok(info.files["index.html"], "the shell is in the payload");
  assert.equal(info.files["app.js"], sha256(await readFile(path.join(ROOT, "public", "app.js"))), "a per-file hash is the sha256 of that file");
  assert.equal(info.files["style.css"], sha256(await readFile(path.join(ROOT, "public", "style.css"))));
  assert.ok(info.files["core/transport.js"], "everything under public/core is hashed too");

  const shell = await fetch(`${panel.base}/`);
  assert.equal(shell.status, 200);
  assert.equal(shell.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(shell.headers.get("cache-control"), "no-store, must-revalidate", "the shell is the one file a browser must not keep");
  const html = await shell.text();
  assert.match(html, new RegExp(`<meta name="panel-build" content="${info.version}"`), "the page can read the build it loaded");
  const urls = assetUrls(html);
  assert.ok(urls.length >= 8, `the shell loads its scripts (saw ${urls.length})`);
  for (const url of urls) {
    assert.ok(url.includes(`?v=${info.version}`), `${url} carries the build version`);
  }
  assert.ok(urls.some((u) => u.startsWith("/app.js?")), "app.js is one of them");
  assert.ok(urls.some((u) => u.startsWith("/style.css?")), "style.css is one of them");

  const index = await fetch(`${panel.base}/index.html`);
  assert.equal(index.headers.get("cache-control"), "no-store, must-revalidate", "the explicit shell URL is no-store too");
});

test("an asset under the current version is cached hard; any other URL is no-store", async (t) => {
  const panel = await startPanel({ token: "build-test-token" });
  t.after(() => panel.stop());
  const info = await (await fetch(`${panel.base}/api/build`)).json();

  const stamped = await fetch(`${panel.base}/app.js?v=${info.version}`);
  assert.equal(stamped.status, 200);
  assert.equal(stamped.headers.get("cache-control"), "public, max-age=31536000, immutable", "the URL names the bytes, so the URL may be kept");
  assert.equal(stamped.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(await stamped.text(), await readFile(path.join(ROOT, "public", "app.js"), "utf8"), "the bytes behind a versioned URL are the file");

  const core = await fetch(`${panel.base}/core/sse.js?v=${info.version}`);
  assert.equal(core.headers.get("cache-control"), "public, max-age=31536000, immutable", "core/ is in the bundle too");

  for (const url of ["/app.js", "/app.js?v=000000000000", "/style.css?v=oldbuild", "/index.html?v=" + info.version]) {
    const r = await fetch(`${panel.base}${url}`);
    assert.equal(r.status, 200, `${url} still serves (a stale URL must not 404 into a broken page)`);
    const cache = r.headers.get("cache-control");
    assert.ok(!/immutable/.test(cache), `${url} may never be filled with bytes it does not name`);
    assert.match(cache, /no-store/, `${url} is revalidated every time`);
    if (!url.startsWith("/index.html")) assert.equal(cache, "no-store", `${url} is not the shell, so it carries no must-revalidate`);
  }
});
