// A boot pass exists to open the board, and it used to open it only after the network answered: `ls-remote` and
// the PR index were awaited before a single row was read, so a host in backoff held whole projects for 30-38s
// (measured on the reader's panel 2026-11-22: optym-transmission-multi remote 33.2s with rows 43.3s behind it).
// These cases drive the real `fullPassProject` against the real Store and pin the three claims the change makes:
//
//   1. a boot reads its rows BEFORE the remote answers arrive, and at "fast" depth;
//   2. the answers still reach the rows - as a decoration, once they land;
//   3. a pass that is not a boot keeps its old contract (full depth, answers in hand, decorated in the pass).
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_SEED_FILE, Hosts } from "../lib/hosts.js";
import { buildPrIndex } from "../lib/project.js";
import { Scheduler } from "../lib/scheduler.js";
import { Store } from "../lib/store.js";

// Paths are built at run time, never written as drive-letter literals: tools/absolute-paths.mjs refuses a path that
// exists on exactly one machine, and this file is part of the repository's own tree (the gate caught the literals
// this file first shipped with).
const ROOT = mkdtempSync(path.join(tmpdir(), "wag-boot-rows-")).replace(/\\/g, "/");
const TREE = `${ROOT}/a-probe-row-abc123`;
const BRANCH = "wtgui/a-probe-row-abc123";
const PROJECT = {
  name: "agent-worktree-gui",
  path: ROOT,
  remote: "origin",
  mainBranch: "main",
  tier: "recent",
};

// A scheduler whose git is a stub and whose remote answers the test holds open: the only thing under test is the
// ORDER a boot reads and decorates in, so every spawn-heavy read is answered by a function here.
function harness({ answers }) {
  const store = new Store();
  const depths = [];
  const scheduler = new Scheduler({
    config: { projects: [PROJECT], scanMode: "visible" },
    store,
    pool: {
      isBusy: () => false,
      meta: async () => ({ meta: { remoteRef: "origin/main", hasRemote: true, remoteTip: "d55e04d" }, trees: null }),
      run: async ({ wtPath, depth }) => {
        depths.push(depth);
        return { path: wtPath, name: "a-probe-row", branch: BRANCH, head: "d55e04d", ahead: 1, behind: 0, dirty: 0, untracked: 0 };
      },
    },
    getProjects: () => [PROJECT],
    hosts: new Hosts({ file: null, seedFile: DEFAULT_SEED_FILE }),
  });
  // The board summary reads the checkout's `.agentboard` and a whole process table; the reconcile spawns
  // `git worktree list`. Neither is part of this question, and neither may touch a real repository in a test.
  scheduler.reconcile = async () => ({ ok: true, listed: 0 });
  scheduler.sessionRoots = async () => new Map();
  scheduler.claudeRoots = async () => new Map();
  scheduler.remoteAnswers = () => answers();
  // One row, as the tree cache would have seeded it before the boot read it.
  store.patchProject(PROJECT.name, { path: PROJECT.path, remote: PROJECT.remote, mainBranch: PROJECT.mainBranch });
  store.seedCached({ project: PROJECT.name, path: TREE, name: "a-probe-row", branch: BRANCH, sha: "d55e04d" });
  return { scheduler, store, depths };
}

const rowNow = (store) => store.rowsFor(PROJECT.name).find((r) => r.path === TREE);

test("a boot reads its rows before the remote answers arrive, at fast depth", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = () => resolve({ heads: new Set([BRANCH]), prs: buildPrIndex([]), upstreams: new Map(), remoteRefs: null });
  });
  const { scheduler, store, depths } = harness({ answers: () => gate });

  // The pass must return with the answers still pending: that is the whole claim. A boot that awaited them would
  // hang here until the gate opened.
  await scheduler.fullPassProject(PROJECT, { boot: true, rows: false, fetch: false });

  assert.deepEqual(depths, ["fast"], "a boot reads a row at fast depth, not full");
  const read = rowNow(store);
  assert.ok(read, "the row is on the board with the answers still in flight");
  assert.equal(read.branch, BRANCH);
  assert.equal(read.remoteBranch, undefined, "nothing has decorated it yet");
  assert.equal(read.branchUrl, undefined);

  // …and when the answers land they reach the same row.
  release();
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
  const decorated = rowNow(store);
  assert.equal(decorated.remoteBranch, "exists", "the remote's head list reached the row after the read");
  assert.match(decorated.branchUrl, /a-probe-row-abc123$/, "the branch cell got its link late, not never");
});

test("the late decoration keeps the row's read time and does not resurrect a dropped tree", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = () => resolve({ heads: new Set([BRANCH]), prs: buildPrIndex([]), upstreams: new Map(), remoteRefs: null });
  });
  const { scheduler, store } = harness({ answers: () => gate });

  await scheduler.fullPassProject(PROJECT, { boot: true, rows: false, fetch: false });
  const before = rowNow(store).scannedAt;
  assert.ok(before, "the read stamped the row");

  // The tree is dropped while the answers are still in flight (the ✕, or a merge agent's `git worktree remove`).
  store.dropRow(PROJECT.name, TREE);
  release();
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));

  assert.equal(rowNow(store), undefined, "a decoration must not put a dropped row back on the board");

  // …and on a row that IS still there, the decoration does not move `scannedAt`: the row was not read again.
  const { scheduler: s2, store: store2 } = harness({ answers: async () => ({ heads: new Set([BRANCH]), prs: buildPrIndex([]), upstreams: new Map(), remoteRefs: null }) });
  await s2.fullPassProject(PROJECT, { boot: true, rows: false, fetch: false });
  const readAt = rowNow(store2).scannedAt;
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
  const after = rowNow(store2);
  assert.equal(after.remoteBranch, "exists", "decorated");
  assert.equal(after.scannedAt, readAt, "the read time is still the read's, not the decoration's");
});

test("a pass that is not a boot keeps full depth and decorates in the pass", async () => {
  let answered = 0;
  const { scheduler, store, depths } = harness({
    answers: async () => {
      answered += 1;
      return { heads: new Set([BRANCH]), prs: buildPrIndex([]), upstreams: new Map(), remoteRefs: null };
    },
  });

  await scheduler.fullPassProject(PROJECT, { boot: false, rows: true, fetch: false });

  assert.deepEqual(depths, ["full"], "a periodic pass still reads at full depth");
  assert.equal(answered, 1);
  const row = rowNow(store);
  assert.equal(row.remoteBranch, "exists", "the answers were in hand when the row was written");
  assert.match(row.branchUrl, /a-probe-row-abc123$/);
});

test("redecorate emits a row event, keeps scannedAt, and creates nothing", () => {
  const store = new Store();
  const row = { path: TREE, branch: BRANCH, head: "d55e04d", verdict: "…", dirty: 0, untracked: 0 };
  store.putRow(PROJECT.name, row, "fast");
  const scannedAt = rowNow(store).scannedAt;

  const events = [];
  store.onEvent((e) => events.push(e));
  const next = { ...rowNow(store), remoteBranch: "exists", branchUrl: "https://github.com/JLRoper/agent-worktree-gui/browse?at=refs/heads/x" };
  const stored = store.redecorate(PROJECT.name, next);

  assert.equal(stored.remoteBranch, "exists");
  assert.equal(stored.scannedAt, scannedAt, "a decoration is not a read");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "row");
  assert.equal(events[0].row.branchUrl, next.branchUrl);

  // A row the store does not hold is a dropped tree: it stays dropped.
  assert.equal(store.redecorate("no-such-project", next), null);
  assert.equal(store.redecorate(PROJECT.name, { ...next, path: path.join(mkdtempSync(path.join(tmpdir(), "wag-")), "gone") }), null);
});
