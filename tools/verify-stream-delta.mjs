#!/usr/bin/env node
// A real page applying a real delta: the stream's push after a first load is a delta (lib/snapshot-delta.js,
// public/settings.js applySnapshotDelta), and the page must patch what it names instead of rebuilding the board.
//
//   node tools/verify-stream-delta.mjs [--root <checkout>] [--seconds 20] [--report <dir>]
//
// A sandbox panel of its own (own config, own state dir, assistant off, gateway pointed at a closed port so nothing
// can start) serves this checkout's page; the harness then:
//
//   1. opens the page and waits for the board it drew;
//   2. proves the page asked for the lean shape (state.es.url carries ?shape=delta);
//   3. counts the board's own full re-renders (renderAll), counts delta applications, and remembers the section node;
//   4. makes ONE real write through the panel's own route (a todo ADD on a row the board draws) and waits;
//   5. asserts the row's todo arrived, the delta path applied it, no re-render happened, the section on screen is the
//      same node, and every project and row the board held is still there - a delta must never be read as
//      authoritative about what exists.
//
// Exit 0 when every check passes, 1 when one fails, 2 when Playwright is not installed on this machine.
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright, withBrowser } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const ROOT = path.resolve(opt("--root", path.join(HERE, "..")));
const WAIT = Number(opt("--seconds", "20"));
const REPORT_DIR = opt("--report", path.join(os.tmpdir(), "wag"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TEST_EMAIL = ["delta-check", "example.invalid"].join(String.fromCharCode(64));

const post = (base, route, body) =>
  fetch(`${base}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

const main = async () => {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log("NOT-RUN: Playwright is not installed on this machine (set PANEL_PLAYWRIGHT_ROOT)");
    process.exit(2);
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-delta-"));
  // A repo with one worktree, and nothing else: the check is about the page's own merge, not about a fleet.
  const repo = path.join(dir, "repos", "delta-checkout");
  mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q");
  git("-c", "user.name=Test", "-c", `user.email=${TEST_EMAIL}`, "commit", "-q", "--allow-empty", "-m", "first");
  git("worktree", "add", "-q", path.join(repo, ".worktrees", "one"), "-b", "feature/one");

  const panel = await startPanel({
    root: ROOT,
    dir,
    config: {
      scanRoots: [path.dirname(repo)],
      projects: [],
      threads: 1,
      worktreeSeconds: 60,
      midSeconds: 120,
      dormantSeconds: 300,
      slowSeconds: 600,
      refreshSeconds: 60,
      assistant: { enabled: false },
      apiServer: { url: "http://127.0.0.1:9", key: "stub" },
      remoteBranchPolicy: "local-only",
      defaultCwd: repo,
    },
  });
  const checks = [];
  const check = (name, ok, evidence) => checks.push({ name, ok: Boolean(ok), evidence });
  try {
    let seeded = null;
    for (let i = 0; i < 60 && !seeded; i += 1) {
      const snap = await fetch(`${panel.base}/api/state`).then((r) => r.json());
      const project = (snap.projects || [])[0];
      const rows = (project && project.worktrees) || [];
      if (project && rows.length >= 2 && (snap.treeList || {}).completedAt) seeded = { project: project.name, rows: rows.length };
      else await sleep(1000);
    }
    if (!seeded) throw new Error("the sandbox board never came up with two rows");

    await withBrowser(
      async ({ page }) => {
        const errors = [];
        page.on("pageerror", (e) => errors.push(String(e && e.message ? e.message : e)));
        await page.goto(panel.base, { waitUntil: "domcontentloaded" });
        // A fresh page draws the project folded. Open it the way the reader's click does (the fold is state, and the
        // paint follows it), then wait for its rows.
        await page.waitForFunction(() => typeof state !== "undefined" && state.projects.size > 0, null, { timeout: WAIT * 1000 });
        await page.evaluate(() => {
          for (const name of state.projects.keys()) state.expandedProjects.add(name);
          renderAll();
        });
        try {
          await page.waitForFunction(() => document.querySelectorAll("section.project[data-project] tr.row").length >= 2, null, { timeout: WAIT * 1000 });
        } catch (e) {
          const diag = await page.evaluate(() => ({
            sections: document.querySelectorAll("section.project[data-project]").length,
            rows: document.querySelectorAll("section.project[data-project] tr.row").length,
            detailRows: document.querySelectorAll("tr.detail").length,
            stateRows: typeof state !== "undefined" ? state.rows.size : null,
            projects: typeof state !== "undefined" ? [...state.projects.keys()] : null,
            expanded: typeof state !== "undefined" ? [...(state.expandedProjects || [])] : null,
            health: document.getElementById("stream-state") && document.getElementById("stream-state").textContent,
            text: document.body.innerText.slice(0, 300),
          }));
          throw new Error(`the page never drew two rows: ${JSON.stringify(diag)}`);
        }

        const before = await page.evaluate(() => {
          window.__rebuilds = 0;
          window.__deltas = 0;
          const origAll = window.renderAll;
          window.renderAll = function (...args) {
            window.__rebuilds += 1;
            return origAll.apply(this, args);
          };
          const origDelta = window.applySnapshotDelta;
          window.applySnapshotDelta = function (...args) {
            window.__deltas += 1;
            return origDelta.apply(this, args);
          };
          window.__section = document.querySelector("section.project[data-project]");
          // `state` is a top-level `let` in a classic script: a global binding, not a window property. Read bare, the
          // way the page's own code reads it.
          const rows = [...state.rows.values()].map((r) => ({ project: r.project, path: r.path, todo: r.todo && (r.todo.items || []).length }));
          return {
            streamUrl: state.es && state.es.url,
            projects: state.projects.size,
            rows: state.rows.size,
            projectNames: [...state.projects.keys()].sort(),
            rowsState: rows,
          };
        });
        check("the page asked for the lean shape", String(before.streamUrl || "").includes("shape=delta"), before.streamUrl);
        check("the board drew the seeded project and its rows", before.rows >= 2 && before.projects >= 1, { rows: before.rows, projects: before.projects });

        // ONE real write, on a row the board draws: a todo ADD. The panel answers it with a delta push.
        const target = before.rowsState.find((r) => r.project === seeded.project) || before.rowsState[0];
        const answer = await post(panel.base, "/api/todos", { op: "add", project: target.project, path: target.path, text: "delta check" });
        check("the write was accepted", answer && answer.ok, answer && (answer.message || answer.error));
        await sleep(1800);

        const after = await page.evaluate(() => {
          const rows = [...state.rows.values()].map((r) => ({ project: r.project, path: r.path, todo: r.todo && (r.todo.items || []).length }));
          return {
            rebuilds: window.__rebuilds,
            deltas: window.__deltas,
            rows: state.rows.size,
            projects: state.projects.size,
            projectNames: [...state.projects.keys()].sort(),
            rowsState: rows,
            sameSection: window.__section === document.querySelector("section.project[data-project]"),
          };
        });
        const moved = after.rowsState.find((r) => r.project === target.project && r.path === target.path);
        check("a delta frame applied it (applySnapshotDelta ran)", after.deltas >= 1, { deltas: after.deltas });
        check("the row's todo arrived on the page", Boolean(moved && moved.todo > (target.todo || 0)), { before: target.todo, after: moved && moved.todo });
        check("the push did not rebuild the board (no renderAll)", after.rebuilds === 0, { rebuilds: after.rebuilds });
        check("the project section on screen is the same node", after.sameSection === true, { sameSection: after.sameSection });
        check("every project is still on the board", JSON.stringify(after.projectNames) === JSON.stringify(before.projectNames), { before: before.projectNames, after: after.projectNames });
        check("every row is still on the board", after.rows === before.rows, { before: before.rows, after: after.rows });
        check("no page errors", errors.length === 0, errors.slice(0, 3));
      },
      { playwright },
    );
  } finally {
    await panel.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }

  const failed = checks.filter((c) => !c.ok);
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(path.join(REPORT_DIR, "verify-stream-delta.json"), JSON.stringify({ root: ROOT, checks, at: new Date().toISOString() }, null, 1));
  for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}${c.evidence !== undefined ? ` - ${JSON.stringify(c.evidence)}` : ""}`);
  console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
};

main().catch((e) => {
  console.error(String((e && e.stack) || e));
  process.exit(1);
});
