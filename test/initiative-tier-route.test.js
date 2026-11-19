// The four levels, on the wire: the same action asked or not asked depending only on the setting.
//
// test/initiative-permissions.test.js pins the decision as a function; this file pins what the routes DO with it, over a
// real server and a real store:
//
//   * `all` asks about all four changes, `remove` only about a detach, `own` only about a tree somebody else attached,
//     and `none` about nothing - the same attach POST, four answers;
//   * a change that is not asked is still RECORDED: the history names the actor and the time at every level, which is
//     the half of the feature that makes an unasked write safe;
//   * the card itself never changes shape - same kind, same once/deny, same `grants: false` - so moving the level
//     changes how often the reader is interrupted, not what a change does;
//   * the level is read from the live config on every request, so a save applies to the next press rather than the
//     next boot, and an unknown value is refused rather than silently stored.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { git, post, startPanel, waitForState } from "../tools/panel-testkit.mjs";

const sandbox = mkdtempSync(path.join(tmpdir(), "wag-initiatives-tier-"));
const repos = path.join(sandbox, "repos");
mkdirSync(repos, { recursive: true });
after(() => rmSync(sandbox, { recursive: true, force: true }));

const projectDir = path.join(repos, "project-a");
mkdirSync(projectDir, { recursive: true });
git(projectDir, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(projectDir, "README.md"), "# project-a\n");
git(projectDir, ["add", "-A"]);
git(projectDir, ["commit", "-q", "-m", "first"]);
for (const tree of ["sso-one", "sso-two"]) {
  git(projectDir, ["worktree", "add", "-q", "-b", tree, path.join(projectDir, ".worktrees", tree)]);
}
const treeA = path.join(projectDir, ".worktrees", "sso-one");
const treeB = path.join(projectDir, ".worktrees", "sso-two");
const initiativesFile = path.join(sandbox, "logs", "initiatives.json");

const panel = await startPanel({ dir: sandbox, config: { initiativesFile } });
after(() => panel.stop());
const base = panel.base;
const get = async (p) => {
  const r = await fetch(`${base}${p}`);
  return { status: r.status, json: await r.json() };
};
const view = async () => (await get("/api/initiatives")).json;
const setTier = async (tier) => {
  const out = await post(base, "/api/settings/initiative-tier", { body: { tier } });
  assert.equal(out.status, 200, out.text);
  return out.json;
};
const pendingFor = async (id) => (await get("/api/state")).json.remoteWrites.pending.find((p) => p.id === id);
const answer = async (id, choice) => {
  const out = await post(base, "/api/remote-write/answer", { body: { id, choice } });
  assert.equal(out.status, 200, out.text);
  return out.json;
};

await waitForState(
  base,
  (s) => (s.projects.flatMap((p) => (p.worktrees || []).map((w) => w.path)) || []).filter((p) => /sso-(one|two)$/.test(p)).length === 2,
  "both worktrees are on the board",
  { timeout: 120_000 },
);

// A fresh initiative for a test, created while the level does not ask about creates (`none`), then the level is set
// where the test wants it. A create is the way to get an id that the rest of the test can attach to.
async function freshInitiative(title, tier) {
  await setTier("none");
  const made = await post(base, "/api/initiatives", { body: { title, description: "a piece of work" } });
  assert.equal(made.status, 201, made.text);
  const id = made.json.initiative.id;
  await setTier(tier);
  return id;
}

test("the read carries the four levels, and the default is the strictest", async () => {
  const out = await view();
  assert.equal(out.tier.id, "all", "an install with no setting asks about everything");
  assert.equal(out.tier.label, "ask me for everything");
  assert.deepEqual(
    out.tiers.map((t) => t.label),
    ["ask me for everything", "ask me only to remove things", "ask me only to remove trees I attached myself", "need no permission at all"],
    "one list of labels, drawn from the module",
  );
});

test("the settings route stores a level, refuses one it does not know, and the next request obeys", async () => {
  const bad = await post(base, "/api/settings/initiative-tier", { body: { tier: "sometimes" } });
  assert.equal(bad.status, 400, bad.text);
  assert.match(bad.json.error, /all/, "the refusal lists the values it accepts");

  const saved = await setTier("own");
  assert.equal(saved.tier.id, "own");
  // Written into the panel's config file, not just into memory: a restart has to come back to the same level.
  const cfg = JSON.parse(readFileSync(panel.configPath, "utf8"));
  assert.equal(cfg.initiativePermissions, "own");
  // The next read - a different request, a different store snapshot - already says `own`.
  assert.equal((await view()).tier.id, "own");
  // The state snapshot carries it too (under `settings`), so the settings select opens on the level the routes are
  // reading rather than on whatever this tab last saved.
  const state = (await get("/api/state")).json;
  assert.equal(state.settings.initiativeTier, "own");
  assert.equal(state.settings.initiativeTiers.length, 4);
});

test("at no permission, an attach is made at once and recorded with its actor", async () => {
  const id = await freshInitiative("Silent map", "none");
  const added = await post(base, "/api/initiatives/move", { body: { tree: treeA, initiative: id, action: "add", by: "scout" } });
  assert.equal(added.status, 200, added.text);
  assert.equal(added.json.asked, false);
  assert.equal(added.json.changed, true);
  assert.equal((await get("/api/state")).json.remoteWrites.pending.some((p) => p.kind === "initiative"), false, "no card at this level");

  // The change landed in the store AND in the history, with the assistant's id and the time.
  const init = (await view()).initiatives.find((i) => i.id === id);
  assert.equal(init.treeCount, 1);
  const attached = init.projects.flatMap((p) => p.trees).find((tr) => tr.name === "sso-one");
  assert.equal(attached.attachedBy, "scout", "the attachment names who made it");
  assert.ok(attached.attachedAt);
  const event = init.history[0];
  assert.equal(event.action, "attach");
  assert.equal(event.by, "scout");
  assert.ok(!Number.isNaN(Date.parse(event.at)), `the event carries a time: ${event.at}`);
  // The same change again is not a change, and says so rather than lying about it.
  const again = await post(base, "/api/initiatives/move", { body: { tree: treeA, initiative: id, action: "add", by: "scout" } });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.changed, false);
});

test("at ask-me-only-to-remove, the same attach is free and the detach asks - and the answer is recorded", async () => {
  const id = await freshInitiative("Remove only", "remove");
  const added = await post(base, "/api/initiatives/move", { body: { tree: treeB, initiative: id, action: "add", by: "reader" } });
  assert.equal(added.status, 200, added.text);
  assert.equal(added.json.changed, true);

  const asked = await post(base, "/api/initiatives/move", { body: { tree: treeB, initiative: id, action: "remove", by: "reader" } });
  assert.equal(asked.status, 202, asked.text);
  const pending = await pendingFor(asked.json.id);
  assert.ok(pending, "the question rides the snapshot");
  assert.equal(pending.kind, "initiative");
  assert.deepEqual(pending.allowed, ["once", "deny"]);
  assert.equal(pending.grants, false);
  assert.equal((await view()).initiatives.find((i) => i.id === id).treeCount, 1, "nothing moved until the answer");

  const yes = await answer(asked.json.id, "once");
  assert.equal(yes.resumed.changed, true);
  const after = (await view()).initiatives.find((i) => i.id === id);
  assert.equal(after.treeCount, 0);
  assert.equal(after.history[0].action, "detach");
  assert.equal(after.history[0].by, "reader");
});

test("at ask-me-only-what-I-attached, an assistant's removal of the reader's tree asks and its own does not", async () => {
  const id = await freshInitiative("Own trees only", "own");

  // The reader attaches: an assistant removing it is removing somebody else's tree, so that asks.
  const mine = await post(base, "/api/initiatives/move", { body: { tree: treeA, initiative: id, action: "add", by: "reader" } });
  assert.equal(mine.status, 200, mine.text);
  const asked = await post(base, "/api/initiatives/move", { body: { tree: treeA, initiative: id, action: "remove", by: "scout" } });
  assert.equal(asked.status, 202, asked.text, "the reader's tree is not the assistant's to take out silently");
  await answer(asked.json.id, "deny");
  assert.equal((await view()).initiatives.find((i) => i.id === id).treeCount, 1, "a deny leaves it where it was");

  // The assistant attaches its own tree and removes it: no question, because it is its own attachment.
  const its = await post(base, "/api/initiatives/move", { body: { tree: treeB, initiative: id, action: "add", by: "scout" } });
  assert.equal(its.status, 200, its.text, "attaching never asks at this level");
  const own = await post(base, "/api/initiatives/move", { body: { tree: treeB, initiative: id, action: "remove", by: "scout" } });
  assert.equal(own.status, 200, own.text);
  assert.equal(own.json.changed, true);
  // And the history has both the attach and the detach, by the assistant.
  const history = (await view()).initiatives.find((i) => i.id === id).history;
  assert.deepEqual(history.slice(0, 2).map((e) => `${e.action}:${e.by}`), ["detach:scout", "attach:scout"]);
  // The reader's own tree is still there, and the reader's own removal of it does not ask.
  assert.equal((await view()).initiatives.find((i) => i.id === id).treeCount, 1);
  const readerOut = await post(base, "/api/initiatives/move", { body: { tree: treeA, initiative: id, action: "remove", by: "reader" } });
  assert.equal(readerOut.status, 200, readerOut.text);
});

test("at ask-me-for-everything, a create asks and its answer creates - and an edit asks too", async () => {
  await setTier("all");
  const asked = await post(base, "/api/initiatives", { body: { title: "Asked into being", description: "the reader confirms", by: "scout" } });
  assert.equal(asked.status, 202, asked.text);
  const pending = await pendingFor(asked.json.id);
  assert.match(pending.title, /Create initiative "Asked into being"/);
  assert.match(pending.description, /scout is adding an initiative/);
  assert.equal(pending.grants, false);
  const before = (await view()).initiatives.length;
  await answer(asked.json.id, "once");
  const after = await view();
  assert.equal(after.initiatives.length, before + 1);
  const made = after.initiatives.find((i) => i.title === "Asked into being");
  assert.equal(made.history[0].action, "create");
  assert.equal(made.history[0].by, "scout");

  const edit = await post(base, "/api/initiatives/update", { body: { id: made.id, title: "Asked into being, again", by: "scout" } });
  assert.equal(edit.status, 202, edit.text);
  assert.match((await pendingFor(edit.json.id)).title, /Edit initiative "Asked into being"/, "the card names the initiative as it stands");
  await answer(edit.json.id, "deny");
  assert.equal((await view()).initiatives.find((i) => i.id === made.id).title, "Asked into being", "a deny edits nothing");
});

test("a tree attached under one level is judged by the record when the level changes", async () => {
  // The point of the record: the level can be relaxed or tightened later, and `own` still knows whose tree it is.
  const id = await freshInitiative("Changing level", "none");
  await post(base, "/api/initiatives/move", { body: { tree: treeA, initiative: id, action: "add", by: "scout" } });
  await setTier("own");
  const asked = await post(base, "/api/initiatives/move", { body: { tree: treeA, initiative: id, action: "remove", by: "reader" } });
  assert.equal(asked.status, 202, asked.text, "the reader removing the assistant's tree asks at `own`");
  await answer(asked.json.id, "once");
  assert.equal((await view()).initiatives.find((i) => i.id === id).treeCount, 0);
});
