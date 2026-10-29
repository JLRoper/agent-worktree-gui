// The board's branch and PR cells, proved where the reader reads them: the row the store holds.
//
// This file exists because the checkpoint's PR cell was silently broken in a way no pure-module test could see. Every
// piece agreed in isolation — `prIndex` built a map of ten PRs, `prFor` found #10 for the branch, the template rendered
// a Bitbucket page — and the cell was still empty, because `Scheduler.decorate` called `linkFor` without importing it.
// The throw landed after `row.pr` was computed and before the row was written, so the store kept the PREVIOUS row (no
// `pr` at all) and `/api/state` showed nothing for exactly the rows that had a PR. The tests below drive the real
// Scheduler method against the real Store and read the row back out of `store.snapshot()`, which is the object
// `/api/state` serialises, so a missing import or a document/object mix-up fails here instead of on the board.
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SEED_FILE, Hosts, linkFor, readHostsFile } from "../lib/hosts.js";
import { buildPrIndex } from "../lib/project.js";
import { Scheduler } from "../lib/scheduler.js";
import { Store } from "../lib/store.js";

const seed = readHostsFile(DEFAULT_SEED_FILE);

// A scheduler with no timers and no git: `decorate` is the only method these cases call, and it reads the store and
// the host mapping and nothing else.
function schedulerFor(hosts) {
  const store = new Store();
  const scheduler = new Scheduler({
    config: { projects: [] },
    store,
    pool: { isBusy: () => false },
    getProjects: () => [],
    hosts,
  });
  return { scheduler, store };
}

// The shape of a row as the scan hands it to decorate: branch, tip, and no PR yet.
const rowFor = (branch, head) => ({
  path: `C:/ProjectDevelopment/email-multi/.worktrees/${branch.replace(/[^\w-]+/g, "-")}`,
  name: branch,
  branch,
  head,
  verdict: "UNMERGED (3 commits)",
  untracked: 0,
  dirty: 0,
});

// The ten PRs git.sefl.com actually returns for IT/email-multi (state=ALL, limit=100), trimmed to the fields
// normalisePr keeps. Read from the live REST call on 2026-10-27; the ids and head refs are the record, not a fixture
// invented to make a number come out.
const LIVE_PRS = [
  { number: 10, state: "OPEN", mergedAt: null, headRefName: "20261023_1724_DMR-44452_internalFrom", headRefOid: "d55e04dd41b0b9aa6f1e5a2f4a5e0b1c9d3a7f21", title: "Java Code Review for email-multi 20261023_1724_DMR" },
  { number: 9, state: "OPEN", mergedAt: null, headRefName: "20261023_1120_DMR-41419_sefreightBizParity", headRefOid: "20b656a0c3f4b7bb1b4d2e1f0a9c8d7e6f5a4b3c", title: "Java Code Review for email-multi 20261023_1120_DMR" },
  { number: 8, state: "MERGED", mergedAt: "2026-10-26T13:52:00.000Z", headRefName: "20261001_1605_DMR-43982_queMonitorK8s", headRefOid: "fe5002f0a1b2c3d4e5f60718293a4b5c6d7e8f90", title: "Java Code Review for email-multi 20261001_1605_DMR" },
];

const PROJECT = { name: "email-multi", path: "C:/ProjectDevelopment/email-multi", remote: "origin", mainBranch: "master" };

test("decorate writes the PR and its Bitbucket page onto the row, and the store keeps both", async () => {
  // The Hosts OBJECT, exactly as server.js hands it to the scheduler — not a plain document. This is the call shape
  // that was silently wrong: a caller passing the object where a document was expected resolved "no host mapping" for
  // a project that is mapped, and the cell went plain text.
  const hosts = new Hosts({ file: null, seedFile: DEFAULT_SEED_FILE });
  const { scheduler, store } = schedulerFor(hosts);
  const row = rowFor("20261023_1724_DMR-44452_internalFrom", "d55e04d");

  await scheduler.decorate(PROJECT, row, new Set([row.branch]), buildPrIndex(LIVE_PRS));

  // The row's own value first…
  assert.equal(row.pr?.number, 10);
  assert.equal(row.pr.state, "OPEN");
  assert.equal(row.pr.matched, "ref");
  assert.equal(row.prUrl, "https://git.sefl.com/projects/IT/repos/email-multi/pull-requests/10");
  assert.equal(row.prWhy, "");
  assert.equal(row.branchUrl, "https://git.sefl.com/projects/IT/repos/email-multi/browse?at=refs/heads/20261023_1724_DMR-44452_internalFrom");

  // …then the same row as `/api/state` reads it, which is what the missing import used to destroy: the throw came
  // after `row.pr` was set, so the store kept the pre-scan row and the board showed no PR at all.
  store.patchProject(PROJECT.name, { path: PROJECT.path, remote: PROJECT.remote, mainBranch: PROJECT.mainBranch });
  store.putRow(PROJECT.name, row, "full");
  const stored = store.snapshot().projects.find((p) => p.name === PROJECT.name).worktrees.find((w) => w.branch === row.branch);
  assert.equal(stored.pr?.number, 10);
  assert.equal(stored.prUrl, "https://git.sefl.com/projects/IT/repos/email-multi/pull-requests/10");
});

test("a branch with no PR reads none, and its neighbours' PRs are not lent to it", async () => {
  const hosts = new Hosts({ file: null, seedFile: DEFAULT_SEED_FILE });
  const { scheduler } = schedulerFor(hosts);
  const index = buildPrIndex(LIVE_PRS);
  const withPr = rowFor("20261023_1120_DMR-41419_sefreightBizParity", "20b656a");
  const without = rowFor("20260928_confluence-doc-sync", "86c852b");
  const heads = new Set([withPr.branch, without.branch]);

  await scheduler.decorate(PROJECT, withPr, heads, index);
  await scheduler.decorate(PROJECT, without, heads, index);

  assert.equal(withPr.pr?.number, 9);
  assert.equal(without.pr, null);
  assert.equal(without.prUrl, null);
  // The branch cell is still a link for a branch the remote has, PR or no PR.
  assert.match(without.branchUrl, /browse\?at=refs\/heads\/20260928_confluence-doc-sync$/);
});

test("an unmapped project keeps the PR number and drops the page, saying why", async () => {
  const hosts = new Hosts({ file: null, seedFile: DEFAULT_SEED_FILE });
  const { scheduler } = schedulerFor(hosts);
  const project = { ...PROJECT, name: "email-handler-openvms" };
  const row = rowFor("20261023_1724_DMR-44452_internalFrom", "d55e04d");

  await scheduler.decorate(project, row, new Set([row.branch]), buildPrIndex(LIVE_PRS));

  // A PR number with no page to open is still useful; a guessed page is not.
  assert.equal(row.pr?.number, 10);
  assert.equal(row.prUrl, null);
  assert.match(row.prWhy, /no host mapping/);
  assert.equal(row.branchUrl, null);
});

// ---- the branch cell's `local` chip, and the link following a branch that moved ----------------------------------
// The chip is one word claiming this branch exists only on this box. It is drawn from `branchLocalOnly`, so the
// three states of the remote's answer have to be three different rows: listed, not listed, and not answered. A page
// that read "unknown" as local is the bug this pins.
test("decorate's chip claim is the remote's own head list: listed, not listed, and not answered are three rows", async () => {
  const hosts = new Hosts({ file: null, seedFile: DEFAULT_SEED_FILE });
  const { scheduler, store } = schedulerFor(hosts);
  const index = buildPrIndex(LIVE_PRS);
  const row = rowFor("20261023_1724_DMR-44452_internalFrom", "d55e04d");
  const twice = () => ({ ...row });

  // 1. The remote lists the branch: a page to open, and no chip.
  const listed = twice();
  await scheduler.decorate(PROJECT, listed, new Set([row.branch]), index);
  assert.equal(listed.remoteBranch, "exists");
  assert.equal(listed.branchLocalOnly, false);
  assert.equal(listed.branchChip, null, "a linked branch says nothing more");
  assert.match(listed.branchUrl, /browse\?at=refs\/heads\/20261023_1724_DMR-44452_internalFrom$/);

  // 2. The remote answered, and the branch is not in its head list: plain text, the reason, and the chip.
  const absent = twice();
  await scheduler.decorate(PROJECT, absent, new Set(["20260928_confluence-doc-sync"]), index);
  assert.equal(absent.remoteBranch, "gone");
  assert.equal(absent.branchLocalOnly, true, "the one state that may carry the word");
  assert.equal(absent.branchChip, "local");
  assert.equal(absent.branchUrl, null);
  assert.match(absent.branchWhy, /^local only/);

  // 3. The remote could not be reached (`ls-remote` returned nothing): the panel cannot tell, so it says so in a
  // word of its own — and the sentence carries the project's own fetch note, which is the only place the reason lives.
  const note = "fetch failed: Could not resolve host: github.com";
  store.patchProject(PROJECT.name, { fetchNote: note });
  const unreachable = twice();
  await scheduler.decorate(PROJECT, unreachable, new Set(), index);
  assert.equal(unreachable.remoteBranch, "unknown");
  assert.equal(unreachable.branchLocalOnly, false);
  assert.equal(unreachable.branchChip, "unverified", "the row is marked, but not with the remote's denial");
  assert.equal(unreachable.branchUrl, null);
  assert.match(unreachable.branchWhy, /^cannot tell/);
  assert.ok(unreachable.branchWhy.includes(note), `the sentence quotes the fetch note: ${unreachable.branchWhy}`);

  // …and the last fetch's refs never upgrade that to the `local` word, whichever way they point: stale refs are not
  // the remote's answer, so `local` stays off and the title says the remote itself was not asked.
  const offlineHas = twice();
  await scheduler.decorate(PROJECT, offlineHas, new Set(), index, null, new Set([row.branch]));
  assert.equal(offlineHas.branchLocalOnly, false);
  assert.equal(offlineHas.branchChip, null, "a page from the last fetch's refs is already the at-a-glance answer");
  assert.equal(offlineHas.branchLinkFrom, "local-refs");
  assert.match(offlineHas.branchUrl, /browse\?at=refs\/heads\/20261023_1724_DMR-44452_internalFrom$/);
  const offlineHasnt = twice();
  await scheduler.decorate(PROJECT, offlineHasnt, new Set(), index, null, new Set());
  assert.equal(offlineHasnt.branchLocalOnly, false);
  assert.equal(offlineHasnt.branchChip, "unverified", "no ref and no remote answer: the panel says it could not tell");
  assert.equal(offlineHasnt.branchUrl, null);
  assert.match(offlineHasnt.branchWhy, /^not on the remote as of the last fetch — /, "the stale-refs answer is not phrased as the remote's own");
  assert.doesNotMatch(offlineHasnt.branchWhy, /^local only/, "…and it does not open with the claim the remote refused to make");
  assert.match(offlineHasnt.branchWhy, /the remote itself was not asked/);
  assert.ok(offlineHasnt.branchWhy.includes(note), "…and it quotes the fetch note for why the remote was not asked");

  // 4. A project with no remote: every branch is local by construction, and the cell says so instead of marking rows.
  const noRemote = twice();
  await scheduler.decorate({ ...PROJECT, remote: null }, noRemote, new Set(), index);
  assert.equal(noRemote.remoteBranch, "n/a");
  assert.equal(noRemote.branchChip, null, "no remote is not a claim about one");
  assert.equal(noRemote.branchLocalOnly, false);
  assert.equal(noRemote.branchWhy, "no remote configured");
});

// A branch switched INSIDE one tree (or renamed by the panel) is a different branch, so the link and the PR that
// were computed from the old name are claims about a branch this tree is not on. server.js re-reads a renamed tree
// with exactly this call — `scanOne(project, path, "full")`, no heads and no PRs in hand — and it used to come back
// with the old branch's page still attached.
test("a row whose branch moved is decorated again: the link is the new branch's, not the one it left", async () => {
  const hosts = new Hosts({ file: null, seedFile: DEFAULT_SEED_FILE });
  const { scheduler, store } = schedulerFor(hosts);
  store.patchProject(PROJECT.name, { path: PROJECT.path, remote: PROJECT.remote, mainBranch: PROJECT.mainBranch });

  const TREE = "C:/ProjectDevelopment/email-multi/.worktrees/follow-up-1a2b3c";
  const oldBranch = "20261023_1724_DMR-44452_internalFrom";
  const newBranch = "wtgui/follow-up-1a2b3c";

  // What the store holds before the move: the old branch, its page, and #10 as its PR.
  const before = { ...rowFor(oldBranch, "d55e04d"), path: TREE };
  await scheduler.decorate(PROJECT, before, new Set([oldBranch]), buildPrIndex(LIVE_PRS));
  store.putRow(PROJECT.name, before, "full");
  assert.equal(store.rowsFor(PROJECT.name)[0].pr?.number, 10);
  assert.match(store.rowsFor(PROJECT.name)[0].branchUrl, /20261023_1724_DMR-44452_internalFrom$/);

  // The same directory, now on a follow-up branch cut off main — the panel's own rename path, or a `git checkout -b`
  // in the tree. Nothing is handed in but the row the scan read.
  scheduler.pool.run = async ({ wtPath }) => ({
    path: wtPath,
    name: "follow-up-1a2b3c",
    branch: newBranch,
    head: "9f8e7d6",
    verdict: "UNMERGED (1 commit)",
    untracked: 0,
    dirty: 0,
  });
  // Liveness is not what this case is about, and the session stores are the reader's own: stubbed, never read.
  scheduler.sessionRoots = async () => new Map();
  scheduler.claudeRoots = async () => new Map();
  let reads = 0;
  scheduler.remoteAnswers = async () => {
    reads += 1;
    return {
      heads: new Set([newBranch]),
      prs: buildPrIndex([{ number: 12, state: "OPEN", mergedAt: null, headRefName: newBranch, headRefOid: "9f8e7d6abcd", title: "the follow-up" }]),
      upstreams: new Map(),
      remoteRefs: null,
    };
  };

  const after = await scheduler.scanOne(PROJECT, TREE, "full");

  assert.equal(reads, 1, "the remote's answers were read for the branch the tree is on now");
  assert.equal(after.branch, newBranch);
  assert.match(after.branchUrl, /follow-up-1a2b3c$/);
  assert.doesNotMatch(after.branchUrl, /internalFrom/, "the cell is not the page of the branch this tree left");
  assert.equal(after.branchLocalOnly, false);
  assert.equal(after.pr?.number, 12, "the PR cell follows the branch too — it does not keep the old branch's #10");

  // …and a read that finds the SAME branch asks the remote for nothing: the answers only move when the branch does.
  let spent = 0;
  scheduler.remoteAnswers = async () => {
    spent += 1;
    throw new Error("a row whose branch did not move must not re-read the remote");
  };
  const same = await scheduler.scanOne(PROJECT, TREE, "fast");
  assert.equal(spent, 0);
  assert.equal(same.remoteBranch, "exists", "the row keeps the answer it already had");
  assert.match(same.branchUrl, /follow-up-1a2b3c$/);
});

test("the cell's link is the template's, not a shape written in the scheduler", () => {
  // GitHub and Bitbucket come out of the same call with different URLs: nothing in lib/scheduler.js names either host.
  assert.ok(seed.hosts.github.links.pull.includes("/pull/{pr}"));
  assert.ok(seed.hosts["sefl-bitbucket"].links.pull.includes("/pull-requests/{pr}"));
  assert.equal(
    linkFor(seed, { name: "agent-worktree-gui", mainBranch: "main" }, "pull", { pr: 71 }).url,
    "https://github.com/JLRoper/agent-worktree-gui/pull/71",
  );
  assert.equal(
    linkFor(seed, { name: "email-multi", mainBranch: "master" }, "pull", { pr: 10 }).url,
    "https://git.sefl.com/projects/IT/repos/email-multi/pull-requests/10",
  );
});
