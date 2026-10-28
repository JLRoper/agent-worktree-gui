// The directories the panel keeps its state in, proved against a real `node server.js` boot.
//
// test/paths.test.js holds the resolution rules; this file holds what only a booted server can show: that a second
// instance (PANEL_CONFIG) never resolves to the reader's board, that the first boot with a data directory copies an
// existing install's logs/ and journals it while a restart does not copy again, and that /api/scratch/clean refuses
// the folders it must refuse and cleans the one it may. Every panel here is a sandbox with its own port, config and
// HERMES_HOME (tools/panel-testkit.mjs); :7331 and the real ~/.wag are never touched.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { post, startPanel } from "../tools/panel-testkit.mjs";

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const getState = async (panel) => (await fetch(`${panel.base}/api/state`)).json();

// A size is measured in the background, so the first /api/state can say `measuring`; poll until the walk has landed.
async function stateWhen(panel, ok, ms = 10_000) {
  const until = Date.now() + ms;
  let last;
  for (;;) {
    last = await getState(panel);
    if (ok(last)) return last;
    if (Date.now() > until) throw new Error(`state never satisfied the check; last paths = ${JSON.stringify(last.paths)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const seededJob = (id, cwd) => ({
  id,
  thread: `wtgui-fixture-${id}`,
  turn: 1,
  prompt: `seeded run ${id}`,
  displayPrompt: `seeded run ${id}`,
  cwd,
  worktree: false,
  projectPath: cwd,
  ownerPath: cwd,
  runId: `seed-${id}`,
  status: "done",
  exitCode: 0,
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:01:00.000Z",
  model: "sandbox/stub",
  lines: [{ kind: "dim", text: "seeded for the data-directory check" }],
  artifacts: [],
  attachments: [],
});

test("a PANEL_CONFIG instance keeps its own folder: WAG_HOME and WAG_SCRATCH are not consulted, and nothing is made there", async (t) => {
  const decoy = mkdtempSync(path.join(os.tmpdir(), "wtgui-decoy-"));
  const decoyHome = path.join(decoy, "readers-board");
  const decoyScratch = path.join(decoy, "readers-scratch");
  // The environment says "use the reader's board"; the sandbox must not listen. This is exactly the situation of every
  // verify tool and every startPanel() test run from a shell that has WAG_HOME set.
  const panel = await startPanel({ env: { WAG_HOME: decoyHome, WAG_SCRATCH: decoyScratch } });
  t.after(async () => {
    await panel.stop();
    rmSync(decoy, { recursive: true, force: true });
  });
  const { paths } = await getState(panel);
  assert.equal(paths.dataDir, path.join(panel.dir, "logs"), "the sandbox's own folder, where it has always kept its files");
  assert.equal(paths.dataSource, "PANEL_CONFIG");
  assert.equal(paths.dataLayout, "flat");
  assert.equal(paths.stateDir, path.join(panel.dir, "logs"), "no state/ folder inside a second instance's folder");
  assert.equal(paths.scratchDir, path.join(panel.dir, "logs", "scratch"));
  assert.equal(paths.scratchMarked, true, "and the folder it made carries the marker Clean scratch looks for");
  assert.equal(existsSync(decoyHome), false, "the environment's data directory was never created");
  assert.equal(existsSync(decoyScratch), false, "nor its scratch directory");
  assert.equal(paths.migrated, null, "a second instance has nothing to migrate");
  assert.match(panel.log(), /data directory: .*logs \(PANEL_CONFIG\)/, "the boot log says which rule answered");
});

test("naming dataDir opts a second instance into the split layout; the first boot copies and journals, a restart does not copy again", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-migrate-"));
  const legacy = path.join(dir, "logs"); // where this config's instance has always kept its files
  const dataDir = path.join(dir, "data");
  mkdirSync(path.join(legacy, "attachments"), { recursive: true });
  mkdirSync(path.join(legacy, "assistant-cwd"), { recursive: true });
  const store = { version: 1, savedAt: "2026-01-01T00:00:00.000Z", jobs: [seededJob("seed0001", dir), seededJob("seed0002", dir)] };
  writeFileSync(path.join(legacy, "jobs.json"), `${JSON.stringify(store)}\n`);
  writeFileSync(path.join(legacy, "todos.json"), "{}\n");
  writeFileSync(path.join(legacy, "attachments", "shot.png"), "PNG");
  writeFileSync(path.join(legacy, "assistant-cwd", "AGENTS.md"), "notes");
  const originals = { jobs: sha(path.join(legacy, "jobs.json")), todos: sha(path.join(legacy, "todos.json")) };
  // The kit names jobsFile / assistantFile / projectsCacheFile for a sandbox; an `undefined` here drops the key from the
  // JSON, so the data directory is what answers.
  const config = { dataDir, jobsFile: undefined, assistantFile: undefined, projectsCacheFile: undefined };
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = await startPanel({ dir, config, keep: true });
  let second = null;
  t.after(async () => {
    await first.stop();
    if (second) await second.stop();
  });
  const s1 = await stateWhen(first, (s) => s.paths?.dataMeasuredAt);
  assert.equal(s1.paths.dataLayout, "split");
  assert.equal(s1.paths.dataSource, "config");
  assert.equal(s1.paths.stateDir, path.join(dataDir, "state"));
  assert.equal(s1.paths.migrated?.thisBoot, true, "the page can say the copy happened on this boot");
  assert.equal(s1.paths.migrated.from, legacy);
  assert.ok(s1.paths.migrated.files >= 4, `copied ${s1.paths.migrated.files} entries`);
  // The board really loaded the migrated store: both seeded cards are on it.
  const ids1 = s1.jobs.map((j) => j.id);
  assert.ok(ids1.includes("seed0001") && ids1.includes("seed0002"), `jobs on the board: ${ids1.join(",")}`);
  // Copied, with the files that must travel with the store.
  assert.ok(existsSync(path.join(dataDir, "state", "jobs.json")));
  assert.equal(readFileSync(path.join(dataDir, "state", "todos.json"), "utf8"), "{}\n");
  assert.equal(readFileSync(path.join(dataDir, "attachments", "shot.png"), "utf8"), "PNG", "pasted files follow the store whose prompts name them");
  assert.equal(readFileSync(path.join(dataDir, "state", "assistant-cwd", "AGENTS.md"), "utf8"), "notes");
  // Journaled durably, and said in the boot log.
  const journal = JSON.parse(readFileSync(path.join(dataDir, "state", "migrations.json"), "utf8"));
  assert.equal(journal.entries.length, 1);
  assert.match(first.log(), /state-migrated: copied \d+ file\(s\) from .*logs to .*state/);
  // Never moved, never deleted: the originals are byte-for-byte what they were.
  assert.equal(sha(path.join(legacy, "jobs.json")), originals.jobs);
  assert.equal(sha(path.join(legacy, "todos.json")), originals.todos);
  assert.ok(existsSync(path.join(legacy, "attachments", "shot.png")));
  await first.stop();

  // A restart on the same folders. The old checkout's file has since changed; the data directory already holds a store,
  // so the migration must not run again and must not put the old file back over a store the panel has been writing.
  writeFileSync(path.join(legacy, "jobs.json"), `${JSON.stringify({ version: 1, savedAt: "2026-02-02T00:00:00.000Z", jobs: [] })}\n`);
  second = await startPanel({ dir, config, keep: true });
  const s2 = await stateWhen(second, (s) => s.paths?.dataMeasuredAt);
  assert.equal(s2.paths.migrated?.thisBoot, false, "the journal still answers where the board came from, but nothing was copied this time");
  assert.equal(s2.paths.migrated.files, s1.paths.migrated.files);
  const ids2 = s2.jobs.map((j) => j.id);
  assert.ok(ids2.includes("seed0001") && ids2.includes("seed0002"), "the store in the data directory is still the one the board reads");
  assert.equal(JSON.parse(readFileSync(path.join(dataDir, "state", "migrations.json"), "utf8")).entries.length, 1, "a boot that copied nothing writes no second entry");
  assert.doesNotMatch(second.log(), /state-migrated: copied/);
});

test("Clean scratch over HTTP: it empties the folder the panel made, and refuses everything else with the reason", async (t) => {
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), "wtgui-fakehome-"));
  const panel = await startPanel();
  t.after(async () => {
    await panel.stop();
    rmSync(fakeHome, { recursive: true, force: true });
  });
  const scratch = path.join(panel.dir, "logs", "scratch");

  // 1. the folder the panel made, holding a throwaway export: cleaned, and the numbers come back.
  mkdirSync(path.join(scratch, "job-x"), { recursive: true });
  writeFileSync(path.join(scratch, "job-x", "compare.diff"), "x".repeat(1024));
  const ok = await post(panel.base, "/api/scratch/clean");
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.freedBytes, 1024);
  assert.equal(ok.json.removedFiles, 1);
  assert.equal(ok.json.freed, "1 KB");
  assert.equal(ok.json.paths.scratchFiles, 0, "the answer carries the new size");
  assert.ok(existsSync(path.join(scratch, ".wag-scratch")), "the marker is not part of what was cleaned");
  assert.equal(existsSync(path.join(scratch, "job-x")), false);

  // 2. the same folder with the marker gone is a folder the panel can no longer vouch for: refused, nothing deleted.
  mkdirSync(path.join(scratch, "job-y"), { recursive: true });
  writeFileSync(path.join(scratch, "job-y", "keep.txt"), "mine");
  rmSync(path.join(scratch, ".wag-scratch"));
  const unmarked = await post(panel.base, "/api/scratch/clean");
  assert.equal(unmarked.status, 409, unmarked.text);
  assert.match(unmarked.json.error, /was not made by the panel/);
  assert.equal(readFileSync(path.join(scratch, "job-y", "keep.txt"), "utf8"), "mine");
  assert.equal((await getState(panel)).paths.scratchMarked, false, "and the Settings row can say so before anyone presses the button");

  // 3. a scratchDir that is the home folder is refused outright. The panel sees a FAKE home (USERPROFILE / HOME), so a
  // regression in this guard deletes a temp folder and not the person running the tests.
  writeFileSync(path.join(fakeHome, "important.txt"), "do not delete");
  const homey = await startPanel({ config: { scratchDir: fakeHome }, env: { USERPROFILE: fakeHome, HOME: fakeHome } });
  t.after(() => homey.stop());
  const refused = await post(homey.base, "/api/scratch/clean");
  assert.equal(refused.status, 409, refused.text);
  assert.match(refused.json.error, /home folder/);
  assert.equal(readFileSync(path.join(fakeHome, "important.txt"), "utf8"), "do not delete");

  // 4. unknown folder names in the open route are a 400, not a shell.
  const bad = await post(panel.base, "/api/paths/open", { body: { which: "../../etc" } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /unknown folder/);
});
