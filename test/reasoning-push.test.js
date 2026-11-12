// A reasoning block that arrives on the run's own event stream is the one chance to show
// thinking BEFORE the /api/thinking store poll finds it. The console has always drawn a
// flattened 240-char dim preview; it must also carry the unflattened block so the client
// can seed the 🧠 pane from the push. Keep the dim line itself unchanged: run-stream.test.js
// pins its kind and exact text.
import test from "node:test";
import assert from "node:assert/strict";
import { linesForEvent } from "../lib/jobs/console-lines.js";

test("a pushed reasoning block carries its full text for the thinking pane", () => {
  const text = "first line\nsecond line of the block";
  const lines = linesForEvent({ event: "reasoning.available", text });
  assert.equal(lines.length, 1, "still one dim line");
  assert.equal(lines[0].kind, "dim");
  assert.equal(lines[0].text, "🧠 reasoning · first line second line of the block", "the preview is unchanged");
  assert.equal(lines[0].think, text, "the unflattened block rides along for the 🧠 pane");
});

test("a reasoning event with no text emits nothing", () => {
  assert.deepEqual(linesForEvent({ event: "reasoning.available" }), []);
});
