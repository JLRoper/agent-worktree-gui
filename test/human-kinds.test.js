// The Human button's FOUR SWITCHES: which kinds it counts, the order it steps the rest in, and the sentence that
// names them.
//
// Settings > Human holds four switches - permissions, clarify questions, review items, collisions - and every one of
// them defaults ON, so a reader who never opens that tab gets exactly the button this panel has always drawn. This
// file pins the arithmetic that makes that true (public/core/review-lane.js `kindKey` / `keepKinds` / `split` /
// `title`) and the wiring that applies it (public/app.js `humanKinds`, `humanQuestions`, `paintHumanButton`, the H
// keydown and the settings rows), because a filter nothing calls is not a filter.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
function sliceBetween(source, from, to) {
  const a = source.indexOf(from);
  assert.ok(a >= 0, `${from} is in the file`);
  const b = source.indexOf(to, a + from.length);
  assert.ok(b > a, `${to} follows ${from}`);
  return source.slice(a, b);
}

await import("../public/core/review-lane.js");
const lane = globalThis.wtReviewLane;

const item = (kind, sinceMs, key) => ({ kind, sinceMs, key: key || `${kind}:${sinceMs}` });
const ALL_ON = { permissions: true, clarify: true, review: true, collisions: true };
const kindsWith = (over) => ({ ...ALL_ON, ...over });

// ---- 1. which switch an entry answers to --------------------------------------------------------------

test("a kind is read off the rotation's own rank, so the switch names and the order cannot drift apart", () => {
  assert.deepEqual(lane.KIND_KEYS, ["permissions", "clarify", "review", "collisions"]);
  assert.equal(lane.kindKey(item("approval", 1)), "permissions");
  assert.equal(lane.kindKey(item("write", 1)), "permissions", "a remote-write approval is a permission");
  assert.equal(lane.kindKey(item("question", 1)), "clarify");
  assert.equal(lane.kindKey(item("review", 1)), "review");
  assert.equal(lane.kindKey(item("collision", 1)), "collisions");
  assert.equal(lane.kindKey({ kind: "something-new" }), "", "an unknown kind has no switch");
});

test("an entry with no rank is KEPT: a switch this module does not understand must not drop work it cannot see", () => {
  const odd = { kind: "something-new", sinceMs: 1 };
  assert.deepEqual(lane.keepKinds([odd], kindsWith({ review: false })), [odd]);
  assert.deepEqual(lane.keepKinds([odd], kindsWith({ permissions: false, clarify: false, review: false, collisions: false })), [odd]);
});

// ---- 2. the filter -----------------------------------------------------------------------------------

test("every kind is counted by default: no switch, an empty switch object, and all-on all keep the whole list", () => {
  const list = [item("approval", 1), item("question", 2), item("review", 3)];
  assert.equal(lane.keepKinds(list, undefined).length, 3, "no settings object at all is every kind on");
  assert.equal(lane.keepKinds(list, {}).length, 3, "a missing key is on, not off");
  assert.equal(lane.keepKinds(list, ALL_ON).length, 3);
  assert.equal(lane.keepKinds(null, ALL_ON).length, 0);
});

test("only an explicit false takes a kind out, and it takes out every entry of that kind", () => {
  const list = [item("approval", 1), item("write", 2), item("question", 3), item("review", 4), item("review", 5)];
  assert.deepEqual(lane.keepKinds(list, kindsWith({ review: false })).map((i) => i.kind), ["approval", "write", "question"]);
  assert.deepEqual(lane.keepKinds(list, kindsWith({ permissions: false })).map((i) => i.kind), ["question", "review", "review"]);
  assert.deepEqual(lane.keepKinds(list, kindsWith({ clarify: false })).map((i) => i.kind), ["approval", "write", "review", "review"]);
  assert.deepEqual(lane.keepKinds(list, kindsWith({ permissions: false, clarify: false, review: false })), []);
  // A stored "yes" is not a switch: only a boolean false is off.
  assert.equal(lane.keepKinds(list, kindsWith({ review: "no" })).length, 5);
});

// ---- 3. the order ------------------------------------------------------------------------------------

test("the rotation keeps permissions, then clarify, then review, then collisions among whatever remains - oldest first inside a kind", () => {
  const list = [
    item("collision", 50, "coll-old"),
    item("review", 300, "review-new"),
    item("question", 500, "ask-new"),
    item("approval", 900, "perm-new"),
    item("review", 100, "review-old"),
    item("write", 800, "write-old"),
    item("collision", 40, "coll-oldest"),
    item("question", 200, "ask-old"),
  ];
  const sorted = lane.sortHuman(list);
  const keys = (kinds) => lane.keepKinds(sorted, kinds).map((i) => i.key);
  // All on: the order the panel has always stepped, with the collisions after the results.
  assert.deepEqual(keys(ALL_ON), ["write-old", "perm-new", "ask-old", "ask-new", "review-old", "review-new", "coll-oldest", "coll-old"]);
  // Review off: the two blocking kinds keep every entry and every relative place.
  assert.deepEqual(keys(kindsWith({ review: false })), ["write-old", "perm-new", "ask-old", "ask-new", "coll-oldest", "coll-old"]);
  // Permissions off: clarify still comes before review, and oldest first inside each.
  assert.deepEqual(keys(kindsWith({ permissions: false })), ["ask-old", "ask-new", "review-old", "review-new", "coll-oldest", "coll-old"]);
  // Clarify off: a permission, then the reviews.
  assert.deepEqual(keys(kindsWith({ clarify: false })), ["write-old", "perm-new", "review-old", "review-new", "coll-oldest", "coll-old"]);
  // Collisions off: nothing changes for the three kinds the button had before this one existed.
  assert.deepEqual(keys(kindsWith({ collisions: false })), ["write-old", "perm-new", "ask-old", "ask-new", "review-old", "review-new"]);
  // Filtering never reorders: what is left is a subsequence of the unfiltered rotation.
  const all = keys(ALL_ON);
  for (const kinds of [kindsWith({ review: false }), kindsWith({ permissions: false }), kindsWith({ clarify: false }), kindsWith({ collisions: false })]) {
    let from = 0;
    for (const key of keys(kinds)) {
      const at = all.indexOf(key, from);
      assert.ok(at >= from, `${key} keeps its place in the rotation`);
      from = at;
    }
  }
});

// ---- 4. the title sentence ---------------------------------------------------------------------------

test("the split names the four kinds in the button's existing shape, and a kind only when it has something in it", () => {
  const counts = lane.badge([item("approval", 1), item("write", 2), item("question", 3), item("review", 4), item("review", 5), item("collision", 6)]);
  assert.equal(lane.split(counts, ALL_ON), "2 permissions, 1 clarify question, 2 to review, 1 collision");
  assert.match(lane.title(counts, ALL_ON), /^2 permissions, 1 clarify question, 2 to review, 1 collision - press H to step into one/);
  // The singulars are singular, and a kind with NOTHING in it is not named at all: "0 collisions" would be a clause
  // about a thing that is not happening, and the reader who sees no overlap should not read the word.
  assert.equal(lane.split(lane.badge([item("approval", 1)]), ALL_ON), "1 permission");
  assert.equal(lane.split(lane.badge([item("approval", 1), item("collision", 2)]), ALL_ON), "1 permission, 1 collision");
});

test("a switched-off kind is never named - not as a zero, not as a noun, not in the quiet sentence", () => {
  const counts = lane.badge([item("approval", 1), item("question", 2), item("review", 3), item("collision", 4)]);
  assert.equal(lane.split(counts, kindsWith({ review: false })), "1 permission, 1 clarify question, 1 collision");
  assert.doesNotMatch(lane.split(counts, kindsWith({ review: false })), /review/);
  assert.equal(lane.split(counts, kindsWith({ permissions: false })), "1 clarify question, 1 to review, 1 collision");
  assert.doesNotMatch(lane.title(counts, kindsWith({ permissions: false })), /permission/);
  // The collision kind is a switch of its own: off, it is gone from the sentence and from the quiet nouns.
  assert.equal(lane.split(counts, kindsWith({ collisions: false })), "1 permission, 1 clarify question, 1 to review");
  assert.doesNotMatch(lane.split(counts, kindsWith({ collisions: false })), /collision/);
  assert.doesNotMatch(lane.title(lane.badge([]), kindsWith({ collisions: false })), /collision/);
  // The quiet sentence loses the kind as well.
  assert.equal(lane.title(lane.badge([]), kindsWith({ review: false })), "nothing is waiting for you - no permission, no question, no collision");
  assert.doesNotMatch(lane.title(lane.badge([]), kindsWith({ review: false })), /result to review/);
  assert.equal(lane.title(lane.badge([]), ALL_ON), "nothing is waiting for you - no permission, no question, no result to review, no collision");
});

test("with every kind off the sentence says so rather than claiming the board is clear", () => {
  const none = kindsWith({ permissions: false, clarify: false, review: false, collisions: false });
  assert.equal(lane.split(lane.badge([]), none), "");
  assert.equal(lane.title(lane.badge([]), none), "nothing is waiting for you - every kind of the Human button is switched off in Settings");
});

// ---- 5. the wiring -----------------------------------------------------------------------------------

const app = read("public/app.js");
const html = read("public/index.html");
const DEFAULT_SWITCH = { permissions: true, clarify: true, review: true, collisions: true };

test("the switches default on, and a saved value may only turn one off", () => {
  const load = sliceBetween(app, "function loadHumanKinds()", "function humanKindOn(");
  assert.match(load, /for \(const key of HUMAN_KIND_KEYS\) out\[key\] = true/, "today's behaviour is every kind on");
  assert.match(load, /typeof saved\[key\] === "boolean"/, "only a real boolean is honoured");
  assert.match(app, /const HUMAN_KINDS_KEY = "wtgui\.humanKinds"/, "saved in this browser like the panel's other settings");
  // The four row ids the setting writes, in the same order as the rotation.
  assert.match(app, /const HUMAN_KIND_KEYS = \["permissions", "clarify", "review", "collisions"\]/);
  const rows = sliceBetween(html, 'id="settings-panel-human"', 'id="settings-panel-repo"');
  for (const key of Object.keys(DEFAULT_SWITCH)) {
    assert.match(rows, new RegExp(`id="human-kind-${key}" type="checkbox" checked`), `${key} is a switch, on by default`);
    assert.match(rows, new RegExp(`for="human-kind-${key}"`), `${key} has a label that names it`);
  }
  assert.match(rows, />Permissions </);
  assert.match(rows, />Clarify questions </);
  assert.match(rows, />Review items </);
  assert.match(rows, />Collisions </);
  // A group of its own, beside the existing ones, with its own tab.
  assert.match(html, /data-settings-tab="human"/);
  assert.match(html, /id="settings-panel-human" data-settings-group="human"/);
  assert.match(app, /box\?\.addEventListener\("change", \(e\) => setHumanKind\(key, e\.target\.checked\)\)/);
});

test("the count, the sentence and the rotation all read the one object", () => {
  const questions = sliceBetween(app, "function humanQuestions()", "function reviewRotationRows()");
  assert.match(questions, /wtReviewLane\.keepKinds\(wtReviewLane\.sortHuman\(\[\.\.\.out, \.\.\.dock\]\), humanKinds\(\)\)/);
  const paint = sliceBetween(app, "function paintHumanButton()", "// Open exactly the path to one question");
  assert.match(paint, /const kinds = humanKinds\(\);/);
  assert.match(paint, /const list = humanQuestions\(\);/);
  assert.match(paint, /wtReviewLane\.badge\(list\)/, "the badge is the count of the filtered list");
  assert.match(paint, /wtReviewLane\.split\(counts, kinds\)/, "the sentence is the module's split, not a second copy");
  assert.match(paint, /humanKindsOffSentence\(kinds\)/, "a switched-off kind is said out loud");
  assert.match(paint, /kindSig/, "a switch repaints a button whose count did not move");
  assert.match(paint, /badge\.hidden = list\.length === 0/, "zero is quiet");
  // The aria-label and the title both label the switch that is off, so neither promises a kind that is not counted.
  assert.match(paint, /every kind of this button is switched off in Settings/);
});

test("H is inert when every kind is off, before preventDefault and without a banner", () => {
  const step = sliceBetween(app, "function humanStep()", "$(\"btn-human\")?.addEventListener");
  assert.match(step, /if \(!humanAnyKindOn\(\)\) \{[\s\S]*?return;\r?\n  \}/, "the press does nothing at all");
  assert.doesNotMatch(step.slice(0, 400), /showBanner/, "and says nothing about a board it is not reading");
  const key = sliceBetween(app, 'document.addEventListener("keydown", (e) => {\r\n  if (e.ctrlKey || e.metaKey || e.altKey) return;\r\n  if (e.key !== "h" && e.key !== "H") return;', "humanStep();");
  const guard = key.indexOf("if (!humanAnyKindOn()) return;");
  assert.ok(guard >= 0, "the key is guarded");
  assert.ok(guard < key.indexOf("e.preventDefault()"), "and refused BEFORE the page takes the keystroke");
});
