// The assistant float's two tab rows, proved by driving a panel of its own — and a real browser over it.
//
//   node tools/verify-assistant-subtabs.mjs
//
// The float used to be one strip of tabs with "Chat" first and "Settings" last. It is now two rows: the float's own
// row (the assistant sessions, then the lists that are the assistant's) and, under it, the session's own row holding
// Chat and Settings. `public/index.html` carries both rows and the pane nesting, `public/assistant.js` the one
// {assistant, subTab} record behind them, `public/style.css` the row and the pass-through panes. What is driven:
//
//   1. the top row is six buttons — "Assistant #1" first, no Settings among them — and the second row is a separate
//      row BELOW it (measured, not read from the markup) holding Chat then Settings;
//   2. Settings is the second row's second tab and nothing else: pressing it shows #as-settings and hides #as-chat,
//      with #as-settings inside the assistant's own pane rather than beside it, and the pane still renders its
//      content (the "How it behaves" group);
//   3. the record is exactly {"assistant":"assistant-1","subTab":"settings"} in localStorage, and the old
//      wm.assistantTab key is never written;
//   4. RELOAD: the reader lands back on Settings — the sub-tab is still on, the settings pane still showing, the
//      chat pane still hidden, the second row still there. This is the check the change exists for;
//   5. Chat switches back to the thread, and the card still fills the float: #as-chat is as tall as the body that
//      holds it, so the two pass-through panes cost the transcript nothing;
//   6. every existing tab still works (Alerts, Watches, Messages, Scratchpad, Charter each show their pane), the
//      second row goes away with the session and comes back on the sub-tab it was left on, the tab badges are still
//      in the top row, and Ctrl+, still opens the board's own Settings panel over the float;
//   7. no page errors throughout.
//
// Everything happens in a sandbox of its own: a throwaway repo, HERMES_HOME, PANEL_CONFIG with its own port, its own
// logs and job store. No gateway is needed (nothing here spawns a run: `assistant.enabled` is false and `apiServer`
// points at a dead port on purpose), and the live panel on 7331 is not touched — the test records its listener count
// before and after its own boot to show that.
//
// The browser half needs a Playwright install; point PANEL_PLAYWRIGHT_ROOT at one (a directory holding
// node_modules/playwright, or the package itself). Without one the script says BROWSER-HALF-NOT-RUN and exits 2
// rather than passing on a half that never ran.
import { execSync, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright } from "./browser.mjs";
import { freePort, ROOT } from "./panel-testkit.mjs";

// A hang here would otherwise be silent (a browser left open keeps node's loop alive and the log never lands).
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
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
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
const listenersOn = (port) => {
  let out = "";
  try {
    out = execSync("netstat -ano", { encoding: "utf8", windowsHide: true });
  } catch (e) {
    out = String((e && e.stdout) || "");
  }
  return out.split(/\r?\n/).filter((l) => l.includes(`:${port} `) && l.includes("LISTENING")).length;
};

// ---- the sandbox ---------------------------------------------------------------------------------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-subtabs-"));
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
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${String((e && e.message) || e)}`));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`);
  });

  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#assistant", { state: "attached", timeout: 20_000 });
  await page.waitForSelector("#job-prompt", { state: "visible", timeout: 20_000 });

  const store = (key) => page.evaluate((k) => localStorage.getItem(k), key);
  const visible = (sel) => page.locator(sel).isVisible();
  const rect = (sel) => page.locator(sel).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
  });
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
  // innerText, not textContent: the spawn count beside the alert count is hidden unless it has something to say, and a
  // label read by textContent shows it anyway ("Alerts 00").
  const rows = () => page.$$eval("#as-tabs button", (els) =>
    els.map((el) => ({ tab: el.dataset.asTab, label: el.innerText.trim(), title: el.getAttribute("title") || "", on: el.classList.contains("is-on") })));
  const subRows = () => page.$$eval("#as-subtabs button", (els) =>
    els.map((el) => ({ sub: el.dataset.asSubtab, label: el.innerText.trim(), title: el.getAttribute("title") || "", on: el.classList.contains("is-on") })));
  const view = () => page.evaluate(() => localStorage.getItem("wm.assistantView"));

  // ---- open the float ---------------------------------------------------------------------------
  console.log("\n== the float, open, on a fresh browser ==");
  await page.locator("#btn-assistant").click();
  await page.waitForSelector("#assistant", { state: "visible" });
  ok("the float opens", await visible("#assistant"));
  check("nothing has been recorded about the view yet", await view(), null);

  const top = await rows();
  check("the float's own row", top.map((t) => t.tab), ["assistant-1", "alerts", "watches", "messages", "pad", "charter"]);
  check("…labelled", top.map((t) => t.label), ["Assistant #1", "Alerts 0", "Watches 0", "Messages", "Scratchpad", "Charter"]);
  ok("the first tab is the assistant session, named Assistant #1", top[0].tab === "assistant-1" && top[0].label === "Assistant #1");
  ok("its tooltip says what it is and where the sub-tabs are", /normal agent card/i.test(top[0].title) && /row under this one/i.test(top[0].title), top[0].title);
  ok("Settings is NOT a tab of the float's own row", !top.some((t) => t.tab === "settings" || t.label === "Settings"));
  ok("and it is the tab on screen", top.filter((t) => t.on).map((t) => t.tab).join() === "assistant-1", JSON.stringify(top.filter((t) => t.on)));

  const sub = await subRows();
  check("the session's own row", sub.map((s) => s.sub), ["chat", "settings"]);
  check("…labelled", sub.map((s) => s.label), ["Chat", "Settings"]);
  ok("Chat is the sub-tab on screen", sub.filter((s) => s.on).map((s) => s.sub).join() === "chat", JSON.stringify(sub.filter((s) => s.on)));
  ok("the second row is up with the session", await visible("#as-subtabs"));

  // It is a ROW under the other one: a real box, below the float's tabs, above the body.
  const tabsBox = await rect("#as-tabs");
  const subBox = await rect("#as-subtabs");
  const bodyBox = await rect(".as-body");
  ok("the session's row is drawn below the float's tabs", subBox.y >= tabsBox.bottom - 1, `tabs end ${tabsBox.bottom.toFixed(1)}, row starts ${subBox.y.toFixed(1)}`);
  ok("…and above the pane it belongs to", subBox.bottom <= bodyBox.y + 1, `row ends ${subBox.bottom.toFixed(1)}, body starts ${bodyBox.y.toFixed(1)}`);
  ok("…with room of its own (not a wrapper collapsed to nothing)", subBox.h >= 14 && subBox.w > 40, `${subBox.w.toFixed(0)}×${subBox.h.toFixed(0)}`);

  // Chat is the thread, and it still fills the float: the two pass-through panes cost it nothing.
  ok("Chat shows the assistant's pane", await visible("#as-assistant-1"));
  check("…with only Chat's half of it showing", await page.evaluate(() => ({
    chatHidden: document.getElementById("as-chat").classList.contains("hidden"),
    settingsHidden: document.getElementById("as-settings").classList.contains("hidden"),
  })), { chatHidden: false, settingsHidden: true });
  const chatH = (await rect("#as-chat")).h;
  ok("the chat pane fills the body it sits in (the nested panes are pass-through)", Math.abs(chatH - bodyBox.h) <= 1, `chat ${chatH.toFixed(1)} vs body ${bodyBox.h.toFixed(1)}`);
  ok("the session's pane has no padding of its own to trim the card", await page.locator("#as-assistant-1").evaluate((el) => getComputedStyle(el).paddingLeft), "0px");
  await shot("subtabs-chat.png");

  // ---- Settings, the session's second tab ---------------------------------------------------------
  console.log("\n== Settings is the session's second tab ==");
  await page.click('#as-subtabs [data-as-subtab="settings"]');
  await page.waitForSelector("#as-settings:not(.hidden)");
  ok("the second row's Settings shows the settings pane", await visible("#as-settings"));
  ok("…and puts Chat away", !(await visible("#as-chat")));
  ok("…without leaving the session: its pane is still the one showing", await visible("#as-assistant-1"));
  ok("…and the row is still there (it is the session's)", await visible("#as-subtabs"));
  check("the record is {assistant, subTab}", await view(), '{"assistant":"assistant-1","subTab":"settings"}');
  check("the old single-tab key is never written", await store("wm.assistantTab"), null);
  const nested = await page.locator("#as-settings").evaluate((el) => ({
    parent: el.closest('[data-pane="assistant-1"]')?.id || null,
    sub: el.dataset.subpane || null,
  }));
  ok("Settings sits INSIDE the assistant's pane", nested.parent === "as-assistant-1", JSON.stringify(nested));
  // The content is the pane the Settings tab always drew: a rendered group list, not an empty box.
  const groups = await page.$$eval("#as-settings h4", (els) => els.map((el) => el.textContent.trim()));
  ok("the pane renders its own content, unchanged", groups.length >= 2 && groups.includes("How it behaves"), JSON.stringify(groups));
  ok("…with its controls live", (await page.locator("#as-settings [data-as-set]").count()) > 0);
  await shot("subtabs-settings.png");

  // ---- RELOAD: the sub-tab survives ---------------------------------------------------------------
  console.log("\n== a reload lands where the reader left it ==");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#assistant", { state: "attached", timeout: 20_000 });
  // The float is remembered open, so the reload restores it by itself — a press on the header button here would
  // close it, which is exactly the reading this section must not produce.
  await page.waitForSelector("#assistant", { state: "visible", timeout: 20_000 });
  await page.waitForSelector("#as-assistant-1:not(.hidden)");
  ok("the float is open again", await visible("#assistant"));
  const afterReload = await subRows();
  ok("Settings is still the sub-tab on screen", afterReload.filter((s) => s.on).map((s) => s.sub).join() === "settings", JSON.stringify(afterReload.filter((s) => s.on)));
  ok("…the settings pane is the one showing", await visible("#as-settings"));
  ok("…Chat is still hidden", !(await visible("#as-chat")));
  ok("…the session's row is still up", await visible("#as-subtabs"));
  ok("…and Assistant #1 is still the tab above it", (await rows()).filter((t) => t.on).map((t) => t.tab).join() === "assistant-1");
  await shot("subtabs-after-reload.png");

  // ---- Chat, and the card still fills the float ---------------------------------------------------
  console.log("\n== back to Chat ==");
  await page.click('#as-subtabs [data-as-subtab="chat"]');
  await page.waitForSelector("#as-chat:not(.hidden)");
  ok("Chat shows the thread again", await visible("#as-chat"));
  ok("…and puts Settings away", !(await visible("#as-settings")));
  check("the record follows the press", await view(), '{"assistant":"assistant-1","subTab":"chat"}');
  ok("the intro (or the card) is what Chat is showing, not an empty box", (await page.locator("#as-chat").evaluate((el) => el.textContent.trim().length)) > 0);
  const chatAfter = (await rect("#as-chat")).h;
  const bodyAfter = (await rect(".as-body")).h;
  ok("the chat pane still fills the body", Math.abs(chatAfter - bodyAfter) <= 1, `chat ${chatAfter.toFixed(1)} vs body ${bodyAfter.toFixed(1)}`);

  // ---- every other tab still works, and the row goes with the session -----------------------------
  console.log("\n== every other tab, and the row that goes with the session ==");
  for (const tab of ["alerts", "watches", "messages", "pad", "charter"]) {
    await page.click(`#as-tabs [data-as-tab="${tab}"]`);
    await page.waitForSelector(`#as-${tab}:not(.hidden)`);
    ok(`${tab}: its pane is the one showing`, await visible(`#as-${tab}`));
    ok(`${tab}: the session's row is gone with the session`, !(await visible("#as-subtabs")));
    ok(`${tab}: its tab is marked`, (await rows()).filter((t) => t.on).map((t) => t.tab).join() === tab);
    check(`${tab}: and it is recorded as the view, sub-tab kept`, JSON.parse(await view()), { assistant: tab, subTab: "chat" });
  }
  await page.click('#as-tabs [data-as-tab="assistant-1"]');
  await page.waitForSelector("#as-subtabs");
  ok("back on Assistant #1, the session's row returns", await visible("#as-subtabs"));
  ok("…on the sub-tab it was left on", (await subRows()).filter((s) => s.on).map((s) => s.sub).join() === "chat");
  ok("…and Chat is showing", await visible("#as-chat"));

  // ---- the badges, and Ctrl+, ----------------------------------------------------------------
  console.log("\n== the badges and the shortcut the float shares with the board ==");
  const alertsTab = (await rows()).find((t) => t.tab === "alerts");
  ok("the Alerts badge is still in the top row's own button", /^Alerts\s*0/.test(alertsTab.label), alertsTab.label);
  check("…and reads the count", await page.locator("#as-alert-n").textContent(), "0");
  check("…beside the watches count", await page.locator("#as-watch-n").textContent(), "0");
  const spawnHidden = await page.locator("#as-spawn-n").evaluate((el) => el.hidden);
  ok("the spawn badge stays hidden with no spawn cards", spawnHidden);

  // Ctrl+, is the board's own Settings panel — the global one, not the session's sub-tab.
  await page.keyboard.press("Control+,");
  await page.waitForSelector("#settings:not(.hidden)");
  ok("Ctrl+, still opens the board's Settings panel", await visible("#settings"));
  ok("…over the float, without changing its sub-tab", (await subRows()).filter((s) => s.on).map((s) => s.sub).join() === "chat");
  check("…and the float's record is untouched", await view(), '{"assistant":"assistant-1","subTab":"chat"}');
  await page.keyboard.press("Escape");
  await waitFor(async () => !(await visible("#settings")), { timeoutMs: 5_000, what: "the board's Settings panel to close" });
  ok("Esc closes it again", !(await visible("#settings")));

  check("no page errors", pageErrors, []);
  await browser.close();
}

// ---- the phases ----------------------------------------------------------------------------------
try {
  console.log("== the sandbox ==");
  note(`temp root ${dir}`);
  note(`panel ${base} (live board 7331 untouched: ${liveBefore} listener(s) before)`);
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
  ok("GET /assistant.js carries the two-row record", js.includes("wm.assistantView") && js.includes("paintAssistantTabs") && js.includes("SUBTABS"));
  ok("…and no longer sets the single tab", !/state\.assistantTab\s*=/.test(js));
  const html = await (await fetch(base)).text();
  ok("GET / carries the session's row", html.includes('id="as-subtabs"') && html.includes('data-as-subtab="settings"'));
  ok("…the renamed tab", html.includes('data-as-tab="assistant-1"') && html.includes(">Assistant #1<"));
  ok("…and the nested panes", /data-pane="assistant-1"[\s\S]*data-subpane="chat"[\s\S]*data-subpane="settings"/.test(html));
  check("served with no-store, so a reload is enough (no restart, no new route)", served.headers.get("cache-control"), "no-store");
  note("the sandbox and both served files are DRIVEN; the browser half below is a real browser over them.");

  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN  the client half of this change was not exercised in a browser.");
    note("re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=C:/ProjectDevelopment/heroes-js node tools/verify-assistant-subtabs.mjs");
    failures += 1;
  } else {
    await browserPhase(pw);
  }

  console.log("\n== summary ==");
  console.log(`${checks} checks, ${failures} failed`);
  console.log("\nWHAT WAS DRIVEN: a real panel process booted on its own port over its own PANEL_CONFIG and HERMES_HOME (its");
  console.log("own project scanned, its own files served, the live 7331 listener count identical across the run), and headless");
  console.log("Chromium over that panel — the two rows measured as boxes, Settings as the session's second tab, the record in");
  console.log("localStorage, the reload that lands back on Settings, the card still filling the float, every other tab, the");
  console.log("badges and Ctrl+,");
  if (!failures) console.log("ASSISTANT-SUBTABS-OK");
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
