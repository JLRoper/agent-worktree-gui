#!/usr/bin/env node
// CAPTURE, not gate: the two pipeline tabs in Settings — Pipeline and Bundles — photographed in a real browser at the
// size a reader actually reads them, with the numbers behind each frame written to one JSON ledger.
//
//   node tools/capture-settings-pipeline.mjs
//   node tools/capture-settings-pipeline.mjs --shots docs/assets/pipeline-tabs --json docs/assets/pipeline-tabs/capture.json
//   node tools/capture-settings-pipeline.mjs --root <a git archive export>     # shoot another build
//   node tools/capture-settings-pipeline.mjs --dsf 1                           # 1:1 pixels instead of 2×
//
// WHY A NEW FILE. tools/verify-pipelines-tab.mjs and tools/verify-bundles-tab.mjs are GATES: each judges one tab
// against a list of lines, and each changes state (typing into the editor, saving, forcing a refusal) to do it. This
// harness shares their fixture idea and nothing else — it never asserts a line, it opens the tab, photographs what is
// on screen, and records how to read the picture. Nothing under public/, lib/ or another tool is imported or edited.
//
// THE FOUR FRAMES, and why these:
//   pipeline-tab.png     Settings > Pipeline as it opens. The catalogue summary and the two file paths it merges, the
//                        picker the tab edits one definition with, "open the flow", and the top of the editor.
//   pipeline-stages.png  the same tab, scrolled to the stage cards of `sefl-review-loop` — seven stages, each with its
//                        prompt and the exit check that ends it. The window scrolls; this is one honest frame of it.
//   pipeline-flow.png    "open the flow" from that tab: the definition drawn stage to stage with its exit checks as
//                        notches. Edit mode, so every stage reads "not reached" — a definition has no position.
//   bundles-tab.png      Settings > Bundles: the studio bundle this panel read (POC to UAT, thirteen stages in order),
//                        the file it came from, and every active queue task with the stage it is on.
//
// THE FIXTURE is a throwaway panel: the shipped catalogue (pipelines.seed.json, seven definitions) as the only
// catalogue, the repo's own pipeline-bundle.seed.json copied in as the bundle, and one assistant queue holding three
// tasks — two on the bundle's pipeline, one the assistant decides. The window is opened at 1250 px through the same
// `wtgui.settingsRect` store a reader's drag writes (so the frame is the window the tab is read in, not the 340-px
// popover the stylesheet defaults to), and each frame's height is fitted to that tab's content up to 976 px — a short
// tab in a tall window photographs as a mostly-empty box. The rect a frame was taken at is in the ledger, per frame.
//
// A RE-RUN IS NOT BYTE-IDENTICAL, and the difference is one line: pipeline-tab.png and bundles-tab.png print the two
// files the tab read, and those live in a fresh mkdtemp sandbox each run — the paths are the fixture's, not the
// reader's. pipeline-stages.png and pipeline-flow.png carry no path and reproduce byte for byte.
//
// Exit: 0 the frames and the ledger were written; 2 the browser half could not run at all.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPlaywright, notRun, openSettingsGroup } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const SHOTS = path.resolve(opt("--shots", path.join(os.tmpdir(), "wtgui-settings-pipeline")));
const JSON_OUT = path.resolve(opt("--json", path.join(SHOTS, "capture.json")));
const DSF = Math.max(1, Number(opt("--dsf", 2)) || 2);

// The window a reader reads these tabs in. 1250 × 976 is a settings window dragged to fill most of a 1400 × 1000
// screen, which is the size the pipeline editor is usable at; the stylesheet's own default is 340 × 520. Each frame
// then asks for the height its content needs (`fitWindow`), never more than 976.
const VIEWPORT = { width: 1400, height: 1000 };
const RECT = { x: 12, y: 12, w: 1250, h: 976 };
const MAX_H = 976;
const TAB_KEY = "wtgui.settingsTab";
const RECT_KEY = "wtgui.settingsRect";

// The definition whose stage cards are photographed: the longest one the seed ships (seven stages), so the frame has
// several prompt + exit-check pairs in it rather than one.
const STAGES_PIPELINE = "sefl-review-loop";

// Three queue rows, so the Bundles tab's task list is not empty and shows both readings of the field: a stage, and the
// default path (`pipelineRun: null` is the record's own spelling of "the assistant decides" — lib/task-pipeline.js).
const QUEUE = {
  version: 1,
  nextId: 4,
  tasks: [
    {
      id: 1,
      title: "Read the stage contract and name what a stage may not do",
      state: "running",
      owner: "assistant-1",
      createdAt: "2026-11-04T13:02:00.000Z",
      pipelineRun: { pipeline: "poc-to-uat", stage: "S3", enteredAt: "2026-11-04T13:20:00.000Z" },
    },
    {
      id: 2,
      title: "Draft the charter for the Menu review",
      state: "queued",
      owner: "assistant-1",
      createdAt: "2026-11-04T13:10:00.000Z",
      pipelineRun: { pipeline: "poc-to-uat", stage: "S0", enteredAt: "2026-11-04T13:11:00.000Z" },
    },
    {
      id: 3,
      title: "Check the changelog render against main",
      state: "queued",
      owner: "assistant-1",
      createdAt: "2026-11-04T13:12:00.000Z",
      pipelineRun: null,
    },
  ],
};

// A drive-letter path exists on exactly one machine — the one that wrote it — so the repo's own absolute-paths gate
// (test/absolute-paths.test.js) refuses one in a committed ledger. Every path the ledger records is therefore
// RELATIVE to the tree that was shot (or a "<tmp>/…" for the throwaway fixture): a reader can follow it from the repo
// root, and a re-run in another checkout writes the same words.
const machineFree = (value) => {
  if (typeof value === "string") {
    let s = value;
    for (const sep of [path.sep, "/", "\\"]) s = s.split(TREE + sep).join("");
    s = s.split(TREE).join(".");
    for (const sep of [path.sep, "/", "\\"]) s = s.split(os.tmpdir() + sep).join("<tmp>/");
    s = s.split(os.tmpdir()).join("<tmp>");
    return s;
  }
  if (Array.isArray(value)) return value.map(machineFree);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, machineFree(v)]));
  return value;
};

const ledger = {
  startedAt: new Date().toISOString(),
  tree: ".",
  shots: machineFree(SHOTS) || ".",
  fixture: {
    catalogue: "pipelines.seed.json — seven definitions, no reader pipelines.json",
    bundle: "pipeline-bundle.seed.json — POC to UAT, thirteen stages (copied in as pipeline-bundle.json)",
    queue: "assistant-1, three tasks: two on poc-to-uat (S3 running, S0 queued) and one assistant-decides",
    window: { ...RECT, viewport: VIEWPORT, deviceScaleFactor: DSF },
  },
  panel: { base: null, build: null, version: null },
  frames: [],
  errors: [],
};

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const words = (s) => String(s || "").replace(/\s+/g, " ").trim();

// What the Pipeline tab is showing, read from the DOM the frame was taken of. The summary is the catalogue's own count;
// the source line is the two file paths and the version the read used; the editor's own head names the definition.
const readPipelineTab = (page) =>
  page.evaluate(() => {
    const text = (sel) => {
      const el = document.querySelector(sel);
      return el ? (el.textContent || "").replace(/\s+/g, " ").trim() : null;
    };
    const value = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.value : null;
    };
    const editor = document.getElementById("pipeline-editor");
    const stages = [...document.querySelectorAll("#pipeline-stages .pipeline-stage")];
    const first = stages[0] || null;
    const body = document.querySelector(".settings-body");
    const win = document.getElementById("settings");
    const rect = win ? win.getBoundingClientRect() : null;
    const visibleStages = stages.filter((s) => {
      const r = s.getBoundingClientRect();
      const br = body ? body.getBoundingClientRect() : { top: 0, bottom: innerHeight };
      return r.top >= br.top - 0.5 && r.bottom <= br.bottom + 0.5;
    }).length;
    return {
      tab: document.querySelector("[data-settings-tab][aria-selected='true']")?.dataset.settingsTab || null,
      window: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
      summary: text("#pipeline-summary"),
      source: text("#pipeline-source"),
      picker: { value: value("#pipeline-select"), options: [...document.querySelectorAll("#pipeline-select option")].map((o) => o.value) },
      flowButton: { text: text("#pipeline-flow-open"), disabled: document.getElementById("pipeline-flow-open")?.disabled ?? null },
      editor: {
        open: Boolean(editor && !editor.hidden),
        head: text("#pipeline-editor .pipeline-editor-head"),
        title: value("#pipeline-title"),
        kind: value("#pipeline-kind"),
        description: value("#pipeline-description"),
        next: value("#pipeline-next"),
        status: text("#pipeline-status"),
        stages: stages.length,
        stagesVisible: visibleStages,
        editorHeight: editor ? Math.round(editor.getBoundingClientRect().height) : null,
      },
      firstStage: first
        ? {
            id: value("#pipeline-stages .pipeline-stage:first-child .stage-id"),
            title: value("#pipeline-stages .pipeline-stage:first-child .stage-title"),
            promptChars: (value("#pipeline-stages .pipeline-stage:first-child .stage-prompt") || "").length,
            exit: value("#pipeline-stages .pipeline-stage:first-child .stage-exit-check"),
            promptSize: parseFloat(getComputedStyle(first.querySelector(".stage-prompt")).fontSize) || null,
          }
        : null,
      scroller: body ? { top: Math.round(body.scrollTop), height: Math.round(body.clientHeight), content: Math.round(body.scrollHeight) } : null,
    };
  });

const readBundlesTab = (page) =>
  page.evaluate(() => {
    const text = (sel) => {
      const el = document.querySelector(sel);
      return el ? (el.textContent || "").replace(/\s+/g, " ").trim() : null;
    };
    const win = document.getElementById("settings");
    const rect = win ? win.getBoundingClientRect() : null;
    const rows = [...document.querySelectorAll("#bundle-list [data-bundle-pipeline]")].map((el) => wordsOf(el));
    const tasks = [...document.querySelectorAll("#bundle-tasks [data-bundle-task-id]")].map((el) => wordsOf(el));
    function wordsOf(el) {
      return { id: el.dataset.bundlePipeline || el.dataset.bundleTaskId || null, text: (el.textContent || "").replace(/\s+/g, " ").trim() };
    }
    return {
      tab: document.querySelector("[data-settings-tab][aria-selected='true']")?.dataset.settingsTab || null,
      window: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
      summary: text("#bundle-summary"),
      summaryBad: document.getElementById("bundle-summary")?.classList.contains("bad") ?? null,
      source: text("#bundle-source"),
      sourceBad: document.getElementById("bundle-source")?.classList.contains("bad") ?? null,
      pipelines: rows,
      taskSummary: text("#bundle-tasks-summary"),
      tasks,
    };
  });

// The modal's own frame: which mode it opened in, the title, and how many stage columns the drawing holds. The count is
// read from the drawing rather than the definition, so a truncated flow would show up as a wrong number.
const readFlow = (page) =>
  page.evaluate(() => {
    const card = document.getElementById("pipeline-modal-card");
    if (!card) return null;
    const text = (sel) => {
      const el = card.querySelector(sel);
      return el ? (el.textContent || "").replace(/\s+/g, " ").trim() : null;
    };
    const box = card.getBoundingClientRect();
    const cols = [...card.querySelectorAll("[data-stage]")];
    const scroller = card.querySelector("[data-pflow-scroll]") || card.querySelector(".pmodal-body");
    const factEls = [...card.querySelectorAll(".pmodal-facts > *")];
    const clean = (el) => (el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "");
    return {
      mode: document.getElementById("pipeline-modal")?.dataset.mode || null,
      title: text(".pmodal-title"),
      subtitle: text(".pmodal-sub"),
      // The facts are label/value pairs in sibling spans with no separator between them, so their texts are joined here
      // rather than read as one run ("kind turnoverstages 7" is not a sentence a caption can quote).
      facts: factEls.map(clean).filter(Boolean).join(" · "),
      stages: cols.length,
      stagesVisible: scroller
        ? cols.filter((c) => {
            const r = c.getBoundingClientRect();
            const s = scroller.getBoundingClientRect();
            return r.left >= s.left - 0.5 && r.right <= s.right + 0.5;
          }).length
        : null,
      card: { w: Math.round(box.width), h: Math.round(box.height) },
      count: text("[data-pflow-count]"),
      size: parseFloat(getComputedStyle(card).fontSize) || null,
    };
  });

const shoot = async (page, selector, name, bytes) => {
  const el = await page.$(selector);
  if (!el) throw new Error(`no element for ${selector} (${name})`);
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(180);
  await el.screenshot({ path: bytes });
  return bytes;
};

// A frame's window, sized to the content it holds and never taller than the screen: the body scrolls, so a height the
// content does not need is dead space in the picture. The height is set on the element rather than through the store,
// because the store is read once at boot — the ledger's per-frame rect is the record of what was shot.
const fitWindow = async (page, height) => {
  const h = Math.min(MAX_H, Math.max(360, Math.round(Number(height) || MAX_H)));
  await page.evaluate((px) => {
    const win = document.getElementById("settings");
    if (win) {
      win.style.height = `${px}px`;
      win.style.maxHeight = "none";
    }
  }, h);
  await page.waitForTimeout(160);
};

// The height the open tab needs, measured from the head, the strip and the visible group — not guessed from a constant.
const neededHeight = (page) =>
  page.evaluate(() => {
    const win = document.getElementById("settings");
    if (!win) return null;
    const head = win.querySelector(":scope > .settings-head");
    const tabs = win.querySelector(":scope > .settings-tabs");
    const group = [...win.querySelectorAll(".settings-group")].find((g) => !g.hidden);
    if (!head || !tabs || !group) return null;
    const chrome = head.getBoundingClientRect().height + tabs.getBoundingClientRect().height;
    // `.settings-body` carries 4 px above and 14 px below the group; 18 covers both and the window's own border.
    return Math.ceil(chrome + group.scrollHeight + 18);
  });

const record = (name, file, data, extra = {}) => {
  if (!file) throw new Error(`frame ${name} was not written`);
  const stat = statSync(file);
  const frame = { name, file: machineFree(file), bytes: stat.size, sha256: sha(file), ...data, ...extra };
  ledger.frames.push(frame);
  console.log(`FRAME ${name}  ${file}  ${stat.size} bytes  sha256:${frame.sha256.slice(0, 16)}`);
  return frame;
};

// ---- boot the throwaway panel ---------------------------------------------------------------------------------
const pw = loadPlaywright();
if (!pw) {
  console.log(notRun("the pipeline tabs were not photographed", "Playwright is not installed in this checkout (tools/browser.mjs could not load it)."));
  process.exit(2);
}

const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-settings-capture-"));
const logs = path.join(dir, "logs");
mkdirSync(logs, { recursive: true });
mkdirSync(SHOTS, { recursive: true });
const bundleFile = path.join(logs, "pipeline-bundle.json");
copyFileSync(path.join(TREE, "pipeline-bundle.seed.json"), bundleFile);
const qdir = path.join(logs, "assistants", "assistant-1");
mkdirSync(qdir, { recursive: true });
writeFileSync(path.join(qdir, "queue.json"), JSON.stringify(QUEUE, null, 1), "utf8");

let panel = null;
const browser = await pw.chromium.launch({ headless: true });
try {
  panel = await startPanel({
    dir,
    keep: true,
    root: TREE,
    config: {
      dataDir: path.join(dir, "data"),
      scratchDir: path.join(dir, "scratch"),
      pipelineBundleFile: bundleFile,
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
  ledger.panel.base = panel.base;
  const about = await fetch(`${panel.base}/api/config`).then((r) => r.json()).catch(() => ({}));
  ledger.panel.version = about.version ?? null;
  ledger.panel.build = await fetch(`${panel.base}/api/build`).then((r) => r.json()).then((b) => b.version ?? b.build ?? null).catch(() => null);

  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: DSF });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource|favicon/i.test(m.text())) pageErrors.push(`console: ${m.text()}`);
  });
  // The reader's remembered window and tab, before the page boots: the store the drag and the tab strip write.
  await page.addInitScript(
    ([tag, rect, key, rectKey]) => {
      try {
        localStorage.setItem(key, tag);
        localStorage.setItem(rectKey, JSON.stringify(rect));
      } catch {
        /* a browser that refuses storage opens at the stylesheet's size; the shot then says so */
      }
    },
    ["pipeline", RECT, TAB_KEY, RECT_KEY],
  );
  await page.goto(panel.base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#btn-settings", { timeout: 30_000 });

  // ---- 1. Settings > Pipeline, as it opens ----------------------------------------------------------------
  await openSettingsGroup(page, "pipeline");
  await page.waitForFunction(() => {
    const el = document.getElementById("pipeline-summary");
    const editor = document.getElementById("pipeline-editor");
    return el && !/reading/.test(el.textContent || "") && editor && !editor.hidden && Boolean(editor.querySelector(".pipeline-stage"));
  }, null, { timeout: 30_000 });
  await page.waitForTimeout(250);
  await fitWindow(page, await neededHeight(page));
  const tabState = await readPipelineTab(page);
  const shot1 = await shoot(page, "#settings", "pipeline-tab", path.join(SHOTS, "pipeline-tab.png"));
  record("pipeline-tab", shot1, { viewport: VIEWPORT, dsf: DSF, read: tabState });

  // ---- 2. the same tab, scrolled to the stage cards ------------------------------------------------------
  await page.selectOption("#pipeline-select", STAGES_PIPELINE);
  await page.waitForFunction(
    (id) => {
      const el = document.getElementById("pipeline-select");
      const editor = document.getElementById("pipeline-editor");
      return el && el.value === id && editor && !editor.hidden && document.querySelectorAll("#pipeline-stages .pipeline-stage").length > 1;
    },
    STAGES_PIPELINE,
    { timeout: 20_000 },
  );
  // The stage list, not the scroller, says where the cards start: scroll it to the top of the body so the frame begins
  // at a stage boundary rather than mid-textarea. The window is given the full height first — seven cards fit at 976.
  await fitWindow(page, MAX_H);
  await page.evaluate(() => {
    const stages = document.getElementById("pipeline-stages");
    const body = document.querySelector(".settings-body");
    if (stages && body) {
      // Measured, not offsetTop: the two elements do not share an offsetParent, and subtracting unrelated offsets
      // scrolls to a place that depends on the layout rather than on where the cards are.
      const delta = stages.getBoundingClientRect().top - body.getBoundingClientRect().top;
      body.scrollTop += delta - 4;
    }
  });
  await page.waitForTimeout(250);
  const stagesState = await readPipelineTab(page);
  const shot2 = await shoot(page, "#settings", "pipeline-stages", path.join(SHOTS, "pipeline-stages.png"));
  record("pipeline-stages", shot2, { viewport: VIEWPORT, dsf: DSF, read: stagesState });

  // ---- 3. the flow the tab draws for that definition -----------------------------------------------------
  await page.click("#pipeline-flow-open");
  await page.waitForSelector("#pipeline-modal:not([hidden]) #pipeline-modal-card [data-stage]", { timeout: 20_000 });
  await page.waitForTimeout(300);
  const flowState = await readFlow(page);
  const shot3 = await shoot(page, "#pipeline-modal-card", "pipeline-flow", path.join(SHOTS, "pipeline-flow.png"));
  record("pipeline-flow", shot3, { viewport: VIEWPORT, dsf: DSF, read: flowState });
  await page.click("[data-pm-close]").catch(() => {});
  await page.waitForSelector("#pipeline-modal[hidden]", { timeout: 10_000 }).catch(() => {});

  // ---- 4. Settings > Bundles -----------------------------------------------------------------------------
  await openSettingsGroup(page, "bundles");
  await page.waitForFunction(
    () => {
      const summary = document.getElementById("bundle-summary");
      const tasks = document.querySelectorAll("#bundle-tasks [data-bundle-task-id]");
      return summary && !/reading/.test(summary.textContent || "") && tasks.length > 0;
    },
    null,
    { timeout: 30_000 },
  );
  // Back to the top of the pane: the Pipeline tab left it scrolled, and one scroller is shared by every tab.
  await page.evaluate(() => {
    const body = document.querySelector(".settings-body");
    if (body) body.scrollTop = 0;
  });
  await page.waitForTimeout(200);
  // This tab is short — five rows — so the window is fitted to it rather than left at the editor's height.
  await fitWindow(page, await neededHeight(page));
  const bundleState = await readBundlesTab(page);
  const shot4 = await shoot(page, "#settings", "bundles-tab", path.join(SHOTS, "bundles-tab.png"));
  record("bundles-tab", shot4, { viewport: VIEWPORT, dsf: DSF, read: bundleState });

  ledger.errors = pageErrors;
  await page.close();
} catch (e) {
  ledger.errors.push(String(e && e.message ? e.message : e));
  console.error(`CAPTURE FAILED — ${e && e.stack ? e.stack : e}`);
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  if (panel) await panel.stop().catch(() => {});
  if (!process.env.WAG_KEEP_CAPTURE) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  if (ledger.frames.length) {
    mkdirSync(path.dirname(JSON_OUT), { recursive: true });
    writeFileSync(JSON_OUT, JSON.stringify(ledger, null, 2), "utf8");
    console.log(`LEDGER ${JSON_OUT}  ${ledger.frames.length} frame(s)  ${ledger.errors.length} page error(s)`);
  }
  if (process.exitCode) console.log("no ledger: the run did not reach a frame that was written");
}
