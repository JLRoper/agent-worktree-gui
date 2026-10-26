// ---- the models a run can actually ask for ------------------------------------------------
// The panel does not choose the provider: the gateway serves whatever its config.yaml says, and the
// panel only names a model per run. So the honest list to offer is the one Hermes itself fetched for
// that provider — `provider_models_cache.json`, rewritten by `hermes model` / `--refresh` — not the
// 6 MB models.dev catalogue, where "available" would include models this account cannot call.
//
// If the cache is absent (a fresh install, or a provider never picked) the curated catalogue that
// ships with Hermes is used as a fallback, so the form still offers something sensible.
//
// Each row also carries what the shipped CLI model picker shows beside it: the input and output
// price per million tokens, and a 0-10 coding rating. Those come from the gateway's own model
// inventory (GET /api/model/options), which is the same source the CLI picker patch decorates its
// rows from — `_apply_pricing` in hermes_cli/inventory.py, reading OpenRouter's `pricing` block and
// `benchmarks.artificial_analysis.coding_index`, formatting both exactly as this file does. Reading
// is a two-file read and nothing more: opening the menu must never wait on a cold endpoint, so the
// numbers only ever come out of the cache this panel wrote, and the Settings refresh regenerates it.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hermesHome } from "./jobs.js";
import { modelContextLength } from "./session-usage.js";
import { readBlockValue } from "./hermes-config.js";
// The price/rating half of this menu lives in lib/model-prices.js: a leaf module, so the card's readout can
// price a session with it without this file and lib/session-usage.js importing each other. Re-exported from
// here because this is where the menu's rows are read, and where the model-prices harness looks for them.
import { cleanPriceEntry, readJson, readPricingCache } from "./model-prices.js";
export { cleanPrice, cleanCoding, cleanPriceEntry, readPricingCache } from "./model-prices.js";

const PROVIDER_LABELS = {
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  "x-ai": "xAI",
  nous: "Nous Portal",
  "copilot-acp": "GitHub Copilot",
  deepseek: "DeepSeek",
  local: "Local",
  ollama: "Ollama",
};

// ---- the picker's own numbers ----------------------------------------------------------------
// The format is lib/model-prices.js's: `input` and `output` are the gateway's own strings ("$x.xx" per
// Mtok, "free" for a zero rate, "?" when one side is unset) and `coding` is Artificial Analysis' 0-100
// coding index over ten, to one decimal. This file only hangs what it read onto each provider's rows.

export function modelCatalogue({ home = hermesHome(), pricingFile = null } = {}) {
  const configPath = path.join(home, "config.yaml");
  let model = {};
  try {
    const cfg = readFileSync(configPath, "utf8");
    model = {
      default: readBlockValue(cfg, "model", "default") || undefined,
      model: readBlockValue(cfg, "model", "model") || undefined,
      name: readBlockValue(cfg, "model", "name") || undefined,
      provider: readBlockValue(cfg, "model", "provider") || undefined,
    };
  } catch {
    /* no config: the gateway's own default is still worth showing as unknown */
  }
  const defaultModel = model.default || model.model || model.name || null;
  const configured = model.provider && model.provider !== "auto" ? model.provider : null;

  const cachePath = path.join(home, "provider_models_cache.json");
  const cache = readJson(cachePath);
  const providers = [];
  let source = cachePath;
  let fetchedAt = null;

  if (cache && typeof cache === "object" && Object.keys(cache).length) {
    for (const [id, entry] of Object.entries(cache)) {
      const models = Array.isArray(entry?.models) ? entry.models.filter((m) => typeof m === "string") : [];
      if (!models.length) continue;
      providers.push({ id, label: PROVIDER_LABELS[id] || id, models });
      const at = Number(entry?.at);
      if (Number.isFinite(at) && at > 0) {
        const iso = new Date(at * 1000).toISOString();
        if (!fetchedAt || iso > fetchedAt) fetchedAt = iso;
      }
    }
  }
  if (!providers.length) {
    // Curated fallback: the catalogue that ships with Hermes.
    source = path.join(home, "cache", "model_catalog.json");
    const catalog = readJson(source);
    for (const [id, entry] of Object.entries(catalog?.providers || {})) {
      const models = Array.isArray(entry?.models) ? entry.models.map((m) => (typeof m === "string" ? m : m?.id)).filter(Boolean) : [];
      if (!models.length) continue;
      providers.push({ id, label: entry?.metadata?.display_name || PROVIDER_LABELS[id] || id, models });
    }
    fetchedAt = catalog?.updated_at || null;
  }

  // The provider the gateway is configured for comes first, and the model in force has to be
  // selectable even if the provider's live list does not mention it (a retired id, a custom endpoint).
  if (configured) {
    const i = providers.findIndex((p) => p.id === configured);
    if (i > 0) providers.unshift(providers.splice(i, 1)[0]);
  }
  if (defaultModel) {
    const owner = providers.find((p) => p.models.includes(defaultModel)) || providers[0];
    if (owner && !owner.models.includes(defaultModel)) owner.models.unshift(defaultModel);
  }

  // Each model's own context window, from the provider catalogue the panel already reads for the context
  // gauge. The model list is useless for planning without it: two ids can cost the same and differ 8x in window.
  const catalogPath = path.join(home, "cache", "openrouter_model_metadata.json");
  const contexts = {};
  for (const p of providers) {
    for (const id of p.models) {
      const len = modelContextLength(id, catalogPath);
      if (len) contexts[id] = len;
    }
  }

  // The prices and ratings, hung on each provider so the page can decorate a row without a second
  // lookup. Absent for a provider nothing was ever priced for — which is a real answer, not an error.
  const pricing = readPricingCache(pricingFile);
  for (const p of providers) {
    const rows = pricing.providers[p.id];
    if (rows) p.pricing = rows;
  }

  return {
    contexts,
    defaultModel,
    provider: configured,
    providers,
    count: providers.reduce((n, p) => n + p.models.length, 0),
    source,
    fetchedAt,
    // Older than a week is worth saying out loud: the list is a cache, not a live call.
    staleDays: fetchedAt ? Math.floor((Date.now() - Date.parse(fetchedAt)) / 86_400_000) : null,
    // The price/rating half, and when it was regenerated.
    pricingAt: pricing.at,
    pricingAge: pricing.at ? Math.max(0, Math.floor((Date.now() - pricing.at) / 1000)) : null,
    pricingSource: pricing.source,
    pricedCount: pricing.pricedCount,
    ratedCount: pricing.ratedCount,
  };
}

// ---- regenerating it, rather than re-reading it ----------------------------------------------
// One press has to be able to prove it did something. This asks the GATEWAY for its model inventory
// with `?refresh=true`, which makes the gateway re-fetch every authenticated provider's live
// /v1/models list and persist it — the same thing `hermes model --refresh` does, and the same file
// it writes (`provider_models_cache.json`, which is what the menu above lists from) — and rebuilds
// this panel's price/coding cache from that answer. The panel's own cache is deleted FIRST, so a
// failed fetch can never leave yesterday's numbers sitting there looking freshly regenerated.
//
// Both files are measured before and after (row counts and mtimes) and the pair is returned, because
// "nothing changed" and "the press worked" are otherwise indistinguishable from the outside.
export function measureModelsCache(file) {
  const out = { path: file, exists: false, mtime: null, mtimeIso: null, providers: 0, rows: 0 };
  try {
    const st = statSync(file);
    out.exists = true;
    out.mtime = Math.round(st.mtimeMs);
    out.mtimeIso = new Date(st.mtimeMs).toISOString();
  } catch {
    return out;
  }
  const data = readJson(file);
  if (data && typeof data === "object") {
    for (const entry of Object.values(data)) {
      if (!Array.isArray(entry?.models)) continue;
      out.providers += 1;
      out.rows += entry.models.length;
    }
  }
  return out;
}

export function measurePricingCache(file) {
  const out = { path: file, exists: false, mtime: null, mtimeIso: null, providers: 0, rows: 0, priced: 0, rated: 0 };
  try {
    const st = statSync(file);
    out.exists = true;
    out.mtime = Math.round(st.mtimeMs);
    out.mtimeIso = new Date(st.mtimeMs).toISOString();
  } catch {
    return out;
  }
  const cache = readPricingCache(file);
  out.providers = Object.keys(cache.providers).length;
  out.rows = Object.values(cache.providers).reduce((n, rows) => n + Object.keys(rows).length, 0);
  out.priced = cache.pricedCount;
  out.rated = cache.ratedCount;
  return out;
}

// The gateway's answer → the file the dropdown reads. The provider slug is the key, because two
// providers can legitimately serve the same bare model name.
export function buildPricingCache(payload, url) {
  const providers = {};
  let pricedCount = 0;
  let ratedCount = 0;
  for (const row of Array.isArray(payload?.providers) ? payload.providers : []) {
    const pid = String(row?.slug || "").trim().toLowerCase();
    if (!pid || !row?.pricing || typeof row.pricing !== "object") continue;
    const clean = {};
    for (const [mid, entry] of Object.entries(row.pricing)) {
      const one = cleanPriceEntry(entry);
      if (!one) continue;
      clean[mid] = one;
      pricedCount += 1;
      if (one.coding) ratedCount += 1;
    }
    if (Object.keys(clean).length) providers[pid] = clean;
  }
  return { at: Date.now(), url: url || null, providers, pricedCount, ratedCount };
}

export async function refreshModelCatalogue({
  home = hermesHome(),
  pricingFile,
  api = {},
  log = () => {},
  timeoutMs = 120_000,
} = {}) {
  if (!pricingFile) throw new Error("no pricing cache file is configured for this panel");
  const modelsCacheFile = path.join(home, "provider_models_cache.json");
  const before = { models: measureModelsCache(modelsCacheFile), pricing: measurePricingCache(pricingFile) };

  // Bust the panel's own cache before anything else: whatever lands below is what was just fetched,
  // never a survivor of the deleted file.
  try {
    rmSync(pricingFile, { force: true });
  } catch (e) {
    log(`model prices: could not clear ${pricingFile} (${String((e && e.message) || e)})`);
  }

  const base = String(api.url || "").replace(/\/+$/, "");
  if (!base) throw new Error("no gateway URL is configured, so the catalogue cannot be regenerated");
  const url = `${base}/api/model/options?refresh=true`;
  const headers = { Accept: "application/json" };
  if (api.key) headers.Authorization = `Bearer ${api.key}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let payload = null;
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`the gateway answered HTTP ${res.status} for ${url}`);
    payload = await res.json();
  } catch (e) {
    const why = e?.name === "AbortError"
      ? `the gateway did not answer within ${Math.round(timeoutMs / 1000)}s`
      : String((e && e.message) || e);
    const err = new Error(why);
    err.partial = { before, after: null };
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const cache = buildPricingCache(payload, url);
  mkdirSync(path.dirname(pricingFile), { recursive: true });
  writeFileSync(pricingFile, `${JSON.stringify(cache)}\n`, "utf8");

  const after = { models: measureModelsCache(modelsCacheFile), pricing: measurePricingCache(pricingFile) };
  log(
    `model prices: regenerated — provider cache ${before.models.rows} rows/${before.models.providers} providers → ` +
      `${after.models.rows} rows/${after.models.providers} providers, pricing ${before.pricing.priced} → ${after.pricing.priced} rows ` +
      `(${after.pricing.rated} rated)`,
  );
  return {
    before,
    after,
    providers: Object.keys(cache.providers).length,
    priced: cache.pricedCount,
    rated: cache.ratedCount,
    url,
  };
}
