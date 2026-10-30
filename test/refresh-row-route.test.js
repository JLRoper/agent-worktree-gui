// The row's ⟳ over HTTP, against the real server on its own port.
//
//   POST /api/refresh/row {project, path, reconcile: true}
//
// The decision logic is proved in test/refresh-row.test.js without a panel, a repo or a browser. This file is about the
// WIRING the page actually talks to, and the two depths of the one route main already had:
//
//   - without `reconcile`, the next-read ring's cheap read: a row and nothing else. The ring's contract must not move.
//   - with `reconcile`, the same read plus the TODO reconcile, the description verdict and the journal.
//
// The load-bearing claim is that a reconcile PROPOSES and does not close: the item it names is still `todo` afterwards,
// and the proposal sits beside the list for the reader to accept. A refresh that quietly marked work done would be the
// one failure this feature cannot afford.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { post, startPanel } from "../tools/panel-testkit.mjs";

const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
const slash = (p) => String(p || "").replace(/\\/g, "/");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The row only exists once the panel has scanned the project, and a scan is asynchronous: poll rather than guess.
// It returns the row as the SNAPSHOT spells it — the page posts `row.path` back, and the route matches that string
// exactly, so the store's own spelling (forward slashes, even on Windows) is the one to ask with.
async function rowAppears(base, name, treePath, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const state = await (await fetch(`${base}/api/state`)).json().catch(() => ({}));
    const proj = (state.projects || []).find((p) => p.name === name);
    const row = (proj?.worktrees || []).find((w) => slash(w.path) === slash(treePath));
    if (row) return row;
    await sleep(250);
  }
  return null;
}

test("the reconcile depth proposes and journals; the cheap read is still a row and nothing else", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wtgui-refreshrow-"));
  const repo = path.join(root, "proj");
  await mkdir(repo, { recursive: true });
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "refresh@local"]);
  git(repo, ["config", "user.name", "Refresh"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repo, "README.md"), "# test\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "init"]);

  // A tree whose branch has real work off main, in the file the TODO item names.
  const worked = path.join(repo, ".worktrees", "wt-worked");
  git(repo, ["worktree", "add", "-b", "feat/worked", worked]);
  await writeFile(path.join(worked, "work.txt"), "a change\n", "utf8");
  git(worked, ["add", "."]);
  git(worked, ["commit", "-m", "add work"]);

  const panel = await startPanel({ config: { scanRoots: [root] } });
  t.after(async () => {
    await panel.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const reload = await post(panel.base, "/api/reload", { body: {} });
  assert.equal(reload.status, 200, `reload must succeed: ${reload.text.slice(0, 200)}`);
  const row0 = await rowAppears(panel.base, "proj", worked);
  assert.ok(row0, "the panel scanned the worktree into its rows");
  const rowPath = row0.path;

  // An open item that names the file the branch's commit touched: the evidence a reconcile has and a scan does not.
  const added = await post(panel.base, "/api/todos", {
    body: { op: "add", project: "proj", path: rowPath, text: "ship the work file", files: ["work.txt"] },
  });
  assert.equal(added.status, 200, `seeding the list must succeed: ${added.text.slice(0, 200)}`);
  const itemId = added.json?.key ? (await (await fetch(`${panel.base}/api/todos?project=proj&path=${encodeURIComponent(rowPath)}`)).json())?.list?.items?.[0]?.id : null;
  assert.ok(itemId, "the item is on the list");

  // (1) The cheap read — the ring's own request. A row, and nothing about TODOs or descriptions.
  const cheap = await post(panel.base, "/api/refresh/row", { body: { project: "proj", path: rowPath } });
  assert.equal(cheap.status, 200, `the cheap read must answer 200: ${cheap.text.slice(0, 300)}`);
  assert.ok(cheap.json?.row, "the cheap read returns the row");
  assert.equal(cheap.json.journal, undefined, "the cheap read writes no journal — it is a read");
  assert.equal(cheap.json.todo, undefined, "the cheap read reconciles no list");

  // (2) The same route, one depth deeper: the ⟳.
  const rec = await post(panel.base, "/api/refresh/row", {
    body: { project: "proj", path: rowPath, reconcile: true, refreshAgent: "off" },
  });
  assert.equal(rec.status, 200, `the reconcile must answer 200: ${rec.text.slice(0, 400)}`);
  const lines = rec.json?.journal;
  assert.ok(Array.isArray(lines) && lines.length, "the reconcile journalled at least one line");
  assert.ok(
    lines.some((l) => /^(re-read, nothing moved|verdict |\d+ -> \d+ ahead)/.test(l)),
    `the merge-state line is there: ${lines.join(" | ")}`,
  );
  assert.ok(lines.some((l) => l.startsWith("TODO ")), `the TODO line is there: ${lines.join(" | ")}`);
  assert.ok(lines.some((l) => l.startsWith("description ")), `the description line is there: ${lines.join(" | ")}`);
  assert.ok(lines.some((l) => l.startsWith("agent pass off")), "an agent pass set to off says so and does nothing else");
  assert.equal(rec.json.agent?.started, null, "off starts no run");
  assert.equal(rec.json.agent?.offered, false, "off offers no card");

  // The proposal names the item, and it is a proposal: the item is still open.
  const proposals = rec.json?.todo?.proposals || [];
  assert.ok(proposals.some((p) => Number(p.id) === Number(itemId)), `the item looks closed: ${JSON.stringify(proposals)}`);
  const after = await (await fetch(`${panel.base}/api/todos?project=proj&path=${encodeURIComponent(worked)}`)).json();
  const item = (after.list?.items || []).find((i) => Number(i.id) === Number(itemId));
  assert.equal(item?.status, "todo", "the reconcile closed nothing — the proposal waits for the reader");
  assert.ok((after.list?.proposal || []).some((p) => Number(p.id) === Number(itemId)), "the proposal rides on the list");
  // The list's own journal records it, in the wording the reader sees, with nothing marked done in the sentence.
  assert.ok(
    (after.list?.journal || []).some((j) => j?.op === "reconcile" && /nothing marked done/.test(String(j.text || ""))),
    `the list's own journal records the reconcile: ${JSON.stringify((after.list?.journal || []).slice(-2))}`,
  );

  // The journal survives with the row, so a reload comes back to the same record.
  const row = rec.json?.row || {};
  assert.ok(Array.isArray(row.refreshJournal) && row.refreshJournal.length, "the row carries its last few lines");
  const state = await (await fetch(`${panel.base}/api/state`)).json();
  const proj = (state.projects || []).find((p) => p.name === "proj");
  const live = (proj?.worktrees || []).find((w) => slash(w.path) === slash(worked));
  assert.ok(Array.isArray(live?.refreshJournal) && live.refreshJournal.length, "the snapshot carries them too");

  // (3) A row that is not there is a sentence, not a stack trace.
  const stray = await post(panel.base, "/api/refresh/row", { body: { project: "proj", path: path.join(root, "nope"), reconcile: true } });
  assert.equal(stray.status, 404);
  assert.match(stray.json?.error || "", /unknown row/);
});
