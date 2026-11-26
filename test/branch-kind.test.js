// THE BRANCH-KIND RULE: what kind of tree a cut made, how the brief decides when the parent cannot, and what that
// kind does to a push.
//
// A tree records what it IS at the one moment the fact is knowable, and the record has exactly three kinds:
//
//   turnover        a child cut from an existing turnover branch the reader asked for;
//   research        a tree cut to answer a question, local only, never lands;
//   implementation  a tree cut to change code, local only, lands by merging locally.
//
// The parent names the turnover kind by itself. A cut from main (or from any other parent) is research or
// implementation, and the BRIEF decides which - the rule is lib/branch-kind.js `inferKindFromBrief`, and `planCut`
// always cuts. A cut that stopped to ask was a tree nobody got; there is no clarify card left in the rule.
//
// The push half: research and implementation are LOCAL ONLY, so a push from either parks on the permission card (one
// grant, one push from one tree) until the reader lifts the tree, which is the per-tree standing grant.
//
// Eight claims, each one a way this can look right and be wrong:
//
//   1. a turnover child records its kind beside its parent, keyed by the tree's tag;
//   2. a plain cut from main with a code brief records implementation, and is local only;
//   3. a plain cut from main with a research brief records research, and is local only;
//   4. a stated kind wins, a turnover parent wins next, and the brief decides last - and no case refuses to cut;
//   5. a push from a local-only tree asks rather than being refused outright, and NAMES the tree and the kind;
//   6. the same push meets the ordinary controls once the reader lifts it;
//   7. `never` still refuses outright, before the kind's ask and without a card;
//   8. the row's Kind cell draws all three letters and offers the lift for BOTH local kinds.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { BRANCH_KINDS, KIND_LABELS, KIND_NOTES, branchKindFor, isTurnoverBranch, kindChoices, planCut } from "../lib/branch-kind.js";
import { Jobs } from "../lib/jobs.js";
import { ParentBook } from "../lib/parents.js";
import { LOCAL_ONLY_TREE_KINDS, permissionForPush, pushPermissionFor, resolvePushPermissions, treeKindAsk } from "../lib/push-permissions.js";

const EMAIL = ["kind", "example.invalid"].join(String.fromCharCode(64));
const TURNOVER = "20261112_0900_DMR-44001_the_turnover";

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
  // cut is a cut from it - even for a brief that names code, because the parent names the kind first.
  r.git("checkout", "-q", "-b", TURNOVER);
  assert.equal(isTurnoverBranch(TURNOVER), true, "the turnover shape is recognised");
  assert.equal(branchKindFor({ parent: TURNOVER }).kind, "turnover", "a turnover parent classifies as a turnover child");
  assert.equal(branchKindFor({ parent: TURNOVER }).localOnly, false, "a turnover child is not local only by its kind");

  const jobs = jobsAt(r.dir);
  const made = await jobs.makeWorktree(r.dir, "fix the roll-up in lib/jobs.js");
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

test("2. a code brief cut from main records implementation, local only", async (t) => {
  const r = repo(t); // the checkout is on main: the plain cut's kind comes from the brief
  const jobs = jobsAt(r.dir);
  const made = await jobs.makeWorktree(r.dir, "fix the push gate in lib/push-permissions.js");

  const [rec] = Object.values(parentsBook(r.dir));
  assert.equal(rec.parent, "main", "the parent is the project's main parent");
  assert.equal(rec.kind, "implementation", "the code word and the file path make it implementation");
  assert.equal(made.localOnly, true, "an implementation tree is local only");
  assert.equal(LOCAL_ONLY_TREE_KINDS.includes(rec.kind), true, "the push rule treats implementation as local only");
  assert.deepEqual(
    { kind: jobsAt(r.dir).treeKindFor({ tree: made.path, branch: made.branch })?.kind, lifted: jobsAt(r.dir).treeKindFor({ tree: made.path, branch: made.branch })?.lifted },
    { kind: "implementation", lifted: false },
    "a fresh store reads the kind and that it has not been lifted",
  );
});

test("3. a research brief cut from main records research, local only", async (t) => {
  const r = repo(t);
  const jobs = jobsAt(r.dir);
  const made = await jobs.makeWorktree(r.dir, "research how the push gate decides a branch");
  const [rec] = Object.values(parentsBook(r.dir));
  assert.equal(rec.kind, "research", "no code word, no file and no commit - the brief reads as research");
  assert.equal(made.localOnly, true, "a research tree is local only");
  assert.equal(KIND_LABELS[rec.kind], "research tree");
});

test("4. planCut never blocks a cut: stated kind, then a turnover parent, then the brief", () => {
  // The stated kind wins over a parent that would say otherwise.
  const stated = planCut({ project: "demo", parent: TURNOVER, kind: "research", brief: "fix lib/x.js" });
  assert.equal(stated.cut, true, "a cut is never refused");
  assert.equal(stated.kind, "research", "the reader's answer wins over the parent");
  assert.equal(stated.stated, true, "the record says the reader chose it");
  assert.equal(stated.localOnly, true);

  // A turnover-shaped parent makes a turnover child whatever the brief says.
  const turnover = planCut({ project: "demo", parent: TURNOVER, brief: "fix lib/x.js" });
  assert.equal(turnover.cut, true);
  assert.equal(turnover.kind, "turnover");
  assert.equal(turnover.stated, false);
  assert.equal(turnover.localOnly, false);

  // A main parent leaves the brief to decide, both ways.
  assert.equal(planCut({ parent: "main", mainBranch: "main", brief: "fix the guard in lib/push-guard.js" }).kind, "implementation");
  assert.equal(planCut({ parent: "main", mainBranch: "main", brief: "read the guard and report how it decides" }).kind, "research");

  // A parent that is neither kind is not a question either: the brief decides, and the cut goes ahead.
  const feature = planCut({ project: "demo", parent: "feature/the-seam", brief: "add a retry to the fetch" });
  assert.equal(feature.cut, true, "a feature parent no longer stops the cut");
  assert.equal(feature.kind, "implementation", "the brief decides");
  assert.equal(feature.clarify, undefined, "there is no clarify card in the rule at all");

  // Even a cut nobody described answers a kind: research is the quiet one.
  const bare = planCut({ project: "demo", parent: "feature/the-seam" });
  assert.equal(bare.cut, true);
  assert.equal(bare.kind, "research");
  assert.equal(bare.clarify, undefined);

  // The vocabulary is exactly the three, with a label and a note each.
  assert.deepEqual(BRANCH_KINDS, ["turnover", "research", "implementation"]);
  assert.deepEqual(kindChoices().map((c) => c.value), BRANCH_KINDS, "the dialog offers the same three kinds");
  for (const kind of BRANCH_KINDS) {
    assert.ok(KIND_LABELS[kind], `${kind} has a label`);
    assert.ok(KIND_NOTES[kind], `${kind} has a note`);
  }
});

test("5. a push from a local-only tree asks, naming the tree and the kind", () => {
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
  // A turnover child is not local only, so its push meets the ordinary controls.
  assert.equal(treeKindAsk({ tree, kind: "turnover" }), null, "a turnover child earns no ask by its kind");
  assert.equal(permissionForPush(resolved, { branch: "20261112_0900_DMR-44001_x", isNew: true, tree, kind: "turnover" }), "allow");
});

test("6. the same push is allowed once the reader lifts it", async (t) => {
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
});

test("7. never still refuses outright, before the kind's ask and with no card", () => {
  const never = resolvePushPermissions({ name: "demo", pushNewBranches: "never", pushExistingBranches: "never" }, {});
  const tree = path.resolve(process.cwd(), "demo", ".worktrees", "fix-the-guard-19d782");
  assert.equal(permissionForPush(never, { branch: "wtgui/x-19d782", isNew: true, tree, kind: "research" }), "refuse", "never beats the ask");
  const answer = pushPermissionFor(never, { branch: "wtgui/x-19d782", isNew: true, tree, kind: "research" });
  assert.equal(answer.permission, "refuse");
  assert.match(answer.reason || "", /never/, "the refusal names the control");
  assert.doesNotMatch(answer.reason || "", /permission card/, "and offers no card");
});

// 8. THE ROW'S KIND CELL, evaluated from the page's own source: all three letters, and BOTH local kinds drawn as the
// button that lifts them - a lifted tree keeps its letter with a tick. The page cannot be imported (it is a classic
// script), so the region between KIND_MARK and the turnover mark is evaluated with the two helpers it calls.
test("8. the Kind column names all three kinds and draws the lift for both local kinds", () => {
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

  const turnover = kindMarkHtml({ branchKind: "turnover", project: "demo", path: "/w/t", branchKindParent: TURNOVER });
  assert.match(turnover, />T</);
  assert.doesNotMatch(turnover, /data-kind-lift/, "a turnover child has a destination already and no lift");
  assert.match(turnover, /kind-turnover/);

  for (const kind of ["research", "implementation"]) {
    const unlifted = kindMarkHtml({ branchKind: kind, project: "demo", path: `/w/${kind}`, branchKindParent: "main" });
    assert.match(unlifted, new RegExp(`>${kind === "research" ? "R" : "I"}<`), `${kind} draws its own letter`);
    assert.match(unlifted, /<button[^>]*data-kind-lift="demo::\/w\//, `${kind} is the button that lifts it`);
    assert.match(unlifted, /local only - press to lift/, "and says what pressing does");
    const lifted = kindMarkHtml({ branchKind: kind, branchKindLifted: true, project: "demo", path: `/w/${kind}`, branchKindParent: "main" });
    assert.match(lifted, /is-lifted/, `${kind} draws the lifted state`);
    assert.match(lifted, /kind-tick/, "with a tick");
    assert.doesNotMatch(lifted, /data-kind-lift/, "and no second lift");
  }
  assert.match(
    kindMarkHtml({ branchKind: "implementation", project: "demo", path: "/w/i", branchKindParent: "main" }),
    /merges into its turnover branch, or into main only on your grant/,
    "the implementation tooltip says where the work goes",
  );
  assert.equal(kindMarkHtml({ branchKind: "", project: "demo", path: "/w/x" }), "", "a tree with no record draws nothing");
});
