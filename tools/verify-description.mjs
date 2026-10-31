// What each branch was STARTED to do, proved by driving a panel of its own — and a real browser over it.
//
//   node tools/verify-description.mjs
//
// The board said where a branch got to (MERGE STATE) and nothing said what it was for. The panel already held the
// answer: a run's brief is in the job store next to the cwd it ran in, so the EARLIEST run in a tree is that branch's
// stated goal. lib/descriptions.js extracts the opening of that brief verbatim and writes it down once, keyed on the
// six-hex tag a rename keeps; server.js harvests it on the events that can add a row or a job and decorates the
// snapshot with it; public/app.js renders it as a strip ABOVE MERGE STATE — a bullet list, one bullet per sentence,
// FOLDED to start with like the two strips under it, unfolding from its own head, and remembering the rows a reader
// UNFOLDED (localStorage `wm.openDescs`).
//
// Everything below happens in a sandbox of its own: a throwaway repo with three hand-cut worktrees, a throwaway
// HERMES_HOME, its own PANEL_CONFIG with its own port, its own logs and job store, and a STUB gateway on an ephemeral
// port. The live panel on 7331 and the live gateway on 8642 are never touched, and the whole temp root is deleted at
// the end.
//
// WHAT IS DRIVEN, AND WHAT IS ONLY INSPECTED
//
//   driven        the record: a panel booted over a seeded job store writes descriptions.json for the trees that have
//                 runs — from the EARLIEST run in each tree, and only for trees that have one
//   driven        the live half: one real POST /api/agents to the sandbox panel (a real worktree cut, a real run
//                 submitted to the stub gateway) lands a description for the tree it cut
//   driven        the goal is not rewritten: a follow-up run into the same tree leaves the record's text and its
//                 write time untouched
//   driven        the snapshot: /api/state carries the record's text on the row — and carries NO description at all
//                 for the worktree that has never had a run
//   driven        the browser (Playwright, headless Chromium, resizing nothing): the strip renders above MERGE STATE
//                 as a bullet list — one bullet per sentence, in the merge state's own list — with the record's own
//                 words; a freshly expanded row shows it FOLDED with its first bullet on the head line, like the two
//                 strips under it (which stay exactly as they were); clicking the head unfolds it, the unfold survives
//                 a reload, a second click folds it again and that survives too; a stale `wm.closedDescs` from the
//                 older build has no say; and the strip is simply absent for the tree with no run — no page errors
//   inspected     the per-render cost — that the extraction sits BEHIND the "does this tree have a record" check (and
//                 so is not re-derived per render) is read off server.js, not measured: the test measures only that
//                 the written record's bytes do not change while the panel keeps scanning
//
// The browser half needs a Playwright install. Point the script at one with PANEL_PLAYWRIGHT_ROOT (a directory holding
// node_modules/playwright, or the package itself); without one the script says BROWSER-HALF-NOT-RUN and exits 2 rather
// than passing on a half that never ran.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./browser.mjs";

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
const note = (text) => console.log(`      ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 60_000, stepMs = 500, what = "condition" } = {}) {
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
const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// ---- a stub gateway ------------------------------------------------------------------------------
// Exactly what lib/jobs.js asks of a real one and nothing more. Every run body is kept, so "the panel really posted
// this run" is answered by the stub's own record of it rather than by the panel's card line (which is written before
// the request goes out).
function makeStub() {
  const state = { runs: new Map(), bodies: [], seq: 0 };
  const timers = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (code, body) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/v1/capabilities") {
      return json(200, {
        version: "0.22.2-stub",
        features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true },
      });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        state.seq += 1;
        const id = `run-${state.seq}`;
        state.bodies.push(body);
        state.runs.set(id, { id, status: "running", output: "", session: body.session_id || null });
        const t = setTimeout(() => {
          const rec = state.runs.get(id);
          if (rec && rec.status === "running") {
            rec.status = "completed";
            rec.output = "sandbox stub: done";
          }
        }, 500);
        timers.push(t);
        json(200, { run_id: id });
      });
      return;
    }
    const one = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (one && req.method === "GET") {
      const rec = state.runs.get(one[1]);
      if (!rec) return json(404, { error: { message: "Run not found", code: "run_not_found" } });
      return json(200, { run_id: rec.id, status: rec.status, output: rec.output });
    }
    if (/^\/v1\/runs\/[^/]+\/events$/.test(url.pathname)) {
      const id = url.pathname.split("/")[3];
      const rec = state.runs.get(id);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      if (!rec) return res.end();
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
        if (rec.status !== "running") {
          clearInterval(timer);
          const payload = JSON.stringify({ event: `run.${rec.status}`, output: rec.output });
          res.write(`event: run.${rec.status}\ndata: ${payload}\n\n`);
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
    json(404, {});
  });
  const close = () =>
    new Promise((r) => {
      for (const t of timers) clearInterval(t);
      server.closeAllConnections?.();
      server.close(() => r());
    });
  return { state, server, close };
}

// ---- the sandbox ---------------------------------------------------------------------------------
const TAG_GOAL = "d3c0de";
const TAG_NONE = "b0b1e5";
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-description-"));
const rootDir = path.join(dir, "scan-root");
const repo = path.join(rootDir, "sandbox-repo");
const home = path.join(dir, "hermes-home");
const configDir = path.join(dir, "panel");
const cwdDir = path.join(dir, "panel-cwd");
const PROJECT = "sandbox-repo";
const TREE_GOAL = path.join(repo, ".worktrees", `make-the-strip-say-what-a-branch-was-for-${TAG_GOAL}`);
const TREE_PLAIN = path.join(repo, ".worktrees", "hand-cut-tree-with-no-tag");
const TREE_NONE = path.join(repo, ".worktrees", `nothing-ever-ran-in-this-tree-${TAG_NONE}`);

// The fixtures are literal, and so are the expectations: the test does not call the derivation function to work out
// what the panel should have said, or it would agree with any behaviour at all. Each prompt's third sentence is a
// canary — it must NOT reach a description, which is what proves the extract is the opening and nothing else.
const PROMPT_GOAL =
  "Make the merge-state strip say what a branch was started to do, in the words of the run that started it. " +
  "The words come from that run's own brief, never from the branch as it looks now. CANARY-ALPHA-THIRD-SENTENCE";
const EXPECT_GOAL =
  "Make the merge-state strip say what a branch was started to do, in the words of the run that started it. " +
  "The words come from that run's own brief, never from the branch as it looks now.";
const PROMPT_LATER = "A later run in the same tree. CANARY-BETA-THIRD-SENTENCE";
const PROMPT_PLAIN = "Give a hand-cut worktree with no tag in its name its own description too. Its record falls back to the path. CANARY-PLAIN-THIRD-SENTENCE";
const EXPECT_PLAIN = "Give a hand-cut worktree with no tag in its name its own description too. Its record falls back to the path.";
const PROMPT_LIVE =
  "Prove that a live run's own brief reaches the description of the tree it cut. " +
  "The harvest reads the panel's job store, not a fixture. CANARY-LIVE-THIRD-SENTENCE";
const EXPECT_LIVE = "Prove that a live run's own brief reaches the description of the tree it cut. The harvest reads the panel's job store, not a fixture.";
// The strip is a bullet list, one bullet per sentence, so the expected shape is written out here as the LITERAL
// sentences — never by calling the splitter, or the test would agree with any splitting at all.
const EXPECT_GOAL_LINES = [
  "Make the merge-state strip say what a branch was started to do, in the words of the run that started it.",
  "The words come from that run's own brief, never from the branch as it looks now.",
];
const EXPECT_PLAIN_LINES = [
  "Give a hand-cut worktree with no tag in its name its own description too.",
  "Its record falls back to the path.",
];
const EXPECT_LIVE_LINES = [
  "Prove that a live run's own brief reaches the description of the tree it cut.",
  "The harvest reads the panel's job store, not a fixture.",
];
const PROMPT_FOLLOW = "A follow-up run into a tree that already has its description. CANARY-GAMMA-THIRD-SENTENCE";

const JOB_GOAL = { id: "aaaa1111", thread: "wtgui-fixture-goal-aaaa11", prompt: PROMPT_GOAL, at: "2026-01-01T00:00:00.000Z" };
const JOB_LATER = { id: "bbbb2222", thread: "wtgui-fixture-later-bbbb22", prompt: PROMPT_LATER, at: "2026-01-02T00:00:00.000Z" };
const JOB_PLAIN = { id: "cccc3333", thread: "wtgui-fixture-plain-cccc33", prompt: PROMPT_PLAIN, at: "2026-01-01T12:00:00.000Z" };

for (const d of [repo, path.join(repo, ".worktrees"), home, configDir, cwdDir]) mkdirSync(d, { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# sandbox repo\n", "utf8");
git(repo, ["add", "."]);
git(repo, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "first"]);
for (const [tree, branch, file] of [
  [TREE_GOAL, `wtgui/make-the-strip-say-what-a-branch-was-for-${TAG_GOAL}`, "goal.txt"],
  [TREE_PLAIN, "wtgui/hand-cut-tree-with-no-tag", "plain.txt"],
  [TREE_NONE, `wtgui/nothing-ever-ran-in-this-tree-${TAG_NONE}`, null],
]) {
  const added = git(repo, ["worktree", "add", "-q", "-b", branch, tree]);
  if (!added.ok) {
    console.log(`FAIL  the sandbox worktree ${path.basename(tree)} could not be cut — ${added.err || added.out}`);
    failures += 1;
  }
  if (file) {
    writeFileSync(path.join(tree, file), "work\n", "utf8");
    git(tree, ["add", "."]);
    git(tree, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", `Start ${file}`]);
  }
}

// The job store the panel loads at boot: two runs in one tree (the earlier one is the branch's stated goal), one in a
// hand-cut tree, and none at all in the third. Status "done" so the panel has nothing to poll and nothing to re-anchor.
const seedJob = (j, extra) => ({
  id: j.id,
  thread: j.thread,
  turn: 1,
  prompt: j.prompt,
  displayPrompt: j.prompt,
  cwd: extra.cwd,
  worktree: Boolean(extra.worktreePath),
  worktreePath: extra.worktreePath || null,
  projectPath: repo,
  ownerPath: extra.cwd,
  branch: extra.branch || null,
  runId: `seed-${j.id}`,
  status: "done",
  exitCode: 0,
  startedAt: j.at,
  endedAt: new Date(Date.parse(j.at) + 60_000).toISOString(),
  model: "sandbox/stub",
  lines: [{ kind: "dim", text: "seeded for the description check" }],
  artifacts: [],
  attachments: [],
});
const seeded = [
  seedJob(JOB_GOAL, { cwd: TREE_GOAL, worktreePath: TREE_GOAL, branch: `wtgui/make-the-strip-say-what-a-branch-was-for-${TAG_GOAL}` }),
  seedJob(JOB_LATER, { cwd: TREE_GOAL, branch: `wtgui/make-the-strip-say-what-a-branch-was-for-${TAG_GOAL}` }),
  seedJob(JOB_PLAIN, { cwd: TREE_PLAIN, worktreePath: TREE_PLAIN, branch: "wtgui/hand-cut-tree-with-no-tag" }),
];
mkdirSync(path.join(configDir, "logs"), { recursive: true });
writeFileSync(path.join(configDir, "logs", "jobs.json"), `${JSON.stringify({ version: 1, savedAt: new Date().toISOString(), jobs: seeded }, null, 1)}\n`, "utf8");

const stub = makeStub();
await new Promise((r) => stub.server.listen(0, "127.0.0.1", r));
const stubUrl = `http://127.0.0.1:${stub.server.address().port}`;
const port = await freePort();
const configPath = path.join(configDir, "config.json");
writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      port,
      host: "127.0.0.1",
      scanRoots: [rootDir],
      refreshSeconds: 4,
      worktreeSeconds: 2,
      midSeconds: 8,
      dormantSeconds: 15,
      slowSeconds: 20,
      fetchSeconds: 3600,
      threads: 1,
      scanMode: "all",
      defaultCwd: cwdDir,
      projectsCacheFile: path.join(configDir, "logs", "projects.json"),
      apiServer: { url: stubUrl, key: "sandbox-key" },
      // Nothing here should spawn a worker of its own while a phase is being measured: this panel is driven, not
      // running a fleet.
      assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const base = `http://127.0.0.1:${port}`;
const descriptionsPath = path.join(configDir, "logs", "descriptions.json");
const panelLog = [];
let panel = null;
const startPanel = async () => {
  panel = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PANEL_CONFIG: configPath, HERMES_HOME: home, PANEL_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  panel.stdout.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  panel.stderr.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  const up = await waitFor(async () => (await fetch(`${base}/api/state`)).ok, { timeoutMs: 40_000, what: "the sandbox panel to answer /api/state" });
  if (!up) throw new Error(`the sandbox panel never came up on ${base}\n${panelLog.slice(-15).join("\n")}`);
};
const stopPanel = async () => {
  if (!panel) return;
  const p = panel;
  panel = null;
  p.kill();
  await waitFor(() => p.exitCode !== null || p.signalCode !== null, { timeoutMs: 15_000, what: "the panel to exit" });
  await sleep(300);
};
const api = async (route, body, method) => {
  const res = await fetch(`${base}${route}`, {
    method: method || (body ? "POST" : "GET"),
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const state = () => api("/api/state").then((r) => r.body);
const rowFor = async (treePath) => {
  const s = await state();
  return s.projects?.find((p) => p.name === PROJECT)?.worktrees?.find((w) => norm(w.path) === norm(treePath)) || null;
};
const records = () => {
  try {
    return JSON.parse(readFileSync(descriptionsPath, "utf8")).trees || {};
  } catch {
    return {};
  }
};
const recordFor = (treePath) => {
  const byPath = Object.values(records()).find((r) => norm(r.path) === norm(treePath));
  if (byPath) return byPath;
  // A rename moves the directory and the branch keeps the tag, so a record written before one is still this tree's:
  // the key is the fallback, and it is what the store is designed around.
  const tag = /-([0-9a-f]{6})$/i.exec(String(treePath).replace(/\//g, "\\").split("\\").pop() || "");
  if (!tag) return null;
  return Object.values(records()).find((r) => String(r.key || "").endsWith(tag[1].toLowerCase())) || null;
};
const treeNames = () => (git(repo, ["worktree", "list", "--porcelain"]).out || "")
  .split(/\r?\n/)
  .filter((l) => l.startsWith("worktree "))
  .map((l) => l.slice(9).trim())
  .filter((p) => norm(p) !== norm(repo));

// ---- the browser half ----------------------------------------------------------------------------
let browserFailures = 0;
async function browserPhase(pw, { liveTree = null } = {}) {
  const pageErrors = [];
  const browser = await pw.chromium.launch({ headless: true });
  // The row key the browser half works on, read before the context exists: the harness seeds the STALE
  // `wm.closedDescs` (what the older build left behind) against this very row, so the check that it has no say is
  // about a key that would have folded this row if it were still read.
  const seedRow = (await state()).projects?.find((p) => p.name === PROJECT)?.worktrees?.find((w) => norm(w.path) === norm(TREE_GOAL));
  if (!seedRow) throw new Error(`no row for ${TREE_GOAL} in /api/state`);
  const keyGoal0 = `${PROJECT}::${seedRow.path}`;
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  // Harness setup, not part of what is asserted: a fresh browser has no remembered layout, so the sandbox project
  // would open collapsed and none of its rows would be on the page. The CLOSED state of the description is the
  // DEFAULT below, not a click; this only opens the folder — and seeds the legacy key, which must not matter.
  await context.addInitScript((o) => {
    localStorage.setItem("wm.expandedProjects", JSON.stringify([o.project]));
    localStorage.setItem("wm.closedDescs", JSON.stringify([o.key]));
  }, { project: PROJECT, key: keyGoal0 });
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${String((e && e.message) || e)}`));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`);
  });
  const openRow = async (treePath) => {
    const s = await state();
    const row = s.projects?.find((p) => p.name === PROJECT)?.worktrees?.find((w) => norm(w.path) === norm(treePath));
    if (!row) throw new Error(`no row for ${treePath} in /api/state`);
    const key = `${PROJECT}::${row.path}`;
    const rowSel = `tr.row[data-key="${key}"]`;
    await page.waitForSelector(rowSel, { timeout: 20_000 });
    if (!(await page.locator(`tr.detail[data-detail="${key}"]`).count())) {
      // A text-only cell: the row's own controls (play, delete, revive, the refresh ring) swallow the click.
      await page.locator(`${rowSel} td.branch`).click();
    }
    await page.waitForSelector(`tr.detail[data-detail="${key}"]`, { timeout: 20_000 });
    return key;
  };
  const shot = async (name) => {
    const into = process.env.PANEL_VERIFY_ARTIFACTS;
    if (!into) return null;
    try {
      mkdirSync(into, { recursive: true });
      const file = path.join(into, name);
      await page.screenshot({ path: file, fullPage: false });
      return file;
    } catch {
      return null;
    }
  };

  await page.goto(base, { waitUntil: "domcontentloaded" });
  const keyGoal = await openRow(TREE_GOAL);
  check("browser: the row the harness seeded its stale key against", keyGoal, keyGoal0);
  const sel = `tr.detail[data-detail="${keyGoal}"]`;
  const descSel = `${sel} .desc-block`;
  const gitSel = `${sel} .git-block`;
  const liveSel = `${sel} .live-block`;
  // Folded, in the page's own terms: the block carries `collapsed` and its body has no box.
  const isFolded = async (blockSel, bodySel) =>
    (await page.locator(blockSel).getAttribute("class")).includes("collapsed") && !(await page.locator(`${blockSel} ${bodySel}`).isVisible());

  ok("browser: the worktree's detail carries a description strip", (await page.locator(descSel).count()) === 1);
  check("browser: the strip's heading", await page.locator(`${descSel} .desc-head h4`).textContent(), "Description");

  // ---- (2) a freshly expanded row shows the strip FOLDED with its one-line peek on the head line, the way the two
  // strips under it behave folded — and those two are untouched by any of this.
  ok(
    "browser: a freshly expanded row shows the description FOLDED",
    await isFolded(descSel, ".desc-body"),
    await page.locator(descSel).getAttribute("class"),
  );
  check("browser: nothing has been unfolded, so nothing is remembered yet", await page.evaluate(() => localStorage.getItem("wm.openDescs")), null);
  ok(
    "browser: the stale wm.closedDescs naming THIS row is on disk and has no say",
    String(await page.evaluate(() => localStorage.getItem("wm.closedDescs"))).includes(keyGoal),
    await page.evaluate(() => localStorage.getItem("wm.closedDescs")),
  );
  check("browser: folded, its one-line peek is the head's first bullet", await page.locator(`${descSel} .desc-first`).textContent(), EXPECT_GOAL_LINES[0]);
  check("browser: merge state, under it, is folded the same way (unchanged)", await isFolded(gitSel, ".git-body"), true);
  check("browser: and so is liveness (unchanged)", await isFolded(liveSel, "ul"), true);
  check(
    "browser: all three folded strips keep a peek on their head line",
    await page.evaluate((s) => {
      const shown = (sel2) => {
        const el = document.querySelector(sel2);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      return {
        desc: shown(`${s} .desc-block .desc-first`),
        git: shown(`${s} .git-block .git-summary`),
        live: shown(`${s} .live-block .live-first`),
      };
    }, sel),
    { desc: true, git: true, live: true },
  );
  const shotFolded = await shot("description-folded-on-expand.png");

  // ---- (1) opened, it is a bullet list in the merge state's own list: same column, size and colour.
  await page.locator(`${descSel} .desc-head`).click();
  ok("browser: clicking the head unfolds the strip", !(await page.locator(descSel).getAttribute("class")).includes("collapsed"));
  ok(
    "browser: and the unfold is remembered in the browser",
    String(await page.evaluate(() => localStorage.getItem("wm.openDescs"))).includes(keyGoal),
    await page.evaluate(() => localStorage.getItem("wm.openDescs")),
  );
  check("browser: the strip's body carries the shared fact list (ul.git-list)", await page.locator(`${descSel} .desc-body ul.git-list.desc-list`).count(), 1);
  check("browser: one bullet per sentence, in the record's own words", await page.locator(`${descSel} .desc-list li`).allTextContents(), EXPECT_GOAL_LINES);
  check("browser: the head's own line is the list's first bullet", await page.locator(`${descSel} .desc-list li`).first().getAttribute("class"), "git-summary-line");
  ok(
    "browser: the strip names the run the words came from",
    (await page.locator(`${descSel} .desc-from`).textContent()).includes(JOB_GOAL.thread),
    await page.locator(`${descSel} .desc-from`).textContent(),
  );
  const order = await page.evaluate((s) => {
    const inner = document.querySelector(s).querySelector(".detail-inner");
    const kids = [...inner.children];
    return { desc: kids.indexOf(inner.querySelector(".desc-block")), git: kids.indexOf(inner.querySelector(".git-block")) };
  }, sel);
  ok(
    "browser: the description sits ABOVE merge state",
    order.desc >= 0 && order.git >= 0 && order.desc < order.git,
    `the detail's own children: description at ${order.desc}, merge state at ${order.git}`,
  );
  ok(
    "browser: merge state is still there, under it",
    (await page.locator(`${sel} .git-head h4`).textContent()) === "Merge state",
    await page.locator(`${sel} .git-head h4`).textContent(),
  );
  // The other two strips are unfolded here only to compare against them: geometry needs them laid out.
  await page.locator(`${gitSel} .git-head`).click();
  await page.locator(`${liveSel} .live-head`).click();
  const shape = await page.evaluate((s) => {
    const read = (li) => {
      const cs = getComputedStyle(li);
      return { font: cs.fontFamily, size: cs.fontSize, colour: cs.color, x: Math.round(li.getBoundingClientRect().x) };
    };
    const all = (sel2) => [...document.querySelectorAll(sel2)].map(read);
    return { desc: all(`${s} .desc-list li`), git: all(`${s} .git-list li`), live: all(`${s} .live-block ul li`) };
  }, sel);
  const descLead = shape.desc[0];
  const descRest = shape.desc[1] || shape.desc[0];
  const gitLead = shape.git[0];
  const gitRest = shape.git[1] || shape.git[0];
  check(
    "browser: a description bullet is the merge state's bullet, in family, size and colour",
    { font: descRest.font, size: descRest.size, colour: descRest.colour },
    { font: gitRest.font, size: gitRest.size, colour: gitRest.colour },
  );
  check(
    "browser: and its first bullet is the merge state's own brighter first bullet",
    { font: descLead.font, size: descLead.size, colour: descLead.colour },
    { font: gitLead.font, size: gitLead.size, colour: gitLead.colour },
  );
  check(
    "browser: every bullet sits in the merge state's own column",
    [...new Set(shape.desc.map((d) => d.x))],
    [shape.git[0].x],
  );
  note(
    `measured: description ${descRest.size} ${descRest.colour} at x=${descRest.x} · merge state ${gitRest.size} ${gitRest.colour} at x=${gitRest.x} · liveness ${shape.live[0].size} ${shape.live[0].colour} at x=${shape.live[0].x}`,
  );
  note(
    "(those two strips are not identical to each other today: merge state's bullets are 11.5px on the dimmer colour, liveness's 12px on the brighter one and 3px further right. The description takes the MERGE STATE's — the list class it shares, and the strip it sits directly above.)",
  );
  const shotOpen = await shot("description-unfolded.png");

  // ---- (3) the choice survives a reload — and it is the UNFOLD that is remembered, not a fold: the two strips under
  // it come back folded, exactly as they do today.
  await page.reload({ waitUntil: "domcontentloaded" });
  const keyAfterReload = await openRow(TREE_GOAL);
  check("browser: the same row after a reload", keyAfterReload, keyGoal);
  ok(
    "browser: the row the reader UNFOLDED is still unfolded after a reload",
    !(await page.locator(descSel).getAttribute("class")).includes("collapsed") && (await page.locator(`${descSel} .desc-body`).isVisible()),
  );
  check(
    "browser: while the two strips under it are folded again, unchanged",
    { git: await isFolded(gitSel, ".git-body"), live: await isFolded(liveSel, "ul") },
    { git: true, live: true },
  );
  const shotOpenReload = await shot("description-unfolded-after-reload.png");

  // ---- and it folds again, which is what makes the remembering a fold rather than a one-way door.
  await page.locator(`${descSel} .desc-head`).click();
  ok("browser: clicking again folds it", await isFolded(descSel, ".desc-body"));
  check("browser: and the unfolded mark is gone again", await page.evaluate(() => localStorage.getItem("wm.openDescs")), "[]");
  await page.reload({ waitUntil: "domcontentloaded" });
  await openRow(TREE_GOAL);
  ok(
    "browser: a reload after that shows it folded, with the peek back on the head line",
    (await isFolded(descSel, ".desc-body")) && (await page.locator(`${descSel} .desc-first`).textContent()) === EXPECT_GOAL_LINES[0],
  );
  const shotClosed = await shot("description-folded-after-reload.png");

  // ---- the tree with no run degrades to nothing, and merge state is untouched by that.
  const keyNone = await openRow(TREE_NONE);
  const noneSel = `tr.detail[data-detail="${keyNone}"]`;
  check("browser: a tree with no run renders NO description strip", await page.locator(`${noneSel} .desc-block`).count(), 0);
  ok(
    "browser: and its merge state still renders",
    (await page.locator(`${noneSel} .git-head h4`).textContent()) === "Merge state",
  );
  // The hand-cut tree has no six-hex tag to key a record on, so this is the path-keyed half of the store reaching the
  // page as well — and it starts folded and lists its sentences like the tagged one.
  const keyPlain = await openRow(TREE_PLAIN);
  const plainSel = `tr.detail[data-detail="${keyPlain}"] .desc-block`;
  ok("browser: a hand-cut tree (no tag) starts folded too", await isFolded(plainSel, ".desc-body"));
  await page.locator(`${plainSel} .desc-head`).click();
  check("browser: a hand-cut tree's description, one bullet per sentence", await page.locator(`${plainSel} .desc-list li`).allTextContents(), EXPECT_PLAIN_LINES);
  const shotSecond = await shot("description-second-tree.png");

  // ---- and the description a LIVE run wrote for the tree it cut reads the same way.
  if (liveTree) {
    const keyLive = await openRow(liveTree);
    const liveDesc = `tr.detail[data-detail="${keyLive}"] .desc-block`;
    ok("browser: the tree a live run cut carries the strip", (await page.locator(liveDesc).count()) === 1);
    await page.locator(`${liveDesc} .desc-head`).click();
    check("browser: with the live run's own words as bullets", await page.locator(`${liveDesc} .desc-list li`).allTextContents(), EXPECT_LIVE_LINES);
  } else {
    note("(no live-cut tree to check in the browser: the live phase above did not cut one)");
  }

  check("browser: no page errors", pageErrors, []);
  browserFailures = failures;
  await browser.close();
  return { shotFolded, shotOpen, shotOpenReload, shotClosed, shotSecond };
}

// ---- the phases ----------------------------------------------------------------------------------
let shots = null;
try {
  console.log("== the sandbox ==");
  note(`temp root ${dir}`);
  note(`stub gateway ${stubUrl} · panel ${base}`);
  await startPanel();
  const discovered = await waitFor(
    async () => {
      const s = await state();
      const trees = s.projects?.find((p) => p.name === PROJECT)?.worktrees || [];
      return trees.length >= 4;
    },
    { timeoutMs: 45_000, what: "the sandbox repo and its three worktrees to be scanned as rows" },
  );
  ok("the sandbox panel scanned the project and its three worktrees", discovered);

  console.log("\n== the record: the earliest run's own brief, written down once ==");
  const written = await waitFor(() => Object.keys(records()).length >= 2, { timeoutMs: 30_000, what: "descriptions.json to hold a record per tree that has a run" });
  ok("a description was written for each tree that has a run", written);
  const recGoal = recordFor(TREE_GOAL);
  const recPlain = recordFor(TREE_PLAIN);
  ok("the tree with two runs has a record", Boolean(recGoal));
  check("its text is the opening of the EARLIEST run's brief", recGoal?.text, EXPECT_GOAL);
  check("the later run's words are not in it", String(recGoal?.text || "").includes("CANARY-BETA"), false);
  check("the third sentence is cut (two sentences, no more)", String(recGoal?.text || "").includes("CANARY-ALPHA"), false);
  check("it names the run it came from", recGoal?.from?.job, JOB_GOAL.id);
  check("and that run's thread", recGoal?.from?.thread, JOB_GOAL.thread);
  check("and when that run started", recGoal?.from?.at, JOB_GOAL.at);
  ok("it is keyed on the six-hex tag a rename keeps", String(recGoal?.key || "").endsWith(TAG_GOAL), recGoal?.key);
  check("the hand-cut tree (no tag) gets one too, keyed on its path", recPlain?.text, EXPECT_PLAIN);
  check("a tree no run has ever touched gets NO record", recordFor(TREE_NONE), null);
  note(`descriptions.json holds ${Object.keys(records()).length} record(s)`);

  console.log("\n== the record is written once, not per render ==");
  const bytesBefore = readFileSync(descriptionsPath, "utf8");
  for (let i = 0; i < 4; i += 1) {
    await state();
    await sleep(900);
  }
  const bytesAfter = readFileSync(descriptionsPath, "utf8");
  check("the file is byte-identical after four more board reads and a scan cycle", bytesAfter === bytesBefore, true);
  note("(that the extraction itself sits behind the 'already has a record' check is read off server.js, not measured here)");

  console.log("\n== the snapshot carries it ==");
  const rowGoal = await rowFor(TREE_GOAL);
  check("the row carries the record's text", rowGoal?.description?.text, EXPECT_GOAL);
  const rowNone = await rowFor(TREE_NONE);
  ok("a tree with no run carries no description field at all", rowNone && !("description" in rowNone), rowNone ? Object.keys(rowNone).includes("description") : "no row");

  console.log("\n== a live run's brief reaches the description of the tree it cut ==");
  const before = treeNames();
  const spawnRes = await api("/api/agents", { project: PROJECT, prompt: PROMPT_LIVE });
  check("the panel accepted the spawn", spawnRes.status, 202);
  let newTree = null;
  const cut = await waitFor(
    () => {
      const extra = treeNames().filter((t) => !before.some((b) => norm(b) === norm(t)));
      if (!extra.length) return false;
      newTree = extra[0];
      return true;
    },
    { timeoutMs: 60_000, stepMs: 700, what: "the panel to cut a worktree for the live run" },
  );
  ok("the live run's worktree was cut", cut && Boolean(newTree), newTree || "");
  const liveRecord = await waitFor(() => Boolean(recordFor(newTree)), { timeoutMs: 60_000, stepMs: 700, what: "a description for the tree the live run cut" });
  ok("a description was written for it", liveRecord);
  check("from the live run's own brief", recordFor(newTree)?.text, EXPECT_LIVE);
  ok("the stub gateway really received that run", stub.state.bodies.length >= 1, `${stub.state.bodies.length} run(s) posted`);
  if (newTree) {
    const liveRow = await rowFor(newTree);
    check("and the new tree's row carries it", liveRow?.description?.text, EXPECT_LIVE);
  }

  console.log("\n== a follow-up run cannot rewrite the goal ==");
  const recBefore = JSON.stringify(recordFor(TREE_GOAL));
  const followRes = await api("/api/agents", { project: PROJECT, prompt: PROMPT_FOLLOW, existing: true, cwd: TREE_GOAL });
  check("the panel accepted the run into the existing tree", followRes.status, 202);
  const followLanded = await waitFor(
    async () => {
      const s = await state();
      return Boolean((s.jobs || []).some((j) => String(j.prompt || "").startsWith("A follow-up run into a tree")));
    },
    { timeoutMs: 45_000, what: "the follow-up run to appear in the panel's job store" },
  );
  ok("the follow-up run is in the panel's store", followLanded);
  await sleep(4000); // several harvest passes' worth, with the follow-up run live in that tree
  check("the tree's description is unchanged, text and write time alike", JSON.stringify(recordFor(TREE_GOAL)), recBefore);

  console.log("\n== the browser: a bullet list, folded on expand, unfolded and remembered ==");
  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN  the client half of this change was not exercised in a browser.");
    note("re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-description.mjs");
    failures += 1;
  } else {
    shots = await browserPhase(pw, { liveTree: newTree });
    if (shots?.shotOpen) note(`screenshots: ${shots.shotFolded} · ${shots.shotOpen} · ${shots.shotOpenReload} · ${shots.shotClosed} · ${shots.shotSecond}`);
  }

  console.log("\n== summary ==");
  console.log(`${checks} checks, ${failures} failed`);
  if (shots?.shotOpen) {
    console.log("\nWHAT WAS DRIVEN: a sandbox panel booted over a seeded job store (the record, the earliest-run choice,");
    console.log("the unchanged-bytes check), a real POST /api/agents to a stub gateway (the live half), a real POST into an");
    console.log("existing tree (the follow-up), and headless Chromium over the running panel: the bullets and their measured");
    console.log("family/size/colour/column against the merge state's own list, the fold on a fresh expand, the click that");
    console.log("unfolds it, the reload that keeps it open, the click that folds it again, the stale legacy key, the no-run");
    console.log("tree, and zero page errors.");
    console.log("WHAT WAS INSPECTED, NOT DRIVEN: that the extraction sits behind the 'already has a record' guard rather");
    console.log("than running per render — read off server.js; the test measures only that the written file does not change.");
  }
  if (!failures) console.log("DESCRIPTION-VERIFY-OK");
} catch (err) {
  failures += 1;
  console.log(`\nFAIL  the run threw: ${String((err && err.stack) || err)}`);
  if (panelLog.length) console.log(`--- panel log (tail)\n${panelLog.slice(-25).join("\n")}`);
} finally {
  if (process.env.VERIFY_KEEP === "1") {
    console.log(`VERIFY_KEEP=1 — leaving ${dir} in place`);
  } else {
    await stopPanel();
    await stub.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch (e) {
      console.log(`      (could not remove ${dir}: ${String((e && e.message) || e)})`);
    }
  }
}
process.exitCode = failures ? 1 : 0;
