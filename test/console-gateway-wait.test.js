// The wait line the reader actually sees: one dim row in the console BODY, with an age that ticks in place, and the
// wording that changes once past PULSE_SILENT_SECONDS. The server half (lib/jobs.js pushGatewayWait/noteFirstEvent/
// noteNoEventAtSettle) is pinned in test/gateway-wait-line.test.js; this pins the page's half by running the SHIPPED
// functions, read out of the source rather than copied here:
//
//   public/board/console.js  the region "gateway wait line" (waitLineHtml/waitLineWords) and lineHtml
//   public/app.js            tickLiveClocks, over rows built the way the console builds them
//
// The claim is the GATEWAY's in every state: nothing here may say the agent is thinking.
import assert from "node:assert/strict";
import test from "node:test";

import { readSource, sliceBetween, sliceRegion } from "../tools/panel-testkit.mjs";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtSeconds = (s) => {
  const n = Math.max(0, Math.round(Number(s) || 0));
  return n < 60 ? `${n}s` : `${Math.floor(n / 60)}m ${String(n % 60).padStart(2, "0")}s`;
};

const waitRegion = sliceRegion(readSource("public/board/console.js"), "gateway wait line");
const lineHtmlSrc = sliceBetween(readSource("public/board/console.js"), "function lineHtml(l, live = \"\", cls = \"\") {", "\nfunction burstGroups(");
const clockSrc = sliceBetween(readSource("public/app.js"), "function tickLiveClocks() {", "\nsetInterval(tickLiveClocks");

// The page's own functions, with the clock held still: `now` is the only thing a test moves.
function page(now, silent = 20) {
  const Date2 = { now: () => now };
  const make = new Function(
    "esc",
    "fmtSeconds",
    "PULSE_SILENT_SECONDS",
    "Date",
    "typedShown",
    "consoleMdIsProse",
    "linkifyText",
    `${waitRegion}\n${lineHtmlSrc}\nreturn { waitLineHtml, waitLineWords, waitAgeSecs, lineHtml };`,
  );
  return make(esc, fmtSeconds, silent, Date2, () => null, () => false, (t) => String(t));
}

const waitingLine = (at) => ({ kind: "dim", lid: 7, at, wait: "gateway", text: "run started - the gateway has sent nothing yet" });

test("a young wait says the run has started and the gateway has sent nothing yet, with its age", () => {
  const p = page(1_000_000);
  const html = p.waitLineHtml(waitingLine(1_000_000 - 4_000));
  assert.match(html, /run started - the gateway has sent nothing yet/);
  assert.match(html, /data-gwait-label/, "the words are their own slot, so only the age is rewritten");
  assert.match(html, /data-gwait-age>4s</, "the measured age, not a promise");
  assert.doesNotMatch(html, /think|reasoning|the model/i);
});

test("past PULSE_SILENT_SECONDS the row states the silence plainly, with the age, and claims nothing about thinking", () => {
  const p = page(1_000_000);
  const html = p.waitLineHtml(waitingLine(1_000_000 - 82_000));
  assert.match(html, /the run is still live - the gateway has sent nothing for /);
  assert.match(html, /data-gwait-age>1m 22s</);
  assert.doesNotMatch(html, /run started/, "the young wording is replaced, not kept beside it");
  for (const secs of [0, 19.9, 20, 60, 82, 600]) {
    const words = p.waitLineWords(secs);
    assert.doesNotMatch(words, /think|reasoning|the model/i, `the gateway line never claims a thought (${secs}s)`);
    assert.match(words, /gateway/);
  }
  // The threshold is the panel's ONE number for this, not a second copy.
  assert.equal(p.waitLineWords(19.9), "run started - the gateway has sent nothing yet · ");
  assert.equal(p.waitLineWords(20), "the run is still live - the gateway has sent nothing for ");
});

test("lineHtml marks the waiting row so the one-second clock finds it, and draws its two slots", () => {
  const p = page(1_000_000);
  const html = p.lineHtml(waitingLine(1_000_000 - 3_000));
  assert.match(html, /class="jl jl-dim jl-gwait"/);
  assert.match(html, /data-gwait="997000"/, "the stamp the ticker counts from rides the row");
  assert.match(html, /data-gwait-label/);
  assert.match(html, /data-gwait-age/);
  // A line that is no longer waiting - the first frame's annotation, or a settled run's verdict - is an ordinary dim
  // line: no clock, no wait mark, no second row.
  for (const wait of ["first", "never", undefined]) {
    const plain = p.lineHtml({ kind: "dim", lid: 7, at: 997_000, wait, text: "an event from the gateway arrived after 3.0s" });
    assert.doesNotMatch(plain, /data-gwait|jl-gwait/);
    assert.match(plain, /an event from the gateway arrived after 3\.0s/);
  }
});

class WaitRow {
  constructor(at, now) {
    this.dataset = { gwait: String(at) };
    this.now = now;
    this.classes = new Set();
    this.list = this.classes;
    this.classList = { toggle: (name, on) => (on ? this.classes.add(name) : this.classes.delete(name)) };
    this.label = { textContent: "" };
    this.age = { textContent: "" };
  }
  querySelector(selector) {
    if (selector === "[data-gwait-label]") return this.label;
    if (selector === "[data-gwait-age]") return this.age;
    return null;
  }
}

function ticker(rows, now, silent = 20) {
  const document = { querySelectorAll: (selector) => (selector === "[data-gwait]" ? rows.filter((r) => r.dataset.gwait) : []) };
  const p = page(now, silent);
  const run = new Function(
    "document",
    "waitLineWords",
    "fmtSeconds",
    "PULSE_SILENT_SECONDS",
    "Date",
    `${clockSrc}\nreturn tickLiveClocks;`,
  )(document, p.waitLineWords, fmtSeconds, silent, { now: () => now });
  return run;
}

test("the card's one-second clock rewrites the age in place and states the silence past the threshold", () => {
  const now = 1_000_000;
  const row = new WaitRow(now - 5_000, now);
  const run = ticker([row], now);
  run();
  assert.equal(row.label.textContent, "run started - the gateway has sent nothing yet · ");
  assert.equal(row.age.textContent, "5s", "the age counts from the line's own stamp");
  assert.equal(row.classes.has("is-silent"), false, "a young wait stays quiet");
  // Same nodes, later clock: the row is not rebuilt, so a scrolled console does not move.
  const label = row.label;
  const later = ticker([row], now + 22_000);
  later();
  assert.equal(row.label, label, "the label node is the same node, rewritten");
  assert.equal(row.label.textContent, "the run is still live - the gateway has sent nothing for ");
  assert.equal(row.age.textContent, "27s");
  assert.equal(row.classes.has("is-silent"), true, "the plain statement of silence wears the amber state");
});

test("the clock stops when the row stops waiting: the first frame's annotation is not written over", () => {
  const now = 1_000_000;
  const row = new WaitRow(now - 30_000, now);
  ticker([row], now)();
  assert.equal(row.age.textContent, "30s");
  // lib/jobs.js answers the same lid with mode:"set" and the wait mark gone; the console clears the attribute
  // (public/board/console.js drawJobLine's set branch), and the age is nobody's to write any more.
  delete row.dataset.gwait;
  const labelBefore = row.label.textContent;
  ticker([row], now + 60_000)();
  assert.equal(row.label.textContent, labelBefore, "no clock writes over a finished wait");
});
