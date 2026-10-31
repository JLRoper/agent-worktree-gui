// Hover copy buttons on console output and thinking blocks, proved in a real browser against THIS
// checkout's public/**: the button appears on hover and fades on leave (a, b), a tool burst gets one for
// its CALL and none for its result lines (c), a press puts the block's own visible text on the clipboard
// - read BACK, not assumed (d), a folded block copies only what it shows (e), a pinned console behaves
// like its page copy (f), the button is inert and absent from the accessibility tree and from a selection
// while hidden and moves nothing when it appears (g), and nothing that worked before broke: the burst's
// fold, a drag-select, Ctrl+wheel resizing, the console's follow-scroll, a fold header's click (h).
//
//   node tools/verify-copy-buttons.mjs                    boot a sandbox panel from THIS checkout
//   PANEL_PLAYWRIGHT_ROOT=C:/ProjectDevelopment/heroes-js node tools/verify-copy-buttons.mjs
//
// WHAT IS DRIVEN, AND WHAT IS ONLY INSPECTED
//
//   driven     a panel of its own on a spare port (never 7331, apiServer pinned at a dead port so nothing
//              here can buy a worker) plus headless Chromium over it, with real pointer moves, a real
//              click, a real drag-select, a real Ctrl+wheel and real Tab/focus attempts
//   driven     the clipboard: every copy is read back with navigator.clipboard.readText() (the origin is
//              granted clipboard-read/write) and compared with the text the block shows. Windows normalises
//              the line breaks to CRLF in the clipboard, so the comparison is on \n after that normalisation
//              and the raw read-back is printed beside it
//   driven     the accessibility tree over CDP (Accessibility.getFullAXTree): the button's name is absent
//              while hidden and present once it is revealed
//   driven     the failure path: navigator.clipboard.writeText is replaced with a rejection, so the panel's
//              own textarea/execCommand fallback has to do the copy, and then BOTH are made to fail and the
//              button must not claim success
//   inspected  that the mechanism is one delegated handler and one attribute (read off public/app.js and
//              public/style.css), not per-renderer markup
//
// The browser half needs a Playwright install; without one this prints BROWSER-HALF-NOT-RUN, counts a
// failure and exits non-zero rather than passing on a half that never ran.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installFakeEventSource, loadPlaywright } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const LIVE = String(process.env.PANEL_URL || "").replace(/\/+$/, "");

let failures = 0;
let checks = 0;
let browserRef = null;
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

// ---- the sandbox panel ---------------------------------------------------------------------------
const THREAD = "wtgui-probe-copy-buttons-9c1f2e";
let dir = null;
let panel = null;
let base = LIVE;
const panelLog = [];

async function startSandbox() {
  dir = mkdtempSync(path.join(tmpdir(), "wtgui-copy-buttons-"));
  const scanRoot = path.join(dir, "scan-root");
  const home = path.join(dir, "hermes-home");
  const configDir = path.join(dir, "panel");
  for (const d of [scanRoot, home, configDir, path.join(configDir, "logs")]) mkdirSync(d, { recursive: true });
  const port = await freePort();
  const configPath = path.join(configDir, "config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        port,
        host: "127.0.0.1",
        scanRoots: [scanRoot],
        defaultCwd: scanRoot,
        jobsFile: path.join(configDir, "logs", "jobs.json"),
        assistantFile: path.join(configDir, "logs", "assistant.json"),
        projectsCacheFile: path.join(configDir, "logs", "projects.json"),
        treeNamesFile: path.join(configDir, "logs", "tree-names.json"),
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

// ---- the fixture, and what the reader is owed for it ----------------------------------------------
// A turn's console: a text line, one tool burst (a call, its result header and two result lines), a text
// line. `⚡` is the glyph the burst row falls back to when the gateway's line carries none.
const CONSOLE_TEXT = "reading the panel's console code";
const CALL_TEXT = "public/app.js";
const BURST_CALL = `⚡ read ×1 ${CALL_TEXT} 0.42s`;
const BASH_TEXT = "npm run test:unit";
const BASH_CALL = `⚡ bash ×1 ${BASH_TEXT} 12.60s`;
const RESULT_LINES = ["  ↳ read · 0.42s", "  first result line", "  second result line"];
const LAST_TEXT = "done — two files changed";
const CONSOLE_FOLDED = [CONSOLE_TEXT, BURST_CALL, LAST_TEXT].join("\n");
const THINK_BLOCKS = ["reasoning line one", "reasoning line two"];
const THINK_FOLDED = "🧠 thinking 2 blocks";
const THINK_OPEN = [THINK_FOLDED, ...THINK_BLOCKS].join("\n");

async function browserPhase(pw) {
  const pageErrors = [];
  const browser = await pw.chromium.launch({ headless: true });
  browserRef = browser;
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  const realSnapshot = await fetch(`${base}/api/state`).then((r) => r.json());
  await installFakeEventSource(context);
  await context.addInitScript(
    ({ snapshot, consoleText, callText, bashText, lastText, thinkBlocks }) => {
      const realFetch = window.fetch.bind(window);
      const probe = { snapshot, written: [] };
      window.__probe = probe;
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      window.fetch = async (url, opts = {}) => {
        const u = String(url);
        if (String((opts && opts.method) || "GET").toUpperCase() !== "POST") {
          if (u.includes("/api/state")) return json({ ...probe.snapshot, jobs: [...state.jobs.values()] });
          if (u.includes("/api/thinking")) return json({ blocks: probe.blocks || [] });
          return realFetch(url, opts);
        }
        return json({ ok: true });
      };
      // The Settings toggle the brief names: thinking on for this session.
      try {
        localStorage.setItem("wtgui.think", "1");
      } catch {
        /* the page just will not remember it */
      }
      probe.blocks = thinkBlocks.map((text) => ({ text }));

      // The turn the checks are made against, fabricated in the PAGE's own state (state.jobs + state.jobLines,
      // painted by the shipped renderJobs/conversationHtml) so every block under test is a real render.
      probe.show = (opts = {}) => {
        const id = opts.id || "probe-turn";
        const lines = [
          { kind: "text", text: consoleText, lid: "l1" },
          { kind: "tool", text: "▸ read · " + callText, at: Date.now() - 8000 },
          { kind: "tool-out", text: "  ↳ read · 0.42s" },
          { kind: "tool-out", text: "  first result line" },
          { kind: "tool-out", text: "  second result line" },
          // A second call in the SAME burst: the head is a column, so its copy has to be one line per call.
          ...(opts.twoRows
            ? [
                { kind: "tool", text: "▸ bash · " + bashText, at: Date.now() - 3000 },
                { kind: "tool-out", text: "  ↳ bash · 12.60s" },
              ]
            : []),
          { kind: "text", text: lastText, lid: "l2" },
        ];
        state.jobs.clear();
        state.jobLines.clear();
        state.thinkCache.clear();
        state.pinnedTurns.clear();
        state.turnOpen.clear();
        state.thinkOpen.clear();
        state.thinkClosed.clear();
        state.toolGroupOpen.clear();
        state.outPinned = {};
        state.jobLines.set(id, lines);
        state.thinkCache.set(id, { blocks: probe.blocks, at: Date.now() });
        state.jobs.set(id, {
          id,
          thread: id,
          turn: 1,
          status: "done",
          prompt: "copy button probe",
          displayPrompt: "copy button probe",
          cwd: null,
          worktree: false,
          worktreePath: null,
          projectPath: null,
          ownerPath: null,
          branch: null,
          runId: "run_probe",
          startedAt: new Date(Date.now() - 90_000).toISOString(),
          endedAt: new Date(Date.now() - 30_000).toISOString(),
          model: "probe/model",
          lines: [],
          artifacts: [],
          attachments: [],
          subagents: [],
        });
        if (opts.openBurst) state.toolGroupOpen.set(`${id}#0|l1`, { open: true, filter: "" });
        if (opts.openThink) state.thinkOpen.add(id);
        if (opts.pin) state.pinnedTurns.add(id);
        if (opts.pinOpen) state.turnOpen.set(`pin:${id}`, true);
        renderJobs();
        return Boolean(document.querySelector("pre.job-out"));
      };
      probe.openBurst = () => {
        const grp = document.querySelector("pre.job-out .tgrp");
        const body = grp.querySelector(".tgrp-body");
        if (body.hidden) {
          body.hidden = false;
          rememberToolGroup(grp);
        }
        return !body.hidden;
      };
      probe.closeBurst = () => {
        const grp = document.querySelector("pre.job-out .tgrp");
        const body = grp.querySelector(".tgrp-body");
        body.hidden = true;
        rememberToolGroup(grp);
        return body.hidden;
      };

      // ---- readings ----
      probe.blockText = (sel) => blockCopyText(document.querySelector(sel));
      probe.innerTextOf = (sel) => document.querySelector(sel).innerText;
      probe.renderedCall = (sel) => {
        // The call's own text built independently of the panel's extractor: each row's items, in order.
        const row = document.querySelector(sel);
        return [...row.children]
          .map((c) => c.innerText.trim())
          .filter(Boolean)
          .join(" ");
      };
      probe.button = (sel) => {
        const block = document.querySelector(sel);
        return probe.btnOf(block);
      };
      probe.state = (sel) => {
        const block = document.querySelector(sel);
        const btn = probe.btnOf(block);
        const cs = getComputedStyle(btn);
        const r = btn.getBoundingClientRect();
        const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return {
          visibility: cs.visibility,
          opacity: Number(cs.opacity),
          pointerEvents: cs.pointerEvents,
          userSelect: cs.userSelect,
          label: btn.textContent,
          title: btn.title,
          cls: btn.className,
          hitAtCentre: at ? at.className || at.tagName : null,
          focusable: (() => {
            btn.focus();
            return document.activeElement === btn;
          })(),
        };
      };
      probe.rects = (sel) => {
        const block = document.querySelector(sel);
        const btn = probe.btnOf(block);
        const box = (el) => {
          const q = el.getBoundingClientRect();
          return { x: Math.round(q.x), y: Math.round(q.y), right: Math.round(q.right), bottom: Math.round(q.bottom), w: Math.round(q.width), h: Math.round(q.height) };
        };
        const line = block.querySelector(".jl, .tgrp-row, summary");
        const range = document.createRange();
        let lineText = null;
        if (line) {
          range.selectNodeContents(line);
          const q = [...range.getClientRects()][0] || line.getBoundingClientRect();
          lineText = { x: Math.round(q.x), y: Math.round(q.y), right: Math.round(q.right), bottom: Math.round(q.bottom) };
        }
        const chevron = block.querySelector(".tgrp-more") || block.querySelector("summary");
        return {
          block: box(block),
          button: box(btn),
          firstLine: line ? box(line) : null,
          firstLineText: lineText,
          chevron: chevron ? box(chevron) : null,
          scrollHeight: block.scrollHeight ?? null,
          scrollTop: block.scrollTop ?? null,
        };
      };
      probe.selectionOf = (sel) => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector(sel));
        const sel2 = document.getSelection();
        sel2.removeAllRanges();
        sel2.addRange(range);
        const text = sel2.toString();
        sel2.removeAllRanges();
        return text;
      };
      probe.countButtons = (sel) => document.querySelectorAll(sel).length;
      probe.visibleButtons = () => [...document.querySelectorAll(".copy-block")].map((b) => ({ parent: (b.closest("[data-copy]") || b.parentElement).className, visibility: getComputedStyle(b).visibility, opacity: Number(getComputedStyle(b).opacity) }));
      // The block's own button: a console or a burst keeps it as a child, a <details> keeps it in its
      // summary, which is the only part a folded one renders.
      probe.btnOf = (block) => block.querySelector(":scope > .copy-block") || block.querySelector(":scope > summary > .copy-block");
      probe.read = () => navigator.clipboard.readText();
      probe.write = async (text) => {
        await navigator.clipboard.writeText(text);
        probe.written.push(text);
      };
      // The failure paths: the async clipboard refuses (the fallback must carry the copy), then the fallback
      // refuses too (the button must not claim success).
  // The failure paths: the async clipboard refuses (so the panel's own textarea/execCommand fallback has to
  // carry the copy), then both writers refuse (so the button must not claim a success). readText keeps
  // working throughout, which is what makes the read-back possible on the broken path.
      probe.breakClipboard = (mode) => {
        if (!probe._clip) probe._clip = navigator.clipboard;
        if (!probe._exec) probe._exec = document.execCommand;
        const orig = probe._clip;
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: () => Promise.reject(new Error("clipboard denied")),
            readText: () => orig.readText.call(orig),
          },
        });
        if (mode === "all") document.execCommand = () => false;
        return true;
      };
      probe.restoreClipboard = () => {
        if (probe._clip) Object.defineProperty(navigator, "clipboard", { configurable: true, value: probe._clip });
        if (probe._exec) document.execCommand = probe._exec;
        return true;
      };
      probe.followScroll = () => {
        const out = document.querySelector("pre.job-out");
        return { top: Math.round(out.scrollTop), max: Math.round(out.scrollHeight - out.clientHeight), atEnd: out.scrollHeight - out.scrollTop - out.clientHeight < 24 };
      };
      probe.appendLines = (n, text) => {
        const out = document.querySelector("pre.job-out");
        for (let i = 0; i < n; i += 1) appendJobLine({ id: out.dataset.out, line: { kind: "text", text: `${text} ${i + 1}` } });
        return true;
      };
    },
    {
      snapshot: realSnapshot,
      consoleText: CONSOLE_TEXT,
      callText: CALL_TEXT,
      bashText: BASH_TEXT,
      lastText: LAST_TEXT,
      thinkBlocks: THINK_BLOCKS,
    },
  );

  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(`pageerror: ${String((e && e.message) || e)}`));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(`console.error: ${m.text()}`);
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Accessibility.enable");
  await page.goto(base, { waitUntil: "domcontentloaded" });
  const ready = await page
    .waitForFunction(() => typeof window.renderJobs === "function" && typeof window.__probe === "object", null, { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  ok("browser: the page is loaded with the probe installed", ready);
  if (!ready) throw new Error("the page never loaded");

  const show = async (opts) => {
    const made = await page.evaluate((o) => window.__probe.show(o), opts || {});
    await page.waitForTimeout(200);
    return made;
  };
  const read = () => page.evaluate(() => window.__probe.read());
  const stateOf = (sel) => page.evaluate((s) => window.__probe.state(s), sel);
  const rects = (sel) => page.evaluate((s) => window.__probe.rects(s), sel);
  const blockText = (sel) => page.evaluate((s) => window.__probe.blockText(s), sel);
  const visible = () => page.evaluate(() => window.__probe.visibleButtons());
  const copyVia = async (sel) => {
    // A real press on the button the reader would press.
    await page.evaluate((s) => document.querySelector(s).click(), sel);
    await page.waitForTimeout(350);
  };
  const W = "[data-copy]";
  const CONSOLE = ".out-wrap.out-tab";
  const BURST = "pre.job-out .tgrp";
  const THINK = "details.think";
  const BURST_BTN = `${BURST} > .copy-block`;
  const CONSOLE_BTN = `${CONSOLE} > .copy-block`;
  const THINK_BTN = `${THINK} > summary > .copy-block`;

  const axNames = async () => {
    const { nodes } = await cdp.send("Accessibility.getFullAXTree");
    return nodes
      .filter((n) => n.name && n.name.value)
      .map((n) => `${n.role && n.role.value}: ${n.name.value}`)
      .filter((s) => /copy this block/i.test(s));
  };

  // ================= (a) the console: one button, on hover, gone on leave ==========================
  console.log("\n== (a) hovering a turn's console ==");
  ok("the fabricated turn renders with its console", await show());
  check("(a) the console carries the copy attribute", await page.evaluate(() => document.querySelector("pre.job-out").closest("[data-copy]").className), "out-wrap out-tab");
  check("(a) it has exactly one copy button of its own", await page.evaluate(() => document.querySelectorAll(".out-wrap.out-tab > .copy-block").length), 1);
  const hiddenState = await stateOf(CONSOLE);
  check("(a) while nothing is hovered the button is hidden", { visibility: hiddenState.visibility, opacity: hiddenState.opacity }, { visibility: "hidden", opacity: 0 });
  // A part of the console that is not the burst inside it: hovering the console's own text line.
  await page.locator("pre.job-out .jl").first().hover();
  await page.waitForTimeout(320);
  const hoverState = await stateOf(CONSOLE);
  check("(a) hovering the console reveals exactly one button on the page", (await visible()).filter((b) => b.visibility === "visible").length, 1);
  check("(a) and it is the console's own", (await visible()).find((b) => b.visibility === "visible")?.parent, "out-wrap out-tab is-at-end");
  check("(a) the revealed button is opaque", { visibility: hoverState.visibility, opacity: hoverState.opacity }, { visibility: "visible", opacity: 1 });
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
  const leftState = await stateOf(CONSOLE);
  check("(a) leaving the pointer fades it out again", { visibility: leftState.visibility, opacity: leftState.opacity }, { visibility: "hidden", opacity: 0 });

  // ================= (b) the thinking block ========================================================
  console.log("\n== (b) hovering a thinking block ==");
  check("(b) the reasoning block carries the copy attribute", await page.evaluate(() => document.querySelector("details.think")?.hasAttribute("data-copy")), true);
  check("(b) it has exactly one copy button, and a folded block can still reach it (it lives in the summary)", await page.evaluate(() => [document.querySelectorAll("details.think > summary > .copy-block").length, document.querySelectorAll("details.think").length, document.querySelector("details.think").open]), [1, 1, false]);
  await page.locator("details.think > summary").first().hover();
  await page.waitForTimeout(320);
  check("(b) hovering it reveals exactly one button on the page", (await visible()).filter((b) => b.visibility === "visible").length, 1);
  check("(b) and it is the thinking block's own", (await visible()).find((b) => b.visibility === "visible")?.parent, "think");
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
  check("(b) leaving fades it out too", (await visible()).filter((b) => b.visibility === "visible").length, 0);

  // ================= (c) the tool burst: the call yes, the result lines no =========================
  console.log("\n== (c) hovering a tool burst ==");
  check("(c) the burst carries the copy attribute", await page.evaluate(() => document.querySelector("pre.job-out .tgrp").hasAttribute("data-copy")), true);
  check("(c) the burst has exactly one button, and it sits on the call's own row block", await page.evaluate(() => { const b = document.querySelector("pre.job-out .tgrp > .copy-block"); return b ? b.parentElement.className : null; }), "tgrp");
  check("(c) the result lines carry no button at all", await page.evaluate(() => document.querySelectorAll("pre.job-out .tgrp-body .copy-block").length), 0);
  const bodyHiddenBefore = await page.evaluate(() => document.querySelector("pre.job-out .tgrp-body").hidden);
  check("(c) the burst's results are folded to begin with", bodyHiddenBefore, true);
  await page.locator("pre.job-out .tgrp .tgrp-head").first().hover();
  await page.waitForTimeout(300);
  const burstHover = await visible();
  check("(c) hovering the burst reveals exactly one button", burstHover.filter((b) => b.visibility === "visible").length, 1);
  check("(c) and it is the burst's own — the console's stays hidden while a burst inside it is hovered", burstHover.find((b) => b.visibility === "visible")?.parent, "tgrp");

  // ================= a burst that holds more than one call ==========================================
  console.log("\n== a burst holding two calls ==");
  await show({ twoRows: true });
  check("the two-call burst renders one row per call", await page.evaluate(() => [...document.querySelectorAll("pre.job-out .tgrp-row")].map((r) => [...r.children].map((c) => c.innerText.trim()).filter(Boolean).join(" "))), [BURST_CALL, BASH_CALL]);
  check("its copy is one line per call, in the rows' own order", await blockText(BURST), [BURST_CALL, BASH_CALL].join("\n"));
  check("and the console's copy carries both on their own lines", await blockText(CONSOLE), [CONSOLE_TEXT, BURST_CALL, BASH_CALL, LAST_TEXT].join("\n"));
  await show({});

  // ================= (d) a press copies that block's own text, read back ===========================
  console.log("\n== (d) what lands on the clipboard ==");
  // The burst first: its call, one line, exactly as the row renders it.
  const burstExpect = await page.evaluate(() => window.__probe.renderedCall("pre.job-out .tgrp-row"));
  check("(d) the burst's call renders as one line", burstExpect, BURST_CALL);
  check("(d) the extractor reads that same line back out of the DOM", await blockText(BURST), BURST_CALL);
  await copyVia(BURST_BTN);
  const burstClip = await read();
  check("(d) the burst's clipboard read-back is the call, line for line", burstClip.replace(/\r\n/g, "\n"), BURST_CALL);
  const burstAfter = await stateOf(BURST);
  check("(d) the burst's button confirms the copy", { label: burstAfter.label, cls: burstAfter.cls }, { label: "✓", cls: "copy-block is-copied" });

  // The console: its own visible text, all of it, line breaks intact.
  const consoleExpect = await blockText(CONSOLE);
  check("(d) the console's text is its three rendered lines", consoleExpect, CONSOLE_FOLDED);
  check("(d) innerText alone would have been wrong — it breaks the flex row and carries control labels", await page.evaluate(() => window.__probe.innerTextOf("pre.job-out")).then((t) => t !== consoleExpect && /\d+ lines/.test(t)), true);
  await page.locator("pre.job-out .jl").first().hover();
  await page.waitForTimeout(250);
  await copyVia(CONSOLE_BTN);
  const consoleClip = await read();
  note(`clipboard, raw read-back: ${JSON.stringify(consoleClip)}`);
  check("(d) the console's clipboard read-back matches its visible text, line breaks and all", consoleClip.replace(/\r\n/g, "\n"), CONSOLE_FOLDED);
  check("(d) and no button label came with it", /⧉|copy this block|\d+ lines/.test(consoleClip), false);

  // The thinking block: its own text, from the store.
  await page.locator("details.think > summary").first().hover();
  await page.waitForTimeout(260);
  await page.evaluate(async () => {
    document.querySelector("details.think > summary > .copy-block").click();
    await new Promise((r) => setTimeout(r, 380));
  });
  const thinkClipClosed = await read();
  check("(d) the folded thinking block copies its own folded text", thinkClipClosed.replace(/\r\n/g, "\n"), THINK_FOLDED);
  check("(d) and the press did not toggle the block it copied from", await page.evaluate(() => document.querySelector("details.think").open), false);

  // ================= (e) folded copies folded, unfolded copies what it shows =======================
  console.log("\n== (e) what a folded block copies ==");
  const foldedBurstTextNow = await blockText(BURST);
  check("(e) while the burst is folded, its result lines are not in its own copy", RESULT_LINES.some((l) => foldedBurstTextNow.includes(l)), false);
  check("(e) nor in the console's copy", RESULT_LINES.some((l) => consoleExpect.includes(l)), false);
  check("(e) opening the burst shows the result lines", await page.evaluate(() => window.__probe.openBurst()), true);
  await page.waitForTimeout(200);
  const consoleOpen = await blockText(CONSOLE);
  note(`console with the burst open: ${JSON.stringify(consoleOpen)}`);
  check("(e) now the console's copy carries every result line it shows", RESULT_LINES.every((l) => consoleOpen.includes(l)), true);
  check("(e) and still starts with the same first line", consoleOpen.split("\n")[0], CONSOLE_TEXT);
  check("(e) an unfolded thinking block copies its reasoning too", await (async () => {
    await show({ openThink: true });
    return (await blockText(THINK)) === THINK_OPEN;
  })(), true);
  check("(e) and the reasoning's line breaks survive the clipboard", await page.evaluate(async () => {
    const btn = document.querySelector("details.think > summary > .copy-block");
    btn.click();
    await new Promise((r) => setTimeout(r, 380));
    return navigator.clipboard.readText();
  }).then((t) => t.replace(/\r\n/g, "\n")), THINK_OPEN);
  await show({});
  check("(e) a fresh folded thinking block is back to its folded text", await blockText(THINK), THINK_FOLDED);

  // ================= (f) the pinned copy ===========================================================
  console.log("\n== (f) the pinned copy of a console ==");
  await show({ pin: true, pinOpen: true });
  check("(f) the turn renders twice — its page copy and its pinned copy", await page.evaluate(() => [...document.querySelectorAll("pre.job-out")].map((o) => o.dataset.out)), ["probe-turn@pin", "probe-turn"]);
  check("(f) both consoles carry the attribute", await page.evaluate(() => [...document.querySelectorAll("pre.job-out")].every((o) => o.closest("[data-copy]"))), true);
  check("(f) and each has its own single button", await page.evaluate(() => [...document.querySelectorAll("pre.job-out")].map((o) => o.closest(".out-wrap").querySelectorAll(":scope > .copy-block").length)), [1, 1]);
  const pinnedText = await page.evaluate(() => blockCopyText(document.querySelector('.pinned-turns pre[data-out$="@pin"]').closest(".out-wrap")));
  const pageText = await page.evaluate(() => blockCopyText(document.querySelector('pre[data-out="probe-turn"]').closest(".out-wrap")));
  check("(f) the pinned copy's text is its page copy's text, character for character", pinnedText, pageText);
  check("(f) and both are the console's visible text", pinnedText, CONSOLE_FOLDED);
  await page.locator('.pinned-turns pre[data-out$="@pin"]').hover();
  await page.waitForTimeout(300);
  const pinnedVisible = (await visible()).filter((b) => b.visibility === "visible");
  check("(f) hovering the pinned console reveals exactly one button, its own", pinnedVisible.length, 1);
  await page.evaluate(() => document.querySelector('.pinned-turns pre[data-out$="@pin"]').closest(".out-wrap").querySelector(":scope > .copy-block").click());
  await page.waitForTimeout(350);
  check("(f) and its press puts the same text on the clipboard", (await read()).replace(/\r\n/g, "\n"), CONSOLE_FOLDED);
  await show({ pin: true, pinOpen: true });

  // ================= (g) inert while hidden, absent, and no reflow =================================
  console.log("\n== (g) hidden means inert, and appearing moves nothing ==");
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
  const buried = await stateOf(CONSOLE);
  check("(g) not visible, not clickable, not selectable", { visibility: buried.visibility, pointerEvents: buried.pointerEvents, userSelect: buried.userSelect }, { visibility: "hidden", pointerEvents: "none", userSelect: "none" });
  ok("(g) the pointer at the button's own centre never reaches the button", !String(buried.hitAtCentre).includes("copy-block"), `it reaches ${JSON.stringify(buried.hitAtCentre)}`);
  check("(g) a programmatic focus() does not land on it", buried.focusable, false);
  const axHidden = await axNames();
  check("(g) it is absent from the accessibility tree while hidden", axHidden, []);
  const selected = await page.evaluate(() => window.__probe.selectionOf(".out-wrap.out-tab"));
  ok("(g) a selection over the whole block picks up no button of the panel's own", !selected.includes("⧉") && !selected.includes("copy this block"), JSON.stringify(selected));
  ok("(g) but it does pick up the block's own text", selected.includes(CONSOLE_TEXT) && selected.includes(LAST_TEXT), JSON.stringify(selected.slice(0, 80)));
  const before = await rects(CONSOLE);
  await page.locator("pre.job-out .jl").first().hover();
  await page.waitForTimeout(300);
  const after = await rects(CONSOLE);
  check("(g) revealing it moves the block by nothing", { block: after.block, scrollHeight: after.scrollHeight }, { block: before.block, scrollHeight: before.scrollHeight });
  check("(g) and the block's scroll position is untouched", after.scrollTop, before.scrollTop);
  const axShown = await axNames();
  ok("(g) it does enter the accessibility tree once revealed", axShown.length === 1, JSON.stringify(axShown));
  const coverConsole = await rects(CONSOLE);
  const clear = (btn, box) => !btn || !box || btn.x >= box.right || btn.right <= box.x || btn.y >= box.bottom || btn.bottom <= box.y;
  ok("(g) the button does not cover the console's first line", clear(coverConsole.button, coverConsole.firstLineText), JSON.stringify({ button: coverConsole.button, firstLineText: coverConsole.firstLineText }));
  ok("(g) nor the burst's fold chevron", clear(coverConsole.button, coverConsole.chevron), JSON.stringify({ button: coverConsole.button, chevron: coverConsole.chevron }));
  ok("(g) it sits inside the block it belongs to", coverConsole.button.x >= coverConsole.block.x && coverConsole.button.right <= coverConsole.block.right, JSON.stringify({ block: coverConsole.block, button: coverConsole.button }));
  await page.locator("pre.job-out .tgrp .tgrp-head").first().hover();
  await page.waitForTimeout(300);
  const coverBurst = await rects(BURST);
  ok("(g) the burst's button does not cover the call's own text", clear(coverBurst.button, coverBurst.firstLineText), JSON.stringify({ button: coverBurst.button, firstLineText: coverBurst.firstLineText }));
  ok("(g) nor the burst's fold chevron", clear(coverBurst.button, coverBurst.chevron), JSON.stringify({ button: coverBurst.button, chevron: coverBurst.chevron }));
  await page.locator("details.think > summary").first().hover();
  await page.waitForTimeout(320);
  const coverThink = await rects(THINK);
  ok("(g) the thinking button does not cover the title line (its chevron is at the left of the same line)", clear(coverThink.button, coverThink.firstLineText), JSON.stringify({ button: coverThink.button, firstLineText: coverThink.firstLineText }));
  const consoleTop = (await rects(CONSOLE)).block.y;
  ok("(g) and what a folded thinking block leaves below the button is empty space, not the console", coverThink.button.bottom <= consoleTop, `button bottom ${coverThink.button.bottom}, console top ${consoleTop}`);
  ok("(g) the thinking button stays inside the block's own width", coverThink.button.x >= coverThink.block.x && coverThink.button.right <= coverThink.block.right, JSON.stringify({ block: coverThink.block, button: coverThink.button }));

  // ================= (h) nothing that worked before broke ==========================================
  console.log("\n== (h) the console's own behaviour is untouched ==");
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);
  // the burst's own fold, by its own chevron button
  const grouped = await page.evaluate(() => {
    const btn = document.querySelector("pre.job-out .tgrp-more");
    const was = document.querySelector("pre.job-out .tgrp-body").hidden;
    btn.click();
    return { was, now: document.querySelector("pre.job-out .tgrp-body").hidden };
  });
  check("(h) the burst's fold button still folds it", grouped, { was: true, now: false });
  await page.waitForTimeout(200);
  const foldedAgain = await page.evaluate(() => {
    const btn = document.querySelector("pre.job-out .tgrp-more");
    btn.click();
    return document.querySelector("pre.job-out .tgrp-body").hidden;
  });
  check("(h) and still unfolds it", foldedAgain, true);
  // a drag-select across the console
  const box = await page.locator("pre.job-out").first().boundingBox();
  await page.mouse.move(box.x + 10, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + box.height - 6, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const dragSel = await page.evaluate(() => document.getSelection().toString());
  ok("(h) a drag across the console still selects its text", dragSel.includes(CONSOLE_TEXT), JSON.stringify(dragSel.slice(0, 120)));
  check("(h) and picks up no button label", /⧉/.test(dragSel), false);
  // Ctrl+wheel over the console still resizes its text
  const sizeBefore = await page.evaluate(() => getComputedStyle(document.querySelector("pre.job-out")).fontSize);
  await page.locator("pre.job-out").first().hover();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Control");
  await page.waitForTimeout(250);
  let sizeAfter = await page.evaluate(() => getComputedStyle(document.querySelector("pre.job-out")).fontSize);
  if (sizeAfter === sizeBefore) {
    note("(the real Ctrl+wheel did not reach the page as a ctrl-modified wheel — dispatching the same event)");
    await page.evaluate(() => document.querySelector("pre.job-out").dispatchEvent(new WheelEvent("wheel", { deltaY: -120, ctrlKey: true, bubbles: true, cancelable: true })));
    await page.waitForTimeout(200);
    sizeAfter = await page.evaluate(() => getComputedStyle(document.querySelector("pre.job-out")).fontSize);
  }
  ok("(h) Ctrl+wheel over the console still resizes its text", parseFloat(sizeAfter) > parseFloat(sizeBefore), `${sizeBefore} -> ${sizeAfter}`);
  // the console still follows its newest line
  await page.evaluate(() => window.__probe.appendLines(60, "follow-scroll line"));
  await page.waitForTimeout(400);
  const follow = await page.evaluate(() => window.__probe.followScroll());
  ok("(h) the console still follows its newest line", follow.atEnd && follow.top > 0, JSON.stringify(follow));
  const followedText = await blockText(CONSOLE);
  ok("(h) and the new lines are part of what it copies", followedText.includes("follow-scroll line 60"), followedText.slice(-80));
  // clicking the fold header still folds the turn
  await show({});
  const foldedTurn = await page.evaluate(() => {
    const turn = document.querySelector(".turn");
    turn.querySelector(".turn-head").click();
    return { turn: document.querySelector(".turn") ? document.querySelector(".turn").className : "no turn", console: Boolean(document.querySelector("pre.job-out")) };
  });
  ok("(h) clicking the turn's fold header still folds the turn", /folded/.test(foldedTurn.turn) && !foldedTurn.console, JSON.stringify(foldedTurn));
  const unfoldedTurn = await page.evaluate(() => {
    document.querySelector(".turn-head").click();
    return document.querySelector(".turn").className;
  });
  ok("(h) and unfolding it brings the console back", !/folded/.test(unfoldedTurn), unfoldedTurn);
  check("(h) with its button mounted again", await page.evaluate(() => document.querySelectorAll("pre.job-out > .copy-block").length), 0);
  check("(h) (the button belongs to the console's wrapper, not the console itself)", await page.evaluate(() => document.querySelectorAll(".out-wrap.out-tab > .copy-block").length), 1);

  // ================= a copy that fails must never look like a success ==============================
  console.log("\n== the fallback and the failure path ==");
  await show({});
  await page.locator("pre.job-out").first().hover();
  await page.waitForTimeout(250);
  await page.evaluate(() => window.__probe.write("sentinel-before"));
  check("a sentinel is on the clipboard to begin with", await read(), "sentinel-before");
  await page.evaluate(() => window.__probe.breakClipboard("write"));
  check("the async clipboard is now refusing", await page.evaluate(async () => { try { await navigator.clipboard.writeText("x"); return "accepted"; } catch { return "refused"; } }), "refused");
  await copyVia(CONSOLE_BTN);
  const fallbackClip = await read();
  check("the fallback still puts the block's text on the clipboard", fallbackClip.replace(/\r\n/g, "\n"), CONSOLE_FOLDED);
  const fallbackState = await stateOf(CONSOLE);
  check("and the button confirms that copy", { label: fallbackState.label, cls: fallbackState.cls }, { label: "✓", cls: "copy-block is-copied" });
  await page.waitForTimeout(4200);
  // The clipboard works again: put a sentinel on it, then break BOTH writers and prove the press says so.
  await page.evaluate(() => window.__probe.restoreClipboard());
  await page.evaluate(() => window.__probe.write("sentinel-after"));
  await page.evaluate(() => window.__probe.breakClipboard("all"));
  await copyVia(CONSOLE_BTN);
  const failedState = await stateOf(CONSOLE);
  check("a copy that fails shows a failure, never the tick", failedState.label, "✕");
  check("and says so on the button", failedState.cls, "copy-block is-failed");
  check("and leaves the clipboard exactly as it was", (await read()).replace(/\r\n/g, "\n"), "sentinel-after");
  await page.evaluate(() => window.__probe.restoreClipboard());
  await page.waitForTimeout(4200);
  check("restored: the async clipboard works again", await page.evaluate(async () => { await navigator.clipboard.writeText("x"); return true; }), true);
  check("no page errors anywhere in this run", pageErrors, []);

  // ================= the mechanism is opt-in: a block that carries the attribute, and nothing else =====
  // This is the whole of the claim the brief makes about the console's code and diff windows: a block
  // another worker draws opts in by carrying the attribute, without knowing this code exists. The block
  // below is created at runtime, so no renderer in the file has ever seen it.
  console.log("\n== a block that opts in by carrying the attribute ==");
  await page.evaluate(() => {
    const host = document.querySelector(".job .job-body") || document.querySelector("#jobs");
    const el = document.createElement("div");
    el.className = "probe-injected";
    el.setAttribute("data-copy", "");
    el.style.cssText = "position: relative; padding: 6px 10px; border: 1px solid #39424f;";
    el.innerHTML = "<div>a block another worker draws</div><div>its second line</div>";
    host.appendChild(el);
  });
  await page.waitForTimeout(200);
  check("a block created at runtime gets exactly one button, from the observer alone", await page.evaluate(() => document.querySelectorAll(".probe-injected > .copy-block").length), 1);
  await page.locator(".probe-injected").hover();
  await page.waitForTimeout(320);
  check("hovering it reveals that button", await page.evaluate(() => getComputedStyle(document.querySelector(".probe-injected > .copy-block")).visibility), "visible");
  await copyVia(".probe-injected > .copy-block");
  check("and its press copies that block's own two lines", (await read()).replace(/\r\n/g, "\n"), ["a block another worker draws", "its second line"].join("\n"));
  check("with no renderer having written a button for it", await page.evaluate(() => document.querySelectorAll(".probe-injected > .copy-block").length), 1);
  await page.evaluate(() => document.querySelector(".probe-injected").remove());
  await page.waitForTimeout(150);

  await browser.close();
  browserRef = null;
}

// ---- what can only be read off the source --------------------------------------------------------
function sourceChecks() {
  const app = readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const css = readFileSync(path.join(ROOT, "public", "style.css"), "utf8");
  const lines = app.split(/\r?\n/);
  const count = (re) => lines.filter((l) => re.test(l)).length;
  check("inspected: one delegated handler is registered for [data-copy-btn]", count(/closest\(COPY_BTN_SEL\)/), 1);
  check("inspected: and it is the only click listener that mentions the copy button", count(/addEventListener\(\s*"click"[\s\S]*COPY_BTN_SEL/), 0);
  const block = app.slice(app.indexOf("// ---- copy buttons"), app.indexOf("// A console follows its newest line"));
  check("inspected: the button markup is built in exactly one place", (block.match(/copyButtonHtml\(\)/g) || []).length, 2); // the definition + the one mount
  check("inspected: the button is mounted, never written by a renderer", count(/insertAdjacentHTML\("beforeend", copyButtonHtml\(\)\)/), 1);
  ok("inspected: the mount is driven by a MutationObserver over the whole document", /new MutationObserver/.test(block) && /observe\(document\.documentElement, \{ childList: true, subtree: true \}\)/.test(block));
  check("inspected: three blocks opt in with the one attribute — the console, the tool burst, the thinking block", lines.filter((l) => /class="[^"]*" data-copy[ >]/.test(l)).length, 3);
  check("inspected: the reveal is CSS, keyed on that attribute", count(/^\[data-copy\]:hover > \.copy-block \{/m) || (css.includes("[data-copy]:hover > .copy-block") ? 1 : 0), 1);
  ok("inspected: and the button is hidden by visibility+opacity+pointer-events, so it is out of the a11y tree and out of a selection", /\.copy-block \{[\s\S]*?visibility: hidden;[\s\S]*?pointer-events: none;[\s\S]*?user-select: none;/.test(css));
  ok("inspected: the gutter the button needs is reserved whether or not it is showing", /\[data-copy\] > \.job-out,[\s\S]*?padding-right: 24px;/.test(css));
  ok("inspected: the copy writer is the panel's existing one (secure context, then a textarea fallback)", /async function copyText\(text\)/.test(app) && /document\.execCommand\("copy"\)/.test(app));
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
    note(`port ${port} — the live board on 7331 is not touched`);
    check("the sandbox panel is the one that answered", (await fetch(`${base}/api/state`)).ok, true);
  }

  console.log("\n== what can only be read off the source ==");
  sourceChecks();

  console.log("\n== the browser: real pointer, real clipboard, real accessibility tree ==");
  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN  the client half of this change was not exercised in a browser.");
    note("re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-copy-buttons.mjs");
    failures += 1;
  } else {
    await browserPhase(pw);
  }

  console.log("\n== summary ==");
  console.log(`${checks} checks, ${failures} failed`);
  console.log("\nWHAT WAS DRIVEN: a panel of this checkout on a spare port plus headless Chromium over it, with real");
  console.log("pointer moves, real clicks, a real drag-select, a real Ctrl+wheel and real focus attempts; the clipboard");
  console.log("read BACK for every copy (granted clipboard-read/write on the origin) and compared with the text the");
  console.log("block shows, with the raw read-back printed (Windows normalises line breaks to CRLF there); the");
  console.log("accessibility tree over CDP, once hidden and once revealed; and the failure path by making the async");
  console.log("clipboard reject, then both writers fail.");
  console.log("WHAT WAS INSPECTED, NOT DRIVEN: that the mechanism is one delegated listener, one attribute and one CSS");
  console.log("reveal read off public/app.js and public/style.css, and that the button is built in a single place —");
  console.log("which is what lets a block another worker adds opt in by carrying the attribute.");
  if (!failures) console.log("COPY-BUTTONS-OK");
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
