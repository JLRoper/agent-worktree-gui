#!/usr/bin/env node
// HARNESS: LIVE GATE
// The agent console's bottom-right corner, dragged for real in the LIVE panel the reader is using, and read at every
// step from the source the panel itself stores the size in - never from a screenshot.
//
//   node tools/verify-console-corner-drag.mjs                       # http://127.0.0.1:7331, the live panel
//   node tools/verify-console-corner-drag.mjs --url http://host:port
//   node tools/verify-console-corner-drag.mjs --serve <checkout>   # that checkout's public/ served over the panel
//   node tools/verify-console-corner-drag.mjs --json               # one JSON object, checks on stderr
//   node tools/verify-console-corner-drag.mjs --trace <file>       # every step of every case as JSON
//   node tools/verify-console-corner-drag.mjs --cause-check        # the slow drag with the browser's anchoring off
//   node tools/verify-console-corner-drag.mjs --widths 1600,820 --sizes 140,460
//   node tools/verify-console-corner-drag.mjs --press-sizes 140,300,460,620 --press-zooms 100,90
//   node tools/verify-console-corner-drag.mjs --inner-height 1080
//
// WHAT THIS GUARDS. The console's corner grip (`pre.job-out` under `.out-box > .out-grip`) has one stored size and one
// writer: `setOutHeight` into `--out-h` (public/board/console.js:3753), remembered on release in `state.outHeights`
// keyed by `pre.dataset.out` (public/app.js:695). The gesture (public/app.js:10612) freezes the box's TOP edge at the
// press and writes `height = pointer + grab - frozenTop` on every move, so that nothing else may move that edge.
//
// A size that is written correctly can still be a corner that does not move: if something scrolls the transcript by
// exactly the height the drag adds, the box's top travels the other way and `top + height` - the corner the hand is
// on - stands still. So every case asserts THREE numbers, not one: the stored number, the rendered client size, and
// the grip's own bottom edge against the pointer. A store-versus-render check alone passes this defect (delta 0 while
// the hand runs 60 px past the corner), which is why the corner is read as well - at every step, and READ AGAIN IN THE
// FRAME AFTER THE RELEASE, because the release's own foot write was a scroll of exactly the drag's travel and undid
// every drag that had worked (row 316).
//
// A transcript on its foot has no offset room for a SHRINK, so below the height the press found the box cannot follow
// and the scrollport's clamp takes the top edge down with it. That is a floor like the sheet's min-height: it is judged
// by the size and store checks, not as a corner the gesture lost, and the floor is read where the press found it (how
// far the transcript was from its foot).
//
// THE MATRIX. Two viewport widths (wide 1600, narrow 820 - the docked rail caps at half the window, so the console is
// 463 px wide at one and 383 px at the other), and two starting sizes (small 140 px, large 460 px). At each: slow
// (30 moves of 2 px), flick (one 120 px move, release on the next tick), past-min (10 moves of -40 px), past-max
// (15 moves of +60 px, past the room under the box), crossing (down, up past the starting corner, sideways across
// it, back down), interrupted by a state poll (`resync`), interrupted by a transcript repaint (an artifact change,
// then the panel's own `updateJob` -> `renderConversation`), and no-move (a press, then a double-click).
//
// THE PRESS-ONLY ROWS (row 332). A press with NO movement, held half a second and released, at every width, at four
// heights, and at the page's own zoom 100 AND 90. Each row asserts the drawn height, the top edge and the corner hold
// still to within 1px while the hand is down, and that the release puts the box back exactly - the reader's report was
// a corner that moved ~50px on the press alone, and the drag matrix's no-move case could not see it because the
// release undid the jump before it read the box. The 90% rows are the shape that carried it: the drawn height is a
// visual length and `--out-h` is a layout one.
//
// The browser half needs a Playwright install (PANEL_PLAYWRIGHT_ROOT or the global npm prefix), exactly like every
// other harness in tools/. It starts no server and restarts nothing: it opens the panel at --url in its own isolated
// browser context, so the reader's tab, its localStorage and its stored heights are untouched.
//
// WHY `--serve`. The gesture lives in the page, so the panel that serves it has to be the build under test. Restarting
// the reader's panel under them is not something a gate may do, and a second instance has no transcript to drag (cards
// are per process). So `--serve <checkout>` answers the page's own requests from that checkout's `public/` and lets
// everything else - the API, the SSE stream, the row scans - come from the running panel. One gate, one set of live
// data, two trees: the pre-fix commit measures the defect and the fixed tree measures the fix, with no server started,
// restarted or reconfigured.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REPO, loadPlaywright, notRun } from "./browser.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};

const BASE = String(opt("url", process.env.PANEL_URL || "http://127.0.0.1:7331")).replace(/\/$/, "");
// The checkout whose `public/` the page is built from, or null for the panel's own (the ordinary run).
const SERVE = opt("serve", null) ? path.resolve(opt("serve", null)) : null;
// A `--serve` that names no checkout is a run that would measure the PANEL's own files and report a pass on a tree
// nobody served - the route's `continue()` fallback hides it, so it is refused here instead. (A git-bash `$PWD` is
// `/c/...`, which path.resolve turns into a broken drive-letter path: the exact mistake this guard exists to stop.)
if (SERVE && !existsSync(path.join(SERVE, "public", "index.html"))) {
  console.error(`--serve ${SERVE} has no public/index.html: refusing to measure the panel's own files instead`);
  process.exit(2);
}
const MIME = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
};
const JSON_OUT = flag("json");
const TRACE = opt("trace", null);
const CAUSE = flag("cause-check");
const WIDTHS = String(opt("widths", "1600,820")).split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);
const SIZES = String(opt("sizes", "140,460")).split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);
// THE PRESS-ONLY MATRIX. A pointerdown that moves nothing must move nothing: the corner, the box and the store read
// before the press, at the end of a half-second hold, and after the release. The drag matrix's no-move case reads only
// the before and the after, so a box that jumps ON the press and is put back on the release passed it - the reader's
// press-only report (a press with no movement moved the corner about 5% of the screen height, because the drawn height
// is a VISUAL length and `--out-h` is a LAYOUT one: on a page at 90% the press wrote the visual number and the box came
// back at 90% of itself). So the rows run at the page's own zoom as well as at 100: a zoom is the shape that carried
// the defect, and a gate that only ever ran at 100 could not see it.
const PRESS_SIZES = String(opt("press-sizes", "140,300,460,620")).split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);
const PRESS_ZOOMS = String(opt("press-zooms", "100,90")).split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);
const PRESS_HOLD_MS = 500;
const PRESS_TOLERANCE_PX = 1; // the brief's number: a press-only row fails above 1px of movement
// THE VIEWPORT HEIGHT. It was hard-coded at 900, and a live chat pane at 820x900 can scroll the open turn's console
// out of its own scrollport: the transcript is on its foot, the console sits at the turn's top, and the corner the
// gesture needs is then drawn above the pane and painted over by the pane's tabs, so every press misses the band and
// the case reports a drag that never happened (measured on origin/main 83ec04e: 16 of 32 drag cases, all at 820).
// 1080 is the reader's screen and the shape tools/measure-console-press-only.mjs measures at; --inner-height keeps
// 900 available for a reproduction, and a press that cannot reach the corner now says so instead of failing as a drag.
const INNER_H = Number(opt("inner-height", 1080)) || 1080;
// A hand lands a few px inside an 18 px band; 3 px is inside it, and 2 px is the repo's corner tolerance.
const GRIP_INSET_PX = 3;
const CORNER_TOLERANCE_PX = 2;
const SIZE_TOLERANCE_PX = 2;
const STEP_MS = 35;
const SETTLE_MAX_MS = 2000;
const OPEN_KEY = "wm.assistantOpen";
const OUT_GRIP_ROOM_PX = 8;

const results = [];
function check(ok, label, detail) {
  results.push({ ok: Boolean(ok), label, detail: detail == null ? "" : String(detail) });
  const line = `${ok ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`;
  if (JSON_OUT) console.error(line);
  else console.log(line);
}

// The page half. Everything is looked up at call time: a repaint may replace the console node, and a helper that
// remembered the old one would measure a node the reader is not holding.
const PAGE_HELPERS = (gripInset) => {
  const pane = () => [...document.querySelectorAll('#assistant [data-subpane="chat"]')].find((p) => p.getBoundingClientRect().width > 80) || null;
  const body = () => pane()?.querySelector(":scope > .job > .job-body") || null;
  const openTurns = () => (body() ? [...body().querySelectorAll(":scope > .turn:not(.folded)")] : []);
  const out = () => {
    const turns = openTurns();
    for (let i = turns.length - 1; i >= 0; i -= 1) {
      const o = turns[i].querySelector(":scope > .out-wrap > .out-box > pre.job-out");
      if (o) return o;
    }
    return null;
  };
  const grip = () => {
    const o = out();
    return o ? o.parentElement.querySelector(":scope > .out-grip") : null;
  };
  const store = () => {
    let ls = {};
    try { ls = JSON.parse(localStorage.getItem("wm.outHeights") || "{}"); } catch { /* unreadable is empty */ }
    return { state: (typeof state !== "undefined" && state.outHeights) || {}, ls };
  };
  const W = { writes: [], mutations: { child: 0, style: 0, other: 0 }, observer: null, node: null };

  window.__CD = {
    pane, body, out, grip, openTurns,
    thread: () => body()?.closest(".job")?.dataset.thread || "",
    // A few px inside the corner: the band is 18 px and a hand lands a couple of px in.
    at: () => {
      const g = grip();
      if (!g) return null;
      const r = g.getBoundingClientRect();
      return { x: +(r.right - gripInset).toFixed(1), y: +(r.bottom - gripInset).toFixed(1) };
    },
    // WHAT IS AT THE CORNER'S POINT. A press that misses the band is a case that measured nothing, and a bare miss
    // cannot tell a hand that was a pixel off from a corner the pane's own tabs are painting over (a live transcript
    // scrolled to its foot can leave the open turn's console above the scrollport, so the corner is drawn - and is
    // not pressable - outside the pane). The verdicts quote this instead of reporting a drag that never happened.
    hit: (pt) => {
      const g = grip();
      const el = pt ? document.elementFromPoint(pt.x, pt.y) : null;
      const name = (n) => {
        if (!n) return "nothing";
        const cls = typeof n.className === "string" && n.className.trim() ? `.${n.className.trim().split(/\s+/).join(".")}` : "";
        return `${n.tagName.toLowerCase()}${cls}`;
      };
      return { onGrip: Boolean(g && el && (el === g || g.contains(el))), at: name(el) };
    },
    // Every number a case is a statement about. `stored` is the panel's own store (state.outHeights, keyed by the
    // console's id) and `varH` the one writer's CSS variable - the same number through the two ends of its life.
    read: () => {
      const o = out();
      const g = grip();
      const b = body();
      if (!o || !g || !b) return null;
      const r = o.getBoundingClientRect();
      const gr = g.getBoundingClientRect();
      const s = store();
      const id = o.dataset.out || "";
      const varRaw = o.style.getPropertyValue("--out-h") || "";
      return {
        t: Math.round(performance.now()),
        id,
        h: +r.height.toFixed(2),
        clientH: o.clientHeight,
        top: +r.top.toFixed(2),
        bottom: +r.bottom.toFixed(2),
        varH: varRaw,
        varPx: varRaw ? parseFloat(varRaw) : null,
        stored: Number.isFinite(Number(s.state[id])) ? Number(s.state[id]) : null,
        storedLs: Number.isFinite(Number(s.ls[id])) ? Number(s.ls[id]) : null,
        gripBottom: +gr.bottom.toFixed(2),
        gripRight: +gr.right.toFixed(2),
        minH: (() => {
          // The floor the box actually draws at: the sheet's min-height, or the console's own padding box, whichever is
          // larger. The gesture clamps to the same pair (public/app.js endOutGrip), and a gate that read only
          // min-height measured a 1px store against an 18px box as a 17px defect.
          const pad = (parseFloat(getComputedStyle(o).paddingTop) || 0) + (parseFloat(getComputedStyle(o).paddingBottom) || 0) +
            (parseFloat(getComputedStyle(o).borderTopWidth) || 0) + (parseFloat(getComputedStyle(o).borderBottomWidth) || 0);
          return Math.max(parseFloat(getComputedStyle(o).minHeight) || 0, Math.round(pad));
        })(),
        maxH: getComputedStyle(o).maxHeight,
        inlineMax: o.style.maxHeight,
        content: o.scrollHeight,
        ownTop: o.scrollTop,
        bodyTop: b.scrollTop,
        bodyMax: b.scrollHeight - b.clientHeight,
        bodyH: b.clientHeight,
        paneW: Math.round(pane().getBoundingClientRect().width),
        held: typeof outDragging === "function" ? outDragging(o) : null,
        dragH: typeof outGripDrag !== "undefined" && outGripDrag ? +Number(outGripDrag.h).toFixed(2) : null,
        dragTop: typeof outGripDrag !== "undefined" && outGripDrag ? +Number(outGripDrag.top).toFixed(2) : null,
        moved: typeof outGripDrag !== "undefined" && outGripDrag ? Boolean(outGripDrag.moved) : null,
        same: o === W.node,
        sig: b.closest(".job")?.dataset.sig || "",
        artifacts: (typeof state !== "undefined" && state.jobs?.get(o.dataset.out)?.artifacts?.length) || 0,
        slack: Boolean(b.querySelector(":scope > .turn.is-slack")),
        display: getComputedStyle(o).display,
        flex: getComputedStyle(o).flex,
        // The page's own zoom, as the gesture reads it: the scale between a visual rect and a layout height. A
        // press-only row at a zoom other than 1 is the shape the reader's report came from.
        zoom: getComputedStyle(document.documentElement).zoom || "1",
      };
    },
    mark: () => { W.node = out(); return true; },
    // The transcript on its foot: the reader's state while a live turn is being read, and the state the legend
    // (public/style.css:1559) says the corner gesture stands the page's tail pin down for.
    foot: () => {
      const b = body();
      if (!b) return null;
      b._atBottom = true;
      b.scrollTop = b.scrollHeight;
      return { top: b.scrollTop, max: b.scrollHeight - b.clientHeight };
    },
    // The starting size, through the page's ONE writer, and recorded in the panel's own store as a size the reader
    // chose - so a case starts from the state a reader's panel is actually in, and a drag that stores nothing can be
    // told apart from a drag that stored the same number again.
    setStart: (px) => {
      const o = out();
      if (!o || typeof setOutHeight !== "function") return null;
      setOutHeight(o, px);
      if (typeof rememberOutHeight === "function") rememberOutHeight(o.dataset.out, px);
      const b = body();
      if (b) { b._atBottom = true; b.scrollTop = b.scrollHeight; }
      return { h: +o.getBoundingClientRect().height.toFixed(2), varH: o.style.getPropertyValue("--out-h") };
    },
    // Count the JS writes to the transcript's scrollTop while the hand is down. A body that moved with zero writes
    // was moved by something outside the page's code - the browser's own scroll anchoring - which is the difference
    // between "a pin is back in the gesture" and "the anchor this design deliberately leaves on is the writer".
    instrument: () => {
      W.writes = [];
      W.mutations = { child: 0, style: 0, other: 0 };
      if (!W.origScrollTop) {
        const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
        W.origScrollTop = desc;
        Object.defineProperty(Element.prototype, "scrollTop", {
          configurable: true,
          get: desc.get,
          set(v) {
            try {
              const b = body();
              if (b && this === b && W.writes.length < 8) {
                W.writes.push({ to: Math.round(Number(v) || 0), from: desc.get.call(this), at: new Error().stack.split("\n").slice(2, 5).join(" <- ") });
              }
            } catch { /* a page without the chat pane writes nothing to it */ }
            return desc.set.call(this, v);
          },
        });
      }
      const o = out();
      if (W.observer) W.observer.disconnect();
      if (o) {
        W.observer = new MutationObserver((recs) => {
          for (const r of recs) {
            if (r.type === "childList") W.mutations.child += 1;
            else if (r.type === "attributes" && r.attributeName === "style") W.mutations.style += 1;
            else W.mutations.other += 1;
          }
        });
        W.observer.observe(o, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class"] });
      }
      return true;
    },
    stopInstrument: () => {
      if (W.observer) { W.observer.disconnect(); W.observer = null; }
      return { ...W.mutations, bodyWrites: W.writes.length, stacks: W.writes.slice(0, 4) };
    },
    // A line from the stream, through the page's own append path: the live turn's ordinary growth.
    feed: (n) => {
      const o = out();
      if (!o || typeof appendJobLine !== "function") return false;
      const text = `streamed sentence ${n}: the transcript keeps writing while the hand is on the corner`;
      appendJobLine({ id: o.dataset.out, line: { kind: "text", mode: "set", lid: "cd1", text: text + " ".repeat(n % 2), at: Date.now() } });
      return true;
    },
    // A repaint with the hand down, through the panel's own live path: an artifact on the running turn changes the
    // card's signature (public/render-jobs.js conversationSignature), updateJob hands it to renderConversation (which
    // asks `outGripHoldsCard`, public/render-jobs.js:1093), and the assistant's OWN renderer is asked as a snapshot
    // would ask it (public/assistant.js:2318 does host.innerHTML = conversationHtml(conv), with no hold question).
    repaint: () => {
      const o = out();
      const job = o && typeof state !== "undefined" ? state.jobs.get(o.dataset.out) : null;
      if (!job || typeof updateJob !== "function") return { painted: false, sigChanged: false };
      const t = body()?.closest(".job")?.dataset.thread;
      // The signature the repaint is owed for, read from the model on both sides of the change: this is the number
      // renderConversation compares, and reading it here keeps the case non-vacuous even when a snapshot lands.
      const sigOf = () => {
        try {
          const conv = typeof conversations === "function" ? conversations().find((c) => c.thread === t) : null;
          return conv && typeof conversationSignature === "function" ? conversationSignature(conv) : "";
        } catch { return ""; }
      };
      const before = sigOf();
      const artifacts = Array.isArray(job.artifacts) ? job.artifacts : [];
      updateJob({ ...job, artifacts: [...artifacts, { name: `corner-probe-${artifacts.length + 1}.txt`, kind: "file", at: Date.now() }] });
      const after = sigOf();
      if (t && typeof window.__assistantRenderChat === "function") window.__assistantRenderChat(t);
      return { painted: true, sigChanged: before !== after && before !== "" };
    },
    // The panel's own state poll (public/app.js's 30 s anti-entropy read).
    poll: () => {
      if (typeof resync !== "function") return false;
      void resync({ automatic: true });
      return true;
    },
    // DIAGNOSTIC ONLY (never part of a pass/fail): suppress the browser's scroll anchoring on the transcript, so the
    // numbers say whether the anchor is the loop moving the box's top edge. `important`, because a repaint that
    // rebuilds the card drops a plain inline property with it, and the property has to survive the gesture.
    anchor: (on) => {
      const b = body();
      if (!b) return null;
      if (on) b.style.setProperty("overflow-anchor", "none", "important");
      else b.style.removeProperty("overflow-anchor");
      return getComputedStyle(b).overflowAnchor;
    },
    version: () => (typeof state !== "undefined" && state.settings ? state.settings.version : ""),
  };
};

const READY = (gripInset) => {
  const panes = [...document.querySelectorAll('#assistant [data-subpane="chat"]')];
  const pane = panes.find((p) => p.getBoundingClientRect().width > 80);
  if (!pane) return { ok: false, why: "the chat pane is not on screen" };
  const body = pane.querySelector(":scope > .job > .job-body");
  const turns = body ? [...body.querySelectorAll(":scope > .turn:not(.folded)")] : [];
  let o = null;
  for (let i = turns.length - 1; i >= 0 && !o; i -= 1) o = turns[i].querySelector(":scope > .out-wrap > .out-box > pre.job-out");
  if (!body || !o) return { ok: false, why: "no open turn with a console" };
  const g = o.parentElement.querySelector(":scope > .out-grip");
  if (!g) return { ok: false, why: "the console has no corner grip" };
  const r = o.getBoundingClientRect();
  const gr = g.getBoundingClientRect();
  return {
    ok: true,
    turns: turns.length,
    paneW: Math.round(pane.getBoundingClientRect().width),
    consoleW: Math.round(r.width),
    consoleH: Math.round(r.height),
    gripInset,
    inView: gr.bottom > 8 && gr.bottom <= innerHeight - 2 && gr.right > 8 && gr.right <= innerWidth - 2,
  };
};

async function loadPanel(page) {
  // The build under test, served over the live panel's data (`--serve`): every request that has a file in the
  // checkout's public/ is answered from it, with the query string the panel appends dropped, and everything else
  // (the API, SSE, anything the panel generates) goes to the panel. No file, no claim: a 404 from the checkout falls
  // through rather than shadowing the panel's own answer.
  if (SERVE) {
    const root = path.join(SERVE, "public");
    await page.route(`${BASE}/**`, async (route) => {
      const url = new URL(route.request().url());
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
      const file = path.resolve(root, rel);
      if (!file.startsWith(path.resolve(root) + path.sep)) return route.continue();
      try {
        const body = readFileSync(file);
        const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
        return await route.fulfill({ status: 200, contentType: type, body });
      } catch {
        return route.continue();
      }
    });
  }
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 45_000 });
  // The live board renders ~190 project cards on its first paint and the page can block for several seconds; the
  // chat pane is torn down and painted again inside that. Wait for a console with a grip, not for a clock.
  let ready = null;
  for (let i = 0; i < 100; i += 1) {
    ready = await page.evaluate(READY, GRIP_INSET_PX).catch(() => null);
    if (ready && ready.ok && ready.inView) break;
    if (i === 8) {
      // The assistant may be closed: open it through its own button, once.
      await page.evaluate(() => {
        if (typeof state !== "undefined" && !state.assistantOpen) document.querySelector("#btn-assistant")?.click();
      }).catch(() => {});
    }
    await page.waitForTimeout(500);
  }
  if (!ready || !ready.ok) throw new Error(`no console with a corner grip in the live chat pane: ${ready ? ready.why : "the page did not answer"}`);
  await page.evaluate(PAGE_HELPERS, GRIP_INSET_PX);
  return ready;
}

// The grip's corner, once its rect holds still across two reads: a press aimed at where the grip WAS lands on the
// transcript when the foot pin finishes a frame later, and a press that misses is a case that measured nothing.
async function aim(page) {
  let last = null;
  for (let k = 0; k < 40; k += 1) {
    const g = await page.evaluate(() => window.__CD.at());
    if (last && g && Math.abs(g.y - last.y) < 0.5 && Math.abs(g.x - last.x) < 0.5) return g;
    last = g;
    await page.waitForTimeout(50);
  }
  return last;
}

// One press: the pointer onto the grip, down, and the row that says what the press found. A press that did not reach
// the band is taken again from a fresh aim rather than measured as a drag of nothing.
async function press(page) {
  let at = null;
  let down = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    at = await aim(page);
    if (!at) throw new Error("the grip went away before the press");
    await page.evaluate(() => { window.__CD.mark(); window.__CD.instrument(); });
    await page.mouse.move(at.x, at.y);
    await page.waitForTimeout(40);
    await page.mouse.down();
    await page.waitForTimeout(60);
    down = await page.evaluate(() => window.__CD.read());
    if (down && down.held === true) break;
    // Why it missed, so the case says "the corner is not pressable here" instead of "the drag failed".
    const hit = await page.evaluate((pt) => window.__CD.hit(pt), at);
    down = down ? { ...down, hit } : down;
    await page.mouse.up();
    await page.waitForTimeout(120);
  }
  return { at, down: down ? { ...down, pointerX: at.x, pointerY: at.y } : null };
}

async function move(page, x, y, wait = STEP_MS) {
  await page.mouse.move(x, y);
  if (wait) await page.waitForTimeout(wait);
  const r = await page.evaluate(() => window.__CD.read());
  return r ? { ...r, pointerX: +x.toFixed(1), pointerY: +y.toFixed(1) } : null;
}

// The release, then the time it takes the box to stop moving: three consecutive equal heights/tops, sampled per frame.
// The gesture's own writers are snapshotted BEFORE the release, so the count is the drag's and not the foot pin the
// release writes once.
async function release(page) {
  const during = await page.evaluate(() => window.__CD.stopInstrument());
  await page.mouse.up();
  const t0 = Date.now();
  let last = null;
  let same = 0;
  let lastChange = 0;
  let finalH = null;
  while (Date.now() - t0 < SETTLE_MAX_MS) {
    const cur = await page.evaluate(() => {
      const o = window.__CD.out();
      if (!o) return null;
      const r = o.getBoundingClientRect();
      return { h: +r.height.toFixed(2), top: +r.top.toFixed(2), at: Date.now() };
    });
    if (cur) {
      if (last && (Math.abs(cur.h - last.h) >= 0.26 || Math.abs(cur.top - last.top) >= 0.26)) {
        lastChange = cur.at - t0;
        same = 0;
      } else {
        same += 1;
      }
      last = cur;
      finalH = cur.h;
      if (same >= 3) break;
    }
    await page.waitForTimeout(16);
  }
  const settleMs = Math.max(0, Math.round(lastChange));
  const after = await page.evaluate(() => window.__CD.read());
  return { settleMs, after, writes: during, finalH };
}

// The starting size for a case, through the page's writer, verified against the rendered box. `z` is the page's own
// zoom: the writer speaks layout px, the rect is visual, so the drawn height it is checked against is `px * z`.
async function startSize(page, px, z = 1) {
  for (let i = 0; i < 5; i += 1) {
    const set = await page.evaluate((n) => window.__CD.setStart(n), px);
    await page.waitForTimeout(120);
    const now = await page.evaluate(() => window.__CD.read());
    if (now && Math.abs(now.h - px * z) <= 1.5) return now;
    if (!set) break;
  }
  return page.evaluate(() => window.__CD.read());
}

// The page's own zoom, the way the reader sets it (Settings > Display, applyZoom in public/settings.js): a layout scale
// on documentElement, so `getBoundingClientRect()` and a pointer are visual px and `--out-h` is a layout length.
async function applyZoom(page, pct) {
  await page.evaluate((n) => {
    document.documentElement.style.zoom = n === 100 ? "" : String(n / 100);
    try { localStorage.setItem("wtgui.zoom", String(n)); } catch { /* private mode */ }
    if (typeof state !== "undefined") state.zoom = n;
  }, pct);
  await page.waitForTimeout(220);
}

// ---- the cases ---------------------------------------------------------------------------------------------------
// Each pushes the rows it read, one per pointer move, with the pointer's own y beside the page's numbers. The press
// and the release are the framework's; only the motion is the case's.

const CASES = {
  // The reader's report: a slow hand, 2 px at a time, 30 moves.
  slow: async (page, g) => {
    const rows = [];
    for (let i = 1; i <= 30; i += 1) rows.push(await move(page, g.press.x, g.press.y + i * 2, 30));
    return rows;
  },
  // One big move and the hand is off: the coalesced case, where the pointerup can carry a position the last
  // pointermove never saw.
  flick: async (page, g) => {
    const rows = [await move(page, g.press.x, g.press.y + 120, 0)];
    await page.waitForTimeout(8);
    return rows;
  },
  // Past the sheet's floor: 400 px up, which is past `min-height` from either starting size.
  "past-min": async (page, g) => {
    const rows = [];
    for (let i = 1; i <= 10; i += 1) rows.push(await move(page, g.press.x, g.press.y - i * 40, 30));
    return rows;
  },
  // Past the room under the box's top edge: 900 px down, more than the viewport has below the corner.
  "past-max": async (page, g) => {
    const rows = [];
    for (let i = 1; i <= 15; i += 1) rows.push(await move(page, g.press.x, g.press.y + i * 60, 28));
    return rows;
  },
  // The hand crosses the corner it started on - down, back up past the press, sideways across the box, and down
  // again to the press - so the gesture has to recover from a height the pointer has already left behind.
  crossing: async (page, g) => {
    const rows = [];
    for (let i = 1; i <= 10; i += 1) rows.push(await move(page, g.press.x, g.press.y + i * 10, 26));
    for (let i = 1; i <= 10; i += 1) rows.push(await move(page, g.press.x, g.press.y + 100 - i * 20, 26));
    for (let i = 1; i <= 5; i += 1) rows.push(await move(page, g.press.x - i * 24, g.press.y - 100, 26));
    for (let i = 1; i <= 10; i += 1) rows.push(await move(page, g.press.x - 120, g.press.y - 100 + i * 10, 26));
    return rows;
  },
  // A state poll lands with the hand down: the panel's own 30 s anti-entropy read.
  "interrupt-poll": async (page, g) => {
    const rows = [];
    for (let i = 1; i <= 6; i += 1) rows.push(await move(page, g.press.x, g.press.y + i * 3, 28));
    const asked = await page.evaluate(() => window.__CD.poll());
    await page.waitForTimeout(900);
    for (let i = 7; i <= 12; i += 1) rows.push(await move(page, g.press.x, g.press.y + i * 3, 28));
    return { rows, meta: { pollAsked: asked } };
  },
  // A repaint lands with the hand down: an artifact changes the running turn's signature and the panel's own
  // updateJob -> renderConversation path decides whether the card may be rebuilt.
  "interrupt-repaint": async (page, g) => {
    const rows = [];
    for (let i = 1; i <= 6; i += 1) rows.push(await move(page, g.press.x, g.press.y + i * 3, 28));
    const painted = await page.evaluate(() => window.__CD.repaint());
    await page.waitForTimeout(400);
    for (let i = 7; i <= 12; i += 1) rows.push(await move(page, g.press.x, g.press.y + i * 3, 28));
    return { rows, meta: { painted } };
  },
  // A press that moves nothing, then a double-click on the corner: neither is a resize. The framework presses; the
  // case releases and presses again inside the double-click window, and the framework's release closes it.
  "no-move": async (page, g) => {
    await page.waitForTimeout(120);
    await page.mouse.up();
    await page.waitForTimeout(45);
    await page.mouse.down();
    await page.waitForTimeout(45);
    const again = await page.evaluate(() => window.__CD.read());
    return { rows: again ? [{ ...again, pointerX: g.press.x, pointerY: g.press.y }] : [], meta: { doubleClick: true } };
  },
};

const TRAVEL = { slow: 60, flick: 120, "past-min": -400, "past-max": 900, crossing: 0, "interrupt-poll": 36, "interrupt-repaint": 36, "no-move": 0 };

// One case: fresh starting size, press, motion, release, settle, numbers.
async function runCase(page, name, sizePx, innerHpx) {
  const start = await startSize(page, sizePx);
  if (!start) throw new Error("the console went away while a case was being set up");
  await page.evaluate(() => window.__CD.foot());
  await page.waitForTimeout(150);
  const before = await page.evaluate(() => window.__CD.read());
  const { at, down } = await press(page);
  const out = await CASES[name](page, { press: at });
  const rows = Array.isArray(out) ? out : out.rows;
  const meta = Array.isArray(out) ? {} : out.meta || {};
  const { settleMs, after, writes } = await release(page);
  return { name, sizePx, at, before, down, rows: rows.filter(Boolean), meta, after, settleMs, writes, innerHpx };
}

// What each case promises, in the three numbers the brief asks for: pointer delta against size delta, the corner
// against the pointer, the store against the box.
// A press that never reached the band measured nothing, and the page says what was at the point instead. A corner
// scrolled above its pane is a shape this gate cannot press; that is a different sentence from a drag that lost the hand.
function missReason(down) {
  const hit = down && down.hit;
  if (!hit) return "";
  return hit.onGrip
    ? " (the point is the grip, so the band was missed)"
    : ` (the point is ${hit.at}, not the grip: the corner is outside the pane's scrollport or painted over at this shape)`;
}

function verdictOf(run) {
  const { name, before, down, after, rows, writes, settleMs, innerHpx } = run;
  const fails = [];
  const numbers = {};
  if (!before || !down || !after) return { fail: ["the case could not be read"], numbers };
  if (down.held !== true) fails.push(`the press did not engage the corner gesture${missReason(down)}`);

  const grab = +(down.gripBottom - down.pointerY).toFixed(2);
  const startH = before.h;
  const endH = after.h;
  const last = rows[rows.length - 1] || down;
  const askedAtEnd = last.dragH == null ? null : last.dragH;
  const minH = Number.isFinite(down.minH) ? down.minH : 0;
  // The room the release clamps to, measured the way endOutGrip measures it: the viewport under the box's own top.
  const room = +(innerHpx - last.top - OUT_GRIP_ROOM_PX).toFixed(2);
  const wanted = name === "no-move" ? startH : askedAtEnd == null ? startH + TRAVEL[name] : askedAtEnd;
  const expectH = name === "no-move" ? startH : Math.max(minH, Math.min(room, Math.round(wanted)));

  numbers.startPx = +startH.toFixed(2);
  numbers.endPx = +endH.toFixed(2);
  numbers.sizeDeltaPx = +(endH - startH).toFixed(2);
  numbers.pointerDeltaPx = name === "no-move" ? 0 : TRAVEL[name];
  numbers.expectedDeltaPx = +(expectH - startH).toFixed(2);
  numbers.roomPx = room;
  numbers.floorPx = minH;
  numbers.storedAfter = after.stored;
  numbers.storedLsAfter = after.storedLs;
  numbers.varAfter = after.varPx;
  numbers.rectAfter = +after.h.toFixed(2);
  numbers.clientAfter = after.clientH;
  numbers.renderVsStoredPx = after.stored == null ? null : +(after.h - after.stored).toFixed(2);
  numbers.clientVsStoredPx = after.stored == null ? null : +(after.clientH - after.stored).toFixed(2);
  numbers.settleMs = settleMs;
  numbers.mutations = { child: writes.child, style: writes.style, other: writes.other };
  numbers.repaints = writes.child;
  numbers.styleWrites = writes.style;
  numbers.bodyWrites = writes.bodyWrites;
  numbers.bodyWriteStacks = writes.stacks || [];
  // Read DURING the drag, not after it: what the release then paints (a deferred rebuild that lands in the pointerup)
  // is the release's business, and the gate's question is whether the node under the hand survived the travel.
  numbers.nodeReplaced = rows.some((r) => r.same === false);
  numbers.nodeAfter = after.same;
  numbers.consoleContentSpanPx = +(after.content - before.content).toFixed(2);
  numbers.releaseSnapPx = +(last.h - after.h).toFixed(2);
  numbers.turnIsSlack = Boolean(after.slack);
  numbers.consoleFlex = after.flex || "";
  numbers.sigChanged = rows.some((r) => (r.sig || "") !== (before.sig || ""));
  numbers.artifactsBefore = before.artifacts;
  numbers.artifactsAfter = after.artifacts;

  // The corner, step by step: grip bottom against (pointer y + the pixels of the grip the hand landed inside).
  // A TRANSCRIPT'S FLOOR. The console's height is inside the transcript's scrollHeight, so a transcript on its foot
  // has no offset room for a SHRINK: below the height the press found, the browser's clamp takes the top edge down
  // with the shrink and the box's bottom stands still (measured, pre-fix: 3px up, the grip 3px off the hand on the
  // first move; 400px up, 400px gone). That is a clamp, like the sheet's floor, and it is judged by the size check
  // below - not as a corner the gesture lost. The floor is read where the press found it: how far the transcript was
  // from its foot (bodyMax - bodyTop) is the room a shrink has, so the corner is judged only at or above
  // `press height - that room`.
  const followFloor = +(down.h - Math.max(0, (down.bodyMax ?? 0) - (down.bodyTop ?? 0))).toFixed(2);
  let worstInRange = 0;
  let worstAll = 0;
  let retrograde = 0;
  let prevGrip = down.gripBottom;
  for (const r of rows) {
    const asked = r.dragH;
    const inRange = asked == null ? true : asked > minH + 0.5 && asked >= followFloor - 0.5 && asked <= room + 1;
    const err = Math.abs(r.gripBottom - (r.pointerY + grab));
    worstAll = Math.max(worstAll, err);
    if (inRange) worstInRange = Math.max(worstInRange, err);
    if (r.gripBottom < prevGrip - 1) retrograde += 1;
    prevGrip = r.gripBottom;
  }
  numbers.worstCornerPx = +worstAll.toFixed(2);
  numbers.worstInRangeCornerPx = +worstInRange.toFixed(2);
  numbers.cornerAtReleasePx = +(after.gripBottom - (last.pointerY + grab)).toFixed(2);
  numbers.retrogradeSteps = retrograde;
  numbers.steps = rows.length;

  // 1. THE HAND AND THE CORNER. While the requested height is inside [floor, room], the grip's bottom edge is on
  //    the pointer. This is the witness a stored-size check cannot see.
  if (name !== "no-move" && worstInRange > CORNER_TOLERANCE_PX) {
    fails.push(`the corner left the pointer by ${numbers.worstInRangeCornerPx}px while the height was in range`);
  }
  // 0. THE CASE REALLY DREW SOMETHING. A drag that never registered movement restores the style and stores nothing,
  //    and a case that measured that would pass vacuously.
  if (name !== "no-move" && last.moved !== true) fails.push("the gesture never registered movement (the press missed the band)");
  if (name === "interrupt-repaint" && !(run.meta.painted && run.meta.painted.sigChanged)) {
    fails.push("the repaint was a no-op: the conversation's signature did not move, so no rebuild was owed");
  }
  if (name === "interrupt-repaint" && numbers.sigChanged) fails.push("the card was rebuilt while the pointer was down");
  if (name === "interrupt-repaint" && !(run.meta.painted && run.meta.painted.painted)) fails.push("the panel's repaint path could not be called");
  if (name === "interrupt-poll" && run.meta.pollAsked !== true) fails.push("the panel's state poll could not be called");
  // 2. THE SIZE. Rendered against what the pointer asked for, with the release clamp as designed.
  if (Math.abs((expectH - startH) - numbers.sizeDeltaPx) > SIZE_TOLERANCE_PX) {
    fails.push(
      `size delta ${numbers.sizeDeltaPx}px against the pointer's ${numbers.pointerDeltaPx}px (asked ${wanted}px, clamped to ${expectH}px)` +
        (numbers.turnIsSlack ? `; the box is drawn by the slack turn's flex (${numbers.consoleFlex}), not by that number` : ""),
    );
  }
  // 3. THE STORE. The number the panel kept against the box it drew, and the one writer's variable against the store.
  if (name !== "no-move") {
    if (after.stored == null) fails.push("nothing was stored for the height the drag reached");
    else {
      if (numbers.renderVsStoredPx != null && Math.abs(numbers.renderVsStoredPx) > SIZE_TOLERANCE_PX) {
        fails.push(`drawn ${endH}px against stored ${after.stored}px (${numbers.renderVsStoredPx}px)`);
      }
      if (after.varPx != null && Math.abs(after.varPx - after.stored) > 0.51) {
        fails.push(`--out-h ${after.varPx}px against the store ${after.stored}px`);
      }
    }
  }
  // 4. A PRESS THAT MOVED NOTHING CHANGES NOTHING.
  if (name === "no-move") {
    if (Math.abs(endH - startH) > 0.51) fails.push(`a click moved the box ${(endH - startH).toFixed(2)}px`);
    if ((after.varH || "") !== (before.varH || "")) fails.push(`a click changed --out-h from "${before.varH}" to "${after.varH}"`);
    if (after.stored !== before.stored) fails.push(`a click changed the stored height from ${before.stored} to ${after.stored}`);
  }
  // 5. THE NODE. What the hand is on is still there. For a drag this is a lost gesture; for a click it is a repaint
  //    that landed between the two presses, which the click check above already says changed nothing.
  if (name !== "no-move" && numbers.nodeReplaced) fails.push("the console node was replaced while the pointer was down");
  // 6. THE CORNER AFTER THE RELEASE. The release used to put a following transcript back on its foot, and that is a
  //    scroll write of exactly the drag's travel: the box came back to the pixel it started from (measured, pre-fix:
  //    60px down and final -60, 120px down and final -120, 400px up and final 400). Judged only when the release KEPT
  //    the number the pointer asked for AND the transcript's floor let the box follow there: a drag past the floor or
  //    past the room is a clamp, and there the corner comes to rest where the box does, by design.
  const keptAsked =
    name !== "no-move" &&
    last.dragH != null &&
    Math.abs(after.h - last.dragH) <= SIZE_TOLERANCE_PX &&
    last.dragH > minH + 0.5 &&
    last.dragH >= followFloor - 0.5;
  numbers.cornerReleaseChecked = keptAsked;
  if (keptAsked && Math.abs(numbers.cornerAtReleasePx) > CORNER_TOLERANCE_PX) {
    fails.push(`the corner stood ${numbers.cornerAtReleasePx}px from the hand after the release (the drag's travel was undone)`);
  }
  numbers.followFloorPx = followFloor;
  return { fail: fails, numbers };
}

// ---- the press-only rows -----------------------------------------------------------------------------------------
// A press, half a second of stillness, a release. The readings are the box BEFORE the press, at the end of the hold,
// and after the release: the print is the drawn height, its top edge and the store, so a jump that the release undoes
// is still a jump, and the row fails on it. `z` is the page's zoom - the reader's defect was a press on a zoomed page,
// where the drawn height (visual) was written back as a layout height and the box came back `z` times smaller.
async function pressOnlyCase(page, sizePx, z) {
  await startSize(page, sizePx, z);
  await page.evaluate(() => window.__CD.foot());
  await page.waitForTimeout(150);
  const before = await page.evaluate(() => window.__CD.read());
  const { at, down } = await press(page);
  // The hold: a quarter of a second in, then the end of it. `press` already waited 60ms for the gesture to engage.
  await page.waitForTimeout(180);
  const mid = await page.evaluate(() => window.__CD.read());
  await page.waitForTimeout(Math.max(0, PRESS_HOLD_MS - 240));
  const held = await page.evaluate(() => window.__CD.read());
  const { settleMs, after, writes } = await release(page);
  return { sizePx, z, at, before, down, mid, held, after, writes, settleMs };
}

// What a press that moves nothing promises: the box and its corner stand still for the whole hold, the release puts
// back exactly what the sheet drew, and nothing is stored. The tolerance is 1px - the reader asked for that number -
// and 0 is what the fixed tree measures.
function pressOnlyVerdict(run) {
  const { before, down, mid, held, after } = run;
  const fails = [];
  const numbers = {};
  if (!before || !down || !mid || !held || !after) return { fail: ["the row could not be read"], numbers };
  if (down.held !== true) fails.push(`the press did not engage the corner gesture (the band was missed)${missReason(down)}`);
  const round = (n) => +Number(n).toFixed(2);
  numbers.drawnBefore = round(before.h);
  numbers.topBefore = round(before.top);
  numbers.storedBefore = before.stored;
  numbers.varBefore = before.varH || "";
  numbers.drawnHeld = round(held.h);
  numbers.topHeld = round(held.top);
  // The store is the third number the row reads: a press that moves the box and writes the new number into `state.outHeights`
  // is a resize the release might not take back, so it is read at the hold as well as after the release.
  numbers.storedHeld = held.stored;
  numbers.deltaDrawn = round(held.h - before.h);
  numbers.deltaTop = round(held.top - before.top);
  numbers.cornerDelta = round(held.gripBottom - before.gripBottom);
  numbers.drawnAfter = round(after.h);
  numbers.topAfter = round(after.top);
  numbers.afterDeltaDrawn = round(after.h - before.h);
  numbers.afterDeltaTop = round(after.top - before.top);
  numbers.storedAfter = after.stored;
  numbers.varAfter = after.varH || "";
  numbers.zoom = before.zoom || "1";
  numbers.heldScrollWrites = run.writes.bodyWrites;
  numbers.settleMs = run.settleMs;
  numbers.nodeReplaced = Boolean(after.same === false);
  if (Math.abs(numbers.deltaDrawn) > PRESS_TOLERANCE_PX) {
    fails.push(`the box changed height by ${numbers.deltaDrawn}px on the press, with the pointer still`);
  }
  if (Math.abs(numbers.deltaTop) > PRESS_TOLERANCE_PX) {
    fails.push(`the corner moved ${numbers.deltaTop}px on the press, with the pointer still`);
  }
  if (Math.abs(numbers.afterDeltaDrawn) > PRESS_TOLERANCE_PX || Math.abs(numbers.afterDeltaTop) > PRESS_TOLERANCE_PX) {
    fails.push(`the release did not put the box back (${numbers.afterDeltaDrawn}px of height, ${numbers.afterDeltaTop}px of top)`);
  }
  if ((after.varH || "") !== (before.varH || "")) fails.push(`the press left --out-h "${before.varH}" -> "${after.varH}"`);
  if (held.stored !== before.stored) fails.push(`the press changed the stored height ${before.stored} -> ${held.stored} while the hand was down`);
  if (after.stored !== before.stored) fails.push(`the press changed the stored height ${before.stored} -> ${after.stored}`);
  if (numbers.nodeReplaced) fails.push("the console node was replaced by a press that moved nothing");
  return { fail: fails, numbers };
}

async function main() {
  const pw = loadPlaywright({ root: REPO });
  if (!pw) return notRun("the console corner drag", "no Playwright install (set PANEL_PLAYWRIGHT_ROOT)");
  const numbers = { base: BASE, widths: WIDTHS, sizes: SIZES, cases: {} };
  const trace = { cases: [], pressOnly: [] };
  let version = "";
  let launched = null;
  try {
    launched = await pw.chromium.launch({ headless: true });
  } catch (err) {
    const missingShell = /Executable doesn't exist|headless[_-]shell/i.test(String((err && err.message) || err));
    if (!missingShell) throw err;
    console.log("BROWSER  the headless shell binary is not installed - launching the full chromium build instead");
    launched = await pw.chromium.launch({ headless: true, channel: "chromium" });
  }
  try {
    for (const width of WIDTHS) {
      const context = await launched.newContext({ viewport: { width, height: INNER_H } });
      await context.addInitScript((key) => {
        try { localStorage.setItem(key, "1"); } catch { /* private mode: the button opens it */ }
      }, OPEN_KEY);
      const page = await context.newPage();
      const pageErrors = [];
      page.on("pageerror", (e) => pageErrors.push(String((e && e.message) || e).slice(0, 200)));
      try {
        const ready = await loadPanel(page);
        version = version || (await page.evaluate(() => window.__CD.version()));
        const innerHpx = await page.evaluate(() => innerHeight);
        if (!JSON_OUT) {
          console.log(
            `\nSHAPE ${width}x${innerHpx}: chat pane ${ready.paneW}px, console ${ready.consoleW}x${ready.consoleH}px, ${ready.turns} open turn(s) at the foot`,
          );
        }
        for (const size of SIZES) {
          for (const name of Object.keys(CASES)) {
            const key = `${name}@${width}/${size}`;
            try {
              const run = await runCase(page, name, size, innerHpx);
              const v = verdictOf(run);
              numbers.cases[key] = { ...v.numbers, fail: v.fail, ok: v.fail.length === 0 };
              trace.cases.push({
                key,
                shape: ready,
                start: run.before,
                press: { at: run.at, down: run.down },
                steps: run.rows.map((r) => ({
                  pointerY: r.pointerY, h: r.h, top: r.top, gripBottom: r.gripBottom, varH: r.varH, stored: r.stored,
                  dragH: r.dragH, dragTop: r.dragTop, bodyTop: r.bodyTop, bodyMax: r.bodyMax, held: r.held, same: r.same,
                })),
                after: run.after,
                writes: run.writes,
                settleMs: run.settleMs,
                meta: run.meta,
              });
              const n = v.numbers;
              check(
                v.fail.length === 0,
                `${key}`,
                `pointer ${n.pointerDeltaPx}px -> size ${n.sizeDeltaPx}px (want ${n.expectedDeltaPx}), ` +
                  `corner worst ${n.worstInRangeCornerPx}px, final ${n.cornerAtReleasePx}px, ` +
                  `stored ${n.storedAfter == null ? "unset" : `${n.storedAfter}px`}, drawn ${n.endPx}px, client ${n.clientAfter}px, ` +
                  `store delta ${n.renderVsStoredPx == null ? "n/a" : `${n.renderVsStoredPx}px`}, ` +
                  `snap ${n.releaseSnapPx}px, settle ${n.settleMs}ms, repaints ${n.repaints}, node ${n.nodeReplaced ? "replaced" : "same"}, ` +
                  `body writes ${n.bodyWrites}` +
                  (v.fail.length ? ` -- ${v.fail.join("; ")}` : ""),
              );
            } catch (err) {
              check(false, `${key}`, `did not run: ${String((err && err.message) || err).slice(0, 240)}`);
              trace.cases.push({ key, error: String((err && err.message) || err) });
            }
            await page.waitForTimeout(80);
          }
        }
        // THE PRESS-ONLY ROWS: a press, half a second of stillness, a release, at the page's own zoom as well as at
        // 100. One row per width, height and zoom; each fails above 1px of movement in the box, its corner or its top
        // edge, and on any change the press leaves in `--out-h` or the store.
        for (const zoomPct of PRESS_ZOOMS) {
          await applyZoom(page, zoomPct);
          const z = zoomPct / 100;
          for (const size of PRESS_SIZES) {
            const key = `press-only@${width}/${size}/z${zoomPct}`;
            try {
              const run = await pressOnlyCase(page, size, z);
              const v = pressOnlyVerdict(run);
              numbers.cases[key] = { ...v.numbers, fail: v.fail, ok: v.fail.length === 0 };
              trace.pressOnly.push({
                key,
                zoom: zoomPct,
                before: run.before,
                down: run.down,
                mid: run.mid,
                held: run.held,
                after: run.after,
                writes: run.writes,
                settleMs: run.settleMs,
              });
              const n = v.numbers;
              check(
                v.fail.length === 0,
                key,
                `drawn ${n.drawnBefore}px -> ${n.drawnHeld}px (delta ${n.deltaDrawn}px), top ${n.topBefore}px -> ${n.topHeld}px ` +
                  `(delta ${n.deltaTop}px), corner delta ${n.cornerDelta}px, after ${n.drawnAfter}px/${n.topAfter}px, ` +
                  `stored ${n.storedBefore == null ? "unset" : `${n.storedBefore}px`} -> ${n.storedHeld == null ? "unset" : `${n.storedHeld}px`} during the hold -> ${n.storedAfter == null ? "unset" : `${n.storedAfter}px`}, ` +
                  `--out-h "${n.varBefore}" -> "${n.varAfter}", zoom ${n.zoom}, scroll writes ${n.heldScrollWrites}` +
                  (v.fail.length ? ` -- ${v.fail.join("; ")}` : ""),
              );
            } catch (err) {
              check(false, key, `did not run: ${String((err && err.message) || err).slice(0, 240)}`);
              trace.pressOnly.push({ key, error: String((err && err.message) || err) });
            }
            await page.waitForTimeout(100);
          }
        }
        await applyZoom(page, 100);
        if (CAUSE) {
          // The same drag twice at one shape: as the page draws it, and with the transcript's scroll anchoring off.
          // The second run is only credited when the first one reproduced the drift, so a shape where the defect does
          // not bite cannot be reported as a cause check that passed.
          const cause = {};
          for (const mode of ["anchor-on", "anchor-off"]) {
            await startSize(page, SIZES[0]);
            await page.evaluate(() => window.__CD.foot());
            if (mode === "anchor-off") await page.evaluate(() => window.__CD.anchor(true));
            else await page.evaluate(() => window.__CD.anchor(false));
            await page.waitForTimeout(120);
            const anchorValue = await page.evaluate((off) => window.__CD.anchor(off), mode === "anchor-off");
            const { at } = await press(page);
            const rows = [];
            for (let i = 1; i <= 20; i += 1) {
              if (mode === "anchor-off") await page.evaluate(() => window.__CD.anchor(true));
              rows.push(await move(page, at.x, at.y + i * 2, 30));
            }
            const { after, writes } = await release(page);
            const first = rows[0];
            const lastRow = rows[rows.length - 1];
            cause[mode] = {
              anchorValue,
              gripTravelPx: +(lastRow.gripBottom - first.gripBottom).toFixed(2),
              pointerTravelPx: 38,
              topMovedPx: +(lastRow.top - first.top).toFixed(2),
              bodyMovedPx: +(lastRow.bodyTop - first.bodyTop).toFixed(2),
              bodyWrites: writes.bodyWrites,
              endH: after.h,
            };
            await page.evaluate(() => window.__CD.anchor(false));
            await page.waitForTimeout(250);
          }
          numbers.causeCheck = cause;
          const on = cause["anchor-on"];
          const off = cause["anchor-off"];
          if (!JSON_OUT) {
            console.log(
              `\nCAUSE CHECK (20 moves of 2px, 38px of travel, start ${SIZES[0]}px): anchoring ${on.anchorValue} -> grip moved ${on.gripTravelPx}px, ` +
                `top ${on.topMovedPx}px, transcript ${on.bodyMovedPx}px, JS writes ${on.bodyWrites}; anchoring ${off.anchorValue} -> ` +
                `grip moved ${off.gripTravelPx}px, top ${off.topMovedPx}px, transcript ${off.bodyMovedPx}px, JS writes ${off.bodyWrites}`,
            );
          }
          if (Math.abs(on.gripTravelPx) <= 2 && off.gripTravelPx >= 36) {
            check(true, "cause check: with the transcript's anchoring off the corner tracks the hand", `grip ${on.gripTravelPx}px of 38 with it on, ${off.gripTravelPx}px with it off`);
          } else if (!JSON_OUT) {
            console.log("CAUSE CHECK inconclusive at this shape: the drift did not reproduce with anchoring on, or it did not clear with it off");
          }
        }
        check(pageErrors.length === 0, `${width}px: the page threw nothing`, pageErrors.slice(0, 3).join(" | "));
      } finally {
        await context.close().catch(() => {});
      }
    }
  } finally {
    await launched.close().catch(() => {});
  }

  if (TRACE) {
    writeFileSync(path.resolve(TRACE), JSON.stringify({ base: BASE, version, ...trace }, null, 1), "utf8");
    // On stderr in JSON mode: stdout is one JSON object and nothing else, so a caller can parse it.
    const line = `trace: ${path.resolve(TRACE)}`;
    if (JSON_OUT) console.error(line);
    else console.log(line);
  }
  const failures = results.filter((r) => !r.ok).length;
  const failedCases = Object.entries(numbers.cases).filter(([, v]) => !v.ok).map(([k]) => k);
  if (JSON_OUT) {
    console.log(JSON.stringify({ base: BASE, version, checks: results, numbers, failedCases, failures }, null, 1));
  } else {
    console.log(`\nPANEL ${BASE} v${version || "?"}`);
    console.log(
      failures
        ? `RESULT: FAIL ${failedCases.length}/${Object.keys(numbers.cases).length} cases: ${failedCases.join(", ")}`
        : "RESULT: PASS",
    );
  }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
