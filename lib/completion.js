// The completion notice: what a worker this panel spawned actually produced.
//
// The panel used to wake the board assistant with three things — the thread's title, the status word its
// card had settled on, and the watch text. That says something finished and nothing about what it made, so
// the assistant answered "the deploy watch finished" and could not tell a worker that shipped a fix from one
// that died on its first command. This module is the rest of it: the run's own last words, how it ended and
// on whose authority, how long it took, where it worked, whether it left anything behind to merge, and the
// report the worker wrote if it wrote one.
//
// Two facts a notice is not allowed to invent.
//
//   1. The exit status. It is read from the run's terminal RESULT — the event (and pollable status) the
//      gateway publishes when a turn ends. `exit_code` when the carrier has one: `hermes chat --format
//      stream-json` ended every turn with `{"type":"result","exit_code":n}`, the Runs API puts the same fact
//      in its terminal event's structured fields (`completed`, `interrupted`, `partial`, `turn_exit_reason`),
//      and a patched gateway may publish the number itself. What it is never derived from is the absence of
//      an error: "nothing was reported" is not an exit code, and a run that was killed is not a run that
//      finished. Hence the three words below, and no fourth.
//
//   2. Whether a run was killed. Only the process's own termination says that — the panel's wall-clock cap
//      firing, a stop from the card, the gateway shutting down. A turn that failed by itself is `failed`
//      even though nothing was killed, and a killed run never reads `done`.
//
// A notice is also only ever built for a turn whose terminal result has arrived. A run that is merely idle
// at its prompt — still live, printing nothing — is not a completion, and `one wake per terminal result` is
// the assistant's side of that promise (see `terminalKey`).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
// The TODO grammar and store live in lib/todos.js; this module only carries the harvested lines into a run's
// completion payload so the panel can apply them (jobs.finalise) and SAY what it refused (the card).
import { parseTodoLines } from "./todos.js";

// The three words a completion notice may use. `done` is not one of them: it is the card's word for a turn
// that settled, and it was the word a killed run used to arrive under.
export const OUTCOMES = ["normal", "failed", "interrupted"];

// The tail a notice falls back to when the run published no final message at all — a killed turn has no
// answer of its own, and its transcript is then the only record of what it was doing.
export const TAIL_LINES = 40;

const NOTICE_CAP = 8000; // what rides in the wake text: enough for a report, not a whole console
const FINAL_CAP = 4000; // the run's own last message, as the notice quotes it
const TAIL_CAP = 6000; // the fallback transcript
const REPORT_CAP = 12000; // a worker's report is inlined; past this it is quoted with a note

// The same strip the console applies to streamed text (lib/jobs.js): a model can put colour in a tool's
// output, and the assistant reads the notice as text, not as a terminal.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;
export const stripAnsi = (s) => String(s ?? "").replace(ANSI_RE, "");

const oneLine = (s, n = 160) => {
  const t = stripAnsi(s).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const cap = (s, n) => (String(s ?? "").length > n ? String(s).slice(0, n) : String(s ?? ""));

// A measured number, or null for "nobody measured it". `Number(null)` is 0 and `Number.isFinite(0)` is true,
// which is how "the tree could not be read" became "the run left no commits": an unmeasured fact must not
// arrive as a measurement of zero.
const numOrNull = (v) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

// `15m 2s` rather than the panel's coarser `15m`: the notice is read next to the card's clock, and a worker
// that ran for 9000ms and one that ran for 9 minutes are different stories.
export function durationText(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return null;
  const s = n / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  if (m < 60) return `${m}m ${String(rest).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m - h * 60).padStart(2, "0")}m`;
}

// What the panel did to the run, when the panel is the one that ended it. Shape: { by, detail, at }.
const TERMINATION_TEXT = {
  cap: (t) => `killed by the panel: the run passed its ${t.seconds || "?"}s wall-clock cap`,
  reader: () => "stopped from the panel",
  gateway: (t) => `the gateway ended it${t.detail ? `: ${t.detail}` : ""}`,
  restart: () => "the panel restarted while this turn was running",
};

// The exit status, from the run's own terminal result plus the process's own termination.
//
// `run` is the terminal event or the polled status object. `runStatus` is the word the run settled on
// (`completed` / `failed` / `cancelled` / `interrupted`). `termination` is the panel's record of ending it
// itself, or null. Returns { word, exitCode, source, reason }.
export function outcomeFrom({ runStatus = "", run = {}, termination = null } = {}) {
  const raw = run?.exit_code ?? run?.exitCode;
  const published = raw !== undefined && raw !== null && raw !== "";
  const exitCode = published && Number.isFinite(Number(raw)) ? Number(raw) : null;
  const source = published ? "the run's result event" : null;
  const status = String(runStatus || "");

  // 1. The run finished. The gateway's terminal result says so and nothing contradicts it: a `completed` that
  //    carries a non-zero exit code did not finish cleanly, and `partial` is the iteration budget running out.
  if (status === "completed" && !run?.partial && (!published || exitCode === 0)) {
    return { word: "normal", exitCode: exitCode === null ? 0 : exitCode, source: source || "the run's completed result", reason: "" };
  }

  // 2. It did not finish, and the panel is why. This is the process's own termination, and it is the only
  //    thing that makes a run `interrupted` rather than `failed`.
  if (termination) {
    const text = TERMINATION_TEXT[termination.by] ? TERMINATION_TEXT[termination.by](termination) : `the panel ended it (${termination.by || "unknown"})`;
    return { word: "interrupted", exitCode, source: source || "the panel's own stop", reason: text };
  }

  // 3. The gateway's own verdict: a shutdown interrupts a run, a stop cancels it. Both are "something other
  //    than the turn finishing ended this".
  if (run?.interrupted === true || status === "interrupted" || status === "cancelled") {
    const why = run?.error || (status === "cancelled" ? "the run was cancelled" : "the run was interrupted");
    return { word: "interrupted", exitCode, source: source || "the run's terminal status", reason: String(why) };
  }

  // 4. A published exit code decides normal vs failed on its own — the number is the measurement, not the
  //    presence or absence of an error string.
  if (published) {
    return {
      word: exitCode === 0 ? "normal" : "failed",
      exitCode,
      source,
      reason: exitCode === 0 ? "" : `exit code ${exitCode}${run?.turn_exit_reason ? ` (${run.turn_exit_reason})` : ""}`,
    };
  }

  // 5. No number and no interruption: the run's structured result is what is left, and a turn that did not
  //    report completion did not finish its work.
  const why = run?.turn_exit_reason || run?.error || (run?.partial ? "the turn ended before it finished (partial)" : "") || `the run ended as ${status || "unknown"}`;
  return { word: "failed", exitCode: null, source: "the run's result event", reason: String(why) };
}

// The card's word for a settled turn, mapped into the three the notice may use. Only for a turn from a store
// written before the payload existed (or one the panel never saw a result for): otherwise `job.outcome` is
// the answer, and it was read from the run itself.
export function wordForStatus(status) {
  const s = String(status || "").toLowerCase();
  if (s === "done" || s === "completed") return "normal";
  if (s === "interrupted" || s === "cancelled" || s === "killed") return "interrupted";
  return "failed";
}

// One terminal result, one notice: this key is what the assistant dedupes a thread's wakes on. It names the
// turn AND the moment it ended, so a second turn of the same thread (a reply, a revive) is a new terminal
// event, while the same turn seen by a second rule — a watch finishing and a cut-off turn are the same
// finish — is not.
export function terminalKey(job) {
  if (!job) return null;
  const ended = job.endedAt || (job.lines || []).at?.(-1)?.at || "";
  return `${job.thread || ""}|${job.id || ""}|${ended}`;
}

// A job line as one string, the way the console draws it: the glyph and the command for a call, the text of
// a tool's output, the paragraph a streamed delta grew into.
export function lineText(line) {
  return stripAnsi(line?.text ?? "").replace(/[ \t]+$/, "");
}

// The run's own prose is already coalesced by the console: `push()` grows ONE line per paragraph as deltas
// arrive — keeping it where it started no matter what lands in between — and replaces it when a phase re-sends
// everything so far instead of a fragment. A tail built from those lines is therefore already coalesced; this
// applies the same rule once more so a transcript that reached the store some other way (an older file, a
// restored turn) reads the same way, and so a re-sent paragraph can never appear twice in a notice.
export function coalesceLines(lines = []) {
  const out = [];
  let open = -1; // the paragraph still being grown, wherever it sits in `out`
  for (const line of lines) {
    const text = lineText(line);
    if (line?.kind === "text") {
      // A fragment that opens with a blank line starts a new paragraph; anything else belongs to the open one.
      const startsParagraph = /^\s*\r?\n\s*\r?\n/.test(text);
      const prev = open >= 0 ? out[open] : null;
      if (prev && !startsParagraph) {
        if (!text.trim()) continue;
        const cumulative = text.length >= prev.text.length && text.trimStart().startsWith(prev.text.trimStart());
        prev.text = cumulative ? text.replace(/^\s*\n+/, "") : prev.text + text;
        continue;
      }
      const grown = text.replace(/^\s*\n+/, "");
      if (!grown.trim()) continue;
      out.push({ kind: "text", text: grown, at: line?.at });
      open = out.length - 1;
      continue;
    }
    // A result line closes the paragraph being grown, the same way it does on the console.
    if (line?.kind === "result" || line?.kind === "init") open = -1;
    const shown = text.replace(/\s+$/, "");
    if (!shown.trim() && line?.kind !== "cmd") continue;
    out.push({ kind: line?.kind || "raw", text: shown, at: line?.at });
  }
  return out;
}

// The last `maxLines` lines of a transcript, as text. The tail keeps its newest lines and drops the oldest:
// what a worker was doing when it stopped is the part a reader can still act on.
export function tailText(lines = [], { maxLines = TAIL_LINES, maxChars = TAIL_CAP } = {}) {
  const kept = coalesceLines(lines).filter((l) => l.text.trim());
  const shown = kept.slice(-maxLines);
  let text = shown.map((l) => l.text).join("\n");
  let cut = kept.length - shown.length;
  if (text.length > maxChars) {
    text = text.slice(text.length - maxChars);
    cut += 1;
  }
  return { text, lines: shown.length, omitted: Math.max(0, cut) };
}

// The worker's final message, or the last forty lines of its transcript when the run published none. A
// carried `finalMessage` is the run's own last word (the gateway's terminal `output`); a killed run has no
// such word, and its transcript is what the panel watched it do.
export function lastWords({ finalMessage = "", lines = [], maxLines = TAIL_LINES, maxChars = FINAL_CAP } = {}) {
  const said = stripAnsi(finalMessage).trim();
  if (said) {
    const cut = said.length > maxChars;
    // Harvest the TODO lines a worker wrote in its FINAL message — the one place the panel reads its report from.
    // They are only PARSED here: jobs.finalise owns the store and applies them, and refuses an unknown id or a
    // malformed line out loud on the card rather than dropping it. The transcript tail is deliberately NOT
    // harvested: the worker's brief (with its TODO instructions) is in there, and re-reading it would add the
    // instructions back as items.
    const todo = parseTodoLines(said);
    return { source: "the worker's final message", text: cut ? `${said.slice(0, maxChars)}\n… (final message truncated)` : said, lines: 0, omitted: 0, truncated: cut, todo };
  }
  const tail = tailText(lines, { maxLines, maxChars });
  if (!tail.text.trim()) return { source: "the worker's final message", text: "", lines: 0, omitted: 0, truncated: false, todo: [] };
  const head = `the last ${tail.lines} line${tail.lines === 1 ? "" : "s"} of its transcript${tail.omitted ? ` (${tail.omitted} earlier line${tail.omitted === 1 ? "" : "s"} dropped)` : ""} — this run published no final message`;
  return { source: head, text: tail.text, lines: tail.lines, omitted: tail.omitted, truncated: false, todo: [] };
}

// The repo a worker's report belongs to: the directory the run was started from, then the tree it worked in.
// Both are tried because a tree is a checkout of the repo, and a report written by hand may sit in either.
export function reportRepos(job = {}) {
  const seen = new Set();
  const out = [];
  for (const p of [job.projectPath, job.ownerPath, job.worktreePath, job.cwd]) {
    const clean = String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (!clean || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    out.push(clean);
  }
  return out;
}

// `<repo>/.agentboard/settlers-reports/<thread-slug>.md`, and nothing else is the report of a run. The
// thread's own name IS the slug a worker writes under (measured: the worktree panel thread
// `wtgui-settlers-game-mode-phase-0-r-837f42` left `.agentboard/settlers-reports/wtgui-settlers-game-mode-phase-0-r-837f42.md`),
// so it is tried first; the tree and branch names are tried after it, for a report filed under the tree.
export function reportCandidates(job = {}) {
  const leaf = (s) => String(s || "").split(/[\\/]/).filter(Boolean).at(-1) || "";
  const names = [];
  for (const n of [job.thread, String(job.thread || "").replace(/^wtgui-/, ""), leaf(job.branch), leaf(job.worktreePath)]) {
    const clean = String(n || "").trim();
    if (clean && !names.includes(clean)) names.push(clean);
  }
  const out = [];
  for (const repo of reportRepos(job)) for (const n of names) out.push(path.join(repo, ".agentboard", "settlers-reports", `${n}.md`));
  return out;
}

// The report file, inlined. Returns null when the run wrote none — which is the normal case, so the notice
// says nothing about it rather than saying "no report".
export function readReport(job = {}, { cap: limit = REPORT_CAP } = {}) {
  for (const file of reportCandidates(job)) {
    try {
      if (!existsSync(file)) continue;
      const raw = readFileSync(file, "utf8");
      const truncated = raw.length > limit;
      return {
        path: file.split("\\").join("/"),
        text: truncated ? `${raw.slice(0, limit)}\n… (report truncated at ${limit} characters)` : raw,
        bytes: raw.length,
        truncated,
      };
    } catch {
      /* an unreadable report is a report that is not there */
    }
  }
  return null;
}

// Assemble the payload from a job the panel has already measured (jobs.js does the git and the file reads).
// Everything here is a pure function of what that measurement found, so a notice is testable without a
// gateway, a repo or a browser.
export function completionPayload(job = {}, { now = Date.now() } = {}) {
  const outcome = job.outcome && OUTCOMES.includes(job.outcome.word)
    ? job.outcome
    : { word: wordForStatus(job.status), exitCode: null, source: null, reason: job.error || "" };
  const started = Date.parse(job.startedAt || "");
  const ended = Date.parse(job.endedAt || "");
  const measured = numOrNull(job.durationMs);
  const elapsed = measured !== null
    ? measured
    : Number.isFinite(started) && Number.isFinite(ended)
      ? Math.max(0, ended - started)
      : null;
  const tree = job.tree || null;
  const worktree = job.worktreePath || job.ownerPath || (tree && tree.path) || null;
  const branch = (tree && tree.branch) || job.branch || null;
  const name = oneLine(job.label || job.title || job.thread || "agent", 60).replace(/^Subagent:\s*/i, "");
  const commits = numOrNull(tree && tree.commits);
  return {
    thread: job.thread || null,
    id: job.id || null,
    turn: job.turn ?? null,
    name,
    at: job.endedAt || new Date(now).toISOString(),
    word: outcome.word,
    exitCode: outcome.exitCode,
    exitSource: outcome.source,
    reason: outcome.reason || "",
    durationMs: elapsed,
    duration: durationText(elapsed),
    branch,
    worktree,
    treeExists: tree ? tree.exists !== false : null,
    treeNote: tree?.note || "",
    dirty: numOrNull(tree && tree.dirty),
    untracked: numOrNull(tree && tree.untracked),
    commits: commits === null
      ? null
      : { count: commits, base: tree.base || null, subjects: Array.isArray(tree.subjects) ? tree.subjects : [] },
    final: lastWords({ finalMessage: job.finalMessage, lines: job.lines }),
    report: job.report || null,
  };
}

// Whether a run left anything behind, in the terms the reader has to decide with. It is the pair that has to
// be distinguishable: nothing committed is not "a worker that finished", and a tree that is gone is not a
// tree holding work to merge.
export function commitsLine(payload = {}) {
  const c = payload.commits;
  if (!c) {
    return payload.treeNote ? `commits not measured (${oneLine(payload.treeNote, 120)})` : "commits not measured";
  }
  if (c.count === 0) {
    return `left no commits — nothing to merge${payload.treeExists === false ? " (its worktree is no longer on disk)" : ""}`;
  }
  const shown = c.subjects.slice(0, 4).map((s) => oneLine(s, 90)).join(" · ");
  return `left ${c.count} commit${c.count === 1 ? "" : "s"} not on ${c.base ? oneLine(c.base, 40) : "the base"}${payload.treeExists === false ? " (its worktree is no longer on disk)" : ""}${shown ? `: ${shown}` : ""}`;
}

// The notice itself: the block that rides in the wake text beside the reason, so the assistant reads the
// payload instead of asking whether anything finished.
export function renderCompletionNotice(payload, { maxChars = NOTICE_CAP } = {}) {
  if (!payload) return "";
  const out = [];
  out.push(`completion — ${payload.name || "agent"}${payload.thread ? ` [${payload.thread}]` : ""}${payload.turn ? `, turn ${payload.turn}` : ""} ended ${payload.word}`);
  out.push(`  exit: ${payload.exitCode === null || payload.exitCode === undefined ? "not published by the run" : payload.exitCode}${payload.exitSource ? ` (from ${payload.exitSource})` : ""}${payload.reason ? ` — ${payload.reason}` : ""}`);
  if (payload.duration) out.push(`  duration: ${payload.duration}`);
  // A tree the panel renamed after this turn ended: the worktree it records is the tree's CURRENT directory, and the
  // old name is said out loud beside it. Without that, an earlier turn's notice quotes a path that no longer exists
  // and the reader has to work out whether the work is gone or just renamed.
  const renamed = payload.renamedFrom ? ` (renamed from ${oneLine(payload.renamedFrom, 160)})` : "";
  out.push(`  branch: ${payload.branch || "(none — this run had no tree of its own)"} · worktree: ${payload.worktree || "(none)"}${renamed}${payload.treeExists === false ? " (gone)" : ""} · ${commitsLine(payload)}`);
  if (payload.dirty || payload.untracked) out.push(`  uncommitted in the tree: ${payload.dirty || 0} modified · ${payload.untracked || 0} untracked`);
  if (payload.final?.text) {
    out.push(`  ${payload.final.source}:`);
    out.push(payload.final.text.split("\n").map((l) => `    ${l}`).join("\n"));
  }
  if (payload.report) {
    out.push(`  report ${payload.report.path}${payload.report.truncated ? ` (first ${payload.report.text.length} chars)` : ""}:`);
    out.push(payload.report.text.split("\n").map((l) => `    ${l}`).join("\n"));
  }
  return cap(out.join("\n"), maxChars);
}

// The same facts as label/value pairs, for the alert card, where a value is one line in a chip.
export function completionEvidence(payload, { clip = 120 } = {}) {
  if (!payload) return [];
  const out = [
    { label: "outcome", value: payload.word },
    { label: "exit", value: payload.exitCode === null || payload.exitCode === undefined ? "not published" : String(payload.exitCode) },
  ];
  if (payload.reason) out.push({ label: "why", value: oneLine(payload.reason, clip) });
  if (payload.duration) out.push({ label: "duration", value: payload.duration });
  out.push({ label: "branch", value: payload.branch ? oneLine(payload.branch, clip) : "(none)" });
  out.push({ label: "commits", value: payload.commits ? (payload.commits.count === 0 ? "none left" : `${payload.commits.count} not on base`) : "not measured" });
  if (payload.treeExists === false) out.push({ label: "tree", value: "gone" });
  if (payload.renamedFrom) out.push({ label: "renamed from", value: oneLine(payload.renamedFrom, clip) });
  if (payload.final?.text) out.push({ label: "final", value: oneLine(payload.final.text, 200) });
  if (payload.report) out.push({ label: "report", value: oneLine(payload.report.path, 160) });
  return out;
}
