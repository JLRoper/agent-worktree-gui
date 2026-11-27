// The results popover of BOTH header searches, measured in a real browser against a real panel process.
// HARNESS: LIVE GATE
//
// WHAT IT PROVES, in the order the reader meets it:
//
//   1. ANCHORED. With a query typed in the assistant's turn search, the popover's top edge sits at the INPUT's
//      bottom edge (within a couple of px) and its left edge is the INPUT's own left edge - not the `.as-search`
//      span's, not the pane's. The pre-fix rule aligned right edges, so a 250px popover hung 140px left of a 55px
//      box; the gate prints both rectangles and the old right-aligned rectangle beside them.
//   2. MOVED. A drag on the strip across the popover's top moves it by the pointer's travel, the caret stays in the
//      box, and the arrow walk + the scroller follow still put the current row inside the list's own band.
//   3. RESIZED. A drag on the bottom-right grip grows it by the pointer's travel; dragging past the floor stops at
//      the minimum width and height, and the walk's current row is still visible afterwards.
//   4. RESET ON CLOSE. Each of Escape, the popover's own x and an outside press closes it; every reopen draws the
//      anchored default again (the same four numbers). A SCOPE change resets the rectangle while the list stays open.
//   5. THE HOT AGENT BAR does the same. Its popover hangs under its opener button: left edge at the button's left,
//      top edge 6px under its bottom, its own head box just inside - the old rule put it 296px to the LEFT of the
//      button. The drag, the grip, the walk and the three closes are repeated on that bar.
//
// HOW TO RUN:  node tools/verify-search-popover.mjs
//              node tools/verify-search-popover.mjs --out <dir>    (defaults to docs/assets/search-popover)
//              node tools/verify-search-popover.mjs --keep          (leave the sandbox store behind)
//
// It boots THIS checkout's server.js on a free port with its own state directory and a SYNTHESIZED store: twelve
// assistant turns carrying the filter (the turn search's corpus) and twenty-four worker turns (the Hot Agent bar's
// corpus), so the gate means the same thing on a machine that has never opened the panel. No live panel is touched.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, createVerifier, startPanel } from "./panel-testkit.mjs";
import { loadPlaywright, withBrowser } from "./browser.mjs";

const argv = process.argv.slice(2);
const argOf = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const keep = argv.includes("--keep");
const outDir = argOf("out", path.join(ROOT, "docs", "assets", "search-popover"));
const dir = argOf("dir", path.join(os.tmpdir(), "wag-search-popover-gate"));
mkdirSync(outDir, { recursive: true });
mkdirSync(dir, { recursive: true });

const FILTER = "saffron";
const ASSISTANT_TURNS = 12; // the turn search answers 10 of these (SEARCH_LIMIT), so the list has a fold
const WORKER_TURNS = 24; // the Hot Agent list opens on the newest 20, so that list has a fold too
const GAP = 6; // PLACE_DEFAULTS.gap: the popover's top is this far under the box's bottom

// ---- the store ----------------------------------------------------------------------------------------------
// The shape the panel's own jobs.json uses: the turn search reads each assistant's threads, the Hot Agent search
// reads the reader's own turns on every OTHER thread. Both need a fold, so both are seeded past their windows.
const at = (minutes) => new Date(Date.UTC(2026, 10, 27, 8, minutes, 0)).toISOString();
const assistantTurns = Array.from({ length: ASSISTANT_TURNS }, (_, i) => {
  const n = i + 1;
  return {
    id: `synth-as-${String(n).padStart(2, "0")}`,
    thread: "panel-assistant",
    turn: n,
    origin: "assistant",
    status: "done",
    startedAt: at(n),
    endedAt: at(n + 1),
    prompt: `saffron assistant turn ${n}: re-read the store and say what moved since the last pass`,
    finalMessage: `the assistant's reply ${n}: the saffron queue is quiet`,
    lines: [{ kind: "tool", text: `read lib/store.js for saffron turn ${n}`, at: Date.parse(at(n)) }],
  };
});
const workerTurns = Array.from({ length: WORKER_TURNS }, (_, i) => {
  const n = i + 1;
  return {
    id: `synth-hot-${String(n).padStart(2, "0")}`,
    title: n % 2 === 0 ? `audit pass ${n}` : "",
    thread: `wtgui-hot-agent-${String(n).padStart(2, "0")}`,
    turn: 1,
    origin: null,
    status: "done",
    assistant: false,
    reply: false,
    startedAt: at(60 + n),
    endedAt: at(61 + n),
    prompt: `saffron worker task ${n}: read public/app.js and the job store, then say what moved since the last turn`,
    finalMessage: `the agent's own reply to task ${n}`,
    projectPath: path.join(dir, "repos", n % 2 === 0 ? "project-beta" : "project-alpha"),
    tree: { path: path.join(dir, "repos", n % 2 === 0 ? "project-beta" : "project-alpha"), branch: "main", exists: true },
    lines: [],
  };
});
const logsDir = path.join(dir, "logs");
mkdirSync(logsDir, { recursive: true });
writeFileSync(
  path.join(logsDir, "assistants.json"),
  JSON.stringify({ version: 2, assistants: [{ id: "assistant-1", name: "Assistant #1", threadId: "panel-assistant" }] }, null, 1),
  "utf8",
);
writeFileSync(
  path.join(logsDir, "jobs.json"),
  JSON.stringify({ version: 3, savedAt: new Date().toISOString(), jobs: [...assistantTurns, ...workerTurns] }, null, 1),
  "utf8",
);
// The panel's own selected-assistant record and the role library, when this machine has them: neither decides what
// this gate measures, but a sandbox missing them draws a float with less around the box.
for (const name of ["assistant.json", "roles.json"]) {
  const from = path.join(os.homedir(), ".wag", "state", name);
  if (existsSync(from)) {
    try {
      copyFileSync(from, path.join(logsDir, name));
    } catch {
      /* optional */
    }
  }
}

// ---- the page-side reads ------------------------------------------------------------------------------------
// One measure returns every rectangle the gate compares, rounded to a tenth of a pixel: the box, the popover, the
// pane it lives in, and (on the Hot Agent bar) its opener and its own head input.
const MEASURE = () => {
  const round = (n) => Math.round(n * 10) / 10;
  const box = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: round(r.left), top: round(r.top), right: round(r.right), bottom: round(r.bottom), width: round(r.width), height: round(r.height) };
  };
  const q = (sel) => document.querySelector(sel);
  const pop = document.getElementById("as-search-pop");
  const haPop = document.getElementById("ha-search-pop");
  const active = document.activeElement;
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    pane: box(document.getElementById("assistant")),
    bar: box(q("#assistant > .as-bar")),
    span: box(document.getElementById("as-search")),
    input: box(document.getElementById("as-search-q")),
    pop: box(pop),
    popHidden: Boolean(pop?.hidden),
    popStyle: pop?.getAttribute("style") || "",
    popCount: pop ? pop.querySelectorAll("[data-search-hit]").length : 0,
    hotOpen: box(document.getElementById("ha-search-open")),
    haPop: box(haPop),
    haHidden: Boolean(haPop?.hidden),
    haStyle: haPop?.getAttribute("style") || "",
    haInput: box(document.getElementById("ha-search-q")),
    haList: box(document.getElementById("ha-search-list")),
    haRows: haPop ? haPop.querySelectorAll("[data-search-hit]").length : 0,
    active: active ? active.id || active.className || active.tagName : "",
    pageY: window.scrollY,
  };
};

// The count the bar prints, and the row the walk is standing on: the gate reads the same data attributes the panel
// writes, never a class it guessed.
const WALK = () => {
  const ass = document.getElementById("as-search-n");
  const hot = document.getElementById("ha-search-n");
  const currentRow = document.querySelector("#as-search-pop [data-search-hit].is-current");
  const hotRow = document.querySelector("#ha-search-list [data-search-hit].is-current");
  const band = (row, scroller) => {
    if (!row || !scroller) return null;
    const r = row.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    return { visible: r.top >= s.top - 0.5 && r.bottom <= s.bottom + 0.5, rowTop: Math.round(r.top * 10) / 10, rowBottom: Math.round(r.bottom * 10) / 10, bandTop: Math.round(s.top * 10) / 10, bandBottom: Math.round(s.bottom * 10) / 10 };
  };
  const list = document.getElementById("as-search-pop");
  const hotList = document.getElementById("ha-search-list");
  return {
    ass: { current: Number(ass?.dataset.searchCurrent || 0), total: Number(ass?.dataset.searchTotal || 0), matched: Number(ass?.dataset.searchMatched || 0), query: ass?.dataset.searchQuery || "" },
    hot: { current: Number(hot?.dataset.searchCurrent || 0), total: Number(hot?.dataset.searchTotal || 0), matched: Number(hot?.dataset.searchMatched || 0) },
    assBand: band(currentRow, list),
    hotBand: band(hotRow, hotList),
    assScroll: list ? list.scrollTop : null,
    hotScroll: hotList ? hotList.scrollTop : null,
    strip: (() => {
      const el = document.querySelector("#as-search-pop [data-search-drag]");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top * 10) / 10, left: Math.round(r.left * 10) / 10, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 };
    })(),
    hotStrip: Boolean(document.querySelector("#ha-search-pop [data-search-drag]")),
    x: Boolean(document.querySelector("#as-search-pop [data-search-close]")),
    grip: Boolean(document.querySelector("#as-search-pop [data-search-grip]")),
    hotGrip: Boolean(document.querySelector("#ha-search-pop [data-search-grip]")),
  };
};

const pw = loadPlaywright();
if (!pw) {
  console.log("BROWSER-HALF-NOT-RUN: no playwright on this machine, so nothing above was checked in a page");
  process.exit(2);
}

const panel = await startPanel({ root: ROOT, dir, keep });
const v = createVerifier();
const errors = [];
const record = { base: panel.base, filter: FILTER, seeded: { assistantTurns: ASSISTANT_TURNS, workerTurns: WORKER_TURNS }, viewport: null, steps: [], screenshots: [] };
const near = (a, b, tol = 1.5) => Math.abs(Number(a) - Number(b)) <= tol;
const shot = async (page, name) => {
  const p = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: p });
  record.screenshots.push(p);
  console.log(`screenshot: ${p}`);
  return p;
};
// A drag from the centre of `selector` by (dx, dy), in six pointer moves so a handler that reads every frame sees a
// drag rather than a teleport.
const dragBy = async (page, selector, dx, dy) => {
  const b = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, selector);
  if (!b) throw new Error(`no element for ${selector}`);
  await page.mouse.move(b.x, b.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i += 1) await page.mouse.move(b.x + (dx * i) / 6, b.y + (dy * i) / 6);
  await page.mouse.up();
  await page.waitForTimeout(120);
};
const typeQuery = async (page, query) => {
  await page.fill("#as-search-q", query);
  await page.waitForFunction(
    (q) => {
      const n = document.getElementById("as-search-n");
      return Boolean(n && !n.hidden && n.dataset.searchQuery === q && Number(n.dataset.searchDisplayed) > 0);
    },
    query,
    { timeout: 10000 },
  );
  await page.waitForTimeout(120);
};
const waitOpen = async (page) => {
  await page.waitForSelector("#as-search-pop:not([hidden])", { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll("#as-search-pop [data-search-hit]").length > 0, null, { timeout: 10000 });
};
const waitHotOpen = async (page) => {
  await page.waitForSelector("#ha-search-pop:not([hidden])", { timeout: 10000 });
  await page.waitForFunction(() => document.querySelectorAll("#ha-search-list [data-search-hit]").length > 0, null, { timeout: 15000 });
  await page.waitForTimeout(150);
};
// Are the four numbers of the anchored default? `input`/`opener` is the box the bar anchored to.
const anchored = (m, boxEl, popEl) => boxEl && popEl && near(popEl.left, boxEl.left, 1) && near(popEl.top, boxEl.bottom + GAP, 1);

try {
  const browserHalf = await withBrowser(
    async ({ page }) => {
      page.on("pageerror", (err) => errors.push(String(err?.message || err)));
      page.on("console", (msg) => {
        if (msg.type() === "error" && !/favicon/i.test(msg.text())) errors.push(msg.text());
      });
      await page.goto(panel.base, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#btn-assistant", { timeout: 45000 });
      if (!(await page.evaluate(() => Boolean(document.querySelector("#assistant:not([hidden])"))))) await page.click("#btn-assistant");
      await page.waitForSelector("#assistant:not([hidden]) #as-chat", { timeout: 25000 });
      await page.waitForSelector("#as-chat [data-turn]", { timeout: 25000 });
      await page.waitForTimeout(500);
      record.viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));

      // ---- 1. the assistant's turn search: anchored, not at the pane -------------------------------------------------
      await typeQuery(page, FILTER);
      await waitOpen(page);
      const defaultM = await page.evaluate(MEASURE);
      const defaultWalk = await page.evaluate(WALK);
      console.log(`      anchored rects: input ${JSON.stringify(defaultM.input)} pop ${JSON.stringify(defaultM.pop)} pane ${JSON.stringify(defaultM.pane)}`);
      console.log(`      the old right-aligned rectangle would have been ${defaultM.span.right - defaultM.pop.width}px (${Math.round((defaultM.input.left - (defaultM.span.right - defaultM.pop.width)) * 10) / 10}px left of the input)`);
      v.ok("the popover's top edge sits at the input's bottom edge", near(defaultM.pop.top, defaultM.input.bottom + GAP, 1.5), `${defaultM.pop.top} vs ${defaultM.input.bottom} + ${GAP}`);
      v.ok("the popover's left edge is the INPUT's own left edge", near(defaultM.pop.left, defaultM.input.left, 1), `${defaultM.pop.left} vs ${defaultM.input.left}`);
      v.ok("the popover is not drawn at the pane's left edge", defaultM.pop.left - defaultM.pane.left > 40, `${Math.round((defaultM.pop.left - defaultM.pane.left) * 10) / 10}px inside the pane's left edge`);
      v.ok("the popover stays inside the window", defaultM.pop.right <= defaultM.viewport.width - 7, `right ${defaultM.pop.right} of ${defaultM.viewport.width}`);
      v.ok("the popover is wider than the box and grows to the RIGHT of it", defaultM.pop.width > defaultM.input.width && defaultM.pop.left >= defaultM.input.left - 1, `pop ${defaultM.pop.width}px, box ${defaultM.input.width}px`);
      v.ok("the drag strip, the close x and the resize grip are drawn", defaultWalk.strip !== null && defaultWalk.x && defaultWalk.grip, JSON.stringify({ strip: defaultWalk.strip, x: defaultWalk.x, grip: defaultWalk.grip }));
      v.ok("the strip is the popover's own top edge, not scrolled away", near(defaultWalk.strip.top, defaultM.pop.top + 4, 6), `strip ${defaultWalk.strip.top}, pop ${defaultM.pop.top}`);
      v.ok("the answer's first row is current and the count reads it", defaultWalk.ass.current === 1 && defaultWalk.ass.total >= 10, `${defaultWalk.ass.current} of ${defaultWalk.ass.total}, ${defaultWalk.ass.matched} matched`);
      record.steps.push({ step: "assistant-anchored", measure: defaultM, walk: defaultWalk });
      await shot(page, "01-assistant-anchored-1760x1000");

      // ---- 2. a drag moves it, and the walk keeps working ----------------------------------------------------------
      const beforeDrag = await page.evaluate(MEASURE);
      await dragBy(page, "#as-search-pop [data-search-drag]", -120, 80);
      const dragM = await page.evaluate(MEASURE);
      const dragWalk = await page.evaluate(WALK);
      console.log(`      drag delta: left ${Math.round((dragM.pop.left - beforeDrag.pop.left) * 10) / 10}, top ${Math.round((dragM.pop.top - beforeDrag.pop.top) * 10) / 10}`);
      v.ok("a drag on the strip moves the popover by the pointer's travel", near(dragM.pop.left - beforeDrag.pop.left, -120, 1.5) && near(dragM.pop.top - beforeDrag.pop.top, 80, 1.5), `moved ${Math.round((dragM.pop.left - beforeDrag.pop.left) * 10) / 10}, ${Math.round((dragM.pop.top - beforeDrag.pop.top) * 10) / 10}`);
      v.ok("the drag keeps the caret in the box", dragM.active === "as-search-q", `active ${dragM.active}`);
      v.ok("the drag keeps the answer and its count", dragWalk.ass.total === defaultWalk.ass.total && dragWalk.ass.current === 1, `${dragWalk.ass.current} of ${dragWalk.ass.total}`);
      v.ok("the strip travels with the popover", near(dragWalk.strip.top, dragM.pop.top + 4, 6), `strip ${dragWalk.strip.top}, pop ${dragM.pop.top}`);
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(180);
      const walked = await page.evaluate(WALK);
      v.ok("an arrow press still steps while the popover is moved", walked.ass.current === 2, `current ${walked.ass.current} of ${walked.ass.total}`);
      v.ok("the scroller follow keeps the stepped row inside the list", walked.assBand?.visible === true, JSON.stringify(walked.assBand));
      // A NEW ANSWER lands in the moved rectangle: only a CLOSE forgets where the reader put it.
      await typeQuery(page, "saffron assistant");
      const afterType = await page.evaluate(MEASURE);
      v.ok("a new answer keeps the moved rectangle", near(afterType.pop.left, dragM.pop.left, 1) && near(afterType.pop.top, dragM.pop.top, 1), `pop ${JSON.stringify(afterType.pop)} after the answer`);
      await typeQuery(page, FILTER);
      await waitOpen(page);
      record.steps.push({ step: "assistant-dragged", before: beforeDrag, after: dragM, walk: walked, afterAnswer: afterType });
      await shot(page, "02-assistant-dragged-1760x1000");

      // ---- 3. the grip resizes it, with a floor -------------------------------------------------------------------
      const beforeResize = await page.evaluate(MEASURE);
      await dragBy(page, "#as-search-pop [data-search-grip]", 80, 60);
      const resizeM = await page.evaluate(MEASURE);
      console.log(`      resize delta: width ${Math.round((resizeM.pop.width - beforeResize.pop.width) * 10) / 10}, height ${Math.round((resizeM.pop.height - beforeResize.pop.height) * 10) / 10}`);
      v.ok("a grip drag resizes the popover by the pointer's travel", near(resizeM.pop.width - beforeResize.pop.width, 80, 1.5) && near(resizeM.pop.height - beforeResize.pop.height, 60, 1.5), `${resizeM.pop.width}x${resizeM.pop.height} from ${beforeResize.pop.width}x${beforeResize.pop.height}`);
      v.ok("the resize keeps the caret in the box", resizeM.active === "as-search-q", `active ${resizeM.active}`);
      // Past the floor: the minimum is a width and a height the list can still be read in.
      await dragBy(page, "#as-search-pop [data-search-grip]", -900, -900);
      const floored = await page.evaluate(MEASURE);
      v.ok("a grip drag past the floor stops at the minimum size", near(floored.pop.width, 250, 1) && near(floored.pop.height, 120, 1), `${floored.pop.width}x${floored.pop.height}`);
      const flooredWalk = await page.evaluate(WALK);
      v.ok("the walk's row is still in the list after the floor", flooredWalk.assBand?.visible === true, JSON.stringify(flooredWalk.assBand));
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(180);
      const flooredStep = await page.evaluate(WALK);
      v.ok("an arrow press still steps in the floored list", flooredStep.ass.current === 2, `current ${flooredStep.ass.current} of ${flooredStep.ass.total}`);
      v.ok("the scroller follow still moves the floored list", flooredStep.assBand?.visible === true, JSON.stringify(flooredStep.assBand));
      v.ok("the drag strip stays at the popover's top when the list scrolls", near(flooredStep.strip.top, floored.pop.top + 4, 10), `strip ${flooredStep.strip.top}, pop ${floored.pop.top}`);
      record.steps.push({ step: "assistant-resized", before: beforeResize, after: resizeM, floored });
      // A readable size again for the picture.
      await dragBy(page, "#as-search-pop [data-search-grip]", 120, 220);
      await shot(page, "03-assistant-resized-1760x1000");

      // ---- 4a. Escape closes and a reopen is the anchored default -------------------------------------------------
      await dragBy(page, "#as-search-pop [data-search-drag]", -90, 70);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      const afterEsc = await page.evaluate(MEASURE);
      v.ok("Escape closes the popover", afterEsc.popHidden === true, `hidden ${afterEsc.popHidden}`);
      v.ok("Escape clears the filter and leaves the caret in the box", (await page.inputValue("#as-search-q")) === "" && afterEsc.active === "as-search-q", `${JSON.stringify(await page.inputValue("#as-search-q"))}, active ${afterEsc.active}`);
      await typeQuery(page, FILTER);
      await waitOpen(page);
      const reopened1 = await page.evaluate(MEASURE);
      v.ok("a reopen after Escape draws the anchored default again", anchored(reopened1, reopened1.input, reopened1.pop) && near(reopened1.pop.width, defaultM.pop.width, 1), `pop ${JSON.stringify(reopened1.pop)} vs ${JSON.stringify(defaultM.pop)}`);
      record.steps.push({ step: "assistant-escape-reopen", afterEsc, reopened: reopened1 });
      await shot(page, "04-assistant-reopened-1760x1000");

      // ---- 4b. the x closes and a reopen is the anchored default --------------------------------------------------
      await dragBy(page, "#as-search-pop [data-search-drag]", -90, 60);
      await dragBy(page, "#as-search-pop [data-search-grip]", 40, 40);
      await page.click("#as-search-pop [data-search-close]");
      await page.waitForTimeout(250);
      const afterX = await page.evaluate(MEASURE);
      v.ok("the popover's own x closes it", afterX.popHidden === true, `hidden ${afterX.popHidden}`);
      await typeQuery(page, FILTER);
      await waitOpen(page);
      const reopened2 = await page.evaluate(MEASURE);
      v.ok("a reopen after the x draws the anchored default again", anchored(reopened2, reopened2.input, reopened2.pop), `pop ${JSON.stringify(reopened2.pop)}`);
      record.steps.push({ step: "assistant-x-reopen", afterX, reopened: reopened2 });

      // ---- 4c. an outside press closes and a reopen is the anchored default ---------------------------------------
      await dragBy(page, "#as-search-pop [data-search-drag]", -80, 50);
      await page.mouse.click(700, 220);
      await page.waitForTimeout(250);
      const afterOutside = await page.evaluate(MEASURE);
      v.ok("a press outside the box and the list closes it", afterOutside.popHidden === true, `hidden ${afterOutside.popHidden}`);
      v.ok("the outside press leaves the filter in the box", (await page.inputValue("#as-search-q")) === FILTER, JSON.stringify(await page.inputValue("#as-search-q")));
      await page.click("#as-search-q");
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(700);
      await waitOpen(page);
      const reopened3 = await page.evaluate(MEASURE);
      v.ok("a reopen after an outside press draws the anchored default again", anchored(reopened3, reopened3.input, reopened3.pop), `pop ${JSON.stringify(reopened3.pop)}`);
      record.steps.push({ step: "assistant-outside-reopen", afterOutside, reopened: reopened3 });

      // ---- 4d. a scope change resets the rectangle while the list stays open --------------------------------------
      await dragBy(page, "#as-search-pop [data-search-drag]", -70, 40);
      await dragBy(page, "#as-search-pop [data-search-grip]", 50, 40);
      const beforeScope = await page.evaluate(MEASURE);
      const movedAway = !near(beforeScope.pop.left, beforeScope.input.left, 20) || !near(beforeScope.pop.height, defaultM.pop.height, 20);
      v.ok("the popover is off its default before the scope press", movedAway, `pop ${JSON.stringify(beforeScope.pop)}`);
      await page.click("#as-search-scope");
      await page.waitForTimeout(600);
      const afterScope = await page.evaluate(MEASURE);
      v.ok("a scope change keeps the list open", afterScope.popHidden === false, `hidden ${afterScope.popHidden}`);
      v.ok("a scope change redraws the anchored default", anchored(afterScope, afterScope.input, afterScope.pop) && near(afterScope.pop.height, defaultM.pop.height, 1), `pop ${JSON.stringify(afterScope.pop)}`);
      record.steps.push({ step: "assistant-scope", before: beforeScope, after: afterScope });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);

      // ---- 5. the Hot Agent bar: anchored to its opener, moved, resized, reset -----------------------------------
      await page.keyboard.press("Control+Shift+KeyQ");
      await waitHotOpen(page);
      const hotDefault = await page.evaluate(MEASURE);
      const hotWalkDefault = await page.evaluate(WALK);
      console.log(`      hot rects: opener ${JSON.stringify(hotDefault.hotOpen)} pop ${JSON.stringify(hotDefault.haPop)} head input ${JSON.stringify(hotDefault.haInput)}`);
      console.log(`      the old right-aligned rectangle would have been ${Math.round((hotDefault.hotOpen.right - hotDefault.haPop.width) * 10) / 10}px (${Math.round((hotDefault.hotOpen.left - (hotDefault.hotOpen.right - hotDefault.haPop.width)) * 10) / 10}px left of the opener)`);
      v.ok("the Hot Agent popover's top edge sits under its opener button", near(hotDefault.haPop.top, hotDefault.hotOpen.bottom + GAP, 1.5), `${hotDefault.haPop.top} vs ${hotDefault.hotOpen.bottom} + ${GAP}`);
      v.ok("the Hot Agent popover's left edge is the opener's own left edge", near(hotDefault.haPop.left, hotDefault.hotOpen.left, 1), `${hotDefault.haPop.left} vs ${hotDefault.hotOpen.left}`);
      v.ok("it is no longer drawn to the LEFT of the opener", hotDefault.haPop.left >= hotDefault.hotOpen.left - 1, `${Math.round((hotDefault.hotOpen.left - hotDefault.haPop.left) * 10) / 10}px left of the opener (the old rule put it ~296px there)`);
      v.ok("its own head box lands just inside the opener's span", hotDefault.haInput.left - hotDefault.hotOpen.left >= -0.5 && hotDefault.haInput.left - hotDefault.hotOpen.left <= 8, `${Math.round((hotDefault.haInput.left - hotDefault.hotOpen.left) * 10) / 10}px in`);
      v.ok("the Hot Agent list has a fold to walk", hotWalkDefault.hot.total >= 20 && hotWalkDefault.hot.matched >= 20, `${hotWalkDefault.hot.total} of ${hotWalkDefault.hot.matched}`);
      v.ok("the Hot Agent popover carries the same chrome", hotWalkDefault.hotStrip && hotWalkDefault.hotGrip, JSON.stringify({ strip: hotWalkDefault.hotStrip, grip: hotWalkDefault.hotGrip }));
      record.steps.push({ step: "hot-anchored", measure: hotDefault, walk: hotWalkDefault });
      await shot(page, "05-hot-anchored-1760x1000");

      const hotBefore = await page.evaluate(MEASURE);
      await dragBy(page, "#ha-search-pop [data-search-drag]", -160, 100);
      const hotDrag = await page.evaluate(MEASURE);
      v.ok("a drag moves the Hot Agent popover by the pointer's travel", near(hotDrag.haPop.left - hotBefore.haPop.left, -160, 1.5) && near(hotDrag.haPop.top - hotBefore.haPop.top, 100, 1.5), `moved ${Math.round((hotDrag.haPop.left - hotBefore.haPop.left) * 10) / 10}, ${Math.round((hotDrag.haPop.top - hotBefore.haPop.top) * 10) / 10}`);
      v.ok("the drag keeps the caret in the Hot Agent box", hotDrag.active === "ha-search-q", `active ${hotDrag.active}`);
      // A shorter list band, so the follow has to move the scroller rather than show everything at once.
      await dragBy(page, "#ha-search-pop [data-search-grip]", 40, -60);
      const hotResize = await page.evaluate(MEASURE);
      v.ok("a grip drag resizes the Hot Agent popover", near(hotResize.haPop.width - hotDrag.haPop.width, 40, 1.5) && near(hotResize.haPop.height - hotDrag.haPop.height, -60, 1.5), `${hotResize.haPop.width}x${hotResize.haPop.height}`);
      let hotWalked = null;
      for (let i = 0; i < 6; i += 1) {
        await page.keyboard.press("ArrowDown");
        await page.waitForTimeout(90);
        hotWalked = await page.evaluate(WALK);
        if (hotWalked.hotBand?.visible !== true) break;
      }
      v.ok("six presses step the Hot Agent walk while it is moved and resized", hotWalked && hotWalked.hot.current === 7, `current ${hotWalked?.hot.current} of ${hotWalked?.hot.total}`);
      v.ok("the Hot Agent scroller follows every press inside its list", hotWalked?.hotBand?.visible === true, JSON.stringify(hotWalked?.hotBand));
      v.ok("the Hot Agent list actually scrolled", (hotWalked?.hotScroll || 0) > 0, `scrollTop ${hotWalked?.hotScroll}`);
      record.steps.push({ step: "hot-dragged-resized", before: hotBefore, dragged: hotDrag, resized: hotResize, walk: hotWalked });
      await shot(page, "06-hot-resized-1760x1000");

      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
      const hotEsc = await page.evaluate(MEASURE);
      v.ok("Escape closes the Hot Agent popover and hands focus to its opener", hotEsc.haHidden === true && hotEsc.active === "ha-search-open", `hidden ${hotEsc.haHidden}, active ${hotEsc.active}`);
      await page.keyboard.press("Control+Shift+KeyQ");
      await waitHotOpen(page);
      const hotReopen1 = await page.evaluate(MEASURE);
      v.ok("a reopen after Escape draws the anchored default again", anchored(hotReopen1, hotReopen1.hotOpen, hotReopen1.haPop) && near(hotReopen1.haPop.width, hotDefault.haPop.width, 1), `pop ${JSON.stringify(hotReopen1.haPop)} vs ${JSON.stringify(hotDefault.haPop)}`);
      record.steps.push({ step: "hot-escape-reopen", afterEsc: hotEsc, reopened: hotReopen1 });

      await dragBy(page, "#ha-search-pop [data-search-drag]", -120, 80);
      await page.click("#ha-search-pop [data-search-close]");
      await page.waitForTimeout(250);
      const hotX = await page.evaluate(MEASURE);
      v.ok("the Hot Agent popover's own x closes it", hotX.haHidden === true, `hidden ${hotX.haHidden}`);
      await page.click("#ha-search-open");
      await waitHotOpen(page);
      const hotReopen2 = await page.evaluate(MEASURE);
      v.ok("a reopen after the x draws the anchored default again", anchored(hotReopen2, hotReopen2.hotOpen, hotReopen2.haPop), `pop ${JSON.stringify(hotReopen2.haPop)}`);
      record.steps.push({ step: "hot-x-reopen", afterX: hotX, reopened: hotReopen2 });

      await dragBy(page, "#ha-search-pop [data-search-drag]", -100, 70);
      const hotBoxAt = await page.evaluate(MEASURE);
      // An outside press: the board behind the float, clear of the popover.
      await page.mouse.click(700, 260);
      await page.waitForTimeout(250);
      const hotOutside = await page.evaluate(MEASURE);
      v.ok("a press outside closes the Hot Agent popover", hotOutside.haHidden === true, `hidden ${hotOutside.haHidden}`);
      await page.click("#ha-search-open");
      await waitHotOpen(page);
      const hotReopen3 = await page.evaluate(MEASURE);
      v.ok("a reopen after an outside press draws the anchored default again", anchored(hotReopen3, hotReopen3.hotOpen, hotReopen3.haPop), `pop ${JSON.stringify(hotReopen3.haPop)}`);
      record.steps.push({ step: "hot-outside-reopen", before: hotBoxAt, after: hotOutside, reopened: hotReopen3 });
      await shot(page, "07-hot-reopened-1760x1000");

      v.ok("the page raised no error during the gate", errors.length === 0, errors.slice(0, 3).join(" | "));
      return true;
    },
    { viewport: { width: 1760, height: 1000 }, deviceScaleFactor: 1 },
  );
  if (!browserHalf) throw new Error("the browser half returned nothing");
} finally {
  await panel.stop();
}

writeFileSync(path.join(outDir, "run.json"), JSON.stringify(record, null, 1), "utf8");
console.log(`\n${v.checks - v.failures}/${v.checks} checks passed  (${record.screenshots.length} screenshots in ${outDir})`);
process.exit(v.failures === 0 ? 0 : 1);
