// queue-cards.js - one assistant's task queue as a column of cards: the rows, the reader's order, the holds, the
// drag, and the reads and the one write path behind them. Cut out of public/assistant.js.
//
// WHY THIS FILE EXISTS. public/assistant.js held 6,090 lines and the queue sub-tab was the largest single surface in
// it: the row and its head, the chips that say what a row is waiting on, the agents under a task, the presses, the
// window that limits how many rows are drawn, and the gesture that reorders them. This is step 5 of the order of work
// in docs/reports/module-map-2026-11-07.html ("queue-cards.js out of app.js. It is the row surface the director
// reads, and separating it makes the queue work independent of project rendering"), moved line for line: not one body
// was rewritten and not one call site was touched.
//
// The report files this cut under public/app.js. The queue cards are not in app.js and never were: the surface the
// report describes (queue rows, drag order, holds rendering, the agent chip on a card) lives in public/assistant.js,
// inside the panel's own IIFE, and that is where it was cut from. Everything else the report says about the cut
// holds; only the file it named was wrong.
//
// WHAT IS HERE
//
//   the pane's state          the cache of one assistant's queue read, one read in flight per assistant and the
//                             sequence counter that keeps an old answer from painting over a new write, the job map
//                             behind the agent chips, the drag record, the window of rows drawn, and the one line a
//                             refused drop leaves.
//   the row                   queueTaskHtml: what the row is, its state in a word, and what it is waiting on (a lane
//                             head, a hold, a question, a skipped file, a stopped run), then the agents, the project
//                             and the PR on one facts line, and the tree, the files and the detail behind the row's
//                             own disclosure.
//   the chips                 the lane chip, the hold badge, the question chip and its alert lookup, the pipeline
//                             chip, the flow press, the project name, who filed the row, the agent chip and its
//                             re-attach press.
//   the order                 QUEUE_BUCKET, queueOrderOf and queueSorted: state bucket first, then the place a card
//                             was dragged to, then the id. queueDropBlocked is the rule a drop is judged by.
//   the reads and the write   renderAssistantQueue, loadQueue, loadQueueJobs and queueAct: the paint, the two reads,
//                             and the one POST every press on a row goes through.
//   the drag                  the pointer gesture: the 4 px threshold, the card that follows the pointer, the pane's
//                             own edge crawl, the drop, and the click the browser fires at the end of a drag.
//
// WHAT IT REACHES OUT FOR (by name, at call time, exactly as before the move)
//
//   the panel's own helpers   hostFor, sessionById, assistantIds, assistantThreadName, isAssistant, activeSessionId,
//                             typingInside, applyAssistant, asPost and setErr. These live inside public/assistant.js's
//                             IIFE, so they are handed in once, as this factory's argument (see THE LOAD CONTRACT).
//   esc, state                public/app.js's escaping and page state: the pane reads state.assistant and
//                             state.assistantView, and every row is built with esc.
//   apiFetch                  public/app.js's fetch wrapper, for the two reads.
//
// THE LOAD CONTRACT. public/assistant.js is an IIFE, so its helpers are not page-wide names and a plain classic script
// could not reach them. This file therefore declares ONE thing: a factory. The panel calls it once, when it loads
// (public/index.html loads this file before assistant.js), hands its helpers in, and gets the queue's names back
// under exactly the spellings the call sites already use, so no call site changed. Nothing here reads an app.js
// binding while it loads: the factory only builds maps and declares functions, and every outward name is read when a
// pane paints or a press lands. The panel keeps the press listeners that run at its own load, because those must keep
// the order they had beside the panel's other handlers.

window.WMApp = window.WMApp || {};
window.WMApp.queueCards = function queueCards(deps) {
  "use strict";
  const {
    asPost, setErr, sessionById, assistantIds, assistantThreadName,
    isAssistant, activeSessionId, hostFor, paneIdFor, typingInside, applyAssistant,
  } = deps;

  // ---- the queue sub-tab ------------------------------------------------------------------------
  //
  // One assistant's task queue. It is the one session pane that is a LIST and lives on the session's own row, because
  // the work is that assistant's: what it is carrying, what it has parked and what it has finished. The pane is
  // fetched when the tab opens and after every change — the polled board state carries each assistant's settings but
  // not its queue, and pushing up to 200 tasks × N assistants through the board poll would be a payload nobody reads.
  //
  // The cache is keyed by assistant id so stepping between tabs is instant, and a failed fetch leaves the last good
  // list on screen with the error above it rather than a pane that went blank because one request timed out.
  const queueCache = new Map(); // assistantId -> { view, error, loading, at }
  // One read in flight per assistant, and one counter per assistant. The counter used to be one `let` for the whole
  // page, so two panes' answers judged each other stale; per id, an answer about assistant-2 says nothing about
  // assistant-1. A write bumps its own id's counter too, so a read that was already in flight when the write landed
  // cannot repaint the list the write replaced.
  const queueSeq = new Map(); // assistantId -> number
  const queueInflight = new Map(); // assistantId -> the promise of the read in flight
  // Which row's ➡️ picker is open, keyed `<assistant>:<task>`. One record for the whole float rather than a DOM flag,
  // so the pane can be repainted (the board polls it) without shutting a picker the reader is looking at, and two
  // assistants' task #3 cannot toggle each other's list.
  const qmoveOpen = new Set();
  // The agents' own statuses, from GET /api/jobs, newest turn per thread. It is deliberately NOT the page's own job
  // map: the brief asks the queue to read the run store, so a sub-row cannot inherit a stale status from a card that
  // has not been repainted yet. `at` is the read's clock — a paint re-asks only when the answer is older than a few
  // seconds, which is what keeps the pane's own repaint from becoming a request loop.
  const queueJobs = { at: 0, byThread: new Map(), inflight: null };
  // The card being dragged (null when no gesture is live), the moment the last drag ENDED, and the one line a refused
  // drop says. The ended-at stamp is what tells the click the browser fires at the end of a drag from the reader's own
  // press: a drag must never open a card, and a click must still open its console.
  let queueDrag = null;
  let queueDragEnded = 0;
  const queueDropNotes = new Map(); // assistantId -> the sentence a blocked drop left on the pane
  // How much of the list the pane draws. A queue holds up to 200 tasks and the pane is rebuilt on every board tick and
  // after every action, so drawing the whole history is a page nobody reads and a DOM the poll keeps paying for. The
  // window lives HERE, outside the painter, keyed by assistant: a repaint reads it back instead of starting at 20 again.
  const QUEUE_FIRST = 20;
  const QUEUE_MORE = 50;
  const queueShown = new Map(); // assistantId -> how many of the newest tasks the pane draws
  const queueWindowOf = (id) => {
    const n = Number(queueShown.get(String(id)));
    return Number.isFinite(n) && n >= QUEUE_FIRST ? n : QUEUE_FIRST;
  };
  // Ids are handed out in order, so the highest ids ARE the newest tasks. The window is a SET of ids rather than the
  // first N rows: the pane's own bucket/`order` sort still decides where each row is drawn, and loading more adds the
  // next-newest slice without re-ordering the rows already on screen.
  const queueWindowIds = (rows, shown) =>
    new Set(
      (Array.isArray(rows) ? rows : [])
        .slice()
        .sort((a, b) => Number(b.id) - Number(a.id))
        .slice(0, shown)
        .map((t) => String(t.id)),
    );
  // The window's rows in DRAWING order. The active buckets keep `queueSorted`'s order (a queued card's drag position is
  // the reader's), and the finished bucket reads newest first: its useful end is the latest work, and "Load 50 more" then
  // appends older rows UNDER the ones on screen instead of inserting them out of sight above.
  const queueWindowRows = (sorted, shown) => {
    const ids = queueWindowIds(sorted, shown);
    const visible = (Array.isArray(sorted) ? sorted : []).filter((t) => ids.has(String(t.id)));
    return [
      ...visible.filter((t) => t.state !== "done"),
      ...visible.filter((t) => t.state === "done").sort((a, b) => Number(b.id) - Number(a.id)),
    ];
  };

  const queueMark = (state) => (state === "done" ? "✓" : state === "parked" ? "⏸" : state === "running" ? "●" : "○");
  const queueStateName = (state) => (state === "running" ? "running" : state === "parked" ? "parked" : state === "done" ? "done" : "queued");
  // The word in the head is a STATUS, and hover is where it explains itself: a reader who does not know what "parked"
  // means here gets the rule without a paragraph under every row.
  const queueStateTitle = (t) =>
    t.stale
      ? `stale — the file still says running, but ${String(t.staleWhy || "its thread has no live run").replace(/^that thread/, "its thread")}`
      : t.state === "running"
        ? t.runBy === "run" && t.runId
          ? `running — run ${t.runId} is ${t.runStatus || "live"}: the row's verdict is read from that run, not from the thread it shares`
          : t.guessed
            ? "running — a run is carrying it, but the row names no run id: this verdict is a guess from its tree path or thread"
            : "running — a run is carrying it; its agent's own status is on the facts line"
        : t.state === "parked"
          ? "parked — stopped until the condition in the note is released; nothing starts it by itself"
          : t.state === "done"
            ? "done — the record of finished work; it stays in place, dimmed, and can be re-queued"
            : "queued — not started; drag the card to change its place, and a card held by another row cannot go above it";
  // What a row is waiting on, in the row's head: the lane head that goes first. `waitingOn` and `lane` are DERIVED
  // by the store (lib/assistant/queue.js's laneInfo) — this draws the fact the digest already carries, in three
  // words, with the file it shares in title= so the row stays one line.
  function queueLaneChip(t) {
    const w = t?.waitingOn;
    const at = Number(w?.id);
    if (!Number.isFinite(at) || at <= 0) return "";
    const lane = String(w?.lane || "").trim();
    const title = `waiting on #${at}${lane ? ` — #${at} heads this lane (${lane})` : ""}: both rows touch the same file, and it goes first`;
    return `<span class="as-task-wait" data-as-qwait="${esc(String(at))}" title="${esc(title)}">waiting on #${esc(String(at))}</span>`;
  }

  // ---- the reader's order, and the hold that can block it ---------------------------------------------------------
  //
  // The pane groups by STATE first — running, queued, parked, done — and that grouping is not the drag's to change:
  // a running row is being worked on, a parked one is waiting for somebody, and a done one is the record. Inside a
  // group the rows are sorted by `order` (the place a card was dragged to, written by the reorder action) and then by
  // id, which is the order every queue file written before the drag already drew.
  const QUEUE_BUCKET = { running: 0, queued: 1, parked: 2, done: 3 };
  const queueOrderOf = (t) => {
    const n = Number(t?.order);
    return Number.isFinite(n) && n > 0 ? n : Number(t?.id) || 0;
  };
  const queueSorted = (rows) =>
    (Array.isArray(rows) ? rows : [])
      .slice()
      .sort(
        (a, b) =>
          (QUEUE_BUCKET[a.state] ?? 9) - (QUEUE_BUCKET[b.state] ?? 9) ||
          queueOrderOf(a) - queueOrderOf(b) ||
          Number(a.id) - Number(b.id),
      );
  // The row a `task` hold names. Only that kind orders anything on this list: a thread, job, path or manual hold is a
  // park's release condition and names nothing here.
  function queueHoldTarget(t) {
    const hold = t?.hold;
    if (!hold || hold.kind !== "task") return null;
    const m = /^\s*#?\s*(\d+)\s*$/.exec(String(hold.value ?? ""));
    if (!m) return null;
    const ms = Date.parse(String(hold.since || ""));
    return { id: Number(m[1]), since: Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 16) : null };
  }
  // The badge a card carries when its hold actually blocks a drop. Only those cards wear one: greying out everything
  // above the row a card holds for would also grey the running and done rows the drag is not competing with.
  function queueHoldBadge(t, byId) {
    const target = queueHoldTarget(t);
    if (!target) return "";
    const held = byId && typeof byId.get === "function" ? byId.get(target.id) : null;
    // A hold whose row is gone from this queue, or reads done, has ended — there is nothing left to hold for.
    if (byId && typeof byId.get === "function" && (!held || held.state === "done")) return "";
    const title = `held by #${target.id}${target.since ? ` since ${target.since}` : ""} — this card cannot be dragged above it`;
    return `<span class="as-task-hold" data-as-qhold="${target.id}" title="${esc(title)}">held by #${target.id}</span>`;
  }

  // ---- a row whose agent has stopped to ask something ----------------------------------------------
  //
  // A queue row says what the reader has queued, and a row is a lane only while it is waiting on the QUEUE. A row whose
  // agent is parked on a `clarify` question is waiting on a PERSON instead, and until now it read exactly like a lane:
  // "parked" plus a reason, which is what a board full of held work looks like when it is actually stopped. So the row
  // wears one more word and one press, `question`, over the panel's own alert for that question.
  //
  // The alert is the store's, not a second copy: the assistant's state publishes its OPEN alerts (`rule`, `parked`,
  // `requestId`, `thread`, `title`, `detail`, `choices`) and this only joins one to a row — by THREAD, because a task's
  // agent IS its thread and `threads[]` is the whole history a re-attempt leaves behind. That title is clipped to 70
  // characters server-side, so the chip is a SIGN, never the question: the full text, every choice and the answer are
  // drawn in the agent's own card by the turn renderer (`questionPrompt`/`questionAnswered` in public/app.js), and the
  // press lands there.
  function queueQuestionAlert(t, alerts) {
    const list = Array.isArray(alerts) ? alerts : [];
    if (!list.length) return null;
    const threads = new Set([...(Array.isArray(t?.threads) ? t.threads : []), t?.thread].map((v) => String(v || "")).filter(Boolean));
    if (!threads.size) return null;
    // The panel writes this alert as rule `question` with `parked` and a request id (`lib/assistant.js`'s clarify
    // branch); `clarify` is accepted by name for a record written against the other spelling of the same fact. An
    // APPROVAL is not a question — its box lives on the card too, but it is a different prompt with a different answer
    // route — so it is excluded by rule rather than by whatever shape it happens to carry.
    const isQuestion = (a) =>
      Boolean(a) && a.status === "open" && (a.rule === "question" || a.rule === "clarify") && (a.parked === true || Boolean(a.requestId));
    // The NEWEST when a thread somehow holds two: a re-ask is the question holding the run now.
    return (
      list
        .filter((a) => isQuestion(a) && threads.has(String(a.thread || "")))
        .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))[0] || null
    );
  }
  // The chip reuses the hold badge's class on purpose: it is the same kind of thing — a pill-sized condition on a row —
  // and a question is made readable with NO new stylesheet rule. A <button> so Enter and Space are the browser's own,
  // and `data-as-qopen` so it opens its agent through the handler that already opens an agent row (the console turn,
  // not just the card header): one opener, not a second path.
  function queueQuestionChip(t, alerts) {
    const alert = queueQuestionAlert(t, alerts);
    if (!alert) return "";
    const thread = String(alert.thread || "");
    const label = String(assistantThreadName(thread) || "").trim();
    const title = `${label && label !== thread ? `“${label}” ` : ""}(${thread}) has stopped to ask you something — click to open its card; the question, every choice and the answer are in its chat`;
    return `<button type="button" class="as-task-hold as-task-question" data-as-qopen="${esc(thread)}" data-as-qid="${esc(String(t.id))}" data-as-qquestion="${esc(alert.id || "")}" title="${esc(title)}" aria-label="${esc(title)}">question</button>`;
  }
  /**
   * The drop the model refuses, found before the request is sent: a queued row may not sit above a row it holds for
   * while that row is still open. `ids` is the whole visible list as the drop leaves it, so this is the same rule
   * `reorderTasks` applies on the server — the pane just answers without a round trip (and the server still refuses a
   * list that got past a stale pane).
   */
  function queueDropBlocked(tasks, ids) {
    const list = Array.isArray(tasks) ? tasks : [];
    const order = (Array.isArray(ids) ? ids : []).map((v) => Number(v));
    const byId = new Map(list.map((t) => [Number(t.id), t]));
    const pos = new Map(order.map((id, i) => [id, i]));
    for (const id of order) {
      const t = byId.get(id);
      if (!t || t.state !== "queued") continue;
      const target = queueHoldTarget(t);
      if (!target || !pos.has(target.id)) continue;
      const held = byId.get(target.id);
      if (!held || held.state === "done") continue;
      if (pos.get(id) < pos.get(target.id)) {
        return {
          id,
          target: target.id,
          since: target.since,
          line: `#${id} is held by #${target.id}${target.since ? ` since ${target.since}` : ""} — it cannot move above it`,
        };
      }
    }
    return null;
  }
  const queueCardsIn = (el) => {
    const pane = el?.closest?.('[data-subpane="queue"]');
    return pane ? [...pane.querySelectorAll(".as-task")] : [];
  };
  // The ids in the order the pane currently draws them — what a drop sends, and what a drag records before it moves.
  const queueIdsIn = (el) => queueCardsIn(el).map((c) => Number(c.dataset.asQrow)).filter((n) => Number.isFinite(n) && n > 0);

  // ---- one agent per task: the threads that carried it, and the status of the RUN each one is on ------------------
  //
  // The status of an agent is read from GET /api/jobs, by thread — never from the task record. The task's `state` is
  // what the READER decided about the work (queued, running, parked, done); an agent's line is what its RUN is doing,
  // and the two disagree on purpose: a task still marked running whose run went away must read EXITED, and a task the
  // reader parked while its agent keeps working must still read RUNNING. Two sources, two questions, one row.
  //
  // The classes and the words are the card's own (public/app.js's job head, `:4260-4300`), so a queue row and a card
  // cannot describe one run two ways: `.pill.pill-running`, `.pill.pill-notrunning` (+ `.is-failed`), `button.pill-complete`,
  // and the words running / complete / exited / not-running — which `.pill`'s own text-transform paints uppercase.
  const QUEUE_LIVE = new Set(["running", "starting", "waiting", "waiting_for_approval", "queued"]);
  function queueAgentChip(job) {
    const status = String(job?.status || "").toLowerCase();
    if (QUEUE_LIVE.has(status)) {
      // ⏸ is the one live state that is not progress: the run is waiting on the reader (an approval, or an answer).
      const waiting = status === "waiting" || status === "waiting_for_approval";
      return { mark: waiting ? "⏸" : "●", markState: waiting ? "parked" : "running", word: "running", cls: "pill pill-running" };
    }
    if (status === "done") return { mark: "✓", markState: "done", word: "complete", cls: "pill pill-complete", button: true };
    // A stopped agent's chip is the pick-up CONTROL, not a word: `exited` after a failed run and `not-running` for
    // anything else that is not going. Both are the same press the board's own card gives them (`button.pill-continue`
    // on `.pill-notrunning`, `.is-failed` for a failure), because this row is that card's chip in a second place — and
    // the press is where a wedged session is cleared. A LIVE run is deliberately not a control: there is nothing to
    // re-attach, and a press on it could only start a second run over a turn that is already going.
    if (status === "failed") return { mark: "○", markState: "queued", word: "exited", cls: "pill pill-notrunning is-failed", reattach: true };
    // A cancelled/interrupted/stopped run, and a thread the job store has never heard of, say the same thing to a
    // reader — nothing is running it now — and the card says the same word for both of them.
    return { mark: "○", markState: "queued", word: "not-running", cls: "pill pill-notrunning", reattach: true };
  }

  // One sub-row per agent. The whole line is the opener — it carries the mark this RUN owns (not the task's) and the
  // card's own chip — and pressing it opens that agent's card AND the console of the turn it is on (openAgentTurn),
  // not just the card header.
  //
  // The RUN ID rides beside the current thread, because a thread is not one run: two records can share one slug (a
  // failed attempt and its live retry), and the id is the only thing on the card that says which record the row's
  // verdict was read from. A row with no run id says so — `guessing` — instead of letting a thread match pass for
  // evidence.
  function queueAgentHtml(id, t, thread, jobs) {
    const threads = Array.isArray(t?.threads) && t.threads.length ? t.threads.filter(Boolean) : t?.thread ? [t.thread] : [];
    const current = threads.length ? threads[threads.length - 1] : "";
    const onCurrent = thread === current;
    // The row's OWN run is what its chip says when the row names one and the verdict came from it (queue.js's
    // `runningFlag`). Otherwise the chip keeps reading the newest turn on the thread, which is the old behaviour.
    const rowRun = onCurrent && t?.runId && String(t?.runBy || "") === "run" ? { status: t.runStatus } : null;
    const job = rowRun || (jobs && typeof jobs.get === "function" ? jobs.get(thread) : null);
    const chip = queueAgentChip(job);
    const label = String(assistantThreadName(thread) || "").trim();
    const named = label && label !== thread;
    const open = `data-as-qopen="${esc(thread)}" data-as-qid="${esc(String(t.id))}"`;
    const title = `open ${named ? `“${label}” ` : ""}(${thread})'s card and its current console turn — this agent's run is ${chip.word}, read from /api/jobs`;
    // What the row is ON, in the one word an id can be: the run id itself. Absent from a queued row (nothing is
    // running it), present on a running or parked one, and the record on a done one. `guessing` is the same slot with
    // the opposite claim: there is no run id, so the state above it was inferred from the tree path or the thread.
    const runChip =
      onCurrent && t?.runId && t?.state !== "queued"
        ? `<span class="as-task-agent-run" data-as-qrun="${esc(String(t.runId))}" title="${esc(
            `run ${t.runId} — the run this row names; ${t.state === "running" ? `its status (${t.runStatus || "unknown"}) is what the row's running/stale verdict is read from` : "kept as the record of the run this row was last on"}`,
          )}">${esc(String(t.runId).length > 24 ? `${String(t.runId).slice(0, 23)}…` : String(t.runId))}</span>`
        : onCurrent && t?.state === "running" && t?.guessed
          ? `<span class="as-task-agent-run is-guess" title="${esc(
              `no run id on this row — the running/stale verdict is a GUESS from ${t.runBy === "thread" ? `its thread (${thread})` : "a live run in its tree path"}; the next cut or resume writes the run id, and then this is evidence`,
            )}">guessing</span>`
          : "";
    // The stopped chip is a real <button>: that IS the role, the tab stop and the Enter/Space activation in one
    // element, so no `role=`/`tabindex=` has to be written onto a span. The word stays the status and the ↻ is the
    // glyph the board's own stopped pill already carries, so a reader who has pressed one recognises the other.
    const reattachWhy =
      chip.word === "exited"
        ? `a failed run can leave the gateway's admission for this session unknown, and every later turn is refused until that is settled. This press settles it (POST /api/assistants/${id}/reset) and, only when something was cleared, starts one short turn on the same thread.`
        : `press to check this assistant's session for a run the gateway never settled. Nothing wedged means nothing is started; something cleared means one short turn on the same thread.`;
    const pill = chip.button
      ? `<button type="button" class="pill pill-complete" ${open} title="${esc(`${title} — the run finished, so nothing here is being resumed`)}" aria-label="${esc(`${chip.word} — ${title}`)}">${chip.word}</button>`
      : chip.reattach
        ? `<button type="button" class="${chip.cls} pill-reattach" data-as-qreattach="${esc(thread)}" data-as-qown="${esc(id)}" data-as-qid="${esc(String(t.id))}" title="${esc(`${chip.word} — re-attach this assistant: ${reattachWhy} Nothing here restarts the panel or the gateway.`)}" aria-label="${esc(`${chip.word} — re-attach this assistant on ${thread}`)}">${chip.word}<span class="pill-again" aria-hidden="true">↻</span></button>`
        : `<span class="${chip.cls}" title="${esc(`this agent's run is ${chip.word} — read from /api/jobs, not from the task record`)}">${chip.word}</span>`;
    return `<div class="as-task-agent" role="button" tabindex="0" ${open} title="${esc(title)}" aria-label="${esc(title)}">
            <span class="as-agent-mark is-${esc(chip.markState)}" aria-hidden="true">${chip.mark}</span>
            <code class="as-task-agent-thread">${esc(thread)}</code>
            ${runChip}
            ${named ? `<span class="as-task-agent-label">${esc(label)}</span>` : ""}
            ${pill}
          </div>`;
  }

  // ---- the stopped chip's press: re-attach this assistant, then say what happened --------------------------------
  //
  // A card can read EXITED for a run the gateway never finished settling: the session's admission is still `unknown`,
  // so the fence stands and the next turn is refused before it starts. `POST /api/assistants/:id/reset` is the call
  // that settles that fence — the same one Settings' reset row makes — and this press adds only what that row cannot:
  // one short turn on the same thread once the fence is gone, and the sentence on the card saying which of the three
  // things happened.
  //
  // What it must never do, and does not: restart the panel or the gateway (no route here touches either), touch
  // another assistant (every call carries THIS card's own id), or start a run when nothing was cleared — an idle
  // assistant whose chip merely reads not-running has nothing to re-attach, and a turn there would be a second run
  // over healthy work. A refusal is printed verbatim: a press that answers nothing is a press that lied.
  const REATTACH_TEXT = "you were re-attached after an exit; continue";
  const queueReattachNotes = new Map(); // `${assistantId}:${taskId}` -> { text, tone }
  const queueReattachInFlight = new Set(); // assistant ids with a reset out: one press, one reset
  const queueReattachKey = (own, id) => `${own}:${id}`;

  // What the last press on this card answered, held per CARD so the repaint the answer asks for cannot erase it.
  function queueReattachNoteHtml(own, id) {
    const n = queueReattachNotes.get(queueReattachKey(own, id));
    if (!n) return "";
    return `<div class="as-task-note is-${esc(n.tone)}" role="status" title="${esc(n.text)}">${esc(n.text)}</div>`;
  }

  async function queueReattach(own, id, btn = null) {
    const assistantId = String(own || "");
    if (!assistantId) return;
    const key = queueReattachKey(assistantId, id);
    const note = (text, tone) => {
      queueReattachNotes.set(key, { text, tone });
    };
    // A second press while the first is still out asks the SAME question, so it is answered from the flight already
    // running rather than putting a second reset on the wire — the route's own single-flight would answer 409, and a
    // 409 the reader caused by double-clicking is noise, not a verdict.
    if (queueReattachInFlight.has(assistantId)) {
      note("one reset is already running for this assistant — nothing was sent twice", "info");
      renderAssistantQueue(assistantId);
      return;
    }
    queueReattachInFlight.add(assistantId);
    if (btn && btn.isConnected) {
      btn.disabled = true;
      btn.classList.add("is-starting");
    }
    try {
      const answer = await asPost(`/api/assistants/${encodeURIComponent(assistantId)}/reset`, {
        dryRun: false,
        reason: "the reader pressed EXITED",
      });
      // A 200 that is not `ok` is the route's INCOMPLETE verdict (some rows settled, the fence still standing): its
      // own sentence is the answer, exactly as a 4xx's is.
      if (answer?.ok !== true) {
        note(String(answer?.error || "the reset answered without a verdict — nothing here says what was cleared"), "bad");
        return;
      }
      const cleared = Array.isArray(answer?.cleared?.admissions) ? answer.cleared.admissions.length : 0;
      const wakes = Array.isArray(answer?.cleared?.wakes) ? answer.cleared.wakes.length : 0;
      const watches = Array.isArray(answer?.cleared?.watches) ? answer.cleared.watches.length : 0;
      if (!cleared) {
        // Nothing was fenced. A turn here would start a run over a session that had nothing wrong with it, so the
        // press reports the truth and stops — the one no-op this control is allowed to have, said out loud.
        const also = wakes || watches ? ` — it did drop ${wakes} queued wake(s) and ${watches} watch(es)` : "";
        note(`nothing was wedged${also} — no run was started`, "info");
        return;
      }
      // The fence is gone. ONE short turn on this assistant's own thread; its run id is what the card says started.
      try {
        const turn = await asPost("/api/assistant/say", { text: REATTACH_TEXT, assistantId });
        const run = String(turn?.job?.runId || turn?.job?.id || "");
        note(`cleared ${cleared} wedged run(s), run ${run || "(no id yet)"} started`, "good");
      } catch (err) {
        // Cleared, but nothing started: claiming a run here would be a lie the reader would act on.
        note(`cleared ${cleared} wedged run(s), but the wake was refused — ${String((err && err.message) || err)}`, "bad");
      }
    } catch (err) {
      // The route's refusal, verbatim — its 409 `error` is written for the reader.
      note(String((err && err.message) || err), "bad");
    } finally {
      queueReattachInFlight.delete(assistantId);
      if (btn && btn.isConnected) {
        btn.disabled = false;
        btn.classList.remove("is-starting");
      }
      // The chip's word comes from /api/jobs and the note from the map above, so the repaint reads both again.
      void loadQueueJobs();
      renderAssistantQueue(assistantId);
    }
  }

  // The row's pipeline press. It draws what the RECORD says — the contract's `pipelineRun` (lib/task-pipeline.js), as it
  // is stored — because the row has no bundle: resolving it is the window's read, one press away. Every task gets one.
  // A task with no assignment is on the DEFAULT path, and the window is where that path is explained; a row with no
  // press would make the explanation unreachable.
  function queuePipelineChip(t, id) {
    const run = t?.pipelineRun;
    const object = run && typeof run === "object" && !Array.isArray(run) ? run : null;
    const pipeline = object && typeof object.pipeline === "string" ? object.pipeline.trim() : "";
    const stage = object && typeof object.stage === "string" ? object.stage.trim() : "";
    const words = pipeline
      ? `pipeline ${pipeline}${stage ? ` · ${stage}` : ""}`
      : run == null
        ? "assistant decides"
        : object
          ? "pipeline: unresolved — no pipeline named"
          : "pipeline: unresolved — unreadable record";
    const title = pipeline
      ? `pipeline ${pipeline}${stage ? `, stage ${stage}` : ""} — open the pipeline window: every stage in order, where this task is, the gate that ended the stage before it, and the control that moves it`
      : run == null
        ? "no pipeline is assigned — the assistant decides; open the pipeline window to put this task on a pipeline or read what the default path means"
        : `the pipeline record is ${JSON.stringify(run)} — open the pipeline window to see why it cannot be read (it is NOT treated as the default path)`;
    return `<button type="button" class="as-task-pipe" data-as-qpipe="${esc(String(t.id))}" data-as-qown="${esc(id)}" title="${esc(title)}" aria-label="${esc(title)}">${esc(words)}</button>`;
  }

  // The row's FLOW press, beside the pipeline chip. The chip opens the pipeline WINDOW (where the task is assigned and
  // where every stage's artifact and gate is spelled out); this opens the flow the window cannot draw at row width:
  // the whole sequence left to right, the gates as notches, a capped loop as an arc, and where this task is. Both
  // read the same answer; neither writes anything, and the press is a glyph so the row stays narrow.
  function queueFlowButton(t, id) {
    return `<button type="button" class="as-qflow" data-as-qflow="${esc(String(t.id))}" data-as-qown="${esc(id)}" title="the pipeline flow — every stage left to right, gates as notches, a capped loop as an arc, and where this task is. It reads only: the chip beside it is where the task is assigned." aria-label="open the pipeline flow">⇢</button>`;
  }

  // The PROJECT a card is about, in one word — the field the panel wrote when it cut the task, else the project the
  // tree path names (everything before `/.worktrees/`, reduced to its directory name), else the board row's own
  // project. Nothing at all when none of the three says anything: a guessed project reads exactly like a fact, and a
  // wrong one sends the reader to the wrong repository. Always the NAME, never the path — the meta line has room for
  // one short word beside the files, and a path there is what would push them off it.
  function queueProjectName(t) {
    const leaf = (v) =>
      String(v ?? "")
        .trim()
        .replace(/\\/g, "/")
        .replace(/\/+$/, "")
        .split("/")
        .filter(Boolean)
        .pop() || "";
    const own = leaf(t?.project);
    if (own) return own;
    const tree = String(t?.worktree || "").replace(/\\/g, "/");
    const at = tree.toLowerCase().indexOf("/.worktrees/");
    if (at > 0) {
      const before = leaf(tree.slice(0, at));
      if (before) return before;
    }
    return leaf(t?.row?.project);
  }

  // WHO FILED a row, when that is somebody other than the reader who is looking at it. `createdBy` is the `by` the
  // write carried, which is the route's designed mechanism for a cross-assistant file and the only trace of it on the
  // row: without this line a row Assistant #4 put in this queue is indistinguishable from one the reader typed. The
  // name is the session's own when the panel knows the id, else the number the id carries ("assistant-4" reads
  // "Assistant #4"), else the id as written. Two filers draw nothing because they are the ordinary case rather than a
  // fact about the row: `reader` (the route's default, and what this page's own Add form posts) and the assistant
  // whose queue this is (a row it filed for itself). "Came from outside this queue" is the one thing the line says.
  function queueFiledBy(t, id) {
    const by = String(t?.createdBy || "").trim();
    if (!by || by === "reader" || by === String(id || "")) return null;
    const named = sessionById(by)?.name;
    if (named) return named;
    const n = /^assistant-(\d+)$/.exec(by);
    return n ? `Assistant #${n[1]}` : by;
  }

  // One row, read in this order: WHAT the row is (its title), its STATE in a word, and WHAT IT IS WAITING ON — a
  // lane head, a hold, a question, a skipped file, a stopped run. Those are the head, on one line, at full contrast;
  // the marker is the accent beside them, never the only word for the state. The agents, project and PR follow on
  // one facts line, and everything a reader needs only after that question — the tree, the files, the attempts and
  // the task's own detail — sits behind the row's own closed disclosure. Printing all of it is what made one row
  // 166 px tall and put its reason under a paragraph of rationale.
  function queueTaskHtml(id, t, jobs, byId, alerts) {
    const mark = queueMark(t.state);
    const state = queueStateName(t.state);
    // A stale row IS a running row nothing is running any more: the WORD says so where the state is read, instead
    // of a blue marker contradicting the amber sentence underneath it.
    const stateWord = t.stale ? "stale" : state;
    // `threads` is the record's whole history and `thread` its legacy first entry, so a queue file written before the
    // list existed still draws one agent row. The CURRENT run is the last one, and that is what a click on the body
    // (rather than on a sub-row) opens.
    const list = Array.isArray(t.threads) && t.threads.length ? t.threads.filter(Boolean) : t.thread ? [t.thread] : [];
    const current = list.length ? list[list.length - 1] : "";
    // The one line that answers WHERE: the project and the PR. FIRST, because the one word that says where the work
    // is must never wrap off the bottom of a card.
    const meta = [];
    const project = queueProjectName(t);
    if (project) meta.push(`project ${esc(project)}`);
    if (t.row?.pr?.number) meta.push(`PR #${esc(String(t.row.pr.number))} ${esc(t.row.pr.state || "")}`.trim());
    else if (t.row?.verdict) meta.push(`PR ${esc(t.row.verdict)}`);
    // The second read, folded: the tree (usually a long path), the files, the attempts and the task's own detail.
    const fold = [];
    if (t.worktree) fold.push(`<span title="the worktree this task works in">tree ${esc(t.worktree)}</span>`);
    if (Array.isArray(t.files) && t.files.length)
      fold.push(
        `<span title="the files this task claims — a queued task that touches a running task's files is skipped">files ${esc(t.files.slice(0, 4).join(", "))}${t.files.length > 4 ? "…" : ""}</span>`,
      );
    if (Number(t.attempts) > 0) fold.push(`<span title="how many times this task has been started">${Number(t.attempts)} attempt${Number(t.attempts) === 1 ? "" : "s"}</span>`);
    if (t.detail) fold.push(`<span class="as-task-detail" title="the detail written when the task was filed">${esc(t.detail)}</span>`);
    // The waiting-on sentence, on its own line, in the row's voice: amber for a stop, red for a refusal. It is a
    // fact, not a description, so it stays printed — with the whole sentence in title= because the line is one line.
    const note = t.stale
      ? `<div class="as-task-note" title="${esc(`STALE — ${t.staleWhy || "its thread has no live run"}`)}">STALE — ${esc(t.staleWhy || "its thread has no live run")}</div>`
      : t.conflict
        ? `<div class="as-task-note is-bad" title="${esc(`SKIPPED — ${t.skipped || "files in use by a running task"}`)}">SKIPPED — ${esc(t.skipped || "files in use by a running task")}</div>`
        : t.state === "parked" && t.reason
          ? `<div class="as-task-note" title="${esc(`parked — ${t.reason}`)}">parked — ${esc(t.reason)}</div>`
          : t.state === "queued" && t.reason
            ? `<div class="as-task-note" title="${esc(t.reason)}">${esc(t.reason)}</div>`
            : "";
    const agents = list.length
      ? list.map((th) => queueAgentHtml(id, t, th, jobs)).join("")
      : `<div class="as-task-agent is-none" title="nothing has run this task yet — Start marks it running, and the thread it is handed becomes its first agent row">
            <span class="as-agent-mark is-queued" aria-hidden="true">○</span>
            <span class="as-task-agent-label">no agent yet</span>
          </div>`;
    // What can be pressed depends on where the task is. A transition to the state it is already in is not offered:
    // a button that reports "already queued" is a button that wasted a click. Each press is a GLYPH on the row and the
    // real word lives in title= and aria-label=, so the row stays narrow without becoming a row of unlabelled squares.
    const btn = (act, glyph, word, why) =>
      `<button type="button" class="as-qglyph" data-as-qact="${act}" data-as-qid="${esc(String(t.id))}" data-as-qown="${esc(id)}" title="${esc(`${word} — ${why}`)}" aria-label="${esc(word)}">${glyph}</button>`;
    const acts = [];
    if (t.state !== "running") acts.push(btn("running", "▸", "Start", "mark this task running — the thread it names is what carries it"));
    if (t.state !== "queued") acts.push(btn("queued", t.state === "done" ? "↺" : "⇣", t.state === "done" ? "Requeue" : "Queue", t.state === "done" ? "put it back in the queue — a finished task can be re-queued" : "put it back in the queue"));
    if (t.state !== "parked") acts.push(btn("parked", "‖", "Park", "park it — blocked, waiting on something outside this assistant"));
    if (t.state !== "done") acts.push(btn("done", "✓", "Done", "mark it finished — this is the reader's judgement, not the panel's"));
    // Move is a POPOVER, not a select that is always on the row: the picker is as wide as the assistant names, and it
    // was the one control on the row that could not be a glyph. ➡️ opens the list; a name in it IS the choice (the
    // press carries data-as-qmove-to), Esc or a press outside closes it, and the one open picker is remembered by key
    // so a repaint of the pane does not shut a picker the reader is looking at.
    const others = assistantIds().filter((x) => x !== id);
    const mkey = `${id}:${t.id}`;
    const open = qmoveOpen.has(mkey);
    const move = others.length
      ? `<span class="as-qmove-wrap">
          <button type="button" class="as-qglyph" data-as-qmove-open="${esc(mkey)}" data-as-qown="${esc(id)}" data-as-qid="${esc(String(t.id))}" title="Move — hand this task to another assistant; it leaves this queue, arrives in that one's with an id of its own, and the move is recorded on the task (movedFrom)" aria-label="Move" aria-haspopup="menu" aria-expanded="${open ? "true" : "false"}">→</button>
          <span class="as-qmove-pop" data-as-qmove-pop="${esc(mkey)}" role="menu" aria-label="Move #${esc(String(t.id))} to another assistant"${open ? "" : " hidden"}>${others
            .map((x) =>
              `<button type="button" role="menuitem" class="as-qmove-pick" data-as-qact="reassign" data-as-qid="${esc(String(t.id))}" data-as-qown="${esc(id)}" data-as-qmove-to="${esc(x)}" title="${esc(`Move to ${sessionById(x)?.name || x} — it leaves this queue, arrives in that one's with an id of its own, and the move is recorded on the task (movedFrom)`)}" aria-label="${esc(`Move to ${sessionById(x)?.name || x}`)}">↳ ${esc(sessionById(x)?.name || x)}</button>`,
            )
            .join("")}</span>
        </span>`
      : "";
    // The disclosure is OUTSIDE the body on purpose: the body is the console opener, and a summary inside it would
    // be swallowed by that press. Closed it is one 9.5 px word; opened it is the tree, the files, the attempts and
    // the task's own detail.
    const more = fold.length
      ? `<details class="as-task-more"><summary title="the tree, the files, the attempts and the detail — folded so the row reads as one line">${t.worktree || (Array.isArray(t.files) && t.files.length) ? "tree · files" : "more"}${Number(t.attempts) > 0 ? " · attempts" : ""}${t.detail ? " · detail" : ""}</summary><div class="as-task-more-body">${fold.join(`<span class="as-task-sep">·</span>`)}</div></details>`
      : "";
    // Somebody else filed this row (null for the ordinary case), drawn on its own small line below.
    const filedBy = queueFiledBy(t, id);
    return `<div class="as-task${t.state === "done" ? " is-done" : ""}${t.state === "queued" ? " is-draggable" : ""}" data-as-qrow="${esc(String(t.id))}" data-as-qstate="${esc(state)}" data-as-qown="${esc(id)}" data-as-qthread="${esc(current)}">
        <div class="as-task-main">
          <div class="as-task-body"${current ? ` data-as-qopen="${esc(current)}"` : ""}>
            <div class="as-task-head">
              <span class="as-task-mark is-${esc(state)}" aria-hidden="true">${mark}</span>
              <b class="mono">#${esc(String(t.id))}</b>
              <span class="as-task-state is-${esc(stateWord)}" title="${esc(queueStateTitle(t))}">${esc(stateWord)}</span>
              <span class="as-task-title" title="${esc(t.title)}">${esc(t.title)}</span>
              ${queueLaneChip(t)}
              ${queueHoldBadge(t, byId)}
              ${queueQuestionChip(t, alerts)}
            </div>
            <div class="as-task-facts">${agents}${meta.length ? `<span class="as-task-meta">${meta.join(" · ")}</span>` : ""}<span class="as-task-pipeline">${queuePipelineChip(t, id)}${queueFlowButton(t, id)}</span></div>
            ${filedBy ? `<div class="as-task-filed" title="who filed this row: the by the write carried, which is not its owner">filed by ${esc(filedBy)}</div>` : ""}
            ${note}
            ${queueReattachNoteHtml(id, t.id)}
          </div>
          <div class="as-task-actions">${acts.join("")}${move}${btn("delete", "✕", "Delete", "delete this task — a removed task leaves no ghost in the digest")}</div>
        </div>
        ${more}
      </div>`;
  }

  // What the pane is showing, as one of four words rather than a read through the cache scattered over the painter.
  // The ORDER is the rule: an error is said before an empty queue, and a store that was never created says so
  // instead of reading as "carrying nothing" — `found: false` is the server's answer for a queue.json that is not
  // there, and `view.error` is the one that is there and could not be parsed.
  function queuePaneState(cached) {
    const error = cached?.error || cached?.view?.error || "";
    if (error) return { kind: "error", message: String(error) };
    if (!cached?.view) return cached?.loading ? { kind: "loading" } : { kind: "idle" };
    if (cached.view.found === false) return { kind: "missing" };
    return { kind: "ready" };
  }

  // The one line a pane with nothing (or nothing readable) to list draws. Its own function so all four cases can be
  // driven without a DOM, and so a pane that has rows AND an error still says the error above them.
  function queueStateHtml(pane, { id, n, view, rows }) {
    const at = `id="as-qstate-${esc(n)}"`;
    if (pane.kind === "error") {
      return `<div class="as-task-note is-bad" ${at}>could not read its queue — ${esc(pane.message)} <button type="button" data-as-qact="reload" data-as-qown="${esc(id)}">Retry</button></div>`;
    }
    if (pane.kind === "missing") {
      return `<div class="as-help" ${at}>no queue yet — <b>Add task</b> creates it${view?.file ? ` at <code>${esc(view.file)}</code>` : ""}</div>`;
    }
    if (pane.kind === "loading") return `<div class="as-help" ${at}>reading its queue…</div>`;
    if (pane.kind === "idle") return `<div class="as-help" ${at}>not read yet</div>`;
    return rows.length ? "" : `<div class="as-help" ${at}>(empty — this assistant is carrying nothing)</div>`;
  }

  // The one control under the list. It appends the next-newest slice of the tasks the window is still hiding, and it
  // RETIRES at the end of the list: with nothing hidden there is no control to draw, not a disabled button that costs a
  // line forever. The count in the note is the truth the label does not spell out when fewer than 50 are left.
  function queueMoreHtml(id, hidden) {
    const left = Number(hidden) || 0;
    if (left <= 0) return "";
    const more = Math.min(QUEUE_MORE, left);
    return `<div class="as-qmore"><button type="button" class="as-qmore-btn" data-as-qact="more" data-as-qown="${esc(id)}" title="append the next ${more} older task${more === 1 ? "" : "s"} - the list opens at the newest ${QUEUE_FIRST}, and this control goes away when every task is shown">Load ${more} more</button><span class="as-qmore-note">${left} older task${left === 1 ? "" : "s"} not shown</span></div>`;
  }
  function renderAssistantQueue(id = activeSessionId(), force = false) {
    const host = hostFor(id, "queue");
    if (!host || !state.assistant) return;
    // A card is being dragged: rebuilding the pane now would take the node out from under the pointer and end the
    // gesture mid-air. The drag's own drop repaints from the answer, so skipping a paint here costs nothing.
    if (queueDrag) return;
    if (!force && typingInside(`#${paneIdFor(id, "queue")}`)) return;
    const rec = sessionById(id);
    // Ask for a read BEFORE the paint when the cache is missing or old: the paint then says it is reading instead of
    // "not read yet" for a frame, and the answer repaints it WITHOUT forcing another read (see loadQueue's .finally).
    const before = queueCache.get(id);
    if (force || !before || Date.now() - Number(before.at || 0) > 20_000) void loadQueue(id);
    // The agents' statuses come from their own route, and a paint asks for it at most every few seconds: the pane is
    // repainted by the board poll, so a read per paint would be the request loop the queue pane was fixed for once.
    if (!queueJobs.at || Date.now() - queueJobs.at > 5_000) void loadQueueJobs();
    const cached = queueCache.get(id);
    const view = cached?.view;
    const pane = queuePaneState(cached);
    const n = String(id).replace(/^assistant-/, "");
    const counts = view?.counts || {};
    const head = view
      ? `${counts.queued || 0} queued · ${counts.running || 0} running${counts.stale ? `, ${counts.stale} stale` : ""} · ${counts.parked || 0} parked · ${counts.done || 0} done`
      : cached?.loading
        ? "loading…"
        : "not loaded yet";
    const rows = Array.isArray(view?.tasks) ? view.tasks : [];
    // The pane's order: state bucket first, then the reader's `order` (the place a card was dragged to), then id.
    const sorted = queueSorted(rows);
    const byId = new Map(sorted.map((t) => [Number(t.id), t]));
    // The window: the newest ids the reader has asked for, drawn in the pane's own order. `hidden` is what the one
    // control under the list appends from, and it retires when it reaches zero.
    const visible = queueWindowRows(sorted, queueWindowOf(id));
    const hidden = sorted.length - visible.length;
    const dropNote = queueDropNotes.get(id) || "";
    host.innerHTML = `
      <div class="as-group as-qpane">
        <h4>Its task queue — ${esc(rec?.name || "this assistant")}'s own</h4>
        <div class="as-qline">
          <b class="as-qcounts"${view?.file ? ` title="${esc(view.file)}"` : ""}>${esc(head)}</b>
          <button type="button" class="as-qquiet" data-as-qact="reload" data-as-qown="${esc(id)}" title="read this assistant's queue file again">Refresh</button>
          <button type="button" class="as-qquiet" data-as-qact="pipeline" data-as-qown="${esc(id)}" title="open Settings on its Pipeline tab — the catalogue every task's pipeline is drawn from">Pipeline settings</button>
        </div>
        <details class="as-qhelp">
          <summary title="what this pane draws, how work gets into it, and how the order works">what this pane is</summary>
          <div class="as-help">
            <p class="as-qlead">the work this assistant is carrying — queued, running on its thread, parked, done — and how it gets in and out.</p>
            <dl class="as-qfacts">
              <div><dt>Add task</dt><dd>files work into THIS assistant's queue, the one this page belongs to, so a task cannot be created into a queue nobody is watching.</dd></div>
              <div><dt>Move</dt><dd>the control on an existing row: the task leaves this queue, arrives in that assistant's with an id of its own, recorded as <code>movedFrom</code>.</dd></div>
              <div><dt>Order</dt><dd>drag a queued card — the order is written to the file and survives the next read; running, parked and done keep their own sections, and a card with a <code>held by #N</code> badge cannot go above that row.</dd></div>
              <div><dt>Waiting and STALE</dt><dd>a queued task whose files touch a running task's files is shown skipped with its reason; a running task whose thread has no live run reads STALE, not phantom progress.</dd></div>
              <div><dt>Where it lives</dt><dd><code>state/assistants/${esc(id)}/queue.json</code> beside the charter, read on every wake before the board; the digest names each task's state, thread, worktree, PR and why it is not going (LIVE, STALE or PARKED).</dd></div>
            </dl>
          </div>
        </details>
        <details class="as-qadd">
          <summary title="file a task into this assistant's own queue — one press opens the form">+ Add task</summary>
          <div class="as-line"><label class="as-grow" title="what has to happen — one line is enough">title <input type="text" id="as-qtitle-${esc(n)}" class="as-grow" spellcheck="false" maxlength="200" placeholder="e.g. land the queue sub-tab's PR"></label></div>
          <div class="as-line"><label class="as-grow" title="optional: the detail an assistant needs to do it without asking">detail <input type="text" id="as-qdetail-${esc(n)}" class="as-grow" spellcheck="false" maxlength="400" placeholder="optional"></label></div>
          <div class="as-line"><label title="optional: comma-separated paths this task will touch — a queued task that overlaps a running task's files is skipped with the reason">files <input type="text" id="as-qfiles-${esc(n)}" spellcheck="false" maxlength="300" placeholder="lib/assistant/queue.js, public/assistant.js"></label>
            <button type="button" class="primary" data-as-qact="add" data-as-qown="${esc(id)}" title="add this task to ${esc(rec?.name || "this assistant")}'s own queue">Add task</button>
            <span class="as-err" id="as-qerr-${esc(n)}">${cached?.error ? esc(cached.error) : ""}</span>
          </div>
        </details>
        ${queueStateHtml(pane, { id, n, view, rows: sorted })}
        ${dropNote ? `<div class="as-qdrop" data-as-qdrop="${esc(id)}" role="status">${esc(dropNote)}</div>` : ""}
        ${visible.map((t) => queueTaskHtml(id, t, queueJobs.byThread, byId, state.assistant?.alerts || [])).join("")}
        ${queueMoreHtml(id, hidden)}
      </div>`;
  }

  function loadQueue(id = activeSessionId()) {
    // ONE read per assistant at a time. A paint that arrives while a read is in flight joins that read instead of
    // starting a second: the pane is repainted by the board poll and by the read's own completion, so without this
    // guard an answer that lands in 62 ms could start a request per paint.
    const running = queueInflight.get(id);
    if (running) return running;
    const seq = (queueSeq.get(id) || 0) + 1;
    queueSeq.set(id, seq);
    const fresh = () => seq === (queueSeq.get(id) || 0);
    const prior = queueCache.get(id);
    queueCache.set(id, { ...prior, loading: true, error: null });
    // The pane is painted by the caller; this only refreshes the cache and asks for one repaint of the pane the reader
    // is looking at. A second tab's answer repaints nothing.
    const read = apiFetch(`/api/assistant/queue?assistantId=${encodeURIComponent(id)}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        if (d.assistant) applyAssistant(d.assistant);
        if (!fresh()) return; // a newer read or a write has landed; this answer describes a moment already gone
        queueCache.set(id, { view: d.queue, error: null, loading: false, at: Date.now() });
      })
      .catch((err) => {
        if (!fresh()) return;
        const last = queueCache.get(id) || {};
        queueCache.set(id, { ...last, loading: false, error: String((err && err.message) || err), at: Date.now() });
      })
      .finally(() => {
        queueInflight.delete(id);
        // WITHOUT force. A forced repaint calls loadQueue again, and a read that repaints itself by force is a spinner
        // with no end — that was the defect: the pane never left "reading its queue…" and every superseded answer was
        // dropped by the sequence guard. An empty store and a failed read are STATES the pane draws, not reasons to
        // read again; Retry is the reader's own second attempt.
        const view = state.assistantView;
        if (view && view.subTab === "queue" && view.assistant === id) renderAssistantQueue(id);
      });
    queueInflight.set(id, read);
    return read;
  }

  // GET /api/jobs, indexed by thread and keeping that thread's NEWEST turn — the same "latest" the card's head reads,
  // and the reason the queue does not ask the task record what its agents are doing. The answer cannot fail a paint:
  // a refused read leaves the last map in place, so the pane keeps the words it had rather than claiming everything
  // stopped. The clock is stamped on the way out either way, which is what stops a failing route from being retried on
  // every repaint.
  function loadQueueJobs() {
    if (queueJobs.inflight) return queueJobs.inflight;
    const read = apiFetch("/api/jobs")
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        const byThread = new Map();
        for (const j of Array.isArray(d.jobs) ? d.jobs : []) {
          const thread = String(j.thread || "");
          if (!thread) continue;
          const prev = byThread.get(thread);
          if (!prev || String(j.startedAt || "").localeCompare(String(prev.startedAt || "")) >= 0) byThread.set(thread, j);
        }
        queueJobs.byThread = byThread;
      })
      .catch(() => {
        /* keep the last answer: an unreadable route is not every run having stopped */
      })
      .finally(() => {
        queueJobs.at = Date.now();
        queueJobs.inflight = null;
        // One repaint of the pane on screen, WITHOUT force: a forced paint asks for a read, and a read that repaints
        // itself by force is the spinner the queue pane was fixed for once already.
        const view = state.assistantView;
        if (view && view.subTab === "queue" && isAssistant(view.assistant)) renderAssistantQueue(view.assistant);
      });
    queueJobs.inflight = read;
    return read;
  }

  // Which row's picker is open is the record above; this paints the DOM from it, so opening one closes the other and a
  // repaint (which rebuilds the markup with `hidden` already right) needs no special case.
  function paintQueueMove() {
    for (const pop of document.querySelectorAll("[data-as-qmove-pop]")) {
      const on = qmoveOpen.has(String(pop.dataset.asQmovePop || ""));
      pop.hidden = !on;
      const btn = pop.parentElement ? pop.parentElement.querySelector("[data-as-qmove-open]") : null;
      if (btn) btn.setAttribute("aria-expanded", on ? "true" : "false");
    }
  }
  function closeQueueMove() {
    if (!qmoveOpen.size) return;
    qmoveOpen.clear();
    paintQueueMove();
  }
  // One picker at a time: opening a second one closes the first, and pressing the open one's ➡️ closes it. A pick is a
  // plain data-as-qact="reassign" press with data-as-qmove-to, so the write path below is the same route it always was.
  function toggleQueueMove(key) {
    const k = String(key || "");
    if (!k) return;
    if (qmoveOpen.has(k)) qmoveOpen.delete(k);
    else {
      qmoveOpen.clear();
      qmoveOpen.add(k);
    }
    paintQueueMove();
  }

  async function queueAct(id, action, body = {}) {
    try {
      const d = await asPost("/api/assistant/queue", { assistantId: id, action, ...body });
      // The route answers with the assistant's whole state and the queue it just wrote, so the pane repaints from the
      // same answer the tab would have fetched — no second read, and no window where the row says "running" while the
      // file says "queued".
      // A read that was already in flight when this write landed describes the queue as it was BEFORE the write, so
      // this write supersedes it rather than letting it repaint the old list over the new one.
      queueSeq.set(id, (queueSeq.get(id) || 0) + 1);
      if (d.queue) queueCache.set(id, { view: d.queue, error: null, loading: false, at: Date.now() });
      // A Move answers with the queue the task landed in as well. Caching it keeps the OTHER assistant's pane honest
      // without a second request — and a read of that pane already in flight describes the queue before the move, so it
      // is superseded rather than allowed to repaint the target's list without the row that just arrived.
      if (d.movedTo?.assistantId) {
        queueSeq.set(d.movedTo.assistantId, (queueSeq.get(d.movedTo.assistantId) || 0) + 1);
        queueCache.set(d.movedTo.assistantId, { view: d.movedTo, error: null, loading: false, at: Date.now() });
      }
      renderAssistantQueue(id, true);
      return d;
    } catch (err) {
      setErr(`as-qerr-${String(id).replace(/^assistant-/, "")}`, String((err && err.message) || err));
      return null;
    }
  }
  // ---- dragging a card into a new place ------------------------------------------------------------
  //
  // The order the pane draws is state bucket → `order` → id, so a drag only ever changes the middle term, and only
  // inside the QUEUED bucket: running, parked and done cards are not `.is-draggable` and never start a gesture. The
  // card itself is what moves — the pointer crossing a queued card's midpoint re-inserts it before that card, and the
  // transform keeps it under the pointer across the reflow — so what the reader sees before the drop is the list the
  // drop sends.
  //
  // Two rules make this safe beside a body that is itself a click target:
  //   - nothing happens until the pointer has TRAVELLED (4 px): a press and a release on the spot is the reader's
  //     click, and it reaches the opener untouched;
  //   - the click the browser fires at the end of a drag is swallowed by `queueCardClickGuard`, judged by the clock
  //     `queueDragEnded` stamps. A drag must never open a card.
  const QUEUE_DRAG_THRESHOLD = 4;

  // ---- the pane's own edge: a held gesture scrolls the list -----------------------------------------
  //
  // The pane is usually SHORTER than the queue — nine queued cards in the 480 px rail are taller than the window it
  // draws — and a pointer cannot travel past the edge of the box it is in. Without the crawl below, a card could only
  // be put where a visible card is: the pointer stopped at the edge and the drop landed on whatever midpoint it had
  // last crossed, while the reader was aiming at a row further down. That is the reader's "it does not drag and drop
  // like it says", so the frame loop is part of the gesture, not a decoration on it.
  //
  // The edge band is measured on the SCROLLER, not the pane: the rail and the float both scroll in `.as-body`, and a
  // narrow enough window falls back to the document, so the walk starts at the pane and takes the first ancestor that
  // can actually move. Speed ramps from nothing at the band's inner edge to full at the box's edge, which is what makes
  // a small overshoot crawl and a deliberate one travel.
  const QUEUE_SCROLL_EDGE = 26;
  const QUEUE_SCROLL_STEP = 14;
  let queueDragRaf = 0;
  function queueScrollerOf(el) {
    for (let n = el?.closest?.('[data-subpane="queue"]') || null; n && n !== document.body; n = n.parentElement) {
      if (!/(auto|scroll)/.test(getComputedStyle(n).overflowY)) continue;
      if (n.scrollHeight <= n.clientHeight + 1) continue;
      return n;
    }
    const doc = document.scrollingElement;
    return doc && doc.scrollHeight > doc.clientHeight + 1 ? doc : null;
  }
  function queueScrollBy(d, dy) {
    const s = d.scroller;
    if (!s) return 0;
    const before = s.scrollTop;
    s.scrollTop = Math.max(0, Math.min(s.scrollHeight - s.clientHeight, before + dy));
    return s.scrollTop - before;
  }
  // Where the card lands, and where it is drawn. Split out because a scroll moves the LIST under a pointer that has
  // not moved: the same decision has to run again with the pointer where it already is.
  function queueDragPaint(d, clientY) {
    // Where the card would land: before the first queued card whose midpoint the pointer has passed, else after the
    // last one. Only queued cards take part — the three fixed sections never swap places with the drag.
    const cards = queueCardsIn(d.el).filter((c) => c !== d.el && c.dataset.asQstate === "queued");
    const at = cards.find((c) => {
      const box = c.getBoundingClientRect();
      return clientY < box.top + box.height / 2;
    });
    if (at) {
      if (d.el.nextElementSibling !== at) at.parentElement.insertBefore(d.el, at);
    } else if (cards.length) {
      const last = cards[cards.length - 1];
      if (d.el.previousElementSibling !== last) last.parentElement.insertBefore(d.el, last.nextElementSibling);
    }
    // Re-anchor under the pointer: a DOM move changes the card's layout top, and the transform is measured from that
    // top, so it is recomputed from the box the browser just laid out rather than accumulated from deltas.
    const layoutTop = d.el.getBoundingClientRect().top - d.translate;
    d.translate = Math.round(clientY - d.grab - layoutTop);
    d.el.style.transform = `translateY(${d.translate}px)`;
  }
  function queueDragFrame() {
    const d = queueDrag;
    if (!d || !d.moved) {
      queueDragRaf = 0;
      return;
    }
    let dy = 0;
    const box = d.scroller?.getBoundingClientRect?.();
    if (box && box.height > 0) {
      const top = box.top + QUEUE_SCROLL_EDGE;
      const bottom = box.bottom - QUEUE_SCROLL_EDGE;
      if (d.y < top) dy = -Math.ceil(QUEUE_SCROLL_STEP * Math.min(1, (top - d.y) / QUEUE_SCROLL_EDGE));
      else if (d.y > bottom) dy = Math.ceil(QUEUE_SCROLL_STEP * Math.min(1, (d.y - bottom) / QUEUE_SCROLL_EDGE));
    }
    // The crawl only re-decides the drop when it actually moved the list: a pointer parked far from either edge costs
    // one comparison a frame and nothing else.
    if (dy && queueScrollBy(d, dy)) queueDragPaint(d, d.y);
    queueDragRaf = requestAnimationFrame(queueDragFrame);
  }
  const queueDragScrollStart = () => {
    if (!queueDragRaf) queueDragRaf = requestAnimationFrame(queueDragFrame);
  };
  const queueDragScrollStop = () => {
    if (queueDragRaf) cancelAnimationFrame(queueDragRaf);
    queueDragRaf = 0;
  };

  function queueCardDown(e) {
    if (queueDrag || e.button !== 0) return;
    const el = e.target?.closest?.(".as-task.is-draggable");
    if (!el) return;
    // A press on a control is that control's, not the card's: the glyphs, the Move popover, any field — and the
    // row's own disclosure, whose summary must toggle instead of starting a drag.
    if (e.target.closest("button, a, input, select, textarea, label, .as-qmove-pop, summary, .as-task-more")) return;
    const rect = el.getBoundingClientRect();
    queueDrag = {
      el,
      own: String(el.dataset.asQown || ""),
      // The box a held gesture has to crawl. Measured once: the frame it has to move cannot change mid-press without
      // the pane being rebuilt, and the pane is not rebuilt while a drag is live.
      scroller: queueScrollerOf(el),
      startY: e.clientY,
      y: e.clientY,
      grab: e.clientY - rect.top,
      translate: 0,
      moved: false,
      before: queueIdsIn(el),
    };
    // No text selection and no native drag for the length of the press: without this the browser starts selecting the
    // card's own text the moment the pointer moves.
    e.preventDefault();
  }

  function queueCardMove(e) {
    const d = queueDrag;
    if (!d) return;
    if (!d.moved) {
      if (Math.abs(e.clientY - d.startY) < QUEUE_DRAG_THRESHOLD) return;
      d.moved = true;
      d.el.classList.add("is-dragging");
      d.el.closest('[data-subpane="queue"]')?.classList.add("as-qdrag");
      queueDropNotes.delete(d.own);
      // The crawl starts with the gesture and runs until the release, so a pointer held still at the pane's edge keeps
      // travelling: a reader waits for the list, they do not shake the card at it.
      queueDragScrollStart();
    }
    d.y = e.clientY;
    queueDragPaint(d, e.clientY);
  }

  async function queueCardUp(cancelled = false) {
    const d = queueDrag;
    if (!d) return;
    queueDrag = null;
    queueDragScrollStop();
    const el = d.el;
    el.classList.remove("is-dragging");
    el.style.transform = "";
    el.closest('[data-subpane="queue"]')?.classList.remove("as-qdrag");
    // A press that never travelled is the reader's click: the opener on the body gets it, untouched.
    if (!d.moved) return;
    // From here on, the click the browser fires at the end of this gesture belongs to the drag.
    queueDragEnded = Date.now();
    if (cancelled) {
      // The browser took the gesture back — a touch scroll, a lost pointer. Nothing the reader chose happened, so the
      // card goes back where it was and NOTHING is written: committing the DOM's half-finished order would reorder the
      // queue on a scroll.
      renderAssistantQueue(d.own);
      return;
    }
    const ids = queueIdsIn(el);
    if (!ids.length || ids.join(",") === d.before.join(",")) {
      // Nothing moved: a paint from the cache is the honest answer, not a write that says "the order did not move".
      renderAssistantQueue(d.own);
      return;
    }
    const rows = queueCache.get(d.own)?.view?.tasks || [];
    const blocked = queueDropBlocked(rows, ids);
    if (blocked) {
      // Snap back: the cache still holds the order before the drag, so one paint from it restores the list — and the
      // one line says which row is holding the card that was dropped.
      queueDropNotes.set(d.own, blocked.line);
      renderAssistantQueue(d.own);
      return;
    }
    queueDropNotes.delete(d.own);
    const out = await queueAct(d.own, "reorder", { ids });
    // A refusal — the server's own copy of the rule, or a list a stale pane got past — snaps back the same way: the
    // cache is the order the server last confirmed.
    if (!out) renderAssistantQueue(d.own);
  }

  // The browser fires a click at the end of a drag as well: the pointer went down and came up over a card, and that is
  // the whole of its test. This is the one place that knows a drag happened, so it swallows that click in the CAPTURE
  // phase, before the row body's own opener (a bubble listener on the same float) can see it.
  function queueCardClickGuard(e) {
    if (!queueDragEnded) return;
    if (Date.now() - queueDragEnded > 600) return;
    if (!(e.target?.closest?.(".as-task"))) return;
    queueDragEnded = 0;
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  // ---- end the queue sub-tab --------------------------------------------------------------------

  // The names the panel keeps reading after the move: the paint and its two reads, the one write path, the re-attach
  // press, the order's own constants, the picker's record, the drag's functions, and the one line of drag state a
  // fresh press clears.
  return {
    renderAssistantQueue, loadQueue, queueAct, queueReattach,
    QUEUE_LIVE, qmoveOpen, closeQueueMove, toggleQueueMove,
    queueDropNotes, queueShown, queueWindowOf, QUEUE_MORE,
    queueCardDown, queueCardMove, queueCardUp, queueCardClickGuard,
    queueDragReset: () => {
      queueDragEnded = 0;
    },
  };
};
