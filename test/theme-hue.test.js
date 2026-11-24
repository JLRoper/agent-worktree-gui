// One theme colour's rule: public/core/theme-hue.js, and the two surfaces that must be using it.
//
// WHY THIS FILE EXISTS. The project boxes' Ctrl+click colouring had its chooser written inline in public/app.js, and
// the Initiatives tab's cards wanted the same gesture. The wrong answer here is a second copy: two re-roll rules (one
// "at least 45 degrees away", one not) and two storage fallbacks (one keeping the colour for the tab, one throwing on
// the first write) would look identical in a screenshot and behave differently the moment a browser refuses storage.
// So the rule is pinned here, and the delegations are pinned by reading the two files that own the gestures.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

await import("../public/core/theme-hue.js");
const hue = globalThis.wtThemeHue;

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const assistant = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

// A storage that answers like localStorage and can be told to refuse.
function fakeStorage(seed = {}, { readThrows = false, writeThrows = false } = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem(key) {
      if (readThrows) throw new Error("storage denied");
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      if (writeThrows) throw new Error("storage denied");
      map.set(key, String(value));
    },
  };
}

test("a stored hue is wrapped onto the circle, and anything that is not a number is dropped", () => {
  const store = fakeStorage({ wm: JSON.stringify({ a: 370, b: -10, c: "x", d: null }) });
  const map = hue.load("wm", store);
  assert.equal(map.get("a"), 10);
  assert.equal(map.get("b"), 350);
  assert.equal(map.has("c"), false);
  // Number(null) is 0, which IS a real hue: the reader's colour-less entry is the absent key, not a null value.
  assert.equal(map.get("d"), 0);
});

test("a key nobody wrote, unreadable JSON, or a storage that refuses a read is an empty map, not a throw", () => {
  assert.equal(hue.load("nothing", fakeStorage()).size, 0);
  assert.equal(hue.load("wm", fakeStorage({ wm: "{not json" })).size, 0);
  assert.equal(hue.load("wm", fakeStorage({ wm: "{}" }, { readThrows: true })).size, 0);
});

test("a save reports whether the storage took it, and a refused write leaves the map alone", () => {
  const store = fakeStorage();
  const map = new Map([["one", 120]]);
  assert.equal(hue.save("wm", map, store), true);
  assert.equal(store.map.get("wm"), JSON.stringify({ one: 120 }));
  assert.equal(hue.save("wm", map, fakeStorage({}, { writeThrows: true })), false);
  assert.equal(map.get("one"), 120, "the tab-only fallback keeps the colour in memory");
});

test("a roll is a whole hue, is stored by the same call, and a re-roll moves it far enough to see", () => {
  const store = fakeStorage();
  const map = new Map();
  const first = hue.roll(map, "wm", "init", store);
  assert.equal(Number.isInteger(first), true);
  assert.ok(first >= 0 && first < 360);
  assert.equal(map.get("init"), first);
  assert.equal(JSON.parse(store.map.get("wm")).init, first, "a roll persists without the caller remembering to save");
});

test("a re-roll never lands beside the colour it replaces, by the rule the project boxes have always used", () => {
  // The rule is stated on the NUMBER, not on the circle: `|next - prev| >= MIN_STEP`, with a +150 step when the random
  // hue landed closer. That is deliberate - it is the projects' chooser, unchanged - so this pins the arithmetic the
  // two surfaces share rather than a circular distance the older rule never promised.
  const store = fakeStorage();
  const map = new Map([["init", 40]]);
  for (let i = 0; i < 500; i += 1) {
    const before = map.get("init");
    const next = hue.roll(map, "wm", "init", store);
    assert.ok(next >= 0 && next < 360, `${next} is on the circle`);
    assert.ok(Math.abs(next - before) >= hue.MIN_STEP, `${next} is ${Math.abs(next - before)} from ${before}`);
    map.set("init", next);
  }
});

test("both surfaces use this one rule, each with its own key", () => {
  assert.match(app, /wtThemeHue\.load\(PROJECT_HUE_KEY\)/, "the projects load through the shared rule");
  assert.match(app, /wtThemeHue\.roll\(state\.projectHues, PROJECT_HUE_KEY, name\)/, "the projects roll through the shared rule");
  assert.match(assistant, /wtThemeHue\.load\(INIT_HUE_KEY\)/, "the initiatives load through the shared rule");
  assert.match(assistant, /wtThemeHue\.roll\(initHues, INIT_HUE_KEY, id\)/, "the initiatives roll through the shared rule");
  assert.match(app, /PROJECT_HUE_KEY = "wm\.projectHues"/);
  assert.match(assistant, /INIT_HUE_KEY = "wm\.initiativeHues"/);
  assert.match(html, /<script src="\/core\/theme-hue\.js"><\/script>/, "the page loads it before the two that delegate");
  assert.ok(html.indexOf("/core/theme-hue.js") < html.indexOf("/app.js"), "before app.js, whose globals are read at parse time");
});
