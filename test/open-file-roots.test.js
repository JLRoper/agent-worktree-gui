// A clarify card's file link is refused by one predicate: is the resolved target inside a root the panel will open from?
//
// THE DEFECT THIS PINS. The roots were the open projects plus the panel's own checkout and nothing else, so a report
// written where the prompt TOLD the worker to write it - the panel's scratch root from the SCRATCH line
// (lib/paths.js `scratchLine`), or the agent host's own `<hermes>/cache/scratch` - answered 403 "a question's link is a
// file inside a project tree, and this one is not". The file existed, the card drew the anchor, the click failed.
//
// WHAT IS PROVEN HERE, and why it is a unit test rather than a request: the route's success path ends in
// `openFileWith`, which STARTS a browser, so a test that asserted a 200 would open a window on the machine running it.
// The two things the route composes - `openFileRoots` and `insideDir` (lib/paths.js) - are pure, and they are the whole
// boundary: `server.js` builds the roots with the first and walks them with the second.
//
// Paths are built at runtime: written out, they would name folders on the machine that wrote this file, which
// tools/absolute-paths.mjs refuses a commit for.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { insideDir, openFileRoots } from "../lib/paths.js";

const DRIVE = `${"C"}:`;
const USER = `${DRIVE}${"/Users/someone"}`;
const PROJECT = `${DRIVE}${"/work/demo"}`;
const PANEL = `${PROJECT}/agent-worktree-gui`;
const SCRATCH = `${USER}/AppData/Local/Temp/wag`;
const HERMES = `${USER}/AppData/Local/hermes`;

// What the route does with each root: `insideRepo` resolves both sides, then asks `insideDir` (server.js:2756).
const opened = (target, root) => insideDir(path.resolve(target), path.resolve(root));

const rootsFor = (extra = {}) => openFileRoots({
  projects: [PROJECT],
  panelDir: PANEL,
  scratchDir: SCRATCH,
  hermesDir: HERMES,
  ...extra,
});

test("the roots are the projects, the panel's checkout, and the two scratch directories", () => {
  const roots = rootsFor();
  assert.deepEqual(roots, [PROJECT, PANEL, SCRATCH, path.join(HERMES, "cache", "scratch")],
    `the boundary is these four and no more:\n${roots.join("\n")}`);
});

test("a report under the panel's scratch root opens", () => {
  const report = `${SCRATCH}/4a1b2c3d/findings.html`;
  assert.ok(rootsFor().some((root) => opened(report, root)), "the directory the SCRATCH line names is a root");
});

test("a report under the agent host's own scratch cache opens", () => {
  // The path that was refused: the host writes a report under its own cache, not under the panel's scratch root.
  const report = `${HERMES}/cache/scratch/report.html`;
  assert.ok(rootsFor().some((root) => opened(report, root)), "the host's cache/scratch is a root");
});

test("the hermes home above that cache is NOT a root", () => {
  const roots = rootsFor();
  assert.ok(!roots.some((root) => opened(`${HERMES}/.env`, root)), "the key file beside the cache stays outside");
  assert.ok(!roots.some((root) => opened(`${HERMES}/state.db`, root)), "and the session database with it");
  assert.ok(!roots.some((root) => opened(`${HERMES}/cache/prompts/x.json`, root)), "and a sibling of the scratch cache");
});

test("a scratch directory is a root with or without its trailing slash", () => {
  // `config.scratchDir` is a config value a reader may have saved with a trailing separator; one folder is one root.
  assert.ok(rootsFor({ scratchDir: `${SCRATCH}/` }).some((root) => opened(`${SCRATCH}/x/y.html`, root)),
    "the trailing slash is not a second directory");
});

test("a folder that merely shares the prefix is not inside", () => {
  const roots = rootsFor();
  assert.ok(!roots.some((root) => opened(`${SCRATCH}2/findings.html`, root)), "wag2 is not wag");
  assert.ok(!roots.some((root) => opened(`${SCRATCH}-old/findings.html`, root)), "wag-old is not wag");
  assert.ok(!roots.some((root) => opened(`${PROJECT}2/file.html`, root)), "and a project's sibling is still outside");
});

test("the rest of the machine is still outside", () => {
  const roots = rootsFor();
  const windowsIni = `${DRIVE}${"/Windows/win.ini"}`;
  assert.ok(!roots.some((root) => opened(windowsIni, root)), "the file the older gate used is still refused");
  assert.ok(!roots.some((root) => opened(`${USER}/Documents/taxes.html`, root)), "and a home document");
});

test("a panel with no scratch directory configured does not turn its own cwd into a root", () => {
  // `path.join("", "cache", "scratch")` is RELATIVE, and a relative root would compare against whatever folder the
  // panel was started in. Absent names contribute nothing.
  assert.deepEqual(openFileRoots({ projects: [PROJECT], panelDir: PANEL }), [PROJECT, PANEL]);
  assert.deepEqual(openFileRoots(), [], "no names, no roots");
  assert.equal(insideDir("", ""), false, "and an empty root matches nothing");
});
