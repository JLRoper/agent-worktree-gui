// The client console, cut out of public/app.js. A classic script, evaluated BEFORE app.js
// (public/index.html) because app.js's boot IIFE calls the console's renderers on the first paint.
//
// What that load order buys, and what it forbids:
//   * every top-level `function` here is a `window` property under its own name, so an inline
//     handler, a later script and the other board modules read it exactly as they read it before;
//   * every top-level `const`/`let` here is a lexical binding in the page's one global lexical
//     environment, which the later app.js reads by bare name;
//   * a name this file does NOT declare (`state`, `esc`, `apiFetch`, `toolGroupsOn`,
//     `paintSubagents`, `typeWordSpeed`, …) may only be read from inside a function body. At top
//     level app.js has not run yet: the console's own `state.*` initialisations therefore stay in
//     app.js, beside the `state` literal they extend.
//
// The seam is the console's: tool-burst bookkeeping, the tool call as a row, the sub-console,
// reasoning pacing, the console's row text/markdown/raw, its writers, copy and motion, the
// reader's own input and scroll, and the job lines. Everything that draws a card, a row, a chart,
// the deliverable list, Settings or the pipeline modal stays in app.js.

// A tool that runs for minutes is the one thing that makes a healthy turn look frozen — a 159 s
// recursive grep did exactly that, and the card showed nothing but the line that started it. Every
// line carries the server's timestamp, so the tool still in flight can grow a live clock.
// Lines lead with the tool's glyph (📖 read_file · path); history written before glyphs leads with ▸,
// so the arrow is optional and the glyph run is skipped before the name is taken.
const TOOL_START_RE = /^(?:▸\s*)?(?:[\p{Extended_Pictographic}\uFE0F\u200D]+\s*)?([^\s·]+)/u;
const TOOL_DONE_RE = /^\s*↳\s*([^\s·]+)/;
// The argument a call line carries ("📖 read_file · docs/map.md"): what the tool was given. The console's own
// rows use it, and a file's code box names the file from it.
const toolCallArg = (text) => {
  const s = String(text || "");
  const sep = s.indexOf(" · ");
  return sep >= 0 ? s.slice(sep + 3) : "";
};

// Index of the started tool call that has no result yet, or -1. Parallel calls interleave, so count
// starts and completions per tool name rather than assuming the last line is the running one.
function inflightToolIndex(lines) {
  const started = new Map();
  const finished = new Map();
  let lastIdx = -1;
  let lastName = null;
  lines.forEach((l, i) => {
    const text = String(l.text || "");
    const start = l.kind === "tool" ? TOOL_START_RE.exec(text) : null;
    if (start) {
      started.set(start[1], (started.get(start[1]) || 0) + 1);
      lastIdx = i;
      lastName = start[1];
      return;
    }
    const done = l.kind === "tool-out" ? TOOL_DONE_RE.exec(text) : null;
    if (done) finished.set(done[1], (finished.get(done[1]) || 0) + 1);
  });
  if (lastIdx < 0 || !lastName) return -1;
  return (started.get(lastName) || 0) > (finished.get(lastName) || 0) ? lastIdx : -1;
}

// The name of the call that has started and not come back - the reason a steer can sit undelivered for minutes.
function inflightToolName(lines) {
  const i = inflightToolIndex(lines);
  if (i < 0) return null;
  const m = TOOL_START_RE.exec(String(lines[i].text || ""));
  return m ? m[1] : null;
}

// The console is what the agent DID, not the run protocol around it. Three lines are bookkeeping: the POST
// that opened the run, the run id echoed back, and the completion summary with the token total. The card
// already states all three — the head carries "turn 2 · done · 26s · 186725 tok" and the foot the outcome —
// so they are stored but not drawn.
const BOOKKEEPING_LINES = new Set(["cmd", "init", "result"]);
function isBookkeeping(l) {
  return Boolean(l && BOOKKEEPING_LINES.has(l.kind));
}

// A run of tool calls with nothing said in between is one burst. The console draws it as one row per tool with a
// tally and the input of the last call - what the agent is doing, not every instance of it - while the full lines
// stay one click away. Text ends the burst: the next tool call starts a fresh tally at that point in the transcript.
// One console line. data-ltext/data-lkind carry the line itself rather than what it renders to, because a
// burst rebuild reads the lines back out of the DOM (groupLines): a link, a running clock or a diff window's
// markup must not change what the next render believes the line said.
function lineHtml(l, live = "", cls = "") {
  const kind = l.kind || "raw";
  // A line the stream is still revealing is drawn up to what may be shown NOW, not up to the wire's whole text:
  // a repaint mid-paragraph (a scan, a pinned copy, the 3s result sweep) must not jump the console ahead of the
  // words the reader is watching arrive. Every other line — history, a tool line, reasoning — is drawn whole.
  const shown = typedShown(l);
  const text = shown == null ? l.text : shown;
  // The agent's own words are the one kind drawn as markdown (core/console-markdown.js): the markers it writes
  // are meant to be shapes. A tool line, a panel note and the run protocol keep the plain escaped line they have
  // always had — a diff's "+ added" is not a list item. Both paths escape first; neither ever injects HTML.
  const body = consoleMdIsProse(kind) ? consoleMdInline(text) : linkifyText(text);
  return `<div class="jl jl-${esc(kind)}${cls ? ` ${cls}` : ""}" data-lid="${esc(l.lid ?? "")}" data-ltext="${esc(l.text ?? "")}" data-lkind="${esc(kind)}">${body}${live}</div>`;
}

function burstGroups(lines) {
  const out = [];
  let burst = null;
  for (const l of lines) {
    if (l.kind === "tool" || l.kind === "tool-out") {
      if (!burst) {
        burst = { group: true, lines: [] };
        out.push(burst);
      }
      burst.lines.push(l);
    } else {
      burst = null;
      out.push({ group: false, line: l });
    }
  }
  return out;
}

// One row per tool name: how many times, the input of the most recent call, and whether it is still running.
function toolBurstRows(lines) {
  const rows = new Map();
  for (const l of lines) {
    const text = String(l.text || "");
    if (l.kind === "tool") {
      const m = TOOL_START_RE.exec(text);
      if (!m) continue;
      const name = m[1];
      const sep = text.indexOf(" · ");
      const g = /^(\p{Extended_Pictographic}[\uFE0F\u200D]*)\s*/u.exec(text);
      const row = rows.get(name) || { name, glyph: (g && g[1]) || "⚡", count: 0, done: 0, last: "", at: null, duration: null };
      row.count += 1;
      row.last = sep >= 0 ? text.slice(sep + 3) : "";
      row.at = Number(l.at) || Date.now();
      rows.set(name, row);
    } else if (l.kind === "tool-out") {
      const m = TOOL_DONE_RE.exec(text);
      if (!m) continue;
      const row = rows.get(m[1]);
      if (!row) continue;
      row.done += 1;
      const d = /·\s*([\d.]+)s/.exec(text);
      if (d) row.duration = Number(d[1]);
    }
  }
  return [...rows.values()];
}

// A call plus the output it produced, so one tool's rows can be opened on their own. A result block starts at the
// "↳ name" line and runs until the next call or result; the plain lines belong to the result above them.
function burstSegments(lines) {
  const out = [];
  let cur = null;
  for (const l of lines) {
    const text = String(l.text || "");
    if (l.kind === "tool") {
      const m = TOOL_START_RE.exec(text);
      cur = { tool: m ? m[1] : "", lines: [l] };
      out.push(cur);
    } else if (l.kind === "tool-out") {
      const m = TOOL_DONE_RE.exec(text);
      if (m) {
        cur = { tool: m[1], lines: [l] };
        out.push(cur);
      } else if (cur) {
        cur.lines.push(l);
      } else {
        cur = { tool: "", lines: [l] };
        out.push(cur);
      }
    }
  }
  return out;
}

// Every line of a group, from the live model when we have it and from the DOM when the group came from a full render.
function groupLines(grp) {
  if (grp._burst) return grp._burst;
  // Read the console lines back out of the DOM - but not the panel's own additions to a block: stored output, the
  // notes under it and an opened batch are all drawn UNDER a line, so counting them inflates the line tally and
  // turns them into console lines of their own on the next rebuild (an opened batch was re-absorbed as five
  // summaries that then satisfied "the preview carried this result").
  const read = (d) => {
    // The line's own text, not the rendered text: a diff window draws one row per change and a code box
    // holds its lines folded, and neither may cost the rebuild a line or invent one (the carried file label
    // is not a .jl for exactly that reason).
    const line = {
      kind: d.dataset.lkind || (d.className.match(/jl-([a-z-]+)/) || [])[1] || "raw",
      text: d.dataset.ltext != null ? d.dataset.ltext : d.textContent,
      // …and the id the row was drawn with, because it is what the next update looks the row up by: the live
      // append replaces a growing line's text through `[data-lid]`, and `paintTypedLines` finishes a half-typed one
      // the same way. A rebuild that read this back without it handed every row it redrew an empty id, so the
      // identity did not survive the group being re-cut.
      lid: d.dataset.lid || undefined,
    };
    // …and which result a fold note names travels with it too: the sentence cannot say it (that is what the
    // stamp on the line is for), and a rebuild that lost it would put the reader back in front of "click to
    // read" with nothing to click. Read from the button the note was already drawn as.
    const btn = d.querySelector ? d.querySelector("[data-tool-fold]") : null;
    if (btn) line.fold = { tool: btn.dataset.foldTool || "", row: Math.max(0, Number(btn.dataset.foldRow) || 0) };
    return line;
  };
  const out = [];
  const sources = new Map();
  for (const d of grp.querySelectorAll(".tgrp-body .jl, .tgrp-body .code-box[data-code-source]")) {
    const box = d.closest(".code-box[data-code-source]");
    if (box) {
      if (!sources.has(box)) {
        let lines = null;
        try { lines = JSON.parse(box.dataset.codeSource); } catch { /* a damaged attribute falls back to the DOM */ }
        sources.set(box, Array.isArray(lines) ? lines : null);
      }
      const lines = sources.get(box);
      if (lines) {
        if (d === box) out.push(...lines);
        continue;
      }
      if (d === box) continue;
    }
    if (d.classList.contains("jl-store") || d.classList.contains("jl-note") || d.classList.contains("jl-panel")) continue;
    // A stream row is the record of BOTH the call and the result that answered it: neither is drawn as a line of
    // its own (the row says the tool, the target and the time), so both halves travel on the row — data-ltext for
    // the call, data-lresult for the result header the console used to draw under it. Read them back as the two
    // lines they are: without the header a rebuild loses the call's time, and `storeOffsetsBefore` (which counts
    // result headers) hands the NEXT burst the wrong starting row for its stored output.
    if (d.dataset && d.dataset.lresult) {
      out.push(read(d), {
        kind: "tool-out",
        text: d.dataset.lresult,
        at: Number(d.dataset.lrat) || undefined,
        lid: d.dataset.lrld || undefined,
      });
      continue;
    }
    // A modification is drawn with its AFTER line first (the reader asked for the new side on the left), which is
    // the opposite of the order the diff had it in. A rebuild re-derives the diff from these lines, and a pair
    // read back the other way round re-classifies as a lone addition plus a lone removal - every modification
    // redrawn as two rows. So a row carrying data-lpair is read back in the diff's own order.
    const row = d.parentElement;
    const cells = row && row.dataset && row.dataset.lpair === "1" ? [...row.children] : null;
    if (cells && cells.length === 2) {
      if (d === cells[0]) continue; // read with its partner, below
      out.push(read(cells[1]), read(cells[0]));
      continue;
    }
    out.push(read(d));
  }
  return out;
}

// How many result lines of each tool the bursts already in this console have drawn. That count is where the NEXT
// burst's pairing starts (see data-gofs): a turn holds several bursts of the same tool, and each one owns its own
// slice of the store's rows.
function storeOffsetsBefore(consoleEl, except) {
  const seen = {};
  for (const g of consoleEl.querySelectorAll(".tgrp")) {
    if (g === except) continue;
    for (const l of groupLines(g)) {
      if (l.kind !== "tool-out") continue;
      const m = TOOL_DONE_RE.exec(String(l.text || ""));
      if (m) seen[m[1]] = (seen[m[1]] || 0) + 1;
    }
  }
  return seen;
}

// How many result blocks the console drew for one tool: each one is a call's output, and the session store has
// one row for each of them, so this is also how many rows to ask for.
function resultBlocksFor(lines, tool) {
  return (lines || []).filter((l) => {
    if (l.kind !== "tool-out") return false;
    const m = TOOL_DONE_RE.exec(String(l.text || ""));
    return Boolean(m) && m[1] === tool;
  }).length;
}

// Rebuild the group the reader has open, wherever it is on the board: the element that asked for the results may
// have been replaced by a repaint while the request was in flight, so aim by the group's stable state key.
function repaintToolGroup(grp) {
  if (!grp || !grp.dataset) return;
  // One turn can be drawn twice (the pinned card and its paged copy), so the lookup stays inside the console that
  // owns this group. The state key is the stable identity and wins; the group key is only a fallback, because the
  // index in it shifts when a long turn is trimmed to its last 300 lines.
  const scope = grp.closest("pre.job-out") || document;
  const gkey = grp.dataset.gstate || "";
  const key = grp.dataset.tgrp || "";
  const live =
    (gkey && scope.querySelector(`.tgrp[data-gstate="${CSS.escape(gkey)}"]`)) ||
    (key && scope.querySelector(`.tgrp[data-tgrp="${CSS.escape(key)}"]`));
  if (!live) return;
  const bodyEl = live.querySelector(".tgrp-body");
  rebuildToolGroup(live, { filter: live.dataset.filter || "", open: bodyEl ? !bodyEl.hidden : true });
}

// Ask the panel server for this turn's stored results for one tool. The live stream's preview is often empty,
// so this is where "↳ patch" turns into the thing the tool actually returned.
//
// A turn that is still running keeps producing results: a fetch taken when the reader opened the block saw one
// patch while the burst ended with five, and every later call kept an empty header - so an entry cached while the
// turn is live expires (five seconds) instead of answering for the rest of the turn. An entry taken while live is
// also refetched ONCE after the turn ends: the last results of a turn land within a second of its endedAt, and
// freezing the mid-run answer is how a finished turn shows three "no output recorded" where the output exists.
async function ensureToolStore(turnId, tool, grp = null) {
  const cacheKey = `${turnId}|${tool}`;
  if (!turnId || !tool || !state.jobs.has(turnId)) return;
  if (state.toolStorePending.has(cacheKey)) return;
  const job = state.jobs.get(turnId);
  const live = turnLive(job);
  const have = state.toolStore.get(cacheKey);
  if (have && !(have.live && !live) && (!live || Date.now() - have.at < 5000)) return;
  // One row per result line the WHOLE TURN drew for this tool, because the entry is shared by every burst in the
  // turn: sizing it to the group that happened to fetch first cut the later bursts off at that group's count, and
  // the missing rows read as "no output recorded". A fold note names its result by that result's index over the
  // whole turn, so the read covers up to the furthest row this turn's own notes name as well — the head above
  // such a note is only checkable against its own row if the row is in hand.
  const turnLines = jobLines(turnId);
  const stamped = stampedRowFor(turnLines, tool);
  const n = Math.min(60, Math.max(4, resultBlocksFor(turnLines, tool) + 1, stamped == null ? 0 : stamped + 1));
  let changed = false;
  state.toolStorePending.add(cacheKey);
  try {
    const q = new URLSearchParams({
      thread: job.thread || job.id,
      tool,
      n: String(n),
      from: String(Date.parse(job.startedAt || "") || 0),
      to: String(Date.parse(job.endedAt || "") || 0),
    });
    const r = await apiFetch(`/api/tool-results?${q}`, {}, { timeoutMs: 15000 });
    // apiFetch does not throw on a 4xx/5xx: a refusal parsed as `{results: []}` would be cached as "the store has
    // nothing", and every call in the block would say so for good.
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const results = Array.isArray(d.results) ? d.results : [];
    changed = JSON.stringify(results) !== JSON.stringify(have ? have.results : null);
    state.toolStore.set(cacheKey, { at: Date.now(), live, results });
    // One entry per (turn, tool) the reader ever opened; a long-lived tab must not keep them all.
    while (state.toolStore.size > 300) state.toolStore.delete(state.toolStore.keys().next().value);
  } catch {
    // Left uncached on purpose: a failed read is not an answer, and the next open retries it.
  } finally {
    state.toolStorePending.delete(cacheKey);
  }
  // Only a real change is worth a repaint: rebuilding the block detaches its text nodes, and a reader dragging
  // across a diff loses the selection when it happens on every sweep.
  if (changed) repaintToolGroup(grp);
}

// The panel's fold, opened: the whole stored text of one result, drawn in place of the note that offered it.
//
// This is the DOM being handed the rest of a result, never the job's own lines: the console's ring buffer
// (jobs.js MAX_LINES = 600) is what a big result would evict, and a result the reader asked to see is not
// something the card has to keep — it is one click away again after any repaint.
//
// The box it is drawn in is OPEN: the reader pressed "click to read" on the note, so a second press to unfold what
// they just asked for would read as the panel ignoring them. That is the one box that is open by default, which is
// why it keeps the boxes the reader SHUT (state.codeBoxShut) where every other box keeps the ones they opened.
const READ_CODE_OPEN = { openByDefault: true, has: (key) => !state.codeBoxShut.has(key) };
function wholeStoredHtml(got, tool = "", arg = "", boxKey = "", codeOpen = READ_CODE_OPEN) {
  const LF = String.fromCharCode(10);
  const all = String((got && got.text) || "").split(LF);
  if (!all.some((l) => l.trim())) return `<div class="jl jl-dim jl-note">  the stored result has no text</div>`;
  return (
    consoleBodyHtml(all.map((l) => ({ kind: "store", text: l })), { tool, arg, codeOpen, codeKey: boxKey, whole: true }) +
    (got.truncated ? `<div class="jl jl-dim jl-note">… this stored result was cut as well</div>` : "")
  );
}

// Which result a fold belongs to, and how many of them the opened tab may hold. The row is the pairing the burst
// already uses (the i-th result line of this tool in this turn is the store's i-th row for it), so the number the
// note was drawn with is the number the fetch asks for.
const foldKey = (turnId, tool, row) => `${turnId}|${tool}|${row}`;
const fullForFold = (fold) => state.foldRows.get(foldKey(fold.turn, fold.tool, fold.row));
const FOLD_ROWS_MAX = 12;

// Which row of the store a fold note names. The stronger of two facts wins, and the per-burst cursor is only
// the last resort.
//
// The store indexes a tool's results over the WHOLE TURN (lib/tool-results.js: one row at `OFFSET row`, ordered
// by the turn's clock window), while the console's own lines are a trimmed window of that turn — 600 lines in
// memory, the last 120 served — so a position inside the console is NOT that number. Measured: the clickable
// note in burst `9658fe9e#2` named `row=0` while the store's row 0 for `terminal` is the turn's opening recon
// command (799 chars, 14 lines), a different result entirely, so the click read back the wrong text.
//
//   * the head the panel kept. The console lines drawn above a note ARE the first lines of the stored row: one
//     fold, one `unwrapToolText` (lib/jobs/console-lines.js pushes the head, lib/tool-results.js reads the store
//     back through the same unwrapping), 40 lines on both sides. So once the burst has read its tool's rows, the
//     note names the row those lines came from — and that row can be checked against its own text.
//   * the row the server stamped on the note (`line.fold`): this result's index among the turn's results for
//     that tool, counted at the event (lib/jobs.js `withResultRow`). The only handle a burst the window trimmed
//     of its call line has, and right whenever the panel saw every result of the turn.
const HEAD_LINES = 40; // MAX_TOOL_LINES in lib/jobs/console-lines.js: the head the panel keeps of a result
const LF = String.fromCharCode(10);
// A line as it compares: no trailing newline, no trailing blanks. The panel trims trailing whitespace on the
// console side of nothing, but a diff's context lines and a store row's may differ by exactly that.
const foldLineText = (l) => String((l && l.text) != null ? l.text : l || "").replace(/\s+$/, "");
const storeRowsFor = (turnId, tool) => state.toolStore.get(`${turnId}|${tool}`)?.results || null;

// The store row a head of console lines came from: the row whose text carries those lines, in order, inside the
// head the panel kept (the row's first 40 lines). `prefer` is the row the note's own stamp named — checked
// first, so a note whose stamp is right keeps naming exactly that row (two results whose heads read the same,
// the same command run twice, are told apart by it), and one whose stamp drifted is repaired to the row the
// lines really came from.
function rowForHead(rows, head, prefer = null) {
  const H = (Array.isArray(head) ? head : []).map(foldLineText).filter((t) => t.trim());
  if (!H.length || !Array.isArray(rows) || !rows.length) return null;
  const hits = [];
  for (let i = 0; i < rows.length; i++) {
    const R = foldLineText(rows[i]).split(LF);
    for (let j = 0; j + H.length <= R.length && j <= HEAD_LINES; j++) {
      if (H.every((h, k) => R[j + k].startsWith(h))) {
        hits.push({ i, j });
        break;
      }
    }
  }
  if (!hits.length) return null;
  const wanted = hits.find((h) => h.i === prefer);
  if (wanted) return wanted.i;
  // A head that starts the row is the stronger reading than one that ends in the middle of it (which is what a
  // trimmed window leaves behind), so a j = 0 match wins over a later row's suffix match.
  const best = hits.reduce((a, b) => (b.j < a.j ? b : a));
  return best.i;
}

// The fold context a note is drawn with: the turn, the tool it belongs to, and the row of the store it names.
// `tool` is what the caller knows from the burst (a result header named it); the note's own stamp wins when the
// window trimmed that away. `cursor` is the burst's pairing, for a line written before the stamp existed.
function foldForNote({ turnId, tool = "", note = null, head = [], cursor = null }) {
  const stamped = note && note.fold ? note.fold : null;
  const which = String((stamped && stamped.tool) || tool || "");
  // No tool anywhere: a note written before the stamp existed, in a burst the window trimmed of its call line.
  // The head over it still does not answer for one tool only, so ask whichever of THIS turn's tool reads is in
  // hand which row those lines came from — the answer names the tool as well as the row.
  if (!which) return foldByHeadAnyTool(turnId, head);
  const prefer = stamped && stamped.row != null ? Math.max(0, Number(stamped.row) || 0) : null;
  const byHead = rowForHead(storeRowsFor(turnId, which), head, prefer);
  const row = byHead != null ? byHead : prefer != null ? prefer : cursor;
  if (row == null) return null;
  return { turn: turnId, tool: which, row: Math.max(0, Number(row) || 0) };
}

// Which of this turn's tools a head of console lines came from, across the store reads the card has in hand
// (the same reads every burst of the turn shares). Only ever consulted for a note that can name no tool of its
// own; the first read whose rows carry the head is the answer.
function foldByHeadAnyTool(turnId, head) {
  const prefix = `${turnId}|`;
  for (const [key, entry] of state.toolStore) {
    if (!key.startsWith(prefix) || !entry || !Array.isArray(entry.results) || !entry.results.length) continue;
    const row = rowForHead(entry.results, head, null);
    if (row != null) return { turn: turnId, tool: key.slice(prefix.length), row: Math.max(0, Number(row) || 0) };
  }
  return null;
}

// Every note's fold context in a list of console lines, keyed by the note line itself. Where the lines are drawn
// in one go (a burst the window trimmed of its call line, so no segment names its own tool), each note is still
// resolved from its stamp and the head above it — bounded to the head's own length, because a note ends the head
// the panel kept.
function noteFolds(turnId, lines) {
  const folds = new Map();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l || l.kind !== "tool-out" || !consoleFoldNote(String(l.text || ""))) continue;
    const fold = foldForNote({ turnId, note: l, head: lines.slice(Math.max(0, i - HEAD_LINES), i) });
    if (fold) folds.set(l, fold);
  }
  return folds;
}

// The tools a burst's store read has to cover: the ones its call lines name, plus any a fold note inside it
// names. A burst the window trimmed of its call line has no rows to count, and the note is the only thing left
// that says which result it folds.
function burstStoreTools(lines) {
  const out = new Set(toolBurstRows(lines).map((r) => r.name));
  for (const l of lines) if (l && l.fold && l.fold.tool) out.add(String(l.fold.tool));
  return [...out].filter(Boolean);
}

// The furthest row this turn's own notes name for one tool: the store read that pairs a burst asks for the rows
// its result lines need, and one more result than that when a note names a later one (the head above the note
// has to be checkable against the row it claims).
function stampedRowFor(lines, tool) {
  let out = null;
  for (const l of lines || []) {
    if (!l || !l.fold || String(l.fold.tool || "") !== tool || l.fold.row == null) continue;
    const row = Math.max(0, Number(l.fold.row) || 0);
    if (out == null || row > out) out = row;
  }
  return out;
}

// The reader clicked the fold: read that one row out of the session store — whole, not the store reader's own
// 6,000-character display cut — and let the card redraw the burst with it. The request carries the turn's own
// window, exactly like the store fetch a burst makes, because the store is queried by time
// (lib/tool-results.js) and the turn's clock is the only thing that says which rows are its.
async function expandToolFold(btn) {
  const grp = btn.closest(".tgrp");
  // The button carries the turn it was drawn for (data-fold-turn). The burst's own key is the same number, but a
  // burst the window trimmed of its call line is drawn as bare console lines — no `.tgrp` to read it from — and
  // the note there is still a control the reader can press.
  const turnId = String(btn.dataset.foldTurn || (grp && grp.dataset.tgrp) || "").split("#")[0];
  const tool = btn.dataset.foldTool || "";
  const row = Math.max(0, Number(btn.dataset.foldRow) || 0);
  if (!turnId || !tool) return false;
  const job = state.jobs.get(turnId);
  if (!job) return true;
  const key = foldKey(turnId, tool, row);
  // The press is the reader asking for this result, so the console holds still while it arrives (Settings > Agent
  // cards, off by default): the answer lands under the note that was pressed, not at the bottom of the console.
  holdConsoleFor(btn);
  const rememberOpen = () => {
    state.codeBoxOpen.add(btn.dataset.codeKey || `result|${turnId}|${tool}|${row}`);
    while (state.codeBoxOpen.size > 500) state.codeBoxOpen.delete(state.codeBoxOpen.values().next().value);
  };
  if (state.foldRows.has(key)) {
    rememberOpen();
    if (grp) repaintToolGroup(grp);
    return true;
  }
  const q = new URLSearchParams({
    thread: job.thread || job.id,
    tool,
    row: String(row),
    full: "1",
    n: "1",
    from: String(Date.parse(job.startedAt || "") || 0),
    to: String(Date.parse(job.endedAt || "") || 0),
  });
  const hint = btn.querySelector(".code-hint");
  const say = (text) => { if (hint) hint.textContent = text; else btn.textContent = text; };
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  say("reading the stored result…");
  let pending = null;
  try {
    pending = state.foldPending.get(key);
    if (!pending) {
      pending = (async () => {
        const r = await apiFetch(`/api/tool-results?${q}`, {}, { timeoutMs: 15000 });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        return Array.isArray(d.results) ? d.results[0] : null;
      })();
      state.foldPending.set(key, pending);
    }
    const got = await pending;
    if (!got || !String(got.text || "").trim()) {
      // A missing or empty copy is not a full result. Keep the preview, and leave the header retryable.
      say(got ? "the stored result has no text — click to retry" : "the session store has no copy of this result — click to retry");
      return true;
    }
    state.foldRows.set(key, got);
    rememberOpen();
    // Retire closed cached results first. Evicting one the reader still has open would shrink it on a repaint.
    for (const held of state.foldRows.keys()) {
      if (state.foldRows.size <= FOLD_ROWS_MAX) break;
      if (!state.codeBoxOpen.has(`result|${held}`)) state.foldRows.delete(held);
    }
    if (grp) repaintToolGroup(grp);
    else {
      // No burst wrapper to repaint: a burst the window trimmed of its call lines is drawn as bare console lines.
      // The whole stored row goes in the note's own place — the same markup the next full repaint draws there
      // (trimmedBurstHtml), so the answer is on the card now rather than at the next paint.
      const rowEl = btn.closest(".jl-fold");
      const holder = document.createElement("div");
      holder.innerHTML = wholeStoredHtml(got, tool, "", `${turnId}|${tool}`);
      if (rowEl && rowEl.parentElement && holder.firstChild) rowEl.replaceWith(...holder.childNodes);
    }
  } catch {
    say("the session store could not be read; click to retry");
  } finally {
    if (state.foldPending.get(key) === pending) state.foldPending.delete(key);
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
  }
  return true;
}

// The calls behind a "+ N commands" batch: the run stream only carries the gateway's summary of a parallel batch, so
// this asks the panel server to read the session transcript and then re-renders the burst open with them in it.
async function loadBatchCalls(btn) {
  const grp = btn.closest(".tgrp");
  if (!grp) return;
  // The batch is about to be drawn open under this button, so the console holds its place rather than sliding down
  // to the end of the list that arrives (Settings > Agent cards, off by default).
  holdConsoleFor(btn);
  const gkey = btn.dataset.batchKey || grp.dataset.gstate || "";
  const tool = btn.dataset.batchTool || "";
  const want = Number(btn.dataset.batchN) || 4;
  const key = grp.dataset.tgrp || "";
  const turnId = String(key).split("#")[0];
  // The card's thread, so the server can find the session whose transcript holds the batch - and the turn's own
  // start, so it reads THAT turn's batch rather than the newest one in the session.
  const job = state.jobs.get(turnId);
  const thread = job?.thread || turnId;
  const since = job?.startedAt ? Date.parse(job.startedAt) || 0 : 0;
  btn.disabled = true;
  btn.textContent = "reading the transcript…";
  let calls = [];
  try {
    // The summary prints the calls it did NOT show, so the batch ran want+1 of them: that count is what picks the
    // right message out of the transcript.
    const first = btn.dataset.batchFirst || "";
    const q = new URLSearchParams({ thread, tool, n: String(Math.max(2, want + 1)), want: String(want + 1), since: String(since), first });
    const r = await apiFetch(`/api/tool-calls?${q}`, {}, { timeoutMs: 15000 });
    const d = await r.json().catch(() => ({}));
    calls = Array.isArray(d.calls) ? d.calls : [];
    if (!r.ok && d.error) throw new Error(d.error);
  } catch (e) {
    showBanner(`could not read the batch: ${e.message}`);
  }
  if (calls.length) {
    state.batchCalls.set(`${gkey}|${tool}`, calls);
    // One entry per burst the reader opened; a long-lived tab should not keep every one of them forever.
    while (state.batchCalls.size > 300) state.batchCalls.delete(state.batchCalls.keys().next().value);
  } else {
    showBanner(`the session transcript has no record of this ${tool} batch yet`);
  }
  const live = document.querySelector(`.tgrp[data-gstate="${CSS.escape(gkey)}"]`) || grp;
  if (live?.isConnected) rebuildToolGroup(live, { filter: live.dataset.filter || "", open: true });
}

function rebuildToolGroup(grp, { filter = "", open = false } = {}) {
  const key = grp.dataset.tgrp || "";
  const lines = groupLines(grp);
  // The anchor is the burst's own identity and travels on the node: lines read back out of the DOM carry no
  // timestamp, so without it a rebuild re-keyed the group from the first line's text and the reader's open
  // state was remembered under one key while the next repaint looked it up under another.
  const anchor = grp.dataset.gat || "";
  let gofs = null;
  try {
    gofs = grp.dataset.gofs ? JSON.parse(grp.dataset.gofs) : null;
  } catch {
    gofs = null;
  }
  const gkey = grp.dataset.gstate || toolGroupStateKey(key, lines, anchor);
  // The click is the new truth, so record it before rendering: toolGroupHtml prefers the remembered state, and
  // otherwise it would faithfully put back the state the reader just changed.
  if (toolGroupDropsState(open, filter, grp.dataset.gdefault === "open")) state.toolGroupOpen.delete(gkey);
  else state.toolGroupOpen.set(gkey, { open, filter });
  const holder = document.createElement("div");
  // A piece of a stream stays a piece of a stream: rebuilding it condensed (a store read landing, a batch opened,
  // the rollup refreshed) would put the folded group back under a card whose whole point is that nothing is folded.
  // The blank line it was drawn with is part of the piece too, so the rebuild keeps it rather than losing it until
  // the next full repaint.
  holder.innerHTML = toolGroupHtml(lines, key, filter, open, anchor, gofs, grp.dataset.gflat === "1" ? { flat: true, sep: grp.classList.contains("jl-sep") } : {});
  const fresh = holder.firstElementChild;
  if (!fresh) return;
  fresh._burst = lines;
  grp.replaceWith(fresh);
  rememberToolGroup(fresh);
}

// ---- tool group key: what a burst is remembered BY, and the window that keeps that identity in view
// A burst's identity, for remembering whether the reader opened it. The group's DOM key changes when the console
// is rebuilt from the buffer (it is the group's index) and when the stream starts a new burst (it is a timestamp),
// so the state is keyed by the turn plus the first line the burst holds - which is the same line in all three.
//
// It has to be the burst's first CALL. A result line above it belongs to a call the console no longer holds, and it
// slides out of the window as the turn grows, so an anchor derived from it re-keys the group under the reader: the
// open group came back `hidden` on the next repaint (state.toolGroupOpen answered for a key nothing looks up now).
function toolGroupAnchor(lines) {
  const run = Array.isArray(lines) ? lines : [];
  const first = run.find((l) => l && l.kind === "tool") || run[0] || null;
  return first ? String(first.lid || first.at || first.text || "").slice(0, 40) : "";
}

// The console draws a window of the turn, not the whole of it. A raw line count cut bursts in half: the call line
// fell out of the window while the output it produced stayed, and a burst with no call line has no rows to tally -
// it stopped being a group at all (toolGroupHtml's trimmed path). So the window is cut on the burst's own boundary:
// if it would start inside a burst's results, it starts at the call line above them instead.
//
// A burst that fits in a second window is kept whole, so there is no hole between a call and what it produced. One
// that does not (a terminal call with hundreds of lines of output) keeps its call line and the ordinary window: a
// group with a call row and a gap, which is the window being a window - never a group that stops existing.
const TURN_WINDOW = 300;

function windowLines(all, keep = TURN_WINDOW) {
  const lines = Array.isArray(all) ? all : [];
  const max = Math.max(1, Number(keep) || TURN_WINDOW);
  if (lines.length <= max) return lines;
  const tail = lines.length - max;
  // A run of `tool`/`tool-out` lines is one burst (burstGroups). Walking back over the results the window opened
  // inside lands on the call that produced them; landing on anything else means the burst's own call line is already
  // out of the buffer, and the trimmed render draws what is left.
  let start = tail;
  while (start > 0 && lines[start].kind === "tool-out") start -= 1;
  // `start` equal to `tail` is a window that already begins at a burst's own call (or at a line that is not a burst's
  // at all): nothing was cut in half, so nothing has to be put back.
  if (start === tail || lines[start].kind !== "tool") return lines.slice(tail);
  return lines.length - start <= max * 2 ? lines.slice(start) : [lines[start], ...lines.slice(tail)];
}

// `anchor` is the identity the node already carries (data-gat), which wins over re-deriving it from lines that were
// read back out of the DOM and have lost their timestamp.
function toolGroupStateKey(key, lines, anchor = "") {
  return `${String(key || "").split("#")[0]}|${anchor || toolGroupAnchor(lines)}`;
}

// Is a rendered group's state worth remembering? A closed, unfiltered group is the condensed view's default and
// leaves nothing to remember - except where the group's OWN default is open (a burst the window trimmed of its call
// line is drawn open), because there the reader shutting it is a choice, and a repaint must not undo it.
function toolGroupDropsState(open, filter, openByDefault = false) {
  return !open && !filter && !openByDefault;
}

// Record the reader's choice from a rendered group, so the next rebuild can put it back.
function rememberToolGroup(grp) {
  if (!grp || !grp.dataset) return;
  const gkey = grp.dataset.gstate;
  if (!gkey) return;
  const body = grp.querySelector(".tgrp-body");
  const filter = grp.dataset.filter || "";
  const open = Boolean(body && !body.hidden);
  if (toolGroupDropsState(open, filter, grp.dataset.gdefault === "open")) {
    state.toolGroupOpen.delete(gkey);
    return;
  }
  state.toolGroupOpen.set(gkey, { open, filter });
  // A long-lived tab would otherwise accumulate one entry per burst it ever opened.
  while (state.toolGroupOpen.size > 500) state.toolGroupOpen.delete(state.toolGroupOpen.keys().next().value);
}
// ---- end tool group key

// The gateway folds a parallel batch into one line - "first command + 3 commands" - because the run stream carries a
// summary of the batch, not each call. The other calls are in the session transcript, so the tail becomes a button
// that reads them back; what it finds is remembered per burst, so a repaint keeps them on screen.
const BATCH_TAIL_RE = /^(.*?)\s*\+\s*(\d+)\s+commands?\s*$/i;

function linkBatchTail(text, tool, gkey) {
  const m = BATCH_TAIL_RE.exec(String(text || ""));
  const n = m ? Number(m[2]) || 0 : 0;
  if (!n) return esc(text);
  const title = `one summary line stands in for ${n + 1} calls run as a batch — click to list all ${n + 1} from the session transcript`;
  // The printed call text travels with the button: it is how the transcript lookup finds THIS batch rather than a
  // newer one in the same turn.
  const first = m[1].trim().slice(0, 110);
  return `${esc(m[1])} <button type="button" class="tgrp-batch" data-batch-tool="${esc(tool)}" data-batch-n="${n}" data-batch-key="${esc(gkey)}" data-batch-first="${esc(first)}" title="${esc(title)}">+ ${n} command${n === 1 ? "" : "s"}</button>`;
}

// A trimmed burst still resolves each result from its own stamped identity or its retained head. The shared
// renderer turns that result's wire note into the box header's fetch metadata and replaces its preview in place.
function trimmedBurstHtml(lines, turnId, gkey, codeOpen = state.codeBoxOpen) {
  return consoleBodyHtml(lines, {
    tool: "", arg: "", codeOpen, codeKey: String(gkey), folds: noteFolds(turnId, lines), fullForFold,
  });
}

// ---- trimmed group head: a burst that lost its call line is still a group
// A burst whose call line the window (or the buffer behind it) no longer holds has no rows to tally, but the lines it
// does hold are still one block of the reader's console. Drawn bare they had no head row, nothing to click, and
// nowhere for the open state to land: a repaint could neither keep them open nor remember them shut, and the 3s sweep
// that refreshes a block's stored output could not find them at all. The head row says what the block is - the call
// above these results is outside the window - and the node carries the same data-gstate/data-gat as any other group.
// `sep` is the stream's own blank line (`jl-sep`): a trimmed piece is a piece like any other, so it is set apart from
// the piece above it the same way.
function trimmedGroupHtml(lines, key, anchor = "", flat = false, codeOpen = state.codeBoxOpen, sep = false) {
  const gkey = toolGroupStateKey(key, lines, anchor);
  const body = trimmedBurstHtml(lines, String(key).split("#")[0], key, codeOpen);
  // A piece of a stream has no fold at all: it is open, and the reader's open state is not consulted for it.
  if (flat) {
    return (
      `<div class="tgrp tgrp-flat${sep ? " jl-sep" : ""}" data-tgrp="${esc(key)}" data-gstate="${esc(gkey)}" data-gat="${esc(anchor || toolGroupAnchor(lines))}" data-gflat="1">` +
      `<div class="tgrp-body">${body}</div></div>`
    );
  }
  // Drawn OPEN: the reader came for this output, and what the window dropped is the call, not the result. Shutting it
  // is therefore a real choice, and data-gdefault is what makes rememberToolGroup keep that choice.
  const saved = state.toolGroupOpen.get(gkey);
  const open = saved ? Boolean(saved.open) : true;
  const names = [
    ...new Set(
      lines
        .map((l) => {
          const m = l && l.kind === "tool-out" ? TOOL_DONE_RE.exec(String(l.text || "")) : null;
          return m ? m[1] : "";
        })
        .filter(Boolean),
    ),
  ];
  const label = `${lines.length} line${lines.length === 1 ? "" : "s"}`;
  const title = "the call line above these results is outside the console's window — this block is the output the card still holds";
  return `<div class="tgrp" data-copy data-tgrp="${esc(key)}" data-gstate="${esc(gkey)}" data-gat="${esc(anchor || toolGroupAnchor(lines))}" data-gdefault="open">
      <div class="tgrp-head" data-copy-text><div class="tgrp-row tgrp-row-trimmed" title="${esc(title)}"><span class="tgrp-g">\u21b3</span><span class="tgrp-name">${esc(names.join(", ") || "tool output")}</span><span class="tgrp-n">trimmed</span></div><button type="button" class="tgrp-more${open ? " is-open" : ""}" data-tgrp-more="${esc(key)}" title="${open ? "fold these result lines away" : "show every result line this card still holds"}">${label}</button></div>
      <div class="tgrp-body"${open ? "" : " hidden"}>${body}</div>
    </div>`;
}
// ---- end trimmed group head

// ---- one stream: a tool call, drawn as a row of it --------------------------------------------------------------------
// A card drawn as ONE stream (the 🌊 beside the 🧠) does not condense a run of calls into a head row with a tally; it
// draws the run as the reader asked for it — one row per call, bracketed by two rules, with what the call returned a
// click away under it. `flatRowHtml` in toolGroupHtml is where a row is built: the glyph and tool name, the target the
// call was given (the file and its range, or the command), and the time it took. Two things the condensed group's head
// row carried live on the row here: the clock of the call still in flight, and the "+ N commands" tail the gateway
// puts on a parallel batch.

// A stream piece's stored results are not asked for by the markup: an always-visible .tgrp is swept by the same 3s
// interval that keeps the condensed view's open groups current (see the setInterval beside ensureToolStore), so a
// patch with an empty preview fills itself in without the reader clicking anything.

function toolGroupHtml(lines, key, filter = "", openBody = false, anchor = "", gofs = null, opts = {}) {
  const flat = Boolean(opts && opts.flat);
  const rows = toolBurstRows(lines);
  // No recognisable call lines (a result whose start was trimmed away): show the lines rather than an empty box.
  // They still go through the one renderer, so a diff in a burst whose call lines were trimmed is a diff — and
  // every note in them is resolved on its own identity, because there is no tool name and no cursor to be had
  // here. Without that the note drew as a plain div and the reader was shown "click to read" with nothing to
  // click, which is exactly the state a reload of a long turn produces.
  // What it must not lose is BEING A GROUP: a head row that says what the block is, the data-gstate/data-gat the
  // reader's open state is remembered under, and the fold that state opens. Drawn as bare lines it dropped out of
  // the panel's own map of its groups - nothing to click, nothing to remember, nothing for the sweep to find.
  if (!rows.length) return trimmedGroupHtml(lines, key, anchor, flat, state.codeBoxOpen, Boolean(opts && opts.sep));
  // The reader's own choice wins over the caller's default: a rebuild is not the reader closing the block.
  const gkey = toolGroupStateKey(key, lines, anchor);
  const saved = flat ? null : state.toolGroupOpen.get(gkey);
  if (saved) {
    filter = saved.filter || filter;
    openBody = saved.open;
  }
  // A burst is only in flight while its TURN is live: the bare counts kept a dead turn's last burst ticking. A turn
  // the panel lost at a restart still drew "running 77m16s" an hour later, one line above the word "interrupted".
  const turnJob = state.jobs.get(String(key).split("#")[0]);
  const live = turnJob ? turnLive(turnJob) : false;
  const head = flat ? "" : rows
    .map((r) => {
      const running = r.count > r.done && live;
      const state = running
        ? `<span class="jl-live tgrp-state" data-live-from="${r.at || Date.now()}">${liveSuffix(r.at || Date.now())}</span>`
        : r.duration != null
          ? `<span class="tgrp-state">${r.duration.toFixed(2)}s</span>`
          : "";
      const last = r.last ? `<span class="tgrp-last mono" title="${esc(r.last)}">${linkBatchTail(r.last, r.name, gkey)}</span>` : "";
      const active = filter === r.name ? " is-active" : "";
      return `<div class="tgrp-row${active}" role="button" tabindex="0" data-tgrp-tool="${esc(r.name)}" title="show the ${r.count} call${r.count === 1 ? "" : "s"} this run made to ${esc(r.name)}${r.count === 1 ? "" : ", with their output"}"><span class="tgrp-g">${esc(r.glyph)}</span><span class="tgrp-name">${esc(r.name)}</span><span class="tgrp-n">×${r.count}</span>${last}${state}</div>`;
    })
    .join("");
  const segments = burstSegments(lines).filter((s) => !filter || s.tool === filter);
  const turnId = String(key).split("#")[0];
  const bodyLines = segments.flatMap((s) => s.lines);
  // Each result block takes the next stored row for ITS tool: the console's result lines and the store's rows are
  // both in the order the calls ran, so position pairs them. The segment index did not - a burst interleaves a call
  // with the result it produced, which drew call #2's output under call #1's result line.
  const LF = String.fromCharCode(10);
  const STORE_LINES = 40;
  // Where this group starts in the store's rows for each tool (carried as data-gofs): a turn can hold several
  // bursts, and every one of them pairs from ITS first result - a fresh 0 in each group drew burst 1's output
  // under burst 2's header.
  const cursorsStart = new Map(Object.entries(gofs || {}));
  const cursors = new Map(cursorsStart);
  const takeStored = (tool) => {
    const i = cursors.get(tool) || 0;
    cursors.set(tool, i + 1);
    const rowsOut = state.toolStore.get(`${turnId}|${tool}`)?.results || null;
    return rowsOut?.[i] || null;
  };
  // The index takeStored is ABOUT to take: a result's fold names which of the turn's rows it is, and the pairing
  // above is where that number comes from (the click then reads exactly that row back out of the store).
  const storedRowAt = (tool) => cursors.get(tool) || 0;
  // Result boxes: folded until the reader opens one, in the condensed view and in a stream alike; the ones they
  // opened are remembered by key.
  const codeOpenSet = state.codeBoxOpen;
  const storedHtml = (got, tool = "", arg = "", boxKey = "", at = null) => {
    const all = String(got.text || "").split(LF);
    const displayCut = Boolean(got.truncated && /^… [0-9]+ characters not shown$/.test(all.at(-1) || ""));
    if (displayCut) all.pop();
    const cut = got.truncated && !displayCut;
    if (!all.some((l) => l.trim())) return cut ? '<div class="jl jl-dim jl-note">  this result was cut before its text</div>' : "";
    const shown = all.slice(0, STORE_LINES).map((text) => ({ kind: "store", text }));
    const more = all.length - shown.length;
    const needsFull = more > 0 || displayCut;
    const fold = needsFull && at != null ? { turn: turnId, tool, row: at } : null;
    // A character-capped store read cannot know the total line count. Say preview, then read the uncapped row.
    if (needsFull) shown.push({ kind: "tool-out", text: foldNoteText(displayCut ? { shortened: 1 } : { hidden: more }) });
    return consoleBodyHtml(shown, { tool, arg, codeOpen: codeOpenSet, codeKey: boxKey, fold, fullForFold, source: [] }) +
      (cut ? `<div class="jl jl-dim jl-note">… this result was cut</div>` : "");
  };
  // What the call behind a result was given: the burst's own call line carries it ("📖 read_file · docs/map.md"),
  // and that argument is what a code box's header names the file from. Read from the lines the group was built
  // with, so a rebuild from the DOM reads the same call line.
  const callArgFor = (seg) => {
    const at = lines.indexOf(seg.lines[0]);
    for (let k = (at < 0 ? lines.length : at) - 1; k >= 0; k--) {
      const l = lines[k];
      if (l.kind !== "tool") continue;
      const m = TOOL_START_RE.exec(String(l.text || ""));
      if (m && m[1] === seg.tool) return toolCallArg(l.text);
    }
    return "";
  };
  // A block that starts with a result header is a call's output; anything else is a call itself.
  const resultHead = (seg) => (seg.lines[0] && seg.lines[0].kind === "tool-out" ? TOOL_DONE_RE.exec(String(seg.lines[0].text || "")) : null);
  const liveTurn = turnLive(state.jobs.get(turnId));
  // The stored row that belongs to THIS call. The store holds every result the turn returned for that tool and the
  // console's own lines can cover only part of the turn (a restored card keeps its last lines), so a position is
  // not an identity: the call line carries the file the tool was given, and a stored diff names the same file in
  // its own "--- a/…" header. That file is what pairs them.
  const pathKey = (p) => normPath(String(p || "")).replace(/^[ab]\//, "").toLowerCase();
  const storedForFile = (tool, arg) => {
    const want = pathKey(arg);
    if (!want) return null;
    const rowsOut = state.toolStore.get(`${turnId}|${tool}`)?.results || [];
    for (let i = 0; i < rowsOut.length; i++) {
      for (const l of String(rowsOut[i].text || "").split(LF).slice(0, 3)) {
        if (pathKey(l.replace(/^[-+]{3}\s+/, "")) === want) return { row: rowsOut[i], at: i };
      }
    }
    return null;
  };
  // A call's own row is the handle for its output: the fold covers the lines under that row and nothing else, and
  // the row's own text is still a console line inside it, so a rebuild reads the call back exactly as before.
  const callBlockHtml = (callLine, callBody, key) => {
    const folded = state.callFolded.has(key);
    const n = (callBody.match(/data-ltext=/g) || []).length;
    const label = `${n} line${n === 1 ? "" : "s"}`;
    const what = folded ? "show" : "fold";
    return (
      `<div class="call${folded ? " is-folded" : ""}" data-call-key="${esc(key)}">` +
      `<div class="call-head" title="${what} this call's output">` +
      `<button type="button" class="call-fold" data-call-fold="1" data-call-key="${esc(key)}" aria-expanded="${folded ? "false" : "true"}"` +
      ` aria-label="${what} this call's output (${label})">${folded ? "▸" : "▾"}</button>` +
      consoleBodyHtml([callLine], { tool: "", arg: "", codeOpen: null, codeKey: "" }) +
      `<span class="call-n">${label}</span>` +
      `<span class="call-hint"${folded ? "" : " hidden"}>folded — click to read</span></div>` +
      `<div class="call-body" data-copy-through${folded ? " hidden" : ""}>${callBody}</div>` +
      `</div>`
    );
  };
  // `dropHead` is for the stream's tool-usage rows: the row above the box says the tool and the time the result
  // header would repeat, so the box starts at what the call returned.
  const bodyOf = (seg, si, { dropHead = false } = {}) => {
    const arg = callArgFor(seg);
    // One key per segment, so the reader's fold survives a rebuild of the burst and a burst holding two files
    // keeps two independent boxes.
    const boxKey = `${gkey}|${si}`;
    // The result line ("  ↳ patch · 79.51s") is the console's own record of the result and stays whatever else
    // is drawn under it — unless the caller is drawing a stream row, which carries that record itself.
    const resultLine = resultHead(seg) ? seg.lines.slice(0, 1) : [];
    const headHtml = () => (dropHead ? "" : render(resultLine));
    const preview = resultHead(seg) ? seg.lines.slice(1) : seg.lines;
    const render = (list, extra = {}) =>
      consoleBodyHtml(list, { tool: seg.tool, arg, codeOpen: codeOpenSet, codeKey: boxKey, fullForFold, ...extra });
    // Where this result's store row is: the pairing below takes rows in order, so the cursor's value BEFORE it
    // advances is this result's own row — the number a fold's click fetches by.
    const rowAt = resultHead(seg) ? storedRowAt(seg.tool) : 0;
    // The cursor advances for EVERY result line, preview or not. A tool whose live previews are populated used to
    // return before consuming its row, so its rows piled up and were re-printed as "more stored result" at the end
    // while the next result line paired with the wrong row.
    const got = resultHead(seg) ? takeStored(seg.tool) : null;
    let out = headHtml() + render(preview);
    if (resultHead(seg)) {
      // The gateway's live stream carries a PREVIEW of a result. When it was cut, these lines are not the whole
      // answer, and the session store is where the rest of it is - it is where a patch's diff comes from in the
      // first place. So the stored row for this call's own file is drawn in place of the cut preview, and the cut
      // row the renderer put at the preview's edge stays as the honest answer only when the store has nothing.
      const full = preview.some((l) => consoleCutNote(String(l.text || ""))) ? storedForFile(seg.tool, arg) : null;
      // The panel's own fold, one cap down from the gateway's: the whole result arrived and the card kept its
      // head. The note is drawn as the button that opens it — unless the reader already opened THIS result, in
      // which case the whole stored text is drawn in its place (that is what the click set up, and a rebuild
      // must not fold it back shut).
      const foldAt = preview.findIndex((l) => consoleFoldNote(String(l.text || "")));
      // The note names its own result — from the head the panel kept above it (checked against the store's own
      // rows once the burst has read them) or from the row the server stamped on the line — and only falls back
      // to this burst's cursor when it has neither.
      const fold = foldAt < 0 ? null : foldForNote({ turnId, tool: seg.tool, note: preview[foldAt], head: preview.slice(0, foldAt), cursor: rowAt });
      if (full) out = headHtml() + storedHtml(full.row, seg.tool, arg, boxKey, full.at);
      else if (foldAt >= 0) {
        out = headHtml() + render(preview, fold ? { fold } : {});
      } else if (!preview.some((l) => String(l.text || "").trim())) {
        out += got
          ? storedHtml(got, seg.tool, arg, boxKey, rowAt)
          : `<div class="jl jl-dim jl-note">  ${state.toolStore.has(`${turnId}|${seg.tool}`) ? (liveTurn ? "no output in the session store yet" : "no output recorded for this call") : "stored, one click away"}</div>`;
      }
    }
    return out;
  };
  // A call and the result it produced are TWO segments: the panel draws the call when the tool starts and the
  // result when it finishes, and a parallel batch interleaves them. The reader's handle is the call's own row, so
  // a call segment followed by its own tool's result segment is rendered as one foldable block - the call line on
  // top, that call's output under it, and nothing else on the card moving when it folds. A call whose result has
  // not arrived yet has nothing to fold and is drawn as the plain line it always was.
  const bodyParts = [];
  // One stream: the call still in flight carries its clock on its own row (the condensed view keeps it there too),
  // and a call IS its row — there is no separate "↳ tool" line and no output in the flow until the reader asks.
  const busyAt = flat && live ? inflightToolIndex(lines) : -1;
  const busyLine = busyAt >= 0 ? lines[busyAt] : null;
  // ---- the reader's tool-usage group: ONE row per call ------------------------------------------------------------
  // A run of calls drawn the way the reader asked for it: one rule above the rows and one below them, and inside it
  // ONE row per call — the tool, the target it was given (the file and its range, or the command) and how long it
  // took. There is no "↳ tool" line of its own: the row IS that record, and the time the result line carried is
  // drawn on the row that produced it. What the call returned is one click under its row, in the same box the
  // condensed view opens (a result's head, the stored text behind a fold note, the honest note when there is
  // nothing). A row starts shut — that is what keeps a burst of five calls five lines instead of a wall of output —
  // and the rules are the group's own edges: the blank line the stream puts above a piece (`jl-sep`, from
  // wtStream.pieces) still sits outside them, so nothing new decides where a group begins or ends.
  //
  // Rows pair by TOOL, in order, not by adjacency: a parallel batch interleaves its calls (call, call, result,
  // result), so the k-th call of a tool is answered by that tool's k-th result. A result whose call the console no
  // longer holds keeps a row of its own — one shape for the group — with no target to name.
  const flatRows = [];
  if (flat) {
    const waiting = new Map();
    for (const seg of segments) {
      const first = seg.lines[0] || {};
      if (seg.lines[0] && resultHead(seg)) {
        const queue = waiting.get(seg.tool) || [];
        const row = queue.shift();
        if (row) row.result = seg;
        else flatRows.push({ call: null, result: seg, extra: [] });
        continue;
      }
      if (first.kind === "tool") {
        const row = { call: seg, result: null, extra: [] };
        flatRows.push(row);
        const queue = waiting.get(seg.tool) || [];
        queue.push(row);
        waiting.set(seg.tool, queue);
        continue;
      }
      // A line of a burst whose call line is outside the window: it is output, so it belongs in the box of the row
      // above it. With no row above it there is nothing to open, and it is drawn as the lines it is.
      const prev = flatRows[flatRows.length - 1];
      if (prev) prev.extra.push(...seg.lines);
      else flatRows.push({ call: null, result: null, extra: [...seg.lines] });
    }
  }
  const flatRowHtml = (row, si) => {
    const call = row.call;
    const line = call ? call.lines[0] : null;
    const text = line ? String(line.text || "") : "";
    const m = line ? TOOL_START_RE.exec(text) : null;
    const res = row.result ? row.result.lines[0] : null;
    const resText = res ? String(res.text || "") : "";
    const done = res ? TOOL_DONE_RE.exec(resText) : null;
    const tool = (call && call.tool) || (row.result && row.result.tool) || (m ? m[1] : "") || "";
    const g = line ? /^(\p{Extended_Pictographic}[\uFE0F\u200D]*)\s*/u.exec(text) : null;
    const glyph = (g && g[1]) || (call ? "⚡" : "\u21b3");
    const arg = call ? toolCallArg(text) : "";
    // The gateway's own duration lives on the result header; a stream that carries none still knows when the call
    // started and when its result came back, which is the same measurement taken from the panel's side.
    const said = done ? /·\s*([\d.]+)s/.exec(resText) : null;
    const from = line ? Number(line.at) || 0 : 0;
    const to = res ? Number(res.at) || 0 : 0;
    const secs = said ? Number(said[1]) : from && to && to >= from ? (to - from) / 1000 : null;
    const failed = done ? /·\s*error\b/.test(resText) : false;
    const running = !row.result && live && line && line === busyLine;
    const stateHtml = failed
      ? `<span class="tgrp-state">error</span>`
      : secs != null
        ? `<span class="tgrp-state">${secs.toFixed(2)}s</span>`
        : running
          ? `<span class="jl-live tgrp-state" data-live-from="${from || Date.now()}">${liveSuffix(from || Date.now())}</span>`
          : "";
    const key = `${gkey}|c${si}`;
    const open = state.callOpen.has(key);
    const target = arg ? `<span class="tgrp-last mono" title="${esc(arg)}">${linkBatchTail(arg, tool, gkey)}</span>` : `<span class="tgrp-last"></span>`;
    const loose = [...(call ? call.lines.slice(1) : []), ...row.extra];
    const box =
      (loose.length ? consoleBodyHtml(loose, { tool, arg, codeOpen: codeOpenSet, codeKey: `${gkey}|c${si}` }) : "") +
      (row.result ? bodyOf(row.result, si, { dropHead: true }) : "");
    // Both halves of the record travel on the row: the call's own line (data-ltext — the reader's console line) and
    // the result header the panel drew under it until now (data-lresult). groupLines reads them back as the two
    // lines they are, so a rebuild keeps the pairing, the time, and the starting row the NEXT burst pairs from.
    const label = `${open ? "hide" : "show"} what ${tool || "this call"} returned${secs != null ? ` (${secs.toFixed(2)}s)` : ""}`;
    return (
      `<div class="tgrp-call${open ? " is-open" : ""}" data-call-key="${esc(key)}">` +
      `<div class="jl jl-tool tgrp-row" role="button" tabindex="0" data-tgrp-call="${esc(key)}" data-call-tool="${esc(tool)}"` +
      ` aria-expanded="${open ? "true" : "false"}" title="${esc(label)}"` +
      (call ? ` data-lid="${esc(line.lid ?? "")}" data-ltext="${esc(text)}" data-lkind="tool"` : ` data-lkind="tool-out"`) +
      (res ? ` data-lresult="${esc(resText)}" data-lrat="${esc(Number(res.at) || "")}" data-lrld="${esc(res.lid ?? "")}"` : "") +
      `><span class="tgrp-g">${esc(glyph)}</span><span class="tgrp-name">${esc(tool)}</span>${target}${stateHtml}</div>` +
      `<div class="tgrp-out"${open ? "" : " hidden"}>${box}</div>` +
      `</div>`
    );
  };
  if (flat) {
    for (let si = 0; si < flatRows.length; si++) {
      const row = flatRows[si];
      // Loose lines with no call and no result are output with nothing to fold: drawn where they are, as they were.
      if (!row.call && !row.result) {
        bodyParts.push(consoleBodyHtml(row.extra, { tool: "", arg: "", codeOpen: codeOpenSet, codeKey: `${gkey}|c${si}` }));
        continue;
      }
      bodyParts.push(flatRowHtml(row, si));
    }
  } else {
    for (let si = 0; si < segments.length; si++) {
      const seg = segments[si];
      const next = segments[si + 1];
      if (seg.lines[0] && seg.lines[0].kind === "tool" && next && resultHead(next) && next.tool === seg.tool) {
        bodyParts.push(callBlockHtml(seg.lines[0], bodyOf(next, si + 1), `${gkey}|${si}`));
        si++;
        continue;
      }
      bodyParts.push(bodyOf(seg, si));
    }
  }
  // No leftover list: the store's rows are paired per burst, so a group cannot know which rows belong to a burst
  // further down the turn — printing the rest of the array re-printed the NEXT burst's output under this one's last
  // result line (measured on a two-burst turn). A result line the console lost stays unshown; the call line is
  // still there, and the store is one click away on that tool's row.
  // A batch the reader has opened: the calls behind its "+ N commands", oldest first.
  const batchBlocks = rows
    .map((r) => {
      const calls = state.batchCalls.get(`${gkey}|${r.name}`);
      if (!calls || !calls.length) return "";
      // jl-panel: this block is drawn BY the panel, so groupLines must not read it back as console lines (it did,
      // and the absorbed summaries then satisfied "the preview carried this result", hiding the stored output).
      return (
        `<div class="jl jl-dim jl-panel">↳ the ${calls.length} call${calls.length === 1 ? "" : "s"} in this batch (${esc(r.name)})</div>` +
        calls.map((c) => `<div class="jl jl-tool-out jl-panel">${esc(c.summary)}</div>`).join("")
      );
    })
    .join("");
  const body =
    (bodyLines.length > 0
      ? bodyParts.join("")
      : `<div class="jl jl-dim">this run recorded nothing for ${esc(filter)}</div>`) + batchBlocks;
  const label = filter ? `all ${lines.length}` : `${lines.length} line${lines.length === 1 ? "" : "s"}`;
  if (flat) {
    // One piece of a stream: no head row and no "N lines" button, and no template whitespace either (the console is a
    // <pre>). `data-gflat` is what keeps it flat: the 3s sweep that keeps an open group's stored results current
    // aims at this node by its state key, and a rebuild must not put the folded group back under the reader.
    // `tgrp-calls` is the row list inside the group's two rules — the rows, and nothing else, at rest.
    return (
      `<div class="tgrp tgrp-flat${opts.sep ? " jl-sep" : ""}" data-tgrp="${esc(key)}" data-gstate="${esc(gkey)}" data-gat="${esc(anchor || toolGroupAnchor(lines))}"` +
      ` data-gofs="${esc(JSON.stringify(Object.fromEntries(cursorsStart)))}" data-gflat="1">` +
      `<div class="tgrp-body tgrp-calls">${body}</div></div>`
    );
  }
  return `<div class="tgrp" data-copy data-tgrp="${esc(key)}" data-gstate="${esc(gkey)}" data-gat="${esc(anchor || toolGroupAnchor(lines))}" data-gofs="${esc(JSON.stringify(Object.fromEntries(cursorsStart)))}"${filter ? ` data-filter="${esc(filter)}"` : ""}>
      <div class="tgrp-head" data-copy-text>${head}<button type="button" class="tgrp-more${filter ? " is-open" : ""}" data-tgrp-more="${esc(key)}" title="${filter ? "show every tool in this run, not just this one" : "show every call in this run of tools, with its output"}">${label}</button></div>
      <div class="tgrp-body"${openBody || filter ? "" : " hidden"}>${body}</div>
    </div>`;
}

// The chip that jumps a console back to its newest line. It sits beside the scrolled element inside a
// positioned wrapper, so it stays in the corner of the console instead of travelling with the text; it is shown
// only while the reader is scrolled away from the end. It is also a `tail-chip`: the same 21px circle as the
// chart's held-back arrow (`.wt-age-toggle` in public/style.css), so the shape comes from that shared rule and
// this one keeps only the placement.
function toBottomBtnHtml() {
  return `<button type="button" class="tail-chip to-bottom" data-to-bottom="1" title="jump to the newest line and follow it again">\u2193</button>`;
}

// The console's own two views, in a strip at its top-right: RAW restores the turn's text exactly as it arrived,
// FOCUS drops the tool rows and leaves what the agent said. The state is per TURN (page state), because a card
// repaint rewrites this markup on every run event and on every scan — a class on the old node would be gone.
function consoleToolsHtml() {
  return (
    `<div class="out-tools" role="group" aria-label="console views">` +
    `<button type="button" class="out-tool" data-md-raw="1" aria-pressed="false" title="show this turn's text exactly as it arrived, markdown and all">raw</button>` +
    `<button type="button" class="out-tool" data-md-focus="1" aria-pressed="false" title="hide the tool rows: read the prose, the errors and the final message">focus</button>` +
    `</div>`
  );
}

function paintToBottom(box) {
  const wrap = box?.closest?.(".out-wrap");
  if (!wrap) return;
  const overflowing = box.scrollHeight > box.clientHeight + 4;
  // The chip is the reader's way back, so it appears exactly when the console is NOT following: the same 2 px the
  // pin uses. A 24 px band hid it for a reader parked a few px up, who was then neither following nor offered the ↓.
  const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight <= 2;
  wrap.classList.toggle("is-at-end", !overflowing || atEnd);
}

// ---- the docked console ---------------------------------------------------------------------------------
// A child's console, drawn in the card's transcript idiom. The panel cannot stream a child (its tools run on its
// own session), so this is a read of its messages - a poll while it is open and the child is still out.
//
// THE MESSAGE ARRIVES AS ONE LINE. lib/subagents.js hands over the stored assistant message as it was written, with
// its newlines still inside that string, and markdown is a property of a RUN of lines. Made into real console lines
// here, a heading, a bullet list and a fence in a child's answer become those shapes; left as one line, they are a
// paragraph with the source punctuation printed in it, which is what the docked console used to do.

// A message's own newlines, as console lines. A tool line keeps its shape: its leading spaces are the output's
// indentation, not a block marker.
function subConsoleLines(lines) {
  const out = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    const kind = (line && line.kind) || "raw";
    const text = line && line.text != null ? String(line.text) : "";
    if (!consoleMdIsProse(kind) || !text.includes("\n")) {
      out.push(line);
      continue;
    }
    // lib/subagents.js has already stripped carriage returns from the stored message, so the newline alone is the
    // line break here.
    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i += 1) {
      out.push({ ...(line || {}), text: parts[i], lid: line && line.lid != null ? `${line.lid}.${i}` : (line && line.lid) });
    }
  }
  return out;
}

// The console's parts in draw order: a run of prose is ONE block (a list, a heading, a fence, or a paragraph of
// several lines), a run of tool lines is one burst, and a panel note is its own plain row. The burst tally is the
// card console's own (burstGroups), so the two consoles condense a run of tools the same way.
function subConsoleParts(lines) {
  const parts = [];
  let prose = null;
  const flush = () => {
    if (prose) parts.push({ prose });
    prose = null;
  };
  for (const item of burstGroups(lines)) {
    if (item.group) {
      flush();
      parts.push({ tools: item.lines });
      continue;
    }
    if (consoleMdIsProse(item.line.kind)) {
      if (!prose) prose = [];
      prose.push(item.line);
      continue;
    }
    flush();
    parts.push({ line: item.line });
  }
  flush();
  return parts;
}

function subConsoleBodyHtml(lines, id) {
  return subConsoleParts(subConsoleLines(lines))
    .map((part, gi) => {
      if (part.prose) return consoleMdHtml(part.prose);
      if (part.tools) return toolGroupHtml(part.tools, `${id}#${gi}`, "", false, "", null, toolGroupsOn() ? {} : { flat: true });
      return lineHtml(part.line);
    })
    .join("");
}

// ---- the console's colour and margin ------------------------------------------------------------------
// Two view preferences, saved in this browser the way the card's tool groups are (wtgui.*). The colour is the NAME
// of a design token, never a hex: the palette lives in style.css, and Settings > Panel contrast rewrites those
// tokens, so a hex here would be the one surface that ignored the reader's contrast setting.
const SUB_CONSOLE_FG_KEY = "wtgui.subConsoleFg";
const SUB_CONSOLE_MARGIN_KEY = "wtgui.subConsoleMargin";
const SUB_CONSOLE_FG = ["text", "dim", "green", "amber", "blue", "violet"];
// The margin steps are the box's own left indent: 36 px is where the console has always sat under the sub-row, 18
// tucks it in, 0 lines it up with the row's own text, and 54 gives a long message room to breathe.
const SUB_CONSOLE_MARGIN = [36, 18, 0, 54];

function subConsoleFg() {
  try {
    const v = localStorage.getItem(SUB_CONSOLE_FG_KEY);
    return SUB_CONSOLE_FG.includes(v) ? v : "text";
  } catch {
    return "text"; // private mode: the console keeps the colour it always had
  }
}
function subConsoleMargin() {
  try {
    const n = Number(localStorage.getItem(SUB_CONSOLE_MARGIN_KEY));
    return SUB_CONSOLE_MARGIN.includes(n) ? n : 36;
  } catch {
    return 36;
  }
}
function setSubConsoleFg(name) {
  try {
    localStorage.setItem(SUB_CONSOLE_FG_KEY, name);
  } catch {
    /* the choice just will not persist */
  }
}
function setSubConsoleMargin(px) {
  try {
    localStorage.setItem(SUB_CONSOLE_MARGIN_KEY, String(px));
  } catch {
    /* same */
  }
}

function subConsoleToolsHtml() {
  const fg = subConsoleFg();
  const margin = subConsoleMargin();
  return (
    `<div class="sub-console-tools" role="group" aria-label="console appearance">` +
    `<button type="button" class="sub-tool" data-sub-console-color="1" aria-label="console text colour: ${esc(fg)}" title="change the console's text colour (${esc(fg)})">` +
    `<span class="sub-swatch" aria-hidden="true"></span>colour</button>` +
    `<button type="button" class="sub-tool" data-sub-console-margin="1" aria-label="console left margin: ${margin} pixels" title="change the console's left margin (${margin}px)">margin ${margin}</button>` +
    `</div>`
  );
}

// One frame for every state of the box. The two controls ride above the scroller, so they stay put while the reader
// reads; the colour is one custom property drawn from the palette (`--sub-console-fg: var(--violet)`), never a hex;
// and the wrapper carries the margin, so the control moves the whole box off the sub-row's indent.
function subConsoleFrame(id, body) {
  const fg = subConsoleFg();
  const margin = subConsoleMargin();
  return (
    `<div class="sub-console-wrap" style="margin-left:${margin}px; --sub-console-fg: var(--${esc(fg)})">` +
    subConsoleToolsHtml() +
    `<div class="sub-console mono" data-sub-console-box="${esc(id)}">${body}</div>` +
    `</div>`
  );
}

function subConsoleHtml(id) {
  const c = state.subConsoles.get(id);
  if (!c || c.loading) return subConsoleFrame(id, `<div class="jl jl-dim">reading this subagent…</div>`);
  if (!c.lines.length) return subConsoleFrame(id, `<div class="jl jl-dim">nothing on its console yet</div>`);
  return subConsoleFrame(id, subConsoleBodyHtml(c.lines, id));
}

// A press cycles the closed list, writes it to this browser and repaints the ONE box it was pressed in. The strip's
// own signature does not carry these two, so paintSubagents would leave the box alone and the control would look
// dead until the next roster poll.
function cycleSubConsoleFg() {
  const i = SUB_CONSOLE_FG.indexOf(subConsoleFg());
  setSubConsoleFg(SUB_CONSOLE_FG[(i + 1) % SUB_CONSOLE_FG.length]);
}
function cycleSubConsoleMargin() {
  const i = SUB_CONSOLE_MARGIN.indexOf(subConsoleMargin());
  setSubConsoleMargin(SUB_CONSOLE_MARGIN[(i + 1) % SUB_CONSOLE_MARGIN.length]);
}
function applySubConsoleLook(wrap) {
  if (!wrap || !wrap.style) return;
  const fg = subConsoleFg();
  const margin = subConsoleMargin();
  wrap.style.marginLeft = `${margin}px`;
  if (wrap.style.setProperty) wrap.style.setProperty("--sub-console-fg", `var(--${fg})`);
  const color = wrap.querySelector("[data-sub-console-color]");
  if (color) {
    color.setAttribute("aria-label", `console text colour: ${fg}`);
    color.title = `change the console's text colour (${fg})`;
  }
  const marginBtn = wrap.querySelector("[data-sub-console-margin]");
  if (marginBtn) {
    marginBtn.setAttribute("aria-label", `console left margin: ${margin} pixels`);
    marginBtn.title = `change the console's left margin (${margin}px)`;
    marginBtn.textContent = `margin ${margin}`;
  }
}
// ---- end the docked console

// The two controls, registered here because this is the console's own surface (app.js's delegation owns the cards).
// Capture phase, so the press never reaches the sub-row that opened the console.
if (typeof document !== "undefined" && document.addEventListener) {
  document.addEventListener(
    "click",
    (e) => {
      const color = e.target && e.target.closest && e.target.closest("[data-sub-console-color]");
      const margin = e.target && e.target.closest && e.target.closest("[data-sub-console-margin]");
      if (!color && !margin) return;
      e.preventDefault();
      e.stopPropagation();
      const wrap = (color || margin).closest(".sub-console-wrap");
      if (color) cycleSubConsoleFg();
      else cycleSubConsoleMargin();
      applySubConsoleLook(wrap);
    },
    true,
  );
}

function bumpSubRead(id) {
  state.subConsoleReads.set(id, (state.subConsoleReads.get(id) || 0) + 1);
}

async function loadSubConsole(id) {
  let entry = { lines: [], running: true, loading: false };
  try {
    const r = await apiFetch(`/api/subagents/console?session=${encodeURIComponent(id)}`);
    if (r.ok) {
      const d = await r.json();
      entry = { lines: Array.isArray(d.lines) ? d.lines : [], running: Boolean(d.running), loading: false };
    } else {
      entry.lines = [{ kind: "dim", text: "could not read this subagent's session" }];
    }
  } catch {
    entry.lines = [{ kind: "dim", text: "could not read this subagent's session" }];
  }
  state.subConsoles.set(id, entry);
  bumpSubRead(id);
  paintSubagents();
}

function toggleSubs(key) {
  if (!key) return;
  if (state.collapsedSubs.has(key)) state.collapsedSubs.delete(key);
  else state.collapsedSubs.add(key);
  paintSubagents();
}

async function toggleSubConsole(id) {
  if (!id) return;
  if (state.openSubConsole.has(id)) {
    state.openSubConsole.delete(id);
    state.subConsoles.delete(id);
  } else {
    state.openSubConsole.add(id);
    state.subConsoles.set(id, { lines: [], running: true, loading: true });
    bumpSubRead(id);
    paintSubagents();
    await loadSubConsole(id);
    return;
  }
  paintSubagents();
}

// ---- reasoning first: a tool's lines wait for the thought in front of them -----------------------------------
// A reply's reasoning is typed at the reader's words-a-second, and the tool call that reply made (and its output) are
// whole lines on the wire, so left alone they land while the thought above them is still being written — the answer
// before the question. This holds those frames (core/type-stream.js createReasoningHold: in order, a whole job's
// queue at once) until two things are true: the store has been read again since the call arrived — the reasoning is
// written to the store a moment AFTER its tool call is on the stream, and only a read finds it — and the pacer has
// written every word of the thoughts that belong in front of the call. "In front of" is every thought newer than
// the last tool result already in the console: a reader who opens a card mid-turn gets the whole backlog typing in
// parallel, and none of that is a reason to hold a call it does not precede.
//
// Only while there is something to wait for AND a reader watching it: the words/s setting is on (0 keeps the console
// exactly as the run sent it), the turn is live, the tab is visible, and the reasoning is on screen — the 🌊 stream
// always draws it, the 🧠 block only while it is open (typing into a folded block is a wait for nothing).
const REASONING_READ_WAIT_MS = 2000; // a store read that has not answered by now is not worth holding a console for
const REASONING_READ_COOLDOWN_MS = 250; // one read serves a whole burst of calls

function reasoningShown(turn) {
  const thread = turn.thread || turn.id;
  if (!thinkingOn(thread)) return false;
  if (streamOn(thread) && globalThis.wtStream) return true;
  return thinkOpenFor(turn, turnKey(turn, ""));
}

function reasoningWants(evt) {
  const kind = evt?.line?.kind;
  if (kind !== "tool" && kind !== "tool-out") return false;
  if (!state.typePacer || !state.typePacer.rate()) return false;
  const turn = state.jobs.get(String(evt.id));
  return Boolean(turn) && turnLive(turn) && reasoningShown(turn);
}

// The moment of the last tool result already in the console: the thoughts newer than it are the ones a call is about
// to follow. 0 (a turn with no result yet) counts every thought of the turn.
function reasoningFloor(job) {
  const lines = jobLines(String(job));
  for (let k = lines.length - 1; k >= 0; k--) if (lines[k]?.kind === "tool-out") return Number(lines[k].at) || 0;
  return 0;
}

// A call, or the header of a result, is the cue to look at the store again. A read already in flight may have been
// answered before the store held this reply, so a cue waits for it and asks once more (loadThinkingAfter).
function reasoningStart(job, evt) {
  const line = evt?.line || {};
  const cue = line.kind === "tool" || (line.kind === "tool-out" && TOOL_DONE_RE.test(String(line.text || "")));
  if (!cue) return;
  const prev = state.reasoningReads.get(job);
  if (prev && Date.now() - prev.at < REASONING_READ_COOLDOWN_MS) return;
  const turn = state.jobs.get(job);
  if (!turn) return;
  const rec = { at: Date.now(), done: false };
  state.reasoningReads.set(job, rec);
  loadThinkingAfter(turn)
    .catch(() => {})
    .finally(() => {
      rec.done = true;
    });
}

function reasoningBusy(job) {
  const rec = state.reasoningReads.get(job);
  if (rec && !rec.done && Date.now() - rec.at < REASONING_READ_WAIT_MS) return true;
  const floor = reasoningFloor(job);
  return Boolean(
    state.typePacer?.pendingFor(job, (lid) => lid.startsWith("think:") && (Number(lid.slice(6)) || 0) > floor),
  );
}

// Reasoning types out on the same pacer, at the same words/s the prose uses — it is the same reading. A block is
// fed the first time the panel sees it while its turn is live AND it is the newest thought that turn has, and every
// re-read of the store feeds it again so a block that grew keeps flowing. Returns the prefix to draw, or null when
// this block is drawn whole (history, a hidden tab, rate 0, or the turn has settled and the flush already released it).
//
// WHY ONLY THE NEWEST. Every path that draws a card hands this function the turn's WHOLE block list in one pass, and
// the toggle is one of them: pressing 🧠 on a running turn paints the blocks for the first time, so with no gate the
// pacer's first frame for each was the block's entire text, queued to be typed - the turn's reasoning replayed from
// its first word over output the reader was already looking at (a live window holds tens of blocks and >100 kB of
// reasoning on this box). The newest thought is the live edge, the one still being written, so it keeps its clock;
// everything above it is history and paints whole.
//
// THE TWO BRANCHES MUST NOT DISAGREE. A block that has been fed always draws the PACER'S prefix — never its whole
// text — because the two are not the same string: a live turn's reasoning runs to 100 kB and more per turn (measured:
// 58 blocks / 183 kB on this box), so the prefix the clock has reached is a small fraction of the wire's text. Drawing
// the whole text in one branch and the prefix in the other makes the block COLLAPSE back to a few words and type them
// out again the moment the branches swap — a settled turn that is revived, a tab that comes back into view. And the
// moment there is no flow to show (a settled turn, a hidden tab) the rest is released at once, so the block ends on
// the wire's whole text instead of on a prefix nobody is left to write.
function thinkIsNewest(turn, block) {
  const blocks = state.thinkCache.get(turn.id)?.blocks || [];
  if (!blocks.length) return true; // nothing to compare against: this block is all the turn has been read as
  let newest = 0;
  for (const b of blocks) {
    const at = Number(b.at) || 0;
    if (at > newest) newest = at;
  }
  return (Number(block.at) || 0) === newest;
}

function paceThinkBlock(turn, block) {
  const P = state.typePacer;
  if (!P || !block) return null;
  const lid = `think:${block.at}`;
  const flowing = !document.hidden && turnLive(turn);
  // A block the pacer has never held: history draws it whole, and on a live turn only the newest thought is written
  // (see above). A block the pacer DOES hold is not history any more, whatever the status or the store says now.
  if (!state.thinkFed.has(lid) && (!flowing || !thinkIsNewest(turn, block))) return null;
  state.thinkFed.add(lid);
  const shown = P.feed(lid, String(turn.id), String(block.text ?? ""));
  if (!flowing) return P.flush(lid) ?? shown;
  return shown;
}

// A SKILL'S RESULT is written like prose and reasoning are. Its lines are fed to the pacer as they join a console,
// and every row a console draws asks `typedShown` (core/console-format.js's hook) how much of itself it may show, so
// the lines of a skill type out at the reader's words-a-second inside the result's box — and walk in at their
// lines-a-second, because the gate in front of this already holds every line. Which results those are is
// wtType.isPacedTool; every other tool's result is drawn whole, exactly as before.
//
// A result's lines arrive together, behind the "↳ tool" header that names it, so the tool a body line belongs to is
// the nearest header above it in its burst. The header itself, the panel's fold note and the gateway's own notes
// are not words of the result and are never typed.
function resultToolOf(lines, line) {
  for (let k = lines.length - 1; k >= 0; k--) {
    const l = lines[k];
    if (!l || l === line) continue;
    if (l.kind === "tool") return "";
    if (l.kind !== "tool-out") continue;
    const m = TOOL_DONE_RE.exec(String(l.text || ""));
    if (m) return m[1];
  }
  return "";
}

function paceResultLine(lines, line, jobId) {
  if (!state.typePacer || !globalThis.wtType || line.kind !== "tool-out" || line.lid == null) return;
  const text = String(line.text ?? "");
  if (TOOL_DONE_RE.test(text) || consoleFoldNote(text) || /^\s*(?:…|\.\.\.)\s/.test(text)) return;
  if (!globalThis.wtType.isPacedTool(resultToolOf(lines, line))) return;
  // Only the head of the result is typed; the tail lands with the burst (see RESULT_PACED_ROWS).
  if (!shouldPaceResultRow(lines, line)) return;
  typedText(line, jobId);
}

// ---- result row head
// How many rows of one result are typed, and no more. A skill's result arrives as one row per line, and handing all
// forty to the pacer made every tick write every row that had grown: one second carried 296 row writes, and the two
// seconds of that burst were 61% of a streamed window's writes (docs/console-redraw-spam.html). The head is what a
// reader watches arrive; past a handful of rows the typing is a delay rather than a reveal, so the rest of a long
// result is drawn at once. Six is a whole short result and the head of a SKILL.md.
const RESULT_PACED_ROWS = 6;

// Which row of its result this line is, counting from the call's own header (0 = the first line under it). Another
// call's header ends the count, so two results in one burst type the head of each.
function resultRowIndex(lines, line) {
  let n = 0;
  for (let k = lines.length - 1; k >= 0; k--) {
    const l = lines[k];
    if (!l || l === line) continue;
    if (l.kind === "tool") return n;
    if (l.kind === "tool-out") n += 1;
  }
  return n;
}

function shouldPaceResultRow(lines, line, cap = RESULT_PACED_ROWS) {
  return resultRowIndex(lines, line) < cap;
}
// ---- end result row head

// The words of a line that may be drawn now: the live append asks for them, and every render path asks too, so a
// repaint mid-paragraph draws the same prefix the console is showing instead of jumping to the wire's whole text.
function typedText(line, jobId) {
  const P = state.typePacer;
  const full = String(line?.text ?? "");
  if (!P || line?.lid == null) return full;
  // The wire's text reaches the pacer whether or not anybody is looking. A hidden tab has no flow to show — the frame
  // is drawn whole and held whole — but the pacer still has to be TOLD the rest of the line. It used to be skipped
  // while hidden, so a paragraph that was mid-type when the reader left stayed at the text it had then; every repaint
  // after they came back drew that prefix over the whole line, and the console showed "This" for a paragraph that
  // starts "This branch was added to main as version 0.47.0." until the card was reloaded from the store.
  const shown = P.feed(String(line.lid), String(jobId ?? ""), full);
  if (document.hidden) {
    P.flush(String(line.lid));
    return full;
  }
  return shown;
}

function typedShown(line) {
  const P = state.typePacer;
  if (!P || !line || line.lid == null) return null;
  // The record's own text goes with the question, so a repaint may only draw a prefix of THAT line (see
  // core/type-stream.js shownFor). A line with no text of its own — a reasoning row holds its words elsewhere — asks
  // with nothing, and the pacer answers for itself, exactly as it did before.
  const rec = line.text;
  return P.shownFor(String(line.lid), rec == null ? undefined : String(rec));
}

// ---- console row text
// One row's visible text, written the cheapest way that is still correct.
//
// A growing line only ever gains characters at its end, and assigning innerHTML for them re-parses the whole row and
// replaces every text node in it — which is what took a selection out of the line every 40 ms while it typed. The tail
// is appended to the row's own text node instead, so the nodes the reader is selecting in stay where they are and a
// tick costs the delta rather than the line.
//
// The innerHTML path remains the correct one in three cases, and each is checked rather than assumed:
//   * the row no longer starts with what is drawn (the wire rewrote the line, or a trim moved it);
//   * the line carries a URL: linkifyText has to turn it into an anchor, and a URL appended as text would stay
//     unclickable for the rest of the turn;
//   * the row already has an element child (an anchor, a live-clock span): appending would put the tail after it.
const ROW_URL_RE = /https?:\/\//i;

function rowTakesTail(el, next) {
  if (typeof el._drawn !== "string" || !next.startsWith(el._drawn)) return false;
  if (el.childElementCount) return false;
  if (ROW_URL_RE.test(next)) return false;
  return !el.lastChild || el.lastChild.nodeType === 3;
}

// True when the row changed, so a caller knows the pane did not move for nothing.
function drawRowText(el, text) {
  const next = String(text ?? "");
  if (el._drawn === next) return false;
  // A prose row draws MARKDOWN (core/console-markdown.js). The cheap tail-append below is still correct for a
  // growing paragraph that has no marker in the part that just arrived; once a marker lands — `**`, a backtick, an
  // underscore, a link's `[` — the row is rendered again, because the tail may be a marker that closes one already
  // on screen. Only this one row is re-parsed; the console and its other blocks are untouched.
  if (el.dataset && el.dataset.lkind === "text" && MD_MARK_RE.test(next.slice(String(el._drawn ?? "").length))) {
    el.innerHTML = consoleMdInline(next);
    el._drawn = next;
    return true;
  }
  if (rowTakesTail(el, next)) {
    // Grow the text node that is already at the end of the row: a new node per tick would leave a hundred siblings
    // behind for one line, and the reader's selection can sit inside this one and survive.
    const last = el.lastChild;
    const tail = next.slice(el._drawn.length);
    if (last && last.nodeType === 3 && typeof last.appendData === "function") last.appendData(tail);
    else el.appendChild(document.createTextNode(tail));
  } else el.innerHTML = linkifyText(next);
  el._drawn = next;
  return true;
}
// One character that can begin a markdown marker. A row with none of them in the arriving part is still plain
// text, which is what keeps a fast stream cheap.
const MD_MARK_RE = /[*_`[]/;

// ---- markdown prose, appended one line at a time -------------------------------------------------------------
// A live turn must not be repainted per token: each line is APPENDED, and this works out which block it belongs
// to (a paragraph, a list, a fence) and puts it there. core/console-markdown.js decides the shape; this does the
// DOM. A repaint (turnBody) renders the same run through consoleMdHtml, so a live console and its repaint agree
// about where a paragraph, a list and a fence begin and end.
function startMdBlock(plan, sep) {
  const holder = document.createElement("div");
  holder.innerHTML = consoleMdOpenHtml(plan);
  const block = holder.firstElementChild;
  if (block && sep) block.classList.add("jl-sep");
  return block;
}
function appendFenceRow(md, line) {
  const body = md.el.querySelector(".md-fence-body");
  if (!body) return;
  body.insertAdjacentHTML("beforeend", consoleMdAppendRow(line, "fence"));
  const n = body.children.length;
  md.el.dataset.mdLines = String(n);
  const count = md.el.querySelector(".md-fence-n");
  if (count) count.textContent = `${n} line${n === 1 ? "" : "s"}`;
}
// The closing fence. Past the fold the well arrives FOLDED, with the same head a repaint draws, so a fence that
// grew while the turn streamed ends in the shape the next repaint will give it.
function finishFence(md) {
  if (!md || md.type !== "fence" || !md.el) return;
  const body = md.el.querySelector(".md-fence-body");
  const n = body ? body.children.length : 0;
  md.el.dataset.mdLines = String(n);
  md.el.classList.remove("is-open");
  if (n <= CONSOLE_MD_FENCE_FOLD) return;
  md.el.classList.add("is-folded");
  const head = md.el.querySelector(".md-fence-head");
  if (!head) return;
  const holder = document.createElement("div");
  holder.innerHTML = consoleMdFenceHead(md.lang, n);
  head.replaceWith(holder.firstElementChild);
  if (body) body.hidden = true;
}
function appendProseLine(out, line, streaming, shown = null) {
  const prev = out._md || null;
  const plan = consoleMdPlan(prev, line);
  if (plan.action === "break") {
    out._md = null;
    return;
  }
  if (plan.action === "close") {
    finishFence(prev);
    out._md = null;
    return;
  }
  if (plan.action === "code" && prev) {
    appendFenceRow(prev, line);
    return;
  }
  if (prev && (plan.action === "line" || plan.action === "item")) {
    prev.el.insertAdjacentHTML("beforeend", consoleMdAppendRow(line, prev.type, { textOf: () => shown }));
    return;
  }
  const block = startMdBlock(plan, streaming && Boolean(out.lastElementChild));
  out.appendChild(block);
  out._md = { type: plan.type, ordered: Boolean(plan.ordered), lang: plan.lang || "", open: Boolean(plan.open), el: block };
  // An OPENING fence is a delimiter, not a line of the well: the block is the fence, and the next lines are its
  // code. (Drawn as a row it would sit inside the body it just opened, which is the shape a repaint never makes.)
  if (plan.type === "fence") return;
  block.insertAdjacentHTML("beforeend", consoleMdAppendRow(line, plan.type, { textOf: () => shown }));
}

// ---- the raw view, and the focus control ---------------------------------------------------------------
// A turn's raw bytes: the console is handed text, never markup, so the reader who needs the source gets every
// line exactly as the agent sent it (core/console-markdown.js, consoleMdRawText). `textContent` is the whole
// safety story here — a `<` in the output is a character, not a tag.
function consoleRawLines(out) {
  const id = String(out.dataset.out || "").replace(/@pin$/, "");
  return jobLines(id).filter((l) => !isBookkeeping(l));
}
function paintRawConsole(out) {
  // The attribute is NOT `data-md-raw`: that one is the reader's button, and a console carrying it would answer its
  // own selector — a click anywhere on the output would toggle the view it is showing.
  if (out.dataset.rawView !== "1") out._mdHtml = out.innerHTML;
  out.dataset.rawView = "1";
  out._md = null;
  out.textContent = consoleMdRawText(consoleRawLines(out));
  const wrap = out.closest(".out-wrap");
  if (wrap) wrap.classList.add("is-raw");
}
function restoreRenderedConsole(out) {
  delete out.dataset.rawView;
  out._md = null;
  if (typeof out._mdHtml === "string") {
    out.innerHTML = out._mdHtml;
    delete out._mdHtml;
    // The rows are fresh nodes: forget what the previous ones had been drawn with, so the next append renders
    // rather than appending half a line to a node this page no longer holds.
    for (const row of out.querySelectorAll("[data-lid]")) delete row._drawn;
    // The open block is deliberately NOT recovered here: the lines that follow the toggle start the next block,
    // which is the paragraph break a repaint would put there anyway. Joining the restored last paragraph would
    // splice a sentence into one that had already been read.
  }
  const wrap = out.closest(".out-wrap");
  if (wrap) wrap.classList.remove("is-raw");
}
function paintConsoleModes(out) {
  const wrap = out && out.closest ? out.closest(".out-wrap") : null;
  if (!wrap) return;
  const id = String(out.dataset.out || "").replace(/@pin$/, "");
  const focus = state.consoleFocus.has(id);
  wrap.classList.toggle("is-focus", focus);
  const focusBtn = wrap.querySelector("[data-md-focus]");
  if (focusBtn) {
    focusBtn.setAttribute("aria-pressed", focus ? "true" : "false");
    focusBtn.classList.toggle("is-on", focus);
  }
  const rawBtn = wrap.querySelector("[data-md-raw]");
  const raw = state.consoleRaw.has(id);
  if (rawBtn) rawBtn.setAttribute("aria-pressed", raw ? "true" : "false");
  // The two views are applied to a console that was just placed, so a repaint keeps what the reader asked for.
  if (raw && out.dataset.rawView !== "1") paintRawConsole(out);
  else if (!raw && out.dataset.rawView === "1") restoreRenderedConsole(out);
}

// Every console showing this turn — the card's own and the pinned copy — is the same reader choice: a toggle is
// applied to each of them at once, so the pinned strip cannot keep showing the other view.
function consoleCopies(btn) {
  const wrap = btn.closest(".out-wrap");
  const box = wrap && wrap.querySelector("pre.job-out");
  if (!box) return { id: "", boxes: [] };
  const id = String(box.dataset.out || "").replace(/@pin$/, "");
  const boxes = placedNodes("pre.job-out").filter((el) => String(el.dataset.out || "").replace(/@pin$/, "") === id);
  return { id, boxes: boxes.length ? boxes : [box] };
}
function toggleConsoleRaw(btn) {
  const { id, boxes } = consoleCopies(btn);
  if (!id) return;
  const on = !state.consoleRaw.has(id);
  if (on) state.consoleRaw.add(id);
  else state.consoleRaw.delete(id);
  for (const box of boxes) {
    const wrap = box.closest(".out-wrap");
    const control = wrap && wrap.querySelector("[data-md-raw]");
    if (on) paintRawConsole(box);
    else restoreRenderedConsole(box);
    if (!control) continue;
    control.setAttribute("aria-pressed", on ? "true" : "false");
    control.classList.toggle("is-on", on);
    control.textContent = on ? "rendered" : "raw";
    control.title = on ? "back to the rendered view (markdown, links, fences)" : "show this turn's text exactly as it arrived, markdown and all";
  }
}
function toggleConsoleFocus(btn) {
  const { id, boxes } = consoleCopies(btn);
  if (!id) return;
  const on = !state.consoleFocus.has(id);
  if (on) state.consoleFocus.add(id);
  else state.consoleFocus.delete(id);
  for (const box of boxes) {
    const wrap = box.closest(".out-wrap");
    if (!wrap) continue;
    wrap.classList.toggle("is-focus", on);
    const control = wrap.querySelector("[data-md-focus]");
    if (control) {
      control.setAttribute("aria-pressed", on ? "true" : "false");
      control.classList.toggle("is-on", on);
      control.title = on ? "show the tool rows again" : "hide the tool rows: read the prose, the errors and the final message";
    }
  }
}
// A fence past the fold: the head's button opens and shuts that one well. Its own line count is the label, and
// the caret says which way it points.
function toggleConsoleFence(btn) {
  const well = btn.closest(".md-fence");
  const body = well && well.querySelector(".md-fence-body");
  if (!body) return;
  const open = body.hidden;
  body.hidden = !open;
  well.classList.toggle("is-folded", !open);
  const n = Number(well.dataset.mdLines) || body.children.length;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  btn.textContent = open ? "collapse" : `show ${n} line${n === 1 ? "" : "s"}`;
  const caret = well.querySelector(".md-fence-caret");
  if (caret) caret.textContent = open ? "\u25be" : "\u25b8";
}
// ---- end markdown prose
// ---- end console row text

// ---- console writers
// How a write reaches a console, and what a console owns.
//
//   * A row is addressed through the console of the JOB that owns the line — never by a document-wide
//     `[data-lid]` query. Line ids are one server sequence, not a page-wide key: a card the board adopted from
//     another panel process can carry the same numbers, and a global lookup then writes one agent's line into
//     another agent's console. Three agents at once is where that stops being theoretical.
//   * Following the newest line never measures the page inside a write. A console remembers whether the reader is at
//     its bottom (set once when it is first seen, then updated only by its own scroll events), and a stick is one
//     scrollTop write, batched to at most one per console per animation frame. Reading scrollHeight per row per tick
//     lays the whole board out again for every line of every agent, which is what made one agent's output stutter
//     the others.
function wireConsole(el) {
  if (!el || el._wired) return el;
  el._wired = true;
  // "Following" is the last line itself, not a band around it. Forty px of tolerance read as generous, but one row of
  // a long turn is taller than that: a reader who nudged up to read the newest line was still "at the bottom" to the
  // page and every paint path re-anchored them on the next line (measured on 0.46.0: 42 moves / +850 px in 30 s on a
  // console parked 24 px up, against 0 px at 296 px). Two px is a scroll landing on the end, not a reader in the band.
  el._atBottom = el._selfTop == null ? true : el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
  el.addEventListener(
    "scroll",
    () => {
      // Every scroll is measured, the panel's own included. A restore puts the reader back where its record says, and
      // that is the bottom only when the record says so: assuming "the panel wrote it, so it is following" pinned a
      // console the reader had been handed back to the middle of (applyStoredScrolls writes atBottom:false). One
      // scroll event is a gesture or a rebuild, not a row, so the layout read this costs is the one the per-row
      // paints were paying for.
      el._atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
    },
    { passive: true },
  );
  // A console that arrives already in the reader's raw view (or with focus on) is drawn that way once, here: the
  // state is the page's, so a repaint may replace the node but never the reader's choice. Called guardedly because
  // this function is READ OUT of the page on its own by test/console-tail-pin.test.js (a vm over the source): a
  // bare call to a second function would make that region depend on a third, which is not what it is testing.
  if (typeof paintConsoleModes === "function") paintConsoleModes(el);
  return el;
}

// ---- the board's consoles, without walking the board ----------------------------------------------------------
// Six paths want every console of one kind on the page, and each asked the whole document for them every time:
// - the typing pacer on every tick (paintTypedLines -> consoleOuts);
// - every streamed line (drawJobLine);
// - every stream repaint (paintStreamConsole);
// - the 400 ms sweep, three times over (consoles, thinking bodies, subagent consoles).
// On the reader's board each of those is a walk of a 55k-node page to find a few dozen nodes. A console only arrives by
// being placed, so a node observer of their own notes each one as it lands. A lookup returns the noted ones still in
// the page, still of that kind, in document order: the same list the walk returned. It must be its own observer and
// not the copy observer's queue. A lookup first takes the records still waiting for it, so a console placed earlier in
// this same task is counted; taking the copy observer's records would run the copy buttons' mount in the middle of a
// paint. Before the watch is set up (placedNodes.watch, beside the copy observer) a lookup is the walk it replaces.
// What it cannot see is a node that TAKES one of these classes after it was placed; nothing in this file does that
// (no classList.add / className write names job-out, think-body, sub-console, detail, tgrp or queue-ago, and nothing
// sets data-q-clock or data-detail on a placed node), and test/placed-nodes.test.js holds the lookup to the walk's
// answer through every way a node does arrive and leave.
function placedNodes(sel) {
  const w = placedNodes.watch;
  const set = w && w.sets.get(sel);
  if (!set) return [...document.querySelectorAll(sel)];
  for (const r of w.mo.takeRecords()) for (const n of r.addedNodes) notePlaced(w, n);
  const out = [];
  for (const el of set) {
    if (!el.isConnected) set.delete(el);
    else if (el.matches(sel)) out.push(el);
  }
  return out.length > 1 ? out.sort(byDocumentOrder) : out;
}

function notePlaced(w, node) {
  if (!node || node.nodeType !== 1) return;
  for (const [sel, set] of w.sets) if (node.matches(sel)) set.add(node);
  if (!node.firstElementChild) return;
  for (const el of node.querySelectorAll(w.any)) for (const [sel, set] of w.sets) if (el.matches(sel)) set.add(el);
}

function byDocumentOrder(a, b) {
  if (a === b) return 0;
  return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
}

// One scan per paint: every console on the board, grouped by the job it draws (a pinned copy is its job's too).
function consoleOuts() {
  const byJob = new Map();
  for (const el of placedNodes("pre.job-out")) {
    const id = el.dataset.out || "";
    const job = id.endsWith("@pin") ? id.slice(0, -4) : id;
    let list = byJob.get(job);
    if (!list) byJob.set(job, (list = []));
    list.push(wireConsole(el));
  }
  return byJob;
}

const stickPending = new Set();
let stickFrame = 0;

// Ask for this console to follow its newest line, at most once per frame, and only while the reader is following it.
function stickSoon(el) {
  if (!el || !el.dataset) return;
  if (!consolePinned(el.dataset.out) && el._atBottom !== true) return;
  stickPending.add(el);
  if (stickFrame) return;
  stickFrame = requestAnimationFrame(() => {
    stickFrame = 0;
    const batch = [...stickPending];
    stickPending.clear();
    for (const out of batch) {
      if (!out.isConnected) continue;
      if (!consolePinned(out.dataset.out) && out._atBottom !== true) continue;
      setScroll(out, out.scrollHeight); // one read per console per frame, not one per row
    }
  });
}
// ---- end console writers

// The pacer says which lines grew; every pane carrying one gets the new prefix (a pinned turn draws its own copy,
// so the same line can be in two consoles at once).
function paintTypedLines(lids) {
  const P = state.typePacer;
  if (!P) return;
  const byJob = consoleOuts();
  for (const lid of lids) {
    const outs = byJob.get(String(P.jobFor(lid) ?? ""));
    if (!outs || !outs.length) continue;
    for (const out of outs) {
      // A reasoning row types inside its thinking block, which follows its own stickiness, not the console's.
      for (const el of out.querySelectorAll(`[data-lid="${CSS.escape(String(lid))}"]`)) {
        if (!el.isConnected) continue;
        // The row's own record goes with the question, so a paint can never shorten a line to a prefix the pacer has
        // stopped growing (see typedShown): the worst a stale tick can do is nothing. A row with no record of its own
        // (a reasoning row) asks with nothing.
        const rec = el.dataset.ltext;
        const shown = rec == null ? P.shownFor(lid) : P.shownFor(lid, rec);
        if (shown == null) continue;
        if (!drawRowText(el, shown)) continue;
        const body = el.closest(".think-body");
        if (body) stickThinkBody(body);
        else stickSoon(out);
      }
    }
  }
}

// The turn is over: nothing may be left waiting in either buffer, and the last of a paragraph's words are released
// rather than left to a clock that has nothing more to say.
function flushTypeStream(job) {
  state.typeHold?.drain(String(job ?? ""));
  state.typeGate?.drain(String(job ?? ""));
  state.typePacer?.flushJob(String(job ?? ""));
}

function paintStreamSpeed() {
  const w = typeWordSpeed();
  const l = typeLineRate();
  const words = $("stream-words");
  if (words && document.activeElement !== words) words.value = String(w);
  const lines = $("stream-lines");
  if (lines && document.activeElement !== lines) lines.value = String(l);
  // The preset the stored value lands on is lit, so the row says what it is without reading the number back.
  for (const b of document.querySelectorAll("[data-stream-words-set]")) {
    b.classList.toggle("on", Number(b.dataset.streamWordsSet) === w);
  }
  for (const b of document.querySelectorAll("[data-stream-lines-set]")) {
    b.classList.toggle("on", Number(b.dataset.streamLinesSet) === l);
  }
  const preview = $("stream-preview");
  if (!preview) return;
  preview.textContent =
    !w && !l
      ? "output arrives exactly as the run sent it — both off"
      : `${w ? `words type at ${w}/s` : "words appear as they arrive"} · ${l ? `new lines walk in at ${l}/s` : "new lines appear at once"}`;
}

function saveTypeWords(value) {
  const n = globalThis.wtType ? globalThis.wtType.clampWords(value) : 0;
  state.typePacer?.setRate(n);
  try {
    localStorage.setItem(TYPE_WORDS_KEY, String(n));
  } catch {
    /* private mode: the choice just will not persist */
  }
  paintStreamSpeed();
}

function saveTypeLines(value) {
  const n = globalThis.wtType ? globalThis.wtType.clampLines(value) : 0;
  state.typeGate?.setRate(n);
  try {
    localStorage.setItem(TYPE_LINES_KEY, String(n));
  } catch {
    /* private mode: the choice just will not persist */
  }
  paintStreamSpeed();
}

// A read that BEGINS after this call. loadThinking drops a request while one is in flight (the poll must not stack up),
// but an answer already on its way may have been asked for before the store held the reply the caller is waiting on,
// so this waits that one out and then asks again. Resolves once the answer is painted — which is also when the pacer
// has been handed any new thought, so a caller that looks at the pacer afterwards sees it.
async function loadThinkingAfter(turn) {
  const until = Date.now() + REASONING_READ_WAIT_MS;
  while (state.thinkLoading.has(turn.id) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  await loadThinking(turn, "");
}

// One turn's thoughts, from the store, bounded by the turn's own clock.
//
// The session the STORE is read under is the turn's own Hermes session, never the card's thread. A worker run is
// started with the thread as its session, so the two are the same string there; an assistant's turns run under a
// session the gateway named from the prompt, so asking the store for `panel-assistant-5` answers "nothing recorded"
// while that turn's own session holds its blocks. That is what made only the one assistant whose session matched its
// thread show any reasoning at all.
//
// Visibility is a different question with a different answer (see `thinkHtml`): the 🧠 switch belongs to the CARD.
function thinkingSessionFor(turn) {
  return String(turn?.sessionId || turn?.thread || turn?.id || "");
}

// ---- reconcile thinking ----
// A live-streamed reasoning.delta preview grows ONE block under a stable `at`. The store poll's
// finished reasoning block carries a DIFFERENT `at` (the message timestamp). Adopting it wholesale
// while the turn is live would (a) hand paceThinkBlock a brand-new `think:<at>` lid, so it types the
// whole text again from word 0 — the "doubling back" — and (b) show the same reasoning twice. Keep
// the live block's own lid and settle the store's complete text INTO it instead: the same `at` means
// the pacer keeps growing one line, never restarting. With no live preview this is the old behaviour.
function reconcileThinking(prev, fresh) {
  const live = (prev || []).filter((b) => b && b.live);
  if (!live.length) return fresh;        // no live-streamed preview: store poll replaces wholesale, as before
  if (!fresh.length) return prev;        // nothing authoritative yet: keep the growing preview
  const complete = fresh.map((b) => String(b.text ?? "")).join("\n\n");
  const kept = prev.filter((b) => !b || !b.live);
  kept.push({ ...live[live.length - 1], text: complete, live: true });
  kept.sort((a, b) => Number(a.at) - Number(b.at));
  return kept;
}
// ---- end reconcile thinking ----

async function loadThinking(turn, copy = "") {
  const key = turnKey(turn, copy);
  if (state.thinkLoading.has(turn.id)) return;
  state.thinkLoading.add(turn.id);
  const prev = state.thinkCache.get(turn.id)?.blocks || [];
  // The block keeps what it has unless a read it can TRUST says otherwise. This is the only pane on a card that is
  // polled; the run's own output is appended and never rebuilt, which is why the recording of a run never flickers and
  // this did.
  let blocks = prev;
  try {
    // Bounded by the turn's own clock, which stops where the next turn began (an interrupted turn has no endedAt).
    const { from, to } = turnBounds(turn);
    const r = await apiFetch(
      `/api/thinking?thread=${encodeURIComponent(thinkingSessionFor(turn))}&from=${from}&to=${to}`,
    );
    if (r.ok) {
      const d = await r.json();
      const fresh = Array.isArray(d.blocks) ? d.blocks : [];
      // A read that FAILED (`error`) is not a turn that recorded nothing: taking its empty array would blank the block
      // and refill it on the next poll — a collapse and reopen, every couple of seconds, on every live card.
      // And a live turn's block list only ever GROWS (the store appends one row per assistant message and takes none
      // away), so an empty answer while the turn is still running is a bad read too. A shorter non-empty answer is left
      // alone: past MAX_BLOCKS the oldest block legitimately drops out of the window.
      if (!d.error && (fresh.length || !prev.length || !turnLive(turn))) blocks = reconcileThinking(prev, fresh);
    }
  } catch {
    /* an unreadable store is not worth a banner: the block just keeps what it already shows */
  } finally {
    state.thinkLoading.delete(turn.id);
  }
  state.thinkCache.set(turn.id, { blocks, at: Date.now() });
  paintThink(turn, "");
  if (document.querySelector(`details.think[data-think-turn="${CSS.escape(turnKey(turn, "@pin"))}"]`)) paintThink(turn, "@pin");
}

// Repaint just the block, so a read landing mid-turn does not rebuild the card under the reader.
// A block opened by the panel (because its turn is running) is not the reader opening it: without this the auto-open
// would be remembered as a choice and the block would never fold again after the turn ends.
const thinkAutoOpened = new WeakSet();

function stickSubConsole(box) {
  if (!box || !box.isConnected) return;
  const id = box.dataset.subConsoleBox || "";
  if (state.subConsolePinned.get(id) === false) return;
  const max = box.scrollHeight - box.clientHeight;
  if (max <= 0 || Math.abs(box.scrollTop - max) <= 1) return;
  setScroll(box, max);
}

function stickThinkBody(body) {
  if (!body || !body.isConnected) return;
  const key = body.closest("details.think")?.dataset.thinkTurn || "";
  if (state.thinkPinned.get(key) === false) return;
  const max = body.scrollHeight - body.clientHeight;
  if (max <= 0 || Math.abs(body.scrollTop - max) <= 1) return;
  setScroll(body, max);
}

// In the single-stream mode there is no block to repaint: the blocks are lines of the console itself, so a read that
// lands mid-turn redraws that console, keeping the reader where they were (the same rule as the run's own appends).
//
// The redraw is a PATCH, not a replacement. Written as one `innerHTML` assignment it threw away every row of a live
// console — and the reader's text selection with it — on every reasoning re-read (~1.2 s while a turn runs), leaving
// the scroll to whatever the browser did with a box whose children had just been replaced: the same fault
// `Let a card pick its model, and keep the console still while it runs` cured one level up for the condensed console
// (a fresh <pre> at scrollTop 0, several times a second), still open one renderer down. So: a row whose words did not
// move keeps its NODE, a new row is inserted where it belongs, a row the turn's window has dropped is removed, and
// the reader's place goes back where it was. A body that would drop rows from the MIDDLE or the tail — a failed store
// read, a shorter answer mid-turn — draws nothing at all, the same rule `loadThinking` follows for the blocks it has.
const streamRowKey = (n) => {
  const lid = n?.dataset?.lid;
  if (lid) return `l:${lid}`;
  const grp = n?.dataset?.tgrp;
  return grp ? `g:${grp}` : "";
};

function syncStreamConsole(out, body, stick) {
  const holder = document.createElement("div");
  holder.innerHTML = body;
  const next = [...holder.children];
  const before = [...out.children];
  // Where the reader is: the first row with any part of itself inside the box, and how far into the box it starts.
  // A poll that grows a row above it must not slide the reader's line down the box.
  const keep = (() => {
    if (stick) return null;
    const box = out.getBoundingClientRect();
    for (const n of before) {
      const r = n.getBoundingClientRect();
      if (r.bottom > box.top + 1) return { key: streamRowKey(n), off: Math.round(r.top - box.top) };
    }
    return null;
  })();
  // A shorter body is only ever a WINDOW TRIM: `windowLines`/`slice(-300)` and `MAX_BLOCKS` drop rows off the TOP.
  // Rows that vanish from the middle or the tail are a read this console should not draw (a failed store read, a
  // shorter answer mid-turn), and drawing it is what collapses the box and pulls everything under it up the page.
  // So: every row below the first one the new body still names must still be named by it.
  const nextKeys = new Set(next.map(streamRowKey).filter(Boolean));
  if (next.length < before.length) {
    const firstNext = next.map(streamRowKey).find(Boolean) || "";
    const keyed = before.map((n) => streamRowKey(n)).filter(Boolean);
    const from = Math.max(0, keyed.indexOf(firstNext));
    if (keyed.slice(from).some((k) => !nextKeys.has(k))) return false;
  }
  if (!before.length) {
    out.replaceChildren(...next);
  } else {
    const byKey = new Map();
    for (const n of before) {
      const k = streamRowKey(n);
      if (k && !byKey.has(k)) byKey.set(k, n);
    }
    let cursor = out.firstElementChild;
    for (const fresh of next) {
      const k = streamRowKey(fresh);
      const have = k ? byKey.get(k) : null;
      if (k) byKey.delete(k);
      let place = have;
      if (have) {
        // The same row in the same place: only its words can have moved, so it is replaced only when they did.
        if (have !== cursor) out.insertBefore(have, cursor);
        if (!have.isEqualNode(fresh)) {
          have.replaceWith(fresh);
          place = fresh;
        }
      } else {
        out.insertBefore(fresh, cursor);
        place = fresh;
      }
      cursor = place.nextElementSibling;
    }
    // Whatever the new body does not name is out of this turn's window. It is all below the loop's cursor, so
    // removing it moves nothing the reader is looking at.
    while (cursor) {
      const gone = cursor;
      cursor = cursor.nextElementSibling;
      gone.remove();
    }
  }
  if (keep?.key) {
    const again = [...out.children].find((n) => streamRowKey(n) === keep.key);
    if (again) {
      const off = Math.round(again.getBoundingClientRect().top - out.getBoundingClientRect().top);
      if (Math.abs(off - keep.off) >= 2) setScroll(out, out.scrollTop + (off - keep.off));
    }
  }
  // The rows this paint replaced include the open markdown block (if there was one): the next appended line must
  // start from the DOM that is actually there, never from a block node this page has just detached.
  out._md = null;
  return true;
}

function paintStreamConsole(turn, copy = "", thread = turn.thread || turn.id) {
  const out = placedNodes("pre.job-out").find((el) => el.dataset.out === `${turn.id}${copy}`);
  if (!out) return false;
  const all = jobLines(turn.id).filter((l) => !isBookkeeping(l));
  const stick = consolePinned(`${turn.id}${copy}`) || wireConsole(out)._atBottom !== false;
  syncStreamConsole(out, streamBodyHtml(turn, all.slice(-300), all.length > 300, thread), stick);
  if (stick) stickSoon(out);
  paintToBottom(out);
  return true;
}

// A poll of the store used to be drawn by replacing the whole `<details>`: one fresh node per read, every block
// inside it new. That is what made the block churn 5.6 rows a second on a card whose model had stopped, and it took
// the reader's selection, the block's open state and the copy button with every read. What a poll's answer actually
// changes is the WORDS: the last thought grows as the pacer types it, one more thought appears at the end, and the
// count in the summary moves. So the node stays — its `open` belongs to the reader (sweepThinking folds it when the
// turn ends, and the card repaint on a status change re-renders it) — the summary's copy button is never touched, and
// only the text that moved is written, in place, so a selection standing in an untouched block survives the read.
const thinkRowKey = (n) => n?.dataset?.lid || (n?.classList?.contains("think-empty") ? "@empty" : "");

// Same element skeleton, different words: the one case that can be patched without replacing anything.
function sameThinkShape(a, b) {
  if (!a || !b || a.nodeType !== b.nodeType) return false;
  if (a.nodeType === 3) return true;
  if (a.nodeType !== 1) return false;
  if (a.tagName !== b.tagName) return false;
  if ((a.getAttribute("class") || "") !== (b.getAttribute("class") || "")) return false;
  // A link's identity is its target: linkifyText can turn a half-typed URL into an anchor mid-read, and that changes
  // the tree's shape rather than its words.
  if (a.tagName === "A" && (a.getAttribute("href") || "") !== (b.getAttribute("href") || "")) return false;
  if (a.childNodes.length !== b.childNodes.length) return false;
  for (let i = 0; i < a.childNodes.length; i++) if (!sameThinkShape(a.childNodes[i], b.childNodes[i])) return false;
  return true;
}

function writeThinkText(live, fresh) {
  for (let i = 0; i < live.childNodes.length; i++) {
    const l = live.childNodes[i];
    const f = fresh.childNodes[i];
    if (!f) return;
    if (l.nodeType === 3) {
      if (l.nodeValue !== f.nodeValue) l.nodeValue = f.nodeValue;
    } else if (l.nodeType === 1) {
      writeThinkText(l, f);
    }
  }
}

// One row of the block, patched against the one it replaced in the cache: same lid keeps its node (and whatever the
// reader has selected in it), a row the window has dropped is removed, a new thought is inserted where it belongs.
function syncThinkBody(body, freshBody) {
  const next = [...freshBody.children];
  const byKey = new Map();
  for (const n of body.children) {
    const k = thinkRowKey(n);
    if (k && !byKey.has(k)) byKey.set(k, n);
  }
  // The "nothing yet — it will appear here as the agent thinks" row BECOMES the first thought instead of being
  // replaced by it. It is the one line the reader is watching before there is anything to read, and the first block
  // arriving is that row's content, not a new row under it: adopt it, so the block's first paint keeps its node
  // (and the harness's "every row it drew" count is the reader's count, not a placeholder swapped for a paragraph).
  const empty = byKey.get("@empty");
  const first = next[0];
  if (empty && first && first.dataset.lid && !empty.dataset.lid) {
    empty.dataset.lid = first.dataset.lid;
    empty.className = first.className;
    empty.innerHTML = first.innerHTML;
    byKey.delete("@empty");
    byKey.set(first.dataset.lid, empty);
  }
  let cursor = body.firstElementChild;
  for (const want of next) {
    const k = thinkRowKey(want);
    const have = k ? byKey.get(k) : null;
    if (k) byKey.delete(k);
    let place = have;
    if (have) {
      if (have !== cursor) body.insertBefore(have, cursor);
      if (have.innerHTML !== want.innerHTML) {
        if (sameThinkShape(have, want)) writeThinkText(have, want);
        else have.innerHTML = want.innerHTML;
      }
    } else {
      body.insertBefore(want, cursor);
      place = want;
    }
    cursor = place.nextElementSibling;
  }
  while (cursor) {
    const gone = cursor;
    cursor = cursor.nextElementSibling;
    gone.remove();
  }
}

function syncThinkBlock(el, fresh) {
  const meta = el.querySelector(":scope > summary .think-meta");
  const wantMeta = fresh.querySelector(":scope > summary .think-meta");
  if (meta && wantMeta && meta.textContent !== wantMeta.textContent) meta.textContent = wantMeta.textContent;
  const body = el.querySelector(".think-body");
  const freshBody = fresh.querySelector(".think-body");
  if (!body || !freshBody) return false;
  syncThinkBody(body, freshBody);
  return true;
}

function paintThink(turn, copy = "") {
  const key = turnKey(turn, copy);
  // The block (or, in the 🌊 mode, the console that carries the reasoning) is drawn inside ONE card, and that card's
  // thread is the value its 🧠 wrote. Reading the choice back from the node the turn actually belongs to is what keeps
  // the repaint and the button on one key, whatever the turn's own thread says.
  const block = document.querySelector(`details.think[data-think-turn="${CSS.escape(key)}"]`);
  const consoleOut = block ? null : document.querySelector(`pre.job-out[data-out="${CSS.escape(turn.id)}${CSS.escape(copy)}"]`);
  const thread = (block || consoleOut)?.closest(".job[data-thread]")?.dataset.thread || turn.thread || turn.id;
  // The 🌊 draws the reasoning inside the console, so that is the thing to repaint — there is no block on the page.
  if (streamOn(thread) && paintStreamConsole(turn, copy, thread)) return;
  const el = block;
  if (!el) return;
  const holder = document.createElement("div");
  holder.innerHTML = thinkHtml(turn, copy, thread);
  const fresh = holder.firstElementChild;
  if (!fresh) return;
  const body = el.querySelector(".think-body");
  // A block that lost its body (a shape this renderer no longer draws) is healed once by the old wholesale path.
  if (!body) {
    el.replaceWith(fresh);
    const made = fresh.querySelector(".think-body");
    if (made) stickThinkBody(made);
    return;
  }
  // Where the reader was. A patched body keeps its scroll by itself; this is for the row that grew past the box.
  const keep = { top: body.scrollTop };
  if (!syncThinkBlock(el, fresh)) return;
  // The body is the same node, and a new thought appended under it must not push the reader's line out of view
  // unless they were reading at the bottom (or the panel pinned it there).
  if (state.thinkPinned.get(key) === false) setScroll(body, Math.min(keep.top, Math.max(0, body.scrollHeight - body.clientHeight)));
  else stickThinkBody(body);
}


// While a turn is running its block is open and re-read, which is what the separate live reasoning line used to do; once
// the turn ends it folds unless the reader left it open. One control, one mental model.
function thinkOpenFor(turn, key) {
  if (state.thinkOpen.has(key)) return true;
  if (state.thinkClosed.has(key)) return false;
  return turnLive(turn);
}

function thinkHtml(turn, copy = "", thread = turn.thread || turn.id) {
  const key = turnKey(turn, copy);
  // The CARD's thread, handed down from the renderer. It is the same value the 🧠 beside this block writes, so a press
  // always flips the block drawn under it: a turn that carries a thread of its own (an assistant's turns run under a
  // session the gateway named) or carries none must not answer for the card's choice.
  if (!thinkingOn(thread)) return "";
  const entry = state.thinkCache.get(turn.id);
  const blocks = entry?.blocks || [];
  const open = thinkOpenFor(turn, key);
  const meta = !entry ? "reading…" : blocks.length ? `${blocks.length} block${blocks.length === 1 ? "" : "s"}` : "none recorded";
  return `<details class="think" data-copy data-think-turn="${esc(key)}"${open ? " open" : ""}>
    <summary><span class="think-title">🧠 thinking</span> <span class="think-meta mono">${esc(meta)}</span></summary>
    <div class="out-wrap"><div class="think-body">${
      blocks.length
        ? blocks.map((b) => {
            // The same words/s the prose types at: the block is fed the first time it is seen on a live turn, and
            // the tick repaints it through this very data-lid.
            const shown = paceThinkBlock(turn, b);
            return `<div class="think-block mono" data-lid="think:${esc(b.at)}">${linkifyText(shown == null ? b.text : shown)}</div>`;
          }).join("")
        : `<div class="think-block mono think-empty">${
            entry
              ? turnLive(turn)
                ? "nothing yet — it will appear here as the agent thinks"
                : "this turn recorded no thinking"
              : "reading the store…"
          }</div>`
    }</div>${toBottomBtnHtml()}</div>
  </details>`;
}

// ---- copy buttons ------------------------------------------------------------------------------
// One mechanism for every "lift this block" affordance: an element carrying `data-copy` carries a small
// button in its corner that appears while the pointer is over it and copies THAT BLOCK's own visible
// text. The button is mounted here, by the observer below, never by the renderers - so a block another
// worker draws (the console's code and diff windows) opts in by carrying the same attribute, and there
// is no second mechanism to keep in step with this one.
//
// What a block copies is what it SHOWS: the reading goes through innerText, so a folded burst or a
// folded reasoning block contributes only the lines on screen, never a hidden one. Every control inside
// the block is taken out of that reading - this button's own label, the "N lines" and "+ N commands"
// buttons, the jump-to-the-newest-line chip - because a control's label is chrome, not output.
const COPY_SEL = "[data-copy]";
const COPY_BTN_SEL = "[data-copy-btn]";
const COPY_TEXT_SEL = "[data-copy-text]";
const COPY_TITLE = "copy this block's text to the clipboard";
const COPY_FLASH_MS = 1400;

function copyButtonHtml() {
  return `<button type="button" class="copy-block" data-copy-btn="1" title="${COPY_TITLE}" aria-label="${COPY_TITLE}">⧉</button>`;
}

// The one place a button is created. Idempotent: the button this inserts is itself a mutation, so the
// observer below sees it, asks again, finds the button already there and stops.
function mountCopyButtons(root) {
  if (!root || root.nodeType !== 1) return;
  const blocks = [];
  if (root.matches?.(COPY_SEL)) blocks.push(root);
  for (const el of root.querySelectorAll?.(COPY_SEL) || []) blocks.push(el);
  for (const block of blocks) {
    // A <details> renders only its summary while it is folded, so its button goes IN the summary: a folded
    // block has to be copyable too, and what it copies is still its folded text.
    const host = block.tagName === "DETAILS" ? block.querySelector(":scope > summary") || block : block;
    if (host.querySelector(":scope > .copy-block")) continue;
    host.insertAdjacentHTML("beforeend", copyButtonHtml());
  }
}

// Generic by construction: ANY render path that puts a `[data-copy]` block on the page gets its button -
// a card rebuilt from scratch, a console line appended by the run's stream, a pinned copy of a turn.
//
// The same hook arms the thinking block's OPEN state, and for the same reason: it is a fact about nodes that arrive
// from a render path, whoever wrote it. A `<details open>` inserted into the document fires a `toggle` of its own,
// queued as a task — indistinguishable, to the listener below, from the reader pressing it. Every re-read of the store
// inserts one (`paintThink` → `el.replaceWith`), so without this every live turn's block was remembered as "the reader
// opened it", `state.thinkOpen` grew a key per turn, and a finished turn's reasoning never folded again. The observer
// runs as a microtask, before that queued task, so the flag is always in place in time.
function armPlacedThink(root) {
  if (!root || root.nodeType !== 1) return;
  if (root.matches?.("details.think[open]")) thinkAutoOpened.add(root);
  for (const d of root.querySelectorAll?.("details.think[open]") || []) thinkAutoOpened.add(d);
}

// ---- motion nobody can see -------------------------------------------------------------------------------------
// A card's pulse dot is a looping opacity + transform animation, which the compositor runs for free while the dot is
// painted. Scrolled out of view it is not painted, and Chrome then runs the animation on the MAIN thread instead -
// its own trace logs "compositor property animations have no effect" (failure 1 << 17) - every frame, for a dot
// nobody can see. Measured on the reader's board in a GPU-composited client, three alternating pairs of 8 s with the
// rows open: one dot off screen held 4.5 points of a core (9.3% animated against 4.8% still), and the same dot on
// screen 0.1. A board scrolled past its running cards pays that once per dot. So a dot off screen is paused
// (`.is-offscreen`, style.css) and plays again as it scrolls back in. Watched from the node observer below, which sees
// every node any render path places; the dots are long-lived (the pulse is rewritten in place every second), and a
// detached one is let go the next time a dot arrives.
const motionDots = new Set();
const offscreenMotion =
  typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
        for (const e of entries) e.target.classList.toggle("is-offscreen", !e.isIntersecting);
      })
    : null;

function watchMotion(root) {
  if (!offscreenMotion || !root || root.nodeType !== 1) return;
  const found = root.matches?.(".pulse-dot") ? [root] : [...(root.querySelectorAll?.(".pulse-dot") || [])];
  if (!found.length) return;
  for (const d of motionDots) {
    if (d.isConnected) continue;
    offscreenMotion.unobserve(d);
    motionDots.delete(d);
  }
  for (const d of found) {
    if (motionDots.has(d)) continue;
    motionDots.add(d);
    offscreenMotion.observe(d);
  }
}

const copyObserver = new MutationObserver((records) => {
  for (const r of records) {
    for (const node of r.addedNodes) {
      if (node.nodeType !== 1) continue;
      mountCopyButtons(node);
      armPlacedThink(node);
      watchMotion(node);
    }
  }
});

// What a block copies: its own text, as the reader sees it. innerText alone will not do - a flex row (a
// tool burst's call: glyph, name, tally, arguments, timer) has its items blockified, so innerText breaks
// them onto five separate lines, and textContent ignores what is folded away altogether. So the walk
// below keeps innerText's rules for what is SHOWN - a folded or hidden subtree contributes nothing - one
// line box at a time, and lays a flex row's items out the way the reader sees them: one line, separated.
const COPY_SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "BUTTON"]);

function copyBlockBox(el) {
  const d = getComputedStyle(el).display;
  return d !== "none" && d !== "contents" && !d.startsWith("inline");
}

function copyShownText(el) {
  if (!el || el.nodeType !== 1) return "";
  if (COPY_SKIP_TAGS.has(el.tagName)) return ""; // a control's label is chrome, never output
  if (el.tagName === "BR") return "\n";
  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden" || el.hidden) return "";
  if (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true })) return "";
  // A folded block contributes its title line and nothing else, whatever its contents compute to.
  if (el.tagName === "DETAILS" && !el.open) return copyShownText(el.querySelector(":scope > summary"));
  // A wrapper a renderer added for a fold is read THROUGH, not treated as a block of its own: a block's copy is
  // trimmed at its edges, and applied to a tool call's output that would eat the leading spaces of whichever line
  // happens to be first under the wrapper (a result line reads "  ↳ patch · 3.27s" on screen). The lines inside
  // are the console's own text, so they are lifted exactly as they are shown.
  if (el.hasAttribute && el.hasAttribute("data-copy-through")) {
    return [...el.childNodes].map((k) => (k.nodeType === 3 ? k.nodeValue : k.nodeType === 1 ? copyShownText(k) : "")).join("\n");
  }
  const display = cs.display;
  if (display === "flex" || display === "inline-flex" || display === "grid" || display === "inline-grid") {
    // A flex ROW lays its items out on one line - which is the whole reason this walk exists - while a
    // flex COLUMN or a grid stacks them, one line each. (A tool burst's head is a column: one row per
    // tool, and its copy is one line per tool.)
    const onOneLine = (display === "flex" || display === "inline-flex") && !String(cs.flexDirection || "").startsWith("column");
    return [...el.children]
      .map(copyShownText)
      .map((t) => t.trim())
      .filter(Boolean)
      .join(onOneLine ? " " : "\n");
  }
  const kids = [...el.childNodes];
  // A line box - text and inline content only: innerText is exact for one, pre-wrap and all.
  if (!kids.some((k) => k.nodeType === 1 && copyBlockBox(k))) return el.innerText;
  return kids
    .map((k) => (k.nodeType === 3 ? k.nodeValue : k.nodeType === 1 ? copyShownText(k) : ""))
    .join("\n")
    .replace(/[ \t]+(?=\r?\n)/g, "")
    .replace(/(\r?\n){2,}/g, "\n")
    .replace(/^[\s\r\n]+|[\s\r\n]+$/g, "");
}

// The part that IS the block's text, when the marked element is a wrapper: a tool burst's button sits on
// the burst (so hovering anywhere in it finds one button) while a burst copies its CALL - the header and
// its summary as rendered - and never its result lines. It is a DIRECT child: a burst inside a console
// carries one of its own, and the console must not read it as its own text.
function blockCopyText(block) {
  return copyShownText(block.querySelector(`:scope > ${COPY_TEXT_SEL}`) || block);
}

function flashCopyButton(btn, ok) {
  btn.textContent = ok ? "✓" : "✕";
  btn.classList.toggle("is-copied", ok);
  btn.classList.toggle("is-failed", !ok);
  btn.title = ok ? "copied to the clipboard" : "the clipboard refused it - nothing was copied";
  clearTimeout(btn._copyTimer);
  btn._copyTimer = setTimeout(() => {
    btn.textContent = "⧉";
    btn.classList.remove("is-copied", "is-failed");
    btn.title = COPY_TITLE;
  }, COPY_FLASH_MS);
}

// ---- the reader's own input, per card
// Which card the reader is working in is the question a scroll event has to answer, so the clock is keyed by the CARD
// and not by the page. With one document-wide `lastInputAt`, a wheel over card B licensed the next scroll event on
// card A to be read as A's reader scrolling: A's pin was rewritten from a silent 35 px clamp 790 ms after the wheel,
// and it then stayed 1,277 px off its tail for the rest of the window (tools/measure-console-pin.mjs, 2,587 frames).
// Input outside every card (the board's own chrome, the assistant panel) is not a console scroll and decides nothing.
const INPUT_WINDOW_MS = 1200; // a scroll this soon after a wheel / key / click in the SAME card is the reader's
const lastInputAt = new Map(); // card thread -> when the reader last wheeled / keyed / clicked inside that card

// Did the reader touch the card this box belongs to, inside the window? A box with no card above it answers `false`:
// nothing the reader did elsewhere on the page is evidence about it, and a scroll the panel cannot attribute stays the
// panel's own.
function readerInputHere(el) {
  const card = el && el.closest ? el.closest(".job[data-thread]") : null;
  const at = card ? lastInputAt.get(card.dataset.thread) : 0;
  return Boolean(at) && Date.now() - at < INPUT_WINDOW_MS;
}
// ---- end the reader's own input, per card
const selfScrolled = new WeakSet();

function consolePinned(id) {
  return state.outPinned[id] !== false;
}

function pinConsole(id) {
  if (id) state.outPinned[id] = true;
}

// A fold the reader opens inside a console hands that console over. The growth is the reader's, not the run's: a
// console still following its newest line carries the view down by the height of what was just folded out (the 400 ms
// stick and the next live line both answer "this console is off its end"), so the box's LAST line fills the view and
// the line the reader was on is gone above it. Unpinned, the view does not move and the box opens under the header
// that was pressed; ↓ (or scrolling back to the end) follows the run again. `atBottom: false` is written with the
// position because a rebuilt card and a re-rendered table restore from that record (applyStoredScrolls,
// restoreScrolls), and a stale "atBottom" would follow the growth on the next repaint.
//
// Called only when a press OPENS something: folding a box back away shrinks the console, and the browser's own clamp
// is the right answer there. Settings > Agent cards > "Jump to an opened result" restores the old follow-the-growth
// behaviour, and off is the default (foldFollowsConsole).
function holdConsoleFor(control) {
  const pre = control && control.closest ? control.closest("pre.job-out") : null;
  if (!pre || !pre.dataset.out || foldFollowsConsole()) return null;
  state.outPinned[pre.dataset.out] = false;
  state.outScrolls[pre.dataset.out] = { top: pre.scrollTop, atBottom: false };
  // …and the page's cached answer has to say so too. A paced paint consults `_atBottom` instead of measuring, and the
  // fold's own growth fires no scroll event to correct it, so a console that was just handed over would be carried to
  // the bottom of what the reader opened on the next tick — the fault this function exists to prevent.
  pre._atBottom = false;
  return pre;
}

// Every scroll the panel performs goes through here. Its scroll event arrives after this task, and without a
// record of what the panel did it is indistinguishable from the reader scrolling - which unpinned consoles during
// a rebuild and left them parked at the top until something else happened to move them.
// A node whose scrollTop is still where the panel put it: the event it is reporting is the panel's own.
function justPlaced(el) {
  return el._selfTop != null && Math.abs(el.scrollTop - el._selfTop) <= 1;
}

function setScroll(el, top) {
  if (!el) return;
  const v = Math.max(0, Math.round(Number(top) || 0));
  el._selfTop = v;
  // Only a write that MOVES the box sends a scroll event, so only that write may claim the next one as the panel's.
  // Most writes move nothing - the follow path re-sticks a console already on its newest line every frame, and a
  // restore often lands on the line the box is on - and the flag such a write left behind had no event of its own to
  // spend it on: it was spent on the reader's next real scroll instead. The wheel still unpinned the console, but its
  // place was never recorded, so state.outScrolls kept the old answer (none at all, or "at the bottom") and the next
  // rebuild that restores from it put the reader somewhere they had not been (docs/console-bounce-manual-7391.md).
  // Reading scrollTop here costs no layout: assigning it already lays the box out to clamp the value.
  const from = el.scrollTop;
  el.scrollTop = v;
  if (el.scrollTop !== from) selfScrolled.add(el);
}

// Rebuilds land before the browser has finished laying the new nodes out, so a "go to the bottom" can be clamped
// to a shorter height than the console ends up with. Once the frame is done, put the pinned ones back on their
// newest line - and only those, so a console the reader took control of is never moved.
// The synchronous half of settleScrolls: run it right after a rebuild inserts nodes, so nothing is ever painted at
// the first line before the frame-based pass gets to it. That one-frame flash is what read as the block "jumping".
function restoreThinkBodies(root) {
  if (!root) return;
  for (const b of root.querySelectorAll(".think-body")) restoreThinkBody(b);
}

function settleScrolls(root) {
  const run = () => {
    if (!root || !root.isConnected) return;
    for (const o of root.querySelectorAll("pre.job-out")) stickConsole(o);
    for (const b of root.querySelectorAll(".think-body")) restoreThinkBody(b);
    for (const s of root.querySelectorAll(".sub-console")) stickSubConsole(s);
    // A repaint can move the card under an open picker; put the panel back under its control.
    positionModelPop();
  };
  requestAnimationFrame(() => requestAnimationFrame(run));
}

// A thinking block in a rebuilt card is a fresh node at its first line. Pinned follows the newest line (as the
// live block does); one the reader took control of returns to where they had it.
function restoreThinkBody(body) {
  if (!body || !body.isConnected) return;
  const key = body.closest("details.think")?.dataset.thinkTurn || "";
  if (state.thinkPinned.get(key) !== false) {
    stickThinkBody(body);
    return;
  }
  const was = state.thinkScroll.get(key);
  if (!was) return;
  setScroll(body, Math.min(was.top, Math.max(0, body.scrollHeight - body.clientHeight)));
}

function stickConsole(pre) {
  if (!pre || !pre.dataset || !consolePinned(pre.dataset.out)) return;
  const max = pre.scrollHeight - pre.clientHeight;
  if (max <= 0 || Math.abs(pre.scrollTop - max) <= 1) return;
  setScroll(pre, max);
}

function captureScrolls(root) {
  const map = new Map();
  if (!root) return map;
  for (const o of root.querySelectorAll("pre.job-out")) {
    map.set(o.dataset.out, {
      top: o.scrollTop,
      // A node the panel has never placed (a fresh build) sits at 0 until something moves it. Reading that 0 as
      // "the reader scrolled up" is what made a rebuilt console come back at its first line.
      atBottom: o._selfTop == null || o.scrollHeight - o.scrollTop - o.clientHeight < 32,
    });
  }
  return map;
}

function restoreScrolls(root, map) {
  if (!root || !map.size) return;
  for (const o of root.querySelectorAll("pre.job-out")) {
    const was = map.get(o.dataset.out);
    if (!was) continue;
    setScroll(o, consolePinned(o.dataset.out) || was.atBottom ? o.scrollHeight : Math.min(was.top, Math.max(0, o.scrollHeight - o.clientHeight)));
  }
}

// Put a console's remembered height back on a node that is NOT the one the reader dragged. `o` either came out of
// conversationHtml (a card built from nothing: a collapsed project expanded again, a row that had no card to carry) or
// replaced the box a rebuild threw away - and an inline style belongs to the element, so the number was gone with it.
// Without this the box returns on its cap or at its content height, which reads as the panel throwing the reader's
// resize away every time anything about the turn changes.
//
// The cap is the other half of the promise. A height bigger than the box's max-height is clipped by it, so a stored
// height above the cap lifts the cap exactly as the drag did; the cap is read off the page rather than assumed, because
// one board draws the same console under 320 px in a worktree row and 230 px in the unattached list. A height at or
// under the cap is left to the sheet: the inline height alone reproduces it, and the cap keeps doing its job.
//
// Returns whether a height was applied, so a caller can tell "the reader chose this" from "a fresh box".
function applyStoredHeight(o) {
  if (!o || !o.dataset) return false;
  const h = Number(state.outHeights[o.dataset.out || ""]);
  if (!Number.isFinite(h) || h <= 0) return false;
  o.style.height = `${h}px`;
  const cap = parseFloat(getComputedStyle(o).maxHeight);
  if (Number.isFinite(cap) && h > cap) o.style.maxHeight = "none";
  return true;
}

// Every console under a subtree that was rebuilt: the height FIRST, so whatever scroll is placed after it is clamped in
// the box the reader left rather than in the 230px one it is about to stop being.
function applyStoredHeights(root) {
  if (!root) return;
  for (const o of root.querySelectorAll("pre.job-out")) applyStoredHeight(o);
}

// Put every console in this subtree back where the reader left it, from the remembered positions.
// Used after a subtree was rebuilt from scratch, where there is no old node to measure.
function applyStoredScrolls(root) {
  if (!root) return;
  applyStoredHeights(root);
  for (const o of root.querySelectorAll("pre.job-out")) {
    const was = state.outScrolls[o.dataset.out];
    if (!was) continue;
    setScroll(o, consolePinned(o.dataset.out) || was.atBottom ? o.scrollHeight : Math.min(was.top, Math.max(0, o.scrollHeight - o.clientHeight)));
  }
  applySubConsoleScrolls(root);
}

// A console a rebuild BUILT, rather than moved: the markup came out of conversationHtml() a moment ago, so there is no
// old node to measure and no entry in the caller's capture map, and nothing else in that rebuild is going to place it.
// Left alone it is a fresh scroll area at its first line, and the run has been writing into that console all along: the
// reader sees the top of a log the panel was following to the end - one card, once per rebuild that builds it, which is
// the "one that is never repaired" the write log could not name (docs/console-combined-first-line.md).
// Called in the same task as the insert, so no frame is ever painted at 0. A console the reader has taken over goes
// back to the line they left it on; everything else follows its newest line, which is the panel's promise.
function placeBuiltConsoles(root) {
  if (!root) return;
  for (const o of root.querySelectorAll("pre.job-out")) {
    // The height the reader dragged this console to, before anything is measured or scrolled inside it: a box that
    // comes back at its cap and then grows puts the reader's line somewhere else than where they left it.
    applyStoredHeight(o);
    if (o._selfTop != null) continue; // someone already placed it in this task; their answer is the one to keep
    const id = o.dataset.out || "";
    const was = state.outScrolls[id];
    if (was && !consolePinned(id) && !was.atBottom) {
      setScroll(o, Math.min(was.top, Math.max(0, o.scrollHeight - o.clientHeight)));
      continue;
    }
    setScroll(o, o.scrollHeight);
  }
  // A child's console lives in the same card and was built by the same insert, so it is in the same state.
  applySubConsoleScrolls(root);
}

// A repainted strip and a rebuilt card both REPLACE the node a child's console lives in, so its position cannot ride
// on the element the way holdScrolls() carries a moved one: it is remembered by child id and written back onto the
// fresh node in the same task. A box still following its newest line goes to the bottom; one the reader took over
// goes back to the line they left it on. A box that fits its content has nowhere to go and is left alone.
function applySubConsoleScrolls(root, { follow = false } = {}) {
  if (!root) return;
  for (const box of root.querySelectorAll(".sub-console[data-sub-console-box]")) {
    const id = box.dataset.subConsoleBox || "";
    if (!id) continue;
    const max = box.scrollHeight - box.clientHeight;
    if (max <= 0) continue;
    if (follow || state.subConsolePinned.get(id) !== false) {
      setScroll(box, max);
      continue;
    }
    const top = state.subConsoleTop.get(id);
    if (top != null) setScroll(box, Math.min(top, max));
  }
}

// ---- moving nodes without losing what is scrolled inside them ------------------------------------------------
// Appending a node that is already in the page is a remove-then-insert: the subtree leaves the layout tree and comes
// back as a fresh scroll area at `scrollTop = 0`. That is the one kind of jump no scroll code writes, and it is what
// reads as two consoles fighting each other while one of them is written to: the move that reset them was about a
// third thing on the board (a closed section's rank, another row's place), and every console inside the moved
// subtree went to its first line in the same frame. So a move here only touches the elements that are actually out
// of place, and whatever does move holds its scroll boxes across the move, in the same task, so no frame is painted
// at 0 and no reader waits for the 400 ms sweep to hand their place back.
function placeInOrder(parent, want) {
  // Backwards, so every element is put down relative to a successor that is already where the order asks it to be.
  // An element whose next sibling is already the right one is never detached at all - that is the whole point.
  let moved = 0;
  for (let i = want.length - 1; i >= 0; i--) {
    const el = want[i];
    if (!el) continue;
    const next = want[i + 1] || null;
    if (el.parentNode === parent && el.nextElementSibling === next) continue;
    parent.insertBefore(el, next);
    moved += 1;
  }
  return moved;
}

// Where every scroll box in this subtree stands, read BEFORE anything is moved: a read taken after the move reads the
// 0 the move left, and a restore built on that writes the reader back to the top.
function holdScrolls(root) {
  const held = [];
  if (!root) return held;
  for (const el of root.querySelectorAll("pre.job-out, .think-body, .sub-console")) {
    const think = el.classList.contains("think-body");
    const sub = el.classList.contains("sub-console");
    held.push({
      el,
      think,
      sub,
      top: el.scrollTop,
      key: think ? el.closest("details.think")?.dataset.thinkTurn || "" : sub ? el.dataset.subConsoleBox || "" : el.dataset.out || "",
    });
  }
  return held;
}

// Put them back. A box still pinned follows its newest line (what it holds may have grown with the move); one the
// reader took over goes back to the line they were on.
function releaseScrolls(held) {
  for (const h of held || []) {
    const el = h.el;
    if (!el || !el.isConnected) continue;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) continue;
    const pinned = h.think
      ? state.thinkPinned.get(h.key) !== false
      : h.sub
        ? state.subConsolePinned.get(h.key) !== false
        : consolePinned(h.key);
    setScroll(el, pinned ? max : Math.min(h.top, max));
  }
}
// A card that is taken out of the document and put back (fillAgentSlots) is a fresh scroll area at its first line,
// so the child consoles inside it are held by the element, exactly as holdScrolls() holds a moved section's boxes.
// Only the child consoles: pre.job-out and the thinking bodies are restored by their own ids in the paths below.
function holdSubConsoles(root) {
  const held = [];
  if (!root) return held;
  for (const el of root.querySelectorAll(".sub-console[data-sub-console-box]")) {
    held.push({ el, think: false, sub: true, top: el.scrollTop, key: el.dataset.subConsoleBox || "" });
  }
  return held;
}
// ---- end moving nodes without losing what is scrolled inside them

// Scrolling at all is the reader taking over just as much as a click is: stop pulling the page back to
// the spawned agent. The wheel was the only gesture watched, so a scrollbar drag, Page Down or a
// trackpad fling still got yanked back a moment later - which is the "it pops me back up to the box"
// report. pendingScrollAt stamps our own one-time jump so it is not read as the reader scrolling.
let pendingScrollAt = 0;
// Every scroll the panel performs on purpose stamps this. The follow below ends on a READER scroll - and the
// panel's own aim/follow jumps (up to the New-agent card, then down to the new agent) are not that.
function programmaticScroll() {
  pendingScrollAt = Date.now();
}
const endFollowOnScroll = (e) => {
  if (Date.now() - pendingScrollAt < 600) return;
  // Only the page counts. A console scrolling its own output (captured here because scroll does not
  // bubble but capture sees every descendant) is the agent working, not the reader leaving.
  const t = e && e.target;
  const page = !t || t === document || t === document.scrollingElement || t === window || t === document.documentElement;
  if (!page) return;
  if (state.pendingFocus) state.pendingFocus = null;
};

function appendJobLine(evt) {
  // The run's live numbers ride the line they belong to: a jobline frame carries them (lib/jobs.js emitLine),
  // so the pulse's age advances with the output instead of needing a summary frame per token.
  if (evt.live) {
    const job = state.jobs.get(evt.id);
    if (job) job.live = evt.live;
  }
  const line = evt.line || {};
  // A reasoning block that arrived on the run's own stream is PUSHED, so it can be shown
  // before the store poll finds it. The console keeps its dim preview line; the full text
  // seeds the 🧠 pane additively, keyed by the line's own server timestamp. A live-streamed
  // chunk (reasoning.delta) carries a STABLE at and is marked `live`: one growing block that
  // owns the pane while the turn runs, so a later store poll cannot re-key it and retype the
  // whole text from word 0 (see reconcileThinking / loadThinking). A finished
  // reasoning.available is the same reasoning under a different at — ignore it once a live
  // block exists, or the reader sees two copies of one thought.
  if (line.think) {
    const turn = state.jobs.get(evt.id);
    if (turn) {
      const at = Number(line.at) || Date.now();
      const entry = state.thinkCache.get(turn.id) || { blocks: [], at: 0 };
      const hasLive = entry.blocks.some((b) => b && b.live);
      if (line.thinkOnly || !hasLive) {
        // A live-streamed chunk drops stale store/available blocks: the pane shows exactly ONE
        // growing block, never the finished copy alongside the streaming one.
        const blocks = line.thinkOnly
          ? entry.blocks.filter((b) => b && b.live && Number(b.at) !== at)
          : entry.blocks.filter((b) => Number(b.at) !== at);
        blocks.push({ at, text: String(line.think), ...(line.thinkOnly ? { live: true } : {}) });
        blocks.sort((a, b) => Number(a.at) - Number(b.at));
        state.thinkCache.set(turn.id, { blocks, at: Date.now() });
        paintThink(turn, "");
      }
    }
  }
  // A streamed reasoning chunk (`line.thinkOnly`) is a PUSHED PREVIEW of one growing block, not a
  // console line: lib/jobs.js emits it coalesced, keyed by a stable `at`, with the cumulative text so
  // far. The `line.think` branch above just painted the 🧠 pane from it; returning here keeps it out
  // of the line-by-line hold, recordJobLine() and drawJobLine(). One frame per token would otherwise
  // flood the transcript and repaint the console. The marked `live` block stays authoritative while
  // the turn runs; the store poll adopts the finished text only once the turn settles (see loadThinking).
  if (line.thinkOnly) return;
  // The line-by-line setting holds a burst of whole lines and lets them in one at a time. Bookkeeping never waits:
  // the `result` line is what says the turn ended, and it is also the frame that flushes both buffers. A hidden tab
  // is not reading anything, so it never holds a line either — the answer is there in full when the reader returns.
  if (!document.hidden && !isBookkeeping(line) && state.typeHold?.push(evt)) return;
  if (!document.hidden && !isBookkeeping(line) && state.typeGate?.push(evt)) return;
  // The turn is over: what the reasoning hold is keeping goes into the console BEFORE the line that says so.
  if (line.kind === "result") state.typeHold?.drain(evt.id);
  recordJobLine(evt);
  drawJobLine(evt);
  if (line.kind === "result") flushTypeStream(evt.id);
}

// The console's own record of the turn — the lines a rebuild draws from. A held line is not in here yet, so a
// repaint mid-burst shows the transcript as far as it has got.
//
// The buffer is trimmed to the same number of lines the panel keeps for a turn (lib/jobs.js MAX_LINES), not a longer
// one of its own: at 1,000 against the server's 600 the tab held lines the panel had already dropped, and no snapshot
// ever told it so. One number on both sides of the wire, and the page can never show a console the server has
// forgotten the tail of.
const JOB_LINES_PER_TURN = 600;

function recordJobLine(evt) {
  const line = evt.line || {};
  let buf = state.jobLines.get(evt.id);
  if (!buf) {
    // This is the only place a buffer is created. A snapshot used to seed one for every record it carried, which
    // retained the record's 60-line tail twice for every turn on the board; the card draws that tail from the record
    // itself now (`jobLines()`), so a buffer is only needed once a line is actually going into it — and then it
    // starts from the tail the card is already showing, or a turn that was running before this tab opened would
    // read as if it began at the first frame that arrived.
    const rec = state.jobs.get(evt.id);
    buf = turnLive(rec) && Array.isArray(rec.lines) ? rec.lines.slice() : [];
  }
  // mode "set" = the agent is still writing the same paragraph; that line grows in place
  // instead of a new one being pushed for every streamed fragment.
  const at = line.lid ? buf.findIndex((l) => l.lid === line.lid) : -1;
  if (line.mode === "set" && at >= 0) buf[at] = { ...buf[at], ...line };
  else buf.push(line);
  if (buf.length > JOB_LINES_PER_TURN) buf.splice(0, buf.length - JOB_LINES_PER_TURN);
  state.jobLines.set(evt.id, buf);
  // A new buffer is also the moment the tab can cross its ceiling on how many turns it holds one for.
  trimJobLines();
  // A folded turn shows only the peek, and it is not part of the console the lines are appended to.
  refreshTurnPeek(state.jobs.get(evt.id));
}

// One line into every pane showing this turn.
function drawJobLine(evt) {
  const line = evt.line || {};
  // Kept in the buffer, never drawn: see BOOKKEEPING_LINES above.
  if (isBookkeeping(line)) return;
  // A pinned turn renders twice — in its page and in the pinned block above — so every pane carrying
  // this id (or its "@pin" copy) gets the line.
  const outs = placedNodes("pre.job-out")
    .filter((el) => el.dataset.out === evt.id || el.dataset.out === `${evt.id}@pin`)
    .map(wireConsole);
  if (!outs.length) return;
  // The words of a growing paragraph that may be drawn now: the pacer holds the tail and releases it on its own
  // clock, so the console fills in a word or two at a time instead of a coalesced phrase at a time.
  const shownText = line.kind === "text" ? typedText(line, evt.id) : line.text;
  // Whether this turn is drawn as ONE stream. Only that console sets a piece apart from the piece above it: the
  // condensed layout keeps its own margins, which is the layout it already had.
  const streaming = streamOn(state.jobs.get(evt.id)?.thread || evt.id);
  for (const out of outs) {
    // Streamed lines follow the newest output only for a reader who is already at the bottom; someone
    // scrolled up to read stays where they are. The answer comes from the console's own remembered state (set by its
    // scroll events), not from a layout read per line.
    const stick = consolePinned(out.dataset.out) || out._atBottom !== false;
    // Only the placeholder an empty console shows gives way to the first line. This used to ask whether the first CHILD
    // was dim, but a dim line is transcript too ("⇢ asked to work in …", "cut from …", "push guard: …") and every
    // repaint — the thinking sweep, a new deliverable, an approval — puts one back on top, so the next live line wiped
    // everything the reader had on screen and drew only itself until the following repaint put it all back.
    out.querySelector(":scope > [data-wait]")?.remove();
    // A tool call joins the burst at the tail of the console and updates its tally in place; anything said in
    // between ends that burst, so the next call starts a fresh tally where the transcript has got to.
    const isTool = line.kind === "tool" || line.kind === "tool-out";
    const tail = out.lastElementChild;
    // Whether this line belongs in the burst already at the tail. A call that follows a result, or one a reasoning
    // block was written after, starts the next burst — the same cut `segments()` makes on the next repaint, so the
    // append and the poll cannot disagree about where the row lives (a row that joins and is then cut out again is
    // one the reader sees leave one box and appear in the next).
    const tailLines = isTool && tail && tail.classList.contains("tgrp") ? tail._burst || groupLines(tail) : null;
    // A tool-usage group is a RUN of calls: a call that arrives after the result above it still belongs in the same
    // group, because the group is what the two rules bracket and the run is what they bracket. Prose ends it (the
    // tail stops being a `.tgrp`), and the condensed view keeps its own cut — there a group is the burst the head
    // row tallies, and `joinsTail` is what keeps the append and that repaint honest.
    const tailFlat = Boolean(tail && tail.classList.contains("tgrp") && tail.dataset.gflat === "1");
    const joins = tailFlat
      ? true
      : !tailLines || !globalThis.wtStream || typeof globalThis.wtStream.joinsTail !== "function"
        ? true
        : globalThis.wtStream.joinsTail(
            (state.jobLines.get(evt.id) || []).filter((l) => !isBookkeeping(l)),
            line,
            state.thinkCache.get(evt.id)?.blocks || [],
            tailLines,
          );
    const openGroup = isTool && tail && tail.classList.contains("tgrp") && joins ? tail : null;
    if (isTool) {
      // A call ends the prose: the next sentence starts its own block rather than being appended to a paragraph
      // that sits above a tool row.
      out._md = null;
      const key = openGroup ? openGroup.dataset.tgrp : `${evt.id}#${Date.now().toString(36)}`;
      // A group that came from a full render has no `_burst`; read its lines back from the DOM so the new call joins
      // the burst the reader is looking at instead of starting a group that shows this line alone.
      const lines = [...(openGroup && tailLines ? tailLines : []), line];
      // The lines of a skill's result are written, not dropped in: this is where each one is handed to the pacer, BEFORE
      // the burst is drawn, so its first paint already shows only the words that may be shown.
      paceResultLine(lines, line, evt.id);
      // A tool chosen by the reader keeps its filter and open body while the burst grows under it.
      const filter = openGroup ? openGroup.dataset.filter || "" : "";
      const bodyEl = openGroup ? openGroup.querySelector(".tgrp-body") : null;
      // A growing burst keeps the offset it was rendered with; a new one starts where this console's earlier bursts
      // stopped consuming this tool's rows.
      let gofs = null;
      if (openGroup) {
        try {
          gofs = openGroup.dataset.gofs ? JSON.parse(openGroup.dataset.gofs) : null;
        } catch {
          gofs = null;
        }
      } else {
        gofs = storeOffsetsBefore(out, null);
      }
      // The group already on screen says whether this console is drawn as a stream; a new one asks its card. A flat
      // piece has no head row and no "N lines" button, so a call appended to it must not grow one back. A NEW group
      // in a card is flat when the reader turned the tally off (Settings > Count tool calls) - the append has to
      // draw the shape the repaint will, or the next repaint would move every row of the burst.
      const flat = openGroup ? openGroup.dataset.gflat === "1" : streaming || !toolGroupsOn();
      // The blank line a reasoning block has always had, before every piece of a stream: a group that opens where
      // another piece already stands is set apart from it, and a group growing in place keeps the separation it was
      // drawn with (the same piece, not a new one). The condensed console has no such blank line, so a flat group
      // there takes none: `streaming`, not `flat`, is what decides.
      const sep = streaming && (openGroup ? openGroup.classList.contains("jl-sep") : Boolean(out.lastElementChild));
      const holder = document.createElement("div");
      holder.innerHTML = toolGroupHtml(lines, key, filter, bodyEl ? !bodyEl.hidden : false, openGroup ? openGroup.dataset.gat || "" : "", gofs, flat ? { flat: true, sep } : {});
      const fresh = holder.firstElementChild;
      if (fresh) {
        fresh._burst = lines;
        if (openGroup) openGroup.replaceWith(fresh);
        else out.appendChild(fresh);
        rememberToolGroup(fresh);
      }
    } else if (out.dataset.rawView === "1") {
      // The raw view is the turn's own bytes, so a line that lands while it is open is part of them: repaint the
      // text, never append a rendered row beside it.
      paintRawConsole(out);
    } else {
      const existing = line.lid ? out.querySelector(`[data-lid="${CSS.escape(String(line.lid))}"]`) : null;
      if (line.mode === "set" && existing) {
        // One rule for both writers: append what the row is missing when it can, reparse it only when it must.
        drawRowText(existing, shownText);
        existing.dataset.ltext = String(line.text ?? "");
      } else if (consoleMdIsProse(line.kind)) {
        // The agent's own words join the block already open (a paragraph, a list, a fence) or start the next one.
        // Appending one row is the whole cost of a streamed line: nothing above it is repainted.
        appendProseLine(out, line, streaming, shownText);
      } else {
        out._md = null;
        const div = document.createElement("div");
        div.className = `jl jl-${line.kind || "raw"}`;
        // A chunk of normal output is a piece of the stream too: the same blank line above it, unless it is the
        // console's first piece. Only the 🌊 console draws that — this is the layout the condensed one already had.
        if (streaming && out.lastElementChild) div.classList.add("jl-sep");
        if (line.lid) div.dataset.lid = line.lid;
        // The line's own text travels with it, the same way a rendered line carries it: a rebuild reads lines
        // back out of the DOM, and this one must read as what was said rather than as what was drawn.
        div.dataset.ltext = String(line.text ?? "");
        div.dataset.lkind = String(line.kind || "raw");
        drawRowText(div, shownText);
        out.appendChild(div);
      }
    }
    if (stick) stickSoon(out);
  }
  refreshJobPreview(evt.id);
}
