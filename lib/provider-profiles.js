// ---- OpenRouter profiles: one (base URL, key) pair under a name ---------------------------------
// The Gateway tab already writes ONE pair into the gateway's config.yaml: model.base_url and
// model.api_key. A reader who moves between OpenRouter itself, a proxy and a second endpoint retypes
// the same key every time, so a profile is that pair saved once and applied with one press.
//
// WHERE THE KEYS LIVE, and why this module exists at all. The store is the panel's own state —
// lib/paths.js puts it at <dataDir>/state/provider-profiles.json, `~/.wag` by default and never inside a
// checkout. That is the whole point: a key in a committed file is a key in every clone and in the pull
// request that added it, and the panel's state folder is outside every repository `git status` here can
// see. Nothing in this file names a path under the repo, and the defaults only cover a caller that named
// no file at all.
//
// WHAT LEAVES THE PROCESS. A profile as the browser sees it carries the name, the URL and
// `key: { set, masked }` — the last four characters, through the same maskKey() the config.yaml field
// shows. No route returns a key: Apply reads it here, in this process, and hands it straight to
// writeProviderSettings(). A profile's key is therefore never in a response body, never in a URL and
// never in the page's own state.
//
// A DELETE REMOVES THE KEY. The key is a field of the profile record, not a second entry keyed beside
// it, so dropping the record drops the secret with it — there is no id left behind pointing at a key
// nobody can see or reach. `deleteProfile` rewrites the file in the same call and the route answers with
// the list, so a reader can see it is gone.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PROVIDER_DEFAULT_URL, maskKey } from "./hermes-config.js";

// The document version. A newer file than this code understands is READ (names and URLs still draw) but
// its secrets are handed to nobody: an unknown shape must not be mistaken for the one this module writes.
export const PROFILES_VERSION = 1;

// There is deliberately NO default path here. Every state path in this panel is derived by lib/paths.js
// (`statePaths(config).providerProfilesFile`, which the server assigns onto its config at boot), and
// test/paths.test.js refuses a module that builds one from the checkout or from a literal `logs/` folder —
// which is exactly the mistake that would put this file's keys inside the repository.

const clean = (v) => String(v ?? "").trim();

// The same two rules writeProviderSettings() applies to a key, checked when it is STORED rather than only
// when it is applied: a profile holding a key the gateway will refuse is a press that fails later, in
// another tab, with the reader having no idea which of the two steps was wrong.
export function looksLikeKey(value) {
  const key = clean(value);
  return key.length >= 8 && /^[\x21-\x7e]+$/.test(key);
}

// http(s) only, trailing slashes dropped — the same normalisation writeProviderSettings() performs, so the
// URL a profile stores is the URL config.yaml ends up holding.
export function normalizeBaseUrl(value) {
  const raw = clean(value);
  if (!raw) return "";
  const url = raw.replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("the URL has to be an http(s) address");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("the URL has to be http or https");
  return url;
}

const emptyDoc = () => ({ version: PROFILES_VERSION, profiles: [] });

const isRecord = (rec) => Boolean(rec) && typeof rec === "object" && !Array.isArray(rec);

// A record as the browser sees it. `key.set` is about the PROFILE, never about config.yaml: "this profile
// carries a key" is what Apply needs, and `masked` is the last four.
export function publicProfile(rec) {
  const key = clean(rec?.apiKey);
  return {
    id: clean(rec?.id),
    name: clean(rec?.name),
    baseUrl: clean(rec?.baseUrl),
    key: { set: Boolean(key), masked: key ? maskKey(key) : null },
    updatedAt: rec?.updatedAt || null,
  };
}

// Read is forgiving on purpose: a hand-edited file, a half-written one from a killed process, a record
// with no name — none of those may stop the Gateway tab from drawing. Every drop is a warning the route
// carries, because a profile that silently vanished is worse than one that never saved.
export function readProfilesFile(file) {
  const out = { ...emptyDoc(), file: file ? String(file) : null, warnings: [] };
  if (!file || !existsSync(file)) return out;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    out.warnings.push(`could not read ${file}: ${String((e && e.message) || e)}`);
    return out;
  }
  let doc;
  try {
    doc = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (e) {
    out.warnings.push(`${file} is not JSON, so no profile was loaded (${String((e && e.message) || e)}); saving again replaces it`);
    return out;
  }
  if (!isRecord(doc)) {
    out.warnings.push(`${file} is not a profile document (expected an object with "profiles")`);
    return out;
  }
  out.version = Number(doc.version) || PROFILES_VERSION;
  if (out.version > PROFILES_VERSION) {
    // Read by name only: this code would rewrite the file in an older shape and lose whatever the newer one
    // added, so the list is shown and the secrets are dropped.
    out.warnings.push(`${file} was written by a newer panel (version ${out.version}); its profiles are read but none of their keys is used here`);
  }
  const seen = new Set();
  const records = Array.isArray(doc.profiles) ? doc.profiles : [];
  for (const rec of records) {
    if (!isRecord(rec)) {
      out.warnings.push("dropped a profile that is not an object");
      continue;
    }
    const id = clean(rec.id);
    const name = clean(rec.name);
    const baseUrl = clean(rec.baseUrl);
    if (!id || !name) {
      out.warnings.push(`dropped a profile with no ${id ? "name" : "id"}`);
      continue;
    }
    if (seen.has(id)) {
      out.warnings.push(`dropped a duplicate profile id ${id}`);
      continue;
    }
    seen.add(id);
    out.profiles.push({
      id,
      name,
      baseUrl,
      apiKey: out.version > PROFILES_VERSION ? "" : clean(rec.apiKey),
      createdAt: rec.createdAt || null,
      updatedAt: rec.updatedAt || null,
    });
  }
  return out;
}

// Atomic, and 0600 where the platform honours it: the file holds keys, and a half-written one is a store
// with no way to tell which records survived.
export function writeProfilesFile(file, doc) {
  if (!file) throw new Error("no profile file to write");
  mkdirSync(path.dirname(String(file)), { recursive: true });
  const text = `${JSON.stringify({ version: PROFILES_VERSION, profiles: doc.profiles }, null, 2)}\n`;
  const tmp = `${file}.panel-${process.pid}.tmp`;
  writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
  return { file: String(file), count: doc.profiles.length };
}

const byName = (a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" });

// The list a route and the page both draw: names, URLs, and whether a key is set — never a key.
export function listProfiles({ file } = {}) {
  const doc = readProfilesFile(file);
  const profiles = doc.profiles.map(publicProfile).sort(byName);
  return {
    file: doc.file,
    version: doc.version,
    count: profiles.length,
    profiles,
    warnings: doc.warnings,
    defaultBaseUrl: PROVIDER_DEFAULT_URL,
  };
}

// The one function that hands a key back. Its only caller is the Apply route, which passes it to
// writeProviderSettings() — keep it that way: a caller that returns this object from a route has sent a
// secret to the browser.
export function profileWithKey({ file, id } = {}) {
  const doc = readProfilesFile(file);
  if (doc.version > PROFILES_VERSION) return null;
  const rec = doc.profiles.find((p) => p.id === clean(id));
  if (!rec) return null;
  return { id: rec.id, name: rec.name, baseUrl: rec.baseUrl, apiKey: rec.apiKey };
}

// Create or update. `id` names the record to update; absent, a new one is created. A blank `apiKey` on an
// UPDATE keeps the key already stored (an edit that only renames a profile or points it at a new proxy
// must not silently strip its credential), and on a CREATE it is refused: a profile is a pair, and a
// name with no key is a press that cannot work.
export function saveProfile({ file, id = null, name, baseUrl, apiKey, now = Date.now() } = {}) {
  const label = clean(name);
  if (!label) throw new Error("a profile needs a name");
  if (label.length > 60) throw new Error("a profile name has to be 60 characters or fewer");
  const url = normalizeBaseUrl(baseUrl);
  if (!url) throw new Error("a profile needs the endpoint URL");
  const doc = readProfilesFile(file);
  if (doc.version > PROFILES_VERSION) {
    throw new Error(`${file} was written by a newer panel — this one will not rewrite it`);
  }
  const wantedKey = clean(apiKey);
  if (wantedKey && !looksLikeKey(wantedKey)) throw new Error("that does not look like an API key");

  const stamp = new Date(now).toISOString();
  const targetId = clean(id);
  const existing = targetId ? doc.profiles.find((p) => p.id === targetId) : null;
  if (targetId && !existing) throw Object.assign(new Error(`no profile with id ${targetId}`), { status: 404 });
  const clash = doc.profiles.find((p) => p.name.toLowerCase() === label.toLowerCase() && p.id !== (existing ? existing.id : null));
  if (clash) throw Object.assign(new Error(`there is already a profile named "${clash.name}" — open it and press Edit to replace it`), { status: 409 });
  if (!existing && !wantedKey) throw new Error("a new profile needs a key — type one in the OpenRouter key box first");

  const rec = existing
    ? { ...existing, name: label, baseUrl: url, apiKey: wantedKey || existing.apiKey, updatedAt: stamp }
    : { id: randomUUID().slice(0, 8), name: label, baseUrl: url, apiKey: wantedKey, createdAt: stamp, updatedAt: stamp };
  const profiles = existing ? doc.profiles.map((p) => (p.id === existing.id ? rec : p)) : [...doc.profiles, rec];
  writeProfilesFile(file, { profiles });
  return { created: !existing, profile: publicProfile(rec), profiles: profiles.map(publicProfile).sort(byName) };
}

// Drop the record — and with it the key, because the key is a field of that record rather than an entry
// keyed beside it. Returns the removed record's PUBLIC fields, or null when the id is not one this store
// holds; the route answers 404 on null rather than pretending a delete happened.
export function deleteProfile({ file, id } = {}) {
  const doc = readProfilesFile(file);
  if (doc.version > PROFILES_VERSION) {
    throw new Error(`${file} was written by a newer panel — this one will not rewrite it`);
  }
  const target = clean(id);
  const rec = doc.profiles.find((p) => p.id === target);
  if (!rec) return null;
  const profiles = doc.profiles.filter((p) => p.id !== target);
  writeProfilesFile(file, { profiles });
  return { removed: publicProfile(rec), profiles: profiles.map(publicProfile).sort(byName) };
}
