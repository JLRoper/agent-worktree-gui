// The assistant search's matcher, on its own: public/core/turn-search.js, the file the page loads and
// lib/assistant/search.js imports.
//
// WHY IT IS TESTED THIS WAY. The matcher is the one piece of the search a reader can break with a keystroke, and
// the two breakages that matter are both about what a character MEANS:
//
//   * `[` (and `(`, `*` in a literal sense, `\`) used to be compiled raw with `new RegExp(query)`, and a bare `[`
//     throws `Unterminated character class` - a 500 on the server and an exception in the page. The zero case below
//     is the proof that a query for a bracket is a search for a bracket.
//   * `.` compiled raw matches ANY character, so a query for `public.app` would answer text it does not contain.
//     The dot case proves it is a literal dot and nothing else.
//
// A query with no wildcard must be a plain substring - that falls out of escaping every character, and it is
// pinned here so a later "optimization" cannot turn `a.b` into a pattern.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import "../public/core/turn-search.js";

const { compile, firstMatch, matches, excerpt } = globalThis.wtTurnSearch;

test("a blank query is no search at all, not a match-everything", () => {
  assert.equal(compile(""), null);
  assert.equal(compile("   "), null);
  assert.equal(compile(null), null);
  assert.equal(matches("anything", null), false);
});

test("a query with no wildcard is a plain substring, case-insensitively", () => {
  const c = compile("Sweeps Pill");
  assert.equal(c.wildcard, false);
  assert.equal(matches("the sweeps pill went quiet", c), true);
  assert.equal(matches("the SWEEPS PILL is fine", c), true);
  assert.equal(matches("the sweeps pills", c), true);
  assert.equal(matches("the sweep pill", c), false);
});

test("* is any run of characters, including none, and ? is exactly one", () => {
  const star = compile("app*js");
  assert.equal(star.wildcard, true);
  assert.equal(matches("public/app.js", star), true);
  assert.equal(matches("public/app.min.js", star), true);
  assert.equal(matches("public/appjs", star), true);
  assert.equal(matches("public/app.css", star), false);
  assert.equal(matches("app js", compile("app* js")), true);

  const one = compile("t?rn");
  assert.equal(one.wildcard, true);
  assert.equal(matches("turn", one), true);
  assert.equal(matches("tern", one), true);
  assert.equal(matches("trn", one), false);
  assert.equal(matches("turrn", one), false);

  // Case does not matter for the wildcards either.
  assert.equal(matches("TURN", one), true);
});

test("a bracket and a dot are literals: zero when the text holds neither, never an exception", () => {
  // The store searched here has no bracket and no dot in the fields the query reads. Raw compilation would throw on
  // the bracket and answer the dot with everything; an escaped query answers zero for both.
  const text = "hello there, hi";
  for (const query of ["[", "]", ".", "(", ")", "{", "}", "|", "^", "$", "\\", "+"]) {
    const c = compile(query);
    assert.ok(c, `compile(${JSON.stringify(query)}) answered null`);
    assert.equal(c.wildcard, false, `${query} is not a wildcard`);
    assert.equal(matches(text, c), false, `${JSON.stringify(query)} matched text that does not hold it`);
  }
  // And they are LITERALS where the text does hold them: the same bracket finds the same bracket.
  assert.equal(matches("fix public/app.js [draft]", compile("[")), true);
  assert.equal(matches("fix public/app.js [draft]", compile("]")), true);
  assert.equal(matches("done. see public/app.js", compile(".")), true);
  assert.equal(matches("doneX see publicYappZjs", compile(".")), false);
  assert.equal(matches("a dot . and a bracket [", compile(".")), true);
  // A query mixing a literal metacharacter with a wildcard escapes only the literal.
  assert.equal(matches("public/app.js", compile("public/*.js")), true);
  assert.equal(matches("public/appXjs", compile("public/*.js")), false);
});

test("a query of metacharacters alone never throws, whatever it is", () => {
  // Every one of these is a fragment a reader can type by accident; compiled raw, several are invalid patterns.
  const nasty = ["[[[", "((((", "***", "???", "\\", "[]", "[^", "a{2,", "|*|", "$(", "?*?*"];
  for (const query of nasty) {
    assert.doesNotThrow(() => {
      const c = compile(query);
      if (c) matches("some ordinary turn text", c);
    }, `${JSON.stringify(query)} threw while compiling or matching`);
  }
});

test("firstMatch reports the index and length of what matched", () => {
  const m = firstMatch("open public/app.js now", compile("app*js"));
  assert.equal(m.index, "open public/".length);
  assert.equal(m.match, "app.js");
  assert.equal(firstMatch("nothing here", compile("app")), null);
});

test("excerpt cuts a window around the match and says where it cut", () => {
  const text = "a".repeat(200) + " the sweeps pill " + "b".repeat(200);
  const ex = excerpt(text, compile("sweeps pill"), { before: 10, after: 12 });
  assert.equal(ex.lead, true);
  assert.equal(ex.tail, true);
  assert.equal(ex.hit, "sweeps pill");
  // The pieces keep their edge spaces, so putting them back together still reads as the original line.
  assert.equal(ex.before.trimEnd().endsWith(" the"), true);
  assert.equal(`${ex.before}${ex.hit}${ex.after}`, "aaaaa the sweeps pill bbbbbbbbbbb");
  assert.equal(ex.after.trim(), "b".repeat(11), "the window after the hit is bounded");
  assert.ok(ex.before.length <= 10, "the window before the hit is bounded");
  // A match at the very start says so by not claiming a lead.
  const head = excerpt("sweeps pill and more", compile("sweeps"), { before: 10, after: 4 });
  assert.equal(head.lead, false);
  assert.equal(head.hit, "sweeps");
  // No match at all is the head of the text, not a throw.
  const none = excerpt("nothing to see", compile("zebra"));
  assert.equal(none.matched, false);
  assert.equal(none.hit, "");
});

test("the page loads this exact file before the script that reads it", () => {
  // One implementation, or a hit means one thing in the count and another on the page: index.html must load
  // /core/turn-search.js, and it must load it before /assistant.js, whose box calls wtTurnSearch.compile.
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const matcher = html.indexOf("/core/turn-search.js");
  const reader = html.indexOf('src="/assistant.js"');
  assert.ok(matcher > 0, "index.html does not load /core/turn-search.js");
  assert.ok(reader > 0, "index.html does not load /assistant.js");
  assert.ok(matcher < reader, "the matcher is loaded after the script that reads it");
});
