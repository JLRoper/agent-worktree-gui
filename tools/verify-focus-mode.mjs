#!/usr/bin/env node
// tools/verify-focus-mode.mjs - focus mode, driven in a real browser against a running panel.
//
//   node tools/verify-focus-mode.mjs <base-url> [--tree <path-fragment>] [--shots <dir>]
//
// WHAT IT PROVES. A double-click on the top header bar draws only the worktree rows whose tree has at least one live
// panel, each under its own project, hides every project with no such row, and folds every expanded row on entry. A
// second double-click brings the whole set back. The single-click project fold still folds while the mode is on.
//
// HOW THE ONE LIVE PANEL IS MADE. The panel's own job list is the evidence the page reads, so the harness adds one
// running job to every /api/state answer the page polls, and holds that one record in the job list the page applies
// from a stream snapshot. Nothing else is touched: no row flag, no page state of the harness's own, and the predicate
// under test is the page's.
//
// The target is a project with at least two worktree rows; `--tree` names the row the fixture job sits in (its path
// fragment), which is how a caller points the proof at a particular worktree. Exit 0 when every check passed.
import fs from "node:fs";
import path from "node:path";
import { withBrowser, openPage } from "./browser.mjs";

const BACKSLASH = String.fromCharCode(92);
const norm = (p) => String(p || "").split(BACKSLASH).join("/").replace(/\/+$/, "").toLowerCase();

const args = process.argv.slice(2);
const base = args.find((a) => /^https?:\/\//.test(a)) || "http://127.0.0.1:7331/";
const opt = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : null;
};
const wantTree = opt("--tree");
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
// The locator is re-resolved on every attempt because a repaint replaces the node under it.
async function sectionShot(page, selector, file) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.locator(selector).screenshot({ path: file });
      return;
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
if (wantTree) {
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
console.log(`panel: ${projects.length} projects; target ${target} has ${fullSet} rows; live tree ${tree}`);

const seeded = {
  id: "verify-focus-mode",
  thread: "verify-focus-mode",
  status: "running",
  model: "verify-focus-mode",
  startedAt: new Date().toISOString(),
  worktreePath: tree,
  title: "focus mode verifier",
  lines: [],
};

const result = await withBrowser(
  async ({ page }) => {
    // The one live panel, in the job list the page applies - from the poll and from a stream snapshot alike.
    await page.addInitScript((job) => {
      const wrap = () => {
        if (typeof applyJobSnapshot !== "function" || applyJobSnapshot.__fixture) return false;
        const original = applyJobSnapshot;
        const wrapped = function (jobs) {
          const list = (Array.isArray(jobs) ? jobs : []).filter((j) => j.id !== job.id);
          return original([...list, { ...job, startedAt: new Date().toISOString() }]);
        };
        wrapped.__fixture = true;
        window.applyJobSnapshot = wrapped;
        return true;
      };
      const tick = setInterval(() => {
        if (wrap()) clearInterval(tick);
      }, 30);
      window.addEventListener("load", wrap);
    }, seeded);
    await page.route("**/api/state*", async (route) => {
      const res = await route.fetch();
      const json = await res.json();
      const jobs = Array.isArray(json.jobs) ? json.jobs.filter((j) => j.id !== seeded.id) : [];
      json.jobs = [...jobs, { ...seeded, startedAt: new Date().toISOString() }];
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
    const beforeRows = await section.locator("tr.row").count();
    ok("the project's whole set is drawn before the gesture", beforeRows > 1, `rows=${beforeRows}`);
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
    ok("the project with the live panel is still drawn", !after.hidden);
    ok("exactly one worktree row is drawn", after.rows === 1, `rows=${after.rows}`);
    ok(
      "the row drawn is the tree the live panel is in",
      after.paths.some((p) => norm(p) === norm(tree) || norm(p).endsWith(`::${norm(tree)}`)),
      JSON.stringify(after.paths),
    );
    ok("no expanded row survived entry", after.open === 0, `open=${after.open}`);
    ok("every project with no surviving row is hidden", counts.hidden === counts.projects - 1, JSON.stringify(counts));
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

    await head.click();
    await page.waitForTimeout(250);
    const foldedRows = await section.locator("tr.row").count();
    const stillFocused = await page.evaluate(() => document.body.classList.contains("focus-mode"));
    await head.click();
    await page.waitForTimeout(250);
    ok("a single click on the project head still folds it", foldedRows === 0, `rows=${foldedRows}`);
    ok("the fold did not leave focus mode", stillFocused);
    ok("and the next single click unfolds it again", (await section.locator("tr.row").count()) === 1);

    await gesture();
    await page.waitForTimeout(400);
    const restored = await section.locator("tr.row").count();
    ok("a second double-click restores the whole set", restored === beforeRows, `rows=${restored}/${beforeRows}`);
    ok("focus mode is off again", await page.evaluate(() => !document.body.classList.contains("focus-mode")));

    return { url: page.url(), target, tree, beforeRows, afterRows: after.rows };
  },
  { viewport: { width: 1760, height: 1000 }, deviceScaleFactor: 2 },
);

const failures = checks.filter((c) => !c.pass);
console.log(JSON.stringify({ ...result, checks: checks.length, failures: failures.length, shots: shots || null }, null, 1));
if (shots) fs.writeFileSync(path.join(shots, "focus-verify.json"), JSON.stringify({ ...result, checks }, null, 1));
process.exit(failures.length ? 1 : 0);
