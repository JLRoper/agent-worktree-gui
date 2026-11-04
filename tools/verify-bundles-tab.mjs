#!/usr/bin/env node
// Settings > Bundles in a real browser: the imported bundle's pipelines listed, the loader's own refusal code when the
// bundle is broken, and a queue task on the default path reading "assistant decides" rather than "unassigned".
//
//   node tools/verify-bundles-tab.mjs
//
// HARNESS: LIVE GATE
//
// RED PROOF. Run this file in a `git archive` export of a build without the tab and it fails on the first check — there
// is no [data-settings-tab="bundles"]. It prints BROWSER-HALF-NOT-RUN and exits 2 when Playwright is absent, rather than
// passing a half that never ran.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright, openSettingsGroup } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const pw = loadPlaywright();
if (!pw) {
  console.log("BROWSER-HALF-NOT-RUN  Settings > Bundles was not exercised in a browser.");
  console.log("  re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-bundles-tab.mjs");
  process.exit(2);
}

let checks = 0;
let failures = 0;
const check = (ok, label, detail = "") => {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  [${detail}]` : ""}`);
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "test", "fixtures", "bundles");
const VALID = path.join(FIXTURES, "valid-bundle.json");
const DANGLING = path.join(FIXTURES, "dangling-gate-bundle.json");
const NOT_A_BUNDLE = path.join(FIXTURES, "not-a-bundle.json");

const browser = await pw.chromium.launch({ headless: true });

// One panel per scenario: a fresh sandbox makes the bundle file under test the only variable. Each is stopped and its
// directory removed in the finally block, so a failing check never leaves a panel running.
const sandboxes = [];
const boot = async ({ bundle, queue = null, label = "" } = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), "wtgui-bundles-tab-"));
  const logs = path.join(dir, "logs");
  mkdirSync(logs, { recursive: true });
  const bundleFile = path.join(logs, "pipeline-bundle.json");
  if (bundle) copyFileSync(bundle, bundleFile);
  if (queue) {
    const qdir = path.join(logs, "assistants", "assistant-1");
    mkdirSync(qdir, { recursive: true });
    writeFileSync(path.join(qdir, "queue.json"), JSON.stringify(queue, null, 1), "utf8");
  }
  const panel = await startPanel({
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
  sandboxes.push({ dir, panel });
  return { dir, panel, bundleFile, label };
};

const read = async (page) => {
  return page.evaluate(() => {
    const panel = document.getElementById("settings-panel-bundles");
    const summary = document.getElementById("bundle-summary");
    const source = document.getElementById("bundle-source");
    const rows = [...document.querySelectorAll("#bundle-list [data-bundle-pipeline]")].map((el) => ({
      id: el.dataset.bundlePipeline,
      text: (el.textContent || "").replace(/\s+/g, " ").trim(),
    }));
    const tasks = [...document.querySelectorAll("#bundle-tasks [data-bundle-task-id]")].map((el) => ({
      id: el.dataset.bundleTaskId,
      text: (el.textContent || "").replace(/\s+/g, " ").trim(),
    }));
    const tasksSummary = document.getElementById("bundle-tasks-summary");
    return {
      summary: summary ? summary.textContent : null,
      summaryBad: summary ? summary.classList.contains("bad") : null,
      source: source ? source.textContent : null,
      sourceBad: source ? source.classList.contains("bad") : null,
      rows,
      tasks,
      tasksSummary: tasksSummary ? tasksSummary.textContent : null,
      tasksBad: tasksSummary ? tasksSummary.classList.contains("bad") : null,
      panelShown: panel ? !panel.hidden : null,
    };
  });
};

// A row's tooltip carries the sentence a reader gets on hover; the row's own text carries the assignment. The press
// opens the task pipeline window — that press is the NEXT check, on the Queue pane's window, not a second control here.
const pressTask = async (page, id, mode = null) => {
  await page.click(`[data-bundle-task-id="${id}"]`);
  // Wait for the ANSWER, not the frame: the dialog paints "reading…" at once and fills in when the model lands. A mode
  // of "reading" is the press's first paint, not an answer.
  await page.waitForFunction(
    (want) => {
      const card = document.getElementById("pipew-card");
      if (!card) return false;
      const got = card.dataset.pipewMode || "";
      return got && got !== "reading" && (!want || got === want);
    },
    mode,
    { timeout: 15_000, polling: 60 },
  );
};

try {
  // ---- 1. a readable bundle lists its pipelines -----------------------------------------------------------
  const ok = await boot({ bundle: VALID, label: "valid" });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(ok.panel.base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#btn-settings", { timeout: 30_000 });
  await openSettingsGroup(page, "bundles");
  await page.waitForFunction(
    () => {
      const el = document.getElementById("bundle-summary");
      return el && !/reading/i.test(el.textContent || "");
    },
    null,
    { timeout: 20_000 },
  );
  const listed = await read(page);
  check(listed.panelShown === true, "the Bundles tab's panel is on screen", String(listed.panelShown));
  check(/^1 pipeline/.test(listed.summary || ""), "the summary names the bundle's pipeline count", listed.summary);
  check(listed.summaryBad === false, "a readable bundle is not marked bad", String(listed.summaryBad));
  check(listed.rows.length === 1, "the list carries the one pipeline the studio bundle holds", `${listed.rows.length} rows`);
  check(listed.rows[0]?.id === "poc-to-uat", "the row names the pipeline's id", listed.rows[0]?.id);
  check(/13 stages/.test(listed.rows[0]?.text || ""), "the row says how many stages it holds", listed.rows[0]?.text);
  check(/pipeline-bundle\.json/.test(listed.source || ""), "the source line names the file that was read", String(listed.source || "").slice(0, 120));
  check(!/reading/i.test(listed.summary || ""), "the summary stopped reading", listed.summary);
  await page.close();

  // ---- 2. a broken bundle shows the LOADER's code, not a generic error ------------------------------------
  const broken = await boot({ bundle: DANGLING, label: "dangling" });
  const page2 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const pageErrors2 = [];
  page2.on("pageerror", (e) => pageErrors2.push(String(e)));
  await page2.goto(broken.panel.base, { waitUntil: "domcontentloaded" });
  await page2.waitForSelector("#btn-settings", { timeout: 30_000 });
  await openSettingsGroup(page2, "bundles");
  await page2.waitForFunction(
    () => {
      const el = document.getElementById("bundle-summary");
      return el && /refused/i.test(el.textContent || "");
    },
    null,
    { timeout: 20_000 },
  );
  const refused = await read(page2);
  check(/refused — dangling-reference/.test(refused.summary || ""), "the summary carries the loader's refusal code", refused.summary);
  check(refused.summaryBad === true, "and the row is marked bad", String(refused.summaryBad));
  check(/gates\[0\]/.test(refused.source || ""), "the sentence names the locator in the exported file", String(refused.source || "").slice(0, 160));
  check(refused.rows.length === 0, "no pipeline row is drawn from a refused bundle", `${refused.rows.length} rows`);
  check(pageErrors2.length === 0, "no page error from a refused bundle", pageErrors2.slice(0, 2).join(" | "));
  await page2.close();

  // ---- 3. JSON that is not a bundle is refused as not-a-bundle --------------------------------------------
  const nope = await boot({ bundle: NOT_A_BUNDLE, label: "not-a-bundle" });
  const page3 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const pageErrors3 = [];
  page3.on("pageerror", (e) => pageErrors3.push(String(e)));
  await page3.goto(nope.panel.base, { waitUntil: "domcontentloaded" });
  await page3.waitForSelector("#btn-settings", { timeout: 30_000 });
  await openSettingsGroup(page3, "bundles");
  await page3.waitForFunction(
    () => {
      const el = document.getElementById("bundle-summary");
      return el && /refused/i.test(el.textContent || "");
    },
    null,
    { timeout: 20_000 },
  );
  const shape = await read(page3);
  check(/refused — not-a-bundle/.test(shape.summary || ""), "an object that is not a bundle gets its own code", shape.summary);
  check(shape.rows.length === 0, "and nothing is listed from it", `${shape.rows.length} rows`);
  await page3.close();

  // ---- 4. a queue task with no assignment reads as the default path, not "unassigned" ---------------------
  const withTask = await boot({
    bundle: VALID,
    label: "queue-default",
    queue: {
      version: 1,
      nextId: 2,
      tasks: [
        {
          id: 1,
          title: "Read the stage contract",
          state: "queued",
          owner: "assistant-1",
          createdAt: "2026-11-04T00:00:00.000Z",
          pipelineRun: null,
        },
      ],
    },
  });
  const page4 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const pageErrors4 = [];
  page4.on("pageerror", (e) => pageErrors4.push(String(e)));
  await page4.goto(withTask.panel.base, { waitUntil: "domcontentloaded" });
  await page4.waitForSelector("#btn-settings", { timeout: 30_000 });
  await openSettingsGroup(page4, "bundles");
  await page4.waitForFunction(
    () => {
      const el = document.getElementById("bundle-tasks");
      return el && Boolean(el.querySelector("[data-bundle-task-id]"));
    },
    null,
    { timeout: 20_000 },
  );
  const queued = await read(page4);
  check(queued.tasks.length === 1, "the task the sandbox seeded is listed", `${queued.tasks.length} tasks`);
  check(/assistant decides/.test(queued.tasks[0]?.text || ""), "a task with no pipeline reads as the default path", queued.tasks[0]?.text);
  check(!/unassigned/i.test(queued.tasks[0]?.text || ""), "and never as unassigned", queued.tasks[0]?.text);
  check(queued.tasksBad === false, "the queue half is not marked bad", String(queued.tasksBad));
  await pressTask(page4, "1", "assistant-decides");
  const windowOpen = await page4.evaluate(() => {
    const win = document.getElementById("pipew");
    const card = document.getElementById("pipew-card");
    if (!win || win.hidden || !card) return { open: false };
    const title = card.querySelector(".pipew-title");
    const assign = card.querySelector("[data-pipew-assign]");
    return {
      open: true,
      mode: card.dataset.pipewMode || "",
      text: (card.textContent || "").replace(/\s+/g, " ").trim().slice(0, 400),
      title: title ? title.textContent : null,
      hasAssign: Boolean(assign),
      assignMode: assign ? assign.dataset.pipewMode || "" : "",
    };
  });
  check(windowOpen.open === true, "the task row opens the SAME task pipeline window the Queue pane opens");
  check(windowOpen.mode === "assistant-decides", "the window's own mode names the default path", windowOpen.mode);
  check(/This task is on the default path/i.test(windowOpen.text || ""), "and the window says the task is on the default path", String(windowOpen.text || "").slice(0, 220));
  check(windowOpen.hasAssign === true, "the default-path window carries the assignment control");
  check(windowOpen.assignMode === "assistant-decides", "and its control is in the default-path mode", windowOpen.assignMode);

  // ---- 5. the press assigns the task to a pipeline, and the tab's own row follows it ----------------------
  await page4.selectOption("#pipew-card [data-pipew-pipe]", "poc-to-uat");
  await page4.selectOption("#pipew-card [data-pipew-stage]", "S2");
  await page4.click("#pipew-card [data-pipew-apply]");
  await page4.waitForFunction(
    () => document.getElementById("pipew-card")?.dataset.pipewMode === "pipeline",
    null,
    { timeout: 15_000, polling: 80 },
  );
  const assigned = await page4.evaluate(() => {
    const card = document.getElementById("pipew-card");
    return {
      mode: card.dataset.pipewMode,
      stage: card.querySelector(".pipew-stage.is-current")?.dataset.pipewStage || null,
      hasClear: Boolean(card.querySelector("[data-pipew-clear]")),
    };
  });
  check(assigned.mode === "pipeline", "the press turns the window into the pipeline it entered", assigned.mode);
  check(assigned.stage === "S2", "and marks the chosen stage current", assigned.stage);
  check(assigned.hasClear === true, "an assigned task offers the way back to the default");
  await page4.waitForFunction(
    () => {
      const row = document.querySelector('#bundle-tasks [data-bundle-task-id="1"]');
      return row && /pipeline poc-to-uat/.test(row.textContent || "");
    },
    null,
    { timeout: 15_000, polling: 80 },
  );
  const followed = await page4.evaluate(() => {
    const row = document.querySelector('#bundle-tasks [data-bundle-task-id="1"]');
    return row ? row.textContent.replace(/\s+/g, " ").trim() : null;
  });
  check(/pipeline poc-to-uat · S2/.test(followed || ""), "the tab's own row follows the assignment", followed);
  check(!/assistant decides/.test(followed || ""), "and no longer reads as the default path", followed);

  // The queue the tab read is the record the press wrote: the same file on disk, read through the route.
  const stored = await page4.evaluate(async () => {
    const r = await fetch("/api/assistant/queue?assistantId=assistant-1");
    const body = await r.json().catch(() => null);
    const t = body && body.queue && (body.queue.tasks || []).find((x) => String(x.id) === "1");
    return t ? { pipeline: t.pipelineRun && t.pipelineRun.pipeline, stage: t.pipelineRun && t.pipelineRun.stage, enteredAt: t.pipelineRun && t.pipelineRun.enteredAt } : null;
  });
  check(stored?.pipeline === "poc-to-uat" && stored?.stage === "S2", "the queue's own record carries the assignment", JSON.stringify(stored));
  check(/^\d{4}-\d{2}-\d{2}T/.test(String(stored?.enteredAt || "")), "with a real UTC stamp", String(stored?.enteredAt || ""));

  // ---- 6. clear sends it back to the default path, and the row follows that too ---------------------------
  await page4.click("#pipew-card [data-pipew-clear]");
  await page4.waitForFunction(
    () => document.getElementById("pipew-card")?.dataset.pipewMode === "assistant-decides",
    null,
    { timeout: 15_000, polling: 80 },
  );
  await page4.waitForFunction(
    () => {
      const row = document.querySelector('#bundle-tasks [data-bundle-task-id="1"]');
      return row && /assistant decides/.test(row.textContent || "");
    },
    null,
    { timeout: 15_000, polling: 80 },
  );
  const cleared = await page4.evaluate(async () => {
    const row = document.querySelector('#bundle-tasks [data-bundle-task-id="1"]');
    const r = await fetch("/api/assistant/queue?assistantId=assistant-1");
    const body = await r.json().catch(() => null);
    const t = body && body.queue && (body.queue.tasks || []).find((x) => String(x.id) === "1");
    return { rowText: row ? row.textContent.replace(/\s+/g, " ").trim() : null, pipelineRun: t ? t.pipelineRun : "missing" };
  });
  check(/assistant decides/.test(cleared.rowText || ""), "clear puts the row back on the default path", cleared.rowText);
  check(cleared.pipelineRun === null, "and the stored record is null, not a deleted field", JSON.stringify(cleared.pipelineRun));
  check(pageErrors4.length === 0, "no page error from the queue half", pageErrors4.slice(0, 2).join(" | "));
  await page4.close();

  check(pageErrors.length === 0, "no page error on the readable bundle", pageErrors.slice(0, 2).join(" | "));
} catch (e) {
  failures += 1;
  console.log(`FAIL  the run threw: ${String((e && e.stack) || e).split("\n").slice(0, 8).join("\n      ")}`);
} finally {
  await browser.close().catch(() => {});
  for (const { dir, panel } of sandboxes) {
    await panel.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

console.log(`\nRESULT: ${failures ? "FAIL" : "PASS"} — ${checks} checks, ${failures} failed`);
process.exit(failures ? 1 : 0);
