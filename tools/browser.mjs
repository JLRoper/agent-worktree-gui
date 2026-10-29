// One Playwright bootstrap for every browser harness in this repo.
//
// WHY. tools/ carries 27 verify-*.mjs scripts and each one resolved playwright, launched Chromium, opened a
// context and closed it again in its own words — the same ~30 lines, 27 times, with the same three bugs in the
// copies: a harness that could not find playwright printed its own BROWSER-HALF-NOT-RUN paragraph instead of
// sharing the sentence; one that threw between launch() and close() leaked a Chromium process; and the "where is
// playwright" question was answered differently by each file (PANEL_PLAYWRIGHT_ROOT, PLAYWRIGHT_ROOT, the repo,
// the cwd, or the Windows global npm prefix). This module is that paragraph, once.
//
// A harness still decides WHAT to assert and what to print. It just stops re-implementing the bootstrap:
//
//   import { withBrowser, openPage } from "./browser.mjs";
//   const verdict = await withBrowser(async ({ page }) => {
//     await openPage(page, base, { selector: "section.project" });
//     ...
//     return failures;
//   }, { viewport: { width: 1760, height: 1000 }, deviceScaleFactor: 2 });
//
// withBrowser always closes the browser, including when the callback throws, and hands back the callback's value.
import { createRequire } from "node:module";
import path from "node:path";
import { ROOT } from "./panel-testkit.mjs";

export const REPO = ROOT;

// Where playwright may live, in the order the harnesses already agreed on: an explicit root, the repo, the cwd,
// and the Windows global install (`npm -g`) — this repo has no node_modules, so the global is the common case.
export function playwrightCandidates({ root = ROOT, cwd = process.cwd(), env = process.env } = {}) {
  const out = [];
  for (const candidate of [env.PANEL_PLAYWRIGHT_ROOT, env.PLAYWRIGHT_ROOT, root, cwd]) {
    if (candidate) out.push(path.resolve(candidate));
  }
  const appData = env.APPDATA || (env.HOME ? path.join(env.HOME, "AppData", "Roaming") : "");
  if (appData) out.push(path.join(appData, "npm", "node_modules"));
  return [...new Set(out)];
}

// The module, or null when nothing on this machine carries one — a harness prints BROWSER-HALF-NOT-RUN and exits
// 2 rather than passing a half that never ran, so "absent" has to be a value, not a throw.
export function loadPlaywright({ root, cwd, env, allowGlobalFallback = true } = {}) {
  const options = { root, cwd, env };
  const require_ = createRequire(path.join(path.resolve(root || ROOT), "noop.cjs"));
  for (const dir of playwrightCandidates(options)) {
    for (const candidate of [path.join(dir, "node_modules", "playwright"), dir]) {
      try {
        return require_(candidate);
      } catch {
        /* not there */
      }
    }
  }
  // The last resort is a bare require, which Node may satisfy from its own global prefix even when every candidate
  // above missed. `allowGlobalFallback: false` is how a test proves the not-installed answer on a machine that has one.
  if (!allowGlobalFallback) return null;
  try {
    return require_("playwright");
  } catch {
    return null;
  }
}

// The same lookup, but a missing install is an error with the fix in it (a harness whose browser half is the whole
// point can use this instead of null-checking).
export function requirePlaywright({ root, cwd, env } = {}) {
  const playwright = loadPlaywright({ root, cwd, env });
  if (playwright) return playwright;
  const looked = playwrightCandidates({ root, cwd, env }).join(", ");
  throw new Error(`no Playwright install found — set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright (looked in ${looked})`);
}

// Run `fn` with a browser, a context and a page; close the browser whatever fn does.
//
// `initScript` is seeded before the first navigation (the harnesses that need the reader's own fold state use it,
// because a fresh context has no remembered layout). Extra launch/context options pass through.
export async function withBrowser(fn, options = {}) {
  const {
    playwright = null,
    headless = true,
    args = [],
    viewport = { width: 1440, height: 900 },
    deviceScaleFactor = 1,
    initScript = null,
    initScripts = [],
    contextOptions = {},
    launchOptions = {},
  } = options;
  const engine = playwright || requirePlaywright(options);
  const browser = await engine.chromium.launch({ headless, args, ...launchOptions });
  try {
    const context = await browser.newContext({ viewport, deviceScaleFactor, ...contextOptions });
    for (const script of [...(initScript ? [initScript] : []), ...initScripts]) await context.addInitScript(script);
    const page = await context.newPage();
    return await fn({ browser, context, page, playwright: engine });
  } finally {
    await browser.close().catch(() => {});
  }
}

// A harness's first three lines, once: go to the panel, wait for the thing that proves the page rendered.
export async function openPage(page, base, { pathname = "/", waitUntil = "domcontentloaded", selector = null, timeout = 30_000 } = {}) {
  await page.goto(String(base).replace(/\/$/, "") + pathname, { waitUntil, timeout });
  if (selector) await page.waitForSelector(selector, { timeout });
  return page;
}

// The sentence every harness prints when the browser half could not run. One wording, so a reader greps once.
export function notRun(what, why) {
  return `BROWSER-HALF-NOT-RUN  ${what} — ${why}`;
}
