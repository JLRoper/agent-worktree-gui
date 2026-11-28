// queue-detail.js - the queue pane's FULL CARD and everything behind it: the stopped chip's re-attach press, the
// pipeline and flow presses, the project and filer lines, the one card in its two modes, the paint, the two reads and
// the one write path. Cut out of public/queue-cards.js, which is entry 8 of
// docs/reports/module-separation-2026-11-28.html's split plan (public/board/queue-detail.js, the report's
// 530-1,099 of a 1,307-line file).
//
// WHY THIS FILE EXISTS. The report splits queue-cards.js three ways so that a row that changes a chip, a row that
// changes the drag and a row that changes the card's markup stop opening the same file. This is the third cut and the
// biggest: the card itself and the state machine around it. The report calls it "the stopped chip and the full card";
// what it also carries is the PAINT (renderAssistantQueue), the two reads that feed it (loadQueue, loadQueueJobs) and
// the one POST every press on a row goes through (queueAct) - the card cannot be drawn without them, and they are
// what a row editing the card's markup needs to read.
//
// WHAT IS HERE
//
//   the stopped chip            queueReattach and its per-card note: the press that settles a wedged session and
//                               starts one short turn, and the sentence saying which of the three things happened.
//   the card's own pieces       the pipeline chip and its flow press, the project a card is about (read back from
//                               public/board/queue-row.js), who filed it, and the re-attach note.
//   the one card                taskCardHtml in its two modes: "full" is the queue pane's row (draggable while
//                               queued, the four state presses, the move popover, the pipeline and flow presses and
//                               the disclosure), "compact" is the Initiatives tab's read-only copy of the same head
//                               and facts, with every control left out.
//   the pane's four states      queuePaneState, queueStateHtml and queueMoreHtml: error, missing, loading, idle, and
//                               the one control under the list that appends the next slice of finished history.
//   the paint                   renderAssistantQueue: what is drawn, from the cache, on the file's own stamp.
//   the reads and the write     loadQueue, loadQueueJobs and queueAct: the two reads and the one POST every press on
//                               a row goes through.
//   the picker                  paintQueueMove, closeQueueMove and toggleQueueMove over the one open-Move record.
//
// WHAT IT REACHES OUT FOR (by name, at call time, exactly as before the move)
//
//   the panel's own helpers     asPost, setErr, sessionById, assistantIds, isAssistant, activeSessionId, hostFor,
//                               paneIdFor, typingInside and applyAssistant, from public/assistant.js's IIFE, handed
//                               in as this factory's argument.
//   the row cut                 the read cache and the one line a refused drop leaves, the sequence and in-flight
//                               records, the job map, the open-picker record, the window's constants and helpers, the
//                               head's own pieces (queueMark, queueStateName, queueStateTitle, queueLaneChip,
//                               queueHoldBadge, queueQuestionChip, queueAgentHtml) and queueProjectName - all read
//                               back from public/board/queue-row.js under the spellings they had in the one closure.
//   the drag cut, one question  `dragLive()`: is a gesture live? A repaint while one is would take the card out from
//                               under the pointer. It is asked through `deps.later` because the drag cut is built
//                               after this one, and it is the only line of moved code whose text changed.
//   esc, state, apiFetch        public/app.js's escaping, page state and fetch wrapper; relTime and CSS likewise
//                               resolve from the page at call time and are not passed.
//
// THE LOAD CONTRACT. This file declares ONE thing: a factory. public/index.html loads it before public/queue-cards.js,
// and that entry point builds it after the row cut (whose names it reads) and before the drag cut. Nothing here reads
// an app.js binding while it loads. The queue sub-tab marker pair below is the test harnesses' slice, kept verbatim so
// the existing slice tests still find the code they drive.


window.WMApp = window.WMApp || {};
window.WMApp.queueDetail = function queueDetail(deps) {
  "use strict";
  const {
    asPost, setErr, sessionById, assistantIds, isAssistant, activeSessionId,
    hostFor, paneIdFor, typingInside, applyAssistant,
  } = deps;
  const { row, later } = deps;
  const { dragLive } = later;
  // The row cut's state and its head pieces, read back under the spellings the bodies below already use.
  const {
    queueCache, queueSeq, queueInflight, qmoveOpen, queueJobs, queueDropNotes, QUEUE_FIRST, QUEUE_MORE,
    queueSorted, queueWindowRows, queueWindowOf, queueStampOf, queueMark, queueStateName, queueStateTitle,
    queueLaneChip, queueHoldBadge, queueQuestionChip, queueProjectName, queueAgentHtml,
  } = row;

  // ---- the queue sub-tab ------------------------------------------------------------------------

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
  //
  // ONE CARD, TWO MODES, AND NO SECOND COPY OF IT. `t` is a queue row and `mode` says who is drawing it:
  //
  //   "full"     the queue pane's own row: draggable while queued, the four state presses, the move popover, the
  //              pipeline and flow presses, the re-attach press, and the disclosure that folds the tree, the files
  //              and the detail.
  //   "compact"  the Initiatives tab's Assistants section, where a reader wants to recognise the card he knows from
  //              the queue rather than read a second, plainer listing of the same rows: the SAME head and facts
  //              markup and the same classes, so the same styles, with every control left out - no drag class, no
  //              inline form, no per-row button, no disclosure. The whole title rides in title= and the compact
  //              card's own CSS is what cuts it to one line, so nothing here truncates the text.
  //
  // `kit` carries what a pane has and a row does not: `own` (the assistant whose queue this is - every data-as-qown,
  // and the id a compact card's press opens), `jobs` (the agent statuses by thread), `byId` (the rows by id a hold's
  // sentence names) and `alerts` (the assistant's own question chips). A mode this function does not know draws the
  // full card: a typo must not silently drop every control.
  function taskCardHtml(t, mode = "full", kit = {}) {
    const compact = mode === "compact";
    const id = String(kit.own || "");
    const jobs = kit.jobs || null;
    const byId = kit.byId instanceof Map ? kit.byId : new Map();
    const alerts = Array.isArray(kit.alerts) ? kit.alerts : [];
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
    // THE HEAD, one piece of markup for both modes: the marker, the id, the state in a word, and the title with the
    // whole of it in title= (the compact card's own CSS cuts it to one line; nothing here truncates the text, so a
    // copy takes the title the queue holds). The chips after it are the full card's alone: a lane, a hold and a
    // question are the three things a row is WAITING ON, and a read-only card leaves every one of them to the queue
    // that can act on it.
    const headHtml = (chips) => `<div class="as-task-head">
              <span class="as-task-mark is-${esc(state)}" aria-hidden="true">${mark}</span>
              <b class="mono">#${esc(String(t.id))}</b>
              <span class="as-task-state is-${esc(stateWord)}" title="${esc(queueStateTitle(t, compact))}">${esc(stateWord)}</span>
              <span class="as-task-title" title="${esc(t.title)}">${esc(t.title)}</span>
              ${chips}
            </div>`;
    if (compact) {
      // THE COMPACT CARD. Read-only by construction: it draws no press, carries no data-as-qact, no drag class and no
      // disclosure, and the one control it has is the press its CALLER puts on it (the Initiatives pane jumps to the
      // row in its real queue). The agent line is the thread alone, with no chip: the run's status is read from
      // /api/jobs by the queue pane, and a compact card that guessed one would be the second opinion this mode exists
      // to avoid. `data-init-act` is the Initiatives tab's own rule that a press here acts on the card rather than
      // folding the initiative around it.
      const agent = current
        ? `<span class="as-task-agent" title="the agent on this task - its thread; open the card to see the run's own status"><code class="as-task-agent-thread">${esc(current)}</code></span>`
        : `<span class="as-task-agent is-none" title="nothing has run this task yet">no agent yet</span>`;
      const when = t.at
        ? `<span class="as-task-when" title="last activity ${esc(String(t.at))}">${esc(relTime(t.at))} ago</span>`
        : `<span class="as-task-when" title="the queue row carries no timestamp">no time recorded</span>`;
      return `<div class="as-task is-compact${t.state === "done" ? " is-done" : ""}" data-as-qrow="${esc(String(t.id))}" data-as-qstate="${esc(state)}" data-as-qown="${esc(id)}" data-as-qthread="${esc(current)}" data-init-task-card="${esc(String(t.id))}" data-init-task-own="${esc(id)}" data-init-act role="button" tabindex="0" title="open #${esc(String(t.id))} in its own queue - the assistant opens, the row is centred and flashed">
        <div class="as-task-main">
          <div class="as-task-body">
            ${headHtml("")}
            <div class="as-task-facts">${agent}${when}</div>
          </div>
        </div>
      </div>`;
    }
    // ---- the full card: the queue pane's own row --------------------------------------------------
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
        : t.laneAllowed
          ? `<div class="as-task-note" title="${esc(`OVERLAP ALLOWED by ${t.laneAllowed.allow?.by || "someone"} on ${(t.laneAllowed.files || []).join(", ")} (overlaps #${t.laneAllowed.holder?.id})`)}">OVERLAP ALLOWED by ${esc(t.laneAllowed.allow?.by || "someone")} on ${esc((t.laneAllowed.files || []).join(", "))}</div>`
          : t.state === "parked" && t.reason
          ? `<div class="as-task-note" title="${esc(`parked — ${t.reason}`)}">parked — ${esc(t.reason)}</div>`
          : t.state === "queued" && t.reason
            ? `<div class="as-task-note" title="${esc(t.reason)}">${esc(t.reason)}</div>`
            : "";
    // THE AGENT ROWS ARE ONE BLOCK ON THE FACTS LINE, not flex siblings on it. `div.as-task-facts` is a wrapping
    // flex row with an 8 px column gap, so two agents joined straight into it laid out SIDE BY SIDE and that gap
    // read as the separator between two agents (the reader photographed exactly that on a card carrying an EXITED
    // thread and a RUNNING one). One child block, a column, gives every agent its own line. No indent of its own:
    // the facts line carries the 18 px, and `.as-task-agents`' 19 px belongs to the Initiatives pane, which is why
    // that container is not the one reused here.
    // WHOSE PROJECT, WHOSE LANDING. Each agent line carries the project and the landed verdict of the tree THAT
    // thread ran in (`agentRows`, decorated server-side from `threadTrees`). When at least one line has that, the
    // task-level meta line steps aside: it names the tree the row points at NOW, and printing it under lines that
    // already say where each agent worked would be the same fact a second time. With no per-agent record - every queue
    // file written before `threadTrees` existed - the meta line draws exactly as before, so nothing is lost.
    const agentRows = Array.isArray(t.agentRows) ? t.agentRows : [];
    const anyWhere = agentRows.some((r) => r && (r.project || r.verdict));
    const agents = list.length
      ? `<div class="as-task-agent-stack">${list.map((th, i) => queueAgentHtml(id, t, th, jobs, agentRows[i] || null)).join("")}</div>`
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
    // THE PIPELINE IS A FACT ABOUT THE TASK, not about an agent: it is assigned to the row, and every agent the row
    // cuts runs under it. It gets a line of its own under the facts block, so an agent's line stays about that agent
    // and a task whose pipeline reads "assistant decides" cannot look like something the agent beside it chose.
    const pipelineRow = `<div class="as-task-pipeline-row"><span class="as-task-pipeline">${queuePipelineChip(t, id)}${queueFlowButton(t, id)}</span></div>`;
    // Somebody else filed this row (null for the ordinary case), drawn on its own small line below.
    const filedBy = queueFiledBy(t, id);
    return `<div class="as-task${t.state === "done" ? " is-done" : ""}${t.state === "queued" ? " is-draggable" : ""}" data-as-qrow="${esc(String(t.id))}" data-as-qstate="${esc(state)}" data-as-qown="${esc(id)}" data-as-qthread="${esc(current)}">
        <div class="as-task-main">
          <div class="as-task-body"${current ? ` data-as-qopen="${esc(current)}"` : ""}>
            ${headHtml(`${queueLaneChip(t)}${queueHoldBadge(t, byId)}${queueQuestionChip(t, alerts)}`)}
            <div class="as-task-facts">${agents}${meta.length && !anyWhere ? `<span class="as-task-meta">${meta.join(" · ")}</span>` : ""}</div>
            ${pipelineRow}
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

  // The one control under the list. It appends the next slice of the FINISHED tasks the window is still hiding, and it
  // RETIRES at the end of the list: with nothing hidden there is no control to draw, not a disabled button that costs a
  // line forever. Every open row is drawn ABOVE it, so what this hides is history - and the note leads with "showing N
  // of M" because a list that hides a row without saying so is exactly how this tab came to read as one agent working
  // while five were running. The count after the dash is what the label does not spell out when fewer than 50 are left.
  function queueMoreHtml(id, hidden, drawn = 0, total = 0) {
    const left = Number(hidden) || 0;
    if (left <= 0) return "";
    const more = Math.min(QUEUE_MORE, left);
    return `<div class="as-qmore"><button type="button" class="as-qmore-btn" data-as-qact="more" data-as-qown="${esc(id)}" title="append the next ${more} older task${more === 1 ? "" : "s"} - the list opens at the newest ${QUEUE_FIRST} FINISHED tasks (every queued, running and parked row is always drawn), and this control goes away when every task is shown">Load ${more} more</button><span class="as-qmore-note">showing ${Number(drawn) || 0} of ${Number(total) || 0} - ${left} older task${left === 1 ? "" : "s"} not shown</span></div>`;
  }
  function renderAssistantQueue(id = activeSessionId(), force = false) {
    const host = hostFor(id, "queue");
    if (!host || !state.assistant) return;
    // A card is being dragged: rebuilding the pane now would take the node out from under the pointer and end the
    // gesture mid-air. The drag's own drop repaints from the answer, so skipping a paint here costs nothing.
    if (dragLive()) return;
    if (!force && typingInside(`#${paneIdFor(id, "queue")}`)) return;
    const rec = sessionById(id);
    // Ask for a read BEFORE the paint when the cache is missing or old: the paint then says it is reading instead of
    // "not read yet" for a frame, and the answer repaints it WITHOUT forcing another read (see loadQueue's .finally).
    const before = queueCache.get(id);
    // WHAT MAKES A QUEUE "OLD" IS THE FILE, NOT A CLOCK. This pane is repainted by every board frame - a row event, an
    // assistant event, the page's own 30 s anti-entropy read - and a read per paint is the request loop this pane was
    // fixed for once. The panel puts the queue file's mtime+size stamp on the assistant row (lib/assistant.js
    // `assistantList`), so a queue that MOVED gets exactly one read and an unchanged one gets none: the reader's defect
    // was a page whose rows went running while the pane kept a view up to twenty seconds old. The twenty-second clock
    // stays as the fallback for a payload that names no stamp (an older server, a queue file that is not there).
    const stamp = queueStampOf(id);
    const moved = Boolean(stamp) && String(before?.view?.stamp || "") !== stamp;
    if (force || !before || moved || Date.now() - Number(before.at || 0) > 20_000) void loadQueue(id);
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
        ${visible.map((t) => taskCardHtml(t, "full", { own: id, jobs: queueJobs.byThread, byId, alerts: state.assistant?.alerts || [] })).join("")}
        ${queueMoreHtml(id, hidden, visible.length, sorted.length)}
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
  // ---- end the queue sub-tab --------------------------------------------------------------------

  // What the entry point hands on: the paint and its two reads, the one write path, the re-attach press, the
  // picker's record and the one card (taskCardHtml), which the Initiatives tab calls in its compact mode.
  return {
    renderAssistantQueue, loadQueue, queueAct, queueReattach,
    qmoveOpen, closeQueueMove, toggleQueueMove, taskCardHtml,
  };
};