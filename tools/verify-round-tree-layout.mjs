// A round on the worktree chart: the parent tree BESIDE the checkout, its stage trees one indent under it, and ONE
// grouped-branch marker per row that hangs - never two.
// HARNESS: LIVE GATE
//
//   node tools/verify-round-tree-layout.mjs
//   node tools/verify-round-tree-layout.mjs --root <a git archive of an earlier commit> --shots <a folder>
//
// WHAT THIS PROVES. A round cuts one frozen parent tree from main and one tree per stage from that commit. The chart
// draws that record (lib/parents.js, public/render-projects.js `childTreeOf`): the parent tree is a SIBLING of the
// checkout's own row - a tree cut from main is not main's child - and every stage tree hangs one indent under the
// parent tree, its own child one indent further. The grouped-branch marker on such a row is a SINGLE L, the └ the
// row leads with, stepping in with the row's own depth (public/chart.css). It used to draw two: the project's rail
// glyph, moved in to the row's depth, and that └.
//
// The proof is a sandbox board of its own: a throwaway repo with the round's parent tree, two stage children, a tree
// cut from the first stage (the second tier) and a plain tree no round cut, plus the queue task that carries the
// round's record and the parent book an EXISTING board has (the parent tree still recorded as cut from `main`). That
// last part is the migration proof: the page refuses a main-branch edge, so a board written before the cut stopped
// naming main draws the sibling picture without a re-cut.
//
// The live panel and the live gateway are never touched: its own port, its own PANEL_CONFIG, its own HERMES_HOME, and
// an apiServer pointed at a dead port. The temp root is deleted at the end; the captures are copied out first. The
// same file is the failing-first proof: `--root` a `git archive` of the commit before this landed and the shape
// checks fail while the captures still land.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadPlaywright, withBrowser } from "./browser.mjs";
import { ROOT, git, slash, startPanel, waitFor } from "./panel-testkit.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const PANEL_ROOT = path.resolve(opt("--root", ROOT));
const SHOTS = path.resolve(opt("--shots", path.join(ROOT, "ledger", "verify", "round-tree-layout")));

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

// ---- the round, as the cut writes it -------------------------------------------------------------------------------
const PROJECT = "sandbox-round";
const ROUND_SLUG = "carry-the-form";
const ROUND_TAG = "a1b2c3";
const TASK_TITLE = "the roll-up names its trees";
const PARENT = `${ROUND_SLUG}-${ROUND_TAG}`;
const STAGE1 = `${ROUND_SLUG}-stage-1-write-the-draft-111111`;
const STAGE2 = `${ROUND_SLUG}-stage-2-critique-the-draft-222222`;
const GRAND = `${ROUND_SLUG}-stage-1-follow-up-333333`;
const PLAIN = "plain-0a1b2c";
const WANT_NAME = { [PARENT]: TASK_TITLE, [STAGE1]: "Stage 1: write the draft", [STAGE2]: "Stage 2: critique the draft" };

const dir = mkdtempSync(path.join(tmpdir(), "wtgui-round-layout-"));
const repos = path.join(dir, "repos");
const repo = path.join(repos, PROJECT);
const logs = path.join(dir, "logs");
const worktrees = path.join(repo, ".worktrees");
for (const d of [repo, worktrees, path.join(logs, "assistants", "assistant-1"), path.join(dir, "hermes"), path.join(dir, "claude")]) mkdirSync(d, { recursive: true });

const runGit = (cwd, args) => git(cwd, args);
runGit(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, ".gitignore"), ".worktrees/\n", "utf8");
writeFileSync(path.join(repo, "README.md"), "# a round's sandbox\n", "utf8");
runGit(repo, ["add", "-A"]);
runGit(repo, ["commit", "-q", "-m", "seed the sandbox"]);
const mainSha = runGit(repo, ["rev-parse", "HEAD"]).trim();

// The round's trees, cut the way the assistant cuts them: the parent from main, the stages pinned to the round's
// frozen commit, and one tree cut from a stage (the second tier the marker has to indent for).
const treePath = (tail) => path.join(worktrees, tail);
const cut = (tail, branch, from) => runGit(repo, ["worktree", "add", "-q", "-b", branch, treePath(tail), from]);
cut(PARENT, `wtgui/${PARENT}`, "main");
const parentSha = runGit(treePath(PARENT), ["rev-parse", "HEAD"]).trim();
cut(STAGE1, `wtgui/${STAGE1}`, parentSha);
cut(STAGE2, `wtgui/${STAGE2}`, parentSha);
cut(GRAND, `work/follow-up`, parentSha);
cut(PLAIN, "work/plain", "main");
check("every tree of the round starts at the round's frozen commit", runGit(treePath(STAGE1), ["rev-parse", "HEAD"]), mainSha);

// ---- the book an EXISTING board has: the parent tree still recorded as cut from main --------------------------------
// The cut stops writing this record (lib/jobs.js `round: true`), but every board that ran a round before that has it,
// and the page must draw the sibling picture for it. `parentSha` is the commit the round froze.
const backslash = (p) => slash(p);
const record = (tail, branch, parent, why) => ({
  project: PROJECT,
  branch,
  path: backslash(treePath(tail)),
  parent,
  parentSha,
  parentRef: parent,
  parentSource: "cut",
  why,
  by: "the panel (cut from main)",
  at: new Date().toISOString(),
});
const parentsFile = path.join(logs, "parents.json");
writeFileSync(
  parentsFile,
  `${JSON.stringify(
    {
      version: 1,
      savedAt: new Date().toISOString(),
      records: [
        record(PARENT, `wtgui/${PARENT}`, "main", ""),
        record(STAGE1, `wtgui/${STAGE1}`, `wtgui/${PARENT}`, ""),
        record(STAGE2, `wtgui/${STAGE2}`, `wtgui/${PARENT}`, ""),
        record(GRAND, "work/follow-up", `wtgui/${STAGE1}`, ""),
      ],
    },
    null,
    0,
  )}\n`,
  "utf8",
);

// ---- the queue task: the round's names, as #274 records them --------------------------------------------------------
const queueTask = {
  id: 7,
  title: TASK_TITLE,
  detail: "a round's parent tree, two stage children and one tree cut from a stage",
  state: "done",
  createdBy: "the reader",
  createdAt: new Date().toISOString(),
  doneAt: new Date().toISOString(),
  doneBy: "the driver",
  project: PROJECT,
  worktree: backslash(treePath(PARENT)),
  pipelineRun: {
    pipeline: "round-a",
    stage: "S2",
    round: {
      parentPath: backslash(treePath(PARENT)),
      parent: `wtgui/${PARENT}`,
      slug: ROUND_SLUG,
      tag: ROUND_TAG,
      display: TASK_TITLE,
      sha: mainSha,
    },
    trees: {
      S1: { path: backslash(treePath(STAGE1)), branch: `wtgui/${STAGE1}`, position: 1, stageName: "write the draft", tag: "111111" },
      S2: { path: backslash(treePath(STAGE2)), branch: `wtgui/${STAGE2}`, position: 2, stageName: "critique the draft", tag: "222222" },
    },
  },
};
writeFileSync(path.join(logs, "assistants", "assistant-1", "queue.json"), `${JSON.stringify({ version: 1, nextId: 8, tasks: [queueTask] }, null, 2)}\n`, "utf8");

// ---- the sandbox panel ---------------------------------------------------------------------------------------------

const panel = await startPanel({
  root: PANEL_ROOT,
  dir,
  config: {
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
    parentsFile,
    assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
  },
});
const base = panel.base;
const rowsOf = async () => {
  const state = await (await fetch(`${base}/api/state`)).json();
  return state.projects?.find((p) => p.name === PROJECT)?.worktrees || [];
};
const byTail = (list, tail) => list.find((row) => slash(row.path).endsWith(`/${tail}`)) || null;

mkdirSync(SHOTS, { recursive: true });
const shotFile = path.join(SHOTS, "chart.png");
const cropFile = path.join(SHOTS, "marks.png");
const ledgerFile = path.join(SHOTS, "layout.json");

const playwright = loadPlaywright();
if (!playwright) {
  console.log("BROWSER-HALF-NOT-RUN: no Playwright install found; set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright");
  console.log("RESULT: FAIL 0 checks");
  await panel.stop();
  rmSync(dir, { recursive: true, force: true });
  process.exit(2);
}

let verdict = null;
try {
  note(`sandbox panel: ${base} (project ${PROJECT}, panel ${PANEL_ROOT})`);

  // 1. THE SERVER HALF: the book still says `main` for the parent tree - the page is what refuses the edge.
  const six = await waitFor(async () => {
    const now = await rowsOf();
    return now.length >= 6 ? now : null;
  }, { timeoutMs: 60_000, what: "the checkout and all five trees on the board" });
  // 1. THE SERVER HALF: the book still says `main` for the parent tree - the page is what refuses the edge. The first
  // rows a boot publishes are the mapping's (no branch, verdict "…"); the shape below is only meaningful once the
  // scan has read the trees, so the wait is for the RECORD to ride the row, not merely for six paths.
  const wantParents = [
    [PARENT, "main"],
    [STAGE1, `wtgui/${PARENT}`],
    [STAGE2, `wtgui/${PARENT}`],
    [GRAND, `wtgui/${STAGE1}`],
  ];
  const scanned = await waitFor(async () => {
    const now = await rowsOf();
    return now.length >= 6 && wantParents.every(([tail, parent]) => byTail(now, tail)?.parent === parent) ? now : null;
  }, { timeoutMs: 150_000, what: "the scan to read all four round records" });
  ok("the board drew the checkout and all five trees", (six || []).length >= 6, `${(six || []).length} rows`);
  const sixRows = scanned || (await rowsOf());
  if (!scanned) {
    note(`the scan did not carry every record within 150s: ${wantParents.map(([tail, parent]) => `${tail} <- ${parent}: ${byTail(sixRows, tail)?.parent || "(none)"}`).join(" · ")}`);
    note(panel.log().split(/\r?\n/).filter((line) => /scan|parent|error/i.test(line)).slice(-12).join("\n"));
  }
  // The book itself, as the panel serves it: the page and the steward read this same answer.
  const book = await (await fetch(`${base}/api/parents?project=${encodeURIComponent(PROJECT)}`)).json();
  const bookRows = Array.isArray(book.parents) ? book.parents : [];
  note(`parent book: ${bookRows.length} record(s) ${JSON.stringify(bookRows.map((r) => `${r.branch} <- ${r.parent}`))}`);
  note(`rows read: ${sixRows.map((row) => `${row.name}${row.parent ? ` <- ${row.parent}` : ""}`).join(" · ")}`);
  const parentRow = byTail(sixRows, PARENT);
  const stage1Row = byTail(sixRows, STAGE1);
  const grandRow = byTail(sixRows, GRAND);
  check("the parent tree's record still says it was cut from main", parentRow?.parent, "main");
  check("a stage tree's record names the parent tree", stage1Row?.parent, `wtgui/${PARENT}`);

  verdict = await withBrowser(
    async ({ page, pageErrors }) => {
      await page.goto(base, { waitUntil: "domcontentloaded" });
      await page.waitForFunction((project) => Boolean(document.querySelector(`tbody[data-tbody="${project}"]`)), PROJECT, { timeout: 40_000 });

      // The shape of every row, read off the DOM the browser painted: the depth it was given, the parent it hangs
      // from, the L it leads with (the .child-tick span) and the rail glyph its first cell draws (::before). A row
      // that hangs must show exactly ONE L; a top-level row must show none.
      const readRows = () =>
        page.evaluate((project) => {
          const tbody = document.querySelector(`tbody[data-tbody="${project}"]`);
          if (!tbody) return [];
          return [...tbody.children]
            .filter((el) => el.classList.contains("row"))
            .map((tr) => {
              const td = tr.querySelector("td.name");
              const tick = tr.querySelector("td.name .row-lead .child-tick");
              const tickBox = tick ? tick.getBoundingClientRect() : null;
              const name = tr.querySelector("td.name .row-name");
              const nameBox = name ? name.getBoundingClientRect() : null;
              const rail = td ? getComputedStyle(td, "::before").content : null;
              return {
                path: tr.dataset.key || "",
                depth: tr.dataset.depth || null,
                parentKey: tr.dataset.parentKey || null,
                classes: [...tr.classList],
                ticks: tr.querySelectorAll("td.name .row-lead .child-tick").length,
                tick: tickBox ? { text: tick.textContent, x: Math.round(tickBox.left), y: Math.round(tickBox.top) } : null,
                rail: rail && rail !== "none" && rail !== "normal" && rail !== '""' ? rail : null,
                // The cell's own indent, which is what "one tier deeper" IS in the layout: `td.name`'s padding-left is
                // 12px at the top level and +16px per tier (public/chart.css). The NAME's x is not that measure - it
                // sits after the lead's own buttons, whose number differs row to row - and the tick's x alone only
                // says where the lead starts.
                padLeft: td ? Math.round(Number.parseFloat(getComputedStyle(td).paddingLeft) || 0) : null,
                cellLeft: td ? Math.round(td.getBoundingClientRect().left) : null,
                nameLeft: nameBox ? Math.round(nameBox.left) : null,
                name: name ? name.textContent.trim() : "",
              };
            });
        }, PROJECT);

      const painted = await waitFor(async () => {
        const list = await readRows();
        return list.length >= 6 && list.some((row) => row.name === TASK_TITLE) && list.some((row) => row.ticks > 0) ? list : null;
      }, { timeoutMs: 90_000, what: "the chart to paint every row of the round, with its grouped-branch markers" });
      ok("the chart drew every row", Boolean(painted), painted ? `${painted.length} rows` : "none");
      const rowFor = (tail) => (painted || []).find((row) => slash(row.path).endsWith(`/${tail}`)) || null;
      const checkoutRow = (painted || []).find((row) => !slash(row.path).includes("/.worktrees/")) || null;
      const parentDrawn = rowFor(PARENT);
      const stage1Drawn = rowFor(STAGE1);
      const stage2Drawn = rowFor(STAGE2);
      const grandDrawn = rowFor(GRAND);
      const plainDrawn = rowFor(PLAIN);
      for (const [name, row] of [
        ["checkout", checkoutRow],
        ["parent tree", parentDrawn],
        ["stage 1", stage1Drawn],
        ["stage 2", stage2Drawn],
        ["the tree cut from stage 1", grandDrawn],
        ["plain tree", plainDrawn],
      ]) {
        ok(`the ${name} is drawn`, Boolean(row), row ? row.path : "missing");
      }
      if (!checkoutRow || !parentDrawn || !stage1Drawn || !stage2Drawn || !grandDrawn) {
        return { rows: painted, shot: null, crop: null };
      }

      // 2. THE PARENT TREE IS A SIBLING OF THE CHECKOUT, not a child of it: no parent key, depth 0 (the depth is
      //    written for EVERY row now, because one indent rule reads it off every row - a parent that wrote nothing
      //    was the row the rule could not reach), no marker, the board's own top-level indent - and nothing hangs
      //    under the checkout.
      const TOP_PAD = plainDrawn.padLeft;
      check("the board's top-level indent is 12px", TOP_PAD, 12);
      check("the parent tree hangs from nobody", parentDrawn.parentKey, null);
      check("the parent tree's depth is 0: a top-level row, not its children's", parentDrawn.depth, "0");
      check("the parent tree is drawn at the plain tree's indent", parentDrawn.nameLeft, plainDrawn.nameLeft);
      check("the parent tree draws NO grouped-branch marker", parentDrawn.ticks, 0);
      ok("the parent tree is not drawn as a child", !parentDrawn.classes.includes("is-child"), parentDrawn.classes.join(" "));
      check("the parent tree sits at the checkout's own indent", parentDrawn.padLeft, checkoutRow.padLeft);
      check("and at a top-level tree's indent: it is a sibling row", parentDrawn.padLeft, TOP_PAD);
      ok("nothing hangs under the checkout", !(painted || []).some((row) => row.parentKey === checkoutRow.path), (painted || []).filter((row) => row.parentKey === checkoutRow.path).map((r) => r.name).join(", "));

      // 3. THE STAGE TREES HANG ONE INDENT UNDER THE PARENT TREE: one L each, the rail's L gone, the marker a step in.
      for (const [name, row] of [["stage 1", stage1Drawn], ["stage 2", stage2Drawn]]) {
        check(`${name} hangs from the parent tree`, row.parentKey, parentDrawn.path);
        check(`${name} is drawn one tier deep`, row.depth, "1");
        check(`${name} draws exactly ONE L`, row.ticks, 1);
        check(`${name} draws no rail L beside it`, row.rail, null);
        check(`${name}'s L is the └ it leads with`, row.tick?.text, "└");
        check(`${name} is indented one tier past the parent tree`, row.padLeft, TOP_PAD + 16);
        check(`${name}'s L starts where that indent puts it`, row.tick ? row.tick.x - parentDrawn.cellLeft : null, TOP_PAD + 16);
      }

      // 4. THE SECOND TIER: a tree cut from a stage steps in again - ONE L, one indent further. This is the "indents
      //    per deeper tier" half: the marker moves with the row and is never doubled to say the depth.
      check("the tree cut from stage 1 hangs from it", grandDrawn.parentKey, stage1Drawn.path);
      check("it is drawn two tiers deep", grandDrawn.depth, "2");
      check("it draws exactly ONE L", grandDrawn.ticks, 1);
      check("it draws no rail L beside it", grandDrawn.rail, null);
      check("it is indented one tier past the first stage tree", grandDrawn.padLeft, TOP_PAD + 32);
      check("its L is one indent past the first tier's L", grandDrawn.tick && stage1Drawn.tick ? grandDrawn.tick.x - stage1Drawn.tick.x : null, 16);

      // 5. THE NAME'S COLUMN IS THE INDENT, one indent per level and nothing else: the parent row lands in the plain
      //    tree's column, the two stage rows share one, the second tier is one step past them. This is the half a
      //    padLeft check cannot see: the markers live in the row's gutter, so a fold that sized itself to its glyph
      //    moved the row's TEXT and left the cell's padding honest.
      check("the parent and the plain tree put their names in one column", parentDrawn.nameLeft, plainDrawn.nameLeft);
      check("stage 1's name is exactly one indent past the parent's", stage1Drawn.nameLeft - parentDrawn.nameLeft, 16);
      check("the two stage rows share a column whatever markers they carry", stage2Drawn.nameLeft, stage1Drawn.nameLeft);
      check("the second tier's name is exactly one indent past its parent's", grandDrawn.nameLeft - stage1Drawn.nameLeft, 16);

      // 6. NOTHING on the chart carries two L's, every hanging row carries exactly one, and a tree no round cut is a
      //    top-level row.
      const hanging = (painted || []).filter((row) => Boolean(row.parentKey));
      check("every row that hangs draws exactly ONE marker and no rail L", hanging.map((row) => `${row.ticks}/${row.rail === null ? "no-rail" : row.rail}/${row.ticks + (row.rail ? 1 : 0)}`), hanging.map(() => "1/no-rail/1"));
      check("no row draws two grouped-branch markers", (painted || []).filter((row) => row.ticks + (row.rail ? 1 : 0) > 1).map((row) => `${row.name} (${row.ticks} tick + rail ${row.rail})`), []);
      check("a tree no round cut hangs from nobody", plainDrawn.parentKey, null);
      check("a tree no round cut draws no marker", plainDrawn.ticks, 0);
      ok("every top-level row draws no grouped-branch marker", (painted || []).filter((row) => !row.parentKey).every((row) => row.ticks === 0), (painted || []).filter((row) => !row.parentKey && row.ticks > 0).map((r) => r.name).join(", "));

      // 6. The names #274 stamps are still on the rows the round cut, beside the shape.
      for (const [tail, want] of Object.entries(WANT_NAME)) {
        check(`the chart paints "${want}" on ${tail}`, rowFor(tail)?.name, want);
      }

      // ---- the captures ----------------------------------------------------------------------------------------
      const section = page.locator(`section.project[data-project="${PROJECT}"]`);
      await section.screenshot({ path: shotFile });
      const box = await section.boundingBox();
      if (box) {
        await page.screenshot({
          path: cropFile,
          clip: { x: box.x, y: box.y, width: Math.min(520, box.width), height: Math.min(box.height, 340) },
        });
      }
      note(`captures: ${shotFile} · ${cropFile}`);

      return {
        rows: painted.map((row) => ({ path: slash(row.path), name: row.name, depth: row.depth, parent: row.parentKey ? "hangs" : "top", ticks: row.ticks, rail: row.rail, tickX: row.tick?.x ?? null, nameLeft: row.nameLeft })),
        pageErrors,
        shot: shotFile,
        crop: cropFile,
      };
    },
    {
      viewport: { width: 1400, height: 950 },
      deviceScaleFactor: 2,
      // Harness setup, not what is asserted: a fresh browser opens every project collapsed, and a collapsed chart has
      // no rows to read.
      initScripts: [[(project) => localStorage.setItem("wm.expandedProjects", JSON.stringify([project])), PROJECT]],
    },
  );

  check("no page errors were raised", verdict.pageErrors, []);
  writeFileSync(
    ledgerFile,
    `${JSON.stringify({ at: new Date().toISOString(), panel: PANEL_ROOT, base, project: PROJECT, shots: { chart: shotFile, marks: cropFile }, rows: verdict.rows || [] }, null, 2)}\n`,
    "utf8",
  );
  note(`ledger: ${ledgerFile}`);
  note(`${(verdict.rows || []).length} row(s) measured: ${(verdict.rows || []).map((r) => `${r.name} [${r.depth ? `depth ${r.depth}` : "top"}, ${r.ticks} L]`).join(" · ")}`);
} catch (err) {
  failures += 1;
  console.log(`FAIL  the gate threw: ${String((err && err.message) || err)}`);
  note(panel.log().split(/\r?\n/).slice(-15).join("\n"));
} finally {
  await panel.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

console.log(`RESULT: ${failures === 0 ? "PASS" : "FAIL"} ${checks} checks`);
process.exit(failures === 0 ? 0 : 1);
