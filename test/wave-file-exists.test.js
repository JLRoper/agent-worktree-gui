// THE ARTEFACT GATE, PROVED AGAINST A REAL REPOSITORY.
//
// `file-exists` was in the closed vocabulary from the first slice and nothing read it: a wave whose acceptance was an
// artefact could never fold to done, which bit hardest on a repo with no remote - `clean` is transient, `commits`
// needs an unmerged branch, and every PR check needs a PR. This file is that gate's acceptance, and every case is a
// real git read in a temp directory, because the facts it has to settle are ones a stub cannot:
//
//   1. MET FROM THE MEMBER'S TREE. The artefact is on disk in the member's own tree; the gate closes and the wave
//      reads done.
//   2. MET FROM THE LANDING COMMIT WHEN THE TREE IS GONE. The tree is deleted and the path is read out of a commit on
//      the wave's main, with no worktree on disk - so a landed local-only wave stays closed after its cleanup.
//   3. UNMET WHEN THE PATH IS ABSENT: a tree that exists and does not hold it, and a landing read on a main that does
//      not hold it.
//   4. NEVER MET FROM AN UNMERGED BRANCH. A file committed only on a branch that was never merged is absent from main,
//      and the gate says not met.
//   5. UNKNOWN, NEVER A THROW, WHEN THERE IS NOTHING TO READ: no member, no row, no tree, no clone, a git reader that
//      throws, and a path that is not a repo-relative file.
//   6. A NAMED ABANDONMENT STILL CLOSES AS ABANDONED, exactly as the other checks do.
//
// The route case at the end proves the wiring: GET /api/waves hands the gate's path to the evidence reader and folds
// the read it gets back, so the path a wave names is the path that is actually read.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { gitIn } from "../lib/scan.js";
import { readMemberEvidence } from "../lib/wave-evidence.js";
import { Waves, readWaveGate, waveMember, waveMemberKey, waveView } from "../lib/waves.js";
import { WAVES_PATH, createWavesRoutes } from "../routes/waves.js";

process.env.GIT_TERMINAL_PROMPT = "0";
process.env.GCM_INTERACTIVE = "never";

const run = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_AUTHOR_NAME: "Artefact Test",
      GIT_AUTHOR_EMAIL: "artefact@example.invalid",
      GIT_COMMITTER_NAME: "Artefact Test",
      GIT_COMMITTER_EMAIL: "artefact@example.invalid",
    },
  }).trim();

// A LOCAL-ONLY project: `git init` on main, one commit, a worktree of it. No remote and no origin/main - which is the
// repo class this check exists for, and the class the lightest of the fixes has to read through.
function sandbox(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-file-exists-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, "project");
  mkdirSync(path.join(project, "docs"), { recursive: true });
  run(dir, "init", "-q", "-b", "main", project);
  writeFileSync(path.join(project, "docs", "artefact.md"), "# the artefact\n");
  writeFileSync(path.join(project, "README.md"), "base\n");
  run(project, "add", "-A");
  run(project, "commit", "-q", "-m", "the base, with the artefact");
  const tree = path.join(project, ".worktrees", "member");
  run(project, "worktree", "add", "-q", "-b", "member", tree);
  return { dir, project, tree };
}

const ARTEFACT = "docs/artefact.md";

const memberTask = (tree, over = {}) => ({
  id: 4,
  title: "one member",
  state: "done",
  project: "local-project",
  worktree: tree,
  waveId: "wave_01",
  pipelineRun: null,
  row: null,
  ...over,
});

// The board row the scan would have made for the member's tree: `hasRow` is what tells the gate the member is a real
// tree on the board, and the brief keeps "no row" as cannot tell.
const boardRow = (tree) => ({ path: tree, dirty: 0, ahead: 0, verdict: null, pr: null });

const evidenceFor = async (box, { paths = [ARTEFACT], task = null, row = null, git = gitIn, cwdFor = null } = {}) => {
  const member = task || memberTask(box.tree);
  return readMemberEvidence({
    task: member,
    row: row || boardRow(box.tree),
    paths,
    git,
    cwdFor: cwdFor || (() => box.project),
    mainRef: "origin/main",
  });
};

const gateOn = (rel, evidence, task = null, row = null) => {
  const tree = task ? task.worktree : null;
  const member = waveMember(task || { id: 4, title: "one member", state: "done", project: "local-project", worktree: tree, waveId: "wave_01" }, row || (tree ? boardRow(tree) : null));
  return readWaveGate({ check: "file-exists", path: rel }, [member], () => evidence);
};

test("a landed local-only wave closes on an artefact in the member's tree", async (t) => {
  const box = sandbox(t);
  const evidence = await evidenceFor(box);
  const read = evidence.files?.[ARTEFACT];
  assert.ok(read, "the evidence carries a read for the path the gate names");
  assert.equal(read.state, "present");
  assert.equal(read.where, "tree");

  const gate = gateOn(ARTEFACT, evidence, memberTask(box.tree));
  assert.equal(gate.state, "met");
  assert.equal(gate.met, true);
  assert.equal(gate.closed, true);
  assert.match(gate.why, /docs\/artefact\.md/);

  // ...and the wave that carries it reads done, with no state stored anywhere.
  const drawn = waveView({
    wave: { id: "wave_01", initiativeId: "init_a", position: 1, title: "Wave 1", entryGate: null, exitGate: { check: "file-exists", path: ARTEFACT }, template: null, auto: false },
    members: [waveMember(memberTask(box.tree), boardRow(box.tree))],
    evidenceFor: () => evidence,
  });
  assert.equal(drawn.state, "done");
  assert.equal(drawn.gates.exit.state, "met");
});

test("the artefact in the landing commit keeps the wave closed after the member's tree is gone", async (t) => {
  const box = sandbox(t);
  const landed = run(box.project, "rev-parse", "main");
  // The cleanup a landed wave goes through: the tree is removed, so the path can only be read out of main.
  rmSync(box.tree, { recursive: true, force: true });
  const task = memberTask(box.tree);
  const evidence = await evidenceFor(box, { task });
  const read = evidence.files?.[ARTEFACT];
  assert.ok(read, "a tree that is gone still gets a read");
  assert.equal(read.state, "present");
  assert.equal(read.where, "landing");
  assert.equal(read.commit, landed, "the commit that holds the path on main");
  // origin/main does not exist in a local-only project, so the read names the local main it fell back to.
  assert.equal(read.ref, "main");
  assert.equal(read.mainSha, landed);

  const gate = gateOn(ARTEFACT, evidence, task);
  assert.equal(gate.state, "met");
  assert.equal(gate.closed, true);
  assert.match(gate.why, /main/);
});

test("a path that is absent is unmet: in a tree that exists, and in a landing that does not hold it", async (t) => {
  const box = sandbox(t);
  // A tree that exists and does not hold the path: the tree is authoritative, so main holding nothing else is moot.
  let evidence = await evidenceFor(box, { paths: ["docs/absent.md", ARTEFACT] });
  assert.equal(evidence.files["docs/absent.md"].state, "absent");
  assert.equal(evidence.files["docs/absent.md"].where, "tree");
  assert.equal(gateOn("docs/absent.md", evidence, memberTask(box.tree)).state, "unmet");

  // A directory is not the file the gate names.
  mkdirSync(path.join(box.tree, "docs", "a-directory"), { recursive: true });
  evidence = await evidenceFor(box, { paths: ["docs/a-directory"] });
  assert.equal(evidence.files["docs/a-directory"].state, "absent");
  assert.match(evidence.files["docs/a-directory"].why, /not a file/);
  assert.equal(gateOn("docs/a-directory", evidence, memberTask(box.tree)).state, "unmet");

  // The tree is gone and main never had the path.
  rmSync(box.tree, { recursive: true, force: true });
  const task = memberTask(box.tree);
  evidence = await evidenceFor(box, { task, paths: ["docs/never-landed.md"] });
  assert.equal(evidence.files["docs/never-landed.md"].state, "absent");
  assert.equal(evidence.files["docs/never-landed.md"].where, "landing");
  const gate = gateOn("docs/never-landed.md", evidence, task);
  assert.equal(gate.state, "unmet");
  assert.equal(gate.closed, false);
});

test("a file that exists only on an unmerged branch is never met", async (t) => {
  const box = sandbox(t);
  run(box.project, "checkout", "-q", "-b", "feature/unmerged", "main");
  writeFileSync(path.join(box.project, "docs", "branch-only.md"), "# only on the branch\n");
  run(box.project, "add", "-A");
  run(box.project, "commit", "-q", "-m", "a file that never merged");
  run(box.project, "checkout", "-q", "main");
  rmSync(box.tree, { recursive: true, force: true });
  const task = memberTask(box.tree);
  const evidence = await evidenceFor(box, { task, paths: ["docs/branch-only.md"] });
  const read = evidence.files["docs/branch-only.md"];
  assert.equal(read.state, "absent", "main is the only history the landing read walks");
  assert.equal(read.where, "landing");
  const gate = gateOn("docs/branch-only.md", evidence, task);
  assert.equal(gate.state, "unmet");
  assert.notEqual(gate.state, "met");
});

test("file-exists answers unknown, and never throws, when there is nothing to read", async (t) => {
  const box = sandbox(t);
  // No member at all: the check is named and there is nothing to read it against.
  assert.equal(readWaveGate({ check: "file-exists", path: ARTEFACT }, []).state, "none");
  // A member the scan has dropped (no board row) is not blind to THIS check: the artefact's fact is the read, and a
  // landed wave whose tree was cleaned must still close on its landing commit. But with nothing read for the path,
  // there is still nothing to say it exists.
  const noRow = waveMember(memberTask(box.tree), null);
  const presentStub = { files: { [ARTEFACT]: { state: "present", why: "stub" } } };
  assert.equal(readWaveGate({ check: "file-exists", path: ARTEFACT }, [noRow], () => presentStub).state, "met");
  const emptyStub = { files: {} };
  const unread = readWaveGate({ check: "file-exists", path: ARTEFACT }, [noRow], () => emptyStub);
  assert.equal(unread.state, "unknown");
  assert.match(unread.why, /no read of docs\/artefact\.md/);
  // A member whose evidence read was never made.
  assert.equal(gateOn(ARTEFACT, null, memberTask(box.tree)).state, "unknown");

  // A tree that is gone, no clone to ask, and a member that names no worktree: too little to tell.
  const nowhere = memberTask(null);
  const lost = await readMemberEvidence({ task: nowhere, row: null, paths: [ARTEFACT], cwdFor: () => null, mainRef: "origin/main" });
  assert.equal(lost.files[ARTEFACT].state, "unknown");
  assert.match(lost.files[ARTEFACT].why, /no tree and no clone/);
  assert.equal(gateOn(ARTEFACT, lost, nowhere).state, "unknown");

  // A git reader that throws is cannot tell with its sentence, never a pass and never an exception. The tree has to be
  // gone for git to be asked at all: while it exists the stat answers, which is the point of the tree half.
  rmSync(box.tree, { recursive: true, force: true });
  const throwing = await evidenceFor(box, {
    task: memberTask(box.tree),
    git: () => {
      throw new Error("the git child died");
    },
  });
  assert.equal(throwing.files[ARTEFACT].state, "unknown");
  assert.match(throwing.files[ARTEFACT].why, /git threw/);
  assert.equal(gateOn(ARTEFACT, throwing, memberTask(box.tree)).state, "unknown");

  // A path that is not a repo-relative file is refused rather than read off this machine.
  const escaping = await evidenceFor(box, { paths: ["../outside.txt"] });
  assert.equal(escaping.files["../outside.txt"].state, "unknown");
  assert.match(escaping.files["../outside.txt"].why, /repo-relative/);
});

test("a named abandonment still closes the file-exists gate as abandoned, not met", async (t) => {
  const box = sandbox(t);
  const evidence = await evidenceFor(box);
  const abandoned = waveMember(memberTask(box.tree, { abandoned: { reason: "the report was retired with the project", by: "reader" } }), boardRow(box.tree));
  const gate = readWaveGate({ check: "file-exists", path: ARTEFACT }, [abandoned], () => evidence);
  assert.equal(gate.state, "abandoned");
  assert.equal(gate.closed, true);
  assert.equal(gate.met, false);
  assert.match(gate.why, /retired with the project/);
});

test("the route hands the gate's path to the evidence reader, and folds the read it answers", async () => {
  const calls = [];
  const files = { [ARTEFACT]: { state: "present", why: "the tree at the member's tree holds docs/artefact.md", where: "tree", path: ARTEFACT } };
  const evidence = { member: 4, key: null, number: null, pr: null, why: "the member names no pull request", sha: null, cwd: null, tree: "the member's tree", files, landing: { state: "unknown", why: "no landing read" } };
  const store = { rowsFor: () => [{ path: "the member's tree", dirty: 0, ahead: 0, verdict: null, pr: null }] };
  const task = { id: 4, title: "one member", state: "done", project: "local-project", worktree: "the member's tree", waveId: "wave_01" };
  evidence.key = waveMemberKey(task);
  const waves = {
    statusOf: () => ({ file: "waves.json", found: true, readable: true, error: null }),
    wavesFor: () => [
      { id: "wave_01", initiativeId: "init_a", position: 1, title: "Wave 1", entryGate: null, exitGate: { check: "file-exists", path: ARTEFACT }, template: null, auto: false },
      // A second wave names another path, and the first wave's path again: the read is handed each path once, in the
      // order the gates name them.
      { id: "wave_02", initiativeId: "init_a", position: 2, title: "Wave 2", entryGate: { check: "file-exists", path: "docs/second.md" }, exitGate: { check: "file-exists", path: ARTEFACT }, template: null, auto: false },
    ],
    skippedFor: () => [],
  };
  const captured = [];
  const handler = createWavesRoutes({
    waves,
    assistant: { assistants: [{ id: "a1" }], queueView: () => ({ tasks: [task] }) },
    store,
    sendJson: (res, code, body) => captured.push({ code, body }),
    waveEvidence: async (arg) => {
      calls.push(arg);
      return new Map([[evidence.key, evidence]]);
    },
  });
  const url = new URL(`http://127.0.0.1${WAVES_PATH}?initiative=init_a`);
  assert.equal(await handler({ method: "GET", url: url.toString() }, {}, WAVES_PATH, url), true);
  assert.deepEqual(calls[0].paths, [ARTEFACT, "docs/second.md"], "the route names each path the waves' gates read, once, in order");
  assert.equal(captured[0].code, 200);
  assert.equal(captured[0].body.waves[0].gates.exit.state, "met");
  assert.equal(captured[0].body.waves[0].state, "done");
});

test("the store refuses a file-exists gate with no path, and keeps one the read can name", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-file-exists-store-"));
  try {
    const file = path.join(dir, "waves.json");
    const store = new Waves({ file, log: () => {} });
    store.load();
    const noPath = store.create({ initiativeId: "init_a", title: "no path", exitGate: { check: "file-exists" } });
    assert.equal(noPath.ok, false);
    assert.match(noPath.error, /needs "path"/);
    const withPath = store.create({ initiativeId: "init_a", title: "an artefact", exitGate: { check: "file-exists", path: ARTEFACT } });
    assert.equal(withPath.ok, true);
    assert.deepEqual(withPath.wave.exitGate, { check: "file-exists", path: ARTEFACT });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
