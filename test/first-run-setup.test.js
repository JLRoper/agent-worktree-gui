// First-run setup, proved against a real `node server.js` boot.
//
// The gate is one fact: config.json names no scan roots. While it holds the server reports `needsSetup` and monitors
// nothing — not even a discovery cache an earlier configuration left behind — and the page shows the setup screen.
// The screen previews a folder with the same rule discovery uses, and the save refuses a folder that is not on this
// machine, so setup cannot end on a root that scans nothing. Every panel is a sandbox (tools/panel-testkit.mjs).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { post, startPanel } from "../tools/panel-testkit.mjs";

const getJson = async (panel, route) => (await fetch(`${panel.base}${route}`)).json();
const preview = (panel, root) => getJson(panel, `/api/settings/scan-preview?root=${encodeURIComponent(root)}`);

// A folder holding one git repo, one plain directory and one stray file: the preview must name only the repo.
function seedRoot(dir) {
  const root = path.join(dir, "code");
  mkdirSync(path.join(root, "notes"), { recursive: true });
  writeFileSync(path.join(root, "README.txt"), "not a repo\n");
  execFileSync("git", ["init", "-q", path.join(root, "alpha")], { windowsHide: true });
  return root;
}

async function waitFor(check, what, ms = 15_000) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

test("no scanRoots in config.json is first-run setup: needsSetup, and nothing monitored — not even the discovery cache", async (t) => {
  // A cache from an earlier configuration, naming a real repo, in place before the boot reads it. Setup must not
  // resurrect it.
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-setup-"));
  const root = seedRoot(dir);
  mkdirSync(path.join(dir, "logs"), { recursive: true });
  writeFileSync(
    path.join(dir, "logs", "projects.json"),
    JSON.stringify({ savedAt: new Date().toISOString(), projects: [{ name: "alpha", path: path.join(root, "alpha") }] }),
  );
  const panel = await startPanel({ dir, config: { scanRoots: undefined } });
  t.after(() => panel.stop());
  assert.match(panel.log(), /discovery cache: 1 project/, "the stale cache was there to be ignored");

  const cfg = await getJson(panel, "/api/config");
  assert.equal(cfg.needsSetup, true);
  assert.deepEqual(cfg.scanRoots, []);
  const s = await getJson(panel, "/api/state");
  assert.equal(s.settings.needsSetup, true, "the snapshot carries the gate too, so every open tab sees it");
  assert.deepEqual(s.projects, []);
  await waitFor(() => /no scanRoots configured, waiting for first-run setup/.test(panel.log()), "the boot sweep to stand down");
  assert.deepEqual((await getJson(panel, "/api/state")).projects, [], "and still nothing once the sweep has run");
});

test("an empty scanRoots list is first-run setup too; a populated one is not", async (t) => {
  const empty = await startPanel({ config: { scanRoots: ["", "  "] } });
  t.after(() => empty.stop());
  assert.equal((await getJson(empty, "/api/config")).needsSetup, true, "blank entries are not a folder");

  const populated = await startPanel();
  t.after(() => populated.stop());
  assert.equal((await getJson(populated, "/api/config")).needsSetup, false);
});

test("the preview lists the git repos directly under a folder, and says when the folder is not there", async (t) => {
  const panel = await startPanel({ config: { scanRoots: undefined } });
  t.after(() => panel.stop());
  const root = seedRoot(panel.dir);

  const found = await preview(panel, root);
  assert.equal(found.exists, true);
  assert.deepEqual(found.repos, ["alpha"], "a plain directory and a file are not repos");

  const missing = await preview(panel, path.join(panel.dir, "nowhere"));
  assert.equal(missing.exists, false);
  assert.deepEqual(missing.repos, []);

  const r = await fetch(`${panel.base}/api/settings/scan-preview`);
  assert.equal(r.status, 400, "a preview needs a root");
});

test("the save refuses an empty list and a folder that is not on this machine, and leaves config.json alone", async (t) => {
  const panel = await startPanel({ config: { scanRoots: undefined } });
  t.after(() => panel.stop());
  const cfgPath = path.join(panel.dir, "config.json");
  const before = readFileSync(cfgPath, "utf8");

  const none = await post(panel.base, "/api/settings/projects", { body: { scanRoots: [] } });
  assert.equal(none.status, 400);

  const nowhere = path.join(panel.dir, "nowhere");
  const bad = await post(panel.base, "/api/settings/projects", { body: { scanRoots: [seedRoot(panel.dir), nowhere] } });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.json.missing, [nowhere], "the refusal names the folder that is not there");

  assert.equal(readFileSync(cfgPath, "utf8"), before, "a refused save writes nothing");
  assert.equal((await getJson(panel, "/api/config")).needsSetup, true);
});

test("saving a real folder ends setup: config.json gains scanRoots and the board fills from it", async (t) => {
  const panel = await startPanel({ config: { scanRoots: undefined } });
  t.after(() => panel.stop());
  const root = seedRoot(panel.dir);

  // The same folder twice, with stray whitespace, is saved once.
  const saved = await post(panel.base, "/api/settings/projects", { body: { scanRoots: [root, ` ${root} `] } });
  assert.equal(saved.status, 200, saved.text);
  assert.deepEqual(saved.json.scanRoots, [root]);

  const onDisk = JSON.parse(readFileSync(path.join(panel.dir, "config.json"), "utf8"));
  assert.deepEqual(onDisk.scanRoots, [root], "the choice survives a restart");
  assert.equal((await getJson(panel, "/api/config")).needsSetup, false);

  const s = await waitFor(async () => {
    const st = await getJson(panel, "/api/state");
    return st.projects.some((p) => p.name === "alpha") && st;
  }, "the saved root's repo to reach the board");
  assert.equal(s.settings.needsSetup, false);
});
