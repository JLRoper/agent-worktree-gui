#!/usr/bin/env node
// Settings > Pipeline in a real browser: the catalogue in a dropdown, one definition opened for editing, a keystroke
// that survives a repaint, add stage / remove stage repainting the rows they change (with the caret, selection and
// scroll still in the stage field), a save that reaches the live file with exactly the stages on screen, and a
// refusal whose findings land inline without losing the draft. The flow modal the tab opens has its own gate:
// tools/verify-pipeline-flow.mjs.
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
  check(tabCount === 11, "the strip has eleven tabs, the Pipeline one included", `${tabCount} tabs`);
  check(hasPipeline, "the Pipeline tab is in the strip");
  if (!hasPipeline) throw new Error("no [data-settings-tab=pipeline] — this is a build without the tab");

  await openSettingsGroup(page, "pipeline");
  await page.waitForFunction(() => {
    const el = document.getElementById("pipeline-summary");
    return el && !/reading/.test(el.textContent);
  }, null, { timeout: 20_000 });

  // (2) The catalogue is listed from the merged answer, in the dropdown the tab selects one definition with.
  const summary = (await page.textContent("#pipeline-summary")) || "";
  check(/\d+ definitions?/.test(summary), "the summary names the catalogue's size", summary);
  const options = await page.$$eval("#pipeline-select option", (els) => els.map((el) => el.value));
  check(
    ["local", "investigate", "turnover"].every((id) => options.includes(id)),
    "the dropdown carries the seed's built-in definitions",
    options.join(","),
  );

  // (3) One definition opens from the dropdown, and its stage prompt is the text the seed ships.
  await page.selectOption("#pipeline-select", "local");
  await page.waitForSelector("#pipeline-editor:not([hidden]) textarea.stage-prompt", { timeout: 10_000 });
  const selected = await page.evaluate(() => ({ pick: document.getElementById("pipeline-select").value, head: document.querySelector("#pipeline-editor .pipeline-editor-head")?.textContent || "" }));
  check(selected.pick === "local" && /editing\s*local/.test(selected.head.replace(/\s+/g, " ")), "the editor edits the definition the dropdown names", `${selected.pick} — ${selected.head.replace(/\s+/g, " ").trim()}`);
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

  // (5b) Add stage / remove stage repaint the rows they change. A dirty draft is not a reason to keep drawing a form
  // that disagrees with the draft Save will write: the rows and `pipelineDraft.stages` have to be one answer, and the
  // repaint must not take the caret out of a stage field the reader is typing in.
  const rowsNow = () => page.$$eval("#pipeline-stages .pipeline-stage", (els) => els.length);
  const idsOnScreen = () => page.$$eval("#pipeline-stages .stage-id", (els) => els.map((el) => el.value));
  const idsInDraft = () => page.evaluate(() => (pipelineDraft?.stages || []).map((s) => s.id));

  const baseRows = await rowsNow();
  await page.click("#pipeline-add-stage");
  await page.click("#pipeline-add-stage");
  const addedRows = await rowsNow();
  const addedIds = await idsInDraft();
  check(addedRows === baseRows + 2, "two add presses draw two rows", `${baseRows} -> ${addedRows}`);
  check(addedIds.length === addedRows, "and the draft holds one stage per row", `${addedIds.length} stages / ${addedRows} rows`);

  // The repainted rows are live: a keystroke in one reaches the draft.
  await page.fill("#pipeline-stages .pipeline-stage:nth-child(2) .stage-id", "typed-after-add");
  const typedIds = await idsInDraft();
  check(typedIds[1] === "typed-after-add", "a keystroke in a repainted row reaches the draft", typedIds.join(","));

  // Remove the middle row: neither the row nor the stage survives the next keystroke.
  const beforeRemove = await idsOnScreen();
  await page.click("#pipeline-stages .pipeline-stage:nth-child(2) .stage-remove");
  const removedIds = await idsOnScreen();
  await page.fill("#pipeline-stages .pipeline-stage:nth-child(1) textarea.stage-prompt", `kept-${Date.now()}`);
  const afterRemoveIds = await idsInDraft();
  check(removedIds.length === beforeRemove.length - 1, "remove leaves one row fewer", `${beforeRemove.length} -> ${removedIds.length}`);
  check(afterRemoveIds.length === removedIds.length, "and the draft agrees after the keystroke", `${afterRemoveIds.length} stages / ${removedIds.length} rows`);
  check(!afterRemoveIds.includes("typed-after-add"), "the removed stage was not resurrected by the keystroke");

  // The caret, the selection and the scroll stay in the stage field across a structural repaint. The prompt is long
  // enough to scroll, so the scroll assertion is about a real offset rather than a textarea that cannot move.
  await page.fill("#pipeline-stages .pipeline-stage:nth-child(2) .stage-id", "second");
  await page.fill("#pipeline-stages .pipeline-stage:nth-child(2) .stage-title", "Second stage");
  const longPrompt = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of a sentence the reader is still typing`).join("\n");
  const caret = await page.evaluate((text) => {
    const ta = document.querySelector("#pipeline-stages .pipeline-stage:nth-child(2) textarea.stage-prompt");
    ta.value = text;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.focus();
    ta.setSelectionRange(60, 66);
    ta.scrollTop = 24;
    const scrollBefore = ta.scrollTop;
    paintPipelineStages();
    const again = document.querySelector("#pipeline-stages .pipeline-stage:nth-child(2) textarea.stage-prompt");
    return {
      sameNode: again === ta,
      focused: document.activeElement === again,
      start: again.selectionStart,
      end: again.selectionEnd,
      scrollBefore,
      scrollAfter: again.scrollTop,
      value: again.value,
    };
  }, longPrompt);
  check(!caret.sameNode && caret.focused, "the repaint replaced the row and kept the caret in it");
  check(caret.start === 60 && caret.end === 66, "and the selection is where it was", `${caret.start}-${caret.end}`);
  check(caret.scrollBefore > 0 && caret.scrollAfter === caret.scrollBefore, "and the field's scroll is where it was", `${caret.scrollBefore} -> ${caret.scrollAfter}`);
  check(caret.value === longPrompt, "and the half-typed sentence is still in the field");

  // Save writes exactly the rows on screen.
  const screenIds = await idsOnScreen();
  await page.click("#pipeline-save");
  await page.waitForFunction(
    () => /^(saved|refused|not saved)/.test((document.getElementById("pipeline-status")?.textContent || "").trim()),
    null,
    { timeout: 15_000 },
  );
  const structuralSave = (await page.textContent("#pipeline-status")) || "";
  check(/^saved/.test(structuralSave.trim()), "Save after the structural presses was accepted", structuralSave.trim());
  const liveIds = (readLive().find((p) => p.id === "local")?.stages || []).map((s) => s.id);
  check(JSON.stringify(liveIds) === JSON.stringify(screenIds), "Save persisted exactly the stages on screen", `${screenIds.join(",")} vs ${liveIds.join(",")}`);

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
