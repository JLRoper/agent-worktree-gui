// The console's boxes, proved in a real browser against THIS checkout's public/**: the frame's body is the
// changed file's own lines with the identifiers in its header (a), the new side is the LEFT one in a two-sided
// diff and the tones did not move with it (b), a hunk the gateway's preview cut says so at its cut edge (c), and
// a click on a tool call's own row folds and unfolds that call's output and nothing else (d).
//
//   node tools/verify-console-boxes.mjs
//   PANEL_PLAYWRIGHT_ROOT=C:/ProjectDevelopment/heroes-js node tools/verify-console-boxes.mjs
//
// WHAT IS DRIVEN, AND WHAT IS ONLY INSPECTED
//
//   driven     a panel of its own on a spare port (never 7331, apiServer pinned at a dead port so nothing here
//              can buy a worker) plus headless Chromium over it, on a card fabricated in the page's own state
//              (state.jobs + state.jobLines, painted by the shipped renderJobs) so every box under test is a real
//              render of real rows: the docker-pods worker's own AGENTS.md preview, copied out of logs/jobs.json
//   driven     the fold: a real click on the call's row, a real Tab to its caret button, real Enter and Space, a
//              real drag-select across the call's text, a real press on the copy button - and the DOM read back
//              after each one (aria-expanded, .call-body hidden, the head's line count)
//   driven     the repaint and the burst rebuild: renderJobs() again (the reader's fold has to survive it) and
//              rebuildToolGroup() over the live node, which re-derives the diff from the DOM - so the reading
//              that undoes the swapped pair (data-lpair) is exercised for real, and a change that came back as a
//              lone addition plus a lone removal would show up here
//   driven     the store path: the session store's own row for that call (seeded, as the panel's /api/tool-results
//              answers) fills the frame with the whole change; with the store empty the same rows draw the cut
//              row instead
//   inspected  that the fold is one delegated handler and one attribute (read off public/app.js and
//              public/style.css), not per-renderer markup
//
// The browser half needs a Playwright install; without one this prints BROWSER-HALF-NOT-RUN, counts a failure and
// exits non-zero rather than passing on a half that never ran.
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
const THREAD = "wtgui-probe-console-boxes-4d7a01";
let dir = null;
let panel = null;
let base = LIVE;
const panelLog = [];

async function startSandbox() {
  dir = mkdtempSync(path.join(tmpdir(), "wtgui-console-boxes-"));
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

// ---- the fixture ---------------------------------------------------------------------------------
// Real rows, copied out of logs/jobs.json (job c9202ee0): the docker-pods worker's patch on AGENTS.md, cut by the
// gateway's preview after two context lines of a 46-line addition, and its patch on docs/operations.md, whose
// preview carries a change block the two-sided window has to draw.
const AGENTS_PATH = "C:\\ProjectDevelopment\\heroes-js\\.worktrees\\docker-pods-per-run-acce-a6c573\\AGENTS.md";
const AGENTS_CALL = `🔧 patch · C:/ProjectDevelopment/heroes-js/.worktrees/docker-pods-per-run-acce-a6c573/AGENTS.md`;
const AGENTS_PREVIEW = [
  "--- a/" + AGENTS_PATH,
  "+++ b/" + AGENTS_PATH,
  "@@ -36,6 +36,46 @@",
  " - Identity in this repo's coordination is `.agentboard/{PID}.json` + the `.plans/` file + `.alock` PIDs.",
  ' - A user "stop" is a hard brake: execute only the literal instruction.',
  "… result truncated by the gateway — the live stream carries a preview of a tool result, not all of it",
];
// What the session store holds for that same call: the whole hunk the preview stopped inside of.
const AGENTS_STORED = [
  "--- a/" + AGENTS_PATH,
  "+++ b/" + AGENTS_PATH,
  "@@ -36,6 +36,46 @@",
  " - Identity in this repo's coordination is `.agentboard/{PID}.json` + the `.plans/` file + `.alock` PIDs.",
  ' - A user "stop" is a hard brake: execute only the literal instruction, keep every other action read-only.',
  " - Session renames are done by the human in the client.",
  "+",
  "+## Per-run docker pods (an isolated db + api + web per run, on its own ports)",
  "+",
  "+- A **pod** is a per-run copy of the stack: its own postgres, api and web, on its own ports.",
  "+- Create one with `npm run pod:up`, list with `npm run pod:list`, remove with `npm run pod:down -- <name>`.",
  "+- Pods are labelled `heroes.pod=<name>`, so `pod:prune` can never touch the shared stack.",
];
const OPS_PATH = "C:\\ProjectDevelopment\\heroes-js\\.worktrees\\docker-pods-per-run-acce-a6c573\\docs\\operations.md";
const OPS_CALL = `🔧 patch · C:/ProjectDevelopment/heroes-js/.worktrees/docker-pods-per-run-acce-a6c573/docs/operations.md`;
const OPS_PREVIEW = [
  "--- a/" + OPS_PATH,
  "+++ b/" + OPS_PATH,
  "@@ -9,6 +9,7 @@",
  " - Use Node.js 22+ and `npm install`; `npm run dev` starts the Vite client and API.",
  "- Local PostgreSQL uses the shared `game_db` container on host port 5432.",
  "+- A **pod** is a per-run copy of that stack — its own postgres, api and web, its own ports.",
  " - The API applies `server/schema.sql` and the ordered migration set during startup.",
];
const FIRST_TEXT = "docker pods per run, acceptance first";
const LAST_TEXT = "pods are up and the ports are recorded";

async function browserPhase(pw) {
  const pageErrors = [];
  const browser = await pw.chromium.launch({ headless: true });
  browserRef = browser;
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const realSnapshot = await fetch(`${base}/api/state`).then((r) => r.json());
  await installFakeEventSource(context);
  await context.addInitScript(
    ({ snapshot, agentsCall, agentsPreview, agentsStored, opsCall, opsPreview, firstText, lastText }) => {
      const realFetch = window.fetch.bind(window);
      const probe = { snapshot, folded: [] };
      window.__probe = probe;
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      window.fetch = async (url, opts = {}) => {
        const u = String(url);
        if (String((opts && opts.method) || "GET").toUpperCase() !== "POST") {
          if (u.includes("/api/state")) return json({ ...probe.snapshot, jobs: [...state.jobs.values()] });
          if (u.includes("/api/tool-results")) return json({ thread: "probe", tool: "patch", results: probe.store || [] });
          return realFetch(url, opts);
        }
        return json({ ok: true });
      };

      // The turn, fabricated in the PAGE's own state and painted by the shipped renderJobs(): two patch calls in
      // one burst, the first with the gateway's cut preview, the second with a change block.
      probe.show = (opts = {}) => {
        const id = opts.id || "probe-turn";
        const lines = [
          { kind: "text", text: firstText, lid: "l1" },
          { kind: "tool", text: agentsCall, at: Date.now() - 90_000 },
          { kind: "tool-out", text: "  ↳ patch · 79.51s" },
          ...agentsPreview.map((text) => ({ kind: "tool-out", text })),
          { kind: "tool", text: opsCall, at: Date.now() - 80_000 },
          { kind: "tool-out", text: "  ↳ patch · 5.66s" },
          ...opsPreview.map((text) => ({ kind: "tool-out", text })),
          { kind: "text", text: lastText, lid: "l2" },
        ];
        state.jobs.clear();
        state.jobLines.clear();
        state.toolStore.clear();
        state.toolGroupOpen.clear();
        state.codeBoxOpen.clear();
        state.callFolded.clear();
        state.outPinned = {};
        // renderJobs() rewrites the card list only when the set of cards, or a card's own conversationSignature,
        // has moved — that is what stops a live console being replaced under the reader on every append. This probe
        // paints the SAME turn twice (with the store's row and without it) to drive the cut edge, which moves no
        // signature: clear the memo first, or section (c) measures the card (a) left in the DOM (its stored rows
        // already fill the frame, so the cut row it is looking for was never drawn).
        state.jobsListSig = "";
        // The card fills the window, which is a state the reader has a button for ("expand this chat to fill the
        // window"): the console then has no max-height, so nothing under test is scrolled out of the box the
        // pointer has to reach.
        state.maximized = id;
        state.jobLines.set(id, lines);
        state.jobs.set(id, {
          id,
          thread: id,
          turn: 1,
          status: "done",
          prompt: "console boxes probe",
          displayPrompt: "console boxes probe",
          cwd: null,
          worktree: false,
          worktreePath: null,
          projectPath: null,
          ownerPath: null,
          branch: null,
          runId: "run_probe",
          startedAt: new Date(Date.now() - 120_000).toISOString(),
          endedAt: new Date(Date.now() - 60_000).toISOString(),
          model: "probe/model",
          lines: [],
          artifacts: [],
          attachments: [],
          subagents: [],
        });
        // The store's row for that tool, as /api/tool-results answers it: the whole change the preview cut.
        if (opts.stored !== false) {
          probe.store = [
            { text: agentsStored.join("\n"), truncated: false },
            { text: opsPreview.join("\n"), truncated: false },
          ];
          state.toolStore.set(`${id}|patch`, { at: Date.now(), live: false, results: probe.store });
        } else {
          probe.store = [];
        }
        // The burst is open, which is how the reader saw it on the board. The state key carries the burst's own
        // anchor (its first line's timestamp), so the group is opened the way a click opens it - through the
        // shipped rememberToolGroup - rather than by guessing the key here.
        renderJobs();
        // Every result is a box and every box starts folded (core/console-format.js). A probe about what a CALL's fold
        // hides asks for them open the way a reader does: a real click on each box's own head.
        if (opts.openBoxes) for (const head of document.querySelectorAll("pre.job-out .code-head")) head.click();
        const grp = document.querySelector("pre.job-out .tgrp");
        const body = grp && grp.querySelector(".tgrp-body");
        if (body && body.hidden) {
          body.hidden = false;
          rememberToolGroup(grp);
        }
        return Boolean(document.querySelector("pre.job-out .tgrp"));
      };

      // ---- readings ----
      probe.calls = () =>
        [...document.querySelectorAll("pre.job-out .call")].map((c) => ({
          key: c.dataset.callKey,
          folded: c.classList.contains("is-folded"),
          expanded: c.querySelector("[data-call-fold]").getAttribute("aria-expanded"),
          caret: c.querySelector("[data-call-fold]").textContent,
          hidden: c.querySelector(".call-body").hidden,
          head: c.querySelector(".call-head > .jl").dataset.ltext,
          headHeight: Math.round(c.querySelector(".call-head").getBoundingClientRect().height),
          lineHeight: Math.round(parseFloat(getComputedStyle(c.querySelector(".call-head")).lineHeight) || 0),
          summary: c.querySelector(".call-n").textContent,
          hintShown: !c.querySelector(".call-hint").hidden,
          bodyLines: [...c.querySelectorAll(".call-body .jl")].map((d) => d.dataset.ltext),
          button: c.querySelector("[data-call-fold]").tagName,
        }));
      probe.callAt = (i) => probe.calls()[i];
      probe.bodyHtml = (i) => document.querySelectorAll("pre.job-out .call")[i].querySelector(".call-body").innerHTML;
      probe.headHtml = (i) => document.querySelectorAll("pre.job-out .call")[i].querySelector(".call-head").outerHTML;
      probe.geometry = () => ({
        jobCls: (document.querySelector(".job") || {}).className || "",
        gstate: (document.querySelector("pre.job-out .tgrp") || { dataset: {} }).dataset.gstate || "",
        tgrpBodyHidden: (document.querySelector("pre.job-out .tgrp-body") || { hidden: "none" }).hidden,
        outH: Math.round((document.querySelector("pre.job-out") || { getBoundingClientRect: () => ({ height: -1 }) }).getBoundingClientRect().height),
        bodyH: Math.round((document.querySelector("pre.job-out .tgrp-body") || { getBoundingClientRect: () => ({ height: -1 }) }).getBoundingClientRect().height),
        callH: Math.round((document.querySelector("pre.job-out .call") || { getBoundingClientRect: () => ({ height: -1 }) }).getBoundingClientRect().height),
        headH: Math.round((document.querySelector("pre.job-out .call-head") || { getBoundingClientRect: () => ({ height: -1 }) }).getBoundingClientRect().height),
        hintHidden: document.querySelector(".call-hint") ? document.querySelector(".call-hint").hidden : "no hint",
      });
      probe.diffRows = (i) => {
        const win = document.querySelectorAll("pre.job-out .call")[i].querySelector(".df-win");
        return {
          head: [...win.querySelectorAll(".df-head .df-label")].map((l) => `${l.className.replace("jl jl-tool-out ", "")} ${l.innerText}`),
          rows: [...win.querySelectorAll(".df-body > .df-row")].map((r) => ({
            lpair: r.dataset.lpair || "",
            cells: [...r.children].map((c) => `${c.className.replace("jl jl-tool-out ", "")} ${c.innerText.trim()}`),
          })),
          cut: [...win.querySelectorAll(".df-body .df-cut")].map((d) => d.innerText.trim()),
          bodyText: [...win.querySelectorAll(".df-body .jl")].map((d) => d.dataset.ltext),
        };
      };
      probe.cardText = () => document.querySelector("pre.job-out").innerText;
      probe.consoleCopy = () => blockCopyText(document.querySelector("pre.job-out"));
      probe.copyPieces = () => ({
        resultLineInner: JSON.stringify(document.querySelectorAll("pre.job-out .call-body .jl")[0].innerText),
        resultLineData: JSON.stringify(document.querySelectorAll("pre.job-out .call-body .jl")[0].dataset.ltext),
        bodyCopy: JSON.stringify(blockCopyText(document.querySelector("pre.job-out .call-body"))),
        headCopy: JSON.stringify(blockCopyText(document.querySelector("pre.job-out .call-head"))),
      });
      probe.cutNoteCount = () => document.querySelectorAll(".df-cut").length;
      // A cut row that is NOT inside a frame: the complaint the reader made, made checkable.
      probe.looseCut = () => [...document.querySelectorAll(".df-cut")].filter((d) => !d.closest(".df-win")).length;
      probe.selectionIn = (i) => {
        const sel = document.getSelection();
        const el = document.querySelectorAll("pre.job-out .call")[i];
        return {
          text: String(sel),
          inCall: sel && sel.rangeCount ? el.contains(sel.getRangeAt(0).startContainer) : false,
          atPoint: (() => {
            const r = el.querySelector(".call-head > .jl").getBoundingClientRect();
            const n = document.elementFromPoint(r.x + 8, r.y + r.height / 2);
            return n ? `${n.tagName}.${String(n.className).split(" ").slice(0, 3).join(".")} ${String(n.textContent).slice(0, 24)}` : "nothing";
          })(),
        };
      };
      probe.copyButton = () => document.querySelector("pre.job-out .tgrp > .copy-block");
      probe.tabToFold = (i) => {
        const btn = document.querySelectorAll("pre.job-out .call")[i].querySelector("[data-call-fold]");
        btn.focus();
        return document.activeElement === btn;
      };
      probe.repaint = () => {
        renderJobs();
        return document.querySelectorAll("pre.job-out .call").length;
      };
      probe.rebuild = (i) => {
        const grp = document.querySelectorAll("pre.job-out .tgrp")[i];
        rebuildToolGroup(grp, { open: true });
        return document.querySelectorAll("pre.job-out .tgrp")[i].querySelectorAll(".call").length;
      };
      probe.rebuildFromDom = (i) => {
        // The path that re-derives the lines from the markup rather than from the burst's own buffer: this is
        // what the swapped pair's data-lpair has to survive.
        const grp = document.querySelectorAll("pre.job-out .tgrp")[i];
        const lines = groupLines(grp);
        return lines.map((l) => l.text);
      };
      probe.holdKey = (i) => document.querySelectorAll("pre.job-out .call")[i].dataset.callKey;
    },
    {
      snapshot: realSnapshot,
      agentsCall: AGENTS_CALL,
      agentsPreview: AGENTS_PREVIEW,
      agentsStored: AGENTS_STORED,
      opsCall: OPS_CALL,
      opsPreview: OPS_PREVIEW,
      firstText: FIRST_TEXT,
      lastText: LAST_TEXT,
    },
  );
  const page = await context.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e && e.message)));
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await waitFor(async () => page.evaluate(() => typeof window.__probe === "object" && typeof window.renderJobs === "function"), {
    timeoutMs: 30_000,
    what: "the page's own app.js to be up",
  });
  const show = (opts = {}) => page.evaluate((o) => window.__probe.show(o), opts);
  const calls = () => page.evaluate(() => window.__probe.calls());
  // Where to put the pointer: the console scrolls (its own max-height, and it follows the newest line), so a row's
  // box can be measured while it is scrolled out of the box's visible area - and a pointer moved there lands on
  // whatever is behind the console. So the point is measured with Playwright's own scrolling, and then CHECKED
  // against elementFromPoint before anything is pressed; a stale measure is retired and taken again.
  const pointOver = async (locator, inside, dx = 8) => {
    for (let i = 0; i < 8; i++) {
      try {
        await locator.scrollIntoViewIfNeeded();
        const box = await locator.boundingBox();
        if (box && box.height > 0) {
          const x = box.x + dx;
          const y = box.y + box.height / 2;
          const over = await page.evaluate(([px, py, sel]) => Boolean(document.elementFromPoint(px, py)?.closest(sel)), [x, y, inside]);
          if (over) return { x, y };
        }
      } catch {
        /* the node was replaced under us: measure again */
      }
      await sleep(150);
    }
    return null;
  };
  const callLocator = (i, sel = ".call-head") => page.locator("pre.job-out .call").nth(i).locator(sel);
  // A box, measured after Playwright has scrolled it into view: both ends of a drag come from ONE measurement, so
  // the two points are on the same line even if the console moves afterwards.
  const boxOf = async (locator) => {
    for (let i = 0; i < 8; i++) {
      try {
        await locator.scrollIntoViewIfNeeded();
        const box = await locator.boundingBox();
        if (box && box.height > 0) return box;
      } catch {
        /* the node was replaced under us: measure again */
      }
      await sleep(150);
    }
    return null;
  };

  // ---- the frame: the store fills it, and the preview's cut says so when it cannot -----------------
  console.log("\n== (a)/(b) the frame the reader sees ==");
  ok("the card renders the burst with one .call per tool call", await show({}), true);
  check("(d) two calls, each with its own fold key", (await calls()).map((c) => c.button), ["BUTTON", "BUTTON"]);
  if (process.env.PROBE_DUMP === "1") {
    note(`geometry: ${JSON.stringify(await page.evaluate(() => window.__probe.geometry()))}`);
    note(`console copy: ${JSON.stringify(await page.evaluate(() => window.__probe.consoleCopy()))}`);
    note(`copy pieces: ${JSON.stringify(await page.evaluate(() => window.__probe.copyPieces()))}`);
  }
  const a0 = await page.evaluate(() => window.__probe.diffRows(0));
  note(`(a) header: ${JSON.stringify(a0.head)}`);
  check(
    "(a) the AGENTS.md case: the identifiers are the frame's header, not rows of its body",
    a0.head.map((h) => h.replace(/^jl jl-\w+ /, "")),
    [
      "df-label is-minus --- …/.worktrees/docker-pods-per-run-acce-a6c573/AGENTS.md",
      "df-label is-plus +++ …/.worktrees/docker-pods-per-run-acce-a6c573/AGENTS.md",
      "df-label is-hunk @@ -36,6 +36,46 @@",
    ],
  );
  ok(
    "(a) the AGENTS.md case: no @@/---/+++ row anywhere in the frame's body",
    !a0.bodyText.some((t) => /^(?:@@|--- |\+\+\+ |diff --git|index )/.test(t)),
    JSON.stringify(a0.bodyText.slice(0, 3)),
  );
  ok(
    "(a) the AGENTS.md case: the body carries the file's own changed lines (from the session store, the whole hunk the preview cut)",
    a0.bodyText.includes("+## Per-run docker pods (an isolated db + api + web per run, on its own ports)") &&
      a0.bodyText.some((t) => t.startsWith("+- A **pod** is a per-run copy")),
    `${a0.bodyText.length} body rows`,
  );
  ok("(a) the AGENTS.md case: no cut row is needed once the store has the rest", a0.cut.length === 0, JSON.stringify(a0.cut));
  const b0 = await page.evaluate(() => window.__probe.diffRows(1));
  note(`(b) rows: ${JSON.stringify(b0.rows)}`);
  check(
    "(b) a modification puts the NEW side in the left cell and the OLD one in the right, on one row",
    b0.rows.filter((r) => r.lpair),
    [
      {
        lpair: "1",
        cells: [
          "df-c is-add +- A **pod** is a per-run copy of that stack — its own postgres, api and web, its own ports.",
          "df-c is-mod - Local PostgreSQL uses the shared `game_db` container on host port 5432.",
        ],
      },
    ],
  );
  check(
    "(b) the context row still spans the window and the row order is unchanged",
    b0.rows.map((r) => r.cells[0].replace(/\s+/g, " ")),
    [
      "df-c is-ctx - Use Node.js 22+ and `npm install`; `npm run dev` starts the Vite client and API.",
      "df-c is-add +- A **pod** is a per-run copy of that stack — its own postgres, api and web, its own ports.",
      "df-c is-ctx - The API applies `server/schema.sql` and the ordered migration set during startup.",
    ],
  );
  ok(
    "(b) a context row is a full-width row: one cell, spanning both columns",
    (await page.evaluate(() => {
      const row = document.querySelectorAll("pre.job-out .call")[1].querySelector(".df-body .df-row");
      return row.children.length === 1 && getComputedStyle(row.children[0]).gridColumn === "1 / -1";
    })),
  );

  // ---- (c) the cut edge, when the store has nothing ------------------------------------------------
  console.log("\n== (c) a hunk the preview cut ==");
  await show({ stored: false });
  const c0 = await page.evaluate(() => window.__probe.diffRows(0));
  note(`(c) at the cut edge: ${JSON.stringify(c0.cut)}`);
  check(
    "(c) the cut is a row INSIDE the frame, at the edge the preview stopped at",
    c0.cut.length,
    1,
  );
  ok("(c) it keeps the gateway's own sentence and names the cause", c0.cut[0].includes("truncated by the gateway") && c0.cut[0].includes("the gateway's live preview stops mid-hunk"));
  ok("(c) it says where the rest can be read", c0.cut[0].includes("stored output (open its own row)") && c0.cut[0].includes("worker's report file"));
  ok(
    "(c) it is drawn under the hunk's own lines, not instead of them",
    c0.bodyText[0].startsWith(" - Identity in this repo's coordination") && c0.bodyText[c0.bodyText.length - 1].startsWith("… result truncated by the gateway"),
    JSON.stringify(c0.bodyText.map((t) => t.slice(0, 24))),
  );
  ok("(c) the cut row is inside the frame, never a line printed after it", (await page.evaluate(() => window.__probe.looseCut())) === 0, `${await page.evaluate(() => window.__probe.looseCut())} cut row(s) outside a .df-win`);

  // ---- every result is one folded box, with the frame inside it ---------------------------------
  console.log("\n== the box around the frame ==");
  await show({});
  const boxed = await page.evaluate(() =>
    [...document.querySelectorAll("pre.job-out .call")].map((c) => ({
      boxes: c.querySelectorAll(".code-box").length,
      shut: [...c.querySelectorAll(".code-box")].every((b) => b.querySelector(".code-body").hidden),
      framesInside: c.querySelectorAll(".code-box .df-win").length,
      framesOutside: [...c.querySelectorAll(".df-win")].filter((w) => !w.closest(".code-box")).length,
      shown: [...c.querySelectorAll(".df-win")].some((w) => w.getBoundingClientRect().height > 0),
      head: c.querySelector(".code-head")?.textContent || "",
    })),
  );
  check("each patch result is one box", boxed.map((b) => b.boxes), [1, 1]);
  ok("and it starts folded, so no frame is on screen until the reader opens it", boxed.every((b) => b.shut && !b.shown), JSON.stringify(boxed.map((b) => [b.shut, b.shown])));
  ok("every frame is inside its box, none outside", boxed.every((b) => b.framesInside >= 1 && b.framesOutside === 0), JSON.stringify(boxed.map((b) => [b.framesInside, b.framesOutside])));
  ok("the header of a folded diff says what it changes", boxed.every((b) => /\+\d+/.test(b.head) && /−\d+/.test(b.head)), JSON.stringify(boxed.map((b) => b.head)));
  await show({ openBoxes: true });
  ok("a click on a box's head shows the frame", (await page.evaluate(() => [...document.querySelectorAll("pre.job-out .df-win")].every((w) => w.getBoundingClientRect().height > 0))));

  // ---- (d) the fold ------------------------------------------------------------------------------
  console.log("\n== (d) a click on a tool call's own row ==");
  const before = await calls();
  ok("(d) default expanded: the call's output is shown and aria-expanded is true", before[0].hidden === false && before[0].expanded === "true" && before[0].caret === "▾");
  ok("(d) the head states the line count while it is expanded", /^\d+ lines$/.test(before[0].summary), before[0].summary);
  const cardBefore = await page.evaluate(() => window.__probe.cardText());
  const copyBefore = await page.evaluate(() => window.__probe.consoleCopy());
  ok(
    "(d) what the block copies is what it shows: the call's own indented result line is in the copy with its indentation",
    copyBefore.includes("  ↳ patch · 79.51s") && copyBefore.includes("+## Per-run docker pods") && copyBefore.includes(FIRST_TEXT) && copyBefore.includes(LAST_TEXT),
    JSON.stringify(copyBefore.slice(0, 80)),
  );
  const rowBox = await pointOver(callLocator(0), "pre.job-out .call");
  ok("(d) the call's own row is where the pointer can reach it", Boolean(rowBox), JSON.stringify(rowBox));
  await page.mouse.click(rowBox.x, rowBox.y);
  await sleep(120);
  const afterClick = await calls();
  check(
    "(d) a real click on the call's row folds that call and only that call",
    afterClick.map((c) => ({ folded: c.folded, hidden: c.hidden, expanded: c.expanded })),
    [
      { folded: true, hidden: true, expanded: "false" },
      { folded: false, hidden: false, expanded: "true" },
    ],
  );
  check("(d) folded: one line, the call's own text, and the line count", [afterClick[0].head, afterClick[0].summary, afterClick[0].hintShown], [AGENTS_CALL, before[0].summary, true]);
  ok("(d) folded: the head is still one line tall", afterClick[0].headHeight <= afterClick[0].lineHeight * 1.6, `${afterClick[0].headHeight}px vs a ${afterClick[0].lineHeight}px line`);
  ok("(d) folded: the caret turns and the summary keeps the count", afterClick[0].caret === "▸" && afterClick[0].summary === before[0].summary);
  const cardAfter = await page.evaluate(() => window.__probe.cardText());
  ok(
    "(d) the rest of the card is untouched: the text lines and the other call's output are still there",
    cardAfter.includes(FIRST_TEXT) && cardAfter.includes(LAST_TEXT) && cardAfter.includes("- Local PostgreSQL uses the shared `game_db` container"),
    `${cardBefore.length} chars before, ${cardAfter.length} after`,
  );
  ok(
    "(d) and only the folded call's own output left the card",
    cardBefore.includes("+## Per-run docker pods") && !cardAfter.includes("+## Per-run docker pods"),
  );
  const copyFolded = await page.evaluate(() => window.__probe.consoleCopy());
  ok(
    "(d) and after the fold, the folded call's output is not in the copy, while the rest still is",
    !copyFolded.includes("+## Per-run docker pods") && copyFolded.includes(FIRST_TEXT) && copyFolded.includes(LAST_TEXT) && copyFolded.includes("- Local PostgreSQL uses the shared"),
    JSON.stringify(copyFolded.slice(0, 80)),
  );
  ok("(d) the other call's output is still there", (await page.evaluate(() => window.__probe.diffRows(1))).rows.length === 3);

  // a repaint
  await page.evaluate(() => window.__probe.repaint());
  await sleep(120);
  const afterRepaint = await calls();
  check(
    "(d) a repaint keeps the fold: the same call is still folded and the other is still open",
    afterRepaint.map((c) => ({ key: c.key, folded: c.folded, expanded: c.expanded, hidden: c.hidden })),
    [
      { key: afterClick[0].key, folded: true, expanded: "false", hidden: true },
      { key: afterClick[1].key, folded: false, expanded: "true", hidden: false },
    ],
  );
  // a burst rebuild, which re-derives the lines out of the DOM
  await page.evaluate(() => window.__probe.rebuild(0));
  await sleep(150);
  const afterRebuild = await calls();
  check(
    "(d) a burst rebuild keeps the fold too",
    afterRebuild.map((c) => ({ key: c.key, folded: c.folded, expanded: c.expanded })),
    [
      { key: afterClick[0].key, folded: true, expanded: "false" },
      { key: afterClick[1].key, folded: false, expanded: "true" },
    ],
  );
  check(
    "(b) the read-back undoes the swapped pair: the rebuild draws the same change, not two rows",
    (await page.evaluate(() => window.__probe.diffRows(1))).rows.map((r) => r.lpair || "-"),
    ["-", "1", "-"],
  );
  const fromDom = await page.evaluate(() => window.__probe.rebuildFromDom(0));
  // The store-backed lines are the panel's own addition (jl-store) and are deliberately NOT read back - they are
  // re-derived from the store on the next render - so the reading is checked on the second call's own preview
  // lines: the diff had "- Local PostgreSQL…" BEFORE "+- A **pod**…", while the markup holds the pair the other
  // way round. Reading it back in the diff's own order is what keeps a rebuild from redrawing the change.
  ok(
    "(b) reading the burst back out of the DOM restores the diff's own order",
    fromDom.indexOf("- Local PostgreSQL uses the shared `game_db` container on host port 5432.") >= 0 &&
      fromDom.indexOf("- Local PostgreSQL uses the shared `game_db` container on host port 5432.") <
        fromDom.indexOf("+- A **pod** is a per-run copy of that stack — its own postgres, api and web, its own ports."),
    JSON.stringify(fromDom.slice(-6).map((t) => t.slice(0, 34))),
  );

  // keyboard
  console.log("\n== (d) the keyboard, and what the fold must not fight ==");
  ok("(d) Tab reaches the fold button", await page.evaluate(() => window.__probe.tabToFold(0)));
  await page.keyboard.press("Enter");
  await sleep(100);
  ok("(d) Enter unfolds the folded call", (await calls())[0].expanded === "true" && (await calls())[0].hidden === false);
  await page.keyboard.press("Space");
  await sleep(100);
  ok("(d) Space folds it again", (await calls())[0].expanded === "false" && (await calls())[0].hidden === true);
  await page.keyboard.press("Enter");
  await sleep(100);
  ok("(d) and it is unfolded again, ready for the rest of the checks", (await calls())[0].hidden === false);

  // a drag-select across the call's own text is a selection, not a fold
  const textBox = await boxOf(callLocator(0, ".call-head > .jl"));
  const selStart = textBox && { x: textBox.x + 8, y: textBox.y + textBox.height / 2 };
  const selEnd = textBox && { x: textBox.x + Math.min(textBox.width - 4, 240), y: textBox.y + textBox.height / 2 };
  ok("(d) the call's own text is where the pointer can reach it", Boolean(selStart && selEnd), JSON.stringify([selStart, selEnd]));
  await page.mouse.move(selStart.x, selStart.y);
  await page.mouse.down();
  await page.mouse.move(selEnd.x, selEnd.y, { steps: 8 });
  await page.mouse.up();
  await sleep(120);
  const afterDrag = await page.evaluate(() => ({
    selected: String(document.getSelection()),
    ...window.__probe.selectionIn(0),
    folded: window.__probe.calls()[0].folded,
    hidden: window.__probe.calls()[0].hidden,
  }));
  ok(
    "(d) a drag-select across the call's text selects that call's text and does not fold it",
    afterDrag.inCall === true && afterDrag.selected.length > 0 && afterDrag.folded === false && afterDrag.hidden === false,
    `${JSON.stringify(afterDrag.selected.slice(0, 40))} in the call: ${afterDrag.inCall}; over it: ${afterDrag.atPoint}`,
  );
  await page.evaluate(() => document.getSelection().removeAllRanges());

  // the copy button
  const copyBox = await pointOver(page.locator("pre.job-out .tgrp > .copy-block"), ".copy-block", 4);
  ok("(d) the block still carries its own copy button, beside the call and not inside it", Boolean(copyBox));
  if (copyBox) {
    await page.mouse.move(copyBox.x, copyBox.y);
    await sleep(80);
    await page.mouse.click(copyBox.x, copyBox.y);
    await sleep(150);
    const afterCopy = await page.evaluate(() => ({ folded: window.__probe.calls()[0].folded, hidden: window.__probe.calls()[0].hidden, label: window.__probe.copyButton().textContent }));
    ok("(d) pressing the copy button copies and does not fold", afterCopy.folded === false && afterCopy.hidden === false, `button now reads ${JSON.stringify(afterCopy.label)}`);
  }

  // a second call folds on its own
  const row2 = await pointOver(callLocator(1), "pre.job-out .call");
  ok("(d) the second call's own row is where the pointer can reach it", Boolean(row2), JSON.stringify(row2));
  await page.mouse.click(row2.x, row2.y);
  await sleep(120);
  const two = await calls();
  check(
    "(d) folding the second call leaves the first one as it was",
    two.map((c) => ({ folded: c.folded, hidden: c.hidden })),
    [
      { folded: false, hidden: false },
      { folded: true, hidden: true },
    ],
  );
  ok(
    "(d) the folded second call keeps its own line count",
    /^\d+ lines$/.test(two[1].summary) && two[1].hintShown === true && two[1].summary !== two[0].summary,
    `${two[1].summary} vs the first call's ${two[0].summary}`,
  );

  check("no page errors anywhere in this run", pageErrors, []);
  await page.close();
  await context.close();
}

// ---- what can only be read off the source --------------------------------------------------------
function sourceChecks() {
  const app = readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const css = readFileSync(path.join(ROOT, "public", "style.css"), "utf8");
  const mod = readFileSync(path.join(ROOT, "public", "core", "console-format.js"), "utf8");
  ok(
    "the fold is one delegated handler on the console, not one per call",
    (app.match(/closest\("\[data-call-fold\], \.call-head"\)/g) || []).length === 1 &&
      (app.match(/callBlockHtml = \(/g) || []).length === 1 &&
      (app.match(/callBlockHtml\(seg\.lines\[0\]/g) || []).length === 1,
    `${(app.match(/closest\("\[data-call-fold\], \.call-head"\)/g) || []).length} handler(s), ${(app.match(/callBlockHtml\(seg\.lines\[0\]/g) || []).length} call site(s)`,
  );
  ok("the folded state is remembered in one place, beside the code box's own set", /callFolded: new Set\(\)/.test(app) && /state\.callFolded\.has\(key\)/.test(app));
  ok("the module draws the swapped pair and marks it for the read-back", /data-lpair="1"/.test(mod) && /row\.dataset\.lpair === "1"/.test(app));
  ok("the module's own doc comment states the new side is the left one", /the LEFT holds the after \(new\) lines/.test(mod) && !/the left holds the before lines/.test(mod));
  ok("the cut row's words live in the module, with the frame's own CSS", /CF_CUT_HINT/.test(mod) && /\.df-cut-hint/.test(css));
  ok("the two file-header chips are the frame's chrome (a tail, not a second full path)", /text\.slice\(0, 3\)/.test(mod) && /\.df-head \{[\s\S]*?flex-wrap: wrap/.test(css));
}

async function main() {
  console.log("console boxes: the frame's body, the swapped sides, the cut edge, and a per-call fold");
  if (!LIVE) {
    const port = await startSandbox();
    note(`temp root ${dir}`);
    note(`panel ${base} (this checkout's own server.js and public/)`);
    note(`nothing here reaches a gateway: apiServer is pinned at http://127.0.0.1:9 and the page's writes are stubbed`);
    note(`port ${port} — the live board on 7331 is not touched`);
    check("the sandbox panel is the one that answered", (await fetch(`${base}/api/state`)).ok, true);
  }

  console.log("\n== what can only be read off the source ==");
  sourceChecks();

  console.log("\n== the browser: a real card, a real click, a real rebuild ==");
  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN  the client half of this change was not exercised in a browser.");
    note("re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-console-boxes.mjs");
    failures += 1;
  } else {
    await browserPhase(pw);
  }

  console.log("\n== summary ==");
  console.log(`${checks} checks, ${failures} failed`);
  console.log("\nWHAT WAS DRIVEN: a panel of this checkout on a spare port plus headless Chromium over it, on a card");
  console.log("fabricated in the page's own state and painted by the shipped renderJobs(), so every box under test is a");
  console.log("real render of real rows (the docker-pods worker's own AGENTS.md preview out of logs/jobs.json); real");
  console.log("clicks on a call's own row, real Tab/Enter/Space, a real drag-select across its text, a real press on the");
  console.log("copy button, a repaint (renderJobs again) and a burst rebuild (rebuildToolGroup over the live node, which");
  console.log("re-derives the diff out of the DOM and is what the swapped pair's read-back has to survive).");
  console.log("WHAT WAS INSPECTED, NOT DRIVEN: that the fold is one delegated handler and one attribute, that the folded");
  console.log("state lives beside the code box's own set, and that the cut row's words and the swapped pair's marker are");
  console.log("in public/core/console-format.js with their CSS in public/style.css.");
  if (!failures) console.log("CONSOLE-BOXES-OK");
}

main()
  .catch((err) => {
    failures += 1;
    console.log(`\nFAIL  the run threw: ${String((err && err.stack) || err)}`);
    if (panelLog.length) console.log(`--- panel log (tail)\n${panelLog.slice(-25).join("\n")}`);
  })
  .finally(async () => {
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
    process.exitCode = failures ? 1 : 0;
  });
