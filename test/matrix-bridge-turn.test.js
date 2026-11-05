// The bridge script's panel contract, run from the repo's own suite.
//
// `matrix-bridge/test_bridge_turn.py` holds the cases — the policy appended to the turn, fetched again on the
// next turn, a failed fetch said in the prompt AND the reply, the reminder list plus the read-only watches view
// carried, and no write path for a watch. This wrapper is what `npm test` executes: the repo is zero-dependency
// Node, so the Python suite becomes a gate by being spawned, never by being copied into a second language. A host
// with no Python SKIPS rather than fails — the gate is about the bridge's behaviour, not about installing a
// runtime the panel does not need.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITE = path.join(HERE, "..", "matrix-bridge", "test_bridge_turn.py");

// WTGUI_PYTHON first (the interpreter the panel is configured with), then the names a fresh shell has.
async function findPython() {
  for (const bin of [process.env.WTGUI_PYTHON, process.env.PYTHON, "python", "python3", "py"].filter(Boolean)) {
    try {
      await execFileP(bin, ["--version"], { windowsHide: true, timeout: 15_000 });
      return bin;
    } catch {
      /* not this one */
    }
  }
  return null;
}

test("the bridge obeys the panel's policy per turn, reports a failed fetch, and never writes a watch", async (t) => {
  assert.ok(existsSync(SUITE), "the Python suite is in the repo, beside the bridge it tests");
  const python = await findPython();
  if (!python) return t.skip("no Python on PATH — the bridge's own suite cannot run on this host");

  let stdout = "";
  let stderr = "";
  try {
    const out = await execFileP(python, [SUITE], { windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    stdout = out.stdout || "";
    stderr = out.stderr || "";
  } catch (e) {
    // A failing suite's output is the evidence; assert with it rather than with "Command failed".
    assert.fail(`matrix-bridge/test_bridge_turn.py failed:\n${(e && e.stdout) || ""}${(e && e.stderr) || ""}`);
  }
  const all = `${stdout}${stderr}`;
  assert.match(all, /Ran \d+ tests? in /, "the suite ran its cases");
  assert.match(all, /^OK/m, "every case passed");
  assert.doesNotMatch(all, /FAILED \(/);
});
