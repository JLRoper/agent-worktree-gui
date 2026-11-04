// The worktree row's name-cell controls, proved on the real page: play, name (✎), lock — in that order — and no ✦.
//
//   node tools/verify-worktree-row-actions.mjs
//
// WHAT THIS GUARDS. Two changes to one row:
//
//   (1) the ✦ ("name it from the work") button is gone. It is not merely hidden: no `[data-name-tree]` element,
//       no `.btn-row-name-work`, and no ✦ glyph in the row's name line. The route it posted to
//       (/api/worktree/suggest-name) is gone from server.js and lib/name-from-work.js is deleted; this harness
//       speaks about the page, and tools/verify-named-tree.mjs about the ledger that stays.
//   (2) the ✎ and the padlock swapped places. The row's `.name-line` now draws the play button, then the name
//       button, then the worktree lock. Each keeps its own title and its own behaviour: the ✎ opens the rename
//       prompt, the padlock toggles the worktree lock. The BRANCH lock in the branch cell is a different control
//       and is untouched by both changes.
//
// The click is driven in headless Chromium over a sandbox panel, not read off the template: the page's own
// delegated listeners (click for the buttons) are what answer. `window.prompt` is replaced in an init script so
// the ✎'s box can be recorded instead of blocking the run; returning null is the reader cancelling, so nothing
// is renamed.
//
// Sandbox only: a throwaway repo with one hand-cut worktree, its own PANEL_CONFIG, logs and port, and a dead
// apiServer. The live panel on 7331 and the live gateway are never touched.
//
// HARNESS: LIVE GATE
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

let failures = 0;
let checks = 0;
function check(name, got, want) {
  checks += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
}
function ok(name, cond, extra = "") {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
}
const note = (text) => console.log(`      ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeoutMs = 30_000, stepMs = 250, what = "condition" } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    let got = false;
    try {
      got = await fn();
    } catch {
      got = false;
    }
    if (got) return true;
    if (Date.now() > until) {
      console.log(`      (timed out after ${timeoutMs}ms waiting for ${what})`);
      return false;
    }
    await sleep(stepMs);
  }
}

const git = (dir, args) => {
  try {
    return { ok: true, out: execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true }).trim() };
  } catch (e) {
    return { ok: false, out: String((e && e.stdout) || "").trim(), err: String((e && e.message) || e) };
  }
};
const commit = (where, message) => {
  git(where, ["add", "-A"]);
  return git(where, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", message]);
};
const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

const pw = loadPlaywright();
if (!pw) {
  console.log("BROWSER-HALF-NOT-RUN  the worktree row's controls were not exercised in a browser.");
  console.log("  re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-worktree-row-actions.mjs");
  process.exit(2);
}

// ---- the sandbox ---------------------------------------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-row-actions-"));
const rootDir = path.join(dir, "scan-root");
const repo = path.join(rootDir, "sandbox-repo");
const home = path.join(dir, "hermes-home");
const configDir = path.join(dir, "panel");
const TREE = path.join(repo, ".worktrees", "one-tree-1a2b3c");
const TREE_BRANCH = "wtgui/one-tree-1a2b3c";
for (const d of [repo, path.join(repo, ".worktrees"), home, configDir]) mkdirSync(d, { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# sandbox repo\n", "utf8");
commit(repo, "seed the sandbox repo");
git(repo, ["worktree", "add", "-q", "-b", TREE_BRANCH, TREE]);
writeFileSync(path.join(TREE, "one.txt"), "sandbox work\n", "utf8");
commit(TREE, "do the one-tree work");

const port = await (async () => {
  const { createServer } = await import("node:http");
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port: p } = s.address();
      s.close(() => resolve(p));
    });
  });
})();
const configPath = path.join(configDir, "config.json");
writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      port,
      host: "127.0.0.1",
      scanRoots: [rootDir],
      refreshSeconds: 3600,
      worktreeSeconds: 3600,
      midSeconds: 3600,
      dormantSeconds: 3600,
      slowSeconds: 3600,
      fetchSeconds: -1,
      threads: 1,
      scanMode: "all",
      defaultCwd: repo,
      projectsCacheFile: path.join(configDir, "logs", "projects.json"),
      apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
      assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const base = `http://127.0.0.1:${port}`;
const panelLog = [];
let panel = null;
const startPanel = async () => {
  panel = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PANEL_CONFIG: configPath, HERMES_HOME: home, PANEL_TOKEN: "", API_SERVER_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  panel.stdout.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  panel.stderr.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  const up = await waitFor(async () => (await fetch(`${base}/api/state`)).ok, { timeoutMs: 40_000, what: "the sandbox panel to answer /api/state" });
  if (!up) throw new Error(`the sandbox panel never came up on ${base}\n${panelLog.slice(-15).join("\n")}`);
};
const stopPanel = async () => {
  if (!panel) return;
  const p = panel;
  panel = null;
  await new Promise((resolve) => {
    p.on("exit", resolve);
    p.kill();
    setTimeout(resolve, 6000);
  });
};
const state = async () => (await fetch(`${base}/api/state`)).json();
const rowFor = async (treePath) => {
  const s = await state();
  return s.projects?.find((p) => p.name === "sandbox-repo")?.worktrees?.find((w) => norm(w.path) === norm(treePath)) || null;
};

let browser = null;
const run = async () => {
  await startPanel();
  const row = await (async () => {
    const until = Date.now() + 40_000;
    for (;;) {
      const r = await rowFor(TREE);
      if (r) return r;
      if (Date.now() > until) return null;
      await sleep(400);
    }
  })();
  ok("the sandbox worktree is on the board", Boolean(row), row ? `${row.name} on ${row.branch}` : "no row after 40s");
  if (!row) throw new Error("the row never boarded");
  const key = `sandbox-repo::${row.path}`;

  browser = await pw.chromium.launch({ headless: true, args: ["--disable-features=OverlayScrollbar,FluentOverlayScrollbar"] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript(() => {
    localStorage.setItem("wm.expandedProjects", JSON.stringify(["sandbox-repo"]));
    window.__rowPrompts = [];
    window.prompt = (message, value) => {
      window.__rowPrompts.push({ message: String(message || ""), value: String(value ?? "") });
      return null;
    };
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String((e && e.message) || e)));
  await page.goto(base, { waitUntil: "domcontentloaded" });
  const rowSel = `tr.row[data-key="${key}"]`;
  await page.waitForSelector(rowSel, { timeout: 20_000 });

  // ---- (1) the order and the absent ✦ -------------------------------------------------------------
  const line = await page.evaluate((sel) => {
    const line = document.querySelector(`${sel} td.name .name-line`);
    if (!line) return { error: "no td.name .name-line" };
    const buttons = [...line.querySelectorAll("button")].map((b) => ({
      text: b.textContent.trim(),
      cls: b.className,
      title: b.title,
      play: b.hasAttribute("data-agent-path"),
      rename: b.hasAttribute("data-rename-tree"),
      lock: b.getAttribute("data-lock-scope") || "",
    }));
    const stray = [...document.querySelectorAll("[data-name-tree], .btn-row-name-work")].length;
    return {
      buttons,
      stray,
      sparkle: line.textContent.includes("\u2726"),
      branchLock: (() => {
        const b = document.querySelector(sel ? `${sel} td.branch .btn-branch-lock` : null);
        return b ? { scope: b.getAttribute("data-lock-scope"), text: b.textContent.trim(), title: b.title } : null;
      })(),
    };
  }, rowSel);
  ok("the row's name line is on the page", !line.error, line.error || "");
  const buttons = line.buttons || [];
  check("the name line draws exactly three buttons", buttons.length, 3);
  check(
    "the buttons are play, name (✎), lock — in that order",
    buttons.map((b) => (b.play ? "play" : b.rename ? "name" : b.lock === "tree" ? "lock" : `other:${b.cls}`)),
    ["play", "name", "lock"],
  );
  check("the name button is the ✎", buttons[1]?.text, "\u270e");
  check("the lock button is a padlock", buttons[2]?.text, "\u{1F513}");
  ok("the name button still says what it does", /^name this worktree by hand/.test(buttons[1]?.title || ""), buttons[1]?.title || "");
  ok(
    "the worktree lock still says what it protects",
    /^lock this worktree — a locked worktree can never be deleted/.test(buttons[2]?.title || ""),
    buttons[2]?.title || "",
  );
  check("no ✦ button is left anywhere on the page", line.stray, 0);
  ok("the name line itself carries no ✦ glyph", !line.sparkle);
  check("the branch cell keeps its own padlock", line.branchLock?.scope, "branch");
  ok("the branch padlock is a different control", /^lock this BRANCH/.test(line.branchLock?.title || ""), line.branchLock?.title || "");

  // ---- (2) the ✎ still opens the rename ------------------------------------------------------------
  await page.locator(`${rowSel} [data-rename-tree]`).click();
  const prompts = await page.evaluate(() => window.__rowPrompts || []);
  check("clicking the ✎ opens the rename prompt once", prompts.length, 1);
  ok("the prompt names the tree and its directory", /name this worktree/.test(prompts[0]?.message || "") && /directory:/.test(prompts[0]?.message || ""), prompts[0]?.message?.split("\n")[0] || "");
  ok("the prompt offers the row's current name", String(prompts[0]?.value || "").length > 0, prompts[0]?.value || "");
  check("cancelling the prompt renames nothing", norm((await rowFor(TREE))?.path || ""), norm(row.path));

  // ---- (3) the padlock still toggles ---------------------------------------------------------------
  const lockSel = `${rowSel} [data-lock-scope="tree"]`;
  await page.locator(lockSel).click();
  const locked = await waitFor(
    async () => (await page.evaluate((s) => document.querySelector(s)?.getAttribute("aria-pressed") === "true", lockSel)),
    { timeoutMs: 15_000, what: "the worktree lock to read pressed" },
  );
  ok("clicking the padlock locks the worktree", locked);
  const lockedRow = await rowFor(TREE);
  check("the panel's own record says the tree is locked", Boolean(lockedRow?.lock?.tree), true);
  check("the row paints the closed padlock", await page.locator(lockSel).textContent(), "\u{1F512}");
  ok("the row marks itself locked", String(await page.locator(rowSel).getAttribute("class")).includes("is-locked"), await page.locator(rowSel).getAttribute("class"));
  ok("the lock's title now offers the unlock", /click to unlock it/.test((await page.locator(lockSel).getAttribute("title")) || ""), await page.locator(lockSel).getAttribute("title"));

  await page.locator(lockSel).click();
  const unlocked = await waitFor(
    async () => (await page.evaluate((s) => document.querySelector(s)?.getAttribute("aria-pressed") === "false", lockSel)),
    { timeoutMs: 15_000, what: "the worktree lock to read released" },
  );
  ok("clicking it again unlocks the worktree", unlocked);
  const afterRow = await rowFor(TREE);
  check("the panel's own record says it is unlocked", Boolean(afterRow?.lock?.tree), false);
  check("the row paints the open padlock", await page.locator(lockSel).textContent(), "\u{1F513}");
  ok("the branch padlock is still there, still unlocked", (await page.locator(`${rowSel} td.branch [data-lock-scope="branch"]`).count()) === 1 && (await page.locator(`${rowSel} td.branch [data-lock-scope="branch"]`).getAttribute("aria-pressed")) === "false");

  check("no page errors along the way", pageErrors, []);
  const shotDir = process.env.PANEL_VERIFY_ARTIFACTS;
  if (shotDir) {
    try {
      mkdirSync(shotDir, { recursive: true });
      const file = path.join(shotDir, "worktree-row-actions.png");
      await page.locator(rowSel).screenshot({ path: file });
      note(`screenshot ${file}`);
    } catch (e) {
      note(`screenshot skipped: ${String((e && e.message) || e)}`);
    }
  }
  note("driven: the order, the ✎'s prompt and the padlock's lock/unlock against a real page.");
};

try {
  await run();
} catch (e) {
  failures += 1;
  console.log(`FAIL  the run threw: ${String((e && e.stack) || e)}`);
} finally {
  try {
    await browser?.close();
  } catch {
    /* already gone */
  }
  await stopPanel().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${checks} checks, ${failures} failed.`);
console.log(failures ? `RESULT: ${failures} FAILED` : "RESULT: ALL PASS");
process.exit(failures ? 1 : 0);
