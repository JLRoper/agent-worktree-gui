// A cached whole-board snapshot with precise, generation-based invalidation.
//
// Building the snapshot is expensive (300-585ms measured): it composes the store, jobs,
// approvals, assistant state, hosts, locks, releases, todos, descriptions and more. The board
// polls /api/state far more often than any of those change. This module returns the SAME object
// until something invalidates the generation, then rebuilds once and caches again.
//
// "Precise invalidation": the composition root bumps the generation on EVERY state-changing
// event (store emits and SSE broadcasts), and only then. A heartbeat - which writes no state -
// never invalidates, so the cache survives the quiet polls that are its whole reason to exist.
// On reconnect handleStream still sends this snapshot as a fresh `event: snapshot` frame, so the
// client's anti-entropy safety net and reconnect recovery are unchanged: a reconnecting client
// receives the current board because any change since its last frame already bumped the generation.
//
// Pure and synchronous: no store, no workers, no I/O. `build` is injected so tests can drive it
// with a synthetic counter and clock (no private stores, no live service).
export function createSnapshotCache({ build, now = () => Date.now() } = {}) {
  if (typeof build !== "function") throw new Error("createSnapshotCache needs a build() function");
  let generation = 0;
  let cached = null; // { generation, value, builtAt, buildMs }
  let hits = 0;
  let misses = 0;
  let invalidations = 0;

  return {
    invalidate() {
      generation += 1;
      invalidations += 1;
    },
    get() {
      if (cached && cached.generation === generation) {
        hits += 1;
        return cached.value;
      }
      misses += 1;
      const startedAt = now();
      const value = build();
      cached = { generation, value, builtAt: now(), buildMs: Math.max(0, now() - startedAt) };
      return value;
    },
    stats() {
      return {
        generation,
        cached: Boolean(cached),
        hits,
        misses,
        invalidations,
        lastBuildMs: cached ? cached.buildMs : null,
        lastBuiltAt: cached ? new Date(cached.builtAt).toISOString() : null,
      };
    },
  };
}
