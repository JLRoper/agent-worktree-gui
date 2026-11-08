#!/usr/bin/env node
// tools/verify-pipeline-catalogue.mjs — the bundle's several pipelines, from the route to the dropdown to the record.
//
// HARNESS: LIVE GATE. It boots the real panel against a sandbox whose bundle file is the SHIPPED SEED, and drives the
// real task pipeline window in Chromium. Nothing here is a fixture written to suit the control: the seed is
// pipeline-bundle.seed.json, copied, so the pipeline ids, their stage counts and their stage names are the reader's.
//
// What it proves, in the order the request names them:
//
//   1. GET /api/assistant/pipeline-catalogue lists EVERY pipeline in the bundle with its own stage count — the four
//      studio pipelines first, then the seven ladders the seed carries as PDL documents, each count equal to its
//      stages[] length;
//   2. the pipeline window's PIPELINE select offers all of them, by title and id;
//   3. choosing a 2-stage pipeline fills STARTING STAGE from THAT pipeline's stages (not from the first, not from the
//      largest), and choosing another one re-fills it again;
//   4. the assignment press writes the record: the queue file on disk carries `pipelineRun` naming the chosen pipeline
//      and its stage, and the window re-reads as "2 of 2".
//   5. the Settings pipeline tab's PDL list is the SAME list the catalogue route serves, id for id and count for
//      count, with the ladder catalogue beside it reading its own (empty) size - the ladder seed ships no definition
//      since the seven moved into the bundle, and the row says "0 definitions" without hiding the eleven.
//
//   node tools/verify-pipeline-catalogue.mjs            assert; exit 0 green, 1 red
//   node tools/verify-pipeline-catalogue.mjs --quiet    only failures + the final line
//
// Exit codes: 0 pass; 1 a failed assertion; 2 the browser half could not run (no Playwright).
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPlaywright, openSettingsGroup } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const pw = loadPlaywright();
if (!pw) {
  console.log("BROWSER-HALF-NOT-RUN  the pipeline catalogue was not exercised in a browser.");
  console.log("  re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-pipeline-catalogue.mjs");
  process.exit(2);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEED = path.join(ROOT, "pipeline-bundle.seed.json");
const quiet = process.argv.includes("--quiet");

let checks = 0;
let failures = 0;
const check = (ok, label, detail = "") => {
  checks += 1;
  if (!ok) failures += 1;
  if (!ok || !quiet) console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  [${detail}]` : ""}`);
};

const dir = mkdtempSync(path.join(tmpdir(), "wtgui-catalogue-"));
const logs = path.join(dir, "logs");
const queueDir = path.join(logs, "assistants", "assistant-1");
mkdirSync(queueDir, { recursive: true });
const bundleFile = path.join(logs, "pipeline-bundle.json");
copyFileSync(SEED, bundleFile);
const queueFile = path.join(queueDir, "queue.json");
writeFileSync(queueFile, JSON.stringify({ version: 3, nextId: 2, tasks: [{ id: 1, title: "draft something on a small pipeline", state: "queued", files: [], pipelineRun: null }] }, null, 1), "utf8");

const browser = await pw.chromium.launch({ headless: true });
let panel = null;
try {
  panel = await startPanel({
    dir,
    keep: true,
    config: {
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
      pipelineBundleFile: bundleFile,
    },
  });

  // ---- 1. the catalogue lists every pipeline, each with its stage count -------------------------------
  const res = await fetch(`${panel.base}/api/assistant/pipeline-catalogue`);
  const catalogue = await res.json();
  check(res.status === 200, "the catalogue answers 200", String(res.status));
  check(catalogue.ok === true, "the seed bundle is readable", catalogue.reason || "");
  const listed = (catalogue.pipelines || []).map((p) => ({ id: p.id, title: p.title, count: p.stageCount, stages: p.stages.length }));
  check(listed.length === 11, "the catalogue lists the bundle's eleven pipelines", listed.map((p) => `${p.id}:${p.count}`).join(", "));
  check(
    listed.every((p) => p.count === p.stages && p.count >= 1),
    "every pipeline carries a stage count that is its stages[] length",
    listed.map((p) => `${p.id}:${p.count}/${p.stages}`).join(", "),
  );
  const byId = new Map(listed.map((p) => [p.id, p]));
  check(byId.get("poc-to-uat")?.count === 13, "the large studio pipeline is still there at 13 stages", String(byId.get("poc-to-uat")?.count));
  check(byId.get("ping-pong")?.count === 2, "the ping-pong pipeline is 2 stages", String(byId.get("ping-pong")?.count));
  check(byId.get("probe-fix")?.count === 2, "the probe-then-fix pipeline is 2 stages", String(byId.get("probe-fix")?.count));
  check(byId.get("author-review-revise")?.count === 3, "the author-review-revise pipeline is 3 stages", String(byId.get("author-review-revise")?.count));
  // The seven ladders the conversion moved into the bundle: still here, each on its own document.
  check(byId.get("local")?.count === 1, "the local ladder is 1 stage", String(byId.get("local")?.count));
  check(byId.get("investigate")?.count === 2, "the investigation ladder is 2 stages", String(byId.get("investigate")?.count));
  check(byId.get("turnover")?.count === 3, "the turnover ladder is 3 stages", String(byId.get("turnover")?.count));
  check(byId.get("sefl-review-loop")?.count === 7, "the SEFL review loop is 7 stages", String(byId.get("sefl-review-loop")?.count));

  // ---- 2. the window's PIPELINE select offers all of them ---------------------------------------------
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(panel.base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#btn-settings", { timeout: 30_000 });
  await openSettingsGroup(page, "bundles");
  await page.waitForSelector('#bundle-tasks [data-bundle-task-id="1"]', { timeout: 20_000 });
  await page.click('[data-bundle-task-id="1"]');
  // Wait for the ANSWER, not the frame: the dialog paints "reading…" first.
  await page.waitForFunction(
    () => {
      const card = document.getElementById("pipew-card");
      const mode = card && card.dataset.pipewMode;
      return Boolean(mode) && mode !== "reading";
    },
    null,
    { timeout: 20_000, polling: 60 },
  );

  const options = await page.evaluate(() => {
    const pipe = document.querySelector("select[data-pipew-pipe]");
    const stage = document.querySelector("select[data-pipew-stage]");
    return {
      mode: document.getElementById("pipew-card")?.dataset.pipewMode,
      pipes: pipe ? [...pipe.options].map((o) => ({ value: o.value, text: o.textContent.trim() })) : null,
      stages: stage ? [...stage.options].map((o) => ({ value: o.value, text: o.textContent.trim(), selected: o.selected })) : null,
    };
  });
  check(options.mode === "assistant-decides", "the task starts on the default path", String(options.mode));
  check(options.pipes?.length === 11, "the PIPELINE select offers every pipeline in the bundle", String(options.pipes?.length));
  check(
    ["poc-to-uat", "ping-pong", "probe-fix", "author-review-revise", "local", "investigate", "turnover", "github-investigate", "sefl-investigate", "github-force-merge", "sefl-review-loop"].every((id) => options.pipes?.some((o) => o.value === id)),
    "and each pipeline is offered by its id",
    (options.pipes || []).map((o) => o.value).join(", "),
  );
  check(/Ping-pong/.test(options.pipes?.find((o) => o.value === "ping-pong")?.text || ""), "the option names the pipeline's title too", options.pipes?.find((o) => o.value === "ping-pong")?.text);

  // ---- 3. choosing a 2-stage pipeline fills STARTING STAGE from ITS OWN stages -------------------------
  await page.selectOption("select[data-pipew-pipe]", "ping-pong");
  await page.waitForFunction(
    () => {
      const stage = document.querySelector("select[data-pipew-stage]");
      return Boolean(stage) && [...stage.options].some((o) => o.value === "critique");
    },
    null,
    { timeout: 10_000, polling: 50 },
  );
  const pingStages = await page.evaluate(() => [...document.querySelector("select[data-pipew-stage]").options].map((o) => ({ value: o.value, text: o.textContent.trim(), selected: o.selected })));
  check(pingStages.map((o) => o.value).join(",") === "draft,critique", "the starting stage list is the ping-pong pipeline's own two stages", pingStages.map((o) => o.value).join(","));
  check(pingStages[0]?.text === "1. Draft" && pingStages[1]?.text === "2. Critique", "each option carries its 1-based position and its title", pingStages.map((o) => o.text).join(" | "));
  check(pingStages[0]?.selected === true, "the first stage is selected for a pipeline the task was not on", JSON.stringify(pingStages.map((o) => o.selected)));

  // Choosing a 3-stage one re-fills the list from THAT pipeline — an id the last one does not hold is dropped.
  await page.selectOption("select[data-pipew-pipe]", "author-review-revise");
  await page.waitForFunction(
    () => {
      const stage = document.querySelector("select[data-pipew-stage]");
      return Boolean(stage) && [...stage.options].some((o) => o.value === "revise");
    },
    null,
    { timeout: 10_000, polling: 50 },
  );
  const authorStages = await page.evaluate(() => [...document.querySelector("select[data-pipew-stage]").options].map((o) => o.value));
  check(authorStages.join(",") === "author,review,revise", "choosing another pipeline re-fills the stage list from it", authorStages.join(","));

  // ---- 4. assigning writes the record, and the window reads "2 of 2" ----------------------------------
  await page.selectOption("select[data-pipew-pipe]", "ping-pong");
  await page.selectOption("select[data-pipew-stage]", "critique");
  await page.click("[data-pipew-apply]");
  await page.waitForFunction(
    () => {
      const card = document.getElementById("pipew-card");
      return Boolean(card) && card.dataset.pipewMode === "pipeline" && /2 of 2/.test(card.textContent || "");
    },
    null,
    { timeout: 20_000, polling: 60 },
  );
  const windowText = await page.evaluate(() => (document.getElementById("pipew-card")?.textContent || "").replace(/\s+/g, " ").trim());
  check(/Ping-pong/.test(windowText) && /2 of 2/.test(windowText), "the window draws the chosen pipeline at 2 of 2", windowText.slice(0, 180));
  check(/Critique/.test(windowText), "and names the stage the record was put on", windowText.slice(0, 180));

  const onDisk = JSON.parse(readFileSync(queueFile, "utf8"));
  const run = onDisk.tasks.find((t) => t.id === 1)?.pipelineRun;
  check(run && run.pipeline === "ping-pong" && run.stage === "critique", "the queue file carries the assignment", JSON.stringify(run));
  check(run && Number.isFinite(Date.parse(run.enteredAt)), "with a real UTC stamp", run?.enteredAt);

  // ---- 5. Settings > Bundles: an imported studio export APPENDS, and a duplicate is refused by name ----
  await page.keyboard.press("Escape");
  const exportFile = path.join(dir, "someone-elses-export.json");
  writeFileSync(
    exportFile,
    JSON.stringify(
      {
        version: 1,
        project: { id: "review-two", name: "Review two", description: "A two-stage review, imported." },
        roles: [
          { id: "checker", name: "Checker", kind: "agent", instructions: "check it" },
          { id: "signer", name: "Signer", kind: "seat", instructions: "sign it" },
        ],
        stages: [
          { id: "check", title: "Check", owner: { kind: "agent", role: "checker" }, artifact: { id: "check-report", path: "ledger/review-two/check.md", schema: "check/1", writer: "checker" } },
          { id: "sign", title: "Sign", owner: { kind: "seat", role: "signer" }, artifact: { id: "signed", path: "ledger/review-two/signed.md", schema: "signed/1", writer: "signer" } },
        ],
        handoffs: [{ id: "H-01", from: "check", to: "sign", artifact: "check-report", kind: "sequence" }],
        gates: [],
      },
      null,
      1,
    ),
    "utf8",
  );
  const rowCount = () => page.evaluate(() => document.querySelectorAll("#bundle-list [data-bundle-pipeline]").length);
  const noteText = () => page.evaluate(() => (document.getElementById("bundle-import-note")?.textContent || "").trim());
  await page.setInputFiles("#bundle-import-file", exportFile);
  await page.waitForFunction(() => /imported/i.test(document.getElementById("bundle-import-note")?.textContent || ""), null, { timeout: 20_000, polling: 60 });
  const importedNote = await noteText();
  check(/now holds 12 pipelines/.test(importedNote), "the tab says what the import added and how many the bundle now holds", importedNote);
  check((await rowCount()) === 12, "the pipeline list grew to twelve rows", String(await rowCount()));

  // The same document twice: the route refuses the duplicate id by name, the tab prints the code, nothing is added.
  await page.setInputFiles("#bundle-import-file", exportFile);
  await page.waitForFunction(() => /duplicate-id|already/i.test(document.getElementById("bundle-import-note")?.textContent || ""), null, { timeout: 20_000, polling: 60 });
  const refusedNote = await noteText();
  check(/duplicate-id/.test(refusedNote), "a second import of the same id is refused with the route's code", refusedNote.slice(0, 200));
  check(/"review-two"/.test(refusedNote), "and the refusal names the pipeline id", refusedNote.slice(0, 200));
  check((await rowCount()) === 12, "nothing was added by the refused import", String(await rowCount()));

  // ---- 6. Settings > Pipeline lists the SAME pipelines the picker offers ------------------------------
  // The tab and the picker were two different sets ("the pipelines" meant the ladder on one surface and the PDL
  // bundle on the other). Both answers now come from lib/pipeline-source.js, so the tab's PDL list and the
  // catalogue route must be the same ids, in the same order, with the same counts.
  await page.keyboard.press("Escape");
  await openSettingsGroup(page, "pipeline");
  await page.waitForFunction(() => document.querySelectorAll("#pipeline-pdl-list [data-pdl-pipeline]").length > 0, null, { timeout: 20_000, polling: 60 });
  const tab = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#pipeline-pdl-list [data-pdl-pipeline]")];
    return {
      ids: rows.map((r) => r.getAttribute("data-pdl-pipeline")),
      units: rows.map((r) => (r.querySelector(".settings-unit")?.textContent || "").trim()),
      summary: (document.getElementById("pipeline-pdl-summary")?.textContent || "").trim(),
      source: (document.getElementById("pipeline-pdl-source")?.textContent || "").trim(),
      ladder: (document.getElementById("pipeline-summary")?.textContent || "").trim(),
      ladderRows: [...document.querySelectorAll("#pipeline-select option")].length,
      ladderValues: [...document.querySelectorAll("#pipeline-select option")].map((o) => o.value),
    };
  });
  const afterImport = await (await fetch(`${panel.base}/api/assistant/pipeline-catalogue`)).json();
  const routeIds = (afterImport.pipelines || []).map((p) => p.id);
  check(
    tab.ids.join(",") === routeIds.join(","),
    "the Settings pipeline tab lists exactly the catalogue route's pipelines, in order",
    `${tab.ids.join(",")} vs ${routeIds.join(",")}`,
  );
  check(tab.ids.length === 12, "the tab shows the twelve pipelines the bundle holds after the import", tab.ids.join(","));
  // The name is the FIRST pipeline's project name once a wrapper has been re-imported (lib/pipeline-bundle-import.js
  // keeps a live name only from a parsed document, and the route hands it the raw text), so the check pins the count
  // and the name the file answers with today rather than inventing a rename.
  check(/12 pipelines/.test(tab.summary) && /POC to UAT/.test(tab.summary), "the tab's summary counts them and names the bundle", tab.summary);
  check(/pipeline-bundle\.json/.test(tab.source), "and its source line names the file the panel reads", tab.source);
  check(/12 pipelines/.test(tab.summary) && tab.units.every((u) => /^\d+ stage/.test(u)), "each row carries its own stage count", tab.units.join(" | "));
  check(tab.ids.includes("review-two"), "the pipeline the import added is in the tab as well as in the picker", tab.ids.join(","));
  // The ladder seed ships EMPTY by design (the seven definitions are PDL documents in the bundle now), so its row
  // reads zero and the dropdown's twelve options are all PDL. A control that counted the ladder alone is what said
  // "0 pipelines" beside a bundle holding eleven.
  check(/0 definitions/.test(tab.ladder), "the ladder catalogue reads its own empty size beside the bundle", tab.ladder);
  check(
    tab.ladderRows === 12 && tab.ladderValues.every((value) => value.startsWith("pdl:")),
    "the dropdown's twelve options are the twelve PDL pipelines - no ladder definition is offered, because none ships",
    `${tab.ladderRows} options`,
  );

  check(pageErrors.length === 0, "no page error while the window and the tab were driven", pageErrors.slice(0, 2).join(" | "));
  await page.close();
} finally {
  try {
    await browser.close();
  } catch {
    /* already closed */
  }
  if (panel) await panel.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

console.log(`${checks - failures} passed, ${failures} failed — the bundle's several pipelines proven end to end`);
process.exit(failures ? 1 : 0);
