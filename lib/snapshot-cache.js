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
export function createSnapshotCache({ build, now = () => Date.now(), serialize = (v) => JSON.stringify(v) } = {}) {
  if (typeof build !== "function") throw new Error("createSnapshotCache needs a build() function");
  let generation = 0;
  let cached = null; // { generation, value, builtAt, buildMs }
  let hits = 0;
  let misses = 0;
  let invalidations = 0;
  let textCached = null; // { generation, text }
  let textHits = 0;
  let textMisses = 0;
  let textDrops = 0;
  let textPending = null; // { generation, promise } - one chunked build at a time
  let textYields = 0;
  // Bumped by dropText(). A build captures the epoch it started in and refuses to commit across a drop, because the
  // drop was a statement that the pre-change board must not be answered at all.
  let textEpoch = 0;

  function value() {
    if (cached && cached.generation === generation) {
      hits += 1;
      return cached.value;
    }
    misses += 1;
    const startedAt = now();
    const built = build();
    cached = { generation, value: built, builtAt: now(), buildMs: Math.max(0, now() - startedAt) };
    return built;
  }

  return {
    invalidate() {
      generation += 1;
      invalidations += 1;
    },
    get() {
      return value();
    },
    // The snapshot as the string a caller would otherwise build for itself. `JSON.stringify` of a 3.6 MB board is
    // 0.6-1.3s of the panel's one event loop, and caching only the object meant every /api/state poll and every
    // stream connect paid it again. Same generation rule as the object: rebuilt only when the board changed.
    text() {
      if (textCached && textCached.generation === generation) {
        textHits += 1;
        return textCached.text;
      }
      textMisses += 1;
      const out = JSON.stringify(value());
      textCached = { generation, text: out };
      return out;
    },
    // THE SAME TEXT, BUILT IN SLICES. `serialize` may be the chunked writer (lib/json-chunks.js), in which case the
    // stringify yields to the event loop instead of holding it for seconds. One build at a time per generation: a
    // second caller waits on the first rather than starting a duplicate.
    //
    // A BUILD THAT RACED A CHANGE IS STILL THE FRESHEST TEXT THIS PROCESS HAS. It used to be thrown away whenever an
    // invalidation landed during the chunked stringify (`gen === generation`), and on a busy fleet one lands during
    // every build - 43,000 invalidations in 85 minutes on the live panel - so the text cache never committed at all.
    // /api/state then answered the last text it had ever managed to cache: 11 minutes old on the live board (generated
    // at 01:51:04 while the request was at 02:00), with a run that had settled at 01:23 still reading `running` in
    // its jobs pane while /api/jobs answered `done`. Keep the newest build; `freshText()` still reports it stale
    // (its generation is behind), so the next reader schedules another one instead of trusting it as current.
    async textAsync() {
      if (textCached && textCached.generation === generation) {
        textHits += 1;
        return textCached.text;
      }
      if (textPending && textPending.generation === generation) return textPending.promise;
      textMisses += 1;
      const gen = generation;
      const epoch = textEpoch;
      const promise = (async () => {
        const built = value();
        const out = await serialize(built);
        // Newest build wins: an older one finishing late must not overwrite a fresher text, and nothing built before
        // a drop may commit at all (dropText is the "the pre-change board must not be answered" signal).
        if (epoch === textEpoch && (!textCached || gen > textCached.generation)) textCached = { generation: gen, text: out };
        return out;
      })();
      textPending = { generation: gen, promise };
      try {
        return await promise;
      } finally {
        if (textPending && textPending.promise === promise) textPending = null;
      }
    },
    // The text for the CURRENT generation, or null. A reader that gets null has a stale or absent cache and can
    // choose between building now and answering with lastText() while a build runs behind it.
    freshText() {
      return textCached && textCached.generation === generation ? textCached.text : null;
    },
    // The last text built, whatever generation it describes - the stale-while-revalidate answer.
    lastText() {
      return textCached ? textCached.text : null;
    },
    // THE BOARD MOVED AND A READER MUST NOT BE CONTRADICTED ABOUT IT. Invalidation alone only says "a rebuild is
    // due": /api/state answers lastText() until one lands, so a submit that invalidates still hands the next poll the
    // pre-change board. A job's status leaving the live set is that kind of change (server.js `broadcastJobs`), and
    // it is rare enough to buy one inline build on the next read. The epoch makes a build already in flight unable
    // to bring the dropped text back.
    dropText() {
      textEpoch += 1;
      textCached = null;
      textPending = null;
      textDrops += 1;
    },

    textGeneration() {
      return textCached ? textCached.generation : null;
    },
    stats() {
      return {
        generation,
        cached: Boolean(cached),
        hits,
        misses,
        invalidations,
        textHits,
        textMisses,
        textDrops,
        textBuilding: Boolean(textPending),
        lastBuildMs: cached ? cached.buildMs : null,
        lastBuiltAt: cached ? new Date(cached.builtAt).toISOString() : null,
      };
    },
  };
}
