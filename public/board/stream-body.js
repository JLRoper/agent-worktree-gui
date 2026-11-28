// stream-body.js - the body a turn draws, and the block it sits in: one stream of the panel's console
// lines, the reasoning rows inside it, the thinking placeholder that stands in until the first line
// lands, and the turn's own block around the body.
// Cut 1 of the two in docs/reports/module-separation-2026-11-28.html, section 15, the card for
// public/render-jobs.js (read from 2ffacfef, measured at 3bb43694).
//
// WHAT MOVED, AND WHERE FROM. public/render-jobs.js lines 46-300, line for line: streamBodyHtml,
// mdRunHtml, emptyConsoleHtml, condensedBodyHtml, turnBody, conversationTaskLink and turnBlock. Not one
// body was rewritten, not one name renamed and not one call site touched. The plan's card gives this
// range as 46-302; 300 is turnBlock's closing brace and 301 its trailing blank, so 302 (the comment
// heading of the stuck-turn chip section) travels with the function it introduces, in
// public/board/conversation.js.
//
// HOW IT IS LOADED. public/index.html loads this as a classic script after /render-projects.js and
// before /board/conversation.js, /render-jobs.js and /app.js. The page is one global scope, so every
// top-level function here is the same page-wide binding it was inside render-jobs.js: public/app.js's
// window.WMApp.jobs door and every other bare-name caller read the name they read before.
//
// WHAT IT REACHES OUT FOR: the names the pre-cut render-jobs.js header listed, unchanged - state and
// esc, the turn land in public/turns.js, the console land in public/board/console.js and public/dom.js,
// and the card's own wiring in public/settings.js, public/render-projects.js and public/app.js.

// ---- one stream: the turn's own body, drawn in its order ---------------------------------------------------------
// Everything a card keeps apart, in one flow: the panel's console lines, the reasoning blocks (placed by
// core/stream-merge.js — see why its comment is the authority on where a block goes), and each RUN of tool calls drawn
// as the reader asked for it — one row per call inside two rules, with what each call returned one click under its row.
//
// The drift is drawn piece by piece on purpose (wtStream.pieces): a live line then only ever redraws the piece it
// belongs to, so a reader's selection in an earlier paragraph survives the turn growing under it. A run of call pieces
// is the exception the group IS: those pieces are collected into one group node, which is what "a rule above and a
// rule below the group" means.
function streamBodyHtml(turn, lines, windowFull = false, thread = turn.thread || turn.id, taskLink = null) {
  const W = globalThis.wtStream;
  if (!W || typeof W.merge !== "function" || typeof W.pieces !== "function") return "";
  // Reasoning joins the stream only while the 🧠 is on: with it off, the console draws no thinking row at all.
  const thinking = thinkingOn(thread);
  const shown = thinking ? lines : lines.filter((l) => l && l.kind !== "think");
  const blocks = thinking ? state.thinkCache.get(turn.id)?.blocks || [] : [];
  // A live thought is already IN the lines: appendJobLine put one preview row per reasoning segment there,
  // in arrival order, and marked it `preview`. Merging the store's blocks beside those rows would draw the
  // same thought twice, so a turn holding a preview is drawn from its record alone; the settled read takes
  // the previews out and the store's blocks are merged by `at` (see dropThoughtPreviews).
  const previews = shown.some((l) => l && l.preview && l.kind === "think");
  // Reasoning joins the console as lines keyed `think:<at>`; feeding them to the stream HERE, where the turn's own
  // clock is at hand, is what makes lineHtml type them out exactly like prose. A live preview is never paced: its
  // words arrive in chunks and a repaint must not replay them from the first one.
  if (!previews) for (const b of blocks) if (!b || !b.preview) paceThinkBlock(turn, b);
  const merged = previews
    ? shown
    : W.merge(shown, blocks.filter((b) => !b || !b.preview), { windowFull, hidePreviews: blocks.length > 0 });
  const storeSeen = new Map();
  const parts = [];
  let n = 0;
  // A RUN of call pieces is ONE group. `pieces()` cuts a unit per call (so a live line only ever redraws the call it
  // belongs to), but the reader's tool-usage group is the run: one rule above its rows, one below, however many calls
  // the burst made. So consecutive call pieces are collected here and handed to the one renderer that draws a group.
  // Its separation is the run's FIRST piece's — `pieces()` decides that, nothing here — and the piece after the run
  // carries its own, which is the blank line under the group.
  let run = null;
  // A run of the agent's own lines is one markdown block (a paragraph, a list, a fence): the same grouping the
  // condensed card uses, so the two views cannot disagree about what a list is.
  let mdRun = null;
  const flushMd = () => {
    if (!mdRun) return;
    parts.push(mdRunHtml(mdRun.lines, mdRun.sep, { scope: turn.id, open: state.codeBoxOpen }, taskLink));
    mdRun = null;
  };
  const flushRun = () => {
    if (!run) return;
    parts.push(toolGroupHtml(run.lines, `${turn.id}#f${n++}`, "", false, "", run.gofs, { flat: true, sep: run.sep }));
    // The stored rows this group paired from are claimed for the whole TURN: the next group starts after them.
    for (const l of run.lines) {
      if (l.kind !== "tool-out") continue;
      const m = TOOL_DONE_RE.exec(String(l.text || ""));
      if (m) storeSeen.set(m[1], (storeSeen.get(m[1]) || 0) + 1);
    }
    run = null;
  };
  // Every piece here is set apart from the piece above it by the one blank line a reasoning block has always had —
  // `pieces()` says which, and `jl-sep` is the class that rule hangs on. Nothing above the first piece: there is
  // nothing up there to be set apart from.
  for (const seg of W.pieces(merged)) {
    if (!seg) continue;
    const sep = seg.sep ? "jl-sep" : "";
    if (!seg.unit) {
      flushRun();
      // The agent's prose is collected and handed to core/console-markdown.js as one run; anything else (a
      // reasoning line, a panel note) is the console line it has always been.
      if (consoleMdIsProse(seg.line.kind)) {
        if (!mdRun) mdRun = { lines: [], sep };
        mdRun.lines.push(seg.line);
        continue;
      }
      flushMd();
      parts.push(lineHtml(seg.line, "", sep));
      continue;
    }
    // The stored rows this group pairs from: what the earlier groups of THIS turn already consumed for that tool.
    flushMd();
    if (!run) run = { lines: [], sep: seg.sep, gofs: Object.fromEntries(storeSeen) };
    run.lines.push(...seg.lines);
  }
  flushMd();
  flushRun();
  return parts.join("");
}

// A run of the agent's own lines, drawn as the markdown it is (core/console-markdown.js). The console's lines
// arrive one per `<div>`, so a paragraph, a list and a fenced block have to be recognised ACROSS lines — the one
// place that knows how they group is that module, and this hands it a run and takes the markup back. `textOf`
// keeps the drawn stream honest: a line still being typed is drawn up to the words that may be shown now.
//
// `cards` is the turn's own scope and the page's open book, and it is what makes a command line in this turn's final
// message the same card the panes around the card draw (core/assistant-command.js, through the frame
// core/console-format.js publishes). The card is built there, never here: this file hands the run over and takes the
// markup back, and it holds no second builder of its own.
function mdRunHtml(lines, sep = "", cards = null, taskLink = null) {
  return consoleMdHtml(lines, { sep, ...(cards ? { cards } : {}), ...(taskLink ? { taskLink } : {}), textOf: (l) => typedShown(l) });
}

// The condensed card's console: one row per tool call (the burst, exactly as before), and the prose between the
// bursts as markdown blocks. Nothing about the tool-group markup moves; the run of prose around it is simply no
// longer one escaped line per marker.
// ---- thinking placeholder ----
// The console's empty state, from submit until the first real line lands. A genuinely RUNNING turn
// shows an active "🧠 thinking…" with a ticking clock instead of the passive "waiting for output…"
// that reads as a stall during the 10-30 s a reasoning model spends before its first token. The clock
// is a `data-live-from` span that tickLiveClocks() advances in place (no repaint per second);
// `data-wait="1"` is the marker drawJobLine() removes the moment the first console line is appended,
// so the placeholder never sits above output. Only running/starting claims to be thinking: a held
// (429/queued) or approval-parked turn has its own head wording and must not imply the model is
// working when it is not.
function emptyConsoleHtml(turn) {
  const status = String(turn?.status || "");
  const working = turnLive(turn) && (status === "running" || status === "starting");
  if (!working) return '<div class="jl jl-dim" data-wait="1">waiting for output…</div>';
  const from = Number(turn?.live?.startedAt) || Date.parse(turn?.startedAt || "") || Date.now();
  return `<div class="jl jl-dim" data-wait="1">🧠 thinking… <span class="jl-live" data-live-from="${from}">${liveSuffix(from)}</span></div>`;
}
// ---- end thinking placeholder ----

function condensedBodyHtml(turn, lines, busy, storeSeen, taskLink = null) {
  const parts = [];
  let run = null;
  const flush = () => {
    if (!run) return;
    parts.push(mdRunHtml(run, "", { scope: turn.id, open: state.codeBoxOpen }, taskLink));
    run = null;
  };
  burstGroups(lines).forEach((item, gi) => {
    if (item.group) {
      flush();
      const gofs = Object.fromEntries(storeSeen);
      for (const l of item.lines) {
        if (l.kind !== "tool-out") continue;
        const m = TOOL_DONE_RE.exec(String(l.text || ""));
        if (m) storeSeen.set(m[1], (storeSeen.get(m[1]) || 0) + 1);
      }
      // The reader's own answer to "count them, or one line each": with the tally off a burst is drawn as
      // the same run of rows the 🌊 console draws — no head row, no "all N" button, one press per call —
      // and the group keeps its two rules, its identity and its store offsets.
      parts.push(toolGroupHtml(item.lines, `${turn.id}#${gi}`, "", false, "", gofs, toolGroupsOn() ? {} : { flat: true }));
      return;
    }
    const l = item.line;
    const i = lines.indexOf(l);
    const live = i === busy ? `<span class="jl-live" data-live-from="${Number(l.at) || Date.now()}">${liveSuffix(Number(l.at) || Date.now())}</span>` : "";
    if (!live && consoleMdIsProse(l.kind)) {
      if (!run) run = [];
      run.push(l);
      return;
    }
    flush();
    parts.push(lineHtml(l, live));
  });
  flush();
  return parts.join("") || emptyConsoleHtml(turn);
}

// `thread` is the CARD's own thread, and it is the one identity the two switches on that card share: the 🧠 beside
// this body writes its answer under the card's thread, so the body must read the answer back from the same value.
// A turn's own `thread` can differ (an assistant's turns run under a session of their own) or be absent, which is
// why this is handed down from `conversationHtml` rather than guessed here.
// `taskLink` is the transcript's own resolver (see conversationTaskLink): the assistant's console can place a `#405`
// as an anchor into its queue row, and a card with no assistant's queue behind it leaves the text alone.
function turnBody(turn, copy = "", thread = turn.thread || turn.id, taskLink = null) {
  const all = jobLines(turn.id).filter((l) => !isBookkeeping(l));
  // A window, cut on a burst boundary rather than a line count: windowLines keeps the call line of the burst the
  // window would otherwise open inside, so that burst is still a group with a head row and a remembered state.
  const lines = windowLines(all);
  const running = turnLive(turn);
  // ONE stream, always: the card draws what the agent thought, said, called and got back in the order it
  // happened. There is no separate thinking block over a console any more - the reasoning is rows of this one.
  const stream = Boolean(globalThis.wtStream);
  // Which started tool call has no result yet. Parallel calls interleave, so count starts and
  // completions per tool name instead of assuming "the last line is the running one".
  const busy = running ? inflightToolIndex(lines) : -1;
  // Each burst pairs its result lines with the store's rows from ITS own offset: a turn can hold a patch burst, a
  // paragraph, then another patch burst, and the second one must start after the first one's rows.
  const storeSeen = new Map();
  const body = stream
    ? streamBodyHtml(turn, lines, lines.length < all.length, thread, taskLink)
    : condensedBodyHtml(turn, lines, busy, storeSeen, taskLink);
  // The body is the TURN'S, not the card's: the approval box and its record used to be the last two lines of this
  // return, which is why a folded turn drew neither (row #286). They are drawn by turnBlock now, in every shape.
  return (
    // `out-tab` carries the 18px left tab the console itself has, so the wrapper is the console's box: the chip
    // centred in the wrapper is centred in the console, not 9px off it.
    //
    // `out-box` holds exactly the console and its corner grip, and nothing else. That is what puts the grip ON the
    // console's corner: the grip is positioned against this box, so it rides the <pre>'s own bottom-right pixel, while
    // everything below it (the marching row, the two chips) belongs to the wrapper and cannot move it. The box is also
    // what the float's slack rule grows, so the grip is at the corner of the box the reader is pulling.
    //
    // The marching tail (console.js marchRowHtml) is a SIBLING of that box, drawn between it and the console's own
    // tools. That is the whole of its place: it is not a line of the record, so it cannot be ordered with one, cannot
    // be typed by the stream, and cannot change the console's height or scroll - and a repaint of the record cannot
    // take it away either, because it is not in the node the repaint replaces. It stays in the TEXT FLOW, a row under
    // the console, and is never pinned over the pane.
    `<div class="out-wrap out-tab" data-copy><div class="out-box"><pre class="job-out" data-out="${esc(turn.id)}${esc(copy)}">${body}</pre>${outGripHtml()}</div>${marchRowHtml(turn)}${consoleToolsHtml()}${toBottomBtnHtml()}</div>` +
    // The subagents this turn spawned, right under the console they ran beside: the delegation is the turn's own
    // work, not the card's, and a card with several turns would otherwise show the newest one's children under all
    // of them.
    turnSubagentsHtml(turn, copy)
  );
}

// A task id in the assistant's transcript is a reference into that assistant's queue (public/queue-cards.js), and the
// anchor is built by the console WHILE it renders (core/console-markdown.js) - never by a pass over the DOM after the
// fact, because this card is rebuilt on every repaint and a sweeper would have to run on every path that draws prose.
// Only the assistant's own card gets a resolver: the board's agent cards have no chat and no queue pane behind them,
// and a link that opens nothing is worse than the words it was written as. The resolver itself answers null for an id
// that no ONE loaded queue owns (or that two queues both own), which is what keeps a `#405` plain rather than guessed.
function conversationTaskLink(conv) {
  if (typeof assistantSessionFor !== "function" || !assistantSessionFor(conv?.thread)) return null;
  return typeof window.__assistantTaskLink === "function" ? window.__assistantTaskLink : null;
}

// The reader asked for ONE answer path and a card that does not vanish under them: a clarify question is not a detail
// of an OPEN console. It is drawn by the turn BLOCK, in every shape the turn takes - open, folded, or frozen to a
// snippet - because a question parked under a fold is exactly the row #277 defect: the header's badge went up, the
// turn output said nothing, and the reader answered from the outline instead of the card.
//
// `ask` is that block, rendered once by `conversationHtml` for the turn and handed in: one question, one block, in the
// one place the turn is drawn (the page copy, the pinned copy when the turn is off-page, or the card's off-page block).
//
// `park` is the APPROVAL's block and follows the same rule for the same reason (row #286). It used to be the last
// thing `turnBody` drew, and `turnBody` is called only for an open turn - so folding a turn that was waiting on a
// flagged command took the box away with the console, and the dock was the one surface still showing it. Whatever
// carries the console also carries the park: both blocks are the TURN's, not the open form's.
function turnBlock(conv, turn, index, copy = "", taskLink = null, ask = "", park = "") {
  const open = turnIsOpen(conv, turn, copy);
  const tkey = turnKey(turn, copy);
  // The rail down the turns' left edge is violet while a turn is executing, slate otherwise, so `is-running`
  // is the only state the CSS needs from here.
  const running = turnLive(turn);
  const compact = !open && state.turnCompact.has(tkey);
  // The Hot Agent search's ring, from STATE so a repaint keeps it: the card was rebuilt when the row opened, and a
  // class added to the element that stood here before would have gone with it. `until` closes the window on its own,
  // so a repaint after it can never ring the turn again.
  const rang = state.haHit && state.haHit.thread === conv.thread && state.haHit.id === turn.id && Date.now() < state.haHit.until ? " ha-hit" : "";
  const cls = `turn${open ? "" : " folded"}${compact ? " compact" : ""}${running ? " is-running" : ""}${rang}`;
  if (compact) {
    return `<div class="${cls}" data-turn="${esc(turn.id)}">${turnHead(turn, index, false, copy, true)}` +
      `${turnAttachmentsHtml(turn)}${compactHtml(turn, copy)}${park}${ask}${subagentsCompactHtml(turn, copy)}</div>`;
  }
  if (!open) {
    // Two rows: the head carries the request, the peek carries what the turn is doing or concluded - and a turn that
    // delegated something keeps saying so as it ages up the list, rather than handing its children to the newest turn.
    return `<div class="${cls}" data-turn="${esc(turn.id)}">${turnHead(turn, index, false, copy, true)}` +
      `${peekHtml(turn)}${park}${ask}${turnAttachmentsHtml(turn)}${subagentsCompactHtml(turn, copy)}</div>`;
  }
  return `<div class="${cls}" data-turn="${esc(turn.id)}">${turnHead(turn, index, true, copy, true)}` +
    // The request stays on the head line whether the turn is open or folded: it is the turn's title either
    // way, and the open form used to drop it onto its own row, which pushed the transcript down for nothing.
    `${turnAttachmentsHtml(turn)}${turnBody(turn, copy, conv.thread, taskLink)}${park}${ask}</div>`;
}
