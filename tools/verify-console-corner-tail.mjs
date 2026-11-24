#!/usr/bin/env node
// The console's two "stays put" promises, on a LIVE turn: the corner grip under the pointer that grabbed it, and the
// tail under the line the reader is reading while rows arrive above it.
//
//   node tools/verify-console-corner-tail.mjs
//   node tools/verify-console-corner-tail.mjs --keep                     # leave the sandbox behind
//   node tools/verify-console-corner-tail.mjs --json                     # the numbers as one JSON object
//   node tools/verify-console-corner-tail.mjs --root <dir>               # run the checks against another checkout
//
// WHAT THIS GUARDS. tools/verify-console-resize.mjs drives the grip on a settled card and tools/verify-console-jitter.mjs
// drives a settled stream; neither one drives the gesture or the tail while the turn is still writing. That is the state
// the reader is actually in, and the state the order-based hold (public/core/type-stream.js createReasoningHold) changed:
// a row stamped behind a paragraph that is still being typed is no longer drawn when it arrives, it is released later,
// from a timer. A row released from a timer is in the DOM at the end of that task, and an animation frame asked for from
// that task runs in the NEXT frame, so the correction lands one paint too late.
//
// What is measured, and what it has to be:
//
//   1. THE CORNER. Eight 12px steps of a pressed pointer, with prose and a tool call arriving under the gesture. At every
//      step the box's height must have moved by the pointer's own travel (1px), the grip's bottom-right corner must be
//      on the pointer (2px), and no step may move more than the pointer did (that is the jump). The release then runs the
//      one clamp (outGripRelease) EXACTLY once, and the height it lands on is written on the box, into the store and
//      through the rebuild that follows a board-wide renderAll().
//   2. THE TAIL. A live turn with the typewriter on and the console on its newest line: prose arrives the way the wire
//      sends it (a few words a frame, the same line id, cumulative text), a tool call is stamped in the middle of a
//      paragraph and its result follows, then a second paragraph. Every painted frame is sampled, and the newest row's
//      bottom must stay within 4px of the box's own bottom edge while the rows above it are appended and swapped.
//
// The numbers are printed both as PASS/FAIL detail and, with --json, as `numbers`, so a report can quote them.
//
// The browser half needs a Playwright install. Point the script at one with PANEL_PLAYWRIGHT_ROOT (a directory holding
// node_modules/playwright, or the package itself); without one it says BROWSER-HALF-NOT-RUN and exits 2 rather than
// passing on a half that never ran.
import { mkdtempSync, rmSync } from "node:fs";
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
const ROOT = path.resolve(opt("root", REPO));

// The reader's reading settings, and the two shapes this file drives. A live turn with the typewriter OFF types
// nothing, so the hold has nothing to wait for and the tail cannot be late: 14 words/s is the slow end of the setting,
// which is where a reader who reports jitter is.
const WORDS_PER_SEC = 14;
const STEP_PX = 12; // the pointer's own travel per move
const STEPS = 8;
const TAIL_TOLERANCE_PX = 4; // the page's own band: verify-console-jitter.mjs uses the same 4px
const CORNER_TOLERANCE_PX = 2; // a grip is 18px; 2px is inside the finger that is holding it

const PROSE = (
  "The reply arrives as one paragraph and the reader is sitting on its last line, so every word the stream still owes " +
  "moves the text under them, and the call the agent made in the middle of that paragraph is stamped in the stream " +
  "behind words that have not been handed over yet. The order-based hold is what decides when that call may be drawn: " +
  "it waits for the paragraph ahead of it, and then it lets the row go from a timer rather than from the wire."
).split(" ");

const results = [];
function check(ok, label, detail) {
  results.push({ ok: Boolean(ok), label, detail: detail == null ? "" : String(detail) });
  const line = `${ok ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`;
  if (JSON_OUT) console.error(line);
  else console.log(line);
}

// Everything the page half needs, installed once. `boot` fabricates ONE live turn through the page's own append path
// (appendJobLine is what the panel's SSE handler calls), so the shapes a frame is drawn from are the wire's.
const PAGE_HELPERS = () => {
  const id = "corner-tail";
  const thread = "corner-tail-thread";
  window.__C = { id, thread, wire: [], frames: [], on: false, clamp: 0 };

  const live = () => ({ events: 1, lastEventAt: Date.now(), startedAt: Date.now(), seq: 1, stream: "open", streaming: true, tool: null });
  const out = () => document.querySelector(`pre.job-out[data-out="${id}"]`);
  const grip = () => document.querySelector(`.job[data-thread="${thread}"] [data-out-grip]`);
  // Two pixels inside the corner, which is where a hand lands on an 18px band.
  window.__C.gripAt = () => {
    const g = grip().getBoundingClientRect();
    return { x: +(g.right - 2).toFixed(1), y: +(g.bottom - 2).toFixed(1) };
  };

  window.__C.boot = ({ rows = 34, height = null, fillers = 3 } = {}) => {
    const now = Date.now();
    state.jobs.clear();
    state.jobLines.clear();
    document.getElementById("jobs").innerHTML = "";
    state.jobsListSig = "";
    state.outPinned = {};
    if (height == null) state.outHeights = {};
    state.jobs.set(id, {
      id, thread, turn: 1, status: "running", prompt: "probe: corner and tail", displayPrompt: "probe: corner and tail",
      cwd: null, startedAt: new Date(now - 30_000).toISOString(), endedAt: null, lines: [],
      artifacts: [], attachments: [], subagents: [], live: live(),
    });
    // A reader's board has other cards on it. Without them the page is only as tall as this one console and sits at
    // its own scroll maximum, where every 12px the box loses also drops the document's maximum: the browser clamps the
    // scroll and the viewport follows the shrinking box, which is the page moving, not the gesture.
    for (let f = 0; f < fillers; f += 1) {
      const fid = `filler-${f}`;
      state.jobs.set(fid, {
        id: fid, thread: `filler-thread-${f}`, turn: 1, status: "done", prompt: `settled turn ${f}`, displayPrompt: `settled turn ${f}`,
        cwd: null, startedAt: new Date(now - 900_000).toISOString(), endedAt: new Date(now - 890_000).toISOString(),
        lines: Array.from({ length: 16 }, (_, k) => ({ kind: "out", text: `  settled ${f} line ${k}`, lid: k + 1, at: now - 900_000 + k })),
        artifacts: [], attachments: [], subagents: [], live: null,
      });
    }
    renderJobs();
    for (let k = 0; k < rows; k += 1) {
      appendJobLine({ id, line: { kind: "out", text: `  history ${k + 1} of the console this reader is reading`, lid: k + 1, at: now - 60_000 + k } });
    }
    const box = out();
    state.outPinned[id] = true;
    box._atBottom = true;
    box.scrollTop = box.scrollHeight;
    window.__C.wire = [];
    return {
      rows: box.children.length,
      h: +box.getBoundingClientRect().height.toFixed(1),
      gap: +(box.lastElementChild.getBoundingClientRect().bottom - box.getBoundingClientRect().bottom).toFixed(1),
      grip: (() => { const g = grip().getBoundingClientRect(); return { x: +(g.right - 2).toFixed(1), y: +(g.bottom - 2).toFixed(1) }; })(),
    };
  };

  window.__C.feed = (line) => {
    window.__C.wire.push(`${line.kind}:${line.lid ?? ""}`);
    return appendJobLine({ id, line, live: line.kind === "tool" || line.kind === "tool-out" ? live() : undefined });
  };

  // One probe per painted frame: the browser has painted after every animation-frame callback of a frame, so a task
  // queued from inside one reads the state that was actually on screen, not the state before the page's own stick ran.
  window.__C.sample = () => {
    const box = out();
    if (!box || box.clientHeight < 60) return;
    const r = box.getBoundingClientRect();
    const rows = [...box.children];
    const last = rows[rows.length - 1];
    const lr = last ? last.getBoundingClientRect() : null;
    window.__C.frames.push({
      t: Math.round(performance.now()),
      n: rows.length,
      gap: lr ? +(lr.bottom - r.bottom).toFixed(1) : null,
      short: Math.round(box.scrollHeight - box.clientHeight - box.scrollTop),
      drew: (box.textContent || "").length,
      q: typeof state.typeHold?.queued === "function" ? state.typeHold.queued(id) : -1,
    });
  };
  window.__C.watch = () => {
    window.__C.frames = [];
    window.__C.on = true;
    const loop = () =>
      requestAnimationFrame(() => {
        setTimeout(() => {
          window.__C.sample();
          if (window.__C.on) loop();
        }, 0);
      });
    loop();
  };
  window.__C.stop = () => {
    window.__C.on = false;
    return window.__C.frames;
  };

  // The gesture's own measurements, read from the nodes the gesture is driving.
  window.__C.box = () => {
    const box = out();
    const g = grip();
    if (!box || !g) return null;
    const r = box.getBoundingClientRect();
    const gr = g.getBoundingClientRect();
    return {
      h: +r.height.toFixed(1),
      top: +r.top.toFixed(1),
      scrollY: Math.round(window.scrollY),
      inline: box.style.getPropertyValue("--out-h"),
      max: box.style.maxHeight,
      gripRight: +gr.right.toFixed(1),
      gripBottom: +gr.bottom.toFixed(1),
      same: box === window.__C.node,
      held: typeof outDragging === "function" ? outDragging(box) : null,
    };
  };
  window.__C.node = null;
  window.__C.mark = () => {
    window.__C.node = out();
    return true;
  };
  // outGripRelease is the one clamp (public/app.js). It is a top-level function of a classic script, so the global
  // binding can be wrapped and the count is the page's own call count, not a re-implementation of it.
  window.__C.countClamp = () => {
    window.__C.clamp = 0;
    const orig = globalThis.outGripRelease;
    // Spread, not one argument: outGripRelease takes (height, floor, room), and a wrapper that passed only the height
    // would answer its own question with the floor.
    globalThis.outGripRelease = (...a) => {
      window.__C.clamp += 1;
      return orig(...a);
    };
    return typeof orig === "function";
  };
  window.__C.stored = () => ({
    clamp: window.__C.clamp,
    store: Number(state.outHeights[window.__C.id]) || 0,
    local: (() => {
      try {
        return Number((JSON.parse(localStorage.getItem("wm.outHeights") || "{}") || {})[window.__C.id]) || 0;
      } catch {
        return 0;
      }
    })(),
    pinned: state.outPinned[window.__C.id],
  });
};

const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

async function main() {
  const pw = loadPlaywright({ root: ROOT });
  if (!pw) return notRun("no Playwright install (set PANEL_PLAYWRIGHT_ROOT)");

  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-corner-tail-"));
  const panel = await startPanel({
    root: ROOT,
    dir,
    keep: KEEP,
    config: { assistant: false, fetchSeconds: 0, refreshSeconds: 0, scanRoots: [path.join(dir, "empty-root")] },
  });
  const numbers = {};
  try {
    await withBrowser(
      async ({ page, pageErrors }) => {
        await installFakeEventSource(page);
        await page.addInitScript(() => {
          try {
            localStorage.setItem("wtgui.think", "1");
            localStorage.setItem("wtgui.stream", "1");
            localStorage.setItem("wtgui.streamWords", "14");
          } catch {}
        });
        await openPage(page, panel.base, { selector: "#jobs" });
        await page.evaluate(PAGE_HELPERS);
        await page.waitForTimeout(300);

        // ---- 1. the corner, under a live turn -----------------------------------------------------------------
        const boot = await page.evaluate(() => window.__C.boot({ rows: 34 }));
        check(boot.rows >= 34 && boot.h > 0, "a live turn's console is on the board at its cap", `rows ${boot.rows}, h ${boot.h}px`);
        // The turn is warmed first: the first frame a live turn draws puts the card's own live row in place, and the head
        // growing under a gesture is the page moving, not the corner. Everything the head needs is drawn before the press.
        await page.evaluate((words) => window.__C.feed({ kind: "text", mode: "set", lid: "warm", text: `${words.slice(0, 6).join(" ")} before the corner is taken`, at: Date.now() }), PROSE);
        await page.waitForTimeout(300);
        // The card is brought clear of the sticky topbar first: the release clamp keeps the box inside the room under
        // its own top edge, and a card sitting mid-page would be clamped to the sheet's floor rather than to the height
        // the gesture reached (which is a different check, and not this one).
        await page.evaluate(() => {
          const card = document.querySelector('.job[data-thread="corner-tail-thread"]');
          window.scrollTo(0, Math.max(0, Math.round(card.getBoundingClientRect().top + window.scrollY) - 96));
        });
        await page.waitForTimeout(250);
        const shown = await page.evaluate(() => window.__C.box());
        check(shown && shown.top > 0 && shown.top < 420, "the card is clear of the topbar", `box top ${shown && shown.top}px, scrollY ${shown && shown.scrollY}`);
        // The card's own head carries a live row, and it can settle once more after the first frame of a turn, which moves
        // the console down the page. A hand on the grip would feel that as the corner running away, and it is not the
        // gesture this verifier is about, so the corner is taken only once it has stopped moving, and a press that missed
        // is re-aimed: what is measured is the drag, not the card's chrome.
        const aim = async () => {
          let last = null;
          for (let k = 0; k < 40; k += 1) {
            const g = await page.evaluate(() => window.__C.gripAt());
            if (last && Math.abs(g.y - last.y) < 0.5 && Math.abs(g.x - last.x) < 0.5) return g;
            last = g;
            await page.waitForTimeout(50);
          }
          return last;
        };
        let press = await aim();
        let down = null;
        let attempts = 0;
        for (; attempts < 3; attempts += 1) {
          await page.mouse.move(press.x, press.y);
          await page.mouse.down();
          await page.waitForTimeout(60);
          down = await page.evaluate(() => window.__C.box());
          if (down && down.held === true && near(down.gripBottom, press.y, CORNER_TOLERANCE_PX)) break;
          await page.mouse.up();
          await page.waitForTimeout(120);
          press = await aim();
        }
        numbers.cornerPressAttempts = attempts + 1;
        await page.evaluate(() => window.__C.mark());
        check(await page.evaluate(() => window.__C.countClamp()), "the release clamp can be counted", "outGripRelease wrapped");
        check(
          down && down.held === true && near(down.gripBottom, press.y, CORNER_TOLERANCE_PX),
          "the press landed on the grip",
          `grip bottom ${down && down.gripBottom} vs pointer ${press.y}, attempt ${attempts + 1}`,
        );
        check(down && down.held === true, "and the page knows the gesture owns the box", `outDragging ${down && down.held}`);

        // A live turn does not stop while the reader holds the corner: the paragraph keeps growing and a call is stamped
        // into the middle of it, so the hold is asked for a decision under the gesture.
        const steps = [];
        for (let i = 1; i <= STEPS; i += 1) {
          await page.evaluate(
            (n) => {
              const words = n.w;
              window.__C.feed({ kind: "text", mode: "set", lid: "p1", text: words.slice(0, 3 * n.i).join(" "), at: Date.now() });
              if (n.i === 4) window.__C.feed({ kind: "tool", text: "$ npm test --grep console-tail", lid: "t1", at: Date.now() });
              if (n.i === 6) window.__C.feed({ kind: "tool-out", text: "  12 passing (3s)", lid: "t1.out", at: Date.now() });
            },
            { i, w: PROSE },
          );
          await page.mouse.move(press.x, press.y - i * STEP_PX);
          await page.waitForTimeout(45);
          steps.push({ i, ...(await page.evaluate(() => window.__C.box())) });
        }
        const drawn = steps.map((s) => s.h);
        const travel = steps.map((s, k) => (k === 0 ? down.h - s.h : steps[k - 1].h - s.h));
        // Drift is measured from where the press landed, not from the pointer's absolute position: a hand that takes the
        // corner 2px inside it keeps that 2px for the whole gesture, and nothing else may move.
        const pressGap = down.gripBottom - press.y;
        const worstCorner = Math.max(...steps.map((s) => Math.abs(s.gripBottom - pressGap - (press.y - s.i * STEP_PX))));
        const worstStep = Math.max(...travel.map((d) => Math.abs(d - STEP_PX)));
        const jump = Math.max(...steps.map((s, k) => (k === 0 ? Math.abs(down.h - s.h - STEP_PX) : Math.abs(steps[k - 1].h - s.h - STEP_PX))));
        numbers.cornerPressGapPx = +pressGap.toFixed(1);
        numbers.cornerWorstOffsetPx = +worstCorner.toFixed(1);
        numbers.cornerWorstStepErrorPx = +worstStep.toFixed(1);
        numbers.cornerMaxJumpPx = +jump.toFixed(1);
        numbers.cornerSteps = steps.map((s) => ({ h: +s.h.toFixed(1), grip: s.gripBottom, want: +(press.y - s.i * STEP_PX).toFixed(1), top: s.top, scrollY: s.scrollY }));
        check(worstCorner <= CORNER_TOLERANCE_PX, "the grip stays under the pointer at every step of the gesture", `worst ${numbers.cornerWorstOffsetPx}px of ${STEPS} steps (${STEPS * STEP_PX}px travel)`);
        check(worstStep <= 1, "and the box follows the pointer's own travel, 12px a step", `worst step error ${numbers.cornerWorstStepErrorPx}px, heights ${drawn.join("/")}`);
        check(jump <= 1, "with no step of the box that the pointer did not make", `worst jump ${numbers.cornerMaxJumpPx}px`);
        check(steps.every((s) => s.same === true), "and no rebuild replaced the node under the hand", `same node at ${steps.filter((s) => s.same).length}/${STEPS} steps`);

        const dragAtRelease = await page.evaluate(() => {
          try {
            const d = outGripDrag;
            if (!d) return null;
            const r = d.out.getBoundingClientRect();
            return {
              h: +Number(d.h).toFixed(1), min: d.min, cap: d.cap, from: +Number(d.from).toFixed(1), moved: d.moved,
              top: +r.top.toFixed(1), innerH: window.innerHeight, inline: d.out.style.getPropertyValue("--out-h"),
              room: Math.max(Number.isFinite(d.cap) ? d.cap : 0, Math.round(window.innerHeight - r.top - 8)),
            };
          } catch (e) {
            return { error: String(e) };
          }
        });
        numbers.dragAtRelease = dragAtRelease;
        await page.mouse.up();
        await page.waitForTimeout(160);
        const released = await page.evaluate(() => window.__C.box());
        const after = await page.evaluate(() => window.__C.stored());
        numbers.clampCalls = after.clamp;
        numbers.keptHeightPx = released.h;
        check(after.clamp === 1, "the release clamp fires exactly once, on the pointerup", `outGripRelease called ${after.clamp} time${after.clamp === 1 ? "" : "s"}`);
        check(released.held === false && released.inline !== "", "the height the gesture reached is written on the box", `inline ${released.inline}, outDragging ${released.held}`);
        check(after.store === Math.round(released.h) && after.local === Math.round(released.h), "and remembered in the store the reload reads", `state ${after.store}px, localStorage ${after.local}px`);

        await page.evaluate(() => renderAll());
        await page.waitForTimeout(160);
        const rebuilt = await page.evaluate(() => ({ h: +document.querySelector('pre.job-out[data-out="corner-tail"]').getBoundingClientRect().height.toFixed(1), inline: document.querySelector('pre.job-out[data-out="corner-tail"]').style.getPropertyValue("--out-h") }));
        numbers.rebuildHeightPx = rebuilt.h;
        check(near(rebuilt.h, released.h, 1), "the chosen height survives the board rebuild that follows", `${released.h}px -> ${rebuilt.h}px (${rebuilt.inline})`);

        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => typeof state !== "undefined" && state.jobs, null, { timeout: 30_000 });
        const reloaded = await page.evaluate(() => {
          try {
            return { store: Number((JSON.parse(localStorage.getItem("wm.outHeights") || "{}") || {}).cornerTail) || Number((JSON.parse(localStorage.getItem("wm.outHeights") || "{}") || {})["corner-tail"]) || 0, loaded: Number(state.outHeights["corner-tail"]) || 0 };
          } catch {
            return { store: 0, loaded: 0 };
          }
        });
        numbers.reloadHeightPx = reloaded.loaded;
        check(near(reloaded.loaded, released.h, 1), "and a reload still knows it", `state.outHeights after reload ${reloaded.loaded}px`);

        // ---- 2. the tail, under a burst -----------------------------------------------------------------------
        await page.evaluate(PAGE_HELPERS);
        await page.waitForTimeout(200);
        const tailBoot = await page.evaluate(() => window.__C.boot({ rows: 34 }));
        check(near(tailBoot.gap, -9, 2) || tailBoot.gap < 0, "the console starts on its newest line", `newest row ${tailBoot.gap}px from the box's bottom edge`);

        // The burst: five phases of the shape a live turn actually has. A paragraph arrives in the wire's own deltas (the
        // same line id, cumulative text, a few words a frame), a call is stamped into the middle of it and is held until
        // the paragraph's last word is out, and its output lands while it waits. Each release draws several rows in one
        // task, which is the shape that paints a row before the page's own stick has run.
        await page.evaluate(() => {
          window.__C.watch();
          window.__C.at = Date.now();
        });
        // One item per painted frame. The wire does not hand a turn three rows in one task, and a burst that did would
        // measure this harness's own batching: with the rows stacked, every version below shows the same 45px slip, which
        // is the harness's shape and not the page's.
        const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0))));
        const phase = async (n) => {
          for (let i = 0; i < 6; i += 1) {
            await page.evaluate(
              (a) => window.__C.feed({ kind: "text", mode: "set", lid: `p${a.n}`, text: a.words.slice(0, 3 * (a.i + 1)).join(" "), at: window.__C.at }),
              { n, i, words: PROSE.slice(0, 18) },
            );
            await frame();
            if (i === 2) {
              await page.evaluate((k) => window.__C.feed({ kind: "tool", text: `$ npm test --grep console-tail-${k}`, lid: `t${k}`, at: Date.now() }), n);
              await frame();
            }
            if (i === 3) {
              for (const part of ["a", "b", "c"]) {
                await page.evaluate((p) => window.__C.feed({ kind: "tool-out", text: `  12 passing in ${p} (3s)`, lid: `t${p.k}.${p.part}`, at: Date.now() }), { k: n, part });
                await frame();
              }
            }
            await page.waitForTimeout(55);
          }
          // Let the hold let go and the release paint before the next phase starts.
          await page.waitForTimeout(900);
        };
        for (let n = 1; n <= 5; n += 1) await phase(n);
        await page.waitForTimeout(900);

        const tail = await page.evaluate(() => {
          const frames = window.__C.stop();
          const real = frames.filter((f) => f.gap != null && f.n > 30);
          const base = real.length ? real[0].gap : 0;
          const dev = real.map((f) => +(Math.abs(f.gap - base)).toFixed(1));
          const over = real.map((f, i) => ({ i, dev: dev[i], ...f })).filter((f) => f.dev > 4).slice(0, 6);
          return {
            frames: real.length,
            base,
            maxDev: dev.length ? +Math.max(...dev).toFixed(1) : 0,
            over4: dev.filter((d) => d > 4).length,
            worstShort: Math.max(...real.map((f) => Math.abs(f.short))),
            worst: over,
            heldPeak: Math.max(...real.map((f) => f.q)),
            rows: real.length ? real[real.length - 1].n : 0,
            drew: real.length ? real[real.length - 1].drew : 0,
          };
        });
        numbers.tailFrames = tail.frames;
        numbers.tailBaselineGapPx = tail.base;
        numbers.tailWorstRowBelowBoxPx = tail.maxDev;
        numbers.tailFramesOver4Px = tail.over4;
        numbers.tailWorstShortOfTailPx = tail.worstShort;
        numbers.tailHoldPeak = tail.heldPeak;
        check(tail.heldPeak >= 1, "the burst asked the order-based hold for a decision", `${tail.heldPeak} frame(s) waiting at the peak`);
        check(tail.rows > 35 && tail.drew > 100, "and the rows really arrived and were drawn", `rows ${tail.rows}, ${tail.drew} chars of console text`);
        check(tail.maxDev <= TAIL_TOLERANCE_PX, "the newest row stays on the box's bottom edge while rows above it arrive", `worst ${numbers.tailWorstRowBelowBoxPx}px off the baseline ${tail.base}px, ${tail.over4}/${tail.frames} frames over ${TAIL_TOLERANCE_PX}px`);
        check(tail.worstShort <= TAIL_TOLERANCE_PX, "so the console is never painted off its tail", `worst ${numbers.tailWorstShortOfTailPx}px short of the tail`);
        if (tail.worst.length) numbers.tailWorstFrames = tail.worst;

        check(pageErrors.length === 0, "the page threw nothing", pageErrors.slice(0, 3).join(" | "));
      },
      { viewport: { width: 1440, height: 900 } },
    );
  } finally {
    await panel.stop();
    if (!KEEP) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    else console.log(`sandbox kept: ${dir}`);
  }

  const failures = results.filter((r) => !r.ok).length;
  if (JSON_OUT) console.log(JSON.stringify({ root: ROOT, checks: results, numbers, failures }, null, 1));
  else {
    console.log(
      `NUMBERS corner worst-offset ${numbers.cornerWorstOffsetPx}px, worst-step ${numbers.cornerWorstStepErrorPx}px, ` +
        `max-jump ${numbers.cornerMaxJumpPx}px, clamp calls ${numbers.clampCalls}, height ${numbers.keptHeightPx}px | ` +
        `tail worst ${numbers.tailWorstRowBelowBoxPx}px below the box, ${numbers.tailFramesOver4Px}/${numbers.tailFrames} frames over 4px, ` +
        `${numbers.tailWorstShortOfTailPx}px short of the tail`,
    );
    console.log(failures ? `RESULT: FAIL (${failures} check${failures === 1 ? "" : "s"})` : "RESULT: PASS");
  }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
