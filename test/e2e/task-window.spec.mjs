// test/e2e/task-window.spec.mjs — the task pipeline window, driven end to end in a real browser.
//
// WHAT THIS IS. The window is a READ of two contracts: lib/pipeline-bundle.js (what an imported studio bundle holds,
// and the ways it is refused) and lib/task-pipeline.js (which mode a record is in, and the time in stage computed from
// the STORED `enteredAt`). lib/pipeline-window.js adds the sequence and the gate; public/assistant.js draws it. This
// spec presses the real chip on a real queue row in headless Chromium and asserts what the reader is shown, so none of
// those four files is taken on its own word.
//
//   RUN   node --test --test-reporter=spec test/e2e/task-window.spec.mjs
//         npm run test:e2e:task-window
//
//         TASK_WINDOW_SHOTS=<dir>   where the screenshots go (default: <tmp>/wtgui-task-window-shots)
//
// THE PANEL IS ITS OWN, AND IT IS NOT 7331. A throwaway server.js from THIS checkout (tools/panel-testkit.mjs), a spare
// port, its own PANEL_CONFIG / HERMES_HOME / job store, a dead apiServer and the board assistant off so no gateway is
// called. config.pipelineBundleFile points INTO that store, so a bundle can be swapped between cases without touching
// a reader's panel. The reader's live panel on 7331 is never started, restarted, read or written; case 1 asserts the
// port this run bound is not it.
//
// THE FIXTURE IS ONE ROW PER ANSWER THE WINDOW CAN GIVE (`state/assistants/assistant-1/queue.json`):
//
//   #7  poc-to-uat S3, stamped 2h30m ago   -> the sequence, S3 current, "3 of 5", the gate that ended S2, 2h30m
//   #8  pipelineRun null                   -> the DEFAULT path in words, no sequence, and the control that assigns one
//   #9  poc-to-uat S1, stamped 3 days ago  -> 3d in stage, opened seconds after #7's 2h30m: the span is the record's
//   #10 poc-to-uat S4, stamp "2026-11-03T14:05:09" (local, no Z) -> UNRESOLVED, the stage kept, the time refused
//   #11 poc-to-uat S9                      -> UNRESOLVED, the sequence drawn, every row unplaced
//   #12 poc-to-uat S2, stamped 10m ago     -> the reader moves it to S3 through the window's own control
//   #13 pipelineRun: "poc-to-uat@S3"       -> UNRESOLVED as a RECORD, not as the default path
//   #14 gone-to-uat S1                     -> UNRESOLVED naming the pipeline the bundle does not hold
//
// THE FOUR CLAIMS THE BRIEF NAMES, and where each is measured:
//
//   the row shows its pipeline stages   the chip names the pipeline and stage; the dialog lists every stage of that
//                                       pipeline in the bundle's order, each with its position of N, the artifact it
//                                       produces, and the gate that ends it (cases 1-8).
//   the position is the stage it is in  exactly one row is current, it is the stage queue.json stores, it agrees with
//                                       the route's own answer, and moving the task through the dialog makes the record
//                                       the position it reads on reopen (cases 9-15).
//   time comes from a timestamp         the span is now − enteredAt (2h30m, 3d), it is the number the server handed the
//                                       page, two windows opened milliseconds apart differ because their records do,
//                                       a reopen recomputes, and a local-time stamp is refused rather than guessed
//                                       (cases 16-22). The one wait (1.2 s) is only that the VISIBLE tick moves; the
//                                       arithmetic is test/task-pipeline-window.test.js against a fixed clock.
//   the refusals are as hard as the happy path   four bad bundles (not a bundle, a newer version, an incomplete stage,
//                                       a dangling handoff) and a missing one, each named to the reader with its code and
//                                       its locator in the exported file, never swallowed and never a 500; plus the two
//                                       record-side danglers (cases 23-41).
//
// A FAILING CASE IS A FAILURE, NOT A TEST TO RE-AIM. If a case below disagrees with the panel, the panel is what the
// report is about; the assertion is not made to fit.
//
// Exit is node:test's: 0 when every case passed, 1 when one failed, and the summary line counts them.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { attachPageCollectors, loadPlaywright } from "../../tools/browser.mjs";
import { freePort, startPanel } from "../../tools/panel-testkit.mjs";

// The reader's own panel. This run must never bind it, and never write its store.
const LIVE_PORT = 7331;

const PW = loadPlaywright();
const SKIP = PW ? null : "BROWSER-HALF-NOT-RUN: no Playwright install found (set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright)";
// A skipped case still reports, so a run without a browser says so in the same shape as a run with one.
const it = (name, fn) => (PW ? test(name, fn) : test(name, { skip: SKIP }, () => {}));

// ---- the fixture --------------------------------------------------------------------------------------------------
const stage = (n, title) => ({
  id: `S${n}`,
  title,
  prompt: `Work stage ${n}: ${title}.`,
  artifact: { id: `artifact-${n}`, path: `out/${n}.json`, schema: "out/1", writer: `worker-${n}` },
});

// A studio bundle in the panel's wrapper form: five stages, one gate that ends S2 (with a decision artifact), and the
// handoffs that join them. Small on purpose — "3 of 5" is legible in a screenshot and in a diff.
const GOOD = {
  bundleVersion: 1,
  name: "poc-to-uat",
  pipelines: [
    {
      id: "poc-to-uat",
      title: "POC to UAT",
      stages: [stage(1, "Gather the ask"), stage(2, "Scope it"), stage(3, "Shape the contract"), stage(4, "Build it"), stage(5, "Hand it over")],
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
        { id: "h1", from: "S1", to: "S2", artifact: "artifact-1", kind: "sequence" },
        { id: "h2", from: "S2", to: "S3", artifact: "artifact-2", kind: "sequence" },
        { id: "h3", from: "S3", to: "S4", artifact: "artifact-3", kind: "sequence" },
        { id: "h4", from: "S4", to: "S5", artifact: "artifact-4", kind: "sequence" },
      ],
    },
  ],
};

// The four refusals, each broken in exactly one way so the code it is refused for cannot be confused with another.
const clone = (value) => JSON.parse(JSON.stringify(value));
const BAD = {
  shape: () => ({ hello: "world" }),
  version: () => ({ ...clone(GOOD), bundleVersion: 2 }),
  stage: () => {
    const bundle = clone(GOOD);
    delete bundle.pipelines[0].stages[1].artifact;
    return bundle;
  },
  handoff: () => {
    const bundle = clone(GOOD);
    bundle.pipelines[0].handoffs.push({ id: "h5", from: "S5", to: "S9", artifact: "artifact-5", kind: "sequence" });
    return bundle;
  },
};

const at = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const QUEUE = {
  version: 3,
  nextId: 15,
  tasks: [
    { id: 7, title: "carry the contract", state: "running", thread: null, threads: [], files: [], pipelineRun: { pipeline: "poc-to-uat", stage: "S3", enteredAt: at(2.5 * HOUR) } },
    { id: 8, title: "unassigned work", state: "queued", files: [], pipelineRun: null },
    { id: 9, title: "long settled", state: "queued", files: [], pipelineRun: { pipeline: "poc-to-uat", stage: "S1", enteredAt: at(3 * DAY) } },
    { id: 10, title: "handed over in local time", state: "queued", files: [], pipelineRun: { pipeline: "poc-to-uat", stage: "S4", enteredAt: "2026-11-03T14:05:09" } },
    { id: 11, title: "points at a stage that left", state: "parked", files: [], pipelineRun: { pipeline: "poc-to-uat", stage: "S9", enteredAt: at(2.5 * HOUR) } },
    { id: 12, title: "moves by the reader", state: "queued", files: [], pipelineRun: { pipeline: "poc-to-uat", stage: "S2", enteredAt: at(10 * MIN) } },
    { id: 13, title: "a record that is not an assignment", state: "queued", files: [], pipelineRun: "poc-to-uat@S3" },
    { id: 14, title: "points at a pipeline that left", state: "queued", files: [], pipelineRun: { pipeline: "gone-to-uat", stage: "S1", enteredAt: at(2.5 * HOUR) } },
  ],
};

// ---- the run's own state ------------------------------------------------------------------------------------------
let panel = null;
let browser = null;
let context = null;
let page = null;
let pageErrors = [];
let consoleErrors = [];
let bundleFile = null;
let queueFile = null;
let shots = null;

// The duration fmtDur draws, back as milliseconds ("2h30m04s", "3d00h", "45m02s", "9s"). Proves the text is the
// server's number and not a shape an assertion was written around.
function parseDur(text) {
  const m = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(String(text || "").trim());
  if (!m || !m.slice(1).some(Boolean)) return null;
  const [, d, h, mi, s] = m;
  return (((Number(d || 0) * 24 + Number(h || 0)) * 60 + Number(mi || 0)) * 60 + Number(s || 0)) * 1000;
}

const writeBundle = (value) => writeFileSync(bundleFile, JSON.stringify(value, null, 1), "utf8");
const restoreBundle = () => writeBundle(GOOD);
const readQueue = () => JSON.parse(readFileSync(queueFile, "utf8"));
const taskOnDisk = (id) => readQueue().tasks.find((t) => Number(t.id) === Number(id));

// What the dialog currently shows, read from the DOM the reader sees. One reader, so every case asserts the same shape.
const snapshot = () =>
  page.evaluate(() => {
    const card = document.getElementById("pipew-card");
    if (!card) return null;
    const rows = [...card.querySelectorAll(".pipew-stage")].map((li) => ({
      id: li.dataset.pipewStage,
      phase: li.dataset.pipewPhase,
      pos: li.querySelector(".pipew-pos")?.textContent.trim() || null,
      text: (li.innerText || "").replace(/\s+/g, " ").trim(),
      artifact: li.querySelector(".pipew-artifact")?.textContent.replace(/\s+/g, " ").trim() || null,
      gate: li.querySelector(".pipew-gate")?.textContent.replace(/\s+/g, " ").trim() || null,
    }));
    const elapsed = card.querySelector("[data-pipew-elapsed]");
    return {
      mode: card.dataset.pipewMode || null,
      title: card.querySelector(".pipew-title")?.textContent.trim() || null,
      sub: card.querySelector(".pipew-bar .pipew-sub")?.textContent.replace(/\s+/g, " ").trim() || null,
      text: (card.innerText || "").replace(/\s+/g, " ").trim(),
      rows,
      phases: rows.map((r) => r.phase),
      current: rows.filter((r) => r.phase === "current").map((r) => r.id),
      previous: card.querySelector(".pipew-prev")?.textContent.replace(/\s+/g, " ").trim() || null,
      hasElapsed: Boolean(elapsed),
      elapsedText: elapsed ? elapsed.textContent.trim() : null,
      elapsedMs: elapsed && elapsed.dataset.pipewMs !== "" ? Number(elapsed.dataset.pipewMs) : null,
      control: Boolean(card.querySelector("[data-pipew-assign]")),
      apply: card.querySelectorAll("[data-pipew-apply]").length,
      offeredStages: [...card.querySelectorAll("[data-pipew-stage] option")].map((o) => o.value),
    };
  });

// The panel's own answer for one row: what the page is expected to draw, read from the route rather than re-derived.
const routeModel = async (taskId) => {
  const r = await fetch(`${panel.base}/api/assistant/task-pipeline?assistantId=assistant-1&task=${taskId}`);
  return { status: r.status, body: await r.json().catch(() => null) };
};

// The rail and its Queue sub-tab. Re-asserted rather than assumed: a case that closed the rail would otherwise fail
// three cases later with a selector timeout that says nothing about the cause.
const rowsReady = (timeout) =>
  page
    .waitForFunction(() => document.querySelectorAll("#as-queue .as-task").length === 8, null, { timeout, polling: 100 })
    .then(() => true, () => false);

async function ensureQueue() {
  const state = await page.evaluate(() => {
    const rail = document.getElementById("assistant");
    const queue = document.getElementById("as-queue");
    return {
      rail: Boolean(rail) && !rail.hidden && getComputedStyle(rail).display !== "none",
      queue: Boolean(queue) && !queue.classList.contains("hidden"),
    };
  });
  if (!state.rail) {
    await page.click("#btn-assistant");
    await page.waitForSelector("#assistant", { state: "visible", timeout: 15_000 });
  }
  if (!state.queue) {
    await page.waitForSelector('#as-subtabs [data-as-subtab="queue"]', { state: "visible", timeout: 15_000 });
    await page.click('#as-subtabs [data-as-subtab="queue"]');
  }
  if (await rowsReady(20_000)) return;
  // A Queue tab pressed before the page finished wiring its tabs can paint its empty state and stay there; pressing
  // it once more is the reader's own move, and it turns a first-boot race into a retry instead of a red run.
  await page.click('#as-subtabs [data-as-subtab="queue"]');
  if (await rowsReady(20_000)) return;
  const seen = await page.evaluate(() => ({
    count: document.querySelectorAll("#as-queue .as-task").length,
    text: (document.getElementById("as-queue")?.innerText || "").replace(/\s+/g, " ").slice(0, 300),
  }));
  throw new Error(`the queue pane never drew ${QUEUE.tasks.length} rows (saw ${seen.count}): ${seen.text}`);
}

async function closeWindow() {
  const open = await page.evaluate(() => {
    const host = document.getElementById("pipew");
    return Boolean(host) && !host.hidden;
  });
  if (!open) return;
  await page.click("#pipew [data-pipew-close]");
  await page.waitForFunction(() => document.getElementById("pipew").hidden === true, null, { timeout: 5_000 });
}

// Open one row's window and wait for the ANSWER, not just the frame: the dialog paints "reading…" at once (a press that
// answered with nothing would look dead), so a visible #pipew alone matches before the data is in.
async function openWindow(taskId, mode = null) {
  await ensureQueue();
  await closeWindow();
  await page.click(`#as-queue .as-task[data-as-qrow="${taskId}"] [data-as-qpipe]`);
  await page.waitForFunction(
    (want) => {
      const card = document.getElementById("pipew-card");
      const host = document.getElementById("pipew");
      if (!host || host.hidden || !card) return false;
      const got = card.dataset.pipewMode || "";
      return Boolean(got) && got !== "reading" && (!want || got === want);
    },
    mode,
    { timeout: 15_000, polling: 60 },
  );
  return snapshot();
}

// ---- boot ---------------------------------------------------------------------------------------------------------
before(async () => {
  if (!PW) return;
  const store = mkdtempSync(path.join(os.tmpdir(), "wtgui-task-window-e2e-"));
  const logs = path.join(store, "logs");
  mkdirSync(path.join(logs, "assistants", "assistant-1"), { recursive: true });
  bundleFile = path.join(logs, "pipeline-bundle.json");
  queueFile = path.join(logs, "assistants", "assistant-1", "queue.json");
  shots = path.resolve(process.env.TASK_WINDOW_SHOTS || path.join(os.tmpdir(), "wtgui-task-window-shots"));
  mkdirSync(shots, { recursive: true });
  writeBundle(GOOD);
  writeFileSync(queueFile, JSON.stringify(QUEUE, null, 1), "utf8");

  const port = await freePort();
  assert.notEqual(port, LIVE_PORT, "the OS handed out the reader's own port — refusing to boot over a live panel");
  panel = await startPanel({
    dir: store,
    port,
    config: {
      pipelineBundleFile: bundleFile,
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
  console.log(`      task-window spec: panel ${panel.base} (store ${store}), shots ${shots}`);

  browser = await PW.chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  ({ pageErrors, consoleErrors } = attachPageCollectors(page));
  await page.goto(panel.base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#job-prompt", { state: "visible", timeout: 30_000 });
  await ensureQueue();
});

after(async () => {
  if (browser) await browser.close().catch(() => {});
  if (panel) await panel.stop();
  if (shots) console.log(`      task-window spec: screenshots in ${shots}`);
});

// ---- 1. the row, and the stages behind it -------------------------------------------------------------------------
it("every queue row carries a pipeline press, and it is a real button", async () => {
  const rows = await page.$$eval("#as-queue .as-task", (list) =>
    list.map((row) => {
      const press = row.querySelector("[data-as-qpipe]");
      return { task: row.dataset.asQrow, tag: press ? press.tagName : null, own: press ? press.dataset.asQown : null };
    }),
  );
  assert.equal(rows.length, QUEUE.tasks.length, `the fixture's ${QUEUE.tasks.length} rows are drawn`);
  // The pane draws its rows in state buckets (parked after the active ones), not in file order, so the claim here is
  // "every task exactly once", not "in the order the file lists them".
  assert.deepEqual(rows.map((r) => r.task).sort(), QUEUE.tasks.map((t) => String(t.id)).sort(), "exactly one press per task");
  assert.deepEqual([...new Set(rows.map((r) => r.tag))], ["BUTTON"], "every press is a real button, not a styled span");
  assert.deepEqual([...new Set(rows.map((r) => r.own))], ["assistant-1"], "each press names the queue it came from");
});

it("a row on a pipeline names the pipeline and the stage it is in", async () => {
  const chip = await page.$eval('#as-queue .as-task[data-as-qrow="7"] [data-as-qpipe]', (b) => b.textContent.replace(/\s+/g, " ").trim());
  assert.equal(chip, "pipeline poc-to-uat · S3", "the row draws the record it stores, by pipeline and stage id");
});

it("a row with no assignment says the assistant decides — and still has a press", async () => {
  const chip = await page.$eval('#as-queue .as-task[data-as-qrow="8"] [data-as-qpipe]', (b) => b.textContent.replace(/\s+/g, " ").trim());
  assert.equal(chip, "assistant decides", "the default path is said in words, not drawn as an empty chip");
});

it("pressing the row opens the window on that task, as a modal dialog that takes the caret", async () => {
  await openWindow(7, "pipeline");
  const dialog = await page.evaluate(() => {
    const card = document.getElementById("pipew-card");
    const labelled = document.getElementById(card.getAttribute("aria-labelledby") || "");
    return {
      role: card.getAttribute("role"),
      modal: card.getAttribute("aria-modal"),
      labelled: Boolean(labelled && labelled.textContent.trim()),
      outsideRail: !card.closest("#assistant"),
      caretInside: card.contains(document.activeElement),
      railOpen: !document.getElementById("assistant").hidden,
      title: document.querySelector("#pipew-card .pipew-title")?.textContent.trim() || null,
    };
  });
  assert.equal(dialog.role, "dialog", "the card is a dialog");
  assert.equal(dialog.modal, "true", "…modal");
  assert.ok(dialog.labelled, "…labelled by its own title");
  assert.ok(dialog.outsideRail, "…and outside the assistant rail, so Escape can stop at it");
  assert.ok(dialog.caretInside, "opening put the caret in the dialog");
  assert.ok(dialog.railOpen, "the rail is still open behind it");
  assert.match(dialog.title || "", /#7 carry the contract/, "the window names the task the row named");
});

it("the window lists every stage of the task's pipeline in the bundle's order", async () => {
  await openWindow(7, "pipeline");
  const win = await snapshot();
  assert.deepEqual(win.rows.map((r) => r.id), ["S1", "S2", "S3", "S4", "S5"], "all five stages, in the bundle's own order");
  assert.equal(win.mode, "pipeline", "the window is in its pipeline mode");
});

it("every stage carries its own position of N", async () => {
  await openWindow(7, "pipeline");
  const win = await snapshot();
  assert.deepEqual(win.rows.map((r) => r.pos), ["1 of 5", "2 of 5", "3 of 5", "4 of 5", "5 of 5"], "each row says where it sits of how many");
});

it("every stage names the artifact it produces", async () => {
  await openWindow(7, "pipeline");
  const win = await snapshot();
  for (const [index, row] of win.rows.entries()) {
    const n = index + 1;
    assert.ok(row.artifact && row.artifact.includes(`artifact-${n}`), `stage ${n} names its artifact id (got ${row.artifact})`);
    assert.ok(row.artifact.includes(`out/${n}.json`), `stage ${n} names the path its artifact is written to (got ${row.artifact})`);
    assert.ok(row.artifact.includes(`worker-${n}`), `stage ${n} names its one writer (got ${row.artifact})`);
  }
});

it("the gate that ends a stage is drawn on that stage, not on the next", async () => {
  await openWindow(7, "pipeline");
  const win = await snapshot();
  assert.ok(win.rows[1].gate && /contract signed/.test(win.rows[1].gate), `S2 carries the gate that ends it (got ${win.rows[1].gate})`);
  assert.ok(/decisions\/2\.json/.test(win.rows[1].gate) && /go, no-go/.test(win.rows[1].gate), "…with the decision artifact and the values it can be read back as");
  assert.equal(win.rows[2].gate, null, "the current stage does not claim the gate that ended the one before it");
});

// ---- 2. where the task actually is --------------------------------------------------------------------------------
it("exactly one stage is marked current, and it is the stage the queue file stores", async () => {
  const win = await openWindow(7, "pipeline");
  const stored = taskOnDisk(7).pipelineRun.stage;
  assert.deepEqual(win.current, ["S3"], "exactly one stage is current");
  assert.equal(win.current[0], stored, `the current stage is the stage queue.json stores (${stored})`);
});

it("the head reads the position of N and the stage's name", async () => {
  const win = await openWindow(7, "pipeline");
  assert.match(win.sub || "", /^3 of 5 — Shape the contract$/, `the head says 3 of 5 and the stage's title (got ${win.sub})`);
});

it("the stages before are marked before and the ones after after", async () => {
  const win = await openWindow(7, "pipeline");
  assert.deepEqual(win.phases, ["before", "before", "current", "after", "after"], "the sequence is marked as one position in a list");
});

it("the window's current stage is the panel route's current stage for the same record", async () => {
  const win = await openWindow(7, "pipeline");
  const route = await routeModel(7);
  assert.equal(route.status, 200, "the route answers");
  assert.equal(win.current[0], route.body.current.id, "the page and the route name the same stage");
  assert.deepEqual(win.phases, route.body.stages.map((s) => s.phase), "…and the same phase on every row");
});

it("the window shows a real task with stages and a position — captured for the report", async () => {
  await openWindow(7, "pipeline");
  const shot = path.join(shots, "task-window-stage-3.png");
  await page.locator("#pipew-card").screenshot({ path: shot });
  const size = statSync(shot).size;
  assert.ok(size > 20_000, `the capture is a real image, not an empty frame (${size} bytes at ${shot})`);
  console.log(`      screenshot: ${shot}`);
});

it("the line above the sequence names the gate that ended the previous stage", async () => {
  const win = await openWindow(7, "pipeline");
  assert.match(win.previous || "", /ended the stage before — contract signed/, `the previous gate is named (got ${win.previous})`);
  assert.match(win.previous || "", /artifact-2/, "…with the artifact it decided on");
  assert.match(win.previous || "", /decisions\/2\.json/, "…and where its decision is written");
});

it("a task on the default path can be put on a pipeline from its window", async () => {
  const before = await openWindow(8, "assistant-decides");
  assert.equal(before.rows.length, 0, "the default-path window draws no sequence to mistake for one");
  await page.selectOption("#pipew-card select[data-pipew-pipe]", "poc-to-uat");
  await page.selectOption("#pipew-card select[data-pipew-stage]", "S2");
  await page.click("#pipew-card [data-pipew-apply]");
  await page.waitForFunction(
    () => {
      const card = document.getElementById("pipew-card");
      return card?.dataset.pipewMode === "pipeline" && card.querySelector(".pipew-stage.is-current")?.dataset.pipewStage === "S2";
    },
    null,
    { timeout: 15_000, polling: 80 },
  );
  const entered = await snapshot();
  assert.deepEqual(entered.current, ["S2"], "pressing apply turns the window into the stage it entered");
  assert.match(entered.sub || "", /^2 of 5 — Scope it$/, `…and the head says where that is (got ${entered.sub})`);
});

it("…and the row behind and the record agree with what the window shows", async () => {
  const chip = await page.$eval('#as-queue .as-task[data-as-qrow="8"] [data-as-qpipe]', (b) => b.textContent.replace(/\s+/g, " ").trim());
  assert.equal(chip, "pipeline poc-to-uat · S2", "the row behind the dialog repaints from the queue the write returned");
  const stored = taskOnDisk(8).pipelineRun;
  assert.equal(stored.stage, "S2", "the record on disk is the stage the window shows");
  assert.match(String(stored.enteredAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/, "…stamped with a UTC instant");
  assert.ok(Date.now() - Date.parse(stored.enteredAt) < 120_000, `…from this write's clock (${stored.enteredAt})`);
});

it("moving the task through the window's own control makes the new stage current", async () => {
  const first = await openWindow(12, "pipeline");
  assert.deepEqual(first.current, ["S2"], "the fixture row starts at S2");
  await page.selectOption("#pipew-card select[data-pipew-stage]", "S3");
  const chosen = await page.$eval("#pipew-card select[data-pipew-stage]", (s) => s.value);
  assert.equal(chosen, "S3", "the select holds the stage the reader chose");
  await page.click("#pipew-card [data-pipew-apply]");
  const entered = await page
    .waitForFunction(
      () => {
        const card = document.getElementById("pipew-card");
        return card?.dataset.pipewMode === "pipeline" && card.querySelector(".pipew-stage.is-current")?.dataset.pipewStage === "S3";
      },
      null,
      { timeout: 8_000, polling: 80 },
    )
    .then(() => true, () => false);
  const after = await page.evaluate(() => {
    const card = document.getElementById("pipew-card");
    return {
      mode: card.dataset.pipewMode,
      current: card.querySelector(".pipew-stage.is-current")?.dataset.pipewStage || null,
      note: card.querySelector("[data-pipew-assign-note]")?.textContent.trim() || null,
    };
  });
  assert.ok(entered, `pressing "move it to this stage" enters S3 — it did not: the dialog answered ${JSON.stringify(after.note)} (mode ${after.mode}, current ${after.current})`);
  await closeWindow();
  const reopened = await openWindow(12, "pipeline");
  assert.deepEqual(reopened.current, ["S3"], "…and a reopen reads the RECORD, so the move survived the dialog");
});

it("the move wrote the record: queue.json carries the new stage and a fresh UTC stamp", async () => {
  const stored = taskOnDisk(12).pipelineRun;
  assert.equal(stored.pipeline, "poc-to-uat", "the pipeline is the one the control offered");
  assert.equal(stored.stage, "S3", `the stage on disk is the stage the window shows — the write the press promises never landed (${JSON.stringify(stored)})`);
  assert.match(String(stored.enteredAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/, "the stamp is a UTC instant");
  assert.ok(Date.now() - Date.parse(stored.enteredAt) < 120_000, `entering a stage stamped the moment it entered (${stored.enteredAt})`);
});

// ---- 3. time in stage is the record's, not the page's -------------------------------------------------------------
it("the span is the record's 2h30m, not the second the dialog has been open", async () => {
  const win = await openWindow(7, "pipeline");
  assert.ok(Number.isFinite(win.elapsedMs), `the window carries a computed span (got ${win.elapsedMs})`);
  assert.ok(win.elapsedMs >= 2.5 * HOUR - MIN, `the span is at least 2h29m (got ${win.elapsedMs} ms)`);
  assert.ok(win.elapsedMs <= 2.5 * HOUR + 2 * MIN, `…and at most 2h32m (got ${win.elapsedMs} ms) — a number counted from the open would be seconds`);
  assert.match(win.elapsedText || "", /^2h3\dm\d+s$/, `…and it is drawn as a duration (got ${win.elapsedText})`);
});

it("the number the page was handed is the server's, computed from the stamp", async () => {
  const win = await openWindow(7, "pipeline");
  const route = await routeModel(7);
  const expected = Date.now() - Date.parse(taskOnDisk(7).pipelineRun.enteredAt);
  assert.ok(Math.abs(route.body.elapsed.ms - expected) < 5_000, `the route's elapsed is now − enteredAt (route ${route.body.elapsed.ms}, expected ${expected})`);
  assert.ok(Math.abs(win.elapsedMs - route.body.elapsed.ms) < 5_000, `the page shows the route's number (page ${win.elapsedMs}, route ${route.body.elapsed.ms})`);
});

it("the drawn span is the route's now minus enteredAt (within 5s)", async () => {
  const win = await openWindow(7, "pipeline");
  const route = await routeModel(7);
  const drawn = parseDur(win.elapsedText);
  assert.ok(Number.isFinite(drawn), `the span parses back out of the drawn text (${win.elapsedText})`);
  assert.ok(Math.abs(drawn - route.body.elapsed.ms) <= 2_000, `the drawn duration is the route's number to the second (drawn ${drawn}, route ${route.body.elapsed.ms})`);
});

it("two windows opened seconds apart show the spans their own records carry (2h30m vs 3d)", async () => {
  const t0 = Date.now();
  const recent = await openWindow(7, "pipeline");
  const t1 = Date.now();
  const old = await openWindow(9, "pipeline");
  const t2 = Date.now();
  assert.ok(t2 - t0 < 10_000, `both windows were opened within one round (${t2 - t0} ms apart)`);
  assert.ok(t1 - t0 < 5_000, "…and the first took seconds, not hours, to open");
  assert.ok(recent.elapsedMs < 3 * HOUR, `#7's span is hours, from its stamp (${recent.elapsedMs} ms)`);
  assert.ok(old.elapsedMs > 70 * HOUR, `#9's span is days, from ITS stamp (${old.elapsedMs} ms) — the same wall clock produced both`);
  assert.match(old.elapsedText || "", /^3d\d\dh$/, `…and 3 days is drawn as 3 days, not 72h (got ${old.elapsedText})`);
});

it("reopening recomputes from the record: the span grows by the time that passed", async () => {
  const first = await openWindow(7, "pipeline");
  await page.waitForTimeout(1_500);
  await closeWindow();
  const again = await openWindow(7, "pipeline");
  const route = await routeModel(7);
  assert.ok(again.elapsedMs >= first.elapsedMs + 1_200, `the reopened span is later than the first read (${first.elapsedMs} -> ${again.elapsedMs})`);
  assert.ok(Math.abs(again.elapsedMs - route.body.elapsed.ms) < 5_000, "…and it is the route's answer at the new clock, not a remembered number");
});

it("the visible tick advances the span while the window is open", async () => {
  const win = await openWindow(7, "pipeline");
  await page.waitForTimeout(1_200);
  const ticked = await page.$eval("#pipew-card [data-pipew-elapsed]", (el) => el.textContent.trim());
  assert.notEqual(ticked, win.elapsedText, `the display moved on its second (${win.elapsedText} -> ${ticked})`);
});

it("a local-time stamp is refused, not counted: no number, and the tick invents none", async () => {
  const win = await openWindow(10, "unresolved");
  assert.match(win.text, /not a UTC instant/, `the reason names the stamp's fault (${win.text.slice(0, 200)})`);
  assert.deepEqual(win.current, ["S4"], "the stage is known, so it keeps its mark");
  assert.ok(win.hasElapsed, "the current row still carries the elapsed slot");
  assert.equal(win.elapsedMs, null, "…with no number the page could count from");
  assert.equal(win.elapsedText, "—", "…drawn as unknown");
  await page.waitForTimeout(1_200);
  assert.equal(await page.$eval("#pipew-card [data-pipew-elapsed]", (el) => el.textContent.trim()), "—", "a tick with no base invents nothing");
});

// ---- 4. the refusals, as hard as the happy path -------------------------------------------------------------------
it("a bundle that is not a bundle is named to the reader — not-a-bundle", async () => {
  writeBundle(BAD.shape());
  const win = await openWindow(7, "unresolved");
  assert.equal(win.mode, "unresolved", "a refused bundle is UNRESOLVED, never the default path");
  assert.match(win.text, /UNRESOLVED/, "the dialog says so in its own heading");
  assert.match(win.text, /not-a-bundle/, `the loader's code is named (${win.text.slice(0, 240)})`);
  assert.match(win.text, /is refused — not-a-bundle/, "…as a refusal of the file, not a generic failure");
  assert.match(win.text, /pipeline-bundle\.json/, "…naming the file that was refused");
  restoreBundle();
});

it("…and its control says no pipeline can be chosen, with the code", async () => {
  writeBundle(BAD.shape());
  const win = await openWindow(7, "unresolved");
  assert.ok(win.control, "the assignment control is still drawn");
  assert.equal(win.apply, 0, "there is no press to assign against a bundle that cannot be read");
  assert.match(win.text, /no pipeline can be chosen/i, "the control says why it offers nothing");
  assert.match(win.text, /not-a-bundle/, "…and repeats the loader's code");
  restoreBundle();
});

it("…and the refusal is a value, not a 500: no stage drawn, the panel still healthy", async () => {
  writeBundle(BAD.shape());
  const win = await openWindow(7, "unresolved");
  assert.notEqual(win.mode, "error", "the route answered, so the dialog is not in its error mode");
  assert.equal(win.rows.length, 0, "a refused bundle has no sequence to draw");
  const health = await fetch(`${panel.base}/api/health`);
  assert.equal(health.status, 200, "the panel is still answering after the refusal");
  restoreBundle();
});

it("a bundle from a newer studio is refused whole — unsupported-version", async () => {
  writeBundle(BAD.version());
  const win = await openWindow(7, "unresolved");
  assert.match(win.text, /unsupported-version/, `the code is named (${win.text.slice(0, 240)})`);
  assert.match(win.text, /version 2/, "…with the version it declares");
  assert.match(win.text, /newer than this panel's 1/, "…and the version this panel reads");
  restoreBundle();
});

it("…and the control prints the version refusal instead of offering stages", async () => {
  writeBundle(BAD.version());
  const win = await openWindow(7, "unresolved");
  assert.equal(win.apply, 0, "no press is offered");
  assert.equal(win.offeredStages.length, 0, "no stage from a bundle the panel refused to read");
  assert.match(win.text, /no pipeline can be chosen — .*version 2/, "the reason reaches the control");
  restoreBundle();
});

it("…and the row behind still shows the record it names — nothing is swallowed", async () => {
  writeBundle(BAD.version());
  const chip = await page.$eval('#as-queue .as-task[data-as-qrow="7"] [data-as-qpipe]', (b) => b.textContent.replace(/\s+/g, " ").trim());
  assert.equal(chip, "pipeline poc-to-uat · S3", "the row draws the stored record even while the bundle was refused");
  restoreBundle();
});

it("an incomplete stage is refused with the code and the locator in the exported file", async () => {
  writeBundle(BAD.stage());
  const win = await openWindow(7, "unresolved");
  assert.match(win.text, /incomplete-stage/, `the code is named (${win.text.slice(0, 260)})`);
  assert.match(win.text, /at pipelines\[0\]\.stages\[1\]/, "…and the locator a reader would search for in the file they exported");
  restoreBundle();
});

it("…and the reason says what the stage is missing", async () => {
  writeBundle(BAD.stage());
  const win = await openWindow(7, "unresolved");
  assert.match(win.text, /produces no artifact/, `the sentence names the missing thing (${win.text.slice(0, 260)})`);
  restoreBundle();
});

it("…and one bad stage draws no sequence at all — the refusal is whole", async () => {
  writeBundle(BAD.stage());
  const win = await openWindow(7, "unresolved");
  assert.deepEqual(win.rows.map((r) => r.id), [], "the four stages that were fine are not drawn beside the one that was not");
  restoreBundle();
});

it("a dangling handoff is refused with the code and the locator", async () => {
  writeBundle(BAD.handoff());
  const win = await openWindow(7, "unresolved");
  assert.match(win.text, /dangling-reference/, `the code is named (${win.text.slice(0, 260)})`);
  assert.match(win.text, /at pipelines\[0\]\.handoffs\[4\]/, "…and the locator of the edge that dangles");
  restoreBundle();
});

it("…and the reason names the stage the pipeline does not hold", async () => {
  writeBundle(BAD.handoff());
  const win = await openWindow(7, "unresolved");
  assert.match(win.text, /stage "S9"/, "the sentence names the missing stage");
  assert.match(win.text, /it holds S1, S2, S3, S4, S5/, "…and what the pipeline does hold, so the reader can fix it");
  restoreBundle();
});

it("…and the control offers no press to assign against a refused bundle", async () => {
  writeBundle(BAD.handoff());
  const win = await openWindow(7, "unresolved");
  assert.equal(win.apply, 0, "no press");
  assert.match(win.text, /no pipeline can be chosen/i, "the control says why");
  restoreBundle();
});

it("a missing bundle is absence, named as `missing` with the file path", async () => {
  rmSync(bundleFile, { force: true });
  const win = await openWindow(7, "unresolved");
  assert.match(win.text, /missing/, `absence has its own code (${win.text.slice(0, 240)})`);
  assert.match(win.text, /pipeline-bundle\.json/, "…and names the file that is not there");
  assert.match(win.text, /there is no bundle at that path/, "…in the loader's own words");
  restoreBundle();
});

it("…and the control says why it can offer nothing", async () => {
  rmSync(bundleFile, { force: true });
  const win = await openWindow(7, "unresolved");
  assert.equal(win.apply, 0, "no press");
  assert.match(win.text, /no pipeline can be chosen/i, "the control says so rather than drawing an empty select");
  restoreBundle();
});

it("restoring the good bundle makes the same window resolve again — nothing was cached", async () => {
  restoreBundle();
  const win = await openWindow(7, "pipeline");
  assert.deepEqual(win.current, ["S3"], "the bundle is read per request, so the good file resolves the same record again");
  assert.equal(win.rows.length, 5, "…with its five stages back");
});

it("a record naming a pipeline the bundle left reads UNRESOLVED and is not the default path", async () => {
  const win = await openWindow(14, "unresolved");
  assert.match(win.text, /gone-to-uat/, "the pipeline the record asked for is named");
  assert.equal(win.rows.length, 0, "there is no sequence to draw for a pipeline the bundle does not hold");
  assert.equal(win.current.length, 0, "nothing is marked current");
  assert.match(win.text, /never treated as the default path/i, "…and the reader is told it is not the default path");
});

it("a record naming a stage its pipeline left keeps its sequence, every row unplaced", async () => {
  const win = await openWindow(11, "unresolved");
  assert.match(win.text, /holds no stage "S9"/, `the missing stage is named (${win.text.slice(0, 240)})`);
  assert.deepEqual(win.rows.map((r) => r.id), ["S1", "S2", "S3", "S4", "S5"], "the sequence it still has is drawn");
  assert.deepEqual(win.phases, ["unplaced", "unplaced", "unplaced", "unplaced", "unplaced"], "every row is unplaced");
  assert.equal(win.current.length, 0, "nothing can be called current");
});

it("a record whose pipelineRun is not an assignment is refused as a record, not a default", async () => {
  const win = await openWindow(13, "unresolved");
  assert.match(win.text, /not a pipeline assignment/, `the record's own fault is named (${win.text.slice(0, 240)})`);
  assert.match(win.text, /poc-to-uat@S3/, "…quoting what the record actually holds");
  assert.doesNotMatch(win.text, /This task is on the default path/, "it is never drawn as the default path");
});

it("opening the window is a read: it does not write the queue file", async () => {
  const beforeText = readFileSync(queueFile, "utf8");
  await openWindow(7, "pipeline");
  await closeWindow();
  assert.equal(readFileSync(queueFile, "utf8"), beforeText, "opening and closing wrote nothing to the store");
});

// ---- 5. the run's own hygiene -------------------------------------------------------------------------------------
it("the run's panel bound its own port, not the reader's 7331", async () => {
  assert.notEqual(panel.port, LIVE_PORT, "the spec never binds the live panel's port");
  assert.match(panel.base, /^http:\/\/127\.0\.0\.1:\d+$/, `the panel is a loopback listener of this run (${panel.base})`);
  assert.equal((await fetch(`${panel.base}/api/health`)).status, 200, "…and it is the panel this run started");
});

it("the page logged no errors", async () => {
  assert.deepEqual(pageErrors, [], "no uncaught error reached the page");
});

it("the console logged no errors", async () => {
  assert.deepEqual(consoleErrors, [], "no console.error was written");
});
