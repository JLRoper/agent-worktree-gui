#!/usr/bin/env node
// HARNESS: LIVE GATE
// The agent console's corner, pulled DOWN SLOWLY in a headless Chromium, read at every step rather than before and after.
//
//   node tools/verify-console-corner-slow-drag.mjs
//   node tools/verify-console-corner-slow-drag.mjs --trace <file>     # the per-step table as JSON
//   node tools/verify-console-corner-slow-drag.mjs --json             # the numbers as one JSON object
//   node tools/verify-console-corner-slow-drag.mjs --keep             # leave the sandbox behind
//
// WHAT THIS GUARDS, AND WHY IT IS A GATE. The corner grip has been "fixed" twice by a before/after measurement
// (tools/verify-console-resize.mjs, tools/verify-console-corner-tail.mjs) and came back both times, because a
// two-sample reading cannot see the frame a box moves and moves back in. The reader's report is a SLOW drag:
// 3px a step, several seconds, the pointer never fast enough for a coalesced move. So this one presses the grip,
// walks the pointer DOWN in small steps over four seconds, and records what the console's height, its own
// scrollTop, the enclosing transcript's scrollTop and the grip's own rect do at EVERY step, in one table.
//
// The two loops the trace has to separate:
//
//   * the drag's own height write (public/app.js's grip gesture): one `height` per pointermove;
//   * the tail pin (public/board/console.js stickSoon -> stickCardBodySoon): a scrollTop write on the enclosing
//     transcript, one per animation frame, which moves the console's TOP edge while the drag is moving its BOTTOM.
//
// A box whose top moves while its height grows moves its bottom by the difference, so the grip's own bottom edge -
// the thing the reader's hand is on - is the honest witness. Every step asserts the grip's bottom is on the pointer.
//
// Four shapes are driven, because the reader's console is not always one shape: SETTLED (nothing arrives while the hand
// is down), LIVE (a paragraph streams into the console being resized), ABOVE (a row lands in the turn above, so content
// grows on the other side of the reader's place), and CLIPPED (the console was already shrunk, so its content is taller
// than the box, it scrolls inside itself, and its own tail pin has somewhere to write while the drag grows it back).
//
// The browser half needs a Playwright install (PANEL_PLAYWRIGHT_ROOT), exactly like every other harness in tools/.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO, installFakeEventSource, loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const KEEP = flag("keep");
const JSON_OUT = flag("json");
const TRACE = opt("trace", null);
const ROOT = path.resolve(opt("root", REPO));

// The reader's own shape: a hand that moves 3px every 110ms is a slow drag, and 40 steps is 4.4 seconds of it.
const STEP_PX = 3;
const STEPS = 40;
const STEP_MS = 110;
// A grip is 18px and a hand lands a couple of px inside it; 2px is the band this repo already uses for the corner.
const CORNER_TOLERANCE_PX = 2;
const THREAD = "panel-assistant";

const results = [];
function check(ok, label, detail) {
  results.push({ ok: Boolean(ok), label, detail: detail == null ? "" : String(detail) });
  const line = `${ok ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`;
  if (JSON_OUT) console.error(line);
  else console.log(line);
}

// A settled turn and a running one, so the console the reader drags is the LAST open turn in the transcript and
// the pane is a real conversation rather than one card on an empty page.
function seedTurns(dir) {
  mkdirSync(path.join(dir, "logs"), { recursive: true });
  const now = Date.now();
  const jobs = [];
  for (let i = 0; i < 2; i += 1) {
    const at = now - (2 - i) * 600_000;
    const running = i === 1;
    const lines = Array.from({ length: running ? 40 : 90 }, (_, k) => ({
      kind: "out",
      text: `turn ${i + 1} line ${k + 1}: the console is longer than the pane, so the transcript has somewhere to be`,
      lid: k + 1,
      at: at + 1_000 + k,
    }));
    jobs.push({
      id: `tkdrag${i + 1}`,
      thread: THREAD,
      turn: i + 1,
      prompt: `fixture turn ${i + 1}`,
      status: running ? "running" : "done",
      exitCode: running ? null : 0,
      startedAt: new Date(at).toISOString(),
      endedAt: running ? null : new Date(at + 30_000).toISOString(),
      durationMs: running ? null : 30_000,
      finalMessage: running ? "" : "done",
      cwd: dir,
      ownerPath: dir,
      worktreePath: dir,
      lines,
    });
  }
  writeFileSync(path.join(dir, "logs", "jobs.json"), JSON.stringify({ savedAt: new Date(now).toISOString(), jobs }, null, 1));
}

// The page half. One object, one place: the console the trace is about, its grip, and the transcript above them.
const PAGE_HELPERS = () => {
  const pane = () => document.querySelector('#assistant [data-subpane="chat"]');
  const body = () => pane()?.querySelector(":scope > .job > .job-body") || null;
  const openTurns = () => (body() ? [...body().querySelectorAll(":scope > .turn:not(.folded)")] : []);
  const out = () => {
    const turns = openTurns();
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const o = turns[i].querySelector(":scope > .out-wrap > .out-box > pre.job-out");
      if (o) return o;
    }
    return null;
  };
  const grip = () => {
    const o = out();
    return o ? o.parentElement.querySelector(":scope > .out-grip") : null;
  };
  window.__D = {
    out,
    grip,
    body,
    // Two pixels inside the corner, which is where a hand lands on an 18px band.
    gripAt: () => {
      const g = grip();
      if (!g) return null;
      const r = g.getBoundingClientRect();
      return { x: +(r.right - 2).toFixed(1), y: +(r.bottom - 2).toFixed(1) };
    },
    // Everything one step of the trace is a statement about. `own` is the console's own scroll, `pin` the
    // transcript's: the two loops write one each, and a step in which BOTH moved is the disagreement.
    read: () => {
      const o = out();
      const g = grip();
      const b = body();
      if (!o || !g || !b) return null;
      const r = o.getBoundingClientRect();
      const gr = g.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return {
        t: Math.round(performance.now()),
        h: +r.height.toFixed(2),
        top: +r.top.toFixed(2),
        bottom: +r.bottom.toFixed(2),
        inline: o.style.height || "",
        varH: o.style.getPropertyValue("--out-h") || "",
        ownTop: o.scrollTop,
        ownMax: o.scrollHeight - o.clientHeight,
        gripTop: +gr.top.toFixed(2),
        gripBottom: +gr.bottom.toFixed(2),
        gripRight: +gr.right.toFixed(2),
        pinTop: b.scrollTop,
        pinSelf: b._selfTop == null ? null : b._selfTop,
        pinMax: b.scrollHeight - b.clientHeight,
        scrollH: b.scrollHeight,
        clientH: b.clientHeight,
        offsetTop: o.offsetTop,
        bodyTop: +br.top.toFixed(2),
        bodyBottom: +br.bottom.toFixed(2),
        scrollY: Math.round(window.scrollY),
        held: typeof outDragging === "function" ? outDragging(o) : null,
        consoleAtBottom: o._atBottom === true,
        bodyAtBottom: b._atBottom !== false,
        dragH: typeof outGripDrag !== "undefined" && outGripDrag && outGripDrag.out === o ? +Number(outGripDrag.h).toFixed(2) : null,
        dragTop: typeof outGripDrag !== "undefined" && outGripDrag && outGripDrag.out === o ? +Number(outGripDrag.top).toFixed(2) : null,
        same: o === window.__D.node,
      };
    },
    mark: () => {
      window.__D.node = out();
      return true;
    },
    // WHICH LOOP WROTE, counted rather than inferred. Every scroll in this page ends in a `scrollTop` assignment
    // (public/board/console.js setScroll is its one writer), so the element's own accessor is where the count lives:
    // a write to a `.job-body` is the transcript's tail pin, a write to a `.job-out` is the console's own tail. The
    // first few carry their calling frame, so a trace names a writer instead of describing one. The pin asks are also
    // wrapped by name - a step that asked neither pin is the drag alone.
    instrument: () => {
      const w = window.__D;
      w.writes = { body: 0, console: 0, pinAsk: 0, settle: 0 };
      w.stacks = w.stacks || [];
      if (typeof globalThis.stickCardBodySoon === "function" && !w.origPin) {
        w.origPin = globalThis.stickCardBodySoon;
        globalThis.stickCardBodySoon = function (el) {
          w.writes.pinAsk += 1;
          return w.origPin(el);
        };
      }
      if (typeof globalThis.stickCardBody === "function" && !w.origSettle) {
        w.origSettle = globalThis.stickCardBody;
        globalThis.stickCardBody = function (el) {
          w.writes.settle += 1;
          return w.origSettle(el);
        };
      }
      if (!w.origScrollTopDesc) {
        const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
        w.origScrollTopDesc = desc;
        Object.defineProperty(Element.prototype, "scrollTop", {
          configurable: true,
          get: desc.get,
          set(v) {
            try {
              const body = this.classList && this.classList.contains("job-body");
              const consoleEl = this.classList && this.classList.contains("job-out");
              if (body) w.writes.body += 1;
              else if (consoleEl) w.writes.console += 1;
              if (body && w.stacks.length < 12) {
                w.stacks.push({ to: Math.round(Number(v) || 0), from: this.scrollTop, at: new Error().stack.split("\n").slice(1, 4).join(" | ") });
              }
            } catch {}
            return desc.set.call(this, v);
          },
        });
      }
      return { pinAsk: Boolean(w.origPin), settle: Boolean(w.origSettle), scrollTop: Boolean(w.origScrollTopDesc) };
    },
    takeWrites: () => {
      const now = { ...window.__D.writes };
      window.__D.writes = { body: 0, console: 0, pinAsk: 0, settle: 0 };
      return now;
    },
    // Feed the stream the way the wire does: the same line id, cumulative text. A live turn is the reader's
    // ordinary state, and it is what asks the tail pin to write while the pointer is down.
    feed: (i, words) => {
      const o = out();
      if (!o) return false;
      const id = o.dataset.out;
      const text = words.slice(0, 2 + i).join(" ");
      appendJobLine({ id, line: { kind: "text", mode: "set", lid: "p1", text, at: Date.now() } });
      return true;
    },
    // A console the reader has ALREADY shrunk: its content is taller than the box, so the console scrolls inside
    // itself and its own tail pin (stickConsole) has somewhere to write. Dragging this one back down is the reader
    // revealing more of the turn they clipped - the case where the box has two scrolls to keep still.
    shrink: (h) => {
      const o = out();
      if (!o) return null;
      // The page's own writer where this tree has one (`--out-h`), and the older inline `height` where it does not:
      // this harness is also run against an archive of main as a failing-first proof, and a fixture that threw there
      // would prove nothing about the shape the reader reported.
      if (typeof setOutHeight === "function") setOutHeight(o, h);
      else o.style.height = `${Math.round(h)}px`;
      o.scrollTop = o.scrollHeight;
      return { h: +o.getBoundingClientRect().height.toFixed(1), ownMax: o.scrollHeight - o.clientHeight, ownTop: o.scrollTop };
    },
    // A row landing in the TURN ABOVE the console: content growing above the reader's place rather than below it.
    // This is the shape that asks the BROWSER's scroll anchoring (not the JS pin) to keep its anchor still, and the
    // anchor it picks is above the console, so its adjustment moves the console's top edge under the hand.
    feedAbove: (i, words) => {
      const turns = openTurns();
      if (turns.length < 2) return false;
      const o = turns[0].querySelector(":scope > .out-wrap > .out-box > pre.job-out");
      if (!o) return false;
      appendJobLine({ id: o.dataset.out, line: { kind: "text", mode: "set", lid: "above", text: words.slice(0, 2 + i).join(" "), at: Date.now() } });
      return true;
    },
  };
};

async function aim(page) {
  let last = null;
  for (let k = 0; k < 40; k += 1) {
    const g = await page.evaluate(() => window.__D.gripAt());
    if (last && g && Math.abs(g.y - last.y) < 0.5 && Math.abs(g.x - last.x) < 0.5) return g;
    last = g;
    await page.waitForTimeout(50);
  }
  return last;
}

// Every turn open: a reader can have several open, and the transcript then has a CONSOLE ABOVE the one they are
// resizing. A folded turn has no console on the page at all, so the shape has to be opened deliberately - and the
// fold is remembered across a reload, which is why this is called after every one.
async function openAllTurns(page) {
  await page.evaluate(() => {
    const b = document.querySelector('#assistant [data-subpane="chat"] > .job > .job-body');
    const turns = b ? [...b.querySelectorAll(":scope > .turn")] : [];
    for (const t of turns) {
      if (t.classList.contains("folded")) t.querySelector("[data-toggle-turn]")?.click();
    }
  });
  await page.waitForTimeout(350);
}

// The reader's reported state: the transcript on its FOOT (the last row at the bottom edge, the composer under it),
// which is where a reader who is watching a live turn sits. The pane's own layout settles after a scroll write, so
// the foot is claimed until it holds rather than once - a press 60px above the foot would measure a different state.
async function settleFoot(page) {
  for (let k = 0; k < 6; k += 1) {
    const r = await page.evaluate(() => {
      const b = window.__D.body();
      if (!b) return null;
      b._atBottom = true;
      b.scrollTop = b.scrollHeight;
      const max = b.scrollHeight - b.clientHeight;
      return { top: b.scrollTop, max, short: max - b.scrollTop };
    });
    if (r && Math.abs(r.short) <= 1) return r;
    await page.waitForTimeout(80);
  }
  return null;
}

// One slow downward drag, one row per step. The pointer is moved BEFORE the read, so a row says what the page
// drew for that step rather than what it had a moment earlier.
async function slowDrag(page, { live = false, above = false, clipped = false } = {}) {
  const shrink = clipped ? await page.evaluate(() => window.__D.shrink(300)) : null;
  const foot = await settleFoot(page);
  const press = await aim(page);
  await page.evaluate(() => window.__D.mark());
  await page.evaluate(() => window.__D.instrument());
  await page.mouse.move(press.x, press.y);
  await page.mouse.down();
  await page.waitForTimeout(60);
  const down = await page.evaluate(() => window.__D.read());
  await page.evaluate(() => window.__D.takeWrites());
  const rows = [];
  let aboveFed = 0;
  try {
    for (let i = 1; i <= STEPS; i += 1) {
      if (live) await page.evaluate((n) => window.__D.feed(n, window.__PROSE), i);
      if (above && (await page.evaluate((n) => window.__D.feedAbove(n, window.__PROSE), i))) aboveFed += 1;
      await page.mouse.move(press.x, press.y + i * STEP_PX);
      await page.waitForTimeout(STEP_MS);
      const now = await page.evaluate(() => window.__D.read());
      const writes = await page.evaluate(() => window.__D.takeWrites());
      rows.push({ i, pointerY: +(press.y + i * STEP_PX).toFixed(1), writes, ...now });
    }
  } finally {
    await page.mouse.up();
  }
  await page.waitForTimeout(200);
  const released = await page.evaluate(() => window.__D.read());
  return { press, foot, down, rows, released, aboveFed, shrink };
}

const PROSE =
  "The reply arrives one word at a time and the reader is sitting on its last line while they pull the console open, " +
  "so every word the stream still owes is a row landing above the corner their hand is on and a scroll the tail pin owes them.";

async function main() {
  const pw = loadPlaywright({ root: ROOT });
  if (!pw) return notRun("no Playwright install (set PANEL_PLAYWRIGHT_ROOT)");

  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-corner-slow-"));
  seedTurns(dir);
  const panel = await startPanel({
    root: ROOT,
    dir,
    keep: KEEP,
    config: { assistant: { enabled: false }, fetchSeconds: -1, refreshSeconds: 3600 },
  });
  const numbers = { stepPx: STEP_PX, steps: STEPS, stepMs: STEP_MS };
  const trace = { press: null, scenarios: {} };
  try {
    await withBrowser(
      async ({ page, pageErrors }) => {
        await installFakeEventSource(page);
        await page.addInitScript((prose) => {
          window.__PROSE = prose.split(" ");
          try {
            localStorage.setItem("wm.assistantOpen", "1");
            localStorage.removeItem("wtgui.zoom");
          } catch {}
        }, PROSE);
        await openPage(page, panel.base, { selector: "#jobs" });
        await page.waitForSelector('#assistant [data-subpane="chat"] .turn', { state: "attached", timeout: 30_000 });
        await page.waitForTimeout(400);
        // Every turn open: a reader can have several open, and the transcript then has a CONSOLE ABOVE the one they
        // are resizing - which is the shape where content grows above the reader's place and the browser's own
        // scroll anchoring, not the page's pin, decides where the box the hand is on ends up.
        await openAllTurns(page);
        await page.evaluate(PAGE_HELPERS);
        await page.evaluate(() => window.__D.mark());
        // The transcript is on its foot, the state the reader reports from: the console is the last thing in a
        // scrollport that is following the newest line.
        await page.evaluate(() => {
          const b = window.__D.body();
          b._atBottom = true;
          b.scrollTop = b.scrollHeight;
        });
        await page.waitForTimeout(200);

        for (const scenario of ["settled", "live", "above", "clipped"]) {
          const live = scenario === "live" || scenario === "clipped";
          const above = scenario === "above";
          const clipped = scenario === "clipped";
          if (scenario !== "settled") {
            // Re-press the same console from a settled state: the drag is the only thing that changed.
            await page.reload({ waitUntil: "domcontentloaded" });
            await page.waitForSelector('#assistant [data-subpane="chat"] .turn', { state: "attached", timeout: 30_000 });
            await page.waitForTimeout(500);
            await page.evaluate(PAGE_HELPERS);
            await page.evaluate(() => window.__D.mark());
            await openAllTurns(page);
          }
          const run = await slowDrag(page, { live, above, clipped });
          trace.scenarios[scenario] = run;
          const pressGap = run.down ? run.down.gripBottom - run.press.y : 0;
          const want = (i) => +(run.press.y + i * STEP_PX).toFixed(1);
          const corner = run.rows.map((s) => +(s.gripBottom - (pressGap + want(s.i))).toFixed(2));
          const heights = run.rows.map((s) => +(run.down.h + (s.h - run.down.h)).toFixed(2));
          const stepH = run.rows.map((s, k) => +(s.h - (k === 0 ? run.down.h : run.rows[k - 1].h)).toFixed(2));
          const tops = run.rows.map((s) => s.top);
          const pins = run.rows.map((s) => s.pinTop);
          const key = scenario;
          const lastRow = run.rows[run.rows.length - 1];
          numbers[`${key}PressGapPx`] = +pressGap.toFixed(2);
          numbers[`${key}WorstCornerPx`] = +Math.max(...corner.map(Math.abs)).toFixed(2);
          numbers[`${key}CornerAtEndPx`] = corner[corner.length - 1];
          numbers[`${key}HeightGrownPx`] = +(lastRow.h - run.down.h).toFixed(2);
          numbers[`${key}PointerTravelPx`] = STEPS * STEP_PX;
          numbers[`${key}TopMovedPx`] = +(lastRow.top - run.down.top).toFixed(2);
          numbers[`${key}PinMovedPx`] = +(lastRow.pinTop - run.down.pinTop).toFixed(2);
          numbers[`${key}OwnScrollMovedPx`] = +(lastRow.ownTop - run.down.ownTop).toFixed(2);
          numbers[`${key}StepsHeightNotTravel`] = stepH.filter((d) => Math.abs(d - STEP_PX) > 1).length;
          numbers[`${key}StepsCornerNotPointer`] = corner.filter((d) => Math.abs(d) > CORNER_TOLERANCE_PX).length;
          numbers[`${key}RetrogradeSteps`] = stepH.filter((d) => d < -1).length;
          numbers[`${key}ReleasedHeightPx`] = run.released ? run.released.h : null;
          numbers[`${key}ReleasedShortOfFootPx`] = run.released ? +(run.released.pinMax - run.released.pinTop).toFixed(2) : null;
          numbers[`${key}ReleasedFollowing`] = run.released ? run.released.bodyAtBottom : null;
          numbers[`${key}ReleasedVar`] = run.released ? run.released.varH : "";
          trace.scenarios[key].summary = {
            pressGap: +pressGap.toFixed(2),
            corner,
            stepH,
            heights,
            tops,
            pins,
            worstCorner: numbers[`${key}WorstCornerPx`],
          };
          const table = run.rows
            .filter((s) => s.i % 4 === 1 || Math.abs(corner[s.i - 1]) > CORNER_TOLERANCE_PX)
            .map(
              (s) =>
                `  step ${String(s.i).padStart(2)}  pointer ${String(want(s.i)).padStart(6)}  ` +
                `grip ${String(s.gripBottom).padStart(6)}  h ${String(s.h).padStart(6)}  top ${String(s.top).padStart(6)}  ` +
                `pin ${String(s.pinTop).padStart(5)}/${String(s.pinMax).padStart(5)}  own ${String(s.ownTop).padStart(5)}  ` +
                `sh/ch ${String(s.scrollH).padStart(5)}/${String(s.clientH).padStart(4)}  offTop ${String(s.offsetTop).padStart(6)}  ` +
                `writes b${s.writes.body}/c${s.writes.console}/ask${s.writes.pinAsk}/set${s.writes.settle}  ` +
                `off ${String(corner[s.i - 1]).padStart(7)}`,
            )
            .join("\n");
          if (!JSON_OUT) console.log(`\nTRACE ${key} (${STEPS} steps of ${STEP_PX}px, ${STEP_MS}ms apart)\n${table}\n`);
          if (key === "above") {
            check(run.aboveFed === STEPS, "above: the burst above the console really landed", `${run.aboveFed}/${STEPS} rows fed into the turn above`);
          }
          if (key === "clipped") {
            check(
              Boolean(run.shrink) && run.shrink.ownMax > 0,
              "clipped: the console really has an internal scroll to keep still",
              run.shrink ? `${run.shrink.h}px tall, ${run.shrink.ownMax}px of content below the fold` : "the console could not be shrunk",
            );
          }
          check(Boolean(run.foot), `${key}: the press starts on the transcript's foot`, run.foot ? `${run.foot.short}px short of the foot` : "the foot could not be claimed");
          check(
            numbers[`${key}WorstCornerPx`] <= CORNER_TOLERANCE_PX,
            `${key}: the grip stays under the pointer at every step`,
            `worst ${numbers[`${key}WorstCornerPx`]}px, ${numbers[`${key}StepsCornerNotPointer`]}/${STEPS} steps over ${CORNER_TOLERANCE_PX}px`,
          );
          check(
            numbers[`${key}RetrogradeSteps`] === 0,
            `${key}: the box never moves back under the pointer`,
            `${numbers[`${key}RetrogradeSteps`]} retrograde step(s)`,
          );
          check(
            numbers[`${key}HeightGrownPx`] >= STEPS * STEP_PX - 2,
            `${key}: the height grew by the pointer's own travel (the drag, not the pin)`,
            `height +${numbers[`${key}HeightGrownPx`]}px for ${STEPS * STEP_PX}px of travel in ${STEPS} steps`,
          );
          // THE LOOP THAT DISAGREED, read as the two numbers it writes. If the transcript's top edge moves at all while
          // the hand is down, its pin is back in the gesture and the corner only looks right because the two errors
          // happened to cancel on this run.
          check(
            Math.abs(numbers[`${key}TopMovedPx`]) <= 1,
            `${key}: nothing re-pinned the transcript's foot while the pointer was down`,
            `box top moved ${numbers[`${key}TopMovedPx`]}px, transcript scrollTop moved ${numbers[`${key}PinMovedPx`]}px`,
          );
          // THE FOLLOW PROMISE, after the hand: a transcript that was on its foot is on its foot again, so a resize
          // cannot silently stop the stream from following.
          check(
            numbers[`${key}ReleasedFollowing`] === true && Math.abs(numbers[`${key}ReleasedShortOfFootPx`]) <= 2,
            `${key}: the release puts a following transcript back on its foot`,
            `${numbers[`${key}ReleasedShortOfFootPx`]}px short of the foot, following ${numbers[`${key}ReleasedFollowing`]}`,
          );
          check(
            numbers[`${key}ReleasedVar`] !== "",
            `${key}: the height the gesture chose is written where the one owner writes it`,
            `--out-h ${numbers[`${key}ReleasedVar`] || "(unset)"}, drawn ${numbers[`${key}ReleasedHeightPx`]}px`,
          );
        }
        numbers.pageErrors = pageErrors.length;
        const stacks = await page.evaluate(() => window.__D.stacks || []);
        if (stacks.length && !JSON_OUT) {
          console.log("\nWHO WROTE THE TRANSCRIPT'S scrollTop (first writes, with the calling frame):");
          for (const s of stacks) console.log(`  ${s.from} -> ${s.to}  ${s.at}`);
        }
        trace.writers = stacks;
        check(pageErrors.length === 0, "the page threw nothing", pageErrors.slice(0, 3).join(" | "));
      },
      { viewport: { width: 1440, height: 900 } },
    );
  } finally {
    await panel.stop();
    if (!KEEP) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    else console.log(`sandbox kept: ${dir}`);
  }

  // THE SANDBOX'S OWN HYGIENE, asserted rather than assumed: `panel.stop()` is the only thing that kills the server
  // this run started, and a gate that leaks a node process on every landing is a defect in the gate. Signal 0 is the
  // "does this pid exist" question on both platforms, so this is the same check a reader runs by hand.
  const pidAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (panel.pid && pidAlive(panel.pid)) {
    try {
      process.kill(panel.pid, "SIGKILL");
    } catch {
      /* it went away between the question and the kill */
    }
    check(false, "the sandbox panel this run started is gone", `pid ${panel.pid} was still alive after panel.stop() - killed`);
  } else {
    check(true, "the sandbox panel this run started is gone", `pid ${panel.pid} exited with the run`);
  }

  if (TRACE) writeFileSync(path.resolve(TRACE), JSON.stringify(trace, null, 1), "utf8");
  if (TRACE) console.log(`trace: ${path.resolve(TRACE)}`);
  const failures = results.filter((r) => !r.ok).length;
  if (JSON_OUT) console.log(JSON.stringify({ root: ROOT, checks: results, numbers, failures }, null, 1));
  else {
    console.log(
      "NUMBERS " +
        ["settled", "live", "above", "clipped"]
          .map((k) => `${k} worst corner ${numbers[`${k}WorstCornerPx`]}px (top moved ${numbers[`${k}TopMovedPx`]}, pin moved ${numbers[`${k}PinMovedPx`]}, height +${numbers[`${k}HeightGrownPx`]})`)
          .join(" | "),
    );
    console.log(failures ? `RESULT: FAIL (${failures} check${failures === 1 ? "" : "s"})` : "RESULT: PASS");
  }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
