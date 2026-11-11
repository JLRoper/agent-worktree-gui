// One press of Queue reply puts the reply in flight - the card closes behind it.
//
//   node tools/verify-queue-single-press.mjs                      # this checkout, one sandbox panel
//   node tools/verify-queue-single-press.mjs --root <dir>         # a `git archive` of another build (RED PROOF)
//   node tools/verify-queue-single-press.mjs --shots <dir>        # where the card captures are written
//   PANEL_URL=http://127.0.0.1:7331 node tools/verify-queue-single-press.mjs   # a panel already running
//
// THE DEFECT. `queueReplyFromBox` read the box, cleared it and called `queueReply` with no guard: the card came
// back with an open, empty box and a live Queue reply button beside one held reply. The box took the same text
// again, and the next press held it a second time - two identical ghost turns, both of which the drain would
// send. A press is a gesture with one answer, so the card has to say "that is in flight" instead of inviting
// another one.
//
// THE CLAIM, driven against a real card drawn by the shipped renderer:
//   (1) ONE press holds exactly one reply;
//   (2) while it is held the Queue reply button is disabled and the box is read-only (contenteditable="false",
//       aria-readonly), so a second press - the real mouse, or a click event dispatched straight at the disabled
//       button - holds nothing, and the keyboard cannot put a character in the box;
//   (3) the card says "queued, waiting" while it holds the reply;
//   (4) once the held reply is drawn (the drain takes it out and sends it), the box is editable again and the note
//       is gone;
//   (5) Enter is the same press: one entry, and the same closed face - one function, so the two cannot drift.
//
// RED PROOF. Everything is asserted through a panel booted from `--root`, so the same file run against a
// `git archive 71c2d169` export fails at (2)(3)(5): that build answers with an open box, a live button and no
// queued state, and the retyped text makes a second held entry. The export has no tools/verify-queue-single-press.mjs
// of its own; run THIS file with --root pointing at it. The captures it writes are the before/after pair.
//
// The card is the shipped one: a running turn is fabricated in the PAGE's state.jobs and rendered by the page's
// own renderJobs, so the markup, the CSS and the handlers are the real build's. The page's fetch is stubbed (a
// send is recorded, never sent) and EventSource is replaced, so a broadcast cannot wipe the probe's card.
//
// The browser half needs a Playwright install (PANEL_PLAYWRIGHT_ROOT or a checkout that has one). Without it the
// script prints BROWSER-HALF-NOT-RUN and exits 2 rather than passing on a half that never ran.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installFakeEventSource, loadPlaywright } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const SHOTS = path.resolve(opt("--shots", path.join(tmpdir(), "wtgui-queue-single-press")));
const LIVE = String(process.env.PANEL_URL || "").replace(/\/+$/, "");
const THREAD = "wtgui-probe-queue-single-press-71c2d1";
const TEXT = "the same reply, pressed twice";

let checks = 0;
let failures = 0;
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` - ${extra}` : ""}`);
  }
};
const check = (name, got, want) => {
  checks += 1;
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) failures += 1;
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${name}${pass ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`,
  );
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
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

// ---- the sandbox panel (skipped entirely when PANEL_URL names a running one) ----------------------
let dir = null;
let panel = null;
let base = LIVE;
const panelLog = [];

async function startSandbox() {
  dir = mkdtempSync(path.join(tmpdir(), "wtgui-queue-single-press-"));
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
        // Nothing this script drives may reach a gateway: the page's fetch is stubbed for the writes, and this is
        // the belt to that brace - a probe that resolved a name would buy a real worker.
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
    cwd: TREE,
    env: { ...process.env, PANEL_CONFIG: configPath, HERMES_HOME: home, PANEL_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  panel.stdout.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  panel.stderr.on("data", (d) => panelLog.push(...String(d).split(/\r?\n/).filter(Boolean)));
  const up = await waitFor(async () => (await fetch(`${base}/api/state`)).ok, { what: "the sandbox panel to answer /api/state" });
  if (!up) throw new Error(`the sandbox panel never came up on ${base}\n${panelLog.slice(-15).join("\n")}`);
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
  if (dir) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may hold a folder; the scratch sweep takes it later */
    }
  }
}

const cardSel = `.job[data-thread="${THREAD}"]`;
const boxSel = `${cardSel} .reply-box`;
const queueBtnSel = `${cardSel} [data-queue-reply]`;

async function browserPhase(pw) {
  const pageErrors = [];
  const browser = await pw.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const realSnapshot = await fetch(`${base}/api/state`).then((r) => r.json());
  await installFakeEventSource(context);
  await context.addInitScript(
    ({ snapshot, thread }) => {
      const realFetch = window.fetch.bind(window);
      const probe = { posts: [], snapshot };
      window.__probe = probe;
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      window.fetch = async (url, opts = {}) => {
        const u = String(url);
        const method = String((opts && opts.method) || "GET").toUpperCase();
        if (method !== "POST") return u.includes("/api/state") ? json({ ...probe.snapshot, jobs: [...state.jobs.values()] }) : realFetch(url, opts);
        probe.posts.push({ url: u, body: opts && opts.body ? JSON.parse(String(opts.body)) : null });
        if (u.includes("/api/agents/reply")) {
          return json({
            job: {
              id: `probe-reply-${probe.posts.length}`,
              thread,
              turn: 2,
              prompt: (probe.posts[probe.posts.length - 1].body || {}).text || "",
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
      // The shipped card: a real conversation object in state.jobs, painted by the page's own renderJobs.
      const job = (o) => ({
        id: o.id,
        thread,
        turn: 1,
        status: o.status,
        prompt: "probe brief - the state under test",
        displayPrompt: "probe brief - the state under test",
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
        document.activeElement?.blur?.();
        state.jobs.clear();
        state.replyQueue.delete(thread);
        state.replyDrafts[thread] = "";
        state.boxModels.delete(`reply:${thread}`);
        document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`)?.remove();
        for (const t of turns) state.jobs.set(t.id, job(t));
        renderJobs();
        const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
        if (box) box.focus();
        return Boolean(box);
      };
      // Everything the assertions read, off the LIVE DOM (never a fixture of the markup).
      probe.read = () => {
        const card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
        const box = card?.querySelector(".reply-box");
        const btn = card?.querySelector("[data-queue-reply]");
        const note = card?.querySelector("[data-queue-wait]");
        return {
          queue: [...(state.replyQueue.get(thread) || [])].map((q) => q.text),
          ghosts: [...(card?.querySelectorAll(".ghost-turn") || [])].map((g) => g.innerText.replace(/\s+/g, " ").trim()),
          box: box ? window.WMApp.board.pasteChips.readBox(box) : null,
          editable: box ? box.getAttribute("contenteditable") : null,
          readOnly: box ? box.getAttribute("aria-readonly") : null,
          boxClass: box ? box.className : null,
          btn: btn ? { disabled: btn.disabled, aria: btn.getAttribute("aria-disabled"), title: btn.title } : null,
          note: note ? { text: note.textContent.trim(), hidden: Boolean(note.hidden) } : null,
        };
      };
      // A click event straight at the node: this bypasses the disabled attribute, so it is the guard itself being
      // asked, not the browser's own refusal.
      probe.clickThrough = () => {
        const btn = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"] [data-queue-reply]`);
        if (!btn) return false;
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        return true;
      };
      // The turn ends: the held reply becomes sendable, and the drain is the page's own.
      probe.finishTurn = async () => {
        for (const j of state.jobs.values()) if (j.thread === thread) j.status = "done";
        await drainReplyQueue(thread);
        return true;
      };
      probe.posts = [];
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
  if (!ready) return;

  const read = () => page.evaluate(() => window.__probe.read());
  const card = async (turns) => {
    const made = await page.evaluate((t) => window.__probe.card(t), turns);
    await page.waitForTimeout(150);
    return made;
  };
  const shot = async (name) => {
    const target = path.join(SHOTS, `${name}.png`);
    await page.locator(cardSel).screenshot({ path: target }).catch(async () => {
      await page.screenshot({ path: target });
    });
    return target;
  };
  const pressButton = async () => {
    await page.locator(queueBtnSel).click({ force: true, timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(200);
  };
  const pressEnter = async () => {
    await page.locator(boxSel).focus().catch(() => {});
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
  };

  mkdirSync(SHOTS, { recursive: true });

  // ================= one press ======================================================================
  console.log("\n== one press of Queue reply on a running worker card ==");
  ok("the card renders with its Queue reply button", (await card([{ id: "probe-run", status: "running" }])) && (await page.locator(queueBtnSel).count()) === 1);
  await page.locator(boxSel).fill(TEXT);
  await page.waitForTimeout(80);
  const shots = {};
  shots.before = await shot("before-press");

  await pressButton();
  const held = await read();
  check("(1) one press holds exactly one reply", held.queue, [TEXT]);
  check("(1) and draws exactly one ghost turn", held.ghosts.length, 1);
  check("(2) the Queue reply button is disabled while it is held", held.btn?.disabled, true);
  check("(2) the box is read-only (contenteditable=false)", held.editable, "false");
  check("(2) and says so to a screen reader", held.readOnly, "true");
  check("(3) the card says queued, waiting", held.note && !held.note.hidden ? held.note.text : null, "queued, waiting");
  shots.held = await shot("after-press-queued-waiting");

  // ================= a second press holds nothing ===================================================
  console.log("\n== a second press on the same text ==");
  await pressButton();
  check("(2) a second click on the disabled button holds nothing", (await read()).queue, [TEXT]);
  await page.evaluate(() => window.__probe.clickThrough());
  await page.waitForTimeout(150);
  check("(2) a click event dispatched at the button holds nothing either", (await read()).queue, [TEXT]);

  // The box must take no input while the first reply is held: this is the half the base build got wrong.
  await page.locator(boxSel).click({ force: true }).catch(() => {});
  await page.keyboard.type(TEXT);
  await page.waitForTimeout(150);
  const typed = await read();
  check("(2) the box takes no input while the reply is held", typed.box, "");
  await pressButton();
  const afterRetype = await read();
  check("(2) so pressing again cannot hold the same text twice", afterRetype.queue, [TEXT]);
  await pressEnter();
  check("(2) and Enter holds nothing more either", (await read()).queue, [TEXT]);
  shots.second = await shot("after-second-press-and-retype");

  // ================= the Enter path is the same single entry =======================================
  console.log("\n== the Enter path ==");
  await card([{ id: "probe-run-enter", status: "running" }]);
  await page.locator(boxSel).fill(TEXT);
  await page.waitForTimeout(80);
  await pressEnter();
  const byEnter = await read();
  check("(5) Enter holds exactly one reply", byEnter.queue, [TEXT]);
  check("(5) with the button off, the box read-only and the queued state visible",
    [byEnter.btn?.disabled, byEnter.editable, byEnter.note && !byEnter.note.hidden ? byEnter.note.text : null],
    [true, "false", "queued, waiting"]);

  // ================= the state clears when the reply is drawn ======================================
  console.log("\n== the held reply is drawn ==");
  await page.evaluate(() => window.__probe.finishTurn());
  await page.waitForTimeout(400);
  const drawn = await read();
  check("(4) the held reply left the queue", drawn.queue, []);
  check("(4) the box is editable again", drawn.editable, "true");
  check("(4) and the queued state is gone", drawn.note ? drawn.note.hidden : true, true);
  shots.cleared = await shot("after-reply-drawn");

  check("no page errors", pageErrors, []);
  for (const [name, file] of Object.entries(shots)) console.log(`      shot ${name}: ${file}`);
  await browser.close();
}

try {
  if (!LIVE) await startSandbox();
  else base = LIVE;
  const pw = loadPlaywright({ root: TREE });
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN - no Playwright install found; set PANEL_PLAYWRIGHT_ROOT");
    process.exit(2);
  }
  await browserPhase(pw);
} catch (err) {
  failures += 1;
  console.log(`FAIL  the run itself: ${String((err && err.message) || err)}`);
} finally {
  await stopSandbox();
}

console.log(`\n${failures ? "FAILED" : "OK"}  ${checks - failures}/${checks} checks passed${failures ? `, ${failures} failed` : ""}`);
process.exit(failures ? 1 : 0);
