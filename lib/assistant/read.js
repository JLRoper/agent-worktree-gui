// Reading a turn: what a run's console says, and the facts every rule asks about a job.
//
// A run's `lines` array is the only evidence the assistant has of what a worker did, and a job summary is
// the only thing it has about the run itself. Everything here turns one of those into a value - what was
// called, what repeated, what failed, where the turn ended, how long ago - and nothing here reads state,
// opens a file or calls a port. That is why tools/verify-assistant.mjs and tools/verify-action-harvest.mjs
// import these directly, and why the shell's own import of the same names changes nothing about them.
//
// `clip`/`reasonOf`/`nowIso`/`normPath`/`toolSigs` are shared with the shell and with ./match.js: they are
// the formatting and comparison primitives the whole feature reads a console through, so they live with the
// console rather than beside the class that happens to use them.

export const clip = (s, n = 160) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
// The words for a failure, from anything that can be thrown. A journal line that says only "undefined"
// is the same as no line at all: what was dropped and why is the whole point of writing it down.
export const reasonOf = (err) => {
  if (!err) return "unknown failure";
  const msg = typeof err === "string" ? err : err.message || String(err);
  return String(msg || "unknown failure").replace(/\s+/g, " ").trim() || "unknown failure";
};
export const nowIso = () => new Date().toISOString();
export const normPath = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// ---------------------------------------------------------------------------------------------
// Reading a turn's console the way a person would

// "💻 terminal · npm test" -> { tool: "terminal", input: "npm test" }
const TOOL_RE = /^\s*\S+\s+([A-Za-z][\w.-]*)\s*(?:·\s*([\s\S]*))?$/;
export function parseToolLine(line) {
  if (!line || line.kind !== "tool") return null;
  const text = String(line.text || "");
  const m = TOOL_RE.exec(text);
  if (!m) return null;
  return { tool: m[1].toLowerCase(), input: clip(m[2] || "", 180), at: Number(line.at) || 0 };
}

export function toolSigs(lines) {
  const out = [];
  for (const l of lines || []) {
    const t = parseToolLine(l);
    if (t) out.push({ ...t, key: `${t.tool}|${t.input}` });
  }
  return out;
}

// The same call with the same input, N times. Read-only helpers are held to a higher bar: reading one
// file twice is ordinary, reading it six times is a loop with extra steps.
const READONLY = new Set(["read_file", "search_files", "skills_list", "skill_view", "todo_list"]);
export function detectRepeat(lines, limit = 3) {
  const counts = new Map();
  for (const s of toolSigs(lines)) {
    const cur = counts.get(s.key) || { ...s, count: 0, firstAt: 0, lastAt: 0, indexes: [] };
    cur.count += 1;
    cur.firstAt = cur.firstAt || s.at;
    cur.lastAt = s.at || cur.lastAt;
    counts.set(s.key, cur);
  }
  let best = null;
  for (const c of counts.values()) {
    const bar = READONLY.has(c.tool) ? limit + 2 : limit;
    if (c.count >= bar && (!best || c.count > best.count)) best = c;
  }
  return best;
}

// A → B → C → A → B → C, where no single call repeats enough to be caught above.
export function detectCycle(lines, { minRepeats = 3, maxLen = 4 } = {}) {
  const keys = toolSigs(lines).map((s) => s.key);
  if (keys.length < 6) return null;
  for (let len = 2; len <= maxLen; len += 1) {
    const tail = keys.slice(-len);
    if (new Set(tail).size < 2) continue; // one call repeated is detectRepeat's case
    let repeats = 0;
    for (let end = keys.length; end - len >= 0; end -= len) {
      const seg = keys.slice(end - len, end);
      if (seg.join(">") !== tail.join(">")) break;
      repeats += 1;
    }
    if (repeats >= minRepeats) {
      const calls = toolSigs(lines).slice(-len);
      return { repeats, len, calls };
    }
  }
  return null;
}

// A tool result that failed. Two shapes on the wire: terminal output carries "(exit 1)" (or "(error: …)"), and any
// tool whose result came back with the error flag gets it in the result HEADER — "  ↳ terminal · error". The header
// is the only signal when the result preview is empty, which is common for a command that wrote nothing.
export function isFailureLine(text) {
  const t = String(text || "");
  if (/\(exit\s+[1-9]\d*\)|\(error:|^error:/i.test(t)) return true;
  return /^\s*↳\s+/.test(t) && /·\s*error\s*$/i.test(t);
}

// Identical failure output. Terminal results carry "(exit 1)"; anything else that says error: counts.
export function detectErrorRepeat(lines, limit = 3) {
  const counts = new Map();
  for (const l of lines || []) {
    if (l.kind !== "tool-out") continue;
    const text = String(l.text || "");
    if (!isFailureLine(text)) continue;
    // Digits are usually a line number or a duration; the shape of the failure is what repeats.
    const key = clip(text.replace(/\d+/g, "#").replace(/\s+/g, " ").trim(), 180);
    if (!key) continue;
    const cur = counts.get(key) || { key, count: 0, at: 0 };
    cur.count += 1;
    cur.at = Number(l.at) || cur.at;
    counts.set(key, cur);
  }
  let best = null;
  for (const c of counts.values()) if (c.count >= limit && (!best || c.count > best.count)) best = c;
  return best;
}

// Where a turn ended up when it failed: the call that produced the last failing result, plus the failing line with
// its numbers masked. "npm test · Tests failed: 2" from three turns in a row is the same place; "npm test" alone
// would collide with every command that exits non-zero.
export function turnFailure(j) {
  const lines = j?.lines || [];
  let call = null;
  let failure = null;
  for (const l of lines) {
    const t = parseToolLine(l);
    if (t) {
      call = `${t.tool}|${t.input}`;
      continue;
    }
    if (l.kind !== "tool-out") continue;
    const text = String(l.text || "");
    if (!isFailureLine(text)) continue;
    failure = { call, text };
  }
  if (failure) {
    const detail = failure.text
      .replace(/\(exit\s+\d+\)/i, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\d+/g, "#");
    return `fail:${failure.call || "?"}|${clip(detail, 120)}`;
  }
  // A turn that ended badly with no failing line: the call it kept repeating is the same place.
  if (["failed", "cancelled", "interrupted"].includes(String(j?.status))) {
    const rep = detectRepeat(lines, 2);
    if (rep) return `call:${rep.key}`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The facts a job summary answers, asked the same way by every rule and by the page.

const LIVE_STATUS = new Set(["running", "starting", "waiting", "waiting_for_approval", "queued"]);

// The tail of the tree a turn works in, for the digest: enough to see two agents in one place, short enough to read.
export function treeTail(j) {
  const p = String((j && (j.ownerPath || j.worktreePath || j.cwd)) || "").replace(/\\/g, "/");
  const parts = p.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || "(no tree)";
}

export function isLive(j) {
  return Boolean(j) && (LIVE_STATUS.has(j.status) || Boolean(j.approval));
}

// When a turn was over. `endedAt` is the answer for a run this panel watched to the end; an `interrupted` job
// (the panel restarted mid-run) has none, and its last line is when it last did anything. 0 means still live.
export function endedAtMs(j) {
  if (!j || isLive(j)) return 0;
  const ended = Date.parse(j.endedAt || "");
  if (Number.isFinite(ended) && ended) return ended;
  return Number((j.lines || []).at(-1)?.at) || Date.parse(j.startedAt || "") || 0;
}

// Which of two turns of one thread came last. The clock decides, not `turn`: that number is a sequence over the
// jobs this store still holds (`siblings.length + 1`), so once KEEP_JOBS trims old turns it moves *backwards* — a
// resumed thread can carry a lower number than the interrupted turn it replaced (measured live: a revive got turn 6
// beside an interrupted turn 8, and the interrupted rule went on calling the dead turn the latest one). `turn` is
// only a tiebreaker for two turns that started in the same millisecond.
export function newerTurn(a, b) {
  const ta = Date.parse(a?.startedAt || "");
  const tb = Date.parse(b?.startedAt || "");
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta > tb;
  return (Number(a?.turn) || 0) > (Number(b?.turn) || 0);
}

export function nameOf(j) {
  const raw = j?.label || j?.title || j?.thread || "agent";
  return clip(String(raw).replace(/^Subagent:\s*/i, ""), 60);
}

export function minutes(ms) {
  const m = Math.max(0, Math.round(Number(ms) / 60_000));
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function lastLine(j) {
  for (let i = (j.lines || []).length - 1; i >= 0; i -= 1) {
    const l = j.lines[i];
    if (l.kind === "text" || l.kind === "raw" || l.kind === "dim") {
      if (String(l.text || "").trim()) return String(l.text).trim();
    }
  }
  return "";
}

// The turn's own prose, in order, with tool bookkeeping left out. Streamed deltas grow one line in
// place, so the last text line is the finished paragraph.
//
// This is the LAST paragraph, which is what a question is judged on (a trailing "…should I?" is the last
// thing the agent wrote). It is NOT the whole answer: the action harvest reads `turnProse` instead, because
// a turn writes its SPAWN, its TO and its NOTE on separate lines — one text line per paragraph — and reading
// only the last one carried out the NOTE while dropping the SPAWN above it without a word (see `harvest`).
export function lastProse(lines) {
  for (let i = (lines || []).length - 1; i >= 0; i -= 1) {
    const l = lines[i];
    if (l.kind === "text" && String(l.text || "").trim()) return String(l.text).trim();
  }
  return "";
}

// Everything the turn wrote, paragraph by paragraph, in order. The run stream opens a new text line wherever
// the reply breaks a paragraph — and the phases around a tool call resend the prose in pieces — so the answer
// is spread over several lines that each hold part of it. Joining them is the only way to see every line the
// assistant wrote; a line the stream resent in full (a later block that already contains an earlier one)
// replaces it rather than being read twice, so nothing is carried out twice.
//
// The resend test is a PREFIX, on either side, and has to stay one. Streaming grows one text line in place, so
// a resent block starts with the shorter one. A plain CONTAINMENT test — which this used to be — also swallows
// a short line that merely appears somewhere inside a longer one, and the action lines the harvest reads are
// short and quotable: on 2026-10-26 two assistant turns each wrote a bare `RESTART panel` and quoted it in the
// prose around it ("…press RESTART panel in the panel…", "…hence the RESTART panel queued this turn…"), so the
// paragraph was taken for a resend of the action line and deleted it from the joined prose. The harvest then
// saw no restart at all: no queue, no refusal, no journal line, and the panel was never replaced. Both of those
// turns' NOTEs were carried out normally, which is what made it look like the RESTART line had been refused.
// tools/verify-restart-line-harvest.mjs drives both shapes through a sandbox panel and fails on a containment
// test.
export function turnProse(lines) {
  const blocks = [];
  for (const l of lines || []) {
    if (l.kind !== "text") continue;
    const t = String(l.text || "").trim();
    if (!t) continue;
    // `trim()` on both sides: a paragraph resent as part of a longer block arrives with the paragraph breaks
    // that separate it, so a prefix is the test, not equality.
    let covered = -1;
    for (let i = 0; i < blocks.length; i += 1) {
      if (blocks[i].startsWith(t) || t.startsWith(blocks[i])) {
        covered = i;
        break;
      }
    }
    if (covered === -1) blocks.push(t);
    else if (t.length > blocks[covered].length) blocks[covered] = t;
  }
  return blocks.join("\n");
}
