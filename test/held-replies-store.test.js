// The store behind a reply held behind a live turn (lib/held-replies.js), on its own: no HTTP, no jobs, no page.
//
// What this file pins is the part a restart depends on: the record is on disk BEFORE any turn exists, `seq` is the
// arrival order a replay walks, `claim()` lets exactly one caller turn a record into a turn, and a process that died
// between the claim and the `sent` is repaired on the next boot by reading the id back off the job. Get any of those
// wrong and a replay either starts a second turn for one hold or silently drops the reader's message.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHeldReplies, HELD_DONE_KEEP, HELD_TOTAL_CAP, HELD_BACKOFF_MAX_MS, heldBackoffMs } from "../lib/held-replies.js";

function tmpFile() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "held-replies-"));
  return { file: path.join(dir, "held-replies.json"), dir };
}

const fresh = (file) => {
  const s = createHeldReplies({ file });
  s.load();
  return s;
};

test("a hold is written to disk before anything else, with its words and its files", () => {
  const { file, dir } = tmpFile();
  const files = [{ path: "attachments/111-turnaround.txt", name: "turnaround.txt", type: "text/plain", bytes: 2048 }];
  try {
    const store = fresh(file);
    const { reply, added } = store.add({ thread: "wtgui-a", text: "and then check the second one", attachments: files, at: 1_700_000_000_000 });
    assert.equal(added, true);
    assert.equal(reply.state, "held");
    assert.equal(reply.seq, 1);
    // ON DISK: the file is the record, not a cache of it. This is the assertion the whole module exists for.
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.replies.length, 1);
    assert.equal(onDisk.replies[0].id, reply.id);
    assert.equal(onDisk.replies[0].text, "and then check the second one");
    assert.deepEqual(onDisk.replies[0].attachments.map((a) => a.path), ["attachments/111-turnaround.txt"]);
    // ...and a fresh store over the same path is the panel after a restart.
    const again = fresh(file);
    assert.equal(again.view().open.length, 1);
    assert.equal(again.get(reply.id).text, "and then check the second one");
    assert.deepEqual(again.get(reply.id).attachments.map((a) => a.path), ["attachments/111-turnaround.txt"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the same id is one record: a retried POST cannot queue the message twice", () => {
  const { file, dir } = tmpFile();
  try {
    const store = fresh(file);
    const first = store.add({ id: "abc123", thread: "wtgui-a", text: "one" });
    const second = store.add({ id: "abc123", thread: "wtgui-a", text: "one, again" });
    assert.equal(first.added, true);
    assert.equal(second.added, false);
    assert.equal(store.view().replies.length, 1);
    // The first words win: a retry is a retry, not an edit.
    assert.equal(store.get("abc123").text, "one");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("seq is the arrival order, and a replay walks it even when the page's clocks agree", () => {
  const { file, dir } = tmpFile();
  try {
    const store = fresh(file);
    const at = 1_700_000_000_000;
    store.add({ id: "b", thread: "wtgui-a", text: "second", at });
    store.add({ id: "a", thread: "wtgui-a", text: "first", at });
    assert.deepEqual(store.openForThread("wtgui-a").map((r) => r.id), ["b", "a"], "the order they ARRIVED, not the id order");
    // And it survives the file: the replay after a restart is the same order.
    const again = fresh(file);
    assert.deepEqual(again.openForThread("wtgui-a").map((r) => r.id), ["b", "a"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claim lets exactly one caller start a turn, and a claimed record is not claimed again", () => {
  const { file, dir } = tmpFile();
  try {
    const store = fresh(file);
    const { reply } = store.add({ thread: "wtgui-a", text: "go" });
    const winner = store.claim(reply.id);
    assert.equal(winner.state, "sending");
    assert.equal(store.claim(reply.id), null, "the second caller gets nothing, which is what stops a second turn");
    // A claimed record is still owed a turn, so it is in `open` but the drain may not start it directly.
    assert.deepEqual(store.view().open.map((r) => r.state), ["sending"]);
    assert.equal(store.openForThread("wtgui-a")[0].state, "sending");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a record that has a turn is never replayed, and a released claim is", () => {
  const { file, dir } = tmpFile();
  try {
    const store = fresh(file);
    const { reply } = store.add({ thread: "wtgui-a", text: "go" });
    store.claim(reply.id);
    store.sent(reply.id, "job-7");
    assert.equal(store.get(reply.id).state, "sent");
    assert.equal(store.get(reply.id).jobId, "job-7");
    assert.deepEqual(store.view().open, [], "sent is not open: a replay cannot start it");
    assert.equal(store.claim(reply.id), null, "and it cannot be claimed either");
    // A refusal puts it back, with the reason on the record, so the card can say why it waits.
    const second = store.add({ thread: "wtgui-b", text: "later" });
    store.claim(second.reply.id);
    store.release(second.reply.id, "the tree has a live run");
    assert.equal(store.get(second.reply.id).state, "held");
    assert.equal(store.get(second.reply.id).why, "the tree has a live run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("boot repair: a claim whose turn WAS accepted is marked sent; one whose turn was not goes back to held", () => {
  const { file, dir } = tmpFile();
  try {
    const store = fresh(file);
    const { reply: accepted } = store.add({ id: "acc", thread: "wtgui-a", text: "the turn happened" });
    const { reply: died } = store.add({ id: "died", thread: "wtgui-b", text: "the process died first" });
    store.claim(accepted.id);
    store.claim(died.id);
    // The panel died here. On the next boot one job carries `acc`, and nothing carries `died`.
    const after = fresh(file);
    const out = after.reconcile((id) => (id === "acc" ? { id: "job-9" } : null));
    assert.equal(out.changed, 2);
    assert.equal(after.get("acc").state, "sent");
    assert.equal(after.get("acc").jobId, "job-9", "the turn that exists is the one the record names");
    assert.equal(after.get("died").state, "held", "no turn means it is still owed one");
    assert.match(after.get("died").why, /restarted while this hold was being accepted/);
    assert.deepEqual(after.view().open.map((r) => r.id), ["died"], "only the unaccepted one is replayed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the reader can take a hold back or edit it, and cannot do either once it is claimed", () => {
  const { file, dir } = tmpFile();
  try {
    const store = fresh(file);
    const { reply } = store.add({ thread: "wtgui-a", text: "first words" });
    assert.equal(store.edit(reply.id, "better words").ok, true);
    assert.equal(store.get(reply.id).text, "better words");
    assert.equal(store.edit(reply.id, "   ").ok, false, "an empty edit cancels, and the caller sends cancel for that");
    assert.equal(store.cancel(reply.id).ok, true);
    assert.equal(store.get(reply.id).state, "cancelled");
    assert.deepEqual(store.view().open, [], "a cancelled hold is never replayed");
    // A claimed record: its words are settled, and the x is answered with the truth rather than a false "cancelled".
    const second = store.add({ thread: "wtgui-b", text: "mid-flight" });
    store.claim(second.reply.id);
    assert.equal(store.edit(second.reply.id, "no").ok, false);
    assert.equal(store.cancel(second.reply.id).ok, false);
    assert.equal(store.cancel(second.reply.id).state, "sending");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file that cannot be read is left alone, and a record without words or a thread is not loaded", () => {
  const { file, dir } = tmpFile();
  try {
    writeFileSync(file, "{ this is not json", "utf8");
    const store = fresh(file);
    assert.deepEqual(store.view().replies, [], "nothing is replayed out of a file that could not be read");
    assert.equal(readFileSync(file, "utf8"), "{ this is not json", "and it is not overwritten: the words may still be in it");
    // A hand-edited record: one good, one with no text, one with no thread, one with an unknown state.
    rmSync(file, { force: true });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        seq: 0,
        replies: [
          { id: "ok", thread: "wtgui-a", text: "keep me", seq: 1, state: "held" },
          { id: "empty", thread: "wtgui-a", text: "   ", seq: 2, state: "held" },
          { id: "threadless", text: "nowhere", seq: 3, state: "held" },
          { id: "odd", thread: "wtgui-b", text: "unknown state", seq: 4, state: "banana" },
        ],
      }),
      "utf8",
    );
    const loaded = fresh(file);
    assert.deepEqual(loaded.view().replies.map((r) => r.id), ["ok", "odd"]);
    assert.equal(loaded.get("odd").state, "held", "an unknown state reads as held: a message the reader meant to send");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the caps drop old terminal records and never a record still owed a turn", () => {
  const { file, dir } = tmpFile();
  try {
    const store = fresh(file);
    // Fill well past both caps with terminal records...
    for (let i = 0; i < HELD_TOTAL_CAP + 30; i += 1) {
      const { reply } = store.add({ thread: "wtgui-a", text: `done ${i}` });
      store.claim(reply.id);
      store.sent(reply.id, `job-${i}`);
    }
    const done = store.view().replies.filter((r) => r.state === "sent");
    assert.ok(done.length <= Math.max(HELD_DONE_KEEP, HELD_TOTAL_CAP), `sent records are capped (${done.length})`);
    assert.ok(store.view().replies.length <= HELD_TOTAL_CAP, "the file itself is capped");
    // ...then hold more than the cap can hold, and check none of them is dropped.
    const held = [];
    for (let i = 0; i < 5; i += 1) held.push(store.add({ thread: "wtgui-b", text: `waiting ${i}` }).reply.id);
    assert.deepEqual(store.openForThread("wtgui-b").map((r) => r.id), held, "every hold still owed a turn survived the cap");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hold needs a thread and words, and says which one is missing", () => {
  const { file, dir } = tmpFile();
  try {
    const store = fresh(file);
    assert.throws(() => store.add({ thread: "", text: "x" }), /thread it is meant for/);
    assert.throws(() => store.add({ thread: "wtgui-a", text: "  " }), /needs its text/);
    assert.deepEqual(store.view().replies, [], "and nothing was written for either");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- a failure is a state, not a retry loop ------------------------------------------------------
// One record for a thread the panel no longer has was retried every 2s for 45.9 hours and wrote 87% of a day's
// log (measured 2026-11-21). A permanent reason parks the record; a transient one backs off. Neither drops the
// reader's words, and neither is retried forever at the clock's beat.

test("a permanent failure PARKS the record: kept, never replayed, and Retry revives it", () => {
  const { file, dir } = tmpFile();
  try {
    const store = fresh(file);
    const { reply } = store.add({ thread: "gone-thread", text: "still mine" });
    store.claim(reply.id);
    const parked = store.fail(reply.id, "unknown thread: gone-thread", { permanent: true, now: 1_700_000_000_000 });
    assert.equal(parked.state, "parked");
    assert.equal(parked.attempts, 1);
    assert.equal(parked.lastError, "unknown thread: gone-thread");
    assert.ok(parked.parkedAt, "the moment it was parked is on the record");
    assert.deepEqual(store.view().open, [], "parked is not owed a turn: the drain never asks again");
    assert.equal(store.view().counts.parked, 1);
    assert.equal(store.claim(reply.id), null, "and it cannot be claimed");
    // The words survive a restart, still parked.
    const again = fresh(file);
    assert.equal(again.get(reply.id).state, "parked");
    assert.equal(again.get(reply.id).text, "still mine");
    assert.deepEqual(again.view().open, []);
    // Retry is the reader's way back: held, with the attempt record cleared.
    const out = again.retry(reply.id);
    assert.equal(out.ok, true);
    assert.equal(again.get(reply.id).state, "held");
    assert.equal(again.get(reply.id).attempts, 0);
    assert.equal(again.get(reply.id).nextTryAt, 0);
    assert.equal(again.get(reply.id).why, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a transient failure backs off 2s, 4s, 8s ... capped, and the record stays held", () => {
  const { file, dir } = tmpFile();
  try {
    const store = fresh(file);
    const { reply } = store.add({ thread: "wtgui-a", text: "go" });
    store.claim(reply.id);
    const t = 1_700_000_000_000;
    store.fail(reply.id, "the gateway is down", { now: t });
    assert.equal(store.get(reply.id).state, "held", "a transient reason is never parked: the words are still owed a turn");
    assert.equal(store.get(reply.id).attempts, 1);
    assert.equal(store.get(reply.id).nextTryAt, t + 2_000);
    store.claim(reply.id);
    store.fail(reply.id, "the gateway is down", { now: t + 2_000 });
    assert.equal(store.get(reply.id).attempts, 2);
    assert.equal(store.get(reply.id).nextTryAt, t + 2_000 + 4_000);
    // The ceiling: an outage is never abandoned, and never hammered.
    for (let i = 0; i < 20; i += 1) {
      store.claim(reply.id);
      store.fail(reply.id, "down", { now: t + i * 1_000 });
    }
    assert.equal(store.get(reply.id).state, "held");
    assert.equal(store.get(reply.id).nextTryAt - (t + 19_000), HELD_BACKOFF_MAX_MS);
    assert.equal(heldBackoffMs(1), 2_000);
    assert.equal(heldBackoffMs(3), 8_000);
    assert.equal(heldBackoffMs(99), HELD_BACKOFF_MAX_MS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fail never reopens a settled record, and retry only revives a parked one", () => {
  const { file, dir } = tmpFile();
  try {
    const store = fresh(file);
    const { reply } = store.add({ thread: "wtgui-a", text: "went" });
    store.claim(reply.id);
    store.sent(reply.id, "job-1");
    assert.equal(store.fail(reply.id, "too late"), null, "a sent turn is not reopened by a late failure");
    assert.equal(store.get(reply.id).state, "sent");
    assert.equal(store.get(reply.id).lastError, null);
    // A held record is already waiting; retry is only for the parked shelf.
    const held = store.add({ thread: "wtgui-b", text: "waiting" }).reply;
    assert.equal(store.retry(held.id).ok, false);
    assert.equal(store.get(held.id).state, "held");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
