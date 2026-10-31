// The RELEASE marker, its grammar, and the request store behind it.
//
// What is proved here is the half that runs as a run ends: a marker line is read out of a settled turn's FINAL
// message, resolved to exactly one tree the panel knows, and written down against that tree — and a marker that cannot
// be read is said OUT LOUD rather than dropped. Nothing in this file touches git, because nothing in this half does:
// the gates and the removal are test/worktree-release.test.js.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReleaseRequests, parseReleaseLines, resolveTreeTarget } from "../lib/worktrees.js";
import { slash } from "../tools/panel-testkit.mjs";

// A tree list shaped the way server.js's `panelTrees()` hands one over: the row's project, its forward-slashed path
// and its branch.
const TREES = [
  { project: "wtgui", path: "C:/ProjectDevelopment/agent-worktree-gui/.worktrees/implement-worktree-relea-944e03", branch: "wtgui/implement-worktree-relea-944e03" },
  { project: "wtgui", path: "C:/ProjectDevelopment/agent-worktree-gui/.worktrees/paint-the-board-1a2b3c", branch: "wtgui/paint-the-board-1a2b3c" },
  { project: "heroes-js", path: "C:/ProjectDevelopment/heroes-js/.worktrees/que-monitor-k8s", branch: "wtgui/que-monitor-k8s" },
];

async function storeOnDisk(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-release-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const file = path.join(dir, "releases.json");
  return { dir, file, store: new ReleaseRequests({ file, trees: () => TREES }) };
}

test("the marker: a path and a reason, split on the first pipe only", () => {
  const [one] = parseReleaseLines("RELEASE C:/work/.worktrees/tree-1a2b3c | the PR landed and the tests pass");
  assert.equal(one.error, null);
  assert.equal(one.target, "C:/work/.worktrees/tree-1a2b3c");
  assert.equal(one.why, "the PR landed and the tests pass");

  // A reason may contain a pipe: only the FIRST one separates the two fields.
  const [two] = parseReleaseLines("RELEASE tree-1a2b3c | landed | merged by the reader");
  assert.equal(two.error, null);
  assert.equal(two.target, "tree-1a2b3c");
  assert.equal(two.why, "landed | merged by the reader");

  // The pipe separator, not a colon: a Windows path carries a colon of its own.
  assert.equal(parseReleaseLines("RELEASE C:\\proj\\.worktrees\\x-1a2b3c | done")[0].error, null);
});

test("the marker: a quoted path with spaces, and case-insensitive spelling", () => {
  const [q] = parseReleaseLines('release "C:/My Projects/p/.worktrees/tree-1a2b3c" | finished');
  assert.equal(q.error, null);
  assert.equal(q.target, "C:/My Projects/p/.worktrees/tree-1a2b3c");
  assert.equal(q.why, "finished");
});

test("the marker: every unreadable shape is a sentence, not silence", () => {
  const cases = [
    ["RELEASE", /needs a worktree and/],
    ["RELEASE tree-1a2b3c", /needs `\| <why it is finished>`/],
    ["RELEASE | no target", /needs a worktree and|names no worktree/],
    ["RELEASE tree-1a2b3c |", /names no reason/],
    ["RELEASE tree-1a2b3c |   ", /names no reason/],
  ];
  for (const [line, expected] of cases) {
    const [mark] = parseReleaseLines(line);
    assert.ok(mark, `${line} must still be reported`);
    assert.ok(mark.error, `${line} must carry an error`);
    assert.match(mark.error, expected, `${line} -> ${mark.error}`);
    assert.equal(mark.target, null);
  }
});

test("the marker: prose that merely mentions the word is not a marker, and only whole lines count", () => {
  assert.deepEqual(parseReleaseLines("we should RELEASE the worktree eventually"), []);
  assert.deepEqual(parseReleaseLines("The release of the tree is pending."), []);
  // Two markers in one message are two requests; an INDENTED one still counts, because agents indent prose.
  const marks = parseReleaseLines("  RELEASE tree-1a2b3c | one\n\n  RELEASE other-4d5e6f | two");
  assert.equal(marks.length, 2);
  assert.deepEqual(marks.map((m) => m.target), ["tree-1a2b3c", "other-4d5e6f"]);
});

test("a target resolves by path, path suffix, directory name, branch or tag — and ambiguity resolves to nothing", () => {
  const byExact = resolveTreeTarget("C:/ProjectDevelopment/agent-worktree-gui/.worktrees/paint-the-board-1a2b3c", TREES);
  assert.equal(byExact.path, TREES[1].path);
  // The suffix form an agent actually writes from inside the repo.
  assert.equal(resolveTreeTarget(".worktrees/paint-the-board-1a2b3c", TREES)?.path, TREES[1].path);
  // The directory name, the branch, and the tag the panel keeps across a rename.
  assert.equal(resolveTreeTarget("paint-the-board-1a2b3c", TREES)?.path, TREES[1].path);
  assert.equal(resolveTreeTarget("wtgui/que-monitor-k8s", TREES)?.path, TREES[2].path);
  assert.equal(resolveTreeTarget("1a2b3c", TREES)?.path, TREES[1].path);
  // Case and trailing slashes are the same tree.
  assert.equal(resolveTreeTarget("PAINT-THE-BOARD-1A2B3C/", TREES)?.path, TREES[1].path);
  // Unknown, and a name that matches two trees, are both "no":
  assert.equal(resolveTreeTarget("something-else", TREES), null);
  assert.equal(
    resolveTreeTarget("monitor", [
      { project: "a", path: "C:/x/.worktrees/monitor", branch: "b1" },
      { project: "b", path: "C:/y/.worktrees/monitor", branch: "b2" },
    ]),
    null,
  );
});

test("a settled turn's marker is recorded against that tree's row, with when and which run", async (t) => {
  const { store } = await storeOnDisk(t);
  const out = store.record({
    job: { id: "abcd1234", thread: "wtgui-thing", finalMessage: "" },
    finalText: "All done.\n\nRELEASE paint-the-board-1a2b3c | the PR landed and the suite is green",
    now: Date.parse("2026-10-29T12:00:00Z"),
  });
  assert.equal(out.requests.length, 1);
  assert.equal(out.refused.length, 0);
  const rec = out.requests[0];
  assert.equal(slash(rec.path), slash(TREES[1].path));
  assert.equal(rec.project, "wtgui");
  assert.equal(rec.branch, TREES[1].branch);
  assert.equal(rec.why, "the PR landed and the suite is green");
  assert.equal(rec.runId, "abcd1234");
  assert.equal(rec.requestedAt, "2026-10-29T12:00:00.000Z");
  assert.equal(rec.state, "requested");
  assert.equal(rec.outcome, null);
  // The row reads exactly these fields.
  const onRow = store.forRow("wtgui", TREES[1].path);
  assert.deepEqual(Object.keys(onRow).sort(), ["at", "branch", "detail", "outcome", "path", "requestedAt", "runId", "state", "why"].sort());
  assert.equal(onRow.state, "requested");
  // …and the card was told, in the panel's voice.
  assert.match(out.lines[0].text, /^⇢ RELEASE requested for .*paint-the-board-1a2b3c/);
  assert.match(out.lines[0].text, /the PR landed and the suite is green/);
});

test("a marker that names nothing the panel knows is refused on the card, and nothing is recorded", async (t) => {
  const { store } = await storeOnDisk(t);
  const out = store.record({
    job: { id: "abcd1234", thread: "t", worktreePath: "C:/nope/not-a-tree" },
    finalText: "RELEASE no-such-tree-999999 | finished",
  });
  assert.equal(out.requests.length, 0);
  assert.equal(out.refused.length, 1);
  assert.match(out.refused[0].error, /no worktree the panel knows matches/);
  assert.match(out.lines[0].text, /^⚠ RELEASE was NOT recorded/);
  assert.equal(store.size, 0, "a request that names no tree writes no record");
});

test("a run's own tree resolves even when the board has no row for it yet", async (t) => {
  const { store } = await storeOnDisk(t);
  const own = "C:/ProjectDevelopment/newproject/.worktrees/fresh-cut-abcdef";
  const out = store.record({
    job: { id: "run1", thread: "t", worktreePath: own, branch: "wtgui/fresh-cut-abcdef" },
    finalText: `RELEASE ${own} | the PR is merged`,
  });
  assert.equal(out.requests.length, 1);
  assert.equal(slash(out.requests[0].path), slash(own));
});

test("the store round-trips, and a second request for one tree replaces the first", async (t) => {
  const { file, store } = await storeOnDisk(t);
  store.record({ job: { id: "run1" }, finalText: "RELEASE paint-the-board-1a2b3c | first" });
  store.record({ job: { id: "run2" }, finalText: "RELEASE paint-the-board-1a2b3c | second" });
  const again = new ReleaseRequests({ file, trees: () => TREES });
  again.load();
  assert.equal(again.size, 1, "one record per tree");
  const rec = again.forRow("wtgui", TREES[1].path);
  assert.equal(rec.why, "second");
  assert.equal(rec.runId, "run2");
  assert.equal(again.pending().length, 1);
  // The file is a real JSON document, not a serialisation of a Map.
  const raw = JSON.parse(await readFile(file, "utf8"));
  assert.equal(raw.version, 1);
  assert.equal(Object.keys(raw.requests).length, 1);
});

test("the outcome is written back onto the record — removed, or the gate that refused", async (t) => {
  const { store } = await storeOnDisk(t);
  store.record({ job: { id: "run1" }, finalText: "RELEASE paint-the-board-1a2b3c | finished" });
  const key = store.pending()[0].key;
  const rec = store.finish(key, {
    outcome: "refused: the tree is not clean (2 changed paths)",
    detail: "the tree is not clean (2 changed paths)",
    steps: [{ step: "clean", ok: false, detail: "M a.txt" }],
    now: Date.parse("2026-10-29T12:04:00Z"),
  });
  assert.equal(rec.state, "refused");
  assert.equal(rec.outcome, "refused: the tree is not clean (2 changed paths)");
  assert.equal(rec.at, "2026-10-29T12:04:00.000Z");
  assert.deepEqual(rec.steps.map((s) => s.step), ["clean"]);
  assert.equal(store.pending().length, 0, "an answered request is not pending again");

  store.record({ job: { id: "run2" }, finalText: "RELEASE paint-the-board-1a2b3c | finished" });
  const removed = store.finish(store.pending()[0].key, { outcome: "removed", detail: "worktree removed", steps: [] });
  assert.equal(removed.state, "removed");
  assert.equal(removed.outcome, "removed");
});

// The settle seam itself: `Jobs.harvestRelease`, the method measureTree calls once a run has ended. It is driven on a
// bare prototype object — the method touches only `releases`, `push` and the job — because the point is the seam, not
// a panel: the marker goes in with the final message, one request comes out, and a second pass records nothing.
test("the settle seam records the marker once per run, and pushes the sentence onto the card", async (t) => {
  const { Jobs } = await import("../lib/jobs.js");
  const { store } = await storeOnDisk(t);
  const harness = Object.create(Jobs.prototype);
  harness.releases = store;
  harness.push = (job, line) => job.lines.push(line);
  const job = {
    id: "run-77",
    thread: "wtgui-thing",
    worktreePath: TREES[1].path,
    branch: TREES[1].branch,
    finalMessage: "Everything landed.\n\nRELEASE paint-the-board-1a2b3c | the PR is merged and the tree is clean",
    lines: [],
  };
  const first = harness.harvestRelease(job);
  assert.equal(first.requests.length, 1);
  assert.equal(job.releaseHarvested, true);
  assert.equal(job.lines.length, 1);
  assert.match(job.lines[0].text, /^⇢ RELEASE requested for /);
  assert.deepEqual(job.releaseAsked.map((r) => r.runId), ["run-77"]);

  const again = harness.harvestRelease(job);
  assert.equal(again, null, "a second settle of the same run must not record a second request");
  assert.equal(store.pending().length, 1);
  assert.equal(job.lines.length, 1, "and must not repeat the console line");
});

test("a run that says nothing about a tree records nothing", async (t) => {
  const { Jobs } = await import("../lib/jobs.js");
  const { store } = await storeOnDisk(t);
  const harness = Object.create(Jobs.prototype);
  harness.releases = store;
  harness.push = (job, line) => job.lines.push(line);
  const job = { id: "run-78", thread: "t", worktreePath: TREES[1].path, finalMessage: "all done, no release needed", lines: [] };
  const out = harness.harvestRelease(job);
  assert.equal(out.requests.length, 0);
  assert.equal(store.size, 0);
  assert.equal(job.lines.length, 0);
});
