// One assistant's frame — the docked rail or the floating window — asserted where it is decided.
//
// The panel had ONE frame for its whole life: a docked rail, and nothing a reader could say about it. `dock` is now
// an assistant's own field in that assistant's settings file (`docked`, the default, or `floating`), and the page
// frames the pane from it. Three facts hold that together, and this file is where they are pinned:
//
//   1. IT IS PER ASSISTANT. #2 can float while #1 stays docked, from the file each one writes; Assistant #1's
//      assistant.json — where its KNOBS live — is byte-identical, and a frame it never chose writes no file at all.
//
//   2. IT IS NOT A KNOB. It is not in DEFAULTS, it is not in the settings object a turn runs on, and no preamble
//      mentions it. It is the third kind of field in that file: beside the knobs (what a turn does) and the two
//      role fields (what it says), the frame is how its pane is drawn.
//
//   3. ONE PAINTER, AND THE STYLESHEET ONLY FOLLOWS IT. The page reads the served map, draws the row with both
//      choices, and re-frames the open panel through `applyFrame` — on a save and on a tab change, with no reload.
//      `#assistant` is the rail's sticky rule; only `#assistant.is-floating` is fixed, so a panel that never touched
//      the setting cannot end up as a window.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import { DEFAULTS, DOCK_DEFAULT, DOCK_MODES, SETTINGS_SCOPE, pickDock } from "../lib/assistant/config.js";
import { PRIMARY_ASSISTANT } from "../lib/assistants.js";

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const here = (p) => new URL(p, import.meta.url);
const html = await readFile(here("../public/index.html"), "utf8");
const css = (await readFile(here("../public/style.css"), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\r/g, "");
const assistant = await readFile(here("../public/assistant.js"), "utf8");
// CRLF is checked in with `core.autocrlf`; the guards below read the SOURCE, so they read it with `\n` only. The
// comment strip leaves a stray `\r` per removed line, which is why it happens before the assertions rather than in
// them.
const code = assistant.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\r/g, "");

async function panel(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-dock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const assistantFile = path.join(dir, "assistant.json");
  await writeFile(assistantFile, JSON.stringify({ version: 2, settings: {}, notes: "", rules: [], watches: [], alerts: [], journal: [] }));
  const store = new Assistant({
    config: { jobsFile: path.join(dir, "jobs.json"), assistantFile },
    jobs: { list: () => [], firstOfThread: () => null, create: async (body) => ({ id: "job-1", ...body }) },
    getProjects: () => [],
    onLog: () => {},
  });
  return { assistant: store, dir, assistantFile, profileFile: (id) => path.join(dir, "assistants", id, "settings.json") };
}

test("the frame is an assistant-owned field, not a knob and not the panel's", () => {
  assert.equal(SETTINGS_SCOPE.dock, "assistant", "placed in the ownership table beside the prompt and the list");
  assert.ok(!("dock" in DEFAULTS), "no turn reads it, so it is not a knob in the settings object");
  assert.deepEqual(DOCK_MODES, ["docked", "floating"], "the two frames, and only two");
  assert.equal(DOCK_DEFAULT, "docked", "the rail is what a panel that never chose anything keeps");
  // A value this build has no frame for is the default, never nothing: the pane always has a geometry to draw.
  assert.equal(pickDock(undefined), "docked");
  assert.equal(pickDock("sideways"), "docked");
  assert.equal(pickDock("floating"), "floating");
});

test("a second assistant holds the opposite frame from the first", async (t) => {
  const { assistant: store, assistantFile, profileFile } = await panel(t);
  const before = sha(await readFile(assistantFile));
  assert.deepEqual(store.state().dock, { [PRIMARY_ASSISTANT]: "docked" }, "a panel that chose nothing is docked");
  const second = store.createAssistant({ roleId: "assistant-agent-manager", name: "Reviewer" }).created.id;
  // One assistant floats; its neighbour stays docked. The value is the FILE's, not a global switch's.
  store.saveProfile(second, { dock: "floating" });
  assert.deepEqual(store.state().dock, { [PRIMARY_ASSISTANT]: "docked", [second]: "floating" });
  assert.equal(JSON.parse(await readFile(profileFile(second), "utf8")).dock, "floating", "written in #2's own file");
  assert.equal(store.profileOf(PRIMARY_ASSISTANT).dock, "docked", "and #1 did not move with it");
  assert.equal(sha(await readFile(assistantFile)), before, "Assistant #1's store is byte-identical");
  await assert.rejects(() => stat(profileFile(PRIMARY_ASSISTANT)), "a frame #1 never chose writes no file at all");
  // The other way round, so the test cannot pass by one assistant being special.
  store.saveProfile(second, { dock: "docked" });
  store.saveProfile(PRIMARY_ASSISTANT, { dock: "floating" });
  assert.deepEqual(store.state().dock, { [PRIMARY_ASSISTANT]: "floating", [second]: "docked" });
  assert.equal(JSON.parse(await readFile(profileFile(PRIMARY_ASSISTANT), "utf8")).dock, "floating", "in #1's own settings file");
  assert.ok(!("dock" in JSON.parse(await readFile(profileFile(second), "utf8"))), "docked is the absence of the key");
  // The knobs are still #1's own object in assistant.json, and the frame is not among them.
  assert.equal(sha(await readFile(assistantFile)), before, "switching the frame never touches the knobs' store");
  assert.ok(!("dock" in store.settings), "and never enters the settings a turn runs on");
  assert.ok(!store.preamble(PRIMARY_ASSISTANT).includes("floating"), "a turn is told nothing about the frame");
});

test("a saved knob does not put the pane back in its dock", async (t) => {
  const { assistant: store, profileFile } = await panel(t);
  const second = store.createAssistant({ roleId: "assistant-agent-manager", name: "Reviewer" }).created.id;
  store.saveProfile(second, { dock: "floating" });
  // A Settings save writes the whole profile file; the frame it was not asked about has to survive it, or a reader
  // who changed their model would find the window gone.
  store.setSettingsFor(second, { autonomy: "auto" });
  const stored = JSON.parse(await readFile(profileFile(second), "utf8"));
  assert.equal(stored.settings.autonomy, "auto");
  assert.equal(stored.dock, "floating", "the frame is carried through a knobs-only write");
  // And a Role save (the prompt route) leaves it alone too.
  store.saveProfile(second, { prompt: "Be brief." });
  assert.equal(JSON.parse(await readFile(profileFile(second), "utf8")).dock, "floating");
  assert.equal(store.state().dock[second], "floating");
});

test("a file that says nothing, or something unknown, reads as docked", async (t) => {
  const { assistant: store, profileFile } = await panel(t);
  const second = store.createAssistant({ roleId: "assistant-agent-manager", name: "Reviewer" }).created.id;
  await mkdir(path.dirname(profileFile(second)), { recursive: true });
  await writeFile(profileFile(second), JSON.stringify({ version: 1, dock: "sideways" }));
  store.readProfile(store.assistantRecord(second));
  assert.equal(store.state().dock[second], "docked", "a hand-edited value cannot strand the pane without a frame");
  await writeFile(profileFile(second), JSON.stringify({ version: 1, settings: { autonomy: "auto" } }));
  store.readProfile(store.assistantRecord(second));
  assert.equal(store.state().dock[second], "docked", "and a file with no key at all is the rail");
  assert.equal(store.state().dockModes.length, 2, "the page is told the two frames rather than guessing them");
});

test("the settings window draws the row from the served map, with both choices", () => {
  // The control is the assistant's own: its id is the value, so the save names the file it belongs to.
  assert.match(code, /<select data-as-dock="\$\{esc\(id\)\}"/, "one row, in that assistant's Settings pane");
  assert.match(code, /dockMode === v \? " selected"/, "the chosen frame is the served value, not a class left behind");
  assert.match(code, /const dockMode = \(a\.dock \|\| \{\}\)\[id\] === "floating" \? "floating" : "docked"/);
  // Both choices are named in words: a select can only carry text, and "docked"/"floating" alone is a riddle.
  assert.match(code, /docked — a rail beside the board/);
  assert.match(code, /floating — a window over the board/);
  // The save goes to the per-assistant profile route with that assistant's id, and the answer's state re-frames the
  // open panel: no reload, and the row is repainted from what the file took.
  assert.match(code, /if \(el\.dataset\.asDock\) \{[\s\S]{0,600}asPost\("\/api\/assistant\/profile", \{ assistantId: own, dock: el\.value \}\)/);
  assert.match(code, /if \(el\.dataset\.asDock\) \{[\s\S]{0,900}renderAssistantSettings\(own, true\)/);
});

test("the pane re-frames on load, on a save and on a tab change — through one painter", () => {
  // One entry point decides which geometry runs, and it reads the setting every time rather than remembering it.
  assert.match(code, /function applyFrame\(force = false\)/);
  assert.match(code, /const mode = dockModeOf\(id\) === "floating" \? "floating" : "docked"/);
  assert.match(code, /el\.classList\.toggle\("is-floating", mode === "floating"\)/);
  assert.match(code, /const frameSessionId = \(\) => \(isAssistant\(state\.assistantView\?\.assistant\) \? state\.assistantView\.assistant : lastSession\)/,
    "a list tab keeps the last session's frame instead of snapping the panel back to #1");
  // The paths that have to land here: the boot, an open, a resize, and every render (a save repaints through it).
  assert.match(code, /function renderAssistant\(\) \{\n\s*const a = state\.assistant;\s*\n\s*applyFrame\(\);/,
    "every render re-frames from the setting — the save and the tab change both land here");
  assert.match(code, /el\.hidden = !state\.assistantOpen;\n\s*as\$\("btn-assistant"\)\?\.classList\.toggle\("is-on", state\.assistantOpen\);\n\s*applyFrame\(true\);/,
    "the boot applies the frame the assistant's file asks for");
  assert.match(code, /if \(state\.assistantOpen\) \{\n\s*applyFrame\(true\);/,
    "opening the pane places it in whichever mode is in force");
  assert.match(code, /window\.addEventListener\("resize", \(\) => \{\n\s*if \(!state\.assistantOpen\) return;\n\s*applyFrame\(true\);/,
    "a resize re-measures the frame it is in");
  // The float's geometry is its own record: the rail's width is not overwritten by it, and the float is not
  // remembered in the rail's key.
  assert.match(code, /const FLOAT_KEY = "wm\.assistantFloat"/);
  assert.match(code, /localStorage\.setItem\(FLOAT_KEY, JSON\.stringify\(r\)\)/);
  assert.match(code, /const DOCK_KEY = "wm\.assistantWidth"/);
  assert.match(code, /state\.assistantFloat = state\.assistantFloat \?\? readFloatRect\(\)/);
  // The gestures follow the mode rather than the element: the rail's edge sizes the column, the float's bar moves
  // it and the same grab is its corner.
  assert.match(code, /onDown\(e, floating\(\) \? "float-size" : "dock-width", split\)/);
  assert.match(code, /if \(bar\) bar\.addEventListener\("pointerdown", \(e\) => \{ if \(floating\(\)\) onDown\(e, "float-move", bar\); \}\)/);
  // …and the stylesheet only draws the window when that class is on the pane.
  const base = css.match(/\n#assistant \{([^}]*)\}/);
  assert.ok(base, "no #assistant rule");
  assert.doesNotMatch(base[1], /position:\s*fixed/, "the rail is the rule every reader gets");
  const floatRule = css.match(/\n#assistant\.is-floating \{([^}]*)\}/);
  assert.ok(floatRule, "no floating rule");
  assert.match(floatRule[1], /position:\s*fixed/, "the float is the window, and only with the class on");
  assert.match(css, /\n#assistant\.is-floating \.as-split \{[^}]*right: 0; top: auto; bottom: 0;/, "the grab moves to the corner");
  assert.match(css, /\n#assistant\.is-floating \.as-bar \{ cursor: move; \}/, "the bar is a handle only while floating");
  // The one element, two jobs: nothing new was added to the markup for a window the rail does not have.
  assert.equal((html.match(/id="as-split"/g) || []).length, 1);
});
