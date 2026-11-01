// core/type-stream.js — how fast a run's output reaches the reader's eyes.
//
// A turn's prose reaches the browser as coalesced frames (lib/jobs.js TEXT_FLUSH_MS, 120 ms) and a fast model
// fills each one with several words, so the console line jumps a phrase at a time. Tool results and reasoning
// blocks arrive as whole lines instead. Both are honest — they are what the wire sent — but neither reads like an
// agent writing, and the reader asked to watch it flow. The result of a skill is the one tool result that gets the
// same treatment as the prose and the reasoning: it is the longest thing a console is handed at once.
//
// Two mechanisms, deliberately separate, because they answer two different questions:
//
//   * the PACER holds the tail of ONE growing line and hands it back a word at a time. A line is fed its whole
//     new text and returns the prefix that may be drawn NOW; the rest leaves on the pacer's own clock. What is
//     drawn is always an exact prefix of the wire's text cut on a word boundary, so a copy of a half-typed line
//     copies what is on screen and the next frame simply extends it. Rate 0 keeps nothing: every frame is drawn
//     whole, exactly as before this existed. Three kinds of line are fed to it: a paragraph of the agent's own
//     words, a reasoning block, and the lines of a skill's result (isPacedTool below).
//   * the GATE holds WHOLE LINES that have just joined a console and releases them one at a time. That is the
//     line-by-line setting: a burst of tool lines and results walks in instead of landing in one paint. A growth
//     frame for a line the gate is still holding updates the held copy instead of jumping the queue, and a held
//     line is not in the console's record yet — a repaint mid-burst shows the transcript as far as it has got,
//     which is the truth.
//
//   * the REASONING HOLD keeps a tool's lines out of the console until the reasoning in front of them has finished
//     being written. The pacer types a thought at the reader's words-a-second, and a tool call (and its output) that
//     follows it is whole lines on the wire: left alone it lands while the thought above it is still being typed,
//     and the reader watches the answer arrive before the question. The hold queues those frames, in order, behind
//     the thought and lets them go the moment the pacer has nothing left to say for it. It knows nothing about the
//     page: the caller says which frames wait (`wants`), what they wait for (`busy`) and what to do when a hold
//     begins (`start` — the page uses it to read the store again, because a reply's reasoning lands there a moment
//     after the tool call it made is already on the wire).
//
// All three are flushed by the caller when the turn settles, so nothing is ever left sitting in a buffer: the clock
// here outlives the wire, not the run.
//
// This is a classic script in the page and a plain module to node (it publishes itself on globalThis), so
// test/type-stream.test.js drives the ONE implementation the page runs, with its clock and timer injected.
(function (root) {
  "use strict";

  // Words per second. Measured on this box: a long answer streams at ~37 words/s, so 40 keeps up with it — the
  // console never trails and still fills in one or two words at a time instead of a coalesced frame's four or five.
  const DEFAULT_WORDS = 40;
  const MAX_WORDS = 200;
  const MAX_LINES = 40;
  const MIN_TICK_MS = 40; // ~25 fps: finer than the eye needs and cheap on a board of cards
  const MAX_ENTRIES = 4000; // a line per entry, and the console keeps 1000 per job
  const MAX_QUEUE = 600;
  // No hold outlasts this. A hold ends because the thought has been written, which the pacer always gets to; this is
  // the fence for the day it does not (a clock that stopped, a read that never answers), and it is far past any
  // reasoning a reader would sit through at a rate they chose.
  const MAX_HOLD_MS = 120_000;

  const clampWords = (v) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(MAX_WORDS, n);
  };
  const clampLines = (v) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(MAX_LINES, n);
  };

  // WHICH TOOL RESULTS ARE WRITTEN, NOT DROPPED IN. Prose and reasoning type out through the pacer; so does the
  // result of a SKILL. It is the biggest block of text a run hands a console in one go — a SKILL.md is the card's
  // whole 40-line, 400-character head arriving in a single paint — and it is the one result a reader watches arrive,
  // so the lines of skill_view / skills_list / skill_manage are fed to the pacer as they join the console and type
  // out at the same words-a-second as everything else (and walk in at the same lines-a-second: the gate already
  // holds every line). Every other tool's result is still drawn whole, exactly as before; widening this is this one
  // predicate and nothing else.
  const PACED_TOOL_RE = /^skill/i;
  const isPacedTool = (name) => PACED_TOOL_RE.test(String(name ?? "").trim());

  const isSpace = (c) => c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f" || c === "\v" || c === "\u00a0";

  // How many words are left in `text` from character `from`.
  function wordsIn(text, from = 0) {
    const s = String(text ?? "");
    let n = 0;
    let i = from < 0 ? 0 : from;
    while (i < s.length) {
      while (i < s.length && isSpace(s[i])) i++;
      if (i >= s.length) break;
      n++;
      while (i < s.length && !isSpace(s[i])) i++;
    }
    return n;
  }

  // The index just past `n` words of `text`, counting from `from`. The whitespace in front of each word travels
  // with it, so the prefix ends at the last character of the last word released. With fewer words left than
  // asked for this is the end of the text.
  function advance(text, from, n) {
    const s = String(text ?? "");
    let i = from < 0 ? 0 : from;
    let left = Math.max(0, Math.round(n));
    while (left > 0) {
      while (i < s.length && isSpace(s[i])) i++;
      if (i >= s.length) return s.length;
      while (i < s.length && !isSpace(s[i])) i++;
      left--;
    }
    return i;
  }

  const defaults = (opts, now) => ({
    now: opts.now || now || (() => Date.now()),
    schedule: opts.schedule || ((fn, ms) => setTimeout(fn, ms)),
    cancel: opts.cancel || ((id) => clearTimeout(id)),
  });

  /**
   * The word pacer: one entry per console line that is being revealed.
   * @param opts.rate       words per second (0 = off, the caller draws every frame whole)
   * @param opts.onPaint    called with the line ids whose visible prefix just grew
   * @param opts.now / schedule / cancel   injected in node by the test
   */
  function createPacer(opts = {}) {
    const { now, schedule, cancel } = defaults(opts);
    const onPaint = opts.onPaint || (() => {});
    let rate = clampWords(opts.rate ?? DEFAULT_WORDS);
    const lines = new Map(); // lid -> { job, full, shown, budget, last }
    let timer = null;

    const restOf = (e) => wordsIn(e.full, e.shown);
    const pendingAny = () => {
      for (const e of lines.values()) if (restOf(e) > 0) return true;
      return false;
    };
    const tickMs = () => Math.max(MIN_TICK_MS, Math.min(250, Math.round(1000 / Math.max(0.5, rate))));

    function arm() {
      if (timer != null || !rate || !pendingAny()) return;
      timer = schedule(run, tickMs());
    }
    function disarm() {
      if (timer == null) return;
      cancel(timer);
      timer = null;
    }
    function run() {
      timer = null;
      tick(now());
      arm();
    }

    /**
     * The wire says this line now reads `text`. Returns the prefix to draw right now.
     *
     * Cumulative growth extends what is already queued; anything else (a frame that rewrites the line, a
     * replacement after a trim) snaps to the new text, because typing out a line that has been rewritten is a
     * promise about the past that nobody made.
     */
    function feed(lid, job, text) {
      const full = String(text ?? "");
      if (!rate) {
        lines.delete(lid);
        return full;
      }
      let e = lines.get(lid);
      if (!e) {
        if (lines.size >= MAX_ENTRIES) lines.delete(lines.keys().next().value);
        e = { job: String(job ?? ""), full: "", shown: 0, budget: 0, last: now() };
        lines.set(lid, e);
      }
      if (job != null) e.job = String(job);
      if (full === e.full) return e.full.slice(0, e.shown);
      if (!full.startsWith(e.full)) {
        e.full = full;
        e.shown = full.length;
        e.budget = 0;
        return full;
      }
      // A line that had gone quiet starts its budget again from now: the clock stopped while there was nothing
      // to release, so the seconds since the last tick are not words anybody is owed.
      const wasIdle = restOf(e) === 0;
      e.full = full;
      if (wasIdle) {
        e.budget = 0;
        e.last = now();
      }
      arm();
      return e.full.slice(0, e.shown);
    }

    /**
     * What may be drawn for this line now, or null when this line is not being paced (draw it whole).
     *
     * `text` is the line as the RECORD holds it — the caller's own row, not the pacer's memory. Given it, the pacer
     * only answers while it can honestly claim a prefix of that line: a line the record has moved past (the reader
     * was away, so no frame was ever fed here) or rewritten (a trim moved it) is not being typed any more, and the
     * entry is dropped so the record draws whole from then on. Without it the entry answers for itself, which is
     * what a caller with no record in hand wants. Why this matters: a prefix that can no longer grow is text the
     * console loses — "This" painted over a paragraph that started "This branch was added to main".
     */
    function shownFor(lid, text) {
      const e = lines.get(lid);
      if (!e) return null;
      if (text == null) return e.full.slice(0, e.shown);
      const full = String(text);
      if (full === e.full) return e.full.slice(0, e.shown);
      if (restOf(e) === 0 || !full.startsWith(e.full)) {
        lines.delete(lid);
        return null;
      }
      return e.full.slice(0, e.shown);
    }

    /** Release the next words that are due. Returns whether anything is still waiting. */
    function tick(when) {
      const t = Number.isFinite(when) ? when : now();
      const painted = [];
      for (const [lid, e] of lines) {
        const rest = restOf(e);
        if (!rest) {
          // Nothing waiting: bank nothing, so the next frame cannot arrive as a dump.
          e.budget = 0;
          e.last = t;
          continue;
        }
        e.budget += (rate * Math.max(0, t - e.last)) / 1000;
        e.last = t;
        const n = Math.floor(e.budget);
        if (n <= 0) continue;
        e.budget -= n;
        const end = advance(e.full, e.shown, Math.min(n, rest));
        if (end === e.shown) continue;
        e.shown = end;
        painted.push(lid);
      }
      if (painted.length) onPaint(painted);
      return pendingAny();
    }

    /** Show everything this line has right now (the turn settled, or the reader asked for it). */
    function flush(lid) {
      const e = lines.get(lid);
      if (!e) return null;
      e.shown = e.full.length;
      e.budget = 0;
      e.last = now();
      disarm();
      arm();
      return e.full;
    }

    function flushJob(job) {
      const id = String(job ?? "");
      const out = [];
      for (const [lid, e] of lines) {
        if (e.job !== id) continue;
        if (restOf(e) > 0) {
          e.shown = e.full.length;
          out.push(lid);
        }
        e.budget = 0;
        e.last = now();
      }
      // Another card may still be typing: the clock keeps running for it.
      disarm();
      arm();
      if (out.length) onPaint(out);
      return out;
    }

    function releaseAll() {
      const out = [];
      for (const [lid, e] of lines) {
        if (restOf(e) <= 0) continue;
        e.shown = e.full.length;
        out.push(lid);
      }
      disarm();
      if (out.length) onPaint(out);
      return out;
    }

    function setRate(v) {
      const next = clampWords(v);
      const was = rate;
      rate = next;
      if (!next) {
        releaseAll();
        lines.clear();
        disarm();
      } else if (next !== was) {
        disarm();
        arm();
      }
      return rate;
    }

    // Is any line of this job still being written? `test(lid)` narrows it to the lines the asker cares about (the
    // reasoning hold asks about thoughts only, and only the ones that belong in front of the call it is holding).
    function pendingFor(job, test) {
      const id = String(job ?? "");
      for (const [lid, e] of lines) {
        if (e.job !== id || restOf(e) <= 0) continue;
        if (!test || test(lid)) return true;
      }
      return false;
    }

    return {
      feed,
      shownFor,
      // Which job a paced line belongs to. A paint must resolve a line's rows through the consoles of THIS job:
      // line ids are the server's sequence, not a page-wide key (a card adopted from another process can carry the
      // same numbers), and a document-wide lookup by lid is how one agent's tick wrote into another agent's console.
      jobFor: (lid) => lines.get(lid)?.job ?? null,
      pendingFor,
      tick,
      flush,
      flushJob,
      releaseAll,
      setRate,
      rate: () => rate,
      pending: pendingAny,
      pendingWords: () => {
        let n = 0;
        for (const e of lines.values()) n += restOf(e);
        return n;
      },
      forget: (lid) => lines.delete(lid),
      size: () => lines.size,
    };
  }

  /**
   * The line gate: whole lines waiting to join a console, released one at a time.
   *
   * An item is a `jobline` frame — `{ id, line }` — so the gate can recognise a growth frame for a line it is
   * already holding and update that copy instead of letting the paragraph jump the queue.
   *
   * @param opts.rate     lines per second (0 = off; push() returns false and the caller draws at once)
   * @param opts.release  called with a frame that may be drawn now
   */
  function createLineGate(opts = {}) {
    const { now, schedule, cancel } = defaults(opts);
    const release = opts.release || (() => {});
    let rate = clampLines(opts.rate ?? 0);
    let queue = [];
    let timer = null;
    let last = 0;
    let budget = 0;

    const tickMs = () => Math.max(MIN_TICK_MS, Math.min(250, Math.round(1000 / Math.max(0.25, rate))));
    function arm() {
      if (timer != null || !rate || !queue.length) return;
      last = now();
      timer = schedule(run, tickMs());
    }
    function disarm() {
      if (timer == null) return;
      cancel(timer);
      timer = null;
    }
    function run() {
      timer = null;
      const t = now();
      budget += (rate * Math.max(0, t - last)) / 1000;
      last = t;
      let n = Math.floor(budget);
      if (n > 0) {
        budget -= n;
        while (n > 0 && queue.length) {
          n--;
          release(queue.shift());
        }
      }
      arm();
    }

    const sameLine = (evt, line) => String(evt.line?.lid ?? "") === String(line.lid ?? "");

    return {
      /** Hold this frame, or return false when it must be drawn at once. */
      push(evt) {
        const line = evt.line || {};
        if (!rate) return false;
        if (line.lid != null) {
          const held = queue.find((q) => q.id === evt.id && sameLine(q, line));
          if (held) {
            held.line = line;
            if (evt.live) held.live = evt.live;
            return true;
          }
        }
        // An already-drawn line growing is not a new line: it must not wait behind the burst.
        if (line.mode === "set") return false;
        queue.push(evt);
        // A flood is not allowed to become a stall: the oldest line goes out immediately.
        if (queue.length > MAX_QUEUE) release(queue.shift());
        arm();
        return true;
      },
      /** Draw everything waiting (for one job when `job` is given) and forget it. */
      drain(job) {
        if (!queue.length) return 0;
        let n = 0;
        if (!job) {
          n = queue.length;
          const all = queue;
          queue = [];
          disarm();
          budget = 0;
          for (const evt of all) release(evt);
          return n;
        }
        const keep = [];
        const go = [];
        for (const evt of queue) (evt.id === job ? go : keep).push(evt);
        queue = keep;
        budget = 0;
        for (const evt of go) release(evt);
        n = go.length;
        if (!queue.length) disarm();
        return n;
      },
      setRate(v) {
        rate = clampLines(v);
        if (!rate) {
          this.drain();
          disarm();
        } else {
          disarm();
          arm();
        }
        return rate;
      },
      rate: () => rate,
      queued: () => queue.length,
      /** Frames waiting for this job, oldest first (read-only: the plans of a live console). */
      held: (job) => queue.filter((q) => !job || q.id === job),
    };
  }

  /**
   * The reasoning hold: whole frames that must wait for a thought to be finished before they join a console.
   *
   * A frame is held when `wants(evt)` says it belongs behind the reasoning AND `busy(job, head)` says that reasoning
   * is not finished. From then on EVERY later frame of that job queues behind it — a console is a transcript, so a
   * line may not overtake the one in front of it — except the growth of a line that is already drawn (`mode: "set"`),
   * which is not a new line. The queue leaves together, in order, the first time `busy` is false (checked on the
   * hold's own clock), or when `drain` is called, or when it has waited `maxWaitMs`.
   *
   * @param opts.wants    (evt) => whether this frame starts a hold when the job is busy
   * @param opts.busy     (job, head) => whether the reasoning in front of `head` is still being read or written
   * @param opts.start    (job, evt) => called once per frame that could start a hold, BEFORE `busy` is asked, so the
   *                      caller can begin the work `busy` then reports (a fresh read of the store)
   * @param opts.release  called with each frame that may be drawn now
   * @param opts.maxWaitMs  a hold's ceiling (default MAX_HOLD_MS)
   */
  function createReasoningHold(opts = {}) {
    const { now, schedule, cancel } = defaults(opts);
    const release = opts.release || (() => {});
    const wants = opts.wants || (() => false);
    const busy = opts.busy || (() => false);
    const start = opts.start || (() => {});
    const maxWait = Number.isFinite(opts.maxWaitMs) ? Math.max(0, opts.maxWaitMs) : MAX_HOLD_MS;
    const queues = new Map(); // job -> { frames, since }
    let timer = null;

    const arm = () => {
      if (timer != null || !queues.size) return;
      timer = schedule(sweep, MIN_TICK_MS);
    };
    const disarm = () => {
      if (timer == null) return;
      cancel(timer);
      timer = null;
    };
    function sweep() {
      timer = null;
      const t = now();
      for (const [job, q] of [...queues]) {
        if (t - q.since < maxWait && busy(job, q.frames[0])) continue;
        // Out of the map first: a frame released into a console may cause another push for this job.
        queues.delete(job);
        for (const evt of q.frames) release(evt);
      }
      arm();
    }

    const sameLine = (evt, line) => line.lid != null && String(evt.line?.lid ?? "") === String(line.lid);

    return {
      /** Hold this frame, or return false when it may be drawn at once. */
      push(evt) {
        const job = String(evt?.id ?? "");
        const line = evt?.line || {};
        const q = queues.get(job);
        if (q) {
          const held = q.frames.find((f) => sameLine(f, line));
          if (held) {
            held.line = line;
            if (evt.live) held.live = evt.live;
            return true;
          }
          // An already-drawn line growing is not a new line: it must not wait behind the hold.
          if (line.mode === "set") return false;
          q.frames.push(evt);
          if (q.frames.length > MAX_QUEUE) release(q.frames.shift());
          return true;
        }
        if (line.mode === "set" || !wants(evt)) return false;
        start(job, evt);
        if (!busy(job, evt)) return false;
        queues.set(job, { frames: [evt], since: now() });
        arm();
        return true;
      },
      /** Let everything waiting go, in order (for one job when `job` is given). Returns how many frames left. */
      drain(job) {
        let n = 0;
        for (const [id, q] of [...queues]) {
          if (job != null && id !== String(job)) continue;
          queues.delete(id);
          for (const evt of q.frames) release(evt);
          n += q.frames.length;
        }
        if (!queues.size) disarm();
        return n;
      },
      queued: (job) => {
        let n = 0;
        for (const [id, q] of queues) if (job == null || id === String(job)) n += q.frames.length;
        return n;
      },
      /** Frames waiting for this job, oldest first (read-only). */
      held: (job) => (queues.get(String(job ?? ""))?.frames || []).slice(),
      isHolding: (job) => queues.has(String(job ?? "")),
    };
  }

  root.wtType = { DEFAULT_WORDS, MAX_WORDS, MAX_LINES, MAX_HOLD_MS, MIN_TICK_MS, wordsIn, advance, createPacer, createLineGate, createReasoningHold, clampWords, clampLines, isPacedTool };
})(globalThis);
