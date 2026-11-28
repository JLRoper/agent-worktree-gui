// The registry tools/panel-testkit.mjs `boot()` keeps, proved where a test can see it: a panel is recorded when it
// starts, a test's own stop() takes it out again, and one sweep stops whatever is left - which is the body of the
// file-level hook. The hook itself (ONE `after()` per file, registered when the kit is evaluated, never per test) is
// shown end to end by tools/panel-boot-proof.mjs: a converted file with every per-test hook stripped, plus a boot
// that throws before it can stop, still exits on its own.
import assert from "node:assert/strict";
import test, { after } from "node:test";

import { boot, panelsBooted, stopBootedPanels } from "../tools/panel-testkit.mjs";

// One file-level hook, registered once and never per test: boot()'s registry, swept after the last test.
after(stopBootedPanels);

const answers = async (base) => {
  try {
    return (await fetch(`${base}/api/health`)).ok;
  } catch {
    return false;
  }
};

test("boot() records the child it started, and a test's own stop() takes it back out", async (t) => {
  const first = await boot();
  const second = await boot();
  t.after(() => first.stop());
  t.after(() => second.stop());

  assert.deepEqual(
    panelsBooted().map((panel) => panel.pid),
    [first.pid, second.pid],
    "both panels are registered, in the order they booted",
  );

  await first.stop();
  assert.equal(
    panelsBooted().some((panel) => panel.pid === first.pid),
    false,
    "a panel a test stopped itself is not the file-level sweep's business",
  );
  assert.equal(
    panelsBooted().some((panel) => panel.pid === second.pid),
    true,
    "the other one is still registered for the sweep",
  );
});

test("stopBootedPanels() stops whatever a test forgot, and the port goes quiet", async () => {
  const panel = await boot();
  assert.equal(await answers(panel.base), true, "the panel answers before the sweep");

  const stopped = await stopBootedPanels();
  assert.deepEqual(
    stopped.map((entry) => ({ pid: entry.pid, stopped: entry.stopped })),
    [{ pid: panel.pid, stopped: true }],
    "the sweep names the child it stopped",
  );
  assert.deepEqual(panelsBooted(), [], "and the registry is empty");
  assert.equal(await answers(panel.base), false, "nothing is listening on the panel's port any more");
});
