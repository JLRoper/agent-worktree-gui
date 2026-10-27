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
