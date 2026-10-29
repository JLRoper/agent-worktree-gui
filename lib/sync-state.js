// The branch against its OWN copy on the remote: the one comparison every git client means by "ahead / behind".
//
//   ↑ ahead   commits this tree has that the copy does not — work that is not pushed yet
//   ↓ behind  commits the copy has that this tree does not — work that is not pulled yet
//
// The board's column used to count against the PROJECT'S MAIN instead (`row.ahead` / `row.behind`, which the verdict is
// built from and which still mean exactly that). That is a different question — "is this work in main?" — and it made a
// branch that was fully pushed read "2 / 2" because main had moved on. This module answers the question the column's
// name asks, from facts the scan already has for free: `git status --porcelain=v2 --branch` reports the branch's
// upstream and, when the upstream ref exists, the count against it. lib/scan.js keeps them as `row.upstream`,
// `row.upstreamAhead` and `row.upstreamBehind`; git OMITS the count when the upstream ref is gone, which is how "gone"
// is told from "level" with no extra process.
//
// A branch's upstream is only its OWN copy when it is the same branch on the remote. A worktree cut from `origin/main`
// tracks `origin/main` until its first `git push -u`, and counting against that would invent a comparison with main
// under a name that says "remote copy" — so it has no copy of its own, and the cell says so.
//
// Pure: no git, no I/O. The store calls it on every row it puts, so a commit or a push shows on the next scan, and a
// test, a harness and the page all read the same answer; the page chooses no word for itself.
//
//   state      level | ahead | behind | diverged   the copy exists and was counted against
//              gone       the branch has a copy configured, and it is not there any more
//              untracked  the remote has a branch of this name, but this tree is not set to track it
//              none       no copy of this branch on the remote (never pushed, or nothing to ask)
//   stale      the project's last fetch FAILED, so the count is as of the last fetch that worked
//   why        the sentence the cell's tooltip carries
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function oneLine(s, max = 140) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// `origin/wtgui/foo` -> the copy is `origin/wtgui/foo` only when what follows the FIRST slash is the branch's own name
// (a branch name may itself contain slashes, a remote name cannot).
export function ownCopyOf(row) {
  const up = String(row?.upstream || "");
  const branch = String(row?.branch || "");
  const cut = up.indexOf("/");
  return cut > 0 && branch && up.slice(cut + 1) === branch ? up : "";
}

export function syncState({ row = {}, remote = "", fetchNote = "" } = {}) {
  const branch = String(row.branch || "");
  const note = oneLine(fetchNote);
  const none = (why, extra = {}) => ({ state: "none", ahead: null, behind: null, ref: null, stale: false, why, ...extra });
  if (!branch || branch === "HEAD") {
    return none("this tree is not on a branch right now (a detached HEAD, or it could not be read), so there is no copy on the remote to compare with");
  }
  if (!remote) return none("this project has no remote, so there is no copy of this branch to be ahead of or behind");

  const ref = ownCopyOf(row);
  if (ref) {
    // The remote itself listed its branches and this one was not among them: stronger than any ref left on disk.
    if (row.remoteBranch === "gone") {
      return {
        state: "gone",
        ahead: null,
        behind: null,
        ref,
        stale: false,
        why: `the remote answered that ${ref} no longer exists — a merged PR's branch is usually deleted. This tree still has its commits.`,
      };
    }
    const a = row.upstreamAhead;
    const b = row.upstreamBehind;
    if (Number.isInteger(a) && Number.isInteger(b)) {
      const stale = Boolean(note);
      const state = a && b ? "diverged" : a ? "ahead" : b ? "behind" : "level";
      const parts = [];
      if (!a && !b) parts.push(`level with ${ref}: nothing to push, nothing to pull.`);
      if (a) parts.push(`↑${a}: ${plural(a, "commit", "commits")} here that ${ref} does not have yet — not pushed.`);
      if (b) parts.push(`↓${b}: ${plural(b, "commit", "commits")} on ${ref} that ${b === 1 ? "is" : "are"} not here — not pulled.`);
      const asOf = stale ? ` The last fetch failed (${note}), so this is as of the last fetch that worked.` : "";
      return { state, ahead: a, behind: b, ref, stale, why: `${parts.join(" ")}${asOf}` };
    }
    // Configured, but git has no count: the upstream ref is gone (deleted on the remote, then pruned by a fetch).
    return {
      state: "gone",
      ahead: null,
      behind: null,
      ref,
      stale: false,
      why: `${ref} is this branch's copy, but it is not there any more: it was deleted on the remote and the last fetch pruned it. This tree still has its commits.`,
    };
  }

  // No copy of its own is configured. The remote may still have one (pushed without -u), and that is worth saying
  // rather than drawing "never pushed" over a branch that is plainly there.
  if (row.remoteBranch === "exists") {
    return {
      state: "untracked",
      ahead: null,
      behind: null,
      ref: null,
      stale: false,
      why: `the remote has a branch with this name, but this tree is not set to track it, so there is nothing to count against — "git branch -u ${remote}/${branch}" makes it count.`,
    };
  }
  if (row.remoteBranch === "unknown") {
    return none(`no tracked copy of this branch is recorded here, and the remote could not be asked${note ? ` (${note})` : ""}, so it may or may not have one.`, { stale: true });
  }
  return none(`this branch has no copy on ${remote}: it has never been pushed.`);
}
