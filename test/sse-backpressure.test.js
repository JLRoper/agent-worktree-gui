import assert from "node:assert/strict";
import test from "node:test";
import { MAX_CLIENT_BUFFER_BYTES, writeClientFrame } from "../lib/sse-write.js";

function fakeClient(writableLength) {
  return {
    writableLength,
    writes: [],
    destroyed: false,
    write(frame) {
      this.writes.push(frame);
    },
    destroy() {
      this.destroyed = true;
    },
  };
}

test("a client whose socket buffer is over the cap is dropped without a write", () => {
  const res = fakeClient(MAX_CLIENT_BUFFER_BYTES + 1);
  const clients = new Set([res]);
  const metrics = {};
  assert.equal(writeClientFrame(res, "event: x\ndata: 1\n\n", { clients, metrics }), false);
  assert.equal(res.writes.length, 0, "nothing else is buffered for a peer that is this far behind");
  assert.equal(clients.has(res), false);
  assert.equal(res.destroyed, true);
  assert.equal(metrics.backpressureDrops, 1);
});

test("a client under the cap is written to normally", () => {
  const res = fakeClient(MAX_CLIENT_BUFFER_BYTES - 1);
  const clients = new Set([res]);
  const metrics = {};
  assert.equal(writeClientFrame(res, "frame", { clients, metrics }), true);
  assert.deepEqual(res.writes, ["frame"]);
  assert.equal(clients.has(res), true);
  assert.equal(res.destroyed, false);
  assert.equal(metrics.backpressureDrops, undefined);
});

test("a write that throws counts a write error and drops the client", () => {
  const res = fakeClient(0);
  res.write = () => {
    throw new Error("EPIPE");
  };
  const clients = new Set([res]);
  const metrics = {};
  assert.equal(writeClientFrame(res, "frame", { clients, metrics }), false);
  assert.equal(clients.has(res), false);
  assert.equal(metrics.writeErrors, 1);
});
