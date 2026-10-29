// The per-turn command audit: every line an assistant turn wrote in the panel's own vocabulary, reconciled
// against what the panel actually did with it.
//
// Two holes this closes, and they are shared by all eight kinds rather than owned by one:
//
//   1. A line that begins with a known prefix and misses that prefix's regex is dropped by `parseActions` with
//      no journal line at all — actions.js says so in its own header, and that is the whole reason this module
//      exists. `scanCommands` records such a line as `unparsed`, so it is captured rather than skipped.
//   2. `harvest` runs when a turn ENDS, so a restart mid-turn carried out nothing and said nothing. The parsed
//      side of the ledger is read from the turn's own lines, which outlive the process in the job store, so the
//      next sentry pass can reconcile a turn this process never harvested.
//
// What this module does NOT do: change the grammar, re-word the prompt, or decide what an action means. It
// reads `parseActions` for the parse; the caller writes each outcome down as it carries the line out. Nothing
// here is a second vocabulary — it is the same eight kinds, counted.
//
// One ledger entry per prefix line of one turn, in the order the turn wrote them:
//
//   { index, kind, line, parsed, outcome }
//
//   outcome null       the grammar read it, nothing has been done with it yet   -> MISSING
//   outcome "pending"  an action has claimed it and has not settled yet         -> MISSING
//   outcome "applied"  the panel did the thing
//   outcome "refused"  the panel declined it, with a journal line saying why
//
// An unparsed line is `parsed: false` and never counts as missing: nothing was ever going to be done with it,
// and its own `command-unparsed` journal line is the record.

import { clip } from "./read.js";
import { parseActions } from "./actions.js";

export const COMMAND_KINDS = ["to", "watch", "note", "spawn", "rule", "charter", "restart", "todo"];
// How many turns of ledger the file keeps: enough that a turn interrupted by a restart is still there when the
// next pass runs, few enough that assistant.json stays a scratchpad rather than a log.
export const COMMAND_AUDIT_CAP = 20;
// A turn older than this is history, not a turn this process is reconciling. Without the window the first pass
// after an upgrade would audit every command line ever written and raise a card for each: those turns were
// harvested before this audit existed, so their applied counts are zero through no fault of the panel.
export const COMMAND_AUDIT_WINDOW_MS = 60 * 60_000;

// A line is a command ATTEMPT when it begins with one of the vocabulary's own words, written the way the
// grammar block writes them — in capitals. That is what separates an attempt from prose: a paragraph opening
// "Note that the tree is dirty" is a sentence, while "NOTE the tree is dirty" is a line that meant `NOTE:` and
// missed its colon. `parseActions` is case-insensitive for most kinds, so a lower-case near-miss is the one
// shape this cannot see; every kind it does see keeps its own bucket, which is what the reconciliation counts.
const PREFIX = [
  ["to", /^\s*TO\b/],
  ["spawn", /^\s*SPAWN\b/],
  ["watch", /^\s*WATCH\b/],
  ["note", /^\s*NOTE\b/],
  ["rule", /^\s*RULE\b/],
  ["charter", /^\s*CHARTER\b/],
  ["restart", /^\s*RESTART\b/],
  ["todo", /^\s*TODO\b/],
];

export function commandPrefix(line) {
  const text = String(line ?? "");
  for (const [kind, re] of PREFIX) if (re.test(text)) return kind;
  return null;
}

// Every prefix line of a reply, in order, with the grammar's own verdict on each. One line at a time is the
// same answer the batch gets for every kind here: no operand of this grammar runs across a line break. A TODO
// line inherits the SPAWN above it, but that is a link BETWEEN lines, not an operand inside one — the parse of
// the line itself is identical either way.
export function scanCommands(text) {
  const out = [];
  const lines = String(text ?? "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const kind = commandPrefix(lines[i]);
    if (!kind) continue;
    const parsed = (parseActions(lines[i])[kind] || []).length > 0;
    out.push({ index: i, kind, line: clip(String(lines[i]).trim(), 300), parsed });
  }
  return out;
}

// The turn's ledger, opened from its own text. `job` only supplies identity: the turn id is what the sentry
// names in a card and what survives a restart.
export function newAudit(job, entries = [], at = new Date().toISOString()) {
  return {
    turn: String(job?.id || ""),
    thread: String(job?.thread || ""),
    startedAt: job?.startedAt || null,
    endedAt: job?.endedAt || null,
    at,
    // What was last said in the journal, per kind, so a gap that persists says it once instead of every pass.
    reported: {},
    lines: entries.slice(0, 240).map((e) => ({ index: e.index, kind: e.kind, line: e.line, parsed: Boolean(e.parsed), outcome: null })),
  };
}

// Claim the next line of one kind that nothing has settled yet. Each action claims its own line before it runs,
// so an action that never comes back leaves a `pending` line rather than a line that looks untouched.
export function claimLine(audit, kind) {
  if (!audit || !Array.isArray(audit.lines)) return null;
  const line = audit.lines.find((l) => l.kind === kind && l.parsed && (l.outcome === null || l.outcome === undefined));
  if (!line) return null;
  line.outcome = "pending";
  return line;
}

// The outcome an action reports. First answer wins: a body that refuses on its own (a busy thread, a missing
// worktree) settles the line before the caller's "it returned" gets a chance to call it applied.
export function settleLine(line, outcome) {
  if (!line || !["applied", "refused"].includes(outcome)) return false;
  if (line.outcome !== "pending" && line.outcome !== null && line.outcome !== undefined) return false;
  line.outcome = outcome;
  return true;
}

// Counts per kind: what the grammar read, what the panel did, what it declined, and what it never touched.
export function auditCounts(audit) {
  const counts = Object.fromEntries(COMMAND_KINDS.map((k) => [k, { parsed: 0, applied: 0, refused: 0, unparsed: 0, missing: 0 }]));
  for (const line of audit?.lines || []) {
    const c = counts[line.kind];
    if (!c) continue;
    if (!line.parsed) {
      c.unparsed += 1;
      continue;
    }
    c.parsed += 1;
    if (line.outcome === "applied") c.applied += 1;
    else if (line.outcome === "refused") c.refused += 1;
    else c.missing += 1;
  }
  return counts;
}

// The reconciliation the sentry makes: parsed exceeds applied-plus-refused, per kind. One entry per kind that
// has a line nothing accounts for, naming the lines themselves.
export function gaps(audit) {
  const counts = auditCounts(audit);
  const out = [];
  for (const kind of COMMAND_KINDS) {
    const c = counts[kind];
    if (!c.missing) continue;
    out.push({
      kind,
      parsed: c.parsed,
      applied: c.applied,
      refused: c.refused,
      missing: c.missing,
      unparsed: c.unparsed,
      lines: (audit?.lines || []).filter((l) => l.kind === kind && l.parsed && l.outcome !== "applied" && l.outcome !== "refused").map((l) => l.line),
    });
  }
  return out;
}

// What the file hands back: only well-formed entries survive, and the ordering is the turn's own. Nothing here
// trusts the file, for the same reason store-file.js does not.
export function readAudits(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a) => a && typeof a === "object" && typeof a.turn === "string" && a.turn)
    .slice(-COMMAND_AUDIT_CAP)
    .map((a) => ({
      turn: a.turn,
      thread: typeof a.thread === "string" ? a.thread : "",
      startedAt: typeof a.startedAt === "string" ? a.startedAt : null,
      endedAt: typeof a.endedAt === "string" ? a.endedAt : null,
      at: typeof a.at === "string" ? a.at : null,
      reportedAt: typeof a.reportedAt === "string" ? a.reportedAt : null,
      reported: a.reported && typeof a.reported === "object" ? { ...a.reported } : {},
      replay: a.replay && typeof a.replay === "object" && typeof a.replay.at === "string" ? { at: a.replay.at } : null,
      replayedAt: typeof a.replayedAt === "string" ? a.replayedAt : null,
      lines: Array.isArray(a.lines)
        ? a.lines
            .filter((l) => l && typeof l === "object" && COMMAND_KINDS.includes(l.kind))
            .slice(0, 240)
            .map((l) => ({
              index: Number(l.index) || 0,
              kind: l.kind,
              line: typeof l.line === "string" ? l.line.slice(0, 300) : "",
              parsed: Boolean(l.parsed),
              outcome: ["applied", "refused", "pending"].includes(l.outcome) ? l.outcome : null,
            }))
        : [],
    }));
}
