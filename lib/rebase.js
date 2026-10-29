// Rebasing one worktree's branch onto the newest commit of the branch it was cut from.
//
// WHY THIS IS NOT AN AGENT. `git rebase <target>` is one deterministic command: git itself reports the replay, the
// up-to-date answer or the conflict, in about a tenth of a second and for no tokens. An agent would turn that into a
// minute-long run with a bill, and the only case that needs judgement — a conflict — is answered better by ABORTING:
// the tree was clean when the rebase started, so the abort puts it back byte for byte and hands the reader the
// colliding paths. That is the same rule lib/merge-prompt.js already gives its merge agent (PHASE 2: abort, leave both
// trees as you found them, report the colliding paths); the difference is that here nobody has to be told it twice.
//
// THE ONE HARD QUESTION IS THE TARGET, and it is a question about HISTORY, not about refs. `git rebase T` replays every
// commit in `merge-base(HEAD, T)..HEAD` onto T. Targeting the wrong ref therefore does not "bring the parent in", it
// REPLAYS THE PARENT'S OWN COMMITS AS NEW WORK: a child cut from feature/X and rebased onto main replays all of
// feature/X on top of main, and landing that branch lands X's history under the child's name. So a candidate ref is
// only accepted when every commit it would replay belongs to THIS branch alone — none of them is reachable from any
// other local branch. One `rev-list` per candidate buys that proof, and it is stronger than a provenance check: a
// recorded cut, a reflog's `Created from`, and a backfilled parent all have to pass the same test, and a ref that
// passes it is safe whatever it is called.
//
// What this module does NOT do: touch the parent, the base branch, the remote or the index of any other tree. A rebase
// writes exactly one branch — the one checked out in the worktree it runs in.
import { existsSync } from "node:fs";
import { gitIn } from "./scan.js";

const oneLine = (s, max = 300) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const short = (sha) => String(sha ?? "").slice(0, 7);

// The candidate refs, most specific first. A parent is only pushed when it is a real branch name: `lib/parents.js`
// already answers null for a main branch (main is a turnover destination, never a child's parent), and a tree cut from
// main catches up against the base ref instead — which is also the ref the board measures every row against.
export function candidateRefs({ branch = "", parent = null, baseRef = null, mainBranch = null } = {}) {
  const out = [];
  const push = (ref) => {
    const r = String(ref ?? "").trim();
    if (!r || r === "HEAD") return;
    if (r === String(branch ?? "").trim()) return;
    if (!out.includes(r)) out.push(r);
  };
  // The recorded parent first: it is the branch this tree's work belongs on, and a child rebased onto its parent's
  // tip rolls up (or fast-forwards) with no merge commit at all — which is the whole point of the control.
  push(parent);
  push(baseRef);
  push(mainBranch);
  return out;
}

// The decision, over facts the caller has already read from git, so it is testable without a repo.
//
// Each candidate carries: ref, sha (the tip, null when the ref does not resolve), mergeBase (merge-base with HEAD, null
// when they share no history), replay (commits in mergeBase..HEAD), foreign (how many of those replay commits are also
// reachable from another local branch) and foreignOn (their names, for the refusal).
export function pickPlan({ branch = "", candidates = [] } = {}) {
  const tried = [];
  for (const c of candidates || []) {
    const ref = String(c?.ref || "").trim();
    if (!ref) continue;
    if (!c.sha) {
      tried.push({ ref, why: "no such ref in this repo" });
      continue;
    }
    if (!c.mergeBase) {
      tried.push({ ref, why: "shares no history with this branch" });
      continue;
    }
    const replay = Number(c.replay) || 0;
    // The ownership proof runs BEFORE the up-to-date answer, and the order is the point. "The target's tip is already
    // inside HEAD" sounds like "nothing to do" — `git rebase <target>` really would print "is up to date" — but it is
    // also true of a child cut from a feature branch when the base has not moved since, and there the range still
    // carries the parent's commit. Answering "nothing to replay" first would hide which branch that history belongs
    // to and leave the reader with a button that quietly does nothing; refusing on ownership names the parent instead.
    const foreign = Number(c.foreign) || 0;
    if (foreign > 0) {
      const who = c.foreignOn ? ` (${c.foreignOn})` : "";
      tried.push({
        ref,
        why: `replaying onto ${ref} would carry ${foreign} commit${foreign === 1 ? "" : "s"} this branch does not own${who} — that history belongs to another branch`,
      });
      continue;
    }
    // Everything the replay would move is this branch's own, and the target's tip is already inside HEAD: git would
    // print "is up to date" and change nothing, so this is the honest "already caught up" answer rather than a button
    // that looks like it acted.
    if (c.mergeBase === c.sha || replay === 0) {
      tried.push({ ref, why: `this branch already contains ${ref}'s tip — nothing to replay` });
      continue;
    }
    return {
      ok: true,
      target: ref,
      targetSha: c.sha,
      mergeBase: c.mergeBase,
      replay,
      tried,
      why: `replays this branch's own ${replay} commit${replay === 1 ? "" : "s"} onto ${ref}`,
    };
  }
  // Nothing passed: say the sharpest thing learned, preferring the ownership refusal because it is the one that
  // explains a real hazard rather than a ref that happens to be level.
  const foreign = tried.find((t) => /would carry/.test(t.why));
  const why = (foreign || tried[0] || { why: "no ref to rebase onto was resolved" }).why;
  return { ok: false, refused: foreign ? "foreign" : "none", error: `refused: ${why}`, tried };
}

// Every local branch except this one, as full refs, because `--not` wants unambiguous names and a branch name may
// contain a slash. Remotes are deliberately absent: a pushed copy of this branch holds the very commits we mean to
// replay, and counting it as a foreign owner would refuse every published tree.
async function otherLocalRefs(worktree, branch) {
  const r = await gitIn(worktree, ["for-each-ref", "--format=%(refname)", "refs/heads"]);
  if (!r.ok) return [];
  const mine = `refs/heads/${String(branch ?? "").trim()}`;
  return r.out
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && s !== mine);
}

// Which local branches hold the commits a replay would move. Only asked on the refusal path (a foreign commit is
// rare and the answer is a sentence the reader acts on), so one extra process there is cheap.
async function foreignOwners(worktree, commits, branch = "") {
  const names = new Set();
  for (const sha of commits.slice(0, 3)) {
    const r = await gitIn(worktree, ["branch", "--contains", sha, "--format=%(refname:short)"], 20000);
    if (!r.ok) continue;
    for (const line of r.out.split("\n")) {
      const name = line.trim();
      // This branch holds its own commits by definition; naming it as a co-owner would make the refusal read as a
      // contradiction ("feat/x and side hold it — that history belongs to another branch").
      if (name && name !== String(branch || "").trim()) names.add(name);
    }
  }
  return [...names].slice(0, 3).join(", ");
}

// The read half: resolve every candidate, prove what each one would replay, and let pickPlan choose. Read-only.
export async function planRebase({ worktree, branch = "", candidates = [] } = {}) {
  const others = await otherLocalRefs(worktree, branch);
  const facts = [];
  for (const ref of candidates) {
    const sha = await gitIn(worktree, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], 20000);
    if (!sha.ok || !sha.out) {
      facts.push({ ref, sha: null });
      continue;
    }
    const mb = await gitIn(worktree, ["merge-base", "HEAD", ref], 20000);
    if (!mb.ok || !mb.out) {
      facts.push({ ref, sha: sha.out, mergeBase: null });
      continue;
    }
    const count = await gitIn(worktree, ["rev-list", "--count", `${mb.out}..HEAD`], 20000);
    const replay = count.ok ? Number.parseInt(count.out, 10) || 0 : 0;
    let foreign = 0;
    let foreignOn = "";
    if (others.length && replay > 0) {
      // The proof: the commits in that range that no other local branch holds. `--not` flips the meaning of the refs
      // after it, so the range keeps its own meaning and the answer is "what only this branch has".
      const own = await gitIn(worktree, ["rev-list", `${mb.out}..HEAD`, "--not", ...others], 20000);
      const ownSet = new Set(own.ok ? own.out.split("\n").filter(Boolean) : []);
      if (ownSet.size < replay) {
        // Something in the range is shared. WHICH shared commits matter: one on HEAD's FIRST-PARENT spine is history
        // this branch inherited from where it was cut (a wrong target would replay it as new work), while one off
        // that spine arrived through a merge this branch made on purpose and is part of its own story. The spine is
        // what tells a parent's commits from a side branch the tree merged in.
        const [all, spine] = await Promise.all([
          gitIn(worktree, ["rev-list", `${mb.out}..HEAD`], 20000),
          gitIn(worktree, ["rev-list", "--first-parent", `${mb.out}..HEAD`], 20000),
        ]);
        const spineSet = new Set(spine.ok ? spine.out.split("\n").filter(Boolean) : []);
        const carried = (all.ok ? all.out.split("\n").filter(Boolean) : []).filter((c) => !ownSet.has(c) && spineSet.has(c));
        foreign = carried.length;
        if (foreign > 0) foreignOn = await foreignOwners(worktree, carried, branch);
      }
    }
    facts.push({ ref, sha: sha.out, mergeBase: mb.out, replay, foreign, foreignOn });
  }
  return { ...pickPlan({ branch, candidates: facts }), candidates: facts };
}

// A rebase already open in this tree. Two replays in one index is a stuck checkout, and the reader would then be
// reading conflict markers the panel never wrote.
export async function rebaseInProgress(worktree) {
  for (const kind of ["rebase-merge", "rebase-apply"]) {
    const p = await gitIn(worktree, ["rev-parse", "--git-path", kind], 15000);
    if (p.ok && p.out && existsSync(p.out)) return kind;
  }
  return null;
}

// The write half. Everything it can refuse for is read from git HERE, not from the row the page drew: the board is a
// scan behind, and a stale scan is exactly what would start a replay over somebody's uncommitted work.
export async function rebaseOn({ worktree, branch = "", plan, log = () => {} } = {}) {
  if (!plan || !plan.ok) return { ok: false, error: plan?.error || "no rebase plan" };
  const open = await rebaseInProgress(worktree);
  if (open) {
    return {
      ok: false,
      refused: "in-progress",
      error: `refused: this worktree already has a rebase open (${open}) — finish it with \`git rebase --continue\` or drop it with \`git rebase --abort\` first`,
    };
  }
  const before = await gitIn(worktree, ["rev-parse", "HEAD"], 15000);
  if (!before.ok || !before.out) return { ok: false, error: `cannot read HEAD in ${worktree}` };
  // A branch that carries merge commits of its own is replayed with its topology intact: a plain rebase flattens those
  // merges, and the resolutions they carry are work somebody did by hand. Linear branches take the plain path.
  const merges = await gitIn(worktree, ["rev-list", "--count", "--merges", `${plan.mergeBase}..HEAD`], 20000);
  const hasMerges = merges.ok && (Number.parseInt(merges.out, 10) || 0) > 0;
  const args = ["-c", "rebase.autoStash=false", "-c", "rebase.autoSquash=false", "rebase"];
  if (hasMerges) args.push("--rebase-merges");
  args.push(plan.target);
  log(`rebase: ${branch || "branch"} onto ${plan.target} (${plan.replay} to replay${hasMerges ? ", merge commits kept" : ""})`);
  const r = await gitIn(worktree, args, 120000);
  if (r.ok) {
    const after = await gitIn(worktree, ["rev-parse", "HEAD"], 15000);
    const contains = await gitIn(worktree, ["merge-base", "--is-ancestor", plan.targetSha, "HEAD"], 15000);
    const settled = contains.ok; // exit 0 means the target really is an ancestor of the new tip
    return {
      ok: true,
      method: hasMerges ? "rebase-merges" : "rebase",
      target: plan.target,
      targetSha: plan.targetSha,
      from: before.out,
      to: after.ok ? after.out : null,
      fromShort: short(before.out),
      toShort: after.ok ? short(after.out) : null,
      replayed: plan.replay,
      containsTarget: settled,
      output: oneLine(r.out),
    };
  }
  // Not every failure is a conflict ("cannot rebase: You have unstaged changes" comes back the same way), so the
  // conflicted paths are read first: they are what makes this a CONFLICT rather than a command git would not run.
  const unmerged = await gitIn(worktree, ["diff", "--name-only", "--diff-filter=U"], 20000);
  const files = unmerged.ok ? unmerged.out.split("\n").filter(Boolean) : [];
  const conflict = files.length > 0 || /CONFLICT/i.test(`${r.out}\n${r.err}`);
  if (!conflict) {
    return { ok: false, refused: "git", error: oneLine(r.err || r.out) || "git refused the rebase", files: [], from: before.out };
  }
  // The tree was clean when this started, so the abort restores it exactly; the paths are kept for the report, which
  // is the only place they are still readable.
  const abort = await gitIn(worktree, ["rebase", "--abort"], 60000);
  const status = await gitIn(worktree, ["status", "--porcelain"], 20000);
  const clean = status.ok && status.out === "";
  const head = await gitIn(worktree, ["rev-parse", "HEAD"], 15000);
  return {
    ok: false,
    refused: "conflict",
    conflict: true,
    aborted: abort.ok,
    clean,
    files,
    from: before.out,
    unchanged: head.ok && head.out === before.out,
    error:
      `the rebase conflicted on ${files.length ? files.slice(0, 6).join(", ") : "this branch's commits"}` +
      (abort.ok && clean ? " — it was aborted and the tree is exactly as it was" : " — and the abort did not come back clean, so read this tree before doing anything else"),
    output: oneLine(`${r.out}\n${r.err}`),
  };
}

// Plan then act, in one call, for the route. `dryRun` reads and decides only.
export async function rebaseWorktree({
  worktree,
  branch = "",
  parent = null,
  baseRef = null,
  mainBranch = null,
  dryRun = false,
  log = () => {},
} = {}) {
  const refs = candidateRefs({ branch, parent, baseRef, mainBranch });
  if (!refs.length) return { ok: false, refused: "none", error: "refused: there is no ref this branch could be rebased onto" };
  const plan = await planRebase({ worktree, branch, candidates: refs });
  if (!plan.ok) return { ...plan, refs };
  // `replayed` is the field the route's real press answers with, so the dry run carries it too: the page and any probe
  // read one name for one question, instead of `replay` here and `replayed` there.
  if (dryRun) return { ...plan, dryRun: true, replayed: plan.replay, refs };
  const out = await rebaseOn({ worktree, branch, plan, log });
  return { ...out, refs, plan: { target: plan.target, replay: plan.replay, why: plan.why } };
}
