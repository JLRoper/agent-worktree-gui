// The floating header with the Human control REMOVED, proved on a real panel at 1440x900 and at 768x900.
// HARNESS: LIVE GATE - `npm run verify:header-without-human`.
//
//   node tools/verify-header-without-human.mjs                # boot a throwaway panel and drive it
//   node tools/verify-header-without-human.mjs --keep         # leave the sandbox on disk
//   node tools/verify-header-without-human.mjs --out <dir>    # where the screenshots go
//
// WHAT THIS IS. The Human button was the last step of the header plan: one badge over four kinds of waiting, and one
// H key that stepped through all four. Permissions, Clarify and Collisions each got their own header control first,
// and review items are counted by the Review control that was already there. This gate proves the page a reader gets:
//
//   1. THE CONTROL IS GONE. No #btn-human, #human-badge, #human-label, no settings-tab-human and no
//      settings-panel-human, and no human-kind-* switch anywhere in the document.
//   2. THE REVIEW KIND STILL COUNTS, SOMEWHERE THE READER SEES. A delivery is seeded through the panel's own settle
//      seam (Jobs.harvestReview -> lib/review-inbox.js), and #review-badge reads 1; the control's title says it is the
//      header's one count of results to read and promises no key; its press filters the table to exactly that row.
//   3. THE THREE SURVIVING KINDS STILL REACH THE READER. #btn-permissions, #btn-clarify and #btn-collisions are drawn,
//      wired, open their own popover, and that popover lands inside the viewport. (What each popover CONTAINS is its own
//      gate's subject: verify-permissions-history, verify-clarify-history, verify-collisions, verify-collision-pairs.)
//   4. H DOES NOTHING, AND RAISES NOTHING. The key is pressed on a blurred page: no row opens, no popover opens, no ring
//      flashes, and no page error is raised.
//   5. NO SETTINGS TAB POINTS AT A BUTTON THAT IS NOT THERE. The strip has no Human tab, every tab names a panel that
//      exists, and opening two of them still works.
//   6. THE HEADER LAYS OUT CLEANLY AT BOTH WIDTHS. No horizontal page scroll, every visible control inside the
//      viewport, and no two controls overlapping: at 1440x900 and at 768x900.
//
// WHAT IS REAL HERE. The server is this checkout's server.js on its own port and its own state folder, the page is the
// one it serves, and the delivery is the one the panel's own harvest writes. Nothing fabricates page state: the
// clicks, the keys and the rect reads are the page's own.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright, withBrowser, openPage } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";
import { Jobs } from "../lib/jobs.js";
import { ReviewInbox } from "../lib/review-inbox.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const keep = argv.includes("--keep");
const outDir = argOf("out", path.join(HERE, "..", ".shots"));

let checks = 0;
let failures = 0;
const ok = (label, cond, detail = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${label}${detail ? `: ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
};
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}${JSON.stringify(got) === JSON.stringify(want) ? "" : ` want ${JSON.stringify(want)}`}`);
const section = (t) => console.log(`\n-- ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const playwright = loadPlaywright({ root: path.join(HERE, "..") });
if (!playwright) {
  console.log("BROWSER-HALF-NOT-RUN  no Playwright install found - set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright");
  process.exit(2);
}

// ---- the fixture: a real repo with one worktree, and one finished delivery --------------------------------------
const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-no-human-"));
const repos = path.join(dir, "repos");
const repo = path.join(repos, "no-human-proj");
const git = (args, cwd = repo) =>
  execFileSync("git", args, {
    cwd,
    stdio: "pipe",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "gate",
      GIT_AUTHOR_EMAIL: "gate@local",
      GIT_COMMITTER_NAME: "gate",
      GIT_COMMITTER_EMAIL: "gate@local",
    },
  });
mkdirSync(repo, { recursive: true });
git(["init", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# no-human fixture\n");
git(["add", "-A"]);
git(["commit", "-m", "fixture"]);
const TREE = path.join(repo, ".worktrees", "review-one-ab12cd").replace(/\\/g, "/");
git(["worktree", "add", "-b", "wtgui/review-one-ab12cd", TREE]);

const STORE = path.join(dir, "logs", "reviews.json");
const store = new ReviewInbox({ file: STORE, log: (m) => console.log(`      store: ${m}`) });
const harness = Object.create(Jobs.prototype);
harness.reviewInbox = store;
harness.push = () => {};
const landed = harness.harvestReview(
  {
    id: "runnoooo1",
    thread: "no-human-thread",
    project: "no-human-proj",
    status: "done",
    endedAt: "2026-11-18T09:00:00.000Z",
    finalMessage: "Removed the Human control from the floating header.\n\nThe report is docs/reports/no-human.html\n\n## Next steps\n- check the header at both widths",
  },
  { path: TREE },
);
ok("the panel's own settle seam recorded the delivery", landed?.saved === true, JSON.stringify(landed?.saved));
eq("…and the store holds it awaiting a check", store.count(), 1);

const panel = await startPanel({ dir, keep, config: { reviewsFile: STORE, assistant: { enabled: false } } });
console.log(`      panel   ${panel.base}  (throwaway: ${panel.dir})`);

const shotDir = outDir;
mkdirSync(shotDir, { recursive: true });

const READER = () =>
  // The page's own reading of the header, the settings strip and the viewport.
  ({
    ids: [...document.querySelectorAll("header.topbar .controls button")].map((b) => b.id),
    visible: [...document.querySelectorAll("header.topbar .controls button")]
      .filter((b) => !b.hidden && b.offsetParent !== null)
      .map((b) => {
        const r = b.getBoundingClientRect();
        return { id: b.id, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) };
      }),
    removed: {
      btn: document.querySelectorAll("#btn-human").length,
      badge: document.querySelectorAll("#human-badge").length,
      label: document.querySelectorAll("#human-label").length,
      tab: document.querySelectorAll("#settings-tab-human").length,
      panel: document.querySelectorAll("#settings-panel-human").length,
      switches: document.querySelectorAll("[id^='human-kind-']").length,
    },
    review: {
      badge: (document.getElementById("review-badge")?.textContent || "").trim(),
      hidden: document.getElementById("review-badge")?.hidden,
      title: document.getElementById("btn-review")?.title || "",
      pressed: document.getElementById("btn-review")?.getAttribute("aria-pressed"),
      rows: document.querySelectorAll("tr.row[data-key]").length,
      marks: document.querySelectorAll("tr.row .review-mark").length,
    },
    buttons: Object.fromEntries(
      ["btn-permissions", "btn-clarify", "btn-collisions"].map((id) => {
        const b = document.getElementById(id);
        return [
          id,
          {
            exists: Boolean(b),
            wired: b?.dataset.wired || null,
            expanded: b?.getAttribute("aria-expanded") || null,
            controls: b?.getAttribute("aria-controls") || null,
            title: (b?.title || "").slice(0, 120),
          },
        ];
      }),
    ),
    popovers: Object.fromEntries(
      ["permissions-pop", "clarify-pop", "collisions-pop"].map((id) => {
        const el = document.getElementById(id);
        if (!el) return [id, { exists: false }];
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return [id, { exists: true, hidden: el.hidden, display: style.display, x: Math.round(r.x), y: Math.round(r.y), right: Math.round(r.right), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }];
      }),
    ),
    tabs: [...document.querySelectorAll("button.settings-tab")].map((t) => ({
      id: t.id,
      label: (t.querySelector(".settings-tab-label")?.textContent || "").trim(),
      controls: t.getAttribute("aria-controls"),
      panelThere: Boolean(document.getElementById(t.getAttribute("aria-controls"))),
    })),
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scrollWidth: document.documentElement.scrollWidth,
    header: (() => {
      const r = document.querySelector("header.topbar")?.getBoundingClientRect();
      return r ? { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) } : null;
    })(),
  });

// How a header is judged clean: inside the viewport, no page scroll, and no two visible controls overlapping.
function layoutVerdict(v) {
  const outside = v.visible.filter((b) => b.x < 0 || b.right > v.viewport.width + 1);
  const overlaps = [];
  for (let i = 0; i < v.visible.length; i += 1) {
    for (let j = i + 1; j < v.visible.length; j += 1) {
      const a = v.visible[i];
      const b = v.visible[j];
      const dx = Math.min(a.right, b.right) - Math.max(a.x, b.x);
      const dy = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
      if (dx > 1 && dy > 1) overlaps.push(`${a.id} x ${b.id}`);
    }
  }
  // A row is a band of tops within 3px of each other: two controls on one line can round a pixel apart.
  const bands = [];
  for (const b of [...v.visible].sort((x, y) => x.y - y.y)) {
    const band = bands.find((t) => Math.abs(t - b.y) <= 3);
    if (band === undefined) bands.push(b.y);
  }
  const rows = bands.length;
  const clipped = v.header ? v.visible.filter((b) => b.bottom > v.header.bottom + 1) : [];
  return { outside, overlaps, rows, clipped, scrollX: v.scrollWidth > v.viewport.width + 1, headerHeight: v.header?.height || 0 };
}

try {
  const verdict = await withBrowser(async ({ page }) => {
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e)));
    await openPage(page, panel.base, { selector: "#btn-review" });
    // A project and a root group start folded, so no row is drawn until the reader opens them: this gate opens them
    // the way the reader does, then waits for the row the filter's count is about.
    await page.waitForSelector('section.project[data-project="no-human-proj"]', { state: "attached", timeout: 60_000 });
    const closed = await page.evaluate(() => {
      const g = document.querySelector("section.root-group.collapsed");
      const p = document.querySelector("section.project.collapsed");
      return { root: g?.dataset.root || null, project: p?.dataset.project || null };
    });
    if (closed.root) await page.click(`[data-toggle-root="${closed.root.replace(/"/g, '\\"')}"]`);
    if (closed.project) await page.click(`[data-toggle-project="${closed.project}"]`);
    await page.waitForFunction(() => document.querySelectorAll("tr.row[data-key]").length > 0, null, { timeout: 60_000 });
    await page.waitForFunction(() => document.getElementById("review-badge") && !document.getElementById("review-badge").hidden, null, { timeout: 20_000 });

    // ---- 1. the control is gone ----------------------------------------------------------------------------
    section("the Human control is gone");
    let v = await page.evaluate(READER);
    eq("no button, badge, label, Settings tab, Settings panel or switch survives", v.removed, { btn: 0, badge: 0, label: 0, tab: 0, panel: 0, switches: 0 });
    ok("…and its id is not among the header's controls", !v.ids.includes("btn-human"), v.ids.join(" "));

    // ---- 2. review items still count, on the Review control ------------------------------------------------
    section("the review kind still counts, where the reader sees it");
    eq("the delivery is counted on the Review badge", { text: v.review.badge, hidden: v.review.hidden }, { text: "1", hidden: false });
    ok("the Review control says it is the header's one count of results to read", /one count of results to read/i.test(v.review.title), v.review.title.slice(0, 160));
    ok("…and promises no key, because the H rotation is gone", !/Press H|press H|H steps/.test(v.review.title), v.review.title.slice(0, 160));
    eq("…and it is not filtering yet", v.review.pressed, "false");
    await page.click("#btn-review");
    await page.waitForFunction(() => document.getElementById("btn-review")?.getAttribute("aria-pressed") === "true", null, { timeout: 10_000 });
    v = await page.evaluate(READER);
    eq("its press filters the table to exactly the row it counted", { rows: v.review.rows, marks: v.review.marks }, { rows: 1, marks: 1 });
    await page.screenshot({ path: path.join(shotDir, "header-without-human-review-filter-1440x900.png") });
    console.log(`SHOT  ${path.join(shotDir, "header-without-human-review-filter-1440x900.png")}`);
    await page.click("#btn-review");
    await page.waitForFunction(() => document.getElementById("btn-review")?.getAttribute("aria-pressed") === "false", null, { timeout: 10_000 });

    // ---- 3. the three surviving kinds still reach the reader ------------------------------------------------
    section("permissions, clarify and collisions each still have a control that opens");
    v = await page.evaluate(READER);
    for (const id of ["btn-permissions", "btn-clarify", "btn-collisions"]) {
      const b = v.buttons[id];
      ok(`#${id} is drawn, wired and names its popover`, b.exists && b.wired === "1" && Boolean(b.controls), JSON.stringify(b));
    }
    for (const [btn, pop] of [
      ["btn-permissions", "permissions-pop"],
      ["btn-clarify", "clarify-pop"],
      ["btn-collisions", "collisions-pop"],
    ]) {
      await page.click(`#${btn}`);
      await page.waitForFunction((id) => document.getElementById(id)?.hidden === false, pop, { timeout: 15_000 });
      const after = await page.evaluate(READER);
      const p = after.popovers[pop];
      ok(`#${btn}'s press opens #${pop}`, p.exists && p.hidden === false && p.w !== 0, JSON.stringify(p));
      ok(`…and it is inside the viewport`, p.x >= 0 && p.right <= after.viewport.width + 1 && p.y >= 0 && p.bottom <= after.viewport.height + 1, JSON.stringify({ pop: p, viewport: after.viewport }));
      await page.keyboard.press("Escape");
      await page.waitForFunction((id) => document.getElementById(id)?.hidden === true, pop, { timeout: 10_000 });
    }

    // ---- 4. H does nothing, and raises nothing ---------------------------------------------------------------
    section("H is not a shortcut any more");
    const beforeH = await page.evaluate(() => ({
      rows: document.querySelectorAll("tr.row[data-key]").length,
      pops: [...document.querySelectorAll("#permissions-pop, #clarify-pop, #collisions-pop")].filter((p) => !p.hidden).length,
      rings: document.querySelectorAll(".human-flash").length,
      url: location.href,
    }));
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press("h");
    await page.keyboard.press("H");
    await sleep(300);
    const afterH = await page.evaluate(() => ({
      rows: document.querySelectorAll("tr.row[data-key]").length,
      pops: [...document.querySelectorAll("#permissions-pop, #clarify-pop, #collisions-pop")].filter((p) => !p.hidden).length,
      rings: document.querySelectorAll(".human-flash").length,
      url: location.href,
    }));
    eq("H opens nothing, flashes nothing and does not move the page", afterH, beforeH);
    ok("…and the page raised no error for it", pageErrors.length === 0, pageErrors.join(" | "));

    // ---- 5. no Settings tab points at a button that is not there ---------------------------------------------
    section("the settings strip has no dangling tab");
    await page.click("#btn-settings");
    await page.waitForSelector("#settings:not(.hidden)", { timeout: 10_000 });
    v = await page.evaluate(READER);
    ok("the strip still carries its tabs", v.tabs.length >= 10, String(v.tabs.length));
    ok("…none of them is Human", v.tabs.every((t) => t.label !== "Human" && t.id !== "settings-tab-human"), v.tabs.map((t) => t.label).join(" "));
    ok("…and every tab names a panel that exists", v.tabs.every((t) => t.panelThere), v.tabs.filter((t) => !t.panelThere).map((t) => t.id).join(" "));
    // Two tabs still open their own panel: the first and the last, so the strip is driven at both ends.
    for (const t of [v.tabs[0], v.tabs[v.tabs.length - 1]]) {
      await page.click(`#${t.id}`);
      await page.waitForFunction((id) => document.getElementById(id)?.getAttribute("aria-selected") === "true", t.id, { timeout: 10_000 });
      const shown = await page.evaluate((panelId) => !document.getElementById(panelId)?.hidden, t.controls);
      ok(`#${t.id} opens its own panel`, shown === true, t.controls);
    }
    await page.click("#btn-settings-close");
    await page.waitForFunction(() => document.getElementById("settings")?.classList.contains("hidden") === true, null, { timeout: 10_000 });

    // ---- 6. the header at 1440x900 and at 768x900 ------------------------------------------------------------
    section("the header at 1440x900 and at 768x900");
    for (const [width, height] of [
      [1440, 900],
      [768, 900],
    ]) {
      await page.setViewportSize({ width, height });
      await sleep(250);
      const w = await page.evaluate(READER);
      const lay = layoutVerdict(w);
      ok(`at ${width}: no control is outside the viewport`, lay.outside.length === 0, JSON.stringify(lay.outside));
      ok(`at ${width}: the page does not scroll sideways`, lay.scrollX === false, `scrollWidth ${w.scrollWidth} vs ${w.viewport.width}`);
      ok(`at ${width}: no two controls overlap`, lay.overlaps.length === 0, lay.overlaps.join(", "));
      ok(`at ${width}: every control is inside the header it sits in`, lay.clipped.length === 0, JSON.stringify(lay.clipped));
      // A header that wraps at a narrow width is not a defect; one that eats the top quarter of the window, or that has
      // lost a control to a clip, is. The measured height is printed with every pass either way.
      ok(`at ${width}: the header leaves the board most of the window`, lay.headerHeight > 20 && lay.headerHeight < w.viewport.height * 0.25, `${lay.headerHeight}px of ${w.viewport.height}px`);
      ok(`at ${width}: the controls are laid out in ${lay.rows} row${lay.rows === 1 ? "" : "s"}`, lay.rows >= 1 && lay.rows <= 3, JSON.stringify(w.visible.map((b) => [b.id, b.x, b.y])));
      const shot = path.join(shotDir, `header-without-human-${width}x${height}.png`);
      await page.screenshot({ path: shot });
      console.log(`SHOT  ${shot}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    ok("the page raised no error during the whole walk", pageErrors.length === 0, pageErrors.join(" | "));
    return failures;
  });
  failures = verdict;
} catch (err) {
  console.log(`FAIL  the harness itself: ${err && err.stack ? err.stack : err}`);
  failures += 1;
} finally {
  if (!keep) await panel.stop?.();
}

console.log(`\n${failures ? "FAILED" : "OK"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
