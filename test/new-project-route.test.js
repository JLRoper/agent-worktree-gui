// POST /api/project/new — a NEW local git project in one configured scan root.
//
//   {root, name} -> 201, and on disk: `main` exists, HEAD points at it, exactly ONE commit.
//
// The clone beside it refuses a destination that already exists; this route has to as well, because
// `git init` on top of somebody's checkout is silent and unrecoverable. The refusals are the half a
// reader meets, so they are asserted by status AND by the sentence the page prints.
//
// The last check is the reason the route commits at all: a repo with an unborn HEAD scans as
// NO BASE REF, and the panel then refuses every spawn off the project. So the row is read back after
// the create, and git's own `rev-list --count HEAD` has to answer 1 — not "the first commit was
// attempted", but "there is a base ref".
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { git, post, slash, startPanel, waitForRow, waitForState } from "../tools/panel-testkit.mjs";

test("the new-project route inits main with one commit and boards the project", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "wtgui-newproj-"));
  const scanRoot = path.join(base, "repos");
  await mkdir(scanRoot, { recursive: true });
  const panel = await startPanel({
    // Rows arrive on a scan pass, not from discovery: the fast cadences keep the wait a second, not a minute.
    config: { scanRoots: [scanRoot], worktreeSeconds: 1, midSeconds: 1, dormantSeconds: 1, slowSeconds: 2 },
  });
  t.after(async () => {
    await panel.stop();
    await rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  // A root that is not a scanRoot: 400, with the configured roots in the sentence.
  const outside = await post(panel.base, "/api/project/new", { body: { root: path.join(base, "elsewhere"), name: "proj" } });
  assert.equal(outside.status, 400, `a root outside scanRoots is refused: ${outside.text.slice(0, 200)}`);
  assert.match(outside.json?.error || "", /root must be one of scanRoots/);
  assert.equal(existsSync(path.join(base, "elsewhere", "proj")), false, "a refused root writes nothing");

  // One path segment, same charset as a repo name: no `owner/`, no separators, no traversal.
  for (const name of ["owner/repo", "../escape", "..", ".", "", "with space", "a\\b", ".hidden"]) {
    const bad = await post(panel.base, "/api/project/new", { body: { root: scanRoot, name } });
    assert.equal(bad.status, 400, `${JSON.stringify(name)} is not a project name: ${bad.text.slice(0, 200)}`);
    assert.match(bad.json?.error || "", /not a project name/);
  }
  assert.equal(existsSync(path.join(base, "escape")), false, "a traversal never makes a folder");
  assert.equal(existsSync(path.join(scanRoot, "repo")), false, "an `owner/name` never lands one level down");

  // An existing folder is a 409 — and it is left exactly as it was.
  const taken = path.join(scanRoot, "taken");
  await mkdir(taken, { recursive: true });
  await writeFile(path.join(taken, "keep.txt"), "not mine to init\n", "utf8");
  const exists = await post(panel.base, "/api/project/new", { body: { root: scanRoot, name: "taken" } });
  assert.equal(exists.status, 409, exists.text.slice(0, 200));
  assert.match(exists.json?.error || "", /already exists/);
  assert.throws(() => git(taken, ["rev-parse", "--git-dir"]), "the existing folder was not inited");
  assert.equal(existsSync(path.join(taken, "keep.txt")), true);

  // The press.
  const made = await post(panel.base, "/api/project/new", { body: { root: scanRoot, name: "fresh-idea" } });
  assert.equal(made.status, 201, made.text.slice(0, 400));
  const dest = path.join(scanRoot, "fresh-idea");
  assert.equal(made.json?.ok, true);
  assert.equal(slash(made.json?.dest), slash(dest));
  assert.equal(made.json?.branch, "main");

  // git's own answers: `main` exists, HEAD is on it, and there is exactly ONE commit.
  assert.equal(git(dest, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
  assert.equal(git(dest, ["rev-parse", "--verify", "refs/heads/main"]), git(dest, ["rev-parse", "HEAD"]));
  assert.equal(git(dest, ["rev-list", "--count", "HEAD"]), "1", "never an unborn HEAD");
  assert.match(git(dest, ["log", "--oneline", "--name-only", "HEAD"]), /README\.md/, "the one commit carries the README");
  assert.equal(git(dest, ["status", "--porcelain"]), "", "nothing left staged or dirty");
  assert.equal(git(dest, ["rev-parse", "--short", "HEAD"]), made.json?.sha, "the answer names the commit it made");

  // The board: the project is there without a reload, and its own checkout is a row on `main`.
  const state = await waitForState(panel.base, (s) => (s.projects || []).some((p) => p.name === "fresh-idea"), "fresh-idea on the board");
  const project = (state.projects || []).find((p) => p.name === "fresh-idea");
  assert.ok(project, "the new project is on the board");
  const row = await waitForRow(panel.base, "fresh-idea", dest, {
    predicate: (r) => r.branch === "main",
    what: "the project's own checkout scanned on main",
  });
  assert.equal(row.branch, "main");

  // A second press on the same name is the 409 the page prints, not a second project.
  const again = await post(panel.base, "/api/project/new", { body: { root: scanRoot, name: "fresh-idea" } });
  assert.equal(again.status, 409, again.text.slice(0, 200));
  assert.match(again.json?.error || "", /already exists/);
});
