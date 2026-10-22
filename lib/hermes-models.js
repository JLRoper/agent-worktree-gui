// ---- the models a run can actually ask for ------------------------------------------------
// The panel does not choose the provider: the gateway serves whatever its config.yaml says, and the
// panel only names a model per run. So the honest list to offer is the one Hermes itself fetched for
// that provider — `provider_models_cache.json`, rewritten by `hermes model` / `--refresh` — not the
// 6 MB models.dev catalogue, where "available" would include models this account cannot call.
//
// If the cache is absent (a fresh install, or a provider never picked) the curated catalogue that
// ships with Hermes is used as a fallback, so the form still offers something sensible.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { hermesHome } from "./jobs.js";

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

const readJson = (file) => {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  } catch {
    return null;
  }
};

// One value out of a top-level block in config.yaml, by line — the same reason the approvals reader
// does not parse the file: it is the user's, thousands of lines of it are comments, and nothing here
// needs a document model.
export function configBlockValue(text, block, keys) {
  const lines = String(text ?? "").split(/\r?\n/);
  const head = new RegExp(`^${block}\\s*:\\s*(?:#.*)?$`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return {};
  const out = {};
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() && !/^\s/.test(line)) break; // next top-level key
    const m = /^\s+([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    if (!keys.includes(m[1])) continue;
    // Drop an inline comment and the quotes a YAML string may carry.
    out[m[1]] = m[2].replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

export function modelCatalogue({ home = hermesHome() } = {}) {
  const configPath = path.join(home, "config.yaml");
  let model = {};
  try {
    model = configBlockValue(readFileSync(configPath, "utf8"), "model", ["default", "model", "name", "provider"]);
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

  return {
    defaultModel,
    provider: configured,
    providers,
    count: providers.reduce((n, p) => n + p.models.length, 0),
    source,
    fetchedAt,
    // Older than a week is worth saying out loud: the list is a cache, not a live call.
    staleDays: fetchedAt ? Math.floor((Date.now() - Date.parse(fetchedAt)) / 86_400_000) : null,
  };
}
