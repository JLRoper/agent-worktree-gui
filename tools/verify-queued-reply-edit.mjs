// Click a held reply to edit it: the queued entry's own text turns into a textarea in place, and what the panel later
// SENDS is the edited text — proved by driving a panel of its own in a real browser, with real clicks and real keys.
//
//   node tools/verify-queued-reply-edit.mjs                      boot a sandbox panel from THIS checkout
//   PANEL_URL=http://127.0.0.1:7331 node tools/verify-queued-reply-edit.mjs   drive a panel already running
//
// The card's held replies (`state.replyQueue`, drawn as `.ghost-turn` blocks) are the subject. Each check is a thing a
// reader does, and the evidence is the page's own state, the recorded request bodies and the before/after DOM:
//
//   (a) clicking a queued entry's text replaces THAT line with a textarea holding that entry's text, in place, with
//       the badge, the age and the rest of the card untouched — before/after DOM quoted
//   (b) editing and saving writes back to that one entry: the ghost text updates, the count and the age do not
//       restart (the entry keeps its `at`, so the age keeps counting from when it was first held)
//   (c) the reply actually sent after an edit carries the edited text — quoted from the request the page posted
//   (d) Escape and the Cancel button both put the original text back and change nothing else
//   (e) with two entries, editing and saving one leaves the other's text and its schedule alone
//   (f) an edit in progress when the turn ends: the entry is NOT sent, the card says so, the text stays in the box,
//       and saving afterwards sends the edited text
//   (g) saving an empty box removes that entry by the same removal path the × uses, and sends nothing
//   (h) the Enter/Ctrl+Enter gestures, the Queue reply button and a card with no held replies are unchanged; clicking
//       away means REVERT, every time
//   (i) the × that landed beside this (main ab2b51f) still takes one entry back — including on the entry the reader
//       has open in the editor, which closes with it — and never sends
//
// WHAT IS DRIVEN: a panel of this checkout (or PANEL_URL) plus headless Chromium over it, with real clicks
// (page.locator(...).click()), real key presses (page.keyboard.press -> CDP Input.dispatchKeyEvent) and the page's own
// fetch stubbed so every request is recorded instead of reaching a gateway. The card states are built in the PAGE's own
// state.jobs and rendered by the shipped renderJobs/conversationHtml, and "the turn ends" is driven through updateJob()
// — the exact function the panel's live stream calls for each job event.
// WHAT IS INSPECTED, NOT DRIVEN: that the editor's key handler is registered before the reply box's, that the empty
// save routes through the same removal the × uses, that the drain asks ONE guard, and that no editor branch calls
// sendReply/steerTurn — read off public/app.js.
//
// The browser half needs a Playwright install. Point the script at one with PANEL_PLAYWRIGHT_ROOT (a directory holding
// node_modules/playwright, or the package itself); without one the script says BROWSER-HALF-NOT-RUN and exits 2 rather
// than passing on a half that never ran.
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
const APP = readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

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
const quote = (label, text) => {
  console.log(`      ${label}`);
  for (const line of String(text).split("\n")) console.log(`        ${line}`);
};
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
const THREAD = "wtgui-probe-queued-edit-5c31d2";
let dir = null;
let panel = null;
let base = LIVE;
const panelLog = [];

async function startSandbox() {
  dir = mkdtempSync(path.join(tmpdir(), "wtgui-queued-edit-"));
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
        // Nothing this script drives may reach a gateway: the page's own fetch is stubbed for the writes, and this is
        // the belt to that brace — a probe that resolved a name would buy a real worker.
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

// ---- what can only be read off public/app.js -----------------------------------------------------
function sourceChecks() {
  const block = (from, to) => {
    const a = APP.indexOf(from);
    const b = to ? APP.indexOf(to, a + 1) : APP.length;
    return a < 0 || b < 0 ? "" : APP.slice(a, b);
  };
  const editorKeys = block('const box = e.target?.closest?.(".ghost-edit-box")', "// What the reader is typing");
  ok("the editor has its own key handler, and it was found in the source", editorKeys.length > 200, `${editorKeys.length} chars`);
  ok("(h) the editor's keys never send and never steer — no sendReply/steer call in that handler", !/sendReply|steerTurn|steerFromBox/.test(editorKeys));
  ok("(d) Escape cancels the edit (the revert path), and Shift+Enter is left to the textarea", /e\.key === "Escape"[\s\S]*cancelQueuedEdit/.test(editorKeys) && /e\.key === "Enter"[\s\S]*if \(!e\.shiftKey\)/.test(editorKeys));
  // The reply box's own handler comes later in the file, so the editor's keys are seen first.
  ok("the editor's handler is registered before the reply box's keydown handler", APP.indexOf('const box = e.target?.closest?.(".ghost-edit-box")') < APP.indexOf('const box = e.target.closest && e.target.closest(".reply-box")'));
  const save = block("function saveQueuedEdit(thread, at)", "// Leave the edit:");
  ok("(g) an empty save goes out by the same removal the × uses (takeQueuedReply), not its own splice", /takeQueuedReply\(thread, at\)/.test(save) && !/splice/.test(save));
  ok("(b) a save writes back to the entry it was opened on, by its `at`, and keeps that entry's timestamp", /findIndex\(\(e\) => e && e\.at === at\)/.test(save) && /q\[i\] = \{ \.\.\.q\[i\], text \}/.test(save));
  const drain = block("async function drainReplyQueue(thread)", "// ---- New-agent prompt history");
  ok("the drain asks ONE guard and names both reasons through it", /heldReplyBlocked\(thread, next\)/.test(drain));
  const guard = block("function heldReplyBlocked(thread, entry)", "// Children this thread started");
  ok("that one guard answers for a cancelled entry AND an entry being edited", /"cancelled"/.test(guard) && /"editing"/.test(guard));
  ok("(f) the drain holds an entry being edited instead of sending it, and says so in the log-free path (no send before the guard)", drain.indexOf("heldReplyBlocked") < drain.indexOf("sendReply"));
}

async function browserPhase(pw) {
  const pageErrors = [];
  const browser = await pw.chromium.launch({ headless: true });
  browserRef = browser;
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });

  const realSnapshot = await fetch(`${base}/api/state`).then((r) => r.json());
  await context.addInitScript(
    ({ snapshot, thread, t0 }) => {
      const realFetch = window.fetch.bind(window);
      const probe = { posts: [], keys: [], snapshot, t0 };
      window.__probe = probe;
      document.addEventListener(
        "keydown",
        (e) => {
          probe.keys.push({ key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, at: (e.target && (e.target.className || e.target.tagName)) || "" });
        },
        true,
      );
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      window.fetch = async (url, opts = {}) => {
        const u = String(url);
        const method = String((opts && opts.method) || "GET").toUpperCase();
        if (method !== "POST") {
          // Reads go to the panel, except the snapshot: it carries what this probe fabricated, so the page's own
          // safety-net resync cannot drop a card in the middle of a check.
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

      // The page's own job shape, as the renderer reads it.
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
        startedAt: new Date(Date.now() - 150_000).toISOString(),
        endedAt: o.status === "running" ? null : new Date(Date.now() - 30_000).toISOString(),
        model: "probe/model",
        lines: [],
        artifacts: [],
        attachments: [],
        subagents: o.subagents || [],
      });
      const card = () => document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
      probe.job = job;
      probe.card = (turns) => {
        state.jobs.clear();
        state.replyQueue.delete(thread);
        state.replyEdit = null;
        state.replyDrafts[thread] = "";
        for (const t of turns) state.jobs.set(t.id, job(t));
        renderJobs();
        const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
        if (box) box.focus();
        return Boolean(box);
      };
      // The turn starting or finishing, through the function the live stream itself calls for a job event.
      probe.update = (o) => {
        updateJob(job(o));
      };
      // Held replies with explicit identities, so a check can name the entry it means and the age is a known figure.
      probe.seed = (entries) => {
        state.replyEdit = null;
        state.replyQueue.set(thread, entries.map((e) => ({ text: e.text, at: e.at })));
        renderConversation(thread);
      };
      probe.queue = () => (state.replyQueue.get(thread) || []).map((e) => ({ text: e.text, at: e.at }));
      probe.edit = () => (state.replyEdit ? { ...state.replyEdit } : null);
      probe.ghosts = () => [...(card()?.querySelectorAll(".ghost-turn") || [])].map((g) => g.outerHTML);
      probe.ghostLines = () =>
        [...(card()?.querySelectorAll(".ghost-turn") || [])].map((g) => {
          const p = g.querySelector(".ghost-prompt");
          const b = g.querySelector(".ghost-edit-box");
          return p ? p.textContent : b ? `<EDITOR:${b.value}>` : "";
        });
      probe.ghostHeads = () => [...(card()?.querySelectorAll(".ghost-head") || [])].map((h) => h.outerHTML);
      probe.dimmers = () => [...(card()?.querySelectorAll(".ghost-head .dimmer") || [])].map((d) => d.textContent);
      probe.ages = () => [...(card()?.querySelectorAll(".queue-ago") || [])].map((el) => ({ at: el.dataset.queuedAt, text: el.textContent }));
      probe.note = () => card()?.querySelector(".queue-note")?.textContent ?? null;
      probe.warn = () => card()?.querySelector(`[data-reply-warn="${CSS.escape(thread)}"]`)?.textContent ?? null;
      probe.buttons = () => [...(card()?.querySelectorAll(".reply-actions button") || [])].map((b) => b.textContent);
      // The placeholder lives in data-ph now (the box is a div: :empty draws it), which is what the panel reads.
      probe.placeholder = () => card()?.querySelector(".reply-box")?.dataset.ph ?? null;
      probe.boxValue = () => {
        const box = card()?.querySelector(".reply-box");
        // The panel's own reader: the reply box is a contenteditable host now (it holds a pasted block as an
        // inline chip), so it has no `.value` to read.
        return box ? window.WMApp.board.pasteChips.readBox(box) : null;
      };
      // Everything in the card EXCEPT the held-reply block: the proof for (a) that the editor moved nothing else.
      probe.shell = () => {
        const c = card();
        if (!c) return null;
        const parts = [".job-head", ".reply-box", ".reply-actions"];
        return Object.fromEntries(parts.map((sel) => [sel, c.querySelector(sel)?.outerHTML ?? null]));
      };
      probe.editBox = () => {
        const b = card()?.querySelector(".ghost-edit-box");
        if (!b) return null;
        return { value: b.value, at: b.dataset.editQueued, thread: b.dataset.editThread, focused: document.activeElement === b, focusedAt: document.activeElement === b ? b.selectionStart : null };
      };
      probe.prompt = (at) => card()?.querySelector(`[data-edit-queued-open="${at}"]`)?.outerHTML ?? null;
      probe.saveBtn = (at) => card()?.querySelector(`[data-edit-save="${at}"]`)?.outerHTML ?? null;
      probe.cancelBtn = (at) => card()?.querySelector(`[data-edit-cancel="${at}"]`)?.outerHTML ?? null;
      probe.promptTitle = (at) => card()?.querySelector(`[data-edit-queued-open="${at}"]`)?.title ?? null;
      probe.promptTab = (at) => card()?.querySelector(`[data-edit-queued-open="${at}"]`)?.tabIndex ?? null;
      probe.hasEditor = () => Boolean(card()?.querySelector(".ghost-edit-box"));
      // How many times the board has rebuilt itself, so a check can say whether the card is being repainted constantly
      // under the reader (which is what a card does while a turn runs) rather than only when something changed.
      probe.renderTicks = 0;
      const realRenderJobs = window.renderJobs;
      window.renderJobs = function (...args) {
        probe.renderTicks += 1;
        return realRenderJobs.apply(this, args);
      };
    },
    { snapshot: realSnapshot, thread: THREAD, t0: Date.now() },
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

  const cardSel = `.job[data-thread="${THREAD}"]`;
  const boxSel = `${cardSel} .reply-box`;
  const T1 = Date.now() - 200_000; // a fixed identity for entry 1
  const T2 = T1 + 1000; // …and for entry 2, one second later
  // The displayed age ticks with the clock, so a comparison of two readings has to normalise that one number out and
  // check the identity (`at`) beside it — otherwise a run that straddles a second boundary fails on the clock.
  const noAge = (html) => String(html).replace(/(<span class="queue-ago"[^>]*>)[^<]*(<\/span>)/, "$1…$2");
  // A running turn's pill names how long it has been running, and the held-reply note's tooltip lists the held texts —
  // and an edit legitimately changes the second one. Both are normalised out, so "the rest of the card did not move"
  // stays a check about the card's structure rather than about the clock or about the edit the check just made.
  const norm = (parts) =>
    Object.fromEntries(
      Object.entries(parts).map(([k, v]) => [k, String(v).replace(/running \d+m\d+s/g, "running …").replace(/title="\d+\.[^"]*"/g, 'title="…"')]),
    );
  // The badge and the age span of a held entry, without the line that follows them: that line is the one thing an
  // editor deliberately rewrites (it can no longer promise a send while the reader is in the box).
  const badgeAge = (head) => String(head).replace(/<span class="dimmer">[\s\S]*<\/span>/, "");

  const A = "held reply A — the text as it was queued";
  const B = "held reply B — a second held reply";

  const posts = () => page.evaluate(() => window.__probe.posts.map((p) => ({ url: p.url, body: p.body })));
  const clearPosts = () => page.evaluate(() => { window.__probe.posts.length = 0; });
  const replyPosts = async () => (await posts()).filter((p) => p.url.includes("/api/agents/reply"));
  const queue = () => page.evaluate(() => window.__probe.queue());
  const ghosts = () => page.evaluate(() => window.__probe.ghosts());
  const ghostLines = () => page.evaluate(() => window.__probe.ghostLines());
  const ghostHeads = () => page.evaluate(() => window.__probe.ghostHeads());
  const dimmers = () => page.evaluate(() => window.__probe.dimmers());
  const ages = () => page.evaluate(() => window.__probe.ages());
  const note_ = () => page.evaluate(() => window.__probe.note());
  const warn = () => page.evaluate(() => window.__probe.warn());
  const buttons = () => page.evaluate(() => window.__probe.buttons());
  const placeholder = () => page.evaluate(() => window.__probe.placeholder());
  const boxValue = () => page.evaluate(() => window.__probe.boxValue());
  const shell = () => page.evaluate(() => window.__probe.shell());
  const editBox = () => page.evaluate(() => window.__probe.editBox());
  const editState = () => page.evaluate(() => window.__probe.edit());
  const promptOf = (at) => page.evaluate((a) => window.__probe.prompt(a), at);
  const hasEditor = () => page.evaluate(() => window.__probe.hasEditor());
  const makeCard = async (turns) => {
    const made = await page.evaluate((t) => window.__probe.card(t), turns);
    await page.waitForTimeout(120);
    return made;
  };
  const seed = async (entries) => {
    await page.evaluate((e) => window.__probe.seed(e), entries);
    await page.waitForTimeout(80);
  };
  const update = async (o) => {
    await page.evaluate((x) => window.__probe.update(x), o);
    await page.waitForTimeout(250);
  };
  const clickPrompt = async (at) => {
    await page.locator(`${cardSel} [data-edit-queued-open="${at}"]`).click();
    await page.waitForTimeout(150);
  };
  const clickSave = async (at) => {
    await page.locator(`${cardSel} [data-edit-save="${at}"]`).click();
    await page.waitForTimeout(250);
  };
  const clickCancel = async (at) => {
    await page.locator(`${cardSel} [data-edit-cancel="${at}"]`).click();
    await page.waitForTimeout(200);
  };
  const typeInEditor = async (text) => {
    // The box is focused the way the reader's own click focuses it, and every character after that is a real key
    // event into it. (Playwright's locator.fill() waits on actionability checks against one node, and this panel
    // rebuilds a card's markup wholesale while a turn runs — the keyboard path is both more faithful to "the keyboard
    // must work" and immune to the node under it being replaced mid-typing.)
    await page.evaluate((sel) => {
      const b = document.querySelector(sel);
      if (b) {
        b.focus();
        b.select();
      }
    }, `${cardSel} .ghost-edit-box`);
    await page.keyboard.press("Delete"); // the selected text goes, and the page hears an input event for it
    if (text) await page.keyboard.insertText(text); // one real text-input event per character
    await page.waitForTimeout(120);
  };
  const keyInEditor = async (combo) => {
    await page.locator(`${cardSel} .ghost-edit-box`).focus();
    await page.keyboard.press(combo);
    await page.waitForTimeout(250);
  };
  const BUSY = [{ id: "probe-run", status: "running" }];
  const DONE = [{ id: "probe-run", status: "done" }];
  const OLD = (ms) => Date.now() - ms;

  // ================= (a) click the held text, get a textarea in place ==============================
  console.log("\n== (a) clicking a queued entry's text turns that line into a textarea, in place ==");
  ok("the card renders with its reply box", await makeCard(BUSY));
  await seed([{ text: A, at: OLD(90_000) }]);
  const atA = (await queue())[0].at;
  const shellBefore = await shell();
  const promptHtml = await promptOf(atA);
  const headBefore = (await ghostHeads())[0];
  const noteBefore = await note_();
  const agesBefore = await ages();
  const buttonsBefore = await buttons();
  const placeholderBefore = await placeholder();
  check("(a) the entry renders as a ghost line (no editor yet)", await ghostLines(), [A]);
  check("(a) the entry's text is the handle — it says so", await page.evaluate((a) => window.__probe.promptTitle(a), atA), "click to edit this held reply");
  check("(a) and it is reachable from the keyboard, not click-only", await page.evaluate((a) => window.__probe.promptTab(a), atA), 0);
  quote("BEFORE — the held entry's own line:", promptHtml);
  await clickPrompt(atA);
  const editorNow = await editBox();
  ok("(a) a textarea is there, focused, seeded with that entry's text", editorNow && editorNow.value === A && editorNow.focused, JSON.stringify(editorNow));
  check("(a) it is the same thread and the same entry (its `at`)", { thread: editorNow.thread, at: editorNow.at }, { thread: THREAD, at: String(atA) });
  check("(a) the caret is at the end of the text, ready to add to it", editorNow.focusedAt, A.length);
  const promptAfter = await promptOf(atA);
  check("(a) the ghost line is gone from that entry (replaced, not duplicated)", promptAfter, null);
  const ghostHtmlAfter = (await ghosts())[0];
  quote("AFTER — the same entry, with the editor in place of its text:", ghostHtmlAfter);
  check("(a) the badge and the age are untouched, byte for byte", noAge(badgeAge((await ghostHeads())[0])), noAge(badgeAge(headBefore)));
  ok(
    "(a) the line above the text says the entry is held while it is edited, instead of promising a send",
    /not sent while you edit it/.test((await dimmers())[0]),
    (await dimmers())[0],
  );
  check("(a) the count note is untouched", await note_(), noteBefore);
  check("(a) the age is still the entry's own reading", (await ages()).map((x) => x.at), agesBefore.map((x) => x.at));
  check("(a) the card's head, reply box and buttons are byte-identical", norm(await shell()), norm(shellBefore));
  check("(a) and nothing was sent by opening the editor", await posts(), []);

  // the same editor, opened from the keyboard on the same line
  await keyInEditor("Escape");
  check("(keyboard) Escape closed it and put the ghost line back", await ghostLines(), [A]);
  await page.locator(`${cardSel} [data-edit-queued-open="${atA}"]`).focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  ok("(keyboard) Enter on the focused held line opens the same editor", (await editBox())?.value === A);
  await keyInEditor("Escape");

  // ================= (b) save writes back to that one entry, and the age does not restart ===========
  console.log("\n== (b) edit, save: the ghost text changes and the count and age stay put ==");
  const EDITED = "held reply A — edited before it ever went out";
  await clickPrompt(atA);
  await typeInEditor(EDITED);
  check("(b) the typed text is held on state as it is typed (a repaint cannot lose it)", (await editState())?.text, EDITED);
  await keyInEditor("Enter");
  check("(b) Enter saved: the editor is gone and the line shows the edited text", await ghostLines(), [EDITED]);
  check("(b) exactly one entry, still keyed by its own `at` — an edit is not a re-queue", await queue(), [{ text: EDITED, at: atA }]);
  check("(b) the age still counts from the original `at`", (await ages()).map((x) => x.at), agesBefore.map((x) => x.at));
  ok("(b) and it reads as the ~90s old reply it was, not as a new one", /^1m\d\ds$/.test((await ages())[0].text), (await ages())[0].text);
  check("(b) the count note is unchanged", await note_(), noteBefore);
  check("(b) the card outside the held block is untouched", norm(await shell()), norm(shellBefore));
  check("(b) saving while the turn runs sends nothing", await posts(), []);

  // Shift+Enter is a newline, and a multi-line save keeps the whole text
  await clickPrompt(atA);
  await typeInEditor("line one");
  await keyInEditor("Shift+Enter");
  const afterShift = (await editBox())?.value;
  ok("(b) Shift+Enter is a newline in the editor, not a save", /line one\n$/.test(afterShift), JSON.stringify(afterShift));
  ok("(b) and it did not save: the editor is still open", await hasEditor(), true);
  check("(b) Shift+Enter sent nothing", await posts(), []);
  await keyInEditor("Enter");
  check("(b) the multi-line edit is what the entry now holds", (await queue())[0].text, "line one");
  await clickPrompt(atA);
  await typeInEditor(EDITED);
  await keyInEditor("Enter");
  check("(b) put back to the single-line edit for the checks below", await ghostLines(), [EDITED]);

  // ================= (d) Escape, Cancel, and clicking away all revert ===============================
  console.log("\n== (d) Escape and Cancel put the original text back and change nothing else ==");
  await clickPrompt(atA);
  await typeInEditor("this must never be written anywhere");
  await keyInEditor("Escape");
  check("(d) Escape: the entry is exactly the text it had when the editor opened", await queue(), [{ text: EDITED, at: atA }]);
  check("(d) and the card shows that text again", await ghostLines(), [EDITED]);
  check("(d) Escape sent nothing and left no editor", { posts: await posts(), editor: await hasEditor() }, { posts: [], editor: false });
  check("(d) nothing else on the card moved", norm(await shell()), norm(shellBefore));
  check("(d) no editor is open on state either", await editState(), null);
  const keysSeen = await page.evaluate(() => window.__probe.keys.slice(-1)[0]);
  ok("(d) the page saw a real Escape", keysSeen && keysSeen.key === "Escape", JSON.stringify(keysSeen));

  await clickPrompt(atA);
  await typeInEditor("nor this one");
  await clickCancel(atA);
  check("(d) Cancel (mouse): the entry is back to the text it opened on", await queue(), [{ text: EDITED, at: atA }]);
  check("(d) and Cancel sent nothing", await posts(), []);

  await clickPrompt(atA);
  await typeInEditor("nor anything typed just before clicking away");
  await page.mouse.click(1400, 950); // empty page, away from the card
  await page.waitForTimeout(250);
  check("(choice in (6)) clicking away REVERTS, the same thing Escape does", await queue(), [{ text: EDITED, at: atA }]);
  check("(choice in (6)) and it sent nothing", await posts(), []);
  check("(choice in (6)) the editor is closed", await hasEditor(), false);

  // ================= (e) two entries stay independent ==============================================
  console.log("\n== (e) two held replies: editing one leaves the other's text and schedule alone ==");
  await seed([{ text: A, at: T1 }, { text: B, at: T2 }]);
  check("two entries render, in order", await ghostLines(), [A, B]);
  const headsTwo = await ghostHeads();
  const agesTwo = await ages();
  await clickPrompt(T1);
  check("(e) the editor opened on the FIRST entry", (await editBox())?.at, String(T1));
  const A2 = "entry one, edited";
  await typeInEditor(A2);
  await clickSave(T1);
  check("(e) the first entry carries the edit", await queue(), [{ text: A2, at: T1 }, { text: B, at: T2 }]);
  check("(e) the second entry's text is untouched", await ghostLines(), [A2, B]);
  check("(e) its own age reading is untouched (same `at`)", (await ages())[1].at, agesTwo[1].at);
  check("(e) and the first entry's age did not restart", (await ages())[0].at, String(T1));
  ok("(e) the head of the second entry — badge, age identity and line — is byte-identical", noAge((await ghostHeads())[1]) === noAge(headsTwo[1]), noAge(headsTwo[1]));
  await clearPosts();
  await clickPrompt(T2);
  check("(e) opening the SECOND entry's editor names the second entry", (await editBox())?.at, String(T2));
  await typeInEditor("entry two, edited");
  await clickSave(T2);
  check("(e) both entries now hold their own edits", await queue(), [{ text: A2, at: T1 }, { text: "entry two, edited", at: T2 }]);
  check("(e) and none of that sent anything (the turn is still running)", await posts(), []);

  // ================= (c) the sent request carries the edited text ===================================
  console.log("\n== (c) the turn ends: the request the panel posts carries the edited text ==");
  await seed([{ text: A, at: T1 }]);
  await clickPrompt(T1);
  const SENT_BODY = "held reply A — as edited by the reader";
  await typeInEditor(SENT_BODY);
  await keyInEditor("Enter");
  await clearPosts();
  await update({ id: "probe-run", status: "done" }); // the exact call the live stream makes when the turn ends
  await page.waitForTimeout(300);
  const sent = await replyPosts();
  check("(c) exactly one reply was posted, and nothing else", (await posts()).length, 1);
  quote("THE REQUEST BODY THE PANEL POSTED:", JSON.stringify(sent[0]?.body, null, 2));
  check("(c) the sent body carries the EDITED text, character for character", sent[0]?.body?.text, SENT_BODY);
  check("(c) to this thread", sent[0]?.body?.thread, THREAD);
  check("(c) and the entry left the queue after the send", await queue(), []);
  check("(c) the held block is gone from the card", await ghostLines(), []);
  check("(c) no editor was left behind", await hasEditor(), false);

  // ================= (f) an edit in progress when the turn ends =====================================
  console.log("\n== (f) the turn ends while the editor is open: held, said so, and sent on save ==");
  await makeCard(BUSY);
  await seed([{ text: A, at: OLD(90_000) }]);
  const atF = (await queue())[0].at;
  const ticksBefore = await page.evaluate(() => window.__probe.renderTicks);
  await clickPrompt(atF);
  const MID_EDIT = "typed while the turn ran — the turn then finished under me";
  await typeInEditor(MID_EDIT);
  await clearPosts();
  await update({ id: "probe-run", status: "done" }); // the drain fires here
  await page.waitForTimeout(300);
  check("(f) nothing was sent while the entry was being edited", await posts(), []);
  check("(f) the entry is still held, with the text it was queued as (an unfinished edit is not written)", await queue(), [{ text: A, at: atF }]);
  check("(f) the editor is still open, holding what the reader typed", (await editBox())?.value, MID_EDIT);
  ok("(f) and the text is still on state, so the repaint did not lose it", (await editState())?.text === MID_EDIT, JSON.stringify(await editState()));
  const said = (await dimmers())[0];
  quote("WHAT THE CARD SAID WHEN THE TURN ENDED MID-EDIT:", said);
  ok("(f) the card says the turn has finished and the reply waits for the edit", /the turn has finished/.test(said) && /save/.test(said), said);
  check("(f) the age kept counting through all of it (same `at`)", (await ages())[0].at, String(atF));
  note(`the board rebuilt itself ${(await page.evaluate(() => window.__probe.renderTicks)) - ticksBefore} time(s) across these steps — a card repaints as its turn's events land, which is why the editor is drawn from state rather than from the DOM a repaint would take away`);
  // saving now makes it sendable again, by the mouse this time
  await clickSave(atF);
  const sentAfterEdit = await replyPosts();
  check("(f) the Save button sent exactly one reply", sentAfterEdit.length, 1);
  quote("THE REQUEST BODY AFTER SAVING MID-EDIT:", JSON.stringify(sentAfterEdit[0]?.body, null, 2));
  check("(f) carrying the text the reader finished editing", sentAfterEdit[0]?.body?.text, MID_EDIT);
  check("(f) and the queue is empty again", await queue(), []);

  // ================= (g) an empty save is the × ====================================================
  console.log("\n== (g) saving an empty box removes that entry, by the same removal the × uses ==");
  await makeCard(BUSY);
  await seed([{ text: A, at: T1 }]);
  await clearPosts();
  const atG = (await queue())[0].at;
  await clickPrompt(atG);
  await typeInEditor("");
  await keyInEditor("Enter");
  check("(g) the entry is gone from the queue", await queue(), []);
  check("(g) the held block is gone from the card", await ghostLines(), []);
  check("(g) the count note is gone with it", await note_(), null);
  check("(g) an empty save sends nothing", await posts(), []);
  const goneSay = await warn();
  quote("WHAT THE CARD SAID ABOUT AN EMPTY SAVE:", goneSay);
  ok("(g) and the card says so rather than going quiet", /saved empty/.test(String(goneSay)), String(goneSay));
  // with two entries, emptying one leaves the other alone
  await seed([{ text: A, at: T1 }, { text: B, at: T2 }]);
  await clickPrompt(T2);
  await typeInEditor("   ");
  await clickSave(T2);
  check("(g) the emptied one went and the other is still held, as it was", await queue(), [{ text: A, at: T1 }]);
  check("(g) still a single held entry on the card", await ghostLines(), [A]);
  check("(g) and still nothing sent (the turn is running)", await posts(), []);

  // ================= (h) nothing else moved =========================================================
  console.log("\n== (h) the other gestures, the button, and a card with no held replies ==");
  await makeCard(BUSY);
  check("(h) a card with no held replies has no held block at all", await page.locator(`${cardSel} .ghost-turns`).count(), 0);
  check("(h) and no editor markup anywhere", await hasEditor(), false);
  const controls = await buttons();
  check("(h) its reply controls are the three they were: steer, queue", controls.length, 3);
  ok("(h) …which are Steer turn, Queue reply, Cancel turn", controls[0] === "Steer turn" && controls[1] === "Queue reply" && controls[2] === "Cancel turn", JSON.stringify(controls));
  check("(h) no queued note is drawn", await note_(), null);
  const placeholderIdle = await placeholder();
  ok("(h) and the placeholder still names the two gestures", /Ctrl\+Enter steers it; Enter holds yours/.test(placeholderIdle), placeholderIdle);
  // Enter still holds a reply.
  await clearPosts();
  await page.locator(boxSel).fill("this is held, not sent");
  await page.locator(boxSel).focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  check("(h) Enter still queues the reply", (await queue()).map((q) => q.text), ["this is held, not sent"]);
  check("(h) with no request at all", await posts(), []);
  check("(h) and no editor was opened by it", await hasEditor(), false);
  ok("(h) the freshly held reply draws the standard line", (await dimmers())[0] === "sends when the current turn finishes", (await dimmers())[0]);
  // Ctrl+Enter still steers the live turn.
  await clearPosts();
  await page.locator(boxSel).fill("steer this into the live turn");
  await page.locator(boxSel).focus();
  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(250);
  const steered = (await posts()).filter((p) => p.url.includes("/api/jobs/steer"));
  check("(h) Ctrl+Enter still steers exactly once", (await posts()).length, 1);
  check("(h) naming the live turn, with the typed text unchanged", { id: steered[0]?.body?.id, text: steered[0]?.body?.text }, { id: "probe-run", text: "steer this into the live turn" });
  check("(h) and it held nothing", (await queue()).map((q) => q.text), ["this is held, not sent"]);
  // The Queue reply button is unchanged.
  await clearPosts();
  await page.locator(boxSel).fill("and this one from the button");
  await page.locator(`${cardSel} [data-queue-reply]`).click();
  await page.waitForTimeout(200);
  check("(h) the Queue reply button holds it the same way", (await queue()).map((q) => q.text), ["this is held, not sent", "and this one from the button"]);
  check("(h) still no request from either press", await posts(), []);
  // …and the two entries it just made are independently editable, one at a time.
  const twoAt = await queue();
  await clickPrompt(twoAt[1].at);
  check("(h) the button's entry opens its own editor", (await editBox())?.at, String(twoAt[1].at));
  check("(h) with the button's text in it", (await editBox())?.value, "and this one from the button");
  await clickCancel(twoAt[1].at);
  check("(h) canceling it leaves the other exactly as it was", await queue(), twoAt);

  // ================= (i) the × landed beside this, and it still works on an entry being edited ======
  console.log("\n== (i) the × on the entry's own line, alongside the editor ==");
  await makeCard(BUSY);
  await seed([{ text: A, at: T1 }, { text: B, at: T2 }]);
  await clearPosts();
  await clickPrompt(T1);
  check("(i) the entry being edited still carries its own ×", await page.locator(`${cardSel} [data-queue-cancel-at="${T1}"]`).count(), 1);
  check("(i) and the entry behind it keeps its own", await page.locator(`${cardSel} [data-queue-cancel-at="${T2}"]`).count(), 1);
  await typeInEditor("edited, then taken back with the ×");
  check("(i) the × is not disabled by the open editor", await page.locator(`${cardSel} [data-queue-cancel-at="${T1}"]`).isEnabled(), true);
  await page.locator(`${cardSel} [data-queue-cancel-at="${T1}"]`).click();
  await page.waitForTimeout(250);
  check("(i) the × takes that one entry back, mid-edit", await queue(), [{ text: B, at: T2 }]);
  check("(i) and the editor it had open is closed with it", await hasEditor(), false);
  check("(i) nothing was sent by any of that", await posts(), []);
  check("(i) the other held reply is untouched", await ghostLines(), [B]);

  check("no page errors anywhere in this run", pageErrors, []);
  await browser.close();
  browserRef = null;
}

// ---- run ------------------------------------------------------------------------------------------
try {
  if (LIVE) {
    console.log(`driving the panel already running at ${LIVE}`);
  } else {
    const port = await startSandbox();
    note(`temp root ${dir}`);
    note(`panel ${base} (this checkout's own server.js and public/)`);
    note(`nothing here reaches a gateway: apiServer is pinned at http://127.0.0.1:9 and the page's writes are stubbed`);
    check("the sandbox panel is the one that answered", (await fetch(`${base}/api/state`)).ok, true);
    note(`port ${port} — the live board on 7331 is not touched`);
  }

  console.log("\n== what can only be read off public/app.js ==");
  sourceChecks();

  console.log("\n== the browser: real clicks and real keys over a real card ==");
  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN  the client half of this change was not exercised in a browser.");
    note("re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-queued-reply-edit.mjs");
    failures += 1;
  } else {
    await browserPhase(pw);
  }

  console.log("\n== summary ==");
  console.log(`${checks} checks, ${failures} failed`);
  console.log("\nWHAT WAS DRIVEN: a panel of this checkout (or PANEL_URL) plus headless Chromium over it, with real clicks");
  console.log("and key presses through CDP; the card and its held replies built in the page's own state and rendered by the");
  console.log("shipped conversationHtml; the turn ending driven through updateJob() — the function the live stream calls;");
  console.log("every request the page would have made recorded by a stubbed fetch, so the body in (c) is the request the");
  console.log("panel really posts and no worker, run or steer ever left the page.");
  console.log("WHAT WAS INSPECTED, NOT DRIVEN: the order of the two keydown handlers, the empty save routing through the");
  console.log("same removal the × uses, the drain asking one guard, and no editor branch calling sendReply/steerTurn — read");
  console.log("off public/app.js.");
  if (!failures) console.log("QUEUED-REPLY-EDIT-OK");
} catch (err) {
  failures += 1;
  console.log(`\nFAIL  the run threw: ${String((err && err.stack) || err)}`);
  if (panelLog.length) console.log(`--- panel log (tail)\n${panelLog.slice(-25).join("\n")}`);
} finally {
  if (process.env.VERIFY_KEEP === "1" && dir) {
    console.log(`VERIFY_KEEP=1 — leaving ${dir} in place`);
  } else {
    // The browser first: a leaked Chromium holds this script's event loop open, so the checks would print and the run
    // would never end — and the panel below would never be killed.
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
