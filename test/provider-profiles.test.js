// The saved provider profiles: one named (base URL, key) pair, applied through writeProviderSettings.
//
// The store carries API keys, so most of what is asserted here is about what does NOT happen: no key in a
// list, no key in a route's answer, no key left behind after a delete, no key in a file inside the checkout.
// The rest is the behaviour a reader meets — Save as / Edit / Delete / Apply, and the two restart buttons
// being two independent presses rather than one chained action.
//
// Two halves. The module half runs over a temp directory and is pure file I/O. The route half boots a real
// server.js through tools/panel-testkit.mjs, because "apply writes config.yaml" is a claim about the write
// path the URL and key rows already use, and a stub would prove only that the stub works.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { post, startPanel, ROOT } from "../tools/panel-testkit.mjs";
import {
  PROFILES_VERSION,
  deleteProfile,
  listProfiles,
  normalizeBaseUrl,
  profileWithKey,
  readProfilesFile,
  saveProfile,
  looksLikeKey,
} from "../lib/provider-profiles.js";
import { providerState, writeProviderSettings } from "../lib/hermes-config.js";

const KEY_A = "sk-or-v1-aaaaaaaaaaaaaaaa1111";
const KEY_B = "sk-or-v1-bbbbbbbbbbbbbbbb2222";
const URL_A = "https://openrouter.ai/api/v1";
const URL_B = "https://gateway.internal.example/v1";
const lastFour = (k) => k.slice(-4);

// The key must never appear in an answer, in a list row, or in a file the repository can see.
const carries = (haystack, needle) => String(haystack).includes(needle);

async function tempStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wag-profiles-"));
  return { dir, file: path.join(dir, "state", "provider-profiles.json") };
}

// ---- the module -------------------------------------------------------------------------------------

test("a saved profile keeps its key on disk and shows only the last four", async () => {
  const { dir, file } = await tempStore();
  const saved = saveProfile({ file, name: "OpenRouter", baseUrl: URL_A, apiKey: KEY_A });
  assert.equal(saved.created, true);
  assert.equal(saved.profile.name, "OpenRouter");
  assert.equal(saved.profile.key.set, true);
  assert.match(saved.profile.key.masked, new RegExp(`${lastFour(KEY_A)}$`));
  assert.equal(carries(JSON.stringify(saved.profile), KEY_A), false, "the saved record as the page sees it carries no key");
  assert.equal(carries(JSON.stringify(saved.profiles), KEY_A), false, "nor does the list it returns");

  const onDisk = await readFile(file, "utf8");
  assert.ok(carries(onDisk, KEY_A), "the store itself holds the key — it is the only copy Apply reads");
  assert.equal(JSON.parse(onDisk).version, PROFILES_VERSION);

  const listed = listProfiles({ file });
  assert.equal(listed.count, 1);
  assert.equal(listed.profiles[0].baseUrl, URL_A);
  assert.equal(carries(JSON.stringify(listed), KEY_A), false, "listProfiles never returns a key");
  assert.equal(listed.file, file);

  const withKey = profileWithKey({ file, id: saved.profile.id });
  assert.equal(withKey.apiKey, KEY_A, "profileWithKey is the one reader that hands the key back, for Apply only");
  await rm(dir, { recursive: true, force: true });
});

test("Save as refuses a duplicate name and a missing key; Edit keeps the stored key when the box is empty", async () => {
  const { dir, file } = await tempStore();
  const first = saveProfile({ file, name: "Proxied", baseUrl: URL_A, apiKey: KEY_A });
  assert.throws(() => saveProfile({ file, name: "proxied", baseUrl: URL_B, apiKey: KEY_B }), /already a profile named/);
  assert.throws(() => saveProfile({ file, name: "No key", baseUrl: URL_A, apiKey: "" }), /needs a key/);
  assert.throws(() => saveProfile({ file, name: "No url", baseUrl: "", apiKey: KEY_A }), /needs the endpoint URL/);
  assert.throws(() => saveProfile({ file, name: "", baseUrl: URL_A, apiKey: KEY_A }), /needs a name/);
  assert.throws(() => saveProfile({ file, name: "Bad key", baseUrl: URL_A, apiKey: "short" }), /does not look like an API key/);
  assert.throws(() => saveProfile({ file, name: "Bad url", baseUrl: "ftp://x.example", apiKey: KEY_A }), /http or https/);
  assert.throws(() => saveProfile({ file, name: "Bad url", baseUrl: "not a url", apiKey: KEY_A }), /http\(s\) address/);

  // Rename + new URL, key box empty: the credential it already holds must survive.
  const edited = saveProfile({ file, id: first.profile.id, name: "Proxied (eu)", baseUrl: `${URL_B}/`, apiKey: "" });
  assert.equal(edited.created, false);
  assert.equal(edited.profile.name, "Proxied (eu)");
  assert.equal(edited.profile.baseUrl, URL_B, "a trailing slash is dropped, as writeProviderSettings does");
  assert.equal(profileWithKey({ file, id: first.profile.id }).apiKey, KEY_A);

  // A key typed into the box replaces it.
  saveProfile({ file, id: first.profile.id, name: "Proxied (eu)", baseUrl: URL_B, apiKey: KEY_B });
  assert.equal(profileWithKey({ file, id: first.profile.id }).apiKey, KEY_B);
  assert.equal(carries(await readFile(file, "utf8"), KEY_A), false, "the replaced key is gone from the store, not shadowed");

  // Two profiles: the LIST is sorted by name and each keeps its own key.
  const second = saveProfile({ file, name: "Alpha", baseUrl: URL_A, apiKey: KEY_A });
  assert.deepEqual(listProfiles({ file }).profiles.map((p) => p.name), ["Alpha", "Proxied (eu)"]);
  assert.equal(profileWithKey({ file, id: second.profile.id }).apiKey, KEY_A);
  await rm(dir, { recursive: true, force: true });
});

test("Delete removes the key with the record instead of leaving it orphaned", async () => {
  const { dir, file } = await tempStore();
  const one = saveProfile({ file, name: "One", baseUrl: URL_A, apiKey: KEY_A });
  saveProfile({ file, name: "Two", baseUrl: URL_B, apiKey: KEY_B });

  const dropped = deleteProfile({ file, id: one.profile.id });
  assert.equal(dropped.removed.name, "One");
  assert.equal(carries(JSON.stringify(dropped), KEY_A), false, "the delete answer does not hand the key back either");
  const onDisk = await readFile(file, "utf8");
  assert.equal(carries(onDisk, KEY_A), false, "the deleted profile's key is not in the file any more");
  assert.ok(carries(onDisk, KEY_B), "the profile that stayed keeps its key");
  assert.equal(listProfiles({ file }).count, 1);
  assert.equal(profileWithKey({ file, id: one.profile.id }), null);
  assert.equal(deleteProfile({ file, id: one.profile.id }), null, "a second delete of the same id removes nothing");
  await rm(dir, { recursive: true, force: true });
});

test("a corrupt or newer store is read forgivingly, and never rewritten behind the reader's back", async () => {
  const { dir, file } = await tempStore();
  await mkdir(path.dirname(file), { recursive: true });

  await writeFile(file, "{ this is not json", "utf8");
  const broken = readProfilesFile(file);
  assert.equal(broken.profiles.length, 0);
  assert.equal(broken.warnings.length, 1);
  assert.match(broken.warnings[0], /not JSON/);
  // Saving again replaces the unreadable file, which is the only way out of it.
  saveProfile({ file, name: "Fresh", baseUrl: URL_A, apiKey: KEY_A });
  assert.equal(listProfiles({ file }).count, 1);

  // A record with no name is dropped and named in the warnings, not silently rendered as a blank row.
  await writeFile(file, JSON.stringify({ version: 1, profiles: [{ id: "abc", baseUrl: URL_A, apiKey: KEY_A }, { name: "Named", id: "def", baseUrl: URL_B, apiKey: KEY_B }] }), "utf8");
  const partly = readProfilesFile(file);
  assert.deepEqual(partly.profiles.map((p) => p.name), ["Named"]);
  assert.match(partly.warnings.join(" "), /no name/);

  // A NEWER document is shown by name, its keys are not used, and a save refuses to rewrite it.
  await writeFile(file, JSON.stringify({ version: PROFILES_VERSION + 1, profiles: [{ id: "zzz", name: "Future", baseUrl: URL_A, apiKey: KEY_A }] }), "utf8");
  const future = readProfilesFile(file);
  assert.equal(future.profiles.length, 1);
  assert.equal(future.profiles[0].apiKey, "", "a newer shape's key is not handed to this code");
  assert.match(future.warnings.join(" "), /newer panel/);
  assert.equal(profileWithKey({ file, id: "zzz" }), null);
  assert.throws(() => saveProfile({ file, name: "Nope", baseUrl: URL_A, apiKey: KEY_A }), /newer panel/);
  await rm(dir, { recursive: true, force: true });
});

test("the URL and key rules are the ones the config.yaml writer already applies", () => {
  assert.equal(normalizeBaseUrl("https://a.example/v1///"), "https://a.example/v1");
  assert.equal(normalizeBaseUrl("  "), "");
  assert.throws(() => normalizeBaseUrl("mailto:x@y.example"), /http or https/);
  assert.equal(looksLikeKey("abcdefgh"), true);
  assert.equal(looksLikeKey("short"), false);
  assert.equal(looksLikeKey("has space inside"), false);
  // The same key the profile store accepts is the one writeProviderSettings accepts: one rule, two callers.
  assert.equal(looksLikeKey(KEY_A), true);
});

// ---- the routes, against a booted panel -------------------------------------------------------------

test("the profile routes save, apply and delete through writeProviderSettings, and never echo a key", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wag-profiles-route-"));
  const home = path.join(dir, "hermes");
  const configPath = path.join(home, "config.yaml");
  await mkdir(home, { recursive: true });
  await writeFile(configPath, "model:\n  provider: openrouter\n  base_url: https://openrouter.ai/api/v1\n", "utf8");
  const token = "profile-token";
  const panel = await startPanel({ dir, token, env: { HERMES_HOME: home } });
  t.after(async () => {
    await panel.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  // Empty to start.
  const empty = await fetch(`${panel.base}/api/settings/provider/profiles`);
  const emptyBody = await empty.json();
  assert.equal(empty.status, 200);
  assert.equal(emptyBody.count, 0);
  const file = emptyBody.file;
  assert.ok(path.resolve(file).startsWith(path.resolve(dir)), `the store is inside the panel's own data dir, not the checkout: ${file}`);
  assert.equal(path.resolve(file).startsWith(path.resolve(ROOT)), false, "the store is outside the repository");

  // A write from this box needs no token: `authorised()` trusts loopback (the page and a local shell are the same
  // caller there), which is why the assertion below is about the ANSWER rather than about a 403. Nothing but the
  // answer shape is copied from the provider route; the token path is that helper's, not this route's.
  const saved = await post(panel.base, "/api/settings/provider/profiles", { token, body: { name: "OpenRouter", baseUrl: URL_A, apiKey: KEY_A } });
  assert.equal(saved.status, 200, saved.text.slice(0, 300));
  assert.equal(carries(saved.text, KEY_A), false, "the save answer never carries the key back");
  assert.equal(saved.json.saved.name, "OpenRouter");
  assert.match(saved.json.saved.key.masked, new RegExp(`${lastFour(KEY_A)}$`));
  const idA = saved.json.saved.id;

  const listed = await (await fetch(`${panel.base}/api/settings/provider/profiles`)).json();
  assert.equal(listed.count, 1);
  assert.equal(carries(JSON.stringify(listed), KEY_A), false, "the list carries no key");

  // Apply: the key is read by the panel and written by writeProviderSettings, so neither request nor answer
  // carries it, and config.yaml ends up holding exactly the pair.
  assert.equal(carries(JSON.stringify(saved.json), KEY_A), false);
  const applied = await post(panel.base, "/api/settings/provider/apply", { token, body: { id: idA } });
  assert.equal(applied.status, 200, applied.text.slice(0, 300));
  assert.equal(carries(applied.text, KEY_A), false, "the apply answer never carries the key");
  assert.equal(applied.json.applied.name, "OpenRouter");
  assert.equal(applied.json.baseUrl, URL_A);
  const config = await readFile(configPath, "utf8");
  assert.match(config, new RegExp(`base_url: "?${URL_A.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.ok(carries(config, KEY_A), "the applied key is the one in config.yaml");
  assert.equal(applied.json.key.masked, providerState({ home }).key.masked);

  // Idempotent second apply: still one pair, no error.
  const again = await post(panel.base, "/api/settings/provider/apply", { token, body: { id: idA } });
  assert.equal(again.status, 200);

  // Applying something that is not there is a 404 with a sentence, not a silent success.
  const missing = await post(panel.base, "/api/settings/provider/apply", { token, body: { id: "nosuchid" } });
  assert.equal(missing.status, 404);
  assert.match(missing.json.error, /no saved profile/);

  // A second profile, then a delete that takes its key with it.
  const second = await post(panel.base, "/api/settings/provider/profiles", { token, body: { name: "Proxied", baseUrl: URL_B, apiKey: KEY_B } });
  assert.equal(second.status, 200, second.text.slice(0, 300));
  assert.equal(carries(second.text, KEY_B), false);
  const idB = second.json.saved.id;

  const deleted = await post(panel.base, "/api/settings/provider/profiles/delete", { token, body: { id: idB } });
  assert.equal(deleted.status, 200, deleted.text.slice(0, 300));
  assert.equal(carries(deleted.text, KEY_B), false);
  assert.equal(deleted.json.count, 1);
  const store = await readFile(file, "utf8");
  assert.equal(carries(store, KEY_B), false, "the deleted profile's key left the store with it");
  assert.ok(carries(store, KEY_A), "the profile that stayed still has its key");

  const goneAgain = await post(panel.base, "/api/settings/provider/profiles/delete", { token, body: { id: idB } });
  assert.equal(goneAgain.status, 404);

  // Save-as refuses a duplicate name through the route as it does in the module.
  const dupe = await post(panel.base, "/api/settings/provider/profiles", { token, body: { name: "openrouter", baseUrl: URL_B, apiKey: KEY_B } });
  assert.equal(dupe.status, 409);
  assert.match(dupe.json.error, /already a profile named/);

  // And no response along the way put a key in a URL or in a header the page could log.
  assert.equal(carries(JSON.stringify(deleted.json.profiles), KEY_A), false);
  assert.equal(carries(JSON.stringify(listProfiles({ file })), KEY_A), false);
});

test("the Gateway tab carries the picker, its four presses, and TWO independent restart buttons", async () => {
  const html = readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  const app = readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  for (const id of [
    "provider-profile",
    "provider-profile-name",
    "btn-provider-profile-save",
    "btn-provider-profile-edit",
    "btn-provider-profile-delete",
    "btn-provider-profile-apply",
    "provider-profile-preview",
  ]) {
    assert.ok(html.includes(`id="${id}"`), `index.html carries #${id}`);
  }
  // The picker sits ABOVE the URL and key rows it writes through.
  const picker = html.indexOf('id="provider-profile-row"');
  const url = html.indexOf('id="provider-url"');
  const key = html.indexOf('id="provider-key"');
  assert.ok(picker > 0 && picker < url && url < key, "the picker is above the URL and key rows");

  // Two buttons, two ids, two targets, and no third control that presses both.
  assert.ok(html.includes('id="btn-restart-gateway"'));
  assert.ok(html.includes('id="btn-restart-panel"'));
  assert.equal((html.match(/id="btn-restart-/g) || []).length, 2, "there are exactly two restart buttons");
  assert.ok(!/restart-(both|all)/i.test(html), "no control restarts both at once");

  // Each handler posts ONE target through POST /api/restart with the body the route expects.
  const gatewayAt = app.indexOf('$("btn-restart-gateway")?.addEventListener');
  const panelAt = app.indexOf('$("btn-restart-panel")?.addEventListener');
  assert.ok(gatewayAt > 0 && panelAt > gatewayAt, "both buttons are bound, gateway first");
  assert.match(app.slice(gatewayAt, panelAt), /restartFromSettings\("gateway", e\.currentTarget\)/);
  assert.match(app.slice(panelAt, panelAt + 220), /restartFromSettings\("panel", e\.currentTarget\)/);
  const handler = app.slice(app.indexOf("async function restartFromSettings"), app.indexOf("// ---- the model menu's prices"));
  assert.match(handler, /apiFetch\("\/api\/restart"/);
  assert.match(handler, /\btarget,/);
  assert.match(handler, /\breason:/);
  assert.match(handler, /\bwaitFor:/);
  assert.equal((handler.match(/apiFetch\(/g) || []).length, 1, "one press makes one request — the restarts are not chained");
  assert.ok(!/apiFetch\([^)]*api\/restart[^)]*\)[\s\S]*apiFetch\([^)]*api\/restart/.test(handler), "no handler posts two restarts");
});

test("writeProviderSettings is the only writer the Apply route uses", async () => {
  // A source-level guard: a second writer of model.base_url would be a second set of checks to keep in step.
  // The settings prefix lives in routes/settings.js since it was lifted out of server.js's chain.
  const settings = readFileSync(path.join(ROOT, "routes", "settings.js"), "utf8");
  const applyRoute = settings.slice(settings.indexOf('route === "/api/settings/provider/apply"'), settings.indexOf("// ---- the Matrix bridge"));
  assert.match(applyRoute, /writeProviderSettings\(\{ baseUrl: profile\.baseUrl, apiKey: profile\.apiKey \}\)/);
  assert.ok(!/writeFileSync|setBlockValueText/.test(applyRoute), "the apply route edits config.yaml only through writeProviderSettings");

  // And the state file is derived from the panel's own paths, not from anything under the checkout.
  const paths = readFileSync(path.join(ROOT, "lib", "paths.js"), "utf8");
  assert.match(paths, /providerProfilesFile: config\.providerProfilesFile \|\| file\("provider-profiles\.json"\)/);
  assert.ok(existsSync(path.join(ROOT, "lib", "provider-profiles.js")));
  // The module names no path of its own at all: a literal `logs/provider-profiles.json` here is the mistake that
  // would put a key in the checkout, and test/paths.test.js refuses one for the same reason.
  const module = readFileSync(path.join(ROOT, "lib", "provider-profiles.js"), "utf8");
  const moduleCode = module.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.equal(/["'`]logs\//.test(moduleCode), false, "the module builds no path from a literal logs/ folder");
});

test("a profile applied through writeProviderSettings round-trips the pair the store holds", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wag-profiles-write-"));
  const file = path.join(dir, "provider-profiles.json");
  const home = path.join(dir, "hermes");
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, "config.yaml"), "model:\n  provider: openrouter\n", "utf8");
  const saved = saveProfile({ file, name: "Direct", baseUrl: URL_B, apiKey: KEY_A });
  const stored = profileWithKey({ file, id: saved.profile.id });
  writeProviderSettings({ baseUrl: stored.baseUrl, apiKey: stored.apiKey }, { home });
  const state = providerState({ home });
  assert.equal(state.baseUrl, URL_B);
  assert.equal(state.key.inConfig, true);
  assert.equal(state.key.masked, saved.profile.key.masked, "the box's placeholder and the list row agree about the key");
  await rm(dir, { recursive: true, force: true });
});
