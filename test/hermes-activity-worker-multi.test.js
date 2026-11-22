// The activity worker's persistent protocol: one worker answers many requests on one read-only handle.
//
// Before this, every liveness tick spawned a worker (bootstrap + a fresh 7.35 GB open) and killed it. The
// host now keeps one per kind (lib/activity.js) and sends {id}; this file pins the worker side: two requests
// get two replies, a bad path reports phase "open" WITHOUT killing the worker, and the next request still works.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Worker } from "node:worker_threads";

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "wag-activity-worker-"));
  const dbPath = path.join(dir, "state.db");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "create table sessions (id text primary key, title text, cwd text, last_activity_at integer, ended_at integer);" +
      "create table session_turn_leases (conversation_id text, expires_at real);" +
      "create table messages (id integer primary key, session_id text, timestamp real, tool_calls text)",
  );
  db.prepare("insert into sessions (id, title, cwd, last_activity_at, ended_at) values (?, ?, ?, ?, ?)").run(
    "s1",
    "One",
    "C:/work/tree",
    1_700_000_100,
    null,
  );
  db.prepare("insert into sessions (id, title, cwd, last_activity_at, ended_at) values (?, ?, ?, ?, ?)").run(
    "s2",
    "Two",
    "C:/work/other",
    1_700_000_050,
    1,
  );
  db.prepare("insert into session_turn_leases (conversation_id, expires_at) values (?, ?)").run("s1", 2_000_000_000);
  db.prepare("insert into messages (session_id, timestamp, tool_calls) values (?, ?, ?)").run(
    "s1",
    1_700_000_090,
    '{"path":"C:/work/tree/a.js"}',
  );
  t.after(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });
  return { dbPath, dir, db };
}

function ask(worker, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the worker did not answer")), 15_000);
    const onMessage = (reply) => {
      if (reply.id !== message.id) return;
      clearTimeout(timer);
      worker.off("message", onMessage);
      resolve(reply);
    };
    worker.on("message", onMessage);
    worker.postMessage(message);
  });
}

test("two requests are answered on one worker, and a bad store does not kill it", async (t) => {
  const { dbPath, dir, db } = fixture(t);
  const worker = new Worker(new URL("../lib/hermes-activity-worker.js", import.meta.url));
  worker.unref();
  t.after(async () => {
    await worker.terminate();
    try {
      db.close();
    } catch {
      /* already closed */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const first = await ask(worker, { id: 1, kind: "sessions", dbPath, now: 1_700_000_100 });
  assert.equal(first.id, 1);
  assert.equal(first.rows.length, 2);
  const one = first.rows.find((r) => r.id === "s1");
  assert.equal(one.leased, 1, "the live lease is reported");
  assert.equal(first.rows.find((r) => r.id === "s2").ended_at, 1);

  const second = await ask(worker, { id: 2, kind: "sessions", dbPath, now: 1_700_000_100 });
  assert.equal(second.id, 2);
  assert.deepEqual(second.rows.map((r) => r.id), first.rows.map((r) => r.id), "the same handle answers again");

  const touched = await ask(worker, { id: 3, kind: "touched", dbPath, now: 1_700_000_200 });
  assert.equal(touched.id, 3);
  assert.equal(touched.rows.length, 1);
  assert.match(touched.rows[0].tool_calls, /C:\/work\/tree\/a\.js/);

  const missing = await ask(worker, { id: 4, kind: "sessions", dbPath: path.join(dbPath, "..", "nope.db"), now: 1 });
  assert.equal(missing.id, 4);
  assert.equal(missing.phase, "open", "an unreadable store says so, it does not throw the worker away");

  const again = await ask(worker, { id: 5, kind: "sessions", dbPath, now: 1_700_000_100 });
  assert.equal(again.id, 5);
  assert.equal(again.rows.length, 2, "and the worker still answers on the store it could read");
});
