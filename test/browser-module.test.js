// tools/browser.mjs, asserted: where it looks for playwright, what it does when there is none, and that a browser
// it opened is closed even when the harness throws. The third one is the bug this module exists to end — a copy of
// the bootstrap that threw between launch() and close() left a Chromium process behind, and the next harness on a
// loaded machine then timed out for reasons nothing recorded.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FAKE_EVENT_SOURCE_SCRIPT,
  clearPlaywrightCache,
  installFakeEventSource,
  loadPlaywright,
  playwrightCandidates,
  withBrowser,
} from "../tools/browser.mjs";
import { ROOT } from "../tools/panel-testkit.mjs";

test("the roots are tried in the order the harnesses agreed on, explicit first", () => {
  const roots = playwrightCandidates({ root: "C:/repo", cwd: "C:/work", env: { PANEL_PLAYWRIGHT_ROOT: "C:/explicit", APPDATA: "C:/Users/x/AppData/Roaming" } });
  assert.equal(roots[0], path.resolve("C:/explicit"), "an explicit root wins");
  assert.ok(roots.includes(path.resolve("C:/repo")), "the repo is asked");
  assert.ok(roots.includes(path.resolve("C:/work")), "and the cwd");
  assert.ok(roots.some((r) => r.endsWith(path.join("npm", "node_modules"))), "the global npm prefix is asked, because this repo has no node_modules");
  assert.equal(new Set(roots).size, roots.length, "no duplicate lookups");
});

test("an empty machine is null, not a throw — a harness prints NOT-RUN and exits 2", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "wtgui-nopw-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // allowGlobalFallback:false is what makes "no install" observable on a machine that has a global one: the bare
  // require at the end would otherwise be satisfied by Node's own global lookup.
  const playwright = loadPlaywright({ root: dir, cwd: dir, env: {}, allowGlobalFallback: false });
  assert.equal(playwright, null);
});

test("withBrowser closes the browser it opened, even when the harness throws", async (t) => {
  const playwright = loadPlaywright();
  if (!playwright) {
    t.skip("no Playwright install on this machine (PANEL_PLAYWRIGHT_ROOT) — the close path was not exercised");
    return;
  }
  let seen = null;
  await assert.rejects(
    withBrowser(
      async ({ page, browser }) => {
        seen = browser;
        await page.goto("data:text/html,<title>bootstrap</title><p id=x>closed-when-thrown</p>");
        assert.equal(await page.textContent("#x"), "closed-when-thrown");
        throw new Error("the harness gave up");
      },
      { playwright },
    ),
    /the harness gave up/,
  );
  assert.ok(seen, "the callback saw a browser");
  assert.equal(seen.isConnected(), false, "and it was closed on the way out");
});

test("withBrowser hands back the harness's own value, and a page that already rendered", async (t) => {
  const playwright = loadPlaywright();
  if (!playwright) {
    t.skip("no Playwright install on this machine (PANEL_PLAYWRIGHT_ROOT)");
    return;
  }
  const value = await withBrowser(
    async ({ page, context, withPage }) => {
      await page.goto("data:text/html,<title>ok</title>");
      assert.equal(await page.title(), "ok");
      assert.ok(context, "the context is handed over for a harness that needs a second page");
      const sub = await withPage(async ({ page: secondPage, context: secondCtx }) => {
        await installFakeEventSource(secondCtx);
        await secondPage.goto("data:text/html,<title>sub</title>");
        const fakeReady = await secondPage.evaluate(() => new window.EventSource("/api/stream").readyState);
        return { title: await secondPage.title(), fakeReady };
      });
      assert.deepEqual(sub, { title: "sub", fakeReady: 1 });
      return { measured: 1 };
    },
    { playwright, viewport: { width: 800, height: 600 }, deviceScaleFactor: 2 },
  );
  assert.deepEqual(value, { measured: 1 });
});

test("default loadPlaywright memoizes its lookup and clearPlaywrightCache resets it", () => {
  assert.equal(typeof FAKE_EVENT_SOURCE_SCRIPT, "function");
  const first = loadPlaywright();
  const second = loadPlaywright();
  assert.equal(first, second, "default lookup returns the cached module");
  clearPlaywrightCache();
  assert.equal(loadPlaywright(), first, "re-resolves cleanly after cache reset");
});

test("the module resolves playwright from the repo it ships in", () => {
  // A guard on the shipped default: the repo root is always a candidate, so a checkout that adds node_modules works
  // with no environment at all.
  assert.equal(ROOT, path.resolve(ROOT));
  assert.ok(playwrightCandidates({ root: ROOT, cwd: ROOT, env: {} }).includes(ROOT));
});
