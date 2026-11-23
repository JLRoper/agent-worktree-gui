#!/usr/bin/env node
// THE REPORTS CHIP, ON THE REAL PAGE, OPENING A REAL REPORT IN A NEW TAB.
//
// HARNESS: LIVE GATE
//
//   node tools/verify-wave-reports.mjs [--shots <dir>]
//
// WHAT THIS GATE PROVES, and why each half is a measurement rather than a look:
//
//   1. THE ROUTE ANSWERS WHAT THE TREE HOLDS. GET /api/reports for the task's thread lists the two .html reports this
//      branch added under docs/reports and NOT the one main carried before the cut - the union, narrowed to this task.
//   2. THE CHIP IS ON THE MEMBER ROW, and carries the task, the thread and the project the route is keyed by. Its
//      `aria-expanded` is false before the press.
//   3. THE PRESS DRAWS THE LIST, once. The chip reads `reports 2`, the list holds two rows, and every link carries
//      `target="_blank"` and `rel="noopener"` - the reader's own words: it opens in the same browser, in a new tab.
//   4. THE LINK OPENS THE REPORT. A new PAGE appears in the same context (a real new tab), its URL is the view route,
//      and it RENDERS the report's own body - not a JSON error, not a 404, not an empty document.
//   5. ESCAPE CLOSES IT, and Enter opens it again: the two keys the brief names. The list is drawn from module state, so
//      it is also what a lane repaint would draw.
//   6. HEALTH: zero page errors and zero console errors on the panel page.
//
// Sandbox only: its own config, port and state directory, one throwaway git repo it makes and removes, and an apiServer
// pointed at a dead port. The live panel on 7331 and ~/.wag are never touched. Without Playwright the script says
// BROWSER-NOT-RUN and exits 2 rather than passing on a half that never ran.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { git, post, startPanel, waitForState } from "./panel-testkit.mjs";
import { readQueueFile, writeQueueFile } from "../lib/assistant/queue.js";

const WATCHDOG_MS = Number(process.env.PANEL_VERIFY_WATCHDOG_MS || 300_000);
const watchdog = setTimeout(() => {
  try {
    process.stderr.write(`WATCHDOG: ${WATCHDOG_MS}ms elapsed without the run finishing.\n`);
  } catch {
    /* nothing left to do */
  }
  process.exit(1);
}, WATCHDOG_MS);

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
    console.log(`FAIL  ${name}${extra ? ` - ${extra}` : ""}`);
  }
};
const note = (s) => console.log(`      ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const shotDirArg = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : null;
const shotsDir = shotDirArg ? path.resolve(shotDirArg) : null;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

// ---- the sandbox: one project, one tree, one task whose tree holds two reports --------------------------------
const sandbox = mkdtempSync(path.join(tmpdir(), "wag-wave-reports-"));
const repos = path.join(sandbox, "repos");
mkdirSync(repos, { recursive: true });
const repo = path.join(repos, "reports-gate");
mkdirSync(path.join(repo, "docs", "reports"), { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# reports-gate\n");
// A report main carried BEFORE the cut: it sits in the same directory and must not be claimed by this task.
writeFileSync(path.join(repo, "docs", "reports", "carried-by-main-2026-01-01.html"), "<title>Carried by main</title><p>not this task's</p>\n");
git(repo, ["add", "-A"]);
git(repo, ["commit", "-q", "-m", "main: the base report"]);
const tree = path.join(repo, ".worktrees", "reports-tree");
git(repo, ["worktree", "add", "-q", "-b", "feat/reports-tree", tree]);
const treeReports = path.join(tree, "docs", "reports");
mkdirSync(treeReports, { recursive: true });
writeFileSync(
  path.join(treeReports, "the-first-report.html"),
  '<!doctype html><html><head><title>The reports gate report</title><style>body{font-family:sans-serif}</style></head><body><h1 id="proof">The reports chip opened this file</h1><p>served by GET /api/reports/view, sandboxed</p></body></html>\n',
);
git(tree, ["add", "docs/reports/the-first-report.html"]);
git(tree, ["commit", "-q", "-m", "the tree's report"]);
writeFileSync(path.join(treeReports, "the-untracked-report.html"), "<title>The untracked report</title><p>never committed</p>\n");
const wavesFile = path.join(sandbox, "logs", "waves.json");

const panel = await startPanel({
  dir: sandbox,
  config: {
    refreshSeconds: 3600,
    worktreeSeconds: 3600,
    midSeconds: 3600,
    dormantSeconds: 3600,
    slowSeconds: 3600,
    fetchSeconds: 3600,
    scanMode: "all",
    apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
    wavesFile,
  },
});
const base = panel.base;
const GET = async (p) => {
  const r = await fetch(`${base}${p}`);
  return { status: r.status, headers: r.headers, json: await r.json().catch(() => ({})) };
};

let shotNo = 0;
const shotName = (slug) => path.join(shotsDir, `${String((shotNo += 1)).padStart(2, "0")}-${slug}.png`);
const shotOf = async (page, slug, selector = null) => {
  if (!shotsDir) return null;
  const file = shotName(slug);
  const target = selector ? page.locator(selector).first() : null;
  if (target && (await target.count()) > 0) await target.screenshot({ path: file });
  else await page.screenshot({ path: file });
  note(`shot ${path.basename(file)}`);
  return file;
};

try {
  console.log(`sandbox: ${base}`);
  console.log(`panel pid: ${panel.pid}`);

  await waitForState(
    base,
    (s) => s.projects.flatMap((p) => (p.worktrees || []).map((w) => w.path)).some((p) => p.replace(/\\/g, "/").toLowerCase() === tree.replace(/\\/g, "/").toLowerCase()),
    "the task's worktree is on the board",
    { timeout: 120_000 },
  );

  // ---- the fixture: one initiative, one wave, one member ------------------------------------------------
  console.log("\n== seed ==");
  check("the initiative tier leaves create free", (await post(base, "/api/settings/initiative-tier", { body: { tier: "remove" } })).status, 200);
  const made = await post(base, "/api/initiatives", { body: { title: "Reports on a task row", description: "One wave, one member, two .html reports in its tree." } });
  check("the initiative is created", made.status, 201);
  const initiativeId = made.json?.initiative?.id;
  ok("the initiative has an id", Boolean(initiativeId), String(initiativeId || ""));

  const assistant = (await GET("/api/state")).json?.assistant?.assistants?.[0];
  ok("the panel seeded an assistant", Boolean(assistant?.id), String(assistant?.id || ""));
  const added = await post(base, "/api/assistant/queue", { body: { assistantId: assistant.id, action: "add", title: "the reports row", worktree: tree, project: "reports-gate" } });
  check("the task is filed", added.status, 200);
  const task = (await GET(`/api/assistant/queue?assistantId=${assistant.id}`)).json?.queue?.tasks?.find((t) => t.title === "the reports row");
  ok("the filed task is in the queue", Boolean(task?.id), String(task?.id || ""));
  // A task that has run carries the thread of that run; filing alone does not stamp one. This is the value the chip
  // reads and the route keys on, so it is written here exactly as a run would leave it.
  const thread = "reports-gate-thread";

  // Membership is the task's own field, stamped here exactly as a reader or a later write route would.
  const queueFile = path.join(sandbox, "logs", "assistants", assistant.id, "queue.json");
  const queued = readQueueFile(queueFile);
  if (queued.error) throw new Error(`the queue cannot be read: ${queued.error}`);
  writeQueueFile(queueFile, queued.tasks.map((t) => (t.id === task.id ? { ...t, thread, waveId: "wave_01" } : t)), queued.nextId);
  const stamped = (await GET(`/api/assistant/queue?assistantId=${assistant.id}`)).json?.queue?.tasks?.find((t) => t.id === task.id);
  check("the task carries its thread", stamped?.thread, thread);
  writeFileSync(
    wavesFile,
    `${JSON.stringify(
      {
        version: 1,
        byInitiative: {
          [initiativeId]: [{ id: "wave_01", initiativeId, position: 1, title: "Reports on a row", entryGate: { check: "clean" }, exitGate: null, template: null, auto: false }],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // ---- the route's own answer, before any paint ---------------------------------------------------------
  console.log("\n== route ==");
  const listQuery = `?thread=${encodeURIComponent(thread)}&task=${encodeURIComponent(String(task.id))}`;
  const listed = await GET(`/api/reports${listQuery}`);
  check("GET /api/reports answers", listed.status, 200);
  const names = (listed.json?.reports || []).map((r) => r.name);
  check("the list is the two reports this branch added", names.sort(), ["the-first-report.html", "the-untracked-report.html"]);
  ok("the report main carried is NOT listed", !names.includes("carried-by-main-2026-01-01.html"), names.join(", "));
  const served = (listed.json?.reports || []).find((r) => r.name === "the-first-report.html");
  ok("the row carries a view url", Boolean(served?.url), String(served?.url || ""));
  const view = await fetch(`${base}${served.url}`);
  check("the view answers 200", view.status, 200);
  check("the view is text/html", view.headers.get("content-type"), "text/html; charset=utf-8");
  check("the view is no-store", view.headers.get("cache-control"), "no-store");
  ok("the view carries its sandbox", /default-src 'none'/.test(view.headers.get("content-security-policy") || ""), String(view.headers.get("content-security-policy") || ""));
  ok("the view serves the report's own body", /The reports chip opened this file/.test(await view.text()));

  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the reports chip opening a real report", "playwright is not installed for this node (see tools/browser.mjs)"));
    failures += 1;
  } else {
    await withBrowser(
      async ({ context, page, pageErrors, consoleErrors }) => {
        await openPage(page, base, { selector: "#projects" });
        const open = await page.evaluate(() => {
          const el = document.getElementById("assistant");
          return Boolean(el) && !el.hidden && getComputedStyle(el).display !== "none";
        });
        if (!open) await page.click("#btn-assistant");
        await page.waitForSelector("#assistant:not([hidden])", { timeout: 20_000 });
        await page.click('#as-tabs [data-as-tab="initiatives"]');
        await page.waitForSelector("#as-initiatives:not(.hidden)", { timeout: 20_000 });
        await page.waitForSelector("#as-initiatives .init-card", { timeout: 30_000 });
        await page.click("#as-initiatives .init-card .init-head-btn");
        await page.waitForSelector("#as-initiatives .init-card .init-wavefold", { timeout: 20_000 });
        const chipSelector = `#as-initiatives [data-wave-member="${task.id}"] [data-wave-reports]`;
        await page.waitForSelector(chipSelector, { timeout: 20_000 });

        // 2. the chip is on the member row and names what the route is keyed by.
        console.log("\n== the chip ==");
        const chip = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return el
            ? {
                text: el.textContent.trim(),
                task: el.getAttribute("data-task"),
                thread: el.getAttribute("data-thread"),
                project: el.getAttribute("data-project"),
                expanded: el.getAttribute("aria-expanded"),
                tag: el.tagName.toLowerCase(),
                listed: Boolean(el.closest(".wave-member")),
              }
            : null;
        }, chipSelector);
        ok("the member row draws a chip", Boolean(chip), JSON.stringify(chip));
        check("the chip is a button", chip?.tag, "button");
        check("the chip names the task", chip?.task, String(task.id));
        check("the chip names the thread", chip?.thread, thread);
        check("the chip names the project", chip?.project, "reports-gate");
        check("the chip starts folded", chip?.expanded, "false");
        check("the chip's first label is reports", chip?.text, "reports");
        await shotOf(page, "chip-on-the-member-row", "#as-initiatives .init-wavefold");

        // 3. the press draws the list, once.
        console.log("\n== the list ==");
        await page.click(chipSelector);
        await page.waitForSelector(`#as-initiatives [data-wave-report-list="${thread}|${task.id}"]`, { timeout: 20_000 });
        await page.waitForSelector(`#as-initiatives [data-wave-report-list="${thread}|${task.id}"] .wave-report-link`, { timeout: 20_000 });
        const drawn = await page.evaluate((sel) => {
          const chip = document.querySelector(sel);
          const list = document.querySelector(`#as-initiatives [data-wave-report-list="${chip.getAttribute("data-wave-reports")}"]`);
          return {
            label: chip.textContent.trim(),
            expanded: chip.getAttribute("aria-expanded"),
            rows: [...(list ? list.querySelectorAll(".wave-report-row") : [])].map((row) => {
              const a = row.querySelector("a");
              return {
                title: (a || row.querySelector(".wave-report-link"))?.textContent.trim() || "",
                href: a ? a.getAttribute("href") : null,
                target: a ? a.getAttribute("target") : null,
                rel: a ? a.getAttribute("rel") : null,
                meta: row.querySelector(".wave-report-meta")?.textContent.trim() || "",
              };
            }),
          };
        }, chipSelector);
        check("the chip counted the answer", drawn.label, "reports 2");
        check("the chip reads as unfolded", drawn.expanded, "true");
        check("the list holds both reports", drawn.rows.map((r) => r.title).sort(), ["The reports gate report", "The untracked report"]);
        ok("every row is a new-tab link", drawn.rows.every((r) => r.target === "_blank" && /noopener/.test(r.rel || "")), JSON.stringify(drawn.rows.map((r) => ({ target: r.target, rel: r.rel }))));
        ok("every row's href is the view route", drawn.rows.every((r) => /^\/api\/reports\/view\?/.test(r.href || "")), JSON.stringify(drawn.rows.map((r) => r.href)));
        ok("every row shows its path as meta", drawn.rows.every((r) => /docs\/reports\//.test(r.meta)), JSON.stringify(drawn.rows.map((r) => r.meta)));
        await shotOf(page, "the-list-unfolded", "#as-initiatives .init-wavefold");

        // 4. the link opens the report in a NEW TAB of this browser.
        console.log("\n== the new tab ==");
        const [tab] = await Promise.all([
          context.waitForEvent("page", { timeout: 20_000 }),
          page.click(`#as-initiatives [data-wave-report-list="${thread}|${task.id}"] a[href*="the-first-report.html"]`),
        ]);
        await tab.waitForLoadState("domcontentloaded", { timeout: 20_000 });
        const tabState = {
          url: tab.url(),
          title: await tab.title(),
          proof: await tab.locator("#proof").textContent().catch(() => ""),
          body: (await tab.locator("body").innerText().catch(() => "")) || "",
        };
        ok("a NEW TAB opened (a second page in the same context)", tab !== page);
        ok("the tab's URL is the view route", /\/api\/reports\/view\?/.test(tabState.url), tabState.url);
        ok("the tab RENDERS the report's own body", /The reports chip opened this file/.test(tabState.body), tabState.body.slice(0, 120));
        check("the tab's document title is the report's", tabState.title, "The reports gate report");
        if (shotsDir) {
          // The new tab is a page of its own, so the shot is taken from it (no second browser window).
          const file = shotName("the-report-in-the-new-tab");
          await tab.screenshot({ path: file });
          note(`shot ${path.basename(file)}`);
        }
        await tab.close();

        // 5. Escape closes, Enter opens again.
        console.log("\n== the keys ==");
        await page.keyboard.press("Escape");
        await page.waitForSelector(`#as-initiatives [data-wave-report-list="${thread}|${task.id}"]`, { state: "detached", timeout: 10_000 });
        const folded = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return { expanded: el.getAttribute("aria-expanded"), text: el.textContent.trim() };
        }, chipSelector);
        check("Escape closes the list", folded.expanded, "false");
        check("the count stays on the chip when it closes", folded.text, "reports 2");
        // The rail's own Escape handler closes the whole panel when the caret is in it; a fold must not take the panel
        // with it. This is the line that proves the press was consumed by the list.
        const railOpen = await page.evaluate(() => {
          const el = document.getElementById("assistant");
          return Boolean(el) && !el.hidden && getComputedStyle(el).display !== "none";
        });
        ok("the assistant rail is still open after the fold", railOpen === true);
        await page.focus(chipSelector);
        // A lane repaint from a snapshot replaces the node under the reader's focus, so a press can land on a detached
        // element. The gate presses again rather than blaming Enter for a repaint: what it proves is that the key
        // reaches the same press a mouse click does, and the second attempt is named when it is needed.
        let reopened = false;
        for (let attempt = 1; attempt <= 3 && !reopened; attempt += 1) {
          await page.locator(chipSelector).focus();
          await page.keyboard.press("Enter");
          reopened = await page
            .waitForSelector(`#as-initiatives [data-wave-report-list="${thread}|${task.id}"] .wave-report-link`, { timeout: 3_000 })
            .then(() => true)
            .catch(() => false);
          if (!reopened) note(`Enter did not open the list on attempt ${attempt} (the lane repainted under focus); pressing again`);
        }
        ok("Enter opens it again, from the cache (no second read)", reopened);

        // 6. health.
        console.log("\n== health ==");
        check("no page errors", pageErrors.map(String), []);
        check("no console errors", consoleErrors.map(String), []);
      },
      { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
    );
  }
} catch (err) {
  failures += 1;
  console.error(`\nFAIL  the run threw: ${err && err.stack ? err.stack : err}`);
  try {
    console.error(panel.log().split("\n").slice(-20).join("\n"));
  } catch {
    /* the log is a courtesy */
  }
} finally {
  await panel.stop();
  rmSync(sandbox, { recursive: true, force: true });
  clearTimeout(watchdog);
}

console.log(`\n${failures === 0 ? "OK" : "FAILED"}  ${checks - failures}/${checks} checks passed${shotsDir ? `; shots in ${shotsDir}` : ""}`);
process.exit(failures === 0 ? 0 : 1);
