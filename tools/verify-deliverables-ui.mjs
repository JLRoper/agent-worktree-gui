// The DELIVERABLES button and list, proved by driving a real panel — the REAL backend, and no interception.
//
//   node tools/verify-deliverables-ui.mjs
//
// HARNESS: LIVE GATE — it tracks main, and `npm run verify:deliverables-ui` is how the repo runs it by name.
//
// WHAT THIS IS. docs/plan/deliverables-handback.md puts one header button beside HUMAN and one popover listing every
// deliverable the panel has recorded, newest first, each row with its age. This gate boots a throwaway panel
// (tools/panel-testkit.mjs) which serves the real `server.js`, `public/index.html`, `public/app.js` and
// `public/style.css`, and drives the page in headless Chromium.
//
// WHAT CHANGED, AND WHY IT MATTERS. The first version of this file answered `GET /api/deliverables` and
// `POST /api/deliverables/open` from Playwright route handlers because the backend had not landed — and that is
// exactly how the 404 shipped: the button worked, the verifier was green, and a reader's first click found nothing.
// There is NO `page.route` here now. The store is seeded by running the REAL settle seam (`Jobs.harvestDeliverables`
// over a real `Deliverables` store), the list is read from the panel's own `GET`, and the open is the panel's own
// `POST`. The page's own request is only OBSERVED (`page.on("request")`), never fulfilled.
//
// ONE SIDE EFFECT, DELIBERATELY. `POST /api/deliverables/open` for a file spawns `explorer.exe` on this box: the kit
// boots `server.js` as a child and the route calls `spawn` inline, so there is no process seam — and inventing one
// would let the gate pass while the real route was broken (plan §9.2 item 4). This gate therefore opens a real file
// twice and prints a line saying so. It never clicks the title of a deliverable that EXISTS: the page-click check
// uses the row whose file was deleted, which 404s before any spawn.
//
// WHAT IS DRIVEN
//   1. the button is in the header, between HUMAN and Collapse all; D opens it; a d in a field does not
//   2. the harvest seam put the DELIVER line in the store, and the real GET serves it with kind, title and age
//   3. the list is newest-first, with the glyph by kind, the target, the agent, the project and the age
//   4. the filter narrows, Esc clears it, Esc again closes and puts focus back on the button; End reaches the oldest
//   5. a title click POSTs the recorded seq ONLY — a request the panel answers 404 because the file is gone — and the
//      row then says `gone` (missingAt, stamped by the real route)
//   6. an unknown seq answers 404 and opens nothing; a restored file answers 200 and clears `gone`
//   7. at the cap the footer says 200 kept
//   8. a second, empty panel says `Nothing has been delivered yet.` and documents the grammar
//   9. a screenshot of the header and the open list is written for the report
//
// The browser half needs a Playwright install; without one this exits 2 (BROWSER-HALF-NOT-RUN), like the other
// verify-*.mjs harnesses.
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright, withBrowser, openPage, attachPageCollectors } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";
import { Deliverables } from "../lib/deliverables.js";
import { Jobs } from "../lib/jobs.js";

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

// ---- the panel sandbox, seeded through the real seam BEFORE it boots -----------------------------------------------
// A store written before the panel starts is the only way to seed one from outside the process that owns it: the store
// loads lazily on the first GET, so the panel serves exactly this file. Everything after the seeding is real HTTP
// against server.js.
const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-deliver-gate-"));
const tree = path.join(dir, "fixtures", "the-report-tree-327334");
const branch = "wtgui/the-report-tree-327334";
mkdirSync(path.join(tree, "docs"), { recursive: true });
mkdirSync(path.join(tree, "many"), { recursive: true });
writeFileSync(path.join(tree, "docs", "report.html"), "<h1>the 200-row probe report</h1>\n");
writeFileSync(path.join(tree, "docs", "shot.png"), "png-bytes\n");
writeFileSync(path.join(tree, "docs", "gone.md"), "# this one is deleted before the click\n");
const STORE = path.join(dir, "logs", "deliverables.json");
const FILLERS = 196; // + the four rows below = exactly the cap
for (let i = 1; i <= FILLERS; i += 1) writeFileSync(path.join(tree, "many", `r${i}.md`), `${i}\n`);

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Day labels are read against LOCAL midnight, so the ages are anchored to it rather than to "N hours ago" (which
// crosses midnight depending on the hour the gate runs).
const midnight = new Date(NOW);
midnight.setHours(0, 0, 0, 0);
const atYesterday = new Date(midnight.getTime() - 1 * HOUR).toISOString(); // yesterday 23:00 — always YESTERDAY
const atTwoDays = new Date(midnight.getTime() - 26 * HOUR).toISOString(); // yesterday 22:00 — still YESTERDAY
const atOlder = new Date(midnight.getTime() - 50 * HOUR).toISOString(); // two days back — always a date
const atFillers = new Date(midnight.getTime() - 4 * DAY).toISOString();

const store = new Deliverables({ file: STORE, log: (m) => console.log(`      store: ${m}`) });

// (1) THE HARVEST SEAM, the thing the first gate could not exercise: a settled run's final message goes in, one row
// comes out, and the ⇢ line lands on the card. The job's `worktreePath` is deliberately a stale name — the tree this
// pass measured is the base a relative target resolves against (the review's B2).
const harvestJob = {
  id: "a1b2c3d4",
  thread: "wtgui-the-report-tree-327334",
  turn: 1,
  project: "agent-worktree-gui",
  worktreePath: path.join(dir, "the-old-name"), // what a rename left behind
  branch,
  finalMessage: "The report is written.\n\nDELIVER file docs/report.html | The deliverables handback plan\n",
  lines: [],
};
const harness = Object.create(Jobs.prototype);
harness.deliverables = store;
harness.push = (job, line) => job.lines.push(line);
const harvested = harness.harvestDeliverables(harvestJob, { path: tree, branch });
const HARVESTED_SEQ = store.list().entries[0]?.seq ?? null;

// (2) Three more rows through the same store, with fixed ages so the day landmarks are stable: an image, a link, and
// a file that is deleted before any click (the `gone` row).
const seeded = [
  {
    job: { id: "e5f6a7b8", thread: "wtgui-the-visual-audit-10e2ba", turn: 3, project: "agent-worktree-gui", worktreePath: tree, branch: "wtgui/the-visual-audit-10e2ba" },
    text: "DELIVER image docs/shot.png | The dock overlapping the console",
    agent: "the-visual-audit-10e2ba",
    now: Date.parse(atYesterday),
  },
  {
    job: { id: "c9d0e1f2", thread: "wtgui-profile-the-four-paths-0a27af", turn: 2, project: "agent-worktree-gui", worktreePath: tree, branch: "wtgui/profile-the-four-paths-0a27af" },
    text: "DELIVER link https://localhost:7473/report.html | The 200-row probe report",
    agent: "profile-the-four-paths-0a27af",
    now: Date.parse(atTwoDays),
  },
  {
    job: { id: "33445566", thread: "wtgui-docs-architecture-41f98e", turn: 1, project: "agent-worktree-gui", worktreePath: tree, branch: "wtgui/docs-architecture-41f98e" },
    text: "DELIVER file docs/gone.md | Where the panel loses a card",
    agent: "docs-architecture-41f98e",
    now: Date.parse(atOlder),
  },
];
for (const s of seeded) {
  store.record({ job: s.job, tree: { path: tree, branch: s.job.branch }, finalText: s.text, agent: s.agent, now: s.now });
}
const goneEntry = store.list().entries.find((e) => e.target.endsWith("/docs/gone.md")) || null;

// (3) Fillers to the cap, in ONE message: the oldest rows the footer counts.
store.record({
  job: { id: "fillerrun", thread: "wtgui-filler", turn: 1, project: "agent-worktree-gui", worktreePath: tree, branch },
  tree: { path: tree, branch },
  finalText: Array.from({ length: FILLERS }, (_, i) => `DELIVER file many/r${i + 1}.md | Report ${i + 1}`).join("\n"),
  agent: "filler",
  now: Date.parse(atFillers),
});

// The gone row's file is deleted now: the store keeps the row, and the click is what finds it missing.
rmSync(path.join(tree, "docs", "gone.md"), { force: true });

console.log(`      seeded  ${store.size} rows in ${STORE} (harvested seq ${HARVESTED_SEQ}, gone seq ${goneEntry?.seq})`);
const panel = await startPanel({ dir, config: { assistant: { enabled: false } } });
console.log(`      panel   ${panel.base}  (throwaway: ${panel.dir})`);

let emptyPanel = null;
try {
  // ---- 0. the real routes, before a browser touches the page ------------------------------------------------------
  const getJson = async (base = panel.base) => {
    const r = await fetch(`${base}/api/deliverables`);
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const openJson = async (seq, base = panel.base) => {
    const r = await fetch(`${base}/api/deliverables/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(seq === undefined ? {} : { seq }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  const first = await getJson();
  eq("GET /api/deliverables answers 200", first.status, 200);
  eq("the envelope is the plan's §7.1 shape", { version: first.body?.version, cap: first.body?.cap, kept: first.body?.kept }, { version: 1, cap: 200, kept: 200 });
  ok("kept and nextSeq are numbers a footer can read", Number.isInteger(first.body?.nextSeq) && first.body.nextSeq > 200, `nextSeq ${first.body?.nextSeq}`);
  ok("the list is newest first", first.body.entries.every((e, i, all) => i === 0 || Date.parse(all[i - 1].at) >= Date.parse(e.at)), "every row is at least as new as the one below it");
  const fetchRow = (seq) => first.body.entries.find((e) => e.seq === seq);
  const oldestSeq = first.body.entries[first.body.entries.length - 1].seq;

  // 1. THE PROOF THE FIRST GATE HID: the row came out of a real harvest of a real DELIVER line.
  const harvestedRow = fetchRow(HARVESTED_SEQ);
  ok("the harvested DELIVER line is in the list", Boolean(harvestedRow) && harvestedRow.title === "The deliverables handback plan", JSON.stringify(harvestedRow && { seq: harvestedRow.seq, kind: harvestedRow.kind, title: harvestedRow.title }));
  eq("…with its kind", harvestedRow?.kind, "file");
  eq("…its resolved target, from the tree this pass measured", harvestedRow?.target, `${tree.replace(/\\/g, "/")}/docs/report.html`);
  ok("…its age (it was delivered seconds ago)", Date.now() - Date.parse(harvestedRow?.at || 0) < 120_000, harvestedRow?.at);
  eq("…and the agent its thread names", harvestedRow?.agent, "wtgui-the-report-tree-327334");
  eq("…under the project", harvestedRow?.project, "agent-worktree-gui");
  ok("…and the harvest pushed its ⇢ line onto the card", harvested.lines.some((l) => /^⇢ DELIVER file recorded: /.test(l.text)) && harvestJob.deliverHarvested === true, harvested.lines.map((l) => l.text).join(" | "));

  // The open route, for real: an unknown seq, and a file that exists.
  const unknown = await openJson(9999);
  eq("an unknown seq answers 404", unknown.status, 404);
  ok("…with the sentence that says so", /^no deliverable 9999 on this panel — the list was pruned, or this page is older than the store$/.test(unknown.body?.error || ""), unknown.body?.error);
  ok("…and opens nothing: no kind, no target, no opener", !("opener" in (unknown.body || {})) && !("target" in (unknown.body || {})) && !("kind" in (unknown.body || {})), JSON.stringify(unknown.body));
  const stillThere = await getJson();
  eq("…and nothing was stamped missing by it", stillThere.body.entries.filter((e) => e.missingAt).length, 0);

  const openExisting = await openJson(HARVESTED_SEQ);
  eq("the harvested seq opens with 200", openExisting.status, 200);
  eq("…as a file through the OS association", { ok: openExisting.body?.ok, kind: openExisting.body?.kind, opener: openExisting.body?.opener }, { ok: true, kind: "file", opener: "explorer.exe" });
  eq("…answering the bytes it recorded", openExisting.body?.bytes, statSync(path.join(tree, "docs", "report.html")).size);
  console.log("      note: that 200 spawned explorer.exe for the real file — the route's real behaviour, plan §9.2 item 4");

  const result = await withBrowser(async ({ page }) => {
    const { pageErrors, consoleErrors } = attachPageCollectors(page);
    // OBSERVED, never fulfilled: what the page itself POSTs when a title is clicked.
    const posts = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("/api/deliverables/open")) {
        try {
          posts.push(r.postDataJSON());
        } catch {
          posts.push(null);
        }
      }
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

    // ---- 3. the rows, from the REAL GET ----------------------------------------------------------
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press("D");
    await page.waitForSelector("#deliver-pop:not([hidden])", { timeout: 5_000 });
    await page.waitForFunction(() => document.querySelectorAll(".dl-row").length === 200, null, { timeout: 15_000 });

    const rows = await page.evaluate(() =>
      [...document.querySelectorAll(".dl-row")].slice(0, 4).map((r) => ({
        seq: Number(r.dataset.seq),
        title: r.querySelector(".dl-name")?.textContent.trim(),
        target: r.querySelector(".dl-target")?.textContent.trim(),
        meta: r.querySelector(".dl-meta")?.textContent.trim(),
        glyph: r.querySelector(".dl-glyph")?.textContent.trim(),
        gone: Boolean(r.querySelector(".dl-gone")),
      })),
    );
    eq("the cap's worth of rows paint, newest first", rows.map((r) => r.seq), [HARVESTED_SEQ, HARVESTED_SEQ + 1, HARVESTED_SEQ + 2, HARVESTED_SEQ + 3]);
    eq("the first row is the harvested deliverable", rows[0].title, "The deliverables handback plan");
    ok("the row carries agent, project and age", /wtgui-the-report-tree-327334 · agent-worktree-gui · just now/.test(rows[0].meta), rows[0].meta);
    ok("the older rows carry their own ages", /\d+h ago/.test(rows[1].meta) && /\dd ago/.test(rows[3].meta), `${rows[1].meta} / ${rows[3].meta}`);
    eq("a file is a page glyph", rows[0].glyph, "📄");
    eq("an image is its own glyph — no thumbnail (Q4)", rows[1].glyph, "🖼");
    eq("a link is a link glyph", rows[2].glyph, "🔗");
    eq("the target is the last three segments", rows[0].target, "…/the-report-tree-327334/docs/report.html");
    eq("a link shows host+path, no scheme", rows[2].target, "localhost:7473/report.html");
    ok("no row is `gone` yet — the file is deleted, the CLICK is what finds it", rows.every((r) => r.gone === false));
    const labels = await page.evaluate(() => [...document.querySelectorAll(".dl-day")].map((d) => d.textContent.trim()));
    ok("day landmarks: TODAY, YESTERDAY, then a date", labels[0] === "TODAY" && labels[1] === "YESTERDAY" && /^\d{4}-\d{2}-\d{2}$/.test(labels[2]), labels.join(" / "));
    eq("the head counts and says newest first", await page.evaluate(() => document.getElementById("dl-count").textContent.trim()), "200 deliverables — newest first");
    ok("the footer explains the cap", await page.evaluate(() => !document.getElementById("dl-foot").hidden && /200 kept — older rows are forgotten; the files stay on disk\./.test(document.getElementById("dl-foot").textContent)));
    // It hangs under the button and stays ON the screen.
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
    // The screenshot: the newest rows and the cap footer, before any click has painted a banner over them.
    mkdirSync(SHOT_DIR, { recursive: true });
    const shot = path.join(SHOT_DIR, "deliverables-button-and-list.png");
    await page.screenshot({ path: shot, fullPage: false });
    console.log(`SHOT  ${shot}`);

    // ---- 4. filter, Esc and End ------------------------------------------------------------------
    await page.click("#dl-filter");
    await page.keyboard.type("probe");
    await page.waitForFunction(() => document.querySelectorAll(".dl-row").length === 1, null, { timeout: 5_000 });
    eq("the filter narrows to the one report", await page.evaluate(() => document.querySelector(".dl-row .dl-name").textContent.trim()), "The 200-row probe report");
    eq("the head says how many of how many", await page.evaluate(() => document.getElementById("dl-count").textContent.trim()), "1 of 200 — newest first");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelectorAll(".dl-row").length === 200, null, { timeout: 5_000 });
    eq("Esc clears the filter first", await page.evaluate(() => document.getElementById("dl-filter").value), "");
    await page.keyboard.press("End");
    eq("End reaches the oldest row", await page.evaluate(() => document.querySelector('.dl-row[aria-selected="true"]')?.dataset.seq), String(oldestSeq));
    await page.keyboard.press("Escape");
    await page.waitForSelector("#deliver-pop[hidden]", { state: "attached", timeout: 5_000 });
    ok("Esc again closes it and focus returns to the button", await page.evaluate(() => document.getElementById("deliver-pop").hidden === true && document.activeElement?.id === "btn-deliver"));

    // ---- 5. the title click is a REAL request, by seq only, and the 404 lands ----------------------
    await page.keyboard.press("d");
    await page.waitForSelector("#deliver-pop:not([hidden])", { timeout: 5_000 });
    await page.waitForFunction(() => document.querySelectorAll(".dl-row").length === 200, null, { timeout: 15_000 });
    posts.length = 0;
    await page.click(`.dl-row[data-seq="${goneEntry.seq}"] .dl-name`);
    await page.waitForFunction((seq) => Boolean(document.querySelector(`.dl-row[data-seq="${seq}"] .dl-gone`)), goneEntry.seq, { timeout: 10_000 });
    eq("the title POSTs exactly one seq, and no path", posts, [{ seq: goneEntry.seq }]);
    ok("the panel answered its own store's 404, and the row now says gone", await page.evaluate((seq) => document.querySelector(`.dl-row[data-seq="${seq}"]`).classList.contains("is-gone"), goneEntry.seq));
    const stamped = await getJson();
    ok("…and the store recorded missingAt", Boolean(stamped.body.entries.find((e) => e.seq === goneEntry.seq)?.missingAt));

    // ---- 6. a restored file opens, and clears `gone` ---------------------------------------------
    writeFileSync(path.join(tree, "docs", "gone.md"), "# it is back\n");
    const restored = await openJson(goneEntry.seq);
    eq("a restored file answers 200", restored.status, 200);
    eq("…and is opened by the OS association", { ok: restored.body?.ok, kind: restored.body?.kind, opener: restored.body?.opener }, { ok: true, kind: "file", opener: "explorer.exe" });
    const cleared = await getJson();
    eq("…and `gone` is cleared in the store", cleared.body.entries.find((e) => e.seq === goneEntry.seq)?.missingAt, null);
    console.log("      note: that 200 spawned explorer.exe again — the same real route, now for a file that is there");

    // ---- 7. a deleted target answers 404 and opens nothing ---------------------------------------
    rmSync(path.join(tree, "docs", "shot.png"), { force: true });
    const goneAgain = await openJson(HARVESTED_SEQ + 1);
    eq("a file deleted between harvest and click answers 404", goneAgain.status, 404);
    ok("…naming the file, the agent and the moment it was last seen", /^no such file: .*shot\.png — it was there when the-visual-audit-10e2ba delivered it \(/.test(goneAgain.body?.error || ""), goneAgain.body?.error);
    ok("…with no opener in the answer", !("opener" in (goneAgain.body || {})), JSON.stringify(goneAgain.body));

    // ---- 8. the page's own health ---------------------------------------------------------------
    ok("no uncaught page error", pageErrors.length === 0, pageErrors.join(" | "));
    // The 404s this gate ASKED for are logged by the browser itself; nothing else may be.
    const unexpected = consoleErrors.filter((m) => !/404 \(Not Found\)|Failed to load resource/.test(m));
    ok("no console error beyond the 404s this gate asked for", unexpected.length === 0, unexpected.join(" | "));

    // ---- 9. an empty store: the empty state, and no cap line ------------------------------------
    emptyPanel = await startPanel({ config: { assistant: { enabled: false } } });
    await openPage(page, emptyPanel.base, { selector: "#btn-deliver" });
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press("d");
    await page.waitForSelector("#deliver-pop:not([hidden])", { timeout: 5_000 });
    await page.waitForFunction(() => /Nothing has been delivered yet/.test(document.getElementById("dl-list").textContent), null, { timeout: 10_000 });
    ok("an empty store says nothing has been delivered yet", await page.evaluate(() => /Nothing has been delivered yet\./.test(document.getElementById("dl-list").textContent)));
    ok("…documents the grammar, so a reader can tell an agent by hand", await page.evaluate(() => /DELIVER file C:\/path\/to\/report\.html \| The report/.test(document.querySelector(".dl-hint code")?.textContent || "")));
    ok("…and shows no cap line", await page.evaluate(() => document.getElementById("dl-foot").hidden === true));
    const empty = await getJson(emptyPanel.base);
    eq("the empty store's envelope is still the plan's shape", { version: empty.body?.version, cap: empty.body?.cap, kept: empty.body?.kept }, { version: 1, cap: 200, kept: 0 });
    return shot;
  }, { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  console.log(`      screenshot ${result}`);
} finally {
  await emptyPanel?.stop();
  await panel.stop();
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* the panel's own stop already removed it */
  }
}

console.log(`\n${failures ? "FAILED" : "OK"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
