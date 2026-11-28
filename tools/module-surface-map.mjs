#!/usr/bin/env node
// HARNESS: RESEARCH - node tools/module-surface-map.mjs maps every public/ front-end module to the
// stylesheet (the CSS surface) that owns the rules matching the class tokens the module emits, and
// names the modules that span more than one surface. It moves no code: it reads public/*.js,
// public/board/*.js, public/core/*.js, public/index.html and every sheet public/index.html links, and
// prints the numbers the report docs/reports/module-surface-seams-2026-11-28.html quotes.
//
// The method, in one paragraph. A module's DOM is found by the class tokens its source writes: class="..."
// literals, classList add/remove/toggle, className assignments and setAttribute("class", ...). Comments are
// stripped first, so a class named in a header comment is not counted as drawn. A token written by exactly
// ONE producer is that producer's private token; a rule is that producer's rule when one of its selector
// entries names a private token. The sheet with the most private rules is the module's OWNER; every other
// sheet with at least one private rule is a surface the module SPANS. Dynamic class names (`is-${x}`) cannot
// be resolved statically and are counted, not guessed.
//
//   node tools/module-surface-map.mjs                 tables on stdout
//   node tools/module-surface-map.mjs --json <path>   also write the numbers as JSON
//   node tools/module-surface-map.mjs --min-lines 200 only rows at or above this size
//
// Exit: 0 the measurement ran; any exception (a sheet index.html links but public/ does not hold, a
// file that cannot be read) exits 1 with the error, never with a partial number that looks whole.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { styleSheetFiles } from "./style-sheets.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const OUT = opt("--json");
const MIN_LINES = Number(opt("--min-lines", "0")) || 0;
const num = (v) => (typeof v === "number" ? v.toLocaleString("en-US") : v);
const pct = (v) => `${(v * 100).toFixed(1)}%`;

// ---------------------------------------------------------------------------------------------
// The surface each sheet owns, as the sheet's own header states it
// ---------------------------------------------------------------------------------------------
export const SURFACE = {
  "base.css": "tokens and resets",
  "chrome.css": "header and status strip",
  "settings.css": "Settings drawer and its dialogs",
  "board-table.css": "the board table: boxes, rows, cells, chips, agent cards",
  "console.css": "the console card: frame, output body, reply composer",
  "console-head.css": "the console head and its controls",
  "console-turns.css": "the console's turn rows and their readouts",
  "model-menu.css": "the model picker popup",
  "overlays.css": "deliverables, pasted chips, approval and question cards, ghost turns",
  "utilities.css": "the shared type and status utilities (.mono, .dim, .name, ...)",
  "assistant.css": "the assistant entry, spawn strip and float shell",
  "feedback.css": "the header's Clarify, Collisions and Permissions popovers",
  "assistant-panes.css": "the assistant float's tabs, panes, search and settings",
  "initiatives.css": "the Initiatives tab",
  "panes.css": "the assistant's Worktrees and Bridge sub-tabs",
  "queue.css": "the queue cards and the assistant queue pane",
  "pipeline.css": "the pipeline window, messages and flow",
  "chart.css": "the worktree chart's age column and legend",
  "core/pipeline-card.css": "one mermaid pipeline card",
  "core/task-card.css": "the queue card's compact mode",
};

// ---------------------------------------------------------------------------------------------
// A CSS reader that keeps the line each rule starts on
// ---------------------------------------------------------------------------------------------
const normSpace = (s) => String(s).replace(/\s+/g, " ").trim();

function splitTop(text, sep) {
  const out = [];
  let buf = "";
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      buf += ch;
      if (ch === "\\") { buf += text[i + 1] || ""; i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === "(" || ch === "[") { depth += 1; buf += ch; continue; }
    if (ch === ")" || ch === "]") { depth = Math.max(0, depth - 1); buf += ch; continue; }
    if (ch === sep && depth === 0) { out.push(buf); buf = ""; continue; }
    buf += ch;
  }
  out.push(buf);
  return out;
}

function lineAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) if (text[i] === "\n") line += 1;
  return line;
}

function parseSheet(text, sheet) {
  const rules = [];
  const stack = [];
  let buf = "";
  let bufStart = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      buf += " ";
      continue;
    }
    if (ch === "{") {
      stack.push({ prelude: normSpace(buf), at: normSpace(buf).startsWith("@"), start: bufStart });
      buf = "";
      bufStart = i + 1;
      i += 1;
      continue;
    }
    if (ch === "}") {
      const top = stack.pop();
      if (top && !top.at) {
        const ctx = stack.filter((s) => s.prelude).map((s) => s.prelude);
        rules.push({
          sheet,
          line: lineAt(text, top.start),
          ctx,
          sel: normSpace(top.prelude),
          selectors: splitTop(normSpace(top.prelude), ",").map(normSpace).filter(Boolean),
          keyframe: ctx.some((c) => /^@(-[a-z]+-)?keyframes\b/i.test(c)),
        });
      }
      buf = "";
      bufStart = i + 1;
      i += 1;
      continue;
    }
    if (ch === ";" && (!stack.length || stack[stack.length - 1].at) && normSpace(buf).startsWith("@")) {
      buf = "";
      bufStart = i + 1;
      i += 1;
      continue;
    }
    if (ch !== "\n" && !buf.trim().length && ch !== " ") bufStart = i;
    buf += ch;
    i += 1;
  }
  return rules.map((r) => ({ ...r, tokens: classTokensOf(r.selectors.join(",")) }));
}

function classTokensOf(selectorText) {
  const set = new Set();
  for (const m of String(selectorText).matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g)) set.add(m[1]);
  return set;
}

// The STRUCTURAL token of one selector entry: the first class in it. `.subagents.is-done .sub-head`
// is a rule about .subagents; `.as-task.is-done` is a rule about .as-task. A rule is attributed by
// this token and not by every token in it, so a shared state modifier (`is-done`, `has-review`) on a
// second module's element cannot drag the rule into the second module's surface.
export function rootTokenOf(selector) {
  const m = String(selector).match(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------------------------
// A JS/HTML reader: the class tokens a producer WRITES, and the ones it READS
// ---------------------------------------------------------------------------------------------
function stripJsComments(text) {
  const out = [];
  let inBlock = false;
  for (const line of text.split(/\r?\n/)) {
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end < 0) { out.push(""); continue; }
      inBlock = false;
      out.push(" ".repeat(end + 2) + line.slice(end + 2));
      continue;
    }
    const t = line.trimStart();
    if (t.startsWith("//")) { out.push(""); continue; }
    if (t.startsWith("/*")) {
      const end = line.indexOf("*/", line.indexOf("/*") + 2);
      if (end < 0) { inBlock = true; out.push(""); continue; }
      out.push(" ".repeat(end + 2) + line.slice(end + 2));
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

const TOKEN_OK = /^[A-Za-z_][A-Za-z0-9_-]*$/;

// Walk one JS string or template literal starting at the opening quote. Returns the index just past
// its closing quote, and every literal chunk plus every ${...} expression it held. Template nesting
// is why this is a scanner and not a regex: `class="row ${open ? " is-open" : ""}"` is ONE attribute
// whose state token lives inside an expression.
function scanString(src, i, interpolate = false) {
  const q = src[i];
  const chunks = [];
  const exprs = [];
  let cur = "";
  i += 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") { cur += src[i + 1] || ""; i += 2; continue; }
    if (ch === q) { chunks.push(cur); return { end: i + 1, chunks, exprs }; }
    if ((q === "`" || interpolate) && ch === "$" && src[i + 1] === "{") {
      chunks.push(cur); cur = "";
      const r = scanExpr(src, i + 2);
      exprs.push(r.text);
      i = r.end + 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  chunks.push(cur);
  return { end: i, chunks, exprs };
}

// Walk a ${...} expression to its matching close brace, skipping the strings and nested templates
// inside it. `i` is the first character after `${`; `end` is the index OF the closing brace.
function scanExpr(src, i) {
  const start = i;
  let depth = 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === "`") { i = scanString(src, i).end; continue; }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { text: src.slice(start, i), end: i };
    }
    i += 1;
  }
  return { text: src.slice(start), end: src.length };
}

// Every string literal in a piece of source, including the ones inside a template expression.
export function stringsIn(src) {
  const out = [];
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const s = scanString(src, i);
      for (const c of s.chunks) out.push(c);
      for (const e of s.exprs) {
        const inner = stringsIn(e);
        out.push(inner);
      }
      i = s.end - 1;
    }
  }
  return out.flat(Infinity);
}

function tokensInList(list) {
  const out = [];
  for (const raw of String(list).split(/\s+/)) {
    // A token ending in "-" is the static half of an interpolated prefix (`jl-${kind}`), not a class.
    if (TOKEN_OK.test(raw) && !raw.endsWith("-")) out.push(raw);
  }
  return out;
}

// The value of one `class=`, `className =` or `setAttribute("class", ...)`: its literal chunks AND
// the strings its expressions choose between.
function classValueTokens(src, startIndex) {
  let i = startIndex;
  while (i < src.length && /\s/.test(src[i])) i += 1;
  if (src[i] === "\\") i += 1; // a `class=\"` inside a double-quoted string
  const q = src[i];
  if (q !== "'" && q !== '"' && q !== "`") return { tokens: [], dynamic: 0, exprs: [], end: i };
  const s = scanString(src, i, true);
  const pieces = [...s.chunks];
  for (const e of s.exprs) pieces.push(...stringsIn(e));
  return { tokens: pieces.flatMap(tokensInList), dynamic: s.exprs.length, exprs: s.exprs, end: s.end };
}

function parenArg(src, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === "`") { i = scanString(src, i).end - 1; continue; }
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return src.slice(openIndex + 1, i);
    }
  }
  return "";
}

export function readProducer(text, { html = false } = {}) {
  const src = html ? text : stripJsComments(text);
  const written = new Map(); // token -> first line
  let dynamic = 0;
  const add = (tokens, line) => {
    for (const tok of tokens) if (!written.has(tok)) written.set(tok, line);
  };
  // ONE level of local resolution: `const cls = \`badge ${...}\`` followed by `class="${cls}"` is
  // how a card builds its class list. Only a class-ish local name is resolved, so an ordinary
  // sentence in `const label = "Save changes"` is never read as two class tokens.
  const locals = new Map();
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g)) {
    if (!/(cls|class|klass)/i.test(m[1])) continue;
    const v = classValueTokens(src, m.index + m[0].length);
    if (v.tokens.length) locals.set(m[1], { tokens: v.tokens, line: lineAt(src, m.index) });
  }
  const addValue = (v, line) => {
    add(v.tokens, line);
    for (const e of v.exprs || []) {
      const name = String(e).trim();
      const local = locals.get(name);
      if (local) add(local.tokens, local.line);
    }
  };
  for (const m of src.matchAll(/class\s*=\s*/g)) {
    const v = classValueTokens(src, m.index + m[0].length);
    dynamic += v.dynamic;
    addValue(v, lineAt(src, m.index));
  }
  for (const m of src.matchAll(/className\s*=\s*/g)) {
    const v = classValueTokens(src, m.index + m[0].length);
    dynamic += v.dynamic;
    addValue(v, lineAt(src, m.index));
  }
  for (const m of src.matchAll(/classList\.(?:add|remove|toggle)\(/g)) {
    const open = m.index + m[0].length - 1;
    const arg = parenArg(src, open);
    const pieces = stringsIn(arg);
    dynamic += (arg.match(/\?/g) || []).length;
    add(pieces.flatMap(tokensInList), lineAt(src, m.index));
  }
  for (const m of src.matchAll(/setAttribute\(\s*["']class["']\s*,\s*/g)) {
    const v = classValueTokens(src, m.index + m[0].length);
    dynamic += v.dynamic;
    add(v.tokens, lineAt(src, m.index));
  }
  // What the producer READS: a query into another surface is a behavioural seam, not a style one.
  const read = new Set();
  if (!html) {
    for (const m of src.matchAll(/querySelector(?:All)?\(\s*(?:\\?["'`])([^"'`]*)/g)) {
      for (const tok of classTokensOf(m[1])) read.add(tok);
    }
    for (const m of src.matchAll(/classList\.contains\(\s*["'`]([^"'`]+)/g)) {
      for (const tok of tokensInList(m[1])) read.add(tok);
    }
  }
  return { written, dynamic, read };
}

// ---------------------------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------------------------
function jsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.isFile() && name.name.endsWith(".js")) out.push(path.join(dir, name.name));
  }
  return out;
}

function lineCount(text) {
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

export function measure(root = ROOT) {
  const files = [
    ...jsFiles(path.join(root, "public")),
    ...jsFiles(path.join(root, "public", "board")),
    ...jsFiles(path.join(root, "public", "core")),
  ].sort();

  const producers = files.map((full) => {
    const text = readFileSync(full, "utf8");
    const rel = path.relative(root, full).replace(/\\/g, "/");
    const info = readProducer(text);
    return { file: rel, lines: lineCount(text), src: stripJsComments(text), ...info };
  });

  const indexFile = path.join(root, "public", "index.html");
  if (existsSync(indexFile)) {
    const text = readFileSync(indexFile, "utf8");
    const info = readProducer(text, { html: true });
    producers.push({ file: "public/index.html", lines: lineCount(text), markup: true, src: text, ...info });
  }

  const sheets = styleSheetFiles({ root }).map((href) => {
    const text = readFileSync(path.join(root, "public", href), "utf8");
    const rules = parseSheet(text, href);
    return {
      sheet: href,
      surface: SURFACE[href] || "",
      lines: lineCount(text),
      rules: rules.filter((r) => !r.keyframe),
      keyframeSteps: rules.filter((r) => r.keyframe).length,
      selectors: rules.filter((r) => !r.keyframe).reduce((a, r) => a + r.selectors.length, 0),
    };
  });

  // token -> producers that write it
  const writers = new Map();
  for (const p of producers) {
    for (const tok of p.written.keys()) {
      if (!writers.has(tok)) writers.set(tok, new Set());
      writers.get(tok).add(p.file);
    }
  }
  const isPrivate = (tok, file) => (writers.get(tok)?.size || 0) === 1 && writers.get(tok).has(file);

  // The rule index. `binders` is every producer with a private token anywhere in the selector;
  // `owners` is narrower: the producers that own the selector entry's STRUCTURAL (first) class. A
  // rule is attributed by `owners`, so `.as-task.is-done` is the task card's rule even though the
  // `is-done` state token is written elsewhere.
  for (const s of sheets) {
    for (const r of s.rules) {
      r.owners = new Set();
      r.binders = new Set();
      r.roots = new Set();
      for (const sel of r.selectors) {
        const root = rootTokenOf(sel);
        if (!root) continue;
        r.roots.add(root);
        for (const file of writers.get(root) || []) if (isPrivate(root, file)) r.owners.add(file);
      }
      for (const tok of r.tokens) {
        for (const file of writers.get(tok) || []) if (isPrivate(tok, file)) r.binders.add(file);
      }
    }
  }

  // How many source lines a cut would touch: a line that names a class THIS producer alone writes
  // whose rule lives in sheet X. Shared tokens are excluded, so `mono` and `chip` do not make every
  // module look like it spans utilities.css and board-table.css.
  const rootToSheets = new Map();
  for (const s of sheets) {
    for (const r of s.rules) {
      for (const t of r.roots) {
        if (!rootToSheets.has(t)) rootToSheets.set(t, new Set());
        rootToSheets.get(t).add(s.sheet);
      }
    }
  }
  const lineHitsFor = (src, file) => {
    const hits = new Map();
    for (const line of src.split("\n")) {
      const seen = new Set();
      for (const m of line.matchAll(/[A-Za-z_][A-Za-z0-9_-]*/g)) {
        if (!isPrivate(m[0], file)) continue;
        const on = rootToSheets.get(m[0]);
        if (on) for (const sh of on) seen.add(sh);
      }
      for (const sh of seen) hits.set(sh, (hits.get(sh) || 0) + 1);
    }
    return hits;
  };

  const rows = producers.map((p) => {
    const lineHits = lineHitsFor(p.src, p.file);
    const privateTokens = [...p.written.keys()].filter((t) => isPrivate(t, p.file));
    const bySheet = new Map(); // sheet -> {private, all, samples[]}
    for (const s of sheets) {
      const entry = { private: 0, all: 0, samples: [] };
      for (const r of s.rules) {
        let touches = false;
        for (const tok of p.written.keys()) if (r.tokens.has(tok)) { touches = true; break; }
        if (!touches) continue;
        entry.all += 1;
        if (r.owners.has(p.file)) {
          entry.private += 1;
          if (entry.samples.length < 12) entry.samples.push({ sel: r.sel, line: r.line, sheet: s.sheet });
        }
      }
      if (entry.all || entry.private) bySheet.set(s.sheet, entry);
    }
    const ranked = [...bySheet.entries()].sort((a, b) => b[1].private - a[1].private || b[1].all - a[1].all || sheets.findIndex((s) => s.sheet === a[0]) - sheets.findIndex((s) => s.sheet === b[0]));
    const owner = ranked[0] ? ranked[0][0] : null;
    const ownerEntry = owner ? bySheet.get(owner) : null;
    const totalPrivate = [...bySheet.values()].reduce((a, e) => a + e.private, 0);
    const totalAll = [...bySheet.values()].reduce((a, e) => a + e.all, 0);
    const spans = ranked
      .filter(([sheet, e]) => sheet !== owner && e.private > 0)
      .map(([sheet, e]) => ({ sheet, private: e.private, all: e.all, lines: lineHits.get(sheet) || 0, samples: e.samples }));
    // A rule that names the private tokens of two producers binds two modules in one selector.
    const shared = new Map();
    for (const s of sheets) {
      const entry = { rules: 0, samples: [] };
      for (const r of s.rules) {
        if (!r.binders.has(p.file) || r.binders.size < 2) continue;
        entry.rules += 1;
        if (entry.samples.length < 6) {
          entry.samples.push({ sel: r.sel, line: r.line, with: [...r.binders].filter((f) => f !== p.file) });
        }
      }
      if (entry.rules) shared.set(s.sheet, entry);
    }
    return {
      file: p.file,
      markup: Boolean(p.markup),
      lines: p.lines,
      tokens: p.written.size,
      privateTokens: privateTokens.length,
      dynamic: p.dynamic,
      reads: [...p.read],
      owner,
      ownerSurface: owner ? SURFACE[owner] || "" : "",
      ownerPrivate: ownerEntry ? ownerEntry.private : 0,
      ownerAll: ownerEntry ? ownerEntry.all : 0,
      ownerSamples: ownerEntry ? ownerEntry.samples : [],
      ownerLines: owner ? lineHits.get(owner) || 0 : 0,
      lineHits: [...lineHits.entries()].sort((a, b) => b[1] - a[1]).map(([sheet, lines]) => ({ sheet, lines })),
      totalPrivate,
      totalAll,
      cohesion: totalPrivate ? (ownerEntry ? ownerEntry.private : 0) / totalPrivate : null,
      sheets: bySheet.size,
      spans,
      shared: [...shared.entries()].map(([sheet, e]) => ({ sheet, ...e })),
      tokensList: [...p.written.entries()].map(([token, line]) => ({ token, line, private: isPrivate(token, p.file) })),
    };
  });

  // Classes a sheet defines that no producer writes.
  const allWritten = new Set();
  for (const p of producers) for (const tok of p.written.keys()) allWritten.add(tok);
  const unowned = sheets.map((s) => {
    const seen = new Map();
    for (const r of s.rules) {
      for (const m of r.sel.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g)) {
        const tok = m[1];
        if (allWritten.has(tok)) continue;
        if (!seen.has(tok)) seen.set(tok, { token: tok, rules: 0, line: r.line });
        seen.get(tok).rules += 1;
      }
    }
    const list = [...seen.values()].sort((a, b) => b.rules - a.rules || a.token.localeCompare(b.token));
    return { sheet: s.sheet, classes: seen.size, rules: list.reduce((a, e) => a + e.rules, 0), list };
  });

  // Orphan tokens a producer writes with no rule anywhere.
  const sheetTokens = new Set();
  for (const s of sheets) for (const r of s.rules) for (const tok of r.tokens) sheetTokens.add(tok);
  const orphanTokens = [];
  for (const p of producers) {
    const list = [...p.written.keys()].filter((t) => !sheetTokens.has(t));
    if (list.length) orphanTokens.push({ file: p.file, count: list.length, tokens: list });
  }

  // State modifiers: the `is-`/`has-` vocabulary. One module writes the state, and any sheet that
  // styles the element it lands on defines a rule for it - a shared vocabulary, measured apart from
  // surface ownership because a state token is meant to be read by more than one sheet.
  const state = [];
  for (const [tok, writeSet] of writers) {
    if (!/^(is|has)-/.test(tok)) continue;
    let rules = 0;
    const on = [];
    for (const s of sheets) {
      const n = s.rules.filter((r) => r.tokens.has(tok)).length;
      if (n) { on.push({ sheet: s.sheet, rules: n }); rules += n; }
    }
    if (on.length) state.push({ token: tok, writers: [...writeSet], rules, sheets: on });
  }
  state.sort((a, b) => b.sheets.length - a.sheets.length || b.rules - a.rules);

  const totals = {
    producers: producers.length,
    jsProducers: producers.filter((p) => !p.markup).length,
    jsLines: producers.filter((p) => !p.markup).reduce((a, p) => a + p.lines, 0),
    sheets: sheets.length,
    rules: sheets.reduce((a, s) => a + s.rules.length, 0),
    selectors: sheets.reduce((a, s) => a + s.selectors, 0),
    keyframeSteps: sheets.reduce((a, s) => a + s.keyframeSteps, 0),
    sheetLines: sheets.reduce((a, s) => a + s.lines, 0),
    tokens: allWritten.size,
  };

  // Coverage: how many rule blocks can be attributed to exactly one module by their structural class.
  // The unattributed ones are broken out, because "no owner" has three very different causes: a rule
  // with no class at all (element or attribute only), a root class several modules write (shared
  // vocabulary), and a root class no producer writes (legacy or built dynamically).
  const coverage = { one: 0, many: 0, none: 0, elementOnly: 0, sharedRoot: 0, unwrittenRoot: 0 };
  for (const s of sheets) {
    s.coverage = { one: 0, many: 0, none: 0, elementOnly: 0, sharedRoot: 0, unwrittenRoot: 0 };
    for (const r of s.rules) {
      const key = r.owners.size === 1 ? "one" : r.owners.size > 1 ? "many" : "none";
      coverage[key] += 1;
      s.coverage[key] += 1;
      if (key !== "none") continue;
      let reason = "elementOnly";
      if (r.roots.size) {
        const shared = [...r.roots].some((t) => (writers.get(t)?.size || 0) > 1);
        reason = shared ? "sharedRoot" : "unwrittenRoot";
      }
      coverage[reason] += 1;
      s.coverage[reason] += 1;
    }
  }
  totals.coverage = coverage;

  return { root, totals, sheets, rows, unowned, orphanTokens, state };
}

// ---------------------------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------------------------
function report(result) {
  const { totals, sheets, rows, unowned, orphanTokens } = result;
  console.log(`root          ${result.root}`);
  console.log(`producers     ${totals.producers} (${totals.jsProducers} JS modules, ${num(totals.jsLines)} lines, plus public/index.html)`);
  console.log(`sheets        ${totals.sheets}, ${num(totals.sheetLines)} lines, ${num(totals.rules)} rule blocks, ${num(totals.selectors)} selector entries, ${num(totals.keyframeSteps)} keyframe steps`);
  console.log(`class tokens  ${num(totals.tokens)} written by at least one producer`);
  const c = totals.coverage;
  console.log(`coverage      ${num(c.one)} rules attributed to one module (${pct(c.one / totals.rules)}), ${num(c.many)} to more than one, ${num(c.none)} to none`);
  console.log("");

  console.log("SHEETS");
  console.log(["sheet", "surface", "lines", "rules", "selectors", "one", "many", "none", "unownedClasses"].join("\t"));
  for (const s of sheets) {
    const u = unowned.find((x) => x.sheet === s.sheet);
    console.log([s.sheet, s.surface, s.lines, s.rules.length, s.selectors, s.coverage.one, s.coverage.many, s.coverage.none, u ? u.classes : 0].join("\t"));
  }
  console.log("");

  console.log("MODULES with at least one private rule (owner = the sheet with the most private rules)");
  console.log(["module", "lines", "tokens", "private", "owner", "ownerRules", "allRules", "cohesion", "sheets", "spans"].join("\t"));
  const withRules = rows
    .filter((r) => r.totalPrivate > 0 && r.lines >= MIN_LINES)
    .sort((a, b) => b.totalPrivate - a.totalPrivate);
  for (const r of withRules) {
    const spans = r.spans.map((x) => `${x.sheet}:${x.private}`).join(" ");
    console.log([r.file, r.lines, r.tokens, r.privateTokens, r.owner, r.ownerPrivate, r.totalAll, pct(r.cohesion), r.sheets, spans].join("\t"));
  }
  console.log("");

  console.log("SPANNING MODULES ranked by private rules outside the owner");
  const spanning = withRules.filter((r) => r.spans.length).sort((a, b) => {
    const cross = (r) => r.spans.reduce((a, x) => a + x.private, 0);
    return cross(b) - cross(a);
  });
  for (const r of spanning) {
    const cross = r.spans.reduce((a, x) => a + x.private, 0);
    console.log(`${r.file}\t${r.lines} lines\towner ${r.owner} ${r.ownerPrivate}\tcross ${cross} over ${r.spans.length} sheets\t${r.spans.map((x) => `${x.sheet}:${x.private}(${x.lines}L)`).join(" ")}`);
  }
  console.log("");

  console.log("MODULES with no private rule (behaviour-only or all classes shared)");
  for (const r of rows.filter((x) => x.totalPrivate === 0 && x.lines >= MIN_LINES)) {
    console.log(`${r.file}\t${r.lines} lines\t${r.tokens} tokens\treads ${r.reads.length} classes`);
  }
  console.log("");

  console.log("SHEETS: classes no producer writes (top 8 per sheet)");
  for (const u of unowned) {
    if (!u.classes) continue;
    console.log(`${u.sheet}\t${u.classes} classes, ${u.rules} rules\t${u.list.slice(0, 8).map((x) => `.${x.token}(${x.rules})`).join(" ")}`);
  }
  console.log("");

  console.log(`ORPHAN TOKENS: written by a producer, defined in no sheet - ${orphanTokens.length} producers`);
  for (const o of orphanTokens.slice(0, 12)) console.log(`${o.file}\t${o.count}\t${o.tokens.slice(0, 10).join(" ")}`);
  console.log("");

  console.log("STATE MODIFIERS: is-/has- tokens, the sheets that style them, and who writes them");
  for (const s of result.state.slice(0, 18)) {
    console.log(`${s.token}\twriters ${s.writers.length}\trules ${s.rules}\t${s.sheets.map((x) => `${x.sheet}:${x.rules}`).join(" ")}`);
  }
}

const result = measure();
report(result);
if (OUT) {
  writeFileSync(path.resolve(OUT), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`\njson ${path.resolve(OUT)}`);
}
