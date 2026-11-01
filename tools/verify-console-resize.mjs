#!/usr/bin/env node
// The console's resize handle must stay under the pointer the reader grabbed it with, from the first pixel.
//
//   node tools/verify-console-resize.mjs
//   node tools/verify-console-resize.mjs --keep     # leave the sandbox behind for inspection
//
// WHAT THIS GUARDS. `.job-out` is resizable (`resize: vertical`, public/style.css) under a 230px max-height, and a
// max-height is what stops a long transcript eating the card — but it also stops the drag dead. So a pointerdown in
// the bottom-right 16px corner pins the height the console HAS and lifts the cap in the same breath
// (`public/app.js`, the `consoleDrag` block). Lifting the cap ALONE is the bug this file exists for: on a console
// whose content is taller than the cap, clearing max-height on pointerdown grew the box to its whole transcript
// before the drag began — measured 230px -> 1053px on a 120-line job — so the handle jumped 827px below the cursor,
// and the native drag then moved nothing the reader could see. The reported symptom was the corner "jumping around
// out from under my cursor".
//
// So the cases below are: a press on the corner that does not move changes nothing (and leaves nothing pinned);
// pointerdown itself moves nothing, with the current height pinned as an inline style; every pixel of drag is a
// pixel of console, in BOTH directions, with a constant offset from the pointer; a second grab starts from where
// the first left the box instead of snapping back; a short console can still be grown past the cap; and a click in
// the text leaves the cap alone.
//
// The native handle is driven through CDP input (page.mouse), which is a trusted event in Chromium, so the browser's
// own `resize: vertical` machinery responds to it — nothing synthetic reaches the page. Everything runs in a sandbox
// of its own: a throwaway config, log folder, job store and HERMES_HOME, on an ephemeral port, assistant off and
// fetchSeconds off so no worker or gateway can be reached. The live panel is not touched.
//
// The browser half needs a Playwright install. Point the script at one with PANEL_PLAYWRIGHT_ROOT (a directory
// holding node_modules/playwright, or the package itself); without one the script says BROWSER-HALF-NOT-RUN and
// exits 2 rather than passing on a half that never ran.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const CAP = 230;
const HANDLE = 4; // where inside the corner the pointer is put, in px
const LONG = "probe-console-resize-long";
const SHORT = "probe-console-resize-short";
const KEEP = process.argv.includes("--keep");

let failures = 0;
const check = (ok, label, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

// Two finished jobs in the sandbox's own store, written BEFORE the panel boots (a running panel rewrites its store
// every ~700ms): one console far taller than the cap, one shorter than it. No run id and no action lines, so
// nothing can be re-attached or re-executed.
function seed(dir) {
  const now = Date.now();
  const job = (thread, prompt, count, at) => ({
    id: (0xb1000000 + at).toString(16),
    thread,
    turn: 0,
    prompt,
    cwd: path.join(dir, `${thread}-cwd`),
    status: "done",
    exitCode: 0,
    startedAt: new Date(now - (at + 1) * 600000).toISOString(),
    endedAt: new Date(now - (at + 1) * 600000 + 40000).toISOString(),
    durationMs: 40000,
    finalMessage: "done",
    lines: [
      { kind: "cmd", text: `POST /v1/runs · session ${thread} · turn 1`, lid: 0, at: now - 600000 },
      ...Array.from({ length: count }, (_, k) => ({
        kind: "out", text: `  line ${k + 1} of the console: the reader is resizing me`, lid: k + 1, at: now - 600000 + k + 1,
      })),
    ],
  });
  const jobs = [job(LONG, "the long console", 120, 3), job(SHORT, "the short console", 4, 1)];
  mkdirSync(path.join(dir, "logs"), { recursive: true });
  writeFileSync(path.join(dir, "logs", "jobs.json"), JSON.stringify({ savedAt: new Date(now).toISOString(), jobs }, null, 1));
}

// The console of one thread, as the page paints it, plus what the drag writes into its inline style.
const measure = (page, thread) =>
  page.evaluate((t) => {
    const card = document.querySelector(`.job[data-thread="${t}"]`);
    const pre = card && card.querySelector("pre.job-out");
    if (!pre) return null;
    const r = pre.getBoundingClientRect();
    const cs = getComputedStyle(pre);
    return {
      t: +r.top.toFixed(1), b: +r.bottom.toFixed(1), l: +r.left.toFixed(1), r: +r.right.toFixed(1),
      h: +r.height.toFixed(1),
      max: cs.maxHeight, inlineH: pre.style.height, inlineMax: pre.style.maxHeight,
      client: pre.clientHeight, scroll: pre.scrollHeight,
    };
  }, thread);

// Bring the card into the window from the top, so a downward drag has room inside the viewport. A page scroll does
// not touch a console's own scrollTop.
async function show(page, thread) {
  await page.evaluate((t) => document.querySelector(`.job[data-thread="${t}"]`)?.scrollIntoView({ block: "start" }), thread);
  await page.waitForTimeout(150);
  return measure(page, thread);
}

// Press the bottom-right handle and hand back the point, so every later move is the reader's own pointer.
async function grab(page, thread) {
  const m = await measure(page, thread);
  const x = m.r - HANDLE, y = m.b - HANDLE;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(80);
  return { x, y, at: m, after: await measure(page, thread) };
}

// One move of the pressed pointer, and the console's frame there. `gap` is the pointer-to-bottom-edge distance: a
// handle that tracks the pointer keeps it constant.
async function slide(page, thread, x, y) {
  await page.mouse.move(x, y);
  await page.waitForTimeout(40);
  const m = await measure(page, thread);
  return { ...m, mx: x, my: y, gap: +(m.b - y).toFixed(1) };
}

const near = (a, b, tol = 0.6) => Math.abs(a - b) <= tol;
const gaps = (trail) => trail.map((s) => s.gap);

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("console resize handle", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)"));
    process.exit(2);
  }

  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-console-resize-"));
  seed(dir);
  const panel = await startPanel({ dir, config: { assistant: { enabled: false }, fetchSeconds: -1 } });
  try {
    console.log(`sandbox: ${panel.base}`);
    await withBrowser(
      async ({ page, pageErrors }) => {
        await openPage(page, panel.base, { selector: `pre.job-out` });
        await page.waitForSelector(`.job[data-thread="${LONG}"] pre.job-out`, { state: "visible", timeout: 20_000 });
        await page.waitForSelector(`.job[data-thread="${SHORT}"] pre.job-out`, { state: "visible", timeout: 20_000 });

        // ---- 1. the console still starts on its cap, with the transcript scrolled inside it
        const start = await show(page, LONG);
        check(near(start.h, CAP), "a long console sits on the 230px cap", `h=${start.h}`);
        check(start.scroll > start.client + 300, "and its transcript scrolls inside that cap",
          `scroll ${start.scroll} > client ${start.client}`);
        check(start.inlineH === "" && start.max === `${CAP}px`, "with nothing pinned in its inline style",
          `inlineH=${JSON.stringify(start.inlineH)} max=${start.max}`);

        // ---- 2. a press on the corner that does not move is not a resize: nothing is left pinned
        {
          const g = await grab(page, LONG);
          check(near(g.after.h, start.h), "the grab itself moves nothing", `h ${start.h} -> ${g.after.h}`);
          await page.mouse.up();
          await page.waitForTimeout(80);
          const after = await measure(page, LONG);
          check(near(after.h, CAP), "a press on the corner with no drag leaves the console on its cap", `h=${after.h}`);
          check(after.inlineH === "" && after.max === `${CAP}px`, "and pins neither a height nor a lifted cap",
            `inlineH=${JSON.stringify(after.inlineH)} max=${after.max}`);
        }

        // ---- 3. every pixel of the drag down is a pixel of console, with the corner still under the pointer
        const g1 = await grab(page, LONG);
        check(near(g1.after.h, g1.at.h), "pointerdown leaves the console the size it was", `h ${g1.at.h} -> ${g1.after.h}`);
        check(g1.after.inlineH === `${g1.at.h}px` && g1.after.max === "none",
          "the height it has is pinned as the drag starts, and the cap is lifted in the same breath",
          `inlineH=${g1.after.inlineH} max=${g1.after.max}`);

        const down = [];
        for (let i = 1; i <= 6; i += 1) down.push(await slide(page, LONG, g1.x, g1.y + i * 20));
        check(gaps(down).every((v) => near(v, HANDLE)), "the corner stays under the pointer all the way down",
          `gaps ${gaps(down).join(",")}`);
        check(down.every((s, i) => near(s.h, g1.at.h + (i + 1) * 20)),
          "and each 20px of drag is 20px of console",
          `heights ${down.map((s) => s.h).join(",")}`);

        // ---- 4. ...and back up, in the same gesture
        const begun = down[down.length - 1];
        const up = [];
        for (let i = 1; i <= 3; i += 1) up.push(await slide(page, LONG, g1.x, begun.my - i * 20));
        check(gaps(up).every((v) => near(v, HANDLE)), "dragging back up tracks the pointer too",
          `gaps ${gaps(up).join(",")}`);
        check(up.every((s, i) => near(s.h, begun.h - (i + 1) * 20)), "each 20px back is 20px less console",
          `heights ${up.map((s) => s.h).join(",")}`);
        await page.mouse.up();
        await page.waitForTimeout(80);

        // ---- 5. a second grab starts from where the first left the box, instead of snapping back to the cap
        {
          const grew = await measure(page, LONG);
          const g2 = await grab(page, LONG);
          check(near(g2.after.h, g2.at.h), "a second grab moves nothing either", `h ${g2.at.h} -> ${g2.after.h}`);
          check(near(g2.at.h, grew.h), "and starts from the height the last drag left", `h=${g2.at.h}`);
          const again = await slide(page, LONG, g2.x, g2.y + 20);
          check(near(again.gap, HANDLE) && near(again.h, g2.at.h + 20), "which it then tracks like the first",
            `gap=${again.gap} h ${g2.at.h} -> ${again.h}`);
          await page.mouse.up();
          await page.waitForTimeout(80);
        }

        // ---- 6. a console shorter than the cap can still be pulled past it (the cap is what used to stop it dead)
        {
          const shortStart = await show(page, SHORT);
          check(shortStart.h < CAP, "the short console starts under the cap", `h=${shortStart.h}`);
          const g3 = await grab(page, SHORT);
          const pull = [];
          for (let i = 1; i <= 13; i += 1) pull.push(await slide(page, SHORT, g3.x, g3.y + i * 20));
          await page.mouse.up();
          await page.waitForTimeout(80);
          check(gaps(pull).every((v) => near(v, HANDLE)), "its corner tracks the pointer too",
            `gaps ${gaps(pull).join(",")}`);
          const end = pull[pull.length - 1];
          check(end.h > CAP && near(end.h, shortStart.h + 260),
            "and the drag carries it past the cap the console otherwise sits on",
            `h ${shortStart.h} -> ${end.h} (cap ${CAP})`);
        }

        // ---- 7. a click in the console's text is not a resize: the cap is untouched (on a freshly painted console,
        //         so the reading is the shipped default rather than a height an earlier case left behind)
        {
          await page.reload({ waitUntil: "domcontentloaded" });
          await page.waitForSelector(`.job[data-thread="${LONG}"] pre.job-out`, { state: "visible", timeout: 20_000 });
          const before = await show(page, LONG);
          check(near(before.h, CAP) && before.inlineH === "", "a repaint puts the console back on its cap",
            `h=${before.h} inlineH=${JSON.stringify(before.inlineH)}`);
          await page.mouse.move(before.l + 120, before.t + 40);
          await page.mouse.down();
          await page.mouse.up();
          await page.waitForTimeout(120);
          const after = await measure(page, LONG);
          check(after.max === `${CAP}px` && after.inlineMax === "",
            "a click in the console's own text lifts no cap", `max ${before.max} -> ${after.max}`);
          check(near(after.h, before.h), "and moves no height the reader did not ask for", `h ${before.h} -> ${after.h}`);
        }

        check(pageErrors.length === 0, "the page threw nothing", pageErrors.slice(0, 3).join(" | "));
      },
      { viewport: { width: 1440, height: 900 } },
    );
  } finally {
    await panel.stop();
    if (!KEEP) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    else console.log(`sandbox kept: ${dir}`);
  }

  console.log(failures ? `RESULT: FAIL (${failures} check${failures === 1 ? "" : "s"})` : "RESULT: PASS");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
