#!/usr/bin/env node
// HARNESS: REVIEW - npm run review:css-split measures how well the 1.191.0 cut of the one panel sheet
// became per-surface sheets. It is not a proof that the cut is faithful (tools/verify-css-split.mjs is
// that proof); it asks the next question: is the RESULT a good split of the work, or only a good copy?
//
// Seven measurements, each one computed, never typed in:
//
//   inventory      lines, bytes, rule blocks, selector entries and declarations per sheet, and each
//                  sheet's share of the whole.
//   duplication    selectors that live in more than one sheet, identical declaration blocks repeated
//                  across sheets, and the same rule written twice.
//   catch-all      what public/base.css and public/late.css still hold that belongs to a surface.
//                  base.css is classified rule by rule as token, reset or surface. late.css is small
//                  enough to name by BLOCK (the sliver layout, the cut dialog, the legend, the search
//                  popovers), and each block is checked against the sheet that should own it: a rule
//                  whose exact selector no other sheet carries is a sole definition, not an override.
//   cascade        (selector, property) pairs set by two or more sheets, and the sheet that wins by load
//                  order (with !important taken first). The top ten by conflict count are listed.
//   dead           rules whose selector matches zero elements in the running page, measured in a real
//                  browser against a seeded fixture. A rule inside a media block that does not apply at
//                  the measured viewport is reported as dormant, not dead. A zero-match selector whose
//                  class/id tokens appear in no file the page ships is reported as structurally dead.
//   cost           sheets a lane must open to change one surface: every sheet whose rule matches an
//                  element inside the surface root, excluding the token layer and the universal reset.
//                  Six surfaces are counted; the two container roots include their nested panes, and
//                  the output says so.
//   money          the split's own six-pane numbers, cited from docs/reports/css-split.html rather than
//                  re-run: this tool never claims a layout delta it did not measure.
//
//   node tools/css-split-review.mjs                 # all seven, screenshots under docs/reports/css-split-review
//   node tools/css-split-review.mjs --static        # the four text measurements, no browser
//   node tools/css-split-review.mjs --json <path>   # also write the numbers as JSON
//   node tools/css-split-review.mjs --no-shots      # browser measurements without captures
//
// Exit: 0 every measurement ran; 1 a measurement failed; 2 Playwright is missing and the browser half
// could not run (the text half still prints, and the JSON it writes has dead: null, cost: null).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { styleSheetFiles } from "./style-sheets.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const OUT = path.resolve(opt("--out", path.join(ROOT, "docs", "reports", "css-split-review")));
const STATIC_ONLY = has("--static");
const NO_SHOTS = has("--no-shots");

const line = (s = "") => console.log(s);
const num = (v) => (typeof v === "number" ? v.toLocaleString("en-US") : v);

// ---------------------------------------------------------------------------------------------
// The sheets, in the order the page applies them
// ---------------------------------------------------------------------------------------------

// Every local sheet public/index.html loads, in load order. chart.css and the two core/ card sheets
// were never part of the one panel sheet; they are still in the order because the cascade measurement needs the
// whole list, but a "split sheet" is one of the nineteen the cut produced. The list is parsed from the page by
// tools/style-sheets.mjs, so a sheet added there is reviewed without an edit here.
export function stylesheetsInLoadOrder(root = ROOT) {
  return styleSheetFiles({ root }).map((href) => ({ href, split: !(href === "chart.css" || href.startsWith("core/")) }));
}

// The surface each sheet owns, as the split's own report names it.
export const SURFACES = {
  "base.css": "tokens and resets",
  "chrome.css": "header and status strip",
  "settings.css": "Settings drawer and its tabs",
  "board.css": "project boxes, folders, agent rows, new-agent form",
  "jobs.css": "job cards",
  "console.css": "the console: agent pane and thought rows",
  "turns.css": "conversation turns",
  "rows.css": "the jobs table's row controls, marks and artifacts",
  "overlays.css": "deliverables, reply box, question cards, ghost turns",
  "rowstrips.css": "git, description, release and TODO strips",
  "boardchips.css": "host, rules, turnover, board and cleanup chips",
  "assistant.css": "the assistant entry, spawn strip and float shell",
  "feedback.css": "Clarify, Collisions and Permissions controls",
  "assistant-panes.css": "the float's tabs, panes, search and settings",
  "initiatives.css": "the initiatives tab",
  "panes.css": "the assistant's Worktrees and Bridge sub-tabs",
  "queue.css": "the queue cards and the assistant queue pane",
  "pipeline.css": "pipeline window, messages, flow and modal",
  "late.css": "late overrides, loaded last",
};

// The two catch-all sheets the review asks about by name.
const CATCH_ALL = ["base.css", "late.css"];

// ---------------------------------------------------------------------------------------------
// A CSS reader: rules with their at-rule context and declarations, no package needed
// ---------------------------------------------------------------------------------------------

const normSpace = (s) => String(s).replace(/\s+/g, " ").trim();

// Collapse the whitespace a browser ignores, including around combinators, so two spellings of one
// selector compare equal. Everything else is kept.
export function normSelector(s) {
  return normSpace(s).replace(/\s*([>+~])\s*/g, "$1");
}

// Split on a separator at bracket depth 0 and outside strings. Selector lists, declaration lists and
// the value of a data: URL all need this rather than String.split.
function splitTop(text, sep) {
  const out = [];
  let buf = "";
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      buf += ch;
      if (ch === "\\") {
        buf += text[i + 1] || "";
        i += 1;
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out;
}

function parseDeclarations(body) {
  const out = [];
  for (const part of splitTop(body, ";")) {
    const text = part.trim();
    if (!text) continue;
    const colon = splitTop(text, ":").length > 1 ? text.indexOf(":") : -1;
    if (colon < 0) continue;
    const prop = text.slice(0, colon).trim();
    if (!prop || prop.startsWith("@")) continue;
    let value = text.slice(colon + 1).trim();
    const important = /!\s*important\s*$/i.test(value);
    if (important) value = value.replace(/!\s*important\s*$/i, "").trim();
    out.push({ prop: prop.toLowerCase(), value, important });
  }
  return out;
}

// Parse one sheet into rule blocks. `ctx` is the stack of at-rule preludes the rule sits inside, so a
// rule that lives in @media (max-height: 300px) is distinguishable from the same selector at top level.
export function parseSheet(text, sheet) {
  const rules = [];
  const stack = [];
  let buf = "";
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
      stack.push({ prelude: normSpace(buf), at: normSpace(buf).startsWith("@") });
      buf = "";
      i += 1;
      continue;
    }
    if (ch === "}") {
      const top = stack.pop();
      if (top && !top.at) {
        const ctx = stack.filter((s) => s.prelude).map((s) => s.prelude);
        const sel = normSpace(top.prelude);
        rules.push({
          sheet,
          order: rules.length,
          ctx,
          sel,
          selectors: splitTop(sel, ",").map(normSelector).filter(Boolean),
          body: normSpace(buf),
          decls: parseDeclarations(buf),
          keyframe: ctx.some((c) => /^@(-[a-z]+-)?keyframes\b/i.test(c)),
        });
      }
      buf = "";
      i += 1;
      continue;
    }
    if (ch === ";" && (!stack.length || stack[stack.length - 1].at) && normSpace(buf).startsWith("@")) {
      buf = "";
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  return rules;
}

// ---------------------------------------------------------------------------------------------
// The text half
// ---------------------------------------------------------------------------------------------

function loadSheets() {
  const order = stylesheetsInLoadOrder(ROOT);
  return order.map((entry, index) => {
    const file = path.join(ROOT, "public", entry.href);
    if (!existsSync(file)) throw new Error(`index.html loads /${entry.href} but public/${entry.href} is missing`);
    const text = readFileSync(file, "utf8");
    const rules = parseSheet(text, entry.href);
    return {
      href: entry.href,
      split: entry.split,
      index,
      text,
      rules,
      bytes: Buffer.byteLength(text),
      lines: text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length,
    };
  });
}

function inventory(sheets) {
  const totalBytes = sheets.filter((s) => s.split).reduce((a, s) => a + s.bytes, 0);
  const totalRules = sheets.filter((s) => s.split).reduce((a, s) => a + s.rules.length, 0);
  const totalSelectors = sheets.filter((s) => s.split).reduce((a, s) => a + s.rules.reduce((b, r) => b + r.selectors.length, 0), 0);
  const totalDecls = sheets.filter((s) => s.split).reduce((a, s) => a + s.rules.reduce((b, r) => b + r.decls.length, 0), 0);
  return {
    totals: { bytes: totalBytes, rules: totalRules, selectors: totalSelectors, decls: totalDecls, sheets: sheets.filter((s) => s.split).length },
    sheets: sheets.filter((s) => s.split).map((s) => {
      const ruleCount = s.rules.length;
      const selectors = s.rules.reduce((a, r) => a + r.selectors.length, 0);
      const decls = s.rules.reduce((a, r) => a + r.decls.length, 0);
      const keyframeSteps = s.rules.filter((r) => r.keyframe).length;
      return {
        sheet: s.href,
        surface: SURFACES[s.href] || "",
        lines: s.lines,
        bytes: s.bytes,
        rules: ruleCount,
        keyframeSteps,
        selectors,
        decls,
        bytesShare: s.bytes / totalBytes,
        ruleShare: ruleCount / totalRules,
        selectorShare: selectors / totalSelectors,
        declShare: decls / totalDecls,
        avgDeclsPerRule: ruleCount ? decls / ruleCount : 0,
      };
    }),
  };
}

// Every selector entry that appears in more than one sheet, with the sheets named, and the same for a
// declaration block: two sheets that carry the same block are duplication even under different names.
function duplication(sheets) {
  const bySelector = new Map();
  const byBlock = new Map();
  const byExactRule = new Map();
  for (const s of sheets) {
    for (const r of s.rules) {
      if (r.keyframe) continue;
      for (const sel of r.selectors) {
        if (!bySelector.has(sel)) bySelector.set(sel, new Map());
        const m = bySelector.get(sel);
        m.set(s.href, (m.get(s.href) || 0) + 1);
      }
      const body = r.body;
      if (body && body !== "{}" && r.decls.length) {
        if (!byBlock.has(body)) byBlock.set(body, new Map());
        const b = byBlock.get(body);
        b.set(s.href, (b.get(s.href) || 0) + 1);
      }
      const exact = `${r.ctx.join(" >> ")}|${r.sel}|${body}`;
      if (!byExactRule.has(exact)) byExactRule.set(exact, []);
      byExactRule.get(exact).push({ sheet: s.href, rule: r });
    }
  }

  const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const selectorPairs = new Map();
  const repeatedSelectors = [];
  for (const [sel, m] of bySelector) {
    if (m.size < 2) continue;
    const names = [...m.keys()].sort((a, b) => sheets.find((s) => s.href === a).index - sheets.find((s) => s.href === b).index);
    repeatedSelectors.push({ selector: sel, sheets: names, occurrences: [...m.values()].reduce((a, b) => a + b, 0) });
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        const k = pairKey(names[i], names[j]);
        selectorPairs.set(k, (selectorPairs.get(k) || 0) + 1);
      }
    }
  }

  const blockPairs = new Map();
  const blockPairsAll = new Map();
  const repeatedBlocks = [];
  for (const [body, m] of byBlock) {
    if (m.size < 2) continue;
    const names = [...m.keys()];
    const declCount = parseDeclarations(body).length;
    repeatedBlocks.push({ body, sheets: names, occurrences: [...m.values()].reduce((a, b) => a + b, 0), bytes: Buffer.byteLength(body), declCount });
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        const k = pairKey(names[i], names[j]);
        blockPairsAll.set(k, (blockPairsAll.get(k) || 0) + 1);
        // A one-declaration block (`display: none`, a colour token) is a shared idiom, not a tangle.
        // A block of three or more declarations is a component's shape copied into another sheet.
        if (declCount >= 3) blockPairs.set(k, (blockPairs.get(k) || 0) + 1);
      }
    }
  }

  const exactDuplicates = [];
  for (const [key, list] of byExactRule) {
    const names = [...new Set(list.map((x) => x.sheet))];
    if (names.length > 1) exactDuplicates.push({ key, sheets: names, count: list.length });
  }

  const top = (map, n = 6) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([pair, count]) => ({ pair: pair.split("|"), count }));

  repeatedSelectors.sort((a, b) => b.occurrences - a.occurrences || a.selector.localeCompare(b.selector));
  repeatedBlocks.sort((a, b) => b.declCount - a.declCount || b.occurrences - a.occurrences || b.bytes - a.bytes);

  return {
    selectorsAcrossSheets: repeatedSelectors,
    selectorPairs: top(selectorPairs),
    blocksAcrossSheets: repeatedBlocks,
    substantialBlocks: repeatedBlocks.filter((b) => b.declCount >= 3),
    blockPairs: top(blockPairs),
    blockPairsAll: top(blockPairsAll),
    exactDuplicates,
    counts: {
      distinctSelectors: bySelector.size,
      repeatedSelectors: repeatedSelectors.length,
      repeatedSelectorOccurrences: repeatedSelectors.reduce((a, r) => a + r.occurrences, 0),
      distinctBlocks: byBlock.size,
      repeatedBlocks: repeatedBlocks.length,
      substantialRepeatedBlocks: repeatedBlocks.filter((b) => b.declCount >= 3).length,
      oneDeclarationBlocks: repeatedBlocks.filter((b) => b.declCount === 1).length,
      exactDuplicateRules: exactDuplicates.length,
    },
  };
}

// What a catch-all sheet still holds, measured by the BLOCK it holds rather than by a guessed token
// owner. public/late.css is small enough (68 rules) that each block can be named from the selector
// family it is written for, and the claim "this block belongs to that surface" can be checked by
// grepping the sheet that surface owns. public/base.css is checked the same way: a rule that is a
// token, a reset or a page element is not a surface rule, and there are no others.
const BASE_RULE_KIND = (sel) => {
  if (sel === ":root") return "token";
  if (sel === "*" || /^\*::?-(webkit|moz)-/.test(sel)) return "reset";
  if (/^(html|body)$/.test(sel) || /^html,\s*body$/.test(sel)) return "reset";
  if (/^(button|select|input|textarea)(,\s*(button|select|input|textarea))*$/.test(sel)) return "reset";
  return "surface";
};

const LATE_BLOCKS = [
  {
    id: "sliver",
    label: "the sliver-window layout: header, shell, agent cards and folders",
    home: ["chrome.css", "board.css"],
    test: (r) => r.ctx.some((c) => /@media\s*\(max-height:\s*300px\)/i.test(c)),
  },
  {
    id: "cut",
    label: "the cut dialog",
    home: ["overlays.css"],
    test: (r) => r.selectors.some((s) => /^\.cut-/.test(s)),
    note: "no .cut- rule exists in overlays.css; public/app.js:7884 creates the dialog",
  },
  {
    id: "legend",
    label: "the chart legend and its popover",
    home: ["chart.css"],
    test: (r) => r.selectors.some((s) => /^\.legend/.test(s)),
  },
  {
    id: "search",
    label: "the assistant and hot-agent search popovers",
    home: ["assistant.css"],
    test: (r) => r.selectors.some((s) => /^\.(as|ha)-search/.test(s)),
  },
];

function catchAll(sheets) {
  const out = {};
  for (const name of CATCH_ALL) {
    const s = sheets.find((x) => x.href === name);
    const rules = s.rules.filter((r) => !r.keyframe);
    const entry = {
      sheet: name,
      surface: SURFACES[name],
      lines: s.lines,
      bytes: s.bytes,
      rules: rules.length,
      blocks: [],
      examples: [],
      surfaceRules: 0,
    };
    if (name === "base.css") {
      const kinds = { token: 0, reset: 0, surface: 0 };
      for (const r of rules) {
        const kind = BASE_RULE_KIND(r.sel);
        kinds[kind] += 1;
        if (kind === "surface" && entry.examples.length < 8) entry.examples.push({ selector: r.sel, kind });
      }
      entry.kinds = kinds;
      entry.surfaceRules = kinds.surface;
      entry.verdict = kinds.surface === 0
        ? "holds nothing but the token layer and page resets"
        : `${kinds.surface} rules name a surface outside the token layer`;
    } else {
      for (const block of LATE_BLOCKS) {
        const list = rules.filter(block.test);
        if (!list.length) continue;
        const tokens = new Set();
        for (const r of list) {
          for (const sel of r.selectors) {
            for (const m of sel.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) tokens.add(`.${m[1]}`);
            for (const m of sel.matchAll(/#([\w-]+)/g)) tokens.add(`#${m[1]}`);
          }
        }
        // Does the sheet that owns this surface actually name these tokens anywhere in its selectors?
        const homeRules = sheets.filter((x) => block.home.includes(x.href)).flatMap((x) => x.rules);
        const defined = new Set();
        for (const r of homeRules) {
          for (const sel of r.selectors) {
            for (const m of sel.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) defined.add(`.${m[1]}`);
            for (const m of sel.matchAll(/#([\w-]+)/g)) defined.add(`#${m[1]}`);
          }
        }
        const absent = [...tokens].filter((t) => !defined.has(t));
        // Rules whose exact selector appears in no other sheet at all: late.css is their only
        // definition, so the "late override" is really the surface's only styling.
        const elsewhere = new Set();
        for (const other of sheets) {
          if (other.href === name) continue;
          for (const r of other.rules) for (const sel of r.selectors) elsewhere.add(sel);
        }
        const sole = list.filter((r) => r.selectors.every((sel) => !elsewhere.has(sel)));
        entry.blocks.push({
          id: block.id,
          soleDefinitions: sole.length,
          soleExamples: sole.slice(0, 4).map((r) => r.sel),
          label: block.label,
          home: block.home,
          rules: list.length,
          decls: list.reduce((a, r) => a + r.decls.length, 0),
          bytes: list.reduce((a, r) => a + Buffer.byteLength(`${r.sel} { ${r.body} }`), 0),
          selectors: list.map((r) => r.sel).slice(0, 6),
          tokens: [...tokens].sort(),
          absentFromHome: absent.sort(),
          note: block.note || "",
        });
        for (const r of list.slice(0, 2)) {
          if (entry.examples.length < 10) entry.examples.push({ selector: r.sel, block: block.id, ctx: r.ctx });
        }
      }
      const covered = entry.blocks.reduce((a, b) => a + b.rules, 0);
      entry.surfaceRules = covered;
      entry.unresolved = rules.length - covered;
      entry.verdict = `${entry.blocks.length} blocks across ${new Set(entry.blocks.flatMap((b) => b.home)).size} surface sheets; ${entry.blocks.filter((b) => b.absentFromHome.length).length} block(s) name tokens their own sheet never defines`;
    }
    out[name] = entry;
  }
  return out;
}

// Set by more than one sheet, with the winner by load order. The selector is the whole key: a rule
// `.x` in two sheets has the same specificity in both, so source order decides, which is exactly the
// tie this measurement is about. A media rule can only collide when it applies, so its context is
// reported beside the pair rather than used to hide it.
function cascade(sheets) {
  const bySel = new Map(); // sel -> prop -> [{sheet, index, value, important, ctx}]
  for (const s of sheets) {
    for (const r of s.rules) {
      if (r.keyframe) continue;
      for (const sel of r.selectors) {
        if (!bySel.has(sel)) bySel.set(sel, new Map());
        const props = bySel.get(sel);
        for (const d of r.decls) {
          if (!props.has(d.prop)) props.set(d.prop, []);
          props.get(d.prop).push({ sheet: s.href, index: s.index, value: d.value, important: d.important, ctx: r.ctx });
        }
      }
    }
  }
  const conflicts = [];
  for (const [sel, props] of bySel) {
    let inConflict = 0;
    const winners = new Map();
    for (const [prop, list] of props) {
      const sheetSet = new Set(list.map((x) => x.sheet));
      if (sheetSet.size < 2) continue;
      inConflict += 1;
      // !important first, then load order.
      const ranked = [...list].sort((a, b) => {
        if (a.important !== b.important) return a.important ? -1 : 1;
        return a.index - b.index;
      });
      const w = ranked[ranked.length - 1];
      if (!winners.has(w.sheet)) winners.set(w.sheet, { sheet: w.sheet, props: 0, examples: [] });
      winners.get(w.sheet).props += 1;
      if (winners.get(w.sheet).examples.length < 4) winners.get(w.sheet).examples.push(prop);
    }
    if (inConflict) {
      conflicts.push({
        selector: sel,
        properties: inConflict,
        sheets: [...new Set([...props.values()].flat().map((x) => x.sheet))],
        winner: [...winners.values()].sort((a, b) => b.props - a.props)[0],
        contexts: [...new Set([...props.values()].flat().filter((x) => x.ctx.length).map((x) => x.ctx.join(" >> ")))],
      });
    }
  }
  conflicts.sort((a, b) => b.properties - a.properties || a.selector.localeCompare(b.selector));

  const pairCounts = new Map();
  for (const c of conflicts) {
    const names = [...new Set(c.sheets)].sort((a, b) => sheets.find((s) => s.href === a).index - sheets.find((s) => s.href === b).index);
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        const k = `${names[i]}|${names[j]}`;
        pairCounts.set(k, (pairCounts.get(k) || 0) + c.properties);
      }
    }
  }
  return {
    totalConflicts: conflicts.reduce((a, c) => a + c.properties, 0),
    selectorsInConflict: conflicts.length,
    top: conflicts.slice(0, 10),
    all: conflicts,
    sheetPairs: [...pairCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([pair, count]) => ({ pair: pair.split("|"), properties: count })),
  };
}

export function staticHalf() {
  const sheets = loadSheets();
  const inv = inventory(sheets);
  const dup = duplication(sheets);
  const cat = catchAll(sheets);
  const cas = cascade(sheets);
  return { sheets, inventory: inv, duplication: dup, catchAll: cat, cascade: cas };
}

// ---------------------------------------------------------------------------------------------
// Terminal output
// ---------------------------------------------------------------------------------------------

function printStatic(result) {
  const { inventory: inv, duplication: dup, catchAll: cat, cascade: cas } = result;
  line("INVENTORY");
  line(`  ${"sheet".padEnd(22)} ${"lines".padStart(6)} ${"bytes".padStart(8)} ${"rules".padStart(6)} ${"sels".padStart(6)} ${"decls".padStart(7)} ${"bytes%".padStart(7)} ${"rules%".padStart(7)}`);
  for (const s of inv.sheets) {
    line(`  ${s.sheet.padEnd(22)} ${String(s.lines).padStart(6)} ${String(s.bytes).padStart(8)} ${String(s.rules).padStart(6)} ${String(s.selectors).padStart(6)} ${String(s.decls).padStart(7)} ${(s.bytesShare * 100).toFixed(1).padStart(6)}% ${(s.ruleShare * 100).toFixed(1).padStart(6)}%`);
  }
  line(`  ${"total".padEnd(22)} ${"".padStart(6)} ${String(inv.totals.bytes).padStart(8)} ${String(inv.totals.rules).padStart(6)} ${String(inv.totals.selectors).padStart(6)} ${String(inv.totals.decls).padStart(7)}`);
  line("");

  line("DUPLICATION");
  line(`  ${num(dup.counts.repeatedSelectors)} selectors of ${num(dup.counts.distinctSelectors)} live in two or more sheets (${num(dup.counts.repeatedSelectorOccurrences)} occurrences)`);
  line(`  ${num(dup.counts.repeatedBlocks)} declaration blocks of ${num(dup.counts.distinctBlocks)} are repeated across sheets;`);
  line(`  ${num(dup.counts.substantialRepeatedBlocks)} of those carry three or more declarations, ${num(dup.counts.oneDeclarationBlocks)} are one declaration; ${num(dup.counts.exactDuplicateRules)} whole rules are written twice`);
  for (const p of dup.selectorPairs.slice(0, 3)) line(`    worst selector pair  ${p.pair.join(" + ")}  ${p.count}`);
  for (const p of dup.blockPairs.slice(0, 3)) line(`    worst block pair (3+ decls)  ${p.pair.join(" + ")}  ${p.count}`);
  line("");

  line("CATCH-ALL");
  const base = cat["base.css"];
  line(`  base.css: ${num(base.rules)} rules; token ${base.kinds.token}, reset ${base.kinds.reset}, surface ${base.kinds.surface} - ${base.verdict}`);
  const late = cat["late.css"];
  line(`  late.css: ${num(late.rules)} rules in ${late.blocks.length} blocks, ${num(late.unresolved)} unresolved - ${late.verdict}`);
  for (const b of late.blocks) {
    line(`    ${String(b.rules).padStart(3)} rules  ${b.label.padEnd(58)} home ${b.home.join(" + ")}${b.absentFromHome.length ? `  (${b.absentFromHome.length} token(s) never named there)` : ""}`);
  }
  line("");

  line("CASCADE");
  line(`  ${num(cas.totalConflicts)} (selector, property) pairs set by two or more sheets, across ${num(cas.selectorsInConflict)} selectors`);
  for (const c of cas.top) line(`    ${String(c.properties).padStart(3)} props  ${c.selector.slice(0, 70).padEnd(70)} winner ${c.winner.sheet} (${c.winner.props})`);
}

// ---------------------------------------------------------------------------------------------
// The browser half: dead selectors, sheets per surface, fresh captures
// ---------------------------------------------------------------------------------------------

// Run in the page. Every rule of every applied sheet, matched against the document. A selector is
// stripped only of the pseudo-classes and pseudo-elements a resting page cannot be in: :hover,
// :focus, :active and their friends, and ::before/::after. `:not()`, `:is()`, `:where()`, `:has()`
// and `:nth-*` are structural and are kept, because removing them would invent matches.
const DEAD_JS = `(() => {
  const DYNAMIC = /:(hover|active|focus|focus-visible|focus-within|visited|checked|disabled|enabled|target|placeholder-shown|invalid|valid|default|indeterminate|autofill|user-invalid|user-valid)(?![\\w-])/g;
  const PSEUDO_ELEMENT = /::?(before|after|first-line|first-letter|selection|placeholder|marker|backdrop|-webkit-[\\w-]+|-moz-[\\w-]+)(?![\\w-])/g;
  const strip = (sel) => sel.replace(PSEUDO_ELEMENT, "").replace(DYNAMIC, "").replace(/\\s+/g, " ").trim();
  const rows = [];
  const tokenSet = (sel) => {
    const out = [];
    for (const m of sel.matchAll(/\\.(-?[_a-zA-Z][\\w-]*)/g)) out.push("." + m[1]);
    for (const m of sel.matchAll(/#([\\w-]+)/g)) out.push("#" + m[1]);
    return out;
  };
  const sheetName = (href) => {
    try {
      const u = new URL(href, location.href);
      return u.pathname.replace(/^.*\\/public\\//, "").replace(/^\\//, "");
    } catch { return String(href); }
  };
  const mediaApplies = (ctx) => ctx.every((c) => {
    if (!/^@media\\b/i.test(c)) return true;
    const q = c.replace(/^@media\\s*/i, "").trim();
    try { return matchMedia(q).matches; } catch { return true; }
  });
  for (const sheet of document.styleSheets) {
    const name = sheetName(sheet.href || "");
    let list = [];
    try { list = [...sheet.cssRules]; } catch { continue; }
    const walk = (rules, ctx) => {
      for (const rule of rules) {
        if (rule.cssRules && !rule.selectorText) {
          const prelude = rule.conditionText ? "@" + (rule.media ? "media " : "") + rule.conditionText : (rule.name ? "@keyframes " + rule.name : "@" + (rule.constructor.name || "group"));
          walk([...rule.cssRules], [...ctx, prelude]);
          continue;
        }
        if (!rule.selectorText) continue;
        if (ctx.some((c) => /^@keyframes\\b/.test(c))) continue;
        const sels = rule.selectorText.split(",").map((s) => s.trim()).filter(Boolean);
        let matched = 0;
        let usable = 0;
        for (const sel of sels) {
          const base = strip(sel);
          if (!base) continue;
          try {
            matched += document.querySelectorAll(base).length;
            usable += 1;
          } catch { /* a selector the engine cannot evaluate is neither dead nor alive */ }
        }
        rows.push({
          sheet: name,
          selector: rule.selectorText,
          ctx,
          mediaApplies: mediaApplies(ctx),
          matched,
          usable,
          tokens: tokenSet(rule.selectorText),
          declarations: rule.style ? rule.style.length : 0,
        });
      }
    };
    walk(list, []);
  }
  return rows;
})()`;

// The owner scan for "structurally dead": a class or id the running page never sees may still be
// produced on demand. This reads every file the page ships and reports which tokens exist there.
export function shippedFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "vendor" || entry.name === "assets") continue;
        walk(p);
      } else if (/\.(js|mjs|html)$/.test(entry.name)) files.push(p); // NOT .css: the stylesheet naming a
      // class does not prove the page can produce it, and counting it here would make every selector "alive".
    }
  };
  walk(path.join(ROOT, "public"));
  return files;
}

// The literal head of a class a template builds: `jl-${kind}` yields "jl-", `md-h${level}` yields
// "md-h". A selector starting with one of these cannot be called stale on the token scan alone.
export function interpolationPrefixes() {
  const out = new Set();
  for (const f of shippedFiles()) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/([a-zA-Z][\w-]*)\$\{/g)) out.add(m[1]);
  }
  return [...out];
}

export function sourceTokens() {
  const files = shippedFiles();
  const tokens = new Set();
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    // A selector token, in the source, can be written any of these ways: `.cls` in a querySelector, an
    // id in a template, or a class attribute string with several names in it. Every hyphenated word
    // inside a quoted or template string is therefore a candidate class; a name the page really
    // produces is written in one of them.
    for (const m of text.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) tokens.add(m[1]);
    for (const m of text.matchAll(/#([\w-]+)/g)) tokens.add(m[1]);
    for (const m of text.matchAll(/["'`]([^"'`\n]{1,300})["'`]/g)) {
      for (const word of m[1].split(/\s+/)) if (/^[a-zA-Z_][\w-]*$/.test(word)) tokens.add(word);
    }
    // `class="a b c"` and className assignments land above; a name built by concatenation still names
    // its own prefix somewhere, so a hyphenated word anywhere in the file is accepted too.
    for (const m of text.matchAll(/[a-zA-Z][\w]*(?:-[\w]+)+/g)) tokens.add(m[0]);
  }
  return tokens;
}

const COST_JS = (sel) => {
  const roots = document.querySelectorAll(sel);
  const root = roots[0];
  if (!root) return null;
  const out = [];
  for (const sheet of document.styleSheets) {
    let list = [];
    try {
      list = [...sheet.cssRules];
    } catch {
      continue;
    }
    const walk = (rules, ctx) => {
      for (const rule of rules) {
        if (rule.cssRules && !rule.selectorText) {
          walk([...rule.cssRules], [...ctx, rule.conditionText || rule.name || "?"]);
          continue;
        }
        if (!rule.selectorText) continue;
        if (ctx.some((c) => /^keyframes/i.test(c))) continue;
        for (const part of rule.selectorText.split(",")) {
          const s = part.trim().replace(/::?(before|after|placeholder|marker|selection|-webkit-[\w-]+|-moz-[\w-]+)(?![\w-])/g, "").trim();
          if (!s) continue;
          try {
            if (!root.querySelectorAll(s).length) continue;
          } catch {
            continue;
          }
          out.push({
            sheet: String(sheet.href || "").split("?")[0].replace(/^.*\/public\//, "").replace(/^https?:\/\/[^/]+\//, ""),
            selector: part.trim(),
            declarations: rule.style ? rule.style.length : 0,
            props: rule.style ? [...rule.style] : [],
          });
          break;
        }
      }
    };
    walk(list, []);
  }
  return { elements: root.querySelectorAll("*").length, rules: out };
};

// Six surfaces, the same six the split proved. The queue is reached through the assistant float,
// which is the pane the split's own numbers name.
const COST_ROOTS = [
  { name: "board", sel: "#projects", what: "the board table" },
  { name: "console", sel: ".job[data-thread='wtgui-board-table-cut']", what: "one agent's console" },
  { name: "queue", sel: "#as-queue", what: "the assistant's queue pane" },
  { name: "assistant", sel: "#assistant", what: "the assistant float" },
  { name: "initiatives", sel: "#as-initiatives", what: "the initiatives tab" },
  { name: "settings", sel: "#settings", what: "the Settings drawer" },
];

const SHOTS = [
  { name: "board-table", sel: "#projects" },
  { name: "console", sel: ".job[data-thread='wtgui-board-table-cut']" },
  { name: "queue-cards", sel: "#as-queue" },
  { name: "assistant-float", sel: "#assistant" },
  { name: "initiatives", sel: "#as-initiatives" },
  { name: "settings", sel: "#settings" },
];

async function settleBoard(page) {
  await page.waitForFunction(() => typeof state !== "undefined" && state.rows && state.rows.size > 0, null, { timeout: 90_000 });
  await page.waitForFunction(() => [...state.rows.values()].length >= 4, null, { timeout: 90_000 });
  await page.evaluate(() => {
    for (const r of state.rows.values()) {
      state.expandedProjects.add(r.project);
      state.expanded.add(`${r.project}::${r.path}`);
    }
    renderAll();
  });
  const signature = () =>
    page.evaluate(() => {
      const root = document.querySelector("#projects");
      return root ? `${root.innerText}\u0000${root.querySelectorAll("*").length}` : "";
    });
  let last = null;
  let same = 0;
  for (let i = 0; i < 24 && same < 5; i += 1) {
    const text = await signature();
    const settled = text.length > 0 && !text.includes("\u2026");
    if (settled && text === last) same += 1;
    else same = 0;
    last = text;
    await page.waitForTimeout(1200);
  }
  await page.waitForTimeout(2000);
  await page.waitForSelector(".job pre.job-out", { state: "visible", timeout: 60_000 });
}

async function drivePanes(page, base, shots) {
  const { openPage } = await import("./browser.mjs");
  await page.addInitScript((fixed) => {
    const Real = Date;
    class Fixed extends Real {
      constructor(...args) {
        if (args.length === 0) super(fixed);
        else super(...args);
      }
      static now() {
        return fixed;
      }
    }
    // eslint-disable-next-line no-global-assign
    Date = Fixed;
    try {
      localStorage.setItem("wtgui.think", "1");
    } catch {
      /* no storage still measures everything else */
    }
  }, Date.UTC(2026, 10, 25, 12, 0, 0));
  await openPage(page, base, { selector: "#projects", timeout: 60_000 });
  await settleBoard(page);

  const snap = async (name, sel) => {
    const ok = await page.evaluate((s) => {
      const root = document.querySelector(s);
      if (!root) return false;
      root.scrollIntoView({ block: "start", inline: "start" });
      const bar = document.querySelector(".topbar");
      const barBottom = bar ? Math.max(0, Math.round(bar.getBoundingClientRect().bottom)) : 0;
      const top = root.getBoundingClientRect().top;
      if (top < barBottom && getComputedStyle(root).position !== "fixed") window.scrollBy(0, top - (barBottom + 12));
      return true;
    }, sel);
    if (!ok) throw new Error(`no element for pane ${name} (${sel})`);
    await page.waitForTimeout(700);
    if (shots) {
      const geom = await page.evaluate((s) => {
        const r = document.querySelector(s).getBoundingClientRect();
        const bar = document.querySelector(".topbar");
        const barBottom = bar ? Math.max(0, Math.round(bar.getBoundingClientRect().bottom)) : 0;
        return { x: r.x, y: r.y, w: r.width, h: r.height, barBottom };
      }, sel);
      const vp = page.viewportSize();
      const top = Math.max(Math.floor(geom.y), geom.barBottom, 0);
      const clip = {
        x: Math.max(0, Math.floor(geom.x)),
        y: top,
        width: Math.max(1, Math.min(Math.ceil(geom.w), Math.floor(vp.width - Math.max(0, Math.floor(geom.x))))),
        height: Math.max(1, Math.min(Math.ceil(geom.y + geom.h) - top, Math.floor(vp.height - top))),
      };
      await page.screenshot({ path: path.join(OUT, `${name}.png`), clip });
    }
    return true;
  };

  const panes = {};
  panes["board-table"] = await snap("board-table", "#projects");
  panes.console = await snap("console", ".job[data-thread='wtgui-board-table-cut']");

  await page.click("#btn-assistant");
  await page.waitForSelector("#assistant:not([hidden])", { timeout: 15_000 });
  await page.click('[data-as-subtab="queue"]');
  await page.waitForSelector("#as-queue:not([hidden])", { timeout: 15_000 });
  await page.click('[data-as-subtab="chat"]');
  await page.waitForTimeout(200);
  await page.click('[data-as-subtab="queue"]');
  await page.waitForTimeout(400);
  panes["queue-cards"] = await snap("queue-cards", "#as-queue");

  await page.click('[data-as-subtab="chat"]');
  await page.waitForTimeout(250);
  panes["assistant-float"] = await snap("assistant-float", "#assistant");

  await page.click('[data-as-tab="initiatives"]');
  await page.waitForSelector("#as-initiatives:not([hidden])", { timeout: 15_000 });
  // The tab draws its toolbar first and its cards when the store read lands. The split's own proof
  // photographed a 49-element pane; this review waits for the shell so its dead measurement sees the
  // cards rather than an empty read.
  await page.waitForSelector("#as-initiatives .init-shell", { timeout: 30_000 });
  await page.waitForTimeout(900);
  panes.initiatives = await snap("initiatives", "#as-initiatives");

  await page.click("#btn-settings");
  await page.waitForSelector("#settings:not(.hidden)", { timeout: 15_000 });
  await page.waitForTimeout(500);
  panes.settings = await snap("settings", "#settings");
  return panes;
}

async function browserHalf({ shots }) {
  const { seedFixture } = await import("./verify-css-split.mjs");
  const { startFixturePanel } = await import("./initiatives-fixture.mjs");
  const { withBrowser } = await import("./browser.mjs");
  const home = path.join(os.tmpdir(), "wag", "css-split-review");
  seedFixture(home);
  const panel = await startFixturePanel({ home, root: ROOT });
  try {
    return await withBrowser(
      async ({ page }) => {
        const panes = await drivePanes(page, panel.base, shots);
        // Dead measurement: every rule in every applied sheet, after all six panes exist in the DOM.
        const deadRows = await page.evaluate(DEAD_JS);
        // The cost measurement re-opens each surface, because a hidden pane still has a DOM but a
        // surface a lane edits is the one the reader is looking at. The Settings drawer is closed
        // first: it is a modal, and every click behind it would land on the drawer instead.
        const cost = [];
        // The capture pass ended on the Settings drawer; close it so the surfaces behind it can be
        // opened by their own controls.
        if (await page.isVisible("#settings")) {
          await page.click("#btn-settings-close");
          await page.waitForTimeout(400);
        }
        for (const surface of COST_ROOTS) {
          if (surface.name === "settings") {
            await page.click("#btn-settings");
            await page.waitForSelector("#settings:not(.hidden)", { timeout: 15_000 });
            await page.waitForTimeout(300);
          } else if (surface.name === "initiatives") {
            if (!(await page.isVisible("#assistant"))) {
              await page.click("#btn-assistant");
              await page.waitForSelector("#assistant:not([hidden])", { timeout: 15_000 });
            }
            await page.click('[data-as-tab="initiatives"]');
            await page.waitForSelector("#as-initiatives .init-shell", { timeout: 30_000 });
            await page.waitForTimeout(300);
          } else if (surface.name === "queue" || surface.name === "assistant") {
            if (!(await page.isVisible("#assistant"))) {
              await page.click("#btn-assistant");
              await page.waitForSelector("#assistant:not([hidden])", { timeout: 15_000 });
            }
            // The subtab row only exists on the assistant's own tab; the capture pass left it on
            // Initiatives, where the queue and chat subtabs are hidden.
            await page.click('[data-as-tab="assistant-1"]');
            await page.waitForSelector('[data-as-subtab="chat"]', { state: "visible", timeout: 15_000 });
            await page.waitForTimeout(250);
            await page.click(`[data-as-subtab="${surface.name === "queue" ? "queue" : "chat"}"]`);
            await page.waitForTimeout(500);
          } else {
            // The board and the console live on the page; nothing to open.
            await page.waitForTimeout(250);
          }
          const got = await page.evaluate(COST_JS, surface.sel);
          if (!got) throw new Error(`cost: no element for ${surface.name} (${surface.sel})`);
          cost.push({ ...surface, ...got });
        }
        return { panes, deadRows, cost };
      },
      { viewport: { width: 1680, height: 1200 }, deviceScaleFactor: 2 },
    );
  } finally {
    await panel.stop();
  }
}

export function deadFindings(rows, tokens, prefixes) {
  const bySheet = new Map();
  const structural = [];
  const dormant = [];
  for (const r of rows) {
    if (!bySheet.has(r.sheet)) bySheet.set(r.sheet, { sheet: r.sheet, split: Object.hasOwn(SURFACES, r.sheet), rules: 0, dead: 0, dormant: 0, structural: 0, matched: 0, deadSample: [] });
    const s = bySheet.get(r.sheet);
    s.rules += 1;
    if (!r.usable) continue;
    if (!r.mediaApplies) {
      s.dormant += 1;
      if (r.matched === 0) dormant.push(r);
      continue;
    }
    if (r.matched > 0) {
      s.matched += 1;
      continue;
    }
    s.dead += 1;
    if (s.deadSample.length < 12) s.deadSample.push(r.selector);
    // Source tokens are stored bare (`update-chip`), selectors carry the sigil: compare without it.
    // A selector whose name starts with a source prefix that ends in "-" can be built by a template
    // (`jl-${kind}`, `md-h${level}`), so it is not called stale.
    const missing = r.tokens.filter((t) => {
      const name = t.replace(/^[.#]/, "");
      return !tokens.has(name) && !prefixes.some((p) => name.startsWith(p) && name.length > p.length);
    });
    if (r.tokens.length && missing.length === r.tokens.length) {
      s.structural += 1;
      structural.push({ ...r, missing });
    }
  }
  return {
    totalRules: rows.length,
    deadRules: [...bySheet.values()].reduce((a, s) => a + s.dead, 0),
    dormantRules: [...bySheet.values()].reduce((a, s) => a + s.dormant, 0),
    structuralRules: structural.length,
    perSheet: [...bySheet.values()].sort((a, b) => b.dead - a.dead),
    structural,
    dormant,
  };
}

// A rule counts toward the cost of changing a surface only if editing it is plausible: the universal
// reset, a scrollbar pseudo-element, a page element and a custom-property-only block are the shared
// layer, and a lane restyling one surface does not open them. The shared layer is reported beside the
// count, never folded into it.
const SHARED_LAYER = /^(\*|\*::.*|:root|html|body|html,\s*body|button,\s*select,\s*input,\s*textarea)$/i;

export function costFindings(cost) {
  const out = [];
  for (const surface of cost) {
    const bySheet = new Map();
    let sharedRules = 0;
    for (const r of surface.rules) {
      if (SHARED_LAYER.test(r.selector.trim())) {
        sharedRules += 1;
        continue;
      }
      if (r.props.length && r.props.every((p) => p.startsWith("--"))) {
        sharedRules += 1;
        continue;
      }
      const name = r.sheet || "(inline)";
      if (!bySheet.has(name)) bySheet.set(name, { sheet: name, rules: 0, decls: 0, examples: [] });
      const s = bySheet.get(name);
      s.rules += 1;
      s.decls += r.declarations;
      if (s.examples.length < 6) s.examples.push(r.selector);
    }
    const sheets = [...bySheet.values()].sort((a, b) => b.rules - a.rules);
    out.push({
      name: surface.name,
      what: surface.what,
      selector: surface.sel,
      elements: surface.elements,
      rules: surface.rules.length - sharedRules,
      sharedRules,
      sheets,
      sheetsTouched: sheets.length,
    });
  }
  return out;
}

// The split's own six-pane numbers, read from its report so the review cites them instead of
// pretending to have measured them again.
function citedPaneNumbers() {
  const file = path.join(ROOT, "docs", "reports", "css-split.html");
  const text = readFileSync(file, "utf8");
  const rows = [];
  const re = /<tr><td[^>]*>([^<]+)<\/td><td><code>([^<]+)<\/code><\/td><td class="num">([\d,]+)<\/td><td class="num">(\d+)<\/td><td class="num">(\d+)<\/td><td class="num">([\d,]+)<\/td><td class="num">(\d+)<\/td><\/tr>/g;
  for (const m of text.matchAll(re)) {
    rows.push({ pane: m[1], root: m[2], elements: Number(m[3].replace(/,/g, "")), boxesDiffer: Number(m[4]), maxDelta: Number(m[5]), textRuns: Number(m[6].replace(/,/g, "")), textDiffer: Number(m[7]) });
  }
  const cssom = text.match(/([\d,]+) rule nodes before the split and <span class="num">([\d,]+)<\/span> after/);
  return { file: "docs/reports/css-split.html", rows, cssom: cssom ? [cssom[1], cssom[2]] : null };
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

let failures = 0;

async function main() {
  const result = staticHalf();
  printStatic(result);

  let browser = null;
  if (!STATIC_ONLY) {
    try {
      mkdirSync(OUT, { recursive: true });
      browser = await browserHalf({ shots: !NO_SHOTS });
    } catch (err) {
      failures += 1;
      if (/playwright/i.test(String(err && err.message))) process.exitCode = 2;
      line("");
      line(`BROWSER-HALF-NOT-RUN: ${err.message}`);
      line("  (install playwright, or run with --static for the text measurements alone)");
    }
  }

  let dead = null;
  let cost = null;
  if (browser) {
    const tokens = sourceTokens();
    dead = deadFindings(browser.deadRows, tokens, interpolationPrefixes());
    cost = costFindings(browser.cost);
    line("");
    line("DEAD");
    line(`  ${num(dead.totalRules)} rules measured in the page; ${num(dead.deadRules)} match no element`);
    line(`  ${num(dead.structuralRules)} of those name only tokens that appear in no shipped file (structurally dead)`);
    line(`  ${num(dead.dormantRules)} more match nothing but sit in a media block that does not apply here (dormant, not dead)`);
    for (const s of dead.perSheet.slice(0, 8)) line(`    ${s.sheet.padEnd(22)} ${String(s.dead).padStart(4)} dead  ${String(s.matched).padStart(4)} live  ${String(s.structural).padStart(3)} structural`);
    if (dead.structural.length) {
      line("  structurally dead, first 12:");
      for (const r of dead.structural.slice(0, 12)) line(`    ${r.sheet.padEnd(20)} ${r.selector.slice(0, 80)}`);
    }
    line("");
    line("COST");
    for (const c of cost) {
      line(`  ${c.name}: ${num(c.elements)} elements, ${num(c.rules)} surface rules from ${c.sheetsTouched} sheets (+${c.sharedRules} shared-layer rules)`);
      for (const s of c.sheets) line(`    ${String(s.rules).padStart(4)} rules  ${s.sheet}`);
    }
    line("");
    line("CITED (from docs/reports/css-split.html, not measured here)");
    for (const r of citedPaneNumbers().rows) line(`  ${r.pane.padEnd(16)} ${String(r.elements).padStart(5)} elements, ${r.boxesDiffer} boxes differ, ${r.textDiffer} text positions differ`);
  }

  if (browser) {
    const evidence = {
      what: "every CSSOM rule the page applied, matched against the document at rest, by tools/css-split-review.mjs",
      dead: browser.deadRows,
      cost: browser.cost.map((c) => ({ name: c.name, selector: c.sel, elements: c.elements, rules: c.rules })),
    };
    writeFileSync(path.join(OUT, "dead-rules.json"), `${JSON.stringify(evidence)}
`, "utf8");
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    generatedFrom: ".", // a repo-relative marker: a committed artifact must not name this machine's folder
    inventory: result.inventory,
    duplication: result.duplication,
    catchAll: result.catchAll,
    cascade: result.cascade,
    dead,
    cost,
    cited: citedPaneNumbers(),
    sheets: result.sheets.map((s) => ({ href: s.href, bytes: s.bytes, lines: s.lines, rules: s.rules.length })),
  };
  // --static must not overwrite the full numbers.json with a half-filled one: the four text measurements
  // write only where --json names a file.
  const jsonPath = opt("--json", STATIC_ONLY ? null : path.join(OUT, "numbers.json"));
  if (jsonPath) {
    mkdirSync(path.dirname(path.resolve(jsonPath)), { recursive: true });
    writeFileSync(path.resolve(jsonPath), `${JSON.stringify(payload, null, 1)}\n`, "utf8");
    line(`JSON written: ${path.relative(ROOT, path.resolve(jsonPath)).replace(/\\/g, "/")}`);
  }
  if (failures && !process.exitCode) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`FAIL  ${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
  });
}
