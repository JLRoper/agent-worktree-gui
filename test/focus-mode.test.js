// The two gestures a double-click on the top bar must not disturb.
//
// The header gains one gesture: a double-click on the top bar toggles focus mode. Two existing paths sit beside it
// and neither may move:
//
//   1. the board's single-click fold of a project head (public/app.js, the document `click` listener's
//      `.project-head[data-toggle-project]` branch) - a single click on a head must still fold the project, and the
//      two clicks a double-click produces must never be read as a fold;
//   2. the model readout's own double-click (`[data-model-pick]`, its own document listener) - a single click on the
//      readout stays a single click, and its double-click must still open the list rather than be swallowed by the
//      header's handler.
//
// WHAT IS DRIVEN: the shipped registrations, sliced out of public/app.js and run in a vm. The click listener's whole
// body runs against a target that only the project head matches, so the test would fail if a branch above the fold
// started consuming that click. Nothing here is re-implemented.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");

// One registration's own source: from its opening line to the closing `});` at column 0. Every callback nested
// inside it is indented, so the first `\n});\n` after the start is the end of the listener. `anchor` picks the
// registration among several that open the same way (the page has more than one document click listener), by a
// line only the one under test carries.
function listenerSource(opening, anchor) {
  for (let at = app.indexOf(opening); at > 0; at = app.indexOf(opening, at + opening.length)) {
    const end = app.indexOf("\n});\n", at);
    assert.ok(end > at, `the registration ends at column 0: ${opening}`);
    const text = app.slice(at, end + 5);
    if (text.includes(anchor)) return text;
  }
  assert.fail(`app.js still carries the registration: ${opening} / ${anchor}`);
}

// A sandbox with just the page names a listener reaches on the target this test builds. `document.addEventListener`
// records the handler instead of registering it, so the test can dispatch the event itself.
function listenerHarness(source, stubs = {}) {
  const handlers = new Map();
  const ctx = {
    document: {
      addEventListener: (type, fn) => handlers.set(type, fn),
      querySelector: () => null,
    },
    CSS: { escape: (s) => String(s) },
    state: { pendingFocus: null, projectHues: new Map(), settings: {} },
    ...stubs,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return { ctx, handlers };
}

function event(target, extra = {}) {
  const e = {
    target,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    prevented: 0,
    stopped: 0,
    preventDefault() {
      e.prevented += 1;
    },
    stopPropagation() {
      e.stopped += 1;
    },
    ...extra,
  };
  return e;
}

// A target that matches exactly the selectors the test says it does, and nothing else. That is what makes the whole
// click listener safe to run: every branch above the fold asks `closest` and gets null.
function targetMatching(matches) {
  return {
    closest(sel) {
      return Object.prototype.hasOwnProperty.call(matches, sel) ? matches[sel] : null;
    },
  };
}

test("a single click on a project head still folds that project", async () => {
  const calls = [];
  const head = { dataset: { toggleProject: "alpha" } };
  const { handlers } = listenerHarness(listenerSource('document.addEventListener("click", async (e) => {', '.project-head[data-toggle-project]'), {
    // keepInPlace corrects the page for the accordion; here it just runs the fold, which is the press's own path.
    keepInPlace: (_find, run) => run(),
    toggleProject: (name) => calls.push(name),
    revertEditOnClickAway: () => {},
    closeArtifactPops: () => {},
  });
  const click = handlers.get("click");
  assert.ok(click, "the board's click listener is registered on the document");

  const e = event(targetMatching({ ".project-head[data-toggle-project]": head }));
  await click(e);

  assert.deepEqual(calls, ["alpha"], "the press folded the project under the caret");
  assert.equal(e.prevented, 0, "the fold is the head's own only path; nothing above it claimed the press");
});

test("a double-click on the model readout opens the model list", async () => {
  const calls = [];
  const btn = { dataset: { modelPick: "opus" }, id: "readout" };
  const { handlers } = listenerHarness(listenerSource('document.addEventListener("dblclick", (e) => {', '[data-model-pick]'), {
    openModelPop: (thread, el) => calls.push([thread, el]),
    state: { pendingFocus: null, projectHues: new Map() },
  });
  const dbl = handlers.get("dblclick");
  assert.ok(dbl, "the model readout's double-click listener is registered on the document");

  const e = event(targetMatching({ "[data-model-pick]": btn }));
  dbl(e);

  assert.deepEqual(calls, [["opus", btn]], "the readout's own double-click still opens its list");
  assert.equal(e.prevented, 1, "and it still owns the event, as its comment promises");
});

test("a double-click that is not the model readout is left alone", () => {
  const calls = [];
  const { handlers } = listenerHarness(listenerSource('document.addEventListener("dblclick", (e) => {', '[data-model-pick]'), {
    openModelPop: (thread, el) => calls.push([thread, el]),
    state: { pendingFocus: null, projectHues: new Map() },
  });
  const e = event(targetMatching({}));
  handlers.get("dblclick")(e);

  assert.deepEqual(calls, [], "nothing opened");
  assert.equal(e.prevented, 0, "and nothing was consumed: a single click on the readout stays a single click");
});
