#!/usr/bin/env node
// The container teardown proved against a REAL Docker daemon, end to end, with the evidence on stdout.
//
//   node tools/verify-container-teardown.mjs            # default image
//   WTGUI_TEST_IMAGE=<image> node tools/verify-container-teardown.mjs
//
// WHAT IT PROVES, in the order the row asks for them:
//
//   1. BRIEF     the paragraph a worker receives carries wag.worktree=<this tree> and wag.row, and the --rm rule;
//   2. SETTLE    a labelled container is stopped and removed by a real Jobs settle, and an unlabelled one that was
//                started beside it is STILL RUNNING afterwards;
//   3. REFUSAL   a queue row whose tree still runs a labelled container is refused with the sentence, and the row is
//                still not done;
//   4. KEEP      the same close, with a reason that names the container and says why, goes through;
//   5. ACTION    POST /api/containers/teardown on a booted panel removes the named tree's container, and the read
//                route shows it before the press and nothing after it.
//
// Everything it creates is named with this run's own stamp and labelled with a throwaway tree, and it REMOVES what it
// created at the end (including on failure). Nothing else on the daemon is touched: the teardown matches the label
// value, not a name prefix.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Jobs } from "../lib/jobs.js";
import { Assistant } from "../lib/assistant.js";
import { closeGate, containerBriefFor, labelTree, listLabelled, resetDaemonState, teardownTree } from "../lib/container-teardown.js";
import { startPanel } from "./panel-testkit.mjs";

const IMAGE = process.env.WTGUI_TEST_IMAGE || "node:24-bookworm-slim";
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const created = new Set();
const tempDirs = new Set();
let failed = 0;

const say = (line) => process.stdout.write(`${line}\n`);
const pass = (what, detail = "") => say(`PASS ${what}${detail ? `: ${detail}` : ""}`);
const fail = (what, error) => {
  failed += 1;
  say(`FAIL ${what}: ${error}`);
};
const docker = (...args) => {
  try {
    return { ok: true, out: execFileSync("docker", args, { encoding: "utf8", timeout: 30_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim() };
  } catch (e) {
    return { ok: false, error: String(e?.stderr || e?.message || e).trim() };
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gone = async (fn, { ms = 20_000 } = {}) => {
  const until = Date.now() + ms;
  for (;;) {
    if (fn()) return true;
    if (Date.now() > until) return false;
    await sleep(200);
  }
};
const name = (tag) => `wag-verify-${stamp}-${tag}`;
const tree = (tag) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), `wtgui-verify-${tag}-`));
  tempDirs.add(dir);
  return dir;
};
const start = (tag, treePath, { labelled = true, row = "269" } = {}) => {
  const n = name(tag);
  const args = ["run", "-d", "--rm", ...(labelled ? ["--label", `wag.worktree=${labelTree(treePath)}`, "--label", `wag.row=${row}`] : []), "--name", n, IMAGE, "sleep", "600"];
  const out = docker(...args);
  if (!out.ok) throw new Error(`could not start ${n}: ${out.error}`);
  created.add(out.out.trim());
  return { id: out.out.trim(), name: n };
};
const running = (id) => docker("inspect", "--format", "{{.State.Running}}", id).out === "true";
const exists = (id) => docker("inspect", "--format", "{{.Id}}", id).ok;
const stateOf = (id) => {
  const out = docker("inspect", "--format", "{{.State.Status}}", id);
  return out.ok ? out.out : "gone";
};

const cleanup = () => {
  for (const id of created) docker("rm", "-f", id);
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
    } catch {
      /* OS temp is throwaway */
    }
  }
};

const main = async () => {
  const version = docker("version", "--format", "{{.Server.Version}}");
  if (!version.ok) {
    say(`NOT RUN: no Docker daemon answers (${version.error})`);
    return 2;
  }
  if (!docker("image", "inspect", "--format", "{{.Id}}", IMAGE).ok) {
    say(`NOT RUN: the image ${IMAGE} is not present - set WTGUI_TEST_IMAGE to one this daemon has`);
    return 2;
  }
  say(`container teardown on Docker ${version.out}, image ${IMAGE}, stamp ${stamp}`);
  resetDaemonState();

  // ---- 1. BRIEF ---------------------------------------------------------------------------------------------
  const briefTree = tree("brief");
  try {
    const brief = containerBriefFor({ tree: briefTree, row: "269" });
    const value = labelTree(briefTree);
    assert.ok(brief.includes(`--label wag.worktree=${value} `), "the literal tree is in the label");
    assert.ok(brief.includes("--label wag.row=269"), "the row is in the second label");
    assert.ok(/docker run -d --rm/.test(brief), "--rm is stated");
    pass("brief", `wag.worktree=${value} and wag.row=269, with --rm`);
  } catch (e) {
    fail("brief", e.message);
  }

  // ---- 2. SETTLE --------------------------------------------------------------------------------------------
  const settleTree = tree("settle");
  const jobsDir = tree("jobs");
  let labelled = null;
  let control = null;
  try {
    labelled = start("settle", settleTree);
    control = start("control", settleTree, { labelled: false });
    say(`  started ${labelled.name} (labelled, ${labelTree(settleTree)}) and ${control.name} (unlabelled)`);
    assert.equal(exists(labelled.id), true, "the labelled container exists before the settle");
    assert.equal(running(control.id), true, "the control is running before the settle");
    const jobs = new Jobs({ config: { jobsFile: path.join(jobsDir, "jobs.json"), apiServer: { url: "http://127.0.0.1:9" } }, onLog: () => {} });
    const j = {
      id: `j-verify-${stamp}`,
      thread: `t-verify-${stamp}`,
      status: "running",
      startedAt: new Date().toISOString(),
      cwd: null,
      ownerPath: null,
      worktreePath: labelTree(settleTree),
      lines: [],
    };
    jobs.jobs.set(j.id, j);
    jobs.settle(j, "completed", { output: "done" });
    for (const timer of [jobs.titleSweep, jobs.approvalSweep, jobs.approvalReconcile]) clearInterval(timer);
    clearTimeout(jobs.persistTimer);
    const removed = await gone(() => !exists(labelled.id));
    assert.equal(removed, true, `${labelled.name} is gone after the settle`);
    assert.equal(running(control.id), true, `${control.name} is still running`);
    pass("settle", `${labelled.name} stopped and removed, ${control.name} untouched`);
  } catch (e) {
    fail("settle", e.message);
  }

  // ---- 3 + 4. THE CLOSE GATE --------------------------------------------------------------------------------
  const gateTree = tree("gate");
  const gateDir = tree("gate-store");
  let gateContainer = null;
  let assistant = null;
  try {
    gateContainer = start("gate", gateTree, { row: "269" });
    const assistantFile = path.join(gateDir, "assistant.json");
    assistant = new Assistant({
      config: { jobsFile: path.join(gateDir, "jobs.json"), assistantFile, defaultCwd: gateDir },
      jobs: { list: () => [], firstOfThread: () => null, create: async (body) => ({ id: "job-verify", ...body }) },
      getProjects: () => [],
      getRows: () => [],
      onLog: () => {},
    });
    const added = assistant.queueMutate("assistant-1", "add", { title: "verify the container gate", worktree: labelTree(gateTree) }, { by: "reader" });
    assert.equal(added.ok, true, added.error);
    const row = added.task;
    const refused = assistant.queueMutate("assistant-1", "state", { id: row.id, state: "done" }, { by: "reader" });
    assert.equal(refused.ok, false, "the close is refused");
    say(`  refusal: ${refused.error}`);
    assert.match(refused.error, new RegExp(`^#${row.id} cannot close while 1 labelled container still runs: ${gateContainer.name}`));
    assert.match(refused.error, /POST \/api\/containers\/teardown/);
    const after = assistant.queueView("assistant-1");
    const still = (after.tasks || []).find((r) => r.id === row.id);
    assert.equal(still?.state, "queued", "a refused close wrote nothing: the row is still queued");
    pass("refusal", `row #${row.id} still ${still?.state}`);
  } catch (e) {
    fail("refusal", e.message);
  }
  try {
    const assistantFile = path.join(gateDir, "assistant.json");
    const added = assistant.queueMutate("assistant-1", "add", { title: "verify the named reason", worktree: labelTree(gateTree) }, { by: "reader" });
    const row = added.task;
    const closed = assistant.queueMutate(
      "assistant-1",
      "state",
      { id: row.id, state: "done", reason: `keeping ${gateContainer.name} because the reader is still using its port` },
      { by: "reader" },
    );
    assert.equal(closed.ok, true, closed.error);
    assert.equal(closed.task.state, "done");
    pass("keep", `row #${row.id} closed with a reason that names ${gateContainer.name}`);
    const swept = await teardownTree(labelTree(gateTree), { log: () => {} });
    assert.equal(swept.ok, true, swept.error || "the gate tree's container was removed");
    assert.equal(await gone(() => !exists(gateContainer.id)), true, "the gate container is gone after the teardown");
    pass("sweep", `${gateContainer.name} stopped and removed by the module's own teardown`);
  } catch (e) {
    fail("keep", e.message);
  }
  if (assistant) for (const timer of [assistant.persistTimer, assistant.wakeTimer, assistant.timer, assistant.settleTimer]) clearTimeout(timer);

  // ---- 5. THE PANEL ACTION, over HTTP -----------------------------------------------------------------------
  const actionTree = tree("action");
  let action = null;
  let panel = null;
  try {
    action = start("action", actionTree, { row: "269" });
    panel = await startPanel({ config: { scanRoots: [actionTree] } });
    const read = await fetch(`${panel.base}/api/containers?tree=${encodeURIComponent(labelTree(actionTree))}`);
    assert.equal(read.status, 200, `the read answered ${read.status}`);
    const before = await read.json();
    assert.equal(before.containers.length, 1, "the read names the labelled container");
    assert.equal(before.containers[0].name, action.name);
    say(`  GET /api/containers?tree=<probe> -> ${before.containers.length} container: ${before.containers[0].name} (row ${before.containers[0].row})`);
    const post = await fetch(`${panel.base}/api/containers/teardown`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tree: labelTree(actionTree) }),
    });
    const answer = await post.json();
    assert.equal(post.status, 200, `the action answered ${post.status}: ${JSON.stringify(answer)}`);
    assert.equal(await gone(() => !exists(action.id)), true, `${action.name} is gone after the action`);
    const after = await (await fetch(`${panel.base}/api/containers?tree=${encodeURIComponent(labelTree(actionTree))}`)).json();
    assert.equal(after.containers.length, 0, "the read is empty after the press");
    say(`  POST /api/containers/teardown -> ${post.status} stopped ${answer.stopped.length}, removed ${answer.removed.length}, left ${answer.left.length}`);
    pass("action", `POST /api/containers/teardown removed ${action.name}, and the read is empty`);
  } catch (e) {
    fail("action", e.message);
  } finally {
    if (panel) await panel.stop().catch(() => {});
  }

  // The module's own answer, read off the daemon rather than assumed.
  try {
    const listed = await listLabelled({});
    assert.equal(listed.ok, true, "the daemon answers a final read");
    const leftovers = listed.containers.filter((c) => c.name.startsWith(`wag-verify-${stamp}`));
    assert.equal(leftovers.length, 0, `no probe container is left: ${leftovers.map((c) => c.name).join(", ")}`);
    pass("read-back", "no probe container is left on the daemon");
  } catch (e) {
    fail("read-back", e.message);
  }

  say(failed ? `FAILED ${failed} step(s)` : "PASS all 7 steps");
  return failed ? 1 : 0;
};

main()
  .catch((e) => {
    fail("verify", String((e && e.stack) || e));
    return 1;
  })
  .then((code) => {
    cleanup();
    resetDaemonState();
    process.exitCode = code;
  });
