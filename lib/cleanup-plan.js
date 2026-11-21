// The ONE decision table behind the project card's cleanup chip: which worktrees a project may shed, which
// branches may go with them, and what stops the rest.
//
// The planner is PURE. It never runs git, never reads the disk and never removes anything: the facts it judges
// (`ahead`, `dirty`, `ancestor`, the cherry counts, the lock and the live job) arrive already measured, so a test
// can put a rule in front of it without building a repository, and the run cannot decide something the read it
// printed did not contain. `lib/cleanup-run.js` gathers those facts and acts on the plan.
//
// The rules, in the order they are asked, and each one is a test in test/cleanup-plan.test.js:
//
//   1. the project's PRIMARY checkout is never a candidate, whatever its branch holds. It is the reader's working
//      copy, not a tree the panel cut;
//   2. the panel's OWN tree is never a candidate either: its cwd is inside it, so on Windows the folder stays busy
//      and removing the code that is running is not a cleanup. "Own" is the tree that CONTAINS the cwd (or is it),
//      never a tree that merely sits under the same folder: a panel started from the primary checkout has its cwd
//      AT the project root, and reading that as "everything under here is mine" marks every worktree skip;
//   2b. a worktree of the same REPOSITORY that sits outside the project's folder is skipped too: the board does not
//      draw it as a row, so the cleanup has no control over it to offer;
//   3. a LOCKED worktree is skipped, with the lock's own sentence (lib/locks.js), because the lock is the reader
//      saying "not this one" and it outranks every count below;
//   4. a tree a LIVE JOB holds is skipped: the job's shell is in it, and a merge or a remove there would fight the
//      agent that is working;
//   5. a TURNOVER branch - the brief's `^[0-9]{8}_[A-Z]+_`, widened below to the fleet's real
//      `YYYYMMDD_HHMM_TICKET_desc` shape - and the branch the project marks as its base are never deleted. A
//      turnover branch is where other trees roll up, so deleting it would orphan every child cut from it;
//   6. a tree with NO branch (detached HEAD) is kept: there is no branch for the proof to be about;
//   7. a branch that is an ANCESTOR of main is already landed: the worktree and the branch may go;
//   8. a branch whose commits main lacks are ALL cherry-equivalent (git cherry marks none as `+`) is landed by
//      content even though the shas differ: the worktree and the branch may go;
//   9. a branch holding commits main lacks, with a CLEAN tree, is MERGED - `--no-ff` - into a child cut from the
//      project's turnover branch when it has one, else from main. The tree stays: the rule that removes a worktree
//      only ever fires for rule 7 or 8;
//  10. a branch holding commits main lacks with a DIRTY tree has its BRANCH merged the same way, and its working
//      tree is never touched: uncommitted files are the only copy of that work, so the tree is left exactly where
//      it is and named in the report;
//  11. anything else - a branch main already contains whose tree is dirty - is kept, and the reason names the
//      dirty files.
//
// NOTHING here deletes, merges or moves a ref itself. The plan says what could be done and why; `applyCleanup`
// refuses to act on a row this file did not mark `remove` or `merge`.

/** The brief's turnover pattern, widened to the names this fleet really cuts. */
// The brief protects `^[0-9]{8}_[A-Z]+_`. Every turnover branch this panel has actually cut is
// `YYYYMMDD_HHMM_TICKET_desc`, where the segment after the date is `1338`, not letters - the literal brief pattern
// would miss all of them. A protection that misses the real names is worse than none, so the middle segment takes
// letters AND digits: a SUPERSET of the brief's pattern, never a narrower rule. The cost of being too wide is a
// needless "keep", which is the safe direction; the cost of being too narrow is a deleted turnover branch.
export const TURNOVER_NAME_RE = /^[0-9]{8}_[A-Za-z0-9]+_/;

/** Is this branch name one the planner must never delete? */
export function isTurnoverName(branch) {
  const name = String(branch ?? "")
    .trim()
    .replace(/^refs\/heads\//, "");
  return Boolean(name) && TURNOVER_NAME_RE.test(name);
}

/** The branches a project marks as its own base: its main branch and its turnover branch. */
export function baseBranchesOf(project = {}) {
  const main = String(project?.mainBranch || "").trim() || "main";
  const turnover = String(project?.turnoverBranch || "").trim();
  return [...new Set([main, turnover].filter(Boolean))];
}

/**
 * Why this branch is protected from deletion, or "" when it is not.
 *
 * Two answers, and both mean "keep the branch": a turnover name (the fleet's roll-up ref) and the branch the
 * project marks as its base (its main branch, or the turnover branch the reader named in its settings).
 */
export function branchProtection(branch, project = {}) {
  const name = String(branch ?? "").trim();
  if (!name) return "";
  if (isTurnoverName(name)) return `turnover branch (${name} matches the turnover name rule) - it is never deleted`;
  const bases = baseBranchesOf(project);
  if (bases.includes(name)) return `the project's base branch (${name}) - it is never deleted`;
  return "";
}

/** One proof line, so the report and the chip cannot describe the same branch differently. */
export function proofOf(tree = {}) {
  if (tree.ancestor === true) {
    return { kind: "ancestor", detail: `${tree.branch || "its branch"} is an ancestor of ${tree.main || "main"} - every commit it carries is already there` };
  }
  const cherry = tree.cherry || null;
  // A content proof has to account for EVERY commit main lacks. `git cherry` writes one mark per non-merge commit, so
  // a branch holding a merge commit prints fewer marks than `rev-list --count` counts: `unique === 0` would then be
  // true while a commit went unjudged. `equivalent === ahead` is what makes this a proof rather than a gap.
  if (cherry && cherry.ahead > 0 && cherry.measured !== false && cherry.unique === 0 && Number(cherry.equivalent) === Number(cherry.ahead)) {
    return {
      kind: "cherry",
      detail: `git cherry marks all ${cherry.ahead} commit${cherry.ahead === 1 ? "" : "s"} main lacks as cherry-equivalent (-), so the content is already in ${tree.main || "main"}`,
    };
  }
  if (cherry && cherry.ahead > 0 && cherry.unique > 0) {
    return { kind: "none", detail: `${cherry.unique} of ${cherry.ahead} commit${cherry.ahead === 1 ? "" : "s"} main lacks ${cherry.unique === 1 ? "is" : "are"} not in ${tree.main || "main"} by content` };
  }
  if (cherry && cherry.ahead > 0 && cherry.measured !== false && cherry.unique === 0) {
    const marked = Number(cherry.equivalent) || 0;
    return {
      kind: "none",
      detail: `git cherry marked only ${marked} of ${cherry.ahead} commit${cherry.ahead === 1 ? "" : "s"} main lacks (a merge commit prints no mark), so ${cherry.ahead - marked} ${cherry.ahead - marked === 1 ? "commit is" : "commits are"} unproved`,
    };
  }
  return { kind: "none", detail: "no proof was read for this tree" };
}

/**
 * The plan.
 *
 * `trees` are already-measured worktrees of ONE project:
 *
 *   { path, branch, head, dirty, dirtyFiles, ancestor, cherry: { ahead, unique, equivalent }, main,
 *     locked, lockReason, liveJob, notOwnTree }
 *
 * and the rest names the two trees that are never candidates. Every row answers with a verdict, the proof, the
 * keep-or-drop call the report prints as a button, and one sentence. `remove` is the only verdict that deletes
 * anything; `merge` preserves a branch's commits and leaves the tree alone.
 */
export function planCleanup({
  project = {},
  trees = [],
  primaryPath = "",
  ownPath = "",
  mainBranch = "",
} = {}) {
  const main = String(mainBranch || project?.mainBranch || "").trim() || "main";
  const primary = normKey(primaryPath || project?.path || "");
  const own = normKey(ownPath || "");
  const isPrimary = (p) => Boolean(primary) && normKey(p) === primary;
  // The own tree is the one the cwd sits IN, not one that sits under the cwd's folder. `ownPath` is the process's
  // cwd, and a panel started from the primary checkout has it AT the project root: `tree.startsWith(own + "/")` then
  // matched every worktree under the repo and marked all of them skip, so the chip read 0 to drop. The containment
  // has to be asked the other way round: `own.startsWith(tree + "/")` is "the cwd is inside this tree".
  const isOwn = (p) => {
    const key = normKey(p);
    return Boolean(own) && Boolean(key) && (key === own || own.startsWith(`${key}/`));
  };
  const rows = [];

  for (const tree of trees) {
    const row = {
      path: String(tree?.path || "").replace(/\\/g, "/"),
      branch: tree?.branch ? String(tree.branch) : null,
      head: tree?.head ? String(tree.head) : null,
      dirty: tree?.dirty === true,
      dirtyFiles: Array.isArray(tree?.dirtyFiles) ? tree.dirtyFiles.slice(0, 20) : [],
      ahead: Number(tree?.cherry?.ahead) || 0,
      behind: Number(tree?.behind) || 0,
      proof: { kind: "none", detail: "" },
      verdict: "keep",
      call: "keep",
      reason: "",
      merge: null,
    };
    row.proof = proofOf({ ...tree, main });

    // 1 and 2: the two trees this feature never touches.
    if (isPrimary(row.path)) {
      rows.push({ ...row, verdict: "skip", reason: "the project's primary checkout - the plan never touches it" });
      continue;
    }
    if (isOwn(row.path)) {
      rows.push({ ...row, verdict: "skip", reason: "the panel's own tree - its cwd is this folder, so nothing here may remove it" });
      continue;
    }
    // 2b: a tree of this REPOSITORY that sits outside the project's folder. The board never draws it as a row, so a
    // control here would be a control the row's own x does not have, over a tree the reader never saw on this card.
    if (tree?.outside === true) {
      rows.push({
        ...row,
        verdict: "skip",
        reason: `sits outside ${String(project?.path || "the project's checkout")} - a worktree of this repository that is not this project's to clean up`,
      });
      continue;
    }
    // 3: the reader's lock, named in its own words.
    if (tree?.locked === true) {
      rows.push({ ...row, verdict: "skip", reason: String(tree.lockReason || "locked by the reader - nothing may touch it") });
      continue;
    }
    // 4: a live job's shell is inside the tree.
    if (tree?.liveJob) {
      rows.push({ ...row, verdict: "skip", reason: `a live job holds it (${String(tree.liveJob)})` });
      continue;
    }
    // A directory that is not a tree of its own (lib/own-tree.js): git would answer for the checkout above it.
    if (tree?.notOwnTree) {
      rows.push({ ...row, verdict: "skip", reason: String(tree.notOwnTree) });
      continue;
    }
    // 6: nothing to judge.
    if (!row.branch) {
      rows.push({ ...row, verdict: "keep", reason: "no branch is checked out (detached HEAD) - there is no branch for the proof to be about" });
      continue;
    }
    // 5: the two protected names, before any count is read.
    const protection = branchProtection(row.branch, { ...project, mainBranch: main });
    if (protection) {
      rows.push({ ...row, verdict: "keep", reason: protection });
      continue;
    }
    // 7: landed by history.
    if (tree?.ancestor === true) {
      if (row.dirty) {
        rows.push({
          ...row,
          verdict: "keep",
          reason: `its commits are in ${main} but its tree holds uncommitted work (${row.dirtyFiles.length || "some"} file${row.dirtyFiles.length === 1 ? "" : "s"}) - remove the tree from its row's x first`,
        });
        continue;
      }
      rows.push({ ...row, verdict: "remove", call: "drop", reason: `already in ${main} by history, and the tree is clean` });
      continue;
    }
    // 8: landed by content. The proof must cover every commit main lacks: `equivalent === ahead`, not just
    // `unique === 0`, because `git cherry` prints no mark for a merge commit and that commit would go unjudged.
    if (tree?.cherry && tree.cherry.measured !== false && tree.cherry.ahead > 0 && tree.cherry.unique === 0 && Number(tree.cherry.equivalent) === Number(tree.cherry.ahead)) {
      if (row.dirty) {
        rows.push({
          ...row,
          verdict: "keep",
          reason: `its commits are cherry-equivalent in ${main} but its tree holds uncommitted work - remove the tree from its row's x first`,
        });
        continue;
      }
      rows.push({ ...row, verdict: "remove", call: "drop", reason: `every commit ${main} lacks is cherry-equivalent, and the tree is clean` });
      continue;
    }
    // 9 and 10: a branch with work main does not have.
    if (row.ahead > 0) {
      const base = String(project?.turnoverBranch || "").trim() || main;
      rows.push({
        ...row,
        verdict: "merge",
        merge: { base, treeKept: row.dirty },
        reason: row.dirty
          ? `${row.ahead} commit${row.ahead === 1 ? "" : "s"} ${main} lacks, and the tree is dirty: merge the branch into a child of ${base} and leave the tree, and never the working tree, alone`
          : `${row.ahead} commit${row.ahead === 1 ? "" : "s"} ${main} lacks: merge the branch --no-ff into a child of ${base}`,
      });
      continue;
    }
    // 11: nothing ahead, nothing to remove (its tree is not an ancestor of main, so this is a branch main already
    // has and a tree holding files).
    rows.push({
      ...row,
      verdict: "keep",
      reason: row.dirty
        ? `nothing for ${main} to take from it, but its tree holds uncommitted work - left alone`
        : `nothing for ${main} to take from it, and no proof it is safe to drop - left alone`,
    });
  }

  const counts = { remove: 0, merge: 0, keep: 0, skip: 0 };
  for (const row of rows) counts[row.verdict] = (counts[row.verdict] || 0) + 1;
  return {
    project: String(project?.name || ""),
    main,
    turnoverBranch: String(project?.turnoverBranch || "").trim() || null,
    primaryPath: String(primaryPath || project?.path || "").replace(/\\/g, "/"),
    ownPath: String(ownPath || "").replace(/\\/g, "/") || null,
    rows,
    counts,
    // The one number the chip shows: how many trees this plan would DROP.
    droppable: counts.remove,
  };
}

/** The same spelling every comparison in this repo uses: resolved-ish, forward slashes, case folded, no tail. */
function normKey(p) {
  const raw = String(p ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return raw.toLowerCase();
}
