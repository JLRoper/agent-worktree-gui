// The x on a queued reply — proved by driving a panel of this checkout and a real browser over it, with real
// clicks, real keys and a stubbed gateway that RECORDS every request the page would have made.
//
//   PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-cancel-queued-reply.mjs
//   PANEL_URL=http://127.0.0.1:7333 node tools/verify-cancel-queued-reply.mjs    drive a panel already running
//
// What each acceptance item of the brief is proved by:
//
//   (a) one queued entry carries a x; pressing it removes that entry, its ghost line and the `N queued` note —
//       quoted before/after from the card's own DOM
//   (b) with two held replies, cancelling the first leaves the second, and the second still goes out when the
//       turn ends — quoted as the request the panel actually posts
//   (c) cancel both and nothing is ever posted for that thread
//   (d) the race with the drain, BOTH directions: a press while the drain is in flight cannot call a taken entry
//       back (the card says "that one was already sent", and the send it could not stop is shown as the post that
//       went out), and a press on the surviving entry during that same window wins — it is never sent, because the
//       drain re-reads the queue at send time
//   (e) an accidental x puts the text back as the draft into an EMPTY box only; a box the reader is part-way
//       through is left exactly as it was
//   (f) the x is a real <button>, tab-reachable, carrying its title and aria-label, activated by Enter, and it
//       reflows nothing (measured with and without it on the same ghost line)
//   (g) `node tools/verify-assistant.mjs` and the public-facing suites stay green — run separately; this script
//       asserts the shape of its own change instead
//
// WHAT IS DRIVEN, AND WHAT IS ONLY INSPECTED
//
//   driven    a panel of this checkout (or PANEL_URL) plus headless Chromium over it; the card's own states
//             fabricated in the page's state.jobs and rendered by the shipped renderJobs/conversationHtml; every
//             ghost entry and every request read back out of the live DOM and the stubbed fetch
//   driven    the drain the way the panel fires it at the end of a turn: updateJob(status -> done), which is the
//             production call site, with the reply POST held open to open the race window
//   inspected that the click branch calls the one cancel function, that the drain looks the entry up by identity,
//             and that the entry render keys the x on the entry's own `at` — read off public/app.js
//
// The browser half needs a Playwright install; without one the script prints BROWSER-HALF-NOT-RUN and exits 1
// rather than passing on a half that never ran.
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
async function waitFor(fn, { timeoutMs = 20_000, stepMs = 100, what = "condition" } = {}) {
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
const THREAD = "wtgui-probe-cancel-reply-9c31d0";
let dir = null;
let panel = null;
let base = LIVE;
const panelLog = [];

async function startSandbox() {
  dir = mkdtempSync(path.join(tmpdir(), "wtgui-cancel-reply-"));
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
        // Nothing this script drives may reach a gateway: the page's own fetch is stubbed for the writes, and this
        // is the belt to that brace — a probe that resolved a name would buy a real worker.
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
const cancelSel = `${cardSel} .ghost-cancel`;

async function browserPhase(pw) {
  const pageErrors = [];
  const browser = await pw.chromium.launch({ headless: true });
  browserRef = browser;
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });

  // Registered BEFORE the page navigates, and it also replaces EventSource: the live stream broadcasts `jobs`,
  // which CLEARS state.jobs, so a card fabricated here would be wiped mid-check by a broadcast. With no stream and
  // a stubbed fetch, this probe's state.jobs is the only source of cards, and every request is recorded.
  const realSnapshot = await fetch(`${base}/api/state`).then((r) => r.json());
  await context.addInitScript(
    ({ snapshot, thread }) => {
      const realFetch = window.fetch.bind(window);
      const probe = { posts: [], clicks: [], snapshot, holdReplies: false, pending: [], replyId: 0 };
      window.__probe = probe;
      // Where a click the page actually received landed — the evidence for a press that arrived after the drain
      // had already repainted the card out from under it.
      document.addEventListener(
        "click",
        (e) => {
          const t = e.target;
          probe.clicks.push({ cls: (t && t.className) || "", tag: (t && t.tagName) || "", cancelAt: (t && t.dataset && t.dataset.queueCancelAt) || null });
        },
        true,
      );
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      const replyJob = (body) => ({
        job: {
          id: `probe-reply-${(probe.replyId += 1)}`,
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
      window.fetch = async (url, opts = {}) => {
        const u = String(url);
        const method = String((opts && opts.method) || "GET").toUpperCase();
        if (method !== "POST") {
          if (u.includes("/api/state")) return json({ ...probe.snapshot, jobs: [...state.jobs.values()] });
          return realFetch(url, opts);
        }
        const body = opts && opts.body ? JSON.parse(String(opts.body)) : null;
        probe.posts.push({ url: u, body });
        if (u.includes("/api/agents/reply") && probe.holdReplies) {
          // A reply POST held open: this is the drain's send in flight, which is the window the race lives in.
          return new Promise((resolve) => probe.pending.push(() => resolve(json(replyJob(body)))));
        }
        if (u.includes("/api/agents/reply")) return json(replyJob(body));
        return json({ ok: true });
      };
      const FakeStream = function () {
        this.readyState = 1;
      };
      FakeStream.prototype.addEventListener = function () {};
      FakeStream.prototype.removeEventListener = function () {};
      FakeStream.prototype.close = function () {};
      window.EventSource = FakeStream;

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
      const cardFor = () => document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
      probe.card = (turns) => {
        state.jobs.clear();
        state.replyQueue.delete(thread);
        state.replySent.delete(thread);
        state.replyDrafts[thread] = "";
        for (const t of turns) state.jobs.set(t.id, job(t));
        renderJobs();
        const box = document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`);
        if (box) box.value = "";
        return Boolean(box);
      };
      // The panel's own path at the end of a turn: updateJob moves the status, and its statusChanged branch calls
      // drainReplyQueue once the thread has nothing running — the production call site, not a stand-in.
      probe.finishTurn = () => {
        const j = [...state.jobs.values()].find((x) => (x.thread || x.id) === thread && turnLive(x));
        if (!j) return false;
        updateJob({ ...j, status: "done", endedAt: new Date().toISOString() });
        return true;
      };
      probe.releaseReplies = () => {
        const pend = probe.pending.splice(0);
        for (const r of pend) r();
        return pend.length;
      };
      probe.queue = () => (state.replyQueue.get(thread) || []).map((q) => ({ text: q.text, at: q.at }));
      probe.sentRecord = () => (state.replySent.get(thread) || []).map((e) => e.at);
      probe.boxValue = () => document.querySelector(`.reply-box[data-reply="${CSS.escape(thread)}"]`)?.value ?? null;
      probe.draft = () => state.replyDrafts[thread] ?? null;
      probe.warn = () => document.querySelector(`[data-reply-warn="${CSS.escape(thread)}"]`)?.textContent ?? null;
      probe.note = () => {
        const el = cardFor()?.querySelector(".queue-note");
        return el ? { text: el.textContent, title: el.title } : null;
      };
      probe.ghosts = () => {
        const card = cardFor();
        return [...(card?.querySelectorAll(".ghost-turn") || [])].map((g) => ({
          text: g.querySelector(".ghost-prompt")?.textContent ?? "",
          at: g.querySelector(".ghost-cancel")?.dataset.queueCancelAt ?? null,
          head: (g.querySelector(".ghost-head")?.innerText || "").replace(/\s+/g, " ").trim(),
          html: g.outerHTML,
        }));
      };
      probe.ghostTurnsHtml = () => cardFor()?.querySelector(".ghost-turns")?.outerHTML ?? null;
      probe.cancelButtons = () =>
        [...(cardFor()?.querySelectorAll(".ghost-cancel") || [])].map((b) => {
          const cs = getComputedStyle(b);
          const r = b.getBoundingClientRect();
          return {
            tag: b.tagName,
            type: b.getAttribute("type"),
            title: b.title,
            aria: b.getAttribute("aria-label"),
            text: b.textContent,
            thread: b.dataset.queueCancel,
            at: b.dataset.queueCancelAt,
            isSend: Boolean(b.dataset.queueReply || b.dataset.steer || b.classList.contains("btn-reply")),
            bg: cs.backgroundColor,
            color: cs.color,
            borderColor: cs.borderColor,
            font: cs.fontFamily.slice(0, 24) + " " + cs.fontSize,
            radius: cs.borderRadius,
            w: Math.round(r.width),
            h: Math.round(r.height),
          };
        });
      // Does the x change the ghost line's own box? Measured on the live node, with the button taken out and put
      // back, so both numbers come from the same layout.
      probe.ghostLine = () => {
        const turn = cardFor()?.querySelector(".ghost-turn");
        const head = turn?.querySelector(".ghost-head");
        const btn = turn?.querySelector(".ghost-cancel");
        if (!turn || !head || !btn) return null;
        const rect = (el) => {
          const r = el.getBoundingClientRect();
          return { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100 };
        };
        const withBtn = { head: rect(head), turn: rect(turn) };
        const btnRect = rect(btn);
        btn.remove();
        const without = { head: rect(head), turn: rect(turn) };
        head.appendChild(btn);
        return { withBtn, without, btn: btnRect, headFont: getComputedStyle(head).fontSize };
      };
      // Exactly what the delegated click branch calls, with the arguments the button carries. Used for the half of
      // the race the DOM cannot reach any more once the drain has repainted the card.
      probe.cancelByIdentity = (at) => {
        const out = cancelQueuedReply(thread, at);
        return { out, warn: document.querySelector(`[data-reply-warn="${CSS.escape(thread)}"]`)?.textContent ?? null };
      };
      probe.sendControls = () => {
        const card = cardFor();
        const q = card?.querySelector("[data-queue-reply]");
        const s = card?.querySelector("[data-steer]");
        return { queue: q ? { tag: q.tagName, title: q.title } : null, steer: s ? { tag: s.tagName, title: s.title } : null };
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

  const ev = (fn, arg) => page.evaluate(fn, arg);
  const posts = () => ev(() => window.__probe.posts.map((p) => ({ url: p.url, body: p.body })));
  const replies = async () => (await posts()).filter((p) => p.url.includes("/api/agents/reply"));
  const steers = async () => (await posts()).filter((p) => p.url.includes("/api/jobs/steer"));
  const clearPosts = () => ev(() => { window.__probe.posts.length = 0; });
  const queue = () => ev(() => window.__probe.queue());
  const ghosts = () => ev(() => window.__probe.ghosts());
  const ghostHtml = () => ev(() => window.__probe.ghostTurnsHtml());
  const note_ = () => ev(() => window.__probe.note());
  const warn = () => ev(() => window.__probe.warn());
  const boxValue = () => ev(() => window.__probe.boxValue());
  const cancelButtons = () => ev(() => window.__probe.cancelButtons());
  const card = async (turns) => {
    const made = await ev((t) => window.__probe.card(t), turns);
    await page.waitForTimeout(120);
    return made;
  };
  const type = async (text) => {
    await page.locator(boxSel).fill(text);
    await page.waitForTimeout(60);
  };
  const holdReplies = (on) => ev((v) => { window.__probe.holdReplies = v; }, on);
  const releaseReplies = () => ev(() => window.__probe.releaseReplies());
  const finishTurn = async () => {
    const done = await ev(() => window.__probe.finishTurn());
    await page.waitForTimeout(250);
    return done;
  };
  const runningCard = [{ id: "probe-cancel-a", status: "running" }];

  // =================================== (a) one entry, one x ==========================================
  console.log("\n== (a) a card with one queued reply: the × removes that entry ==");
  ok("the card renders with its reply box", await card(runningCard));
  await type("hold this one");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  check("(a) Enter held the reply", (await queue()).map((q) => q.text), ["hold this one"]);
  const beforeHtml = await ghostHtml();
  const beforeNote = await note_();
  note(`BEFORE ghost DOM: ${beforeHtml}`);
  note(`BEFORE note: ${JSON.stringify(beforeNote)}`);
  const btnsA = await cancelButtons();
  check("(a) the entry carries exactly one ×", btnsA.length, 1);
  check("(a) it is a real button", { tag: btnsA[0].tag, type: btnsA[0].type }, { tag: "BUTTON", type: "button" });
  ok("(a) it is keyed to the entry's own `at`, not the thread", btnsA[0].at === String((await queue())[0].at), `× at ${btnsA[0].at}, queue at ${(await queue())[0].at}`);
  await clearPosts();
  await page.locator(cancelSel).click();
  await page.waitForTimeout(250);
  check("(a) the entry is gone from the queue", await queue(), []);
  check("(a) the ghost line is gone", await ghostHtml(), null);
  check("(a) the `N queued` note went with it", await note_(), null);
  check("(a) nothing was posted", await posts(), []);
  note(`AFTER ghost DOM: ${JSON.stringify(await ghostHtml())}, note ${JSON.stringify(await note_())}`);

  // =================================== (b) two entries, the first one cancelled ======================
  console.log("\n== (b) two held replies: cancelling the first leaves the second, which still sends ==");
  await card(runningCard);
  await clearPosts();
  await type("first — cancel me");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  await type("second — let me go out");
  await page.locator(`${cardSel} [data-queue-reply]`).click();
  await page.waitForTimeout(200);
  const two = await queue();
  check("(b) both replies are held, in the order they were written", two.map((q) => q.text), ["first — cancel me", "second — let me go out"]);
  check("(b) the note counts both", (await note_()).text, "2 queued");
  const btnsB = await cancelButtons();
  check("(b) each entry has its own ×, keyed to its own `at`", btnsB.map((b) => b.at), two.map((q) => String(q.at)));
  ok("(b) the first ×'s identity is the first entry's", btnsB[0].at === String(two[0].at), `${btnsB[0].at} vs ${two[0].at}`);
  await page.locator(cancelSel).first().click();
  await page.waitForTimeout(250);
  const afterB = await queue();
  check("(b) the first entry is cancelled and the second is untouched", afterB.map((q) => q.text), ["second — let me go out"]);
  ok("(b) the second entry kept its own identity", afterB[0].at === two[1].at, `${afterB[0].at} vs ${two[1].at}`);
  check("(b) the card shows only the surviving ghost line", (await ghosts()).map((g) => g.text), ["second — let me go out"]);
  const noteB = await note_();
  check("(b) the note decremented", noteB.text, "1 queued");
  ok("(b) and its title lists the survivor only", noteB.title === "1. second — let me go out", JSON.stringify(noteB.title));
  ok("(b) the cancelled text is nowhere in the title", !noteB.title.includes("first"), noteB.title);
  check("(b) nothing has been posted yet", await replies(), []);
  // The turn ends: the panel's own end-of-turn path drains the queue.
  ok("(b) the turn finishes (the production call site: updateJob's statusChanged branch)", await finishTurn());
  const sentB = await waitFor(async () => (await replies()).length > 0, { what: "the surviving reply to be posted" });
  ok("(b) the surviving entry was sent when the turn ended", sentB);
  const postsB = await replies();
  check("(b) exactly one request went out", postsB.length, 1);
  note(`(b) THE REQUEST THE PANEL POSTED: POST ${postsB[0].url}  body ${JSON.stringify(postsB[0].body)}`);
  check("(b) to this thread", postsB[0].body.thread, THREAD);
  check("(b) carrying the SURVIVING entry's text", postsB[0].body.text, "second — let me go out");
  check("(b) the queue is empty", await queue(), []);
  check("(b) the ghost line and the note are gone", { ghosts: await ghostHtml(), note: await note_() }, { ghosts: null, note: null });

  // =================================== (c) cancel both, nothing is posted ============================
  console.log("\n== (c) cancel both: nothing is ever posted for that thread ==");
  await card(runningCard);
  await clearPosts();
  await type("one");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  await type("two");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  check("(c) two replies are held", (await queue()).length, 2);
  await page.locator(cancelSel).first().click();
  await page.waitForTimeout(200);
  await page.locator(cancelSel).first().click();
  await page.waitForTimeout(200);
  check("(c) both are cancelled", await queue(), []);
  check("(c) the ghost line is gone", await ghostHtml(), null);
  check("(c) the note is gone", await note_(), null);
  await finishTurn();
  await page.waitForTimeout(400);
  check("(c) the turn ending posted nothing at all", await posts(), []);

  // =================================== (d) the race with the drain ===================================
  console.log("\n== (d) the race: a press while the drain is in flight ==");
  await card(runningCard);
  await clearPosts();
  await holdReplies(true);
  await type("taken by the drain");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  await finishTurn();
  const inFlight = await waitFor(async () => (await replies()).length === 1 && (await queue()).length === 0, { what: "the drain to take the entry and hold its POST open" });
  ok("(d) the drain took the entry and its send is in flight (the POST is held open)", inFlight, `posts ${JSON.stringify((await replies()).map((p) => p.body.text))}`);
  const takenPosts = await replies();
  note(`(d) the send it could not stop: POST ${takenPosts[0].url}  body ${JSON.stringify(takenPosts[0].body)}`);
  note("(d) that press, played as a reader plays it — the × held down, the turn ending under the finger, then released:");
  await card(runningCard);
  await clearPosts();
  await type("pressed while the drain runs");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  const lateAt = (await queue())[0].at;
  const box = await page.locator(cancelSel).boundingBox();
  await ev(() => { window.__probe.clicks.length = 0; });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await finishTurn();
  await page.mouse.up();
  await page.waitForTimeout(250);
  const clicks = await ev(() => window.__probe.clicks.slice());
  const lateClick = clicks.find((c) => c.cls.includes("ghost-cancel")) || null;
  check("(d) the release reached no × at all — the drain's repaint had already replaced it", lateClick, null);
  note(`(d) ${clicks.length} click event(s) reached the page from that press; where they landed: ${JSON.stringify(clicks[clicks.length - 1] || null)}`);
  const lateWarnDom = await warn();
  ok("(d) so the DOM press claimed no cancellation", !lateWarnDom || !/cancelled/.test(lateWarnDom), JSON.stringify(lateWarnDom));
  // The handler's own answer for the identity that button carried, driven with the arguments the click branch passes:
  // the one path a DOM press can no longer take once the drain's repaint has swapped the node out.
  const lateAns = await ev((at) => window.__probe.cancelByIdentity(at), lateAt);
  check("(d) the handler answers for an entry the drain has taken honestly", lateAns.out, "sent");
  check("(d) and the card says so in words", lateAns.warn, "that one was already sent");
  check("(d) nothing was claimed as cancelled", /cancelled/.test((await warn()) || ""), false);
  check("(d) the queue is untouched by that press", await queue(), []);
  check("(d) and the send it could not stop is the one that went out", (await replies()).map((p) => p.body.text), ["pressed while the drain runs"]);
  note("(d) the other direction — the press wins for an entry the drain has NOT taken yet:");
  await card(runningCard);
  await clearPosts();
  await type("goes out");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  await type("cancelled mid-flight");
  await page.locator(`${cardSel} [data-queue-reply]`).click();
  await page.waitForTimeout(200);
  check("(d) two entries are held", (await queue()).map((q) => q.text), ["goes out", "cancelled mid-flight"]);
  const midFirstAt = (await queue())[0].at;
  const midSecondAt = (await queue())[1].at;
  await finishTurn(); // the drain takes the first and its POST stays held open
  await waitFor(async () => (await replies()).length === 1, { what: "the drain's send to be in flight" });
  const midSentRecord = await ev(() => window.__probe.sentRecord());
  check("(d) the record of what the drain took holds the first entry's identity", midSentRecord, [midFirstAt]);
  await page.locator(cancelSel).first().click(); // the SURVIVING entry's ×, pressed during that window
  await page.waitForTimeout(250);
  check("(d) the surviving entry is cancelled while the drain's send is in flight", await queue(), []);
  check("(d) the card shows no ghost line any more", await ghostHtml(), null);
  const held = await releaseReplies();
  ok("(d) the held send is released", held >= 1, `${held} held`);
  await page.waitForTimeout(400);
  const racePosts = await replies();
  check("(d) the drain sent only what was still in the queue — one request", racePosts.map((p) => p.body.text), ["goes out"]);
  check("(d) and never the cancelled one", racePosts.some((p) => p.body.text === "cancelled mid-flight"), false);
  const sentRecord = await ev(() => window.__probe.sentRecord());
  ok("(d) only the entry the drain sent is on the sent record", sentRecord.includes(midFirstAt) && !sentRecord.includes(midSecondAt), `record ${JSON.stringify(sentRecord)}, sent ${midFirstAt}, cancelled ${midSecondAt}`);
  await holdReplies(false);

  // =================================== (e) an accident must not lose the text ========================
  console.log("\n== (e) the draft: an empty box gets the text back, a full one is left alone ==");
  await card(runningCard);
  await clearPosts();
  check("(e) the box starts empty", await boxValue(), "");
  await type("this text must survive the ×");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  check("(e) the box is empty after Enter held it", await boxValue(), "");
  await page.locator(cancelSel).click();
  await page.waitForTimeout(250);
  check("(e) with an empty box the cancelled text is back as the draft", await boxValue(), "this text must survive the ×");
  check("(e) the draft is remembered, so a repaint cannot lose it", await ev(() => window.__probe.draft()), "this text must survive the ×");
  check("(e) and the card says where it went", await warn(), "that queued reply is cancelled — the text is back in the box as your draft");
  // …and the other half: a box the reader is part-way through is theirs.
  await card(runningCard);
  await type("cancel me too");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(150);
  await type("and I am still typing this");
  await page.locator(cancelSel).click();
  await page.waitForTimeout(250);
  check("(e) a non-empty box is left exactly as it was", await boxValue(), "and I am still typing this");
  check("(e) the cancelled text did NOT go into it", (await boxValue()).includes("cancel me too"), false);
  check("(e) the note promises no draft in that case", await warn(), "that queued reply is cancelled");
  check("(e) and the entry is gone all the same", await queue(), []);

  // =================================== (f) the × as a control ========================================
  console.log("\n== (f) the × is a real, keyboard-reachable dismiss control that reflows nothing ==");
  await card(runningCard);
  await clearPosts();
  await type("keyboard cancel");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  const btnsF = await cancelButtons();
  check("(f) it carries a title", /cancel this queued reply/.test(btnsF[0].title), true);
  note(`(f) title: ${btnsF[0].title}`);
  check("(f) it carries an aria-label naming the thread", btnsF[0].aria, `cancel this queued reply for ${THREAD}`);
  ok("(f) it is not a send control", btnsF[0].isSend === false, JSON.stringify({ isSend: btnsF[0].isSend }));
  note(`(f) computed style (hovered by the mouse left over from the race above): ${JSON.stringify({ bg: btnsF[0].bg, color: btnsF[0].color, font: btnsF[0].font, radius: btnsF[0].radius, box: `${btnsF[0].w}×${btnsF[0].h}` })}`);
  // Park the mouse, then measure the resting state, and the hover state against the card's OWN dismiss control: the
  // brief asks for the × to be styled like the panel's other dismiss controls, so that is measured, not asserted.
  await page.mouse.move(4, 4);
  await page.waitForTimeout(150);
  const resting = await cancelButtons();
  note(`(f) at rest: ${JSON.stringify({ bg: resting[0].bg, color: resting[0].color, border: resting[0].borderColor ?? null, radius: resting[0].radius, box: `${resting[0].w}×${resting[0].h}` })}`);
  check("(f) at rest it is unfilled — nothing that reads as a send", resting[0].bg, "rgba(0, 0, 0, 0)");
  const styleOf = (sel) =>
    ev(
      (arg) => {
        const card = document.querySelector(`.job[data-thread="${CSS.escape(arg.t)}"]`);
        const b = card?.querySelector(arg.sel);
        if (!b) return null;
        const cs = getComputedStyle(b);
        return { color: cs.color, border: cs.borderColor, bg: cs.backgroundColor, radius: cs.borderRadius };
      },
      { t: THREAD, sel },
    );
  await page.locator(`${cardSel} .btn-clear-thread`).hover();
  await page.waitForTimeout(120);
  const clearHover = await styleOf(".btn-clear-thread");
  await page.locator(cancelSel).hover();
  await page.waitForTimeout(120);
  const cancelHover = await styleOf(".ghost-cancel");
  note(`(f) hover — the card head's own clear control: ${JSON.stringify(clearHover)}`);
  note(`(f) hover — the queued entry's ×:                  ${JSON.stringify(cancelHover)}`);
  check("(f) on hover it wears the same colours as the panel's other dismiss control", { color: cancelHover.color, border: cancelHover.border }, { color: clearHover.color, border: clearHover.border });
  // Reach it with the keyboard, from the reply box: the × sits just before it in the card's tab order.
  await page.locator(boxSel).focus();
  await page.keyboard.press("Shift+Tab");
  await page.waitForTimeout(150);
  let active = await page.evaluate(() => ({ cls: document.activeElement?.className || "", tag: document.activeElement?.tagName || "" }));
  if (!String(active.cls).includes("ghost-cancel")) {
    note(`(f) Shift+Tab landed on ${JSON.stringify(active)} — walking the tab order instead`);
    for (let i = 0; i < 400 && !String(active.cls).includes("ghost-cancel"); i += 1) {
      await page.keyboard.press("Tab");
      active = await page.evaluate(() => ({ cls: document.activeElement?.className || "", tag: document.activeElement?.tagName || "" }));
    }
  }
  ok("(f) Tab reaches the × with no mouse", String(active.cls).includes("ghost-cancel"), JSON.stringify(active));
  const focused = await page.evaluate(() => ({
    aria: document.activeElement?.getAttribute("aria-label") || null,
    title: document.activeElement?.title || null,
  }));
  check("(f) the focused control is the × with its own aria-label", focused.aria, `cancel this queued reply for ${THREAD}`);
  // …and it works from the keyboard: Enter on a focused button is its press.
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);
  check("(f) Enter on the focused × cancels that entry", await queue(), []);
  check("(f) and posts nothing", await posts(), []);
  // No reflow: the same ghost line, measured with the button and without it.
  await card(runningCard);
  await type("measure me");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  const line = await ev(() => window.__probe.ghostLine());
  note(`(f) ghost line measured WITH the ×: head ${JSON.stringify(line.withBtn.head)}, entry ${JSON.stringify(line.withBtn.turn)} (head font ${line.headFont})`);
  note(`(f) the same line WITHOUT it:      head ${JSON.stringify(line.without.head)}, entry ${JSON.stringify(line.without.turn)}`);
  check("(f) the ghost head is no taller for having the × in it", line.withBtn.head.h, line.without.head.h);
  check("(f) and the ghost entry box is unchanged", line.withBtn.turn.h, line.without.turn.h);
  ok("(f) the × itself fits inside the line it sits on", line.btn.h <= line.without.head.h, `× ${line.btn.h}px, head ${line.without.head.h}px`);

  // =================================== the other gestures are untouched ==============================
  console.log("\n== Enter still queues, Ctrl+Enter still steers, and the queue's own controls are unchanged ==");
  await card(runningCard);
  await clearPosts();
  await type("queued by Enter");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  check("Enter still holds the reply", (await queue()).map((q) => q.text), ["queued by Enter"]);
  check("Enter still posts nothing", await posts(), []);
  const controls = await ev(() => window.__probe.sendControls());
  ok("the Queue reply button is still offered and still names Enter", controls.queue && /\(Enter\)/.test(controls.queue.title) && controls.queue.tag === "BUTTON", JSON.stringify(controls.queue));
  check("the note still counts the held replies", (await note_()).text, "1 queued");
  await type("steered instead");
  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(250);
  const steered = await steers();
  check("Ctrl+Enter still steers the live turn, one request", steered.length, 1);
  check("with the typed text", steered[0]?.body?.text, "steered instead");
  check("and holds nothing new", (await queue()).map((q) => q.text), ["queued by Enter"]);
  check("the × is still on the held line afterwards", (await cancelButtons()).length, 1);
  check("no page errors anywhere in this run", pageErrors, []);
  await browser.close();
  browserRef = null;
}

// ---- what can only be read off the source ---------------------------------------------------------
function sourceChecks() {
  const src = readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  const lines = src.split(/\r?\n/);
  const at = (needle) => lines.findIndex((l) => l.includes(needle));
  const defs = lines.filter((l) => l.includes("function cancelQueuedReply(")).length;
  check("inspected: cancelQueuedReply is defined once", defs, 1);
  const calls = lines.filter((l) => /cancelQueuedReply\(/.test(l) && !l.includes("function cancelQueuedReply(")).length;
  check("inspected: and called from exactly one place — the delegated click branch", calls, 1);
  const branchAt = at('const queueCancel = e.target.closest("[data-queue-cancel]");');
  const callAt = lines.findIndex((l, i) => i > branchAt && branchAt > 0 && l.includes("cancelQueuedReply(queueCancel.dataset.queueCancel"));
  ok("inspected: that branch is the one that calls it, with the TWO arguments the button carries", branchAt > 0 && callAt > branchAt, `branch ${branchAt + 1}, call ${callAt + 1}`);
  const markupAt = at('data-queue-cancel-at="${q.at}"');
  ok("inspected: the entry's × is keyed on the entry's own `at` in the markup", markupAt > 0, `line ${markupAt + 1}`);
  const inQueueMap = markupAt > 0 && lines[markupAt].includes("ghost-turn");
  ok("inspected: and it is drawn inside the per-entry map, so every held reply gets its own", inQueueMap);
  const drainAt = at("async function drainReplyQueue(thread) {");
  const findAt = lines.findIndex((l, i) => i > drainAt && drainAt > 0 && l.includes("const i = q.findIndex((entry) => entry && entry.at === next.at);"));
  const bailAt = lines.findIndex((l, i) => i > findAt && findAt > 0 && l.includes("if (i < 0) return;"));
  ok("inspected: the drain re-reads the queue at send time and looks the entry up by identity", drainAt > 0 && findAt > drainAt && bailAt > findAt, `drain ${drainAt + 1}, lookup ${findAt + 1}, bail ${bailAt + 1}`);
  const shiftAt = at("q.shift().text");
  check("inspected: the blind shift is gone", shiftAt, -1);
  const titleAt = at("const queuedTitle = queue.map((q, i) =>");
  const queueAt = at("const queue = state.replyQueue.get(thread) || [];");
  ok("inspected: the note's title is built from the live queue, so a cancelled entry cannot appear in it", queueAt > 0 && titleAt > queueAt, `queue ${queueAt + 1}, title ${titleAt + 1}`);
  const stampAt = at("while (q.some((entry) => entry && entry.at === at)) at += 1;");
  ok("inspected: two replies queued in the same millisecond still get distinct identities", stampAt > 0, `line ${stampAt + 1}`);
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

  console.log("\n== what can only be read off public/app.js ==");
  sourceChecks();

  console.log("\n== the browser: a real click on a real × over a real card ==");
  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN  the client half of this change was not exercised in a browser.");
    note("re-run with a Playwright install, e.g. PANEL_PLAYWRIGHT_ROOT=<dir with node_modules/playwright> node tools/verify-cancel-queued-reply.mjs");
    failures += 1;
  } else {
    await browserPhase(pw);
  }

  console.log("\n== summary ==");
  console.log(`${checks} checks, ${failures} failed`);
  console.log("\nWHAT WAS DRIVEN: a panel of this checkout (or PANEL_URL) plus headless Chromium over it; the queued");
  console.log("replies held through the shipped Enter gesture and the Queue reply button; the × pressed for real (mouse");
  console.log("and keyboard); the drain fired through the panel's own end-of-turn call site (updateJob) with the reply");
  console.log("POST held open to open the race window; and every request the page would have made recorded by a stubbed");
  console.log("fetch, so no worker, run, reply or steer ever left the page.");
  console.log("WHAT WAS INSPECTED, NOT DRIVEN: that the click branch is the only caller of cancelQueuedReply, that the");
  console.log("drain looks the entry up by identity before sending, and that the note's title is built from the live queue");
  console.log("— read off public/app.js. The late-press half of (d) is driven at the handler the click branch calls: the");
  console.log("drain's own repaint replaces that × in the same turn, so the DOM press cannot reach it any more, and the");
  console.log("browser half says where that press landed instead.");
  if (!failures) console.log("CANCEL-QUEUED-REPLY-OK");
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
