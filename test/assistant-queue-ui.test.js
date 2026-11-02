// The Queue sub-tab's four markers: ○ queued, ● running, ⏸ parked, ✓ done. The row renderer is the page's own code,
// sliced out of public/assistant.js and driven against stubs — the same style as assistant-subtabs.test.js. What this
// pins is the brief's "a browser check that the sub-tab renders all four markers": each state's marker reaches the
// row's HTML, and the row's marker class matches it. A done row is the only one that is greyed, and it stays in place
// rather than vanishing — the record, not a ghost.
//
// The region's top level only constructs a Map and declares functions, so evaluating it executes nothing that needs a
// document. Only `queueTaskHtml` and the two marker helpers are called, and their three stubs are handed in.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sliceRegion } from "../tools/panel-testkit.mjs";

const assistant = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");
const region = sliceRegion(assistant, "the queue sub-tab");

const build = () =>
  new Function(
    "esc",
    "assistantIds",
    "sessionById",
    `${region}
return { queueMark, queueStateName, queueTaskHtml };`,
  )(
    (s) =>
      String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;"),
    () => ["assistant-1", "assistant-2"],
    (id) => ({ id, name: `Assistant ${id}` }),
  );

test("the queue's four markers are the brief's four", () => {
  const { queueMark } = build();
  assert.equal(queueMark("queued"), "○");
  assert.equal(queueMark("running"), "●");
  assert.equal(queueMark("parked"), "⏸");
  assert.equal(queueMark("done"), "✓");
});

test("queueStateName falls every unknown state back to queued", () => {
  const { queueStateName } = build();
  assert.equal(queueStateName("queued"), "queued");
  assert.equal(queueStateName("running"), "running");
  assert.equal(queueStateName("parked"), "parked");
  assert.equal(queueStateName("done"), "done");
  assert.equal(queueStateName("bogus"), "queued");
});

test("each task row renders its state's marker and its marker class", () => {
  const { queueTaskHtml } = build();
  const base = { id: 1, title: "carry it", owner: "assistant-1", files: [] };
  const cases = [
    ["queued", "○"],
    ["running", "●"],
    ["parked", "⏸"],
    ["done", "✓"],
  ];
  for (const [state, mark] of cases) {
    const html = queueTaskHtml("assistant-1", { ...base, state });
    assert.ok(html.includes(`>${mark}</span>`), `${state} renders its marker ${mark}`);
    assert.ok(html.includes(`as-task-mark is-${state}`), `${state} carries its marker class`);
    assert.equal(html.includes("as-task is-done"), state === "done", `${state} row's greyed class`);
  }
});

test("a stale row and a skipped row carry their reason under the marker", () => {
  const { queueTaskHtml } = build();
  const stale = queueTaskHtml("assistant-1", { id: 2, title: "phantom", state: "running", stale: true, staleWhy: "that thread has no live run", files: [] });
  assert.ok(stale.includes("STALE — that thread has no live run"), "the stale sentence is shown, not a spinner");
  const skipped = queueTaskHtml("assistant-1", { id: 3, title: "next", state: "queued", conflict: { files: ["lib/a.js"] }, skipped: "files in use by #2", files: [] });
  assert.ok(skipped.includes("SKIPPED — files in use by #2"), "the conflict's reason is shown on the tab");
});

test("the row offers only transitions away from its current state", () => {
  const { queueTaskHtml } = build();
  const queued = queueTaskHtml("assistant-1", { id: 4, title: "q", state: "queued", files: [] });
  assert.ok(!queued.includes('data-as-qact="queued"'), "no Queue button on a queued row");
  assert.ok(queued.includes('data-as-qact="running"'), "Start is offered");
  assert.ok(queued.includes('data-as-qact="parked"'), "Park is offered");
  assert.ok(queued.includes('data-as-qact="done"'), "Done is offered");
  assert.ok(queued.includes('data-as-qact="delete"'), "delete is always offered");
  const done = queueTaskHtml("assistant-1", { id: 5, title: "d", state: "done", files: [] });
  assert.ok(!done.includes('data-as-qact="done"'), "no Done button on a done row");
  assert.ok(done.includes('data-as-qact="queued"'), "Requeue is offered on a done row");
});

test("a row with no other assistant offers no move, and one with another offers both controls", () => {
  const solo = build();
  // The stub's assistantIds always returns two; rebuild with a single-id stub to drive the empty branch.
  const soloRegion = sliceRegion(assistant, "the queue sub-tab");
  const buildSolo = () =>
    new Function(
      "esc",
      "assistantIds",
      "sessionById",
      `${soloRegion}
return { queueTaskHtml };`,
    )(
      (s) => String(s ?? ""),
      () => ["assistant-1"],
      (id) => ({ id, name: "Assistant #1" }),
    );
  const html = buildSolo().queueTaskHtml("assistant-1", { id: 6, title: "solo", state: "queued", files: [] });
  assert.ok(html.includes("no other assistant to move it to"), "a lone assistant cannot move work to itself");
  assert.ok(!html.includes('data-as-qact="reassign"'), "and no Move button is drawn");
  const withOther = solo.queueTaskHtml("assistant-1", { id: 7, title: "move me", state: "queued", files: [] });
  assert.ok(withOther.includes('data-as-qact="reassign"'), "two assistants means a Move button");
  assert.ok(withOther.includes('data-as-qmove="7"'), "and the picker beside it");
});
