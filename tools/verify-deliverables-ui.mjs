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
// THE HEADER MOVES ON ITS OWN CLOCK, AND THE POPOVER IS POSITIONED ONCE. `#stream-rate` is written by a 1 s clock
// (`public/app.js:14772`) and is the last thing that reflows the controls: when it lands, the button moves 105 px
// right (236 → 341 at 1440 px wide). A popover opened before that is positioned from the old box and is left behind
// its anchor — which is the flake this gate used to report as "one edge aligned" (top 82 vs button bottom 76,
// left/right 236/796 vs button 341/440). So the gate waits for the header to settle before it opens the list, and
// asserts the relationship that matters — below the button, anchored to it, inside the card — rather than a
// pixel-exact edge. PANEL_GATE_MOVE_POPOVER=1 moves the popover off its anchor so that check can be seen to fail;
// breaking the page is the only thing the switch does, and it can never make a failing check pass.
//
// ONE SIDE EFFECT, DELIBERATELY. `POST /api/deliverables/open` for a file spawns `explorer.exe` on this box: the kit
// boots `server.js` as a child and the route calls `spawn` inline, so there is no process seam — and inventing one
// would let the gate pass while the real route was broken (plan §9.2 item 4). This gate therefore opens a real file
// three times — the harvested proof through the route, the restored file through the route, and the restored ROW
// through its own Open control — and prints a line saying so. The missing-file click is unchanged: it 404s before
// any spawn.
//
// WHAT IS DRIVEN
//   1. the button is in the header, between HUMAN and Collapse all; D opens it; a d in a field does not
//   2. the harvest seam put the DELIVER line in the store, and the real GET serves it with kind, title and age
//   3. the list is newest-first, with the glyph by kind, the target, the agent, the project and the age
//   4. the filter narrows, Esc clears it, Esc again closes and puts focus back on the button; End reaches the oldest
//   4b. the KIND chips: one per kind that has rows, ALL ON by default, a real button with aria-pressed reached by Tab
//      and pressed by Enter; a chip narrows the same list the text filter does (both compose), the head reports the
//      filtered set and names the kinds left on, the state survives a repaint, a kind with no rows has no chip at all,
//      and no chip writes the store
//   5. a title click POSTs the recorded seq ONLY — a request the panel answers 404 because the file is gone — and the
//      row then says `gone` (missingAt, stamped by the real route)
//   6. an unknown seq answers 404 and opens nothing; a restored file answers 200 and clears `gone`
//   6b. the restored ROW's own Open says what it opened and with which opener — `opened gone.md with explorer.exe` —
//      and claims no window, because a detached spawn cannot see one; a refusal is still the route's own sentence
//   7. at the cap the footer says 200 kept
//   8. a second, empty panel says `Nothing has been delivered yet.` and documents the grammar
//   9. a screenshot of the header and the open list is written for the report
//  10. the seen watermark: a store nobody opened counts every row; POST /api/deliverables/seen moves it forward once,
//      persists it beside the entries, refuses a non-integer and never moves it backwards
//  11. the badge: rows ABOVE the watermark only, the highlight as a class on #btn-deliver, the number in the
//      aria-label; opening (click or D) posts the watermark once and clears both with no flicker on the next poll;
//      a restart keeps a cleared badge cleared, and a FRESH delivery above the watermark re-lights it with ONE — the
//      badge's own dismiss then writes the same watermark without opening the list
//
// The browser half needs a Playwright install; without one this exits 2 (BROWSER-HALF-NOT-RUN), like the other
// verify-*.mjs harnesses.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const panel = await startPanel({ dir, keep: true, config: { assistant: { enabled: false } } });
console.log(`      panel   ${panel.base}  (throwaway: ${panel.dir})`);

let emptyPanel = null;
let restartedPanel = null;
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
  // The HIGHEST seq, which is what the page's watermark is: the list is ordered by `at`, and the fillers below carry
  // the oldest timestamps, so entries[0] is not the last number handed out.
  const newestSeq = first.body.entries.reduce((n, e) => Math.max(n, Number(e.seq) || 0), 0);

  // ---- 0b. the watermark: what the badge counts from, and the one route that writes it ---------------------------
  // A store nobody has opened has no watermark, so every kept row is new. That is the shape a restart reads, and it is
  // what makes "unseenCount" a number about THIS reader rather than about the archive.
  eq(
    "a store nobody has opened counts every row as unseen",
    { seenSeq: first.body?.seenSeq, seenAt: first.body?.seenAt, unseenCount: first.body?.unseenCount },
    { seenSeq: 0, seenAt: null, unseenCount: 200 },
  );
  const seenJson = async (seq, base = panel.base) => {
    const r = await fetch(`${base}/api/deliverables/seen`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(seq === undefined ? {} : { seq }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const badSeen = await seenJson("soon");
  eq("a non-integer watermark is refused", badSeen.status, 400);
  ok("…with the sentence that names the field", /`seq` must be the integer/.test(badSeen.body?.error || ""), badSeen.body?.error);
  const marked = await seenJson(HARVESTED_SEQ);
  eq("POST /api/deliverables/seen answers 200", marked.status, 200);
  eq(
    "…records the seq the page showed, and the count that is left",
    { seenSeq: marked.body?.seenSeq, unseenCount: marked.body?.unseenCount, moved: marked.body?.moved },
    { seenSeq: HARVESTED_SEQ, unseenCount: 199, moved: true },
  );
  ok("…and stamps when the reader looked", Number.isFinite(Date.parse(marked.body?.seenAt || "")), marked.body?.seenAt);
  const onDiskSeen = JSON.parse(readFileSync(STORE, "utf8"));
  eq(
    "…persisted BESIDE the entries, which is what a restart reads",
    { seenSeq: onDiskSeen.seenSeq, seenAt: onDiskSeen.seenAt },
    { seenSeq: HARVESTED_SEQ, seenAt: marked.body?.seenAt },
  );
  const backwards = await seenJson(0);
  eq(
    "an older seq cannot move the watermark backwards",
    { seenSeq: backwards.body?.seenSeq, moved: backwards.body?.moved, unseenCount: backwards.body?.unseenCount },
    { seenSeq: HARVESTED_SEQ, moved: false, unseenCount: 199 },
  );

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
    // OBSERVED, never fulfilled: what the page itself POSTs when a title is clicked, and what it records as seen.
    const posts = [];
    const seenPosts = [];
    page.on("request", (r) => {
      if (r.method() !== "POST") return;
      const bucket = r.url().includes("/api/deliverables/seen") ? seenPosts : r.url().includes("/api/deliverables/open") ? posts : null;
      if (!bucket) return;
      try {
        bucket.push(r.postDataJSON());
      } catch {
        bucket.push(null);
      }
    });

    await openPage(page, panel.base, { selector: "#btn-deliver" });

    // ---- 1. the button and its place -------------------------------------------------------------
    const header = await page.evaluate(() => {
      const ids = [...document.querySelectorAll(".controls > button")].map((b) => b.id);
      const btn = document.getElementById("btn-deliver");
      return {
        ids,
        label: (document.getElementById("deliver-label")?.textContent || "").trim(),
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

    // ---- 1b. the badge: rows ABOVE the watermark, a class for the highlight, the number in the aria-label -------
    await page.waitForFunction(() => !document.getElementById("deliver-badge").hidden, null, { timeout: 10_000 });
    const badge = await page.evaluate(() => {
      const btn = document.getElementById("btn-deliver");
      const pill = document.getElementById("deliver-badge");
      return {
        text: (pill?.textContent || "").trim(),
        hidden: Boolean(pill?.hidden),
        cls: btn.classList.contains("has-unseen"),
        style: btn.getAttribute("style") || "",
        label: btn.getAttribute("aria-label") || "",
      };
    });
    eq("the badge counts only rows ABOVE the watermark, never everything kept", badge.text, "199");
    eq("…and it is shown", badge.hidden, false);
    ok("the button wears the highlight as a class", badge.cls);
    ok("…carried by the class, not an inline style", !/background|border-color/.test(badge.style), badge.style || "(no style attribute)");
    ok("the aria-label carries the number — a coloured dot is not a notification", /199 new deliverables/.test(badge.label), badge.label);
    mkdirSync(SHOT_DIR, { recursive: true });
    const badgeShot = path.join(SHOT_DIR, "deliverables-badge.png");
    await page.screenshot({ path: badgeShot, clip: { x: 0, y: 0, width: 1440, height: 110 } });
    console.log(`SHOT  ${badgeShot}`);

    // ---- 1c. the header settles before anything is opened against it ------------------------------
    // The rate line is the last thing that reflows the controls (see the header comment). Wait for it, then for the
    // button's own box to hold still across frames: a popover positioned before that is anchored to a box that no
    // longer exists, which is the flake this gate used to report.
    const settled = await page.evaluate(async () => {
      const btn = document.getElementById("btn-deliver");
      const rate = document.getElementById("stream-rate");
      const box = () => {
        const r = btn.getBoundingClientRect();
        return [r.left, r.top, r.right, r.bottom].map((n) => Math.round(n)).join(",");
      };
      const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
      const until = performance.now() + 8_000;
      while (!(rate?.textContent || "").trim() && performance.now() < until) await frame();
      let last = box();
      let still = 0;
      while (still < 3 && performance.now() < until) {
        await frame();
        const now = box();
        still = now === last ? still + 1 : 0;
        last = now;
      }
      return { box: last, rate: (rate?.textContent || "").trim() };
    });
    console.log(`      header  settled at ${settled.box} (rate "${settled.rate}")`);

    // ---- 2. D opens it; a d in a field does not --------------------------------------------------
    // Opening IS seeing: the popover's open posts the watermark once, before a row is read.
    seenPosts.length = 0;
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press("d");
    await page.waitForSelector("#deliver-pop:not([hidden])", { timeout: 5_000 });
    eq("D opens the list", await page.evaluate(() => document.getElementById("btn-deliver").getAttribute("aria-expanded")), "true");
    eq("the popover is the live list", await page.evaluate(() => document.getElementById("dl-list").getAttribute("role")), "listbox");
    ok("focus lands in the filter", await page.evaluate(() => document.activeElement?.id === "dl-filter"));
    // The open has already cleared the badge, and it posted the watermark ONCE — the newest seq, nothing else.
    await page.waitForFunction(() => document.getElementById("deliver-badge").hidden, null, { timeout: 5_000 });
    eq("opening the list records the watermark once, with the newest seq", seenPosts, [{ seq: newestSeq }]);
    const clearedBadge = await page.evaluate(() => {
      const btn = document.getElementById("btn-deliver");
      return {
        cls: btn.classList.contains("has-unseen"),
        hidden: document.getElementById("deliver-badge").hidden,
        label: btn.getAttribute("aria-label") || "",
      };
    });
    eq("…the badge and the highlight are gone", { cls: clearedBadge.cls, hidden: clearedBadge.hidden }, { cls: false, hidden: true });
    ok("…and the aria-label stops claiming anything is new", !/new deliverable/.test(clearedBadge.label), clearedBadge.label);
    // THE NEXT POLL: the page's own read again. A GET that answered just before the POST landed must not re-light it,
    // which is what taking the max of the store's watermark and this page's own is for.
    await page.evaluate(() => deliverFetch({ quiet: true }));
    eq("the next poll does not flicker it back on", await page.evaluate(() => {
      const btn = document.getElementById("btn-deliver");
      return { cls: btn.classList.contains("has-unseen"), hidden: document.getElementById("deliver-badge").hidden };
    }), { cls: false, hidden: true });
    await page.keyboard.press("Escape");
    await page.waitForSelector("#deliver-pop[hidden]", { state: "attached", timeout: 5_000 });
    ok("Esc closes it and puts focus back on the button", await page.evaluate(() => document.getElementById("deliver-pop").hidden === true && document.activeElement?.id === "btn-deliver"));
    // The button is the other toggle, and a second press closes what the first opened. Nothing new has arrived, so the
    // open posts NOTHING: the watermark is already at the newest row.
    seenPosts.length = 0;
    await page.click("#btn-deliver");
    await page.waitForSelector("#deliver-pop:not([hidden])", { timeout: 5_000 });
    await page.click("#btn-deliver");
    await page.waitForSelector("#deliver-pop[hidden]", { state: "attached", timeout: 5_000 });
    ok("a second press of the button closes it", await page.evaluate(() => document.getElementById("deliver-pop").hidden === true));
    eq("…and a re-open with nothing new posts the watermark again only when the seq moved", seenPosts, []);

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
    // THE RED PROOF, ON DEMAND. PANEL_GATE_MOVE_POPOVER=beside slides the popover off its anchor but keeps it on
    // screen (the anchor clause must fail); =above lifts it over the button (the "below" clause must fail). Breaking
    // the page is the only thing the switch does, and it can never make a failing check pass.
    const MOVE = process.env.PANEL_GATE_MOVE_POPOVER || "";
    if (MOVE) {
      const moved = await page.evaluate((where) => {
        const p = document.getElementById("deliver-pop");
        const b = document.getElementById("btn-deliver").getBoundingClientRect();
        if (where === "above") p.style.top = "0px";
        else p.style.left = `${Math.round(b.right + 40)}px`;
        const r = p.getBoundingClientRect();
        return `${Math.round(r.left)},${Math.round(r.top)}`;
      }, MOVE);
      console.log(`      red proof: the popover was moved to ${moved} (${MOVE}) — the placement check must fail`);
    }
    // It hangs under the button, anchored to it, and stays inside the card. Both boxes are read in ONE frame, so the
    // pair compared is a pair that existed together. The relationship, not a pixel: the header reflows on its own
    // clock, and a popover positioned a frame before that is still under the button and still on screen.
    const box = await page.evaluate(() => {
      const p = document.getElementById("deliver-pop").getBoundingClientRect();
      const b = document.getElementById("btn-deliver").getBoundingClientRect();
      return { left: p.left, right: p.right, top: p.top, bottom: p.bottom, width: p.width, vw: innerWidth, vh: innerHeight, btnBottom: b.bottom, btnLeft: b.left, btnRight: b.right };
    });
    ok("the popover is fully on screen", box.left >= 0 && box.right <= box.vw, `left ${Math.round(box.left)}, right ${Math.round(box.right)} of ${box.vw}`);
    ok(
      "it hangs under the button, anchored to it and inside the card",
      box.top >= box.btnBottom - 0.5 &&
        box.left <= box.btnLeft + 1 &&
        box.right >= box.btnRight - 1 &&
        box.left >= 0 && box.right <= box.vw && box.top >= 0 && box.bottom <= box.vh,
      `top ${Math.round(box.top)} vs button bottom ${Math.round(box.btnBottom)}; popover ${Math.round(box.left)}..${Math.round(box.right)} vs button ${Math.round(box.btnLeft)}..${Math.round(box.btnRight)}; card ${box.vw}×${box.vh}`,
    );
    // Put the page back the way the reader would find it, so a red run's screenshot is still the real one.
    if (MOVE) await page.evaluate(() => deliverPosition());
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
    eq("the head says how many of how many, and which kinds", await page.evaluate(() => document.getElementById("dl-count").textContent.trim()), "1 of 200 · link file image");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelectorAll(".dl-row").length === 200, null, { timeout: 5_000 });
    eq("Esc clears the filter first", await page.evaluate(() => document.getElementById("dl-filter").value), "");
    await page.keyboard.press("End");
    eq("End reaches the oldest row", await page.evaluate(() => document.querySelector('.dl-row[aria-selected="true"]')?.dataset.seq), String(oldestSeq));
    await page.keyboard.press("Escape");
    await page.waitForSelector("#deliver-pop[hidden]", { state: "attached", timeout: 5_000 });
    ok("Esc again closes it and focus returns to the button", await page.evaluate(() => document.getElementById("deliver-pop").hidden === true && document.activeElement?.id === "btn-deliver"));

    // ---- 4b. the KIND chips: one per kind present, ALL ON by default, keyboard reachable, composing with the filter --
    await page.keyboard.press("d");
    await page.waitForSelector("#deliver-pop:not([hidden])", { timeout: 5_000 });
    await page.waitForFunction(() => document.querySelectorAll(".dl-row").length === 200, null, { timeout: 15_000 });
    const headText = () => page.evaluate(() => document.getElementById("dl-count").textContent.trim());
    const chipState = () =>
      page.evaluate(() =>
        [...document.querySelectorAll("#dl-kinds [data-dl-kind]")].map((c) => ({
          kind: c.dataset.dlKind,
          tag: c.tagName,
          type: c.getAttribute("type"),
          pressed: c.getAttribute("aria-pressed"),
          label: c.getAttribute("aria-label"),
          hidden: c.hidden,
          drawn: c.getBoundingClientRect().width > 0,
          glyph: (c.textContent || "").trim(),
        })),
      );
    const chips = await chipState();
    eq("one chip per kind that has rows, in the store's order", chips.map((c) => c.kind), ["link", "file", "image"]);
    ok("every chip is a real button", chips.every((c) => c.tag === "BUTTON" && c.type === "button"), chips.map((c) => c.tag).join(" "));
    eq("…all ON by default", chips.map((c) => c.pressed), ["true", "true", "true"]);
    ok("…each carries its own mark and a name an AT can read", chips.every((c) => c.glyph.length > 0 && /^(link|file|image)$/.test(c.label || "")), JSON.stringify(chips.map((c) => [c.glyph, c.label])));
    ok("…and is drawn, not hidden — this store holds all three", chips.every((c) => c.hidden === false && c.drawn), JSON.stringify(chips.map((c) => [c.kind, c.hidden, c.drawn])));
    eq("all on: the head says the plain total", await headText(), "200 deliverables — newest first");

    // Keyboard: the chips are real buttons, so Tab reaches them and Enter presses them. Tab out of the header still closes.
    await page.click("#dl-filter");
    await page.keyboard.press("Tab");
    eq("Tab from the search box reaches the first chip", await page.evaluate(() => document.activeElement?.dataset?.dlKind || ""), "link");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll(".dl-row").length === 199, null, { timeout: 5_000 });
    eq("Enter on a chip hides that kind", await page.evaluate(() => document.querySelector('[data-dl-kind="link"]').getAttribute("aria-pressed")), "false");
    eq("…the head reports the filtered set, and names what is left", await headText(), "199 of 200 · file image");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll(".dl-row").length === 200, null, { timeout: 5_000 });
    eq("…and Enter again puts it back", await page.evaluate(() => document.querySelector('[data-dl-kind="link"]').getAttribute("aria-pressed")), "true");

    // The mouse is the same press, and the text filter composes with it rather than replacing it.
    await page.click('[data-dl-kind="image"]');
    await page.waitForFunction(() => document.querySelectorAll(".dl-row").length === 199, null, { timeout: 5_000 });
    eq("a click hides the image, and the head counts the filtered set", await headText(), "199 of 200 · link file");
    await page.click("#dl-filter");
    await page.keyboard.type("dock");
    await page.waitForFunction(() => /nothing matches/.test(document.getElementById("dl-list").textContent), null, { timeout: 5_000 });
    ok(
      "the chips compose with the text filter: a word only the hidden kind matches finds nothing",
      await page.evaluate(() => /nothing matches “dock”/.test(document.getElementById("dl-list").textContent) && document.querySelectorAll(".dl-row").length === 0),
    );
    eq("…and the head still counts the same 200, naming the kinds left on", await headText(), "0 of 200 · link file");
    await page.click('[data-dl-kind="image"]');
    await page.waitForFunction(() => document.querySelectorAll(".dl-row").length === 1, null, { timeout: 5_000 });
    eq("…putting the kind back, with the word still typed, finds its one row", await page.evaluate(() => document.querySelector(".dl-row .dl-name").textContent.trim()), "The dock overlapping the console");
    eq("…and the head now counts over all three kinds", await headText(), "1 of 200 · link file image");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelectorAll(".dl-row").length === 200, null, { timeout: 5_000 });

    // A REPAINT: this is the paint a `deliverable` frame runs, and the state has to survive it.
    await page.click('[data-dl-kind="image"]');
    await page.waitForFunction(() => document.querySelectorAll(".dl-row").length === 199, null, { timeout: 5_000 });
    const countBeforeRepaint = await headText();
    await page.evaluate(() => deliverFetch({ quiet: true }));
    eq("a repaint keeps the kind switched off", await page.evaluate(() => document.querySelector('[data-dl-kind="image"]').getAttribute("aria-pressed")), "false");
    eq("…the rows stay filtered", await page.evaluate(() => document.querySelectorAll(".dl-row").length), 199);
    eq("…and the head still reports the filtered set", await headText(), countBeforeRepaint);
    ok("no row was touched by a chip: the store still holds all 200", await page.evaluate(async () => (await (await fetch("/api/deliverables")).json()).kept === 200));
    const kindsShot = path.join(SHOT_DIR, "deliverables-kind-chips.png");
    await page.locator("#deliver-pop").screenshot({ path: kindsShot });
    console.log(`SHOT  ${kindsShot}`);
    await page.click('[data-dl-kind="image"]');
    await page.waitForFunction(() => document.querySelectorAll(".dl-row").length === 200, null, { timeout: 5_000 });
    eq("…and the chip restores the whole list", await headText(), "200 deliverables — newest first");
    // Leave the popover SHUT and all kinds on, which is the state phase 5 expects to reopen from.
    await page.keyboard.press("Escape");
    await page.waitForSelector("#deliver-pop[hidden]", { state: "attached", timeout: 5_000 });


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

    // ---- 6b. the 200 {open:"handler"} is not silent ----------------------------------------------
    // The route answers from the spawn, so the row says what it handed over and to which opener, and stops there.
    // This is the one answer the audit found the page swallowing: 29 of 111 files and 7 of 32 images reached a
    // handler and the row said nothing, which a reader reads as "it doesn't respond at all".
    posts.length = 0;
    await page.locator(`.dl-row[data-seq="${goneEntry.seq}"] .dl-name`).click();
    await page.waitForFunction((seq) => Boolean(document.querySelector(`.dl-row[data-seq="${seq}"] .dl-opened`)), goneEntry.seq, { timeout: 10_000 });
    const answered = await page.evaluate((seq) => {
      const line = document.querySelector(`.dl-row[data-seq="${seq}"] .dl-opened`);
      return {
        text: (line?.textContent || "").trim(),
        role: line?.getAttribute("role") || "",
        why: Boolean(document.querySelector(`.dl-row[data-seq="${seq}"] .dl-why`)),
      };
    }, goneEntry.seq);
    eq("the answer's click POSTs the seq only", posts, [{ seq: goneEntry.seq }]);
    ok("a 200 handler says what it opened and with which opener", answered.text.startsWith("opened gone.md with explorer.exe"), answered.text);
    ok("…and claims no window, because the panel cannot see one", /cannot see whether a window appeared$/.test(answered.text), answered.text);
    ok("…as a polite status, with no refusal left on the row", answered.role === "status" && !answered.why, JSON.stringify({ role: answered.role, why: answered.why }));

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
    const emptyChips = await page.evaluate(() =>
      [...document.querySelectorAll("#dl-kinds [data-dl-kind]")].map((c) => ({ kind: c.dataset.dlKind, hidden: c.hidden, drawn: c.getBoundingClientRect().width > 0 })),
    );
    ok("a kind with no rows gets NO chip — hidden, never greyed", emptyChips.length === 3 && emptyChips.every((c) => c.hidden && !c.drawn), JSON.stringify(emptyChips));
    ok("…and the group is hidden, so the header carries no empty control", await page.evaluate(() => document.getElementById("dl-kinds").hidden === true));
    const empty = await getJson(emptyPanel.base);
    eq("the empty store's envelope is still the plan's shape", { version: empty.body?.version, cap: empty.body?.cap, kept: empty.body?.kept }, { version: 1, cap: 200, kept: 0 });
    const emptySeen = await seenJson(42, emptyPanel.base);
    eq(
      "an empty store cannot be marked seen past itself",
      { seenSeq: emptySeen.body?.seenSeq, moved: emptySeen.body?.moved, unseenCount: emptySeen.body?.unseenCount },
      { seenSeq: 0, moved: false, unseenCount: 0 },
    );
    // ---- 10. a restart must not resurrect a cleared badge, and a FRESH delivery must re-light it ----------------
    // Panel #1 was booted with keep:true, so stopping it leaves the sandbox — and the store the page just wrote — on
    // disk. The fresh row goes in through a store that LOADS that file, which is exactly what a restarted panel does.
    await emptyPanel.stop();
    emptyPanel = null;
    await panel.stop();
    writeFileSync(path.join(tree, "docs", "since-you-looked.html"), "<h1>delivered after the list was opened</h1>\n");
    const restartStore = new Deliverables({ file: STORE });
    const seenBefore = restartStore.list().seenSeq;
    const fresh = restartStore.record({
      job: { id: "feedface", thread: "wtgui-since-you-looked-9a10bc", turn: 1, project: "agent-worktree-gui", worktreePath: tree, branch },
      tree: { path: tree, branch },
      finalText: "DELIVER file docs/since-you-looked.html | Delivered after the list was opened",
      agent: "since-you-looked-9a10bc",
    });
    const freshSeq = restartStore.list().entries[0].seq;
    eq(
      "a fresh delivery lands ABOVE the watermark the page wrote",
      { added: fresh.added, seenSeq: seenBefore, seq: freshSeq },
      { added: 1, seenSeq: newestSeq, seq: newestSeq + 1 },
    );

    restartedPanel = await startPanel({ dir, keep: true, reuseConfig: true, config: { assistant: { enabled: false } } });
    const afterRestart = await getJson(restartedPanel.base);
    eq(
      "the restarted panel reads the watermark back: the 200 cleared rows stay cleared",
      { seenSeq: afterRestart.body?.seenSeq, unseenCount: afterRestart.body?.unseenCount },
      { seenSeq: seenBefore, unseenCount: 1 },
    );
    await openPage(page, restartedPanel.base, { selector: "#btn-deliver" });
    await page.waitForFunction(() => !document.getElementById("deliver-badge").hidden, null, { timeout: 10_000 });
    const relit = await page.evaluate(() => ({
      text: document.getElementById("deliver-badge").textContent.trim(),
      cls: document.getElementById("btn-deliver").classList.contains("has-unseen"),
      label: document.getElementById("btn-deliver").getAttribute("aria-label") || "",
      open: document.getElementById("btn-deliver").getAttribute("aria-expanded") === "true",
    }));
    eq("a fresh delivery re-lights the badge with ONE — not with everything ever delivered", relit.text, "1");
    ok("…the highlight is back", relit.cls);
    ok("…the aria-label says one", /1 new deliverable since/.test(relit.label), relit.label);
    eq("…and the list is still shut: the badge lit from the watermark, not from an open", relit.open, false);

    // The SECOND door: a press on the badge writes the SAME watermark through the same route, and never opens the list.
    seenPosts.length = 0;
    await page.click("#deliver-badge");
    await page.waitForFunction(() => document.getElementById("deliver-badge").hidden, null, { timeout: 5_000 });
    eq("the badge's dismiss posts the same watermark, once", seenPosts, [{ seq: freshSeq }]);
    ok(
      "…without opening the list",
      await page.evaluate(
        () => (document.getElementById("deliver-pop")?.hidden ?? true) === true && document.getElementById("btn-deliver").getAttribute("aria-expanded") === "false",
      ),
    );
    ok("…and the highlight goes with it", await page.evaluate(() => !document.getElementById("btn-deliver").classList.contains("has-unseen")));
    await page.evaluate(() => deliverFetch({ quiet: true }));
    ok("…and the next poll keeps it cleared", await page.evaluate(() => document.getElementById("deliver-badge").hidden === true));
    const dismissed = await getJson(restartedPanel.base);
    eq(
      "the store holds the dismissed watermark: nothing above it",
      { seenSeq: dismissed.body?.seenSeq, unseenCount: dismissed.body?.unseenCount },
      { seenSeq: freshSeq, unseenCount: 0 },
    );
    ok("no uncaught page error across the restart", pageErrors.length === 0, pageErrors.join(" | "));
    return shot;
  }, { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  console.log(`      screenshot ${result}`);
} finally {
  await emptyPanel?.stop();
  await restartedPanel?.stop();
  await panel.stop();
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* the panel's own stop already removed it */
  }
}

console.log(`\n${failures ? "FAILED" : "OK"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
