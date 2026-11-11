import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readTouchedRows } from "../lib/hermes-activity-worker.js";

const original = "select session_id, tool_calls, timestamp from messages " +
  "where timestamp > ? and tool_calls is not null and length(tool_calls) > 16 " +
  "order by timestamp desc, id asc limit 250";

function fixture(indexed) {
  const db = new DatabaseSync(":memory:");
  db.exec("create table messages (id integer primary key, session_id text, timestamp real, tool_calls text)");
  if (indexed) db.exec("create index idx_messages_session on messages(session_id, timestamp)");
  const insert = db.prepare("insert into messages values (?, ?, ?, ?)");
  // More than 250 rows, including null/orphan sessions, ties, old rows and non-tool messages.
  for (let i = 1; i <= 420; i++) {
    insert.run(i, i % 13 === 0 ? null : `session-${i % 17}`, 1000 + Math.floor(i / 3),
      i % 19 === 0 ? null : `tool call ${i} C:/project/tree/file.js`);
  }
  return db;
}

for (const indexed of [true, false]) {
  test(`global newest 250 remain unchanged ${indexed ? "with" : "without"} the session index`, () => {
    const db = fixture(indexed);
    try {
      // Avoid an ambiguous boundary tie when comparing against the original ORDER BY timestamp alone.
      const expected = db.prepare(original).all(1000).map((r) => ({ ...r }));
      const actual = readTouchedRows(db, 1000).map((r) => ({ ...r }));
      assert.equal(actual.length, 250);
      assert.deepEqual(actual, expected);
    } finally { db.close(); }
  });
}

test("a very busy session cannot crowd out globally newer calls from other sessions", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("create table messages (id integer primary key, session_id text, timestamp real, tool_calls text);" +
    "create index idx_messages_session on messages(session_id, timestamp)");
  const insert = db.prepare("insert into messages values (?, ?, ?, ?)");
  for (let i = 1; i <= 600; i++) insert.run(i, i <= 500 ? "busy" : "orphan", i, `call number ${i} C:/work/tree/a.js`);
  try {
    assert.deepEqual(readTouchedRows(db, 0).map((r) => ({ ...r })),
      db.prepare(original).all(0).map((r) => ({ ...r })));
  } finally { db.close(); }
});

test("a partial session index cannot stand in for a complete index", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("create table messages (id integer primary key, session_id text, timestamp real, tool_calls text);" +
    "create index idx_partial on messages(session_id, timestamp) where session_id = 'a';" +
    "insert into messages values (1, 'a', 100, 'first-tool-call-that-is-long');" +
    "insert into messages values (2, 'b', 101, 'second-tool-call-that-is-long')");
  try {
    assert.deepEqual(readTouchedRows(db, 0).map((r) => ({ ...r })), db.prepare(original).all(0).map((r) => ({ ...r })));
  } finally { db.close(); }
});

test("simultaneous session callers share the worker result without blocking a timer", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "wtgui-activity-worker-"));
  const oldHome = process.env.HERMES_HOME;
  process.env.HERMES_HOME = home;
  const db = new DatabaseSync(path.join(home, "state.db"));
  db.exec("create table sessions (id text, title text, cwd text, last_activity_at real, ended_at real);" +
    "create table messages (id integer primary key, session_id text, timestamp real, tool_calls text);" +
    "create index idx_messages_session on messages(session_id, timestamp);" +
    "create table session_turn_leases (conversation_id text, expires_at real);");
  db.prepare("insert into sessions values (?, ?, ?, ?, ?)").run("one", "One", "C:/work/tree", Date.now() / 1000, null);
  db.prepare("insert into messages values (?, ?, ?, ?)").run(1, "one", Date.now() / 1000, 'read C:/work/tree/src/file.js');
  db.close();
  try {
    const { hermesSessions, hermesTouchedPaths, hermesSessionRoots } = await import("../lib/activity.js");
    let ticked = false;
    const timer = new Promise((resolve) => setTimeout(() => { ticked = true; resolve(); }, 0));
    const [first, second, touched] = await Promise.all([hermesSessions(), hermesSessions(), hermesTouchedPaths()]);
    await timer;
    assert.ok(ticked);
    assert.strictEqual(first, second, "in-flight callers must share one result, not receive cached null");
    assert.equal(first[0].id, "one");
    assert.equal(touched.get("one")[0].paths[0], "c:/work/tree/src/file.js");
    const roots = await hermesSessionRoots(["C:/work/tree", "C:/work/tree/src", "C:/work/tre"]);
    assert.equal(roots.get("c:/work/tree/src")[0].id, "one", "the deepest containing worktree wins");
    assert.equal(roots.get("c:/work/tree/src")[0].matched, "work");
    assert.equal((await hermesSessionRoots(["C:/work/tree"], { exclude: new Set(["one"]) })).size, 0);
  } finally {
    if (oldHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
});
