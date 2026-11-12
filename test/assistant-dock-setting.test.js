// THE PANE'S FRAME — ONE setting for the whole panel, asserted where it is decided.
//
// The panel had one frame for its whole life (a docked rail). Then `dock` became one assistant's own field in that
// assistant's settings file, and the page framed the pane from the value on the tab it was showing. It is one
// panel-wide choice again, and not by dropping the values that were already chosen: this file pins the four facts
// that make the move safe.
//
//   1. IT IS THE PANEL'S KEY. `settings.dockMode` in config.json, saved through POST /api/settings/general. No
//      assistant's file carries a frame any more, and SETTINGS_SCOPE has no `dock` row — the ownership table is
//      the one place a key is declared, and the frame is nobody's per-assistant key.
//
//   2. THE OLD VALUES ARE ADOPTED, NOT DROPPED. A file written by the older build is read once (`readLegacyDock`),
//      the page posts the value of the assistant it is showing (the frame the reader is actually looking at), and
//      `retireDockField` takes the key out of every file — a file that held nothing but the frame is deleted
//      rather than left behind as an empty husk.
//
//   3. ONE READER. The page's geometry asks `state.settings.dockMode` and nothing else: `dockModeOf` takes no
//      assistant id, so two assistants cannot end up drawn in two different frames after the move.
//
//   4. ONE PAINTER. `applyFrame` writes the class and the geometry; a save, a settings event from another tab and
//      the first snapshot all land there, and the stylesheet only draws the window while that class is on.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Assistant } from "../lib/assistant.js";
import { DEFAULTS, DOCK_DEFAULT, DOCK_MODES, SETTINGS_SCOPE, pickDock } from "../lib/assistant/config.js";
import { EMPTY_PROFILE, pickProfile } from "../lib/assistant/profile.js";
import { PRIMARY_ASSISTANT } from "../lib/assistants.js";

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const here = (p) => new URL(p, import.meta.url);
const html = await readFile(here("../public/index.html"), "utf8");
const css = (await readFile(here("../public/style.css"), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\r/g, "");
const assistant = await readFile(here("../public/assistant.js"), "utf8");
const appSrc = (await readFile(here("../public/app.js"), "utf8")).replace(/\r/g, "");
const settingsSrc = (await readFile(here("../public/settings.js"), "utf8")).replace(/\r/g, "");
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

test("the frame is the panel's own key — not a knob, and no assistant's field", () => {
  assert.equal(SETTINGS_SCOPE.dock, undefined, "the ownership table has no per-assistant frame row any more");
  assert.ok(!("dock" in DEFAULTS), "no turn reads it, so it is not a knob in the settings object");
  assert.deepEqual(DOCK_MODES, ["docked", "floating"], "the two frames, and only two");
  assert.equal(DOCK_DEFAULT, "docked", "the rail is what a panel that never chose anything keeps");
  // A value this build has no frame for is refused by the route (strict read) and reads as the default anywhere
  // else, so a hand-edited config cannot strand the pane without a geometry to draw.
  assert.equal(pickDock(undefined), "docked");
  assert.equal(pickDock("sideways"), "docked");
  assert.equal(pickDock("floating"), "floating");
  assert.equal(pickDock("sideways", null), null, "the General route's strict read refuses it rather than guessing");
  // The profile has no frame field: a file that still carries one is read with the key dropped, which is what stops
  // the value from quietly coming back as a per-assistant setting.
  assert.ok(!("dock" in EMPTY_PROFILE), "an assistant with no file has no frame of its own");
  assert.equal(pickProfile({ dock: "floating" }).dock, undefined, "a file's dock is dropped on read");
});

test("two assistants that disagreed both follow the one setting afterwards, and the per-assistant key is gone", async (t) => {
  const { assistant: store, profileFile } = await panel(t);
  const second = store.createAssistant({ roleId: "assistant-agent-manager", name: "Reviewer" }).created.id;
  // The files a panel that had used the old row would carry: #1 floats and its file holds nothing else; #2 was
  // written docked beside a prompt, so its file must survive the cleanup with only the frame gone.
  await mkdir(path.dirname(profileFile(PRIMARY_ASSISTANT)), { recursive: true });
  await writeFile(profileFile(PRIMARY_ASSISTANT), JSON.stringify({ version: 1, dock: "floating" }));
  await mkdir(path.dirname(profileFile(second)), { recursive: true });
  await writeFile(profileFile(second), JSON.stringify({ version: 1, prompt: "Be brief.", dock: "docked" }));
  store.loadProfiles();
  assert.deepEqual(
    store.state().dock,
    { [PRIMARY_ASSISTANT]: "floating", [second]: "docked" },
    "the migration's read sees both values, and they really do disagree",
  );

  // The panel is showing #2 when the General route saves the frame it adopted; the value is one key now, and every
  // per-assistant copy goes in the same breath.
  const dropped = store.retireDockField().sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(dropped.map((d) => d.id).sort(), [PRIMARY_ASSISTANT, second].sort(), "both values were carried out, not dropped in silence");
  assert.equal(dropped.find((d) => d.id === second).dock, "docked");
  assert.deepEqual(store.state().dock, {}, "nothing per-assistant is left to disagree with the panel");
  assert.equal(store.profileOf(PRIMARY_ASSISTANT).dock, undefined);
  assert.equal(store.profileOf(second).dock, undefined);
  await assert.rejects(() => stat(profileFile(PRIMARY_ASSISTANT)), "a file that held only the frame is gone, not left empty");
  const kept = JSON.parse(await readFile(profileFile(second), "utf8"));
  assert.ok(!("dock" in kept), "the key is gone from a file that had other fields");
  assert.equal(kept.prompt, "Be brief.", "and the rest of the file survived the cleanup");
});

test("a knob, a prompt, or a stale per-assistant dock cannot write the retired frame back", async (t) => {
  const { assistant: store, assistantFile, profileFile } = await panel(t);
  const before = sha(await readFile(assistantFile));
  const second = store.createAssistant({ roleId: "assistant-agent-manager", name: "Reviewer" }).created.id;
  store.setSettingsFor(second, { autonomy: "auto" });
  let stored = JSON.parse(await readFile(profileFile(second), "utf8"));
  assert.equal(stored.settings.autonomy, "auto");
  assert.ok(!("dock" in stored), "the knobs' write carries no frame");
  store.saveProfile(second, { prompt: "Be brief." });
  stored = JSON.parse(await readFile(profileFile(second), "utf8"));
  assert.ok(!("dock" in stored), "the prompt's write carries none either");
  // A page from before the move still posts `dock` to the profile route. The store ignores the field rather than
  // writing a second copy of a panel-wide choice.
  store.saveProfile(second, { dock: "floating" });
  stored = JSON.parse(await readFile(profileFile(second), "utf8"));
  assert.ok(!("dock" in stored), "a stale patch cannot put the key back");
  assert.deepEqual(store.state().dock, {}, "and nothing per-assistant is served");
  assert.equal(sha(await readFile(assistantFile)), before, "Assistant #1's store is byte-identical: the frame never entered it");
});

test("the geometry reads the one key — no id, no map, so two assistants cannot be drawn two ways", () => {
  const found = code.match(/const dockModeOf = (.+);\n/);
  assert.ok(found, "no dockModeOf in the page");
  const read = (state) => new Function("state", `return ${found[1]};`)(state);
  const floating = read({
    settings: { dockMode: "floating" },
    // Every retired per-assistant value says the opposite. If the reader still asked the map, this would answer docked.
    assistant: { dock: { "assistant-1": "docked", "assistant-2": "docked" } },
  });
  assert.equal(typeof floating, "function");
  assert.equal(floating.length, 0, "it takes no assistant id: the frame is not a question about a tab");
  assert.equal(floating(), "floating", "the panel's key decides, whatever the old map says");
  const docked = read({ settings: { dockMode: null }, assistant: { dock: { "assistant-1": "floating" } } });
  assert.equal(docked(), "docked", "an absent key is the rail, never a leftover per-assistant value");
  const absent = read({ settings: {}, assistant: null });
  assert.equal(absent(), "docked", "and a page that has not loaded the settings yet draws the rail");
});

test("the per-assistant Settings pane no longer draws the frame", () => {
  assert.doesNotMatch(code, /data-as-dock/, "no per-assistant select");
  assert.doesNotMatch(code, /el\.dataset\.asDock/, "no handler for one");
  assert.doesNotMatch(code, /as-dock-err/, "and no error line for a save that cannot happen any more");
  assert.doesNotMatch(assistant, /How this assistant's pane is drawn/, "the group's heading is gone");
  assert.doesNotMatch(code, /dockModeOf\(frameSessionId\(\)\)/, "the tab no longer chooses the frame");
  assert.doesNotMatch(code, /const dockMode = \(a\.dock \|\| \{\}\)\[id\]/, "nothing in the pane reads a per-assistant mode");
});

test("General Settings carries the one picker, its help, and the save that applies it at once", () => {
  const start = html.indexOf('id="settings-panel-general"');
  assert.ok(start > 0, "the General panel is in the page");
  const panelHtml = html.slice(start, html.indexOf('<div class="settings-group"', start + 10));
  const select = panelHtml.match(/<select id="general-dock">([\s\S]*?)<\/select>/);
  assert.ok(select, "the row lives in the General panel, not in an assistant's own Settings pane");
  assert.match(select[1], /<option value="docked">/, "one choice is the rail");
  assert.match(select[1], /<option value="floating">/, "the other is the window");
  assert.match(panelHtml, /One frame for every assistant's pane/, "the help says it is the panel's, not one assistant's");
  assert.match(
    panelHtml,
    /where two assistants disagreed, the frame of the assistant the panel was showing/,
    "and says what the move did with values that disagreed",
  );
  // The page paints the select from the snapshot and posts the ONE key into the General route, which answers with
  // the settings this page then draws and re-frames from — no reload.
  assert.match(appSrc, /put\("general-dock", s\.dockMode === "floating" \? "floating" : "docked"\)/);
  assert.match(appSrc, /saveGeneralSettings\(\{ dockMode: value \}, "assistant pane"\)/);
  assert.match(appSrc, /if \(typeof window\.__assistantFrame === "function"\) window\.__assistantFrame\(\);/);
});

test("a corner drag's console height is monotonic in the frame's gain and stops at its floor", () => {
  // The console is what the reader reads, so the drag hands it the height the FRAME gained - measured back after the
  // clamp - rather than leaving it on the sheet's `flex: 1 1 auto`, which can only grow into FREE space. An
  // overflowing transcript has none: the console kept its content height, and a wider frame rewrapped that content
  // into fewer lines, so a drag that made the panel bigger drew a SHORTER console (measured 132.5 -> 98px on the
  // panel). This is the arithmetic that replaced it: press height + drawn gain, floored at the console's min-height.
  const fn = code.match(/function consoleDragHeight\(([^)]*)\) \{([\s\S]*?)\n  \}/);
  assert.ok(fn, "no consoleDragHeight in the page");
  const floorConst = code.match(/const FLOAT_OUT_MIN = (\d+);/);
  assert.ok(floorConst, "no FLOAT_OUT_MIN");
  const heightFor = new Function("FLOAT_OUT_MIN", `return function (${fn[1]}) {${fn[2]}\n  };`)(Number(floorConst[1]));

  // The floor is `.job-out`'s own min-height, read off the sheet: the drag stops where the sheet stops the box.
  const minRule = css.match(/\.job-out \{[^}]*min-height:\s*(\d+)px/);
  assert.ok(minRule, "the console has no min-height in the sheet");
  assert.equal(Number(floorConst[1]), Number(minRule[1]), "the drag's floor is the console's min-height");

  assert.equal(heightFor(132.5, 150, 34), 282.5, "the console takes exactly the height the frame gained");
  assert.equal(heightFor(132.5, -150, 34), 34, "a drag past the floor stops at the console's min-height");
  assert.equal(heightFor(20, -150, 34), 34, "never a negative height");
  // Down-right: non-decreasing at every step, whatever the width reflow does to the text.
  let prev = heightFor(132.5, 0, 34);
  for (let gained = 15; gained <= 150; gained += 15) {
    const now = heightFor(132.5, gained, 34);
    assert.ok(now >= prev, `down-right: ${gained}px of gain reduced the console (${prev} -> ${now})`);
    prev = now;
  }
  // Up-left: non-increasing, and it lands on the floor instead of going through it.
  prev = heightFor(132.5, 0, 34);
  for (let gained = -15; gained >= -300; gained -= 15) {
    const now = heightFor(132.5, gained, 34);
    assert.ok(now <= prev, `up-left: ${gained}px of gain grew the console (${prev} -> ${now})`);
    assert.ok(now >= 34, `up-left: ${gained}px went under the console's floor (${now})`);
    prev = now;
  }

  // And the gesture WRITES it, from the drawn frame - not from the pointer's arithmetic, and not left to the flex.
  assert.match(code, /const drawn = el\.getBoundingClientRect\(\)\.height - d\.box\.height;/, "the gain is the drawn frame's");
  assert.match(code, /cons\.style\.height = cssPx\(/, "the console's height is written");
  assert.match(code, /cons\.style\.maxHeight = cssPx\(/, "and its cap with it, or flex-grow hands it more than the drag did");
  assert.match(code, /rememberOutHeight\(cons\.dataset\.out/, "the size survives a rebuild through the console store");
});

test("the pane re-frames on load, on a save and on another tab's settings change — through one painter", () => {
  // One entry point decides which geometry runs, and it reads the panel's key every time rather than remembering it.
  assert.match(code, /function applyFrame\(force = false\)/);
  assert.match(code, /const mode = dockModeOf\(\);/);
  assert.match(code, /el\.classList\.toggle\("is-floating", mode === "floating"\)/);
  // The paths that have to land here: the boot, an open, a resize, every render, and the settings event that carries
  // a pick made in another tab. The assistant's own tab no longer changes the frame.
  assert.match(code, /function renderAssistant\(\) \{\n\s*const a = state\.assistant;\s*\n\s*applyFrame\(\);/,
    "every render re-frames from the panel's key — a save and the first snapshot both land here");
  assert.match(code, /el\.hidden = !state\.assistantOpen;\n\s*as\$\("btn-assistant"\)\?\.classList\.toggle\("is-on", state\.assistantOpen\);\n\s*applyFrame\(true\);/,
    "the boot applies the frame the panel's file asks for");
  assert.match(code, /if \(state\.assistantOpen\) \{\n\s*applyFrame\(true\);/,
    "opening the pane places it in whichever mode is in force");
  assert.match(code, /window\.addEventListener\("resize", \(\) => \{\n\s*if \(!state\.assistantOpen\) return;\n\s*applyFrame\(true\);/,
    "a resize re-measures the frame it is in");
  assert.match(code, /window\.__assistantFrame = \(\) => applyFrame\(\)/,
    "the General tab's save calls this painter by name");
  assert.match(settingsSrc, /window\.__assistantFrame\(\)/, "and a settings event from another tab re-frames this one");
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
