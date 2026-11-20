// active-button.js - whether the floating header draws the ACTIVE AGENTS button at all.
//
// WHY THIS IS A MODULE. Two readers have to agree about one switch: the page's paint (public/app.js
// `paintHotButton`, which decides whether the control exists) and the Settings > General row that writes it. The
// default and the read live here once, the way public/core/hot-agent-list.js owns the list's one number, so a row
// cannot save a value the paint then reads differently - and test/active-button-toggle.test.js drives this same
// file, so the default and the decision are asked by name rather than inferred from the page.
//
// OFF IS THE DEFAULT, and off means ABSENT: the button is not drawn at all - no grey bolt, no zero badge, no
// reserved space - which is the same "zero is absent" rule the control already had for a board with no agent
// working. A reader who never opens the row gets a header without it.
//
// THE WIRE NAMES DID NOT CHANGE WITH THE LABEL. `#btn-hot`, `#hot-label` and `#hot-badge` are the ids the control has
// always had, so a page written against the older build still finds it. The switch itself is new, so it has its own
// key - `wtgui.activeButton` - and a browser that never set it reads the default. Only the word a person sees is Active.
//
// Published on globalThis as `wtActiveButton`, loaded as a classic script by public/index.html before app.js, and
// imported by test/active-button-toggle.test.js.
(function (root) {
  "use strict";

  const KEY = "wtgui.activeButton";
  const DEFAULT = false;

  // The stored value as a switch. A stored "1"/"true"/"on" is on, "0"/"false"/"off" is off, and anything else
  // (absent, blank, unreadable, a word another build wrote) is the DEFAULT: a reader who never set it gets off, and
  // a hand-edited value is never guessed into a header control.
  function norm(value) {
    if (value == null) return DEFAULT;
    const text = String(value).trim().toLowerCase();
    if (!text) return DEFAULT;
    if (text === "1" || text === "true" || text === "on") return true;
    if (text === "0" || text === "false" || text === "off") return false;
    return DEFAULT;
  }

  /**
   * The setting as this browser holds it. `storage` is passed in (window.localStorage, or a test stub) rather than
   * read off a global here, which is what keeps the module importable by a server test with no DOM.
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
  function write(storage, on) {
    const value = Boolean(on);
    try {
      storage?.setItem?.(KEY, value ? "1" : "0");
    } catch {
      /* the value still applies for this page, and the row's own note says where it is saved */
    }
    return value;
  }

  // THE ONE DECISION the paint asks: the control exists only when the reader switched it on AND an agent is
  // actually working. Both halves, so "on with nothing running" is still absent - the bolt is a claim that an agent
  // is burning right now, and a quiet one would be a claim about the board that is not true. A turn parked on a
  // permission or a question is never in `list` (public/core/hot-mark.js), so it can never make this true.
  function show(list, on) {
    return Boolean(on) && (list || []).length > 0;
  }

  root.wtActiveButton = { KEY, DEFAULT, norm, read, write, show };
})(globalThis);
