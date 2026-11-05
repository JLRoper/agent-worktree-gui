// A tab running an app.js older than the shell that loaded it must not have a DEAD DELIVERABLES button.
//
//   node tools/verify-deliverables-stale.mjs
//
// HARNESS: LIVE GATE — it tracks main, and `npm run verify:deliverables-stale` is how the repo runs it by name.
//
// THE HYPOTHESIS THIS PINS. The shell (index.html) is served no-store, but every asset URL it renders carries the
// build version (lib/build-version.js). A tab opened while app.js was being written — the live panel measured
// app.js mtime 09:02:57 and a boot at 09:03:24 — gets the NEW shell and the OLD app.js under the URL the shell was
// rendered with, and a browser holding that URL keeps the old bytes. If the old app.js predates the DELIVERABLES
// block, the header carries the button and nothing is wired to it: a click does nothing, logs nothing, and shows
// nothing. That is the worst shape a control can take, and it is what this gate reproduces.
//
// HOW IT REPRODUCES IT. The page is loaded from the real panel, but the `app.js` request is fulfilled with the bytes
// of the build BEFORE the button existed (`git show <the commit that added #btn-deliver>^:public/app.js`). That is
// exactly what the browser's cache holds: the old file under the shell's own versioned URL. Everything else — the
// shell, style.css, the core modules, the API — is the real panel's.
//
// WHAT IT ASSERTS.
//   1. the old app.js really did not wire the button (`#btn-deliver` carries no data-wired)
//   2. a click on it is NOT silent: a console error names the build the page loaded with, and a second one names the
//      build the panel serves (the two differ)
//   3. the page offers the reload: a visible `#stale-build-bar` with role=alert, the two build names in its text, and
//      a real Reload button
//   4. the popover did not open — the guard reports the failure instead of pretending
//   5. the guard is not a false positive: on the SAME panel with the real app.js, the button is wired, the click
//      opens the list, and no stale bar appears
//
// HOW TO SEE IT FAIL: run it on the tree before the guard existed (the shell has no inline guard, so the click is
// silent and checks 2-4 fail).
//
// The browser half needs a Playwright install; without one this exits 2 (BROWSER-HALF-NOT-RUN), like the other
// verify-*.mjs harnesses.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withBrowser, openPage } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";
import { Deliverables } from "../lib/deliverables.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOT_DIR = process.env.PANEL_SHOT_DIR || path.join(ROOT, ".shots");
const git = (...args) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).trim();

let checks = 0;
let failures = 0;
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// ---- the previous build's app.js: the bytes a tab opened mid-edit would be holding ---------------------------------
let addedBy = "";
let oldApp = "";
try {
  // The commit that put #btn-deliver in the shell. `-S` finds the addition, not every later edit of the file.
  addedBy = git("log", "--format=%H", "-S", "btn-deliver", "--", "public/index.html").split("\n").filter(Boolean).pop();
  oldApp = git("show", `${addedBy}^:public/app.js`);
} catch (e) {
  console.log(`BROWSER-HALF-NOT-RUN: cannot read the build before #btn-deliver from this checkout — ${e && e.message}`);
  process.exit(2);
}
if (oldApp.includes("btn-deliver")) {
  console.log(`BROWSER-HALF-NOT-RUN: ${addedBy}^:public/app.js already mentions the button, so it is not the stale half`);
  process.exit(2);
}
console.log(`      stale   app.js from ${addedBy.slice(0, 8)}^ (${oldApp.length} bytes) — the build before the button`);

// ---- the sandbox: one real deliverable, so the healthy page has something to show ---------------------------------
const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-stale-"));
const tree = path.join(dir, "repos", "agent-worktree-gui", ".worktrees", "wtgui-stale-page");
mkdirSync(path.join(tree, "docs"), { recursive: true });
mkdirSync(path.join(dir, "logs"), { recursive: true });
writeFileSync(path.join(tree, "docs", "one.md"), "# the one deliverable\n");
const store = new Deliverables({ file: path.join(dir, "logs", "deliverables.json"), log: () => {} });
store.record({
  job: { id: "stale001", thread: "wtgui-stale-page", turn: 1, project: "agent-worktree-gui", worktreePath: tree, branch: "wtgui/stale-page" },
  tree: { path: tree, branch: "wtgui/stale-page" },
  finalText: "DELIVER file docs/one.md | The one deliverable",
  agent: "stale-page",
  now: Date.now(),
});
const panel = await startPanel({ dir, keep: true, config: { assistant: { enabled: false } } });
console.log(`      panel   ${panel.base}  (throwaway: ${panel.dir})`);

try {
  const result = await withBrowser(async ({ page }) => {
    // ---- 1. the stale page: the shell of the PREVIOUS build, and its app.js bytes ---------------------------------
    // Two halves make the page a stale one. The shell is served with the build version the tab was loaded with (the
    // commit before the button), and the app.js request — the URL that shell rendered — is fulfilled with that same
    // build's file. That is what a browser holds after a panel restart: the old shell, the old app.js, a new server.
    const consoleErrors = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    const shell = await (await fetch(`${panel.base}/`)).text();
    const current = shell.match(/<meta name="panel-build" content="([^"]+)"/)?.[1] || "";
    const loadedBuild = addedBy.slice(0, 12);
    await page.route(`${panel.base}/`, (route) =>
      route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: shell.replace(`content="${current}"`, `content="${loadedBuild}"`) }),
    );
    await page.route(/\/app\.js(\?|$)/, (route) =>
      route.fulfill({ status: 200, contentType: "application/javascript; charset=utf-8", body: oldApp }),
    );
    await openPage(page, panel.base, { selector: "#btn-deliver" });
    await page.waitForTimeout(500);

    const before = await page.evaluate(() => {
      const btn = document.getElementById("btn-deliver");
      return {
        wired: btn.dataset.wired || "",
        loaded: document.querySelector('meta[name="panel-build"]')?.getAttribute("content") || "",
        expanded: btn.getAttribute("aria-expanded"),
        pop: Boolean(document.getElementById("deliver-pop")),
      };
    });
    eq("the stale page's app.js never wired the button", before.wired, "");
    ok("…and the shell still carries the button (that is the trap)", Boolean(before.loaded), `loaded build ${before.loaded}`);

    await page.click("#btn-deliver");
    await page.waitForSelector("#stale-build-bar", { timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(300);

    const after = await page.evaluate(() => {
      const bar = document.getElementById("stale-build-bar");
      const reload = document.getElementById("stale-build-reload");
      const btn = document.getElementById("btn-deliver");
      return {
        bar: Boolean(bar),
        visible: bar ? getComputedStyle(bar).display !== "none" && bar.getBoundingClientRect().height > 0 : false,
        role: bar?.getAttribute("role") || "",
        text: (bar?.textContent || "").trim(),
        reload: Boolean(reload) && reload.tagName === "BUTTON",
        expanded: btn.getAttribute("aria-expanded"),
        pop: Boolean(document.getElementById("deliver-pop")),
      };
    });

    const loadedErr = consoleErrors.find((t) => /loaded from build (\w+)/.test(t));
    const servedErr = consoleErrors.find((t) => /the panel serves (\w+)/.test(t));
    const loadedInErr = loadedErr?.match(/loaded from build (\w+)/)?.[1] || "";
    const servedInErr = servedErr?.match(/the panel serves (\w+)/)?.[1] || "";
    ok("the click is not silent: a console error names the build the page loaded with", Boolean(loadedErr), loadedErr || "(no console error)");
    ok("…and a second names the build the panel serves", Boolean(servedErr), servedErr || "(no console error)");
    ok("…and they are different builds", Boolean(loadedInErr) && Boolean(servedInErr) && loadedInErr !== servedInErr, `${loadedInErr} vs ${servedInErr}`);
    ok("the page offers the reload: a visible role=alert bar", after.bar && after.visible && after.role === "alert", JSON.stringify({ bar: after.bar, visible: after.visible, role: after.role }));
    ok("…naming both builds in its own words", after.text.includes(loadedInErr || "\u0000") && after.text.includes(servedInErr || "\u0000"), after.text);
    ok("…with a real Reload control", after.reload);
    ok("the popover did not open — the guard reports instead of pretending", after.expanded === "false" && after.pop === false, JSON.stringify({ expanded: after.expanded, pop: after.pop }));
    mkdirSync(SHOT_DIR, { recursive: true });
    const staleShot = path.join(SHOT_DIR, "deliverables-stale-bar.png");
    await page.screenshot({ path: staleShot });
    console.log(`SHOT  ${staleShot}`);

    // ---- 2. the same panel, the real app.js: wired, opens, and no stale bar -------------------------------------
    await page.unroute(/\/app\.js(\?|$)/);
    await page.unroute(`${panel.base}/`);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#btn-deliver", { timeout: 15_000 });
    await page.waitForFunction(() => document.getElementById("btn-deliver")?.dataset.wired === "1", null, { timeout: 15_000 }).catch(() => {});
    const healthy = await page.evaluate(() => ({
      wired: document.getElementById("btn-deliver").dataset.wired || "",
      bar: Boolean(document.getElementById("stale-build-bar")),
    }));
    eq("the real build wires the button", healthy.wired, "1");
    await page.click("#btn-deliver");
    await page.waitForSelector("#deliver-pop:not([hidden])", { timeout: 5_000 }).catch(() => {});
    const opened = await page.evaluate(() => ({
      expanded: document.getElementById("btn-deliver").getAttribute("aria-expanded"),
      pop: Boolean(document.getElementById("deliver-pop")) && document.getElementById("deliver-pop").hidden === false,
      bar: Boolean(document.getElementById("stale-build-bar")),
    }));
    ok("…the click opens the list", opened.expanded === "true" && opened.pop, JSON.stringify(opened));
    ok("…and the guard does not fire on a healthy page", opened.bar === false);

    return failures;
  }, { viewport: { width: 1440, height: 900 } });

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (result !== failures) console.log("note: the browser callback's own failure count disagreed with the module counter");
} catch (e) {
  failures += 1;
  console.log(`FAIL  the gate threw: ${e && e.stack ? e.stack : e}`);
} finally {
  await panel.stop?.();
  rmSync(dir, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);
