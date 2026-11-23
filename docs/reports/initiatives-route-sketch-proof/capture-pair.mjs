// The before/after pair, taken on the same panel and the same seeded data with only the product files switched.
// TAG=b (with the change stashed) and TAG=a (with it back) write the same six pictures.
import { mkdirSync, writeFileSync } from "node:fs";
import { withBrowser, openPage } from "file:///C:/ProjectDevelopment/agent-worktree-gui/.worktrees/research-round-b-for-the-initiatives-tab-1d1d2c/tools/browser.mjs";

const BASE = process.env.BASE || "http://127.0.0.1:7332";
const OUT = process.env.OUT || "C:/Users/roper/AppData/Local/Temp/wag/73596cb0/shots";
const TAG = process.env.TAG || "a";
mkdirSync(OUT, { recursive: true });

const settle = async (page) => {
  await openPage(page, BASE, { selector: "#btn-assistant", timeout: 30_000 });
  if (await page.evaluate(() => document.getElementById("assistant")?.hidden === true)) await page.click("#btn-assistant");
  await page.waitForSelector("#assistant:not([hidden])", { timeout: 20_000 });
  const tab = '#as-tabs [data-as-tab="initiatives"]';
  await page.waitForSelector(tab, { timeout: 20_000 });
  if (!(await page.evaluate((s) => document.querySelector(s)?.getAttribute("aria-selected") === "true", tab))) await page.click(tab);
  await page.waitForSelector("#as-initiatives:not(.hidden) .init-card", { timeout: 30_000 });
  const head = page.locator("#as-initiatives .init-card", { hasText: "Sketch proof" }).locator(".init-head-btn").first();
  await head.scrollIntoViewIfNeeded();
  if (await page.evaluate(() => !document.querySelector("#as-initiatives .init-card:not(.is-titlecard) .init-wavefold"))) await head.click();
  await page.waitForSelector("#as-initiatives .init-card:not(.is-titlecard) .init-wavefold", { timeout: 20_000 });
  await page.waitForTimeout(700);
};

const facts = () =>
  (() => {
    const b = (el) => (el ? { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height), x: Math.round(el.getBoundingClientRect().x), y: Math.round(el.getBoundingClientRect().y) } : null);
    const join = document.querySelector("#as-initiatives .wave-join");
    const close = document.querySelector("#as-initiatives .wave-close");
    const lanes = [...document.querySelectorAll("#as-initiatives .wave-lane")].map(b);
    return {
      pane: b(document.querySelector("#as-initiatives")),
      join: join ? { text: join.textContent, b: b(join), bg: getComputedStyle(join).backgroundColor, border: getComputedStyle(join).borderLeftColor } : null,
      close: close ? { b: b(close), dir: getComputedStyle(close).flexDirection } : null,
      lanes,
      head: b(document.querySelector("#as-initiatives .wave-row .wave-head")),
      state: b(document.querySelector("#as-initiatives .wave-row .wave-state")),
    };
  })();

const verdict = await withBrowser(
  async ({ page }) => {
    await settle(page);
    await fetch(`${BASE}/api/settings/general`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dockMode: "floating" }), signal: AbortSignal.timeout(8000) });
    await page.evaluate(() => {
      localStorage.setItem("wm.assistantOpen", "1");
      localStorage.setItem("wm.assistantFloat", JSON.stringify({ x: 8, y: 80, w: 1384, h: 860 }));
    });
    await settle(page);
    const hw = await page.evaluate(() => Math.ceil(document.querySelector("#as-initiatives .init-card:not(.is-titlecard) .init-wavefold").getBoundingClientRect().height));
    await page.setViewportSize({ width: 1440, height: Math.min(hw + 300, 1400) });
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      const pane = document.querySelector("#as-initiatives");
      const el = document.querySelector("#as-initiatives .init-card:not(.is-titlecard) .init-wavefold");
      pane.scrollTop += el.getBoundingClientRect().top - pane.getBoundingClientRect().top - 30;
    });
    await page.waitForTimeout(300);
    await page.locator("#as-initiatives").screenshot({ path: `${OUT}/wide-${TAG}.png` });
    const wide = await page.evaluate(facts);

    // docked, 1440 window
    await fetch(`${BASE}/api/settings/general`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dockMode: "docked" }), signal: AbortSignal.timeout(8000) });
    await page.setViewportSize({ width: 1440, height: 1200 });
    await page.evaluate(() => localStorage.removeItem("wm.assistantFloat"));
    await settle(page);
    const hd = await page.evaluate(() => Math.ceil(document.querySelector("#as-initiatives .init-card:not(.is-titlecard) .init-wavefold").getBoundingClientRect().height));
    await page.setViewportSize({ width: 1440, height: Math.min(hd + 300, 1600) });
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      const pane = document.querySelector("#as-initiatives");
      const el = document.querySelector("#as-initiatives .init-card:not(.is-titlecard) .init-wavefold");
      pane.scrollTop += el.getBoundingClientRect().top - pane.getBoundingClientRect().top - 20;
    });
    await page.waitForTimeout(300);
    await page.locator("#as-initiatives").screenshot({ path: `${OUT}/docked-${TAG}.png` });
    const docked = await page.evaluate(facts);
    await page.setViewportSize({ width: 1440, height: 900 });
    return { wide, docked };
  },
  { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
);

writeFileSync(`${OUT}/pair-${TAG}.json`, JSON.stringify(verdict, null, 1));
console.log(JSON.stringify(verdict, null, 1));
