// initiative-fold.js - the Initiatives tab's small rules, as pure functions with a test beside them.
//
// WHY THIS IS A MODULE AND NOT THREE LINES IN THE HANDLER. Each rule here has a wrong answer that still looks right
// on a screenshot, which is exactly the kind that ships:
//
//   * A PRESS ON A CARD means one of four things depending on where it landed. Answering "the card toggles" for
//     every press inside it folds the initiative out from under a reader who pressed a worktree link; answering
//     "only controls act" for every press leaves the title card dead. The four answers, and which one wins, are the
//     function below.
//   * THE DESCRIPTION'S PREVIEW is "the first two lines and then three dots" - and the dots are a lie when the text
//     fits, or when the cut halved a word. The `...` is the caller's to draw, but where the text stops is decided
//     here so it can be tested without a browser: the layout says where line two ends, this backs that offset up to
//     a whole word.
//   * THE PER-ASSISTANT STRIP is four chips in a fixed order, zeros included, because a strip that grew a chip when
//     a count stopped being zero would shift the row sideways every time work moved. The order, the labels and the
//     tones are one list here, so the pane cannot draw three of them and forget the fourth.
//
// Published on globalThis as `wtInitiativeFold`, loaded as a classic script by public/index.html (before
// assistant.js) and imported by test/initiative-fold.test.js - the same load contract public/core/search-dismiss.js
// has. Nothing here touches the DOM: `press` takes a node that can answer `closest`/`contains`, so the test can
// answer it with stubs.
(function (root) {
  "use strict";

  // Three ASCII dots, the marker the panel's folded command cards already end with. Drawn in its own span so the
  // text a copy takes is the description itself, not a sentence that ends in punctuation it never had.
  const DOTS = "...";

  // A folded description is the first two lines the card actually draws, at any width.
  const PREVIEW_LINES = 2;

  // ---- what a press inside an initiative card means ------------------------------------------------
  // The description's header answers first: it toggles the description and nothing else. Then the TITLE CARD, which
  // is itself a button - so it must be answered before the "acts on itself" rule, or the head button would swallow
  // every press on the title and the card would never fold. Then anything that acts on itself - a link, a button, a
  // box being typed in, or any element that says so with `data-init-act`. Then the card's own dead space. On a card
  // that is already unfolded, a press on the body's dead space (the chips, the "edited two days ago" hint) means
  // nothing at all: folding an initiative out from under a reader who was reading it is worse than a press that does
  // nothing.
  const DESC_SELECTOR = "[data-init-desc-fold]";
  const HEAD_SELECTOR = "[data-init-card-toggle]";
  const SELF_SELECTOR = "a, button, input, textarea, select, [data-init-act]";

  const KINDS = Object.freeze(["none", "outside", "description", "self", "card"]);

  function contains(card, node) {
    if (!card || !node) return false;
    if (card === node) return true;
    return typeof card.contains === "function" && Boolean(card.contains(node));
  }

  /**
   * What a press on `target` means, inside initiative card `card`.
   *
   *   "none"        nothing: a press this pane does not answer (a synthetic event, a press on the open body's dead
   *                 space)
   *   "outside"     the press is not inside the card at all - the caller's other controls answer it
   *   "description" fold or unfold that initiative's description, and leave the card open
   *   "card"        fold or unfold the initiative
   *   "self"        a control that acts on itself: a project fold, a worktree link, an assistant's name, Edit
   *
   * `open` is the card's own state, because a folded card is all title card: a press anywhere on it unfolds it.
   */
  function press(target, { card = null, open = true } = {}) {
    if (!target) return "none";
    if (card && !contains(card, target)) return "outside";
    const near = (selector) => (typeof target.closest === "function" ? target.closest(selector) : null);
    if (near(DESC_SELECTOR)) return "description";
    if (near(HEAD_SELECTOR)) return "card";
    if (near(SELF_SELECTOR)) return "self";
    return open ? "none" : "card";
  }

  // ---- the folded description's text ---------------------------------------------------------------
  /**
   * The preview text for a description the layout cut at `at`.
   *
   * `at` is the character offset the folded section's line box ends after - a fact only the browser has, since it
   * depends on the width the card is drawn at and the font it is drawn in. Everything from `at` on is out of the
   * preview, and the last partial word comes out with it: the cut backs up to the whitespace before it, because a
   * preview that ends "…onto Ok" reads as a typo. A cut at or past the end is no cut at all - a description that
   * fits its two lines comes back whole, and the caller draws no dots.
   *
   * Paragraph breaks are kept: the text is never flattened, so a preview of two short paragraphs reads as those
   * two paragraphs and a preview of one long one ends at the word the second line stops on.
   */
  function cut(text, at) {
    const src = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
    const limit = Math.max(0, Math.min(src.length, Math.floor(Number(at) || 0)));
    if (!src || limit >= src.length) return { text: src, truncated: false };
    const head = src.slice(0, limit);
    // The layout stopped BETWEEN two words when the character it did not draw is whitespace: then the head already
    // ends on a whole word and there is nothing to back up over. Otherwise the word at the cut is a partial one and
    // the preview ends before it - that is the whole point of backing up.
    const space = head.search(/\s\S*$/);
    const between = /\s/.test(src.charAt(limit));
    // No whitespace to back up to (one unbreakable token, a URL), or only the one at the very start: the layout's
    // own offset is the honest answer, mid-word and all.
    const keep = between ? limit : space > 0 ? space : head.length;
    const preview = head.slice(0, keep).replace(/\s+$/, "");
    return { text: preview, truncated: Boolean(preview) };
  }

  // ---- the per-assistant strip --------------------------------------------------------------------
  // The order a task moves through, which is also the order the reader reads the strip in: queued first because it
  // is the state before running. `tone` is the chip class the panel already has for that state - running `good`,
  // parked `warn`, and nothing new: a fourth colour for the state that has not started yet would make the strip
  // read as four different things instead of one count of four buckets.
  const COUNT_CHIPS = Object.freeze([
    { key: "queued", label: "queued", tone: "", what: "queued on this initiative's worktrees - filed and not started yet" },
    { key: "running", label: "running", tone: "good", what: "running on this initiative's worktrees, right now" },
    { key: "done", label: "completed", tone: "", what: "completed on this initiative's worktrees" },
    { key: "parked", label: "parked", tone: "warn", what: "parked on this initiative's worktrees - waiting on something outside the assistant" },
  ]);

  /**
   * The four chips, in order, always four: a zero is drawn as a zero rather than left out, so the strip never
   * shifts sideways as work moves between the states.
   */
  function countChips(counts) {
    const c = counts || {};
    return COUNT_CHIPS.map((chip) => {
      const n = Math.max(0, Math.floor(Number(c[chip.key]) || 0));
      const tone = n ? chip.tone : "";
      return {
        key: chip.key,
        label: chip.label,
        count: n,
        zero: n === 0,
        tone,
        cls: `chip${tone ? ` ${tone}` : ""}${n ? "" : " is-zero"}`,
        text: `${n} ${chip.label}`,
        title: `${n} task${n === 1 ? "" : "s"} ${chip.what}`,
      };
    });
  }

  // ---- the exact tasks, under one assistant --------------------------------------------------------
  // A task's state, in the reader's four words and the panel's own tones: running is `good`, parked is `warn`, and
  // the two quiet states stay quiet. `done` is drawn as "done" HERE and as "completed" in the count strip: the strip
  // counts a bucket, the row names the state the queue file stores, and both are the same four states.
  const TASK_STATE_INFO = Object.freeze([
    { id: "queued", label: "queued", tone: "", what: "filed on this initiative's worktrees and not started yet" },
    { id: "running", label: "running", tone: "good", what: "live on this initiative's worktrees right now" },
    { id: "parked", label: "parked", tone: "warn", what: "parked on this initiative's worktrees, waiting on something outside the assistant" },
    { id: "done", label: "done", tone: "", what: "finished on this initiative's worktrees" },
  ]);

  /**
   * The chip one task row wears. An unknown or missing state is drawn as itself rather than dropped: a row the queue
   * cannot place is still a task the reader should see, and a blank chip would read as a rendering defect.
   */
  function taskChip(state) {
    const id = String(state == null ? "" : state);
    const info = TASK_STATE_INFO.find((row) => row.id === id) || null;
    const label = info ? info.label : id || "unknown";
    const tone = info ? info.tone : "";
    return {
      state: id,
      label,
      tone,
      cls: `chip init-task-state${tone ? ` ${tone}` : ""}`,
      title: info ? info.what : `the queue stores "${id || "(no state)"}" for this task`,
    };
  }

  /**
   * The key one assistant's task fold is kept under: the initiative AND the assistant, because two assistants under
   * one initiative fold separately, and the same assistant under two initiatives is two rows in two cards.
   */
  function taskFoldKey(initiativeId, assistantId) {
    return `${String(initiativeId == null ? "" : initiativeId)}::${String(assistantId == null ? "" : assistantId)}`;
  }

  // ---- the cards one fold draws, and how many of them ------------------------------------------------
  // A compact card is the QUEUE's own card (public/queue-cards.js `taskCardHtml`, mode "compact"), so this module
  // decides only the two things the fold adds: WHICH cards come first, and HOW MANY are painted before the reader
  // asks for the rest. An assistant can carry 169 rows on one initiative, and painting all of them into a tab that
  // is usually closed is the cost this window exists to avoid.
  //
  // THE ORDER. Running, then queued, then parked - the states somebody is acting on or waiting on - then the most
  // recent done rows. Within a bucket the caller's order is kept: the route hands the rows newest activity first, so
  // the first `running` row is the one that moved most recently. It is the queue pane's own bucket order
  // (`QUEUE_BUCKET` in queue-cards.js), so the two surfaces cannot disagree about which task matters now.
  const TASK_CARD_BUCKET = Object.freeze({ running: 0, queued: 1, parked: 2, done: 3 });
  // How many cards a fold draws before its "show more": enough that an assistant with a handful of rows is complete
  // on the first look, few enough that the fold never becomes the tab's whole height.
  const TASK_CARD_FIRST = 6;
  // What one press adds, the queue pane's own slice size, so the two "more" controls move in the same steps.
  const TASK_CARD_MORE = 50;

  /**
   * The rows in the order a fold draws them: the states being acted on first, then the finished ones.
   */
  function taskCardOrder(rows) {
    const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
    return list
      .map((row, at) => ({ row, at }))
      .sort((a, b) => {
        const ab = TASK_CARD_BUCKET[String(a.row.state || "")];
        const bb = TASK_CARD_BUCKET[String(b.row.state || "")];
        return (ab === undefined ? 2 : ab) - (bb === undefined ? 2 : bb) || a.at - b.at;
      })
      .map((x) => x.row);
  }

  /**
   * The window one fold paints: the first `shown` rows in `taskCardOrder`, and an honest count of what is left.
   *
   * `hidden` is the number NOT drawn, `more` is how many one press adds (never more than is left), and `total` is
   * every row the fold holds - the number the count chip beside the fold already carries. `shown` below one is the
   * first window rather than an empty list: a fold that opens on nothing is not a state any caller asked for.
   */
  function taskCardWindow(rows, shown = TASK_CARD_FIRST) {
    const ordered = taskCardOrder(rows);
    const want = Math.max(1, Math.floor(Number(shown)) || TASK_CARD_FIRST);
    const visible = ordered.slice(0, want);
    const hidden = ordered.length - visible.length;
    return { visible, hidden, more: Math.min(TASK_CARD_MORE, hidden), total: ordered.length };
  }

  // ---- one line of an initiative's history ---------------------------------------------------------
  /**
   * What one stored event says, in the reader's words.
   *
   * The actor is the point: the history exists so a removal can be judged against who put the tree there, and a fold
   * that said "attached a tree" without naming who would leave the reader exactly where the guess was. `reader` is
   * drawn as "you" (the panel's own word for the person pressing), an assistant keeps its id, and the time is handed
   * back untouched for the caller to draw - `at` is the ISO string, and the relative sentence belongs to the page's
   * clock, not to this module.
   */
  function historyLine(event) {
    const ev = event && typeof event === "object" ? event : {};
    const by = String(ev.by || "reader");
    const who = by === "reader" ? "you" : by;
    const name =
      String(ev.tree || "")
        .replace(/\\/g, "/")
        .replace(/\/+$/, "")
        .split("/")
        .filter(Boolean)
        .pop() || String(ev.tree || "");
    let what;
    switch (String(ev.action || "")) {
      case "create":
        what = "created this initiative";
        break;
      case "edit":
        what = `edited ${String(ev.detail || "the words").trim() || "the words"}`;
        break;
      case "attach":
        what = name ? `attached ${name}` : "attached a worktree";
        break;
      case "detach":
        what = name ? `removed ${name}` : "removed a worktree";
        break;
      default:
        what = "changed this initiative";
    }
    return { who, what, at: typeof ev.at === "string" ? ev.at : null };
  }

  // ---- the initiative's route mark -----------------------------------------------------------------
  // A FOLDED INITIATIVE MUST SAY WHERE THE WORK HAS GOT TO. Round A found the folded card spent its pixels on the
  // title and the description preview and showed nothing about the thing the tab exists for; round B's second
  // finding was that the tab has no rank. The mark is the smallest honest answer: one dot per wave in the wave's own
  // derived state, and a label naming the current station - both read straight from the payload, never invented. A
  // wave with no state is drawn idle, a store that cannot be read says so instead of saying "no waves", and an
  // initiative with no waves says that.
  const WAVE_TONES = Object.freeze({
    running: "is-running",
    ready: "is-ready",
    blocked: "is-blocked",
    unknown: "is-unknown",
    done: "is-done",
    abandoned: "is-abandoned",
    empty: "is-empty",
    unentered: "is-unentered",
  });

  /**
   * The route mark for one initiative: `{ dots, label, tone, title }`.
   *
   * `dots` is one entry per wave, in position order as the route returned them, carrying the wave's own `state` and
   * whether it is the one `waveCurrentId` names. `label` is the status word the folded row shows - "W3 running", or
   * the honest "no waves" / "waves unreadable". `tone` is the class the pill wears, from the same state vocabulary.
   */
  function routeGlyph(init, waveStatus = null) {
    const unreadable = Boolean(waveStatus && waveStatus.readable === false);
    if (unreadable) {
      return {
        dots: [],
        label: "waves unreadable",
        tone: "is-unknown",
        title: `the wave store cannot be read, so this initiative's position is unknown: ${String(waveStatus.error || "no reason given")}`,
      };
    }
    const waves = Array.isArray(init && init.waves) ? init.waves : [];
    if (!waves.length) {
      return { dots: [], label: "no waves", tone: "is-idle", title: "no wave is recorded on this initiative yet - a wave is a named position a task joins by naming its id" };
    }
    const currentId = init && init.waveCurrentId ? String(init.waveCurrentId) : "";
    const dots = waves.map((w) => {
      const state = String((w && w.state) || "empty");
      return {
        id: String((w && w.id) || ""),
        position: Number(w && w.position) > 0 ? Number(w.position) : null,
        state,
        tone: WAVE_TONES[state] || "is-empty",
        current: Boolean(currentId) && String((w && w.id) || "") === currentId,
      };
    });
    const current = dots.find((d) => d.current) || null;
    const why = current ? String((waves.find((w) => String(w && w.id) === current.id) || {}).stateWhy || "") : "";
    const label = current ? `W${current.position || "?"} ${current.state}` : `${dots.length} wave${dots.length === 1 ? "" : "s"}`;
    const route = dots.map((d) => `W${d.position || "?"} ${d.state}${d.current ? " (current)" : ""}`).join(", ");
    return {
      dots,
      label,
      tone: current ? current.tone : "is-idle",
      title: `${route} - the current station is the one the stated order makes current${why ? `: ${why}` : ""}`,
    };
  }

  root.wtInitiativeFold = {
    DOTS, PREVIEW_LINES, KINDS, COUNT_CHIPS, TASK_STATE_INFO, TASK_CARD_BUCKET, TASK_CARD_FIRST, TASK_CARD_MORE,
    press, cut, countChips, historyLine, taskChip, taskFoldKey, taskCardOrder, taskCardWindow, routeGlyph,
  };
})(globalThis);
