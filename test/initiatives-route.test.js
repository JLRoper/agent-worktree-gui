// The initiatives' wire half, over a real server in a sandbox: the read the tab draws, the two free writes, and the
// one write that is a question.
//
// What this file is really pinning:
//
//   * THE MOVE CHANGES NOTHING UNTIL THE READER ANSWERS. POST /api/initiatives/move answers 202 with a question id,
//     the store still has no tree in it, and the question names the tree AND the initiative. Answering once applies
//     the move; answering deny leaves the document byte-identical.
//   * A "YES" ON A MOVE IS NOT A PUSH GRANT. The question is parked with `grants: false`, so the answer's state does
//     not list the tree (lib/remote-writes.js `once`). Without that, one initiative move would silently authorise the
//     next `git push` from that tree - the kind of bug that only shows up in production, months later.
//   * AN UNREADABLE STORE IS A 409 AND NO QUESTION. The move route checks the store BEFORE parking anything, so the
//     reader is never handed a card whose only answer is a failure, and the corrupt bytes stay on disk.
//   * THE TAB'S COUNTS ARE THE QUEUE'S, and the assistants are ordered by how recently they worked on THIS initiative
//     (the running one first, because it is working now).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { git, post, startPanel, waitForState } from "../tools/panel-testkit.mjs";

const sandbox = mkdtempSync(path.join(tmpdir(), "wag-initiatives-route-"));
const repos = path.join(sandbox, "repos");
mkdirSync(repos, { recursive: true });
after(() => rmSync(sandbox, { recursive: true, force: true }));

// Two projects, four worktrees: the shape the proof's screenshot names. Nothing here is about git beyond giving the
// scan rows to find, so each tree is one commit on its own branch.
function project(name, trees) {
  const dir = path.join(repos, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "first"]);
  for (const tree of trees) {
    git(dir, ["worktree", "add", "-q", "-b", tree, path.join(dir, ".worktrees", tree)]);
  }
  return dir;
}
const projectA = project("project-a", ["sso-one", "sso-two"]);
const projectB = project("project-b", ["gateway-one", "gateway-two"]);
const treeA1 = path.join(projectA, ".worktrees", "sso-one");
const treeA2 = path.join(projectA, ".worktrees", "sso-two");
const treeB1 = path.join(projectB, ".worktrees", "gateway-one");
const treeB2 = path.join(projectB, ".worktrees", "gateway-two");
const initiativesFile = path.join(sandbox, "logs", "initiatives.json");

const panel = await startPanel({ dir: sandbox, config: { initiativesFile } });
after(() => panel.stop());
const base = panel.base;
const get = async (p) => {
  const r = await fetch(`${base}${p}`);
  return { status: r.status, json: await r.json() };
};
const readStore = () => JSON.parse(readFileSync(initiativesFile, "utf8"));
const state = async () => (await get("/api/state")).json;
// The remote-write cards left the snapshot for their own route, so the question a move parks is read there.
const pendingCards = async () => (await get("/api/remote-write/state")).json.pending;

// The level is a settings value, so a test that is about the wire shape of a write NAMES the level it needs instead
// of leaning on the default. `all` is the strictest and asks for every change; `remove` leaves create and edit free
// and asks only about a detach. The four levels' own behaviour is test/initiative-tier-route.test.js's subject.
const setTier = async (tier) => {
  const out = await post(base, "/api/settings/initiative-tier", { body: { tier } });
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.tier.id, tier);
};

await waitForState(
  base,
  (s) => {
    const rows = s.projects.flatMap((p) => (p.worktrees || []).map((w) => w.path));
    return [treeA1, treeA2, treeB1, treeB2].every((p) => rows.some((r) => r.replace(/\\/g, "/").toLowerCase() === p.replace(/\\/g, "/").toLowerCase()));
  },
  "the four worktrees are on the board",
  { timeout: 120_000 },
);

// One assistant, four tasks in four states, on the initiative's trees. The queue route is the shipped one; this is
// the same write an assistant makes when it files a task, and a filed task is `queued` - the state before running,
// counted by the tab's strip with the other three.
const assistantState = async () => (await get("/api/assistant")).json;
const first = (await assistantState()).assistants[0];
assert.ok(first?.id, "the panel seeds an assistant");
const addTask = async (assistantId, title, worktree, projectName) => {
  const made = await post(base, "/api/assistant/queue", { body: { assistantId, action: "add", title, worktree, project: projectName } });
  assert.equal(made.status, 200, made.text);
  const task = (await get(`/api/assistant/queue?assistantId=${assistantId}`)).json.queue.tasks.find((t) => t.title === title);
  assert.ok(task, `task ${title} exists`);
  return task;
};
const setState = async (assistantId, id, next) => {
  const out = await post(base, "/api/assistant/queue", { body: { assistantId, action: "state", id, state: next, reason: next === "parked" ? "waiting on the reader" : undefined } });
  assert.equal(out.status, 200, out.text);
};
const done = await addTask(first.id, "finish the store", treeA1, "project-a");
await setState(first.id, done.id, "done");
const parked = await addTask(first.id, "write the tab", treeB1, "project-b");
await setState(first.id, parked.id, "parked");
const running = await addTask(first.id, "prove the column", treeA2, "project-a");
await setState(first.id, running.id, "running");
// Filed and not started: the queue route writes a new task as `queued`, which is the state the strip draws first.
const waiting = await addTask(first.id, "wait for the gateway owner", treeB2, "project-b");
assert.equal(waiting.state, "queued", "a filed task is queued until an assistant picks it up");

test("the tab's read starts empty, and says the store is a file it can read", async () => {
  const out = await get("/api/initiatives");
  assert.equal(out.status, 200);
  assert.equal(out.json.readable, true);
  assert.equal(out.json.file, initiativesFile);
  assert.deepEqual(out.json.initiatives, []);
});

test("create lands with no trees, and the document is a file beside the panel's other state", async () => {
  await setTier("remove");
  const made = await post(base, "/api/initiatives", { body: { title: "SSO migration", description: "Menu and oauth2, one piece of work" } });
  assert.equal(made.status, 201, made.text);
  assert.match(made.json.initiative.id, /^init_/);
  assert.equal(made.json.initiatives.length, 1);
  assert.equal(made.json.initiatives[0].treeCount, 0);
  const doc = readStore();
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.trees, {});
  assert.equal(doc.initiatives[0].title, "SSO migration");
});

test("a move parks a question that names the tree and the initiative - and changes nothing yet", async () => {
  await setTier("all");
  const init = (await get("/api/initiatives")).json.initiatives[0];
  const asked = await post(base, "/api/initiatives/move", { body: { tree: treeA1, initiative: init.id, action: "add" } });
  assert.equal(asked.status, 202, asked.text);
  assert.equal(asked.json.asked, true);
  assert.ok(asked.json.id);
  assert.match(asked.json.note, /dock/i);

  // The store did not move: this is the whole point of the card.
  assert.deepEqual(readStore().trees, {});
  // And the question that the page will draw carries both names, plus the fact that it grants no remote write.
  const pending = (await pendingCards()).find((p) => p.id === asked.json.id);
  assert.ok(pending, "the question rides the snapshot, so a reload comes back to it");
  assert.equal(pending.kind, "initiative");
  assert.match(pending.title, /Add sso-one to "SSO migration"/);
  assert.match(pending.command, /add .*sso-one to initiative "SSO migration"/);
  assert.deepEqual(pending.allowed, ["once", "deny"]);
  assert.equal(pending.grants, false);
});

test("answering once applies the move, and leaves no push grant behind", async () => {
  const pending = (await pendingCards()).find((p) => p.kind === "initiative");
  const answered = await post(base, "/api/remote-write/answer", { body: { id: pending.id, choice: "once" } });
  assert.equal(answered.status, 200, answered.text);
  assert.equal(answered.json.resumed.ok, true);
  assert.equal(answered.json.resumed.changed, true);
  assert.deepEqual(readStore().trees[Object.keys(readStore().trees)[0]].initiatives.length, 1);
  // THE PUSH-GRANT TRAP: a "once" on this question must not appear in the remote-write grants.
  assert.equal(answered.json.state.once.some((p) => p.replace(/\\/g, "/").toLowerCase().endsWith("/sso-one")), false);
});

test("deny leaves the document byte for byte", async () => {
  const init = (await get("/api/initiatives")).json.initiatives[0];
  const before = readFileSync(initiativesFile, "utf8");
  const asked = await post(base, "/api/initiatives/move", { body: { tree: treeB1, initiative: init.id, action: "add" } });
  assert.equal(asked.status, 202, asked.text);
  const answered = await post(base, "/api/remote-write/answer", { body: { id: asked.json.id, choice: "deny" } });
  assert.equal(answered.status, 200, answered.text);
  assert.equal(answered.json.resumed, null, "a deny resumes nothing");
  assert.equal(readFileSync(initiativesFile, "utf8"), before);
});

test("the read groups the trees by project and counts the assistants by state, newest worker first", async () => {
  const init = (await get("/api/initiatives")).json.initiatives[0];
  // Add the three remaining trees through the real path (ask, answer once), so the view is built from a store a
  // reader's answers produced rather than one a fixture wrote.
  for (const [tree, projectName] of [
    [treeA2, "project-a"],
    [treeB1, "project-b"],
    [treeB2, "project-b"],
  ]) {
    const asked = await post(base, "/api/initiatives/move", { body: { tree, initiative: init.id, action: "add" } });
    assert.equal(asked.status, 202, asked.text);
    const answered = await post(base, "/api/remote-write/answer", { body: { id: asked.json.id, choice: "once" } });
    assert.equal(answered.status, 200, answered.text);
    assert.equal(answered.json.resumed.ok, true, `${projectName}: the move landed`);
  }
  const view = (await get("/api/initiatives")).json.initiatives[0];
  assert.equal(view.treeCount, 4);
  assert.equal(view.projectCount, 2);
  assert.deepEqual(view.projects.map((p) => p.name), ["project-a", "project-b"]);
  assert.deepEqual(view.projects.map((p) => p.trees.length), [2, 2]);
  assert.deepEqual(view.projects[0].trees.map((t) => t.name), ["sso-one", "sso-two"]);
  // The four tasks are on the four trees of this initiative: one of each state, and the four states the strip
  // draws all counted by the same read.
  assert.equal(view.assistants.length, 1);
  assert.deepEqual(view.assistants[0].counts, { queued: 1, running: 1, done: 1, parked: 1 });
  assert.ok(view.assistants[0].lastAt, "a running task makes the assistant count as working now");

  // The chart column's field is on the rows themselves, and only on rows that have one.
  const s = await state();
  const norm = (p) => p.replace(/\\/g, "/").toLowerCase();
  const rowFor = (tree) => s.projects.flatMap((p) => p.worktrees).find((r) => norm(r.path) === norm(tree));
  assert.deepEqual(rowFor(treeA1).initiatives, [{ id: view.id, title: "SSO migration" }]);
  // Nothing else on the board wears the field: the four trees above are the whole membership, and a project's own
  // main checkout is a row with no initiative - which is the normal, unenforced case.
  const carrying = s.projects.flatMap((p) => p.worktrees).filter((r) => r.initiatives && r.initiatives.length);
  assert.deepEqual(carrying.map((r) => norm(r.path)).sort(), [treeA1, treeA2, treeB1, treeB2].map(norm).sort());
});

test("an edit changes the words and nothing else", async () => {
  await setTier("remove");
  const init = (await get("/api/initiatives")).json.initiatives[0];
  const edited = await post(base, "/api/initiatives/update", { body: { id: init.id, title: "SSO migration, phase two", description: "now with the gateway" } });
  assert.equal(edited.status, 200, edited.text);
  assert.equal(edited.json.initiative.title, "SSO migration, phase two");
  const view = (await get("/api/initiatives")).json.initiatives[0];
  assert.equal(view.title, "SSO migration, phase two");
  assert.equal(view.description, "now with the gateway");
  assert.equal(view.treeCount, 4, "membership is not touched by an edit");
});

test("an unreadable store is a 409 on every write, and the move asks nothing at all", async () => {
  const broken = '{ "version": 1, "initiatives": [ { "id": "init_';
  writeFileSync(initiativesFile, broken, "utf8");
  const read = await get("/api/initiatives");
  assert.equal(read.status, 200);
  assert.equal(read.json.readable, false);
  assert.match(read.json.error, /JSON|Unexpected|end of/i);

  const created = await post(base, "/api/initiatives", { body: { title: "Should not land" } });
  assert.equal(created.status, 409, created.text);
  assert.equal(created.json.refused, "unreadable");
  assert.match(created.json.error, /NOT overwritten/);

  const pendingBefore = (await pendingCards()).length;
  const moved = await post(base, "/api/initiatives/move", { body: { tree: treeA1, initiative: "init_whatever", action: "remove" } });
  assert.equal(moved.status, 409, moved.text);
  assert.equal(moved.json.refused, "unreadable");
  assert.equal((await pendingCards()).length, pendingBefore, "no card whose only answer is a failure");
  assert.equal(readFileSync(initiativesFile, "utf8"), broken);
});

test("a repaired store works again on the next write", async () => {
  await setTier("remove");
  writeFileSync(initiativesFile, JSON.stringify({ version: 1, initiatives: [], trees: {} }), "utf8");
  const made = await post(base, "/api/initiatives", { body: { title: "After the repair" } });
  assert.equal(made.status, 201, made.text);
  assert.equal((await get("/api/initiatives")).json.readable, true);
});

test("the read is memoised for a moment, and a write drops it", async () => {
  // The read behind this tab is a whole-store join (initiatives x trees x queue x waves x gate evidence) that measured
  // 34.7s during a boot on 2026-11-23 for a 122 KB document, and the tab polls it. Two reads inside the window must
  // answer the SAME document; a write must never be answered from a cache built before it.
  const before = (await get("/api/initiatives")).json;
  const again = (await get("/api/initiatives")).json;
  assert.equal(again.at, before.at, "a second read inside the window reuses the document");
  assert.equal(again.initiatives.length, before.initiatives.length);

  const made = await post(base, "/api/initiatives", { body: { title: "Drops the memoised read" } });
  assert.equal(made.status, 201, made.text);
  const after = (await get("/api/initiatives")).json;
  assert.notEqual(after.at, before.at, "a write drops the memoised read");
  assert.equal(after.initiatives.length, before.initiatives.length + 1);
});
