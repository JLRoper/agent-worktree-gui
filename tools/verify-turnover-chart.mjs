// tools/verify-turnover-chart.mjs - the chart's container row, proved on a rendered page.
//
//   node tools/verify-turnover-chart.mjs [--out docs/assets/turnover-container-rows]
//
// WHAT IT BUILDS. A real repository whose project NAMES one turnover branch, and NOTHING stands on that branch. Two
// trees were cut from it and recorded in the cut book (so the chart attaches them); a third was cut from it with no
// record at all (so its parent is only a reflog reconstruction, and the chart must attach it nowhere and say so); a
// fifth tree was cut from main, to compete for the chart's top N. The panel's own `chartTopCount` is 1, so a chart
// that still held the container back would show the defect this page repairs.
//
// WHAT IT ASSERTS, from the DOM the page painted:
//   - the turnover branch is a ROW of its own (a placeholder container), named for the branch, marked T, with the one
//     START press whose tooltip says what it starts and what it refuses;
//   - the two recorded children are one indent in, hung under that row (`data-parent-key`, `--child-depth`);
//   - the unrecorded child is at the top level with the ∅ mark, whose tooltip carries the reason;
//   - the container and its children are drawn although the top N is 1 and other rows are held back.
//
// It prints the rows in the order they are drawn (the quote the report uses) and, with Playwright present, writes a
// screenshot of the section.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright, attachPageCollectors, openPage } from "./browser.mjs";
import { createVerifier, git, slash, startPanel, waitFor, waitForState } from "./panel-testkit.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const OUT = path.resolve(opt("--out", "docs/assets/turnover-container-rows"));

const TURNOVER = "20261126_1800_TASK-406_the-complete-brief";
const PROJECT = "turnover-chart";
const CHILDREN = [
  { name: "the-first-child", tag: "aaaa11" },
  { name: "the-second-child", tag: "bbbb22" },
];
const ORPHAN = { name: "the-unrecorded-child", tag: "cccc33" };
const PLAIN = { name: "a-plain-research-tree", tag: "dddd44" };
// A tree whose commit is deliberately old: the chart ranks by last activity, so this is the one row the top N is
// meant to hold back while the container and its children stay drawn.
const QUIET = { name: "a-quiet-old-tree", tag: "eeee55" };

const verifier = createVerifier();
const { ok, check } = verifier;
let panel = null;
let browser = null;
let shots = 0;

function fixture() {
  const sandbox = mkdtempSync(path.join(tmpdir(), "wag-turnover-chart-"));
  const repo = path.join(sandbox, "repos", PROJECT);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "seed.txt"), "the container's base\n", "utf8");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "seed the repository");
  git(repo, "config", "user.email", "chart@example.invalid");
  git(repo, "config", "user.name", "Chart Fixture");
  git(repo, "config", "commit.gpgsign", "false");
  // THE CONTAINER IS A BRANCH AND NOTHING ELSE.
  git(repo, "branch", TURNOVER, "main");
  const trees = {};
  for (const spec of CHILDREN) {
    const branch = `wtgui/${spec.name}-${spec.tag}`;
    const tree = path.join(repo, ".worktrees", `${spec.name}-${spec.tag}`);
    git(repo, "worktree", "add", "-q", "-b", branch, tree, TURNOVER);
    trees[spec.name] = { branch, tree, tag: spec.tag, recorded: true };
  }
  for (const spec of [ORPHAN, PLAIN, QUIET]) {
    const branch = `wtgui/${spec.name}-${spec.tag}`;
    const tree = path.join(repo, ".worktrees", `${spec.name}-${spec.tag}`);
    git(repo, "worktree", "add", "-q", "-b", branch, tree, spec === ORPHAN ? TURNOVER : "main");
    trees[spec.name] = { branch, tree, tag: spec.tag, recorded: false };
  }
  // The quiet tree's only commit is dated 2020, and its one file carries that date too: nothing about it reads as
  // recent to the chart's ranking, which is what makes it the held row.
  writeFileSync(path.join(trees[QUIET.name].tree, "old.txt"), "work from a long time ago" + String.fromCharCode(10), "utf8");
  const oldEnv = { ...process.env, GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" };
  execFileSync(
    "git",
    ["-C", trees[QUIET.name].tree, "-c", "user.name=Chart Fixture", "-c", `user.email=${["chart", "example.invalid"].join(String.fromCharCode(64))}`, "-c", "commit.gpgsign=false", "add", "-A"],
    { env: oldEnv, stdio: "ignore" },
  );
  execFileSync(
    "git",
    ["-C", trees[QUIET.name].tree, "-c", "user.name=Chart Fixture", "-c", `user.email=${["chart", "example.invalid"].join(String.fromCharCode(64))}`, "-c", "commit.gpgsign=false", "commit", "-qm", "old work"],
    { env: oldEnv, stdio: "ignore" },
  );
  const bookFile = path.join(sandbox, "branch-parents.json");
  const stamp = new Date().toISOString();
  const book = {};
  for (const spec of CHILDREN) {
    const rec = trees[spec.name];
    book[`tag:${rec.tag}`] = { parent: TURNOVER, branch: rec.branch, tree: slash(rec.tree), kind: "implementation", at: stamp };
  }
  writeFileSync(bookFile, `${JSON.stringify(book, null, 2)}\n`, "utf8");
  return { sandbox, repo, bookFile, trees };
}

try {
  const fx = fixture();
  panel = await startPanel({
    config: {
      scanRoots: [path.dirname(fx.repo).replace(/\\/g, "/")],
      projects: [
        {
          name: PROJECT,
          path: slash(fx.repo),
          mainBranch: "main",
          turnoverBranches: [{ branch: TURNOVER, key: "task 406" }],
          turnoverPolicy: "free",
        },
      ],
      branchParentsFile: fx.bookFile,
      chartTopCount: 3,
      assistant: { enabled: false },
      worktreeSeconds: 60,
      midSeconds: 60,
      dormantSeconds: 60,
      slowSeconds: 60,
      fetchSeconds: 600,
    },
  });

  // A FAST-PASS ROW HAS NO BRANCH YET. The chart attaches on `branch`, so every tree is read at FULL depth first,
  // through the route the row's own ⟳ uses - the same read a reader's press makes.
  const boot = await waitForState(panel.base, (s) => (s.projects || []).some((p) => p.name === PROJECT && (p.worktrees || []).length >= 5), "the trees are scanned");
  const projectBoot = (boot.projects || []).find((p) => p.name === PROJECT);
  for (const w of projectBoot.worktrees || []) {
    await fetch(`${panel.base}/api/refresh/row`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project: PROJECT, path: w.path }),
    }).catch(() => null);
  }
  await waitForState(
    panel.base,
    (s) => {
      const p = (s.projects || []).find((x) => x.name === PROJECT);
      return p && (p.worktrees || []).length >= 5 && (p.worktrees || []).every((r) => r.branch);
    },
    "every row read at full depth",
    { timeout: 60_000 },
  );

  const playwright = loadPlaywright();
  if (!playwright) {
    console.log("BROWSER-NOT-RUN  the container row was not rendered.");
    console.log("  re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-turnover-chart.mjs");
    process.exitCode = 2;
  } else {
    const launch = await playwright.chromium.launch({ headless: true });
    browser = launch;
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const { pageErrors, consoleErrors } = attachPageCollectors(page);
      await openPage(page, panel.base, { selector: "section.project" });
      // The folder starts folded: open it the way the reader's own press does (the same `toggleProject` the head calls),
      // then wait for the rows to be built. A folded project keeps its rows in state and draws none of them.
      await page.evaluate((name) => {
        if (typeof state !== "undefined" && !state.expandedProjects.has(name)) toggleProject(name);
      }, PROJECT);
      await page.waitForFunction(
        (project) => document.querySelectorAll(`section.project[data-project="${project}"] tr.row[data-key]`).length > 0,
        PROJECT,
        { timeout: 30_000 },
      );
      // The container's key is the branch under a prefix no directory can carry; the children's keys are their paths.
      const CONTAINER = `section.project[data-project="${PROJECT}"] tr.row[data-key="${PROJECT}::turnover:${TURNOVER}"].is-turnover-container`;
      const containerDrawn = await waitFor(async () => (await page.locator(CONTAINER).count()) === 1, {
        timeoutMs: 30_000,
        what: "the container's own row",
      });
      ok("the turnover branch is drawn as its own row", containerDrawn);

      // ---- 1. what the container row says -------------------------------------------------------------------
      const container = await page.evaluate((sel) => {
        const tr = document.querySelector(sel);
        if (!tr) return null;
        const text = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
        const start = tr.querySelector("button.btn-start-turnover");
        return {
          key: tr.dataset.key,
          name: text(tr.querySelector("td.name .row-name")),
          nameTitle: tr.querySelector("td.name .row-name")?.getAttribute("title") || "",
          kind: text(tr.querySelector("td.kind .kind-mark")),
          kindAria: tr.querySelector("td.kind .kind-mark")?.getAttribute("aria-label") || "",
          verdict: text(tr.querySelector("td.verdict")),
          mark: text(tr.querySelector(".turnover-mark")),
          markAria: tr.querySelector(".turnover-mark")?.getAttribute("aria-label") || "",
          controls: [...tr.querySelectorAll("td.row-actions button")].map((b) => b.className),
          startTitle: start?.getAttribute("title") || "",
          startProject: start?.dataset.startProject || "",
          startBranch: start?.dataset.startTurnover || "",
          childDepth: tr.style.getPropertyValue("--child-depth"),
          parentKey: tr.dataset.parentKey || "",
          fold: tr.querySelector(".btn-row-fold")?.getAttribute("aria-label") || "",
          branchCell: text(tr.querySelector("td.branch")),
        };
      }, CONTAINER);
      ok("the row is the branch itself: named for it, and its name is the whole branch", container?.name === TURNOVER, container?.name);
      ok("the row is a statement of the container: T in the kind column", container?.kind === "T" && /turnover tree/.test(container?.kindAria || ""), `${container?.kind} / ${container?.kindAria}`);
      check("the verdict cell says what the row is, never a landing word", container?.verdict, "container");
      ok("the ⇄ mark says it is the project's turnover branch, and that no worktree stands on it yet", container?.mark === "\u21c4" && /no worktree stands on it yet/.test(container?.markAria || ""), container?.markAria);
      check("the only control on the row is the START press", container?.controls, ["btn-start-turnover"]);
      ok("the start press names the branch and the project it starts", container?.startProject === PROJECT && container?.startBranch === TURNOVER, `${container?.startProject} / ${container?.startBranch}`);
      ok("... and its tooltip states what it starts", /start this turnover container: put a worktree on /.test(container?.startTitle || ""), container?.startTitle);
      ok("... and what it refuses", /It refuses a branch this project does not name as a turnover branch/.test(container?.startTitle || ""), container?.startTitle);
      ok("... and that it pushes and lands nothing", /pushes nothing, opens no pull request and lands nothing/.test(container?.startTitle || ""), container?.startTitle);
      check("the container row hangs under nothing", [container?.childDepth, container?.parentKey], ["0", ""]);
      ok("its fold covers the two recorded children", /2 worktrees cut from/.test(container?.fold || ""), container?.fold);

      // ---- 2. what sits under it ----------------------------------------------------------------------------
      const drawn = await page.evaluate((project) => {
        return [...document.querySelectorAll(`section.project[data-project="${project}"] tr.row[data-key]`)].map((tr) => {
          const text = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
          const gap = tr.querySelector(".parent-gap");
          return {
            key: tr.dataset.key,
            name: text(tr.querySelector("td.name .row-name")),
            depth: tr.style.getPropertyValue("--child-depth"),
            parentKey: tr.dataset.parentKey || "",
            gapAria: gap?.getAttribute("aria-label") || "",
            gapTitle: gap?.getAttribute("title") || "",
            gapGlyph: gap ? gap.textContent.trim() : "",
            kind: text(tr.querySelector("td.kind .kind-mark")),
          };
        });
      }, PROJECT);
      const containerKey = container?.key || `turnover:${TURNOVER}`;
      for (const spec of CHILDREN) {
        const row = drawn.find((r) => String(r.key).endsWith(`/${spec.name}-${spec.tag}`));
        ok(`the recorded child ${spec.name} is drawn`, Boolean(row), row ? row.name : "missing");
        check(`... one indent in, under the container row`, [row?.depth, row?.parentKey], ["1", containerKey]);
        check(`... and it carries no ∅ (it is attached)`, row?.gapAria, "");
      }
      const orphan = drawn.find((r) => String(r.key).endsWith(`/${ORPHAN.name}-${ORPHAN.tag}`));
      ok("the unrecorded child is drawn", Boolean(orphan), orphan ? orphan.name : "missing");
      check("... at the top level, not borrowed under a guess", [orphan?.depth, orphan?.parentKey], ["0", ""]);
      ok("... with the ∅ mark that says it attaches nowhere", orphan?.gapGlyph === "\u2205" && /attaches nowhere/.test(orphan?.gapAria || ""), orphan?.gapAria);
      ok("... and the reason, in the mark's own tooltip", /a reconstruction is not a record|no cut record/.test(orphan?.gapTitle || ""), orphan?.gapTitle);

      // ---- 3. the chart's top N did not hold the container back ---------------------------------------------
      const topToggle = await page.evaluate((project) => {
        const btn = document.querySelector(`section.project[data-project="${project}"] [data-age-toggle]`);
        return btn ? btn.textContent.trim() : "";
      }, PROJECT);
      ok("the chart IS holding a row back, so the next check means something", /show \d+ more/.test(topToggle), topToggle);
      const onScreen = drawn.map((r) => r.name);
      ok("the container and both children are on the chart anyway", onScreen.includes(TURNOVER) && CHILDREN.every((s) => onScreen.some((n) => n.includes(s.name))), onScreen.join(" | "));

      // ---- 4. the quote, and the picture --------------------------------------------------------------------
      console.log("");
      console.log("THE CHART, in the order the page draws it (depth, key, name, kind, ∅):");
      for (const r of drawn) console.log(`  ${r.depth}  ${r.key}  ${r.name}  [${r.kind || "-"}]${r.gapAria ? `  ∅ ${r.gapAria}` : ""}`);
      console.log(`UNDER the container row (${containerKey}): ${drawn.filter((r) => r.parentKey === containerKey).map((r) => r.name).join(", ")}`);
      console.log("");

      mkdirSync(OUT, { recursive: true });
      const file = path.join(OUT, "chart.png");
      const section = await page.locator(`section.project[data-project="${PROJECT}"]`).first();
      await section.screenshot({ path: file });
      shots += 1;
      console.log(`SHOT ${file}`);
      ok("no page errors", pageErrors.length === 0 && consoleErrors.length === 0, [...pageErrors, ...consoleErrors].join(" | "));
    } finally {
      await browser.close().catch(() => {});
      browser = null;
    }
  }
} catch (err) {
  console.log(`FAIL  the harness itself: ${String((err && err.stack) || err)}`);
} finally {
  try {
    await panel?.stop();
  } catch {
    /* already gone */
  }
}

console.log("");
console.log(`${verifier.checks} checks, ${verifier.failures} failed${shots ? `, ${shots} screenshot` : ""}`);
process.exitCode = verifier.failures ? 1 : process.exitCode || 0;
