#!/usr/bin/env node
// HARNESS: LIVE GATE - the agent card's own session scroller, driven in headless Chromium against a real stream.
// THE AGENT CARD'S SESSION SCROLLER, IN A REAL BROWSER, DURING A REAL STREAM.
//
//   node tools/verify-agent-card-pin.mjs                      # this checkout
//   node tools/verify-agent-card-pin.mjs --root <dir>          # serve a `git archive` of another build
//   node tools/verify-agent-card-pin.mjs --shots <dir>         # where the screenshots go (default: a temp dir)
//   node tools/verify-agent-card-pin.mjs --json <file>         # keep the raw sample ledger
//
// THE REPORT. In the agent card's docked conversation pane (the assistant rail, `.as-subpane[data-subpane="chat"]`)
// the box that scrolls is the card's own `.job-body`, not the turn console inside it: the sheet gives the console
// `max-height: none` there, so it is drawn at its content height and never overflows. Every "follow the newest line"
// path in the page (drawJobLine, paintTypedLines, stickConsole, the 400 ms sweep) measured the CONSOLE, found nothing
// to scroll, and returned. The pane grew under the reader with nothing following it: a long turn was appended below
// the fold and the only way to see it was to drag the session scroll bar down by hand.
//
// THE MECHANISM (public/board/console.js, "the card's session scroller"). `.job-body` follows its foot while the
// reader is at it - eight px, the band the pane's own pin already used - and is never touched once the reader has
// taken it. Its answer is remembered on the node from its own scroll events and consulted once per appended line, so
// no layout read is added to the per-line path. The pane's ↓ chip is drawn on the newest console in the body, because
// that is the console a reader would press for the pane.
//
// WHAT IS DRIVEN (nothing synthetic reaches the page). A throwaway panel of its own (tools/panel-testkit.mjs: spare
// port, own state directory, own scanned repo, own PANEL_CONFIG / HERMES_HOME / jobs.json - the reader's panel on
// :7331 is never started, read or written), a stub Runs API on an ephemeral port that streams a long turn - a
// reasoning stream and then a long answer - and the reader's own gestures: the assistant opened, the intro box typed
// in, Send pressed, a wheel over the pane, and a press on the pane's ↓ chip. The reasoning block is opened the way a
// reader opens it (localStorage `wtgui.think`, the Thinking switch), because a block that is not drawn cannot be
// measured.
//
// WHAT IT ASSERTS, off samples taken IN THE PAGE every 60 ms while the turn streams:
//   (1) THE PANE IS THE SCROLLER. `.job-body` overflows (scrollHeight well past clientHeight) and the console inside
//       it does not, so this is the pane's own bar the reader was dragging;
//   (2) PINNED RIDES THE GROWTH. Over at least 20 samples taken while the turn streams, `scrollHeight - scrollTop -
//       clientHeight` stays within 3 px of 0, and scrollHeight itself grew by at least 250 px across them - the
//       content moved up under a fixed viewport rather than the viewport being placed on a settled tail;
//   (3) A READER WHO SCROLLED UP IS NOT MOVED. After a real wheel over the pane, scrollTop does not change by more
//       than 1 px over the next 20+ samples, while scrollHeight keeps growing by at least 150 px;
//   (4) THE WAY BACK STILL WORKS. The pane's ↓ chip is offered while the reader is away from the foot, pressing it
//       puts the pane back on the foot, and the next streamed lines are followed again;
//   (5) no page error, and one screenshot of each state.
//
// THE FAILING-FIRST PROOF is the `--root` flag, on the rule the other gates use - the same harness, the base's own
// server.js, lib/ and public/:
//   mkdir -p "$SCRATCH/main" && git archive main | tar -x -C "$SCRATCH/main"
//   git -C "$SCRATCH/main" init -q -b main && git -C "$SCRATCH/main" add -A && git -C "$SCRATCH/main" commit -qm export
//   node tools/verify-agent-card-pin.mjs --root "$SCRATCH/main"
// main's console.js has no pin for `.job-body`, so (2) fails there while this checkout passes. The export needs its
// own one-commit repository because server.js reads `git rev-parse` at boot and dies on a bare export.
//
// Exit codes: 0 held; 1 a check failed; 2 the run did not measure what it claims (no Playwright, no pane, no stream).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { freePort, git, startPanel, waitFor } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const SHOTS = path.resolve(opt("--shots", path.join(tmpdir(), "wtgui-agent-card-pin")));
const JSON_OUT = opt("--json");
const DEBUG = argv.includes("--debug");
const VIEWPORT = { width: 1440, height: 900 };
const THREAD = "panel-assistant"; // Assistant #1's thread, the one the rail opens on
const TAIL_PX = 3; // the pin's own band is 8 px; 3 px of slack is the frame a sample can land inside a write

let checks = 0;
let failures = 0;
let measured = 0;
const out = { tree: TREE, viewport: VIEWPORT, steps: {}, samples: 0, errors: [] };
function check(ok, label, detail = "") {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
  return ok;
}
const note = (text) => console.log(`      ${text}`);

const PW = loadPlaywright();
if (!PW) {
  console.log(notRun("the agent card's session scroller", "no Playwright install found (set PANEL_PLAYWRIGHT_ROOT to a directory holding node_modules/playwright)"));
  process.exit(2);
}

// The state of the page when a wait runs out. A gate that fails must say what it saw: which boxes exist, what they
// measure, whether the stylesheet made any of them a scrollport, and what the run is doing.
async function diagnose(page, base, label) {
  console.log(`\n-- diagnosis (${label}) --`);
  try {
    const jobs = await (await fetch(`${base}/api/jobs`)).json();
    for (const j of jobs.jobs || []) {
      console.log(`   job ${j.id} thread=${j.thread} status=${j.status} exit=${j.exitCode ?? "-"}`);
      const lines = j.lines || [];
      console.log(`     ${lines.length} line(s) kept; live=${JSON.stringify(j.live || null)}`);
      for (const l of lines.slice(-6)) console.log(`     [${l.kind}] ${String(l.text || "").length} chars: ${String(l.text || "").slice(0, 60)}`);
    }
  } catch (err) {
    console.log(`   /api/jobs did not answer: ${err.message}`);
  }
  const boxes = await page.evaluate(() => {
    const pane = document.querySelector('.as-subpane[data-subpane="chat"]:not(.hidden)');
    const rows = [...document.querySelectorAll(".job-body")].map((b) => {
      const cs = getComputedStyle(b);
      return {
        job: b.closest(".job")?.dataset?.thread || "-",
        inPane: Boolean(b.closest(".as-subpane")),
        overflowY: cs.overflowY,
        sh: b.scrollHeight,
        ch: b.clientHeight,
        top: b.scrollTop,
      };
    });
    const pres = [...document.querySelectorAll(".job-body pre.job-out")].map((p) => {
      const cs = getComputedStyle(p);
      const rows = [...p.querySelectorAll(".jl")].map((r) => ({ cls: r.className, n: r.textContent.length, head: r.textContent.slice(0, 40), html: r.innerHTML.slice(0, 220) }));
      return { out: p.dataset.out || "-", overflowY: cs.overflowY, maxH: cs.maxHeight, sh: p.scrollHeight, ch: p.clientHeight, text: p.textContent.length, rows, html: p.innerHTML.length };
    });
    return {
      pane: pane ? { hidden: pane.classList.contains("hidden"), hasJob: Boolean(pane.querySelector(".job")), html: pane.innerHTML.length } : null,
      bodies: rows,
      pres,
      think: [...document.querySelectorAll(".think-body")].map((t) => ({ sh: t.scrollHeight, ch: t.clientHeight, text: t.textContent.length })),
      lines: [...document.querySelectorAll(".jl, .job-out")].length,
    };
  });
  console.log(`   pane: ${JSON.stringify(boxes.pane)}`);
  for (const b of boxes.bodies) console.log(`   .job-body[${b.job}] inPane=${b.inPane} overflowY=${b.overflowY} content=${b.sh} view=${b.ch} top=${b.top}`);
  for (const p of boxes.pres.slice(-3)) {
    console.log(`   pre[${p.out}] overflowY=${p.overflowY} maxH=${p.maxH} content=${p.sh} view=${p.ch} chars=${p.text} html=${p.html}`);
    for (const r of p.rows.slice(-6)) console.log(`     row .${r.cls} ${r.n} chars: ${r.head}
       html ${r.html}`);
  }
  for (const t of boxes.think.slice(-2)) console.log(`   .think-body content=${t.sh} view=${t.ch} chars=${t.text}`);
  console.log(`   ${boxes.lines} console rows in the document`);
  if (panel) console.log(`   panel log tail:\n${panel.log().split("\n").slice(-14).join("\n")}`);
  await page.screenshot({ path: path.join(SHOTS, `diagnosis-${label.replace(/\W+/g, "-")}.png`) }).catch(() => {});
}

mkdirSync(SHOTS, { recursive: true });
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-agent-card-pin-"));
const repos = path.join(dir, "repos");
const repo = path.join(repos, "pin-sandbox-repo");
for (const d of [repo, path.join(repo, ".worktrees"), path.join(dir, "hermes-home")]) mkdirSync(d, { recursive: true });
git(repo, "init", "-q", "-b", "main");
writeFileSync(path.join(repo, "README.md"), "# the sandbox repo, for the agent card's session scroller\n", "utf8");
git(repo, "add", ".");
git(repo, "commit", "-q", "-m", "first");

// ---- the stub Runs API -------------------------------------------------------------------------------------------
// The gateway's shape, with the one power this gate needs: a turn that is still streaming when the assertions are
// taken. Its stream is a long one on purpose - a reasoning stream, then a long answer - because that is the turn the
// report was about.
const REASONING_FRAMES = 40;
const ANSWER_FRAMES = 220;
const REASONING_MS = 45;
const ANSWER_MS = 85;

function makeStub() {
  const seen = { submitted: [], events: 0 };
  const streams = new Map();
  const json = (code, body, res) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  const readBody = (req) =>
    new Promise((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          resolve(JSON.parse(raw || "{}"));
        } catch {
          resolve({});
        }
      });
    });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/v1/capabilities") {
      return json(200, { version: "agent-card-pin-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true } }, res);
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      const body = await readBody(req);
      seen.submitted.push(body);
      return json(200, { run_id: `pin-run-${seen.submitted.length}`, status: "running" }, res);
    }
    const one = /^\/v1\/runs\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
    if (one) {
      const id = decodeURIComponent(one[1]);
      const sub = one[2] || "";
      if (sub === "/steer") {
        await readBody(req);
        return json(200, { accepted: true, run_id: id }, res);
      }
      if (sub === "/stop") return json(200, { ok: true }, res);
      if (sub === "/events") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.write(": attached\n\n");
        const state = { res, seq: 0, timers: [], done: false };
        streams.set(id, state);
        // Every frame is the panel's own wire shape: `id:` plus one JSON `data:` line, which lib/jobs.js reads.
        const frame = (evt) => {
          state.seq += 1;
          seen.events += 1;
          if (DEBUG) console.log(`      stub -> ${evt.event} #${state.seq} ${String(evt.delta || "").length} chars`);
          res.write(`id: ${state.seq}\ndata: ${JSON.stringify({ ...evt, seq: state.seq })}\n\n`);
        };
        state.frame = frame;
        // The turn: reasoning first (drawn in the 🧠 block, which scrolls itself), then a long answer streamed into the
        // console (which is what grows the pane - `.job-out` is `max-height: none` there).
        const reasoning = [
          "Looking at the panel's scroll plumbing first: which box actually moves in the docked pane.",
          "The console cannot scroll in the chat subpane, so the card body is the scrollport.",
          "Sampling the pane while the turn streams is the only honest instrument here.",
          "Checking the reader's own scroll before any write, so a reader parked mid-read is left alone.",
        ];
        const answer = [
          "The pane's scroller is the card's own body, not the turn console inside it. ",
          "In the docked Chat pane the sheet draws every console at its content height, so the console has no tail ",
          "of its own to follow and the body is the box the reader is actually reading. ",
          "A pin for the body therefore has to ride the body's own scrollHeight growth, and it has to let go the ",
          "moment the reader takes the box over, or it fights them. ",
        ];
        let r = 0;
        let a = 0;
        const step = () => {
          if (state.done) return;
          if (r < REASONING_FRAMES) {
            const text = `${reasoning[r % reasoning.length]} (${r + 1}/${REASONING_FRAMES})\n`;
            r += 1;
            frame({ event: "reasoning.delta", delta: text });
            state.timers.push(setTimeout(step, REASONING_MS));
            return;
          }
          if (a < ANSWER_FRAMES) {
            // A fragment that wraps: the answer is one growing paragraph, exactly what a streamed reply looks like.
            const chunk = `${answer[a % answer.length]}(line ${a + 1} of ${ANSWER_FRAMES}) `;
            a += 1;
            frame({ event: "message.delta", delta: chunk });
            state.timers.push(setTimeout(step, ANSWER_MS));
            return;
          }
          // The turn stays OPEN here on purpose: the reader's own samples are taken while it is still streaming.
        };
        state.timers.push(setTimeout(step, 120));
        req.on("close", () => {
          for (const t of state.timers) clearTimeout(t);
          state.timers = [];
        });
        return;
      }
      return json(200, { run_id: id, status: "running", output: "" }, res);
    }
    return json(404, { error: { message: "not found" } }, res);
  });
  return {
    seen,
    server,
    // The rest of the turn: the last of the answer, then the run's own end, so the card settles after the assertions.
    finish(id) {
      const state = streams.get(id);
      if (!state) return false;
      state.done = true;
      for (const t of state.timers) clearTimeout(t);
      state.timers = [];
      state.frame({ event: "message.delta", delta: "\n\nThat is the whole of it: the pane follows its own foot.\n" });
      state.frame({ event: "run.completed", output: "", usage: {}, exit_code: 0 });
      state.res.end();
      return true;
    },
    close: () =>
      new Promise((resolve) => {
        for (const s of streams.values()) {
          for (const t of s.timers) clearTimeout(t);
          s.res.end();
        }
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// ---- boot: the sandbox, its stub, and the panel ---------------------------------------------------------------
let panel = null;
let stub = null;
const summaries = [];
let browserErrors = [];

try {
  stub = makeStub();
  await new Promise((r) => stub.server.listen(0, "127.0.0.1", r));
  const stubUrl = `http://127.0.0.1:${stub.server.address().port}`;

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  check(port !== 7331, "the sandbox port is the panel's own, not 7331", `port ${port}`);

  panel = await startPanel({
    dir,
    port,
    root: TREE,
    config: {
      refreshSeconds: 3600,
      worktreeSeconds: 3600,
      midSeconds: 3600,
      dormantSeconds: 3600,
      slowSeconds: 3600,
      fetchSeconds: 3600,
      scanMode: "all",
      threads: 1,
      defaultCwd: repo,
      apiServer: { url: stubUrl, key: "sandbox-key" },
      assistant: { enabled: true, autonomy: "draft", seconds: 120, maxWakesPerHour: 20 },
    },
  });
  check(true, `the sandbox panel answers on its own port (${base})`);
  note(`tree ${TREE}`);
  note(`temp root ${dir}`);

  // The page's state: the assistant rail OPEN and DOCKED (the side panel the report names), the thinking block drawn
  // the way the reader's Thinking switch draws it, and the board's own folds left alone.
  const seed = () => {
    localStorage.setItem("wm.assistantOpen", "true");
    localStorage.setItem("wtgui.think", "1");
    localStorage.setItem("wtgui.streamWords", "0");
  };

  await withBrowser(
    async ({ page, pageErrors, consoleErrors }) => {
      await openPage(page, base, { selector: "body" });
      await page.waitForTimeout(1500);
      await page.click("#btn-assistant");
      await page.waitForSelector("#assistant:not([hidden])", { timeout: 15_000 });
      await page.waitForTimeout(700);

      // ---- 0. the pane the report is about ------------------------------------------------------------------
      const frame = await page.evaluate(() => {
        const el = document.getElementById("assistant");
        const r = el.getBoundingClientRect();
        const main = document.querySelector("main")?.getBoundingClientRect();
        const chat = document.querySelector('.as-subpane[data-subpane="chat"]:not(.hidden)');
        return {
          floating: el.classList.contains("is-floating"),
          railLeft: Math.round(r.left),
          railWidth: Math.round(r.width),
          mainRight: main ? Math.round(main.right) : null,
          chat: Boolean(chat),
          viewport: { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight },
        };
      });
      check(!frame.floating, "the assistant is attached as the side panel, not floating", `is-floating=${frame.floating}`);
      check(frame.railLeft >= (frame.mainRight ?? 0) - 2, "the rail sits beside the board, on the right", `rail left ${frame.railLeft}, board right ${frame.mainRight}`);
      check(frame.viewport.w === VIEWPORT.width && frame.viewport.h === VIEWPORT.height, "the window is 1440x900", `${frame.viewport.w}x${frame.viewport.h}`);
      check(frame.chat, "the assistant's Chat pane is on screen");

      // ---- 1. send a prompt that produces a long streamed turn ----------------------------------------------
      await page.click("#as-first-text");
      await page.keyboard.type("walk through the panel's scroll plumbing and tell me exactly which box moves");
      await page.click("#btn-as-first");
      const job = await waitFor(
        async () => {
          const r = await fetch(`${base}/api/jobs`);
          const d = await r.json().catch(() => ({}));
          return (d.jobs || []).find((j) => j.thread === THREAD) || null;
        },
        { what: "a job on the assistant's thread", timeoutMs: 25_000 },
      );
      check(Boolean(job), "pressing Send starts a run on the assistant's own thread", job ? `${job.id} ${job.status}` : "no job");

      // The sampler reads the pane the reader reads, every 60 ms, in the page: a Node-side poll would sample the
      // driver's own latency, not the pane.
      await page.evaluate(() => {
        const paneOf = () => document.querySelector('.as-subpane[data-subpane="chat"]:not(.hidden) > .job > .job-body');
        window.__pinPhase = "pinned";
        window.__pin = [];
        window.__pinTimer = setInterval(() => {
          const b = paneOf();
          if (!b) return;
          const pre = b.querySelector("pre.job-out");
          window.__pin.push({
            phase: window.__pinPhase,
            t: Date.now(),
            top: b.scrollTop,
            ch: b.clientHeight,
            sh: b.scrollHeight,
            preSh: pre ? pre.scrollHeight : 0,
            preCh: pre ? pre.clientHeight : 0,
            preOverflow: pre ? pre.scrollHeight - pre.clientHeight : 0,
          });
        }, 60);
      });

      // Wait for the pane to overflow, then let it stream for a while with the reader on the foot.
      try {
        await page.waitForFunction(
          () => {
            const b = document.querySelector('.as-subpane[data-subpane="chat"]:not(.hidden) > .job > .job-body');
            return b && b.scrollHeight - b.clientHeight > 240;
          },
          null,
          { timeout: 40_000 },
        );
      } catch {
        await diagnose(page, base, "the pane never overflowed");
        throw new Error("the pane did not overflow within 40 s: no long stream reached it (see the diagnosis above)");
      }
      await page.waitForTimeout(4500);
      const pinned = await page.evaluate(() => window.__pin.filter((s) => s.phase === "pinned"));
      out.steps.pinned = pinned.length;
      out.samples += pinned.length;
      const over = pinned.filter((s) => s.sh - s.ch > 240);
      const gaps = over.map((s) => s.sh - s.top - s.ch);
      const grew = over.length ? over[over.length - 1].sh - over[0].sh : 0;
      const worst = gaps.length ? Math.max(...gaps) : null;
      const preGap = over.length ? Math.max(...over.map((s) => s.preOverflow)) : null;

      check(over.length >= 20, "the pane was sampled at least 20 times while it overflowed", `${over.length} samples`);
      check(
        preGap !== null && preGap <= 4,
        "the console inside the pane does not scroll: this is the session scroller's own bar",
        `console overflow ${preGap} px`,
      );
      check(grew >= 250, "the stream grew the pane by at least 250 px across those samples", `grew ${grew} px`);
      check(
        worst !== null && worst <= TAIL_PX,
        "PINNED: every sample is on the pane's foot (scrollTop + clientHeight within 3 px of scrollHeight)",
        `worst gap ${worst} px over ${over.length} samples`,
      );
      if (over.length) {
        note(`pane ${over[0].ch} px tall, content ${over[0].sh} -> ${over[over.length - 1].sh} px`);
      }
      await page.screenshot({ path: path.join(SHOTS, "1-pinned.png") });

      // ---- 2. the reader scrolls up: the pane must stop following --------------------------------------------
      const box = await page.evaluate(() => {
        const b = document.querySelector('.as-subpane[data-subpane="chat"]:not(.hidden) > .job > .job-body');
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.bottom - 130) };
      });
      await page.mouse.move(box.x, box.y);
      await page.mouse.wheel(0, -520);
      // The phase starts AFTER the gesture has landed: a sample taken mid-wheel would count the reader's own 520 px
      // as the panel moving them, which is the one thing this check exists to tell apart.
      await page.waitForTimeout(450);
      await page.evaluate(() => {
        window.__pinPhase = "scrolled";
      });
      await page.waitForTimeout(4200);
      const scrolled = await page.evaluate(() => window.__pin.filter((s) => s.phase === "scrolled"));
      out.steps.scrolled = scrolled.length;
      out.samples += scrolled.length;
      const tops = scrolled.map((s) => s.top);
      const moved = tops.length ? Math.max(...tops) - Math.min(...tops) : null;
      const scrolledGrew = scrolled.length ? scrolled[scrolled.length - 1].sh - scrolled[0].sh : 0;
      const scrolledGap = scrolled.length ? scrolled[scrolled.length - 1].sh - scrolled[scrolled.length - 1].top - scrolled[scrolled.length - 1].ch : null;
      check(scrolled.length >= 20, "the pane kept being sampled after the wheel", `${scrolled.length} samples`);
      check(scrolledGap !== null && scrolledGap > 40, "the reader is away from the foot", `gap ${scrolledGap} px`);
      check(
        moved !== null && moved <= 1,
        "A READER WHO SCROLLED UP IS NOT MOVED: scrollTop does not shift while the turn keeps streaming",
        `moved ${moved} px over ${scrolled.length} samples`,
      );
      check(scrolledGrew >= 150, "and the pane kept growing underneath them", `grew ${scrolledGrew} px`);

      // ---- 3. the way back: the pane's ↓ chip ---------------------------------------------------------------
      const chip = await page.evaluate(() => {
        const wraps = [...document.querySelectorAll('.as-subpane[data-subpane="chat"]:not(.hidden) > .job > .job-body .out-wrap')];
        const offered = wraps.filter((w) => !w.classList.contains("is-at-end"));
        return {
          wraps: wraps.length,
          offered: offered.length,
          visible: offered.length ? getComputedStyle(offered[0].querySelector(".to-bottom")).pointerEvents : null,
        };
      });
      check(chip.offered === 1, "the pane offers exactly one ↓ chip, on the newest console", `${chip.offered} of ${chip.wraps} wraps`);
      check(chip.visible !== "none", "the chip takes the press", `pointer-events ${chip.visible}`);
      await page.screenshot({ path: path.join(SHOTS, "2-scrolled-up.png") });

      // The press is a real one, at the chip's own coordinates: a locator click would scroll the chip into view first,
      // and the box it is inside is the very thing under test.
      const at = await page.evaluate(() => {
        const wraps = [...document.querySelectorAll('.as-subpane[data-subpane="chat"]:not(.hidden) > .job > .job-body .out-wrap')];
        const chip = wraps.find((w) => !w.classList.contains("is-at-end"))?.querySelector(".to-bottom");
        const body = document.querySelector('.as-subpane[data-subpane="chat"]:not(.hidden) > .job > .job-body');
        if (!chip || !body) return null;
        const r = chip.getBoundingClientRect();
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + r.height / 2);
        // A chip the reader cannot hit is not an affordance: ask the page what is under the pointer before pressing.
        const hit = document.elementFromPoint(x, y);
        window.__pressSeen = 0;
        document.addEventListener("click", (e) => { if (e.target.closest?.("[data-to-bottom]")) window.__pressSeen += 1; }, true);
        const pane = body.getBoundingClientRect();
        return {
          x,
          y,
          before: body.scrollTop,
          gap: body.scrollHeight - body.scrollTop - body.clientHeight,
          hit: hit === chip || chip.contains(hit),
          under: hit ? `${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ""}.${String(hit.className || "").split(" ")[0]}` : "nothing",
          inPane: y > Math.round(pane.top) && y < Math.round(pane.bottom),
        };
      });
      check(Boolean(at) && at.hit, "a reader can hit the chip where it is drawn", at ? `${at.under} at ${at.x},${at.y}${at.inPane ? "" : " (outside the pane)"}` : "no chip");
      await page.evaluate(() => {
        window.__pinPhase = "back";
      });
      if (!at) {
        check(false, "THE WAY BACK: the press jumps the session scroller to its foot", "no chip was offered, so there was nothing to press");
      } else {
        await page.mouse.click(at.x, at.y);
        await page.waitForTimeout(150);
        const pressed = await page.evaluate(() => {
          const body = document.querySelector('.as-subpane[data-subpane="chat"]:not(.hidden) > .job > .job-body');
          return { seen: window.__pressSeen, top: body ? body.scrollTop : null };
        });
        check(pressed.seen === 1, "the press reached the page's to-the-newest handler", `${pressed.seen} press(es) seen`);
        check(
          pressed.top !== null && at.gap > 40 && pressed.top - at.before > 40,
          "THE WAY BACK: the press jumps the session scroller to its foot",
          `gap ${at.gap} px -> scrollTop ${at.before} -> ${pressed.top}`,
        );
      }
      await page.waitForTimeout(3600);
      const back = await page.evaluate(() => window.__pin.filter((s) => s.phase === "back"));
      out.steps.back = back.length;
      out.samples += back.length;
      const backOver = back.filter((s) => s.sh - s.ch > 240);
      const backWorst = backOver.length ? Math.max(...backOver.map((s) => s.sh - s.top - s.ch)) : null;
      const backGrew = backOver.length ? backOver[backOver.length - 1].sh - backOver[0].sh : 0;
      check(backOver.length >= 8, "the pane was sampled after the press", `${backOver.length} samples`);
      check(backWorst !== null && backWorst <= TAIL_PX, "and it is pinned again: every later sample is on its foot", `worst gap ${backWorst} px`);
      check(backGrew >= 150, "while the lines that arrived after it were followed", `grew ${backGrew} px after the press`);
      await page.screenshot({ path: path.join(SHOTS, "3-back-on-the-foot.png") });

      // ---- 4. the turn ends, and nothing threw ---------------------------------------------------------------
      stub.finish(`pin-run-1`);
      await page.waitForTimeout(1200);
      const settled = await page.evaluate(() => {
        const b = document.querySelector('.as-subpane[data-subpane="chat"]:not(.hidden) > .job > .job-body');
        return { gap: b ? b.scrollHeight - b.scrollTop - b.clientHeight : null };
      });
      check(settled.gap !== null && settled.gap <= 8, "the settled card is still on the pane's foot", `gap ${settled.gap} px`);
      browserErrors = [...pageErrors];
      check(pageErrors.length === 0, "no page error", pageErrors.join(" | "));
      check(consoleErrors.filter((e) => !/favicon/i.test(e)).length === 0, "no console error", consoleErrors.join(" | "));

      // The sampler is a harness instrument: it must not outlive the run.
      await page.evaluate(() => clearInterval(window.__pinTimer));
    },
    { viewport: VIEWPORT, initScript: seed },
  );

  summaries.push(`the pane's own scroller (${THREAD}) followed a live stream and stopped when the reader scrolled up`);
  summaries.push(`screenshots: ${SHOTS}`);
} catch (err) {
  failures += 1;
  out.errors.push(String((err && err.stack) || err));
  console.log(`FAIL  the run threw: ${String((err && err.message) || err)}`);
} finally {
  try {
    if (stub) await stub.close();
  } catch {
    /* the stub is going away either way */
  }
  try {
    if (panel) await panel.stop();
  } catch {
    /* and so is the panel */
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

out.checks = checks;
out.failures = failures;
if (JSON_OUT) writeFileSync(path.resolve(JSON_OUT), `${JSON.stringify(out, null, 2)}\n`, "utf8");

console.log("\n== what this run proved ==");
for (const s of summaries) console.log(`  - ${s}`);
console.log(`  - ${checks - failures}/${checks} checks held; ${out.samples} pane samples taken in the page at 1440x900`);
if (browserErrors.length) console.log(`  - page errors: ${browserErrors.join(" | ")}`);
if (!checks) {
  console.log("\nNOT MEASURED: no check ran.");
  process.exit(2);
}
process.exit(failures ? 1 : 0);
