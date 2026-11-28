// board/approvals.js - the approval dock, the permission box and the remote-write review, cut out
// of public/app.js.
//
// WHY THIS FILE EXISTS. public/app.js is the file six open queue rows claimed at 2026-11-28, and the
// approval surface was one of the blocks they all opened. This is cut 1 of the eight in
// docs/reports/module-separation-2026-11-28.html, section 5, the card for public/app.js: "the
// permission box, the approvals list, the remote-write review and their clocks". Moved line for
// line: not one body was rewritten and not one call site was touched.
//
// WHAT IS HERE
//
//   the permission box     permissionBoxHtml and the choices table every box shares
//                          (APPROVAL_CHOICE_LABEL), APPROVAL_CLOSED_HEAD with the closed and
//                          unanswerable notes, and approvalDecided - the one record line a spent
//                          approval leaves on the card.
//   the flight             approvalFlights, approvalFlightKey, approvalInFlight, approvalCardsFor and
//                          paintApprovalFlight: one answer per request id, greying every copy of a
//                          box at once, whichever surface it was pressed on.
//   a run's own question   approvalPrompt (the turn parked on a gateway approval) and
//                          answerRunApproval, its answer path, with closeApprovalCard for a request
//                          the panel has already let go.
//   the dock               APPROVAL_LABEL, APPROVALS_FOLDED_KEY and approvalsFolded,
//                          approvalThreadsShown, approvalAgentName, approvalCard and renderApprovals,
//                          and the gestures that walk the reader from a dock card to the agent that
//                          asked: revealAgentHome, dockGoto, rwAgentFor, rwUnresolved, dockNote.
//   remote writes          remoteWriteBoxHtml, remoteWriteDecidedHtml, remoteWriteReviewHtml,
//                          reviewAgentName, rwGroupHtml, keepReview, unwindReview and
//                          answerRemoteWrite: the panel's own permission for a push, drawn in the
//                          same box, plus the receipts and the auto-allowed writes to review.
//   the clock              tickApprovals, DECIDED_TTL_MS and DECIDED_SHOWN (a receipt ages out on the
//                          page's own 1 s clock), and approvalSent with approvalKey,
//                          approvalAlreadySent and noteApprovalSent: the second of two presses on one
//                          choice is a no-op. The interval itself is registered in public/app.js,
//                          with the page's other load-time wiring.
//
// WHAT IT REACHES OUT FOR (by name, at call time, exactly as before the move)
//
//   state.approvals, state.rwPending, state.rwDecided, state.rwReviews, state.rwPolicy, state.jobs,
//   state.rows, state.projects, state.expanded, state.expandedProjects, state.collapsedRoots
//                          the stores the dock paints.
//   apiFetch (core/transport.js), esc and fmtAgo (core/dom-format.js), readBox, writeBox,
//   clearBoxDraft and setCaretOffset (board/paste-chips.js), applyApprovalsFold (settings.js),
//   programmaticScroll (board/console.js), rowKeyForThread (render-projects.js), and public/app.js's
//                          own $, showBanner, showNote, fmtLeft, fmtClock, rootOf, jumpToAgent,
//                          renderConversation, turnLive, applyApprovalAnswered, saveCollapsedRoots,
//                          applyRootCollapse, toggleProject, paintClarifyButton,
//                          paintPermissionsButton, paintHotButton and paintReviewChip.
//
// THE LOAD CONTRACT. public/index.html loads CLASSIC scripts, so the page is one global scope: a
// top-level `function` here is a window property and a top-level `const`/`let` is a binding every
// other script reads by bare name. index.html loads this file before app.js, and the file DECLARES
// ONLY - nothing here reads a `state` field or an app.js binding while it loads - so sitting before
// app.js costs nothing and cannot land in a temporal dead zone. public/app.js re-exports these names
// on window.WMApp.approvals, which is the door public/render-jobs.js, public/settings.js,
// public/core/sse.js and public/core/permissions-history.js already reach for.
//
// WHAT STAYED IN app.js. The four remote-write stores are initialised beside the `state` literal
// they hang off ("state.rwPending = state.rwPending || new Map()" and its three neighbours), the way
// the thinking and tool-group books stay with the state they are built in; only the code that paints
// them moved. The 1 s interval that drives tickApprovals is load-time wiring and stays there too.
//
// RE-MEASURED FROM 3bb43694. The report's rows for this cut were 1,994-2,156 and 5,968-6,535. On
// this base the first is 1935-2156 and the second had drifted into three pieces: 5825-5954 (a run's
// answer path and the whole approvals dock) and 5960-6536 (remote writes through answerRemoteWrite).
// The difference is the four state initialisers and the section comments the report's scan did not
// carry, not a change of surface.

// The approval question belongs where the reading stopped: directly under the console output of the
// turn that is parked on it, not in a separate panel at the bottom of the card. It is a box that
// behaves like a popup (raised, bordered, the only thing asking for a decision) but it lives in the
// flow, so it never covers the output it is about.
// The choices a parked question offers, and what each one means. ONE table for every box the panel draws — a turn
// parked on an approval, a local-only worktree parked on a push — because "Always allow" has to mean the same
// thing in both, and the reader asked for the same box rather than a lookalike.
const APPROVAL_CHOICE_LABEL = { once: "Allow once", session: "Allow for this session", always: "Always allow", deny: "Deny" };

// One answer per question, shared by every box that draws it. A permission can be open as a run card
// (`turn-approval`) and as a dock card (`.approval`), and a clarify question can be drawn on the worktree
// session and in the assistant session; both copies carry the gateway's request id, so the flight is keyed
// on that id rather than on the card, the turn or the button. The entry exists from the press until the
// answer settles: every other press is refused, and every copy is greyed together.
const approvalFlights = new Map(); // `request:<id>` | `id:<id>` -> { id, requestId, choice, at }
function approvalFlightKey(id, requestId) {
  const rid = String(requestId || "").trim();
  return rid ? `request:${rid}` : `id:${String(id || "")}`;
}
function approvalInFlight(id, requestId) {
  return approvalFlights.get(approvalFlightKey(id, requestId)) || null;
}

// Every box that draws this approval, on every surface: the board card and the pinned copy of the same turn are
// two boxes for one request, and both carry the gateway's request id. A record with no id falls back to the
// turn, which is the finest identity it has.
function approvalCardsFor(id, requestId) {
  const rid = String(requestId || "").trim();
  const turn = String(id || "");
  const cards = new Set();
  for (const el of document.querySelectorAll("[data-approve]")) {
    const same = rid ? String(el.dataset.request || "") === rid : String(el.dataset.approve || "") === turn;
    if (!same) continue;
    const card = el.closest(".turn-approval");
    if (card) cards.add(card);
  }
  return cards;
}

// Grey (or un-grey) every copy of one approval at the press, before any round trip: `disabled` on the button
// itself is what a stale pointerup and a repaint that has not run yet both see, and the flight line says what
// is happening without waiting for the next snapshot.
function paintApprovalFlight(id, requestId, mode) {
  const sending = mode === "sending";
  for (const card of approvalCardsFor(id, requestId)) {
    card.classList.toggle("is-sending", sending);
    if (sending) card.setAttribute("aria-busy", "true");
    else card.removeAttribute("aria-busy");
    for (const el of card.querySelectorAll("button")) el.disabled = sending;
    const line = card.querySelector("[data-ta-flight]");
    if (line) line.hidden = !sending;
  }
}

// The permission box itself: the amber raised box, its head, the thing being asked about, the choices, and a
// deadline the page's own 1s clock counts down. Extracted from approvalPrompt() when the remote-write permission
// arrived, so the two questions cannot drift into two designs. Everything that differs is a parameter: which
// record the press belongs to (`extra`), what the head and the tooltips say, and where the foot's countdown is
// driven from (`data-approval-until`, which tickApprovals already reads).
function permissionBoxHtml({
  id,
  requestId = "",
  forAttr = "",
  head,
  command,
  // The tree the command runs in, when the surface knows it (the turn's own cwd, the dock's worktree): the
  // summary block uses it to say when a step writes OUTSIDE the repo, and says nothing of the sort without it.
  root = "",
  choices = ["once", "deny"],
  deadline = 0,
  windowMs = 0,
  closed = false,
  closedHead = APPROVAL_CLOSED_HEAD,
  closedNote = "",
  // A line under the command, for a box that has something to say about itself (the dock's "no agent on this
  // board owns that write" is the one caller). Empty for every other question.
  note = "",
  titles = null,
  extra = "",
  // Can this panel send an answer for this request at all? False for a turn with no run, a record with no
  // permitted choice, and a request the gateway has proved it no longer holds: the box then draws the note
  // instead of choices, because a button that can only be refused is worse than no button.
  answerable = true,
}) {
  const left = deadline ? deadline - Date.now() : 0;
  const canSend = !closed && answerable;
  // A press has already gone out for this request: every copy of the box greys its choices at once, so a
  // second box (the dock's copy, or this card after a repaint) cannot send a second, different answer.
  const sending = canSend && Boolean(approvalInFlight(id, requestId));
  const buttons =
    `<div class="ta-actions">` +
    choices
      .map(
        (c) =>
          `<button class="btn-approve${c === "deny" ? " btn-deny" : ""}" data-approve="${esc(id)}" data-choice="${esc(c)}" data-request="${esc(requestId)}" data-until="${deadline || ""}"${extra} type="button"${sending ? " disabled" : ""} title="${esc((titles && titles[c]) || APPROVAL_CHOICE_LABEL[c] || c)}">${esc(APPROVAL_CHOICE_LABEL[c] || c)}</button>`,
      )
      .join("") +
    `</div>`;
  // The countdown only exists when the window is known: a question with no deadline gets no invented number.
  const foot =
    !deadline || !windowMs
      ? ""
      : `<div class="ta-foot${closed ? " is-over" : left <= 20_000 ? " is-low" : ""}" data-approval-until="${deadline}" data-approval-window="${windowMs}" title="time left before this question is denied and the writer is told so">` +
        `<div class="ta-timer"><span style="width:${Math.max(0, Math.min(100, (left / windowMs) * 100)).toFixed(2)}%"></span></div>` +
        `<span class="ta-left mono">${closed ? "expired" : `~${fmtLeft(left)} left`}</span></div>`;
  // The plain reading of the command, ABOVE it and never instead of it: `wtCommandSummary` (core/command-summary.js)
  // splits the line into steps and names the effects a reader is deciding about. A module that is absent (an old
  // page served with a new app.js) draws no block at all, which is exactly what the card did before it existed.
  const summary = globalThis.wtCommandSummary?.html ? globalThis.wtCommandSummary.html(command, { root, esc }) : "";
  return `<div class="turn-approval${closed ? " is-expired" : ""}${sending ? " is-sending" : ""}" ${forAttr}>
    <div class="ta-head mono">${closed ? esc(closedHead) : head}</div>
    ${summary}
    <pre class="ta-cmd mono">${esc(command || "(no command text)")}</pre>
    ${note}
    <div class="ta-note mono is-sending" data-ta-flight${sending ? "" : " hidden"}>sending your answer...</div>
    ${canSend ? buttons : closed ? closedNote : approvalUnanswerableNote()}
    ${canSend ? foot : ""}
  </div>`;
}

function approvalPrompt(turn, copy = "") {
  const approval = turn.approval;
  if (!approval) return "";
  // A question only exists while its turn does. The panel's approval object can outlive the run — the
  // run errors, is cancelled, or its stream simply ends while the request is still attached — and a box
  // offering "Allow once" for a turn that is already dead is worse than no box. The terminal state of
  // the turn wins, and the error line left in its console is the record of what happened.
  const live = turnLive(turn);
  // A park that is on the card is drawn. `approvalDone` records an EARLIER approval on this same turn, and gating a
  // later request on it is exactly what hid the second box behind the first's answer (docs/steer-refusal.md §1.4) —
  // `approval.responded` and settle clear `approval` itself, so its presence is the whole test.
  if (!live) return "";
  const choices = Array.isArray(approval.choices) && approval.choices.length ? approval.choices : ["once", "deny"];
  // The window is the gateway's own (`approvals.timeout`), carried on the request when it arrived. An approval
  // is a question with a deadline: the gateway gives up at it and denies the command on its own, so a box that
  // keeps offering a choice past that instant is offering a decision that can no longer be made — the answer
  // comes back 409 `approval_not_pending` and the reader is told nothing about why.
  const deadline = Number(approval.deadline) || 0;
  const windowMs = (Number(approval.timeoutSeconds) || 0) * 1000;
  const closed = Boolean(deadline) && deadline - Date.now() <= 0;
  // The panel's own verdict on whether those buttons can lead anywhere: it needs a run to post to, at least
  // one choice the host allowed, and a request its reconcile has not found gone. A page talking to a panel
  // that predates the field gets `undefined`, which is why only an explicit false closes the box.
  const answerable = Boolean(turn.runId) && approval.answerable !== false && choices.length > 0;
  return permissionBoxHtml({
    id: turn.id,
    requestId: approval.requestId || "",
    forAttr: `data-approval-for="${esc(turn.id)}${esc(copy)}"`,
    head: "⚠ waiting on you — this turn is parked until you answer",
    command: approval.command,
    // The turn's own cwd is where the command runs: the summary says "outside the repo" only when it can compare
    // against it.
    root: turn.cwd || "",
    choices,
    deadline,
    windowMs,
    closed,
    answerable,
    closedNote: approvalClosedNote(),
    titles: {
      once: "allow this command (once)",
      session: "allow this command (session)",
      always: "allow this command (always)",
      deny: "refuse this command — the agent is told no and carries on without it",
    },
  });
}

// The window closed with nobody answering: the gateway denied the command and the agent carried on. Nothing is
// left to answer here, and saying so is better than a disabled button that looks like a decision was pending.
const APPROVAL_CLOSED_HEAD = "⚠ no answer within the gateway's window — it has already denied this command";

function approvalClosedNote() {
  return `<div class="ta-note mono">the gateway stopped waiting and denied it; the agent carried on without this command</div>`;
}

// There is a box on screen that this panel cannot send an answer for: the turn has no run to post to, the
// gateway allowed no choice, or its own reconcile found the gateway no longer holds the request. The honest
// thing is the record without the buttons: the panel is not the surface that can settle this one.
function approvalUnanswerableNote() {
  return `<div class="ta-note mono">this panel cannot answer this request: it has no line to the run that asked, so no choice is offered here</div>`;
}

// Once answered the box collapses to one line: what was decided, about what. An approval nobody answered gets its
// own record — the gateway denied the command when its window ran out, and "✓ approved" for that would be a lie.
//
// WHAT WAS ASKED OUTLIVES THE WINDOW. The one line this used to leave named the command and nothing else, truncated at
// 140 characters: a reader who came back after the window closed could not tell what had been offered, when it was
// asked, or how long it waited. Row #277 gave a timed-out QUESTION its question, choices and reason back; row #286 is
// the same rule on the other park, so an expired approval keeps the command it showed, the choices it offered and why
// it closed, and offers no control on a wait that is over.
function approvalDecided(turn) {
  const done = turn.approvalDone;
  if (!done || turn.approval) return "";
  if (done.expired) {
    // A press that lost the race is not the same event as a box nobody touched. The reader DID answer; the
    // gateway had already let the request go, and the record says which of the two happened.
    const why = done.clicked
      ? "your answer reached the gateway after it had already let this request go: its window closed, another surface answered it, or the run was stopped"
      : done.reason === "withdrawn"
        ? "the gateway had already let this request go (its window closed, another surface answered it, or the run was stopped)"
        : `no answer reached the gateway inside its waiting window${Number(done.waitedSeconds) ? ` (${fmtLeft(Number(done.waitedSeconds) * 1000)} unanswered)` : ""}`;
    const head = done.clicked ? "✕ your answer arrived too late" : "✕ not answered here";
    // The choices the host allowed, by the names the box offered them under. A record written by an older panel build
    // carries none, and then the block simply has no choice row rather than inventing two.
    const choices = Array.isArray(done.choices) ? done.choices.map(String).filter((c) => c.trim()) : [];
    const asked = done.askedAt ? `asked ${fmtClock(done.askedAt)}` : "";
    const closed = done.at ? `closed ${fmtClock(done.at)}` : "";
    const when = [asked, closed].filter(Boolean).join(" · ");
    const tip = `${why}${done.command ? ` - ${String(done.command)}` : ""}`;
    return `<div class="turn-approval-done is-expired is-trace" title="${esc(tip)}">
    <div class="tad-head mono">${esc(head)}</div>
    <div class="tad-why mono">${esc(why)}</div>
    ${done.command ? `<pre class="tad-cmd mono">${esc(String(done.command))}</pre>` : ""}
    ${choices.length ? `<div class="tad-choices">${choices.map((c) => `<span class="tad-choice" title="this choice was offered while the window was open, and can no longer be taken">${esc(APPROVAL_CHOICE_LABEL[c] || c)}</span>`).join("")}</div>` : ""}
    ${when ? `<div class="tad-when mono">${esc(when)}</div>` : ""}
  </div>`;
  }
  const denied = String(done.choice || "").toLowerCase() === "deny";
  const verb = denied ? "denied" : `approved ${done.choice || ""}`.trim();
  return `<div class="turn-approval-done mono${denied ? " is-deny" : ""}" title="${esc(done.command || "")}">${denied ? "✕" : "✓"} ${esc(verb)}${done.command ? `: ${esc(String(done.command).slice(0, 140))}` : ""}</div>`;
}

// Answer an approval a run is parked on. Kept as a function so both the click and the pointerup path reach the
// same place; `approvalSent` makes the second of the two a no-op.
async function answerRunApproval(approveBtn) {
  const id = approveBtn.dataset.approve;
  const choice = approveBtn.dataset.choice;
  const requestId = approveBtn.dataset.request || "";
  // The same box, the same four choices, two questions: a run parked on a gateway approval, or a write parked on
  // the panel's own remote-write permission (lib/remote-writes.js). The button is identical, so the ROUTE is
  // decided by which record the id belongs to — never by a second kind of button.
  if (state.rwPending.has(id)) return answerRemoteWrite(id, choice, approveBtn);
  // One answer per request, whichever copy was pressed: the second press (the pinned card, or the click that
  // follows a pointerup) is refused while the first is still on its way, so the gateway never sees two answers
  // and the transcript never records the loser's 409 over the winner's decision.
  if (approvalInFlight(id, requestId)) return;
  if (approvalAlreadySent(id, choice)) return;
  noteApprovalSent(id, choice);
  const card = approveBtn.closest(".job");
  const warn = card ? card.querySelector("[data-reply-warn]") : null;
  // The window can close between the paint and the press: the gateway has already denied the command and let the
  // agent carry on, so nothing is sent — the box says what happened instead of spending a request to be told
  // "approval_not_pending" (four of those in a row is what this fence exists for).
  const until = Number(approveBtn.dataset.until) || 0;
  if (until && Date.now() >= until) {
    closeApprovalCard(approveBtn.closest(".turn-approval"));
    if (warn) warn.textContent = "that approval had already expired — the gateway denied the command and the agent carried on";
    approvalSent.delete(approvalKey(id, choice));
    return;
  }
  const key = approvalFlightKey(id, requestId);
  approvalFlights.set(key, { id, requestId, choice, at: Date.now() });
  paintApprovalFlight(id, requestId, "sending");
  try {
    const res = await apiFetch("/api/jobs/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, choice, requestId: approveBtn.dataset.request || null }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) {
      // The panel answers "gone" when the gateway no longer holds the request: the box goes, and the reason is
      // left where the reader is looking rather than on a prompt that can never be answered.
      paintApprovalFlight(id, requestId, "error");
      if (out.gone) closeApprovalCard(approveBtn.closest(".turn-approval"));
      if (warn) warn.textContent = out.error || `approval failed (HTTP ${res.status})`;
      approvalSent.delete(approvalKey(id, choice));
      return;
    }
    // Accepted: the box goes on every surface now, and the decision is written the way the server wrote it,
    // instead of waiting for a snapshot that may be a repaint behind.
    applyApprovalAnswered(id, requestId, out.choice || choice);
  } catch (err) {
    paintApprovalFlight(id, requestId, "error");
    if (warn) warn.textContent = `approval failed: ${err.message}`;
    approvalSent.delete(approvalKey(id, choice));
  } finally {
    // Only this press could have taken the key: a second one was refused above, so removing it here cannot
    // clear another answer in flight.
    approvalFlights.delete(key);
  }
}

// Take the decision away from a card whose request is gone: the buttons become the same note a closed box draws,
// so a click that arrives after the panel answered with `gone` cannot re-post into the same 409.
function closeApprovalCard(card) {
  if (!card || card.classList.contains("is-expired")) return;
  card.classList.add("is-expired");
  const head = card.querySelector(".ta-head");
  if (head) head.textContent = APPROVAL_CLOSED_HEAD;
  const actions = card.querySelector(".ta-actions");
  if (actions) actions.outerHTML = approvalClosedNote();
  // The countdown has nothing left to count, and a stale "~2m left" under a box that is over would be its own
  // small lie. The server-side sweep replaces this box with the one record line within 5s.
  card.querySelector(".ta-foot")?.remove();
}

// ---- approvals ------------------------------------------------------------------
// Requests arrive from the Hermes approval-transport plugin (~/.hermes/plugins/worktree-panel).
// This only records the human's choice: Hermes owns the policy, the timeout and the fail-closed
// behaviour, and a request that expires here is denied there.
const APPROVAL_LABEL = { once: "Allow once", session: "Allow for session", always: "Always allow", deny: "Deny" };

// The dock is folded or not across reloads: it is a corner of the screen, and its state is the reader's.
const APPROVALS_FOLDED_KEY = "wtgui.approvalsFolded";
let approvalThreadsShown = new Set(); // threads that had an approval at the last render

function approvalsFolded() {
  try {
    return localStorage.getItem(APPROVALS_FOLDED_KEY) === "1";
  } catch {
    return false;
  }
}

// Which agent this request belongs to, by the name the reader knows it by: the card's title, else its label,
// else the thread id. "agent" alone was the surface and said nothing about who was blocked.
function approvalAgentName(r) {
  const thread = r && r.thread ? String(r.thread) : "";
  if (thread) {
    const job = [...state.jobs.values()].find((j) => (j.thread || j.id) === thread);
    if (job) return job.title || job.label || thread;
    return thread;
  }
  return r && r.surface ? String(r.surface) : "agent";
}

function approvalCard(r) {
  const left = Math.max(0, Math.round(((r.deadline || 0) - Date.now()) / 1000));
  const buttons = (r.allowed || ["once", "deny"])
    .map((c) => {
      const cls = c === "deny" ? "" : c === "once" ? ' class="primary"' : "";
      return `<button type="button"${cls} data-approval-id="${esc(r.id)}" data-approval-choice="${esc(c)}">${esc(APPROVAL_LABEL[c] || c)}</button>`;
    })
    .join("");
  return `<div class="approval" data-approval="${esc(r.id)}">
    <div class="ap-head"><span class="mono ap-agent" title="${esc(r.thread ? `blocked agent: ${r.thread}` : r.surface || "agent")}">${esc(approvalAgentName(r))}</span>${r.thread ? `<button class="sig sig-panel" data-agent-thread="${esc(r.thread)}" title="jump to the agent blocked on this approval">⧉ agent</button>` : ""}<span class="spacer"></span><span class="mono ${left < 20 ? "warn" : "dimmer"}" data-approval-left="${esc(r.id)}">expires in ${left}s</span></div>
    <pre class="ap-cmd mono">${esc(r.command || "(no command text)")}</pre>
    ${r.description ? `<div class="ap-desc dim">${esc(r.description)}</div>` : ""}
    <div class="ap-actions">${buttons}<span class="ap-err mono"></span></div>
  </div>`;
}

// ---- remote writes: the panel's own permission box, in the same dock --------------------------------
// A worktree the panel cut is LOCAL ONLY by default (see Settings > Branches on the remote). When something tries
// to put a branch on a remote anyway — a worker's `git push`, met by the pre-push guard the panel installed, or
// the panel's own merge flow — the question lands here, and it is the SAME box a parked run gets: same amber
// chrome, same four choices, same deadline and countdown (permissionBoxHtml). Deny leaves the remote untouched;
// Allow tells the waiting hook to go ahead.

// A decided record and a review are RECEIPTS, not fixtures. The dock is a corner of the screen, and a receipt that
// outlives the thing it describes is exactly the "waiting on you" box the reader could not get rid of: both age out
// on the page's own 1 s clock (tickApprovals), so the corner clears itself with no event to wait for.
const DECIDED_TTL_MS = 90_000;
const DECIDED_SHOWN = 3; // the last three, as before: a receipt list is not a log

// One parked write. The head names the tree, because a reader answering three of these needs to know WHICH tree is
// asking; the command line is what will actually run.
function remoteWriteBoxHtml(r) {
  const deadline = Number(r.deadline) || 0;
  const windowMs = (Number(r.timeoutSeconds) || 0) * 1000;
  const closed = Boolean(deadline) && deadline - Date.now() <= 0;
  // FOUR KINDS, ONE BOX. A push and the panel's merge both write to a remote, so the head says "is local-only". An
  // initiative move and a new turnover branch write nothing outside the panel: their titles already name what is
  // waiting, and the head must not claim a push is waiting when what waits is a change to the reader's own project.
  const isMove = r.kind === "initiative";
  const isTurnover = r.kind === "turnover";
  const cardOnly = isMove || isTurnover;
  const kind = r.kind === "merge" ? "the panel's own merge flow" : isMove ? "a change to your initiative map" : isTurnover ? "a new turnover branch" : "a push from this worktree";
  return permissionBoxHtml({
    id: r.id,
    requestId: r.id,
    forAttr: `data-remote-write="${esc(r.id)}" data-rw-tree="${esc(r.worktree || "")}"`,
    head: cardOnly ? `⚠ waiting on you - ${esc(r.title || kind)}` : `⚠ waiting on you — ${esc(kind)}: ${esc(r.project || "this project")} is local-only`,
    note: r.note ? `<div class="rw-note mono" data-rw-note>⚠ ${esc(r.note)}</div>` : "",
    command: r.command || "",
    // The dock knows which tree is asking, so the summary can say whether the push writes outside it.
    root: r.worktree || "",
    choices: Array.isArray(r.allowed) && r.allowed.length ? r.allowed : ["once", "session", "always", "deny"],
    deadline,
    windowMs,
    closed,
    closedHead: isMove
      ? "⚠ no answer inside the panel's window - the map was left as it was"
      : isTurnover
        ? "⚠ no answer inside the panel's window - the turnover branch was not added"
        : "⚠ no answer inside the panel's window — this write has been denied",
    closedNote: isMove
      ? `<div class="ta-note mono">the panel stopped waiting and made no change; the worktree stays where it was</div>`
      : isTurnover
        ? `<div class="ta-note mono">the panel stopped waiting and made no change; the project's turnover branches stay as they were</div>`
        : `<div class="ta-note mono">the panel stopped waiting and told the writer no; nothing was pushed</div>`,
    what: "write",
    titles: isMove
      ? {
          once: "allow this one move - the panel writes it and the Initiatives tab re-reads",
          deny: "refuse: the initiative is left exactly as it is",
        }
      : isTurnover
        ? {
            once: "allow this one branch creation - the panel adds it to the project",
            deny: "refuse: no turnover branch is added and the project stays as it is",
          }
        : {
            once: "allow this one write — the waiting push is told to go ahead",
            session: "allow writes from this worktree until the panel restarts",
            always: "allow remote writes from now on — this WRITES the panel's setting, so the box stops asking",
            deny: "refuse: nothing is pushed and the remote is left exactly as it is",
          },
  });
}

// A decided record: one line, a ✕ of its own, and a click that goes back to the agent the write was about. It is a
// receipt for a question that is OVER, which is why it never shares the head with a pending request.
function remoteWriteDecidedHtml(d) {
  const id = String(d.id || "");
  const denied = String(d.choice || "") === "deny";
  const verb = denied ? (d.expired ? "not answered — denied" : "denied") : `allowed ${d.choice}`;
  const what = d.kind === "initiative" ? "initiative move" : d.kind === "turnover" ? "turnover branch" : "remote write";
  const note = d.note ? `<div class="rw-note mono" data-rw-note>⚠ ${esc(d.note)}</div>` : "";
  return `<div class="rw-record mono${denied ? " is-deny" : ""}" data-rw-record="${esc(id)}" data-rw-tree="${esc(d.worktree || "")}" data-rw-branch="${esc(d.branch || "")}" title="${esc(d.why || "remote write")} — click to go to the agent this write was about">
    <span class="rw-record-text">${denied ? "✕" : "✓"} ${what} ${esc(verb)}${d.command ? `: ${esc(String(d.command).slice(0, 140))}` : ""}</span>
    <button type="button" class="rw-x" data-rw-dismiss="${esc(id)}" title="dismiss this record">✕</button>
    ${note}
  </div>`;
}

// The agent a review is about, by the name the reader knows it by — the card's title, else the thread id.
function reviewAgentName(r) {
  const thread = String(r.agentThread || "");
  if (thread) {
    const job = [...state.jobs.values()].find((j) => (j.thread || j.id) === thread);
    if (job) return job.title || job.label || thread;
  }
  return "the agent";
}

// An auto-allowed write, after the fact: the panel was never asked, so this is the only record that it happened.
// Keep closes it; Unwind is the ONE inverse the record offers - a remote branch delete, or a message drafted to the
// agent when there is no safe inverse. The panel never runs an inverse of its own, and the button is the
// confirmation.
// ---- rw review card
// The card is ONE summary line: what was written, the branch, the repo, the sha and when. The full command, the
// tree it ran from, the allow-policy and what Unwind would run live behind the Details disclosure, so the branch
// is stated once instead of five times down a 400px dock. Keep is the safe action and the whole width of the card,
// with Unwind as the red bar under it (`.rw-keep` + `.rw-review .ap-actions` in the sheet). The class goes on the
// control in BOTH states, because the dismissed record's one control is the same slot.
function remoteWriteReviewHtml(r) {
  const unwind = r.unwind && r.unwind.type ? r.unwind : { type: "message", text: "" };
  const target = r.branch ? `${r.remote || "origin"}/${r.branch}` : "";
  const repo = r.project || String(r.worktree || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "";
  const unwound = r.state === "unwound";
  const action = unwound ? "✕ unwound" : r.kind === "merge" ? "✓ merge started" : "✓ pushed";
  const meta = [repo, r.sha ? String(r.sha).slice(0, 7) : "", fmtAgo(r.at)].filter(Boolean);
  // The clock is the head's tooltip: the line says "just now" (these records live 90 s), and the exact second is
  // one hover away, beside the full branch a narrow dock ellipsizes.
  const clock = r.at ? new Date(Number(r.at)).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  const whole = [action, r.branch, ...meta, clock].filter(Boolean).join(" · ");
  const head =
    `<div class="rw-review-head mono" title="${esc(whole)}">` +
      `<span class="rw-review-line">` +
        `<span class="rw-review-act">${esc(action)}</span>` +
        (r.branch ? `<span class="rw-review-branch">${esc(r.branch)}</span>` : "") +
      `</span>` +
      (meta.length ? `<span class="rw-review-meta">${esc(`${r.branch ? "· " : ""}${meta.join(" · ")}`)}</span>` : "") +
    `</div>`;
  const buttons =
    unwound
      ? `<button type="button" class="rw-keep" data-rw-review-keep="${esc(r.id)}" title="dismiss this record">Dismiss</button>`
      : `<button type="button" class="rw-keep" data-rw-review-keep="${esc(r.id)}" title="keep it - the write stands and this card goes">Keep</button>` +
        (unwind.type === "delete-branch"
          ? `<button type="button" class="btn-deny" data-rw-review-unwind="${esc(r.id)}" title="deletes ${esc(target || "the remote branch")} on the remote - the exact command is under Details, and this click is its confirmation">Unwind</button>`
          : `<button type="button" data-rw-review-unwind="${esc(r.id)}" title="nothing is run: this drafts a message to ${esc(reviewAgentName(r))} instead">Unwind</button>`);
  // Everything the summary left out, in the record's own words: the disclosure costs one muted line closed, and
  // the branch does not have to be repeated to say any of it.
  const line = (key, value) => `<div class="rw-detail"><span class="rw-detail-key">${esc(key)}</span><span class="rw-detail-val">${value}</span></div>`;
  const allowed = [r.why, target].filter(Boolean).join(" · ");
  const unwindText = unwound
    ? r.alreadyGone
      ? `${esc(target || "the remote branch")} was already gone on the remote - nothing was deleted`
      : `${esc(target || "the remote branch")} was deleted from the remote; this record is its receipt`
    : unwind.type === "delete-branch"
      ? `<code>${esc(unwind.command || "")}</code> - this deletes ${esc(target || "the remote branch")}, and the Unwind click is its confirmation`
      : "no safe inverse for this write - Unwind drafts a message to the agent and the panel runs nothing";
  const details =
    `<details class="rw-review-details">` +
      `<summary class="rw-review-sum mono" title="the full command, the tree it ran from, why nobody was asked, and what Unwind runs">details</summary>` +
      `<div class="rw-review-body">` +
        (r.command ? `<pre class="ap-cmd mono">${esc(r.command)}</pre>` : "") +
        (r.worktree ? line("worktree", esc(r.worktree)) : "") +
        (allowed ? line("allowed", esc(allowed)) : "") +
        line("unwind", unwindText) +
      `</div>` +
    `</details>`;
  const jumpNote = r.note ? `<div class="rw-note mono" data-rw-jump-note>⚠ ${esc(r.note)}</div>` : "";
  return `<div class="rw-review" data-rw-review="${esc(r.id)}" data-rw-tree="${esc(r.worktree || "")}" data-rw-branch="${esc(r.branch || "")}" title="click to go to the agent this write came from">
    ${head}
    <div class="ap-actions">${buttons}</div>
    ${details}${jumpNote}
  </div>`;
}
// ---- end rw review card

// Records and reviews live under their OWN heads. The reader's report was a green check under "waiting on you":
// a group label says what a group is, and the dock's head only ever counts what is actually pending.
function rwGroupHtml(kind, label, title, body) {
  return `<div class="ap-group" data-rw-group="${esc(kind)}">
    <div class="ap-group-head mono"><span>${esc(label)}</span><span class="spacer"></span><button type="button" data-rw-clear="${esc(kind)}" title="${esc(title)}">clear</button></div>
    ${body}
  </div>`;
}

function renderApprovals() {
  const sec = $("approvals");
  if (!sec) return;
  const now = Date.now();
  const list = [...state.approvals.values()].sort((a, b) => (a.deadline || 0) - (b.deadline || 0));
  const writes = [...state.rwPending.values()].sort((a, b) => (a.deadline || 0) - (b.deadline || 0));
  const decided = [...state.rwDecided.values()]
    .filter((d) => now - (Number(d.at) || 0) < DECIDED_TTL_MS)
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, DECIDED_SHOWN);
  // Only a write the remote actually shows is drawn: the panel deletes an unconfirmed one for itself, and a card
  // claiming a push that never landed would be its own false record.
  const reviews = [...state.rwReviews.values()]
    .filter((r) => !r.kept && r.state !== "checking" && now - (Number(r.at) || 0) < DECIDED_TTL_MS)
    .sort((a, b) => (b.at || 0) - (a.at || 0));
  const pending = list.length + writes.length;
  // THE HEAD COUNTS. `⚠ waiting on you` only while something IS waiting; a decided record or a review is never
  // placed under a label that claims a question, which was the reader's whole report.
  const headEl = $("approval-head");
  if (headEl) headEl.textContent = pending ? "⚠ waiting on you" : "✓ nothing pending";
  sec.classList.toggle("is-quiet", pending === 0);
  sec.hidden = pending === 0 && decided.length === 0 && reviews.length === 0;
  applyApprovalsFold(sec);
  // The card that says "waiting on you →" is part of the same fact: repaint the threads whose answer changed,
  // instead of leaving the chip on a stale card until the next job event happens to arrive.
  const threadsNow = new Set(list.map((r) => r && r.thread).filter(Boolean));
  for (const thread of new Set([...threadsNow, ...approvalThreadsShown])) {
    if (threadsNow.has(thread) === approvalThreadsShown.has(thread)) continue;
    if (document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`)) renderConversation(thread);
  }
  approvalThreadsShown = threadsNow;
  const listEl = $("approval-list");
  const chipsEl = $("approval-chips");
  if (!listEl || !chipsEl) return;
  if (!pending && !decided.length && !reviews.length) {
    listEl.innerHTML = "";
    chipsEl.innerHTML = "";
    return;
  }
  chipsEl.innerHTML = pending ? `<span class="chip bad">${pending}</span>` : "";
  // The panel's own questions lead (they are the ones holding a worker's push), then the CLI-transport approvals,
  // then the two groups that are OVER: auto-allowed writes to review, and the receipts of writes already decided.
  listEl.innerHTML =
    writes.map(remoteWriteBoxHtml).join("") +
    list.map(approvalCard).join("") +
    (reviews.length
      ? rwGroupHtml(
          "review",
          "auto-allowed · review",
          "keep a write the panel allowed without asking, or unwind it — nothing here runs on its own",
          reviews.map(remoteWriteReviewHtml).join(""),
        )
      : "") +
    (decided.length
      ? rwGroupHtml("decided", "decided", "clear these receipts — each one also ages out after 90 s", decided.map(remoteWriteDecidedHtml).join(""))
      : "");
}

// ---- the dock's own gestures --------------------------------------------------------------------------------
// The reader reported a box that did nothing when clicked. A click on the HEAD or on any CARD is now the way to the
// agent that asked: unfold the stack, then jump through the same jumpToAgent() a row's agent chip uses, so the card
// is flashed and the caret follows it. A decided record has no thread (it keeps what/when only), so its agent is
// resolved from the worktree and branch it was about — and where it cannot be resolved, the card says so.
function revealAgentHome(thread) {
  if (!thread) return;
  // A card only exists in the DOM while its worktree row is open, so unfold the row — and its project and root —
  // first, exactly the three folds revealSpawnedAgent does before it lands on a card it just made.
  const key = rowKeyForThread(thread);
  const row = key ? state.rows.get(key) : null;
  if (row) {
    const project = state.projects.get(row.project);
    const root = project ? rootOf(project) : "";
    if (root && state.collapsedRoots.has(root)) {
      state.collapsedRoots.delete(root);
      saveCollapsedRoots();
      applyRootCollapse(root);
    }
    if (!state.expandedProjects.has(row.project)) toggleProject(row.project);
    if (!state.expanded.has(key)) document.querySelector(`tr.row[data-key="${CSS.escape(key)}"]`)?.click();
  }
  jumpToAgent(thread);
}

// Which agent a remote write came from: the tree first (a write is about one worktree), then the branch. Several
// agents can share a tree, so one that is working or parked wins over one that has stopped.
function rwAgentFor(r) {
  const want = normPath(r?.worktree || "").toLowerCase();
  const branch = String(r?.branch || "");
  const jobs = [...state.jobs.values()];
  const inTree = want ? jobs.filter((j) => normPath(j.ownerPath || j.cwd || "").toLowerCase() === want) : [];
  const pool = inTree.length ? inTree : branch ? jobs.filter((j) => String(j.branch || "") === branch) : [];
  if (!pool.length) return null;
  return pool.find((j) => j.status === "running" || j.status === "starting") || pool[pool.length - 1] || null;
}

function rwUnresolved(r) {
  const what = r?.branch ? `branch ${r.branch}` : "that write";
  const where = r?.worktree ? ` in ${r.worktree}` : "";
  return `no agent card on this board for ${what}${where} — the write is on record, its agent is not`;
}

// Say it instead of doing nothing: a card that cannot find its agent keeps the reason on its own face (a banner
// alone is gone in four seconds) until it is dismissed or ages out.
function dockNote(record, why) {
  if (record && typeof record === "object") record.note = why;
  renderApprovals();
  showBanner(why);
  return false;
}

// One gesture for every dock click that is not a control: unfold, then go to the agent.
function dockGoto(el) {
  const dock = $("approvals");
  if (!dock) return false;
  try {
    localStorage.setItem(APPROVALS_FOLDED_KEY, "0"); // a jump always unfolds: the cards live inside
  } catch {
    /* the jump still happens */
  }
  applyApprovalsFold(dock);
  // A CLI-transport approval names its thread, so it goes straight to the agent.
  const approvalId = el?.dataset?.approval || "";
  if (approvalId) {
    const r = state.approvals.get(approvalId);
    if (r?.thread) {
      revealAgentHome(r.thread);
      return true;
    }
    showBanner(`that approval carries no agent thread${r?.surface ? ` (${r.surface})` : ""} — there is no card to go to`);
    return false;
  }
  const writeId = el?.dataset?.remoteWrite || "";
  const recordId = el?.dataset?.rwRecord || "";
  const reviewId = el?.dataset?.rwReview || "";
  if (writeId || recordId || reviewId) {
    const r =
      (writeId && state.rwPending.get(writeId)) || (recordId && state.rwDecided.get(recordId)) || (reviewId && state.rwReviews.get(reviewId)) || null;
    if (!r) return false;
    const job = rwAgentFor(r);
    if (!job) return dockNote(r, rwUnresolved(r));
    revealAgentHome(job.thread || job.id);
    return true;
  }
  // The head: the most urgent thing the dock holds, in the order it draws them, and the first one that can name an
  // agent. When none can, the FIRST one carries the reason.
  const byDeadline = (a, b) => (a.deadline || 0) - (b.deadline || 0);
  const newest = (a, b) => (b.at || 0) - (a.at || 0);
  const heads = [
    [...state.rwPending.values()].sort(byDeadline)[0],
    [...state.approvals.values()].sort(byDeadline)[0],
    [...state.rwReviews.values()].filter((r) => !r.kept).sort(newest)[0],
    [...state.rwDecided.values()].sort(newest)[0],
  ].filter(Boolean);
  let first = null;
  for (const r of heads) {
    if (!first) first = r;
    const job = r.thread ? null : rwAgentFor(r);
    const thread = r.thread || job?.thread || job?.id || "";
    if (thread) {
      revealAgentHome(thread);
      return true;
    }
  }
  return first ? dockNote(first, rwUnresolved(first)) : false;
}

// Keep: the write stands and the review goes. The panel drops its copy too, so a reload does not bring it back.
async function keepReview(id) {
  const r = state.rwReviews.get(id);
  if (!r) return;
  r.kept = true; // optimistic: the card goes at once
  renderApprovals();
  try {
    const res = await apiFetch("/api/remote-write/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action: "keep" }),
    });
    if (!res.ok) {
      const out = await res.json().catch(() => ({}));
      throw new Error(out.error || `HTTP ${res.status}`);
    }
  } catch (e) {
    state.rwReviews.set(id, { ...r, kept: false });
    renderApprovals();
    showBanner(`could not record that keep: ${e.message}`);
  }
}

// The inverse of an auto-allowed write. A remote branch delete is run by the PANEL from the review's own record: the
// button names it, so the click IS the confirmation, and this page sends the record's ID and never a command.
// Anything with no safe inverse becomes a message DRAFTED to the agent, which the reader sends (or does not) —
// nothing auto-executes.
async function unwindReview(id) {
  const r = state.rwReviews.get(id);
  if (!r) return;
  const plan = r.unwind || {};
  if (plan.type !== "delete-branch") {
    const job = r.agentThread ? [...state.jobs.values()].find((j) => (j.thread || j.id) === r.agentThread) : rwAgentFor(r);
    if (!job) return dockNote(r, `no agent card to draft a message to — ${rwUnresolved(r)}`);
    const thread = job.thread || job.id;
    const text = String(plan.text || "").trim();
    if (!text) return dockNote(r, "no message was drafted for that write — nothing was run");
    revealAgentHome(thread);
    const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
    if (!box) return dockNote(r, "that agent has no reply box on this board — nothing was drafted");
    writeBox(box, text);
    clearBoxDraft(box);
    state.replyDrafts[thread] = text;
    try {
      box.focus({ preventScroll: true });
    } catch {
      box.focus();
    }
    setCaretOffset(box, readBox(box).length);
    showNote(`drafted a message to ${job.title || job.label || thread} — it is yours to send`);
    return;
  }
  const btns = [...document.querySelectorAll(`[data-rw-review-unwind="${CSS.escape(id)}"]`)];
  btns.forEach((b) => (b.disabled = true));
  try {
    const res = await apiFetch("/api/remote-write/unwind", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }), // the id only: the command is the review's, never this page's
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) throw new Error(out.error || `HTTP ${res.status}`);
    state.rwReviews.set(id, out.review || { ...r, state: "unwound", at: Date.now() });
    renderApprovals();
    showBanner(
      out.alreadyGone ? `the remote branch was already gone — ${plan.label || "nothing to delete"}` : `unwound — ${out.did || plan.label || "the write was reversed"}`,
    );
  } catch (e) {
    btns.forEach((b) => (b.disabled = false));
    dockNote(r, `unwind failed: ${e.message}`);
  }
}

function tickApprovals() {
  for (const r of state.approvals.values()) {
    const el = document.querySelector(`[data-approval-left="${CSS.escape(r.id)}"]`);
    if (!el) continue;
    const left = Math.max(0, Math.round(((r.deadline || 0) - Date.now()) / 1000));
    el.textContent = left ? `expires in ${left}s` : "expired";
    el.classList.toggle("warn", left < 20);
  }
  // A decided record and a review are receipts with a lifetime. They age out HERE, on the page's own clock: the
  // corner clears itself whether or not another event ever arrives, which is what the reader asked for after a green
  // check sat under "waiting on you" until a reload.
  const now = Date.now();
  let aged = false;
  for (const [id, d] of state.rwDecided) {
    if (now - (Number(d.at) || 0) >= DECIDED_TTL_MS) {
      state.rwDecided.delete(id);
      aged = true;
    }
  }
  for (const [id, r] of state.rwReviews) {
    if (now - (Number(r.at) || 0) >= DECIDED_TTL_MS) {
      state.rwReviews.delete(id);
      aged = true;
    }
  }
  if (aged) renderApprovals();
  // …and a run's own approval box, which carries the gateway's window: its label counts down, and at the deadline
  // the buttons go. The panel's sweep removes the box a moment later (5s), and this is what covers the gap so the
  // reader never presses a choice the gateway has already refused.
  for (const card of document.querySelectorAll(".turn-approval .ta-foot[data-approval-until]")) {
    const until = Number(card.dataset.approvalUntil) || 0;
    const windowMs = Number(card.dataset.approvalWindow) || 0;
    const left = until - now;
    if (windowMs) {
      const fill = card.querySelector(".ta-timer > span");
      if (fill) fill.style.width = `${Math.max(0, Math.min(100, (left / windowMs) * 100)).toFixed(2)}%`;
    }
    const box = card.closest(".turn-approval");
    const label = card.querySelector(".ta-left");
    if (label) label.textContent = left <= 0 ? "expired" : `~${fmtLeft(left)} left`;
    card.classList.toggle("is-low", left > 0 && left <= 20_000);
    card.classList.toggle("is-over", left <= 0);
    if (left <= 0) closeApprovalCard(box);
  }
  // The CLARIFY count is the same kind of live fact, read off the history route on its own slow tick and repainted here
  // from the number it last read - so the badge and the purple highlight follow an answer, a cancel or a timeout on this
  // page's own clock, not on whichever frame happened to arrive.
  paintClarifyButton();
  // The PERMISSIONS count is the same kind of live fact on the same clock: a request answered in the popup, on a card
  // or by its window closing has to leave the amber badge without waiting for a frame that may never come.
  paintPermissionsButton();
  // The HOT marker is a live fact of the same kind: a turn starts and stops on the gateway's own clock, and a bolt
  // that waited for the next job frame would be drawn after the agent had already begun (or leave a finished one up).
  paintHotButton();
  // The review count is the same kind of live fact: a delivery lands when a run settles, and a row reviewed in
  // another tab or by the bulk press has to leave the count on this clock too.
  paintReviewChip();
}
setInterval(tickApprovals, 1000);

// A background repaint can replace the button between the press and the release, and a click is only delivered
// when both land on the same node - so a parked run that keeps emitting events made its own approval buttons
// unclickable. Both answer paths are therefore driven from pointerup (the element under the cursor at release,
// even a freshly rebuilt one), and this records the choice so the click that sometimes follows does not send it
// twice.
const approvalSent = new Map(); // `${id}|${choice}` -> when it was sent

function approvalKey(id, choice) {
  return `${id || ""}|${choice || ""}`;
}

function approvalAlreadySent(id, choice) {
  const at = approvalSent.get(approvalKey(id, choice));
  return Boolean(at && Date.now() - at < 4000);
}

function noteApprovalSent(id, choice) {
  approvalSent.set(approvalKey(id, choice), Date.now());
  if (approvalSent.size > 40) {
    const cut = Date.now() - 60000;
    for (const [k, at] of approvalSent) if (at < cut) approvalSent.delete(k);
  }
}

async function answerApproval(id, choice, btn) {
  if (approvalAlreadySent(id, choice)) return;
  noteApprovalSent(id, choice);
  const card = btn?.closest(".approval");
  const err = card?.querySelector(".ap-err");
  card?.querySelectorAll("button").forEach((b) => (b.disabled = true));
  if (err) err.textContent = "";
  try {
    const res = await apiFetch("/api/approvals/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, choice }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (err) err.textContent = j.error || `HTTP ${res.status}`;
      card?.querySelectorAll("button").forEach((b) => (b.disabled = false));
      // Nothing was accepted, so the same choice may be pressed again at once.
      approvalSent.delete(approvalKey(id, choice));
    }
  } catch (e) {
    if (err) err.textContent = e.message;
    card?.querySelectorAll("button").forEach((b) => (b.disabled = false));
    approvalSent.delete(approvalKey(id, choice));
  }
}

// Answer a parked remote write. The waiting side is a shell process on this box (the pre-push guard) or the
// panel's own merge flow, and both are told through the panel: this POST is the whole answer, and the collapsed
// line that replaces the box is what the reader has left as the record.
async function answerRemoteWrite(id, choice, btn) {
  const box = btn?.closest(".turn-approval");
  const req = state.rwPending.get(id) || null;
  // The same single flight as a run approval: this box can be drawn on the dock and on the card, and its id is
  // the request id the panel gave it.
  if (approvalInFlight(id, id)) return;
  const key = approvalFlightKey(id, id);
  approvalFlights.set(key, { id, requestId: id, choice, at: Date.now() });
  paintApprovalFlight(id, id, "sending");
  try {
    const res = await apiFetch("/api/remote-write/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, choice, by: "reader" }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) throw new Error(out.error || `HTTP ${res.status}`);
    state.rwPending.delete(id);
    state.rwDecided.set(id, {
      id,
      choice: out.choice || choice,
      why: out.why || "",
      command: req?.command || "",
      // The record has to be able to find its agent after the box is gone: a decided remote write carries no
      // thread, so the tree and the branch it was about are what `dockGoto` resolves through `state.jobs`.
      worktree: req?.worktree || "",
      branch: req?.branch || "",
      kind: req?.kind || "push",
      at: Date.now(),
    });
    renderApprovals();
    // The answer is the panel's, not the push guard's: an initiative move is resumed by the panel itself, and a pane
    // that draws the map (the Initiatives tab) has to hear that the map moved. The event is fired after the state has
    // been written, so a listener that re-reads sees the new store rather than the one it asked about.
    window.dispatchEvent(
      new CustomEvent("wtgui:remote-write-answered", {
        detail: { id, choice: out.choice || choice, kind: req?.kind || "push", worktree: req?.worktree || "", resumed: out.resumed || null },
      }),
    );
    const moved = req?.kind === "initiative";
    showBanner(
      choice === "deny"
        ? moved
          ? "no change - the worktree stays where it was"
          : "remote write denied — nothing was pushed"
        : choice === "always"
          ? "remote writes are now allowed — the setting is saved (Settings > Branches on the remote)"
          : moved
            ? out.resumed?.ok
              ? `${req?.title || "the move"} - it is in the initiative now`
              : `the move could not be made: ${out.resumed?.error || "the store refused it"}`
            : `remote write allowed ${choice}${req?.branch ? ` (${req.branch})` : ""} — the waiting push is going ahead`,
    );
  } catch (e) {
    paintApprovalFlight(id, id, "error");
    box?.classList.add("is-error");
    showBanner(`could not answer that permission request: ${e.message}`);
  } finally {
    approvalFlights.delete(key);
  }
}
