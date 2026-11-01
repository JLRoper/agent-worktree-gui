// One panel per port (lib/port-guard.js, asked from server.js before the panel touches anything).
//
// The incident it answers, 2026-11-01: on Windows a 127.0.0.1 bind and a 0.0.0.0 bind share a port without an error,
// and loopback traffic goes to the 127.0.0.1 one. An orphaned sandbox panel (pid 37748) sat on 127.0.0.1:7331 over the
// reader's own panel (pid 35400, 0.0.0.0:7331): http://127.0.0.1:7331 answered "0 project(s)" while the real board
// kept running behind it. A panel now refuses to start on a port something already answers on.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { portAnswers, portHolder, probeHosts, refusalLine } from "../lib/port-guard.js";
import { freePort, startPanel } from "../tools/panel-testkit.mjs";

// A bare TCP listener: answers the connect, says nothing (as a second panel, or any other program, would to a probe).
function listen(port, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((s) => s.destroy());
    srv.once("error", reject);
    srv.listen(port, host, () => resolve(srv));
  });
}
const close = (srv) => new Promise((r) => srv.close(() => r()));

test("the probe asks loopback always, and the configured host when it is an address of its own", () => {
  assert.deepEqual(probeHosts("0.0.0.0"), ["127.0.0.1"], "an all-interfaces panel is shadowed on loopback");
  assert.deepEqual(probeHosts("127.0.0.1"), ["127.0.0.1"]);
  assert.deepEqual(probeHosts(""), ["127.0.0.1"]);
  assert.deepEqual(probeHosts("192.168.1.20"), ["127.0.0.1", "192.168.1.20"]);
});

test("a port with a listener answers; a closed one does not, and says so at once", async () => {
  const port = await freePort();
  const t0 = Date.now();
  assert.equal(await portAnswers("127.0.0.1", port), false, "nothing there");
  assert.ok(Date.now() - t0 < 1000, "a refused connection is a quick no, not a timeout");
  const srv = await listen(port);
  try {
    assert.equal(await portAnswers("127.0.0.1", port), true);
  } finally {
    await close(srv);
  }
});

test("a predecessor still letting go of the port is waited for; one that stays is the answer", async () => {
  let asked = 0;
  const leaving = (h, p) => Promise.resolve(++asked <= 3); // answers three times, then the port is free
  assert.equal(await portHolder({ port: 7331, host: "0.0.0.0", waitMs: 5000, stepMs: 5, probe: leaving }), null);
  assert.equal(asked, 4, "it asked until the port was free");
  const staying = () => Promise.resolve(true);
  const t0 = Date.now();
  assert.equal(await portHolder({ port: 7331, host: "0.0.0.0", waitMs: 120, stepMs: 20, probe: staying }), "127.0.0.1");
  assert.ok(Date.now() - t0 >= 100, "and only after the wait ran out");
  assert.equal(await portHolder({ port: 0, host: "0.0.0.0", probe: staying }), null, "port 0 has nothing to collide with");
  assert.match(refusalLine("127.0.0.1", 7331), /REFUSING to start: 127\.0\.0\.1:7331 already answers.*findstr :7331.*"port"/);
});

test("a panel configured for 0.0.0.0 refuses a port something already answers on loopback, before writing anything", async () => {
  const port = await freePort();
  const srv = await listen(port, "127.0.0.1");
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-port-guard-"));
  try {
    await assert.rejects(
      startPanel({ dir, port, config: { host: "0.0.0.0" }, env: { PANEL_PORT_WAIT_MS: "300" } }),
      (e) => {
        assert.match(e.message, /exited before it was ready \(\{"code":1/, "the boot stopped itself, exit code 1");
        assert.match(e.message, new RegExp(`REFUSING to start: 127\\.0\\.0\\.1:${port} already answers`), "and said why");
        return true;
      },
    );
    assert.equal(existsSync(path.join(dir, "logs")), false, "it stopped before creating its data directory or reading a job");
  } finally {
    await close(srv);
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("a free port boots as before (control)", async () => {
  const panel = await startPanel({ env: { PANEL_PORT_WAIT_MS: "8000" } });
  try {
    assert.equal((await fetch(`${panel.base}/api/health`)).ok, true);
  } finally {
    await panel.stop();
  }
});

test("a replacement waits for a predecessor still letting go of the port, instead of dying on EADDRINUSE", async () => {
  const port = await freePort();
  const srv = await listen(port, "127.0.0.1");
  setTimeout(() => void close(srv), 600); // the outgoing panel releases the port a moment after the new one starts
  const panel = await startPanel({ port, env: { PANEL_PORT_WAIT_MS: "8000" } });
  try {
    const r = await fetch(`${panel.base}/api/health`);
    assert.equal(r.ok, true, "the replacement came up on the port its predecessor left");
  } finally {
    await panel.stop();
  }
});
