// The 480 bottom view (the note below the lanes) and the 239/347/479 ledgers with the throwaway's folded route row.
import { mkdirSync, writeFileSync } from "node:fs";
import { withBrowser, openPage } from "file:///C:/ProjectDevelopment/agent-worktree-gui/.worktrees/research-round-b-for-the-initiatives-tab-1d1d2c/tools/browser.mjs";

const BASE = process.env.BASE || "http://127.0.0.1:7332";
const OUT = process.env.OUT || "C:/Users/roper/AppData/Local/Temp/wag/73596cb0/shots";
const TAG = process.env.TAG || "after";
mkdirSync(OUT, { recursive: true });

const verdict = await withBrowser(
  async ({ page }) => {
    await openPage(page, BASE, { selector: "#btn-assistant", timeout: 30_000 });
    if (await page.evaluate(() => document.getElementById("assistant")?.hidden === true)) await page.click("#btn-assistant");
    await page.waitForSelector("#assistant:not([hidden])", { timeout: 20_000 });
    const tab = '#as-tabs [data-as-tab="initiatives"]';
    await page.waitForSelector(tab, { timeout: 20_000 });
    if (!(await page.evaluate((s) => document.querySelector(s)?.getAttribute("aria-selected") === "true", tab))) await page.click(tab);
    await page.waitForSelector("#as-initiatives:not(.hidden) .init-card", { timeout: 30_000 });
    await page.waitForTimeout(600);

    // ledger at the three widths
    for (const [name, width] of [["1440", 1440], ["768", 768], ["480", 480]]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(400);
      await page.evaluate(() => {
        document.querySelector("#as-initiatives").scrollTop = 0;
      });
      await page.waitForTimeout(250);
      await page.locator("#as-initiatives").screenshot({ path: `${OUT}/${TAG}-${name}-ledger.png` });
    }

    // the open card, 480, scrolled to the closing note
    await page.setViewportSize({ width: 480, height: 1200 });
    await page.waitForTimeout(400);
    const head = page.locator("#as-initiatives .init-card", { hasText: "Sketch proof" }).locator(".init-head-btn").first();
    await head.scrollIntoViewIfNeeded();
    if (await page.evaluate(() => !document.querySelector("#as-initiatives .init-card:not(.is-titlecard) .init-wavefold"))) await head.click();
    await page.waitForSelector("#as-initiatives .wave-join", { timeout: 20_000 });
    await page.evaluate(() => {
      const pane = document.querySelector("#as-initiatives");
      const join = document.querySelector("#as-initiatives .wave-join");
      pane.scrollTop += join.getBoundingClientRect().bottom - pane.getBoundingClientRect().bottom + 40;
    });
    await page.waitForTimeout(300);
    await page.locator("#as-initiatives").screenshot({ path: `${OUT}/${TAG}-480-waves-note.png` });

    // the throwaway's folded route row, and the same row at 480
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);
    if (await page.evaluate(() => !document.querySelector("#as-initiatives .init-card:not(.is-titlecard)"))) await head.click();
    await head.click();
    await page.waitForTimeout(400);
    const row = page.locator("#as-initiatives .init-card.is-titlecard", { hasText: "Sketch proof" }).first();
    await row.scrollIntoViewIfNeeded();
    await page.locator("#as-initiatives").screenshot({ path: `${OUT}/${TAG}-route-row-pane.png` });
    await row.screenshot({ path: `${OUT}/${TAG}-route-row.png` });
    await page.setViewportSize({ width: 480, height: 900 });
    await page.waitForTimeout(400);
    await row.scrollIntoViewIfNeeded();
    await row.screenshot({ path: `${OUT}/${TAG}-route-row-480.png` });
    const facts = await page.evaluate(() => {
      const card = [...document.querySelectorAll("#as-initiatives .init-card")].find((c) => /Sketch proof/i.test(c.querySelector(".init-title")?.textContent || ""));
      const pick = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
      return {
        cls: card.className,
        dots: card.querySelectorAll(".init-glyph i").length,
        tones: [...card.querySelectorAll(".init-glyph i")].map((d) => d.className),
        status: pick(card.querySelector(".init-status")),
        desc: pick(card.querySelector(".init-desc")),
        chips: [...card.querySelectorAll(".init-chips .chip, .init-chips .init-meta")].map(pick),
      };
    });
    return facts;
  },
  { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
);

writeFileSync(`${OUT}/${TAG}-row.json`, JSON.stringify(verdict, null, 1));
console.log(JSON.stringify(verdict, null, 1));
