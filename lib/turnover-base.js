// The third base-ref kind: a tree cut on a LOCAL TURNOVER BRANCH the panel has to FIND.
//
// The two kinds that came before this are NAMED, which is why they could be read off a file. `lib/jobs.js`
// `startRefOf` takes whatever branch the checkout is standing on; a project that names its turnover branch
// (`lib/project-turnover.js`, wired into the cut by ae6888ca) hands the cut a name from `config.json`. This kind has
// no name to read. The reader selects "local turnover branch - ask if none exist", and the branch is a fact about
// the repository at the moment of the cut, so the panel has to look for it.
//
// THREE CONDITIONS, ALL AT ONCE. Each one alone is a different way to be wrong:
//
//   1. the NAME is the turnover shape `YYYYMMDD_HHMM_<KEY>_<slug>`. That is not a second pattern: it is
//      `BRANCH_NAME_GATE_PATTERN` from lib/push-permissions.js, the one string the pre-push hook also greps, imported
//      here so a branch the push gate calls a turnover branch is a branch this resolver will consider (and the
//      reverse). A second copy of the pattern is how the two halves come to disagree about which branches are work.
//   2. a REMOTE carries a branch of that name. A branch that only exists on this machine has not been published
//      anywhere, so a child cut from it is a child of work nobody else can see, and pushing the child is the exact
//      remote write this option exists to avoid.
//   3. it is NOT an ancestor of main or master. An ancestor has LANDED: cutting from it and rolling back into it
//      would land the child's work on a branch main already carries, which is a merge into a landing branch with
//      extra steps. A merged branch passes 1 and 2 perfectly, which is why the check cannot be skipped.
//
// ASK, NEVER FALL BACK. When no branch passes all three the resolver answers `ok: false` with a question for the
// reader. It does NOT return main, the checkout's branch, or the newest branch that failed a test: silently cutting
// from main is the failure this option exists to prevent, and a cut that lands there has already done the thing the
// reader selected against. `lib/jobs.js` raises the question and refuses the cut; nothing leaves the machine.
//
// The rule is split in two so both halves can be proved without git: `pickTurnoverBase` is pure (lists in, branch
// or question out) and `resolveTurnoverBase` is the three git reads that fill those lists. `turnoverBaseBrief` is
// the paragraph the worker is handed, also pure: it is the fleet rule, not a repository read.
import { gitIn } from "./scan.js";
import { BRANCH_NAME_GATE_PATTERN } from "./push-permissions.js";
import { LOCAL_TURNOVER_KIND, LOCAL_TURNOVER_LABEL } from "./base-ref-kind.js";

/** The kind's stored value, on the project's `config.json` row (`baseRefKind`). The three kinds live together in
 *  lib/base-ref-kind.js; this is the third one, re-exported under the resolver's own name. */
export const TURNOVER_BASE_KIND = LOCAL_TURNOVER_KIND;

/** The option's label, the reader's words for what selecting this kind means. */
export const TURNOVER_BASE_LABEL = LOCAL_TURNOVER_LABEL;

/** The turnover shape, built from the push gate's own string. `main`/`master` are NOT turnover branches: the gate
 *  allows them separately (`BASE_BRANCHES`), and a resolver that took them here would offer main as a candidate.
 *
 *  ONE deliberate relaxation, and only one: the gate's slug class is lowercase (`[a-z0-9._-]+`) because it decides
 *  what may be PUBLISHED without asking, while a turnover branch's slug carries the reader's own words and a real
 *  one on this fleet is camelCase (`20261020_1624_DMR-39015_menuOAuth2Gateway`). The date/time/ticket half is still
 *  the gate's string, character for character, so the shape cannot drift; only the case class is widened, and
 *  `branchNamePassesGate` keeps the strict rule it had. */
const TURNOVER_NAME_RE = new RegExp(BRANCH_NAME_GATE_PATTERN.replace("[a-z0-9._-]+$", "[A-Za-z0-9._-]+$"));

/** One predicate for the first condition, exported so the prompt, the card and the tests cannot disagree about it. */
export function isTurnoverBranchName(name) {
  const branch = String(name ?? "").trim().replace(/^refs\/heads\//, "");
  if (!branch) return false;
  return TURNOVER_NAME_RE.test(branch);
}

const shortRef = (ref) =>
  String(ref ?? "")
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "");

// A remote-tracking ref's branch name: `origin/20261020_1624_DMR-39015_menuOAuth2Gateway` -> the branch name, and
// `origin/HEAD` -> null (it is a symbolic alias for a branch that is already in the list).
function branchOfRemoteRef(ref) {
  const short = shortRef(ref);
  const cut = short.indexOf("/");
  if (cut <= 0) return null;
  const tail = short.slice(cut + 1);
  if (!tail || tail === "HEAD") return null;
  return tail;
}

// THE RULE, without a repository. `locals` is every local branch name, `remotes` every branch name some
// remote-tracking ref carries, `merged` the local branch names that are ancestors of main or master. Every local
// branch is answered for in `rejected` when it is not chosen, so a reader asking "why not that one?" gets a reason
// instead of a silence.
//
// Two branches can qualify at once (a fleet may keep two turnover branches open). The name starts with the cut's own
// timestamp, so sorting descending takes the NEWEST first: `20261020_...` outranks `20260101_...` as text, and that
// is the whole ordering rule. No commit dates are read, because a rebase rewrites them and the name does not.
export function pickTurnoverBase({ locals = [], remotes = [], merged = [] } = {}) {
  const remoteSet = new Set((remotes || []).map(shortRef).filter(Boolean));
  const mergedSet = new Set((merged || []).map(shortRef).filter(Boolean));
  const seen = new Set();
  const candidates = [];
  const rejected = [];
  for (const raw of locals || []) {
    const name = shortRef(raw);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (!isTurnoverBranchName(name)) {
      rejected.push({ name, reason: "name", why: `${name} is not a turnover name (YYYYMMDD_HHMM_<KEY>_<slug>)` });
      continue;
    }
    if (!remoteSet.has(name)) {
      rejected.push({ name, reason: "unpushed", why: `${name} is not on any remote - a child of an unpublished branch is a child nobody else can see` });
      continue;
    }
    if (mergedSet.has(name)) {
      rejected.push({ name, reason: "merged", why: `${name} is already an ancestor of main or master - it has landed, so there is nothing to roll back into` });
      continue;
    }
    candidates.push(name);
  }
  candidates.sort().reverse();
  if (!candidates.length) return { ok: false, branch: null, candidates: [], rejected };
  return { ok: true, branch: candidates[0], candidates: [...candidates], rejected };
}

// The question a cut owes the reader when the repository has no branch that passes all three tests. One sentence a
// card can draw, the reason for every branch that was looked at, and what the reader can do about it. `choices` is
// deliberately empty: the answer is a branch name the panel has not seen, so a list of the rejects would offer the
// reader exactly the branches the rule just refused.
export function turnoverBaseQuestion({ repoDir = "", rejected = [] } = {}) {
  const where = String(repoDir || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const lines = (rejected || []).map((r) => `${r.name}: ${r.why}`);
  const detail =
    `No local turnover branch in ${where || "this repository"} passes all three tests - the turnover name ` +
    `YYYYMMDD_HHMM_<KEY>_<slug>, a remote branch of the same name, and not an ancestor of main or master - so nothing ` +
    `was cut instead of cutting from main: that fallback is the failure this option exists to prevent.` +
    (lines.length ? ` Every local branch was asked and refused: ${lines.join("; ")}.` : "") +
    " Name the branch to cut from, or push the turnover branch first.";
  return {
    title: `no local turnover branch to cut from in ${where || "this repository"}`,
    detail,
    choices: [],
    rejected: (rejected || []).map((r) => ({ ...r })),
  };
}

// The git half: three reads, then the pure rule.
//
//   `for-each-ref refs/heads`    every local branch. `%(refname:short)` is the name `worktree add` takes.
//   `for-each-ref refs/remotes`  what a remote carries, as branch names (`origin/x` -> `x`).
//   `merge-base --is-ancestor`   one call per candidate per base branch: the only honest answer to "has it landed".
//
// `mainBranch` is the project's own name for main, asked FIRST and then `main` and `master`, so a project whose
// landing branch is called something else is still measured against what the board calls its base. A local base
// branch missing (a fresh clone) falls back to `origin/main` / `origin/master`, because "no local main" is not
// "nothing has landed".
export async function resolveTurnoverBase({ repoDir = "", mainBranch = "main" } = {}) {
  const dir = String(repoDir || "").trim();
  const empty = { ok: false, branch: null, sha: null, remote: null, candidates: [], rejected: [] };
  if (!dir) return { ...empty, question: turnoverBaseQuestion({ repoDir: dir }) };

  const [localRefs, remoteRefs] = await Promise.all([
    gitIn(dir, ["for-each-ref", "--format=%(refname)", "refs/heads"], 20000),
    gitIn(dir, ["for-each-ref", "--format=%(refname)", "refs/remotes"], 20000),
  ]);
  // A read that failed is not an empty repository: answering "no branch qualifies" from a git error would ask the
  // reader a question about a repository the panel never managed to look at.
  if (!localRefs.ok) {
    return {
      ...empty,
      error: `could not read the local branches: ${String(localRefs.err || localRefs.out || "git failed")}`,
      question: {
        title: `could not read the branches of ${dir}`,
        detail: `The local turnover branch could not be looked for: ${String(localRefs.err || "git failed")}. Nothing was cut, and nothing fell back to main.`,
        choices: [],
        rejected: [],
      },
    };
  }
  const locals = localRefs.out ? localRefs.out.split("\n").map(shortRef).filter(Boolean) : [];
  const trackedRefs = remoteRefs.ok && remoteRefs.out ? remoteRefs.out.split("\n").map(shortRef).filter(Boolean) : [];
  const remotes = trackedRefs.map(branchOfRemoteRef).filter(Boolean);

  // The base branches that exist here, local first, then the remote-tracking spelling of the same two names.
  const bases = [];
  const want = [...new Set([String(mainBranch || "").trim(), "main", "master"].filter(Boolean))];
  for (const name of want) if (locals.includes(name)) bases.push(`refs/heads/${name}`);
  for (const name of want) {
    const tracked = remotes.includes(name) ? `refs/remotes/origin/${name}` : null;
    if (tracked) bases.push(tracked);
  }

  // Only a branch that already passed the first two tests costs an ancestry call: a feature branch is refused by its
  // name, and an unpushed one by the remote read, without asking git about ancestry at all.
  //
  // The question is asked as DATA, not as an exit status: `git rev-list --count <base>..<candidate>` prints how many
  // of the candidate's commits the base does not already carry, so 0 IS "it has landed". `merge-base --is-ancestor`
  // answers the same thing with an exit code, and this panel's git helper reports a benign exit 1 as a failure with
  // no way to tell it from a real one - which would turn every unmerged candidate into "could not tell".
  const provisional = pickTurnoverBase({ locals, remotes, merged: [] });
  const merged = [];
  for (const name of provisional.candidates) {
    for (const base of bases) {
      const r = await gitIn(dir, ["rev-list", "--count", `${base}..refs/heads/${name}`], 15000);
      if (!r.ok) {
        return {
          ...empty,
          error: `could not tell whether ${name} has landed: ${String(r.err || r.out)}`,
          question: {
            title: `could not tell whether ${name} has landed`,
            detail: `Checking ${name} against ${base} failed: ${String(r.err || r.out)}. Nothing was cut, and nothing fell back to main.`,
            choices: [],
            rejected: [],
          },
        };
      }
      const ahead = Number(String(r.out || "").trim());
      if (Number.isFinite(ahead) && ahead === 0) {
        merged.push(name);
        break;
      }
    }
  }

  const picked = pickTurnoverBase({ locals, remotes, merged });
  if (!picked.ok) return { ...empty, rejected: picked.rejected, question: turnoverBaseQuestion({ repoDir: dir, rejected: picked.rejected }) };

  const branch = picked.branch;
  const shaRead = await gitIn(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], 15000);
  const sha = String(shaRead.out || "").trim().toLowerCase();
  // The remote-tracking ref that carries the branch, `origin` first because that is the panel's own convention.
  const carrying = trackedRefs.filter((ref) => ref.endsWith(`/${branch}`));
  const remote = carrying.find((ref) => ref === `origin/${branch}`) || carrying[0] || null;
  return {
    ok: true,
    branch,
    sha: /^[0-9a-f]{40,64}$/.test(sha) ? sha : null,
    remote,
    candidates: picked.candidates,
    rejected: picked.rejected,
  };
}

// THE BRIEF, for a run whose tree was cut on this kind. It is the fleet rule in the worker's own words: the child
// stays on this machine and is rolled back into its parent turnover branch by fast-forward, so the two remote writes
// that would break that - pushing the child, and cutting a new remote branch - are named and refused. The three tests
// are restated because the worker may need to find the branch again (a later turn in the same tree, a rebase, a
// question to the reader) and the paragraph is the only place it is told how.
export function turnoverBaseBrief({ branch = "", repoDir = "" } = {}) {
  const name = String(branch || "").trim();
  const where = String(repoDir || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const ours = name ? "`" + name + "`" : "this run's parent";
  const target = name ? `\`${name}\`` : "that branch";
  const ancestry = "`git merge-base --is-ancestor " + (name || "<branch>") + " main`";
  return (
    `TURNOVER BASE: this tree was cut on the local turnover branch ${ours}${where ? ` (${where})` : ""} - a local ` +
    "branch whose name matches YYYYMMDD_HHMM_<KEY>_<slug>, which is also pushed to a remote, and which is not an " +
    "ancestor of main or master. Find it again with those three tests: `git branch --list '[0-9]*_[0-9]*_*-*_*'`, " +
    "`git branch -r --list` for the same name on a remote, and " + ancestry + " (exit 0 means it has landed and is " +
    "not a turnover branch to roll into). " +
    "Do not push this tree's branch and do not cut a new remote branch: this child stays local, and when the work is " +
    `done it is rolled back into ${target} by fast-forward - \`git checkout ${name || "<branch>"} && git merge --ff-only ` +
    `${"<this tree's branch>"}\` - never by a merge commit and never through the remote.`
  );
}
