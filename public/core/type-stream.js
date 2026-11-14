// core/type-stream.js - how fast a run's output reaches the reader's eyes.
//
// A turn's prose reaches the browser as coalesced frames (lib/jobs.js TEXT_FLUSH_MS, 120 ms) and a fast model
// fills each one with several words, so the console line jumps a phrase at a time. Tool results and reasoning
// blocks arrive as whole lines instead. Both are honest - they are what the wire sent - but neither reads like an
// agent writing, and the reader asked to watch it flow. The result of a skill is the one tool result that gets the
// same treatment as the prose and the reasoning: it is the longest thing a console is handed at once.
//
// Three mechanisms, and only ONE of them owns the order and the clock:
//
//   * the DRAWN STREAM (createDrawStream) is the one queue every revealed segment joins, whatever road it arrived
//     by: a paragraph of the agent's own words, a reasoning block (a streamed reasoning.delta or a store read), a
//     tool line, or one line of a skill's result (isPacedTool below). Each segment carries a sequence number and
//     the server stamp of the thing it draws; the queue's order is (stamp, sequence), one budget releases `rate`
//     words per second across all of them, and `shown` (the characters emitted for a segment) only ever grows. A
//     rebuild asks the stream, never the DOM, so a repaint draws exactly what had been emitted and nothing is
//     revealed twice. Rate 0 keeps nothing: every frame is drawn whole, exactly as before this existed.
//   * the GATE holds WHOLE LINES that have just joined a console and releases them one at a time. That is the
//     line-by-line setting: a burst of tool lines and results walks in instead of landing in one paint. It decides
//     ADMISSION only - how many new lines may join at once - and never how fast words appear, which is the
//     stream's one clock. A growth frame for a line the gate is still holding updates the held copy instead of
//     jumping the queue, and a held line is not in the console's record yet, so a repaint mid-burst shows the
//     transcript as far as it has got, which is the truth.
//
//   * the REASONING HOLD keeps a tool's lines out of the console until the reasoning in front of them has finished
//     being written. The stream types a thought at the reader's words-a-second, and a tool call (and its output)
//     that follows it is whole lines on the wire: left alone it lands while the thought above it is still being
//     typed, and the reader watches the answer arrive before the question. The hold queues those frames, in order,
//     behind the thought and lets them go the moment the stream has nothing left to say for it. It knows nothing
//     about the page: the caller says which frames wait (`wants`), what they wait for (`busy`) and what to do when
//     a hold begins (`start` - the page uses it to read the store again, because a reply's reasoning lands there a
//     moment after the tool call it made is already on the wire).
//
// All three are flushed by the caller when the turn settles, so nothing is ever left sitting in a buffer: the clock
// here outlives the wire, not the run.
//
// This is a classic script in the page and a plain module to node (it publishes itself on globalThis), so
// test/type-stream.test.js and test/console-ordered-stream.test.js drive the ONE implementation the page runs, with
// its clock and timer injected.
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
  // No hold outlasts this. A hold ends because the thought has been written, which the stream always gets to; this is
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

  // WHICH TOOL RESULTS ARE WRITTEN, NOT DROPPED IN. Prose and reasoning type out through the stream; so does the
  // result of a SKILL. It is the biggest block of text a run hands a console in one go — a SKILL.md is the card's
  // whole 40-line, 400-character head arriving in a single paint — and it is the one result a reader watches arrive,
  // so the lines of skill_view / skills_list / skill_manage are fed to the stream as they join the console and type
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
   * The DRAWN STREAM: one ordered queue, one clock, one writer contract for everything a console reveals.
   *
   * WHY THIS REPLACES THE PACER. The pacer held one clock per console line. Three segments fed at once each got the
   * reader's whole words-a-second, so the rate was multiplied by however many were live, and because every segment
   * released words on its own budget a later line could finish before an earlier one: the reader watched a
   * transcript assemble out of order. The three kinds of text a console draws also arrived by three different
   * roads - reasoning.delta for the thoughts (a cumulative preview), `text`/`set` frames for the answer (blocks
   * grown in place), and whole `tool`/`tool-out` records - sharing neither an order nor a clock, which is why each
   * of the last four fixes repaired one road and left the other two.
   *
   * A SEGMENT is the unit now. A paragraph, a thought, a tool line and each line of a skill's result all join ONE
   * queue as a segment carrying a sequence number and the server stamp (`at`) of the thing it draws. `seq` is
   * assigned here, on arrival; the queue's order is (at, seq). The server's stamp is the only clock all three kinds
   * share, and seq orders two segments written inside one millisecond. A segment keeps its place while its text
   * grows, so a paragraph the wire is still writing stays one entry in the order rather than a new one per frame.
   *
   * THE CLOCK IS ONE BUDGET. tick() adds `rate` words per second, once, and hands them to the earliest segment
   * that still has words to show. Only when that segment has caught up does the next one get a word, so the setting
   * means words per second across thinking, answer and tool output together, and nothing can overtake the thing in
   * front of it. A segment that has caught up with its text is skipped (the wire may still be writing it), and if
   * it grows again it is still the earliest pending segment, so its new words are released before the later ones.
   *
   * THE WRITER IS APPEND-ONLY. `shown` - the number of characters emitted for a segment - only ever grows and is
   * the only thing a paint or a rebuild asks for. It lives here, not in the DOM, so a board poll, a rail resize or
   * a focus-mode toggle redraws exactly what had been emitted and typing carries on from that character; nothing
   * is revealed twice. The one exception is a frame that REWRITES a line (a trim, a replayed snapshot): that is a
   * replacement, not a retype - the segment jumps to its new text and the row is drawn again whole.
   *
   * This is a classic script in the page and a plain module to node, so the ONE implementation the page runs is
   * what test/type-stream.test.js and test/console-ordered-stream.test.js drive, with the clock injected.
   */
  function createDrawStream(opts = {}) {
    const { now, schedule, cancel } = defaults(opts);
    const onPaint = opts.onPaint || (() => {});
    let rate = clampWords(opts.rate ?? DEFAULT_WORDS);
    const segs = new Map(); // key -> { key, job, kind, at, seq, text, shown, rewrites }
    let queue = []; // the same segments, ordered by (at, seq)
    const lastAt = new Map(); // job -> the newest stamp seen, for a segment that carries none
    let timer = null;
    let last = 0;
    let words = 0; // the stream's one word budget
    let seqNo = 0;
    const stats = { enqueued: 0, emitted: 0, rewrites: 0, replaced: 0, late: 0, ticks: 0, paints: 0, capped: 0 };

    const restOf = (s) => wordsIn(s.text, s.shown);
    // How far behind the wire the QUEUE may be, in words. Paced reveal is for prose arriving at readable speed; a
    // burst - ten whole lines of a paragraph each, a result's whole head, one frame carrying a document - is one
    // queue, and every line in it can be under any per-line cap while the reader waits seconds for the console to
    // finish typing something that ended long ago. 1.5 s of the reader's own clock is the most the pacer may still
    // owe; past it everything pending is drawn at once and the clock restarts empty. (A paced TOOL RESULT is the one
    // kind that is *meant* to be typed out - paceResultLine, six rows of a skill's answer - and six short rows are
    // well under this, so the feature survives; forty rows were never handed to the pacer in the first place.)
    const queueCap = () => Math.max(60, Math.ceil(rate * 1.5));
    // The debt is what the CONSOLE owes, and only the part of it that can be drawn without jumping the queue. A
    // console line is a row the wire has already handed over in full, so a reveal longer than a second and a half is
    // the page catching up, not the model writing. A reasoning block is fed the same way but is watched differently:
    // its newest block is written from its first word (docs/reports/console-streaming-lag-2026-11-14.html cause 7,
    // and think-toggle-no-replay's rule that the press does not re-type history). So the walk stops at the first live
    // segment with no `cap` - drawing past it would put a later row on screen before the head, which is the ordering
    // defect console-ordered-stream exists to pin. Completed segments are behind the head and never in the way.
    const capRun = () => {
      // Characters, not words: restOf() counts spaces in a scan of the text, and running that for the whole queue on
      // every tick (25 a second) is itself a cost the report would charge to this page. A character count is a
      // subtraction per segment; CAP_CHARS is only the threshold's own unit, so an average word is close enough.
      let n = 0;
      for (const s of queue) {
        if (s.shown >= s.text.length) continue;
        if (!s.cap) break;
        n += s.text.length - s.shown;
      }
      return n;
    };
    // One reader-facing word is ~6 characters of console text; the cap is a feel, not a contract, so the threshold is
    // converted once instead of counting words on every tick.
    const CAP_CHARS = 6;
    const pendingAny = () => {
      for (const s of queue) if (s.shown < s.text.length) return true;
      return false;
    };
    const tickMs = () => Math.max(MIN_TICK_MS, Math.min(250, Math.round(1000 / Math.max(0.5, rate))));

    function arm() {
      if (timer != null || !rate || !pendingAny()) return;
      // Nothing banks while the clock is stopped: the seconds since the last tick are not words anybody is owed.
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
      tick(now());
      arm();
    }

    // Where a segment sits: the server stamp first, the arrival sequence second. A segment with no stamp of its own
    // (history written before lines were stamped) takes the newest stamp its job has, so it stays where it arrived.
    function atOf(job, at) {
      const id = String(job ?? "");
      const n = Number(at);
      if (Number.isFinite(n) && n > 0) {
        lastAt.set(id, n);
        return n;
      }
      return lastAt.get(id) ?? 0;
    }

    // Insert by (at, seq). A frame can reach this late with an EARLIER stamp than something already on screen (the
    // store hands a reply's reasoning over after the tool call it made is already on the wire, see
    // appendJobLine's `think` branch). It takes its ordered place; `late` counts the cases where text was already
    // emitted for a segment that now stands after it, which is the only situation the order cannot undo.
    function place(s) {
      let i = queue.length;
      for (let k = 0; k < queue.length; k++) {
        const q = queue[k];
        if (q.at > s.at || (q.at === s.at && q.seq > s.seq)) {
          i = k;
          break;
        }
      }
      if (i < queue.length) {
        for (let k = i; k < queue.length; k++) {
          if (queue[k].shown > 0) {
            stats.late += 1;
            break;
          }
        }
      }
      queue.splice(i, 0, s);
    }

    // The earliest segment with words left to show. Everything in front of it has caught up with the text it has,
    // which is exactly "the reader has seen everything that comes before this".
    function headPending() {
      for (const s of queue) if (s.shown < s.text.length) return s;
      return null;
    }

    /**
     * The wire says this segment now reads `text`. Returns the prefix to draw right now.
     *
     * Cumulative growth extends the segment in place and keeps its position; anything else (a frame that rewrites
     * the line, a replacement after a trim) snaps to the new text, because typing out a line that has been
     * rewritten is a promise about the past that nobody made.
     */
    function feed(key, job, text, opts = {}) {
      const k = String(key);
      const full = String(text ?? "");
      const kind = opts.kind ?? "";
      const at = opts.at;
      if (!rate) {
        forget(k);
        return full;
      }
      let s = segs.get(k);
      if (!s) {
        if (segs.size >= MAX_ENTRIES) forgetOldest();
        s = {
          key: k,
          job: String(job ?? ""),
          kind: String(kind ?? ""),
          at: atOf(job, at),
          seq: ++seqNo,
          text: "",
          shown: 0,
          rewrites: 0,
          // Console lines are capped, reasoning blocks are not - see backlog().
          cap: opts.cap === true,
        };
        segs.set(k, s);
        place(s);
        stats.enqueued += 1;
      } else {
        if (job != null) s.job = String(job);
        if (kind != null) s.kind = String(kind);
        if (opts.cap === true) s.cap = true;
      }
      if (full === s.text) return s.text.slice(0, s.shown);
      if (!full.startsWith(s.text)) {
        // A rewrite. Draw the new line whole from here on; what was emitted before is not typed again.
        stats.replaced += s.shown;
        stats.rewrites += 1;
        s.text = full;
        s.shown = full.length;
        return full;
      }
      s.text = full;
      arm();
      return s.text.slice(0, s.shown);
    }

    /**
     * What may be drawn for this segment now, or null when it is not being paced (draw the record whole).
     *
     * `text` is the segment as the RECORD holds it - the caller's own row, not the stream's memory. Given it, the
     * stream only answers while it can honestly claim a prefix of that line: a line the record has moved past (the
     * reader was away, so no frame was ever fed here) or rewritten (a trim moved it) is not being typed any more,
     * and the entry is dropped so the record draws whole from then on. Without it the entry answers for itself,
     * which is what a caller with no record in hand wants (a reasoning row holds its words elsewhere).
     */
    function shownFor(key, text) {
      const s = segs.get(String(key));
      if (!s) return null;
      if (text == null) return s.text.slice(0, s.shown);
      const full = String(text);
      if (full === s.text) return s.text.slice(0, s.shown);
      if (restOf(s) === 0 || !full.startsWith(s.text)) {
        forget(s.key);
        return null;
      }
      return s.text.slice(0, s.shown);
    }

    /**
     * Everything emitted for this segment so far, and nothing the clock has not reached. This is what a REBUILD
     * draws: it is the stream's own high-water mark, so a repaint cannot be behind what the reader has already
     * seen and a repaint cannot be ahead of the clock either.
     */
    function emitted(key) {
      const s = segs.get(String(key));
      return s ? s.text.slice(0, s.shown) : "";
    }

    /** Release the next words that are due. Returns whether anything is still waiting. */
    function tick(when) {
      const t = Number.isFinite(when) ? when : now();
      const dt = Math.max(0, t - last);
      last = t;
      stats.ticks += 1;
      if (!rate) return false;
      // The queue is a burst this clock cannot read: draw what it owes NOW, in one paint, and start the clock empty.
      // (See queueCap: the wire stopped, and a reveal that takes longer than a second and a half is the page catching
      // up, not the model writing.)
      if (capRun() > queueCap() * CAP_CHARS) {
        const painted = [];
        for (const s of queue) {
          if (s.shown >= s.text.length) continue;
          // The head's own typewriter, or any reasoning block, is where the queue stops being dumpable.
          if (!s.cap) break;
          stats.emitted += s.text.length - s.shown;
          s.shown = s.text.length;
          painted.push(s.key);
        }
        stats.capped += 1;
        words = 0;
        if (painted.length) {
          stats.paints += 1;
          onPaint(painted);
        }
        return false;
      }
      words += (rate * dt) / 1000;
      const painted = [];
      // One budget, spent in transcript order: the earliest segment with words left takes them, and the next one
      // only gets what is left over once it has caught up.
      for (;;) {
        const s = headPending();
        if (!s) break;
        const n = Math.min(Math.floor(words), restOf(s));
        if (n <= 0) break;
        words -= n;
        const end = advance(s.text, s.shown, n);
        if (end > s.shown) {
          stats.emitted += end - s.shown;
          s.shown = end;
          painted.push(s.key);
        }
        if (words < 1) break;
      }
      if (painted.length) {
        stats.paints += 1;
        onPaint(painted);
      }
      return pendingAny();
    }

    /** Show everything this segment has right now (the turn settled, or the reader asked for it). */
    function flush(key) {
      const s = segs.get(String(key));
      if (!s) return null;
      stats.emitted += s.text.length - s.shown;
      s.shown = s.text.length;
      disarm();
      arm();
      return s.text;
    }

    function flushJob(job) {
      const id = String(job ?? "");
      const out = [];
      for (const s of queue) {
        if (s.job !== id) continue;
        // Every segment of a settled turn goes back to the console, not only the ones with words still queued: the
        // wire can stop a frame short of the record, and a line the stream thinks it finished is exactly the one a
        // settle was leaving drawn at its own top. The console repaints each against its record (see paintTypedLines).
        stats.emitted += s.text.length - s.shown;
        s.shown = s.text.length;
        out.push(s.key);
      }
      // Another card may still be typing: the clock keeps running for it.
      disarm();
      arm();
      if (out.length) {
        stats.paints += 1;
        onPaint(out);
      }
      return out;
    }

    function releaseAll() {
      const out = [];
      for (const s of queue) {
        if (s.shown >= s.text.length) continue;
        stats.emitted += s.text.length - s.shown;
        s.shown = s.text.length;
        out.push(s.key);
      }
      disarm();
      if (out.length) {
        stats.paints += 1;
        onPaint(out);
      }
      return out;
    }

    function setRate(v) {
      const next = clampWords(v);
      const was = rate;
      rate = next;
      if (!next) {
        releaseAll();
        segs.clear();
        queue = [];
        disarm();
      } else if (next !== was) {
        disarm();
        arm();
      }
      return rate;
    }

    function forget(key) {
      const k = String(key);
      if (!segs.delete(k)) return false;
      queue = queue.filter((s) => s.key !== k);
      return true;
    }

    // The oldest segment that has nothing left to show; a segment still being written is kept.
    function forgetOldest() {
      for (const s of queue) {
        if (restOf(s) > 0) continue;
        return forget(s.key);
      }
      return forget(queue[0]?.key);
    }

    // Is any segment of this job still being written? `test(key)` narrows it to the segments the asker cares about
    // (the reasoning hold asks about thoughts only, and only the ones that belong in front of the call it is holding).
    function pendingFor(job, test) {
      const id = String(job ?? "");
      for (const s of queue) {
        if (s.job !== id || s.shown >= s.text.length) continue;
        if (!test || test(s.key)) return true;
      }
      return false;
    }

    return {
      feed,
      shownFor,
      emitted,
      // Which job a segment belongs to. A paint must resolve a segment's rows through the consoles of THIS job:
      // keys are the server's sequence, not a page-wide key (a card adopted from another process can carry the same
      // numbers), and a document-wide lookup by key is how one agent's tick wrote into another agent's console.
      jobFor: (key) => segs.get(String(key))?.job ?? null,
      kindFor: (key) => segs.get(String(key))?.kind ?? null,
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
        for (const s of queue) n += restOf(s);
        return n;
      },
      forget,
      size: () => segs.size,
      // The queue's order, oldest first: the order the reader must see the segments start in.
      order: () => queue.map((s) => s.key),
      seqOf: (key) => segs.get(String(key))?.seq ?? null,
      atOf: (key) => segs.get(String(key))?.at ?? null,
      stats: () => ({ ...stats }),
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

  root.wtType = { DEFAULT_WORDS, MAX_WORDS, MAX_LINES, MAX_HOLD_MS, MIN_TICK_MS, wordsIn, advance, createDrawStream, createLineGate, createReasoningHold, clampWords, clampLines, isPacedTool };
})(globalThis);
