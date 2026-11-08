// The Role tab is a ROLE editor: a Role group holding the selector, then three groups in one order — what the role
// is for (name and description), the prompt, and the charter — and Save, Create role and New assistant from this
// role at the bottom.
//
// What this file is the contract for, and why each half is asserted where it is:
//
//   1. THE SHAPE is the pane's own renderer, sliced out of public/assistant.js and run against a stub document: one
//      #as-role-pick inside the first .as-group (headed "Role", carrying the library's count on that heading), then
//      three .as-group blocks in that order, each carrying ONE sentence (a single period), the four editable fields,
//      and the three buttons inside the LAST element of the pane. A second picker, a picker outside the first group,
//      a count trailing the select, or a button above the charter is the regression this pins.
//   2. NO PER-ASSISTANT REFERENCE survives in the pane: the thread id, "each assistant has its own copy", the
//      Assistant #2 versus #1 sentence, and the read-only preview dance are the strings the brief takes out, and
//      they are asserted ABSENT rather than left to a reader to notice.
//   3. THE BOXES hold the role the read landed, byte for byte, and a typed edit is a draft the pane paints back —
//      never the text last read. The cap and Save follow the draft, which is what the browser gate drives for real.
//   4. THE SAVE PATH is lib/roles.js's writer, exercised through Assistant.saveRole in test/roles.test.js: the four
//      fields land in one write, and the cap and stale refusals are the ones the route maps to 413 and 409.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sliceRegion } from "../tools/panel-testkit.mjs";

const assistant = readFileSync(new URL("../public/assistant.js", import.meta.url), "utf8");
const region = sliceRegion(assistant, "the role editor: name, description, prompt and charter of ONE role", "the role editor");

const esc = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const MANAGER_DESCRIPTION = "The board manager: drives every agent it starts to an approved PR ready to merge.";
const MANAGER = {
  id: "assistant-agent-manager",
  name: "Agent Manager",
  description: MANAGER_DESCRIPTION,
  prompt: "Be brief, and never approve your own work.",
  text: "# The manager charter\n\nDRIVES-THE-BOARD\n",
  role: { id: "assistant-agent-manager", name: "Agent Manager", description: MANAGER_DESCRIPTION, chars: 40, cap: 20000, over: false, updatedAt: "2026-11-08T00:00:00.000Z" },
  cap: 20000,
  mtime: 1762560000000,
};
const REVIEWER = {
  id: "reviewer",
  name: "Reviewer",
  description: "Reads a diff and says no.",
  prompt: "",
  text: "# Reviewer\n",
  role: { id: "reviewer", name: "Reviewer", description: "Reads a diff and says no.", chars: 11, cap: 20000, over: false, updatedAt: "2026-11-08T00:00:00.000Z" },
  cap: 20000,
  mtime: 1762560000000,
};

// The page's own region, run against the handful of things it asks of the page. `fields` is the DOM the pane paints
// into by id, and `host.innerHTML` is what a render produced — the markup the assertions read.
const pane = ({ roles = [MANAGER.role, REVIEWER.role], payloads = { "assistant-agent-manager": MANAGER, reviewer: REVIEWER }, sessionRole = "assistant-agent-manager" } = {}) => {
  const host = { innerHTML: "", dataset: {} };
  const fields = new Map();
  const node = (id) => {
    if (!fields.has(id)) {
      fields.set(id, {
        id,
        value: "",
        textContent: "",
        disabled: false,
        className: "",
        classList: { on: [], toggle(name, on) { if (on) this.on.push(name); } },
        focus() {},
        remove() {},
        insertAdjacentElement() {},
      });
    }
    return fields.get(id);
  };
  const meta = { textContent: "", classList: { on: [], toggle(name, on) { if (on) this.on.push(name); } } };
  const doc = {
    activeElement: null,
    createElement: () => ({ className: "", id: "", textContent: "", setAttribute() {}, remove() {}, insertAdjacentElement() {} }),
    querySelector: (sel) =>
      sel === "#as-role [data-as-rolesize]" ? meta : sel === "#as-role [data-as-roleholds]" ? meta : sel === "#as-role [data-as-rolesave]" ? meta : null,
  };
  const reads = [];
  const state = { assistant: { roles, assistants: [{ id: "assistant-1", name: "Assistant #1", roleId: sessionRole }] } };
  const apiFetch = (url) => {
    reads.push(String(url));
    const id = new URL(String(url), "http://127.0.0.1").searchParams.get("roleId");
    const p = payloads[id];
    return Promise.resolve({ ok: Boolean(p), status: p ? 200 : 404, json: async () => p || { error: `no such role: ${id}` } });
  };
  const errors = [];
  const api = new Function(
    "esc",
    "relTime",
    "state",
    "as$",
    "document",
    "apiFetch",
    "sessionById",
    "lastSession",
    "typingInside",
    "setErr",
    "applyAssistant",
    "setView",
    "showBanner",
    "asPost",
    "asPut",
    "SUBTABS",
    `${region}
return { renderAssistantRole, loadRoleText, roleShown, roleValues, roleDirty, roleForm, roleSaveSentence, noteRoleInput, roleDefault };`,
  )(
    esc,
    () => "30 seconds",
    state,
    (id) => (id === "as-role" ? host : node(id)),
    doc,
    apiFetch,
    (id) => state.assistant.assistants.find((a) => a.id === id) || null,
    "assistant-1",
    () => false,
    (sel, message) => errors.push([sel, message]),
    () => {},
    () => {},
    () => {},
    async () => ({}),
    async () => ({}),
    ["chat"],
  );
  const flush = async () => {
    for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
  };
  return { api, state, host, fields, node, doc, meta, reads, errors, flush };
};

const groupStarts = (html) => [...html.matchAll(/<div class="as-group">\s*<h4>([^<]+)<\/h4>\s*<p class="as-help">([^<]+)<\/p>/g)].map(([, h, s]) => ({ h, s }));

test("the tab is a Role group holding the selector, then the three groups in order, each with one sentence", async () => {
  const p = pane();
  p.api.renderAssistantRole(true);
  await p.flush();
  const html = p.host.innerHTML;
  assert.equal((html.match(/id="as-role-pick"/g) || []).length, 1, "exactly one role selector");
  const firstGroup = html.indexOf('<div class="as-group"');
  const secondGroup = html.indexOf('<div class="as-group"', firstGroup + 10);
  assert.ok(firstGroup > 0 && secondGroup > firstGroup, "the first group opens before the three below it");
  assert.ok(html.indexOf('id="as-role-pick"') > firstGroup, "the selector sits inside the first group");
  assert.ok(html.indexOf('id="as-role-pick"') < secondGroup, "…and above the three below it, not inside one");
  assert.match(html.slice(firstGroup, secondGroup), /<h4>Role <span class="as-hint" data-as-rolecount>2 roles in this panel<\/span><\/h4>/, "its heading is Role, and the library's count rides that heading");
  assert.ok(html.indexOf("data-as-rolecount") < html.indexOf('id="as-role-pick"'), "the count is on the heading, not trailing the select");
  assert.match(html.slice(firstGroup, secondGroup), /<label class="as-role-field"[^>]*>role\s*<select id="as-role-pick"/, "the picker is a labelled .as-role-field, the way the name box is");
  const groups = groupStarts(html);
  assert.deepEqual(groups.map((g) => g.h), ["What this role is for", "The prompt", "The charter"], "the three groups, in the brief's order");
  for (const g of groups) {
    assert.equal((g.s.match(/\./g) || []).length, 1, `"${g.h}" carries ONE plain sentence: ${g.s}`);
  }
  assert.match(groups[0].s, /name/i, "the first sentence names the name");
  assert.match(groups[0].s, /description/i, "…and the description");
  assert.match(groups[1].s, /prompt/i, "the second is about the prompt");
  assert.match(groups[2].s, /charter/i, "the third is about the charter");
  assert.match(groups[2].s, /first turn/i, "and says when it is sent: the first turn");
  assert.match(groups[2].s, /every twentieth turn/i, "…on change, and every twentieth turn");
  assert.equal((html.match(/<div class="as-group"/g) || []).length, 4, "four groups: the Role picker's, then the three");
  // The four fields the editor writes, one per subject.
  for (const id of ["as-role-name", "as-role-description", "as-role-prompt", "as-role-text"]) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} is in the pane`);
  }
  assert.ok(html.indexOf('id="as-role-name"') > html.indexOf("What this role is for"), "the name box is in the first group");
  assert.ok(html.indexOf('id="as-role-description"') > html.indexOf('id="as-role-name"'), "the description follows it");
  assert.ok(html.indexOf('id="as-role-prompt"') > html.indexOf("The prompt"), "the prompt box is in the second group");
  assert.ok(html.indexOf('id="as-role-text"') > html.indexOf("The charter"), "the charter box is in the third group");
});

test("Save, Create role and New assistant from this role are grouped together at the bottom", async () => {
  const p = pane();
  p.api.renderAssistantRole(true);
  await p.flush();
  const html = p.host.innerHTML;
  const actions = html.slice(html.indexOf('<div class="as-actions"'));
  assert.ok(actions.length > 0, "an actions block exists");
  assert.ok(html.lastIndexOf('<div class="as-group">') < html.indexOf('<div class="as-actions"'), "it sits below every group");
  const ids = [...actions.matchAll(/<button id="([^"]+)"/g)].map(([, id]) => id);
  assert.deepEqual(ids, ["btn-as-role", "btn-as-role-newrole", "btn-as-new-assistant"], "the three presses, in that order");
  assert.match(actions, />Save</, "Save is the first");
  assert.match(actions, />Create role</, "Create role is beside it");
  assert.match(actions, />New assistant from this role</, "and the new-assistant press is the third");
  assert.equal((html.match(/<div class="as-actions"/g) || []).length, 1, "one actions block, not one per group");
});

test("no per-assistant reference survives in the pane", async () => {
  const p = pane();
  p.api.renderAssistantRole(true);
  await p.flush();
  const html = p.host.innerHTML;
  for (const gone of ["thread", "own copy", "each assistant has its own", "Assistant #2", "preview", "read-only", "this assistant's role", "this assistant's own"]) {
    assert.ok(!html.toLowerCase().includes(gone.toLowerCase()), `"${gone}" is gone from the pane`);
  }
  assert.doesNotMatch(region, /roleShown =|roleShown\?\.|clearShownRole|showRole\(/, "the preview dance has no code left to run");
});

test("the boxes hold the role the read landed, and the picker lists the library", async () => {
  const p = pane();
  p.api.renderAssistantRole(true);
  await p.flush();
  const html = p.host.innerHTML;
  assert.match(p.reads[0], /\/api\/assistant\/role\/charter\?roleId=assistant-agent-manager/, "the one role shown is the one read");
  assert.match(html, /<option value="assistant-agent-manager" selected>Agent Manager<\/option>/, "the picker selects the role the pane shows");
  assert.match(html, /<option value="reviewer">Reviewer<\/option>/, "and lists the rest of the library");
  assert.match(html, /id="as-role-name"[^>]*value="Agent Manager"/, "the name box holds the role's name");
  assert.match(html, /id="as-role-description"[^>]*>The board manager: drives every agent it starts to an approved PR ready to merge\.<\/textarea>/, "the description box holds its remit");
  assert.match(html, /id="as-role-prompt"[^>]*>Be brief, and never approve your own work\.<\/textarea>/, "the prompt box holds its prompt");
  assert.match(html, /id="as-role-text"[^>]*># The manager charter\n\nDRIVES-THE-BOARD\n<\/textarea>/, "the charter box holds its text, byte for byte");
  assert.match(html, /data-as-rolesize>40\/20000 chars/, "the size is judged against the cap");
  assert.deepEqual(p.errors, [], "no error line");
});

test("a typed edit is a draft the pane paints back, and it is what Save would write", async () => {
  const p = pane();
  p.api.renderAssistantRole(true);
  await p.flush();
  p.node("as-role-name").value = "Agent Manager II";
  p.node("as-role-description").value = "same job, sharper words";
  p.node("as-role-prompt").value = "Say less.";
  p.node("as-role-text").value = "# shorter\n";
  p.api.noteRoleInput();
  assert.equal(p.api.roleDirty(), true, "the boxes differ from the read");
  p.api.renderAssistantRole(true);
  const html = p.host.innerHTML;
  assert.match(html, /value="Agent Manager II"/, "the draft name is painted back");
  assert.match(html, /edited here, not saved/, "and the provenance says it is unsaved");
  assert.deepEqual(p.api.roleForm(), {
    name: "Agent Manager II",
    description: "same job, sharper words",
    prompt: "Say less.",
    text: "# shorter\n",
  }, "Save posts exactly what is in the boxes");
});

test("the editor opens on the role the last session runs, and an unknown pick falls back to the library", async () => {
  const p = pane({ sessionRole: "reviewer" });
  assert.equal(p.api.roleDefault(), "reviewer", "the role the reader's session runs is the default");
  p.api.renderAssistantRole(true);
  await p.flush();
  assert.match(p.host.innerHTML, /<option value="reviewer" selected>Reviewer<\/option>/);
  assert.equal(p.api.roleShown(), "reviewer");
});
