// THE BRANCH-KIND RULE: what kind of tree a cut made, how the brief decides, and what that kind does to a push.
//
// A tree records what it IS at the one moment the fact is knowable, and the record has exactly three kinds:
//
//   turnover        the FEATURE CONTAINER - the tree standing on a turnover branch. It is not a child of anything:
//                   the only way a tree records turnover is the container's own cut (`planTurnoverContainer`,
//                   lib/jobs.js `cutTurnoverTreeFor`).
//   research        a tree cut to answer a question, local only, never lands;
//   implementation  a tree cut to change code, local only, lands by merging into its turnover branch locally.
//
// THERE IS NO TURNOVER CHILD. A branch cut from a turnover branch - and a nested child of a research or
// implementation tree - classifies research or implementation by its own brief, never turnover. The brief is
// lib/branch-kind.js `inferKindFromBrief`; `planCut` never answers turnover and never blocks a cut.
//
// THE PUSH HALF: research and implementation are LOCAL ONLY, so a push from either parks on the permission card (one
// grant, one push from one tree) until the reader lifts the tree, which is the per-tree standing grant. A turnover
// tree is the container and its push meets the ordinary controls.
//
// Eight claims, each one a way this can look right and be wrong:
//
//   1. the turnover TREE records turnover, and its children record research or implementation - never turnover;
//   2. an implementation cut asked for with a main parent first auto-cuts the feature's turnover tree under a `free`
//      policy, then cuts the child from it: one press, two trees, the parent recorded;
//   3. under `ask` the auto-cut raises the permission card and cuts nothing;
//   4. planCut never answers turnover, for any parent or stated kind, and the dialog offers the two child kinds;
//   5. the parent options preselect the feature's turnover branch on a main row, with main still offered;
//   6. a push from a local-only tree asks rather than being refused outright, and NAMES the tree and the kind;
//   7. the same push meets the ordinary controls once the reader lifts it, and `never` still refuses outright;
//   8. the row's Kind cell names the turnover tree as the container, draws all three letters, and lifts both local kinds.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  BRANCH_KINDS,
  CHILD_KINDS,
  KIND_LABELS,
  KIND_NOTES,
  branchKindFor,
  cutParentChoices,
  isTurnoverBranch,
  kindChoices,
  planCut,
  planTurnoverContainer,
} from "../lib/branch-kind.js";
import { Jobs } from "../lib/jobs.js";
import { ParentBook } from "../lib/parents.js";
import { planTurnoverCut } from "../lib/project-turnover.js";
import { LOCAL_ONLY_TREE_KINDS, permissionForPush, pushPermissionFor, resolvePushPermissions, treeKindAsk } from "../lib/push-permissions.js";

const EMAIL = ["kind", "example.invalid"].join(String.fromCharCode(64));
const TURNOVER = "20261112_0900_DMR-44001_the_turnover";
const FIXED_AT = new Date("2026-11-26T18:00:00");

// A real repository, on main, with one commit. The cut reads the checkout's own branch, so this is what a plain
// spawn cuts from - and it is what makes the research and implementation halves real cuts rather than a comparison.
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

// The book the rule writes: one JSON object keyed by the tree's tag (or its path when a turnover branch carries no
// tag), each entry naming the parent, the branch, the tree and the kind. Read from disk because that is the record a
// later run sees, not the store in memory.
function parentsBook(dir) {
  const file = path.join(dir, "logs", "branch-parents.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

test("1. the turnover tree records turnover, and a child of it records research or implementation", async (t) => {
  const r = repo(t);
  // The container: a tree standing on a turnover branch, cut from main. Its own record is the ONLY turnover record.
  // The branch exists with no worktree (a `git branch`, not a checkout): the container cut is what puts a tree on it.
  r.git("branch", TURNOVER);
  const jobs = jobsAt(r.dir);
  const container = await jobs.cutTurnoverTreeFor({ repoDir: r.dir, project: "demo", branch: TURNOVER, base: "main", mainBranch: "main", key: "task 18" });
  assert.equal(container.ok, true, `the container is cut: ${container.error || ""}`);
  assert.equal(container.reused, false);
  assert.equal(container.parent, "main", "the container is cut from the project's base");
  assert.equal(isTurnoverBranch(TURNOVER), true, "the turnover shape is recognised");
  assert.equal(branchKindFor({ parent: TURNOVER }).kind, null, "a turnover parent names no CHILD kind by itself");
  assert.equal(branchKindFor({ parent: TURNOVER }).container, true, "it names the container");

  // Its children are research or implementation by their brief - the same code brief that used to read "turnover".
  const impl = await jobs.makeWorktree(r.dir, "fix the roll-up in lib/jobs.js", { project: "demo", turnoverBranch: TURNOVER, mainBranch: "main" });
  assert.equal(impl.parentName, TURNOVER, "the child is cut from the container");
  assert.equal(impl.kind, "implementation", "a code brief is implementation, never turnover");
  const research = await jobs.makeWorktree(r.dir, "explain how the roll-up decides", { project: "demo", turnoverBranch: TURNOVER, mainBranch: "main" });
  assert.equal(research.parentName, TURNOVER);
  assert.equal(research.kind, "research", "a question is research, never turnover");

  const book = parentsBook(r.dir);
  assert.ok(book, "the cut wrote branch-parents.json");
  const entries = Object.values(book);
  const kinds = entries.map((rec) => rec.kind).sort();
  assert.deepEqual(kinds, ["implementation", "research", "turnover"], "one container and two children, three kinds");
  const containerRec = entries.find((rec) => rec.branch === TURNOVER);
  assert.ok(containerRec, "the container has its own record");
  assert.equal(containerRec.kind, "turnover", "the container records turnover");
  assert.equal(containerRec.parent, "main", "and the base it was cut from");
  for (const made of [impl, research]) {
    const rec = entries.find((row) => row.branch === made.branch);
    assert.equal(rec.parent, TURNOVER, "each child's parent is the container");
    assert.notEqual(rec.kind, "turnover", "a child of a turnover branch is never turnover");
  }
  // ...and it survives a restart, which is the only reason it is on disk.
  const again = jobsAt(r.dir);
  assert.equal(again.treeKindFor({ tree: container.path, branch: TURNOVER })?.kind, "turnover", "a fresh store reads the container back");
  assert.equal(again.treeKindFor({ tree: impl.path, branch: impl.branch })?.kind, "implementation");
});

test("2. an implementation cut with a main parent auto-cuts the feature's turnover tree, then the child", async (t) => {
  const r = repo(t); // the checkout is on main
  const mainSha = r.git("rev-parse", "HEAD");
  const jobs = jobsAt(r.dir);
  // A project under `free`: the container is made at once, no card. `task 186` is the feature key the queue row names.
  jobs.turnoverCutFor = (name, key, opts) =>
    planTurnoverCut({ project: { turnoverBranches: [], turnoverPolicy: "free" }, key: key || "task 186", name: opts?.name || "", at: FIXED_AT });
  const made = await jobs.makeWorktree(r.dir, "fix the push gate in lib/push-permissions.js", { project: "demo", turnoverKey: "task 186", mainBranch: "main" });

  assert.equal(made.kind, "implementation", "the child is the implementation tree");
  assert.ok(made.container, "the answer names the container it made");
  assert.match(made.container.branch, /^20261126_1800_TASK-186_/i, "the container's name carries the key and the cut's minute");
  assert.equal(isTurnoverBranch(made.container.branch), true, "the made branch is a turnover branch");
  assert.equal(made.parentName, made.container.branch, "the child's parent is the container, not main");
  assert.equal(existsSync(made.container.path), true, "two trees: the container's");
  assert.equal(existsSync(made.path), true, "two trees: the child's");
  assert.equal(execFileSync("git", ["-C", made.container.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), mainSha, "the container starts at the project's base");
  assert.equal(execFileSync("git", ["-C", made.path, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim(), made.branch);
  assert.equal(execFileSync("git", ["-C", made.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), mainSha, "the child starts at the container's tip");

  const book = parentsBook(r.dir);
  const entries = Object.values(book);
  const containerRec = entries.find((rec) => rec.branch === made.container.branch);
  assert.ok(containerRec, "the container's own record is written");
  assert.equal(containerRec.kind, "turnover");
  assert.equal(containerRec.parent, "main");
  const childRec = entries.find((rec) => rec.branch === made.branch);
  assert.equal(childRec.kind, "implementation");
  assert.equal(childRec.parent, made.container.branch, "the parent recorded is the container");
});

test("3. under ask the auto-cut raises the permission card and cuts nothing", async (t) => {
  const r = repo(t);
  const jobs = jobsAt(r.dir);
  const asked = [];
  jobs.turnoverCutFor = (name, key, opts) =>
    planTurnoverCut({ project: { turnoverBranches: [], turnoverPolicy: "ask" }, key: key || "task 7", name: opts?.name || "", at: FIXED_AT });
  jobs.requestTurnoverBranch = async (request) => {
    asked.push(request);
    return { id: "req-7", deadline: null, timeoutSeconds: 300 };
  };
  await assert.rejects(
    () => jobs.makeWorktree(r.dir, "fix the permission card", { project: "demo", turnoverKey: "task 7", mainBranch: "main" }),
    (e) => {
      assert.match(String(e.message), /implementation tree/, "the refusal says what the cut is");
      assert.match(String(e.message), /permission card \(req-7\)/, "and names the card that was raised");
      assert.match(String(e.message), /20261126_1800_TASK-7_/, "and the branch the answer will make");
      return true;
    },
  );
  assert.equal(asked.length, 1, "exactly one card");
  assert.equal(asked[0].project, "demo");
  assert.equal(asked[0].key, "task 7");
  assert.match(asked[0].branch, /^20261126_1800_TASK-7_/i);
  assert.equal(asked[0].policy, "ask");
  assert.equal(existsSync(path.join(r.dir, ".worktrees")), false, "nothing was cut: the tree comes after the answer");
});

test("4. planCut never answers turnover: a child of any parent is research or implementation", () => {
  // A STATED turnover is not a child's answer: the brief decides, and the record says the reader did not choose it.
  const stated = planCut({ project: "demo", parent: TURNOVER, kind: "turnover", brief: "fix lib/x.js" });
  assert.equal(stated.cut, true, "a cut is never refused");
  assert.equal(stated.kind, "implementation", "turnover is the container, so the brief decides the child");
  assert.equal(stated.stated, false, "the ignored answer is not recorded as the reader's");
  assert.equal(stated.containerParent, true, "the parent is the container");

  // A turnover parent, both briefs. It was the one case that used to short-circuit to turnover.
  assert.equal(planCut({ project: "demo", parent: TURNOVER, brief: "fix lib/x.js" }).kind, "implementation");
  assert.equal(planCut({ project: "demo", parent: TURNOVER, brief: "read the guard and report how it decides" }).kind, "research");

  // A main parent leaves the brief to decide, both ways.
  assert.equal(planCut({ parent: "main", mainBranch: "main", brief: "fix the guard in lib/push-guard.js" }).kind, "implementation");
  assert.equal(planCut({ parent: "main", mainBranch: "main", brief: "read the guard and report how it decides" }).kind, "research");

  // A NESTED child - the parent is a research or implementation tree - classifies by its own brief too.
  const nested = planCut({ project: "demo", parent: "wtgui/fix-the-guard-abc123", brief: "add a retry to the fetch" });
  assert.equal(nested.kind, "implementation", "a nested child's brief decides");
  assert.equal(nested.containerParent, false);
  assert.equal(planCut({ project: "demo", parent: "wtgui/what-is-the-seam-def456", brief: "what is the seam" }).kind, "research");

  // A stated child kind wins.
  assert.equal(planCut({ parent: TURNOVER, kind: "research", brief: "fix lib/x.js" }).kind, "research");

  // Even a cut nobody described answers a kind: research is the quiet one.
  const bare = planCut({ project: "demo", parent: "feature/the-seam" });
  assert.equal(bare.cut, true);
  assert.equal(bare.kind, "research");
  assert.equal(bare.clarify, undefined, "there is no clarify card in the rule at all");

  // The container's OWN cut is the only turnover answer.
  const container = planTurnoverContainer({ project: "demo", key: "task 18", parent: "main", mainBranch: "main", branch: TURNOVER });
  assert.equal(container.kind, "turnover");
  assert.equal(container.container, true);
  assert.equal(container.localOnly, false);
  assert.match(container.why, /feature container itself/);

  // The vocabulary is still the three, with a label and a note each, but a CUT offers only the two child kinds.
  assert.deepEqual(BRANCH_KINDS, ["turnover", "research", "implementation"]);
  assert.deepEqual(CHILD_KINDS, ["research", "implementation"]);
  assert.deepEqual(kindChoices().map((c) => c.value), CHILD_KINDS, "the dialog offers the two child kinds");
  for (const kind of BRANCH_KINDS) {
    assert.ok(KIND_LABELS[kind], `${kind} has a label`);
    assert.ok(KIND_NOTES[kind], `${kind} has a note`);
  }
  assert.equal(KIND_LABELS.turnover, "turnover tree", "the container's own name, not a child's");
});

test("5. the parent options preselect the feature's turnover branch, with main still offered", () => {
  const feature = "20261126_1800_TASK-186_fix-the-seam";
  const choices = cutParentChoices({ parent: "main", mainBranch: "main", turnoverBranch: feature });
  assert.equal(choices.length, 2, "a main row has a real choice");
  assert.deepEqual(choices.map((c) => c.branch), [feature, "main"], "the feature's turnover branch first, main second");
  assert.equal(choices[0].preselected, true, "the turnover branch is preselected");
  assert.equal(choices[0].role, "turnover");
  assert.equal(choices[1].preselected, false, "main is offered, not imposed");
  assert.equal(choices[1].role, "main");

  // A project with no turnover branch: main, alone.
  const plain = cutParentChoices({ parent: "main", mainBranch: "main" });
  assert.deepEqual(plain.map((c) => c.branch), ["main"]);
  assert.equal(plain[0].preselected, true);

  // A row already on the container cuts from it, with no alternative.
  const onTurnover = cutParentChoices({ parent: feature, mainBranch: "main", turnoverBranch: feature });
  assert.deepEqual(onTurnover.map((c) => c.branch), [feature]);
  assert.equal(onTurnover[0].role, "turnover");

  // A nested row cuts from its own branch, alone.
  const nested = cutParentChoices({ parent: "wtgui/fix-the-guard-abc123", mainBranch: "main", turnoverBranch: feature });
  assert.deepEqual(nested.map((c) => c.branch), ["wtgui/fix-the-guard-abc123"]);
  assert.equal(nested[0].role, "nested");
});

test("6. a push from a local-only tree asks, naming the tree and the kind", () => {
  // A directory that looks like a tree on this machine, built at run time so the file states no absolute path.
  const tree = path.resolve(process.cwd(), "demo", ".worktrees", "fix-the-guard-19d782");
  const ask = treeKindAsk({ tree, kind: "research" });
  assert.ok(ask, "a local-only kind earns an ask");
  assert.match(ask, /fix-the-guard-19d782/, "the ask names the tree");
  assert.match(ask, /research/, "the ask names the kind");
  assert.match(ask, /one push from this tree/, "the ask says what one grant covers");
  assert.match(ask, /lift/i, "the ask says what the reader's standing grant is");
  assert.ok(treeKindAsk({ tree, kind: "implementation" }), "implementation is local only too");

  const resolved = resolvePushPermissions({ name: "demo", pushNewBranches: "allow-all", pushExistingBranches: "allow-all" }, {});
  assert.equal(permissionForPush(resolved, { branch: "wtgui/fix-the-guard-19d782", isNew: true }), "allow", "without a kind the controls allow it");
  assert.equal(
    permissionForPush(resolved, { branch: "wtgui/fix-the-guard-19d782", isNew: true, tree, kind: "research" }),
    "ask",
    "research is not allowed by an allow-all control: it asks",
  );
  assert.equal(
    permissionForPush(resolved, { branch: "wtgui/fix-the-guard-19d782", isNew: true, tree, kind: "implementation" }),
    "ask",
    "implementation asks the same way",
  );
  const answer = pushPermissionFor(resolved, { branch: "wtgui/fix-the-guard-19d782", isNew: true, tree, kind: "research" });
  assert.equal(answer.permission, "ask", "the answer carries the decision");
  assert.match(answer.reason || "", /fix-the-guard-19d782/, "the answer carries the tree");
  assert.match(answer.reason || "", /research/, "the answer carries the kind");
  // A turnover tree is the container, not local only, so its push meets the ordinary controls.
  assert.equal(treeKindAsk({ tree, kind: "turnover" }), null, "a turnover tree earns no ask by its kind");
  assert.equal(permissionForPush(resolved, { branch: TURNOVER, isNew: true, tree, kind: "turnover" }), "allow");
});

test("7. the same push is allowed once the reader lifts it, and never still refuses outright", async (t) => {
  const r = repo(t);
  const jobs = jobsAt(r.dir);
  const made = await jobs.makeWorktree(r.dir, "fix the guard in lib/push-guard.js");
  const tree = made.path;
  const resolved = resolvePushPermissions({ name: "demo", pushNewBranches: "allow-all", pushExistingBranches: "allow-all" }, {});

  assert.equal(permissionForPush(resolved, { branch: made.branch, isNew: true, tree, kind: "implementation" }), "ask", "asked before the lift");

  const lifted = await jobs.liftKind({ tree, branch: made.branch });
  assert.equal(lifted?.lifted, true, "the lift is written on the tree's own record");
  assert.equal(lifted?.kind, "implementation", "lifting does not rewrite the kind");
  assert.equal(jobsAt(r.dir).treeKindFor({ tree, branch: made.branch })?.lifted, true, "the lift survives a restart");

  const rec = jobs.treeKindFor({ tree, branch: made.branch });
  assert.equal(
    permissionForPush(resolved, { branch: made.branch, isNew: true, tree, kind: rec.kind, lifted: rec.lifted }),
    "allow",
    "once lifted, the same push meets the ordinary controls and goes through",
  );
  assert.equal(treeKindAsk({ tree, kind: "implementation", lifted: true }), null, "a lifted tree earns no ask");

  const never = resolvePushPermissions({ name: "demo", pushNewBranches: "never", pushExistingBranches: "never" }, {});
  assert.equal(permissionForPush(never, { branch: "wtgui/x-19d782", isNew: true, tree, kind: "research" }), "refuse", "never beats the ask");
  const refusal = pushPermissionFor(never, { branch: "wtgui/x-19d782", isNew: true, tree, kind: "research" });
  assert.equal(refusal.permission, "refuse");
  assert.match(refusal.reason || "", /never/, "the refusal names the control");
  assert.doesNotMatch(refusal.reason || "", /permission card/, "and offers no card");
});

// 8. THE ROW'S KIND CELL, evaluated from the page's own source: all three letters, the container named as the
// container, BOTH local kinds drawn as the button that lifts them, and an UPGRADED one drawn as T - the kind it
// behaves as - with the kind it was left in the tooltip. The page cannot be imported (it is a classic script), so the
// region between KIND_MARK and the turnover mark is evaluated with the two helpers it calls.
test("8. the Kind column names the container, the local kinds, and what an upgraded one behaves as", () => {
  const src = readFileSync(path.resolve("public", "render-projects.js"), "utf8");
  const start = src.indexOf("const KIND_MARK =");
  const end = src.indexOf("// The row's turnover mark", start);
  assert.ok(start > 0 && end > start, "the kind-mark region is in public/render-projects.js");
  const esc = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const keyOf = (project, tree) => `${project}::${tree}`;
  const kindMarkHtml = new Function("esc", "keyOf", `${src.slice(start, end)}; return kindMarkHtml;`)(esc, keyOf);

  const container = kindMarkHtml({ branchKind: "turnover", project: "demo", path: "/w/t", branchKindParent: "main" });
  assert.match(container, />T</);
  assert.doesNotMatch(container, /data-kind-lift/, "the container has a destination already and no lift");
  assert.match(container, /kind-turnover/);
  assert.match(container, /turnover tree/, "T is called a turnover tree, not a child");
  assert.match(container, /feature container/, "and the tooltip says what it is");
  assert.match(container, /research and implementation trees are cut from it/, "and where its children come from");

  for (const kind of ["research", "implementation"]) {
    const unlifted = kindMarkHtml({ branchKind: kind, project: "demo", path: `/w/${kind}`, branchKindParent: TURNOVER });
    assert.match(unlifted, new RegExp(`>${kind === "research" ? "R" : "I"}<`), `${kind} draws its own letter`);
    assert.match(unlifted, /<button[^>]*data-kind-lift="demo::\/w\//, `${kind} is the button that lifts it`);
    assert.match(unlifted, /local only - press to lift/, "and says what pressing does");
    const lifted = kindMarkHtml({ branchKind: kind, branchKindLifted: true, project: "demo", path: `/w/${kind}`, branchKindParent: TURNOVER });
    assert.match(lifted, />T</, `${kind} upgraded reads T, the kind it behaves as`);
    assert.match(lifted, /kind-turnover/, "in the turnover chip, not its old letter");
    assert.doesNotMatch(lifted, new RegExp(`kind-${kind}`), "with the recorded kind no longer drawn");
    assert.match(lifted, /is-lifted/, "and the lifted ink still separates it from a recorded T");
    const was = kind === "research" ? "a research tree" : "an implementation tree";
    assert.match(lifted, new RegExp(`was ${was}, upgraded by the reader; it behaves as a turnover tree`), "the tooltip names the kind the record keeps");
    assert.doesNotMatch(lifted, /kind-tick|✓/, "with no tick");
    assert.doesNotMatch(lifted, /data-kind-lift/, "and no second lift");
  }
  assert.match(
    kindMarkHtml({ branchKind: "implementation", project: "demo", path: "/w/i", branchKindParent: TURNOVER }),
    /merges into its turnover branch/,
    "the implementation tooltip says where the work goes",
  );
  assert.equal(kindMarkHtml({ branchKind: "", project: "demo", path: "/w/x" }), "", "a tree with no record draws nothing");
});
