// The Ahead / Behind column's meaning: the branch against its OWN copy on the remote (lib/sync-state.js). Pure, so
// every state is pinned here without a git repo; test/scan-upstream.test.js proves the raw numbers against real git.
import test from "node:test";
import assert from "node:assert/strict";
import { ownCopyOf, syncState } from "../lib/sync-state.js";

const own = (over = {}) => ({
  branch: "wtgui/foo",
  upstream: "origin/wtgui/foo",
  upstreamAhead: 0,
  upstreamBehind: 0,
  remoteBranch: "exists",
  ...over,
});
const sync = (row, extra = {}) => syncState({ row, remote: "origin", fetchNote: "", ...extra });

test("level, ahead, behind and diverged are counted against the branch's own copy", () => {
  const level = sync(own());
  assert.equal(level.state, "level");
  assert.deepEqual([level.ahead, level.behind, level.ref, level.stale], [0, 0, "origin/wtgui/foo", false]);
  assert.match(level.why, /level with origin\/wtgui\/foo: nothing to push, nothing to pull/);

  const ahead = sync(own({ upstreamAhead: 2 }));
  assert.equal(ahead.state, "ahead");
  assert.deepEqual([ahead.ahead, ahead.behind], [2, 0]);
  assert.match(ahead.why, /↑2: 2 commits here that origin\/wtgui\/foo does not have yet — not pushed/);

  const behind = sync(own({ upstreamBehind: 3 }));
  assert.equal(behind.state, "behind");
  assert.match(behind.why, /↓3: 3 commits on origin\/wtgui\/foo that are not here — not pulled/);

  const both = sync(own({ upstreamAhead: 1, upstreamBehind: 1 }));
  assert.equal(both.state, "diverged");
  assert.match(both.why, /↑1: 1 commit here .*not pushed\. ↓1: 1 commit on .* that is not here — not pulled/);
});

test("the count is against the copy, not against main: a pushed branch is level however far main has moved", () => {
  // `ahead` / `behind` are the verdict's count against main and do not enter the answer at all.
  const row = own({ ahead: 2, behind: 2, upstreamAhead: 0, upstreamBehind: 0 });
  const s = sync(row);
  assert.equal(s.state, "level");
  assert.equal(s.ahead, 0);
  assert.equal(s.behind, 0);
});

test("a branch whose upstream is main has no copy of its own, and says so instead of counting against main", () => {
  // A worktree cut from origin/main tracks origin/main until its first `git push -u`.
  const fresh = { branch: "wtgui/foo", upstream: "origin/main", upstreamAhead: 2, upstreamBehind: 2, remoteBranch: "gone" };
  assert.equal(ownCopyOf(fresh), "");
  const s = sync(fresh);
  assert.equal(s.state, "none");
  assert.equal(s.ahead, null);
  assert.equal(s.behind, null);
  assert.equal(s.ref, null);
  assert.match(s.why, /no copy on origin: it has never been pushed/);
});

test("a copy that is configured but has no count is gone, and the remote's own answer beats a ref left on disk", () => {
  const pruned = sync(own({ upstreamAhead: null, upstreamBehind: null, remoteBranch: "gone" }));
  assert.equal(pruned.state, "gone");
  assert.equal(pruned.ref, "origin/wtgui/foo");

  const noCount = sync(own({ upstreamAhead: null, upstreamBehind: null, remoteBranch: "exists" }));
  assert.equal(noCount.state, "gone");
  assert.match(noCount.why, /deleted on the remote and the last fetch pruned it/);

  // The ref is still on disk with a count, but the remote listed its branches and this was not among them.
  const staleRef = sync(own({ upstreamAhead: 0, upstreamBehind: 0, remoteBranch: "gone" }));
  assert.equal(staleRef.state, "gone");
  assert.match(staleRef.why, /the remote answered that origin\/wtgui\/foo no longer exists/);
});

test("the remote has the branch but this tree does not track it: untracked, with the command that fixes it", () => {
  const s = sync({ branch: "wtgui/foo", upstream: null, remoteBranch: "exists" });
  assert.equal(s.state, "untracked");
  assert.equal(s.ahead, null);
  assert.match(s.why, /git branch -u origin\/wtgui\/foo/);
});

test("nothing recorded and the remote could not be asked: none, marked stale, never claimed as 'never pushed'", () => {
  const s = sync({ branch: "wtgui/foo", upstream: null, remoteBranch: "unknown" }, { fetchNote: "ssh: connect to host x port 22: Connection timed out" });
  assert.equal(s.state, "none");
  assert.equal(s.stale, true);
  assert.match(s.why, /could not be asked \(ssh: connect to host x port 22: Connection timed out\)/);
  assert.doesNotMatch(s.why, /never been pushed/);
});

test("a failed fetch marks a count stale and quotes the note; a count with no failure is not stale", () => {
  const ok = sync(own({ upstreamAhead: 1 }));
  assert.equal(ok.stale, false);
  assert.doesNotMatch(ok.why, /last fetch failed/);

  const bad = sync(own({ upstreamAhead: 1 }), { fetchNote: "kex_exchange_identification: Connection reset by peer" });
  assert.equal(bad.state, "ahead");
  assert.equal(bad.stale, true);
  assert.match(bad.why, /The last fetch failed \(kex_exchange_identification: Connection reset by peer\), so this is as of the last fetch that worked\./);
});

test("a long, multi-line fetch note is folded to one short line", () => {
  const note = `fatal: unable to access\n${"x".repeat(400)}`;
  const s = sync(own(), { fetchNote: note });
  const quoted = /last fetch failed \((.*)\), so this/s.exec(s.why)[1];
  assert.ok(quoted.length <= 140, `quoted note is ${quoted.length} chars`);
  assert.doesNotMatch(quoted, /\n/);
  assert.ok(quoted.endsWith("…"));
});

test("no remote, or no branch: none, with the reason", () => {
  assert.equal(syncState({ row: own(), remote: "", fetchNote: "" }).state, "none");
  assert.match(syncState({ row: own(), remote: "" }).why, /no remote/);
  for (const branch of [null, "", "HEAD"]) {
    const s = sync({ ...own(), branch });
    assert.equal(s.state, "none");
    assert.match(s.why, /not on a branch right now/);
  }
});

test("ownCopyOf splits on the FIRST slash only: branch names carry slashes, remote names do not", () => {
  assert.equal(ownCopyOf({ branch: "wtgui/foo", upstream: "origin/wtgui/foo" }), "origin/wtgui/foo");
  assert.equal(ownCopyOf({ branch: "wtgui/foo", upstream: "fork/wtgui/foo" }), "fork/wtgui/foo"); // any remote's copy
  assert.equal(ownCopyOf({ branch: "foo", upstream: "origin/foo" }), "origin/foo");
  assert.equal(ownCopyOf({ branch: "wtgui/foo", upstream: "origin/foo" }), ""); // a different branch
  assert.equal(ownCopyOf({ branch: "main", upstream: "main" }), ""); // a local upstream has no remote part
  assert.equal(ownCopyOf({ branch: "main", upstream: null }), "");
  assert.equal(ownCopyOf({ branch: "", upstream: "origin/" }), "");
});
