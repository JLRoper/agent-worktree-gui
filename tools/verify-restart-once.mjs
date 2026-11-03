// The one-bounce rule, gated on a seeded restart ledger.
//
//   node tools/verify-restart-once.mjs
//
// The failure this gate pins: two real panel bounces ten minutes apart, the listener pid moving 26496 → 66912,
// and the second carrying the FIRST entry's reason on a tree that had been a newer version since the first.
// At that moment restart.json read `"reason": null` and `"resumedAt": null`, so the ledger could say neither
// what the entry was for nor that it had already run. Three rules answer it, and each has a section here:
//
//   1. an entry is CONSUMED when it runs — the ledger keeps its id with the reason and a `resumedAt`, and the
//      persisted queue stops naming it, before the action that may kill the process;
//   2. a replay of a consumed id is refused, with a journal line, instead of executed;
//   3. a `reason: null` entry is refused at queue time — by the controller, by the boot that reads a queue,
//      and by the HTTP boundary — so no bounce can be written into the ledger without an explanation.
//
// Sections 1–3 drive the real RestartController against a seeded restart file; the only substitutions are the
// actions (a stub spawn, a stub gateway command and a stub proof), so no entry here can bounce anything. Section
// 4 boots a real panel on a port and state dir of its own and reads the same refusals from `/api/restart` plus
// the POST route's own 400 — with `hermesBin` pointed at this Node process and no gateway_state.json in the
// sandbox, so even the un-fixed code cannot reach the live gateway from here.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RestartController } from "../lib/restart.js";
import { freePort, startPanel, waitFor } from "./panel-testkit.mjs";

let failures = 0;
let checks = 0;
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const note = (text) => console.log(`      · ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (fn, what, timeoutMs = 8_000) => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const got = fn();
    if (got) return got;
    if (Date.now() > until) {
      note(`timed out after ${timeoutMs}ms waiting for ${what}`);
      return null;
    }
    await sleep(20);
  }
};

const dir = mkdtempSync(path.join(tmpdir(), "wtgui-restart-once-"));
const home = path.join(dir, "hermes");
mkdirSync(home, { recursive: true });
// A key, because `request()` refuses before the queue when the gateway has nothing to come back with.
writeFileSync(path.join(home, ".env"), "OPENROUTER_API_KEY=test-key\n", "utf8");

// The real controller, with every act it could reach substituted: a panel spawn, a gateway command, the proof,
// and the identity read. Nothing here has a process to kill.
const controllerFor = (file, over = {}) => {
  const counters = { executions: 0, proofs: 0, shutdowns: 0 };
  const controller = new RestartController({
    config: { restartFile: file },
    jobs: { list: () => [], runningJobs: () => [], reconcileRestored: async () => [] },
    home,
    version: over.version || "1.0.0",
    log: () => {},
    credentials: () => null,
    identity: () => null,
    gatewayState: () => null,
    identityWaitMs: 40,
    identityPollMs: 5,
    pollMs: 10,
    proveGateway: () => {
      counters.proofs += 1;
      return { ok: true, stage: "turn", runId: "proof-once", status: "completed", output: "PANEL-RESTART-OK", ms: 3 };
    },
    runGatewayRestart: () => {
      counters.executions += 1;
      return { command: "stub gateway restart", pid: 4242, at: new Date().toISOString() };
    },
    spawnPanel: () => {
      counters.executions += 1;
      return { command: "stub panel replacement", pid: 5150, at: new Date().toISOString() };
    },
    shutdown: () => {
      counters.shutdowns += 1;
    },
    ...over,
  });
  return { controller, counters };
};

const entry = (over = {}) => ({
  id: "once0001",
  target: "panel",
  reason: "serve 1.2.0 after the landing",
  waitFor: "no-thread",
  version: "2.0.0",
  requestedBy: "reader",
  queuedAt: new Date().toISOString(),
  state: "queued",
  ...over,
});

try {
  // ============================================================================================
  console.log("1. a seeded entry runs once, and the ledger records its id, reason and resumedAt");
  const file = path.join(dir, "restart-once.json");
  const seeded = entry();
  writeFileSync(file, JSON.stringify({ queued: [seeded] }), "utf8");

  const first = controllerFor(file);
  first.controller.restoreQueue();
  const ran = await waitUntil(() => first.counters.executions === 1, "the seeded entry to run");
  ok("the seeded entry runs", Boolean(ran), JSON.stringify(first.counters));
  eq("…exactly once", first.counters.executions, 1);
  eq("…and it exits through the shared shutdown path", first.counters.shutdowns, 1);

  const ledger = JSON.parse(readFileSync(file, "utf8"));
  eq("the ledger names the entry it bounced for", ledger.id, seeded.id);
  eq("…with the reason it was given", ledger.reason, seeded.reason);
  eq("…and resumedAt still null, because the replacement has not proved the gateway", ledger.resumedAt, null);
  const consumed = (ledger.consumed || []).find((e) => e.id === seeded.id) || null;
  ok("the ledger's consumed list records the id", Boolean(consumed), JSON.stringify(ledger.consumed || []));
  ok("…with a resumedAt", /^\d{4}-\d{2}-\d{2}T/.test(String(consumed?.resumedAt || "")), String(consumed?.resumedAt || ""));
  eq("…and the reason, so the entry can say what it was for", consumed?.reason, seeded.reason);
  eq("…and the persisted queue no longer asks for it", (ledger.queued || []).filter((e) => e.id === seeded.id).length, 0);
  await sleep(200);
  eq("…and nothing ran it a second time", first.counters.executions, 1);

  // ============================================================================================
  console.log("\n2. a replay of a consumed id is refused, journalled, and not executed");
  // The stale queue a death between the consumed write and the replacement leaves: the same id is still named.
  const replayed = { ...ledger, queued: [{ ...seeded, version: "2.0.0" }] };
  writeFileSync(file, JSON.stringify(replayed), "utf8");

  const second = controllerFor(file);
  second.controller.restoreQueue();
  const journalLine = await waitUntil(
    () => (second.controller.state().journal || []).find((j) => /refused a replay/.test(String(j.text || ""))),
    "the replay refusal to be journalled",
  );
  ok("the replay is refused with a journal line", Boolean(journalLine), JSON.stringify((second.controller.state().journal || []).slice(-4)));
  ok("…naming the consumed id", String(journalLine?.text || "").includes(seeded.id), String(journalLine?.text || ""));
  ok("…and saying when it already ran", /already ran at/.test(String(journalLine?.text || "")), String(journalLine?.text || ""));
  ok("…and that it was dropped instead of executed", /instead of executed/.test(String(journalLine?.text || "")), String(journalLine?.text || ""));
  await sleep(250);
  eq("the replay started nothing", second.counters.executions, 0);
  eq("…and it is not left holding the queue", second.controller.state().queued.length, 0);

  // ============================================================================================
  console.log("\n3. a null reason is refused at queue time");
  const nullSeed = path.join(dir, "restart-null-only.json");
  writeFileSync(
    nullSeed,
    JSON.stringify({ queued: [{ id: "null0001", target: "gateway", reason: null, waitFor: "no-thread", version: "2.0.0", queuedAt: new Date().toISOString() }] }),
    "utf8",
  );
  const nullController = controllerFor(nullSeed);
  nullController.controller.restoreQueue();
  const nullLine = await waitUntil(
    () => (nullController.controller.state().journal || []).find((j) => /records a null reason/.test(String(j.text || ""))),
    "the null-reason refusal to be journalled",
  );
  ok("a null-reason entry read from the ledger is refused with a journal line", Boolean(nullLine), JSON.stringify(nullController.controller.state().journal || []));
  ok("…naming the entry", /null0001/.test(String(nullLine?.text || "")), String(nullLine?.text || ""));
  eq("…and nothing ran", nullController.counters.executions, 0);
  eq("…and the queue is empty", nullController.controller.state().queued.length, 0);

  let ref = null;
  try {
    nullController.controller.request({ target: "panel", reason: null });
  } catch (e) {
    ref = e;
  }
  eq("a request with reason: null is a 400", ref?.status, 400);
  ok("…asking for the reason in the words the board keeps", /needs a reason/.test(String(ref?.message || "")), String(ref?.message || ""));
  eq("…and leaves nothing queued", nullController.controller.state().queued.length, 0);

  // ============================================================================================
  console.log("\n4. the HTTP boundary: the boot refuses both entries, and the route refuses reason: null");
  // A sandbox of its own. Its ledger carries the two shapes above as GATEWAY entries: un-fixed code would run a
  // plain `gateway restart` there (this Node process, no gateway_state.json), which cannot bounce this panel.
  const panelDir = mkdtempSync(path.join(tmpdir(), "wtgui-restart-once-panel-"));
  mkdirSync(path.join(panelDir, "logs"), { recursive: true });
  mkdirSync(path.join(panelDir, "hermes"), { recursive: true });
  writeFileSync(path.join(panelDir, "hermes", ".env"), "OPENROUTER_API_KEY=test-key\n", "utf8");
  writeFileSync(
    path.join(panelDir, "logs", "restart.json"),
    JSON.stringify({
      consumed: [{ id: "boot0001", target: "gateway", reason: "serve 1.2.0 after the landing", resumedAt: "2026-11-02T18:00:00.000Z" }],
      queued: [
        { id: "boot0001", target: "gateway", reason: "serve 1.2.0 after the landing", waitFor: "no-thread", version: "2.0.0", queuedAt: new Date().toISOString() },
        { id: "boot0002", target: "gateway", reason: null, waitFor: "no-thread", version: "2.0.0", queuedAt: new Date().toISOString() },
      ],
    }),
    "utf8",
  );

  const token = "sandbox-token";
  const port = await freePort();
  const panel = await startPanel({
    dir: panelDir,
    port,
    token,
    config: {
      assistant: { enabled: false },
      // Nothing here may reach the reader's gateway: the command is this Node process and the API points at a
      // dead port. A restart that starts at all still cannot bounce anything outside the sandbox.
      hermesBin: process.execPath,
      apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
      refreshSeconds: 3600,
      worktreeSeconds: 3600,
      midSeconds: 3600,
      dormantSeconds: 3600,
      slowSeconds: 3600,
      fetchSeconds: 3600,
      threads: 1,
    },
    env: { API_SERVER_URL: "http://127.0.0.1:9" },
  });
  const api = async (route, init = {}) => {
    const res = await fetch(`${panel.base}${route}`, {
      ...init,
      headers: { "Content-Type": "application/json", "x-panel-token": token, ...(init.headers || {}) },
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  };
  try {
    const bootLines = await waitFor(
      async () => {
        const state = (await api("/api/restart")).body || {};
        const journal = state.journal || [];
        const replay = journal.find((j) => /refused a replay/.test(String(j.text || "")));
        const nil = journal.find((j) => /records a null reason/.test(String(j.text || "")));
        return replay && nil ? { journal, state } : null;
      },
      { what: "the boot to refuse the replayed id and the null reason", timeoutMs: 15_000 },
    );
    ok("the boot refuses the replayed id and the null-reason entry", Boolean(bootLines), JSON.stringify((await api("/api/restart")).body?.journal || []));
    ok("…the replay line names the consumed id", /boot0001/.test(String(bootLines?.journal?.find((j) => /refused a replay/.test(String(j.text || "")))?.text || "")));
    ok("…the null-reason line names its entry", /boot0002/.test(String(bootLines?.journal?.find((j) => /records a null reason/.test(String(j.text || "")))?.text || "")));
    eq("…and neither was left queued", (bootLines?.state?.queued || []).length, 0);
    eq("…and nothing is running", bootLines?.state?.running || null, null);

    const nullPost = await api("/api/restart", { method: "POST", body: JSON.stringify({ target: "panel", reason: null }) });
    eq("POST /api/restart with reason: null is a 400", nullPost.status, 400);
    ok("…asking for the reason", /needs a reason/.test(String(nullPost.body?.error || "")), String(nullPost.body?.error || ""));
    const missingPost = await api("/api/restart", { method: "POST", body: JSON.stringify({ target: "panel" }) });
    eq("…and a missing reason is the same 400", missingPost.status, 400);
    const after = (await api("/api/restart")).body || {};
    eq("…and neither request left a wait behind", (after.queued || []).length, 0);
  } finally {
    await panel.stop();
  }
} catch (e) {
  failures += 1;
  console.log(`FAIL  the gate threw: ${String((e && e.stack) || e)}`);
}

console.log(`\n${checks} checks, ${checks - failures} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
