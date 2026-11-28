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
//      box, and the arrow walk + the scroller follow still put the current row inside the list's own band. The drag
//      is then walked in EIGHT steps with the box read after each one: every reading must be within 2px of the
//      pointer's grab offset, and no step may move the box more than 2px beyond the pointer's own step. A QUERY
//      typed mid-drag (its answer is the redraw) must move the box 0px, and a redraw between the press and the
//      first move must not re-anchor it under the held strip.
//   3. RESIZED. A drag on the bottom-right grip grows it by the pointer's travel; dragging past the floor stops at
//      the minimum width and height, and the walk's current row is still visible afterwards. The resize is walked in
//      eight steps too, and the list is checked to stay inside the resized box. After the drop the rectangle
//      survives a keystroke and a re-render and is only forgotten by a close.
//   4. RESET ON CLOSE. Each of Escape, the popover's own x and an outside press closes it; every reopen draws the
//      anchored default again (the same four numbers). A SCOPE change resets the rectangle while the list stays open.
//   5. ZOOMED. Settings > Display's zoom is a layout scale, so a rect and a pointer are VISUAL px while a style length
//      is LAYOUT px. At 110% the popover must still open within 2px of the input and track the pointer within 2px;
//      before the unit conversion it opened 147.1px right and 13.5px low of the input and jumped up to 26.2px per
//      drag step, sliding out from under the pointer.
//   6. THE HOT AGENT BAR does the same. Its popover hangs under its opener button: left edge at the button's left,
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
// The record's paths are RELATIVE to the repo: a drive-letter path is true on one machine only, and the
// absolute-paths gate refuses a new one in a tracked file. The console prints the path the reader can click.
const relPath = (p) => path.relative(ROOT, p).split(path.sep).join("/");
const shot = async (page, name) => {
  const p = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: p });
  record.screenshots.push(relPath(p));
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
// Two animation frames: a style write is synchronous, but a redraw the page schedules lands in the next frame, so a
// step read after this is the frame the reader saw rather than the one before it.
const settled = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const r1 = (n) => Math.round(Number(n) * 10) / 10;
// Wait until an answer for `query` has been drawn: the count names the query only after the bar rendered it.
const waitAnswer = (page, query) =>
  page.waitForFunction(
    (q) => {
      const n = document.getElementById("as-search-n");
      return Boolean(n && !n.hidden && n.dataset.searchQuery === q && Number(n.dataset.searchDisplayed) > 0);
    },
    query,
    { timeout: 10000 },
  );
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
      // The brief's clause (a): the two deltas, printed, and both inside 2px.
      const anchorDelta = { left: r1(defaultM.pop.left - defaultM.input.left), top: r1(defaultM.pop.top - (defaultM.input.bottom + GAP)) };
      console.log(`      anchor deltas: left ${anchorDelta.left}px from the input's left, top ${anchorDelta.top}px from input.bottom + ${GAP}`);
      v.ok("the open position is within 2px of the input's left and bottom plus the gap", Math.abs(anchorDelta.left) <= 2 && Math.abs(anchorDelta.top) <= 2, JSON.stringify(anchorDelta));
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

      // ---- 2b. EIGHT INTERMEDIATE MOVES: the popover tracks the pointer's grab offset, with a redraw mid-drag ------
      // The reader's own complaint: the box "snaps out from underneath your mouse pointer regularly" while dragging
      // or resizing. This walks the drag in eight steps and reads the box after each one; a move that recomputed from
      // a stale rectangle (or a redraw that cleared the moved placement) shows as a jump between two consecutive
      // readings, and the distance is printed rather than described.
      const grab = await page.evaluate(() => {
        const strip = document.querySelector("#as-search-pop [data-search-drag]");
        const pop = document.getElementById("as-search-pop");
        const s = strip.getBoundingClientRect();
        const p = pop.getBoundingClientRect();
        return { x: s.left + s.width / 2, y: s.top + s.height / 2, pop: { left: p.left, top: p.top, width: p.width, height: p.height } };
      });
      const grabX = grab.x - grab.pop.left;
      const grabY = grab.y - grab.pop.top;
      const MOVE_DX = -200;
      const MOVE_DY = 120;
      const MOVE_STEPS = 8;
      await page.mouse.move(grab.x, grab.y);
      await page.mouse.down();
      const moves = [];
      let midDrag = null;
      for (let i = 1; i <= MOVE_STEPS; i += 1) {
        if (i === 5) {
          // A query typed at the fourth move: the answer lands as a redraw while the button is still down. The caret
          // is still in the box (the strip's mousedown is preventative), so the keys go where a reader's would.
          const beforeRedraw = await page.evaluate(MEASURE);
          await page.keyboard.type(" assistant");
          await waitAnswer(page, "saffron assistant");
          await settled(page);
          const afterRedraw = await page.evaluate(MEASURE);
          midDrag = {
            before: { left: beforeRedraw.pop.left, top: beforeRedraw.pop.top, right: beforeRedraw.pop.right, bottom: beforeRedraw.pop.bottom },
            after: { left: afterRedraw.pop.left, top: afterRedraw.pop.top, right: afterRedraw.pop.right, bottom: afterRedraw.pop.bottom },
            reset: { left: r1(afterRedraw.pop.left - beforeRedraw.pop.left), top: r1(afterRedraw.pop.top - beforeRedraw.pop.top) },
            anchoredLeft: r1(afterRedraw.pop.left - afterRedraw.input.left),
            anchoredTop: r1(afterRedraw.pop.top - (afterRedraw.input.bottom + GAP)),
            query: await page.inputValue("#as-search-q"),
          };
          console.log(`      mid-drag redraw: pop moved ${JSON.stringify(midDrag.reset)} (the anchored default would be ${midDrag.anchoredLeft}, ${midDrag.anchoredTop} off the input)`);
        }
        const tx = grab.x + (MOVE_DX * i) / MOVE_STEPS;
        const ty = grab.y + (MOVE_DY * i) / MOVE_STEPS;
        await page.mouse.move(tx, ty);
        await settled(page);
        const m = await page.evaluate(MEASURE);
        moves.push({ i, pointer: { x: r1(tx), y: r1(ty) }, left: m.pop.left, top: m.pop.top, wantLeft: r1(tx - grabX), wantTop: r1(ty - grabY) });
      }
      const moveErr = moves.map((s) => Math.max(Math.abs(s.left - s.wantLeft), Math.abs(s.top - s.wantTop)));
      const maxMoveErr = Math.max(...moveErr);
      const jumps = moves.map((s, i) => {
        const prevL = i ? moves[i - 1].left : grab.pop.left;
        const prevT = i ? moves[i - 1].top : grab.pop.top;
        return Math.max(Math.abs(s.left - (prevL + MOVE_DX / MOVE_STEPS)), Math.abs(s.top - (prevT + MOVE_DY / MOVE_STEPS)));
      });
      const maxJump = r1(Math.max(...jumps));
      console.log(`      eight moves: worst pointer offset ${r1(maxMoveErr)}px, largest jump between moves ${maxJump}px`);
      for (const s of moves) console.log(`        move ${s.i}: pointer ${s.pointer.x},${s.pointer.y} -> pop ${s.left},${s.top} (wanted ${s.wantLeft},${s.wantTop}, off ${r1(Math.max(Math.abs(s.left - s.wantLeft), Math.abs(s.top - s.wantTop)))})`);
      v.ok("eight intermediate moves keep the popover within 2px of the grab offset", maxMoveErr <= 2, `worst ${r1(maxMoveErr)}px`);
      v.ok("no move jumps the popover more than 2px beyond the pointer's own step", maxJump <= 2, `largest jump ${maxJump}px`);
      v.ok("a query typed mid-drag does not reset the position", Math.abs(midDrag.reset.left) <= 2 && Math.abs(midDrag.reset.top) <= 2, `moved ${JSON.stringify(midDrag.reset)} on the redraw`);
      v.ok("the mid-drag redraw draws the new answer", midDrag.query === "saffron assistant" && (await page.evaluate(WALK)).ass.total > 0, midDrag.query);
      const afterMoves = await page.evaluate(MEASURE);
      v.ok("the drag still holds the caret in the box after eight moves and a redraw", afterMoves.active === "as-search-q", `active ${afterMoves.active}`);
      record.steps.push({ step: "assistant-eight-moves", grab: grab.pop, moves, maxMoveErr: r1(maxMoveErr), maxJump, midDrag });
      await shot(page, "02b-assistant-mid-drag-1760x1000");
      await page.mouse.up();
      await settled(page);
      const dropped = await page.evaluate(MEASURE);
      v.ok("the dropped position is the last move's position", near(dropped.pop.left, moves[MOVE_STEPS - 1].left, 1) && near(dropped.pop.top, moves[MOVE_STEPS - 1].top, 1), `dropped ${dropped.pop.left},${dropped.pop.top} vs ${moves[MOVE_STEPS - 1].left},${moves[MOVE_STEPS - 1].top}`);

      // ---- 2c. the corner resize tracks the pointer by the same rule ----------------------------------------------
      const grip = await page.evaluate(() => {
        const g = document.querySelector("#as-search-pop [data-search-grip]");
        const pop = document.getElementById("as-search-pop");
        const r = g.getBoundingClientRect();
        const p = pop.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, pop: { left: p.left, top: p.top, width: p.width, height: p.height } };
      });
      const RESIZE_DX = 160;
      const RESIZE_DY = 120;
      const RESIZE_STEPS = 8;
      await page.mouse.move(grip.x, grip.y);
      await page.mouse.down();
      const sizes = [];
      for (let i = 1; i <= RESIZE_STEPS; i += 1) {
        await page.mouse.move(grip.x + (RESIZE_DX * i) / RESIZE_STEPS, grip.y + (RESIZE_DY * i) / RESIZE_STEPS);
        await settled(page);
        const m = await page.evaluate(MEASURE);
        sizes.push({ i, left: m.pop.left, top: m.pop.top, width: m.pop.width, height: m.pop.height, wantWidth: r1(grip.pop.width + (RESIZE_DX * i) / RESIZE_STEPS), wantHeight: r1(grip.pop.height + (RESIZE_DY * i) / RESIZE_STEPS) });
      }
      await page.mouse.up();
      await settled(page);
      const resizeErr = sizes.map((s) => Math.max(Math.abs(s.width - s.wantWidth), Math.abs(s.height - s.wantHeight)));
      const maxResizeErr = Math.max(...resizeErr);
      const sizeJumps = sizes.map((s, i) => {
        const prevW = i ? sizes[i - 1].width : grip.pop.width;
        const prevH = i ? sizes[i - 1].height : grip.pop.height;
        return Math.max(Math.abs(s.width - (prevW + RESIZE_DX / RESIZE_STEPS)), Math.abs(s.height - (prevH + RESIZE_DY / RESIZE_STEPS)));
      });
      const maxSizeJump = r1(Math.max(...sizeJumps));
      const resizeEnd = await page.evaluate(MEASURE);
      const resizeInside = await page.evaluate(() => {
        const pop = document.getElementById("as-search-pop");
        const p = pop.getBoundingClientRect();
        const rows = [...pop.querySelectorAll("[data-search-hit]")];
        const wide = rows.filter((row) => {
          const r = row.getBoundingClientRect();
          return r.right > p.right + 1 || r.left < p.left - 1;
        });
        const gripEl = pop.querySelector("[data-search-grip]");
        const g = gripEl.getBoundingClientRect();
        return {
          rows: rows.length,
          outside: wide.length,
          scrolls: getComputedStyle(pop).overflowY === "auto",
          gripBottom: Math.round((p.bottom - g.bottom) * 10) / 10,
          scrollHeight: pop.scrollHeight,
          clientHeight: pop.clientHeight,
        };
      });
      console.log(`      resize: worst size offset ${r1(maxResizeErr)}px, largest jump between steps ${maxSizeJump}px, rows outside the box ${resizeInside.outside}/${resizeInside.rows}`);
      for (const s of sizes) console.log(`        step ${s.i}: pop ${s.width}x${s.height} (wanted ${s.wantWidth}x${s.wantHeight}) at ${s.left},${s.top}`);
      v.ok("eight resize moves keep the box within 2px of the pointer's travel", maxResizeErr <= 2, `worst ${r1(maxResizeErr)}px`);
      v.ok("no resize step jumps the box more than 2px beyond the pointer's own step", maxSizeJump <= 2, `largest jump ${maxSizeJump}px`);
      v.ok("the resize keeps the box's top-left where it was", near(resizeEnd.pop.left, grip.pop.left, 1) && near(resizeEnd.pop.top, grip.pop.top, 1), `${resizeEnd.pop.left},${resizeEnd.pop.top} vs ${grip.pop.left},${grip.pop.top}`);
      v.ok("the list stays inside the resized box", resizeInside.outside === 0 && resizeInside.scrolls && resizeInside.gripBottom <= 6, `${resizeInside.outside} of ${resizeInside.rows} rows wide of the box, scrolls ${resizeInside.scrolls}, grip ${resizeInside.gripBottom}px above the foot`);
      record.steps.push({ step: "assistant-resize-steps", grip: grip.pop, sizes, maxResizeErr: r1(maxResizeErr), maxSizeJump, inside: resizeInside });
      await shot(page, "02c-assistant-resized-steps-1760x1000");

      // ---- 2d. the drop survives a keystroke and a re-render; a close forgets it ----------------------------------
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(220);
      const afterKeystroke = await page.evaluate(MEASURE);
      v.ok("a keystroke after the drop leaves the rectangle alone", near(afterKeystroke.pop.left, resizeEnd.pop.left, 1) && near(afterKeystroke.pop.top, resizeEnd.pop.top, 1) && near(afterKeystroke.pop.width, resizeEnd.pop.width, 1), `pop ${JSON.stringify(afterKeystroke.pop)} vs ${JSON.stringify(resizeEnd.pop)}`);
      await typeQuery(page, "saffron");
      const afterReRender = await page.evaluate(MEASURE);
      v.ok("a re-render after the drop leaves the rectangle alone", near(afterReRender.pop.left, resizeEnd.pop.left, 1) && near(afterReRender.pop.top, resizeEnd.pop.top, 1) && near(afterReRender.pop.height, resizeEnd.pop.height, 1), `pop ${JSON.stringify(afterReRender.pop)} vs ${JSON.stringify(resizeEnd.pop)}`);
      record.steps.push({ step: "assistant-drop-survives", dropped: resizeEnd, afterKeystroke, afterReRender });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
      await typeQuery(page, FILTER);
      await waitOpen(page);
      const reopenedAfterDrop = await page.evaluate(MEASURE);
      const reopenDelta = { left: r1(reopenedAfterDrop.pop.left - reopenedAfterDrop.input.left), top: r1(reopenedAfterDrop.pop.top - (reopenedAfterDrop.input.bottom + GAP)) };
      console.log(`      reopen after the drop: deltas ${JSON.stringify(reopenDelta)}, ${reopenedAfterDrop.pop.width}x${reopenedAfterDrop.pop.height}`);
      v.ok("a close and reopen puts the box back under the input, within 2px", Math.abs(reopenDelta.left) <= 2 && Math.abs(reopenDelta.top) <= 2, JSON.stringify(reopenDelta));
      v.ok("a close and reopen forgets the reader's size", near(reopenedAfterDrop.pop.width, defaultM.pop.width, 1) && near(reopenedAfterDrop.pop.height, defaultM.pop.height, 1), `${reopenedAfterDrop.pop.width}x${reopenedAfterDrop.pop.height} vs ${defaultM.pop.width}x${defaultM.pop.height}`);
      record.steps.push({ step: "assistant-reopen-after-drop", reopened: reopenedAfterDrop, delta: reopenDelta });
      await shot(page, "02d-assistant-reopened-after-drop-1760x1000");

      // ---- 2e. THE SAME TWO RULES ON A ZOOMED PAGE -----------------------------------------------------------------
      // Settings > Display's zoom is a LAYOUT scale on documentElement (applyZoom in public/settings.js): a rect and a
      // pointer arrive in VISUAL px, a length written to style is LAYOUT px. A placement that writes the visual
      // rectangle straight back opens the popover zoom-times too far from the input; a drag whose start rect and
      // deltas are visual while the writes are layout moves the box zoom-times too far on every step, so it slides
      // out from under the pointer a little more each move. At 110% that is the reader's report, measured.
      await page.evaluate(() => {
        document.documentElement.style.zoom = "1.1";
      });
      await settled(page);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
      await typeQuery(page, FILTER);
      await waitOpen(page);
      const zoomAnchored = await page.evaluate(MEASURE);
      const zoomDelta = { left: r1(zoomAnchored.pop.left - zoomAnchored.input.left), top: r1(zoomAnchored.pop.top - (zoomAnchored.input.bottom + GAP)) };
      console.log(`      zoom 110%: input ${JSON.stringify(zoomAnchored.input)} pop ${JSON.stringify(zoomAnchored.pop)} deltas ${JSON.stringify(zoomDelta)} (visual px)`);
      v.ok("at 110% zoom the open position is still within 2px of the input", Math.abs(zoomDelta.left) <= 2 && Math.abs(zoomDelta.top) <= 2, JSON.stringify(zoomDelta));
      const zgrab = await page.evaluate(() => {
        const strip = document.querySelector("#as-search-pop [data-search-drag]");
        const pop = document.getElementById("as-search-pop");
        const s = strip.getBoundingClientRect();
        const p = pop.getBoundingClientRect();
        return { x: s.left + s.width / 2, y: s.top + s.height / 2, pop: { left: p.left, top: p.top } };
      });
      const zgx = zgrab.x - zgrab.pop.left;
      const zgy = zgrab.y - zgrab.pop.top;
      const ZDX = -160;
      const ZDY = 100;
      await page.mouse.move(zgrab.x, zgrab.y);
      await page.mouse.down();
      const zmoves = [];
      for (let i = 1; i <= 8; i += 1) {
        const tx = zgrab.x + (ZDX * i) / 8;
        const ty = zgrab.y + (ZDY * i) / 8;
        await page.mouse.move(tx, ty);
        await settled(page);
        const m = await page.evaluate(MEASURE);
        zmoves.push({ i, left: m.pop.left, top: m.pop.top, wantLeft: r1(tx - zgx), wantTop: r1(ty - zgy) });
      }
      await page.mouse.up();
      await settled(page);
      const zErr = zmoves.map((s) => Math.max(Math.abs(s.left - s.wantLeft), Math.abs(s.top - s.wantTop)));
      const zJumps = zmoves.map((s, i) => {
        const prevL = i ? zmoves[i - 1].left : zgrab.pop.left;
        const prevT = i ? zmoves[i - 1].top : zgrab.pop.top;
        return Math.max(Math.abs(s.left - (prevL + ZDX / 8)), Math.abs(s.top - (prevT + ZDY / 8)));
      });
      const zMaxErr = r1(Math.max(...zErr));
      const zMaxJump = r1(Math.max(...zJumps));
      console.log(`      zoom 110%: eight moves worst offset ${zMaxErr}px, largest jump ${zMaxJump}px`);
      for (const s of zmoves) console.log(`        move ${s.i}: pop ${s.left},${s.top} wanted ${s.wantLeft},${s.wantTop}`);
      v.ok("at 110% zoom eight moves keep the popover within 2px of the grab offset", zMaxErr <= 2, `worst ${zMaxErr}px`);
      v.ok("at 110% zoom no move jumps the popover more than 2px", zMaxJump <= 2, `largest jump ${zMaxJump}px`);
      record.steps.push({ step: "assistant-zoom-110", anchored: zoomAnchored, delta: zoomDelta, moves: zmoves, maxErr: zMaxErr, maxJump: zMaxJump });
      await shot(page, "02e-assistant-zoom-110-1760x1000");
      // Back to the page the rest of the gate documents.
      await page.evaluate(() => {
        document.documentElement.style.zoom = "";
      });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
      await typeQuery(page, FILTER);
      await waitOpen(page);

      // ---- 2f. a redraw between the PRESS and the first MOVE does not re-anchor under the pointer -----------------
      // The sharpest form of the mid-drag redraw: the button is down on the strip and the pointer has not moved yet.
      // A placement that still reads the anchor while a drag is in progress draws the default under the held strip,
      // and the first move snaps it back. The press owns the rectangle, so the answer changes the rows and nothing
      // else. The box is moved OFF its anchor first, so a reset would be a visible distance rather than 0.
      await dragBy(page, "#as-search-pop [data-search-drag]", -200, 60);
      const pgrab = await page.evaluate(() => {
        const strip = document.querySelector("#as-search-pop [data-search-drag]");
        const pop = document.getElementById("as-search-pop");
        const s = strip.getBoundingClientRect();
        const p = pop.getBoundingClientRect();
        return { x: s.left + s.width / 2, y: s.top + s.height / 2, pop: { left: p.left, top: p.top } };
      });
      await page.mouse.move(pgrab.x, pgrab.y);
      await page.mouse.down();
      await settled(page);
      const pressHeld = await page.evaluate(MEASURE);
      await page.keyboard.type(" assistant");
      await waitAnswer(page, "saffron assistant");
      await settled(page);
      const pressAfterRedraw = await page.evaluate(MEASURE);
      const pressReset = { left: r1(pressAfterRedraw.pop.left - pressHeld.pop.left), top: r1(pressAfterRedraw.pop.top - pressHeld.pop.top) };
      console.log(`      redraw before the first move: pop moved ${JSON.stringify(pressReset)} (a reset to the anchor would be ${r1(pressAfterRedraw.input.left - pressHeld.pop.left)}px)`);
      v.ok("a redraw between the press and the first move leaves the box under the pointer", Math.abs(pressReset.left) <= 2 && Math.abs(pressReset.top) <= 2, `moved ${JSON.stringify(pressReset)}`);
      await page.mouse.move(pgrab.x - 60, pgrab.y - 40);
      await settled(page);
      const pressMoved = await page.evaluate(MEASURE);
      v.ok("the first move after that redraw tracks the pointer", near(pressMoved.pop.left, pressAfterRedraw.pop.left - 60, 2) && near(pressMoved.pop.top, pressAfterRedraw.pop.top - 40, 2), `pop ${pressMoved.pop.left},${pressMoved.pop.top} from ${pressAfterRedraw.pop.left},${pressAfterRedraw.pop.top}`);
      await page.mouse.up();
      await settled(page);
      record.steps.push({ step: "assistant-press-redraw", held: pressHeld, after: pressAfterRedraw, reset: pressReset, moved: pressMoved });
      await shot(page, "02f-assistant-press-redraw-1760x1000");




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
