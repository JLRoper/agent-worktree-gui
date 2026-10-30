#!/usr/bin/env node
// The assistant float's eight resize grabs, proved by driving a panel of its own — and a real browser over it.
//
//   node tools/verify-assistant-resize.mjs
//
// WHAT THIS GUARDS. The float is resized by pointer drags (`public/assistant.js`), with one grab per edge and corner
// (`public/index.html`, `public/style.css`). Two failures have already shipped from this code, and both were about
// the frame moving when the reader had not asked it to:
//
//   1. the grab stopped tracking the pointer at the viewport edge, so the corner slid away from the cursor and had to
//      be walked all the way back before the frame stirred; and
//   2. the clamp was taken from `visualViewport`, which a classic scrollbar shrinks by its own width (11px on this
//      machine). A float parked on the LAYOUT viewport's 8px edge was therefore 3px outside the visual viewport, and
//      the first pixel of a drag snapped the whole frame inward by the scrollbar's width — the window jumped the
//      instant it was grabbed.
//
// So the cases below are: nothing moves at grab time (the frame's size and position on pointerdown and on the first
// pixel are the size it had); each grab moves only its own edge, by the drag distance, with a constant offset from the
// pointer; the frame stops on the 8px edge and follows the pointer back out of it immediately; and a frame remembered
// on a bigger screen is not snapped anywhere until the drag pulls it back in.
//
// The last group is where the room a taller panel gains ends up (it used to go to the spacer above the turns — blank
// panel between the card's head and the first turn). It must land in the console of the LOWEST open turn; with every
// turn folded, a resize opens the newest turn first so the room has a console to land in. That group seeds six
// finished turns into the sandbox's own job store before the panel boots.
//
// The scrollbar case is emulated rather than measured: headless Chromium always paints OVERLAY scrollbars, so the
// visual viewport equals the layout viewport there and the bug cannot occur. Case 2 therefore installs a
// `visualViewport` shim 11px narrower than `innerWidth` — the exact input the old clamp read — and asserts the frame
// does not move because the clamp no longer consults it.
//
// Everything runs in a sandbox of its own: a throwaway config, log folder, job store and HERMES_HOME, on an ephemeral
// port, with `assistant.enabled` false and `fetchSeconds` off so no worker or gateway can be reached. The live panel
// is not touched.
//
// The browser half needs a Playwright install. Point the script at one with PANEL_PLAYWRIGHT_ROOT (a directory holding
// node_modules/playwright, or the package itself); without one the script says BROWSER-HALF-NOT-RUN and exits 2
// rather than passing on a half that never ran.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const VIEW = { width: 1280, height: 800 };
const EDGE = 8;
const SEED = { x: 600, y: 120, w: 480, h: 420 };
const MIN_W = 340;
const MIN_H = 320;

let failures = 0;
const check = (ok, label, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

const frame = (page) =>
  page.evaluate(() => {
    const a = document.getElementById("assistant").getBoundingClientRect();
    return {
      l: +a.left.toFixed(1), t: +a.top.toFixed(1), r: +a.right.toFixed(1), b: +a.bottom.toFixed(1),
      w: +a.width.toFixed(1), h: +a.height.toFixed(1),
    };
  });

const delta = (a, c) => ({ dl: +(c.l - a.l).toFixed(1), dt: +(c.t - a.t).toFixed(1),
  dr: +(c.r - a.r).toFixed(1), db: +(c.b - a.b).toFixed(1),
  dw: +(c.w - a.w).toFixed(1), dh: +(c.h - a.h).toFixed(1) });

const still = (d) => d.dl === 0 && d.dt === 0 && d.dr === 0 && d.db === 0 && d.dw === 0 && d.dh === 0;

// Put the float where a case wants it, open it, and hand back the frame it actually has.
async function place(page, base, rect) {
  await openPage(page, base, { selector: "#btn-assistant" });
  await page.evaluate((r) => {
    if (r) localStorage.setItem("wm.assistantRect", JSON.stringify(r));
    else localStorage.removeItem("wm.assistantRect");
    localStorage.setItem("wm.assistantOpen", "1");
  }, rect);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#as-grips", { state: "attached", timeout: 30_000 });
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__assistantToggle(true));
  await page.waitForTimeout(250);
  return frame(page);
}

const gripBox = (page, dir) => page.locator(`.as-grip[data-dir="${dir}"]`).boundingBox();

// Press the grab, move by (dx, dy) in `steps`, and return the frame after every move.
async function drag(page, dir, dx, dy, steps = 6) {
  const b = await gripBox(page, dir);
  const sx = b.x + b.width / 2, sy = b.y + b.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  const down = await frame(page);
  const trail = [];
  for (let i = 1; i <= steps; i += 1) {
    const x = sx + (dx * i) / steps, y = sy + (dy * i) / steps;
    await page.mouse.move(x, y);
    await page.waitForTimeout(30);
    trail.push({ ...(await frame(page)), mx: x, my: y });
  }
  await page.mouse.up();
  return { sx, sy, down, trail };
}

// The pointer-to-edge offset each grab owns; constant means the corner never drifts away from the cursor.
function offsets(f, dir, mx, my) {
  const o = {};
  if (dir.includes("e")) o.x = +(f.r - mx).toFixed(1);
  if (dir.includes("w")) o.x = +(mx - f.l).toFixed(1);
  if (dir.includes("s")) o.y = +(f.b - my).toFixed(1);
  if (dir.includes("n")) o.y = +(my - f.t).toFixed(1);
  return o;
}

// Six finished turns on the assistant thread, so the float has a transcript to grow into. Written BEFORE the panel
// boots (a running panel rewrites its store every ~700ms) and with no run id and no action lines, so nothing can be
// re-attached or re-executed.
function seedTurns(dir, count = 6) {
  const now = Date.now();
  const jobs = Array.from({ length: count }, (_, i) => ({
    id: (0xa1000000 + i * 17).toString(16),
    thread: "panel-assistant",
    turn: i,
    prompt: `turn ${i + 1} of the fixture conversation`,
    cwd: path.join(dir, "assistant-cwd"),
    status: "done",
    exitCode: 0,
    startedAt: new Date(now - (count - i) * 600000).toISOString(),
    endedAt: new Date(now - (count - i) * 600000 + 40000).toISOString(),
    durationMs: 40000,
    finalMessage: `turn ${i + 1} finished`,
    lines: [
      { kind: "cmd", text: `POST /v1/runs · session panel-assistant · turn ${i + 1}`, lid: i * 100, at: now + i * 100 },
      ...Array.from({ length: 10 }, (_, k) => ({
        kind: "out", text: `  line ${k + 1} of turn ${i + 1}: nothing moved on the board since the last read`,
        lid: i * 100 + k + 1, at: now + i * 100 + k + 1,
      })),
      { kind: "out", text: `✔ turn ${i + 1} done`, lid: i * 100 + 90, at: now + i * 100 + 90 },
    ],
  }));
  mkdirSync(path.join(dir, "logs"), { recursive: true });
  writeFileSync(path.join(dir, "logs", "jobs.json"), JSON.stringify({ savedAt: new Date(now).toISOString(), jobs }, null, 1));
}

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("assistant resize grabs", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)"));
    process.exit(2);
  }

  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-resize-"));
  seedTurns(dir);
  const panel = await startPanel({ dir, config: { assistant: { enabled: false }, fetchSeconds: -1 } });
  try {
    console.log(`sandbox: ${panel.base}`);

    // ---- 1. nothing moves at grab time, and every grab moves only its own edge, by the drag distance
    const shareA = await withBrowser(async ({ page }) => {
      const seeded = await place(page, panel.base, SEED);
      check(seeded.w === SEED.w && seeded.h === SEED.h, "the seeded frame opens at the remembered size",
        `${seeded.w}x${seeded.h}`);

      const cases = [
        ["se", 80, 60], ["e", 90, 0], ["s", 0, 70], ["nw", -60, -50],
        ["n", 0, -40], ["w", -70, 0], ["ne", 60, -50], ["sw", -50, 60],
      ];
      for (const [dir, dx, dy] of cases) {
        const before = await place(page, panel.base, SEED);
        const { down, trail } = await drag(page, dir, dx, dy);
        check(still(delta(before, down)),
          `grab ${dir}: nothing moves on pointerdown`, JSON.stringify(delta(before, down)));

        const after = trail[trail.length - 1];
        const moved = delta(before, after);
        const want = {
          dl: dx < 0 && dir.includes("w") ? dx : 0,
          dt: dy < 0 && dir.includes("n") ? dy : 0,
          dr: dx > 0 && dir.includes("e") ? dx : 0,
          db: dy > 0 && dir.includes("s") ? dy : 0,
        };
        check(["dl", "dt", "dr", "db"].every((k) => Math.abs(moved[k] - want[k]) <= 1),
          `grab ${dir}: moves only its own edge, by the drag distance`, `moved ${JSON.stringify(moved)} wanted ${JSON.stringify(want)}`);

        const gaps = trail.map((f) => offsets(f, dir, f.mx, f.my));
        const xs = gaps.map((g) => g.x).filter((v) => v !== undefined);
        const ys = gaps.map((g) => g.y).filter((v) => v !== undefined);
        const drift = Math.max(
          xs.length ? Math.max(...xs) - Math.min(...xs) : 0,
          ys.length ? Math.max(...ys) - Math.min(...ys) : 0,
        );
        check(drift <= 1, `grab ${dir}: keeps a constant offset from the pointer`, `drift ${drift.toFixed(1)}px`);
      }
    }, { viewport: VIEW });

    // ---- 2. the scrollbar input: a visual viewport 11px narrower than the layout viewport must not move the frame
    const scrollbarShim = () => {
      Object.defineProperty(window, "visualViewport", {
        configurable: true,
        value: { width: window.innerWidth - 11, height: window.innerHeight, offsetLeft: 0, offsetTop: 0, scale: 1 },
      });
    };
    const shareB = await withBrowser(async ({ page }) => {
      // A frame parked on the LAYOUT viewport's 8px edge is 3px outside the emulated visual viewport.
      const edge = await page.evaluate(() => ({ vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight }));
      const rect = { x: edge.vw - EDGE - SEED.w, y: 120, w: SEED.w, h: SEED.h };
      const before = await place(page, panel.base, rect);
      const b = await gripBox(page, "se");
      const sx = b.x + b.width / 2, sy = b.y + b.height / 2;
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      const down = await frame(page);
      await page.mouse.move(sx + 1, sy);
      await page.waitForTimeout(40);
      const out = await frame(page);
      await page.mouse.move(sx - 20, sy);
      await page.waitForTimeout(40);
      const back = await frame(page);
      await page.mouse.up();

      check(before.r === edge.vw - EDGE, "frame sits on the layout viewport's 8px edge", `right=${before.r} edge=${edge.vw - EDGE}`);
      check(still(delta(before, down)), "scrollbar case: nothing moves on pointerdown", JSON.stringify(delta(before, down)));
      check(out.w >= before.w - 1, "scrollbar case: pushing at the edge does not snap the frame inward",
        `width ${before.w} -> ${out.w} (old clamp here snapped it by the scrollbar width)`);
      check(Math.abs((before.w - back.w) - 20) <= 1, "scrollbar case: the frame follows the pointer back in",
        `width ${out.w} -> ${back.w}`);
    }, { viewport: VIEW, initScripts: [scrollbarShim] });

    // ---- 3. the clamp: the frame stops on the 8px edge and follows the pointer back immediately
    const shareC = await withBrowser(async ({ page }) => {
      const before = await place(page, panel.base, SEED);
      const b = await gripBox(page, "se");
      const sx = b.x + 8, sy = b.y + 8;
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      await page.mouse.move(sx + 700, sy + 700, { steps: 20 });
      await page.waitForTimeout(60);
      const held = await frame(page);
      const edge = await page.evaluate(() => ({ vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight }));
      check(held.r === edge.vw - EDGE && held.b === edge.vh - EDGE, "the frame stops on the 8px viewport edge",
        `right=${held.r}/${edge.vw - EDGE} bottom=${held.b}/${edge.vh - EDGE} (from ${before.w}x${before.h})`);
      await page.mouse.move(sx + 680, sy + 680, { steps: 2 });
      await page.waitForTimeout(60);
      const back = await frame(page);
      check(held.r - back.r === 20 && held.b - back.b === 20, "and follows the pointer back out of the edge at once",
        `right ${held.r}->${back.r} bottom ${held.b}->${back.b}`);
      await page.mouse.up();
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("wm.assistantRect") || "null"));
      check(stored && Math.abs(stored.w - back.w) <= 1 && Math.abs(stored.h - back.h) <= 1,
        "the released frame is the remembered one", JSON.stringify(stored));
    }, { viewport: VIEW });

    // ---- 4. a frame bigger than the room left (remembered on another screen) is not snapped by the grab
    const shareD = await withBrowser(async ({ page }) => {
      const edge = await page.evaluate(() => ({ vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight }));
      const big = { x: EDGE, y: EDGE, w: edge.vw - 2 * EDGE + 120, h: edge.vh - 2 * EDGE + 120 };
      const before = await place(page, panel.base, big);
      check(before.w <= edge.vw - 2 * EDGE && before.h <= edge.vh - 2 * EDGE,
        "a stored rect larger than the window is trimmed to fit on open", `${before.w}x${before.h}`);
      const { down } = await drag(page, "se", 1, 1, 2);
      check(delta(before, down).dl === 0 && delta(before, down).dt === 0, "and grabbing it does not move it",
        JSON.stringify(delta(before, down)));
      const res = await drag(page, "e", -60, 0, 3);
      const shrunk = res.trail[res.trail.length - 1];
      check(Math.abs((before.w - shrunk.w) - 60) <= 1, "pulling the edge in shrinks it by the drag distance",
        `${before.w} -> ${shrunk.w}`);
      const floor = await drag(page, "e", -2000, 0, 6);
      check(floor.trail[floor.trail.length - 1].w === MIN_W, "and the 340px floor holds", `w=${floor.trail[floor.trail.length - 1].w}`);
      void MIN_H;
    }, { viewport: VIEW });

    // ---- 5. the room a taller panel gains goes INTO the open turn's console, not into blank panel above the turns
    const shareE = await withBrowser(async ({ page }) => {
      const read = () => page.evaluate(() => {
        const body = document.querySelector("#as-chat > .job > .job-body");
        if (!body) return null;
        const turns = [...body.querySelectorAll(":scope > .turn")];
        const open = turns.filter((t) => !t.classList.contains("folded"));
        const br = body.getBoundingClientRect();
        const first = turns[0].getBoundingClientRect();
        const last = open.length ? open[open.length - 1] : null;
        const pre = last ? last.querySelector("pre.job-out") : null;
        return {
          gap: Math.round(first.top - br.top + body.scrollTop),
          open: open.length,
          slackOnLast: Boolean(last && last.classList.contains("is-slack")),
          slackCount: turns.filter((t) => t.classList.contains("is-slack")).length,
          consoleH: pre ? Math.round(pre.getBoundingClientRect().height) : 0,
          consoleContent: pre ? pre.scrollHeight : 0,
        };
      });
      const pull = async (dy, steps = 8) => {
        const b = await gripBox(page, "s");
        const sx = b.x + b.width / 2, sy = b.y + b.height / 2;
        await page.mouse.move(sx, sy);
        await page.mouse.down();
        for (let i = 1; i <= steps; i += 1) {
          await page.mouse.move(sx, sy + (dy * i) / steps);
          await page.waitForTimeout(25);
        }
        await page.mouse.up();
        await page.waitForTimeout(300);
      };

      // tall enough that the transcript is not already scrolling: the room has somewhere to go
      await place(page, panel.base, { x: 200, y: 60, w: 700, h: 900 });
      await page.waitForTimeout(400);
      const before = await read();
      check(before.open === 1 && before.slackOnLast && before.slackCount === 1,
        "the newest turn is open and owns the room", JSON.stringify(before));

      await pull(200);
      const after = await read();
      check(after.consoleH - before.consoleH === 200,
        "growing the float by 200px grows the open console by 200px",
        `console ${before.consoleH} -> ${after.consoleH}`);
      check(after.gap === 0, "and no blank panel opens above the turns", `gap ${before.gap} -> ${after.gap}`);

      // everything folded: the spacer owns the room — then a resize brings the newest turn back to take it
      await page.evaluate(() => {
        for (const head of document.querySelectorAll("#as-chat .turn:not(.folded) > .turn-head")) head.click();
      });
      await page.waitForTimeout(900);
      const folded = await read();
      check(folded.open === 0 && folded.gap > 100, "with every turn folded the room is blank panel", JSON.stringify(folded));

      await pull(120);
      const reopened = await read();
      check(reopened.open === 1 && reopened.gap === 0 && reopened.consoleH > 100,
        "a resize with nothing open opens the newest turn and gives it the room", JSON.stringify(reopened));

      // two open: the room belongs to the LOWEST of them, the one at the foot of the transcript
      await page.evaluate(() => {
        const foldedHeads = [...document.querySelectorAll("#as-chat .turn.folded > .turn-head")];
        if (foldedHeads.length) foldedHeads[foldedHeads.length - 1].click();
      });
      await page.waitForTimeout(900);
      const two = await read();
      check(two.open === 2 && two.slackOnLast && two.slackCount === 1,
        "with two turns open only the lowest one takes the room", JSON.stringify(two));
      void shareA; void shareB; void shareC; void shareD;
    }, { viewport: { width: 1400, height: 1200 } });
  } finally {
    await panel.stop();
  }

  if (failures) {
    console.log(`\nASSISTANT-RESIZE-FAILED  ${failures} check(s)`);
    process.exit(1);
  }
  console.log("\nASSISTANT-RESIZE-OK  eight grabs, no jump on grab, one size authority");
}

await main();
