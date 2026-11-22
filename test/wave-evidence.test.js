// THE GATE'S EVIDENCE, PROVED AGAINST A REAL REPOSITORY.
//
// The claims this file has to settle are the ones a stub cannot: that a squash landing is judged BY CONTENT (the
// member's sha is not an ancestor of main, and the gate still closes), that content that did not land is refused,
// and that every unreadable read - a sha the clone does not hold, a main ref that does not resolve, no PR recorded, a
// reader that throws - answers cannot tell and blocks. Real git, in a temp directory, with a bare origin the clone
// pulls from: nothing here is mocked except the host's API, which is a function by design.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { gitIn } from "../lib/scan.js";
import { collectWaveEvidence, prByNumber, readLanding, readMemberEvidence, recordedShaOf } from "../lib/wave-evidence.js";
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
      GIT_AUTHOR_NAME: "Wave Test",
      GIT_AUTHOR_EMAIL: "wave@example.test",
      GIT_COMMITTER_NAME: "Wave Test",
      GIT_COMMITTER_EMAIL: "wave@example.test",
    },
  }).trim();

// A bare origin and a clone whose main is one commit. The clone is the "member's tree"; origin/main is the fact the
// gate reads.
function sandbox(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-wave-evidence-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origin = path.join(dir, "origin.git");
  const work = path.join(dir, "work");
  mkdirSync(work);
  run(dir, "init", "--bare", "-q", "-b", "main", origin);
  run(dir, "clone", "-q", origin, work);
  mkdirSync(path.join(work, "lib"), { recursive: true });
  writeFileSync(path.join(work, "lib", "a.js"), "export const a = 1;\n");
  writeFileSync(path.join(work, "README.md"), "base\n");
  run(work, "add", "-A");
  run(work, "commit", "-q", "-m", "base");
  run(work, "push", "-q", "-u", "origin", "main");
  return { dir, origin, work };
}

// Land a member's branch on main BY SQUASH: main gets a NEW sha whose tree holds the member's content, and the
// member's own commit is left dangling - exactly what this repo does, and exactly what ancestry cannot see.
function squashLand(t, { work }, file, content, message = "squash the member") {
  run(work, "checkout", "-q", "-b", "feature/member", "origin/main");
  writeFileSync(path.join(work, file), content);
  run(work, "add", "-A");
  run(work, "commit", "-q", "-m", "member change");
  const memberSha = run(work, "rev-parse", "HEAD");
  run(work, "checkout", "-q", "main");
  run(work, "merge", "--squash", "-q", "feature/member");
  run(work, "commit", "-q", "-m", message);
  const mainSha = run(work, "rev-parse", "HEAD");
  run(work, "push", "-q", "origin", "main");
  run(work, "fetch", "-q", "origin");
  run(work, "checkout", "-q", "main");
  return { memberSha, mainSha };
}

const landedTask = (work, over = {}) => ({
  id: 4,
  title: "one member",
  state: "done",
  project: null,
  worktree: work,
  waveId: "wave_01",
  pipelineRun: null,
  row: null,
  ...over,
});

const prRead = (state, head) => async ({ number }) => ({ ok: true, pr: { number, state, mergedAt: state === "MERGED" ? "2026-11-21T00:00:00.000Z" : null, headRefOid: head } });

test("a squash-merged member still closes: the sha is not an ancestor, and the gate judged CONTENT", async (t) => {
  const box = sandbox(t);
  const { memberSha, mainSha } = squashLand(t, box, "lib/a.js", "export const a = 2;\n");
  // The premise, measured: the member's sha is NOT an ancestor of the landed main. If this ever passes, the test
  // below proves nothing about squash, so it is asserted rather than assumed.
  assert.equal((await gitIn(box.work, ["merge-base", "--is-ancestor", memberSha, mainSha])).ok, false, "a squash landing rewrites the sha");

  const read = await readLanding({ cwd: box.work, sha: memberSha, mainRef: "origin/main" });
  assert.equal(read.state, "landed");
  assert.equal(read.ancestor, false, "the verdict was reached by content, not ancestry");
  assert.equal(read.mainSha, mainSha);
  assert.deepEqual(read.paths, ["lib/a.js"]);
  assert.match(read.why, /not an ancestor of main, so this was judged by content/);

  // ...and the gate that reads it closes.
  const member = waveMember(landedTask(box.work));
  assert.equal(readWaveGate({ check: "main-moved" }, [member], () => ({ landing: read })).state, "met");
});

test("a wave whose member was squash-merged with a rewritten sha closes, from real git and a stubbed API", async (t) => {
  const box = sandbox(t);
  const { memberSha } = squashLand(t, box, "lib/a.js", "export const a = 2;\n");
  const task = landedTask(box.work, { row: { pr: { number: 7, state: "MERGED" } } });
  const evidence = await readMemberEvidence({ task, readPr: prRead("MERGED", memberSha), mainRef: "origin/main" });
  assert.equal(evidence.pr.state, "MERGED");
  assert.equal(evidence.sha, memberSha, "the PR's own head is the sha that was judged");
  assert.equal(evidence.landing.state, "landed");
  const members = [waveMember(task)];
  const drawn = waveView({ wave: { id: "wave_01", initiativeId: "init_a", position: 1, title: "Wave 1", entryGate: null, exitGate: { check: "pr-merged" }, template: null, auto: false }, members, evidenceFor: () => evidence });
  assert.equal(drawn.state, "done");
  assert.equal(drawn.gates.exit.state, "met");
  assert.match(drawn.gates.exit.why, /judged by content/);
});

test("content that did not land is not met, even when the PR reads MERGED", async (t) => {
  const box = sandbox(t);
  const { memberSha } = squashLand(t, box, "lib/a.js", "export const a = 2;\n");
  // A different member changes the same file and is never landed.
  run(box.work, "checkout", "-q", "-b", "feature/other", "origin/main");
  writeFileSync(path.join(box.work, "lib", "a.js"), "export const a = 99;\n");
  run(box.work, "commit", "-qam", "other change");
  const otherSha = run(box.work, "rev-parse", "HEAD");
  run(box.work, "checkout", "-q", "main");

  const read = await readLanding({ cwd: box.work, sha: otherSha, mainRef: "origin/main" });
  assert.equal(read.state, "not-landed");
  assert.deepEqual(read.differ, ["lib/a.js"]);
  assert.match(read.why, /differs from the recorded sha in lib\/a\.js/);
  // The landed member still reads landed: the two are judged apart.
  assert.equal((await readLanding({ cwd: box.work, sha: memberSha, mainRef: "origin/main" })).state, "landed");
});

test("a PR the API reads MERGED but whose content is not on main blocks the exit gate as not met", async (t) => {
  const box = sandbox(t);
  const { memberSha } = squashLand(t, box, "lib/a.js", "export const a = 2;\n");
  // The PR claims a head that main's copy does not hold: a merge into some other base, or a push after the merge.
  run(box.work, "checkout", "-q", "-b", "feature/unlanded", "origin/main");
  writeFileSync(path.join(box.work, "lib", "a.js"), "export const a = 7;\n");
  run(box.work, "commit", "-qam", "unlanded");
  const sha = run(box.work, "rev-parse", "HEAD");
  run(box.work, "checkout", "-q", "main");
  const evidence = await readMemberEvidence({ task: landedTask(box.work, { row: { pr: { number: 7, state: "MERGED" } } }), readPr: prRead("MERGED", sha), mainRef: "origin/main" });
  const member = waveMember(landedTask(box.work));
  const gate = readWaveGate({ check: "pr-merged" }, [member], () => evidence);
  assert.equal(gate.state, "unmet");
  assert.match(gate.why, /differs from the recorded sha/);
  // The member's PR really was MEMBER-headed, and the other one is the landed fact: the read kept them apart.
  assert.equal(evidence.landing.state, "not-landed");
  assert.notEqual(memberSha, sha);
});

test("every unreadable landing read answers cannot tell, and none of them throws", async (t) => {
  const box = sandbox(t);
  const { memberSha } = squashLand(t, box, "lib/a.js", "export const a = 2;\n");
  const missing = "f".repeat(40);
  const cases = [
    { args: { cwd: box.work, sha: missing }, match: /not a commit/ },
    { args: { cwd: box.work, sha: null }, match: /records no sha/ },
    { args: { cwd: null, sha: "a".repeat(40) }, match: /records no worktree/ },
    { args: { cwd: box.work, sha: memberSha, mainRef: "origin/no-such-branch" }, match: /cannot be read/ },
    { args: { cwd: box.work, sha: memberSha, git: () => { throw new Error("git child died"); } }, match: /git threw/ },
  ];
  for (const { args, match } of cases) {
    const read = await readLanding(args);
    assert.equal(read.state, "unknown", JSON.stringify(args));
    assert.match(read.why, match);
  }
});

test("a member with no PR recorded answers cannot tell, and its stored state word is not evidence", async (t) => {
  const box = sandbox(t);
  const { memberSha } = squashLand(t, box, "lib/a.js", "export const a = 2;\n");
  const task = landedTask(box.work, { pipelineRun: { assembly: { commit: memberSha } } });
  const evidence = await readMemberEvidence({ task, mainRef: "origin/main" });
  assert.equal(evidence.number, null);
  assert.match(evidence.why, /names no pull request/);
  // The landing read still ran, on the run's own recorded sha - but the gate needs the PR, so it blocks.
  assert.equal(evidence.landing.state, "landed");
  const gate = readWaveGate({ check: "pr-merged" }, [waveMember(task)], () => evidence);
  assert.equal(gate.state, "unknown");
  assert.match(gate.why, /names no pull request/);
});

test("a PR read that throws is cannot tell, never met", async (t) => {
  const box = sandbox(t);
  const task = landedTask(box.work, { row: { pr: { number: 7, state: "MERGED" } } });
  const evidence = await readMemberEvidence({
    task,
    readPr: async () => {
      throw new Error("the gh child died");
    },
    mainRef: "origin/main",
  });
  assert.match(evidence.why, /threw: the gh child died/);
  assert.equal(evidence.landing.state, "unknown");
  assert.equal(readWaveGate({ check: "pr-merged" }, [waveMember(task)], () => evidence).state, "unknown");
});

test("a PR read that answers ok:false keeps its sentence, and cannot tell", async (t) => {
  const box = sandbox(t);
  const task = landedTask(box.work, { row: { pr: { number: 7, state: "MERGED" } } });
  const evidence = await readMemberEvidence({
    task,
    readPr: async () => ({ ok: false, why: "the host answered 502" }),
    mainRef: "origin/main",
  });
  assert.match(evidence.why, /502/);
  assert.equal(readWaveGate({ check: "pr-open" }, [waveMember(task)], () => evidence).state, "unknown");
});

test("the recorded sha: the assembly commit first, else the newest settled stage run, never a guess", () => {
  assert.equal(recordedShaOf({ pipelineRun: { assembly: { commit: "aaa" }, stageRuns: [{ commit: "bbb", status: "done" }] } }), "aaa");
  assert.equal(
    recordedShaOf({
      pipelineRun: {
        stageRuns: [
          { commit: "old", status: "done", settledAt: "2026-11-20T00:00:00.000Z" },
          { commit: "new", status: "done", settledAt: "2026-11-21T00:00:00.000Z" },
          { commit: "not", status: "failed", settledAt: "2026-11-22T00:00:00.000Z" },
        ],
      },
    }),
    "new",
  );
  assert.equal(recordedShaOf({ pipelineRun: { stageRuns: [{ commit: "x", status: "failed" }] } }), null);
  assert.equal(recordedShaOf({}), null);
  assert.equal(recordedShaOf(null), null);
});

test("the API's head wins over a run's recorded sha: the PR head is what the host merged", async (t) => {
  const box = sandbox(t);
  const { memberSha } = squashLand(t, box, "lib/a.js", "export const a = 2;\n");
  const task = landedTask(box.work, { pipelineRun: { assembly: { commit: "b".repeat(40) } }, row: { pr: { number: 7, state: "MERGED" } } });
  const evidence = await readMemberEvidence({ task, readPr: prRead("MERGED", memberSha), mainRef: "origin/main" });
  assert.equal(evidence.sha, memberSha);
  assert.equal(evidence.landing.state, "landed");
});

test("one pull request by number, across the index's groups; a number it does not hold is null", () => {
  const index = {
    byRef: new Map([
      ["feature/a", [{ number: 3, state: "MERGED", headRefOid: "a".repeat(40) }]],
      ["feature/b", [{ number: 9, state: "OPEN" }, { number: 3, state: "OPEN" }]],
    ]),
  };
  assert.equal(prByNumber(index, 9).state, "OPEN");
  assert.equal(prByNumber(index, 3).state, "MERGED", "a number is unique, so the first record carrying it is the record");
  assert.equal(prByNumber(index, 77), null);
  assert.equal(prByNumber(index, null), null);
  assert.equal(prByNumber(null, 3), null);
});

test("collectWaveEvidence keys every wave member, skips a task in no wave, and keeps a failed read as cannot tell", async (t) => {
  const box = sandbox(t);
  const { memberSha } = squashLand(t, box, "lib/a.js", "export const a = 2;\n");
  const one = landedTask(box.work, { id: 4, row: { pr: { number: 7, state: "MERGED" } } });
  const two = landedTask(box.work, { id: 5, row: { pr: { number: 8, state: "MERGED" } }, state: "running" });
  const loose = landedTask(box.work, { id: 6, waveId: null, row: { pr: { number: 9, state: "MERGED" } } });
  const map = await collectWaveEvidence({
    tasks: [one, two, loose],
    readPr: prRead("MERGED", memberSha),
    mainRef: "origin/main",
  });
  assert.deepEqual([...map.keys()].sort(), [waveMemberKey(one), waveMemberKey(two)].sort());
  assert.equal(map.has(waveMemberKey(loose)), false, "a task in no wave has no gate to feed");
  assert.equal(map.get(waveMemberKey(one)).landing.state, "landed");
});

test("the route: an OPEN PR blocks, no PR is cannot tell, and a throwing evidence read is never met", async (t) => {
  const box = sandbox(t);
  const { memberSha } = squashLand(t, box, "lib/a.js", "export const a = 2;\n");
  const wavesFile = path.join(box.dir, "waves.json");
  writeFileSync(
    wavesFile,
    `${JSON.stringify({
      version: 1,
      byInitiative: {
        init_a: [{ id: "wave_01", initiativeId: "init_a", position: 1, title: "Wave 1", entryGate: null, exitGate: { check: "pr-merged" }, template: null, auto: false }],
      },
    })}\n`,
    "utf8",
  );
  const waves = new Waves({ file: wavesFile, log: () => {} });
  waves.load();
  assert.equal(waves.statusOf().readable, true);
  const task = landedTask(box.work, { row: { pr: { number: 7, state: "MERGED" } } });
  const assistant = { assistants: [{ id: "a1" }], queueView: () => ({ tasks: [task] }) };
  const read = async (waveEvidence) => {
    const captured = [];
    const handler = createWavesRoutes({ waves, assistant, store: null, sendJson: (res, code, body) => captured.push({ code, body }), waveEvidence });
    const url = new URL(`http://127.0.0.1${WAVES_PATH}?initiative=init_a`);
    const answered = await handler({ method: "GET", url: url.toString() }, {}, WAVES_PATH, url);
    assert.equal(answered, true);
    assert.equal(answered, true);
    assert.equal(captured.length, 1);
    return captured[0];
  };

  // The evidence the server would build for a landed member: real landing read, stubbed API.
  const evidence = await readMemberEvidence({ task, readPr: prRead("MERGED", memberSha), mainRef: "origin/main" });
  const closed = await read(async () => new Map([[waveMemberKey(task), evidence]]));
  assert.equal(closed.code, 200);
  assert.equal(closed.body.waves[0].state, "done");

  const open = await read(async () => new Map([[waveMemberKey(task), { ...evidence, pr: { ...evidence.pr, state: "OPEN" } }]]));
  assert.equal(open.body.waves[0].gates.exit.state, "unmet");
  assert.notEqual(open.body.waves[0].state, "done", "an OPEN pull request blocks the wave");

  const none = await read(async () => new Map());
  assert.equal(none.body.waves[0].gates.exit.state, "unknown");
  assert.notEqual(none.body.waves[0].state, "done");

  const thrown = await read(async () => {
    throw new Error("the host is down");
  });
  assert.equal(thrown.body.waves[0].gates.exit.state, "unknown");
  assert.notEqual(thrown.body.waves[0].state, "done");

  const noReader = await read(null);
  assert.equal(noReader.body.waves[0].gates.exit.state, "unknown");
  assert.notEqual(noReader.body.waves[0].state, "done");
});
