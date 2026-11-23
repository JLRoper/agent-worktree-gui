// A READ'S OWN PHASE CLOCK, off unless the request asks for it.
//
// A read that takes 64 s on a live panel is not one number: it is a queue fold, a lane fold, a template parse and an
// evidence read that may spawn git and reach a host's API. Timing those by wrapping the route from outside attributes
// only the total, and a total cannot say which seam to cut. So a seam calls `time`/`timeSync` around its own body and
// `count` for an operation it had to perform (a git spawn, a host read), and the read answers the phases it took.
//
// OFF IS THE DEFAULT AND OFF IS FREE ENOUGH: the only cost is one AsyncLocalStorage lookup per seam, and no payload key
// appears unless the caller asked with `?profile=1`. The tab never asks, so the bytes it draws are unchanged.
//
// THE STORE IS PER REQUEST, NOT PER PROCESS. Two reads can be in flight at once (the tab's 4 s poll beside an
// assistant's own read), and a module-level accumulator would blend them into a number that describes neither.
// `AsyncLocalStorage` follows the awaiting chain, so a phase recorded deep inside the evidence read lands on the
// request whose route opened the profile.
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage();

/** The profile the current read is collecting into, or null. */
export function runningProfile() {
  return store.getStore() || null;
}

/**
 * Run `fn` with a profile when `enabled` is true, and with none otherwise. `fn` is handed the profile (or null) so a
 * route can pass it to a helper without another lookup; every helper below finds it on its own.
 */
export function withProfile(enabled, fn) {
  if (!enabled) return fn(null);
  return store.run({ started: performance.now(), phases: new Map(), counts: new Map(), facts: new Map() }, () => fn(store.getStore()));
}

function bump(profile, table, name, by = 1) {
  table.set(name, (table.get(name) || 0) + by);
}

/** Add one operation to the read's tally (a git spawn, a host read, a queue file read). */
export function countOperation(name, by = 1) {
  const profile = store.getStore();
  if (profile) bump(profile, profile.counts, name, by);
}

/** Record a fact the report should name (a host, a ref), keeping the distinct values in first-seen order. */
export function noteFact(name, value) {
  const profile = store.getStore();
  if (!profile) return;
  const wanted = String(value ?? "").trim();
  if (!wanted) return;
  const seen = profile.facts.get(name) || [];
  if (!seen.includes(wanted)) seen.push(wanted);
  profile.facts.set(name, seen);
}

/** Time one synchronous seam. */
export function timeSync(name, fn) {
  const profile = store.getStore();
  if (!profile) return fn();
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    bump(profile, profile.phases, name, Math.round((performance.now() - t0) * 100) / 100);
  }
}

/** Time one awaited seam. A throw still records the time the seam spent before it. */
export async function timeAsync(name, fn) {
  const profile = store.getStore();
  if (!profile) return fn();
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    bump(profile, profile.phases, name, Math.round((performance.now() - t0) * 100) / 100);
  }
}

/**
 * The read's answer: phases in milliseconds (nested seams are quoted beside their parent, so a phase list is a tree the
 * reader walks, not a sum), operations in counts, facts by name, and the read's own wall time.
 */
export function profileReport() {
  const profile = store.getStore();
  if (!profile) return null;
  const phases = {};
  for (const [name, ms] of profile.phases) phases[name] = Math.round(ms * 10) / 10;
  const operations = {};
  for (const [name, n] of profile.counts) operations[name] = n;
  const facts = {};
  for (const [name, list] of profile.facts) facts[name] = list;
  return { totalMs: Math.round((performance.now() - profile.started) * 10) / 10, phases, operations, facts };
}
