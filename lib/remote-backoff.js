// A host that is not answering stops being asked, for a while.
//
// WHY: the panel's every look at a PR, a remote's heads or a pipeline's review is a call to ONE host, and
// the paths that make them are memoised by TTL and rebuilt after every restart — so a host that is DOWN
// is still retried on every TTL and again, cold, after every restart. On 2026-11-09 git.sefl.com was
// unreachable and each retry was paid in full: the REST reads hold their socket for 20 s
// (`AbortSignal.timeout`), the `ls-remote` pays the ssh connect timeout, and the reads arrive together
// whenever a wave of memos expires. It was not one bad call; it was the same bad call, forever.
//
// The rule: two CONSECUTIVE host-class failures and the host is HELD. While held, every call site skips
// its attempt and answers what it answers when the host cannot be reached — no socket, no timeout, no
// repeated log — until the hold expires. The hold starts at a minute and doubles with each failure
// beyond the second, capped at half an hour; one answer resets it. Expiry lets ONE attempt through (the
// probe): it fails, the hold doubles; it answers, the host is healthy again. Entering and leaving a hold
// are logged once each; the per-call failure line stays for the calls that actually happened.
//
// A PER-REPO failure must not hold a host (`looksLikeHostTrouble`): a repository that was renamed or
// never existed answers every call about it, and holding the host would mute every other repo on it.
// Only the shapes a DOWN host produces qualify: aborts and timeouts, refused or reset sockets, hosts
// and networks that cannot be reached, names that cannot be resolved.

const HOLD_AFTER_FAILURES = 2;
const HOLD_BASE_MS = 60_000;
const HOLD_MAX_MS = 30 * 60_000;

// What a down host sounds like — and, more importantly, what a per-repo answer sounds like it is not.
const HOST_TROUBLE = /abort|timed?[\s_-]?out|econnrefused|econnreset|ehostunreach|enetunreach|eai_again|enotfound|socket hang up|fetch failed|network|did not answer/i;

export function looksLikeHostTrouble(text) {
  return HOST_TROUBLE.test(String(text || ""));
}

let now = () => Date.now();
let log = (line) => console.log(new Date(now()).toISOString().slice(11, 19), line);
const table = new Map(); // host id -> { fails, until, last }

const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));

// false, or { ms, why } while the host is held. After `until` the next call is the probe: it goes through.
export function heldBack(id, at = now()) {
  const entry = id ? table.get(id) : null;
  if (!entry || !entry.until || at >= entry.until) return false;
  return { ms: entry.until - at, why: entry.last || "the host did not answer" };
}

// One more host-class failure: hold the host, or lengthen the hold it is already under.
export function failed(id, why = "") {
  if (!id) return;
  const entry = table.get(id) || { fails: 0, until: 0, last: "" };
  entry.fails += 1;
  entry.last = String(why || entry.last || "");
  if (entry.fails >= HOLD_AFTER_FAILURES) {
    const hold = Math.min(HOLD_BASE_MS * 2 ** (entry.fails - HOLD_AFTER_FAILURES), HOLD_MAX_MS);
    entry.until = now() + hold;
    log(`host ${id} is not answering (${entry.fails} failing call(s): ${entry.last}) — its calls are held back for ${minutes(hold)} min`);
  }
  table.set(id, entry);
}

// The host answered: healthy again — and it says so when it had been unwell.
export function answered(id) {
  if (!id) return;
  const entry = table.get(id);
  if (!entry) return;
  if (entry.fails) log(`host ${id} answered again — its calls resume`);
  table.delete(id);
}

// Tests only: a clock, a log sink, and a clean table.
export function configure({ clock = null, sink = null } = {}) {
  if (clock) now = clock;
  if (sink) log = sink;
}

export function reset() {
  table.clear();
}
