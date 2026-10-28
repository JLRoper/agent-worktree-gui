// ---- gateway events, and what they read as -----------------------------------------------------
// One SSE event and its tool preview become the console lines the browser already knows how to draw,
// and a gateway refusal becomes a sentence a reader can act on. This is the one cluster in the run
// supervisor with no state of its own — no job, no store, no timer — which is what lets it be read
// (and tested) without the registry around it.
//
// `cleanPath` and `linesOf` are the tree-measuring half of the same cluster: the tree measurement
// parses `git worktree list --porcelain` by hand, and this is where the constants it needs live.
import { unwrapToolText } from "../tool-text.js";

// Panels render plain text; a model can still emit ANSI colour inside tool output.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;
export const stripAnsi = (s) => String(s ?? "").replace(ANSI_RE, "");

const MAX_TOOL_LINES = 40;
const MAX_TOOL_LINE_CHARS = 400;

// The panel's fold, said out loud and made clickable.
//
// The card keeps a result's HEAD (40 lines, 400 characters a line) and nothing else: a 5,000-line read pushed
// whole through the console's ring buffer (jobs.js MAX_LINES = 600) would evict every other line the card had.
// The rest of the result is not lost — it is in the session store, verbatim — so the head ends with a sentence
// the browser turns into a button, and that button's click fetches the whole stored text (lib/tool-results.js).
//
// Two rules this note lives by:
//   * it is only ever pushed when this fold really dropped something (a hidden line, or a line shortened at
//     MAX_TOOL_LINE_CHARS), and
//   * it names WHICH cap did it — this one, the panel's, never the gateway's. The gateway's own cut keeps its
//     own sentence ("… result truncated by the gateway — …"), pushed below, and the two are distinguishable
//     because each appears exactly when its cap cut something.
//
// console-format.js matches the same sentence in the browser (consoleFoldNote); a harness asserts the two
// agree, because a note the browser does not recognise is a fold with no way to read the rest of it.
export const FOLD_NOTE_RE = /^\s*(?:…|\.\.\.)\s+\d+ lines?(?: hidden| shortened)(?:, \d+ lines? shortened)? — click to read\s*$/;
export function foldNoteText({ hidden = 0, shortened = 0 } = {}) {
  const bits = [];
  if (hidden > 0) bits.push(`${hidden} line${hidden === 1 ? "" : "s"} hidden`);
  if (shortened > 0) bits.push(`${shortened} line${shortened === 1 ? "" : "s"} shortened`);
  return bits.length ? `… ${bits.join(", ")} — click to read` : "";
}

// The backslash, and the lines of a block of text, both built from character codes rather than written as
// escape sequences: an escape that lands wrong in a regex literal here is a `SyntaxError` for the whole
// panel, and the tree measurement below parses `git worktree list --porcelain` by hand.
const BS = String.fromCharCode(92);
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
export const cleanPath = (s) => String(s || "").split(BS).join("/").replace(/[/]+$/, "");
export const linesOf = (text) => String(text || "").split(LF).map((l) => (l.endsWith(CR) ? l.slice(0, -1) : l));

// tool.completed carries the result as a preview (a JSON envelope for terminal, a diff for patch, plain
// text otherwise). Unwrap the envelope and hand the first lines to the console so a reader sees what the
// tool actually said instead of a bare "tool · 1.2s" — the envelope itself is never drawn: the gateway's
// default cap is ~500 chars ("..." appended), so it is usually cut mid-string, and braces plus literal \n
// in a console are bytes nobody reads. The unwrapping is shared with the session-store path (lib/tool-text.js)
// so a live preview and a stored result read the same way.
//
// With the gateway's cap lifted (HERMES_RUN_PREVIEW_CHARS=0) this is the only fold left between a tool result
// and the reader: the whole result arrives, the head below is what the card keeps, and the fold note's click
// reads the rest out of the session store.
function toolResultLines(tool, preview, { duration, error, rowAt } = {}) {
  const unwrapped = unwrapToolText(preview);
  let body = [unwrapped.text, unwrapped.notes.length ? `(${unwrapped.notes.join(" · ")})` : ""].filter(Boolean).join("\n");
  const all = body.split(String.fromCharCode(10)).filter((l, idx, arr) => l.trim() || (idx > 0 && idx < arr.length - 1));
  const shown = all.slice(0, MAX_TOOL_LINES).map((l) => l.slice(0, MAX_TOOL_LINE_CHARS));
  const shortened = shown.filter((l, i) => l.length < all[i].length).length;
  const meta = [duration ? `${Number(duration).toFixed(2)}s` : null, error ? "error" : null].filter(Boolean).join(" · ");
  const out = [{ kind: "tool-out", text: `  ↳ ${tool || "tool"}${meta ? ` · ${meta}` : ""}` }];
  for (const l of shown) out.push({ kind: "tool-out", text: l });
  // Only when this fold really dropped something, and it names this panel's cap — see foldNoteText above.
  // The note carries which result it folds (foldLine): the card's click has to read THAT row back out of the
  // session store, and a position inside the console's trimmed window is not that number.
  const note = foldNoteText({ hidden: all.length - shown.length, shortened });
  if (note) out.push(foldLine(note, tool, rowAt));
  // Say it out loud rather than letting a cut payload look like the whole answer.
  if (unwrapped.truncated) out.push({ kind: "tool-out", text: "… result truncated by the gateway — the live stream carries a preview of a tool result, not all of it" });
  return out;
}

// The note as the reader's own handle on the result it folds: the sentence, plus which result it is.
//
// The tool and the row travel on the LINE (never in its text, which the reader reads and the browser matches)
// because the console cannot work them out from a window that was trimmed of the call: `/api/jobs` serves the
// last 120 lines and `jobs.json` keeps 60, so a burst routinely arrives with its call line and its `↳ tool`
// header already gone, and the note inside it then belongs to no tool the console can name. `rowAt` is this
// result's index among the turn's results for that tool — the number lib/tool-results.js indexes by — counted
// at the event in lib/jobs.js (`withResultRow`) rather than from a position inside the window.
export function foldLine(note, tool, rowAt) {
  const line = { kind: "tool-out", text: note };
  if (tool && Number.isInteger(rowAt) && rowAt >= 0) line.fold = { tool: String(tool), row: rowAt };
  return line;
}

// One glyph per tool, taken from the Hermes registry so a tool looks the same in the CLI and here
// (read_file 📖, terminal 💻, patch 🔧). Unknown tools fall back by family — a glyph that is wrong is
// worse than a generic one — and then to the CLI's own default, ⚡.
const TOOL_GLYPHS = {
  read_file: "📖", write_file: "✍️", patch: "🔧", search_files: "🔎",
  terminal: "💻", read_terminal: "🖥️", close_terminal: "🖥️", execute_code: "🐍",
  browser_exec: "🌐", browser_cdp: "🧪", browser_dialog: "💬", browser_vault: "🔐",
  web_search: "🔍", web_extract: "📄", session_search: "🔍",
  delegate_task: "🔀", todo_list: "📋", process_manage: "⚙️", memory: "🧠",
  skill_view: "📚", skills_list: "📚", skill_manage: "📝", clarify: "❓",
  cronjob_manage: "⏰", manage_connections: "🔗", manage_catalog: "🧩",
  text_to_speech: "🔊", vision_analyze: "👁️", video_analyze: "🎬", video_generate: "🎬",
  image_generate: "🎨", computer_use: "🖱️", tool_search: "🧰", tool_describe: "🧰", tool_call: "🧰",
  annotate_preview: "🔖", desktop_preview: "🖼️", documents: "📄",
};

const TOOL_GLYPH_FAMILIES = [
  [/^mcp__/, "🧩"],
  [/^browser/, "🌐"],
  [/^skill/, "📚"],
  [/^(web_|.*_search$)/, "🔍"],
  [/^tool_/, "🧰"],
];

export function toolGlyph(tool) {
  const name = String(tool || "").toLowerCase();
  if (!name) return "⚡";
  const known = TOOL_GLYPHS[name] || TOOL_GLYPHS[name.replace(/^mcp__.*?__/, "")];
  if (known) return known;
  for (const [re, glyph] of TOOL_GLYPH_FAMILIES) if (re.test(name)) return glyph;
  return "⚡";
}

// The gateway appends a messaging-surface hint to a clarify question ("Reply \"skip\" to skip this
// question.") because the API server counts as a chat platform. The panel's box has its own controls and
// its own note, so the hint is noise — in the question box AND in the console line that records it.
const CLARIFY_HINT = /\n?\s*Reply\s+["']?skip["']?\s+to skip this question\.?\s*$/i;
export function clarifyText(text) {
  return String(text ?? "").replace(CLARIFY_HINT, "").trim();
}

// One line out of a block of text: the console draws lines, and a reasoning block arrives with its own
// newlines in it.
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// One SSE event -> the console lines the browser already knows how to draw.
export function linesForEvent(evt) {
  switch (evt.event) {
    case "tool.started": {
      const p = typeof evt.preview === "string" ? evt.preview.replace(/\s+/g, " ").trim().slice(0, 240) : "";
      // The glyph leads the line, the way the CLI prints a call; the arrow is kept only in history
      // written before glyphs, which the browser still parses.
      return [{ kind: "tool", text: `${toolGlyph(evt.tool)} ${evt.tool || "tool"}${p ? ` · ${p}` : ""}` }];
    }
    case "tool.completed":
      // `rowAt` is not on the wire: lib/jobs.js counts it (this result's index among the turn's results for
      // that tool) and hands it in, because it is what the fold note's click reads back.
      return toolResultLines(evt.tool, evt.preview, { duration: evt.duration, error: evt.error, rowAt: evt.rowAt });
    case "message.delta":
      // The wire field is `delta` (not `text`): the run stream carries fragments.
      return evt.delta ? [{ kind: "text", text: String(evt.delta) }] : [];
    case "message.interim":
      // Commentary the model writes beside its tool calls. When it was also streamed as a delta,
      // printing it again would duplicate the line.
      return evt.text && !evt.already_streamed ? [{ kind: "text", text: String(evt.text) }] : [];
    case "reasoning.available":
      // The run stream publishes a finished reasoning BLOCK, not deltas (the gateway's
      // `reasoning_streaming` capability is the chat-completions surface). It belongs in the transcript as
      // ONE dim line: never merged into the answer, never invented - a run that sends no reasoning gets no
      // line. The block itself stays in the session store behind the card's reasoning toggle.
      return evt.text ? [{ kind: "dim", text: `🧠 reasoning · ${oneLine(evt.text).slice(0, 240)}` }] : [];
    case "run.steered":
      return [{ kind: "raw", text: "⇢ steer delivered to the live turn" }];
    case "approval.request":
      return [{ kind: "raw", text: `⚠ approval requested: ${String(evt.command || evt.description || "").slice(0, 200)}` }];
    case "approval.responded":
      return [{ kind: "dim", text: `⇢ approval answered: ${String(evt.choice || "")}` }];
    case "clarify.request":
      // The question itself is the card's prompt box; this line is the transcript's record that the
      // agent stopped to ask, at the point in its output where it stopped.
      return [{ kind: "raw", text: `❓ question asked: ${clarifyText(evt.question).replace(/\s+/g, " ").slice(0, 200)}` }];
    case "subagent.start":
      return [{ kind: "raw", text: `↳ subagent started${evt.preview ? `: ${String(evt.preview).slice(0, 160)}` : ""}` }];
    case "subagent.complete":
      return [{ kind: "raw", text: `↳ subagent ${evt.status || "finished"}${evt.preview ? `: ${String(evt.preview).slice(0, 160)}` : ""}` }];
    case "error":
      // A run-level error ends the turn's usefulness: whatever approval it was parked on is moot, and
      // leaving the object behind made the card keep offering buttons for a dead turn.
      return [{ kind: "raw", text: `error: ${String(evt.error || evt.message || "unknown").slice(0, 300)}` }];
    default:
      return [];
  }
}

// The stats row above the reply box (context occupancy, prompt-cache hit rate, mean latency and
// throughput) is a display readout, not billing: keep only values that are really numbers, so a
// field the gateway omitted renders as "no data" instead of a fabricated 0%.
const STAT_NUM_KEYS = ["context_used", "context_max", "context_percent", "cache_hit_pct",
  "avg_latency_s", "avg_tps", "compressions"];

export function statsFromUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const out = {};
  for (const key of STAT_NUM_KEYS) {
    const v = usage[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  if (typeof usage.context_estimated === "boolean") out.context_estimated = usage.context_estimated;
  return Object.keys(out).length ? out : null;
}

// A line is a line: kind + text. The gateway's whole run object used to ride along as `json` on every result line -
// straight to the browser and into jobs.json - for a reader that never looked at it. The numbers a card needs are
// already read from the run by settle(); what is left here is the sentence.
export function runResultLine(status, run) {
  const tk = run?.usage || {};
  const bits = [
    `run ${status}`,
    tk.total_tokens ? `tokens ${tk.total_tokens} (in ${tk.input_tokens ?? "?"} / out ${tk.output_tokens ?? "?"})` : null,
    run?.pending_steer ? `pending steer: ${String(run.pending_steer).slice(0, 120)}` : null,
  ].filter(Boolean);
  return { kind: "result", text: bits.join(" · ") };
}

// Turns a gateway refusal into something a reader can act on. Only the cases we understand are translated;
// everything else keeps the gateway's own words.
export function runRefusal(status, detail, { thread, revived } = {}) {
  const text = String(detail || "");
  if (Number(status) !== 409 || !/permission_denied/.test(text)) return null;
  if (revived) {
    return `this session is the CLI's, not the panel's — the gateway will not take a panel turn in it (409 permission_denied). Continue it in a terminal: hermes --resume ${thread}`;
  }
  return `the gateway refused the turn (409 permission_denied): it will not write into a session owned by another surface. Continue that session where it lives, or start a new panel session.`;
}
