#!/usr/bin/env node
// HARNESS: LIVE GATE - npm run verify:late-dissolve proves row 446's dissolve of public/late.css.
//
// THE CLAIM. late.css was the page's last sheet: the catch-all the 1.191.0 split left (the sliver window, the cut
// dialog, the legend, the search popovers). Rows 444 and 445 took the cut dialog and the legend out of it; row 446
// moved what was left - the @media (max-height: 300px) sliver block and the search popovers' drag/grip chrome - into
// the sheets that own those surfaces, and deleted the file. This gate proves the move changed nothing the page
// applies.
//
// HALF A - the stream and the cascade, no browser.
//   1. THE FILE IS GONE. public/late.css does not exist and public/index.html does not link it.
//   2. THE MULTISET. The sheets the page linked before the dissolve (read out of git at the last revision that held
//      the file) hold the same rules as the sheets it links now: 0 missing, 0 extra, 0 edited. A move between sheets
//      passes; a dropped, doubled or reworded rule fails with the rule named.
//   3. THE HOME. Every dissolved rule is in exactly one sheet, and it is the sheet the row names for its selector:
//      the header rule in chrome.css, the page-row pair in assistant.css, the search chrome in assistant.css, and
//      everything else (the page column and the board) in board-table.css.
//   4. THE CASCADE PAIRS. Every (selector, property) the dissolved sheet shared with another sheet is listed by name
//      with the winning declaration before and after. The winning VALUE must be identical; the sheet that owns it
//      changes, which is the move. late.css's last position was what made it win those pairs, so this is the half
//      that answers "did it depend on being last".
//   5. NO NEW TIE. Every (selector, property) any two sheets set, page-wide, must have the same winning value after
//      the move as before. A rule that moved earlier and now loses a tie it used to win is a finding here.
//
// HALF B - ONE document, both sheet sets, three viewports.
//   The panel is booted from the pre-dissolve revision (a `git archive`, not a worktree), with a fixture that draws
//   TWO folder cards and both agent cards. In the SAME document, same DOM, same scroll, the gate reads every element
//   each dissolved selector matches - its box and its computed style for every property the dissolved rules declare,
//   plus ::before and ::after - then disables the page's links, injects THIS tree's sheets in THIS tree's order, and
//   reads again. Zero differing boxes and zero differing declarations at 1680x1200, 1280x900 and 1879x157 is the
//   pass. The last is the sliver band the media block exists for; the two folder heads' bands are printed as
//   numbers, because that is what the block's own comment claims (83.9-120.9 of 157).
//
//   node tools/verify-late-dissolve.mjs                 # both halves
//   node tools/verify-late-dissolve.mjs --stream        # half A only (no browser needed)
//   node tools/verify-late-dissolve.mjs --old <rev>     # another pre-dissolve revision
//   node tools/verify-late-dissolve.mjs --json <path>   # write the numbers as JSON
//   node tools/verify-late-dissolve.mjs --keep          # keep the export and the fixture home
//
// Exit: 0 pass; 1 a check failed; 2 Playwright is not installed and the pixel half could not run.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseRules } from "./verify-css-split.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const has = (name) => argv.includes(name);

const DISSOLVED = ["public", "late.css"].join("/");
const STREAM_ONLY = has("--stream");
const KEEP = has("--keep");
const SCRATCH = path.join(os.tmpdir(), "wag", "late-dissolve");

const line = (s = "") => console.log(s);
let failures = 0;
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `: ${extra}` : ""}`);
  if (!cond) failures += 1;
  return cond;
};

// ---------------------------------------------------------------------------------------------
// A selector / declaration reader over the gate's normalized rule stream
// ---------------------------------------------------------------------------------------------

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
const selectorsOf = (rule) => splitTop(rule.sel, ",").map((s) => s.trim()).filter(Boolean);
const declsOf = (rule) =>
  splitTop(rule.decls, ";")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const i = d.indexOf(":");
      const prop = d.slice(0, i).trim();
      let value = d.slice(i + 1).trim();
      const important = /!important\s*$/i.test(value);
      if (important) value = value.replace(/\s*!important\s*$/i, "");
      return { prop, value, important };
    });

const ruleKey = (rule) => `${rule.ctx}|${rule.sel}|${rule.decls}`;

// ---------------------------------------------------------------------------------------------
// The before revision: the last commit that held public/late.css
// ---------------------------------------------------------------------------------------------

function dissolvedRevision() {
  const fromOpt = opt("--old");
  if (fromOpt) return fromOpt;
  const holds = (sha) => {
    if (!sha) return false;
    try {
      execFileSync("git", ["-C", ROOT, "cat-file", "-e", `${sha}:${DISSOLVED}`], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  // The tree the dissolve was cut from: the parent of the commit that DELETED the file. That is the real
  // counterfactual (this branch before the move), not the last revision that happened to edit late.css - a later
  // landing that left the file alone is part of the before tree and must stay in it.
  const deletions = execFileSync("git", ["-C", ROOT, "log", "--diff-filter=D", "--format=%H", "--", DISSOLVED], {
    encoding: "utf8",
  })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sha of deletions) {
    const parent = execFileSync("git", ["-C", ROOT, "rev-parse", `${sha}^`], { encoding: "utf8" }).trim();
    if (holds(parent)) return parent;
  }
  // Before the dissolve is committed there is no deletion commit: HEAD is the tree the move is being made in.
  const head = execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (holds(head)) return head;
  throw new Error(`no commit in this branch's history holds ${DISSOLVED}`);
}

const gitShow = (rev, file) =>
  execFileSync("git", ["-C", ROOT, "show", `${rev}:${file}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const LINK = /<link\s+rel="stylesheet"\s+href="\/([^"]+\.css)"/g;
const sheetsAt = (rev) => [...gitShow(rev, "public/index.html").matchAll(LINK)].map((m) => m[1]);
const sheetsNow = () => [...readFileSync(path.join(ROOT, "public", "index.html"), "utf8").matchAll(LINK)].map((m) => m[1]);

function sheetSet(rev, names) {
  return names.map((name) => ({
    name,
    text: rev ? gitShow(rev, `public/${name}`) : readFileSync(path.join(ROOT, "public", name), "utf8"),
  }));
}
const rulesOf = (set) => set.flatMap((s) => parseRules(s.text).map((r) => ({ ...r, sheet: s.name })));

function multisetDelta(oldKeys, newKeys) {
  const count = (keys) => {
    const m = new Map();
    for (const k of keys) m.set(k, (m.get(k) || 0) + 1);
    return m;
  };
  const a = count(oldKeys);
  const b = count(newKeys);
  const lost = [];
  const added = [];
  for (const [k, n] of a) for (let i = b.get(k) || 0; i < n; i += 1) lost.push(k);
  for (const [k, n] of b) for (let i = a.get(k) || 0; i < n; i += 1) added.push(k);
  return { lost, added };
}

// The home each dissolved rule must have, from its own selector. A rule the row did not name is a finding.
function homeFor(rule) {
  const media = /@media\s*\(max-height:\s*300px\)/i.test(rule.ctx);
  const sels = selectorsOf(rule);
  if (media && sels.every((s) => s === ".topbar")) return "chrome.css";
  // parseRules collapses the space around `>`: the page-row pair reads `.shell` and `.shell>main`.
  if (media && sels.every((s) => s === ".shell" || s.replace(/\s+/g, "") === ".shell>main")) return "assistant.css";
  if (
    sels.some(
      (s) => /\.(as|ha)-search-(drag|grip|x)\b/.test(s) || /\.(as|ha)-search-pop\.is-(moving|resizing)\b/.test(s),
    )
  ) {
    return "assistant.css";
  }
  if (media) return "board-table.css";
  return null;
}

// The declaration index, in load order. Specificity is equal by construction (the same selector text), so a tie is
// decided by !important and then by position: sheet order, then the rule's own position inside its sheet.
function declarationIndex(set) {
  const map = new Map();
  let n = 0;
  for (const s of set) {
    for (const r of parseRules(s.text)) {
      if (r.sel.startsWith("@") || /@keyframes/.test(r.ctx)) continue;
      n += 1;
      for (const sel of selectorsOf(r)) {
        if (!map.has(sel)) map.set(sel, new Map());
        for (const d of declsOf(r)) {
          if (!map.get(sel).has(d.prop)) map.get(sel).set(d.prop, []);
          map.get(sel).get(d.prop).push({ sheet: s.name, seq: n, value: d.value, important: d.important });
        }
      }
    }
  }
  return map;
}
const winnerOf = (list) => {
  const ranked = [...list].sort((a, b) => (a.important === b.important ? a.seq - b.seq : a.important ? 1 : -1));
  return ranked[ranked.length - 1];
};
const say = (v) => (v ? `${v.sheet} ${v.value}${v.important ? " !important" : ""}` : "(none)");

// ---------------------------------------------------------------------------------------------
// HALF A
// ---------------------------------------------------------------------------------------------

function halfStream() {
  line("HALF A  the stream and the cascade");
  const rev = dissolvedRevision();
  const beforeNames = sheetsAt(rev);
  const afterNames = sheetsNow();
  const before = sheetSet(rev, beforeNames);
  const after = sheetSet(null, afterNames);
  const beforeRules = rulesOf(before);
  const afterRules = rulesOf(after);

  line(`  before              ${rev.slice(0, 8)}: ${beforeNames.length} sheets, ${beforeRules.length} rules`);
  line(`  after               this tree: ${afterNames.length} sheets, ${afterRules.length} rules`);

  // 1. the file and its link
  const onDisk = existsSync(path.join(ROOT, DISSOLVED));
  const linked = afterNames.includes("late.css");
  ok("late.css: the file is gone and no sheet the page links is called late.css", !onDisk && !linked,
    `${DISSOLVED} on disk ${onDisk}, linked ${linked}`);

  // 2. the multiset
  const beforeKeys = beforeRules.map(ruleKey);
  const afterKeys = afterRules.map(ruleKey);
  const delta = multisetDelta(beforeKeys, afterKeys);
  const lostByPair = new Map();
  for (const k of delta.lost) {
    const p = k.split("|").slice(0, 2).join("|");
    if (!lostByPair.has(p)) lostByPair.set(p, []);
    lostByPair.get(p).push(k);
  }
  const edits = [];
  const addedLeft = [];
  for (const k of delta.added) {
    const pool = lostByPair.get(k.split("|").slice(0, 2).join("|"));
    if (pool && pool.length === 1) edits.push({ before: pool.pop(), after: k });
    else addedLeft.push(k);
  }
  const lostLeft = [...lostByPair.values()].flat();
  ok("stream: the rule multiset is identical before and after",
    lostLeft.length === 0 && addedLeft.length === 0 && edits.length === 0,
    `${beforeKeys.length} rules: ${lostLeft.length} missing, ${addedLeft.length} extra, ${edits.length} edited`);
  for (const k of lostLeft.slice(0, 5)) line(`    missing  ${String(k).slice(0, 150)}`);
  for (const k of addedLeft.slice(0, 5)) line(`    extra    ${String(k).slice(0, 150)}`);
  for (const e of edits.slice(0, 5)) line(`    edited   ${String(e.before).slice(0, 110)} -> ${String(e.after).slice(0, 110)}`);

  // 3. every dissolved rule's one home
  const dissolved = beforeRules.filter((r) => r.sheet === "late.css");
  const holders = new Map();
  for (const r of afterRules) {
    const k = ruleKey(r);
    if (!holders.has(k)) holders.set(k, new Set());
    holders.get(k).add(r.sheet);
  }
  const wrong = [];
  const perHome = {};
  for (const r of dissolved) {
    const found = [...(holders.get(ruleKey(r)) || [])];
    const want = homeFor(r);
    const home = found.length === 1 ? found[0] : `(${found.length ? found.join("+") : "nowhere"})`;
    perHome[home] = (perHome[home] || 0) + 1;
    if (found.length !== 1 || found[0] !== want) wrong.push({ sel: r.sel, ctx: r.ctx, want, found });
  }
  ok("home: every dissolved rule is in exactly one sheet, the one its selector names", wrong.length === 0,
    `${dissolved.length} rules into ${Object.keys(perHome).length} sheet(s): ${Object.entries(perHome).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  for (const w of wrong.slice(0, 6)) line(`    ${w.ctx || "(no at-rule)"} | ${w.sel}: want ${w.want}, found ${w.found.join("+") || "nowhere"}`);

  // 4. the cascade pairs the dissolved sheet took part in
  const beforeIdx = declarationIndex(before);
  const afterIdx = declarationIndex(after);
  const pairs = [];
  for (const [sel, props] of beforeIdx) {
    for (const [prop, list] of props) {
      if (!list.some((x) => x.sheet === "late.css")) continue;
      if (new Set(list.map((x) => x.sheet)).size < 2) continue;
      const wb = winnerOf(list);
      const wa = winnerOf(afterIdx.get(sel)?.get(prop) || []);
      pairs.push({
        sel,
        prop,
        sheets: [...new Set(list.map((x) => x.sheet))],
        before: say(wb),
        after: say(wa),
        same: Boolean(wa) && wb.value === wa.value && wb.important === wa.important,
      });
    }
  }
  ok("cascade: every pair the dissolved sheet shared keeps its winning value", pairs.every((p) => p.same),
    `${pairs.length} pair(s) across ${new Set(pairs.map((p) => p.sel)).size} selector(s)`);
  for (const p of pairs) line(`    ${p.sel} { ${p.prop} }: ${p.before}  ->  ${p.after}${p.same ? "" : "   CHANGED"}`);

  // 5. no new losing tie anywhere on the page
  const changed = [];
  const allSel = new Set([...beforeIdx.keys(), ...afterIdx.keys()]);
  let crossSheetPairs = 0;
  for (const sel of allSel) {
    const props = new Set([...(beforeIdx.get(sel)?.keys() || []), ...(afterIdx.get(sel)?.keys() || [])]);
    for (const prop of props) {
      const lb = beforeIdx.get(sel)?.get(prop) || [];
      const la = afterIdx.get(sel)?.get(prop) || [];
      const crossBefore = new Set(lb.map((x) => x.sheet)).size >= 2;
      const crossAfter = new Set(la.map((x) => x.sheet)).size >= 2;
      if (!crossBefore && !crossAfter) continue;
      crossSheetPairs += 1;
      const wb = winnerOf(lb);
      const wa = winnerOf(la);
      if (!wb || !wa) continue;
      if (wb.value !== wa.value || wb.important !== wa.important) changed.push({ sel, prop, before: say(wb), after: say(wa) });
    }
  }
  ok("cascade: no (selector, property) pair changed its winning value anywhere on the page", changed.length === 0,
    `${allSel.size} selectors, ${crossSheetPairs} cross-sheet pairs, ${changed.length} changed`);
  for (const c of changed.slice(0, 6)) line(`    ${c.sel} { ${c.prop} }: ${c.before} -> ${c.after}`);

  line();
  return {
    rev,
    beforeSheets: beforeNames,
    afterSheets: afterNames,
    beforeRules: beforeRules.length,
    afterRules: afterRules.length,
    lost: lostLeft.length,
    added: addedLeft.length,
    edited: edits.length,
    dissolved: dissolved.map((r) => {
      // The properties this rule had to WIN, by being later than another sheet's declaration of the same property
      // on the same selector. Specificity is equal (the selector is the same text), so source order decided.
      const lastWins = [];
      const shared = [];
      for (const sel of selectorsOf(r)) {
        for (const d of declsOf(r)) {
          const others = (beforeIdx.get(sel)?.get(d.prop) || []).filter((x) => x.sheet !== "late.css");
          if (others.length) lastWins.push(`${sel} { ${d.prop} } over ${[...new Set(others.map((x) => `${x.sheet} ${x.value}`))].join(", ")}`);
        }
        // A selector another sheet also names, where no property collides: the rule shared its name, not a tie.
        const named = [...new Set(beforeRules.filter((o) => o.sheet !== "late.css" && selectorsOf(o).includes(sel)).map((o) => o.sheet))];
        if (named.length) shared.push(`${sel} in ${named.join(", ")}`);
      }
      return {
        ctx: r.ctx,
        sel: r.sel,
        decls: r.decls,
        selectors: selectorsOf(r),
        properties: declsOf(r).map((d) => d.prop),
        home: [...(holders.get(ruleKey(r)) || [])][0] || null,
        want: homeFor(r),
        lastWins,
        sharedSelectors: shared,
      };
    }),
    perHome,
    pairs,
    changed,
    crossSheetPairs,
  };
}

// ---------------------------------------------------------------------------------------------
// HALF B: one document, both sheet sets
// ---------------------------------------------------------------------------------------------

const VIEWPORTS = [
  { name: "desk", width: 1680, height: 1200 },
  { name: "narrow", width: 1280, height: 900 },
  { name: "sliver", width: 1879, height: 157 },
];

const msys = (p) => {
  const s = String(p).replace(/\\/g, "/");
  return /^[A-Za-z]:\//.test(s) ? `/${s[0].toLowerCase()}${s.slice(2)}` : s;
};

function git(root, args) {
  const C = String.fromCharCode(64);
  return execFileSync(
    "git",
    ["-C", root, "-c", "user.name=Fixture", "-c", `user.email=fixture${C}example.invalid`, "-c", "commit.gpgsign=false", ...args],
    { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"] },
  );
}

function exportRoot(rev, dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  mkdirSync(dir, { recursive: true });
  const tarFile = `${dir}.tar`;
  rmSync(tarFile, { force: true });
  execFileSync("git", ["-C", ROOT, "archive", "--format=tar", `--output=${tarFile}`, rev], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
  execFileSync("tar", ["-x", "-f", msys(tarFile), "-C", msys(dir)], { stdio: ["ignore", "pipe", "pipe"] });
  rmSync(tarFile, { force: true });
  // The panel reads `git rev-parse HEAD` for its version line, so the export needs a repo of its own.
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "export"]);
  return dir;
}

// The fixture draws TWO folder cards: seedFixture's two projects under one root, plus one repo under a second root,
// which is the shape the sliver block's comment measures ("both heads at 83.9-120.9 of 157").
function twoFolderConfig(home) {
  const file = path.join(home, "config.json");
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  const other = path.join(home, "other");
  const repo = path.join(other, "one-repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(repo, "README.md"), "# one-repo\n", "utf8");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "seed one-repo"]);
  cfg.scanRoots = [...cfg.scanRoots, other];
  writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  return { other, repo };
}

async function settle(page) {
  await page.waitForFunction(() => typeof state !== "undefined" && state.rows && state.rows.size > 0, null, { timeout: 90_000 });
  await page.evaluate(() => {
    for (const r of state.rows.values()) {
      state.expandedProjects.add(r.project);
      state.expanded.add(`${r.project}::${r.path}`);
    }
    renderAll();
  });
  await page.waitForFunction(() => document.querySelectorAll("#projects > .root-group").length >= 2, null, { timeout: 60_000 });
  // The reader leaves the two fixed agent cards folded, which is the state the sliver block's own comment measures.
  for (const id of ["newagent", "agents"]) {
    const folded = await page.evaluate((x) => Boolean(document.getElementById(x)?.classList.contains("fixed-collapsed")), id);
    if (!folded) await page.click(`#${id} > .project-head`);
  }
  await page.waitForTimeout(300);
  // The board is settled when its text holds still: a row verdict lands on its own schedule.
  let last = null;
  let same = 0;
  for (let i = 0; i < 12 && same < 3; i += 1) {
    const text = await page.evaluate(() => document.querySelector("#projects")?.innerText || "");
    const settled = text.length > 0 && !text.includes("\u2026");
    if (settled && text === last) same += 1;
    else same = 0;
    last = text;
    await page.waitForTimeout(600);
  }
}

// One document, two sheet sets. MEASURE reads every element each dissolved selector matches for every property the
// dissolved rules declare; the sets are swapped in place, so the DOM, the scroll position and the media state are
// the same for both readings.
const MEASURE_JS = ({ selectors, props }) => {
  const dynamic =
    /:(hover|active|focus|focus-visible|focus-within|visited|checked|disabled|enabled|target|placeholder-shown|invalid|valid|default|indeterminate|autofill|user-invalid|user-valid)(?![\w-])/g;
  const strip = (sel) => sel.replace(dynamic, "");
  const round = (v) => Math.round(v * 100) / 100;
  const read = (el, pseudo) => {
    const cs = getComputedStyle(el, pseudo);
    return props.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";");
  };
  const out = [];
  for (const sel of selectors) {
    let els = [];
    try {
      els = [...document.querySelectorAll(strip(sel))];
    } catch {
      continue;
    }
    els.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      out.push({
        sel,
        i,
        tag: el.tagName.toLowerCase(),
        id: el.id || "",
        cls: (el.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 3).join("."),
        box: [round(r.x), round(r.y), round(r.width), round(r.height)],
        style: read(el, null),
        before: read(el, "::before"),
        after: read(el, "::after"),
      });
    });
  }
  return out;
};

const LAYOUT_JS = () => {
  const cs = (sel, prop) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el).getPropertyValue(prop) : null;
  };
  const r = (v) => Math.round(v * 100) / 100;
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: r(b.x), y: r(b.y), w: r(b.width), h: r(b.height), top: r(b.top), bottom: r(b.bottom) };
  };
  const heads = [...document.querySelectorAll("#projects > .root-group > .root-head")].map((h) => {
    const b = h.getBoundingClientRect();
    return { x: r(b.x), y: r(b.y), w: r(b.width), h: r(b.height), top: r(b.top), bottom: r(b.bottom) };
  });
  const cols = [box(".topbar"), box("#spawn-strip"), box("#newagent"), box("#agents"), box("#projects")];
  return {
    body: { display: cs("body", "display"), flexDirection: cs("body", "flex-direction"), overflow: cs("body", "overflow") },
    topbar: { position: cs(".topbar", "position"), padding: cs(".topbar", "padding") },
    shell: { alignItems: cs(".shell", "align-items"), minHeight: cs(".shell", "min-height") },
    projects: { display: cs("#projects", "display"), gridTemplateColumns: cs("#projects", "grid-template-columns") },
    boxes: { topbar: cols[0], spawn: cols[1], newagent: cols[2], agents: cols[3], projects: cols[4] },
    heads,
  };
};

const AFFORDANCE_JS = () => {
  const out = { cursors: {}, hover: {} };
  for (const id of ["as-search-pop", "ha-search-pop"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    out.cursors[id] = { rest: getComputedStyle(el).cursor };
    el.classList.add("is-moving");
    out.cursors[id].moving = getComputedStyle(el).cursor;
    el.classList.remove("is-moving");
    el.classList.add("is-resizing");
    out.cursors[id].resizing = getComputedStyle(el).cursor;
    el.classList.remove("is-resizing");
  }
  return out;
};

async function hoverAffordances(page) {
  // A real hover is the wrong tool here: the popover can sit under the sticky top bar in the sliver band, and
  // Playwright refuses a hover whose point another element receives. The state being compared is `:hover` itself,
  // so it is forced on the node through CDP - the same style the pointer would produce, at every viewport.
  const client = await page.context().newCDPSession(page);
  await client.send("DOM.enable");
  await client.send("CSS.enable");
  const { root } = await client.send("DOM.getDocument", { depth: -1 });
  const out = {};
  try {
    for (const [key, sel, pseudo, prop] of [
      ["drag", "#as-search-pop [data-search-drag]", "::before", "background-color"],
      ["grip", "#as-search-pop [data-search-grip]", "::after", "background-image"],
      ["ha-drag", "#ha-search-pop [data-search-drag]", "::before", "background-color"],
      ["ha-grip", "#ha-search-pop [data-search-grip]", "::after", "background-image"],
    ]) {
      const { nodeId } = await client.send("DOM.querySelector", { nodeId: root.nodeId, selector: sel });
      if (!nodeId) continue;
      await client.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] });
      out[key] = await page.evaluate(
        ([s, ps, p]) => {
          const node = document.querySelector(s);
          return node ? getComputedStyle(node, ps).getPropertyValue(p) : null;
        },
        [sel, pseudo, prop],
      );
      await client.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
    }
  } finally {
    await client.detach();
  }
  return out;
}

async function affordances(page) {
  const rest = await page.evaluate(AFFORDANCE_JS);
  const hover = await hoverAffordances(page);
  return { ...rest, hover };
}

async function applySet(page, sheets) {
  await page.evaluate((list) => {
    for (const el of document.querySelectorAll("style[data-after='1']")) el.remove();
    for (const l of document.querySelectorAll("link[rel='stylesheet']")) l.disabled = Boolean(list);
    if (!list) return;
    for (const s of list) {
      const style = document.createElement("style");
      style.dataset.after = "1";
      style.textContent = s.text;
      document.head.appendChild(style);
    }
  }, sheets);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function readAt(page, vp, sheets, selectors, props) {
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(120);
  await applySet(page, sheets);
  const readings = await page.evaluate(MEASURE_JS, { selectors, props });
  const layout = await page.evaluate(LAYOUT_JS);
  return { readings, layout };
}

async function popovers(page) {
  if (!(await page.evaluate(() => Boolean(document.querySelector("#assistant:not([hidden])"))))) await page.click("#btn-assistant");
  await page.waitForSelector("#assistant:not([hidden])", { timeout: 45_000 });
  await page.waitForSelector("#as-search-q", { state: "visible", timeout: 30_000 });
  await page.fill("#as-search-q", "the");
  await page.waitForSelector("#as-search-pop:not([hidden])", { timeout: 20_000 });
  await page.click("#ha-search-open");
  await page.waitForSelector("#ha-search-pop:not([hidden])", { timeout: 20_000 });
  await page.fill("#ha-search-q", "the");
  await page.waitForTimeout(400);
}

function diffReadings(before, after, label) {
  const diffs = [];
  const n = Math.max(before.length, after.length);
  for (let i = 0; i < n; i += 1) {
    const b = before[i];
    const a = after[i];
    if (!b || !a) {
      diffs.push({ at: label, what: b ? "only before" : "only after", sel: (b || a).sel, i: (b || a).i });
      continue;
    }
    if (JSON.stringify(b.box) !== JSON.stringify(a.box)) diffs.push({ at: label, what: "box", sel: b.sel, i: b.i, before: b.box, after: a.box });
    if (b.style !== a.style) diffs.push({ at: label, what: "style", sel: b.sel, i: b.i, before: b.style, after: a.style });
    if (b.before !== a.before) diffs.push({ at: label, what: "::before", sel: b.sel, i: b.i, before: b.before, after: a.before });
    if (b.after !== a.after) diffs.push({ at: label, what: "::after", sel: b.sel, i: b.i, before: b.after, after: a.after });
  }
  return diffs;
}

async function pair(page, vp, afterSheets, selectors, props, label) {
  const before = await readAt(page, vp, null, selectors, props);
  const after = await readAt(page, vp, afterSheets, selectors, props);
  await applySet(page, null);
  const diffs = diffReadings(before.readings, after.readings, label);
  if (JSON.stringify(before.layout) !== JSON.stringify(after.layout)) {
    diffs.push({ at: label, what: "layout probe", before: before.layout, after: after.layout });
  }
  const seen = {};
  for (const e of before.readings) seen[e.sel] = (seen[e.sel] || 0) + 1;
  return { elements: before.readings.length, diffs, layout: before.layout, seen };
}

async function halfStyles(stream) {
  line("HALF B  one document, both sheet sets");
  const browserMod = await import("./browser.mjs");
  if (!browserMod.loadPlaywright()) {
    console.log(browserMod.notRun("the one-document comparison", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT to the browser cache)"));
    return { skipped: true };
  }
  const beforeRoot = exportRoot(stream.rev, path.join(SCRATCH, "before"));
  line(`  before root         ${beforeRoot} (git archive of ${stream.rev.slice(0, 8)})`);
  line(`  after set           this tree's ${stream.afterSheets.length} sheets, in its own link order`);

  const { seedFixture } = await import("./verify-css-split.mjs");
  const { startFixturePanel } = await import("./initiatives-fixture.mjs");
  const home = path.join(SCRATCH, "home");
  seedFixture(home);
  twoFolderConfig(home);

  const selectors = [...new Set(stream.dissolved.flatMap((r) => selectorsOf(r)))];
  const props = [...new Set(stream.dissolved.flatMap((r) => declsOf(r).map((d) => d.prop)))].sort();
  const afterSheets = sheetSet(null, stream.afterSheets);

  const panel = await startFixturePanel({ home, root: beforeRoot });
  try {
    const viewports = await browserMod.withBrowser(
      async ({ page }) => {
        await browserMod.openPage(page, panel.base, { selector: "#projects", timeout: 60_000 });
        await settle(page);
        await popovers(page);
        const out = {};
        for (const vp of VIEWPORTS) {
          const main = await pair(page, vp, afterSheets, selectors, props, vp.name);
          const affBefore = await affordances(page);
          await applySet(page, afterSheets);
          const affAfter = await affordances(page);
          await applySet(page, null);
          if (JSON.stringify(affBefore) !== JSON.stringify(affAfter)) {
            main.diffs.push({ at: vp.name, what: "affordances", before: affBefore, after: affAfter });
          }
          out[vp.name] = { vp, ...main, affordances: affBefore };
          line(`  ${vp.name.padEnd(11)} ${`${vp.width}x${vp.height}`.padEnd(10)} ${String(main.elements).padStart(4)} element readings, ${String(main.diffs.length).padStart(2)} differing`);
          // The sliver's OTHER state: both fixed cards open, which is when the block's :not(.fixed-collapsed) rules are
          // live. The reader's own state (folded) is the reading above; this one proves the open state too.
          if (vp.name === "sliver") {
            for (const id of ["newagent", "agents"]) await page.click(`#${id} > .project-head`);
            await page.waitForTimeout(250);
            const open = await pair(page, vp, afterSheets, selectors, props, "sliver-open");
            out["sliver-open"] = { vp, ...open };
            line(`  ${"sliver-open".padEnd(11)} ${`${vp.width}x${vp.height}`.padEnd(10)} ${String(open.elements).padStart(4)} element readings, ${String(open.diffs.length).padStart(2)} differing`);
            for (const id of ["newagent", "agents"]) await page.click(`#${id} > .project-head`);
            await page.waitForTimeout(250);
          }
        }
        return out;
      },
      { viewport: { width: 1680, height: 1200 }, deviceScaleFactor: 1 },
    );
    line("");
    return { beforeRoot, selectors: selectors.length, properties: props.length, viewports };
  } finally {
    await panel.stop();
    line(`  panel stopped (${panel.root})`);
  }
}

// ---------------------------------------------------------------------------------------------
async function main() {
  const stream = halfStream();
  const result = { generatedAt: new Date().toISOString(), stream };
  if (!STREAM_ONLY) {
    const styles = await halfStyles(stream);
    result.styles = styles;
    if (styles.skipped) {
      line("  the pixel half did not run; the stream half stands on its own");
      process.exit(2);
    }
    const clean = Object.values(styles.viewports).every((v) => !v.diffs.length);
    ok("pixels: every box, declaration and ::before/::after is identical in the one document", clean,
      Object.entries(styles.viewports).map(([k, v]) => `${k} ${v.diffs.length}`).join(", "));
    const sliver = styles.viewports.sliver;
    for (const [i, h] of (sliver?.layout?.heads || []).entries()) {
      line(`  sliver head ${i + 1}       y ${h.top}-${h.bottom} of 157, x ${h.x}, ${h.w}x${h.h}`);
    }
    line(`  sliver layout       body ${sliver?.layout?.body?.display}/${sliver?.layout?.body?.flexDirection}, topbar ${sliver?.layout?.topbar?.position}, #projects ${sliver?.layout?.projects?.display}`);
    for (const [name, b] of Object.entries(sliver?.layout?.boxes || {})) {
      if (b) line(`    ${name.padEnd(10)} y ${b.top}-${b.bottom}, x ${b.x}, ${b.w}x${b.h}`);
    }
    const desk = styles.viewports.desk;
    line(`  desk layout         body ${desk?.layout?.body?.display}, topbar ${desk?.layout?.topbar?.position}, #projects ${desk?.layout?.projects?.display}`);
    ok("media: the 300 px block is live in the sliver reading and not at the desk",
      sliver?.layout?.body?.display === "flex" && sliver?.layout?.body?.flexDirection === "column" &&
        sliver?.layout?.topbar?.position === "static" && sliver?.layout?.projects?.display === "grid" &&
        desk?.layout?.topbar?.position === "sticky",
      `sliver body ${sliver?.layout?.body?.display}/${sliver?.layout?.body?.flexDirection}, topbar ${sliver?.layout?.topbar?.position}, #projects ${sliver?.layout?.projects?.display}; desk topbar ${desk?.layout?.topbar?.position}`);
    ok("media: the two folder heads share the sliver's one head row",
      (sliver?.layout?.heads || []).length >= 2 && new Set((sliver?.layout?.heads || []).map((h) => h.top)).size === 1,
      (sliver?.layout?.heads || []).map((h) => `y ${h.top}-${h.bottom}`).join(", "));
    for (const [name, v] of Object.entries(styles.viewports)) {
      for (const d of v.diffs.slice(0, 8)) {
        line(`    ${name} ${d.what} ${d.sel} [${d.i}]: ${String(JSON.stringify(d.before)).slice(0, 120)} -> ${String(JSON.stringify(d.after)).slice(0, 120)}`);
      }
    }
  }
  if (!KEEP) {
    try {
      rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* a busier Windows handle is not a failure of the proof */
    }
  }
  const jsonPath = opt("--json");
  if (jsonPath) {
    mkdirSync(path.dirname(path.resolve(jsonPath)), { recursive: true });
    writeFileSync(path.resolve(jsonPath), `${JSON.stringify(result, null, 1)}\n`, "utf8");
    line(`JSON written: ${path.relative(ROOT, path.resolve(jsonPath)).replace(/\\/g, "/")}`);
  }
  line(failures ? `FAIL  ${failures} check(s) failed` : "PASS  every check passed");
  process.exit(failures ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`FAIL  ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}
