// The reply box's two gestures — Enter holds the reply, Ctrl/Cmd+Enter steers the live turn — proved by driving a
// panel of its own, and a real browser over it, with real keydown events.
//
//   node tools/verify-reply-queue-keys.mjs                       boot a sandbox panel from THIS checkout
//   PANEL_URL=http://127.0.0.1:7331 node tools/verify-reply-queue-keys.mjs    drive a panel already running
//
// A card offers at most one of the two reply buttons: **Steer turn** while a turn is live, **Queue reply** while
// there is something to wait for (a turn running, or a finished turn whose subagents are still out), and **Send
// reply** when there is neither. Each keystroke is the button it stands for, and nothing else:
//
//   (1) Enter is the Queue reply button's press: no request, the box empties, the queued entry is on the card with
//       its "sends when the current turn finishes" line, and the button is still the only other control that does it
//   (2) Ctrl/Cmd+Enter is the Steer turn button's press: one POST /api/jobs/steer naming the live turn, nothing held
//   (3) the same while the button is offered for the other reason — a finished turn whose subagents are out: Enter
//       holds it, and with no live turn to steer Ctrl+Enter means what Enter means
//   (4) with no turn running and no subagent out there is nothing to hold and nothing to steer, so BOTH send, and
//       the request each makes is identical
//   (5) Shift+Enter still inserts a newline, Ctrl+Shift+Enter is a newline and never a gesture, an empty box is
//       ignored without an error, and the add-agent field, the model picker and the settings boxes are untouched
//   (6) the placeholder and both buttons' titles name the gesture each of them owns, in each state
//
// WHAT IS DRIVEN, AND WHAT IS ONLY INSPECTED
//
//   driven     a panel of its own (or PANEL_URL) plus headless Chromium over it, with real key presses
//              (page.keyboard.press -> CDP Input.dispatchKeyEvent), and the page's own fetch stubbed so a
//              "send" or a "steer" is recorded instead of reaching a gateway
//   driven     the three card states, fabricated in the PAGE's own state (state.jobs + renderJobs) so a running
//              turn, a finished turn with subagents out and an idle thread are real renders of the shipped code
//   inspected  that each branch sits behind the `.reply-box` guard, and that each button's click path and its
//              keystroke call the SAME function — read off public/app.js, not measured here
//
// The browser half needs a Playwright install. Point the script at one with PANEL_PLAYWRIGHT_ROOT (a directory
// holding node_modules/playwright, or the package itself); without one the script says BROWSER-HALF-NOT-RUN and
// exits 2 rather than passing on a half that never ran.
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const require = createRequire(import.meta.url);
const LIVE = String(process.env.PANEL_URL || "").replace(/\/+$/, "");

let failures = 0;
let browserRef = null;
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
async function waitFor(fn, { timeoutMs = 30_000, stepMs = 300, what = "condition" } = {}) {
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
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// ---- the sandbox panel (skipped entirely when PANEL_URL names a running one) ----------------------
const THREAD = "wtgui-probe-reply-keys-4e71aa";
let dir = null;
let panel = null;
let base = LIVE;
const panelLog = [];

async function startSandbox() {
  dir = mkdtempSync(path.join(tmpdir(), "wtgui-reply-keys-"));
  const scanRoot = path.join(dir, "scan-root");
  const home = path.join(dir, "hermes-home");
  const configDir = path.join(dir, "panel");
  const cwdDir = path.join(dir, "panel-cwd");
  for (const d of [scanRoot, home, configDir, cwdDir, path.join(configDir, "logs")]) mkdirSync(d, { recursive: true });
  const port = await freePort();
  const configPath = path.join(configDir, "config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        port,
        host: "127.0.0.1",
        scanRoots: [scanRoot],
        defaultCwd: cwdDir,
        jobsFile: path.join(configDir, "logs", "jobs.json"),
        assistantFile: path.join(configDir, "logs", "assistant.json"),
        projectsCacheFile: path.join(configDir, "logs", "projects.json"),
        treeNamesFile: path.join(configDir, "logs", "tree-names.json"),
        // Nothing this script drives may reach a gateway: the page's own fetch is stubbed for the writes, and
        // this is the belt to that brace — a probe that resolved a name would buy a real worker.
        apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
        assistant: { enabled: false, seconds: 3600, maxWakesPerHour: 0 },
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
  base = `http://127.0.0.1:${port}`;
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
  return port;
}
async function stopSandbox() {
  if (!panel) return;
  const p = panel;
  panel = null;
  p.kill();
  await waitFor(() => p.exitCode !== null || p.signalCode !== null, { timeoutMs: 10_000, what: "the panel to exit" });
  if (p.exitCode === null && p.signalCode === null && p.pid) {
    try {
      execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      /* already gone */
    }
  }
  await sleep(300);
}

// ---- the browser half ----------------------------------------------------------------------------
function loadPlaywright() {
  const roots = [process.env.PANEL_PLAYWRIGHT_ROOT, process.env.PLAYWRIGHT_ROOT, ROOT, process.cwd()].filter(Boolean);
  for (const root of roots) {
    try {
      return require(path.join(root, "node_modules", "playwright"));
    } catch {
      /* not there */
    }
    try {
      return require(root);
    } catch {
      /* not there */
    }
  }
  try {
    return require("playwright");
  } catch {
    return null;
  }
}

const cardSel = `.job[data-thread="${THREAD}"]`;
const boxSel = `${cardSel} .reply-box`;
const queueBtnSel = `${cardSel} [data-queue-reply]`;
const steerBtnSel = `${cardSel} [data-steer]`;

async function browserPhase(pw) {
  const pageErrors = [];
  const browser = await pw.chromium.launch({ headless: true });
  browserRef = browser;
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });

  // ---- the page-side probe: a recorded fetch, the three card states, and the box's own readings ----
  // Registered BEFORE the page navigates, and it also replaces EventSource. The page's live stream broadcasts
  // `jobs`, which CLEARS state.jobs — so a card fabricated here could be wiped mid-check by a broadcast that has
  // nothing to do with this test. With no stream and a stubbed fetch, this probe's state.jobs is the only source
  // of cards on the page, and every request the page would otherwise make is recorded instead of sent.
  const realSnapshot = await fetch(`${base}/api/state`).then((r) => r.json());
  await context.addInitScript(
    ({ snapshot, thread }) => {
      const realFetch = window.fetch.bind(window);
      const probe = { posts: [], keys: [], snapshot };
      window.__probe = probe;
      // Every keydown the page sees, with its modifiers: what proves a branch was reached by a REAL Ctrl+Enter
      // rather than by a handler that ignores the modifiers.
      document.addEventListener(
        "keydown",
        (e) => {
          probe.keys.push({ key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey, at: (e.target && e.target.className) || "" });
        },
        true,
      );
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      window.fetch = async (url, opts = {}) => {
        const u = String(url);
        const method = String((opts && opts.method) || "GET").toUpperCase();
        if (method !== "POST") {
          // Reads go to the panel, except the snapshot: it carries whatever this probe fabricated, so the page's
          // own safety-net resync cannot drop a card in the middle of a check.
          if (u.includes("/api/state")) return json({ ...probe.snapshot, jobs: [...state.jobs.values()] });
          return realFetch(url, opts);
        }
        const body = opts && opts.body ? JSON.parse(String(opts.body)) : null;
        probe.posts.push({ url: u, body });
        if (u.includes("/api/agents/reply")) {
          return json({
            job: {
              id: `probe-reply-${probe.posts.length}`,
              thread: (body && body.thread) || thread,
              turn: 2,
              prompt: (body && body.text) || "",
              displayPrompt: (body && body.text) || "",
              status: "running",
              startedAt: new Date().toISOString(),
              cwd: null,
              worktree: false,
              lines: [],
              artifacts: [],
              attachments: [],
              subagents: [],
            },
          });
        }
        return json({ ok: true });
      };
      const FakeStream = function () {
        this.readyState = 1;
      };
      FakeStream.prototype.addEventListener = function () {};
      FakeStream.prototype.removeEventListener = function () {};
      FakeStream.prototype.close = function () {};
      window.EventSource = FakeStream;

      // The three states the brief names. They are the page's own conversation objects, rendered by the shipped
      // renderJobs/conversationHtml — the card is the real thing, not a fixture of the markup.
      const job = (o) => ({
        id: o.id,
        thread,
        turn: o.turn || 1,
        status: o.status,
        prompt: "probe brief — the state under test",
        displayPrompt: "probe brief — the state under test",
        cwd: null,
        worktree: false,
        worktreePath: null,
        projectPath: null,
        ownerPath: null,
        branch: null,
        runId: o.status === "running" ? "run_probe" : null,
        startedAt: new Date(Date.now() - 90_000).toISOString(),
        endedAt: o.status === "running" ? null : new Date(Date.now() - 30_000).toISOString(),
        model: "probe/model",
        lines: [],
        artifacts: [],
        attachments: [],
        subagents: o.subagents || [],
      });
      probe.card = (turns) => {
        state.jobs.clear();
        state.replyQueue.delete(thread);
        state.replyDrafts[thread] = "";
        for (const t of turns) state.jobs.set(t.id, job(t));
        renderJobs();
        const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
        if (box) box.focus();
        return Boolean(box);
      };
      probe.queue = () => [...(state.replyQueue.get(thread) || [])].map((q) => q.text);
      probe.boxValue = () => document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`)?.value ?? null;
      probe.placeholder = () => document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`)?.placeholder ?? null;
      probe.titles = () => {
        const card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
        const q = card?.querySelector("[data-queue-reply]");
        const s = card?.querySelector("[data-steer]");
        const p = s || card?.querySelector(".btn-reply[data-thread]");
        return { queue: q ? q.title : null, steer: s ? s.title : null, primary: p ? p.title : null, primaryLabel: p ? p.textContent : null };
      };
      probe.ghosts = () => {
        const card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
        return [...(card?.querySelectorAll(".ghost-turn") || [])].map((g) => g.innerText.replace(/\s+/g, " ").trim());
      };
      probe.cardCount = () => document.querySelectorAll(`.job[data-thread="${CSS.escape(thread)}"]`).length;
    },
    { snapshot: realSnapshot, thread: THREAD },
  );
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${String((e && e.message) || e)}`));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`);
  });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  const ready = await page
    .waitForFunction(() => typeof window.renderJobs === "function" && typeof window.__probe === "object", null, { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  ok("browser: the page is loaded with the probe installed", ready);

  const press = async (combo, { focus = boxSel } = {}) => {
    await page.locator(focus).focus();
    await page.keyboard.press(combo);
    await page.waitForTimeout(200);
  };
  const posts = () => page.evaluate(() => window.__probe.posts.map((p) => ({ url: p.url, body: p.body })));
  const lastKey = () => page.evaluate(() => window.__probe.keys[window.__probe.keys.length - 1] || null);
  const replyPosts = async () => (await posts()).filter((p) => p.url.includes("/api/agents/reply"));
  const steerPosts = async () => (await posts()).filter((p) => p.url.includes("/api/jobs/steer"));
  const clearPosts = () => page.evaluate(() => { window.__probe.posts.length = 0; });
  const queueOf = () => page.evaluate(() => window.__probe.queue());
  const ghosts = () => page.evaluate(() => window.__probe.ghosts());
  const titles = () => page.evaluate(() => window.__probe.titles());
  const placeholder = () => page.evaluate(() => window.__probe.placeholder());
  const boxValue = () => page.evaluate(() => window.__probe.boxValue());
  const card = async (turns) => {
    const made = await page.evaluate((t) => window.__probe.card(t), turns);
    await page.waitForTimeout(120);
    return made;
  };
  const type = async (text) => {
    await page.locator(boxSel).fill(text);
    await page.waitForTimeout(80);
  };

  // ================= state A: a turn is running =====================================================
  console.log("\n== state A: a turn is running on this thread ==");
  ok("the card renders with its reply box", await card([{ id: "probe-a", status: "running" }]));
  check("the Steer turn button is offered (this is the state it exists for)", await page.locator(steerBtnSel).count(), 1);
  check("the Queue reply button is offered beside it", await page.locator(queueBtnSel).count(), 1);
  check("the primary button is Steer turn", (await titles()).primaryLabel, "Steer turn");
  const titlesA = await titles();
  const placeholderA = await placeholder();
  ok("(6) the placeholder names both gestures in this state", /Ctrl\+Enter steers it/.test(placeholderA) && /Enter holds yours/.test(placeholderA), placeholderA);
  ok("(6) the Steer turn button's title names its gesture", /\(Ctrl\+Enter\)/.test(titlesA.steer), titlesA.steer);
  ok("(6) the Queue reply button's title names its gesture", /\(Enter\)/.test(titlesA.queue), titlesA.queue);

  // (1) Enter holds the reply — no request at all, the box empties, the ghost entry is on the card.
  await clearPosts();
  await type("hold this for the next turn");
  await press("Enter");
  const keyEnter = await lastKey();
  ok("(1) the key the page saw was a real Enter with no modifiers", keyEnter && keyEnter.key === "Enter" && !keyEnter.ctrl && !keyEnter.meta && !keyEnter.shift, JSON.stringify(keyEnter));
  check("(1) Enter made no request at all", await posts(), []);
  check("(1) the reply is held", await queueOf(), ["hold this for the next turn"]);
  check("(1) the box is empty", await boxValue(), "");
  const ghostsA = await ghosts();
  ok("(1) the queued entry is on the card, with its own line", ghostsA.length === 1 && /sends when the current turn finishes/.test(ghostsA[0]) && /hold this for the next turn/.test(ghostsA[0]), JSON.stringify(ghostsA));
  check("(1) the queue count is on the card too", await page.locator(`${cardSel} .queue-note`).textContent(), "1 queued");
  check("(1) the only control carrying the queue action is the Queue reply button", await page.locator(`${cardSel} [data-queue-reply]`).count(), 1);
  check("(1) and it is a button, so the press is still there for the reader", await page.locator(queueBtnSel).evaluate((el) => el.tagName), "BUTTON");
  // the button and the keystroke are one action: the button holds the next one.
  await type("and this one from the button");
  await page.locator(queueBtnSel).click();
  await page.waitForTimeout(200);
  check("(1) the Queue reply button holds it the same way", await queueOf(), ["hold this for the next turn", "and this one from the button"]);
  check("(1) still no request from either press", await posts(), []);

  // (2) Ctrl+Enter steers the live turn — one POST, nothing held.
  await page.evaluate(() => { state.replyQueue.delete("wtgui-probe-reply-keys-4e71aa"); renderConversation("wtgui-probe-reply-keys-4e71aa"); });
  await clearPosts();
  await type("steer this into the live turn");
  await press("Control+Enter");
  const keyCtrl = await lastKey();
  ok("(2) the key the page saw was a real Ctrl+Enter", keyCtrl && keyCtrl.key === "Enter" && keyCtrl.ctrl === true && keyCtrl.shift === false, JSON.stringify(keyCtrl));
  const steered = await steerPosts();
  check("(2) Ctrl+Enter posts one steer, and nothing else", (await posts()).length, 1);
  check("(2) the steer names the running turn (the job the card shows as live)", steered[0]?.body?.id, "probe-a");
  check("(2) and carries the typed text", steered[0]?.body?.text, "steer this into the live turn");
  check("(2) Ctrl+Enter held nothing", await queueOf(), []);
  check("(2) the box is empty after the steer", await boxValue(), "");
  // the Steer turn button and the keystroke are one action.
  await clearPosts();
  await type("and this one from the button");
  await page.locator(steerBtnSel).click();
  await page.waitForTimeout(250);
  const steeredByButton = await steerPosts();
  check("(2) the Steer turn button steers the same way", steeredByButton[0]?.body?.text, "and this one from the button");
  check("(2) and holds nothing either", await queueOf(), []);

  // (5) Shift+Enter is still a newline, Ctrl+Shift+Enter is still a newline and never a gesture.
  await clearPosts();
  await type("line one");
  await press("Shift+Enter");
  const afterShift = await boxValue();
  ok("(5) Shift+Enter inserts a newline instead of acting", /line one\n$/.test(afterShift), JSON.stringify(afterShift));
  check("(5) Shift+Enter held nothing and sent nothing", { q: await queueOf(), posts: await posts() }, { q: [], posts: [] });
  await press("Control+Shift+Enter");
  const keyCtrlShift = await lastKey();
  check("(5) Ctrl+Shift+Enter held nothing", await queueOf(), []);
  check("(5) and steered nothing", await posts(), []);
  ok("(5) the page saw Ctrl+Shift+Enter with shift down", keyCtrlShift && keyCtrlShift.shift === true && keyCtrlShift.ctrl === true, JSON.stringify(keyCtrlShift));
  ok("(5) it is the newline branch that ran, so the box grew a line", String(await boxValue()).split("\n").length >= 3, JSON.stringify(await boxValue()));

  // (5) an empty box is still ignored, without an error — for either gesture.
  await page.evaluate(() => { document.querySelector('.reply-box[data-reply="wtgui-probe-reply-keys-4e71aa"]').value = ""; state.replyDrafts["wtgui-probe-reply-keys-4e71aa"] = ""; });
  await clearPosts();
  await press("Enter");
  check("(5) an empty box with Enter holds nothing", await queueOf(), []);
  check("(5) and sends nothing", await posts(), []);
  await press("Control+Enter");
  check("(5) an empty box with Ctrl+Enter steers nothing", await queueOf(), []);
  check("(5) and posts nothing", await posts(), []);

  // ⌘+Enter: the Mac spelling of the steer gesture.
  await clearPosts();
  await type("steered from the command key");
  await press("Meta+Enter");
  const keyMeta = await lastKey();
  if (keyMeta && keyMeta.meta === true) {
    ok("(2) the key the page saw was a real ⌘+Enter", keyMeta.key === "Enter" && keyMeta.meta === true, JSON.stringify(keyMeta));
  } else {
    note(`Playwright's Meta+Enter reached the page as ${JSON.stringify(keyMeta)} — dispatching the same event with metaKey instead`);
    await page.evaluate(() => {
      const box = document.querySelector('.reply-box[data-reply="wtgui-probe-reply-keys-4e71aa"]');
      box.focus();
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(200);
    const dispatched = await lastKey();
    ok("(2) a ⌘+Enter keydown (metaKey, dispatched on the box) steers", dispatched && dispatched.meta === true, JSON.stringify(dispatched));
  }
  const metaSteer = await steerPosts();
  check("(2) ⌘+Enter steered the live turn", metaSteer[0]?.body?.text, "steered from the command key");
  check("(2) ⌘+Enter held nothing", await queueOf(), []);

  // ================= state B: finished turn, subagents still out =====================================
  console.log("\n== state B: the turn is over, its subagents are still out ==");
  ok("the card renders with its reply box", await card([{ id: "probe-b", status: "done", subagents: [{ id: "sub-1", running: true, name: "worker" }] }]));
  check("the Queue reply button is offered for the second reason", await page.locator(queueBtnSel).count(), 1);
  check("no turn is live, so no Steer turn button is offered", await page.locator(steerBtnSel).count(), 0);
  check("the primary button is Send reply", (await titles()).primaryLabel, "Send reply");
  const titlesB = await titles();
  const placeholderB = await placeholder();
  ok("(6) the placeholder names the gesture in this state", /Enter holds yours until they finish/.test(placeholderB), placeholderB);
  ok("(6) the Queue reply button's title names its gesture", /\(Enter\)/.test(titlesB.queue), titlesB.queue);
  ok("(6) the Send reply button's title names no key, because no key sends here", /subagents this thread started are still out/.test(titlesB.primary) && !/\(Enter/.test(titlesB.primary), titlesB.primary);
  await clearPosts();
  await type("wait for the children, then this");
  await press("Enter");
  check("(3) Enter holds the reply while the subagents are out", await queueOf(), ["wait for the children, then this"]);
  check("(3) with no request at all", await posts(), []);
  const ghostsB = await ghosts();
  ok("(3) and the queued entry is on the card", ghostsB.length === 1 && /wait for the children, then this/.test(ghostsB[0]), JSON.stringify(ghostsB));
  // No live turn to steer: Ctrl+Enter means what Enter means here.
  await page.evaluate(() => { state.replyQueue.delete("wtgui-probe-reply-keys-4e71aa"); renderConversation("wtgui-probe-reply-keys-4e71aa"); });
  await clearPosts();
  await type("ctrl+enter with nothing to steer");
  await press("Control+Enter");
  check("(3) Ctrl+Enter with no live turn holds it too", await queueOf(), ["ctrl+enter with nothing to steer"]);
  check("(3) and still makes no request", await posts(), []);

  // ================= state C: nothing running, no subagent out =======================================
  console.log("\n== state C: nothing is running and no subagent is out — nothing to hold, nothing to steer ==");
  ok("the card renders with its reply box", await card([{ id: "probe-c", status: "done" }]));
  check("no Queue reply button is offered", await page.locator(queueBtnSel).count(), 0);
  check("no Steer turn button is offered", await page.locator(steerBtnSel).count(), 0);
  check("the primary button is Send reply", (await titles()).primaryLabel, "Send reply");
  const placeholderC = await placeholder();
  const titlesC = await titles();
  ok("(6) the placeholder says what this state does, and promises no hold", /Enter or Ctrl\+Enter to send/.test(placeholderC), placeholderC);
  ok("(6) and the Send reply button's title names both gestures", /\(Enter or Ctrl\+Enter\)/.test(titlesC.primary), titlesC.primary);
  await clearPosts();
  await type("this is the next turn");
  await press("Enter");
  const replyPostsEnter = await replyPosts();
  check("(4) Enter sends exactly one reply", replyPostsEnter.length, 1);
  check("(4) to this thread", replyPostsEnter[0]?.body?.thread, THREAD);
  check("(4) with the typed text", replyPostsEnter[0]?.body?.text, "this is the next turn");
  check("(4) and held nothing", await queueOf(), []);
  check("(4) the box is empty after the send", await boxValue(), "");
  const afterEnter = await posts();
  // Same state again before the comparison: a sent reply paints a new running turn on the card (that is what the
  // stubbed answer says a real one does), and comparing the two gestures has to start from the state the brief
  // names - nothing running, nothing held.
  await card([{ id: "probe-c", status: "done" }]);
  await clearPosts();
  await type("this is the next turn");
  await press("Control+Enter");
  const afterCtrl = await posts();
  check("(4) Ctrl+Enter makes the same request, character for character", JSON.stringify(afterCtrl), JSON.stringify(afterEnter));
  ok("(4) so both gestures are one behaviour where there is nothing to wait for", afterCtrl.length === 1 && afterCtrl[0].url.includes("/api/agents/reply"), JSON.stringify(afterCtrl.map((p) => p.url)));

  // ================= (5) the other boxes on the page are untouched ===================================
  console.log("\n== the gestures are scoped to the reply box ==");
  await card([{ id: "probe-a2", status: "running" }]);
  await type("still the reply box's own text");
  // The settings dialog is closed on a fresh page, so open it the way the reader does before touching its
  // boxes — a field focused while hidden would prove nothing about the page as it is used.
  await page.evaluate(() => toggleSettings(true));
  await page.waitForTimeout(150);
  const foreign = [
    ["#job-prompt", "the add-agent field"],
    ["#provider-key", "a settings text box"],
    ["#q-width", "a settings preset row's own box"],
  ];
  for (const [sel, what] of foreign) {
    if ((await page.locator(sel).count()) !== 1 || !(await page.locator(sel).isVisible())) {
      note(`(${sel} — ${what} — is not on this page, skipped)`);
      continue;
    }
    await clearPosts();
    await page.locator(sel).focus();
    await page.keyboard.press("Control+Enter");
    await page.waitForTimeout(150);
    check(`(5) Ctrl+Enter in ${what} holds nothing`, await queueOf(), []);
    check(`(5) Ctrl+Enter in ${what} steers nothing`, (await steerPosts()).length, 0);
    check(`(5) Ctrl+Enter in ${what} does nothing at all`, await posts(), []);
    check(`(5) the reply box still holds its own draft`, await boxValue(), "still the reply box's own text");
  }
  await page.evaluate(() => toggleSettings(false));
  // The model picker: open it from the card's model readout and type in its search box.
  const opened = await page.evaluate(() => {
    const stat = document.querySelector('.job[data-thread="wtgui-probe-reply-keys-4e71aa"] [data-model-pick]');
    if (!stat) return false;
    stat.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    return Boolean(document.querySelector(".model-pop .model-search"));
  });
  if (!opened) {
    note("(the model picker could not be opened on this card — skipped)");
  } else {
    await page.locator(".model-pop .model-search").focus();
    await page.keyboard.type("gpt");
    await page.keyboard.press("Control+Enter");
    await page.waitForTimeout(150);
    check("(5) Ctrl+Enter in the model picker's search holds nothing", await queueOf(), []);
    check("(5) Ctrl+Enter in the model picker's search steers nothing", (await steerPosts()).length, 0);
    check("(5) the reply box still holds its own draft", await boxValue(), "still the reply box's own text");
    note("(the picker's own Enter picks the highlighted model — unchanged, and its Ctrl+Enter was never the reply box's)");
    await page.keyboard.press("Escape");
  }
  check("(5) no page errors anywhere in this run", pageErrors, []);
  await browser.close();
  browserRef = null;
}

// ---- what can only be read off the source --------------------------------------------------------
function sourceChecks() {
  const src = readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const lines = src.split(/\r?\n/);
  const at = (needle) => lines.findIndex((l) => l.includes(needle));
  const guard = at('const box = e.target.closest && e.target.closest(".reply-box");');
  const shiftBranch = at('if (e.key === "Enter" && e.shiftKey) {');
  const ctrlBranch = at("&& steerOfferedFor(box)) {");
  const plainBranch = at('if (e.key === "Enter" && !e.shiftKey) {');
  ok("inspected: both branches sit inside the `.reply-box` handler", guard > 0 && ctrlBranch > guard && plainBranch > guard, `guard line ${guard + 1}, Ctrl branch ${ctrlBranch + 1}, Enter branch ${plainBranch + 1}`);
  ok("inspected: and after the Shift+Enter newline branch", shiftBranch > 0 && ctrlBranch > shiftBranch && plainBranch > shiftBranch, `shift line ${shiftBranch + 1}`);
  ok("inspected: the Ctrl/Cmd branch is the steer one, and comes first", ctrlBranch > 0 && plainBranch > ctrlBranch, `steer at ${ctrlBranch + 1}, hold at ${plainBranch + 1}`);
  const defs = lines.filter((l) => l.includes("function queueReplyFromBox(")).length;
  const calls = lines.filter((l) => /queueReplyFromBox\(/.test(l) && !l.includes("function queueReplyFromBox(")).length;
  check("inspected: queueReplyFromBox is defined once", defs, 1);
  check("inspected: and called from exactly two places — the button and the Enter branch", calls, 2);
  const steerDefs = lines.filter((l) => l.includes("function steerFromBox(")).length;
  const steerCalls = lines.filter((l) => /steerFromBox\(/.test(l) && !l.includes("function steerFromBox(")).length;
  check("inspected: steerFromBox is defined once", steerDefs, 1);
  check("inspected: and called from exactly two places — the button and the Ctrl/Cmd branch", steerCalls, 2);
  const clickAt = lines.findIndex((l) => l.includes('const queueBtn = e.target.closest("[data-queue-reply]");'));
  const clickCall = lines.findIndex((l, i) => i > clickAt && clickAt > 0 && l.includes("queueReplyFromBox(queueBtn.dataset.queueReply)"));
  ok("inspected: the Queue reply button's click path is that same call, with no body of its own", clickAt > 0 && clickCall > clickAt, `click path line ${clickAt + 1}, the call at ${clickCall + 1}`);
  const steerClickAt = lines.findIndex((l) => l.includes('const steerBtn = e.target.closest("[data-steer]");'));
  const steerClickCall = lines.findIndex((l, i) => i > steerClickAt && steerClickAt > 0 && l.includes("await steerFromBox("));
  ok("inspected: the Steer turn button's click path is that same call too", steerClickAt > 0 && steerClickCall > steerClickAt, `click path line ${steerClickAt + 1}, the call at ${steerClickCall + 1}`);
  const oldQueueBody = lines.some((l) => l.includes("// Clear the draft first: queueReply rebuilds the card"));
  check("inspected: the Queue reply button's old inline body is gone", oldQueueBody, false);
  const oldSteerBody = lines.some((l) => l.includes("await steerTurn(thread, steerBtn.dataset.steer"));
  check("inspected: the Steer turn button's old inline body is gone", oldSteerBody, false);
}

// ---- run -----------------------------------------------------------------------------------------
try {
  if (LIVE) {
    console.log("== driving the panel already running ==");
    note(`target ${LIVE} (nothing was booted; PANEL_URL was set)`);
    const up = await waitFor(async () => (await fetch(`${LIVE}/api/state`)).ok, { timeoutMs: 10_000, what: `${LIVE} to answer /api/state` });
    if (!up) throw new Error(`${LIVE} is not answering /api/state`);
  } else {
    console.log("== the sandbox ==");
    const port = await startSandbox();
    note(`temp root ${dir}`);
    note(`panel ${base} (this checkout's own server.js and public/)`);
    note(`nothing here reaches a gateway: apiServer is pinned at http://127.0.0.1:9 and the page's writes are stubbed`);
    check("the sandbox panel is the one that answered", (await fetch(`${base}/api/state`)).ok, true);
    note(`port ${port} — the live board on 7331 is not touched`);
  }

  console.log("\n== what can only be read off public/app.js ==");
  sourceChecks();

  console.log("\n== the browser: real keydown events over a real card ==");
  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN  the client half of this change was not exercised in a browser.");
    note("re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-reply-queue-keys.mjs");
    failures += 1;
  } else {
    await browserPhase(pw);
  }

  console.log("\n== summary ==");
  console.log(`${checks} checks, ${failures} failed`);
  console.log("\nWHAT WAS DRIVEN: a panel of this checkout (or PANEL_URL) plus headless Chromium over it, with real");
  console.log("key presses through CDP; the three card states built in the page's own state.jobs and rendered by the");
  console.log("shipped renderJobs/conversationHtml; every request the page would have made recorded by a stubbed fetch");
  console.log("(so no worker, no run and no steer ever left the page), and the keydowns themselves read back with their");
  console.log("modifiers to prove each branch was reached by a real Ctrl+Enter or Enter.");
  console.log("WHAT WAS INSPECTED, NOT DRIVEN: that both branches sit behind the .reply-box guard, that the steer branch");
  console.log("precedes the hold branch, and that each button's click path and its keystroke call one shared function —");
  console.log("read off public/app.js.");
  if (!failures) console.log("REPLY-QUEUE-KEYS-OK");
} catch (err) {
  failures += 1;
  console.log(`\nFAIL  the run threw: ${String((err && err.stack) || err)}`);
  if (panelLog.length) console.log(`--- panel log (tail)\n${panelLog.slice(-25).join("\n")}`);
} finally {
  if (process.env.VERIFY_KEEP === "1" && dir) {
    console.log(`VERIFY_KEEP=1 — leaving ${dir} in place`);
  } else {
    // The browser first: a leaked Chromium holds this script's event loop open, so the checks would print and
    // the run would never end — and the panel below would never be killed.
    if (browserRef) {
      try {
        await browserRef.close();
      } catch {
        /* already gone */
      }
      browserRef = null;
    }
    await stopSandbox();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      } catch (e) {
        console.log(`      (could not remove ${dir}: ${String((e && e.message) || e)})`);
      }
    }
  }
}
process.exitCode = failures ? 1 : 0;
