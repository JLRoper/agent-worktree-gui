import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../server.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");

test("broadcast skips event serialization entirely when no client is connected", () => {
  const start = source.indexOf("function broadcast(evt) {");
  const end = source.indexOf("\n}\n\n// One part", start);
  assert.ok(start >= 0 && end > start);
  const clients = new Set();
  const metrics = { writeErrors: 0 };
  let measurements = 0;
  const timing = { measure: (_name, fn) => { measurements++; return fn(); } };
  const broadcast = new Function("clients", "streamMetrics", "syncTiming", `${source.slice(start, end + 2)}; return broadcast;`)(clients, metrics, timing);
  const cyclic = { type: "row" };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => broadcast(cyclic));
  assert.equal(measurements, 0);
  const frames = [];
  clients.add({ write: (frame) => frames.push(frame) });
  broadcast({ type: "row", row: { id: "one" } });
  assert.equal(measurements, 1);
  assert.match(frames[0], /^event: row\ndata: /);
});

test("row event overlays run only when a browser is listening", () => {
  const start = source.indexOf("store.onEvent((evt) => {");
  const end = source.indexOf("\n});", start);
  assert.ok(start >= 0 && end > start);
  let handler;
  let calls = 0;
  const events = [];
  const clients = new Set();
  const store = { onEvent: (fn) => { handler = fn; } };
  new Function("store", "clients", "broadcast", "rowExtras", source.slice(start, end + 4))(
    store, clients, (evt) => events.push(evt), (_project, row) => { calls++; return { ...row, augmented: true }; },
  );
  handler({ type: "row", project: "p", row: { id: 1 } });
  assert.equal(calls, 0);
  assert.equal(events.length, 0);
  clients.add({});
  handler({ type: "row", project: "p", row: { id: 1 } });
  assert.equal(calls, 1);
  assert.equal(events[0].row.augmented, true);
});
