// Row 578's proof, rerunable: one real wave, both routes, the tab read through its memo.
//
//   node docs/reports/wave-status-authority-578/repro.mjs
//
// Boots the real server against a throwaway config, creates an initiative, reads the tab (so its memo exists),
// creates one wave through the only writer there is, then asks GET /api/waves and GET /api/initiatives for it and
// requires the same answer. Then breaks the store on disk and requires both routes to agree that it cannot be read.
// Exit code 0 is agreement; 1 is the disagreement this row exists to prevent, printed with both bodies.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { post, startPanel } from "../../../tools/panel-testkit.mjs";

const sandbox = mkdtempSync(path.join(os.tmpdir(), "wag-wave-authority-"));
const wavesFile = path.join(sandbox, "logs", "waves.json");
const panel = await startPanel({ dir: sandbox, config: { wavesFile } });
const get = async (p) => {
  const res = await fetch(`${panel.base}${p}`);
  return { status: res.status, json: await res.json() };
};
const shown = (doc, initiativeId) => ({
  waveStatus: doc.waveStatus
    ? { file: doc.waveStatus.file, found: doc.waveStatus.found, readable: doc.waveStatus.readable }
    : { file: doc.file, found: doc.found, readable: doc.readable },
  waves: doc.waves || (doc.initiatives || []).find((row) => row.id === initiativeId)?.waves || [],
});

let failed = 0;
try {
  await post(panel.base, "/api/settings/initiative-tier", { body: { tier: "none" } });
  const made = await post(panel.base, "/api/initiatives", { body: { title: "Wave authority", description: "" } });
  const initiativeId = made.json.initiative.id;

  // The tab's memo is built here, before any wave exists.
  await get("/api/initiatives");
  const wave = await post(panel.base, "/api/waves", { body: { initiativeId, title: "The wave in question" } });
  assert.equal(wave.status, 200, wave.text);

  const route = await get(`/api/waves?initiative=${initiativeId}`);
  const tab = await get("/api/initiatives");
  const a = shown(route.json, initiativeId);
  const b = shown(tab.json, initiativeId);
  console.log("GET /api/waves        ", route.status, JSON.stringify(a));
  console.log("GET /api/initiatives  ", tab.status, JSON.stringify(b));
  assert.deepEqual(
    b.waves.map((w) => ({ id: w.id, state: w.state })),
    a.waves.map((w) => ({ id: w.id, state: w.state })),
    "the two routes disagree about the wave",
  );
  assert.equal(b.waveStatus.found, a.waveStatus.found, "the two routes disagree about whether the store exists");
  console.log("agree on the wave:", a.waves.map((w) => `${w.id} ${w.state}`).join(", "));

  // Break the file: both must say it cannot be read, and neither may answer a lane.
  writeFileSync(wavesFile, "{ not json at all\n", "utf8");
  const routeBad = await get(`/api/waves?initiative=${initiativeId}`);
  const tabBad = await get("/api/initiatives");
  const c = shown(routeBad.json, initiativeId);
  const d = shown(tabBad.json, initiativeId);
  console.log("broken GET /api/waves        ", routeBad.status, JSON.stringify({ refused: routeBad.json.refused }));
  console.log("broken GET /api/initiatives  ", tabBad.status, JSON.stringify(d.waveStatus));
  assert.equal(routeBad.status, 409);
  assert.equal(routeBad.json.refused, "unreadable");
  assert.equal(d.waveStatus.readable, false, "the tab answered a readable store while the route answered 409");
  assert.equal(d.waves.length, 0, "the tab drew a lane from a store it cannot read");
  console.log("agree on the store: unreadable on both, no lane drawn");
} catch (error) {
  failed = 1;
  console.error("DISAGREEMENT:", error && error.message ? error.message : error);
} finally {
  await panel.stop();
}
process.exit(failed);
