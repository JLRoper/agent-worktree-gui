// The ACTIVE AGENTS button's own switch: off by default, absent while off, and the one decision the paint asks.
//
// WHY THIS FILE EXISTS. The header control (public/index.html #btn-hot, drawn by public/app.js paintHotButton) used
// to exist whenever an agent was working and only then. The row that asked for the rename also asked for the
// control to become a Settings toggle that ships OFF, so "is it drawn at all" is now two facts joined: the reader's
// switch, and whether an agent is actually working. Both halves live in public/core/active-button.js, and this file
// asks them by name with a storage stub, so the default cannot be a value one call site assumes and another
// contradicts.
//
// WHAT IT PINS
//
//   1. THE DEFAULT IS OFF for a reader who never set it: no storage at all, an empty value, a blank one, and a
//      browser that throws on read all answer false. A value this build does not understand is the default too.
//   2. A STORED VALUE IS HONOURED one way only: "1"/"true"/"on" is on, "0"/"false"/"off" is off, and nothing else is
//      guessed into a header control.
//   3. THE SHOW DECISION is the switch AND a working agent - so "on with nothing running" is still absent, and a
//      parked agent can never make it true (it is not in the list hot-mark.js builds).
//   4. THE PAGE is wired to this file: the General row exists, ships unchecked, names the pen search as a different
//      control, saves under this key, and the paint asks the module rather than repeating its rule. The word the
//      reader sees is Active, and the ids and the key keep `hot` so existing state keeps reading.
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

await import("../public/core/active-button.js");
const setting = globalThis.wtActiveButton;

const storage = (initial = null) => {
  const map = new Map(initial == null ? [] : [[setting.KEY, initial]]);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    dump: () => Object.fromEntries(map),
  };
};

// ---- 1. the default, which is OFF -----------------------------------------------------------------------------

test("a reader who never set it gets OFF: no storage, no value, a blank value, an unreadable one", () => {
  assert.equal(setting.DEFAULT, false, "the module's own default is off");
  assert.equal(setting.read(null), false, "no storage at all answers the default");
  assert.equal(setting.read(undefined), false);
  assert.equal(setting.read({}), false, "an object with no getItem is not a storage");
  assert.equal(setting.read(storage()), false, "a storage that has never held the key is off");
  assert.equal(setting.read(storage("")), false, "a blank value is not a switch");
  assert.equal(setting.read(storage("   ")), false);
  assert.equal(
    setting.read({
      getItem: () => {
        throw new Error("private mode");
      },
    }),
    false,
    "a browser that refuses storage answers the default rather than an error the page has to catch",
  );
});

test("a stored value this build does not understand is the default, never guessed on", () => {
  for (const weird of ["yes please", "2", "header", "TRUE!"]) assert.equal(setting.read(storage(weird)), false, `${JSON.stringify(weird)} is not a switch`);
});

// ---- 2. the stored value, one way only ------------------------------------------------------------------------

test("on is written as 1 and read back as true; off as 0 and read back as false", () => {
  const store = storage();
  assert.equal(setting.write(store, true), true, "write answers what was stored");
  assert.equal(store.getItem(setting.KEY), "1", "the key holds the on value");
  assert.equal(setting.read(store), true, "and the read agrees with the write");

  assert.equal(setting.write(store, false), false);
  assert.equal(store.getItem(setting.KEY), "0");
  assert.equal(setting.read(store), false, "a page that switched it off stays off");

  // Truthy/falsey input is coerced once, at the write, so the row cannot save a value the read then rewrites.
  assert.equal(setting.write(store, "yes"), true);
  assert.equal(setting.read(store), true);
  assert.equal(setting.write(store, undefined), false);
  assert.equal(setting.read(store), false);
});

test("each word a build might have written is read the way it says", () => {
  assert.equal(setting.read(storage("true")), true);
  assert.equal(setting.read(storage("on")), true);
  assert.equal(setting.read(storage(" ON ")), true, "surrounding space and case do not change the switch");
  assert.equal(setting.read(storage("false")), false);
  assert.equal(setting.read(storage("off")), false);
  assert.equal(setting.read(storage("0")), false);
});

test("a browser that refuses the write still applies the value for this page", () => {
  const refusing = {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota");
    },
  };
  assert.equal(setting.write(refusing, true), true, "the row's own press is honoured even when the save is refused");
});

// ---- 3. the show/hide decision ---------------------------------------------------------------------------------

test("the button is drawn only when the switch is ON and an agent is working", () => {
  const one = [{ key: "a" }];
  assert.equal(setting.show(one, false), false, "off: absent, whatever the board is doing");
  assert.equal(setting.show(one, true), true, "on, with one agent working: drawn");
  assert.equal(setting.show([], true), false, "on, with nothing working: absent - a grey bolt would be a false claim");
  assert.equal(setting.show(null, true), false, "a page that has read no jobs yet draws nothing");
  assert.equal(setting.show(undefined, undefined), false, "and the absent case is the default, not an error");
  assert.equal(setting.show([{ key: "a" }, { key: "b" }], true), true);
});

// ---- 4. the page is wired to this file --------------------------------------------------------------------------

test("Settings > General carries the row, it ships unchecked, and it names the pen search as another control", () => {
  const html = read("public/index.html");
  const start = html.indexOf('id="settings-panel-general"');
  assert.ok(start > 0, "the General panel is in the page");
  const panel = html.slice(start, html.indexOf('<div class="settings-group"', start + 10));
  const row = panel.match(/<label class="settings-row[^"]*" for="general-active-button" title="([^"]*)">([\s\S]*?)<\/label>/);
  assert.ok(row, "the General panel carries a row for #general-active-button");
  const [, title, body] = row;

  assert.match(body, /Show the Active agents button in the floating header/, "the row says exactly what it switches");
  assert.match(body, /<input id="general-active-button" type="checkbox">/, "it is one unchecked checkbox");
  assert.doesNotMatch(body, /checked/, "and it ships OFF for a reader who has never set it");

  assert.match(title, /OFF by default/, "the tooltip says the default");
  assert.match(title, /off means ABSENT/, "and says off is absent rather than hidden-but-reserved");
  assert.match(title, /Only an agent actually working is counted/, "what it counts");
  assert.match(title, /red Human count/, "and that a parked agent belongs to Human instead");
  assert.match(title, /DIFFERENT control from the Hot Agent pen search/, "the pen search is named as a different control");
  assert.match(title, /Ctrl\+Shift\+Q/, "with its own chord, so nobody turns off the wrong one");
  assert.match(title, /Saved in this browser/, "and the row says where the value lives");
});

test("the paint and the row ask the module, and the word a person sees is Active", () => {
  const app = read("public/app.js");
  const paint = sliceBetween(app, "function paintHotButton()", "function hotStep()");
  assert.match(paint, /btn\.hidden = !wtActiveButton\.show\(list, on\)/, "the painter does not restate the rule");
  assert.match(paint, /⚡ Active/, "the label is the new word");
  assert.match(paint, /Active agents - /, "and so is the aria-label");
  assert.ok(!/⚡ Hot|Hot Agents/.test(paint), "no string the painter writes still says Hot");

  // The row's save path is the module's write, on this browser, followed by a repaint that is not waiting for a job.
  const handler = sliceBetween(app, '$("general-active-button")?.addEventListener', "// The row is drawn from the stored value");
  assert.match(handler, /wtActiveButton\.write\(localStorage, e\.target\.checked\)/, "the row writes through the module");
  assert.match(handler, /paintHotButton\(\)/, "and repaints the header on the press");
  assert.match(handler, /state\.hot\.sig = ""/, "clearing the signature is what makes that repaint happen now");

  // The ids and the key are the wire: they keep `hot`, which is what lets an earlier page's setting keep reading.
  const module = read("public/core/active-button.js");
  assert.match(module, /const KEY = "wtgui\.activeButton"/, "the browser key is this one, and only this one");
  assert.match(app, /state\.hot\.on/, "the cached read lives on the rotation's own state");
  assert.match(app, /\$?\("hot-label"\)/, "the label span keeps its id");
});
