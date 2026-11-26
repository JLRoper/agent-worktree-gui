// The ＋ route, proved over HTTP against the real server on its own port.
//
//   POST /api/worktree/child {project, path, name?, kind?: research|implementation, parent?, turnoverKey?}
//
// The cut itself is proved in test/child-worktree.test.js against real git. This file is about the wiring the page
// talks to, and about the two claims only the route can make:
//
//   - the tree it cuts is a tree the ROLL-UP will accept (two records and a boarded row, not one git command);
//   - an IMPLEMENTATION asked for with a main parent first cuts the feature's TURNOVER tree under the project's
//     turnover policy and then cuts the child from it: one press, two trees, the parent recorded. A child of a
//     turnover branch is research or implementation by its brief and never turnover; under `ask` the whole press
//     parks on the permission card and the answer cuts both trees.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configureRepo, git, post, slash, startPanel, waitForRow } from "../tools/panel-testkit.mjs";

const TURNOVER = "20261112_0900_DMR-70001_the_parent";

test("the child route cuts from the row's branch, classifies by the brief, and auto-cuts a turnover parent for implementation", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "wtgui-childroute-"));
  const scanRoot = path.join(base, "repos");
  const repo = path.join(scanRoot, "proj");
  await mkdir(repo, { recursive: true });

  git(repo, ["init", "-q", "-b", "main"]);
  configureRepo(repo);
  await writeFile(path.join(repo, "base.txt"), "base\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "main: base"]);

  // The parent row: a worktree on its own branch, one commit of its own — the branch a child is cut from.
  const parentTree = path.join(repo, ".worktrees", "feat-parent");
  git(repo, ["worktree", "add", "-q", "-b", "feat/parent", parentTree]);
  await writeFile(path.join(parentTree, "parent.txt"), "the parent's work\n", "utf8");
  git(parentTree, ["add", "."]);
  git(parentTree, ["commit", "-q", "-m", "parent: its own commit"]);
  const parentSha = git(parentTree, ["rev-parse", "HEAD"]);

  // main moves on AFTER the parent was cut, so a child cut from HEAD is a different sha and a different tree.
  await writeFile(path.join(repo, "later.txt"), "main moved on\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "main: later"]);

  // A row standing ON main: the checkout moves aside and main stands in a worktree of its own. This is the row an
  // implementation is asked for with a main parent.
  git(repo, ["checkout", "-q", "-b", "parked"]);
  const mainTree = path.join(repo, ".worktrees", "on-main");
  git(repo, ["worktree", "add", "-q", mainTree, "main"]);

  // A worktree on a turnover branch: its children are research or implementation, never turnover.
  const turnoverTree = path.join(repo, ".worktrees", "the-parent");
  git(repo, ["worktree", "add", "-q", "-b", TURNOVER, turnoverTree, "main"]);
  await writeFile(path.join(turnoverTree, "turnover.txt"), "the feature's container\n", "utf8");
  git(turnoverTree, ["add", "."]);
  git(turnoverTree, ["commit", "-q", "-m", "container: its own work"]);

  const panel = await startPanel({ config: { scanRoots: [scanRoot] } });
  t.after(async () => {
    await panel.stop();
    await rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const reload = await post(panel.base, "/api/reload", { body: {} });
  assert.equal(reload.status, 200, `reload must succeed: ${reload.text.slice(0, 200)}`);
  // The snapshot's own spelling is what the page posts back; the route matches that string.
  const parentRow = await waitForRow(panel.base, "proj", parentTree);
  const mainRow = await waitForRow(panel.base, "proj", mainTree);
  const containerRow = await waitForRow(panel.base, "proj", turnoverTree);

  // Refusals first: the project's own checkout is not a worktree, an unknown project and an unknown path are 404s.
  const root = await post(panel.base, "/api/worktree/child", { body: { project: "proj", path: repo } });
  assert.equal(root.status, 409, `the checkout is refused: ${root.text.slice(0, 200)}`);
  assert.match(root.json?.error || "", /own checkout, not a worktree/);

  const noProject = await post(panel.base, "/api/worktree/child", { body: { project: "nope", path: parentRow.path } });
  assert.equal(noProject.status, 404);
  assert.match(noProject.json?.error || "", /unknown project/);

  const noRow = await post(panel.base, "/api/worktree/child", { body: { project: "proj", path: path.join(base, "elsewhere") } });
  assert.equal(noRow.status, 404, "a path no row holds is a 404, not a cut somewhere else");

  // THE VOCABULARY the dialog reads: the two child kinds (never turnover), and the row's parent options. A feature
  // branch is a NESTED parent, so it is the only option.
  const kinds = await (await fetch(`${panel.base}/api/branch-kinds?project=proj&parent=${encodeURIComponent(parentRow.branch)}`)).json();
  assert.deepEqual(kinds.kinds, ["research", "implementation"], "a cut offers the two child kinds");
  assert.deepEqual(kinds.choices.map((c) => c.value), ["research", "implementation"]);
  assert.deepEqual(kinds.parents.map((p) => p.role), ["nested"], "a feature branch is this tree's own branch");

  // THE CUT, with no stated kind: the brief (the name, else the branch) reads as research. The route never asks.
  const research = await post(panel.base, "/api/worktree/child", { body: { project: "proj", path: parentRow.path } });
  assert.equal(research.status, 200, `a bare cut is research now: ${research.text.slice(0, 300)}`);
  assert.equal(research.json.kind, "research");
  assert.equal(research.json.parent, "feat/parent");
  assert.equal(research.json.clarify, undefined, "there is no clarify card in the rule at all");

  // A STATED turnover is not a child's answer: it is ignored and the brief decides.
  const asTurnover = await post(panel.base, "/api/worktree/child", { body: { project: "proj", path: parentRow.path, kind: "turnover", name: "fix the child" } });
  assert.equal(asTurnover.status, 200, asTurnover.text.slice(0, 300));
  assert.equal(asTurnover.json.kind, "implementation", "a child of a feature branch is never turnover");

  // The press. The name is the reader's; the tag is the server's; the kind is the reader's answer.
  const cut = await post(panel.base, "/api/worktree/child", {
    body: { project: "proj", path: parentRow.path, name: "child of feat/parent", kind: "implementation" },
  });
  assert.equal(cut.status, 200, `the cut must answer 200: ${cut.text.slice(0, 400)}`);
  const made = cut.json;
  assert.equal(made.ok, true);
  assert.match(made.branch, /^wtgui\/child-of-feat-parent-[0-9a-f]{6}$/);
  assert.equal(made.parent, "feat/parent");
  assert.equal(made.parentSha, parentSha, "the parent's tip at the cut is on the answer, so the page can name it");
  assert.equal(slash(made.path), `${slash(repo)}/.worktrees/${path.basename(made.path)}`);
  assert.match(slash(made.path), /\/\.worktrees\/child-of-feat-parent-[0-9a-f]{6}$/, "the tree lands inside the project, where the board holds rows");

  // What git says, not what the answer says.
  assert.equal(git(made.path, ["rev-parse", "HEAD"]), parentSha);
  assert.equal(git(made.path, ["rev-parse", "--abbrev-ref", "HEAD"]), made.branch);
  assert.equal(existsSync(path.join(made.path, "parent.txt")), true);
  assert.equal(existsSync(path.join(made.path, "later.txt")), false, "the child came from the parent, not from main");
  assert.match(git(repo, ["worktree", "list", "--porcelain"]), new RegExp(`worktree ${made.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  // The parent's own tree did not move and did not gain the child's branch as a checkout.
  assert.equal(git(parentTree, ["rev-parse", "HEAD"]), parentSha);
  assert.equal(git(parentTree, ["status", "--porcelain"]), "", "a cut writes nothing into the parent's tree");

  // The parent book says "cut" — the only source the roll-up will act on — and the row is on the board.
  const parents = await (await fetch(`${panel.base}/api/parents?project=proj`)).json();
  const rec = (parents.parents || []).find((r) => r.branch === made.branch);
  assert.ok(rec, `the cut is written down as a parent record: ${JSON.stringify(parents.parents)}`);
  assert.equal(rec.parent, "feat/parent");
  assert.equal(rec.parentSource, "cut", "a guess would refuse the roll-up");
  assert.equal(rec.parentSha, parentSha);

  const childRow = await waitForRow(panel.base, "proj", made.path);
  assert.equal(childRow.branch, made.branch, "the child is boarded by the route, not by the next discovery pass");

  // The claim the button exists for: the rollup route accepts this child, and names the parent it would write in.
  const preview = await post(panel.base, "/api/worktree/rollup", { body: { project: "proj", path: childRow.path } });
  assert.equal(preview.status, 428, `a roll preview (no confirm) is the route working: ${preview.text.slice(0, 300)}`);
  assert.equal(preview.json?.parent, "feat/parent");
  assert.equal(preview.json?.branch, made.branch);

  // A SECOND press is a second child of the same branch: the tag is what makes the name unique, so both stand.
  const second = await post(panel.base, "/api/worktree/child", { body: { project: "proj", path: parentRow.path, kind: "research" } });
  assert.equal(second.status, 200, second.text.slice(0, 300));
  assert.notEqual(second.json.path, made.path);
  assert.notEqual(second.json.branch, made.branch);
  assert.match(second.json.branch, /^wtgui\/parent-[0-9a-f]{6}$/, "with no name, the child is named after the branch's last word");
  await waitForRow(panel.base, "proj", second.json.path);

  // A CHILD OF A TURNOVER BRANCH classifies research or implementation, never turnover - even a code brief.
  const fromContainer = await post(panel.base, "/api/worktree/child", { body: { project: "proj", path: containerRow.path, name: "fix the roll-up", kind: "implementation" } });
  assert.equal(fromContainer.status, 200, fromContainer.text.slice(0, 300));
  assert.equal(fromContainer.json.kind, "implementation", "the brief decides, and it names code");
  assert.equal(fromContainer.json.parent, TURNOVER, "the parent is the container");
  const containerCutRec = (await (await fetch(`${panel.base}/api/parents?project=proj`)).json()).parents.find((r) => r.branch === fromContainer.json.branch);
  assert.equal(containerCutRec.parent, TURNOVER, "the chart hangs the child under the container");
  assert.equal(git(fromContainer.json.path, ["rev-parse", "HEAD"]), git(turnoverTree, ["rev-parse", "HEAD"]), "the child starts at the container's tip");

  // AN IMPLEMENTATION ASKED FOR WITH A MAIN PARENT: under `free` the feature's turnover tree is cut first, then the
  // child from it. One press, two trees, the parent recorded.
  const free = await post(panel.base, "/api/project-turnover", { body: { project: "proj", turnoverPolicy: "free" } });
  assert.equal(free.status, 200, free.text.slice(0, 300));
  const auto = await post(panel.base, "/api/worktree/child", { body: { project: "proj", path: mainRow.path, kind: "implementation", name: "fix the seam" } });
  assert.equal(auto.status, 200, `the auto-cut must answer 200: ${auto.text.slice(0, 400)}`);
  assert.ok(auto.json.container, "the answer names the container it cut");
  assert.equal(auto.json.parent, auto.json.container.branch, "the child's parent is the container, not main");
  assert.match(auto.json.container.branch, /^[0-9]{8}_[0-9]{4}_KEY-[0-9]+_fix-the-seam$/, "the feature's branch carries the derived ticket and the cut's words");
  assert.equal(existsSync(auto.json.container.path), true, "two trees: the container exists");
  assert.equal(existsSync(auto.json.path), true, "two trees: the child exists");
  assert.equal(git(auto.json.path, ["rev-parse", "HEAD"]), git(mainTree, ["rev-parse", "HEAD"]), "the child starts at the container's tip");
  const autoParents = (await (await fetch(`${panel.base}/api/parents?project=proj`)).json()).parents;
  const containerRec = autoParents.find((r) => r.branch === auto.json.container.branch);
  assert.equal(containerRec.parentSource, "cut");
  assert.equal(containerRec.parent, "main", "the container is cut from the project's base");
  const autoChildRec = autoParents.find((r) => r.branch === auto.json.branch);
  assert.equal(autoChildRec.parent, auto.json.container.branch, "the parent recorded is the container");
  // The container is a ROW, and the child hangs under it.
  await waitForRow(panel.base, "proj", auto.json.container.path);
  await waitForRow(panel.base, "proj", auto.json.path);

  // UNDER `ask` the same press parks on the permission card and cuts nothing until the reader answers. The answer's
  // resume cuts the container AND the child it was asked about.
  const ask = await post(panel.base, "/api/project-turnover", { body: { project: "proj", turnoverPolicy: "ask" } });
  assert.equal(ask.status, 200, ask.text.slice(0, 300));
  const parked = await post(panel.base, "/api/worktree/child", { body: { project: "proj", path: mainRow.path, kind: "implementation", name: "fix the other seam", turnoverKey: "task 42" } });
  assert.equal(parked.status, 202, `the press parks: ${parked.text.slice(0, 300)}`);
  assert.equal(parked.json.asked, true);
  assert.ok(parked.json.id, "the card is a real request");
  assert.match(parked.json.branch, /^[0-9]{8}_[0-9]{4}_TASK-42_fix-the-other-seam$/, "the card names the branch it will make");
  assert.equal(existsSync(path.join(repo, ".worktrees", path.basename(parked.json.branch))), false, "nothing is cut before the answer");

  const answer = await post(panel.base, "/api/approvals/answer", { body: { id: parked.json.id, choice: "once" } });
  assert.equal(answer.status, 200, `the answer must be accepted: ${answer.text.slice(0, 400)}`);
  assert.ok(answer.json.resumed?.container, "the answer resumed the two-tree cut");
  assert.equal(answer.json.resumed.out.parent, answer.json.resumed.container.branch);
  assert.equal(existsSync(answer.json.resumed.container.path), true, "the answer cut the container");
  assert.equal(existsSync(answer.json.resumed.out.path), true, "and the child");
  await waitForRow(panel.base, "proj", answer.json.resumed.container.path);
  await waitForRow(panel.base, "proj", answer.json.resumed.out.path);
});
