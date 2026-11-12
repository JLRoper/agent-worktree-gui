// THE BRANCH-KIND RULE: what kind of tree a cut made, written beside its parent, and what that kind does to a push.
//
// A tree records what it IS at the one moment the fact is knowable, and the record has exactly two kinds:
//
//   turnover  a child cut from an existing turnover branch the reader asked for;
//   research  a tree cut from the project's main parent, local only.
//
// Neither kind is a guess: a parent that matches neither is NOT recorded as a default, it opens a clarify card and
// the cut does not happen. A silent fallback here is the failure this rule exists to prevent - every tree then
// reads "local only" or "may land" by accident rather than by the reader's answer.
//
// The push half: a tree recorded local only refuses a push naming the tree and the kind, until the reader lifts it.
//
// Five claims, each one a way this can look right and be wrong:
//
//   1. a turnover child records its kind beside its parent, keyed by the tree's tag;
//   2. a research tree records its kind, and the record says it is local only;
//   3. a parent that is neither kind raises the card - exactly the two kinds on offer - and cuts nothing;
//   4. a push from a local-only tree is refused with the tree and the kind named;
//   5. the same push is allowed once the reader lifts it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BRANCH_KINDS, KIND_LABELS, branchKindFor, isTurnoverBranch, kindChoices, planCut } from "../lib/branch-kind.js";
import { Jobs } from "../lib/jobs.js";
import { ParentBook } from "../lib/parents.js";
import { LOCAL_ONLY_TREE_KINDS, permissionForPush, pushPermissionFor, resolvePushPermissions, treeKindRefusal } from "../lib/push-permissions.js";

const EMAIL = ["kind", "example.invalid"].join(String.fromCharCode(64));
const TURNOVER = "20261112_0900_DMR-44001_the_turnover";

// A real repository, on main, with one commit. The cut reads the checkout's own branch, so this is what a plain
// spawn cuts from - and it is what makes the research half a real cut rather than a string comparison.
function repo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "wag-branch-kind-"));
  const git = (...args) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=Kind Fixture", "-c", `user.email=${EMAIL}`, "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Kind Fixture");
  git("config", "user.email", EMAIL);
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  mkdirSync(path.join(dir, "docs"), { recursive: true });
  writeFileSync(path.join(dir, "docs", "seed.txt"), "the parent's own work\n");
  git("add", "-A");
  git("commit", "-qm", "the parent's own work");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, git };
}

function jobsAt(dir) {
  const jobs = new Jobs({
    config: { apiServer: { url: "http://127.0.0.1:1" }, jobsFile: path.join(dir, "logs", "jobs.json"), jobMaxRuntimeSeconds: 60 },
    onEvent: () => {},
    onLog: () => {},
  });
  jobs.parents = new ParentBook({ file: path.join(dir, "logs", "parents.json"), onLog: () => {} });
  return jobs;
}

// The book the rule writes: one JSON object keyed by the tree's tag, each entry naming the parent, the branch, the
// tree and now the kind. Read from disk because that is the record a later run sees, not the store in memory.
function parentsBook(dir) {
  const file = path.join(dir, "logs", "branch-parents.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

test("1. a turnover child records its kind beside its parent", async (t) => {
  const r = repo(t);
  // The reader asked for this turnover branch: it exists locally and it is what the checkout stands on, so a plain
  // cut is a cut from it.
  r.git("checkout", "-q", "-b", TURNOVER);
  assert.equal(isTurnoverBranch(TURNOVER), true, "the turnover shape is recognised");
  assert.equal(branchKindFor({ parent: TURNOVER }).kind, "turnover", "a turnover parent classifies as a turnover child");
  assert.equal(branchKindFor({ parent: TURNOVER }).localOnly, false, "a turnover child is not local only by its kind");

  const jobs = jobsAt(r.dir);
  const made = await jobs.makeWorktree(r.dir, "cut this turnover child");
  assert.equal(made.parentName, TURNOVER, "the cut names the turnover branch it came from");
  assert.equal(made.kind, "turnover", "the cut returns the kind it recorded");

  const book = parentsBook(r.dir);
  assert.ok(book, "the cut wrote branch-parents.json");
  const entries = Object.values(book);
  assert.equal(entries.length, 1, "one tree, one entry");
  const [rec] = entries;
  const key = Object.keys(book)[0];
  assert.match(key, /^tag:[0-9a-f]{6}$/i, "the entry is keyed by the tree's tag");
  assert.equal(rec.parent, TURNOVER, "the parent is recorded beside the kind");
  assert.equal(rec.branch, made.branch, "the branch is recorded");
  assert.equal(rec.tree, made.path, "the tree is recorded");
  assert.equal(rec.kind, "turnover", "the kind is recorded");
  // ...and it survives a restart, which is the only reason it is on disk.
  const again = jobsAt(r.dir);
  assert.equal(again.treeKindFor({ tree: made.path, branch: made.branch })?.kind, "turnover", "a fresh store reads the kind back");
});

test("2. a research tree records its kind, local only", async (t) => {
  const r = repo(t); // the checkout is on main: the plain cut is a research tree
  const jobs = jobsAt(r.dir);
  const made = await jobs.makeWorktree(r.dir, "research the seam");

  const book = parentsBook(r.dir);
  assert.ok(book, "the cut wrote branch-parents.json");
  const [rec] = Object.values(book);
  assert.equal(rec.parent, "main", "the parent is the project's main parent");
  assert.equal(rec.kind, "research", "the kind is recorded");
  assert.equal(made.localOnly, true, "a research tree is local only");
  assert.equal(LOCAL_ONLY_TREE_KINDS.includes(rec.kind), true, "the push rule treats research as local only");
  // The same record read by a fresh store answers the push question without a cut in hand.
  const again = jobsAt(r.dir);
  assert.deepEqual(
    { kind: again.treeKindFor({ tree: made.path, branch: made.branch })?.kind, lifted: again.treeKindFor({ tree: made.path, branch: made.branch })?.lifted },
    { kind: "research", lifted: false },
    "a fresh store reads the kind and that it has not been lifted",
  );
});

test("3. neither kind raises the card, and cuts nothing", async (t) => {
  const r = repo(t);
  // A feature branch matches neither kind: it is not a turnover branch, and it is not the project's main parent.
  assert.equal(branchKindFor({ parent: "feature/the-seam" }).kind, null, "a feature parent matches neither kind");
  const plan = planCut({ project: "demo", tree: null, parent: "feature/the-seam" });
  assert.equal(plan.cut, false, "the cut does not happen");
  assert.ok(plan.clarify, "a clarify card is raised");
  assert.deepEqual(plan.clarify.choices.map((c) => c.value), BRANCH_KINDS, "exactly the two kinds are on offer");
  assert.equal(plan.clarify.choices.length, 2, "no third option and no default");
  assert.equal(plan.clarify.multiSelect, false, "one answer");
  assert.match(plan.clarify.question, /feature\/the-seam/, "the card names the parent that could not be classified");
  assert.ok(KIND_LABELS.turnover && KIND_LABELS.research, "both kinds are named for the reader");

  // Cutting nothing means nothing is written either: no tree, no record.
  const jobs = jobsAt(r.dir);
  const tree = path.join(r.dir, ".worktrees", "would-be-child");
  if (plan.cut) await jobs.makeWorktree(r.dir, "never reached");
  assert.equal(existsSync(tree), false, "no directory was made");
  assert.equal(parentsBook(r.dir), null, "no branch-parents record was written");

  // The card's own answer is one of the two, and nothing else is a kind.
  assert.deepEqual(kindChoices().map((c) => c.value), BRANCH_KINDS, "the dialog offers the same two kinds");
});

test("4. a push from a local-only tree is refused, naming the tree and the kind", () => {
  // A directory that looks like a tree on this machine, built at run time so the file states no absolute path.
  const tree = path.resolve(process.cwd(), "demo", ".worktrees", "research-the-seam-19d782");
  const refusal = treeKindRefusal({ tree, kind: "research" });
  assert.ok(refusal, "a local-only kind is refused");
  assert.match(refusal, /research-the-seam-19d782/, "the refusal names the tree");
  assert.match(refusal, /research/, "the refusal names the kind");
  assert.match(refusal, /lift/i, "the refusal says what the reader can do about it");

  const resolved = resolvePushPermissions({ name: "demo", pushNewBranches: "allow-all", pushExistingBranches: "allow-all" }, {});
  assert.equal(permissionForPush(resolved, { branch: "wtgui/research-the-seam-19d782", isNew: true }), "allow", "without a kind the controls allow it");
  assert.equal(
    permissionForPush(resolved, { branch: "wtgui/research-the-seam-19d782", isNew: true, tree, kind: "research" }),
    "refuse",
    "the recorded kind outranks an allow-all control",
  );
  const answer = pushPermissionFor(resolved, { branch: "wtgui/research-the-seam-19d782", isNew: true, tree, kind: "research" });
  assert.equal(answer.permission, "refuse", "the answer carries the decision");
  assert.match(answer.reason || "", /research-the-seam-19d782/, "the answer carries the tree");
  assert.match(answer.reason || "", /research/, "the answer carries the kind");
  // A turnover child is not local only, so its push meets the ordinary controls.
  assert.equal(treeKindRefusal({ tree, kind: "turnover" }), null, "a turnover child is not refused by its kind");
});

test("5. the same push is allowed once the reader lifts it", async (t) => {
  const r = repo(t);
  const jobs = jobsAt(r.dir);
  const made = await jobs.makeWorktree(r.dir, "research the seam");
  const tree = made.path;
  const resolved = resolvePushPermissions({ name: "demo", pushNewBranches: "allow-all", pushExistingBranches: "allow-all" }, {});

  assert.equal(permissionForPush(resolved, { branch: made.branch, isNew: true, tree, kind: "research" }), "refuse", "refused before the lift");

  const lifted = await jobs.liftKind({ tree, branch: made.branch });
  assert.equal(lifted?.lifted, true, "the lift is written on the tree's own record");
  assert.equal(lifted?.kind, "research", "lifting does not rewrite the kind");
  assert.equal(jobsAt(r.dir).treeKindFor({ tree, branch: made.branch })?.lifted, true, "the lift survives a restart");

  const rec = jobs.treeKindFor({ tree, branch: made.branch });
  assert.equal(
    permissionForPush(resolved, { branch: made.branch, isNew: true, tree, kind: rec.kind, lifted: rec.lifted }),
    "allow",
    "once lifted, the same push meets the ordinary controls and goes through",
  );
  assert.equal(treeKindRefusal({ tree, kind: "research", lifted: true }), null, "a lifted tree earns no refusal");
});
