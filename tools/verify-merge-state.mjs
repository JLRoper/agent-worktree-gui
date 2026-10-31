// MERGE STATE, unfolded: every commit off remote main on its own line, and the file lists behind their own folds.
//
//   PANEL_PLAYWRIGHT_ROOT=C:/ProjectDevelopment/heroes-js node tools/verify-merge-state.mjs
//
// WHAT WAS WRONG. The three things a reader opens a worktree to see — the commits it carries off remote main, the
// files it has changed, the files it has added — were three `<div class="col">` blocks pushed into one flex row
// (`<div class="cols">`, `tr.detail .col { min-width: 300px }`). A tree with five commits and forty changed files
// put the commits in a 300px column beside two other 300px columns, so a commit subject wrapped into a cramped
// ribbon, and the file lists were a wall of names standing above the agents whether or not anyone wanted them.
//
// NOW. Unfolding MERGE STATE gives the commit list the full width of the row, one commit per line, and the list is
// never clipped: a long one extends and the panel scrolls. Modified and Untracked are one-line strips under it,
// each carrying its count, each with its own fold, so the names are there when they are asked for and not before.
// The three folds are independent: opening a file list does not move the merge state strip, opening one file list
// does not touch the other, and folding merge state does not forget which file lists were open.
//
// Everything below happens in a sandbox of its own: a throwaway repo with a bare `origin`, three hand-cut
// worktrees (one with five commits and a dirty tree, one with fourteen commits and a clean tree, one with no
// commits at all), a throwaway HERMES_HOME, its own PANEL_CONFIG with its own port and its own logs, and an
// apiServer pointed at a dead port so nothing here can reach the live gateway. The live panel on 7331 and the live
// gateway on 8642 are never touched, no branch of this repository is cut or renamed, and the whole temp root is
// deleted at the end.
//
// WHAT IS DRIVEN, AND WHAT IS ONLY INSPECTED
//
//   driven        the data: /api/state carries the tree's own unmergedCommits, dirtyFiles and untrackedFiles, so
//                 the browser half is asserted against the row the server really built, not against a fixture
//   driven        the browser (Playwright, headless Chromium): the commit list holds one line per commit, full
//                 width, with all fourteen of a long list present and none clipped; the two file strips are one
//                 line each, carry their counts, and hide their names; each opens and closes on its own and
//                 independently of the merge state strip; the choice survives folding and unfolding merge state;
//                 the clean tree gets no commit list and no strips, and the tree with commits but a clean working
//                 tree gets a commit list and no strips; the Description strip above and the Liveness strip below
//                 are still there, in that order, still folded at rest and still opening from their own heads; no
//                 page errors
//   inspected     that lib/scan.js builds unmergedCommits from `git log --oneline` against the project's base ref —
//                 read off the file, not re-derived here; this script asserts only what the row carries
//
// The browser half needs a Playwright install. Point the script at one with PANEL_PLAYWRIGHT_ROOT (a directory
// holding node_modules/playwright, or the package itself); without one the script says BROWSER-HALF-NOT-RUN and
// exits 2 rather than claiming a pass.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (!same) failures += 1;
  console.log(`${same ? "PASS" : "FAIL"}  ${name}${same ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
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
const commitIn = (dir, message) =>
  git(dir, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", message]);
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

// A gateway that is never reached: the panel boots, scans and serves without one, and nothing in this change
// touches a run. Its whole job is to stop the panel looking for the live gateway on 8642.
function makeStub() {
  const server = createServer((req, res) => {
    const json = (code, body) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (req.url === "/v1/capabilities") return json(200, { version: "0.0.0-stub", features: {} });
    json(404, {});
  });
  const close = () => new Promise((r) => server.close(() => r()));
  return { server, close };
}

// ---- the sandbox ---------------------------------------------------------------------------------
// Three trees, each of which exists to answer one of the acceptance questions. The tags are six hex characters
// because that is what a tree's name carries and what the panel's own records are keyed on.
const TAG_MIXED = "a1b2c3";
const TAG_LONG = "b2c3d4";
const TAG_CLEAN = "c3d4e5";
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-merge-state-"));
const rootDir = path.join(dir, "scan-root");
const repo = path.join(rootDir, "sandbox-repo");
const originDir = path.join(dir, "origin.git");
const home = path.join(dir, "hermes-home");
const configDir = path.join(dir, "panel");
const cwdDir = path.join(dir, "panel-cwd");
const PROJECT = "sandbox-repo";
const BRANCH_MIXED = `wtgui/merge-state-mixed-${TAG_MIXED}`;
const BRANCH_LONG = `wtgui/merge-state-long-${TAG_LONG}`;
const BRANCH_CLEAN = `wtgui/merge-state-clean-${TAG_CLEAN}`;
const TREE_MIXED = path.join(repo, ".worktrees", `merge-state-mixed-${TAG_MIXED}`);
const TREE_LONG = path.join(repo, ".worktrees", `merge-state-long-${TAG_LONG}`);
const TREE_CLEAN = path.join(repo, ".worktrees", `merge-state-clean-${TAG_CLEAN}`);

// Five commits, one of them with a subject long enough that a 300px column would wrap it into a ribbon — which is
// the cramped shape the flex row produced and the reason the list is full width now.
const MIXED_SUBJECTS = [
  "Cut the merge-state strip back to the commits that are actually off remote main",
  "Give the commit list the full width of the row instead of one of three columns",
  "Put the changed files behind a fold of their own so they stop crowding the agents",
  "Carry the count on the folded strip so the reader knows what is behind it",
  "Prove the three folds move independently of one another in a real browser",
];
const LONG_COUNT = 14;

for (const d of [rootDir, repo, path.join(repo, ".worktrees"), originDir, home, configDir, cwdDir]) {
  mkdirSync(d, { recursive: true });
}
git(originDir, ["init", "-q", "--bare"]);
git(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# sandbox repo\n", "utf8");
git(repo, ["add", "."]);
commitIn(repo, "first");
git(repo, ["remote", "add", "origin", originDir]);
git(repo, ["push", "-q", "origin", "main"]);

const cut = (tree, branch) => {
  const added = git(repo, ["worktree", "add", "-q", "-b", branch, tree]);
  if (!added.ok) {
    console.log(`FAIL  the sandbox worktree ${path.basename(tree)} could not be cut — ${added.err || added.out}`);
    failures += 1;
  }
};
cut(TREE_MIXED, BRANCH_MIXED);
cut(TREE_LONG, BRANCH_LONG);
cut(TREE_CLEAN, BRANCH_CLEAN);

// The mixed tree: five commits off main, then a working tree that is genuinely dirty — three tracked files
// changed and two files it has never added.
const MIXED_FILES = [];
MIXED_SUBJECTS.forEach((subject, i) => {
  const file = `step-${i + 1}.txt`;
  MIXED_FILES.push(file);
  writeFileSync(path.join(TREE_MIXED, file), `work ${i + 1}\n`, "utf8");
  git(TREE_MIXED, ["add", "."]);
  commitIn(TREE_MIXED, subject);
});
const DIRTY_PATHS = MIXED_FILES.slice(0, 3);
for (const file of DIRTY_PATHS) writeFileSync(path.join(TREE_MIXED, file), `work edited\n`, "utf8");
const UNTRACKED_PATHS = ["leftover-notes.md", "scratch/"];
mkdirSync(path.join(TREE_MIXED, "scratch"), { recursive: true });
writeFileSync(path.join(TREE_MIXED, "leftover-notes.md"), "notes\n", "utf8");
writeFileSync(path.join(TREE_MIXED, "scratch", "probe.txt"), "probe\n", "utf8");

// The long tree: fourteen commits off main and a clean working tree, so the commit list is the only thing it has.
// Fourteen is under the server's own read cap, so what the browser is asked to show is the whole of the list.
for (let i = 1; i <= LONG_COUNT; i += 1) {
  writeFileSync(path.join(TREE_LONG, `long-${i}.txt`), `line ${i}\n`, "utf8");
  git(TREE_LONG, ["add", "."]);
  commitIn(TREE_LONG, `Long-tree commit ${i} of ${LONG_COUNT}, still off remote main`);
}

// The clean tree: cut from main, never committed to, nothing changed in it.

// The job store the panel loads at boot: one finished run in the mixed tree, so the DESCRIPTION strip above MERGE
// STATE is on the row and its survival can be checked rather than assumed. Nothing here is running, so the panel
// has nothing to poll and nothing to re-anchor.
const PROMPT_MIXED =
  "Restore the detail behind the merge-state strip. EVERY commit off remote main, one per line. CANARY-THIRD-SENTENCE";
const EXPECT_DESC = "Restore the detail behind the merge-state strip. EVERY commit off remote main, one per line.";
const seeded = [
  {
    id: "aaaa1111",
    thread: "wtgui-fixture-merge-state-aaaa11",
    turn: 1,
    prompt: PROMPT_MIXED,
    displayPrompt: PROMPT_MIXED,
    cwd: TREE_MIXED,
    worktree: true,
    worktreePath: TREE_MIXED,
    projectPath: repo,
    ownerPath: TREE_MIXED,
    branch: BRANCH_MIXED,
    runId: "seed-aaaa1111",
    status: "done",
    exitCode: 0,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:01:00.000Z",
    model: "sandbox/stub",
    lines: [{ kind: "dim", text: "seeded for the merge-state check" }],
    artifacts: [],
    attachments: [],
  },
];
mkdirSync(path.join(configDir, "logs"), { recursive: true });
writeFileSync(
  path.join(configDir, "logs", "jobs.json"),
  `${JSON.stringify({ version: 1, savedAt: new Date().toISOString(), jobs: seeded }, null, 1)}\n`,
  "utf8",
);

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
      // Nothing in this sandbox is old enough to be interesting: the age collapse must not hold a row back.
      hideOlderThanDays: 0,
      defaultCwd: cwdDir,
      projectsCacheFile: path.join(configDir, "logs", "projects.json"),
      apiServer: { url: stubUrl, key: "sandbox-key" },
      assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const base = `http://127.0.0.1:${port}`;
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
const state = async () => (await fetch(`${base}/api/state`)).json();
const rowFor = async (treePath) => {
  const s = await state();
  return s.projects?.find((p) => p.name === PROJECT)?.worktrees?.find((w) => norm(w.path) === norm(treePath)) || null;
};

// ---- the browser half ----------------------------------------------------------------------------
async function browserPhase(pw) {
  const pageErrors = [];
  const browser = await pw.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1200 } });
  // Harness setup, not part of what is asserted: a fresh browser remembers no layout, so the sandbox project would
  // open collapsed and none of its rows would be on the page.
  await context.addInitScript((project) => {
    localStorage.setItem("wm.expandedProjects", JSON.stringify([project]));
  }, PROJECT);
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${String((e && e.message) || e)}`));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`);
  });

  const openRow = async (treePath) => {
    const row = await rowFor(treePath);
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
  const unfoldGit = async (key) => {
    const block = page.locator(`tr.detail[data-detail="${key}"] .git-block`);
    if ((await block.getAttribute("class")).includes("collapsed")) {
      await page.locator(`tr.detail[data-detail="${key}"] .git-head`).click();
      await page.waitForTimeout(120);
    }
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
  const out = { shots: [] };

  await page.goto(base, { waitUntil: "domcontentloaded" });

  // ---- the tree with commits off main AND a dirty working tree: everything the strip can carry.
  const keyMixed = await openRow(TREE_MIXED);
  const mixed = `tr.detail[data-detail="${keyMixed}"]`;
  ok("browser: the row's merge state strip is folded at rest", (await page.locator(`${mixed} .git-block`).getAttribute("class")).includes("collapsed"));
  ok("browser: folded, its body takes no space", !(await page.locator(`${mixed} .git-body`).isVisible()));

  await unfoldGit(keyMixed);
  ok("browser: unfolding it shows the body", await page.locator(`${mixed} .git-body`).isVisible());
  const s1 = await shot("merge-state-open.png");
  if (s1) out.shots.push(s1);

  // (1) EVERY commit off remote main, one per line, full width.
  const commitSel = `${mixed} .git-commits-list li`;
  check("browser: one list item per commit off remote main", await page.locator(commitSel).count(), MIXED_SUBJECTS.length);
  const commitLines = await page.evaluate(
    ({ sel, n }) => {
      const lis = [...document.querySelectorAll(sel)];
      const body = document.querySelector(sel.split(" li")[0]);
      const td = document.querySelector(sel.split(" ")[0] + " > td") || document.querySelector(sel.split(" ")[0]).closest("td");
      return {
        n: lis.length,
        shas: lis.map((li) => (li.querySelector(".dimmer")?.textContent || "").trim()),
        texts: lis.map((li) => li.textContent.trim()),
        tops: lis.map((li) => Math.round(li.getBoundingClientRect().top)),
        widths: lis.map((li) => Math.round(li.getBoundingClientRect().width)),
        rowWidth: td ? Math.round(td.getBoundingClientRect().width) : 0,
        lineHeights: lis.map((li) => Math.round(li.getBoundingClientRect().height)),
        listOverflow: getComputedStyle(body).overflowY,
        clippedByList: body.scrollHeight - body.clientHeight,
        heading: document.querySelector(sel.split(" li")[0]).closest(".git-commits").querySelector("h4").textContent,
        legacyCols: document.querySelectorAll(`${sel.split(" ")[0]} .cols, ${sel.split(" ")[0]} .col`).length,
        want: n,
      };
    },
    { sel: commitSel, n: MIXED_SUBJECTS.length },
  );
  check("browser: every commit is in the list", commitLines.n, MIXED_SUBJECTS.length);
  ok(
    "browser: each commit carries a short sha and its subject",
    commitLines.shas.every((s) => /^[0-9a-f]{7,}$/.test(s)) && MIXED_SUBJECTS.every((sub) => commitLines.texts.some((t) => t.includes(sub))),
    commitLines.shas.join(", "),
  );
  check(
    "browser: the list is newest first, the order git log gives",
    commitLines.texts.map((t) => t.replace(/^[0-9a-f]+\s*/, "")),
    MIXED_SUBJECTS.slice().reverse(),
  );
  ok(
    "browser: one commit per line — no two share a line",
    new Set(commitLines.tops).size === commitLines.n && commitLines.tops.every((t, i) => i === 0 || t > commitLines.tops[i - 1]),
    `tops ${commitLines.tops.join(", ")}`,
  );
  ok(
    "browser: the list is full width, not a cramped column",
    commitLines.widths.every((w) => w > 500 && w > commitLines.rowWidth * 0.7),
    `each line ${commitLines.widths[0]}px inside a ${commitLines.rowWidth}px row`,
  );
  ok(
    "browser: the list is not clipped — nothing overflows a hidden box",
    commitLines.clippedByList <= 1,
    `list scrollHeight − clientHeight = ${commitLines.clippedByList}, overflow-y ${commitLines.listOverflow}`,
  );
  ok("browser: the heading still names the remote and the diffstat", /^Commits not on origin\/main/.test(commitLines.heading), commitLines.heading);
  check("browser: the old three-column flex row is gone", commitLines.legacyCols, 0);

  // (2) Modified and Untracked: one-line strips, counts on them, names folded away.
  check("browser: one strip per file list", await page.locator(`${mixed} .git-sub`).count(), 2);
  check(
    "browser: the strips are headed by their counts",
    await page.locator(`${mixed} .git-sub-head h4`).allTextContents(),
    [`Modified (${DIRTY_PATHS.length})`, `Untracked (${UNTRACKED_PATHS.length})`],
  );
  const subSel = (kind) => `${mixed} .git-sub[data-git-sub="${keyMixed}::${kind}"]`;
  ok("browser: both strips start folded", (await page.locator(`${subSel("modified")}.collapsed`).count()) === 1 && (await page.locator(`${subSel("untracked")}.collapsed`).count()) === 1);
  ok("browser: a folded strip hides its names", !(await page.locator(`${subSel("modified")} > ul`).isVisible()) && !(await page.locator(`${subSel("untracked")} > ul`).isVisible()));
  const stripShapes = await page.evaluate(
    (sels) =>
      sels.map((s) => {
        const head = document.querySelector(`${s} .git-sub-head`);
        const block = document.querySelector(s);
        return { head: Math.round(head.getBoundingClientRect().height), block: Math.round(block.getBoundingClientRect().height) };
      }),
    [subSel("modified"), subSel("untracked")],
  );
  ok(
    "browser: folded, each strip is one line high",
    stripShapes.every((s) => s.head > 0 && s.head <= 24 && Math.abs(s.block - s.head) <= 6),
    stripShapes.map((s) => `${s.head}px head / ${s.block}px strip`).join(", "),
  );

  // (3) The folds are independent, in every direction.
  await page.locator(`${subSel("modified")} .git-sub-head`).click();
  await page.waitForTimeout(100);
  check("browser: opening Modified shows its files", await page.locator(`${subSel("modified")} > ul li`).allTextContents(), DIRTY_PATHS.map((p) => `M ${p}`));
  ok("browser: opening Modified leaves Untracked folded", (await page.locator(`${subSel("untracked")}.collapsed`).count()) === 1);
  ok("browser: opening Modified leaves merge state unfolded", !(await page.locator(`${mixed} .git-block`).getAttribute("class")).includes("collapsed"));
  const s2 = await shot("merge-state-modified-open.png");
  if (s2) out.shots.push(s2);

  await page.locator(`${subSel("untracked")} .git-sub-head`).click();
  await page.waitForTimeout(100);
  check("browser: opening Untracked shows its files", await page.locator(`${subSel("untracked")} > ul li`).allTextContents(), UNTRACKED_PATHS);
  ok("browser: opening Untracked leaves Modified open", (await page.locator(`${subSel("modified")}.collapsed`).count()) === 0);

  await page.locator(`${subSel("modified")} .git-sub-head`).click();
  await page.waitForTimeout(100);
  ok("browser: closing Modified leaves Untracked open", (await page.locator(`${subSel("untracked")}.collapsed`).count()) === 0 && (await page.locator(`${subSel("untracked")} > ul`).isVisible()));
  ok("browser: closing Modified hides only its own files", !(await page.locator(`${subSel("modified")} > ul`).isVisible()));

  // Folding the strip around them must not forget them: fold merge state, unfold it, and the one that was open is
  // still open while the one that was closed is still closed.
  await page.locator(`${mixed} .git-head`).click();
  await page.waitForTimeout(120);
  ok("browser: folding merge state hides the whole body", !(await page.locator(`${mixed} .git-body`).isVisible()));
  check("browser: folding merge state forgets neither strip's own fold", [await page.locator(`${subSel("modified")}.collapsed`).count(), await page.locator(`${subSel("untracked")}.collapsed`).count()], [1, 0]);
  await page.locator(`${mixed} .git-head`).click();
  await page.waitForTimeout(120);
  ok("browser: unfolded again, Untracked is still the one that is open", (await page.locator(`${subSel("untracked")} > ul`).isVisible()) && !(await page.locator(`${subSel("modified")} > ul`).isVisible()));

  // (5) The Description strip above and the Liveness strip below are untouched, and in that order.
  const shape = await page.evaluate((sel) => {
    const inner = document.querySelector(sel).querySelector(".detail-inner");
    const kids = [...inner.children];
    const desc = inner.querySelector(".desc-block");
    return {
      order: kids.map((k) => k.className.split(" ")[0]),
      desc: kids.indexOf(desc),
      git: kids.indexOf(inner.querySelector(".git-block")),
      live: kids.indexOf(inner.querySelector(".live-block")),
      descHead: desc?.querySelector(".desc-head h4")?.textContent || null,
      descText: [...(desc?.querySelectorAll(".desc-body li") || [])].map((li) => li.textContent).join(" "),
      descFolded: Boolean(desc?.classList.contains("collapsed")),
      liveHead: inner.querySelector(".live-block .live-head h4")?.textContent || null,
    };
  }, mixed);
  ok("browser: the Description strip is still there, above merge state", shape.desc === 0 && shape.desc < shape.git, shape.order.join(" · "));
  check("browser: it still says what the branch was started to do", shape.descText, EXPECT_DESC);
  check("browser: its heading is untouched", shape.descHead, "Description");
  ok("browser: the Liveness strip is still there, below merge state", shape.live > shape.git && shape.live >= 0, `liveness at ${shape.live}, merge state at ${shape.git}`);
  check("browser: its heading is untouched", shape.liveHead, "Liveness evidence");
  // The description strip is main's to own — folded at rest, opening from its own head. This change must not have
  // moved it, changed its words or taken its click.
  ok("browser: the Description strip is still folded at rest, the way the board draws it", shape.descFolded);
  await page.locator(`${mixed} .desc-head`).click();
  await page.waitForTimeout(100);
  ok("browser: it still opens from its own head", !(await page.locator(`${mixed} .desc-block`).getAttribute("class")).includes("collapsed"));
  await page.locator(`${mixed} .desc-head`).click();
  await page.waitForTimeout(100);

  // ---- the long tree: fourteen commits, and none of them hidden.
  const keyLong = await openRow(TREE_LONG);
  const long = `tr.detail[data-detail="${keyLong}"]`;
  await unfoldGit(keyLong);
  const longShape = await page.evaluate((sel) => {
    const lis = [...document.querySelectorAll(`${sel} .git-commits-list li`)];
    const list = document.querySelector(`${sel} .git-commits-list`);
    return {
      n: lis.length,
      visible: lis.filter((li) => li.getBoundingClientRect().height > 0).length,
      clipped: list.scrollHeight - list.clientHeight,
      overflow: getComputedStyle(list).overflowY,
      height: Math.round(list.getBoundingClientRect().height),
      line: Math.round((lis[1]?.getBoundingClientRect().top || 0) - (lis[0]?.getBoundingClientRect().top || 0)),
      subs: document.querySelectorAll(`${sel} .git-sub`).length,
    };
  }, long);
  check("browser: the long list holds every commit the row carries", longShape.n, LONG_COUNT);
  check("browser: every one of them is drawn", longShape.visible, LONG_COUNT);
  ok("browser: none of them is clipped away", longShape.clipped <= 1, `scrollHeight − clientHeight = ${longShape.clipped}, overflow-y ${longShape.overflow}`);
  ok("browser: the list is as tall as its lines, not capped", longShape.height >= longShape.line * LONG_COUNT, `${longShape.height}px for ${LONG_COUNT} lines of ${longShape.line}px`);
  check("browser: a clean working tree gets no file strips", longShape.subs, 0);
  const s3 = await shot("merge-state-long-list.png");
  if (s3) out.shots.push(s3);

  // ---- the clean tree: nothing unmerged and nothing changed, so nothing to fold.
  const keyClean = await openRow(TREE_CLEAN);
  const clean = `tr.detail[data-detail="${keyClean}"]`;
  await unfoldGit(keyClean);
  const cleanShape = await page.evaluate((sel) => ({
    commits: document.querySelectorAll(`${sel} .git-commits-list li`).length,
    blocks: document.querySelectorAll(`${sel} .git-commits`).length,
    subs: document.querySelectorAll(`${sel} .git-sub`).length,
    heads: document.querySelectorAll(`${sel} .git-sub-head`).length,
    bodyVisible: Boolean(document.querySelector(`${sel} .git-body`)?.getBoundingClientRect().height),
  }), clean);
  check("browser: a clean tree with nothing unmerged lists no commits", cleanShape.commits, 0);
  check("browser: and has no empty commit block standing there", cleanShape.blocks, 0);
  check("browser: and no empty Modified / Untracked strips", [cleanShape.subs, cleanShape.heads], [0, 0]);
  ok("browser: its merge state still unfolds to its own facts", cleanShape.bodyVisible);

  check("browser: the page threw nothing", pageErrors, []);
  await browser.close();
  return out;
}

// ---- the run -------------------------------------------------------------------------------------
let shots = null;
try {
  await startPanel();
  const discovered = await waitFor(
    async () => {
      const s = await state();
      const p = s.projects?.find((x) => x.name === PROJECT);
      return Boolean(p && (p.worktrees || []).length >= 4);
    },
    { timeoutMs: 60_000, what: "the sandbox project and its trees to be scanned" },
  );
  ok("the sandbox project and its three trees are on the board", discovered);

  // The rows must carry the data the browser half is asserted against — and it must be the FULL scan's verdict,
  // which is the only pass that builds the commit list.
  const fullMixed = await waitFor(
    async () => {
      const r = await rowFor(TREE_MIXED);
      return Boolean(r && (r.unmergedCommits || []).length === MIXED_SUBJECTS.length);
    },
    { timeoutMs: 60_000, what: "the mixed tree's full scan to land its commit list" },
  );
  ok("the mixed tree's row carries its unmerged commits", fullMixed);
  const rowMixed = await rowFor(TREE_MIXED);
  check("the row carries one entry per commit off origin/main, newest first", (rowMixed.unmergedCommits || []).length, MIXED_SUBJECTS.length);
  check("with a short sha and a subject on each", (rowMixed.unmergedCommits || []).map((c) => c.subject), MIXED_SUBJECTS.slice().reverse());
  check("the row carries the changed files", (rowMixed.dirtyFiles || []).map((f) => f.path), DIRTY_PATHS);
  check("the row carries the untracked files", (rowMixed.untrackedFiles || []).slice().sort(), UNTRACKED_PATHS.slice().sort());
  ok("the row says it is UNMERGED", String(rowMixed.verdict || "").startsWith(`UNMERGED (${MIXED_SUBJECTS.length} commit`), String(rowMixed.verdict));

  const fullLong = await waitFor(
    async () => {
      const r = await rowFor(TREE_LONG);
      return Boolean(r && (r.unmergedCommits || []).length === LONG_COUNT);
    },
    { timeoutMs: 60_000, what: "the long tree's full scan to land its commit list" },
  );
  ok(`the long tree's row carries all ${LONG_COUNT} of its commits`, fullLong);

  const cleanRow = await waitFor(
    async () => {
      const r = await rowFor(TREE_CLEAN);
      return Boolean(r && r.verdict && !String(r.verdict).startsWith("UNMERGED"));
    },
    { timeoutMs: 60_000, what: "the clean tree to be scanned" },
  );
  ok("the clean tree carries nothing unmerged", cleanRow);
  const rowClean = await rowFor(TREE_CLEAN);
  check("and no changed or untracked files", [(rowClean.dirtyFiles || []).length, (rowClean.untrackedFiles || []).length], [0, 0]);
  check("and no commits off main", (rowClean.unmergedCommits || []).length, 0);

  // The description strip this change must not disturb: the panel writes the record from the seeded run at boot.
  const described = await waitFor(
    async () => {
      const r = await rowFor(TREE_MIXED);
      return Boolean(r && r.description && r.description.text);
    },
    { timeoutMs: 60_000, stepMs: 700, what: "the seeded run's description to reach the row" },
  );
  ok("the mixed tree's row carries the description this change sits under", described, (await rowFor(TREE_MIXED))?.description?.text || "");

  console.log("\n== the browser: the commit list, the two sub-folds, and the strips around them ==");
  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN  the client half of this change was not exercised in a browser.");
    note("re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-merge-state.mjs");
    failures += 1;
  } else {
    shots = await browserPhase(pw);
    if (shots?.shots?.length) note(`screenshots: ${shots.shots.join(" · ")}`);
  }

  console.log("\n== summary ==");
  console.log(`${checks} checks, ${failures} failed`);
  if (shots) {
    console.log("\nWHAT WAS DRIVEN: a sandbox panel booted over three hand-cut worktrees (five commits and a dirty tree,");
    console.log("fourteen commits and a clean tree, nothing at all), /api/state read for the rows the server really");
    console.log("built, and headless Chromium over the running panel — the commit list line by line and full width,");
    console.log("its long form unclipped, the two file strips one line each with their counts and their names hidden,");
    console.log("every open/close combination of the three folds, the clean tree's empty ones absent, and the");
    console.log("Description and Liveness strips still there, in order, folded at rest, with zero page errors.");
    console.log("WHAT WAS INSPECTED, NOT DRIVEN: that unmergedCommits comes from `git log --oneline` against the base");
    console.log("ref — read off lib/scan.js; this script asserts only what the row carries. Nothing here re-derives the");
    console.log("expected HTML from the renderer, so the test cannot agree with any behaviour at all.");
  }
  if (!failures) console.log("MERGE-STATE-VERIFY-OK");
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
