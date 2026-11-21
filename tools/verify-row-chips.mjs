// tools/verify-row-chips.mjs - the result card as a ONE-LINE chip, and the collision card behind the row's ONE diamond,
// driven in a real browser against a real panel at 1440x900.
//
//   node tools/verify-row-chips.mjs
//   node tools/verify-row-chips.mjs --shots <dir>
//
// WHAT THIS IS. Both cards used to be blocks in the row's detail: two paragraphs of height that only existed once the
// reader had opened the row they were deciding whether to open. They are controls in the row's existing strip now, and
// the cards are popups behind them. This gate boots a throwaway panel (tools/panel-testkit.mjs - the real server.js and
// the real public/) over a real git fixture with three worktrees, seeds BOTH surfaces through their real seams
// (`Jobs.harvestReview` -> lib/review-inbox.js, `Jobs.harvestCollisions` -> lib/collisions.js) and drives the page in
// headless Chromium.
//
// THE COLLISION SIDE IS ONE DIAMOND, NOT A CHIP. It used to be a violet mark per pair plus a "0 open . 1 resolved"
// pill; the pill spent the width the reader asked back, and the marks said the same thing twice. One real button per
// row now, filled while a pair is open and outlined once every one is resolved, and its accessible name and title say
// the state and the count in words.
//
// WHAT IS DRIVEN AND WHY EACH ONE MATTERS
//   1. ONE CONTROL PER CELL: the collision diamond rides the row's existing name line, the result chip sits in the
//      chart's own `reviewedExtra` column - and the counts chip is GONE from every row and from the sheet
//   2. ONE DIAMOND PER ROW, including the row that carries TWO pairs: a mark per pair and a chip per row is what the
//      reader asked to end, so the count of the control is asserted on all three rows
//   3. the diamond's state words: "2 collisions: 1 open, 1 resolved" / "1 collision, open" / "1 collision, resolved",
//      on BOTH the accessible name and the title, and a FILLED glyph while a pair is open against an OUTLINED one when
//      every pair is resolved - so the state never rests on colour alone
//   4. IT IS A REAL CONTROL: a 24x24 border box, keyboard reachable, Space and Enter both open the card, Escape closes
//      it and hands the caret back, and the focus ring is measured at 3:1 or better against the row
//   5. collapsed, the result chip reads the first clause of the summary, the age and (on a checked delivery)
//      "reviewed"; it carries NO chevron and NO absolute path
//   6. the row does not reflow: the 24x24 box is bought with a negative block margin, so the row is exactly as tall as
//      it was with the counts chip there and as tall as a row with no collision at all
//   7. pressing the diamond opens the card behind it - the whole paragraph, the report as a real anchor through the
//      panel's own open-file route with the TREE as its base, and the next steps the run named
//   8. pressing the diamond opens the pair card for EVERY pair on the worktree - both blocks, not the first pair - and
//      one card at a time
//   9. A REPAINT DOES NOT SLAM IT SHUT: the page's own `renderProjectRows` rebuilds every row and its controls, and the
//      open card is still there, still anchored to the row's NEW diamond, still `aria-expanded="true"`
//  10. Escape closes it, hands the caret back to the diamond, and forgets the expansion
//  11. a reviewed delivery says so in its chip - the check is in the collapsed text, not behind the expansion
//  12. the expansion is REMEMBERED: a card opened before a reload comes back open, on the row's own control
//  13. a row whose every pair is resolved wears the OUTLINED muted diamond, and a row with an open pair the filled,
//      accented one - and the diamond's box and the row's height are measured against each other in both states
//  14. screenshots at 1440x900: both collapsed, one expanded, the pair card, and the muted diamond
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
// WCAG relative luminance and contrast, so "a focus ring at 3:1" is a MEASUREMENT and not a claim in a comment. The
// ring is checked against the row's own paint (the first opaque background behind the control), which is the surface it
// is drawn on.
const parseRgb = (s) => (String(s).match(/[\d.]+/g) || []).slice(0, 3).map(Number);
const relLum = ([r, g, b]) =>
  [r, g, b]
    .map((v) => v / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a, b) => {
  if (a.length < 3 || b.length < 3) return 0;
  const [la, lb] = [relLum(a), relLum(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

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
  const diamondSel = (t) => `${rowSel(t)} [data-collision-diamond]`;

  // ---- 1. one control per cell, and the counts chip is gone ---------------------------------------------------
  section("1. one control per cell: the result chip in its own column, ONE collision diamond in the name line");
  const present = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("tr.row[data-key]")];
    return rows.map((tr) => {
      const line = tr.querySelector("td.name .name-line");
      const extra = tr.querySelector("td.reviewed-extra");
      const chips = [...tr.querySelectorAll("[data-rowchip]")];
      const diamonds = [...tr.querySelectorAll("[data-collision-diamond]")];
      return {
        key: tr.dataset.key,
        chips: chips.map((c) => c.dataset.rowchip),
        inNameLine: line ? [...line.querySelectorAll("[data-rowchip]")].map((c) => c.dataset.rowchip) : [],
        inExtraCell: extra ? [...extra.querySelectorAll("[data-rowchip]")].map((c) => c.dataset.rowchip) : [],
        parents: chips.map((c) => (c.parentElement && c.parentElement.className) || ""),
        diamonds: diamonds.length,
        diamondTags: diamonds.map((d) => d.tagName),
        diamondText: diamonds.map((d) => (d.textContent || "").trim()),
        perPairMarks: tr.querySelectorAll('.collision-mark[role="img"]').length,
        oldChip: tr.querySelectorAll(".collision-chip").length,
        marks: line ? [...line.querySelectorAll(".review-mark, .collision-mark")].length : 0,
        tags: chips.map((c) => c.tagName),
        expanded: chips.map((c) => c.getAttribute("aria-expanded")),
      };
    });
  });
  const rowOne = present.find((r) => r.key === keyOfTree(ONE));
  const rowTwo = present.find((r) => r.key === keyOfTree(TWO));
  const rowThree = present.find((r) => r.key === keyOfTree(THREE));
  // Document order is the name cell first, then the column beside it - so the collision control is read first.
  ok("the row with a delivery and two pairs carries both controls", rowOne && JSON.stringify(rowOne.chips) === JSON.stringify(["collision", "result"]), JSON.stringify(rowOne && rowOne.chips));
  ok("the result chip is in the chart's reviewedExtra cell, OUTSIDE the name cell", rowOne && rowOne.inExtraCell.join(",") === "result", JSON.stringify(rowOne && rowOne.inExtraCell));
  ok("…so the name cell no longer carries it", rowOne && !rowOne.inNameLine.includes("result"), JSON.stringify(rowOne && rowOne.inNameLine));
  ok("the collision control rides the name line", rowOne && rowOne.inNameLine.join(",") === "collision", JSON.stringify(rowOne && rowOne.inNameLine));
  ok("one control per cell, both in the row's one line", rowOne && JSON.stringify(rowOne.parents) === JSON.stringify(["name-line", "reviewed-extra"]), JSON.stringify(rowOne && rowOne.parents));
  // ONE DIAMOND PER ROW - including the row that carries TWO pairs, which used to paint two marks and then a chip.
  ok("the row with TWO pairs paints exactly ONE diamond", rowOne && rowOne.diamonds === 1, `diamonds ${rowOne && rowOne.diamonds}`);
  ok("…and every other row with a collision paints one too", rowTwo?.diamonds === 1 && rowThree?.diamonds === 1, `two ${rowTwo?.diamonds}, three ${rowThree?.diamonds}`);
  ok("no row paints a passive per-pair mark any more", present.every((r) => r.perPairMarks === 0), JSON.stringify(present.map((r) => r.perPairMarks)));
  ok("no row draws the counts chip", present.every((r) => r.oldChip === 0), JSON.stringify(present.map((r) => r.oldChip)));
  ok("the diamond is a real BUTTON", rowOne && rowOne.diamondTags.join(",") === "BUTTON", JSON.stringify(rowOne && rowOne.diamondTags));
  ok("…and it draws no number: its text is the glyph alone", rowOne && rowOne.diamondText.every((t) => t === "\u25c6"), JSON.stringify(rowOne && rowOne.diamondText));
  ok("no 'N open . M resolved' string is left anywhere on the board", (await page.evaluate(() => ![...document.querySelectorAll("tr.row")].some((tr) => /\d+ open\s*\u00b7\s*\d+ resolved/.test(tr.innerText || "")))));
  ok("the row's other mark (the amber review one) is still beside it", rowOne && rowOne.marks >= 2, `marks ${rowOne && rowOne.marks}`);
  ok("each control is a real button, so Tab reaches it and Enter presses it", rowOne && rowOne.tags.every((t) => t === "BUTTON"), JSON.stringify(rowOne && rowOne.tags));
  ok("both start COLLAPSED", rowOne && rowOne.expanded.every((e) => e === "false"), JSON.stringify(rowOne && rowOne.expanded));
  ok("no card is in the document while neither control is pressed", (await page.evaluate(() => document.querySelectorAll(".rowchip-pop").length)) === 0);
  ok("no control on the board carries a chevron while collapsed", (await page.evaluate(() => document.querySelectorAll("[data-rowchip] .rowchip-chev").length)) === 0);

  // ---- 2. the result chip's words, and the diamond's ----------------------------------------------------------
  section("2. the result chip reads the clause and the age; the diamond says the state and the count in WORDS");
  // By CHIP KIND, not by position: a row with no delivery has no result chip, so the collision diamond is its first.
  const labels = await page.evaluate(
    () =>
      Object.fromEntries(
        [...document.querySelectorAll("tr.row[data-key]")].map((tr) => [
          tr.dataset.key,
          Object.fromEntries([...tr.querySelectorAll("[data-rowchip]")].map((c) => [c.dataset.rowchip, (c.querySelector(".rowchip-text")?.textContent || "").trim()])),
        ]),
      ),
  );
  const says = await page.evaluate(
    () =>
      Object.fromEntries(
        [...document.querySelectorAll("tr.row[data-key]")].map((tr) => {
          const d = tr.querySelector("[data-collision-diamond]");
          return [
            tr.dataset.key,
            d
              ? {
                  aria: (d.getAttribute("aria-label") || "").trim(),
                  title: (d.getAttribute("title") || "").trim(),
                  glyph: (d.querySelector(".collision-diamond-glyph")?.textContent || "").trim(),
                  cls: d.className,
                  box: (() => {
                    const r = d.getBoundingClientRect();
                    return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
                  })(),
                }
              : null,
          ];
        }),
      ),
  );
  const oneLabels = labels[keyOfTree(ONE)] || {};
  ok("the result chip reads the FIRST CLAUSE of the run's summary", /^Both cards became one-line chips/.test(oneLabels.result || ""), oneLabels.result);
  ok("…then the run's age, as the page's own relative reader spelled it", /\d+[a-z]+ ago$/.test(oneLabels.result || ""), oneLabels.result);
  ok("…and no absolute path anywhere in it", !/[A-Za-z]:[\\/]/.test(Object.values(oneLabels).join(" ")) && !/\/worktrees\//.test(Object.values(oneLabels).join(" ")), Object.values(oneLabels).join(" | "));
  // THE DIAMOND'S SENTENCE: the state and BOTH numbers, in words, on the accessible name and on the title - the counts
  // chip's whole content, kept where a screen reader and a tooltip can read it.
  const oneSay = says[keyOfTree(ONE)];
  const twoSay = says[keyOfTree(TWO)];
  const threeSay = says[keyOfTree(THREE)];
  ok("the two-pair row's diamond says '2 collisions: 1 open, 1 resolved'", /^2 collisions: 1 open, 1 resolved on this worktree/.test(oneSay?.aria || ""), oneSay?.aria);
  ok("…and what the press does with every pair", /press to open every pair/.test(oneSay?.aria || ""), oneSay?.aria);
  ok("the open row's diamond says '1 collision, open'", /^1 collision, open on this worktree/.test(twoSay?.aria || ""), twoSay?.aria);
  ok("the resolved row's diamond says '1 collision, resolved'", /^1 collision, resolved on this worktree/.test(threeSay?.aria || ""), threeSay?.aria);
  ok("the title repeats the state and the count, so a pointer reader gets them too", twoSay?.title === twoSay?.aria && oneSay?.title === oneSay?.aria && threeSay?.title === threeSay?.aria, JSON.stringify([oneSay?.title, twoSay?.title, threeSay?.title]));
  // Never colour alone: the FILL is the open state and the OUTLINE is the resolved one, so the glyph itself says it.
  ok("an open pair paints the FILLED diamond", oneSay?.glyph === "\u25c6" && twoSay?.glyph === "\u25c6", JSON.stringify([oneSay?.glyph, twoSay?.glyph]));
  ok("every pair resolved paints the OUTLINED diamond", threeSay?.glyph === "\u25c7", threeSay?.glyph);
  ok("…and the resolved row's diamond wears the resolved state class", /is-resolved/.test(threeSay?.cls || "") && /is-(open|waiting)/.test(twoSay?.cls || ""), JSON.stringify([threeSay?.cls, twoSay?.cls]));
  // THE HIT TARGET: 24x24, on every row that carries one.
  ok("the diamond's box is at least 24x24", [oneSay, twoSay, threeSay].every((s) => s && s.box.w >= 24 && s.box.h >= 24), JSON.stringify([oneSay?.box, twoSay?.box, threeSay?.box]));

  // ---- 3. no added height, and the width the name got back -----------------------------------------------------
  section("3. the diamond adds no pixel to the row, and the row's name takes the width the chip spent");
  const height = await page.evaluate((key) => {
    const tr = document.querySelector(`tr.row[data-key="${key}"]`);
    if (!tr) return null;
    const line = tr.querySelector("td.name .name-line");
    const extra = tr.querySelector("td.reviewed-extra");
    const resultChip = extra ? extra.querySelector('[data-rowchip="result"]') : null;
    const diamond = tr.querySelector("[data-collision-diamond]");
    const nameEl = tr.querySelector("td.name .row-name");
    const withChips = tr.getBoundingClientRect().height;
    const lineBox = line.getBoundingClientRect().height;
    const nameCellBox = tr.querySelector("td.name").getBoundingClientRect().height;
    const extraCellBox = extra ? extra.getBoundingClientRect().height : 0;
    const nameWith = nameEl ? nameEl.getBoundingClientRect().width : 0;
    const nameVisible = nameEl ? nameEl.clientWidth : 0;
    const nameFull = nameEl ? nameEl.scrollWidth : 0;
    // The diamond's own OUTER size in the line's flow: the box it needs plus whatever margin it holds. This is what
    // would push the line (and the row) taller, not the visual box on its own.
    const dStyle = diamond ? getComputedStyle(diamond) : null;
    const diamondBox = diamond ? diamond.getBoundingClientRect().width : 0;
    const diamondLead = dStyle ? parseFloat(dStyle.marginLeft) : 0;
    const diamondOuter = diamond ? diamond.getBoundingClientRect().height + parseFloat(dStyle.marginTop) + parseFloat(dStyle.marginBottom) : 0;
    // With the diamond hidden, the row must not get SHORTER either: that would mean it was the diamond holding the row
    // open. The name's own width with the diamond gone is the width the chip used to spend.
    const held = diamond ? diamond.style.display : "";
    if (diamond) diamond.style.display = "none";
    const withoutDiamond = tr.getBoundingClientRect().height;
    const nameWithout = nameEl ? nameEl.getBoundingClientRect().width : 0;
    if (diamond) diamond.style.display = held;
    // Every control on the row, whichever cell it lives in, for the "no control adds height" read.
    const chips = [...tr.querySelectorAll("[data-rowchip]")];
    const heldChips = chips.map((c) => c.style.display);
    for (const c of chips) c.style.display = "none";
    const withoutChips = tr.getBoundingClientRect().height;
    const lineWithout = line.getBoundingClientRect().height;
    const lineScroll = line.scrollHeight;
    chips.forEach((c, i) => {
      c.style.display = heldChips[i];
    });
    const nameBox = tr.querySelector("td.name").getBoundingClientRect();
    const resultBox = resultChip ? resultChip.getBoundingClientRect() : null;
    // The row's OTHER mark must still be inside the cell: the name line clips rather than wraps, so a wider strip would
    // push the amber review mark past the cell's edge - present in the DOM and invisible on screen, which is exactly the
    // regression the 250px floor is there to prevent.
    const reviewMark = tr.querySelector("td.name .review-mark");
    const markBox = reviewMark ? reviewMark.getBoundingClientRect() : null;
    const markInside = Boolean(markBox) && markBox.left >= nameBox.left - 0.5 && markBox.right <= nameBox.right + 0.5 && markBox.width >= 6;
    return {
      withChips,
      withoutChips,
      withoutDiamond,
      diamondOuter,
      lineBox,
      lineWithout,
      lineScroll,
      nameCellBox,
      extraCellBox,
      nameWith,
      nameWithout,
      nameVisible,
      nameFull,
      diamondBox,
      diamondLead,
      markInside,
      nameCellWidth: nameBox.width,
      chipBesideName: Boolean(resultBox && nameBox && resultBox.top >= nameBox.top - 1 && resultBox.bottom <= nameBox.bottom + 1),
      nameOneLine: lineBox <= lineWithout + 0.5,
    };
  }, keyOfTree(ONE));
  ok("the row is exactly as tall with its controls as without them", height && Math.abs(height.withChips - height.withoutChips) <= 0.5, height ? `${height.withChips} vs ${height.withoutChips}` : "no row");
  ok("…and exactly as tall with the diamond hidden: it holds nothing open", height && Math.abs(height.withChips - height.withoutDiamond) <= 0.5, height ? `${height.withChips} vs ${height.withoutDiamond}` : "no row");
  ok("the 24px box does not grow the one line it sits in", height && height.diamondOuter <= height.lineBox + 0.5, height ? `diamond outer ${height.diamondOuter} vs line ${height.lineBox}` : "no row");
  ok("the name line is one line either way - the diamond rides it, nothing stacks", height && height.nameOneLine, height ? `line ${height.lineBox} / ${height.lineWithout}` : "no row");
  ok("the result cell is one line too: no taller than the name cell beside it", height && height.extraCellBox <= height.nameCellBox + 1, height ? `${height.extraCellBox} vs ${height.nameCellBox}` : "no row");
  ok("…and the result chip is drawn INSIDE that line's box, beside the name rather than under it", height && height.chipBesideName);
  ok("…so the strip did not overflow: no vertical scroll inside it", height && height.lineScroll <= Math.round(height.lineBox) + 1, height ? `scroll ${height.lineScroll} vs box ${height.lineBox}` : "no row");
  // THE WIDTH: the control's whole cost to the line is its 24px box plus its 2px lead - where the counts pill spent
  // ~133px on the same fact (the row's own result chip, same font and padding, is printed as that shape). And the name
  // must still SHOW: the 12ch floor is what stops the column collapsing to the buttons' width now the pill is gone.
  const diamondCost = height ? Math.round((height.diamondBox + height.diamondLead) * 10) / 10 : 0;
  console.log(`      the control spends ${diamondCost}px of the line; the name shows ${height?.nameVisible || 0}px of its ${height?.nameFull || 0}px in a ${Math.round(height?.nameCellWidth || 0)}px cell`);
  ok("the diamond spends its 24px box and a 2px lead, nothing else", height && diamondCost >= 24 && diamondCost <= 28, `${diamondCost}px`);
  // The name either fits whole or keeps a readable prefix: the bar is 60px of it, or all of it when the name is short.
  ok("…and the name behind it still shows itself, not a blank cell", height && height.nameVisible >= Math.min(60, height.nameFull), `${height?.nameVisible} of ${height?.nameFull}px`);
  ok("…in a name column that keeps the 320px floor the strip's own controls need", height && height.nameCellWidth >= 320, `${Math.round(height?.nameCellWidth || 0)}px`);
  ok("…and the amber review mark is still INSIDE that cell, not pushed past its edge", height && height.markInside, JSON.stringify({ inside: height?.markInside, cell: height?.nameCellWidth }));

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

  // ---- 5. one card at a time: the collision diamond opens the pair card -------------------------------------
  section("5. the collision diamond opens the pair card, for EVERY pair, and closes the result card");
  await page.click(diamondSel(ONE));
  await page.waitForSelector(".rowchip-pop .collision-block", { timeout: 15_000 });
  const pair = await page.evaluate(({ ruledKey, key }) => {
    const pops = [...document.querySelectorAll(".rowchip-pop")];
    const pop = pops.find((p) => p.dataset.rowchipPop === "collision");
    const tr = document.querySelector(`tr.row[data-key="${key}"]`);
    const diamond = tr?.querySelector("[data-collision-diamond]");
    const blocks = [...(pop?.querySelectorAll(".collision-block") || [])];
    // The card behind the diamond carries EVERY pair on the row; the ruled one is the block this section is about.
    const block = blocks.find((b) => b.dataset.collisionKey === ruledKey) || blocks[0];
    const text = (block?.textContent || "").replace(/\s+/g, " ").trim();
    return {
      count: pops.length,
      kinds: pops.map((p) => p.dataset.rowchipPop),
      blocks: blocks.length,
      keys: blocks.map((b) => b.dataset.collisionKey),
      anchored: Boolean(pop) && pop._anchor === diamond,
      text,
      sides: [...(block?.querySelectorAll(".collision-side") || [])].map((s) => (s.textContent || "").replace(/\s+/g, " ").trim()),
      ruling: Boolean(block?.querySelector("[data-collision-pick], .collision-ruling, .collision-ruled")),
      resultExpanded: tr?.querySelector('[data-rowchip="result"]')?.getAttribute("aria-expanded"),
      collisionExpanded: diamond?.getAttribute("aria-expanded"),
      chevrons: diamond ? diamond.querySelectorAll(".rowchip-chev").length : -1,
    };
  }, { ruledKey: ruledPairKey, key: keyOfTree(ONE) });
  eq("exactly ONE card is open - the collision's", [pair.count, pair.kinds], [1, ["collision"]]);
  ok("…anchored to the row's diamond, the control the reader pressed", pair.anchored);
  eq("the result chip is collapsed again", pair.resultExpanded, "false");
  eq("the diamond is expanded", pair.collisionExpanded, "true");
  // EVERY pair on that worktree: this row carries two, and the card must list both - "the first pair" is the bug the
  // reader's brief names, so the count and the keys are both asserted.
  ok("the card lists BOTH of the row's pairs, not the first", pair.blocks === 2, `${pair.blocks} block(s)`);
  ok("…two DIFFERENT pair keys, so both are really there", new Set(pair.keys).size === 2 && pair.keys.every(Boolean), JSON.stringify(pair.keys));
  eq("the ruled pair's block names BOTH sides", pair.sides.length, 2);
  ok("…one of them this row, one of them chip-three", pair.sides.join(" ").includes("chip-one") && pair.sides.join(" ").includes("chip-three"), pair.sides.join(" || ").slice(0, 200));
  ok("…and it says the pair is already ruled", /ruled|goes first/i.test(pair.text), pair.text.slice(0, 160));
  eq("the diamond never wears the chips' chevron", pair.chevrons, 0);
  await page.screenshot({ path: path.join(shots, "row-chips-03-collision-expanded-1440x900.png") });

  // ---- 5b. it is a REAL control: keyboard reach, both activation keys, focus ring ---------------------------------
  section("5b. the diamond is keyboard complete: Tab, Space, Enter, Escape, and a focus ring at 3:1");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelectorAll(".rowchip-pop").length === 0, null, { timeout: 10_000 });
  // The walk starts where a keyboard reader's does: the control before it in the same line, then forward, so the caret
  // arrives by Tab and Chromium matches :focus-visible. A programmatic .focus() would not, which is the point.
  ok("the row's ▶ probe is where the walk starts", await page.evaluate((key) => {
    const lead = document.querySelector(`tr.row[data-key="${key}"] .btn-row-agent`);
    if (!lead) return false;
    lead.focus();
    return document.activeElement === lead;
  }, keyOfTree(ONE)));
  let reached = false;
  for (let i = 0; i < 10 && !reached; i += 1) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate((key) => {
      const d = document.querySelector(`tr.row[data-key="${key}"] [data-collision-diamond]`);
      return Boolean(d) && document.activeElement === d;
    }, keyOfTree(ONE));
  }
  ok("Tab reaches the diamond, so it is in the row's tab order", reached);
  const ring = await page.evaluate((key) => {
    const d = document.querySelector(`tr.row[data-key="${key}"] [data-collision-diamond]`);
    if (!d) return null;
    const cs = getComputedStyle(d);
    // The row's own paint behind the ring: an outline at +2px sits OUTSIDE the control, so the walk starts at the
    // control's parent, not at the control's own background.
    let node = d.parentElement;
    let bg = "rgba(0, 0, 0, 0)";
    while (node && (bg === "rgba(0, 0, 0, 0)" || bg === "transparent")) {
      bg = getComputedStyle(node).backgroundColor;
      node = node.parentElement;
    }
    return { focusVisible: d.matches(":focus-visible"), width: parseFloat(cs.outlineWidth), style: cs.outlineStyle, colour: cs.outlineColor, offset: parseFloat(cs.outlineOffset), bg };
  }, keyOfTree(ONE));
  ok("the ring only draws for a keyboard focus", ring && ring.focusVisible, JSON.stringify(ring));
  ok("…and it is a real 2px outline, offset clear of the glyph", ring && ring.width >= 2 && ring.style !== "none" && ring.offset >= 2, JSON.stringify(ring));
  // 3:1 or better, measured, not asserted in a comment: the ring's own ink against the row's paint.
  const ringRatio = ring ? contrast(parseRgb(ring.colour), parseRgb(ring.bg)) : 0;
  console.log(`      focus ring ${ring?.colour} on ${ring?.bg}: ${ringRatio.toFixed(2)}:1`);
  ok("the focus ring clears 3:1 against the row", ringRatio >= 3, `${ringRatio.toFixed(2)}:1`);
  // SPACE: the first activation key. It opens the card, from the caret alone.
  await page.keyboard.press("Space");
  await page.waitForSelector('.rowchip-pop[data-rowchip-pop="collision"]', { timeout: 10_000 });
  ok("SPACE opens the pair card from the caret", (await page.evaluate(() => document.querySelectorAll('.rowchip-pop[data-rowchip-pop="collision"]').length)) === 1);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelectorAll(".rowchip-pop").length === 0, null, { timeout: 10_000 });
  ok("…and Escape hands the caret back to the diamond", (await page.evaluate((key) => document.activeElement === document.querySelector(`tr.row[data-key="${key}"] [data-collision-diamond]`), keyOfTree(ONE))));
  // ENTER: the second. A <button> gets both for free, which is why this is a button and not a decorated span.
  await page.keyboard.press("Enter");
  await page.waitForSelector('.rowchip-pop[data-rowchip-pop="collision"]', { timeout: 10_000 });
  ok("ENTER opens it too", (await page.evaluate(() => document.querySelectorAll('.rowchip-pop[data-rowchip-pop="collision"]').length)) === 1);
  // LEFT OPEN on purpose: the next section repaints the board under an open card, which is the whole point of it.

  // ---- 6. A REPAINT DOES NOT SLAM IT SHUT -------------------------------------------------------------------
  section("6. the page's own repaint leaves the open card open, on the row's NEW diamond");
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

  // ---- 10. every pair resolved: the OUTLINED diamond, and the filled one on an open row -----------------------
  section("10. a row whose every pair is resolved wears the outlined diamond; an open row the filled accented one");
  const quietDiamond = await page.evaluate((key) => {
    const tr = document.querySelector(`tr.row[data-key="${key}"]`);
    const d = tr?.querySelector("[data-collision-diamond]");
    const box = d ? d.getBoundingClientRect() : null;
    return {
      text: (d?.textContent || "").trim(),
      aria: (d?.getAttribute("aria-label") || "").trim(),
      glyph: (d?.querySelector(".collision-diamond-glyph")?.textContent || "").trim(),
      cls: d?.className || "",
      colour: d ? getComputedStyle(d).color : "",
      border: d ? getComputedStyle(d).borderTopColor : "",
      diamonds: tr ? tr.querySelectorAll("[data-collision-diamond]").length : 0,
      box: box ? { w: Math.round(box.width), h: Math.round(box.height) } : null,
      rowHeight: tr ? Math.round(tr.getBoundingClientRect().height * 10) / 10 : 0,
    };
  }, keyOfTree(THREE));
  ok("the fully resolved row draws ONE diamond, with no number in it", quietDiamond.diamonds === 1 && /^\u25c7$/.test(quietDiamond.text), JSON.stringify([quietDiamond.diamonds, quietDiamond.text]));
  ok("…its sentence still carries both numbers in words", /^1 collision, resolved/.test(quietDiamond.aria), quietDiamond.aria);
  ok("…in the QUIET state, never the open one", /is-resolved/.test(quietDiamond.cls) && !/is-open|is-waiting/.test(quietDiamond.cls), quietDiamond.cls);
  eq("…drawn in the muted ink", quietDiamond.colour, "rgb(139, 122, 168)");
  ok("…so the state is in the SHAPE and the ink, not the ink alone", quietDiamond.glyph === "\u25c7" && quietDiamond.border === "rgb(44, 55, 68)", `${quietDiamond.glyph} ${quietDiamond.border}`);
  ok("…and it is still a 24x24 control", quietDiamond.box && quietDiamond.box.w >= 24 && quietDiamond.box.h >= 24, JSON.stringify(quietDiamond.box));
  const liveDiamond = await page.evaluate((key) => {
    const tr = document.querySelector(`tr.row[data-key="${key}"]`);
    const d = tr?.querySelector("[data-collision-diamond]");
    return {
      cls: d?.className || "",
      glyph: (d?.querySelector(".collision-diamond-glyph")?.textContent || "").trim(),
      colour: d ? getComputedStyle(d).color : "",
      rowHeight: tr ? Math.round(tr.getBoundingClientRect().height * 10) / 10 : 0,
    };
  }, keyOfTree(TWO));
  ok("a row with a pair still open keeps the FILLED diamond", /is-open|is-waiting/.test(liveDiamond.cls) && liveDiamond.glyph === "\u25c6", `${liveDiamond.cls} ${liveDiamond.glyph}`);
  // Two violet inks, one meaning: the base violet for a pair with the assistants, the brighter one for a pair waiting
  // on the reader. Both are the OPEN pair's; the muted #8b7aa8 is the resolved one's alone.
  ok("…in a violet ink, not the muted resolved one", ["rgb(201, 160, 255)", "rgb(228, 200, 255)"].includes(liveDiamond.colour), liveDiamond.colour);
  // NO REFLOW, both states: the two diamonds measure the same and neither row is taller than the other.
  ok("the two states are the SAME SIZE, so a state change does not shift the row", quietDiamond.box && Math.abs(quietDiamond.box.w - 24) <= 1 && Math.abs(quietDiamond.box.h - 24) <= 1, JSON.stringify(quietDiamond.box));
  ok("…and the resolved row is exactly as tall as the open one", Math.abs(quietDiamond.rowHeight - liveDiamond.rowHeight) <= 0.5, `${quietDiamond.rowHeight} vs ${liveDiamond.rowHeight}`);
  await page.screenshot({ path: path.join(shots, "row-chips-05-muted-diamond-1440x900.png") });

  eq("no page error was raised while driving the board", pageErrors.length, 0, pageErrors.slice(0, 3).join(" | "));
  return { checks, failures, shots };
});

console.log(`\n-- ${result.checks} checks, ${result.failures} failed`);
console.log(`      screenshots: ${result.shots}`);
process.exit(result.failures === 0 ? 0 : 1);
