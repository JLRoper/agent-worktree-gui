// The CHECKING outcome's route, proved over HTTP against the real server on its own port.
//
//   POST /api/worktree/verify-landed {project, path}
//
// The act behind the answer is tested in test/verify-landed.test.js; this file is about the wiring the page actually
// talks to - the resolution of a path to its project, every refusal that has to reach the reader as a sentence rather
// than a dead button, and `{dryRun: true}` handing the script back without starting a run. A sandbox panel has no
// gateway key, so a start that gets past every gate answers 503 and NAMES the gateway: that is the proof it reached
// the last step, and it is deliberately not a 400 about the tree.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configureRepo, git, post, slash, startPanel } from "../tools/panel-testkit.mjs";

test("the check route resolves the tree and refuses what it must, without starting a run", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wtgui-checkroute-"));
  const repo = path.join(root, "proj");
  await mkdir(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  configureRepo(repo);
  await writeFile(path.join(repo, "README.md"), "# test\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "init"]);

  // One tree with work of its own, and one that never committed anything: the two shapes the route judges differently.
  const worked = path.join(repo, ".worktrees", "wt-worked");
  git(repo, ["worktree", "add", "-q", "-b", "feat/worked", worked]);
  await writeFile(path.join(worked, "work.txt"), "a change\n", "utf8");
  git(worked, ["add", "."]);
  git(worked, ["commit", "-q", "-m", "add work"]);
  const empty = path.join(repo, ".worktrees", "wt-empty");
  git(repo, ["worktree", "add", "-q", "-b", "feat/empty", empty]);

  const panel = await startPanel({ config: { scanRoots: [root] } });
  t.after(async () => {
    await panel.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const reload = await post(panel.base, "/api/reload", { body: {} });
  assert.equal(reload.status, 200, `reload must succeed: ${reload.text.slice(0, 200)}`);

  // A path that is not one of this project's trees: a sentence, not a stack trace.
  const stray = await post(panel.base, "/api/worktree/verify-landed", { body: { project: "proj", path: path.join(root, "nope") } });
  assert.equal(stray.status, 404);
  assert.match(stray.json?.error || "", /no such directory/);

  const unowned = await post(panel.base, "/api/worktree/verify-landed", { body: { project: "proj", path: root } });
  assert.equal(unowned.status, 400, "a directory no project owns is refused, not checked");
  assert.match(unowned.json?.error || "", /not inside a known project/);

  // The project's own checkout is on the base branch itself: there is no branch of its own to check.
  const onBase = await post(panel.base, "/api/worktree/verify-landed", { body: { project: "proj", path: repo } });
  assert.ok([400, 409].includes(onBase.status), `the base checkout is refused: ${onBase.status} ${onBase.text.slice(0, 200)}`);

  // A branch that never committed has nothing to check - and a check that "confirmed" it would be a lie.
  const nothing = await post(panel.base, "/api/worktree/verify-landed", { body: { project: "proj", path: empty } });
  assert.equal(nothing.status, 409);
  assert.match(nothing.json?.error || "", /no commits off main/);

  // The dry run: the script, the label, the ref, and NO run - the one answer that costs nothing.
  const dry = await post(panel.base, "/api/worktree/verify-landed", { body: { project: "proj", path: worked, dryRun: true } });
  assert.equal(dry.status, 200, `the dry run must answer 200: ${dry.text.slice(0, 300)}`);
  assert.equal(dry.json.dryRun, true);
  assert.equal(dry.json.label, "CHECKING MAIN");
  assert.equal(dry.json.base, "main");
  assert.equal(dry.json.branch, "feat/worked");
  assert.equal(slash(dry.json.worktree), slash(worked));
  assert.match(dry.json.prompt, /git apply --check --reverse/, "the script the agent is held to is handed back");
  assert.match(dry.json.prompt, /LANDED: YES/);
  assert.equal(dry.json.job, undefined, "a dry run starts nothing");

  // A real press: every gate passes, and the only thing missing is the gateway this sandbox deliberately has no key
  // for - so the answer names it instead of pretending a run exists.
  const start = await post(panel.base, "/api/worktree/verify-landed", { body: { project: "proj", path: worked } });
  assert.equal(start.status, 503, `a sandbox has no gateway: ${start.status} ${start.text.slice(0, 300)}`);
  assert.match(start.json?.error || "", /Hermes gateway API is not usable/);
  assert.equal(start.json?.prompt, undefined, "the refused start does not leak the whole script into the error");

  // And the board still holds the row: a refused check changed nothing.
  const state = await (await fetch(`${panel.base}/api/state`)).json();
  const proj = (state.projects || []).find((p) => p.name === "proj");
  assert.ok(proj, "the project is still on the board");
  assert.ok((proj.worktrees || []).some((w) => slash(w.path) === slash(worked)), "the refused check left its tree in place");
});
