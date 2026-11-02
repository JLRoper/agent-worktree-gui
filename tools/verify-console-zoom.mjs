// Does ONE font size drive the console's normal output, its reasoning and a tool's output — and does Ctrl+wheel move
// all three together, per card? Read off a real page.
//
//   node tools/verify-console-zoom.mjs                  # 🌊 one-stream console and the 🧠 block, headless (~60 s)
//   node tools/verify-console-zoom.mjs --mode stream    # the 🌊 console only
//   node tools/verify-console-zoom.mjs --mode think     # the 🧠 block above a condensed console only
//   node tools/verify-console-zoom.mjs --headed         # watch it
//   node tools/verify-console-zoom.mjs --keep           # leave the sandbox behind for inspection
//
// WHAT THIS ANSWERS
//   The console draws three kinds of text — the agent's own words, a tool's output, and its reasoning (the 🧠 block, or
//   the reasoning lines of the 🌊 stream) — and there is ONE size for all of them. This measures what the page really
//   computes, and what the gesture really does:
//
//     1. at the default, the three computed sizes are the SAME (11.5px), and so are the two cards' on a board with
//        two of them;
//     2. Ctrl+wheel over the CONSOLE moves all three by the same half-pixel step, together;
//     3. Ctrl+wheel over the REASONING moves the console and the tool output too — the gesture is not scoped to the
//        kind of text the pointer happens to be over;
//     4. Ctrl+wheel over a TOOL'S OUTPUT does the same, and wheel-down steps all three back down;
//     5. the card REPAINTED keeps its zoom (the card re-emits it), and the OTHER card is untouched by it;
//     6. Settings' Console size still moves all three on every card that has not been zoomed — and a zoomed card
//        keeps its own size, because a zoom is that card's override of the one baseline;
//     7. after a reload the cards are back on the stored Console size — a Ctrl+wheel zoom is in memory, as it always
//        was (documented in docs/console-expand.md §6), and the size that DOES persist is the one Settings keeps.
//
//   The unit test (test/text-styles.test.js) proves the stylesheet resolves all three selectors to `--term-size`; this
//   proves the variable reaches them on a live card and that one gesture writes it once.
//
// WHAT IT DRIVES
//   a sandbox panel of its own (tools/panel-testkit.mjs) and a stub Runs API that plays the same fixed script over
//   real SSE for two sessions at once: a thought, a terminal call with output, prose. Pacing is off (words/s 0) so the
//   rows are whole the moment they arrive. The wheel is a real Ctrl+wheel through CDP where the page takes it; where
//   it does not reach (headless occasionally drops the modifier), the same WheelEvent is dispatched at the element and
//   the line says which path ran.
//
// EXIT CODES
//   0  every check held (or Playwright is not installed: SKIP)   1  a check failed   2  the run did not drive what it measures
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { loadPlaywright, openSettingsGroup } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const MODE = opt("--mode", "both");
const HEADED = argv.includes("--headed");
const KEEP = argv.includes("--keep");
if (!["stream", "think", "both"].includes(MODE)) {
  console.log(`--mode must be stream, think or both, not ${MODE}`);
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const A = "probe-zoom-a"; // the card the wheel is driven on
const B = "probe-zoom-b"; // the card that must not move
const THREADS = [A, B];
const DEFAULT_SIZE = 11.5;
const SETTINGS_SIZE = 13;
const STEP = 1; // one wheel notch = 1px, and half-pixel rounding keeps 11.5 → 12.5 rather than jumping 1.5

// ---- the turn ------------------------------------------------------------------------------------------------
const STEPS = [
  { at: 300, think: "First thought: the task names a PDF, so I should load the pdf skill before touching it." },
  { at: 900, tool: "terminal", preview: "ls", result: "a.pdf\nb.pdf" },
  { at: 2400, text: "Both files are there." },
];
const END_AT = 3200;

function seedStore(dir) {
  mkdirSync(path.join(dir, "hermes"), { recursive: true });
  const db = new DatabaseSync(path.join(dir, "hermes", "state.db"));
  db.exec(`
    create table if not exists sessions (id text primary key, source text not null, started_at real not null,
      model text, cwd text, title text, message_count integer default 0);
    create table if not exists messages (id integer primary key autoincrement, session_id text not null, role text not null,
      content text, timestamp real not null, reasoning text, reasoning_content text, tool_name text, tool_call_id text,
      token_count integer, finish_reason text);
  `);
  for (const thread of THREADS) {
    db.prepare("insert or replace into sessions (id, source, started_at, model, cwd, title) values (?,?,?,?,?,?)").run(thread, "probe", Date.now() / 1000, "probe/model", ROOT, "console zoom probe");
  }
  db.close();
}

function makeGateway(dir) {
  // The panel POSTs one run per agent, in spawn order, so the n-th run belongs to the n-th thread: each run seeds
  // only its own session's reasoning, or both cards would receive both thoughts twice.
  const state = { runs: new Map(), posts: 0 };
  const timers = new Set();
  const later = (ms, fn) => {
    const h = setTimeout(() => {
      timers.delete(h);
      fn();
    }, Math.max(0, ms));
    timers.add(h);
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (code, body) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/v1/capabilities") {
      return json(200, { version: "console-zoom-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true } });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        state.posts += 1;
        const id = `run_zoom_${state.posts}`;
        const thread = THREADS[(state.posts - 1) % THREADS.length];
        state.runs.set(id, { id, thread, status: "running", output: "", startedAt: null });
        json(200, { run_id: id, status: "running" });
      });
      return;
    }
    const one = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (one && req.method === "GET") {
      const rec = state.runs.get(one[1]);
      if (!rec) return json(404, { error: { message: "Run not found", code: "run_not_found" } });
      return json(200, { run_id: rec.id, status: rec.status, output: rec.output, usage: { total_tokens: 900, input_tokens: 800, output_tokens: 100 } });
    }
    const ev = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (ev && req.method === "GET") {
      const rec = state.runs.get(ev[1]);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      if (!rec) return res.end();
      res.write(": open\n\n");
      if (rec.startedAt != null) return;
      rec.startedAt = Date.now();
      let open = true;
      req.on("close", () => {
        open = false;
      });
      let seq = 0;
      const send = (evt) => {
        if (!open) return;
        res.write(`id: ${seq}\ndata: ${JSON.stringify({ ...evt, run_id: rec.id, seq, timestamp: Date.now() / 1000 })}\n\n`);
        seq += 1;
      };
      for (const s of STEPS) {
        later(s.at, () => {
          if (s.think) {
            const db = new DatabaseSync(path.join(dir, "hermes", "state.db"));
            db.prepare("insert into messages (session_id, role, content, timestamp, reasoning_content) values (?,?,?,?,?)").run(rec.thread, "assistant", "…", Date.now() / 1000, s.think);
            db.close();
          }
          if (s.text) send({ event: "message.delta", delta: `\n\n${s.text}` });
          if (s.tool) {
            later(60, () => {
              send({ event: "tool.started", tool: s.tool, preview: s.preview });
              later(300, () => send({ event: "tool.completed", tool: s.tool, duration: 0.3, error: false, preview: s.result }));
            });
          }
        });
      }
      later(END_AT, () => {
        rec.status = "completed";
        rec.output = "done";
        send({ event: "run.completed", output: "done", usage: { total_tokens: 900, input_tokens: 800, output_tokens: 100 } });
        later(50, () => res.end());
      });
      return;
    }
    json(404, {});
  });
  return {
    listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))),
    close: () =>
      new Promise((r) => {
        for (const h of timers) clearTimeout(h);
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

function git(args, cwd) {
  return execFileSync("git", ["-c", "user.name=probe", "-c", "user.email=probe@localhost", ...args], { cwd, stdio: "pipe", encoding: "utf8" });
}

// ---- reading the page ----------------------------------------------------------------------------------------
// Everything for both cards is read in ONE evaluate, so a card cannot be repainted between two measurements.
function readSizes([a, b]) {
  const px = (el) => (el ? Math.round(parseFloat(getComputedStyle(el).fontSize) * 100) / 100 : null);
  const read = (thread) => {
    const card = document.querySelector(`.job[data-thread="${thread}"]`);
    if (!card) return { ok: false };
    const con = card.querySelector("pre.job-out");
    // Reasoning is the 🌊 stream's reasoning line, or the 🧠 block's own line: whichever this board drew.
    const reasoning = card.querySelector("pre.job-out .jl-think, .think-body .think-block");
    const tool = card.querySelector("pre.job-out .jl-tool-out");
    const prose = con ? con.querySelector(".jl-text") : null;
    return {
      ok: Boolean(con && reasoning && tool && prose),
      normal: px(prose || con),
      reasoning: px(reasoning),
      tool: px(tool),
      console: px(con),
      cardVar: card.style.getPropertyValue("--term-size") || null,
      reasoningNode: reasoning ? (reasoning.closest(".think-body") ? "🧠 block" : "🌊 stream") : null,
    };
  };
  return { a: read(a), b: read(b), rootVar: document.documentElement.style.getPropertyValue("--term-size") || null };
}

const selectorFor = (thread, what, mode) => {
  const card = `.job[data-thread="${thread}"]`;
  if (what === "console") return `${card} pre.job-out`;
  if (what === "tool") return `${card} pre.job-out .jl-tool-out`;
  return mode === "think" ? `${card} .think-body .think-block` : `${card} pre.job-out .jl-think`;
};

// The reader's gesture, through CDP: hover the text, hold Ctrl, one wheel notch. Playwright forwards the held
// modifier with the wheel, and the page's own capture listener is what answers. A headless run occasionally drops it,
// so the caller checks whether anything moved and falls back to the same WheelEvent on the element.
async function wheelAt(page, selector, dy) {
  const el = page.locator(selector).first();
  await el.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
  await el.hover({ timeout: 4000 }).catch(() => {});
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, dy);
  await page.keyboard.up("Control");
  await sleep(320);
}

async function ctrlWheel(page, { thread, what, mode, dy, before }) {
  const selector = selectorFor(thread, what, mode);
  await wheelAt(page, selector, dy);
  let after = await page.evaluate(readSizes, THREADS);
  let gesture = "real";
  if (after.a.console === before.a.console && after.b.console === before.b.console) {
    gesture = "dispatched";
    await page.evaluate(
      ([sel, delta]) => {
        const el = document.querySelector(sel);
        el.dispatchEvent(new WheelEvent("wheel", { deltaY: delta, ctrlKey: true, bubbles: true, cancelable: true }));
      },
      [selector, dy],
    );
    await sleep(260);
    after = await page.evaluate(readSizes, THREADS);
  }
  return { after, gesture, selector };
}

// Open the folded result boxes (and the 🧠 block) so the pointer has something visible to sit on. Opening is the
// reader's own gesture and changes no size.
async function openRows(page, thread, mode) {
  await page.evaluate(
    ([th, m]) => {
      const card = document.querySelector(`.job[data-thread="${th}"]`);
      if (!card) return;
      for (const box of card.querySelectorAll(".code-box")) {
        if (!box.classList.contains("is-open")) box.querySelector(".code-head")?.click();
      }
      if (m === "think") {
        const d = card.querySelector("details.think");
        if (d && !d.open) d.querySelector("summary")?.click();
      }
    },
    [thread, mode],
  );
  await sleep(350);
}

async function runMode(ctx, work, mode) {
  const dir = path.join(work, mode);
  const repo = path.join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  mkdirSync(path.join(dir, "empty-root"), { recursive: true });
  git(["init", "-q", "-b", "main"], repo);
  writeFileSync(path.join(repo, "README.md"), "# probe repo\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "first"], repo);
  seedStore(dir);
  const gw = makeGateway(dir);
  const gwPort = await gw.listen();
  const sandbox = await startPanel({
    dir,
    keep: KEEP,
    config: {
      scanRoots: [path.join(dir, "empty-root")],
      refreshSeconds: 3600,
      fetchSeconds: -1,
      assistant: { enabled: false },
      remoteBranchPolicy: "local-only",
      defaultCwd: repo,
      apiServer: { url: `http://127.0.0.1:${gwPort}`, key: "probe" },
    },
    env: { API_SERVER_KEY: "" },
  });
  const errors = [];
  const shotDir = path.join(work, "shots");
  mkdirSync(shotDir, { recursive: true });
  const out = { mode, shots: [], steps: [] };
  try {
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(String((e && e.message) || e)));
    await page.addInitScript(
      ({ threads, m }) => {
        if (sessionStorage.getItem("__init")) return; // a reload must show what the reader chose
        sessionStorage.setItem("__init", "1");
        localStorage.setItem("wtgui.autoCollect", "0");
        localStorage.setItem("wtgui.think", "1");
        localStorage.setItem("wtgui.streamWords", "0");
        localStorage.setItem("wtgui.streamLines", "0");
        for (const t of threads) {
          localStorage.setItem(`wtgui.think.${t}`, "1");
          if (m === "stream") localStorage.setItem(`wtgui.stream.${t}`, "1");
        }
      },
      { threads: THREADS, mode },
    );
    await page.goto(sandbox.base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state.jobs, null, { timeout: 30000 });
    for (const thread of THREADS) {
      const spawned = await fetch(`${sandbox.base}/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "probe: think, call a tool, then answer", cwd: repo, existing: true, thread }),
      }).then((r) => r.json());
      if (!spawned || !spawned.job) throw new Error(`spawn failed for ${thread}: ${JSON.stringify(spawned)}`);
    }
    for (const thread of THREADS) await page.waitForSelector(`.job[data-thread="${thread}"] pre.job-out`, { timeout: 20000 });
    await sleep(END_AT + 3000); // both turns are over and every row is whole

    await page.evaluate((th) => document.querySelector(`.job[data-thread="${th}"]`)?.scrollIntoView({ block: "center" }), A);
    await openRows(page, A, mode);
    out.baseline = await page.evaluate(readSizes, THREADS);
    out.shots.push(path.join(shotDir, `${mode}-1-defaults.png`));
    await page.screenshot({ path: out.shots.at(-1) });

    // ---- the gesture, over each kind of text ---------------------------------------------------------------
    const step = async (what, dy) => {
      const before = await page.evaluate(readSizes, THREADS);
      const run = await ctrlWheel(page, { thread: A, what, mode, dy, before });
      out.steps.push({ what, dy, gesture: run.gesture, selector: run.selector, before, after: run.after });
      return run.after;
    };
    out.afterConsole = await step("console", -120);
    out.shots.push(path.join(shotDir, `${mode}-2-console-wheel.png`));
    await page.screenshot({ path: out.shots.at(-1) });
    out.afterReasoning = await step("reasoning", -120);
    out.shots.push(path.join(shotDir, `${mode}-3-reasoning-wheel.png`));
    await page.screenshot({ path: out.shots.at(-1) });
    out.afterTool = await step("tool", -120);
    out.afterDown = await step("reasoning", 120);

    // ---- a repaint carries the zoom, and the other card is untouched ---------------------------------------
    await page.evaluate(() => {
      state.jobsListSig = "";
      renderJobs();
    });
    await sleep(400);
    out.repainted = await page.evaluate(readSizes, THREADS);

    // ---- Settings' Console size: the one baseline, for every card that has not been zoomed ------------------
    await openSettingsGroup(page, "display");
    await page.waitForSelector("#term-size-select", { state: "visible" });
    await page.selectOption("#term-size-select", String(SETTINGS_SIZE));
    out.panel = await page.evaluate(() => ({
      consoleSize: document.getElementById("term-size-select").value,
      hasThinkSize: Boolean(document.getElementById("think-size-select")),
      previews: ["think", "skill", "console"].map((k) => {
        const s = getComputedStyle(document.getElementById(`${k}-preview`));
        return { k, size: s.fontSize };
      }),
    }));
    await page.click("#btn-settings-close").catch(() => {});
    await sleep(300);
    out.sized = await page.evaluate(readSizes, THREADS);
    out.shots.push(path.join(shotDir, `${mode}-4-settings-size.png`));
    await page.screenshot({ path: out.shots.at(-1) });

    // ---- a reload: the stored size is what comes back -------------------------------------------------------
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state.jobs, null, { timeout: 30000 });
    for (const thread of THREADS) await page.waitForSelector(`.job[data-thread="${thread}"] pre.job-out`, { timeout: 20000 });
    await sleep(2500);
    await openRows(page, A, mode);
    out.reloaded = await page.evaluate(readSizes, THREADS);
    out.errors = errors;
    return out;
  } finally {
    await gw.close().catch(() => {});
    await sandbox.stop().catch(() => {});
  }
}

// ---- the verdicts --------------------------------------------------------------------------------------------
const same = (v, want) => v === want;
const three = (s) => [s.normal, s.reasoning, s.tool];
const allThree = (s, want) => s.ok && three(s).every((v) => same(v, want));
const fmt = (s) => (s && s.ok ? `normal ${s.normal} · reasoning ${s.reasoning} · tool ${s.tool}` : `not found (${JSON.stringify(s)})`);

function judge(cap) {
  const checks = [];
  const add = (name, got, want, ok) => checks.push({ name, got, want, ok });
  const { baseline: b, afterConsole: c, afterReasoning: r, afterTool: t, afterDown: d, repainted: p, sized: s, reloaded: l } = cap;
  const driven =
    [b, c, r, t, d, p, s, l].every((x) => x && x.a && x.b) &&
    b.a.ok &&
    b.b.ok &&
    THREE_KINDS_present(b.a) &&
    b.a.normal === DEFAULT_SIZE;
  if (!driven) return { checks, driven: false };

  // 1. one size, at the default
  add("default: the three computed sizes are the same", fmt(b.a), `${DEFAULT_SIZE} everywhere`, allThree(b.a, DEFAULT_SIZE));
  add("default: the second card is the same size", fmt(b.b), `${DEFAULT_SIZE} everywhere`, allThree(b.b, DEFAULT_SIZE));

  // 2. the wheel over the console
  add("wheel over the console moves all three together", fmt(c.a), `every kind ${DEFAULT_SIZE + STEP}`, allThree(c.a, DEFAULT_SIZE + STEP));
  add("...and the other card does not move", fmt(c.b), `every kind ${DEFAULT_SIZE}`, allThree(c.b, DEFAULT_SIZE));

  // 3. the wheel over the REASONING — the gesture is not scoped to what the pointer is over
  add("wheel over the reasoning moves the console and a tool's output too", fmt(r.a), `every kind ${DEFAULT_SIZE + 2 * STEP}`, allThree(r.a, DEFAULT_SIZE + 2 * STEP));

  // 4. the wheel over a TOOL'S OUTPUT, and back down
  add("wheel over a tool's output moves the reasoning too", fmt(t.a), `every kind ${DEFAULT_SIZE + 3 * STEP}`, allThree(t.a, DEFAULT_SIZE + 3 * STEP));
  add("wheel down steps all three back together", fmt(d.a), `every kind ${DEFAULT_SIZE + 2 * STEP}`, allThree(d.a, DEFAULT_SIZE + 2 * STEP));

  // 5. a repaint keeps the card's zoom, and only that card
  add("a repainted card keeps its zoom, on all three", `${fmt(p.a)} · card var ${p.a.cardVar}`, `every kind ${DEFAULT_SIZE + 2 * STEP}`, allThree(p.a, DEFAULT_SIZE + 2 * STEP) && p.a.cardVar === `${DEFAULT_SIZE + 2 * STEP}px`);
  add("...and the untouched card is still at the default", fmt(p.b), `every kind ${DEFAULT_SIZE}`, allThree(p.b, DEFAULT_SIZE));

  // 6. Settings' one baseline
  add("Console size moves all three on a card that was never zoomed", fmt(s.b), `every kind ${SETTINGS_SIZE}`, allThree(s.b, SETTINGS_SIZE));
  add("...while the zoomed card keeps its own size", fmt(s.a), `every kind ${DEFAULT_SIZE + 2 * STEP}`, allThree(s.a, DEFAULT_SIZE + 2 * STEP));
  add("the Thinking text row offers no second size", cap.panel, "no size picker, its preview at the console size", cap.panel.hasThinkSize === false && cap.panel.previews.find((x) => x.k === "think").size === `${SETTINGS_SIZE}px`);

  // 7. a reload: the stored Console size is what comes back
  add("after a reload every card, every kind, is the stored Console size", `${fmt(l.a)} · ${fmt(l.b)}`, `${SETTINGS_SIZE} everywhere`, allThree(l.a, SETTINGS_SIZE) && allThree(l.b, SETTINGS_SIZE));
  add("the page threw nothing", cap.errors, [], cap.errors.length === 0);
  return { checks, driven: true };
}
const THREE_KINDS_present = (s) => typeof s.normal === "number" && typeof s.reasoning === "number" && typeof s.tool === "number";

// ---- main ----------------------------------------------------------------------------------------------------
const pw = loadPlaywright();
if (!pw) {
  console.log("SKIP  playwright is not installed here (set PLAYWRIGHT_ROOT to a node_modules directory that has it)");
  process.exit(0);
}
const work = mkdtempSync(path.join(os.tmpdir(), "wtgui-console-zoom-"));
const profile = path.join(work, "profile");
mkdirSync(profile, { recursive: true });
const ctx = await pw.chromium.launchPersistentContext(profile, { headless: !HEADED, viewport: { width: 1280, height: 1000 } });
let exit = 0;
try {
  const modes = MODE === "both" ? ["stream", "think"] : [MODE];
  for (const mode of modes) {
    console.log(`\n-- ${mode}: two cards, each with a thought, a terminal call and prose; the wheel is driven on card A`);
    const cap = await runMode(ctx, work, mode);
    const verdict = judge(cap);
    for (const c of verdict.checks) {
      if (c.ok) console.log(`PASS  ${c.name}: ${JSON.stringify(c.got)}`);
      else console.log(`FAIL  ${c.name}\n        got  ${JSON.stringify(c.got)}\n        want ${typeof c.want === "string" ? c.want : JSON.stringify(c.want)}`);
    }
    for (const st of cap.steps) {
      const a0 = st.before.a, a1 = st.after.a;
      const delta = (k) => Math.round((a1[k] - a0[k]) * 100) / 100;
      console.log(`   wheel ${st.dy < 0 ? "up" : "down"} over the ${st.what} (${st.gesture}): normal ${a0.normal}→${a1.normal} (Δ${delta("normal")}), reasoning ${a0.reasoning}→${a1.reasoning} (Δ${delta("reasoning")}), tool ${a0.tool}→${a1.tool} (Δ${delta("tool")}) · card B ${st.before.b.normal}→${st.after.b.normal}`);
    }
    console.log(`   screenshots: ${cap.shots.join("  ")}`);
    if (!verdict.driven) {
      console.log("NOT DRIVEN  the page did not show two cards with normal output, reasoning and a tool's output: a pass here would prove nothing");
      console.log(JSON.stringify({ baseline: cap.baseline }, null, 1).slice(0, 1500));
      exit = Math.max(exit, 2);
    } else if (verdict.checks.some((c) => !c.ok)) exit = Math.max(exit, 1);
    else if (cap.steps.some((st) => st.gesture !== "real")) console.log("NOTE  a wheel step was dispatched as a WheelEvent because CDP dropped the modifier (the page's listener answered either way)");
  }
} finally {
  await ctx.close().catch(() => {});
}
console.log(exit === 0 ? "\nOK  one size drives the console's words, a tool's output and the reasoning, and Ctrl+wheel moves all three per card" : exit === 1 ? "\nFAILED  see the FAIL lines above" : "\nINCONCLUSIVE  the harness did not drive what it measures");
process.exit(exit);
