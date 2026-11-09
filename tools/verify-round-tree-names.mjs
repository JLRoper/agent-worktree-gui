// A round's own names on the worktree chart, proved in a browser that has never typed one.
// HARNESS: LIVE GATE
//
//   PANEL_PLAYWRIGHT_ROOT=C:/ProjectDevelopment/heroes-js node tools/verify-round-tree-names.mjs
//
// WHAT THIS PROVES. A round cuts its own trees and writes their names down: `pipelineRun.round` on the queue task
// names the parent, `pipelineRun.trees` names every stage child, both derived at the cut by `stageTreeName`. The chart
// used to paint the reader's browser map (`localStorage` `wtgui.treenames`) and then the agent's own title, so a fresh
// profile drew the directory name for every row of a round. The panel now stamps the record's name on each row
// (`row.round`, server.js `withRoundNames` / `rowExtras`) and the page paints it (`public/app.js` `treeTitleOf`).
//
// The proof is a real board in a sandbox of its own: a throwaway repo with a round's parent tree, its two stage
// children and one plain tree no round cut, plus a queue task that carries the round's record. The browser context is
// FRESH, so `wtgui.treenames` is empty, and the gate asserts that before it reads a single row. Then:
//
//   driven   `/api/state` carries the record on exactly the three round rows, and on neither the plain tree nor the
//            checkout; the parent reads the TASK's name and each child reads "Stage <n>: <stage>" from its position
//            and stage, which the record stores with no `display` of its own
//   driven   the chart paints those three names, and the plain tree still draws its directory name
//   driven   the same names survive a live `row` frame: the row's reconcile press repaints the row from a frame, and a
//            name stamped only into the snapshot would be erased there
//   driven   the queue record's paths are written with backslashes, as the cut writes them on Windows, and the rows
//            carry forward slashes: the join is the panel's own path key, not string equality
//   capture  one PNG of the chart, written to `ledger/verify/round-tree-names/` so a reader can open it after the
//            temp dir is gone
//
// The live panel and the live gateway are never touched: its own port, its own PANEL_CONFIG, its own HERMES_HOME, and
// an apiServer pointed at a dead port. The temp root is deleted at the end; the capture is copied out first.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright } from "./browser.mjs";
import { ROOT, freePort, git, slash, waitFor } from "./panel-testkit.mjs";

let checks = 0;
let failures = 0;
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
    console.log(`FAIL  ${name}${extra ? ` - ${extra}` : ""}`);
  }
};
const note = (text) => console.log(`      ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the round, as the cut writes it -------------------------------------------------------------------------------
const PROJECT = "sandbox-round";
const ROUND_SLUG = "round-a";
const ROUND_TAG = "052254";
const TASK_TITLE = "274: parent row reads the task name";
const PARENT_TAIL = `${ROUND_SLUG}-${ROUND_TAG}`;
const STAGE1_TAIL = `${ROUND_SLUG}-stage-1-probe-6632b6`;
const STAGE2_TAIL = `${ROUND_SLUG}-stage-2-implement-9d41f0`;
const PLAIN_TAIL = "plain-0a1b2c";
// What the chart must paint, written out by hand: the record's words, never the directory, never a typed name.
const WANT = {
  [PARENT_TAIL]: TASK_TITLE,
  [STAGE1_TAIL]: "Stage 1: probe",
  [STAGE2_TAIL]: "Stage 2: implement",
};

const dir = mkdtempSync(path.join(tmpdir(), "wtgui-round-names-"));
const repos = path.join(dir, "repos");
const repo = path.join(repos, PROJECT);
const logs = path.join(dir, "logs");
const worktrees = path.join(repo, ".worktrees");
for (const d of [repo, worktrees, path.join(logs, "assistants", "assistant-1")]) mkdirSync(d, { recursive: true });

const runGit = (cwd, args) => git(cwd, args);
runGit(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, ".gitignore"), ".worktrees/\n", "utf8");
writeFileSync(path.join(repo, "README.md"), "# a round's sandbox\n", "utf8");
runGit(repo, ["add", "-A"]);
runGit(repo, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "seed the sandbox"]);
const mainSha = runGit(repo, ["rev-parse", "HEAD"]).trim();

// The round's trees, cut the way the assistant cuts them: the parent from main, the children pinned to it.
const treePath = (tail) => path.join(worktrees, tail);
const cut = (tail, branch, from) => runGit(repo, ["worktree", "add", "-q", "-b", branch, treePath(tail), from]);
cut(PARENT_TAIL, `wtgui/${PARENT_TAIL}`, "main");
const parentSha = runGit(treePath(PARENT_TAIL), ["rev-parse", "HEAD"]).trim();
cut(STAGE1_TAIL, `wtgui/${STAGE1_TAIL}`, parentSha);
cut(STAGE2_TAIL, `wtgui/${STAGE2_TAIL}`, parentSha);
// A tree no round cut: it must keep the fallback it always had.
cut(PLAIN_TAIL, "work/plain", "main");
check("the round's parent and both stage trees are cut from the same commit", runGit(treePath(PARENT_TAIL), ["rev-parse", "HEAD"]), mainSha);

// ---- the queue task: the record the chart now reads ----------------------------------------------------------------
// Paths are written with BACKSLASHES, as `path.join` records them on Windows, while the rows carry the scanner's
// forward slashes. The join must be the panel's path key, not string equality.
const backslash = (p) => String(p).replace(/\//g, "\\");
const queueTask = {
  id: 7,
  title: TASK_TITLE,
  detail: "a round's parent tree and its two stage children",
  state: "done",
  createdBy: "the reader",
  createdAt: new Date().toISOString(),
  doneAt: new Date().toISOString(),
  doneBy: "the driver",
  project: PROJECT,
  worktree: backslash(treePath(PARENT_TAIL)),
  pipelineRun: {
    pipeline: "round-a",
    stage: "S2",
    // No `display` on either child: the panel must derive "Stage <n>: <stage>" from the stage and its position,
    // which is the half a stored sentence could get stale.
    round: {
      parentPath: backslash(treePath(PARENT_TAIL)),
      parent: `wtgui/${PARENT_TAIL}`,
      slug: ROUND_SLUG,
      tag: ROUND_TAG,
      display: "the round title from the record",
      sha: mainSha,
    },
    trees: {
      S1: { path: backslash(treePath(STAGE1_TAIL)), branch: `wtgui/${STAGE1_TAIL}`, position: 1, stageName: "probe", tag: "6632b6" },
      S2: { path: backslash(treePath(STAGE2_TAIL)), branch: `wtgui/${STAGE2_TAIL}`, position: 2, stageName: "implement", tag: "9d41f0" },
    },
  },
};
writeFileSync(path.join(logs, "assistants", "assistant-1", "queue.json"), `${JSON.stringify({ version: 1, nextId: 8, tasks: [queueTask] }, null, 2)}\n`, "utf8");

// ---- the sandbox panel ---------------------------------------------------------------------------------------------
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const configPath = path.join(dir, "config.json");
writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      port,
      host: "127.0.0.1",
      scanRoots: [repos],
      scanMode: "all",
      threads: 2,
      worktreeSeconds: 3,
      midSeconds: 10,
      dormantSeconds: 20,
      slowSeconds: 30,
      refreshSeconds: 5,
      fetchSeconds: 3600,
      defaultCwd: repo,
      jobsFile: path.join(logs, "jobs.json"),
      assistantFile: path.join(logs, "assistant.json"),
      projectsCacheFile: path.join(logs, "projects.json"),
      apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
      assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const panelLog = [];
let panel = null;
const startPanel = async () => {
  panel = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PANEL_CONFIG: configPath,
      HERMES_HOME: path.join(dir, "hermes"),
      CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
      PANEL_TOKEN: "",
      API_SERVER_KEY: "",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_ASKPASS: "echo",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  panel.stdout.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  panel.stderr.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  const up = await waitFor(async () => (await fetch(`${base}/api/state`)).ok, { timeoutMs: 40_000, what: "the sandbox panel to answer /api/state" });
  if (!up) throw new Error(`the sandbox panel never came up on ${base}\n${panelLog.slice(-20).join("\n")}`);
};
const stopPanel = async () => {
  if (!panel) return;
  const p = panel;
  panel = null;
  p.kill();
  const gone = await waitFor(() => p.exitCode !== null || p.signalCode !== null, { timeoutMs: 15_000, what: "the panel to exit" });
  if (!gone && p.pid) {
    try {
      execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      /* already gone */
    }
    await waitFor(() => p.exitCode !== null || p.signalCode !== null, { timeoutMs: 8_000, what: "the panel to be gone" });
  }
  p.stdout?.destroy();
  p.stderr?.destroy();
};

const api = async (route, body, method) => {
  const res = await fetch(`${base}${route}`, {
    method: method || (body ? "POST" : "GET"),
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const rows = async () => {
  const state = (await api("/api/state")).body;
  return state.projects?.find((p) => p.name === PROJECT)?.worktrees || [];
};
const byTail = (list, tail) => list.find((row) => slash(row.path).endsWith(`/${tail}`)) || null;

// ---- the capture path: inside the repo, because the temp dir goes away ---------------------------------------------
const shotDir = path.join(ROOT, "ledger", "verify", "round-tree-names");
mkdirSync(shotDir, { recursive: true });
const shotFile = path.join(shotDir, "chart.png");

const playwright = loadPlaywright();
if (!playwright) {
  console.log("BROWSER-HALF-NOT-RUN: no Playwright install found; set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright");
  console.log("RESULT: FAIL 0 checks");
  process.exit(2);
}

let browser = null;
try {
  await startPanel();
  note(`sandbox panel: ${base} (project ${PROJECT})`);

  // 1. THE SERVER HALF: the record rides the rows, and only the rows it names.
  const five = await waitFor(async () => {
    const now = await rows();
    return now.length >= 5 ? now : null;
  }, { timeoutMs: 60_000, what: "all five worktrees on the board" });
  ok("the board drew the checkout and all four trees", (five || []).length >= 5, `${(five || []).length} rows`);

  const parentRow = byTail(five, PARENT_TAIL);
  const stage1Row = byTail(five, STAGE1_TAIL);
  const stage2Row = byTail(five, STAGE2_TAIL);
  const plainRow = byTail(five, PLAIN_TAIL);
  for (const [name, row] of [["parent", parentRow], ["stage 1", stage1Row], ["stage 2", stage2Row], ["plain tree", plainRow]]) {
    ok(`the ${name} is a row on the board`, Boolean(row), row ? slash(row.path) : "missing");
  }
  check("the parent row carries the round's record, named by the TASK", parentRow?.round?.display, TASK_TITLE);
  check("the parent's record says which tree it is", parentRow?.round?.role, "parent");
  check("stage 1 reads its stage and position, not a directory name", stage1Row?.round?.display, "Stage 1: probe");
  check("stage 2 reads its stage and position, not a directory name", stage2Row?.round?.display, "Stage 2: implement");
  check("a tree no round cut carries no record at all", plainRow && "round" in plainRow, false);

  // 2. THE PAGE HALF, in a profile whose treenames map is EMPTY.
  browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  await context.addInitScript((project) => {
    // Harness setup, not what is asserted: a fresh browser opens every project collapsed, and a collapsed chart has
    // no rows to read. The treenames map is deliberately NOT touched.
    localStorage.setItem("wm.expandedProjects", JSON.stringify([project]));
  }, PROJECT);
  await context.addInitScript(() => {
    // A tap on the page's own stream: every `row` frame the panel broadcasts is kept, so the frame half can be
    // asserted instead of assumed. The page opens its EventSource after this script runs.
    window.__rowFrames = [];
    const Real = window.EventSource;
    window.EventSource = function tap(...args) {
      const es = new Real(...args);
      es.addEventListener("row", (e) => {
        try {
          window.__rowFrames.push(JSON.parse(e.data));
        } catch {
          window.__rowFrames.push({ unreadable: true });
        }
      });
      return es;
    };
    window.EventSource.prototype = Real.prototype;
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String((e && e.message) || e)));

  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction((project) => Boolean(document.querySelector(`tbody[data-tbody="${project}"]`)), PROJECT, { timeout: 40_000 });
  const treenames = await page.evaluate(() => localStorage.getItem("wtgui.treenames"));
  ok("this browser has never typed a name: wtgui.treenames is empty", treenames === null || treenames === "{}", String(treenames));

  const drawn = async () =>
    page.$$eval(`tbody[data-tbody="${PROJECT}"] tr.row`, (els) =>
      els.map((tr) => {
        const title = tr.querySelector(".row-name");
        return { path: title?.getAttribute("title") || "", name: title?.textContent || "" };
      }),
    );
  const painted = await waitFor(async () => {
    const list = await drawn();
    return list.length >= 5 && list.some((row) => row.name === TASK_TITLE) ? list : null;
  }, { timeoutMs: 60_000, what: "the chart to paint the round's rows" });
  ok("the chart drew every row", Boolean(painted), painted ? `${painted.length} rows` : "none");
  for (const [tail, want] of Object.entries(WANT)) {
    const row = (painted || []).find((r) => r.path.endsWith(`/${tail}`));
    check(`the chart paints "${want}" on ${tail}`, row?.name, want);
  }
  const plainPainted = (painted || []).find((r) => r.path.endsWith(`/${PLAIN_TAIL}`));
  check("a tree no round cut falls back to its directory name", plainPainted?.name, PLAIN_TAIL);

  // The capture: the project's own section, so the reader sees the titles under one another.
  const chart = page.locator(`section.project[data-project="${PROJECT}"]`);
  await chart.screenshot({ path: shotFile });
  note(`capture: ${shotFile}`);

  // 3. THE `row` FRAME HALF: a live frame REPLACES the page's row object, so a name stamped only into a snapshot
  // would be erased here. The press is retried because the periodic scan may hold the row (409) for a moment.
  let pressed = null;
  for (let attempt = 0; attempt < 10 && !pressed; attempt += 1) {
    const res = await api("/api/refresh/row", { project: PROJECT, path: parentRow.path, reconcile: true });
    if (res.status === 200) pressed = res;
    else await sleep(1200);
  }
  ok("the row's reconcile press answered", Boolean(pressed), pressed ? `${pressed.status} ok` : "never accepted; a scan kept holding the row");
  const frames = await waitFor(async () => {
    const got = await page.evaluate(() => window.__rowFrames || []);
    return got.length ? got : null;
  }, { timeoutMs: 30_000, what: "a live row frame at the page" });
  ok("a live row frame reached the page", Boolean(frames), `${(frames || []).length} frame(s)`);
  const parentFrame = (frames || []).find((f) => slash(f?.row?.path || "").endsWith(`/${PARENT_TAIL}`));
  check("the live row frame carries the round's record as well", parentFrame?.row?.round?.display, TASK_TITLE);
  const afterFrame = await waitFor(async () => {
    const list = await drawn();
    return list.some((r) => r.path.endsWith(`/${PARENT_TAIL}`)) ? list : null;
  }, { timeoutMs: 30_000, what: "the chart after the row frame" });
  for (const [tail, want] of Object.entries(WANT)) {
    const row = (afterFrame || []).find((r) => r.path.endsWith(`/${tail}`));
    check(`after a live row frame, ${tail} still reads "${want}"`, row?.name, want);
  }
  ok("no page errors were raised", pageErrors.length === 0, pageErrors.join(" | ") || "none");
  await context.close();
} catch (err) {
  failures += 1;
  console.log(`FAIL  the gate threw: ${String((err && err.message) || err)}`);
  note(panelLog.slice(-20).join("\n"));
} finally {
  try {
    await browser?.close();
  } catch {
    /* already closed */
  }
  await stopPanel();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

console.log(`RESULT: ${failures === 0 ? "PASS" : "FAIL"} ${checks} checks`);
process.exit(failures === 0 ? 0 : 1);
