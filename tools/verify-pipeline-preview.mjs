#!/usr/bin/env node
// tools/verify-pipeline-preview.mjs - the dialog's Preview, proven against the page it copies.
//
// The reader asked why the popup could not have the map page's flow charts. The answer in code is one shared module
// (public/core/pipeline-mermaid.js) drawn by both surfaces; this harness is the answer in evidence, and it drives a
// real Chromium against a throwaway panel of its own:
//
//   1. SAME DEFINITION, SAME CARD. The map page's card for `turnover` and the dialog's preview for the same
//      definition are read node by node, edge by edge, label by label, and compared. A comparison of the DRAWING
//      (stages, ordinal + title, the role line, the arrow labels, the status sentence's counts) - the map's card
//      head is the page's own chrome, which the dialog's bar replaces.
//   2. PREVIEW IS THE DEFAULT, READ-ONLY, AND SWITCHABLE. Opening `open the flow` lands on preview, the switch
//      offers both views with the pressed one marked, the chart's nodes offer no press, and the edit view is the
//      flow drawing this dialog always had.
//   3. THE TOGGLE KEEPS THE EDIT. A stage title is typed into the Settings editor (the draft), the dialog is opened,
//      switched preview -> edit -> preview, closed - and the field still holds the typed text, the tab still says
//      "unsaved changes", and the chart drew the EDITED title rather than the stored one.
//   4. THE EDITOR STILL DRAGS. In the edit view the bar drags the card and the corner grip resizes it; the frame the
//      reader made survives a switch to preview and back.
//
//   node tools/verify-pipeline-preview.mjs                 # assert; exit 0 green, 1 red
//   node tools/verify-pipeline-preview.mjs --shots <dir>   # screenshots of both views
//   node tools/verify-pipeline-preview.mjs --json <file>   # the raw ledger
//
// Exit codes: 0 pass; 1 a failed check; 2 the browser half could not run (no Playwright).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPlaywright, notRun, openSettingsGroup, withBrowser } from "./browser.mjs";
import { freePort, startPanel } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const SHOTS = path.resolve(opt("--shots", path.join(os.tmpdir(), "wtgui-pipeline-preview")));
const JSON_OUT = opt("--json");

let checks = 0;
let failures = 0;
const out = { tree: TREE, checks: [], pageErrors: [], consoleErrors: [], errors: [] };
const check = (ok, label, detail = "") => {
  checks += 1;
  if (!ok) failures += 1;
  out.checks.push({ ok: Boolean(ok), label, detail: String(detail ?? "") });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
};
const equal = (label, actual, expected) => check(JSON.stringify(actual) === JSON.stringify(expected), label, `got ${JSON.stringify(actual)}`);
const note = (text) => console.log(`      ${text}`);

const pw = loadPlaywright();
if (!pw) {
  console.log(notRun("the dialog's preview was not exercised in a browser", "Playwright is not installed in this checkout (tools/browser.mjs could not load it)."));
  process.exit(2);
}

const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-pipeline-preview-"));
mkdirSync(SHOTS, { recursive: true });

const port = await freePort();
const panel = await startPanel({
  dir,
  port,
  root: TREE,
  keep: true,
  config: {
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

// ONE reader for one card, on either surface: the drawing's own facts, never the page's arrangement of them.
const readCard = (sel) => {
  const card = document.querySelector(sel);
  if (!card) return null;
  const draw = card.querySelector("[data-draw]");
  const status = (card.querySelector("[data-status]")?.textContent || "").replace(/\s+/g, " ").trim();
  const edges = [...draw.querySelectorAll("g.edgeLabel")].map((e) => (e.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean);
  return {
    id: card.dataset.card,
    stages: Number(card.dataset.stages),
    drawn: Number(card.dataset.nodeCount),
    loopPaths: Number(card.dataset.loopCount),
    nodes: [...draw.querySelectorAll("g.node[data-stage]")].map((n) => ({
      id: n.getAttribute("data-stage"),
      role: n.getAttribute("data-role-label"),
      source: n.getAttribute("data-role-source"),
      text: (n.querySelector(".nodeLabel")?.textContent || "").replace(/\s+/g, " ").trim(),
      hover: (n.getAttribute("title") || "").slice(0, 60),
      press: `${n.getAttribute("role") || ""}/${n.getAttribute("tabindex") || ""}`,
    })),
    edges: [...new Set(edges)],
    // Everything before the width-dependent tail ("N px past the card", "N of M in view"): the page and a 900 px
    // dialog do not fit the same pixels, and the claim here is the CARD's content, not the window it was given.
    counts: status.split("smallest label")[0].trim() + (status.includes("smallest label") ? " smallest label present" : ""),
    loops: (card.querySelector(".pm-loops")?.textContent || "").replace(/\s+/g, " ").trim(),
    gates: (card.querySelector(".pm-gates")?.textContent || "").replace(/\s+/g, " ").trim(),
  };
};

let result;
try {
  result = await withBrowser(async ({ page, context, pageErrors, consoleErrors }) => {
    page.setDefaultTimeout(20_000);
    await page.goto(panel.base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#job-prompt", { state: "visible", timeout: 30_000 });

    // ---- the same definition on both surfaces -------------------------------------------------------------
    console.log("\n== one definition, two surfaces ==");
    const catalogue = await page.evaluate(async () => (await fetch("/api/pipelines")).json());
    const ID = "turnover";
    const def = catalogue.pipelines[ID];
    check(Boolean(def && def.stages.length === 3), "the catalogue carries the turnover definition", def ? `${def.stages.length} stages` : "missing");

    const mapTab = await context.newPage();
    await mapTab.goto(`${panel.base}/pipeline-map.html`, { waitUntil: "domcontentloaded" });
    await mapTab.waitForSelector(`.pm-card[data-card="${ID}"][data-ready="1"]`, { timeout: 60_000 });
    const mapCard = await mapTab.evaluate(readCard, `.pm-card[data-card="${ID}"]`);
    check(mapCard && mapCard.drawn === 3, "the map page drew the turnover card", mapCard ? `${mapCard.drawn} nodes` : "missing");
    await mapTab.screenshot({ path: path.join(SHOTS, "map-turnover.png"), fullPage: false });
    await mapTab.close();

    await openSettingsGroup(page, "pipeline");
    await page.waitForFunction(() => !/reading/.test(document.getElementById("pipeline-summary")?.textContent || ""), null, { timeout: 20_000 });
    await page.selectOption("#pipeline-select", ID);
    await page.waitForSelector("#pipeline-editor:not([hidden]) .pipeline-stage", { timeout: 15_000 });
    await page.click("#pipeline-flow-open");
    await page.waitForSelector("#pipeline-modal:not([hidden])");
    await page.waitForSelector(`#pipeline-modal-card [data-pm-chart] .pm-card[data-card="${ID}"][data-ready="1"]`, { timeout: 60_000 });
    const dlgCard = await page.evaluate(readCard, "#pipeline-modal-card [data-pm-chart] .pm-card");

    // The comparison the reader asked for. Every stage, its ordinal + title, its role line and its source; every
    // arrow label; the counts the status line prints; the loop list and the gates list.
    equal("the same definition draws the SAME stages, in the same order", dlgCard.nodes.map((n) => n.id), mapCard.nodes.map((n) => n.id));
    equal("with the same ordinal, title and role on every node", dlgCard.nodes.map((n) => n.text), mapCard.nodes.map((n) => n.text));
    equal("and the same role line and role source", dlgCard.nodes.map((n) => `${n.role}|${n.source}`), mapCard.nodes.map((n) => `${n.role}|${n.source}`));
    equal("the same arrows, labelled by the same exit checks", dlgCard.edges, mapCard.edges);
    equal("the same counts on the card's status line", dlgCard.counts, mapCard.counts);
    check(mapCard.counts.includes("3 nodes drawn") && mapCard.counts.includes("2 arrows"), "the status line is the measurement, not a tally of the document", mapCard.counts);
    equal("the same loop-backs list", dlgCard.loops, mapCard.loops);
    equal("and the same gates list (none, for a definition)", dlgCard.gates, mapCard.gates);
    check(mapCard.nodes.every((n) => n.hover) && dlgCard.nodes.every((n) => n.hover), "every node carries its prompt on hover on both surfaces");
    await page.screenshot({ path: path.join(SHOTS, "dialog-preview.png") });

    // ---- preview is the default, read-only, and switchable ------------------------------------------------
    console.log("\n== the default view, and the switch ==");
    const views = await page.evaluate(() => {
      const card = document.getElementById("pipeline-modal-card");
      return {
        buttons: [...card.querySelectorAll("[data-pm-view]")].map((b) => ({ view: b.dataset.pmView, pressed: b.getAttribute("aria-pressed"), text: (b.textContent || "").trim() })),
        note: (card.querySelector(".pmodal-views-note")?.textContent || "").trim(),
        hasFlow: Boolean(card.querySelector(".pflow")),
        chartNodes: card.querySelectorAll("[data-pm-chart] g.node[data-stage]").length,
      };
    });
    equal("the dialog opens on preview", views.buttons.map((b) => `${b.text}:${b.pressed}`), ["preview:true", "edit:false"]);
    check(/read-?only/i.test(views.note), "the preview says it is read-only", views.note);
    check(!views.hasFlow && views.chartNodes === 3, "and the hand-built flow drawing is not what is up", `flow=${views.hasFlow}, chart nodes=${views.chartNodes}`);
    check(dlgCard.nodes.every((n) => n.press === "/"), "the chart's stages offer no press a read-only view would not honour", JSON.stringify(dlgCard.nodes.map((n) => n.press)));
    await page.click('#pipeline-modal-card [data-pm-view="edit"]');
    await page.waitForSelector("#pipeline-modal:not([hidden]) .pflow-node");
    const editView = await page.evaluate(() => ({
      pflow: document.querySelectorAll("#pipeline-modal-card .pflow-node").length,
      chart: document.querySelectorAll("#pipeline-modal-card [data-pm-chart] .pm-card").length,
      pressed: [...document.querySelectorAll("#pipeline-modal-card [data-pm-view]")].map((b) => `${b.dataset.pmView}:${b.getAttribute("aria-pressed")}`),
    }));
    equal("edit is the flow drawing, and the switch moved", [editView.pflow, editView.chart, editView.pressed], [3, 0, ["preview:false", "edit:true"]]);
    await page.screenshot({ path: path.join(SHOTS, "dialog-edit.png") });

    // ---- the toggle keeps the edit ------------------------------------------------------------------------
    console.log("\n== the toggle keeps the edit ==");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("pipeline-modal").hidden === true, null, { timeout: 5_000 });
    const EDITED = "Commit (edited in the tab)";
    await page.fill('#pipeline-editor .pipeline-stage[data-stage-index="0"] .stage-title', EDITED);
    const dirty = await page.evaluate(() => ({
      value: document.querySelector('#pipeline-editor .pipeline-stage[data-stage-index="0"] .stage-title')?.value || "",
      status: (document.getElementById("pipeline-status")?.textContent || "").trim(),
    }));
    check(dirty.value === EDITED && /unsaved/i.test(dirty.status), "the tab holds an unsaved edit before the dialog is opened", `${JSON.stringify(dirty.value)} / ${dirty.status}`);

    await page.click("#pipeline-flow-open");
    await page.waitForSelector("#pipeline-modal:not([hidden])");
    await page.waitForSelector("#pipeline-modal-card [data-pm-chart] .pm-card[data-ready='1']", { timeout: 60_000 });
    const firstText = await page.evaluate(() => (document.querySelector("#pipeline-modal-card [data-pm-chart] .pm-card g.node[data-stage] .nodeLabel")?.textContent || "").replace(/\s+/g, " ").trim());
    check(firstText.includes("Commit (edited in the tab)"), "the preview draws the DRAFT, not the stored definition", firstText);
    const sub = await page.evaluate(() => (document.querySelector("#pipeline-modal-card .pmodal-sub")?.textContent || "").trim());
    check(/unsaved/i.test(sub), "and the dialog says the definition underneath it is unsaved", sub);

    await page.click('#pipeline-modal-card [data-pm-view="edit"]');
    await page.waitForSelector("#pipeline-modal:not([hidden]) .pflow-node");
    await page.click('#pipeline-modal-card [data-pm-view="preview"]');
    await page.waitForSelector("#pipeline-modal-card [data-pm-chart] .pm-card[data-ready='1']", { timeout: 60_000 });
    const afterToggle = await page.evaluate(() => ({
      value: document.querySelector('#pipeline-editor .pipeline-stage[data-stage-index="0"] .stage-title')?.value || "",
      status: (document.getElementById("pipeline-status")?.textContent || "").trim(),
      chartText: (document.querySelector("#pipeline-modal-card [data-pm-chart] .pm-card g.node[data-stage] .nodeLabel")?.textContent || "").replace(/\s+/g, " ").trim(),
    }));
    check(afterToggle.value === EDITED, "preview -> edit -> preview leaves the tab's edit in place", afterToggle.value);
    check(/unsaved/i.test(afterToggle.status), "and the tab still reports it as unsaved", afterToggle.status);
    check(afterToggle.chartText.includes(EDITED), "the chart after the round trip is still the edited one", afterToggle.chartText);

    // ---- the editor still drags ----------------------------------------------------------------------------
    console.log("\n== the edit view still drags ==");
    const boxOf = () =>
      page.evaluate(() => {
        const b = document.getElementById("pipeline-modal-card").getBoundingClientRect();
        return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
      });
    // The handle's own top-left corner, not its middle: a narrow card's bar wraps the view switch onto a second row,
    // and the middle of the bar is a button there - a press on a control is that control, never a drag.
    const gesture = async (handle, dx, dy) => {
      const at = await page.$eval(handle, (el) => {
        const b = el.getBoundingClientRect();
        return { x: b.left + 12, y: b.top + 8 };
      });
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await page.mouse.move(at.x + dx, at.y + dy, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(150);
    };
    await page.click('#pipeline-modal-card [data-pm-view="edit"]');
    await page.waitForSelector("#pipeline-modal:not([hidden]) .pflow-node");
    const before = await boxOf();
    await gesture("#pipeline-modal-card .pmodal-bar", 36, 44);
    const dragged = await boxOf();
    equal("the bar drags the card by the pointer's travel", { dx: dragged.x - before.x, dy: dragged.y - before.y }, { dx: 36, dy: 44 });
    await gesture("#pipeline-modal-card [data-pm-resize]", -20, -20);
    const sized = await boxOf();
    check(sized.w <= dragged.w - 12 && sized.h <= dragged.h - 12, "the corner grip resizes it", `${dragged.w}x${dragged.h} -> ${sized.w}x${sized.h}`);
    await page.screenshot({ path: path.join(SHOTS, "dialog-edit-dragged.png") });

    await page.click('#pipeline-modal-card [data-pm-view="preview"]');
    await page.waitForSelector("#pipeline-modal-card [data-pm-chart] .pm-card[data-ready='1']", { timeout: 60_000 });
    const previewBox = await boxOf();
    equal("the frame the reader made survives the switch", [previewBox.x, previewBox.y], [sized.x, sized.y]);
    check(Math.abs(previewBox.w - sized.w) <= 2, "and so does its width", `${sized.w} -> ${previewBox.w}`);
    await page.screenshot({ path: path.join(SHOTS, "dialog-preview-dragged.png") });
    await page.click('#pipeline-modal-card [data-pm-view="edit"]');
    await page.waitForSelector("#pipeline-modal:not([hidden]) .pflow-node");

    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("pipeline-modal").hidden === true, null, { timeout: 5_000 });
    const closed = await page.evaluate(() => ({
      value: document.querySelector('#pipeline-editor .pipeline-stage[data-stage-index="0"] .stage-title')?.value || "",
      status: (document.getElementById("pipeline-status")?.textContent || "").trim(),
      settingsOpen: !document.getElementById("settings").classList.contains("hidden"),
    }));
    check(closed.value === EDITED && /unsaved/i.test(closed.status) && closed.settingsOpen, "closing the dialog leaves the tab and its edit exactly where they were", `${closed.value} / ${closed.status} / settings=${closed.settingsOpen}`);

    out.pageErrors.push(...pageErrors);
    out.consoleErrors.push(...consoleErrors);
    check(pageErrors.length === 0, "no page error", pageErrors.slice(0, 3).join(" | "));
    check(consoleErrors.length === 0, `no console error (${consoleErrors.length} recorded)`, consoleErrors.slice(0, 3).join(" | "));
    return { nodes: dlgCard.nodes.length, edges: dlgCard.edges.length, checks };
  }, { viewport: { width: 1400, height: 950 } });

  if (!result) throw new Error("the browser half returned no verdict");
} catch (e) {
  failures += 1;
  out.errors.push(String((e && e.stack) || e));
  console.log(`FAIL  the run threw: ${String((e && e.stack) || e).split("\n").slice(0, 6).join("\n      ")}`);
} finally {
  console.log(`\nSCREENSHOTS  ${SHOTS}`);
  await finish(failures ? 1 : 0);
}
