// The board digest as an append-only tail: one small message per assistant turn.
//
// WHAT IT REPLACES. The digest was a block rebuilt in full on every turn it was due: every live run and the five
// most recent, each with its prompt, its tree and its last tool calls, plus the panel's own notices. On a busy
// board that is about 8 KB, and a turn that had already read it read it again on the next sweep. A block that is
// rewritten every turn cannot say what MOVED; it only says what IS.
//
// THE SHAPE. Each turn appends exactly ONE message to the assistant's digest transcript
// (`state/assistants/<id>/digest.jsonl`) and hands that same message to the run. A message carries one row per
// item: the item's stable id, a state token (a hash of the facts an assistant acts on), the moment that state was
// first seen, and a pointer at the sending turn - `assistant/thread/turn`.
//
// A row carries the item's one-line text ONLY when its token is new. The message that first carried a token is
// still in the transcript above, so an unchanged row is four fields and no text: the tail costs what changed, not
// what the board holds. `buildDigestMessage` takes the previous message for exactly that comparison.
//
// THE FULL TEXT IS NOT IN THE DIGEST. What the sending turn ended on, and its last few tool calls, is read on
// demand by `readTurn(pointer)`. That is what lets an assistant act only on the rows whose token moved and fetch
// the words behind one when it needs them, instead of the digest carrying every prompt on the board.
//
// ONE SCREEN. The message is bounded twice: `fitItems` keeps every changed row and drops unchanged rows from the
// tail of the list until the rendered message fits the assistant float's default text box, and the test renders
// the busiest realistic board and counts display lines at the same width. `DIGEST_SCREEN` is the one place the
// geometry lives; the test and the measurement tool read it rather than keeping a second opinion.
//
// NOTHING HERE TOUCHES THE JOB STORE OR DISK EXCEPT THE THREE TAIL FUNCTIONS. The builder is pure, so a test can
// hand it items and a previous message and read the answer without a panel.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { clip, minutes, nameOf, toolSigs } from "./read.js";

export const DIGEST_TAIL_VERSION = 1;
// How many messages the transcript keeps. One message a turn, and a turn is minutes apart: 200 is a long
// afternoon of the assistant's own reading, and the file stays small enough to rewrite when the cap bites.
export const DIGEST_TAIL_CAP = 200;
// A changed item's own line of text. Long enough to name the run and what it was asked, short enough that the
// row wraps to two display lines at the float's width and not three.
export const DIGEST_ITEM_TEXT = 64;
// The most rows one message carries, whatever the board holds. The cap keeps a pathological board from growing
// the message past a screen before `fitItems` has anything left to drop.
export const DIGEST_ITEM_MAX = 24;
// The board's own warning, kept verbatim in the message because it is a standing correction, not news: a model
// that reads "worker X is running" as an invitation to answer it is how two TO lines and three runs on one
// worktree happened.
export const LIVE_RUNS_LINE =
  "LIVE RUNS - one run per thread, one worker per tree. Do NOT write a TO line to one: a reply starts a SECOND run " +
  "on the same files. Write nothing and let each finish.";

// The assistant float's default text box, and the two conversions a display line needs. The numbers come from the
// page's own code, not from a preference:
//   width   placeFloat(): round(0.42 * 1440) = 605 px on the panel's standard 1440 px window
//   height  placeFloat(): round(0.80 * 900) = 720 px on the same window
//   cols    605 less the 2 px border, the 8 px padding each side and the console's own 32 px of chrome, at the
//           6.15 px advance the console's 11.5 px monospace measures (tools/verify-digest-cost.mjs measures it live)
//   lines   720 less the bar, the two tab rows and the pane padding, at the console's 17.25 px line (11.5 at 1.5)
export const DIGEST_SCREEN = Object.freeze({ widthPx: 605, heightPx: 720, cols: 89, lines: 35 });

// The fields a state token covers. Everything an assistant might act on, and nothing that moves on its own: the
// run's `lines` are the obvious exclusion (they grow on every tool call), but so are `prompt`, `title` and the
// gateway's token counters - a row whose text is stable must not look changed because its clock ticked.
export function itemStateOf(job = {}) {
  const j = job && typeof job === "object" ? job : {};
  return {
    status: j.status || null,
    endedAt: j.endedAt || null,
    exitCode: j.exitCode ?? null,
    branch: j.branch || null,
    tree: j.worktreePath || j.ownerPath || null,
    completion: j.completion?.word || null,
    outcome: j.outcome?.word || null,
    termination: j.termination?.kind || j.termination?.word || null,
    question: j.question ? { key: j.question.key || null, text: clip(j.question.text || "", 80) } : null,
    approval: j.approval ? { command: clip(j.approval.command || "", 80) } : null,
    error: j.error ? 1 : null,
    fatal: j.fatal ? 1 : null,
    runGone: Boolean(j.runGone),
  };
}

// One comparable string for an object, keys sorted at every level, so a token depends on the facts and not on the
// order a caller happened to write them in.
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

/** The state token: the first 8 hex characters of a sha256 over the canonical state. Short enough for a row. */
export function stateToken(state) {
  return createHash("sha256").update(canonical(state && typeof state === "object" ? state : {})).digest("hex").slice(0, 8);
}

/** A pointer is three parts and always has been: the sender assistant, the thread, and the turn. */
export function pointerOf({ assistant = null, thread = null, turn = null } = {}) {
  return [String(assistant || "-"), String(thread || "-"), String(turn || "-")].join("/");
}

/** The inverse of `pointerOf`. The turn is the last part and the assistant the first, so a thread with a slash in
 *  its name still parses (only the last two separators are load-bearing). */
export function parsePointer(text) {
  const parts = String(text ?? "").trim().split("/");
  const turn = parts.length > 1 ? parts.pop() : null;
  const thread = parts.length > 1 ? parts.pop() : null;
  const assistant = parts.length ? parts.join("/") : null;
  const clean = (v) => (v && v !== "-" ? v : null);
  return { assistant: clean(assistant), thread: clean(thread), turn: clean(turn) };
}

// Greedy wrap at spaces, the way the pane's `white-space: pre-wrap` lays a line out. A word longer than the line
// takes the lines it must; everything else is packed. This is the count the test asserts against, and the
// measurement tool checks it against a real Chromium box.
export function wrapCount(line, cols = DIGEST_SCREEN.cols) {
  const text = String(line ?? "");
  const width = Math.max(1, Number(cols) || DIGEST_SCREEN.cols);
  if (!text.length) return 1;
  let rows = 1;
  let used = 0;
  for (const word of text.split(" ")) {
    const len = word.length;
    if (!len) continue;
    if (used === 0) {
      used = len;
      while (used > width) {
        rows += 1;
        used -= width;
      }
    } else if (used + 1 + len <= width) {
      used += 1 + len;
    } else {
      rows += 1;
      used = len;
      while (used > width) {
        rows += 1;
        used -= width;
      }
    }
  }
  return rows;
}

/** How many display lines a block occupies in the assistant float, at its default width. */
export function displayLines(text, cols = DIGEST_SCREEN.cols) {
  return String(text ?? "")
    .split("\n")
    .reduce((n, line) => n + wrapCount(line, cols), 0);
}

/** Whether a block fits one screen of the float, at its default width and height. */
export function fitsOneScreen(text, { cols = DIGEST_SCREEN.cols, lines = DIGEST_SCREEN.lines } = {}) {
  return displayLines(text, cols) <= lines;
}

/** The timestamp a row carries: `MM-DDTHH:MM` in UTC. A year is not news and a full ISO date is 20 characters of
 *  it, which is a fifth of a row on a text this tight. The header takes `precise` and keeps the seconds: turns can
 *  be seconds apart, and two messages stamped the same minute are indistinguishable as a `prev`. */
export function stampOf(at, { precise = false } = {}) {
  const ms = Date.parse(String(at ?? ""));
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  const p = (n) => String(n).padStart(2, "0");
  const base = `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  return precise ? `${base}:${p(d.getUTCSeconds())}` : base;
}

/** The header: when this message was built, what moved, and which message it is comparing against. */
function headerOf({ at, changed, same, previous }) {
  return `Board tail ${stampOf(at, { precise: true })}Z | ${changed} changed, ${same} same | prev ${previous ? `${stampOf(previous, { precise: true })}Z` : "none"}`;
}

/**
 * One item's row. `+` is a row whose token differs from the previous message's (and which therefore carries its
 * text), `=` a row that has not moved (and does not).
 */
export function renderItem(item) {
  const mark = item.changed ? "+" : "=";
  const base = `${mark} #${item.id} tok=${item.token} at=${stampOf(item.at)} send=${item.pointer || "-/-/-"}`;
  return item.text ? `${base} | ${item.text}` : base;
}

/**
 * The whole message as text. `head` lines sit between the header and the rows (the board's standing warning),
 * `flags` after them (the panel's notices, each already a block). A `hidden` count is said out loud so a reader
 * can tell a short tail from a short board.
 */
export function renderDigestMessage({ at = new Date().toISOString(), previous = null, items = [], head = [], flags = [], hidden = 0 } = {}) {
  const changed = items.filter((i) => i.changed).length;
  const lines = [headerOf({ at, changed, same: items.length - changed, previous }), ...head.map(String), ...items.map(renderItem)];
  if (hidden > 0) lines.push(`... ${hidden} unchanged item${hidden === 1 ? "" : "s"} not shown (one screen)`);
  for (const block of flags) if (String(block || "").trim()) lines.push(String(block));
  return lines.join("\n");
}

/**
 * Keep every changed row and as many unchanged ones as one screen holds. Unchanged rows are dropped from the END
 * (the list is live runs first, then recent ones, so the tail is the least actionable), and the count of what was
 * dropped rides in the message. A message with nothing changed is one screen by construction, because its rows
 * are one line each - the guard still runs, so a board that grew past `DIGEST_ITEM_MAX` is honest about it.
 */
export function fitItems(items, { at, previous, head = [], flags = [], hiddenBase = 0, cols, lines } = {}) {
  const limit = Math.max(1, Number(lines) || DIGEST_SCREEN.lines);
  let keep = items.slice(0, DIGEST_ITEM_MAX);
  let hidden = Math.max(0, Number(hiddenBase) || 0) + (items.length - keep.length);
  const render = (rows, hiddenCount) => renderDigestMessage({ at, previous, items: rows, head, flags, hidden: hiddenCount });
  while (keep.length > 1 && displayLines(render(keep, hidden), cols) > limit) {
    // Drop the newest unchanged row first from the end; never drop a changed one.
    const at2 = [...keep].reverse().findIndex((i) => !i.changed);
    if (at2 < 0) break;
    keep = keep.slice(0, keep.length - 1 - at2).concat(keep.slice(keep.length - at2));
    hidden += 1;
  }
  return { items: keep, hidden };
}

/**
 * Build one message from this turn's items and the previous message.
 *
 * @param {{items: {id: string, state?: object, token?: string, at?: string, pointer?: object|string, text?: string}[], at?: string, previous?: object|null, head?: string[], flags?: string[]}} input
 * @returns {{version: number, at: string, previous: string|null, items: object[], hidden: number, text: string, bytes: number, lines: number}}
 */
export function buildDigestMessage({ items = [], at = new Date().toISOString(), previous = null, head = [], flags = [] } = {}) {
  const before = new Map((previous?.items || []).map((i) => [String(i.id), i]));
  const rows = [];
  for (const item of items) {
    const id = String(item.id);
    if (!id || id === "undefined") continue;
    const token = String(item.token || stateToken(item.state || {}));
    const prior = before.get(id);
    const changed = !prior || prior.token !== token;
    rows.push({
      id,
      token,
      // A changed row is stamped with the moment the panel saw the change; an unchanged one keeps the moment its
      // current state began, which is the timestamp the previous message already carried.
      at: changed ? at : prior?.at || item.at || at,
      pointer: typeof item.pointer === "string" ? item.pointer : pointerOf(item.pointer || {}),
      text: changed ? clip(item.text || "", DIGEST_ITEM_TEXT) : "",
      changed,
    });
  }
  const fitted = fitItems(rows, { at, previous, head, flags });
  const text = renderDigestMessage({ at, previous, items: fitted.items, head, flags, hidden: fitted.hidden });
  return {
    version: DIGEST_TAIL_VERSION,
    at,
    previous: previous?.at || null,
    items: fitted.items,
    hidden: fitted.hidden,
    bytes: Buffer.byteLength(text, "utf8"),
    lines: displayLines(text),
    text,
  };
}

// ------------------------------------------------------------------------------------------------
// The transcript on disk

/** Where one assistant's digest transcript lives, relative to the state directory (beside its queue and settings). */
export const digestRelFor = (id) => path.join("assistants", String(id || ""), "digest.jsonl");
/** The absolute file for one assistant's digest transcript. */
export const digestPathOf = (stateDir, id) => path.join(String(stateDir || ""), digestRelFor(id));

const isMessage = (v) => Boolean(v) && typeof v === "object" && Number(v.version) === DIGEST_TAIL_VERSION && Array.isArray(v.items);

/** Every message in the transcript, oldest first. A line that does not parse is skipped, never fatal: this is a
 *  record the panel appends to on every turn, and one torn write must not take the board down with it. */
export function readDigestTail(file) {
  if (!file || !existsSync(file)) return [];
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    try {
      const msg = JSON.parse(text);
      if (isMessage(msg)) out.push(msg);
    } catch {
      /* a torn line is not a message */
    }
  }
  return out;
}

/**
 * Append exactly one message, and trim the transcript to its cap from the front when it is over. Appending is one
 * `appendFileSync`; the rewrite only happens on the turn the cap bites, and it keeps whole messages, so no message
 * a turn was handed is ever edited.
 */
export function appendDigestMessage(file, message, cap = DIGEST_TAIL_CAP) {
  if (!file) throw new Error("appendDigestMessage needs a file");
  if (!isMessage(message)) throw new Error("appendDigestMessage needs a digest message");
  mkdirSync(path.dirname(file), { recursive: true });
  const line = `${JSON.stringify(message)}\n`;
  const existing = readDigestTail(file);
  const overflow = existing.length + 1 - Math.max(1, Number(cap) || DIGEST_TAIL_CAP);
  if (overflow > 0) {
    const kept = [...existing, message].slice(overflow);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, kept.map((m) => `${JSON.stringify(m)}\n`).join(""), "utf8");
    renameSync(tmp, file);
    return message;
  }
  appendFileSync(file, line, "utf8");
  return message;
}

// ------------------------------------------------------------------------------------------------
// The read tool

/**
 * The sending turn behind a pointer: its final message and its last few tool calls.
 *
 * Deliberately reads the turn the pointer NAMES, never the newest turn of the thread: the whole point of a pointer
 * is that a digest message can name the turn that sent an item three turns ago, and a reader that answered with
 * the latest turn would be a different (and wrong) answer.
 *
 * @param {string|{assistant?: string, thread?: string, turn?: string}} pointer
 * @param {{jobs: {get: (id: string) => object|null}, calls?: number}} ctx
 * @returns {{ok: boolean, pointer: object, turn?: object, finalMessage?: string, calls?: object[], why?: string}}
 */
export function readTurn(pointer, { jobs, calls = 3 } = {}) {
  const ptr = typeof pointer === "string" ? parsePointer(pointer) : parsePointer(pointerOf(pointer || {}));
  if (!ptr.turn) return { ok: false, pointer: ptr, why: "the pointer has no turn" };
  const job = typeof jobs?.get === "function" ? jobs.get(String(ptr.turn)) : null;
  if (!job) return { ok: false, pointer: ptr, why: `no turn ${ptr.turn} in the job store` };
  if (ptr.thread && job.thread && String(job.thread) !== String(ptr.thread)) {
    return { ok: false, pointer: ptr, why: `turn ${ptr.turn} ran on ${job.thread}, not ${ptr.thread}` };
  }
  const sigs = toolSigs(job.lines || []).slice(-Math.max(1, Number(calls) || 3));
  return {
    ok: true,
    pointer: ptr,
    turn: {
      id: job.id,
      thread: job.thread || null,
      assistantId: job.assistantId || null,
      title: job.title || null,
      status: job.status || null,
      startedAt: job.startedAt || null,
      endedAt: job.endedAt || null,
    },
    finalMessage: String(job.finalMessage || ""),
    calls: sigs.map((s) => ({ tool: s.tool, input: s.input, at: s.at })),
  };
}

/** The one-line text a changed row carries: what the run is, how it stands, where it works and what it was asked. */
export function itemTextOf(job, { now = Date.now(), asked = 40 } = {}) {
  const j = job || {};
  const bits = [nameOf(j)];
  const status = j.status || j.completion?.word || "unknown";
  bits.push(status);
  // Only a run that is still going carries its age: a finished one's age is not news, and "10592m" for a run that
  // ended yesterday is a number a reader has to decode.
  const started = Date.parse(j.startedAt || "");
  if (!j.endedAt && Number.isFinite(started) && started) bits.push(minutes(now - started));
  const tree = String(j.worktreePath || j.ownerPath || "").replace(/\\/g, "/").split("/").filter(Boolean).slice(-2).join("/");
  if (tree) bits.push(tree);
  const prompt = String(j.prompt || "").replace(/\s+/g, " ").trim();
  if (prompt) bits.push(`asked: ${clip(prompt, asked)}`);
  return bits.join(" \u00b7 ");
}
