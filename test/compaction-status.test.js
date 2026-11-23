// The gateway's `hermes.status` frame is the only thing a turn says while it compacts its context: preflight
// compression runs BEFORE the first model call, so a 63s summary call used to leave the card on "no events yet" -
// indistinguishable from a dead socket. This is the server half: the console line and the pulse's copy. The browser
// half (livePulse's is-status branch) is in public/app.js.
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
    id: "cs-1", thread: "wtgui-cs-1", turn: 1,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    status: "running", exitCode: null, endedAt: null,
    lines: [], eventCount: 0, inflight: [], streaming: false,
  };
  jobs.jobs.set(j.id, j);
  return { jobs, j };
}

const COMPACTION = "📦 Preflight compression: ~203,774 tokens >= 200,000 threshold. This may take a moment.";

test("a hermes.status frame becomes one dim console line, in the gateway's own words", () => {
  const lines = linesForEvent({ event: "hermes.status", kind: "compression", text: COMPACTION });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, "dim");
  assert.equal(lines[0].text, COMPACTION, "the status text is never re-worded");
});

test("a status with no text draws no line and leaves the job untouched", () => {
  assert.deepEqual(linesForEvent({ event: "hermes.status", kind: "" }), []);
  const { jobs, j } = harness();
  jobs.consume(j, { event: "hermes.status", kind: "" });
  assert.equal(j.lastStatus, undefined);
});

test("consume keeps the last status for the pulse and counts the frame as an event", () => {
  const { jobs, j } = harness();
  jobs.consume(j, { event: "hermes.status", kind: "compression", text: COMPACTION });
  assert.equal(j.eventCount, 1, "the frame is an event: the card is no longer 'no events yet'");
  const live = jobs.liveOf(j);
  assert.equal(live.events, 1);
  assert.equal(live.status.text, COMPACTION);
  assert.equal(live.status.kind, "compression");
  assert.ok(live.status.at > 0);
  // A later delta does not erase it: the pulse compares the two timestamps and prefers the newest.
  jobs.consume(j, { event: "message.delta", delta: "hello" });
  assert.equal(jobs.liveOf(j).status.text, COMPACTION);
  assert.equal(j.eventCount, 2);
});
