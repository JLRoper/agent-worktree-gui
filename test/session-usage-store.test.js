// The session readout used to open and close the 7.35 GB store on every card read (0.3-413.6 ms per open, a
// snapshot asks for every card at once). One read-only connection now lives for the process, the date/count caches
// are keyed honestly, and the index cache is per store rather than one global — the last of those was a real bug:
// a card built from one store could wear the title of a session with the same id in another.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { closeSessionStore, forgetSessionUsage, sessionIndex, sessionUsage } from "../lib/session-usage.js";

function store(t, { id = "session-one", title = "First session" } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "wag-session-store-"));
  const dbPath = path.join(dir, "state.db");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "create table sessions (id text primary key, title text, last_activity_at integer, input_tokens integer, " +
      "output_tokens integer, cache_read_tokens integer, cache_write_tokens integer, api_call_count integer, " +
      "model text, model_config text, message_count integer, billing_provider text, estimated_cost_usd real, " +
      "actual_cost_usd real, cost_status text, cost_source text)",
  );
  db.exec("create table messages (session_id text, timestamp integer, _compressed_summary integer)");
  db.exec(
    "create table session_model_usage (session_id text, model text, billing_provider text, task text, " +
      "api_call_count integer, input_tokens integer, output_tokens integer, cache_read_tokens integer, " +
      "cache_write_tokens integer, estimated_cost_usd real, actual_cost_usd real, cost_status text, cost_source text)",
  );
  add(db, id, title);
  t.after(() => {
    closeSessionStore(dbPath);
    try {
      db.close();
    } catch {
      /* already closed */
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, dbPath, db, id };
}

function add(db, id, title, { input = 100 } = {}) {
  db.prepare(
    "insert into sessions (id, title, last_activity_at, input_tokens, output_tokens, cache_read_tokens, " +
      "cache_write_tokens, api_call_count, model, model_config, message_count, billing_provider, estimated_cost_usd, " +
      "actual_cost_usd, cost_status, cost_source) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, title, 1_700_000_000, input, 20, 5, 0, 3, "deepseek/deepseek-v4.1", JSON.stringify({ _usage_anchor: { prompt_tokens: 1234 } }), 2, "openrouter", 0.01, null, "estimated", "api");
  db.prepare("insert into session_model_usage (session_id, model, billing_provider, task, api_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, estimated_cost_usd, actual_cost_usd, cost_status, cost_source) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    "deepseek/deepseek-v4.1",
    "openrouter",
    "",
    3,
    input,
    20,
    5,
    0,
    0.01,
    null,
    "estimated",
    "api",
  );
  db.prepare("insert into messages (session_id, timestamp, _compressed_summary) values (?, ?, 1)").run(id, 1_700_000_001);
  db.prepare("insert into messages (session_id, timestamp, _compressed_summary) values (?, ?, 1)").run(id, 1_700_000_002);
}

test("a card's readout comes from the open handle and sees a commit made after it was read", (t) => {
  const s = store(t);
  const first = sessionUsage(s.id, { dbPath: s.dbPath, maxAgeMs: 0 });
  assert.equal(first.input_tokens, 100);
  assert.equal(first.anchor_prompt_tokens, 1234, "the usage anchor is the last call's occupancy");
  assert.equal(first.compactions, 2, "one summary message per compaction event");
  assert.equal(first.models.length, 1);
  assert.equal(first.models[0].input_tokens, 100);

  // The gateway writes the turn's final counters; the SAME handle must see them on the next read.
  s.db.prepare("update sessions set input_tokens = 250 where id = ?").run(s.id);
  s.db.prepare("update session_model_usage set input_tokens = 250 where session_id = ? and task = ''").run(s.id);
  const second = sessionUsage(s.id, { dbPath: s.dbPath, maxAgeMs: 0 });
  assert.equal(second.input_tokens, 250, "no snapshot is held between reads");
  assert.equal(second.models[0].input_tokens, 250);
});

test("the session index is keyed by the store, not one global map", (t) => {
  const a = store(t, { id: "session-a", title: "Alpha" });
  const b = store(t, { id: "session-b", title: "Beta" });
  add(b.db, "session-b2", "Beta's second");

  const indexA = sessionIndex({ dbPath: a.dbPath, maxAgeMs: 0 });
  assert.deepEqual([...indexA.keys()], ["session-a"]);
  const indexB = sessionIndex({ dbPath: b.dbPath, maxAgeMs: 0 });
  assert.deepEqual([...indexB.keys()].sort(), ["session-b", "session-b2"], "one store's rows never answer for another's");
  assert.equal(indexB.get("session-b").title, "Beta");
});

test("closeSessionStore frees the file, and a later read reopens it", (t) => {
  const s = store(t);
  assert.equal(sessionUsage(s.id, { dbPath: s.dbPath, maxAgeMs: 0 }).input_tokens, 100);
  closeSessionStore(s.dbPath);
  // A real read after the close must open a fresh handle, not fail.
  assert.equal(sessionUsage(s.id, { dbPath: s.dbPath, maxAgeMs: 0 }).input_tokens, 100);
  closeSessionStore(s.dbPath);
});

test("forgetSessionUsage makes the next read fresh without maxAge 0", (t) => {
  const s = store(t);
  assert.equal(sessionUsage(s.id, { dbPath: s.dbPath, maxAgeMs: 3000 }).input_tokens, 100);
  s.db.prepare("update sessions set input_tokens = 300 where id = ?").run(s.id);
  assert.equal(
    sessionUsage(s.id, { dbPath: s.dbPath, maxAgeMs: 3000 }).input_tokens,
    100,
    "inside the window the cached row is served, which is why a settle must clear it",
  );
  forgetSessionUsage(s.id);
  assert.equal(
    sessionUsage(s.id, { dbPath: s.dbPath, maxAgeMs: 3000 }).input_tokens,
    300,
    "the settle's clear makes the next read the final one",
  );
});

test("the compaction count is cached for a minute across row refreshes", (t) => {
  const s = store(t);
  assert.equal(sessionUsage(s.id, { dbPath: s.dbPath, maxAgeMs: 0 }).compactions, 2);
  s.db.prepare("insert into messages (session_id, timestamp, _compressed_summary) values (?, ?, 1)").run(s.id, 1_700_000_003);
  assert.equal(
    sessionUsage(s.id, { dbPath: s.dbPath, maxAgeMs: 0 }).compactions,
    2,
    "a row refresh does not re-scan the session's messages inside the compaction window",
  );
  forgetSessionUsage(s.id);
  assert.equal(
    sessionUsage(s.id, { dbPath: s.dbPath, maxAgeMs: 0 }).compactions,
    3,
    "the settle's clear lets the next read see the new compaction",
  );
});
