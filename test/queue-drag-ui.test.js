// The queue pane's drag: the order it draws, the drop it refuses, and the one card that wears a badge.
//
// The gesture itself lives in listeners and is proved by tools/verify-queue-drag.mjs in a real browser. What this file
// pins is the half that decides anything — the pure functions the gesture calls, sliced out of public/assistant.js and
// driven against fixtures:
//
//   1. `queueSorted` puts the state bucket first (running, queued, parked, done), `order` second, id last — so a
//      dragged card keeps its place across a reload and a row with no `order` keeps the id order every old file drew;
//   2. `queueDropBlocked` finds the drop a hold forbids — a queued row above the row it holds for — and says nothing
//      about a hold whose target is done, gone, or names no row at all;
//   3. `queueHoldBadge` is on the card whose hold blocks, and on no other; a row with no hold carries no badge;
//   4. the row markup: a queued card is the only draggable one, and every card carries its state and its queue's id.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sliceRegion } from "../tools/panel-testkit.mjs";

const assistant = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");
const region = sliceRegion(assistant, "the queue sub-tab");

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const build = () =>
  new Function(
    "esc",
    "assistantIds",
    "sessionById",
    "assistantThreadName",
    `${region}
return { queueSorted, queueOrderOf, queueDropBlocked, queueHoldBadge, queueHoldTarget, queueTaskHtml, QUEUE_BUCKET };`,
  )(esc, () => ["assistant-1", "assistant-2"], (id) => ({ id, name: `Assistant ${id}` }), (t) => t);

const tasks = () => [
  { id: 1, title: "carrying it", state: "running", files: [] },
  { id: 2, title: "second", state: "queued", files: [] },
  { id: 3, title: "first", state: "queued", files: [] },
  { id: 4, title: "third", state: "queued", files: [] },
  { id: 5, title: "waiting", state: "parked", files: [] },
  { id: 6, title: "finished", state: "done", files: [] },
];
const order = (rows) => rows.map((t) => t.id);

test("the pane's order: bucket first, then the reader's order, then the id", () => {
  const { queueSorted } = build();
  assert.deepEqual(order(queueSorted(tasks())), [1, 2, 3, 4, 5, 6], "with no order stored, the id order every old file drew");

  const dragged = tasks();
  dragged.find((t) => t.id === 4).order = 1;
  dragged.find((t) => t.id === 2).order = 2;
  dragged.find((t) => t.id === 3).order = 3;
  assert.deepEqual(order(queueSorted(dragged)), [1, 4, 2, 3, 5, 6], "the queued block follows `order`");

  // A drag never lifts a card out of its section even if a hand-edited order says so: the done row with the smallest
  // order on the board still paints last, and the queued block still sorts only against itself.
  const crossed = tasks();
  crossed.find((t) => t.id === 6).order = 1;
  assert.deepEqual(order(queueSorted(crossed)), [1, 2, 3, 4, 5, 6], "a done row stays last whatever order it carries");
  crossed.find((t) => t.id === 3).order = 99;
  assert.deepEqual(order(queueSorted(crossed)), [1, 2, 4, 3, 5, 6], "the queued block re-sorts, and nothing else moves");
});

test("queueOrderOf is the stored order, or the id", () => {
  const { queueOrderOf } = build();
  assert.equal(queueOrderOf({ id: 7 }), 7);
  assert.equal(queueOrderOf({ id: 7, order: 2 }), 2);
  assert.equal(queueOrderOf({ id: 7, order: "x" }), 7);
  assert.equal(queueOrderOf({ id: 7, order: 0 }), 7);
});

test("a drop is blocked when a queued card would sit above the row it holds for", () => {
  const { queueDropBlocked } = build();
  const rows = tasks();
  rows.find((t) => t.id === 3).hold = { kind: "task", value: "2", since: "2024-05-01T21:36:00.000Z" };
  const all = [1, 2, 3, 4, 5, 6];

  const blocked = queueDropBlocked(rows, [1, 2, 3, 4, 5, 6]);
  assert.equal(blocked, null, "behind the row it waits on is where it belongs");

  const bad = queueDropBlocked(rows, [1, 3, 2, 4, 5, 6]);
  assert.deepEqual([bad.id, bad.target], [3, 2], "the row and the row that holds it are both named");
  assert.match(bad.line, /^#3 is held by #2 since 21:36 — it cannot move above it$/, "and the line the pane shows is one sentence");
  assert.deepEqual(queueDropBlocked(rows, all), null);
});

test("a hold that has ended blocks nothing: the target done, gone, or a kind that names no row", () => {
  const { queueDropBlocked } = build();
  const done = tasks();
  done.find((t) => t.id === 2).state = "done";
  done.find((t) => t.id === 3).hold = { kind: "task", value: "2", since: "2024-05-01T21:36:00.000Z" };
  assert.equal(queueDropBlocked(done, [1, 3, 4, 2, 5, 6]), null, "the hold ended with the row it waited on");

  const gone = tasks();
  gone.find((t) => t.id === 3).hold = { kind: "task", value: "42", since: "2024-05-01T21:36:00.000Z" };
  assert.equal(queueDropBlocked(gone, [1, 3, 2, 4, 5, 6]), null, "a target that left the queue cannot be reached");

  const other = tasks();
  other.find((t) => t.id === 3).hold = { kind: "thread", value: "wtgui-x-abc123", since: "2024-05-01T21:36:00.000Z" };
  assert.equal(queueDropBlocked(other, [1, 3, 2, 4, 5, 6]), null, "a thread hold names no row on this list");
});

test("only the card whose hold blocks wears the badge", () => {
  const { queueHoldBadge } = build();
  const rows = tasks();
  const byId = new Map(rows.map((t) => [t.id, t]));
  assert.equal(queueHoldBadge(rows[1], byId), "", "a row with no hold carries no badge");

  const held = { ...rows[2], hold: { kind: "task", value: "#2", since: "2024-05-01T21:36:00.000Z" } };
  const html = queueHoldBadge(held, byId);
  assert.match(html, /class="as-task-hold" data-as-qhold="2"/, "the badge names the row it holds for");
  assert.match(html, />held by #2</, "and says so in words");
  assert.match(html, /title="held by #2 since 21:36 — this card cannot be dragged above it"/);

  const doneTarget = new Map([...byId, [2, { ...rows[1], state: "done" }]]);
  assert.equal(queueHoldBadge(held, doneTarget), "", "a hold whose row is done no longer blocks, so the badge goes");
  const ghostTarget = new Map([...byId].filter(([id]) => id !== 2));
  assert.equal(queueHoldBadge(held, ghostTarget), "", "nor does one whose row left the queue");
});

test("a queued card is the only one the drag can pick up", () => {
  const { queueTaskHtml } = build();
  const rows = tasks();
  const html = rows.map((t) => queueTaskHtml("assistant-1", t, new Map(), new Map(rows.map((x) => [x.id, x]))));
  const queuedFlags = html.map((h) => h.includes("is-draggable"));
  assert.deepEqual(queuedFlags, [false, true, true, true, false, false], "running, parked and done keep their section");

  // Every card says what it is (the drop reads it) and which queue it belongs to (the write is scoped to it).
  assert.deepEqual(
    [...html.join("").matchAll(/data-as-qstate="([a-z]+)" data-as-qown="([^"]+)" data-as-qthread/g)].map((m) => `${m[1]}:${m[2]}`),
    ["running:assistant-1", "queued:assistant-1", "queued:assistant-1", "queued:assistant-1", "parked:assistant-1", "done:assistant-1"],
  );
  // The body is still the opener — the drag must not have taken that away from the card.
  assert.ok(html.every((h) => h.includes('class="as-task-body"') && !h.includes("data-as-qopen=\"\"")), "each row keeps its body");
});
