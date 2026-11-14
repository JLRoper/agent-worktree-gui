#!/usr/bin/env node
// tools/verify-spawn-todo-bullets.mjs - a SPAWN's TODOs drawn as its own card's bullets, in a real browser.
//
// THE CHANGE. A reply's TODOs are written under the SPAWN that names the tree they belong to. They used to be drawn
// as five cards of their own under the SPAWN card; they are now bullet rows INSIDE that card, each reading
// `<category> - <todo>` (the category being the TODO's leading `[Title]`), with the checkbox glyph, and the card's
// head counting them. The bullets sit between the head and the body, so folding the card to two lines never hides
// them. A TODO with no SPAWN above it keeps the card it always had. DISPLAY ONLY: lib/assistant/actions.js parses
// the line byte for byte as before, and lib/todos.js is untouched.
//
// WHAT IS DRIVEN - two real panels, side by side, on this one seed:
//
//   BEFORE  port 7340  a `git archive` of main (never a second worktree), its own config, its own store
//   AFTER   port 7341  this checkout, its own config, its own store - the service left standing for the reader
//
// Both are seeded with the SAME message: assistant-1's #398 message - the reply that starts "Row #398 filed and a
// worker started" and ends with `SPAWN IN #398 ...` followed by five `TODO [<category>] ...` lines. That message is
// the fixture (test/fixtures/assistant-398-message.txt); the one machine path in it was replaced with `<projects>`,
// because a commit may not name a folder on the machine that wrote it.
//
// The assistant is attached as the side panel (localStorage `wm.assistantOpen`), the Messages tab is the pane, and
// the message is expanded past its 320-character clamp, so the cards at its end are on the page. Chromium is
// headless at 1440x900 - the viewport the reader asked for.
//
// WHAT IT ASSERTS, off the painted DOM:
//   BEFORE  six cards in the message - one SPAWN, then five TODO cards - and no bullet row anywhere;
//   AFTER   one card: the SPAWN, with five bullets, no TODO card, the head reading `5 todos`, and each bullet
//           reading category - item with the checkbox glyph; the bullets are between the head and the body and
//           none is inside the clamped body;
//   the fold still works: a press opens the card (aria-expanded true, the whole payload on the page, the bullets
//           still there), a second press folds it back to two lines;
//   the store the page read is byte-for-byte unchanged by any of it (the drawing is a reading, not a write).
//
//   node tools/verify-spawn-todo-bullets.mjs                        # both services, shots, the report
//   node tools/verify-spawn-todo-bullets.mjs --port 7341           # pin the AFTER port
//   node tools/verify-spawn-todo-bullets.mjs --stop-after          # take the AFTER service down when done
//   node tools/verify-spawn-todo-bullets.mjs --shots <dir> --report <file> --json <file>
//
// Exit codes: 0 held; 1 a check failed; 2 the run did not measure what it claims (no Playwright, no card, no
// message on the page).
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright, notRun, withBrowser } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TREE = path.resolve(HERE, "..");
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const flag = (n) => argv.includes(n);

const AFTER_PORT = Number(opt("--port", 7341));
const BEFORE_PORT = Number(opt("--before-port", 7340));
const MAIN = String(opt("--main", "main"));
const SCRATCH = path.resolve(opt("--scratch", path.join(os.tmpdir(), "wtgui-spawn-todo-bullets")));
const SHOTS = path.resolve(opt("--shots", path.join(SCRATCH, "shots")));
// The report is named by the READER's day, not UTC's: an evening run here is already tomorrow in UTC, and a file
// called tomorrow that was written today is a small lie in every link to it.
const stamp = (() => {
  const d = new Date();
  const two = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
})();
const REPORT = path.resolve(opt("--report", path.join(TREE, "docs", "reports", `spawn-todo-bullets-${stamp}.html`)));
const JSON_OUT = opt("--json");
const STOP_AFTER = flag("--stop-after");

// The message the reader asked about: assistant-1's #398 reply. Read from the fixture, so the seed and the report
// quote the same text.
const MESSAGE = readFileSync(path.join(TREE, "test", "fixtures", "assistant-398-message.txt"), "utf8").replace(/\r\n/g, "\n").trimEnd();
const MSG_ID = "job:22a4a10e:in";
const MSG_SEL = `.as-msg[data-msg="${MSG_ID}"]`;
const SPAWN_LINE = MESSAGE.split("\n").find((line) => /^SPAWN\b/.test(line)) || "";
const TODO_LINES = MESSAGE.split("\n").filter((line) => /^TODO\b/.test(line));
const CATEGORIES = TODO_LINES.map((line) => {
  const m = /^TODO\s+(?:ADD\s+)?\[([^\]]+)\]\s*([\s\S]*)$/.exec(line);
  return m ? `${m[1]} - ${m[2]}` : line.replace(/^TODO\s+(?:ADD\s+)?/, "");
});

let checks = 0;
let failures = 0;
const out = { tree: TREE, before: null, after: null, steps: [], notMeasured: [], checks: [] };
function check(ok, label, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  out.checks.push({ ok: Boolean(ok), label, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
}
const note = (text) => console.log(`      ${text}`);
const tail = (file, n = 1200) => {
  try {
    const text = readFileSync(file, "utf8");
    return text.slice(Math.max(0, text.length - n));
  } catch {
    return "(no log)";
  }
};

// ---- the two panels ----------------------------------------------------------------------------------
// One store, seeded with the same message, written before the panel boots: the message board is a VIEW over the job
// store, so a single settled job is all it takes for the pane to draw one entry.
function seedStore(dir) {
  const logs = path.join(dir, "logs");
  mkdirSync(logs, { recursive: true });
  const now = Date.now();
  const at = now - 60 * 60 * 1000;
  const fixtureTree = path.join(dir, "fixture-tree").replace(/\\/g, "/");
  const job = {
    id: "22a4a10e",
    thread: "panel-assistant",
    turn: 1,
    prompt: "fixture: assistant-1's #398 message",
    status: "done",
    exitCode: 0,
    startedAt: new Date(at).toISOString(),
    endedAt: new Date(at + 90_000).toISOString(),
    durationMs: 90_000,
    finalMessage: MESSAGE,
    cwd: fixtureTree,
    ownerPath: fixtureTree,
    worktreePath: fixtureTree,
    worktree: "spawn-todo-bullets-fixture",
    lines: [{ kind: "text", text: MESSAGE, lid: 1, at: at + 1000 }],
  };
  const file = path.join(logs, "jobs.json");
  writeFileSync(file, JSON.stringify({ savedAt: new Date(now).toISOString(), jobs: [job] }, null, 1));
  return file;
}

function writeConfig(dir, port) {
  const cfgPath = path.join(dir, "config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify(
      {
        port,
        host: "127.0.0.1",
        scanRoots: [path.join(dir, "repos")],
        projects: [],
        threads: 1,
        worktreeSeconds: 3600,
        midSeconds: 3600,
        dormantSeconds: 3600,
        slowSeconds: 3600,
        refreshSeconds: 3600,
        fetchSeconds: -1,
        discoverSeconds: 3600,
        jobsFile: path.join(dir, "logs", "jobs.json"),
        assistantFile: path.join(dir, "logs", "assistant.json"),
        projectsCacheFile: path.join(dir, "logs", "projects.json"),
        // No gateway: a dead apiServer and the assistant's own rules off, so nothing here can start a run.
        assistant: { enabled: false },
        apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
      },
      null,
      2,
    ),
  );
  return cfgPath;
}

// Boot one panel against one checkout. `detached` is what lets the AFTER service outlive this run: a child on
// inherited pipes dies with its parent's read end, so the log goes to a file and the process group is its own.
async function bootPanel({ root, dir, port, label, detached = false }) {
  mkdirSync(path.join(dir, "repos"), { recursive: true });
  const cfgPath = writeConfig(dir, port);
  const logPath = path.join(dir, "server.log");
  const fd = openSync(logPath, "a");
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      PANEL_CONFIG: cfgPath,
      HERMES_HOME: path.join(dir, "hermes"),
      CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_ASKPASS: "echo",
      API_SERVER_KEY: "",
    },
    stdio: ["ignore", fd, fd],
    windowsHide: true,
    detached,
  });
  child.unref?.();
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`${label} on ${port} did not answer /api/health within 30s\n${tail(logPath)}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  return {
    label,
    root,
    dir,
    port,
    base,
    pid: child.pid,
    logPath,
    store: path.join(dir, "logs", "jobs.json"),
    cfgPath,
    stop() {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    },
  };
}

// Is something already answering on a port (a service an earlier run left standing)? Refused rather than fought
// over: the port is the brief's, and a second panel on it could only fail with EADDRINUSE.
async function liveOn(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

// Who holds a listening port, so the refusal can name the command that frees it (netstat is the one reader that
// answers without a shell, and it is on every Windows box this panel runs on).
function portOwnerPid(port) {
  try {
    const text = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of text.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length >= 5 && cols[1].endsWith(`:${port}`) && cols[3] === "LISTENING") return cols[4];
    }
  } catch {
    /* netstat is a courtesy, not a requirement */
  }
  return "<pid>";
}

// Main, unpacked with `git archive` - never a second worktree (one would have to be cleaned up, and the point of
// the BEFORE half is that it is the same tree this branch was cut from).
function archiveRef(ref, into) {
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  const tar = path.join(SCRATCH, `archive-${ref.replace(/[^a-z0-9]+/gi, "-")}.tar`);
  // Forward slashes for tar: a backslashed drive path is read as a remote host by the GNU tar this shell ships.
  const posix = (p) => p.replace(/\\/g, "/");
  execFileSync("git", ["-C", TREE, "archive", "--format=tar", ref, "-o", tar], { stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("tar", ["-x", "--force-local", "-f", posix(tar), "-C", posix(into)], { stdio: ["ignore", "pipe", "pipe"] });
  rmSync(tar, { force: true });
  return into;
}

// ---- what the page says ------------------------------------------------------------------------------
// One message entry, read off the painted DOM: every card, its head, its count, its fold, and the bullet rows it
// carries. Nothing here asks the module; this is what a reader's eye gets.
const readMessage = (id) => {
  const msg = document.querySelector(`.as-msg[data-msg="${id}"]`);
  if (!msg) return null;
  const cards = [...msg.querySelectorAll(".code-box")].map((box) => {
    const head = box.querySelector(".code-head");
    const body = box.querySelector(".code-body");
    const n = head ? head.querySelector(".code-n") : null;
    return {
      ltext: box.getAttribute("data-ltext"),
      what: head && head.querySelector(".code-what") ? String(head.querySelector(".code-what").textContent || "").trim() : "",
      count: n ? String(n.textContent || "").trim() : "",
      countShown: n ? getComputedStyle(n).display !== "none" : false,
      key: head ? head.getAttribute("data-code-key") : null,
      aria: head ? head.getAttribute("aria-expanded") : null,
      clamp: box.getAttribute("data-code-clamp"),
      clamped: box.classList.contains("is-clamped"),
      open: box.classList.contains("is-open"),
      bodyH: body ? Math.round(body.getBoundingClientRect().height) : null,
      bodyScroll: body ? Math.round(body.scrollHeight) : null,
      lineH: body ? Math.round(parseFloat(getComputedStyle(body).lineHeight) || 0) : null,
      boxH: Math.round(box.getBoundingClientRect().height),
      bullets: [...box.querySelectorAll(".code-bullet")].map((b) => ({
        text: b.querySelector(".code-bullet-text") ? String(b.querySelector(".code-bullet-text").textContent || "").trim() : "",
        glyph: b.querySelector(".code-bullet-glyph") ? String(b.querySelector(".code-bullet-glyph").textContent || "").trim() : "",
        title: b.getAttribute("title"),
        inBody: Boolean(body && body.contains(b)),
      })),
    };
  });
  return { cards, expanded: Boolean(msg.querySelector(".as-msg-more[aria-expanded=\"true\"]")), text: String(msg.querySelector(".as-msg-text") ? msg.querySelector(".as-msg-text").innerText || "" : "").slice(0, 80) };
};

// The region a shot of the card(s) should cover: from the first card's top through the fourth, capped to the
// reader's viewport, in PAGE coordinates (the page is scrolled so the message is on screen first).
const cardRegion = (id) => {
  const msg = document.querySelector(`.as-msg[data-msg="${id}"]`);
  if (!msg) return null;
  const boxes = [...msg.querySelectorAll(".code-box")];
  if (!boxes.length) return null;
  // The rail is a scroller of its own: the cards below its fold are not on the page a reader is looking at, so the
  // region is clipped to what the rail actually shows - a shot is evidence only for pixels that were on screen.
  const scrollerOf = (el) => {
    let p = el.parentElement;
    while (p && p !== document.body && p !== document.documentElement) {
      const s = getComputedStyle(p);
      if (/(auto|scroll)/.test(String(s.overflowY))) return p;
      p = p.parentElement;
    }
    return null;
  };
  const rail = scrollerOf(boxes[0]);
  const railRect = rail ? rail.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
  const first = boxes[0].getBoundingClientRect();
  const last = boxes[boxes.length - 1].getBoundingClientRect();
  const top = Math.max(railRect.top, first.top);
  const bottom = Math.min(railRect.bottom, last.bottom) + 10;
  const x = Math.max(0, Math.round(first.left - 14));
  const y = Math.max(0, Math.round(top + window.scrollY));
  const width = Math.min(window.innerWidth - x, Math.round(Math.max(first.width, last.width) + 28));
  const height = Math.max(80, Math.min(1200, Math.round(bottom - top)));
  return {
    clip: { x, y, width, height },
    meta: {
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      dpr: window.devicePixelRatio,
      scrollY: Math.round(window.scrollY),
      rail: { top: Math.round(railRect.top), bottom: Math.round(railRect.bottom), scrollTop: rail ? Math.round(rail.scrollTop) : 0 },
      first: { left: Math.round(first.left), top: Math.round(first.top), w: Math.round(first.width), h: Math.round(first.height) },
      last: { bottom: Math.round(last.bottom), h: Math.round(last.height) },
      boxes: boxes.length,
    },
  };
};

// Put the message's first card at the top of the rail: the read below is then about the whole run of cards, not the
// slice that happened to be in view when the pane was opened.
const scrollCardTop = (id) => {
  const msg = document.querySelector(`.as-msg[data-msg="${id}"]`);
  const box = msg ? msg.querySelector(".code-box") : null;
  if (box) box.scrollIntoView({ block: "start", behavior: "instant" });
  return Boolean(box);
};

// The Messages pane, with the assistant attached as the side panel and the #398 message expanded past its clamp.
async function openMessages(page, base) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("wm.assistantOpen", "1");
    } catch {
      /* a browser with storage off still draws the rail on its own default */
    }
  });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#assistant", { timeout: 45_000 });
  await page.waitForSelector('#as-subtabs [data-as-subtab="messages"]', { timeout: 45_000 });
  await page.locator('#as-subtabs [data-as-subtab="messages"]').click();
  await page.waitForSelector(MSG_SEL, { timeout: 45_000 });
  const more = page.locator(`${MSG_SEL} [data-as-msg-more="${MSG_ID}"]`);
  if (await more.count()) {
    await more.click();
    await page.waitForTimeout(300);
  }
  await page.waitForSelector(`${MSG_SEL} .code-box`, { timeout: 30_000 });
  await page.waitForTimeout(400);
}

// ---- the run -----------------------------------------------------------------------------------------
const playwright = loadPlaywright({ root: TREE });
if (!playwright) {
  console.log(notRun("a SPAWN's TODOs as its card's bullets", "Playwright is not installed here (set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright)"));
  process.exit(2);
}

const runs = [];
let before = null;
let after = null;
try {
  mkdirSync(SHOTS, { recursive: true });
  console.log(`a SPAWN's TODOs, as its card's bullets - ${TREE}`);
  console.log(`  message: ${MSG_ID} · ${TODO_LINES.length} TODOs under one SPAWN · viewport 1440x900`);

  // BEFORE: main, through a git archive. Booted fresh, always, and taken down at the end. The store is seeded
  // before the boot, because a panel that boots onto no store writes an empty one over anything that arrives after.
  const beforeRoot = archiveRef(MAIN, path.join(SCRATCH, "before-root"));
  const beforeDir = path.join(SCRATCH, "before-state");
  rmSync(beforeDir, { recursive: true, force: true });
  seedStore(beforeDir);
  before = await bootPanel({ root: beforeRoot, dir: beforeDir, port: BEFORE_PORT, label: "BEFORE (main)", detached: false });
  console.log(`  BEFORE ${before.base} (main, git archive at ${beforeRoot})`);

  // AFTER: this checkout, its own store, left standing for the reader unless --stop-after. A service an earlier run
  // left on the port is not adopted: it holds the store it read at boot, so a fresh seed under it would be a lie.
  const afterDir = path.join(SCRATCH, "after-state");
  if (await liveOn(AFTER_PORT)) {
    const stop = `node -e "process.kill(Number(process.argv[1]))" -- ${await portOwnerPid(AFTER_PORT)}`;
    out.notMeasured.push(`port ${AFTER_PORT} already has a service on it - stop it first: ${stop}`);
    throw new Error(`port ${AFTER_PORT} already has a service on it. Stop it and run again:\n  ${stop}`);
  }
  rmSync(afterDir, { recursive: true, force: true });
  seedStore(afterDir);
  after = await bootPanel({ root: TREE, dir: afterDir, port: AFTER_PORT, label: "AFTER (this branch)", detached: true });
  console.log(`  AFTER  ${after.base} (this branch, pid ${after.pid})`);
  out.before = { base: before.base, root: beforeRoot, port: BEFORE_PORT, pid: before.pid };
  out.after = { base: after.base, root: TREE, port: AFTER_PORT, pid: after.pid, kept: !STOP_AFTER };

  await withBrowser(
    async ({ page, pageErrors }) => {
      // ---- BEFORE ------------------------------------------------------------------------------------
      await openMessages(page, before.base);
      const beforeRead = await page.evaluate(readMessage, MSG_ID);
      out.before.dom = beforeRead;
      out.steps.push({ step: "before", ...(beforeRead || {}) });
      if (!beforeRead) {
        out.notMeasured.push("the #398 message was not on the BEFORE page");
        console.log("NOT MEASURED  the #398 message was not on the BEFORE page");
        return;
      }
      check(beforeRead.cards.length === 6, "BEFORE: the message draws six cards - the SPAWN and five TODOs", `${beforeRead.cards.length} cards`);
      check(beforeRead.cards.every((c) => c.bullets.length === 0), "BEFORE: no card carries a bullet row", JSON.stringify(beforeRead.cards.map((c) => c.bullets.length)));
      check(
        beforeRead.cards.filter((c) => c.what.startsWith(String.fromCodePoint(0x2611))).length === 5,
        "BEFORE: each TODO is a card of its own, with the checkbox glyph",
        String(beforeRead.cards.filter((c) => c.what.startsWith(String.fromCodePoint(0x2611))).length),
      );
      check(
        Boolean(beforeRead.cards[0]) && beforeRead.cards[0].what.startsWith(String.fromCodePoint(0x1f331)),
        "BEFORE: the first card is the SPAWN",
        beforeRead.cards[0] ? beforeRead.cards[0].what.slice(0, 60) : "(none)",
      );
      await page.evaluate(scrollCardTop, MSG_ID);
      await page.waitForTimeout(350);
      const beforeRegion = await page.evaluate(cardRegion, MSG_ID);
      out.before.region = beforeRegion && beforeRegion.meta;
      const beforeShot = path.join(SHOTS, "01-before-main.png");
      // fullPage WITH a clip: Playwright reads a clip on a plain shot as viewport-relative, and this page is scrolled,
      // so a plain clip lands lower than the cards it was measured from. Page coordinates plus the rail-clipped
      // region are what the reader sees, and nothing else.
      await page.screenshot({ path: beforeShot, fullPage: true, clip: beforeRegion.clip });
      note(`screenshot ${beforeShot} (${beforeRegion.clip.width}x${beforeRegion.clip.height} of a ${beforeRegion.meta.viewport} page, rail ${beforeRegion.meta.rail.top}..${beforeRegion.meta.rail.bottom})`);
      out.before.shot = beforeShot;

      // ---- AFTER -------------------------------------------------------------------------------------
      await openMessages(page, after.base);
      const atLoad = createHash("sha256").update(readFileSync(after.store)).digest("hex");
      let afterRead = await page.evaluate(readMessage, MSG_ID);
      out.after.dom = afterRead;
      out.steps.push({ step: "after", ...(afterRead || {}) });
      if (!afterRead) {
        out.notMeasured.push("the #398 message was not on the AFTER page");
        console.log("NOT MEASURED  the #398 message was not on the AFTER page");
        return;
      }
      check(afterRead.cards.length === 1, "AFTER: the message draws ONE card - the SPAWN", `${afterRead.cards.length} cards${afterRead.cards.length > 1 ? `: ${afterRead.cards.map((c) => c.what).join(" / ")}` : ""}`);
      const card = afterRead.cards[0] || { bullets: [] };
      check(card.bullets.length === TODO_LINES.length, `AFTER: it carries all ${TODO_LINES.length} TODOs as bullets`, `${card.bullets.length} bullets`);
      check(
        card.bullets.every((b) => b.glyph === String.fromCodePoint(0x2611, 0xfe0f)),
        "AFTER: each bullet carries the checkbox glyph",
        JSON.stringify([...new Set(card.bullets.map((b) => b.glyph))]),
      );
      check(
        card.bullets.map((b) => b.text).join(" | ") === CATEGORIES.join(" | "),
        "AFTER: each bullet reads <category> - <todo>, the category from the TODO's own bracket",
        card.bullets.map((b) => b.text).join(" | "),
      );
      check(card.count === `${TODO_LINES.length} todos` && card.countShown, "AFTER: the head shows the count", `${card.count}${card.countShown ? "" : " (hidden)"}`);
      check(card.bullets.length === 0 || card.bullets.every((b) => !b.inBody), "AFTER: no bullet is inside the body - the clamp cannot hide them");
      check(card.clamped && card.aria === "false" && card.clamp === "2", "AFTER: the card is folded to two lines, as every command card is", `clamped ${card.clamped} · aria ${card.aria} · clamp ${card.clamp}`);
      check(
        afterRead.cards.filter((c) => c.what.startsWith(String.fromCodePoint(0x2611))).length === 0,
        "AFTER: no TODO card is drawn beside it",
      );
      await page.evaluate(scrollCardTop, MSG_ID);
      await page.waitForTimeout(400);
      const afterRegion = await page.evaluate(cardRegion, MSG_ID);
      out.after.region = afterRegion && afterRegion.meta;
      const afterCard = page.locator(`${MSG_SEL} .code-box`).first();
      const afterShot = path.join(SHOTS, "02-after-folded.png");
      await afterCard.screenshot({ path: afterShot });
      note(`screenshot ${afterShot} (the card itself, ${card.boxH}px tall on a ${afterRegion.meta.viewport} page)`);
      out.after.shot = afterShot;

      // The fold: a real press opens the card, and the bullets are still there.
      await page.locator(`${MSG_SEL} .code-box .code-head`).first().click();
      await page.waitForTimeout(300);
      const opened = await page.evaluate(readMessage, MSG_ID);
      out.steps.push({ step: "after-open", ...(opened || {}) });
      const openCard = opened ? opened.cards[0] : null;
      check(Boolean(openCard) && openCard.aria === "true" && openCard.open && !openCard.clamped, "a press opens the card", openCard ? `aria ${openCard.aria} · clamped ${openCard.clamped}` : "(missing)");
      check(Boolean(openCard) && openCard.bullets.length === TODO_LINES.length, "the bullets stay on the card when it is open", openCard ? `${openCard.bullets.length}` : "(missing)");
      check(Boolean(openCard) && openCard.bodyScroll > 0 && openCard.bodyH >= openCard.bodyScroll - 2, "and the whole payload is on the page", openCard ? `${openCard.bodyH}px vs ${openCard.bodyScroll}px` : "(missing)");
      await page.waitForTimeout(150);
      const openShot = path.join(SHOTS, "03-after-open.png");
      await afterCard.screenshot({ path: openShot });
      note(`screenshot ${openShot}`);
      out.after.openShot = openShot;
      // ...and a second press folds it back to the same two lines.
      await page.locator(`${MSG_SEL} .code-box .code-head`).first().click();
      await page.waitForTimeout(300);
      const refolded = await page.evaluate(readMessage, MSG_ID);
      out.steps.push({ step: "after-refold", ...(refolded || {}) });
      const folded = refolded ? refolded.cards[0] : null;
      check(
        Boolean(folded) && folded.aria === "false" && folded.clamped && folded.lineH > 0 && folded.bodyH <= folded.lineH * 2 + 2,
        "a second press folds it back to exactly two lines",
        folded ? `${folded.bodyH}px at a ${folded.lineH}px line` : "(missing)",
      );
      check(Boolean(folded) && folded.bullets.length === TODO_LINES.length, "and the bullets are still on the folded card", folded ? `${folded.bullets.length}` : "(missing)");

      // Display only: the store the page read did not move.
      const afterHash = createHash("sha256").update(readFileSync(after.store)).digest("hex");
      check(atLoad === afterHash, "the store the page read is byte-for-byte what it was after the drawing and the presses", `${atLoad.slice(0, 16)} -> ${afterHash.slice(0, 16)}`);
      out.after.store = { atLoad, after: afterHash };
      out.errors = pageErrors;
      check(pageErrors.length === 0, "no page error", pageErrors.slice(0, 2).join(" | "));
      runs.push({ beforeRead, afterRead, opened, refolded });
    },
    { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  );
} catch (e) {
  out.error = String((e && e.stack) || e);
  console.error(`FAIL  the run threw: ${out.error}`);
  failures += 1;
} finally {
  if (before) before.stop();
  if (after && STOP_AFTER) after.stop();
}

// ---- the report ----------------------------------------------------------------------------------------
// One self-contained page: the shots inline as data URIs, no script, no font, no image request - a reader can open
// it from a folder with the network off and see exactly what the run saw.
function dataUri(file) {
  try {
    return `data:image/png;base64,${readFileSync(file).toString("base64")}`;
  } catch {
    return "";
  }
}

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function bulletsTable(read) {
  const card = read && read.cards ? read.cards[0] : null;
  if (!card) return "<tr><td colspan=\"3\">(no card)</td></tr>";
  return card.bullets.map((b) => `<tr><td class="mono">${esc(b.glyph)}</td><td>${esc(b.text)}</td><td class="mono dim">${esc(b.title)}</td></tr>`).join("");
}

function cardsTable(read) {
  const cards = (read && read.cards) || [];
  return cards
    .map((c) => `<tr><td class="mono dim">${esc((c.ltext || "").slice(0, 70))}</td><td>${esc(c.what)}</td><td class="mono">${esc(c.count)}</td><td class="mono">${c.clamped ? "2 lines" : c.open ? "open" : ""}</td><td class="num">${c.bullets.length}</td></tr>`)
    .join("");
}

const commands = [
  "# the worktree this branch was cut in, called $TREE below (the panel row names it)",
  "cd \"$TREE\"",
  "# BEFORE: main, unpacked with git archive - never a second worktree",
  "git -C \"$TREE\" archive --format=tar main -o \"$SCRATCH/before.tar\"",
  "tar -x -f \"$SCRATCH/before.tar\" -C \"$SCRATCH/before-root\"",
  "# both panels: their own config, their own store, no gateway",
  "PANEL_CONFIG=\"$SCRATCH/before-state/config.json\" node \"$SCRATCH/before-root/server.js\"    # port 7340",
  "PANEL_CONFIG=\"$SCRATCH/after-state/config.json\"  node \"$TREE/server.js\"                  # port 7341",
  "# the same run, end to end (what produced the shots below)",
  "node tools/verify-spawn-todo-bullets.mjs --port 7341 --before-port 7340",
  "# the seed both panels were given",
  "test/fixtures/assistant-398-message.txt        # assistant-1's #398 message, one machine path as <projects>",
].join("\n");

const report = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>A SPAWN's TODOs, drawn as its own card's bullets</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 28px 32px 60px; background: #0d1117; color: #d7dee8; font: 15px/1.55 ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
  h1 { font-size: 24px; margin: 0 0 6px; color: #f0f4fa; }
  h2 { font-size: 17px; margin: 34px 0 10px; color: #c9d7ea; border-bottom: 1px solid #232c38; padding-bottom: 6px; }
  p { max-width: 92ch; }
  .lede { color: #9fb0c6; }
  .mono { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 12.5px; }
  .dim { color: #8595a8; }
  .num { text-align: right; font-family: ui-monospace, Consolas, monospace; }
  table { border-collapse: collapse; margin: 8px 0 4px; width: 100%; }
  th, td { text-align: left; padding: 5px 10px; border-bottom: 1px solid #1e2733; vertical-align: top; }
  th { color: #9fb0c6; font-weight: 600; font-size: 12.5px; text-transform: uppercase; letter-spacing: .04em; }
  tr.bad td { background: #3a1d22; }
  pre { background: #111823; border: 1px solid #232c38; border-radius: 6px; padding: 12px 14px; overflow: auto; font: 12.5px/1.6 ui-monospace, Consolas, monospace; color: #cbd6e4; }
  figure { margin: 14px 0 26px; }
  figure img { display: block; width: 100%; max-width: 560px; border: 1px solid #2a3442; border-radius: 6px; background: #0f151d; }
  figcaption { color: #9fb0c6; font-size: 13px; margin-top: 8px; }
  .tag { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 12px; margin-right: 6px; }
  .ok { background: #12301f; color: #7ee787; }
  .no { background: #3a1d22; color: #ff9c94; }
  code { background: #16202c; padding: 1px 5px; border-radius: 4px; }
</style>
</head>
<body>
<h1>A SPAWN's TODOs, drawn as its own card's bullets</h1>
<p class="lede">The reader's page: the panel's Messages pane, assistant attached as the side panel, on <strong>assistant-1's
#398 message</strong> - the reply that starts "Row #398 filed and a worker started" and ends with one
<code>SPAWN IN #398 ...</code> line and five <code>TODO [category] ...</code> lines. Headless Chromium, 1440x900. The
BEFORE page is <code>main</code> (this branch's base, unpacked with <code>git archive</code>); the AFTER page is this
branch. Both are separate test services with their own store; the live panel on 7331 was never touched.</p>

<h2>The page, the services, the URLs</h2>
<table>
  <tr><th>side</th><th>what it served</th><th>URL</th><th>state</th></tr>
  <tr><td>BEFORE</td><td class="mono">main (git archive of ${esc(MAIN)})</td><td class="mono">${esc((out.before && out.before.base) || "http://127.0.0.1:7340")}/</td><td class="mono dim">own store, taken down after the shots</td></tr>
  <tr><td>AFTER</td><td class="mono">this branch's checkout</td><td class="mono">${esc((out.after && out.after.base) || "http://127.0.0.1:7341")}/</td><td class="mono dim">own store${out.after && out.after.kept ? ", left standing" : ""}</td></tr>
</table>
<p class="dim">The live panel at <code>http://127.0.0.1:7331/</code> (pid 54208) was not stopped, restarted, signalled
or read for this run; the reader's live store was not written.</p>

<h2>The exact commands</h2>
<pre>${esc(commands)}</pre>
<p class="dim"><code>$TREE</code> is the worktree this branch was cut in (the panel row names it); <code>$SCRATCH</code> is
the throwaway folder under the OS temp directory.</p>

<h2>BEFORE - five TODO cards of their own</h2>
<figure>
  <img alt="main: the SPAWN card followed by five separate TODO cards" src="${dataUri(out.before && out.before.shot)}">
  <figcaption>main: the SPAWN card, then a card for every TODO - six boxes, no bullets, the SPAWN's payload folded to
  two lines with nothing above it but its head.</figcaption>
</figure>
<table>
  <tr><th>line the card was drawn from</th><th>head</th><th>count</th><th>fold</th><th>bullets</th></tr>
  ${cardsTable(out.before && out.before.dom)}
</table>

<h2>AFTER - the SPAWN's card, with its five bullets</h2>
<figure>
  <img alt="this branch: one SPAWN card with five bullet rows inside it" src="${dataUri(out.after && out.after.shot)}">
  <figcaption>this branch: one card. The head reads <code>5 todos</code>, the five bullet rows sit between the head
  and the body, each reading <code>&lt;category&gt; - &lt;todo&gt;</code> with the checkbox glyph, and no TODO box is
  drawn beside it. The bullet rows are outside the clamped body, so they are all visible on the folded card.</figcaption>
</figure>
<table>
  <tr><th>glyph</th><th>bullet</th><th>the TODO line it was read from</th></tr>
  ${bulletsTable(out.after && out.after.dom)}
</table>

<h2>The fold still works</h2>
<figure>
  <img alt="this branch: the same card opened, the whole payload on the page, the bullets still there" src="${dataUri(out.after && out.after.openShot)}">
  <figcaption>A real press on the head opens the card: <code>aria-expanded</code> flips, the two-line clamp lifts, the
  whole payload is on the page - and the five bullets are still above it. A second press folds it back to two lines.</figcaption>
</figure>

<h2>What the run asserted</h2>
<table>
  <tr><th>result</th><th>check</th><th>what it read</th></tr>
  ${out.checks.map((c) => `<tr class="${c.ok ? "" : "bad"}"><td><span class="tag ${c.ok ? "ok" : "no"}">${c.ok ? "held" : "failed"}</span></td><td>${esc(c.label)}</td><td class="mono dim">${esc(c.detail)}</td></tr>`).join("")}
</table>

<h2>Display only</h2>
<p>The card is a second reading of the same strings. <code>lib/assistant/actions.js</code>'s parser still reads each
TODO with its bracket (<code>[Inventory first] Write the report ...</code>) and <code>lib/todos.js</code> is untouched;
the panel's store was hashed before and after the drawing and the presses (${esc((out.after && out.after.store && out.after.store.atLoad || "").slice(0, 16))} -> ${esc((out.after && out.after.store && out.after.store.after || "").slice(0, 16))}).
The shared action grammar now asks every manager to put each TODO directly under its SPAWN with its short category in
brackets, which is what gives the bullets their categories.</p>
</body>
</html>
`;

try {
  mkdirSync(path.dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, report, "utf8");
  out.report = REPORT;
  console.log(`report ${REPORT}`);
} catch (e) {
  out.error = `the report could not be written: ${String((e && e.message) || e)}`;
  console.error(`FAIL  ${out.error}`);
  failures += 1;
}

if (JSON_OUT) {
  try {
    writeFileSync(path.resolve(JSON_OUT), JSON.stringify(out, null, 1), "utf8");
  } catch {
    /* a ledger that cannot be written is not the run's verdict */
  }
}

if (out.notMeasured.length) {
  console.log(`NOT MEASURED: ${out.notMeasured.join("; ")}`);
  process.exit(2);
}
console.log(`${checks - failures}/${checks} checks held`);
if (out.after && !STOP_AFTER) console.log(`AFTER service standing: ${out.after.base} (pid ${out.after.pid ?? "adopted"})`);
process.exit(failures ? 1 : 0);
