#!/usr/bin/env node
// A WAVE THAT CLOSES ON AN ARTEFACT, THROUGH THE REAL API, AND STAYS CLOSED.
//
// HARNESS: LIVE GATE (a real panel process; the sandbox only - no browser)
//
//   node tools/verify-wave-file-exists.mjs
//
// WHAT THIS GATE PROVES, and why each step is a measurement rather than a look:
//
//   1. A ROW AND A WAVE, THROUGH THE API. The throwaway task is filed by POST /api/assistant/queue with a `waveId`, is
//      the only member of a wave created by POST /api/waves whose exit gate is `file-exists` on a file that is already
//      on the local-only repo's main, and GET /api/waves reads the wave back as DONE with the gate MET, in the member's
//      own tree. GET /api/initiatives carries the identical lane, so the card cannot draw a different state.
//   2. IT STAYS CLOSED WHEN THE TREE GOES. The member's worktree is removed - the cleanup a landed wave goes through -
//      and the tree drops off the board; the same GET reads DONE again, and the gate's sentence names the commit on
//      main that holds the path, so the close is a landing read and not a stale tree stat.
//   3. A FILE ONLY ON AN UNMERGED BRANCH IS NEVER MET. A second wave names a path committed on a branch that was never
//      merged; it reads not met, and the wave never reads done.
//   4. THE STORE IS PUT BACK. Both waves are removed through POST /api/waves/remove, the row is closed through the
//      queue's own state door, and the wave store reads as an empty map with the initiative store byte-identical to
//      the snapshot taken before the first write.
//
// Sandbox only: its own config, port and state directory, an apiServer pointed at a dead port, and one throwaway
// local-only repo. The live panel on 7331 and ~/.wag are never touched.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { git, post, startPanel, waitForState } from "./panel-testkit.mjs";

const WATCHDOG_MS = Number(process.env.PANEL_VERIFY_WATCHDOG_MS || 300_000);
const watchdog = setTimeout(() => {
  try {
    process.stderr.write(`WATCHDOG: ${WATCHDOG_MS}ms elapsed without the run finishing.\n`);
  } catch {
    /* nothing left to do */
  }
  process.exit(1);
}, WATCHDOG_MS);

let failures = 0;
let checks = 0;
const check = (name, got, want) => {
  checks += 1;
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` - ${extra}` : ""}`);
  }
};
const note = (s) => console.log(`      ${s}`);
const slash = (p) => String(p || "").replace(/\\/g, "/").toLowerCase();
const bytes = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

// ---- the sandbox: a LOCAL-ONLY project (no remote, no origin/main) -------------------------------------------------
const sandbox = mkdtempSync(path.join(tmpdir(), "wag-wave-file-exists-"));
const repos = path.join(sandbox, "repos");
const wavesFile = path.join(sandbox, "logs", "waves.json");
const initiativesFile = path.join(sandbox, "logs", "initiatives.json");
const ARTEFACT = "docs/artefact.md";
const UNMERGED = "docs/branch-only.md";
mkdirSync(repos, { recursive: true });
const projectDir = path.join(repos, "artefact-gate");
const projectName = "artefact-gate";
mkdirSync(path.join(projectDir, "docs"), { recursive: true });
git(projectDir, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(projectDir, "docs", "artefact.md"), "# the artefact\n");
writeFileSync(path.join(projectDir, "README.md"), "# artefact-gate\n");
git(projectDir, ["add", "-A"]);
git(projectDir, ["commit", "-q", "-m", "the base, with the artefact"]);
// A file that exists only on a branch nobody merged: the refusal has to be proved on a real branch, not a stub.
git(projectDir, ["checkout", "-q", "-b", "feature/unmerged", "main"]);
writeFileSync(path.join(projectDir, "docs", "branch-only.md"), "# only on the branch\n");
git(projectDir, ["add", "-A"]);
git(projectDir, ["commit", "-q", "-m", "a file that never merged"]);
git(projectDir, ["checkout", "-q", "main"]);
const tree = path.join(projectDir, ".worktrees", "member");
git(projectDir, ["worktree", "add", "-q", "-b", "member", tree]);
const mainSha = git(projectDir, ["rev-parse", "main"]).trim();
const landingSha = git(projectDir, ["log", "-1", "--format=%H", "main", "--", ARTEFACT]).trim();

const panel = await startPanel({
  dir: sandbox,
  config: {
    refreshSeconds: 4,
    worktreeSeconds: 4,
    midSeconds: 3600,
    dormantSeconds: 3600,
    slowSeconds: 3600,
    fetchSeconds: 3600,
    scanMode: "all",
    apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
    wavesFile,
    initiativesFile,
  },
});
const base = panel.base;
const GET = async (p) => {
  const r = await fetch(`${base}${p}`);
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const laneOf = (read, id) => (read.json?.waves || []).find((w) => w.id === id) || null;

try {
  console.log(`sandbox: ${base}`);
  console.log(`panel pid: ${panel.pid}`);
  await waitForState(
    base,
    (s) => s.projects.flatMap((p) => (p.worktrees || []).map((w) => slash(w.path))).includes(slash(tree)),
    "the member's worktree is on the board",
    { timeout: 120_000 },
  );

  // ---- seed: the tier, the initiative, and the store's starting bytes ------------------------------------------------
  console.log("\n== seed ==");
  check("the initiative tier is set to none, so nothing asks", (await post(base, "/api/settings/initiative-tier", { body: { tier: "none" } })).status, 200);
  const made = await post(base, "/api/initiatives", { body: { title: "A throwaway artefact wave", description: "The file-exists gate's own initiative - removed with the sandbox." } });
  check("the throwaway initiative is created", made.status, 201);
  const initiativeId = made.json?.initiative?.id;
  ok("the initiative has an id", Boolean(initiativeId), String(initiativeId || ""));
  const initiativesBefore = bytes(initiativesFile);
  ok("the initiative store is on disk", initiativesBefore.length > 0, `${initiativesBefore.length} bytes`);
  const beforeWaves = await GET(`/api/waves?initiative=${initiativeId}`);
  check("it starts with no waves", beforeWaves.json?.waves?.length, 0);

  const state = await GET("/api/state");
  const assistant = state.json?.assistant?.assistants?.[0];
  ok("the panel seeds an assistant", Boolean(assistant?.id), String(assistant?.id || ""));

  // ---- 1. The wave, then a row that names it, through the API -------------------------------------------------------
  console.log("\n== 1. An exit gate on an artefact already on main, and a row that names the wave ==");
  const created = await post(base, "/api/waves", { body: { initiativeId, title: "Close on the artefact", exitGate: { check: "file-exists", path: ARTEFACT } } });
  check("the wave is created", created.status, 200);
  const waveId = created.json?.wave?.id;
  ok("the wave has an id", Boolean(waveId), String(waveId || ""));
  check("its exit gate is stored as the name and the path", created.json?.wave?.exitGate, { check: "file-exists", path: ARTEFACT });

  const filed = await post(base, "/api/assistant/queue", {
    body: { assistantId: assistant.id, action: "add", title: "Close on the artefact", project: projectName, worktree: tree, waveId },
  });
  check("the throwaway row is filed", filed.status, 200);
  check("and it is filed with the wave id, which is the only membership there is", filed.json?.task?.waveId, waveId);
  const taskId = filed.json?.task?.id;
  ok("the row has an id", Boolean(taskId), String(taskId || ""));

  const read1 = await GET(`/api/waves?initiative=${initiativeId}`);
  const wave1 = laneOf(read1, waveId);
  ok("the wave is read back with its one member", wave1?.members?.length === 1, JSON.stringify(wave1?.members?.map((m) => m.id)));
  check("the exit gate reads met", wave1?.gates?.exit?.state, "met");
  ok("and its sentence is the tree's own read", String(wave1?.gates?.exit?.why || "").includes(ARTEFACT) && String(wave1?.gates?.exit?.why || "").includes("tree"), String(wave1?.gates?.exit?.why || ""));
  check("the wave reads done", wave1?.state, "done");

  const tab1 = await GET("/api/initiatives");
  const card1 = (tab1.json?.initiatives || []).find((row) => row.id === initiativeId);
  const lane1 = (card1?.waves || []).find((w) => w.id === waveId);
  check("the tab's own read agrees: done", lane1?.state, "done");
  check("and its gate agrees: met", lane1?.gates?.exit?.state, "met");
  const stored1 = JSON.parse(bytes(wavesFile) || "{}");
  ok("no wave state is written to the store", !JSON.stringify(stored1).includes('"state"'), JSON.stringify(Object.keys(stored1)));
  ok("the store is version 2", stored1.version === 2, String(stored1.version));

  // ---- 2. The tree goes: it stays closed, from the landing commit ----------------------------------------------------
  console.log("\n== 2. Remove the member's tree (the cleanup), and read it again ==");
  git(projectDir, ["worktree", "remove", "--force", tree]);
  ok("the tree is gone from disk", bytes(path.join(tree, "docs", ARTEFACT)) === "", "the path is not readable");
  // The evidence read is memoised for 30 s per member (server.js WAVE_EVIDENCE_TTL_MS), which is a reader's repaint
  // budget rather than a wave's state: the fold re-runs on every read, and the read below is the one a reader sees
  // once the memo expires.
  note("waiting out the 30 s evidence memo, so the next read is a fresh one");
  await new Promise((r) => setTimeout(r, 31_000));
  const read2 = await GET(`/api/waves?initiative=${initiativeId}`);
  const wave2 = laneOf(read2, waveId);
  check("the wave still reads done", wave2?.state, "done");
  check("the exit gate still reads met", wave2?.gates?.exit?.state, "met");
  const why2 = String(wave2?.gates?.exit?.why || "");
  ok("the read moved off the tree", !why2.includes("the tree at"), why2);
  ok("and it is a landing read that names a commit on main", /on main at \w{7}/.test(why2) && why2.includes(landingSha.slice(0, 7)), why2);
  ok("the ref it names is the local main it fell back to", why2.includes(" main "), why2);
  note(`main head ${mainSha}, the artefact's landing commit ${landingSha}`);

  // A member the board has never seen - no board row at all - closes the same way: the artefact's fact is the read,
  // not the row. This is the class the check exists for: a task whose tree is gone before the wave is ever read.
  console.log("\n== 2b. A member with no board row, in the same wave ==");
  const goneTree = path.join(projectDir, ".worktrees", "never-scanned");
  const filedGone = await post(base, "/api/assistant/queue", {
    body: { assistantId: assistant.id, action: "add", title: "A tree the board never saw", project: projectName, worktree: goneTree, waveId },
  });
  check("the second row is filed", filedGone.status, 200);
  const goneTaskId = filedGone.json?.task?.id;
  const row2 = (await GET("/api/state")).json?.projects?.flatMap((p) => p.worktrees || []).find((w) => slash(w.path) === slash(goneTree));
  ok("the board holds no row for it", !row2, JSON.stringify(row2 || null));
  const read2b = await GET(`/api/waves?initiative=${initiativeId}`);
  const wave2b = laneOf(read2b, waveId);
  check("the wave is still done", wave2b?.state, "done");
  check("its gate is still met", wave2b?.gates?.exit?.state, "met");
  check("and the wave counts both members", wave2b?.members?.length, 2);
  const why2b = String(wave2b?.gates?.exit?.why || "");
  ok("both members' reads are named", why2b.includes(`#${taskId}`) && why2b.includes(`#${goneTaskId}`), why2b);

  // ---- 3. A file only on an unmerged branch is never met -------------------------------------------------------------
  console.log("\n== 3. A path that exists only on an unmerged branch ==");
  const unmergedWave = await post(base, "/api/waves", { body: { initiativeId, title: "Never met from a branch", exitGate: { check: "file-exists", path: UNMERGED } } });
  check("the second wave is created", unmergedWave.status, 200);
  const branchWaveId = unmergedWave.json?.wave?.id;
  // A member of its own, or the gate would have nothing to read: the member's tree is gone, so this is a landing read
  // on main, and main never held the branch's file.
  const filedBranch = await post(base, "/api/assistant/queue", {
    body: { assistantId: assistant.id, action: "add", title: "A path only on a branch", project: projectName, worktree: goneTree, waveId: branchWaveId },
  });
  check("its member is filed", filedBranch.status, 200);
  const branchTaskId = filedBranch.json?.task?.id;
  const read3 = await GET(`/api/waves?initiative=${initiativeId}`);
  const wave3 = laneOf(read3, branchWaveId);
  check("its exit gate reads not met", wave3?.gates?.exit?.state, "unmet");
  ok("and the sentence says the landing does not hold it", /does not hold it/.test(String(wave3?.gates?.exit?.why || "")), String(wave3?.gates?.exit?.why || ""));
  ok("so the wave never reads done", wave3?.state !== "done", String(wave3?.state));
  const stillDone = laneOf(read3, waveId);
  check("the first wave is untouched by the second", stillDone?.state, "done");

  // ---- 4. Put the store back ----------------------------------------------------------------------------------------
  console.log("\n== 4. Remove both waves and close the rows ==");
  for (const [id, members] of [[branchWaveId, 1], [waveId, 2]]) {
    const removed = await post(base, "/api/waves/remove", { body: { initiativeId, id, by: "assistant-2" } });
    check(`the wave ${id} is removed`, removed.status, 200);
    check(`and its answer names the ${members} member(s) it detached`, removed.json?.members, members);
  }
  for (const id of [taskId, goneTaskId, branchTaskId]) {
    const closed = await post(base, "/api/assistant/queue", { body: { assistantId: assistant.id, action: "state", id, state: "done" } });
    check(`the throwaway row ${id} is closed`, closed.status, 200);
    check(`and row ${id} reads done`, closed.json?.task?.state, "done");
  }
  const empty = await GET(`/api/waves?initiative=${initiativeId}`);
  check("the initiative reads no waves again", empty.json?.waves?.length, 0);
  check("the store is an empty map", JSON.stringify(JSON.parse(bytes(wavesFile)).byInitiative), "{}");
  ok("the initiative store is byte-identical to the snapshot", bytes(initiativesFile) === initiativesBefore);
  const tab2 = await GET("/api/initiatives");
  const card2 = (tab2.json?.initiatives || []).find((row) => row.id === initiativeId);
  check("the tab's read agrees: no waves", card2?.waves?.length, 0);
} finally {
  await panel.stop().catch(() => {});
  rmSync(sandbox, { recursive: true, force: true });
  clearTimeout(watchdog);
}

console.log(`\n${failures ? "FAILED" : "OK"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
