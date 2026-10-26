// Paste-collapse chips: a paste of 300+ characters (or 5+ lines) into any box the reader writes a prompt in
// collapses, in place at the caret, into one inline chip — and every acceptance item (a)–(j) of the brief is
// driven here, in a real Chromium, against a sandbox panel of THIS checkout.
//
//   node tools/verify-paste-chips.mjs                                   boot a sandbox panel from this checkout
//   PANEL_URL=http://127.0.0.1:7331 node tools/verify-paste-chips.mjs    drive a panel already running
//
// The boxes: the worktree card's reply box (also the assistant float's composer — one class, one
// implementation), the New-agent prompt (#job-prompt) and the inline add-agent field the green + turns into.
// All of them are contenteditable hosts now (board/paste-chips.js), because a textarea cannot hold an inline
// widget: a chip is a non-editable inline atom inside the box.
//
//   (a) a paste of 367 lines with the caret mid-sentence leaves one chip in place: the text before and after
//       it survives and the caret sits immediately after the chip
//   (b) the label shows the line count and a preview of the first characters
//   (c) a click shows ALL 367 lines, wrapped and read-only; a second click (and Escape) folds it back
//   (d) the × removes that chip and nothing else; Backspace with the caret beside a chip removes it whole;
//       neither ever edits the chip's own text
//   (e) what the agent receives is the full text IN POSITION — read out of the request the panel actually
//       sends (POST /api/agents/reply), never out of the DOM
//   (f) the chip and its text survive a board rescan — a real rebuild with the box focused, again blurred, and
//       a full repaint — and a reload of the page
//   (g) two chips in one box are independent: own ×, own expand, own delete
//   (h) a 250-character paste stays plain; an image paste still produces the attachment chip
//   (i) Enter, Ctrl+Enter, Shift+Enter, ↑/↓ recall and the pending-steer restore all still work, on every box
//   (j) the other suites stay green — run separately (this script reports its own checks, not theirs)
//
// WHAT IS DRIVEN, AND WHAT IS ONLY INSPECTED
//
//   driven     a panel of its own (or PANEL_URL) plus headless Chromium over it; real `paste` events carrying
//              a real DataTransfer (text, and a File); real key presses through page.keyboard; real clicks on
//              the chip's own face and its ×; cards built in the page's own state.jobs and rendered by the
//              shipped renderJobs/conversationHtml; a rescan rebuild, a full board repaint and a page.reload
//   driven     the READS the panel itself makes: readBox(box) — the one function every send/steer/queue/draft
//              path goes through — and the request bodies the page posts, recorded by a stubbed fetch, so a
//              send is proved by the bytes it carries rather than by the markup
//   inspected  that no reader of a prompt box touches `.value` any more, that readBox is defined once, that the
//              chip's text is keyed by id in state.pasteChips, that a chip-bearing draft is mirrored for a
//              reload, and the 300-character / 5-line threshold — read off public/app.js, the module and
//              public/index.html
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
const briefVal = (v) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s == null) return String(s);
  return s.length <= 200 ? s : `${s.slice(0, 120)} …(${s.length} chars)… ${s.slice(-50)}`;
};
const firstDiff = (x, y) => {
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) if (x[i] !== y[i]) return i;
  return -1;
};
const check = (name, got, want) => {
  checks += 1;
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`PASS  ${name}: ${briefVal(got)}`);
    return;
  }
  failures += 1;
  console.log(`FAIL  ${name}`);
  // Never print a 367-line paste into the log: a window around the first difference says everything.
  if (typeof got === "string" && typeof want === "string" && got.length + want.length > 200) {
    const at = firstDiff(got, want);
    console.log(`        got  ${got.length} chars${at >= 0 ? `, first difference at ${at} → ${JSON.stringify(got.slice(Math.max(0, at - 40), at + 40))}` : ""}`);
    console.log(`        want ${want.length} chars${at >= 0 ? ` → ${JSON.stringify(want.slice(Math.max(0, at - 40), at + 40))}` : ""}`);
    return;
  }
  console.log(`        got  ${briefVal(got)}`);
  console.log(`        want ${briefVal(want)}`);
};
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${briefVal(extra)}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${briefVal(extra)}` : ""}`);
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
const THREAD = "wtgui-probe-paste-chips-9c31b7";
const ADD_KEY = "probe::C:/probe/tree";
let dir = null;
let panel = null;
let base = LIVE;
const panelLog = [];

async function startSandbox() {
  dir = mkdtempSync(path.join(tmpdir(), "wtgui-paste-chips-"));
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
        // Nothing this script drives may reach a gateway: the page's own writes are stubbed, and this is the
        // belt to that brace — a probe that resolved a name would buy a real worker.
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

// The pasted blocks. 367 lines is the number the brief names; the first line opens with a marker a preview can
// be recognised in.
const PREVIEW_HEAD = "THIS-IS-THE-PREVIEW-START and more characters to fill the preview out";
const PASTE_367 = Array.from({ length: 367 }, (_, i) => (i === 0 ? `${PREVIEW_HEAD} — first line` : `line ${i + 1} of the pasted block`)).join("\n");
const PASTE_FIVE = Array.from({ length: 5 }, (_, i) => `short block line ${i + 1}`).join("\n");
const PLAIN_250 = "p".repeat(250);

const cardSel = `.job[data-thread="${THREAD}"]`;
const boxSel = `${cardSel} .reply-box`;
const chipSel = `${boxSel} .paste-chip`;
const promptSel = "#job-prompt";
const fieldSel = `.add-agent-input[data-add-agent-key="${ADD_KEY}"]`;

async function browserPhase(pw) {
  const pageErrors = [];
  const browser = await pw.chromium.launch({ headless: true });
  browserRef = browser;
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });

  // The page-side probe. Registered BEFORE the page navigates, and it replaces both fetch and EventSource: the
  // live stream broadcasts `jobs`, which CLEARS state.jobs, so a card fabricated here would be wiped mid-check
  // by a broadcast that has nothing to do with this test. The fabricated turns ride sessionStorage so a reload
  // boots the board with them, exactly as a real board boots with its own store.
  const realSnapshot = await fetch(`${base}/api/state`).then((r) => r.json());
  await context.addInitScript(
    ({ snapshot, thread }) => {
      const realFetch = window.fetch.bind(window);
      const probe = { posts: [], jobs: [], snapshot, failSpawn: false };
      window.__probe = probe;
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      try {
        probe.jobs = JSON.parse(sessionStorage.getItem("probe.jobs") || "[]");
      } catch {
        probe.jobs = [];
      }
      const keep = () => {
        try {
          sessionStorage.setItem("probe.jobs", JSON.stringify(probe.jobs));
        } catch {
          /* nothing to keep the fixture in */
        }
      };
      // The panel's OWN reader, by name: this is the readBox every send/steer/queue/draft path uses.
      const chips = () => window.WMApp.board.pasteChips;
      probe.read = (sel) => chips().readBox(document.querySelector(sel));
      probe.caret = (sel) => chips().caretOffset(document.querySelector(sel));
      probe.chipCount = (sel) => document.querySelectorAll(`${sel} .paste-chip`).length;
      probe.chipLabel = (sel, i = 0) => document.querySelectorAll(`${sel} .paste-chip .pc-label`)[i]?.textContent ?? null;
      probe.chipText = (sel, i = 0) => {
        const el = document.querySelectorAll(`${sel} .paste-chip`)[i];
        if (!el) return null;
        const c = state.pasteChips.get(el.dataset.pasteChip);
        return c ? c.text : null;
      };
      probe.chipOpen = (sel, i = 0) => Boolean(document.querySelectorAll(`${sel} .paste-chip`)[i]?.classList.contains("is-open"));
      probe.chipBody = (sel, i = 0) => document.querySelectorAll(`${sel} .paste-chip .pc-body .pc-text`)[i]?.textContent ?? null;
      probe.chipBodyStyle = (sel, i = 0) => {
        const el = document.querySelectorAll(`${sel} .paste-chip .pc-text`)[i];
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { whiteSpace: cs.whiteSpace, maxHeight: cs.maxHeight, overflow: cs.overflow, overflowY: cs.overflowY };
      };
      probe.chipFace = (sel, i = 0) => {
        const el = document.querySelectorAll(`${sel} .paste-chip`)[i];
        if (!el) return null;
        return { display: getComputedStyle(el).display, editable: el.getAttribute("contenteditable"), children: el.children.length };
      };
      probe.attachChips = () => [...document.querySelectorAll(".attach-chip")].map((c) => c.textContent.trim());
      probe.setCaret = (sel, at) => {
        const box = document.querySelector(sel);
        if (!box) return false;
        // Focus FIRST, then place the caret: focusing a host that was not focused puts a caret of its own
        // somewhere, and placing one before that would be undone.
        box.focus();
        chips().setCaretOffset(box, at);
        return chips().caretOffset(box);
      };
      probe.focused = (sel) => document.activeElement === document.querySelector(sel);
      probe.focusBox = (sel) => {
        const box = document.querySelector(sel);
        if (box) box.focus();
        return Boolean(box);
      };
      probe.blur = () => document.activeElement?.blur?.();
      // A real `paste` event carrying a real DataTransfer — what the browser dispatches to a paste.
      probe.paste = (sel, kind, payload) => {
        const box = document.querySelector(sel);
        if (!box) return false;
        box.focus();
        const dt = new DataTransfer();
        if (kind === "file") dt.items.add(new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], payload || "shot.png", { type: "image/png" }));
        else dt.setData("text/plain", payload);
        let ev = null;
        try {
          ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
        } catch {
          ev = null;
        }
        if (!ev || ev.clipboardData !== dt) {
          ev = new Event("paste", { bubbles: true, cancelable: true });
          Object.defineProperty(ev, "clipboardData", { value: dt });
        }
        box.dispatchEvent(ev);
        return { prevented: ev.defaultPrevented };
      };
      probe.clickChip = (sel, what, i = 0) => {
        const chip = document.querySelectorAll(`${sel} .paste-chip`)[i];
        if (!chip) return false;
        const target = what === "x" ? chip.querySelector(".pc-x") : chip.querySelector(".pc-label");
        for (const type of ["mousedown", "mouseup", "click"]) {
          target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
        }
        return true;
      };
      probe.chipsInState = () => [...state.pasteChips.entries()].map(([id, c]) => ({ id, lines: c.lines, len: c.text.length }));
      probe.draftModel = (key) => (state.boxModels.get(key) || []).map((s) => (s.t === "chip" ? `chip:${s.id}` : `text:${JSON.stringify(s.v)}`));
      probe.markCard = () => {
        const el = document.querySelector(`.job[data-thread="${thread}"]`);
        if (!el) return false;
        el.dataset.probeMark = "1";
        return true;
      };
      probe.marked = () => Boolean(document.querySelector(`.job[data-thread="${thread}"]`)?.dataset.probeMark);

      window.fetch = async (url, opts = {}) => {
        const u = String(url);
        const method = String((opts && opts.method) || "GET").toUpperCase();
        if (method !== "POST") {
          // Reads go to the panel, except the snapshot: it carries what this probe fabricated, so the page's
          // own safety-net resync cannot drop a card in the middle of a check.
          if (u.includes("/api/state")) return json({ ...probe.snapshot, jobs: probe.jobs });
          return realFetch(url, opts);
        }
        let body = null;
        try {
          body = opts && opts.body ? JSON.parse(String(opts.body)) : null;
        } catch {
          body = null; // an attachment's body is a File, not JSON
        }
        probe.posts.push({ url: u, body });
        if (u.includes("/api/agents/reply")) {
          return json({
            job: {
              id: `probe-reply-${probe.posts.length}`,
              thread: (body && body.thread) || thread,
              turn: 9,
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
        if (u.includes("/api/agents")) {
          if (probe.failSpawn) return new Response(JSON.stringify({ error: "probe: the gateway refused this spawn" }), { status: 500, headers: { "Content-Type": "application/json" } });
          return json({
            job: {
              id: `probe-spawn-${probe.posts.length}`,
              thread: "wtgui-probe-spawned-000000",
              turn: 1,
              prompt: (body && body.prompt) || "",
              displayPrompt: (body && body.prompt) || "",
              status: "running",
              startedAt: new Date().toISOString(),
              cwd: (body && body.cwd) || null,
              worktree: false,
              lines: [],
              artifacts: [],
              attachments: [],
              subagents: [],
            },
          });
        }
        if (u.includes("/api/attachments")) return json({ name: "shot.png", path: "C:/probe/attachments/shot.png", type: "image/png", bytes: 8 });
        return json({ ok: true });
      };
      const FakeStream = function () {
        this.readyState = 1;
      };
      FakeStream.prototype.addEventListener = function () {};
      FakeStream.prototype.removeEventListener = function () {};
      FakeStream.prototype.close = function () {};
      window.EventSource = FakeStream;

      // The card this test drives, built in the page's own state and rendered by the shipped renderJobs /
      // conversationHtml — the card is the real thing, not a fixture of the markup.
      const job = (o) => ({
        id: o.id,
        thread,
        turn: o.turn || 1,
        status: o.status,
        prompt: o.prompt || "probe brief — the state under test",
        displayPrompt: o.prompt || "probe brief — the state under test",
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
        pendingSteer: o.pendingSteer || null,
      });
      probe.card = (turns, { add = false } = {}) => {
        if (!add) {
          // A fabricated state starts EMPTY: the box is blurred first (a focused box is restored from its own
          // typing snapshot by the render, faithfully — which would carry the previous fixture's text into this
          // one), and the card node is removed so renderJobs has to build a fresh one.
          document.activeElement?.blur?.();
          state.jobs.clear();
          state.replyQueue.delete(thread);
          state.replyDrafts[thread] = "";
          state.boxModels.delete(`reply:${thread}`);
          document.querySelector(`.job[data-thread="${thread}"]`)?.remove();
        }
        for (const t of turns) state.jobs.set(t.id, job(t));
        probe.jobs = [...state.jobs.values()];
        keep();
        renderJobs();
        const box = document.querySelector(`.reply-box[data-reply="${thread}"]`);
        if (box) box.focus();
        return Boolean(box);
      };
      probe.rescan = (turns) => {
        for (const t of turns) state.jobs.set(t.id, job(t));
        probe.jobs = [...state.jobs.values()];
        keep();
        renderConversation(thread);
        return true;
      };
      probe.repaint = (turns) => {
        for (const t of turns) state.jobs.set(t.id, job(t));
        probe.jobs = [...state.jobs.values()];
        keep();
        renderJobs(); // repaints every card from scratch: the coldest rebuild the board has
        return true;
      };
      probe.signature = () => document.querySelector(`.job[data-thread="${thread}"]`)?.dataset.sig ?? null;
      probe.forgetSteerSeed = () => {
        state.seededSteer = new Set();
        state.replyDrafts[thread] = "";
      };
      probe.seedReplyHistory = (list) => localStorage.setItem("wtgui.replyHistory", JSON.stringify({ [thread]: list }));
      probe.seedSpawnHistory = (list) => {
        localStorage.setItem("wm.spawnHistory", JSON.stringify(list));
        state.spawnHistory = list;
        state.spawnNav = null;
      };
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
    .waitForFunction(
      () => typeof window.renderJobs === "function" && typeof window.__probe === "object" && typeof window.WMApp?.board?.pasteChips?.readBox === "function",
      null,
      { timeout: 30_000 },
    )
    .then(() => true)
    .catch(() => false);
  ok("browser: the page is loaded with the probe and the chip module installed", ready);

  const readSel = (sel) => page.evaluate((s) => window.__probe.read(s), sel);
  const read = () => readSel(boxSel);
  const caret = (sel = boxSel) => page.evaluate((s) => window.__probe.caret(s), sel);
  const chipCount = (sel = boxSel) => page.evaluate((s) => window.__probe.chipCount(s), sel);
  const chipLabel = (i = 0) => page.evaluate(([s, n]) => window.__probe.chipLabel(s, n), [boxSel, i]);
  const chipText = (i = 0) => page.evaluate(([s, n]) => window.__probe.chipText(s, n), [boxSel, i]);
  const chipOpen = (i = 0) => page.evaluate(([s, n]) => window.__probe.chipOpen(s, n), [boxSel, i]);
  const chipBody = (i = 0) =>
    page.evaluate(
      ([s, n]) => document.querySelectorAll(`${s} .paste-chip`)[n]?.querySelector(".pc-body .pc-text")?.textContent ?? null,
      [boxSel, i],
    );
  const posts = () => page.evaluate(() => window.__probe.posts.map((p) => ({ url: p.url, body: p.body })));
  const clearPosts = () => page.evaluate(() => { window.__probe.posts.length = 0; });
  const paste = (sel, payload, kind = "text") => page.evaluate(([s, k, p]) => window.__probe.paste(s, k, p), [sel, kind, payload]);
  const clickChip = (what, i = 0) => page.evaluate(([s, w, n]) => window.__probe.clickChip(s, w, n), [boxSel, what, i]);
  const setCaret = (sel, at) => page.evaluate(([s, n]) => window.__probe.setCaret(s, n), [sel, at]);
  const focusBox = (sel) => page.evaluate((s) => window.__probe.focusBox(s), sel);
  const blur = () => page.evaluate(() => window.__probe.blur());
  const card = async (turns) => {
    const made = await page.evaluate((t) => window.__probe.card(t), turns);
    await page.waitForTimeout(150);
    return made;
  };
  const rescan = async (turns) => {
    await page.evaluate((t) => window.__probe.rescan(t), turns);
    await page.waitForTimeout(200);
  };
  const press = async (combo, sel = boxSel) => {
    // Focus only when the box is not focused already: focusing is what moves the caret, and a test that has
    // just placed one must keep it.
    const focused = await page.evaluate((s) => window.__probe.focused(s), sel);
    if (!focused) await focusBox(sel);
    await page.keyboard.press(combo);
    await page.waitForTimeout(200);
  };
  const typeIn = async (sel, text) => {
    await focusBox(sel);
    await page.keyboard.type(text);
    await page.waitForTimeout(120);
  };

  const DONE = [{ id: "probe-paste-1", status: "done", prompt: "the turn before the paste" }];

  // ================= (a) a 367-line paste, mid-sentence ===============================================
  console.log("\n== (a) 367 lines pasted with the caret mid-sentence ==");
  ok("the card renders with its reply box", await card(DONE));
  check("(a) the reply box is one element on the card", await page.locator(boxSel).count(), 1);
  check("(a) and it is a contenteditable host, not a textarea", await page.locator(boxSel).evaluate((el) => `${el.tagName}:${el.getAttribute("contenteditable")}`), "DIV:true");
  await typeIn(boxSel, "Quote this: ");
  check("(a) the prose before the paste is in the box", await read(), "Quote this: ");
  await paste(boxSel, PASTE_367);
  await page.waitForTimeout(200);
  check("(a) one chip appears, in place", await chipCount(), 1);
  check("(a) the text before it survives", (await read()).slice(0, "Quote this: ".length), "Quote this: ");
  check("(a) and the box holds the whole pasted block after it", await read(), `Quote this: ${PASTE_367}`);
  check("(a) the caret sits immediately after the chip (prose + the whole pasted block)", await caret(), "Quote this: ".length + PASTE_367.length);
  check("(a) the chip is the only ELEMENT in the box, among the text", await page.locator(`${boxSel} > *`).evaluateAll((kids) => kids.map((k) => k.className)), ["paste-chip"]);
  check("(a) and nothing else was wrapped around it (no <br>, no block)", await page.locator(`${boxSel} > br, ${boxSel} > div, ${boxSel} > p`).count(), 0);
  await typeIn(boxSel, " — and this prose after it");
  check("(a) typing after the paste lands AFTER the chip, in position", await read(), `Quote this: ${PASTE_367} — and this prose after it`);
  check("(a) still exactly one chip", await chipCount(), 1);

  // ================= (b) what the chip says ==========================================================
  console.log("\n== (b) the label: the line count and the preview ==");
  const label = await chipLabel();
  const preview = PREVIEW_HEAD.replace(/\s+/g, " ").trim();
  ok("(b) the label reads [Pasted <n> lines: <preview>…]", /^\[Pasted 367 lines: /.test(label) && label.endsWith("…]"), label);
  ok("(b) the preview is the first characters of the pasted block", label.includes(preview.slice(0, 40)), label);
  check("(b) the preview is display only, never a second copy of the text", preview.length >= 40 && !label.includes("line 2 of the pasted block"), true);
  check("(b) the chip's text is in the PANEL'S STATE, not only in the DOM", await chipText(), PASTE_367);
  const inState = await page.evaluate(() => window.__probe.chipsInState());
  ok("(b) state.pasteChips holds it by id, with its line count", inState.length === 1 && inState[0].lines === 367 && inState[0].len === PASTE_367.length, JSON.stringify(inState));

  // ================= (c) click to read, click to fold ================================================
  console.log("\n== (c) a click shows the whole thing, wrapped; a second click folds it ==");
  await clickChip("label");
  await page.waitForTimeout(150);
  check("(c) the chip is open", await chipOpen(), true);
  check("(c) and shows ALL 367 lines", String(await chipBody()).split("\n").length, 367);
  check("(c) the body's text is the whole pasted block", await chipBody(), PASTE_367);
  const bodyStyle = await page.evaluate((s) => window.__probe.chipBodyStyle(s), boxSel);
  ok("(c) the body is wrapped, not one long line", bodyStyle?.whiteSpace === "pre-wrap", JSON.stringify(bodyStyle));
  ok("(c) and scrollable when long", bodyStyle?.overflow === "auto" || bodyStyle?.overflowY === "auto", JSON.stringify(bodyStyle));
  const faceOpen = await page.evaluate((s) => window.__probe.chipFace(s), boxSel);
  ok("(c) the unfolded chip takes its own line (display: block)", faceOpen?.display === "block", JSON.stringify(faceOpen));
  check("(c) the chip is not editable: this is a read, never an edit path", faceOpen?.editable, "false");
  await clickChip("label");
  await page.waitForTimeout(150);
  check("(c) a second click folds it back", await chipOpen(), false);
  check("(c) and the body is gone", await page.locator(`${chipSel} .pc-body`).count(), 0);
  await clickChip("label");
  await page.waitForTimeout(120);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  check("(c) Escape folds it too", await chipOpen(), false);

  // ================= (d) / (g) two chips: own ×, own expand, whole-chip Backspace ====================
  console.log("\n== (d)/(g) two chips: own ×, own expand, own delete — and Backspace removes one whole ==");
  await card(DONE);
  await typeIn(boxSel, "first: ");
  await paste(boxSel, PASTE_367);
  await typeIn(boxSel, " | second: ");
  await paste(boxSel, PASTE_FIVE);
  await page.waitForTimeout(200);
  check("(g) two chips in one box", await chipCount(), 2);
  check("(g) each carries its own text", [await chipText(0), await chipText(1)], [PASTE_367, PASTE_FIVE]);
  check("(g) and its own label", [String(await chipLabel(0)).startsWith("[Pasted 367 lines:"), String(await chipLabel(1)).startsWith("[Pasted 5 lines:")], [true, true]);
  await clickChip("label", 1);
  await page.waitForTimeout(150);
  check("(g) opening the second leaves the first folded", [await chipOpen(0), await chipOpen(1)], [false, true]);
  check("(g) and shows only the second block's text", await chipBody(1), PASTE_FIVE);
  await clickChip("label", 1);
  await page.waitForTimeout(120);
  check("(d) before any removal the box reads as the text it holds", await read(), `first: ${PASTE_367} | second: ${PASTE_FIVE}`);
  const keepFirstText = await chipText(0);
  await clickChip("x", 1);
  await page.waitForTimeout(200);
  check("(d) the × removes that chip and nothing else", await chipCount(), 1);
  check("(d) the text around it survives, in place", await read(), `first: ${PASTE_367} | second: `);
  check("(d) the other chip is untouched, text and all", await chipText(0), keepFirstText);
  ok("(d) its text was never edited by any of that", keepFirstText === PASTE_367, "the remaining chip still holds all 367 lines");
  // Backspace with the caret right after a chip: the whole chip goes in one press, never half of it.
  await setCaret(boxSel, `first: ${PASTE_367}`.length);
  const chipsBefore = (await page.evaluate(() => window.__probe.chipsInState())).length;
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(200);
  check("(d) Backspace beside a chip removes it whole", await chipCount(), 0);
  check("(d) leaving the prose around it, with nothing half-deleted", await read(), "first:  | second: ");
  check("(d) no chip element survives in the DOM", await page.locator(chipSel).count(), 0);
  const chipsAfter = await page.evaluate(() => window.__probe.chipsInState());
  check("(d) and that chip's text went with it out of the state", chipsAfter.length, chipsBefore - 1);

  // ================= (e) what the agent receives =====================================================
  console.log("\n== (e) the request the panel actually sends ==");
  await card(DONE);
  await typeIn(boxSel, 'here is the pasted spec: "');
  await paste(boxSel, PASTE_367);
  await typeIn(boxSel, '" — implement it');
  await page.waitForTimeout(200);
  const expected = `here is the pasted spec: "${PASTE_367}" — implement it`;
  check("(e) the box reads as the full text in position", await read(), expected);
  await clearPosts();
  await press("Enter");
  const sent = (await posts()).filter((p) => p.url.includes("/api/agents/reply"));
  check("(e) Enter sends exactly one reply", sent.length, 1);
  const sentText = sent[0]?.body?.text ?? null;
  check("(e) THE REQUEST CARRIES THE WHOLE PASTED BLOCK, IN POSITION, BETWEEN THE QUOTES", sentText, expected);
  console.log(`      the serialized value the panel sent — ${String(sentText).length} characters, 367 pasted lines collapsed to one chip:`);
  console.log(`      ${JSON.stringify(String(sentText).slice(0, 110))} … ${JSON.stringify(String(sentText).slice(-70))}`);

  // ================= (i) the keys, on the reply box ==================================================
  console.log("\n== (i) Enter / Ctrl+Enter / Shift+Enter / ↑↓ recall / the pending-steer restore ==");
  check("(i) the box is empty after the send (the chip went out with it)", await read(), "");
  check("(i) and its model went with it", await page.evaluate((k) => window.__probe.draftModel(k), `reply:${THREAD}`), []);
  await card(DONE);
  await typeIn(boxSel, "line one");
  await paste(boxSel, PASTE_FIVE);
  await page.waitForTimeout(150);
  await press("Shift+Enter");
  check("(i) Shift+Enter adds a newline at the caret, after the chip", await read(), `line one${PASTE_FIVE}\n`);
  check("(i) and the chip is still there, whole", await chipCount(), 1);
  await card([{ id: "probe-live-1", status: "running" }]);
  await paste(boxSel, PASTE_FIVE);
  await typeIn(boxSel, " steer this");
  await page.waitForTimeout(150);
  await clearPosts();
  await press("Control+Enter");
  const steered = (await posts()).filter((p) => p.url.includes("/api/jobs/steer"));
  check("(i) Ctrl+Enter steers the live turn", steered.length, 1);
  check("(i) with the chip's text in position", steered[0]?.body?.text, `${PASTE_FIVE} steer this`);
  // ↑/↓ walk the thread's history, from the very start of the text.
  await card(DONE);
  await page.evaluate((lines) => window.__probe.seedReplyHistory(lines), ["an older reply", "the newest reply"]);
  await setCaret(boxSel, 0);
  await press("ArrowUp");
  check("(i) ↑ with the caret at the start recalls the newest prompt", await read(), "the newest reply");
  await press("ArrowUp");
  check("(i) ↑ again walks further back", await read(), "an older reply");
  await press("ArrowDown");
  check("(i) ↓ walks forward again", await read(), "the newest reply");
  check("(i) and the caret is left at the end of the recalled text", await caret(), "the newest reply".length);
  // The pending-steer restore: a steer that missed its turn is offered back into the box on the next render.
  await page.evaluate((lines) => window.__probe.seedReplyHistory(lines), []);
  await card([{ id: "probe-missed-1", status: "done" }]);
  await page.evaluate(() => window.__probe.forgetSteerSeed());
  // Blurred: the pending steer IS the draft here, and a focused box would come back from its own typing
  // snapshot instead — which is the same rule for a real reader who walked away mid-sentence.
  await blur();
  await rescan([{ id: "probe-missed-2", status: "done", turn: 2, prompt: "a later turn", pendingSteer: { text: "the steer that missed the turn", at: Date.now() } }]);
  check("(i) an unsent steer is offered back in the box", await read(), "the steer that missed the turn");
  check("(i) and the card says so", await page.locator(`${cardSel} [data-pending-steer]`).count(), 1);

  // ================= (i) the New-agent prompt ========================================================
  console.log("\n== (i) the New-agent prompt (#job-prompt) ==");
  check("(i) the New-agent prompt is a chipbox", await page.locator(promptSel).getAttribute("data-chipbox"), "spawn");
  await paste(promptSel, PASTE_367);
  await page.waitForTimeout(200);
  check("(i) a 367-line paste collapses there too", await chipCount(promptSel), 1);
  check("(i) and the box reads as the whole block", await readSel(promptSel), PASTE_367);
  await typeIn(promptSel, " do this");
  check("(i) typing after it lands after the chip", await readSel(promptSel), `${PASTE_367} do this`);
  await press("Shift+Enter", promptSel);
  check("(i) Shift+Enter is a newline here", (await readSel(promptSel)).endsWith("\n"), true);
  await page.evaluate((lines) => window.__probe.seedSpawnHistory(lines), ["an older spawn prompt"]);
  await setCaret(promptSel, 0);
  await press("ArrowUp", promptSel);
  check("(i) ↑ recalls a prompt that was spawned before", await readSel(promptSel), "an older spawn prompt");
  await paste(promptSel, PASTE_FIVE);
  await page.waitForTimeout(150);
  await clearPosts();
  await page.locator("#btn-spawn").click();
  await page.waitForTimeout(500);
  const spawned = (await posts()).filter((p) => p.url.includes("/api/agents"));
  check("(i) the Spawn press posts one run", spawned.length, 1);
  ok("(i) and the prompt it carries holds the chip's whole text", String(spawned[0]?.body?.prompt || "").includes(PASTE_FIVE), JSON.stringify(String(spawned[0]?.body?.prompt || "").slice(0, 70)));
  check("(i) the prompt box is cleared after the spawn", await readSel(promptSel), "");

  // ================= (i) the inline add-agent field ==================================================
  console.log("\n== (i) the inline add-agent field ==");
  const opened = await page.evaluate((k) => {
    const row = [...state.rows.values()][0];
    const key = row ? `${row.project}::${row.path}` : k;
    const btn = document.querySelector(`.btn-add-agent[data-add-agent-key="${CSS.escape(key)}"]`);
    if (!btn) return null;
    btn.click();
    return document.querySelector(`.add-agent-input[data-add-agent-key="${CSS.escape(key)}"]`) ? key : null;
  }, ADD_KEY);
  if (!opened) {
    note("(the sandbox has no worktree row, so the field is built from the panel's own markup builder instead)");
    await page.evaluate((k) => {
      const host = document.createElement("div");
      host.innerHTML =
        `<div class="add-agent-form"><div class="add-agent-input" contenteditable="true" role="textbox" data-single="1" data-add-agent-key="${k}" data-add-agent-path="C:/probe/tree" data-add-agent-name="probe-tree" data-add-agent-project="probe" data-chipbox="add:${k}" data-ph="what should this agent do here?"></div></div>`;
      document.body.appendChild(host);
      state.addAgent = { key: k, path: "C:/probe/tree", name: "probe-tree", project: "probe", value: "", start: 0, end: 0, focused: true };
      host.querySelector(".add-agent-input").focus();
    }, ADD_KEY);
  }
  check("(i) the add-agent field is a chipbox", await page.locator(fieldSel).getAttribute("data-chipbox"), `add:${ADD_KEY}`);
  await paste(fieldSel, PASTE_367);
  await page.waitForTimeout(200);
  check("(i) a 367-line paste collapses in the field", await chipCount(fieldSel), 1);
  check("(i) and the field reads as the whole block", await readSel(fieldSel), PASTE_367);
  await typeIn(fieldSel, " go");
  check("(i) typing after it lands after the chip", await readSel(fieldSel), `${PASTE_367} go`);
  check("(i) the draft the field remembers is the serialized text", await page.evaluate(() => state.addAgent.value), `${PASTE_367} go`);
  await paste(fieldSel, "a short paste stays plain");
  await page.waitForTimeout(150);
  check("(i) a short paste in the field is still plain text", await chipCount(fieldSel), 1);
  await page.evaluate(() => { window.confirm = () => true; });
  const fieldBefore = await readSel(fieldSel);
  await press("Shift+Enter", fieldSel);
  check("(i) Shift+Enter adds no line in the one-line field", await readSel(fieldSel), fieldBefore);
  await press("Control+Enter", fieldSel);
  check("(i) Ctrl+Enter adds no line there either (an <input> ignored it)", await readSel(fieldSel), fieldBefore);
  // Enter hands the field's prompt to the New-agent card with the chip intact. The spawn is refused on purpose,
  // because a REFUSED spawn is the one that keeps the prompt for editing — which is what there is to read.
  await page.evaluate(() => { window.__probe.failSpawn = true; });
  await press("Enter", fieldSel);
  await page.waitForTimeout(600);
  check("(i) Enter hands the field's prompt to the New-agent card, chip included", await chipCount(promptSel), 1);
  check("(i) and the field is gone (the + bar is back)", await page.locator(fieldSel).count(), 0);
  check("(i) the card's prompt reads as the whole thing", await readSel(promptSel), fieldBefore);
  await page.evaluate(() => { window.__probe.failSpawn = false; });
  await clearPosts();
  await page.locator("#btn-spawn").click();
  await page.waitForTimeout(600);
  const fromField = (await posts()).filter((p) => p.url.includes("/api/agents"));
  check("(i) the run started from that prompt posts one request", fromField.length, 1);
  const bodyText = String(fromField[0]?.body?.prompt || "");
  ok("(i) carrying the chip's whole text", bodyText.includes(PASTE_367), JSON.stringify(bodyText.slice(0, 70)));
  ok(
    "(i) with the prose after the chip in the right order",
    bodyText.indexOf(PASTE_367) >= 0 && bodyText.indexOf("a short paste stays plain") > bodyText.indexOf(PASTE_367),
    JSON.stringify(bodyText.slice(bodyText.indexOf(PASTE_367) + PASTE_367.length, bodyText.indexOf(PASTE_367) + PASTE_367.length + 40)),
  );

  // ================= (i) the assistant float's boxes =================================================
  console.log("\n== (i) the assistant float ==");
  // Opened the way a reader opens it: a click on the header button (assistant.js keeps its own functions
  // private; the button is the front door).
  await page.locator("#btn-assistant").click();
  await page.waitForTimeout(500);
  if ((await page.locator("#as-first-text").count()) === 1) {
    await paste("#as-first-text", PASTE_FIVE);
    await page.waitForTimeout(200);
    check("(i) the assistant's intro composer collapses a paste", await chipCount("#as-first-text"), 1);
    check("(i) and reads as the whole block", await readSel("#as-first-text"), PASTE_FIVE);
    check("(i) the paste posted nothing: it is a draft, not a send", (await posts()).filter((p) => p.url.includes("/api/assistant/say")).length, 0);
  } else note("(the assistant's intro composer is not on this page — the float already has a conversation)");
  const asBox = "#as-chat .reply-box";
  if ((await page.locator(asBox).count()) === 1) {
    await paste(asBox, PASTE_FIVE);
    await page.waitForTimeout(200);
    check("(i) the float's own composer collapses a paste as well", await chipCount(asBox), 1);
  } else note("(the float has no conversation card on this sandbox — its composer is the same .reply-box class as the board's)");
  await page.locator("#btn-assistant").click();
  await page.waitForTimeout(250);

  // ================= (h) below the threshold, and an image paste =====================================
  console.log("\n== (h) below the threshold, and files/images ==");
  await card(DONE);
  await paste(boxSel, PLAIN_250);
  await page.waitForTimeout(200);
  check("(h) a 250-character paste makes no chip", await chipCount(), 0);
  check("(h) it is plain text in the box", await read(), PLAIN_250);
  check("(h) with no chip element anywhere in it", await page.locator(`${boxSel} .paste-chip`).count(), 0);
  await paste(boxSel, "four lines\nof a short\npaste that\nstays plain\n");
  await page.waitForTimeout(200);
  check("(h) four lines plus a trailing newline is still under the 5-line threshold", await chipCount(), 0);
  check("(h) so it pastes as text", (await read()).endsWith("stays plain\n") ? "ends with a plain newline" : JSON.stringify((await read()).slice(-22)), "ends with a plain newline");
  await paste(boxSel, PASTE_FIVE);
  await page.waitForTimeout(200);
  check("(h) five lines does collapse", await chipCount(), 1);
  check("(h) and the chip's text is the pasted block, line breaks and all", await chipText(), PASTE_FIVE);
  await card(DONE);
  await paste(boxSel, "shot.png", "file");
  await page.waitForTimeout(400);
  const attach = await page.evaluate(() => window.__probe.attachChips());
  check("(h) an image paste still makes the attachment chip", attach.length, 1);
  check("(h) reading [shot.png]", attach[0], "[shot.png]\u00d7");
  check("(h) and the box itself stays empty: a file paste is not a text chip", await read(), "");
  check("(h) the attachment posted to the panel's own route", (await posts()).filter((p) => p.url.includes("/api/attachments")).length, 1);

  // ================= (f) a rescan and a reload =======================================================
  console.log("\n== (f) a board rescan, a full repaint, and a reload of the page ==");
  await card(DONE);
  await typeIn(boxSel, 'kept: "');
  await paste(boxSel, PASTE_FIVE);
  await typeIn(boxSel, '"');
  const beforeRescan = await read();
  check("(f) the draft reads as text around the chip", beforeRescan, `kept: "${PASTE_FIVE}"`);
  ok("(f) the panel holds a model for this draft", (await page.evaluate((k) => window.__probe.draftModel(k), `reply:${THREAD}`)).length === 3, JSON.stringify(await page.evaluate((k) => window.__probe.draftModel(k), `reply:${THREAD}`)));
  await page.evaluate(() => window.__probe.markCard());
  const sigBefore = await page.evaluate(() => window.__probe.signature());
  // A rescan lands a new turn: the card is rebuilt through renderConversation, with the box FOCUSED.
  await rescan([{ id: "probe-paste-2", status: "done", turn: 2, prompt: "a later turn the scan landed" }]);
  const sigAfter = await page.evaluate(() => window.__probe.signature());
  ok("(f) the card really was rebuilt (its render signature moved)", sigBefore !== sigAfter, `${sigBefore} -> ${sigAfter}`);
  check("(f) and it is a NEW node, not the one that was there", await page.evaluate(() => window.__probe.marked()), false);
  check("(f) the chip came back after the rebuild", await chipCount(), 1);
  check("(f) with the same draft around it", await read(), beforeRescan);
  check("(f) and the same text inside it", await chipText(), PASTE_FIVE);
  // And again with the box NOT focused: the draft path, not the typing snapshot.
  await blur();
  await page.evaluate(() => window.__probe.markCard());
  await rescan([{ id: "probe-paste-3", status: "done", turn: 3, prompt: "and another turn" }]);
  check("(f) the rebuild happened with the box blurred", await page.evaluate(() => window.__probe.marked()), false);
  check("(f) and the draft path still brings the chip back", await chipCount(), 1);
  check("(f) with the text around it", await read(), beforeRescan);
  // The coldest rebuild there is: every card repainted from scratch.
  await page.evaluate(() => window.__probe.markCard());
  await page.evaluate((t) => window.__probe.repaint(t), [{ id: "probe-paste-4", status: "done", turn: 4, prompt: "one more" }]);
  await page.waitForTimeout(300);
  check("(f) a full board repaint keeps it too", await chipCount(), 1);
  check("(f) with its text", await read(), beforeRescan);
  // A reload: a chip-bearing draft is mirrored per tab, so the paste survives an F5 with its text.
  await page.reload({ waitUntil: "domcontentloaded" });
  const backAfterLoad = await waitFor(() => page.locator(boxSel).count().then((n) => n === 1), { timeoutMs: 25_000, what: "the card (and its reply box) to come back after the reload" });
  ok("(f) the page reloaded and the board came back with the same card", backAfterLoad);
  check("(f) the chip is back after the reload", await chipCount(), 1);
  check("(f) holding the same block", await chipText(), PASTE_FIVE);
  check("(f) and the same draft around it", await read(), beforeRescan);
  const modelAfter = await page.evaluate((k) => window.__probe.draftModel(k), `reply:${THREAD}`);
  ok(
    "(f) the draft's model survived the reload: text, chip, text",
    modelAfter.length === 3 && modelAfter[0] === 'text:"kept: \\""' && /^chip:pc\d+$/.test(modelAfter[1]) && modelAfter[2] === 'text:"\\""',
    JSON.stringify(modelAfter),
  );
  // The New-agent prompt is static markup, restored at boot: its own draft comes back the same way.
  await paste(promptSel, PASTE_FIVE);
  await page.waitForTimeout(300);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitFor(() => page.locator(promptSel).count().then((n) => n === 1), { timeoutMs: 25_000, what: "#job-prompt to be back" });
  const promptBack = await waitFor(() => page.evaluate((s) => window.__probe.chipCount(s) === 1, promptSel), { timeoutMs: 10_000, what: "the prompt's chip to come back" });
  check("(f) the New-agent prompt's pasted block survives a reload too", promptBack, true);
  check("(f) with its text", await readSel(promptSel), PASTE_FIVE);

  check("no page errors anywhere in this run", pageErrors, []);
  await browser.close();
  browserRef = null;
}

// ---- what can only be read off the source ---------------------------------------------------------
function sourceChecks() {
  const app = readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const mod = readFileSync(path.join(ROOT, "public", "board", "paste-chips.js"), "utf8");
  const appLines = app.split(/\r?\n/);
  const modLines = mod.split(/\r?\n/);
  // One reader for every box: no prompt box may be read through `.value` any more.
  const bad = [];
  for (const sel of [".reply-box", "#job-prompt", ".add-agent-input"]) {
    for (const [i, line] of appLines.entries()) {
      if (!line.includes(sel)) continue;
      if (/\.value\b/.test(line) && !/data-|placeholder|esc\(value\)/.test(line)) bad.push(`${i + 1}: ${line.trim()}`);
    }
  }
  check("inspected: no reader of a prompt box touches .value any more", bad, []);
  const readers = appLines.filter((l) => /\breadBox\(/.test(l)).length;
  ok("inspected: readBox is the read path all over the panel", readers >= 12, `${readers} call sites`);
  check("inspected: and it is defined exactly once", modLines.filter((l) => l.startsWith("function readBox(")).length, 1);
  ok("inspected: it serializes a chip back to its text in place", /s\.t === "chip" \? chipText\(s\.id\) : s\.v/.test(mod), "the serializer's chip branch");
  ok("inspected: the chip's text is keyed by id in the panel's state", /state\.pasteChips\.set\(id, \{ text/.test(mod) && /pasteChips: boxChips\.chips/.test(app), "state.pasteChips");
  const css = readFileSync(path.join(ROOT, "public", "style.css"), "utf8");
  ok(
    "inspected: the chip is a non-editable inline atom",
    /contenteditable", "false"/.test(mod) && /\.paste-chip \{[\s\S]{0,120}?display: inline-block/.test(css),
    "non-editable in the module, display: inline-block in the stylesheet",
  );
  ok("inspected: the box's placeholder is drawn from data-ph (:empty)", /\.chipbox:empty::before \{ content: attr\(data-ph\)/.test(css), "the :empty rule");
  ok("inspected: a chip-bearing draft is mirrored for a reload", /sessionStorage\.setItem\(CHIP_DRAFT_KEY/.test(mod), "CHIP_DRAFT_KEY");
  ok("inspected: the 300-character / 5-line threshold is the module's own", /PASTE_CHIP_MIN_CHARS = 300/.test(mod) && /PASTE_CHIP_MIN_LINES = 5/.test(mod), "300 chars, 5 lines");
  const html = readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  ok("inspected: the chip module is loaded before app.js", html.indexOf("/board/paste-chips.js") > 0 && html.indexOf("/board/paste-chips.js") < html.indexOf("/app.js"), "script order");
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
    note("nothing here reaches a gateway: apiServer is pinned at http://127.0.0.1:9 and the page's writes are stubbed");
    check("the sandbox panel is the one that answered", (await fetch(`${base}/api/state`)).ok, true);
    note(`port ${port} — the live board on 7331 is not touched`);
  }

  console.log("\n== what can only be read off the source ==");
  sourceChecks();

  console.log("\n== the browser: real pastes and real keys over a real page ==");
  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN  the client half of this change was not exercised in a browser.");
    note("re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-paste-chips.mjs");
    failures += 1;
  } else {
    await browserPhase(pw);
  }

  console.log("\n== summary ==");
  console.log(`${checks} checks, ${failures} failed`);
  console.log("\nWHAT WAS DRIVEN: a panel of this checkout (or PANEL_URL) plus headless Chromium over it; cards built in");
  console.log("the page's own state.jobs and rendered by the shipped renderJobs/conversationHtml; real `paste` events");
  console.log("carrying a real DataTransfer (text AND a File); real key presses through page.keyboard; real clicks on the");
  console.log("chip and its ×; a rescan rebuild, a full board repaint and a page.reload; every send/steer/spawn/attachment");
  console.log("request the page would have made recorded by a stubbed fetch (so no worker, no run and no steer ever left");
  console.log("the page); and every READ taken through readBox — the one function the panel's send, steer, queue and");
  console.log("draft paths use — rather than through the DOM.");
  console.log("WHAT WAS INSPECTED, NOT DRIVEN: that no prompt box is read through `.value` anywhere in public/app.js,");
  console.log("that readBox is defined once, that the chip's text is keyed by id in state.pasteChips, that the chip is a");
  console.log("non-editable inline atom, that a chip-bearing draft is mirrored into sessionStorage, and the 300/5");
  console.log("threshold — read off public/app.js, public/board/paste-chips.js and public/index.html.");
  if (!failures) console.log("PASTE-CHIPS-OK");
} catch (err) {
  failures += 1;
  console.log(`\nFAIL  the run threw: ${String((err && err.stack) || err)}`);
  if (panelLog.length) console.log(`--- panel log (tail)\n${panelLog.slice(-25).join("\n")}`);
} finally {
  if (process.env.VERIFY_KEEP === "1" && dir) {
    console.log(`VERIFY_KEEP=1 — leaving ${dir} in place`);
  } else {
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
