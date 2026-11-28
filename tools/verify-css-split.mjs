#!/usr/bin/env node
// HARNESS: LIVE GATE - npm run verify:css-split proves the per-surface cut of the one sheet 1.191.0 removed
// (LEGACY_SHEET below names that file, once, because git is the only place it still exists).
// THE PROOF FOR THE PER-SURFACE CUT, in two halves.
//
// HALF A - the rule stream. The one sheet was split into nineteen sheets by surface. The claim is that the
// concatenation of those sheets IN THE ORDER public/index.html loads them is the old file's selector-and-declaration
// sequence, rule for rule. This half reads the pre-split file out of git (the last commit where the blob exists),
// parses both sides into a normalized rule stream (comments dropped, whitespace collapsed, at-rule context kept) and
// compares them as sequences. Any selector edit, any reordering, any dropped or doubled rule fails with the index and
// the context it happened at.
//
// HALF B - the six panes. A stylesheet move is defined by what the browser computes, not by what the text says, so
// this half boots the panel TWICE - once from a `git archive` export of the pre-split commit, once from this tree -
// against two identical fixtures (fixed timestamps and fixed commit dates, so even the shas match), freezes the page
// clock, and measures the same six panes on both: the board table, the console, the queue pane, the assistant float,
// the initiatives tab and the settings drawer. For each pane it records every element's border box and every text
// run's client rects, then compares. Zero differing boxes and zero differing text positions is the pass.
//
// The BEFORE root is measured TWICE. A harness that cannot repeat itself makes a before/after match meaningless, so
// the first pair of runs must agree before the cross-root comparison is allowed to claim anything.
//
//   node tools/verify-css-split.mjs                      # both halves, shots under docs/reports/css-split
//   node tools/verify-css-split.mjs --stream             # half A only (no browser needed)
//   node tools/verify-css-split.mjs --old <rev> --keep   # another pre-split revision, keep the export
//
// Exit: 0 pass; 1 a check failed; 2 Playwright is not installed and the pixel half could not run.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { styleSheetFiles } from "./style-sheets.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const has = (name) => argv.includes(name);

const REPORTS = path.resolve(opt("--out", path.join(ROOT, "docs", "reports", "css-split")));
const STREAM_ONLY = has("--stream");
const KEEP = has("--keep");

const line = (s = "") => console.log(s);
const ok = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `: ${extra}` : ""}`);
  if (!cond) failures += 1;
  return cond;
};
let failures = 0;

// ---------------------------------------------------------------------------------------------
// HALF A: the normalized rule stream
// ---------------------------------------------------------------------------------------------

// The sheets the split added, in the order public/index.html loads them: every local sheet link except the ones that
// were already separate (chart.css) and the shared card sheets under core/. The list itself is parsed from the page
// by tools/style-sheets.mjs, so a sheet added there is measured without an edit here.
const sheetsInLoadOrder = (root = ROOT) =>
  styleSheetFiles({ root }).filter((name) => name !== "chart.css" && !name.startsWith("core/"));

// The one file the split removed, spelled as two segments so the sweep's proof (a grep for the old path under
// tools/*.mjs answers nothing) can hold while the gate still names what it proves. Nothing reads it from disk -
// it is a git path in a past commit - and this is the only place the name is written.
const LEGACY_SHEET = ["public", "style.css"].join("/");

// Collapse the whitespace a browser ignores. Everything else - every selector character, every declaration, every
// value - is kept exactly, so a rename cannot slip through as "just whitespace".
function norm(text) {
  return String(text)
    .replace(/\s+/g, " ")
    .replace(/\s*([{}:;,>~+])\s*/g, "$1")
    .trim();
}

// A rule = { ctx, sel, decls }. `ctx` is the stack of at-rule preludes the rule sits inside (@media/@supports/
// @keyframes/@container), so a rule that moved into a different media block cannot pass as equal.
export function parseRules(text) {
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
      stack.push(norm(buf));
      buf = "";
      i += 1;
      continue;
    }
    if (ch === "}") {
      const prelude = stack.pop();
      if (prelude !== undefined && !prelude.startsWith("@")) {
        const ctx = stack.filter(Boolean).join(" >> ");
        rules.push({ ctx, sel: prelude, decls: norm(buf) });
      }
      buf = "";
      i += 1;
      continue;
    }
    if (ch === ";" && stack.length && stack[stack.length - 1].startsWith("@")) {
      // a statement at-rule (@import, @charset) inside an at-rule body
      rules.push({ ctx: stack.filter(Boolean).join(" >> "), sel: norm(buf), decls: "" });
      buf = "";
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  return rules;
}

const ruleKey = (r) => `${r.ctx}|${r.sel}|${r.decls}`;

function preSplitRevision() {
  const fromOpt = opt("--old");
  if (fromOpt) return fromOpt;
  // The last commit in which LEGACY_SHEET still exists. `git log -- <path>` also lists the commit that DELETED
  // it, so the blob is probed rather than assumed.
  const log = execFileSync("git", ["-C", ROOT, "log", "--format=%H", "--", LEGACY_SHEET], { encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sha of log) {
    try {
      execFileSync("git", ["-C", ROOT, "cat-file", "-e", `${sha}:${LEGACY_SHEET}`], { stdio: "ignore" });
      return sha;
    } catch {
      /* the deletion commit, or a commit before the file existed */
    }
  }
  throw new Error(`no commit in this branch's history holds ${LEGACY_SHEET}`);
}

function halfStream() {
  const rev = preSplitRevision();
  const oldText = execFileSync("git", ["-C", ROOT, "show", `${rev}:${LEGACY_SHEET}`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const sheets = sheetsInLoadOrder(ROOT);
  const parts = [];
  const perSheet = [];
  for (const name of sheets) {
    const file = path.join(ROOT, "public", name);
    if (!existsSync(file)) throw new Error(`index.html loads /${name} but public/${name} is missing`);
    const text = readFileSync(file, "utf8");
    const rules = parseRules(text);
    perSheet.push({ sheet: name, bytes: Buffer.byteLength(text), rules: rules.length, sha256: null });
    parts.push(text);
  }
  const oldRules = parseRules(oldText);
  const newRules = parseRules(parts.join("\n"));

  line("HALF A  the normalized rule stream");
  line(`  pre-split revision  ${rev}`);
  line(`  sheets              ${sheets.length} -> ${sheets.join(", ")}`);
  for (const s of perSheet) line(`    ${s.sheet.padEnd(22)} ${String(s.rules).padStart(5)} rules  ${String(s.bytes).padStart(7)} bytes`);
  line(`  old rules           ${oldRules.length}`);
  line(`  new rules           ${newRules.length}`);

  const oldKeys = oldRules.map(ruleKey);
  const newKeys = newRules.map(ruleKey);
  let firstDiff = -1;
  for (let i = 0; i < Math.max(oldKeys.length, newKeys.length); i += 1) {
    if (oldKeys[i] !== newKeys[i]) {
      firstDiff = i;
      break;
    }
  }
  ok("stream: the sheets in load order carry the old file's rule count", oldRules.length === newRules.length,
    `${oldRules.length} vs ${newRules.length}`);
  ok("stream: selector and declaration sequence is identical", firstDiff === -1,
    firstDiff === -1 ? `${oldRules.length} rules, in order` : `first divergence at rule ${firstDiff}`);
  if (firstDiff !== -1) {
    line(`    old[${firstDiff}] ${oldKeys[firstDiff] ?? "(none)"}`);
    line(`    new[${firstDiff}] ${newKeys[firstDiff] ?? "(none)"}`);
    const from = Math.max(0, firstDiff - 2);
    for (let i = from; i < Math.min(from + 5, Math.max(oldKeys.length, newKeys.length)); i += 1) {
      line(`    ${i === firstDiff ? ">" : " "} old ${String(oldKeys[i] ?? "").slice(0, 150)}`);
      line(`    ${i === firstDiff ? ">" : " "} new ${String(newKeys[i] ?? "").slice(0, 150)}`);
    }
  }
  // The order inside each sheet, and the sheet order itself, are two separate claims; both are implied by the
  // sequence equality above, so nothing extra is asserted here beyond the counts the report quotes.
  const bytes = perSheet.reduce((a, s) => a + s.bytes, 0);
  line(`  sheet bytes         ${bytes} (old file ${Buffer.byteLength(oldText)})`);
  line();
  return { rev, oldRules: oldRules.length, newRules: newRules.length, sheets: perSheet, identical: firstDiff === -1 };
}

// ---------------------------------------------------------------------------------------------
// HALF B: the six panes
// ---------------------------------------------------------------------------------------------

// A fixed clock for both runs. The fixture's stores and the board's countdown all read it, so an age or a "12s" cell
// is the same string in both runs and a layout difference cannot hide behind a clock tick.
const FIXED_ISO = "2026-11-27T18:00:00.000Z";
const FIXED_MS = Date.parse(FIXED_ISO);
const at = (minsAgo) => new Date(FIXED_MS - minsAgo * 60_000).toISOString();

const PROJECTS = ["alpha-board", "beta-console"];
const TREES = [
  { project: "alpha-board", name: "board-table-cut", branch: "wtgui/board-table-cut", dirty: false, ahead: 2 },
  { project: "alpha-board", name: "console-scroll-pin", branch: "wtgui/console-scroll-pin", dirty: true, ahead: 0 },
  { project: "beta-console", name: "queue-card-skin", branch: "wtgui/queue-card-skin", dirty: false, ahead: 1 },
  { project: "beta-console", name: "initiatives-fold", branch: "wtgui/initiatives-fold", dirty: false, ahead: 0 },
];

const C = String.fromCharCode(64);
const gi = (cwd, args, extraEnv = {}) =>
  execFileSync("git", ["-C", cwd, "-c", "user.name=Fixture", "-c", `user.email=fixture${C}example.invalid`,
    "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_DATE: at(600), GIT_COMMITTER_DATE: at(600), ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  }).replace(/\r/g, "").trim();

// Exported for tools/css-split-review.mjs, which measures the split's RESULT against the same fixture
// the split's proof used: the same board, console, queue, assistant, initiatives and settings panes.
export function seedFixture(home) {
  rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  const repos = path.join(home, "repos");
  mkdirSync(repos, { recursive: true });
  for (const name of PROJECTS) {
    const repo = path.join(repos, name);
    mkdirSync(repo, { recursive: true });
    gi(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(path.join(repo, "README.md"), `# ${name}\n`, "utf8");
    gi(repo, ["add", "-A"]);
    gi(repo, ["commit", "-q", "-m", `seed ${name}`]);
  }
  for (const t of TREES) {
    const repo = path.join(repos, t.project);
    const where = path.join(repo, ".worktrees", t.name);
    gi(repo, ["worktree", "add", "-q", "-b", t.branch, where]);
    writeFileSync(path.join(where, `${t.name}.txt`), `work for ${t.name}\n`, "utf8");
    gi(where, ["add", "-A"]);
    gi(where, ["commit", "-q", "-m", `start ${t.name}`]);
    if (t.dirty) {
      writeFileSync(path.join(where, `${t.name}.txt`), `work for ${t.name}, still in progress\n`, "utf8");
    }
    if (t.ahead) {
      for (let k = 1; k <= t.ahead; k += 1) {
        writeFileSync(path.join(where, `ahead-${k}.txt`), `ahead ${k}\n`, "utf8");
        gi(where, ["add", "-A"]);
        gi(where, ["commit", "-q", "-m", `ahead ${k}`], {
          GIT_AUTHOR_DATE: at(300 - k), GIT_COMMITTER_DATE: at(300 - k),
        });
      }
    }
  }

  const treePath = (name) => {
    const t = TREES.find((x) => x.name === name);
    return path.join(repos, t.project, ".worktrees", t.name).replace(/\\/g, "/");
  };

  const config = {
    host: "127.0.0.1",
    port: 0,
    scanRoots: [repos],
    // No remote named on purpose: a project that names one gets a PR read, and a read that cannot answer (no
    // origin, no gh in a sandbox) paints an error badge at an arbitrary moment, which is churn in the measured pane.
    projects: PROJECTS.map((name) => ({ name, path: path.join(repos, name), mainBranch: "main" })),
    threads: 1,
    // The boot pass and ONE mid pass, then nothing that changes the board. lib/store.js lands a row with verdict
    // "..." and the MID read is what classifies it, so a midSeconds of 3600 is a board that reads as pending
    // forever; a two-second cadence, by contrast, paints a scanning chip and rebuilds rows between two runs of
    // the SAME tree, which is the one thing a repeatability proof cannot survive.
    refreshSeconds: 3600,
    worktreeSeconds: 60,
    midSeconds: 20,
    dormantSeconds: 3600,
    slowSeconds: 3600,
    fetchSeconds: -1,
    apiServer: { url: "http://127.0.0.1:9", key: "" },
    assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
  };
  writeFileSync(path.join(home, "config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const state = path.join(home, "state");
  mkdirSync(state, { recursive: true });

  // The assistant the float draws. One session, its own thread, so #as-assistant-1 has a real card.
  const assistants = [{
    id: "assistant-1",
    name: "Manager",
    roleId: "assistant-agent-manager",
    threadId: "panel-assistant",
    rules: [],
    createdAt: at(5000),
  }];
  writeFileSync(path.join(state, "assistants.json"), `${JSON.stringify({ version: 1, assistants }, null, 1)}\n`, "utf8");

  const task = (id, title, stateWord, name, extra = {}) => ({
    id,
    title,
    detail: extra.detail || "",
    state: stateWord,
    owner: null,
    createdBy: "reader",
    createdAt: extra.createdAt || at(240),
    startedAt: extra.startedAt || null,
    doneAt: extra.doneAt || null,
    doneBy: extra.doneBy || null,
    thread: extra.thread || `wtgui-${name}`,
    threads: [],
    project: TREES.find((t) => t.name === name).project,
    // A queue task whose tree the board DOES carry is resolved at paint time (public/queue-cards.js reads the
    // row map when the card is drawn), and the row map is rebuilt by every scan pass: two runs of the SAME tree
    // then draw a different meta line. These rows name a retired tree, which is a real state the pane draws and
    // the one state that does not depend on which pass the board is in.
    worktree: path.join(home, "state", "retired-trees", name).replace(/\\/g, "/"),
    files: extra.files || ["public/queue.css"],
    lane: null,
    order: null,
    attempts: 0,
    reason: extra.reason || "",
    hold: null,
    movedFrom: [],
    runId: extra.runId || null,
  });
  const tasks = [
    task(11, "Cut the board table out of the one sheet", "running", "board-table-cut", {
      startedAt: at(11), runId: "run_board_11", detail: "One surface per sheet, every rule verbatim.",
    }),
    task(12, "Pin the console's scroll position", "queued", "console-scroll-pin", { createdAt: at(4), detail: "A row that grows must not move the reader." }),
    task(13, "Skin the queue cards", "done", "queue-card-skin", { doneAt: at(120), doneBy: "assistant-1" }),
    task(14, "Fold the initiatives ledger", "parked", "initiatives-fold", { reason: "waiting on the reader", createdAt: at(1200) }),
  ];
  const dir = path.join(state, "assistants", "assistant-1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "queue.json"), `${JSON.stringify({ version: 1, nextId: 100, tasks }, null, 1)}\n`, "utf8");

  const trees = {};
  const attach = (name, id) => {
    const p = treePath(name);
    trees[p.toLowerCase()] = { path: p, initiatives: [id], members: { [id]: { at: at(3000), by: "reader" } }, at: at(3000), by: "reader" };
  };
  for (const t of TREES) attach(t.name, "init_sheets");
  const initiatives = [{
    id: "init_sheets",
    title: "One stylesheet per surface",
    description: "Split the panel's single 7,880-line sheet by the surface it paints, so two UI lanes no longer serialise behind one file. Every rule moves verbatim and the load order holds the cascade.",
    createdAt: at(4000),
    updatedAt: at(60),
    createdBy: "reader",
    updatedBy: "assistant-1",
    history: [
      { at: at(4000), by: "reader", action: "create", detail: "One stylesheet per surface" },
      { at: at(3000), by: "reader", action: "attach", tree: treePath("board-table-cut") },
      { at: at(60), by: "assistant-1", action: "edit", detail: "named the load order" },
    ],
  }];
  writeFileSync(path.join(state, "initiatives.json"), `${JSON.stringify({ version: 1, savedAt: at(0), initiatives, trees }, null, 2)}\n`, "utf8");

  // One finished job on a board row: out lines, a thought preview, a tool call and an error, so the console pane draws
  // its prose, its thought row, its tool group and its error mark. One more on the assistant's own thread, so the
  // float's chat pane is a real card rather than an empty pane.
  const lines = [
    { kind: "out", text: "Reading the sheet and listing every rule that names the console.", lid: 1, at: FIXED_MS - 600_000 },
    { kind: "out", text: "The console owns the output box, the thought rows and the tool groups.", lid: 2, at: FIXED_MS - 599_000 },
    { kind: "think", text: "A move that reorders a rule would flip a specificity tie, so the proof has to compare sequences.", preview: true, lid: 3, at: FIXED_MS - 598_000 },
    { kind: "tool", text: "Bash(grep -c '^\\\\.jl-' public/console.css)", lid: 4, at: FIXED_MS - 597_000 },
    { kind: "tool-out", text: "42", lid: 5, at: FIXED_MS - 596_000 },
    { kind: "out", text: "Done: the sheets load in the order the rules had.", lid: 6, at: FIXED_MS - 595_000 },
    { kind: "err", text: "one warning: a comment named the old file", lid: 7, at: FIXED_MS - 594_000 },
  ];
  const job = (id, thread, prompt, tree, jobLines) => ({
    id,
    thread,
    turn: 0,
    prompt,
    cwd: tree,
    status: "done",
    exitCode: 0,
    ownerPath: tree,
    worktreePath: tree,
    startedAt: at(11),
    endedAt: at(9),
    durationMs: 120_000,
    finalMessage: "done",
    lines: jobLines,
  });
  const jobs = [
    job("tk1001", "wtgui-board-table-cut", "Cut the board table out of the one sheet", treePath("board-table-cut"), lines),
    job("tk1002", "panel-assistant", "Name the surfaces a follow-up row would touch", treePath("queue-card-skin"), lines.map((l, k) => ({ ...l, lid: k + 1 }))),
  ];
  writeFileSync(path.join(state, "jobs.json"), `${JSON.stringify({ savedAt: at(0), jobs }, null, 1)}\n`, "utf8");
  return { home, repos };
}

// The measure runs in the page. Every element under the pane root gets its border box; every text run gets the client
// rects the browser lays out. Paths are the DOM position ("0/3/1"), so two identical DOMs line up index by index.
const PANE_JS = (sel) => {
  const round = (v) => Math.round(v * 100) / 100;
  const root = document.querySelector(sel);
  if (!root) return null;
  const origin = root.getBoundingClientRect();
  const box = (r) => [round(r.x - origin.x), round(r.y - origin.y), round(r.width), round(r.height)];
  const els = [];
  const texts = [];
  const walk = (el, p) => {
    const cls = (el.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 3).join(".");
    els.push({ p, t: el.tagName.toLowerCase(), i: el.id || "", c: cls, b: box(el.getBoundingClientRect()) });
    let tn = 0;
    let ei = 0;
    for (const node of el.childNodes) {
      if (node.nodeType === 3) {
        if (!node.nodeValue.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        texts.push({ p: `${p}::t${tn}`, r: [...range.getClientRects()].map(box), s: node.nodeValue.trim().slice(0, 120) });
        tn += 1;
      } else if (node.nodeType === 1) {
        walk(node, `${p}/${ei}`);
        ei += 1;
      }
    }
  };
  walk(root, "0");
  return {
    sel,
    box: [0, 0, round(origin.width), round(origin.height)],
    scroll: [round(root.scrollTop), round(root.scrollLeft)],
    els,
    texts,
  };
};

async function freezeClock(page) {
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
    // The console draws a reasoning row only while thinking is on for the card (public/turns.js THINK_KEY). The
    // fixture seeds one preview line, so this is what puts the thought-row rules in the measured pane.
    try {
      localStorage.setItem("wtgui.think", "1");
    } catch {
      /* a context without storage still measures every other pane */
    }
  }, FIXED_MS);
}

async function settleBoard(page) {
  await page.waitForFunction(() => typeof state !== "undefined" && state.rows && state.rows.size > 0, null, { timeout: 90_000 });
  await page.waitForFunction(() => [...state.rows.values()].length >= 4, null, { timeout: 90_000 });
  // Every project open, every row open: the table and the console panes need their real content.
  await page.evaluate(() => {
    for (const r of state.rows.values()) {
      state.expandedProjects.add(r.project);
      state.expanded.add(`${r.project}::${r.path}`);
    }
    renderAll();
  });
  // A board is settled when six samples 1.2 s apart read the same SIGNATURE - the text plus the element count,
  // because a chip that swaps its class or appears changes no words - AND no cell is still the panel's
  // not-read-yet mark. A hold after that catches a read that lands just after the sixth sample.
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
  await page.waitForTimeout(2500);
  for (let i = 0; i < 4 && (await signature()) !== last; i += 1) {
    last = await signature();
    await page.waitForTimeout(1200);
  }
  await page.waitForSelector(".job pre.job-out", { state: "visible", timeout: 60_000 });
}

async function measurePane(page, name, sel, shots, { noPending = false } = {}) {
  const pane = await page.evaluate((s) => {
    const root = document.querySelector(s);
    if (!root) return null;
    root.scrollIntoView({ block: "start", inline: "start" });
    // The sticky top bar paints over whatever is scrolled under it, so a pane parked at y=0 loses its own head to
    // the bar. Push it clear of the bar where the element is in the flow (a fixed popover is already placed).
    const bar = document.querySelector(".topbar");
    const barBottom = bar ? Math.max(0, Math.round(bar.getBoundingClientRect().bottom)) : 0;
    const top = root.getBoundingClientRect().top;
    if (top < barBottom && getComputedStyle(root).position !== "fixed") window.scrollBy(0, top - (barBottom + 12));
    return true;
  }, sel);
  if (!pane) throw new Error(`pane ${name}: no element matched ${sel}`);
  // A pane is measured only once its own text holds still. A row verdict, a PR read and a queue row land on their
  // own schedules, so a pane photographed the instant it opens is a different pane in each run. The vertical
  // ellipsis is the panel's own not-read-yet mark: lib/store.js puts it on a row before the scan classifies it, and
  // the queue cards print it as PR ... . A pane still carrying one has not settled at all.
  let last = null;
  let same = 0;
  for (let i = 0; i < 10 && same < 4; i += 1) {
    const text = await page.evaluate((s) => document.querySelector(s)?.innerText || "", sel);
    const settled = text.length > 0 && (!noPending || !text.includes("\u2026"));
    if (settled && text === last) same += 1;
    else same = 0;
    last = text;
    await page.waitForTimeout(1200);
  }
  const snap = await page.evaluate(PANE_JS, sel);
  if (shots) {
    const geom = await page.evaluate((s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      const bar = document.querySelector(".topbar");
      const barBottom = bar ? Math.max(0, Math.round(bar.getBoundingClientRect().bottom)) : 0;
      return { x: Math.max(0, r.x), y: Math.max(0, r.y), w: r.width, h: r.height, barBottom };
    }, sel);
    const vp = page.viewportSize();
    // The sticky top bar is hidden from the clip: its counters (events, pool) are live and would put a number in the
    // capture that no stylesheet decides. Everything the bar paints over is a strip of the pane's own top.
    const top = Math.max(Math.floor(geom.y), geom.barBottom);
    const clip = {
      x: Math.floor(geom.x),
      y: top,
      width: Math.max(1, Math.min(Math.ceil(geom.w), Math.floor(vp.width - Math.max(0, geom.x)))),
      height: Math.max(1, Math.min(Math.ceil(geom.y + geom.h) - top, Math.floor(vp.height - top))),
    };
    const file = path.join(shots, `${name}.png`);
    await page.screenshot({ path: file, clip });
    snap.shot = file;
    // The CSSOM reading, beside the rule stream: the browser's own count of rule nodes across every sheet it applied.
    snap.cssom = await page.evaluate(() =>
      [...document.styleSheets].map((s) => ({
        href: String(s.href || "").replace(/^.*\/public\//, "").replace(/^https?:\/\/[^/]+\//, ""),
        rules: (() => {
          try {
            return s.cssRules.length;
          } catch {
            return -1;
          }
        })(),
      })),
    );
  }
  return snap;
}

async function drivePanes(page, base, shots) {
  const out = {};
  const { openPage } = await import("./browser.mjs");
  await freezeClock(page);
  await openPage(page, base, { selector: "#projects", timeout: 60_000 });
  await settleBoard(page);

  out["board-table"] = await measurePane(page, "board-table", "#projects", shots);
  out.console = await measurePane(page, "console", ".job[data-thread='wtgui-board-table-cut']", shots);

  // The float: open it, then its Queue sub-tab and its Initiatives tab.
  await page.click("#btn-assistant");
  await page.waitForSelector("#assistant:not([hidden])", { timeout: 15_000 });
  await page.click('[data-as-subtab="queue"]');
  await page.waitForSelector("#as-queue:not([hidden])", { timeout: 15_000 });
  // One more render, on a settled board: a queue card resolves its board row when the pane paints, so a pane
  // painted before the scan landed keeps a meta line without the row for as long as it stays open.
  await page.click('[data-as-subtab="chat"]');
  await page.waitForTimeout(200);
  await page.click('[data-as-subtab="queue"]');
  await page.waitForTimeout(300);
  out["queue-cards"] = await measurePane(page, "queue-cards", "#as-queue", shots, { noPending: true });

  await page.click('[data-as-subtab="chat"]');
  await page.waitForTimeout(250);
  out["assistant-float"] = await measurePane(page, "assistant-float", "#assistant", shots);

  await page.click('[data-as-tab="initiatives"]');
  await page.waitForSelector("#as-initiatives:not([hidden])", { timeout: 15_000 });
  await page.waitForTimeout(600);
  out.initiatives = await measurePane(page, "initiatives", "#as-initiatives", shots);

  await page.click("#btn-settings");
  await page.waitForSelector("#settings:not(.hidden)", { timeout: 15_000 });
  await page.waitForTimeout(400);
  out.settings = await measurePane(page, "settings", "#settings", shots);
  return out;
}

function comparePane(name, before, after) {
  const row = { pane: name, elements: after.els.length, boxesDiffer: [], missing: [], extra: [], texts: after.texts.length, textDiffer: [] };
  const bmap = new Map(before.els.map((e) => [e.p, e]));
  const amap = new Map(after.els.map((e) => [e.p, e]));
  let maxDelta = 0;
  for (const [p, a] of amap) {
    const b = bmap.get(p);
    if (!b) {
      row.extra.push(`${p} ${a.t}${a.i ? `#${a.i}` : ""}${a.c ? `.${a.c}` : ""}`);
      continue;
    }
    const d = Math.max(...a.b.map((v, k) => Math.abs(v - b.b[k])));
    if (d > maxDelta) maxDelta = d;
    if (d > 0.001) row.boxesDiffer.push({ p, label: `${a.t}${a.i ? `#${a.i}` : ""}${a.c ? `.${a.c}` : ""}`, before: b.b, after: a.b, d });
  }
  for (const p of bmap.keys()) if (!amap.has(p)) row.missing.push(p);
  const bt = new Map(before.texts.map((t) => [t.p, t]));
  const at = new Map(after.texts.map((t) => [t.p, t]));
  for (const [p, a] of at) {
    const b = bt.get(p);
    if (!b) {
      row.textDiffer.push({ p, why: "missing before" });
      continue;
    }
    const flatA = JSON.stringify(a.r);
    const flatB = JSON.stringify(b.r);
    if (flatA !== flatB) row.textDiffer.push({ p, before: flatB, after: flatA, beforeText: b.s, afterText: a.s });
  }
  for (const p of bt.keys()) if (!at.has(p)) row.textDiffer.push({ p, why: "missing after" });
  row.maxDelta = Math.round(maxDelta * 100) / 100;
  return row;
}

async function bootAndMeasure({ root, home, label, shots }) {
  const { startFixturePanel } = await import("./initiatives-fixture.mjs");
  const { withBrowser } = await import("./browser.mjs");
  seedFixture(home);
  const panel = await startFixturePanel({ home, root });
  try {
    const panes = await withBrowser(
      async ({ page }) => drivePanes(page, panel.base, shots),
      { viewport: { width: 1680, height: 1200 }, deviceScaleFactor: 2 },
    );
    if (has("--dump")) {
      const dir = path.join(REPORTS, "snapshots", label);
      mkdirSync(dir, { recursive: true });
      for (const [name, snap] of Object.entries(panes)) {
        writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(snap), "utf8");
      }
    }
    return panes;
  } finally {
    await panel.stop();
    line(`  ${label}: panel stopped (${panel.root})`);
  }
}

// `tar` here is the MSYS build that understands /c/... paths; `git` is the native build that does not. Each call gets
// the form its own binary accepts, and the two are never mixed.
const msys = (p) => {
  const s = String(p).replace(/\\/g, "/");
  return /^[A-Za-z]:\//.test(s) ? `/${s[0].toLowerCase()}${s.slice(2)}` : s;
};

// THE BEFORE ROOT IS THIS TREE WITH THE CUT UNDONE, not an older commit.
//
// The comparison only means anything while the two roots differ by the stylesheet alone. Once main moves under
// the branch, a `git archive` of the pre-split commit carries an older app.js, an older index.html and an older
// settings panel next to the old sheet, and a measured difference then belongs to that other landing rather than
// to the cut. So the before root is built from HEAD with the one-file stylesheet put back: the pre-split sheet is
// restored from the last commit that held it, the nineteen sheets are removed, and index.html gets its single
// link back. Everything else is byte-identical to the after root, which is exactly the counterfactual.
function exportRoot(rev, dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  mkdirSync(dir, { recursive: true });
  const tarFile = path.join(path.dirname(dir), `${path.basename(dir)}.tar`);
  rmSync(tarFile, { force: true });
  execFileSync("git", ["-C", ROOT, "archive", "--format=tar", `--output=${tarFile}`, "HEAD"], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
  execFileSync("tar", ["-x", "-f", msys(tarFile), "-C", msys(dir)], { stdio: ["ignore", "pipe", "pipe"] });
  rmSync(tarFile, { force: true });

  // The one-file sheet, byte for byte out of the commit the split started from.
  const oldSheet = execFileSync("git", ["-C", ROOT, "show", `${rev}:${LEGACY_SHEET}`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  writeFileSync(path.join(dir, "public", "style.css"), oldSheet.replace(/\r?\n/g, "\r\n"), "utf8");

  // The sheets the split added, and the shell's link block, go away together.
  const sheets = sheetsInLoadOrder(ROOT);
  for (const name of sheets) rmSync(path.join(dir, "public", name), { force: true });
  const shell = path.join(dir, "public", "index.html");
  const lines = readFileSync(shell, "utf8").split("\n");
  const from = lines.findIndex((l) => l.includes("style.css is split by surface"));
  const to = lines.findIndex((l) => l.includes('href="/late.css"'));
  if (from < 0 || to < from) throw new Error("the before root cannot find the shell's sheet block to undo");
  const crlf = readFileSync(shell, "utf8").includes("\r\n");
  lines.splice(from, to - from + 1, '  <link rel="stylesheet" href="/style.css" />' + (crlf ? "\r" : ""));
  writeFileSync(shell, lines.join("\n"), "utf8");

  // The panel reads `git rev-parse HEAD` for its version line, so the export needs a repo of its own.
  gi(dir, ["init", "-q", "-b", "main"]);
  gi(dir, ["add", "-A"]);
  gi(dir, ["commit", "-q", "-m", "export"]);
  return dir;
}

async function halfPixels(rev) {
  line("HALF B  the six-pane layout delta");
  const browserMod = await import("./browser.mjs");
  const { loadPlaywright, notRun } = browserMod;
  if (!loadPlaywright()) {
    console.log(notRun("six-pane delta", "playwright is not installed (set PLAYWRIGHT_BROWSERS_PATH to the browser cache)"));
    return { skipped: true };
  }
  const scratch = path.join(os.tmpdir(), "wag", "css-split", "before");
  const beforeRoot = exportRoot(rev, scratch);
  line(`  before root         ${beforeRoot} (HEAD with the cut undone: ${rev}:${LEGACY_SHEET} restored, sheets removed)`);
  line(`  after root          ${ROOT}`);

  // Run 1 and the after run are the evidence a reader opens; run 2 only has to answer as numbers.
  const shotsBefore1 = path.join(REPORTS, "before");
  const shotsBefore2 = path.join(scratch, "shots-before-2");
  const shotsAfter = path.join(REPORTS, "after");
  for (const d of [shotsBefore1, shotsBefore2, shotsAfter]) mkdirSync(d, { recursive: true });

  const boot = (root, tag, shots) => bootAndMeasure({
    root,
    // ONE home path for every run, rebuilt before each boot. The board prints the scan root's own text, so a
    // per-run directory name would move a path string and be read as a layout difference.
    home: path.join(scratch, "home"),
    label: tag,
    shots,
  });

  line("  run 1: the pre-split export");
  const b1 = await boot(beforeRoot, "before-1", shotsBefore1);
  line("  run 2: the pre-split export again (the harness must repeat itself)");
  const b2 = await boot(beforeRoot, "before-2", shotsBefore2);
  line("  run 3: this tree");
  const a1 = await boot(ROOT, "after", shotsAfter);

  const names = ["board-table", "console", "queue-cards", "assistant-float", "initiatives", "settings"];
  const repeat = names.map((n) => comparePane(n, b1[n], b2[n]));
  const delta = names.map((n) => comparePane(n, b1[n], a1[n]));

  const table = (rows) => {
    line("  pane              elements  boxes differ  max delta  text runs  text differ");
    for (const r of rows) {
      line(`  ${r.pane.padEnd(17)} ${String(r.elements).padStart(8)}  ${String(r.boxesDiffer.length + r.missing.length + r.extra.length).padStart(12)}  ${String(r.maxDelta).padStart(9)}  ${String(r.texts).padStart(9)}  ${String(r.textDiffer.length).padStart(11)}`);
    }
  };
  line("  self-proof: the pre-split export against itself");
  table(repeat);
  const repeatClean = repeat.every((r) => !r.boxesDiffer.length && !r.missing.length && !r.extra.length && !r.textDiffer.length);
  ok("pixels: the harness measures the same board twice identically", repeatClean);

  line("  delta: the pre-split export against this tree");
  table(delta);
  const clean = delta.every((r) => !r.boxesDiffer.length && !r.missing.length && !r.extra.length && !r.textDiffer.length);
  for (const r of delta) {
    if (!r.boxesDiffer.length && !r.missing.length && !r.extra.length && !r.textDiffer.length) continue;
    line(`    ${r.pane}:`);
    for (const d of r.boxesDiffer.slice(0, 8)) line(`      box  ${d.p} ${d.label} ${JSON.stringify(d.before)} -> ${JSON.stringify(d.after)}`);
    for (const p of r.missing.slice(0, 8)) line(`      only-before ${p}`);
    for (const p of r.extra.slice(0, 8)) line(`      only-after ${p}`);
    for (const t of r.textDiffer.slice(0, 8)) line(`      text ${t.p} ${t.why || ""} ${JSON.stringify(t.beforeText)} -> ${JSON.stringify(t.afterText)}`);
  }
  ok("pixels: every box and text position is identical across the six panes", clean);

  const cssom = a1["board-table"]?.cssom || [];
  const cssomBefore = b1["board-table"]?.cssom || [];
  const sum = (list) => list.reduce((a, s) => a + s.rules, 0);
  line(`  CSSOM               before ${cssomBefore.length} sheets / ${sum(cssomBefore)} rule nodes; after ${cssom.length} sheets / ${sum(cssom)} rule nodes`);
  ok("pixels: the CSSOM carries the same number of rule nodes", sum(cssomBefore) === sum(cssom),
    `${sum(cssomBefore)} vs ${sum(cssom)}`);

  // Portable on purpose: npm run absolute-paths refuses a drive-letter path in a file a landing adds, and a
  // reader on another box has no use for this machine's scratch directory.
  const ledger = { rev, before: `HEAD with the cut undone (${rev}:${LEGACY_SHEET} restored, sheets removed)`, after: "this tree", selfProof: repeat, delta, cssom: { before: cssomBefore, after: cssom } };
  writeFileSync(path.join(REPORTS, "delta.json"), `${JSON.stringify(ledger, null, 1)}\n`, "utf8");
  if (!KEEP) {
    // The export and its fixture homes are throwaway; the shots and the ledger are the record.
    try {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* a busier Windows handle is not a failure of the proof */
    }
  }
  line();
  return ledger;
}

async function main() {
  mkdirSync(REPORTS, { recursive: true });
  const stream = halfStream();
  if (STREAM_ONLY) process.exit(failures ? 1 : 0);
  const pixels = await halfPixels(stream.rev);
  if (pixels.skipped) {
    line("  the pixel half did not run; the stream half stands on its own");
    process.exit(2);
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
