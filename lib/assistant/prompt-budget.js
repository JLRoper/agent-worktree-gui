// One turn's prompt, as a budget: which sections it carries, what each is allowed to take, and the
// three turns the reader asks about (the first turn of a session, an ordinary turn, the fourth wake).
//
// WHY THIS MODULE EXISTS. The Settings -> Prompt tab draws three box-in-box diagrams, and the one
// thing a picture of a budget must not do is invent its own numbers. Every cap below is read from
// the module that OWNS the cap: `RULE_BRIEFING_MAX` and the 200-character rule clip from
// ./rules.js, `CHARTER_MAX_CHARS` from ../charter.js, `PROMPT_CAP` from ./profile.js. The sections
// that are fixed prose (identity, role, directive, the restart/autonomy/spawn block, the action
// grammar and the closing lines) have no cap to read - their words do not move - so their size is
// MEASURED from the built briefing by `Assistant.promptBudget`, never guessed here.
//
// The module is pure: it takes the measured sizes and the two gates, and returns the numbers the
// page draws. It reads no file, no state and no clock, so a unit test can hand it a table and the
// page can be given the same table over HTTP without either side growing a second opinion.
//
// THE THREE TURNS. It is the same prompt in each, because the standing half is the same bytes all
// session; what moves is which sections are DUE:
//
//   first     the first turn of a session: the charter is sent whole, the queue digest is carried,
//             the board is its full digest. The largest turn the panel ever builds.
//   ordinary  a sweep whose gates are closed: the charter is a one-line marker, the queue digest
//             is not due, and the board is its one-line marker.
//   fourth    the fourth wake: the newsletter wake. Its queue gate (every Nth wake, 2 by default)
//             is due and its board gate (every Nth sweep, 4 by default) lands on its full digest,
//             while the charter is still a marker. The largest ORDINARY turn.
//
// `queueSweepEveryNWakes` / `digestSweepEveryNWakes` are per-assistant settings, so the gate labels
// come in as values and the module never assumes 2 and 4.

import { CHARTER_MAX_CHARS } from "../charter.js";
import { DEFAULTS, NOTES_CAP } from "./config.js";
import { PROMPT_CAP } from "./profile.js";
import { RULE_BRIEFING_MAX } from "./rules.js";

// ------------------------------------------------------------------------------------------------
// The constants this module is allowed to name
// ------------------------------------------------------------------------------------------------

// A rule is injected clipped to 200 characters (lib/assistant.js, the standing-rules block). This is
// the CLIP, not the 400-character store cap (`RULE_TEXT_MAX`): a stored rule longer than 200 is sent
// as a clipped sentence, so 200 is the space the block can actually reserve per seat.
export const RULE_BRIEFING_CHARS = 200;
// The scratchpad's clip, and the watches list's shape: ten narrow rows, each a thread and a title. The notes cap
// is `NOTES_CAP` in ./config.js - the store's own cap and the preamble's clip are one number - so this name only
// gives the section a budget the diagram can print.
export const NOTES_BRIEFING_CHARS = NOTES_CAP;
export const WATCHES_BRIEFING_MAX = 10;
export const WATCH_TEXT_CHARS = 120;
// The projects list stops at forty lines to keep the preamble short (lib/assistant.js), and a line
// is a name and a path; 96 is the reservation per line, not a second clip on the path.
export const PROJECTS_BRIEFING_MAX = 40;
export const PROJECT_LINE_CHARS = 96;
// The queue digest's own shape: a header and `queueDigestSize` rows (a row is a 90-character title
// plus its facts, owner, files and lane note). The board digest has no clip in the builder - it is
// as long as the board is - so 8,000 is the panel's own budget line for it, the figure the
// "instead of handing it 8 KB of text it already read" note in lib/assistant.js names.
export const QUEUE_DIGEST_HEADER_CHARS = 120;
export const QUEUE_DIGEST_ROW_CHARS = 240;
export const BOARD_DIGEST_CHARS = 8000;

// The section table, in the order a turn reads them. `cap` is the reservation in characters and
// `basis` says where the number comes from. A `cap` of null is a section whose words are fixed:
// its size is whatever the builder wrote, measured at request time.
export const PROMPT_SECTION_DEFS = Object.freeze([
  { key: "identity", label: "Identity", half: "system", cap: null, basis: "the fixed identity lines" },
  { key: "role", label: "Role", half: "system", cap: null, basis: "the role line" },
  { key: "prompt", label: "Role prompt", half: "system", cap: PROMPT_CAP, basis: "PROMPT_CAP" },
  { key: "directive", label: "Queue directive", half: "system", cap: null, basis: "the standing queue directive" },
  { key: "rest", label: "Restart, autonomy, spawn", half: "system", cap: null, basis: "the fixed job lines" },
  { key: "projects", label: "Projects", half: "system", cap: PROJECTS_BRIEFING_MAX * PROJECT_LINE_CHARS, basis: `${PROJECTS_BRIEFING_MAX} project lines` },
  { key: "rules", label: "Twelve rules", half: "system", cap: RULE_BRIEFING_MAX * RULE_BRIEFING_CHARS, basis: `${RULE_BRIEFING_MAX} seats x ${RULE_BRIEFING_CHARS} chars` },
  { key: "notes", label: "Notes", half: "system", cap: NOTES_BRIEFING_CHARS, basis: `${NOTES_BRIEFING_CHARS}-char clip` },
  { key: "watches", label: "Watches", half: "system", cap: WATCHES_BRIEFING_MAX * WATCH_TEXT_CHARS, basis: `${WATCHES_BRIEFING_MAX} x ${WATCH_TEXT_CHARS} chars` },
  { key: "grammar", label: "Action grammar", half: "system", cap: null, basis: "the action grammar" },
  { key: "close", label: "Closing lines", half: "system", cap: null, basis: "the charter sentence and the close" },
  { key: "charter", label: "Charter", half: "turn", cap: CHARTER_MAX_CHARS, basis: `CHARTER_MAX_CHARS` },
  { key: "queue", label: "Queue digest", half: "turn", cap: null, basis: "queueDigestSize rows" },
  { key: "board", label: "Board digest", half: "turn", cap: BOARD_DIGEST_CHARS, basis: "the board's own budget" },
]);

/** The queue digest's reservation for one assistant's row count. A cap, not the live digest's size. */
export const queueBudgetChars = (rows = DEFAULTS.queueDigestSize) => {
  const n = Math.max(1, Math.min(20, Number(rows) || DEFAULTS.queueDigestSize));
  return QUEUE_DIGEST_HEADER_CHARS + n * QUEUE_DIGEST_ROW_CHARS;
};

/** The caps the panel enforces or reserves, as one table. The Prompt tab and its test read THIS. */
export const PROMPT_BUDGET = Object.freeze({
  ...Object.fromEntries(PROMPT_SECTION_DEFS.filter((s) => s.cap !== null).map((s) => [s.key, s.cap])),
  // The queue's cap is a function of the assistant's `queueDigestSize`; this is its default shape, kept in
  // the table so a caller with no settings can still answer "what is the queue row reserved against".
  queue: queueBudgetChars(),
});

/** The gate labels, said the way the builder reads them: one wake in N, one sweep in N. */
export const gateOf = (value, fallback) => {
  const n = Math.max(1, Math.min(20, Number(value) || fallback));
  return { n, label: n === 1 ? "every wake" : n === 2 ? "every 2nd wake" : n === 3 ? "every 3rd wake" : `every ${n}th wake` };
};

const charsOf = (value) => Math.max(0, Math.round(Number(value) || 0));

/**
 * One section, with its cap and its share of the turn.
 * @param {object} def  a PROMPT_SECTION_DEFS row
 * @param {number} chars the measured text in this turn
 * @param {number} total the turn's total characters
 * @param {object} [extra] `gated` / `whenDue` for a section whose own gate is closed
 */
function sectionOf(def, chars, total, extra = {}) {
  const n = charsOf(chars);
  return {
    key: def.key,
    label: def.label,
    half: def.half,
    chars: n,
    share: total > 0 ? n / total : 0,
    cap: def.cap,
    basis: def.basis,
    ...extra,
  };
}

const sum = (list) => list.reduce((n, s) => n + charsOf(s.chars), 0);

/**
 * One turn's diagram.
 * @param {{key: string, label: string, note: string}} turn
 * @param {object[]} system  the measured standing sections
 * @param {{queue: number, board: number, charter: number}} moving  this turn's turn-half sizes
 * @param {object} gates
 */
function variantOf({ key, label, note }, system, moving, gates) {
  const queueDef = PROMPT_SECTION_DEFS.find((s) => s.key === "queue");
  const boardDef = PROMPT_SECTION_DEFS.find((s) => s.key === "board");
  const charterDef = PROMPT_SECTION_DEFS.find((s) => s.key === "charter");
  const queueChars = charsOf(moving.queue);
  const queueCap = queueBudgetChars(gates.queueRows);
  const queueBasis = `${gates.queueRows} row${gates.queueRows === 1 ? "" : "s"} x ${QUEUE_DIGEST_ROW_CHARS} chars`;
  // The ordinary turn's queue gate is CLOSED: the section is still drawn, as the gate it is, and it
  // contributes nothing to the total. `whenDue` is what the section would take on its next due wake.
  // An EMPTY queue is a different fact again: there is no digest to gate, so the section reads empty
  // rather than closed.
  const queue = moving.queueEmpty
    ? [{ ...sectionOf(queueDef, 0, 0), cap: queueCap, basis: "the queue is empty" }]
    : queueChars
      ? [{ ...sectionOf(queueDef, queueChars, 0), cap: queueCap, basis: queueBasis }]
      : [{ ...sectionOf(queueDef, 0, 0, { gated: true, whenDue: 0 }), cap: queueCap, basis: queueBasis }];
  const board = [{ ...sectionOf(boardDef, moving.board, 0), basis: moving.board === moving.boardFull ? "the full digest" : "the one-line marker" }];
  const charter = [{ ...sectionOf(charterDef, moving.charter, 0), basis: moving.charter === moving.charterFull ? "sent in full" : "the one-line marker" }];
  const sections = [...system, ...queue, ...board, ...charter];
  const total = sum(sections);
  // The share is of the turn's own total, so it is computed after the total is known.
  for (const s of sections) s.share = total > 0 ? s.chars / total : 0;
  return {
    key,
    label,
    note,
    total,
    system: sum(sections.filter((s) => s.half === "system")),
    turn: sum(sections.filter((s) => s.half === "turn")),
    sections,
    gates,
  };
}

/**
 * The whole model the Prompt tab draws.
 *
 * @param {object} input
 * @param {{key: string, chars: number}[]} input.system   the measured standing sections, in order
 * @param {{queue: number, boardFull: number, boardMarker: number, charterFull: number, charterMarker: number}} input.turn
 * @param {{queueRows: number, queueWakes: number, boardWakes: number, boardMarkerLabel?: string}} input.gates
 */
export function promptBudgetModel({ system = [], turn = {}, gates = {}, actual = null } = {}) {
  const measured = new Map(system.map((s) => [s.key, charsOf(s.chars)]));
  const standing = PROMPT_SECTION_DEFS.filter((s) => s.half === "system").map((def) =>
    sectionOf(def, measured.get(def.key) || 0, 0),
  );
  const queueRows = Math.max(1, Math.min(20, Number(gates.queueRows) || DEFAULTS.queueDigestSize));
  const gate = {
    queueRows,
    queueWakes: Math.max(1, Math.min(20, Number(gates.queueWakes) || DEFAULTS.queueSweepEveryNWakes)),
    boardWakes: Math.max(1, Math.min(20, Number(gates.boardWakes) || DEFAULTS.digestSweepEveryNWakes)),
  };
  const queue = charsOf(turn.queue);
  const boardFull = charsOf(turn.boardFull);
  const boardMarker = charsOf(turn.boardMarker);
  const charterFull = charsOf(turn.charterFull);
  const charterMarker = charsOf(turn.charterMarker);
  const queueEmpty = Boolean(turn.queueEmpty);

  const turns = [
    variantOf(
      { key: "first", label: "First turn of a session", note: "Everything in full: the charter, the queue digest and the board's full digest." },
      standing,
      { queue, queueEmpty, board: boardFull, boardFull, charter: charterFull, charterFull },
      gate,
    ),
    variantOf(
      { key: "ordinary", label: "Ordinary turn", note: "The gates are closed: a charter marker, the board's marker, and no queue digest." },
      standing,
      { queue: 0, queueEmpty, board: boardMarker, boardFull, charter: charterMarker, charterFull },
      gate,
    ),
    variantOf(
      { key: "fourth", label: "Fourth wake", note: "The queue gate and the board's full sweep are both due; the charter is still a marker." },
      standing,
      { queue, queueEmpty, board: boardFull, boardFull, charter: charterMarker, charterFull },
      gate,
    ),
  ];

  // The exact assembled lengths, when the caller measured them. The section texts exclude the newlines
  // that join them, so the sum of the boxes is a few characters short of the prompt; the outer box is
  // the prompt, and it says so.
  if (actual) {
    for (const t of turns) {
      const measuredTurn = actual[t.key];
      if (!measuredTurn) continue;
      t.total = charsOf(measuredTurn.total);
      t.system = charsOf(measuredTurn.system);
      t.turn = charsOf(measuredTurn.turn);
      for (const s of t.sections) s.share = t.total > 0 ? s.chars / t.total : 0;
    }
  }

  // The ordinary turn's queue section is DRAWN but gated: it says what the next due wake would take
  // and contributes nothing, which is the difference the picture is for. Keep the would-be size on it
  // so the label can name it instead of reading "0". An empty queue is not a closed gate.
  const ordinary = turns[1];
  const queueSection = ordinary.sections.find((s) => s.key === "queue");
  if (queueSection && !queueEmpty) {
    queueSection.gated = true;
    queueSection.whenDue = queue;
    queueSection.basis = `closed this wake; ${gate.queueWakes === 1 ? "due every wake" : `due every ${gate.queueWakes} wakes`}`;
  }

  return {
    version: 1,
    turns,
    gates: {
      ...gate,
      queueLabel: gateOf(gate.queueWakes, DEFAULTS.queueSweepEveryNWakes).label,
      boardLabel: gateOf(gate.boardWakes, DEFAULTS.digestSweepEveryNWakes).label,
    },
    // The budget table the caps come from. The page does not need it to draw, but the test and a
    // reader who asks "what is this box reserved against" both do.
    budget: {
      ...PROMPT_BUDGET,
      queue: queueBudgetChars(queueRows),
    },
    at: new Date().toISOString(),
  };
}
