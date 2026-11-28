// The parent line on a REAL board: the five sayings, each proved on a tree the panel is actually reading.
//
//   node tools/verify-parent-line.mjs                 # the panel's live snapshot (127.0.0.1:7331)
//   node tools/verify-parent-line.mjs --json          # the same, machine-readable (what the report embeds)
//   node tools/verify-parent-line.mjs --rows saved.json --state <dir>
//
// WHAT IT PROVES. Every worktree row's Merge state block prints one line about where the tree was cut from
// (lib/parent-line.js). This harness reads the SAME three sources the row does - the panel's scanned rows, the cut
// book (`branch-parents.json`, through lib/worktrees.js `recordedParentFor`) and the parent book (`parents.json`,
// lib/parents.js) - picks one REAL tree for each saying, and prints the exact sentence and the exact list item the
// block draws for it. Then it asserts the promise each saying makes:
//
//   recorded       the cut book has the tree, and the line says "cut from <branch>" with the record named in its title;
//   reconstructed  the cut book has NOTHING, the parent book says backfilled, and the line says it was reconstructed;
//   unknown        neither source answers, the line reads unknown, and the title carries the reason;
//   base           the record names a main branch, and the line names it as the project base, never as a parent;
//   turnover       the row IS the project's turnover branch, and the line says nothing sits above it.
//
// READ ONLY and bounded: one GET of /api/state with a 15s abort, two JSON reads, no git. It never posts, never starts
// a run and never asks the panel to change a worktree. Exits 0 only when all five sayings were found and held.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parentLineFor, parentLineItemHtml } from "../lib/parent-line.js";
import { recordedParentFor } from "../lib/worktrees.js";

const arg = (flag) => {
  const at = process.argv.indexOf(flag);
  return at > -1 ? process.argv[at + 1] : null;
};
const JSON_OUT = process.argv.includes("--json");
const BASE = (arg("--base") || process.env.PANEL_BASE || "http://127.0.0.1:7331").replace(/\/+$/, "");
const STATE = arg("--state") || path.join(os.homedir(), ".wag", "state");
const ROWS_FILE = arg("--rows");

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const norm = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

async function rowsFromPanel() {
  if (ROWS_FILE) return readJson(ROWS_FILE);
  const res = await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GET ${BASE}/api/state answered ${res.status}`);
  return res.json();
}

// One row per worktree, carrying the project's own turnover list so the container saying can be decided here exactly as
// server.js `withParentLines` decides it.
function flatten(snapshot) {
  const out = [];
  for (const project of snapshot.projects || []) {
    const turnovers = new Set(
      [...(project.turnoverBranches || []).map((e) => (e && e.branch) || e), project.turnoverBranch || ""]
        .map((b) => String(b ?? "").trim().toLowerCase())
        .filter(Boolean),
    );
    for (const row of project.worktrees || []) {
      out.push({ project: project.name, checkout: norm(project.path), turnovers, row });
    }
  }
  return out;
}

const isCheckout = (entry) => entry.checkout && entry.checkout === norm(entry.row.path);

function lineFor(entry, book, records) {
  const branch = String(entry.row.branch || "").trim();
  const rec = records.get(`${entry.project}::${branch}`) || null;
  return parentLineFor({
    book,
    tree: entry.row.path,
    branch,
    parent: (rec && rec.parent) || entry.row.parent || null,
    parentSource: (rec && rec.parentSource) || entry.row.parentSource || "unknown",
    why: (rec && rec.why) || "",
    refused: (rec && rec.refused) || "",
    mainBranch: (entry.mainBranch || null) || null,
    turnover: Boolean(branch) && entry.turnovers.has(branch.toLowerCase()),
  });
}

// The evidence each saying must carry, in one sentence - quoted from the books, never a whole file dump.
function evidenceFor(entry, book, records) {
  const branch = String(entry.row.branch || "").trim();
  const recorded = recordedParentFor(book, { tree: entry.row.path, branch });
  const rec = records.get(`${entry.project}::${branch}`) || null;
  return {
    tree: entry.row.path,
    project: entry.project,
    branch,
    cutEntry: recorded ? { key: recorded.key, parent: recorded.parent, branch: recorded.branch, at: (book[recorded.key] || {}).at || null } : null,
    parentRecord: rec
      ? { parent: rec.parent || null, parentSource: rec.parentSource || "unknown", why: rec.why || "", refused: rec.refused || null }
      : null,
  };
}

function pick(entries, book, records, want) {
  const candidates = entries.filter((e) => !isCheckout(e)).map((e) => ({ e, line: lineFor(e, book, records), ev: evidenceFor(e, book, records) }));
  const matching = candidates.filter((c) => c.line.kind === want.kind);
  if (want.kind === "unknown") {
    // Prefer a reason that names the refusal ("not a local branch"), then a tie; both say WHY, which is the saying.
    matching.sort((a, b) => {
      const score = (c) => (/not a local branch/.test(c.ev.parentRecord?.why || "") ? 3 : /ambiguous/.test(c.ev.parentRecord?.why || "") ? 2 : c.ev.parentRecord?.why ? 1 : 0);
      return score(b) - score(a);
    });
  }
  if (want.kind === "recorded" || want.kind === "reconstructed") {
    // Prefer a tree of the project this row works for, and first of all the tree this harness is run from, so the
    // proof is of the board the reader is looking at rather than of whichever row happened to sort first.
    const here = norm(process.cwd());
    matching.sort((a, b) => {
      const score = (c) => (norm(c.e.row.path) === here ? 2 : c.e.project === "agent-worktree-gui" ? 1 : 0);
      return score(b) - score(a);
    });
  }
  return matching[0] || null;
}

const book = readJson(path.join(STATE, "branch-parents.json"));
const parentsFile = readJson(path.join(STATE, "parents.json"));
const records = new Map((parentsFile.records || []).filter((r) => r && r.project && r.branch).map((r) => [`${r.project}::${r.branch}`, r]));
const snapshot = await rowsFromPanel();
const entries = flatten(snapshot).map((e) => ({ ...e, mainBranch: (snapshot.projects.find((p) => p.name === e.project) || {}).mainBranch || null }));

const SAYINGS = [
  { kind: "recorded", name: "a recorded parent" },
  { kind: "reconstructed", name: "a reconstructed parent" },
  { kind: "unknown", name: "an unknown parent" },
  { kind: "base", name: "a main/master base" },
  { kind: "turnover", name: "a turnover container" },
];

let failures = 0;
const cases = [];
for (const saying of SAYINGS) {
  const found = pick(entries, book, records, saying);
  if (!found) {
    failures += 1;
    cases.push({ kind: saying.kind, name: saying.name, found: false, why: `no live tree on this board reads as ${saying.kind}` });
    continue;
  }
  const line = found.line;
  const html = parentLineItemHtml(line);
  const checks = [];
  const check = (ok, text) => checks.push({ ok: Boolean(ok), text });
  if (saying.kind === "recorded") {
    check(found.ev.cutEntry, "the cut book records this tree");
    check(/^cut from /.test(line.text) && !/reconstruct|not recorded/.test(line.text), "the line says cut from, with no reconstruction wording");
    check(/branch-parents\.json/.test(line.title), "the title names the record it came from");
  }
  if (saying.kind === "reconstructed") {
    check(!found.ev.cutEntry, "the cut book has no record for this tree");
    check(found.ev.parentRecord && found.ev.parentRecord.parentSource === "backfilled", "the parent book says backfilled");
    check(/reconstructed/.test(line.text) && /not recorded/.test(line.text), "the line says reconstructed, not recorded");
  }
  if (saying.kind === "unknown") {
    check(!found.ev.cutEntry, "the cut book has no record for this tree");
    check(!found.ev.parentRecord || found.ev.parentRecord.parentSource !== "backfilled", "no reconstruction names a parent");
    check(line.text === "unknown - no cut record and its reflog names no local branch", "the line reads unknown");
    check(line.title !== line.text, "the title carries the reason");
  }
  if (saying.kind === "base") {
    check(/^(main|master|trunk|develop)$/i.test(found.ev.cutEntry?.parent || ""), "the record names a main branch");
    check(/never a child's parent/.test(line.text), "the line says a main branch is never a child's parent");
    check(!/^cut from (main|master|trunk|develop)$/.test(line.text), "it is not printed as a plain parent");
  }
  if (saying.kind === "turnover") {
    check(found.e.turnovers.has(String(found.e.row.branch).toLowerCase()), "the row is the project's turnover branch");
    check(line.text === "turnover container - nothing above it", "the line says nothing sits above it");
    check(!/cut from/.test(line.text), "no parent is named");
  }
  if (checks.some((c) => !c.ok)) failures += 1;
  cases.push({ kind: saying.kind, name: saying.name, found: true, ...found.ev, line, html, checks });
}

if (JSON_OUT) {
  console.log(JSON.stringify({ base: BASE, state: STATE, generatedAt: new Date().toISOString(), cases, failures }, null, 1));
} else {
  console.log(`parent line, from ${BASE}/api/state and ${STATE}`);
  for (const c of cases) {
    if (!c.found) {
      console.log(`\n${c.kind}: ${c.why}`);
      continue;
    }
    console.log(`\n${c.kind} - ${c.name}`);
    console.log(`  tree     ${c.project} ${c.branch}`);
    console.log(`           ${c.tree}`);
    console.log(`  record   ${c.cutEntry ? `branch-parents.json ${c.cutEntry.key} -> ${c.cutEntry.parent}` : "no cut record"}`);
    console.log(`  parent   ${c.parentRecord ? `${c.parentRecord.parentSource}: ${c.parentRecord.why || "(no reason)"}` : "no parent-book record"}`);
    console.log(`  line     ${c.line.text}`);
    console.log(`  title    ${c.line.title}`);
    for (const k of c.checks) console.log(`  ${k.ok ? "ok  " : "FAIL"} ${k.text}`);
  }
}
if (failures) {
  console.error(`\n${failures} saying(s) missing or not held`);
  process.exit(1);
}
