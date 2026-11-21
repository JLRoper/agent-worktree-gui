// tools/verify-branch-kind.mjs - the kind a cut recorded, ON THE ROW, with the lift control that was missing.
//
//   node tools/verify-branch-kind.mjs
//   PANEL_SHOTS_DIR=docs/assets/branch-kind node tools/verify-branch-kind.mjs
//
// WHAT THIS IS. lib/branch-kind.js closes the vocabulary at two kinds: a TURNOVER CHILD (cut from a turnover branch,
// with a destination on the remote) and a RESEARCH TREE (cut from the project's main parent, LOCAL ONLY - its push
// meets a refusal until the reader lifts it). The kind is written at the cut into ~/.wag/state/branch-parents.json.
// Until this change the page drew NONE of it: a reader finishing a landing on a research tree had to open that JSON
// file, or hand-call POST /api/worktree/kind-lift, because the route had no control in the UI at all.
//
// WHAT IS DRIVEN, AND WHY EACH ONE MATTERS
//   1. the record: /api/state stamps branchKind, branchKindLabel, branchKindLifted and branchKindParent from the book,
//      on exactly the rows that have a record - and a row with none carries no field at all
//   2. the row: ONE LETTER in td.verdict (T or R), never in td.name; the name is still drawn whole; the mark is under
//      24px wide, so it cannot repeat the defect that moved a review chip out of the name line
//   3. the kind is a statement for a turnover child (a span with role=img and an accessible name) and a real CONTROL
//      for an unlifted research tree (a button with an aria-label, a title and a focus ring, reached by Tab)
//   4. the confirm: Enter opens it under that row, the keyboard rests on Cancel, the sentence says the one thing the
//      lift does (the tree's push stops meeting the research refusal), and Escape closes it back onto R
//   5. the refusal: a branch with no record answers the real route with its 404 and the page draws that sentence in
//      the confirm and the banner - not a silent no-op
//   6. the lift: pressing Lift writes lifted:true on the record (read back from the FILE on disk, so a restart keeps
//      it), the row turns into R with a tick, and the kind itself is still research
//   7. the Worktrees tab draws the same pair, and its R is the same button
//   8. the cut dialog still offers exactly the two kinds from GET /api/branch-kinds, pre-selects NEITHER, and a cut
//      that picks turnover records kind:turnover with the parent it was cut from - the recording path is unchanged
//   9. no page errors
//
// The panel under test is a SECOND instance on a port the OS says is free (tools/panel-testkit.mjs `freePort`).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright } from "./browser.mjs";
import { git, slash, startPanel, waitFor, waitForState } from "./panel-testkit.mjs";

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

// ---- the sandbox: three trees, two kinds, one row with no record ---------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-branch-kind-"));
const reposDir = path.join(dir, "repos");
const repo = path.join(reposDir, "kind-repo");
const TURNOVER_BRANCH = "20261112_0900_DMR-44001_the_turnover";
const PARENT_TREE = path.join(repo, ".worktrees", TURNOVER_BRANCH);
const RESEARCH_TREE = path.join(repo, ".worktrees", "research-probe-aaaa11");
const RESEARCH_BRANCH = "wtgui/research-probe-aaaa11";
const CHILD_TREE = path.join(repo, ".worktrees", "turnover-child-bbbb22");
const CHILD_BRANCH = "wtgui/turnover-child-bbbb22";
for (const d of [repo, path.join(repo, ".worktrees")]) mkdirSync(d, { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# kind sandbox\n", "utf8");
git(repo, ["add", "-A"]);
git(repo, ["commit", "-q", "-m", "seed the sandbox repo"]);
// The turnover branch the parent row stands on (no record: it was cut before the kind rule, which is the normal
// absence, and no mark is drawn for it).
git(repo, ["worktree", "add", "-q", "-b", TURNOVER_BRANCH, PARENT_TREE]);
// A research tree cut from main: local only, its push refused until lifted.
git(repo, ["worktree", "add", "-q", "-b", RESEARCH_BRANCH, RESEARCH_TREE, "main"]);
// A turnover child cut from the turnover branch: it has a destination on the remote.
git(repo, ["worktree", "add", "-q", "-b", CHILD_BRANCH, CHILD_TREE, TURNOVER_BRANCH]);

// The book the panel boots with. Keys are the panel's own: tag:<six hex> (lib/jobs.js `treeParentKey`), which the
// directory names carry, so a branch renamed later still finds its record.
const bookFile = path.join(dir, "branch-parents.json");
const iso = new Date().toISOString();
const writeBook = (extra = null) => {
  const book = {
    "tag:aaaa11": { parent: "main", branch: RESEARCH_BRANCH, tree: slash(RESEARCH_TREE), kind: "research", lifted: false, at: iso },
    "tag:bbbb22": { parent: TURNOVER_BRANCH, branch: CHILD_BRANCH, tree: slash(CHILD_TREE), kind: "turnover", lifted: false, at: iso },
  };
  if (extra) Object.assign(book, extra);
  writeFileSync(bookFile, `${JSON.stringify(book, null, 2)}\n`, "utf8");
  return book;
};
writeBook();

const shotsDir = process.env.PANEL_SHOTS_DIR ? path.resolve(process.cwd(), process.env.PANEL_SHOTS_DIR) : path.join(dir, "shots");
mkdirSync(shotsDir, { recursive: true });

const panel = await startPanel({
  dir,
  config: {
    branchParentsFile: bookFile,
    sameRepoScan: true,
    scanMode: "all",
    defaultCwd: repo,
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
const rowEnding = (snap, sfx) => rowsOf(snap).find((r) => slash(r.path).toLowerCase().endsWith(sfx));

let browser = null;
let shots = 0;
const shot = async (page, name, clip = null) => {
  shots += 1;
  const file = path.join(shotsDir, `${String(shots).padStart(2, "0")}-${name}-1440x900.png`);
  await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
  note(`shot ${file}`);
  return file;
};
const clipOf = async (page, ...selectors) =>
  page.evaluate((sels) => {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }
    if (!Number.isFinite(left)) return null;
    const pad = 2;
    return {
      x: Math.max(0, left + window.scrollX - pad),
      y: Math.max(0, top + window.scrollY - pad),
      width: right - left + pad * 2,
      height: bottom - top + pad * 2,
    };
  }, selectors);

try {
  // ---- 1. the record, as the server stamps it -------------------------------------------------
  const snap = await waitForState(base, (s) => rowsOf(s).length >= 4, "the sandbox repo and its three trees");
  const researchRow = rowEnding(snap, "research-probe-aaaa11");
  const childRow = rowEnding(snap, "turnover-child-bbbb22");
  const parentRow = rowEnding(snap, `the_turnover`);
  ok("the scan found the research tree, the turnover child and the parent they were cut from", Boolean(researchRow && childRow && parentRow));
  const fields = (r) => [r?.branchKind, r?.branchKindLabel, r?.branchKindLifted, r?.branchKindParent];
  check("the research tree carries the kind its cut recorded", fields(researchRow), ["research", "research tree", false, "main"]);
  check("the turnover child carries its own kind and the parent it was cut from", fields(childRow), ["turnover", "turnover child", false, TURNOVER_BRANCH]);
  ok("a row with no record carries no kind field at all, not a guessed third kind", !("branchKind" in parentRow) && !("branchKindLifted" in parentRow), JSON.stringify(Object.keys(parentRow || {}).filter((k) => k.startsWith("branchKind"))));
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
  const rowCount = await waitFor(async () => (await page.locator("tr.row[data-key]").count()) >= 4, { timeoutMs: 30_000, what: "four rows on the board" });
  ok("the board draws the project and its three trees", rowCount);

  const RESEARCH = '#projects tr.row[data-key*="research-probe-aaaa11"]';
  const CHILD = '#projects tr.row[data-key*="turnover-child-bbbb22"]';
  const PARENT = `#projects tr.row[data-key*="the_turnover"]`;
  const markState = (selector) =>
    page.evaluate((sel) => {
      const tr = document.querySelector(sel);
      if (!tr) return null;
      const mark = tr.querySelector("td.verdict .kind-mark");
      const nameEl = tr.querySelector("td.name .row-name");
      const nameCell = tr.querySelector("td.name");
      const badge = tr.querySelector("td.verdict .badge");
      return {
        markTag: mark ? mark.tagName.toLowerCase() : "",
        text: mark ? mark.textContent.replace(/\s+/g, " ").trim() : "",
        aria: mark?.getAttribute("aria-label") || "",
        title: mark?.getAttribute("title") || "",
        role: mark?.getAttribute("role") || "",
        isButton: mark?.tagName === "BUTTON",
        width: mark ? Math.round(mark.getBoundingClientRect().width * 10) / 10 : 0,
        height: mark ? Math.round(mark.getBoundingClientRect().height * 10) / 10 : 0,
        inVerdict: Boolean(mark && mark.closest("td")?.classList.contains("verdict")),
        inName: Boolean(mark && mark.closest("td.name")),
        lifted: Boolean(mark?.classList.contains("is-lifted")),
        nameText: (nameEl?.textContent || "").trim(),
        nameWidth: nameEl ? Math.round(nameEl.getBoundingClientRect().width) : 0,
        nameWhole: Boolean(nameEl && nameEl.scrollWidth <= nameEl.clientWidth + 1),
        nameCellWidth: nameCell ? Math.round(nameCell.getBoundingClientRect().width) : 0,
        verdictWidth: Math.round(tr.querySelector("td.verdict")?.getBoundingClientRect().width || 0),
        badge: badge?.textContent?.trim() || "",
      };
    }, selector);

  // ---- 2. the row: one letter, in the verdict cell, clear of the name --------------------------
  const research = await markState(RESEARCH);
  check("the research row draws R in td.verdict", [research.text, research.inVerdict, research.inName], ["R", true, false]);
  check("... as a real button, because an unlifted research tree has something to do", research.markTag, "button");
  ok("... with an accessible name that spells the kind out", /research tree/i.test(research.aria) && /lift/i.test(research.aria), research.aria);
  ok("... and a title that says when its push is refused and what pressing does", /research refusal/i.test(research.title) && /press to lift/i.test(research.title), research.title);
  ok("the mark is one letter, not a chip with a sentence in it", research.width > 0 && research.width <= 24, `${research.width}px wide, ${research.height}px tall`);
  ok("the name is still drawn whole beside it", research.nameWhole && research.nameText === "research-probe-aaaa11", `${research.nameText}, ${research.nameWidth}px of ${research.nameCellWidth}px`);
  const researchShot = await shot(page, "research-row", await clipOf(page, RESEARCH));

  const child = await markState(CHILD);
  check("the turnover row draws T in td.verdict", [child.text, child.inVerdict, child.inName], ["T", true, false]);
  check("... as a statement, not a control: a turnover child already has a destination", [child.markTag, child.role], ["span", "img"]);
  ok("... with an accessible name of its own", /turnover child/i.test(child.aria), child.aria);
  ok("... and no button in the cell's mark position", !child.isButton);
  ok("the turnover name is drawn whole too", child.nameWhole, `${child.nameText}, ${child.nameWidth}px`);
  const childShot = await shot(page, "turnover-row", await clipOf(page, CHILD));

  const parent = await markState(PARENT);
  ok("the parent turnover row, which has no record, draws no mark at all", parent && !parent.markTag, parent ? JSON.stringify(parent.text) : "no row");
  ok("the verdict cell is still the badge when there is no kind", parent && parent.badge.length > 0, parent?.badge);

  const legend = await page.evaluate(() => {
    const l = document.querySelector("section.project .legend");
    return {
      hasT: Boolean(l?.querySelector(".kind-mark.kind-turnover")),
      hasR: Boolean(l?.querySelector(".kind-mark.kind-research")),
      text: (l?.textContent || "").replace(/\s+/g, " ").trim(),
    };
  });
  ok("the chart's legend decodes both letters", legend.hasT && legend.hasR && /turnover child/.test(legend.text) && /research tree/.test(legend.text), legend.hasT && legend.hasR ? "T and R in the legend" : "missing");

  // ---- 3. the Worktrees tab draws the same pair ------------------------------------------------
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
  const TAB_RESEARCH = '#as-worktrees section.as-wtgroup:not(.collapsed) tr.row[data-key*="research-probe-aaaa11"]';
  const TAB_CHILD = '#as-worktrees section.as-wtgroup:not(.collapsed) tr.row[data-key*="turnover-child-bbbb22"]';
  const tabResearch = tabUp ? await markState(TAB_RESEARCH) : null;
  const tabChild = tabUp ? await markState(TAB_CHILD) : null;
  check("... the research row's R there is the same control", [tabResearch?.text, tabResearch?.markTag], ["R", "button"]);
  check("... and the turnover row's T is the same statement", [tabChild?.text, tabChild?.markTag], ["T", "span"]);
  // No photograph of the pane: at 1440 it is a docked 450px column carrying the board's fourteen-column table, so a
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

  // ---- 4. keyboard: Tab reaches R, Enter asks, the question says what it does -------------------
  const beforeTab = await page.evaluate((sel) => {
    const tr = document.querySelector(sel);
    const btn = tr?.querySelector("[data-kind-lift]");
    if (!btn) return { found: false };
    const all = [...document.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => el.getClientRects().length > 0);
    const i = all.indexOf(btn);
    const prev = i > 0 ? all[i - 1] : null;
    if (prev) prev.focus();
    return { found: i > 0, prev: prev ? prev.className || prev.id || prev.tagName : "", active: document.activeElement === prev };
  }, RESEARCH);
  ok("a focusable control sits before the R in the row", beforeTab.found, beforeTab.prev);
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
      kindWord: Boolean(el.querySelector(".rc-kind")),
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

  // ---- 5. the refusal: a branch with no record answers with the route's 404, in the question -----
  await page.locator(`${RESEARCH} [data-kind-lift]`).click();
  await page.waitForSelector("tr.row-kind-confirm");
  const confirmShot = await shot(page, "lift-confirm", await clipOf(page, RESEARCH, "tr.row-kind-confirm"));
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
    const diag = await page.evaluate(() => ({
      confirm: (document.querySelector("tr.row-kind-confirm")?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
      refusal: document.querySelector("tr.row-kind-confirm .rc-refusal")?.textContent || "",
      banner: document.querySelector("#banner-text")?.textContent || "",
      bannerHidden: document.querySelector("#banner")?.classList.contains("hidden") ?? null,
      liftDisabled: document.querySelector("[data-kind-lift-yes]")?.disabled ?? null,
    }));
    note(`refusal diagnostic: ${JSON.stringify(diag)}`);
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

  // ---- 6. the lift: the record on disk, the row, the note --------------------------------------
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
  ok("the row turns into R with a tick after the lift", Boolean(liftedUp), liftedUp ? `${liftedUp.text}, ${liftedUp.width}px` : "not lifted");
  ok("... the letter is still R: a lift answers the record, it does not change the kind", liftedUp?.text === "R✓");
  ok("... the question is gone", (await page.locator("tr.row-kind-confirm").count()) === 0);
  ok("a green note says what the lift did", /is lifted/.test(liftNote?.text || "") && /ordinary controls/.test(liftNote?.text || "") && liftNote?.green === true && liftNote?.hidden === false, JSON.stringify(liftNote));
  const onDisk = JSON.parse(readFileSync(bookFile, "utf8"));
  check("the record on disk keeps kind:research and now says lifted:true", [onDisk["tag:aaaa11"].kind, onDisk["tag:aaaa11"].lifted], ["research", true]);
  const afterSnap = await stateNow();
  check("... and /api/state stamps the lifted row the same way", fields(rowEnding(afterSnap, "research-probe-aaaa11")), ["research", "research tree", true, "main"]);
  const liftedShot = await shot(page, "lifted-row", await clipOf(page, RESEARCH));

  // ---- 7. the cut dialog still records the kind the same way ------------------------------------
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
  const dialogShot = await shot(page, "cut-dialog");
  await page.locator('.cut-dialog label:has(input[name="cut-kind"][value="turnover"])').click();
  const chosen = await page.evaluate(() => document.querySelector('.cut-dialog input[name="cut-kind"][value="turnover"]')?.checked === true);
  ok("... and the turnover card is the one chosen", chosen);
  await page.locator(".cut-dialog .cut-name").fill("a-new-turnover-child");
  await page.locator(".cut-dialog .cut-go").click();
  const cutRow = await waitFor(
    async () => {
      const st = await stateNow();
      return rowsOf(st).find((r) => slash(r.path).toLowerCase().includes("a-new-turnover-child")) || false;
    },
    { timeoutMs: 120_000, what: "the cut tree's row" },
  );
  ok("a cut that chose turnover is recorded and drawn as a turnover child", cutRow && cutRow.branchKind === "turnover" && cutRow.branchKindParent === TURNOVER_BRANCH, cutRow ? `${cutRow.branchKind} from ${cutRow.branchKindParent}` : "no row");
  // The cut's write is queued (lib/jobs.js `saveParents`, `writeFileQueued`), so read until the record is on disk.
  // Match on the tree the record names as well as the branch: the key is the tag and a record carries both.
  const cutTail = slash(cutRow?.path || "").toLowerCase();
  let cutEntry = null;
  const cutWritten = await waitFor(
    () => {
      const book = JSON.parse(readFileSync(bookFile, "utf8"));
      cutEntry = Object.values(book).find((r) => r && (r.branch === cutRow?.branch || slash(r.tree || "").toLowerCase() === cutTail)) || null;
      return Boolean(cutEntry);
    },
    { timeoutMs: 10_000, what: "the cut's record on disk" },
  );
  ok("... the book on disk gained the record the cut always wrote", cutWritten, cutEntry ? JSON.stringify({ kind: cutEntry.kind, parent: cutEntry.parent }) : `keys: ${Object.keys(JSON.parse(readFileSync(bookFile, "utf8"))).join(", ")}`);
  // `lifted` is only written when true (lib/jobs.js `rememberParent`), so absent IS false for a turnover child.
  check("... with the kind the dialog chose, the parent it was cut from, and not lifted", [cutEntry?.kind, cutEntry?.parent, Boolean(cutEntry?.lifted)], ["turnover", TURNOVER_BRANCH, false]);
  const cutMark = cutRow ? await waitFor(async () => {
    const st = await markState(`tr.row[data-key*="${cutRow.path.split("/").pop()}"]`);
    return st && st.text === "T" ? st : false;
  }, { timeoutMs: 20_000, what: "the new row's T" }) : null;
  ok("... and the new row draws T without a reload", Boolean(cutMark), cutMark ? cutMark.text : "none");

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
