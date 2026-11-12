// turn-search.js - one matcher for the assistant's turn search: the box, the result row and the mark inside the
// turn all compile a query HERE, so a hit cannot mean one thing in the count and another on the page.
//
// THE RULES, once:
//
//   *  `*` is any run of characters (including none) and `?` is exactly one; both are wildcards anywhere in the
//      query, and matching is case-insensitive.
//   *  A query with NO wildcard is a plain substring - which falls out of the rule below, because every literal
//      character is escaped and an escaped literal is the substring search.
//   *  Every regular-expression metacharacter is ESCAPED before the pattern is compiled. This is the whole reason
//      the module exists: a reader who searches for `[` is looking for a bracket, and compiling the raw query
//      throws `Unterminated character class` on the server and the page alike. `[` and `.` are literals here.
//
// Published on globalThis as `wtTurnSearch`, loaded as a classic script by public/index.html (before assistant.js)
// and imported by lib/assistant/search.js, the same load contract public/core/steerable.js has.
(function (root) {
  "use strict";

  // The characters that mean syntax inside a RegExp built from a string. `-` and `/` are not among them: nothing
  // below ever puts a literal inside a character class, and the constructor form needs no escaping for `/`.
  const META = new Set([".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);

  // Compile one query. A blank query is null - "search for nothing" is the absence of a search, not a match-all.
  // The returned object is what every caller passes around: { text, source, wildcard, re }.
  function compile(query) {
    const text = String(query == null ? "" : query).trim();
    if (!text) return null;
    let source = "";
    let wildcard = false;
    // Character by character, so a wildcard is a wildcard and every other character is a LITERAL: there is no
    // second pass that could forget to escape one, and no way for a `*` inside a literal run to survive.
    for (const ch of text) {
      if (ch === "*") {
        source += "[\\s\\S]*";
        wildcard = true;
      } else if (ch === "?") {
        source += "[\\s\\S]";
        wildcard = true;
      } else {
        source += META.has(ch) ? `\\${ch}` : ch;
      }
    }
    return { text, source, wildcard, re: new RegExp(source, "i") };
  }

  // The first match in a text, or null. The regex carries no `g` flag, so `.exec` keeps no lastIndex between calls
  // and the same compiled query can be asked about a thousand lines without a state bug.
  function firstMatch(text, compiled) {
    if (!compiled || !compiled.re) return null;
    const m = compiled.re.exec(String(text == null ? "" : text));
    if (!m) return null;
    return { index: m.index, length: m[0].length, match: m[0] };
  }

  const matches = (text, compiled) => Boolean(firstMatch(text, compiled));

  // Whitespace collapsed to one space: a console line and a prompt both arrive with newlines in them, and a result
  // row is one line. Squashing is display-only - every match was decided on the ORIGINAL text. `norm` keeps the
  // spaces at the edges, which matters: a window split as `before`/`hit`/`after` that trimmed them would print
  // "Write thePDL" instead of "Write the PDL" once the pieces were put back together.
  const squash = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ");

  // A one-line window around the first match: what the result row prints. `before`/`hit`/`after` are separate so
  // the row can wrap `hit` in a mark without trusting an offset into text it just re-escaped. `lead`/`tail` say
  // whether text was cut off on that side, so the row can print the ellipsis honestly.
  function excerpt(text, compiled, { before = 42, after = 90, hitMax = 120 } = {}) {
    const raw = String(text == null ? "" : text);
    const m = firstMatch(raw, compiled);
    if (!m) return { before: squash(raw.slice(0, before + after)), hit: "", after: "", lead: false, tail: raw.length > before + after, matched: false };
    const start = Math.max(0, m.index - before);
    const end = Math.min(raw.length, m.index + m.length + after);
    return {
      before: norm(raw.slice(start, m.index)),
      // A wildcard can span a whole paragraph; the row wants the start of it, not all of it.
      hit: norm(raw.slice(m.index, m.index + Math.min(m.length, hitMax))),
      after: norm(raw.slice(m.index + m.length, end)),
      lead: start > 0,
      tail: end < raw.length,
      matched: m.length > 0,
    };
  }

  root.wtTurnSearch = { compile, firstMatch, matches, excerpt, squash };
})(globalThis);
