// The tree list the panel had at its last successful scan (lib/tree-cache.js), on its own: no HTTP, no scheduler, no
// page.
//
// What this file pins is the half a boot depends on. The file holds ONE entry per tree with the path, branch, project,
// parent branch, the sha it was read at and when it was read; it is read back into the store as a PLACEHOLDER row with
// the same key the scan will write, so the replacement is in place; a row whose read FAILED, whose path is not a tree
// any more, or which is already known to be gone is never written; and the file is capped both by age and by count, so
// a long-dead tree does not live there forever.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Store } from "../lib/store.js";
import {
  TREE_CACHE_MAX_AGE_MS,
  TREE_CACHE_MAX_TREES,
  TREE_CACHE_STALE_KEEP_MS,
  TreeCache,
  entryFromRow,
  readTreeCache,
  reconcileCached,
  treeCacheKey,
  writeTreeCache,
} from "../lib/tree-cache.js";

const PROJECT = "demo";
const MAIN = "main";

function tmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wag-tree-cache-"));
  return { dir, file: path.join(dir, "tree-cache.json") };
}

function storeWith(rows = []) {
  const store = new Store();
  store.ensureProject({ name: PROJECT, path: "C:/repos/demo", mainBranch: MAIN, remote: "github" });
  for (const r of rows) store.putRow(PROJECT, { dirty: 0, untracked: 0, ...r }, "full");
  return store;
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

test("one row is written with its path, branch, project, parent branch, the sha it was read at and when", () => {
  const { file, dir } = tmp();
  try {
    const store = storeWith([
      { path: "C:/repos/demo/.worktrees/a-111111", name: "a-111111", branch: "wtgui/a-111111", parent: "wtgui/turnover", head: "abc1234", verdict: "UNMERGED (2 commits)" },
    ]);
    const cache = new TreeCache({ file });
    const out = cache.writeFrom(store);
    assert.equal(out.written, 1);
    const doc = readJson(file);
    assert.equal(doc.version, 1);
    assert.equal(doc.trees.length, 1);
    const entry = doc.trees[0];
    assert.equal(entry.path, "C:/repos/demo/.worktrees/a-111111");
    assert.equal(entry.branch, "wtgui/a-111111");
    assert.equal(entry.project, PROJECT);
    assert.equal(entry.parentBranch, "wtgui/turnover");
    assert.equal(entry.sha, "abc1234");
    assert.ok(Number.isFinite(Date.parse(entry.readAt)), "readAt is an ISO time");
    // The file says what it is, so a later reader does not mistake it for current state.
    assert.match(String(doc.note), /last read successfully/);
    // `at` is the newest entry's readAt, never the write time.
    assert.equal(doc.at, entry.readAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the file is read back as a placeholder row with the same key, the same branch and no verdict of its own", () => {
  const { file, dir } = tmp();
  try {
    const store = storeWith([
      { path: "C:/repos/demo", name: "demo", branch: MAIN, head: "1111111", verdict: "ON MAIN", parent: null },
      { path: "C:/repos/demo/.worktrees/a-111111", name: "a-111111", branch: "wtgui/a-111111", parent: MAIN, head: "abc1234", verdict: "UNMERGED (2 commits)" },
    ]);
    new TreeCache({ file }).writeFrom(store);

    // A boot: a fresh store, the cache read, the entries seeded.
    const cache = new TreeCache({ file });
    const loaded = cache.read();
    assert.equal(loaded.trees.length, 2);
    assert.ok(loaded.at, "the load reports when the list was read");

    const booted = new Store();
    for (const p of loaded.projects) booted.ensureProject(p);
    for (const t of loaded.trees) booted.seedCached(t);

    const rows = booted.rowsFor(PROJECT);
    assert.equal(rows.length, 2);
    const tree = rows.find((r) => r.path.endsWith("a-111111"));
    assert.ok(tree, "the cached tree is a row");
    assert.equal(booted.rowKey(PROJECT, tree.path), treeCacheKey(PROJECT, tree.path), "the cached row has the key the scan will write");
    assert.equal(tree.branch, "wtgui/a-111111");
    assert.equal(tree.head, "abc1234");
    assert.equal(tree.parent, MAIN);
    assert.equal(tree.cached, true, "the row says it is from the cache");
    assert.equal(tree.cachedAt, loaded.trees.find((t) => t.path.endsWith("a-111111")).readAt);
    // A cached row has NOT been read in this process: claiming a verdict from a week-old list is the guess the board
    // exists to avoid.
    assert.equal(tree.verdict, "…");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the first fresh read of a cached path clears the flag in the same put, so the replacement is in place", () => {
  const store = new Store();
  store.ensureProject({ name: PROJECT, path: "C:/repos/demo", mainBranch: MAIN });
  store.seedCached({ project: PROJECT, path: "C:/repos/demo/.worktrees/a-111111", name: "a-111111", branch: "wtgui/a", head: "abc1234", readAt: "2026-11-19T09:00:00.000Z" });
  const key = store.rowKey(PROJECT, "C:/repos/demo/.worktrees/a-111111");
  assert.equal(store.rows.get(key).cached, true);
  const fresh = store.putRow(PROJECT, { path: "C:/repos/demo/.worktrees/a-111111", name: "a-111111", branch: "wtgui/a", head: "def5678", verdict: "MERGED", dirty: 0, untracked: 0 }, "full");
  assert.equal(fresh.cached, false);
  assert.equal(fresh.cachedAt, null);
  assert.equal(fresh.head, "def5678");
  assert.equal(store.rows.size, 1, "one row, not two: the identity is the key");
});

test("a row whose read failed, whose path is not a tree, or which is known gone is not written", () => {
  assert.equal(entryFromRow(PROJECT, { path: "C:/x", error: "fatal: not a git repository" }), null);
  assert.equal(entryFromRow(PROJECT, { path: "C:/x", verdict: "RELEASED" }), null);
  assert.equal(entryFromRow(PROJECT, { path: "C:/x", stale: { reason: "gone" } }), null);
  assert.equal(entryFromRow(PROJECT, { path: "" }), null);
  // ...and a stale row already on disk is dropped by the write, because the write is derived from the store's rows.
  const { file, dir } = tmp();
  try {
    const store = storeWith([{ path: "C:/repos/demo/.worktrees/a-111111", branch: "wtgui/a", verdict: "MERGED" }]);
    new TreeCache({ file }).writeFrom(store);
    assert.equal(readTreeCache(file).trees.length, 1);
    store.markStale(PROJECT, "C:/repos/demo/.worktrees/a-111111", { reason: "the folder is gone from disk" });
    new TreeCache({ file }).writeFrom(store);
    assert.equal(readTreeCache(file).trees.length, 0, "a row the scan withdrew is not preserved as a claim");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an entry older than the age cap is dropped on read, and the file is capped by count", () => {
  const { file, dir } = tmp();
  try {
    const old = new Date(Date.now() - TREE_CACHE_MAX_AGE_MS - 60_000).toISOString();
    const fresh = new Date().toISOString();
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        at: fresh,
        trees: [
          { path: "C:/repos/demo/.worktrees/old-000000", branch: "wtgui/old", project: PROJECT, readAt: old },
          ...Array.from({ length: 5 }, (_, i) => ({
            path: `C:/repos/demo/.worktrees/n-${i}`,
            branch: `wtgui/n-${i}`,
            project: PROJECT,
            readAt: new Date(Date.now() - i * 60_000).toISOString(),
          })),
        ],
        projects: [{ name: PROJECT, path: "C:/repos/demo", mainBranch: MAIN }],
      }),
    );
    const aged = readTreeCache(file);
    assert.equal(aged.trees.some((t) => t.path.endsWith("old-000000")), false, "a week-old tree is not served");
    assert.equal(aged.dropped.aged, 1);
    const capped = readTreeCache(file, { maxTrees: 2 });
    assert.equal(capped.trees.length, 2);
    assert.equal(capped.dropped.capped, 3);
    // Newest first: the one read a minute ago before the one read three minutes ago.
    assert.equal(capped.trees[0].path.endsWith("n-0"), true);
    assert.ok(TREE_CACHE_MAX_TREES >= 100, "the default cap is a board, not a handful");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file that does not parse is a null read with a line, never a boot failure", () => {
  const { file, dir } = tmp();
  try {
    writeFileSync(file, "{not json");
    const lines = [];
    assert.equal(readTreeCache(file, { log: (l) => lines.push(l) }), null);
    assert.match(String(lines[0]), /could not read/);
    // A missing file is the normal first run.
    assert.equal(readTreeCache(path.join(dir, "nope.json")), null);
    // A file from a newer panel is refused whole rather than half-read.
    writeFileSync(file, JSON.stringify({ version: 99, trees: [{ path: "C:/x", project: PROJECT, readAt: new Date().toISOString() }] }));
    assert.equal(readTreeCache(file), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a boot that seeds from the file does not stamp a read that did not happen", () => {
  const { file, dir } = tmp();
  try {
    const readAt = "2026-11-19T09:00:00.000Z";
    writeFileSync(file, JSON.stringify({ version: 1, at: readAt, trees: [{ path: "C:/repos/demo/.worktrees/a-111111", project: PROJECT, branch: "wtgui/a", readAt }], projects: [{ name: PROJECT, path: "C:/repos/demo", mainBranch: MAIN }] }));
    const store = new Store();
    const cache = new TreeCache({ file });
    for (const p of cache.read().projects) store.ensureProject(p);
    for (const t of cache.read().trees) store.seedCached(t);
    cache.flush(store);
    const doc = readJson(file);
    assert.equal(doc.at, readAt, "the list is still the one read at 09:00");
    assert.equal(doc.trees[0].readAt, readAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the write is atomic: no .tmp file is left beside it", () => {
  const { file, dir } = tmp();
  try {
    const store = storeWith([{ path: "C:/repos/demo/.worktrees/a-111111", branch: "wtgui/a", verdict: "MERGED" }]);
    new TreeCache({ file }).writeFrom(store);
    assert.equal(existsSync(file), true);
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes(".tmp")), [], "no temp file lingers");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the reconciliation classifies kept, gone and new rows by the store's own key", () => {
  const cached = [
    { project: PROJECT, path: "C:/repos/demo/.worktrees/kept-111111" },
    { project: PROJECT, path: "C:/repos/demo/.worktrees/gone-222222" },
  ];
  const fresh = [
    { project: PROJECT, path: "C:/repos/demo/.worktrees/KEPT-111111/" },
    { project: PROJECT, path: "C:/repos/demo/.worktrees/new-333333" },
  ];
  const { kept, gone, added } = reconcileCached({ cached, fresh });
  // The reconciliation key is spelling-blind on purpose (a file can be hand-edited, a listing can answer in another
  // case), so it is the lowercased pair; the ROW's own key is the store's exact one, which is what `kept.fresh` carries.
  assert.deepEqual(kept.map((k) => k.key), [treeCacheKey(PROJECT, "C:/repos/demo/.worktrees/kept-111111").toLowerCase()]);
  assert.deepEqual(gone.map((g) => g.cached.path), ["C:/repos/demo/.worktrees/gone-222222"]);
  assert.deepEqual(added.map((a) => a.fresh.path), ["C:/repos/demo/.worktrees/new-333333"]);
  // The KEPT's fresh half is the row that replaces it: same key, so the page's placeRow swaps it in place.
  assert.equal(kept[0].fresh.path, fresh[0].path);
  // Spelling and a trailing separator do not make a second row.
  assert.equal(kept.length + gone.length, 2);
  assert.equal(reconcileCached({ cached: [], fresh: [] }).kept.length, 0);
});

test("the stale keep window is a day, so a dead tree does not live on the board forever", () => {
  assert.equal(TREE_CACHE_STALE_KEEP_MS, 24 * 60 * 60 * 1000);
});
