// The truncated name and branch, copied WHOLE - proved on the real page, with the real clipboard.
//
//   node tools/verify-copy-full-name.mjs
//
// WHAT THIS GUARDS. public/chart.css ellipsises `td.name`/.row-name and `td.branch`, so a highlight or a
// double-click on either covers the visible part only, and Ctrl+C used to take the cut string. The fix
// (public/core/copy-full-value.js) answers both the `copy` event and the HIGHLIGHT with the cell's whole value, and
// every other selection is the browser's. So this harness does the thing the reader does, not a call into the module:
//
//   (1) DRAG across the middle of the truncated worktree name, release, and press nothing: the clipboard, read back
//       with navigator.clipboard.readText(), must already hold the whole name; the drag must still be on the screen;
//       a "copied" chip must be up and must not be able to take the next click; and the row must be as expanded as
//       it was before the drag;
//   (2) the same drag on the branch cell, which is a different rendering of the same value;
//   (3) a double-click on a word of the name still selects only that word, and the highlight path puts the whole name
//       on the clipboard before Ctrl+C is pressed - then Ctrl+C still does;
//   (4) the same for the branch;
//   (5) a double-click and Ctrl+C on plain page text outside the row stay the browser's own copy of exactly what was
//       selected - the proof the handler leaves every other selection alone;
//   (6) a plain click on the name cell still expands the row, and copies nothing.
//
// The captures are the record: the row with the selection still highlighted and the "copied" chip beside it, plus a
// strip at the bottom of the same frame carrying the clipboard's actual text, read back after the write. Nothing is
// typed into the strip by this harness except what readText() returned.
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
const OUT = process.env.COPY_FULL_OUT || path.join(ROOT, "docs", "assets", "copy-full-highlight");

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
// lands on a word however the column was sized. `key` resolves the row in the SAME evaluate: the board replaces a
// <tr> on a repaint, so a selector holding an id captured a moment ago can find nothing.
async function dblclickText(page, selector, key = null) {
  const at = await page.evaluate(
    ({ sel, k }) => {
      const root = k ? [...document.querySelectorAll("tr.row")].find((el) => el.dataset.key === k) : document;
      const el = root && root.querySelector(sel);
      if (!el) return null;
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = range.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: r.left + Math.min(12, Math.max(2, r.width / 2)), y: r.top + r.height / 2, text: String(el.textContent || "") };
    },
    { sel: selector, k: key },
  );
  if (!at) throw new Error(`nothing to double-click for ${selector}${key ? ` in ${key}` : ""}`);
  await page.mouse.dblclick(at.x, at.y);
  return at;
}
// Each case starts with no selection, so a copy cannot be answered from the previous case's highlight.
const clearSelection = (page) => page.evaluate(() => window.getSelection()?.removeAllRanges());
// The text the page thinks is highlighted, read back the way a reader would see it.
const selectionText = (page) => page.evaluate(() => String(window.getSelection() || ""));

// A DRAG across the middle of a cell, which is the gesture this landing is about: no Ctrl+C follows it, so
// anything on the clipboard afterwards was written by the page. The start is inside the inner element that holds
// the text (the name's span, the branch's link), and the end is clamped to the cell, so the drag can never run off
// into a neighbouring column and select a second value. The row is resolved by its data-key in this same evaluate,
// for the reason `dblclickText` gives.
async function dragHighlight(page, key, cellSel, innerSel = null) {
  const box = await page.evaluate(
    ({ k, cs, is }) => {
      const tr = [...document.querySelectorAll("tr.row")].find((el) => el.dataset.key === k);
      if (!tr) return { noRow: true };
      const cell = tr.querySelector(cs);
      const inner = (is && tr.querySelector(is)) || cell;
      if (!cell || !inner) return { noCell: true, cs };
      const c = cell.getBoundingClientRect();
      const i = inner.getBoundingClientRect();
      const left = Math.max(c.left + 3, i.left + 2);
      const right = Math.min(c.right - 4, i.right);
      if (!(right > left + 12)) {
        return { tooSmall: true, cell: [Math.round(c.left), Math.round(c.right), Math.round(c.width)], inner: [Math.round(i.left), Math.round(i.right), Math.round(i.width)], top: Math.round(i.top) };
      }
      return { x1: left + 4, x2: Math.min(left + 70, right - 2), y: i.top + i.height / 2, width: right - left, text: String(inner.textContent || "") };
    },
    { k: key, cs: cellSel, is: innerSel },
  );
  if (!box) throw new Error(`nothing to drag across for ${cellSel}`);
  if (box.noRow) throw new Error(`the row ${key} was not on the page`);
  if (box.noCell) throw new Error(`nothing to drag across for ${cellSel} in ${key}`);
  if (box.tooSmall) throw new Error(`nothing to drag across for ${cellSel}: cell ${JSON.stringify(box.cell)}, inner ${JSON.stringify(box.inner)}, top ${box.top}`);
  await page.mouse.move(box.x1, box.y);
  await page.mouse.down();
  await page.mouse.move((box.x1 + box.x2) / 2, box.y, { steps: 5 });
  await page.mouse.move(box.x2, box.y, { steps: 5 });
  await page.mouse.up();
  return box;
}

// The "copied" chip, as the page draws it: its text, whether it has a box, and whether it can take a gesture.
const flashState = (page) =>
  page.evaluate(() => {
    const el = document.querySelector(".copy-flash");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return { text: el.textContent, role: el.getAttribute("role"), width: r.width, height: r.height, pointer: style.pointerEvents, userSelect: style.userSelect };
  });

// Whether the row is expanded, which is what a plain click toggles. Resolved by data-key in the same evaluate, so a
// repaint between two calls cannot answer about a row that has been replaced.
const rowState = (page, key) => page.evaluate((k) => {
  const tr = [...document.querySelectorAll("tr.row")].find((el) => el.dataset.key === k);
  return { expanded: Boolean(tr && tr.classList.contains("expanded")), detail: Boolean(tr && tr.nextElementSibling && tr.nextElementSibling.classList.contains("detail")) };
}, key);

// The board repaints rows constantly (a scan, a row frame, a fold), and a repaint replaces the <tr> - id and all. Every
// section re-finds the row by its data-key and puts the harness's id back before it touches anything, so a repaint
// between two sections cannot turn into "nothing to drag across".
async function settleRow(page, key) {
  return waitFor(
    () =>
      page.evaluate((k) => {
        const tr = [...document.querySelectorAll("tr.row")].find((el) => el.dataset.key === k) || document.getElementById("copy-row");
        if (!tr || !tr.querySelector("td.name .row-name")) return false;
        tr.id = "copy-row";
        return true;
      }, key),
    { timeoutMs: 15000, what: "the sandbox row to be back on the page" },
  );
}

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
  await settleRow(page, key);

  // ---- (0) the cells the fix is about, and that the chart still cuts them ---------------------------------
  const cells = await page.evaluate((k) => {
    const tr = [...document.querySelectorAll("tr.row")].find((el) => el.dataset.key === k);
    const nameCell = tr?.querySelector("td.name");
    const nameInner = nameCell?.querySelector(".row-name");
    const branchCell = tr?.querySelector("td.branch");
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
  }, key);
  check("td.name carries the whole worktree name", cells.nameAttr, NAME);
  check("td.branch carries the whole branch", cells.branchAttr, BRANCH);
  ok("the name cell is still ellipsised, not re-laid-out", cells.nameEllipsis === "ellipsis" && cells.nameClip[0] > cells.nameClip[1], `text-overflow ${cells.nameEllipsis}, scrollWidth ${cells.nameClip?.[0]} > clientWidth ${cells.nameClip?.[1]}`);
  ok("the branch cell is still ellipsised, not re-laid-out", cells.branchEllipsis === "ellipsis" && cells.branchWraps === "nowrap" && cells.branchClip[0] > cells.branchClip[1], `text-overflow ${cells.branchEllipsis}, scrollWidth ${cells.branchClip?.[0]} > clientWidth ${cells.branchClip?.[1]}`);

  // ---- (1) the name: the HIGHLIGHT itself is the copy -------------------------------------------------
  // A drag across a middle chunk of the truncated name, released, with NO Ctrl+C afterwards: the clipboard must
  // already hold the whole name, because the highlight is the gesture the reader asked for. The selection must still
  // be the piece they dragged (the write never replaces the highlight), the flash must say it happened, and the row
  // must be exactly as expanded as it was before the drag.
  await settleRow(page, key);
  await clearSelection(page);
  await sleep(250); // let a previous case's settle check run out before the "before" reading
  const beforeDrag = await rowState(page, key);
  const nameBox = await dragHighlight(page, key, "td.name", "td.name .row-name");
  await sleep(150); // the write is a promise; the readText below is the proof it landed
  const nameHighlight = await selectionText(page);
  ok(
    "the drag highlighted part of the name, not the whole cell",
    nameHighlight.length > 0 && nameHighlight.length < NAME.length,
    `${nameHighlight.length} of ${NAME.length} chars: ${JSON.stringify(nameHighlight)}`,
  );
  ok("the highlighted fragment is a piece of the name that was drawn", nameBox.text.includes(nameHighlight), `${JSON.stringify(nameHighlight)} inside ${JSON.stringify(nameBox.text)}`);
  const nameFlash = await flashState(page);
  ok(
    "a copied chip is on the page after the drag",
    Boolean(nameFlash) && nameFlash.text === "copied" && nameFlash.width > 0 && nameFlash.height > 0,
    nameFlash ? `text ${JSON.stringify(nameFlash.text)}, role ${nameFlash.role}, ${Math.round(nameFlash.width)}x${Math.round(nameFlash.height)}` : "no .copy-flash",
  );
  ok(
    "the chip cannot take the reader's next click or drag",
    Boolean(nameFlash) && nameFlash.pointer === "none" && nameFlash.userSelect === "none",
    nameFlash ? `pointer-events ${nameFlash.pointer}, user-select ${nameFlash.userSelect}` : "no .copy-flash",
  );
  const nameDragCopied = await capture(page, path.join(OUT, "name-highlight-copied-whole.png"), "worktree name, dragged highlight, no Ctrl+C");
  check("a HIGHLIGHT on the truncated worktree name puts the WHOLE name on the clipboard", nameDragCopied, NAME);
  const afterDrag = await rowState(page, key);
  ok("the drag left the row's expand state alone", afterDrag.expanded === beforeDrag.expanded, `expanded ${beforeDrag.expanded} -> ${afterDrag.expanded}`);
  const keptHighlight = await selectionText(page);
  ok("the highlight is still on the screen after the write", keptHighlight === nameHighlight, `selection ${JSON.stringify(keptHighlight)}`);
  ok("the copied chip clears itself", await waitFor(async () => (await flashState(page)) === null, { timeoutMs: 4000, what: "the copied chip to disappear" }), "gone within 4s");

  // ---- (2) the branch: a different rendering of the same rule -----------------------------------------
  // The branch cell is its own ellipsis (chart.css line 83) and its text can sit inside a link, so this is not the
  // name cell with another string: the drag starts in the cell and its whole value is what must land.
  await settleRow(page, key);
  await clearSelection(page);
  await sleep(250);
  const beforeBranch = await rowState(page, key);
  const branchBox = await dragHighlight(page, key, "td.branch");
  await sleep(150);
  const branchHighlight = await selectionText(page);
  ok(
    "the drag highlighted part of the branch, not the whole cell",
    branchHighlight.length > 0 && branchHighlight.length < BRANCH.length,
    `${branchHighlight.length} of ${BRANCH.length} chars: ${JSON.stringify(branchHighlight)}`,
  );
  ok("the highlighted fragment is a piece of the branch", branchBox.text.includes(branchHighlight), `${JSON.stringify(branchHighlight)} inside ${JSON.stringify(branchBox.text)}`);
  const branchFlash = await flashState(page);
  ok("the branch's copy says copied as well", Boolean(branchFlash) && branchFlash.text === "copied" && branchFlash.width > 0, branchFlash ? `text ${JSON.stringify(branchFlash.text)}` : "no .copy-flash");
  const branchDragCopied = await capture(page, path.join(OUT, "branch-highlight-copied-whole.png"), "branch, dragged highlight, no Ctrl+C");
  check("a HIGHLIGHT on the truncated branch puts the WHOLE branch on the clipboard", branchDragCopied, BRANCH);
  const afterBranch = await rowState(page, key);
  ok("the branch drag left the row's expand state alone", afterBranch.expanded === beforeBranch.expanded, `expanded ${beforeBranch.expanded} -> ${afterBranch.expanded}`);
  ok("the branch highlight is still on the screen after the write", (await selectionText(page)) === branchHighlight);

  // ---- (3) the worktree name, double-clicked and copied ------------------------------------------------
  await settleRow(page, key);
  await clearSelection(page);
  await dblclickText(page, "td.name .row-name", key);
  const nameSelection = await page.evaluate(() => String(window.getSelection() || ""));
  ok("the double-click selected only part of the name, as it always did", nameSelection.length > 0 && nameSelection.length < NAME.length, `selected ${JSON.stringify(nameSelection)}`);
  // The double-click is itself a highlight, so the whole name is already there before any key is pressed.
  await sleep(200);
  check("the double-click alone puts the WHOLE name on the clipboard", await readClipboard(page), NAME);
  await page.keyboard.press("Control+c");
  await sleep(250);
  const nameCopied = await capture(page, path.join(OUT, "name-copied-whole.png"), "worktree name, double-clicked");
  check("Ctrl+C on the truncated worktree name puts the WHOLE name on the clipboard", nameCopied, NAME);

  // ---- (4) the branch, double-clicked and copied -------------------------------------------------------
  await settleRow(page, key);
  await clearSelection(page);
  await dblclickText(page, "td.branch .branch-plain, td.branch a.branch-link", key);
  const branchSelection = await page.evaluate(() => String(window.getSelection() || ""));
  ok("the double-click selected only part of the branch", branchSelection.length > 0 && branchSelection.length < BRANCH.length, `selected ${JSON.stringify(branchSelection)}`);
  await sleep(200);
  check("the double-click alone puts the WHOLE branch on the clipboard", await readClipboard(page), BRANCH);
  await page.keyboard.press("Control+c");
  await sleep(250);
  const branchCopied = await capture(page, path.join(OUT, "branch-copied-whole.png"), "branch, double-clicked");
  check("Ctrl+C on the truncated branch puts the WHOLE branch on the clipboard", branchCopied, BRANCH);

  // ---- (5) a copy outside those cells is the browser's own --------------------------------------------
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
  await settleRow(page, key);
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

  // ---- (6) a plain click still expands the row ---------------------------------------------------------
  // The highlight path must not have taken the row's own gesture with it: one click on the name cell (no drag, so
  // no highlight) opens the detail row and copies nothing, and a second click closes it again.
  await settleRow(page, key);
  const namePoint = await page.evaluate((k) => {
    const tr = [...document.querySelectorAll("tr.row")].find((el) => el.dataset.key === k);
    const el = tr?.querySelector("td.name .row-name");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.min(r.left + 12, r.right - 2), y: r.top + r.height / 2 };
  }, key);
  if (!namePoint) throw new Error(`no name cell to click in ${key}`);
  // Whatever the double-click cases left behind, start from the folded row.
  if ((await rowState(page, key)).expanded) {
    await page.mouse.click(namePoint.x, namePoint.y);
    await waitFor(async () => !(await rowState(page, key)).expanded, { timeoutMs: 3000, what: "the row to fold before the click case" });
  }
  const clipBeforeClick = await readClipboard(page);
  await page.mouse.click(namePoint.x, namePoint.y);
  ok(
    "a plain click on the name still expands the row",
    await waitFor(async () => (await rowState(page, key)).expanded, { timeoutMs: 3000, what: "the row to expand on a plain click" }),
    `expanded ${(await rowState(page, key)).expanded}`,
  );
  ok("that click copied nothing", (await readClipboard(page)) === clipBeforeClick, `clipboard ${JSON.stringify(await readClipboard(page))}`);
  await page.mouse.click(namePoint.x, namePoint.y);
  ok(
    "a second plain click folds it again",
    await waitFor(async () => !(await rowState(page, key)).expanded, { timeoutMs: 3000, what: "the row to fold on a second click" }),
  );

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
