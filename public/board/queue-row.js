// queue-row.js - one assistant's task QUEUE as a column of cards: the pane's state, the row and its head, the chips
// that say what a row is waiting on, the agents under a task, and the order the reader put it in. Cut out of
// public/queue-cards.js, which is entry 8 of docs/reports/module-separation-2026-11-28.html's split plan
// (public/board/queue-row.js, from the lines the report measured as 62-529 of a 1,307-line file).
//
// WHY THIS FILE EXISTS. public/queue-cards.js was one 1,254-line closure with 73 internal bindings: the row, the full
// card, the drag, the paint, the two reads and the one write path all shared one scope, so a row that changed a chip
// and a row that changed the drag opened the same file. The report splits it three ways, one file per thing a row
// changes. This is the first cut: the state a queue read fills, the row that draws it, and the order the reader put
// the cards in. Not one body was rewritten and not one call site was touched.
//
// WHAT IS HERE
//
//   the pane's state          the cache of one assistant's queue read, one read in flight per assistant and the
//                             sequence counter that keeps an old answer from painting over a new write, the job map
//                             behind the agent chips, the window of rows drawn, and the one line a refused drop leaves.
//                             (The drag record, the two `let`s the gesture itself assigns, stayed in
//                             public/queue-cards.js: the drag's own cut has not happened yet.)
//   the task index            whose row a `#405` is, and the press that follows one into its row.
//   the row                   the head's own pieces: the state in a word and what it is waiting on, the lane chip,
//                             the hold badge, the question chip and its alert lookup, the project name, and the
//                             agents under the task (queueAgentHtml, its status chip and its re-attach pill).
//   the order                 QUEUE_BUCKET, queueOrderOf and queueSorted: state bucket first, then the place a card
//                             was dragged to, then the id. queueDropBlocked is the rule a drop is judged by, and
//                             queueCardsIn/queueIdsIn are the pane's own list read back as cards and as ids.
//
// queueProjectName came with this cut although it sat further down the file: the agent row is one of its two callers
// (the full card is the other), and it is the row's own fact - which project a card is about - so it travels with
// the row rather than being handed across the seam four times a paint.
//
// WHAT IT REACHES OUT FOR (by name, at call time, exactly as before the move)
//
//   the panel's own helpers   sessionById, assistantThreadName, isAssistant and hostFor, from public/assistant.js's
//                             IIFE, handed in as this factory's argument.
//   THREE NAMES IT DOES NOT OWN, handed in as `deps.later` because the entry point builds this cut FIRST and the cuts
//                             that own them come after it: renderAssistantQueue and loadQueue (the paint and the
//                             read, in public/board/queue-detail.js) and queueScrollerOf (the pane's own scroller, in
//                             public/board/queue-drag.js). Each is a thunk over the entry point's own record, so the
//                             bodies below keep the spellings they had in the one closure.
//   esc, state                public/app.js's escaping and page state: the pane reads state.assistant, and every row is
//                             built with esc. apiFetch, relTime, restartClassAnimation, flashRowMs and CSS likewise
//                             resolve from the page at call time and are not passed.
//
// THE LOAD CONTRACT. This file declares ONE thing: a factory. public/index.html loads it before public/queue-cards.js,
// and that entry point calls it once and hands the queue's names back under exactly the spellings the call sites
// already use. Nothing here reads an app.js binding while it loads: the factory only builds maps and declares
// functions. The queue sub-tab marker pair below is the test harnesses' slice, kept verbatim from the file
// this cut came out of so the existing slice tests still find the code they drive.


window.WMApp = window.WMApp || {};
window.WMApp.queueRow = function queueRow(deps) {
  "use strict";
  const { sessionById, assistantThreadName, isAssistant, hostFor } = deps;
  const { renderAssistantQueue, loadQueue, queueScrollerOf } = deps.later;

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
  const queueDropNotes = new Map(); // assistantId -> the sentence a blocked drop left on the pane
  // How much of the FINISHED history the pane draws. A queue holds up to 200 tasks and the pane is rebuilt on every
  // board tick and after every action, so drawing the whole history is a page nobody reads and a DOM the poll keeps
  // paying for. The window lives HERE, outside the painter, keyed by assistant: a repaint reads it back instead of
  // starting at 20 again.
  //
  // IT NEVER APPLIES TO AN OPEN ROW, and that was the defect the reader photographed on 2026-11-28: the window counted
  // from the newest task ID, so a RUNNING row whose id was older than the twenty newest (#402, #404 and #411, three live
  // runs) had no card at all while the caption above it - built from the store's own counts - read "5 running". The tab
  // is the work the assistant is CARRYING, so every queued, running and parked row is drawn; the history is the only
  // thing a window may hide, and the note under the list says how much of it.
  const QUEUE_FIRST = 20;
  const QUEUE_MORE = 50;
  const queueShown = new Map(); // assistantId -> how many of the newest FINISHED tasks the pane draws
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
  // The window's rows in DRAWING order. Every OPEN row first, always, in `queueSorted`'s order (a queued card's drag
  // position is the reader's); then the finished bucket, newest first, down to the window. "Load 50 more" appends older
  // finished rows UNDER the ones on screen instead of inserting them out of sight above.
  const queueWindowRows = (sorted, shown) => {
    const rows = Array.isArray(sorted) ? sorted : [];
    const open = rows.filter((t) => t.state !== "done");
    const finished = rows.filter((t) => t.state === "done");
    const ids = queueWindowIds(finished, shown);
    return [...open, ...finished.filter((t) => ids.has(String(t.id))).sort((a, b) => Number(b.id) - Number(a.id))];
  };
  // The queue file's stamp, off the assistant row the board already carries. It is the server's own mtime+size for
  // state/assistants/<id>/queue.json (lib/assistant/queue.js `readQueueFile`), so it moves on ANY write - this panel's,
  // a script's, another panel's - which is what a clock cannot tell the pane. "" when the payload names none, and that is
  // not "unchanged": the twenty-second clock is then the only guard, exactly as it was before the stamp existed.
  const queueStampOf = (id) => String(sessionById(id)?.queueStamp || "");

  // ---- a task id is a reference into this pane -------------------------------------------------------
  //
  // The assistant's own prose can say `#405`, and `#405` names one row of ONE assistant's queue. Two questions are
  // answered here, and they are deliberately separate:
  //
  //   WHOSE ROW IS IT (`taskOwnerOf`) is read at RENDER time, when the console turns the words into an anchor
  //   (public/core/console-markdown.js). It answers from every queue this tab holds, and only when exactly ONE
  //   assistant owns the id: each assistant's queue numbers its own tasks, so two queues can both hold a `#405`, and
  //   a guess would send the reader to the wrong list. No owner, or two, is null - the words stay plain.
  //
  //   WHERE IS THE ROW (`queueOpenTask`) is answered at PRESS time, when the reader follows the anchor. A row can be
  //   in the queue and outside the window the pane draws, or the queue can be one this tab never read; both are
  //   fixed here, with ONE read and no loop.
  //
  // The attribution is warmed by ONE list read of every queue (`GET /api/assistant/queue` with no id). It is what
  // fills each assistant's cache too, so a press on a fresh page usually has its row already; the read is throttled
  // and single-flight, so a paint that arrives while it is out joins it instead of starting another.
  const TASK_INDEX_TTL = 20000;
  const taskIndex = { at: 0, inflight: null };
  // The attribution, and the signature it was built from. The signature is cheap (one number per cached queue) and
  // changes whenever a cache is replaced, which is every read and every write: no call site has to remember to tell
  // this map that the queues moved.
  let taskOwnersMemo = { sig: "", byId: new Map() };
  const taskIndexSig = () =>
    [...queueCache.keys()]
      .sort()
      .map((k) => `${k}:${queueCache.get(k)?.at || 0}`)
      .join("|");
  function taskOwnersById() {
    const sig = taskIndexSig();
    if (sig === taskOwnersMemo.sig) return taskOwnersMemo.byId;
    const byId = new Map();
    for (const [own, cached] of queueCache) {
      for (const t of Array.isArray(cached?.view?.tasks) ? cached.view.tasks : []) {
        const id = String(t?.id ?? "");
        if (!id) continue;
        const owners = byId.get(id) || new Set();
        owners.add(own);
        byId.set(id, owners);
      }
    }
    taskOwnersMemo = { sig, byId };
    return byId;
  }
  // The assistant that owns a task id, or null when none or more than one does. Never a guess.
  function taskOwnerOf(taskId) {
    const id = String(taskId ?? "").trim();
    if (!id) return null;
    const owners = taskOwnersById().get(id);
    if (!owners || owners.size !== 1) return null;
    const [own] = owners;
    return isAssistant(own) ? own : null;
  }
  // The transcript's own repaint key: a card drawn before this answer landed carries the plain words it could
  // honestly draw then, and the string moving is what tells it to draw them again.
  const taskIndexRev = () => taskIndexSig();
  function ensureTaskIndex() {
    if (taskIndex.inflight) return taskIndex.inflight;
    if (taskIndex.at && Date.now() - taskIndex.at < TASK_INDEX_TTL) return Promise.resolve(false);
    taskIndex.at = Date.now();
    const read = apiFetch("/api/assistant/queue")
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        let changed = false;
        for (const q of Array.isArray(d.queues) ? d.queues : []) {
          const own = String(q?.assistantId || "");
          // A queue this tab already holds is NOT replaced: the pane's own read is the copy the reader is looking
          // at, and an index answer that left the server a moment earlier must not paint over it.
          if (!own || queueCache.get(own)?.view) continue;
          queueCache.set(own, { view: q, error: null, loading: false, at: Date.now() });
          changed = true;
        }
        if (changed) {
          // The anchors are built while the console renders, so the cards already on screen are asked to draw
          // again. public/assistant.js owns that paint; this is the one thing it is told.
          document.dispatchEvent(new CustomEvent("wtgui:task-index", { detail: { rev: taskIndexRev() } }));
        }
        return changed;
      })
      .catch(() => false)
      .finally(() => {
        taskIndex.inflight = null;
      });
    taskIndex.inflight = read;
    return read;
  }
  // Follow a `#405` into its row: widen the window if the row is known but not drawn, ONE read if the queue is not
  // in this tab (or does not have the id), then centre the row in the pane's scroller and pulse it. True when the
  // row was found and flashed.
  async function queueOpenTask(own, taskId) {
    const id = String(taskId ?? "").trim();
    if (!id || !isAssistant(own)) return false;
    const find = () => hostFor(own, "queue")?.querySelector(`.as-task[data-as-qrow="${CSS.escape(id)}"]`) || null;
    // A row the window leaves out is still in the cache. The window counts newest first, so the target's own
    // position in that order (plus one) is the smallest window that draws it - no wider than it has to be.
    const reveal = () => {
      const rows = Array.isArray(queueCache.get(own)?.view?.tasks) ? queueCache.get(own).view.tasks : [];
      const newest = rows.slice().sort((a, b) => Number(b.id) - Number(a.id)).map((t) => String(t.id));
      const at = newest.indexOf(id);
      if (at < 0 || at + 1 <= queueWindowOf(own)) return false;
      queueShown.set(own, at + 1);
      renderAssistantQueue(own);
      return true;
    };
    let row = find();
    if (!row && reveal()) row = find();
    if (!row) {
      await loadQueue(own);
      reveal();
      row = find();
    }
    if (!row) {
      // Still nothing: the read has just been made and the id is not in it. Say so rather than pulse nothing.
      queueDropNotes.set(own, `task #${id} is not in this queue: it has just been read again, and #${id} is not in it.`);
      renderAssistantQueue(own);
      return false;
    }
    queueDropNotes.delete(own);
    // The scroll is the PANE's, not the page's: the float is a column with its own scroller, and scrollIntoView would
    // move the board under it as well. Centre the row in that scroller.
    const scroller = queueScrollerOf(row);
    if (scroller) {
      const top = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      const want = top - (scroller.clientHeight - row.offsetHeight) / 2;
      scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, want));
    } else {
      row.scrollIntoView({ block: "center", inline: "nearest" });
    }
    // The chart's own green pulse, on this row: the same @keyframes flashrow the table flashes a row with, and the
    // class carries the card's own resting colour so the fade ends where the card started (see public/style.css).
    restartClassAnimation(row, "flash", "flashrow");
    clearTimeout(row._asFlash);
    row._asFlash = setTimeout(() => row.classList.remove("flash"), flashRowMs() + 60);
    return true;
  }

  const queueMark = (state) => (state === "done" ? "✓" : state === "parked" ? "⏸" : state === "running" ? "●" : "○");
  const queueStateName = (state) => (state === "running" ? "running" : state === "parked" ? "parked" : state === "done" ? "done" : "queued");
  // The word in the head is a STATUS, and hover is where it explains itself: a reader who does not know what "parked"
  // means here gets the rule without a paragraph under every row. The compact card passes `compact`, because the one
  // affordance it does not have is the drag: a tooltip promising one would be a control the card never draws.
  const queueStateTitle = (t, compact = false) =>
    t.stale
      ? `stale — the file still says running, but ${String(t.staleWhy || "its thread has no live run").replace(/^that thread/, "its thread")}`
      : t.state === "running"
        ? t.runBy === "run" && t.runId
          ? `running — run ${t.runId} is ${t.runStatus || "live"}: the row's verdict is read from that run, not from the thread it shares`
          : t.runBy === "round"
            ? `running - the round's ${t.runStage ? `stage ${t.runStage}` : "work"} is live${t.runThread ? ` on ${t.runThread}` : ""}: a pipeline row's verdict is read from its round's stage runs, not from the thread it started on`
            : t.guessed
              ? "running — a run is carrying it, but the row names no run id: this verdict is a guess from its tree path or thread"
              : "running — a run is carrying it; its agent's own status is on the facts line"
        : t.state === "parked"
          ? "parked — stopped until the condition in the note is released; nothing starts it by itself"
          : t.state === "done"
            ? "done — the record of finished work; it stays in place, dimmed, and can be re-queued"
            : compact
              ? "queued - not started; its queue is where it is started, parked or put in order"
              : "queued — not started; drag the card to change its place, and a card held by another row cannot go above it";
  // What a row is waiting on, in the row's head: the LIVE peer it shares a file with. `waitingOn` and `lane` are
  // DERIVED by the store (lib/assistant/queue.js's laneInfo) - this draws the fact the digest already carries, in three
  // words, with the file the pair collide on in title= so the row stays one line.
  function queueLaneChip(t) {
    const w = t?.waitingOn;
    const at = Number(w?.id);
    if (!Number.isFinite(at) || at <= 0) return "";
    const file = String(w?.file || w?.lane || "").trim();
    const title = `waiting on #${at}${file ? ` - #${at} is live on ${file}` : ""}: this row claims the same file, so it waits until #${at} ends and lands`;
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
  // The RUN ID rides at the END of the row, after the agent's own status chip: a thread is not one run (two records
  // can share one slug - a failed attempt and its live retry), and the id is the only thing on the card that says
  // which record the row's verdict was read from. It trails the row so the id is read last, after the branch, the
  // title, the landing and the status, and it is never mistaken for the agent's name. A row with no run id says
  // `guessing` in the same slot instead of letting a thread match pass for evidence.
  // WHERE THIS AGENT'S WORK IS. The task's `worktree` is one path that moves with the newest link, so on its own it
  // cannot say where an earlier agent ran. `where` is this thread's own recorded tree (lib/assistant/queue.js
  // `threadTrees`), read back through the board row: the project it belongs to and how that tree LANDS - the verdict
  // for every kind (a research or implementation tree lands by merging locally, a turnover tree also carries a PR).
  // Absent when the queue never wrote a tree for this thread: the line then falls back to the task's own project for
  // the `project:branch` label, and this sentence draws nothing extra, because an absence is not a landing.
  //
  // The PROJECT is not in this sentence any more. It leads the line instead (`agent-worktree-gui:<branch>`, built in
  // queueAgentHtml), where it is read first and cannot be confused with the verdict; the late `project <name>`
  // fragment a reader photographed half way along the row is gone, the word included. The title keeps the tree path,
  // so a reader who wants the project spelled out still finds it one hover away.
  function queueAgentWhere(where) {
    if (!where) return "";
    const parts = [];
    if (where.verdict) parts.push(String(where.verdict));
    if (where.pr?.number) parts.push(`PR #${where.pr.number} ${String(where.pr.state || "").toLowerCase()}`.trim());
    if (!parts.length) return "";
    const text = parts.join(" · ");
    const title = `the tree this agent ran in${where.kindLabel ? ` (${where.kindLabel})` : ""}${where.path ? `: ${where.path}` : ""}. ${where.verdict ? `It lands as ${where.verdict}.` : "Its landing was not read."}${where.pr?.number ? ` Pull request #${where.pr.number} is ${String(where.pr.state || "in an unknown state").toLowerCase()}.` : ""}`;
    return `<span class="as-task-agent-where" title="${esc(title)}">${esc(text)}</span>`;
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

  function queueAgentHtml(id, t, thread, jobs, where = null) {
    const threads = Array.isArray(t?.threads) && t.threads.length ? t.threads.filter(Boolean) : t?.thread ? [t.thread] : [];
    const current = threads.length ? threads[threads.length - 1] : "";
    const onCurrent = thread === current;
    // The row's OWN run is what its chip says when the row names one and the verdict came from it (queue.js's
    // `runningFlag`). A pipeline row whose verdict came from its ROUND says the round's job in the same slot: the run
    // the row names is the link it started on, and it is not the one going. Otherwise the chip keeps reading the
    // newest turn on the thread, which is the old behaviour.
    const roundLive = onCurrent && String(t?.runBy || "") === "round" && Boolean(t?.runJob) && !t?.guessed;
    const rowRun = onCurrent && t?.state !== "queued" && roundLive ? { status: t.runStatus } : onCurrent && t?.runId && String(t?.runBy || "") === "run" ? { status: t.runStatus } : null;
    const job = rowRun || (jobs && typeof jobs.get === "function" ? jobs.get(thread) : null);
    const chip = queueAgentChip(job);
    // THE LINE LEADS WITH WHERE THE WORK IS: `<project>:<branch>`, read before the title, the landing or the status.
    // The thread's own recorded tree wins, because two agents on one card can be in two projects; a thread the queue
    // never recorded a tree for falls back to the task's project, which the panel wrote when it cut the task. With
    // no project anywhere the line keeps its bare thread, because a guessed project reads exactly like a fact.
    const project = String(where?.project || queueProjectName(t) || "").trim();
    const threadText = project ? `${project}:${thread}` : thread;
    const label = String(assistantThreadName(thread) || "").trim();
    const named = label && label !== thread;
    const open = `data-as-qopen="${esc(thread)}" data-as-qid="${esc(String(t.id))}"`;
    const title = `open ${named ? `“${label}” ` : ""}(${thread})'s card and its current console turn — this agent's run is ${chip.word}, read from /api/jobs`;
    // What the row is ON, in the one word an id can be: the run id itself. Absent from a queued row (nothing is
    // running it), present on a running or parked one, and the record on a done one. `guessing` is the same slot with
    // the opposite claim: there is no run id, so the state above it was inferred from the tree path or the thread.
    // A pipeline row read from its round shows the ROUND's job, because that is the run the verdict was read from.
    const chipId = roundLive ? String(t.runJob) : String(t.runId || "");
    const runChip =
      onCurrent && chipId && t?.state !== "queued"
        ? `<span class="as-task-agent-run" data-as-qrun="${esc(chipId)}" title="${esc(
            roundLive
              ? `run ${chipId} - the run the round's ${t.runStage ? `stage ${t.runStage}` : "work"} is on${t.runThread ? ` (${t.runThread})` : ""}; the row's running/stale verdict is read from the round's stage runs, not from the thread it started on`
              : `run ${chipId} — the run this row names; ${t.state === "running" ? `its status (${t.runStatus || "unknown"}) is what the row's running/stale verdict is read from` : "kept as the record of the run this row was last on"}`,
          )}">${esc(chipId.length > 24 ? `${chipId.slice(0, 23)}…` : chipId)}</span>`
        : onCurrent && t?.state === "running" && t?.guessed
          ? `<span class="as-task-agent-run is-guess" title="${esc(
              `no run id on this row — the running/stale verdict is a GUESS from ${t.runBy === "thread" ? `its thread (${thread})` : t.runBy === "round" ? "a thread the round names" : "a live run in its tree path"}; the next cut or resume writes the run id, and then this is evidence`,
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
            <code class="as-task-agent-thread" title="${esc(threadText)}">${esc(threadText)}</code>
            ${named ? `<span class="as-task-agent-label">${esc(label)}</span>` : ""}
            ${queueAgentWhere(where)}
            ${pill}
            ${runChip}
          </div>`;
  }

  // ---- end the queue sub-tab --------------------------------------------------------------------

  // What the entry point hands on: the public surface this cut owns, the state the other two cuts are handed
  // (the read cache and the one line a refused drop leaves), and the row helpers the full card in
  // public/board/queue-detail.js calls when it draws the head.
  return {
    // the public surface: the state of a row, the order, the one card's chips and the task id's own answer
    QUEUE_LIVE, queueDropNotes, queueShown, queueWindowOf, QUEUE_MORE,
    taskOwnerOf, taskIndexRev, ensureTaskIndex, queueOpenTask,
    // the state the other two cuts read and write, handed over rather than declared twice
    queueCache, queueSeq, queueInflight, qmoveOpen, queueJobs, QUEUE_FIRST,
    queueWindowRows, queueStampOf,
    // the head's own pieces, called by taskCardHtml in public/board/queue-detail.js
    queueMark, queueStateName, queueStateTitle, queueLaneChip, queueHoldBadge, queueQuestionChip,
    queueProjectName, queueAgentHtml,
    // the reader's order, and the rule a drop is judged by
    queueSorted, queueDropBlocked, queueCardsIn, queueIdsIn,
  };
};