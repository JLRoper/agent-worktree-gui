// Importing a studio export over HTTP, against a real panel on a spare port.
//
//   POST /api/assistant/pipeline-bundle/import   append a studio export to the bundle the panel reads
//   GET  /api/assistant/pipeline-catalogue       the pipelines the dropdown may offer, each with its stage count
//
// The claim this pins is the one the reader made: the live file used to be ONE studio document, so a second import
// could only replace the first and the dropdown kept one entry. Here the panel starts from exactly that shape (one
// studio document on disk), imports a second export, and the catalogue — and the assignment it feeds — sees BOTH. A
// duplicate id is a 409 that names the pipeline and leaves the file byte-identical; a broken document is a 422 that
// writes nothing.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startPanel } from "../tools/panel-testkit.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEED_TEXT = await readFile(path.join(ROOT, "pipeline-bundle.seed.json"), "utf8");
const TOKEN = "import-token";
const sha = (text) => createHash("sha256").update(text).digest("hex");

const stage = (id, title) => ({
  id,
  title,
  prompt: `Do ${title}.`,
  artifact: { id: `${id}-artifact`, path: `out/${id}.json`, schema: "out/1", writer: `${id}-writer` },
});

// Exactly the old live shape: a bare studio document, one pipeline, roles at the document's own level.
const studioDoc = (id, title, stageIds) => ({
  version: 1,
  project: { id, name: title, description: `${title}, as the studio exports it.` },
  roles: stageIds.map((s) => ({ id: `${s}-role`, name: `${s} role`, kind: "agent", instructions: `do ${s}` })),
  stages: stageIds.map((s) => ({
    id: s,
    title: `${title} ${s}`,
    owner: { kind: "agent", role: `${s}-role` },
    artifact: { id: `${s}-artifact`, path: `out/${s}.json`, schema: "out/1", writer: `${s}-role` },
  })),
  handoffs: stageIds.slice(0, -1).map((s, i) => ({ id: `h-${s}`, from: s, to: stageIds[i + 1], artifact: `${s}-artifact`, kind: "sequence" })),
  gates: [],
});

const get = async (base, route) => {
  const res = await fetch(`${base}${route}`);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* the assertion prints the body */
  }
  return { status: res.status, json, text };
};

const postImport = async (base, body) => {
  const res = await fetch(`${base}/api/assistant/pipeline-bundle/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-panel-token": TOKEN },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* the assertion prints the body */
  }
  return { status: res.status, json, text };
};

const postQueue = async (base, body) => {
  const res = await fetch(`${base}/api/assistant/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-panel-token": TOKEN },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* the assertion prints the body */
  }
  return { status: res.status, json, text };
};

test("an import appends a second studio export: the catalogue lists both, and the new one is assignable", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-pipeimport-"));
  const logs = path.join(dir, "logs");
  await mkdir(path.join(logs, "assistants", "assistant-1"), { recursive: true });
  const bundleFile = path.join(logs, "pipeline-bundle.json");
  const first = studioDoc("poc-to-uat", "POC to UAT", ["S0", "S1", "S2"]);
  await writeFile(bundleFile, JSON.stringify(first, null, 1), "utf8");
  const queueFile = path.join(logs, "assistants", "assistant-1", "queue.json");
  await writeFile(queueFile, JSON.stringify({ version: 3, nextId: 2, tasks: [{ id: 1, title: "pick me up", state: "queued", files: [], pipelineRun: null }] }, null, 1), "utf8");

  const panel = await startPanel({
    dir,
    keep: true,
    token: TOKEN,
    config: {
      pipelineBundleFile: bundleFile,
      refreshSeconds: 3600,
      worktreeSeconds: 3600,
      midSeconds: 3600,
      dormantSeconds: 3600,
      slowSeconds: 3600,
      fetchSeconds: -1,
      assistant: { enabled: false },
      apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
    },
  });
  t.after(async () => {
    await panel.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  // ---- the old shape reads as one pipeline ---------------------------------------------------------
  const before = await get(panel.base, "/api/assistant/pipeline-catalogue");
  assert.equal(before.status, 200, before.text.slice(0, 300));
  assert.deepEqual(before.json.pipelines.map((p) => [p.id, p.stageCount]), [["poc-to-uat", 3]]);
  assert.deepEqual(before.json.pipelines[0].stages.map((s) => s.id), ["S0", "S1", "S2"]);

  // ---- the import appends ---------------------------------------------------------------------------
  const pingPong = studioDoc("ping-pong", "Ping-pong", ["draft", "critique"]);
  pingPong.handoffs = [
    { id: "H-01", from: "draft", to: "critique", artifact: "draft-artifact", kind: "sequence" },
    { id: "H-02", from: "critique", to: "draft", artifact: "critique-artifact", kind: "loop", cap: "3 rounds" },
  ];
  const imported = await postImport(panel.base, { document: pingPong });
  assert.equal(imported.status, 200, imported.text.slice(0, 400));
  assert.equal(imported.json.ok, true);
  assert.deepEqual(imported.json.added, [{ id: "ping-pong", title: "Ping-pong", stages: 2 }]);
  assert.deepEqual(imported.json.pipelines.map((p) => [p.id, p.stages]), [["poc-to-uat", 3], ["ping-pong", 2]]);
  assert.match(imported.json.reason, /imported "ping-pong" \(2 stages\)/);
  assert.match(imported.json.reason, /now holds 2 pipelines/);

  // The write is on disk, in the panel's own wrapper, and the pipeline that was there is still there field for field.
  const onDisk = JSON.parse(await readFile(bundleFile, "utf8"));
  assert.equal(onDisk.bundleVersion, 1);
  assert.deepEqual(onDisk.pipelines.map((p) => p.id || (p.project && p.project.id)), ["poc-to-uat", "ping-pong"]);
  assert.deepEqual(onDisk.pipelines[0], first, "the live studio document was lifted, not rewritten");

  // The catalogue — the answer the dropdown draws — lists both, with their own stage counts.
  const after = await get(panel.base, "/api/assistant/pipeline-catalogue");
  assert.equal(after.status, 200);
  assert.deepEqual(after.json.pipelines.map((p) => [p.id, p.stageCount, p.stages.length]), [
    ["poc-to-uat", 3, 3],
    ["ping-pong", 2, 2],
  ]);
  assert.equal(after.json.pipelines[1].stages[1].title, "Ping-pong critique", "the imported stage names travel");

  // ---- a duplicate id is a 409 that names the pipeline and writes nothing ----------------------------
  const bytes = await readFile(bundleFile, "utf8");
  const dup = await postImport(panel.base, { document: studioDoc("ping-pong", "Ping-pong again", ["a", "b"]) });
  assert.equal(dup.status, 409, dup.text.slice(0, 400));
  assert.equal(dup.json.code, "duplicate-id");
  assert.match(dup.json.error, /"ping-pong"/);
  assert.match(dup.json.error, /already held as Ping-pong/);
  assert.equal(sha(await readFile(bundleFile, "utf8")), sha(bytes), "the bundle is byte-identical after a refused import");

  // ---- a document the loader refuses is a 422 that writes nothing ------------------------------------
  const broken = await postImport(panel.base, { document: { version: 1, stages: [{ id: "x", title: "X" }] } });
  assert.equal(broken.status, 422, broken.text.slice(0, 400));
  assert.equal(sha(await readFile(bundleFile, "utf8")), sha(bytes), "a refused document writes nothing either");

  // ---- and the imported pipeline is assignable: the record names a stage of ITS OWN -----------------
  const assign = await postQueue(panel.base, { assistantId: "assistant-1", action: "pipeline", id: 1, pipeline: "ping-pong", stage: "critique" });
  assert.equal(assign.status, 200, assign.text.slice(0, 400));
  assert.equal(assign.json.ok, true);
  const view = await get(panel.base, "/api/assistant/task-pipeline?assistantId=assistant-1&task=1");
  assert.equal(view.status, 200, view.text.slice(0, 300));
  assert.equal(view.json.mode, "pipeline");
  assert.equal(view.json.pipeline.id, "ping-pong");
  assert.equal(view.json.count, 2, "the window counts the chosen pipeline's stages, not the largest one's");
  assert.equal(view.json.current.id, "critique");
  assert.equal(view.json.current.position, 2);

  // ---- an unreadable live bundle is REPAIRED over HTTP, and the route says so ------------------------
  // The case the import exists for: the file on disk is one the loader refuses whole, so the window draws nothing.
  // This used to be a 422 live-bundle-unreadable and the reader ran the seed tool by hand.
  const truncated = '{"bundleVersion":1,"name":"stale","pipelines":[{"id":"half';
  await writeFile(bundleFile, truncated, "utf8");
  const repaired = await postImport(panel.base, { text: SEED_TEXT, name: "pipeline-bundle.seed.json" });
  assert.equal(repaired.status, 200, repaired.text.slice(0, 400));
  assert.equal(repaired.json.ok, true);
  assert.ok(repaired.json.repair, "the route reports the repair instead of an append");
  assert.equal(repaired.json.repair.code, "not-a-bundle");
  assert.match(repaired.json.repair.reason, /the file it replaces cannot be read/);
  assert.match(repaired.json.reason, /repaired the bundle/);
  assert.match(repaired.json.reason, /not-a-bundle/);
  const healed = await get(panel.base, "/api/assistant/pipeline-catalogue");
  assert.equal(healed.status, 200);
  assert.ok(healed.json.pipelines.length > 1, "the catalogue reads the repaired bundle");

  // ---- a document that does not parse is still a 422 that writes nothing, repair or not -----------------
  const afterRepair = await readFile(bundleFile, "utf8");
  const refusedSeed = await postImport(panel.base, { document: { version: 1, stages: [{ id: "x", title: "X" }] } });
  assert.equal(refusedSeed.status, 422, refusedSeed.text.slice(0, 400));
  assert.equal(sha(await readFile(bundleFile, "utf8")), sha(afterRepair), "a refused document writes nothing");

  // ---- the route is a POST only ----------------------------------------------------------------------
  const wrong = await fetch(`${panel.base}/api/assistant/pipeline-bundle/import`);
  assert.equal(wrong.status, 405);
});

// ---- `{seed: true}`: the repair control's one press, over HTTP --------------------------------------
// Settings > Pipeline prints the loader's sentence for a bundle it refuses and offers one control: "repair from the
// seed". The page does not carry the document and does not name a path — it posts `{seed: true}` and the ROUTE reads
// the bundle this checkout ships. What this pins, in the order a reader meets it:
//
//   the refusal is the real one   the live file is the shipped seed with gate G1's `routes` map removed, and the
//                                 catalogue answers exactly the code and locator the tab printed (incomplete-gate at
//                                 pipelines[3].gates[0].decision.routes);
//   the repair writes             a 200 carrying `repair` and eleven pipelines, and the file on disk is no longer the
//                                 refused bytes — it is the shipped bundle, every pipeline readable;
//   the list appears              the catalogue the dropdown draws reads eleven, which is what "the eleven appear
//                                 there" means from the route's side;
//   a second press appends        the repaired file LOADS, so the same body is now a duplicate-id 409 that writes
//                                 nothing — the repair replaces only what cannot be read.
test("the repair door imports the shipped seed over a refused bundle, and the catalogue then lists eleven", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-pipeimport-seed-"));
  const logs = path.join(dir, "logs");
  await mkdir(path.join(logs, "assistants", "assistant-1"), { recursive: true });
  const bundleFile = path.join(logs, "pipeline-bundle.json");
  // The reader's live file: the shipped bundle with the route-less gate the tab refused whole.
  const stale = JSON.parse(SEED_TEXT);
  delete stale.pipelines[3].gates[0].decision.routes;
  await writeFile(bundleFile, JSON.stringify(stale, null, 1), "utf8");
  const before = sha(await readFile(bundleFile, "utf8"));

  const panel = await startPanel({
    dir,
    keep: true,
    token: TOKEN,
    config: {
      pipelineBundleFile: bundleFile,
      refreshSeconds: 3600,
      worktreeSeconds: 3600,
      midSeconds: 3600,
      dormantSeconds: 3600,
      slowSeconds: 3600,
      fetchSeconds: -1,
      assistant: { enabled: false },
      apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
    },
  });
  t.after(async () => {
    await panel.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  // ---- the state the tab draws: refused, with the loader's own code and locator -----------------------
  const refusedRead = await get(panel.base, "/api/assistant/pipeline-catalogue");
  assert.equal(refusedRead.status, 200, refusedRead.text.slice(0, 300));
  assert.equal(refusedRead.json.ok, false);
  assert.equal(refusedRead.json.code, "incomplete-gate");
  assert.equal(refusedRead.json.where, "pipelines[3].gates[0].decision.routes");
  assert.match(refusedRead.json.reason, /gate G1 of pipeline author-review-revise declares outcomes accept, reject and no "routes" map/);
  assert.deepEqual(refusedRead.json.pipelines, [], "a refused bundle offers nothing to assign");

  // ---- the press: `{seed: true}`, nothing else named -------------------------------------------------
  const repaired = await postImport(panel.base, { seed: true });
  assert.equal(repaired.status, 200, repaired.text.slice(0, 500));
  assert.equal(repaired.json.ok, true);
  assert.ok(repaired.json.repair, "the route reports a repair instead of an append");
  assert.equal(repaired.json.repair.code, "incomplete-gate");
  assert.equal(repaired.json.repair.where, "pipelines[3].gates[0].decision.routes");
  assert.equal(repaired.json.pipelines.length, 11);
  assert.match(repaired.json.reason, /^repaired the bundle: the file it replaces cannot be read/);
  assert.match(repaired.json.reason, /now holds 11 pipelines/);

  // ---- the file was REPLACED, not merged into --------------------------------------------------------
  const after = await readFile(bundleFile, "utf8");
  assert.notEqual(sha(after), before, "the refused bytes are gone");
  const onDisk = JSON.parse(after);
  assert.equal(onDisk.bundleVersion, 1);
  assert.equal(onDisk.pipelines.length, 11);
  assert.deepEqual(onDisk.pipelines.map((p) => p.id), JSON.parse(SEED_TEXT).pipelines.map((p) => p.id));

  // ---- and the list the dropdown draws is the eleven -------------------------------------------------
  const healed = await get(panel.base, "/api/assistant/pipeline-catalogue");
  assert.equal(healed.status, 200);
  assert.equal(healed.json.ok, true);
  assert.equal(healed.json.pipelines.length, 11);
  assert.equal(healed.json.pipelines[0].id, "poc-to-uat");
  assert.deepEqual(healed.json.pipelines.map((p) => p.id), ["poc-to-uat", "ping-pong", "probe-fix", "author-review-revise", "local", "investigate", "turnover", "github-investigate", "sefl-investigate", "github-force-merge", "sefl-review-loop"]);

  // ---- a second press appends, so it refuses the ids it now holds ------------------------------------
  const again = await postImport(panel.base, { seed: true });
  assert.equal(again.status, 409, again.text.slice(0, 400));
  assert.equal(again.json.code, "duplicate-id");
  assert.equal(sha(await readFile(bundleFile, "utf8")), sha(after), "a readable bundle is not replaced");
});
