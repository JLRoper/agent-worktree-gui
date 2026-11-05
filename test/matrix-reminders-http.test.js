// The bridge's reminder routes over the wire: GET serves its own list AND the assistants' watches as a
// read-only projection; POST is the page's write (add, complete, reopen, delete) and refuses every body that
// asks it to write a watch. Boots the real server.js (tools/panel-testkit.mjs) against a throwaway data
// directory, so this asserts what the routes answer rather than what their source says. The store's own unit
// tests are test/matrix-reminders.test.js; the bridge's turn contract is test/matrix-bridge-turn.test.js.
import assert from "node:assert/strict";
import test from "node:test";
import { post, startPanel } from "../tools/panel-testkit.mjs";

const TOKEN = "matrix-reminders-test-token";
let panel = null;

test.before(async () => {
  panel = await startPanel({ token: TOKEN });
});
test.after(async () => {
  if (panel) await panel.stop();
});

const getJson = async (route) => {
  const r = await fetch(`${panel.base}${route}`);
  return { status: r.status, body: await r.json() };
};

test("a fresh panel serves an empty bridge reminder list, in the state folder, with the watches view beside it", async () => {
  const r = await getJson("/api/matrix/reminders");
  assert.equal(r.status, 200);
  assert.equal(r.body.kind, "matrix-reminders");
  assert.deepEqual(r.body.reminders, []);
  assert.equal(r.body.counts.total, 0);
  assert.equal(r.body.cap, undefined, "the cap rides inside counts where the page reads it");
  assert.equal(r.body.counts.cap, 200);
  assert.equal(Array.isArray(r.body.watches), true, "the assistants' list is projected, never absent");
  assert.equal(r.body.watchesReadOnly, true);
  assert.match(r.body.watchesNote, /read-only/);
  assert.ok(r.body.path.toLowerCase().startsWith(panel.dir.replace(/\\/g, "/").toLowerCase()), "the file is in the sandbox's data directory");
  assert.ok(r.body.path.endsWith("matrix-reminders.json"));
  assert.equal(r.body.path.includes("\\"), false, "the page gets a forward-slash path");
});

test("a reminder round-trips: add, complete, reopen, delete — and the list is distinct from a watch", async () => {
  const added = await post(panel.base, "/api/matrix/reminders", {
    token: TOKEN,
    body: { text: "check the deploy", due: "after lunch" },
  });
  assert.equal(added.status, 200);
  assert.equal(added.json.reminders.length, 1);
  const row = added.json.reminders[0];
  assert.match(row.id, /^br-/);
  assert.equal(row.kind, "bridge-reminder");
  assert.equal(row.thread, undefined, "a reminder is not a watch: no thread");
  assert.equal(row.state, undefined, "a reminder is not a watch: no state");
  assert.equal(added.json.counts.open, 1);

  const read = await getJson("/api/matrix/reminders");
  assert.equal(read.body.reminders[0].text, "check the deploy", "the next reader sees the saved list");
  assert.equal(read.body.reminders[0].due, "after lunch");
  assert.match(read.body.preamble, /- \[ \] check the deploy — due after lunch/, "the turn preamble is built from the saved list");

  const done = await post(panel.base, "/api/matrix/reminders", { token: TOKEN, body: { id: row.id, done: true } });
  assert.equal(done.status, 200);
  assert.equal(done.json.counts.done, 1);
  assert.ok(done.json.reminders[0].doneAt);
  assert.match(done.json.preamble, /- \[x\] check the deploy/, "a completed reminder is still carried, marked done");

  const reopened = await post(panel.base, "/api/matrix/reminders", { token: TOKEN, body: { id: row.id, done: false } });
  assert.equal(reopened.json.counts.open, 1);

  const removed = await post(panel.base, "/api/matrix/reminders", { token: TOKEN, body: { id: row.id, remove: true } });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.json.reminders, []);
  assert.deepEqual((await getJson("/api/matrix/reminders")).body.reminders, []);
});

test("an assistant's watch is visible here but not writable: the refusal names the key and the watch survives", async () => {
  // A real watch, made through the route that owns it. The bridge's view must see it...
  const made = await post(panel.base, "/api/assistant/watch", { token: TOKEN, body: { thread: "thread-7", title: "deploy watch" } });
  assert.equal(made.status, 201);
  const watchId = made.json.watch.id;

  const before = await getJson("/api/matrix/reminders");
  const watch = before.body.watches.find((w) => w.id === watchId);
  assert.ok(watch, "the assistants' watch list is projected into the bridge's view");
  assert.equal(watch.kind, "watch");
  assert.equal(watch.readOnly, true, "every row says it on its own");
  assert.equal(watch.thread, "thread-7");
  assert.equal(before.body.watchesReadOnly, true);
  assert.match(before.body.preamble, /## Assistants' watches — READ ONLY/);
  assert.match(before.body.preamble, /deploy watch — watching/);

  // ...and every way of asking this route to write one is refused BEFORE the file moves.
  for (const body of [
    { watches: [] },
    { watch: { title: "replacement" } },
    { watchId, done: true },
    { id: watchId, assistantId: "assistant-1" },
    { watchState: "done" },
  ]) {
    const refused = await post(panel.base, "/api/matrix/reminders", { token: TOKEN, body });
    assert.equal(refused.status, 400, `${JSON.stringify(body)} is a bad body, not a write`);
    assert.match(refused.json.error, /READ ONLY/);
    assert.equal(refused.json.watchesReadOnly, true, "the refusal still answers with the read-only payload");
  }

  const after = await getJson("/api/assistant");
  const still = after.body.watches.find((w) => w.id === watchId);
  assert.ok(still, "the watch is still the assistant's, unchanged");
  assert.equal(still.state, "watching", "nothing completed it");
  assert.deepEqual((await getJson("/api/matrix/reminders")).body.reminders, [], "and no refusal wrote a reminder either");

  await post(panel.base, "/api/assistant/watch/remove", { token: TOKEN, body: { id: watchId } });
});

test("the refusals are real statuses: 404 for a gone id, 400 for a bad body and an empty text", async () => {
  const missing = await post(panel.base, "/api/matrix/reminders", { token: TOKEN, body: { id: "br-not-here", done: true } });
  assert.equal(missing.status, 404);
  assert.match(missing.json.error, /no reminder with id/);

  const empty = await post(panel.base, "/api/matrix/reminders", { token: TOKEN, body: { text: "   " } });
  assert.equal(empty.status, 400);
  assert.match(empty.json.error, /needs some text/);

  const notJson = await post(panel.base, "/api/matrix/reminders", { token: TOKEN, body: { text: 7 } });
  assert.equal(notJson.status, 400);

  const badShape = await post(panel.base, "/api/matrix/reminders", { token: TOKEN, body: [1, 2, 3] });
  assert.equal(badShape.status, 400);
  assert.match(badShape.json.error, /send a JSON object/);
});

test("GET /api/matrix/status carries the same reminder list, so the Bridge tab draws one moment", async () => {
  await post(panel.base, "/api/matrix/reminders", { token: TOKEN, body: { text: "status copy" } });
  const status = await getJson("/api/matrix/status");
  assert.equal(status.status, 200);
  assert.ok(status.body.reminders.reminders.some((r) => r.text === "status copy"), "the status answer carries the list");
  assert.equal(status.body.reminders.watchesReadOnly, true);
  assert.equal(status.body.policy.preamble.includes("How the reader wants the Matrix bridge"), true,
    "the policy payload carries the preamble the bridge appends");
});
