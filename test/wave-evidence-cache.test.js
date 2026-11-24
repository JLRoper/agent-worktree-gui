// THE EVIDENCE CACHES: A WARM ANSWER COSTS NO GIT SPAWN, AND A MOVED FACT RE-READS IT.
//
// The rule the caches implement is written in lib/wave-evidence.js: a landing answer is keyed on (clone, sha, ref) and
// validated against the ref's TIP; a path answer is keyed on the tree plus the file's stamp while the tree exists, and
// on (clone, ref, path) plus the tip once it is gone. This file proves each clause against a real repository, with a
// git reader that COUNTS its spawns:
//
//   1. the same sha against the same tip answers from the cache - one tip read, no member read;
//   2. a moved sha and a moved main are both MISSES, and the moved main flips the verdict;
//   3. a path in a tree is re-read when its stamp changes, and a path read out of main is re-read when main moves;
//   4. blindness (`unknown`) is never cached, so a git that comes back is noticed at once;
//   5. the fan-out is in parallel under one budget, and a spent budget answers cannot tell rather than hanging.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { gitIn } from "../lib/scan.js";
import { clearEvidenceCaches, collectWaveEvidence, readLanding, readMemberPath, refTipOnDisk } from "../lib/wave-evidence.js";
import { waveMemberKey } from "../lib/waves.js";

process.env.GIT_TERMINAL_PROMPT = "0";
process.env.GCM_INTERACTIVE = "never";

const EMAIL = ["wave", "example.invalid"].join(String.fromCharCode(64));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const run = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_AUTHOR_NAME: "Wave Test",
      GIT_AUTHOR_EMAIL: EMAIL,
      GIT_COMMITTER_NAME: "Wave Test",
      GIT_COMMITTER_EMAIL: EMAIL,
    },
  }).trim();

// A bare origin and a clone whose main is one commit.
function sandbox(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-wave-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origin = path.join(dir, "origin.git");
  const work = path.join(dir, "work");
  mkdirSync(work);
  run(dir, "init", "--bare", "-q", "-b", "main", origin);
  run(dir, "clone", "-q", origin, work);
  mkdirSync(path.join(work, "lib"), { recursive: true });
  writeFileSync(path.join(work, "lib", "a.js"), "export const a = 1;\n");
  writeFileSync(path.join(work, "artefact.md"), "the artefact\n");
  run(work, "add", "-A");
  run(work, "commit", "-q", "-m", "base");
  run(work, "push", "-q", "-u", "origin", "main");
  return { dir, origin, work };
}

// A member branch, then main moved by a SQUASH of that branch: main holds the member's content under a new sha.
function memberAndSquash({ work }, file = "lib/a.js", content = "export const a = 2;\n") {
  run(work, "checkout", "-q", "-b", "feature/member", "origin/main");
  writeFileSync(path.join(work, file), content);
  run(work, "add", "-A");
  run(work, "commit", "-q", "-m", "member change");
  const memberSha = run(work, "rev-parse", "HEAD");
  run(work, "checkout", "-q", "main");
  return memberSha;
}

function squashOntoMain({ work }, message = "land the member") {
  run(work, "merge", "--squash", "-q", "feature/member");
  run(work, "commit", "-q", "-m", message);
  run(work, "push", "-q", "origin", "main");
  run(work, "fetch", "-q", "origin");
  return run(work, "rev-parse", "HEAD");
}

const counter = () => ({ n: 0 });
const counted = (tally) => async (cwd, args, timeout) => {
  tally.n += 1;
  return gitIn(cwd, args, timeout);
};

test("the same sha against the same tip answers from the cache: one tip read, no member read", async (t) => {
  clearEvidenceCaches();
  const box = sandbox(t);
  const memberSha = memberAndSquash(box);
  const tally = counter();
  const git = counted(tally);

  const first = await readLanding({ git, cwd: box.work, sha: memberSha, mainRef: "origin/main" });
  assert.equal(first.state, "not-landed");
  assert.ok(tally.n >= 5, `a cold landing read spawns its git calls (measured ${tally.n})`);

  const cold = tally.n;
  const second = await readLanding({ git, cwd: box.work, sha: memberSha, mainRef: "origin/main" });
  assert.equal(second.state, "not-landed");
  assert.equal(second.cached, true, "the second read is a cache hit");
  assert.equal(tally.n - cold, 0, `a warm read spawns NO git at all: the tip comes from the ref files (measured ${tally.n - cold})`);
  assert.equal(second.mainSha, first.mainSha);
  assert.equal(second.why, first.why, "the cached answer is the answer the read gave");
});

test("a sha that moves is a different entry, and a main that moves re-reads and can flip the verdict", async (t) => {
  clearEvidenceCaches();
  const box = sandbox(t);
  const memberSha = memberAndSquash(box);
  const tally = counter();
  const git = counted(tally);

  const before = await readLanding({ git, cwd: box.work, sha: memberSha, mainRef: "origin/main" });
  assert.equal(before.state, "not-landed");

  // A second member with a different content is a different key: it must not be answered from the first entry.
  run(box.work, "checkout", "-q", "-b", "feature/other", "origin/main");
  writeFileSync(path.join(box.work, "lib", "a.js"), "export const a = 99;\n");
  run(box.work, "commit", "-qam", "other");
  const otherSha = run(box.work, "rev-parse", "HEAD");
  run(box.work, "checkout", "-q", "main");
  assert.notEqual(otherSha, memberSha);

  const cold = tally.n;
  const readOther = await readLanding({ git, cwd: box.work, sha: otherSha, mainRef: "origin/main" });
  assert.equal(readOther.cached, undefined, "a new sha is a miss");
  assert.equal(readOther.state, "not-landed");
  assert.ok(tally.n - cold > 1, `a new sha is measured, not answered from cache (spawned ${tally.n - cold})`);

  // The member's branch lands by SQUASH, which moves origin/main under the same member sha.
  squashOntoMain(box);
  const landed = await readLanding({ git, cwd: box.work, sha: memberSha, mainRef: "origin/main" });
  assert.equal(landed.cached, undefined, "the moved tip is a miss even for a sha already measured");
  assert.equal(landed.state, "landed", "the verdict flipped because main moved, not because the sha did");

  // The other member's content did not land, so it is re-read against the new tip - and then cached against it.
  const otherAfter = await readLanding({ git, cwd: box.work, sha: otherSha, mainRef: "origin/main" });
  assert.equal(otherAfter.cached, undefined, "the moved tip re-reads every member, not just the landed one");
  assert.equal(otherAfter.state, "not-landed");
  const otherWarm = await readLanding({ git, cwd: box.work, sha: otherSha, mainRef: "origin/main" });
  assert.equal(otherWarm.cached, true, "an unmoved sha against an unmoved tip answers from cache");
  assert.equal(otherWarm.state, "not-landed");
});

test("a path in a tree is re-read when its stamp changes, and a cached path answer never disagrees with the file", async (t) => {
  clearEvidenceCaches();
  const box = sandbox(t);
  const tree = path.join(box.dir, "member-tree");
  mkdirSync(tree);
  writeFileSync(path.join(tree, "artefact.md"), "the member's artefact\n");
  const tally = counter();
  const git = counted(tally);

  const first = await readMemberPath({ tree, rel: "artefact.md", cwd: box.work, git, mainRef: "origin/main" });
  assert.equal(first.state, "present");
  assert.equal(first.where, "tree");
  const cold = tally.n;
  const second = await readMemberPath({ tree, rel: "artefact.md", cwd: box.work, git, mainRef: "origin/main" });
  assert.equal(second.cached, true, "the tree half is a cache hit when the stamp is unchanged");
  assert.equal(second.state, "present");
  assert.equal(tally.n - cold, 0, "the tree half reads no git at all");

  // Touch the file: same path, new stamp, so the answer is read again rather than served.
  const later = new Date(Date.now() + 5_000);
  utimesSync(path.join(tree, "artefact.md"), later, later);
  const touched = await readMemberPath({ tree, rel: "artefact.md", cwd: box.work, git, mainRef: "origin/main" });
  assert.equal(touched.cached, undefined, "a changed stamp is a miss");
  assert.equal(touched.state, "present");

  // Delete it: the stamp is gone, and the answer must follow the file, not the old entry.
  rmSync(path.join(tree, "artefact.md"));
  const gone = await readMemberPath({ tree, rel: "artefact.md", cwd: box.work, git, mainRef: "origin/main" });
  assert.equal(gone.state, "absent", "a deleted artefact is absent, never the cached present");
});

test("a path read out of main is re-read when main moves, and cached while it does not", async (t) => {
  clearEvidenceCaches();
  const box = sandbox(t);
  // The member's tree is gone: the read moves to main's history.
  const tally = counter();
  const git = counted(tally);

  const first = await readMemberPath({ tree: null, rel: "artefact.md", cwd: box.work, git, mainRef: "origin/main" });
  assert.equal(first.state, "present");
  assert.equal(first.where, "landing");
  const cold = tally.n;
  const second = await readMemberPath({ tree: null, rel: "artefact.md", cwd: box.work, git, mainRef: "origin/main" });
  assert.equal(second.cached, true);
  assert.equal(tally.n - cold, 0, `a warm path read spawns no git at all (measured ${tally.n - cold})`);

  // Remove the artefact from main: the tip moves, so the entry dies and the answer follows.
  run(box.work, "rm", "-q", "artefact.md");
  run(box.work, "commit", "-q", "-m", "remove the artefact");
  run(box.work, "push", "-q", "origin", "main");
  run(box.work, "fetch", "-q", "origin");
  const gone = await readMemberPath({ tree: null, rel: "artefact.md", cwd: box.work, git, mainRef: "origin/main" });
  assert.equal(gone.cached, undefined, "the moved tip is a miss");
  assert.equal(gone.state, "absent");
});

test("blindness is never cached: an unknown answer is re-read on every call", async (t) => {
  clearEvidenceCaches();
  const box = sandbox(t);
  const tally = counter();
  const git = counted(tally);
  const missing = "f".repeat(40);
  const first = await readLanding({ git, cwd: box.work, sha: missing, mainRef: "origin/main" });
  assert.equal(first.state, "unknown");
  const cold = tally.n;
  const second = await readLanding({ git, cwd: box.work, sha: missing, mainRef: "origin/main" });
  assert.equal(second.state, "unknown");
  assert.equal(second.cached, undefined, "an unknown answer is never served from cache");
  assert.ok(tally.n - cold >= 1, `the blind read asks git again rather than answering from cache (measured ${tally.n - cold})`);
});

test("a member whose recorded sha IS main's tip is landed by identity, and cached", async (t) => {
  clearEvidenceCaches();
  const box = sandbox(t);
  const mainSha = run(box.work, "rev-parse", "origin/main");
  const tally = counter();
  const git = counted(tally);
  const first = await readLanding({ git, cwd: box.work, sha: mainSha, mainRef: "origin/main" });
  assert.equal(first.state, "landed", "a commit that is the tip has nothing left to land");
  assert.match(first.why, /IS the recorded sha/);
  const cold = tally.n;
  const second = await readLanding({ git, cwd: box.work, sha: mainSha, mainRef: "origin/main" });
  assert.equal(second.cached, true);
  assert.equal(tally.n - cold, 0, "and it is cached like any other answer, with no spawn");
});

test("the ref tip read from the ref files is the sha git answers: loose, packed, a worktree, and nothing when blind", async (t) => {
  const box = sandbox(t);
  const wanted = run(box.work, "rev-parse", "origin/main");
  assert.equal(refTipOnDisk(box.work, "origin/main"), wanted, "a loose remote-tracking ref reads straight out of its file");

  // A worktree's .git is a file, and its refs live in the common dir.
  const wt = path.join(box.dir, "wt");
  run(box.work, "worktree", "add", "-q", "-b", "feature/wt", wt);
  assert.equal(refTipOnDisk(wt, "origin/main"), wanted, "a worktree resolves through gitdir and commondir to the same ref");

  // Packed refs: the loose file is gone and the value lives in packed-refs.
  run(box.work, "pack-refs", "--all", "--prune");
  assert.equal(refTipOnDisk(box.work, "origin/main"), wanted, "a packed ref reads out of packed-refs");
  assert.equal(refTipOnDisk(box.work, "origin/main"), run(box.work, "rev-parse", "origin/main"), "and still agrees with git");

  assert.equal(refTipOnDisk(box.work, "origin/no-such-branch"), null, "an absent ref answers nothing, so git is asked");
  assert.equal(refTipOnDisk(path.join(box.dir, "not-a-repo"), "origin/main"), null, "a directory that is not a repo answers nothing");
});

test("members read in parallel: more than one member's git call is in flight at once", async (t) => {
  clearEvidenceCaches();
  const box = sandbox(t);
  const inflight = { now: 0, max: 0 };
  const git = async () => {
    inflight.now += 1;
    inflight.max = Math.max(inflight.max, inflight.now);
    await sleep(40);
    inflight.now -= 1;
    return { ok: true, out: "" };
  };
  const tasks = Array.from({ length: 6 }, (_, i) => ({
    id: 100 + i,
    title: `member ${i}`,
    state: "done",
    project: null,
    // A distinct tree per member, so each has its own ref-tip read and its own cache key.
    worktree: path.join(box.dir, `tree-${i}`),
    waveId: "wave_perf",
    pipelineRun: { assembly: { commit: "a".repeat(40) } },
  }));
  for (const task of tasks) mkdirSync(task.worktree);
  const map = await collectWaveEvidence({ tasks, git, mainRef: "origin/main", concurrency: 6, budgetMs: 5000 });
  assert.equal(map.size, 6);
  assert.ok(inflight.max >= 2, `members overlapped (max in flight ${inflight.max})`);
  assert.ok(map.get(waveMemberKey(tasks[0])).budgetExhausted === undefined);
});

test("a spent budget answers cannot tell instead of hanging, and nothing past it is started", async (t) => {
  clearEvidenceCaches();
  const box = sandbox(t);
  let spawned = 0;
  const git = async () => {
    spawned += 1;
    await sleep(400);
    return { ok: true, out: "" };
  };
  const tasks = Array.from({ length: 5 }, (_, i) => ({
    id: 200 + i,
    title: `member ${i}`,
    state: "running",
    project: null,
    worktree: path.join(box.dir, `slow-${i}`),
    waveId: "wave_slow",
    pipelineRun: { assembly: { commit: "b".repeat(40) } },
  }));
  for (const task of tasks) mkdirSync(task.worktree);
  const started = Date.now();
  const map = await collectWaveEvidence({ tasks, git, mainRef: "origin/main", concurrency: 1, budgetMs: 150 });
  const elapsed = Date.now() - started;
  assert.equal(map.size, 5, "every member is still answered, so the fold cannot lose one");
  assert.ok(elapsed < 2000, `the read returned inside a small multiple of its budget (measured ${elapsed}ms)`);
  const answers = [...map.values()];
  assert.ok(answers.some((a) => a.budgetExhausted === true), "at least one member is told the budget was spent");
  assert.ok(answers.every((a) => a.landing === null && a.pr === null), "a skipped member has no half-read evidence");
  assert.match(answers.find((a) => a.budgetExhausted).why, /budget/);
  assert.ok(spawned <= 2, `nothing past the budget is started (measured ${spawned} git spawns)`);
});
