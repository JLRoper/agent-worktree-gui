// A full node restart must not lose a round's GROUPING, the way it never lost its NAMES.
//
// The reader's finding: after the panel process stopped and was started again, the worktrees a round cut still painted
// the round's names, but they were no longer grouped under the round's parent tree. The two halves came from different
// stores. The NAME is read from the queue task at snapshot time (lib/round-tree-names.js -> `row.round.display`), which
// is a file under `logs/assistants/<id>/queue.json`, so it is there the moment the process is. The GROUPING was only
// ever `row.parent`, a field a SCAN writes from `parents.json` (lib/scan.js `parentFor`), so a row discovered at boot
// carries no edge until its own scan lands, and a stage tree the parent book never recorded carries none at all.
//
// The fix moves the grouping onto the same record as the name and the same read. This test boots the real panel twice
// over one sandbox that has a queue task naming a round and NO parents.json at all: both boots must paint the name AND
// the grouping, or the grouping is still living on the scan.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { startPanel, git, configureRepo } from "../tools/panel-testkit.mjs";

const ROUND_PARENT = "wtgui/round-a-052254";
const ROUND_STAGE = "wtgui/round-a-stage-1-probe-6632b6";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The rows the chart would draw, once both trees are on the board. The panel discovers them from the repo, so this
// waits for the scan rather than writing rows into a store by hand - a restart test that seeds rows would prove
// nothing about a restart.
async function roundRows(panel, dir) {
  const base = `http://127.0.0.1:${panel.port}`;
  for (let i = 0; i < 240; i += 1) {
    const snap = await (await fetch(`${base}/api/state`)).json();
    const project = (snap.projects || []).find((p) => p.name === "demo");
    const rows = (project && project.worktrees) || [];
    const parent = rows.find((r) => r.branch === ROUND_PARENT);
    const stage = rows.find((r) => r.branch === ROUND_STAGE);
    if (parent && stage) return { parent, stage };
    await sleep(250);
  }
  assert.fail(`the two round trees never reached the board (sandbox ${dir})`);
}

test("a round's grouping and its names both survive a full panel restart, from the queue record alone", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "wag-round-restart-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repos = path.join(dir, "repos");
  const repo = path.join(repos, "demo");
  await mkdir(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  configureRepo(repo);
  await writeFile(path.join(repo, "README.md"), "# demo\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "first");
  const sha = git(repo, "rev-parse", "main");
  const parentPath = path.join(repo, ".worktrees", "round-a-052254").replace(/\\/g, "/");
  const stagePath = path.join(repo, ".worktrees", "round-a-stage-1-probe-6632b6").replace(/\\/g, "/");
  git(repo, "worktree", "add", "-q", "-b", ROUND_PARENT, parentPath, sha);
  git(repo, "worktree", "add", "-q", "-b", ROUND_STAGE, stagePath, sha);

  // The record the cut wrote, exactly as `cutPipelineTree` writes it: the round names the parent tree and holds every
  // stage child under it. No parents.json: nothing but this file says where the trees belong.
  const queueDir = path.join(dir, "logs", "assistants", "assistant-1");
  await mkdir(queueDir, { recursive: true });
  await writeFile(
    path.join(queueDir, "queue.json"),
    JSON.stringify({
      version: 1,
      nextId: 9,
      tasks: [
        {
          id: 7,
          title: "Round A: the parent-tree note",
          state: "running",
          project: "demo",
          worktree: parentPath,
          pipelineRun: {
            pipeline: "local",
            stage: "probe",
            round: {
              parentPath,
              parent: ROUND_PARENT,
              slug: "round-a",
              tag: "052254",
              display: "Round A: the parent-tree note",
              sha,
              at: "2026-11-09T00:00:00.000Z",
              by: "panel",
            },
            trees: {
              probe: {
                path: stagePath,
                branch: ROUND_STAGE,
                parent: ROUND_PARENT,
                parentPath,
                position: 1,
                stageName: "probe",
                display: "Stage 1: probe",
                cutAt: "2026-11-09T00:00:00.000Z",
                by: "panel",
              },
            },
          },
        },
      ],
    }),
    "utf8",
  );
  assert.equal(existsSync(path.join(dir, "logs", "parents.json")), false, "the sandbox has no parent book to read");

  const config = {
    scanRoots: [repos],
    projects: [{ name: "demo", path: repo }],
    worktreeSeconds: 1,
    midSeconds: 1,
    dormantSeconds: 1,
    slowSeconds: 2,
    refreshSeconds: 60,
  };

  // Two processes, one state dir: the second is the reader's restart.
  for (const boot of [1, 2]) {
    const panel = await startPanel({ dir, config, reuseConfig: boot === 2, keep: true });
    try {
      const { parent, stage } = await roundRows(panel, dir);
      assert.equal(parent.round?.display, "Round A: the parent-tree note", `boot ${boot}: the parent tree's name`);
      assert.equal(parent.round?.role, "parent");
      assert.equal(parent.round?.parentPath, null, `boot ${boot}: the parent tree is a sibling, never a child`);
      assert.equal(stage.round?.display, "Stage 1: probe", `boot ${boot}: the stage tree's name`);
      assert.equal(stage.round?.role, "stage");
      assert.equal(stage.round?.position, 1);
      assert.equal(stage.round?.parentPath, parentPath, `boot ${boot}: the stage tree groups under the round's parent tree`);
    } finally {
      await panel.stop();
    }
  }
});
