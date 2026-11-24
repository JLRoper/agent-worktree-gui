// JSON.stringify, in slices.
//
// The board's snapshot is 3.4-4.3 MB and one `JSON.stringify` of it measured 0.7s on a quiet box and 3.5s on the
// loaded one (2026-11-24) - every millisecond of it on the panel's single event loop, which is why a poll of a big
// board showed up in the log as an "event loop stalled" freeze rather than a slow request.
//
// This walks the same value and emits the same bytes, but yields to the loop between slices, so the work is spread
// over the time it takes rather than held in one block. The leaf values are delegated to JSON.stringify itself, so
// escaping, number formatting (-0, NaN, Infinity), key order and `toJSON` are exactly the built-in's.
//
// It is deliberately a *string* builder, not a stream: the callers hand the result to sendJsonText / an SSE frame,
// both of which want the whole text anyway.
export async function stringifyInChunks(value, { budgetMs = 8, serialize = (v) => JSON.stringify(v), yieldTo = null } = {}) {
  const parts = [];
  const pause = () => new Promise((resolve) => (yieldTo ? yieldTo(resolve) : setImmediate(resolve)));
  let sliceStartedAt = Date.now();

  async function tick() {
    if (Date.now() - sliceStartedAt < budgetMs) return;
    await pause();
    sliceStartedAt = Date.now();
  }

  async function walk(node) {
    if (node === null) {
      parts.push("null");
      return;
    }
    const kind = typeof node;
    if (kind !== "object") {
      // Strings, numbers, booleans: the built-in's own bytes, including `undefined`'s omission rule (handled by the
      // caller) and non-finite numbers becoming `null`.
      const out = serialize(node);
      parts.push(out === undefined ? "null" : out);
      return;
    }
    if (typeof node.toJSON === "function") {
      await walk(node.toJSON());
      return;
    }
    if (Array.isArray(node)) {
      parts.push("[");
      for (let i = 0; i < node.length; i++) {
        if (i) parts.push(",");
        const item = node[i];
        if (item === undefined || typeof item === "function" || typeof item === "symbol") parts.push("null");
        else await walk(item);
        await tick();
      }
      parts.push("]");
      return;
    }
    parts.push("{");
    let first = true;
    for (const key of Object.keys(node)) {
      const item = node[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol") continue;
      if (!first) parts.push(",");
      first = false;
      parts.push(JSON.stringify(key), ":");
      await walk(item);
      await tick();
    }
    parts.push("}");
  }

  await walk(value);
  return parts.join("");
}
