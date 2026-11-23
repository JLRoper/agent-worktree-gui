// The boot pass walks the fleet with every row frame suppressed (the store's own gate), so a reader that arrives
// mid-boot can use the board and nothing else. These tests pin the two reads to that fact: the state read answers the
// compact board frame while the pass runs (building the panes there cost 1.2-2.5s per poll on the panel's loop), and
// the stream's second frame is deferred to the boot's own broadcast instead of being built for that reader.

import test from "node:test";
import assert from "node:assert/strict";

import { createStateRoutes, STATE_PATH, AUDIT_PATH, BOARD_PATH } from "../routes/state.js";
import { handleStream } from "../lib/http/transport.js";

/** The recorder routes/state.js is driven with: what status, what body. */
function recorder() {
  const out = { status: 0, body: "" };
  const res = {
    writeHead(status) {
      out.status = status;
    },
    end(body) {
      out.body = String(body);
    },
  };
  return { out, res };
}

/** The smallest response an SSE attach writes to. */
function streamFake() {
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
  const req = { socket, on() {} };
  return { chunks, req, res };
}

const settle = () => new Promise((r) => setImmediate(r));

test("a state poll during the boot answers the board frame, and the full read once the pass is done", async () => {
  let ready = false;
  let fullBuilds = 0;
  let boardBuilds = 0;
  const routes = createStateRoutes({
    snapshotText: () => {
      fullBuilds += 1;
      return '{"full":true}';
    },
    boardText: () => {
      boardBuilds += 1;
      return '{"board":true}';
    },
    sendJsonText: (res, status, body) => {
      res.writeHead(status);
      res.end(body);
    },
    fullReady: () => ready,
  });

  const during = recorder();
  assert.equal(await routes({}, during.res, STATE_PATH), true);
  assert.equal(during.out.status, 200);
  assert.equal(during.out.body, '{"board":true}');
  assert.equal(fullBuilds, 0, "the panes are not built for a reader the boot cannot serve yet");
  assert.equal(boardBuilds, 1);

  // The older name answers the same read, under the same rule.
  const audit = recorder();
  await routes({}, audit.res, AUDIT_PATH);
  assert.equal(audit.out.body, '{"board":true}');

  ready = true;
  const after = recorder();
  await routes({}, after.res, STATE_PATH);
  assert.equal(after.out.body, '{"full":true}');
  assert.equal(fullBuilds, 1);
});

test("/api/board still answers the compact frame once the boot is done", async () => {
  const routes = createStateRoutes({
    snapshotText: () => '{"full":true}',
    boardText: () => '{"board":true}',
    sendJsonText: (res, status, body) => {
      res.writeHead(status);
      res.end(body);
    },
    fullReady: () => true,
  });
  const out = recorder();
  assert.equal(await routes({}, out.res, BOARD_PATH), true);
  assert.equal(out.out.body, '{"board":true}');
});

test("a reader that attaches mid-boot gets the board frame and no full frame until the boot broadcasts one", async () => {
  const mid = streamFake();
  handleStream(mid.req, mid.res, {
    clients: new Set(),
    boardText: () => "board-body",
    snapshotText: () => "full-body",
    fullReady: () => false,
  });
  await settle();
  await settle();
  assert.equal(mid.chunks.filter((c) => c.startsWith("event: board")).length, 1);
  assert.equal(mid.chunks.filter((c) => c.startsWith("event: snapshot")).length, 0, "nothing builds the panes mid-boot");
  assert.match(mid.chunks[0], /data: board-body/);
});

test("a reader that attaches after the boot still gets both frames", async () => {
  const after = streamFake();
  handleStream(after.req, after.res, {
    clients: new Set(),
    boardText: () => "board-body",
    snapshotText: () => "full-body",
    fullReady: () => true,
  });
  await settle();
  await settle();
  assert.equal(after.chunks.filter((c) => c.startsWith("event: board")).length, 1);
  assert.equal(after.chunks.filter((c) => c.startsWith("event: snapshot")).length, 1);
  assert.match(after.chunks[1], /data: full-body/);
});
