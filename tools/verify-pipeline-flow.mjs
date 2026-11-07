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
//   the map        Settings > Pipeline's row and the dialog's header bar both name `public/pipeline-map.html`, and the
//                  dialog's control is FOLLOWED in this browser: the new tab's own title and its eleven cards are the
//                  proof, not the href.
//   reduced motion A second browser context asks for `prefers-reduced-motion: reduce`: the same drawing arrives with
//                  `data-motion="off"` and no animation on the current stage's mark.
//   the frame      A card that has been RESIZED is as tall as its content - the drag writes a `max-height` and no
//                  `height`, so the empty field of card background the 3285x472 capture showed under the legend is
//                  gone; the tile row keeps 8 px of headroom under the scroller's top edge, so the tiles' top border
//                  and every mark are whole; and every gate's notch is drawn INSIDE the tile it ends, so no window
//                  shape can slice it. The three are measured at 640x480 and at 1825x262 - the capture's own shape.
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

// One long definition in the LIVE catalogue, beside the seed's own: thirteen stages is the length the drawer was built
// for and the length a small window cannot hold as one row of readable columns. The seed keeps supplying its own
// definitions (the server merges the live file over them), so the dropdown checks above still see the built-ins.
const THIRTEEN = {
  id: "acceptance-thirteen",
  kind: "turnover",
  title: "Acceptance thirteen",
  description: "Thirteen stages, for the window that cannot draw them as one row.",
  stages: Array.from({ length: 13 }, (_, i) => ({
    id: `st${i + 1}`,
    title: `Stage ${i + 1} - ${["intake", "scope", "shape", "build", "check", "review", "hand over", "archive", "audit", "sign off", "publish", "follow up", "close"][i]}`,
    prompt: `Work stage ${i + 1}: read what arrived, produce the artifact, and stop when the exit check passes.`,
    exit: i % 3 === 2 ? { check: "file-exists", path: `docs/stage-${i + 1}.md` } : { check: "commits", min: 1 },
  })),
};
writeFileSync(path.join(dir, "pipelines.json"), JSON.stringify({ version: 1, note: "the flow harness's own definitions", pipelines: { [THIRTEEN.id]: THIRTEEN } }, null, 1), "utf8");

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
// A definition opens at the PREVIEW now, so every section that judges the flow drawing has to ask for it. This is the
// press a reader makes, not a state poke: the switch is part of what is being proven.
const toEditView = async (page) => {
  await page.waitForSelector('#pipeline-modal-card [data-pm-view="edit"]', { timeout: 20_000 });
  await page.click('#pipeline-modal-card [data-pm-view="edit"]');
  await page.waitForSelector("#pipeline-modal:not([hidden]) .pflow-node");
};
const openDefinitionFlow = async (page, view = "edit") => {
  await page.click("#pipeline-flow-open");
  await page.waitForSelector("#pipeline-modal:not([hidden])");
  if (view === "edit") await toEditView(page);
  else await page.waitForSelector('#pipeline-modal-card [data-pm-chart] .pm-card[data-ready="1"]', { timeout: 60_000 });
};
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
  browserRun = await withBrowser(async ({ page, context, pageErrors, consoleErrors }) => {
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

    // ---- 1a. the PREVIEW: the map page's card, read-only, and the default -------------------------------------
    console.log("\n== the preview: the map page's chart, opened by default and read-only ==");
    await page.click("#pipeline-flow-open");
    await page.waitForSelector("#pipeline-modal:not([hidden])");
    await page.waitForSelector('#pipeline-modal-card [data-pm-chart] .pm-card[data-ready="1"]', { timeout: 60_000 });
    const prev = await page.evaluate(() => {
      const card = document.getElementById("pipeline-modal-card");
      const host = card.querySelector("[data-pm-chart]");
      const pc = host && host.querySelector(".pm-card");
      const views = [...card.querySelectorAll("[data-pm-view]")].map((b) => ({ view: b.dataset.pmView, pressed: b.getAttribute("aria-pressed"), text: (b.textContent || "").trim() }));
      return {
        views,
        note: (card.querySelector(".pmodal-views-note")?.textContent || "").trim(),
        hasFlow: Boolean(card.querySelector(".pflow")),
        chartId: host?.dataset.chartId || "",
        chartStages: Number(host?.dataset.chartStages || 0),
        cardStages: Number(pc?.dataset.stages || 0),
        cardBundle: pc?.dataset.bundle || "",
        nodes: [...(pc?.querySelectorAll("g.node[data-stage]") || [])].map((n) => ({
          id: n.getAttribute("data-stage"),
          role: n.getAttribute("data-role-label") || "",
          pressed: n.getAttribute("role") || "",
          tab: n.getAttribute("tabindex"),
          title: (n.getAttribute("title") || "").slice(0, 40),
          text: (n.querySelector(".nodeLabel")?.textContent || "").replace(/\s+/g, " ").trim(),
        })),
        edges: [...(pc?.querySelectorAll(".edgeLabel") || [])].map((e) => (e.textContent || "").trim()).filter(Boolean),
        status: (pc?.querySelector("[data-status]")?.textContent || "").replace(/\s+/g, " ").trim(),
        statusRaw: pc?.querySelector("[data-status]")?.innerHTML || "",
        loops: (pc?.querySelector(".pm-loops")?.textContent || "").replace(/\s+/g, " ").trim(),
        bodyText: (card.querySelector(".pmodal-body")?.textContent || "").replace(/\s+/g, " ").trim(),
      };
    });
    check(prev.views.length === 2 && prev.views[0].view === "preview" && prev.views[0].pressed === "true", "the definition opens on preview, and the switch says which view is up", JSON.stringify(prev.views));
    check(/read-?only/i.test(prev.note), "and the preview is labelled read-only", prev.note);
    check(!prev.hasFlow, "the preview is NOT the hand-built flow drawing");
    check(prev.chartId === multi && prev.chartStages === catalogue.pipelines[multi].stages.length, "the chart is the definition the dropdown names, with every stage", `${prev.chartId} ${prev.chartStages}`);
    check(prev.cardStages === catalogue.pipelines[multi].stages.length && prev.cardBundle === "0", "the card is one definition's card, not a bundle's", `${prev.cardStages} stages, bundle=${prev.cardBundle}`);
    equal("every stage of the definition is drawn, in order", prev.nodes.map((n) => n.id), catalogue.pipelines[multi].stages.map((s) => s.id));
    check(prev.nodes.every((n) => /^\d+ · /.test(n.text)), "each node is ordinal and title", JSON.stringify(prev.nodes.map((n) => n.text)));
    check(prev.nodes.every((n) => /^(derived|role): /.test(n.role)), "and a role line the closed table or the definition supplies", JSON.stringify(prev.nodes.map((n) => n.role)));
    check(prev.nodes.every((n) => n.title), "every node carries its prompt on hover");
    check(prev.nodes.every((n) => !n.pressed && n.tab === null), "a read-only chart offers no press it would not honour: the nodes are not buttons", JSON.stringify(prev.nodes.map((n) => `${n.id}:${n.pressed}/${n.tab}`)));
    // The card's own status sentence carries the arrow count: `<b>1</b> arrows · 1 labelled`. Reading it, rather than
    // counting `.edgeLabel` nodes, is the same measurement the map page prints (mermaid nests two label nodes per edge).
    const arrows = /<b>(\d+)<\/b> arrows · (\d+) labelled/.exec(prev.statusRaw || "");
    check(
      Boolean(arrows) && Number(arrows[1]) === Math.max(0, catalogue.pipelines[multi].stages.length - 1) && Number(arrows[2]) === Number(arrows[1]),
      "the exit check that ends each stage labels the arrow that leaves it",
      arrows ? `${arrows[1]} arrows, ${arrows[2]} labelled` : prev.status.slice(0, 120),
    );
    check(/nodes drawn/.test(prev.status) && /smallest label/.test(prev.status), "the card's status line is the map page's own measurement", prev.status);
    check(prev.loops.includes("loop-backs"), "and the loop-backs list travels with the card", prev.loops.slice(0, 80));
    await page.screenshot({ path: path.join(SHOTS, "preview-mode.png") });

    // ---- 1b. the switch to the flow drawing ---------------------------------------------------------------
    await toEditView(page);
    check(!(await page.evaluate(() => Boolean(document.querySelector("[data-pm-chart] .pm-card")))), "the edit view replaces the chart rather than stacking under it");
    const backToPreview = await page.evaluate(() => {
      const b = document.querySelector('#pipeline-modal-card [data-pm-view="preview"]');
      return b ? b.getAttribute("aria-pressed") : null;
    });
    check(backToPreview === "false", "and the switch's pressed state moved with it", String(backToPreview));
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

    // ---- 1b. the map: both doors, and one of them followed ---------------------------------------------------
    // The page `public/pipeline-map.html` drew the whole library and the panel named it nowhere; these two controls
    // are the doors. The proof is not the href: it is a real press, a new tab, and the page's OWN title.
    console.log("\n== the map: a control on both pipeline surfaces, and a real page behind it ==");
    const inBar = await page.evaluate(() => {
      const card = document.getElementById("pipeline-modal-card");
      const bar = card && card.querySelector(".pmodal-bar");
      const a = card && card.querySelector("[data-pm-map]");
      if (!a || !bar || !bar.contains(a)) return null;
      return { href: a.getAttribute("href"), target: a.getAttribute("target"), rel: a.getAttribute("rel"), text: (a.textContent || "").trim() };
    });
    check(Boolean(inBar), "the flow dialog's header bar carries a map control", JSON.stringify(inBar));
    check(inBar && inBar.href === "/pipeline-map.html", "and it names the page", inBar && inBar.href);
    check(inBar && inBar.target === "_blank" && /\bnoopener\b/.test(inBar.rel || ""), "in its own tab, with no window.opener", inBar && `${inBar.target} ${inBar.rel}`);
    check(inBar && /map/i.test(inBar.text), "and the words on it say map", inBar && inBar.text);

    // The Settings row, behind the dialog: the same page with a door of its own.
    const mapRow = await page.evaluate(() => {
      const a = document.getElementById("pipeline-map-open");
      if (!a) return null;
      const panel = a.closest('[data-settings-group="pipeline"]');
      const others = [...document.querySelectorAll("[data-settings-group]")].filter(
        (p) => p !== panel && p.querySelector('a[href="/pipeline-map.html"]'),
      ).length;
      return { href: a.getAttribute("href"), target: a.getAttribute("target"), rel: a.getAttribute("rel"), inPipeline: Boolean(panel), others, text: (a.textContent || "").trim() };
    });
    check(Boolean(mapRow), "Settings > Pipeline carries the map row", JSON.stringify(mapRow));
    check(mapRow && mapRow.href === "/pipeline-map.html" && mapRow.inPipeline, "the same page, in the panel that owns the catalogue", mapRow && `${mapRow.href} in pipeline=${mapRow.inPipeline}`);
    check(mapRow && mapRow.target === "_blank" && /\bnoopener\b/.test(mapRow.rel || ""), "also in its own tab, with no window.opener", mapRow && `${mapRow.target} ${mapRow.rel}`);
    check(mapRow && mapRow.others === 0, "and no other settings tab offers it", mapRow && String(mapRow.others));

    // FOLLOW the dialog's control. `context` is this harness's own browser context, so the press's new tab is a
    // page this run can read — the assertion is the page's title and its cards, never the href it was built with.
    const [mapTab] = await Promise.all([context.waitForEvent("page", { timeout: 20_000 }), page.click("#pipeline-modal-card [data-pm-map]")]);
    await mapTab.waitForSelector(".pm-card", { timeout: 30_000 });
    const mapPage = await mapTab.evaluate(() => ({
      title: document.title,
      h1: (document.querySelector("h1")?.textContent || "").trim(),
      cards: document.querySelectorAll(".pm-card").length,
      generated: document.querySelector('meta[name="wtgui-generated"]')?.getAttribute("content") || "",
    }));
    check(/^Every pipeline the panel can put a tree on/.test(mapPage.title), "following it lands on the page's own title", mapPage.title);
    check(mapPage.cards >= 11, "and the page draws the pipelines it says it draws", `${mapPage.cards} cards, generated ${mapPage.generated}`);
    const panelStill = await page.evaluate(() => ({
      path: location.pathname,
      modal: !document.getElementById("pipeline-modal").hidden,
      mode: document.getElementById("pipeline-modal").dataset.mode,
    }));
    check(panelStill.path === "/" && panelStill.modal && panelStill.mode === "edit", "the panel's own tab still holds the dialog — the map took a tab of its own", JSON.stringify(panelStill));
    await mapTab.close();
    await page.screenshot({ path: path.join(SHOTS, "map-control.png") });

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
    equal("the legend counts the marks on screen, and only those", pos.legend, ["not-reached:not reached 1 stage", "current:current 1 stage", "done:done 3 stages"]);
    equal("the gate that ends S2 is one notch", pos.notches, ["g2"]);
    equal("the capped loop is one arc, labelled with its cap only", pos.arcs, [{ cap: "2 rounds", from: "S4", to: "S2", label: "2 rounds" }]);
    check(pos.arcAboveTrack, "and it is drawn above the track, not over the stages");
    check(/2 rounds/.test(pos.note) === false, "the cap is on the arc, not repeated in the note");
    check(pos.preview, "the position preview is offered");
    const posMap = await page.evaluate(() => document.querySelector("#pipeline-modal-card [data-pm-map]")?.getAttribute("href") || "");
    check(posMap === "/pipeline-map.html", "the same header carries the map in position mode too — it draws one pipeline of the library", posMap);
    equal("the preview lists every stage", pos.stageOptions, ["S0", "S1", "S2", "S3", "S4"]);
    await page.screenshot({ path: path.join(SHOTS, "position-mode.png") });

    // ---- 3. moving the position -----------------------------------------------------------------------------
    console.log("\n== moving it: the preview moves the drawing and writes nothing ==");
    await page.selectOption("[data-pm-stage]", "S1");
    await page.waitForTimeout(150);
    const moved = await readModal(page);
    equal("S1 is now the current stage", marks(moved), ["S0:done", "S1:current", "S2:not-reached", "S3:not-reached", "S4:not-reached"]);
    equal("the legend followed", moved.legend, ["not-reached:not reached 3 stages", "current:current 1 stage", "done:done 1 stage"]);

    await page.click(".pmodal-check input[data-pm-refused]");
    await page.waitForTimeout(150);
    const refused = await readModal(page);
    equal("`stage refused` marks that stage refused", marks(refused), ["S0:done", "S1:refused", "S2:not-reached", "S3:not-reached", "S4:not-reached"]);
    equal("and the legend says one refused, and no current stage", refused.legend, ["not-reached:not reached 3 stages", "done:done 1 stage", "refused:refused 1 stage"]);
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

    // ---- 6. a small window: every stage readable, and the card is a window ------------------------------------------
    // The reader's complaint this round answers: at a window a laptop can be shrunk to, a thirteen-stage definition was
    // one row of columns wider than the card, with eight stages behind a scroll bar and a count under it. The card now
    // drags and resizes, and a drawing that cannot be a readable row WRAPS into rows of readable columns, so the check
    // is not "a count says how much is hidden" but "nothing is hidden, and the frame is the reader's".
    console.log("\n== a small window: thirteen stages stay readable, and the card drags and resizes ==");
    await page.setViewportSize({ width: 640, height: 480 });
    await page.waitForTimeout(220);
    const readSmall = () =>
      page.evaluate(() => {
        const card = document.getElementById("pipeline-modal-card");
        const scroll = card.querySelector(".pflow-scroll");
        const box = (el) => {
          const b = el.getBoundingClientRect();
          return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), right: Math.round(b.right), bottom: Math.round(b.bottom) };
        };
        const cardBox = box(card);
        const scrollBox = box(scroll);
        const nodes = [...card.querySelectorAll(".pflow-node")].map((n) => ({ id: n.dataset.stage, ...box(n) }));
        const body = card.querySelector(".pmodal-body");
        return {
          vw: innerWidth,
          vh: innerHeight,
          card: cardBox,
          body: { sh: body.scrollHeight, ch: body.clientHeight, overflowY: getComputedStyle(body).overflowY },
          scroll: { ...scrollBox, sw: scroll.scrollWidth, cw: scroll.clientWidth },
          wrap: card.querySelector(".pflow")?.dataset.wrap,
          rows: new Set(nodes.map((n) => n.y)).size,
          nodes,
          clipped: nodes.filter((n) => n.x < cardBox.x || n.right > cardBox.right || n.y < cardBox.y || n.bottom > cardBox.bottom).map((n) => n.id),
          offWindow: nodes.filter((n) => n.x < 0 || n.right > innerWidth || n.y < 0 || n.bottom > innerHeight).map((n) => n.id),
          statusHidden: Boolean(card.querySelector("[data-pflow-status]")?.hidden),
          style: card.getAttribute("style") || "",
        };
      });
    // The FRAME of the drawing, measured where the three reported defects lived: the card's own height against the
    // last row it painted (an empty field below the legend), the scroller's top edge against the tiles (a clipped
    // top border and half marks), and every gate's notch against the tile that owns it (a notch hung in the gap).
    const readFrame = () =>
      page.evaluate(() => {
        const card = document.getElementById("pipeline-modal-card");
        if (!card) return null;
        const scroll = card.querySelector(".pflow-scroll");
        const sb = scroll.getBoundingClientRect();
        const nodes = [...card.querySelectorAll(".pflow-node")];
        const rect = (el) => {
          const b = el.getBoundingClientRect();
          return { x: b.left, y: b.top, w: b.width, h: b.height, right: b.right, bottom: b.bottom };
        };
        const painted = [...card.querySelectorAll(".pflow-node, .pflow-legend, .pflow-status, .pflow-artifact-key")].filter((el) => el.getBoundingClientRect().height > 0);
        const lastPainted = Math.max(...painted.map((el) => el.getBoundingClientRect().bottom));
        const body = card.querySelector(".pmodal-body");
        return {
          vw: innerWidth,
          vh: innerHeight,
          card: rect(card),
          cardStyle: card.getAttribute("style") || "",
          cardMax: getComputedStyle(card).maxHeight,
          cardHeight: getComputedStyle(card).height,
          body: { sh: body.scrollHeight, ch: body.clientHeight, oy: getComputedStyle(body).overflowY },
          emptyField: +(card.getBoundingClientRect().bottom - lastPainted).toFixed(1),
          scroll: { top: sb.top, bottom: sb.bottom, left: sb.left, right: sb.right, sw: scroll.scrollWidth, cw: scroll.clientWidth },
          // Above the tallest tile's own top edge: the band the scroller clips if the row has no headroom.
          headroom: +Math.min(...nodes.map((n) => n.getBoundingClientRect().top - sb.top)).toFixed(1),
          // How much of the worst mark sits above the scroller's top edge. 0 is a whole dot.
          markCut: +Math.max(0, ...nodes.map((n) => sb.top - (n.querySelector(".pflow-dot")?.getBoundingClientRect().top ?? sb.top))).toFixed(1),
          notches: nodes.flatMap((n) =>
            [...n.querySelectorAll(".pflow-notch")].map((notch) => {
              const nr = notch.getBoundingClientRect();
              const tr = n.getBoundingClientRect();
              return {
                stage: n.dataset.stage,
                gate: notch.dataset.gate,
                inside: nr.left >= tr.left - 0.5 && nr.right <= tr.right + 0.5 && nr.top >= tr.top - 0.5 && nr.bottom <= tr.bottom + 0.5,
                outX: +Math.max(0, tr.left - nr.left, nr.right - tr.right).toFixed(1),
                outY: +Math.max(0, tr.top - nr.top, nr.bottom - tr.bottom).toFixed(1),
              };
            }),
          ),
          wrap: card.querySelector(".pflow")?.dataset.wrap,
        };
      });

    // The three defects, as three measurements. `where` names the window shape so a failure points at one.
    const checkFrame = (where, m) => {
      const outside = m.notches.filter((n) => !n.inside);
      check(
        outside.length === 0,
        `${where}: every gate notch is drawn inside the tile it ends - nothing hangs in the gap to be cut`,
        `${m.notches.length} notches, ${outside.length} outside${outside.length ? ` (${outside.map((n) => `${n.stage}:${n.gate} by ${n.outX}x${n.outY} px`).join(", ")})` : ""}`,
      );
      check(m.headroom >= 6, `${where}: the tile row keeps headroom under the scroller's top edge`, `${m.headroom} px above the tallest tile (the marks overhang 5 px)`);
      check(m.markCut === 0, `${where}: no stage's mark is sliced by the scroller`, `worst mark cut ${m.markCut} px`);
    };
    // A card that has been RESIZED is as tall as its content: the empty field under its last row is the frame's own
    // 2 px of padding, and its inline geometry carries a max-height, never a height.
    const checkFollowsContent = (where, m) => {
      check(m.emptyField <= 4, `${where}: the resized card's height stops at its content - no empty field under the legend`, `${m.emptyField} px below the last painted row (card ${Math.round(m.card.h)} px, body ${m.body.ch}/${m.body.sh})`);
      check(!/(^|;)\s*height:/.test(m.cardStyle), `${where}: the card carries no pinned height`, m.cardStyle || "(no inline geometry)");
      check(/max-height:\s*\d+px/.test(m.cardStyle), `${where}: the resize wrote the ceiling the body may grow into`, m.cardStyle || "(no inline geometry)");
    };

    const gesture = async (handle, dx, dy) => {
      const at = await page.$eval(handle, (el) => {
        const b = el.getBoundingClientRect();
        return { x: b.left + Math.min(10, b.width / 2), y: b.top + b.height / 2 };
      });
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await page.mouse.move(at.x + dx, at.y + dy, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(160);
    };
    await openSettingsGroup(page, "pipeline");
    await page.waitForFunction(() => !/reading/.test(document.getElementById("pipeline-summary")?.textContent || ""), null, { timeout: 20_000 });
    await page.selectOption("#pipeline-select", THIRTEEN.id);
    await page.waitForSelector("#pipeline-editor:not([hidden]) .pipeline-stage", { timeout: 15_000 });
    await openDefinitionFlow(page);
    await page.waitForTimeout(260);
    const small = await readSmall();
    equal("the thirteen-stage definition is drawn in rows at a 640x480 window", small.wrap, "1");
    check(small.rows > 1, "and the rows are real rows, not one clipped line", `${small.rows} rows`);
    equal("every stage of the definition is drawn", small.nodes.map((n) => n.id), THIRTEEN.stages.map((s) => s.id));
    check(small.scroll.sw <= small.scroll.cw + 1, "the drawing needs no horizontal scroll - no stage is behind a bar", `${small.scroll.sw} <= ${small.scroll.cw}`);
    equal("no stage is clipped by the card or the window", { inCard: small.clipped, offWindow: small.offWindow }, { inCard: [], offWindow: [] });
    check(small.statusHidden, "and no count row is offered over a drawing that holds all thirteen");
    // The three defects the 3285x472 capture reported, measured on this drawing: no notch outside its tile, the row's
    // headroom under the scroller's edge, and every mark whole.
    checkFrame("640x480", await readFrame());
    await page.screenshot({ path: path.join(SHOTS, "small-window.png") });

    // The corner grip resizes, and the header bar drags: both are the reader's frame, and both are measured on the
    // card's own rect, not on a state variable.
    await gesture("#pipeline-modal-card [data-pm-resize]", -160, -90);
    const sized = await readSmall();
    check(sized.card.w <= small.card.w - 140 && sized.card.h <= small.card.h - 70, "the corner grip resizes the card", `${small.card.w}x${small.card.h} -> ${sized.card.w}x${sized.card.h}`);
    await gesture("#pipeline-modal-card .pmodal-bar", 40, 50);
    const dragged = await readSmall();
    equal("the header bar drags the card by the pointer's own travel", { dx: dragged.card.x - sized.card.x, dy: dragged.card.y - sized.card.y }, { dx: 40, dy: 50 });
    check(dragged.card.x >= 0 && dragged.card.y >= 0 && dragged.card.right <= dragged.vw && dragged.card.bottom <= dragged.vh, "and it stays fully inside the window", JSON.stringify(dragged.card));
    check(dragged.scroll.sw <= dragged.scroll.cw + 1, "no stage is behind a horizontal bar after the resize either", `${dragged.scroll.sw} <= ${dragged.scroll.cw}`);
    check(dragged.body.overflowY === "auto", "and the rows below the fold scroll inside the card rather than being cut off", `body ${dragged.body.ch}/${dragged.body.sh} px, overflow-y ${dragged.body.overflowY}`);
    await page.screenshot({ path: path.join(SHOTS, "small-window-resized.png") });

    // Growing it is the defect the capture showed: the card used to be pinned to the new rectangle, so every pixel the
    // drawing did not ask for was an empty field of the card's own background. Now the drag sets a ceiling and the
    // card stops at its content.
    await gesture("#pipeline-modal-card [data-pm-resize]", 40, 150);
    checkFollowsContent("640x480 after growing the card", await readFrame());
    await page.screenshot({ path: path.join(SHOTS, "small-window-grown.png") });

    // A fresh open is the stylesheet's card again: the place and size belong to the drawing the reader was looking at.
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("pipeline-modal").hidden === true, null, { timeout: 5_000 });
    await openDefinitionFlow(page);
    await page.waitForTimeout(160);
    const again = await readSmall();
    check(!/left:|top:|width:/.test(again.style), "a fresh open is the stylesheet's centred card again", again.style || "(no inline geometry)");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("pipeline-modal").hidden === true, null, { timeout: 5_000 });

    // ---- 7. the wide, short window: the reader's own shape -------------------------------------------------------
    // 1825x262 CSS px is the 3285x472 capture at its own device pixel ratio: a card as wide as the window allows, a
    // short glass, one row of thirteen columns. All three defects were reported at this shape, and they are the same
    // three measurements taken again - a drawing whose legend is followed by a field of nothing, a row of half marks
    // along the scroller's edge, and a notch hanging in a gap.
    console.log("\n== a wide, short window: the capture's own shape ==");
    await page.setViewportSize({ width: 1825, height: 262 });
    await page.waitForTimeout(220);
    await openSettingsGroup(page, "pipeline");
    await page.waitForFunction(() => !/reading/.test(document.getElementById("pipeline-summary")?.textContent || ""), null, { timeout: 20_000 });
    await page.selectOption("#pipeline-select", THIRTEEN.id);
    await page.waitForSelector("#pipeline-editor:not([hidden]) .pipeline-stage", { timeout: 15_000 });
    await openDefinitionFlow(page);
    await page.waitForTimeout(240);
    const wide = await readFrame();
    equal("the thirteen-stage definition is one row at 1825x262, not a wrapped stack", wide.wrap, "0");
    check(wide.card.bottom <= wide.vh - 6, "and the card sits inside the short window", `card bottom ${Math.round(wide.card.bottom)} of ${wide.vh}`);
    check(wide.emptyField <= 4, "the card is exactly as tall as its drawing - no empty field under the legend", `${wide.emptyField} px below the last painted row (card ${Math.round(wide.card.h)} px)`);
    checkFrame("1825x262", wide);
    await page.screenshot({ path: path.join(SHOTS, "wide-short.png") });
    // Growing it here is the capture's own sequence: at this shape the drawing is a third of the card's height, so a
    // pinned height is a field of the card's background under the legend. The grip sets a ceiling now, and the card
    // still stops at its content.
    await gesture("#pipeline-modal-card [data-pm-resize]", 30, 60);
    checkFollowsContent("1825x262 after growing the card", await readFrame());
    await page.screenshot({ path: path.join(SHOTS, "wide-short-grown.png") });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("pipeline-modal").hidden === true, null, { timeout: 5_000 });

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
