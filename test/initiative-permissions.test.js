// The initiative permission tier: four levels, one decision, and the one level that needs a record.
//
// The setting decides ONLY whether the panel asks - the card, its wording and its resume are the same at every level -
// so this file pins the decision itself as a pure function, one case per level per action, plus the two facts the
// `own` level rests on: an attachment's actor is compared to the actor removing, and an attachment with no recorded
// actor is judged as somebody else's (so it asks).
//
// The reading of `own` is written down here because the label can be read two ways: the tier asks when the remover is
// NOT the actor who attached the tree. The opposite reading would let an assistant remove a tree the reader attached
// with no question at all, which is the one case the level exists to stop.
import assert from "node:assert/strict";
import test from "node:test";

import {
  INITIATIVE_ACTIONS,
  INITIATIVE_TIER_DEFAULT,
  INITIATIVE_TIER_INFO,
  INITIATIVE_TIERS,
  describeInitiativeTier,
  initiativeAsks,
  initiativeTierFrom,
  initiativeTierInfo,
} from "../lib/initiative-permissions.js";

const ACTOR = "scout";

test("the four levels are the four the setting offers, strictest first", () => {
  assert.deepEqual([...INITIATIVE_TIERS], ["all", "remove", "own", "none"]);
  assert.deepEqual(
    INITIATIVE_TIER_INFO.map((row) => row.id),
    [...INITIATIVE_TIERS],
    "the rows and the values are one list",
  );
  assert.deepEqual(
    INITIATIVE_TIER_INFO.map((row) => row.label),
    [
      "ask me for everything",
      "ask me only to remove things",
      "ask me only to remove trees I attached myself",
      "need no permission at all",
    ],
    "the reader's words for the four levels",
  );
  // Every row says what it does, because the third label alone is readable two ways.
  for (const row of INITIATIVE_TIER_INFO) assert.ok(row.hint.length > 20, `${row.id} carries a sentence`);
});

test("a missing or malformed value is the strictest level, never an error and never `none`", () => {
  assert.equal(INITIATIVE_TIER_DEFAULT, "all");
  for (const bad of [undefined, null, "", "  ", "ALL", "everything", "false", 0, {}, []]) {
    assert.equal(initiativeTierFrom(bad), "all", `${JSON.stringify(bad)} reads as the default`);
  }
  assert.equal(initiativeTierFrom(" NONE "), "none", "a real value is trimmed and lowercased");
  assert.equal(initiativeTierInfo("nonsense").id, "all");
  assert.equal(initiativeTierInfo("own").label, "ask me only to remove trees I attached myself");
});

test("ask me for everything asks for all four changes, whoever is making them", () => {
  for (const action of INITIATIVE_ACTIONS) {
    assert.equal(initiativeAsks("all", action, { actor: "reader" }), true, `reader ${action}`);
    assert.equal(initiativeAsks("all", action, { actor: ACTOR }), true, `an assistant's ${action}`);
  }
});

test("ask me only to remove things asks for a detach and nothing else", () => {
  assert.equal(initiativeAsks("remove", "create", { actor: "reader" }), false);
  assert.equal(initiativeAsks("remove", "edit", { actor: ACTOR }), false);
  assert.equal(initiativeAsks("remove", "attach", { actor: ACTOR }), false);
  assert.equal(initiativeAsks("remove", "detach", { actor: "reader" }), true);
  assert.equal(initiativeAsks("remove", "detach", { actor: ACTOR }), true, "who attached it does not matter here");
});

test("ask me only to remove trees I attached myself asks when the remover is somebody else", () => {
  // The reader takes out his own attachment: no question.
  assert.equal(initiativeAsks("own", "detach", { actor: "reader", attachedBy: "reader" }), false);
  // An assistant takes out what it attached: no question either.
  assert.equal(initiativeAsks("own", "detach", { actor: ACTOR, attachedBy: ACTOR }), false);
  // An assistant takes out the reader's attachment: THE case this level exists for.
  assert.equal(initiativeAsks("own", "detach", { actor: ACTOR, attachedBy: "reader" }), true);
  // The reader takes out an assistant's attachment: also somebody else's tree.
  assert.equal(initiativeAsks("own", "detach", { actor: "reader", attachedBy: ACTOR }), true);
  // No record of who attached it cannot be judged, so it asks rather than guesses in the remover's favour.
  assert.equal(initiativeAsks("own", "detach", { actor: "reader", attachedBy: null }), true);
  assert.equal(initiativeAsks("own", "detach", { actor: "reader" }), true);
  // Case and whitespace are the panel's own normalisation, so two spellings of one assistant are one actor.
  assert.equal(initiativeAsks("own", "detach", { actor: " Scout ", attachedBy: "scout" }), false);
  // And the other three actions never ask at this level.
  for (const action of ["create", "edit", "attach"]) {
    assert.equal(initiativeAsks("own", action, { actor: ACTOR, attachedBy: "reader" }), false, action);
  }
});

test("need no permission at all asks for nothing", () => {
  for (const action of INITIATIVE_ACTIONS) {
    assert.equal(initiativeAsks("none", action, { actor: ACTOR, attachedBy: "reader" }), false, action);
  }
});

test("an action the setting does not govern asks nothing, and a default actor is the reader", () => {
  for (const action of ["remove", "delete", "", null, undefined]) {
    assert.equal(initiativeAsks("all", action), false, `${String(action)} is not one of the four`);
  }
  // `actor` absent means the reader, which is what the page sends by omission.
  assert.equal(initiativeAsks("own", "detach", { attachedBy: "reader" }), false);
  assert.equal(initiativeAsks("own", "detach", { attachedBy: ACTOR }), true);
});

test("the sentence names the level and what it does", () => {
  for (const tier of INITIATIVE_TIERS) {
    const sentence = describeInitiativeTier(tier);
    assert.ok(sentence.startsWith(initiativeTierInfo(tier).label), `${tier} starts with its label`);
    assert.ok(sentence.includes(initiativeTierInfo(tier).hint), `${tier} carries its hint`);
  }
});
