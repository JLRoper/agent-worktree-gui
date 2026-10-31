// The one switch that stops agents removing their own worktrees.
//
// A worker never deletes its own tree — its shell is inside it — so it asks with a `RELEASE` line and the panel
// decides afterwards (lib/worktrees.js). That is the process this file puts a switch in front of: sometimes the
// reader wants the trees left exactly where they are, to read and remove them one at a time from the ✕.
//
// Four facts, each driven rather than read off the source:
//
//   1. the normaliser: a MISSING key reads as ON (an install written before this row existed behaved as if it were),
//      and only the literal `true` leaves it open — a hand-edited "off", a 1 or a "true" string must never keep a
//      delete open, and the switch is a VETO, so `on` still needs the project's own grant;
//   2. POST /api/settings/cleanup writes the panel's own config.json, answers with the stored value, applies to a
//      process that never saw the browser, and writes OFF for a body that names nothing;
//   3. the Settings row lives in the Board group, asks for the switch, and names BOTH clean-ups it closes;
//   4. the page's paint tells "on, and these projects carry the grant" apart from "on, but no project does" and from
//      "off", and a rejected save is not painted as a saved one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { AGENT_CLEANUP_DEFAULT, agentCleanupFrom, releasesEnabled } from "../lib/worktrees.js";
import { post, startPanel } from "../tools/panel-testkit.mjs";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

// ---- 1. the normaliser ----------------------------------------------------------------------------------------------
test("a missing switch is ON, and only the literal `true` keeps it open", () => {
  assert.equal(AGENT_CLEANUP_DEFAULT, true, "an install that predates this row kept its behaviour");
  assert.equal(agentCleanupFrom(undefined), true, "no key is not a veto");
  assert.equal(agentCleanupFrom(true), true);
  for (const value of [false, null, "true", "on", 1, 0, "", {}]) {
    assert.equal(agentCleanupFrom(value), false, `${JSON.stringify(value)} must never keep a delete open`);
  }
});

test("the switch is a veto above the project's grant, never a grant of its own", () => {
  // `releasesEnabled` is untouched by the board switch: the executor is handed the switch separately, so a project
  // without its own `releaseWorktrees: true` stays closed however the row is set.
  assert.equal(releasesEnabled({ releaseWorktrees: true }), true);
  assert.equal(releasesEnabled({ releaseWorktrees: false }), false);
  assert.equal(releasesEnabled({}), false, "no project grant is still no grant");
});

// ---- 2. the route ---------------------------------------------------------------------------------------------------
test("POST /api/settings/cleanup stores the switch in config.json, and it survives a restart", async (t) => {
  const panel = await startPanel({ keep: true });
  const first = await post(panel.base, "/api/settings/cleanup", { body: { agentCleanup: false } });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.agentCleanup, false);
  assert.equal(first.json.settings.agentCleanup, false);
  // What is in FORCE and what was WRITTEN are two different reads: the answer is the first, the file the next boot
  // believes is the second.
  const cfg = JSON.parse(readFileSync(path.join(panel.dir, "config.json"), "utf8"));
  assert.equal(cfg.agentCleanup, false);
  const live = await (await fetch(`${panel.base}/api/config`)).json();
  assert.equal(live.agentCleanup, false);
  assert.ok(Array.isArray(live.releaseProjects), "the row is told which projects would actually clean up");
  await panel.stop();

  const again = await startPanel({ dir: panel.dir, keep: false, reuseConfig: true });
  t.after(() => again.stop());
  const after = await (await fetch(`${again.base}/api/config`)).json();
  assert.equal(after.agentCleanup, false, "the switch is the panel's, not the tab's");

  // A body that names nothing writes OFF rather than assuming a delete permission.
  const blank = await post(again.base, "/api/settings/cleanup", { body: {} });
  assert.equal(blank.status, 200, blank.text);
  assert.equal(blank.json.agentCleanup, false);
  assert.equal(JSON.parse(readFileSync(path.join(panel.dir, "config.json"), "utf8")).agentCleanup, false);

  const on = await post(again.base, "/api/settings/cleanup", { body: { agentCleanup: true } });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.json.agentCleanup, true, "on is a literal true, not `anything but false`");
  assert.equal(JSON.parse(readFileSync(path.join(panel.dir, "config.json"), "utf8")).agentCleanup, true);
});

// ---- 3. the Settings row ---------------------------------------------------------------------------------------------
test("the row is in the Board group and names both clean-ups it closes", () => {
  const board = html.slice(html.indexOf('data-settings-group="board"'), html.indexOf('data-settings-group="branches"'));
  assert.ok(board.length > 0, "the Board group is in the page");
  assert.match(board, /<label class="settings-row settings-gap" for="agent-cleanup"/);
  assert.match(board, /<span>Agents clean up /);
  assert.match(board, /<input id="agent-cleanup" type="checkbox"/);
  assert.match(board, /id="agent-cleanup-preview"/, "the row says what the switch leaves in force");
  // The tooltip is the only explanation a reader gets: both paths have to be in it, and the project's own grant.
  const title = (board.match(/for="agent-cleanup" title="([^"]+)"/) || [])[1] || "";
  assert.match(title, /releaseWorktrees/, "it names the project-level grant it sits above");
  assert.match(title, /LANDED: YES/, "it names the check agent's answer, not only the RELEASE line");
  assert.match(title, /config\.json \(agentCleanup\)/, "it says where the value is stored");
});

// ---- 4. the paint ---------------------------------------------------------------------------------------------------
const begin = src.indexOf("// ---- whether an agent may clean up after itself");
const end = src.indexOf("// ---- end agent cleanup");
assert.ok(begin > 0 && end > begin, "the agent-cleanup region is in public/app.js");
const region = src.slice(begin, end);

function paint(settings, { note = "", bad = false, checked = null } = {}) {
  const box = { checked, addEventListener() {} };
  const preview = { textContent: "", classList: { toggle() {} } };
  const els = { "agent-cleanup": box, "agent-cleanup-preview": preview };
  const $ = (id) => els[id] || null;
  const api = new Function("state", "$", `${region}\nreturn { paintAgentCleanup, agentCleanupStored };`)({ settings }, $);
  api.paintAgentCleanup(note, bad);
  return { box, preview };
}

test("on names the projects that would actually clean up, so the row cannot read as \"every repo\"", () => {
  const one = paint({ agentCleanup: true, releaseProjects: ["agent-worktree-gui"] });
  assert.equal(one.box.checked, true);
  assert.match(one.preview.textContent, /on — a project's own releaseWorktrees grant decides, and it names agent-worktree-gui/);
  assert.match(one.preview.textContent, /set in config\.json \(agentCleanup\)/, "the row says where it is stored");

  const none = paint({ agentCleanup: true, releaseProjects: [] });
  assert.equal(none.box.checked, true);
  assert.match(none.preview.textContent, /on — but no project carries a releaseWorktrees grant, so nothing is removed automatically either/);
});

test("off says what stops, not just that a box is unticked", () => {
  const off = paint({ agentCleanup: false, releaseProjects: ["agent-worktree-gui"] });
  assert.equal(off.box.checked, false);
  assert.match(off.preview.textContent, /off — no prompt carries RELEASE/);
  assert.match(off.preview.textContent, /a LANDED: YES is only a line in the console/);
  assert.match(off.preview.textContent, /the ✕ still removes a tree/, "the reader's own delete is not switched off");
});

test("a missing key paints ON, and a rejected save leaves the reader's press alone", () => {
  const missing = paint({});
  assert.equal(missing.box.checked, true, "an install that never wrote the key reads as on");

  const failed = paint({ agentCleanup: false }, { note: "could not change it: HTTP 500", bad: true, checked: true });
  assert.equal(failed.box.checked, true, "the box stays where the reader put it — the save is what failed");
  assert.match(failed.preview.textContent, /^NOT SAVED — could not change it: HTTP 500\. config\.json still says: off\./);
});
