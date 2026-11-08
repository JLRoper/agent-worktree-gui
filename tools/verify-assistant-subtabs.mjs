// The assistant float's two tab rows, proved by driving a panel of its own — and a real browser over it.
//
//   node tools/verify-assistant-subtabs.mjs
//
// The float used to be one strip of tabs. It is now two rows: the float's own row (the assistant sessions, then the
// two panes that belong to the PANEL — the Role library and the Watchdog) and, under it, everything that belongs to
// ONE session. Alerts, watches, messages and the pad used to be the float's own tabs beside the sessions; they are
// the session's own sub-tabs now, and each pane is filled for the assistant whose tab holds it. `public/index.html`
// carries both rows and the pane nesting, `public/assistant.js` the one {assistant, subTab} record behind them,
// `public/style.css` the row and the pass-through panes. What is driven:
//
//   1. the top row is four buttons — "Assistant #1" first, then Role, Watchdog and Bridge, no Settings and none of
//      the four lists — and the second row is a separate row BELOW it (measured, not read from the markup) holding eight:
//      Chat, Settings, Queue, Worktrees, Alerts, Watches, Messages, Notes;
//   2. Settings is the second row's second tab and nothing else: pressing it shows #as-settings and hides #as-chat,
//      with #as-settings inside the assistant's own pane rather than beside it, and the pane still renders its
//      content (the "How it behaves" group);
//   3. the record is exactly {"assistant":"assistant-1","subTab":"settings"} in localStorage, and the old
//      wm.assistantTab key is never written — and its old values land on the matching sub-tab of #1;
//   4. RELOAD: the reader lands back on Settings — the sub-tab is still on, the settings pane still showing, the
//      chat pane still hidden, the second row still there. This is the check the change exists for;
//   5. Chat switches back to the thread, and the card still fills the float: #as-chat is as tall as the body that
//      holds it, so the pass-through panes cost the transcript nothing;
//   6. the four moved lists ARE inside #1's own pane and work from its row (alerts, watches, messages, pad), the
//      second row goes away with a panel-wide pane (Role) and comes back on the sub-tab it was left on, the two
//      counts live on the moved list pills, and Ctrl+, still opens the board's own Settings panel over the float;
//   7. the Role tab: the ROLE editor's selector on the role a record runs, its four fields read whole, and no
//      assistant copy written from this pane
//      (with no control that changes that role - Settings owns that), "New assistant from this role" adding
//      Assistant #2 to the top row with its own pane - its Settings with NO
//      per-assistant rules block (that block is gone) and its Notes tab keeping Notes, Standing rules and Journal,
//      where a rule added lands on #2's own record — and, the claim this feature exists for, #2's saved edit landing
//      in its own file while #1's text and #1's charter file stay byte for byte what they were;
//   8. a SECOND, seeded panel with #1, #2 and #3: each assistant's four panes hold ITS OWN pad, watches, alerts and
//      messages (and none of another's), All widens a pane to everything and only that pane, and the counts on the
//      sub-tabs are the selected assistant's;
//   9. no page errors throughout.
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
  // The row carries the sessions and the panel's TWO panes: Role is a library every assistant picks from, and the
  // watchdog is the panel's sentry. Alerts, Watches, Messages and Notes are NOT here — they moved inside the
  // assistant, onto the row under this one.
  check("the float's own row", top.map((t) => t.tab), ["assistant-1", "role", "watchdog", "bridge"]);
  check("…labelled", top.map((t) => t.label), ["Assistant #1", "Role", "Watchdog", "Bridge"]);
  ok(
    "no top-level Alerts, Watches, Messages or Notes tab is left",
    !top.some((t) => ["alerts", "watches", "messages", "pad"].includes(t.tab)),
    JSON.stringify(top.map((t) => t.tab)),
  );
  ok("the Charter tab is the Role tab now", !top.some((t) => t.tab === "charter") && top.some((t) => t.tab === "role" && /role library/i.test(t.title)));
  ok("the first tab is the assistant session, named Assistant #1", top[0].tab === "assistant-1" && top[0].label === "Assistant #1");
  ok("its tooltip says what it is and where the sub-tabs are", /real agent thread of its own/i.test(top[0].title) && /running the role it picked/i.test(top[0].title), top[0].title);
  ok("Settings is NOT a tab of the float's own row", !top.some((t) => t.tab === "settings" || t.label === "Settings"));
  ok("and it is the tab on screen", top.filter((t) => t.on).map((t) => t.tab).join() === "assistant-1", JSON.stringify(top.filter((t) => t.on)));

  const sub = await subRows();
  // Eight sub-tabs: the session's card, settings, its queue and trees, and the four lists that used to be the float's.
  check("the session's own row", sub.map((s) => s.sub), ["chat", "settings", "queue", "worktrees", "alerts", "watches", "messages", "pad"]);
  check("…labelled", sub.map((s) => s.label), ["Chat", "Settings", "Queue", "Worktrees", "Alerts 0", "Watches 0", "Messages", "Notes"]);
  ok("Chat is the sub-tab on screen", sub.filter((s) => s.on).map((s) => s.sub).join() === "chat", JSON.stringify(sub.filter((s) => s.on)));
  ok("the second row is up with the session", await visible("#as-subtabs"));
  // innerText, not textContent: the spawn count beside the alert count is hidden unless it has something to say.
  ok("the alert count is on the Alerts sub-tab", sub[4].label === "Alerts 0", sub[4].label);
  ok("…and the watch count on Watches", sub[5].label === "Watches 0", sub[5].label);

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

  // ---- every other pane still works, and the row goes with the session ----------------------------
  console.log("\n== the four moved lists inside #1, and the panel's own pane ==");
  for (const subTab of ["alerts", "watches", "messages", "pad"]) {
    await page.click(`#as-subtabs [data-as-subtab="${subTab}"]`);
    await page.waitForSelector(`#as-${subTab}:not(.hidden)`);
    ok(`${subTab}: its pane is the one showing`, await visible(`#as-${subTab}`));
    ok(`${subTab}: it is still INSIDE Assistant #1's pane`, (await page.locator(`#as-${subTab}`).evaluate((el) => el.closest('[data-pane="assistant-1"]')?.id || null)) === "as-assistant-1");
    ok(`${subTab}: the session's row stays up (it is the session's own list)`, await visible("#as-subtabs"));
    ok(`${subTab}: its pill is marked`, (await subRows()).filter((s) => s.on).map((s) => s.sub).join() === subTab);
    ok(`${subTab}: and the group tab above it is still the session`, (await rows()).filter((t) => t.on).map((t) => t.tab).join() === "assistant-1");
    check(`${subTab}: recorded as #1's sub-tab`, JSON.parse(await view()), { assistant: "assistant-1", subTab });
  }
  await page.click('#as-tabs [data-as-tab="role"]');
  await page.waitForSelector("#as-role:not(.hidden)");
  ok("role: the panel's own pane is the one showing", await visible("#as-role"));
  ok("role: the session's row is gone with the session", !(await visible("#as-subtabs")));
  ok("role: its tab is marked", (await rows()).filter((t) => t.on).map((t) => t.tab).join() === "role");
  await page.click('#as-tabs [data-as-tab="assistant-1"]');
  await page.waitForSelector("#as-subtabs");
  ok("back on Assistant #1, the session's row returns", await visible("#as-subtabs"));
  ok("…on the sub-tab it was left on", (await subRows()).filter((s) => s.on).map((s) => s.sub).join() === "pad");
  ok("…and that pane is showing", await visible("#as-pad"));

  // ---- the Role tab, and Assistant #2 made from it -------------------------------------------------
  // The item this change was asked for, driven the way a reader does it: open Role, see the job title and the charter
  // #1 actually carries, make a second assistant from the same role, and prove its edit does not move #1's text.
  console.log("\n== the Role tab, and Assistant #2 from the role ==");
  await page.click('#as-tabs [data-as-tab="role"]');
  await page.waitForSelector("#as-role:not(.hidden)");
  ok("the Role pane is the one showing", await visible("#as-role"));
  ok("…and the session's row is gone with the session", !(await visible("#as-subtabs")));
  check("the pane carries one role selector", await page.locator("#as-role-pick").count(), 1);
  check("…and no second control that assigns a role from here", await page.locator("#as-roletarget, [data-as-roletarget], #btn-as-role-adopt").count(), 0);
  const roleNow = await (await fetch(`${base}/api/assistant/role?assistantId=assistant-1`)).json();
  check("…with the role the record runs selected", await page.locator("#as-role-pick").inputValue(), roleNow.role.id);
  await page.waitForFunction(() => !document.querySelector("#as-role-name").disabled, null, { timeout: 10_000 });
  const roleField = (id) => page.locator(id).inputValue();
  const roleOwn = (await (await fetch(`${base}/api/assistant/role/charter?roleId=${encodeURIComponent(roleNow.role.id)}`)).json());
  check("the name box holds the ROLE's name", await roleField("#as-role-name"), roleOwn.role.name);
  check("…its description box the role's remit", await roleField("#as-role-description"), roleOwn.role.description);
  check("…and the charter box the role's own text, not an assistant's copy", await page.locator("#as-role-text").evaluate((el) => el.value), roleOwn.text);
  ok("…which is the seeded manager charter", String(roleOwn.text).includes("## Role and remit"), `${String(roleOwn.text).length} chars`);
  ok(
    "…and the pane names no assistant at all",
    !/Assistant #1|this assistant|own copy|read-only preview/i.test(await page.locator("#as-role").innerText()),
    (await page.locator("#as-role").innerText()).slice(0, 120),
  );

  await page.click("#btn-as-new-assistant");
  ok(
    "pressing it adds Assistant #2 to the top row",
    await waitFor(async () => (await rows()).some((t) => t.tab === "assistant-2"), { timeoutMs: 10_000, what: "Assistant #2's tab" }),
  );
  const afterCreate = await rows();
  check("…at the head, beside Assistant #1", afterCreate.map((t) => t.tab).slice(0, 2), ["assistant-1", "assistant-2"]);
  check("…labelled", afterCreate.filter((t) => t.tab === "assistant-2").map((t) => t.label), ["Assistant #2"]);
  check("…and it is the tab on screen", JSON.parse(await view()), { assistant: "assistant-2", subTab: "chat" });
  ok("…with its own pane and its own intro", await visible("#as-assistant-2"));
  ok("…saying which assistant it is", /Assistant #2/.test(await page.locator("#as-chat-2").innerText()));
  ok("…and the session's row is back for it", await visible("#as-subtabs"));

  // Its own rules are on its NOTES tab now; the Settings tab's second rules block is gone.
  await page.click('#as-subtabs [data-as-subtab="settings"]');
  await page.waitForSelector("#as-settings-2:not(.hidden)");
  ok(
    "Assistant #2's Settings carries no rules list of its own any more",
    (await page.locator("#as-settings-2 [data-as-addrule], #as-settings-2 #as-rules-text-2").count()) === 0,
    "the per-assistant rules block is gone from the bottom of the Settings tab",
  );

  await page.click('#as-subtabs [data-as-subtab="pad"]');
  await page.waitForSelector("#as-pad-2:not(.hidden)");
  ok(
    "its Notes tab keeps the three sections",
    await waitFor(async () => /Notes/i.test(await page.locator("#as-pad-2").innerText()) && /Standing rules/i.test(await page.locator("#as-pad-2").innerText()) && /Journal/i.test(await page.locator("#as-pad-2").innerText()), {
      timeoutMs: 10_000,
      what: "#2's Notes pane to paint its three sections",
    }),
  );
  await page.fill("#as-rule-text-2", "ask before writing to a tree another agent owns");
  await page.click('[data-as-padrule="assistant-2"]');
  ok(
    "a rule added there lands on Assistant #2's own record",
    await waitFor(
      async () => (await page.locator("#as-pad-2").innerText()).includes("another agent owns"),
      { timeoutMs: 10_000, what: "the rule to appear in #2's Notes pane" },
    ),
  );
  const both = await (await fetch(`${base}/api/assistant`)).json();
  check("…and Assistant #1's rules are untouched", both.assistants.find((a) => a.id === "assistant-1").rules.map((r) => r.text), []);
  check("…while #2 has the one", both.assistants.find((a) => a.id === "assistant-2").rules.map((r) => r.text), ["ask before writing to a tree another agent owns"]);

  // The Role tab is a ROLE editor now: #2's Settings' Open Role tab press points it at the ROLE #2 runs, and the
  // pane holds that role's own four fields. No assistant's copy is edited from this tab, so the thing proved here is
  // the pointing and the subject; the per-assistant copies are store-level contracts in test/roles.test.js.
  await page.click('#as-subtabs [data-as-subtab="settings"]');
  await page.waitForSelector("#as-settings-2:not(.hidden)");
  const c1Before = (await (await fetch(`${base}/api/assistant/charter`)).json()).charter.text;
  await page.click('[data-as-roleopen="assistant-2"]');
  await page.waitForSelector("#as-role:not(.hidden)");
  const roleOf2 = await (await fetch(`${base}/api/assistant/role?assistantId=assistant-2`)).json();
  const roleDoc2 = await (await fetch(`${base}/api/assistant/role/charter?roleId=${encodeURIComponent(roleOf2.role.id)}`)).json();
  ok(
    "the press lands on the ROLE #2 runs",
    await waitFor(async () => (await page.locator("#as-role-pick").inputValue()) === roleOf2.role.id, { timeoutMs: 10_000, what: "#2's role in the editor" }),
    roleOf2.role.id,
  );
  ok(
    "…with that role's own four fields in the boxes",
    await waitFor(
      async () =>
        (await page.locator("#as-role-name").inputValue()) === roleDoc2.role.name &&
        (await page.locator("#as-role-description").inputValue()) === roleDoc2.role.description &&
        (await page.locator("#as-role-text").evaluate((el) => el.value)) === roleDoc2.text,
      { timeoutMs: 10_000, what: "the role's fields" },
    ),
  );
  ok("…and the pane names no assistant at all", !/Assistant #2|own copy|this assistant/i.test(await page.locator("#as-role").innerText()));
  const c1After = (await (await fetch(`${base}/api/assistant/charter`)).json()).charter.text;
  ok("#1's charter did not move — this tab writes no assistant copy", c1After === c1Before, `${c1Before.length} chars`);

  // Back to #1's Chat, where the rest of the run expects to be. The sub-tab record is ONE record for the float, so
  // the reader arrives on the sub-tab #2 was left on (Notes): press Chat, then wait for the pane.
  await page.click('#as-tabs [data-as-tab="assistant-1"]');
  await page.waitForSelector("#as-subtabs:not([hidden])");
  await page.click('#as-subtabs [data-as-subtab="chat"]');
  await page.waitForSelector("#as-chat:not(.hidden)");

  // ---- the badges, and Ctrl+, ----------------------------------------------------------------
  console.log("\n== the badges and the shortcut the float shares with the board ==");
  const alertsPill = (await subRows()).find((s) => s.sub === "alerts");
  ok("the Alerts count is on the Alerts sub-tab, for the assistant above it", /^Alerts\s*0/.test(alertsPill.label), alertsPill.label);
  check("…and reads the count", await page.locator("#as-alert-n").textContent(), "0");
  check("…beside the watches count", await page.locator("#as-watch-n").textContent(), "0");
  ok(
    "…and neither count is up in the float's own row any more",
    (await page.locator("#as-tabs #as-alert-n").count()) === 0 && (await page.locator("#as-tabs #as-watch-n").count()) === 0,
  );
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

// ---- the four moved lists, proved on #2 AND #3 ---------------------------------------------------
//
// A SECOND panel, seeded before it boots, so none of this is a fixture painted into the page: three assistants, alerts
// and watches stamped for each of them, a job on each assistant's own thread (what the Messages pane reads), and
// #1's notes. #2's and #3's pads are then written through the panel's own route, so each pane has a line of its own to
// show. The browser walks BOTH assistants' four lists — and the All toggle inside a pane, which must widen that pane
// and nothing else.
async function movedPanesPhase(pw) {
  const dir2 = mkdtempSync(path.join(tmpdir(), "wtgui-subtabs-moved-"));
  const root2 = path.join(dir2, "scan-root");
  const repo2 = path.join(root2, "moved-repo");
  const home2 = path.join(dir2, "hermes-home");
  const cfg2 = path.join(dir2, "panel");
  const logs2 = path.join(cfg2, "logs");
  for (const d of [repo2, home2, cfg2, logs2]) mkdirSync(d, { recursive: true });
  git(repo2, ["init", "-q", "-b", "main"]);
  writeFileSync(path.join(repo2, "README.md"), "# moved-panes repo\n", "utf8");
  git(repo2, ["add", "."]);
  git(repo2, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "first"]);

  const now = Date.now();
  const before = (min) => new Date(now - min * 60_000).toISOString();
  const alert = (id, owner, title, min) => ({
    id,
    key: `leftover|${id}`,
    rule: "leftover",
    severity: "warn",
    level: "alert",
    title,
    detail: "",
    at: before(min),
    status: "open",
    assistantId: owner,
  });
  const alerts = [
    alert("al-one", "assistant-1", "ALERT-ONE", 30),
    alert("al-two", "assistant-2", "ALERT-TWO", 20),
    alert("al-two-b", "assistant-2", "ALERT-TWO-B", 10),
    alert("al-three", "assistant-3", "ALERT-THREE", 5),
  ];
  const watch = (id, owner, title) => ({ id, thread: "wtgui-seed-worker", title, at: before(40), by: "reader", state: "watching", assistantId: owner });
  const watches = [
    watch("w-one", "assistant-1", "WATCH-ONE"),
    watch("w-two", "assistant-2", "WATCH-TWO"),
    watch("w-two-b", "assistant-2", "WATCH-TWO-B"),
    watch("w-three", "assistant-3", "WATCH-THREE"),
  ];
  const assistants = [1, 2, 3].map((n) => ({
    id: `assistant-${n}`,
    name: `Assistant #${n}`,
    roleId: "agent-manager",
    threadId: n === 1 ? "panel-assistant" : `panel-assistant-${n}`,
    rules: [],
    createdAt: before(90 - n),
  }));
  writeFileSync(
    path.join(logs2, "assistants.json"),
    JSON.stringify({ version: 1, assistants }, null, 1),
    "utf8",
  );
  writeFileSync(
    path.join(logs2, "assistant.json"),
    JSON.stringify({ version: 2, settings: {}, notes: "PAD-ONE", rules: [], watches, alerts, journal: [] }, null, 1),
    "utf8",
  );
  // One turn on each assistant's own thread: the Messages pane builds its entries from the job store, and a turn with
  // no origin on an assistant's thread is that assistant talking to the reader.
  writeFileSync(
    path.join(logs2, "jobs.json"),
    JSON.stringify({
      savedAt: new Date().toISOString(),
      jobs: [1, 2, 3].map((n) => ({
        id: `seed-${n}`,
        thread: n === 1 ? "panel-assistant" : `panel-assistant-${n}`,
        status: "running",
        startedAt: before(20 - n),
        prompt: `MESSAGE-${["ONE", "TWO", "THREE"][n - 1]}`,
        // The store's shape: a summary reads `lines` straight off the record.
        lines: [],
      })),
    }),
    "utf8",
  );

  const port2 = await freePort();
  const cfgPath2 = path.join(cfg2, "config.json");
  writeFileSync(
    cfgPath2,
    `${JSON.stringify(
      {
        port: port2,
        host: "127.0.0.1",
        scanRoots: [root2],
        defaultCwd: root2,
        jobsFile: path.join(logs2, "jobs.json"),
        assistantFile: path.join(logs2, "assistant.json"),
        assistantsFile: path.join(logs2, "assistants.json"),
        projectsCacheFile: path.join(logs2, "projects.json"),
        treeNamesFile: path.join(logs2, "tree-names.json"),
        apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
        assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
        refreshSeconds: 3600,
        worktreeSeconds: 3600,
        midSeconds: 3600,
        dormantSeconds: 3600,
        slowSeconds: 3600,
        fetchSeconds: 3600,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const base2 = `http://127.0.0.1:${port2}`;
  const log2 = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PANEL_CONFIG: cfgPath2, HERMES_HOME: home2, PANEL_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (d) => log2.push(...String(d).split(/\r?\n/).filter(Boolean)));
  child.stderr.on("data", (d) => log2.push(...String(d).split(/\r?\n/).filter(Boolean)));
  let browser = null;
  try {
    const up = await waitFor(async () => (await fetch(`${base2}/api/state`)).ok, { timeoutMs: 40_000, what: "the seeded panel to answer" });
    if (!up) throw new Error(`the seeded panel never came up on ${base2}\n${log2.slice(-15).join("\n")}`);
    const seededState = await (await fetch(`${base2}/api/assistant`)).json();
    check("the seeded panel holds three assistants", seededState.assistants.map((a) => a.id), ["assistant-1", "assistant-2", "assistant-3"]);
    const perOwner = (list) => {
      // A fixed key order, so the comparison is about the COUNTS and not about the store's sort order.
      const m = {};
      for (const id of ["assistant-1", "assistant-2", "assistant-3"]) m[id] = list.filter((x) => x.assistantId === id).length;
      return m;
    };
    check("…and #2's and #3's alerts are stamped for them", perOwner(seededState.alerts), { "assistant-1": 1, "assistant-2": 2, "assistant-3": 1 });
    check("…with the watches stamped the same way", perOwner(seededState.watches), { "assistant-1": 1, "assistant-2": 2, "assistant-3": 1 });

    // Each pad is written through the panel's own route: the pane has a line of its own to show, not a shared seed.
    for (const [id, text] of [["assistant-2", "PAD-TWO"], ["assistant-3", "PAD-THREE"]]) {
      const r = await fetch(`${base2}/api/assistant/notes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assistantId: id, text }),
      });
      ok(`the seeded panel saved ${id}'s pad`, r.ok, `HTTP ${r.status}`);
    }
    const pads = await Promise.all(
      ["assistant-2", "assistant-3"].map(async (id) => (await (await fetch(`${base2}/api/assistant/notes?assistantId=${id}`)).json()).notes),
    );
    check("…each into its own file", pads, ["PAD-TWO", "PAD-THREE"]);

    browser = await pw.chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(`pageerror: ${String((e && e.message) || e)}`));
    page.on("console", (m) => {
      if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`);
    });
    await page.goto(base2, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#job-prompt", { state: "visible", timeout: 20_000 });
    await page.locator("#btn-assistant").click();
    await page.waitForSelector("#assistant", { state: "visible" });
    // The float paints Assistant #1 from the page's own default and the rest from /api/assistant: read the row
    // before that answer lands and the seeded #2 and #3 are simply not there yet.
    await waitFor(
      async () => (await page.$$eval("#as-tabs button", (els) => els.map((el) => el.dataset.asTab))).includes("assistant-3"),
      { timeoutMs: 20_000, what: "the seeded assistants' tabs" },
    );

    const top = await page.$$eval("#as-tabs button", (els) => els.map((el) => el.dataset.asTab));
    check("the float's row on the seeded panel", top, ["assistant-1", "assistant-2", "assistant-3", "role", "watchdog", "bridge"]);
    ok("no top-level Alerts/Watches/Messages/Pad tab on it", !top.some((t) => ["alerts", "watches", "messages", "pad"].includes(t)), JSON.stringify(top));

    const panesOf = async (id) =>
      page.$eval(`#as-assistant-${id.replace(/^assistant-/, "")}`, (el) => [...el.querySelectorAll("[data-subpane]")].map((s) => s.dataset.subpane));
    const textOf = (sel) => page.$eval(sel, (el) => el.innerText);
    const subOn = async () => page.$$eval("#as-subtabs button.is-on", (els) => els.map((el) => el.dataset.asSubtab));

    for (const [n, pad, alertTitles, watchTitles, message] of [
      [2, "PAD-TWO", ["ALERT-TWO", "ALERT-TWO-B"], ["WATCH-TWO", "WATCH-TWO-B"], "MESSAGE-TWO"],
      [3, "PAD-THREE", ["ALERT-THREE"], ["WATCH-THREE"], "MESSAGE-THREE"],
    ]) {
      const id = `assistant-${n}`;
      const suffix = `-${n}`;
      const other = n === 2 ? "ALERT-THREE" : "ALERT-TWO";
      await page.click(`#as-tabs [data-as-tab="${id}"]`);
      await page.waitForSelector(`#as-assistant-${n}:not(.hidden)`);
      check(`#${n}: its pane holds all eight sub-panes`, await panesOf(id), ["chat", "settings", "queue", "worktrees", "alerts", "watches", "messages", "pad"]);

      // Alerts: its own list, and All as a toggle INSIDE the pane.
      await page.click('#as-subtabs [data-as-subtab="alerts"]');
      await page.waitForSelector(`#as-alerts${suffix}:not(.hidden)`);
      ok(`#${n} alerts: its own list is what shows`, (await textOf(`#as-alerts${suffix}`)).includes(alertTitles[0]), alertTitles[0]);
      ok(`#${n} alerts: and nothing of another assistant's`, !(await textOf(`#as-alerts${suffix}`)).includes(other));
      check(`#${n} alerts: the count on the sub-tab is ITS notices`, await page.locator("#as-alert-n").textContent(), String(alertTitles.length));
      await page.click(`#as-alerts${suffix} [data-as-alertwho="all"]`);
      await page.waitForSelector(`#as-alerts${suffix} [data-as-alertwho="all"][aria-pressed="true"]`);
      for (const t of ["ALERT-ONE", "ALERT-TWO", "ALERT-TWO-B", "ALERT-THREE"]) {
        ok(`#${n} alerts: All shows ${t}`, (await textOf(`#as-alerts${suffix}`)).includes(t));
      }
      check(`#${n} alerts: and the count follows All`, await page.locator("#as-alert-n").textContent(), "4");
      await page.click(`#as-alerts${suffix} [data-as-alertwho="${id}"]`);
      await page.waitForSelector(`#as-alerts${suffix} [data-as-alertwho="${id}"][aria-pressed="true"]`);
      ok(`#${n} alerts: back to its own list`, !(await textOf(`#as-alerts${suffix}`)).includes("ALERT-ONE"));
      check(`#${n} alerts: and its own count again`, await page.locator("#as-alert-n").textContent(), String(alertTitles.length));

      // Watches: its own list, no All (a watchlist is never the panel's).
      await page.click('#as-subtabs [data-as-subtab="watches"]');
      await page.waitForSelector(`#as-watches${suffix}:not(.hidden)`);
      const watchText = await textOf(`#as-watches${suffix}`);
      for (const t of watchTitles) ok(`#${n} watches: ${t} is on its list`, watchText.includes(t));
      ok(`#${n} watches: another assistant's watch is not`, !watchText.includes(n === 2 ? "WATCH-THREE" : "WATCH-TWO"));
      check(`#${n} watches: the count on the sub-tab is ITS watches`, await page.locator("#as-watch-n").textContent(), String(watchTitles.length));

      // Messages: its own split, and All as a toggle INSIDE the pane.
      await page.click('#as-subtabs [data-as-subtab="messages"]');
      await page.waitForSelector(`#as-messages${suffix} .as-msg`, { timeout: 20_000 });
      ok(`#${n} messages: its own thread is what shows`, (await textOf(`#as-messages${suffix}`)).includes(message), message);
      ok(`#${n} messages: and not another assistant's`, !(await textOf(`#as-messages${suffix}`)).includes(n === 2 ? "MESSAGE-THREE" : "MESSAGE-TWO"));
      await page.click(`#as-messages${suffix} [data-as-msgwho="all"]`);
      await page.waitForSelector(`#as-messages${suffix} [data-as-msgwho="all"][aria-pressed="true"]`);
      for (const t of ["MESSAGE-ONE", "MESSAGE-TWO", "MESSAGE-THREE"]) {
        ok(`#${n} messages: All shows ${t}`, (await textOf(`#as-messages${suffix}`)).includes(t));
      }
      await page.click(`#as-messages${suffix} [data-as-msgwho="${id}"]`);
      await page.waitForSelector(`#as-messages${suffix} [data-as-msgwho="${id}"][aria-pressed="true"]`);
      ok(`#${n} messages: back to its own split`, !(await textOf(`#as-messages${suffix}`)).includes("MESSAGE-ONE"));

      // Pad: its own notes, written to its own file above.
      await page.click('#as-subtabs [data-as-subtab="pad"]');
      await page.waitForSelector(`#as-pad${suffix} [data-as-padsave="${id}"]`, { timeout: 20_000 });
      ok(`#${n} pad: its own line is in the box`, (await page.locator(`#as-pad${suffix} textarea`).inputValue()) === pad, pad);
      ok(`#${n} pad: and not another assistant's`, !(await textOf(`#as-pad${suffix}`)).includes(n === 2 ? "PAD-THREE" : "PAD-TWO"));
      check(`#${n}: the four lists are the assistant's own sub-tabs`, await subOn(), ["pad"]);
      ok(`#${n}: every one of its panes lives inside its own pane`, await page.locator(`#as-alerts${suffix}`).evaluate((el, want) => el.closest(`[data-pane="${want}"]`)?.id === `as-${want}`, id));
    }

    check("no page errors in the moved-panes phase", pageErrors, []);
    if (process.env.PANEL_VERIFY_ARTIFACTS) {
      try {
        mkdirSync(process.env.PANEL_VERIFY_ARTIFACTS, { recursive: true });
        await page.click('#as-tabs [data-as-tab="assistant-2"]');
        await page.click('#as-subtabs [data-as-subtab="alerts"]');
        await page.screenshot({ path: path.join(process.env.PANEL_VERIFY_ARTIFACTS, "moved-panes-assistant-2-alerts.png") });
      } catch {
        /* a screenshot is not a check */
      }
    }
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* already gone */
      }
    }
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, { timeoutMs: 15_000, what: "the seeded panel to exit" });
    if (process.env.VERIFY_KEEP !== "1") {
      try {
        rmSync(dir2, { recursive: true, force: true, maxRetries: 5 });
      } catch (e) {
        console.log(`      (could not remove ${dir2}: ${String((e && e.message) || e)})`);
      }
    }
  }
}

// ---- the worktrees pane: one card per project, folded, and a tree press that lands on the board -----
//
// A THIRD panel, seeded before it boots with three repositories and REAL worktrees under each. Nothing here is
// painted into the page: the rows are the scanner's own, every tree is Assistant #1's by default, and two jobs are
// stamped onto trees in beta-repo so the card's live/parked counts have something true to read. What is driven:
// every card starts collapsed, a press opens only that card, the record survives a reload, and a press on a tree
// opens its board row, paints its agents block and leaves the row centred in the viewport — with the float left open.
async function worktreeGroupsPhase(pw) {
  const dir3 = mkdtempSync(path.join(tmpdir(), "wtgui-subtabs-groups-"));
  const root3 = path.join(dir3, "scan-root");
  const home3 = path.join(dir3, "hermes-home");
  const cfg3 = path.join(dir3, "panel");
  const logs3 = path.join(cfg3, "logs");
  for (const d of [root3, home3, cfg3, logs3]) mkdirSync(d, { recursive: true });

  const repos = { "alpha-repo": 3, "beta-repo": 16, "gamma-repo": 5 };
  const trees = {};
  for (const [name, n] of Object.entries(repos)) {
    const repo = path.join(root3, name);
    mkdirSync(repo, { recursive: true });
    git(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(path.join(repo, "README.md"), `# ${name}\n`, "utf8");
    git(repo, ["add", "."]);
    git(repo, ["-c", "user.name=verify", "-c", "user.email=verify@localhost", "commit", "-q", "-m", "first"]);
    const slug = name.replace(/-repo$/, "");
    trees[name] = [];
    for (let i = 1; i <= n; i += 1) {
      const tree = path.join(repo, ".worktrees", `${slug}-${i}`).replace(/\\/g, "/");
      const made = git(repo, ["worktree", "add", "-q", "-b", `${slug}-wt-${i}`, tree, "main"]);
      if (!made.ok) throw new Error(`could not cut ${tree}: ${made.err || made.out}`);
      trees[name].push(tree);
    }
  }

  const now = Date.now();
  const before = (min) => new Date(now - min * 60_000).toISOString();
  // Two agents on beta-repo's trees: one running, one parked on a question. The card's head reads them from the
  // job list the float already holds, so the counts are the panel's own answer rather than a fixture.
  writeFileSync(
    path.join(logs3, "jobs.json"),
    JSON.stringify({
      savedAt: new Date().toISOString(),
      jobs: [
        { id: "seed-live", thread: "seed-live-thread", status: "running", startedAt: before(9), prompt: "GROUPS-LIVE", ownerPath: trees["beta-repo"][0], lines: [] },
        { id: "seed-park", thread: "seed-park-thread", status: "waiting_for_approval", startedAt: before(8), prompt: "GROUPS-PARK", ownerPath: trees["beta-repo"][1], lines: [] },
      ],
    }),
    "utf8",
  );

  const port3 = await freePort();
  const cfgPath3 = path.join(cfg3, "config.json");
  writeFileSync(
    cfgPath3,
    `${JSON.stringify(
      {
        port: port3,
        host: "127.0.0.1",
        scanRoots: [root3],
        defaultCwd: root3,
        jobsFile: path.join(logs3, "jobs.json"),
        assistantFile: path.join(logs3, "assistant.json"),
        assistantsFile: path.join(logs3, "assistants.json"),
        projectsCacheFile: path.join(logs3, "projects.json"),
        treeNamesFile: path.join(logs3, "tree-names.json"),
        apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
        assistant: { enabled: false, autonomy: "draft", seconds: 3600, maxWakesPerHour: 0 },
        refreshSeconds: 3,
        worktreeSeconds: 2,
        midSeconds: 3600,
        dormantSeconds: 3600,
        slowSeconds: 3600,
        fetchSeconds: 3600,
        threads: 2,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const base3 = `http://127.0.0.1:${port3}`;
  const log3 = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PANEL_CONFIG: cfgPath3, HERMES_HOME: home3, PANEL_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (d) => log3.push(...String(d).split(/\r?\n/).filter(Boolean)));
  child.stderr.on("data", (d) => log3.push(...String(d).split(/\r?\n/).filter(Boolean)));
  let browser = null;
  try {
    const up = await waitFor(async () => (await fetch(`${base3}/api/state`)).ok, { timeoutMs: 40_000, what: "the groups panel to answer" });
    if (!up) throw new Error(`the groups panel never came up on ${base3}\n${log3.slice(-15).join("\n")}`);
    const stateNow = async () => (await fetch(`${base3}/api/state`)).json();
    const countOf = (s, name) => ((s.projects || []).find((p) => p.name === name)?.worktrees || []).length;
    const scanned = await waitFor(
      async () => {
        const s = await stateNow();
        return countOf(s, "alpha-repo") === 4 && countOf(s, "beta-repo") === 17 && countOf(s, "gamma-repo") === 6;
      },
      { timeoutMs: 120_000, what: "the three projects and their 27 rows to be scanned" },
    );
    ok("the sandbox scanned every project and every tree", scanned, "4 + 17 + 6 rows in /api/state (each project's own checkout included)");
    const seeded = await stateNow();
    const owners = (seeded.projects || []).flatMap((p) => (p.worktrees || []).map((r) => r.assistant?.id || ""));
    ok("…and every row is Assistant #1's, so this pane has all 27", owners.length === 27 && owners.every((id) => id === "assistant-1"), JSON.stringify([...new Set(owners)]));

    browser = await pw.chromium.launch({ headless: true });
    // A short viewport on purpose: the board has to be able to SCROLL for a centred row to be a measurement rather
    // than a clamp at the top of a page that already fits.
    const context = await browser.newContext({ viewport: { width: 1400, height: 620 } });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(`pageerror: ${String((e && e.message) || e)}`));
    page.on("console", (m) => {
      if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`);
    });
    await page.goto(base3, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#job-prompt", { state: "visible", timeout: 20_000 });
    await page.locator("#btn-assistant").click();
    await page.waitForSelector("#assistant", { state: "visible" });
    // The float paints its panes from the assistant's own answer, so the sub-tab row can be pressed before that
    // answer lands. Wait for the session pane first, then press; if the pane is still empty (a repaint landed between
    // the press and the rows), press once more rather than failing on a race.
    await page.waitForSelector("#as-assistant-1:not(.hidden)", { timeout: 20_000 });
    await page.click('#as-subtabs [data-as-subtab="worktrees"]');
    let paneUp = await waitFor(async () => (await page.locator("#as-worktrees .as-wtgroup").count()) > 0, {
      timeoutMs: 12_000,
      what: "the grouped worktrees pane",
    });
    if (!paneUp) {
      await page.click('#as-subtabs [data-as-subtab="worktrees"]');
      paneUp = await waitFor(async () => (await page.locator("#as-worktrees .as-wtgroup").count()) > 0, {
        timeoutMs: 12_000,
        what: "the grouped worktrees pane, second press",
      });
    }
    ok("the grouped pane renders", paneUp);
    if (!paneUp) {
      const diag = await page.evaluate(() => ({
        view: localStorage.getItem("wm.assistantView"),
        pane: (document.getElementById("as-worktrees")?.innerText || "").slice(0, 300),
        groups: document.querySelectorAll("#as-worktrees .as-wtgroup").length,
      }));
      console.log(`      pane diagnostics: ${JSON.stringify(diag)}`);
      console.log(`      page errors: ${JSON.stringify(pageErrors)}`);
      throw new Error("the worktrees pane never drew a project card");
    }

    const store = (key) => page.evaluate((k) => localStorage.getItem(k), key);
    const groups = () =>
      page.$$eval("#as-worktrees .as-wtgroup", (els) =>
        els.map((el) => {
          const table = el.querySelector(".as-worktrees-table");
          return {
            name: el.dataset.asWtgroupCard,
            collapsed: el.classList.contains("collapsed"),
            rows: el.querySelectorAll("tbody tr.row").length,
            head: (el.querySelector(".project-head")?.innerText || "").replace(/\s+/g, " ").trim(),
            tables: table ? 1 : 0,
            painted: Boolean(table && table.offsetParent),
            openers: [...el.querySelectorAll("tbody tr.row")].every((tr) => String(tr.dataset.openRow || "").includes("::")),
          };
        }),
      );

    console.log("\n== the worktrees pane: one card per project, all folded ==");
    const first = await groups();
    check("one card per project, in name order", first.map((g) => g.name), ["alpha-repo", "beta-repo", "gamma-repo"]);
    check("…holding every row the flat table used to show (each project's own checkout included)", first.map((g) => g.rows), [4, 17, 6]);
    ok("every card starts collapsed", first.every((g) => g.collapsed), JSON.stringify(first.map((g) => g.collapsed)));
    ok("…and no table is painted under a closed card", first.every((g) => !g.painted), JSON.stringify(first.map((g) => g.painted)));
    ok("…with the table still in the markup, so nothing the table shows is lost", first.every((g) => g.tables === 1 && g.rows > 0));
    ok("every row carries the board's own opener key", first.every((g) => g.openers));
    ok("the head says how many trees the project holds", first.every((g, i) => g.head.includes(`${[4, 17, 6][i]} trees`)), JSON.stringify(first.map((g) => g.head)));
    // The counts are read from the job list the float holds, so the gate asks that list what to expect rather than
    // pinning a number: the store reconciles a seeded `running` job to `interrupted` when no process is behind it,
    // and the parked one stays parked. What is asserted is that the head agrees with the answer.
    const jobsNow = (await (await fetch(`${base3}/api/jobs`)).json()).jobs || [];
    const statusOf = (thread) => String(jobsNow.find((j) => j.thread === thread)?.status || "").toLowerCase();
    const liveN = ["seed-live-thread"].filter((t) => ["running", "starting", "queued"].includes(statusOf(t))).length;
    const parkN = ["seed-park-thread"].filter((t) => ["waiting", "waiting_for_approval"].includes(statusOf(t))).length;
    const wantCounts = [liveN ? `${liveN} live` : "", parkN ? `${parkN} parked` : ""].filter(Boolean).join(" · ");
    ok("…and beta's head counts the agents the job list reports on its trees", wantCounts ? first[1].head.includes(wantCounts) : !/live|parked/.test(first[1].head), `${first[1].head} (jobs say ${wantCounts || "none"})`);
    ok("…with the parked seed still parked", parkN === 1, `parked ${parkN}, live ${liveN}`);
    check("the pane's own record is not written on a first render", await store("wm.assistantWorktreeGroups"), null);
    check("…and the board's project fold was not touched", await store("wm.expandedProjects"), null);

    console.log("\n== a press opens that card and only that card ==");
    await page.click('#as-worktrees [data-as-wtgroup="alpha-repo"]');
    await waitFor(async () => (await groups()).filter((g) => !g.collapsed).length === 1, { timeoutMs: 10_000, what: "alpha-repo to open" });
    const afterAlpha = await groups();
    check("only alpha-repo is open", afterAlpha.map((g) => g.collapsed), [false, true, true]);
    ok("…its table is painted with its four rows", afterAlpha[0].painted && afterAlpha[0].rows === 4, JSON.stringify(afterAlpha[0]));
    check("…recorded under this pane's own key", JSON.parse(await store("wm.assistantWorktreeGroups")), ["alpha-repo"]);
    check("…and the board's project fold is still untouched", await store("wm.expandedProjects"), null);

    console.log("\n== the fold survives a reload ==");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#assistant", { state: "visible", timeout: 20_000 });
    await page.waitForSelector("#as-worktrees .as-wtgroup", { timeout: 20_000 });
    const afterReload = await groups();
    check("alpha-repo is still open, the other two still closed", afterReload.map((g) => g.collapsed), [false, true, true]);
    check("…and the record is what the page left", JSON.parse(await store("wm.assistantWorktreeGroups")), ["alpha-repo"]);

    console.log("\n== a tree press opens its board row and centres the window on it ==");
    await page.click('#as-worktrees [data-as-wtgroup="beta-repo"]');
    await waitFor(async () => (await groups()).find((g) => g.name === "beta-repo")?.collapsed === false, { timeoutMs: 10_000, what: "beta-repo to open" });
    check("opening a second card leaves the first one open", (await groups()).map((g) => g.collapsed), [false, false, true]);

    const beta = page.locator('#as-worktrees .as-wtgroup[data-as-wtgroup-card="beta-repo"]');
    const target = beta.locator("tbody tr.row").nth(11);
    const key = await target.getAttribute("data-key");
    const opener = await target.getAttribute("data-open-row");
    check("the row's opener is the board's own key for it", opener, key);
    ok("the board's beta project is closed before the press", await page.locator('section.project[data-project="beta-repo"]').evaluate((el) => el.classList.contains("collapsed")));
    await target.locator(".row-name").click();
    const landed = await waitFor(async () => (await page.locator(`#projects tr.row[data-key="${key}"].expanded`).count()) === 1, {
      timeoutMs: 10_000,
      what: "the board row to open",
    });
    ok("the press opens the matching board row", landed, key);
    ok("…and its agents block is painted", (await page.locator(`#projects tr.detail[data-detail="${key}"] .agents-block`).count()) === 1);
    ok("…with the project itself unfolded", !(await page.locator('section.project[data-project="beta-repo"]').evaluate((el) => el.classList.contains("collapsed"))));
    // The land() re-asserts on the next frame, then at 120 ms and 400 ms: measure after the last one, or the number
    // is the first pass's guess rather than what the reader is left looking at.
    await sleep(700);
    const geo = await page.evaluate((k) => {
      const tr = document.querySelector(`#projects tr.row[data-key="${CSS.escape(k)}"]`);
      if (!tr) return null;
      const r = tr.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), mid: Math.round((r.top + r.bottom) / 2), vh: window.innerHeight, y: Math.round(window.scrollY) };
    }, key);
    ok("the row is fully inside the viewport", Boolean(geo) && geo.top >= -1 && geo.bottom <= geo.vh + 1, JSON.stringify(geo));
    ok("…and centred in it", Boolean(geo) && Math.abs(geo.mid - geo.vh / 2) <= 60, `row mid ${geo?.mid} vs viewport mid ${geo?.vh / 2}`);
    ok("the float is left open — it is not closed to make room", await page.locator("#assistant").isVisible());
    const labels = await page.$$eval("#as-subtabs button", (els) => els.map((e) => e.innerText.trim()));
    ok("the session's sub-tabs still carry their counts", labels.includes("Alerts 0") && labels.includes("Watches 0"), JSON.stringify(labels));
    check("no page errors in the groups phase", pageErrors, []);
    if (process.env.PANEL_VERIFY_ARTIFACTS) {
      try {
        mkdirSync(process.env.PANEL_VERIFY_ARTIFACTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.PANEL_VERIFY_ARTIFACTS, "worktree-groups-open.png") });
      } catch {
        /* a screenshot is not a check */
      }
    }
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* already gone */
      }
    }
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, { timeoutMs: 15_000, what: "the groups panel to exit" });
    if (process.env.VERIFY_KEEP !== "1") {
      try {
        rmSync(dir3, { recursive: true, force: true, maxRetries: 5 });
      } catch (e) {
        console.log(`      (could not remove ${dir3}: ${String((e && e.message) || e)})`);
      }
    }
  }
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
  ok(
    "…the four moved lists as sub-tabs of the assistant",
    ["alerts", "watches", "messages", "pad"].every((sub) => html.includes(`data-as-subtab="${sub}"`)),
  );
  ok(
    "…and no top-level tab for any of them",
    ["alerts", "watches", "messages", "pad"].every((tab) => !html.includes(`data-as-tab="${tab}"`)),
  );
  ok("…and the nested panes", /data-pane="assistant-1"[\s\S]*data-subpane="chat"[\s\S]*data-subpane="settings"[\s\S]*data-subpane="alerts"[\s\S]*data-subpane="pad"/.test(html));
  ok("…the Role tab in the markup", html.includes('data-as-tab="role"') && html.includes('data-pane="role"') && !html.includes('data-as-tab="charter"'));
  check("served with no-store, so a reload is enough (no restart, no new route)", served.headers.get("cache-control"), "no-store");
  note("the sandbox and both served files are DRIVEN; the browser half below is a real browser over them.");

  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN  the client half of this change was not exercised in a browser.");
    note("re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=C:/ProjectDevelopment/heroes-js node tools/verify-assistant-subtabs.mjs");
    failures += 1;
  } else {
    await browserPhase(pw);
    console.log("\n== the four moved lists, on #2 and #3 ==");
    await movedPanesPhase(pw);
    console.log("\n== the worktrees pane, one card per project ==");
    await worktreeGroupsPhase(pw);
  }

  console.log("\n== summary ==");
  console.log(`${checks} checks, ${failures} failed`);
  console.log("\nWHAT WAS DRIVEN: a real panel process booted on its own port over its own PANEL_CONFIG and HERMES_HOME (its");
  console.log("own project scanned, its own files served, the live 7331 listener count identical across the run), and headless");
  console.log("Chromium over that panel — the two rows measured as boxes, Settings as the session's second tab, the record in");
  console.log("localStorage, the reload that lands back on Settings, the card still filling the float, every other tab, the");
  console.log("Role editor's selector pointing at the role a record runs, a second assistant made from that role with its own tab, pane, rules");
  console.log("and copy of the charter, and #1's own text and file staying byte for byte while that pane is opened and read.");
  console.log("byte, the badges and Ctrl+,");
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
