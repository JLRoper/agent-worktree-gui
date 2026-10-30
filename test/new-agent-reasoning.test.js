import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { REASONING_EFFORTS } from "../lib/reasoning.js";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("New Agent has a reasoning selector instead of a nonfunctional YOLO checkbox", () => {
  assert.ok(/<select\b[^>]*id="job-reasoning"/.test(html), "New Agent must expose a reasoning selector");
  assert.ok(!/id="job-yolo"/.test(html), "the nonfunctional YOLO checkbox must be removed");
  const select = html.match(/<select\b[^>]*id="job-reasoning"[^>]*>([\s\S]*?)<\/select>/)[1];
  assert.deepEqual([...select.matchAll(/<option value="([^"]*)"/g)].map((match) => match[1]), ["", ...REASONING_EFFORTS]);
});

test("the actual spawn form reads the reasoning choice and the row shortcut resets it", () => {
  const fields = new Map([
    ["job-prompt", { value: "task" }], ["job-cwd", { value: "C:/fixture" }],
    ["job-create", { checked: true }], ["job-landing", { checked: false }],
    ["job-project", { value: "fixture" }], ["job-model", { value: "model" }],
    ["job-budget", { value: "1800" }], ["job-maxTurns", { value: "" }],
    ["job-reasoning", { value: "medium", disabled: false }],
  ]);
  const formSource = app.slice(app.indexOf("function formValues()"), app.indexOf("// ---------------- worktrees", app.indexOf("function formValues()")));
  const form = new Function("$", "readBox", `${formSource}; return formValues;`)((id) => fields.get(id), (box) => box.value);
  assert.equal(form().reasoningEffort, "medium");
  fields.get("job-reasoning").disabled = true;
  assert.equal(form().reasoningEffort, undefined, "an unavailable control must not send a stale selection");
  fields.get("job-reasoning").disabled = false;
  fields.get("job-reasoning").value = "";
  assert.equal(form().reasoningEffort, undefined, "default leaves Hermes configuration alone");
  const resetSource = app.slice(app.indexOf("function resetSpawnDefaults()"), app.indexOf('// The green "+"', app.indexOf("function resetSpawnDefaults()")));
  const reset = new Function("$", `${resetSource}; return resetSpawnDefaults;`)((id) => fields.get(id));
  fields.get("job-reasoning").value = "high";
  reset();
  assert.equal(fields.get("job-reasoning").value, "");
});
