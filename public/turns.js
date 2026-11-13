// turns.js - the turn's own face: the list a card pages through, the head and its chips, the two ways a turn is
// drawn shut, and the two display switches that change what a turn shows. Cut out of public/app.js.
//
// WHY THIS FILE EXISTS. public/app.js held 22,000 lines and a third of the board's work landed in it, so one file
// was one lane. This is step 4 of the order of work in docs/reports/module-map-2026-11-07.html ("turns.js out of
// app.js. It carries the origin chips, which is the code the reader keeps asking about, so it is worth isolating"),
// moved line for line: not one body was rewritten and not one call site was touched.
//
// WHAT IS HERE
//
//   the list a card pages     conversations() groups the turns of one thread and orders them by the clock;
//   through                   turnOrder is that order, with the counter as the tiebreaker for one millisecond,
//                             and turnSeqOf is the number a turn is drawn under. The page itself, its offset and
//                             the arrows that move it, is public/core/turn-fold.js.
//   the fold book's names     turnKey, turnIsOpen and toggleTurn: the three names this renderer has always used,
//                             answered by public/core/turn-fold.js, which the assistant's own card reads too, so a
//                             turn cannot be open in one file's answer and shut in the other's.
//   the head's chips          the watchdog chip (isWatchdogTurn, watchdogHtml, watchdogPromptText), the origin
//                             chips (originHtml and originAttributionHtml: assistant reply, wake, spawn, row
//                             refresh, subagent delivery) and sessionReplacedHtml.
//   the head and its          turnHead, the inline prompt it carries (inlinePrompt, displayPrompt and the
//   shut forms                attachment paragraph it strips), turnAttachmentsHtml, and the two ways a turn is
//                             drawn shut: the peek (turnPeekLine, firstSentence, peekHtml, refreshTurnPeek) and
//                             the compact card (compactHtml).
//   the two display           the thinking switch (THINK_KEY, thinkDefault, thinkingOn, setThinking) and the one-
//   switches                  stream switch (STREAM_KEY, SHOW_STREAM_KEY, showStreamButton, streamDefault,
//                             streamOn, setStreamMode). Both are a per-session answer over a global default, both
//                             are read while a card renders, and neither does anything but write localStorage and
//                             ask the one thread it changed to repaint.
//
// WHAT IT REACHES OUT FOR (by name, at call time, exactly as before the move)
//
//   state                     conversations and turnSeqOf read state.jobs; turnKey, turnIsOpen and toggleTurn hand
//                             it to the fold book; turnHead reads state.pinnedTurns; turnPeekLine and compactHtml
//                             read state.jobLines.
//   esc                       every chip and every head this file builds.
//   CSS.escape                toggleTurn's console lookup and refreshTurnPeek's peek lookup.
//   setScroll                 toggleTurn puts a turn it just opened at its newest line.
//   turnLive, turnStateText   whether the head says running, and whether the peek shows the call in flight.
//   jobLines, isBookkeeping   the lines a folded turn is summarised from.
//   linkifyText               the compact card's last tool line and answer.
//   wtTurnFold                the fold book (public/core/turn-fold.js).
//   renderConversation        the two switches repaint the one card they changed, and the press hands it that card.
//
// THE LOAD CONTRACT. public/index.html loads CLASSIC scripts, so the page is one global scope: a top-level
// `function` here is a window property and a top-level `let` is a binding every other script reads by bare name.
// This file DECLARES ONLY: the consts here are literals and regexes, nothing reads an app.js binding while it
// loads, and neither switch is called until a card renders. public/app.js re-exports these names on
// window.WMApp.turns.

// ---- conversations ------------------------------------------------------------
// Every turn of one thread is a separate CLI process, but they are one conversation: group
// them so the card reads top to bottom and the reply box continues the same session.
// The order a thread's turns are drawn in: by the clock, with the counter as the tiebreaker for one millisecond.
// The collapse tiers name the newest turn through this same order, so "the turn drawn open" cannot drift from
// the one the card paints.
const turnOrder = (a, b) =>
  (Date.parse(a.startedAt || "") || 0) - (Date.parse(b.startedAt || "") || 0) || (a.turn || 0) - (b.turn || 0);

function conversations() {
  const groups = new Map();
  for (const j of state.jobs.values()) {
    const key = j.thread || j.id;
    const arr = groups.get(key) || [];
    arr.push(j);
    groups.set(key, arr);
  }
  const out = [];
  for (const [thread, turns] of groups) {
    // By the clock, not by `turn`. That counter is `siblings.length + 1` over the jobs KEEP_JOBS still holds, so
    // trimming old turns moves it BACKWARDS: the turn that resumed an interrupted thread got 7 while the dead turn
    // it replaced was still 8, and the card drew "turn 7 · running" ABOVE "turn 8 · interrupted" — running on top
    // of interrupted, which is exactly what a reader reads as a contradiction (measured live on 7473). The clock
    // only moves forward, so it orders the list; the counter is the tiebreaker for one millisecond.
    turns.sort(turnOrder);
    out.push({ thread, turns, first: turns[0], latest: turns[turns.length - 1] });
  }
  out.sort((a, b) => String(b.latest.startedAt).localeCompare(String(a.latest.startedAt)));
  return out;
}

// The number a turn is drawn under (see `turnHead`): its place in the thread by the clock. The one-second clock tick
// rewrites a running head's text in place, so it has to agree with the render or the label jumps a second later.
function turnSeqOf(j) {
  const turns = [...state.jobs.values()].filter((x) => (x.thread || x.id) === (j.thread || j.id));
  turns.sort(turnOrder);
  const i = turns.findIndex((x) => x.id === j.id);
  return i < 0 ? j.turn || "?" : i + 1;
}

// The fold book and the pager's arithmetic live in ONE place — public/core/turn-fold.js — because the assistant's
// own card reads and writes the same state (assistant.js), and two files spelling three books is how a turn ended up
// unfolded on a page that was not showing it. These two names are the ones this renderer has always used, so every
// call site below still reads the same; the answers behind them are the module's.
function turnKey(turn, copy = "") {
  return wtTurnFold.key(turn.id, copy);
}

// A turn is open when the reader opened it, otherwise only the newest turn is: opening an agent shows its current
// turn in full and lists the earlier ones as the single request line each. The pinned copy of a turn keeps its own
// open state (`pin:<id>`), so unfolding it never unfolds the original in the page — and a pinned turn starts folded.
function turnIsOpen(conv, turn, copy = "") {
  return wtTurnFold.isOpen(state, turn, conv.latest.id, copy);
}

function toggleTurn(key) {
  // The pinned duplicate toggles under its own key, so it opens and closes independently of the turn
  // it was cloned from.
  const turn = state.jobs.get(wtTurnFold.idOf(key));
  if (!turn) return;
  const conv = conversations().find((c) => c.thread === (turn.thread || turn.id));
  if (!conv) return;
  const copy = wtTurnFold.isPinCopy(key) ? wtTurnFold.PIN : "";
  const open = wtTurnFold.toggle(state, turn, conv.latest.id, copy);
  renderConversation(conv.thread);
  // A turn that was just opened should show its newest lines, not its first line.
  if (open) {
    const pre = document.querySelector(`pre[data-out="${CSS.escape(turn.id)}${copy}"]`);
    if (pre) setScroll(pre, pre.scrollHeight);
  }
}

// ---- turn origin ---------------------------------------------------------------------------
// `inline` puts the turn's request on the head line itself — the folded form is two rows: the head with
// the request, then one line saying what the turn is doing (or, once done, what it concluded).
// A turn the reader did not start: it answers a delivery, and the head should say which. One child names itself;
// several are listed in the tooltip, in the same order the collect prompt numbered them.
//
// The panel's watchdog starts a turn with its own announcement AS the prompt ("Watchdog: LONG RUN …"), so the
// head names the watchdog in a chip and the request under it drops the same two words. The chip is dark, not
// the purple an assistant's attribution wears: the panel reporting a run is not a reply in the conversation.
const WATCHDOG_PROMPT_PREFIX = "Watchdog: ";
const WATCHDOG_TITLE = "the panel's watchdog — a turn the sentry started when it found a run worth reporting";
function isWatchdogTurn(turn) {
  return Boolean(turn) && String(turn.prompt || "").startsWith(WATCHDOG_PROMPT_PREFIX);
}
// Same box as `.turn-origin` (size, radius, padding); only the colours differ, in public/style.css.
function watchdogHtml(turn) {
  if (!isWatchdogTurn(turn)) return "";
  return ` <span class="turn-origin is-watchdog mono" title="${esc(WATCHDOG_TITLE)}">watchdog</span>`;
}
// The prompt the head shows, minus the sentry's own opener: the chip already carries it, and repeating it costs
// the reader the first words of the request in a head that is one line long.
function watchdogPromptText(text) {
  const s = String(text || "");
  return s.startsWith(WATCHDOG_PROMPT_PREFIX) ? s.slice(WATCHDOG_PROMPT_PREFIX.length) : s;
}
// A turn another assistant's message started. The store writes its line as "message from <name>: <request>", so
// the head would spend its one line naming the sender; the chip carries the sender's own name instead, in the same
// purple box every assistant attribution wears, and the opener is dropped the way the watchdog's is. The tooltip
// names the sender and the thread the message was written on, so a head in the All view can be traced back to it.
const MESSAGE_PROMPT_OPENER = "message from ";
function messageOrigin(turn) {
  const o = turn && turn.origin;
  return o && o.kind === "assistant-message" ? o : null;
}
// The sender's own name; an origin recorded before the name was stored falls back to its id, never to "the assistant".
function messageSenderName(o) {
  return String(o.name || o.from || "another assistant");
}
function messageHtml(turn) {
  const o = messageOrigin(turn);
  if (!o) return "";
  const name = messageSenderName(o);
  const id = String(o.id || o.from || "");
  const thread = String(o.thread || turn.thread || "");
  const title = `started by a message from ${name}${id && id !== name ? ` (${id})` : ""}${thread ? ` on thread ${thread}` : ""}`;
  return ` <span class="turn-origin mono" title="${esc(title)}">${esc(name)}</span>`;
}
// The prompt the head shows, minus the sender's opener: the chip already carries the name, and the request is what
// the head's one line is for. Only a turn whose origin says a message started it is stripped, so a reader's own
// request that happens to begin with the same words keeps them.
function messagePromptText(text, turn) {
  const s = String(text || "");
  const o = messageOrigin(turn);
  if (!o) return s;
  const named = `${MESSAGE_PROMPT_OPENER}${messageSenderName(o)}: `;
  if (s.startsWith(named)) return s.slice(named.length);
  const m = /^message from [^:\n]+: /.exec(s);
  return m ? s.slice(m[0].length) : s;
}
// The head's chips, in the order they are drawn: who started the turn, then what the turn's own record adds.
function originHtml(turn) {
  if (!turn) return "";
  return watchdogHtml(turn) + originAttributionHtml(turn);
}
function originAttributionHtml(turn) {
  const o = turn.origin;
  // A message another assistant sent into this thread. Its own chip, before the kinds below, because the sender is
  // the answer to "who started this turn" — the same question the watchdog chip answers for the sentry.
  if (o && o.kind === "assistant-message") return messageHtml(turn);
  // A turn the panel assistant caused: it wrote a reply into this thread, or it woke itself about something.
  // Saying so on the turn head is the difference between "the agent suddenly changed course" and a move the
  // reader can trace back to the alert that prompted it.
  if (o && o.kind === "assistant-reply") {
    const how = o.by === "reader" ? "sent from the assistant panel" : "written by the assistant";
    return ` <span class="turn-origin mono" title="${esc(how)}${o.autonomy ? ` · autonomy: ${esc(o.autonomy)}` : ""}">\u21b3 ${esc(o.by === "reader" ? "from the assistant panel" : "from the assistant")}</span>`;
  }
  if (o && o.kind === "assistant-wake") {
    return ` <span class="turn-origin mono" title="${esc(o.reason || "the assistant woke itself")}">\u21b3 assistant woke itself</span>`;
  }
  if (o && o.kind === "assistant-spawn") {
    const where = o.project ? `a worktree cut in ${o.project}` : "a directory that already existed";
    // A SPAWN IN name that had to be resolved to a real tree: the panel says which one it picked here, because
    // a chip that only says "the assistant started this" hides the one fact that was in doubt.
    const fit = o.resolvedPath ? ` — ${o.resolvedFrom} had been renamed, resolved to ${o.resolvedPath} (${o.resolvedHow || "matched"})` : "";
    return ` <span class="turn-origin mono" title="${esc(where)}${esc(fit)}">\u21b3 started by the assistant</span>`;
  }
  if (o && o.kind === "row-refresh") {
    const what = Array.isArray(o.evidence) && o.evidence.length ? o.evidence.join(" · ") : "nothing that moved";
    return ` <span class="turn-origin mono" title="${esc(`started by the ⟳ on this worktree's row to double-check the TODO, the description and the merge state — what it found: ${what}`)}">\u21b3 from the row's ⟳</span>`;
  }
  if (!o || o.kind !== "subagent-delivery") return "";
  const subs = Array.isArray(o.subagents) ? o.subagents : [];
  const one = subs.length === 1 ? subs[0] : null;
  const list = subs.map((s) => `#${s.index} ${s.title || "(untitled)"}`).join("\n");
  const text = one ? `from subagent #${one.index} · ${one.title || "untitled"}` : `from ${subs.length} subagents`;
  const title = subs.length
    ? `this turn was started by the delivery of:\n${list}`
    : "this turn was started by a subagent delivery";
  return ` <span class="turn-origin mono" title="${esc(title)}">\u21b3 ${esc(text)}</span>`;
}
// ---- end turn origin -----------------------------------------------------------------------

// ---- session replaced ------------------------------------------------------------------------
// A turn the panel had to move into a NEW gateway session, because the session its thread was on had been lost: the
// gateway admitted the previous run and never executed it, so continuing that id would have queued for ever. The head
// says so — the answer under this turn is a cold start, not a continuation of the conversation above it, and a reader
// comparing the two needs to know which it is. Absent on every ordinary turn, warm retries included.
function sessionReplacedHtml(turn) {
  const r = turn && turn.sessionReplaced;
  if (!r) return "";
  const from = String(r.from || "");
  const to = String(r.to || "");
  if (!from || !to) return "";
  const why = String(r.why || "");
  const title = `the gateway lost session ${from}${why ? ` (${why})` : ""} — this turn starts ${to} in the same tree`;
  return ` <span class="turn-origin mono" data-session-replaced="${esc(from)}" title="${esc(title)}">\u21ba new session</span>`;
}
// ---- end session replaced --------------------------------------------------------------------

function turnHead(turn, index, open, copy = "", inline = false) {
  // The number the reader counts down the thread. Not `turn.turn`: that counter is trimmed with the store and can
  // repeat (a restarted board showed two "turn 6" and two "turn 7" in one card), while `index` is the turn's place in
  // the clock-ordered list that the pager already counts ("turns 5–7 of 7").
  const label = `turn ${index + 1}`;
  const pinned = state.pinnedTurns.has(turn.id);
  const state_ = turnStateText(turn);
  return `<div class="turn-head mono dimmer" data-turn-head="${esc(turn.id)}" data-toggle-turn="${esc(turnKey(turn, copy))}" title="${open ? "collapse" : "expand"} this turn"><button type="button" class="btn-star${pinned ? " on" : ""}" data-star-turn="${esc(turn.id)}" title="${pinned ? "unpin this turn" : "pin this turn above the paged turns"}">${pinned ? "\u2605" : "\u2606"}</button><span class="chev">${open ? "\u25be" : "\u25b8"}</span> <span class="turn-text">${esc(label)} · ${esc(state_)}</span>${originHtml(turn)}${sessionReplacedHtml(turn)}${inlinePrompt(turn, inline)}</div>`;
}

function inlinePrompt(turn, inline) {
  const text = inline ? displayPrompt(turn.prompt, turn) : "";
  if (!text) return "";
  return `<span class="turn-prompt-inline" title="${esc(text)}">${esc(text)}</span>`;
}

// One turn: its head, then either the full prompt + output, or a single line carrying the request
// that turn was about. The one-line form is what makes a long conversation readable.
// `copy` marks the pinned duplicate's transcript so it cannot collide with the paged one.
// The prompt the agent was given vs the prompt the card shows. Attachment paths are appended to the
// request as a paragraph of machine text — the agent needs them, the reader has the chips for them — so
// that paragraph is stripped before the prompt is drawn.
const ATTACH_BLOCK_RE = /(?:\r?\n){1,2}Attachment: [^\n]*? — (?:read_file it|use vision_analyze on it) before answering\./g;
function displayPrompt(text, turn = null) {
  return messagePromptText(watchdogPromptText(String(text || "").replace(ATTACH_BLOCK_RE, "")).trim(), turn).trim();
}

// What the reader attached to this turn, under its prompt: a link to the file, no x (the file is
// already part of this turn — removing it here would mean editing history the agent has seen).
function turnAttachmentsHtml(turn) {
  const list = Array.isArray(turn.attachments) ? turn.attachments : [];
  if (!list.length) return "";
  return `<div class="turn-attachments">${list
    .map(
      (a) =>
        `<button type="button" class="turn-attach mono" data-open-path="${esc(a.path)}" title="open ${esc(a.path)} in Notepad++">[${esc(a.name)}]</button>`,
    )
    .join("")}</div>`;
}

// ---- the assistant's command lines, as the tool card -----------------------------------------
// A reply ends with lines in the panel's own vocabulary, and public/core/assistant-command.js is the one reader of
// them: it answers with the same `.code-box` frame a tool's result is drawn in (public/core/console-format.js
// publishes it), with the body folded to two lines. DISPLAY ONLY - it reads the line a second time and never
// changes what the panel does with it, so a line whose title is malformed or absent draws exactly what it drew
// before this existed.
//
// The module is asked at call time, and a page without it draws the plain line: nothing here may be the reason a
// card comes back blank.
function commandCardHtml(line, key, open = state.codeBoxOpen) {
  const mod = globalThis.wtAssistantCommand;
  if (!mod || typeof mod.cardHtml !== "function") return "";
  return mod.cardHtml(line, { key, open });
}

// A block of text (a compacted answer) with every titled command line drawn as a card; "" when it holds none, so
// the caller keeps its own rendering untouched.
function commandCardsHtml(text, scope, open = state.codeBoxOpen) {
  const mod = globalThis.wtAssistantCommand;
  if (!mod || typeof mod.cardsHtml !== "function") return "";
  return mod.cardsHtml(text, { scope, open, renderText: (line) => `<div class="tc-line">${linkifyText(line)}</div>` });
}
// ---- end the assistant's command lines -------------------------------------------------------

// The answer a turn ended on: the first sentence of what the agent said AFTER its last tool call. Not the
// console, not the tool output, not the thinking — the line a reader would have kept.
function firstSentence(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  const m = /^(.{12,}?[.!?])(\s|$)/.exec(s);
  const out = m ? m[1] : s;
  return out.length > 220 ? `${out.slice(0, 217)}…` : out;
}

function turnPeekLine(turn) {
  const lines = state.jobLines.get(turn.id) || turn.lines || [];
  if (!lines.length) return null;
  const running = turnLive(turn);
  if (running) {
    // What it is doing right now: the newest tool CALL, drawn exactly as the console draws it. The
    // completion line ("↳ terminal") is skipped while a call exists — swapping to it for two seconds
    // read as the peek going backwards.
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (l && l.kind === "tool" && String(l.text || "").trim()) return { kind: "tool", text: String(l.text).trim() };
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (l && l.kind === "tool-out" && String(l.text || "").trim()) return { kind: "tool", text: String(l.text).trim() };
    }
    return null;
  }
  // Finished: the first sentence it said after its last tool call.
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const k = lines[i] && lines[i].kind;
    if (k === "tool" || k === "tool-out") { last = i; break; }
  }
  const after = lines
    .slice(last + 1)
    .filter((l) => l && l.kind === "text" && String(l.text || "").trim())
    .map((l) => String(l.text).trim())
    .join(" ");
  const said = firstSentence(after);
  if (said) return { kind: "answer", text: said };
  // A turn that ended on a tool still has an answer somewhere: fall back to its last words.
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l && l.kind === "text" && String(l.text || "").trim()) {
      return { kind: "answer", text: firstSentence(l.text) };
    }
  }
  return null;
}

// A compacted turn: what it concluded, and the last tool it used. Thinking blocks and the run of tool calls -
// usually several hundred pixels of scrollback the reader has already read - are dropped, not merely folded.
// A reply's command lines are drawn as cards here (see `commandCardHtml`): the tail of a folded turn is where a
// reader meets "QUEUE assistant-3 | Playwright test" long after the turn has ended, and one line of prose is the
// worst place to find it.
function compactHtml(turn, copy = "") {
  const lines = jobLines(turn.id).filter((l) => !isBookkeeping(l));
  let lastTool = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const k = lines[i] && lines[i].kind;
    if (k === "tool" || k === "tool-out") {
      lastTool = i;
      break;
    }
  }
  const texts = (from) =>
    lines
      .slice(from)
      .filter((l) => l && l.kind === "text" && String(l.text || "").trim())
      .map((l) => String(l.text).trim());
  // The answer is what it said after its last tool call; a turn that ended on a tool still has words somewhere.
  const said = texts(lastTool + 1);
  const answer = (said.length ? said : texts(0)).join("\n\n");
  const tool = lastTool >= 0 ? lines[lastTool] : null;
  const hidden = lines.filter((l) => l.kind === "tool" || l.kind === "tool-out" || l.kind === "dim").length;
  // The command cards the answer holds, line by line; "" when it holds none, which leaves the drawn answer exactly
  // as it was.
  const cards = commandCardsHtml(answer, `compact|${turn.id}${copy}`);
  return `<div class="turn-compact" data-compact-turn="${esc(turn.id)}${esc(copy)}">${
    tool ? `<div class="tc-tool mono" title="${esc(String(tool.text || ""))}">${linkifyText(String(tool.text || ""))}</div>` : ""
  }${answer ? `<div class="tc-answer">${cards || linkifyText(answer)}</div>` : ""}<div class="tc-more dimmer mono">${
    hidden ? `${hidden} tool line${hidden === 1 ? "" : "s"} folded` : "thinking folded"
  } · open for the whole turn</div></div>`;
}

function peekHtml(turn) {
  const peek = turnPeekLine(turn);
  if (!peek) return `<div class="turn-peek" data-peek-turn="${esc(turn.id)}" hidden></div>`;
  // A command line the turn ended on is drawn as its card: its title is what the reader is looking for, and the
  // one-line peek would cut it at the window's width.
  const card = commandCardHtml(peek.text, `peek|${turn.id}`);
  if (card) return `<div class="turn-peek is-command" data-peek-turn="${esc(turn.id)}" title="${esc(peek.text)}">${card}</div>`;
  return `<div class="turn-peek${peek.kind === "tool" ? " is-tool" : ""}" data-peek-turn="${esc(turn.id)}" title="${esc(peek.text)}">${esc(peek.text)}</div>`;
}

// A folded turn has no console on the page, so the peek is repainted by hand as its lines arrive.
function refreshTurnPeek(turn) {
  if (!turn || !turn.id) return;
  for (const el of document.querySelectorAll(`.turn-peek[data-peek-turn="${CSS.escape(turn.id)}"]`)) {
    const peek = turnPeekLine(turn);
    el.hidden = !peek;
    el.classList.toggle("is-tool", Boolean(peek && peek.kind === "tool"));
    const text = peek ? peek.text : "";
    const card = peek ? commandCardHtml(text, `peek|${turn.id}`) : "";
    el.classList.toggle("is-command", Boolean(card));
    // The card is redrawn only when the line behind it changed: a repaint of an unchanged card would take the
    // reader's focus off the head they just pressed (the fold itself is kept in the page's own book).
    if (card) {
      if (el.dataset.cmdText !== text) {
        el.innerHTML = card;
        el.dataset.cmdText = text;
      }
    } else {
      if (el.dataset.cmdText) {
        el.innerHTML = "";
        delete el.dataset.cmdText;
      }
      if (el.textContent !== text) el.textContent = text;
    }
    el.title = text;
  }
}

// ---- thinking -----------------------------------------------------------------------------
// What the agent thought before it acted. The runs stream only carries a 500-char preview (and not at all on the
// durable path), so this is read from the store per turn. It is a per-session preference with a global default:
// thinking is 1-2 KB per block, which is the whole point on one agent and noise across forty cards.
const THINK_KEY = "wtgui.think"; // global default, "1" when a card without its own answer should show thinking
function thinkDefault() {
  try {
    return localStorage.getItem(THINK_KEY) === "1";
  } catch {
    return false;
  }
}

function thinkingOn(thread) {
  try {
    const own = localStorage.getItem(`wtgui.think.${thread}`);
    if (own === "1") return true;
    if (own === "0") return false;
  } catch {
    /* private mode: fall through to the default */
  }
  return thinkDefault();
}

function setThinking(thread, on, card = null) {
  try {
    localStorage.setItem(`wtgui.think.${thread}`, on ? "1" : "0");
  } catch {
    /* the choice just will not persist */
  }
  // Repaint the card the press came from, not whatever card a lookup by thread finds first: a thread can be drawn
  // in more than one host (the float owns its assistants, the board owns the rest), and the reader's press must
  // change the card under the pointer.
  renderConversation(thread, { card });
}

// ---- one stream ------------------------------------------------------------------------------
// The 🌊 among the head's controls (while Settings > Agent cards > Wave button draws it): draw this session as ONE
// stream — what the agent thought, said, called and got back, in the
// order it happened, with no burst to open. What is NOT folded there is the run of calls itself: a result is still the
// shut box it is in the condensed view (core/console-format.js), so the stream is one flow of what happened rather
// than a wall of output. Per session like thinking, and with a global default like it too (Settings > Agent cards >
// Combined output): a card that never pressed the button follows that switch, and a card that did keeps its answer.
const STREAM_KEY = "wtgui.stream"; // global default, "1" when a card without its own answer should be drawn as one stream
// Whether a card DRAWS the wave button at all is a separate answer from what the button does: Settings > Agent cards >
// Wave button. Off by default — a card's head is the five controls that act on the card itself — and the answer is the
// browser's, so it survives a reload. Each card reads it while it renders, so the switch is the only save path.
const SHOW_STREAM_KEY = "wtgui.showStreamButton";

function showStreamButton() {
  try {
    return localStorage.getItem(SHOW_STREAM_KEY) === "1";
  } catch {
    /* private mode: off, which is the default anyway */
    return false;
  }
}

function streamDefault() {
  try {
    return localStorage.getItem(STREAM_KEY) === "1";
  } catch {
    /* private mode: off, which is the default anyway */
    return false;
  }
}

// NOT `setStream`. That name is already core/sse.js's connection label (the ● live / offline pill, called from
// there, from core/transport.js and from this file); it is a global in a classic script, so a function of the same
// name here would replace it for every caller and the status pill would stop moving.
function streamOn(thread) {
  try {
    const own = localStorage.getItem(`${STREAM_KEY}.${thread}`);
    if (own === "1") return true;
    if (own === "0") return false;
  } catch {
    /* private mode: fall through to the default */
  }
  return streamDefault();
}

function setStreamMode(thread, on) {
  try {
    localStorage.setItem(`${STREAM_KEY}.${thread}`, on ? "1" : "0");
  } catch {
    /* the choice just will not persist */
  }
  renderConversation(thread);
}
