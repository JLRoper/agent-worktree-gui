// THE VERSION LINE IS NOT A FILE FIGHT. Every landing here claims the next patch above main, so three live trees can
// hold 1.155.5, 1.155.6 and 1.156.0 at once and every pair of them "shares" package.json. That overlap is settled at
// LAND time (rebase onto the current origin/main, keep the higher version), so it is a LAND ORDER: named, counted as
// answered, and never a reader question. This file is the proof, over the shapes the board actually showed:
//
//   1. package.json ALONE, differing in nothing but the version: no reader record, no notice in either queue, one
//      record holding a land order with both numbers.
//   2. package.json AND a source file both edited: still a reader record, and its title names the source file.
//   3. a land order WITHDRAWN when the overlap stops being a version line: the pair goes straight back to the reader.
//   4. a pair standing on a tree git no longer registers: ABSENT, not a question - the leftover directory a dead run's
//      child holds. Beside it, two registered trees stay the reader's.
//   5. the probe and the registration read themselves, against a real repository.
//
// The four cases PR 845 fixed (a rename re-keying a pair, a shared directory expanding to its files, one live pair one
// record, and the badge outliving its trees) live in test/collision-count.test.js and are not repeated here: this file
// is additive, and `a gone pair must still leave the count` is asserted there.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CollisionBook,
  classifyVersionOnly,
  compareVersionText,
  isVersionCarrier,
  stateOf,
  textWithoutVersion,
  versionInText,
} from "../lib/collisions.js";
import { sweepCollisions } from "../lib/collision-flow.js";
import { probeVersionOnly, registeredWorktrees } from "../lib/collision-merge.js";

await import("../public/core/review-lane.js");
const lane = globalThis.wtReviewLane;

const PROJECT = "agent-worktree-gui";
// Built from parts so the address never has to be typed into a file: git only needs a syntactically valid one.
const EMAIL = ["panel", "example.test"].join("@");
const roots = [];
const tempRoot = (name) => {
  const root = mkdtempSync(path.join(os.tmpdir(), `wag-version-${name}-`));
  roots.push(root);
  return root;
};
test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const manifestOf = (version, extra = {}) => ({ name: PROJECT, version, private: true, ...extra });
function writeManifest(dir, version, extra = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(manifestOf(version, extra), null, 2)}\n`);
}
// A tree on a REAL disk: the probe reads the manifest out of the tree, so the fixture is a directory with the files in
// it, not a path in a sentence.
function cutTree(root, name, { version = "1.155.6", shared = null, extra = {} } = {}) {
  const dir = path.join(root, name);
  mkdirSync(path.join(dir, "lib"), { recursive: true });
  writeManifest(dir, version, extra);
  if (shared !== null) writeFileSync(path.join(dir, "lib", "shared.js"), shared);
  return dir.replace(/\\/g, "/");
}
const rowOf = (dir, dirtyFiles, over = {}) => ({
  project: PROJECT,
  path: dir,
  name: path.basename(dir),
  branch: `wtgui/${path.basename(dir)}`,
  parent: "main",
  live: true,
  dirtyFiles,
  untrackedFiles: [],
  commitFiles: [],
  head: "",
  ...over,
});
const owners = (rows) => {
  const map = new Map(rows.map((row, index) => [row.path, `assistant-${index + 1}`]));
  return { ownerOf: (side) => map.get(side.path) || null, tasksFor: () => [], fileQueue: () => ({ taskId: null }) };
};
const manifestOnly = [{ code: "M", path: "package.json" }];

// ---- 1. THE VERSION LINE ALONE ------------------------------------------------------------------------------------
test("package.json alone: a land order, not a reader record", () => {
  const root = tempRoot("only");
  const low = cutTree(root, "version-low", { version: "1.155.5" });
  const high = cutTree(root, "version-high", { version: "1.156.0" });
  const rows = [rowOf(low, manifestOnly), rowOf(high, manifestOnly)];
  const book = new CollisionBook({});
  const deps = { ...owners(rows), probeVersionOnly: (pair) => probeVersionOnly(pair) };
  const at = Date.parse("2026-11-22T10:00:00.000Z");

  const first = sweepCollisions({ rows, book, now: at, ...deps });
  assert.equal(first.landOrder.length, 1, "the pair is named as a land order on the sweep that first reads it");
  assert.deepEqual(first.filed, [], "a land order files no notice into either queue");
  assert.deepEqual(first.escalated, [], "and it asks nobody");
  assert.equal(book.all().length, 1, "the pair is still one record");

  const rec = book.all()[0];
  assert.equal(stateOf(rec), "ruled", "answered, not waiting");
  assert.equal(rec.ruling?.auto, true, "the panel's answer, not the reader's");
  assert.equal(rec.ruling?.basis, "version", "and it says what the answer was based on");
  assert.deepEqual(rec.files, ["package.json"], "the shared path it names is the manifest");
  assert.equal(book.state().count, 0, "the Human button does not count it: there is no reader record");

  // The order is the LOWER version first, because the higher number is the one that rebases on top of it.
  const order = rec.landOrder;
  const firstSide = rec[order.pick];
  const secondSide = rec[order.pick === "a" ? "b" : "a"];
  assert.equal(firstSide.name, "version-low", "the lower version goes first");
  assert.equal(order.versions[order.pick], "1.155.5");
  assert.equal(order.versions[order.pick === "a" ? "b" : "a"], "1.156.0");

  // What the reader sees on the row: a land order, both numbers, and no press implied.
  const title = lane.collisionTitle(book.forTree(firstSide.path)[0]);
  assert.match(title, /^land order with /, "the marker says land order, not collision");
  assert.match(title, /1\.155\.5/);
  assert.match(title, /1\.156\.0/);
  assert.match(title, /not a file fight/);
  assert.doesNotMatch(title, /yours to rule/, "it does not ask the reader for anything");

  // A second sweep keeps the same order and announces nothing twice.
  const second = sweepCollisions({ rows, book, now: at + 10_000, ...deps });
  assert.deepEqual(second.landOrder, [], "an order already named is not announced again");
  assert.deepEqual(second.escalated, []);
  assert.equal(book.state().count, 0, "and it is still not the reader's, however many sweeps run");
  assert.equal(book.all().length, 1);
});

test("a land order survives a restart", () => {
  const root = tempRoot("reload");
  const low = cutTree(root, "reload-low", { version: "1.155.5" });
  const high = cutTree(root, "reload-high", { version: "1.156.0" });
  const rows = [rowOf(low, manifestOnly), rowOf(high, manifestOnly)];
  const file = path.join(root, "collisions.json");
  const deps = { ...owners(rows), probeVersionOnly: (pair) => probeVersionOnly(pair) };
  const book = new CollisionBook({ file });
  sweepCollisions({ rows, book, now: Date.parse("2026-11-22T10:00:00.000Z"), ...deps });
  book.save();
  const key = book.all()[0].key;

  const reopened = new CollisionBook({ file });
  const rec = reopened.get(key);
  assert.ok(rec, "the record is still there");
  assert.equal(stateOf(rec), "ruled");
  assert.equal(rec.ruling?.basis, "version");
  assert.equal(rec.landOrder?.files?.[0], "package.json");
  assert.equal(reopened.state().count, 0, "a restart does not put the pair back in front of the reader");
  // The next sweep over the same trees re-reads them and keeps the same answer.
  const swept = sweepCollisions({ rows, book: reopened, now: Date.parse("2026-11-22T10:01:00.000Z"), ...deps });
  assert.equal(swept.landOrderWithdrawn.length, 0);
  assert.equal(reopened.state().count, 0);
});

// ---- 2. THE MIXED PAIR: A VERSION LINE AND A SOURCE FILE ----------------------------------------------------------
test("package.json AND a source file: still a reader record, naming the source file", () => {
  const root = tempRoot("mixed");
  const one = cutTree(root, "mixed-one", { version: "1.155.5", shared: "export const shared = 1;\n" });
  const two = cutTree(root, "mixed-two", { version: "1.156.0", shared: "export const shared = 2;\n" });
  const dirty = [{ code: "M", path: "package.json" }, { code: "M", path: "lib/shared.js" }];
  const rows = [rowOf(one, dirty), rowOf(two, dirty)];
  const book = new CollisionBook({});
  const deps = { ...owners(rows), probeVersionOnly: (pair) => probeVersionOnly(pair) };
  const at = Date.parse("2026-11-22T10:10:00.000Z");

  // The probe agrees: a shared source file is not a version line.
  const read = probeVersionOnly({ files: ["lib/shared.js", "package.json"], a: rows[0], b: rows[1] });
  assert.equal(read.ok, true);
  assert.equal(read.versionOnly, false, "a source file both sides edited is never a version-only overlap");
  assert.match(String(read.why), /lib\/shared\.js is not a manifest version field/);

  const first = sweepCollisions({ rows, book, now: at, ...deps });
  assert.deepEqual(first.landOrder, [], "no land order for a pair that shares a source file");
  sweepCollisions({ rows, book, now: at + 4000, ...deps });

  const rec = book.all()[0];
  assert.equal(stateOf(rec), "reader", "the pair reaches the reader, exactly as it did before the classification");
  assert.deepEqual([...rec.files].sort(), ["lib/shared.js", "package.json"]);
  assert.equal(book.state().count, 1, "one live pair is one record in the count");
  const title = lane.collisionTitle(book.forTree(one)[0]);
  assert.match(title, /^collision with /, "it is a collision, not a land order");
  assert.match(title, /lib\/shared\.js/, "and it names the source file");
  assert.doesNotMatch(title, /land order/);
});

// ---- 3. A LAND ORDER THAT STOPS BEING ONE -------------------------------------------------------------------------
test("a land order is withdrawn when the overlap stops being a version line", () => {
  const root = tempRoot("withdraw");
  const one = cutTree(root, "withdraw-one", { version: "1.155.5", shared: "export const shared = 1;\n" });
  const two = cutTree(root, "withdraw-two", { version: "1.156.0", shared: "export const shared = 1;\n" });
  const rows = [rowOf(one, manifestOnly), rowOf(two, manifestOnly)];
  const book = new CollisionBook({});
  const deps = { ...owners(rows), probeVersionOnly: (pair) => probeVersionOnly(pair) };
  const at = Date.parse("2026-11-22T10:20:00.000Z");

  sweepCollisions({ rows, book, now: at, ...deps });
  const rec = book.all()[0];
  assert.equal(stateOf(rec), "ruled", "version-only first: a land order");
  assert.equal(book.state().count, 0);

  // Both sides now edit the same source file, under the same tips: the reading is taken again and the order stops.
  writeFileSync(path.join(one, "lib", "shared.js"), "export const shared = 2;\n");
  writeFileSync(path.join(two, "lib", "shared.js"), "export const shared = 3;\n");
  const grown = [rowOf(one, [{ code: "M", path: "package.json" }, { code: "M", path: "lib/shared.js" }]), rowOf(two, [{ code: "M", path: "package.json" }, { code: "M", path: "lib/shared.js" }])];
  const swept = sweepCollisions({ rows: grown, book, now: at + 10_000, ...deps });

  assert.equal(swept.landOrderWithdrawn.length, 1, "the order is withdrawn on the sweep that sees the new file");
  assert.equal(rec.landOrder, null, "the card stops naming a version order nobody stands behind");
  assert.equal(rec.ruling, null, "and the answer is gone with it");
  assert.equal(stateOf(rec), "reader", "so the pair reaches the reader, which is what a shared source file earns");
  assert.equal(book.state().count, 1);
});

// ---- 4. A LEFTOVER DIRECTORY: ABSENT, NOT ASKED -------------------------------------------------------------------
const strandedRows = () => {
  const rows = [
    rowOf("/repos/agent-worktree-gui/.worktrees/research-round-b-for-the-initiatives-tab-1d1d2c", [{ code: "M", path: "docs/reports/initiatives-redesign-research-b-2026-11-22.html" }]),
    rowOf("/repos/agent-worktree-gui/.worktrees/landed-round-b-ac77d9", [{ code: "M", path: "docs/reports/initiatives-redesign-research-b-2026-11-22.html" }]),
  ];
  return rows;
};

test("a pair whose tree git no longer registers is absent, not a question", () => {
  const rows = strandedRows();
  const book = new CollisionBook({});
  const deps = owners(rows);
  const at = Date.parse("2026-11-22T10:30:00.000Z");
  sweepCollisions({ rows, book, now: at, ...deps });
  sweepCollisions({ rows, book, now: at + 4000, ...deps });
  const rec = book.all()[0];
  assert.equal(stateOf(rec), "reader", "the pair is the reader's while both trees are registered");
  assert.equal(book.state().count, 1);

  const leftover = rec.a.name.includes("1d1d2c") ? rec.a : rec.b;
  const swept = sweepCollisions({
    rows,
    book,
    now: at + 10_000,
    ...deps,
    // The folder is still on disk - a dead run's child held it, so `git worktree remove` refused - but git no longer
    // lists it. The disk check cannot see that; the registration can.
    treeExists: () => true,
    treeRegistered: (treePath) => treePath !== leftover.path,
  });
  assert.equal(swept.gone.length, 1);
  assert.equal(swept.gone[0].how, "tree-unregistered");
  assert.equal(stateOf(rec), "absent");
  assert.equal(rec.absent?.how, "tree-unregistered");
  assert.match(String(rec.absent?.why), /not a registered worktree/);
  assert.equal(book.state().count, 0, "the count drops: a leftover directory is not a second worker");
  const title = lane.collisionTitle(book.forTree(leftover.path)[0]);
  assert.match(title, /no longer a registered worktree/);
  assert.doesNotMatch(title, /yours to rule/);
});

test("both trees registered and on disk: the pair stays the reader's", () => {
  const rows = strandedRows();
  const book = new CollisionBook({});
  const deps = owners(rows);
  const at = Date.parse("2026-11-22T10:40:00.000Z");
  sweepCollisions({ rows, book, now: at, ...deps });
  sweepCollisions({ rows, book, now: at + 4000, ...deps });
  const swept = sweepCollisions({ rows, book, now: at + 10_000, ...deps, treeExists: () => true, treeRegistered: () => true });
  assert.deepEqual(swept.gone, [], "nothing is closed while git still registers both trees");
  assert.equal(book.state().count, 1);
});

// ---- 5. THE PURE READING, AND THE TWO READS BEHIND IT -------------------------------------------------------------
test("the classifier answers about manifests only, and only about the version line", () => {
  const same = JSON.stringify({ name: PROJECT, version: "1.155.6", dependencies: { express: "4.18.2" } }, null, 2);
  const bumped = same.replace("1.155.6", "1.156.0");
  const dependency = same.replace("4.18.2", "4.19.0");
  const kind = (files, contents) => classifyVersionOnly({ files, contents });

  const only = kind(["package.json"], { "package.json": { a: same, b: bumped } });
  assert.equal(only.versionOnly, true);
  assert.deepEqual(only.versions, { a: "1.155.6", b: "1.156.0" });
  assert.equal(only.pick, "a", "the lower version goes first");

  assert.equal(kind(["package.json"], { "package.json": { a: same, b: dependency } }).versionOnly, false, "a dependency change is a real overlap");
  assert.equal(kind(["lib/shared.js"], { "lib/shared.js": { a: "x", b: "y" } }).versionOnly, false, "a source file is not a manifest");
  assert.equal(kind(["package.json", "lib/shared.js"], { "package.json": { a: same, b: bumped }, "lib/shared.js": { a: "x", b: "y" } }).versionOnly, false);
  assert.equal(kind(["package.json"], { "package.json": { a: same, b: same } }).versionOnly, false, "the same number is no order at all");
  assert.equal(kind(["package.json"], { "package.json": { a: same, b: null } }).ok, false, "an unreadable copy is not an answer");

  // A version file and a POM are carriers too, and their own version line is the one that moves.
  assert.equal(isVersionCarrier("version.txt"), true);
  assert.equal(isVersionCarrier("pom.xml"), true);
  assert.equal(isVersionCarrier("lib/version.js"), true);
  assert.equal(isVersionCarrier("docs/version.md"), false);
  assert.equal(versionInText("pom.xml", "<version>1.2.3</version>"), "1.2.3");
  assert.equal(textWithoutVersion("pom.xml", "<version>1.2.3</version>"), "<version>__VERSION__</version>");
  assert.equal(compareVersionText("1.155.9", "1.156.0"), -1, "a version is compared by segment, not as a string");
  assert.equal(compareVersionText("1.156.0", "1.155.6"), 1);
  assert.equal(compareVersionText("1.156.0", "1.156.0"), 0);
});

test("the probe reads the working copy first, and the tip when the file is not on disk", () => {
  const root = tempRoot("probe");
  const repo = path.join(root, "repo").replace(/\\/g, "/");
  const run = (args) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
    }).trim();

  // The working copy answers when it is there: two trees with different bumps are a version-only overlap.
  const one = cutTree(root, "probe-one", { version: "1.155.5" });
  const two = cutTree(root, "probe-two", { version: "1.156.0" });
  const onDisk = probeVersionOnly({ files: ["package.json"], a: rowOf(one, manifestOnly), b: rowOf(two, manifestOnly) });
  assert.equal(onDisk.ok, true);
  assert.equal(onDisk.versionOnly, true);

  // The tip answers when it is not: one checkout, two commits, and no package.json in the working tree at all.
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: ["ignore", "pipe", "pipe"] });
  run(["config", "user.email", EMAIL]);
  run(["config", "user.name", "panel"]);
  writeManifest(repo, "1.155.5");
  run(["add", "."]);
  run(["commit", "-qm", "1.155.5"]);
  const left = run(["rev-parse", "HEAD"]);
  writeManifest(repo, "1.156.0");
  run(["add", "."]);
  run(["commit", "-qm", "1.156.0"]);
  const right = run(["rev-parse", "HEAD"]);
  rmSync(path.join(repo, "package.json"));

  const fromTips = probeVersionOnly({
    files: ["package.json"],
    a: { path: repo, name: "one-fifty-five", head: left },
    b: { path: repo, name: "one-fifty-six", head: right },
  });
  assert.equal(fromTips.ok, true, "a file that is not on disk is read from the tip it was committed at");
  assert.equal(fromTips.versionOnly, true);
  assert.deepEqual(fromTips.versions, { a: "1.155.5", b: "1.156.0" });

  // And the registration: the two worktrees git lists, and not the folder that merely exists.
  const second = path.join(root, "second").replace(/\\/g, "/");
  run(["worktree", "add", "-q", second, "-b", "second"]);
  mkdirSync(path.join(root, "leftover"), { recursive: true });
  const listed = registeredWorktrees(repo);
  assert.equal(listed.ok, true);
  assert.equal(listed.paths.includes(repo.toLowerCase()), true, "the checkout itself is registered");
  assert.equal(listed.paths.includes(second.toLowerCase()), true, "and the tree cut from it");
  assert.equal(listed.paths.includes(path.join(root, "leftover").replace(/\\/g, "/").toLowerCase()), false, "a bare folder is not");
});
