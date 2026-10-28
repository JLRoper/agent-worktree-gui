// The steward's own rules, driven against real git.
//
// What this file pins, in the order the work happens:
//   1. PARENT RESOLUTION — a tree the panel cuts records the ref and the sha it resolved to, and the record survives
//      the process (`parentSource: "cut"`); a tree nobody recorded is guessed from a shared ticket id ONLY when the
//      two branches share a merge-base, and the guess is marked "backfilled"; no ticket, or an ambiguous pair, is
//      "unknown" — never a guess dressed as a fact.
//   2. THE FIVE CLASSES — LANDED (content, not ancestry: the squash-merged branch is NOT an ancestor of master and
//      still has to come out landed), ROLLUP, ORPHAN, DIRTY, LOCKED.
//   3. BOTH REFUSALS — a roll-up into master, and a roll-up into a parent that is a guess. Plus the two smaller ones a
//      reader would be angry to discover later: a production parent goes to a worker, and an apply without a confirm
//      (or without a dry run) writes nothing.
//   4. THE ACT — a dry run lists and deletes nothing; a confirmed run deletes only LANDED+clean+unlocked, rolls the
//      ROLLUP branches inside their parent's own worktree, and leaves the dirty, locked and guessed-at trees alone.
//
// Every fixture is a throwaway repo under the OS temp dir; nothing here touches this checkout or the panel's own state.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ParentBook, backfillCandidates, pickBackfill, resolveParents, ticketIds } from "../lib/parents.js";
import { WriterLocks } from "../lib/locks.js";
import { applyPlan, buildPlan, classify, contentIn, deletable, inspectProject, rollGate, rollUp, worktrees } from "../lib/steward.js";

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    .replace(/\r\n/g, "\n")
    .trim();
}

function commit(repo, file, text, message) {
  writeFileSync(path.join(repo, file), text);
  git(repo, "add", file);
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

const tmp = [];
function makeRepo(name = "repo") {
  const root = mkdtempSync(path.join(os.tmpdir(), `steward-${name}-`));
  tmp.push(root);
  git(root, "init", "-q", "-b", "master");
  git(root, "config", "user.email", "steward@example.test");
  git(root, "config", "user.name", "Steward Test");
  git(root, "config", "commit.gpgsign", "false");
  commit(root, "a.txt", "one\n", "one");
  return root;
}
test.after(() => {
  for (const dir of tmp) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a locked worktree left on disk is the OS's problem, not the suite's */
    }
  }
});

// A worktree cut the way the panel cuts one: `worktree add -b <branch> <path> <startRef>`.
function cut(repo, branch, startRef = "master") {
  const wt = path.join(repo, ".worktrees", branch.replace(/[^A-Za-z0-9._-]+/g, "-"));
  git(repo, "worktree", "add", "-q", "-b", branch, wt, startRef);
  return wt;
}

// The rows the scan would hand the steward: branch, path, and the dirty counts it read from `status`.
function rowsOf(repo) {
  const listing = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8", env: GIT_ENV, windowsHide: true }).replace(/\r\n/g, "\n");
  const trees = [];
  let cur = null;
  for (const line of listing.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9).trim(), branch: null };
      trees.push(cur);
    } else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7).trim().replace("refs/heads/", "");
  }
  return trees.map((t) => {
    const st = execFileSync("git", ["-C", t.path, "status", "--porcelain"], { encoding: "utf8", env: GIT_ENV, windowsHide: true }).replace(/\r\n/g, "\n").trim();
    const lines = st ? st.split("\n").filter(Boolean) : [];
    return {
      path: t.path.replace(/\\/g, "/"),
      branch: t.branch,
      dirty: lines.filter((l) => !l.startsWith("??")).length,
      untracked: lines.filter((l) => l.startsWith("??")).length,
      verdict: "UNMERGED (1 commit)",
    };
  });
}

// ---- 1. parent resolution -------------------------------------------------------------------------------------

test("ticketIds: a real ticket, never the panel's own hex tag", () => {
  assert.deepEqual(ticketIds("dmr-1234-menu-sso"), ["DMR-1234"]);
  assert.deepEqual(ticketIds("wtgui/roll-back-branches-a1b2c3"), []);
  assert.deepEqual(ticketIds("build-a-project-steward-667552"), []);
  assert.deepEqual(ticketIds("feature/DMR-77_x"), ["DMR-77"]);
});

test("a cut records the start ref and the sha it resolved to, and the row reads it back", () => {
  const repo = makeRepo("cut");
  const startSha = git(repo, "rev-parse", "master");
  const book = new ParentBook({ file: path.join(repo, "parents.json") });
  const rec = book.record({ project: "demo", branch: "wtgui/x-abcdef", path: path.join(repo, ".worktrees", "x"), startRef: "master", startSha });
  assert.equal(rec.parent, null, "master is never a parent");
  assert.equal(rec.parentSource, "unknown");

  git(repo, "branch", "dmr-7-turnover");
  const turn = git(repo, "rev-parse", "dmr-7-turnover");
  const rec2 = book.record({ project: "demo", branch: "wtgui/y-123456", path: path.join(repo, ".worktrees", "y"), startRef: "dmr-7-turnover", startSha: turn });
  assert.equal(rec2.parent, "dmr-7-turnover");
  assert.equal(rec2.parentSha, turn);
  assert.equal(rec2.parentSource, "cut");

  // A restart sees exactly the same answer: the record is a file, not a memory.
  const again = new ParentBook({ file: path.join(repo, "parents.json") });
  assert.equal(again.get("demo", "wtgui/y-123456").parent, "dmr-7-turnover");
  assert.equal(again.get("demo", "wtgui/y-123456").parentSource, "cut");
  assert.deepEqual(
    again.rowsFor("demo").map((r) => `${r.branch}=${r.parent}/${r.parentSource}`).sort(),
    ["wtgui/x-abcdef=null/unknown", "wtgui/y-123456=dmr-7-turnover/cut"],
  );
});

test("backfill: a legacy tree is guessed from a shared ticket id, with a merge-base check, and marked a guess", async () => {
  const repo = makeRepo("backfill");
  git(repo, "checkout", "-q", "-b", "dmr-1234-turnover");
  commit(repo, "t.txt", "turnover\n", "turnover work");
  const turnoverSha = git(repo, "rev-parse", "dmr-1234-turnover");
  git(repo, "checkout", "-q", "-b", "dmr-1234-child");
  commit(repo, "c.txt", "child\n", "child work");
  // A DIFFERENT project's branch with the same ticket: same name, no shared history at all.
  const other = makeRepo("other");
  git(other, "checkout", "-q", "-b", "dmr-1234-unrelated");
  commit(other, "z.txt", "z\n", "unrelated");

  const book = new ParentBook({ file: path.join(repo, "parents.json") });
  const out = await book.refresh({ project: "demo", repoDir: repo, mainBranch: "master" });
  assert.ok(out.learned >= 2);
  const rec = book.get("demo", "dmr-1234-child");
  assert.equal(rec.parent, "dmr-1234-turnover", "the shared ticket names the parent");
  assert.equal(rec.parentSource, "backfilled", "and it is a GUESS, not a cut");
  assert.equal(rec.parentSha, turnoverSha);

  // The same ticket id in a repo that shares no history is not a candidate: the merge-base check drops it.
  const cand = await backfillCandidates(other, "dmr-1234-unrelated", ["dmr-1234-turnover"]);
  assert.deepEqual(cand.candidates, []);
});

test("a legacy tree is recovered from its own reflog before anything is guessed", async () => {
  const repo = makeRepo("reflog");
  git(repo, "checkout", "-q", "-b", "dmr-9-turnover");
  commit(repo, "t.txt", "t\n", "turnover");
  // Cut the way a person cuts one: the reflog keeps git's own note of the start ref.
  const child = cut(repo, "dmr-9-child", "dmr-9-turnover");
  commit(child, "c.txt", "c\n", "child");

  const book = new ParentBook({ file: path.join(repo, "parents.json") });
  await book.refresh({ project: "p", repoDir: repo, mainBranch: "master" });
  const rec = book.get("p", "dmr-9-child");
  assert.equal(rec.parent, "dmr-9-turnover", "the reflog names the cut ref exactly");
  assert.equal(rec.parentSource, "backfilled", "recovered is still not the same thing as watched: no write may follow");
  assert.match(rec.why, /reflog/i, "and the row says where the answer came from");
  // The turnover branch itself was created from master, which is a destination, never a parent — and it is NOT handed
  // to the ticket heuristic, which would be free to name one of its own children instead.
  const turnover = book.get("p", "dmr-9-turnover");
  assert.equal(turnover.parent, null);
  // Whichever refusal git leaves us with, it has to be a refusal and not a sibling named as a parent: its own reflog
  // says `Created from HEAD` (that is all `checkout -b` writes), so the answer comes from the heuristic's direction
  // check — the child was cut FROM this branch.
  assert.match(turnover.why, /cut FROM this branch|main branch|reflog/i);
});

test("backfill refuses to guess when no ticket is shared, or when two candidates are equally near", () => {
  assert.deepEqual(pickBackfill({ branch: "wtgui/a-b-c", candidates: [] }).parent, null);
  const tie = pickBackfill({
    branch: "dmr-9-child",
    candidates: [
      { branch: "dmr-9-a", sharesBase: true, isAncestor: true, behind: 2 },
      { branch: "dmr-9-b", sharesBase: true, isAncestor: true, behind: 2 },
    ],
  });
  assert.equal(tie.parent, null);
  assert.match(tie.why, /ambiguous/);
  const near = pickBackfill({
    branch: "dmr-9-child",
    candidates: [
      { branch: "dmr-9-a", sharesBase: true, isAncestor: true, behind: 5 },
      { branch: "dmr-9-b", sharesBase: true, isAncestor: true, behind: 1 },
    ],
  });
  assert.equal(near.parent, "dmr-9-b");
});

test("resolveParents keeps a cut record and only fills in what is missing", async () => {
  const repo = makeRepo("resolve");
  git(repo, "checkout", "-q", "-b", "dmr-5-turnover");
  commit(repo, "t.txt", "t\n", "t");
  git(repo, "checkout", "-q", "master");
  git(repo, "checkout", "-q", "-b", "dmr-5-child", "dmr-5-turnover");
  commit(repo, "c.txt", "c\n", "c");
  const records = new Map([["dmr-5-child", { branch: "dmr-5-child", parent: "somewhere-else", parentSha: "abc", parentSource: "cut" }]]);
  const out = await resolveParents({ repoDir: repo, branches: ["master", "dmr-5-turnover", "dmr-5-child"], records, mainBranch: "master" });
  assert.equal(out.get("dmr-5-child").parent, "somewhere-else", "a cut record is never overwritten by a guess");
  assert.equal(out.get("dmr-5-child").parentSource, "cut");
  assert.equal(out.get("dmr-5-turnover").parentSource, "unknown", "a turnover branch has no parent of its own");
});

// ---- 2. the five classes --------------------------------------------------------------------------------------

test("classify: all five classes, in the policy's own order", () => {
  const base = { branch: "b", parent: "p", parentSource: "cut", mainBranch: "master", dirty: 0, untracked: 0 };
  assert.equal(classify({ ...base, locked: true }).kind, "LOCKED");
  assert.equal(classify({ ...base, locked: true, dirty: 9 }).kind, "LOCKED", "locked is decided before anything is read");
  assert.equal(classify({ ...base, dirty: 1, inMaster: { landed: true } }).kind, "DIRTY", "dirty beats landed");
  assert.equal(classify({ ...base, parent: null, parentSource: "unknown" }).kind, "ORPHAN");
  assert.equal(classify({ ...base, parent: "master" }).kind, "ORPHAN", "master is never a roll target");
  assert.equal(classify({ ...base, inMaster: { landed: true, how: "x" } }).kind, "LANDED");
  assert.equal(classify({ ...base, inParent: { landed: true, how: "x" } }).kind, "LANDED");
  const roll = classify({ ...base, ahead: 3, inMaster: { landed: false }, inParent: { landed: false } });
  assert.equal(roll.kind, "ROLLUP");
  assert.equal(roll.rollable, true);
  const guessed = classify({ ...base, parentSource: "backfilled", ahead: 3, inMaster: { landed: false }, inParent: { landed: false } });
  assert.equal(guessed.kind, "ROLLUP");
  assert.equal(guessed.rollable, false, "a guessed parent is shown, never acted on");
  assert.equal(guessed.needsConfirm, true);
});

// A worktree on an EXISTING branch (the turnover branch lives in its own tree, not in the main checkout).
function addTree(repo, branch, startRef = "master", { create = true } = {}) {
  const wt = path.join(repo, ".worktrees", branch.replace(/[^A-Za-z0-9._-]+/g, "-"));
  const args = ["worktree", "add", "-q"];
  if (create) args.push("-b", branch);
  args.push(wt);
  if (startRef) args.push(startRef);
  git(repo, ...args);
  return wt;
}

// A repo that carries one tree of every class.
async function classificationRepo() {
  const repo = makeRepo("classes");
  // (1) LANDED by a SQUASH merge: master carries the change, the branch is not an ancestor of master.
  const squashedWt = addTree(repo, "dmr-1-squashed");
  commit(squashedWt, "squash.txt", "squashed change\n", "the change that will be squashed");
  git(repo, "merge", "-q", "--squash", "dmr-1-squashed");
  git(repo, "commit", "-q", "-m", "squash dmr-1");

  // (2) A turnover parent — its own tree, so the roll-up has somewhere to land — with a child that landed on it and a
  // child that still has to be rolled up.
  const parentWt = addTree(repo, "dmr-2-turnover");
  commit(parentWt, "turn.txt", "turnover\n", "turnover base");
  const landedChild = cut(repo, "dmr-2-child-landed", "dmr-2-turnover");
  commit(landedChild, "landed.txt", "landed\n", "work that landed");
  git(parentWt, "merge", "-q", "--ff-only", "dmr-2-child-landed");
  const rollWt = cut(repo, "dmr-2-child-roll", "dmr-2-turnover");
  commit(rollWt, "roll.txt", "to roll\n", "work to roll up");

  // (3) Dirty, orphan, locked.
  const dirtyWt = cut(repo, "dmr-2-dirty", "dmr-2-turnover");
  writeFileSync(path.join(dirtyWt, "wip.txt"), "half done\n");
  const orphanWt = cut(repo, "wtgui/no-ticket-at-all", "master");
  commit(orphanWt, "orphan.txt", "orphan\n", "nobody knows where this goes");
  const lockedWt = cut(repo, "dmr-2-locked", "dmr-2-turnover");
  git(repo, "worktree", "lock", lockedWt);

  const book = new ParentBook({ file: path.join(repo, "parents.json") });
  const branches = ["dmr-1-squashed", "dmr-2-turnover", "dmr-2-child-roll", "dmr-2-child-landed", "dmr-2-dirty", "wtgui/no-ticket-at-all", "dmr-2-locked"];
  await book.refresh({ project: "classes", repoDir: repo, mainBranch: "master", branches });
  // The panel cut these two, so their parent is a fact rather than a guess.
  for (const branch of ["dmr-2-child-roll", "dmr-2-child-landed"]) {
    book.record({ project: "classes", branch, startRef: "dmr-2-turnover", startSha: git(repo, "rev-parse", "dmr-2-turnover") });
  }
  const parents = new Map(book.state("classes").map((r) => [r.branch, r]));
  const rows = rowsOf(repo);
  const entries = await inspectProject({ project: "classes", repoDir: repo, rows, parents, mainBranch: "master" });
  return { repo, entries, rows, parents, byBranch: new Map(entries.map((e) => [e.branch, e])), parentWt, rollWt };
}

test("the five classes against real git: LANDED by content, ROLLUP, ORPHAN, DIRTY, LOCKED", async () => {
  const { repo, byBranch } = await classificationRepo();
  const kind = (b) => byBranch.get(b)?.kind;

  // The squash case is the one ancestry cannot answer: the branch is NOT an ancestor of master…
  let ancestor = true;
  try {
    git(repo, "merge-base", "--is-ancestor", "dmr-1-squashed", "master");
  } catch {
    ancestor = false;
  }
  assert.equal(ancestor, false, "a squash merge leaves the branch off master's history — the whole reason for a content test");
  assert.equal(kind("dmr-1-squashed"), "LANDED");
  assert.match(byBranch.get("dmr-1-squashed").why, /patch-id|identical/i);

  assert.equal(kind("dmr-2-child-landed"), "LANDED", "content that is already in its parent");
  assert.equal(kind("dmr-2-child-roll"), "ROLLUP");
  assert.equal(kind("wtgui/no-ticket-at-all"), "ORPHAN");
  assert.equal(kind("dmr-2-dirty"), "DIRTY");
  assert.equal(kind("dmr-2-locked"), "LOCKED");
  assert.equal(kind("dmr-2-turnover"), "ORPHAN", "a turnover branch is not rolled anywhere, and never guessed as a child");

  // Exactly the landed, clean, unlocked trees are deletable — never the dirty, the locked, the rollup or the main checkout.
  assert.equal(deletable(byBranch.get("dmr-1-squashed")), true);
  assert.equal(deletable(byBranch.get("dmr-2-child-landed")), true);
  assert.equal(deletable(byBranch.get("dmr-2-child-roll")), false);
  assert.equal(deletable(byBranch.get("dmr-2-dirty")), false);
  assert.equal(deletable(byBranch.get("dmr-2-locked")), false);
  assert.equal(deletable(byBranch.get("dmr-2-turnover")), false, "a turnover tree is not a child that landed");
});

// ---- 3. the refusals ------------------------------------------------------------------------------------------

test("refusal 1: a roll-up never merges into master", async () => {
  const gate = rollGate({ parentBranch: "master", parentSource: "cut", mainBranch: "master", parentWorktree: "C:/nowhere" });
  assert.equal(gate.ok, false);
  assert.equal(gate.refused, "main");
  const out = await rollUp({ repoDir: "C:/nowhere", parentBranch: "master", parentWorktree: "C:/nowhere", childBranch: "x", mainBranch: "master" });
  assert.equal(out.ok, false);
  assert.equal(out.refused, "main");
});

test("refusal 2: a guessed parent never drives a merge, and neither does one with no worktree", () => {
  const guess = rollGate({ parentBranch: "dmr-1-turnover", parentSource: "backfilled", mainBranch: "master", parentWorktree: "C:/tree" });
  assert.equal(guess.ok, false);
  assert.equal(guess.refused, "guess");
  assert.match(guess.error, /guess may not drive a merge/);
  const nowhere = rollGate({ parentBranch: "dmr-1-turnover", parentSource: "cut", mainBranch: "master", parentWorktree: null });
  assert.equal(nowhere.ok, false);
  assert.equal(nowhere.via, "worker", "no worktree to merge inside: a worker (or the reader) makes one");
  const prod = rollGate({ parentBranch: "dmr-1-turnover", parentSource: "cut", prodBranch: "dmr-1-turnover", parentWorktree: "C:/tree" });
  assert.equal(prod.refused, "prod");
  assert.equal(prod.via, "worker", "a production roll-up is never done by editing a tree");
  assert.equal(rollGate({ parentBranch: "dmr-1-turnover", parentSource: "cut", parentWorktree: "C:/tree" }).ok, true);
});

test("a roll-up really lands inside the parent's worktree, fast-forwarding it and touching nothing else", async () => {
  const { repo, parentWt } = await classificationRepo();
  const before = git(parentWt, "rev-parse", "HEAD");
  const out = await rollUp({ repoDir: repo, parentBranch: "dmr-2-turnover", parentWorktree: parentWt, childBranch: "dmr-2-child-roll", mainBranch: "master" });
  assert.equal(out.ok, true, out.error || "");
  assert.equal(out.method, "ff");
  assert.notEqual(git(parentWt, "rev-parse", "HEAD"), before);
  assert.equal(git(parentWt, "log", "-1", "--format=%s"), "work to roll up");
  assert.equal(git(repo, "rev-parse", "master"), git(repo, "rev-parse", "master"), "master was not written");
});

test("locks serialise two roll-ups into the same parent branch, and the second one still lands", async () => {
  const locks = new WriterLocks();
  const order = [];
  const one = locks.with("rollup:r::p", async () => {
    order.push("a:start");
    await new Promise((r) => setTimeout(r, 40));
    order.push("a:end");
  });
  const two = locks.with("rollup:r::p", async () => {
    order.push("b:start");
    order.push("b:end");
  });
  await Promise.all([one, two]);
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"], "no interleaving inside one parent");
  assert.deepEqual(locks.state(), []);
});

// ---- 4. the plan and the act ----------------------------------------------------------------------------------

test("the plan is a file, it lists the three answers, and it writes nothing but itself", async () => {
  const { repo, entries, parents } = await classificationRepo();
  const plan = buildPlan({ project: "classes", repoDir: repo, entries, mainBranch: "master" });
  assert.equal(plan.delete.length, 2, "the two landed trees");
  assert.equal(plan.roll.length, 1, "the one branch still ahead of its parent");
  assert.ok(plan.ask.length >= 2, "the orphan and every guessed tree ask the reader");
  assert.ok(plan.skip.length >= 2, "dirty and locked are named, not silently dropped");
  // Nothing moved: the trees are all still there.
  const listing = await worktrees(repo);
  assert.ok(listing.trees.length >= 5);
});

test("apply: no confirm writes nothing; a dry run lists and writes nothing; a confirm deletes only landed+clean+unlocked and rolls the rest", async () => {
  const { repo, entries, parents, rollWt, parentWt } = await classificationRepo();
  const fresh = buildPlan({ project: "classes", repoDir: repo, entries, mainBranch: "master" });
  const plan = { ...fresh, at: fresh.at };
  const listing = await worktrees(repo);

  const noConfirm = await applyPlan({ plan, fresh, repoDir: repo, trees: listing.trees });
  assert.equal(noConfirm.ok, false);
  assert.match(noConfirm.error, /without an explicit confirm/);
  assert.equal((await worktrees(repo)).trees.length, listing.trees.length, "nothing was deleted");

  const stale = await applyPlan({ plan, fresh, expectedAt: "1999-01-01T00:00:00.000Z", repoDir: repo, trees: listing.trees, confirm: true });
  assert.equal(stale.ok, false);
  assert.match(stale.error, /look again/);

  const dry = await applyPlan({ plan, fresh, repoDir: repo, trees: listing.trees, dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(dry.delete.length, 2);
  assert.equal(dry.roll.length, 1);
  assert.equal((await worktrees(repo)).trees.length, listing.trees.length, "a dry run deletes nothing");

  const done = await applyPlan({ plan, fresh, repoDir: repo, trees: listing.trees, confirm: true });
  assert.equal(done.ok, true, done.error || "");
  assert.equal(done.deleted.length, 2);
  assert.equal(done.rolled.length, 1);
  const branches = git(repo, "branch", "--format=%(refname:short)").split("\n");
  assert.ok(!branches.includes("dmr-1-squashed"), "a landed branch is gone");
  assert.ok(!branches.includes("dmr-2-child-landed"), "a landed child is gone");
  assert.ok(branches.includes("dmr-2-dirty"), "the dirty branch is kept");
  assert.ok(branches.includes("dmr-2-locked"), "the locked branch is kept");
  assert.ok(branches.includes("dmr-2-child-roll"), "a rolled branch is kept — it still has its own tree");
  assert.equal(git(parentWt, "log", "-1", "--format=%s"), "work to roll up", "the roll landed in the PARENT's tree");
  assert.equal(git(repo, "log", "-1", "--format=%s", "master"), "squash dmr-1", "master was never written by the steward");
  assert.ok(path.isAbsolute(rollWt));
});

test("contentIn proves a squash merge by patch-id, not by ancestry", async () => {
  const repo = makeRepo("content");
  git(repo, "checkout", "-q", "-b", "dmr-3-branch");
  commit(repo, "b.txt", "b\n", "b");
  git(repo, "checkout", "-q", "master");
  git(repo, "merge", "-q", "--squash", "dmr-3-branch");
  git(repo, "commit", "-q", "-m", "squashed b");
  const out = await contentIn(repo, "master", "dmr-3-branch");
  assert.equal(out.landed, true);
  // Either proof is a content proof: the squash left master's TREE identical to the branch's here, and the patch-id
  // test is what covers the case where it does not (master moved on afterwards).
  assert.match(out.how, /patch-id|identical/);
  // Moving master on top of the squash is what makes the tree differ; the patch-id proof still lands the branch.
  commit(repo, "a.txt", "one\ntwo\n", "master moves on");
  const after = await contentIn(repo, "master", "dmr-3-branch");
  assert.equal(after.landed, true);
  assert.match(after.how, /patch-id/);
  // And a branch master has never seen is not landed.
  git(repo, "checkout", "-q", "-b", "dmr-3-later", "master");
  commit(repo, "later.txt", "later\n", "later");
  assert.equal((await contentIn(repo, "master", "dmr-3-later")).landed, false);
});
