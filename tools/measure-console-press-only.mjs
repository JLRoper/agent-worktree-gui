#!/usr/bin/env node
// MEASURE: the console's corner grip, pressed and held with NO movement, read before, during and after the press.
//
//   node tools/measure-console-press-only.mjs                      # the live panel at 127.0.0.1:7331
//   node tools/measure-console-press-only.mjs --serve <checkout>   # that checkout's public/, live data
//   node tools/measure-console-press-only.mjs --widths 1600,820 --heights 100,140,300,460
//   node tools/measure-console-press-only.mjs --json <file>
//
// WHY. The reader reports that a pointerdown on the corner with NO movement moves the corner about five percent of the
// screen HEIGHT higher the instant the press lands. verify-console-corner-drag's no-move case reads the box BEFORE the
// press and AFTER the release, so a box that jumps on the press and is put back on the release passes it. This tool
// samples the hold: the drawn height and top edge at 0, 50, 100 ... 500 ms after the press, then after the release.
// A press that moves nothing must read delta 0 at every sample.
//
// It also names the writers it saw: every setOutHeight call with its stack, every style mutation on the console, and
// every scrollTop write on the transcript. The `top` delta is the corner's own movement on screen; a height delta with
// a top delta of 0 is the box growing downward, a top delta is the box - and the hand - moving.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPO, loadPlaywright, notRun } from "./browser.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const BASE = String(opt("url", process.env.PANEL_URL || "http://127.0.0.1:7331")).replace(/\/$/, "");
const SERVE = opt("serve", null) ? path.resolve(opt("serve", null)) : null;
// A `--serve` that names no checkout is a run that would measure the PANEL's own files and report a pass on a tree
// nobody served - the route's `continue()` fallback hides it, so it is refused here instead. (A git-bash `$PWD` is
// `/c/...`, which path.resolve turns into a broken drive-letter path: the exact mistake this guard exists to stop.)
if (SERVE && !existsSync(path.join(SERVE, "public", "index.html"))) {
  console.error(`--serve ${SERVE} has no public/index.html: refusing to measure the panel's own files instead`);
  process.exit(2);
}
const WIDTHS = String(opt("widths", "1600,820")).split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);
const HEIGHTS = String(opt("heights", "100,140,300,460")).split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);
const JSON_OUT = opt("json", null);
const CLEAR = args.includes("--clear");
const ZOOM = Number(opt("zoom", 100)) || 100;
const DRAG = Number(opt("drag", 0)) || 0; // visual px of pointer travel AFTER the press-only hold, to prove a real drag
const INNER_H = Number(opt("inner-height", 1080)) || 1080;
const HOLD_MS = 500;
const SAMPLE_MS = 50;
const GRIP_INSET_PX = 3;
const OPEN_KEY = "wm.assistantOpen";
const MIME = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
};

const rows = [];
const checks = [];
function check(ok, label, detail) {
  checks.push({ ok: Boolean(ok), label, detail: detail == null ? "" : String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
}

const PAGE_HELPERS = (gripInset) => {
  const pane = () => [...document.querySelectorAll('#assistant [data-subpane="chat"]')].find((p) => p.getBoundingClientRect().width > 80) || null;
  const body = () => pane()?.querySelector(":scope > .job > .job-body") || null;
  const openTurns = () => (body() ? [...body().querySelectorAll(":scope > .turn:not(.folded)")] : []);
  const out = () => {
    const turns = openTurns();
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const o = turns[i].querySelector(":scope > .out-wrap > .out-box > pre.job-out");
      if (o) return o;
    }
    return null;
  };
  const grip = () => {
    const o = out();
    return o ? o.parentElement.querySelector(":scope > .out-grip") : null;
  };
  const store = () => {
    let ls = {};
    try { ls = JSON.parse(localStorage.getItem("wm.outHeights") || "{}"); } catch { /* unreadable is empty */ }
    return { state: (typeof state !== "undefined" && state.outHeights) || {}, ls };
  };
  const W = { writes: [], calls: [], mutations: [], node: null, bodyWrites: [], observer: null, origSet: null, origScroll: null };

  window.__PO = {
    pane, body, out, grip, openTurns,
    at: () => {
      const g = grip();
      if (!g) return null;
      const r = g.getBoundingClientRect();
      return { x: +(r.right - gripInset).toFixed(1), y: +(r.bottom - gripInset).toFixed(1) };
    },
    read: () => {
      const o = out();
      const g = grip();
      const b = body();
      if (!o || !g || !b) return null;
      const r = o.getBoundingClientRect();
      const gr = g.getBoundingClientRect();
      const s = store();
      const id = o.dataset.out || "";
      const varRaw = o.style.getPropertyValue("--out-h") || "";
      const cs = getComputedStyle(o);
      return {
        t: Math.round(performance.now()),
        h: +r.height.toFixed(2),
        top: +r.top.toFixed(2),
        bottom: +r.bottom.toFixed(2),
        clientH: o.clientHeight,
        varH: varRaw,
        varPx: varRaw ? parseFloat(varRaw) : null,
        stored: Number.isFinite(Number(s.state[id])) ? Number(s.state[id]) : null,
        gripBottom: +gr.bottom.toFixed(2),
        bodyTop: b.scrollTop,
        bodyMax: b.scrollHeight - b.clientHeight,
        minH: cs.minHeight,
        maxH: cs.maxH || cs.maxHeight,
        inlineMax: o.style.maxHeight,
        inlineMin: o.style.minHeight,
        ownTop: o.scrollTop,
        content: o.scrollHeight,
        paneW: Math.round(pane().getBoundingClientRect().width),
        held: typeof outDragging === "function" ? outDragging(o) : null,
        dragH: typeof outGripDrag !== "undefined" && outGripDrag ? +Number(outGripDrag.h).toFixed(2) : null,
        dragTop: typeof outGripDrag !== "undefined" && outGripDrag ? +Number(outGripDrag.top).toFixed(2) : null,
        moved: typeof outGripDrag !== "undefined" && outGripDrag ? Boolean(outGripDrag.moved) : null,
        same: o === W.node,
        sig: b.closest(".job")?.dataset.sig || "",
        slack: Boolean(b.querySelector(":scope > .turn.is-slack")),
        flex: cs.flex,
        zoom: getComputedStyle(document.documentElement).zoom || "1",
        innerH: window.innerHeight,
        docH: document.documentElement.clientHeight,
        visH: window.visualViewport ? +window.visualViewport.height.toFixed(2) : null,
        bodyClass: document.body.className,
        paneScroll: (() => { const p = pane(); return p ? p.scrollTop : null; })(),
      };
    },
    mark: () => { W.node = out(); return true; },
    // The console's own chain, and the one row above it that could move it: every ancestor whose height decides where
    // the corner is, read as rects so a press that moves the corner says WHICH box changed.
    chain: () => {
      const o = out();
      if (!o) return null;
      const pick = (el, name) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { name, h: +r.height.toFixed(2), top: +r.top.toFixed(2), bottom: +r.bottom.toFixed(2) };
      };
      const job = o.closest(".job");
      return {
        head: pick(job?.querySelector(":scope > .job-head"), "job-head"),
        body: pick(o.closest(".job-body"), "job-body"),
        turn: pick(o.closest(".turn"), "turn"),
        wrap: pick(o.closest(".out-wrap"), "out-wrap"),
        box: pick(o.closest(".out-box"), "out-box"),
        out: pick(o, "job-out"),
        reply: pick(o.closest(".job-body")?.querySelector(":scope > .reply"), "reply"),
        foot: pick(o.closest(".job-body")?.querySelector(":scope > .job-foot"), "job-foot"),
        turns: (o.closest(".job-body")?.querySelectorAll(":scope > .turn") || []).length,
        folded: (o.closest(".job-body")?.querySelectorAll(":scope > .turn.folded") || []).length,
      };
    },
    // What the layout moved on its own, with Chromium's own attribution: a layout-shift entry names the nodes whose
    // rect changed and their previous/current boxes, so the writer is named by the page rather than guessed.
    shifts: () => {
      try {
        return performance.getEntriesByType("layout-shift").slice(-6).map((e) => ({
          value: +e.value.toFixed(4),
          at: Math.round(e.startTime),
          sources: (e.sources || []).slice(0, 6).map((s) => ({
            tag: s.node ? s.node.tagName || "" : "",
            cls: s.node ? String(s.node.className || "").slice(0, 60) : "",
            prev: s.previousRect ? [s.previousRect.x, s.previousRect.y, s.previousRect.width, s.previousRect.height].map((n) => Math.round(n)) : null,
            now: s.currentRect ? [s.currentRect.x, s.currentRect.y, s.currentRect.width, s.currentRect.height].map((n) => Math.round(n)) : null,
          })),
        }));
      } catch { return []; }
    },
    clearHeight: () => {
      const o = out();
      if (!o) return null;
      if (typeof clearOutHeight === "function") clearOutHeight(o);
      else o.style.removeProperty("--out-h");
      o.style.maxHeight = "";
      o.style.minHeight = "";
      try {
        if (typeof state !== "undefined" && state.outHeights && o.dataset.out) delete state.outHeights[o.dataset.out];
        const ls = JSON.parse(localStorage.getItem("wm.outHeights") || "{}");
        delete ls[o.dataset.out];
        localStorage.setItem("wm.outHeights", JSON.stringify(ls));
      } catch { /* the store is best effort here */ }
      return { h: +o.getBoundingClientRect().height.toFixed(2), varH: o.style.getPropertyValue("--out-h") };
    },
    foot: () => {
      const b = body();
      if (!b) return null;
      b._atBottom = true;
      b.scrollTop = b.scrollHeight;
      return { top: b.scrollTop, max: b.scrollHeight - b.clientHeight };
    },
    setStart: (px) => {
      const o = out();
      if (!o || typeof setOutHeight !== "function") return null;
      setOutHeight(o, px);
      if (typeof rememberOutHeight === "function") rememberOutHeight(o.dataset.out, px);
      return { h: +o.getBoundingClientRect().height.toFixed(2), varH: o.style.getPropertyValue("--out-h") };
    },
    // Every writer that could move this box, with the stack it was called from. The page is one global scope, so
    // setOutHeight is a global function and can be wrapped here; scrollTop is patched on Element.prototype and only
    // recorded when the element is THIS transcript.
    instrument: () => {
      W.calls = [];
      W.mutations = [];
      W.bodyWrites = [];
      W.shiftList = [];
      try {
        if (!W.shiftObs && typeof PerformanceObserver === "function") {
          W.shiftObs = new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
              W.shiftList.push({
                value: +e.value.toFixed(4),
                at: Math.round(e.startTime),
                hadRecentInput: e.hadRecentInput,
                sources: (e.sources || []).slice(0, 6).map((s) => ({
                  tag: s.node ? s.node.tagName || "" : "",
                  cls: s.node ? String(s.node.className || "").slice(0, 70) : "",
                  prev: s.previousRect ? [s.previousRect.x, s.previousRect.y, s.previousRect.width, s.previousRect.height].map((n) => Math.round(n)) : null,
                  now: s.currentRect ? [s.currentRect.x, s.currentRect.y, s.currentRect.width, s.currentRect.height].map((n) => Math.round(n)) : null,
                })),
              });
            }
          });
          W.shiftObs.observe({ type: "layout-shift", buffered: true });
        }
      } catch { /* no layout-shift support: the chain reads still name the box */ }
      if (typeof setOutHeight === "function" && !W.origSet) {
        W.origSet = setOutHeight;
        window.setOutHeight = function (el, px) {
          try {
            if (el === out() && W.calls.length < 12) W.calls.push({ px: Number(px), at: Math.round(performance.now()), stack: new Error().stack.split("\n").slice(1, 5).join(" <- ") });
          } catch { /* no console on screen */ }
          return W.origSet(el, px);
        };
      }
      if (!W.origScroll) {
        const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
        W.origScroll = desc;
        Object.defineProperty(Element.prototype, "scrollTop", {
          configurable: true,
          get: desc.get,
          set(v) {
            try {
              if (this === body() && W.bodyWrites.length < 12) {
                W.bodyWrites.push({ to: Math.round(Number(v) || 0), from: desc.get.call(this), at: Math.round(performance.now()), stack: new Error().stack.split("\n").slice(1, 4).join(" <- ") });
              }
            } catch { /* not the transcript */ }
            return desc.set.call(this, v);
          },
        });
      }
      const o = out();
      if (W.observer) W.observer.disconnect();
      if (o) {
        W.observer = new MutationObserver((recs) => {
          for (const r of recs) {
            if (W.mutations.length > 20) break;
            W.mutations.push({
              type: r.type,
              attr: r.attributeName || "",
              to: r.type === "attributes" ? (o.getAttribute(r.attributeName) || "") : "",
              at: Math.round(performance.now()),
            });
          }
        });
        W.observer.observe(o, { attributes: true, attributeFilter: ["style", "class"], childList: true });
      }
      return true;
    },
    evidence: () => {
      if (W.observer) { W.observer.disconnect(); W.observer = null; }
      return { calls: W.calls, mutations: W.mutations, bodyWrites: W.bodyWrites, shifts: W.shiftList || [] };
    },
    version: () => (typeof state !== "undefined" && state.settings ? state.settings.version : ""),
  };
};

const READY = () => {
  const panes = [...document.querySelectorAll('#assistant [data-subpane="chat"]')];
  const pane = panes.find((p) => p.getBoundingClientRect().width > 80);
  if (!pane) return { ok: false, why: "the chat pane is not on screen" };
  const body = pane.querySelector(":scope > .job > .job-body");
  const turns = body ? [...body.querySelectorAll(":scope > .turn:not(.folded)")] : [];
  let o = null;
  for (let i = turns.length - 1; i >= 0 && !o; i -= 1) o = turns[i].querySelector(":scope > .out-wrap > .out-box > pre.job-out");
  if (!body || !o) return { ok: false, why: "no open turn with a console" };
  const g = o.parentElement.querySelector(":scope > .out-grip");
  if (!g) return { ok: false, why: "the console has no corner grip" };
  const gr = g.getBoundingClientRect();
  return {
    ok: true,
    turns: turns.length,
    paneW: Math.round(pane.getBoundingClientRect().width),
    consoleW: Math.round(o.getBoundingClientRect().width),
    consoleH: Math.round(o.getBoundingClientRect().height),
    inView: gr.bottom > 8 && gr.bottom <= innerHeight - 2 && gr.right > 8 && gr.right <= innerWidth - 2,
  };
};

async function loadPanel(page) {
  if (SERVE) {
    const root = path.join(SERVE, "public");
    await page.route(`${BASE}/**`, async (route) => {
      const url = new URL(route.request().url());
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
      const file = path.resolve(root, rel);
      if (!file.startsWith(path.resolve(root) + path.sep)) return route.continue();
      try {
        const body = readFileSync(file);
        const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
        return await route.fulfill({ status: 200, contentType: type, body });
      } catch {
        return route.continue();
      }
    });
  }
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 45_000 });
  let ready = null;
  for (let i = 0; i < 100; i += 1) {
    ready = await page.evaluate(READY).catch(() => null);
    if (ready && ready.ok && ready.inView) break;
    if (i === 8) {
      await page.evaluate(() => {
        if (typeof state !== "undefined" && !state.assistantOpen) document.querySelector("#btn-assistant")?.click();
      }).catch(() => {});
    }
    await page.waitForTimeout(500);
  }
  if (!ready || !ready.ok) throw new Error(`no console with a corner grip in the chat pane: ${ready ? ready.why : "the page did not answer"}`);
  await page.evaluate(PAGE_HELPERS, GRIP_INSET_PX);
  return ready;
}

async function aim(page) {
  let last = null;
  for (let k = 0; k < 40; k += 1) {
    const g = await page.evaluate(() => window.__PO.at());
    if (last && g && Math.abs(g.y - last.y) < 0.5 && Math.abs(g.x - last.x) < 0.5) return g;
    last = g;
    await page.waitForTimeout(50);
  }
  return last;
}

async function pressOnly(page, width, px) {
  const set = CLEAR ? await page.evaluate(() => window.__PO.clearHeight()) : await page.evaluate((n) => window.__PO.setStart(n), px);
  await page.waitForTimeout(160);
  await page.evaluate(() => window.__PO.foot());
  await page.waitForTimeout(150);
  const before = await page.evaluate(() => window.__PO.read());
  const chainBefore = await page.evaluate(() => window.__PO.chain());
  const at = await aim(page);
  if (!at) throw new Error("the grip went away before the press");
  await page.evaluate(() => { window.__PO.mark(); window.__PO.instrument(); });
  await page.mouse.move(at.x, at.y);
  await page.waitForTimeout(40);
  const prePress = await page.evaluate(() => window.__PO.read());
  await page.mouse.down();
  const during = [];
  const t0 = Date.now();
  for (let i = 0; i <= Math.round(HOLD_MS / SAMPLE_MS); i += 1) {
    const r = await page.evaluate(() => window.__PO.read());
    if (r) during.push({ ...r, ms: Date.now() - t0 });
    if (i * SAMPLE_MS < HOLD_MS) await page.waitForTimeout(SAMPLE_MS);
  }
  const chainDuring = await page.evaluate(() => window.__PO.chain());
  const evidence = await page.evaluate(() => window.__PO.evidence());
  // OPTIONAL: a real drag after the hold, in visual px, step by step - the corner has to stay on the hand whatever the
  // page's zoom, because the gesture now divides the pointer before it writes.
  const dragRows = [];
  if (DRAG) {
    const steps = 6;
    for (let i = 1; i <= steps; i += 1) {
      const y = at.y + (DRAG * i) / steps;
      await page.mouse.move(at.x, y);
      await page.waitForTimeout(35);
      const r = await page.evaluate(() => window.__PO.read());
      if (r) dragRows.push({ ...r, pointerY: +y.toFixed(1), pointerX: at.x });
    }
    await page.waitForTimeout(60);
  }
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => window.__PO.read());
  const chainAfter = await page.evaluate(() => window.__PO.chain());
  return { width, px, at, set, before, chainBefore, prePress, during, chainDuring, evidence, after, chainAfter, dragRows };
}

function summarize(run) {
  const { before, prePress, during, after } = run;
  const firstDuring = during[0] || null;
  const maxJump = during.reduce((m, d) => (before && Math.abs(d.top - before.top) > Math.abs(m)) ? d.top - before.top : m, 0);
  const maxHDelta = during.reduce((m, d) => (before && Math.abs(d.h - before.h) > Math.abs(m)) ? d.h - before.h : m, 0);
  return {
    width: run.width,
    start: run.px,
    beforeH: before.h,
    beforeTop: before.top,
    beforeStored: before.stored,
    beforeVar: before.varH,
    pressH: prePress.h,
    pressTop: prePress.top,
    downH: firstDuring ? firstDuring.h : null,
    downTop: firstDuring ? firstDuring.top : null,
    downDeltaH: firstDuring ? +(firstDuring.h - before.h).toFixed(2) : null,
    downDeltaTop: firstDuring ? +(firstDuring.top - before.top).toFixed(2) : null,
    maxHDelta: +maxHDelta.toFixed(2),
    maxTopDelta: +maxJump.toFixed(2),
    held: firstDuring ? firstDuring.held : null,
    dragH: firstDuring ? firstDuring.dragH : null,
    afterH: after.h,
    afterTop: after.top,
    afterStored: after.stored,
    afterVar: after.varH,
    bodyDelta: firstDuring && before ? +(firstDuring.bodyTop - before.bodyTop).toFixed(2) : null,
    slack: before.slack,
    flex: before.flex,
    heldFlag: firstDuring ? firstDuring.held : null,
    chainBefore: run.chainBefore,
    chainDuring: run.chainDuring,
    chainAfter: run.chainAfter,
    shifts: run.evidence.shifts || [],
    varDuring: firstDuring ? firstDuring.varH : null,
    storedDuring: firstDuring ? firstDuring.stored : null,
    zoom: before.zoom,
    innerH: before.innerH,
    docH: before.docH,
    visH: before.visH,
    // A real drag after the hold, when --drag asked for one: the corner against the hand, step by step, in visual px.
    drag: (() => {
      const rows = run.dragRows || [];
      if (!rows.length) return null;
      const grab = before.gripBottom - run.at.y;
      let worst = 0;
      for (const r of rows) worst = Math.max(worst, Math.abs(r.gripBottom - (r.pointerY + grab)));
      const last = rows[rows.length - 1];
      return {
        travel: +(last.gripBottom - before.gripBottom).toFixed(2),
        pointerTravel: +(last.pointerY - run.at.y).toFixed(2),
        heightDelta: +(last.h - before.h).toFixed(2),
        worstCornerPx: +worst.toFixed(2),
      };
    })(),
    samples: during.map((d) => ({ ms: d.ms, h: d.h, top: d.top, varH: d.varH, stored: d.stored, held: d.held })),
  };
}

async function main() {
  const pw = loadPlaywright({ root: REPO });
  if (!pw) return notRun("the console press-only measurement", "no Playwright install (set PANEL_PLAYWRIGHT_ROOT)");
  let launched = null;
  try {
    launched = await pw.chromium.launch({ headless: true });
  } catch (err) {
    const missingShell = /Executable doesn't exist|headless[_-]shell/i.test(String((err && err.message) || err));
    if (!missingShell) throw err;
    launched = await pw.chromium.launch({ headless: true, channel: "chromium" });
  }
  let version = "";
  try {
    for (const width of WIDTHS) {
      const context = await launched.newContext({ viewport: { width, height: INNER_H } });
      await context.addInitScript((key) => {
        try { localStorage.setItem(key, "1"); } catch { /* private mode: the button opens it */ }
      }, OPEN_KEY);
      const page = await context.newPage();
      const pageErrors = [];
      page.on("pageerror", (e) => pageErrors.push(String((e && e.message) || e).slice(0, 200)));
      try {
        const ready = await loadPanel(page);
        version = version || (await page.evaluate(() => window.__PO.version()));
        // The page's own zoom (Settings > Display, `applyZoom` in public/settings.js): a layout scale written on
        // documentElement, so a client length and a CSS length are not the same number once it is not 100.
        await page.evaluate((pct) => {
          document.documentElement.style.zoom = pct === 100 ? "" : String(pct / 100);
          try { localStorage.setItem("wtgui.zoom", String(pct)); } catch { /* private mode */ }
          if (typeof state !== "undefined") state.zoom = pct;
        }, ZOOM);
        await page.waitForTimeout(250);
        console.log(`\nSHAPE ${width}x${INNER_H}: chat pane ${ready.paneW}px, console ${ready.consoleW}x${ready.consoleH}px, ${ready.turns} open turn(s)`);
        for (const px of HEIGHTS) {
          const run = await pressOnly(page, width, px);
          const s = summarize(run);
          rows.push(s);
          console.log(
            `press-only ${width}/${px}: before ${s.beforeH}px top ${s.beforeTop} -> down ${s.downH}px top ${s.downTop} ` +
              `(dh ${s.downDeltaH}, dtop ${s.downDeltaTop}, worst dtop ${s.maxTopDelta}, worst dh ${s.maxHDelta}) ` +
              `-> after ${s.afterH}px top ${s.afterTop}; stored ${s.beforeStored}->${s.afterStored}; var ${s.beforeVar || "unset"}->${s.afterVar || "unset"}; ` +
              `held ${s.held}; dragH ${s.dragH}; body ${s.bodyDelta}px; slack ${s.slack}; ${s.flex}`,
          );
          console.log(`  writers: calls ${JSON.stringify(run.evidence.calls)}`);
          console.log(`  mutations: ${JSON.stringify(run.evidence.mutations.slice(0, 8))}`);
          console.log(`  body scroll writes: ${JSON.stringify(run.evidence.bodyWrites.slice(0, 6))}`);
          console.log(`  chain before: ${JSON.stringify(s.chainBefore)}`);
          console.log(`  chain during: ${JSON.stringify(s.chainDuring)}`);
          console.log(`  chain after: ${JSON.stringify(s.chainAfter)}`);
          console.log(`  shifts: ${JSON.stringify(s.shifts)}`);
          check(
            Math.abs(s.maxTopDelta ?? 99) <= 1 && Math.abs(s.maxHDelta ?? 99) <= 1,
            `press-only ${width}/${px} moves nothing`,
            `corner moved ${s.maxTopDelta}px up/down and the box ${s.maxHDelta}px while the hand was still`,
          );
          if (s.drag) {
            console.log(`  drag after the hold: pointer ${s.drag.pointerTravel}px -> corner ${s.drag.travel}px, box ${s.drag.heightDelta}px, worst corner ${s.drag.worstCornerPx}px`);
            check(
              Math.abs(s.drag.worstCornerPx) <= 2 && Math.abs(s.drag.heightDelta - s.drag.pointerTravel) <= 2,
              `drag ${width}/${px} follows the hand`,
              `corner off the hand by ${s.drag.worstCornerPx}px, box moved ${s.drag.heightDelta}px for ${s.drag.pointerTravel}px of travel`,
            );
          }
          await page.waitForTimeout(120);
        }
        check(pageErrors.length === 0, `${width}px: the page threw nothing`, pageErrors.slice(0, 3).join(" | "));
      } finally {
        await context.close().catch(() => {});
      }
    }
  } finally {
    await launched.close().catch(() => {});
  }
  const failures = checks.filter((c) => !c.ok).length;
  const payload = { base: BASE, serve: SERVE, version, heights: HEIGHTS, widths: WIDTHS, rows, checks, failures };
  if (JSON_OUT) writeFileSync(path.resolve(JSON_OUT), JSON.stringify(payload, null, 1), "utf8");
  console.log(`\nPANEL ${BASE} v${version || "?"} served from ${SERVE || "the panel"}`);
  console.log(failures ? `RESULT: FAIL ${failures}/${checks.length}` : `RESULT: PASS ${checks.length} checks`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
