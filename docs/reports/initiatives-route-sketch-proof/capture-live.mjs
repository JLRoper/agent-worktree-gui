// The measured cause, on the reader's own panel: read-only. Seven initiatives, zero waves.
import { mkdirSync, writeFileSync } from "node:fs";
import { withBrowser, openPage } from "file:///C:/ProjectDevelopment/agent-worktree-gui/.worktrees/research-round-b-for-the-initiatives-tab-1d1d2c/tools/browser.mjs";

const BASE = process.env.BASE || "http://127.0.0.1:7331";
const OUT = process.env.OUT || "C:/Users/roper/AppData/Local/Temp/wag/73596cb0/shots";
mkdirSync(OUT, { recursive: true });

const read = () =>
  (() => {
    const pick = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
    const cards = [...document.querySelectorAll("#as-initiatives .init-card")];
    return cards.map((c) => ({
      title: pick(c.querySelector(".init-title")),
      folded: c.classList.contains("is-titlecard"),
      hasRoute: c.classList.contains("has-route"),
      dots: c.querySelectorAll(".init-glyph i").length,
      status: pick(c.querySelector(".init-status")),
      statusClass: c.querySelector(".init-status")?.className || null,
      waveRows: c.querySelectorAll(".wave-row").length,
      laneBlocks: c.querySelectorAll(".wave-lanes").length,
      wavefold: Boolean(c.querySelector(".init-wavefold")),
      chips: [...c.querySelectorAll(".init-chips .chip, .init-chips .init-meta")].map(pick),
    }));
  })();

const verdict = await withBrowser(
  async ({ page }) => {
    await openPage(page, BASE, { selector: "#btn-assistant", timeout: 30_000 });
    if (await page.evaluate(() => document.getElementById("assistant")?.hidden === true)) await page.click("#btn-assistant");
    await page.waitForSelector("#assistant:not([hidden])", { timeout: 20_000 });
    const tab = '#as-tabs [data-as-tab="initiatives"]';
    await page.waitForSelector(tab, { timeout: 20_000 });
    if (!(await page.evaluate((s) => document.querySelector(s)?.getAttribute("aria-selected") === "true", tab))) await page.click(tab);
    await page.waitForSelector("#as-initiatives:not(.hidden) .init-card", { timeout: 40_000 });
    await page.waitForTimeout(1200);
    const shot = `${OUT}/live-1440-ledger.png`;
    await page.locator("#as-initiatives").screenshot({ path: shot });
    const facts = await page.evaluate(read);
    const head = pick2(await page.textContent("#as-initiatives .as-actions, #as-initiatives"));
    return { shot, facts };
    function pick2(v) {
      return String(v || "").replace(/\s+/g, " ").slice(0, 120);
    }
  },
  { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
);

writeFileSync(`${OUT}/live-facts.json`, JSON.stringify(verdict, null, 1));
console.log(JSON.stringify({ shot: verdict.shot, cards: verdict.facts.length, facts: verdict.facts.map((f) => [f.title, f.folded, f.hasRoute, f.dots, f.status, f.waveRows, f.laneBlocks]) }, null, 1));
