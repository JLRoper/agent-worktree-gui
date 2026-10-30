// The reasoning block's source: one turn's thinking, read from the Hermes store.
//
// The block is the only pane on a card that is POLLED (`/api/thinking`, ~every 2.4 s while a turn runs) and then
// redrawn from what the answer says — everything else on the card is appended from the run's own line stream. So the
// two facts this file pins are the two a polled read has to get right:
//
//   1. one thought is ONE block. The store holds the same assistant message twice at one timestamp on this box (494
//      such pairs, always identical text). Drawn as two blocks, the same paragraph appears twice in the reasoning, and
//      both carry `think:<at>` — the single identity the pacer keeps one visible prefix for, so the two would paint
//      each other's words.
//   2. a read that FAILED is not a turn that recorded nothing. It comes back `{ blocks: [], error }` so the card can
//      keep what the block already shows instead of blanking it and refilling on the next poll — the collapse and
//      reopen a reader sees, on the one pane that is redrawn from a store rather than appended to.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { thinkingFor } = await import("../lib/thinking.js");

const SESSION = "probe-thread";

function store(rows) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-thinking-"));
  const dbPath = path.join(dir, "state.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`create table messages (id integer primary key, session_id text, role text, content text,
            reasoning_content text, reasoning text, timestamp real)`);
  const ins = db.prepare("insert into messages (session_id, role, content, reasoning_content, timestamp) values (?,?,?,?,?)");
  for (const r of rows) ins.run(r.session ?? SESSION, "assistant", "", r.text, r.at);
  db.close();
  return { dbPath, dir };
}

const LONG = (n) => Array.from({ length: n }, (_, i) => `thought${i}`).join(" ");

test("one turn's blocks come back oldest first, with their timestamps in ms", () => {
  const { dbPath, dir } = store([
    { at: 1_760_000_002.5, text: "second thought, long enough to count as one" },
    { at: 1_760_000_001.25, text: "first thought, long enough to count as one" },
  ]);
  try {
    const { blocks, error } = thinkingFor(SESSION, { dbPath });
    assert.equal(error, null);
    assert.deepEqual(blocks.map((b) => b.at), [1_760_000_001_250, 1_760_000_002_500]);
    assert.match(blocks[0].text, /^first thought/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the same thought stored twice at one timestamp is ONE block (one lid, one paragraph)", () => {
  const text = LONG(40);
  const { dbPath, dir } = store([
    { at: 1_760_000_010, text },
    { at: 1_760_000_010, text }, // the duplicate row the store really holds
    { at: 1_760_000_011, text: LONG(40) + " and then some more" },
  ]);
  try {
    const { blocks } = thinkingFor(SESSION, { dbPath });
    assert.equal(blocks.length, 2, "the duplicate is one thought, the grown one is a second");
    assert.equal(new Set(blocks.map((b) => b.at)).size, 2, "no two blocks share a timestamp (= a pacer lid)");
    assert.match(blocks[1].text, /and then some more$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a turn with nothing recorded is an empty list and NO error", () => {
  const { dbPath, dir } = store([{ at: 1_760_000_010, text: "only one, and it is in another session", session: "other" }]);
  try {
    assert.deepEqual(thinkingFor(SESSION, { dbPath }), { blocks: [], error: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the turn's own window bounds the read, in ms against the store's seconds", () => {
  const { dbPath, dir } = store([
    { at: 1_760_000_001, text: "before the turn, long enough to count" },
    { at: 1_760_000_010, text: "inside the turn, long enough to count" },
    { at: 1_760_000_020, text: "after the turn, long enough to count" },
  ]);
  try {
    const { blocks } = thinkingFor(SESSION, { dbPath, from: 1_760_000_005_000, to: 1_760_000_015_000 });
    assert.equal(blocks.length, 1);
    assert.match(blocks[0].text, /^inside the turn/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a read that cannot be made says so, instead of claiming the turn thought nothing", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-thinking-"));
  const dbPath = path.join(dir, "not-a-store.db");
  writeFileSync(dbPath, "this is not a sqlite database\n", "utf8");
  try {
    const r = thinkingFor(SESSION, { dbPath });
    assert.deepEqual(r.blocks, []);
    assert.ok(r.error && r.error.length > 0, "the failure has to be visible in the answer");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no store at all is empty, not an error: a thread with no session has nothing to read", () => {
  assert.deepEqual(thinkingFor(SESSION, { dbPath: path.join(os.tmpdir(), "wtgui-no-such-dir", "state.db") }), {
    blocks: [],
    error: null,
  });
});

test("a huge block is capped, and the cap is marked", () => {
  const { dbPath, dir } = store([{ at: 1_760_000_010, text: "x".repeat(9000) }]);
  try {
    const { blocks } = thinkingFor(SESSION, { dbPath });
    assert.equal(blocks[0].text.length, 8000);
    assert.match(blocks[0].text, /…$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
