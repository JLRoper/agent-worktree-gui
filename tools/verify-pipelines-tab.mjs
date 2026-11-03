#!/usr/bin/env node
// Settings > Pipeline in a real browser: the catalogue list, one definition opened for editing, a keystroke that
// survives a repaint, a save that reaches the live file, and a refusal whose findings land inline without losing the
// draft.
//
//   node tools/verify-pipelines-tab.mjs
//
// RED PROOF. Run this file in a `git archive 6da7bad | tar -x` export (0.80.0) and it fails on the first check —
// there is no [data-settings-tab="pipeline"] and no /api/pipelines route there — so a green run here means the tab
// and the route are what answered, not an empty page. It prints BROWSER-HALF-NOT-RUN and exits 2 when Playwright is
// absent, rather than passing a half that never ran.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright, openSettingsGroup } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const pw = loadPlaywright();
if (!pw) {
  console.log("BROWSER-HALF-NOT-RUN  Settings > Pipeline was not exercised in a browser.");
  console.log("  re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-pipelines-tab.mjs");
  process.exit(2);
}

let checks = 0;
let failures = 0;
const check = (ok, label, detail = "") => {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  [${detail}]` : ""}`);
};

const dir = mkdtempSync(path.join(tmpdir(), "wtgui-pipelines-tab-"));
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

const readLive = () => {
  const raw = JSON.parse(readFileSync(pipelinesFile, "utf8"));
  const list = Array.isArray(raw.pipelines) ? raw.pipelines : Object.values(raw.pipelines || {});
  return list;
};

const browser = await pw.chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    // A deliberate 422 refusal is logged by Chromium as "Failed to load resource"; it is the answer under test,
    // not a page error. Everything else at error level is.
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) pageErrors.push(`console: ${m.text()}`);
  });
  await page.goto(panel.base, { waitUntil: "domcontentloaded" });

  // (1) The tab is in the strip. On 0.80.0 this is the first red line.
  const tabCount = await page.evaluate(() => document.querySelectorAll("[data-settings-tab]").length);
  const hasPipeline = await page.evaluate(() => Boolean(document.querySelector('[data-settings-tab="pipeline"]')));
  check(tabCount === 10, "the strip has ten tabs, the Pipeline one included", `${tabCount} tabs`);
  check(hasPipeline, "the Pipeline tab is in the strip");
  if (!hasPipeline) throw new Error("no [data-settings-tab=pipeline] — this is a build without the tab");

  await openSettingsGroup(page, "pipeline");
  await page.waitForFunction(() => {
    const el = document.getElementById("pipeline-summary");
    return el && !/reading/.test(el.textContent);
  }, null, { timeout: 20_000 });

  // (2) The catalogue is listed from the merged answer.
  const summary = (await page.textContent("#pipeline-summary")) || "";
  check(/\d+ definitions?/.test(summary), "the summary names the catalogue's size", summary);
  const rows = await page.$$eval("#pipeline-list [data-pipeline-row]", (els) => els.map((el) => el.dataset.pipelineRow));
  check(
    ["local", "investigate", "turnover"].every((id) => rows.includes(id)),
    "the list carries the seed's built-in definitions",
    rows.join(","),
  );

  // (3) One definition opens, and its stage prompt is the text the seed ships.
  await page.click('#pipeline-list [data-pipeline-open="local"]');
  await page.waitForSelector("#pipeline-editor:not([hidden]) textarea.stage-prompt", { timeout: 10_000 });
  const original = await page.inputValue("#pipeline-editor textarea.stage-prompt");
  check(original.length > 20, "the editor carries the stage's prompt", `${original.length} chars`);

  // (4) A keystroke survives a repaint of the list: the editor is a sibling and a dirty draft is never replaced.
  const marker = `\n\nMARKER-${Date.now()}`;
  await page.click("#pipeline-editor textarea.stage-prompt");
  await page.evaluate(() => {
    const ta = document.querySelector("#pipeline-editor textarea.stage-prompt");
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });
  await page.type("#pipeline-editor textarea.stage-prompt", marker, { delay: 5 });
  const typed = await page.inputValue("#pipeline-editor textarea.stage-prompt");
  check(typed.endsWith(marker), "the typed text is in the prompt", `${typed.length} chars`);
  check(/unsaved/.test((await page.textContent("#pipeline-status")) || ""), "the editor says the draft is unsaved");

  const before = await page.evaluate(() => {
    const ta = document.querySelector("#pipeline-editor textarea.stage-prompt");
    return { value: ta.value, focused: document.activeElement === ta, at: ta.selectionStart };
  });
  await page.evaluate(() => loadPipelines());
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => {
    const ta = document.querySelector("#pipeline-editor textarea.stage-prompt");
    return { value: ta.value, focused: document.activeElement === ta, at: ta.selectionStart };
  });
  check(after.value === before.value, "a repaint did not lose a keystroke", `${before.value.length} -> ${after.value.length} chars`);
  check(after.focused && after.at === before.at, "and the caret is still where it was", `${before.at} -> ${after.at}`);

  // ...and leaving the tab and coming back keeps it too.
  await page.click('[data-settings-tab="display"]');
  await page.click('[data-settings-tab="pipeline"]');
  await page.waitForSelector("#pipeline-editor:not([hidden]) textarea.stage-prompt");
  const afterTab = await page.inputValue("#pipeline-editor textarea.stage-prompt");
  check(afterTab === before.value, "leaving the tab and coming back kept the draft", `${afterTab.length} chars`);

  // (5) Save reaches the live file.
  await page.click("#pipeline-save");
  await page.waitForFunction(
    () => /^saved/.test((document.getElementById("pipeline-status")?.textContent || "").trim()),
    null,
    { timeout: 15_000 },
  );
  const saveStatus = (await page.textContent("#pipeline-status")) || "";
  check(/^saved/.test(saveStatus.trim()), "the save was accepted", saveStatus);
  const localDef = readLive().find((p) => p.id === "local");
  check(Boolean(localDef) && String(localDef.stages?.[0]?.prompt || "").includes(marker), "the live file carries the edit");

  // (6) A refusal comes back with validatePipeline's own finding, shown inline, and the draft is kept.
  await page.click("#pipeline-editor textarea.stage-prompt");
  await page.evaluate(() => {
    const ta = document.querySelector("#pipeline-editor textarea.stage-prompt");
    ta.value = `${ta.value} {{nope}}`;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.click("#pipeline-save");
  await page.waitForFunction(() => {
    const el = document.getElementById("pipeline-findings");
    return el && !el.hidden && /unknown placeholder/.test(el.textContent || "");
  }, null, { timeout: 15_000 });
  const findings = (await page.textContent("#pipeline-findings")) || "";
  check(/unknown placeholder \{\{nope\}\}/.test(findings), "the server's finding is shown inline", findings.slice(0, 140));
  const kept = await page.inputValue("#pipeline-editor textarea.stage-prompt");
  check(kept.includes("{{nope}}"), "the refused save kept the draft");
  const localAfter = readLive().find((p) => p.id === "local");
  check(!String(localAfter?.stages?.[0]?.prompt || "").includes("{{nope}}"), "and nothing was written to the file");

  check(pageErrors.length === 0, "no page error", pageErrors.slice(0, 3).join(" | "));
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
