// The 🌊 default (Settings → Agent cards → **Combined output**): the switch is the answer for a card that never chose,
// a card's own press still wins, and the choice round-trips through a save.
//
// The mechanism is the page's, not a node module, so this slices the two regions that own it out of public/app.js and
// runs them against a stub localStorage — the shape settings-groups.test.js and tool-group-key.test.js already use.
// Four facts:
//
//   1. with nothing stored a card is the condensed console it always was, and building a card WRITES nothing (a read
//      is not a save, so opening the board must not pin the default for the next browser);
//   2. a session with no answer of its own follows the switch — that is the whole point: a NEW session's console comes
//      up as one stream when the default is on, with no press on that card;
//   3. a card's own answer wins in BOTH directions (`wtgui.stream.<thread>` = "1" over a default of off, "0" over a
//      default of on) — otherwise pressing 🌊 could not turn the stream off again while the default was on;
//   4. the setting's own handler saves the global key — never the per-card one — and repaints only the cards with no
//      answer of their own, which is exactly what the 🧠 row above it does.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sliceBetween } from "../tools/panel-testkit.mjs";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

// The one-stream region: `const STREAM_KEY` through the 🌊/condensed decision (`streamDefault`, `streamOn`,
// `setStreamMode`), stopping before the tool-group section that follows. (Anchored on the const, not on
// "// ---- one stream": that phrase also heads the section that draws a single tool row.)
const REGION = sliceBetween(src, 'const STREAM_KEY = "wtgui.stream";', "// ---- a run of tool calls");

// The settings row's own change handler, from its statement to the `});` that closes it.
const handlerAt = src.indexOf('$("stream-default")?.addEventListener("change"');
assert.ok(handlerAt > 0, "public/app.js still wires the Combined output row");
const handlerEnd = src.indexOf("\n});", handlerAt);
assert.ok(handlerEnd > handlerAt, "…and closes the handler");
const HANDLER = src.slice(handlerAt, handlerEnd + "\n});".length);

function store(seed = {}) {
  const map = new Map(Object.entries(seed));
  const writes = [];
  return {
    map,
    writes,
    localStorage: {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => {
        writes.push([k, String(v)]);
        map.set(k, String(v));
      },
    },
  };
}

// The page's own functions, run against a stub store. `renderConversation` is the only page call they make.
function page(seed = {}) {
  const s = store(seed);
  const rendered = [];
  const api = new Function(
    "localStorage",
    "renderConversation",
    `${REGION}; return { streamOn, streamDefault, setStreamMode, STREAM_KEY };`,
  )(s.localStorage, (t) => rendered.push(t));
  return { ...api, ...s, rendered };
}

test("a card with nothing stored is the condensed console, and building it writes nothing", () => {
  const p = page();
  assert.equal(p.streamDefault(), false, "the switch starts off — what every card did before it existed");
  assert.equal(p.streamOn("never-seen"), false);
  assert.deepEqual(p.writes, [], "a read is not a save: building a card must not pin the default");
});

test("a session that never chose follows the switch, so a new card comes up as one stream", () => {
  const p = page({ "wtgui.stream": "1" });
  assert.equal(p.streamDefault(), true);
  assert.equal(p.streamOn("a-thread-opened-today"), true, "a new session's console is one stream with the default on");
  assert.equal(p.streamOn("another-new-one"), true);
});

test("a card's own answer wins over the default in both directions", () => {
  const onByDefault = page({ "wtgui.stream": "1", "wtgui.stream.pressed-off": "0" });
  assert.equal(onByDefault.streamOn("pressed-off"), false, "🌊 pressed off beats a default of on");
  assert.equal(onByDefault.streamOn("untouched"), true);
  const offByDefault = page({ "wtgui.stream": "0", "wtgui.stream.pressed-on": "1" });
  assert.equal(offByDefault.streamOn("pressed-on"), true, "🌊 pressed on beats a default of off");
  assert.equal(offByDefault.streamOn("untouched"), false);
});

test("a save round-trips, and the card keeps it when the default moves under it", () => {
  const p = page();
  p.setStreamMode("t1", true);
  assert.deepEqual(p.writes, [["wtgui.stream.t1", "1"]], "the press saves the CARD's answer, not the global default");
  assert.equal(p.map.get("wtgui.stream.t1"), "1");
  assert.deepEqual(p.rendered, ["t1"], "and the card is repainted from it");
  assert.equal(p.streamOn("t1"), true);
  // The reader then turns the default on: the card that already answered must not follow it...
  p.map.set("wtgui.stream", "1");
  assert.equal(p.streamOn("t1"), true, "…it stays as saved");
  p.setStreamMode("t1", false);
  assert.equal(p.streamOn("t1"), false, "and the next press turns it off again, over a default of on");
  assert.equal(p.map.get("wtgui.stream"), "1", "the card's press never rewrites the default");
});

test("the switch saves the global key and repaints only the cards with no answer of their own", () => {
  const s = store({ "wtgui.stream.own": "0" });
  let handler = null;
  const rendered = [];
  const el = { checked: false, addEventListener: (type, fn) => (type === "change" ? (handler = fn) : null) };
  const api = new Function(
    "localStorage",
    "renderConversation",
    "$",
    "conversations",
    `${REGION};${HANDLER}; return { streamOn };`,
  )(
    s.localStorage,
    (t) => rendered.push(t),
    (id) => (id === "stream-default" ? el : null),
    () => [{ thread: "own" }, { thread: "fresh" }],
  );
  assert.equal(typeof handler, "function", "the row registers its change handler");
  el.checked = true;
  handler({ target: el });
  assert.deepEqual(s.writes, [["wtgui.stream", "1"]], "the switch owns the global key");
  assert.deepEqual(rendered, ["fresh"], "the card with its own answer is left alone");
  assert.equal(api.streamOn("fresh"), true, "and the card that followed it is now one stream");
  assert.equal(api.streamOn("own"), false, "while the card that chose stays condensed");
});

test("the row sits beside Show thinking, in the Agent cards group, with the same ⓘ shape", () => {
  const start = html.indexOf('<h3 class="settings-group-head" data-settings-group="cards"');
  const end = html.indexOf('<div class="settings-group', start + 10);
  const group = html.slice(start, end > start ? end : undefined);
  const think = group.indexOf('for="show-thinking"');
  const mine = group.indexOf('for="stream-default"');
  assert.ok(think > 0, "the Agent cards group still carries Show thinking");
  assert.ok(mine > think, "Combined output is in the same group, below it");
  const thinkEnd = group.indexOf("</label>", think) + "</label>".length;
  const mineAt = group.lastIndexOf("<label", mine);
  assert.ok(mineAt > thinkEnd, "the next row after Show thinking is Combined output");
  assert.equal(group.slice(thinkEnd, mineAt).trim(), "", "and no other row, control or preset sits between them");
  const row = group.slice(group.lastIndexOf("<label", mine), group.indexOf("</label>", mine) + "</label>".length);
  assert.match(row, /<span>Combined output <span class="settings-info">ⓘ<\/span><\/span>/, "the label and its ⓘ");
  assert.match(row, /<input id="stream-default" type="checkbox">/, "a checkbox, like the row above");
  assert.match(row, /settings-unit mono">default for cards</, "and it says what it is a default for");
  assert.match(row, /title="[^"]*wins over this switch/, "the ⓘ says the card's own button wins");
  assert.match(row, /title="[^"]*Saved in this browser\./, "and where the answer is kept");
});

test("the switch is painted from the stored answer at start-up, beside the 🧠 one", () => {
  assert.ok(
    src.includes('if ($("stream-default")) $("stream-default").checked = streamDefault();'),
    "the page paints the box from the saved answer",
  );
  const think = src.indexOf('$("show-thinking").checked = thinkDefault()');
  const mine = src.indexOf('$("stream-default").checked = streamDefault()');
  assert.ok(think > 0 && mine > think, "the load line sits with the other settings defaults");
});
