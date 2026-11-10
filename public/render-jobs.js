// render-jobs.js - the job card and its turns: the body a turn draws, the block a turn sits in, the card itself,
// and the render and update path that keeps them on the page. Cut out of public/app.js.
//
// WHY THIS FILE EXISTS. public/app.js held 18,502 lines and one file was one lane: every streamed line, every
// card repaint and every turn fold landed in it. This is step 7 of the order of work in
// docs/reports/module-map-2026-11-07.html, the second of the two big cuts ("render-jobs.js ... job and turn cards:
// updateJob, appendJobLine, turn folding, the tool-call lines"), and it takes 861 lines line for line. Not one
// body was rewritten and not one call site was touched. The report names appendJobLine and drawJobLine under this
// row; both left app.js with the console in an earlier cut and live in public/board/console.js today.
//
// WHAT IS HERE
//
//   the turn's body        streamBodyHtml, mdRunHtml, condensedBodyHtml and turnBody: one flow of the panel's
//                          console lines, the reasoning blocks and each run of tool calls, drawn piece by piece so
//                          a live line only redraws the piece it belongs to
//   the turn's block       turnBlock: where one turn sits in its card, its head, its rail and the open or folded
//                          body
//   the card               conversationHtml, the card a thread draws: the head, its meta slots, the turns and the
//                          reply box; and jobHtml, the same card around one homeless run
//   the list and the       queueJobsRefresh and scheduleRenderJobs (the two coalesced repaints), renderJobs (the
//   update path            unattached list, its chips and its fold), paintAgentBadges (the row badge a job event
//                          moves), updateJob (one card replaced or repainted in place), conversationSignature (the
//                          signature that decides), paintCardMeta (the two slots that move without a rebuild) and
//                          renderConversation (one thread's card, rebuilt where it stands)
//
// WHAT IT REACHES OUT FOR (by name, at call time, exactly as before the move)
//
//   state, esc               the page's state literal and the escaper
//   the turn land            turnHead, conversations, turnKey and turnIsOpen (public/turns.js), turnLive,
//                            turnStateText, turnSubagentsHtml, turnAttachmentsHtml, approvalPrompt, questionPrompt,
//                            questionAnswered, approvalDecided, pipelineChipHtml, artifactRowsHtml
//   the console land         captureScrolls, restoreScrolls, applyStoredScrolls, settleScrolls,
//                            restoreThinkBodies, ensureToolStore, applyStoredHeight and the move bracket in
//                            public/board/console.js; captureCardSelection, restoreCardSelection and selectionIn in
//                            public/dom.js
//   the card's own wiring    statsRowHtml, subagentsHtml, ghostTurnHtml, addAgentBarHtml, restoreReplyDraft,
//                            captureTyping, restoreTyping, applyPendingFocus (public/settings.js), humanRefocus,
//                            paintHumanButton, reorderProjects (public/render-projects.js), fmtAgo, relTime
//
// THE LOAD CONTRACT. public/index.html loads CLASSIC scripts, so the page is one global scope: a top-level
// `function` here is a window property and a top-level `let` is a binding every other script reads by bare name.
// This file DECLARES ONLY: no top-level statement, no listener and no read of an app.js binding while it loads
// (jobsRefreshQueued and renderJobsQueued are literal initialisers), so being loaded before app.js costs nothing.
// public/app.js re-exports these names on window.WMApp.jobs.

// ---- one stream: the turn's own body, drawn in its order ---------------------------------------------------------
// Everything a card keeps apart, in one flow: the panel's console lines, the reasoning blocks (placed by
// core/stream-merge.js — see why its comment is the authority on where a block goes), and each RUN of tool calls drawn
// as the reader asked for it — one row per call inside two rules, with what each call returned one click under its row.
//
// The drift is drawn piece by piece on purpose (wtStream.pieces): a live line then only ever redraws the piece it
// belongs to, so a reader's selection in an earlier paragraph survives the turn growing under it. A run of call pieces
// is the exception the group IS: those pieces are collected into one group node, which is what "a rule above and a
// rule below the group" means.
function streamBodyHtml(turn, lines, windowFull = false, thread = turn.thread || turn.id) {
  const W = globalThis.wtStream;
  if (!W || typeof W.merge !== "function" || typeof W.pieces !== "function") return "";
  // Reasoning joins the stream only while the 🧠 is on: with it off, the console's own one-line preview is the only
  // trace of what the agent thought, exactly as in the condensed view.
  const blocks = thinkingOn(thread) ? state.thinkCache.get(turn.id)?.blocks || [] : [];
  // Reasoning joins the console as lines keyed `think:<at>`; feeding them to the pacer HERE, where the turn's own
  // clock is at hand, is what makes lineHtml type them out exactly like prose.
  if (blocks.length) for (const b of blocks) paceThinkBlock(turn, b);
  const merged = W.merge(lines, blocks, { windowFull, hidePreviews: blocks.length > 0 });
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
    parts.push(mdRunHtml(mdRun.lines, mdRun.sep));
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
// keeps the word pacer honest: a line still being typed is drawn up to the words that may be shown now.
function mdRunHtml(lines, sep = "") {
  return consoleMdHtml(lines, { sep, textOf: (l) => typedShown(l) });
}

// The condensed card's console: one row per tool call (the burst, exactly as before), and the prose between the
// bursts as markdown blocks. Nothing about the tool-group markup moves; the run of prose around it is simply no
// longer one escaped line per marker.
function condensedBodyHtml(turn, lines, busy, storeSeen) {
  const parts = [];
  let run = null;
  const flush = () => {
    if (!run) return;
    parts.push(mdRunHtml(run));
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
  return parts.join("") || '<div class="jl jl-dim" data-wait="1">waiting for output…</div>';
}

// `thread` is the CARD's own thread, and it is the one identity the two switches on that card share: the 🧠 beside
// this body writes its answer under the card's thread, so the body must read the answer back from the same value.
// A turn's own `thread` can differ (an assistant's turns run under a session of their own) or be absent, which is
// why this is handed down from `conversationHtml` rather than guessed here.
function turnBody(turn, copy = "", thread = turn.thread || turn.id) {
  const all = jobLines(turn.id).filter((l) => !isBookkeeping(l));
  // A window, cut on a burst boundary rather than a line count: windowLines keeps the call line of the burst the
  // window would otherwise open inside, so that burst is still a group with a head row and a remembered state.
  const lines = windowLines(all);
  const running = turnLive(turn);
  // The 🌊: this card draws ONE stream, so the reasoning is not a block above the console — it is in it.
  const stream = streamOn(thread) && Boolean(globalThis.wtStream);
  // Which started tool call has no result yet. Parallel calls interleave, so count starts and
  // completions per tool name instead of assuming "the last line is the running one".
  const busy = running ? inflightToolIndex(lines) : -1;
  // Each burst pairs its result lines with the store's rows from ITS own offset: a turn can hold a patch burst, a
  // paragraph, then another patch burst, and the second one must start after the first one's rows.
  const storeSeen = new Map();
  const body = stream
    ? streamBodyHtml(turn, lines, lines.length < all.length, thread)
    : condensedBodyHtml(turn, lines, busy, storeSeen);
  return (stream ? "" : thinkHtml(turn, copy, thread)) +
    // `out-tab` carries the 18px left tab the console itself has, so the wrapper is the console's box: the chip
    // centred in the wrapper is centred in the console, not 9px off it.
    `<div class="out-wrap out-tab" data-copy><pre class="job-out" data-out="${esc(turn.id)}${esc(copy)}">${body}</pre>${consoleToolsHtml()}${toBottomBtnHtml()}</div>` +
    // The subagents this turn spawned, right under the console they ran beside: the delegation is the turn's own
    // work, not the card's, and a card with several turns would otherwise show the newest one's children under all
    // of them.
    turnSubagentsHtml(turn, copy) +
    approvalPrompt(turn, copy) + approvalDecided(turn) +
    questionPrompt(turn, copy) + questionAnswered(turn);
}

function turnBlock(conv, turn, index, copy = "") {
  const open = turnIsOpen(conv, turn, copy);
  const tkey = turnKey(turn, copy);
  // The rail down the turns' left edge is violet while a turn is executing, slate otherwise, so `is-running`
  // is the only state the CSS needs from here.
  const running = turnLive(turn);
  const compact = !open && state.turnCompact.has(tkey);
  const cls = `turn${open ? "" : " folded"}${compact ? " compact" : ""}${running ? " is-running" : ""}`;
  if (compact) {
    return `<div class="${cls}" data-turn="${esc(turn.id)}">${turnHead(turn, index, false, copy, true)}` +
      `${turnAttachmentsHtml(turn)}${compactHtml(turn, copy)}${subagentsCompactHtml(turn, copy)}</div>`;
  }
  if (!open) {
    // Two rows: the head carries the request, the peek carries what the turn is doing or concluded - and a turn that
    // delegated something keeps saying so as it ages up the list, rather than handing its children to the newest turn.
    return `<div class="${cls}" data-turn="${esc(turn.id)}">${turnHead(turn, index, false, copy, true)}` +
      `${peekHtml(turn)}${turnAttachmentsHtml(turn)}${subagentsCompactHtml(turn, copy)}</div>`;
  }
  return `<div class="${cls}" data-turn="${esc(turn.id)}">${turnHead(turn, index, true, copy, true)}` +
    // The request stays on the head line whether the turn is open or folded: it is the turn's title either
    // way, and the open form used to drop it onto its own row, which pushed the transcript down for nothing.
    `${turnAttachmentsHtml(turn)}${turnBody(turn, copy, conv.thread)}</div>`;
}

function conversationHtml(conv) {
  const { thread, turns, latest } = conv;
  const collapsed = state.collapsedJobs.has(thread);
  const maximized = state.maximized === thread;
  const homeless = isHomelessConv(conv);
  const runningTurn = turns.find(turnLive);
  // A steer that missed its turn is offered back as an unsent draft: seed the box once, so the reader can send it,
  // edit it, or ignore it. Seeding is keyed on the steer itself, so a re-render cannot refill a box they cleared.
  const pendingSteer = latest.pendingSteer && typeof latest.pendingSteer.text === "string" ? latest.pendingSteer : null;
  if (pendingSteer) {
    const key = `${thread}|${pendingSteer.at || 0}`;
    const seeded = state.seededSteer || (state.seededSteer = new Set());
    if (!state.replyDrafts[thread] && !seeded.has(key)) {
      seeded.add(key);
      state.replyDrafts[thread] = pendingSteer.text;
    }
  }
  // Steering while the agent sits inside delegate_task waits for that call to return. Say so at the moment it
  // matters, instead of promising a boundary the turn may never reach.
  const inDelegate = runningTurn ? inflightToolName(jobLines(runningTurn.id)) === "delegate_task" : false;
  const running = Boolean(runningTurn);
  // The Steer control's own question, asked once from the predicate the ROUTE refuses with (public/core/steerable.js,
  // carried on every job summary as `steerable`): a turn parked on an approval, past its last tool boundary, or one
  // whose run the gateway no longer has is live but not steerable, and must not offer a press the gateway refuses.
  const steerTurnFor = turns.find((t) => turnLive(t) && t.steerable?.ok) || null;
  const canSteer = Boolean(steerTurnFor);
  // The second reason Queue reply is offered: the turn is over but the subagents it started are still out. Asked
  // once here, because the placeholder, both button titles and the button itself all have to agree on it.
  const childrenStillOut = childrenOut(thread);
  const queue = state.replyQueue.get(thread) || [];
  const queued = queue.length;
  const queuedTitle = queue.map((q, i) => `${i + 1}. ${q.text}`).join("\n");
  // A turn can end while the children it delegated are still working. The card's state is what is happening, not what
  // the parent's turn did, so RUNNING outlives the turn for as long as something it started is still going.
  const liveSubs =
    turns.flatMap((t) => t.subagents || []).some((s) => s.running) ||
    (subagentFallback.get(thread) || []).some((s) => s.running);
  const runningNow = running || liveSubs;
  // A pending approval for this conversation means the agent is not thinking, it is waiting on you.
  const waitingApproval = [...state.approvals.values()].find((a) => a && a.thread && a.thread === thread) || null;
  // A run parks its own approval inside the turn (the Runs API path): same message, different
  // carrier, so the card can answer it without the CLI approval plugin. An approval whose window has closed is
  // not a signal any more — the gateway denied the command on its own and the box below says so.
  const runApprovalRaw = runningTurn?.approval || latest.approval || null;
  const runApproval = approvalLive(runApprovalRaw) ? runApprovalRaw : null;
  // …and the same for the agent's own question: the head says the agent is waiting on an ANSWER, which is
  // a different act from allowing a command, so it gets its own chip in the light purple.
  const runQuestion = runningTurn?.question || latest.question || null;
  // The session's own name is the card's title, and it is set like the revive row's: bold, with how long ago
  // the thread was last used in the same dimmed grey next to it. The cwd only appears when a session has no
  // name at all.
  const titleHtml = latest.title
    ? `<span class="job-title mono" title="${esc(latest.title)}">${esc(latest.title)}</span>`
    : "";
  // How stale the thread is, right after the state it belongs to: "NOT-RUNNING · 2m ago" reads as one fact,
  // while the same counter trailing a long session name sat far from the thing it describes.
  const whenHtml = latest.lastActiveAt
    ? `<span class="job-when mono" data-when="${esc(thread)}" title="last used ${esc(new Date(latest.lastActiveAt).toLocaleString())}">${esc(fmtAgo(latest.lastActiveAt))}</span>`
    : "";
  // Where this agent is actually working — the top of every card, one quiet line. A card is re-read to
  // answer "which tree is this one in", and that fact used to appear only on a card whose session never
  // got a title. Only the last segments are drawn; the full path, and the row this agent is filed under
  // when that is a different folder, are in the tooltip.
  const cwdHere = normPath(latest.cwd);
  const cwdRow = normPath(latest.ownerPath);
  const cwdLine = cwdHere || cwdRow;
  const cwdTitle = [
    cwdHere ? `working directory: ${cwdHere}` : null,
    cwdRow && cwdRow !== cwdHere ? `worktree row: ${cwdRow}` : null,
    latest.worktree ? `worktree: ${latest.worktree}` : null,
  ].filter(Boolean).join("\n");
  // The run id is bookkeeping, but it is the id the reader quotes back to the gateway, and a row of its own
  // cost a line of chrome for eight characters. It rides the cwd line now, beside the path it belongs to.
  const runIdShort = latest.runId ? String(latest.runId).replace(/^run_/, "").slice(0, 8) : "";
  // Why a card is in the unattached panel, said in the card's own terms. "no worktree" is false for a card whose
  // cwd is `.worktrees/<name>`: the tree is right there in the path, and the board either has a row for it (the
  // card is simply not attached) or has not read it yet. Name the project and the tree in the head's 12 px text,
  // instead of leaving the only visible tree fact to the cwd line's 10.5 px path tail and its title attribute.
  // The head stays path-derived on purpose: the first card paint can beat the scan, and a "not read" that was true
  // then would sit there after the row arrived. The picker, built on the press, is where the live read state is said.
  const cwdTree = worktreeRootOf(cwdHere);
  const cwdTreeName = cwdTree ? cwdTree.split("/").pop() : "";
  const cwdTreeProject = cwdTree ? projectOfTree(cwdTree) : "";
  const whyHomeless = latest.ownerPath
    ? `owner ${latest.ownerPath} (not in the scan)`
    : cwdTree
      ? `worktree ${cwdTreeName}${cwdTreeProject ? ` · ${cwdTreeProject}` : ""}`
      : "no worktree";
  // The head's meta line is built after the cwd line because the run id now lives there — it stays on this
  // line only for a card with no cwd line to draw it on.
  const meta = [
    // cwd is no longer listed here: it has its own line under the card's head, on every card, titled
    // or not.
    // Why this card is in the unattached panel: the answer is the `whyHomeless` fact built above.
    homeless ? whyHomeless : null,
    // With usage figures present the model leads that strip instead (it is what the numbers belong to);
    // without them this line is the only place it can appear.
    latest.stats ? null : latest.model ? `model ${latest.model}` : "(default model)",
    // The project the tree was cut from, where the bare word "worktree" used to stand — every card in this
    // row is one, so the word says nothing and the repository is what the reader cannot see. A tree path
    // that resolves no project keeps the bare word.
    latest.worktree
      ? `${projectOfTree(latest.worktreePath || latest.ownerPath || latest.cwd) || "worktree"} ${latest.worktree}`
      : null,
    latest.baseCheckout ? "in the project checkout (no worktree)" : latest.existing ? "in existing worktree" : null,
    turns.length > 1 ? `${turns.length} turns` : null,
    // …and the run id stays on this line only for the card with no cwd line to put it on.
    runIdShort && !cwdLine ? `run ${runIdShort}` : null,
  ].filter(Boolean).join(" · ");
  // The card's two rows, built once because every card — expanded or minimized — draws them the same way: the head
  // carries the state and the card's own controls, and the cwd line carries where the agent runs, the session's name
  // and the pencil that renames it. The five head controls are ONE block pinned to the head's right edge, so nothing on
  // the left can push them onto a line of their own (that is what a long name used to do); the name is the cwd line's
  // right-hand item with the pencil immediately after it, so the label and the control that edits it read as one pair,
  // and the name is the only thing on that line that gives up width. A card with no cwd line has nowhere else to put
  // the name, so that one keeps name, pencil and controls together in the head.
  const threadNameHtml = `<span class="mono dimmer thread-name" data-thread-name="${esc(thread)}" data-label="${esc(latest.label || "")}" title="${latest.label ? esc(`${latest.label} — Hermes thread ${thread}`) : "Hermes session thread — continue it any time"}">${esc(latest.label || thread)}</span>`;
  // The pencil rides the cwd line, immediately after the name (see cwdHtml below): the head's control block keeps the
  // other five. Same button, same delegated press — only its place in the card moved.
  const renameBtnHtml = `<button class="btn-rename" data-rename-thread="${esc(thread)}" type="button" title="rename this session — a label for the panel only; the Hermes thread id never changes">\u270e</button>`;
  const cardActionsHtml =
    `<span class="job-actions">` +
    `<button class="btn-pin${state.anchorThread === thread ? " is-on" : ""}" data-pin-thread="${esc(thread)}" type="button" title="${state.anchorThread === thread ? "this card holds its place while anything above it grows — click to release" : "pin this card: hold its place on screen while other cards above it grow (one pin at a time)"}">\u{1F4CC}</button>` +
    `<button class="btn-think${thinkingOn(thread) ? " is-on" : ""}" data-think-thread="${esc(thread)}" type="button" title="${thinkingOn(thread) ? "showing this session's reasoning — open live while a turn runs, folded afterwards. click to hide it" : "show this session's reasoning: live and open while a turn runs, folded per turn afterwards (read from the session store)"}">🧠</button>` +
    // The wave is drawn only while the Cards-tab switch is on: absent by default, and the switch owns that answer for
    // every card (Settings > Wave button).
    (showStreamButton() ? `<button class="btn-stream${streamOn(thread) ? " is-on" : ""}" data-stream-thread="${esc(thread)}" type="button" aria-pressed="${streamOn(thread) ? "true" : "false"}" title="${streamOn(thread) ? "this session is drawn as ONE stream — reasoning, tool calls, their output and the agent's own words in the order they happened, with no burst to open; each result is still the shut box it is everywhere else. click to go back to the separate thinking block and the condensed tool groups" : "draw this session as ONE stream: what the agent thought, said, called and got back, in the order it happened, with no burst to open — each result is still the shut box it is everywhere else, so a call's output is one click away (reasoning joins it while 🧠 is on; subagents keep their own strip)"}">🌊</button>` : "") +
    `<button class="btn-max" data-max-thread="${esc(thread)}" type="button" title="${maximized ? "shrink this chat back into the list (Esc)" : "expand this chat to fill the window (Esc to close)"}">${maximized ? "\u2921" : "\u2922"}</button>` +
    `<button class="btn-clear-thread" data-clear-thread="${esc(thread)}" type="button" title="forget this agent session — removes its turns and transcript from the panel (the worktree it made stays on disk)">✕</button>` +
    `</span>`;
  const cwdHtml = cwdLine
    ? `<div class="job-cwd" title="${esc(cwdTitle)}">` +
      `<span class="cwd-label">cwd</span>` +
      `<span class="cwd-path mono">${esc(tailPath(cwdLine))}</span>` +
      (runIdShort
        ? `<span class="cwd-run mono" title="the gateway run this card is attached to — ${esc(latest.runId)}">run ${esc(runIdShort)}</span>`
        : "") +
      (cwdRow && cwdHere && cwdRow !== cwdHere
        ? `<span class="cwd-row mono" title="the worktree row this agent is filed under">row ${esc(tailPath(cwdRow, 2))}</span>`
        : "") +
      threadNameHtml +
      renameBtnHtml +
      "</div>"
    : "";
  // A run has no process to exit. The pool maps run status onto 0/1 so the old CLI card keeps
  // rendering, but printing "exit 0" for it reads as if a child process came and went — answer
  // "what happened" instead. A legacy CLI turn still has a real exit code worth showing.
  const outcome = latest.runId
    ? `${latest.status}${latest.exitCode && latest.exitCode !== 0 ? ` · exit ${latest.exitCode}` : ""}`
    : `exit ${latest.exitCode ?? "?"}`;
  // No clock here while a turn runs: the turn head already says "turn 2 - running 12s", and a second
  // counter a few lines above the reply box only pushed the box down.
  const foot = turnLive(latest)
    ? ""
    : latest.revived
      // Rebuilt from the gateway's session store, so there was never a process here: "exit ?" and
      // "0s" would both describe a run that did not happen in this panel. Say when it was last used.
      ? `<span class="mono dim">revived · last active ${esc(relTime(latest.startedAt))} ago</span>`
      : `<span class="mono dim">${esc(outcome)} · ${esc(elapsed(latest))}${latest.tokens?.total ? ` · tokens ${fmtTok(latest.tokens.total)}` : ""}${latest.error ? ` · ${esc(latest.error)}` : ""}</span>${turnRetryHtml(latest, thread)}`;
  const artifacts = artifactsFor(conv);
  const artSplit = splitArtifacts(artifacts);
  // The page this card is showing, sliced by the one module that owns the arithmetic. The pager's count, the arrows'
  // disabled ends and this strip are three readings of ONE range; they used to be three copies of the same sums.
  const blocks = (() => {
    const r = wtTurnFold.range(turns.length, wtTurnFold.offset(state, thread, turns.length));
    return { ...r, html: turns.slice(r.start, r.end).map((t, i) => turnBlock(conv, t, r.start + i)).join("") };
  })();
  const pages = blocks.pages;
  // Starred turns are repeated above the page — still accordions, and still present in their own
  // page, so pinning never moves a turn out from under its history.
  const pinned = turns.filter((t) => state.pinnedTurns.has(t.id));
  const pinnedHtml = pinned.length
    ? `<div class="pinned-turns">
        <div class="pinned-head mono"><span>\u2605 pinned</span><span class="dimmer">${pinned.length} of ${turns.length}</span></div>
        ${pinned.map((t) => turnBlock(conv, t, turns.indexOf(t), wtTurnFold.PIN)).join("")}
      </div>`
    : "";
  const pager = pages > 1
    ? `<span class="turn-pager" title="turns ${blocks.start + 1}–${blocks.end} of ${turns.length} — page through them here">` +
      `<button type="button" class="pager-btn" data-turn-page="older" data-thread-page="${esc(thread)}"${blocks.offset >= pages - 1 ? " disabled" : ""} title="older turns">\u25b2</button>` +
      `<button type="button" class="pager-btn" data-turn-page="newer" data-thread-page="${esc(thread)}"${blocks.offset === 0 ? " disabled" : ""} title="newer turns">\u25bc</button>` +
      `<span class="pager-n mono">${blocks.start + 1}–${blocks.end} / ${turns.length}</span>` +
      `</span>`
    : "";
  const jumped = state.jumpThread && state.jumpThread.thread === thread && Date.now() < state.jumpThread.until ? " jump" : "";
  const zoom = state.consoleZoom.get(thread);
  const sizeVars = zoom ? `--term-size:${zoom}px` : "";
  // The pill the reader already knows, for a card this panel has no line to. It still reads "not-running" — that is
  // the state, and the press is the same press: pick this up. What differs is behind the click. This one asks the
  // gateway about the run it lost BEFORE starting anything: still live -> the card re-attaches to that run and
  // steers it again; ended -> the run's own result is adopted; forgotten -> the card settles honestly and the thread
  // is continued, which is the pick-up that was asked for. It is only drawn while the run may still exist; once the
  // gateway has said it has no record of it (runGone) there is nothing left to ask, and the ordinary pill stands.
  const runMayStillExist = latest.status === "interrupted" && Boolean(latest.runId) && !latest.runGone;
  const detachedChip = runMayStillExist
    ? `<button type="button" class="pill pill-notrunning pill-reattach" data-reattach-job="${esc(latest.id || thread)}" title="${esc(
        `not running: this panel lost its line to run ${latest.runId}, which may still be going in the gateway — click to pick this up. Still live: the card re-attaches to that run and can steer it again. Ended: the run's result is adopted. Forgotten: the card settles as interrupted and this thread is continued.`,
      )}">not-running<span class="pill-again" aria-hidden="true">\u21bb</span></button>`
    : "";
  // A finished agent is not a stopped one, and the reader asked for the difference: when the card's latest turn is
  // exactly `done` the pill reads COMPLETE in the panel's green and carries no refresh glyph, because nothing here is
  // being resumed. Same pill, same place, same size — a word, a colour, and a press that queues one ask for the board
  // assistant instead of nudging the agent that already finished. Every other status keeps the pill it has today, word
  // for word: `failed` stays "exited", `cancelled`/`interrupted`/lost stay "not-running", and the re-attach pill's own
  // path is untouched.
  const completeChip = latest.status === "done"
    ? `<button type="button" class="pill pill-complete" data-complete-ask="${esc(latest.id || thread)}" title="${esc(
        `done · ${elapsed(latest)} — click to queue one ask for the board assistant: whether this really is complete (the commits, the PR, the report) and what has to happen next for this worktree. Nothing is sent to this agent.`,
      )}">complete</button>`
    : "";
  const hotFlash = state.hotFlash.thread === thread && Date.now() < state.hotFlash.until;
  return `<div class="job${collapsed ? " collapsed" : ""}${maximized ? " maximized" : ""}${jumped}${hotFlash ? " hot-flash" : ""}" data-thread="${esc(thread)}" data-id="${esc(thread)}" data-sig="${esc(conversationSignature(conv))}"${sizeVars ? ` style="${sizeVars}"` : ""}>
    <div class="job-head" data-toggle="${esc(thread)}" title="${collapsed ? "expand" : "minimize"} this conversation">
      <span class="agent-glyph" title="a Hermes agent session — ⧉ marks an agent row">\u29c9</span>
      <span class="chev">${collapsed ? "\u25b8" : "\u25be"}</span>
      ${runningNow
        ? `<span class="pill pill-running" title="${esc(running ? `running ${elapsed(latest)}` : `this turn is ${latest.status}, but subagents it started are still running`)}">running</span>`
        : completeChip ||
          detachedChip ||
          `<button class="pill pill-notrunning pill-continue${latest.status === "failed" ? " is-failed" : ""}" data-continue-thread="${esc(thread)}" type="button" title="${esc(
            `${latest.status} · ${elapsed(latest)}${latest.error ? ` · ${latest.error}` : ""} — click to send this agent "${CONTINUE_TEXT}" and start its next turn`,
          )}">${latest.status === "failed" ? "exited" : "not-running"}<span class="pill-again" aria-hidden="true">\u21bb</span></button>`}
      ${pipelineChipHtml(latest.pipeline)}
      ${livePulseHtml(latest)}
      ${whenHtml}
      ${waitingApproval ? `<button class="sig sig-approval" data-approval-jump="${esc(waitingApproval.id)}" title="this agent is blocked on an approval — click to answer it">waiting on you →</button>` : ""}
      ${runApproval && !waitingApproval ? `<span class="sig sig-approval" title="this run is parked on a flagged command — answer it in the card below">waiting on approval</span>` : ""}
      ${runQuestion ? `<button type="button" class="sig sig-question" data-question-jump="${esc(thread)}" title="the agent stopped to ask you something — click to jump to its question box">waiting on your answer →</button>` : ""}
      ${titleHtml}
      ${meta ? `<span class="mono dim">${esc(meta)}</span>` : ""}
      ${artSplit.files.length ? `<button type="button" class="btn-artifacts" data-artifacts="${esc(thread)}" data-artifacts-kind="file" title="${artSplit.files.length} file deliverable(s) from this agent — click to open in an editor, copy the path or delete the file">\u{1F4C4} ${artSplit.files.length}</button>` : ""}
      ${artSplit.urls.length ? `<button type="button" class="btn-artifacts" data-artifacts="${esc(thread)}" data-artifacts-kind="url" title="${artSplit.urls.length} URL(s) / endpoint(s) this agent printed — click to open one in your browser, copy it or remove it from the list">\u{1F517} ${artSplit.urls.length}</button>` : ""}
      ${pager}
      <span class="spacer"></span>
      ${latest.yolo ? '<span class="pill yolo" title="this run was started with the --yolo flag (auto-approve, no prompts). The panel does not send it: approvals still come to this card.">yolo</span>' : ""}
      ${homeless ? `<button class="btn-attach" data-attach-toggle="${esc(thread)}" type="button" title="attach this agent to a worktree — it then lives under that row">\u2935 attach</button>` : ""}
      ${cwdLine ? "" : threadNameHtml + renameBtnHtml}
      ${cardActionsHtml}
    </div>
    ${cwdHtml}
    ${collapsed ? `<div class="job-preview mono" data-preview="${esc(thread)}">${jobPreviewHtml(latest)}</div>` : ""}
    ${homeless ? `<div class="attach-row" data-attach-row="${esc(thread)}" hidden>
      <span class="dimmer mono">attach to</span>
      <select data-attach-path="${esc(thread)}"></select>
      <button class="btn-attach-go" data-attach-go="${esc(thread)}" type="button">Attach</button>
    </div>` : ""}
    ${artSplit.files.length ? artifactsPopHtml(thread, artSplit.files, state.openArtifacts.get(thread)?.kind !== "url" ? state.openArtifacts.get(thread) : null, "file") : ""}
    ${artSplit.urls.length ? artifactsPopHtml(thread, artSplit.urls, state.openArtifacts.get(thread)?.kind === "url" ? state.openArtifacts.get(thread) : null, "url") : ""}
    <div class="job-body">
      ${pinnedHtml}
      ${blocks.html}
      ${queued ? `<div class="ghost-turns">${queue
        .map((q) => ghostTurnHtml(thread, q, queuedEditFor(thread), !threadBusy(thread) && !childrenStillOut))
        .join("")}</div>` : ""}
      ${foot ? `<div class="job-foot">${foot}</div>` : ""}
      <div class="reply">
        <div class="reply-wrap">
          <div class="attach-chips" data-chips="${esc(thread)}">${attachmentChipsHtml(thread)}</div>
          <!-- A chip needs an inline atom, and a textarea cannot hold one: this box is contenteditable and
               the chip is a non-editable span inside it. Nothing changes for the reader — Enter, Ctrl+Enter,
               Shift+Enter, the ↑/↓ recall and the draft restore are the same gestures — and every reader of
               its text goes through readBox(box) (board/paste-chips.js), which gives a chip's own text back
               in place. The placeholder moved to data-ph, because :empty draws it on a div. -->
          <div class="reply-box chipbox" contenteditable="true" role="textbox" aria-multiline="true"
            data-1p-ignore data-bwignore data-lpignore="true" data-form-type="other" autocomplete="off"
            data-reply="${esc(thread)}" data-chipbox="reply:${esc(thread)}" data-rows="2" spellcheck="false"
            data-ph="${running
              ? (!canSteer
                // A live turn with no Steer press to offer: the box says what Enter does instead of promising a
                // gesture the card has taken away.
                ? (runningTurn?.steerable?.why === "parked"
                  ? "this turn is parked on an approval — Enter holds yours for the next turn"
                  : "this turn cannot take a steer right now — Enter holds yours for the next turn")
                : inDelegate
                  ? "a subagent is out — a steer lands when delegate_task returns; Enter holds yours for the next turn"
                  : "a turn is running — Ctrl+Enter steers it; Enter holds yours for the next turn")
              : childrenStillOut
                ? "this thread's subagents are still out — Enter holds yours until they finish"
                : "Reply to this agent — continues the same Hermes thread, Enter or Ctrl+Enter to send"}"></div>
          <div class="reply-actions">
            ${canSteer
              ? `<button class="btn-reply btn-steer-primary" data-steer="${esc(steerTurnFor.id)}" type="button" title="${inDelegate ? "send this into the running turn (Ctrl+Enter) — it waits for delegate_task to return, and if the turn ends first it comes back to this box unsent" : "send this into the running turn (Ctrl+Enter) — the agent reads it at its next tool boundary and the turn carries on"}">Steer turn</button>`
              : running
                // A live turn the gateway will not take a steer for right now — parked on an approval, past its last
                // tool boundary, or a run the gateway no longer has. No press at all: Queue reply holds text for the
                // next turn, and Cancel turn is the other thing this state can be given (docs/steer-refusal.md §2.2).
                ? ""
                : `<button class="btn-reply" data-thread="${esc(thread)}" type="button" title="${childrenStillOut ? "send this as the next turn now — the subagents this thread started are still out, and Enter holds it until they finish instead" : "send this as the next turn (Enter or Ctrl+Enter)"}">Send reply</button>`}
            ${running || childrenStillOut
              ? `<button class="btn-queue" data-queue-reply="${esc(thread)}" type="button" title="${running ? "hold this reply and send it the moment the current turn finishes (Enter)" : "hold this reply until the subagents this thread started have finished, so the parent is not talking over them (Enter)"}">Queue reply</button>`
              : ""}
            ${queued ? `<span class="queue-note mono" title="${esc(queuedTitle)}">${queued} queued</span>` : ""}
            ${running ? `<button class="btn-cancel" data-id="${esc(runningTurn.id)}" type="button" title="cancel the run this agent is in the middle of">Cancel turn</button>` : ""}
          </div>
        </div>
        <div class="job-stats-slot" data-stats="${esc(thread)}">${statsRowHtml(latest, thread)}</div>
        ${pendingSteer
          ? `<div class="reply-note mono" data-pending-steer="${esc(thread)}" title="the turn ended before the gateway could read your steer at a tool boundary. It is in the box above, unsent — send it to continue on the same thread.">⇢ that steer missed the turn — it is in the box, unsent</div>`
          : ""}
        <div class="reply-row">
          <span class="warnline" data-reply-warn="${esc(thread)}"></span>
        </div>
      </div>
    </div>
  </div>`;
}

function jobHtml(j) {
  return conversationHtml({ thread: j.thread || j.id, turns: [j], first: j, latest: j });
}

// Rebuilding the unattached list is cheap but not free; anything that makes several rows appear at
// once (a boot pass, a discovery sweep) should coalesce into one repaint.
let jobsRefreshQueued = false;
function queueJobsRefresh() {
  if (jobsRefreshQueued) return;
  jobsRefreshQueued = true;
  requestAnimationFrame(() => {
    jobsRefreshQueued = false;
    renderJobs();
  });
}

// Rebuilding every card is the most expensive thing this page does, and a burst of job events (a spawn
// fanning out, several agents finishing at once) used to trigger it several times per frame. Coalesce
// to one rebuild per animation frame — the work is identical, only the count changes.
let renderJobsQueued = false;
function scheduleRenderJobs() {
  if (renderJobsQueued) return;
  renderJobsQueued = true;
  requestAnimationFrame(() => {
    renderJobsQueued = false;
    renderJobs();
  });
}

function renderJobs() {
  // Only unattached agents live here now: anything created in a worktree is listed under that
  // worktree's row, so this panel is the "homeless" workspace (project-root runs, pending spawns,
  // agents whose worktree was removed).
  // The assistant's thread is a conversation but not a board agent: it is counted on neither side of
  // "unattached / in worktrees", and it is rendered only inside its floating panel.
  const boardConvs = conversations().filter((c) => !assistantSessionFor(c.thread));
  const convs = homelessConversations();
  const nested = boardConvs.length - convs.length;
  for (const id of [...state.collapsedJobs]) if (!conversations().some((c) => c.thread === id)) state.collapsedJobs.delete(id);
  // Forgetting a cleared job's explicit turn state keeps the map from growing forever — and the module owns which
  // keys belong to which turn (a pinned copy prunes on the turn it was cloned from) and a cleared thread's page.
  const live = new Set([...state.jobs.keys()]);
  const threads = new Set([...state.jobs.values()].map((j) => j.thread || j.id));
  wtTurnFold.prune(state, { turnIds: live, threads });
  // ...and for a height the reader dragged on a console whose turn has left the board. A turn's thread going away is
  // the same event (the thread's turns go with it), so the turn id is the key that decides.
  pruneOutHeights(live);
  // The list is rebuilt wholesale, so remember where every open transcript was and put it back:
  // a `jobs` event must not cost the reader their place in an agent they are reading.
  //
  // This panel sits ABOVE the board, so its height is in front of everything the reader is looking at: a wholesale
  // rebuild that changes it (or a page that shrinks under a reader parked at the bottom) clamps their scroll and the
  // content above is gone for good. Hold the page position across the rebuild, and hand the sweep an anchor so the
  // board below follows it like it does for every other render path.
  const pageY = window.scrollY;
  const anchor = captureBoardAnchor();
  // A snapshot merges every job in and asks for this list again even when nothing a card DRAWS has moved — and `#jobs`
  // is appended to by each run's own stream, so a card that is streaming holds lines no snapshot carries. Rebuilding
  // the list from that content replaces the card node for nothing: the console, the thinking block and the reader's
  // place in both come back as new nodes. So the markup is only written when the set of cards, or any card's own
  // signature, has moved. A card whose run is alive therefore keeps its node through a resync, and a card that is
  // genuinely dead changes signature (its status, its run, its ownership) and is rebuilt exactly as before.
  const listSig = `${convs.map((c) => `${c.thread}:${conversationSignature(c)}`).join("|")}#${convs.length}`;
  const sameList = listSig === state.jobsListSig && $("jobs").querySelectorAll(":scope > .job[data-thread]").length === convs.length;
  state.jobsListSig = listSig;
  if (!sameList) {
    // The list is rebuilt wholesale, so remember where every open transcript was and put it back:
    // a `jobs` event must not cost the reader their place in an agent they are reading.
    //
    // This panel sits ABOVE the board, so its height is in front of everything the reader is looking at: a wholesale
    // rebuild that changes it (or a page that shrinks under a reader parked at the bottom) clamps their scroll and the
    // content above is gone for good. Hold the page position across the rebuild, and hand the sweep an anchor so the
    // board below follows it like it does for every other render path.
    const prevScrolls = captureScrolls($("jobs"));
    // These cards are rebuilt from scratch, so a selection standing in one is recorded and put back on the new nodes.
    const heldSelection = captureCardSelection();
    // And so is the caret: without this, typing in an unattached card's reply box ended the moment anything about the
    // job list changed - the box was replaced under the reader and focus fell to the page.
    const typing = captureTyping($("jobs"));
    $("jobs").innerHTML = convs.length
      ? convs.map(conversationHtml).join("")
      : `<p class="empty">No unattached agents${nested ? ` — ${nested} agent${nested === 1 ? "" : "s"} listed under their worktree rows` : ""}.</p>`;
    restoreTyping($("jobs"), typing);
    // The panel above the board just changed height. This rebuild is one synchronous step, so a moved scroll is the
    // browser clamping the page (a shorter document pulls a reader parked at the bottom upward), never the reader
    // scrolling: put it back, then let the sweep hold the board's own anchor.
    if (window.scrollY !== pageY) {
      const maxY = Math.max(0, document.scrollingElement.scrollHeight - window.innerHeight);
      window.scrollTo({ top: Math.min(pageY, maxY) });
    }
    restoreScrolls($("jobs"), prevScrolls);
    applyStoredScrolls($("jobs"));
    restoreThinkBodies($("jobs"));
    for (const c of convs) restoreReplyDraft(c.thread);
    // After the drafts are back in their boxes, put the caret back in the one the reader was typing in - with
    // preventScroll, so a restore never drags the page to the box.
    restoreTyping($("jobs"), typing);
    restoreCardSelection(heldSelection);
    // Readers at the bottom stay at the bottom, readers scrolled up keep their line, and only genuinely new cards
    // jump to the newest output.
    restoreScrolls($("jobs"), prevScrolls);
    for (const c of convs) {
      if (state.collapsedJobs.has(c.thread)) continue;
      if (!prevScrolls.has(c.latest.id)) scrollThreadToBottom(c.thread);
    }
    // Their thinking blocks and any open picker have to be put back the way the row path does it: the blocks where the
    // reader had them, the picker under its control.
    settleScrolls($("jobs"));
  }
  scheduleBoardSweep(anchor);
  const running = convs.filter((c) => c.turns.some((t) => turnLive(t))).length;
  const folded = convs.filter((c) => state.collapsedJobs.has(c.thread)).length;
  const turns = [...state.jobs.values()].filter((j) => !assistantSessionFor(j.thread || j.id)).length;
  $("agents-chips").innerHTML =
    `<span class="chip">${convs.length} unattached</span>` +
    (nested ? `<span class="chip">${nested} in worktrees</span>` : "") +
    (turns > convs.length ? `<span class="chip">${turns} turns</span>` : "") +
    (running ? `<span class="chip warn">${running} running</span>` : "") +
    (folded ? `<span class="chip">${folded} minimized</span>` : "");
  const fold = $("btn-fold-jobs");
  if (fold) fold.textContent = convs.length && folded === convs.length ? "Expand all" : "Minimize all";
  paintAgentBadges();
  // A pending spawn target has to be re-applied here too — renderConversation bails out to renderJobs() whenever the
  // card did not exist yet.
  applyPendingFocus();
}

// Row badges ("⧉ 2 · 1 running") follow job events without rebuilding the table.
function paintAgentBadges() {
  for (const row of state.rows.values()) {
    const tr = document.querySelector(`tr.row[data-key="${CSS.escape(keyOf(row.project, row.path))}"]`);
    if (!tr) continue;
    // Inside the name cell's own flex row: appended to the <td> it lands after that row and drops onto a second
    // line, which made a row taller the moment an agent started in it.
    const cell = tr.querySelector("td.name > .name-line") || tr.querySelector("td.name");
    const existing = cell?.querySelector("[data-open-row]");
    const html = agentBadgeHtml(row);
    if (existing && !html) {
      existing.remove();
      continue;
    }
    if (!html) continue;
    if (existing) existing.outerHTML = html;
    else cell?.insertAdjacentHTML("beforeend", html);
  }
}

function updateJob(j, { scroll = false } = {}) {
  const prev = state.jobs.get(j.id);
  const statusChanged = !prev || prev.status !== j.status;
  // A parked approval appearing or being answered changes what the ROW badge and the project chip say,
  // and neither follows a status change (a run stays "running" through both). Without this the row kept
  // advertising "awaiting approval" after the question was answered.
  const approvalChanged =
    Boolean(prev?.approval) !== Boolean(j.approval) ||
    String(prev?.approvalDone?.choice || "") !== String(j.approvalDone?.choice || "") ||
    // An approval nobody answered replaces the box with a record line whose `choice` is empty on both sides, so
    // the expiry itself has to be compared or the card keeps the box it was just told to drop.
    Boolean(prev?.approvalDone?.expired) !== Boolean(j.approvalDone?.expired);
  const prevOwner = prev ? prev.ownerPath || null : null;
  const ownerChanged = (j.ownerPath || null) !== prevOwner;
  state.jobs.set(j.id, { ...prev, ...j });
  // No copy of `j.lines` into `state.jobLines` here: the record is what a turn without a buffer draws from
  // (`jobLines()`), and the only writer that needs a buffer of its own is `recordJobLine` — which seeds it from
  // this record for a turn that is still running. Copying it here retained the same 60 lines twice, once in the
  // record `/api/state` just delivered and once in the array nothing ever shrank.
  // A turn that has stopped has no more frames coming, so whatever either display buffer still holds is released:
  // a resumed, interrupted or failed run settles without a `result` line, and its card must not sit mid-paragraph.
  if (statusChanged && !turnLive(j)) flushTypeStream(j.id);
  renderConversation(j.thread || j.id, { scroll });
  // Starting or finishing a turn changes what the worktree rows should say about themselves.
  if (statusChanged || approvalChanged) {
    repaintAgentState();
    // A queued reply goes out as soon as this thread has nothing running any more.
    const t = j.thread || j.id;
    if (!threadBusy(t)) void drainReplyQueue(t);
  }
  // Ownership decides which container the card belongs to — the unattached list or a worktree's
  // agents block. Repaint both sides the moment it changes (a spawn that starts out owned, a `-w`
  // tree appearing, an attach), instead of leaving the card where it was until the next snapshot.
  if (ownerChanged) {
    invalidatePanelMap();
    scheduleRenderJobs();
    for (const from of new Set([prevOwner, j.ownerPath || null].filter(Boolean))) {
      const want = normPath(from).toLowerCase();
      const row = [...state.rows.values()].find((r) => normPath(r.path).toLowerCase() === want);
      if (!row) continue;
      renderProjectRows(row.project);
      refreshChips(row.project);
    }
    reorderProjects();
  }
  // Every turn change lands here, so this is where the HUMAN count is kept honest without waiting for the page's
  // clock: a question that arrived, or one the reader just answered, moves the number in the same repaint.
  paintHumanButton();
}

// What the card actually draws. If none of this changed, the DOM does not need rebuilding — and
// rebuilding is what used to throw the reader back to the top of a chat mid-read.
function conversationSignature(conv) {
  const turns = conv.turns
    .map((t) => `${t.id}:${t.status}:${t.exitCode ?? ""}:${t.error ? 1 : 0}:${(t.artifacts || []).length}`)
    .join(",");
  // A run's approval lives on the TURN (Runs API), not in state.approvals. Without it here, a prompt
  // arriving mid-turn changes nothing in the signature, so the card is not repainted and the approval
  // box only appears whenever some unrelated event forces a rebuild (observed: ~20 s later).
  const runApprovals = conv.turns
    .map((t) => `${t.id}:${t.approval ? t.approval.requestId || t.approval.command || 1 : 0}:${t.approvalDone ? t.approvalDone.choice || 1 : 0}`)
    .join(",");
  // The same for an agent's own question: without it here, a `clarify.request` landing mid-turn
  // changes nothing in the signature and the box only appears when some unrelated event repaints.
  const runQuestions = conv.turns
    .map((t) => `${t.id}:${t.question ? t.question.requestId || t.question.question?.slice(0, 40) || 1 : 0}:${t.question ? (t.question.choices || []).length : 0}:${t.questionDone ? (t.questionDone.answer || "closed").slice(0, 40) : 0}`)
    .join(",");
  // The re-attach pill's own input, for the same reason as the two above: the gateway answering 404 for a card's run
  // settles it — the promise becomes the settled wording and `runGone` goes up — while its status stays `interrupted`
  // and it still carries an error, so nothing else in this signature moves. Without it the pill sat on a card whose
  // run is provably gone until some unrelated event forced a rebuild.
  const runReattach = conv.turns.map((t) => `${t.id}:${t.runGone ? 1 : 0}`).join(",");
  // Whether each turn may offer its Steer control, and why not: the gateway's 409 (`past_boundary`) and a proven 404
  // (`gone`) change the verdict while the card's status word stays `running`, so without this the control the route
  // just refused stayed drawn until some unrelated event forced a rebuild.
  const runSteerable = conv.turns.map((t) => `${t.id}:${t.steerable?.ok ? 1 : 0}:${t.steerable?.why || ""}`).join(",");
  const open = [...state.turnOpen].map(([k, v]) => `${k}${v ? 1 : 0}`).join(",");
  const approvals = [...state.approvals.values()]
    .filter((a) => a && a.thread === conv.thread)
    .map((a) => a.id)
    .join("|");
  const l = conv.latest;
  // Which page of turns this card is showing: paging back must survive a repaint, and paging is a
  // structural change (different turn blocks), so it belongs in the signature.
  const pageOffset = state.turnPage.get(conv.thread) || 0;
  const pinned = conv.turns.filter((t) => state.pinnedTurns.has(t.id)).map((t) => t.id).join(",");
  return [
    conv.thread,
    turns,
    pageOffset,
    pinned,
    open,
    l.label || "",
    // The session's own name, which Hermes writes a moment after the first turn: a card created here can be
    // repainted by its title landing, so the title belongs in the signature even though nothing else changes.
    l.title || "",
    // l.lastActiveAt is NOT here: it moves with every event of a running turn, and rebuilding the whole card for
    // it destroyed the console under the reader several times a second - which is what made the scroll jump. It is
    // repainted in place by paintCardMeta().
    // Queued replies show as a note next to the buttons; a change must repaint the card.
    (state.replyQueue.get(conv.thread) || []).length,
    // The held reply the reader has open in the in-place editor, by its `at`: opening it swaps that entry's line for a
    // textarea and closing it puts the line back, so the card has to repaint on the open/close alone. The text being
    // typed is deliberately NOT here — a keystroke must not rebuild the card the reader is typing in.
    `e${queuedEditFor(conv.thread)?.at ?? ""}`,
    state.collapsedJobs.has(conv.thread) ? "c" : "o",
    state.maximized === conv.thread ? "m" : "-",
    // Whether the head draws the wave button at all (Settings > Agent cards > Wave button): the switch changes the
    // card's MARKUP, not its data, so without it here the card kept the head it was built with and the wave only
    // appeared on some later unrelated rebuild.
    showStreamButton() ? "w" : "-",
    isHomelessConv(conv) ? "h" : "-",
    approvals,
    runApprovals,
    runQuestions,
    runReattach,
    runSteerable,
    l.runId || "",
    l.cwd || "",
    // The row this agent is filed under: the card's cwd line falls back to it, so a change must repaint.
    l.ownerPath || "",
    l.model || "",
    l.yolo ? "y" : "",
    l.worktree || "",
    l.existing ? "e" : "",
    // l.tokens.total is NOT here: it changes with every event of a running turn, and each rebuild replaced the
    // card's buttons under the reader's cursor - which is what made an approval unclickable. The foot is repainted
    // in place (paintCardMeta) and a finished turn repaints anyway when its status changes.
    // A steer the turn never read comes back as a note in the reply area: without it here the card would not
    // repaint, and the note would only appear whenever something unrelated forced a rebuild.
    l.pendingSteer ? `s${l.pendingSteer.at || 1}` : "",
    conv.turns.map((x) => `${x.origin ? `o${x.id}` : ""}${x.collected ? "c" : ""}`).join(""),
    thinkingOn(conv.thread) ? "t" : "-",
    // …and the 🌊 beside it, for exactly that reason: `streamOn` decides which console renderer the card uses
    // (`turnBody` draws one stream or the condensed groups), so without a term here a press writes its choice to
    // localStorage, asks for a repaint, and the repaint concludes nothing changed — the card flips only when some
    // unrelated event moves this signature.
    streamOn(conv.thread) ? "s" : "-",
    // …and the tool-call shape for the same reason, one level up: `toolGroupsOn` decides whether a run of calls in
    // this card is the tallied group or one row each, so a press in Settings (which repaints every conversation)
    // would otherwise conclude nothing changed and leave the console in the shape it was drawn under.
    toolGroupsOn() ? "g" : "-",
    // A card stays RUNNING while children it delegated are out, so that answer belongs in the signature.
    (subagentFallback.get(conv.thread) || []).some((s) => s.running) ||
    conv.turns.some((t) => (t.subagents || []).some((s) => s.running))
      ? "r"
      : "-",
    // The stats row is repainted in place too: a new reading must update the numbers, but it must not rebuild
    // the console under them.
  ].join("~");
}

// The two things on a card that move without changing its markup: when it was last used, and its usage figures.
// Writing them where they stand is what keeps a streaming turn from rebuilding (and resetting) its own console.
function paintCardMeta(el, conv) {
  const latest = conv.latest;
  const when = el.querySelector("[data-when]");
  if (when) {
    const next = latest.lastActiveAt ? fmtAgo(latest.lastActiveAt) : "";
    if (when.textContent !== next) when.textContent = next;
    if (latest.lastActiveAt) when.title = `last used ${new Date(latest.lastActiveAt).toLocaleString()}`;
  }
  const slot = el.querySelector("[data-stats]");
  if (slot) {
    const html = statsRowHtml(latest, conv.thread);
    // The figures are the one part of a streaming card that rewrite themselves every poll, and a rewrite deletes
    // whatever the reader had selected in them: a full row selected and copied came back empty within a second.
    // Hold the markup while a selection stands inside it and let the first tick after they let go paint the current
    // numbers — a stale reading under a live selection is the honest trade, and it is the only one that keeps the
    // selection the reader just made.
    if (slot._html !== html && !selectionIn(slot)) {
      slot.innerHTML = html;
      slot._html = html;
    }
  }
}

function renderConversation(thread, { scroll = false, card = null } = {}) {
  const conv = conversations().find((c) => c.thread === thread);
  // A press that knows which card it came from repaints THAT card. Looking the thread up in the document can only
  // find one of two hosts, and the reader pressed in the other one.
  const el = card && card.isConnected ? card : document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
  if (!conv) return renderJobs();
  if (!el) {
    // The assistant's card lives in the floating panel, not in #jobs. Rebuilding the unattached list would
    // leave the float empty until some unrelated render, so paint that one card in its own host.
    if (assistantSessionFor(thread) && typeof window.__assistantRenderChat === "function") {
      window.__assistantRenderChat(thread);
      return;
    }
    return renderJobs();
  }
  const sig = conversationSignature(conv);
  if (el.dataset.sig === sig) {
    paintCardMeta(el, conv);
    return;
  }
  // Rebuild, then put the reader back exactly where they were: every output pane, the maximized
  // body, and the page itself. Following the newest output only happens when they were already at
  // the bottom (or when the caller explicitly asks for it, e.g. a freshly spawned turn).
  const prev = [...el.querySelectorAll("pre.job-out")].map((o) => ({
    id: o.dataset.out,
    top: o.scrollTop,
    atBottom: o._selfTop == null || o.scrollHeight - o.scrollTop - o.clientHeight < 32,
  }));
  const prevBody = el.querySelector(".job-body");
  const bodyTop = prevBody ? prevBody.scrollTop : 0;
  const bodyAtBottom = prevBody ? prevBody.scrollHeight - prevBody.scrollTop - prevBody.clientHeight < 32 : true;
  const pageY = window.scrollY;
  const typing = captureTyping(el);
  // A rebuild replaces the card node, which drops any selection standing in its readout; record it and put it back.
  const heldSelection = captureCardSelection();
  const holder = document.createElement("div");
  holder.innerHTML = conversationHtml(conv);
  const fresh = holder.firstElementChild;
  fresh.dataset.sig = sig;
  el.replaceWith(fresh);
  restoreThinkBodies(fresh);
  restoreTyping(fresh, typing);
  restoreCardSelection(heldSelection);
  if (window.scrollY !== pageY) {
    const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    window.scrollTo({ top: Math.min(pageY, maxY) });
  }
  for (const o of fresh.querySelectorAll("pre.job-out")) {
    // The box is new (the card was rebuilt), so the height the reader dragged it to goes back on before the follow /
    // restore below decides where its line is: both read clientHeight, and a 420 px box clamped as a 320 px one puts
    // the reader's line somewhere they never left it.
    applyStoredHeight(o);
    const was = prev.find((p) => p.id === o.dataset.out);
    const follow = scroll || consolePinned(o.dataset.out) || (was ? was.atBottom : conv.latest.status === "running");
    if (follow) setScroll(o, o.scrollHeight);
    else if (was) setScroll(o, Math.min(was.top, Math.max(0, o.scrollHeight - o.clientHeight)));
  }
  // The card node was replaced, so an open child console in its subagent strip is a fresh box at its first line: put
  // it back in this same task instead of leaving it to the 400 ms sweep.
  applySubConsoleScrolls(fresh, { follow: scroll });
  const body = fresh.querySelector(".job-body");
  if (body) {
    setScroll(body, bodyAtBottom ? body.scrollHeight : Math.min(bodyTop, Math.max(0, body.scrollHeight - body.clientHeight)));
  }
  settleScrolls(fresh);
  // A repaint replaces the card node, and the node that held the caret is gone with it — so a spawn
  // that asked for the reply box puts the caret back here, once the new card is in the document.
  applyPendingFocus();
  // …and a HUMAN hop whose row was still opening when it focused has the same problem: the box it landed on is
  // replaced a moment later. Put the ring and the caret back, scoped to the thread and the beat that asked for it.
  humanRefocus(thread);
}
