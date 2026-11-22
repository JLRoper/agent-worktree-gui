// tools/capture-settings-glossary.mjs - the before/after photograph set for the Settings glossary, from ONE harness.
//
//   node tools/capture-settings-glossary.mjs --tag before --root <a git archive export> --out docs/assets/settings-glossary
//   node tools/capture-settings-glossary.mjs --tag after --out docs/assets/settings-glossary
//
// WHY IT EXISTS. A comparison across two builds is only honest if the fixture, the panel config and the camera are the
// SAME on both sides - so this script takes a `--tag` and serves whatever tree it is pointed at. The old page comes
// from `git archive <base>` in a scratch directory (pass it as --root); the new page from this checkout. Nothing else
// differs between the two runs.
//
// WHAT IT TAKES, for each tab the glossary touches (General, Repo and Board), at 1440x900 and at 768x900:
//   <tag>-<tab>-<width>-top.png      the settings window scrolled to the top of that tab
//   <tag>-<tab>-<width>-bottom.png   the same window scrolled to the bottom
//   <tag>-<tab>-<width>-block.png    the glossary block itself, AFTER only - the before build has no block
//
// The width is the VIEWPORT, and it is the honest difference a reader feels: at 1440 the window is dragged to 640 px,
// at 768 it is the stylesheet's own 340 px window, which is the narrowest a reader ever reads these tabs at. It also
// PRINTS each block's client/scroller widths, its computed size and line height, and the words it holds, so the
// report can cite what the picture shows instead of describing it. It asserts nothing: the gate is
// tools/verify-settings-glossary.mjs.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadPlaywright, notRun } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";
import { buildKindFixture } from "./kind-fixture.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const TAG = opt("--tag", process.env.PANEL_SHOT_TAG || "shot");
const OUT = path.resolve(process.cwd(), opt("--out", process.env.PANEL_SHOTS_DIR || ".shots/settings-glossary"));
const ROOT = opt("--root", null) ? path.resolve(path.resolve(process.cwd(), opt("--root", null))) : null;
const WIDTHS = [
  { w: 1440, h: 900, label: "1440" },
  { w: 768, h: 900, label: "768" },
];
// The tabs whose content moved, and the blocks each one should carry after the change.
const TABS = [
  { key: "general", blocks: ["settings-glossary-index"] },
  { key: "repo", blocks: ["settings-glossary-kinds", "settings-glossary-chips"] },
  { key: "board", blocks: ["settings-glossary-board-chip"] },
];
const RECT_KEY = "wtgui.settingsRect";
const TAB_KEY = "wtgui.settingsTab";

mkdirSync(OUT, { recursive: true });

const pw = loadPlaywright();
if (!pw) {
  console.log(notRun("the Settings glossary was not photographed.", "no Playwright install found"));
  console.log("  re-run with PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/capture-settings-glossary.mjs");
  process.exit(2);
}

const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-glossary-shots-"));
const fx = buildKindFixture(dir);
const panel = await startPanel({
  root: ROOT || undefined,
  dir,
  config: {
    branchParentsFile: fx.bookFile,
    sameRepoScan: true,
    scanMode: "all",
    defaultCwd: fx.repo,
    worktreeSeconds: 60,
    midSeconds: 60,
    dormantSeconds: 60,
    slowSeconds: 60,
    fetchSeconds: 3600,
    threads: 1,
    apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
    assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
  },
});
console.log(`panel on ${panel.base} (${TAG}${ROOT ? `, root ${ROOT}` : ""})`);

let browser = null;
let shots = 0;
const shoot = async (page, file) => {
  shots += 1;
  await page.locator("#settings").screenshot({ path: file });
  console.log(`shot ${file}`);
};

try {
  browser = await pw.chromium.launch({ headless: true }).catch(async (err) => {
    if (!/Executable doesn't exist|headless[_-]shell/i.test(String((err && err.message) || err))) throw err;
    return pw.chromium.launch({ headless: true, channel: "chromium" });
  });
  for (const { w, h, label } of WIDTHS) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    // The window a reader reads these tabs in: dragged wide at 1440, the stylesheet's own 340 px at 768 (no stored
    // rect - which is exactly the tightest honest frame).
    await page.addInitScript(
      ({ rectKey, tabKey, tab, wide }) => {
        try {
          if (wide) localStorage.setItem(rectKey, JSON.stringify({ x: 12, y: 12, w: 640, h: 876 }));
          else localStorage.removeItem(rectKey);
          localStorage.setItem(tabKey, tab);
        } catch {
          /* a browser that refuses storage is not a reason to stop */
        }
      },
      { rectKey: RECT_KEY, tabKey: TAB_KEY, tab: "general", wide: w > 1000 },
    );
    await page.goto(panel.base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("section.project[data-project]", { timeout: 60_000 }).catch(() => null);
    await page.waitForSelector("#btn-settings", { timeout: 30_000 });
    await page.click("#btn-settings");
    await page.waitForSelector("#settings:not(.hidden)", { timeout: 10_000 });
    for (const { key, blocks } of TABS) {
      // The tab, through the reader's own strip.
      const tab = `[data-settings-tab="${key}"]`;
      if ((await page.evaluate((s) => document.querySelector(s)?.getAttribute("aria-selected") === "true", tab)) !== true) {
        await page.click(tab);
      }
      await page.waitForSelector(`[data-settings-group="${key}"]:not([hidden])`, { timeout: 10_000 });
      const body = page.locator("#settings .settings-body");
      await body.evaluate((el) => void (el.scrollTop = 0));
      await page.waitForTimeout(120);
      await shoot(page, path.join(OUT, `${TAG}-${key}-${label}-top.png`));
      await body.evaluate((el) => void (el.scrollTop = el.scrollHeight));
      await page.waitForTimeout(120);
      await shoot(page, path.join(OUT, `${TAG}-${key}-${label}-bottom.png`));
      for (const block of blocks) {
        const found = page.locator(`#${block}`);
        if ((await found.count()) === 0) {
          console.log(`      ${block} at ${label}: absent in this build (the before frame)`);
          continue;
        }
        await body.evaluate((el) => void (el.scrollTop = 0));
        // The block in its own window, not as a bare element: a block taller than the window would otherwise be
        // photographed past the panel's own clip, with the board showing through underneath.
        await found.evaluate((el) => {
          const scroller = el.closest(".settings-body");
          if (!scroller) return;
          const delta = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
          scroller.scrollTop += delta - 4;
        });
        await page.waitForTimeout(100);
        await shoot(page, path.join(OUT, `${TAG}-${key}-${label}-${block.replace("settings-glossary-", "")}.png`));
        const said = await page.evaluate((id) => {
          const el = document.getElementById(id);
          if (!el) return null;
          const cs = getComputedStyle(el);
          const rect = el.getBoundingClientRect();
          return {
            client: Math.round(el.clientWidth),
            scroll: Math.round(el.scrollWidth),
            width: Math.round(rect.width),
            font: cs.fontSize,
            lineHeight: cs.lineHeight,
            words: (el.textContent || "").replace(/\s+/g, " ").trim().length,
          };
        }, block);
        console.log(
          `      ${block} at ${label}: width=${said?.width} client=${said?.client} scroll=${said?.scroll} font=${said?.font} line=${said?.lineHeight} chars=${said?.words}`,
        );
      }
    }
    await page.close();
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  await panel.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}
console.log(`${shots} frames under ${OUT}`);
