// The container teardown, its close gate and its brief: one file per claim.
//
// The pure half runs everywhere: the label match is the panel's tree spelling, a stopped container is not a reason to
// refuse a close, and the sentence names what it is about. The real-daemon half is SKIPPED on a machine with no
// Docker (or no image), and it is the proof that matters: a labelled container is stopped and removed at a settle, an
// unlabelled one is left alone, the refusal fires, and a close whose reason names the container goes through.
//
// The image is `node:24-bookworm-slim` unless WTGUI_TEST_IMAGE names another one; the block skips when neither is
// present, because a test may not pull an image on a reader's machine.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Jobs } from "../lib/jobs.js";
import {
  closeGate,
  closeRefusal,
  containerBriefFor,
  labelTree,
  labelledFor,
  listLabelled,
  parseInspect,
  resetDaemonState,
  sameTree,
  teardownPlan,
  teardownTree,
} from "../lib/container-teardown.js";

const IMAGE = process.env.WTGUI_TEST_IMAGE || "node:24-bookworm-slim";

// tools/absolute-paths.mjs refuses a line shaped like a drive-letter path anywhere, fixtures included, and a new
// landing does not get an allowlist line for a path that exists nowhere. So this file's stand-in trees are built from
// parts: the comparison is the same, and the fixture stays readable.
const DRIVE = String.fromCharCode(67) + ":";
const T1 = `${DRIVE}/p/.worktrees/t`;
const T1W = T1.replace(/\//g, "\\");
const T2 = `${T1}-2`;
const T3 = `${DRIVE}/p/t`;
const T4 = `${DRIVE}/p/other`;
const lower = (p) => p.toLowerCase();
const labels = (tree, row = null) => ({ Labels: { "wag.worktree": tree, ...(row ? { "wag.row": row } : {}) } });

const docker = (...args) => {
  try {
    const out = execFileSync("docker", args, { encoding: "utf8", timeout: 30_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out: String(out || "").trim() };
  } catch (e) {
    return { ok: false, error: String(e?.stderr || e?.message || e).trim() };
  }
};

const daemonUp = () => docker("version", "--format", "{{.Server.Version}}").ok;
const imageThere = (image) => docker("image", "inspect", "--format", "{{.Id}}", image).ok;
const DOCKER = daemonUp() && imageThere(IMAGE);
const WHY = !daemonUp() ? "no Docker daemon on this machine" : `the image ${IMAGE} is not present (set WTGUI_TEST_IMAGE)`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gone = async (fn, { ms = 20_000 } = {}) => {
  const until = Date.now() + ms;
  for (;;) {
    if (fn()) return true;
    if (Date.now() > until) return false;
    await sleep(200);
  }
};

const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const named = (n) => `wag-ct-${stamp()}-${n}`;
const makeTree = (tag) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), `wtgui-ct-${tag}-`));
  return dir;
};

// A container started by a WORKER: the two labels, and a command that stays up until it is stopped.
const startLabelled = (name, tree, { row = "269", rm = false } = {}) => {
  const args = ["run", "-d", ...(rm ? ["--rm"] : []), "--label", `wag.worktree=${labelTree(tree)}`, "--label", `wag.row=${row}`, "--name", name, IMAGE, "sleep", "600"];
  const out = docker(...args);
  assert.equal(out.ok, true, `the probe container ${name} started: ${out.error || ""}`);
  return out.out.trim();
};
const startPlain = (name) => {
  const out = docker("run", "-d", "--rm", "--name", name, IMAGE, "sleep", "600");
  assert.equal(out.ok, true, `the control container ${name} started: ${out.error || ""}`);
  return out.out.trim();
};
const alive = (id) => docker("inspect", "--format", "{{.State.Running}}", id).out === "true";
const exists = (id) => docker("inspect", "--format", "{{.Id}}", id).ok;
const stopQuietly = (id) => {
  docker("rm", "-f", id);
};

test("parseInspect reads the two labels, the running state and the name, and drops an entry with no id", () => {
  const text = JSON.stringify([
    { Id: "abc123", Name: "/web-269", State: { Running: true }, Config: labels(T1, "269") },
    { Id: "", Name: "/broken", State: { Running: true }, Config: { Labels: {} } },
    { Id: "def456", Name: "/gone", State: { Running: false }, Config: labels(T1) },
  ]);
  const list = parseInspect(text);
  assert.equal(list.length, 2, "the entry without an id is not a container this module can act on");
  assert.deepEqual(list[0], { id: "abc123", name: "web-269", running: true, tree: T1, row: "269" });
  assert.equal(list[1].running, false);
  assert.deepEqual(parseInspect("not json"), []);
});

test("the tree match is the panel's one spelling, and a sibling path is not this tree", () => {
  assert.equal(sameTree(T1W, `${T1}/`.toLowerCase()), true);
  const list = parseInspect(
    JSON.stringify([
      { Id: "1", Name: "/a", State: { Running: true }, Config: labels(T1W) },
      { Id: "2", Name: "/b", State: { Running: true }, Config: labels(T2) },
      { Id: "3", Name: "/c", State: { Running: true }, Config: { Labels: {} } },
    ]),
  );
  assert.deepEqual(labelledFor(list, lower(T1)).map((c) => c.id), ["1"]);
  assert.deepEqual(labelledFor(list, "").map((c) => c.id), [], "an empty tree matches nothing, never everything");
});

test("a teardown plan stops the running ones, removes every match, and names nothing outside the match", () => {
  const list = parseInspect(
    JSON.stringify([
      { Id: "run1", Name: "/run", State: { Running: true }, Config: labels(T3) },
      { Id: "stop1", Name: "/stop", State: { Running: false }, Config: labels(T3) },
      { Id: "other", Name: "/other", State: { Running: true }, Config: labels(T4) },
    ]),
  );
  const plan = teardownPlan(list, T3);
  assert.deepEqual(plan.stop, ["run1"], "only the running one is stopped");
  assert.deepEqual(plan.remove, ["run1", "stop1"], "a stopped one is still removed");
  assert.equal(plan.matched.length, 2, "the other tree's container is not in the plan");
});

test("the close gate refuses a running labelled container with a sentence that names it and the way out", () => {
  const list = parseInspect(JSON.stringify([{ Id: "aa11", Name: "/web-269", State: { Running: true }, Config: labels(T3, "269") }]));
  const task = { id: 269, worktree: T3 };
  const said = closeRefusal({ task, reason: "", containers: list });
  assert.match(said, /^#269 cannot close while 1 labelled container still runs: web-269 \(row 269\)\./);
  assert.ok(said.includes(`{"tree": "${T3}"}`), `the sentence names the tree and the route: ${said}`);
  assert.match(said, /POST \/api\/containers\/teardown/);
  assert.match(said, /name it in the reason, with why it is kept/);
});

test("a reason that names the container and says why lets the close through; a bare name does not", () => {
  const list = parseInspect(
    JSON.stringify([
      { Id: "aa11", Name: "/web-269", State: { Running: true }, Config: labels(T3) },
      { Id: "bb22", Name: "/db-269", State: { Running: true }, Config: labels(T3) },
    ]),
  );
  const task = { id: 7, worktree: T3 };
  assert.equal(closeRefusal({ task, reason: "kept web-269 and db-269 because the demo still needs both", containers: list }), null);
  const bare = closeRefusal({ task, reason: "web-269 db-269", containers: list });
  assert.match(bare, /names the containers \(web-269, db-269\) but not why they are kept/);
  const one = closeRefusal({ task, reason: "kept web-269 for the demo", containers: list });
  assert.match(one, /cannot close while 2 labelled containers still run/, "every running one has to be named");
});

test("a stopped container is not a reason to refuse a close", () => {
  const list = parseInspect(JSON.stringify([{ Id: "st1", Name: "/old", State: { Running: false }, Config: labels(T3) }]));
  assert.equal(closeRefusal({ task: { id: 1, worktree: T3 }, reason: "", containers: list }), null);
});

test("the brief carries the two labels, the literal tree, the row and the --rm requirement", () => {
  const text = containerBriefFor({ tree: T1W, row: "269" });
  assert.ok(text.includes(`--label wag.worktree=${T1} `), "the tree is written in the exact spelling the teardown matches");
  assert.match(text, /--label wag\.row=269/);
  assert.match(text, /docker run -d --rm/);
  assert.match(text, /`labels:` block/, "a compose service is told where the same two labels go");
  assert.match(text, /refuses to close your row while one is still running/);
  const bare = containerBriefFor({ tree: T3 });
  assert.match(bare, /leave it off a run with no row/);
});

test("teardownTree on a daemon that says nothing is a clean answer, not a throw", async () => {
  resetDaemonState();
  const calls = [];
  const out = await teardownTree(T3, {
    run: async (args) => {
      calls.push(args.join(" "));
      return { ok: true, out: "" };
    },
    log: () => {},
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.removed, []);
  assert.deepEqual(calls, ["ps -a -q --filter label=wag.worktree"], "one read, and no write when nothing carries the label");
});

test("teardownTree stops and removes only the labelled match, and reads the daemon back", async () => {
  resetDaemonState();
  const state = new Map([
    ["lbl1", { Name: "/web", running: true, tree: T3 }],
    ["lbl2", { Name: "/db", running: false, tree: T3 }],
    ["other", { Name: "/control", running: true, tree: T4 }],
  ]);
  const seen = [];
  const run = async (args) => {
    seen.push(args.join(" "));
    const [verb] = args;
    if (verb === "ps") return { ok: true, out: `${[...state.keys()].join("\n")}\n` };
    if (verb === "inspect") {
      const ids = args.slice(1).filter((a) => state.has(a));
      return {
        ok: true,
        out: JSON.stringify(
          ids.map((id) => ({
            Id: id,
            Name: state.get(id).Name,
            State: { Running: state.get(id).running },
            Config: { Labels: { "wag.worktree": state.get(id).tree } },
          })),
        ),
      };
    }
    if (verb === "stop") {
      for (const id of args.slice(1)) state.get(id).running = false;
      return { ok: true, out: "" };
    }
    if (verb === "rm") {
      for (const id of args.slice(1)) state.delete(id);
      return { ok: true, out: "" };
    }
    return { ok: false, error: `unexpected docker ${args[0]}` };
  };
  const out = await teardownTree(`${T3}/`, { run, log: () => {} });
  assert.equal(out.ok, true);
  assert.deepEqual(out.stopped, ["web"], "the running labelled one was stopped");
  assert.deepEqual(out.removed.sort(), ["db", "web"], "both labelled containers were removed");
  assert.equal(state.has("other"), true, "the other tree's container was never touched");
  assert.equal(state.get("other").running, true);
  assert.ok(seen.includes("stop lbl1"), "stop ran before rm");
  assert.ok(seen[seen.length - 2].startsWith("ps"), "the last two calls are the read-back: ps, then inspect");
});

test("a daemon that fails is remembered, and the next teardown does not spawn docker again", async () => {
  resetDaemonState();
  const first = await teardownTree(T3, { run: async () => ({ ok: false, error: "Cannot connect to the Docker daemon" }), log: () => {} });
  assert.equal(first.ok, false);
  assert.match(first.error, /Cannot connect/);
  let calls = 0;
  const second = await teardownTree(T3, {
    run: async () => {
      calls += 1;
      return { ok: true, out: "" };
    },
    log: () => {},
  });
  assert.equal(calls, 0, "the remembered failure skipped the daemon entirely");
  assert.match(second.error, /docker is not answering/);
  resetDaemonState();
});

test("listLabelled asks for ids first and reads the labels with inspect", async () => {
  resetDaemonState();
  const seen = [];
  const out = await listLabelled({
    run: async (args) => {
      seen.push(args[0]);
      if (args[0] === "ps") return { ok: true, out: "1\n2\n" };
      return {
        ok: true,
        out: JSON.stringify([
          { Id: "1", Name: "/a", State: { Running: true }, Config: labels(T3) },
          { Id: "2", Name: "/b", State: { Running: true }, Config: labels(T3) },
        ]),
      };
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.containers.length, 2);
  assert.deepEqual(seen, ["ps", "inspect"], "two calls, and inspect got every id in one");
});

// ---- the real daemon: the four proofs the brief asks for -------------------------------------------------------

test("on a real daemon: a labelled container is stopped and removed at a settle, and an unlabelled one is left alone", { skip: DOCKER ? false : WHY }, async (t) => {
  resetDaemonState();
  const tree = makeTree("settle");
  const dir = makeTree("jobs");
  const labelled = startLabelled(named("settle"), tree);
  const control = startPlain(named("control"));
  const jobs = new Jobs({ config: { jobsFile: path.join(dir, "jobs.json"), apiServer: { url: "http://127.0.0.1:9" } }, onLog: () => {} });
  t.after(() => {
    clearInterval(jobs.titleSweep);
    clearInterval(jobs.approvalSweep);
    clearInterval(jobs.approvalReconcile);
    clearTimeout(jobs.persistTimer);
    stopQuietly(control);
    stopQuietly(labelled);
    rmSync(tree, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    resetDaemonState();
  });

  assert.equal(exists(labelled), true, "the labelled container is there before the settle");
  const j = {
    id: "j-container-settle",
    thread: "t-container-settle",
    status: "running",
    startedAt: new Date().toISOString(),
    cwd: null,
    ownerPath: null,
    worktreePath: labelTree(tree),
    lines: [],
  };
  jobs.jobs.set(j.id, j);
  jobs.settle(j, "completed", { output: "done" });

  assert.equal(await gone(() => !exists(labelled)), true, "the settle stopped and removed the labelled container");
  assert.equal(alive(control), true, "the unlabelled container is still running: no label, no teardown");
});

test("on a real daemon: the refusal fires with its sentence, and a reason naming the container lets the close through", { skip: DOCKER ? false : WHY }, async (t) => {
  resetDaemonState();
  const tree = makeTree("gate");
  const name = named("gate");
  const id = startLabelled(name, tree);
  t.after(() => {
    stopQuietly(id);
    rmSync(tree, { recursive: true, force: true });
    resetDaemonState();
  });
  const task = { id: 269, worktree: labelTree(tree) };
  const said = closeGate({ task, reason: "" });
  assert.ok(said, "the close is refused while the container runs");
  assert.match(said, /#269 cannot close while 1 labelled container still runs/);
  assert.ok(said.includes(name), "the sentence names the container");
  assert.match(said, /POST \/api\/containers\/teardown/);
  assert.equal(closeGate({ task, reason: `keeping ${name} because the reader is still using its port` }), null, "a named reason lets the close through");
  assert.match(closeGate({ task, reason: name }), /not why it is kept/, "the name alone is not a reason");
});

test("on a real daemon: the panel action stops and removes the named tree's containers, and a dry run leaves them running", { skip: DOCKER ? false : WHY }, async (t) => {
  const { createContainerRoutes, CONTAINERS_TEARDOWN_PATH } = await import("../routes/containers.js");
  resetDaemonState();
  const tree = makeTree("route");
  const dryId = startLabelled(named("dry"), tree);
  t.after(() => {
    stopQuietly(dryId);
    rmSync(tree, { recursive: true, force: true });
    resetDaemonState();
  });
  const answers = [];
  let body = {};
  const handler = createContainerRoutes({
    getConfig: () => ({ token: null }),
    sendJson: (res, code, payload) => answers.push({ code, payload }),
    readBody: async () => body,
    authorised: () => true,
  });
  const post = (payload) => {
    body = payload;
    answers.length = 0;
    return handler({ method: "POST" }, {}, CONTAINERS_TEARDOWN_PATH, new URL(`http://127.0.0.1${CONTAINERS_TEARDOWN_PATH}`));
  };

  await post({ tree: labelTree(tree), dryRun: true });
  assert.equal(answers[0].code, 200);
  assert.equal(answers[0].payload.dryRun, true);
  assert.equal(answers[0].payload.wouldRemove, 1);
  assert.equal(alive(dryId), true, "a dry run touched nothing");

  await post({ tree: labelTree(tree) });
  assert.equal(answers[0].code, 200, JSON.stringify(answers[0].payload));
  assert.equal(answers[0].payload.dryRun, false);
  assert.equal(await gone(() => !exists(dryId)), true, "the action removed the labelled container");
});

test("on a real daemon: the queue's done door is refused, and a close whose reason names the container goes through", { skip: DOCKER ? false : WHY }, async (t) => {
  const { Assistant } = await import("../lib/assistant.js");
  resetDaemonState();
  const tree = makeTree("queue");
  const dir = makeTree("queue-store");
  const name = named("row");
  const id = startLabelled(name, tree);
  const assistantFile = path.join(dir, "assistant.json");
  const assistant = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile, defaultCwd: dir },
    jobs: { list: () => [], firstOfThread: () => null, create: async (body) => ({ id: "job-probe", ...body }) },
    getProjects: () => [],
    getRows: () => [],
    onLog: () => {},
  });
  t.after(() => {
    for (const timer of [assistant.persistTimer, assistant.wakeTimer, assistant.timer, assistant.settleTimer]) clearTimeout(timer);
    stopQuietly(id);
    rmSync(tree, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    resetDaemonState();
  });

  const added = assistant.queueMutate("assistant-1", "add", { title: "a row whose tree still runs a container", worktree: labelTree(tree) }, { by: "reader" });
  assert.equal(added.ok, true, added.error);
  const row = added.task;
  assert.equal(row.worktree, labelTree(tree));

  const refused = assistant.queueMutate("assistant-1", "state", { id: row.id, state: "done" }, { by: "reader" });
  assert.equal(refused.ok, false, "the row is not closed while its container runs");
  assert.match(refused.error, new RegExp(`^#${row.id} cannot close while 1 labelled container still runs: ${name}`));
  assert.match(refused.error, /POST \/api\/containers\/teardown/);

  const closed = assistant.queueMutate(
    "assistant-1",
    "state",
    { id: row.id, state: "done", reason: `keeping ${name} because the reader is still using its port` },
    { by: "reader" },
  );
  assert.equal(closed.ok, true, closed.error);
  assert.equal(closed.task.state, "done");
});
