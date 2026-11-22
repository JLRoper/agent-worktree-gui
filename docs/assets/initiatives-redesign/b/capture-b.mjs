#!/usr/bin/env node
// ROUND B CAPTURES: the Initiatives tab, with waves, lanes and members, photographed through the repo's own headless
// Chromium harness at 1440, 1024 and 768. One run makes the pair the report is written from: the tab as it ships, and
// the same live DOM with tokens.css applied on top. The product is read-only: tokens.css is injected into the page at
// capture time and no file in public/, lib/ or server.js is touched.
//
//   env node docs/assets/initiatives-redesign/b/capture-b.mjs
//
// The panel is the fixture's own (tools/initiatives-fixture.mjs): throwaway git repositories, an initiatives store and
// two assistant queues under a scratch WAG_HOME, and server.js booted on a free port. The wave store is written by this
// script, because the fixture predates waves; every wave field is the shape lib/waves.js `pickWave` accepts.
//
// WHAT THE WAVES ARE FOR: one initiative (init_sso) carries three waves. wave-proof has closed on its exit gate and
// has its auto switch on; wave-flip was OPENED BY that switch, is running, and holds two named lanes with two members;
// wave-retire is empty and names a template the bundle does not hold. That gives the capture every state the lane
// draws, including both gate answers and the current mark, and it is a read of the real route, not page-invented text.
//
// Exit codes: 0 captures written; 2 Playwright is missing; 1 something threw.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright, notRun, openPage, withBrowser, withPage } from "../../../../tools/browser.mjs";
import { buildFixture, startFixturePanel, waitForFixtureRows, waitForInitiativesView } from "../../../../tools/initiatives-fixture.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = HERE;
const HOME = path.resolve(process.env.B_CAPTURE_HOME || path.join(os.tmpdir(), "wag", "initiatives-research-b"));
const MANIFEST = path.join(OUT, "captures.json");
const TOKENS = readFileSync(path.join(HERE, "tokens.css"), "utf8");

const shots = [];
const facts = {};

const api = async (base, route) => {
  const r = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(8000) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

// The wave store: a sibling of initiatives.json, keyed by initiative id (lib/paths.js wavesFile, lib/waves.js
// `Waves.load`). Positions are unique; a gate is {check, ...params} and only a real `true` turns the switch on.
function seedWaves(home) {
  const state = path.join(home, "state");
  const waves = {
    version: 1,
    savedAt: new Date().toISOString(),
    byInitiative: {
      init_sso: [
        {
          id: "wave-proof",
          initiativeId: "init_sso",
          position: 1,
          title: "Prove the Okta callback through the VIP",
          entryGate: { check: "clean" },
          exitGate: { check: "clean" },
          template: null,
          auto: true,
        },
        {
          id: "wave-flip",
          initiativeId: "init_sso",
          position: 2,
          title: "Flip the Menu login to SSO behind the toggle",
          entryGate: { check: "clean" },
          exitGate: { check: "pr-open" },
          template: null,
          auto: false,
        },
        {
          id: "wave-retire",
          initiativeId: "init_sso",
          position: 3,
          title: "Retire the LDAP fallback and close the migration",
          entryGate: null,
          exitGate: null,
          template: "sefl-review-loop",
          auto: false,
        },
      ],
    },
  };
  writeFileSync(path.join(state, "waves.json"), `${JSON.stringify(waves, null, 2)}\n`, "utf8");

  // Membership is the task's own waveId, and a lane is a name the member carries (lib/waves.js `waveMember`). The
  // queue read normalises both fields (lib/assistant/queue.js), so this is the same shape a real row has.
  const patches = {
    "assistant-1": {
      11: { waveId: "wave-flip", lane: "cookie" },
      13: { waveId: "wave-flip", lane: "login" },
    },
    "assistant-2": {
      21: { waveId: "wave-proof" },
    },
  };
  for (const [id, byTask] of Object.entries(patches)) {
    const file = path.join(state, "assistants", id, "queue.json");
    const doc = JSON.parse(readFileSync(file, "utf8"));
    doc.tasks = doc.tasks.map((task) => ({ ...task, ...(byTask[task.id] || {}) }));
    writeFileSync(file, `${JSON.stringify(doc, null, 1)}\n`, "utf8");
  }
}

const toTop = async (page) => {
  // The pane is rebuilt from a read on its own four-second timer, and an element screenshot of the wave lane scrolls
  // the pane. Put it back at the top and let the next paint land before a frame shot of the whole tab.
  await page.waitForSelector('#as-initiatives [data-init-card="init_sso"] [data-wave-id="wave-flip"] [data-wave-lane="cookie"]', { timeout: 20_000 });
  for (let i = 0; i < 3; i += 1) {
    await page.evaluate(() => {
      const pane = document.getElementById("as-initiatives");
      if (pane) pane.scrollTop = 0;
    });
    await page.waitForTimeout(120);
  }
};

const openInitiatives = async (page, base, { card = "init_sso" } = {}) => {
  await openPage(page, base, { selector: "section.project, .topbar" });
  const open = await page.evaluate(() => {
    const el = document.getElementById("assistant");
    return Boolean(el) && !el.hidden && getComputedStyle(el).display !== "none";
  });
  if (!open) await page.click("#btn-assistant");
  await page.waitForSelector("#assistant:not([hidden])", { timeout: 15_000 });
  const selected = await page.evaluate(() => document.querySelector('#as-tabs [data-as-tab="initiatives"]')?.getAttribute("aria-selected") === "true");
  if (!selected) await page.click('#as-tabs [data-as-tab="initiatives"]');
  await page.waitForSelector("#as-initiatives:not(.hidden)", { timeout: 15_000 });
  await page.waitForSelector("#as-initiatives .init-card", { timeout: 30_000 });
  await page.waitForFunction(() => document.querySelectorAll("#as-initiatives .init-card").length >= 4, null, { timeout: 30_000 });
  const head = page.locator(`#as-initiatives [data-init-card="${card}"] .init-head-btn`);
  const folded = await page.locator(`#as-initiatives [data-init-card="${card}"]`).evaluate((el) => el.classList.contains("is-titlecard"));
  if (folded) await head.click();
  await page.waitForSelector(`#as-initiatives [data-init-card="${card}"] .init-projects`, { timeout: 15_000 });
  await page.waitForSelector(`#as-initiatives [data-init-card="${card}"] [data-wave-id="wave-flip"] [data-wave-lane="cookie"]`, { timeout: 20_000 });
  await page.evaluate(() => {
    const pane = document.getElementById("as-initiatives");
    if (pane) pane.scrollTop = 0;
  });
  await page.waitForTimeout(300);
};

const shotElement = async (page, selector, slug, viewport, note) => {
  const file = path.join(OUT, `${slug}.png`);
  await page.locator(selector).first().screenshot({ path: file });
  shots.push({ file: path.basename(file), slug, viewport, element: selector, note, command: "env node docs/assets/initiatives-redesign/b/capture-b.mjs" });
  console.log(`shot  ${slug}  ${viewport.width}x${viewport.height}  ${selector}`);
};

const shotPage = async (page, slug, viewport, note) => {
  const file = path.join(OUT, `${slug}.png`);
  await page.screenshot({ path: file });
  shots.push({ file: path.basename(file), slug, viewport, element: "viewport", note, command: "env node docs/assets/initiatives-redesign/b/capture-b.mjs" });
  console.log(`shot  ${slug}  ${viewport.width}x${viewport.height}  viewport`);
};

// The numbers the token table is checked against: the first match of each selector, its type and its box. A missing
// selector is null rather than a zero, so a rule that did not apply is visible instead of looking small.
const SELECTORS = [
  ".init-card",
  ".init-title",
  ".init-desc",
  ".init-chips",
  ".init-chips .chip",
  ".init-chips .init-meta",
  ".init-sechead",
  ".init-proj",
  ".init-branch",
  ".init-wavefold",
  ".wave-row",
  ".wave-pos",
  ".wave-title",
  ".wave-head .chip",
  ".wave-gates .wave-gate",
  ".wave-gates .wave-auto",
  ".wave-auto-open",
  ".wave-lanes",
  ".wave-lane",
  ".wave-lane .wave-lane-read",
  ".wave-member",
  ".wave-member .chip",
  ".init-side",
];

const measure = async (page) =>
  page.evaluate((selectors) => {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const px = (v) => Math.round(Number.parseFloat(v) || 0);
      return {
        fs: px(s.fontSize),
        fw: s.fontWeight,
        lh: px(s.lineHeight),
        family: /mono/i.test(s.fontFamily) ? "mono" : "ui",
        color: s.color,
        bg: s.backgroundColor,
        border: s.borderTopWidth === "0px" ? "none" : `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
        radius: px(s.borderTopLeftRadius),
        pad: s.padding,
        gap: s.columnGap === "normal" ? s.rowGap : s.columnGap,
        height: Math.round(r.height),
        width: Math.round(r.width),
      };
    };
    const pane = document.getElementById("as-initiatives");
    return {
      paneWidth: pane ? Math.round(pane.getBoundingClientRect().width) : null,
      paneScroll: pane ? Math.round(pane.scrollHeight) : null,
      cardGrid: (() => {
        const card = document.querySelector(".init-card:not(.is-titlecard)");
        if (!card) return null;
        const s = getComputedStyle(card);
        return { display: s.display, columns: s.gridTemplateColumns, gap: s.columnGap };
      })(),
      styles: Object.fromEntries(selectors.map((sel) => [sel, pick(sel)])),
    };
  }, SELECTORS);

let panel = null;
try {
  mkdirSync(OUT, { recursive: true });
  console.log(`home (scratch): ${HOME.replace(/\\/g, "/")}`);
  console.log(`out:            ${OUT.replace(/\\/g, "/")}`);

  await buildFixture({ home: HOME, reset: true });
  seedWaves(HOME);
  panel = await startFixturePanel({ home: HOME, root: path.resolve(HERE, "../../../..") });
  console.log(`panel: ${panel.base} (pid ${panel.pid})`);
  await waitForFixtureRows(panel.base);
  await waitForInitiativesView(panel.base);

  // THE FACTS THE CAPTURES ARE TRUSTED ON: the route itself, read once.
  const doc = (await api(panel.base, "/api/initiatives")).body;
  const sso = doc.initiatives.find((i) => i.id === "init_sso");
  facts.initiative = { id: sso.id, title: sso.title, trees: sso.treeCount, projects: sso.projectCount, assistants: sso.assistantCount };
  facts.waves = sso.waves.map((w) => ({
    id: w.id,
    position: w.position,
    title: w.title,
    state: w.state,
    word: w.stateWord,
    current: w.id === sso.waveCurrentId,
    auto: w.auto,
    autoOpen: w.autoOpen,
    lanes: w.lanes.length,
    laneNames: w.lanes.map((l) => ({ label: l.label, state: l.state, read: l.read && l.read.ok ? "ok" : "cannot-tell", members: l.members.length })),
    members: w.members.map((m) => ({ id: m.id, title: m.title, state: m.state, project: m.project, lane: m.lane })),
    gates: { entry: w.gates.entry.state, exit: w.gates.exit.state },
    template: w.template,
    templateResolved: w.templateResolved,
  }));
  facts.waveCurrentId = sso.waveCurrentId;
  facts.route = { at: doc.at, file: String(doc.file || "").split(/[\\/]/).pop(), tier: doc.tier.id };
  const flip = facts.waves.find((w) => w.id === "wave-flip");
  const proof = facts.waves.find((w) => w.id === "wave-proof");
  const retire = facts.waves.find((w) => w.id === "wave-retire");
  const ok = (name, cond) => console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  ok("three waves are on the route", facts.waves.length === 3);
  ok("wave-proof closed on its exit gate", proof.state === "done");
  ok("wave-flip is running", flip.state === "running");
  ok("wave-flip is the current wave", facts.waveCurrentId === "wave-flip");
  ok("wave-flip was opened by wave-proof's switch", Boolean(flip.autoOpen && flip.autoOpen.open === true && flip.autoOpen.from === "wave-proof"));
  ok("wave-flip holds two named lanes", flip.lanes === 2 && flip.laneNames.map((l) => l.label).join(",") === "cookie,login");
  ok("wave-flip holds two members", flip.members.length === 2);
  ok("wave-retire is empty and its template is unresolved", retire.state === "empty" && retire.templateResolved === false);

  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the round B captures", "playwright is not installed for this node (see tools/browser.mjs)"));
    process.exitCode = 2;
  } else {
    // 1. THE DEFAULT RAIL: 1440 window, docked 480 pane, the reader's ordinary view.
    const docked = { width: 1440, height: 900 };
    await withBrowser(
      async ({ page }) => {
        await openInitiatives(page, panel.base);
        facts.docked = await measure(page);
        await toTop(page);
        await shotPage(page, "00-1440-page-docked-real", docked, "1440 window, assistant docked at 480px, init_sso open with three waves");
        await shotElement(page, "#assistant", "01-1440-docked-tab-real", docked, "the docked assistant frame, the pane at 480px");
        await shotElement(page, '#as-initiatives [data-init-card="init_sso"] .init-wavefold', "01b-1440-docked-wave-real", docked, "the wave lane in the 480px rail, as it ships");
        await toTop(page);
        await page.addStyleTag({ content: TOKENS });
        await toTop(page);
        facts.dockedTokens = await measure(page);
        await shotElement(page, "#assistant", "09-1440-docked-tab-tokens", docked, "the docked 480px rail with tokens.css applied");
        await shotElement(page, '#as-initiatives [data-init-card="init_sso"] .init-wavefold', "10-1440-docked-wave-tokens", docked, "the wave lane in the 480px rail with tokens.css: lanes stack, spine and pills hold");
      },
      { viewport: docked, deviceScaleFactor: 1, initScripts: [() => localStorage.setItem("wm.assistantOpen", "1")] },
    );

    // 2. THE WIDE FRAME: the panel switched to floating through its own route, so the pane can be measured at the
    //    three widths the brief names. Each context is isolated, so the tokens of one cannot leak into the next.
    const switched = await fetch(`${panel.base}/api/settings/general`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dockMode: "floating" }),
      signal: AbortSignal.timeout(8000),
    });
    facts.floatSwitch = { status: switched.status };

    const VIEWPORTS = [
      { width: 1440, height: 900, w: 1384, slug: "1440" },
      { width: 1024, height: 900, w: 1008, slug: "1024" },
      { width: 768, height: 900, w: 752, slug: "768" },
    ];

    for (const vp of VIEWPORTS) {
      await withBrowser(
        async ({ page }) => {
          await openInitiatives(page, panel.base);
          const rect = await page.evaluate(() => {
            const el = document.getElementById("assistant");
            const r = el.getBoundingClientRect();
            const pane = document.getElementById("as-initiatives").getBoundingClientRect();
            return { width: Math.round(r.width), height: Math.round(r.height), pane: Math.round(pane.width) };
          });
          facts[`frame${vp.slug}`] = rect;
          facts[`real${vp.slug}`] = await measure(page);
          await toTop(page);
          await shotElement(page, "#assistant", `02-${vp.slug}-tab-real`, vp, `${vp.width} window, assistant floating ${rect.width}x${rect.height}, pane ${rect.pane}px, the tab as it ships`);
          if (vp.slug === "1440") {
            await shotPage(page, "03-1440-page-float-real", vp, "1440 window, assistant floating, the whole page");
            await shotElement(page, '#as-initiatives [data-init-card="init_sso"] .init-wavefold', "04-1440-wave-real", vp, "the wave lane as it ships: three waves, two lanes and their members");
            await toTop(page);
          }
          // The token layer, on the same live DOM, same state, same viewport.
          await page.addStyleTag({ content: TOKENS });
          await toTop(page);
          facts[`token${vp.slug}`] = await measure(page);
          await shotElement(page, "#assistant", `05-${vp.slug}-tab-tokens`, vp, `${vp.width} window, the same DOM with tokens.css applied`);
          if (vp.slug === "1440") {
            await shotPage(page, "06-1440-page-float-tokens", vp, "1440 window, the whole page with tokens.css applied");
            await shotElement(page, '#as-initiatives [data-init-card="init_sso"] .init-wavefold', "07-1440-wave-tokens", vp, "the wave lane with tokens.css: state spine, lane blocks, gate pills, member pills");
            await toTop(page);
          }
          if (vp.slug === "768") {
            await shotElement(page, '#as-initiatives [data-init-card="init_sso"] .init-wavefold', "08-768-wave-tokens", vp, "the wave lane at 768 with tokens.css");
          }
        },
        {
          viewport: { width: vp.width, height: vp.height },
          deviceScaleFactor: 1,
          initScripts: [
            () => {
              localStorage.setItem("wm.assistantOpen", "1");
              localStorage.setItem("wm.assistantFloat", JSON.stringify({ x: 8, y: 72, w: 1384, h: 820 }));
            },
          ],
        },
      );
    }
  }

  writeFileSync(MANIFEST, `${JSON.stringify({ at: new Date().toISOString(), command: "env node docs/assets/initiatives-redesign/b/capture-b.mjs", home: HOME.replace(/\\/g, "/"), panel: panel.base, facts, shots }, null, 2)}\n`, "utf8");
  console.log(`manifest: ${MANIFEST.replace(/\\/g, "/")}`);
  console.log(`shots: ${shots.length}`);
} catch (err) {
  console.error(`CAPTURE FAILED: ${String((err && err.stack) || err)}`);
  process.exitCode = 1;
} finally {
  if (panel) await panel.stop().catch(() => {});
  process.exit(process.exitCode || 0);
}
