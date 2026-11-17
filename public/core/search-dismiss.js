// search-dismiss.js - one predicate: does a mousedown close the assistant's search results?
//
// WHY THIS EXISTS. The results popover opens on a filter and, until this module, only a key press or a click on a
// row ever closed it: a reader who clicked away to the transcript, another pane, or the board kept a list floating
// over the card, still ringing a match they had stopped looking at. The rule is small but it has three edges that
// are easy to get wrong in an event handler, so it is a pure function with a test:
//
//   * INSIDE THE BOX OR THE LIST IS NOT OUTSIDE. A mousedown on the search input, on a result row, on the panel's
//     own scrollbar, or on the footer is the reader using the list - a click there still selects a row - so it must
//     not close anything.
//   * A DRAG THAT STARTS INSIDE THE LIST IS INSIDE. The decision is made on `mousedown` alone, so a selection that
//     begins on a row and ends over the transcript (mouseup elsewhere) never closes the list under the reader.
//   * ANYTHING ELSE IS OUTSIDE, INCLUDING ANOTHER PANE OF THE SAME FLOAT. The transcript, the tabs, the board: all
//     of them are places the reader went instead of the list.
//
// Published on globalThis as `wtSearchDismiss`, loaded as a classic script by public/index.html (before
// assistant.js) and imported by test/assistant-search-dismiss.test.js - the same load contract
// public/core/search-items.js has. The function takes nodes, not a document, so the test can answer it with nothing
// but two stubs that know what they contain.

(function (root) {
  "use strict";

  // Is `target` the node, or inside it? A node that cannot answer `contains` (a stub, a detached fragment) still
  // answers for identity, which is the whole question for the input itself.
  function inside(target, node) {
    if (!target || !node) return false;
    if (node === target) return true;
    return typeof node.contains === "function" && Boolean(node.contains(target));
  }

  // Does a mousedown on `target` close the popover? `zones` carries the two places a mousedown belongs to the
  // search: the input and the results panel. A missing target (a synthetic event, a call with nothing) is never a
  // dismissal: a handler that closed the list on an event it cannot place would close it on its own repaint.
  function outside(target, { input = null, pop = null } = {}) {
    if (!target) return false;
    if (inside(target, input)) return false;
    if (inside(target, pop)) return false;
    return true;
  }

  root.wtSearchDismiss = { outside, inside };
})(globalThis);
