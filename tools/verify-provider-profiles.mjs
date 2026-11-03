#!/usr/bin/env node
// verify-provider-profiles.mjs — the Gateway tab's saved (URL, key) pairs: where the secret lives, what the
// routes answer, and whether Apply really writes the pair through writeProviderSettings.
//
// WHAT THIS PROVES, and why each one is worth a boot:
//
//   1. THE STORE IS OUTSIDE THE CHECKOUT. A key in a file under the repository is a key in every clone and in
//      the pull request that added it. The file the panel names has to resolve inside its own data directory
//      and outside this checkout, and the file has to exist after a save.
//   2. NO ANSWER CARRIES THE KEY. Not the save, not the list, not the apply — the browser only ever learns
//      whether a key is set and its last four, which is what the config.yaml field already says.
//   3. APPLY IS writeProviderSettings. config.yaml ends up holding model.base_url and model.api_key — the same
//      two lines the URL/key rows write — and the panel's own providerState agrees.
//   4. DELETE TAKES THE KEY. The record and its key leave the file together; no orphaned secret is left behind,
//      and a second delete of the same id is a 404 rather than a pretend success.
//   5. TWO RESTART BUTTONS, ONE TARGET EACH. The markup carries exactly two, both bound, and the handler posts
//      one request per press. The route is exercised only with a REFUSABLE request (no reason): a real restart
//      would bounce this machine's gateway, and the point here is the shape, not the bounce.
//
//   npm run verify:provider-profiles
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createVerifier, post, ROOT, startPanel } from "./panel-testkit.mjs";

const KEY_A = "sk-or-v1-aaaaaaaaaaaaaaaa1111";
const KEY_B = "sk-or-v1-bbbbbbbbbbbbbbbb2222";
const URL_A = "https://openrouter.ai/api/v1";
const URL_B = "https://gateway.internal.example/v1";
const v = createVerifier();
const lastFour = (k) => k.slice(-4);
const carries = (haystack, needle) => String(haystack).includes(needle);

const dir = await mkdtemp(path.join(os.tmpdir(), "wag-verify-profiles-"));
const home = path.join(dir, "hermes");
const configPath = path.join(home, "config.yaml");
await mkdir(home, { recursive: true });
await writeFile(configPath, "model:\n  provider: openrouter\n  base_url: https://openrouter.ai/api/v1\n", "utf8");

let panel = null;
try {
  panel = await startPanel({ dir, token: "verify-profile-token", env: { HERMES_HOME: home } });
  const token = "verify-profile-token";
  const get = async (route) => {
    const r = await fetch(`${panel.base}${route}`);
    return { status: r.status, json: await r.json(), text: "" };
  };

  // 1. empty, and the store's own path
  const empty = await get("/api/settings/provider/profiles");
  v.ok("GET profiles answers", empty.status === 200, `status ${empty.status}`);
  v.check("nothing saved yet", empty.json.count, 0);
  const file = empty.json.file;
  v.ok("the store path is inside the panel's data dir", Boolean(file) && path.resolve(file).startsWith(path.resolve(dir)), file);
  v.ok("the store path is OUTSIDE the checkout", Boolean(file) && !path.resolve(file).startsWith(path.resolve(ROOT)), file);

  // 2. save, and what the answer may carry
  const saved = await post(panel.base, "/api/settings/provider/profiles", { token, body: { name: "OpenRouter", baseUrl: URL_A, apiKey: KEY_A } });
  v.ok("POST profiles saves", saved.status === 200, saved.text.slice(0, 200));
  v.ok("the save answer does not carry the key", !carries(saved.text, KEY_A));
  v.ok("the save answer shows the last four", carries(saved.text, lastFour(KEY_A)), lastFour(KEY_A));
  const idA = saved.json.saved?.id;
  v.ok("the saved row has an id and a name", Boolean(idA) && saved.json.saved.name === "OpenRouter");
  const store = await readFile(file, "utf8");
  v.ok("the store file holds the key (Apply is the only reader)", carries(store, KEY_A), file);

  const listed = await get("/api/settings/provider/profiles");
  v.ok("GET profiles does not carry the key", !carries(JSON.stringify(listed.json), KEY_A));
  v.check("one profile is listed", listed.json.count, 1);

  // 3. apply: the pair lands in config.yaml via writeProviderSettings
  const applied = await post(panel.base, "/api/settings/provider/apply", { token, body: { id: idA } });
  v.ok("POST apply answers 200", applied.status === 200, applied.text.slice(0, 200));
  v.ok("the apply answer does not carry the key", !carries(applied.text, KEY_A));
  v.ok("the apply answer names the profile it applied", applied.json.applied?.name === "OpenRouter", JSON.stringify(applied.json.applied || null));
  const config = await readFile(configPath, "utf8");
  v.ok("config.yaml carries the profile's URL", carries(config, URL_A));
  v.ok("config.yaml carries the profile's key", carries(config, KEY_A));
  const state = await get("/api/settings/provider");
  v.ok("the provider state reads the applied URL back", state.json.baseUrl === URL_A, String(state.json.baseUrl));
  v.ok("the provider state shows the key's last four", carries(String(state.json.key?.masked), lastFour(KEY_A)), String(state.json.key?.masked));

  // 4. a rename with an empty key box keeps the key; a delete takes it away
  const renamed = await post(panel.base, "/api/settings/provider/profiles", { token, body: { id: idA, name: "OpenRouter (renamed)", baseUrl: URL_A, apiKey: "" } });
  v.ok("Edit with an empty key box keeps the stored key", renamed.status === 200 && carries(await readFile(file, "utf8"), KEY_A), renamed.text.slice(0, 200));
  v.ok("Edit does not echo the kept key", !carries(renamed.text, KEY_A));

  const second = await post(panel.base, "/api/settings/provider/profiles", { token, body: { name: "Proxied", baseUrl: URL_B, apiKey: KEY_B } });
  v.ok("a second profile saves", second.status === 200, second.text.slice(0, 200));
  const idB = second.json.saved?.id;
  const deleted = await post(panel.base, "/api/settings/provider/profiles/delete", { token, body: { id: idB } });
  v.ok("DELETE removes the profile", deleted.status === 200 && deleted.json.count === 1, deleted.text.slice(0, 200));
  v.ok("the delete answer does not carry the removed key", !carries(deleted.text, KEY_B));
  v.ok("the deleted profile's key is gone from the store", !carries(await readFile(file, "utf8"), KEY_B));
  const again = await post(panel.base, "/api/settings/provider/profiles/delete", { token, body: { id: idB } });
  v.ok("a second delete of the same id is a 404", again.status === 404, `status ${again.status}`);

  const nowhere = await post(panel.base, "/api/settings/provider/apply", { token, body: { id: "nosuchid" } });
  v.ok("applying an unknown profile is a 404", nowhere.status === 404, `status ${nowhere.status}`);

  // 5. the two restart controls, and the route they post to
  const html = readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const app = readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const restartIds = [...html.matchAll(/id="(btn-restart-[a-z]+)"/g)].map(([, id]) => id);
  v.check("exactly two restart buttons", restartIds, ["btn-restart-gateway", "btn-restart-panel"]);
  v.ok("no control restarts both at once", !/restart-(both|all)/i.test(html));
  const pickerAt = html.indexOf('id="provider-profile-row"');
  v.ok("the picker is above the URL and key rows", pickerAt > 0 && pickerAt < html.indexOf('id="provider-url"') && html.indexOf('id="provider-url"') < html.indexOf('id="provider-key"'));
  for (const id of ["provider-profile", "btn-provider-profile-save", "btn-provider-profile-edit", "btn-provider-profile-delete", "btn-provider-profile-apply"]) {
    v.ok(`the tab carries #${id}`, html.includes(`id="${id}"`));
  }
  const handler = app.slice(app.indexOf("async function restartFromSettings"), app.indexOf("// ---- the model menu's prices"));
  v.ok("one press posts one restart request", (handler.match(/apiFetch\(/g) || []).length === 1);
  v.ok("the restart body carries target, reason and waitFor", /target,/.test(handler) && /reason:/.test(handler) && /waitFor:/.test(handler));
  const gatewayAt = app.indexOf('$("btn-restart-gateway")?.addEventListener');
  const panelAt = app.indexOf('$("btn-restart-panel")?.addEventListener');
  v.ok("each button is bound to its own target", gatewayAt > 0 && panelAt > gatewayAt && /restartFromSettings\("gateway"/.test(app.slice(gatewayAt, panelAt)));

  // The route itself, with a request it must REFUSE: no reason means nothing is queued, so this cannot bounce
  // the gateway the check is running beside.
  const refused = await post(panel.base, "/api/restart", { token, body: { target: "gateway", reason: "" } });
  v.ok("POST /api/restart refuses a reasonless request", refused.status === 400, `status ${refused.status}`);
  v.ok("the refusal says why", carries(refused.text, "reason"), refused.text.slice(0, 160));

  // The key must not have leaked into any answer collected along the way.
  for (const [name, body] of Object.entries({ saved: saved.text, listed: JSON.stringify(listed.json), applied: applied.text, deleted: deleted.text })) {
    v.ok(`${name} carries no key`, !carries(body, KEY_A) && !carries(body, KEY_B));
  }
} catch (e) {
  console.log(`FAIL  the run threw before it finished — ${String((e && e.stack) || e)}`);
} finally {
  try {
    if (panel) await panel.stop();
  } catch {
    /* a panel the run already killed */
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

console.log(`\n${v.failures === 0 ? "PASS" : "FAIL"}  provider profiles — ${v.checks - v.failures}/${v.checks} checks passed`);
process.exit(v.failures === 0 ? 0 : 1);
