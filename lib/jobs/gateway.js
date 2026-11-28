// ---- the gateway's backpressure policy ---------------------------------------------------------
// What this module owns: the three knobs a refused POST is held on, the arithmetic that turns a
// `Retry-After` header and an attempt number into a wait, and the one wording a wait is printed in.
// Nothing here reads a job, a store or a timer - every function is a pure read of the panel's config
// and of a response's headers - which is what made it the first piece of lib/jobs.js safe to move:
// the bodies came out byte-identical, the names were already exported, and tools/verify-429-hold.mjs
// already drives them through the shipped `Jobs`.
//
// lib/jobs.js keeps the hold that spends them (inside `create`'s POST loop) and re-exports every name
// below unchanged, so no reader of those names has to move.
//
// This is the front half of the plan's J1 cut (docs/arch-review-r1-a.md, section 2.4): `postRun` -
// the POST itself and its absorption of a 429 - lands here next, when `create` stops owning the
// transport and the state machine behind it is all that is left there.

// ---- 429: the gateway's backpressure, not a failed run -----------------------------------------
// `POST /v1/runs` answers 429 with `{error:{code:"rate_limit_exceeded"}}` and a `Retry-After` header when
// its concurrent-run cap is reached (`_concurrency_limited_response` in api_server). That is a statement
// about SLOTS, not about this run: the same request is accepted the moment one frees, so the panel holds
// the turn and sends it again instead of marking it failed. These are the knobs for that hold, overridable
// from the panel config as `retry429: {attempts, baseMs, maxMs, jitter}` (a sandbox wants small ones).
//   * `attempts` counts the POST itself, so 6 means one try plus five retries;
//   * the delay is a backoff that doubles from `baseMs` and stops growing at `maxMs`, with `jitter` of the
//     delay added or subtracted at random so a fleet of panel instances does not wake up together;
//   * a `Retry-After` is a FLOOR under that backoff, never a shortening of it, and it is never capped away
//     — a gateway that says 60 s is not asked again at 30. This gateway sends `Retry-After: 1`, which the
//     backoff already covers.
export const RETRY_429_DEFAULTS = { attempts: 6, baseMs: 1500, maxMs: 30_000, jitter: 0.25 };

export function retry429Settings(config = {}) {
  const raw = config && typeof config.retry429 === "object" && config.retry429 ? config.retry429 : {};
  const num = (v, fallback, min) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? n : fallback;
  };
  return {
    attempts: Math.max(1, Math.round(num(raw.attempts, RETRY_429_DEFAULTS.attempts, 1))),
    baseMs: num(raw.baseMs, RETRY_429_DEFAULTS.baseMs, 0),
    maxMs: num(raw.maxMs, RETRY_429_DEFAULTS.maxMs, 0),
    jitter: Math.min(1, num(raw.jitter, RETRY_429_DEFAULTS.jitter, 0)),
  };
}

// The gateway's own hint, in milliseconds: `Retry-After` is either a whole number of seconds or an
// HTTP-date. Anything that parses as neither is treated as absent (null) rather than as a zero wait.
export function retryAfterMs(headers) {
  const get = headers && typeof headers.get === "function" ? (name) => headers.get(name) : () => null;
  const raw = get("retry-after");
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const text = String(raw).trim();
  if (/^[0-9]+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

// How long to hold before POST attempt `attempt` (1-based), as a number of milliseconds. Exported because
// the harness proves the shape directly: doubling, capped, jittered, and never below `Retry-After`.
export function retry429DelayMs(attempt, settings = RETRY_429_DEFAULTS, afterMs = null, random = Math.random) {
  const s = { ...RETRY_429_DEFAULTS, ...(settings || {}) };
  const grown = Math.min(s.maxMs, s.baseMs * 2 ** Math.max(0, attempt - 1));
  const wobbled = grown * (1 + (Number(random()) * 2 - 1) * s.jitter);
  const floor = Number.isFinite(afterMs) && afterMs > 0 ? afterMs : 0;
  return Math.max(0, Math.round(Math.max(floor, wobbled)));
}

// A wait, said the way a reader reads a clock: "1.5s", "47s", "2m 05s".
export function fmtWait(ms) {
  const s = Math.max(0, Number(ms) || 0) / 1000;
  if (s < 10) return `${(Math.round(s * 10) / 10).toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s - m * 60)).padStart(2, "0")}s`;
}
