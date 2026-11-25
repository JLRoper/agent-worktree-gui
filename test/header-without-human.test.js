// The header WITHOUT the Human control, and the four kinds it used to count.
//
// The Human button was the last step of the header plan: one control whose badge counted permissions, clarify
// questions, review items and collisions, plus the H key that stepped through all four. Three of those kinds got
// their own header control first (Permissions #920, Collisions #922, Clarify before them), and the fourth - review
// items - is counted by the Review control that was already in the header. So the button has been removed, not
// replaced: this file pins the absence, and pins that each kind still has a surface a reader can see and press.
//
// WHAT IT DOES NOT PROVE. That a permission, a question, a collision or a review row actually REACHES the page.
// That is tools/verify-header-without-human.mjs's job, which boots the real panel and drives the real buttons, at
// two widths. This file is the source-level half: nothing left behind that points at the removed control, and no
// dangling Settings tab.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");
const html = read("public/index.html");
const app = read("public/app.js");
const css = read("public/style.css");
const pkg = JSON.parse(read("package.json"));

test("the Human control is gone: button, badge, label, tab, panel and every switch", () => {
  for (const id of ["btn-human", "human-badge", "human-label", "settings-tab-human", "settings-panel-human", "human-kind-permissions", "human-kind-clarify", "human-kind-review", "human-kind-collisions", "human-kinds-preview"]) {
    assert.equal(html.indexOf(`id="${id}"`), -1, `#${id} is still in the markup`);
  }
  assert.doesNotMatch(html, /🙋/, "the glyph went with the button");
  assert.doesNotMatch(html, /data-settings-tab="human"/, "no tab carries the removed group");
});

test("the rotation's code is gone from the page: the painter, the list, the step and the H key", () => {
  for (const name of ["paintHumanButton", "humanQuestions", "humanStep", "humanShow", "humanShowReview", "humanShowCollision", "humanLandOnQuestion", "humanFocusNow", "humanRefocus", "humanTick", "humanKinds", "paintHumanKinds", "reviewRotationRows", "collisionRotationRows", "humanQuestionKey", "humanFlushTimer"]) {
    assert.equal(app.indexOf(name), -1, `${name} is still in public/app.js`);
  }
  assert.doesNotMatch(app, /e\.key === "h"|e\.key === "H"/, "H is no longer claimed by the page");
  assert.doesNotMatch(app, /human-flash/, "the prompt ring went with the rotation");
  assert.doesNotMatch(css, /btn-human|human-badge|human-flash|humanflash/, "no stylesheet rule survives for the removed control");
});

test("each of the four kinds keeps a header surface, and every one of them is bound", () => {
  // Permissions, Clarify, Collisions: a button, a badge, and a popover the button controls. The popover is CREATED
  // by the module that draws it (it is not in the shell's markup), so the target is proved in the module's own source.
  for (const [btn, badge, pop, file] of [
    ["btn-permissions", "permissions-badge", "permissions-pop", "public/permissions-history.js"],
    ["btn-clarify", "clarify-badge", "clarify-pop", "public/clarify-history.js"],
    ["btn-collisions", "collisions-badge", "collisions-pop", "public/collision-history.js"],
  ]) {
    const tag = html.match(new RegExp(`<button id="${btn}"[^>]*>`));
    assert.ok(tag, `#${btn} is in the header`);
    assert.match(tag[0], new RegExp(`aria-controls="${pop}"`), `#${btn} names its popover`);
    assert.match(read(file), new RegExp(`pop\\.id = "${pop}"`), `${pop} is created by ${file}`);
    assert.ok(html.includes(`id="${badge}"`), `#${badge} is in the button`);
    assert.ok(app.includes(`$("${btn}")`), `#${btn} has a press bound in app.js`);
  }
  // Review items: the header's one count, with a badge and a filter press, and a bulk press beside it.
  assert.ok(html.includes('id="btn-review"'), "#btn-review is in the header");
  assert.ok(html.includes('id="review-badge"'), "the review count is drawn");
  assert.match(app, /function paintReviewChip\(\)/, "the review count has its painter");
  assert.match(app, /wtReviewLane\.count\(state\.rows\.values\(\)\)/, "and it counts the rows the board draws");
  assert.ok(html.includes('id="btn-review-all"'), "the bulk press survives");
});

test("no Settings tab points at a panel that is not there, and no panel is orphaned", () => {
  const tabs = [...html.matchAll(/<button[^>]*class="settings-tab"[^>]*id="([^"]+)"[^>]*aria-controls="([^"]+)"/g)].map((m) => ({ tab: m[1], panel: m[2] }));
  const panels = [...html.matchAll(/<div class="settings-group" id="([^"]+)"[^>]*data-settings-group="([^"]+)"/g)].map((m) => ({ id: m[1], group: m[2] }));
  assert.ok(tabs.length >= 10, `the tab strip is still the settings surface (${tabs.length} tabs)`);
  assert.ok(panels.length >= 10, `every group still has its panel (${panels.length} panels)`);
  for (const { tab, panel } of tabs) {
    assert.ok(panels.some((p) => p.id === panel), `#${tab} controls a panel that exists (${panel})`);
  }
  for (const { id, group } of panels) {
    assert.ok(tabs.some((t) => t.panel === id), `#${id} is reachable from a tab (${group})`);
  }
  // The remembered-tab list, if the page keeps one, carries no dead name.
  assert.doesNotMatch(html, /"human"\s*,?\s*\]/, "no list of tab names keeps the removed group");
});

test("the two harnesses whose subject was removed are gone, and the survivor gate is wired", () => {
  assert.equal(existsSync(path.join(ROOT, "tools", "verify-human-button.mjs")), false, "the rotation's gate is deleted");
  assert.equal(existsSync(path.join(ROOT, "tools", "verify-human-kinds.mjs")), false, "the switches' gate is deleted");
  const scripts = Object.values(pkg.scripts || {}).join("\n");
  assert.doesNotMatch(scripts, /verify-human-button|verify-human-kinds/, "no package script names a deleted gate");
  assert.match(scripts, /verify-header-without-human/, "the removal's own gate is wired in the same commit");
  assert.match(scripts, /verify-review-lane/, "and the review lane's gate still is");
});
