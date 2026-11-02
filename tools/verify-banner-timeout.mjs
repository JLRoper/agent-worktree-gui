#!/usr/bin/env node
// The red banner's clock: a failure hides ITSELF after the seconds in Settings → Board (5 s by default, 0 = never),
// the clock pauses while the pointer or the keyboard focus is inside the bar, and the ✕ is still an instant
// dismissal. The green confirmation is not a failure and keeps its own four seconds.
//
//   node tools/verify-banner-timeout.mjs
//
// WHAT WAS WRONG. `showBanner` armed no timer at all, and the Board tab had no row for one: a red failure stayed on
// screen until its ✕ was pressed. On a board that re-reads every few seconds that means a message outlives the
// condition it describes — the reader comes back to a failure that was fixed ten minutes ago and has to dismiss it to
// see the board.
//
// NOW. A red message arms a timer of `wtgui.bannerSeconds` (0–30, 5 by default, read at arm time so a change applies
// to the next failure); `pointerenter`/`focusin` clear it and `pointerleave`/`focusout` start the full delay again,
// with the DOM's own `:hover`/`activeElement` as the truth so a hidden bar can never leave the clock paused. A second
// message restarts the clock. The ✕ still calls `hideBanner` at once, and `showNote`'s four seconds are its own
// number, unaffected by the setting.
//
// WHAT IS DRIVEN, on a panel of this checkout (throwaway config, store, HERMES_HOME and port) in a real Chromium,
// with the SSE stream stubbed out so nothing but this gate repaints the bar:
//   * the Board tab carries a #banner-seconds row: type=number, min 0, max 30, default 5, and nothing is written to
//     storage until the reader chooses a number
//   * the default fires: a red bar is up at 4.2 s and gone by 5.9 s
//   * a typed 1 s is saved (row, preview and `wtgui.bannerSeconds`) and the bar is up at 0.4 s and gone by 1.6 s
//   * a second failure restarts the clock: still up 0.7 s after the second message, gone by 2.3 s after it
//   * the ✕ closes at once, and nothing brings the bar back afterwards
//   * hover pauses: up 2.5 s into a 1 s setting, and gone within 1.6 s of the pointer leaving
//   * focus pauses: the ✕ focused keeps it up 2.2 s, and blurring it starts the clock again
//   * 0 never fires: up 2.5 s into the setting, and its ✕ closes it
//   * a typed 45 is clamped to 30 and a typed -2 to 0 — the row is 0–30
//   * the setting survives a reload and the reloaded page honours it (up at 1.2 s on a 2 s number, gone by 3 s)
//   * the green note still goes at four seconds while the red clock is set to 1 s, carries no ✕, and is not cut
//     short when it replaces a red bar whose clock was already running
//
// BEFORE IT LANDED. Run this file against an export of 0.64.0 (`git archive 0.64.0 | tar -x`) and it fails on the
// row that does not exist and on every survival check: the base's red bar is still up when this gate expects it gone.
//
// The browser half needs a Playwright install. Point the script at one with PANEL_PLAYWRIGHT_ROOT (a directory holding
// node_modules/playwright, or the package itself); without one it says BROWSER-HALF-NOT-RUN and exits 2 rather than
// passing on a half that never ran. The live panel on :7331 is never touched.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright, notRun, openPage, openSettingsGroup, stubEventSourceInit, withBrowser } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const VIEWPORT = { width: 1440, height: 900 };
const KEY = "wtgui.bannerSeconds";
const RED = "probe: the board could not be re-read";
const GREEN = "probe: a green confirmation";

let failures = 0;
let checks = 0;
const check = (cond, label, detail = "") => {
  checks += 1;
  if (!cond) failures += 1;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const section = (name) => console.log(`\n-- ${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One read of everything this gate has an opinion about, so every case is a statement about the same numbers.
const read = (page) =>
  page.evaluate((key) => {
    const b = document.getElementById("banner");
    const input = document.getElementById("banner-seconds");
    const preview = document.getElementById("banner-preview");
    let stored = null;
    try {
      stored = localStorage.getItem(key);
    } catch {
      stored = "unreadable";
    }
    const x = b ? b.querySelector(".banner-x") : null;
    return {
      hasBanner: Boolean(b),
      shown: Boolean(b) && getComputedStyle(b).display !== "none",
      ok: Boolean(b && b.classList.contains("ok")),
      text: (document.getElementById("banner-text") || {}).textContent || "",
      x: x ? { hidden: x.hidden, display: getComputedStyle(x).display } : null,
      input: input ? { type: input.type, value: input.value, min: input.min, max: input.max } : null,
      inputGroup: input && input.closest("[data-settings-group]") ? input.closest("[data-settings-group]").dataset.settingsGroup : null,
      preview: preview ? preview.textContent : null,
      stored,
    };
  }, KEY);

const showRed = (page, msg = RED) => page.evaluate((m) => window.showBanner(m), msg);
const showGreen = (page, msg = GREEN) => page.evaluate((m) => window.showNote(m), msg);
const closeSettings = (page) => page.keyboard.press("Escape");

// Type a number into the row the way a reader does: the value, then Enter (the row saves on change and on Enter).
const setSeconds = async (page, value) => {
  if (!(await page.locator("#banner-seconds").count())) return false;
  await page.fill("#banner-seconds", String(value));
  await page.press("#banner-seconds", "Enter");
  await page.waitForTimeout(120);
  return true;
};

// Is the bar hidden within `ms`? A poll rather than one sample: a timer that fires a beat late is not a failure.
const hiddenWithin = (page, ms) =>
  page
    .waitForFunction(
      () => {
        const b = document.getElementById("banner");
        return Boolean(b) && getComputedStyle(b).display === "none";
      },
      { timeout: ms, polling: 50 },
    )
    .then(() => true)
    .catch(() => false);

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the red banner's clock", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)"));
    process.exit(2);
  }

  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-banner-timeout-"));
  const panel = await startPanel({ dir, config: { assistant: { enabled: false }, fetchSeconds: -1 } });
  try {
    console.log(`sandbox: ${panel.base}`);
    await withBrowser(
      async ({ page, pageErrors }) => {
        // The stream is inert, so the only thing that paints the bar is this gate.
        await page.addInitScript(stubEventSourceInit);
        await page.setViewportSize(VIEWPORT);
        await openPage(page, panel.base, { selector: "#btn-assistant" });
        await page.waitForSelector("#health.ok", { timeout: 30_000 });
        await page.waitForTimeout(250);

        const fresh = await read(page);
        check(fresh.hasBanner, "the page carries a banner to time", fresh.hasBanner ? "" : "no #banner");

        // ---- 1. the Board tab's row: 0–30, 5 by default, nothing written until the reader chooses -------------
        section("the seconds row");
        await openSettingsGroup(page, "board");
        const row = await read(page);
        check(Boolean(row.input), "Settings → Board carries a #banner-seconds row", row.input ? "" : "no input in the board panel");
        check(row.inputGroup === "board", "the row is in the Board panel, not another tab", `panel ${row.inputGroup}`);
        check(row.input?.type === "number" && row.input?.min === "0" && row.input?.max === "30",
          "the input is a number and its band is 0–30", row.input ? `type ${row.input.type} min ${row.input.min} max ${row.input.max}` : "absent");
        check(row.input?.value === "5", "it starts at the default 5 s", `value ${row.input?.value}`);
        check(row.stored === null, "a default that was never chosen is not written to storage", `stored ${JSON.stringify(row.stored)}`);
        check(String(row.preview || "").includes("5 s"), "the preview names the five seconds in effect", String(row.preview || ""));
        await closeSettings(page);

        // ---- 2. the default fires: up at 4.2 s, gone by 5.9 s ----------------------------------------------------
        section("the default 5 s");
        await showRed(page);
        await sleep(4200);
        const atDefault = await read(page);
        check(atDefault.shown && !atDefault.ok, "the red bar is still up at 4.2 s on the default", `shown ${atDefault.shown}`);
        const defaultGone = await hiddenWithin(page, 1800);
        check(defaultGone, "and it has hidden itself by 5.9 s", defaultGone ? "" : "still up");

        // ---- 3. a typed 1 s is saved and fires ----------------------------------------------------------------
        section("a typed one second");
        await openSettingsGroup(page, "board");
        const saved = await setSeconds(page, 1);
        const typed = await read(page);
        check(saved, "the row takes a typed number");
        check(typed.input?.value === "1" && typed.stored === "1", "1 s is saved in the row and in wtgui.bannerSeconds",
          `value ${typed.input?.value}, stored ${JSON.stringify(typed.stored)}`);
        check(String(typed.preview || "").includes("saved") && String(typed.preview || "").includes("1 s"),
          "the preview says it was saved and names the second", String(typed.preview || ""));
        await closeSettings(page);

        await showRed(page);
        await sleep(400);
        const early = await read(page);
        check(early.shown, "the red bar is up 0.4 s into a 1 s clock");
        const oneGone = await hiddenWithin(page, 1400);
        check(oneGone, "and gone by 1.6 s", oneGone ? "" : "still up");

        // A second failure restarts the clock: 0.7 s after it the bar is up, and it is gone 2.3 s after it.
        await showRed(page);
        await sleep(600);
        await showRed(page, "probe: a second failure");
        await sleep(700);
        const restarted = await read(page);
        check(restarted.shown && restarted.text === "probe: a second failure",
          "a second failure restarts the clock rather than inheriting the first one's remainder",
          `shown ${restarted.shown}, "${restarted.text}"`);
        const restartedGone = await hiddenWithin(page, 1500);
        check(restartedGone, "and that message gets its own full second", restartedGone ? "" : "still up");

        // ---- 4. the ✕ is still instant, and nothing brings the bar back -----------------------------------------
        section("the ✕");
        await showRed(page);
        await page.waitForTimeout(200);
        await page.click("#banner .banner-x");
        await page.waitForTimeout(120);
        const xPressed = await read(page);
        check(!xPressed.shown, "the ✕ hides the bar at once", `shown ${xPressed.shown}`);
        await sleep(1400);
        const xStayed = await read(page);
        check(!xStayed.shown, "and no pending timer brings it back afterwards");

        // ---- 5. hover pauses the clock ---------------------------------------------------------------------------
        section("hover pauses");
        await showRed(page);
        await page.waitForTimeout(150);
        await page.hover("#banner");
        await sleep(2500);
        const hovered = await read(page);
        check(hovered.shown, "the bar is still up 2.5 s into a 1 s clock while the pointer is over it", `shown ${hovered.shown}`);
        await page.mouse.move(4, 500);
        const hoverGone = await hiddenWithin(page, 1600);
        check(hoverGone, "and it goes within 1.6 s of the pointer leaving", hoverGone ? "" : "still up");

        // ---- 6. focus pauses the clock -------------------------------------------------------------------------
        section("focus pauses");
        await showRed(page);
        await page.waitForTimeout(150);
        await page.focus("#banner .banner-x");
        await sleep(2200);
        const focused = await read(page);
        check(focused.shown, "the bar is still up 2.2 s into a 1 s clock while its ✕ has the focus", `shown ${focused.shown}`);
        await page.evaluate(() => document.activeElement && document.activeElement.blur());
        const focusGone = await hiddenWithin(page, 1600);
        check(focusGone, "and it goes within 1.6 s of the focus leaving", focusGone ? "" : "still up");

        // ---- 7. 0 never fires ----------------------------------------------------------------------------------
        section("0 never fires");
        await openSettingsGroup(page, "board");
        await setSeconds(page, 0);
        const zero = await read(page);
        check(zero.input?.value === "0" && zero.stored === "0", "0 is saved", `value ${zero.input?.value}, stored ${JSON.stringify(zero.stored)}`);
        await closeSettings(page);
        await showRed(page);
        await sleep(2500);
        const zeroHeld = await read(page);
        check(zeroHeld.shown, "with 0 the red bar is still up 2.5 s later (2.5× the previous setting)", `shown ${zeroHeld.shown}`);
        await page.click("#banner .banner-x");
        await page.waitForTimeout(120);
        const zeroClosed = await read(page);
        check(!zeroClosed.shown, "and its ✕ still closes it");

        // ---- 8. the row is 0–30: typed values are clamped ------------------------------------------------------
        section("the 0–30 band");
        await openSettingsGroup(page, "board");
        await setSeconds(page, 45);
        const clampedHigh = await read(page);
        check(clampedHigh.input?.value === "30" && clampedHigh.stored === "30", "45 is clamped to 30", `value ${clampedHigh.input?.value}`);
        await setSeconds(page, -2);
        const clampedLow = await read(page);
        check(clampedLow.input?.value === "0" && clampedLow.stored === "0", "-2 is clamped to 0", `value ${clampedLow.input?.value}`);

        // ---- 9. the setting survives a reload, and the reloaded page honours it --------------------------------
        section("across a reload");
        await setSeconds(page, 2);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector("#health.ok", { timeout: 30_000 });
        await page.waitForTimeout(250);
        const reloaded = await read(page);
        check(reloaded.input?.value === "2" && reloaded.stored === "2",
          "the row and wtgui.bannerSeconds still read 2 after a reload", `value ${reloaded.input?.value}, stored ${JSON.stringify(reloaded.stored)}`);
        await showRed(page);
        await sleep(1200);
        const twoEarly = await read(page);
        check(twoEarly.shown, "the reloaded page is still up 1.2 s into the saved 2 s");
        const twoGone = await hiddenWithin(page, 1800);
        check(twoGone, "and hides it by 3 s", twoGone ? "" : "still up");

        // ---- 10. the green note keeps its own four seconds ------------------------------------------------------
        section("the green note");
        await openSettingsGroup(page, "board");
        await setSeconds(page, 1);
        await closeSettings(page);
        // A green note can replace a red bar. The red bar's clock (1 s here) must not take the note at its own
        // deadline: a note is a confirmation, not a failure with a remainder.
        await showRed(page);
        await sleep(300);
        await showGreen(page);
        await page.waitForTimeout(200);
        const green = await read(page);
        check(green.shown && green.ok, "the green confirmation is up");
        check(green.x && green.x.display === "none", "and it carries no ✕");
        await sleep(1000);
        const greenAfterRed = await read(page);
        check(greenAfterRed.shown && greenAfterRed.ok,
          "a green note is not cut short by the red bar's clock it replaced", `shown ${greenAfterRed.shown}, ok ${greenAfterRed.ok}`);
        await sleep(2000);
        const greenHeld = await read(page);
        check(greenHeld.shown, "it is still up at 3.2 s into its own four", `shown ${greenHeld.shown}`);
        const greenGone = await hiddenWithin(page, 1500);
        check(greenGone, "and it goes by 4.7 s — its own four seconds, not the setting's", greenGone ? "" : "still up");

        check(pageErrors.length === 0, "no uncaught page errors", pageErrors.join(" | "));
      },
      { viewport: VIEWPORT, deviceScaleFactor: 1 },
    );
  } catch (e) {
    failures += 1;
    console.log(`FAIL  the run itself threw  ${(e && e.stack) || e}`);
  } finally {
    await panel.stop();
    console.log(`\n${failures === 0 ? "OK" : "FAILED"}  ${checks - failures}/${checks} checks passed`);
    process.exit(failures === 0 ? 0 : 1);
  }
}

await main();
