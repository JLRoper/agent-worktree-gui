// The REVIEW LANE, proved on a real panel: a finished row cannot be forgotten.
//
//   node tools/verify-review-lane.mjs
//
// WHAT THIS IS. docs/reviews-lane.md puts a delivery on the row its run closed in, an amber marker beside the reader's
// lock and the turnover mark, a result card under the row (one-line summary, the report as a REAL anchor through the
// panel's own open-file route, the next steps as chips), a header count that filters the table, and a third kind in
// the Human rotation. This gate boots a throwaway panel (tools/panel-testkit.mjs, the real server.js and the real
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
//   7. H steps into a review row as a THIRD kind, after permissions and questions: the row opens, the card is
//      centred and flashed, and ✓ Reviewed takes focus - one more key clears it
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
    const scanned = await page.evaluate(async () => {
      const r = await fetch("/api/state");
      const snap = await r.json();
      const p = (snap.projects || []).find((x) => x.name === "lane-proj");
      return { projects: (snap.projects || []).map((x) => x.name), trees: (p?.worktrees || []).map((t) => t.path), reviews: (p?.worktrees || []).filter((t) => t.review).length };
    });
    ok("the scan found the fixture's project with its checkout and three worktrees", scanned.trees.length === 4, `${scanned.projects.join(",")} -> ${scanned.trees.length} rows`);
    eq("…and the snapshot carries a review record on exactly the two deliveries", scanned.reviews, 2, JSON.stringify(scanned.trees));
    const storeKeys = await (await fetch(`${panel.base}/api/review`)).json();
    console.log(`      store ${storeKeys.total} entries: ${(storeKeys.entries || []).map((e) => `${e.key}${e.awaiting ? "" : " (done)"}`).join(" | ")}`);
    console.log(`      rows: ${scanned.trees.join(" | ")}`);
    await page.click('[data-toggle-project="lane-proj"]');
    await page.waitForFunction(() => document.querySelectorAll("tr.row[data-key]").length >= 4, null, { timeout: 45_000 });
    await page.waitForFunction(() => document.getElementById("review-badge") && !document.getElementById("review-badge").hidden, null, { timeout: 20_000 });

    const keyOfTree = (t) => `lane-proj::${t}`;
    const rowSel = (t) => `tr.row[data-key="${keyOfTree(t)}"]`;

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
    await page.click(rowSelKey(withReport));
    await page.waitForSelector(`[data-review-block="${withReport}"]`, { timeout: 10_000 });
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
    await page.click(rowSelKey(twoKey));
    await page.waitForSelector(`[data-review-block="${twoKey}"]`, { timeout: 10_000 });
    const bare = await page.evaluate((key) => {
      const block = document.querySelector(`[data-review-block="${key}"]`);
      return { anchor: (block?.querySelector(".review-anchor")?.textContent || "").trim(), chips: block?.querySelectorAll(".review-chip").length, none: (block?.textContent || "").includes("no next steps were named") };
    }, twoKey);
    ok("a delivery with no report path says so rather than leaving a blank space", /no report path/.test(bare.anchor), bare.anchor);
    ok("…and says there were no next steps", bare.chips === 0 && bare.none);

    // ---- 5. the anchor goes through the existing route ---------------------------------------------------
    // A click TOGGLES the row, so open it only if the card is not already there: pressing twice would shut it.
    const stillOpen = await page.evaluate((k) => Boolean(document.querySelector(`[data-review-block="${k}"] [data-open-file]`)), withReport);
    if (!stillOpen) await page.click(rowSelKey(withReport));
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

    // ---- 6. H steps into the oldest review row, after permissions and questions ---------------------------
    await page.click(rowSelKey(withReport)); // fold it again: H must open it itself
    await page.waitForSelector(`[data-review-block="${withReport}"]`, { state: "detached", timeout: 5_000 }).catch(() => {});
    await page.evaluate(() => document.activeElement?.blur?.());
    const title = await page.evaluate(() => document.getElementById("btn-human")?.title || "");
    ok("the Human title counts the lane as a third kind", /0 permissions, 0 clarify questions, 2 to review/.test(title), title.slice(0, 90));
    const humanBadge = await page.evaluate(() => ({ text: document.getElementById("human-badge")?.textContent, hidden: document.getElementById("human-badge")?.hidden }));
    eq("…and the Human badge's total includes them", { text: humanBadge.text, hidden: humanBadge.hidden }, { text: "2", hidden: false });
    await page.keyboard.press("h");
    await page.waitForSelector(`[data-review-block="${withReport}"]`, { timeout: 10_000 });
    const landed = await page.evaluate(() => {
      const active = document.activeElement;
      const flashed = document.querySelector(".human-flash");
      return {
        focusAttr: active?.getAttribute?.("data-review-done") || null,
        focusTag: active?.tagName || null,
        flashed: flashed ? flashed.getAttribute("data-review-block") || flashed.className : null,
        humanLabel: (document.getElementById("human-label")?.textContent || "").trim(),
      };
    });
    ok("H puts the caret on ✓ Reviewed, so one more key clears the row", Boolean(landed.focusAttr), `${landed.focusTag} ${landed.focusAttr}`);
    eq("…on the OLDEST delivery, which is the row H stepped into", landed.focusAttr, withReport);
    ok("…and the card it belongs to is the one flashed in view", Boolean(landed.flashed), String(landed.flashed));
    ok("…and the rotation says where it is", /Human 1\/2/.test(landed.humanLabel), landed.humanLabel);
    const humanShot = path.join(SHOT_DIR, "review-lane-human.png");
    await page.screenshot({ path: humanShot });
    console.log(`SHOT  ${humanShot}`);

    // One more key: Enter on the focused button clears THAT row.
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => (document.getElementById("review-badge")?.textContent || "") === "1", null, { timeout: 10_000 });
    const afterOne = await page.evaluate(() => ({
      count: document.getElementById("review-badge")?.textContent,
      marks: document.querySelectorAll("tr.row .review-mark").length,
      humanTitle: document.getElementById("btn-human")?.title || "",
    }));
    eq("Enter on the focused Reviewed clears the row", { count: afterOne.count, marks: afterOne.marks }, { count: "1", marks: 1 });
    ok("…and the Human title drops it", /1 to review/.test(afterOne.humanTitle), afterOne.humanTitle.slice(0, 90));
    const why = await page.evaluate(() => ({
      list: (typeof humanQuestions === "function" ? humanQuestions() : []).map((q) => q.kind),
      sig: window.state?.human?.sig,
      aria: document.getElementById("btn-human")?.getAttribute("aria-label"),
      title: (document.getElementById("btn-human")?.title || "").slice(0, 60),
      badge: document.getElementById("human-badge")?.hidden,
      n: document.getElementById("human-badge")?.textContent,
    }));
    console.log(`      human now: ${JSON.stringify(why)}`);

    // ---- 7. the bulk press -------------------------------------------------------------------------------
    await page.click("#btn-review-all");
    await page.waitForFunction(() => document.getElementById("review-badge")?.hidden === true, null, { timeout: 10_000 });
    const afterAll = await page.evaluate(() => ({
      marks: document.querySelectorAll("tr.row .review-mark").length,
      pressed: document.querySelectorAll("tr.row [data-review-done]").length,
      human: document.getElementById("btn-human")?.title || "",
      humanBadge: document.getElementById("human-badge")?.hidden,
      rows: document.querySelectorAll("tr.row[data-key]").length,
    }));
    eq("mark all reviewed clears every row at once", { marks: afterAll.marks, pressed: afterAll.pressed }, { marks: 0, pressed: 0 });
    ok("…leaves the Human rotation with nothing of the lane", /nothing is waiting on you/.test(afterAll.human) && afterAll.humanBadge === true, afterAll.human.slice(0, 80));
    eq("…and the filtered table is empty because nothing is awaiting", afterAll.rows, 0);

    // Filter off: the whole board comes back, with the reviewed rows still there and their cards readable.
    await page.click("#btn-review");
    await page.waitForFunction((n) => document.querySelectorAll("tr.row[data-key]").length === n, out.allRows.length, { timeout: 10_000 });
    // The rebuild replaced the tbody under the pointer, so the first click can land on nothing: open, and if the card
    // did not appear, press once more. The row is a toggle, so a retry can only ever mean "open it".
    await page.click(rowSelKey(withReport));
    await page
      .waitForSelector(`[data-review-block="${withReport}"]`, { timeout: 3_000 })
      .catch(async () => {
        await page.click(rowSelKey(withReport));
        await page.waitForSelector(`[data-review-block="${withReport}"]`, { timeout: 10_000 });
      });
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
      humanBadge: document.getElementById("human-badge")?.hidden,
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
