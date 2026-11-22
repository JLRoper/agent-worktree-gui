#!/usr/bin/env node
// THE ROUTE, CAPTURED BEFORE AND AFTER, WITH THE NUMBERS BESIDE EACH PAIR.
//
//   env ROUTE_ROOT=<tree> ROUTE_OUT=<dir> ROUTE_HOME=<scratch home> node docs/assets/initiatives-redesign/route/capture-route.mjs
//
// ONE SCRIPT, TWO RENDERS. It boots the repo's own fixture panel (tools/initiatives-fixture.mjs: throwaway repos, a
// seeded initiatives store, two assistant queues) with the wave store this file writes, opens the real Initiatives
// tab in headless Chromium and photographs it. `ROUTE_ROOT` is the tree whose server.js and public/ are served: point
// it at a `git archive` of the commit before the change for the BEFORE set, and at the working tree for the AFTER
// set. The harness code is this tree's; only the product it serves moves, which is what makes the pair a comparison
// of the tab rather than of the measurement.
//
// WHAT EACH WIDTH IS:
//   1440 - the panel at 1440x900, assistant DOCKED: the rail is the 480px dock, the tab's real home.
//    768 - the same panel at 768x900: the narrowest dock, a pane around 350px.
//   1440 float - the assistant floated full width at 1440: the plate's two columns and the lane's side-by-side set.
//
// WHAT IS MEASURED, not eyeballed: the folded row's height, the open card's height, the pane's scroll height, the type
// step of every run of text, and the contrast ratio of each ink against the background it is actually drawn on
// (composited through every translucent layer above the ground). Plus the facts: every title, description, project,
// branch, assistant, count, wave field, lane and member the API document holds is looked for in the pane's rendered
// text, with every fold opened first, so "nothing is lost" is a list of zero missing strings in both runs.
//
// Exit codes: 0 written; 2 Playwright missing; 1 something threw.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright, notRun, openPage, withBrowser } from "../../../../tools/browser.mjs";
import { buildFixture, startFixturePanel, waitForFixtureRows, waitForInitiativesView } from "../../../../tools/initiatives-fixture.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.ROUTE_ROOT || path.resolve(HERE, "../../../.."));
const OUT = path.resolve(process.env.ROUTE_OUT || HERE);
const HOME = path.resolve(process.env.ROUTE_HOME || path.join(os.tmpdir(), "wag", "route-capture"));
const LABEL = process.env.ROUTE_LABEL || "after";

mkdirSync(OUT, { recursive: true });

// The wave store the fixture predates: three waves on init_sso, every field the route accepts (see
// docs/assets/initiatives-redesign/b/capture-b.mjs, whose seeding this repeats so the two sets photograph the same
// route). wave-flip holds two named lanes with one member each, which is what makes the lane set's layout measurable.
function seedWaves(home) {
  const state = path.join(home, "state");
  const waves = {
    version: 1,
    savedAt: new Date().toISOString(),
    byInitiative: {
      init_sso: [
        { id: "wave-proof", initiativeId: "init_sso", position: 1, title: "Prove the Okta callback through the VIP", entryGate: { check: "clean" }, exitGate: { check: "clean" }, template: null, auto: true },
        { id: "wave-flip", initiativeId: "init_sso", position: 2, title: "Flip the Menu login to SSO behind the toggle", entryGate: { check: "clean" }, exitGate: { check: "pr-open" }, template: null, auto: false },
        { id: "wave-retire", initiativeId: "init_sso", position: 3, title: "Retire the LDAP fallback and close the migration", entryGate: null, exitGate: null, template: "sefl-review-loop", auto: false },
      ],
    },
  };
  writeFileSync(path.join(state, "waves.json"), `${JSON.stringify(waves, null, 2)}\n`, "utf8");
  const patches = { "assistant-1": { 11: { waveId: "wave-flip", lane: "cookie" }, 13: { waveId: "wave-flip", lane: "login" } }, "assistant-2": { 21: { waveId: "wave-proof" } } };
  for (const [id, byTask] of Object.entries(patches)) {
    const file = path.join(state, "assistants", id, "queue.json");
    if (!existsSync(file)) throw new Error(`the fixture has no queue for ${id}`);
    const doc = JSON.parse(readFileSync(file, "utf8"));
    doc.tasks = doc.tasks.map((task) => ({ ...task, ...(byTask[task.id] || {}) }));
    writeFileSync(file, `${JSON.stringify(doc, null, 1)}\n`, "utf8");
  }
}

const api = async (base, route) => {
  const r = await fetch(`${base}${route}`, { signal: AbortSignal.timeout(8000) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const setDock = async (base, mode) => {
  const r = await fetch(`${base}/api/settings/general`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dockMode: mode }),
    signal: AbortSignal.timeout(8000),
  });
  return r.status;
};

// Every fold open, so the fact check reads the whole tab rather than its resting half. The About control is pressed
// too when the tab has one: the paragraph it holds is the one piece of text the redesign moves behind a control, and
// the check has to find it in both renders.
const openEveryFold = async (page) => {
  const press = async (selector) => {
    const nodes = await page.locator(selector).all();
    for (const node of nodes) {
      if ((await node.getAttribute("aria-expanded")) === "false") {
        await node.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(60);
      }
    }
  };
  const about = page.locator("#as-initiatives [data-init-about]");
  if ((await about.count()) > 0 && (await about.first().getAttribute("aria-expanded")) !== "true") {
    await about.first().click().catch(() => {});
    await page.waitForTimeout(120);
  }
  for (let round = 0; round < 4; round += 1) {
    const before = await page.evaluate(() => document.querySelectorAll('#as-initiatives [aria-expanded="false"]').length);
    await press("#as-initiatives [data-init-card-toggle]");
    await press("#as-initiatives [data-init-desc-fold]");
    await press("#as-initiatives [data-init-fold]");
    await press("#as-initiatives [data-init-assist-fold]");
    await press("#as-initiatives [data-init-task-fold]");
    await press("#as-initiatives [data-init-history-fold]");
    const after = await page.evaluate(() => document.querySelectorAll('#as-initiatives [aria-expanded="false"]').length);
    if (after === before || after === 0) break;
  }
  await page.waitForTimeout(400);
};

// THE FACTS, FROM THE DOCUMENT, LOOKED FOR IN THE RENDER. Deterministic: the fixture and the wave seed are the same
// in both runs, so the two lists of missing strings are comparable.
const expectedFacts = (doc) => {
  const out = [];
  const push = (kind, value) => {
    const v = String(value == null ? "" : value).trim();
    if (v) out.push({ kind, value: v });
  };
  for (const init of doc.initiatives || []) {
    push("title", init.title);
    push("description", init.description);
    for (const p of init.projects || []) {
      push("project", p.name);
      for (const t of p.trees || []) {
        push("tree", t.name || String(t.path || "").split(/[\\/]/).pop());
        if (t.branch) push("branch", t.branch);
      }
    }
    for (const a of init.assistants || []) {
      push("assistant", a.name || a.id);
      const c = a.counts || {};
      push("count", `${c.queued ?? 0} queued`);
      push("count", `${c.running ?? 0} running`);
      push("count", `${c.done ?? c.completed ?? 0} completed`);
      push("count", `${c.parked ?? 0} parked`);
    }
    for (const w of init.waves || []) {
      push("wave", w.title);
      push("wave-state", w.stateWord || w.state);
      push("gate", `entry ${w.entryGate?.check || "no check"}`);
      push("gate", `exit ${w.exitGate?.check || "no check"}`);
      for (const m of w.members || []) push("member", m.title);
      // One lane is the implicit lane and is drawn flat: only a set of two or more is drawn as lanes.
      if ((w.lanes || []).length >= 2) for (const l of w.lanes || []) push("lane", `lane ${l.label || l.name} - ${l.state}`);
      if (w.template) push("template", w.template);
    }
  }
  return out;
};

const factCheck = (page, doc) =>
  page.evaluate((facts) => {
    const pane = document.getElementById("as-initiatives");
    const hay = (pane?.innerText || "").replace(/\s+/g, " ").toLowerCase();
    const flat = (s) => String(s).replace(/\s+/g, " ").trim().toLowerCase();
    const missing = facts.filter((f) => !hay.includes(flat(f.value)));
    return { checked: facts.length, missing: missing.map((f) => `${f.kind}: ${f.value.slice(0, 90)}`) };
  }, expectedFacts(doc));

const measure = (page) =>
  page.evaluate(() => {
    const px = (v) => Math.round(Number.parseFloat(v) || 0);
    const pick = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const c = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { fs: px(c.fontSize), fw: c.fontWeight, lh: px(c.lineHeight), color: c.color, bg: c.backgroundColor, h: Math.round(r.height), w: Math.round(r.width) };
    };
    const parse = (v) => {
      const m = String(v || "").match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(",").map((n) => Number(n.trim()));
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const lum = ({ r, g, b }) => {
      const f = (v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    // The background a run of text is really on: its own fill, then every ancestor's, composited down to the ground
    // the pane is painted on. A translucent state wash is therefore measured as the reader sees it.
    const bgOf = (node) => {
      const layers = [];
      let n = node;
      while (n) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c && c.a > 0) layers.push(c);
        if (c && c.a >= 1) break;
        n = n.parentElement;
      }
      layers.push({ r: 15, g: 17, b: 21, a: 1 });
      let base = layers.pop();
      while (layers.length) {
        const l = layers.pop();
        base = { r: l.r * l.a + base.r * (1 - l.a), g: l.g * l.a + base.g * (1 - l.a), b: l.b * l.a + base.b * (1 - l.a), a: 1 };
      }
      return base;
    };
    const contrast = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const c = parse(getComputedStyle(el).color);
      if (!c) return null;
      const bg = bgOf(el);
      const fg = { ...c, a: 1 };
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      return Math.round(((hi + 0.05) / (lo + 0.05)) * 10) / 10;
    };
    const pane = document.getElementById("as-initiatives");
    const folded = document.querySelector("#as-initiatives .init-card.is-titlecard") || document.querySelector("#as-initiatives .init-card");
    const foldedRows = [...document.querySelectorAll("#as-initiatives .init-card.is-titlecard")];
    const openCard = document.querySelector("#as-initiatives .init-card:not(.is-titlecard)");
    const lanes = [...document.querySelectorAll("#as-initiatives .wave-lane")].map((el) => {
      const r = el.getBoundingClientRect();
      return { name: el.getAttribute("data-wave-lane"), left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    });
    const laneSet = document.querySelector("#as-initiatives .wave-lanes");
    const row = document.querySelector("#as-initiatives .wave-row");
    const spine = row ? getComputedStyle(row, "::before") : null;
    const member = document.querySelector("#as-initiatives .wave-member");
    return {
      pane: { width: pane ? Math.round(pane.getBoundingClientRect().width) : null, scroll: pane ? Math.round(pane.scrollHeight) : null },
      folded: folded ? Math.round(folded.getBoundingClientRect().height) : null,
      foldedCount: foldedRows.length,
      foldedRowHeights: foldedRows.map((el) => Math.round(el.getBoundingClientRect().height)),
      openCard: openCard ? Math.round(openCard.getBoundingClientRect().height) : null,
      type: { title: pick("#as-initiatives .init-title"), desc: pick("#as-initiatives .init-desc"), chip: pick("#as-initiatives .init-chips .chip"), status: pick("#as-initiatives .init-status"), sectionHead: pick("#as-initiatives .init-sechead"), tier: pick("#as-initiatives .init-tier"), waveTitle: pick("#as-initiatives .wave-title"), waveState: pick("#as-initiatives .wave-head .chip"), gate: pick("#as-initiatives .wave-gate"), member: pick("#as-initiatives .wave-member"), memberId: pick("#as-initiatives .wave-member-id") },
      contrast: { desc: contrast("#as-initiatives .init-desc"), chip: contrast("#as-initiatives .init-chips .chip"), status: contrast("#as-initiatives .init-status"), gate: contrast("#as-initiatives .wave-gate"), auto: contrast("#as-initiatives .wave-auto"), memberProject: contrast("#as-initiatives .wave-member-project"), tier: contrast("#as-initiatives .init-tier"), sectionHead: contrast("#as-initiatives .init-sechead") },
      chips: { total: document.querySelectorAll("#as-initiatives .chip").length, buttons: document.querySelectorAll("#as-initiatives button").length, links: document.querySelectorAll("#as-initiatives a").length },
      waves: { rows: document.querySelectorAll("#as-initiatives .wave-row").length, spine: spine ? { width: spine.width, color: spine.backgroundColor } : null, lanes, laneSet: laneSet ? { columns: getComputedStyle(laneSet).gridTemplateColumns, w: Math.round(laneSet.getBoundingClientRect().width) } : null, member: member ? { display: getComputedStyle(member).display, columns: getComputedStyle(member).gridTemplateColumns, h: Math.round(member.getBoundingClientRect().height) } : null },
      docked: (() => {
        const el = document.getElementById("assistant");
        return Boolean(el) && getComputedStyle(el).position !== "fixed" && getComputedStyle(el).position !== "absolute" ? "dock" : "float";
      })(),
    };
  });

const collapseCard = async (page, id) => {
  const head = page.locator(`#as-initiatives [data-init-card="${id}"] [data-init-card-toggle]`);
  if ((await head.count()) === 0) return;
  if ((await head.first().getAttribute("aria-expanded")) === "true") await head.first().click();
  await page.waitForTimeout(150);
};

const openCard = async (page, id) => {
  const head = page.locator(`#as-initiatives [data-init-card="${id}"] [data-init-card-toggle]`);
  if ((await head.count()) === 0) return;
  if ((await head.first().getAttribute("aria-expanded")) !== "true") await head.first().click();
  await page.waitForSelector(`#as-initiatives [data-init-card="${id}"] .init-projects`, { timeout: 20_000 });
  await page.waitForTimeout(250);
};

const openTab = async (page, base) => {
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
  await page.evaluate(() => {
    const pane = document.getElementById("as-initiatives");
    if (pane) pane.scrollTop = 0;
  });
  await page.waitForTimeout(300);
};

let panel = null;
// THE LEDGER IS READ BY PEOPLE, AND IT IS COMMITTED. A drive-letter path exists on one machine, so the tree is
// described rather than pointed at: the harness is run once per tree and the label says which is which.
const TREE = LABEL === "before" ? "a git archive of 86bea38 (1.157.1), unpacked outside the repo" : "this working tree";
const report = { label: LABEL, tree: TREE, at: new Date().toISOString(), widths: {}, facts: {}, shots: [] };

try {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log(notRun("the route captures", "playwright is not installed for this node (see tools/browser.mjs)"));
    process.exit(2);
  }
  console.log(`label: ${LABEL}`);
  console.log(`root:  ${ROOT.replace(/\\/g, "/")}`);
  console.log(`out:   ${OUT.replace(/\\/g, "/")}`);
  await buildFixture({ home: HOME, reset: true });
  seedWaves(HOME);
  panel = await startFixturePanel({ home: HOME, root: ROOT });
  console.log(`panel: ${panel.base} (pid ${panel.pid})`);
  await waitForFixtureRows(panel.base);
  await waitForInitiativesView(panel.base);
  const doc = (await api(panel.base, "/api/initiatives")).body;
  report.facts.doc = (doc.initiatives || []).map((i) => ({ id: i.id, title: i.title, trees: i.treeCount, waves: (i.waves || []).length }));

  await withBrowser(async ({ page }) => {
    const shot = async (slug, note) => {
      const file = path.join(OUT, `${slug}.png`);
      await page.screenshot({ path: file });
      report.shots.push({ file: path.basename(file), slug, note });
      console.log(`shot  ${slug}`);
    };
    // A TALL SHOT NEEDS A TALL WINDOW. The pane is a scroll container inside a fixed-height rail, so an element shot
    // of a card taller than the viewport is clipped by the pane and comes back with blank bands where the content
    // scrolled away. The window is grown to the pane's own scroll height first (never the WIDTH: the design answers to
    // inline size, so a taller window renders the same layout), the shot is taken, and the window is put back.
    const shotEl = async (selector, slug, note) => {
      const file = path.join(OUT, `${slug}.png`);
      const vp = page.viewportSize();
      const needed = await page.evaluate(() => {
        const pane = document.getElementById("as-initiatives");
        return pane ? Math.ceil(pane.scrollHeight) + 160 : 900;
      });
      const taller = Math.max(vp.height, Math.min(2600, needed));
      if (taller !== vp.height) {
        await page.setViewportSize({ width: vp.width, height: taller });
        await page.waitForTimeout(350);
      }
      await page.locator(selector).first().screenshot({ path: file });
      if (taller !== vp.height) {
        await page.setViewportSize(vp);
        await page.waitForTimeout(250);
      }
      report.shots.push({ file: path.basename(file), slug, element: selector, viewport: { ...vp, height: taller }, note });
      console.log(`shot  ${slug}  ${selector}${taller !== vp.height ? ` (window ${taller}px tall for the shot)` : ""}`);
    };

    // ---- 1440, the rail docked (the tab's home) ----------------------------------------------------
    await page.setViewportSize({ width: 1440, height: 900 });
    await openTab(page, panel.base);
    await setDock(panel.base, "docked");
    await page.reload({ waitUntil: "domcontentloaded" });
    await openTab(page, panel.base);
    await collapseCard(page, "init_sso");
    await page.waitForTimeout(250);
    await shot("01-1440-list", "the folded ledger at 1440, the assistant docked at 480");
    await shotEl("#as-initiatives", "01b-1440-pane", "the whole tab at 1440 docked");
    await openCard(page, "init_sso");
    report.widths["1440-dock"] = await measure(page);
    await shot("02-1440-open", "the plate and its route at 1440 docked");
    await shotEl('#as-initiatives [data-init-card="init_sso"]', "02b-1440-plate", "the open initiative at 1440 docked");
    await shotEl('#as-initiatives [data-init-card="init_sso"] .init-wavefold', "02c-1440-waves", "the wave lane at 1440 docked");
    await openEveryFold(page);
    report.facts["1440-dock"] = await factCheck(page, doc);
    await shot("03-1440-all-folds", "every fold open, the fact check's own reading");

    // ---- 768, the narrowest dock -------------------------------------------------------------------
    await page.setViewportSize({ width: 768, height: 900 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await openTab(page, panel.base);
    await collapseCard(page, "init_sso");
    await shot("04-768-list", "the folded ledger at 768");
    await openCard(page, "init_sso");
    report.widths["768-dock"] = await measure(page);
    await shot("05-768-open", "the plate and its route at 768");
    await shotEl('#as-initiatives [data-init-card="init_sso"] .init-wavefold', "05b-768-waves", "the wave lane at 768");
    await openEveryFold(page);
    report.facts["768-dock"] = await factCheck(page, doc);

    // ---- 1440, the assistant floated: the wide plate ------------------------------------------------
    await page.setViewportSize({ width: 1440, height: 900 });
    await setDock(panel.base, "floating");
    // The floated assistant remembers its own rectangle (wm.assistantFloat); without it the frame opens at its
    // default narrow width and neither the two-column plate nor the side-by-side lane set is ever drawn.
    await page.evaluate(() => {
      localStorage.setItem("wm.assistantOpen", "1");
      localStorage.setItem("wm.assistantFloat", JSON.stringify({ x: 8, y: 80, w: 1384, h: 860 }));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await openTab(page, panel.base);
    await collapseCard(page, "init_sso");
    await shot("06-wide-list", "the ledger at 1440 with the assistant floated");
    await openCard(page, "init_sso");
    report.widths["1440-float"] = await measure(page);
    await shot("07-wide-open", "the wide plate: words left, cast right, route full width");
    await shotEl('#as-initiatives [data-init-card="init_sso"] .init-wavefold', "07b-wide-waves", "the lane set side by side on the wide plate");

    // ---- the density token, when the tab offers it (after only) -------------------------------------
    const density = page.locator("#as-initiatives [data-init-density]");
    if ((await density.count()) > 0) {
      await density.first().click();
      await page.waitForTimeout(300);
      report.widths["1440-float-compact"] = await measure(page);
      await shot("08-wide-compact", "the same plate on the compact token set");
      const back = page.locator("#as-initiatives [data-init-density]");
      if ((await back.count()) > 0) await back.first().click();
      await page.waitForTimeout(250);
    }
    await setDock(panel.base, "docked");
  });

  const file = path.join(OUT, `captures-${LABEL}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const facts = Object.values(report.facts).filter((f) => f && Array.isArray(f.missing));
  const missing = facts.reduce((n, f) => n + f.missing.length, 0);
  console.log(`\nfacts checked: ${facts.map((f) => `${f.checked}/${f.missing.length} missing`).join(", ") || "none"}`);
  console.log(`shots: ${report.shots.length}`);
  console.log(`ledger: ${file.replace(/\\/g, "/")}`);
  if (missing > 0) {
    console.log(`\nMISSING FACTS (${LABEL}):`);
    for (const f of Object.values(report.facts)) if (f && f.missing) for (const m of f.missing) console.log(`  - ${m}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`\nTHREW: ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
} finally {
  if (panel) panel.stop?.();
}
