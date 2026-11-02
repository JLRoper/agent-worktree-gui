// The restart storm, gated on its own port and state dir.
//
//   node tools/verify-restart-idempotence.mjs
//
// The storm is three small holes in the same loop: a boot replays a brief whose work already landed, a restart is
// accepted with no reason (so nothing on the board says what it was for, and the next boot asks for it again), and
// a queued wait cannot be withdrawn once it is holding a slot. This gate boots the REAL panel against a STUB
// gateway, on a port and a state dir of its own, and proves each one from the outside:
//
//   1. a boot with a landed brief starts nothing — the debt is settled as "landed", the journal says
//      "replay skipped: already landed", the digest stops advertising it and NO run is POSTed;
//   2. a reasonless POST /api/restart is refused with 400 and leaves nothing queued;
//   3. a waiting entry can be cancelled (200, queue empty) and no restart happens even once the turn it was
//      waiting for has ended — the case a cancel has to win.
//
// Nothing here can bounce the live gateway: the controller's `hermes` binary is this Node process (so `gateway
// restart` exits without doing anything), and $HERMES_HOME is the sandbox's own, with no gateway_state.json in it.
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, git, slash, startPanel, waitFor } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const SCRATCH = path.join(process.env.LOCALAPPDATA || process.env.TEMP || ".", "Temp", "wag", "f4594c2d");

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

// ---- a stub gateway -------------------------------------------------------------------------
// Only what the panel asks of a real one: capabilities, run submission, a pollable status, an events stream and a
// stop. A run it is given stays RUNNING until this file settles it, which is what holds a restart in `waiting`.
function makeStub() {
  const state = { posts: [], runs: new Map(), seq: 0 };
  const timers = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/v1/capabilities") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({ version: "0.22.2-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true } }),
      );
      return;
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        state.seq += 1;
        const id = `run-${state.seq}`;
        state.runs.set(id, { id, status: "running", output: "", session: body.session_id || null, input: String(body.input || "") });
        state.posts.push({ id, session: body.session_id || null, input: String(body.input || ""), cwd: body.cwd || null, at: Date.now() });
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ run_id: id }));
      });
      return;
    }
    const one = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (one && req.method === "GET") {
      const record = state.runs.get(one[1]);
      if (!record) return res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "Run not found", code: "run_not_found" } }));
      return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ run_id: record.id, status: record.status, output: record.output }));
    }
    if (one && req.method === "POST") {
      // stop
      const record = state.runs.get(one[1]);
      if (record) record.status = "stopped";
      return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
    }
    if (/^\/v1\/runs\/[^/]+\/events$/.test(url.pathname)) {
      const id = url.pathname.split("/")[3];
      const record = state.runs.get(id);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      if (!record) return res.end();
      const frame = (e) => `event: ${e.event}\ndata: ${JSON.stringify(e)}\n\n`;
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
        if (record.status === "completed") {
          clearInterval(timer);
          res.write(frame({ event: "run.completed", output: record.output }));
          res.end();
        } else if (record.status === "stopped") {
          clearInterval(timer);
          res.write(frame({ event: "run.stopped", output: "" }));
          res.end();
        } else if (ticks > 150) {
          clearInterval(timer);
          res.end();
        }
      }, 200);
      timers.push(timer);
      req.on("close", () => clearInterval(timer));
      return;
    }
    res.writeHead(404).end("{}");
  });
  const close = () =>
    new Promise((r) => {
      for (const t of timers) clearInterval(t);
      server.closeAllConnections?.();
      server.close(() => r());
    });
  return { state, server, close };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the sandbox: its own dir, its own repo, its own port ------------------------------------
mkdirSync(SCRATCH, { recursive: true });
const dir = mkdtempSync(path.join(SCRATCH, "restart-idem-"));
const repos = path.join(dir, "repos");
const repo = path.join(repos, "sandbox-repo");
const wt = path.join(repo, ".worktrees", "landed-brief");
mkdirSync(path.join(repo, ".worktrees"), { recursive: true });
mkdirSync(path.join(dir, "hermes"), { recursive: true });
// A provider key, because a restart is refused without one — and this gate must reach the queue, not the preflight.
writeFileSync(path.join(dir, "hermes", ".env"), "OPENROUTER_API_KEY=sk-or-v1-sandbox\n", "utf8");

git(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# the sandbox repo, for restart idempotence\n", "utf8");
git(repo, ["add", "."]);
git(repo, ["commit", "-q", "-m", "first"]);

// The brief's work: one commit on its own branch, then the SAME change on main as a cherry-pick. That is the
// cherry-picked case a count cannot see — the branch is one commit ahead, and it has landed.
git(repo, ["checkout", "-q", "-b", "feature/landed-brief"]);
writeFileSync(path.join(repo, "landed.txt"), "the brief that already landed\n", "utf8");
git(repo, ["add", "."]);
git(repo, ["commit", "-q", "-m", "the brief, done"]);
const briefSha = git(repo, ["rev-parse", "HEAD"]);
git(repo, ["checkout", "-q", "main"]);
// A second commit on main FIRST: within the same second the cherry-pick would otherwise reproduce the branch's
// commit byte for byte (same parent, tree, message and identity), and the fixture would stop being "ahead".
writeFileSync(path.join(repo, "base.txt"), "landed first, so the cherry-pick is its own commit\n", "utf8");
git(repo, ["add", "."]);
git(repo, ["commit", "-q", "-m", "the base moves on"]);
git(repo, ["cherry-pick", briefSha]);
git(repo, ["worktree", "add", "-q", slash(wt), "feature/landed-brief"]);
const cherry = git(wt, ["cherry", "-v", "main", "HEAD"]);
const ahead = git(wt, ["rev-list", "--count", "main..HEAD"]);

console.log("0. a sandbox of its own, and a brief that landed by patch-id");
note(`temp root ${dir}`);
ok("the fixture branch is AHEAD of main (so ahead-by-N would call it unlanded)", ahead === "1", `ahead ${ahead}`);
ok("…and every one of its commits is on main by patch-id", /^- /.test(cherry) && !/^\+ /.test(cherry), cherry);

const stub = makeStub();
await new Promise((r) => stub.server.listen(0, "127.0.0.1", r));
const stubUrl = `http://127.0.0.1:${stub.server.address().port}`;
const port = await freePort();
const token = "sandbox-token";
let booted = 0;
const boot = (extra = {}) =>
  startPanel({
    dir,
    port,
    keep: true,
    reuseConfig: booted++ > 0,
    token,
    env: { API_SERVER_URL: stubUrl },
    config: {
      refreshSeconds: 3600,
      worktreeSeconds: 3600,
      midSeconds: 3600,
      dormantSeconds: 3600,
      slowSeconds: 3600,
      fetchSeconds: 3600,
      threads: 1,
      defaultCwd: repo,
      scanRoots: [repos],
      apiServer: { url: stubUrl, key: "sandbox-key" },
      // A `gateway restart` from this panel runs THIS file with the args ["gateway","restart"], which exits at once
      // and touches nothing. The fallback has no gateway_state.json to stop, so it refuses for want of a pid.
      hermesBin: process.execPath,
      assistant: { enabled: true, autonomy: "draft", seconds: 2, maxWakesPerHour: 20 },
      ...extra,
    },
  });

const api = async (base, route, init = {}) => {
  const res = await fetch(`${base}${route}`, {
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
const assistantOf = async (base) => (await api(base, "/api/assistant")).body || {};
const restartOf = async (base) => (await api(base, "/api/restart")).body || {};

let panel = null;
try {
  // First boot: a panel with no debt, so the assistant file exists for the second boot to edit. It is stopped
  // before the board has anything to do.
  panel = await boot();
  ok("the sandbox answers on a port of its own", !existsSync(path.join(ROOT, "data", String(port))), `port ${port}`);
  ok("…and its state dir is the sandbox's", slash(panel.configPath).startsWith(slash(dir)), slash(panel.configPath));
  await panel.stop();

  // The debt a restart left behind: a SPAWN IN whose work is already on main, reported lost before the restart.
  const asstFile = path.join(dir, "logs", "assistant.json");
  const store = existsSync(asstFile) ? JSON.parse(readFileSync(asstFile, "utf8")) : { version: 2, settings: {} };
  store.spawnIntents = [
    {
      id: "landed01",
      turnId: "turn-landed",
      thread: "wtgui-landed-brief",
      at: Date.now() - 10 * 60_000,
      target: wt,
      existing: true,
      prompt: "the brief that already landed",
      outcome: "lost",
      alertId: null,
      jobThread: null,
      reportedAt: new Date(Date.now() - 8 * 60_000).toISOString(),
      tree: wt,
      branch: "feature/landed-brief",
    },
  ];
  mkdirSync(path.dirname(asstFile), { recursive: true });
  writeFileSync(asstFile, JSON.stringify(store, null, 1), "utf8");

  const postsBefore = stub.state.posts.length;
  panel = await boot();

  // ============================================================================================
  console.log("\n1. a boot with a landed brief starts nothing");
  const settled = await waitFor(
    async () => {
      const s = await assistantOf(panel.base);
      return (s.journal || []).find((j) => /replay skipped: already landed/.test(String(j.text || ""))) || null;
    },
    { what: "the boot to settle the landed debt", timeoutMs: 30_000 },
  );
  ok("the boot journals `replay skipped: already landed`", Boolean(settled), JSON.stringify((await assistantOf(panel.base)).journal || []).slice(0, 400));
  ok("…naming the brief and the evidence", /the brief that already landed|SPAWN IN/.test(String(settled?.text || "")), String(settled?.text || ""));
  ok("…and says nothing was started", /nothing was started/.test(String(settled?.text || "")), String(settled?.text || ""));

  await sleep(1_500);
  ok("no run was POSTed to the gateway", stub.state.posts.length === postsBefore, `${stub.state.posts.length - postsBefore} new post(s)`);
  const board = await api(panel.base, "/api/jobs");
  ok("no job exists for the brief", !(board.body?.jobs || []).some((j) => /already landed/.test(String(j.prompt || ""))), JSON.stringify((board.body?.jobs || []).map((j) => j.prompt)));
  const digest = String((await assistantOf(panel.base)).digest || "");
  ok("the digest no longer advertises the debt", !/already landed/.test(digest), digest.slice(0, 300));
  const reloaded = JSON.parse(readFileSync(asstFile, "utf8")).spawnIntents?.[0] || {};
  eq("…and the skip is on disk, so the next boot does not re-owe it", [reloaded.outcome, Boolean(reloaded.landedAt)], ["landed", true]);

  // ============================================================================================
  console.log("\n2. a reasonless restart is refused with 400");
  const noReason = await api(panel.base, "/api/restart", { method: "POST", body: JSON.stringify({ target: "gateway" }) });
  eq("POST /api/restart with no reason is a 400", noReason.status, 400);
  ok("…and the refusal asks for the reason", /reason/i.test(String(noReason.body?.error || "")), String(noReason.body?.error || ""));
  const blank = await api(panel.base, "/api/restart", { method: "POST", body: JSON.stringify({ target: "gateway", reason: "   " }) });
  eq("…and a blank reason is the same 400", blank.status, 400);
  eq("…and nothing was left queued", ((await restartOf(panel.base)).queued || []).length, 0);
  // The gate is `authorised`, the same one the POST above uses: from this host's loopback it says yes without a
  // token, so the proof is the shared shape — a request WITH a token is accepted, and the route validates its body.
  const emptyId = await api(panel.base, "/api/restart/cancel", { method: "POST", body: JSON.stringify({}) });
  eq("…and a cancel with no id is a 400, not a silent success", emptyId.status, 400);

  // ============================================================================================
  console.log("\n3. a waiting entry can be cancelled, and then no restart happens");
  // A live turn on a thread of its own: the restart waits for it, which is the only state a cancel may drop.
  const spawn = await api(panel.base, "/api/agents", { method: "POST", body: JSON.stringify({ prompt: "hold the turn", cwd: wt, existing: true }) });
  eq("a worker run was started to hold the wait", spawn.status, 202);
  const thread = spawn.body?.job?.thread || null;
  ok("…on a thread of its own", Boolean(thread), String(thread));
  const live = await waitFor(async () => (await api(panel.base, "/api/jobs")).body?.jobs?.find((j) => j.thread === thread && ["running", "starting", "waiting"].includes(String(j.status))), {
    what: "the hold to be live",
    timeoutMs: 20_000,
  });
  ok("…and the panel sees it running", Boolean(live), JSON.stringify((await api(panel.base, "/api/jobs")).body?.jobs || []));

  const queued = await api(panel.base, "/api/restart", { method: "POST", body: JSON.stringify({ target: "gateway", reason: "restart to pick up the sandbox config", waitFor: thread }) });
  eq("the restart is accepted (202)", queued.status, 202);
  const id = queued.body?.restart?.id || null;
  ok("…and it waits rather than running", Boolean(id) && ["queued", "waiting"].includes(String(queued.body?.restart?.state)), JSON.stringify(queued.body?.restart || null));
  const held = await waitFor(async () => ((await restartOf(panel.base)).queued || [])[0], { what: "the wait to hold a slot", timeoutMs: 10_000 });
  eq("…holding the one slot a queued restart may take", String(held?.id || ""), String(id));
  const dup = await api(panel.base, "/api/restart", { method: "POST", body: JSON.stringify({ target: "gateway", reason: "a second ask", waitFor: thread }) });
  eq("…so a second ask is a 409 while it waits", dup.status, 409);

  const missing = await api(panel.base, "/api/restart/cancel", { method: "POST", body: JSON.stringify({ id: "nosuchid" }) });
  eq("cancelling an unknown id is a 404", missing.status, 404);

  const cancelled = await api(panel.base, "/api/restart/cancel", { method: "POST", body: JSON.stringify({ id }) });
  eq("the queued restart cancels with a 200", cancelled.status, 200);
  eq("…and the answer carries the queue that remains", (cancelled.body?.queue || []).length, 0);
  eq("…and the panel agrees the queue is empty", ((await restartOf(panel.base)).queued || []).length, 0);
  ok("…with the withdrawal in the journal", ((await restartOf(panel.base)).journal || []).some((j) => new RegExp(`cancelled before it ran`).test(String(j.text || ""))), JSON.stringify((await restartOf(panel.base)).journal || []));

  // Let the hold END for real: the gateway finishes the run, so the turn the restart was waiting for is gone and
  // the loop's next poll is exactly the one a cancel has to win. (A stop would leave the card's own settling to
  // race this assertion; a completed run is one terminal status away from `livesOn` saying no.)
  const holdRun = stub.state.runs.get(live?.runId);
  ok("the hold has a run at the gateway to end", Boolean(holdRun), String(live?.runId || "none"));
  if (holdRun) {
    holdRun.status = "completed";
    holdRun.output = "the hold ended";
  }
  const ended = await waitFor(
    async () => {
      const j = (await api(panel.base, "/api/jobs")).body?.jobs?.find((x) => x.id === live?.id);
      return j && !["running", "starting", "waiting"].includes(String(j.status)) ? j : null;
    },
    { what: "the hold to end on the board", timeoutMs: 15_000 },
  );
  ok("…and the board reads it as ended", Boolean(ended), String(ended?.status || "still live"));
  await sleep(3_500);
  const after = await restartOf(panel.base);
  eq("once the turn it waited for has ended, no restart ran", after.last, null);
  eq("…and nothing is running", after.running, null);
  ok("…and the journal never says it started", !(after.journal || []).some((j) => /the queued restart starts now|ran `/.test(String(j.text || ""))), JSON.stringify(after.journal || []));
  ok("…and the gateway was never bounced (the restart log was never even opened)", !existsSync(path.join(dir, "logs", "gateway-restart.log")), "gateway-restart.log exists");
} catch (e) {
  failures += 1;
  console.log(`FAIL  the gate threw: ${String((e && e.stack) || e)}`);
  if (panel) console.log(panel.log().slice(-4000));
} finally {
  if (panel) await panel.stop();
  await stub.close();
}

console.log(`\n${checks} checks, ${checks - failures} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
