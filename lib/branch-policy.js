// The paragraph a worker is handed about where its branch goes when the work is done.
//
// A tree the panel cuts has a PARENT: the branch `git worktree add -b` cut from. That parent — not the project's
// main branch — is what decides how the work lands, and the two cases are opposites:
//
//   parent is a local turnover branch  -> merge into the parent LOCALLY and do not push. The parent has not landed,
//                                         so a remote branch of this tree lands nothing and puts a child of an
//                                         unpublished branch on a repository other people share.
//   parent is main / master            -> do NOT merge into it. Push the branch and open a pull request: the parent
//                                         is a landing branch and the house rule is one reviewable PR per branch.
//
// There is a THIRD case, and it is not about the parent at all: a pipeline stage whose declared artifact is not a
// pull request (a document, a report, a build) has nothing to land. Its branch is a workspace, and the artifact is a
// file the next stage reads out of it — so the paragraph says commit on the branch and report the commit, and that a
// push or a pull request is exactly the remote write nobody asked for. Rendering the parent's case there made every
// document stage push its branch and open a PR (measured: PR #607 for one ledger/draft.md). The caller says which
// case it is (`localOnly`), because the STAGE knows its artifact and this module does not.
//
// THE PARENT IS READ, NEVER ASSUMED. lib/jobs.js records it at the moment it cuts a tree (the branch the repo was on
// when `git worktree add` ran) and reads that record back for a later run in the same tree; git's own upstream is the
// second answer. When neither can be read this function returns "" and the caller falls back to the blanket rule —
// because a guessed `main` is precisely the sentence that pushed a child of a turnover branch to the shared remote,
// which is what this exists to stop.
export const LANDING_BRANCHES = new Set(["main", "master"]);

export const isLandingBranch = (name) => LANDING_BRANCHES.has(String(name ?? "").trim().toLowerCase());

// What the panel's guard will actually do to a push from this project, in one sentence. The policy is per project
// (lib/remote-writes.js `policyForProject`), so the same tree can be allowed in one repo and refused in another.
// The per-remote switch (`allowPushWithoutAsking`) is named only after the policy's own answers, because `deny` wins
// and an `allow` policy already means "not asked about".
function guardTail(policy, { landingParent = false, allowPushWithoutAsking = false } = {}) {
  const p = String(policy || "local-only").trim().toLowerCase();
  if (p === "deny") {
    return "The policy in force for this project refuses a push outright (remoteBranchPolicy: deny), so a push from this tree will fail.";
  }
  if (p === "allow") {
    return "Remote writes are allowed for this project, so a push is not asked about — the rule above is what decides whether to push at all.";
  }
  // The switch is the reader's standing "do not ask me about THIS remote". It pushes nothing by itself, so the
  // sentence keeps the decision where it belongs: the rule above.
  if (allowPushWithoutAsking === true) {
    return "This remote's Allow push without asking switch is on for this project, so a push from this tree is not asked about — the rule above is what decides whether to push at all.";
  }
  // Local-only: the guard parks a push on the reader's permission box rather than allowing it, and says so in a way
  // that matches the instruction the worker was just given (push for a PR, or do not push at all).
  return landingParent
    ? "A push from this tree is not allowed by itself: it parks on the reader's permission box in the panel and goes through only if they allow it — if nobody answers, report the branch and the PR body instead of retrying."
    : "The panel's push guard refuses a push from this tree and asks the reader through its permission box, so a push you attempt will park and then fail; report instead.";
}

export function branchLandingLine(o = {}, where = null) {
  const tree = String(where ?? o.cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const parent = String(o.parent ?? o.parentBranch ?? "").trim();
  const branch = String(o.branch ?? "").trim();
  const remote = String(o.remote ?? "").trim();
  const ours = branch ? `\`${branch}\`` : "this tree's branch";
  const here = tree ? ` (${tree})` : "";
  // The stage's own case, and it WINS over the parent's: a stage that declares a document has no pull request to
  // open whatever its tree was cut from, and a paragraph that told it to open one is the defect this branch exists
  // for. It does not need the parent, so a tree nobody can name still gets a true sentence.
  if (o.localOnly === true) {
    return (
      `LANDING: this worktree${here} is on ${ours}. This stage's artifact is not a pull request, so this tree is ` +
      `local-only: when the work is done, commit on ${ours} and report the commit — do not push the branch and do not ` +
      "open a pull request. The artifact is the file a later stage reads out of this tree, and a PR on this branch is " +
      "a remote write nobody asked for. " +
      guardTail(o.policy ?? o.branchPolicy, { allowPushWithoutAsking: o.allowPushWithoutAsking === true })
    );
  }
  if (!parent) return "";
  if (isLandingBranch(parent)) {
    return (
      `LANDING: this worktree${here} is on ${ours}, cut from \`${parent}\` — a landing branch, so do not merge into it. ` +
      `When the work is done, commit on ${ours}, push it and open a pull request: ` +
      `\`git push -u ${remote || "<remote>"} HEAD\` then \`gh pr create --fill\`. ` +
      guardTail(o.policy ?? o.branchPolicy, { landingParent: true, allowPushWithoutAsking: o.allowPushWithoutAsking === true })
    );
  }
  return (
    `LANDING: this worktree${here} is on ${ours}, cut from \`${parent}\`. ` +
    `Finish by merging ${ours} into \`${parent}\` LOCALLY and do not push: \`${parent}\` has not landed, so a remote ` +
    "branch of this tree would be a branch on the shared remote nobody asked for. " +
    `Report the merge commit and leave \`${parent}\` where it is — the reader decides when it lands. ` +
    guardTail(o.policy ?? o.branchPolicy, { allowPushWithoutAsking: o.allowPushWithoutAsking === true })
  );
}
