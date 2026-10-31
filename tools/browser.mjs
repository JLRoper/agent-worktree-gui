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

let cachedDefaultPlaywright;

export function clearPlaywrightCache() {
  cachedDefaultPlaywright = undefined;
}

// The module, or null when nothing on this machine carries one — a harness prints BROWSER-HALF-NOT-RUN and exits
// 2 rather than passing a half that never ran, so "absent" has to be a value, not a throw.
export function loadPlaywright({ root, cwd, env, allowGlobalFallback = true } = {}) {
  const isDefault = root === undefined && cwd === undefined && env === undefined && allowGlobalFallback === true;
  if (isDefault && cachedDefaultPlaywright !== undefined) return cachedDefaultPlaywright;
  const options = { root, cwd, env };
  const require_ = createRequire(path.join(path.resolve(root || ROOT), "noop.cjs"));
  for (const dir of playwrightCandidates(options)) {
    for (const candidate of [path.join(dir, "node_modules", "playwright"), dir]) {
      try {
        const mod = require_(candidate);
        if (isDefault) cachedDefaultPlaywright = mod;
        return mod;
      } catch {
        /* not there */
      }
    }
  }
  // The last resort is a bare require, which Node may satisfy from its own global prefix even when every candidate
  // above missed. `allowGlobalFallback: false` is how a test proves the not-installed answer on a machine that has one.
  if (!allowGlobalFallback) return null;
  try {
    const mod = require_("playwright");
    if (isDefault) cachedDefaultPlaywright = mod;
    return mod;
  } catch {
    if (isDefault) cachedDefaultPlaywright = null;
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

// Apply init scripts to a BrowserContext. Each entry may be a function/string, `[fn, arg]`, or `{ fn, arg }`.
async function applyInitScripts(context, { initScript = null, initScripts = [] } = {}) {
  for (const entry of [...(initScript ? [initScript] : []), ...initScripts]) {
    if (Array.isArray(entry)) {
      await context.addInitScript(entry[0], entry[1]);
    } else if (entry && typeof entry === "object" && typeof entry.fn === "function") {
      await context.addInitScript(entry.fn, entry.arg);
    } else if (entry) {
      await context.addInitScript(entry);
    }
  }
}

// Collect uncaught page errors and console errors (excluding missing-favicon noise) on `page`.
export function attachPageCollectors(page) {
  const pageErrors = [];
  const consoleErrors = [];
  page?.on?.("pageerror", (e) => pageErrors.push(String((e && e.message) || e)));
  page?.on?.("console", (m) => {
    if (m && typeof m.type === "function" && m.type() === "error" && !/favicon/i.test(m.text())) {
      consoleErrors.push(m.text());
    }
  });
  return { pageErrors, consoleErrors };
}

// Open an isolated BrowserContext + Page on an already-running `browser` and close the context in `finally`.
// Lets a multi-scenario harness launch Chromium once via `withBrowser` and still get clean storage/DOM per case.
export async function withPage(browser, fn, options = {}) {
  const {
    viewport = { width: 1440, height: 900 },
    deviceScaleFactor = 1,
    permissions = null,
    initScript = null,
    initScripts = [],
    contextOptions = {},
  } = options;
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor,
    ...(permissions ? { permissions } : {}),
    ...contextOptions,
  });
  try {
    await applyInitScripts(context, { initScript, initScripts });
    const page = await context.newPage();
    const { pageErrors, consoleErrors } = attachPageCollectors(page);
    return await fn({ browser, context, page, pageErrors, consoleErrors });
  } finally {
    await context.close().catch(() => {});
  }
}

// Run `fn` with a browser, a context and a page; close the browser whatever fn does.
//
// `initScript` / `initScripts` are seeded before the first navigation (each entry may be `fn` or `[fn, arg]`).
// `withPage` is also passed to `fn` so a harness with several isolated scenarios can open fresh contexts on the
// same Chromium instance instead of launching a new browser per scenario.
export async function withBrowser(fn, options = {}) {
  const {
    playwright = null,
    headless = true,
    args = [],
    viewport = { width: 1440, height: 900 },
    deviceScaleFactor = 1,
    permissions = null,
    initScript = null,
    initScripts = [],
    contextOptions = {},
    launchOptions = {},
  } = options;
  const engine = playwright || requirePlaywright(options);
  const browser = await engine.chromium.launch({ headless, args, ...launchOptions });
  const boundWithPage = (innerFn, pageOpts = {}) =>
    withPage(browser, innerFn, { viewport, deviceScaleFactor, ...pageOpts });
  try {
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor,
      ...(permissions ? { permissions } : {}),
      ...contextOptions,
    });
    await applyInitScripts(context, { initScript, initScripts });
    const page = await context.newPage();
    const { pageErrors, consoleErrors } = attachPageCollectors(page);
    return await fn({
      browser,
      context,
      page,
      pageErrors,
      consoleErrors,
      withPage: boundWithPage,
      playwright: engine,
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

// Init script that replaces `window.EventSource` with an inert stub so a browser card probe's
// fabricated `state.jobs` is not overwritten by the server's live `/api/stream` broadcast.
export function stubEventSourceInit() {
  window.__fakeStreams = [];
  window.EventSource = function FakeStream(url) {
    this.url = url;
    this.readyState = 1;
    this.addEventListener = () => {};
    this.removeEventListener = () => {};
    this.close = () => {
      this.readyState = 2;
    };
    window.__fakeStreams.push(this);
  };
}

export const FAKE_EVENT_SOURCE_SCRIPT = stubEventSourceInit;

export async function installFakeEventSource(target) {
  await target.addInitScript(stubEventSourceInit);
  return target;
}

// A harness's first three lines, once: go to the panel, wait for the thing that proves the page rendered.
export async function openPage(page, base, { pathname = "/", waitUntil = "domcontentloaded", selector = null, timeout = 30_000 } = {}) {
  await page.goto(String(base).replace(/\/$/, "") + pathname, { waitUntil, timeout });
  if (selector) await page.waitForSelector(selector, { timeout });
  return page;
}

// Open the Settings drawer and, when `group` is named, unfold that `<h3 data-settings-group="...">` section
// (since PR #118 every settings group starts folded by default).
export async function openSettingsGroup(page, group = null) {
  const open = await page.evaluate(() => {
    const panel = document.getElementById("settings");
    return Boolean(panel) && !panel.classList.contains("hidden") && getComputedStyle(panel).display !== "none";
  });
  if (!open) await page.click("#btn-settings");
  await page.waitForSelector("#settings:not(.hidden)", { timeout: 10_000 });
  if (group) {
    const sel = `[data-settings-group="${group}"]`;
    await page.waitForSelector(sel, { state: "attached", timeout: 10_000 });
    const folded = await page.evaluate((s) => document.querySelector(s)?.getAttribute("aria-expanded") === "false", sel);
    if (folded) await page.click(sel);
  }
}

// The sentence every harness prints when the browser half could not run. One wording, so a reader greps once.
export function notRun(what, why) {
  return `BROWSER-HALF-NOT-RUN  ${what} — ${why}`;
}
