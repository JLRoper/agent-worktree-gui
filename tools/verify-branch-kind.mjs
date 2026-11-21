// tools/verify-branch-kind.mjs - the kind a cut recorded, in a COLUMN OF ITS OWN beside the verdict, with the lift
// control that was missing.
//
//   node tools/verify-branch-kind.mjs
//   PANEL_SHOTS_DIR=docs/assets/branch-kind-column node tools/verify-branch-kind.mjs
//
// WHAT THIS IS. lib/branch-kind.js closes the vocabulary at two kinds: a TURNOVER CHILD (cut from a turnover branch,
// with a destination on the remote) and a RESEARCH TREE (cut from the project's main parent, LOCAL ONLY - its push
// meets a refusal until the reader lifts it). The kind is written at the cut into ~/.wag/state/branch-parents.json.
// Until the 1.146.0 landing the page drew NONE of it; that landing put the mark INSIDE the verdict cell and the cell
// then clipped the words the reader needs (PR #821: an R chip where ON MAIN and MERGED used to be). This gate asserts
// the split: the verdict cell is the badge alone, the kind is a column of its own immediately to its left, and the
// column is a switch in the same panel as every other column.
//
// WHAT IS DRIVEN, AND WHY EACH ONE MATTERS
//   1. the record: /api/state stamps branchKind, branchKindLabel, branchKindLifted and branchKindParent from the book,
//      on exactly the rows that have a record - and a row with none carries no field at all
//   2. THE SPLIT: td.verdict holds the badge and NOTHING ELSE (its text is the badge's own text, from UNMERGED to
//      MERGED), td.kind holds the one-letter mark, the mark is in neither td.verdict nor td.name, and the column has
//      its own header in the chart's own order, immediately left of Verdict
//   3. the kind is a statement for a turnover child (a span with role=img and an accessible name) and a real CONTROL
//      for an unlifted research tree (a button with an aria-label, a title and a focus ring, reached by Tab)
//   4. THE COLUMN IS A SWITCH: its box lives in Settings > Board > Chart columns and starts on; unchecking it takes
//      the header and every cell away while the verdict cell keeps reading the badge alone, and checking it again
//      brings both back - so the mark is not a cell that cannot be hidden
//   5. the confirm: Enter opens it under that row, the keyboard rests on Cancel, the sentence says the one thing the
//      lift does (the tree's push stops meeting the research refusal), and Escape closes it back onto R
//   6. the refusal: a branch with no record answers the real route with its 404 and the page draws that sentence in
//      the confirm and the banner - not a silent no-op
//   7. THE LIFT STILL WORKS FROM THE NEW COLUMN: pressing it writes lifted:true on the record (read back from the FILE
//      on disk, so a restart keeps it), the row turns into R with a tick in td.kind, and the kind itself is still
//      research
//   8. the Worktrees tab draws the same pair, and its R is the same button
//   9. the cut dialog still offers exactly the two kinds from GET /api/branch-kinds, pre-selects NEITHER, and a cut
//      that picks turnover records kind:turnover with the parent it was cut from - the recording path is unchanged
//  10. no page errors
//  11. the four rows the landing note photographs (research, turnover, a landed MERGED row, the lifted row) are shot
//      at 1440x900 AND at 768 wide, so a narrow board is proved too
//
// The panel under test is a SECOND instance on a port the OS says is free (tools/panel-testkit.mjs `freePort`), and
// the fixture is shared with tools/capture-kind-column.mjs (tools/kind-fixture.mjs) so the before/after pictures and
// this gate are taken over the same five rows.
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright, openSettingsGroup } from "./browser.mjs";
import { startPanel, waitFor, waitForState } from "./panel-testkit.mjs";
import { buildKindFixture, KIND_TREES } from "./kind-fixture.mjs";

let failures = 0;
let checks = 0;
const check = (name, got, want) => {
  checks += 1;
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (!same) failures += 1;
  console.log(`${same ? "PASS" : "FAIL"}  ${name}${same ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` - ${extra}` : ""}`);
  }
};
const note = (text) => console.log(`      ${text}`);

const pw = loadPlaywright();
if (!pw) {
  console.log("BROWSER-NOT-RUN  the kind and its lift were not exercised in a browser.");
  console.log("  re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-branch-kind.mjs");
  process.exit(2);
}

// ---- the sandbox: five rows, two kinds, a landed MERGED row, one row with no record ----------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-branch-kind-"));
const fx = buildKindFixture(dir);
const bookFile = fx.bookFile;

const shotsDir = process.env.PANEL_SHOTS_DIR ? path.resolve(process.cwd(), process.env.PANEL_SHOTS_DIR) : path.join(dir, "shots");
mkdirSync(shotsDir, { recursive: true });

const panel = await startPanel({
  dir,
  config: {
    branchParentsFile: bookFile,
    sameRepoScan: true,
    scanMode: "all",
    defaultCwd: fx.repo,
    refreshSeconds: 4,
    worktreeSeconds: 2,
    midSeconds: 8,
    dormantSeconds: 15,
    slowSeconds: 20,
    fetchSeconds: 3600,
    threads: 1,
    apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
    assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
  },
});
note(`second panel instance on free port ${panel.port} (config ${panel.configPath})`);
const base = panel.base;
const getJson = async (url, opts = undefined) => {
  const r = await fetch(`${base}${url}`, opts);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const stateNow = async () => (await getJson("/api/state")).body;
const rowsOf = (snap) => (snap.projects || []).flatMap((p) => p.worktrees || []);
const rowEnding = (snap, sfx) => rowsOf(snap).find((r) => String(r.path || "").replace(/\\/g, "/").toLowerCase().endsWith(String(sfx).toLowerCase()));

let browser = null;
let shots = 0;
// A row is photographed as the ROW ITSELF, at both widths the landing note names. The clip is taken from the row's own
// box and shot at PAGE level rather than through the element: the panel repaints its rows on a timer, and an element
// shot waits for the node to stop being replaced, which a live row never is.
const shoot = async (page, sel, label) => {
  for (const [w, h] of [[1440, 900], [768, 900]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(200);
    const row = page.locator(sel);
    await row.scrollIntoViewIfNeeded().catch(() => {});
    const box = await row.boundingBox();
    if (!box) {
      note(`the ${label} row is not on screen at ${w}; no shot`);
      continue;
    }
    shots += 1;
    const file = path.join(shotsDir, `${String(shots).padStart(2, "0")}-${label}-${w}x${h}.png`);
    await page.screenshot({ path: file, clip: { x: box.x, y: box.y, width: box.width, height: box.height }, animations: "disabled" });
    note(`shot ${file}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
};

try {
  // ---- 1. the record, as the server stamps it -------------------------------------------------
  let snap;
  try {
    snap = await waitForState(base, (s) => {
      const rows = rowsOf(s);
      // A row served from the cached tree list reads "…" until its own read lands (lib/tree-cache.js). The verdict's
      // WORDS are what this gate is about, so it waits for the two rows whose words it asserts on (the research tree
      // and the landed MERGED row). The turnover child is NOT waited for: a tree cut from a turnover branch is the
      // last the one-threaded reader gets to, and how long that takes is not this gate's subject.
      const read = (sfx) => {
        const row = rowEnding(s, sfx);
        return row && String(row.verdict || "") !== "…" && String(row.verdict || "") !== "";
      };
      return rows.length >= 5 && read(fx.suffixes.research) && read(fx.suffixes.landed);
    }, "the sandbox repo, its four trees, and the verdicts this gate asserts on", { timeout: 120_000 });
  } catch (err) {
    const seen = await stateNow().catch(() => ({}));
    note(`the snapshot when the wait gave up: ${JSON.stringify(rowsOf(seen).map((r) => [String(r.path || "").split(/[\\/]/).pop(), r.verdict, r.branchKind]))}`);
    throw err;
  }
  const researchRow = rowEnding(snap, fx.suffixes.research);
  const childRow = rowEnding(snap, fx.suffixes.child);
  const landedRow = rowEnding(snap, fx.suffixes.landed);
  const parentRow = rowEnding(snap, fx.suffixes.parent);
  ok("the scan found the research tree, the turnover child, the landed tree and the parent they were cut from", Boolean(researchRow && childRow && landedRow && parentRow));
  const fields = (r) => [r?.branchKind, r?.branchKindLabel, r?.branchKindLifted, r?.branchKindParent];
  check("the research tree carries the kind its cut recorded", fields(researchRow), ["research", "research tree", false, "main"]);
  check("the turnover child carries its own kind and the parent it was cut from", fields(childRow), ["turnover", "turnover child", false, fx.suffixes.parent]);
  ok("a row with no record carries no kind field at all, not a guessed third kind", !("branchKind" in parentRow) && !("branchKindLifted" in parentRow), JSON.stringify(Object.keys(parentRow || {}).filter((k) => k.startsWith("branchKind"))));
  check("the landed tree's verdict reads MERGED, so its badge carries words to clip", String(landedRow?.verdict || "").startsWith("MERGED"), true);
  const kinds = await getJson("/api/branch-kinds");
  check("GET /api/branch-kinds still answers exactly the closed vocabulary", kinds.body.kinds, ["turnover", "research"]);
  check("... and still offers the two cut choices to the dialog", (kinds.body.choices || []).map((c) => c.value), ["turnover", "research"]);

  // ---- the browser ---------------------------------------------------------------------------
  browser = await pw.chromium.launch({ headless: true }).catch(async (err) => {
    // A host can carry the full chromium build and not the headless shell Playwright prefers. tools/browser.mjs
    // `withBrowser` makes the same fallback; this harness owns its launch, so it makes it here and NAMES it.
    if (!/Executable doesn't exist|headless[_-]shell/i.test(String((err && err.message) || err))) throw err;
    console.log("BROWSER  the headless shell binary is not installed - launching the full chromium build instead");
    return pw.chromium.launch({ headless: true, channel: "chromium" });
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const pageErrors = [];
  const liftCalls = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/worktree/kind-lift")) liftCalls.push({ sent: r.postData() });
  });
  page.on("response", (r) => {
    if (r.url().includes("/api/worktree/kind-lift")) liftCalls.push({ status: r.status() });
  });
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${String((e && e.message) || e)}`));
  page.on("console", (m) => {
    // The refusal section below asks the real route for a record that is not there, so ONE 404 is the proof, not a
    // defect. Every other console error is still a failure.
    if (m.type() === "error" && !/Failed to load resource: the server responded with a status of 404/.test(m.text())) {
      pageErrors.push(`console.error: ${m.text()}`);
    }
  });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  // The project folder starts folded in this panel, and a folded section keeps its rows in the DOM but not on screen.
  // Open it the way a reader does, then read the rows.
  const projectUp = await waitFor(async () => (await page.locator("section.project[data-project]").count()) > 0, { timeoutMs: 60_000, what: "the project on the board" });
  ok("the project is on the board", projectUp);
  for (const head of await page.locator("section.project > .project-head[data-toggle-project]").all()) {
    const section = head.locator("xpath=..");
    const cls = await section.getAttribute("class");
    if (cls && cls.includes("collapsed")) await head.click();
  }
  await page.waitForSelector("tr.row[data-key]", { timeout: 30_000 });
  const RESEARCH = `#projects tr.row[data-key*="${fx.suffixes.research}"]`;
  const CHILD = `#projects tr.row[data-key*="${fx.suffixes.child}"]`;
  const LANDED = `#projects tr.row[data-key*="${fx.suffixes.landed}"]`;
  const rowCount = await waitFor(async () => (await page.locator("tr.row[data-key]").count()) >= 5, { timeoutMs: 30_000, what: "five rows on the board" });
  ok("the board draws the project and its four trees", rowCount);
  // The page paints from the same snapshot the assertions above read, but its first paint can be the cached "...". Wait
  // for the rows' own verdicts to be on screen before measuring the cells.
  const verdictsOnScreen = await waitFor(
    async () => {
      const st = await page.evaluate(([a, b]) => {
        const text = (sel) => document.querySelector(sel)?.textContent.trim() || "";
        return { research: text(a), landed: text(b) };
      }, [`${RESEARCH} td.verdict`, `${LANDED} td.verdict`]);
      return Boolean(st.research && st.research !== "…" && st.landed && st.landed !== "…");
    },
    { timeoutMs: 30_000, what: "both verdicts drawn on screen" },
  );
  ok("the page draws both verdicts, not the cached unknown", verdictsOnScreen);

  const PARENT = `#projects tr.row[data-key*="${fx.suffixes.parent}"]`;
  const markState = (selector) =>
    page.evaluate((sel) => {
      const tr = document.querySelector(sel);
      if (!tr) return null;
      const mark = tr.querySelector("td.kind .kind-mark");
      const nameEl = tr.querySelector("td.name .row-name");
      const nameCell = tr.querySelector("td.name");
      const badge = tr.querySelector("td.verdict .badge");
      const verdict = tr.querySelector("td.verdict");
      const kindCell = tr.querySelector("td.kind");
      const head = tr.closest("table")?.tHead?.rows?.[0];
      return {
        markTag: mark ? mark.tagName.toLowerCase() : "",
        text: mark ? mark.textContent.replace(/\s+/g, " ").trim() : "",
        aria: mark?.getAttribute("aria-label") || "",
        title: mark?.getAttribute("title") || "",
        role: mark?.getAttribute("role") || "",
        isButton: mark?.tagName === "BUTTON",
        width: mark ? Math.round(mark.getBoundingClientRect().width * 10) / 10 : 0,
        height: mark ? Math.round(mark.getBoundingClientRect().height * 10) / 10 : 0,
        inKind: Boolean(mark && mark.closest("td")?.classList.contains("kind")),
        inVerdict: Boolean(mark && mark.closest("td.verdict")),
        inName: Boolean(mark && mark.closest("td.name")),
        lifted: Boolean(mark?.classList.contains("is-lifted")),
        kindCell: Boolean(kindCell),
        kindText: kindCell ? kindCell.textContent.replace(/\s+/g, " ").trim() : "",
        kindEmpty: Boolean(kindCell && kindCell.textContent.trim() === "" && !kindCell.querySelector(".kind-mark")),
        verdictText: verdict ? verdict.textContent.replace(/\s+/g, " ").trim() : "",
        verdictMarks: verdict ? verdict.querySelectorAll(".kind-mark").length : 0,
        badgeText: badge?.textContent?.replace(/\s+/g, " ").trim() || "",
        kindHeader: head?.querySelector('th[data-col-id="kind"]')?.textContent?.trim() || "",
        kindBeforeVerdict: head ? [...head.cells].map((c) => c.dataset.colId).indexOf("verdict") - [...head.cells].map((c) => c.dataset.colId).indexOf("kind") : 0,
        nameText: (nameEl?.textContent || "").trim(),
        nameWidth: nameEl ? Math.round(nameEl.getBoundingClientRect().width) : 0,
        nameWhole: Boolean(nameEl && nameEl.scrollWidth <= nameEl.clientWidth + 1),
        nameCellWidth: nameCell ? Math.round(nameCell.getBoundingClientRect().width) : 0,
        verdictWidth: Math.round(verdict?.getBoundingClientRect().width || 0),
        badgeWidth: Math.round(badge?.getBoundingClientRect().width || 0),
        kindWidth: Math.round(kindCell?.getBoundingClientRect().width || 0),
        badgeWhole: Boolean(badge && badge.scrollWidth <= badge.clientWidth + 1),
      };
    }, selector);

  // ---- 2. THE SPLIT: the verdict cell is the badge alone; the kind has its own column -----------
  const research = await markState(RESEARCH);
  check("the research row draws R in td.kind", [research.text, research.inKind, research.inVerdict, research.inName], ["R", true, false, false]);
  ok("the verdict cell holds NO kind mark at all", research.verdictMarks === 0, `${research.verdictMarks} marks in td.verdict`);
  check("...so its text is exactly the badge's own text", research.verdictText, research.badgeText);
  ok("...which is the words the reader needs, not a clipped fragment", /^UNMERGED|^NO COMMITS|^MERGED|^ON MAIN/.test(research.badgeText), research.badgeText);
  check("the column has its own header, immediately left of Verdict", [research.kindHeader, research.kindBeforeVerdict], ["Kind", 1]);
  check("...as a real button, because an unlifted research tree has something to do", research.markTag, "button");
  ok("...with an accessible name that spells the kind out", /research tree/i.test(research.aria) && /lift/i.test(research.aria), research.aria);
  ok("...and a title that says when its push is refused and what pressing does", /research refusal/i.test(research.title) && /press to lift/i.test(research.title), research.title);
  ok("the mark is one letter, not a chip with a sentence in it", research.width > 0 && research.width <= 24, `${research.width}px wide, ${research.height}px tall`);
  ok("...inside a column wide enough to draw it whole", research.kindWidth >= Math.ceil(research.width), `${research.width}px mark in a ${research.kindWidth}px cell`);
  ok("the name is still drawn whole beside them", research.nameWhole && research.nameText === "research-probe-aaaa11", `${research.nameText}, ${research.nameWidth}px of ${research.nameCellWidth}px`);
  ok("the badge owns the whole cell, so nothing shares it with the words", research.badgeWidth >= research.verdictWidth - 24, `badge ${research.badgeWidth}px in a ${research.verdictWidth}px cell`);
  await shoot(page, RESEARCH, "research-row");

  const child = await markState(CHILD);
  check("the turnover row draws T in td.kind", [child.text, child.inKind, child.inVerdict, child.inName], ["T", true, false, false]);
  check("...as a statement, not a control: a turnover child already has a destination", [child.markTag, child.role], ["span", "img"]);
  ok("...with an accessible name of its own", /turnover child/i.test(child.aria), child.aria);
  ok("...and no button in the column", !child.isButton);
  check("the turnover verdict cell is the badge alone too", [child.verdictMarks, child.verdictText], [0, child.badgeText]);
  ok("the turnover name is drawn whole too", child.nameWhole, `${child.nameText}, ${child.nameWidth}px`);
  await shoot(page, CHILD, "turnover-row");

  // THE ROW THE READER COMPLAINED ABOUT: a landed tree whose badge says MERGED, carrying a research record. Before this
  // branch the mark led the badge IN THIS CELL and MERGED was the part that got clipped.
  const landed = await markState(LANDED);
  ok("the landed row's badge reads MERGED in full", /^MERGED \(1 commit\)/.test(landed.badgeText), landed.badgeText);
  check("...and its verdict cell is that badge alone, with the R in the Kind column", [landed.verdictMarks, landed.verdictText, landed.text, landed.inKind], [0, landed.badgeText, "R", true]);
  ok("...so the badge has the cell to itself, with no mark beside it eating its pixels", landed.badgeWidth >= landed.verdictWidth - 24 && landed.verdictText === landed.badgeText, `${landed.verdictText}: badge ${landed.badgeWidth}px in a ${landed.verdictWidth}px cell`);
  // The width budget: a column added beside the verdict is paid for out of other columns' floors (public/charts.js),
  // and if it is not, `columnPlan` scales the whole chart down and the verdict loses the pixel that showed
  // "MERGED (1..." instead of "MERGED (...". This asserts the cell kept the floor it had before the mark existed.
  ok("the Kind column did not shave the verdict cell: it keeps its 104px floor at 1440", landed.verdictWidth >= 104, `${landed.verdictWidth}px`);
  await shoot(page, LANDED, "landed-merged-row");

  const parent = await markState(PARENT);
  ok("the parent turnover row, which has no record, draws no mark at all", parent && !parent.markTag && parent.kindEmpty, parent ? JSON.stringify(parent.kindText) : "no row");
  check("...and its verdict cell is still the badge alone", [parent.verdictMarks, parent.verdictText], [0, parent.badgeText]);

  const legend = await page.evaluate(() => {
    const l = document.querySelector("section.project .legend");
    return {
      hasT: Boolean(l?.querySelector(".kind-mark.kind-turnover")),
      hasR: Boolean(l?.querySelector(".kind-mark.kind-research")),
      text: (l?.textContent || "").replace(/\s+/g, " ").trim(),
    };
  });
  ok("the chart's legend decodes both letters", legend.hasT && legend.hasR && /turnover child/.test(legend.text) && /research tree/.test(legend.text), legend.hasT && legend.hasR ? "T and R in the legend" : "missing");
  ok("...and names the column they live in, rather than the verdict cell", /the kind column/i.test(legend.text) && !/verdict cell/i.test(legend.text), legend.text.slice(0, 140));

  // ---- 3. THE COLUMN IS A SWITCH, in the same panel as every other column ----------------------
  await openSettingsGroup(page, "board");
  await page.waitForSelector('#chart-cols input[data-chart-col="kind"]', { state: "visible", timeout: 10_000 });
  const kindBox = page.locator('#chart-cols input[data-chart-col="kind"]');
  const kindSwitch = await page.evaluate(() => {
    const box = document.querySelector('#chart-cols input[data-chart-col="kind"]');
    return { checked: box ? box.checked : null, chip: Boolean(document.querySelector('#chart-cols label[data-chart-chip="kind"]')), count: document.querySelector("#chart-cols-count")?.textContent || "" };
  });
  check("the Kind column has a box in Settings > Board > Chart columns, and it starts on", [kindSwitch.checked, kindSwitch.chip], [true, false]);
  ok("...and the row's own counter counts it", /^15\/15$/.test(kindSwitch.count), kindSwitch.count);
  await kindBox.click();
  const kindHidden = await waitFor(
    async () =>
      page.evaluate(() => {
        const th = document.querySelector('thead th[data-col-id="kind"]');
        const cells = [...document.querySelectorAll("#projects tr.row[data-key]")];
        return !th && cells.length > 0 && cells.every((tr) => !tr.querySelector("td.kind"));
      }),
    { timeoutMs: 15_000, what: "the Kind header and cells gone" },
  );
  ok("unchecking it takes the header and every cell away", kindHidden);
  const verdictWhileHidden = await page.evaluate((sel) => document.querySelector(`${sel} td.verdict`)?.textContent.replace(/\s+/g, " ").trim() || "", LANDED);
  check("...while the landed row's verdict still reads the badge alone", verdictWhileHidden, landed.badgeText);
  await kindBox.click();
  const kindShown = await waitFor(
    async () =>
      page.evaluate(() => {
        const th = document.querySelector('thead th[data-col-id="kind"]');
        const cells = [...document.querySelectorAll("#projects tr.row[data-key]")];
        return Boolean(th) && cells.length > 0 && cells.every((tr) => Boolean(tr.querySelector("td.kind")));
      }),
    { timeoutMs: 15_000, what: "the Kind header and cells back" },
  );
  ok("checking it again brings the column back on every row", kindShown);
  await page.click("#btn-settings");
  await waitFor(async () => !(await page.locator("#settings").isVisible()), { timeoutMs: 10_000, what: "the settings drawer to close" });

  // ---- 4. the Worktrees tab draws the same pair ------------------------------------------------
  await page.locator("#btn-assistant").click();
  await page.waitForSelector("#assistant", { state: "visible", timeout: 20_000 });
  await page.waitForSelector("#as-assistant-1:not(.hidden)", { timeout: 20_000 });
  await page.locator('#as-subtabs [data-as-subtab="worktrees"]').click();
  const tabUp = await waitFor(async () => (await page.locator("#as-worktrees .as-wtgroup").count()) > 0, { timeoutMs: 20_000, what: "the assistant's grouped worktrees" });
  ok("the assistant's Worktrees tab renders the group", tabUp);
  // The group is a fold card and starts collapsed. Open it the way a reader does: hidden rows in the DOM would prove
  // the builder ran, not that the reader can SEE the pair.
  const group = page.locator('[data-as-wtgroup="kind-repo"]');
  // A press is retried: the pane repaints from the snapshot, and a click that lands during that repaint is lost.
  const tabOpen = await waitFor(
    async () => {
      if ((await group.getAttribute("aria-expanded")) === "true") return true;
      await group.click({ timeout: 2_000 }).catch(() => {});
      return false;
    },
    { timeoutMs: 20_000, stepMs: 400, what: "the project's group to open" },
  );
  ok("... and its project card opens onto the rows", tabOpen);
  const TAB_RESEARCH = `#as-worktrees section.as-wtgroup:not(.collapsed) tr.row[data-key*="${fx.suffixes.research}"]`;
  const TAB_CHILD = `#as-worktrees section.as-wtgroup:not(.collapsed) tr.row[data-key*="${fx.suffixes.child}"]`;
  const tabResearch = tabUp ? await markState(TAB_RESEARCH) : null;
  const tabChild = tabUp ? await markState(TAB_CHILD) : null;
  check("... the research row's R there is the same control, in the same column", [tabResearch?.text, tabResearch?.markTag, tabResearch?.inKind, tabResearch?.verdictMarks], ["R", "button", true, 0]);
  check("... and the turnover row's T is the same statement", [tabChild?.text, tabChild?.markTag, tabChild?.inKind], ["T", "span", true]);
  // No photograph of the pane: at 1440 it is a docked 450px column carrying the board's fifteen-column table, so a
  // picture of it proves the table is narrow, not that the kind is on the rows. The two checks above read the pane's
  // OWN rows (a button R and a span T from the same row builder), which is the fact under test.
  // The ACTION is the same there too: pressing the pane's R asks the question under the pane's own row, not under the
  // board's copy of it.
  if (tabUp) {
    const tabConfirm = await waitFor(
      async () => {
        const under = await page.evaluate(() => {
          const el = document.querySelector("#as-worktrees tr.row-kind-confirm");
          if (!el) return false;
          return (el.previousElementSibling?.getAttribute("data-key") || "").includes("research-probe-aaaa11") ? "under the pane's row" : false;
        });
        if (under) return under;
        await page.locator(`${TAB_RESEARCH} [data-kind-lift]`).click({ timeout: 2_000 }).catch(() => {});
        return false;
      },
      { timeoutMs: 20_000, stepMs: 400, what: "the pane's own lift question" },
    );
    ok("... and pressing it asks the question under the pane's own row", tabConfirm);
    await page.keyboard.press("Escape");
    ok("... Escape leaves no question behind", (await page.locator("#as-worktrees tr.row-kind-confirm").count()) === 0);
  }
  await page.locator("#btn-as-close").click();
  await waitFor(async () => !(await page.locator("#assistant").isVisible()), { timeoutMs: 10_000, what: "the assistant to close" });

  // ---- 5. keyboard: Tab reaches R in its own column, Enter asks, the question says what it does ------
  const beforeTab = await page.evaluate((sel) => {
    const tr = document.querySelector(sel);
    const btn = tr?.querySelector("[data-kind-lift]");
    if (!btn) return { found: false };
    const all = [...document.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => el.getClientRects().length > 0);
    const i = all.indexOf(btn);
    const prev = i > 0 ? all[i - 1] : null;
    if (prev) prev.focus();
    return { found: i > 0, prev: prev ? prev.className || prev.id || prev.tagName : "", active: document.activeElement === prev, inKind: Boolean(btn.closest("td.kind")) };
  }, RESEARCH);
  ok("the lift control sits in td.kind, with a focusable control before it in the row", beforeTab.found && beforeTab.inKind, `${beforeTab.prev}`);
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    const cs = el ? getComputedStyle(el) : null;
    return { isKind: Boolean(el?.matches("[data-kind-lift]")), outline: cs ? `${cs.outlineStyle} ${cs.outlineWidth}` : "", tag: el?.tagName || "" };
  });
  ok("Tab reaches the lift control", focused.isKind, focused.tag);
  ok("... and it draws a focus ring", /^solid/.test(focused.outline) && parseInt(focused.outline.split(" ")[1] || "0", 10) >= 2, focused.outline);
  await page.keyboard.press("Enter");
  const confirm = await page.evaluate(() => {
    const el = document.querySelector("tr.row-kind-confirm");
    if (!el) return null;
    const btns = [...el.querySelectorAll("button")];
    const texts = btns.map((b) => b.textContent.trim());
    return {
      text: el.textContent.replace(/\s+/g, " ").trim(),
      cancel: texts.includes("Cancel"),
      lift: texts.includes("Lift"),
      focus: document.activeElement?.textContent.trim() || "",
      underResearch: (el.previousElementSibling?.getAttribute("data-key") || "").includes("research-probe-aaaa11"),
    };
  });
  ok("Enter opens the lift question under that row", Boolean(confirm && confirm.underResearch));
  ok("... it says the one thing the lift does: the tree's push stops meeting the research refusal", /the tree's push stops meeting the research refusal/i.test(confirm?.text || ""), confirm?.text?.slice(0, 120));
  ok("... and that nothing is pushed and no branch moves", /nothing is pushed and no branch moves/i.test(confirm?.text || ""));
  ok("... the two answers are Cancel and Lift", confirm?.cancel && confirm?.lift);
  ok("... and the keyboard rests on Cancel, not on Lift", confirm?.focus === "Cancel", confirm?.focus);
  await page.keyboard.press("Escape");
  const afterEscape = await page.evaluate(() => ({
    closed: !document.querySelector("tr.row-kind-confirm"),
    backOnR: Boolean(document.activeElement?.matches("[data-kind-lift]")),
  }));
  ok("Escape closes the question and puts the keyboard back on R", afterEscape.closed && afterEscape.backOnR);

  // ---- 6. the refusal: a branch with no record answers with the route's 404, in the question -----
  await page.locator(`${RESEARCH} [data-kind-lift]`).click();
  await page.waitForSelector("tr.row-kind-confirm");
  await shoot(page, "tr.row-kind-confirm", "lift-confirm");
  const mutated = await page.evaluate(() => {
    const el = document.querySelector("tr.row-kind-confirm");
    if (!el) return false;
    // Aim the OPEN question at a name with no record: both the tag in the path and the branch are gone, so the
    // server's own lookup finds nothing. The route is the real one; only this question points at a missing record.
    el.dataset.kindPath = `${el.dataset.kindPath}-no-record`;
    el.dataset.kindBranch = "wtgui/no-record-zzzz99";
    return true;
  });
  ok("the open question can be aimed at a branch with no record", mutated);
  await page.locator("[data-kind-lift-yes]").click();
  const refused = await waitFor(
    async () => {
      const got = await page.evaluate(() => ({
        inConfirm: document.querySelector("tr.row-kind-confirm .rc-refusal")?.textContent?.trim() || "",
        banner: document.querySelector("#banner-text")?.textContent?.trim() || "",
        red: !document.querySelector("#banner")?.classList.contains("hidden"),
      }));
      return got.inConfirm && got.banner ? got : false;
    },
    { timeoutMs: 15_000, what: "the refusal sentence in the confirm and the banner" },
  );
  if (!refused) {
    note(`kind-lift calls: ${JSON.stringify(liftCalls)}`);
  }
  ok("a branch with no record is refused, not silently accepted", Boolean(refused));
  ok("... the server's own sentence is drawn in the question", /no branch-parents record/i.test(refused?.inConfirm || "") && /nothing to lift/i.test(refused?.inConfirm || ""), refused?.inConfirm);
  ok("... and in the banner, where a failure is read", /lift refused/i.test(refused?.banner || "") && /no branch-parents record/i.test(refused?.banner || ""), refused?.banner);
  const stillOpen = await page.evaluate(() => Boolean(document.querySelector("tr.row-kind-confirm") && document.querySelector("[data-kind-lift-yes]:not([disabled])")));
  ok("... the question stays open with Lift pressable again", stillOpen);
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.querySelector("#banner .banner-x")?.click());
  await page.evaluate(() => window.resync?.());
  await waitFor(async () => (await page.locator(`${RESEARCH} [data-kind-lift]`).count()) === 1, { timeoutMs: 15_000, what: "the row back from the refused attempt" });

  // ---- 7. THE LIFT, FROM THE NEW COLUMN: the record on disk, the row, the note ------------------
  await page.locator(`${RESEARCH} [data-kind-lift]`).click();
  await page.waitForSelector("tr.row-kind-confirm");
  await page.locator("[data-kind-lift-yes]").click();
  let liftNote = null;
  const liftedUp = await waitFor(
    async () => {
      const st = await markState(RESEARCH);
      if (!st || !st.lifted || st.isButton) return false;
      liftNote = await page.evaluate(() => ({
        text: document.querySelector("#banner-text")?.textContent?.trim() || "",
        hidden: document.querySelector("#banner")?.classList.contains("hidden") ?? true,
        green: document.querySelector("#banner")?.classList.contains("ok") ?? false,
      }));
      return st;
    },
    { timeoutMs: 20_000, what: "the research row to draw R with a tick" },
  );
  ok("the row turns into R with a tick after the lift, still in td.kind", Boolean(liftedUp) && liftedUp.inKind, liftedUp ? `${liftedUp.text}, ${liftedUp.width}px` : "not lifted");
  ok("... the letter is still R: a lift answers the record, it does not change the kind", liftedUp?.text === "R✓");
  check("... and the verdict cell never moved", [liftedUp?.verdictMarks, liftedUp?.verdictText], [0, liftedUp?.badgeText]);
  ok("... the question is gone", (await page.locator("tr.row-kind-confirm").count()) === 0);
  ok("a green note says what the lift did", /is lifted/.test(liftNote?.text || "") && /ordinary controls/.test(liftNote?.text || "") && liftNote?.green === true && liftNote?.hidden === false, JSON.stringify(liftNote));
  const onDisk = JSON.parse(readFileSync(bookFile, "utf8"));
  check("the record on disk keeps kind:research and now says lifted:true", [onDisk[`tag:${KIND_TREES.research.tag}`].kind, onDisk[`tag:${KIND_TREES.research.tag}`].lifted], ["research", true]);
  const afterSnap = await stateNow();
  check("... and /api/state stamps the lifted row the same way", fields(rowEnding(afterSnap, fx.suffixes.research)), ["research", "research tree", true, "main"]);
  await shoot(page, RESEARCH, "lifted-row");

  // ---- 8. the cut dialog still records the kind the same way ------------------------------------
  await page.locator(`${PARENT} [data-child-tree]`).click();
  const dialog = await waitFor(
    async () => {
      const got = await page.evaluate(() => {
        const el = document.querySelector(".cut-dialog");
        if (!el) return null;
        const opts = [...el.querySelectorAll('input[name="cut-kind"]')].map((i) => ({ kind: i.value, checked: i.checked, label: i.closest("label")?.textContent?.replace(/\s+/g, " ").trim() || "" }));
        return { opts, hasName: Boolean(el.querySelector(".cut-name")), hasGo: Boolean(el.querySelector(".cut-go")) };
      });
      return got || false;
    },
    { timeoutMs: 15_000, what: "the cut dialog" },
  );
  check("the cut dialog offers exactly the two kinds GET /api/branch-kinds answers with", dialog?.opts.map((o) => o.kind), ["turnover", "research"]);
  ok("... pre-selecting neither, so a cut still records only what the reader chose", dialog?.opts.every((o) => !o.checked), JSON.stringify(dialog?.opts.map((o) => o.checked)));
  ok("... with a name field and a Cut button", dialog?.hasName && dialog?.hasGo);
  await shoot(page, ".cut-dialog", "cut-dialog");
  await page.locator('.cut-dialog label:has(input[name="cut-kind"][value="turnover"])').click();
  const chosen = await page.evaluate(() => document.querySelector('.cut-dialog input[name="cut-kind"][value="turnover"]')?.checked === true);
  ok("... and the turnover card is the one chosen", chosen);
  await page.locator(".cut-dialog .cut-name").fill("a-new-turnover-child");
  await page.locator(".cut-dialog .cut-go").click();
  const cutRow = await waitFor(
    async () => {
      const st = await stateNow();
      return rowsOf(st).find((r) => String(r.path || "").replace(/\\/g, "/").toLowerCase().includes("a-new-turnover-child")) || false;
    },
    { timeoutMs: 120_000, what: "the cut tree's row" },
  );
  ok("a cut that chose turnover is recorded and drawn as a turnover child", cutRow && cutRow.branchKind === "turnover" && cutRow.branchKindParent === fx.suffixes.parent, cutRow ? `${cutRow.branchKind} from ${cutRow.branchKindParent}` : "no row");
  // The cut's write is queued (lib/jobs.js `saveParents`, `writeFileQueued`), so read until the record is on disk.
  const cutTail = String(cutRow?.path || "").replace(/\\/g, "/").toLowerCase();
  let cutEntry = null;
  const cutWritten = await waitFor(
    () => {
      const book = JSON.parse(readFileSync(bookFile, "utf8"));
      cutEntry = Object.values(book).find((r) => r && (r.branch === cutRow?.branch || String(r.tree || "").replace(/\\/g, "/").toLowerCase() === cutTail)) || null;
      return Boolean(cutEntry);
    },
    { timeoutMs: 10_000, what: "the cut's record on disk" },
  );
  ok("... the book on disk gained the record the cut always wrote", cutWritten, cutEntry ? JSON.stringify({ kind: cutEntry.kind, parent: cutEntry.parent }) : `keys: ${Object.keys(JSON.parse(readFileSync(bookFile, "utf8"))).join(", ")}`);
  // `lifted` is only written when true (lib/jobs.js `rememberParent`), so absent IS false for a turnover child.
  check("... with the kind the dialog chose, the parent it was cut from, and not lifted", [cutEntry?.kind, cutEntry?.parent, Boolean(cutEntry?.lifted)], ["turnover", fx.suffixes.parent, false]);
  const cutMark = cutRow ? await waitFor(async () => {
    const st = await markState(`tr.row[data-key*="${String(cutRow.path).split("/").pop()}"]`);
    return st && st.text === "T" && st.inKind ? st : false;
  }, { timeoutMs: 20_000, what: "the new row's T" }) : null;
  ok("... and the new row draws T in the Kind column without a reload", Boolean(cutMark), cutMark ? cutMark.text : "none");

  ok("no page errors", pageErrors.length === 0, pageErrors.join(" | "));

  console.log("");
  console.log(`${checks} checks, ${failures} failed`);
  if (shots) console.log(`${shots} screenshots in ${shotsDir}`);
} catch (err) {
  failures += 1;
  console.log(`FAIL  the harness itself: ${String((err && err.stack) || err)}`);
  console.log("");
  console.log(`${checks} checks, ${failures} failed`);
} finally {
  try {
    await browser?.close();
  } catch {
    /* already gone */
  }
  try {
    await panel.stop();
  } catch {
    /* already gone */
  }
  process.exitCode = failures ? 1 : 0;
}
