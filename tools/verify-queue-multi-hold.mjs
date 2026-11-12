// A held reply no longer closes the card: the reader types and queues the next message beside it.
//
//   node tools/verify-queue-multi-hold.mjs                        # this checkout, one sandbox panel
//   node tools/verify-queue-multi-hold.mjs --root <dir>           # a `git archive` of another build (RED PROOF)
//   node tools/verify-queue-multi-hold.mjs --shots <dir>          # where the card captures are written
//   PANEL_URL=http://127.0.0.1:7331 node tools/verify-queue-multi-hold.mjs   # a panel already running
//
// THE DEFECT. 205d7098 answered "is a reply held?" and closed the card on that answer: after ONE press the Queue
// reply button was drawn off, the box was read-only, and its sentence was replaced by "queued, waiting - your
// reply goes out when this turn finishes". The block lasted as long as the entry waited - the whole turn - so a
// reader with a second, different thing to say could not type or queue it at all. What 205d7098 was fixing (a
// second press holding the same text twice) is a hole in the PRESS, not in the HOLD: it is open only while the
// press is in flight, which is one task.
//
// THE CLAIM, driven against a real card drawn by the shipped renderer and a real keyboard:
//   (a) after one press the box is editable, empty, and the button is live, with the held reply counted beside it;
//   (b) a second, DIFFERENT message typed into that box is held as its own entry - two ghosts, two entries;
//   (c) a press dispatched INSIDE the first press's flight holds nothing (the 205d7098 hole stays shut);
//   (d) Enter is the same press and obeys the same predicate: type, Enter, type, Enter - both held;
//   then the turn ends: the two held replies go out in the order they were written.
//
// RED PROOF. Run with `--root` against `git archive <base>`: (a) fails there - the box refuses the typing
// ("queued, waiting" placeholder, contenteditable=false), so (b) and (d) cannot produce a second entry. The
// captures it writes are the before/after pair.
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
const SHOTS = path.resolve(opt("--shots", path.join(tmpdir(), "wtgui-queue-multi-hold")));
const LIVE = String(process.env.PANEL_URL || "").replace(/\/+$/, "");
const THREAD = "wtgui-probe-queue-multi-hold-71c2d1";
const FIRST = "the first message, held while the turn runs";
const SECOND = "a second and different message, typed after the first was held";
const THIRD = "a third one held from the keyboard";
const FOURTH = "and a fourth, also from the keyboard";

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
  dir = mkdtempSync(path.join(tmpdir(), "wtgui-queue-multi-hold-"));
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
              turn: probe.posts.length + 1,
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
          ph: box ? box.dataset.ph : null,
          btn: btn ? { disabled: btn.disabled, aria: btn.getAttribute("aria-disabled"), title: btn.title } : null,
          note: note ? { text: note.textContent.trim(), hidden: Boolean(note.hidden) } : null,
          pressInFlight: state.replyPress ? Boolean(state.replyPress.get(thread)) : false,
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
      // Two presses in ONE turn of the event loop, with text in the box both times: the shape a double click or a
      // held Enter key has, and the window 205d7098 was closing. The second press must hold nothing.
      probe.doublePress = async () => {
        const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
        const one = queueReplyFromBox(thread);
        if (box) box.textContent = "a second press inside the same flight";
        const two = queueReplyFromBox(thread);
        const [first, second] = await Promise.all([one, two]);
        return { first, second, queue: [...(state.replyQueue.get(thread) || [])].map((q) => q.text) };
      };
      // The turn ends: the held replies become sendable, and the drain is the page's own.
      probe.finishTurn = async () => {
        for (const j of state.jobs.values()) if (j.thread === thread) j.status = "done";
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
    await page.waitForTimeout(250);
  };
  const typeInBox = async (text) => {
    await page.locator(boxSel).click({ force: true }).catch(() => {});
    await page.keyboard.type(text);
    await page.waitForTimeout(120);
  };
  const pressEnter = async () => {
    await page.locator(boxSel).focus().catch(() => {});
    await page.keyboard.press("Enter");
    await page.waitForTimeout(250);
  };

  mkdirSync(SHOTS, { recursive: true });

  // ================= (a) one press, and the box comes back =========================================
  console.log("\n== one press of Queue reply on a running worker card ==");
  ok("the card renders with its Queue reply button", (await card([{ id: "probe-run", status: "running" }])) && (await page.locator(queueBtnSel).count()) === 1);
  await page.locator(boxSel).fill(FIRST);
  await page.waitForTimeout(80);
  const shots = {};
  shots.pressed = await shot("before-press");

  await pressButton();
  const held = await read();
  check("(a) one press holds exactly one reply", held.queue, [FIRST]);
  check("(a) the box is editable again", held.editable, "true");
  check("(a) and says nothing about being read-only", held.readOnly, null);
  check("(a) the Queue reply button is live again", held.btn?.disabled, false);
  check("(a) the box came back empty", held.box, "");
  check("(a) the held reply is counted beside it", held.note && !held.note.hidden ? held.note.text : null, "1 queued");
  ok(
    "(a) the box carries its own sentence again, not the closed face's",
    typeof held.ph === "string" && held.ph.length > 0 && !held.ph.includes("queued, waiting"),
    JSON.stringify(held.ph),
  );

  // ================= (b) a second, different message is held too ===================================
  console.log("\n== the second, different message: typed, then held ==");
  await typeInBox(SECOND);
  const typedSecond = await read();
  check("(b) the box takes the second message", typedSecond.box, SECOND);
  if (typedSecond.box !== SECOND) shots.blocked = await shot("BEFORE-the-block-box-refused-typing");
  await pressButton();
  const twoHeld = await read();
  check("(b) two different messages are two held entries, in order", twoHeld.queue, [FIRST, SECOND]);
  check("(b) and the card draws two ghosts", twoHeld.ghosts.length, 2);
  check("(b) with both counted", twoHeld.note && !twoHeld.note.hidden ? twoHeld.note.text : null, "2 queued");
  check("(b) and the box still open for a third", twoHeld.editable, "true");
  shots.twoHeld = await shot("after-two-messages-held");

  // ================= (c) a press inside the flight holds nothing ==================================
  console.log("\n== a press dispatched inside the first press's flight (the 205d7098 hole) ==");
  await card([{ id: "probe-run-flight", status: "running" }]);
  await page.locator(boxSel).fill(FIRST);
  await page.waitForTimeout(80);
  const double = await page.evaluate(() => window.__probe.doublePress());
  check("(c) the first press of the pair reports that it held", double.first, true);
  check("(c) the press inside its flight holds nothing", double.second, false);
  check("(c) so the card holds one entry, not two", double.queue, [FIRST]);
  const afterDouble = await read();
  check("(c) and the box is open again once it has settled", afterDouble.editable, "true");
  check("(c) with the flight released", afterDouble.pressInFlight, false);
  shots.flight = await shot("after-double-press-during-flight");

  // ================= (d) Enter is the same press =================================================
  console.log("\n== the Enter path: type, Enter, type, Enter ==");
  await card([{ id: "probe-run-enter", status: "running" }]);
  await page.locator(boxSel).fill(FIRST);
  await page.waitForTimeout(80);
  await pressEnter();
  const enterOne = await read();
  check("(d) Enter holds the first message", enterOne.queue, [FIRST]);
  check("(d) and the box comes back open and empty", [enterOne.editable, enterOne.box], ["true", ""]);
  await typeInBox(SECOND);
  check("(d) the box takes the second message from the keyboard too", (await read()).box, SECOND);
  await pressEnter();
  const enterTwo = await read();
  check("(d) Enter holds the second message as its own entry", enterTwo.queue, [FIRST, SECOND]);
  check("(d) two ghosts, and the box still open", [enterTwo.ghosts.length, enterTwo.editable], [2, "true"]);
  shots.enter = await shot("after-two-messages-held-by-enter");

  // ================= the turn ends, both go out in order =========================================
  console.log("\n== the turn ends: both held replies go out, in order ==");
  await page.evaluate(() => window.__probe.finishTurn());
  await page.waitForTimeout(300);
  await page.evaluate((t) => drainReplyQueue(t), THREAD);
  await page.waitForTimeout(300);
  const afterOne = await read();
  check("the first held reply was drawn and sent", afterOne.queue, [SECOND]);
  // A sent reply starts the next turn, so the second entry waits for it exactly as it waited for the first: end
  // that turn and the drain takes the second one.
  await page.evaluate(() => window.__probe.finishTurn());
  await page.waitForTimeout(300);
  await page.evaluate((t) => drainReplyQueue(t), THREAD);
  await page.waitForTimeout(400);
  const drained = await read();
  check("the second followed it", drained.queue, []);
  const sentTexts = await page.evaluate(() => window.__probe.posts.filter((p) => p.url.includes("/api/agents/reply")).map((p) => String(p.body.text).split("\n")[0]));
  check("both were sent, first one first", sentTexts, [FIRST, SECOND]);
  check("the note is gone with them", drained.note ? drained.note.hidden : true, true);
  check("and the box is the reader's again", drained.editable, "true");
  shots.drained = await shot("after-both-sent");

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
