// What each model costs per million tokens, as this panel cached it.
//
// Two readers want these numbers and neither may reach through the other: the model menu
// (lib/hermes-models.js) decorates each row of the dropdown with them, and the card's readout
// (lib/session-usage.js) prices a session the gateway recorded no cost for. hermes-models already imports
// session-usage for the context window, so the reader moved down to this leaf module — both import it and
// neither imports the other.
//
// The strings stay exactly as the gateway formats them (`_apply_pricing` in hermes_cli/inventory.py reads
// OpenRouter's `pricing` block): "input" and "output" are "$x.xx" per Mtok, "free" for a zero rate, "?" when
// one side is unset. Only the point of use turns them into numbers, because the menu prints the gateway's
// own strings and the arithmetic needs per-million floats.
import { existsSync, readFileSync } from "node:fs";

// A JSON file read once, or null: both halves of this module's job need it, and neither may throw over a
// file that is absent or half-written.
export const readJson = (file) => {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  } catch {
    return null;
  }
};

// A router sentinel — the "-1000000" some endpoints serve to mean "not priced" — is not a price.
// Anything that is not a plain "$<digit>…" is refused, which also drops "$-1000000.00", "-1" and
// the gateway's own "?" marker, so a row keeps its bare id rather than advertising a negative rate.
export function cleanPrice(value) {
  const s = String(value ?? "").trim();
  if (!s) return "";
  if (s === "free") return s;
  if (!/^\$\d/.test(s)) return "";
  const n = Number(s.slice(1));
  return Number.isFinite(n) && n >= 0 ? s : "";
}

// Artificial Analysis' 0-10 rating, or "" when the model has not been benchmarked. The gateway
// already omits the field for an unrated model; this guard is what keeps a sentinel from becoming a
// rating if one ever reaches the file.
export function cleanCoding(value) {
  const s = String(value ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return "";
  const n = Number(s);
  return n > 0 && n <= 10 ? s : "";
}

// One model's row as the dropdown is allowed to show it: both prices and the rating, or nothing.
// A side that is unset renders as the gateway's own "?" only when the other side has a price.
export function cleanPriceEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const input = cleanPrice(entry.input);
  const output = cleanPrice(entry.output);
  const coding = cleanCoding(entry.coding);
  if (!input && !output && !coding) return null;
  const row = {};
  if (input || output) {
    row.input = input || "?";
    row.output = output || "?";
  }
  if (coding) row.coding = coding;
  return row;
}

// What the dropdown reads, cleaned on the way in: a cache file written by an older build (or
// hand-edited) can never put a sentinel on the page.
export function readPricingCache(file) {
  const empty = { providers: {}, at: null, pricedCount: 0, ratedCount: 0, source: null };
  if (!file) return empty;
  const raw = readJson(file);
  if (!raw || typeof raw !== "object" || !raw.providers || typeof raw.providers !== "object") return empty;
  const providers = {};
  let pricedCount = 0;
  let ratedCount = 0;
  for (const [pid, rows] of Object.entries(raw.providers)) {
    if (!rows || typeof rows !== "object") continue;
    const clean = {};
    for (const [mid, entry] of Object.entries(rows)) {
      const row = cleanPriceEntry(entry);
      if (!row) continue;
      clean[mid] = row;
      pricedCount += 1;
      if (row.coding) ratedCount += 1;
    }
    if (Object.keys(clean).length) providers[pid] = clean;
  }
  const at = Number(raw.at);
  return {
    providers,
    at: Number.isFinite(at) && at > 0 ? at : null,
    pricedCount,
    ratedCount,
    source: typeof raw.url === "string" ? raw.url : null,
  };
}

// One model's per-million rates as numbers, for arithmetic. "free" is a real price of 0; "" and "?" are
// not prices at all, so a side that was never priced comes back null and the caller must say so rather
// than price it at zero.
export function pricePerMillion(value) {
  const clean = cleanPrice(value);
  if (!clean) return null;
  if (clean === "free") return 0;
  const n = Number(clean.slice(1));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// The one-line form the tooltip prints, so the reader can see the rates the figure was computed from.
// Matches the gateway's own shape above $1 ($10.00) and keeps a sub-dollar rate readable without a run of
// trailing zeros ($0.02, $0.002). Takes the per-million NUMBER, because that is what priceEntry hands out.
export function formatRate(perMillion) {
  if (perMillion === null || perMillion === undefined || !Number.isFinite(perMillion)) return "?";
  if (perMillion === 0) return "free";
  if (perMillion >= 1) return `$${perMillion.toFixed(2)}`;
  return `$${String(Number(perMillion.toFixed(5)))}`;
}

// The same, for the gateway's own strings ("$0.02" / "free" / "?" as read from the cache file).
export function formatPrice(value) {
  return formatRate(pricePerMillion(value));
}

// Every lookup answer, keyed by the cache object itself: a rebuilt cache is a new object and starts over,
// and a snapshot asks for the same handful of session models on every card.
const lookupCache = new WeakMap();

// What one model costs per million tokens, in numbers. The model id is matched exactly and
// case-insensitively, then by its bare name (a provider that lists "deepseek-v4.1-flash" where a session
// row says "deepseek/deepseek-v4.1-flash"), and the session's own billing provider is tried first so two
// providers serving the same id cannot silently swap rates.
export function priceEntry(cache, model, provider = null) {
  const id = String(model || "").trim();
  if (!cache || !id) return null;
  const bare = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
  const key = `${id.toLowerCase()}|${String(provider || "").toLowerCase()}|${bare.toLowerCase()}`;
  let memo = lookupCache.get(cache);
  if (!memo) {
    memo = new Map();
    lookupCache.set(cache, memo);
  }
  if (memo.has(key)) return memo.get(key);
  const providers = cache.providers || {};
  const wanted = [id.toLowerCase(), bare.toLowerCase()];
  const order = [String(provider || "").toLowerCase(), ...Object.keys(providers).map((p) => p.toLowerCase())];
  let answer = null;
  for (const pid of order) {
    const rows = providers[pid];
    if (!rows) continue;
    for (const [mid, row] of Object.entries(rows)) {
      const lower = mid.toLowerCase();
      if (wanted.includes(lower) || (mid.includes("/") && wanted.includes(mid.slice(mid.indexOf("/") + 1).toLowerCase()))) {
        answer = { model: mid, provider: pid, input: pricePerMillion(row.input), output: pricePerMillion(row.output) };
        break;
      }
    }
    if (answer) break;
  }
  memo.set(key, answer);
  return answer;
}
