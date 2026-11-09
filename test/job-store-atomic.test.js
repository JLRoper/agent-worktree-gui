// The job store is written while a panel is running and read by the next boot, so a write must never be
// visible half done. jobs.json was caught at exactly 1,048,576 bytes with its JSON cut mid-string, then at
// 0 bytes, then at 524,288 bytes, all inside one minute: a restart inside that window read a fragment,
// logged "could not read", and lost every job. These tests pin the writer to the temp-file-and-rename
// shape that removes the window, and pin the growth bound to KEEP_JOBS rather than to a byte cap.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Jobs, KEEP_JOBS, writeFileQueued } from "../lib/jobs.js";

// A store-shaped payload: one job per conversation, each with its console lines, sized so the payload is a
// real one rather than a fixture a write cannot be caught inside.
function storePayload({ jobs, savedAt, lineCount = 40, lineLength = 90 }) {
  const line = "-".repeat(lineLength);
  return JSON.stringify({
    savedAt,
    jobs: Array.from({ length: jobs }, (_, i) => ({
      id: `j-${i}`,
      thread: `t-${i}`,
      status: "done",
      startedAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 60_000).toISOString(),
      lines: Array.from({ length: lineCount }, (_, n) => ({ lid: n + 1, text: `${i}/${n} ${line}` })),
    })),
  });
}

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "wag-store-atomic-"));
}

test("a queued write lands the whole payload and leaves no temp file behind", async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "jobs.json");
    const payload = storePayload({ jobs: 4, savedAt: "2026-01-01T00:00:00.000Z" });
    await writeFileQueued(file, payload);
    assert.equal(readFileSync(file, "utf8"), payload, "the target is the payload, byte for byte");
    assert.deepEqual(
      readdirSync(dir),
      ["jobs.json"],
      "the temp file was renamed over the target, not left beside it for the next reader to trip on",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reader sees the whole old file or the whole new one, never a fragment", async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "jobs.json");
    const small = storePayload({ jobs: 2, savedAt: "old", lineCount: 10 });
    const big = storePayload({ jobs: KEEP_JOBS, savedAt: "new", lineCount: 40 });
    const smallBytes = Buffer.byteLength(small, "utf8");
    const bigBytes = Buffer.byteLength(big, "utf8");
    assert.ok(bigBytes > smallBytes, "the two snapshots are different sizes, so a torn read cannot hide behind an equal length");

    await writeFileQueued(file, small);

    // A reader that never stops: every read is a JSON.parse of whatever is on disk at that instant. The
    // writer alternates a small store and a full one so both sizes have to appear whole, and any third size
    // on disk is a fragment the atomic swap failed to hide.
    const seen = new Map(); // bytes -> reads
    let bad = 0;
    let reads = 0;
    let stop = false;
    const reader = (async () => {
      while (!stop) {
        const text = await readFile(file, "utf8");
        reads += 1;
        const bytes = Buffer.byteLength(text, "utf8");
        seen.set(bytes, (seen.get(bytes) || 0) + 1);
        try {
          JSON.parse(text);
        } catch {
          bad += 1;
        }
      }
    })();

    let last = small;
    for (let i = 0; i < 30; i += 1) {
      last = i % 2 ? small : big;
      await writeFileQueued(file, last);
    }
    stop = true;
    await reader;

    assert.ok(reads > 50, `the reader has to have read during the writes; it read ${reads} times`);
    assert.equal(bad, 0, `every read must parse as JSON; ${bad} of ${reads} did not`);
    assert.deepEqual(
      [...seen.keys()].sort((a, b) => a - b),
      [smallBytes, bigBytes].sort((a, b) => a - b),
      `only a whole payload may ever be on disk; sizes seen: ${[...seen.entries()].map(([b, n]) => `${b}x${n}`).join(", ")}`,
    );
    assert.equal(JSON.parse(readFileSync(file, "utf8")).savedAt, last === big ? "new" : "old", "the newest snapshot is the one that remained");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writes to one path serialize, so the last call is the one that remains", async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "labels.json");
    const calls = Array.from({ length: 12 }, (_, i) => writeFileQueued(file, JSON.stringify({ savedAt: i })));
    await Promise.all(calls);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).savedAt, 11, "the chain ran in call order");
    assert.deepEqual(readdirSync(dir), ["labels.json"], "twelve chained writes left no temp files");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the store's own save keeps KEEP_JOBS entries and a file a restart can parse", async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "jobs.json");
    const store = new Jobs({ config: { jobsFile: file, apiServer: { url: "http://127.0.0.1:9" } } });
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    for (let i = 0; i < 100; i += 1) {
      store.jobs.set(`j-${i}`, {
        id: `j-${i}`,
        thread: `t-${i}`,
        status: "done",
        startedAt: new Date(base + i * 60_000).toISOString(),
        lines: [],
        artifacts: [],
        attachments: [],
      });
    }
    store.schedulePersist();

    // The save is debounced (700 ms), so wait for the file rather than sleeping a magic number.
    const until = Date.now() + 10_000;
    let doc = null;
    while (Date.now() < until) {
      try {
        doc = JSON.parse(readFileSync(file, "utf8"));
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    assert.ok(doc, "the save landed a file that parses");
    assert.equal(doc.jobs.length, KEEP_JOBS, `the file is bounded by the count (${KEEP_JOBS} jobs), not by a byte cap`);
    assert.equal(doc.jobs[0].id, "j-99", "the newest conversation is first");
    assert.equal(store.jobs.size, 100, "the bound trims the file only: the live map keeps every card");
    assert.deepEqual(readdirSync(dir), ["jobs.json"], "the save left no temp file beside the store");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
