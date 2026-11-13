// The console's marching tail: ". . . . " under a live turn's last line, one dot every 500 ms, cleared to one dot
// whenever output arrives, and gone the instant the turn reads done.
//
// The claim this file has to hold is not the look, it is the PLACE. The row is a sibling of the console, so it is no
// segment of `createDrawStream`, nothing orders it against one, and the record's own text, height and scroll are the
// console's. The page's own region is driven here against a fake document, with the timer and the clock injected, so
// the interval, the wrap and the clear are the things under test rather than a copy of them. The browser half - a real
// card, a real turn, the measured interval, the feed's height across two wraps and the two captures - is
// tools/verify-march-row.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(path.join(root, f), "utf8").replace(/\r\n/g, "\n");
const consoleSrc = read("public/board/console.js");
const jobsSrc = read("public/render-jobs.js");
const cssRaw = read("public/style.css");
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "");

const begin = consoleSrc.indexOf("// ---- the console's marching tail");
const end = consoleSrc.indexOf("// ---- end the console's marching tail");
assert.ok(begin > 0 && end > begin, "the marching-tail region is in public/board/console.js");
const region = consoleSrc.slice(begin, end);

// ---- a page just big enough for the region -------------------------------------------------------------------------
// An element per row, a text node per dot slot, and consoles whose `nextElementSibling` is the row - which is where
// render-jobs.js puts it. The row's `textContent` is derived from its text node, so a write that REPLACED the node
// (the mutation the copy observer wakes for) is visible as a changed node identity.
function makeRow(id, text = ". ") {
  const node = { nodeType: 3, nodeValue: text, parentNode: null };
  const dots = {
    firstChild: node,
    appendChild(n) {
      this.firstChild = n;
      n.parentNode = this;
      return n;
    },
  };
  node.parentNode = dots;
  const row = {
    dataset: { march: id },
    _dots: dots,
    querySelector: (sel) => (sel === ".march-dots" ? dots : null),
    removed: false,
    remove() {
      this.removed = true;
    },
  };
  return row;
}

function bench({ still = false, record = "the turn's own record, no dots in it" } = {}) {
  const clock = { t: 1_000_000 };
  const timers = new Map();
  let seq = 0;
  const consoles = [];
  const state = {};
  const cleared = [];
  const ctx = {
    state,
    placedNodes: () => consoles.map((c) => c.out),
    document: {
      hidden: false,
      createTextNode: (t) => ({ nodeType: 3, nodeValue: t, parentNode: null }),
      querySelectorAll: (sel) => {
        const m = /\[data-march="(.*)"\]/.exec(sel);
        return consoles.map((c) => c.row).filter((r) => !m || r.dataset.march === m[1]);
      },
    },
    setInterval: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { fn, ms });
      return id;
    },
    clearInterval: (id) => {
      cleared.push(id);
      timers.delete(id);
    },
    Date: { now: () => clock.t },
    esc: (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])),
    turnLive: (t) => Boolean(t && String(t.status) === "running"),
    matchMedia: () => ({ matches: still }),
    CSS: { escape: (s) => String(s) },
  };
  const script = new vm.Script(`(() => {
    ${region}
    return { marchDotsAt, marchText, marchRowHtml, marchReset, marchAdvance, marchEnd, marchStart, marchStop,
      MARCH_STEP_MS, MARCH_DOTS };
  })()`);
  const api = script.runInContext(vm.createContext(ctx));
  // A console with a row, as turnBody emits them: the <pre> first, the row as its next sibling.
  const mount = (id, text) => {
    const out = { textContent: record, dataset: { out: id } };
    const row = makeRow(id, text);
    out.nextElementSibling = row;
    consoles.push({ out, row });
    return row;
  };
  const unmount = (row) => {
    const i = consoles.findIndex((c) => c.row === row);
    if (i >= 0) consoles.splice(i, 1);
  };
  const textOf = (row) => row._dots.firstChild && row._dots.firstChild.nodeValue;
  const tick = () => {
    for (const x of [...timers.values()]) x.fn();
  };
  return { ...api, clock, timers, cleared, consoles, state, mount, unmount, textOf, tick, record };
}

// ---- the clock -------------------------------------------------------------------------------------------------------
test("the march is one dot every 500 ms and four dots to the cycle", () => {
  const b = bench();
  assert.equal(b.MARCH_STEP_MS, 500);
  assert.equal(b.MARCH_DOTS, 4);
  const at = (ms) => b.marchDotsAt(0, ms);
  assert.deepEqual([0, 1, 499, 500, 999, 1000, 1499, 1500, 1999, 2000, 2500, 3999, 4000].map(at), [
    1, 1, 1, 2, 2, 3, 3, 4, 4, 1, 2, 4, 1,
  ]);
});

test("one space between dots, and the slot is exactly eight characters wide", () => {
  const b = bench();
  assert.equal(b.marchText(1), ". ");
  assert.equal(b.marchText(2), ". . ");
  assert.equal(b.marchText(4), ". . . . ");
  for (const n of [1, 2, 3, 4]) {
    assert.equal(b.marchText(n).length, 2 * n, `step ${n} is one dot plus one space each`);
    assert.equal(b.marchText(n).trimEnd().split(" ").length, n, `step ${n} has ${n} dots`);
  }
  // The slot the stylesheet sizes: `.march-dots { width: 8ch }` is this string and nothing wider, so the fourth dot
  // is the clear at the right edge and no step can grow the row.
  assert.equal(css.match(/\.out-wrap > \.live-pulse\.march \.march-dots \{[^}]*\}/)[0].includes("width: 8ch"), true);
});

test("the dot count is a function of the clock, so a late tick neither skips nor doubles a dot", () => {
  const b = bench();
  const row = b.mount("j1");
  b.state.march = new Map([["j1", { at: 0, dots: 1 }]]);
  for (const [now, want] of [[0, ". "], [10, ". "], [1000, ". . . "], [1200, ". . . "], [2000, ". "], [2500, ". . "]]) {
    b.marchAdvance(now);
    assert.equal(b.textOf(row), want, `at ${now}ms`);
  }
});

// ---- the place -------------------------------------------------------------------------------------------------------
test("the row is drawn only while the turn is live, and it is no console line", () => {
  const b = bench();
  const live = b.marchRowHtml({ id: "j1", status: "running" });
  assert.match(live, /data-march="j1"/);
  assert.match(live, /class="live-pulse is-stream march"/);
  assert.match(live, /class="pulse-dot"/);
  assert.match(live, /class="march-dots"/);
  assert.match(live, /class="march-label"/);
  for (const line of ["jl ", "jl-", "data-lid", "data-ltext", "tgrp"]) {
    assert.equal(live.includes(line), false, `the row carries no ${line}: it is not a line of the record`);
  }
  assert.equal(b.marchRowHtml({ id: "j1", status: "done" }), "", "a settled turn draws no row at all");
  assert.equal(b.marchRowHtml({ id: "j1", status: "running" }).includes("is-still"), false);
});

test("render-jobs emits the row after the console, outside the <pre>, and only once", () => {
  const calls = jobsSrc.split("${marchRowHtml(turn)}").length - 1;
  assert.equal(calls, 1, "one place draws the row");
  const at = jobsSrc.indexOf("${marchRowHtml(turn)}");
  assert.ok(at > jobsSrc.indexOf("</pre>"), "the row is emitted after the console closes");
  assert.ok(at < jobsSrc.indexOf("${consoleToolsHtml()}"), "and before the console's own tools");
  const between = jobsSrc.slice(jobsSrc.lastIndexOf("`<div class=\"out-wrap", at) + 1, at);
  assert.equal(between.includes("${body}"), true, "the console body is closed before the row");
});

test("the region never reaches the ordered stream", () => {
  // The region's own prose says what it does NOT do ("it never joins createDrawStream"), so the check is on the CODE.
  const code = region
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  for (const forbidden of ["createDrawStream", "typeStream", "typeGate", "typeHold", "feed(", "shownFor", "drawRowText", "paintTypedLines", "requestAnimationFrame"]) {
    assert.equal(code.includes(forbidden), false, `the march never calls ${forbidden}`);
  }
});

test("the stream's own books do not move while the row marches", async () => {
  await import("../public/core/type-stream.js");
  const P = globalThis.wtType.createDrawStream({ rate: 40, now: () => 0, schedule: () => 1, cancel: () => {}, onPaint: () => {} });
  const b = bench();
  const row = b.mount("j1");
  for (let i = 0; i <= 8; i++) {
    b.marchAdvance(i * 500);
    b.marchReset("j1");
  }
  assert.equal(b.textOf(row).includes("."), true);
  const s = P.stats();
  assert.equal(s.enqueued, 0, "no segment was enqueued for the row");
  assert.equal(s.pending ?? 0, 0);
  assert.equal(P.pendingWords(), 0);
});

// ---- clearing, wrapping and ending ------------------------------------------------------------------------------------
test("the row wraps at four dots and one full cycle is two seconds", () => {
  const b = bench();
  const row = b.mount("j1");
  b.state.march = new Map([["j1", { at: 0, dots: 1 }]]);
  b.marchStart();
  const seen = [];
  for (let ms = 0; ms <= 4000; ms += 500) {
    b.clock.t = ms;
    b.tick();
    seen.push(b.textOf(row));
  }
  assert.deepEqual(seen.slice(0, 5), [". ", ". . ", ". . . ", ". . . . ", ". "]);
  assert.deepEqual(seen.slice(5), seen.slice(1, 5), "the second cycle is the first one again, 2 s later");
});

test("new output clears it back to a single dot, and the next step is 500 ms away", () => {
  const b = bench();
  const row = b.mount("j1");
  const at = 0;
  b.state.march = new Map([["j1", { at, dots: 1 }]]);
  b.marchAdvance(1500);
  assert.equal(b.textOf(row), ". . . . ");
  b.clock.t = 1700;
  b.marchReset("j1"); // a burst arrives
  assert.equal(b.textOf(row), ". ", "cleared at once, not on the next tick");
  b.clock.t = 2000;
  b.marchAdvance(b.clock.t);
  assert.equal(b.textOf(row), ". ", "the old clock is gone: 300 ms after the burst is still one dot");
  b.clock.t = 2200;
  b.marchAdvance(b.clock.t);
  assert.equal(b.textOf(row), ". . ", "the next dot is 500 ms after the burst");
});

test("the turn reading done takes the row away at once, and stops the clock", () => {
  const b = bench();
  const row = b.mount("j1");
  const pinned = b.mount("j1");
  b.state.march = new Map([["j1", { at: 0, dots: 1 }]]);
  b.marchStart();
  assert.equal(b.timers.size, 1, "one timer for the page, whatever the rows");
  b.marchAdvance(1000);
  b.marchEnd("j1");
  assert.equal(row.removed, true);
  assert.equal(pinned.removed, true, "both copies of a pinned turn go");
  assert.equal(b.state.march.size, 0, "and the count goes with it");
  b.unmount(row);
  b.unmount(pinned);
  b.marchAdvance(1500);
  assert.equal(b.cleared.length, 1, "no row left: the timer is cleared");
});

test("the march writes the row's own text node, never the record's", () => {
  const b = bench();
  const row = b.mount("j1");
  const node = row._dots.firstChild;
  const out = b.consoles[0].out;
  for (let i = 0; i <= 12; i++) b.marchAdvance(i * 500);
  assert.equal(row._dots.firstChild, node, "the same text node all the way: nodeValue, not textContent");
  assert.equal(out.textContent, b.record, "the console's text is untouched, dots or no dots");
});

// ---- the panel's one motion idiom -------------------------------------------------------------------------------------
test("reduced motion holds a static single dot and a label, and starts no march", () => {
  const b = bench({ still: true });
  const live = b.marchRowHtml({ id: "j1", status: "running" });
  assert.match(live, /is-still/, "the row says it is holding still");
  assert.match(live, /march-label/);
  assert.equal(b.marchStart(), undefined);
  assert.equal(b.timers.size, 0, "no timer is started when motion is held still");
  const row = b.mount("j1");
  b.state.march = new Map([["j1", { at: 0, dots: 1 }]]);
  for (const ms of [0, 500, 1500, 4000]) {
    b.marchAdvance(ms);
    assert.equal(b.textOf(row), ". ", `still at ${ms}ms`);
  }
});

test("the stylesheet reuses the pulse idiom's one rule and adds no media query", () => {
  const media = cssRaw.match(/@media \(prefers-reduced-motion: reduce\)/g) || [];
  assert.equal(media.length, 2, "the two that were there: nothing new to turn off");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.live-pulse \.pulse-dot \{ animation: none; \} \}/);
  assert.match(css, /@keyframes livepulse/);
  assert.match(css, /\.live-pulse \.pulse-dot \.is-offscreen|\.live-pulse \.pulse-dot\.is-offscreen/);
  assert.match(css, /\.out-wrap > \.live-pulse\.march \{/);
  assert.match(css, /\.out-wrap > \.live-pulse\.march \.march-label \{ display: none; \}/);
  assert.match(css, /\.out-wrap > \.live-pulse\.march\.is-still \.march-label \{ display: inline; \}/);
  // The card's own one-second pulse clock must not rewrite the tail: it would take the march's classes away.
  const appSrc = read("public/app.js");
  assert.match(appSrc, /querySelectorAll\("\.live-pulse:not\(\[data-march\]\)"\)/);
});
