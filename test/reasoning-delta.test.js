// A streamed reasoning CHUNK (gateway `reasoning.delta`) must accumulate into ONE growing 🧠
// preview and never become a console line. The CLI has always shown reasoning live; the durable
// Runs SSE never carried it, so the panel only saw reasoning after the store poll. This is the
// server half of that fix: lib/jobs.js consume()/noteReasoningDelta()/flushReasoning() and the
// linesForEvent() contract. The browser half (appendJobLine thinkOnly, emptyConsoleHtml) is in
// reasoning-delta-pane.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { Jobs } from "../lib/jobs.js";
import { linesForEvent } from "../lib/jobs/console-lines.js";

function harness() {
  const frames = [];
  const jobs = new Jobs({
    config: { apiServer: { url: "http://stub.invalid", key: "sandbox-key" } },
    onEvent: (e) => frames.push(e),
    onLog: () => {},
    children: { killScope: () => 0 },
  });
  const j = {
    id: "rd-1", thread: "wtgui-rd-1", turn: 1,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    status: "running", exitCode: null, endedAt: null,
    lines: [], eventCount: 0, inflight: [], streaming: false,
    reasoningLive: null, reasoningAt: null, reasoningSent: null, reasoningTimer: null,
  };
  jobs.jobs.set(j.id, j);
  const thinkFrames = () => frames.filter((f) => f.type === "jobline" && f.line?.thinkOnly);
  return { jobs, j, frames, thinkFrames };
}

test("linesForEvent never turns a reasoning delta into a console line", () => {
  assert.deepEqual(linesForEvent({ event: "reasoning.delta", delta: "a thought" }), []);
  // The finished reasoning.available block keeps its existing dim+think line (v1.85.5).
  const finished = linesForEvent({ event: "reasoning.available", text: "first\nsecond" });
  assert.equal(finished.length, 1);
  assert.equal(finished[0].kind, "dim");
  assert.equal(finished[0].think, "first\nsecond");
});

test("consume accumulates cumulative text into one coalesced, non-persisted preview frame", () => {
  const { jobs, j, thinkFrames } = harness();
  jobs.consume(j, { event: "reasoning.delta", delta: "Let me " });
  jobs.consume(j, { event: "reasoning.delta", delta: "think." });

  assert.equal(j.reasoningLive, "Let me think.", "chunks concatenate cumulatively");
  assert.ok(j.reasoningAt, "a stable at is stamped once");
  assert.equal(j.streaming, true, "the pulse reads tokens arriving, not silence");
  assert.equal(j.eventCount, 2, "each delta is still a gateway event");
  assert.equal(j.lines.length, 0, "no console line was pushed for a reasoning chunk");

  // The 120 ms coalescing timer would emit the frame; force the flush deterministically.
  jobs.flushReasoning(j);
  const frames = thinkFrames();
  assert.equal(frames.length, 1, "two chunks are ONE coalesced frame, not one per token");
  assert.equal(frames[0].line.kind, "dim");
  assert.equal(frames[0].line.think, "Let me think.", "the frame carries the whole block so far");
  assert.equal(frames[0].line.at, j.reasoningAt, "a stable at keeps it ONE growing 🧠 block");
  assert.equal(frames[0].line.thinkOnly, true, "the browser knows it is a preview, not a console line");
});

test("flushReasoning dedupes identical text and sends only the tail on the next chunk", () => {
  const { jobs, j, thinkFrames } = harness();
  jobs.consume(j, { event: "reasoning.delta", delta: "abc" });
  jobs.flushReasoning(j);
  jobs.flushReasoning(j);
  assert.equal(thinkFrames().length, 1, "a byte-identical flush emits nothing");

  jobs.consume(j, { event: "reasoning.delta", delta: "def" });
  jobs.flushReasoning(j);
  const frames = thinkFrames();
  assert.equal(frames.length, 2, "a new chunk emits again");
  assert.equal(frames[1].line.think, "def", "only the words since the last frame cross the wire");
  assert.equal(frames[1].line.thinkFrom, 3, "the frame says where its chunk starts inside the block");
  assert.equal(frames[1].line.at, frames[0].line.at, "the at is stable across frames (one block)");
});

// The invariant the change buys: the block's text crosses the wire EXACTLY once, in order, however many flushes it
// takes. Re-sending the block on every flush is what made a long thought cost the square of its length.
test("the frames of one block concatenate to it, with no text sent twice", () => {
  const { jobs, j, thinkFrames } = harness();
  const words = "the panel shows what the run is doing without buying the same words twice";
  let i = 0;
  for (const ch of words) {
    jobs.consume(j, { event: "reasoning.delta", delta: ch });
    // Flush every third character: the same 120 ms coalescing, made deterministic.
    i += 1;
    if (i % 3 === 0) jobs.flushReasoning(j);
  }
  jobs.flushReasoning(j);
  const frames = thinkFrames();
  let running = 0;
  for (const [n, f] of frames.entries()) {
    assert.equal(f.line.thinkFrom, running, `frame ${n} starts where the last one ended`);
    assert.ok(f.line.think.length > 0, "no empty frame");
    running += f.line.think.length;
  }
  assert.equal(frames.map((f) => f.line.think).join(""), words, "the chunks reassemble the block exactly");
  assert.equal(running, words.length, "the wire carried the block's characters once, not once per flush");
  assert.ok(frames.length > 5, "several flushes happened, so the claim is not vacuous");
});

test("a block that is not an extension of what was sent starts over at 0 (whole-block frame)", () => {
  const { jobs, j, thinkFrames } = harness();
  jobs.consume(j, { event: "reasoning.delta", delta: "abcdef" });
  jobs.flushReasoning(j);
  // A caller that rewrites the block instead of appending to it: the next paint must be able to replace it.
  j.reasoningLive = "rewritten";
  jobs.flushReasoning(j);
  const frames = thinkFrames();
  assert.equal(frames.length, 2);
  assert.equal(frames[1].line.think, "rewritten");
  assert.equal(frames[1].line.thinkFrom, 0, "an unappendable block is sent whole, as before");
});

test("an empty delta is ignored and does not arm a timer", () => {
  const { jobs, j } = harness();
  jobs.consume(j, { event: "reasoning.delta", delta: "" });
  assert.equal(j.reasoningLive, null, "no text accumulated");
  assert.equal(j.reasoningTimer, null, "no flush timer armed");
});

test("flush at settle emits the final chunk before the turn ends, then stops its mark", () => {
  const { jobs, j, frames, thinkFrames } = harness();
  jobs.consume(j, { event: "reasoning.delta", delta: "final words" });
  // settle() flushes the live reasoning preview the same way it flushes the answer paragraph, then emits the
  // `thinkEnd` frame the console uses to remove the row's still-thinking mark.
  jobs.settle(j, "completed", {});
  const chunks = thinkFrames().filter((f) => f.line.think !== "");
  assert.equal(chunks.length, 1, "the last chunk is not lost when the turn settles");
  assert.equal(chunks[0].line.think, "final words");
  const end = thinkFrames().find((f) => f.line.thinkEnd);
  assert.ok(end, "the row is told the thought stopped");
  assert.equal(end.line.at, chunks[0].line.at, "the mark stops on the same block it started on");
  assert.equal(j.reasoningAt, null, "the next delta opens a new block");
  assert.equal(j.reasoningTimer, null, "the coalescing timer is cleared at settle");
});
