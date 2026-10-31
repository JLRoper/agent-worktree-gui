// The thinking block's flicker, caught in a browser against the shipped page.
//
//   node tools/verify-thinking-flicker.mjs                 # drive this checkout, print the checks
//   node tools/verify-thinking-flicker.mjs --headless      # no window (rAF is throttled; the state log still runs)
//   node tools/verify-thinking-flicker.mjs --only store    # one phase: live | store | flap | settle
//   node tools/verify-thinking-flicker.mjs --blocks <fail> # replay a REAL turn's reasoning (a JSON dump of the route:
//                                                          # { blocks: [{ at, text }] } from /api/thinking)
//
// WHAT THE FLICKER IS (the question this tool answers)
//   The reasoning block is the only thing on a card that is not drawn from the run's own line stream: it is POLLED
//   (`/api/thinking`, every ~2.4 s while its turn is live) and then painted twice over a whole node replacement —
//   `paintThink()` builds a fresh `<details>` from the store's blocks and `el.replaceWith()`s it. Everything the run
//   itself says is appended to `pre.job-out` and never rebuilt. So a collapse of the reasoning block can only come
//   from one of: the block reading closed, the painted text shrinking, or the block list shrinking under it.
//
// WHAT IS DRIVEN (nothing synthetic reaches the server)
//   * a sandbox panel of its own — spare port, own PANEL_CONFIG, own HERMES_HOME, API_SERVER_KEY empty — serving the
//     chosen checkout's public/
//   * the page's OWN state: a live turn fabricated in `state.jobs`/`state.jobLines` and painted by the shipped
//     `renderJobs()`/`conversationHtml()`, with `/api/thinking` fulfilled from the probe so the sweep's real
//     `loadThinking()` → `paintThink()` path runs on its real 1.2 s clock
//   * a state log taken from the mutation batches themselves (a write is what changes the block, and the observer runs
//     before the next paint) plus a timer as a backstop and rAF when the window paints: `open`, the `<details>` height,
//     the body's scroll and scrollHeight, the block count, each block's text length and the summary's meta line
//
// WHAT IT ASSERTS (exit 1 while any check fails)
//   (1) a live turn's open block never reads closed, and its height never falls back toward the summary
//   (2) no painted block's text ever gets shorter — typing grows, it does not rewind
//   (3) a block's text is a prefix of ITS OWN store text (the lid that identifies it must not be shared with another
//       block: the pacer keeps ONE visible prefix per lid, so two blocks on one lid paint each other's words)
//   (4) the sweep really repainted the block (>= 2 `paintThink` calls), so a clean run means the repaint was played
//   (5) a store read that comes back EMPTY while the turn is live does not blank a block that already has text
//   (6) a settled turn folds once and does not reopen (the panel's own re-read must not count as the reader opening it)
//   (7) a turn that settles and comes back does not REWIND the block's text: the whole-text branch and the pacer's
//       prefix must never disagree, or the block collapses to a few words and types them out again
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installFakeEventSource, loadPlaywright } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
// This checkout: the panel it boots is the one beside this tool. A `before` capture is made by copying this file into
// an export of the base commit (`git archive <ref> | tar -x -C <scratch>`), so the tool and the page always agree.
const ROOT = path.join(HERE, "..");
const ONLY = opt("--only");
const BLOCKS_FILE = opt("--blocks");
const HEADLESS = argv.includes("--headless");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const THREAD = "probe-think-thread";

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

// Two blocks of reasoning the size a real turn's are (1-8 kB each, measured on this box). They have to be this long
// for a reason: at 40 words a second the pacer is still deep inside a block minutes after it arrived, which is what
// makes "the whole text" and "the prefix the clock reached" two visibly different strings.
const BLOCK_A = Array.from({ length: 400 }, (_, i) => `alpha${i}`).join(" ");
const BLOCK_B = Array.from({ length: 400 }, (_, i) => `beta${i}`).join(" ");
const AT_A = 1_760_000_000_000;
const AT_B = AT_A + 4_000;

let browserRef = null;
let panel = null;
let tmp = null;
async function cleanup() {
  try {
    if (browserRef) await browserRef.close();
  } catch {
    /* already gone */
  }
  try {
    if (panel) await panel.stop();
  } catch {
    /* already gone */
  }
  try {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* a locked scratch file is not worth failing the run */
  }
}
process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});

async function main() {
  const pw = loadPlaywright();
  if (!pw) {
    console.log("BROWSER-HALF-NOT-RUN: no playwright on this box (set PANEL_PLAYWRIGHT_ROOT)");
    process.exit(2);
  }
  tmp = mkdtempSync(path.join(os.tmpdir(), "wtgui-think-flicker-"));
  panel = await startPanel({ config: { scanRoots: [path.join(tmp, "repos")] } });
  const base = panel.base;

  const browser = await pw.chromium.launch({
    headless: HEADLESS,
    // Overlay scrollbars change clientHeight and can mask an under/overflowing body.
    args: [
      "--disable-features=OverlayScrollbar,FluentOverlayScrollbar,FluentScrollbar",
      // A headed window that is occluded or minimised is throttled: rAF stops, and with it every frame of the sample.
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
    ],
  });
  browserRef = browser;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.bringToFront();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e && e.message)));

  await installFakeEventSource(context);
  await context.addInitScript(
    ({ thread, atA, atB, a, b, real }) => {
      const realFetch = window.fetch.bind(window);
      // A window this probe cannot see is not a window the reader sees: Chromium never paints an occluded page, so
      // `document.hidden` would switch the pacing off and there would be nothing to watch. The page's own code reads
      // `document.hidden` in exactly one place (`paceThinkBlock`), so saying "visible" here is what a reader's screen
      // says, not a stub of the thing under test.
      try {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      } catch {
        /* a browser that refuses just runs the hidden path */
      }
      // A real turn is the default shape of the problem: a live turn's store window holds every reasoning block it has
      // written so far (58 blocks / 183 kB measured on this box), not the two a fixture would suggest.
      const probe = {
        blocks: real && real.length ? real.map((x) => ({ at: x.at, text: x.text })) : [{ at: atA, text: a }, { at: atB, text: b }],
        reads: 0,
        emptyNext: 0,
        paints: 0,
        loads: 0,
      };
      probe.nBlocks = probe.blocks.length;
      window.__probe = probe;
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      window.fetch = async (url, opts = {}) => {
        const u = String(url);
        if (String((opts && opts.method) || "GET").toUpperCase() !== "POST") {
          if (u.includes("/api/state")) {
            try {
              const d = await realFetch(url, opts).then((r) => r.json());
              return json({ ...d, jobs: [...state.jobs.values()] });
            } catch {
              return json({ jobs: [...state.jobs.values()] });
            }
          }
          if (u.includes("/api/thinking")) {
            probe.reads += 1;
            if (probe.emptyNext > 0) {
              probe.emptyNext -= 1;
              return json({ blocks: [] });
            }
            return json({ blocks: probe.blocks.map((x) => ({ at: x.at, text: x.text })) });
          }
          return realFetch(url, opts);
        }
        return json({ ok: true });
      };
      try {
        localStorage.setItem("wtgui.think", "1");
        localStorage.setItem(`wtgui.think.${thread}`, "1");
        localStorage.setItem("wtgui.autoCollect", "0");
        localStorage.setItem("wtgui.streamWords", "40");
      } catch {
        /* the page will just not remember it */
      }

      // The turn under test: LIVE, its own thread, one console with prose and a tool burst.
      probe.mount = (opts = {}) => {
        const id = "probe-think-turn";
        const lines = [
          { kind: "text", text: "Reading the tree before anything else.", lid: "t1" },
          { kind: "tool", text: "▸ read · public/app.js", at: Date.now() - 9000 },
          { kind: "tool-out", text: "  ↳ read · 0.42s" },
          { kind: "text", text: "Nothing odd so far.", lid: "t2" },
        ];
        state.jobs.clear();
        state.jobLines.clear();
        state.thinkCache.clear();
        state.thinkOpen.clear();
        state.thinkClosed.clear();
        state.pinnedTurns.clear();
        state.outPinned = {};
        state.jobLines.set(id, lines);
        state.jobs.set(id, {
          id,
          thread,
          turn: 1,
          status: opts.status || "running",
          prompt: "thinking flicker probe",
          displayPrompt: "thinking flicker probe",
          cwd: null,
          worktree: false,
          worktreePath: null,
          projectPath: null,
          ownerPath: null,
          branch: null,
          runId: "run_probe_think",
          startedAt: new Date(Date.now() - 90_000).toISOString(),
          endedAt: opts.status === "done" ? new Date().toISOString() : null,
          model: "probe/model",
          lines: [],
          artifacts: [],
          attachments: [],
          subagents: [],
        });
        // The block is open because its turn is LIVE (thinkOpenFor falls back to turnLive) - not because the reader
        // pressed it: adding the turn here would make the settle phase's fold a reader choice that never happens.
        // The panel's own paths, wrapped so the run can say whether the sweep actually fired.
        if (!window.__wrapped) {
          window.__wrapped = true;
          const realPaint = window.paintThink;
          window.paintThink = function (...args) {
            probe.paints += 1;
            return realPaint.apply(this, args);
          };
          const realLoad = window.loadThinking;
          window.loadThinking = function (...args) {
            probe.loads += 1;
            return realLoad.apply(this, args);
          };
        }
        renderJobs();
        return Boolean(document.querySelector("details.think"));
      };

      // A live turn's reasoning keeps growing while the reader watches: the store appends a paragraph to the block it is
      // already holding, and the clock is soon far behind it. That gap is what the whole-text branch has to agree with.
      probe.grow = (n = 400, tag = "appended") => {
        probe.blocks = probe.blocks.map((b, i) => ({
          at: b.at,
          text: `${b.text} ${Array.from({ length: n }, (_, j) => `${tag}${i}x${j}`).join(" ")}`,
        }));
        return probe.blocks.reduce((sum, b) => sum + b.text.length, 0);
      };

      probe.setStatus = (status) => {
        const j = [...state.jobs.values()].find((x) => x.id === "probe-think-turn");
        j.status = status;
        j.endedAt = status === "done" ? new Date().toISOString() : null;
        renderConversation(j.thread || j.id);
        return true;
      };

      // The sampler: a row per state the block is left in, captured from the mutation batches themselves (a write is
      // what changes it, and a MutationObserver fires before the next paint, so every intermediate state is recorded
      // with its own timestamp) plus a timer as a backstop. rAF is kept when the window paints, but a probe that
      // depended on it would read "0 frames, all clear" on a box whose Chromium is occluded.
      probe.arm = () => {
        probe.frames = [];
        probe.states = [];
        probe.last = null;
        const snap = () => {
          const d = document.querySelector("details.think");
          if (!d) return { gone: true };
          const body = d.querySelector(".think-body");
          const blocks = [...d.querySelectorAll(".think-block")];
          return {
            t: Math.round(performance.now()),
            open: d.open,
            h: Math.round(d.getBoundingClientRect().height),
            bodyH: body ? Math.round(body.getBoundingClientRect().height) : null,
            scrollTop: body ? Math.round(body.scrollTop) : null,
            scrollH: body ? Math.round(body.scrollHeight) : null,
            n: blocks.length,
            lens: blocks.map((x) => x.textContent.length),
            texts: blocks.map((x) => x.textContent),
            meta: d.querySelector(".think-meta")?.textContent || "",
          };
        };
        const push = (row, bag) => {
          const k = JSON.stringify([row.open, row.h, row.n, row.lens, row.meta, row.gone]);
          if (probe.last === k) return;
          probe.last = k;
          bag.push(row);
          if (bag.length > 4000) bag.shift();
        };
        probe.snap = snap;
        const loop = () => {
          if (!probe.stop) requestAnimationFrame(loop);
          push(snap(), probe.frames);
        };
        requestAnimationFrame(loop);
        probe.obs = new MutationObserver(() => push(snap(), probe.states));
        probe.obs.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
        probe.timer = setInterval(() => push(snap(), probe.states), 60);
        return true;
      };
      probe.disarm = () => {
        probe.stop = true;
        probe.obs?.disconnect();
        clearInterval(probe.timer);
        return true;
      };
      probe.report = () => ({
        frames: probe.frames.slice(),
        states: probe.states.slice(),
        paints: probe.paints,
        loads: probe.loads,
        reads: probe.reads,
        nBlocks: probe.blocks.length,
        source: probe.blocks.map((x) => x.text),
      });
      // What the render reads, so a failed check can name the field that did not move instead of guessing.
      probe.debug = () => {
        const t = [...state.jobs.values()][0];
        const det = document.querySelector("details.think");
        return {
          jobs: [...state.jobs.keys()],
          status: t?.status ?? null,
          live: t ? turnLive(t) : null,
          key: t ? turnKey(t, "") : null,
          thinkOpen: [...state.thinkOpen],
          thinkClosed: [...state.thinkClosed],
          cache: [...state.thinkCache.keys()],
          cards: document.querySelectorAll(".job[data-thread]").length,
          details: document.querySelectorAll("details.think").length,
          open: det ? det.open : null,
        };
      };
    },
    {
      thread: THREAD,
      atA: AT_A,
      atB: AT_B,
      a: BLOCK_A,
      b: BLOCK_B,
      real: BLOCKS_FILE ? JSON.parse(readFileSync(path.resolve(BLOCKS_FILE), "utf8")).blocks || [] : null,
    },
  );

  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof renderJobs === "function" && typeof state === "object", null, { timeout: 30_000 });
  await sleep(500);
  const mounted = await page.evaluate(() => window.__probe.mount());
  check("(0) the fabricated live turn draws a thinking block", Boolean(mounted), `details.think present: ${mounted}`);
  if (!mounted) throw new Error("the probe could not draw a card — the render contract moved");

  // Give the block its first read, then start measuring: the first feed types from empty on purpose (a live turn's
  // new block arrives a word at a time), so the sampler starts once that has happened.
  await sleep(1200);

  const phases = ONLY ? [ONLY] : ["live", "store", "flap", "settle"];

  if (phases.includes("live")) {
    await page.evaluate(() => {
      window.__probe.last = null;
      window.__probe.frames = [];
      window.__probe.muts = [];
      window.__probe.arm();
    });
    const t0 = Date.now();
    // 8 s: the sweep's clock is 1.2 s and a live read is allowed every 2 s, so this covers ~3 full re-reads.
    while (Date.now() - t0 < 8000) await sleep(250);
    const rep = await page.evaluate(() => {
      window.__probe.disarm();
      return window.__probe.report();
    });
    judgeLive(rep, "live/steady");
  }

  if (phases.includes("store")) {
    // A read that comes back empty (the store hiccup) while the turn is still live.
    await page.evaluate(() => {
      window.__probe.arm();
      window.__probe.emptyNext = 1;
    });
    const t0 = Date.now();
    while (Date.now() - t0 < 6000) await sleep(200);
    const rep = await page.evaluate(() => {
      window.__probe.disarm();
      return window.__probe.report();
    });
    judgeStore(rep);
  }

  if (phases.includes("flap")) {
    // The turn settles and comes back (a revived run, a card that was adopted twice). The block folds and reopens, and
    // its TEXT must not rewind: a prefix the clock had reached minutes ago is not what the store says now.
    await page.evaluate(() => window.__probe.grow(400));
    await sleep(2600); // one store re-read: the block the pacer holds is now far longer than what it has typed
    await page.evaluate(() => window.__probe.arm());
    await sleep(1500);
    await page.evaluate(() => window.__probe.setStatus("done"));
    await sleep(1200);
    await page.evaluate(() => window.__probe.setStatus("running"));
    await sleep(2200);
    const rep = await page.evaluate(() => {
      window.__probe.disarm();
      return window.__probe.report();
    });
    judgeFlap(rep);
  }

  if (phases.includes("settle")) {
    let settleDebug = null;
    await page.evaluate(() => {
      window.__probe.arm();
      window.__probe.setStatus("done");
    });
    await sleep(400);
    // Named in the check's detail when it fails: which state the panel thinks the block is in, and why.
    settleDebug = await page.evaluate(() => window.__probe.debug());
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) await sleep(200);
    const rep = await page.evaluate(() => {
      window.__probe.disarm();
      return window.__probe.report();
    });
    judgeSettle(rep, settleDebug);
  }

  check("no page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | ") || "0");
  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks pass${failed.length ? `, ${failed.length} FAIL` : ""}`);
  await cleanup();
  process.exit(failed.length ? 1 : 0);
}

function series(rep) {
  // The mutation log is the sample stream that always exists; rAF frames are only a bonus (an occluded Chromium never
  // paints). Whichever ran, both record the same shape, so the checks read one of them.
  const states = (rep.states || []).filter((f) => !f.gone);
  const frames = (rep.frames || []).filter((f) => !f.gone);
  return frames.length > states.length ? frames : states;
}

// A collapse is a FALL between two states of the same block list, not a small height: a block legitimately starts at
// nothing and grows as it types, so "below its own maximum" would flag the first word of every block.
function falls(frames) {
  const out = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    if (a.n !== b.n) continue;
    if (b.h < a.h - 40) out.push({ from: a.h, to: b.h, at: b.t });
  }
  return out;
}

function judgeLive(rep, label) {
  // A block that leaves the document and comes back is the reader's "collapsed and reopened": measure the gaps.
  const all = [...(rep.states || []), ...(rep.frames || [])].sort((a, b) => (a.t || 0) - (b.t || 0));
  const gaps = [];
  for (let i = 1; i < all.length; i++) if (all[i - 1].gone && !all[i].gone) gaps.push({ gone: all[i].t - all[i - 1].t, at: all[i - 1].t });
  console.log(`  [${label}] absent-then-back gaps: ${gaps.length}${gaps.length ? `, longest ${Math.max(...gaps.map((g) => g.gone))} ms` : ""}`);
  const frames = series(rep);
  const closed = frames.filter((f) => f.open === false);
  const heights = frames.map((f) => f.h);
  const drops = falls(frames);
  check(
    `(1) ${label}: a live block never reads closed and never falls back toward its summary`,
    frames.length >= 5 && closed.length === 0 && drops.length === 0,
    `states ${frames.length}, closed ${closed.length}, height ${Math.min(...heights)}→${Math.max(...heights)}` +
      (drops.length ? `, FALLS ${JSON.stringify(drops.slice(0, 3))}` : ", no fall"),
  );
  const shrinks = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    if (a.n !== b.n) continue;
    for (let k = 0; k < b.n; k++) if (b.lens[k] < (a.lens[k] || 0)) shrinks.push({ from: a.lens[k], to: b.lens[k], k, at: b.t });
  }
  check(`(2) ${label}: no painted block's text gets shorter`, frames.length >= 5 && shrinks.length === 0, shrinks.length ? JSON.stringify(shrinks.slice(0, 4)) : `${frames.length} states, monotone`);
  const nBlocks = rep.nBlocks || 2;
  const bleed = frames.filter((f) => f.texts.some((t, k) => k < Math.min(nBlocks, f.texts.length) && t && !(String(rep.source[k] ?? "")).startsWith(t)));
  check(
    `(3) ${label}: each block paints its OWN text (no shared lid)`,
    frames.length >= 5 && bleed.length === 0,
    bleed.length ? JSON.stringify(bleed[0].texts.map((t) => t.slice(0, 24))) : "both blocks own their words",
  );
  check(
    `(4) ${label}: the sweep really repainted the block`,
    rep.paints >= 2,
    `paintThink ${rep.paints}, loadThinking ${rep.loads}, reads ${rep.reads}`,
  );
}

function judgeFlap(rep) {
  const frames = series(rep);
  const shrinks = [];
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    if (a.n !== b.n) continue;
    for (let k = 0; k < b.n; k++) if (b.lens[k] < (a.lens[k] || 0)) shrinks.push({ from: a.lens[k], to: b.lens[k], k, at: b.t });
  }
  const closed = frames.filter((f) => f.open === false).length;
  const reopened = frames.some((f, i) => i > 0 && f.open === true && frames[i - 1].open === false);
  check(
    "(7) a turn that settles and comes back does not rewind the block's text",
    rep.reads >= 2 && frames.length >= 2 && shrinks.length === 0 && reopened,
    `${frames.length} states, ${closed} folded, reopened: ${reopened}` +
      (shrinks.length ? `, SHRANK ${JSON.stringify(shrinks.slice(0, 3))}` : ", monotone"),
  );
}

function judgeStore(rep) {
  const frames = series(rep);
  const blank = frames.filter((f) => f.n === 1 && f.lens[0] > 0 && /nothing yet|recorded no thinking|reading the store/.test(f.texts[0] || ""));
  const drops = falls(frames);
  check(
    "(5) a store read that comes back empty does not blank a live block that already has text",
    rep.reads >= 2 && frames.length >= 1 && blank.length === 0 && drops.length === 0,
    `reads ${rep.reads}, states ${frames.length}, blanked ${blank.length}` +
      (drops.length ? `, FALLS ${JSON.stringify(drops.slice(0, 3))}` : ", no fall"),
  );
}

function judgeSettle(rep, debug = null) {
  const frames = series(rep);
  // A settled turn folds once and keeps the whole text: exactly one transition to closed, and no reopen after it.
  const firstClosed = frames.findIndex((f) => f.open === false);
  const reopened = firstClosed >= 0 ? frames.slice(firstClosed + 1).some((f) => f.open === true) : false;
  check(
    "(6) a settled turn folds once and does not reopen",
    frames.length > 0 && firstClosed >= 0 && !reopened,
    `${frames.length} states, ` +
      (firstClosed < 0
        ? `never folded (opens: ${frames.filter((f) => f.open).length}, reads ${rep.reads}${debug ? `, thinkOpen ${JSON.stringify(debug.thinkOpen)}` : ""})`
        : `folded at state ${firstClosed} of ${frames.length}, reopened: ${reopened}`),
  );
}

main().catch(async (err) => {
  console.error(`probe failed: ${err?.stack || err}`);
  await cleanup();
  process.exit(1);
});
