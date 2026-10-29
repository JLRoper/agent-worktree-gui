// Every tool result is ONE box, folded until the reader opens it: the renderer's rules, as text in and markup out.
//
// public/core/console-format.js is a classic script in the page, so it is loaded here in a vm the way the page loads
// it — over the real dom-format.js, so `esc`, `linkifyText` and `tailPath` are the shipped ones — and driven through
// the one entry point every console uses, `consoleBodyHtml`. The browser half (a real click, a repaint, a stream, the
// typing) is tools/verify-output-boxes.mjs; this is the part that must never need a browser to fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const context = vm.createContext({
  window: {},
  console,
  document: { getElementById: () => null },
  state: { projects: new Map() },
  normPath: (p) => String(p ?? "").split("\\").join("/").replace(/\/+$/, ""),
});
for (const file of ["public/core/dom-format.js", "public/core/console-format.js"]) {
  vm.runInContext(readFileSync(path.join(root, file), "utf8"), context, { filename: file });
}
const CF = context.window.WMApp.core.consoleFormat;

const out = (lines, kind = "tool-out") => lines.map((text, i) => ({ kind, text, lid: 100 + i }));
const html = (lines, opts = {}, kind) => CF.bodyHtml(out(lines, kind), opts);
const count = (s, re) => (s.match(re) || []).length;
const boxes = (s) => count(s, /<div class="code-box /g);
const opened = (s) => count(s, /<div class="code-body">/g);
const folded = (s) => count(s, /<div class="code-body" hidden>/g);

const TERMINAL = ["docs/a.md:1:first hit", "docs/b.md:2:second hit", "--- a heading that is not a diff ---"];

test("a shell transcript is one box, folded, that says what it is and how long it is", () => {
  const h = html(TERMINAL, { tool: "terminal", arg: "grep -rn x docs" });
  assert.equal(boxes(h), 1);
  assert.equal(folded(h), 1, "folded by default");
  assert.equal(opened(h), 0);
  assert.match(h, /<span class="code-what">terminal output<\/span>/);
  assert.match(h, /<span class="code-n">3 lines<\/span>/);
  assert.match(h, /<span class="code-hint">click to read<\/span>/);
  assert.match(h, /aria-expanded="false"/);
  assert.match(h, /<span class="code-caret">▸<\/span>/);
  for (const line of TERMINAL) assert.ok(h.includes(`data-ltext="${line}"`), `${line} is in the box, whole, as a console line`);
});

test("a result of one line is a box too — every result, not the long ones", () => {
  const h = html(["saved"], { tool: "memory", arg: "add" });
  assert.equal(boxes(h), 1);
  assert.match(h, /<span class="code-n">1 line<\/span>/);
  assert.equal(folded(h), 1);
});

test("a file read keeps its name in the header; a bare shell print names its file too", () => {
  const read = html(["1|{", "2|}"], { tool: "read_file", arg: "docs/map.md" });
  assert.match(read, /<span class="code-what">read_file · docs\/map\.md<\/span>/);
  assert.match(read, /code-box is-file/);
  const cat = html(["a", "b"], { tool: "terminal", arg: "cat package.json" });
  assert.match(cat, /<span class="code-what">terminal · package\.json<\/span>/);
  const one = html(["only line"], { tool: "read_file", arg: "x.txt" });
  assert.equal(boxes(one), 1, "one solid line of a file is still boxed");
});

test("a tool nobody can name still gets the box, called plain output", () => {
  const h = html(["something"], { tool: "", arg: "" });
  assert.match(h, /<span class="code-what">output<\/span>/);
});

test("the result's own header line, and the notes under a result, stay OUTSIDE the box", () => {
  const rows = [
    "  ↳ terminal · 0.42s",
    "alpha",
    "beta",
    "… result truncated by the gateway — the live stream carries a preview of a tool result, not all of it",
  ];
  const h = html(rows, { tool: "terminal", arg: "ls" });
  assert.equal(boxes(h), 1);
  const bodyAt = h.indexOf('<div class="code-body"');
  const bodyEnd = h.indexOf("</div></div>", bodyAt);
  const inside = h.slice(bodyAt, bodyEnd);
  assert.ok(!inside.includes("↳ terminal"), "the header line is not in the box");
  assert.ok(!inside.includes("result truncated"), "the gateway's note is not in the box");
  assert.ok(h.indexOf("↳ terminal") < h.indexOf('<div class="code-box'), "the header comes first");
  assert.ok(h.indexOf("result truncated") > bodyEnd, "the note comes after it, as the line it always was");
  assert.match(h, /<span class="code-n">2 lines<\/span>/, "and neither is counted");
});

test("the panel's own fold note is still a button, outside the box, naming its result", () => {
  const note = { kind: "tool-out", text: "… 214 lines hidden — click to read", lid: 9, fold: { tool: "terminal", row: 3 } };
  const rows = [...out(["one", "two"]), note];
  // The caller (public/app.js) is the one that knows the TURN a note is filed under, and hands the whole fold in.
  const h = CF.bodyHtml(rows, { tool: "terminal", arg: "ls", codeKey: "t|1", fold: { turn: "t1", tool: "terminal", row: 3 } });
  assert.equal(boxes(h), 1);
  assert.match(h, /<button type="button" class="fold-read" data-tool-fold="1"[^>]*data-fold-turn="t1"[^>]*data-fold-tool="terminal" data-fold-row="3"/);
  assert.ok(h.indexOf("fold-read") > h.indexOf("</div></div>"), "the button follows the box rather than sitting in it");
});

test("only a tool's own output is boxed: a sentence, a call and the panel's notes never are", () => {
  const rows = [
    { kind: "text", text: "I will run the tests." },
    { kind: "tool", text: "💻 terminal · npm test" },
    { kind: "dim", text: "⇢ asked to work in somewhere" },
    { kind: "raw", text: "error: something" },
    { kind: "tool-out", text: "  ↳ terminal · 1.0s" },
  ];
  const h = CF.bodyHtml(rows, { tool: "terminal", arg: "npm test" });
  assert.equal(boxes(h), 0);
  for (const r of rows) assert.ok(h.includes(`data-ltext="${r.text}"`));
});

test("a result of nothing but blank lines has nothing to put in a box", () => {
  const h = html(["", " ", ""], { tool: "terminal" });
  assert.equal(boxes(h), 0);
});

test("a diff is one box with its framed windows inside it, and the header says what it adds and removes", () => {
  const diff = [
    "--- a/C:\\p\\q\\r\\package.json",
    "+++ b/C:\\p\\q\\r\\package.json",
    "@@ -1,4 +1,5 @@",
    " {",
    '-  "a": 1,',
    '+  "a": 2,',
    '+  "b": 3,',
    " }",
    "@@ -20,3 +21,3 @@",
    " keep",
    "-gone",
    "+came",
  ];
  const h = html(diff, { tool: "patch", arg: "C:/p/q/r/package.json" });
  assert.equal(boxes(h), 1, "one box for the whole result, not one per hunk");
  assert.match(h, /code-box is-diff/);
  assert.equal(count(h, /class="df-win"/g), 2, "a window per hunk, still");
  assert.equal(folded(h), 1);
  const inside = h.slice(h.indexOf('<div class="code-body"'));
  assert.equal(count(inside, /class="df-win"/g), 2, "every window is inside the box's body");
  assert.match(h, /<span class="code-what">patch · …\/q\/r\/package\.json<\/span>/);
  assert.match(h, /<span class="is-add">\+3<\/span><span class="is-del">−2<\/span>/, "two modifications and one addition: +3 −2");
});

test("a diff that creates a file is named by the new side, never by /dev/null", () => {
  const h = html(["--- /dev/null", "+++ b/lib/new.js", "@@ -0,0 +1,2 @@", "+one", "+two"], { tool: "write_file", arg: "lib/new.js" });
  assert.match(h, /<span class="code-what">write_file · lib\/new\.js<\/span>/);
  assert.match(h, /<span class="is-add">\+2<\/span><span class="is-del">−0<\/span>/);
});

test("a hunk the preview cut keeps its cut row inside the window, inside the box", () => {
  const h = html(["--- a/x", "+++ b/x", "@@ -1,2 +1,9 @@", " keep", "… result truncated by the gateway — the live stream carries a preview of a tool result, not all of it"], { tool: "patch", arg: "x" });
  assert.equal(boxes(h), 1);
  assert.equal(count(h, /df-cut/g) >= 1, true);
  assert.ok(h.indexOf("df-cut") > h.indexOf('<div class="code-body"'), "the cut row is in the box");
});

test("the reader's open boxes come from the caller's set, keyed by the run's first row — which does not move while it grows", () => {
  const key = (rows, opts) => (html(rows, opts).match(/data-code-key="([^"]*)"/) || [])[1];
  const opts = { tool: "terminal", arg: "ls", codeKey: "turn|anchor|0" };
  assert.equal(key(["a"], opts), "turn|anchor|0|0");
  assert.equal(key(["a", "b"], opts), "turn|anchor|0|0", "the same key with one more line");
  assert.equal(key(["a", "b", "c", "d"], opts), "turn|anchor|0|0");

  const seen = new Set(["turn|anchor|0|0"]);
  const h = html(["a", "b"], { ...opts, codeOpen: seen });
  assert.equal(opened(h), 1, "a key the reader opened is drawn open");
  assert.match(h, /code-box is-out is-open/);
  assert.match(h, /aria-expanded="true"/);
  assert.match(h, /<span class="code-caret">▾<\/span>/);
  assert.match(h, /<span class="code-hint">click to fold<\/span>/);
  assert.equal(folded(html(["a", "b"], { ...opts, codeOpen: new Set(["some|other|key"]) })), 1, "any other key stays folded");
});

test("a result that is a header, a diff and a summary is still ONE box", () => {
  // What `git show` hands the console: the commit's own lines, then the diff, then the summary. A diff run used to
  // end the box, so this arrived as a "terminal output" box and a second "terminal · file" box for the one call.
  const rows = [
    "commit 1a2b3c4 — tidy the console",
    "Author: Jake Roper",
    "--- a/public/style.css",
    "+++ b/public/style.css",
    "@@ -1,2 +1,2 @@",
    "-  old rule",
    "+  new rule",
    " 1 file changed, 1 insertion(+), 1 deletion(-)",
  ];
  const h = html(rows, { tool: "terminal", arg: "git show HEAD" });
  assert.equal(boxes(h), 1, "one box for the call, not a header box and a diff box");
  assert.match(h, /code-box is-diff/);
  assert.match(h, /<span class="code-what">terminal · public\/style\.css<\/span>/, "the box is named by the file the diff changes");
  assert.match(h, /<span class="is-add">\+1<\/span><span class="is-del">−1<\/span>/, "and it still says what the change adds and removes");
  assert.equal(count(h, /class="df-win"/g), 1, "the diff keeps its framed window, inside the box");
  assert.equal(folded(h), 1);
  const inside = h.slice(h.indexOf('<div class="code-body"'));
  for (const line of rows) assert.ok(inside.includes(`data-ltext="${line.replace(/"/g, "&quot;")}"`), `${line} is inside the box`);
});

test("a diff followed by a plain line the diff does not own is one box, in the order it arrived", () => {
  const rows = ["--- a/x", "+++ b/x", "@@ -1,1 +1,1 @@", "-old", "+new", "3 files changed"];
  const h = html(rows, { tool: "terminal", arg: "git diff HEAD~1" });
  assert.equal(boxes(h), 1);
  const body = h.slice(h.indexOf('<div class="code-body"'));
  assert.ok(body.indexOf("data-ltext=\"3 files changed\"") > body.indexOf("df-win"), "the summary comes after the window, not in a box of its own");
});

test("a second result's header still ends the box: a ↳ line splits two calls", () => {
  const h = CF.bodyHtml(out(["one", "↳ terminal", "two"]), { tool: "terminal", arg: "x", codeKey: "k" });
  assert.equal(boxes(h), 2);
  assert.deepEqual([...h.matchAll(/data-code-key="([^"]*)"/g)].map((m) => m[1]), ["k|0", "k|2"]);
  assert.ok(h.includes('data-ltext="↳ terminal"'), "the header is a console line, outside both boxes");
});

test("two results in one list are two boxes with two keys", () => {
  const rows = ["one", "two", "… 5 lines hidden — click to read", "three"];
  const h = CF.bodyHtml(out(rows), { tool: "terminal", arg: "x", codeKey: "k" });
  assert.equal(boxes(h), 2);
  assert.deepEqual([...h.matchAll(/data-code-key="([^"]*)"/g)].map((m) => m[1]), ["k|0", "k|3"]);
});

test("a box the reader asked for is drawn open, and the page knows which book to write the click in", () => {
  const shut = new Set();
  const readOpen = { openByDefault: true, has: (k) => !shut.has(k) };
  const h = html(["a", "b"], { tool: "terminal", arg: "x", codeKey: "w", whole: true, codeOpen: readOpen });
  assert.equal(opened(h), 1);
  assert.match(h, /data-code-inverted="1"/);
  assert.match(h, /<span class="code-what">terminal output · full result<\/span>/);
  shut.add("w|0");
  assert.equal(folded(html(["a", "b"], { tool: "terminal", arg: "x", codeKey: "w", whole: true, codeOpen: readOpen })), 1, "shut by the reader, it stays shut");
  assert.ok(!/data-code-inverted/.test(html(["a"], { tool: "terminal" })), "an ordinary box is not inverted");
});

test("the classifier itself is unchanged: ordinary output is still not a diff", () => {
  // (the array is built inside the vm, so compare its contents, not its prototype)
  assert.deepEqual([...CF.lineClasses(out(TERMINAL))], ["plain", "plain", "plain"]);
});

test("a line still being written is drawn up to what may be shown, and the console line keeps the whole of it", () => {
  const rows = [
    { kind: "tool-out", text: "  ↳ skill_view · 0.1s", lid: 1 },
    { kind: "tool-out", text: "alpha beta gamma delta", lid: 2 },
    { kind: "tool-out", text: "epsilon zeta", lid: 3 },
  ];
  const typing = new Map([["2", "alpha beta"], ["3", ""]]);
  CF.setShownFor((row) => (row.lid != null && typing.has(String(row.lid)) ? typing.get(String(row.lid)) : null));
  try {
    const h = CF.bodyHtml(rows, { tool: "skill_view", arg: "x" });
    assert.match(h, /data-ltext="alpha beta gamma delta" data-lkind="tool-out" data-lid="2">alpha beta<\/div>/);
    assert.match(h, /data-ltext="epsilon zeta" data-lkind="tool-out" data-lid="3"><\/div>/, "a line the clock has not reached yet is empty but present");
    assert.match(h, /data-ltext="  ↳ skill_view · 0\.1s"[^>]*>  ↳ skill_view · 0\.1s<\/div>/, "the header is not paced");
  } finally {
    CF.setShownFor(null);
  }
  const whole = CF.bodyHtml(rows, { tool: "skill_view", arg: "x" });
  assert.match(whole, />alpha beta gamma delta<\/div>/, "with no hook every row is whole");
});
