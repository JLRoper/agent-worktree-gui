// ONE Enter in a reply box is ONE queued chip - measured on a real card, at 1440, before and after the fix.
//
//   node tools/verify-queue-held-snapshot-race.mjs                     # this checkout, one sandbox panel
//   node tools/verify-queue-held-snapshot-race.mjs --root <dir>        # a `git archive` of another build (RED PROOF)
//   node tools/verify-queue-held-snapshot-race.mjs --shots <dir>       # where the pair of captures is written
//   PANEL_URL=http://127.0.0.1:7331 node tools/verify-queue-held-snapshot-race.mjs   # a panel already running
//
// THE DEFECT. queueReply() (public/app.js) pushes the entry into state.replyQueue and then posts it to the panel
// (POST /api/held-replies, action add). The panel stores the record with the page's own `at` and broadcasts its
// `held-replies` view; the drain broadcasts that view whenever a hold arrives, starts, or is released. When that
// broadcast reaches the page BEFORE the POST's answer has stamped `heldId` on the entry, applyHeldReplies() could not
// find the record by id, read it as a record the page did not hold, and pushed a second entry for the same words.
// The reader's screenshot: two identical chips for one press, both "queued 3s", the card counting "2 queued".
//
// THE CLAIM, on one card and one real keyboard:
//   (a) one Enter holds ONE chip, and the card counts "1 queued", even though the panel's view of that same press
//       arrives first and the POST's answer is still in flight;
//   (b) the answer landing afterwards does not add a second chip either;
//   (c) the x takes that entry back and cancels the panel's record of it, by the id the entry adopted;
//   (d) a re-queued reply is ONE chip, not the pair, and its own x clears it again.
//
// RED PROOF. Run with `--root` against `git archive <base>`: (a) fails there with two chips and "2 queued" - the
// captures it writes are the before/after pair. The page's own held-replies listener is used (a recording
// EventSource), and only the POST's answer is held open, which is exactly the window a live page has.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const SHOTS = path.resolve(opt("--shots", path.join(tmpdir(), "wtgui-queue-held-snapshot-race")));
const LABEL = String(opt("--label", "run")).replace(/[^\w.-]+/g, "-");
const LIVE = String(process.env.PANEL_URL || "").replace(/\/+$/, "");
const VIEWPORT = { width: 1440, height: 1000 };
const THREAD = "wtgui-probe-queue-held-snapshot-3f8a1c";
const FIRST = "one Enter, one queued reply - the double-queue probe";
const SECOND = "typed again after the x, and queued once";

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
  dir = mkdtempSync(path.join(tmpdir(), "wtgui-queue-held-snapshot-"));
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
        // Nothing here may reach a gateway: the page's fetch is stubbed for the writes it makes, and a probe that
        // resolved a name would buy a real worker.
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

async function browserPhase(pw) {
  const pageErrors = [];
  const browser = await pw.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT });
  const realSnapshot = await fetch(`${base}/api/state`).then((r) => r.json());
  await context.addInitScript(
    ({ snapshot, thread }) => {
      const realFetch = window.fetch.bind(window);
      const probe = { posts: [], cancelPosts: [], answers: [], streams: [], snapshot };
      window.__probe = probe;
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      // A stream that records its listeners, so the probe can deliver the panel's OWN `held-replies` event into the
      // page's own handler. Nothing else about the page's SSE use changes: no event is invented but this one.
      window.EventSource = function FakeStream(url) {
        this.url = url;
        this.readyState = 1;
        this._handlers = new Map();
        this.addEventListener = (type, fn) => {
          if (!this._handlers.has(type)) this._handlers.set(type, []);
          this._handlers.get(type).push(fn);
        };
        this.removeEventListener = () => {};
        this.close = () => {
          this.readyState = 2;
        };
        probe.streams.push(this);
      };
      window.fetch = async (url, opts = {}) => {
        const u = String(url);
        const method = String((opts && opts.method) || "GET").toUpperCase();
        if (method !== "POST") return u.includes("/api/state") ? json({ ...probe.snapshot, jobs: [...state.jobs.values()] }) : realFetch(url, opts);
        const body = opts && opts.body ? JSON.parse(String(opts.body)) : {};
        // The write-through a held reply makes. Its ANSWER is held open on purpose: on a live page the panel's
        // broadcast can arrive before this answer names the entry, and that is the window the defect lives in.
        if (u.includes("/api/held-replies")) {
          if (body.action === "cancel") {
            probe.cancelPosts.push(body);
            return json({ ok: true, changed: true, reply: { id: body.id, state: "cancelled" } });
          }
          probe.posts.push({ url: u, body });
          const id = `probe-held-${probe.posts.length}`;
          return new Promise((resolve) => {
            probe.answers.push(() =>
              resolve(json({ ok: true, added: true, reply: { id, thread: body.thread, text: body.text, at: body.at, state: "held" } })),
            );
          });
        }
        probe.posts.push({ url: u, body });
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
        subagents: [],
      });
      probe.card = (turns) => {
        document.activeElement?.blur?.();
        state.jobs.clear();
        state.replyQueue.delete(thread);
        if (state.replyPress) state.replyPress.delete(thread);
        state.replyDrafts[thread] = "";
        state.boxModels.delete(`reply:${thread}`);
        document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`)?.remove();
        for (const t of turns) state.jobs.set(t.id, job(t));
        renderJobs();
        const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
        if (box) box.focus();
        return Boolean(box);
      };
      // Everything the assertions read is off the LIVE DOM, never a fixture of the markup.
      probe.read = () => {
        const card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
        const note = card?.querySelector("[data-queue-wait]");
        return {
          queue: [...(state.replyQueue.get(thread) || [])].map((q) => ({ text: q.text, at: q.at, heldId: q.heldId || null })),
          ghosts: [...(card?.querySelectorAll(".ghost-turn") || [])].map((g) => g.innerText.replace(/\s+/g, " ").trim()),
          ages: [...(card?.querySelectorAll(".queue-ago") || [])].map((a) => a.textContent.trim()),
          note: note ? { text: note.textContent.trim(), hidden: Boolean(note.hidden) } : null,
          editable: card?.querySelector(".reply-box")?.getAttribute("contenteditable") ?? null,
        };
      };
      // The panel's view of the ONE record this press wrote, as the drain broadcasts it: same id it would store,
      // same `at` the page stamped (the record comes back with it), state `held`.
      probe.heldRecord = (text) => {
        const entry = (state.replyQueue.get(thread) || []).find((e) => e && e.text === text);
        if (!entry) return null;
        return { id: `probe-held-${probe.posts.filter((p) => String(p.body?.action || "add") === "add").length}`, thread, text: entry.text, at: entry.at, state: "held", attachments: [] };
      };
      probe.emitHeld = (record) => {
        const data = JSON.stringify({ type: "held-replies", held: { replies: record ? [record] : [], counts: { held: record ? 1 : 0, sending: 0 } } });
        let delivered = 0;
        for (const s of probe.streams) {
          for (const fn of s._handlers.get("held-replies") || []) {
            fn({ data });
            delivered += 1;
          }
        }
        return delivered;
      };
      probe.answer = () => {
        const pending = probe.answers.splice(0);
        for (const f of pending) f();
        return pending.length;
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
    const target = path.join(SHOTS, `${LABEL}-${name}.png`);
    await page.locator(cardSel).screenshot({ path: target }).catch(async () => {
      await page.screenshot({ path: target });
    });
    return target;
  };
  // The reader's gesture: text in the box, one Enter.
  const typeAndEnter = async (text) => {
    await page.locator(boxSel).click({ force: true }).catch(() => {});
    await page.locator(boxSel).fill(text);
    await page.waitForTimeout(80);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
  };

  mkdirSync(SHOTS, { recursive: true });
  console.log(`\nviewport ${VIEWPORT.width}x${VIEWPORT.height}, build ${TREE}`);

  // ================= (a) one Enter, and the panel's view of that same press arrives first =========
  console.log("\n== one Enter, then the panel's held-replies view of that same press ==");
  ok("the card renders with its Queue reply button", (await card([{ id: "probe-run", status: "running" }])) && (await page.locator(`${cardSel} [data-queue-reply]`).count()) === 1);
  await typeAndEnter(FIRST);
  const pressed = await read();
  check("(a) one Enter holds one entry in the page's queue before the broadcast", pressed.queue.map((q) => q.text), [FIRST]);
  check("(a) and its answer has not named it yet", pressed.queue.map((q) => q.heldId), [null]);

  const record = await page.evaluate((text) => window.__probe.heldRecord(text), FIRST);
  const delivered = await page.evaluate((rec) => window.__probe.emitHeld(rec), record);
  ok("(a) the page's own held-replies listener received the record", delivered >= 1, `${delivered} listener(s)`);
  await page.waitForTimeout(250);
  const afterView = await read();
  const beforeShot = await shot("one-enter-chips-before-the-answer");
  check("(a) one Enter is ONE chip", afterView.ghosts.length, 1);
  check("(a) and the card counts one", afterView.note ? afterView.note.text : null, "1 queued");
  check("(a) which is one queued entry", afterView.queue.map((q) => q.text), [FIRST]);
  check("(a) one record, one id on the entry", afterView.queue.map((q) => q.heldId), [record.id]);

  // ================= (b) the answer lands afterwards ==============================================
  console.log("\n== the POST's answer lands afterwards ==");
  const answered = await page.evaluate(() => window.__probe.answer());
  ok("(b) the add's answer was released", answered === 1);
  await page.waitForTimeout(250);
  const settled = await read();
  const afterShot = await shot("one-enter-chips-after-the-answer");
  check("(b) still one chip", settled.ghosts.length, 1);
  check("(b) still counted once", settled.note ? settled.note.text : null, "1 queued");
  check("(b) still one entry", settled.queue.map((q) => q.text), [FIRST]);
  if (settled.ghosts.length > 1) console.log(`      both chips read: ${JSON.stringify(settled.ghosts)}`);

  // ================= (c) the x takes that one entry back, record and all ==========================
  console.log("\n== the x on the one chip ==");
  await page.locator(`${cardSel} [data-queue-cancel]`).first().click({ force: true });
  await page.waitForTimeout(250);
  const cleared = await read();
  check("(c) the queue is empty", cleared.queue, []);
  check("(c) no chip is left", cleared.ghosts.length, 0);
  const cancels = await page.evaluate(() => window.__probe.cancelPosts.map((c) => c.id));
  check("(c) the panel's record was cancelled by the id the entry adopted", cancels, [record.id]);

  // ================= (d) the re-queue is one chip too =============================================
  console.log("\n== re-queue after the x ==");
  await typeAndEnter(SECOND);
  const again = await read();
  check("(d) one Enter re-queues one entry", again.queue.map((q) => q.text), [SECOND]);
  const secondRecord = await page.evaluate((text) => window.__probe.heldRecord(text), SECOND);
  await page.evaluate((rec) => window.__probe.emitHeld(rec), secondRecord);
  await page.waitForTimeout(250);
  const requeued = await read();
  const requeuedShot = await shot("requeue-after-the-x");
  check("(d) and the view of it does not add the pair", requeued.ghosts.length, 1);
  check("(d) counted once", requeued.note ? requeued.note.text : null, "1 queued");
  await page.locator(`${cardSel} [data-queue-cancel]`).first().click({ force: true });
  await page.waitForTimeout(200);
  const emptied = await read();
  check("(d) its own x clears it", [emptied.queue.length, emptied.ghosts.length], [0, 0]);

  check("no page errors", pageErrors, []);
  for (const [name, file] of Object.entries({ before: beforeShot, after: afterShot, requeued: requeuedShot })) {
    console.log(`      shot ${name}: ${file}`);
  }
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
