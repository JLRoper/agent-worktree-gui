// The folders the board scans are a SETTING, and the board is one card per folder.
//
// What this pins, in the order the tab does it:
//   1. a root added through POST /api/settings/scan-roots is written to config.json, re-discovered without a restart,
//      and the repo under it arrives on the board carrying that root — so it is drawn under its own folder's card;
//   2. the same folder twice is refused with a sentence, not silently collapsed;
//   3. a FILE is refused by name (the sentence has to say which entry it is about — "invalid scan root" over a list
//      leaves the reader guessing);
//   4. an EMPTY list is legal and means the fallback: the folder the panel's own checkout sits in, which is what a
//      fresh clone scans. The answer names it, so the tab can explain a blank list instead of leaving the board
//      unexplained.
//
// The grouping itself is `rootOf()`, sliced out of public/app.js and run against the records the route really
// produced: a project carries the root discovery FOUND it under, and the path-derived answer is only the fallback for
// a record without the tag. That is the difference between the board filing a project under the folder it was found
// in and it guessing from a prefix.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { git, post, readSource, ROOT, startPanel } from "../tools/panel-testkit.mjs";

const ROUTE = "/api/settings/scan-roots";

// `rootOf()` out of public/app.js, with only the two names it reads from the module passed in: `normPath` (its own
// normaliser) and `state` (for the default `roots` argument). A slice rather than a copy, so the test cannot drift
// from the shipped function.
function rootOfFromSource() {
  const src = readSource("public/app.js").replace(/\r\n/g, "\n");
  const start = src.indexOf("function rootOf(");
  assert.ok(start >= 0, "public/app.js carries rootOf()");
  const end = src.indexOf("\n}\n", start);
  assert.ok(end > start, "rootOf() is a top-level function");
  const normPath = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const state = { scanRoots: [] };
  return new Function("normPath", "state", `${src.slice(start, end + 3)}\nreturn rootOf;`)(normPath, state);
}

function makeRepo(dir, name) {
  const repo = path.join(dir, name);
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), `# ${name}\n`, "utf8");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "first");
  return repo;
}

test("scan roots: a folder added from the settings is written, re-scanned, and drawn under its own card", async (t) => {
  const panel = await startPanel({});
  t.after(() => panel.stop());
  const base = panel.base;

  // The first root is the sandbox's own `repos` folder; the second is a folder the panel has never seen, so nothing
  // about it can be coming from the boot sweep.
  makeRepo(panel.repos, "alpha");
  const extra = path.join(panel.dir, "extra");
  mkdirSync(extra, { recursive: true });
  const beta = makeRepo(extra, "beta");

  const before = await fetch(`${base}/api/state`).then((r) => r.json());
  assert.ok(!before.projects.some((p) => p.name === "beta"), "beta is not on the board before the folder is named");

  const added = await post(base, ROUTE, { body: { roots: [panel.repos, extra] } });
  assert.equal(added.status, 200, `the write is accepted: ${added.text}`);
  assert.deepEqual(added.json.scanRootsConfigured, [panel.repos.replace(/\\/g, "/"), extra.replace(/\\/g, "/")]);
  assert.equal(added.json.scanRootsFallback, false, "a named list is not the fallback");
  assert.ok(
    added.json.scanRootsDetail.every((d) => d.exists === true),
    `every row says the folder is there: ${JSON.stringify(added.json.scanRootsDetail)}`,
  );

  // It is in the FILE, not only in the running process: a restart has to come back to the same list.
  const onDisk = JSON.parse(await readFile(panel.configPath, "utf8"));
  assert.deepEqual(onDisk.scanRoots.map((p) => p.replace(/\\/g, "/")), added.json.scanRootsConfigured);

  // The board: the project is there, tagged with the root it was found under, and rootOf() files it under THAT folder
  // — its own card — rather than under the panel's first root.
  const state = await fetch(`${base}/api/state`).then((r) => r.json());
  const project = state.projects.find((p) => p.name === "beta");
  assert.ok(project, "the repo under the new folder is on the board without a restart");
  assert.equal(project.path.replace(/\\/g, "/"), beta.replace(/\\/g, "/"));
  assert.equal(project.root.replace(/\\/g, "/"), extra.replace(/\\/g, "/"), "the project carries the root it was found under");
  assert.ok(state.scanRoots.map((p) => p.replace(/\\/g, "/")).includes(extra.replace(/\\/g, "/")), "the board knows the new root");

  const rootOf = rootOfFromSource();
  assert.equal(rootOf(project), extra.replace(/\\/g, "/"), "the project is filed under its own folder's card");
  assert.notEqual(rootOf(project), rootOf(state.projects.find((p) => p.name === "alpha")), "the two roots are two cards");

  // The tag wins over the path: a record whose path sits under root A but which discovery found under root B is filed
  // under B. This is the nested-root case a prefix match gets wrong.
  assert.equal(
    rootOf({ path: path.join(panel.repos, "alpha"), root: extra.replace(/\\/g, "/") }),
    extra.replace(/\\/g, "/"),
    "the recorded root beats a path prefix",
  );
  // ...and a record with no tag still answers from the path, so an older cache is not filed under "(unknown folder)".
  assert.equal(rootOf({ path: beta }), extra.replace(/\\/g, "/"), "an untagged record still groups by its own folder");

  // A duplicate is refused with a sentence that names it.
  const dup = await post(base, ROUTE, { body: { roots: [panel.repos, extra, extra.replace(/\//g, "\\")] } });
  assert.equal(dup.status, 400, `a duplicate is refused: ${dup.text}`);
  assert.match(dup.json.error, /already in the list/i);
  assert.ok(dup.json.error.includes("extra"), `the refusal names the folder: ${dup.json.error}`);

  // A file is refused BY NAME — the sentence has to be about that entry, not about the list.
  const file = path.join(panel.dir, "not-a-folder.txt");
  writeFileSync(file, "this is a file\n", "utf8");
  const bad = await post(base, ROUTE, { body: { roots: [panel.repos, file] } });
  assert.equal(bad.status, 400, `a file is refused: ${bad.text}`);
  assert.ok(bad.json.error.includes("not-a-folder.txt"), `the refusal names the file: ${bad.json.error}`);
  assert.match(bad.json.error, /not a folder/i);
  // ...and the refused write changed nothing: the list on disk is still the one that was accepted.
  assert.deepEqual(JSON.parse(await readFile(panel.configPath, "utf8")).scanRoots, added.json.scanRootsConfigured);

  // The empty list: legal, and it means the fallback folder — the panel's own parent — which the answer names.
  const empty = await post(base, ROUTE, { body: { roots: [] } });
  assert.equal(empty.status, 200, `an empty list is accepted: ${empty.text}`);
  assert.deepEqual(empty.json.scanRootsConfigured, [], "the file names no folder");
  assert.equal(empty.json.scanRootsFallback, true, "an empty list IS the fallback");
  assert.deepEqual(empty.json.scanRoots, [empty.json.scanRootsFallbackPath], "the effective list is the fallback folder");
  assert.equal(
    empty.json.scanRootsFallbackPath.replace(/\\/g, "/"),
    path.dirname(ROOT).replace(/\\/g, "/"),
    "the fallback is the folder the panel's own checkout sits in",
  );
  assert.deepEqual(JSON.parse(await readFile(panel.configPath, "utf8")).scanRoots, [], "the empty list is what the file says");
  // The board still answers, and it is scanning the fallback rather than nothing.
  const after = await fetch(`${base}/api/config`).then((r) => r.json());
  assert.deepEqual(after.scanRoots, [empty.json.scanRootsFallbackPath], "/api/config reports the fallback as the effective root");
  assert.equal(after.scanRootsFallback, true);
});
