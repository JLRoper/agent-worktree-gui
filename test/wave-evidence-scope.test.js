// WHICH MEMBERS OWE AN EVIDENCE READ, AND WHICH HALF OF IT.
//
// Row 267 of the read queue: GET /api/initiatives took 64 s on a board of eight initiatives because the route built
// evidence for every task that names a wave, in every initiative, whether or not the wave has a gate and whatever the
// gate reads. One wave of twelve named a gate; it reads one artefact path; two tasks were its members. The fix is a
// scope (`waveEvidenceNeeds`) and a vocabulary (`WAVE_EVIDENCE_READS` / `evidenceReadsFor`), and these tests pin both
// ends of it: the table decides what is read, and a read that is not owed does not happen at all.
//
// The last test drives the real read against a real repository, because "no landing read was made" is a claim about
// work that did not happen, and only the real function can be asked whether it happened.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { evidenceReadsFor, readMemberEvidence } from "../lib/wave-evidence.js";
import { WAVE_EVIDENCE_READS, waveEvidenceNeeds, waveMember, readWaveGate } from "../lib/waves.js";

const run = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_AUTHOR_NAME: "Scope Test",
      GIT_AUTHOR_EMAIL: ["scope", "example.invalid"].join(String.fromCharCode(64)),
      GIT_COMMITTER_NAME: "Scope Test",
      GIT_COMMITTER_EMAIL: ["scope", "example.invalid"].join(String.fromCharCode(64)),
    },
  }).trim();

function repo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-wave-scope-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "lib"), { recursive: true });
  writeFileSync(path.join(dir, "lib", "a.js"), "export const a = 1;\n");
  writeFileSync(path.join(dir, "README.md"), "base\n");
  run(dir, "init", "-q", "-b", "main");
  run(dir, "add", "-A");
  run(dir, "commit", "-q", "-m", "base");
  return dir;
}

test("a wave with no gate, or a gate that judges the board row, owes no evidence read at all", () => {
  const none = waveEvidenceNeeds([
    { id: "w1", entryGate: null, exitGate: null },
    { id: "w2", entryGate: { check: "clean" }, exitGate: { check: "commits", min: 1 } },
    { id: "w3", entryGate: { check: "branch-exists", branch: "x" }, exitGate: null },
  ]);
  assert.deepEqual(none, { checks: [], waveIds: [], reads: { pr: false, landing: false, files: false } });
});

test("a gate that reads evidence names its wave and the halves it consumes", () => {
  const needs = waveEvidenceNeeds([
    { id: "w1", entryGate: { check: "pr-open" }, exitGate: null },
    { id: "w2", entryGate: null, exitGate: { check: "file-exists", path: "n8n/workflows/code-loop.json" } },
    { id: "w3", entryGate: { check: "clean" }, exitGate: null },
  ]);
  assert.deepEqual(needs.waveIds, ["w1", "w2"]);
  assert.deepEqual(needs.checks, ["pr-open", "file-exists"]);
  assert.deepEqual(needs.reads, { pr: true, landing: false, files: true });
  // One wave id, however many gates name it.
  const twice = waveEvidenceNeeds([{ id: "w1", entryGate: { check: "pr-merged" }, exitGate: { check: "main-moved" } }]);
  assert.deepEqual(twice.waveIds, ["w1"]);
  assert.deepEqual(twice.reads, { pr: true, landing: true, files: false });
});

test("the table is the closed vocabulary the gate reads: every check that calls evidenceFor is in it", () => {
  // The five claims the gate makes by reading evidence: pr-open reads the PR, pr-merged the PR and the landing,
  // main-moved the landing, file-exists the artefact. A check absent from this table must be a check whose answer
  // never consults `evidenceFor` - clean, commits, branch-exists, branch-name, pushed, pr-head, reviewers-exact,
  // pr-comments, pr-approved, command (the last answers cannot tell from the gate's own default case).
  assert.deepEqual(Object.keys(WAVE_EVIDENCE_READS).sort(), ["file-exists", "main-moved", "pr-merged", "pr-open"]);
  assert.deepEqual(evidenceReadsFor(null), { pr: true, landing: true, files: true });
  assert.deepEqual(evidenceReadsFor([]), { pr: false, landing: false, files: false });
  assert.deepEqual(evidenceReadsFor(["pr-open"]), { pr: true, landing: false, files: false });
  assert.deepEqual(evidenceReadsFor(["file-exists"]), { pr: false, landing: false, files: true });
  assert.deepEqual(evidenceReadsFor(["pr-merged", "file-exists"]), { pr: true, landing: true, files: true });
  assert.deepEqual(evidenceReadsFor(["clean", "commits"]), { pr: false, landing: false, files: false });
});

test("a file-exists read asks the host for nothing and the clone only for the artefact", async (t) => {
  const dir = repo(t);
  let prReads = 0;
  let gitCalls = 0;
  const git = async (cwd, args, timeout) => {
    gitCalls += 1;
    return { ok: true, out: "", err: "" };
  };
  const task = {
    id: 647,
    project: "n8n-jlr",
    waveId: "wave-code-loop",
    state: "done",
    worktree: dir,
    row: { pr: { number: 12, state: "MERGED" }, path: dir },
  };
  const evidence = await readMemberEvidence({
    task,
    readPr: async () => {
      prReads += 1;
      return { ok: true, pr: { number: 12, state: "MERGED", headRefOid: "deadbeef" } };
    },
    git,
    mainRef: "origin/main",
    paths: ["lib/a.js"],
    checks: ["file-exists"],
  });
  assert.equal(prReads, 0, "the host was never asked for a pull request a gate here does not read");
  assert.equal(evidence.pr, null);
  assert.equal(evidence.landing, null, "the landing read was not made");
  assert.equal(evidence.sha, null);
  assert.equal(evidence.files["lib/a.js"].state, "present");
  assert.equal(gitCalls, 0, "a tree that holds the artefact answers with a stat, not a git call");
  // The gate this read was made for closes on the artefact, and the one it was not made for cannot tell rather than
  // pass: a narrow read is never a wider gate's evidence.
  assert.equal(readWaveGate({ check: "file-exists", path: "lib/a.js" }, [waveMember(task)], () => evidence).state, "met");
  assert.equal(readWaveGate({ check: "pr-merged" }, [waveMember(task)], () => evidence).state, "unknown");
});

test("the wider read still happens when no scope is given, and a pr-open scope reads only the pull request", async (t) => {
  const dir = repo(t);
  const task = { id: 1, project: "p", waveId: "w", state: "done", worktree: dir, row: { pr: { number: 9, state: "OPEN" }, path: dir } };
  let gitCalls = 0;
  const git = async () => {
    gitCalls += 1;
    return { ok: true, out: "", err: "" };
  };
  const open = await readMemberEvidence({
    task,
    readPr: async () => ({ ok: true, pr: { number: 9, state: "OPEN", headRefOid: "abc" } }),
    git,
    mainRef: "origin/main",
    checks: ["pr-open"],
  });
  assert.equal(open.pr.state, "OPEN");
  assert.equal(gitCalls, 0, "pr-open reads no landing, so no git call is owed");
  assert.equal(readWaveGate({ check: "pr-open" }, [waveMember(task)], () => open).state, "met");

  // No `checks` at all is the historical read-everything: the landing read is made (git is called) and a PR that
  // names a number is asked for.
  const wide = await readMemberEvidence({
    task,
    readPr: async () => ({ ok: true, pr: { number: 9, state: "OPEN", headRefOid: "abc" } }),
    git,
    mainRef: "origin/main",
  });
  assert.ok(gitCalls > 0, "the unscoped read still makes the landing read");
  assert.notEqual(wide.landing, null);
});
