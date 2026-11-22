// THE MERGE PROBE: git's own answer to "which side can go first", in both directions, against a pair's two tips.
//
// WHY THIS EXISTS. A collision used to be a card the reader had to rule on, one at a time, and the reader's own
// estimate is that 99 percent of them do not need him: two trees touching one file rarely disagree about the content,
// and the ORDER that makes the merge harder is git's question. `git merge-tree --write-tree` performs a whole merge in
// the object database - no checkout, no working file, no branch moved, no model, no worker turn - and exits 1 when the
// merge would conflict. That exit code is the fact this module reads.
//
// TWO DIRECTIONS, because the panel rules on an ORDER. `aFirst` asks the merge that would happen if A landed first and
// B then merged onto it, i.e. `merge-tree <A> <B>` (git's first branch is the target). `bFirst` is the same question
// with the sides swapped. A clean `aFirst` is proof that A can go first and B still merges without a conflict; the
// reverse direction says the same for B. Everything the sweep then does with the two answers is pure and lives in
// lib/collisions.js (`settleCollision`), which is why this file has no opinion about who should land.
//
// THE TIE-BREAK FACTS travel with the answer, but only when both directions are clean (the only case that needs them):
// the commits each side carries since the merge base, and the cut - the oldest reflog entry for the branch, which is
// the moment its line began ("branch: Created from ..."), falling back to the side's first own commit. The reader's
// order is older cut first, then fewer commits, then the branch name (`lib/collisions.js` `deterministicPick`).
//
// BOUNDED AND OFF THE NETWORK. Each call is a git process against a local repository, with a timeout and with the
// credential prompts switched off; a git older than 2.38 (no `merge-tree --write-tree`) exits 129 and the direction
// reads `clean: null` - "git could not answer" - which never turns into a ruling. The sweep probes only a pair it has
// not settled, and only up to its own per-sweep budget, so a board full of overlaps cannot turn one tick into a queue
// of processes.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { classifyVersionOnly } from "./collisions.js";

const MAX_BUFFER = 8 * 1024 * 1024;
// A conflict list is evidence, not a log: the card names the first few paths and the count is what the reader reads.
export const MERGE_CONFLICT_CAP = 24;

const text = (value) => String(value ?? "").replace(/\r\n/g, "\n").trim();

function git(cwd, args, timeout) {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout,
      windowsHide: true,
      maxBuffer: MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
    });
    return { status: 0, out: text(out), err: "" };
  } catch (error) {
    // `status` is git's own exit code. A timeout or a missing binary has none, and must never be read as a conflict
    // (exit 1) or as a clean merge (exit 0): null is "git could not answer".
    return {
      status: typeof error?.status === "number" ? error.status : null,
      out: text(error?.stdout),
      err: text(error?.stderr || error?.message),
    };
  }
}

/** A rev as the commit it points at, or null. Never a branch name: a name can move between the detection and the probe. */
function commitOf(cwd, rev, timeout) {
  const want = text(rev);
  if (!want) return null;
  const run = git(cwd, ["rev-parse", "--verify", "--quiet", `${want}^{commit}`], timeout);
  if (run.status !== 0) return null;
  const sha = run.out.split("\n").filter(Boolean).pop() || "";
  return /^[0-9a-f]{40,64}$/i.test(sha) ? sha.toLowerCase() : null;
}

// `merge-tree --write-tree --name-only --no-messages` prints the resulting tree on the first line and, on a conflict,
// the conflicted paths under it, then a blank line. Only that block is read, so an informational message can never be
// mistaken for a path.
export function mergeConflictPaths(output = "") {
  const lines = text(output).split("\n");
  const paths = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) break;
    paths.push(line);
  }
  return [...new Set(paths)].slice(0, MERGE_CONFLICT_CAP);
}

function direction(repo, ours, theirs, timeout) {
  const run = git(repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", ours, theirs], timeout);
  if (run.status === 0) return { clean: true, conflicts: [], error: null };
  if (run.status === 1) return { clean: false, conflicts: mergeConflictPaths(run.out), error: null };
  return {
    clean: null,
    conflicts: [],
    error: text(run.err || run.out).split("\n")[0].slice(0, 300) || `git exited ${run.status === null ? "without a code" : run.status}`,
  };
}

/** The moment a side's line began: the oldest reflog entry for its branch, then its first own commit, then nothing. */
function cutOf(repo, side, tip, base, timeout) {
  const branch = text(side?.branch).replace(/^refs\/heads\//, "");
  if (branch) {
    const log = git(repo, ["reflog", "show", "--date=unix", "--format=%gd", `refs/heads/${branch}`], timeout);
    if (log.status === 0) {
      const lines = log.out.split("\n").map((line) => line.trim()).filter(Boolean);
      const oldest = lines[lines.length - 1] || "";
      const at = /@\{(\d{9,12})\}/.exec(oldest);
      if (at) return Number(at[1]) * 1000;
    }
  }
  if (!base) return null;
  const log = git(repo, ["log", "--format=%ct", "--reverse", `${base}..${tip}`], timeout);
  if (log.status !== 0) return null;
  const first = log.out.split("\n").map((line) => line.trim()).find(Boolean);
  const stamp = Number(first);
  return Number.isFinite(stamp) && stamp > 0 ? stamp * 1000 : null;
}

function sideFacts(repo, side, tip, base, timeout) {
  let commits = null;
  if (base) {
    const count = git(repo, ["rev-list", "--count", `${base}..${tip}`], timeout);
    const n = Number(count.out);
    if (count.status === 0 && Number.isFinite(n) && n >= 0) commits = n;
  }
  return { commits, cutAt: cutOf(repo, side, tip, base, timeout) };
}

/**
 * Ask git about ONE pair. `pair.a` and `pair.b` are the record's sides (path, branch and the scanned tip in `head`).
 * Answers `{ok, at, repo, tips, mergeBase, aFirst, bFirst, a, b, error}`: `aFirst.clean` is `true`, `false`, or `null`
 * when git could not answer. `ok` is false only when there is no repository or a tip the repo cannot resolve.
 */
export function probePairMerge(pair = {}, { timeout = 8000, now = () => new Date() } = {}) {
  const at = now().toISOString();
  const a = pair?.a || null;
  const b = pair?.b || null;
  const repo = text(a?.path || b?.path).replace(/\\/g, "/");
  const fail = (error) => ({ ok: false, at, repo: repo || null, tips: null, mergeBase: null, aFirst: null, bFirst: null, a: null, b: null, error });
  if (!repo) return fail("the pair names no tree, so there is no repository to ask");
  const tipA = commitOf(repo, a?.head || a?.branch, timeout);
  const tipB = commitOf(repo, b?.head || b?.branch, timeout);
  if (!tipA || !tipB) {
    const which = !tipA ? a?.name || a?.branch || "the first side" : b?.name || b?.branch || "the second side";
    return fail(`the tip of ${which} does not resolve in ${repo}, so git cannot be asked`);
  }
  // A first means B merges ONTO A: git's first branch is the target of the merge, so A is passed first.
  const aFirst = direction(repo, tipA, tipB, timeout);
  const bFirst = direction(repo, tipB, tipA, timeout);
  const baseRun = git(repo, ["merge-base", tipA, tipB], timeout);
  const mergeBase = baseRun.status === 0 ? baseRun.out.split("\n").map((l) => l.trim()).find(Boolean) || null : null;
  // The tie-break facts are only worth two more git calls when the answer is "either order is clean".
  const bothClean = aFirst.clean === true && bFirst.clean === true;
  return {
    ok: true,
    at,
    repo,
    tips: { a: tipA, b: tipB },
    mergeBase,
    aFirst,
    bFirst,
    a: bothClean ? sideFacts(repo, a, tipA, mergeBase, timeout) : null,
    b: bothClean ? sideFacts(repo, b, tipB, mergeBase, timeout) : null,
    error: null,
  };
}

/**
 * THE FILES BOTH SIDES CHANGED, measured. A reported note carries a sentence, not evidence: two trees whose
 * branches both edit the same path is the fact a reader can act on, and git answers it from the object database
 * without a checkout. `git diff --name-only <merge base> <tip>` is each side's own change set; the intersection is
 * what the card prints. An empty set is a real answer ("no shared file"), not a failure - `ok` separates the two,
 * so the card can say which one it is instead of showing nothing.
 */
export function probeSharedFiles(pair = {}, { timeout = 8000, now = () => new Date() } = {}) {
  const at = now().toISOString();
  const a = pair?.a || null;
  const b = pair?.b || null;
  const repo = text(a?.path || b?.path).replace(/\\/g, "/");
  const fail = (error) => ({ ok: false, at, repo: repo || null, base: null, a: [], b: [], files: [], error });
  if (!repo || !a?.path || !b?.path) return fail("the pair does not name two trees, so there is nothing to measure");
  const tipA = commitOf(repo, a?.head || a?.branch, timeout);
  const tipB = commitOf(repo, b?.head || b?.branch, timeout);
  if (!tipA || !tipB) return fail("a tip of the pair does not resolve in the repository, so the files cannot be measured");
  const baseRun = git(repo, ["merge-base", tipA, tipB], timeout);
  const base = baseRun.status === 0 ? baseRun.out.split("\n").map((l) => l.trim()).find(Boolean) || null : null;
  if (!base) return fail("the two tips share no merge base, so the files cannot be measured");
  const changed = (tip) => {
    const run = git(repo, ["diff", "--name-only", base, tip], timeout);
    if (run.status !== 0) return null;
    return run.out.split("\n").map((l) => l.trim()).filter(Boolean).map((p) => p.replace(/\\/g, "/").toLowerCase());
  };
  const left = changed(tipA);
  const right = changed(tipB);
  if (!left || !right) return fail("git could not list the files either branch changed, so the overlap cannot be measured");
  const set = new Set(right);
  const files = [...new Set(left.filter((p) => set.has(p)))].sort().slice(0, MERGE_CONFLICT_CAP);
  return { ok: true, at, repo, base, a: left.slice(0, MERGE_CONFLICT_CAP), b: right.slice(0, MERGE_CONFLICT_CAP), files, error: null };
}

/**
 * IS THIS SIDE'S TIP ALREADY IN MAIN, and when did it land? A collision report that predates the landing of the
 * branch it names is describing work that is over. `merge-base --is-ancestor` is the fact; the first commit on the
 * ancestry path from the tip to main is the landing that carried it (a `--no-ff` merge commit names the landing
 * itself, and its committer date is when the landing happened). A rebase or cherry-pick rewrites the branch's
 * commits, so the tip is not an ancestor - that is not an error, it is a landing this question cannot date, and the
 * card stays as it was rather than guessing.
 */
export function probeLanded(side = {}, { main = "main", timeout = 8000, now = () => new Date() } = {}) {
  const at = now().toISOString();
  const repo = text(side?.path).replace(/\\/g, "/");
  const want = text(main) || "main";
  const fail = (error) => ({ ok: false, at, repo: repo || null, main: want, mainRef: null, tip: null, landed: false, commit: null, landedAt: null, error });
  if (!repo) return fail("the side names no tree, so there is no repository to ask");
  const tip = commitOf(repo, side?.head || side?.branch, timeout);
  if (!tip) return fail("the side's tip does not resolve in the repository, so the landing cannot be checked");
  // The project's main, whichever ref this checkout actually carries: a local branch, the remote-tracking one, or a
  // bare name the repository resolves another way. The first that resolves is the one the answer is about.
  let mainRef = null;
  let mainTip = null;
  for (const ref of [`refs/heads/${want}`, `refs/remotes/origin/${want}`, want]) {
    const got = commitOf(repo, ref, timeout);
    if (got) {
      mainRef = ref;
      mainTip = got;
      break;
    }
  }
  if (!mainTip) return fail(`the repository has no ${want}, so there is no landing to compare with`);
  const ancestor = git(repo, ["merge-base", "--is-ancestor", tip, mainTip], timeout);
  if (ancestor.status === 1) return { ok: true, at, repo, main: want, mainRef, tip, registered: tip, landed: false, commit: null, landedAt: null, error: null };
  if (ancestor.status !== 0) return fail(text(ancestor.err || ancestor.out).split("\n")[0].slice(0, 300) || "git could not answer whether the tip is in main");
  // The first commit after the tip on a path to main. An empty list means the tip IS main's tip.
  const path = git(repo, ["rev-list", "--ancestry-path", "--reverse", `${tip}..${mainTip}`], timeout);
  const landing = path.status === 0 ? path.out.split("\n").map((l) => l.trim()).find(Boolean) || mainTip : mainTip;
  const when = git(repo, ["show", "-s", "--format=%ct", landing], timeout);
  const stamp = Number(when.out.split("\n").map((l) => l.trim()).find(Boolean));
  return {
    ok: true,
    at,
    repo,
    main: want,
    mainRef,
    tip,
    landed: true,
    commit: landing,
    landedAt: Number.isFinite(stamp) && stamp > 0 ? new Date(stamp * 1000).toISOString() : null,
    error: null,
  };
}

// One side's copy of a shared manifest: the working file when it is on disk, otherwise the blob at the side's tip.
// The working copy comes first because a landing bump can still be uncommitted when the pair is seen, and it is the
// cheap read - no git process at all for the ordinary case. Both readings go through `text`, so a CRLF tree and an LF
// tree are compared as the same file.
function sideText(side, file, timeout) {
  const tree = text(side?.path).replace(/\\/g, "/");
  if (!tree) return { text: null, source: null };
  try {
    return { text: text(readFileSync(path.join(tree, file), "utf8")), source: "worktree" };
  } catch {
    // Not on disk in this tree: the tip it committed is the other half of the same side.
  }
  const tip = commitOf(tree, side?.head || side?.branch, timeout);
  if (!tip) return { text: null, source: null };
  const show = git(tree, ["show", `${tip}:${file}`], timeout);
  return show.status === 0 ? { text: show.out, source: "tip" } : { text: null, source: null };
}

/**
 * IS THE OVERLAP A MANIFEST'S VERSION LINE AND NOTHING ELSE? Two live trees both claiming the next patch above main
 * "share" package.json and disagree about nothing but the number, which is what the land step settles by rebasing onto
 * the current main and keeping the higher version. The decision itself is pure (`lib/collisions.js`
 * `classifyVersionOnly`); this function only reads the files it needs, one copy per side per shared path.
 *
 * `ok` false means a copy could not be read - an answer the caller must not turn into "not a version line", because
 * that would put a pair back in front of the reader on the strength of a failed read.
 */
export function probeVersionOnly(pair = {}, { timeout = 8000, now = () => new Date() } = {}) {
  const at = now().toISOString();
  const a = pair?.a || null;
  const b = pair?.b || null;
  const repo = text(a?.path || b?.path).replace(/\\/g, "/");
  const files = [...new Set((pair?.files || []).map((file) => text(file).replace(/\\/g, "/").toLowerCase()).filter(Boolean))].slice(0, MERGE_CONFLICT_CAP);
  const fail = (error) => ({ ok: false, at, repo: repo || null, versionOnly: false, files, versions: null, pick: null, why: error, error });
  if (!repo || !a?.path || !b?.path) return fail("the pair does not name two trees, so there is nothing to read");
  if (!files.length) return fail("the pair names no shared file");
  const contents = {};
  for (const file of files) {
    const one = sideText(a, file, timeout);
    const two = sideText(b, file, timeout);
    if (one.text === null || two.text === null) {
      const which = one.text === null ? text(a?.name || a?.path) : text(b?.name || b?.path);
      return fail(`the ${file} in ${which} could not be read, so the overlap cannot be classified`);
    }
    contents[file] = { a: one.text, b: two.text };
  }
  const verdict = classifyVersionOnly({ files, contents });
  return {
    ok: verdict.ok,
    at,
    repo,
    versionOnly: verdict.versionOnly,
    files,
    versions: verdict.versions || null,
    pick: verdict.pick || null,
    why: verdict.why || null,
    error: verdict.ok ? null : verdict.why || "the overlap could not be classified",
  };
}

/**
 * THE WORKTREES GIT ACTUALLY REGISTERS. A directory under `.worktrees/` can outlive its registration: the branch is
 * deleted, `git worktree remove` refuses because a dead run's child still holds a file ("Permission denied"), and what
 * is left is a folder git no longer lists. Such a tree cannot be a side of anything - it has no branch to land, no
 * worker to stand down and no answer to give - so the sweep marks the pair absent instead of asking the reader about
 * it. This function only READS: a sweep never removes a directory, and a path it does not find is a fact about the
 * repository, not permission to delete anything.
 */
export function registeredWorktrees(repoPath, { timeout = 8000 } = {}) {
  const repo = text(repoPath).replace(/\\/g, "/");
  if (!repo) return { ok: false, paths: [], error: "no repository to ask" };
  const run = git(repo, ["worktree", "list", "--porcelain"], timeout);
  if (run.status !== 0) {
    return { ok: false, paths: [], error: text(run.err || run.out).split("\n")[0].slice(0, 300) || "git could not list the worktrees" };
  }
  const paths = [];
  for (const line of run.out.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("worktree ")) paths.push(trimmed.slice("worktree ".length).replace(/\\/g, "/").trim().toLowerCase());
  }
  return { ok: true, paths, error: null };
}
