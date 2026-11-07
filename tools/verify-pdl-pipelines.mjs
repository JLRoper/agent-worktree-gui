#!/usr/bin/env node
// HARNESS: LIVE GATE
// The four PDL pipelines, in a real browser: the Settings > Pipeline dropdown lists them first and tagged PDL, and the
// map draws each one from its stages, gates and handoffs.
//
//   node tools/verify-pdl-pipelines.mjs
//
// WHAT IT PROVES, and why each line is not decoration:
//   - the dropdown carries `pdl:poc-to-uat`, `pdl:ping-pong`, `pdl:probe-fix` and `pdl:author-review-revise`, every one
//     of them BEFORE the first ladder option, inside an optgroup whose label says PDL. The catalogue is read from
//     config.pipelineBundleFile through lib/pipeline-source.js, so this is the panel's own reading, not the seed page's;
//   - pressing "open the flow" on each PDL selection paints public/core/pipeline-mermaid.js's card from that
//     pipeline's stages, gates and handoffs: 13 painted nodes for poc-to-uat, 2 for ping-pong, 2 for probe-fix and 3 for
//     author-review-revise, with the document's gates and capped loops beside them;
//   - the map link carries the panel's own catalogue route while a PDL pipeline is selected, and the map page opened
//     from it draws the same four pipelines at the same stage counts.
//
// BROWSER-HALF-NOT-RUN (exit 2) when Playwright is absent, rather than a green half that never opened a page.
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright, openSettingsGroup } from "./browser.mjs";
import { startPanel, ROOT } from "./panel-testkit.mjs";

const pw = loadPlaywright();
if (!pw) {
  console.log("BROWSER-HALF-NOT-RUN  the PDL pipelines were not exercised in a browser.");
  console.log(`  re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-pdl-pipelines.mjs`);
  process.exit(2);
}

let checks = 0;
let failures = 0;
const check = (ok, label, detail = "") => {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  [${detail}]` : ""}`);
};

const PDL = [
  { id: "poc-to-uat", stages: 13, gates: 5, loops: 3 },
  { id: "ping-pong", stages: 2, gates: 1, loops: 1 },
  { id: "probe-fix", stages: 2, gates: 0, loops: 0 },
  { id: "author-review-revise", stages: 3, gates: 1, loops: 1 },
];

const dir = mkdtempSync(path.join(tmpdir(), "wtgui-pdl-pipelines-"));
// The panel reads ONE bundle file (config.pipelineBundleFile). Point it at the seed so the four ids are the ones the
// dropdown must list, and keep the ladder catalogue in its own file beside it.
const bundleFile = path.join(dir, "pipeline-bundle.json");
copyFileSync(path.join(ROOT, "pipeline-bundle.seed.json"), bundleFile);
const panel = await startPanel({
  dir,
  keep: true,
  config: {
    pipelinesFile: path.join(dir, "pipelines.json"),
    pipelineBundleFile: bundleFile,
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

const browser = await pw.chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) pageErrors.push(`console: ${m.text()}`);
  });
  await page.goto(panel.base, { waitUntil: "domcontentloaded" });
  await openSettingsGroup(page, "pipeline");
  await page.waitForFunction(() => {
    const el = document.getElementById("pipeline-summary");
    return el && !/reading/.test(el.textContent);
  }, null, { timeout: 20_000 });
  await page.waitForFunction(() => document.querySelectorAll("#pipeline-select optgroup").length >= 2, null, { timeout: 20_000 });

  // (1) The dropdown: two groups, PDL first, and the four ids inside it.
  const pick = await page.$$eval("#pipeline-select optgroup", (groups) =>
    groups.map((g) => ({
      label: g.label,
      options: [...g.querySelectorAll("option")].map((o) => ({ value: o.value, label: o.textContent.trim() })),
    })),
  );
  check(pick.map((g) => g.label).join(" | ") === "PDL pipelines | built-in ladders", "the dropdown groups PDL pipelines above the built-in ladders", pick.map((g) => g.label).join(" | "));
  const pdlOptions = pick.find((g) => g.label === "PDL pipelines")?.options || [];
  const ladderOptions = pick.find((g) => g.label === "built-in ladders")?.options || [];
  check(
    JSON.stringify(pdlOptions.map((o) => o.value)) === JSON.stringify(PDL.map((p) => `pdl:${p.id}`)),
    "the PDL group lists the four ids, in the bundle's order",
    pdlOptions.map((o) => o.value).join(", "),
  );
  check(pdlOptions.every((o) => /^PDL · /.test(o.label)), "every PDL option is tagged PDL", pdlOptions.map((o) => o.label).join(" | "));
  // The DOM's own order, not just the group's: every PDL option sits above every ladder option.
  const order = await page.$$eval("#pipeline-select option", (els) => els.map((el) => el.value));
  const firstLadder = order.findIndex((v) => !v.startsWith("pdl:"));
  const lastPdl = order.map((v, i) => (v.startsWith("pdl:") ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  check(lastPdl >= 0 && (firstLadder === -1 || lastPdl < firstLadder), "and they are listed above every built-in ladder", order.join(", "));

  // (2) Each PDL pipeline draws from its own stages, gates and handoffs.
  const drawn = [];
  for (const want of PDL) {
    await page.selectOption("#pipeline-select", `pdl:${want.id}`);
    await page.waitForFunction(() => !document.getElementById("pipeline-flow-open")?.disabled, null, { timeout: 5000 });
    const status = (await page.textContent("#pipeline-pdl-pick")) || "";
    check(new RegExp(`PDL pipeline "${want.id}"`).test(status), `${want.id}: the tab says the selection is a PDL pipeline`, status.trim().slice(0, 120));
    check(await page.evaluate(() => document.getElementById("pipeline-editor")?.hidden !== false), `${want.id}: the ladder editor is closed`, "");
    await page.click("#pipeline-flow-open");
    await page.waitForFunction(
      () => {
        const card = document.querySelector("[data-pm-chart] .pm-card[data-pdl='1']");
        return card && card.getAttribute("data-ready") === "1";
      },
      null,
      { timeout: 30_000 },
    );
    const card = await page.evaluate(() => {
      const el = document.querySelector("[data-pm-chart] .pm-card[data-pdl='1']");
      const host = document.querySelector("[data-pm-chart]");
      return {
        id: el?.dataset.card || "",
        declared: Number(el?.dataset.stages || 0),
        nodes: Number(el?.dataset.nodeCount || 0),
        loops: Number(el?.dataset.loopCount || 0),
        gates: el?.querySelectorAll(".pm-gates li").length || 0,
        title: document.getElementById("pipeline-modal-title")?.textContent || "",
        chartId: host?.dataset.chartId || "",
        chartStages: Number(host?.dataset.chartStages || 0),
      };
    });
    drawn.push(card);
    check(card.id === want.id, `${want.id}: the card is the selected pipeline`, `${card.id} / title ${card.title}`);
    check(card.declared === want.stages && card.chartStages === want.stages, `${want.id}: the map draws ${want.stages} stages`, `declared ${card.declared}, chart ${card.chartStages}`);
    check(card.nodes === want.stages, `${want.id}: ${want.stages} stage nodes are painted`, `${card.nodes} nodes`);
    check(card.gates === want.gates, `${want.id}: ${want.gates} gate${want.gates === 1 ? "" : "s"} listed`, `${card.gates}`);
    check(card.loops === want.loops, `${want.id}: ${want.loops} loop${want.loops === 1 ? "" : "s"} drawn`, `${card.loops}`);
    await page.click("[data-pm-close]");
    await page.waitForFunction(() => document.getElementById("pipeline-modal")?.hidden !== false, null, { timeout: 5000 });
  }
  check(drawn.map((c) => c.nodes).join(",") === "13,2,2,3", "the four draws are 13, 2, 2 and 3 stages", drawn.map((c) => `${c.id}:${c.nodes}`).join(", "));

  // (3) The map link hands the page this panel's catalogue, and the page draws the same four.
  await page.selectOption("#pipeline-select", "pdl:poc-to-uat");
  const href = await page.getAttribute("#pipeline-map-open", "href");
  check(href === "/pipeline-map.html?doc=/api/assistant/pipeline-catalogue", "the map link carries the panel's own PDL catalogue", String(href));
  const mapPage = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  const mapErrors = [];
  mapPage.on("pageerror", (e) => mapErrors.push(String(e)));
  await mapPage.goto(panel.base + href, { waitUntil: "domcontentloaded" });
  // The page draws its own seed first and then the document it was handed; the document's own count is on the root.
  await mapPage.waitForFunction(() => document.documentElement.dataset.pipelineDocCards === "4", null, { timeout: 40_000 });
  await mapPage.waitForFunction(() => [...document.querySelectorAll(".pm-card[data-card]")].every((el) => el.getAttribute("data-ready") === "1"), null, { timeout: 40_000 });
  const mapCards = await mapPage.$$eval(".pm-card[data-card]", (els) => els.map((el) => ({ id: el.dataset.card, stages: Number(el.dataset.stages || 0), nodes: Number(el.dataset.nodeCount || 0), loops: Number(el.dataset.loopCount || 0), gates: el.querySelectorAll(".pm-gates li").length })));
  check(mapCards.length === 4, "the map page drew four PDL pipelines from the panel's catalogue", mapCards.map((c) => c.id).join(", "));
  for (const want of PDL) {
    const card = mapCards.find((c) => c.id === want.id);
    check(Boolean(card) && card.stages === want.stages && card.nodes === want.stages, `map: ${want.id} is ${want.stages} stages`, card ? `${card.stages} declared / ${card.nodes} painted` : "missing");
    check(Boolean(card) && card.gates === want.gates && card.loops === want.loops, `map: ${want.id} carries ${want.gates} gates and ${want.loops} loops`, card ? `${card.gates}g/${card.loops}l` : "missing");
  }
  await mapPage.close();

  // (4) A ladder still edits: the dropdown's other half is not collateral.
  await page.selectOption("#pipeline-select", "local");
  await page.waitForSelector("#pipeline-editor:not([hidden]) textarea.stage-prompt", { timeout: 10_000 });
  const ladderPick = await page.evaluate(() => ({ value: document.getElementById("pipeline-select").value, href: document.getElementById("pipeline-map-open").getAttribute("href") }));
  check(ladderPick.value === "local", "a built-in ladder still opens its editor", ladderPick.value);
  check(ladderPick.href === "/pipeline-map.html", "and the map link goes back to the generated library page", ladderPick.href);

  check(pageErrors.length === 0, "no page error", pageErrors.slice(0, 3).join(" | "));
  check(mapErrors.length === 0, "no error on the map page", mapErrors.slice(0, 3).join(" | "));
} catch (e) {
  failures += 1;
  console.log(`FAIL  the run threw: ${String((e && e.stack) || e).split("\n").slice(0, 6).join("\n      ")}`);
} finally {
  await browser.close().catch(() => {});
  await panel.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

console.log(`\nRESULT: ${failures ? "FAIL" : "PASS"} — ${checks} checks, ${failures} failed`);
process.exit(failures ? 1 : 0);
