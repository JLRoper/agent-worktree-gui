// Consolidate one assistant's standing rules, against the panel's own state directory, with the reader's grant.
//
// This is the pass docs/design/prompt-tiers-2026-11-08.md section 5 describes, run from a checkout instead of from
// a turn: the same lib/assistant/consolidate.js doors, the same lib/assistant.js `consolidateRulesFor`, so the
// snapshot, the provenance and the refusals are the shipped ones and not a second implementation. It exists
// because a pass over the LIVE store has to run with the panel stopped (two writers on one store is the defect
// this tool refuses), and because a plan is a file a reviewer can read before it is applied.
//
// The order is the design's: GRANT, then the pass (which writes its snapshot first), then the charter trim. The
// trim is the last step because the pass appends the moved rules and its summary to the charter; trimming first
// would let the pass's own entries be the ones a later prune eats. It drops the two frozen seed sections the
// design says to drop, then the OLDEST changelog entries, and never a line above the changelog heading.
//
//   node tools/consolidate-rules.mjs --assistant assistant-2 --plan docs/design/.../assistant-2.plan.json \
//     --grant --charter-target 17600
//
// `--dry-run` validates and prints the report with no write, and `--grant` is the reader's press made explicit:
// without it, an ungranted record refuses the pass by name.
import { readFileSync } from "node:fs";
import path from "node:path";
import { Assistant } from "../lib/assistant.js";
import { briefingRules } from "../lib/assistant/rules.js";
import { CHARTER_HEADING, CHARTER_MAX_CHARS } from "../lib/charter.js";
import { statePaths } from "../lib/paths.js";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const next = process.argv[i + 1];
  args.set(a.slice(2), next && !next.startsWith("--") ? next : true);
}

const dataDir = String(args.get("data-dir") || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".wag"));
const assistantId = String(args.get("assistant") || "assistant-2");
const planFile = args.get("plan") ? String(args.get("plan")) : "";
const dryRun = args.get("dry-run") === true;
const grant = args.get("grant") === true;
const trimOnly = args.get("trim-only") === true;
const target = Number(args.get("charter-target") || 17_600);
const port = Number(args.get("port") || 7331);
if (!planFile && !trimOnly) {
  console.error("usage: node tools/consolidate-rules.mjs --assistant <id> --plan <file> [--grant] [--dry-run] [--charter-target <chars>]");
  process.exit(2);
}

// ONE WRITER. The running panel holds the same records in memory and rewrites assistants.json from them on the
// next record change, so a pass applied under it is silently reverted. A DRY RUN writes nothing, so it is allowed
// beside a live panel; anything that writes refuses, and says how to make it safe.
try {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 700);
  const res = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: ac.signal });
  clearTimeout(timer);
  if (res.ok && !dryRun) {
    console.error(`refused: a panel is serving on ${port} and holds these records in memory - stop it (stop-background.cmd), run this, then start it again.`);
    process.exit(3);
  }
  if (res.ok && dryRun) console.log(`note: a panel is serving on ${port}; this is a dry run, so nothing is written.`);
} catch {
  /* nothing serving: the store has one writer, this process */
}

const state = statePaths({ dataDir });
const assistant = new Assistant({
  config: {
    dataDir,
    jobsFile: state.jobsFile,
    assistantFile: state.assistantFile,
    charterFile: state.charterFile,
    rolesFile: state.rolesFile,
    assistantsFile: state.assistantsFile,
    logsDir: state.logsDir,
  },
  jobs: { list: () => [], firstOfThread: () => null, create: async (b) => b },
  getProjects: () => [],
  getRows: () => [],
  onLog: (m) => console.log(`log: ${m}`),
});

const rec = assistant.assistantRecord(assistantId);
if (!rec) {
  console.error(`no such assistant: ${assistantId}`);
  process.exit(2);
}

const bytes = (s) => Buffer.byteLength(String(s || ""), "utf8");
let snapshot = "";
const before = {
  rules: assistant.rulesFor(rec.id).length,
  block: bytes(assistant.systemBriefing(rec.id)),
  charter: String(assistant.charterTextFor(rec.id) || "").length,
  window: briefingRules(assistant.rulesFor(rec.id)),
};
console.log(`\n== ${rec.name} (${rec.id}) before`);
console.log(`   rules ${before.rules}, shown ${before.window.rules.length}, left out ${before.window.leftOut}`);
console.log(`   system block ${before.block} bytes, charter ${before.charter} chars`);

if (!trimOnly) {
  const body = JSON.parse(readFileSync(planFile, "utf8"));
  const plan = body.plan || body;
  if (grant) {
    const g = assistant.setConsolidationGrant(rec.id, true);
    console.log(`   grant: ${g.granted ? "given by the reader's press" : "refused"}`);
  }
  const out = assistant.consolidateRulesFor(rec.id, { plan, dryRun });
  if (dryRun) {
    console.log(`\n   DRY RUN: ${out.counts ? JSON.stringify(out.counts) : ""}`);
    console.log(`   ${out.before.rules} rules -> ${out.after.rules}, ${out.before.chars} -> ${out.after.chars} chars; window would leave out ${out.leftOut}`);
    for (const op of out.ops) console.log(`   - ${op.op} ${(op.ids || []).join(",")}${op.id && op.id !== op.ids[0] ? ` -> ${op.id}` : ""}`);
    process.exit(0);
  }
  snapshot = String(out.snapshot || "");
  console.log(`\n   pass: ${JSON.stringify(out.counts)}`);
  console.log(`   rules ${out.before.rules} -> ${out.after.rules}; window leaves out ${out.leftOut}; snapshot ${snapshot}`);
  console.log(`   charter now ${out.charterChars} chars, prompt ${out.promptChars} chars`);
}

// ---- the charter trim ---------------------------------------------------------------------------
// The two frozen copies the design drops (the store is the authority), then the oldest changelog entries until
// the file is at the target. Nothing above the changelog heading is cut: that is the reader's prose.
let charter = String(assistant.charterTextFor(rec.id) || "");
const droppedSections = [];
for (const name of ["Standing rules carried over", "Scratchpad notes carried over"]) {
  const at = charter.indexOf(`## ${name}`);
  if (at < 0) continue;
  const next = charter.indexOf("\n## ", at + 3);
  const end = next < 0 ? charter.length : next + 1;
  charter = charter.slice(0, at) + charter.slice(end);
  droppedSections.push(name);
}
let droppedEntries = 0;
const head = charter.indexOf(CHARTER_HEADING);
if (charter.length > target && head >= 0) {
  const cut = head + CHARTER_HEADING.length;
  const beforePart = charter.slice(0, cut);
  const entries = charter.slice(cut).split("\n").filter((l) => l.trim());
  while (entries.length && beforePart.length + entries.join("\n").length + 2 > target) {
    entries.shift();
    droppedEntries += 1;
  }
  charter = `${beforePart}\n${entries.join("\n")}\n`;
}
if (charter.length > CHARTER_MAX_CHARS) {
  console.error(`refused: the trimmed charter is ${charter.length} chars, over the ${CHARTER_MAX_CHARS} cap`);
  process.exit(4);
}
if (!dryRun && (droppedSections.length || droppedEntries || charter.length !== before.charter)) {
  assistant.setCharterFor(rec.id, charter, "consolidate");
}
console.log(`\n   charter trim: ${droppedSections.length ? `dropped ${droppedSections.join(" + ")}; ` : ""}${droppedEntries} oldest entries; ${before.charter} -> ${charter.length} chars`);

// ---- after ---------------------------------------------------------------------------------------
const afterRules = assistant.rulesFor(rec.id);
const afterWindow = briefingRules(afterRules);
const afterBlock = bytes(assistant.systemBriefing(rec.id));
const profile = assistant.profileOf(rec.id);
console.log(`\n== ${rec.name} after`);
console.log(`   rules ${afterRules.length}, shown ${afterWindow.rules.length}, left out ${afterWindow.leftOut}`);
console.log(`   system block ${afterBlock} bytes (${afterBlock - before.block}), charter ${String(assistant.charterTextFor(rec.id) || "").length} chars, prompt ${String(profile.prompt || "").length} chars (${profile.promptBy || "empty"})`);
console.log(`   snapshot dir: ${assistant.consolidationDir().replace(/\\/g, "/")}${snapshot ? ` (this pass: ${snapshot.replace(/\\/g, "/")})` : ""}`);
for (const r of afterRules) {
  console.log(`   ${r.id} · ${r.by}${r.safety ? " · safety" : ""}${r.rewritten ? " · rewritten(" + (r.rewrittenFrom || []).join(",") + ")" : ""} · ${r.text.length} · ${r.text}`);
}
