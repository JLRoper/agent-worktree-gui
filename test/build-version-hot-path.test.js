// The hot path: a static request reads the bundle the watcher already proved. It may never wait on
// the staleness check, on a re-read, or on a stat — the check is a chain of awaits, and on a loaded
// host every link in it is a turn of a loop that may be seconds away. These cases hold a stat and a
// re-read against the module and require the request to be answered anyway, with the last good
// bundle, in a time that cannot contain a check at all.
//
// They fail on the version this replaces: it ran `staleCheck()` inside `get()`, so a hung stat held
// the request for the whole of `scanTimeoutMs` (1200 ms in production), and a bundle the watcher had
// marked dirty was re-read before the response was written.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBuild, readBundle } from "../lib/build-version.js";
import { serveStatic } from "../lib/http/static.js";
import { syncTiming } from "../lib/sync-timing.js";

const HANG = () => new Promise(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Generous enough that a loaded machine cannot flake it, far below the 1200 ms bound the old path
// would have waited out — a request that enters the check cannot come in under it.
const INSTANT = 250;

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-build-hot-"));
  await mkdir(path.join(dir, "core"), { recursive: true });
  await writeFile(path.join(dir, "index.html"), '<html><head><link rel="stylesheet" href="/style.css" /></head><body><script src="/app.js"></script></body></html>\n');
  await writeFile(path.join(dir, "app.js"), "console.log('app');\n");
  await writeFile(path.join(dir, "style.css"), "body { margin: 0; }\n");
  await writeFile(path.join(dir, "core", "util.js"), "export const one = 1;\n");
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("a slow synchronous watcher setup is named in diagnostics", async (t) => {
  const dir = await fixture(t);
  const before = syncTiming.stats().count;
  const build = createBuild({
    publicDir: dir,
    watchFn: () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 140);
      return { unref() {}, on() {}, close() {} };
    },
  });
  t.after(() => build.close());
  await build.current();
  const stats = syncTiming.stats();
  assert.ok(stats.count > before);
  assert.ok(stats.recent.some((r) => r.phase === "static watcher setup" && r.ms >= 250));
});

test("a request is not held by a staleness check that will not answer", async (t) => {
  const dir = await fixture(t);
  let wedged = false;
  const build = createBuild({
    publicDir: dir,
    log: () => {},
    // The backstop is due on every request, so the old path reaches the stat sweep every time.
    backstopMs: 0,
    // Far longer than the assertion below: if the request joins the check, this is the wait.
    scanTimeoutMs: 5000,
    retryAfterMs: 20,
    stat: (target) => (wedged ? HANG() : stat(target)),
  });
  t.after(() => build.close());

  const first = await build.current();
  assert.match(first.version, /^[0-9a-f]{12}$/, "the healthy read gives a real version");

  wedged = true;
  const started = performance.now();
  const answer = await build.current();
  const took = performance.now() - started;

  assert.equal(answer.version, first.version, "the held bundle is the answer while the disk is silent");
  assert.ok(took < INSTANT, `a request must not wait on the check (waited ${took.toFixed(1)} ms)`);
});

test("a request is served the last good bundle while a re-read the watcher asked for is in flight", async (t) => {
  const dir = await fixture(t);
  let gate = false;
  let release;
  const build = createBuild({
    publicDir: dir,
    log: () => {},
    scanTimeoutMs: 5000,
    bundleReader: async (publicDir) => {
      if (gate) await new Promise((r) => { release = r; });
      return readBundle(publicDir);
    },
  });
  t.after(() => build.close());

  const first = await build.current();
  gate = true;

  // An edit the watcher sees: the module owes a re-read, and that read is now held open.
  await writeFile(path.join(dir, "style.css"), "body { margin: 2px; }\n");
  await sleep(25); // the watcher's event, and the debounce that folds a burst into one read

  const started = performance.now();
  const held = await build.current();
  const took = performance.now() - started;

  assert.equal(held.version, first.version, "the request is answered from the bundle already held");
  assert.ok(took < INSTANT, `a pending re-read cannot hold the response (waited ${took.toFixed(1)} ms)`);

  // The read is still the one that moves the build, once it lands.
  for (let i = 0; !release && i < 200; i++) await sleep(10);
  assert.equal(typeof release, "function", "the watcher's read was started and is what is held open");
  release();
  const deadline = Date.now() + 3000;
  let next = await build.current();
  while (next.version === first.version && Date.now() < deadline) {
    await sleep(10);
    next = await build.current();
  }
  assert.notEqual(next.version, first.version, "the watcher's read still moves the build");
});

test("a versioned asset is immutable only while the held build still describes the bytes", async () => {
  const { PUBLIC_DIR } = await import("../lib/http/static.js");
  const app = path.join(PUBLIC_DIR, "app.js");
  const held = await stat(app);
  const version = "a".repeat(12);
  const buildOf = (stamp) => ({ current: async () => ({ version, files: { "app.js": "held-hash" }, stamps: { "app.js": stamp } }) });

  const call = async (stamp) => {
    const res = { code: null, headers: null, body: null, writeHead(c, h) { this.code = c; this.headers = h; return this; }, end(b) { this.body = b; } };
    await serveStatic({ url: `/app.js?v=${version}`, headers: {} }, res, "/app.js", buildOf(stamp));
    return res;
  };

  const fresh = await call({ mtimeMs: held.mtimeMs, size: held.size });
  assert.equal(fresh.headers["Cache-Control"], "public, max-age=31536000, immutable", "the bytes are the ones the version names, so the URL may be kept");

  // The watcher's debounce is what lets the held build trail a write: the URL for the previous
  // bytes must not be filled with the new ones for a year.
  const stale = await call({ mtimeMs: held.mtimeMs - 1, size: held.size });
  assert.equal(stale.headers["Cache-Control"], "no-store", "a file the held build has not caught up with is never cached as immutable");
});

test("a static file is written to the socket without waiting for the check", async (t) => {
  const dir = await fixture(t);
  let wedged = false;
  const build = createBuild({
    publicDir: dir,
    log: () => {},
    backstopMs: 0,
    scanTimeoutMs: 5000,
    retryAfterMs: 20,
    stat: (target) => (wedged ? HANG() : stat(target)),
  });
  t.after(() => build.close());
  await build.current();

  // The exact call serveStatic makes for every file it serves: `await build.current()`.
  const res = {
    code: null,
    headers: null,
    body: null,
    writeHead(code, headers) {
      this.code = code;
      this.headers = headers;
      return this;
    },
    end(body) {
      this.body = body;
    },
  };
  const req = { url: "/", headers: {} };

  wedged = true;
  const started = performance.now();
  await serveStatic(req, res, "/", build);
  const took = performance.now() - started;

  assert.equal(res.code, 200, "the shell is still served");
  assert.ok(res.body && res.body.length > 0, "with its bytes");
  assert.ok(took < INSTANT, `serving the shell must not enter the check (took ${took.toFixed(1)} ms)`);
});
