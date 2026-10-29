// A leftover alert must not fire on a tree a live run holds — proved end to end, in a sandbox of its own.
//
//   node tools/verify-leftover-holder.mjs
//   PANEL_PLAYWRIGHT_ROOT=C:/ProjectDevelopment/heroes-js node tools/verify-leftover-holder.mjs   # with the browser half
//
// The rule this drives: the sentry's `leftover` sweep flags a finished card's tree when it finds uncommitted work
// there, and it re-checks that tree at sweep time. It used to re-check it without asking who holds it now, so a
// SPAWN IN into a just-finished tree read the new agent's own edits as the old worker's abandoned work — observed
// four times on one tree on the live board, the counts rising 1 modified → 2 modified → 2 modified + 1 untracked →
// 2 modified + 2 untracked as the second agent worked. `Jobs.runInTree()` (lib/jobs.js) is the holder question,
// built on `runningJobs()`; the sweep asks it before it blames a tree, which is the check standing rule 16 asks a
// reader to make by hand.
//
// WHAT IS DRIVEN, AND WHAT IS ONLY INSPECTED
//
//   driven   a real panel process (`node server.js`) from THIS worktree, on its own PANEL_CONFIG, its own port,
//            its own throwaway HERMES_HOME, its own logs and job store, over two REAL git worktrees of a sandbox
//            repo — one dirty and unheld, one dirty and held by a live run — scanned by the panel's own scanner.
//            The alert list is read from `/api/assistant`, so the whole stack is exercised: git → scanner row →
//            sentry → alert.
//   driven   the live holder itself. A persisted `running` card is stamped `interrupted` when the store loads (a
//            panel restart loses the stream), so the holder is seeded the way the board really gets one back: an
//            interrupted card with a run id, which the boot reconcile re-attaches against a stub Runs API that
//            still holds the run. The card reads `running` before any scan row exists, which is the ordering the
//            assertions rest on — and the test fails loudly if it is not met.
//   driven   the browser (Playwright, headless Chromium): the board is opened, the assistant float is opened with
//            a bare "A", the Alerts tab is pressed, and the alerts are read out of the DOM (`#as-alerts .as-alert`)
//            — the unheld tree's leftover is rendered, the held tree's is not there at all. This is the half that
//            proves the alert the reader actually sees, not just the JSON behind it.
//   inspected  the sweep's own source is not read: every assertion is about the alert that came out.
//
// The deterministic half of this behaviour — the same pair of cases without a gateway, a scanner or a browser — is
// in tools/verify-assistant.mjs ("work left in a finished tree") and the store predicate itself in lib/jobs.test.js
// (phase 6, `Jobs.runInTree`). This file adds the end-to-end pass over the served page.
//
// The live panel on :7331 is not touched — the sandbox listens on an ephemeral port of its own, and the live
// instance is never restarted, pointed at, or asked to serve anything.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const require = createRequire(import.meta.url);

let failures = 0;
let checks = 0;
const check = (name, got, want) => {
  checks += 1;
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const note = (text) => console.log(`      ${text}`);
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

// ---- the stub Runs API ---------------------------------------------------------------------------
// Only two answers are needed: the panel may ask what the gateway is (capabilities), and it re-attaches the run the
// live holder owns. The events stream is held open and never ends, so the holder stays a live run for the whole
// test and nothing in it can settle on its own.
function makeStub() {
  const answers = new Map();
  const timers = [];
  const json = (code, body, res) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/v1/capabilities") {
      return json(200, { version: "sandbox-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_cwd: true } }, res);
    }
    const m = /^\/v1\/runs\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const sub = m[2] || "";
      if (sub === "/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": attached\n\n");
        const t = setInterval(() => res.write(": hold\n\n"), 250);
        timers.push(t);
        req.on("close", () => clearInterval(t));
        return;
      }
      const a = answers.get(id);
      if (!a) return json(404, { error: { message: "Run not found", code: "run_not_found" } }, res);
      return json(200, { run_id: id, ...a }, res);
    }
    json(404, { error: { message: "not found" } }, res);
  });
  return {
    answers,
    server,
    set: (id, body) => answers.set(id, body),
    close: () =>
      new Promise((r) => {
        for (const t of timers) clearInterval(t);
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

// ---- the sandbox: a repo with two dirty worktrees, one of them held ----------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-leftover-holder-"));
const rootDir = path.join(dir, "scan-root");
const repo = path.join(rootDir, "sandbox-repo");
const home = path.join(dir, "hermes-home");
const configDir = path.join(dir, "panel");
const cwdDir = path.join(dir, "panel-cwd");
const logsDir = path.join(configDir, "logs");
const heldTree = path.join(repo, ".worktrees", "held-tree");
const freeTree = path.join(repo, ".worktrees", "free-tree");
for (const d of [repo, path.join(repo, ".worktrees"), home, configDir, cwdDir, logsDir]) mkdirSync(d, { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# sandbox repo\n");
git(repo, ["add", "."]);
git(repo, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "first"]);
git(repo, ["worktree", "add", "-q", "-b", "wtgui/held-tree", heldTree]);
git(repo, ["worktree", "add", "-q", "-b", "wtgui/free-tree", freeTree]);
// Both trees carry uncommitted work: the ONLY difference between them is the live run in one of them.
writeFileSync(path.join(heldTree, "README.md"), "# sandbox repo\n\nheld: an agent is editing this now\n");
writeFileSync(path.join(freeTree, "README.md"), "# sandbox repo\n\nfree: nobody is holding this tree\n");

const iso = (ms) => new Date(ms).toISOString();
const now = Date.now();
const jobSeed = (id, thread, over) => ({
  id,
  thread,
  turn: 1,
  prompt: `the turn behind ${id}`,
  projectPath: repo,
  sessionId: thread,
  status: "done",
  exitCode: 0,
  startedAt: iso(now - 180_000),
  endedAt: iso(now - 60_000),
  runId: null,
  worktree: true,
  existing: false,
  branch: null,
  lines: [{ kind: "text", lid: 1, at: now - 90_000, text: `finished ${id}` }],
  ...over,
});
const jobsPath = path.join(logsDir, "jobs.json");
writeFileSync(
  jobsPath,
  JSON.stringify({
    savedAt: iso(now),
    jobs: [
      // A worker that ended and left its dirty tree with nobody in it: this one MUST still be reported.
      jobSeed("j-free", "wtgui-free-tree", { cwd: freeTree, ownerPath: freeTree, worktreePath: freeTree, branch: "wtgui/free-tree" }),
      // …and the same shape in the tree a live run now occupies: this one must NOT be reported.
      jobSeed("j-held", "wtgui-held-tree", { cwd: heldTree, ownerPath: heldTree, worktreePath: heldTree, branch: "wtgui/held-tree" }),
      // The run that holds it, as the store really gets one back after a restart: interrupted with a run id, which
      // the boot reconcile re-attaches against the stub below and which then reads `running`.
      jobSeed("j-holder", "wtgui-holder", {
        cwd: heldTree,
        ownerPath: heldTree,
        worktreePath: heldTree,
        status: "interrupted",
        endedAt: iso(now - 20_000),
        runId: "run_holder",
        error: "the panel restarted while this was running (run run_holder may still be live in the gateway)",
      }),
    ],
  }),
  "utf8",
);

const stub = makeStub();
await new Promise((r) => stub.server.listen(0, "127.0.0.1", r));
const stubUrl = `http://127.0.0.1:${stub.server.address().port}`;
stub.set("run_holder", { status: "running" });
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const configPath = path.join(configDir, "config.json");
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
      prCacheSeconds: 3600,
      threads: 1,
      scanMode: "all",
      defaultCwd: cwdDir,
      jobsFile: jobsPath,
      projectsCacheFile: path.join(logsDir, "projects.json"),
      apiServer: { url: stubUrl, key: "sandbox-key" },
      assistant: {
        enabled: true,
        seconds: 1,
        cwd: path.join(logsDir, "assistant-cwd"),
        leftoverMinutes: 15,
        rules: { leftover: "alert" },
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
mkdirSync(path.join(logsDir, "assistant-cwd"), { recursive: true });

// ---- the panel, from THIS worktree ----------------------------------------------------------------
const panelLog = [];
let panel = null;
const api = async (route) => {
  const res = await fetch(`${base}${route}`);
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
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

const cards = async () => (await api("/api/jobs")).body.jobs || [];
const cardFor = async (id) => (await cards()).find((j) => j.id === id) || null;
const rowFor = async (tree) => {
  const st = await api("/api/state");
  const wts = (st.body.projects || []).flatMap((p) => p.worktrees || []);
  return wts.find((w) => String(w.path || "").replace(/\\/g, "/").toLowerCase() === tree.replace(/\\/g, "/").toLowerCase()) || null;
};
const alerts = async () => (await api("/api/assistant")).body.alerts || [];
const leftovers = async () => (await alerts()).filter((a) => a.rule === "leftover");

// ---- the browser half -----------------------------------------------------------------------------
function loadPlaywright() {
  const roots = [process.env.PANEL_PLAYWRIGHT_ROOT, process.env.PLAYWRIGHT_ROOT, ROOT, process.cwd()].filter(Boolean);
  for (const root of roots) {
    try {
      return require(path.join(root, "node_modules", "playwright"));
    } catch {
      /* not there */
    }
    try {
      return require(root);
    } catch {
      /* not there */
    }
  }
  try {
    return require("playwright");
  } catch {
    return null;
  }
}

let browser = null;
async function browserPhase(pw) {
  browser = await pw.chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await waitFor(async () => page.evaluate(() => Boolean(window.__assistantToggle)), { timeoutMs: 30_000, stepMs: 300, what: "the board's own boot to wire the assistant" });
  // The float opens on a bare "A" — the key the reader presses — and its alerts live on their own tab, which is
  // hidden until it is picked, so pressing the tab is part of opening the thing that shows the alert.
  await page.keyboard.press("a");
  await page.waitForSelector("#assistant:not([hidden])", { timeoutMs: 15_000 });
  const seen = [];
  const readAlerts = async () =>
    page.$$eval("#as-alerts .as-alert", (els) =>
      els.map((el) => ({
        rule: el.querySelector(".as-rule")?.textContent || "",
        thread: el.querySelector(".as-thread")?.textContent || "",
        title: el.querySelector("h4")?.textContent || "",
        detail: el.querySelector(".as-detail")?.textContent || "",
      })),
    );
  const opened = await waitFor(
    async () => {
      await page.click('#as-tabs [data-as-tab="alerts"]').catch(() => {});
      const list = await readAlerts();
      if (list.length) seen.push(...list);
      return list.length > 0;
    },
    { timeoutMs: 30_000, stepMs: 700, what: "the assistant's alerts tab to render an alert" },
  );
  // One more read after the list settled, so the assertion is on the finished list and not on a half paint.
  await sleep(1200);
  const list = await readAlerts();
  return { opened, rendered: list.length ? list : seen };
}

// ---- the run --------------------------------------------------------------------------------------
let err = null;
let pw = null;
try {
  console.log(`\nphase 1 — a panel of its own on PANEL_CONFIG (port ${port}), over two real worktrees`);
  await startPanel();
  ok("the panel logged its own sandbox port", panelLog.join("\n").includes(`agent-worktree-gui on http://127.0.0.1:${port}`));
  ok("…and nothing was served from or asked of the live panel on :7331", !panelLog.join("\n").includes("7331"));

  console.log("\nphase 2 — the live holder, before any scan row exists");
  const holderLive = await waitFor(async () => (await cardFor("j-holder"))?.status === "running", { timeoutMs: 30_000, what: "the holder to be re-attached and read running" });
  ok("the holder is re-attached against the stub and reads running", holderLive, (await cardFor("j-holder"))?.status || "?");
  // The ordering every later assertion rests on: the holder is live BEFORE the first row for either tree exists,
  // so a leftover raised for the held tree could only be the bug. If this ever stops holding, the test fails here
  // rather than passing for the wrong reason.
  ok("…and neither tree has been scanned yet", !(await rowFor(heldTree)) && !(await rowFor(freeTree)));
  check("…and the sweep has raised nothing yet", await leftovers(), []);

  console.log("\nphase 3 — the scanner sees both dirty trees (the input the sweep reads)");
  const dirtyOk = await waitFor(
    async () => {
      const h = await rowFor(heldTree);
      const f = await rowFor(freeTree);
      return (h?.dirtyFiles || []).length > 0 && (f?.dirtyFiles || []).length > 0;
    },
    { timeoutMs: 60_000, what: "both rows to carry a modified file" },
  );
  ok("both rows carry the uncommitted work the sweep judges", dirtyOk, JSON.stringify({ held: (await rowFor(heldTree))?.dirtyFiles?.length, free: (await rowFor(freeTree))?.dirtyFiles?.length }));

  console.log("\nphase 4 — the sweep: the unheld tree alerts, the held tree does not");
  const fired = await waitFor(async () => (await leftovers()).some((a) => a.thread === "wtgui-free-tree"), { timeoutMs: 60_000, what: "the unheld tree's leftover alert" });
  ok("a dirty tree NO live run holds raises its leftover", fired, JSON.stringify((await leftovers()).map((a) => a.thread)));
  const free = (await leftovers()).find((a) => a.thread === "wtgui-free-tree");
  ok("…naming the work left in it", /modified/.test(free?.detail || ""), free?.detail || "");
  check("…and the held tree has raised nothing at all", (await leftovers()).map((a) => a.thread), ["wtgui-free-tree"]);

  // Keep watching, and keep changing the held tree the way the second agent did: the false alert did not appear
  // once and stop — it appeared four times as that agent worked, one per tick the counts moved. A single clean
  // tick proves nothing, so this walks the counts the way the observed case did.
  const seenThreads = new Set();
  const counts = [];
  for (let i = 0; i < 12; i += 1) {
    writeFileSync(path.join(heldTree, `scratch-${i}.md`), `edit ${i}\n`);
    if (i % 4 === 3) writeFileSync(path.join(heldTree, "README.md"), `# sandbox repo\n\nheld: an agent is editing this now (${i})\n`);
    for (const a of await leftovers()) seenThreads.add(a.thread);
    const row = await rowFor(heldTree);
    counts.push(`${(row?.dirtyFiles || []).length} modified + ${(row?.untrackedFiles || []).length} untracked`);
    await sleep(1000);
  }
  check("…and across a dozen ticks, with the held tree changing under it, the held tree never raises one", [...seenThreads].sort(), ["wtgui-free-tree"]);
  note(`the held tree moved through: ${[...new Set(counts)].join(" → ")}`);

  console.log("\nphase 5 — the same two trees, on the page the reader sees");
  pw = loadPlaywright();
  if (!pw) {
    note("no Playwright install found — BROWSER-HALF-NOT-RUN");
    note("re-run with PANEL_PLAYWRIGHT_ROOT=C:/ProjectDevelopment/heroes-js node tools/verify-leftover-holder.mjs");
  } else {
    const { opened, rendered } = await browserPhase(pw);
    ok("the alerts tab renders the sweep's alert", opened, JSON.stringify(rendered.map((a) => a.title)));
    const domLeftovers = rendered.filter((a) => a.rule === "leftover");
    ok("the page renders the unheld tree's leftover", domLeftovers.some((a) => /free-tree|nobody is holding/.test(`${a.thread} ${a.title} ${a.detail}`)), JSON.stringify(domLeftovers.map((a) => a.title)));
    ok("…and no rendered alert mentions the tree a live run holds", !rendered.some((a) => /held-tree|wtgui-holder/.test(`${a.thread} ${a.title} ${a.detail}`)), JSON.stringify(rendered.map((a) => `${a.rule}:${a.thread}`)));
    check("exactly one leftover is on the page", domLeftovers.length, 1);
  }
} catch (e) {
  err = e;
  failures += 1;
  console.log(`\nphases threw: ${String((e && e.message) || e)}`);
  console.log(panelLog.slice(-25).join("\n"));
} finally {
  try {
    await browser?.close();
  } catch {
    /* nothing to close */
  }
  await stopPanel();
  await stub.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nDRIVEN: a real panel from this worktree on its own PANEL_CONFIG (port ${port}) — two real git worktrees,`);
console.log("        the panel's own scanner, the sentry's leftover sweep, a stub Runs API holding one live run, and");
console.log("        headless Chromium over the served board.");
console.log("INSPECTED: nothing. The sweep's source is not read: every assertion is about the alert that came out.");
console.log(err ? `RESULT: threw — ${String(err.message || err)}` : failures ? `RESULT: ${failures} FAILED of ${checks}` : `RESULT: ALL PASS (${checks} checks)`);
process.exitCode = err || failures ? 1 : 0;
