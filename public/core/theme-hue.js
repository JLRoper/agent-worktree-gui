// theme-hue.js - ONE THEME COLOUR'S RULE, for every surface that can be given a hue.
//
// WHY THIS IS A MODULE AND NOT A THIRD COPY. The project boxes have had Ctrl+click colouring since the board
// existed (public/app.js `loadProjectHues` / `saveProjectHues` / `rollProjectHue`), and the Initiatives tab's cards
// asked for the same gesture. Two copies of a chooser is two answers to "what does a re-roll do", and the copy that
// is read last wins: the hue is a random number, the re-roll has to move it far enough to be visible, and a stored
// value has to be wrapped into the circle. So the rule is written here once, and both surfaces keep only their own
// KEY and their own MAP:
//
//   * `load(key)` reads the map a surface's colours live in. A key with nothing in it, unreadable JSON, or a
//     storage that throws on READ (`localStorage` itself can throw in a locked-down browser) is an empty map - a
//     colour nobody can read is not a reason to fail the page.
//   * `save(key, map)` writes it and answers whether it landed. A storage that refuses the WRITE is the tab-only
//     case: the caller keeps its in-memory map, the reader keeps the colour until the tab closes, and nothing else
//     changes. That is why this returns false instead of throwing.
//   * `roll(map, key, name)` picks the next hue: a random one, moved at least `MIN_STEP` degrees away from the one
//     already there, because a re-roll that lands next door looks like the click did nothing.
//
// Published on globalThis as `wtThemeHue`, loaded by public/index.html before app.js (the projects' own functions
// are one-line delegations to it) and before assistant.js (the initiatives' cards use it directly).
// test/theme-hue.test.js imports this same file and answers a fake storage.
(function (root) {
  "use strict";

  // A re-roll has to change what you see: a new hue closer than this to the old one reads as no change at all.
  const MIN_STEP = 45;
  // Where a re-roll goes when the random one landed too close: half a circle away, which cannot also be too close.
  const STEP_AWAY = 150;

  // A hue is a point on the circle: 370 is 10, and -10 is 350.
  const wrapHue = (h) => ((h % 360) + 360) % 360;

  // The storage the caller named, or the page's own. Reading `root.localStorage` can itself throw when a browser
  // has storage switched off, so even that is inside the try.
  function store(wanted) {
    try {
      return wanted || root.localStorage || null;
    } catch {
      return null;
    }
  }

  /**
   * The map of name -> hue kept under `key`: a Map, because a surface looks a colour up by name on every paint.
   * Anything unreadable answers an empty map rather than throwing into the paint that asked.
   */
  function load(key, storage) {
    try {
      const raw = JSON.parse(store(storage).getItem(key) || "{}");
      const map = new Map();
      for (const [name, hue] of Object.entries(raw || {})) {
        const h = Number(hue);
        if (Number.isFinite(h)) map.set(name, wrapHue(h));
      }
      return map;
    } catch {
      return new Map();
    }
  }

  /**
   * Write `map` under `key`. True when the storage took it; false when it refused, which is the tab-only case the
   * caller answers by keeping the map in memory.
   */
  function save(key, map, storage) {
    try {
      store(storage).setItem(key, JSON.stringify(Object.fromEntries(map)));
      return true;
    } catch {
      /* no storage: the colour lasts this tab only */
      return false;
    }
  }

  /**
   * The next hue for `name`: random, and at least `MIN_STEP` degrees from the one it replaces. The map is written
   * in place and persisted by the same call, so a caller cannot roll a colour it forgets to store.
   */
  function roll(map, key, name, storage) {
    const prev = map.get(name);
    let hue = Math.floor(Math.random() * 360);
    if (prev != null && Math.abs(hue - prev) < MIN_STEP) hue = (hue + STEP_AWAY) % 360;
    map.set(name, hue);
    save(key, map, storage);
    return hue;
  }

  root.wtThemeHue = { MIN_STEP, wrapHue, load, save, roll };
})(globalThis);
