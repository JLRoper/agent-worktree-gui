#!/usr/bin/env node
// The assistant's docked rail, proved by driving a panel of its own — and a real browser over it.
//
//   node tools/verify-assistant-dock.mjs
//
// WHAT THIS GUARDS. The assistant used to be a floating window: `position: fixed`, dragged by its head, resized by
// eight grabs, maximized and pinned, with its rect remembered in `wm.assistantRect`. It covered the board. It is now
// a column docked at the right of the board (`public/index.html` puts it in the board's own row, `public/style.css`
// makes that row a flex line, `public/assistant.js` owns the width), and the failures this file exists for are the
// ones a dock can have that a float could not:
//
//   1. it still overlays the board — a `position: fixed` left behind, or a row that does not actually shrink;
//   2. it does not stay put — a sticky rail whose containing block ends before the page does slides up under the
//      topbar at the end of a scroll, taking the close toggle with it;
//   3. the width is not the reader's — not remembered across a reload, or not clamped to 340-640px and to 60% of
//      the window, which is what keeps the board the majority of the row;
//   4. the chrome came back — a drag head, a grip, a pin, a maximize, or a press on the board that dismisses the
//      rail the reader is reading.
//
// The last group is the one the brief calls out by name: Chat is the default sub-tab and it is where the assistant's
// messages render. The "Assistant #1" tab is that Chat, not a second surface, so the check is that exactly ONE chat
// pane is on screen and that it is the one the session tab shows.
//
// Everything runs in a sandbox of its own: a throwaway config, log folder, job store and HERMES_HOME, on an ephemeral
// port, with `assistant.enabled` false and `fetchSeconds` off so no worker or gateway can be reached. The live panel
// is not touched.
//
// The browser half needs a Playwright install. Point the script at one with PANEL_PLAYWRIGHT_ROOT (a directory holding
// node_modules/playwright, or the package itself); without one the script says BROWSER-HALF-NOT-RUN and exits 2
// rather than passing on a half that never ran.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const VIEW = { width: 1280, height: 800 };
const NARROW = { width: 900, height: 700 };
const DEFAULT_W = 480;
const MIN_W = 340;
const MAX_W = 640;

let failures = 0;
let checks = 0;
const check = (ok, label, detail = "") => {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const eq = (got, want, label) => check(JSON.stringify(got) === JSON.stringify(want), label, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
const note = (text) => console.log(`      ${text}`);

// The rail, the board and the window, in one read: every case below is a statement about these numbers.
const frame = (page) =>
  page.evaluate(() => {
    const a = document.getElementById("assistant");
    const r = a.getBoundingClientRect();
    const m = document.querySelector("main").getBoundingClientRect();
    const bar = document.querySelector(".topbar").getBoundingClientRect();
    const cs = getComputedStyle(a);
    return {
      hidden: a.hidden,
      position: cs.position,
      w: +r.width.toFixed(1), h: +r.height.toFixed(1),
      left: +r.left.toFixed(1), right: +r.right.toFixed(1), top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1),
      mainLeft: +m.left.toFixed(1), mainRight: +m.right.toFixed(1), mainW: +m.width.toFixed(1),
      barBottom: +bar.bottom.toFixed(1),
      vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight,
      stored: localStorage.getItem("wm.assistantWidth"),
      open: localStorage.getItem("wm.assistantOpen"),
    };
  });

// Put the rail where a case wants it: a remembered width (or none), open, then reload so the boot path runs.
async function place(page, base, width) {
  if (!page.url().startsWith(base)) await openPage(page, base, { selector: "#btn-assistant" });
  await page.evaluate((w) => {
    if (w == null) localStorage.removeItem("wm.assistantWidth");
    else localStorage.setItem("wm.assistantWidth", String(w));
    localStorage.removeItem("wtgui.zoom");
    localStorage.setItem("wm.assistantOpen", "1");
  }, width);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#assistant", { state: "visible", timeout: 30_000 });
  await page.waitForFunction(() => typeof window.__assistantToggle === "function", null, { timeout: 10_000 });
  await page.waitForTimeout(150);
  return frame(page);
}

// Drag the rail's left edge by `dx` client px, in steps, and hand back the frame after the release.
async function dragEdge(page, dx, steps = 6) {
  const b = await page.locator("#as-split").boundingBox();
  const sx = b.x + b.width / 2;
  const sy = b.y + Math.min(200, b.height / 2);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(sx + (dx * i) / steps, sy);
    await page.waitForTimeout(25);
  }
  await page.mouse.up();
  await page.waitForTimeout(120);
  return frame(page);
}

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the assistant's docked rail", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)"));
    process.exit(2);
  }

  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-dock-"));
  const panel = await startPanel({ dir, config: { assistant: { enabled: false }, fetchSeconds: -1 } });
  try {
    console.log(`sandbox: ${panel.base}`);

    await withBrowser(async ({ page, withPage, pageErrors }) => {
      // ---- 1. closed at boot: the rail takes no room at all
      {
        await openPage(page, panel.base, { selector: "#btn-assistant" });
        await page.waitForFunction(() => typeof window.__assistantToggle === "function", null, { timeout: 10_000 });
        const f = await frame(page);
        check(f.hidden, "the rail starts closed");
        check(f.mainW === f.vw, "and the board has the whole window", `main ${f.mainW} of ${f.vw}`);
      }

      // ---- 2. open: a docked column beside the board, never over it
      {
        await page.click("#btn-assistant");
        await page.waitForSelector("#assistant", { state: "visible", timeout: 10_000 });
        await page.waitForTimeout(200);
        const f = await frame(page);
        eq(f.position, "sticky", "the rail is in the page's flow (sticky), not fixed over the board");
        check(f.w === DEFAULT_W, "a fresh browser opens the rail at its default width", `${f.w}px`);
        check(Math.abs(f.mainRight - f.left) <= 1,
          "the board's right edge IS the rail's left edge — the rail takes layout width", `main ends ${f.mainRight}, rail starts ${f.left}`);
        check(f.mainW < f.vw, "and the board is narrower for it", `main ${f.mainW} of ${f.vw}`);
        check(f.left >= f.mainLeft, "the rail is to the right of the board, not on top of it");
        check(Math.abs(f.top - f.barBottom) <= 1, "the rail starts under the topbar", `rail ${f.top}, topbar ends ${f.barBottom}`);
        check(Math.abs(f.bottom - f.vh) <= 1, "and runs to the bottom of the window", `rail ends ${f.bottom}, window ${f.vh}`);
        eq(f.open, "1", "the open flag is remembered");
        // Nothing of the board is under the rail: a point just inside the board's right edge belongs to the board.
        const hit = await page.evaluate(() => {
          const m = document.querySelector("main").getBoundingClientRect();
          const el = document.elementFromPoint(m.right - 4, m.top + 40);
          return Boolean(el && el.closest("#assistant"));
        });
        check(!hit, "a press at the board's right edge lands on the board, not on the rail");
      }

      // ---- 3. the chrome is gone, and a press on the board does not dismiss the rail
      {
        const chrome = await page.evaluate(() => ({
          head: Boolean(document.getElementById("as-drag")),
          grips: document.querySelectorAll(".as-grip, #as-grips").length,
          pin: Boolean(document.getElementById("btn-as-pin")),
          max: Boolean(document.getElementById("btn-as-max")),
          close: document.querySelectorAll("#btn-as-close").length,
          split: document.querySelectorAll("#as-split").length,
        }));
        eq(chrome, { head: false, grips: 0, pin: false, max: false, close: 1, split: 1 },
          "no drag head, no grips, no pin, no maximize — one close toggle and the rail's one edge");
        // A press on the board is what used to close the float. A docked rail is read BESIDE the board.
        await page.locator("#config-line").click();
        await page.waitForTimeout(200);
        const f = await frame(page);
        check(!f.hidden, "a press on the board leaves the rail up");
        eq(f.open, "1", "and the open flag is untouched");
      }

      // ---- 4. the close toggle, and the topbar button as the other way in
      {
        await page.click("#btn-as-close");
        await page.waitForTimeout(200);
        const closed = await frame(page);
        check(closed.hidden, "the ✕ closes the rail");
        eq(closed.open, "0", "and the close is remembered");
        check(closed.mainW === closed.vw, "the board takes the whole window back", `main ${closed.mainW} of ${closed.vw}`);
        await page.click("#btn-assistant");
        await page.waitForSelector("#assistant", { state: "visible", timeout: 10_000 });
        await page.waitForTimeout(200);
        const reopened = await frame(page);
        check(!reopened.hidden, "the topbar's Assistant button opens it again");
        check(reopened.w === DEFAULT_W, "at the remembered width", `${reopened.w}px`);
      }

      // ---- 5. the width is remembered across a reload
      {
        const f = await place(page, panel.base, 520);
        check(f.w === 520, "a remembered width of 520px opens at 520px", `${f.w}px`);
        eq(f.stored, "520", "and it is still the stored number");
        // The rail is already open after the reload (the open flag is remembered): pressing the button would CLOSE it.
        check(!f.hidden, "the reload restores the rail open, as it was left");
      }

      // ---- 6. the clamp: 340-640px, and at most 60% of the window
      {
        const low = await place(page, panel.base, 200);
        check(low.w === MIN_W, "a remembered 200px is drawn at the 340px floor", `${low.w}px`);
        const high = await place(page, panel.base, 900);
        check(high.w === MAX_W, "a remembered 900px is drawn at the 640px cap", `${high.w}px`);
        // 60% of the window, when that is the smaller limit.
        await withPage(async ({ page: narrow }) => {
          await openPage(narrow, panel.base, { selector: "#btn-assistant" });
          await narrow.evaluate(() => {
            localStorage.setItem("wm.assistantWidth", "900");
            localStorage.setItem("wm.assistantOpen", "1");
          });
          await narrow.reload({ waitUntil: "domcontentloaded" });
          await narrow.waitForSelector("#assistant", { state: "visible", timeout: 30_000 });
          await narrow.waitForTimeout(200);
          const f = await frame(narrow);
          const cap = Math.floor(f.vw * 0.6);
          check(f.w === cap, `on a ${f.vw}px window the rail is capped at 60% (${cap}px)`, `${f.w}px`);
          check(f.mainRight <= f.left + 1, "and the board still has the majority of the row", `main ${f.mainW} of ${f.vw}`);
        }, { viewport: NARROW });
      }

      // ---- 7. the rail's one edge resizes it, and the width is stored
      {
        const before = await place(page, panel.base, 480);
        const after = await dragEdge(page, -100);
        check(Math.abs(after.w - (before.w + 100)) <= 2,
          "dragging the edge 100px left widens the rail by 100px", `${before.w} → ${after.w}`);
        check(after.stored === String(Math.round(after.w)), "and the width it drew is the width it stored", `stored ${after.stored}`);
        check(Math.abs(after.mainRight - after.left) <= 1, "the board gives up exactly that width", `main ends ${after.mainRight}, rail starts ${after.left}`);
        // A drag past the cap stores the cap, not the pointer's overshoot.
        const capped = await dragEdge(page, -600);
        check(capped.w === MAX_W, "a drag past the cap stops at 640px", `${capped.w}px`);
        eq(capped.stored, String(MAX_W), "and stores 640, not the overshoot");
        // A click on the edge is not a gesture: nothing moves, nothing is stored.
        const b = await page.locator("#as-split").boundingBox();
        await page.mouse.move(b.x + b.width / 2, b.y + 100);
        await page.mouse.down();
        await page.waitForTimeout(80);
        await page.mouse.up();
        await page.waitForTimeout(150);
        const clicked = await frame(page);
        check(clicked.w === capped.w, "a click on the edge resizes nothing", `${clicked.w}px`);
        eq(clicked.stored, String(MAX_W), "and stores nothing new");
      }

      // ---- 8. it stays put: the rail is pinned for the whole scroll, close toggle included
      {
        await place(page, panel.base, 480);
        const atTop = await frame(page);
        const maxScroll = await page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight);
        check(maxScroll > 0, "the sandbox board is long enough to scroll", `${maxScroll}px of scroll`);
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await page.waitForTimeout(250);
        const atFoot = await frame(page);
        check(Math.abs(atFoot.top - atTop.top) <= 1,
          "scrolled to the foot of the page, the rail has not moved", `${atTop.top} → ${atFoot.top}`);
        check(Math.abs(atFoot.bottom - atFoot.vh) <= 1, "and its foot is still the window's foot", `${atFoot.bottom} of ${atFoot.vh}`);
        const closeVisible = await page.locator("#btn-as-close").isVisible();
        check(closeVisible, "the close toggle is still on screen at the foot of the page");
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(150);
      }

      // ---- 9. Chat is the default sub-tab, and the "Assistant #1" tab IS that chat
      {
        await place(page, panel.base, 480);
        const view = await page.evaluate(() => {
          const subs = [...document.querySelectorAll("#as-subtabs [data-as-subtab]")].map((b) => ({
            tab: b.dataset.asSubtab, on: b.classList.contains("is-on"),
          }));
          const chats = [...document.querySelectorAll('#assistant [data-subpane="chat"]')].map((p) => ({
            id: p.id, hidden: p.classList.contains("hidden"), text: (p.innerText || "").trim().length,
          }));
          const pane = document.getElementById("as-assistant-1");
          return {
            subs,
            chats,
            sessionTabOn: document.querySelector('#as-tabs [data-as-tab="assistant-1"]')?.classList.contains("is-on"),
            paneHidden: pane?.classList.contains("hidden"),
            paneHoldsChat: Boolean(pane?.querySelector('[data-subpane="chat"]')),
            tabs: [...document.querySelectorAll("#as-tabs [data-as-tab]")].map((b) => b.dataset.asTab),
          };
        });
        eq(view.subs.find((s) => s.on)?.tab, "chat", "Chat is the sub-tab the rail opens on");
        eq(view.chats.filter((c) => !c.hidden).length, 1, "exactly one chat pane is on screen — no second surface");
        check(view.chats.find((c) => !c.hidden)?.text > 0, "and it has the assistant's own content in it",
          `${view.chats.find((c) => !c.hidden)?.text} characters`);
        check(view.sessionTabOn && !view.paneHidden, "the Assistant #1 tab is the pane that holds it");
        check(view.paneHoldsChat, "the Assistant #1 pane IS the chat, not an empty surface beside it");
        eq(view.tabs, ["assistant-1", "alerts", "watches", "messages", "pad", "role", "watchdog"],
          "every tab the rail had is still there");
        eq(view.subs.map((s) => s.tab), ["chat", "settings", "queue"], "and every sub-tab");
      }

      // ---- 10. no page errors anywhere in the run
      eq(pageErrors, [], "no page errors");
    }, { viewport: VIEW });
  } finally {
    await panel.stop();
  }

  console.log(`\n${checks} checks, ${failures} failed`);
  if (!failures) console.log("ASSISTANT-DOCK-OK");
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.log(`\nFAIL  the run threw: ${String((err && err.stack) || err)}`);
  process.exitCode = 1;
});
