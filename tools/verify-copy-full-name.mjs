// The truncated name and branch, copied WHOLE - proved on the real page, with the real clipboard.
//
//   node tools/verify-copy-full-name.mjs
//
// WHAT THIS GUARDS. public/chart.css ellipsises `td.name`/.row-name and `td.branch`, so a double-click on either
// selects the visible part and Ctrl+C took the cut string. The fix (public/core/copy-full-value.js) answers the
// `copy` event with the cell's whole value, and every other copy is the browser's. So this harness does the thing
// the reader does, not a call into the module:
//
//   (1) double-click a word of the truncated worktree name, press Ctrl+C, and read the clipboard back with
//       navigator.clipboard.readText() - it must be the whole name, and the cell must still be ellipsised;
//   (2) the same for the branch;
//   (3) double-click a word of ANOTHER cell in the same row (the dirty count), press Ctrl+C, and read it back - it
//       must be the word that was selected and nothing else, which is the proof the handler leaves a copy outside
//       those cells exactly as it was.
//
// The two screenshots are the record: the row on the left with the selection still highlighted, and a strip at the
// bottom of the same frame carrying the clipboard's actual text, read back after the copy. Nothing is typed into
// the strip by this harness except what readText() returned.
//
// Sandbox only: a throwaway repo with one hand-cut worktree whose name is long enough to be cut, its own
// PANEL_CONFIG, logs and port, and a dead apiServer. The live panel and the live gateway are never touched, and
// the panel is never restarted - this boots a second, separate one.
//
// HARNESS: LIVE GATE
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const OUT = process.env.COPY_FULL_OUT || path.join(ROOT, "docs", "assets", "copy-full-name");

let failures = 0;
let checks = 0;
function ok(name, cond, extra = "") {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` - ${extra}` : ""}`);
  }
}
function check(name, got, want) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  checks += 1;
  if (same) console.log(`PASS  ${name}: ${JSON.stringify(got)}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 40_000, stepMs = 250, what = "condition" } = {}) {
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
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true }).trim();
  } catch (e) {
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${String((e && e.stderr) || e.message)}`);
  }
};
const commit = (where, message) => {
  git(where, ["add", "-A"]);
  git(where, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
};

const pw = loadPlaywright();
if (!pw) {
  console.log("BROWSER-HALF-NOT-RUN  the truncated name and branch were not copied in a browser.");
  console.log("  re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-copy-full-name.mjs");
  process.exit(2);
}

// ---- the sandbox -----------------------------------------------------------------------------------
// The name is the length the real board cuts: 43 characters of branch slug, which is what the row shows and what
// the cell has no room for at this window.
const NAME = "make-a-truncated-worktree-name-and-e5d056";
const BRANCH = `wtgui/${NAME}`;
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-copy-full-"));
const rootDir = path.join(dir, "scan-root");
const repo = path.join(rootDir, "sandbox-repo");
const home = path.join(dir, "hermes-home");
const configDir = path.join(dir, "panel");
const TREE = path.join(repo, ".worktrees", NAME);
mkdirSync(path.join(repo, ".worktrees"), { recursive: true });
mkdirSync(home, { recursive: true });
mkdirSync(configDir, { recursive: true });
mkdirSync(OUT, { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# sandbox repo\n", "utf8");
commit(repo, "seed the sandbox repo");
git(repo, ["worktree", "add", "-q", "-b", BRANCH, TREE]);
writeFileSync(path.join(TREE, "one.txt"), "sandbox work\n", "utf8");
commit(TREE, "do the work this row is named after");

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
  const up = await waitFor(async () => (await fetch(`${base}/api/state`)).ok, { what: "the sandbox panel to answer /api/state" });
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
const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// The clipboard's actual text, as the page reads it back. This is the only source the strip and the assertions use.
const readClipboard = (page) => page.evaluate(async () => await navigator.clipboard.readText());

// A double-click ON THE TEXT, not on the middle of the box: a chart cell is mostly padding, and a double-click in
// the empty part of it selects nothing at all. The point is measured from the node's own text range, so the click
// lands on a word however the column was sized.
async function dblclickText(page, selector) {
  const at = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const range = document.createRange();
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: r.left + Math.min(12, Math.max(2, r.width / 2)), y: r.top + r.height / 2, text: String(el.textContent || "") };
  }, selector);
  if (!at) throw new Error(`nothing to double-click for ${selector}`);
  await page.mouse.dblclick(at.x, at.y);
  return at;
}
// Each case starts with no selection, so a copy cannot be answered from the previous case's highlight.
const clearSelection = (page) => page.evaluate(() => window.getSelection()?.removeAllRanges());

// A strip at the bottom of the frame carrying what the clipboard really holds, then a screenshot of the frame.
async function capture(page, file, label) {
  const said = await readClipboard(page);
  await page.evaluate(
    ({ label, said }) => {
      document.querySelectorAll("[data-copy-capture]").forEach((n) => n.remove());
      const strip = document.createElement("div");
      strip.setAttribute("data-copy-capture", "1");
      strip.style.cssText =
        "position:fixed;left:0;right:0;bottom:0;z-index:40;background:#101318;border-top:2px solid #3d6ea8;" +
        "color:#e6e8ec;font:13px/1.5 Consolas,'Cascadia Mono',monospace;padding:10px 16px 12px;white-space:pre-wrap";
      const head = document.createElement("div");
      head.style.cssText = "color:#8ea6c0;font-size:11px;letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px";
      head.textContent = `${label} - clipboard, read back with navigator.clipboard.readText()`;
      const body = document.createElement("div");
      body.style.cssText = "color:#9fe0a8;font-weight:600;font-size:14px";
      body.textContent = said;
      strip.append(head, body);
      document.body.appendChild(strip);
    },
    { label, said },
  );
  await page.screenshot({ path: file });
  return said;
}

let browser = null;
const run = async () => {
  await startPanel();
  const row = await (async () => {
    const until = Date.now() + 60_000;
    for (;;) {
      const state = await (await fetch(`${base}/api/state`)).json();
      const found = state.projects?.find((p) => p.name === "sandbox-repo")?.worktrees?.find((w) => norm(w.path) === norm(TREE));
      // The branch is filled by the scan's own git read, which can land a moment after the row itself.
      if (found && found.branch) return found;
      if (Date.now() > until) return found || null;
      await sleep(400);
    }
  })();
  check("the sandbox row is on the board with the long name and branch", [row?.name, row?.branch], [NAME, BRANCH]);
  if (!row) throw new Error("the row never boarded");

  browser = await pw.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  await context.addInitScript(() => localStorage.setItem("wm.expandedProjects", JSON.stringify(["sandbox-repo"])));
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String((e && e.message) || e)));
  await page.goto(base, { waitUntil: "domcontentloaded" });
  // The row's data-key is `project::path`, a Windows path full of backslashes and a colon, which no CSS attribute
  // selector can carry unescaped. The harness names the row it found instead of building a selector out of it.
  const key = `sandbox-repo::${row.path}`;
  const named = await waitFor(
    () =>
      page.evaluate((k) => {
        const tr = [...document.querySelectorAll("tr.row")].find((el) => el.dataset.key === k);
        if (!tr || !tr.querySelector("td.name .row-name")) return false;
        tr.id = "copy-row";
        return true;
      }, key),
    { what: "the sandbox row on the page" },
  );
  ok("the sandbox row is drawn", named, key);
  if (!named) throw new Error(`the row never appeared on ${base}`);
  const rowSel = "#copy-row";
  await page.waitForSelector(`${rowSel} td.name .row-name`, { timeout: 30_000 });

  // ---- (0) the cells the fix is about, and that the chart still cuts them ---------------------------------
  const cells = await page.evaluate((sel) => {
    const nameCell = document.querySelector(`${sel} td.name`);
    const nameInner = nameCell?.querySelector(".row-name");
    const branchCell = document.querySelector(`${sel} td.branch`);
    const style = (el) => (el ? getComputedStyle(el) : null);
    return {
      nameAttr: nameCell?.getAttribute("data-copy-value") ?? null,
      branchAttr: branchCell?.getAttribute("data-copy-value") ?? null,
      nameDrawn: nameInner?.textContent ?? null,
      branchDrawn: branchCell?.textContent?.trim() ?? null,
      nameClip: nameInner ? [nameInner.scrollWidth, nameInner.clientWidth] : null,
      branchClip: branchCell ? [branchCell.scrollWidth, branchCell.clientWidth] : null,
      nameEllipsis: style(nameInner)?.textOverflow ?? null,
      branchEllipsis: style(branchCell)?.textOverflow ?? null,
      branchWraps: style(branchCell)?.whiteSpace ?? null,
    };
  }, rowSel);
  check("td.name carries the whole worktree name", cells.nameAttr, NAME);
  check("td.branch carries the whole branch", cells.branchAttr, BRANCH);
  ok("the name cell is still ellipsised, not re-laid-out", cells.nameEllipsis === "ellipsis" && cells.nameClip[0] > cells.nameClip[1], `text-overflow ${cells.nameEllipsis}, scrollWidth ${cells.nameClip?.[0]} > clientWidth ${cells.nameClip?.[1]}`);
  ok("the branch cell is still ellipsised, not re-laid-out", cells.branchEllipsis === "ellipsis" && cells.branchWraps === "nowrap" && cells.branchClip[0] > cells.branchClip[1], `text-overflow ${cells.branchEllipsis}, scrollWidth ${cells.branchClip?.[0]} > clientWidth ${cells.branchClip?.[1]}`);

  // ---- (1) the worktree name, double-clicked and copied ------------------------------------------------
  await clearSelection(page);
  await dblclickText(page, `${rowSel} td.name .row-name`);
  const nameSelection = await page.evaluate(() => String(window.getSelection() || ""));
  ok("the double-click selected only part of the name, as it always did", nameSelection.length > 0 && nameSelection.length < NAME.length, `selected ${JSON.stringify(nameSelection)}`);
  await page.keyboard.press("Control+c");
  await sleep(250);
  const nameCopied = await capture(page, path.join(OUT, "name-copied-whole.png"), "worktree name, double-clicked");
  check("Ctrl+C on the truncated worktree name puts the WHOLE name on the clipboard", nameCopied, NAME);

  // ---- (2) the branch, double-clicked and copied -------------------------------------------------------
  await clearSelection(page);
  await dblclickText(page, `${rowSel} td.branch .branch-plain, ${rowSel} td.branch a.branch-link`);
  const branchSelection = await page.evaluate(() => String(window.getSelection() || ""));
  ok("the double-click selected only part of the branch", branchSelection.length > 0 && branchSelection.length < BRANCH.length, `selected ${JSON.stringify(branchSelection)}`);
  await page.keyboard.press("Control+c");
  await sleep(250);
  const branchCopied = await capture(page, path.join(OUT, "branch-copied-whole.png"), "branch, double-clicked");
  check("Ctrl+C on the truncated branch puts the WHOLE branch on the clipboard", branchCopied, BRANCH);

  // ---- (3) a copy outside those cells is the browser's own --------------------------------------------
  // Not another cell of the row: chart.css line 38 makes every cell from the third on unselectable on purpose, so
  // the name and the branch are the only selectable text in a row. So the case is any other text on the page: the
  // first leaf element, outside the row, that the browser will actually let a reader drag across.
  const other = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll("body *")].filter((el) => {
      if (el.children.length || el.closest("tr.row") || el.closest("script, style")) return false;
      // A control is not text a reader can drag across, and pressing one would press it.
      if (el.closest("button, a, input, select, textarea, label, summary, [role='button']")) return false;
      const text = String(el.textContent || "").trim();
      if (text.length < 3 || text.length > 60) return false;
      if (getComputedStyle(el).userSelect === "none") return false;
      const r = el.getBoundingClientRect();
      return r.width > 8 && r.height > 6 && r.top > 0 && r.bottom < window.innerHeight;
    });
    // One token reads as one answer: a double-click selects the whole of it, so the clipboard can be compared to
    // exactly what the browser highlighted.
    const pick = candidates.find((el) => /^[\w./:@-]+$/.test(String(el.textContent || "").trim())) || candidates[0];
    if (!pick) return null;
    pick.setAttribute("data-copy-other", "1");
    return { tag: pick.tagName, cls: pick.className, text: String(pick.textContent || "").trim() };
  });
  ok("there is other text on the page to copy from", Boolean(other), other ? `${other.tag} ${other.cls} holds ${JSON.stringify(other.text)}` : "no selectable text outside the row");
  await clearSelection(page);
  const clicked = await dblclickText(page, "[data-copy-other]");
  console.log(`      (the text picked: ${JSON.stringify(clicked.text)})`);
  const otherSelection = await page.evaluate(() => String(window.getSelection() || ""));
  ok("something outside the row was selected", otherSelection.length > 0, `selected ${JSON.stringify(otherSelection)}`);
  await page.keyboard.press("Control+c");
  await sleep(250);
  const otherCopied = await capture(page, path.join(OUT, "outside-cells-unchanged.png"), "plain page text, not a name or a branch");
  check("a copy outside the name and branch cells is the browser's own copy of what was selected", otherCopied, otherSelection);
  ok("that copy is not a name or a branch", otherCopied !== NAME && otherCopied !== BRANCH && otherCopied.length > 0, `clipboard ${JSON.stringify(otherCopied)}`);

  ok("the page threw nothing while the copies ran", pageErrors.length === 0, pageErrors.join(" | "));
  await context.close();
};

try {
  await run();
} finally {
  if (browser) await browser.close().catch(() => {});
  await stopPanel();
}

console.log(`\n${failures ? "FAIL" : "PASS"}  ${checks - failures}/${checks} checks; captures in ${OUT}`);
process.exit(failures ? 1 : 0);
