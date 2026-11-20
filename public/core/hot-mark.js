// hot-mark.js - which agents are HOT: the ones working right now, and the press that lands on one.
//
// THE WORD, AND THE WIRE. The header control this module feeds is labelled Active (it read Hot before the rename);
// the file name, the global, the element ids and the browser key keep `hot`, because they are the wire, not the
// word a person reads. Every title and aria-label this file answers says Active.
//
// WHY THIS IS A MODULE. The header's bolt, its count, its tooltip and the press that steps to an agent all have to
// answer "is this agent hot" the same way, and the answer is one predicate. It lives here so it is answered once:
// the page reads it (public/app.js `paintHotButton` / `hotStep`), and test/hot-mark.test.js drives the same file with
// the turn records a real store writes. A predicate copied into the count and again into the tooltip is how a marker
// ends up saying two agents while the press walks three.
//
// HOT IS NOT LIVE, and the difference is the whole point of the control. The panel calls a turn live while it is
// running, starting, waiting, queued, OR parked on a permission or a question (public/board-scaffold.js LIVE_STATUS,
// and lib/jobs.js LIVE_JOB_STATUS agrees) - a parked turn is still inside the turn, and counting it as finished was
// once a real defect. But a parked turn is not WORKING: it is waiting on the reader, and that is the red Human
// count's own subject. So the bolt is the other half of the same board: amber for an agent that is burning right
// now, red on Human for one that is stuck on you. Every status in HOT_STATUS is also in LIVE_STATUS (the test pins
// the subset), and `waiting_for_approval` is deliberately absent.
//
// A turn carrying an OPEN approval or question is not hot whatever its status says: the approval event and the
// status event arrive on different frames, so a record can read `running` with a park already on it. The ask is open
// while its deadline has not passed (the same window public/board-scaffold.js `approvalLive` reads: a record with no
// deadline is open, not closed).
//
// THE ROTATION. `step` is the press's arithmetic - the next agent after the one last shown, wrapping at the end -
// so a button that has lost an agent between two presses does not walk backwards or stall.
//
// Published on globalThis as `wtHotMark`, loaded as a classic script by public/index.html before app.js, and
// imported by test/hot-mark.test.js - the same load contract public/core/review-lane.js has.
(function (root) {
  "use strict";

  // The statuses an agent is WORKING in. `waiting` is the gap between two tool calls inside a live turn, `queued`
  // is a run the gateway is about to start - both are the agent's own clock moving, neither is the reader's.
  const HOT_STATUS = new Set(["running", "starting", "waiting", "queued"]);

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // An ask is OPEN while its window has not closed. A record with no readable deadline is open (an older record, or
  // a gateway that names no window): guessing "closed" would say a parked agent is working while its box waits.
  function asks(ask, now) {
    if (!ask) return false;
    const deadline = Number(ask.deadline);
    return !Number.isFinite(deadline) || now < deadline;
  }

  // THE ONE PREDICATE. `now` is injected so a test can drive a deadline without waiting on a clock.
  function hot(turn, now = Date.now()) {
    if (!turn) return false;
    if (!HOT_STATUS.has(String(turn.status || ""))) return false;
    if (asks(turn.approval, now) && !turn.approvalDone) return false;
    if (asks(turn.question, now) && !turn.questionDone) return false;
    return true;
  }

  // Every agent with at least one hot turn, one entry per THREAD - a thread's turns are one agent, and the newest
  // hot turn is the one its name and its tree are read from. The caller's order is kept (public/turns.js
  // `conversations` hands them newest first), so the press walks the board the way the reader reads it.
  function agents(convs, { now = Date.now() } = {}) {
    const out = [];
    for (const c of convs || []) {
      let turn = null;
      for (const t of c?.turns || []) if (hot(t, now)) turn = t;
      if (!turn) continue;
      out.push({
        key: String(c.thread || turn.thread || turn.id || ""),
        thread: c.thread || turn.thread || null,
        turn,
        sinceMs: Date.parse(turn.startedAt || "") || 0,
      });
    }
    return out;
  }

  function count(list) {
    return (list || []).length;
  }

  // The next agent after the one the last press landed on, wrapping. A key that has left the list (the agent
  // finished) starts again from the first, which is the newest agent on the board.
  function step(list, key) {
    const items = list || [];
    if (!items.length) return null;
    const at = key ? items.findIndex((a) => a.key === key) : -1;
    return items[(at + 1) % items.length];
  }

  // The button's tooltip. It names the agents and the trees they are working in, says what the press does, and draws
  // the line between this amber and Human's red in the reader's own words - the two controls are read side by side.
  // The word is ACTIVE: the control's ids and its module keep the old name `hot` on the wire (and this file is one of
  // them), but a person reads Active, and every title and aria-label this file answers says so.
  function title(list) {
    const items = (list || []).filter(Boolean);
    if (!items.length) {
      return "Active agents - nothing is working right now: no agent on this board is inside a turn. This button is drawn only while one is; a turn parked on a permission or a question is the red Human count, not this.";
    }
    const named = items.map((a) => (a.where ? `${a.name || a.key} (${a.where})` : a.name || a.key));
    return `Active agents - ${plural(items.length, "agent", "agents")} working right now: ${named.join(", ")}. Click to land on the next one: its row opens if it has one, the board scrolls to its card and the card flashes. A turn parked on a permission or a question is not active - that is the red Human count, and the yellow lock and the blue turnover mark on a row are other things again. Settings > General > "Show the Active agents button in the floating header" turns this button off.`;
  }

  root.wtHotMark = { HOT_STATUS, hot, asks, agents, count, step, title };
})(globalThis);
