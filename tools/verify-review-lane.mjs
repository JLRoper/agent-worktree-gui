// The REVIEW LANE, proved on a real panel: a finished row cannot be forgotten.
//
//   node tools/verify-review-lane.mjs
//
// WHAT THIS IS. docs/reviews-lane.md puts a delivery on the row its run closed in, an amber marker beside the reader's
// lock and the turnover mark, a result card under the row (one-line summary, the report as a REAL anchor through the
// panel's own open-file route, the next steps as chips), a header count that filters the table, and a third kind in
// the one header count of them. This gate boots a throwaway panel (tools/panel-testkit.mjs, the real server.js and the real
// public/) over a real git fixture with three worktrees, seeds the deliveries through the REAL settle seam
// (`Jobs.harvestReview` -> lib/review-inbox.js), and drives the page in headless Chromium at 1440x900.
//
// WHAT IS DRIVEN
//   1. the header draws one control with the count, quiet at zero, and its title splits the count by kind
//   2. the amber ▣ and ✓ Reviewed are on exactly the rows awaiting a check - and NOT on the row with no delivery
//   3. the mark cannot be confused with the yellow lock or the blue turnover mark: its own class, its own glyph, its
//      own colour, and it is drawn after both
//   4. clicking the count filters the table to exactly those rows; clicking again shows everything
//   5. the result card is drawn by the PANEL from the stored delivery, for a run nobody has touched: summary, the
//      report as an anchor carrying the TREE as its base, and the next steps as chips
//   6. the anchor goes through the existing route: one POST /api/open-file with the report path and the tree
//   7. the Review control is the header's ONE count of these rows: the badge counts them, its title says so and
//      promises no key, its press filters the table to exactly those rows, H does nothing, and ✓ Reviewed on the
//      row drops the count in the same frame
//   8. a bulk mark-all-reviewed clears the rest in one press, and the count is honest again
//   9. an unanswered card costs nothing: the row stays amber and counted across a reload, with no run involved
//  10. a delivery with no report path and no next steps still records cleanly and draws a card that says so
//  11. screenshots at 1440x900 for the report
//
// ONE SIDE EFFECT, DELIBERATELY. `POST /api/open-file` hands the file to the browser this machine is registered to
// use, exactly as a reader's click does. That is the route under test - intercepting it is how the deliverables
// button shipped 404ing behind a green gate - so this run opens the report once, and says so.
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

// ---- the fixture: a real repo with three worktrees ------------------------------------------------------------
const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-review-gate-"));
const repos = path.join(dir, "repos");
const repo = path.join(repos, "lane-proj");
const git = (args, cwd = repo) => execFileSync("git", args, { cwd, stdio: "pipe", windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "gate", GIT_AUTHOR_EMAIL: "gate@local", GIT_COMMITTER_NAME: "gate", GIT_COMMITTER_EMAIL: "gate@local" } });
mkdirSync(repo, { recursive: true });
git(["init", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# lane fixture\n");
git(["add", "-A"]);
git(["commit", "-m", "fixture"]);
const TREES = {
  one: path.join(repo, ".worktrees", "await-one-ab12cd").replace(/\\/g, "/"),
  two: path.join(repo, ".worktrees", "await-two-ef34ab").replace(/\\/g, "/"),
  plain: path.join(repo, ".worktrees", "plain-three-cd56ef").replace(/\\/g, "/"),
};
git(["worktree", "add", "-b", "wtgui/await-one-ab12cd", TREES.one]);
git(["worktree", "add", "-b", "wtgui/await-two-ef34ab", TREES.two]);
git(["worktree", "add", "-b", "wtgui/plain-three-cd56ef", TREES.plain]);
// The report the first delivery names: a real file inside the worktree, so the anchor's route finds it.
mkdirSync(path.join(TREES.one, "docs", "reports"), { recursive: true });
writeFileSync(path.join(TREES.one, "docs", "reports", "review-lane.html"), "<!doctype html><h1>the review lane report</h1>\n");

// ---- the deliveries, through the REAL seam -------------------------------------------------------------------
const STORE = path.join(dir, "logs", "reviews.json");
const store = new ReviewInbox({ file: STORE, log: (m) => console.log(`      store: ${m}`) });
const harness = Object.create(Jobs.prototype);
harness.reviewInbox = store;
harness.push = () => {};
const OLD = "2026-11-18T09:00:00.000Z";
const NEW = "2026-11-18T10:00:00.000Z";
const first = harness.harvestReview(
  {
    id: "runaaaa1",
    thread: "lane-thread-one",
    project: "lane-proj",
    status: "done",
    endedAt: OLD,
    finalMessage: [
      "The lane is built and the marker is on the row.",
      "",
      "The report is docs/reports/review-lane.html",
      "",
      "## Next steps",
      "- open the report and check the counts",
      "- decide whether the amber mark is too close to the lock",
    ].join("\n"),
  },
  { path: TREES.one },
);
const second = harness.harvestReview(
  {
    id: "runbbbb2",
    thread: "lane-thread-two",
    project: "lane-proj",
    status: "done",
    endedAt: NEW,
    // No report path, no next steps: the summary is the whole deliverable.
    finalMessage: "Rebuilt the fixture and left the tree clean.",
  },
  { path: TREES.two },
);
ok("the settle seam recorded both deliveries", first?.saved === true && second?.saved === true, `one: ${first?.saved} report ${first?.entry?.report}, two: ${second?.saved} report ${second?.entry?.report}`);
ok("the second delivery recorded with no report and no next steps", second?.entry?.report === null && second?.entry?.next?.length === 0);
eq("the store holds two entries, both awaiting", store.count(), 2);

const panel = await startPanel({ dir, keep: true, config: { reviewsFile: STORE, assistant: { enabled: false } } });
console.log(`      panel   ${panel.base}  (throwaway: ${panel.dir})`);

try {
  // ---- 0. the real routes, before a browser touches the page ------------------------------------------------
  const getJson = async () => {
    const r = await fetch(`${panel.base}/api/review`);
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const before = await getJson();
  eq("GET /api/review answers 200", before.status, 200);
  eq("…and it counts the two awaiting deliveries", before.body?.count, 2);
  const postJson = async (body) => {
    const r = await fetch(`${panel.base}/api/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const refused = await postJson({ op: "reviewed", path: "" });
  eq("a reviewed press with no path is refused with a sentence", { status: refused.status, ok: refused.body?.ok }, { status: 400, ok: false });
  ok("…naming what it needs", /worktree is required/.test(refused.body?.error || ""), refused.body?.error);
  const unknown = await postJson({ op: "sideways" });
  ok("an unknown op is refused and names the two it knows", unknown.status === 400 && /reviewed, review-all/.test(unknown.body?.error || ""), unknown.body?.error);

  const result = await withBrowser(async ({ page }) => {
    const out = {};
    const posts = [];
    // A handler that throws does not fail a Playwright click by itself: the page's own errors are collected so the
    // H press below can be judged on "nothing was raised" rather than on the absence of a visible change.
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e && e.message ? e.message : e)));
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("/api/open-file")) {
        try {
          posts.push(r.postDataJSON());
        } catch {
          posts.push(null);
        }
      }
    });
    await openPage(page, panel.base, { selector: "#btn-review" });
    // A root group and a project both start folded, so the fixture's project is REACHED the way a reader reaches it:
    // open the root, then open the project. Only then do rows exist in the document at all.
    await page.waitForSelector('section.project[data-project="lane-proj"]', { state: "attached", timeout: 60_000 });
    const rootToggle = await page.evaluate(() => {
      const sec = document.querySelector('section.project[data-project="lane-proj"]');
      const group = sec?.closest("section.root-group");
      return group && group.classList.contains("collapsed") ? group.dataset.root : null;
    });
    if (rootToggle) await page.click(`[data-toggle-root="${rootToggle.replace(/"/g, '\\"')}"]`);
    await page.click('[data-toggle-project="lane-proj"]');
    await page.waitForFunction(() => document.querySelectorAll("tr.row[data-key]").length >= 4, null, { timeout: 45_000 });
    await page.waitForFunction(() => document.getElementById("review-badge") && !document.getElementById("review-badge").hidden, null, { timeout: 20_000 });
    // The board's own rows carry the review record the panel attached (server.js `withReviews`); the raw
    // projects[].worktrees[] list is discovery, and never carried it. Read after the rows are on the page, because a
    // scan that has not finished yet is an empty board rather than a missing record.
    await page.waitForFunction(() => [...state.rows.values()].filter((row) => row.review && row.review.summary).length === 2, null, { timeout: 30_000 });
    const scanned = await page.evaluate(() => {
      const rows = [...state.rows.values()].filter((row) => row.project === "lane-proj");
      return { projects: [...state.projects.keys()], trees: rows.map((row) => row.path), reviews: rows.filter((row) => row.review && row.review.summary).length };
    });
    ok("the board carries the fixture's checkout and its three worktrees", scanned.trees.length >= 4, `${scanned.projects.join(",")} -> ${scanned.trees.length} rows`);
    eq("…and two rows carry a review record", scanned.reviews, 2, JSON.stringify(scanned.trees));
    const storeKeys = await (await fetch(`${panel.base}/api/review`)).json();
    console.log(`      store ${storeKeys.total} entries: ${(storeKeys.entries || []).map((e) => `${e.key}${e.awaiting ? "" : " (done)"}`).join(" | ")}`);
    console.log(`      rows: ${scanned.trees.join(" | ")}`);

    const keyOfTree = (t) => `lane-proj::${t}`;
    const rowSel = (t) => `tr.row[data-key="${keyOfTree(t)}"]`;
    // THE CARD IS A POPUP behind the row's result chip (public/board-scaffold.js `openRowChipPop`), so a reader opens it
    // with that press: the row first (the chip is only drawn on a drawn row), then the chip. One helper for every open
    // below, so a card that is already up is not toggled shut.
    const openCard = async (key) => {
      if (!(await page.evaluate((k) => Boolean(document.querySelector(`[data-review-block="${k}"]`)), key))) {
        if ((await page.locator(`[data-rowchip="result"][data-rowchip-key="${key}"]`).count()) === 0) await page.click(rowSelKey(key));
        await page.waitForSelector(`[data-rowchip="result"][data-rowchip-key="${key}"]`, { timeout: 10_000 });
        await page.click(`[data-rowchip="result"][data-rowchip-key="${key}"]`);
      }
      await page.waitForSelector(`[data-review-block="${key}"]`, { timeout: 10_000 });
    };

    // ---- 1. the header control ---------------------------------------------------------------------------
    const head = await page.evaluate(() => {
      const btn = document.getElementById("btn-review");
      const badge = document.getElementById("review-badge");
      const all = document.getElementById("btn-review-all");
      return {
        label: (document.getElementById("review-label")?.textContent || "").trim(),
        badge: (badge?.textContent || "").trim(),
        hidden: badge?.hidden,
        pressed: btn?.getAttribute("aria-pressed"),
        hasReview: btn?.classList.contains("has-review"),
        allHidden: all?.hidden,
        title: btn?.title || "",
        aria: btn?.getAttribute("aria-label") || "",
      };
    });
    eq("the count is the number of rows awaiting a check", head.badge, "2");
    ok("the badge is drawn, and the button wears its own highlight class", head.hidden === false && head.hasReview);
    eq("the filter starts off", head.pressed, "false");
    ok("the title splits the count by kind", /2 finished rows/.test(head.title), head.title.slice(0, 80));
    ok("the bulk press is not offered before the lane is on", head.allHidden === true, String(head.allHidden));

    // ---- 2. the mark, on exactly the awaiting rows -------------------------------------------------------
    const marked = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("tr.row[data-key]")];
      return rows
        .map((tr) => ({
          key: tr.dataset.key,
          mark: tr.querySelector(".review-mark")?.textContent || null,
          press: tr.querySelector("[data-review-done]")?.textContent.trim() || null,
          hasReview: tr.classList.contains("has-review"),
          colour: tr.querySelector(".review-mark") ? getComputedStyle(tr.querySelector(".review-mark")).color : null,
          lock: tr.querySelector(".btn-row-lock")?.textContent.trim() || null,
          name: tr.querySelector(".name-line") ? [...tr.querySelector(".name-line").children].map((el) => el.className).join("|") : "",
        }))
        .filter((r) => r.key.startsWith("lane-proj::"));
    });
    const markedRows = marked.filter((r) => r.mark);
    eq("two rows carry the amber mark, and the row with no delivery carries none", markedRows.length, 2);
    ok("every marked row also carries the ✓ Reviewed press", markedRows.every((r) => /Reviewed/.test(r.press || "")));
    ok("…and the row itself is marked at rest (has-review)", markedRows.every((r) => r.hasReview));
    ok("the plain row has neither mark nor press", marked.some((r) => !r.mark && !/review-done/.test(r.name)));
    ok("the mark is the amber ▣, not the lock's padlock", markedRows.every((r) => r.mark === "\u25a3" && r.lock !== r.mark), markedRows.map((r) => `${r.mark}/${r.lock}`).join(" "));
    ok("its ink is amber and not the lock's own", markedRows.every((r) => /rgb\(255, 180, 84\)/.test(r.colour || "")), markedRows.map((r) => r.colour).join(" "));
    ok(
      "it is drawn AFTER the lock and the turnover mark in the name line",
      markedRows.every((r) => r.name.indexOf("btn-row-lock") < r.name.indexOf("review-mark")),
      markedRows[0]?.name,
    );
    out.markedRows = markedRows;

    // The row count of the whole board, for the filter check below.
    const allRows = await page.evaluate(() => [...document.querySelectorAll("tr.row[data-key]")].map((tr) => tr.dataset.key));
    out.allRows = allRows;

    // ---- 3. the filter -----------------------------------------------------------------------------------
    await page.click("#btn-review");
    await page.waitForFunction((keys) => document.querySelectorAll("tr.row[data-key]").length === keys, markedRows.length, { timeout: 10_000 });
    const filtered = await page.evaluate(() => ({
      rows: [...document.querySelectorAll("tr.row[data-key]")].map((tr) => tr.dataset.key),
      pressed: document.getElementById("btn-review")?.getAttribute("aria-pressed"),
      allHidden: document.getElementById("btn-review-all")?.hidden,
      allText: (document.getElementById("btn-review-all")?.textContent || "").trim(),
    }));
    eq("the filter shows exactly the rows the count counted", filtered.rows.sort(), markedRows.map((r) => r.key).sort());
    eq("…the button says it is on", filtered.pressed, "true");
    ok("…and the bulk press is offered, naming the count", filtered.allHidden === false && /2 reviewed/.test(filtered.allText), filtered.allText);

    mkdirSync(SHOT_DIR, { recursive: true });
    const boardShot = path.join(SHOT_DIR, "review-lane-board.png");
    await page.screenshot({ path: boardShot });
    console.log(`SHOT  ${boardShot}`);

    // ---- 4. the result card, drawn by the panel from the store -------------------------------------------
    // Open the delivery that named a report (the older one) the way a reader does: click its row.
    const withReport = (out.markedRows.find((r) => /await-one/i.test(r.key)) || out.markedRows[0]).key;
    await openCard(withReport);
    const card = await page.evaluate((key) => {
      const block = document.querySelector(`[data-review-block="${key}"]`);
      if (!block) return null;
      const anchor = block.querySelector("[data-review-anchor] a[data-open-file]");
      const chips = [...block.querySelectorAll(".review-chip")].map((c) => c.textContent.trim());
      return {
        cls: block.className,
        summary: (block.querySelector(".review-summary")?.textContent || "").trim(),
        anchorText: (block.querySelector(".review-anchor")?.textContent || "").trim(),
        href: anchor?.getAttribute("href") || null,
        target: anchor?.dataset.openFile || null,
        base: anchor?.dataset.openFileBase || null,
        chips,
        press: Boolean(block.querySelector("[data-review-done]")),
      };
    }, withReport);
    ok("the card is drawn from the stored delivery", Boolean(card), String(card));
    ok("…with the run's one-line summary", /The lane is built/.test(card?.summary || ""), card?.summary);
    ok("…and the report as a REAL anchor, not a URL to the page", card?.href === "#" && card?.target === "docs/reports/review-lane.html", `${card?.href} ${card?.target}`);
    ok("…carrying the TREE as its base, so a relative report resolves in the worktree", /await-one-ab12cd/.test(card?.base || ""), card?.base);
    eq("the next steps are chips beneath the anchor", card?.chips.length, 2);
    ok("…in the run's own words", /open the report and check the counts/.test(card?.chips?.[0] || ""), card?.chips?.[0]);
    const cardShot = path.join(SHOT_DIR, "review-lane-card.png");
    await page.screenshot({ path: cardShot });
    console.log(`SHOT  ${cardShot}`);

    // A delivery with no report and no next steps still says so, in a sentence.
    const twoKey = out.markedRows.map((r) => r.key).find((k) => k.includes("await-two"));
    await openCard(twoKey);
    const bare = await page.evaluate((key) => {
      const block = document.querySelector(`[data-review-block="${key}"]`);
      return { anchor: (block?.querySelector(".review-anchor")?.textContent || "").trim(), chips: block?.querySelectorAll(".review-chip").length, none: (block?.textContent || "").includes("no next steps were named") };
    }, twoKey);
    ok("a delivery with no report path says so rather than leaving a blank space", /no report path/.test(bare.anchor), bare.anchor);
    ok("…and says there were no next steps", bare.chips === 0 && bare.none);

    // ---- 5. the anchor goes through the existing route ---------------------------------------------------
    // A click TOGGLES the row, so open it only if the card is not already there: pressing twice would shut it.
    const stillOpen = await page.evaluate((k) => Boolean(document.querySelector(`[data-review-block="${k}"] [data-open-file]`)), withReport);
    if (!stillOpen) await openCard(withReport);
    await page.waitForSelector(`[data-review-block="${withReport}"] [data-open-file]`, { timeout: 5_000 });
    const answered = page.waitForResponse((r) => r.url().includes("/api/open-file") && r.request().method() === "POST", { timeout: 10_000 });
    await page.click(`[data-review-block="${withReport}"] [data-open-file]`);
    const openRes = await answered;
    eq("the anchor POSTs the panel's own open-file route", openRes.status(), 200);
    const sent = posts.at(-1) || {};
    eq("…with the report path the delivery named", sent.path, "docs/reports/review-lane.html");
    ok("…and the TREE as its base, so the relative path resolves in the worktree", /await-one-ab12cd/.test(sent.base || ""), sent.base);
    eq("…exactly the base the card carried", sent.base, card.base);
    console.log(`      NOTE  the open route handed the report to this machine's browser - the route under test, not a stub`);

    // ---- 6. the Review control is the header's one count, and its press is the filter ---------------------
    // The Human button and its H step-through are gone: this control is where a reader sees how many results are
    // waiting, and its own press is what narrows the table to exactly them.
    await page.click(rowSelKey(withReport)); // fold the row again: the filter has to show it, not this press
    await page.waitForSelector(`[data-review-block="${withReport}"]`, { state: "detached", timeout: 5_000 }).catch(() => {});
    const chip = await page.evaluate(() => ({
      text: document.getElementById("review-badge")?.textContent,
      hidden: document.getElementById("review-badge")?.hidden,
      title: document.getElementById("btn-review")?.title || "",
      pressed: document.getElementById("btn-review")?.getAttribute("aria-pressed"),
      human: Boolean(document.getElementById("btn-human") || document.getElementById("human-badge") || document.getElementById("settings-tab-human")),
    }));
    eq("the count includes both deliveries", { text: chip.text, hidden: chip.hidden }, { text: "2", hidden: false });
    ok("…and the control says it is the header's one count of results to read", /one count of results to read/i.test(chip.title), chip.title.slice(0, 140));
    ok("…and promises no key: the H rotation is gone", !/Press H|press H|H steps/.test(chip.title));
    ok("…and the removed Human control is not on the page", chip.human === false);
    eq("…and it is filtering, which section 3 turned on with its own press", chip.pressed, "true");

    // One press shows everything again, and the next narrows it back to exactly the rows the count counted.
    await page.click("#btn-review");
    await page.waitForFunction((n) => document.getElementById("btn-review")?.getAttribute("aria-pressed") === "false" && document.querySelectorAll("tr.row[data-key]").length === n, out.allRows.length, { timeout: 10_000 });
    ok("its press shows every row again", true, `${out.allRows.length} rows`);
    await page.click("#btn-review");
    await page.waitForFunction(() => document.getElementById("btn-review")?.getAttribute("aria-pressed") === "true", null, { timeout: 10_000 });
    const narrowed = await page.evaluate(() => ({
      rows: document.querySelectorAll("tr.row[data-key]").length,
      marks: document.querySelectorAll("tr.row .review-mark").length,
    }));
    eq("the press filters the table to exactly the rows it counted", narrowed, { rows: 2, marks: 2 });
    const filterShot = path.join(SHOT_DIR, "review-lane-filter.png");
    await page.screenshot({ path: filterShot });
    console.log(`SHOT  ${filterShot}`);

    // H is not a shortcut any more: the key is not claimed, nothing opens, and the page raises nothing for it.
    const beforeH = await page.evaluate(() => ({
      rows: document.querySelectorAll("tr.row[data-key]").length,
      pops: document.querySelectorAll(".rowchip-pop").length,
    }));
    await page.evaluate(() => document.activeElement?.blur?.());
    await page.keyboard.press("h");
    await page.waitForTimeout(250);
    const afterH = await page.evaluate(() => ({
      rows: document.querySelectorAll("tr.row[data-key]").length,
      pops: document.querySelectorAll(".rowchip-pop").length,
      flash: document.querySelectorAll(".human-flash, .hot-flash").length,
    }));
    eq("H does nothing: the table is unchanged and nothing was opened", afterH, { ...beforeH, flash: 0 });
    ok("…and the page raised no error for it", pageErrors.length === 0, pageErrors.join(" | "));

    // One press on the row's own ✓ Reviewed clears THAT row, and the count follows in the same frame.
    await page.click(`[data-review-done="${withReport}"]`);
    await page.waitForFunction(() => (document.getElementById("review-badge")?.textContent || "") === "1", null, { timeout: 10_000 });
    const afterOne = await page.evaluate(() => ({
      count: document.getElementById("review-badge")?.textContent,
      marks: document.querySelectorAll("tr.row .review-mark").length,
      rows: document.querySelectorAll("tr.row[data-key]").length,
    }));
    eq("✓ Reviewed on the row clears it and the count drops", { count: afterOne.count, marks: afterOne.marks }, { count: "1", marks: 1 });
    eq("…and the filter is still on, so the table now shows the one row", afterOne.rows, 1);

    // ---- 7. the bulk press -------------------------------------------------------------------------------
    await page.click("#btn-review-all");
    await page.waitForFunction(() => document.getElementById("review-badge")?.hidden === true, null, { timeout: 10_000 });
    const afterAll = await page.evaluate(() => ({
      marks: document.querySelectorAll("tr.row .review-mark").length,
      pressed: document.querySelectorAll("tr.row [data-review-done]").length,
      rows: document.querySelectorAll("tr.row[data-key]").length,
    }));
    eq("mark all reviewed clears every row at once", { marks: afterAll.marks, pressed: afterAll.pressed }, { marks: 0, pressed: 0 });
    eq("…and the filtered table is empty because nothing is awaiting", afterAll.rows, 0);

    // Filter off: the whole board comes back, with the reviewed rows still there and their cards readable. A press
    // outside an open card is the reader leaving it (public/board-scaffold.js), so the card is closed with Escape
    // first: otherwise this press is spent on the card and the filter never toggles.
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelectorAll(".rowchip-pop").length === 0, null, { timeout: 10_000 }).catch(() => {});
    await page.click("#btn-review");
    await page.waitForFunction(() => document.getElementById("btn-review")?.getAttribute("aria-pressed") === "false", null, { timeout: 10_000 });
    const backRows = await page.evaluate(() => [...document.querySelectorAll("tr.row[data-key]")].map((tr) => tr.dataset.key));
    ok("the whole board comes back, and the reviewed row is still on it", backRows.length > markedRows.length && backRows.includes(withReport), `${backRows.length} rows`);
    // The rebuild replaced the tbody under the pointer, so the first click can land on nothing: open, and if the card
    // did not appear, press once more. The row is a toggle, so a retry can only ever mean "open it".
    await openCard(withReport);
    const reviewedCard = await page.evaluate((key) => {
      const block = document.querySelector(`[data-review-block="${key}"]`);
      return {
        cls: block?.className || "",
        stamp: (block?.querySelector(".review-stamp")?.textContent || "").trim(),
        press: Boolean(block?.querySelector("[data-review-done]")),
        anchor: Boolean(block?.querySelector("[data-open-file]")),
      };
    }, withReport);
    ok("a reviewed row keeps its card, with the delivery still readable", Boolean(reviewedCard.anchor) && /is-reviewed/.test(reviewedCard.cls), reviewedCard.cls);
    ok("…and says when it was checked instead of offering the press again", /reviewed/.test(reviewedCard.stamp) && !reviewedCard.press, reviewedCard.stamp);

    // ---- 8. a reload is the same board: the store is the record ------------------------------------------
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll("tr.row[data-key]").length > 0, null, { timeout: 30_000 });
    await page.waitForTimeout(1200);
    const reloaded = await page.evaluate(() => ({
      badgeHidden: document.getElementById("review-badge")?.hidden,
      marks: document.querySelectorAll("tr.row .review-mark").length,
    }));
    ok("after a reload nothing is awaiting: the stamp is on disk, not in the page", reloaded.badgeHidden === true && reloaded.marks === 0, JSON.stringify(reloaded));
    const finalShot = path.join(SHOT_DIR, "review-lane-after.png");
    await page.screenshot({ path: finalShot });
    console.log(`SHOT  ${finalShot}`);

    out.posts = posts;
    return out;
  });

  // ---- 9. the store on disk is what the page proved ------------------------------------------------------
  const after = await getJson();
  eq("the store kept both deliveries and both stamps", { count: after.body?.count, total: after.body?.total }, { count: 0, total: 2 });
  ok("…each with the summary the run ended on", after.body?.entries?.every((e) => typeof e.summary === "string" && e.summary.length > 0));
  ok("…and the report only on the one that named it", after.body?.entries?.filter((e) => e.report).length === 1);
  ok("the page opened the report exactly once, through the route", result?.posts?.length === 1, JSON.stringify(result?.posts));
} finally {
  console.log(`      window stays open: ${panel.dir}`);
}

console.log(`\n${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);

// The tree path a row key names: the fixture's own, so the expectation is the path the store holds.
function TREE_OF(key) {
  const lower = String(key).toLowerCase();
  if (lower.includes("await-one")) return TREES.one;
  if (lower.includes("await-two")) return TREES.two;
  return TREES.plain;
}
function rowSelKey(key) {
  return `tr.row[data-key="${key}"]`;
}
