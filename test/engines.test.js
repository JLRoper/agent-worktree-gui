// The panel advertises a Node floor. This asserts the floor is one the code can actually start on:
// five modules import node:sqlite statically, and node:sqlite does not exist before 22.5, so an
// older runtime fails while linking the module graph - before any of the panel's own logging runs.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ROOT } from "../tools/panel-testkit.mjs";

const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));

// ">=22.5" -> [22, 5]. The floor is what matters, not the range syntax.
function floorOf(range) {
  const m = /(\d+)\.(\d+)/.exec(String(range || ""));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

test("engines.node is at least the 22.5 that node:sqlite needs", () => {
  const floor = floorOf(pkg.engines?.node);
  assert.ok(floor, `engines.node must name a version, got ${JSON.stringify(pkg.engines?.node)}`);
  const [major, minor] = floor;
  assert.ok(
    major > 22 || (major === 22 && minor >= 5),
    `node:sqlite landed in 22.5; engines.node says ${pkg.engines.node}`,
  );
});

test("the imports that make the floor hard still exist", async () => {
  const sources = ["server.js", ...(await readdir(path.join(ROOT, "lib"))).filter((f) => f.endsWith(".js")).map((f) => path.join("lib", f))];
  const staticImport = /import\s*\{[^}]*\}\s*from\s*["']node:sqlite["']/;
  const staticUsers = [];
  for (const rel of sources) {
    const text = await readFile(path.join(ROOT, rel), "utf8");
    if (staticImport.test(text)) staticUsers.push(rel);
  }
  // If this ever drops to zero, the floor can be lowered honestly; until then 22.5 is a boot
  // requirement, not a feature requirement.
  assert.ok(staticUsers.length >= 5, `expected 5+ static node:sqlite importers, found ${staticUsers.length}: ${staticUsers.join(", ")}`);
});

test("every advert of the requirement names the same number", async () => {
  for (const rel of ["README.md", "SETUP.md", "setup.cmd", "setup.sh"]) {
    const text = await readFile(path.join(ROOT, rel), "utf8");
    assert.match(text, /22\.5/, `${rel} must name the 22.5 floor`);
    assert.doesNotMatch(text, /Node 18|node >= 18|Node 18\+/, `${rel} still advertises Node 18`);
  }
});

test("the setup scripts check the minor, not just the major", async () => {
  const sh = await readFile(path.join(ROOT, "setup.sh"), "utf8");
  const cmd = await readFile(path.join(ROOT, "setup.cmd"), "utf8");
  assert.match(sh, /minor.*-lt 5/, "setup.sh must reject 22.0-22.4");
  assert.match(cmd, /NODEMINOR% LSS 5/i, "setup.cmd must reject 22.0-22.4");
});
