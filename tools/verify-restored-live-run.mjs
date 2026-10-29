// The sticky "cannot steer it" card, proved against a panel of its own.
//
// WHAT WAS WRONG. `reconcileRestored()` (lib/jobs.js) asks the gateway about every turn a restart cut off. A run the
// gateway had already finished was adopted; a run the gateway STILL HAD was written off with
//   "the panel restarted while this was running — the gateway still has run <id>, so it will finish on its own, but
//    this card cannot steer it"
// and finalised there. Two things followed, and both are what this script drives:
//   * The card was dead weight. The re-attach half of the sweep (`j.reattached` + `this.follow`) only ever runs for
//     jobs whose status is running/starting, and this write-off had just stamped the job `interrupted` — so the one
//     turn that could still be steered and whose outcome could still be adopted was the one turn nothing revisited.
//   * Once the run DID leave the gateway (it finished and was evicted, or the gateway was replaced), the promise in
//     that error was false and nothing took it back: `runStatus()` returned null for a 404 and `reconcileRestored`
//     read that as "the gateway cannot be asked", so the card kept promising a finish nobody would ever see. That is
//     the sticky card: on the reader's own board it stays for as long as the job store holds it.
//
// NOW. A run the gateway still has re-attaches: the card goes back to `running`, its stream and status poll are
// re-established, it steers again, and its outcome is adopted when the run actually finishes. A run the gateway no
// longer has gets the promise cleared and reads interrupted-by-restart, naming the run and saying the outcome was
// never seen here. A gateway that cannot answer for a run (a 5xx) is not an answer, and the verdict stands.
//
//   node tools/verify-restored-live-run.mjs
//
// WHAT IS DRIVEN: a real panel process (`node server.js`) on its own PANEL_CONFIG, its own port, its own store and its
// own throwaway HERMES_HOME, over real HTTP — GET /api/jobs, POST /api/jobs/steer — against a stub Runs API on an
// ephemeral port. The store is seeded with the cards a restart leaves behind, INCLUDING one already written off by
// the old code (promise and measured outcome in the file, the way the reader's store is), and the panel's own boot
// reconcile is what repairs them. The live panel on :7331 and the live gateway on :8642 are never touched; no branch
// of this repository is affected; the sandbox is deleted at the end.
//
// WHAT IS ONLY INSPECTED: the browser half — that the card renders the cleared error and offers the steer box lives in
// public/app.js and is not clicked here. The two HTTP calls behind those controls (the job list the card is drawn
// from, and the steer route that was refused with 400 before this change) are driven and asserted.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

let failures = 0;
let checks = 0;
const check = (name, got, want) => {
  checks += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 30_000, stepMs = 250, what = "condition" } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    let got = false;
    try {
      got = await fn();
    } catch {
      got = false;
    }
    if (got) return true;
    if (Date.now() > until) {
      console.log(`      (timed out after ${timeoutMs}ms waiting for ${what})`);
      return false;
    }
    await sleep(stepMs);
  }
}

const git = (dir, args) => {
  try {
    return { ok: true, out: execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true }).trim() };
  } catch (e) {
    return { ok: false, out: String((e && e.stdout) || "").trim(), err: String((e && e.message) || e) };
  }
};
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// ---- the stub Runs API ------------------------------------------------------------------------
// It answers what the panel asks at boot: capabilities, the status of a run, its event stream, and a steer. The three
// seeded cards are the three answers: one run the gateway still holds (its stream is HELD until the script releases
// it), and two it has no record of at all.
function makeStub() {
  const answers = {
    run_live: { status: "running" },
    run_promise: null, // 404: Run not found
    run_gone: null, // 404: Run not found
  };
  const seen = { runs: {}, steer: [], stops: [], wakeRuns: 0 };
  const timers = [];
  const json = (code, body, res) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  const readBody = (req) =>
    new Promise((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          resolve(JSON.parse(raw || "{}"));
        } catch {
          resolve({});
        }
      });
    });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/v1/capabilities") {
      return json(200, { version: "sandbox-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true } }, res);
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      seen.wakeRuns += 1;
      return json(200, { run_id: `stub-wake-${seen.wakeRuns}`, status: "running" }, res);
    }
    const m = /^\/v1\/runs\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const sub = m[2] || "";
      seen.runs[id] = (seen.runs[id] || 0) + 1;
      if (sub === "/steer") {
        const body = await readBody(req);
        seen.steer.push({ id, body });
        return json(200, { accepted: true, run_id: id }, res);
      }
      if (sub === "/stop") {
        seen.stops.push(id);
        return json(200, { ok: true }, res);
      }
      if (sub === "/events") {
        // SSE frames are separated by a blank line; the stream ends the way the gateway ends one — with the run's own
        // terminal event — and is held open with a comment line while the run is still going.
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": attached\n\n");
        const timer = setInterval(() => {
          const a = answers[id];
          if (!a || a.status === "running") {
            res.write(": hold\n\n");
            return;
          }
          clearInterval(timer);
          // The answer reaches a card as prose first (the gateway streams it as `message.delta` fragments) and the
          // terminal event second; a stub that sent only the terminal frame would look like a run that answered with
          // nothing at all.
          if (a.output) res.write(`event: message.delta\ndata: ${JSON.stringify({ event: "message.delta", delta: `\n\n${a.output}` })}\n\n`);
          const evt = { event: `run.${a.status}`, output: a.output, usage: a.usage, exit_code: a.exit_code };
          res.write(`event: run.${a.status}\ndata: ${JSON.stringify(evt)}\n\n`);
          res.end();
        }, 150);
        timers.push(timer);
        req.on("close", () => clearInterval(timer));
        return;
      }
      if (!(id in answers) || answers[id] === null) {
        return json(404, { error: { message: "Run not found", code: "run_not_found" } }, res);
      }
      return json(200, { run_id: id, ...answers[id] }, res);
    }
    json(404, { error: { message: "not found" } }, res);
  });
  const release = (id, over = {}) => {
    answers[id] = { status: "completed", exit_code: 0, output: "…", ...over };
  };
  const close = () =>
    new Promise((r) => {
      for (const t of timers) clearInterval(t);
      server.closeAllConnections?.();
      server.close(() => r());
    });
  return { answers, seen, server, release, close };
}

// ---- the sandbox ------------------------------------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-restored-live-"));
const rootDir = path.join(dir, "scan-root");
const repo = path.join(rootDir, "sandbox-repo");
const home = path.join(dir, "hermes-home");
const configDir = path.join(dir, "panel");
const cwdDir = path.join(dir, "panel-cwd");
const logsDir = path.join(configDir, "logs");
for (const d of [repo, path.join(repo, ".worktrees"), home, configDir, cwdDir, logsDir]) mkdirSync(d, { recursive: true });

git(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# sandbox repo\n");
git(repo, ["add", "."]);
git(repo, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "first"]);

const stub = makeStub();
await new Promise((r) => stub.server.listen(0, "127.0.0.1", r));
const stubUrl = `http://127.0.0.1:${stub.server.address().port}`;
const port = await freePort();
const configPath = path.join(configDir, "config.json");
const jobsPath = path.join(logsDir, "jobs.json");

// ---- the store a restart left behind ----------------------------------------------------------
// Three turns were running when the panel died. One card had already been written off by the OLD code: `interrupted`,
// the promise in its error, and the outcome that promise was measured into — the exact state the reader's own sticky
// card is in.
const START = "2026-10-24T02:56:46.400Z";
const LAST = Date.parse("2026-10-24T03:09:19.351Z");
const PROMISE = "the panel restarted while this was running — the gateway still has run run_promise, so it will finish on its own, but this card cannot steer it";
const OUTPUT = "Finished after the panel came back, with the work committed.";
const job = (id, runId, prompt, over = {}) => ({
  id,
  thread: `wtgui-restored-${id}`,
  turn: 1,
  prompt,
  cwd: repo,
  projectPath: repo,
  sessionId: `wtgui-restored-${id}`,
  status: "running",
  exitCode: null,
  startedAt: START,
  endedAt: null,
  runId,
  worktree: false,
  existing: true,
  lines: [
    { kind: "tool", lid: 1, at: LAST - 60_000, text: "💻 terminal · build the war" },
    { kind: "tool", lid: 2, at: LAST, text: "💻 terminal · KEY=… + 2 commands" },
  ],
  ...over,
});
writeFileSync(
  jobsPath,
  JSON.stringify({
    savedAt: START,
    jobs: [
      job("j-live", "run_live", "stay on it"),
      job("j-gone", "run_gone", "deploy it"),
      job("j-promise", "run_promise", "deploy the other one", {
        status: "interrupted",
        endedAt: new Date(LAST).toISOString(),
        error: PROMISE,
        outcome: { word: "interrupted", exitCode: null, source: null, reason: PROMISE },
      }),
    ],
  }),
);
const seeded = readFileSync(jobsPath, "utf8");
ok("the store handed to the panel already carries the old write-off", seeded.includes(PROMISE));

writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      port,
      host: "127.0.0.1",
      scanRoots: [rootDir],
      refreshSeconds: 5,
      worktreeSeconds: 2,
      midSeconds: 10,
      dormantSeconds: 20,
      slowSeconds: 30,
      fetchSeconds: 3600,
      threads: 1,
      scanMode: "all",
      defaultCwd: cwdDir,
      jobsFile: jobsPath,
      projectsCacheFile: path.join(logsDir, "projects.json"),
      apiServer: { url: stubUrl, key: "sandbox-key" },
      // Nothing here is a setting the panel needs; it is here so the sentry cannot spawn a worker of its own into the
      // sandbox while a phase is being measured. The stub would take such a run happily, which is exactly why no wake
      // should be able to reach it.
      assistant: { enabled: false },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
const base = `http://127.0.0.1:${port}`;
const panelLog = [];
let panel = null;
const panelSaid = (re) => panelLog.some((l) => re.test(l));
const api = async (route, body) => {
  const res = await fetch(`${base}${route}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const cardFor = async (id) => (await api("/api/jobs")).body.jobs?.find((j) => j.id === id) || null;

const startPanel = async () => {
  panel = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PANEL_CONFIG: configPath, HERMES_HOME: home, PANEL_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  panel.stdout.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  panel.stderr.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  const up = await waitFor(async () => (await fetch(`${base}/api/state`)).ok, { timeoutMs: 60_000, stepMs: 400, what: "the sandbox panel to answer /api/state" });
  if (!up) throw new Error(`the sandbox panel never came up on ${base}\n${panelLog.slice(-15).join("\n")}`);
};
const stopPanel = async () => {
  if (!panel) return;
  const p = panel;
  panel = null;
  try {
    p.kill();
    await waitFor(() => p.exitCode !== null || p.signalCode !== null, { timeoutMs: 10_000, what: "the panel to exit" });
  } catch {
    /* fall through to the hard kill */
  }
  if (p.exitCode === null) {
    // `child.kill()` can leave the panel alive on Windows, and its pipes then hold this script's event loop open.
    try {
      execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      /* already gone */
    }
  }
  p.stdout?.destroy();
  p.stderr?.destroy();
  await sleep(300);
};

let err = null;
try {
  // ── phase 1: the panel came up on the sandbox config, and restored the seeded store ──────────
  console.log(`\nphase 1 — a panel of its own (PANEL_CONFIG, port ${port}, stub at ${stubUrl})`);
  await startPanel();
  const logText = panelLog.join("\n");
  ok("the panel logged the port from the sandbox config", logText.includes(`agent-worktree-gui on http://127.0.0.1:${port}`), `port ${port}`);
  ok("...and the stub it was pointed at, not the live gateway", logText.includes(`agent transport: ${stubUrl}`));
  ok("...and nothing bound the live panel's port", !panelLog.some((l) => /:7331\b/.test(l)));
  const restored = await waitFor(() => panelSaid(/restored 3 job\(s\) from/), { timeoutMs: 30_000, what: "the seeded store to be restored" });
  ok("it restored the three seeded cards from the sandbox store", restored, panelLog.find((l) => /restored 3 job\(s\) from/.test(l)) || "");
  ok("...and read them from the sandbox's own jobs file", panelLog.some((l) => /restored 3 job\(s\) from/.test(l) && l.includes("jobs.json")));

  // ── phase 2: the boot reconcile repaired the written-off card ───────────────────────────────
  console.log("\nphase 2 — the card the old code wrote off");
  const reconciled = await waitFor(() => panelSaid(/reconciled 3 turn\(s\) a restart cut off/), { timeoutMs: 30_000, what: "the boot reconcile to name the restored turns" });
  ok("the panel's own boot reconcile ran and named all three", reconciled, panelLog.find((l) => /reconciled 3 turn\(s\)/.test(l)) || "");
  ok("...re-attaching the live run rather than writing it off", panelSaid(/run j-live: the gateway still has this run \(run_live\) — re-attached instead of writing it off/));

  const promiseCard = await cardFor("j-promise");
  ok("the written-off card is still on the board", Boolean(promiseCard), promiseCard ? `status ${promiseCard.status}` : "MISSING");
  check("the verdict is still interrupted", promiseCard?.status, "interrupted");
  ok("its promise is replaced by what the gateway said", /^the panel restarted while this was running — the gateway no longer has run run_promise, so its outcome was never seen here$/.test(promiseCard?.error || ""), promiseCard?.error || "");
  ok("nothing on the card still promises a finish", !/will finish on its own/.test(JSON.stringify(promiseCard)), JSON.stringify(promiseCard).slice(0, 120));
  ok("...and its completion notice does not either", !/will finish on its own/.test(JSON.stringify(promiseCard?.completion || {})));
  ok("but the notice still names the run it never saw end", /run_promise/.test(JSON.stringify(promiseCard?.completion || {})), JSON.stringify(promiseCard?.completion?.reason || ""));
  const promiseSteer = await api("/api/jobs/steer", { id: "j-promise", text: "carry on" });
  check("a run the gateway has lost is still not steerable", promiseSteer.status, 400);
  ok("...and the refusal says why, rather than promising anything", /run is not running \(interrupted\)/.test(promiseSteer.body?.error || ""), promiseSteer.body?.error || "");

  const goneCard = await cardFor("j-gone");
  check("the second 404 card reads interrupted too", goneCard?.status, "interrupted");
  ok("...with the same honest wording", /the gateway no longer has run run_gone, so its outcome was never seen here/.test(goneCard?.error || ""), goneCard?.error || "");

  // ── phase 3: the run the gateway still had — steerable again, and its outcome adopted ────────
  console.log("\nphase 3 — the run that outlived the panel");
  const liveCard = await cardFor("j-live");
  check("the live card is running again, not interrupted", liveCard?.status, "running");
  check("...with the restart's error cleared", liveCard?.error, null);
  check("...and no stale completion riding it", liveCard?.completion, null);
  ok("the console says the panel re-attached", /re-attached to it and can steer it again/.test(JSON.stringify(liveCard?.lines || [])), JSON.stringify((liveCard?.lines || []).map((l) => l.text)));
  const steer = await api("/api/jobs/steer", { id: "j-live", text: "keep going, then finish" });
  check("a steer is accepted where the card used to refuse it", steer.status, 200);
  check("...and the panel reports it accepted", steer.body?.ok, true);
  check("...against the run the gateway still has", steer.body?.runId, "run_live");
  ok("...and the gateway received it", stub.seen.steer.length === 1 && stub.seen.steer[0].id === "run_live" && /keep going/.test(JSON.stringify(stub.seen.steer[0].body)), JSON.stringify(stub.seen.steer));

  // The run finishes — on its own stream, which the re-attach re-established.
  stub.release("run_live", { output: OUTPUT, usage: { total_tokens: 900, input_tokens: 700, output_tokens: 200 } });
  const settled = await waitFor(async () => (await cardFor("j-live"))?.status === "done", { timeoutMs: 20_000, what: "the re-attached run's outcome to be adopted" });
  ok("the re-attached run's outcome is adopted when it finishes", settled);
  const finished = await cardFor("j-live");
  check("...as done", finished?.status, "done");
  check("...with the exit status the run reported", finished?.exitCode, 0);
  ok("...and the answer it finished on is on the console", (finished?.lines || []).some((l) => String(l.text).includes(OUTPUT)), JSON.stringify((finished?.lines || []).map((l) => l.text)));
  ok("...and the same words are what the notice carries", String(finished?.completion?.final?.text || "").includes(OUTPUT), String(finished?.completion?.final?.source || "") + ": " + String(finished?.completion?.final?.text || ""));
  ok("...and no restart error left on it", !finished?.error, String(finished?.error || ""));
  ok("the outcome the notice is built from is the run's own", finished?.outcome?.word === "normal", JSON.stringify(finished?.outcome || {}));

  // ── phase 4: the store the panel rewrites no longer carries the promise ─────────────────────
  console.log("\nphase 4 — what the panel now keeps");
  const persisted = await waitFor(() => {
    try {
      const saved = JSON.parse(readFileSync(jobsPath, "utf8"));
      return saved.jobs?.find((j) => j.id === "j-live")?.status === "done";
    } catch {
      return false;
    }
  }, { timeoutMs: 20_000, what: "the panel to persist the adopted outcome" });
  ok("the panel persisted the settled store", persisted);
  const savedText = readFileSync(jobsPath, "utf8");
  ok("the promise is gone from the store on disk", !savedText.includes("will finish on its own"));
  ok("...and the repaired wording is what the card keeps", /the gateway no longer has run run_promise/.test(savedText));
  ok("no wake run was ever posted to the live gateway's stand-in", stub.seen.wakeRuns === 0, `wakeRuns ${stub.seen.wakeRuns}`);
} catch (e) {
  err = e;
  failures += 1;
  console.log(`\nphases threw: ${String((e && e.message) || e)}`);
  console.log(panelLog.slice(-25).join("\n"));
} finally {
  await stopPanel();
  await stub.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nDRIVEN: a real panel process on PANEL_CONFIG :${port} over HTTP (GET /api/jobs, POST /api/jobs/steer),`);
console.log("        the panel's own boot reconcile, and a stub Runs API holding one run and 404ing two.");
console.log("INSPECTED: the browser half — the card's rendering of the cleared error lives in public/app.js and is not clicked here.");
console.log(err ? `RESULT: threw — ${String(err.message || err)}` : failures ? `RESULT: ${failures} FAILED of ${checks}` : `RESULT: ALL PASS (${checks} checks)`);
process.exit(err || failures ? 1 : 0);
