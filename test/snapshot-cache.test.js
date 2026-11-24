// Cached snapshot with precise, generation-based invalidation. Synthetic build function and
// clock: no store, no workers, no live service.
import assert from "node:assert/strict";
import test from "node:test";
import { createSnapshotCache } from "../lib/snapshot-cache.js";

test("a cached snapshot is built once and returned unchanged until invalidated", () => {
  let builds = 0;
  const cache = createSnapshotCache({ build: () => ({ n: ++builds }) });
  const first = cache.get();
  const second = cache.get();
  assert.strictEqual(first, second, "the same object is reused");
  assert.equal(builds, 1, "build ran only once");
  cache.invalidate();
  const third = cache.get();
  assert.notStrictEqual(third, first);
  assert.equal(builds, 2, "one rebuild after invalidation");
  assert.equal(third.n, 2);
  const fourth = cache.get();
  assert.strictEqual(fourth, third);
  assert.equal(builds, 2);
});

test("stats report hits, misses, invalidations and generation", () => {
  const cache = createSnapshotCache({ build: () => ({}) });
  cache.get(); // miss
  cache.get(); // hit
  cache.get(); // hit
  cache.invalidate();
  cache.get(); // miss (new generation)
  const s = cache.stats();
  assert.equal(s.misses, 2);
  assert.equal(s.hits, 2);
  assert.equal(s.invalidations, 1);
  assert.equal(s.generation, 1);
  assert.equal(s.cached, true);
});

test("a build is required and is lazy (nothing is built until the first get)", () => {
  assert.throws(() => createSnapshotCache({}), /build\(\)/);
  let builds = 0;
  const cache = createSnapshotCache({ build: () => ++builds });
  assert.equal(cache.stats().buildMs === undefined || cache.stats().lastBuildMs === null, true);
  assert.equal(cache.stats().cached, false);
  cache.get();
  assert.equal(cache.stats().cached, true);
});

test("reconnect reads the current generation (anti-entropy recovery is preserved)", () => {
  // A reconnecting client calls get() after some state changed elsewhere and invalidated the
  // cache. It must receive the fresh board, not the snapshot it held before it disconnected.
  const versions = ["v1", "v2", "v3"];
  let i = 0;
  const cache = createSnapshotCache({ build: () => versions[i] });
  assert.equal(cache.get(), "v1"); // initial connect frame
  i = 1;
  cache.invalidate(); // a write landed while the client was away
  assert.equal(cache.get(), "v2"); // reconnect gets the current board
  i = 2;
  cache.invalidate();
  assert.equal(cache.get(), "v3");
});

test("text() stringifies once per generation and hands the same string to every reader", () => {
  let builds = 0;
  const cache = createSnapshotCache({ build: () => ({ n: ++builds }) });
  const first = cache.text();
  const second = cache.text();
  assert.equal(first, second, "the same string is reused");
  assert.equal(builds, 1, "one build for the generation");
  assert.equal(first, JSON.stringify({ n: 1 }));
  cache.invalidate();
  const third = cache.text();
  assert.equal(third, JSON.stringify({ n: 2 }), "a changed board rebuilds the string once");
  const s = cache.stats();
  assert.equal(s.textMisses, 2);
  assert.equal(s.textHits, 1);
});

test("textAsync builds the same string in slices and hands it to every reader", async () => {
  let builds = 0;
  let slices = 0;
  const cache = createSnapshotCache({
    build: () => ({ n: ++builds }),
    serialize: async (value) => {
      slices += 1;
      return JSON.stringify(value);
    },
  });
  const first = await cache.textAsync();
  const second = await cache.textAsync();
  assert.equal(first, JSON.stringify({ n: 1 }));
  assert.equal(second, first, "the second reader gets the built text, not a second build");
  assert.equal(builds, 1);
  assert.equal(slices, 1, "one serialization for the generation");
  cache.invalidate();
  assert.equal(cache.freshText(), null, "the text no longer describes the current generation");
  assert.equal(cache.lastText(), first, "but the last text is still answerable while a rebuild runs");
  const third = await cache.textAsync();
  assert.equal(third, JSON.stringify({ n: 2 }));
});

test("two readers waiting on one generation share a single build", async () => {
  let builds = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const cache = createSnapshotCache({
    build: () => ({ n: ++builds }),
    serialize: async (value) => {
      await gate;
      return JSON.stringify(value);
    },
  });
  const a = cache.textAsync();
  const b = cache.textAsync();
  release();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(first, second);
  assert.equal(builds, 1, "one build for two readers");
  assert.equal(cache.stats().textBuilding, false, "the in-flight marker is cleared");
});
