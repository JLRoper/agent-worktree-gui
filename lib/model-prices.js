// ---- what a model costs, per million tokens ------------------------------------------------
// `tools/openrouter-prices.py` asks OpenRouter for its live model list and writes the prices it
// found into `data/openrouter-model-prices.json`. This module is the only reader of that file, so
// the panel never has to guess a number and never hardcodes one.
//
// The file is optional. A repo that has never run the script has no prices, and the picker simply
// shows no price — which is honest, and better than a made-up figure that is wrong the moment a
// provider changes its rates. The file's own generatedAt travels with the numbers so the UI can
// say how old they are.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
export const PRICES_PATH = path.join(ROOT, "data", "openrouter-model-prices.json");

// Read once per file version: the script rewrites the whole file, so mtime+size identifies it.
let cache = { stamp: "", value: null };

function readJson(file) {
  try {
    const st = statSync(file);
    const stamp = `${st.mtimeMs}:${st.size}`;
    if (stamp === cache.stamp) return cache.value;
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const prices = {};
    for (const row of Array.isArray(parsed?.models) ? parsed.models : []) {
      if (!row?.id) continue;
      prices[row.id] = {
        input: row.inputPerMillion ?? null,
        output: row.outputPerMillion ?? null,
        average: row.averagePerMillion ?? null,
        cacheRead: row.cacheReadPerMillion ?? null,
        variable: Boolean(row.variablePricing),
        // 0-10 benchmark rating. null means Artificial Analysis has not scored this model — the
        // picker shows no stars rather than a zero, which would read as "bad" instead of "unknown".
        rating: typeof row.rating === "number" ? row.rating : null,
        ratingSource: row.ratingSource || null,
        ratingModel: row.ratingModel || null,
        ratingEstimated: Boolean(row.ratingEstimated),
      };
    }
    const value = {
      prices,
      latest: (Array.isArray(parsed?.latestModels) ? parsed.latestModels : []).map((r) => ({
        id: r?.id,
        name: r?.name || r?.id,
        added: r?.added || null,
        average: r?.averagePerMillion ?? null,
      })),
      generatedAt: parsed?.generatedAt || null,
      unit: parsed?.unit || "per 1M tokens",
      currency: parsed?.currency || "USD",
      source: parsed?.source || null,
      counts: parsed?.counts || null,
      ratings: parsed?.ratings || null,
    };
    cache = { stamp, value };
    return value;
  } catch {
    return null;
  }
}

// `null` when the script has never run here — callers treat that as "no prices known", not as zero.
export function modelPrices(file = PRICES_PATH) {
  if (!existsSync(file)) return null;
  return readJson(file);
}

// Only the ids the provider list actually offers, so /api/models stays small. The picker looks up
// by id and falls back to nothing.
export function pricesFor(ids, file = PRICES_PATH) {
  const all = modelPrices(file);
  if (!all) return null;
  const out = {};
  for (const id of ids || []) {
    const p = all.prices[id];
    if (p) out[id] = p;
  }
  if (!Object.keys(out).length) return null;
  return {
    ...all,
    prices: out,
    latest: all.latest.filter((m) => m.id && (ids || []).includes(m.id)),
  };
}
