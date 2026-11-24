// The chunked serializer must be the built-in's bytes, and must not hold the loop while it writes them.
import test from "node:test";
import assert from "node:assert/strict";
import { stringifyInChunks } from "../lib/json-chunks.js";

const tricky = {
  a: 1,
  b: -0,
  c: [1, "two", null, true, false],
  d: { nested: { deeper: [1, 2, 3] } },
  e: "quotes \" and \\ backslash \n newline \t tab",
  f: "unicode: ✓ 日本語 \u0000 control",
  g: [],
  h: {},
  i: [undefined, () => {}, Symbol("s"), 1],
  j: { u: undefined, f: () => {}, keep: 2 },
  k: 1e21,
  l: 0.1 + 0.2,
  m: new Date("2026-11-24T00:00:00.000Z"),
  n: null,
  o: "line\u2028separator\u2029",
};

test("stringifyInChunks writes exactly the bytes JSON.stringify writes", async () => {
  const out = await stringifyInChunks(tricky);
  assert.equal(out, JSON.stringify(tricky));
});

test("and it is identical for the shapes a board is made of", async () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({
    name: `tree-${i}`,
    path: `C:/x/${i}`,
    files: Array.from({ length: 5 }, (_, j) => `f${j}.js`),
    nested: { a: i, b: [i, i + 1], c: null },
    unicode: "→ ✓",
  }));
  const doc = { generatedAt: "2026-11-24T00:00:00.000Z", projects: [{ name: "p", worktrees: rows }] };
  assert.equal(await stringifyInChunks(doc), JSON.stringify(doc));
});

test("it yields to the loop while it writes a large document", async () => {
  const big = { rows: Array.from({ length: 20000 }, (_, i) => ({ i, s: `value-${i}`, a: [i, i, i] })) };
  let yields = 0;
  let maxGap = 0;
  let last = Date.now();
  const started = Date.now();
  const text = await stringifyInChunks(big, {
    budgetMs: 4,
    yieldTo: (resolve) =>
      setImmediate(() => {
        yields += 1;
        const now = Date.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
        resolve();
      }),
  });
  const tookMs = Date.now() - started;
  assert.equal(text, JSON.stringify(big), "the bytes are still the built-in's");
  assert.ok(yields > 2, `expected several slices, saw ${yields} in ${tookMs}ms`);
  assert.ok(maxGap < 100, `a slice held the loop for ${maxGap}ms`);
});

test("a small value needs no slice at all", async () => {
  let yields = 0;
  const out = await stringifyInChunks({ a: 1 }, { budgetMs: 1000, yieldTo: (r) => { yields += 1; r(); } });
  assert.equal(out, '{"a":1}');
  assert.equal(yields, 0);
});
