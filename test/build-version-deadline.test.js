// The build scan is a read of public/ that every static request waits on. A scan (or a stat) that
// never answers used to be a permanent wedge: `pending` was memoised and cleared only by its own
// `finally`, so one stuck fs call took `/`, every asset and `/api/build` with it for the life of the
// process. These cases hold a hanging scan and a hanging stat against the module and require it to
// answer anyway, with the last good bundle, and to say why in the log.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createBuild, readBundle } from "../lib/build-version.js";

const HANG = () => new Promise(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HUNG = Symbol("hung");

// A request is answered from the held bundle; the read it scheduled lands later. Poll for the
// effect rather than requiring it in the same tick.
const until = async (read, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("the log line never arrived");
    await sleep(10);
  }
};

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-build-deadline-"));
  await mkdir(path.join(dir, "core"), { recursive: true });
  await writeFile(path.join(dir, "index.html"), '<html><head><link rel="stylesheet" href="/style.css" /></head><body><script src="/app.js"></script></body></html>\n');
  await writeFile(path.join(dir, "app.js"), "console.log('app');\n");
  await writeFile(path.join(dir, "style.css"), "body { margin: 0; }\n");
  await writeFile(path.join(dir, "core", "util.js"), "export const one = 1;\n");
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("a scan that never answers cannot stop the page being served", async (t) => {
  const dir = await fixture(t);
  const said = [];
  let read = 0;
  const build = createBuild({
    publicDir: dir,
    log: (line) => said.push(line),
    scanTimeoutMs: 120,
    bundleReader: () => {
      read += 1;
      return HANG();
    },
  });

  const answer = await Promise.race([build.current(), sleep(2000).then(() => HUNG)]);

  assert.equal(read, 1, "the read that was injected is the one the module ran");
  assert.notEqual(answer, HUNG, "the request answers instead of waiting for a scan that never returns");
  assert.equal(answer.version, "", "with no bundle ever read the shell is served unversioned");
  assert.match(said.join("\n"), /did not answer within 120 ms/, "and the panel says why it is unversioned");
});

test("a scan that wedges after a good read keeps serving the last good bundle", async (t) => {
  const dir = await fixture(t);
  const said = [];
  let wedged = false;
  const build = createBuild({
    publicDir: dir,
    log: (line) => said.push(line),
    scanTimeoutMs: 120,
    retryAfterMs: 40,
    bundleReader: (publicDir) => (wedged ? HANG() : readBundle(publicDir)),
  });
  t.after(() => build.close());

  const first = await build.current();
  assert.match(first.version, /^[0-9a-f]{12}$/, "the healthy read gives a real version");

  // A file moves, so the watcher owes the bundle a re-read — which now wedges. The request that
  // follows is answered from the bundle already held, not from that read.
  wedged = true;
  await writeFile(path.join(dir, "style.css"), "body { margin: 1px; }\n");
  const answer = await Promise.race([build.current(), sleep(2000).then(() => HUNG)]);

  assert.notEqual(answer, HUNG, "a wedged re-read must not take the shell down");
  assert.equal(answer.version, first.version, "the last good bundle is what the browser gets");
  await until(async () => said.some((l) => /did not answer within 120 ms/.test(l)), 2000);
  assert.match(said.join("\n"), /did not answer within 120 ms/, "with the reason in the log");
});

test("a stat that never answers cannot stop the page being served either", async (t) => {
  const dir = await fixture(t);
  let wedged = false;
  let statCalls = 0;
  const build = createBuild({
    publicDir: dir,
    log: () => {},
    scanTimeoutMs: 120,
    retryAfterMs: 40,
    stat: (target) => {
      statCalls += 1;
      return wedged ? HANG() : stat(target);
    },
  });
  t.after(() => build.close());

  const first = await build.current();
  assert.match(first.version, /^[0-9a-f]{12}$/, "the healthy read gives a real version");
  assert.ok(statCalls > 0, "the stat that was injected is the one the module used");

  // The staleness check stats every bundle file on every request; one that never returns used to
  // hold the request for the process's life.
  wedged = true;
  const answer = await Promise.race([build.current(), sleep(2000).then(() => HUNG)]);

  assert.notEqual(answer, HUNG, "the staleness check is bounded as well");
  assert.equal(answer.version, first.version, "and an unknown staleness serves what is already held");
});

test("a healthy build still reads, moves on an edit and reports the same payload", async (t) => {
  const dir = await fixture(t);
  const build = createBuild({ publicDir: dir, log: () => {} });
  t.after(() => build.close());
  const first = await build.current();
  const second = await build.current();
  assert.equal(second.computedAt, first.computedAt, "an unchanged bundle is still not re-read");

  await writeFile(path.join(dir, "app.js"), "console.log('app, edited');\n");
  const third = await until(async () => {
    const b = await build.current();
    return b.version !== first.version ? b : null;
  });
  assert.notEqual(third.version, first.version, "an edit still moves the build");
  const info = await build.info();
  assert.equal(info.version, third.version, "and info() follows it");
});
