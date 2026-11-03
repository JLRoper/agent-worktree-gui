// Ctrl+[ folds ONE tier per press, proved by five real keydowns against a real page.
//
//   node tools/verify-tiered-collapse.mjs [--shots <dir>]
//
// The bracket on the left used to call setEverythingOpen(false): one press closed the folder roots, the projects,
// the worktree rows, every card and every turn. Now it peels one layer at a time, from the lowest tier with anything
// open upward — turns, cards, rows, projects, folders (plus the two fixed cards) — and a board with nothing open
// makes it a no-op rather than a fall-through into expanding. The header's "Collapse all" button keeps closing the
// whole tree in one press, because that is what its label promises, and Ctrl+] keeps opening everything.
//
// WHAT IS DRIVEN (Playwright, headless Chromium, a sandbox of its own — throwaway repo, worktree, HERMES_HOME, port
// and logs, apiServer pointed at a dead port; the live panel and gateway are never touched and the temp root is
// deleted at the end):
//
//   1. Ctrl+] opens the board (every turn, card, project, folder, fixed card), then FIVE real Ctrl+[ keydowns:
//        press 1 folds the TURNS only      press 2 folds the CARDS only
//        press 3 folds the ROWS only       press 4 folds the PROJECTS only, and arms each project's clock
//        press 5 folds the FOLDERS and the two fixed cards, and arms theirs
//      …each press asserting the four other tiers did not move, in the state AND in the page;
//   2. a sixth press changes nothing and expands nothing — the no-op, not a toggle;
//   3. the header button still collapses/expands the whole tree in one press, and its title no longer claims
//      Ctrl+[ does that;
//   4. the focus guard: Ctrl+[ with a field focused leaves the board alone, and the same key without focus folds.
//
// THE RED PROOF. Against the tree this branch was cut from, press 1 closes every tier at once and the run stops at
// "press 1 leaves the cards open" (the cards are already minimized). That is the before number quoted in the commit.
//
// The browser half needs a Playwright install. Point the script at one with PANEL_PLAYWRIGHT_ROOT (a directory
// holding node_modules/playwright, or the package itself); without one the script says BROWSER-HALF-NOT-RUN and
// exits 2 rather than passing on a half that never ran.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { ROOT, configureRepo, freePort, git, startPanel } from "./panel-testkit.mjs";

let failures = 0;
let checks = 0;
function check(name, cond, extra = "") {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
}
const args = process.argv.slice(2);
const shotDirArg = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : null;

// ---- the sandbox -------------------------------------------------------------------------------------------------
const dir = path.join(ROOT, ".worktrees", ".tiered-collapse-sandbox");
rmSync(dir, { recursive: true, force: true });
mkdirSync(path.join(dir, "logs"), { recursive: true });
const shotsDir = shotDirArg ? path.resolve(shotDirArg) : path.join(ROOT, ".worktrees", ".tiered-collapse-shots");
mkdirSync(shotsDir, { recursive: true });
const repos = path.join(dir, "repos");
const repo = path.join(repos, "sandbox-repo");
const tree = path.join(repo, ".worktrees", "tree-one");
const PROJECT = "sandbox-repo";
mkdirSync(tree, { recursive: true });

git(repo, ["init", "-q", "-b", "main"]);
configureRepo(repo);
writeFileSync(path.join(repo, "README.md"), "# sandbox repo\n", "utf8");
git(repo, ["add", "-A"]);
git(repo, ["commit", "-q", "-m", "seed the sandbox repo"]);
git(repo, ["worktree", "add", "-q", "-b", "work/tree-one", tree]);
writeFileSync(path.join(tree, "work.txt"), "the worktree the cards run in\n", "utf8");
git(tree, ["add", "-A"]);
git(tree, ["commit", "-q", "-m", "do the work"]);

// Two settled cards in that worktree, each with one turn — the turn body is the deepest tier, so it has to be drawn.
const now = Date.now();
const settled = (id) => ({
  id,
  thread: id,
  turn: 1,
  prompt: `fixture: ${id}`,
  status: "done",
  exitCode: 0,
  startedAt: new Date(now - 900_000).toISOString(),
  endedAt: new Date(now - 840_000).toISOString(),
  durationMs: 60_000,
  finalMessage: "done",
  cwd: tree,
  ownerPath: tree,
  worktreePath: tree,
  lines: [{ kind: "out", text: `the card ${id} is here so a tier has something to fold`, lid: 1, at: now - 840_000 }],
});
const THREADS = ["tk-tier-a", "tk-tier-b"];
writeFileSync(
  path.join(dir, "logs", "jobs.json"),
  JSON.stringify({ savedAt: new Date(now).toISOString(), jobs: THREADS.map((id) => settled(id)) }, null, 1),
  "utf8",
);

const port = await freePort();
const panel = await startPanel({
  dir,
  port,
  keep: true,
  config: {
    scanRoots: [repos],
    refreshSeconds: 4,
    worktreeSeconds: 2,
    midSeconds: 8,
    dormantSeconds: 15,
    slowSeconds: 20,
    fetchSeconds: 3600,
    liveMinutes: 5,
    // Long enough that a clock armed by press 4 or 5 outlives the whole run: the gate proves the clock is ARMED
    // (the cascade itself is proved on fake timers by test/collapse-cascade.test.js).
    collapseAfterSeconds: 600,
    defaultCwd: repo,
    apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
    assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
  },
});
const base = panel.base;
// The row key is the panel's own: project name, `::`, and the path with forward slashes and the case it has on
// disk. It is NOT lowercased — a selector matching the folded form finds nothing.
const rowKey = `${PROJECT}::${tree.replace(/\\/g, "/")}`;
const rowSel = `tr.row[data-key="${rowKey}"]`;
const projectHead = `[data-toggle-project="${PROJECT}"]`;

try {
  const engine = loadPlaywright();
  if (!engine) {
    console.log(notRun("the tiered collapse", "no Playwright on this machine — set PANEL_PLAYWRIGHT_ROOT"));
    failures += 1;
  } else {
    // One read of everything a press may move: the fold books, the clocks they armed, and the painted page.
    const snapshot = (page) =>
      page.evaluate(() => {
        const q = (sel) => [...document.querySelectorAll(sel)];
        return {
          turnsOpen: [...state.turnOpen.values()].filter(Boolean).length,
          turnsClosed: [...state.turnOpen.values()].filter((open) => open === false).length,
          cards: [...state.collapsedJobs].sort(),
          rows: [...state.expanded].sort(),
          projects: [...state.expandedProjects].sort(),
          roots: [...state.collapsedRoots].sort(),
          fixed: [...state.collapsedFixed].sort(),
          timers: [...state.collapseTimers.keys()].sort(),
          drawn: {
            cards: q(".agents-block .job[data-thread]").length,
            cardsCollapsed: q(".agents-block .job[data-thread].collapsed").length,
            rowsExpanded: q("tr.row.expanded").length,
            projectsCollapsed: q("section.project.collapsed").length,
            rootsCollapsed: q("section.root-group.collapsed").length,
            fixedCollapsed: q(".fixed-collapsed").length,
            turnChevrons: q("[data-toggle-turn] .chev").map((el) => el.textContent.trim()),
          },
          label: document.getElementById("btn-collapse-all").textContent,
          title: document.getElementById("btn-collapse-all").title,
        };
      });
    const press = async (page, key) => {
      await page.evaluate(() => document.activeElement?.blur?.());
      await page.keyboard.down("Control");
      await page.keyboard.press(key);
      await page.keyboard.up("Control");
      await page.waitForTimeout(120);
    };

    const verdict = await withBrowser(
      async ({ page }) => {
        await openPage(page, base, { selector: "section.project" });
        // The project starts collapsed; open it, then the row, and wait for both cards to be drawn.
        if (await page.evaluate((s) => document.querySelector(s).closest("section.project").classList.contains("collapsed"), projectHead)) {
          await page.click(projectHead);
        }
        await page.waitForSelector(rowSel, { timeout: 20_000 });
        if (!(await page.evaluate((s) => document.querySelector(s).classList.contains("expanded"), rowSel))) {
          await page.click(rowSel);
        }
        await page.waitForFunction((sel) => document.querySelectorAll(sel).length === 2, ".agents-block .job[data-thread]");
        // Every tier open: the lowest one included, so the five presses have five tiers to take.
        await press(page, "]");
        const open = await snapshot(page);
        check("Ctrl+] opens the whole board", open.turnsOpen === 2 && open.cards.length === 0 && open.projects.length === 1, JSON.stringify({ turns: open.turnsOpen, cards: open.cards.length, projects: open.projects }));
        check("…and the page shows it: two open turns, two open cards, an expanded row", open.drawn.turnChevrons.every((c) => c === "▾") && open.drawn.cardsCollapsed === 0 && open.drawn.rowsExpanded === 1, JSON.stringify(open.drawn));
        check(
          "the button's title no longer advertises Ctrl+[ as collapsing everything",
          /Ctrl\+\[ folds one tier per press/.test(open.title) && !/— Ctrl\+\[/.test(open.title),
          open.title,
        );
        await page.screenshot({ path: path.join(shotsDir, "1-open.png") });

        // ---- press 1: the turns ---------------------------------------------------------------------------------
        let before = open;
        await press(page, "[");
        let now = await snapshot(page);
        check("press 1 folds the turns", now.turnsOpen === 0 && now.turnsClosed === 2, JSON.stringify({ open: now.turnsOpen, closed: now.turnsClosed }));
        check("…and the page draws them folded", now.drawn.turnChevrons.length === 2 && now.drawn.turnChevrons.every((c) => c === "▸"), JSON.stringify(now.drawn.turnChevrons));
        check("press 1 leaves the cards open", now.cards.length === 0 && now.drawn.cardsCollapsed === 0, JSON.stringify(now.cards));
        check("press 1 leaves the rows open", now.drawn.rowsExpanded === 1, String(now.drawn.rowsExpanded));
        check("press 1 leaves the projects open", JSON.stringify(now.projects) === JSON.stringify(before.projects), JSON.stringify(now.projects));
        check("press 1 leaves the folders open", now.roots.length === 0 && now.drawn.rootsCollapsed === 0, JSON.stringify(now.roots));
        await page.screenshot({ path: path.join(shotsDir, "2-turns.png") });

        // ---- press 2: the cards ---------------------------------------------------------------------------------
        before = now;
        await press(page, "[");
        now = await snapshot(page);
        check("press 2 folds the cards", now.cards.length === 2, JSON.stringify(now.cards));
        check("…and the page draws them minimized", now.drawn.cardsCollapsed === 2, `${now.drawn.cardsCollapsed} of ${now.drawn.cards}`);
        check("press 2 leaves the rows open", now.drawn.rowsExpanded === 1, String(now.drawn.rowsExpanded));
        check("press 2 leaves the projects open", JSON.stringify(now.projects) === JSON.stringify(before.projects), JSON.stringify(now.projects));
        check("press 2 leaves the folders open", now.roots.length === 0, JSON.stringify(now.roots));
        await page.screenshot({ path: path.join(shotsDir, "3-cards.png") });

        // ---- press 3: the rows ----------------------------------------------------------------------------------
        before = now;
        await press(page, "[");
        now = await snapshot(page);
        check("press 3 folds the rows", now.rows.length === 0 && now.drawn.rowsExpanded === 0, JSON.stringify(now.rows));
        check("press 3 leaves the projects open", JSON.stringify(now.projects) === JSON.stringify(before.projects), JSON.stringify(now.projects));
        check("press 3 leaves the folders open", now.roots.length === 0 && now.drawn.rootsCollapsed === 0, JSON.stringify(now.roots));
        check("press 3 leaves every card folded", JSON.stringify(now.cards) === JSON.stringify(before.cards), JSON.stringify(now.cards));
        await page.screenshot({ path: path.join(shotsDir, "4-rows.png") });

        // ---- press 4: the projects ------------------------------------------------------------------------------
        before = now;
        await press(page, "[");
        now = await snapshot(page);
        check("press 4 folds the projects", now.projects.length === 0 && now.drawn.projectsCollapsed === 1, JSON.stringify(now.projects));
        check("press 4 starts that parent's cascade clock", now.timers.includes(`project:${PROJECT}`), JSON.stringify(now.timers));
        check("press 4 leaves the folders open", now.roots.length === 0 && now.drawn.rootsCollapsed === 0, JSON.stringify(now.roots));
        check("press 4 leaves the fixed cards open", now.fixed.length === 0, JSON.stringify(now.fixed));
        check("press 4 closes no card", JSON.stringify(now.cards) === JSON.stringify(before.cards), JSON.stringify(now.cards));
        await page.screenshot({ path: path.join(shotsDir, "5-projects.png") });

        // ---- press 5: the folders and the two fixed cards -------------------------------------------------------
        before = now;
        await press(page, "[");
        now = await snapshot(page);
        check("press 5 folds the folder", now.roots.length === 1 && now.drawn.rootsCollapsed === 1, JSON.stringify(now.roots));
        check("press 5 folds both fixed cards", now.fixed.length === 2 && now.drawn.fixedCollapsed === 2, JSON.stringify(now.fixed));
        check(
          "press 5 starts the folder's and the fixed cards' clocks",
          now.timers.some((key) => key.startsWith("root:")) &&
            now.timers.includes("fixed:newagent") &&
            now.timers.includes("fixed:agents"),
          JSON.stringify(now.timers),
        );
        check("press 5 changes no card", JSON.stringify(now.cards) === JSON.stringify(before.cards), JSON.stringify(now.cards));
        check("the button now reads Expand all", now.label === "Expand all", now.label);
        await page.screenshot({ path: path.join(shotsDir, "6-folders.png") });

        // ---- press 6: the no-op ---------------------------------------------------------------------------------
        const closed = now;
        await press(page, "[");
        now = await snapshot(page);
        check("a sixth press changes nothing", JSON.stringify(now) === JSON.stringify(closed), "the fold books, the clocks and the page are identical");
        check("…and expands nothing: the board is still closed", now.turnsOpen === 0 && now.cards.length === 2 && now.projects.length === 0 && now.roots.length === 1, JSON.stringify({ turns: now.turnsOpen, cards: now.cards.length, projects: now.projects, roots: now.roots }));

        // ---- the header button still does the whole tree in one press ------------------------------------------
        await page.click("#btn-collapse-all"); // Expand all
        now = await snapshot(page);
        check(
          "the header button expands the whole tree in one press",
          now.turnsOpen === 2 && now.cards.length === 0 && now.projects.length === 1 && now.roots.length === 0 && now.fixed.length === 0,
          JSON.stringify({ turns: now.turnsOpen, cards: now.cards.length, projects: now.projects, roots: now.roots, fixed: now.fixed }),
        );
        await page.click("#btn-collapse-all"); // Collapse all
        now = await snapshot(page);
        check(
          "…and collapses all five tiers in one press, as its label promises",
          now.turnsOpen === 0 && now.cards.length === 2 && now.projects.length === 0 && now.roots.length === 1 && now.fixed.length === 2,
          JSON.stringify({ turns: now.turnsOpen, cards: now.cards.length, projects: now.projects, roots: now.roots, fixed: now.fixed }),
        );

        // ---- the focus guard ------------------------------------------------------------------------------------
        await press(page, "]");
        const beforeGuard = await snapshot(page);
        await page.click("#job-cwd"); // an INPUT inside the New agent card
        await page.keyboard.down("Control");
        await page.keyboard.press("[");
        await page.keyboard.up("Control");
        await page.waitForTimeout(120);
        const guarded = await snapshot(page);
        check("Ctrl+[ typed into a field leaves the board alone", guarded.turnsOpen === beforeGuard.turnsOpen && JSON.stringify(guarded.cards) === JSON.stringify(beforeGuard.cards), JSON.stringify({ turns: guarded.turnsOpen }));
        await page.evaluate(() => document.activeElement?.blur?.());
        await press(page, "[");
        now = await snapshot(page);
        check("…and the same key with the board focused folds the turns", now.turnsOpen === 0 && now.turnsClosed === 2, JSON.stringify({ open: now.turnsOpen, closed: now.turnsClosed }));
        await page.screenshot({ path: path.join(shotsDir, "7-focus-guard.png") });

        return 0;
      },
      { viewport: { width: 1760, height: 1000 } },
    ).catch((e) => {
      failures += 1;
      console.log(`FAIL  the browser half threw — ${String((e && e.message) || e)}`);
      return 1;
    });
    void verdict;
  }
} catch (e) {
  failures += 1;
  console.log(`FAIL  the harness threw — ${String((e && e.message) || e)}`);
} finally {
  await panel.stop();
  if (!process.env.KEEP_SANDBOX) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

console.log(`\n${failures ? "FAIL" : "PASS"}  ${checks - failures}/${checks} checks`);
if (!checks) {
  console.log("nothing ran");
  process.exit(2);
}
process.exit(failures ? 1 : 0);
