// core/stream-merge.js — the order of ONE stream: what the agent thought, said, called and got back, as a single
// transcript.
//
// A card keeps those in separate places. The console holds the agent's words and its tool calls (lines the panel
// stamped the moment they arrived); the reasoning is not on the stream at all — the panel reads it back out of the
// session store as blocks, each stamped with the moment its assistant message was written. A card in the single-stream
// mode (the 🌊 beside the 🧠) draws all of it in one flow, so somebody has to say where each reasoning block sits among
// the lines. That decision is this file, and it is pure so test/single-stream.test.js can drive it without a browser.
//
// WHERE A BLOCK GOES
//
// The store stamps an assistant message when the model's reply is complete, a few tens of milliseconds BEFORE the
// panel stamps the tool call that reply made (measured on this box: 10–110 ms, never the other way round). But the
// words the same reply streamed — "I'll read the file first" — were stamped while it was being written, i.e. BEFORE
// the message's own stamp. Sorting by time alone therefore puts the reasoning after the sentence it came first
// for. The turn's own rhythm says it better: reasoning, then words, then calls, then their results, then the next
// reasoning. So a block goes immediately after the last tool result stamped before it, and before the first line of
// words or the first tool call that follows that result — the lines its own reply produced.
//
// Two things keep that honest when the lines do not cooperate: a reply that produced no line at all (the first
// line after the previous result is minutes later) is placed by its time instead, and a block older than the window
// of lines the card kept is dropped rather than piled up above the first line it has nothing to do with.
//
// This is a classic script in the page and a plain module to node (it exports nothing and publishes itself on
// globalThis), so the test imports the one implementation the page runs rather than a copy of it.
(function (root) {
  "use strict";

  // The first line of the same reply is the tool call; a reply that produced no call and no words leaves the next
  // content line to some LATER reply. Past this distance from the block's own stamp that is what has happened.
  const SLACK_MS = 30_000;

  // The gateway's `reasoning.available` event draws one dim line in the console — the first 240 characters of a
  // block (`🧠 reasoning · …`). When the card shows the whole block, that line is the same thing said twice.
  const PREVIEW_RE = /^🧠 reasoning · /;
  const isPreview = (line) => Boolean(line) && line.kind === "dim" && PREVIEW_RE.test(String(line.text || ""));

  // A line's moment, carried forward over a line that has none (history written before lines were stamped): its
  // neighbour is the best evidence of when it happened, and 0 means nothing is known yet.
  function stamps(lines) {
    const out = new Array(lines.length);
    let last = 0;
    for (let i = 0; i < lines.length; i++) {
      const at = Number(lines[i] && lines[i].at);
      if (Number.isFinite(at) && at > 0) last = at;
      out[i] = last;
    }
    return out;
  }

  /**
   * Interleave a turn's reasoning blocks with its console lines.
   * @param lines  the console lines the card draws, oldest first (bookkeeping already removed)
   * @param blocks the reasoning blocks read from the store: [{ at (epoch ms), text }]
   * @param opts.windowFull   the card kept only the newest lines of the turn, so a block older than the first one is
   *                          not part of what is on screen
   * @param opts.hidePreviews drop the console's own one-line preview of a block (the block carries the whole of it)
   * @returns the lines in draw order, with each block as { kind: "think", text, at, lid }
   */
  function merge(lines, blocks, opts = {}) {
    const src = (Array.isArray(lines) ? lines : []).filter((l) => l && !(opts.hidePreviews && isPreview(l)));
    const list = (Array.isArray(blocks) ? blocks : [])
      .map((b) => ({ at: Number(b && b.at) || 0, text: String((b && b.text) || "") }))
      .filter((b) => b.text.trim())
      .sort((a, b) => a.at - b.at);
    if (!list.length) return src;
    const at = stamps(src);
    const first = at.length ? at[0] : 0;
    const slots = new Map(); // index in src -> the blocks that go in front of it
    for (const b of list) {
      const T = b.at;
      if (opts.windowFull && first && T && T < first - SLACK_MS) continue;
      // After the last result that was already back when this reply was written.
      let p = 0;
      for (let i = 0; i < src.length; i++) if (T && src[i].kind === "tool-out" && at[i] < T) p = i + 1;
      // …and in front of the first words or call that came after it.
      let q = -1;
      for (let i = p; i < src.length; i++) {
        if (src[i].kind === "text" || src[i].kind === "tool") {
          q = i;
          break;
        }
      }
      let idx;
      if (q >= 0 && (!T || at[q] <= T + SLACK_MS)) idx = q;
      else {
        idx = src.length;
        for (let i = p; i < src.length; i++) {
          if (T && at[i] > T) {
            idx = i;
            break;
          }
        }
      }
      const slot = slots.get(idx) || [];
      slot.push(b);
      slots.set(idx, slot);
    }
    const out = [];
    for (let i = 0; i <= src.length; i++) {
      for (const b of slots.get(i) || []) out.push({ kind: "think", text: b.text, at: b.at, lid: `think:${b.at}` });
      if (i < src.length) out.push(src[i]);
    }
    return out;
  }

  /**
   * Cut a stream into what is drawn as one piece each: a line, or a UNIT of tool lines.
   * A unit is a call (or a parallel batch of calls) and the results that came back for it. The next call that follows
   * a result starts a new unit, so a card that runs a hundred tools in a row is a hundred small pieces and a new line
   * only ever redraws the piece it belongs to — never the whole run, which is what a reader's selection would not
   * survive.
   * @returns [{ line } | { unit: true, lines: [...] }]
   */
  function segments(items) {
    const out = [];
    let run = null;
    let seenResult = false;
    for (const l of Array.isArray(items) ? items : []) {
      const call = l.kind === "tool";
      const result = l.kind === "tool-out";
      if (!call && !result) {
        run = null;
        out.push({ line: l });
        continue;
      }
      if (!run || (call && seenResult)) {
        run = { unit: true, lines: [] };
        seenResult = false;
        out.push(run);
      }
      run.lines.push(l);
      if (result) seenResult = true;
    }
    return out;
  }

  // Has this unit's call been answered? The one question a live append asks to decide between growing the last unit
  // and starting the next.
  function unitHasResult(lines) {
    return (Array.isArray(lines) ? lines : []).some((l) => l && l.kind === "tool-out");
  }

  root.wtStream = { SLACK_MS, isPreview, merge, segments, unitHasResult };
})(globalThis);
