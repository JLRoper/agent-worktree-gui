// The Hermes readers when state.db cannot be opened. memo() resolved a rejected factory to the
// previous value (null on the first call), hermesSessionRoots then iterated that null and threw, and
// the scheduler answered with an empty Map and no log line: every Hermes chip gone, no reason anywhere.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hermesSessionRoots, hermesSessions } from "../lib/activity.js";

test("an unreadable state.db yields an empty value and one explanatory line", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "wtgui-hermes-"));
  const previousHome = process.env.HERMES_HOME;
  process.env.HERMES_HOME = home;
  const seen = [];
  const realError = console.error;
  console.error = (...a) => seen.push(a.join(" "));
  t.after(async () => {
    console.error = realError;
    if (previousHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  // The value, not a rejection: null here is what made the caller throw.
  assert.deepEqual(await hermesSessions(), [], "no sessions is an empty list, never null");

  // The whole chain: attribution must answer a Map (no chips) instead of throwing on `for..of null`.
  const roots = await hermesSessionRoots(["C:/work/tree"]);
  assert.ok(roots instanceof Map, "attribution returns a Map even when the store is unreadable");
  assert.equal(roots.size, 0);

  // A second call inside the cache window must not add a second line.
  await hermesSessions();
  const mine = seen.filter((m) => /Hermes session store unreadable/.test(m));
  assert.equal(mine.length, 1, `one line per distinct failure, got ${mine.length}: ${seen.join(" | ")}`);
  assert.match(mine[0], /state\.db/, "the line names the file that could not be read");
});
