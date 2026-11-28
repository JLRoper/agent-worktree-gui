// Cut 1 of four for public/board/console.js, card 9 of docs/reports/module-separation-2026-11-28.html's split plan
// (the plan measured the file at 4,502 lines and named 1,006-1,552 for this cut; re-measured on this base the file is
// 4,502 lines and the cut is 1,006-1,552). A classic script, loaded by public/index.html after /board/console.js and
// before app.js.
//
// WHAT MOVED, BYTE FOR BYTE: the tool group key (what a burst is remembered BY, and the window that keeps that identity
// in view), the trimmed group head, the tool-usage group (toolGroupHtml), the two paint shortcuts (paintAtEnd,
// paintToBottom) and the three controls the group is drawn with (toBottomBtnHtml, outGripHtml, consoleToolsHtml).
//
// The page's own globals are unchanged. Every top-level `function` here is a `window` property under its own name, and
// every top-level `const`/`let` a binding in the one global lexical environment console.js and app.js read, so not one
// call site changes: the names console.js no longer declares are still page globals, declared here.

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
      // ONE clock slot per row, empty until the row has something to say and never re-created: the text is written
      // into this node by whoever owns the number (the build here, tickLiveClocks between builds, the completion
      // swap), so a repaint is a text write and not a new span. `data-live-from` rides the slot so the sampler and
      // the tick find the same node; the row outlives every repaint because a group of the same run is patched, not
      // replaced (see patchGroup in the console).
      const state =
        running
          ? `<span class="jl-live tgrp-state" data-tgrp-clock data-live-from="${r.at || Date.now()}">${liveSuffix(r.at || Date.now())}</span>`
          : r.duration != null
            ? `<span class="tgrp-state" data-tgrp-clock>${r.duration.toFixed(2)}s</span>`
            : `<span class="tgrp-state" data-tgrp-clock></span>`;
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
      ? `<span class="tgrp-state" data-tgrp-clock>error</span>`
      : secs != null
        ? `<span class="tgrp-state" data-tgrp-clock>${secs.toFixed(2)}s</span>`
        : running
          ? `<span class="jl-live tgrp-state" data-tgrp-clock data-live-from="${from || Date.now()}">${liveSuffix(from || Date.now())}</span>`
          : `<span class="tgrp-state" data-tgrp-clock></span>`;
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

// The console's own corner. It is the only thing that resizes a console (`public/app.js` owns the gesture and the
// number): the box is drawn in a `.out-box` with the <pre>, so this element's corner IS the console's corner, and the
// marching tail and the chips below it are siblings of that box and cannot move it. Drawn as three diagonal ticks by
// the sheet, in the shape the float's corner grip already has; a span rather than a button because there is no press
// to announce and no label to read, and a focusable stop between a transcript and the reply box is a stop for nothing.
function outGripHtml() {
  return `<span class="out-grip" data-out-grip="1" title="drag this corner to resize the console"></span>`;
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

// The answer the 400 ms pass already knows: the box grew and was just stuck to its tail, or it does not overflow at
// all. No box is read for it - paintToBottom's two reads per box are the choke point the report timed, and a box the
// page itself scrolled to the end cannot be showing the reader a chip. Only a dirty chip (a reader parked above the
// tail) goes through the measuring path, and it does so at most twice a second.
function paintAtEnd(box) {
  const wrap = box?.closest?.(".out-wrap");
  if (wrap && !wrap.classList.contains("is-at-end")) wrap.classList.add("is-at-end");
  if (box) box._chipDirty = false;
}

function paintToBottom(box) {
  const wrap = box?.closest?.(".out-wrap");
  if (!wrap) return;
  // Which box the reader is actually reading. A console drawn inside a card's session scroller has no tail of its
  // own: the sheet gives it `max-height: none`, so it cannot scroll and `.job-body` scrolls for it. A chip tied to
  // that console could never be shown and could never move anything, so the NEWEST console in the body speaks for
  // the body and carries the one chip such a pane has; every other console keeps the answer its own box gives, which
  // is the behaviour the board has always had.
  const body = cardBodyOf(box);
  const scroller = box.scrollHeight > box.clientHeight + 4 || !body || cardTailConsole(body) !== box ? box : body;
  const overflowing = scroller.scrollHeight > scroller.clientHeight + 4;
  // The chip is the reader's way back, so it appears exactly when the console is NOT following: the same 2 px the
  // pin uses. A 24 px band hid it for a reader parked a few px up, who was then neither following nor offered the ↓.
  const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2;
  wrap.classList.toggle("is-at-end", !overflowing || atEnd);
  box._chipDirty = false;
}
