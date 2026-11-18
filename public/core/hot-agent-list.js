// hot-agent-list.js - how many recent turns the Hot Agent search lists when its box is empty.
//
// WHY THIS IS A MODULE. The number is read in two places that must agree: the page (assistant.js, which sends the
// limit with every read) and the panel's Settings row (which writes it). The default and the clamp live here once,
// the same way public/core/search-count.js owns the search's one readout, so a settings row cannot write a number
// the request then silently changes. It is also the number the SERVER falls back to when a caller sends no limit,
// through lib/hot-agent/search.js importing this same file.
//
// Saved in this BROWSER, like the other Display/Board rows: it is a reading preference, not a fact about the panel
// that another machine should inherit.
//
// Published on globalThis as `wtHotAgentList`, loaded as a classic script by public/index.html before
// assistant.js, and imported by lib/hot-agent/search.js and test/hot-agent-search.test.js.
(function (root) {
  "use strict";

  const KEY = "wtgui.hotAgentList";
  const DEFAULT = 20;
  const MAX = 100;
  const MIN = 1;

  /**
   * One limit, normalised: an absent/blank/unreadable value is the DEFAULT (a reader who never touched the row
   * gets 20), a fractional value is rounded, and anything outside 1..100 is clamped rather than refused - a
   * settings box that answers "no" to 500 is worse than one that saves 100 and says it did.
   */
  function norm(value) {
    if (value == null) return DEFAULT;
    const text = String(value).trim();
    if (!text) return DEFAULT;
    const n = Number(text);
    if (!Number.isFinite(n)) return DEFAULT;
    return Math.min(MAX, Math.max(MIN, Math.round(n)));
  }

  /**
   * The setting as this browser holds it. `storage` is passed in (a test stub, or window.localStorage) rather
   * than read off a global here, which is what keeps the module importable by a server test with no DOM.
   */
  function read(storage) {
    if (!storage || typeof storage.getItem !== "function") return DEFAULT;
    let raw = null;
    try {
      raw = storage.getItem(KEY);
    } catch {
      return DEFAULT; // a browser that refuses storage answers the default, not an error the page has to catch
    }
    return norm(raw);
  }

  /** Write one value; returns what was stored. A refusing browser answers the value it would have held. */
  function write(storage, value) {
    const n = norm(value);
    try {
      storage?.setItem?.(KEY, String(n));
    } catch {
      /* the default read still answers, and the reader is told by the row's own note */
    }
    return n;
  }

  root.wtHotAgentList = { KEY, DEFAULT, MAX, MIN, norm, read, write };
})(globalThis);
