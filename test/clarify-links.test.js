// A clarify question's `links` field: the shape the card can draw, out of the shape a gateway sends.
//
// The field is somebody else's envelope. It arrives absent (every worker that has not been told about it), as a
// string, as an object, as a `file:///` URL where a path was meant, with a refused scheme, or with twelve entries when
// a card has room for four. lib/clarify-links.js is the one place that shape is known, so every one of those has a
// test here - and none of them may throw, because this runs inside a run's event handler where an exception would cost
// the turn its stream.
import assert from "node:assert/strict";
import test from "node:test";
import { labelFor, linkOf, linksOf, linkLine, MAX_LINKS, pathFromFileUrl } from "../lib/clarify-links.js";

test("no field at all is an empty list, not a throw", () => {
  assert.deepEqual(linksOf(undefined), []);
  assert.deepEqual(linksOf(null), []);
  assert.deepEqual(linksOf(""), []);
  assert.deepEqual(linksOf([]), []);
  assert.deepEqual(linksOf({}), []);
});

test("a string entry is a target with a generated label", () => {
  const [link] = linksOf("C:/ProjectDevelopment/agent-worktree-gui/docs/reports/x.html");
  assert.equal(link.kind, "file");
  assert.equal(link.target, "C:/ProjectDevelopment/agent-worktree-gui/docs/reports/x.html");
  assert.equal(link.label, "x.html");
});

test("an absolute URL is a url link, and the label is the host and the last segment", () => {
  const [link] = linksOf({ url: "https://example.test/run/7" });
  assert.equal(link.kind, "url");
  assert.equal(link.target, "https://example.test/run/7");
  assert.equal(link.label, "example.test/7");
});

test("a label is kept when the caller gives one", () => {
  const [link] = linksOf({ label: "the report", path: "docs/reports/x.html" });
  assert.equal(link.label, "the report");
  assert.equal(link.kind, "file");
  assert.equal(link.target, "docs/reports/x.html");
});

test("`href`, `file` and `target` are read as the target too", () => {
  assert.equal(linksOf({ href: "https://a.test/x" })[0].kind, "url");
  assert.equal(linksOf({ file: "C:/x/y.png" })[0].kind, "file");
  assert.equal(linksOf({ target: "C:/x/y.png" })[0].kind, "file");
});

test("a file:/// URL becomes a path, drive letter and all", () => {
  assert.equal(pathFromFileUrl("file:///C:/x/y.html"), "C:/x/y.html");
  assert.equal(pathFromFileUrl("file:///home/roper/y.html"), "/home/roper/y.html");
  // A `file:` URL is a file however it was spelled, so the card opens it through the same ladder.
  const [link] = linksOf({ label: "report", url: "file:///C:/ProjectDevelopment/x/report.html" });
  assert.equal(link.kind, "file");
  assert.equal(link.target, "C:/ProjectDevelopment/x/report.html");
  assert.equal(link.label, "report");
});

test("a refused scheme is dropped, and the entry after it still draws", () => {
  const out = linksOf([{ url: "javascript:alert(1)" }, { url: "https://ok.test/x" }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].target, "https://ok.test/x");
  assert.equal(linksOf([{ url: "data:text/html,<b>x" }]).length, 0);
});

test("a link with no target is dropped rather than drawn as an empty anchor", () => {
  assert.deepEqual(linksOf({ label: "nowhere" }), []);
  assert.deepEqual(linksOf([{ label: "nowhere" }, null, 7]), []);
});

test("the cap keeps the first entries and the refusals do not eat a slot", () => {
  const many = Array.from({ length: MAX_LINKS + 4 }, (_, i) => ({ label: `l${i}`, url: `https://x.test/${i}` }));
  const out = linksOf([{ url: "javascript:1" }, ...many]);
  assert.equal(out.length, MAX_LINKS);
  assert.equal(out[0].target, "https://x.test/0");
});

test("a single link object is accepted where an array is expected", () => {
  const out = linksOf({ label: "one", url: "https://one.test/a" });
  assert.equal(out.length, 1);
  assert.equal(out[0].label, "one");
});

test("indices are the position in the RESULT, so the page and a test name the same link", () => {
  const out = linksOf([{ url: "javascript:1" }, { url: "https://two.test/a" }, { path: "C:/x/y.html" }]);
  assert.deepEqual(out.map((l) => l.index), [0, 1]);
});

test("an over-long target is refused, because no card can draw one", () => {
  assert.equal(linkOf({ url: `https://x.test/${"a".repeat(1000)}` }), null);
});

test("a relative path with no scheme stays a file, and keeps its slash shape", () => {
  const [link] = linksOf({ label: "the diff", path: "docs/reports/diff.txt" });
  assert.equal(link.kind, "file");
  assert.equal(link.target, "docs/reports/diff.txt");
});

test("a label with markup in it is the caller's string, not markup to trust", () => {
  // The card escapes it at render time; this module's job is only to not turn it into something else.
  const [link] = linksOf({ label: "<img src=x onerror=1>", url: "https://x.test/a" });
  assert.equal(link.label, "<img src=x onerror=1>");
});

test("labelFor never returns an empty label", () => {
  assert.equal(labelFor("https://example.test", "url"), "example.test");
  assert.equal(labelFor("docs/x.html", "file"), "x.html");
  assert.equal(labelFor("", "file"), "");
});

test("linkLine names a link the way the room message does", () => {
  assert.equal(linkLine({ label: "the report", target: "C:/x/y.html" }), "the report - C:/x/y.html");
  assert.equal(linkLine(null), "");
});
