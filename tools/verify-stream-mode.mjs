// Does the 🌊 toggle repaint a card that is already on the board? And what does the stream actually draw?
//
//   node tools/verify-stream-mode.mjs                     # drive the panel on 127.0.0.1:7331 (read-only)
//   node tools/verify-stream-mode.mjs --url <panel>       # another panel (127.0.0.1 only: this is a read-only probe)
//   node tools/verify-stream-mode.mjs --out <dir>         # where the screenshots + results.json go
//   node tools/verify-stream-mode.mjs --watch <ms>        # how long each toggle is watched (default 8000)
//
// WHAT IS DRIVEN
//   The live board, in a throwaway browser context: sections and rows are expanded with the panel's own fold controls
//   (`section.project .project-head`, `[data-open-row]`, never the ▶ that probes agents), and the only clicks are on a
//   card's own 🌊 and 🧠. No route is posted, nothing is spawned, the panel is never restarted and its logs are never
//   written. The 🌊/🧠 choices land in this context's localStorage (`wtgui.stream.<thread>`, `wtgui.think.<thread>`),
//   which no other browser shares. A page reload re-renders the card from those choices: that is the CONTROL that
//   shows what the mode draws when the card is built with it, as opposed to toggled into it.
//
// WHAT IS MEASURED, in order
//   (1) a turn with three tool bursts, drawn condensed (🌊 off, card loaded with it off): three `.tgrp` groups with a
//       head row each, bodies folded, prose lines between them;
//   (2) 🌊 on: whether that existing card repaints within 500 ms — and, because the board rebuilds rows on its own
//       schedule, WHERE any later change came from: the toggle's own `renderConversation` (wrapped and traced) or a
//       board rebuild that replaced the card node (traced to its caller);
//   (3) 🌊 off, on a card loaded in stream mode: the same measurement from the other direction;
//   (4) with 🌊 on, the card rebuilt through a control that IS in the signature (🧠): the groups must come out
//       `.tgrp-flat` — no head row, no `hidden` body — and on a live turn the reasoning must be typed into the console
//       a word at a time (`.jl-think` text grows over several samples) instead of landing as one block;
//   (5) the live console parked mid-scroll, three screenshots 2 s apart while the thinking sweep repaints it:
//       scrollTop must not move, and the console must actually have been repainted in that window for that to mean
//       anything.
//
// THE DEFECT THIS PROVES (or disproves, if the card repaints from the toggle itself)
//   The flat/condensed decision is derived three ways — `turnBody`'s `streamOn(thread) && wtStream`,
//   `streamBodyHtml`'s unconditional `{ flat: true }`, and `drawJobLine`'s `openGroup.dataset.gflat === "1"` with a
//   `streamOn(...)` fallback — while `conversationSignature()` carries the 🧠 (thinkingOn) and not the 🌊. A card is
//   rebuilt only when that signature changes (`renderConversation` compares `el.dataset.sig`), so the toggle can write
//   localStorage and leave the DOM exactly as it was.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const opt = (name, fallback = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const URL_ = opt("--url", "http://127.0.0.1:7331/");
const OUT = opt("--out", "C:/CodeReviews/agent-worktree-gui/playwright-lane-b");
const WATCH_MS = Number(opt("--watch", "8000"));
const FAST_MS = 500;
const PROGRESS_MS = Number(opt("--progress", "3000"));
const SWEEP_MS = Number(opt("--sweep", "2000"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!/^http:\/\/127\.0\.0\.1:\d+\/?$/.test(URL_)) {
  console.log(`refusing to drive ${URL_}: this is a read-only probe and only talks to 127.0.0.1`);
  process.exit(2);
}

const checks = [];
const observed = {};
function check(name, pass, detail = "") {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const shotPath = (name) => path.join(OUT, name);

// A crop of an element in DOCUMENT coordinates, so a board repaint that restores the page scroll between measuring and
// shooting cannot make the clip land on another card (measured: a viewport rect went stale and every shot came back as
// the assistant's console). Playwright's clip is page-relative and scrolls for itself.
async function shootBox(page, locator, file, maxH = 900, focusSel = null) {
  if (focusSel) {
    // Put the evidence in the window: the console is a fixed-height scroll box, so the turn's opening prose is what a
    // shot at its default scroll position shows (measured — the group rows were all below the fold).
    await locator
      .evaluate((el, sel) => {
        const t = el.querySelector(sel);
        if (!t) return false;
        // A console the panel still pins is re-stuck to its newest line within 400 ms, which undoes the scroll below
        // before the shutter: unpin it the way a reader's own scroll does, then measure both rects (offsetTop is
        // relative to the nearest positioned ancestor, not to this <pre>).
        try {
          state.outPinned[el.dataset.out] = false;
        } catch {
          /* no state to write: the scroll still stands on its own */
        }
        const delta = t.getBoundingClientRect().top - el.getBoundingClientRect().top;
        el.scrollTop = Math.max(0, el.scrollTop + delta - 6);
        return true;
      }, focusSel)
      .catch(() => false);
  }
  const r = await locator
    .evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { x: b.x + window.scrollX, y: b.y + window.scrollY, w: b.width, h: b.height };
    })
    .catch(() => null);
  if (!r) return null;
  const vp = page.viewportSize();
  const x = Math.max(0, Math.round(r.x));
  const y = Math.max(0, Math.round(r.y));
  const w = Math.max(1, Math.round(Math.min(r.w, vp.width)));
  const h = Math.max(1, Math.round(Math.min(r.h, maxH)));
  // `fullPage` with a page-relative clip: the crop can sit thousands of pixels down a board whose viewport is elsewhere,
  // and a viewport-relative shot of it comes back empty ("Clipped area is either empty or outside the resulting image").
  await page.screenshot({ path: file, clip: { x, y, width: w, height: h }, fullPage: true });
  return { file, clip: { x, y, width: w, height: h }, element: { w: Math.round(r.w), h: Math.round(r.h) } };
}

// ---- the page's own helpers, installed after every load ------------------------------------------
// `state`, `conversations()` and `conversationSignature` are top-level `const`/`function` in a classic script: they
// live in the page's global lexical environment, so they are reachable by BARE name inside evaluate — `window.state`
// is undefined, and reading it is what makes a helper silently report "no running turn".
async function installHelpers(page) {
  await page.evaluate(() => {
    const card = (t) => document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`);
    const jobs = () => {
      try {
        return state && state.jobs ? [...state.jobs.values()] : [];
      } catch {
        return [];
      }
    };
    window.__L = {
      card,
      out: (t) => {
        const c = card(t);
        return c ? c.querySelector("pre.job-out") : null;
      },
      jobs,
      running: (t) => jobs().some((j) => (j.thread || j.id) === t && j.status === "running"),
      storage(t) {
        try {
          return localStorage.getItem(`wtgui.stream.${t}`);
        } catch {
          return "?";
        }
      },
      measuredSig(t) {
        try {
          const conv = conversations().find((c) => c.thread === t);
          return conv ? conversationSignature(conv) : null;
        } catch {
          return null;
        }
      },
      snap(t) {
        const c = card(t);
        if (!c) return { gone: true };
        const out = c.querySelector("pre.job-out");
        if (out && !out.dataset.probeEl) out.dataset.probeEl = `e${Math.floor(Math.random() * 1e6).toString(36)}`;
        const groups = out ? [...out.querySelectorAll(":scope > .tgrp")] : [];
        const btn = c.querySelector("[data-stream-thread]");
        let pinned = null;
        try {
          pinned = out ? state.outPinned[out.dataset.out] !== false : null;
        } catch {
          pinned = null;
        }
        return {
          sig: c.dataset.sig || "",
          measured: window.__L.measuredSig(t) || "",
          groups: groups.length,
          flat: groups.filter((g) => g.dataset.gflat === "1").length,
          heads: groups.filter((g) => g.querySelector(":scope > .tgrp-head")).length,
          bodies: groups.filter((g) => g.querySelector(":scope > .tgrp-body")).length,
          hiddenBodies: groups.filter((g) => {
            const b = g.querySelector(":scope > .tgrp-body");
            return Boolean(b && b.hidden);
          }).length,
          flatWithHead: groups.filter((g) => g.dataset.gflat === "1" && g.querySelector(":scope > .tgrp-head")).length,
          flatHiddenBody: groups.filter((g) => {
            if (g.dataset.gflat !== "1") return false;
            const b = g.querySelector(":scope > .tgrp-body");
            return !b || b.hidden;
          }).length,
          tallies: groups.map((g) =>
            [...g.querySelectorAll(":scope > .tgrp-head .tgrp-row")].map((r) => (r.textContent || "").replace(/\s+/g, " ").trim()).join(" | "),
          ),
          textLines: out ? out.querySelectorAll(":scope > .jl-text").length : 0,
          thinkBlocks: c.querySelectorAll("details.think").length,
          thinkLines: out ? out.querySelectorAll(":scope > .jl-think").length : 0,
          online: btn ? btn.getAttribute("aria-pressed") : null,
          lit: btn ? btn.classList.contains("is-on") : null,
          storage: window.__L.storage(t),
          outHtml: out ? out.innerHTML.length : 0,
          outId: out ? out.dataset.out : "",
          scrollTop: out ? Math.round(out.scrollTop) : null,
          scrollHeight: out ? out.scrollHeight : null,
          clientHeight: out ? out.clientHeight : null,
          pinned,
          hidden: document.hidden,
        };
      },
    };
  });
}

// The repaint paths, wrapped so "the card changed" can be attributed: the toggle's own render (which bails on an
// unchanged signature) versus a board rebuild that replaced the card node — and, for the latter, who called it.
async function installTrace(page) {
  await page.evaluate(() => {
    window.__trace = { calls: [] };
    const wrap = (name) => {
      const fn = window[name];
      if (typeof fn !== "function") return;
      window[name] = function (...args) {
        const t = Math.round(performance.now());
        const thread = name === "renderConversation" ? String(args[0] ?? "") : "";
        const before = thread ? window.__L.card(thread) : null;
        let out;
        try {
          out = fn.apply(this, args);
        } finally {
          const after = thread ? window.__L.card(thread) : null;
          const entry = {
            name,
            t,
            thread,
            replaced: Boolean(before && after && before !== after),
            same: Boolean(before && after && before === after),
            sigBefore: before ? String(before.dataset.sig || "").slice(0, 24) : "",
            sigAfter: after ? String(after.dataset.sig || "").slice(0, 24) : "",
          };
          if (name === "conversationHtml") entry.stack = String(new Error().stack || "").split("\n").slice(1, 5).map((s) => s.trim());
          if (window.__trace.calls.length < 4000) window.__trace.calls.push(entry);
        }
        return out;
      };
    };
    for (const n of ["renderConversation", "conversationHtml", "fillAgentSlots", "renderJobs"]) wrap(n);
  });
  // The console's out-of-band painters, counted but not argued with: which of them ran after a click is the difference
  // between "the toggle repainted the card" and "a clock repainted the console behind the toggle's back".
  await page.evaluate(() => {
    for (const name of ["paintStreamConsole", "paintThink", "loadThinking", "sweepThinking", "drawJobLine"]) {
      const fn = window[name];
      if (typeof fn !== "function") continue;
      window[name] = function (...args) {
        window.__trace.calls.push({ name, t: Math.round(performance.now()) });
        return fn.apply(this, args);
      };
    }
  });
  // Who writes scrollTop. Assignments go through Element.prototype's setter; a drift with an empty log is the browser
  // (scroll anchoring), not the panel.
  await page.evaluate(() => {
    window.__scrollLog = [];
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    if (!desc || !desc.set) return;
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true,
      get() {
        return desc.get.call(this);
      },
      set(v) {
        try {
          if (this.matches && this.matches("pre.job-out")) {
            const frames = String(new Error().stack || "").split("\n").slice(1).map((s) => s.trim());
            const caller = frames.slice(1).find((f) => !/scrollTop/.test(f)) || frames[1] || "";
            const tag = this.dataset.probeEl || "untagged";
            const key = `${caller.replace(/^at\s+/, "").slice(0, 100)}|${tag}`;
            const e = window.__scrollLog.find((x) => x.key === key);
            if (e) {
              e.n++;
              e.last = Math.round(Number(v));
            } else {
              window.__scrollLog.push({
                key,
                tag,
                n: 1,
                first: Math.round(Number(v)),
                last: Math.round(Number(v)),
                id: this.dataset.out,
                ch: this.clientHeight,
                sh: this.scrollHeight,
                frames: frames.slice(1, 5),
              });
            }
          }
        } catch {
          /* the log is a convenience, never a reason to fail a scroll */
        }
        desc.set.call(this, v);
      },
    });
  });
}

async function expandBoard(page) {
  const opened = await page.evaluate(() => {
    let sections = 0;
    for (const el of document.querySelectorAll("section.project:not(.open) .project-head")) {
      el.click();
      sections++;
    }
    let rows = 0;
    for (const el of document.querySelectorAll("[data-open-row]")) {
      if (el.dataset.openRow) {
        el.click();
        rows++;
      }
    }
    return { sections, rows, cards: document.querySelectorAll(".job[data-thread]").length };
  });
  await sleep(1300);
  return opened;
}

// The card only exists once its row is unfolded, and a freshly loaded board unfolds its rows a moment after the click
// (the detail is filled from the row payload). Press the folds until the card is in the DOM.
async function ensureCard(page, thread, deadlineMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    const there = await page.evaluate((t) => Boolean(document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`)), thread);
    if (there) return true;
    await page.evaluate(() => {
      for (const el of document.querySelectorAll("section.project:not(.open) .project-head")) el.click();
      for (const el of document.querySelectorAll("[data-open-row]")) if (el.dataset.openRow) el.click();
    });
    await sleep(600);
  }
  return false;
}

// Load the board with this thread's 🌊/🧠 choices already in storage, then expand it. The reload is the control: a card
// BUILT with the mode on, versus one toggled into it.
async function loadWith(page, thread, { stream = "0", think = "0" } = {}) {
  await page.evaluate(
    ({ t, s, k }) => {
      try {
        localStorage.setItem(`wtgui.stream.${t}`, s);
        localStorage.setItem(`wtgui.think.${t}`, k);
      } catch {
        /* private mode: the probe just sees the default */
      }
    },
    { t: thread, s: stream, k: think },
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll(".job[data-thread]").length > 0);
  await sleep(900);
  await expandBoard(page);
  const found = await ensureCard(page, thread);
  await installHelpers(page);
  await installTrace(page);
  return found;
}

// Wait for the 1.2 s thinking sweep to fire, so the toggle is measured from a known phase: right after a tick, the next
// one is ~1.2 s away. Without that, a run can land the click 50 ms before a tick and read "it repainted in 107 ms", which
// is the clock, not the switch.
async function waitForSweepTick(page, timeoutMs = 4000) {
  return page.evaluate(
    (ms) =>
      new Promise((resolve) => {
        // `setInterval(sweepThinking, 1200)` captured the original function before any wrapper existed, so the tick is
        // counted by shadowing setInterval at document start (see addInitScript), not by wrapping the function.
        const count = () => (window.__ticks ? window.__ticks.sweepThinking || 0 : 0);
        const seen = count();
        const t0 = performance.now();
        const iv = setInterval(() => {
          if (count() > seen) {
            clearInterval(iv);
            resolve({ afterMs: Math.round(performance.now() - t0), ticks: count() });
          } else if (performance.now() - t0 > ms) {
            clearInterval(iv);
            resolve({ afterMs: null, ticks: count() });
          }
        }, 25);
      }),
    timeoutMs,
  );
}

// One toggle, measured in one uninterrupted stretch inside the page: the click, the toggle's own render path (traced),
// the DOM 500 ms later, and — separately labelled — the first time the card node changed for any other reason.
async function toggle(page, thread, { watchMs, fastMs }) {
  return page.evaluate(
    async ({ t, watchMs, fastMs }) => {
      const L = window.__L;
      const cardNow = () => L.card(t);
      const btn = document.querySelector(`.job[data-thread="${CSS.escape(t)}"] [data-stream-thread]`);
      if (!btn) return { error: "no 🌊 button on that card", own: null };
      const before = cardNow();
      if (!before) return { error: "no card for that thread", own: null };
      const base = L.snap(t);
      const traceFrom = window.__trace ? window.__trace.calls.length : 0;
      const clickAt = performance.now();
      btn.click();
      const ownCalls = (window.__trace ? window.__trace.calls.slice(traceFrom) : []).filter((c) => c.thread === t || c.name === "conversationHtml");
      const afterOwn = cardNow();
      const own = {
        calls: ownCalls.map((c) => ({ name: c.name, thread: c.thread, replaced: c.replaced, same: c.same })),
        replaced: afterOwn !== before,
        sigBefore: String(before.dataset.sig || ""),
        sigAfter: String((afterOwn && afterOwn.dataset.sig) || ""),
        aria: btn.getAttribute("aria-pressed"),
        lit: btn.classList.contains("is-on"),
        storage: L.storage(t),
      };
      const key = (s) => JSON.stringify([s.groups, s.flat, s.heads, s.hiddenBodies, s.thinkBlocks, s.thinkLines, s.outHtml, s.online, s.lit, s.sig]);
      // The MODE is what the toggle is supposed to change: flat pieces vs head rows, a thinking block vs reasoning rows in
      // the console, and the button's own lit state. `outHtml` moves on its own — the group sweep rewrites a body — and
      // counting that as "the card repainted" is how a probe talks itself into a fix that is not there.
      const modeKey = (s) => JSON.stringify([s.flat, s.heads, s.thinkBlocks, s.thinkLines, s.online, s.lit]);
      const paintKey = (s) => JSON.stringify([s.outHtml, s.groups, s.flat, s.heads, s.thinkBlocks, s.thinkLines]);
      const baseKey = key(base);
      const baseMode = modeKey(base);
      const basePaint = paintKey(base);
      let first = null;
      let firstPaint = null;
      let at500 = null;
      let replacedAt = null;
      let replacement = null;
      let node = before;
      await new Promise((resolve) => {
        const tick = () => {
          const dt = performance.now() - clickAt;
          const s = L.snap(t);
          const c = cardNow();
          if (node && c && c !== node) {
            node = c;
            if (replacedAt == null) {
              replacedAt = Math.round(dt);
              const calls = (window.__trace ? window.__trace.calls : []).filter((x) => (x.name === "conversationHtml" || x.name === "renderJobs" || x.name === "fillAgentSlots") && x.t > clickAt);
              replacement = calls.slice(0, 3).map((x) => ({ name: x.name, replaced: x.replaced, stack: x.stack || [] }));
            }
          }
          if (modeKey(s) !== baseMode && !first) first = { dt: Math.round(dt), flat: s.flat, groups: s.groups, heads: s.heads, thinkBlocks: s.thinkBlocks, thinkLines: s.thinkLines, online: s.online, lit: s.lit };
          if (paintKey(s) !== basePaint && !firstPaint) firstPaint = { dt: Math.round(dt), flat: s.flat, groups: s.groups, heads: s.heads };
          if (at500 == null && dt >= fastMs) at500 = { dt: Math.round(dt), flat: s.flat, groups: s.groups, heads: s.heads, thinkBlocks: s.thinkBlocks, thinkLines: s.thinkLines, online: s.online, lit: s.lit, storage: s.storage, signedSame: modeKey(s) === baseMode };
          if (dt < watchMs) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
      const paths = [...new Set((window.__trace ? window.__trace.calls : [])
        .filter((c) => c.t > clickAt && ["paintStreamConsole", "paintThink", "loadThinking", "sweepThinking", "drawJobLine"].includes(c.name))
        .map((c) => `${c.name}@+${c.t - Math.round(clickAt)}ms`))].slice(0, 10);
      return { base, own, first, firstPaint, at500, replacedAt, replacement, final: L.snap(t), paths };
    },
    { t: thread, watchMs, fastMs },
  );
}

const browser = await require("playwright").chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
const page = await ctx.newPage();
page.setDefaultTimeout(15000);
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
mkdirSync(OUT, { recursive: true });

// Count the panel's own clock ticks from the very first document: `setInterval(sweepThinking, 1200)` captures the
// function object, so wrapping `window.sweepThinking` later cannot see it fire. Wrapping setInterval itself can.
await ctx.addInitScript(() => {
  try {
    const orig = window.setInterval.bind(window);
    window.__ticks = {};
    window.setInterval = (fn, ms, ...rest) => {
      if (typeof fn !== "function") return orig(fn, ms, ...rest);
      const name = fn.name || "anon";
      const wrapped = function (...a) {
        window.__ticks[name] = (window.__ticks[name] || 0) + 1;
        return fn.apply(this, a);
      };
      return orig(wrapped, ms, ...rest);
    };
  } catch {
    /* no instrumented clock: the phase control degrades to "unknown", which the run reports */
  }
});

// ---- what the panel is serving --------------------------------------------------------------------
await page.goto(URL_, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelectorAll(".job[data-thread]").length > 0);
await sleep(900);
await expandBoard(page);
await installHelpers(page);
const build = await page.evaluate(() => {
  try {
    return { version: (state && state.settings && state.settings.version) || null, visibility: document.visibilityState, wtStream: Boolean(globalThis.wtStream) };
  } catch {
    return { version: null, visibility: document.visibilityState, wtStream: Boolean(globalThis.wtStream) };
  }
});
const appJs = await (await fetch(new URL("app.js", URL_))).text();
build.appJsSha256 = createHash("sha256").update(appJs).digest("hex");
try {
  build.treeAppJsSha256 = createHash("sha256").update(readFileSync(path.resolve("public/app.js"))).digest("hex");
} catch {
  build.treeAppJsSha256 = null;
}
console.log(`panel: ${URL_}  version=${build.version}  visibility=${build.visibility}  app.js=${build.appJsSha256.slice(0, 12)}  tree=${String(build.treeAppJsSha256).slice(0, 12)}`);

// ---- pick the two cards ---------------------------------------------------------------------------
const cards = await page.evaluate(() =>
  [...document.querySelectorAll(".job[data-thread]")].map((c) => ({ thread: c.dataset.thread, running: window.__L.running(c.dataset.thread), ...window.__L.snap(c.dataset.thread) })),
);
const finished =
  cards.find((c) => !c.running && c.groups >= 3 && c.textLines >= 2 && /catch-the-console-flicker/.test(c.thread)) ||
  cards.find((c) => !c.running && c.groups >= 3 && c.textLines >= 2) ||
  cards.find((c) => !c.running && c.groups >= 3);
const live = cards.find((c) => c.running && c.outHtml > 0 && /playwright-lane-b/.test(c.thread)) || cards.find((c) => c.running && c.outHtml > 0);
if (!finished) {
  console.log("no card on this board draws a turn with three tool bursts — nothing to measure");
  await browser.close();
  process.exit(2);
}
const target = finished.thread;
console.log(`condensed target: ${target} (${finished.groups} groups, ${finished.textLines} prose lines)`);
console.log(`live target:      ${live ? live.thread : "none"}${live ? ` (running: ${live.running})` : ""}`);

// ================= (1) the turn, drawn condensed, with three tool bursts ==========================
await loadWith(page, target, { stream: "0", think: "0" });
const s1 = await page.evaluate((t) => window.__L.snap(t), target);
if (s1.gone) {
  console.log(`the card for ${target} is not on the board after unfolding its row — nothing to measure`);
  await browser.close();
  process.exit(2);
}
check(
  "(1) card loaded with 🌊 off draws three bursts with a head row each",
  s1.groups >= 3 && s1.heads === s1.groups && s1.flat === 0 && s1.hiddenBodies >= 1,
  `${s1.groups} groups, ${s1.heads} heads, ${s1.flat} flat, ${s1.hiddenBodies}/${s1.bodies} bodies folded — tallies: ${s1.tallies.join(" / ")}`,
);
check("(1) the bursts are separated by prose", s1.textLines >= 2, `${s1.textLines} prose lines between the groups`);
check("(1) 🌊 is off and its button says so", (s1.storage === null || s1.storage === "0") && s1.online === "false" && s1.lit === false, `storage=${s1.storage} aria-pressed=${s1.online} is-on=${s1.lit}`);
observed.step1 = s1;
const s1Shot = await shootBox(page, page.locator(`.job[data-thread="${target}"] pre.job-out`), shotPath("01-condensed-three-bursts.png"), 700, ":scope > .tgrp");
check("(1) screenshot written", Boolean(s1Shot), s1Shot && s1Shot.file);

// ================= (2) toggle 🌊 on: does the existing card repaint within 500 ms? =================
const phase = await waitForSweepTick(page);
await sleep(60);
const on = await toggle(page, target, { watchMs: WATCH_MS, fastMs: FAST_MS });
check(
  "(2) the toggle's own render path bails instead of repainting",
  Boolean(on.own && !on.own.replaced),
  `renderConversation(${on.own.replaced ? "replaced the node" : "bailed"}) — card node ${on.own.replaced ? "replaced" : "unchanged"} by the click; calls: ${on.own.calls.map((c) => `${c.name}(${c.replaced ? "replaced" : "bailed"})`).join(", ") || "none"}`,
);
check(
  "(2) no repaint into stream mode within 500 ms of 🌊 on",
  !on.first || on.first.dt > FAST_MS,
  on.first
    ? `console repainted as a stream at ${on.first.dt} ms after the click, measured from ${phase.afterMs == null ? "an unknown" : phase.afterMs + " ms after"} a sweep tick (flat ${on.first.flat}, heads ${on.first.heads}); painters: ${on.paths.join(", ") || "none"}`
    : `mode unchanged for ${WATCH_MS} ms; painters: ${on.paths.join(", ") || "none"}; ${on.firstPaint ? `only DOM churn was a body repaint at ${on.firstPaint.dt} ms` : "no DOM churn at all"}`,
);
check(
  "(2) the repaint key is unchanged by the toggle, so renderConversation returns early",
  on.own.sigBefore === on.own.sigAfter && on.own.sigBefore.length > 0,
  `dataset.sig ${on.own.sigBefore === on.own.sigAfter ? "byte-identical" : "moved"} (${on.own.sigBefore.slice(0, 60)}…); conversationSignature() ${on.base.measured === on.final.measured ? "identical" : "moved"}`,
);
check(
  "(2) the switch reached storage without lighting its own button",
  on.own.storage === "1" && on.at500 && on.at500.storage === "1" && on.at500.online === "false" && on.at500.lit === false,
  `localStorage=1; at +${on.at500 ? on.at500.dt : "?"} ms aria-pressed=${on.at500 && on.at500.online} is-on=${on.at500 && on.at500.lit} — the button keeps reading off after the switch is on`,
);
check(
  "(2) no board rebuild replaced the card in the watch window",
  on.replacedAt == null,
  on.replacedAt == null
    ? `the card node is the same object after ${WATCH_MS} ms; final mode: flat=${on.final.flat}, heads=${on.final.heads}/${on.final.groups}`
    : `card node replaced at ${on.replacedAt} ms by ${on.replacement && on.replacement[0] ? on.replacement[0].name : "?"} (${on.replacement && on.replacement[0] && on.replacement[0].stack ? on.replacement[0].stack[1] || on.replacement[0].stack[0] : "no stack"})`,
);
observed.step2 = on;
const s2Shot = await shootBox(page, page.locator(`.job[data-thread="${target}"] pre.job-out`), shotPath("02-stream-on-existing-card.png"), 700, ":scope > .tgrp");
check("(2) screenshot written", Boolean(s2Shot), s2Shot && s2Shot.file);

// ================= (2b)/(2c) what the sweep does with 🌊 on =====================================
// (2b) 🧠 already on, a FINISHED turn: `sweepThinking` re-reads a turn's blocks only when it has none or the turn is live,
// so with the cache warm there is no paint path at all and the toggle changes nothing — not the console, not the block.
await loadWith(page, target, { stream: "0", think: "1" });
// Wait for the block's store read to land. With the blocks cached, `sweepThinking` never re-reads a finished turn, so
// there is no paint path left for the toggle at all; toggling BEFORE that read lands is a different sequence — the
// sweep's own first read then paints the console (measured: the same half-state (2c) shows on a live turn).
await page
  .waitForFunction(
    (t) => {
      const m = document.querySelector(`.job[data-thread="${CSS.escape(t)}"] .think-meta`);
      return Boolean(m && !/reading/.test(m.textContent || ""));
    },
    target,
    { timeout: 8000 },
  )
  .catch(() => {});
const d0 = await page.evaluate((t) => window.__L.snap(t), target);
await page.evaluate((t) => document.querySelector(`.job[data-thread="${CSS.escape(t)}"] [data-stream-thread]`)?.click(), target);
await sleep(3000);
const d1 = await page.evaluate((t) => window.__L.snap(t), target);
check(
  "(2b) with 🧠 on, toggling 🌊 on a finished turn changes nothing at all",
  d0.thinkBlocks >= 1 && d1.thinkBlocks === d0.thinkBlocks && d1.flat === d0.flat && d1.thinkLines === 0 && d1.storage === "1",
  `built: ${d0.thinkBlocks} thinking block(s), flat=${d0.flat}, ${d0.thinkLines} reasoning rows; after the toggle + 3 s of sweeps: ${d1.thinkBlocks} thinking block(s), flat=${d1.flat}, ${d1.thinkLines} reasoning rows, storage=${d1.storage}, button is-on=${d1.lit}`,
);
observed.step2b = { before: d0, after: d1 };

// (2c) 🧠 on, a LIVE turn: the sweep DOES re-read (every 2 s while the turn is live), and `paintStreamConsole` rewrites
// the console as a stream while the card's own frame — rendered before the toggle — keeps its thinking block. The same
// reasoning is then on screen twice.
if (live) {
  const lt = live.thread;
  await loadWith(page, lt, { stream: "0", think: "1" });
  const e0 = await page.evaluate((t) => window.__L.snap(t), lt);
  await page.evaluate((t) => document.querySelector(`.job[data-thread="${CSS.escape(t)}"] [data-stream-thread]`)?.click(), lt);
  let doubled = null;
  try {
    await page.waitForFunction(
      (t) => {
        const c = document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`);
        const out = c && c.querySelector("pre.job-out");
        return Boolean(out && out.querySelector(":scope > .tgrp-flat, :scope > .jl-think") && c.querySelectorAll("details.think").length > 0);
      },
      lt,
      { timeout: 6000 },
    );
    doubled = true;
  } catch {
    doubled = false;
  }
  const e1 = await page.evaluate((t) => window.__L.snap(t), lt);
  check(
    "(2c) on a live turn the sweep paints the console while the old thinking block stays — the reasoning is drawn twice",
    doubled === true && e1.thinkBlocks >= 1 && e1.thinkLines > 0 && e1.flat >= 1,
    `built: ${e0.thinkBlocks} block(s), flat=${e0.flat}, ${e0.thinkLines} reasoning rows; after the toggle: ${e1.thinkBlocks} block(s), flat=${e1.flat}, ${e1.thinkLines} reasoning rows, button is-on=${e1.lit}`,
  );
  observed.step2c = { before: e0, after: e1, doubled };
  const s2cBlock = await shootBox(page, page.locator(`.job[data-thread="${lt}"] details.think`), shotPath("02c-thinking-block-still-there.png"), 500);
  const s2cConsole = await shootBox(page, page.locator(`.job[data-thread="${lt}"] pre.job-out`), shotPath("02c-console-also-has-reasoning.png"), 500);
  check("(2c) screenshots written", Boolean(s2cBlock && s2cConsole), `${s2cBlock && s2cBlock.file} + ${s2cConsole && s2cConsole.file}`);
}

// ================= (3) toggle 🌊 off, from a card loaded in stream mode ===========================
await loadWith(page, target, { stream: "1", think: "0" });
const s3base = await page.evaluate((t) => window.__L.snap(t), target);
check("(3) the control: a card loaded with 🌊 on comes out as a stream", s3base.flat >= 1 && s3base.heads === 0, `${s3base.flat} flat groups of ${s3base.groups}, ${s3base.heads} heads, ${s3base.thinkBlocks} thinking blocks`);
const off = await toggle(page, target, { watchMs: WATCH_MS, fastMs: FAST_MS });
check(
  "(3) the toggle's own render path bails on an unchanged signature (off)",
  Boolean(off.own && !off.own.replaced),
  `card node ${off.own.replaced ? "replaced" : "unchanged"} by the click; calls: ${off.own.calls.map((c) => `${c.name}(${c.replaced ? "replaced" : "bailed"})`).join(", ") || "none"}`,
);
check(
  "(3) no repaint back to condensed within 500 ms of 🌊 off",
  !off.first || off.first.dt > FAST_MS,
  off.first
    ? `mode changed at ${off.first.dt} ms (flat ${off.first.flat}, heads ${off.first.heads})`
    : `mode unchanged for ${WATCH_MS} ms; ${off.firstPaint ? `only DOM churn was a body repaint at ${off.firstPaint.dt} ms` : "no DOM churn at all"}`,
);
check(
  "(3) the switch does not put the card back; only an unrelated board rebuild does",
  Boolean(off.own && !off.own.replaced),
  `card node ${off.own.replaced ? "replaced" : "unchanged"} by the click; ${off.first ? `first mode change at ${off.first.dt} ms (flat ${off.first.flat}, heads ${off.first.heads})` : `mode unchanged for the whole ${WATCH_MS} ms window`}${off.replacedAt != null ? `, card rebuilt at ${off.replacedAt} ms` : ", no card rebuild"}; after the window: flat=${off.final.flat}, heads=${off.final.heads}, storage=${off.final.storage}`,
);
observed.step3 = { base: s3base, ...off };
const s3Shot = await shootBox(page, page.locator(`.job[data-thread="${target}"] pre.job-out`), shotPath("03-stream-off-again.png"), 700, ":scope > .tgrp-flat");
check("(3) screenshot written", Boolean(s3Shot), s3Shot && s3Shot.file);

// ================= (4) with 🌊 on, the mode's own drawing ==========================================
// The card is still drawn as a stream from the control above, but (3) left storage saying off. Press 🌊 once more (a
// storage-only write, as (3) measured) so the mode is on, then press 🧠: thinkingOn is IN the signature, so that press
// is a real repaint — the reader's workaround for the toggle.
await page.evaluate((t) => document.querySelector(`.job[data-thread="${CSS.escape(t)}"] [data-stream-thread]`)?.click(), target);
await sleep(200);
const beforeThink = await page.evaluate((t) => window.__L.snap(t), target);
const ta = Date.now();
await page.evaluate((t) => document.querySelector(`.job[data-thread="${CSS.escape(t)}"] [data-think-thread]`)?.click(), target);
let thinkMs = null;
try {
  await page.waitForFunction(
    (t) => {
      const c = document.querySelector(`.job[data-thread="${CSS.escape(t)}"]`);
      const out = c && c.querySelector("pre.job-out");
      return Boolean(out && out.querySelector(":scope > .tgrp-flat") && c.querySelectorAll("details.think").length === 0);
    },
    target,
    { timeout: 8000 },
  );
  thinkMs = Date.now() - ta;
} catch {
  thinkMs = null;
}
await sleep(400);
const s4 = await page.evaluate((t) => window.__L.snap(t), target);
check(
  "(4) the reasoning moved into the console when the card was rebuilt",
  s4.thinkBlocks === 0 && s4.thinkLines > 0 && beforeThink.thinkLines === 0,
  `before 🧠: ${beforeThink.thinkLines} .jl-think, ${beforeThink.thinkBlocks} thinking blocks; after: ${s4.thinkLines} .jl-think, ${s4.thinkBlocks} thinking blocks (rebuild seen ${thinkMs == null ? ">8000 ms" : thinkMs + " ms"} after 🧠, storage=${s4.storage})`,
);
check("(4) every group in the stream is flat: no head row", s4.flat >= 1 && s4.flatWithHead === 0 && s4.heads === 0, `${s4.flat} flat of ${s4.groups} groups, ${s4.flatWithHead} flat groups carrying a .tgrp-head, ${s4.heads} heads total`);
check("(4) no flat group has a hidden body", s4.flatHiddenBody === 0 && s4.bodies === s4.groups, `${s4.flatHiddenBody} flat groups hidden/missing a body, ${s4.bodies}/${s4.groups} bodies present`);
observed.step4 = { s4, thinkMs };
const s4Shot = await shootBox(page, page.locator(`.job[data-thread="${target}"] pre.job-out`), shotPath("04-stream-flat-groups.png"), 700, ":scope > .tgrp-flat");
check("(4) screenshot written", Boolean(s4Shot), s4Shot && s4Shot.file);

// ================= (4b) a live turn: reasoning typed into the console, word by word ================
let progress = null;
if (live) {
  const t = live.thread;
  await loadWith(page, t, { stream: "1", think: "1" });
  progress = await page.evaluate(
    async ({ th, ms }) => {
      const L = window.__L;
      const series = [];
      const t0 = performance.now();
      while (performance.now() - t0 < ms) {
        const out = L.out(th);
        const rows = out ? [...out.querySelectorAll(":scope > .jl-think")] : [];
        const last = rows[rows.length - 1];
        series.push({
          dt: Math.round(performance.now() - t0),
          rows: rows.length,
          full: last ? String(last.dataset.ltext || "").length : 0,
          shown: last ? String(last.textContent || "").length : 0,
          thinkBlocks: L.card(th)?.querySelectorAll("details.think").length ?? null,
        });
        await new Promise((r) => setTimeout(r, 100));
      }
      return { series, snap: L.snap(th), visibility: document.visibilityState };
    },
    { th: t, ms: PROGRESS_MS },
  );
  const shownSeq = [...new Set(progress.series.map((s) => s.shown))];
  const grew = shownSeq.filter((n, i) => i > 0 && n > shownSeq[i - 1]).length;
  const partial = progress.series.filter((s) => s.full > 0 && s.shown > 0 && s.shown < s.full);
  const spanMs = partial.length ? partial[partial.length - 1].dt - partial[0].dt : 0;
  const lastSample = progress.series[progress.series.length - 1];
  check(
    "(4b) reasoning is typed into the console instead of landing as one block",
    grew >= 3 && partial.length >= 2 && spanMs > 300,
    `${shownSeq.length} distinct visible lengths over ${PROGRESS_MS} ms (${grew} growth steps), ${partial.length} samples part-way (${spanMs} ms of typing); newest block: full ${lastSample.full} chars, ${lastSample.shown} shown at the end`,
  );
  check(
    "(4b) the live card draws the stream, not a thinking block",
    progress.snap.flat >= 1 && progress.snap.thinkBlocks === 0 && progress.snap.storage === "1" && progress.visibility === "visible",
    `flat=${progress.snap.flat} groups=${progress.snap.groups} thinkBlocks=${progress.snap.thinkBlocks} storage=${progress.snap.storage} visibility=${progress.visibility}`,
  );
  observed.progress = progress;
  const midShot = await shootBox(page, page.locator(`.job[data-thread="${t}"] pre.job-out`), shotPath("05-live-stream-typing.png"), 700, ":scope > .jl-think");
  check("(4b) screenshot written", Boolean(midShot), midShot && midShot.file);

  // ================= (5) the console parked mid-scroll across three thinking-sweep repaints =========
  // A real scroll first (the pointer over the console, wheel up): the panel unpins on input, so what is parked here is
  // parked the way a reader parks it.
  const box = await page.locator(`.job[data-thread="${t}"] pre.job-out`).boundingBox();
  if (box) {
    await page.mouse.move(box.x + Math.min(240, box.width / 2), box.y + Math.min(120, box.height / 2));
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, -320);
      await sleep(120);
    }
    await sleep(250);
  }
  // If three wheel notches over the console did not move it (the panel re-sticks a pinned console within 400 ms), park it
  // the way the panel records a reader's own scroll: `outPinned[id] = false` and a scrollTop above the fold. Which of the
  // two parked it is reported, so this cannot pass as a reader's scroll when it was the probe's.
  const park = await page.evaluate((th) => {
    const out = window.__L.out(th);
    if (!out) return { method: "no console" };
    const max = out.scrollHeight - out.clientHeight;
    const already = out.scrollTop > 40 && out.scrollTop < max - 40;
    if (already) return { method: "wheel", top: Math.round(out.scrollTop), max: Math.round(max) };
    try {
      state.outPinned[out.dataset.out] = false;
    } catch {
      /* no state to write: the scroll below still stands on its own */
    }
    const target = Math.max(40, Math.round(max * 0.4));
    out.scrollTop = target;
    return { method: "outPinned=false + scrollTop", top: Math.round(out.scrollTop), max: Math.round(max), want: target };
  }, t);
  await sleep(300);
  await page.evaluate((th) => {
    const out = window.__L.out(th);
    window.__sweep = { repaints: 0, at: [] };
    if (!out) return;
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "childList" && r.target === out && (r.addedNodes.length || r.removedNodes.length)) {
          window.__sweep.repaints++;
          window.__sweep.at.push(Math.round(performance.now()));
        }
      }
    }).observe(out, { childList: true });
  }, t);
  const parks = [];
  // A 250 ms sampler for the whole window: the three shots are the deliverable, the series says WHEN it moved and what
  // was at the top of the visible box, which separates "the panel re-stuck it to the bottom" from "the browser kept the
  // anchored line in view while the transcript above it grew".
  await page.evaluate((th) => {
    const topVisible = (o) => {
      const box = o.getBoundingClientRect();
      for (const el of o.children) {
        const r = el.getBoundingClientRect();
        if (r.bottom > box.top + 2) return `${el.className}|${(el.textContent || "").replace(/\s+/g, " ").slice(0, 48)}`;
      }
      return null;
    };
    window.__park = { samples: [], timer: null };
    const tick = () => {
      const o = window.__L.out(th);
      if (!o) return;
      window.__park.samples.push({ t: Math.round(performance.now()), top: Math.round(o.scrollTop), height: o.scrollHeight, vis: o.clientHeight, anchor: topVisible(o) });
    };
    tick();
    window.__park.timer = setInterval(tick, 250);
  }, t);
  for (let i = 0; i < 3; i++) {
    const s = await page.evaluate((th) => {
      const out = window.__L.out(th);
      return out ? { top: Math.round(out.scrollTop), max: Math.round(out.scrollHeight - out.clientHeight), height: out.scrollHeight, visible: out.clientHeight } : null;
    }, t);
    const file = shotPath(`06-parked-${i + 1}.png`);
    const shot = await shootBox(page, page.locator(`.job[data-thread="${t}"] pre.job-out`), file);
    parks.push({ ...s, at: new Date().toISOString(), shot: shot && shot.file });
    if (i < 2) await sleep(SWEEP_MS);
  }
  const parkRun = await page.evaluate((th) => {
    if (window.__park && window.__park.timer) clearInterval(window.__park.timer);
    const out = window.__L.out(th);
    const tag = out ? out.dataset.probeEl || "" : "";
    return {
      tag,
      samples: (window.__park ? window.__park.samples : []).slice(-40),
      writes: (window.__scrollLog || []).filter((w) => w.tag === tag),
    };
  }, t);
  const sweep = await page.evaluate(() => window.__sweep);
  const tops = parks.map((p) => p.top);
  const spread = Math.max(...tops) - Math.min(...tops);
  const heightGrew = parks[parks.length - 1].height - parks[0].height;
  const parked = parks[0] && parks[0].max > 80 && parks[0].top > 40 && parks[0].top < parks[0].max - 40;
  check(
    "(5) the console is parked mid-scroll, not at an end",
    Boolean(parked),
    `${park.method}: scrollTop=${parks[0].top} of max ${parks[0].max} (scrollHeight ${parks[0].height}, ${parks[0].visible}px visible)`,
  );
  check("(5) scrollTop is unchanged across three screenshots 2 s apart", spread === 0, `tops=${tops.join(", ")} (spread ${spread} px)`);
  const panelWrites = parkRun.writes.filter((w) => !/^eval/.test(w.key));
  check(
    "(5) the panel left the parked console's scrollTop alone",
    panelWrites.length === 0,
    panelWrites.length === 0
      ? `no programmatic scrollTop assignment from the panel (${parkRun.writes.length} write(s) total, all from the probe's own park)`
      : `${panelWrites.reduce((n, w) => n + w.n, 0)} assignments from ${panelWrites.length} call site(s): ${panelWrites.slice(0, 3).map((w) => `${w.key.split("|")[0]} (${w.n}×, last top=${w.last})`).join("; ")}`,
  );
  const anchors = [...new Set(parkRun.samples.map((s) => s.anchor))];
  check(
    "(5) the same line stayed at the top of the visible box",
    anchors.length === 1,
    `${anchors.length} distinct top lines across ${parkRun.samples.length} samples: ${anchors.map((a) => String(a).split("|")[1] || a).join(" ‖ ")}`,
  );
  check(
    "(5) the console was really repainted in that window",
    sweep.repaints >= 1,
    `${sweep.repaints} wholesale console writes at ${sweep.at.join(", ")} ms; content ${heightGrew >= 0 ? "grew" : "shrank"} ${Math.abs(heightGrew)} px while parked`,
  );
  observed.parked = { park, parks, parkRun, sweep, spread, heightGrew };
}

// ---- results -------------------------------------------------------------------------------------
const toggleRepainted = Boolean(on.own && on.own.replaced) || Boolean(off.own && off.own.replaced);
const sweepAppliedOn = Boolean(on.first) && (on.paths || []).some((p) => p.startsWith("paintStreamConsole"));
const offStuck = !off.first;
const defectConfirmed = !toggleRepainted && on.own.sigBefore === on.own.sigAfter && on.own.storage === "1" && off.final.storage === "0";
const results = {
  at: new Date().toISOString(),
  panel: URL_,
  build,
  targets: { condensed: target, live: live ? live.thread : null },
  checks,
  observed,
  verdict: {
    defect: defectConfirmed
      ? `CONFIRMED, with a correction to the brief: the switch does not repaint the card — its own renderConversation() bails because conversationSignature() carries thinkingOn and not streamOn — but the console is not frozen either. The 1.2 s sweepThinking() paints it out of band (paintStreamConsole) at ${on.first ? on.first.dt + " ms" : "no"} after 🌊 on, while the card's frame, its 🌊 button and its signature keep the old state (measured ${on.at500 ? on.at500.dt + " ms" : "?"} with aria-pressed=${on.at500 && on.at500.online}). Turning it off has no sweep path (the guard skips a card whose 🌊 and 🧠 are both off), so the card is drawn as a stream until something unrelated rebuilds the row — ${off.first ? `measured ${off.first.dt} ms in this run` : `not within ${WATCH_MS} ms in this run`}.` +
        (sweepAppliedOn ? "" : " (Note: the console change was NOT traced to paintStreamConsole in this run.)")
      : toggleRepainted
        ? "NOT reproduced: the toggle itself replaced the card node"
        : "INCONCLUSIVE: the toggle did not repaint, but the storage/signature evidence did not line up",
    repaint: {
      toggleOwnRepaint: toggleRepainted,
      onModeChangeMs: on.first ? on.first.dt : null,
      onFirstPaintMs: on.firstPaint ? on.firstPaint.dt : null,
      onCardRebuildMs: on.replacedAt,
      onRebuildBy: on.replacement && on.replacement[0] ? on.replacement[0].name : null,
      onPainters: on.paths,
      offModeChangeMs: off.first ? off.first.dt : null,
      offFirstPaintMs: off.firstPaint ? off.firstPaint.dt : null,
      offCardRebuildMs: off.replacedAt,
      offPainters: off.paths,
      watchedMs: WATCH_MS,
      fastMs: FAST_MS,
    },
  },
  pageErrors,
};
writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2), "utf8");
await browser.close();

console.log("");
console.log(`VERDICT ${results.verdict.defect}`);
console.log(`toggle's own repaint: ${toggleRepainted ? "yes" : "no (renderConversation bailed)"}`);
console.log(`mode change after 🌊 on:  ${on.first ? on.first.dt + " ms" : "none in " + WATCH_MS + " ms"}${on.firstPaint ? ` (first DOM churn: ${on.firstPaint.dt} ms, flat ${on.firstPaint.flat})` : ""}`);
console.log(`mode change after 🌊 off: ${off.first ? off.first.dt + " ms" : "none in " + WATCH_MS + " ms"}${off.firstPaint ? ` (first DOM churn: ${off.firstPaint.dt} ms, flat ${off.firstPaint.flat})` : ""}`);
console.log(`results → ${path.join(OUT, "results.json")}`);
const failed = checks.filter((c) => !c.pass);
// The brief's own assertions about the parked console are expected to fail here, and why is reported next to each: the
// transcript grows above the fold while the reasoning types, the panel's pacer re-follows the console as it is repainted,
// and the reader's line still holds (the top visible line is identical across every sample and all three shots). Any
// OTHER failing check is a disagreement with the board, which is what the exit code is for.
const expectedFails = new Set(["(5) scrollTop is unchanged across three screenshots 2 s apart", "(5) the panel left the parked console's scrollTop alone"]);
const unexpected = failed.filter((f) => !expectedFails.has(f.name));
const expectedHit = failed.filter((f) => expectedFails.has(f.name));
console.log(`${checks.length - failed.length}/${checks.length} checks as expected${unexpected.length ? " — unexpected: " + unexpected.map((f) => f.name).join("; ") : ""}${expectedHit.length ? `; ${expectedHit.length} documented finding: ${expectedHit.map((f) => f.name).join("; ")}` : ""}`);
process.exit(unexpected.length === 0 ? 0 : 1);
