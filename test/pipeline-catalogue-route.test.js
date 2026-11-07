// The pipeline catalogue's HTTP surface, over a real panel on a spare port.
//
//   GET /api/pipelines   the merged catalogue — the reader's pipelines.json over the shipped seed — with its
//                        provenance (both file paths), the version it was written with, the closed vocabularies the
//                        tab draws its controls from, and every refusal the loader made.
//   PUT /api/pipelines   one document in, validatePipeline's findings out UNALTERED, and nothing written when any
//                        definition is refused.
//
// Six things a pure function cannot show, and this file pins:
//
//   1. the read carries the FULL definitions (a stage's prompt, its exit and its parameters), not the summary
//      /api/state holds — the tab edits stages, and a summary would make it guess;
//   2. a valid save reaches the live file, and the answer is the merged catalogue again;
//   3. a definition validatePipeline rejects is a 422 whose `findings` are the validator's own sentences, and the
//      file on disk is untouched;
//   4. a `next` that goes backwards is the same 422 — the cross-reference rule runs over the document's own valid
//      definitions, so it needs the target in the same body;
//   5. a document whose version is newer than this panel's is a 409 refused whole, exactly as the loader refuses it;
//   6. a save that names one definition merges over the live file's others: editing `local` and then `investigate`
//      leaves both edits in force.
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ROOT, startPanel } from "../tools/panel-testkit.mjs";

const SEED = JSON.parse(readFileSync(path.join(ROOT, "pipelines.seed.json"), "utf8"));
const seedDef = (id) => JSON.parse(JSON.stringify(SEED.pipelines.find((p) => p.id === id)));

const liveRecords = (file) => {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  return Array.isArray(raw.pipelines) ? raw.pipelines : Object.values(raw.pipelines || {});
};

const call = async (base, method, body) => {
  const res = await fetch(`${base}/api/pipelines`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* an error page is read as text by the assertion that failed */
  }
  return { status: res.status, json, text };
};

test("the catalogue route reads the full merged catalogue and refuses with validatePipeline's own findings", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wtgui-pipelines-route-"));
  const pipelinesFile = path.join(dir, "pipelines.json");
  const panel = await startPanel({
    dir,
    keep: true,
    config: {
      pipelinesFile,
      dataDir: path.join(dir, "data"),
      scratchDir: path.join(dir, "scratch"),
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
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  // (1) the read.
  const read = await call(panel.base, "GET");
  assert.equal(read.status, 200, read.text.slice(0, 300));
  assert.equal(read.json.version, 1);
  assert.equal(read.json.supported, 1);
  assert.ok(String(read.json.seedFile).endsWith("pipelines.seed.json"), `seedFile: ${read.json.seedFile}`);
  assert.ok(String(read.json.file).endsWith("pipelines.json"), `file: ${read.json.file}`);
  assert.deepEqual(read.json.kinds, ["local", "investigation", "turnover"]);
  assert.ok(Array.isArray(read.json.exitChecks) && read.json.exitChecks.includes("pr-merged"));
  assert.equal(read.json.pipelines.local.stages[0].id, "work");
  assert.ok(String(read.json.pipelines.local.stages[0].prompt).length > 20, "the full definition travels, not a summary");
  assert.equal(read.json.readOnly, false);
  // The PDL list rides the same answer: this panel was given no bundle, so it is a refusal of its OWN, and the ladder
  // above is untouched by it. (The list itself is pinned in test/pipeline-source.test.js against a real bundle.)
  assert.equal(read.json.pdl.ok, false);
  assert.equal(read.json.pdl.code, "missing");
  assert.deepEqual(read.json.pdl.pipelines, []);

  // (2) a valid save reaches the live file, and the answer is the catalogue again.
  const edit = seedDef("local");
  edit.title = "Local work (edited by the route test)";
  const saved = await call(panel.base, "PUT", { version: 1, pipelines: { local: edit } });
  assert.equal(saved.status, 200, saved.text.slice(0, 400));
  assert.equal(saved.json.ok, true);
  assert.equal(saved.json.state.pipelines.local.title, edit.title);
  assert.equal(liveRecords(pipelinesFile).find((p) => p.id === "local").title, edit.title, "the live file carries the edit");

  // (3) an unknown exit check is a 422 whose findings are the validator's sentences, and the file is untouched.
  const badCheck = seedDef("local");
  badCheck.stages[0].exit = { check: "not-a-check" };
  const refused = await call(panel.base, "PUT", { version: 1, pipelines: { local: badCheck } });
  assert.equal(refused.status, 422, refused.text.slice(0, 300));
  assert.ok(Array.isArray(refused.json.findings), "the findings are an array");
  assert.ok(
    refused.json.findings.some((f) => f.includes('exit.check "not-a-check" is not one of the closed vocabulary')),
    refused.json.findings.join("; "),
  );
  assert.equal(liveRecords(pipelinesFile).find((p) => p.id === "local").title, edit.title, "the refused document did not reach the file");

  // (4) an unknown placeholder is the same refusal, with the hole named.
  const hole = seedDef("local");
  hole.stages[0].prompt = "Do the work with {{nope}}.";
  const refusedHole = await call(panel.base, "PUT", { version: 1, pipelines: { local: hole } });
  assert.equal(refusedHole.status, 422);
  assert.ok(refusedHole.json.findings.some((f) => f.includes("unknown placeholder {{nope}}")), refusedHole.json.findings.join("; "));

  // (5) a chain may not go backwards — the target has to be in the same document for the rule to judge it.
  const back = seedDef("turnover");
  back.next = "local";
  const refusedChain = await call(panel.base, "PUT", { version: 1, pipelines: { turnover: back, local: seedDef("local") } });
  assert.equal(refusedChain.status, 422);
  assert.ok(refusedChain.json.findings.some((f) => f.includes("a chain may not go backwards")), refusedChain.json.findings.join("; "));

  // (6) a document naming a newer version is refused whole, not half-parsed.
  const newer = await call(panel.base, "PUT", { version: 2, pipelines: {} });
  assert.equal(newer.status, 409);
  assert.equal(newer.json.refused.supported, 1);

  // (7) a body that is not a document at all.
  const nonObject = await call(panel.base, "PUT", [1, 2, 3]);
  assert.equal(nonObject.status, 400);

  // (8) a save naming ONE definition merges over the live file's others.
  const inv = seedDef("investigate");
  inv.title = "Investigate (edited by the route test)";
  const savedInv = await call(panel.base, "PUT", { version: 1, pipelines: { investigate: inv } });
  assert.equal(savedInv.status, 200, savedInv.text.slice(0, 300));
  const ids = liveRecords(pipelinesFile).map((p) => p.id).sort();
  assert.deepEqual(ids, ["investigate", "local"], "the second save kept the first edit");
  const after = await call(panel.base, "GET");
  assert.equal(after.json.pipelines.investigate.title, inv.title);
  assert.equal(after.json.pipelines.local.title, edit.title);
});
