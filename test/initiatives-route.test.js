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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { git, post, startPanel, waitForState } from "../tools/panel-testkit.mjs";
// The store itself, so the "another writer" half of the order proof is a real second writer over the same file rather
// than a second POST through the same process.
import { Initiatives, normTreePath } from "../lib/initiatives.js";

const sandbox = mkdtempSync(path.join(tmpdir(), "wag-initiatives-route-"));
const repos = path.join(sandbox, "repos");
mkdirSync(repos, { recursive: true });
after(() => rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

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

  // The chart column's field is on the rows themselves, and only on rows that have one. /api/state answers the LAST
  // text and rebuilds behind it (server.js `snapshotText`, "a reader never waits for the build"), so the read that
  // follows a write can be one poll stale by design: poll for the chips rather than reading once and calling the
  // overlay missing.
  const norm = (p) => p.replace(/\\/g, "/").toLowerCase();
  let s = await state();
  const rowFor = (tree) => s.projects.flatMap((p) => p.worktrees).find((r) => norm(r.path) === norm(tree));
  if (![treeA1, treeA2, treeB1, treeB2].every((t) => rowFor(t)?.initiatives?.length)) {
    s = await waitForState(
      base,
      (st) =>
        [treeA1, treeA2, treeB1, treeB2].every((t) => {
          const row = (st.projects || []).flatMap((p) => p.worktrees || []).find((r) => norm(r.path) === norm(t));
          return Boolean(row && row.initiatives && row.initiatives.length);
        }),
      "the four rows carry their initiative chip",
    );
  }
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

test("the read is kept beside the store, so a restart answers before the join finishes", async () => {
  // The evidence join measured 25-52s on a loaded box, longer than the tab's 12s timeout: without a document on disk a
  // restarted panel cannot answer the tab at all. The cache is written beside the store on every build.
  await get("/api/initiatives");
  const file = path.join(path.dirname(initiativesFile), "initiatives-cache.json");
  assert.ok(existsSync(file), "the cache file is written beside the store");
  const raw = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(Array.isArray(raw.doc.initiatives), "the cached document is the tab's document");
  assert.ok(Number(raw.at) > 0, "and it carries when it was built");
});

// ---- row 297: the reader's order, and the archive --------------------------------------------------------------------
// A BOUNDED WAIT FOR THE BOARD, because the snapshot is rebuilt on the panel's own clock (a scan), not on this test's:
// the read below is retried until the row carries the overlay this test asks about, and a row that never gets there is
// a failure with the last answer in the sentence rather than a race.
async function rowWhen(treePath, predicate, why, timeout = 25_000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    const snapshot = (await get("/api/state")).json;
    last = snapshot.projects.flatMap((p) => p.worktrees || []).find((r) => normTreePath(r.path) === normTreePath(treePath)) || null;
    if (last && predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  assert.fail(`${why} (the row last read: ${JSON.stringify(last && last.initiatives)})`);
}

// THE ORDER IS A FIELD AND A SAVE PER PRESS. A reorder posts `to`, the 1-based place the card should end at, and the
// answer is the whole document the next GET would be - so a reload shows the same sequence. The proof also rewrites
// the file through a SECOND Initiatives instance: the panel re-reads the store when its stamp moves, and an order
// another writer set is the order the tab draws.
test("a reorder saves at once, numbers the record, survives a reload and another writer's rewrite", async () => {
  await setTier("none");
  const made = [];
  for (const title of ["Order Alpha", "Order Beta", "Order Gamma"]) {
    const r = await post(base, "/api/initiatives", { body: { title, description: `${title} is a card to move` } });
    assert.equal(r.status, 201, r.text);
    made.push(r.json.initiative.id);
  }
  const before = (await get("/api/initiatives")).json.initiatives;
  assert.deepEqual(before.map((i) => i.position), before.map((_, at) => at + 1), "the read is 1..n before anything moves");
  // The three fresh cards lead the list (a new initiative lands on top), in the reverse of the order they were made.
  assert.deepEqual(before.slice(0, 3).map((i) => i.id), made.slice().reverse());

  // MOVE THE THIRD CARD TO THE FRONT. One press, one write, and the answer is the list the next GET would give.
  const target = before[2].id;
  const moved = await post(base, "/api/initiatives/reorder", { body: { id: target, to: 1 } });
  assert.equal(moved.status, 200, moved.text);
  assert.equal(moved.json.changed, true);
  assert.equal(moved.json.asked, false, "a reorder never parks a question: the tier is about membership");
  assert.equal(moved.json.to, 1);
  const expected = [target, ...before.map((i) => i.id).filter((id) => id !== target)];
  assert.deepEqual(moved.json.order.map((o) => o.id), expected);
  assert.deepEqual(moved.json.order.map((o) => o.position), expected.map((_, at) => at + 1));
  assert.deepEqual(moved.json.initiatives.map((i) => i.id), expected, "the answer is the lane the next GET would answer");

  // THE STORE HOLDS IT: every record carries a number and the moved one carries who moved it.
  const doc = readStore();
  const orderById = new Map(doc.initiatives.map((i) => [i.id, i.order]));
  assert.deepEqual(expected.map((id) => orderById.get(id)), expected.map((_, at) => at + 1));
  assert.equal(doc.initiatives.find((i) => i.id === target).orderBy, "reader");

  // A RELOAD: the read the tab takes when it opens is the same sequence, from the file.
  const reloaded = (await get("/api/initiatives")).json.initiatives.map((i) => i.id);
  assert.deepEqual(reloaded, expected);

  // ANOTHER WRITER: a second store instance over the same file moves the first card to the third place. `?profile=1`
  // is the read that BUILDS rather than answering from the tab's two-second memo, and that memo is the only thing
  // between the file and the answer here: the tab's own poll picks the change up the same way on its next build.
  const other = new Initiatives({ file: initiativesFile, log: () => {} });
  const rewritten = other.reorder({ id: expected[0], to: 3, by: "assistant-9" });
  assert.equal(rewritten.ok, true, JSON.stringify(rewritten));
  const afterOther = (await get("/api/initiatives?profile=1")).json.initiatives.map((i) => i.id);
  assert.deepEqual(afterOther, [expected[1], expected[2], expected[0], ...expected.slice(3)]);

  // A PRESS THAT MOVES NOTHING WRITES NOTHING: the same place is `changed: false` and the bytes do not move.
  const bytes = readFileSync(initiativesFile, "utf8");
  const same = await post(base, "/api/initiatives/reorder", { body: { id: afterOther[0], to: 1 } });
  assert.equal(same.status, 200, same.text);
  assert.equal(same.json.changed, false);
  assert.equal(readFileSync(initiativesFile, "utf8"), bytes);

  // A REORDER WITHOUT `to` IS A REFUSAL, not a card dropped at the end.
  const bad = await post(base, "/api/initiatives/reorder", { body: { id: afterOther[0] } });
  assert.equal(bad.status, 400, bad.text);
  assert.match(bad.json.error, /1-based position/);
});

// THE ARCHIVE'S REFUSAL NAMES WHAT IS OPEN, and the liveness rule is the wave fold's own: a wave with a queued member
// reads open, the member is open, and both are named by id and title. Closing the member closes the wave (no exit gate
// closes on membership), and the SAME press then lands - with the trees, the wave and the task link still in place.
test("archiving is refused while a wave or a task under it is open, names them, and lands once they are closed", async () => {
  await setTier("none");
  const created = await post(base, "/api/initiatives", {
    body: { title: "Archive candidate", description: "this one has a kerfuffle in its description and nothing else" },
  });
  assert.equal(created.status, 201, created.text);
  const id = created.json.initiative.id;
  // An ACTIVE CONTROL on the same tree: the earlier tests' store was replaced by the repair test, so this file makes its
  // own initiative that stays active. It is what proves the chart overlay is live while the archived id is absent from
  // it, rather than the row simply carrying no overlay at all.
  const keeper = await post(base, "/api/initiatives", { body: { title: "Keeper initiative", description: "stays on the map" } });
  assert.equal(keeper.status, 201, keeper.text);
  const keeperId = keeper.json.initiative.id;
  const kept = await post(base, "/api/initiatives/move", { body: { tree: treeA1, initiative: keeperId, action: "add" } });
  assert.equal(kept.status, 200, kept.text);
  const position = (await get("/api/initiatives")).json.initiatives.find((i) => i.id === id).position;
  const attached = await post(base, "/api/initiatives/move", { body: { tree: treeA1, initiative: id, action: "add" } });
  assert.equal(attached.status, 200, attached.text);
  const wave = await post(base, "/api/waves", { body: { initiativeId: id, title: "The open wave" } });
  assert.equal(wave.status, 200, wave.text);
  const waveId = wave.json.wave.id;
  const task = await addTask(first.id, "hold the archive", treeA1, "project-a");
  const joined = await post(base, "/api/assistant/queue", { body: { assistantId: first.id, action: "edit", id: task.id, wave: waveId } });
  assert.equal(joined.status, 200, joined.text);

  const refused = await post(base, "/api/initiatives/archive", { body: { id } });
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.json.changed, false);
  assert.match(refused.json.error, /cannot be archived/);
  assert.match(refused.json.error, /still open/);
  const blocked = refused.json.blocked || [];
  assert.ok(
    blocked.some((b) => b.kind === "wave" && b.id === waveId && b.title === "The open wave"),
    `the wave is named by id and title: ${JSON.stringify(blocked)}`,
  );
  assert.ok(
    blocked.some((b) => b.kind === "task" && Number(b.id) === Number(task.id) && b.title === "hold the archive"),
    `the task is named by id and title: ${JSON.stringify(blocked)}`,
  );
  // Nothing was written: the record is still active and its tree is still attached.
  const refusedDoc = readStore();
  assert.equal(refusedDoc.initiatives.find((i) => i.id === id).archivedAt, null);
  assert.equal(refusedDoc.trees[normTreePath(treeA1)].initiatives.includes(id), true);

  // CLOSE THE MEMBER. The wave closes on membership, so the same press now lands.
  await setState(first.id, task.id, "done");
  const archived = await post(base, "/api/initiatives/archive", { body: { id } });
  assert.equal(archived.status, 200, archived.text);
  assert.equal(archived.json.changed, true);
  assert.equal(archived.json.initiatives.some((i) => i.id === id), false, "it left the active list");
  assert.equal(archived.json.archived.some((i) => i.id === id), true, "and it is in the archived one");
  assert.equal(archived.json.counts.active, archived.json.initiatives.length);
  assert.equal(archived.json.counts.archived, archived.json.archived.length);
  const archivedCard = archived.json.archived.find((i) => i.id === id);
  assert.match(archivedCard.description, /kerfuffle/, "the description travels, which is what the search reads");
  assert.equal(archivedCard.treeCount, 1, "archiving detached nothing");
  assert.equal(archivedCard.archivedBy, "reader");

  // AN ARCHIVED INITIATIVE IS ABSENT FROM EVERY COUNT. Three places, checked one by one:
  //   1. the tab's own document (the counts and both lists) - it is not in `initiatives` and not in `counts.active`;
  //   2. the store's index, which is THE map server.js `withInitiatives` and `rowExtras` overlay the chart column, the
  //      project table and every per-row frame from - the tree is still keyed there, and the archived id is not in it;
  //   3. the live board snapshot, polled until the overlay is there at all (the SSO initiative, which is NOT archived,
  //      is the control) and then asserted without the archived id.
  const otherStore = new Initiatives({ file: initiativesFile, log: () => {} });
  const overlay = otherStore.index().get(normTreePath(treeA1)) || [];
  assert.equal(overlay.some((i) => i.id === id), false, "the index the chart overlays from carries no archived chip");
  assert.equal(overlay.some((i) => i.id === keeperId), true, "and it still carries the active one");
  const treeRow = await rowWhen(
    treeA1,
    (row) => (row.initiatives || []).some((i) => i.id === keeperId) && !(row.initiatives || []).some((i) => i.id === id),
    "the board row never carried the overlay without the archived chip",
  );
  assert.equal((treeRow.initiatives || []).some((i) => i.id === id), false, "the archived initiative draws no chip");

  // ITS WORK IS STILL THERE WHILE IT IS AWAY: the tree record and the wave are untouched.
  const awayDoc = readStore();
  assert.equal(awayDoc.trees[normTreePath(treeA1)].initiatives.includes(id), true, "the tree is still attached");
  const awayWaves = await get(`/api/waves?initiative=${id}`);
  assert.equal(awayWaves.status, 200, awayWaves.text);
  assert.equal(awayWaves.json.waves.some((w) => w.id === waveId), true, "the wave is still in the store");

  // A REORDER OF AN ARCHIVED CARD IS REFUSED: it is not in the list the arrows move.
  const reorderAway = await post(base, "/api/initiatives/reorder", { body: { id, to: 1 } });
  assert.equal(reorderAway.status, 409, reorderAway.text);
  assert.match(reorderAway.json.error, /archived/);

  // RESTORE PUTS IT BACK AT ITS SAVED NUMBER, with everything it had.
  const restored = await post(base, "/api/initiatives/restore", { body: { id } });
  assert.equal(restored.status, 200, restored.text);
  assert.equal(restored.json.changed, true);
  assert.equal(restored.json.restored.position, position, "the place it was archived from");
  assert.equal(restored.json.initiatives[position - 1].id, id, "and the list reads that place");
  assert.equal(restored.json.archived.some((i) => i.id === id), false, "the archived list let it go");
  const back = restored.json.initiatives.find((i) => i.id === id);
  assert.equal(back.treeCount, 1, "its tree came back with it");
  assert.equal((back.waves || []).some((w) => w.id === waveId), true, "its wave came back with it");
  const taskRows = (back.assistants || []).flatMap((a) => a.taskRows || []);
  assert.equal(taskRows.some((t) => Number(t.id) === Number(task.id) && t.title === "hold the archive"), true, "its task link came back with it");
  const backSnapshot = await state();
  assert.ok(backSnapshot.projects.length > 0);
  const backRow = await rowWhen(
    treeA1,
    (row) => (row.initiatives || []).some((i) => i.id === keeperId) && (row.initiatives || []).some((i) => i.id === id),
    "the board row never carried the restored chip again",
  );
  assert.equal((backRow.initiatives || []).some((i) => i.id === id), true, "and the chart chip is back");
});
