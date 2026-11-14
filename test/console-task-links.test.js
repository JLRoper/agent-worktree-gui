// A TASK ID in the assistant's transcript is a reference, not a word: `#405` names one row of one assistant's queue,
// and the console draws it as an anchor WHILE it renders (public/core/console-markdown.js). This is the unit half of
// that promise - the browser half (the press, the scroll, the pulse) is tools/verify-task-refs.mjs.
//
// What must never need a browser to fail:
//
//   * the anchor carries BOTH halves of the reference in data attributes (the assistant and the id), because the press
//     handler has nothing else to go on;
//   * an id the resolver will not place stays the text it was - no anchor, no guess, and nothing that looks pressable;
//   * a pull request number is not a task, and neither is a number inside code or inside a link;
//   * a card with no resolver (the board's agent cards) draws the words it always did.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const context = vm.createContext({ window: {}, console });
for (const file of ["public/core/dom-format.js", "public/core/console-markdown.js"]) {
  vm.runInContext(readFileSync(path.join(root, file), "utf8"), context, { filename: file });
}
const M = context.window.WMApp.core.consoleMarkdown;

const prose = (texts) => texts.map((text, i) => ({ kind: "text", text, lid: 100 + i }));
const rendered = (texts, taskLink = null) => M.html(prose(texts), taskLink ? { taskLink } : {});
const visible = (html) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
const anchors = (html) => [...String(html).matchAll(/<a class="as-task-ref"[^>]*>#[^<]*<\/a>/g)].map((m) => m[0]);
// One assistant's queue: 405 and 406 are its own, 999 is nobody's, and 760 belongs to a PR.
const queue = new Map([
  ["405", "assistant-2"],
  ["406", "assistant-2"],
]);
const place = (id) => queue.get(String(id)) || null;
const resolver = () => {
  const fn = (id) => {
    fn.calls.push(String(id));
    return place(id);
  };
  fn.calls = [];
  return fn;
};

test("a task id the resolver places is ONE static anchor carrying the assistant and the id", () => {
  const html = rendered(["the anchor is ready on #405, and #406 is next"], resolver());
  assert.equal(anchors(html).length, 2, `both ids became anchors: ${html}`);
  assert.match(html, /<a class="as-task-ref" href="#assistant" data-as-task="405" data-as-task-own="assistant-2"/);
  assert.match(html, /data-as-task="406"/);
  // The reader still sees the id, and the sentence still reads as the agent wrote it.
  assert.equal(visible(html).trim(), "the anchor is ready on #405, and #406 is next");
});

test("an id the resolver will not place stays plain text - no anchor, no guess", () => {
  const ask = resolver();
  const html = rendered(["nothing there yet: #999, and #405 is fine"], ask);
  assert.equal(anchors(html).length, 1, "only the id the resolver placed is an anchor");
  assert.match(html, /data-as-task="405"/);
  assert.ok(!/data-as-task="999"/.test(html), "the unresolved id was not turned into anything pressable");
  assert.equal(visible(html).trim(), "nothing there yet: #999, and #405 is fine");
  assert.ok(ask.calls.includes("999"), "the resolver was asked, and answered null");
});

test("a pull request number is not a task, even when a queue happens to hold that id", () => {
  const ask = resolver();
  queue.set("760", "assistant-1");
  try {
    const html = rendered(["PR #760 MERGED, and also (PR #760) in the notes"], ask);
    assert.equal(anchors(html).length, 0, `no anchor for a PR number: ${html}`);
    assert.ok(!ask.calls.includes("760"), "the resolver was not even asked about a PR number");
    assert.equal(visible(html).trim(), "PR #760 MERGED, and also (PR #760) in the notes");
  } finally {
    queue.delete("760");
  }
});

test("a number inside code, or inside a link's target, is not a task id", () => {
  const html = rendered(["`#405` is how you write it, and https://example.test/task/405#405 is a url, and [#406](https://x.test/406)"], resolver());
  assert.equal(anchors(html).length, 0, `nothing inside code or a url is lifted: ${html}`);
  assert.match(html, /<code class="md-code">#405<\/code>/);
});

test("a marker glued to a word is a word", () => {
  const html = rendered(["see #405 but not abc#406"], resolver());
  assert.equal(anchors(html).length, 1);
  assert.match(html, /data-as-task="405"/);
  assert.ok(!/data-as-task="406"/.test(html));
});

test("parenthesised and listed ids are references too", () => {
  assert.equal(anchors(rendered(["(#405)"], resolver())).length, 1);
  assert.equal(anchors(rendered(["- #405 first in line"], resolver())).length, 1);
  assert.equal(anchors(rendered(["## #405 in a heading"], resolver())).length, 1);
});

test("a fence is not prose: ids in code stay code", () => {
  const lines = [
    { kind: "text", text: "```", lid: 1 },
    { kind: "text", text: "#405 is not a reference here", lid: 2 },
    { kind: "text", text: "```", lid: 3 },
  ];
  const html = M.html(lines, { taskLink: resolver() });
  assert.equal(anchors(html).length, 0, `a fence's body is code: ${html}`);
  assert.match(html, /#405 is not a reference here/);
});

test("a console with no resolver draws the words it always did", () => {
  const html = rendered(["the anchor is ready on #405"]);
  assert.equal(anchors(html).length, 0);
  assert.equal(visible(html).trim(), "the anchor is ready on #405");
});

test("the live append path places the same anchors as a repaint", () => {
  // consoleMdAppendRow is what a streaming console appends with; a task id has to look the same there as in the
  // repaint that follows, or the anchor would appear only once the turn ended.
  const html = M.appendRow({ kind: "text", text: "done on #405", lid: 7 }, "text", { taskLink: resolver() });
  assert.match(html, /data-as-task="405"/);
  assert.match(html, /data-as-task-own="assistant-2"/);
});
