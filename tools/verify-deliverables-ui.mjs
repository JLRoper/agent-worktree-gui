// The DELIVERABLES button and list, proved by driving a real panel in a real browser.
//
//   node tools/verify-deliverables-ui.mjs
//
// WHAT THIS IS. The plan (docs/plan/deliverables-handback.md §5) puts one header button beside HUMAN and one
// popover listing every deliverable the panel has recorded, newest first, each row with its age. This gate boots a
// throwaway panel (tools/panel-testkit.mjs), serves the REAL public/index.html, public/app.js and public/style.css,
// and drives the page in headless Chromium.
//
// WHAT IS STUBBED, AND WHY IT HAS TO BE. The store and the two routes are another landing's half of the plan
// (lib/deliverables.js + server.js). This gate owns the page, so the two /api/deliverables routes are answered by
// Playwright route interception with the exact shapes §7.1/§7.2 specify. Everything else — the markup, the script,
// the stylesheet, the SSE connection, the keyboard — is the real served page. When the backend lands, drop the two
// route handlers and the same checks run against it.
//
// WHAT IS DRIVEN
//   1. the button is in the header, between HUMAN and Collapse all, and D opens it
//   2. a d typed into a field does not (the HUMAN guard) — and lands IN the field
//   3. the list is newest-first, with title, agent, project, age, the glyph by kind and day landmarks
//   4. the filter narrows, Esc clears it, Esc again closes and puts focus back on the button
//   5. the title click POSTs the recorded seq only; the page sends no path
//   6. a gone row says `gone` and keeps its click
//   7. at the cap the footer says 200 kept, End reaches the oldest row
//   8. the empty state documents the grammar; a failed read says so and offers retry
//   9. a screenshot of the header and the open list is written for the report
//
// The browser half needs a Playwright install; without one this exits 2 (BROWSER-HALF-NOT-RUN), like the other
// verify-*.mjs harnesses.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright, withBrowser, openPage, attachPageCollectors } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = process.env.PANEL_SHOT_DIR || path.join(HERE, "..", ".shots");

let checks = 0;
let failures = 0;
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), got === want ? String(got) : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const playwright = loadPlaywright({ root: path.join(HERE, "..") });
if (!playwright) {
  console.log("BROWSER-HALF-NOT-RUN  no Playwright install found — set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright");
  process.exit(2);
}

const NOW = Date.now();
const ago = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
// Day labels are read against LOCAL midnight, so the fixtures are anchored to it rather than to "N hours ago"
// (which crosses midnight depending on the hour the gate runs). 23:00 yesterday is always YESTERDAY; 22:00 the
// day before is always a date.
const midnight = new Date(NOW);
midnight.setHours(0, 0, 0, 0);
const atToday = ago(3 * MIN);
const atYesterday = new Date(midnight.getTime() - 1 * HOUR).toISOString();
const atTwoDays = new Date(midnight.getTime() - 26 * HOUR).toISOString();
const atOlder = new Date(midnight.getTime() - 50 * HOUR).toISOString();

const TREE = "C:/ProjectDevelopment/agent-worktree-gui/.worktrees/build-the-deliver-hand-b-327334";
const ENTRIES = [
  {
    seq: 18, kind: "file",
    target: `${TREE}/docs/plan/deliverables-handback.md`,
    title: "The deliverables handback plan",
    at: atToday, project: "agent-worktree-gui", treePath: TREE,
    branch: "wtgui/build-the-deliver-hand-b-327334", tag: "327334",
    jobId: "a1b2c3d4", thread: "wtgui-build-the-deliver-ha-327334", turn: 1,
    agent: "build-the-deliver-hand-b-327334", bytes: 65425, mtimeMs: NOW - 4 * MIN, missingAt: null,
  },
  {
    seq: 17, kind: "image",
    target: "C:/Users/roper/AppData/Local/Temp/wag/06eefd76/shot.png",
    title: "The dock overlapping the console",
    at: atYesterday, project: "agent-worktree-gui", treePath: TREE,
    branch: "wtgui/read-only-visual-audit-o-10e2ba", tag: "10e2ba",
    jobId: "e5f6a7b8", thread: "wtgui-read-only-visual-audit-o-10e2ba", turn: 3,
    agent: "read-only-visual-audit-o-10e2ba", bytes: 182344, mtimeMs: NOW - 125 * MIN, missingAt: null,
  },
  {
    seq: 16, kind: "link",
    target: "https://localhost:7473/report.html",
    title: "The 200-row probe report",
    at: atTwoDays, project: "agent-worktree-gui", treePath: TREE,
    branch: "wtgui/profile-the-four-paths-t-0a27af", tag: "0a27af",
    jobId: "c9d0e1f2", thread: "wtgui-profile-the-four-paths-t-0a27af", turn: 2,
    agent: "profile-the-four-paths-t-0a27af", bytes: null, mtimeMs: null, missingAt: null,
  },
  {
    seq: 15, kind: "file",
    target: `${TREE}/docs/report.html`,
    title: "Where the panel loses a card",
    at: atOlder, project: "agent-worktree-gui", treePath: TREE,
    branch: "wtgui/docs-architecture-md-10-41f98e", tag: "41f98e",
    jobId: "33445566", thread: "wtgui-docs-architecture-md-10-41f98e", turn: 1,
    agent: "docs-architecture-md-10-41f98e", bytes: 1200, mtimeMs: NOW - 50 * HOUR,
    missingAt: ago(2 * HOUR),
  },
];

const listBody = (entries, { cap = 200, kept = entries.length } = {}) => ({
  version: 1, cap, kept, nextSeq: 19, at: new Date().toISOString(), entries,
});

// 200 seeded rows for the cap check: the store writes newest-first, and the page must paint the order it is given.
const CAP_ENTRIES = Array.from({ length: 200 }, (_, i) => ({
  seq: 400 - i, kind: "file",
  target: `${TREE}/docs/reports/report-${400 - i}.md`,
  title: `Report ${400 - i}`,
  at: ago((i + 1) * 7 * MIN), project: "agent-worktree-gui", treePath: TREE,
  branch: "wtgui/build-the-deliver-hand-b-327334", tag: "327334",
  jobId: `job-${400 - i}`, thread: "wtgui-build-the-deliver-ha-327334", turn: 1,
  agent: "build-the-deliver-hand-b-327334", bytes: 100 + i, mtimeMs: NOW - (i + 1) * 7 * MIN, missingAt: null,
}));

let mode = { status: 200, body: listBody(ENTRIES) };
const opened = [];

const panel = await startPanel({ config: { assistant: { enabled: false } } });
console.log(`      panel   ${panel.base}  (throwaway: ${panel.dir})`);

try {
  // The served files are the real ones, before a browser touches them.
  const home = await (await fetch(`${panel.base}/`)).text();
  const appJs = await (await fetch(`${panel.base}/app.js`)).text();
  ok("the served page carries #btn-deliver", /id="btn-deliver"/.test(home), `${home.length} bytes of index.html`);
  ok("the served app.js carries the popover", /deliver-pop/.test(appJs) && /deliverFetch/.test(appJs), `${appJs.length} bytes of app.js`);

  const result = await withBrowser(async ({ page }) => {
    const { pageErrors, consoleErrors } = attachPageCollectors(page);

    await page.route("**/api/deliverables", async (route) => {
      await route.fulfill({
        status: mode.status,
        contentType: "application/json",
        body: JSON.stringify(mode.body),
      });
    });
    await page.route("**/api/deliverables/open", async (route) => {
      const body = route.request().postDataJSON();
      opened.push(body);
      const entry = ENTRIES.find((e) => Number(e.seq) === Number(body.seq));
      if (!entry) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "no deliverable on this panel" }) });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, kind: entry.kind, target: entry.target, opener: entry.kind === "link" ? "chrome.exe" : "explorer.exe", ...(entry.kind === "link" ? { chrome: true } : { bytes: entry.bytes }) }) });
    });

    await openPage(page, panel.base, { selector: "#btn-deliver" });

    // ---- 1. the button and its place -------------------------------------------------------------
    const header = await page.evaluate(() => {
      const ids = [...document.querySelectorAll(".controls > button")].map((b) => b.id);
      const btn = document.getElementById("btn-deliver");
      return {
        ids,
        label: (btn?.textContent || "").trim(),
        expanded: btn?.getAttribute("aria-expanded"),
        top: btn ? Math.round(btn.getBoundingClientRect().top) : null,
      };
    });
    const human = header.ids.indexOf("btn-human");
    const deliver = header.ids.indexOf("btn-deliver");
    const collapse = header.ids.indexOf("btn-collapse-all");
    ok("the header button sits between HUMAN and Collapse all", human >= 0 && deliver === human + 1 && collapse === deliver + 1, header.ids.join(" "));
    eq("the label is the plan's word", header.label, "DELIVERABLES");
    eq("the button says it is closed", header.expanded, "false");

    // ---- 2. D opens it; a d in a field does not --------------------------------------------------
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press("d");
    await page.waitForSelector("#deliver-pop:not([hidden])", { timeout: 5_000 });
    eq("D opens the list", await page.evaluate(() => document.getElementById("btn-deliver").getAttribute("aria-expanded")), "true");
    eq("the popover is the live list", await page.evaluate(() => document.getElementById("dl-list").getAttribute("role")), "listbox");
    ok("focus lands in the filter", await page.evaluate(() => document.activeElement?.id === "dl-filter"));
    await page.keyboard.press("Escape");
    await page.waitForSelector("#deliver-pop[hidden]", { state: "attached", timeout: 5_000 });
    ok("Esc closes it and puts focus back on the button", await page.evaluate(() => document.getElementById("deliver-pop").hidden === true && document.activeElement?.id === "btn-deliver"));
    // The button is the other toggle, and a second press closes what the first opened.
    await page.click("#btn-deliver");
    await page.waitForSelector("#deliver-pop:not([hidden])", { timeout: 5_000 });
    await page.click("#btn-deliver");
    await page.waitForSelector("#deliver-pop[hidden]", { state: "attached", timeout: 5_000 });
    ok("a second press of the button closes it", await page.evaluate(() => document.getElementById("deliver-pop").hidden === true));

    // A real text field, added by this probe (the board has no reply box without a card): typing d must land in it
    // and must not open the list.
    await page.evaluate(() => {
      const box = document.createElement("textarea");
      box.id = "probe-reply-box";
      box.style.position = "fixed";
      box.style.bottom = "0";
      document.body.append(box);
      box.focus();
    });
    await page.keyboard.type("d");
    eq("a d typed into a field stays in the field", await page.evaluate(() => document.getElementById("probe-reply-box").value), "d");
    ok("and the list stayed shut", await page.evaluate(() => document.getElementById("deliver-pop").hidden === true));
    await page.evaluate(() => document.getElementById("probe-reply-box").remove());

    // ---- 3. the rows -----------------------------------------------------------------------------
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press("D");
    await page.waitForSelector("#deliver-pop:not([hidden])", { timeout: 5_000 });
    await page.waitForFunction(() => document.querySelectorAll(".dl-row").length === 4, null, { timeout: 10_000 });

    const rows = await page.evaluate(() =>
      [...document.querySelectorAll(".dl-row")].map((r) => ({
        seq: Number(r.dataset.seq),
        title: r.querySelector(".dl-name")?.textContent.trim(),
        target: r.querySelector(".dl-target")?.textContent.trim(),
        meta: r.querySelector(".dl-meta")?.textContent.trim(),
        glyph: r.querySelector(".dl-glyph")?.textContent.trim(),
        gone: Boolean(r.querySelector(".dl-gone")),
        open: r.querySelector(".dl-name")?.dataset.dlOpen,
      })),
    );
    eq("four rows, newest first, as the store wrote them", rows.map((r) => r.seq), [18, 17, 16, 15]);
    eq("the first row is the plan", rows[0].title, "The deliverables handback plan");
    ok("the row carries agent, project and age", /build-the-deliver-hand-b-327334 · agent-worktree-gui · 3m ago/.test(rows[0].meta), rows[0].meta);
    ok("the age is fmtAgo's own wording", /\d+h ago/.test(rows[1].meta) && /\dd ago/.test(rows[3].meta), `${rows[1].meta} / ${rows[3].meta}`);
    eq("a file is a page glyph", rows[0].glyph, "📄");
    eq("an image is its own glyph — no thumbnail (Q4)", rows[1].glyph, "🖼");
    eq("a link is a link glyph", rows[2].glyph, "🔗");
    eq("the target is the last three segments", rows[0].target, "…/docs/plan/deliverables-handback.md");
    eq("a link shows host+path, no scheme", rows[2].target, "localhost:7473/report.html");
    ok("the gone row says gone", rows[3].gone === true && /gone/.test(await page.evaluate(() => document.querySelector('.dl-row[data-seq="15"]').textContent)));
    const labels = await page.evaluate(() => [...document.querySelectorAll(".dl-day")].map((d) => d.textContent.trim()));
    ok("day landmarks: TODAY, YESTERDAY, then a date", labels[0] === "TODAY" && labels[1] === "YESTERDAY" && /^\d{4}-\d{2}-\d{2}$/.test(labels[2]), labels.join(" / "));
    eq("the head counts and says newest first", await page.evaluate(() => document.getElementById("dl-count").textContent.trim()), "4 deliverables — newest first");
    ok("the cap line is absent below the cap", await page.evaluate(() => document.getElementById("dl-foot").hidden === true));
    // It hangs under the button and stays ON the screen. A 560px panel right-aligned to a button at x=440 ran off
    // the left edge before this anchor was clamped; the width is wider than the control, so this is the real check.
    const box = await page.evaluate(() => {
      const p = document.getElementById("deliver-pop").getBoundingClientRect();
      const b = document.getElementById("btn-deliver").getBoundingClientRect();
      return { left: p.left, right: p.right, top: p.top, width: p.width, vw: innerWidth, btnBottom: b.bottom, btnLeft: b.left, btnRight: b.right };
    });
    ok("the popover is fully on screen", box.left >= 0 && box.right <= box.vw, `left ${Math.round(box.left)}, right ${Math.round(box.right)} of ${box.vw}`);
    ok(
      "it hangs under the button, one edge aligned",
      Math.round(box.top) >= Math.round(box.btnBottom) &&
        (Math.abs(box.right - box.btnRight) <= 1 || Math.abs(box.left - box.btnLeft) <= 1),
      `top ${Math.round(box.top)} vs button bottom ${Math.round(box.btnBottom)}; left/right ${Math.round(box.left)}/${Math.round(box.right)} vs button ${Math.round(box.btnLeft)}/${Math.round(box.btnRight)}`,
    );
    ok("it is the plan's 560px wide", Math.abs(box.width - 560) <= 1, String(box.width));

    // ---- 4. filter and Esc -----------------------------------------------------------------------
    await page.click("#dl-filter");
    await page.keyboard.type("probe");
    await page.waitForFunction(() => document.querySelectorAll(".dl-row").length === 1, null, { timeout: 5_000 });
    eq("the filter narrows to the one report", await page.evaluate(() => document.querySelector(".dl-row .dl-name").textContent.trim()), "The 200-row probe report");
    eq("the head says how many of how many", await page.evaluate(() => document.getElementById("dl-count").textContent.trim()), "1 of 4 — newest first");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelectorAll(".dl-row").length === 4, null, { timeout: 5_000 });
    eq("Esc clears the filter first", await page.evaluate(() => document.getElementById("dl-filter").value), "");
    await page.keyboard.press("Escape");
    await page.waitForSelector("#deliver-pop[hidden]", { state: "attached", timeout: 5_000 });
    ok("Esc again closes it and focus returns to the button", await page.evaluate(() => document.getElementById("deliver-pop").hidden === true && document.activeElement?.id === "btn-deliver"));

    // ---- 5. the title opens through the route, by seq only ---------------------------------------
    opened.length = 0;
    await page.keyboard.press("d");
    await page.waitForSelector("#deliver-pop:not([hidden])", { timeout: 5_000 });
    await page.waitForFunction(() => document.querySelectorAll(".dl-row").length === 4, null, { timeout: 10_000 });
    await page.click('.dl-row[data-seq="17"] .dl-name');
    await page.waitForTimeout(300);
    eq("the title POSTs exactly one seq, and no path", opened, [{ seq: 17 }]);
    ok("a file's answer does not claim Chrome was missing", await page.evaluate(() => !/Chrome was not found/.test(document.body.textContent)));

    // ---- 6. a gone row keeps its click ----------------------------------------------------------
    opened.length = 0;
    await page.click('.dl-row[data-seq="15"] .dl-name');
    await page.waitForTimeout(300);
    eq("a gone row still tries its target", opened, [{ seq: 15 }]);

    // ---- 7. the cap ------------------------------------------------------------------------------
    mode = { status: 200, body: listBody(CAP_ENTRIES, { kept: 200 }) };
    await page.keyboard.press("Escape"); // close (filter empty)
    await page.waitForSelector("#deliver-pop[hidden]", { state: "attached", timeout: 5_000 });
    await page.keyboard.press("d");
    await page.waitForFunction(() => document.querySelectorAll(".dl-row").length === 200, null, { timeout: 10_000 });
    eq("200 seeded entries all paint", await page.evaluate(() => document.querySelectorAll(".dl-row").length), 200);
    ok("the footer explains the cap", await page.evaluate(() => !document.getElementById("dl-foot").hidden && /200 kept — older rows are forgotten; the files stay on disk\./.test(document.getElementById("dl-foot").textContent)));
    await page.click("#dl-filter");
    await page.keyboard.press("End");
    eq("End reaches the oldest row", await page.evaluate(() => document.querySelector('.dl-row[aria-selected="true"]')?.dataset.seq), "201");
    await page.keyboard.type("Report 3");
    await page.waitForFunction(() => document.querySelectorAll(".dl-row").length < 200 && document.querySelectorAll(".dl-row").length > 0, null, { timeout: 5_000 });
    ok("the filter is the answer to the 200th row", await page.evaluate(() => document.querySelectorAll(".dl-row").length <= 120), String(await page.evaluate(() => document.querySelectorAll(".dl-row").length)));
    await page.keyboard.press("Escape");

    // ---- 8. empty and failed states --------------------------------------------------------------
    // Everything above ran against a healthy store: a console error from here on is the 500 this gate asks for.
    const errorsBeforeFailure = consoleErrors.length;
    ok("no console error while the store answered", errorsBeforeFailure === 0, consoleErrors.slice(0, 3).join(" | "));
    mode = { status: 200, body: listBody([], { kept: 0 }) };
    await page.keyboard.press("Escape"); // close
    await page.waitForSelector("#deliver-pop[hidden]", { state: "attached", timeout: 5_000 });
    await page.keyboard.press("d");
    await page.waitForFunction(() => /Nothing has been delivered yet/.test(document.getElementById("dl-list").textContent), null, { timeout: 10_000 });
    ok("the empty state documents the grammar", await page.evaluate(() => /DELIVER file C:\/path\/to\/report\.html \| The report/.test(document.querySelector(".dl-hint code")?.textContent || "")));

    mode = { status: 500, body: { error: "the store could not be read" } };
    await page.keyboard.press("Escape");
    await page.waitForSelector("#deliver-pop[hidden]", { state: "attached", timeout: 5_000 });
    await page.keyboard.press("d");
    await page.waitForFunction(() => /could not read the list/.test(document.getElementById("dl-list").textContent), null, { timeout: 10_000 });
    ok("a failed read says so and offers retry", await page.evaluate(() => Boolean(document.querySelector("[data-dl-retry]")) && /the store could not be read/.test(document.getElementById("dl-list").textContent)));

    // ---- 9. the screenshot, on the real four-row list -------------------------------------------
    mode = { status: 200, body: listBody(ENTRIES) };
    await page.keyboard.press("Escape");
    await page.waitForSelector("#deliver-pop[hidden]", { state: "attached", timeout: 5_000 });
    await page.keyboard.press("d");
    await page.waitForFunction(() => document.querySelectorAll(".dl-row").length === 4, null, { timeout: 10_000 });
    mkdirSync(SHOT_DIR, { recursive: true });
    const shot = path.join(SHOT_DIR, "deliverables-button-and-list.png");
    await page.screenshot({ path: shot, fullPage: false });
    console.log(`SHOT  ${shot}`);

    ok("no uncaught page error", pageErrors.length === 0, pageErrors.join(" | "));
    const unexpected = consoleErrors.filter((m) => !/500 \(Internal Server Error\)/.test(m));
    ok("no console error beyond the 500 this gate asked for", unexpected.length === 0, unexpected.join(" | "));
    return shot;
  }, { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  console.log(`      screenshot ${result}`);
} finally {
  await panel.stop();
}

console.log(`\n${failures ? "FAILED" : "OK"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
