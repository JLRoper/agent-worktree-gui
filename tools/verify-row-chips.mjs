// tools/verify-row-chips.mjs - the result card and the collision card as ONE-LINE chips, driven in a real browser
// against a real panel at 1440x900.
//
//   node tools/verify-row-chips.mjs
//   node tools/verify-row-chips.mjs --shots <dir>
//
// WHAT THIS IS. Both cards used to be blocks in the row's detail: two paragraphs of height that only existed once the
// reader had opened the row they were deciding whether to open. They are chips in the row's existing strip now, and the
// cards are popups behind them. This gate boots a throwaway panel (tools/panel-testkit.mjs - the real server.js and the
// real public/) over a real git fixture with three worktrees, seeds BOTH surfaces through their real seams
// (`Jobs.harvestReview` -> lib/review-inbox.js, `Jobs.harvestCollisions` -> lib/collisions.js) and drives the page in
// headless Chromium.
//
// WHAT IS DRIVEN AND WHY EACH ONE MATTERS
//   1. both chips are IN the row's existing name line - the strip that already carries the marks - so they are not a
//      second line: the row's own height does not move when the chips are hidden, and the name line does not overflow
//   2. collapsed, the result chip reads the first clause of the summary, the age and (on a checked delivery)
//      "reviewed"; it carries NO chevron and NO absolute path, and nothing is in the DOM until it is pressed
//   3. collapsed, the collision chip carries the pair count - and the count is the ROW's: 1 open on the two rows of a
//      detected pair, 0 open . 1 resolved on the row whose pair the reader has ruled
//   4. pressing the result chip opens the card behind it - the whole paragraph, the report as a real anchor through
//      the panel's own open-file route with the TREE as its base, and the next steps the run named
//   5. pressing the collision chip closes that card and opens the pair card - one card at a time, and the pair card
//      names both sides and carries the ruling
//   6. A REPAINT DOES NOT SLAM IT SHUT: the page's own `renderProjectRows` rebuilds every row and its chips, and the
//      open card is still there, still anchored to the row's NEW chip, still `aria-expanded="true"`
//   7. Escape closes it, hands the caret back to the chip, and forgets the expansion
//   8. a reviewed delivery says so in its chip - the check is in the collapsed text, not behind the expansion
//   9. the expansion is REMEMBERED: a card opened before a reload comes back open, on the row's own chip
//  10. a row whose every pair is resolved wears the MUTED chip and a faded mark, and a row with an open pair still
//      wears the violet one - the accent is the open pairs' alone, on the chip and on the mark
//  11. screenshots at 1440x900: both collapsed, one expanded, and the collision count
//
// NO SIDE EFFECT: nothing here presses a route that opens a file on the reader's desktop. The report anchor is
// asserted by its attributes, not by pressing it.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright, withBrowser, openPage } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";
import { Jobs } from "../lib/jobs.js";
import { ReviewInbox } from "../lib/review-inbox.js";
import { CollisionBook, COLLISION_PASS_MS } from "../lib/collisions.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const SHOT_DIR = opt("--shots", process.env.PANEL_SHOT_DIR || path.join(HERE, "..", ".shots"));

let checks = 0;
let failures = 0;
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` - ${extra}` : ""}`);
  }
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want), got === want ? String(got) : `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const section = (name) => console.log(`\n-- ${name}`);

const playwright = loadPlaywright({ root: path.join(HERE, "..") });
if (!playwright) {
  console.log("BROWSER-HALF-NOT-RUN  no Playwright install found - set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright");
  process.exit(2);
}

// ---- the fixture: one project, three worktrees, one shared file dirty in two of them -----------------------------
const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-rowchips-"));
const repos = path.join(dir, "repos");
const repo = path.join(repos, "chip-proj");
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
writeFileSync(path.join(repo, "README.md"), "# chips fixture\n");
mkdirSync(path.join(repo, "lib"), { recursive: true });
writeFileSync(path.join(repo, "lib", "shared.js"), "export const shared = 1;\n");
git(["add", "-A"]);
git(["commit", "-m", "fixture"]);
const ONE = path.join(repo, ".worktrees", "chip-one-aaaa").replace(/\\/g, "/");
const TWO = path.join(repo, ".worktrees", "chip-two-bbbb").replace(/\\/g, "/");
const THREE = path.join(repo, ".worktrees", "chip-three-cccc").replace(/\\/g, "/");
git(["worktree", "add", "-b", "wtgui/chip-one", ONE]);
git(["worktree", "add", "-b", "wtgui/chip-two", TWO]);
git(["worktree", "add", "-b", "wtgui/chip-three", THREE]);
// The ordinary shared-file collision: the same file, uncommitted, in two trees. The scan proves this pair by itself.
writeFileSync(path.join(ONE, "lib", "shared.js"), "export const shared = 'one';\n");
writeFileSync(path.join(TWO, "lib", "shared.js"), "export const shared = 'two';\n");
// The report the first delivery names: a real file inside the worktree, so the anchor's route would find it.
mkdirSync(path.join(ONE, "docs", "reports"), { recursive: true });
writeFileSync(path.join(ONE, "docs", "reports", "row-chips.html"), "<!doctype html><h1>the row chips report</h1>\n");

// ---- the result side: two deliveries through the REAL settle seam ----------------------------------------------
const REVIEW_STORE = path.join(dir, "logs", "reviews.json");
const inbox = new ReviewInbox({ file: REVIEW_STORE, log: (m) => console.log(`      store: ${m}`) });
const jobs = Object.create(Jobs.prototype);
jobs.reviewInbox = inbox;
jobs.push = () => {};
const delivered = jobs.harvestReview(
  {
    id: "runchip001",
    thread: "chip-thread-one",
    project: "chip-proj",
    status: "done",
    endedAt: "2026-11-18T09:00:00.000Z",
    finalMessage: [
      "Both cards became one-line chips in the row's own strip. The tall blocks are gone and the detail is unchanged.",
      "",
      "The report is docs/reports/row-chips.html",
      "",
      "## Next steps",
      "- check the count on the collision chip",
      "- confirm a repaint leaves an open card open",
    ].join("\n"),
  },
  { path: ONE },
);
ok(
  "the settle seam recorded the first delivery with its report and its two next steps",
  delivered?.saved === true && delivered?.entry?.report === "docs/reports/row-chips.html" && delivered?.entry?.next?.length === 2,
  `report ${delivered?.entry?.report}, next ${delivered?.entry?.next?.length}`,
);
const second = jobs.harvestReview(
  {
    id: "runchip002",
    thread: "chip-thread-two",
    project: "chip-proj",
    status: "done",
    endedAt: "2026-11-18T10:00:00.000Z",
    // No report, no next steps: the summary is the whole deliverable, and this row is the one the reader will check.
    finalMessage: "Rebuilt the fixture and left the tree clean.",
  },
  { path: TWO },
);
ok("the second delivery recorded with no report and no next steps", second?.saved === true && second?.entry?.next?.length === 0);

// ---- the collision side: one detected pair, and one reported pair the reader rules on ---------------------------
const BOOK_FILE = path.join(dir, "logs", "collisions.json");
const book = new CollisionBook({ file: BOOK_FILE, log: (m) => console.log(`      book: ${m}`) });
const rowSkeleton = (p, branch, name) => ({ project: "chip-proj", path: p, branch, name, live: true });
const harvester = Object.create(Jobs.prototype);
harvester.collisions = book;
harvester.push = () => {};
harvester.getRows = () => [rowSkeleton(ONE, "wtgui/chip-one", "chip-one"), rowSkeleton(TWO, "wtgui/chip-two", "chip-two"), rowSkeleton(THREE, "wtgui/chip-three", "chip-three")];
const noted = harvester.harvestCollisions(
  {
    id: "runchip003",
    thread: "chip-thread-three",
    project: "chip-proj",
    status: "done",
    endedAt: "2026-11-18T11:00:00.000Z",
    finalMessage: ["The third tree is built.", "", "COLLISION chip-one | both of us are rewriting lib/shared.js - I only need the export name settled"].join("\n"),
  },
  { path: THREE, branch: "wtgui/chip-three" },
);
ok("a worker's COLLISION line was filed against its own tree", noted?.noted === 1 && noted?.broken === 0, `noted ${noted?.noted}, broken ${noted?.broken}`);
const reported = [...book.all()].find((rec) => rec.source === "reported");
ok("…and it resolved to the pair of the third tree and the first", Boolean(reported) && [reported?.a?.path, reported?.b?.path].sort().join("|") === [ONE, THREE].sort().join("|"), reported?.key);

const panel = await startPanel({ dir, keep: true, config: { collisionsFile: BOOK_FILE, reviewsFile: REVIEW_STORE, assistant: { enabled: false } } });
console.log(`      panel   ${panel.base}  (throwaway: ${panel.dir})`);
const shots = path.resolve(SHOT_DIR);
mkdirSync(shots, { recursive: true });

// The reader rules on the reported pair through the panel's OWN route, so the resolved count on the chip is a record
// this panel wrote and not a fixture field: after this press that pair is a ruling, and the other pair is still open.
const ruledRes = await fetch(`${panel.base}/api/collisions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ op: "rule", key: reported?.key, pick: "a", note: "the third tree goes second" }),
});
const ruledBody = await ruledRes.json().catch(() => null);
ok("POST /api/collisions stored the ruling against the pair", ruledRes.status === 200 && ruledBody?.ok !== false, `${ruledRes.status} ${JSON.stringify(ruledBody)?.slice(0, 160)}`);

// The scan's own pair is DETECTED BY THE PANEL, not seeded: the sweep runs over the rows the scanner wrote, so it is
// driven from inside the page section below, once those rows exist. A sweep that runs before the boot scan has
// finished sees nothing, and a proof cannot assert on that race.

const result = await withBrowser(async ({ page, pageErrors }) => {
  await openPage(page, panel.base, { selector: "#btn-review" });
  await page.setViewportSize({ width: 1440, height: 900 });

  // The scanner's own rows, before any sweep: the detector reads THESE, so a sweep asked for before they exist is the
  // race tools/verify-collisions.mjs documents rather than a finding about the chips.
  await page.waitForFunction(
    () => {
      try {
        return state.rows.size >= 3;
      } catch {
        return false;
      }
    },
    null,
    { timeout: 60_000 },
  );
  const swept = async () => {
    const r = await fetch(`${panel.base}/api/collisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "sweep" }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  let detected = null;
  for (let i = 0; i < 30; i += 1) {
    detected = await swept();
    if ((detected.body?.report?.pairs || 0) >= 1) break;
    await page.waitForTimeout(1000);
  }
  ok("the sweep found the two dirty trees' pair, beside the worker's reported one", (detected.body?.report?.pairs || 0) >= 1, `pairs ${detected.body?.report?.pairs}`);
  // The panel's own pass hands a detected pair over on a LATER sweep, at least COLLISION_PASS_MS after the first -
  // the same two-tick rule tools/verify-collisions.mjs drives, so the pair is the reader's and not auto-settled.
  await page.waitForTimeout(COLLISION_PASS_MS + 600);
  const handed = await swept();
  ok("the second sweep handed the detected pair over", handed.status === 200 && (handed.body?.report?.pairs || 0) >= 1, JSON.stringify(handed.body?.report || handed.body)?.slice(0, 200));
  const known = await (await fetch(`${panel.base}/api/collisions`)).json();
  const pairs = known?.records || known?.pairs || [];
  const openPairKey = pairs.find((p) => !p.ruling && p.state !== "ruled")?.key || null;
  const ruledPairKey = pairs.find((p) => Boolean(p.ruling))?.key || null;
  console.log(`      pairs after the sweeps: ${pairs.map((p) => `${p.key?.split("/").pop()}:${p.state}${p.ruling ? "(ruled)" : ""}`).join(" | ") || "(none)"}`);
  ok("the two dirty trees are one OPEN pair, and the ruled pair is still the ruled one", Boolean(openPairKey) && Boolean(ruledPairKey), `${pairs.length} pair(s)`);

  // A reload makes the rows the chips draw carry both pairs: the snapshot attaches `collisions.forTree` to every row.
  await page.reload({ waitUntil: "domcontentloaded" });

  const reachProject = async () => {
    await page.waitForSelector('section.project[data-project="chip-proj"]', { state: "attached", timeout: 60_000 });
    const root = await page.evaluate(() => {
      const sec = document.querySelector('section.project[data-project="chip-proj"]');
      const group = sec?.closest("section.root-group");
      return group && group.classList.contains("collapsed") ? group.dataset.root : null;
    });
    if (root) await page.click(`[data-toggle-root="${root.replace(/"/g, '\\"')}"]`);
    // A project the page restored as open is opened already: pressing its head would FOLD it, and the rows would go.
    const folded = await page.evaluate(() => Boolean(document.querySelector('section.project[data-project="chip-proj"]')?.classList.contains("collapsed")));
    if (folded) await page.click('[data-toggle-project="chip-proj"]');
    await page.waitForFunction(() => document.querySelectorAll("tr.row[data-key]").length >= 4, null, { timeout: 45_000 });
  };
  await reachProject();

  const keyOfTree = (t) => `chip-proj::${t}`;
  const rowSel = (t) => `tr.row[data-key="${keyOfTree(t)}"]`;
  const chipSel = (t, kind) => `${rowSel(t)} [data-rowchip="${kind}"]`;

  // ---- 1. the chips exist, in the strip that was already there ------------------------------------------------
  section("1. both chips are in the row's own name line");
  const present = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("tr.row[data-key]")];
    return rows.map((tr) => {
      const line = tr.querySelector("td.name .name-line");
      const chips = line ? [...line.querySelectorAll("[data-rowchip]")] : [];
      return {
        key: tr.dataset.key,
        chips: chips.map((c) => c.dataset.rowchip),
        parents: chips.map((c) => (c.parentElement && c.parentElement.className) || ""),
        marks: line ? [...line.querySelectorAll(".review-mark, .collision-mark")].length : 0,
        tags: chips.map((c) => c.tagName),
        expanded: chips.map((c) => c.getAttribute("aria-expanded")),
      };
    });
  });
  const rowOne = present.find((r) => r.key === keyOfTree(ONE));
  const rowTwo = present.find((r) => r.key === keyOfTree(TWO));
  const rowThree = present.find((r) => r.key === keyOfTree(THREE));
  ok("the row with a delivery and two pairs carries both chips, result first", rowOne && JSON.stringify(rowOne.chips) === JSON.stringify(["result", "collision"]), JSON.stringify(rowOne && rowOne.chips));
  ok("they are children of the row's existing name line - the same strip as the marks", rowOne && rowOne.parents.every((p) => /name-line/.test(p)), JSON.stringify(rowOne && rowOne.parents));
  ok("the row's marks are still beside them", rowOne && rowOne.marks >= 2, `marks ${rowOne && rowOne.marks}`);
  ok("each chip is a real button, so Tab reaches it and Enter presses it", rowOne && rowOne.tags.every((t) => t === "BUTTON"), JSON.stringify(rowOne && rowOne.tags));
  ok("both start COLLAPSED", rowOne && rowOne.expanded.every((e) => e === "false"), JSON.stringify(rowOne && rowOne.expanded));
  ok("no card is in the document while neither chip is pressed", (await page.evaluate(() => document.querySelectorAll(".rowchip-pop").length)) === 0);
  ok("no chip on the board carries a chevron while collapsed", (await page.evaluate(() => document.querySelectorAll("[data-rowchip] .rowchip-chev").length)) === 0);

  // ---- 2. collapsed, an absolute path is not in the chip -----------------------------------------------------
  section("2. the collapsed result chip reads the clause, the age, and never an absolute path");
  // By CHIP KIND, not by position: a row with no delivery has no result chip, so the collision chip is its first.
  const labels = await page.evaluate(
    () =>
      Object.fromEntries(
        [...document.querySelectorAll("tr.row[data-key]")].map((tr) => [
          tr.dataset.key,
          Object.fromEntries([...tr.querySelectorAll("[data-rowchip]")].map((c) => [c.dataset.rowchip, (c.querySelector(".rowchip-text")?.textContent || "").trim()])),
        ]),
      ),
  );
  const oneLabels = labels[keyOfTree(ONE)] || {};
  ok("the result chip reads the FIRST CLAUSE of the run's summary", /^Both cards became one-line chips/.test(oneLabels.result || ""), oneLabels.result);
  ok("…then the run's age, as the page's own relative reader spelled it", /\d+[a-z]+ ago$/.test(oneLabels.result || ""), oneLabels.result);
  ok("…and no absolute path anywhere in it", !/[A-Za-z]:[\\/]/.test(Object.values(oneLabels).join(" ")) && !/\/worktrees\//.test(Object.values(oneLabels).join(" ")), Object.values(oneLabels).join(" | "));
  ok("the collision chip reads this row's pair count, both numbers", oneLabels.collision === "1 open \u00b7 1 resolved", oneLabels.collision);
  ok("the row with only the detected pair reads 1 open . 0 resolved", (labels[keyOfTree(TWO)] || {}).collision === "1 open \u00b7 0 resolved", (labels[keyOfTree(TWO)] || {}).collision);
  ok("the row whose pair the reader ruled reads 0 open . 1 resolved", (labels[keyOfTree(THREE)] || {}).collision === "0 open \u00b7 1 resolved", (labels[keyOfTree(THREE)] || {}).collision);

  // ---- 3. NO ADDED HEIGHT ------------------------------------------------------------------------------------
  section("3. neither chip adds a pixel to the row");
  const height = await page.evaluate((key) => {
    const tr = document.querySelector(`tr.row[data-key="${key}"]`);
    if (!tr) return null;
    const line = tr.querySelector("td.name .name-line");
    const withChips = tr.getBoundingClientRect().height;
    const lineBox = line.getBoundingClientRect().height;
    const chips = [...line.querySelectorAll("[data-rowchip]")];
    const chipTops = chips.map((c) => Math.round(c.getBoundingClientRect().top));
    // The chips out of the flow: if they were a second line, the row would be shorter without them.
    const held = chips.map((c) => c.style.display);
    for (const c of chips) c.style.display = "none";
    const withoutChips = tr.getBoundingClientRect().height;
    const lineWithout = line.getBoundingClientRect().height;
    const lineScroll = line.scrollHeight;
    chips.forEach((c, i) => {
      c.style.display = held[i];
    });
    return { withChips, withoutChips, lineBox, lineWithout, lineScroll, chipTops, sameLine: new Set(chipTops).size === 1, nameOneLine: lineBox <= lineWithout + 0.5 };
  }, keyOfTree(ONE));
  ok("the row is exactly as tall with the two chips as without them", height && Math.abs(height.withChips - height.withoutChips) <= 0.5, height ? `${height.withChips} vs ${height.withoutChips}` : "no row");
  ok("the name line is one line either way, and the chips sit on that line", height && height.nameOneLine && height.sameLine, height ? `line ${height.lineBox} / ${height.lineWithout}, tops ${height.chipTops}` : "no row");
  ok("…so the strip did not overflow: no vertical scroll inside it", height && height.lineScroll <= Math.round(height.lineBox) + 1, height ? `scroll ${height.lineScroll} vs box ${height.lineBox}` : "no row");

  if (process.env.PANEL_SHOT_DIR || true) await page.screenshot({ path: path.join(shots, "row-chips-01-both-collapsed-1440x900.png") });

  // ---- 4. the result chip opens the card behind it -----------------------------------------------------------
  section("4. the result chip opens the existing card: the paragraph, the report anchor, the next steps");
  await page.click(chipSel(ONE, "result"));
  await page.waitForSelector(".rowchip-pop .review-block", { timeout: 15_000 });
  const card = await page.evaluate((key) => {
    const pop = document.querySelector(".rowchip-pop");
    const anchor = pop?.querySelector(".review-block a[data-open-file]");
    const summary = pop?.querySelector(".review-summary");
    const steps = [...(pop?.querySelectorAll(".review-chip") || [])];
    const chip = document.querySelector(`tr.row[data-key="${key}"] [data-rowchip="result"]`);
    const rect = pop?.getBoundingClientRect();
    return {
      kind: pop?.dataset.rowchipPop,
      text: (pop?.textContent || "").replace(/\s+/g, " ").trim(),
      summary: (summary?.textContent || "").trim(),
      target: anchor?.getAttribute("data-open-file") || "",
      base: anchor?.getAttribute("data-open-file-base") || "",
      steps: steps.map((s) => s.textContent.trim()),
      expanded: chip?.getAttribute("aria-expanded"),
      chevron: Boolean(chip?.querySelector(".rowchip-chev")),
      inside: Boolean(rect) && rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth + 0.5 && rect.bottom <= window.innerHeight + 0.5,
      popRect: rect ? { l: Math.round(rect.left), t: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
    };
  }, keyOfTree(ONE));
  eq("the popup is the RESULT card", card.kind, "result");
  ok("it carries the WHOLE summary, not the chip's clause", card.summary.startsWith("Both cards became one-line chips in the row's own strip."), card.summary.slice(0, 70));
  eq("the report is the panel's own open-file anchor, on the run's path", card.target, "docs/reports/row-chips.html");
  ok("…with the TREE as its base, so the relative path resolves in the worktree", /chip-one-aaaa$/.test(card.base.replace(/\\/g, "/")), card.base);
  eq("both next steps the run named are on the card", card.steps, ["check the count on the collision chip", "confirm a repaint leaves an open card open"]);
  eq("the chip it belongs to is expanded, and only now wears a chevron", [card.expanded, card.chevron], ["true", true]);
  ok("the card fits inside the 1440x900 window", card.inside, JSON.stringify(card.popRect));
  await page.screenshot({ path: path.join(shots, "row-chips-02-result-expanded-1440x900.png") });

  // ---- 5. one card at a time: the collision chip opens the pair card ----------------------------------------
  section("5. the collision chip opens the pair card, and closes the result card");
  await page.click(chipSel(ONE, "collision"));
  await page.waitForSelector(".rowchip-pop .collision-block", { timeout: 15_000 });
  const pair = await page.evaluate(({ ruledKey, key }) => {
    const pops = [...document.querySelectorAll(".rowchip-pop")];
    const pop = pops.find((p) => p.dataset.rowchipPop === "collision");
    const tr = document.querySelector(`tr.row[data-key="${key}"]`);
    const blocks = [...(pop?.querySelectorAll(".collision-block") || [])];
    // The card behind the chip carries EVERY pair on the row; the ruled one is the block this section is about.
    const block = blocks.find((b) => b.dataset.collisionKey === ruledKey) || blocks[0];
    const text = (block?.textContent || "").replace(/\s+/g, " ").trim();
    return {
      count: pops.length,
      kinds: pops.map((p) => p.dataset.rowchipPop),
      blocks: blocks.length,
      text,
      sides: [...(block?.querySelectorAll(".collision-side") || [])].map((s) => (s.textContent || "").replace(/\s+/g, " ").trim()),
      ruling: Boolean(block?.querySelector("[data-collision-pick], .collision-ruling, .collision-ruled")),
      resultExpanded: tr?.querySelector('[data-rowchip="result"]')?.getAttribute("aria-expanded"),
      collisionExpanded: tr?.querySelector('[data-rowchip="collision"]')?.getAttribute("aria-expanded"),
    };
  }, { ruledKey: ruledPairKey, key: keyOfTree(ONE) });
  eq("exactly ONE card is open - the collision's", [pair.count, pair.kinds], [1, ["collision"]]);
  eq("the result chip is collapsed again", pair.resultExpanded, "false");
  eq("the collision chip is expanded", pair.collisionExpanded, "true");
  ok("the card lists both of the row's pairs", pair.blocks === 2, `${pair.blocks} block(s)`);
  eq("the ruled pair's block names BOTH sides", pair.sides.length, 2);
  ok("…one of them this row, one of them chip-three", pair.sides.join(" ").includes("chip-one") && pair.sides.join(" ").includes("chip-three"), pair.sides.join(" || ").slice(0, 200));
  ok("…and it says the pair is already ruled", /ruled|goes first/i.test(pair.text), pair.text.slice(0, 160));
  await page.screenshot({ path: path.join(shots, "row-chips-03-collision-expanded-1440x900.png") });

  // ---- 6. A REPAINT DOES NOT SLAM IT SHUT -------------------------------------------------------------------
  section("6. the page's own repaint leaves the open card open, on the row's NEW chip");
  const before = await page.evaluate((key) => {
    const pop = document.querySelector(".rowchip-pop");
    const chip = document.querySelector(`tr.row[data-key="${key}"] [data-rowchip="collision"]`);
    window.__chipNode = chip;
    // setAttribute answers undefined, so the MARK is read back rather than trusted to the call's return.
    if (chip) chip.setAttribute("data-gate-old", "1");
    return { chipMarked: chip ? chip.getAttribute("data-gate-old") : "", had: Boolean(pop) };
  }, keyOfTree(ONE));
  ok("the collision card is open before the repaint", before.had && before.chipMarked === "1", JSON.stringify(before));
  await page.evaluate(() => {
    // Exactly what a scan does: every row of the project is rebuilt, chip nodes and all.
    window.renderProjectRows("chip-proj");
  });
  await page.waitForFunction(() => !document.querySelector('[data-rowchip="collision"][data-gate-old]'), null, { timeout: 10_000 });
  const after = await page.evaluate((key) => {
    const pop = document.querySelector(".rowchip-pop");
    const chip = document.querySelector(`tr.row[data-key="${key}"] [data-rowchip="collision"]`);
    return {
      open: Boolean(pop),
      kind: pop?.dataset.rowchipPop,
      anchorConnected: Boolean(pop?._anchor && pop._anchor.isConnected),
      anchorIsNewChip: pop?._anchor === chip,
      expanded: chip?.getAttribute("aria-expanded"),
      oldNodeGone: !document.querySelector("[data-gate-old]"),
      stored: localStorage.getItem("wm.openRowChips"),
      bodyHasPair: Boolean(pop?.querySelector(".collision-block")),
    };
  }, keyOfTree(ONE));
  ok("the repaint really replaced the chip node", after.oldNodeGone);
  ok("the card is STILL open after the repaint", after.open && after.kind === "collision", JSON.stringify(after));
  ok("…anchored to the row's NEW chip, with its body intact", after.anchorConnected && after.anchorIsNewChip && after.bodyHasPair, JSON.stringify({ connected: after.anchorConnected, isNew: after.anchorIsNewChip, body: after.bodyHasPair }));
  eq("…and the new chip is still marked expanded", after.expanded, "true");
  ok("…because the expansion is remembered per row and per card", /"collision\|chip-proj::.*chip-one-aaaa"/.test(after.stored || ""), after.stored);
  await page.screenshot({ path: path.join(shots, "row-chips-04-after-repaint-1440x900.png") });

  // ---- 7. Escape closes it and forgets it ------------------------------------------------------------------
  section("7. Escape closes the card, hands the caret back, and forgets the expansion");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelectorAll(".rowchip-pop").length === 0, null, { timeout: 10_000 });
  const closed = await page.evaluate((key) => ({
    pops: document.querySelectorAll(".rowchip-pop").length,
    expanded: document.querySelector(`tr.row[data-key="${key}"] [data-rowchip="collision"]`)?.getAttribute("aria-expanded"),
    chevrons: document.querySelectorAll("[data-rowchip] .rowchip-chev").length,
    focused: document.activeElement?.getAttribute("data-rowchip") || document.activeElement?.tagName,
    stored: localStorage.getItem("wm.openRowChips"),
  }), keyOfTree(ONE));
  eq("the card is gone", closed.pops, 0);
  eq("its chip is collapsed, with no chevron", [closed.expanded, closed.chevrons], ["false", 0]);
  eq("the caret went back to the chip", closed.focused, "collision");
  ok("…and the remembered set no longer holds it", !/"collision\|/.test(closed.stored || ""), closed.stored);

  // ---- 8. a checked delivery says so in the collapsed chip ---------------------------------------------------
  section("8. a reviewed delivery reads 'reviewed' in the chip, not only in the card");
  const checked = await fetch(`${panel.base}/api/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "reviewed", path: TWO }) });
  const checkedBody = await checked.json().catch(() => null);
  ok("POST /api/review marked the second delivery reviewed", checked.status === 200 && checkedBody?.ok !== false, `${checked.status} ${JSON.stringify(checkedBody)}`);
  await page.reload({ waitUntil: "domcontentloaded" });
  await reachProject();
  await page.waitForFunction(
    (key) => {
      const chip = document.querySelector(`tr.row[data-key="${key}"] [data-rowchip="result"]`);
      return Boolean(chip) && /reviewed/.test(chip.textContent || "");
    },
    keyOfTree(TWO),
    { timeout: 20_000 },
  );
  const reviewedChip = await page.evaluate((key) => {
    const chip = document.querySelector(`tr.row[data-key="${key}"] [data-rowchip="result"]`);
    return { text: (chip?.textContent || "").replace(/\s+/g, " ").trim(), cls: chip?.className || "" };
  }, keyOfTree(TWO));
  ok("the checked row's chip says 'reviewed'", / reviewed$/.test(reviewedChip.text), reviewedChip.text);
  ok("…and wears the reviewed colour, not the awaiting one", /is-reviewed/.test(reviewedChip.cls) && !/is-awaiting/.test(reviewedChip.cls), reviewedChip.cls);
  ok("the unchecked row's chip still reads the clause and its age, with no 'reviewed'", !/reviewed/.test((labels[keyOfTree(ONE)] || {}).result || ""), (labels[keyOfTree(ONE)] || {}).result);

  // ---- 9. the expansion is remembered across a reload ---------------------------------------------------------
  section("9. a card the reader opened comes back open after a reload");
  await page.click(chipSel(ONE, "result"));
  await page.waitForSelector('.rowchip-pop[data-rowchip-pop="result"]', { timeout: 15_000 });
  const remembered = await page.evaluate((id) => {
    const stored = localStorage.getItem("wm.openRowChips") || "";
    return { stored, hasId: stored.includes(id) };
  }, `result|${keyOfTree(ONE)}`);
  ok("the press remembered the result card under its own row", remembered.hasId, remembered.stored);
  await page.reload({ waitUntil: "domcontentloaded" });
  await reachProject();
  await page.waitForSelector('.rowchip-pop[data-rowchip-pop="result"]', { timeout: 20_000 });
  const backOpen = await page.evaluate((key) => {
    const chip = document.querySelector(`tr.row[data-key="${key}"] [data-rowchip="result"]`);
    const pop = document.querySelector('.rowchip-pop[data-rowchip-pop="result"]');
    return {
      expanded: chip?.getAttribute("aria-expanded"),
      chevron: Boolean(chip?.querySelector(".rowchip-chev")),
      open: Boolean(pop),
      anchored: Boolean(pop) && pop._anchor === chip,
      body: Boolean(pop?.querySelector(".review-block")),
      key: pop?.dataset.popKey || "",
    };
  }, keyOfTree(ONE));
  eq("…the chip is expanded again, with its chevron", [backOpen.expanded, backOpen.chevron], ["true", true]);
  ok("…and its card is back, on the row's own chip, with the paragraph in it", backOpen.open && backOpen.anchored && backOpen.body && backOpen.key === keyOfTree(ONE), JSON.stringify(backOpen));
  // The restored card is anchored to a chip with no caret in it - a repaint must not steal focus. Tab reaches the
  // chip, and Escape on the chip is its own dismissal, so that is the press a keyboard reader makes here.
  await page.evaluate((key) => {
    const chip = document.querySelector(`tr.row[data-key="${key}"] [data-rowchip="result"]`);
    if (chip) chip.focus();
  }, keyOfTree(ONE));
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelectorAll(".rowchip-pop").length === 0, null, { timeout: 10_000 });

  // ---- 10. every pair resolved: the muted chip and the faded mark ---------------------------------------------
  section("10. a row whose every pair is resolved is muted, on the chip and on the mark");
  const quietChip = await page.evaluate((key) => {
    const tr = document.querySelector(`tr.row[data-key="${key}"]`);
    const chip = tr?.querySelector('[data-rowchip="collision"]');
    const mark = tr?.querySelector(".collision-mark");
    return {
      text: (chip?.querySelector(".rowchip-text")?.textContent || "").trim(),
      cls: chip?.className || "",
      mark: mark?.className || "",
      markColour: mark ? getComputedStyle(mark).color : "",
      marks: tr ? tr.querySelectorAll(".collision-mark").length : 0,
    };
  }, keyOfTree(THREE));
  eq("the fully resolved row reads 0 open . 1 resolved", quietChip.text, "0 open \u00b7 1 resolved");
  ok("…in the muted chip, never the violet one", /is-quiet/.test(quietChip.cls) && !/is-live/.test(quietChip.cls), quietChip.cls);
  ok("…and its row mark is the faded ruled one, not the violet open one", /is-ruled/.test(quietChip.mark) && !/is-assistants|is-reader/.test(quietChip.mark), quietChip.mark);
  eq("…drawn in the muted ink", quietChip.markColour, "rgb(139, 122, 168)");
  const liveMark = await page.evaluate((key) => {
    const mark = document.querySelector(`tr.row[data-key="${key}"] .collision-mark`);
    return { cls: mark?.className || "", colour: mark ? getComputedStyle(mark).color : "" };
  }, keyOfTree(TWO));
  ok("a row with a pair still open keeps the violet mark", /is-assistants|is-reader/.test(liveMark.cls), liveMark.cls);
  // Two violet inks, one meaning: the base violet for a pair with the assistants, the brighter one for a pair waiting
  // on the reader. Both are the OPEN pair's; the muted #8b7aa8 is the ruled one's alone.
  ok("…in a violet ink, not the muted ruled one", ["rgb(201, 160, 255)", "rgb(228, 200, 255)"].includes(liveMark.colour), liveMark.colour);
  await page.screenshot({ path: path.join(shots, "row-chips-05-muted-chip-1440x900.png") });

  eq("no page error was raised while driving the board", pageErrors.length, 0, pageErrors.slice(0, 3).join(" | "));
  return { checks, failures, shots };
});

console.log(`\n-- ${result.checks} checks, ${result.failures} failed`);
console.log(`      screenshots: ${result.shots}`);
process.exit(result.failures === 0 ? 0 : 1);
