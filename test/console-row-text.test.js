// A growing console row is appended to, not re-parsed.
//
// What went wrong. Every 40 ms while a line typed, the page assigned the row's whole `innerHTML` to reveal the next
// word or two. That assignment reparses the row and replaces every text node in it, so a selection standing in the
// line died about 25 times a second (measured: median held 33-50 ms) even though the words only ever grew at the end.
// The rule now lives in one helper, `drawRowText`, which both writers (the pacer's paint and the live append) call.
//
// The helper under test is READ OUT of public/app.js between its markers, not copied here, so a change to the page's
// own rule changes these answers. The model is a just-enough DOM: innerHTML replaces the children and creates a text
// node for plain text or an element for markup (which is what decides whether a tail may be appended), and
// linkifyText turns a URL into an element exactly as the page's does.
import assert from "node:assert/strict";
import test from "node:test";

import { readSource, sliceRegion } from "../tools/panel-testkit.mjs";

const code = sliceRegion(readSource("public/app.js"), "console row text");
const linkifyText = (text) => (/https?:\/\//i.test(text) ? `<a class="out-link">${text}</a>` : String(text));
const make = new Function("document", "linkifyText", `${code}\nreturn { drawRowText, rowTakesTail };`);

// A row model: `nodes` are what the element holds (type 1 = an element child, type 3 = a text node).
class Row {
  constructor(nodes = []) {
    this.nodes = nodes;
    this.html = 0;
    this.written = null;
    this._drawn = undefined;
  }
  get childElementCount() {
    return this.nodes.filter((n) => n.nodeType === 1).length;
  }
  get lastChild() {
    return this.nodes[this.nodes.length - 1] || null;
  }
  appendChild(node) {
    this.nodes.push(node);
    return node;
  }
  set innerHTML(value) {
    this.html += 1;
    this.written = value;
    this.nodes = /<[a-z]/i.test(value) ? [{ nodeType: 1, tag: "a", data: value }] : [{ nodeType: 3, data: value }];
  }
  get textContent() {
    return this.nodes.map((n) => n.data).join("");
  }
}

const text = (data) => ({
  nodeType: 3,
  data,
  appendData(extra) {
    this.data += extra;
  },
});
const fakeDocument = { createTextNode: (data) => text(data) };
const { drawRowText, rowTakesTail } = make(fakeDocument, linkifyText);

test("a growing line appends its tail and keeps the node the reader is in", () => {
  const first = text("the console");
  const row = new Row([first]);
  row._drawn = "the console";
  assert.equal(drawRowText(row, "the console row"), true);
  assert.equal(row.html, 0, "nothing was re-parsed");
  assert.equal(row.textContent, "the console row", "the row reads the whole line");
  assert.equal(row.nodes[0], first, "the text node that was already there is the same node");
  assert.equal(row.nodes.length, 1, "the tail grew that node instead of adding a sibling");
  assert.equal(first.data, "the console row");
});

test("an unchanged row is not written at all", () => {
  const row = new Row([text("same")]);
  row._drawn = "same";
  assert.equal(drawRowText(row, "same"), false);
  assert.equal(row.html, 0);
  assert.equal(row.nodes.length, 1);
});

test("a line that no longer starts with what is drawn is re-parsed", () => {
  const row = new Row([text("a line")]);
  row._drawn = "a line";
  assert.equal(drawRowText(row, "a different line"), true);
  assert.equal(row.html, 1, "the wire rewrote the line, so the row is rebuilt once");
  assert.equal(row.textContent, "a different line");
});

test("a URL is linkified, never appended as text", () => {
  const row = new Row([text("open ")]);
  row._drawn = "open ";
  assert.equal(drawRowText(row, "open http://127.0.0.1:7331/x"), true);
  assert.equal(row.html, 1, "the URL took the markup path");
  assert.match(row.written, /<a /, "the URL became an anchor");
});

test("a row that already carries an anchor is re-parsed, not appended after it", () => {
  const row = new Row([{ nodeType: 1, tag: "a", data: "http://127.0.0.1:7331/x" }]);
  row._drawn = "http://127.0.0.1:7331/x";
  assert.equal(rowTakesTail(row, "http://127.0.0.1:7331/x and more"), false);
  drawRowText(row, "http://127.0.0.1:7331/x and more");
  assert.equal(row.html, 1);
});

test("a row with a live-clock span is re-parsed rather than appended after the span", () => {
  const row = new Row([text("running"), { nodeType: 1, tag: "span", data: "· 3s" }]);
  row._drawn = "running";
  assert.equal(rowTakesTail(row, "running faster"), false);
  drawRowText(row, "running faster");
  assert.equal(row.html, 1);
});

test("a fresh row with nothing drawn yet takes the markup path", () => {
  const row = new Row();
  assert.equal(row._drawn, undefined);
  assert.equal(rowTakesTail(row, "first words"), false);
  drawRowText(row, "first words");
  assert.equal(row.html, 1);
  assert.equal(row.textContent, "first words");
});
