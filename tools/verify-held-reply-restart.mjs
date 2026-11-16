// A reply held behind a live turn, end to end, across the death of the node process that held it.
//
//   node tools/verify-held-reply-restart.mjs
//   node tools/verify-held-reply-restart.mjs --root=C:/path/to/a/git/archive --label=before
//
// WHAT THIS PROVES, on a spare port and a throwaway state directory (the live panel on :7331 is never touched, and a
// port of 18083 is refused as well because the reader keeps a second board there):
//
//   A. WHILE THE TURN IS LIVE. A run is started on a thread and left running by the stub gateway. A second message is
//      held on that thread: it is written to state/held-replies.json BEFORE any turn exists (asserted from the file on
//      disk), and no second run is submitted to the gateway while the first is live. When the first run finishes, the
//      hold becomes its own turn without any restart at all:
//   B. ACROSS A KILL. A long run is started, TWO messages are held behind it with an attachment each (uploaded through
//      the panel's own POST /api/attachments), and the node process is KILLED mid-run. The gateway is then told the run
//      finished while the panel was down. The panel is restarted over the same state directory, and:
//        - the two holds start in ARRIVAL order, each as its own turn;
//        - each turn's prompt carries the attachment path the record stored, exactly once, and the card carries the file;
//        - each message ran EXACTLY ONCE: one job carries its `origin.heldId`, and the gateway sees its marker in
//          exactly one submitted run, even after the drain clock has ticked several times;
//        - nothing is left owed: the store's open count is zero and the file says both records are `sent`.
//
// The `--root` form is the failing-first half: the same gate against a `git archive` of main, where the panel has no
// held-reply store at all, so the first write answers 404 and the run stops there (exit 1). It is how the "before" in
// docs/reports is a measurement instead of a claim.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROOT as REPO_ROOT, freePort, waitFor } from "./panel-testkit.mjs";

const arg = (name, dflt = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const ROOT = arg("root", REPO_ROOT);
const LABEL = arg("label", "after");

const checks = [];
let failures = 0;
const ok = (name, cond, extra = "") => {
  checks.push({ name, pass: Boolean(cond), extra: String(extra || "") });
  if (!cond) failures += 1;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `: ${extra}` : ""}`);
};
const note = (text) => console.log(`      ${text}`);
const slash = (p) => String(p || "").replace(/\\/g, "/");

// ---- the stub gateway ----------------------------------------------------------------------------------------------
// The shape lib/jobs.js talks to, with the one power this gate needs: the test decides when a run ends. Every
// submitted run body is kept, so "which text the panel asked to run" is a fact about the panel, not an inference.
function makeStub() {
  const answers = new Map();
  const seen = { submitted: [], events: [], stopped: [] };
  const timers = new Set();
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
      return json(200, { version: "held-reply-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_cwd: true } }, res);
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      const body = await readBody(req);
      const runId = `stub-run-${seen.submitted.length + 1}`;
      seen.submitted.push({ runId, body });
      answers.set(runId, { status: "running" });
      return json(200, { run_id: runId, status: "running" }, res);
    }
    const m = /^\/v1\/runs\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const sub = m[2] || "";
      if (sub === "/steer") {
        await readBody(req);
        return json(200, { accepted: true, run_id: id }, res);
      }
      if (sub === "/stop") {
        seen.stopped.push(id);
        answers.set(id, { status: "cancelled", exit_code: 130, output: "stopped" });
        return json(200, { ok: true }, res);
      }
      if (sub === "/events") {
        seen.events.push(id);
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": attached\n\n");
        const timer = setInterval(() => {
          const cur = answers.get(id) || { status: "running" };
          if (cur.status === "running") {
            res.write(": hold\n\n");
            return;
          }
          clearInterval(timer);
          timers.delete(timer);
          if (cur.output) res.write(`event: message.delta\ndata: ${JSON.stringify({ event: "message.delta", delta: `\n\n${cur.output}` })}\n\n`);
          res.write(`event: run.${cur.status}\ndata: ${JSON.stringify({ event: `run.${cur.status}`, output: cur.output, usage: cur.usage, exit_code: cur.exit_code })}\n\n`);
          res.end();
        }, 100);
        timers.add(timer);
        req.on("close", () => {
          clearInterval(timer);
          timers.delete(timer);
        });
        return;
      }
      const a = answers.get(id) || { status: "running" };
      return json(200, { run_id: id, ...a }, res);
    }
    if (url.pathname === "/v1/models") return json(200, { data: [] }, res);
    json(404, { error: { message: "not found" } }, res);
  });
  return {
    seen,
    server,
    set: (id, body) => answers.set(id, body),
    finish: (id, output = "done") => answers.set(id, { status: "completed", exit_code: 0, output }),
    close: () =>
      new Promise((r) => {
        for (const t of timers) clearInterval(t);
        timers.clear();
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

// ---- the sandbox ---------------------------------------------------------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-held-reply-"));
const repos = path.join(dir, "repos");
const repo = path.join(repos, "sandbox-repo");
const logs = path.join(dir, "logs");
const home = path.join(dir, "hermes");
const cwd = path.join(dir, "cwd", "t1");
const attachmentsDir = path.join(dir, "attachments");
for (const d of [repo, path.join(repo, ".worktrees"), logs, home, cwd, attachmentsDir]) mkdirSync(d, { recursive: true });
const git = (args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true }).trim();
git(["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# sandbox repo\n", "utf8");
git(["add", "."]);
git(["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "first"]);
// The thread's OWN tree, and it has to be a repository: `replyTree` (lib/own-tree.js) refuses a directory git answers
// for some other checkout, which is what a bare folder inside the sandbox is. One commit is enough.
const cwdGit = (args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).trim();
cwdGit(["init", "-q", "-b", "main"]);
writeFileSync(path.join(cwd, "README.md"), "# the thread's tree\n", "utf8");
cwdGit(["add", "."]);
cwdGit(["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "first"]);

const THREAD = "wtgui-held-restart-4f21b0";
const jobsFile = path.join(logs, "jobs.json");
const assistantFile = path.join(logs, "assistant.json");
const seed = Date.now() - 30 * 60_000;
writeFileSync(
  jobsFile,
  JSON.stringify({
    savedAt: new Date(seed).toISOString(),
    jobs: [
      {
        id: "j-seed-1",
        thread: THREAD,
        turn: 1,
        prompt: "the turn that made this card",
        cwd,
        ownerPath: null,
        projectPath: null,
        sessionId: THREAD,
        status: "done",
        exitCode: 0,
        startedAt: new Date(seed).toISOString(),
        endedAt: new Date(seed + 40_000).toISOString(),
        runId: "run_seed_1",
        worktree: false,
        existing: false,
        worktreePath: null,
        branch: null,
        lines: [{ kind: "text", lid: 1, at: seed + 40_000, text: "done" }],
        finalMessage: "done",
      },
    ],
  }),
  "utf8",
);

const stub = makeStub();
await new Promise((r) => stub.server.listen(0, "127.0.0.1", r));
const stubUrl = `http://127.0.0.1:${stub.server.address().port}`;
stub.set("run_seed_1", { status: "completed", exit_code: 0, output: "done" });

const liveBefore = (() => {
  try {
    return execFileSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true })
      .split(/\r?\n/)
      .filter((l) => l.includes(":7331 ") && l.includes("LISTENING")).length;
  } catch {
    return -1;
  }
})();

let port = await freePort();
while (port === 7331 || port === 18083) port = await freePort();
const base = `http://127.0.0.1:${port}`;
const configPath = path.join(dir, "config.json");
const config = {
  port,
  host: "127.0.0.1",
  scanRoots: [repos],
  refreshSeconds: 3600,
  worktreeSeconds: 3600,
  midSeconds: 3600,
  dormantSeconds: 3600,
  slowSeconds: 3600,
  fetchSeconds: 3600,
  threads: 1,
  scanMode: "all",
  defaultCwd: cwd,
  jobsFile,
  assistantFile,
  attachmentsDir,
  projectsCacheFile: path.join(logs, "projects.json"),
  treeNamesFile: path.join(logs, "tree-names.json"),
  apiServer: { url: stubUrl, key: "sandbox-key" },
  assistant: { enabled: false },
};
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

const heldFile = path.join(logs, "held-replies.json");
const readHeld = () => JSON.parse(readFileSync(heldFile, "utf8"));
const listen = (p) => {
  try {
    return execFileSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true })
      .split(/\r?\n/)
      .filter((l) => l.includes(`:${p} `) && l.includes("LISTENING")).length;
  } catch {
    return -1;
  }
};

let child = null;
const panelLog = [];
async function boot({ why }) {
  const log = [];
  const c = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PANEL_CONFIG: configPath, HERMES_HOME: home, CLAUDE_CONFIG_DIR: path.join(dir, "claude"), PANEL_TOKEN: "", API_SERVER_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  c.stdout.setEncoding("utf8");
  c.stderr.setEncoding("utf8");
  c.stdout.on("data", (d) => log.push(...String(d).split(/\r?\n/).filter(Boolean)));
  c.stderr.on("data", (d) => log.push(...String(d).split(/\r?\n/).filter(Boolean)));
  child = c;
  const up = await waitFor(async () => {
    try {
      return (await fetch(`${base}/api/state`)).ok;
    } catch {
      return false;
    }
  }, { timeoutMs: 90_000, stepMs: 250, what: `the panel (${why})` });
  if (!up) throw new Error(`the panel never answered /api/state (${why}):\n${log.slice(-25).join("\n")}`);
  panelLog.push({ why, lines: log });
  return log;
}
// A kill, not a close: TerminateProcess on Windows, SIGKILL elsewhere. This is the death the brief is about, so the
// process gets no chance to flush anything on the way out.
async function killPanel() {
  const pid = child.pid;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
    else process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  const gone = await waitFor(() => child.exitCode !== null || child.signalCode !== null, { timeoutMs: 20_000, stepMs: 100, what: "the panel to die" });
  return { pid, gone };
}

const GET = async (p) => {
  const r = await fetch(`${base}${p}`);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const POST = async (p, body, headers = {}) => {
  const r = await fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const upload = async (name, text) => {
  const r = await fetch(`${base}/api/attachments`, {
    method: "POST",
    headers: { "x-filename": encodeURIComponent(name), "content-type": "text/plain" },
    body: text,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const jobsNow = async () => (await GET("/api/jobs")).body.jobs || [];
const runsWith = (marker) => stub.seen.submitted.filter((s) => String(s.body?.prompt || s.body?.input || "").includes(marker));
// The run body the panel posts: lib/jobs.js sends `prompt` (and `input` in some shapes). Both are searched so a change
// of field name shows up as a failed check rather than as a passing test that never looked.
const runText = (s) => String(s.body?.prompt ?? s.body?.input ?? s.body?.message ?? "");

let exitCode = 0;
try {
  console.log(`\n== the sandbox (${LABEL}) ==`);
  note(`root     ${slash(ROOT)}`);
  note(`state    ${slash(dir)}`);
  note(`port     ${port}`);
  ok("the sandbox boots the checkout under test", existsSync(path.join(ROOT, "server.js")), slash(ROOT));
  ok("the sandbox port is neither 7331 nor 18083", port !== 7331 && port !== 18083, `port ${port}`);
  ok("every state path is inside the sandbox", [jobsFile, assistantFile, attachmentsDir].every((p) => slash(p).toLowerCase().startsWith(slash(dir).toLowerCase())));
  note(`the live board's 7331 listener count is ${liveBefore} before this run`);

  await boot({ why: "first boot" });
  ok("the panel is the listener on its own port", listen(port) >= 1, `${listen(port)} listener(s) on :${port}`);
  ok("the panel restored the seeded card", (await jobsNow()).some((j) => j.thread === THREAD && j.id === "j-seed-1"));

  // ---- A. a hold behind a LIVE turn ------------------------------------------------------------------------------
  console.log(`\n== A. a hold written while the turn is live ==`);
  const A_TURN = `TURN-A-${Date.now()}`;
  const A_HELD = `HELD-A-${Date.now()}`;
  const first = await POST("/api/agents/reply", { thread: THREAD, text: A_TURN });
  ok("the long turn is accepted", first.status === 202, `HTTP ${first.status}`);
  const runA = stub.seen.submitted.find((s) => runText(s).includes(A_TURN));
  ok("the gateway was asked to run it", Boolean(runA), runA?.runId || "no submission");

  const heldA = await POST("/api/held-replies", { action: "add", thread: THREAD, text: A_HELD });
  ok("the second message is held", heldA.status === 201 && heldA.body?.reply?.state === "held", `HTTP ${heldA.status} ${heldA.body?.reply?.state || heldA.body?.error || ""}`);
  ok("...and it is on DISK before any turn exists for it", existsSync(heldFile) && readHeld().replies.some((r) => r.text === A_HELD), slash(heldFile));
  ok("...under the arrival order the replay will walk", readHeld().replies.find((r) => r.text === A_HELD)?.seq === 1, `seq ${readHeld().replies.find((r) => r.text === A_HELD)?.seq}`);
  ok("no second run was submitted while the turn was live", runsWith(A_HELD).length === 0);

  // The turn finishes: the settle hook is what starts the hold, with no restart involved.
  stub.finish(runA.runId, "first turn done");
  const startedA = await waitFor(() => runsWith(A_HELD).length === 1, { timeoutMs: 30_000, stepMs: 200, what: "the hold behind the finished turn" });
  if (!startedA) {
    const j = (await jobsNow()).find((x) => String(x.prompt || "").includes(A_TURN));
    note(`after finish(): job ${JSON.stringify({ id: j?.id, status: j?.status, runId: j?.runId })}`);
    note(`panel log:\n      ${(panelLog.at(-1)?.lines || []).slice(-18).join("\n      ")}`);
  }
  ok("when the turn settles the hold becomes its own turn", startedA, `${runsWith(A_HELD).length} submission(s)`);
  const heldNowA = (await GET("/api/held-replies")).body.replies || [];
  ok("...and the record says sent, with the turn that carries it", heldNowA.find((r) => r.text === A_HELD)?.state === "sent" && Boolean(heldNowA.find((r) => r.text === A_HELD)?.jobId), JSON.stringify(heldNowA.find((r) => r.text === A_HELD)?.state));
  stub.finish(runsWith(A_HELD)[0].runId, "held turn done");
  await waitFor(async () => (await GET("/api/held-replies")).body?.counts?.open === 0, { timeoutMs: 20_000, stepMs: 200, what: "the store to be clear" });

  // ---- B. two holds, a kill, a restart --------------------------------------------------------------------------
  console.log(`\n== B. two holds, the process killed mid-run, then the restart ==`);
  const B_TURN = `TURN-B-${Date.now()}`;
  const b1 = await POST("/api/agents/reply", { thread: THREAD, text: B_TURN });
  ok("the long turn is accepted", b1.status === 202, `HTTP ${b1.status}`);
  const runB = stub.seen.submitted.find((s) => runText(s).includes(B_TURN));
  ok("the gateway is running it", Boolean(runB), runB?.runId || "no submission");

  const up1 = await upload("held-one.txt", "the first held message's file\n");
  const up2 = await upload("held-two.txt", "the second held message's file\n");
  ok("two attachments are stored by the panel's own route", up1.status === 201 && up2.status === 201, `${up1.status}/${up2.status}`);
  ok("...inside the sandbox's attachments folder", [up1, up2].every((u) => slash(u.body.path).toLowerCase().startsWith(slash(attachmentsDir).toLowerCase())));

  const M1 = `HELD-ONE-${Date.now()}`;
  const M2 = `HELD-TWO-${Date.now()}`;
  const h1 = await POST("/api/held-replies", { action: "add", thread: THREAD, text: M1, attachments: [up1.body] });
  const h2 = await POST("/api/held-replies", { action: "add", thread: THREAD, text: M2, attachments: [up2.body] });
  ok("both messages are held", h1.status === 201 && h2.status === 201, `${h1.status}/${h2.status}`);
  const before = readHeld();
  const r1 = before.replies.find((r) => r.text === M1);
  const r2 = before.replies.find((r) => r.text === M2);
  ok("...on disk, in arrival order", r1 && r2 && r1.seq < r2.seq, `seq ${r1?.seq} then ${r2?.seq}`);
  ok("...with their attachments named on the record", r1?.attachments?.[0]?.path === up1.body.path && r2?.attachments?.[0]?.path === up2.body.path, `${slash(r1?.attachments?.[0]?.path)}`);
  ok("...and neither started while the turn was live", runsWith(M1).length === 0 && runsWith(M2).length === 0);
  note(`the store before the kill: ${JSON.stringify(before.replies.map((r) => [r.text.slice(0, 8), r.state, r.seq]))}`);

  const killed = await killPanel();
  ok("the panel's node process is KILLED mid-run", killed.gone, `pid ${killed.pid}`);
  ok("...and its port is not answering", await (async () => {
    try {
      await fetch(`${base}/api/state`);
      return false;
    } catch {
      return true;
    }
  })());
  // The turn finished while the panel was down: this is the case a replay has to get right, not the easy one where the
  // run is still live and the panel merely re-attaches to it.
  stub.finish(runB.runId, "the turn that outlived the panel");
  note(`the store after the kill: ${JSON.stringify(readHeld().replies.map((r) => [r.text.slice(0, 8), r.state, r.seq]))}`);

  const log2 = await boot({ why: "restart" });
  ok("the panel comes back on the same port", listen(port) >= 1, `${listen(port)} listener(s) on :${port}`);
  ok("its boot log names the hold it found", log2.some((l) => /held replies: \d+ record\(s\)/.test(l)), log2.find((l) => /held replies:/.test(l)) || "no line");

  const firstStarted = await waitFor(() => runsWith(M1).length === 1, { timeoutMs: 60_000, stepMs: 250, what: "the first hold to start" });
  ok("the FIRST held message becomes its turn after the restart", firstStarted, `${runsWith(M1).length} submission(s)`);
  // The replay's own line, read once its pass has had the time to finish: the pass is fired, not awaited, at boot.
  const replayLine = await waitFor(() => log2.find((l) => /held replies \((boot|the clock|a turn settled)/.test(l)), {
    timeoutMs: 15_000,
    stepMs: 200,
    what: "the replay's line in the boot log",
  });
  ok("...and the boot log says the replay pass started it", Boolean(replayLine), replayLine || "no line");
  const p1 = runsWith(M1)[0];
  ok("...with its attachment path in the run's own prompt", p1 ? runText(p1).includes(up1.body.path) : false);
  ok("...exactly once", p1 ? runText(p1).split(up1.body.path).length - 1 === 1 : false);
  ok("...and the words are the reader's, untouched", p1 ? runText(p1).includes(M1) : false);
  // The second one is BEHIND the first: it must not be submitted until the first turn ends.
  ok("the SECOND hold waits behind it", runsWith(M2).length === 0);
  stub.finish(p1.runId, "the first held turn done");
  const secondStarted = await waitFor(() => runsWith(M2).length === 1, { timeoutMs: 60_000, stepMs: 250, what: "the second hold to start" });
  ok("when the first settles, the second becomes its turn", secondStarted, `${runsWith(M2).length} submission(s)`);
  const p2 = runsWith(M2)[0];
  ok("...with ITS attachment, not the first one's", p2 ? runText(p2).includes(up2.body.path) && !runText(p2).includes(up1.body.path) : false);
  stub.finish(p2.runId, "the second held turn done");

  // ---- C. exactly once -----------------------------------------------------------------------------------------
  console.log(`\n== C. nothing ran twice ==`);
  await waitFor(async () => (await GET("/api/held-replies")).body?.counts?.open === 0, { timeoutMs: 30_000, stepMs: 250, what: "the store to be clear" });
  // Time for the drain clock to tick several times over a store that is already clear.
  await new Promise((r) => setTimeout(r, 3_000));
  const jobs = await jobsNow();
  const jobsOf = (id) => jobs.filter((j) => j.origin && j.origin.heldId === id);
  ok("the first held message ran exactly once (one job carries its id)", jobsOf(r1.id).length === 1, `${jobsOf(r1.id).length} job(s)`);
  ok("the second held message ran exactly once", jobsOf(r2.id).length === 1, `${jobsOf(r2.id).length} job(s)`);
  ok("the gateway saw each message in exactly one submitted run", [M1, M2].every((m) => runsWith(m).length === 1), `${runsWith(M1).length}/${runsWith(M2).length}`);
  const job1 = jobsOf(r1.id)[0];
  ok("the turn's card carries the attachment the record stored", (job1?.attachments || []).some((a) => a.path === up1.body.path), JSON.stringify((job1?.attachments || []).map((a) => a.name)));
  const finalHeld = await GET("/api/held-replies");
  ok("the store ends with nothing owed a turn", finalHeld.body?.counts?.open === 0, JSON.stringify(finalHeld.body?.counts));
  ok("...and every record on disk is settled", readHeld().replies.filter((r) => r.state === "held" || r.state === "sending").length === 0);
  const kept = readHeld().replies.filter((r) => [r1.id, r2.id].includes(r.id));
  ok("...with the two held ones marked sent and naming their turns", kept.length === 2 && kept.every((r) => r.state === "sent" && r.jobId), JSON.stringify(kept.map((r) => [r.state, r.jobId])));

  // ---- D. the live board --------------------------------------------------------------------------------------
  const liveAfter = listen(7331);
  ok("the live board's 7331 listener count is unchanged", liveAfter === liveBefore, `${liveBefore} before, ${liveAfter} after`);
  ok("no listener of this run's was left behind", listen(port) === 0 || listen(port) === 1, `:${port} (the panel is still up: the sandbox's own)`);
} catch (e) {
  failures += 1;
  console.log(`FAIL  the run itself threw: ${String((e && e.message) || e)}`);
} finally {
  try {
    if (child) await killPanel();
  } catch {
    /* nothing to kill */
  }
  await stub.close();
  const pass = checks.filter((c) => c.pass).length;
  console.log(`\n${failures ? "FAILED" : "OK"}  ${pass}/${checks.length} checks passed (${LABEL}, port ${port})`);
  if (!process.env.KEEP_SANDBOX) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  else console.log(`kept: ${slash(dir)}`);
  exitCode = failures ? 1 : 0;
  process.exit(exitCode);
}
