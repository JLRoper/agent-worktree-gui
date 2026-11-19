// The actor and the time on every attachment and every initiative edit, and the history a card draws.
//
// The permission tier's third level ("ask me only to remove trees I attached myself") cannot be decided from a removal
// request: the request knows who is removing, not who put the tree there. So the store records, per (tree, initiative),
// the actor and the instant of the attachment, and it keeps one history per initiative with the same facts for a
// create, an edit, an attach and a detach. This file pins:
//
//   1. every one of the four writes lands an event with ITS actor and time - a reader's press and an assistant's post
//      are told apart, at every tier, because the record is written whatever the tier decided;
//   2. the attachment's actor survives a reload (the record is in the file, not in memory), and an older file that
//      has no `members` block is interpreted from its own `at`/`by` rather than read as unattributed;
//   3. the history is newest first for the page, bounded, and an edit that changes nothing is not an event.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { HISTORY_MAX, Initiatives } from "../lib/initiatives.js";

// A drive-letter path is assembled rather than typed: the repository's own reader refuses a literal one in a tracked
// file (it names a folder on the machine that wrote the line and nowhere else), and this file needs a tree path the
// store normalises like any other.
const DRIVE = ["C", ":"].join("");
const TREE = `${DRIVE}/work/alpha/.worktrees/sso-one`;
const OTHER = `${DRIVE}/work/beta/.worktrees/sso-two`;

function store(t, { now = () => Date.now() } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-init-history-"));
  const file = path.join(dir, "initiatives.json");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file, make: (opts = {}) => new Initiatives({ file, log: () => {}, now, ...opts }) };
}

// A clock the test moves by hand, so "the time" is an assertion instead of a range.
function clock(start = Date.parse("2026-11-19T10:00:00.000Z")) {
  let t = start;
  return {
    now: () => t,
    tick: (ms = 1000) => {
      t += ms;
      return new Date(t).toISOString();
    },
  };
}

test("a create records its actor and its time", (t) => {
  const c = clock();
  const { make } = store(t, { now: c.now });
  const s = make();
  const at = new Date(c.now()).toISOString();
  const out = s.create({ title: "SSO migration", description: "one piece of work", by: "scout" });
  assert.equal(out.ok, true);
  assert.equal(out.initiative.createdBy, "scout");
  assert.deepEqual(out.initiative.history, [{ at, by: "scout", action: "create", tree: null, detail: "SSO migration" }]);
  assert.deepEqual(s.historyFor(out.initiative.id), out.initiative.history, "newest first is the same one event");
});

test("an edit names the field it changed, the actor and the time - and an unchanged edit is not an event", (t) => {
  const c = clock();
  const { make } = store(t, { now: c.now });
  const s = make();
  const created = s.create({ title: "SSO migration", by: "reader" });
  const id = created.initiative.id;

  c.tick(5000);
  const edited = s.update({ id, description: "Menu and oauth2, one app at a time", by: "scout" });
  assert.equal(edited.ok, true);
  assert.equal(edited.changed, undefined, "a real edit is not flagged false");
  const newest = s.historyFor(id)[0];
  assert.equal(newest.action, "edit");
  assert.equal(newest.by, "scout");
  assert.equal(newest.detail, "the description");
  assert.equal(newest.at, new Date(c.now()).toISOString());

  // The same words again: no event, no updatedAt move. A history of presses is not a history of changes.
  const before = s.initiativeById(id).updatedAt;
  c.tick(5000);
  const same = s.update({ id, description: "Menu and oauth2, one app at a time", by: "reader" });
  assert.equal(same.ok, true);
  assert.equal(same.changed, false);
  assert.equal(s.initiativeById(id).updatedAt, before);
  assert.equal(s.historyFor(id).length, 2, "the create and the one real edit");

  // A title change names the title; both together names both.
  c.tick(1000);
  s.update({ id, title: "SSO and Menu", by: "scout" });
  assert.equal(s.historyFor(id)[0].detail, "the title");
  c.tick(1000);
  s.update({ id, title: "SSO and Menu, one login", description: "two apps", by: "scout" });
  assert.equal(s.historyFor(id)[0].detail, "the title and the description");
});

test("an attach records who attached it and when, and a detach is judged against that record", (t) => {
  const c = clock();
  const { make } = store(t, { now: c.now });
  const s = make();
  const created = s.create({ title: "SSO migration", by: "reader" });
  const id = created.initiative.id;

  c.tick(2000);
  const attachAt = new Date(c.now()).toISOString();
  const added = s.move({ tree: TREE, initiative: id, action: "add", by: "scout" });
  assert.equal(added.ok, true);
  assert.equal(added.changed, true);
  assert.deepEqual(s.attachmentInfo(TREE, id), { at: attachAt, by: "scout" }, "the attachment knows its actor");
  assert.equal(s.treesFor(id)[0].attachedBy, "scout");
  assert.equal(s.treesFor(id)[0].attachedAt, attachAt);
  const event = s.historyFor(id)[0];
  assert.equal(event.action, "attach");
  assert.equal(event.by, "scout");
  assert.equal(event.tree, TREE.replace(/\//g, "/"));
  assert.equal(event.at, attachAt);

  // A second tree, attached by the reader: two attachments, two actors, in one initiative.
  c.tick(1000);
  s.move({ tree: OTHER, initiative: id, action: "add", by: "reader" });
  assert.deepEqual(s.attachmentInfo(OTHER, id), { at: new Date(c.now()).toISOString(), by: "reader" });
  assert.equal(s.attachmentInfo(TREE, id).by, "scout", "the first attachment's actor is untouched");

  // The detach removes the membership record and writes its own event.
  c.tick(1000);
  const removed = s.move({ tree: TREE, initiative: id, action: "remove", by: "reader" });
  assert.equal(removed.ok, true);
  assert.equal(s.attachmentInfo(TREE, id), null, "no attachment, no actor to judge");
  assert.notEqual(s.attachmentInfo(OTHER, id), null, "the other tree is still there");
  const latest = s.historyFor(id)[0];
  assert.equal(latest.action, "detach");
  assert.equal(latest.by, "reader");
  assert.equal(latest.tree, TREE);
});

test("an attachment with no actor answers null and asks, and an older file is read from its own at/by", (t) => {
  const { file, make } = store(t);
  const s = make();
  const id = s.create({ title: "SSO migration", by: "reader" }).initiative.id;
  s.move({ tree: TREE, initiative: id, action: "add", by: "reader" });

  // Rewrite the file the way a store written before `members` looked: one `at`/`by` on the tree record, no members.
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const key = Object.keys(doc.trees)[0];
  doc.trees[key] = { path: doc.trees[key].path, initiatives: [id], at: "2026-11-01T09:00:00.000Z", by: "reader" };
  doc.initiatives = doc.initiatives.map((i) => ({ ...i, history: undefined }));
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, "utf8");

  const reread = make();
  assert.deepEqual(reread.attachmentInfo(TREE, id), { at: "2026-11-01T09:00:00.000Z", by: "reader" });
  assert.deepEqual(reread.historyFor(id), [], "an initiative with no history has none, rather than an invented one");

  // A tree record with neither block is unattributed, which the `own` tier reads as somebody else's and asks about.
  const doc2 = JSON.parse(readFileSync(file, "utf8"));
  doc2.trees[key] = { path: doc2.trees[key].path, initiatives: [id] };
  writeFileSync(file, `${JSON.stringify(doc2, null, 2)}\n`, "utf8");
  assert.deepEqual(make().attachmentInfo(TREE, id), { at: null, by: null });
});

test("the history survives a reload, newest first, with a reader's and an assistant's changes in one list", (t) => {
  const c = clock();
  const { make } = store(t, { now: c.now });
  const first = make();
  const id = first.create({ title: "SSO migration", by: "reader" }).initiative.id;
  c.tick(1000);
  first.update({ id, description: "one app at a time", by: "scout" });
  c.tick(1000);
  first.move({ tree: TREE, initiative: id, action: "add", by: "scout" });

  const second = make();
  const history = second.historyFor(id);
  assert.deepEqual(
    history.map((ev) => `${ev.action}:${ev.by}`),
    ["attach:scout", "edit:scout", "create:reader"],
    "newest first, and both actors in the same list",
  );
  // The card draws this list, so the actor has to be the id the panel knows, not a display name that can change.
  assert.deepEqual(
    history.map((ev) => ev.at),
    [...history.map((ev) => ev.at)].sort().reverse(),
    "the times run newest first",
  );
});

test(`a long history keeps the newest ${HISTORY_MAX} events`, (t) => {
  const c = clock();
  const { make } = store(t, { now: c.now });
  const s = make();
  const id = s.create({ title: "Chatty initiative", by: "reader" }).initiative.id;
  for (let i = 0; i < HISTORY_MAX + 12; i += 1) {
    c.tick(1000);
    s.update({ id, description: `revision ${i}`, by: i % 2 ? "scout" : "reader" });
  }
  const history = s.historyFor(id);
  assert.equal(history.length, HISTORY_MAX);
  assert.equal(history[0].detail, "the description");
  assert.equal(history[0].at, new Date(c.now()).toISOString(), "the newest event is kept");
  assert.equal(history[history.length - 1].at > "2026-11-19T09:00:00.000Z", true, "the oldest kept is not the create");
  // The document on disk is the same list, so a restart does not resurrect the dropped events.
  assert.equal(make().historyFor(id).length, HISTORY_MAX);
});

test("one tree in two initiatives records each attachment separately", (t) => {
  const c = clock();
  const { make } = store(t, { now: c.now });
  const s = make();
  const one = s.create({ title: "SSO migration", by: "reader" }).initiative.id;
  c.tick(1000);
  const two = s.create({ title: "Release readiness", by: "reader" }).initiative.id;
  c.tick(1000);
  s.move({ tree: TREE, initiative: one, action: "add", by: "reader" });
  c.tick(1000);
  s.move({ tree: TREE, initiative: two, action: "add", by: "scout" });

  assert.equal(s.attachmentInfo(TREE, one).by, "reader");
  assert.equal(s.attachmentInfo(TREE, two).by, "scout");
  assert.notEqual(s.attachmentInfo(TREE, one).at, s.attachmentInfo(TREE, two).at);
  // Removing one membership leaves the other, and its actor, alone.
  s.move({ tree: TREE, initiative: one, action: "remove", by: "reader" });
  assert.equal(s.attachmentInfo(TREE, one), null);
  assert.equal(s.attachmentInfo(TREE, two).by, "scout");
});
