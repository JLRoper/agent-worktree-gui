// Where a reasoning block sits among a turn's console lines, and how a stream is cut into pieces.
//
// public/core/stream-merge.js is a classic script in the page and a plain module to node (it publishes itself on
// globalThis), so this imports the ONE implementation the single-stream card runs rather than a copy of it.
//
// The stamps below are not invented shapes: they are the ones measured on this box from a live turn's
// logs/jobs.json lines against the same session's rows in state.db (an assistant message is written 10-110 ms before
// the tool call it made is stamped; its words were stamped before the message was written; a tool result's line and
// its store row land within a few milliseconds of each other).
import assert from "node:assert/strict";
import test from "node:test";

await import("../public/core/stream-merge.js");
const { merge, segments, pieces, isPreview, unitHasResult, joinsTail, SLACK_MS } = globalThis.wtStream;

const T0 = 1_790_000_000_000; // an arbitrary epoch, so every stamp below reads as seconds into the turn
const at = (s) => T0 + Math.round(s * 1000);
const line = (kind, text, s, extra = {}) => ({ kind, text, at: s == null ? undefined : at(s), ...extra });
const block = (s, text) => ({ at: at(s), text });
const shape = (items) => items.map((l) => (l.kind === "think" ? `think:${l.text}` : `${l.kind}:${l.text}`));

test("reasoning goes in front of the tool call it led to", () => {
  const lines = [
    line("tool", "💻 terminal · grep -n emoji", 0.11),
    line("tool-out", "  ↳ terminal", 0.97),
    line("tool", "💻 terminal · grep -n purple", 5.19),
    line("tool-out", "  ↳ terminal", 6.13),
  ];
  // The two assistant messages, as the store stamped them: 110 ms and 20 ms before their calls.
  const out = merge(lines, [block(0.0, "first thought"), block(5.17, "second thought")]);
  assert.deepEqual(shape(out), [
    "think:first thought",
    "tool:💻 terminal · grep -n emoji",
    "tool-out:  ↳ terminal",
    "think:second thought",
    "tool:💻 terminal · grep -n purple",
    "tool-out:  ↳ terminal",
  ]);
});

test("reasoning goes in front of the words its own reply streamed, not after them", () => {
  // The model wrote "I'll read the file" WHILE replying, so those lines are stamped before the message's own stamp
  // (7.9 s); sorted by time alone the block would land after the sentence it came first for.
  const lines = [
    line("tool", "📖 read_file · a.js", 1.0),
    line("tool-out", "  ↳ read_file", 2.0),
    line("text", "I'll read the other file", 6.0, { lid: "l1" }),
    line("text", "and then patch it", 7.0, { lid: "l2" }),
    line("tool", "📖 read_file · b.js", 7.95),
    line("tool-out", "  ↳ read_file", 8.5),
  ];
  const out = merge(lines, [block(7.9, "which file next")]);
  assert.deepEqual(shape(out), [
    "tool:📖 read_file · a.js",
    "tool-out:  ↳ read_file",
    "think:which file next",
    "text:I'll read the other file",
    "text:and then patch it",
    "tool:📖 read_file · b.js",
    "tool-out:  ↳ read_file",
  ]);
});

test("the first reply of a turn lands after the panel's own notes and before its first call", () => {
  const lines = [
    line("dim", "cut from main @ c0b46d22", 90),
    line("dim", "⇢ assistant context attached", 91),
    line("raw", "worktree created: C:/x", 92),
    line("tool", "📖 read_file · a.js", 108.05),
  ];
  const out = merge(lines, [block(108.0, "plan")]);
  assert.deepEqual(shape(out), [
    "dim:cut from main @ c0b46d22",
    "dim:⇢ assistant context attached",
    "raw:worktree created: C:/x",
    "think:plan",
    "tool:📖 read_file · a.js",
  ]);
});

test("a steer the panel noted between a result and the next reply stays above that reply's reasoning", () => {
  const lines = [
    line("tool", "📖 read_file · a.js", 1),
    line("tool-out", "  ↳ read_file", 2),
    line("dim", "⇢ steer sent: do the other thing", 252.58),
    line("raw", "⇢ steer delivered to the live turn", 252.58),
    line("tool", "📖 read_file · b.js", 263.24),
  ];
  const out = merge(lines, [block(263.23, "read the steer")]);
  assert.deepEqual(shape(out).slice(2), [
    "dim:⇢ steer sent: do the other thing",
    "raw:⇢ steer delivered to the live turn",
    "think:read the steer",
    "tool:📖 read_file · b.js",
  ]);
});

test("a reply that produced no line is placed by its time, not in front of a much later reply", () => {
  const lines = [
    line("tool", "📖 read_file · a.js", 1),
    line("tool-out", "  ↳ read_file", 2),
    // a reply at 10 s wrote nothing the card kept; the next content line is a different reply a long time later
    line("dim", "⇢ a note at 20 s", 20),
    line("tool", "📖 read_file · b.js", 10 + (SLACK_MS + 5000) / 1000),
  ];
  const out = merge(lines, [block(10, "a reply that wrote nothing")]);
  assert.deepEqual(shape(out), [
    "tool:📖 read_file · a.js",
    "tool-out:  ↳ read_file",
    "think:a reply that wrote nothing",
    "dim:⇢ a note at 20 s",
    `tool:📖 read_file · b.js`,
  ]);
});

test("a block with nothing after it joins the end; one stamped after the last line does too", () => {
  const lines = [line("tool", "📖 read_file · a.js", 1), line("tool-out", "  ↳ read_file", 2)];
  assert.deepEqual(shape(merge(lines, [block(3, "the next reply, not yet drawn")])).at(-1), "think:the next reply, not yet drawn");
});

test("a window that kept only the newest lines drops the blocks that came before it; a whole turn keeps them", () => {
  const lines = [line("tool", "📖 read_file · late.js", 500), line("tool-out", "  ↳ read_file", 501)];
  const old = block(10, "from the part of the turn the card no longer holds");
  assert.deepEqual(shape(merge(lines, [old], { windowFull: true })), shape(lines), "trimmed window: nothing piles up at the top");
  assert.equal(shape(merge(lines, [old], { windowFull: false }))[0], "think:from the part of the turn the card no longer holds");
});

test("every console line survives, in its own order, whatever is merged into it", () => {
  const lines = [
    line("text", "one", 1),
    line("tool", "💻 terminal · a", 2),
    line("tool-out", "  ↳ terminal", 3),
    line("tool-out", "output", 3),
    line("text", "two", 4),
  ];
  const blocks = [block(0.5, "a"), block(1.9, "b"), block(3.5, "c"), block(99, "d")];
  const out = merge(lines, blocks);
  assert.deepEqual(
    out.filter((l) => l.kind !== "think"),
    lines,
    "the lines are the same objects in the same order"
  );
  assert.equal(out.filter((l) => l.kind === "think").length, 4, "every block is drawn exactly once");
  assert.deepEqual(
    out.filter((l) => l.kind === "think").map((l) => l.text),
    ["a", "b", "c", "d"],
    "and the blocks keep their own order"
  );
});

test("a block is a line of its own with an identity the page can key on", () => {
  const [b] = merge([], [block(1.5, "thinking out loud")]);
  assert.deepEqual(b, { kind: "think", text: "thinking out loud", at: at(1.5), lid: `think:${at(1.5)}` });
});

test("lines with no stamp (history from before lines were stamped) still merge without throwing", () => {
  const lines = [line("text", "old", null), line("tool", "▸ read_file · a", null), line("tool-out", "  ↳ read_file", null)];
  const out = merge(lines, [block(5, "x")]);
  assert.equal(out.length, 4);
  assert.equal(out.filter((l) => l.kind === "think").length, 1);
});

test("empty and missing input is an empty stream, not an exception", () => {
  assert.deepEqual(merge(), []);
  assert.deepEqual(merge([], []), []);
  assert.deepEqual(merge(null, null), []);
  assert.deepEqual(merge([line("text", "a", 1)], [{ at: at(1), text: "   " }, null, {}]).map((l) => l.kind), ["text"], "a blank block is nothing");
});

test("the console's own reasoning preview is hidden only when the block carries the whole of it", () => {
  const preview = line("dim", "🧠 reasoning · the first 240 characters of a block…", 3);
  const note = line("dim", "⇢ steer sent: 🧠 reasoning · quoted by the reader", 4);
  const lines = [line("text", "hi", 1), preview, note];
  assert.equal(isPreview(preview), true);
  assert.equal(isPreview(note), false, "only a line that LEADS with it is the preview");
  assert.equal(isPreview(line("text", "🧠 reasoning · said by the agent", 1)), false, "and only the console's dim kind");
  assert.deepEqual(shape(merge(lines, [], { hidePreviews: true })), ["text:hi", "dim:⇢ steer sent: 🧠 reasoning · quoted by the reader"]);
  assert.deepEqual(shape(merge(lines, [], { hidePreviews: false })), shape(lines), "with reasoning off the preview is the only trace of it");
});

test("segments: a call and its result are one piece; the next call after a result starts the next piece", () => {
  const items = [
    line("tool", "💻 terminal · a", 1),
    line("tool-out", "  ↳ terminal", 2),
    line("tool-out", "out a", 2),
    line("tool", "📖 read_file · b", 3),
    line("tool-out", "  ↳ read_file", 4),
  ];
  const segs = segments(items);
  assert.equal(segs.length, 2);
  assert.deepEqual(segs.map((s) => s.lines.map((l) => l.text)), [
    ["💻 terminal · a", "  ↳ terminal", "out a"],
    ["📖 read_file · b", "  ↳ read_file"],
  ]);
});

test("segments: a parallel batch (calls first, results after) stays one piece", () => {
  const items = [
    line("tool", "📖 read_file · a", 1),
    line("tool", "📖 read_file · b", 1),
    line("tool-out", "  ↳ read_file", 2),
    line("tool-out", "  ↳ read_file", 2),
    line("tool", "📖 read_file · c", 3),
  ];
  const segs = segments(items);
  assert.deepEqual(segs.map((s) => s.lines.length), [4, 1]);
});

test("segments: prose and reasoning end a piece, and a result with no call still has a place", () => {
  const items = [
    line("tool-out", "  ↳ terminal", 1),
    line("tool", "💻 terminal · a", 2),
    { kind: "think", text: "hm", at: at(2.5), lid: "think:x" },
    line("tool", "💻 terminal · b", 3),
    line("text", "said", 4),
    line("tool-out", "  ↳ terminal", 5),
  ];
  const segs = segments(items);
  assert.deepEqual(
    segs.map((s) => (s.unit ? `unit:${s.lines.map((l) => l.kind).join("+")}` : `line:${s.line.kind}`)),
    // the lone result (its call was trimmed away) is a piece of its own: the call after it starts the next one
    ["unit:tool-out", "unit:tool", "line:think", "unit:tool", "line:text", "unit:tool-out"]
  );
});

test("segments: nothing in, nothing out; every line is in exactly one piece", () => {
  assert.deepEqual(segments(), []);
  assert.deepEqual(segments([]), []);
  const items = [line("text", "a", 1), line("tool", "t", 2), line("tool-out", "r", 3), line("tool", "t2", 4), line("dim", "d", 5)];
  const flat = segments(items).flatMap((s) => (s.unit ? s.lines : [s.line]));
  assert.deepEqual(flat, items);
});

// The blank line the reasoning block has always had, before every other piece of a stream: one answer, decided where
// the stream's order and its cuts are already decided, so the painter cannot disagree with itself about it.
test("pieces: every piece but the console's first is set apart from the piece above it", () => {
  const items = [
    line("text", "I'll read the file", 1),
    line("tool", "📖 read_file · a.js", 2),
    line("tool-out", "  ↳ read_file", 3),
    { kind: "think", text: "what it said back", at: 4, lid: "think:4" },
    line("tool", "💻 terminal · ls", 5),
    line("tool-out", "  ↳ terminal", 6),
    line("text", "done", 7),
  ];
  const out = pieces(items);
  assert.deepEqual(
    out.map((p) => (p.unit ? `unit:${p.lines.map((l) => l.kind).join("+")}` : `line:${p.line.kind}`)),
    ["line:text", "unit:tool+tool-out", "line:think", "unit:tool+tool-out", "line:text"],
    "the same cut segments() makes",
  );
  assert.deepEqual(out.map((p) => p.sep), [false, true, true, true, true], "nothing is set apart at the very top");
  assert.equal(out.filter((p) => p.unit).every((p) => p.sep), true, "and every group of tool output is");
  assert.deepEqual(pieces([]), [], "nothing in, nothing out");
});

test("pieces: a reasoning block is a piece like any other — it is not double-spaced", () => {
  // The reasoning row keeps the block's own class for its voice; the separation is the same `sep` a group gets, so
  // there is one gap and not a reasoning-specific one on top of it.
  const out = pieces([line("text", "said", 1), { kind: "think", text: "thought", at: 2, lid: "think:2" }]);
  assert.deepEqual(out.map((p) => [p.line.kind, p.sep]), [["text", false], ["think", true]]);
  assert.equal("sep" in out[0], true, "the first piece carries the answer too, rather than the painter assuming it");
});

test("unitHasResult answers the one question a live append asks", () => {
  assert.equal(unitHasResult([line("tool", "t", 1)]), false);
  assert.equal(unitHasResult([line("tool", "t", 1), line("tool-out", "r", 2)]), true);
  assert.equal(unitHasResult(), false);
});

// The live append asks before it draws. A call the poll would cut out of the burst on screen is one the reader sees
// leave one box and appear in the next, so `joinsTail` runs the transcript through the same `merge` + `segments` the
// repaint runs, and joins only when the cutter puts the call in the same unit as the burst's last line.
test("joinsTail: a call that follows a result opens the next burst", () => {
  const burst = [line("tool", "💻 terminal · date", 1), line("tool-out", "  ↳ terminal", 2)];
  const next = line("tool", "💻 terminal · ls", 3);
  assert.equal(joinsTail([...burst, next], next, [], burst), false);
});

test("joinsTail: a call the burst has not answered yet joins it", () => {
  const burst = [line("tool", "💻 terminal · sleep 5", 1)];
  const next = line("tool", "💻 terminal · date", 2);
  assert.equal(joinsTail([...burst, next], next, [], burst), true);
  // a result always joins the burst it answers, even one that already saw a result
  const answered = [...burst, line("tool-out", "x", 2)];
  const result = line("tool-out", "y", 3);
  assert.equal(joinsTail([...answered, result], result, [], answered), true);
});

test("joinsTail: a reasoning block that merge puts in front of the call ends the burst", () => {
  const answered = [line("tool", "💻 terminal · date", 1), line("tool-out", "  ↳ terminal", 2)];
  const next = line("tool", "💻 terminal · ls", 4);
  // the block belongs after that result and before the next call: the call is the head of a new burst
  assert.equal(joinsTail([...answered, next], next, [block(3, "I should list the folder")], answered), false);
  // a block from before the burst is placed above the burst entirely, so the call is still cut off from it by the
  // result above — the same answer, for a different reason
  assert.equal(joinsTail([...answered, next], next, [block(0.5, "earlier")], answered), false);
});

test("joinsTail: nothing on screen, or a burst read back without stamps — the append's old answer", () => {
  const next = line("tool", "t", 1);
  assert.equal(joinsTail([next], next, [], []), false);
  assert.equal(joinsTail([next], next, [], null), false);
  // a burst read back out of the DOM carries no identity to match on: fall back to \"does it already hold a result\"
  const domBurst = [{ kind: "tool", text: "💻" }, { kind: "tool-out", text: " ↳" }];
  assert.equal(joinsTail([...domBurst, next], next, [], domBurst), false);
  const domOpen = [{ kind: "tool", text: "💻" }];
  assert.equal(joinsTail([...domOpen, next], next, [], domOpen), true);
});

// The rule the append follows is the rule the renderer cuts by: whatever it decides, the poll must agree, or the row
// is drawn in one burst and moved to another on the next repaint.
test("joinsTail agrees with the grouping a repaint builds", () => {
  const cases = [
    [[line("tool", "a", 1)], line("tool", "b", 2), []],
    [[line("tool", "a", 1), line("tool-out", "ra", 2)], line("tool", "b", 3), []],
    [[line("tool", "a", 1), line("tool-out", "ra", 2)], line("tool", "b", 4), [block(3, "think")]],
    [[line("tool", "a", 1)], line("tool", "b", 3), [block(2, "think")]],
    [[line("text", "said"), line("tool", "a", 1), line("tool-out", "ra", 2)], line("tool", "b", 3), [block(2.5, "think")]],
  ];
  for (const [before, next, blocks] of cases) {
    const all = [...before, next];
    const joined = joinsTail(all, next, blocks, before);
    const merged = merge(all, blocks);
    const units = segments(merged);
    const unitOf = (l) => units.findIndex((s) => s.unit && s.lines.includes(l));
    const polled = unitOf(next) === unitOf(before[before.length - 1]);
    assert.equal(joined, polled, `next=${next.text} blocks=${blocks.length} lines=${shape(all)}`);
  }
});
