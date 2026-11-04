#!/usr/bin/env node
// The PIPELINE FLOW and its modal, in a real browser — the gate for `public/pipeline-flow.js` and
// `public/pipeline-modal.js` and for the two presses that open them.
//
//   node tools/verify-pipeline-flow.mjs                # this checkout
//   node tools/verify-pipeline-flow.mjs --shots <dir>  # where the screenshots go
//   node tools/verify-pipeline-flow.mjs --json <file>  # the raw ledger
//
// WHAT IS DRIVEN. A throwaway panel of its own (tools/panel-testkit.mjs: spare port, own PANEL_CONFIG / jobs store),
// a dead apiServer and the board assistant OFF so no gateway is called. Its state folder carries one studio bundle
// with five stages, one gate and one capped loop, and a queue with one row on stage 3 of that pipeline:
//
//   edit mode      Settings > Pipeline's dropdown selects a definition; `open the flow` opens the SAME dialog in edit
//                  mode. Every stage is drawn, every exit check is a notch, no mark is set (a definition has no
//                  position), and the dialog sits ABOVE the Settings window that opened it.
//   position mode  A queue row's ⇢ press opens it again, in position mode, from the task pipeline answer plus the
//                  bundle: the stages before the task's stage are done, its stage is current, the rest are not
//                  reached, the gate is a notch and the loop is one arc labelled with its cap and nothing else.
//   moving it      The preview's own select and checkbox move the DRAWING (nothing is written): another stage changes
//                  the marks, and `stage refused` turns that stage refused.
//   the modal      Escape closes it and leaves the Settings window open (one Esc, one surface); Tab cycles inside the
//                  card; a press on the backdrop closes it, a press inside does not; focus returns to the press that
//                  opened it.
//   reduced motion A second browser context asks for `prefers-reduced-motion: reduce`: the same drawing arrives with
//                  `data-motion="off"` and no animation on the current stage's mark.
//
// The console error count is printed as a count, and any page error fails the run. Exit: 0 held, 1 a check failed,
// 2 the run did not measure what it claims (no Playwright, no rows, no dialog).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPlaywright, notRun, openSettingsGroup, withBrowser } from "./browser.mjs";
import { freePort, startPanel } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const SHOTS = path.resolve(opt("--shots", path.join(os.tmpdir(), "wtgui-pipeline-flow")));
const JSON_OUT = opt("--json");

let checks = 0;
let failures = 0;
const out = { tree: TREE, checks: [], pageErrors: [], consoleErrors: [], errors: [] };
const check = (ok, label, detail = "") => {
  checks += 1;
  if (!ok) failures += 1;
  out.checks.push({ ok: Boolean(ok), label, detail: String(detail ?? "") });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};
const equal = (label, actual, expected) => check(JSON.stringify(actual) === JSON.stringify(expected), label, `got ${JSON.stringify(actual)}`);
const note = (text) => console.log(`      ${text}`);

// ---- the fixture -----------------------------------------------------------------------------------------------
const stage = (n, title) => ({
  id: `S${n}`,
  title,
  prompt: `Work stage ${n}: ${title}.`,
  artifact: { id: `artifact-${n}`, path: `out/${n}.json`, schema: "out/1", writer: `worker-${n}` },
});

const BUNDLE = {
  bundleVersion: 1,
  name: "poc-flow",
  pipelines: [
    {
      id: "poc-flow",
      title: "POC flow",
      stages: [stage(0, "Intake and charter"), stage(1, "Scope it"), stage(2, "Shape the contract"), stage(3, "Build it"), stage(4, "Hand it over")],
      gates: [
        {
          id: "g2",
          name: "contract signed",
          after: "S2",
          artifact: "artifact-2",
          decider: "reader",
          decision: { id: "d2", path: "decisions/2.json", schema: "decision/1", writer: "gate-2", outcomes: ["go", "no-go"] },
        },
      ],
      handoffs: [
        { id: "h1", from: "S0", to: "S1", artifact: "artifact-0", kind: "sequence" },
        { id: "h2", from: "S1", to: "S2", artifact: "artifact-1", kind: "sequence" },
        { id: "h3", from: "S2", to: "S3", artifact: "artifact-2", kind: "sequence" },
        { id: "h4", from: "S3", to: "S4", artifact: "artifact-3", kind: "sequence" },
        { id: "h5", from: "S4", to: "S2", artifact: "artifact-4", kind: "loop", cap: "2 rounds" },
      ],
    },
  ],
};

const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-pipeline-flow-"));
const logs = path.join(dir, "logs");
mkdirSync(path.join(logs, "assistants", "assistant-1"), { recursive: true });
mkdirSync(SHOTS, { recursive: true });
const bundleFile = path.join(logs, "pipeline-bundle.json");
writeFileSync(bundleFile, JSON.stringify(BUNDLE, null, 1), "utf8");

const ENTERED = new Date(Date.now() - 2.5 * 3_600_000).toISOString();
writeFileSync(
  path.join(logs, "assistants", "assistant-1", "queue.json"),
  JSON.stringify(
    { version: 3, nextId: 8, tasks: [{ id: 7, title: "carry the contract", state: "running", thread: null, threads: [], files: [], pipelineRun: { pipeline: "poc-flow", stage: "S3", enteredAt: ENTERED } }] },
    null,
    1,
  ),
  "utf8",
);

const pw = loadPlaywright();
if (!pw) {
  console.log(notRun("the pipeline flow was not exercised in a browser", "Playwright is not installed in this checkout (tools/browser.mjs could not load it)."));
  process.exit(2);
}

const port = await freePort();
const panel = await startPanel({
  dir,
  port,
  root: TREE,
  keep: true,
  config: {
    pipelineBundleFile: bundleFile,
    pipelinesFile: path.join(dir, "pipelines.json"),
    dataDir: path.join(dir, "data"),
    refreshSeconds: 3600,
    worktreeSeconds: 3600,
    midSeconds: 3600,
    dormantSeconds: 3600,
    slowSeconds: 3600,
    fetchSeconds: -1,
    projects: [],
    assistant: { enabled: false },
    apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
  },
});
note(`panel ${panel.base} on ${TREE}`);

const finish = async (code) => {
  await panel.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  if (JSON_OUT) writeFileSync(path.resolve(JSON_OUT), JSON.stringify(out, null, 1), "utf8");
  console.log(`\n${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ""}`);
  process.exit(code);
};

// The dialog's whole state, read from the DOM in one go: everything this gate asserts is on these elements.
const readModal = (page) =>
  page.evaluate(() => {
    const modal = document.getElementById("pipeline-modal");
    const card = document.getElementById("pipeline-modal-card");
    if (!modal || modal.hidden || !card) return null;
    const nodes = [...card.querySelectorAll(".pflow-node")].map((n) => ({ id: n.dataset.stage, mark: n.dataset.mark, title: n.querySelector(".pflow-title")?.textContent || "" }));
    const arc = card.querySelector(".pflow-arc");
    const track = card.querySelector(".pflow-track");
    const dot = card.querySelector('.pflow-node[data-mark="current"] .pflow-dot');
    const settings = document.getElementById("settings");
    const settingsZ = settings ? Number(getComputedStyle(settings).zIndex) : null;
    return {
      mode: modal.dataset.mode,
      motion: modal.dataset.motion,
      title: document.getElementById("pipeline-modal-title")?.textContent || "",
      sub: card.querySelector(".pmodal-sub")?.textContent || "",
      facts: card.querySelector(".pmodal-facts")?.textContent?.replace(/\s+/g, " ").trim() || "",
      note: card.querySelector(".pmodal-note")?.textContent || "",
      nodes,
      legend: [...card.querySelectorAll(".pflow-key")].map((k) => `${k.dataset.mark}:${(k.textContent || "").trim()}`),
      notches: [...card.querySelectorAll(".pflow-notch")].map((n) => n.dataset.gate),
      arcs: [...card.querySelectorAll(".pflow-arc")].map((a) => ({ cap: a.dataset.cap, from: a.dataset.from, to: a.dataset.to, label: (a.textContent || "").trim() })),
      arcAboveTrack: Boolean(arc && track && arc.getBoundingClientRect().bottom <= track.getBoundingClientRect().top + 1),
      zIndex: Number(getComputedStyle(modal).zIndex),
      settingsZ,
      locked: document.body.classList.contains("pipeline-modal-open"),
      focusInCard: card.contains(document.activeElement),
      active: `${document.activeElement?.tagName || ""}.${document.activeElement?.className || document.activeElement?.id || ""}`,
      animation: dot ? getComputedStyle(dot).animationName : null,
      preview: Boolean(card.querySelector("[data-pm-preview]")),
      stageOptions: [...card.querySelectorAll("[data-pm-stage] option")].map((o) => o.value),
    };
  });

const marks = (modal) => (modal ? modal.nodes.map((n) => `${n.id}:${n.mark}`) : []);
const openQueueFlow = async (page) => {
  await page.click('#as-queue .as-task[data-as-qrow="7"] [data-as-qflow]');
  await page.waitForFunction(
    () => {
      const modal = document.getElementById("pipeline-modal");
      return modal && !modal.hidden && modal.dataset.mode === "position" && modal.querySelectorAll(".pflow-node").length > 0;
    },
    null,
    { timeout: 20_000, polling: 60 },
  );
};

let browserRun = null;
try {
  browserRun = await withBrowser(async ({ page, pageErrors, consoleErrors }) => {
    page.setDefaultTimeout(20_000);
    await page.goto(panel.base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#job-prompt", { state: "visible", timeout: 30_000 });

    // ---- 1. edit mode, from the Pipeline tab ---------------------------------------------------------------
    console.log("\n== edit mode: the Pipeline tab's dropdown, the editor, and the flow it opens ==");
    await openSettingsGroup(page, "pipeline");
    await page.waitForFunction(() => {
      const el = document.getElementById("pipeline-summary");
      return el && !/reading/.test(el.textContent || "");
    }, null, { timeout: 20_000 });

    const catalogue = await page.evaluate(async () => (await fetch("/api/pipelines")).json());
    const ids = Object.keys(catalogue.pipelines || {});
    const options = await page.$$eval("#pipeline-select option", (els) => els.map((el) => el.value));
    equal("the dropdown carries every definition the catalogue holds", options, ids);
    check(options.length >= 3, "and the seed's built-ins are among them", options.join(", "));

    // A definition with more than one stage, so the sequence and its notches are both visible.
    const multi = ids.find((id) => (catalogue.pipelines[id].stages || []).length > 1) || ids[0];
    await page.selectOption("#pipeline-select", multi);
    await page.waitForSelector("#pipeline-editor:not([hidden]) .pipeline-stage", { timeout: 15_000 });
    const editorFor = await page.evaluate(() => document.querySelector("#pipeline-editor .pipeline-editor-head")?.textContent?.replace(/\s+/g, " ") || "");
    check(editorFor.includes(multi), "the editor edits the definition the dropdown names", editorFor);

    await page.click("#pipeline-flow-open");
    await page.waitForSelector("#pipeline-modal:not([hidden]) .pflow-node");
    const edit = await readModal(page);
    check(Boolean(edit), "the flow modal opened from the Pipeline tab");
    check(edit.mode === "edit", "it is in edit mode", edit.mode);
    check(edit.title === (catalogue.pipelines[multi].title || multi), "it names the definition", edit.title);
    equal("every stage of the definition is drawn, in order", edit.nodes.map((n) => n.id), catalogue.pipelines[multi].stages.map((s) => s.id));
    equal("a definition has no position, so every stage is not reached", edit.nodes.map((n) => n.mark), catalogue.pipelines[multi].stages.map(() => "not-reached"));
    equal("every stage's exit check is a notch on the connector after it", edit.notches, catalogue.pipelines[multi].stages.map((s) => `exit:${s.id}`));
    check(!edit.preview, "and there is no position preview to move");
    check(edit.zIndex > edit.settingsZ, "the dialog is above the Settings window that opened it", `modal ${edit.zIndex} > settings ${edit.settingsZ}`);
    check(edit.locked, "the page behind it is locked");
    check(edit.focusInCard, "the dialog took the caret", edit.active);
    await page.screenshot({ path: path.join(SHOTS, "edit-mode.png") });

    // One Esc, one surface: the dialog closes and Settings stays open.
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("pipeline-modal").hidden === true, null, { timeout: 5_000 });
    const afterEsc = await page.evaluate(() => ({
      closed: document.getElementById("pipeline-modal").hidden,
      settingsOpen: !document.getElementById("settings").classList.contains("hidden"),
      focus: `${document.activeElement?.tagName || ""}.${document.activeElement?.id || document.activeElement?.className || ""}`,
      locked: document.body.classList.contains("pipeline-modal-open"),
    }));
    check(afterEsc.closed, "Escape closes the dialog");
    check(afterEsc.settingsOpen, "and does NOT close the Settings window behind it");
    check(/pipeline-flow-open/.test(afterEsc.focus), "focus goes back to the control that opened it", afterEsc.focus);
    check(!afterEsc.locked, "and the page is unlocked");

    // A press on the backdrop closes; a press inside the card does not.
    await page.click("#pipeline-flow-open");
    await page.waitForSelector("#pipeline-modal:not([hidden])");
    await page.click("#pipeline-modal-card .pmodal-body", { position: { x: 30, y: 20 } });
    check(!(await page.evaluate(() => document.getElementById("pipeline-modal").hidden)), "a press inside the card leaves it open");
    await page.mouse.click(8, 8);
    await page.waitForFunction(() => document.getElementById("pipeline-modal").hidden === true, null, { timeout: 5_000 });
    check(true, "a press on the backdrop closes it");

    // ---- 2. position mode, from a queue row -----------------------------------------------------------------
    console.log("\n== position mode: a queue row's press, the marks, and the loop's cap ==");
    const route = await page.evaluate(async () => {
      const r = await fetch("/api/assistant/task-pipeline?assistantId=assistant-1&task=7");
      return { status: r.status, body: await r.json() };
    });
    check(route.status === 200 && route.body.mode === "pipeline", "the task's own answer says it is on a pipeline", `${route.status} ${route.body.mode}`);

    await page.click("#btn-settings");
    await page.click("#btn-assistant");
    await page.waitForSelector("#assistant:not([hidden])");
    await page.click('#as-subtabs [data-as-subtab="queue"]');
    await page.waitForSelector("#as-queue:not(.hidden)");
    await page.waitForFunction(() => document.querySelectorAll("#as-queue .as-task").length === 1, null, { timeout: 20_000 });
    const press = await page.$eval('#as-queue .as-task[data-as-qrow="7"] [data-as-qflow]', (b) => ({ title: b.getAttribute("title") || "", own: b.dataset.asQown, task: b.dataset.asQflow }));
    check(Boolean(press.title) && press.own === "assistant-1" && press.task === "7", "the queue row carries the flow press", JSON.stringify(press));

    await openQueueFlow(page);
    const pos = await readModal(page);
    check(pos.mode === "position", "the same dialog is in position mode", pos.mode);
    check(/4 of 5/.test(pos.sub), "its subtitle says where the task is", pos.sub);
    equal("the five stages are drawn left to right", pos.nodes.map((n) => n.id), ["S0", "S1", "S2", "S3", "S4"]);
    equal("three done, one current, one not reached", marks(pos), ["S0:done", "S1:done", "S2:done", "S3:current", "S4:not-reached"]);
    equal("the legend counts the four marks", pos.legend, ["not-reached:not reached 1", "current:current 1", "done:done 3", "refused:refused"]);
    equal("the gate that ends S2 is one notch", pos.notches, ["g2"]);
    equal("the capped loop is one arc, labelled with its cap only", pos.arcs, [{ cap: "2 rounds", from: "S4", to: "S2", label: "2 rounds" }]);
    check(pos.arcAboveTrack, "and it is drawn above the track, not over the stages");
    check(/2 rounds/.test(pos.note) === false, "the cap is on the arc, not repeated in the note");
    check(pos.preview, "the position preview is offered");
    equal("the preview lists every stage", pos.stageOptions, ["S0", "S1", "S2", "S3", "S4"]);
    await page.screenshot({ path: path.join(SHOTS, "position-mode.png") });

    // ---- 3. moving the position -----------------------------------------------------------------------------
    console.log("\n== moving it: the preview moves the drawing and writes nothing ==");
    await page.selectOption("[data-pm-stage]", "S1");
    await page.waitForTimeout(150);
    const moved = await readModal(page);
    equal("S1 is now the current stage", marks(moved), ["S0:done", "S1:current", "S2:not-reached", "S3:not-reached", "S4:not-reached"]);
    equal("the legend followed", moved.legend, ["not-reached:not reached 3", "current:current 1", "done:done 1", "refused:refused"]);

    await page.click(".pmodal-check input[data-pm-refused]");
    await page.waitForTimeout(150);
    const refused = await readModal(page);
    equal("`stage refused` marks that stage refused", marks(refused), ["S0:done", "S1:refused", "S2:not-reached", "S3:not-reached", "S4:not-reached"]);
    equal("and the legend says one refused", refused.legend, ["not-reached:not reached 3", "current:current", "done:done 1", "refused:refused 1"]);
    const queueOnDisk = JSON.parse(readFileSync(path.join(logs, "assistants", "assistant-1", "queue.json"), "utf8"));
    check(queueOnDisk.tasks[0].pipelineRun.stage === "S3", "nothing was written: the record still says S3", queueOnDisk.tasks[0].pipelineRun.stage);
    await page.screenshot({ path: path.join(SHOTS, "refused.png") });

    // ---- 4. the modal's own behaviour ----------------------------------------------------------------------
    console.log("\n== the modal: Tab stays inside, Escape closes, focus comes back ==");
    const inside = new Set();
    for (let i = 0; i < 10; i += 1) {
      await page.keyboard.press("Tab");
      inside.add(
        await page.evaluate(() => {
          const card = document.getElementById("pipeline-modal-card");
          return card.contains(document.activeElement) ? "in" : `out:${document.activeElement?.tagName}`;
        }),
      );
    }
    equal("ten tabs never leave the card", [...inside], ["in"]);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("pipeline-modal").hidden === true, null, { timeout: 5_000 });
    check(true, "Escape closes it");
    const back = await page.evaluate(() => `${document.activeElement?.tagName}.${document.activeElement?.dataset?.asQflow ? "as-qflow" : document.activeElement?.className || ""}`);
    check(/as-qflow/.test(back), "and hands the caret back to the queue row's flow press", back);

    // ---- 5. reduced motion ----------------------------------------------------------------------------------
    console.log("\n== reduced motion: the same drawing, no animation ==");
    await openQueueFlow(page);
    const still = await readModal(page);
    check(still.motion === "on", "the normal context draws with motion", still.motion);
    check(still.animation === "pflow-breathe", "and the current stage's mark animates", String(still.animation));
    await page.keyboard.press("Escape");

    out.pageErrors.push(...pageErrors);
    out.consoleErrors.push(...consoleErrors);
    check(pageErrors.length === 0, "no page error", pageErrors.slice(0, 3).join(" | "));
    check(consoleErrors.length === 0, `no console error (${consoleErrors.length} recorded)`, consoleErrors.slice(0, 3).join(" | "));
    return failures;
  }, { viewport: { width: 1500, height: 1000 }, contextOptions: {} });

  // A second context, asking for less motion. The dialog and the drawing are the same; the animation is not.
  const reduced = await withBrowser(async ({ page, pageErrors }) => {
    page.setDefaultTimeout(20_000);
    await page.goto(panel.base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#job-prompt", { state: "visible", timeout: 30_000 });
    await page.click("#btn-assistant");
    await page.waitForSelector("#assistant:not([hidden])");
    await page.click('#as-subtabs [data-as-subtab="queue"]');
    await page.waitForSelector("#as-queue:not(.hidden)");
    await page.waitForFunction(() => document.querySelectorAll("#as-queue .as-task").length === 1, null, { timeout: 20_000 });
    await openQueueFlow(page);
    const reducedState = await readModal(page);
    check(reducedState.motion === "off", "the dialog is told the reader asked for less motion", reducedState.motion);
    const flowMotion = await page.evaluate(() => document.querySelector("#pipeline-modal .pflow")?.dataset.motion);
    check(flowMotion === "off", "and so is the drawing", flowMotion);
    check(reducedState.animation === "none", "the current stage's mark does not animate", String(reducedState.animation));
    equal("the marks are the same drawing", marks(reducedState), ["S0:done", "S1:done", "S2:done", "S3:current", "S4:not-reached"]);
    await page.screenshot({ path: path.join(SHOTS, "reduced-motion.png") });
    check(pageErrors.length === 0, "no page error in the reduced-motion context", pageErrors.slice(0, 3).join(" | "));
    return failures;
  }, { viewport: { width: 1500, height: 1000 }, contextOptions: { reducedMotion: "reduce" } });

  if (browserRun == null || reduced == null) throw new Error("a browser run returned no verdict");
} catch (e) {
  failures += 1;
  out.errors.push(String((e && e.stack) || e));
  console.log(`FAIL  the run threw: ${String((e && e.stack) || e).split("\n").slice(0, 6).join("\n      ")}`);
} finally {
  console.log(`\nSCREENSHOTS  ${SHOTS}`);
  console.log(`CONSOLE      page errors ${out.pageErrors.length}, console errors ${out.consoleErrors.length}`);
  await finish(failures ? 1 : 0);
}
