// Which assistant owns a worktree — the detail's "Controlled by: Assistant #1 — Manager" bullet and the optional
// chart column, whose cell reads the assistant's NAME and whose tooltip carries its numbered role label.
//
// The owner is stored beside the lock (lib/locks.js `owners`) because it is the same kind of fact: the panel's own
// answer about a directory git knows nothing about. Three properties are asserted here, each driven through the real
// server rather than read off the source:
//
//   1. THE KEY IS THE TREE, NOT THE PATH OR THE BRANCH. The panel renames both after the thread's title, so a
//      path-keyed owner is orphaned by the panel's own rename. A rename through POST /api/worktree/rename must leave
//      the reader's owner on the row, with the store still keyed on the six-hex tag.
//   2. THE LABEL IS RESOLVED AT READ TIME. Two assistants on two roles read as two labels, and renaming a role changes
//      the row's text while locks.json stays byte-identical: the store holds an id, never a label.
//   3. ABSENCE IS ASSISTANT #1. A tree nobody moved carries no record (setting #1 CLEARS it), an unknown id is
//      refused out loud (404) instead of stored, and an owner whose assistant is gone falls back to #1 AND SAYS SO.
//
// The column's own default/visible behaviour is owned by test/chart-columns.test.js and tools/verify-chart-columns.mjs;
// this file owns the DATA those surfaces draw. The reader-only gate on the route is asserted here too, because that
// route is the one place an agent could try to reassign a tree.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ownerKey } from "../lib/locks.js";
import { configureRepo, git, post, slash, startPanel, waitForRow } from "../tools/panel-testkit.mjs";

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

// A project with one commit on main and N tagged worktrees under it. The tag is what a rename keeps, so every name
// here carries one — a tree without a tag is refused by the rename path (lib/tree-names.js `renameRefusal`).
async function makeBoard({ prefix = "wtgui-owner-", trees = ["tree-one-1a2b3c"] } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const repos = path.join(dir, "repos");
  const proj = path.join(repos, "proj");
  await mkdir(proj, { recursive: true });
  git(proj, ["init", "-q", "-b", "main"]);
  configureRepo(proj);
  await writeFile(path.join(proj, "README.md"), "# board\n", "utf8");
  git(proj, ["add", "-A"]);
  git(proj, ["commit", "-q", "-m", "init"]);
  const out = {};
  for (const name of trees) {
    const tree = path.join(proj, ".worktrees", name);
    git(proj, ["worktree", "add", "-q", "-b", `work/${name}`, slash(tree)]);
    out[name] = tree;
  }
  return { dir, repos, proj, trees: out };
}

const configFor = (board) => ({
  scanRoots: [slash(board.repos)],
  projects: [{ name: "proj", path: slash(board.proj), mainBranch: "main", remote: null }],
  // The sentry is not under test and must not wake anything from a sandbox.
  assistant: { enabled: false },
  // A sandbox does not wait a minute for the panel's own clock: a directory a rename moved is adopted by the next
  // pass, and the test asserts the row that pass produces rather than a timer.
  worktreeSeconds: 4,
  midSeconds: 4,
  dormantSeconds: 4,
  slowSeconds: 4,
});

const locksFile = (panel) => path.join(panel.dir, "logs", "locks.json");
// The store is created by the first write, so "nothing written" is a missing file as much as an empty map.
const ownersOnDisk = async (panel) => {
  try {
    const raw = JSON.parse(await readFile(locksFile(panel), "utf8"));
    return raw.owners || {};
  } catch (err) {
    if (err && err.code === "ENOENT") return {};
    throw err;
  }
};

// Every write from the panel's own page carries `Origin`; a worker's shell does not. The route refuses the second,
// so the test's own POSTs say where they came from — exactly as the browser does.
const fromPage = (panel) => ({ headers: { Origin: panel.base } });

// The panel's own SSE, read frame by frame until a matching event arrives. What a `row` event carries IS the contract
// the page draws from: its handler replaces state.rows' entry wholesale (public/core/sse.js queueRow -> placeRow), so
// a field missing here is a field the chart loses until the next full snapshot.
async function readStream(base, match, { timeoutMs = 45_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/stream`, { signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buf += dec.decode(value, { stream: true });
      let at;
      while ((at = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, at);
        buf = buf.slice(at + 2);
        const data = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!data) continue;
        const evt = JSON.parse(data.slice(6));
        if (match(evt)) return evt;
      }
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

test("a tree nobody moved reports Assistant #1, labelled by its role", { timeout: 120_000 }, async (t) => {
  const board = await makeBoard();
  t.after(() => rm(board.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const panel = await startPanel({ keep: true, config: configFor(board) });
  t.after(() => panel.stop());

  const row = await waitForRow(panel.base, "proj", board.trees["tree-one-1a2b3c"]);
  assert.equal(row.assistant.id, "assistant-1", "the default owner is Assistant #1");
  assert.equal(row.assistant.label, "Manager 1", "its label is the role's, not its id");
  assert.equal(row.assistant.name, "Assistant #1", "the cell's text is the assistant's own name");
  assert.equal(row.assistant.role, "Manager", "the bullet's second half is the role, without its number");
  assert.notEqual(row.assistant.label, row.assistant.id, "the label is never the raw id");
  assert.equal(row.assistant.fallback, undefined, "a default owner has nothing to explain");
  assert.deepEqual(await ownersOnDisk(panel), {}, "nothing is written for a tree nobody moved");
});

test("the setter stores an id, answers with the updated row, and survives a restart", { timeout: 180_000 }, async (t) => {
  const board = await makeBoard();
  t.after(() => rm(board.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const tree = board.trees["tree-one-1a2b3c"];
  const panel = await startPanel({ keep: true, config: configFor(board) });
  await waitForRow(panel.base, "proj", tree);
  const created = await post(panel.base, "/api/assistant/assistants", { body: { roleId: "agent-manager" } });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.created.id, "assistant-2");

  const set = await post(panel.base, "/api/worktree/assistant", { body: { project: "proj", path: tree, assistant: "assistant-2" }, ...fromPage(panel) });
  assert.equal(set.status, 200, set.text);
  assert.equal(set.json.assistant.id, "assistant-2");
  assert.equal(set.json.assistant.label, "Manager 2", "the second assistant on the manager role is Manager 2");
  assert.equal(set.json.row.assistant.id, "assistant-2", "the answer carries the updated row");

  // The next read agrees, and the store holds the id under the tree's tag — never the path, never the label.
  const row = await waitForRow(panel.base, "proj", tree);
  assert.equal(row.assistant.id, "assistant-2");
  assert.equal(row.assistant.name, "Assistant #2", "the cell names the assistant, not the role");
  assert.equal(row.assistant.label, "Manager 2");
  assert.equal(row.assistant.role, "Manager");
  assert.deepEqual(await ownersOnDisk(panel), { "proj::1a2b3c": "assistant-2" });

  // …and a restart proves it is the panel's, not the tab's.
  const dir = panel.dir;
  await panel.stop();
  const again = await startPanel({ dir, keep: false, reuseConfig: true });
  t.after(() => again.stop());
  const after = await waitForRow(again.base, "proj", tree);
  assert.equal(after.assistant.id, "assistant-2", "the owner outlives the process that stored it");
  assert.equal(after.assistant.label, "Manager 2");
});

test("setting Assistant #1 clears the entry instead of writing one", { timeout: 120_000 }, async (t) => {
  const board = await makeBoard();
  t.after(() => rm(board.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const tree = board.trees["tree-one-1a2b3c"];
  const panel = await startPanel({ keep: true, config: configFor(board) });
  t.after(() => panel.stop());
  await waitForRow(panel.base, "proj", tree);
  await post(panel.base, "/api/assistant/assistants", { body: { roleId: "agent-manager" } });
  const set = await post(panel.base, "/api/worktree/assistant", { body: { project: "proj", path: tree, assistant: "assistant-2" }, ...fromPage(panel) });
  assert.equal(set.status, 200, set.text);
  assert.notDeepEqual(await ownersOnDisk(panel), {});

  const cleared = await post(panel.base, "/api/worktree/assistant", { body: { project: "proj", path: tree, assistant: "assistant-1" }, ...fromPage(panel) });
  assert.equal(cleared.status, 200, cleared.text);
  assert.equal(cleared.json.assistant.id, "assistant-1");
  const row = await waitForRow(panel.base, "proj", tree);
  assert.equal(row.assistant.id, "assistant-1");
  assert.equal(row.assistant.label, "Manager 1");
  // Absence IS the default, so the file carries no owner for this tree rather than a record that says "assistant-1".
  assert.deepEqual(await ownersOnDisk(panel), {}, "setting #1 deletes the entry");
});

test("an unknown assistant id is refused and the stored owner does not move", { timeout: 120_000 }, async (t) => {
  const board = await makeBoard();
  t.after(() => rm(board.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const tree = board.trees["tree-one-1a2b3c"];
  const panel = await startPanel({ keep: true, config: configFor(board) });
  t.after(() => panel.stop());
  await waitForRow(panel.base, "proj", tree);
  await post(panel.base, "/api/assistant/assistants", { body: { roleId: "agent-manager" } });
  await post(panel.base, "/api/worktree/assistant", { body: { project: "proj", path: tree, assistant: "assistant-2" }, ...fromPage(panel) });

  const refused = await post(panel.base, "/api/worktree/assistant", { body: { project: "proj", path: tree, assistant: "nobody-9" }, ...fromPage(panel) });
  assert.equal(refused.status, 404, "an id no record answers for is a 404, not a silent default");
  assert.match(refused.text, /no such assistant: nobody-9/);
  const row = await waitForRow(panel.base, "proj", tree);
  assert.equal(row.assistant.id, "assistant-2", "the refusal leaves the owner alone");
  assert.deepEqual(await ownersOnDisk(panel), { "proj::1a2b3c": "assistant-2" });
});

test("the owner survives a rename of the directory AND the branch", { timeout: 180_000 }, async (t) => {
  const board = await makeBoard({ prefix: "wtgui-owner-rename-" });
  t.after(() => rm(board.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const tree = board.trees["tree-one-1a2b3c"];
  const panel = await startPanel({ keep: true, config: configFor(board) });
  t.after(() => panel.stop());
  await waitForRow(panel.base, "proj", tree);
  await post(panel.base, "/api/assistant/assistants", { body: { roleId: "agent-manager" } });
  const set = await post(panel.base, "/api/worktree/assistant", { body: { project: "proj", path: tree, assistant: "assistant-2" }, ...fromPage(panel) });
  assert.equal(set.status, 200, set.text);

  // `git worktree move` can lose the directory for a moment to a scanner read of the same tree (the answer then says
  // `moved: false` with a warning, and nothing moved), so the press is retried rather than the property weakened: the
  // asserted state is a rename that ACTUALLY landed.
  let renamed = await post(panel.base, "/api/worktree/rename", { body: { project: "proj", path: tree, name: "renamed-tree" } });
  for (let attempt = 0; attempt < 5 && renamed.status === 200 && renamed.json.moved !== true; attempt += 1) {
    await new Promise((r) => setTimeout(r, 800));
    renamed = await post(panel.base, "/api/worktree/rename", { body: { project: "proj", path: tree, name: "renamed-tree" } });
  }
  assert.equal(renamed.status, 200, `the panel renamed the tree: ${renamed.text}`);
  assert.equal(renamed.json.moved, true, `the directory moved: ${renamed.text}`);
  const moved = renamed.json.path;
  assert.notEqual(slash(moved).toLowerCase(), slash(tree).toLowerCase(), "the directory moved");
  assert.match(slash(moved), /renamed-tree-1a2b3c$/, "the rename keeps the tag");

  // The row under the NEW path is the reader's tree, with the reader's owner — a path-keyed store would answer
  // Assistant #1 here, which is the bug the key exists to prevent.
  // The row appears as soon as the scan adopts the directory; its branch arrives with the same read, so wait for the
  // row the reader would actually see rather than the half-filled first frame.
  const row = await waitForRow(panel.base, "proj", moved, { predicate: (r) => Boolean(r.branch), what: "the renamed row and its branch" });
  assert.equal(row.branch, "wtgui/renamed-tree-1a2b3c", "the branch moved with it (the panel rebuilds it as wtgui/<slug>-<tag>)");
  assert.equal(row.assistant.id, "assistant-2", "the owner follows the tree, not the path it used to have");
  assert.equal(row.assistant.label, "Manager 2");
  // One entry, still under the tag: the rename wrote nothing, because the key never moved.
  assert.deepEqual(await ownersOnDisk(panel), { "proj::1a2b3c": "assistant-2" });
});

test("the label is the role's, read at read time: two roles read as two labels and a rename needs no write", { timeout: 240_000 }, async (t) => {
  const board = await makeBoard({ prefix: "wtgui-owner-roles-", trees: ["tree-one-1a2b3c", "tree-two-4d5e6f"] });
  t.after(() => rm(board.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const one = board.trees["tree-one-1a2b3c"];
  const two = board.trees["tree-two-4d5e6f"];
  const panel = await startPanel({ keep: true, config: configFor(board) });
  await waitForRow(panel.base, "proj", one);
  const role = await post(panel.base, "/api/assistant/roles", { body: { name: "Reviewer" } });
  assert.equal(role.status, 201, role.text);
  const reviewerId = role.json.role.id;
  const made = await post(panel.base, "/api/assistant/assistants", { body: { roleId: reviewerId } });
  assert.equal(made.status, 201, made.text);

  const a = await post(panel.base, "/api/worktree/assistant", { body: { project: "proj", path: one, assistant: "assistant-1" }, ...fromPage(panel) });
  const b = await post(panel.base, "/api/worktree/assistant", { body: { project: "proj", path: two, assistant: "assistant-2" }, ...fromPage(panel) });
  assert.equal(a.status, 200, a.text);
  assert.equal(b.status, 200, b.text);
  assert.equal((await waitForRow(panel.base, "proj", one)).assistant.label, "Manager 1");
  assert.equal((await waitForRow(panel.base, "proj", two)).assistant.label, "Reviewer 1", "a different role reads as a different label");
  // The served assistant list carries the same labels, so the page never has to map an id to a name itself.
  const listed = await (await fetch(`${panel.base}/api/assistant`)).json();
  const labels = Object.fromEntries((listed.assistants || []).map((x) => [x.id, x.roleLabel]));
  assert.equal(labels["assistant-1"], "Manager 1");
  assert.equal(labels["assistant-2"], "Reviewer 1");

  // A ROLE RENAME, on disk, with the store untouched: the row's text follows the role because nothing about the
  // label is stored. `locks.json` is compared byte for byte across the restart.
  const before = sha(await readFile(locksFile(panel), "utf8"));
  const dir = panel.dir;
  await panel.stop();
  const rolesPath = path.join(dir, "logs", "roles.json");
  const stored = JSON.parse(await readFile(rolesPath, "utf8"));
  for (const rec of stored.roles || []) if (rec.id === reviewerId) rec.name = "Auditor";
  await writeFile(rolesPath, `${JSON.stringify(stored, null, 1)}\n`, "utf8");

  const again = await startPanel({ dir, keep: false, reuseConfig: true });
  t.after(() => again.stop());
  const renamedRow = await waitForRow(again.base, "proj", two);
  assert.equal(renamedRow.assistant.id, "assistant-2", "the id in the store did not move");
  assert.equal(renamedRow.assistant.label, "Auditor 1", "the label follows the role's new name");
  assert.equal(renamedRow.assistant.role, "Auditor", "…and so does the bullet's unnumbered role");
  assert.equal(renamedRow.assistant.name, "Assistant #2", "the assistant's own name did not move");
  assert.equal(sha(await readFile(locksFile(again), "utf8")), before, "renaming a role writes nothing to the owner store");
});

test("an owner whose assistant is gone falls back to Assistant #1 and says so", { timeout: 180_000 }, async (t) => {
  const board = await makeBoard({ prefix: "wtgui-owner-gone-" });
  t.after(() => rm(board.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const tree = board.trees["tree-one-1a2b3c"];
  const panel = await startPanel({ keep: true, config: configFor(board) });
  await waitForRow(panel.base, "proj", tree);
  await post(panel.base, "/api/assistant/assistants", { body: { roleId: "agent-manager" } });
  const set = await post(panel.base, "/api/worktree/assistant", { body: { project: "proj", path: tree, assistant: "assistant-2" }, ...fromPage(panel) });
  assert.equal(set.status, 200, set.text);

  // The assistant is removed from the board (the store is the panel's; a deleted record is what a restart sees).
  const dir = panel.dir;
  await panel.stop();
  const file = path.join(dir, "logs", "assistants.json");
  const stored = JSON.parse(await readFile(file, "utf8"));
  stored.assistants = (stored.assistants || []).filter((a) => a.id !== "assistant-2");
  await writeFile(file, `${JSON.stringify(stored, null, 1)}\n`, "utf8");

  const again = await startPanel({ dir, keep: false, reuseConfig: true });
  t.after(() => again.stop());
  const row = await waitForRow(again.base, "proj", tree);
  assert.equal(row.assistant.id, "assistant-1", "the tree falls back to the default owner");
  assert.equal(row.assistant.name, "Assistant #1", "the cell names who ACTUALLY owns it now");
  assert.equal(row.assistant.label, "Manager 1");
  assert.equal(row.assistant.role, "Manager");
  assert.equal(row.assistant.stored, "assistant-2", "the row keeps the id the reader gave it");
  assert.match(row.assistant.fallback, /assistant-2 is not on the board any more/);
  assert.match(row.assistant.fallback, /Assistant #1 controls this worktree/);
  // The store is NOT rewritten behind the reader's back: the fallback is a read-time answer, so re-creating the
  // assistant brings the tree back to it.
  assert.deepEqual(await ownersOnDisk(again), { "proj::1a2b3c": "assistant-2" });
});

test("the setter is the reader's: a request with no same-origin Origin is refused", { timeout: 120_000 }, async (t) => {
  const board = await makeBoard();
  t.after(() => rm(board.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const tree = board.trees["tree-one-1a2b3c"];
  const panel = await startPanel({ keep: true, config: configFor(board) });
  t.after(() => panel.stop());
  await waitForRow(panel.base, "proj", tree);
  await post(panel.base, "/api/assistant/assistants", { body: { roleId: "agent-manager" } });

  // What a worker's own shell produces: the right body, no Origin — the shape of an agent trying to reassign the tree
  // it is working in.
  const bare = await post(panel.base, "/api/worktree/assistant", { body: { project: "proj", path: tree, assistant: "assistant-2" } });
  assert.equal(bare.status, 403, bare.text);
  assert.match(bare.text, /reader's to set/);
  assert.deepEqual(await ownersOnDisk(panel), {}, "the refusal does not move the owner");
  const row = await waitForRow(panel.base, "proj", tree);
  assert.equal(row.assistant.id, "assistant-1");

  // Another origin is refused too: same-origin means the panel's own page, not merely "some browser".
  const foreign = await post(panel.base, "/api/worktree/assistant", { body: { project: "proj", path: tree, assistant: "assistant-2" }, headers: { Origin: "http://127.0.0.1:1" } });
  assert.equal(foreign.status, 403, foreign.text);
  assert.deepEqual(await ownersOnDisk(panel), {});

  // …and the page's own request is the one that lands.
  const page = await post(panel.base, "/api/worktree/assistant", { body: { project: "proj", path: tree, assistant: "assistant-2" }, ...fromPage(panel) });
  assert.equal(page.status, 200, page.text);
  assert.deepEqual(await ownersOnDisk(panel), { "proj::1a2b3c": "assistant-2" });
});

test("the store's key is the tree's tag, so neither the path nor the branch spelling can move it", () => {
  // The invariant behind the rename test, without a panel: two spellings of the same tree — before and after the
  // panel's rename — are one key, and a different tag (a different tree cut into the same folder) is another.
  const before = ownerKey({ project: "proj", path: "C:/p/.worktrees/tree-one-1a2b3c", branch: "wtgui/tree-one-1a2b3c" });
  const after = ownerKey({ project: "proj", path: "C:/p/.worktrees/renamed-tree-1a2b3c", branch: "wtgui/renamed-tree-1a2b3c" });
  assert.equal(before, after);
  assert.equal(before, "proj::1a2b3c");
  assert.notEqual(before, ownerKey({ project: "proj", path: "C:/p/.worktrees/tree-one-4d5e6f" }));
  // A directory with no tag is keyed by its path — and the panel refuses to rename an untagged tree, so that entry
  // cannot be moved out from under itself either.
  assert.match(ownerKey({ project: "proj", path: "C:/p/.worktrees/plain" }), /^proj::path:/);
});

test("the owner is drawn from the server's answer, and the wake path consults the same store", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  // The worktree row template moved to public/render-projects.js in step 7 of
  // docs/reports/module-map-2026-11-07.html, so the owner slot is read where the template now lives.
  const src = `${app}\n${await readFile(new URL("../public/render-projects.js", import.meta.url), "utf8")}`;
  // Both surfaces come from the owner-cell region, which reads the SERVER's name, label and role; neither maps an id
  // to a sentence of its own, and neither falls back to the role label.
  assert.match(src, /assistant: ownerCellHtml\(row\)/, "the owner column draws the owner cell");
  assert.match(src, /\$\{ownerDetailHtml\(row\)\}/, "the merge-state list draws the owner bullet");
  assert.doesNotMatch(src, /row\.assistant\?\.label \|\| "Assistant #1"/, "neither surface falls back to the role label");
  assert.doesNotMatch(src, /Controlled by: \$\{esc\(row\.assistant/, "the bullet no longer reads the label");
  assert.doesNotMatch(src, /assistant-2["'`]\s*=>/, "the page never hard-codes an id-to-label table");

  // The routing half: the module that fires wakes reads the same store the row draws, through the port the server
  // hands it (`this.locks`), and never imports the store itself — where the answer lives stays the server's business,
  // and a unit test can hand in a stub. `row.assistant` is still never read here: the page's field is not the store.
  const assistant = await readFile(new URL("../lib/assistant.js", import.meta.url), "utf8");
  assert.doesNotMatch(assistant, /row\.assistant/);
  assert.match(assistant, /this\.locks\.owner\(/, "the wake path asks the injected owner store");
  assert.match(assistant, /assistantIdForJob\(/, "one resolver decides which assistant a run belongs to");
  assert.match(assistant, /this\.locks\.setOwner\(/, "a tree an assistant started in is claimed through the store");
  assert.doesNotMatch(assistant, /^import[^\n]*locks\.js/m, "the module does not import the store itself");
});

test("a tree's FIRST row event carries the owner, before any snapshot has overlaid it", { timeout: 150_000 }, async (t) => {
  const board = await makeBoard();
  t.after(() => rm(board.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const panel = await startPanel({ keep: true, config: configFor(board) });
  t.after(() => panel.stop());
  await waitForRow(panel.base, "proj", board.trees["tree-one-1a2b3c"]);

  // The page rebuilds ONE row from a `row` frame, and that frame replaces its row object wholesale
  // (public/core/sse.js queueRow -> placeRow). A tree cut after the board is up reaches the page FIRST through that
  // frame, which is why the owner has to be on it: the overlay lives in `withAssistantOwners`, which only ever sees
  // the rows a snapshot carries, so a frame built from the scanner's own row draws the bare fallback name — the cell
  // loses "(Manager 1)", the bullet loses "— Manager" — until the next full snapshot, and a board that is not polled
  // never gets one. Observed as a 2-of-4 flake in tools/verify-chart-columns.mjs before this was pinned.
  const fresh = path.join(board.proj, ".worktrees", "tree-two-4d5e6f");
  const pending = readStream(panel.base, (evt) => evt.type === "row" && slash(evt.row?.path || "") === slash(fresh));
  git(board.proj, ["worktree", "add", "-q", "-b", "work/two", slash(fresh)]);
  const evt = await pending;
  assert.ok(evt, "the new tree's arrival was announced as a row event");
  assert.equal(evt.row.assistant?.id, "assistant-1", "the event's row carries the owner's id");
  assert.equal(evt.row.assistant?.name, "Assistant #1", "…its name, which the cell draws");
  assert.equal(evt.row.assistant?.label, "Manager 1", "…its numbered role label, which the tooltip draws");
  assert.equal(evt.row.assistant?.role, "Manager", "…and its role, so the bullet keeps its second half");
});
