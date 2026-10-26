// board/hot.js — the "hot agent" rotation through the agents that are waiting on you.
//
// Extracted from public/app.js as M13 in .agentboard/refactor-research/frontend-app-js.md (§2, §5 step 2),
// moved line for line: lines 11148-11333 of public/app.js at ae528c7. Nothing renamed, nothing rewritten, no
// call site touched.
//
// WHAT MOVED: the section comment and everything under it — hotWaiting, hotCandidates, hotRowFor,
// hotStillWaiting, flashHotCard, paintHotButton, hotOpenPath, hotFocus, hotStep, hotToggle, hotAfterSend —
// and the #btn-hot click listener that turns the rotation on, which the plan counts as part of this unit. It
// is the smallest surface in the file: 186 lines, and the plan records only two inbound call units (hotStep
// and hotAfterSend, both from the click/keyboard wiring).
//
// LOADED AS A CLASSIC SCRIPT, BEFORE app.js (see index.html). The names stay page globals, exactly as they
// were. Its own state slice is the one thing it owns and writes: state.hot (the visit stack and the cursor),
// plus state.hotFlash and state.hotFlashTimer for the amber ring. Nothing here writes a property another
// module also writes.
//
// WHAT IT STILL REACHES OUT FOR (by name, at call time): state (public/app.js, M1), conversations (M6),
// agentsFor / showBanner (M5), keyOf and $ (core/dom-format.js), toggleProject (M1), applyRootCollapse /
// paintCollapseAll / saveCollapsedRoots (M8), scrollCardUnderBar (M12), CSS.escape.
//
// The listener registers at load, one step earlier in the same tick than it used to: it takes the button by
// id, and the button is static markup, so there is nothing to wait for.

// ---- NOT-RUNNING (the hot-agent rotation) --------------------------------------------------
// A rotation through the agents that are waiting on you: a card whose latest turn is NOT running has said what
// it wanted and is sitting there. Turning this on opens the first one, puts the caret in its reply box and
// flashes that box amber; Enter sends and moves to the next, Alt+Right skips one, Alt+Left steps back. The box
// flashes on every hop, not just the first, so the eye can follow the caret through the list.

function hotWaiting() {
  return conversations().filter((c) => {
    const t = c.latest || {};
    return t.status !== "running" && t.status !== "starting";
  });
}

function hotCandidates() {
  const waiting = hotWaiting();
  // Visible cards first, in the order the board shows them, then everything else newest-first: a folded
  // project has no cards in the DOM and those agents are just as waiting.
  const rank = new Map([...document.querySelectorAll(".agents-block .job")].map((el, i) => [el.dataset.thread, i]));
  const dom = waiting.filter((c) => rank.has(c.thread)).sort((a, b) => rank.get(a.thread) - rank.get(b.thread));
  const rest = waiting
    .filter((c) => !rank.has(c.thread))
    .sort((a, b) => Date.parse(b.latest?.startedAt || 0) - Date.parse(a.latest?.startedAt || 0));
  return [...dom, ...rest].map((c) => c.thread);
}

function hotRowFor(thread) {
  for (const row of state.rows.values()) {
    if (agentsFor(row).some((c) => c.thread === thread)) return row;
  }
  return null;
}

function hotStillWaiting(thread) {
  const conv = conversations().find((c) => c.thread === thread);
  if (!conv) return false;
  const t = conv.latest || {};
  return t.status !== "running" && t.status !== "starting";
}

// The whole card flashes, not just the box: the rotation moves the reader's attention to a panel, and a ring
// around the panel is what says "this one". The caret still lands in the reply box.
function flashHotCard(thread) {
  const card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
  if (!card) return;
  const until = Date.now() + 1300;
  state.hotFlash = { thread, until };
  card.classList.remove("hot-flash");
  void card.offsetWidth; // restart it even when the last flash is still fading
  card.classList.add("hot-flash");
  clearTimeout(state.hotFlashTimer);
  state.hotFlashTimer = setTimeout(() => {
    state.hotFlash = { thread: null, until: 0 };
    document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`)?.classList.remove("hot-flash");
  }, 1300);
}

function paintHotButton() {
  const btn = $("btn-hot");
  if (!btn) return;
  const h = state.hot;
  btn.classList.toggle("on", h.on);
  btn.textContent = h.on ? `NOT-RUNNING ${Math.min(h.cursor + 1, h.stack.length)}/${h.stack.length}` : "NOT-RUNNING";
  btn.title = h.on
    ? "NOT-RUNNING is on — Enter sends and moves to the next agent that is waiting on you, Alt+Right skips, Alt+Left goes back. Click to stop."
    : "NOT-RUNNING — step through the agents that are not running and are waiting on you: each one is opened, its reply box focused and flashed amber. Enter sends and moves on; Alt+Right skips; Alt+Left goes back.";
}

// Open exactly the path to one card and close everything else: after Collapse all the project is only "open"
// in state, and the folder holding it is still shut - an open project inside a closed folder is not on screen,
// which is why the counter moved and nothing appeared. The rotation keeps one project visible at a time.
function hotOpenPath(row) {
  const project = row.project;
  for (const name of [...state.expandedProjects]) {
    if (name !== project) toggleProject(name);
  }
  const sec = document.querySelector(`section.project[data-project="${CSS.escape(project)}"]`);
  const root = sec?.closest("section.root-group")?.dataset.root;
  if (root && state.collapsedRoots.has(root)) {
    state.collapsedRoots.delete(root);
    saveCollapsedRoots();
    applyRootCollapse(root);
    paintCollapseAll();
  }
  if (!state.expandedProjects.has(project)) toggleProject(project);
  const key = keyOf(project, row.path);
  if (!state.expanded.has(key)) {
    document.querySelector(`tr.row[data-key="${CSS.escape(key)}"]`)?.click();
  }
}

function hotFocus(thread) {
  const row = hotRowFor(thread);
  if (!row) return false;
  hotOpenPath(row);
  let card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
  if (!card) return false;
  if (card.classList.contains("collapsed")) {
    // Unfolding repaints the card, so the node we clicked is replaced: re-query or every step after this
    // (scroll, focus, flash) runs against a detached element and does nothing visible.
    card.querySelector(".job-head")?.click();
    card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`) || card;
  }
  scrollCardUnderBar(card);
  const box = card.querySelector(".reply-box");
  if (box) {
    try {
      box.focus({ preventScroll: true });
    } catch {
      box.focus();
    }
    const end = box.value.length;
    if (box.setSelectionRange) box.setSelectionRange(end, end);
  }
  flashHotCard(thread);
  return true;
}

function hotStep(dir) {
  const h = state.hot;
  if (!h.on) return;
  if (dir > 0) {
    let i = h.cursor;
    while (i + 1 < h.stack.length) {
      i += 1;
      if (hotStillWaiting(h.stack[i]) && hotFocus(h.stack[i])) {
        h.cursor = i;
        paintHotButton();
        return;
      }
    }
    const next = hotCandidates().find((t) => !h.stack.includes(t));
    if (!next) {
      showBanner("NOT-RUNNING: no agents are waiting for input");
      return;
    }
    h.stack.push(next);
    h.cursor = h.stack.length - 1;
    hotFocus(next);
    paintHotButton();
    return;
  }
  let i = h.cursor;
  while (i - 1 >= 0) {
    i -= 1;
    if (hotStillWaiting(h.stack[i]) && hotFocus(h.stack[i])) {
      h.cursor = i;
      paintHotButton();
      return;
    }
  }
}

function hotToggle() {
  const h = state.hot;
  h.on = !h.on;
  if (!h.on) {
    h.stack = [];
    h.cursor = -1;
    paintHotButton();
    return;
  }
  const list = hotCandidates();
  if (!list.length) {
    h.on = false;
    paintHotButton();
    showBanner("NOT-RUNNING: no agents are waiting for input");
    return;
  }
  h.stack = [list[0]];
  h.cursor = 0;
  paintHotButton();
  hotFocus(list[0]);
}

// Enter in the hot card: the reply is on its way, so fold that project away and step on.
function hotAfterSend(thread) {
  if (!state.hot.on) return;
  const row = hotRowFor(thread);
  if (row && state.expandedProjects.has(row.project)) toggleProject(row.project);
  hotStep(1);
}

$("btn-hot")?.addEventListener("click", (e) => {
  e.stopPropagation();
  hotToggle();
});

window.WMApp = window.WMApp || {};
window.WMApp.board = window.WMApp.board || {};
// Published for the later steps of the split; nothing reads it yet.
window.WMApp.board.hot = { hotWaiting, hotCandidates, hotStillWaiting, hotToggle, hotStep, hotAfterSend, paintHotButton };
