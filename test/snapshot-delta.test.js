// What a stream push has to say once the reader already has the board (lib/snapshot-delta.js): the panes that
// changed and the rows that changed, and nothing else. Synthetic snapshots - no store, no socket, no clock.
//
// The load-bearing test here is the REPLAY one: a delta applied to the state a client held must produce exactly the
// state the full frame would have produced. Every other property (a smaller frame, a quiet push sending nothing)
// is only worth anything if that one holds.
import assert from "node:assert/strict";
import test from "node:test";
import { snapshotDelta, snapshotRowPrints } from "../lib/snapshot-delta.js";

const row = (path, extra = {}) => ({
  path,
  branch: "main",
  name: path.split("/").pop(),
  sync: { ahead: 0, behind: 0 },
  todo: { total: 1, done: 0, items: [{ id: 1, text: "a thing", status: "todo", at: "2026-11-01T00:00:00.000Z", ageMs: 1000 }] },
  ...extra,
});
const project = (name, rows, extra = {}) => ({ name, path: `/repos/${name}`, activityAt: "2026-11-23T10:00:00.000Z", worktrees: rows, ...extra });
const snapshot = (projects, extra = {}) => ({
  generatedAt: "2026-11-23T15:00:00.000Z",
  settings: { threads: 5 },
  stats: { scans: 7 },
  hosts: { projects: {} },
  treeList: { count: 2 },
  projects,
  jobs: [{ id: "job_1", lines: [{ lid: 1, text: "hello" }] }],
  assistant: { thread: "t1" },
  approvals: [],
  ...extra,
});

// The page's own merge, in the smallest faithful form (public/settings.js applySnapshotDelta): panes replace, rows
// replace by path, jobs merge by id, dropped rows/projects/jobs leave, project fields merge. Written out here so the
// server's frame is checked against an independent reader, not against itself.
function replay(prev, delta) {
  const next = { ...prev };
  for (const key of Object.keys(delta)) {
    if (["delta", "generatedAt", "projects", "rows", "droppedRows", "droppedProjects", "jobs", "droppedJobs"].includes(key)) continue;
    next[key] = delta[key];
  }
  // The job pane: merged by id, the way updateJob merges one card on the page.
  if (Array.isArray(delta.jobs) || Array.isArray(delta.droppedJobs)) {
    const byId = new Map((prev.jobs || []).map((j) => [j.id, j]));
    for (const id of delta.droppedJobs || []) byId.delete(id);
    for (const job of delta.jobs || []) byId.set(job.id, job);
    next.jobs = [...byId.values()];
  }
  const projects = (prev.projects || []).map((p) => ({ ...p, worktrees: [...(p.worktrees || [])] }));
  const byName = new Map(projects.map((p) => [p.name, p]));
  for (const name of delta.droppedProjects || []) byName.delete(name);
  for (const fields of delta.projects || []) {
    const { added, ...rest } = fields;
    const cur = byName.get(fields.name);
    if (cur) byName.set(fields.name, { ...cur, ...rest });
    else byName.set(fields.name, { ...rest, worktrees: [] });
  }
  for (const { project: name, row: fresh } of delta.rows || []) {
    const p = byName.get(name);
    assert.ok(p, `row for a project the delta never named: ${name}`);
    const at = p.worktrees.findIndex((w) => w.path === fresh.path);
    if (at === -1) p.worktrees.push(fresh);
    else p.worktrees[at] = fresh;
  }
  for (const { project: name, path } of delta.droppedRows || []) {
    const p = byName.get(name);
    if (!p) continue;
    p.worktrees = p.worktrees.filter((w) => w.path !== path);
  }
  next.projects = [...byName.values()];
  return next;
}

const strip = (snap) =>
  JSON.parse(
    JSON.stringify(snap, (key, value) => {
      if (key === "generatedAt") return undefined;
      if (key === "ageMs") return 0; // derived at build time; the delta deliberately does not resend a row for it
      return value;
    }),
  );

test("a push carries the changed pane and the changed row, and no other row", () => {
  const before = snapshot([project("a", [row("/repos/a/one"), row("/repos/a/two")]), project("b", [row("/repos/b/one")])]);
  const after = JSON.parse(JSON.stringify(before));
  after.projects[0].worktrees[0].todo.items[0].status = "done";
  after.jobs = [{ id: "job_1", lines: [{ lid: 1, text: "hello" }, { lid: 2, text: "again" }] }];
  const delta = snapshotDelta(before, after);
  assert.ok(delta, "there was a change, so there is a frame");
  assert.equal(delta.rows.length, 1, "one row moved");
  assert.equal(delta.rows[0].project, "a");
  assert.equal(delta.rows[0].row.path, "/repos/a/one");
  assert.equal(delta.jobs.length, 1, "the job pane moved and is carried whole");
  assert.equal(delta.projects, undefined, "no project field moved");
  assert.equal(delta.settings, undefined, "an unchanged pane is not resent");
  assert.equal(delta.assistant, undefined);
});

test("a replay of the delta leaves the client in exactly the state the full frame describes", () => {
  const before = snapshot([project("a", [row("/repos/a/one"), row("/repos/a/two")]), project("b", [row("/repos/b/one")])]);
  const after = JSON.parse(JSON.stringify(before));
  after.projects[0].activityAt = "2026-11-23T11:00:00.000Z";
  after.projects[0].worktrees[1].sync.ahead = 3;
  after.projects[1].worktrees.push(row("/repos/b/two"));
  after.projects.push(project("c", [row("/repos/c/one")]));
  after.projects = after.projects.filter((p) => p.name !== "a" || true); // keep both; "c" is the arrival
  after.settings = { threads: 8 };
  after.approvals = [{ id: "apr_1" }];
  after.assistant = { thread: "t2" };
  after.generatedAt = "2026-11-23T15:00:05.000Z";
  const delta = snapshotDelta(before, after);
  assert.ok(delta);
  assert.deepEqual(strip(replay(before, delta)), strip(after), "replaying the delta must land on the full frame's state");
});

test("a row that only aged is not resent, but a row that really changed is carried whole", () => {
  const before = snapshot([project("a", [row("/repos/a/one")])]);
  const aged = JSON.parse(JSON.stringify(before));
  aged.projects[0].worktrees[0].todo.items[0].ageMs = 99_000;
  assert.equal(snapshotDelta(before, aged), null, "an age alone is not news");

  const moved = JSON.parse(JSON.stringify(aged));
  moved.projects[0].worktrees[0].branch = "feature/x";
  const delta = snapshotDelta(before, moved);
  assert.equal(delta.rows.length, 1);
  assert.equal(delta.rows[0].row.branch, "feature/x");
  assert.equal(delta.rows[0].row.todo.items[0].ageMs, 99_000, "the row travels whole, age included");
});

test("nothing changed means no frame at all", () => {
  const one = snapshot([project("a", [row("/repos/a/one")])]);
  assert.equal(snapshotDelta(one, JSON.parse(JSON.stringify(one))), null);
});

test("rows that left and projects that left are named, never silently dropped", () => {
  const before = snapshot([project("a", [row("/repos/a/one"), row("/repos/a/two")]), project("gone", [row("/repos/g/one")])]);
  const after = snapshot([project("a", [row("/repos/a/one")])]);
  const delta = snapshotDelta(before, after);
  assert.deepEqual(delta.droppedRows, [{ project: "a", path: "/repos/a/two" }]);
  assert.deepEqual(delta.droppedProjects, ["gone"]);
  assert.deepEqual(strip(replay(before, delta).projects), strip(after.projects));
});

test("a client with nothing yet gets every pane and every row, and replays to the same state", () => {
  const after = snapshot([project("a", [row("/repos/a/one")])]);
  const delta = snapshotDelta(null, after);
  assert.ok(delta);
  assert.equal(delta.rows.length, 1);
  assert.equal(delta.projects.length, 1);
  assert.equal(delta.projects[0].added, true);
  assert.deepEqual(strip(replay({ projects: [] }, delta)), strip(after));
});

test("a delta never claims to be a full snapshot", () => {
  const after = snapshot([project("a", [row("/repos/a/one")])]);
  const delta = snapshotDelta(null, after);
  assert.equal(delta.delta, true);
  assert.equal(delta.generatedAt, after.generatedAt, "the frame carries the state's own stamp");
  assert.equal(delta.projects[0].worktrees, undefined, "rows travel in `rows`, not inside the project");
});

test("the job pane travels as the cards that moved, and a removed card is named", () => {
  const before = snapshot([project("a", [row("/repos/a/one")])], {
    jobs: [
      { id: "job_1", lines: [{ lid: 1, text: "one" }] },
      { id: "job_2", lines: [{ lid: 1, text: "two" }] },
    ],
  });
  const after = JSON.parse(JSON.stringify(before));
  after.jobs[1].lines.push({ lid: 2, text: "three" });
  const delta = snapshotDelta(before, after);
  assert.equal(delta.jobs.length, 1, "only the card that moved");
  assert.equal(delta.jobs[0].id, "job_2");
  assert.equal(delta.droppedJobs, undefined);

  const gone = JSON.parse(JSON.stringify(after));
  gone.jobs = [gone.jobs[1]];
  const second = snapshotDelta(after, gone);
  assert.deepEqual(second.droppedJobs, ["job_1"]);
  assert.equal(second.jobs, undefined, "the card that stayed is not resent");
  assert.deepEqual(strip(replay(before, delta).jobs), strip(after.jobs));
});

test("a row the client already holds from its own row frame is not sent again", () => {
  // The scan delivers a row as a `row` frame; a push half a minute later compares against what the tab was TOLD
  // (the print ledger), not against the last push's text - so a board being scanned still gets a one-row push.
  const before = snapshot([project("a", [row("/repos/a/one"), row("/repos/a/two")])]);
  const after = JSON.parse(JSON.stringify(before));
  after.projects[0].worktrees[0].signals = { hermes: { running: 1 } };
  after.projects[0].worktrees[0].todo.items[0].ageMs = 2000;
  const held = snapshotRowPrints(after);
  const delta = snapshotDelta(before, after, { printOf: held });
  assert.equal(delta, null, "the tab already holds every row, so there is nothing to say");

  // A real edit to one of them still travels.
  const edited = JSON.parse(JSON.stringify(after));
  edited.projects[0].worktrees[0].todo.items[0].status = "done";
  const one = snapshotDelta(before, edited, { printOf: held });
  assert.equal(one.rows.length, 1);
  assert.equal(one.rows[0].row.todo.items[0].status, "done");
});
