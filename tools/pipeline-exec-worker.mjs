#!/usr/bin/env node
// ONE STAGE'S WORK, IN A REAL BROWSER — the seat a pipeline stage's prompt is handed to.
//
// This is not a model. It is a scripted seat with a stated remit, and it exists so a pipeline round can be run end to
// end without a gateway, a token or a human: the PANEL's driver decides which stage runs, in which tree, and when the
// stage has settled; this file only does the work that stage was hired for, writes the artifact the stage declares,
// and exits with a status the job store can read.
//
//   node tools/pipeline-exec-worker.mjs --stage probe  --tree <dir> --visit <n>
//   node tools/pipeline-exec-worker.mjs --stage fix    --tree <dir> --visit <n>
//   node tools/pipeline-exec-worker.mjs --stage verify --tree <dir> --visit <n>
//
// THE SUBJECT. `<tree>/studio` is a copy of the SEFL Pipeline Studio (ai-development-factory/tools/pipeline-studio),
// served from the file system exactly as its README says it runs. The probe loads it in headless Chromium and measures
// six clauses of the pipeline's own legibility contract:
//
//   L1 seed-rendered    thirteen stage cards, ids S0..S12              (the document the studio opens)
//   L2 no-page-errors   no uncaught error and no console error on load
//   L3 card-name        every card exposes a non-empty accessible name
//   L4 subtext-size     every role/meta line inside a card paints at >= 12px
//   L5 min-text         nothing inside a card paints below 10px
//   L6 bundle-docs      bundle.json carries the four documents it promises
//
// A clause that fails is a FINDING with the number that made it fail, never an opinion. `fix` applies the one patch
// app.css needs for the failing clauses and records the before/after sha256; `verify` re-measures ALL six and reports
// each previously-failing clause as fixed or still open, plus any clause the patch broke. Every stage writes the
// artifact its stage declares in the pipeline document, and nothing else:
//
//   probe   out/probe.json      fix   out/fix.json      verify  out/verify.json
//
// The artifacts carry NO timestamp and NO absolute path, on purpose: two independent rounds over the same document
// must produce the same bytes, and that is one of the facts the report checks.
//
// Exit: 0 the stage did its work; 3 the browser never got the page (a real stage failure, which the panel parks);
// 4 the tree has no studio to probe.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadPlaywright } from "./browser.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const at = argv.indexOf(name);
  return at === -1 ? fallback : argv[at + 1] ?? fallback;
};

const STAGE = String(arg("--stage", "probe"));
const TREE = path.resolve(String(arg("--tree", process.cwd())));
const VISIT = Number(arg("--visit", "1")) || 1;
const OUT = String(arg("--out", "out"));
const STUDIO = path.join(TREE, "studio", "index.html");
const ARTIFACTS = path.join(TREE, OUT);
const shotPath = (name) => path.join(ARTIFACTS, name);

// The bar, in one place: the probe, the fix and the report all name the same numbers.
export const CLAUSES = Object.freeze([
  { id: "L1", key: "seed-rendered", bar: "13 stage cards, S0..S12" },
  { id: "L2", key: "no-page-errors", bar: "0 uncaught and 0 console errors on load" },
  { id: "L3", key: "card-name", bar: "every card has a non-empty accessible name" },
  { id: "L4", key: "subtext-size", bar: "role and meta lines paint at >= 12px" },
  { id: "L5", key: "min-text", bar: "no text inside a card paints below 10px" },
  { id: "L6", key: "bundle-docs", bar: "bundle.json carries pipeline, roles, artifacts and yaml" },
]);

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const writeJson = (name, value) => {
  mkdirSync(ARTIFACTS, { recursive: true });
  const body = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path.join(ARTIFACTS, name), body);
  return { name, sha256: sha256(Buffer.from(body)), bytes: Buffer.byteLength(body) };
};

const fail = (code, message) => {
  console.error(`pipeline-exec-worker: ${message}`);
  process.exit(code);
};

if (!existsSync(STUDIO)) fail(4, `no studio at ${STUDIO} — the stage's tree has nothing to probe`);

const playwright = loadPlaywright();
if (!playwright) fail(3, "no Playwright install found (set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright)");

// ---- the measurement -------------------------------------------------------------------------------------------
// Everything a clause needs is measured in ONE page pass, so a clause cannot be measured against a page another
// clause has already changed. The export download is the one exception: it is a second context, and it is only read
// for L6.
async function measure() {
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String((e && e.message) || e)));
  page.on("console", (m) => {
    if (m && m.type() === "error" && !/favicon/i.test(m.text())) consoleErrors.push(m.text());
  });
  try {
    await page.goto(pathToFileURL(STUDIO).href, { waitUntil: "load", timeout: 30_000 });
    await page.waitForTimeout(700);

    const dom = await page.evaluate(() => {
      const cards = [...document.querySelectorAll(".node[data-id]")];
      const ids = cards.map((c) => c.getAttribute("data-id"));
      const named = cards.filter((c) => String(c.getAttribute("aria-label") || c.textContent || "").trim().length > 3);
      const px = (el) => parseFloat(getComputedStyle(el).fontSize) || 0;
      const subtext = [];
      const tiny = [];
      const seen = new Set();
      for (const card of cards) {
        for (const el of card.querySelectorAll(".node-role, .node-meta")) subtext.push(px(el));
        for (const el of card.querySelectorAll("*")) {
          const size = px(el);
          const text = (el.textContent || "").trim();
          if (!text || size >= 10) continue;
          const key = `${el.className}|${size}`;
          if (seen.has(key)) continue;
          seen.add(key);
          tiny.push({ cls: String(el.className), size });
        }
      }
      return {
        cards: cards.length,
        ids,
        idsOk: ids.length === 13 && ids.every((id, i) => id === `S${i}`),
        named: named.length,
        subtextMin: subtext.length ? Math.min(...subtext) : 0,
        subtextCount: subtext.length,
        tiny,
        loaded: Boolean(document.querySelector(".canvas")),
      };
    });

    let bundleOk = false;
    let bundleKeys = null;
    try {
      await page.click("#exportMenuBtn");
      await page.waitForTimeout(120);
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 6000 }).catch(() => null),
        page.locator('#exportMenu button[data-file="bundle.json"]').click({ timeout: 4000 }).catch(() => {}),
      ]);
      if (download) {
        const doc = JSON.parse(readFileSync(await download.path(), "utf8"));
        bundleKeys = Object.keys(doc).sort();
        bundleOk = ["artifacts", "pipeline", "roles", "yaml"].every((k) => bundleKeys.includes(k));
      }
    } catch {
      bundleOk = false;
    }
    await page.keyboard.press("Escape");

    return {
      ...dom,
      pageErrors,
      consoleErrors,
      bundleOk,
      bundleKeys,
      findings: [
        { id: "L1", key: "seed-rendered", ok: dom.idsOk, measured: `${dom.cards} cards ${dom.ids[0] || "?"}..${dom.ids.at(-1) || "?"}` },
        { id: "L2", key: "no-page-errors", ok: pageErrors.length === 0 && consoleErrors.length === 0, measured: `${pageErrors.length} page, ${consoleErrors.length} console` },
        { id: "L3", key: "card-name", ok: dom.cards > 0 && dom.named === dom.cards, measured: `${dom.named}/${dom.cards} named` },
        { id: "L4", key: "subtext-size", ok: dom.subtextCount > 0 && dom.subtextMin >= 12, measured: `min ${dom.subtextMin}px over ${dom.subtextCount} lines` },
        { id: "L5", key: "min-text", ok: dom.tiny.length === 0, measured: dom.tiny.length ? dom.tiny.map((t) => `${t.cls} ${t.size}px`).join(", ") : "nothing below 10px" },
        { id: "L6", key: "bundle-docs", ok: bundleOk, measured: bundleOk ? (bundleKeys || []).join(", ") : `keys ${JSON.stringify(bundleKeys)}` },
      ],
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function shoot(name) {
  mkdirSync(ARTIFACTS, { recursive: true });
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(pathToFileURL(STUDIO).href, { waitUntil: "load", timeout: 30_000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: shotPath(name), fullPage: false });
    return { name, bytes: readFileSync(shotPath(name)).length };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// ---- the fix ---------------------------------------------------------------------------------------------------
// The patch table. Each entry is a real CSS declaration in the studio's own stylesheet, keyed by the clause that
// asked for it. A rule that already carries the target value is not touched (the second visit of the same stage must
// not rewrite a file that is already right), and a rule the stylesheet does not hold is reported as unfixable rather
// than invented.
const PATCHES = Object.freeze([
  { clause: "L4", match: /\.node-meta \{[^}]*\}/, from: "font-size: 10.5px;", to: "font-size: 12px;", selector: ".node-meta", note: "role/meta line 10.5px -> 12px" },
  { clause: "L4", match: /\.node-role \{[^}]*\}/, from: "overflow: hidden;", to: "font-size: 12px; overflow: hidden;", selector: ".node-role", note: "role name set to 12px explicitly" },
  { clause: "L5", match: /\.node-imported \{[^}]*\}/, from: "font-size: 8px;", to: "font-size: 10px;", selector: ".node-imported", note: "imported badge 8px -> 10px" },
  { clause: "L5", match: /\.node-gate \{[^}]*\}/, from: "font-size: 9px;", to: "font-size: 10px;", selector: ".node-gate", note: "gate badge 9px -> 10px" },
  { clause: "L5", match: /\.node-kind \{[^}]*\}/, from: "font-size: 9px;", to: "font-size: 10px;", selector: ".node-kind", note: "kind label 9px -> 10px" },
  { clause: "L5", match: /\.node-artifact \{[^}]*\}/, from: "font-size: 9.5px;", to: "font-size: 10px;", selector: ".node-artifact", note: "artifact chip 9.5px -> 10px" },
]);

function applyFixes(failing) {
  const file = path.join(TREE, "studio", "app.css");
  const before = readFileSync(file);
  let css = before.toString("utf8");
  const applied = [];
  const skipped = [];
  for (const clause of failing) {
    for (const patch of PATCHES.filter((p) => p.clause === clause)) {
      if (css.includes(patch.to) && !new RegExp(patch.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(css)) {
        skipped.push({ clause, selector: patch.selector, why: "already at the target value" });
        continue;
      }
      const rule = new RegExp(patch.match.source, patch.match.flags);
      const hit = rule.exec(css);
      if (!hit || !hit[0].includes(patch.from)) {
        skipped.push({ clause, selector: patch.selector, why: "the rule is not in the stylesheet in the shape the patch names" });
        continue;
      }
      const next = hit[0].replace(patch.from, patch.to);
      css = css.slice(0, hit.index) + next + css.slice(hit.index + hit[0].length);
      applied.push({ clause, selector: patch.selector, note: patch.note });
    }
  }
  if (applied.length) writeFileSync(file, css);
  return { applied, skipped, before: sha256(before), after: sha256(Buffer.from(css)), changed: applied.length > 0 };
}

// ---- the three stages ------------------------------------------------------------------------------------------
const STAGE_ARTIFACT = { probe: "probe.json", fix: "fix.json", verify: "verify.json" };

const readArtifact = (name) => {
  const file = path.join(ARTIFACTS, name);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
};

async function probe() {
  const found = await measure();
  const shots = [];
  try {
    shots.push(await shoot(`probe-visit${VISIT}.png`));
  } catch {
    /* a shot that cannot be taken does not fail the stage: the numbers are the artifact */
  }
  const doc = {
    stage: "probe",
    visit: VISIT,
    clause_bar: CLAUSES,
    findings: found.findings,
    pass: found.findings.filter((f) => f.ok).length,
    fail: found.findings.filter((f) => !f.ok).map((f) => f.id),
    details: {
      cards: found.cards,
      ids: found.ids,
      page_errors: found.pageErrors,
      console_errors: found.consoleErrors,
      subtext_min_px: found.subtextMin,
      tiny_text: found.tiny,
      bundle_keys: found.bundleKeys,
    },
    evidence: shots.map((s) => s.name),
  };
  console.log(JSON.stringify({ ok: true, stage: "probe", visit: VISIT, pass: doc.pass, fail: doc.fail }));
  return writeJson(STAGE_ARTIFACT.probe, doc);
}

async function fix() {
  const found = readArtifact(STAGE_ARTIFACT.probe);
  if (!found) fail(5, "no out/probe.json in the tree — the fix stage has nothing to read");
  const failing = (found.findings || []).filter((f) => !f.ok).map((f) => f.id);
  const result = applyFixes(failing);
  const shots = [];
  try {
    shots.push(await shoot(`fix-visit${VISIT}.png`));
  } catch {
    /* same rule as the probe's shot */
  }
  const doc = {
    stage: "fix",
    visit: VISIT,
    read: { artifact: "probe.json", findings: (found.findings || []).length, failing },
    applied: result.applied,
    skipped: result.skipped,
    file: "studio/app.css",
    sha256: { before: result.before, after: result.after },
    changed: result.changed,
    evidence: shots.map((s) => s.name),
  };
  console.log(JSON.stringify({ ok: true, stage: "fix", visit: VISIT, applied: result.applied.length, skipped: result.skipped.length }));
  return writeJson(STAGE_ARTIFACT.fix, doc);
}

async function verify() {
  const found = readArtifact(STAGE_ARTIFACT.probe);
  const fixed = readArtifact(STAGE_ARTIFACT.fix);
  if (!found) fail(5, "no out/probe.json in the tree — the verify stage has nothing to re-measure");
  const now = await measure();
  const before = new Map((found.findings || []).map((f) => [f.id, f]));
  const rows = now.findings.map((f) => ({
    id: f.id,
    key: f.key,
    was_ok: before.has(f.id) ? before.get(f.id).ok : null,
    now_ok: f.ok,
    measured_before: before.has(f.id) ? before.get(f.id).measured : null,
    measured_now: f.measured,
  }));
  const previouslyFailing = rows.filter((r) => r.was_ok === false);
  const regressions = rows.filter((r) => r.was_ok === true && r.now_ok === false);
  const shots = [];
  try {
    shots.push(await shoot(`verify-visit${VISIT}.png`));
  } catch {
    /* same rule as the probe's shot */
  }
  const doc = {
    stage: "verify",
    visit: VISIT,
    read: { probe_visit: found.visit ?? null, fix_visit: fixed ? fixed.visit ?? null : null },
    clauses: rows,
    previously_failing: previouslyFailing.map((r) => r.id),
    fixed: previouslyFailing.filter((r) => r.now_ok).map((r) => r.id),
    still_open: previouslyFailing.filter((r) => !r.now_ok).map((r) => r.id),
    regressions: regressions.map((r) => r.id),
    pass: now.findings.filter((f) => f.ok).length,
    evidence: shots.map((s) => s.name),
  };
  console.log(JSON.stringify({ ok: true, stage: "verify", visit: VISIT, fixed: doc.fixed, still_open: doc.still_open, regressions: doc.regressions }));
  return writeJson(STAGE_ARTIFACT.verify, doc);
}

const table = { probe, fix, verify };
if (!table[STAGE]) fail(2, `unknown stage ${JSON.stringify(STAGE)} — expected probe, fix or verify`);
const written = await table[STAGE]();
console.log(JSON.stringify({ artifact: written.name, sha256: written.sha256, bytes: written.bytes }));
