// core/sse.js — the panel's own EventSource, and the translation of every server frame into app calls.
//
// Extracted from public/app.js as M4 in .agentboard/refactor-research/frontend-app-js.md (§2, §5 step 3),
// moved line for line: lines 9199-9335 of public/app.js at ae528c7 — `setStream` and the whole of `connect`,
// 137 lines. Nothing renamed, nothing rewritten, no call site touched.
//
// `connect` is the contract surface: it closes the previous stream, opens /api/stream and registers its handlers
// (open, snapshot, row, project, drop, job, jobline, remote-write, remote-write-answered, settings, approval,
// approval-answered, jobs, assistant, heartbeat, error). `remote-write*` and `settings` were added with the
// remote-write permission box: the first two are the panel's own parked question about a push, the third is a
// settings change made anywhere else (another tab, or "Always allow" in the box). Three things about the rest are
// load-bearing and moved exactly as they were:
//
//   * the `project` handler does its own synchronous DOM surgery — read window.scrollY, capture the caret,
//     detach the section, put the old row nodes straight back into the fresh tbody before anything measures,
//     restore the scroll, then renderProjectRows. The plan's warning about this (the "table vanishes for
//     seconds" and page-clamp fixes, in the comments it carries) is why the handler moved with `connect` and
//     did not get split out.
//   * the `snapshot` handler accepts BOTH shapes — `d.data` and a bare payload (9212) — because
//     server.js:997 writes a bare snapshot on the first connection while every later broadcast wraps it.
//     Simplifying it to one shape would break the first frame.
//   * the `jobline` handler resolves the thread through state.jobs first (state.jobs.get(evt.id)?.thread),
//     which is the only reason a line can be attributed to the right card.
//
// The plan also records that `restart` is broadcast by the server and silently dropped here. That is left
// exactly as it was: this step moves code, it does not decide protocol questions.
//
// LOADED AS A CLASSIC SCRIPT, BEFORE app.js (see index.html). Both declarations are functions, so they stay
// page globals; boot() in app.js calls connect() after its first await, long after this file has been parsed.
//
// WHAT IT STILL REACHES OUT FOR (by name, at call time): state (M1), $ (core/dom-format.js), setStream's
// targets in the DOM, ten functions in M5 (applySnapshot, noteEventLife, projectSection, queueRow,
// refreshChips, removeRow, renderAll, renderProjectRows, reorderProjects, repaintAgentState), eight in M6
// (appendJobLine, beginDomMove, captureTyping, endDomMove, renderConversation, restoreAddAgent,
// scheduleRenderJobs, updateJob), flashProjectMs (M9), renderApprovals (M11) and applyAssistant
// (public/assistant.js, through the typeof guard).

function setStream(label, cls = "ok") {
  $("stream-state").textContent = label;
  $("health").className = `dot ${cls}`;
}

// A project event is worth a repaint only when it carries something the page does not already hold. The store sends
// one on every patch, changed or not (lib/store.js patchProject), and the board answered each one by rebuilding the
// project's section: forced layout reads, a fresh header, the rows moved across, a row repaint and a re-sort. On the
// reader's board 68 of 68 repeat events in 100 s were byte-identical to the last one for their project, and that
// handler was the most expensive path on the page (350 ms of main thread a minute, 0.48.1). Compared field by field
// over what the event carries: the snapshot's own `worktrees` list is not in it and is not re-serialised.
function projectEventIsNew(cur, patch) {
  if (!cur) return true;
  for (const k of Object.keys(patch || {})) {
    if (JSON.stringify(cur[k]) !== JSON.stringify(patch[k])) return true;
  }
  return false;
}

function connect() {
  if (state.es) state.es.close();
  const es = new EventSource("/api/stream");
  state.es = es;
  es.addEventListener("open", () => setStream("● live"));
  es.addEventListener("snapshot", (e) => {
    const d = JSON.parse(e.data);
    state.lastEventAt = Date.now();
    applySnapshot(d.data ? d.data : d);
  });
  es.addEventListener("row", (e) => {
    const evt = JSON.parse(e.data);
    state.events += 1;
    state.lastEventAt = Date.now();
    // Liveness-only updates repaint the row but do not flash it: evidence blinks on and off
    // far more often than git state moves, and flashing for that is just noise.
    queueRow(evt.project, evt.row, { flash: evt.changed !== false && !evt.livenessOnly });
  });
  es.addEventListener("project", (e) => {
    const evt = JSON.parse(e.data);
    const known = state.projects.get(evt.project.name);
    // Nothing new: the section, its rows, the reader's place and caret are already what this event would draw.
    if (!projectEventIsNew(known, evt.project)) return;
    const cur = known || {};
    state.projects.set(evt.project.name, { ...cur, ...evt.project });
    refreshChips(evt.project.name);
    const sec = document.querySelector(`section.project[data-project="${CSS.escape(evt.project.name)}"]`);
    if (!sec) {
      renderAll();
      return;
    }
    // Replace only the section's own markup, then immediately repaint its rows: swapping the
    // whole section used to leave an empty <tbody> behind until the next full re-render,
    // which is what made the worktree table vanish for seconds at a time.
    // Read the page position BEFORE anything leaves the document. Reading scrollY forces a layout, and a layout with
    // this project's rows detached is exactly what clamps the reader upward when they are near the bottom of the page.
    const pageY = window.scrollY;
    // And the caret, for the same reason: this section is about to leave the page, taking the reply box the reader
    // is typing in with it. Once it is detached there is no focus left to capture, so it is read here and handed to
    // the row repaint below, which puts it back in the box it rebuilds.
    const typing = captureTyping(sec);
    // The section swap below takes every card and the inline add-agent field out of the page for an instant; bracketed
    // so their blur does not read as the reader leaving, and both are restored by the row repaint.
    beginDomMove();
    const oldBody = sec.querySelector(`[data-tbody="${CSS.escape(evt.project.name)}"]`);
    const oldRows = oldBody ? [...oldBody.childNodes] : [];
    const holder = document.createElement("div");
    holder.innerHTML = projectSection(evt.project.name);
    const freshHolder = holder.firstElementChild;
    // A project event replaces the whole section. If it was mid-flash (it had just moved because an
    // agent started in it), the replacement would silently drop the highlight.
    if (sec.classList.contains("flash")) {
      freshHolder.classList.add("flash");
      clearTimeout(freshHolder._flashT);
      freshHolder._flashT = setTimeout(() => freshHolder.classList.remove("flash"), flashProjectMs() + 40);
    }
    sec.replaceWith(freshHolder);
    // The fresh section arrives with an empty tbody. Put the rows that were on screen straight back into it, before
    // anything measures, so the document never lays out with the project missing: the swap takes the section out and
    // the rows back in between two statements, and nothing in between reads the layout.
    const newBody = freshHolder.querySelector(`[data-tbody="${CSS.escape(evt.project.name)}"]`);
    if (oldRows.length && newBody) newBody.replaceChildren(...oldRows);
    state.tbodyEls.set(evt.project.name, newBody);
    if (window.scrollY !== pageY) {
      const maxY = Math.max(0, document.scrollingElement.scrollHeight - window.innerHeight);
      window.scrollTo({ top: Math.min(pageY, maxY) });
    }
    renderProjectRows(evt.project.name, { typing });
    endDomMove();
    restoreAddAgent(freshHolder);
    // A project whose rows really did grow or shrink moves the document. This handler is one synchronous step, so a
    // scroll that moved under it is a clamp, not the reader: put them back before the board re-sorts under them.
    if (window.scrollY !== pageY) {
      const maxY = Math.max(0, document.scrollingElement.scrollHeight - window.innerHeight);
      window.scrollTo({ top: Math.min(pageY, maxY) });
    }
    reorderProjects();
  });
  es.addEventListener("drop", (e) => {
    const evt = JSON.parse(e.data);
    removeRow(evt.project, evt.path);
  });
  es.addEventListener("job", (e) => {
    state.lastEventAt = Date.now();
    const job = JSON.parse(e.data).job;
    updateJob(job);
    // A job being created, re-statused or finished is news about the worktree that owns it.
    if (job) noteEventLife(job.thread || job.id);
  });
  es.addEventListener("jobline", (e) => {
    const evt = JSON.parse(e.data);
    // A line on a run's own stream is the freshest proof the panel's live path is working, so it stamps the board's
    // liveness clock exactly like a `job` or `row` frame does. Without this stamp, a card writing seven lines a
    // second read 33 s stale to the 30 s safety net (app.js), which then rebuilt the whole board — every card, every
    // row — mid-stream, on a card that was demonstrably alive. That is mechanism #3 in docs/jitter-synthesis.md.
    state.lastEventAt = Date.now();
    appendJobLine(evt);
    // Every line an agent writes is proof that its worktree is being worked in right now - the freshest sign of
    // life there is, and one the scanner only finds out about on its next pass.
    noteEventLife(state.jobs.get(evt.id)?.thread || evt.thread || evt.id);
  });
  // The panel's own permission box for a remote write (lib/remote-writes.js): a worker's push parked by the guard
  // the panel installed, or the panel's own merge flow asking before it pushes. Same dock, same box chrome.
  es.addEventListener("remote-write", (e) => {
    const r = JSON.parse(e.data).request;
    if (!r || !r.id) return;
    state.lastEventAt = Date.now();
    state.rwPending.set(r.id, r);
    renderApprovals();
  });
  es.addEventListener("remote-write-answered", (e) => {
    const evt = JSON.parse(e.data);
    const r = state.rwPending.get(evt.id) || null;
    state.rwPending.delete(evt.id);
    state.rwDecided.set(evt.id, { choice: evt.choice || "deny", why: evt.why || "", command: r?.command || "", expired: Boolean(evt.expired), at: Date.now() });
    renderApprovals();
  });
  // A settings change made anywhere (the Settings row, another tab, "Always allow" in the permission box): the page
  // repaints from the numbers the server just wrote, rather than keeping its own copy of a policy.
  es.addEventListener("settings", (e) => {
    const d = JSON.parse(e.data);
    if (!d.settings) return;
    state.lastEventAt = Date.now();
    applySettings(d.settings);
  });
  es.addEventListener("approval", (e) => {
    const r = JSON.parse(e.data).request;
    if (!r || !r.id) return;
    state.approvals.set(r.id, r);
    renderApprovals();
    // The agent that is blocked now says "waiting on you" instead of just "running".
    if (r.thread) {
      noteEventLife(r.thread);
      renderConversation(r.thread);
    }
  });
  es.addEventListener("approval-answered", (e) => {
    const evt = JSON.parse(e.data);
    const r = state.approvals.get(evt.id);
    state.approvals.delete(evt.id);
    renderApprovals();
    if (r && r.thread) {
      noteEventLife(r.thread);
      renderConversation(r.thread);
    }
  });
  es.addEventListener("jobs", (e) => {
    state.lastEventAt = Date.now();
    state.jobs.clear();
    for (const j of JSON.parse(e.data).jobs) state.jobs.set(j.id, j);
    scheduleRenderJobs();
    repaintAgentState();
  });
  // The sentry's own state: a new alert, a dismissed one, a watch closing, a settings change from another tab.
  es.addEventListener("assistant", (e) => {
    state.lastEventAt = Date.now();
    const d = JSON.parse(e.data);
    if (d.assistant && typeof applyAssistant === "function") applyAssistant(d.assistant);
  });
  es.addEventListener("heartbeat", (e) => {
    state.pool = JSON.parse(e.data).pool;
  });
  es.addEventListener("error", () => setStream("reconnecting…", "warn"));
}

window.WMApp = window.WMApp || {};
window.WMApp.core = window.WMApp.core || {};
// Published for the later steps of the split; nothing reads it yet.
window.WMApp.core.sse = { setStream, connect };
