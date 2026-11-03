// The dogfood harness's own contract: the documented entry point, the npm script, and the safety rules that make
// the run worth trusting. Nothing here boots a panel or a browser — that is the tool's job, twice a release at
// most — so this suite stays fast.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../tools/panel-testkit.mjs";

const TOOL = path.join(ROOT, "tools", "dogfood-chat.mjs");

test("the harness is a real file and answers --help with every documented knob", () => {
  assert.ok(existsSync(TOOL), "tools/dogfood-chat.mjs is missing");
  const out = execFileSync(process.execPath, [TOOL, "--help"], { encoding: "utf8", cwd: ROOT, timeout: 20_000 });
  for (const flag of ["--turns", "--out", "--assistant", "--thread", "--gateway", "--port", "--turn-timeout", "--keep", "--headed"]) {
    assert.ok(out.includes(flag), `--help does not document ${flag}`);
  }
  // The default assistant is the seeded second one, whose thread this run owns; #1's thread is the reader's.
  assert.match(out, /--assistant ID\s+which assistant tab to drive \(default assistant-2/);
});

test("npm run dogfood:chat runs the harness", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["dogfood:chat"], "node tools/dogfood-chat.mjs");
});

// A dogfood run writes cards, turns and journal lines; pointed at the reader's own board it would be
// indistinguishable from their activity afterwards. Three guards carry that promise, and all three are one
// character away from being deleted by a later edit:
//   * :7331 is refused outright,
//   * the report goes to a durable directory outside the repository,
//   * a run on the primary assistant's thread needs an explicit opt-in (that session belongs to the reader).
test("the run can never be the reader's board", () => {
  const src = readFileSync(TOOL, "utf8");
  assert.match(src, /if \(port === 7331\) throw new Error/, "the :7331 guard is gone");
  assert.match(src, /agent-worktree-gui\/dogfood-chat/, "the default report directory moved out of CodeReviews");
  assert.match(src, /--allow-shared-session/, "the shared-session opt-in is gone");
  assert.match(src, /no path in \/api\/state points at the reader's \.wag store/, "the .wag isolation assertion is gone");
});
