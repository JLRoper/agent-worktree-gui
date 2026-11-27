// The board's tag registry (lib/initiative-tags.js) and the two stores' join: one vocabulary, ids on the cards.
//
// What this file pins, as behaviour rather than prose:
//
//   1. A TAG IS A RECORD WITH SIX FIELDS, and the id and `createdAt` are the PANEL's - a caller that posts them is
//      ignored, exactly as an initiative's stamps are. The ident is unique CASE-INSENSITIVELY, so "SSO" and "sso"
//      cannot both exist and a filter cannot silently mean two tags.
//   2. THE CAPS REFUSE, THEY DO NOT TRUNCATE. An ident outside 2-6 letters or digits, a name past 40, a description
//      past 200 and a colour outside the ten names all answer `{ ok: false }` with the rule and the size given. A chip
//      that silently lost the tail of its name is a tag the reader cannot find again.
//   3. AN UNREADABLE REGISTRY IS REFUSED, NEVER OVERWRITTEN - the initiative store's own rule, byte for byte.
//   4. AN INITIATIVE CARRIES IDS, NEVER WORDS. A rename edits the one registry entry and every card follows because
//      no card held the words; an unknown id is refused BY NAME where the write happens.
//   5. DELETE IS TWO-STEP. A carried tag refuses with the COUNT and the titles, and a confirmed delete takes the id off
//      every initiative in one save (dropTag) - archived cards included, because Restore returns them as they were.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Initiatives } from "../lib/initiatives.js";
import {
  DEFAULT_TAG_COLOR,
  InitiativeTags,
  TAG_COLOR_IDS,
  TAG_DESCRIPTION_MAX,
  TAG_IDENT_MAX,
  TAG_NAME_MAX,
  TAG_PALETTE,
  tagsView,
  validateTag,
} from "../lib/initiative-tags.js";

function store(t, name = "state") {
  const dir = mkdtempSync(path.join(tmpdir(), `wtgui-initiative-tags-${name}-`));
  const tagsFile = path.join(dir, "initiative-tags.json");
  const initiativesFile = path.join(dir, "initiatives.json");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const make = () => {
    const tags = new InitiativeTags({ file: tagsFile, log: () => {} });
    const initiatives = new Initiatives({ file: initiativesFile, log: () => {}, tags });
    return { tags, initiatives };
  };
  return { dir, tagsFile, initiativesFile, make };
}

const tagPayload = { ident: "SSO", name: "single sign-on migration", description: "Menu and oauth2", color: "violet" };

test("a missing registry is an empty vocabulary, and the first tag lands with the panel's id and clock", (t) => {
  const { tagsFile, make } = store(t);
  const { tags } = make();
  assert.equal(tags.statusOf().found, false);
  assert.equal(tags.statusOf().readable, true);
  assert.deepEqual(tags.list(), []);

  const made = tags.create({ ...tagPayload, id: "tag_from_the_caller", createdAt: "1999-01-01T00:00:00.000Z" });
  assert.equal(made.ok, true);
  assert.match(made.tag.id, /^tag_/);
  assert.notEqual(made.tag.id, "tag_from_the_caller", "the id is the panel's, never the caller's");
  assert.notEqual(made.tag.createdAt, "1999-01-01T00:00:00.000Z", "createdAt is server-set");
  assert.match(made.tag.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(made.tag.ident, "SSO", "the ident keeps the case the reader typed");
  assert.equal(made.tag.color, "violet");
  assert.deepEqual(Object.keys(made.tag).sort(), ["color", "createdAt", "description", "id", "ident", "name"]);
  assert.equal(existsSync(tagsFile), true);
});

test("a second instance over the same file reads back what the first wrote", (t) => {
  const { make } = store(t);
  const first = make().tags;
  const made = first.create(tagPayload);
  assert.equal(made.ok, true);
  const second = make().tags;
  assert.deepEqual(second.list(), first.list());
  const raw = JSON.parse(readFileSync(second.file, "utf8"));
  assert.equal(raw.version, 1);
  assert.equal(raw.tags.length, 1);
  assert.equal(typeof raw.savedAt, "string");
});

test("the ident is unique whatever the case, and the refusal names the tag that holds it", (t) => {
  const { make } = store(t);
  const { tags } = make();
  assert.equal(tags.create(tagPayload).ok, true);
  const clash = tags.create({ ...tagPayload, ident: "sso", name: "another word for it" });
  assert.equal(clash.ok, false);
  assert.equal(clash.duplicate, true);
  assert.match(clash.error, /already uses the ident "SSO"/);
  assert.match(clash.error, /case/);
  assert.equal(tags.list().length, 1);
  // A rename onto the same ident, in the same case, is not a clash with itself.
  const own = tags.rename({ id: tags.list()[0].id, name: "single sign-on" });
  assert.equal(own.ok, true);
  assert.equal(own.changed, true);
});

test("the caps refuse rather than truncate, and each refusal names the rule and the size", (t) => {
  const { make } = store(t);
  const { tags } = make();
  const badIdent = tags.create({ ident: "s", name: "too short" });
  assert.equal(badIdent.ok, false);
  assert.equal(badIdent.field, "ident");
  assert.match(badIdent.error, /is 1 character/);

  const longIdent = tags.create({ ident: "abcdefg", name: "too long" });
  assert.equal(longIdent.ok, false);
  assert.match(longIdent.error, new RegExp(`is ${TAG_IDENT_MAX + 1} characters`));

  const punctuation = tags.create({ ident: "s-s", name: "a hyphen is not a letter" });
  assert.equal(punctuation.ok, false);
  assert.match(punctuation.error, /A-Z, a-z or 0-9/);

  const noName = tags.create({ ident: "sso" });
  assert.equal(noName.ok, false);
  assert.match(noName.error, /needs a name/);

  const longName = tags.create({ ident: "sso", name: "x".repeat(TAG_NAME_MAX + 1) });
  assert.equal(longName.ok, false);
  assert.match(longName.error, new RegExp(`at most ${TAG_NAME_MAX} characters - this one is ${TAG_NAME_MAX + 1}`));

  const longDesc = tags.create({ ident: "sso", name: "single sign-on", description: "y".repeat(TAG_DESCRIPTION_MAX + 1) });
  assert.equal(longDesc.ok, false);
  assert.match(longDesc.error, new RegExp(`at most ${TAG_DESCRIPTION_MAX}`));

  const color = tags.create({ ident: "sso", name: "single sign-on", color: "chartreuse" });
  assert.equal(color.ok, false);
  assert.match(color.error, /one of/);
  assert.match(color.error, /chartreuse/);
  for (const name of TAG_COLOR_IDS) assert.match(color.error, new RegExp(name));

  // Nothing above wrote a record, and nothing above was truncated: the store is still empty.
  assert.deepEqual(tags.list(), []);
});

test("the colour defaults to the palette's first name, and only the ten names are colours", (t) => {
  const { make } = store(t);
  const { tags } = make();
  const made = tags.create({ ident: "DMR", name: "DMR tickets" });
  assert.equal(made.ok, true);
  assert.equal(made.tag.color, DEFAULT_TAG_COLOR);
  assert.equal(TAG_PALETTE.length, 10);
  assert.deepEqual(TAG_PALETTE.map((c) => c.id), TAG_COLOR_IDS.slice());
  assert.equal(validateTag({ ident: "DMR", name: "x", color: "VIOLET" }).tag.color, "violet", "a colour name is read case-insensitively");
});

test("an unreadable registry is refused, with the file named, and the bytes are left alone", (t) => {
  const { tagsFile, make } = store(t);
  writeFileSync(tagsFile, "{ this is not json", "utf8");
  const before = readFileSync(tagsFile, "utf8");
  const { tags } = make();
  const status = tags.statusOf();
  assert.equal(status.found, true);
  assert.equal(status.readable, false);
  assert.match(status.error, /json/i);

  for (const out of [
    tags.create(tagPayload),
    tags.rename({ id: "tag_anything", name: "new" }),
    tags.remove({ id: "tag_anything" }),
  ]) {
    assert.equal(out.ok, false);
    assert.equal(out.refused, "unreadable");
    assert.match(out.error, /NOT overwritten/);
    assert.equal(out.file, tagsFile);
  }
  assert.equal(readFileSync(tagsFile, "utf8"), before, "the corrupt bytes are exactly where the reader left them");
});

test("a hand-edited file is read forgivingly: a dropped colour falls back, a record without an ident is dropped", (t) => {
  const { tagsFile, make } = store(t);
  mkdirSync(path.dirname(tagsFile), { recursive: true });
  writeFileSync(
    tagsFile,
    JSON.stringify({
      tags: [
        { id: "tag_one", ident: "SSO", name: "single sign-on", description: 42, color: "not-a-colour", createdAt: "2026-11-01T00:00:00.000Z" },
        { id: "tag_two", name: "no ident, no chip" },
        { ident: "ID", name: "no id either" },
      ],
    }),
    "utf8",
  );
  const { tags } = make();
  const list = tags.list();
  assert.equal(list.length, 1, "only the record with an id, an ident and a name survives");
  assert.equal(list[0].color, DEFAULT_TAG_COLOR, "an unknown colour paints the palette's first name");
  assert.equal(list[0].description, "42", "a non-string description is read as text rather than painted as an object");
});

test("an initiative carries ids, an absent tagIds is none, and an unknown id is refused by name", (t) => {
  const { make } = store(t);
  const { tags, initiatives } = make();
  const sso = tags.create(tagPayload).tag;
  const dmr = tags.create({ ident: "DMR", name: "DMR tickets", color: "sky" }).tag;

  const made = initiatives.create({ title: "SSO migration", tagIds: [sso.id, dmr.id, sso.id] });
  assert.equal(made.ok, true);
  assert.deepEqual(made.initiative.tagIds, [sso.id, dmr.id], "deduped, in the order applied");

  const unknown = initiatives.create({ title: "no such tag", tagIds: ["tag_does_not_exist"] });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "unknown-tag");
  assert.match(unknown.error, /no such tag: tag_does_not_exist/);

  // An initiative written before tags existed has no field at all: it reads as none, and the edit that says nothing
  // about tags leaves whatever it has alone.
  const legacy = JSON.parse(readFileSync(initiatives.file, "utf8"));
  delete legacy.initiatives[0].tagIds;
  writeFileSync(initiatives.file, JSON.stringify(legacy), "utf8");
  assert.deepEqual(initiatives.initiativeById(made.initiative.id).tagIds, []);

  const kept = initiatives.update({ id: made.initiative.id, title: "SSO migration, renamed" });
  assert.equal(kept.ok, true);
  assert.deepEqual(kept.initiative.tagIds, [], "an edit of the words does not invent tags");
});

test("a rename edits the one entry, so every card and every saved filter follows", (t) => {
  const { make } = store(t);
  const { tags, initiatives } = make();
  const sso = tags.create(tagPayload).tag;
  const made = initiatives.create({ title: "SSO migration", tagIds: [sso.id] });
  assert.equal(made.ok, true);

  const renamed = tags.rename({ id: sso.id, ident: "okta", name: "Okta sign-in", color: "teal" });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.tag.id, sso.id, "the id is stable: nothing that points at it has to move");
  assert.equal(renamed.tag.ident, "okta");
  assert.equal(renamed.tag.name, "Okta sign-in");
  assert.equal(renamed.tag.createdAt, sso.createdAt, "a rename does not restamp the creation");
  assert.deepEqual(renamed.fields, ["ident", "name", "color"]);

  // The card still holds the id, and the registry is what gives it the new words: that is the whole mechanism.
  const card = initiatives.initiativeById(made.initiative.id);
  assert.deepEqual(card.tagIds, [sso.id]);
  assert.equal(tags.byId(sso.id).ident, "okta");

  const nothing = tags.rename({ id: sso.id, ident: "okta", name: "Okta sign-in" });
  assert.equal(nothing.ok, true);
  assert.equal(nothing.changed, false);
  const absent = tags.rename({ id: "tag_nope", name: "x" });
  assert.equal(absent.notFound, true);
});

test("delete refuses while a card carries the tag, names the count, and the confirm takes it off every card", (t) => {
  const { make } = store(t);
  const { tags, initiatives } = make();
  const sso = tags.create(tagPayload).tag;
  const dmr = tags.create({ ident: "DMR", name: "DMR tickets" }).tag;
  const one = initiatives.create({ title: "SSO migration", tagIds: [sso.id, dmr.id] });
  const two = initiatives.create({ title: "Okta rollout", tagIds: [sso.id] });
  const archived = initiatives.create({ title: "put away but still tagged", tagIds: [sso.id] });
  assert.equal(initiatives.archive({ id: archived.initiative.id }).ok, true);

  const carried = initiatives.carriersOfTag(sso.id);
  assert.equal(carried.length, 3, "archived cards carry tags too");
  assert.deepEqual(carried.map((c) => c.title).sort(), ["Okta rollout", "SSO migration", "put away but still tagged"]);

  const refused = tags.remove({ id: sso.id, carried });
  assert.equal(refused.ok, false);
  assert.equal(refused.refused, "carried");
  assert.equal(refused.carried, 3);
  assert.match(refused.error, /is on 3 initiatives/);
  assert.match(refused.error, /confirm/);
  assert.equal(tags.byId(sso.id)?.ident, "SSO", "the refusal changed nothing");
  assert.equal(initiatives.initiativeById(one.initiative.id).tagIds.length, 2);

  // The route composes these two: drop the id off every initiative, then drop the entry.
  const dropped = initiatives.dropTag({ id: sso.id });
  assert.equal(dropped.ok, true);
  assert.equal(dropped.removed, 3);
  for (const id of [one.initiative.id, two.initiative.id, archived.initiative.id]) {
    assert.deepEqual(initiatives.initiativeById(id).tagIds.includes(sso.id), false, `${id} no longer carries the deleted tag`);
  }
  assert.deepEqual(initiatives.initiativeById(one.initiative.id).tagIds, [dmr.id], "the other tag is untouched");

  const deleted = tags.remove({ id: sso.id, confirm: true, carried });
  assert.equal(deleted.ok, true);
  assert.equal(deleted.deleted.ident, "SSO");
  assert.deepEqual(tags.list().map((x) => x.ident), ["DMR"]);
  assert.equal(tags.remove({ id: sso.id }).notFound, true);
});

test("a tag nothing carries deletes on the first press", (t) => {
  const { make } = store(t);
  const { tags } = make();
  const loose = tags.create({ ident: "LOST", name: "not applied anywhere" }).tag;
  const out = tags.remove({ id: loose.id });
  assert.equal(out.ok, true);
  assert.equal(out.carried, 0);
  assert.deepEqual(tags.list(), []);
});

test("the registry's view carries the palette and the caps the form prints", (t) => {
  const { make } = store(t);
  const { tags } = make();
  tags.create(tagPayload);
  const view = tagsView(tags);
  assert.equal(view.tags.length, 1);
  assert.equal(view.palette.length, 10);
  assert.equal(view.caps.identMin, 2);
  assert.equal(view.caps.identMax, 6);
  assert.equal(view.caps.name, 40);
  assert.equal(view.caps.description, 200);
  assert.deepEqual(view.caps.colors, TAG_COLOR_IDS.slice());
  assert.equal(view.identRule, "^[A-Za-z0-9]{2,6}$");
  assert.equal(view.readable, true);
});
