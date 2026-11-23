// Capture the proof panel's Initiatives tab at three widths, with the throwaway card open.
// Reads the DOM it shoots, so the comparison table cites selectors and text, not a memory of the picture.
import { mkdirSync, writeFileSync } from "node:fs";
import { withBrowser, openPage } from "file:///C:/ProjectDevelopment/agent-worktree-gui/.worktrees/research-round-b-for-the-initiatives-tab-1d1d2c/tools/browser.mjs";

const BASE = process.env.BASE || "http://127.0.0.1:7332";
const OUT = process.env.OUT || "C:/Users/roper/AppData/Local/Temp/wag/73596cb0/shots";
const TAG = process.env.TAG || "before";
mkdirSync(OUT, { recursive: true });

const measure = () =>
  (() => {
    const pane = document.querySelector("#as-initiatives");
    const card = [...document.querySelectorAll("#as-initiatives .init-card")].find((c) =>
      /Sketch proof/i.test(c.querySelector(".init-title")?.textContent || ""),
    );
    const pick = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
    };
    const cs = (el, props) => (el ? Object.fromEntries(props.map((p) => [p, getComputedStyle(el)[p]])) : null);
    const rows = [...document.querySelectorAll("#as-initiatives .init-card.is-titlecard")].map((c) => ({
      title: pick(c.querySelector(".init-title")),
      dots: c.querySelectorAll(".init-glyph i").length,
      dotTones: [...c.querySelectorAll(".init-glyph i")].map((d) => d.className),
      status: pick(c.querySelector(".init-status")),
      statusClass: c.querySelector(".init-status")?.className || null,
      hasRoute: c.classList.contains("has-route"),
      chips: [...c.querySelectorAll(".init-chips .chip, .init-chips .init-meta")].map(pick),
      desc: pick(c.querySelector(".init-desc")),
      box: box(c),
    }));
    const waveRows = [...(card?.querySelectorAll(".wave-row") || [])].map((w) => ({
      id: w.dataset.waveId,
      state: w.dataset.waveState,
      current: w.dataset.waveCurrent || null,
      pos: pick(w.querySelector(".wave-pos")),
      title: pick(w.querySelector(".wave-title")),
      stateChip: pick(w.querySelector(".wave-state")),
      currentChip: pick(w.querySelector(".wave-current")),
      gates: [...w.querySelectorAll(".wave-gates .chip")].map((c) => ({ text: pick(c), cls: c.className, gate: c.dataset.waveGate || null, state: c.dataset.gateState || null })),
      template: pick(w.querySelector(".wave-template")),
      join: pick(w.querySelector(".wave-join")),
      joinClass: w.querySelector(".wave-join")?.className || null,
      lanes: [...w.querySelectorAll(".wave-lane")].map((l) => ({
        label: l.dataset.waveLane,
        state: l.dataset.laneState,
        read: l.dataset.laneRead,
        chip: pick(l.querySelector(".wave-mstate")),
        hint: pick(l.querySelector(".wave-lane-read")),
        members: [...l.querySelectorAll(".wave-member")].map((m) => ({ text: pick(m), state: m.dataset.memberState, id: m.dataset.waveMember, box: box(m) })),
        box: box(l),
      })),
      flatMembers: [...w.querySelectorAll(":scope > .wave-members .wave-member")].map((m) => ({ text: pick(m), state: m.dataset.memberState })),
      box: box(w),
      headBox: box(w.querySelector(".wave-head")),
      gatesBox: box(w.querySelector(".wave-gates")),
      posBox: box(w.querySelector(".wave-pos")),
      stateBox: box(w.querySelector(".wave-state")),
    }));
    return {
      pane: { w: Math.round(pane?.clientWidth || 0), scroll: Math.round(pane?.scrollWidth || 0), height: Math.round(pane?.clientHeight || 0), scrollHeight: Math.round(pane?.scrollHeight || 0) },
      docScroll: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
      foldedRows: rows,
      card: card
        ? {
            title: pick(card.querySelector(".init-title")),
            desc: pick(card.querySelector(".init-desc")),
            chips: [...card.querySelectorAll(":scope > .init-chips .chip, :scope > .init-chips .init-meta")].map(pick),
            projects: [...card.querySelectorAll(".init-project")].map((p) => ({
              name: pick(p.querySelector(".init-proj-name")),
              chip: pick(p.querySelector(".chip")),
              box: box(p),
            })),
            addTree: pick(card.querySelector(".init-add")),
            waveHead: pick(card.querySelector(".init-wavefold .init-sechead")),
            waveNote: pick(card.querySelector(".init-wave-note")),
            waveRows,
            assistantsFold: pick(card.querySelector(".init-assistfold .init-proj")),
            historyFold: pick(card.querySelector(".init-histfold .init-proj")),
            box: box(card),
          }
        : null,
      styles: {
        title: cs(document.querySelector("#as-initiatives .init-title"), ["fontSize", "fontWeight", "color", "fontFamily"]),
        wavePos: cs(document.querySelector("#as-initiatives .wave-pos"), ["fontSize", "color", "fontFamily", "letterSpacing", "borderRadius", "width", "height"]),
        waveTitle: cs(document.querySelector("#as-initiatives .wave-title"), ["fontSize", "fontWeight", "color"]),
        waveState: cs(document.querySelector("#as-initiatives .wave-state"), ["fontSize", "color", "background", "borderColor", "borderRadius"]),
        gateChip: cs(document.querySelector("#as-initiatives .wave-gate"), ["fontSize", "color", "background", "borderColor", "borderRadius"]),
        laneChip: cs(document.querySelector("#as-initiatives .wave-lane .wave-mstate"), ["fontSize", "color", "background"]),
        member: cs(document.querySelector("#as-initiatives .wave-member"), ["fontSize", "color", "background", "borderColor", "borderRadius", "padding"]),
        join: cs(document.querySelector("#as-initiatives .wave-join"), ["fontSize", "color", "background", "borderColor"]),
        status: cs(document.querySelector("#as-initiatives .init-status"), ["fontSize", "color", "background", "borderRadius"]),
      },
    };
  })();

const scrollCard = (page, offset) =>
  page.evaluate((off) => {
    const pane = document.querySelector("#as-initiatives");
    const card = [...document.querySelectorAll("#as-initiatives .init-card")].find((c) => /Sketch proof/i.test(c.querySelector(".init-title")?.textContent || ""));
    if (!pane || !card) return null;
    pane.scrollTop += card.getBoundingClientRect().top - pane.getBoundingClientRect().top - off;
    return pane.scrollTop;
  }, offset);

const scrollWaves = (page) =>
  page.evaluate(() => {
    const pane = document.querySelector("#as-initiatives");
    const waves = document.querySelector("#as-initiatives .init-card:not(.is-titlecard) .init-wavefold");
    if (!pane || !waves) return null;
    pane.scrollTop += waves.getBoundingClientRect().top - pane.getBoundingClientRect().top - 8;
    return pane.scrollTop;
  });

const verdict = await withBrowser(
  async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e.message || e)));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await openPage(page, BASE, { selector: "#btn-assistant", timeout: 30_000 });
    const railOpen = await page.evaluate(() => {
      const el = document.getElementById("assistant");
      return Boolean(el) && !el.hidden && getComputedStyle(el).display !== "none";
    });
    if (!railOpen) await page.click("#btn-assistant");
    await page.waitForSelector("#assistant:not([hidden])", { timeout: 20_000 });
    const tab = '#as-tabs [data-as-tab="initiatives"]';
    await page.waitForSelector(tab, { timeout: 20_000 });
    if (!(await page.evaluate((s) => document.querySelector(s)?.getAttribute("aria-selected") === "true", tab))) {
      await page.click(tab);
    }
    await page.waitForSelector("#as-initiatives:not(.hidden) .init-card", { timeout: 30_000 });
    const head = page.locator("#as-initiatives .init-card", { hasText: "Sketch proof" }).locator(".init-head-btn").first();
    await head.scrollIntoViewIfNeeded();
    await head.click();
    await page.waitForSelector("#as-initiatives .init-card:not(.is-titlecard) .init-wavefold", { timeout: 20_000 });
    await page.waitForTimeout(600);

    const shoot = async (tag, width, height) => {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(500);
      const out = { width, height };
      await scrollCard(page, 250);
      await page.waitForTimeout(200);
      const paneShot = `${OUT}/${TAG}-${tag}-pane.png`;
      await page.locator("#as-initiatives").screenshot({ path: paneShot });
      out.paneShot = paneShot;
      await scrollWaves(page);
      await page.waitForTimeout(250);
      const wavesShot = `${OUT}/${TAG}-${tag}-waves.png`;
      const wave = page.locator("#as-initiatives .init-card:not(.is-titlecard) .init-wavefold").first();
      try {
        await wave.screenshot({ path: wavesShot, timeout: 15_000 });
        out.wavesShot = wavesShot;
      } catch (e) {
        out.wavesShotError = String(e.message || e);
      }
      out.dom = await page.evaluate(measure);
      return out;
    };

    const runs = {};
    runs["1440"] = await shoot("1440", 1440, 900);
    runs["768"] = await shoot("768", 768, 900);
    runs["480"] = await shoot("480", 480, 900);
    // the wide float: the pane the sketch was drawn at, where two lanes can sit side by side
    await page.setViewportSize({ width: 1440, height: 900 });
    const switched = await fetch(`${BASE}/api/settings/general`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dockMode: "floating" }),
      signal: AbortSignal.timeout(8000),
    }).catch((e) => ({ ok: false, status: String(e.message || e) }));
    await page.evaluate(() => {
      localStorage.setItem("wm.assistantOpen", "1");
      localStorage.setItem("wm.assistantFloat", JSON.stringify({ x: 8, y: 80, w: 1384, h: 860 }));
    });
    await openPage(page, BASE, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForSelector("#as-tabs", { timeout: 20_000 });
    if (!(await page.evaluate((s) => document.querySelector(s)?.getAttribute("aria-selected") === "true", tab))) {
      await page.click(tab);
    }
    await page.waitForSelector("#as-initiatives:not(.is-titlecard) .init-card, #as-initiatives .init-card", { timeout: 20_000 });
    const headWide = page.locator("#as-initiatives .init-card", { hasText: "Sketch proof" }).locator(".init-head-btn").first();
    await headWide.scrollIntoViewIfNeeded();
    await headWide.click();
    await page.waitForSelector("#as-initiatives .init-card:not(.is-titlecard) .init-wavefold", { timeout: 20_000 });
    await page.waitForTimeout(800);
    runs.wide = await shoot("wide", 1440, 1000);
    runs.wide.switched = switched.ok === true ? "floating" : `switch failed: ${switched.status}`;
    await fetch(`${BASE}/api/settings/general`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dockMode: "docked" }),
      signal: AbortSignal.timeout(8000),
    }).catch(() => {});
    return { runs, errors };
  },
  { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
);

writeFileSync(`${OUT}/${TAG}-dom.json`, JSON.stringify(verdict, null, 1));
const r = verdict.runs["1440"].dom;
console.log(JSON.stringify({
  errors: verdict.errors,
  pane1440: r.pane,
  folded: r.foldedRows.map((x) => [String(x.title).slice(0, 40), x.dots, x.status, x.hasRoute]),
  waves: r.card?.waveRows?.map((w) => [w.pos, w.state, w.stateChip, w.lanes.length, w.join]),
  widePane: verdict.runs.wide.dom.pane,
  wideLanes: verdict.runs.wide.dom.card?.waveRows?.[2]?.lanes?.map((l) => l.box),
}, null, 1));
