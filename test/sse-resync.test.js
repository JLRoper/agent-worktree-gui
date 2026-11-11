import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

const source = (file) => readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8");

function fixture() {
  let now = 1_800_000_000_000;
  const requests = [];
  const snapshots = [];
  const banners = [];
  const elements = new Map();
  class Clock extends Date { static now() { return now; } }
  class EventSource {
    constructor(url) { this.url = url; this.readyState = 0; this.listeners = new Map(); }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }
    emit(type, data = {}) {
      for (const listener of this.listeners.get(type) || []) listener({ data: JSON.stringify(data) });
    }
    close() { this.readyState = 2; }
  }
  const state = { es: null, paused: false, lastEventAt: null, lastTransportAt: null, lastSnapshotAt: null,
    snapshotGeneration: 0, events: 0, jobs: new Map(), projects: new Map() };
  const context = vm.createContext({
    window: {}, state, EventSource, Date: Clock, Headers, AbortController, URL, URLSearchParams, setTimeout, clearTimeout,
    location: { search: "", href: "http://example.test/" }, localStorage: { getItem: () => null }, history: {},
    $: (id) => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); },
    applySnapshot: (snapshot) => snapshots.push(snapshot),
    showBanner: (message) => banners.push(message),
    queueRow: () => {},
    fetch: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
  });
  for (const file of ["core/liveness.js", "core/transport.js", "core/sse.js"]) vm.runInContext(source(file), context);
  const app = source("app.js").replace(/\r\n/g, "\n");
  const start = app.indexOf('setInterval(() => {\n  if (state.paused) return;\n  // The Gateway tab');
  const end = app.indexOf("}, 30000);", start);
  assert.ok(start >= 0 && end > start, "the actual safety-net interval is present");
  context.matrixSettingsShowing = () => false;
  context.setInterval = (fn, ms) => { assert.equal(ms, 30000); context.tick = fn; };
  vm.runInContext(app.slice(start, end + "}, 30000);".length), context);
  return { context, state, requests, snapshots, banners, advance: (ms) => { now += ms; }, now: () => now,
    respond: (index, snapshot, ok = true) => requests[index].resolve({ ok, status: ok ? 200 : 503, json: async () => snapshot }) };
}

test("heartbeats do not trigger idle reads, but anti-entropy repairs a missed event", async () => {
  const f = fixture();
  f.context.connect();
  const es = f.state.es;
  es.readyState = 1;
  es.emit("open");
  es.emit("snapshot", { version: 1 });
  for (let i = 0; i < 3; i++) {
    f.advance(30000);
    es.emit("heartbeat", { pool: { inFlight: 0 } });
    f.context.tick();
  }
  assert.equal(f.requests.length, 0);
  assert.equal(f.state.lastSnapshotAt, f.now() - 90000, "heartbeat is not snapshot freshness");
  f.advance(30000);
  es.emit("heartbeat", { pool: { inFlight: 0 } });
  f.context.tick();
  assert.equal(f.requests.length, 1);
  const pending = f.context.resync({ automatic: true });
  assert.equal(f.requests.length, 1, "overlapping automatic reads share the request");
  f.respond(0, { version: 2 });
  await pending;
  assert.deepEqual(f.snapshots.map((s) => s.version), [1, 2]);
  assert.equal(f.state.lastSnapshotAt, f.now());
});

test("safety net still works when the liveness helper failed to load", async () => {
  const f = fixture();
  f.context.connect();
  const es = f.state.es;
  es.readyState = 1;
  es.emit("open");
  es.emit("snapshot", { version: 1 });
  delete f.context.wtLive;
  f.advance(120000);
  es.emit("heartbeat", { pool: {} });
  f.context.tick();
  assert.equal(f.requests.length, 1);
  const pending = f.context.resync({ automatic: true });
  f.respond(0, { version: 2 });
  await pending;
  assert.deepEqual(f.snapshots.map((s) => s.version), [1, 2]);
});

test("boot uses the first stream snapshot, with HTTP fallback on error or timeout", async () => {
  const bootLine = source("app.js").split(/\r?\n/).find((line) => line.includes("if (!(await connect({ waitForSnapshot: true }))"));
  assert.ok(bootLine, "boot waits for the stream before deciding whether to fetch");
  const healthy = fixture();
  const boot = vm.runInContext(`(async () => { ${bootLine} })()`, healthy.context);
  healthy.state.es.readyState = 1;
  healthy.state.es.emit("open");
  healthy.state.es.emit("snapshot", { version: 1 });
  await boot;
  assert.equal(healthy.requests.length, 0, "the first snapshot avoids a duplicate HTTP request");

  const failed = fixture();
  const retrying = vm.runInContext(`(async () => { ${bootLine} })()`, failed.context);
  failed.state.es.emit("error");
  await Promise.resolve();
  assert.equal(failed.requests.length, 1);
  failed.respond(0, { version: 2 });
  await retrying;
  assert.deepEqual(failed.snapshots.map((s) => s.version), [2]);

  const stalled = fixture();
  let expire;
  stalled.context.setTimeout = (fn, ms) => { assert.equal(ms, 10000); expire = fn; return 1; };
  stalled.context.clearTimeout = () => {};
  const waiting = stalled.context.connect({ waitForSnapshot: true });
  expire();
  assert.equal(await waiting, false, "a stream that never sends a snapshot is bounded");
});

test("disconnect, reconnect snapshot, failed reads, and pause retain recovery", async () => {
  const f = fixture();
  f.context.connect();
  const es = f.state.es;
  es.readyState = 1;
  es.emit("open");
  es.emit("snapshot", { version: 1 });
  es.readyState = 0;
  es.emit("error");
  f.context.tick();
  assert.equal(f.requests.length, 1, "disconnected streams fetch on the safety-net tick");
  const pending = f.context.resync({ automatic: true });
  es.readyState = 1;
  es.emit("open");
  es.emit("snapshot", { version: 3 });
  f.respond(0, { version: 2 });
  await pending;
  assert.deepEqual(f.snapshots.map((s) => s.version), [1, 3], "an older pending automatic read cannot overwrite a reconnect snapshot");
  f.advance(30000);
  es.emit("heartbeat", { pool: {} });
  f.context.tick();
  assert.equal(f.requests.length, 1, "reconnect snapshot makes another read unnecessary");
  es.readyState = 0;
  f.context.tick();
  const failed = f.context.resync({ automatic: true });
  f.respond(1, { error: "synthetic failure" }, false);
  await failed;
  assert.match(f.banners.at(-1), /synthetic failure/);
  f.context.tick();
  assert.equal(f.requests.length, 3, "a failed read does not reset freshness or suppress retries");
  const paused = f.context.resync({ automatic: true });
  f.state.paused = true;
  f.respond(2, { version: 4 });
  await paused;
  f.context.tick();
  assert.deepEqual(f.snapshots.map((s) => s.version), [1, 3]);
  assert.equal(f.requests.length, 3, "paused board neither applies a pending automatic read nor starts another");
});

test("a reconnected stream missing its initial snapshot still triggers a catch-up", async () => {
  const f = fixture();
  f.context.connect();
  const es = f.state.es;
  es.readyState = 1;
  es.emit("open");
  es.emit("snapshot", { version: 1 });
  es.readyState = 0;
  es.emit("error");
  es.readyState = 1;
  es.emit("open");
  es.emit("heartbeat", { pool: {} });
  f.context.tick();
  assert.equal(f.requests.length, 1, "heartbeat cannot stand in for the reconnect snapshot");
  const pending = f.context.resync({ automatic: true });
  f.respond(0, { version: 2 });
  await pending;
  assert.deepEqual(f.snapshots.map((s) => s.version), [1, 2]);
  es.emit("snapshot", { data: { version: 3 } });
  assert.equal(f.state.awaitingStreamSnapshot, false);
  assert.deepEqual(f.snapshots.map((s) => s.version), [1, 2, 3], "both snapshot envelope shapes work");
});

test("user refresh after a write waits for an in-flight read and is not lost", async () => {
  const f = fixture();
  const first = f.context.resync({ automatic: true });
  const afterWrite = f.context.resync();
  const anotherWrite = f.context.resync();
  assert.strictEqual(afterWrite, anotherWrite);
  assert.equal(f.requests.length, 1);
  f.respond(0, { version: 1 });
  await first;
  await Promise.resolve();
  assert.equal(f.requests.length, 2, "one follow-up read starts after the first settles");
  f.respond(1, { version: 2 });
  await afterWrite;
  assert.deepEqual(f.snapshots.map((s) => s.version), [1, 2]);
});
