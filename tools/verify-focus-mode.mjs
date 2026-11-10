#!/usr/bin/env node
// tools/verify-focus-mode.mjs - focus mode, driven in a real browser against a running panel.
//
//   node tools/verify-focus-mode.mjs <base-url> [--tree <path-fragment>] [--shots <dir>]
//   node tools/verify-focus-mode.mjs <base-url> --pathless <project> [--panel <project>] [--shots <dir>]
//
// WHAT IT PROVES. A double-click on the top header bar draws only the worktree rows whose tree has at least one live
// panel, each under its own project, hides every project with no such row, and folds every expanded row on entry. A
// second double-click brings the whole set back. The single-click project fold still folds while the mode is on.
//
// THE SECOND FORM is the pathless run: `--pathless <project>` seeds one live job with NO `worktreePath` whose
// `worktree` is that project's checkout folder name - a turn running in the project's own checkout, nothing cut for it
// - and `--panel <project>` seeds a second live job inside one of that project's worktree rows. The proof is that the
// checkout's project is DRAWN (its own row, never a tree cut from it) beside the panel's project, and that every other
// project is hidden. Without this the checkout run's project was the one the mode hid.
//
// HOW THE LIVE PANELS ARE MADE. The panel's own job list is the evidence the page reads, so the harness REPLACES the
// job list every /api/state answer and stream snapshot carries with the seeded records. Replacing rather than adding
// is what makes the counts exact: the live board carries runs of its own, and a check that says "exactly one row" has
// to be about the fixture and nothing else. Nothing else is touched: no row flag, no page state of the harness's own,
// and the predicate under test is the page's.
//
// The first form's target is a project with at least two worktree rows; `--tree` names the row the fixture job sits in
// (its path fragment), which is how a caller points the proof at a particular worktree. Exit 0 when every check passed.
import fs from "node:fs";
import path from "node:path";
import { withBrowser, openPage } from "./browser.mjs";

const BACKSLASH = String.fromCharCode(92);
const norm = (p) => String(p || "").split(BACKSLASH).join("/").replace(/\/+$/, "").toLowerCase();
const lastSegment = (p) => String(p || "").split(BACKSLASH).join("/").replace(/\/+$/, "").split("/").filter(Boolean).pop() || "";

const args = process.argv.slice(2);
const base = args.find((a) => /^https?:\/\//.test(a)) || "http://127.0.0.1:7331/";
const opt = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : null;
};
const wantTree = opt("--tree");
const wantCheckout = opt("--pathless");
const wantPanel = opt("--panel");
// Drive the page with a local public/app.js instead of the copy the running panel serves. The panel is the reader's,
// so this is how a fix in a worktree is proven against the real board without restarting it: same shell, same state,
// same API, one file swapped for the one under test.
const wantApp = opt("--app");
const shots = opt("--shots");

const checks = [];
const ok = (name, cond, extra = "") => {
  checks.push({ name, pass: Boolean(cond), extra });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  return Boolean(cond);
};

// A screenshot the board's own repaints cannot lose: sections are replaced while an element is captured.
async function shot(page, file, fullPage = false) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.screenshot({ path: file, fullPage });
      return;
    } catch (e) {
      if (attempt >= 4) throw e;
      await page.waitForTimeout(500);
    }
  }
}

// The project's own section, whole: the row count is what the proof is about, and a viewport cannot hold 100 rows.
// The locator is re-resolved on every attempt because a repaint replaces the node under it. A section the mode has
// hidden has no box to photograph: that is the defect this harness reports, so it is skipped here and left to the
// checks - a harness that throws on the state it exists to name prints no verdict at all.
async function sectionShot(page, selector, file) {
  const visible = await page
    .locator(selector)
    .isVisible()
    .catch(() => false);
  if (!visible) {
    console.log(`SKIP  ${file}: the section is not drawn`);
    return false;
  }
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.locator(selector).screenshot({ path: file });
      return true;
    } catch (e) {
      if (attempt >= 4) throw e;
      await page.waitForTimeout(600);
    }
  }
}

const state = await (await fetch(new URL("api/state", base))).json();
const projects = state.projects || [];
let target = null;
let tree = null;
let panelName = null;
let panelTree = null;
if (wantCheckout) {
  const p = projects.find((x) => x.name === wantCheckout);
  if (!p) throw new Error(`no project on ${base} is called ${wantCheckout}`);
  target = p.name;
  tree = p.path;
  if (!tree) throw new Error(`${wantCheckout} carries no checkout path`);
  if (wantPanel) {
    const q = projects.find((x) => x.name === wantPanel);
    if (!q) throw new Error(`no project on ${base} is called ${wantPanel}`);
    const row = (q.worktrees || []).find((t) => norm(t.path) !== norm(q.path));
    if (!row) throw new Error(`${wantPanel} has no worktree row to hold the live panel`);
    panelName = q.name;
    panelTree = row.path;
  }
} else if (wantTree) {
  for (const p of projects) {
    const w = (p.worktrees || []).find((t) => norm(t.path).includes(norm(wantTree)));
    if (w) {
      target = p.name;
      tree = w.path;
      break;
    }
  }
  if (!target) throw new Error(`no project on ${base} carries a row matching ${wantTree}`);
} else {
  const best = projects
    .filter((p) => (p.worktrees || []).length >= 2)
    .sort((a, b) => (b.worktrees || []).length - (a.worktrees || []).length)[0];
  if (!best) throw new Error(`no project on ${base} has two worktree rows to narrow`);
  target = best.name;
  tree = best.worktrees[0].path;
}
const fullSet = (projects.find((p) => p.name === target)?.worktrees || []).length;
console.log(
  `panel: ${projects.length} projects; target ${target} has ${fullSet} rows; live tree ${tree}` +
    (panelTree ? `; panel ${panelName} in ${panelTree}` : ""),
);

// The fixture job list. `--pathless` seeds a run in the CHECKOUT in the shape the store actually writes: no
// `worktreePath` and no `worktree` name, with `ownerPath` and `cwd` sitting on the checkout itself (measured on the
// live board: 301 pathless jobs, not one carrying a `worktree` name). `--panel` adds a run that does carry a path, so
// one proof covers both shapes of record.
const baseSeed = {
  model: "verify-focus-mode",
  startedAt: new Date().toISOString(),
  title: "focus mode verifier",
  lines: [],
};
const seeds = wantCheckout
  ? [
      {
        ...baseSeed,
        id: "verify-focus-mode-checkout",
        thread: "verify-focus-mode-checkout",
        status: "running",
        worktreePath: null,
        worktree: null,
        ownerPath: tree,
        cwd: tree,
        baseCheckout: true,
        title: "live run in the project checkout",
      },
    ]
  : [{ ...baseSeed, id: "verify-focus-mode", thread: "verify-focus-mode", status: "running", worktreePath: tree }];
if (panelTree) {
  seeds.push({
    ...baseSeed,
    id: "verify-focus-mode-panel",
    thread: "verify-focus-mode-panel",
    status: "running",
    worktreePath: panelTree,
    worktree: lastSegment(panelTree),
    cwd: panelTree,
    title: "live panel in a worktree",
  });
}
const seedList = () => seeds.map((s) => ({ ...s, startedAt: new Date().toISOString() }));

const result = await withBrowser(
  async ({ page }) => {
    if (wantApp) {
      const body = fs.readFileSync(wantApp, "utf8");
      await page.route("**/app.js*", (route) =>
        route.fulfill({ status: 200, contentType: "application/javascript; charset=utf-8", body }),
      );
      console.log(`app.js under test: ${wantApp}`);
    }
    // The fixture job list, in the job list the page applies - from the poll and from a stream snapshot alike.
    await page.addInitScript((fixture) => {
      const wrap = () => {
        if (typeof applyJobSnapshot !== "function" || applyJobSnapshot.__fixture) return false;
        const original = applyJobSnapshot;
        const wrapped = function () {
          const list = fixture.map((j) => ({ ...j, startedAt: new Date().toISOString() }));
          return original(list);
        };
        wrapped.__fixture = true;
        window.applyJobSnapshot = wrapped;
        return true;
      };
      const tick = setInterval(() => {
        if (wrap()) clearInterval(tick);
      }, 30);
      window.addEventListener("load", wrap);
    }, seeds);
    await page.route("**/api/state*", async (route) => {
      const res = await route.fetch();
      const json = await res.json();
      json.jobs = seedList();
      await route.fulfill({ response: res, json });
    });

    await openPage(page, base, { selector: "section.project[data-project]" });
    await page.waitForFunction((name) => Boolean(document.querySelector(`section.project[data-project="${name}"]`)), target, {
      timeout: 30000,
    });

    const section = page.locator(`section.project[data-project="${target}"]`);
    const head = page.locator(`section.project[data-project="${target}"] .project-head[data-toggle-project]`);
    if (await section.evaluate((el) => el.classList.contains("collapsed") || el.classList.contains("is-collapsed"))) {
      await head.click();
      await page.waitForTimeout(250);
    }
    // The panel's project is a second section, and it is unfolded the same way: a row count taken on a folded project
    // is zero for a reason that has nothing to do with focus mode.
    const panelSection = panelName ? page.locator(`section.project[data-project="${panelName}"]`) : null;
    const panelHead = panelName ? page.locator(`section.project[data-project="${panelName}"] .project-head[data-toggle-project]`) : null;
    if (
      panelSection &&
      (await panelSection.evaluate((el) => el.classList.contains("collapsed") || el.classList.contains("is-collapsed")))
    ) {
      await panelHead.click();
      await page.waitForTimeout(250);
    }
    const beforeRows = await section.locator("tr.row").count();
    ok("the project's whole set is drawn before the gesture", beforeRows > 1, `rows=${beforeRows}`);
    let panelRowsBefore = 0;
    if (panelTree) {
      panelRowsBefore = await page.locator(`section.project[data-project="${panelName}"]`).locator("tr.row").count();
      ok("the panel's project draws its whole set too", panelRowsBefore > 1, `rows=${panelRowsBefore}`);
    }
    ok("focus mode is off going in", await page.evaluate(() => !document.body.classList.contains("focus-mode")));
    if (shots) {
      await section.evaluate((el) => el.scrollIntoView({ block: "start" }));
      await page.waitForTimeout(300);
      await shot(page, path.join(shots, "focus-before.png"));
      await sectionShot(page, `section.project[data-project="${target}"]`, path.join(shots, "focus-before-rows.png"));
    }

    const bar = await page.locator("header.topbar").boundingBox();
    if (!bar) throw new Error("no header bar on the page");
    const gesture = () => page.mouse.dblclick(bar.x + 8, bar.y + bar.height / 2);
    await gesture();
    await page.waitForTimeout(400);

    const after = await section.evaluate((el) => ({
      hidden: el.classList.contains("is-focus-out"),
      rows: el.querySelectorAll("tr.row").length,
      paths: [...el.querySelectorAll("tr.row")].map((r) => r.dataset.path || r.dataset.key || ""),
      open: el.querySelectorAll("tr.row.expanded, tr.detail").length,
    }));
    const counts = await page.evaluate(() => {
      const all = [...document.querySelectorAll("section.project[data-project]")];
      return { projects: all.length, hidden: all.filter((s) => s.classList.contains("is-focus-out")).length };
    });
    ok("the double-click turned focus mode on", await page.evaluate(() => document.body.classList.contains("focus-mode")));
    ok("the project with the live run is still drawn", !after.hidden);
    ok("exactly one worktree row is drawn", after.rows === 1, `rows=${after.rows}`);
    ok(
      wantCheckout
        ? "the row drawn is the project's own checkout, not a tree cut from it"
        : "the row drawn is the tree the live panel is in",
      after.paths.some((p) => norm(p) === norm(tree) || norm(p).endsWith(`::${norm(tree)}`)) &&
        (!wantCheckout || !after.paths.some((p) => norm(p).includes("/.worktrees/"))),
      JSON.stringify(after.paths),
    );
    ok("no expanded row survived entry", after.open === 0, `open=${after.open}`);

    // The second live run: a panel with a worktree path, in another project. A pathless run must not have taken its
    // row and a path-carrying one must still keep it, so both are counted in the same narrowed board.
    let panelAfter = null;
    if (panelTree) {
      const psec = page.locator(`section.project[data-project="${panelName}"]`);
      panelAfter = await psec.evaluate((el) => ({
        hidden: el.classList.contains("is-focus-out"),
        rows: el.querySelectorAll("tr.row").length,
        paths: [...el.querySelectorAll("tr.row")].map((r) => r.dataset.path || r.dataset.key || ""),
      }));
      ok("the project with the live worktree panel is still drawn", !panelAfter.hidden);
      ok("its one live worktree row is drawn", panelAfter.rows === 1, `rows=${panelAfter.rows}`);
      ok(
        "the row drawn there is the tree the live panel is in",
        panelAfter.paths.some((p) => norm(p) === norm(panelTree) || norm(p).endsWith(`::${norm(panelTree)}`)),
        JSON.stringify(panelAfter.paths),
      );
    }

    const keptSections = 1 + (panelTree ? (panelName === target ? 0 : 1) : 0);
    ok(
      "every project with no surviving row is hidden",
      counts.hidden === counts.projects - keptSections,
      JSON.stringify({ ...counts, keptSections }),
    );
    ok(
      "the bar says the mode is on",
      await page.evaluate(
        () =>
          document.body.classList.contains("focus-mode") &&
          getComputedStyle(document.querySelector("header.topbar")).borderBottomColor === "rgb(163, 113, 247)",
      ),
    );

    if (shots) {
      await section.evaluate((el) => el.scrollIntoView({ block: "start" }));
      await page.waitForTimeout(300);
      await shot(page, path.join(shots, "focus-after.png"));
      await sectionShot(page, `section.project[data-project="${target}"]`, path.join(shots, "focus-after-rows.png"));
      await shot(page, path.join(shots, "focus-after-full.png"), true);
    }

    // The fold gesture, on a project the mode may have hidden: there is no head to click on one that is not drawn, and
    // "the project is not drawn" is the verdict those three checks report rather than a crash.
    if (!(await head.isVisible().catch(() => false))) {
      ok("a single click on the project head still folds it", false, "the section is not drawn");
      ok("the fold did not leave focus mode", false, "the section is not drawn");
      ok("and the next single click unfolds it again", false, "the section is not drawn");
    } else {
      await head.click();
      await page.waitForTimeout(250);
      const foldedRows = await section.locator("tr.row").count();
      const stillFocused = await page.evaluate(() => document.body.classList.contains("focus-mode"));
      await head.click();
      await page.waitForTimeout(250);
      ok("a single click on the project head still folds it", foldedRows === 0, `rows=${foldedRows}`);
      ok("the fold did not leave focus mode", stillFocused);
      ok("and the next single click unfolds it again", (await section.locator("tr.row").count()) === 1);
    }

    await gesture();
    await page.waitForTimeout(400);
    const restored = await section.locator("tr.row").count();
    ok("a second double-click restores the whole set", restored === beforeRows, `rows=${restored}/${beforeRows}`);
    ok("focus mode is off again", await page.evaluate(() => !document.body.classList.contains("focus-mode")));

    return {
      url: page.url(),
      target,
      tree,
      mode: wantCheckout ? "pathless-checkout" : "worktree",
      panelName,
      panelTree,
      beforeRows,
      afterRows: after.rows,
      panelRowsBefore,
      panelRowsAfter: panelAfter ? panelAfter.rows : null,
      projects: counts.projects,
      projectsHidden: counts.hidden,
    };
  },
  { viewport: { width: 1760, height: 1000 }, deviceScaleFactor: 2 },
);

const failures = checks.filter((c) => !c.pass);
console.log(JSON.stringify({ ...result, checks: checks.length, failures: failures.length, shots: shots || null }, null, 1));
if (shots) fs.writeFileSync(path.join(shots, "focus-verify.json"), JSON.stringify({ ...result, checks }, null, 1));
process.exit(failures.length ? 1 : 0);
