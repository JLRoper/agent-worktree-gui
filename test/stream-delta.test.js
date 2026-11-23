// The stream's two shapes (lib/http/transport.js): a reader that asks for the lean shape gets the board and then
// only what the board did not carry; a reader that asks for nothing is answered exactly as before. The frame bodies
// are the composition root's, so a fake one here proves the transport's own rule and nothing about the store.
import assert from "node:assert/strict";
import test from "node:test";

import { handleStream } from "../lib/http/transport.js";

function streamFake(url = "/api/stream") {
  const chunks = [];
  const socket = { remoteAddress: "127.0.0.1" };
  const res = {
    destroyed: false,
    writableEnded: false,
    socket,
    writeHead() {},
    write(chunk) {
      chunks.push(String(chunk));
    },
    on() {},
  };
  const req = { url, socket, on() {} };
  return { chunks, req, res };
}

const settle = () => new Promise((r) => setImmediate(r));

const boardText = () => '{"projects":[{"name":"a"}]}';

test("a reader that asks for the lean shape is handed the board text it received and gets the delta frame", async () => {
  const lean = streamFake("/api/stream?shape=delta");
  const seen = [];
  handleStream(lean.req, lean.res, {
    clients: new Set(),
    boardText,
    snapshotText: () => "full-body",
    snapshotFrame: ({ boardBody }) => {
      seen.push(boardBody);
      return "event: snapshot\ndata: {\"type\":\"snapshot\",\"delta\":true}\n\n";
    },
    fullReady: () => true,
  });
  await settle();
  await settle();
  assert.equal(lean.res.wagShape, "delta", "the client is remembered as a lean one for every later push");
  assert.equal(seen.length, 1);
  assert.equal(seen[0], boardText(), "the delta is computed against the exact bytes this client was sent");
  assert.match(lean.chunks[0], /^event: board\ndata: /);
  assert.match(lean.chunks[1], /"delta":true/);
  assert.ok(!lean.chunks.some((c) => c.includes("full-body")), "a lean reader never pays for the full frame");
});

test("a reader that asks for nothing gets the full snapshot, byte for byte as before", async () => {
  const classic = streamFake("/api/stream");
  let deltaCalls = 0;
  handleStream(classic.req, classic.res, {
    clients: new Set(),
    boardText,
    snapshotText: () => "full-body",
    snapshotFrame: () => {
      deltaCalls += 1;
      return "event: snapshot\ndata: {\"delta\":true}\n\n";
    },
    fullReady: () => true,
  });
  await settle();
  await settle();
  assert.equal(classic.res.wagShape, undefined);
  assert.equal(deltaCalls, 0, "the lean builder is not consulted for a classic reader");
  assert.equal(classic.chunks[1], "event: snapshot\ndata: full-body\n\n");
});

test("an unknown shape is the classic one - a typo must not silently change the protocol", async () => {
  const odd = streamFake("/api/stream?shape=lean");
  let deltaCalls = 0;
  handleStream(odd.req, odd.res, {
    clients: new Set(),
    boardText,
    snapshotText: () => "full-body",
    snapshotFrame: () => {
      deltaCalls += 1;
      return "x";
    },
    fullReady: () => true,
  });
  await settle();
  await settle();
  assert.equal(deltaCalls, 0);
  assert.equal(odd.chunks[1], "event: snapshot\ndata: full-body\n\n");
});

test("a lean reader that attaches mid-boot is marked for a full frame, because it never got the delta's baseline", async () => {
  const mid = streamFake("/api/stream?shape=delta");
  handleStream(mid.req, mid.res, {
    clients: new Set(),
    boardText,
    snapshotText: () => "full-body",
    snapshotFrame: () => "event: snapshot\ndata: {\"delta\":true}\n\n",
    fullReady: () => false,
  });
  await settle();
  await settle();
  assert.equal(mid.res.wagNeedsFull, true);
  assert.equal(mid.chunks.filter((c) => c.startsWith("event: snapshot")).length, 0);
});

test("a snapshot that cannot be built is counted and logged, never written half-way", async () => {
  const broken = streamFake("/api/stream?shape=delta");
  const metrics = { writeErrors: 0 };
  handleStream(broken.req, broken.res, {
    clients: new Set(),
    boardText,
    snapshotText: () => "full-body",
    snapshotFrame: () => {
      throw new Error("store refused");
    },
    metrics,
    fullReady: () => true,
  });
  await settle();
  await settle();
  assert.equal(metrics.writeErrors, 1);
  assert.equal(broken.chunks.filter((c) => c.startsWith("event: snapshot")).length, 0);
});
