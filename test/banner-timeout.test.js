// The Board tab's banner timeout: one number, 0–30, five seconds by default, saved under `wtgui.bannerSeconds` — and
// the red banner's clock read from it at arm time.
//
// The seam-free half of `tools/verify-banner-timeout.mjs` (there is no layout engine and no real clock in `npm
// test`): the reader is sliced out of `public/app.js` and driven over a stub localStorage, and the row is read out of
// the shipped markup. What it pins is the part a typo moves silently — the key's name, the band, the default, a value
// the browser stored that is not a number — plus the wiring that makes the red path arm a clock while the green note
// keeps its own four seconds.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function grab(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `public/app.js still carries ${name}()`);
  const end = src.indexOf("\n}\n", start);
  assert.ok(end > start, `${name}() is still a top-level function`);
  return src.slice(start, end + 3);
}

const number = (name) => {
  const m = src.match(new RegExp(`const ${name} = (\\d+);`));
  assert.ok(m, `public/app.js declares ${name}`);
  return Number(m[1]);
};
const KEY = (src.match(/const BANNER_SECONDS_KEY = "([^"]+)";/) || [])[1];
const DEFAULT = number("BANNER_SECONDS_DEFAULT");
const MAX = number("BANNER_SECONDS_MAX");
const NOTE_MS = number("BANNER_NOTE_MS");

// The reader, with the three module constants passed in: the same function the page runs, no DOM needed.
const bannerSecondsOver = (getItem) =>
  new Function(
    "localStorage",
    "BANNER_SECONDS_KEY",
    "BANNER_SECONDS_DEFAULT",
    "BANNER_SECONDS_MAX",
    `${grab("bannerSeconds")}\nreturn bannerSeconds;`,
  )({ getItem }, KEY, DEFAULT, MAX);

test("the key, the band and the default are the ones the Board tab promises", () => {
  assert.equal(KEY, "wtgui.bannerSeconds", "the setting lives under the reader's own wtgui.* key");
  assert.equal(DEFAULT, 5, "five seconds is what a reader who never chose one gets");
  assert.equal(MAX, 30, "the row's top is 30 s");
  assert.equal(NOTE_MS, 4000, "the green confirmation's four seconds are its own constant, not the setting");
});

test("an absent key reads as the default and is not written back", () => {
  const seconds = bannerSecondsOver(() => null);
  assert.equal(seconds(), 5);
  // "" is what a cleared field leaves behind in some browsers; it is the default, not 0.
  assert.equal(bannerSecondsOver(() => "")(), 5);
});

test("a stored number is read, and clamped to 0–30", () => {
  const over = (raw) => bannerSecondsOver(() => raw)();
  assert.equal(over("0"), 0, "0 is a real setting: never hide itself");
  assert.equal(over("1"), 1);
  assert.equal(over("12"), 12);
  assert.equal(over("30"), 30);
  assert.equal(over("31"), 30, "above the band is the band's top");
  assert.equal(over("45"), 30);
  assert.equal(over("-1"), 0, "below the band is the band's bottom");
  assert.equal(over("4.6"), 5, "a stored fraction is rounded to whole seconds");
});

test("a value that is not a number falls back to the default rather than to 0", () => {
  const over = (raw) => bannerSecondsOver(() => raw)();
  assert.equal(over("abc"), 5);
  assert.equal(over("  "), 5);
  assert.equal(over("1e400"), 5, "Infinity is not a setting");
});

test("a browser that refuses storage still gets the default", () => {
  const seconds = bannerSecondsOver(() => {
    throw new Error("denied");
  });
  assert.equal(seconds(), 5);
});

test("the red path arms the clock, the green path keeps its four seconds, and hiding clears both", () => {
  const showBanner = grab("showBanner");
  assert.match(showBanner, /armBannerTimer\(\);/, "showBanner (re)starts the red bar's clock on every message");
  const showNote = grab("showNote");
  assert.match(showNote, /setTimeout\(hideBanner, BANNER_NOTE_MS\)/, "showNote's four seconds are unchanged by the setting");
  const hideBanner = grab("hideBanner");
  assert.match(hideBanner, /clearTimeout\(noteTimer\)/, "hiding clears the green timer");
  assert.match(hideBanner, /stopBannerTimer\(\)/, "hiding clears the red timer too");
  const arm = grab("armBannerTimer");
  assert.match(arm, /if \(bannerHeld\(\)\) return;/, "a held bar does not arm the clock");
  assert.match(arm, /if \(ms <= 0\) return;/, "0 never arms one");
  const held = grab("bannerHeld");
  assert.match(held, /:hover/, "the pointer's hold is read from the DOM");
  assert.match(held, /activeElement/, "the keyboard's hold is read from the DOM");
});

test("the row is in the Board panel, a number, 0–30, and has no baked-in value", () => {
  assert.equal(html.split('id="banner-seconds"').length - 1, 1, "#banner-seconds appears exactly once");
  const boardStart = html.indexOf('data-settings-group="board"');
  assert.ok(boardStart > 0, "the Board panel is in the page");
  const board = html.slice(boardStart, html.indexOf('<div class="settings-group', boardStart + 10));
  assert.match(board, /id="banner-seconds"/, "the row is the Board tab's");
  assert.doesNotMatch(html.slice(0, boardStart), /id="banner-seconds"/, "and not another tab's");
  const input = board.match(/<input id="banner-seconds"([^>]*)>/);
  assert.ok(input, "the row carries the input");
  assert.match(input[1], /type="number"/);
  assert.match(input[1], /min="0"/);
  assert.match(input[1], /max="30"/);
  assert.doesNotMatch(input[1], /value=/, "the default is the script's number, so it cannot drift from BANNER_SECONDS_DEFAULT");
  const label = board.match(/<label class="settings-row[^"]*" for="banner-seconds"([^>]*)>/);
  assert.ok(label, "the input is announced by its own row label");
  assert.match(label[1], /title="[^"]*✕/, "the row's own words say the ✕ still dismisses at once");
  assert.match(label[1], /title="[^"]*(pointer|focus)/i, "and that hovering or focusing pauses it");
  assert.match(label[1], /title="[^"]*four seconds/, "and that a green note keeps its four seconds");
  assert.match(board, /id="banner-preview"/, "the row says what is in effect under itself");
});
