// The paragraph a worker is handed about where its branch goes when the work is done.
//
// A tree the panel cuts has a PARENT: the branch `git worktree add -b` cut from. That parent - not the project's
// main branch - is what decides how the work lands, and the cases are opposites:
//
//   parent is the project's turnover branch -> merge into the parent LOCALLY and do not push, and do not open a pull
//                                         request. It does not matter whether that branch is remote-backed or only
//                                         local: it has not landed, so a remote branch of this tree lands nothing and
//                                         puts a child of an unpublished branch on a repository other people share.
//   parent is main / master            -> do NOT merge into it. Push the branch and open a pull request: the parent
//                                         is a landing branch and the house rule is one reviewable PR per branch.
//                                         A NEW remote branch is only ever permitted when the project has no turnover
//                                         branch configured and there is none on origin - otherwise the work rolls
//                                         up into that branch locally instead.
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
//
// THE KIND OUTRANKS THE PARENT, because the kind is what the cut RECORDED and the parent is only how it was reached.
// A research tree never lands: it commits, is copied out and released. An implementation tree lands by merging
// LOCALLY - into the turnover branch it was cut from, or the project's configured turnover branch when its parent is
// not one, else into main only on the reader's explicit grant - and never pushes as part of that landing. Both are
// local only, so neither is ever told to open a pull request. A turnover child keeps the paragraph it always had. A
// caller that passes no kind gets the parent's case exactly as before, which is what pipeline stages and older
// callers do.
import { isTurnoverBranch } from "./branch-kind.js";

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
    return "Remote writes are allowed for this project, so a push is not asked about - the rule above is what decides whether to push at all.";
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

// The push tail for the two LOCAL-ONLY kinds. It cannot be `guardTail`, whose `allow` sentence says a push is not
// asked about: a local-only tree's recorded kind outranks the project's push controls (lib/push-permissions.js
// `pushModeFor`), so the card is what happens under `allow` too. `never` is still absolute and gets its own sentence.
function localKindPushTail(policy) {
  const p = String(policy || "local-only").trim().toLowerCase();
  if (p === "deny") {
    return "The project's policy refuses a push outright (deny), so a push from this tree will fail.";
  }
  return "A push from this tree is not part of this landing: it parks on the reader's permission card, one grant covers one push from this tree, and the reader's lift is the standing grant.";
}

export function branchLandingLine(o = {}, where = null) {
  const tree = String(where ?? o.cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  const parent = String(o.parent ?? o.parentBranch ?? "").trim();
  const branch = String(o.branch ?? "").trim();
  const remote = String(o.remote ?? "").trim();
  const ours = branch ? `\`${branch}\`` : "this tree's branch";
  const here = tree ? ` (${tree})` : "";
  // The project's turnover branch, when one is configured AND it really exists (lib/jobs.js asks git before handing
  // it over). It is the one branch a project declares as the destination of its work, so a paragraph that ignored it
  // would be free to invent a second, remote one. Empty means "no turnover branch on this project".
  const turnover = String(o.turnoverBranch ?? "").trim();
  const turnoverBacked = o.turnoverOnRemote === true || o.parentOnRemote === true;
  // The stage's own case, and it WINS over the parent's: a stage that declares a document has no pull request to
  // open whatever its tree was cut from, and a paragraph that told it to open one is the defect this branch exists
  // for. It does not need the parent, so a tree nobody can name still gets a true sentence.
  if (o.localOnly === true) {
    return (
      `LANDING: this worktree${here} is on ${ours}. This stage's artifact is not a pull request, so this tree is ` +
      `local-only: when the work is done, commit on ${ours} and report the commit - do not push the branch and do not ` +
      "open a pull request. The artifact is the file a later stage reads out of this tree, and a PR on this branch is " +
      "a remote write nobody asked for. " +
      guardTail(o.policy ?? o.branchPolicy, { allowPushWithoutAsking: o.allowPushWithoutAsking === true })
    );
  }
  // THE RESEARCH KIND, and its rule is the shortest of the three: the work is the answer, not a branch. It commits
  // where it stands, is copied out and released, and merges into nothing. Saying "never push" without the grant
  // sentence would be a lie the moment the reader lifts the tree, so the sentence names the reader's grant as the
  // only way a push happens - without inviting one. A tree the reader has ALREADY lifted (a SPAWN row that said it may
  // land on the remote) is not given this paragraph at all: the lift is the answer that the parent's own case
  // describes, and telling a lifted worker not to push would contradict the record it was cut with.
  if (String(o.kind ?? "").trim().toLowerCase() === "research" && o.lifted !== true) {
    return (
      `LANDING: this worktree${here} is on ${ours}. This is a research tree: when the work is done, commit on ${ours} ` +
      "and report the commit. Do not merge it into any branch, do not push it and do not open a pull request - the " +
      "work is the answer, and the tree is copied out and released rather than landed. A push from this tree is the " +
      "reader's to grant, never part of this landing."
    );
  }
  // THE IMPLEMENTATION KIND: it LANDS, but only locally. The destination is the turnover branch it was cut from, or
  // the project's configured turnover branch when its parent is not one, else main - and main only when the reader
  // grants it explicitly. It never pushes as part of that landing, whatever the project's controls say. LIFTED is the
  // same exception as research: the reader already said this tree may land on the remote, so the parent's case (which
  // the policy tail makes truthful) is the paragraph.
  if (String(o.kind ?? "").trim().toLowerCase() === "implementation" && o.lifted !== true) {
    const main = String(o.mainBranch ?? "").trim() || "main";
    // The branch the tree was cut FROM names the destination only when it really is a turnover branch. A parent that
    // is main (or any other ordinary branch) with no turnover branch configured falls to the last case below: main,
    // and only on the reader's explicit grant.
    const parentIsTurnover = Boolean(parent) && (parent === turnover || isTurnoverBranch(parent));
    if (parentIsTurnover) {
      return (
        `LANDING: this worktree${here} is on ${ours}, cut from \`${parent}\` - a turnover branch. This is an ` +
        `implementation tree: when the work is done, commit on ${ours} and merge it into \`${parent}\` LOCALLY. Do ` +
        `not push and do not open a pull request: \`${parent}\` is where the work rolls up, and the reader decides ` +
        `when it lands. Report the merge commit and leave \`${parent}\` where it is. ` +
        localKindPushTail(o.policy ?? o.branchPolicy)
      );
    }
    if (turnover) {
      return (
        `LANDING: this worktree${here} is on ${ours}${parent ? `, cut from \`${parent}\`` : ""}. This is an ` +
        `implementation tree. This project's turnover branch is \`${turnover}\`, so when the work is done, commit on ` +
        `${ours} and merge it into \`${turnover}\` LOCALLY${parent ? ` - do not merge into \`${parent}\`` : ""}. Do ` +
        "not push and do not open a pull request: the turnover branch is where the work rolls up, and the reader " +
        `decides when it lands. Report the merge commit and leave \`${turnover}\` where it is. ` +
        localKindPushTail(o.policy ?? o.branchPolicy)
      );
    }
    return (
      `LANDING: this worktree${here} is on ${ours}${parent ? `, cut from \`${parent}\`` : ""}. This is an ` +
      `implementation tree: when the work is done, commit on ${ours}. Merge it into \`${main}\` LOCALLY only if the ` +
      "reader grants that explicitly - do not merge into it on your own, and do not push. Report the commit and the " +
      `branch, and leave \`${main}\` where it is until the reader says otherwise. ` +
      localKindPushTail(o.policy ?? o.branchPolicy)
    );
  }
  if (!parent) return "";
  // THE TURNOVER PARENT, and it is the case this module was missing: the tree was cut from the project's own
  // turnover branch, whether that branch is on origin or local only. The instruction is the same either way - merge
  // back into it LOCALLY, no push, no PR - because a remote branch of this tree lands nothing the turnover branch
  // does not already carry, and a PR asks a reviewer to look at a branch that has not landed itself.
  if (turnover && parent === turnover) {
    return (
      `LANDING: this worktree${here} is on ${ours}, cut from \`${parent}\` - this project's turnover branch` +
      `${turnoverBacked ? " (it is remote-backed, and that changes nothing about where this branch goes)" : " (local only)"}. ` +
      `When the work is done, finish by merging ${ours} into \`${parent}\` LOCALLY and do not push: a new remote ` +
      "branch of this tree would be a branch on the shared remote nobody asked for. Do not open a pull request - " +
      `\`${parent}\` is where the work rolls up, and the reader decides when it lands. Report the merge commit and ` +
      `leave \`${parent}\` where it is. A new remote branch is permitted only when a project has no turnover branch ` +
      "configured and there is none on origin. " +
      guardTail(o.policy ?? o.branchPolicy, { allowPushWithoutAsking: o.allowPushWithoutAsking === true })
    );
  }
  if (isLandingBranch(parent)) {
    // A landing parent with a turnover branch configured on the project: the checkout is on main, but the project
    // has declared where its work rolls up. Telling the worker to push a second remote branch is exactly the defect
    // this file exists to stop, so the paragraph rolls the work into the turnover branch instead.
    if (turnover) {
      return (
        `LANDING: this worktree${here} is on ${ours}, cut from \`${parent}\` - a landing branch, so do not merge into it. ` +
        `This project's turnover branch is \`${turnover}\`, so do not push a new remote branch: when the work is done, ` +
        `finish by merging ${ours} into \`${turnover}\` LOCALLY and do not open a pull request - \`${turnover}\` is ` +
        "where the work rolls up, and the reader decides when it lands. Report the merge commit and leave " +
        `\`${turnover}\` where it is. A new remote branch is permitted only when a project has no turnover branch ` +
        "configured and there is none on origin. " +
        guardTail(o.policy ?? o.branchPolicy, { allowPushWithoutAsking: o.allowPushWithoutAsking === true })
      );
    }
    return (
      `LANDING: this worktree${here} is on ${ours}, cut from \`${parent}\` - a landing branch, so do not merge into it. ` +
      `When the work is done, commit on ${ours}, push it and open a pull request: ` +
      `\`git push -u ${remote || "<remote>"} HEAD\` then \`gh pr create --fill\`. ` +
      "A new remote branch is permitted here only because this project has no turnover branch configured and there is " +
      "none on origin. " +
      guardTail(o.policy ?? o.branchPolicy, { landingParent: true, allowPushWithoutAsking: o.allowPushWithoutAsking === true })
    );
  }
  return (
    `LANDING: this worktree${here} is on ${ours}, cut from \`${parent}\`. ` +
    `Finish by merging ${ours} into \`${parent}\` LOCALLY and do not push: \`${parent}\` has not landed, so a remote ` +
    "branch of this tree would be a branch on the shared remote nobody asked for. " +
    `Report the merge commit and leave \`${parent}\` where it is - the reader decides when it lands. ` +
    guardTail(o.policy ?? o.branchPolicy, { allowPushWithoutAsking: o.allowPushWithoutAsking === true })
  );
}
