// Settings → General's server half: the two scan knobs are written to config.json (so they survive a restart) and
// applied LIVE (so the reader does not restart a board to save two seconds of scanning), and a value outside its
// range is refused with a sentence naming the knob instead of being clamped behind the reader's back.
//
// The live half is the assertion that matters: `worktreeSeconds` comes back from /api/config, which is the same
// answer the page paints and the scheduler's cfg holds, and `threads` is the pool the panel rebuilt.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { startPanel, post } from "../tools/panel-testkit.mjs";

test("the General route writes both scan knobs, applies them live, and refuses a value outside its range", async (t) => {
  const panel = await startPanel();
  t.after(() => panel.stop());

  const before = JSON.parse(await readFile(panel.configPath, "utf8"));
  assert.equal(before.threads, 1, "the sandbox boots with the testkit's one worker");

  const ok = await post(panel.base, "/api/settings/general", { body: { threads: 3, worktreeSeconds: 15 } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.settings.threads, 3);
  assert.equal(ok.json.settings.worktreeSeconds, 15);

  // The file is the durable half: a restart must come back to these numbers.
  const after = JSON.parse(await readFile(panel.configPath, "utf8"));
  assert.equal(after.threads, 3, "threads lands in config.json");
  assert.equal(after.worktreeSeconds, 15, "worktreeSeconds lands in config.json");

  // The live half: /api/config is built from the running config, so it only agrees without a restart if the route
  // applied it. The pool size rides the same answer.
  const cfg = await (await fetch(`${panel.base}/api/config`)).json();
  assert.equal(cfg.worktreeSeconds, 15, "applied without a restart");
  assert.equal(cfg.threads, 3, "the rebuilt pool's size is what the panel reports");

  // Below the floor: refused, named, and the file is untouched.
  const zero = await post(panel.base, "/api/settings/general", { body: { threads: 0 } });
  assert.equal(zero.status, 400, zero.text);
  assert.match(zero.json.error, /scan workers/);
  const fast = await post(panel.base, "/api/settings/general", { body: { worktreeSeconds: 1 } });
  assert.equal(fast.status, 400, fast.text);
  assert.match(fast.json.error, /row refresh/);
  const unchanged = JSON.parse(await readFile(panel.configPath, "utf8"));
  assert.equal(unchanged.threads, 3, "a refused write leaves the last good value");
  assert.equal(unchanged.worktreeSeconds, 15);
});

test("the briefing budget rides the same route and comes back in the answer", async (t) => {
  const panel = await startPanel();
  t.after(() => panel.stop());

  const saved = await post(panel.base, "/api/settings/general", { body: { briefingBudgetChars: 16000 } });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.settings.briefingBudgetChars, 16000);

  // 0 is the off switch, not an error: it is the value every panel had before the knob existed.
  const off = await post(panel.base, "/api/settings/general", { body: { briefingBudgetChars: 0 } });
  assert.equal(off.status, 200, off.text);
  assert.equal(off.json.settings.briefingBudgetChars, 0);

  const tooBig = await post(panel.base, "/api/settings/general", { body: { briefingBudgetChars: 40_001 } });
  assert.equal(tooBig.status, 400, tooBig.text);
  assert.match(tooBig.json.error, /briefing budget/);
});
