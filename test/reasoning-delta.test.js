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

test("flushReasoning dedupes identical text and grows the same block on the next chunk", () => {
  const { jobs, j, thinkFrames } = harness();
  jobs.consume(j, { event: "reasoning.delta", delta: "abc" });
  jobs.flushReasoning(j);
  jobs.flushReasoning(j);
  assert.equal(thinkFrames().length, 1, "a byte-identical flush emits nothing");

  jobs.consume(j, { event: "reasoning.delta", delta: "def" });
  jobs.flushReasoning(j);
  const frames = thinkFrames();
  assert.equal(frames.length, 2, "a new chunk emits again");
  assert.equal(frames[1].line.think, "abcdef", "cumulative growth, not a replacement");
  assert.equal(frames[1].line.at, frames[0].line.at, "the at is stable across frames (one block)");
});

test("an empty delta is ignored and does not arm a timer", () => {
  const { jobs, j } = harness();
  jobs.consume(j, { event: "reasoning.delta", delta: "" });
  assert.equal(j.reasoningLive, null, "no text accumulated");
  assert.equal(j.reasoningTimer, null, "no flush timer armed");
});

test("flush at settle emits the final chunk before the turn ends", () => {
  const { jobs, j, thinkFrames } = harness();
  jobs.consume(j, { event: "reasoning.delta", delta: "final words" });
  // settle() flushes the live reasoning preview the same way it flushes the answer paragraph.
  jobs.settle(j, "completed", {});
  const frames = thinkFrames();
  assert.equal(frames.length, 1, "the last chunk is not lost when the turn settles");
  assert.equal(frames[0].line.think, "final words");
  assert.equal(j.reasoningTimer, null, "the coalescing timer is cleared at settle");
});
