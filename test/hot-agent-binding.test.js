// Ctrl+Shift+Q is free: this is the static half of that proof, and it is a TEST rather than a paragraph because the
// claim decays - a later feature can bind the chord and nothing would notice.
//
// WHAT IS SCANNED. Every .js, .mjs and .html under public/ and lib/, plus the page's own roots, minus the vendored
// bundles: public/pipeline-map.html is a single-file cytoscape/mermaid build (a separate page, not the panel), and
// nothing in it can answer a press on the panel's page. The scan is not a grep for the letter q: it looks at the
// lines that COMPARE a key to q/Q/KeyQ/81, takes the handler window around each, and asks whether a modifier test is
// in that window. That is what distinguishes "the app binds Ctrl+Shift+Q" from "the app mentions q in a comment".
//
// THE ANSWER the brief asks for:
//   * exactly ONE chording handler mentions q: public/assistant.js's window keydown, which owns BOTH chords;
//   * the plain chord (Ctrl+Q) carries `!e.shiftKey`, so a held Shift cannot reach it: one press cannot be answered
//     by two bars;
//   * the shifted chord carries `!e.altKey && !e.metaKey`, so Ctrl+Alt+Q and Ctrl+Shift+Cmd+Q stay out of it;
//   * lib/ binds no keys at all: the server never sees a keydown;
//   * no element in the panel declares accesskey="q".
//
// The other half is a real press in a real page: tools/verify-hot-agent-search.mjs drives Ctrl+Shift+Q in headless
// Chromium and asserts the list opens with the box focused, which is the end-to-end proof this file supports.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

// A vendored build is not the app's own key handling. Named individually so the exemption is a decision, not a glob
// that later hides a real handler.
const VENDORED = new Set(["public/pipeline-map.html"]);

function walk(dir, out = []) {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    const full = join(ROOT, rel);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === ".git") continue;
      walk(rel, out);
    } else if (/\.(js|mjs|html)$/.test(name) && !VENDORED.has(rel)) {
      out.push(rel);
    }
  }
  return out;
}

// A key comparison: `"q"`, `'Q'`, `KeyQ`, or the legacy keyCode.
const KEY_Q = /(?:["']q["']|["']Q["']|["']KeyQ["']|keyCode\s*===?\s*81|which\s*===?\s*81)/;
// How many parentheses a snippet has open, so a condition that spans lines can be read as one string.
function depth(text) {
  let n = 0;
  for (const ch of text) {
    if (ch === "(") n += 1;
    else if (ch === ")") n -= 1;
  }
  return n;
}

function qSites() {
  const sites = [];
  for (const rel of walk("public")) {
    const lines = readFileSync(join(ROOT, rel), "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (!KEY_Q.test(lines[i])) continue;
      // A comment is not a handler. A line whose first non-space is // or * is prose about a key.
      const trimmed = lines[i].trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      // The CONDITION this comparison belongs to: start at its line and keep reading until the parentheses balance,
      // which is the `if (...)` a multi-line chord test spans. Asking the window instead would let the plain chord see
      // the shifted one two lines above it and call itself shifted - a false pass for exactly the collision this file
      // exists to catch.
      let condition = lines[i];
      for (let j = i, guard = 0; guard < 6 && depth(condition) > 0 && j + 1 < lines.length; guard += 1) {
        j += 1;
        condition += "\n" + lines[j];
      }
      const code = condition
        .split(/\r?\n/)
        .filter((line) => {
          const t = line.trim();
          return !t.startsWith("//") && !t.startsWith("*");
        })
        .join("\n");
      sites.push({
        file: rel,
        line: i + 1,
        text: trimmed,
        condition: code.trim(),
        chording: /ctrlKey|metaKey/.test(code),
        // A chord REQUIRES Shift when it mentions shiftKey positively. `!e.shiftKey` is the plain chord REFUSING a
        // shifted press, which is the opposite of requiring one - reading both as "shifted" is exactly how a
        // collision between the two chords would be missed.
        shift: condition.includes("shiftKey") && !condition.includes("!e.shiftKey"),
        alt: /altKey/.test(code),
      });
    }
  }
  return sites;
}

test("no key handler in public/ binds a bare q or a shifted-only q", () => {
  const sites = qSites();
  assert.ok(sites.length >= 2, `the two chords are expected to be found (found ${sites.length} q sites)`);
  for (const site of sites) {
    const where = `${site.file}:${site.line}`;
    // Every q site is either part of a chord that tests ctrl/meta, or the comment-free body of one (the `return` and
    // the call inside the branch). A bare `if (e.key === "q")` with no modifier test would be the defect.
    assert.ok(
      site.chording || /openHotSearch|focusSearch|closeSearch|runSearch|e\.preventDefault/.test(site.text),
      `${where} compares q but is neither a chord nor the body of one: ${site.text}`,
    );
  }
});

test("exactly two chords mention q: Ctrl+Q and Ctrl+Shift+Q, in one handler", () => {
  const chords = qSites().filter((site) => site.chording);
  const owners = [...new Set(chords.map((site) => site.file))];
  assert.deepEqual(owners, ["public/assistant.js"], "one file owns every q chord");
  const plain = chords.filter((site) => !site.shift);
  const shifted = chords.filter((site) => site.shift);
  assert.equal(plain.length, 1, "one plain chord: the turn search's Ctrl+Q");
  assert.equal(shifted.length, 1, "one shifted chord: the Hot Agent search's Ctrl+Shift+Q");
  assert.ok(plain[0].line < shifted[0].line + 40, "both live in the same window keydown handler");
});

test("the plain chord refuses Shift, so a press cannot reach both bars", () => {
  const js = readFileSync(join(ROOT, "public/assistant.js"), "utf8");
  const shiftedFirst = js.slice(js.indexOf("if (!e.repeat && e.ctrlKey && e.shiftKey"));
  // The Hot Agent branch comes first and returns, and it demands Shift.
  assert.match(shiftedFirst, /if \(!e\.repeat && e\.ctrlKey && e\.shiftKey && !e\.altKey && !e\.metaKey/);
  const called = shiftedFirst.slice(0, 700);
  assert.ok(called.includes("openHotSearch();"), "the shifted branch opens the Hot Agent search");
  assert.ok(
    called.indexOf("openHotSearch();") < called.indexOf("return;"),
    "and returns, so the press never reaches the plain chord below it",
  );
  // The turn search's branch then refuses every shifted press - not merely "ignores" it.
  const turnBranch = js.slice(js.indexOf("Ctrl+Q is the search box's own key"));
  assert.match(turnBranch, /e\.ctrlKey && !e\.altKey && !e\.metaKey && !e\.shiftKey/);
  // Both chords live in the ONE window keydown listener, so there is no second listener that could answer first.
  const listener = js.indexOf('window.addEventListener("keydown"');
  assert.ok(listener > 0, "the panel has a window keydown listener");
  assert.ok(js.indexOf("if (!e.repeat && e.ctrlKey && e.shiftKey") > listener, "the Hot Agent chord is inside it");
  assert.ok(js.indexOf("Ctrl+Q is the search box's own key") > listener, "so is the turn search's");
});

test("the server binds no keys: q is a page concern only", () => {
  for (const rel of walk("lib")) {
    const text = readFileSync(join(ROOT, rel), "utf8");
    assert.equal(KEY_Q.test(text), false, `${rel} reads a q key, which the server never receives`);
  }
});

test("no element in the panel claims accesskey=q", () => {
  for (const rel of walk("public")) {
    if (!rel.endsWith(".html")) continue;
    const html = readFileSync(join(ROOT, rel), "utf8");
    assert.doesNotMatch(html, /accesskey\s*=\s*["']q["']/i, `${rel} declares accesskey=q, which a browser answers itself`);
  }
});

test("the exemption list is a decision, and it is short", () => {
  assert.deepEqual([...VENDORED], ["public/pipeline-map.html"]);
  // The exempted file is a vendored build: if it ever stops being one, the exemption has to be revisited.
  const big = readFileSync(join(ROOT, "public/pipeline-map.html"), "utf8");
  assert.ok(big.length > 500_000, "pipeline-map.html is the single-file vendored build this exemption exists for");
});
