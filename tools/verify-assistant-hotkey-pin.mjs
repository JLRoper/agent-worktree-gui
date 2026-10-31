// The assistant float's bare-A hotkey and its pin button, proved by driving a panel of its own — and a real browser
// over it.
//
//   node tools/verify-assistant-hotkey-pin.mjs [--piece hotkey|pin|both]
//
// Two small behaviours on the floating assistant panel (`public/assistant.js` owns the frame, `public/index.html` the
// markup, `public/style.css` the button):
//
//   1. a BARE "A" opens the float from the board. Bare means bare: any of ctrl/meta/alt/shift disqualifies it, so
//      Ctrl+A stays the browser's select-all, and a caret sitting in a field (input, textarea, select, contenteditable)
//      disqualifies it, so typing in the prompt box — or in any other field on the board — never opens the float.
//      Ctrl+Shift+A, the shortcut that was already there, still toggles.
//   2. a pin button immediately LEFT of the ✕. Pinned, the float ignores the press that would otherwise dismiss it.
//      Unpinned, a press anywhere off the float closes it through the SAME toggle the ✕ calls — one close path, not a
//      second implementation — and the choice is remembered across reloads beside the open flag.
//
// Everything below happens in a sandbox of its own: a throwaway repo, a throwaway HERMES_HOME, its own PANEL_CONFIG
// with its own port, its own logs and job store. No gateway is needed (nothing here spawns a run: `assistant.enabled`
// is false and `apiServer` points at a dead port on purpose, so a leaked worker is impossible), and the live panel on
// 7331 is not touched — the test records its listener count before and after its own boot to show that.
//
// WHAT IS DRIVEN, AND WHAT IS ONLY INSPECTED
//
//   driven        the sandbox: a real panel process booted on an ephemeral port over its own config, proved to be the
//                 instance that answered by finding the sandbox project in /api/state, with the live :7331 listener
//                 count identical before and after
//   driven        the served files: GET /assistant.js and GET / carry the new code (Cache-Control: no-store), which is
//                 why this half is a plain reload and not a restart — no route or guard changed
//   driven        the browser (Playwright, headless Chromium), everything the brief's acceptance asks for: A opens the
//                 float with nothing focused and does nothing with a field focused (and the letter lands IN the field)
//                 or with a modifier down (with Ctrl+A still selecting the page); the pin is inside the head,
//                 immediately left of the ✕ and in the top-right; it reads pressed/unpressed in class, aria-pressed and
//                 its own (non-shifting) box; pinned survives an outside press — on the header and on a field — and
//                 survives a reload; unpinned closes on an outside press and on the ✕, both through the identical
//                 close (same stored flag, same header button state, same panel class); unpinned survives a reload too
//   inspected     that the outside press shares ONE close path with the ✕ is asserted by comparison of the observable
//                 result (the same state after both, byte for byte), not by reading the source — the reading is the
//                 reason it was written that way, and the comparison is what would catch a second implementation
//
// The browser half needs a Playwright install. Point the script at one with PANEL_PLAYWRIGHT_ROOT (a directory holding
// node_modules/playwright, or the package itself); without one the script says BROWSER-HALF-NOT-RUN and exits 2 rather
// than passing on a half that never ran.
//
// --piece hotkey runs only the first group (used to commit the hotkey on its own, before the pin exists) and prints a
// PARTIAL marker instead of the OK one, so a filtered run can never be mistaken for the full proof.
import { execSync, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

// Both spellings: --piece=hotkey and --piece hotkey.
const argOf = (name) => {
  const args = process.argv.slice(2);
  for (const a of args) {
    if (a.startsWith(`--${name}=`)) return a.slice(a.indexOf("=") + 1);
    if (a === `--${name}`) return args[args.indexOf(a) + 1] ?? true;
  }
  return null;
};
const PIECE = String(argOf("piece") || "both");
if (!["hotkey", "pin", "both"].includes(PIECE)) {
  console.log(`--piece takes hotkey, pin or both (got ${PIECE})`);
  process.exit(1);
}
const wantHotkey = PIECE === "hotkey" || PIECE === "both";
const wantPin = PIECE === "pin" || PIECE === "both";

// A hang here would otherwise be silent (a browser left open keeps node's loop alive and the log never lands), so the
// run is bounded and says where it stopped.
const WATCHDOG_MS = Number(process.env.PANEL_VERIFY_WATCHDOG_MS || 240_000);
const watchdog = setTimeout(() => {
  try {
    process.stderr.write(`WATCHDOG: ${WATCHDOG_MS}ms elapsed without the run finishing — see the last line printed above.\n`);
  } catch {
    /* nothing left to do */
  }
  process.exit(1);
}, WATCHDOG_MS);

let failures = 0;
let checks = 0;
const check = (name, got, want) => {
  checks += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const note = (text) => console.log(`      ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 60_000, stepMs = 400, what = "condition" } = {}) {
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
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
// The live board's listener count, so "we did not touch 7331" is measured rather than claimed.
const listenersOn = (port) => {
  let out = "";
  try {
    out = execSync("netstat -ano", { encoding: "utf8", windowsHide: true });
  } catch (e) {
    out = String((e && e.stdout) || "");
  }
  return out
    .split(/\r?\n/)
    .filter((l) => l.includes(`:${port} `) && l.includes("LISTENING")).length;
};

// ---- the sandbox ---------------------------------------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-hotkey-pin-"));
const rootDir = path.join(dir, "scan-root");
const repo = path.join(rootDir, "sandbox-repo");
const home = path.join(dir, "hermes-home");
const configDir = path.join(dir, "panel");
const cwdDir = path.join(dir, "panel-cwd");
const PROJECT = "sandbox-repo";

for (const d of [repo, home, configDir, cwdDir, path.join(configDir, "logs")]) mkdirSync(d, { recursive: true });
git(repo, ["init", "-q", "-b", "main"]);
writeFileSync(path.join(repo, "README.md"), "# sandbox repo\n", "utf8");
git(repo, ["add", "."]);
git(repo, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "first"]);

const liveBefore = listenersOn(7331);
const port = await freePort();
ok("the sandbox port is not the live one", port !== 7331 && port !== 8642, `port ${port}`);
const configPath = path.join(configDir, "config.json");
writeFileSync(
  configPath,
  `${JSON.stringify(
    {
      port,
      host: "127.0.0.1",
      scanRoots: [rootDir],
      refreshSeconds: 4,
      worktreeSeconds: 2,
      midSeconds: 8,
      threads: 1,
      scanMode: "all",
      defaultCwd: cwdDir,
      projectsCacheFile: path.join(configDir, "logs", "projects.json"),
      // A DEAD port on purpose: nothing in this test may reach the live gateway, and nothing here spawns a run.
      apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
      assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
    },
    null,
    2,
  )}\n`,
  "utf8",
);
// A PANEL_CONFIG that does not resolve is not an error — the panel falls back to the LIVE port. Assert it exists first.
ok("the sandbox config is on disk", existsSync(configPath) && statSync(configPath).size > 0, configPath);

const base = `http://127.0.0.1:${port}`;
const panelLog = [];
let panel = null;
const startPanel = async () => {
  panel = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PANEL_CONFIG: configPath, HERMES_HOME: home, PANEL_TOKEN: "" },
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
  p.kill();
  await waitFor(() => p.exitCode !== null || p.signalCode !== null, { timeoutMs: 15_000, what: "the panel to exit" });
  await sleep(300);
};
const state = async () => (await fetch(`${base}/api/state`)).json();

// ---- the browser half ----------------------------------------------------------------------------
let liveBrowser = null;
async function browserPhase(pw) {
  const pageErrors = [];
  const browser = (liveBrowser = await pw.chromium.launch({ headless: true }));
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();
  // A short default so a step that cannot proceed fails and prints, instead of sitting on Playwright's 30s auto-wait.
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${String((e && e.message) || e)}`));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`);
  });

  await page.goto(base, { waitUntil: "domcontentloaded" });
  // Attached, not visible: the float is CLOSED at boot, and that is the state the first checks assert.
  await page.waitForSelector("#assistant", { state: "attached", timeout: 20_000 });
  await page.waitForSelector("#job-prompt", { state: "visible", timeout: 20_000 });

  const store = (key) => page.evaluate((k) => localStorage.getItem(k), key);
  const open = () => page.locator("#assistant").isVisible();
  const activeEl = () => page.evaluate(() => `${document.activeElement?.tagName || "?"}#${document.activeElement?.id || ""}`);
  const shot = async (name) => {
    const into = process.env.PANEL_VERIFY_ARTIFACTS;
    if (!into) return null;
    try {
      mkdirSync(into, { recursive: true });
      const file = path.join(into, name);
      await page.screenshot({ path: file, fullPage: false });
      return file;
    } catch {
      return null;
    }
  };
  // What the float looks like from the outside, after a close. Two closes that produce the same reading went through
  // the same path; a second implementation would show up here as a difference.
  const closeFingerprint = async () => ({
    panelVisible: await open(),
    openFlag: await store("wm.assistantOpen"),
    headerOn: await page.locator("#btn-assistant").evaluate((el) => el.classList.contains("is-on")),
    pinnedClass: await page.locator("#assistant").evaluate((el) => el.classList.contains("is-pinned")),
  });
  // An inert point on the board, well outside the float and outside every field and control: the header's config line.
  const pressOutside = () => page.locator("#config-line").click();

  // ---- piece 1: the bare "A" hotkey ---------------------------------------------------------------
  let hotkeyShots = {};
  if (wantHotkey) {
    console.log("\n== piece 1: a bare A opens the float, and only a bare A ==");
    check("a fresh browser has remembered nothing about the float", await store("wm.assistantOpen"), null);
    ok("the float starts closed", !(await open()));

    // The four hosts a caret can live in. Each one is a REAL field on the board, and the letter must land in it.
    // The board's prompt boxes are contenteditable hosts now (they hold pasted blocks as inline chips), so the
    // reading is the panel's own readBox(box) — the same read every send path takes — not a `.value`.
    const readBox = (sel) => page.evaluate((s) => window.WMApp.board.pasteChips.readBox(document.querySelector(s)), sel);
    const writeBox = (sel, v) => page.evaluate(([s, t]) => window.WMApp.board.pasteChips.writeBox(document.querySelector(s), t), [sel, v]);
    await page.locator("#job-prompt").click();
    check("the board's prompt box has the caret", await activeEl(), "DIV#job-prompt");
    await page.keyboard.type("a");
    check("the letter went into the prompt box, not to the shortcut", await readBox("#job-prompt"), "a");
    ok("a keystroke aimed at the prompt box does not open the float", !(await open()));
    await writeBox("#job-prompt", "");

    // The panel pre-fills this one with the project's path, so the measure is "the field grew by the letter typed",
    // not "the field reads a" — a click puts the caret wherever it was pressed.
    const cwdBefore = await page.locator("#job-cwd").inputValue();
    await page.locator("#job-cwd").click();
    check("the 'start in' input has the caret", await activeEl(), "INPUT#job-cwd");
    await page.keyboard.type("a");
    const cwdAfter = await page.locator("#job-cwd").inputValue();
    ok(
      "the letter went into the 'start in' input",
      cwdAfter.length === cwdBefore.length + 1 && cwdAfter !== cwdBefore,
      `${JSON.stringify(cwdBefore)} → ${JSON.stringify(cwdAfter)}`,
    );
    ok("a keystroke aimed at an input does not open the float", !(await open()));
    await page.locator("#job-cwd").fill(cwdBefore);

    // A <select> is focused by focus(), not by a click: headless Chromium opens a native popup for the click and the
    // popup is not what is under test here.
    await page.locator("#job-project").focus();
    check("the board's project picker has the caret", await activeEl(), "SELECT#job-project");
    await page.keyboard.press("a");
    ok("a keystroke aimed at a select does not open the float", !(await open()));

    // contenteditable has no board instance here, so the probe is a real editable element added to the live page and
    // focused for real — the guard reads isContentEditable, not a class name.
    await page.evaluate(() => {
      const d = document.createElement("div");
      d.id = "verify-ce";
      d.setAttribute("contenteditable", "true");
      d.style.cssText = "position:fixed;left:4px;bottom:4px;width:180px;height:26px;z-index:9999;background:#111;color:#eee";
      d.textContent = "";
      document.body.appendChild(d);
    });
    await page.locator("#verify-ce").click();
    await page.keyboard.type("a");
    check("the letter went into a contenteditable host", await page.locator("#verify-ce").textContent(), "a");
    ok("a keystroke aimed at a contenteditable does not open the float", !(await open()));
    await page.evaluate(() => document.getElementById("verify-ce")?.remove());

    // Modifiers. Ctrl+A must reach the browser's own select-all, which is the reason the bare check is strict.
    await pressOutside();
    check("nothing is focused now (the board itself)", await activeEl(), "BODY#");
    for (const [combo, held] of [["Control+a", "ctrl"], ["Shift+a", "shift"], ["Alt+a", "alt"], ["Meta+a", "meta"]]) {
      await page.keyboard.press(combo);
      ok(`A with ${held} held does not open the float`, !(await open()));
    }
    await pressOutside();
    await page.keyboard.press("Control+a");
    const selected = await page.evaluate(() => String(window.getSelection()?.toString() || "").length);
    ok("Ctrl+A still selects the page (the shortcut did not swallow it)", selected > 0, `${selected} characters selected`);
    await page.keyboard.press("Escape");

    // And now the bare press itself, from the board with nothing focused.
    await pressOutside();
    check("still nothing focused", await activeEl(), "BODY#");
    await page.keyboard.press("a");
    ok("a bare A opens the float", await open());
    check("and it remembers itself open", await store("wm.assistantOpen"), "1");
    ok("and the header button reads on", await page.locator("#btn-assistant").evaluate((el) => el.classList.contains("is-on")));
    hotkeyShots.open = await shot("hotkey-open.png");

    // A letter that is not A must not do it, and the pre-existing Ctrl+Shift+A must still toggle.
    await page.locator("#btn-as-close").click();
    ok("the ✕ closes it", !(await open()));
    await pressOutside();
    await page.keyboard.press("b");
    ok("some other letter does not open it", !(await open()));
    await page.keyboard.press("Control+Shift+a");
    ok("Ctrl+Shift+A still toggles it open (the shortcut that was already there)", await open());
    // No press outside in between: unpinned, that would close the float before the chord got its turn.
    await page.keyboard.press("Control+Shift+a");
    ok("and still toggles it closed", !(await open()));
  }

  // ---- piece 2: the pin, and the single close path -------------------------------------------------
  let pinShots = {};
  if (wantPin) {
    console.log("\n== piece 2: the pin, and the press that dismisses ==");
    await pressOutside();
    await page.keyboard.press("a");
    ok("the float is up for the pin checks", await open());

    const pin = page.locator("#btn-as-pin");
    check("there is exactly one pin button", await pin.count(), 1);
    ok("the pin sits in the panel's header", await pin.evaluate((el) => el.parentElement?.id === "as-drag"), await pin.evaluate((el) => el.parentElement?.id));
    check("the pin is IMMEDIATELY left of the ✕", await pin.evaluate((el) => el.nextElementSibling?.id), "btn-as-close");
    ok("and the ✕ is the last thing in the header", await page.locator("#btn-as-close").evaluate((el) => el === el.parentElement?.lastElementChild));
    const boxes = await page.evaluate(() => {
      const head = document.getElementById("as-drag").getBoundingClientRect();
      const p = document.getElementById("btn-as-pin").getBoundingClientRect();
      const x = document.getElementById("btn-as-close").getBoundingClientRect();
      return { headRight: head.right, pin: { x: p.x, right: p.right, w: p.width, h: p.height, y: p.y }, close: { x: x.x, y: x.y, w: x.width, h: x.height } };
    });
    ok("the pin is drawn entirely to the left of the ✕", boxes.pin.right <= boxes.close.x, `pin ends at ${boxes.pin.right.toFixed(1)}, ✕ starts at ${boxes.close.x.toFixed(1)}`);
    ok("the two sit on the same line", Math.abs(boxes.pin.y - boxes.close.y) < 6, `pin y ${boxes.pin.y.toFixed(1)}, ✕ y ${boxes.close.y.toFixed(1)}`);
    ok("the ✕ is at the header's top-right edge", boxes.headRight - (boxes.close.x + boxes.close.w) < 40, `${(boxes.headRight - boxes.close.x - boxes.close.w).toFixed(1)}px from the header's right edge`);

    // Unpinned is the default, and it reads that way.
    check("a fresh browser has remembered no pin", await store("wm.assistantPinned"), null);
    check("the pin reads unpressed", await pin.getAttribute("aria-pressed"), "false");
    check("and unpressed in its class", await pin.evaluate((el) => el.classList.contains("is-on")), false);
    check("and the frame does not read pinned", await page.locator("#assistant").evaluate((el) => el.classList.contains("is-pinned")), false);
    const pinBoxBefore = await pin.boundingBox();
    pinShots.unpinned = await shot("pin-unpinned.png");

    // The ✕ closes it — the reading every other close has to match.
    await page.locator("#btn-as-close").click();
    const closedByX = await closeFingerprint();
    check("the ✕ leaves the float closed", closedByX.panelVisible, false);

    // Unpinned, a press outside closes it, and the reading is identical: the same stored flag, the same header state.
    await pressOutside();
    await page.keyboard.press("a");
    ok("reopened with A", await open());
    await pressOutside();
    const closedByOutside = await closeFingerprint();
    check("an outside press closes the float while it is unpinned", closedByOutside.panelVisible, false);
    check("an outside press leaves the SAME reading as the ✕ (one close path)", closedByOutside, closedByX);
    pinShots.closed = await shot("pin-closed-by-outside-press.png");

    // Pin it: pressed in the class, in aria-pressed, in the stored flag and on the frame — and the button does not move
    // or resize when it lights up, so "pressed" is a state and not a layout shift.
    await pressOutside();
    await page.keyboard.press("a");
    await pin.click();
    check("clicking the pin stores it", await store("wm.assistantPinned"), "1");
    check("the pin reads pressed", await pin.getAttribute("aria-pressed"), "true");
    check("and pressed in its class", await pin.evaluate((el) => el.classList.contains("is-on")), true);
    check("and the frame reads pinned", await page.locator("#assistant").evaluate((el) => el.classList.contains("is-pinned")), true);
    const pinBoxAfter = await pin.boundingBox();
    ok(
      "lighting up does not move or resize the button",
      pinBoxBefore && pinBoxAfter && ["x", "y", "width", "height"].every((k) => Math.abs(pinBoxBefore[k] - pinBoxAfter[k]) < 1),
      `${JSON.stringify(pinBoxBefore)} → ${JSON.stringify(pinBoxAfter)}`,
    );
    pinShots.pinned = await shot("pin-pinned.png");

    // Pinned, the same press outside leaves it up — first on the header, then on a field (both are outside the float).
    await pressOutside();
    ok("pinned: an outside press leaves the float up", await open());
    check("pinned: the open flag is untouched", await store("wm.assistantOpen"), "1");
    await page.locator("#job-cwd").click();
    ok("pinned: a press into a board field leaves the float up too", await open());
    await pressOutside();

    // Pinned survives a reload.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#btn-as-pin", { timeout: 20_000 });
    ok("pinned: the float is still up after a reload", await open());
    check("pinned: still pressed after a reload", await page.locator("#btn-as-pin").getAttribute("aria-pressed"), "true");
    check("pinned: and still stored", await store("wm.assistantPinned"), "1");
    check("pinned: and the frame still reads pinned", await page.locator("#assistant").evaluate((el) => el.classList.contains("is-pinned")), true);
    pinShots.reloaded = await shot("pin-after-reload.png");

    // The ✕ closes a pinned float too — and closing does not unpin it, which is what makes them two states.
    await page.locator("#btn-as-close").click();
    ok("the ✕ closes even a pinned float", !(await open()));
    check("and the pin is still on afterwards", await page.locator("#btn-as-pin").getAttribute("aria-pressed"), "true");
    await pressOutside();
    await page.keyboard.press("a");
    ok("it opens again still pinned", await open());
    check("still pinned after all that", await store("wm.assistantPinned"), "1");

    // Unpin: back to dismissing on a press outside, and the choice survives a reload in the other direction.
    await page.locator("#btn-as-pin").click();
    check("clicking the pin again unpins it", await page.locator("#btn-as-pin").getAttribute("aria-pressed"), "false");
    check("and that is stored", await store("wm.assistantPinned"), "0");
    await pressOutside();
    ok("unpinned again: an outside press closes it", !(await open()));
    await page.reload({ waitUntil: "domcontentloaded" });
    // Attached, not visible: the reload restores the UNPINNED state, so the button is inside a closed float.
    await page.waitForSelector("#btn-as-pin", { state: "attached", timeout: 20_000 });
    check("unpinned survives a reload", await page.locator("#btn-as-pin").getAttribute("aria-pressed"), "false");
    check("and it is still stored as unpinned", await store("wm.assistantPinned"), "0");
    check("so the float is closed on the reloaded page", await open(), false);
    pinShots.afterUnpin = await shot("pin-unpinned-after-reload.png");
  }

  check("no page errors", pageErrors, []);
  await browser.close();
  return { hotkeyShots, pinShots };
}

// ---- the phases ----------------------------------------------------------------------------------
let shots = null;
try {
  console.log("== the sandbox ==");
  note(`temp root ${dir}`);
  note(`piece ${PIECE} · panel ${base} (live board 7331 untouched: ${liveBefore} listener(s) before)`);
  await startPanel();
  const discovered = await waitFor(async () => {
    const s = await state();
    return Boolean(s.projects?.some((p) => p.name === PROJECT));
  }, { timeoutMs: 45_000, what: "the sandbox project to be scanned as a row" });
  ok("the sandbox panel is the instance that answered", discovered, "the sandbox project is in /api/state");
  ok("the sandbox is bound on its own port", listenersOn(port) >= 1, `${listenersOn(port)} listener(s) on :${port}`);
  check("the live board's listener count is unchanged by this run", listenersOn(7331), liveBefore);

  console.log("\n== what the sandbox serves ==");
  const served = await fetch(`${base}/assistant.js`);
  const js = await served.text();
  ok("GET /assistant.js carries the new hotkey", js.includes("inTextField") && js.includes("!e.shiftKey"), `${js.length} bytes`);
  if (wantPin) ok("and the pin", js.includes('btn-as-pin') && js.includes("wm.assistantPinned") && js.includes("onOutsidePress"));
  const html = await (await fetch(base)).text();
  if (wantPin) ok("GET / carries the pin button in the header", html.includes('id="btn-as-pin"'));
  check("served with no-store, so a reload is enough (no restart, no new route)", served.headers.get("cache-control"), "no-store");
  note("these two group(s) are DRIVEN through a real panel process; the browser half below is a real browser.");

  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN  the client half of this change was not exercised in a browser.");
    note("re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=C:/ProjectDevelopment/heroes-js node tools/verify-assistant-hotkey-pin.mjs");
    failures += 1;
  } else {
    shots = await browserPhase(pw);
    const files = Object.values({ ...(shots?.hotkeyShots || {}), ...(shots?.pinShots || {}) }).filter(Boolean);
    if (files.length) note(`screenshots: ${files.join(" · ")}`);
  }

  console.log("\n== summary ==");
  console.log(`${checks} checks, ${failures} failed  (piece: ${PIECE})`);
  console.log("\nWHAT WAS DRIVEN: a real panel process booted on its own port over its own PANEL_CONFIG and HERMES_HOME");
  console.log("(its own project scanned, its own files served, the live 7331 listener count identical across the run), and");
  console.log("headless Chromium over that panel — every line of the acceptance: the bare A, the four kinds of field, the");
  console.log("modifiers (with Ctrl+A still selecting), the pin's placement and pressed/unpressed reading, the outside press");
  console.log("pinned and unpinned, the two reloads, and the ✕. No run is ever spawned: the config points the Runs API at a");
  console.log("dead port and the assistant is off, so the live gateway is not reachable from this test at all.");
  console.log("WHAT WAS INSPECTED, NOT DRIVEN: nothing in the browser half — but that the outside press and the ✕ share one");
  console.log("close path is proved by comparing their observable result, not by reading the source.");
  if (PIECE === "both") {
    if (!failures) console.log("ASSISTANT-HOTKEY-PIN-OK");
  } else {
    console.log(`PARTIAL-PIECE-RUN: only the ${PIECE} checks ran — this is not the full proof of both behaviours.`);
    if (!failures) console.log(`ASSISTANT-HOTKEY-PIN-PARTIAL-OK (${PIECE})`);
  }
} catch (err) {
  failures += 1;
  console.log(`\nFAIL  the run threw: ${String((err && err.stack) || err)}`);
  if (panelLog.length) console.log(`--- panel log (tail)\n${panelLog.slice(-25).join("\n")}`);
} finally {
  // A browser left open keeps node's loop alive: the run would print everything and then never exit.
  if (liveBrowser) {
    try {
      await liveBrowser.close();
    } catch {
      /* already gone */
    }
    liveBrowser = null;
  }
  if (process.env.VERIFY_KEEP === "1") {
    console.log(`VERIFY_KEEP=1 — leaving ${dir} in place`);
  } else {
    await stopPanel();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch (e) {
      console.log(`      (could not remove ${dir}: ${String((e && e.message) || e)})`);
    }
  }
  clearTimeout(watchdog);
}
process.exitCode = failures ? 1 : 0;
