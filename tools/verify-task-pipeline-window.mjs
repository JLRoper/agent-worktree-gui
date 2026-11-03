// The task pipeline WINDOW, in a real browser: a Queue row's press opens a dialog that lists every stage of the task's
// pipeline in order, marks the current one with its `position of N` and the time spent there, names the gate that ended
// the stage before it, and says so plainly when the record is on the default path or cannot be resolved.
//
//   node tools/verify-task-pipeline-window.mjs                     # this checkout
//   node tools/verify-task-pipeline-window.mjs --root <export>     # serve a `git archive` of another build
//   node tools/verify-task-pipeline-window.mjs --shots <dir>       # where screenshots go (default: a temp dir)
//   node tools/verify-task-pipeline-window.mjs --json <file>       # keep the raw ledger
//
// WHAT IS DRIVEN. A throwaway panel of its own (tools/panel-testkit.mjs — spare port, own PANEL_CONFIG / HERMES_HOME /
// jobs.json), a dead apiServer and the board assistant OFF so no gateway is called. Its state folder carries one studio
// bundle (`pipeline-bundle.json`, the file `config.pipelineBundleFile` names) and a queue with four rows, one per answer
// the window can give:
//
//   #7  on stage 3 of 5 of `poc-to-uat`  -> the sequence, S3 current, the gate that ended S2, the stamp, the elapsed
//   #8  no pipelineRun at all            -> the DEFAULT path in words, no sequence, and the control that puts it on one
//   #9  a pipeline the bundle left       -> UNRESOLVED with the reason, no stage current
//   #10 a stage its pipeline left        -> UNRESOLVED, the sequence drawn unplaced
//
// THE ASSIGNMENT CONTROL is driven end to end from #8's window: the catalogue's pipelines and stages are read from the
// select it drew, apply writes through the queue's own route, the window turns into the pipeline it just entered, the
// row's chip behind it changes, the STAGE SURVIVES A REOPEN (it is the record, not the dialog), and clear puts the task
// back on the default path with `pipelineRun: null` on disk. Each step is checked against the queue FILE, not the page.
//
// THE CLOCK IS NOT WAITED ON. The number in the window is the server's `elapsed.ms` (lib/task-pipeline.js
// `elapsedInStage`, computed from the stored `enteredAt`), so this gate compares the drawn span with the route's own
// answer rather than timing anything. test/task-pipeline-window.test.js proves the arithmetic against a fixed clock,
// including the hour a closed panel would have hidden. The one wait here (1.2 s) is only that the VISIBLE tick moves the
// span, which is a display fact, not the arithmetic.
//
// THE BEHAVIOUR THE BRIEF NAMES. Escape closes the dialog and does NOT close the assistant rail behind it (the dialog is
// outside #assistant and stops the key); focus lands on the card when it opens and goes back to the row's own press when
// it closes; Tab three times never leaves the dialog, so nothing behind it takes the caret.
//
// THE FAILING-FIRST PROOF is the `--root` flag, on the rule the other gates use:
//   mkdir -p "$SCRATCH/main" && git archive origin/main | tar -x -C "$SCRATCH/main"
//   git -C "$SCRATCH/main" init -q -b main && git -C "$SCRATCH/main" add -A && git -C "$SCRATCH/main" commit -qm export
//   node tools/verify-task-pipeline-window.mjs --root "$SCRATCH/main"
// The base has no `#pipew`, no `.as-task-pipe` and no /api/assistant/task-pipeline, so every window check fails there —
// and no `[data-pipew-assign]` or /api/assistant/pipeline-catalogue, so the assignment control's checks fail there too,
// by name and one at a time rather than by aborting the run.
//
// Exit codes: 0 held; 1 a check failed; 2 the run did not measure what it claims (no Playwright, no rows, no dialog).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPlaywright, notRun, withBrowser } from "./browser.mjs";
import { freePort, startPanel } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const SHOTS = path.resolve(opt("--shots", path.join(os.tmpdir(), "wtgui-task-pipeline-window")));
const JSON_OUT = opt("--json");

let checks = 0;
let failures = 0;
let notMeasured = 0;
const out = { tree: TREE, checks: [], pageErrors: [], consoleErrors: [], errors: [], notMeasured: [] };
const check = (ok, label, detail = "") => {
  checks += 1;
  if (!ok) failures += 1;
  const line = `${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`;
  out.checks.push({ ok: Boolean(ok), label, detail: String(detail ?? "") });
  console.log(line);
};
const same = (label, actual, expected) => check(JSON.stringify(actual) === JSON.stringify(expected), label, `got ${JSON.stringify(actual)}`);
const ok = (label, value, detail = "") => check(Boolean(value), label, detail);
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

const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-pipewin-gate-"));
const logs = path.join(dir, "logs");
mkdirSync(path.join(logs, "assistants", "assistant-1"), { recursive: true });
mkdirSync(SHOTS, { recursive: true });
const bundleFile = path.join(logs, "pipeline-bundle.json");
writeFileSync(bundleFile, JSON.stringify(BUNDLE, null, 1), "utf8");

const ENTERED = new Date(Date.now() - 2.5 * 3_600_000).toISOString(); // 2h30m in S3 at the moment the page opens
const queueFile = path.join(logs, "assistants", "assistant-1", "queue.json");
const writeQueue = () =>
  writeFileSync(
    queueFile,
    JSON.stringify(
      {
        version: 3,
        nextId: 11,
        tasks: [
          { id: 7, title: "carry the contract", state: "running", thread: null, threads: [], files: [], pipelineRun: { pipeline: "poc-to-uat", stage: "S3", enteredAt: ENTERED } },
          { id: 8, title: "unassigned work", state: "queued", files: [], pipelineRun: null },
          { id: 9, title: "points at a pipeline that left", state: "queued", files: [], pipelineRun: { pipeline: "gone-to-uat", stage: "S1", enteredAt: ENTERED } },
          { id: 10, title: "points at a stage that left", state: "parked", files: [], pipelineRun: { pipeline: "poc-to-uat", stage: "S9", enteredAt: ENTERED } },
        ],
      },
      null,
      1,
    ),
    "utf8",
  );
writeQueue();

const pw = loadPlaywright();
if (!pw) {
  console.log(notRun("Playwright is not installed in this checkout (tools/browser.mjs could not load it)."));
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
const base = panel.base;
note(`panel ${base} on ${TREE}`);

const finish = async (code) => {
  await panel.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  if (JSON_OUT) writeFileSync(path.resolve(JSON_OUT), JSON.stringify(out, null, 1), "utf8");
  console.log(`\n${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ""}`);
  process.exit(code);
};

// The route's own answer for the same row: what the page is expected to draw, read from the panel rather than re-derived.
// Open one row's window and wait for the ANSWER, not just for the frame: the dialog paints "reading…" at once (a press
// that answered with nothing would look dead), so `#pipew:not([hidden])` alone matches before the data is in.
const openWindow = async (page, task, mode = null) => {
  await page.click(`#as-queue .as-task[data-as-qrow="${task}"] [data-as-qpipe]`);
  await page.waitForFunction(
    (want) => {
      const card = document.getElementById("pipew-card");
      const host = document.getElementById("pipew");
      if (!host || host.hidden || !card) return false;
      const got = card.dataset.pipewMode || "";
      return got && got !== "reading" && (!want || got === want);
    },
    mode,
    { timeout: 15_000, polling: 60 },
  );
};

const closeWindow = async (page) => {
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.getElementById("pipew").hidden === true, null, { timeout: 5_000 });
};

const modelOf = async (task) => {
  const r = await fetch(`${base}/api/assistant/task-pipeline?assistantId=assistant-1&task=${task}`);
  return { status: r.status, body: await r.json().catch(() => null) };
};

let browserRun = null;
try {
  browserRun = await withBrowser(async ({ page, pageErrors, consoleErrors }) => {
    page.setDefaultTimeout(20_000);
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#job-prompt", { state: "visible", timeout: 30_000 });

    await page.locator("#btn-assistant").click();
    await page.waitForSelector("#assistant", { state: "visible" });
    await page.waitForSelector('#as-subtabs [data-as-subtab="queue"]');
    await page.click('#as-subtabs [data-as-subtab="queue"]');
    await page.waitForSelector("#as-queue:not(.hidden)");
    await page.waitForFunction(() => document.querySelectorAll("#as-queue .as-task").length === 4, null, { timeout: 20_000, polling: 150 });

    // ---- 1. the rows carry the opener ------------------------------------------------------------------------
    console.log("\n== the rows: one pipeline press per task, naming what the record says ==");
    const chips = await page.$$eval("#as-queue .as-task", (rows) =>
      rows.map((row) => {
        const chip = row.querySelector(".as-task-pipe");
        return {
          task: row.dataset.asQrow,
          exists: Boolean(chip),
          tag: chip ? chip.tagName : null,
          text: chip ? chip.textContent.replace(/\s+/g, " ").trim() : null,
          title: chip ? chip.getAttribute("title") : null,
          opens: chip ? chip.dataset.asQpipe : null,
          own: chip ? chip.dataset.asQown : null,
        };
      }),
    );
    same("four rows, each with a pipeline press", chips.map((c) => [c.task, c.exists]), [["7", true], ["8", true], ["9", true], ["10", true]]);
    same("the press is a real button", [...new Set(chips.map((c) => c.tag))], ["BUTTON"]);
    same("a task on a pipeline names it and its stage", chips[0].text, "pipeline poc-to-uat · S3");
    same("a task with no assignment says the assistant decides — and still has a press", chips[1].text, "assistant decides");
    same("the press carries the ids the route needs", chips.map((c) => [c.opens, c.own]), [["7", "assistant-1"], ["8", "assistant-1"], ["9", "assistant-1"], ["10", "assistant-1"]]);

    // ---- 2. the task on a pipeline: every stage, the current one, the gate before it ---------------------------
    console.log("\n== #7 on stage 3 of 5: the sequence, the current stage, the gate that ended S2 ==");
    const model = await modelOf(7);
    same("the route answers the same row", model.status, 200);
    ok("…with the current stage the row names", model.body?.current?.id === "S3", JSON.stringify(model.body?.current));

    await openWindow(page, 7, "pipeline");
    ok("pressing the row's pipeline opens the window", await page.locator("#pipew").isVisible());
    ok("…and locks the page behind it", await page.evaluate(() => document.body.classList.contains("pipew-open")));
    ok(
      "…as a dialog, outside the rail, labelled",
      await page.evaluate(() => {
        const card = document.getElementById("pipew-card");
        const labelled = document.getElementById(card.getAttribute("aria-labelledby") || "");
        return card.getAttribute("role") === "dialog" && card.getAttribute("aria-modal") === "true" && Boolean(labelled && labelled.textContent.trim()) && !card.closest("#assistant");
      }),
    );

    const win = await page.evaluate(() => {
      const card = document.getElementById("pipew-card");
      const text = (card.innerText || "").replace(/\s+/g, " ").trim();
      const rows = [...card.querySelectorAll(".pipew-stage")].map((li) => ({
        id: li.dataset.pipewStage,
        phase: li.dataset.pipewPhase,
        current: li.classList.contains("is-current"),
        text: (li.innerText || "").replace(/\s+/g, " ").trim(),
      }));
      const elapsed = card.querySelector("[data-pipew-elapsed]");
      return {
        text,
        rows,
        title: card.querySelector(".pipew-title")?.textContent.trim() || null,
        sub: card.querySelector(".pipew-sub")?.textContent.replace(/\s+/g, " ").trim() || null,
        previous: card.querySelector(".pipew-prev")?.textContent.replace(/\s+/g, " ").trim() || null,
        elapsedText: elapsed ? elapsed.textContent.trim() : null,
        elapsedMs: elapsed ? Number(elapsed.dataset.pipewMs) : null,
        active: Boolean(document.activeElement && card.contains(document.activeElement)),
        rail: !document.getElementById("assistant").hidden,
      };
    });
    same("the stages are drawn in the pipeline's order", win.rows.map((r) => r.id), ["S1", "S2", "S3", "S4", "S5"]);
    same("…marked before / current / after", win.rows.map((r) => r.phase), ["before", "before", "current", "after", "after"]);
    same("…with exactly one current", win.rows.filter((r) => r.current).map((r) => r.id), ["S3"]);
    ok("the window names the task", /#7 carry the contract/.test(win.title || ""), win.title);
    ok("the head says the position of N and the stage's name", /3 of 5 — Shape the contract/.test(win.sub || ""), win.sub);
    ok("every stage carries its own position of N", ["1 of 5", "2 of 5", "3 of 5", "4 of 5", "5 of 5"].every((p) => win.text.includes(p)));
    ok("every stage names the artifact it produces", ["out/1.json", "out/5.json"].every((p) => win.text.includes(p)));
    ok("the gate that ended the previous stage is named", /ended the stage before — contract signed/.test(win.previous || ""), win.previous);
    ok("…with the artifact its decision is written to", /decisions\/2\.json/.test(win.previous || "") && /go, no-go/.test(win.previous || ""), win.previous);
    ok("…and the gate is drawn on the stage it ended, not the current one", win.rows[1].text.includes("contract signed") && !win.rows[2].text.includes("contract signed"));
    ok("the current stage says when it began", /began \d/.test(win.text), win.text.slice(0, 200));
    ok("the current stage's elapsed number is the route's number", Math.abs(win.elapsedMs - (model.body?.elapsed?.ms ?? -1)) < 5_000, `window ${win.elapsedMs} vs route ${model.body?.elapsed?.ms}`);
    ok("…drawn as a duration, not milliseconds", /^\d+[hms]/.test(win.elapsedText || ""), win.elapsedText);
    ok("opening put the caret in the dialog", win.active);
    ok("…and the assistant rail is still open behind it", win.rail);

    // The one wait in this gate: a VISIBLE tick moves the number. It is a display fact; the arithmetic is the unit test's.
    await page.waitForTimeout(1_200);
    const ticked = await page.evaluate(() => document.querySelector("[data-pipew-elapsed]")?.textContent.trim() || null);
    ok("the elapsed number ticks while the window is open", ticked !== win.elapsedText, `${win.elapsedText} -> ${ticked}`);

    await page.screenshot({ path: path.join(SHOTS, "pipeline-window-stage-3.png"), fullPage: false });

    // ---- 3. Escape hands the caret back to the row, and does not close the rail -------------------------------
    console.log("\n== Escape: the window closes, the caret returns to the row, the rail stays ==");
    await closeWindow(page);
    ok("Escape closes the window", await page.evaluate(() => document.getElementById("pipew").hidden));
    ok("…and the assistant rail is still there", await page.locator("#assistant").isVisible());
    const back = await page.evaluate(() => {
      const el = document.activeElement;
      return { isChip: Boolean(el && el.matches?.("[data-as-qpipe]")), task: el?.dataset?.asQpipe || null, text: el?.textContent?.trim() || null };
    });
    same("focus went back to the row's own press", [back.isChip, back.task], [true, "7"]);
    ok("…which is the press the reader made", back.text === "pipeline poc-to-uat · S3", back.text);
    ok("…and the page behind is unlocked", await page.evaluate(() => !document.body.classList.contains("pipew-open")));

    // ---- 4. nothing behind the dialog takes the caret --------------------------------------------------------
    console.log("\n== Tab: the caret stays inside the dialog ==");
    await openWindow(page, 7, "pipeline");
    const tabs = [];
    for (let i = 0; i < 3; i += 1) {
      await page.keyboard.press("Tab");
      tabs.push(await page.evaluate(() => Boolean(document.getElementById("pipew-card").contains(document.activeElement))));
    }
    same("three Tabs, three presses, all inside the dialog", tabs, [true, true, true]);

    // ---- 5. the default path, said in words ------------------------------------------------------------------
    console.log("\n== #8 with no pipeline: the DEFAULT path, and no sequence ==");
    await closeWindow(page);
    await openWindow(page, 8, "assistant-decides");
    const none = await page.evaluate(() => ({
      text: (document.getElementById("pipew-card").innerText || "").replace(/\s+/g, " ").trim(),
      stages: document.querySelectorAll("#pipew-card .pipew-stage").length,
    }));
    ok("the window says the task is on the default path", /default path/i.test(none.text), none.text.slice(0, 220));
    ok("…in the assistant's own terms", /assistant decides/i.test(none.text));
    same("…and draws no stage list", none.stages, 0);

    // ---- 5b. the control that puts it on a pipeline, and takes it back off ------------------------------------
    console.log("\n== #8 put on a pipeline from its window, and cleared back to the default ==");
    const controlLabels = [
      "the control offers every pipeline the bundle holds",
      "…and the chosen pipeline's stages, in order, with a starting stage selected",
      "…and no clear press on a task that has nothing to clear",
      "opening the control writes nothing",
      "pressing apply turns the window into the pipeline it just entered",
      "…marking the stage and its position of N",
      "…with elapsed computed from the stamp the write stored",
      "…and the row behind says which pipeline is now in force",
      "…and the queue file on disk carries the stage and a real UTC stamp",
      "an assigned task offers the way back to the default",
      "clearing turns the window back into the default path",
      "…the row behind says the assistant decides again",
      "…and the stored record is pipelineRun null, not a deleted field",
    ];
    const hasControl = (await page.locator("#pipew-card [data-pipew-assign]").count()) === 1;
    ok("the default-path window carries an assignment control", hasControl, hasControl ? "" : "no [data-pipew-assign] in this build");
    if (!hasControl) {
      // The negative control: on the base this section FAILS every check instead of aborting the run, so the report can
      // say how many of the new control's checks hold there (none) beside the window checks that already held.
      for (const label of controlLabels) check(false, label, "no assignment control in this build");
    } else {
      const form = await page.evaluate(() => {
        const card = document.getElementById("pipew-card");
        const pipe = card.querySelector("[data-pipew-pipe]");
        const stage = card.querySelector("[data-pipew-stage]");
        return {
          pipelines: pipe ? [...pipe.options].map((o) => o.value) : [],
          stages: stage ? [...stage.options].map((o) => o.value) : [],
          selectedStage: stage ? stage.value : null,
          clear: Boolean(card.querySelector("[data-pipew-clear]")),
          apply: card.querySelector("[data-pipew-apply]")?.textContent.trim() || null,
        };
      });
      same("the control offers every pipeline the bundle holds", form.pipelines, ["poc-to-uat"]);
      same("…and the chosen pipeline's stages, in order, with a starting stage selected", [form.stages, form.selectedStage], [["S1", "S2", "S3", "S4", "S5"], "S1"]);
      ok("…and no clear press on a task that has nothing to clear", form.clear === false);
      const untouched = JSON.parse(readFileSync(queueFile, "utf8")).tasks.find((x) => x.id === 8);
      ok("opening the control writes nothing", untouched.pipelineRun === null, JSON.stringify(untouched.pipelineRun));

      await page.selectOption("#pipew-card [data-pipew-pipe]", "poc-to-uat");
      await page.selectOption("#pipew-card [data-pipew-stage]", "S2");
      await page.click("#pipew-card [data-pipew-apply]");
      await page.waitForFunction(
        () => {
          const card = document.getElementById("pipew-card");
          const current = card?.querySelector(".pipew-stage.is-current");
          return card?.dataset.pipewMode === "pipeline" && current?.dataset.pipewStage === "S2";
        },
        null,
        { timeout: 15_000, polling: 80 },
      );
      const entered = await page.evaluate(() => {
        const card = document.getElementById("pipew-card");
        const current = card.querySelector(".pipew-stage.is-current");
        const row = document.querySelector('#as-queue .as-task[data-as-qrow="8"] [data-as-qpipe]');
        return {
          mode: card.dataset.pipewMode,
          stage: current?.dataset.pipewStage || null,
          text: (card.innerText || "").replace(/\s+/g, " ").trim(),
          elapsedMs: Number(card.querySelector("[data-pipew-elapsed]")?.dataset.pipewMs),
          chip: row ? row.textContent.replace(/\s+/g, " ").trim() : null,
        };
      });
      ok("pressing apply turns the window into the pipeline it just entered", entered.mode === "pipeline", entered.mode);
      ok("…marking the stage and its position of N", entered.stage === "S2" && /2 of 5/.test(entered.text), `${entered.stage} / ${entered.text.slice(0, 160)}`);
      const route = await modelOf(8);
      ok(
        "…with elapsed computed from the stamp the write stored",
        route.body?.current?.id === "S2" && Math.abs(entered.elapsedMs - (route.body?.elapsed?.ms ?? -1)) < 5_000,
        `window ${entered.elapsedMs} vs route ${route.body?.elapsed?.ms}`,
      );
      ok("…and the row behind says which pipeline is now in force", entered.chip === "pipeline poc-to-uat · S2", entered.chip);
      const stored = JSON.parse(readFileSync(queueFile, "utf8")).tasks.find((x) => x.id === 8).pipelineRun;
      ok(
        "…and the queue file on disk carries the stage and a real UTC stamp",
        stored?.pipeline === "poc-to-uat" && stored?.stage === "S2" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(String(stored?.enteredAt)),
        JSON.stringify(stored),
      );

      // The stage survives a close and a reopen — it is the RECORD, not the dialog's memory.
      await closeWindow(page);
      await openWindow(page, 8, "pipeline");
      same("the stage survives closing and reopening the window", await page.evaluate(() => document.querySelector("#pipew-card .pipew-stage.is-current")?.dataset.pipewStage || null), "S2");
      const clearable = (await page.locator("#pipew-card [data-pipew-clear]").count()) === 1;
      ok("an assigned task offers the way back to the default", clearable);

      if (clearable) {
        await page.click("#pipew-card [data-pipew-clear]");
        await page.waitForFunction(() => document.getElementById("pipew-card")?.dataset.pipewMode === "assistant-decides", null, { timeout: 15_000, polling: 80 });
        const cleared = await page.evaluate(() => ({
          mode: document.getElementById("pipew-card").dataset.pipewMode,
          chip: document.querySelector('#as-queue .as-task[data-as-qrow="8"] [data-as-qpipe]')?.textContent.replace(/\s+/g, " ").trim() || null,
        }));
        ok("clearing turns the window back into the default path", cleared.mode === "assistant-decides", cleared.mode);
        ok("…the row behind says the assistant decides again", cleared.chip === "assistant decides", cleared.chip);
        const after = JSON.parse(readFileSync(queueFile, "utf8")).tasks.find((x) => x.id === 8);
        ok("…and the stored record is pipelineRun null, not a deleted field", after.pipelineRun === null, JSON.stringify(after.pipelineRun));
      } else {
        check(false, "clearing turns the window back into the default path", "no clear press in this build");
        check(false, "…the row behind says the assistant decides again", "no clear press in this build");
        check(false, "…and the stored record is pipelineRun null, not a deleted field", "no clear press in this build");
      }
    }

    // ---- 6. the two unresolved records -----------------------------------------------------------------------
    console.log("\n== #9 and #10: a pipeline the bundle left, a stage its pipeline left ==");
    await closeWindow(page);
    await openWindow(page, 9, "unresolved");
    const gonePipeline = await page.evaluate(() => {
      const card = document.getElementById("pipew-card");
      return {
        text: (card.innerText || "").replace(/\s+/g, " ").trim(),
        current: card.querySelectorAll(".pipew-stage.is-current").length,
        stages: card.querySelectorAll(".pipew-stage").length,
        bad: Boolean(card.querySelector(".pipew-note.is-bad")),
      };
    });
    ok("a pipeline the bundle no longer holds reads UNRESOLVED", /UNRESOLVED/.test(gonePipeline.text), gonePipeline.text.slice(0, 220));
    ok("…naming the pipeline the record asked for", /gone-to-uat/.test(gonePipeline.text));
    ok("…with the reason styled as a refusal", gonePipeline.bad);
    same("…and no stage marked current", [gonePipeline.current, gonePipeline.stages], [0, 0]);
    ok("…and it says it is not falling back to the default path", /never treated as the default path/i.test(gonePipeline.text));

    await closeWindow(page);
    await openWindow(page, 10, "unresolved");
    const goneStage = await page.evaluate(() => {
      const card = document.getElementById("pipew-card");
      const rows = [...card.querySelectorAll(".pipew-stage")];
      return {
        text: (card.innerText || "").replace(/\s+/g, " ").trim(),
        phases: rows.map((r) => r.dataset.pipewPhase),
        current: card.querySelectorAll(".pipew-stage.is-current").length,
      };
    });
    ok("a stage its pipeline no longer holds reads UNRESOLVED", /UNRESOLVED/.test(goneStage.text) && /S9/.test(goneStage.text), goneStage.text.slice(0, 220));
    same("…and the sequence it still has is drawn, every row unplaced", goneStage.phases, ["unplaced", "unplaced", "unplaced", "unplaced", "unplaced"]);
    same("…with nothing marked current", goneStage.current, 0);
    await page.screenshot({ path: path.join(SHOTS, "pipeline-window-unresolved.png"), fullPage: false });

    // ---- 7b. no bundle beside the job store: unresolved with a reason, and no control that pretends --------------
    console.log("\n== the bundle removed: an assigned task reads UNRESOLVED, and the control says why it cannot offer one ==");
    await closeWindow(page);
    rmSync(bundleFile, { force: true });
    await openWindow(page, 7, "unresolved");
    const noBundle = await page.evaluate(() => {
      const card = document.getElementById("pipew-card");
      return {
        text: (card.innerText || "").replace(/\s+/g, " ").trim(),
        mode: card.dataset.pipewMode,
        apply: card.querySelectorAll("[data-pipew-apply]").length,
        stages: card.querySelectorAll(".pipew-stage").length,
      };
    });
    ok("with no bundle, an assigned task reads UNRESOLVED instead of the default path", noBundle.mode === "unresolved" && /UNRESOLVED/.test(noBundle.text), noBundle.mode);
    ok("…naming the file that is not there", /pipeline-bundle\.json/.test(noBundle.text), noBundle.text.slice(0, 220));
    same("…and no stage is marked current", noBundle.stages, 0);
    same("…and the control offers no press to assign against nothing", noBundle.apply, 0);
    ok("…saying no pipeline can be chosen, rather than an empty list", /no pipeline can be chosen/i.test(noBundle.text), noBundle.text.slice(0, 220));

    // ---- 7. the ✕, and a clean console ----------------------------------------------------------------------
    console.log("\n== the ✕ closes it, and the page logged nothing ==");
    await page.click("#pipew [data-pipew-close]");
    await page.waitForFunction(() => document.getElementById("pipew").hidden === true);
    ok("the ✕ closes the window", await page.evaluate(() => document.getElementById("pipew").hidden));
    same("no page errors", pageErrors, []);
    same("no console errors", consoleErrors, []);

    if (pageErrors.length || consoleErrors.length) out.errors.push(...pageErrors, ...consoleErrors);
  });
} catch (err) {
  out.errors.push(String((err && err.stack) || err));
  console.log(`\nFAIL  the run did not finish — ${String((err && err.message) || err)}`);
  failures += 1;
  checks += 1;
}

await finish(failures ? 1 : 0);
