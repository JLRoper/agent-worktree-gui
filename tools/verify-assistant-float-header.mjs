// HARNESS: LIVE GATE
// The assistant float's title row: `as-name` and its mode chip are FULLY VISIBLE in both frames, at every width and
// at the reader's zoom — never clipped by the float's own edge and never under the tab row.
//
//   node tools/verify-assistant-float-header.mjs
//   node tools/verify-assistant-float-header.mjs --shots <dir>
//
// THE DEFECT. `public/assistant.js` drew a watch deadline's draining bar as `<span class="as-bar">`, and
// `public/style.css` gave `.as-bar` its box late in the file (`width: 78px; height: 4px; overflow: hidden`). The
// assistant's TITLE ROW is also `.as-bar` — so the later rule became the header's own box: 78 px wide, 15 px tall
// (4 + the two 7 px paddings + the 1 px border), 478 px of content inside it. `#assistant { overflow: hidden }` then
// cut the name and the mode chip off at the float's top edge: the name's box started at y = 79.2 while the float
// began at y = 90, and its 18.85 px line was wrapped to two by a 57 px box. Measured on the base at 480×600, zoom
// 100%: bar 78×15, `scrollHeight` 33 against a 14 px client, name 57.3 px wide over two lines. That is the reader's
// screenshot.
//
// THE FIX this gate pins: the deadline bar is `.as-watchbar`, scoped under `.as-watch-timer`; the title row is
// scoped as `#assistant > .as-bar` so no other `.as-bar` can hand it a box again; the name and the mode chip keep one
// line each (`nowrap` + `ellipsis` on the name, whose `title` carries the rest) and the row WRAPS rather than
// squeezing them, so a narrow float moves the chips down and never cuts the header.
//
// WHAT IS MEASURED, per case: the name and the mode chip sit fully inside the title row and fully inside the float;
// each is one line; the title row spans the float; its `scrollHeight` does not exceed its client box; the tab row
// starts at or below the row's bottom edge; the pane still has room (so the header cannot eat the float). The
// deadline bar is measured on its own: 78×4 inside its row, and exactly ONE `.as-bar` on the page — the title row.
//
// CASES: the float at 380×520, 480×600 and 640×760, each at zoom 100/110/125/150 (the panel's own page zoom, which
// is what makes the reader's header narrower in layout px), and the docked rail at 340 and 480 px at zoom 100/125.
// A deliberately long name is then renamed onto the record at 380×520 @ 125% to prove it ellipsizes inside the row
// instead of spilling or wrapping.
//
// EXIT CODES: 0 every case held; 1 a case failed; 2 the run did not measure what it claims (no Playwright, the float
// never opened, the watch never painted).
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright } from "./browser.mjs";
import { ROOT, freePort, startPanel } from "./panel-testkit.mjs";

const args = process.argv.slice(2);
const shotsArg = args.includes("--shots") ? args[args.indexOf("--shots") + 1] : null;
const SHOTS = shotsArg ? path.resolve(shotsArg) : path.join(ROOT, ".worktrees", ".assistant-float-header-shots");
mkdirSync(SHOTS, { recursive: true });

let checks = 0;
let failures = 0;
const check = (ok, label, detail = "") => {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
};
const note = (t) => console.log(`      ${t}`);

let playwright = null;
try {
  playwright = loadPlaywright();
} catch {
  playwright = null;
}
if (!playwright) {
  console.log("BROWSER-HALF-NOT-RUN: no Playwright install found (set PANEL_PLAYWRIGHT_ROOT)");
  process.exit(2);
}

const dir = mkdtempSync(path.join(tmpdir(), "wtgui-float-header-"));
const panel = await startPanel({
  dir,
  port: await freePort(),
  config: {
    refreshSeconds: 3600,
    worktreeSeconds: 3600,
    midSeconds: 3600,
    dormantSeconds: 3600,
    slowSeconds: 3600,
    fetchSeconds: -1,
    discoverSeconds: 3600,
    assistant: { enabled: false },
    apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
  },
});

const post = async (route, body) => {
  const r = await fetch(`${panel.base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${route} -> ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
};

const measure = (page) =>
  page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const R = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { l: +r.left.toFixed(1), t: +r.top.toFixed(1), r: +r.right.toFixed(1), b: +r.bottom.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
    };
    const el = q("#assistant");
    const bar = q("#assistant > .as-bar");
    const name = q("#as-name");
    const mode = q("#as-mode");
    const tabs = q(".as-tabs");
    const body = q(".as-body");
    const watch = q(".as-watch-timer .as-watchbar");
    const css = (node, p) => (node ? getComputedStyle(node)[p] : null);
    return {
      floating: Boolean(el?.classList.contains("is-floating")),
      float: R(el),
      bar: R(bar),
      name: R(name),
      mode: R(mode),
      glyph: R(q("#assistant > .as-bar .as-glyph")),
      chips: R(q("#as-chips")),
      close: R(q("#btn-as-close")),
      tabs: R(tabs),
      subtabs: R(q(".as-subtabs")),
      body: R(body),
      watchbar: R(watch),
      nameText: name?.textContent ?? null,
      nameTitle: name?.title ?? null,
      nameLines: name?.getClientRects().length ?? null,
      nameSW: name?.scrollWidth ?? null,
      nameCW: name?.clientWidth ?? null,
      nameWhiteSpace: css(name, "whiteSpace"),
      nameOverflow: css(name, "overflow"),
      barWrap: css(bar, "flexWrap"),
      barScrollH: bar?.scrollHeight ?? null,
      barClientH: bar?.clientHeight ?? null,
      barRuleW: css(bar, "width"),
      modeText: mode?.textContent ?? null,
      modeLines: mode?.getClientRects().length ?? null,
      modeWhiteSpace: css(mode, "whiteSpace"),
      asBarCount: document.querySelectorAll(".as-bar").length,
      titleRowHasName: Boolean(bar && name && bar.contains(name)),
      titleRowHasMode: Boolean(bar && mode && bar.contains(mode)),
      zoom: getComputedStyle(document.documentElement).zoom,
    };
  });

const EPS = 1.5;
const inside = (inner, outer, eps = EPS) =>
  Boolean(inner && outer) && inner.t >= outer.t - eps && inner.b <= outer.b + eps && inner.l >= outer.l - eps && inner.r <= outer.r + eps;

const cases = [];
for (const [w, h] of [[380, 520], [480, 600], [640, 760]]) for (const z of [100, 110, 125, 150]) cases.push({ frame: "float", w, h, z });
for (const w of [340, 480]) for (const z of [100, 125]) cases.push({ frame: "docked", w, z });

try {
  await post("/api/settings/general", { dockMode: "floating" });
  await post("/api/assistant/watch", { thread: "panel-assistant", title: "the deadline bar keeps its own box", minutes: 30, assistantId: "assistant-1" });

  const { chromium } = playwright;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    const boot = async ({ w, h, z, frame }) => {
      if (page.url() === "about:blank") await page.goto(panel.base, { waitUntil: "domcontentloaded" });
      await page.evaluate(
        ([rect, zoom, dockW]) => {
          localStorage.setItem("wm.assistantFloat", JSON.stringify(rect));
          localStorage.setItem("wtgui.zoom", String(zoom));
          localStorage.setItem("wm.assistantWidth", String(dockW));
        },
        [{ x: 900, y: 90, w, h }, z, frame === "docked" ? w : 480],
      );
      await post("/api/settings/general", { dockMode: frame === "docked" ? "docked" : "floating" });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("#btn-assistant", { timeout: 20_000 });
      await page.waitForTimeout(600);
      if (!(await page.locator("#assistant").isVisible().catch(() => false))) {
        await page.click("#btn-assistant");
        await page.waitForSelector("#assistant:not([hidden])", { timeout: 15_000 });
      }
      await page.waitForTimeout(400);
    };

    for (const c of cases) {
      const tag = c.frame === "float" ? `float ${c.w}x${c.h} @ ${c.z}%` : `rail ${c.w} @ ${c.z}%`;
      await boot(c);
      const f = await measure(page);
      if (!f.float || !f.bar || !f.name || !f.mode) {
        check(false, `${tag}: the header is on the page`, JSON.stringify({ float: f.float, bar: f.bar, name: f.name, mode: f.mode }));
        continue;
      }
      // The regression's own signature: the title row was 78 px wide inside a 478 px float.
      check(f.bar.w >= f.float.w - 4, `${tag}: the title row spans the float`, `row ${f.bar.w}px in a ${f.float.w}px float (${f.barRuleW})`);
      check(inside(f.name, f.bar), `${tag}: as-name sits inside the title row`, `name ${f.name.t}-${f.name.b} · row ${f.bar.t}-${f.bar.b}`);
      check(inside(f.mode, f.bar), `${tag}: the mode chip sits inside the title row`, `mode ${f.mode.t}-${f.mode.b} · row ${f.bar.t}-${f.bar.b}`);
      check(inside(f.name, f.float) && inside(f.mode, f.float), `${tag}: neither the name nor the chip is cut by the float's edge`, `float starts at y ${f.float.t}`);
      check(f.nameLines === 1, `${tag}: as-name is one line`, `${f.nameLines} line box(es), box ${f.name.w}×${f.name.h}`);
      check(f.modeLines === 1, `${tag}: the mode chip is one line`, `${f.modeLines} line box(es), ${JSON.stringify(f.modeText)}`);
      check(Number(f.barScrollH) <= Number(f.barClientH) + 1, `${tag}: the title row's content fits its own box (nothing clipped)`, `scrollHeight ${f.barScrollH} · client ${f.barClientH}`);
      check(f.bar.b <= f.tabs.t + 1, `${tag}: the title row and the tab row do not overlap`, `row bottom ${f.bar.b} · tabs top ${f.tabs.t}`);
      check(f.name.r <= f.mode.l + 1, `${tag}: the name is not under the mode chip`, `name right ${f.name.r} · chip left ${f.mode.l}`);
      check(f.tabs.b <= f.float.b + 1, `${tag}: the tab row is inside the float`, `tabs bottom ${f.tabs.b} · float bottom ${f.float.b}`);
      check(f.body && f.body.h >= 40, `${tag}: the pane still has room below the header`, f.body ? `body ${f.body.h}px tall` : "no .as-body");
      await page.screenshot({ path: path.join(SHOTS, `${c.frame}-${c.w}x${c.h || ""}-z${c.z}.png`), clip: { x: Math.max(0, f.float.l - 10), y: Math.max(0, f.float.t - 10), width: Math.min(1600, f.float.w + 20), height: Math.min(1000, Math.min(320, f.float.h + 20)) } });
    }

    // ---- exactly one .as-bar, and it is the title row ---------------------------------------------------------
    await boot({ frame: "float", w: 480, h: 600, z: 100 });
    await page.click('[data-as-subtab="watches"]');
    await page.waitForTimeout(600);
    const w = await measure(page);
    check(w.asBarCount === 1, "exactly one .as-bar on the page (the title row, not the deadline bar)", `${w.asBarCount} found`);
    check(w.titleRowHasName && w.titleRowHasMode, "the one .as-bar is the title row that carries as-name and the chip", `name ${w.titleRowHasName} · chip ${w.titleRowHasMode}`);
    check(w.watchbar && w.watchbar.w > 0 && w.watchbar.h > 0, "the watch deadline's own bar is still painted", w.watchbar ? `${w.watchbar.w}×${w.watchbar.h}` : "absent");
    check(w.watchbar && w.watchbar.h <= 8 && w.watchbar.w <= 90, "the deadline bar keeps its 78×4 box (its rule did not follow the rename)", w.watchbar ? `${w.watchbar.w}×${w.watchbar.h}` : "absent");
    check(w.bar.w >= w.float.w - 4, "the title row is still full width with a watch on the pane", `row ${w.bar.w} · float ${w.float.w}`);
    await page.screenshot({ path: path.join(SHOTS, "watches-pane-480-z100.png"), clip: { x: Math.max(0, w.float.l - 10), y: Math.max(0, w.float.t - 10), width: Math.min(1600, w.float.w + 20), height: 360 } });

    // ---- a long name ellipsizes in the row, and does not spill or wrap ---------------------------------------
    const LONG = "a deliberately long assistant name for the header row";
    const saved = await post("/api/assistant/settings", { assistantId: "assistant-1", name: LONG });
    const storedName = saved?.renamed?.target?.name || LONG;
    // 380 px at the reader's 150 % zoom: 253 layout px for the whole row, so a 40-character name cannot fit.
    await boot({ frame: "float", w: 380, h: 520, z: 150 });
    const n = await measure(page);
    check(n.nameText === storedName, "the long name is on the record and in the header", JSON.stringify(n.nameText));
    check(n.nameLines === 1, "a long name stays on one line", `${n.nameLines} line box(es)`);
    check(inside(n.name, n.bar) && inside(n.name, n.float), "a long name is contained by the row and the float", `name ${n.name.l}-${n.name.r} in row ${n.bar.l}-${n.bar.r}`);
    check(n.nameSW > n.nameCW, "a long name ellipsizes instead of shrinking the row", `scrollWidth ${n.nameSW} · client ${n.nameCW}`);
    check(String(n.nameTitle || "").startsWith(storedName), "the whole name is readable from the name's title", JSON.stringify(n.nameTitle));
    check(n.bar.b <= n.tabs.t + 1 && n.modeLines === 1 && inside(n.mode, n.bar), "the chip stays visible beside a long name", `row bottom ${n.bar.b} · tabs top ${n.tabs.t}`);
    await page.screenshot({ path: path.join(SHOTS, "long-name-380-z150.png"), clip: { x: Math.max(0, n.float.l - 10), y: Math.max(0, n.float.t - 10), width: Math.min(1600, n.float.w + 20), height: 320 } });
  } finally {
    await browser.close();
  }
} finally {
  await panel.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

console.log(`\n${checks} checks, ${failures} failed  ·  shots: ${SHOTS}`);
process.exitCode = failures ? 1 : 0;
