// Undo and redo for the composer's pasted content, proved on a real composer with a real paste.
// HARNESS: LIVE GATE
//
// WHY THIS EXISTS. A chip is written programmatically: board/paste-chips.js inserts the atom itself and
// board/attachments.js draws the file chip above the box, so the editing engine's own undo stack never saw either
// write and Ctrl+Z after a paste did nothing. The composer keeps its own bounded stack now, and this gate drives
// the two presses in Chromium against a sandbox panel of THIS checkout:
//
//   (a) a block pasted into the New-agent composer becomes one chip; Ctrl+Z takes it back, the box reads exactly
//       the text it held before the paste, and the chip's text leaves the panel's state;
//   (b) Ctrl+Shift+Z puts the same chip back, with the whole block in it;
//   (c) a pasted FILE becomes an attachment chip above the box; Ctrl+Z takes that chip off and unstages the file;
//   (d) #82's keys are untouched: Ctrl+Backspace beside a chip removes it whole, Ctrl+Backspace in typed text
//       takes one word, and neither records an action of its own;
//   (e) ordinary typing keeps the engine's own undo: with nothing pasted, Ctrl+Z is not taken by the composer and
//       the browser's undo moves the typed text;
//   (f) a paste BELOW the threshold lands as plain text rather than a chip, and the same keys cover it: Ctrl+Z
//       takes exactly the pasted text back and restores the caret, Ctrl+Shift+Z puts both back, and two short
//       pastes are two entries.
//
//   node tools/verify-composer-undo.mjs                    boot a sandbox panel of this checkout
//   PROBE_CAPTURES=1 node tools/verify-composer-undo.mjs   also write the before/after PNGs (PROBE_OUT names dir)
//
// The captures default to a scratch directory so a run never rewrites the committed images under
// docs/assets/composer-undo. The browser half needs a Playwright install; without one this says
// BROWSER-HALF-NOT-RUN and exits 2 rather than passing on a half that never ran.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startPanel } from "./panel-testkit.mjs";
import { loadPlaywright, stubEventSourceInit } from "./browser.mjs";

const TREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOX = "#job-prompt";
const OUT = String(process.env.PROBE_OUT || "").trim() || path.join(tmpdir(), "wtgui-composer-undo");
const WRITE_CAPTURES = String(process.env.PROBE_CAPTURES || "") === "1";
const PASTE = Array.from({ length: 6 }, (_, i) => `pasted line ${i + 1} of the block the reader copied in`).join("\n");
// Short enough for neither threshold: this one lands as plain text, not a chip.
const SHORT = "a short paste";

let checks = 0;
let failures = 0;
const check = (name, got, want) => {
  checks += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  const brief = (v) => {
    const s = JSON.stringify(v);
    return s && s.length > 180 ? `${s.slice(0, 120)} ...(${s.length} chars)` : s;
  };
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${brief(got)}${ok ? "" : ` (wanted ${brief(want)})`}`);
};
const note = (msg) => console.log(`        ${msg}`);

const readBox = (page) => page.evaluate((sel) => window.WMApp.board.pasteChips.readBox(document.querySelector(sel)), BOX);
const chipCount = (page) => page.evaluate((sel) => document.querySelectorAll(`${sel} .paste-chip`).length, BOX);
const chipLabel = (page) => page.evaluate((sel) => document.querySelector(`${sel} .paste-chip .pc-label`)?.textContent || null, BOX);
// -1 on a build with no stack at all, which is what makes this gate a red proof against an older checkout.
const depth = (page) =>
  page.evaluate((sel) => {
    const api = window.WMApp.board.pasteChips;
    return typeof api.composerActionDepth === "function" ? api.composerActionDepth(document.querySelector(sel)) : -1;
  }, BOX);
const attachChips = (page) =>
  page.evaluate(() => [...document.querySelectorAll("#spawn-chips .attach-chip")].map((c) => c.textContent.trim()));
const caret = (page) =>
  page.evaluate((sel) => window.WMApp.board.pasteChips.caretOffset(document.querySelector(sel)), BOX);

// A real paste: a real DataTransfer handed to a real ClipboardEvent at the focused box.
const pasteAt = (page, kind, payload) =>
  page.evaluate(
    ({ sel, kind, payload }) => {
      const box = document.querySelector(sel);
      box.focus();
      const dt = new DataTransfer();
      if (kind === "file") {
        dt.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13])], payload || "shot.png", { type: "image/png" }));
      } else {
        dt.setData("text/plain", payload);
      }
      let ev = null;
      try {
        ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
      } catch {
        ev = null;
      }
      if (!ev || ev.clipboardData !== dt) {
        ev = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(ev, "clipboardData", { value: dt });
      }
      box.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented };
    },
    { sel: BOX, kind, payload },
  );

// The composer's own region, so a capture shows the box and its chip row and nothing else.
const clip = (page) =>
  page.evaluate(
    ({ sel }) => {
      const box = document.querySelector(sel);
      const row = document.querySelector("#spawn-chips");
      const rects = [box.getBoundingClientRect(), row ? row.getBoundingClientRect() : null].filter(Boolean);
      const x = Math.min(...rects.map((r) => r.x));
      const y = Math.min(...rects.map((r) => r.y));
      const right = Math.max(...rects.map((r) => r.right));
      const bottom = Math.max(...rects.map((r) => r.bottom));
      return { x: Math.max(0, Math.floor(x - 12)), y: Math.max(0, Math.floor(y - 12)), width: Math.ceil(right - x + 24), height: Math.ceil(bottom - y + 24) };
    },
    { sel: BOX },
  );
const shot = async (page, name) => {
  if (!WRITE_CAPTURES) return null;
  mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, clip: await clip(page) });
  note(`capture ${file}`);
  return file;
};

let panel = null;
let browser = null;
try {
  panel = await startPanel({ config: { assistant: { enabled: false, seconds: 3600, maxWakesPerHour: 0 } } });
  note(`panel ${panel.base} (${TREE})`);
  const pw = loadPlaywright({ root: TREE });
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN: no Playwright install found; set PANEL_PLAYWRIGHT_ROOT");
    process.exitCode = 2;
  } else {
    browser = await pw.chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(stubEventSourceInit);
    const page = await context.newPage();
    page.on("pageerror", (e) => note(`page error: ${e.message}`));
    await page.goto(`${panel.base}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(BOX, { state: "visible", timeout: 30000 });
    await page.waitForFunction(() => Boolean(window.WMApp?.board?.pasteChips), null, { timeout: 30000 });
    await page.click(BOX);
    await page.keyboard.type("Quote this: ");

    // ---- (a) the pasted block -------------------------------------------------------------
    console.log("\n== (a) paste a block, Ctrl+Z: the chip goes, the typed text stays ==");
    const typedText = await readBox(page);
    await shot(page, "1-text-before-paste.png");
    check("the paste is taken by the page (default prevented)", (await pasteAt(page, "text", PASTE)).prevented, true);
    check("one chip, in place", await chipCount(page), 1);
    check("the box reads the typed text and the block", await readBox(page), `${typedText}${PASTE}`);
    check("the composer's stack holds one action", await depth(page), 1);
    note(`chip label: ${JSON.stringify(await chipLabel(page))}`);
    await shot(page, "2-text-after-paste.png");

    await page.keyboard.press("Control+z");
    check("Ctrl+Z: the chip is gone", await chipCount(page), 0);
    check("Ctrl+Z: the box is back to the typed text", await readBox(page), typedText);
    check("Ctrl+Z: nothing is left on the undo side", await depth(page), 0);
    await shot(page, "3-text-after-undo.png");

    // ---- (b) redo -------------------------------------------------------------------------
    console.log("\n== (b) Ctrl+Shift+Z puts the same chip back ==");
    await page.keyboard.press("Control+Shift+z");
    check("Ctrl+Shift+Z: the chip is back", await chipCount(page), 1);
    check("Ctrl+Shift+Z: with the whole block in it", await readBox(page), `${typedText}${PASTE}`);
    note(`chip label after redo: ${JSON.stringify(await chipLabel(page))}`);
    await page.keyboard.press("Control+z");
    check("and Ctrl+Z takes it again", await chipCount(page), 0);

    // ---- (f) a paste below the threshold -------------------------------------------------
    console.log("\n== (f) a short paste lands as text, and Ctrl+Z / Ctrl+Shift+Z cover it too ==");
    await page.click(BOX);
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
    await page.keyboard.type("Quote this: ");
    const typedShort = await readBox(page);
    await shot(page, "8-text-paste-before.png");
    check("the short paste is taken by the page", (await pasteAt(page, "text", SHORT)).prevented, true);
    check("no chip: the short paste is plain text", await chipCount(page), 0);
    check("the box reads the typed text and the paste", await readBox(page), `${typedShort}${SHORT}`);
    check("the composer's stack holds one action for it", await depth(page), 1);
    const shortCaret = await caret(page);
    note(`caret after the short paste: ${shortCaret} (typed text is ${typedShort.length})`);
    await shot(page, "9-text-paste-after-paste.png");

    await page.keyboard.press("Control+z");
    check("Ctrl+Z: the pasted text is gone", await readBox(page), typedShort);
    check("Ctrl+Z: the caret is back where the paste found it", await caret(page), typedShort.length);
    await shot(page, "10-text-paste-after-undo.png");

    await page.keyboard.press("Control+Shift+z");
    check("Ctrl+Shift+Z: the text is back", await readBox(page), `${typedShort}${SHORT}`);
    check("Ctrl+Shift+Z: and the caret is after it", await caret(page), shortCaret);
    await shot(page, "11-text-paste-after-redo.png");

    // Two short pastes, two entries: neither insert was in the engine's history, so both presses must be the
    // composer's, and the first must take only the second paste. The depth is read as a delta because the redo
    // above put its entry back, and a stale entry is only dropped when a press reaches it.
    const depthBeforeTwo = await depth(page);
    await page.click(BOX);
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
    await pasteAt(page, "text", "alpha ");
    await pasteAt(page, "text", "beta");
    check("two short pastes read as one line of text", await readBox(page), "alpha beta");
    check("each paste added an entry of its own", await depth(page), depthBeforeTwo + 2);
    await page.keyboard.press("Control+z");
    check("Ctrl+Z takes the second paste only", await readBox(page), "alpha ");
    await page.keyboard.press("Control+z");
    check("Ctrl+Z again takes the first", await readBox(page), "");
    check("and both entries are gone", await depth(page), depthBeforeTwo);

    // ---- (c) a pasted file ---------------------------------------------------------------
    console.log("\n== (c) paste a file, Ctrl+Z: the attachment chip and the staged file both go ==");
    await page.click(BOX);
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
    check("the file paste is taken by the page", (await pasteAt(page, "file", "shot.png")).prevented, true);
    await page.waitForFunction(() => document.querySelectorAll("#spawn-chips .attach-chip").length > 0, null, { timeout: 15000 });
    check("one attachment chip above the box", (await attachChips(page)).length, 1);
    note(`chip: ${JSON.stringify((await attachChips(page))[0])}`);
    await shot(page, "4-file-after-paste.png");

    await page.keyboard.press("Control+z");
    await page.waitForFunction(() => document.querySelectorAll("#spawn-chips .attach-chip").length === 0, null, { timeout: 5000 });
    check("Ctrl+Z: the attachment chip is off the composer", (await attachChips(page)).length, 0);
    check("Ctrl+Z: and the box's own text is untouched", await readBox(page), "");
    await shot(page, "5-file-after-undo.png");

    // ---- (d) and (e) the keys #82 gave the box, and the engine's own undo -----------------
    console.log("\n== (d) #82's keys, unchanged ==");
    await page.click(BOX);
    await pasteAt(page, "text", PASTE);
    check("a fresh paste, one chip", await chipCount(page), 1);
    note(`caret after the paste: ${await page.evaluate((sel) => window.WMApp.board.pasteChips.caretOffset(document.querySelector(sel)), BOX)}`);
    const stateBefore = await depth(page);
    await page.keyboard.press("Control+Backspace");
    check("Ctrl+Backspace beside the chip: it goes whole", await chipCount(page), 0);
    check("Ctrl+Backspace: and the box keeps the rest", await readBox(page), "");
    check("Ctrl+Backspace recorded nothing new", await depth(page), stateBefore);

    await page.click(BOX);
    await page.keyboard.type("alpha beta gamma delta");
    await page.keyboard.press("Control+Backspace");
    check("Ctrl+Backspace in typed text takes one word", await readBox(page), "alpha beta gamma ");
    check("the composer recorded no action for a word delete", await depth(page), stateBefore);
    await page.keyboard.press("Control+z");
    check("Ctrl+Z there is left alone: the word delete is not resurrected", await readBox(page), "alpha beta gamma ");

    console.log("\n== (e) ordinary typing keeps the engine's own undo ==");
    await page.click(BOX);
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
    await page.keyboard.type("hello there");
    check("typed text is in the box", await readBox(page), "hello there");
    await page.keyboard.press("Control+z");
    // How much the engine takes per press is Chromium's own granularity; what matters is that the press REACHED
    // it - the typed text moved - because the composer had nothing to step back over.
    const nativeAfter = await readBox(page);
    note(`typed "hello there", Ctrl+Z -> ${JSON.stringify(nativeAfter)}`);
    check("Ctrl+Z with nothing pasted is the engine's: the typing moves under it", nativeAfter !== "hello there" && "hello there".startsWith(nativeAfter), true);
    await shot(page, "6-native-typing-after-undo.png");
  }
} catch (e) {
  failures += 1;
  console.log(`\nPROBE ERROR: ${e && e.stack ? e.stack : e}`);
} finally {
  try {
    if (browser) await browser.close();
  } catch {
    /* already gone */
  }
  try {
    if (panel) await panel.stop();
  } catch {
    /* already gone */
  }
  console.log(`\nRESULT: ${failures === 0 ? "PASS" : `FAIL (${failures})`} of ${checks} checks`);
  if (failures) process.exitCode = 1;
}
