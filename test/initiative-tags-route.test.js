// The tag registry's wire half, over a real panel in a sandbox: the four verbs, the reader-only writes, and the join
// with the initiative routes.
//
// What this file really pins:
//
//   * GET /api/initiatives/tags ANSWERS THE VOCABULARY, and the same registry rides GET /api/initiatives (`tags`), so
//     the tab needs one read to draw its filter row and its cards.
//   * THE THREE WRITES ARE THE READER'S ALONE. The page sends no `by` and means the reader; an assistant that sends its
//     own id is refused 403 on POST/PATCH/DELETE, and it may still APPLY an existing tag through the initiative
//     update route - the half it is allowed.
//   * AN UNKNOWN TAG ID IS REFUSED BY NAME where the initiative is written, not dropped. A card that silently lost a
//     tag is worse than a 400 that says which id is not a tag.
//   * DELETE IS TWO-STEP AND THE REFUSAL NAMES THE COUNT. Unconfirmed on a carried tag: 409, `carried`, and the
//     sentence names the number; the initiative store is byte-identical. Confirmed: the id leaves every card in one
//     save and the entry goes.
//   * AN UNREADABLE REGISTRY IS A 409 AND THE BYTES STAY. The route reads the store's own sentence before writing.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { boot, stopBootedPanels } from "../tools/panel-testkit.mjs";

// One file-level hook, registered once and never per test: boot()'s registry, swept after the last test.
after(stopBootedPanels);

const sandbox = mkdtempSync(path.join(tmpdir(), "wag-initiative-tags-route-"));
after(() => rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));

const initiativesFile = path.join(sandbox, "logs", "initiatives.json");
const tagsFile = path.join(sandbox, "logs", "initiative-tags.json");
const tagsPath = "/api/initiatives/tags";

const panel = await boot({ dir: sandbox, config: { initiativesFile, initiativeTagsFile: tagsFile } });
after(() => panel.stop());
const base = panel.base;

const get = async (p) => {
  const r = await fetch(`${base}${p}`);
  return { status: r.status, json: await r.json() };
};
// PATCH and DELETE have no helper in the testkit (its `post` is POST-only, which is the point of writing these).
const send = async (method, route, body) => {
  const r = await fetch(`${base}${route}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* a refusal that is not JSON still carries a status the test can assert */
  }
  return { status: r.status, json, text };
};
const bytes = (p) => readFileSync(p, "utf8");
const doc = async () => (await get("/api/initiatives")).json;

// THE TIER IS NAMED RATHER THAN INHERITED. `all` (the default) parks a question in the dock for every create and edit,
// and a test about the wire shape of a tag write must not be a test about the dock. `none` makes every change at once
// and still records it, which is the shape these assertions read; test/initiative-tier-route.test.js owns the levels.
const setTier = async (tier) => {
  const out = await send("POST", "/api/settings/initiative-tier", { tier });
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.tier.id, tier);
};
await setTier("none");

let ssoId = "";

test("the registry starts empty, and says which file it would write", async () => {
  const out = await get(tagsPath);
  assert.equal(out.status, 200);
  assert.equal(out.json.ok, true);
  assert.equal(out.json.file, tagsFile);
  assert.equal(out.json.readable, true);
  assert.equal(out.json.found, false);
  assert.deepEqual(out.json.tags, []);
  assert.equal(out.json.palette.length, 10);
  assert.equal(out.json.caps.identMin, 2);
});

test("the reader creates a tag: 201, the panel's id and clock, and the registry rides the initiatives read", async () => {
  const out = await send("POST", tagsPath, { ident: "SSO", name: "single sign-on migration", description: "Menu and oauth2", color: "violet" });
  assert.equal(out.status, 201, out.text);
  assert.equal(out.json.ok, true);
  assert.equal(out.json.changed, true);
  assert.match(out.json.tag.id, /^tag_/);
  assert.equal(out.json.tag.ident, "SSO");
  assert.equal(out.json.tag.color, "violet");
  assert.match(out.json.tag.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(out.json.registry.tags.length, 1);
  ssoId = out.json.tag.id;

  const read = await doc();
  assert.equal(read.readable, true);
  assert.equal(read.tags.readable, true);
  assert.deepEqual(read.tags.tags, out.json.registry.tags, "the same registry arrives with the tab's own read");
  assert.deepEqual(read.caps.tagIdentMin, 2);
  assert.equal(read.caps.tagName, 40);
});

test("a duplicate ident is refused whatever the case, and a bad ident is refused with its rule", async () => {
  const dup = await send("POST", tagsPath, { ident: "sso", name: "the same tag, other case" });
  assert.equal(dup.status, 400, dup.text);
  assert.match(dup.json.error, /already uses the ident "SSO"/);

  const short = await send("POST", tagsPath, { ident: "s", name: "too short" });
  assert.equal(short.status, 400);
  assert.match(short.json.error, /2 to 6 letters or digits/);

  const longName = await send("POST", tagsPath, { ident: "LONG", name: "x".repeat(41) });
  assert.equal(longName.status, 400);
  assert.match(longName.json.error, /at most 40 characters/);

  const color = await send("POST", tagsPath, { ident: "PAINT", name: "a colour outside the palette", color: "chartreuse" });
  assert.equal(color.status, 400);
  assert.match(color.json.error, /chartreuse/);

  assert.equal((await get(tagsPath)).json.tags.length, 1, "no refusal wrote a record");
});

test("an initiative is created with tagIds, and an unknown id is refused by name", async () => {
  const made = await send("POST", "/api/initiatives", { title: "SSO migration", description: "one piece of work", tagIds: [ssoId] });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.json.ok, true);
  const card = made.json.initiatives.find((i) => i.title === "SSO migration");
  assert.ok(card, "the answer carries the folded card");
  assert.deepEqual(card.tagIds, [ssoId], "the card holds the id, never the words");

  const unknown = await send("POST", "/api/initiatives", { title: "no such tag", tagIds: ["tag_not_real"] });
  assert.equal(unknown.status, 400, unknown.text);
  assert.match(unknown.json.error, /no such tag: tag_not_real/);
});

test("an assistant may apply an existing tag but may not mint, rename or delete one", async () => {
  const renamed = await send("PATCH", tagsPath, { id: ssoId, ident: "okta", by: "assistant-3" });
  assert.equal(renamed.status, 403, renamed.text);
  assert.match(renamed.json.error, /reader's to create, rename and delete/);

  const created = await send("POST", tagsPath, { ident: "NEW", name: "an assistant's own tag", by: "assistant-3" });
  assert.equal(created.status, 403);

  const deleted = await send("DELETE", tagsPath, { id: ssoId, by: "assistant-3" });
  assert.equal(deleted.status, 403);

  // The half it may do: apply an existing id with an edit of the card.
  const card = (await doc()).initiatives.find((i) => i.title === "SSO migration");
  const applied = await send("POST", "/api/initiatives/update", { id: card.id, tagIds: [], by: "assistant-3" });
  assert.equal(applied.status, 200, applied.text);
  assert.deepEqual(applied.json.initiative.tagIds, [], "an assistant cleared the tags it was allowed to change");
  const restored = await send("POST", "/api/initiatives/update", { id: card.id, tagIds: [ssoId], by: "assistant-3" });
  assert.equal(restored.status, 200);
  assert.deepEqual(restored.json.initiative.tagIds, [ssoId]);
  assert.equal((await get(tagsPath)).json.tags.length, 1, "none of the read-only presses changed the registry");
});

test("a rename edits the one entry: the card keeps its id and the registry supplies the new words", async () => {
  const out = await send("PATCH", tagsPath, { id: ssoId, ident: "okta", name: "Okta sign-in", color: "teal" });
  assert.equal(out.status, 200, out.text);
  assert.equal(out.json.changed, true);
  assert.deepEqual(out.json.fields, ["ident", "name", "color"]);
  assert.equal(out.json.tag.id, ssoId);
  assert.equal(out.json.tag.ident, "okta");
  assert.equal(out.json.registry.tags[0].ident, "okta");

  const read = await doc();
  const card = read.initiatives.find((i) => i.title === "SSO migration");
  assert.deepEqual(card.tagIds, [ssoId], "every card follows a rename because the card holds an id");
  assert.equal(read.tags.tags.find((t) => t.id === ssoId).name, "Okta sign-in");

  const missing = await send("PATCH", tagsPath, { id: "tag_nope", name: "x" });
  assert.equal(missing.status, 404);
});

test("delete refuses while a card carries the tag, names the count, and the confirm takes it off every card", async () => {
  const before = bytes(initiativesFile);
  const refused = await send("DELETE", tagsPath, { id: ssoId });
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.json.refused, "carried");
  assert.equal(refused.json.carried, 1);
  assert.match(refused.json.error, /is on 1 initiative/);
  assert.match(refused.json.error, /confirm/);
  assert.equal(bytes(initiativesFile), before, "the refusal wrote nothing to the initiative store");
  assert.equal((await get(tagsPath)).json.tags.length, 1);

  const confirmed = await send("DELETE", tagsPath, { id: ssoId, confirm: true });
  assert.equal(confirmed.status, 200, confirmed.text);
  assert.equal(confirmed.json.changed, true);
  assert.equal(confirmed.json.carried, 1);
  assert.equal(confirmed.json.removedFrom, 1);
  assert.deepEqual(confirmed.json.registry.tags, []);

  const read = await doc();
  assert.deepEqual(read.tags.tags, []);
  assert.deepEqual(read.initiatives.find((i) => i.title === "SSO migration").tagIds, [], "the id left the card");
  const stored = JSON.parse(bytes(initiativesFile));
  assert.deepEqual(stored.initiatives[0].tagIds, [], "and it left the stored record, not only the answer");
});

test("an unreadable registry is a 409 with the store's own sentence, and the bytes are left where they are", async () => {
  writeFileSync(tagsFile, "{ broken json", "utf8");
  const before = bytes(tagsFile);
  const read = await get(tagsPath);
  assert.equal(read.status, 200);
  assert.equal(read.json.readable, false);
  assert.match(String(read.json.error), /json/i);

  const out = await send("POST", tagsPath, { ident: "OOPS", name: "cannot land" });
  assert.equal(out.status, 409, out.text);
  assert.equal(out.json.refused, "unreadable");
  assert.match(out.json.error, /NOT overwritten/);
  assert.equal(bytes(tagsFile), before);
});
