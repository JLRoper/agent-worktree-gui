// Every frame a console paints, across the rebuilds a reader actually causes: a card a rebuild BUILDS (a second
// agent arrives), a project collapsed and expanded, and one console parked mid-scrollback while all of it lands.
//
//   node tools/measure-console-expand-frames.mjs --base http://127.0.0.1:7393 --seconds 150 --spawn-at 15 --toggle-at 60
//   node tools/measure-console-expand-frames.mjs --base http://127.0.0.1:7393 --seconds 100 --cycles 5 --no-park
//
// WHY THIS TOOL EXISTS. The count that matters to the reader is not "did a write go backwards" (a clamp repaired
// inside its own task paints nothing) and not "did the box leave its tail" (the 40 px band class): it is "did a
// frame paint a console that was following its run at scrollTop 0". Only a per-frame sample answers that, and only
// with the page's own pin state beside it, because a console the reader PARKED is supposed to sit wherever they put
// it. `tools/verify-console-independence.mjs` samples frames for its `rebuild` layout; this one drives the expand
// cycle and an agent arriving while a console is parked, on a panel the reader can open, and prints for every
// rebuilt console the first frame it painted (top / max / ms) - the frames that show a fix, or its absence.
//
// WHAT IS DRIVEN. A panel that is already running (`--base`, default 7393). The project's section and the row named
// by `--row` (or every row of the project) are opened through the page's own state, the consoles are parked with a
// REAL wheel, a second agent is created through the panel's own POST /api/agents (`--spawn-at`, `--prompt`, cwd =
// `--row`, existing:true), and the project head is clicked shut and open (`--toggle-at`, `--cycles`). Nothing is
// injected into the board: every card is the panel's.
//
// THE INSTRUMENT. `addInitScript`, before app.js parses:
//   * a requestAnimationFrame loop that re-queries every `pre.job-out` per frame and records
//     {scrollTop, scrollHeight, clientHeight, pin, node uid, thread}. `pin` is the page's own answer
//     (`consolePinned(id)`, i.e. `state.outPinned[id] !== false`), not an inference from distance.
//   * DOM-primitive wrappers (appendChild / insertBefore / after / before / append / replaceWith / replaceChildren /
//     remove, and the innerHTML / outerHTML setters) filtered to subtrees carrying a console, each with its caller
//     stack - used only to ATTRIBUTE a frame that paints at 0, never to decide whether one happened.
//   * the page's EventSource, tagged by event name (`job`, `jobs`, `row`, `project`, `snapshot`), so a rebuild can
//     be joined to the server frame that asked for it.
//
// DEFINITIONS. A "hop" is one frame where a box reads `pin === 1`, `scrollHeight - clientHeight > 20` and
// `scrollTop <= 2`: an unparked console painted at the top of a log it was following. A console the reader parked
// (`pin === 0`) is never counted, however far up it sits - that is the reader's own place. `--no-park` leaves every
// console pinned (the expand-only case). A box that fits its content (`max <= 20`) cannot show a hop and is not one.
//
// AFTER THE WINDOW, the tool plants the jump it is looking for (write 0, read five frames, repair) and re-appends a
// console's own section raw: a zero without that self-test is indistinguishable from a sampler that cannot see the
// event. Each attempt is printed; a run whose self-test never sees a jump exits 2.
//
// Exit codes: 0 measured, no frame painted an unparked console at 0; 1 measured, one did; 2 measured nothing
// (no console overflowed, the page never loaded, the self-test never saw a planted jump, or the base was refused).
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TREE = path.resolve(HERE, "..");
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const BASE = String(opt("--base", "http://127.0.0.1:7393")).replace(/\/$/, "");
const SECONDS = Number(opt("--seconds", 150));
const JSON_OUT = opt("--json", "");
const PROJECT = opt("--project", "agent-worktree-gui");
const ROW = opt("--row", "");
const SPAWN_AT = Number(opt("--spawn-at", -1));
const SPAWN_PROMPT = opt("--prompt", "Reply with exactly 90 numbered lines, 1 through 90, one per line, no other text and no tools.");
const TOGGLE_AT = Number(opt("--toggle-at", -1));
const CYCLES = Number(opt("--cycles", 1));
const TOGGLE_EVERY = Number(opt("--toggle-every", 16000));
const PARK = !argv.includes("--no-park");
const PARK_THREAD = opt("--park-thread", "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[frames]", ...a);

const { loadPlaywright } = await import(pathToFileURL(path.join(TREE, "tools", "browser.mjs")).href);
const pw = loadPlaywright({ root: TREE });
if (!pw) {
  console.log("BROWSER-HALF-NOT-RUN  measure-console-expand-frames — no playwright install found");
  process.exit(2);
}

// ---- the page instrument --------------------------------------------------------------------------------------------
function pageInit() {
  const R = { armAt: 0, endAt: 0, frames: 0, nodeSeq: 0, boxes: {}, ops: [], sse: [], errors: [] };
  window.__fr = R;
  const uid = (el) => {
    if (!el.__uid) el.__uid = ++R.nodeSeq;
    return el.__uid;
  };
  const label = (n) => {
    if (!n || !n.tagName) return String(n);
    const cls = typeof n.className === "string" ? n.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".") : "";
    return `${n.tagName.toLowerCase()}${cls ? "." + cls : ""}`;
  };
  const hasConsole = (n) => Boolean(n && n.nodeType === 1 && (n.matches?.("pre.job-out") || n.querySelector?.("pre.job-out")));
  const stack = () => {
    const lines = String(new Error().stack || "").split("\n").slice(1);
    const out = [];
    for (const raw of lines) {
      const s = raw.trim().replace(/^at\s+/, "");
      const loc = (s.match(/\(?([^()\s]+:\d+:\d+)\)?$/) || [])[1] || "";
      if (!loc) continue;
      const file = loc.replace(/^.*[\\/]/, "").replace(/:\d+:\d+$/, "");
      const line = (loc.match(/:(\d+):\d+$/) || [])[1] || "";
      const fn = s.split(" (")[0].replace(/[\\/]/g, "/").split("/").pop() || "(anon)";
      if (/^(stack|pageInit|wrap|note|f)$/.test(fn)) continue;
      if (file === "<anonymous>" || file === "") continue;
      out.push(`${fn}|${file}:${line}`);
      if (out.length >= 6) break;
    }
    return out.join(" < ");
  };
  const note = (op, self, nodes) => {
    try {
      if (!hasConsole(self) && !nodes.some(hasConsole)) return;
      const keys = nodes.filter(hasConsole).map((n) => (n.dataset && n.dataset.out) || (n.querySelector?.("pre.job-out")?.dataset.out ?? "")).filter(Boolean);
      R.ops.push({ t: performance.now(), op, node: label(self), keys: keys.join(","), by: stack() });
    } catch {
      /* an op must never break the page */
    }
  };
  const wrap = (proto, name, nodesOf) => {
    const orig = proto[name];
    if (typeof orig !== "function" || orig.__w) return;
    const f = function (...a) {
      const r = orig.apply(this, a);
      note(name, this, nodesOf(this, a) || []);
      return r;
    };
    f.__w = true;
    proto[name] = f;
  };
  wrap(Node.prototype, "insertBefore", (s, a) => [a[0]]);
  wrap(Node.prototype, "appendChild", (s, a) => [a[0]]);
  wrap(Element.prototype, "after", (s, a) => [s.parentNode, ...a]);
  wrap(Element.prototype, "before", (s, a) => [s.parentNode, ...a]);
  wrap(Element.prototype, "append", (s, a) => [...a]);
  wrap(Element.prototype, "replaceWith", (s, a) => [s, s.parentNode, ...a]);
  wrap(Element.prototype, "replaceChildren", (s, a) => [s, ...s.children, ...a]);
  wrap(Element.prototype, "remove", (s) => [s.parentNode, s]);
  for (const prop of ["innerHTML", "outerHTML"]) {
    const d = Object.getOwnPropertyDescriptor(Element.prototype, prop);
    if (!d || !d.set) continue;
    Object.defineProperty(Element.prototype, prop, {
      configurable: true,
      enumerable: d.enumerable,
      get: d.get,
      set(v) {
        const before = hasConsole(this);
        const r = d.set.call(this, v);
        if (before || /job-out/.test(String(v))) R.ops.push({ t: performance.now(), op: prop, node: label(this), keys: "", by: stack() });
        return r;
      },
    });
  }
  const OrigES = window.EventSource;
  function TaggedES(...args) {
    const es = new OrigES(...args);
    for (const kind of ["jobs", "job", "project", "row", "snapshot", "jobline", "assistant"]) {
      es.addEventListener(kind, () => {
        try {
          R.sse.push({ t: performance.now(), kind });
        } catch {
          /* never break the stream */
        }
      });
    }
    return es;
  }
  TaggedES.prototype = OrigES.prototype;
  window.EventSource = TaggedES;
  const pinOf = (id) => {
    try {
      if (typeof consolePinned === "function") return consolePinned(id) ? 1 : 0;
      if (typeof state !== "undefined" && state.outPinned) return state.outPinned[id] !== false ? 1 : 0;
    } catch {
      /* the page is mid-load */
    }
    return 1;
  };
  const tick = (ts) => {
    try {
      if (R.armAt) {
        R.frames += 1;
        for (const el of document.querySelectorAll("pre.job-out")) {
          const card = el.closest(".job");
          const id = (el.dataset && el.dataset.out) || "(none)";
          let b = R.boxes[id];
          if (!b) b = R.boxes[id] = { ts: [], top: [], sh: [], ch: [], pin: [], uid: [], thread: (card && card.dataset && card.dataset.thread) || "" };
          b.ts.push(Math.round(ts * 10) / 10);
          b.top.push(el.scrollTop);
          b.sh.push(el.scrollHeight);
          b.ch.push(el.clientHeight);
          b.pin.push(pinOf(id));
          b.uid.push(uid(el));
        }
      }
    } catch (e) {
      R.errors.push(String(e && e.message));
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__frArm = () => {
    R.armAt = performance.now();
  };
  window.__frEnd = () => {
    R.endAt = performance.now();
  };
}

// ---- analysis -------------------------------------------------------------------------------------------------------
function analyze(dump, toggles) {
  const t0 = dump.armAt;
  const endT = dump.endAt || Infinity;
  const ops = (dump.ops || []).filter((o) => o.t <= endT);
  const out = { frames: dump.frames, boxes: {}, episodes: [], expansions: [], rebuilds: [], sse: {} };
  for (const [id, b] of Object.entries(dump.boxes)) {
    const idx = [];
    for (let i = 0; i < b.ts.length; i += 1) if (b.ts[i] <= endT) idx.push(i);
    if (!idx.length) continue;
    let atTop = 0;
    let atTopPinned = 0;
    let offTailPinned = 0;
    let max = 0;
    let drops = 0;
    for (let k = 0; k < idx.length; k += 1) {
      const i = idx[k];
      const m = b.sh[i] - b.ch[i];
      if (m > max) max = m;
      if (m > 20 && b.top[i] <= 2) {
        atTop += 1;
        if (b.pin[i] === 1) atTopPinned += 1;
      }
      if (b.pin[i] === 1 && m > 20 && b.sh[i] - b.top[i] - b.ch[i] > 8) offTailPinned += 1;
      if (k) {
        const p = idx[k - 1];
        if (b.top[p] - b.top[i] > 2) drops += 1;
      }
    }
    let nodes = 1;
    for (let k = 1; k < idx.length; k += 1) if (b.uid[idx[k]] !== b.uid[idx[k - 1]]) nodes += 1;
    out.boxes[id] = { thread: b.thread || "", frames: idx.length, max, atTop, atTopPinned, offTailPinned, drops, nodes, firstPaint: [] };
    // every node this box had, and the frame it first painted on
    const seen = new Set();
    for (const i of idx) {
      if (seen.has(b.uid[i])) continue;
      seen.add(b.uid[i]);
      out.boxes[id].firstPaint.push({ uid: b.uid[i], t: Math.round(b.ts[i] - t0), top: b.top[i], max: b.sh[i] - b.ch[i], pin: b.pin[i] });
    }
    // a hop: an unparked console (pin 1) with room to scroll, painted at 0
    let run = null;
    for (let k = 0; k < idx.length; k += 1) {
      const i = idx[k];
      const m = b.sh[i] - b.ch[i];
      const hit = b.pin[i] === 1 && m > 20 && b.top[i] <= 2;
      if (hit && !run) {
        const before = ops.filter((o) => o.t <= b.ts[i] && o.t > b.ts[i] - 2000);
        const op = before[before.length - 1];
        const sse = (dump.sse || []).filter((s) => s.t <= b.ts[i] && s.t > b.ts[i] - 2000).slice(-3);
        run = {
          box: id,
          thread: b.thread || "",
          startT: Math.round(b.ts[i] - t0),
          prevTop: k ? b.top[idx[k - 1]] : b.top[i],
          max: m,
          frames: 0,
          born: k ? b.uid[idx[k - 1]] !== b.uid[i] : false,
          op: op ? `${op.op} ${op.node} by ${(op.by || "").split(" < ")[0]}` : null,
          opDtMs: op ? Math.round(b.ts[i] - op.t) : null,
          sse: sse.map((s) => `${s.kind}+${Math.round(b.ts[i] - s.t)}ms`).join(",") || null,
        };
      }
      if (hit && run) run.frames += 1;
      if (!hit && run) {
        run.repairTop = b.top[i];
        run.ms = Math.round(b.ts[i] - t0 - run.startT * 1);
        out.episodes.push(run);
        run = null;
      }
    }
    if (run) out.episodes.push({ ...run, unrepaired: true });
  }
  // per expand: the consoles the click REBUILT, and the first frame each painted
  for (const [ci, te] of (toggles || []).filter((t) => t.phase === "expand").entries()) {
    const line = { index: ci + 1, t: te.t, consoles: [] };
    for (const [id, b] of Object.entries(dump.boxes)) {
      const pre = [];
      for (let i = 0; i < b.ts.length; i += 1) if (b.ts[i] <= t0 + te.t) pre.push(i);
      const post = [];
      for (let i = 0; i < b.ts.length; i += 1) if (b.ts[i] > t0 + te.t && b.ts[i] <= t0 + te.t + 2500) post.push(i);
      if (!pre.length || !post.length) continue;
      if (b.uid[pre[pre.length - 1]] === b.uid[post[0]]) continue; // not rebuilt by this click
      let at0 = 0;
      for (const i of post) if (b.uid[i] === b.uid[post[0]] && b.sh[i] - b.ch[i] > 20 && b.top[i] <= 2) at0 += 1;
      const first = post[0];
      const near = ops.filter((o) => o.t <= b.ts[first] && o.t > b.ts[first] - 1200);
      const op = near[near.length - 1];
      line.consoles.push({
        id,
        thread: b.thread || "",
        uid: b.uid[first],
        ms: Math.round(b.ts[first] - t0 - te.t),
        top: b.top[first],
        max: b.sh[first] - b.ch[first],
        pin: b.pin[first],
        at0,
        builtBy: op ? `${op.op} ${op.node} by ${(op.by || "").split(" < ")[0]}` : "",
      });
    }
    out.expansions.push(line);
  }
  const by = new Map();
  for (const o of ops) {
    const k = `${o.op} ${o.node} | ${(o.by || "?").split(" < ")[0]}`;
    by.set(k, (by.get(k) || 0) + 1);
  }
  out.rebuilds = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([key, n]) => ({ key, n }));
  out.sse = (dump.sse || []).reduce((m, s) => ((m[s.kind] = (m[s.kind] || 0) + 1), m), {});
  return out;
}

// ---- the window -----------------------------------------------------------------------------------------------------
const browser = await pw.chromium.launch({
  headless: true,
  args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"],
});
let exitCode = 2;
const result = { base: BASE, seconds: SECONDS, project: PROJECT, row: ROW, errors: [] };
try {
  // Which build is really answering: the hash of the bytes served and the shell's own build id.
  const build = await fetch(`${BASE}/api/build`).then((r) => r.json()).catch(() => null);
  const appJs = await fetch(`${BASE}/app.js`).then((r) => r.text()).catch(() => "");
  result.served = { build: build && build.version, appJs: createHash("sha256").update(appJs).digest("hex") };
  log(`served ${BASE}: build ${result.served.build}, app.js sha256 ${result.served.appJs}`);

  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => result.errors.push(String((e && e.message) || e).slice(0, 300)));
  await page.addInitScript(pageInit);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof state !== "undefined" && state.rows && state.jobs, null, { timeout: 40_000 });
  const norm = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  await page.waitForFunction((p) => [...state.projects.keys()].includes(p), PROJECT, { timeout: 90_000 });
  await page.waitForFunction(
    ({ p, row }) => [...state.rows.values()].some((x) => x.project === p && (!row || String(x.path || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === row)),
    { p: PROJECT, row: norm(ROW) },
    { timeout: 90_000 },
  );
  // Open the section and the row(s) the way the reader does — a click on the project head, then the row's ⧉ chip —
  // because the next scan re-renders rows from the page's own expanded set and a state key that does not match
  // `keyOf()` is silently dropped on that pass.
  const projectOpen = await page.evaluate((p) => state.expandedProjects.has(p), PROJECT);
  if (!projectOpen) await page.click(`.project-head[data-toggle-project="${PROJECT}"]`, { timeout: 10_000, force: true });
  await sleep(600);
  const rowKeys = await page.evaluate(
    ({ p, row }) =>
      [...state.rows.values()]
        .filter((r) => r.project === p)
        .filter((r) => !row || String(r.path || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === row)
        .map((r) => `${p}::${r.path}`),
    { p: PROJECT, row: norm(ROW) },
  );
  for (const key of rowKeys) {
    const hit = await page.evaluate((k) => {
      const n = (s) => String(s || "").replace(/\\/g, "/").toLowerCase();
      const chip = [...document.querySelectorAll("[data-open-row]")].find((el) => n(el.dataset.openRow) === n(k));
      if (!chip) return false;
      chip.click();
      return true;
    }, key);
    if (!hit) await page.evaluate((k) => state.expanded.add(k), key);
    await sleep(120);
  }
  await page.evaluate(() => renderAll());
  await page.waitForFunction(
    () => [...document.querySelectorAll("pre.job-out")].some((o) => o.getBoundingClientRect().width > 0 && o.scrollHeight - o.clientHeight > 40),
    null,
    { timeout: 90_000, polling: 250 },
  );
  result.consoles = await page.evaluate((p) => {
    const detail = [...state.detailEls.entries()].filter(([k]) => k.startsWith(`${p}::`)).map(([, el]) => el);
    return [...document.querySelectorAll("pre.job-out")].map((o) => {
      const card = o.closest(".job");
      const rect = o.getBoundingClientRect();
      return {
        thread: card && card.dataset.thread,
        out: o.dataset.out,
        max: o.scrollHeight - o.clientHeight,
        visible: rect.width > 0 && rect.height > 0,
        inRow: detail.some((d) => d.contains(o)),
      };
    });
  }, PROJECT);
  log(`consoles: ${result.consoles.filter((c) => c.visible && c.max > 40).length} overflowing of ${result.consoles.length} on the page`);

  // ---- park one console MID-SCROLLBACK with a real wheel ------------------------------------------------------------
  if (PARK) {
    const candidates = result.consoles
      .filter((c) => c.visible && c.max > 40)
      .filter((c) => !PARK_THREAD || c.thread === PARK_THREAD)
      .sort((a, b) => Number(b.inRow) - Number(a.inRow) || b.max - a.max);
    if (!candidates.length) throw new Error("no overflowing console to park");
    let park = { ok: false };
    let target = null;
    for (const cand of candidates.slice(0, 6)) {
      const sel = `pre.job-out[data-out="${cand.out}"]`;
      const handle = await page.$(sel);
      if (!handle) continue;
      // Put the console in the middle of the viewport before aiming at it: a 318 px box near the bottom of a long
      // page leaves `box.y` off-screen, and a wheel over whatever is there scrolls the page instead of the console.
      await handle.evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest" }));
      await sleep(200);
      const bb = await handle.boundingBox();
      if (!bb) continue;
      await page.mouse.move(bb.x + bb.width / 2, bb.y + Math.min(bb.height / 2, 80));
      await page.mouse.wheel(0, 4000); // to the bottom first
      await sleep(300);
      await page.mouse.wheel(0, -520); // then up, out of the follow band
      await sleep(350);
      const got = await page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return { ok: false };
        return { ok: true, top: el.scrollTop, max: el.scrollHeight - el.clientHeight, gap: el.scrollHeight - el.scrollTop - el.clientHeight, pin: typeof consolePinned === "function" ? consolePinned(el.dataset.out) : null };
      }, sel);
      if (got.ok && got.gap > 40) {
        park = got;
        target = cand;
        break;
      }
    }
    if (!target) throw new Error("no console took a wheel park (every candidate stayed on its tail)");
    result.park = { thread: target.thread, out: target.out, ...park };
    log(`park: ${JSON.stringify(result.park)}`);
  } else {
    result.park = null;
  }

  await page.evaluate(() => window.__frArm());
  const armWall = Date.now();
  log(`sampler armed for ${SECONDS} s`);

  // ---- a second agent, created through the panel's own route while the reader is parked -----------------------------
  result.secondAgent = null;
  if (SPAWN_AT >= 0 && SPAWN_AT < SECONDS) {
    await sleep(Math.max(0, SPAWN_AT * 1000));
    const cwd = ROW || (result.consoles.find((c) => c.inRow) || {}).thread;
    const r = await fetch(`${BASE}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: SPAWN_PROMPT, cwd, existing: true }),
    }).then((x) => x.json());
    result.secondAgent = { at: SPAWN_AT * 1000, cwd, job: r && r.job ? { id: r.job.id, thread: r.job.thread, status: r.job.status } : r };
    log(`second agent: ${JSON.stringify(result.secondAgent.job)}`);
  }

  // ---- collapse -> expand, the reader's own click -------------------------------------------------------------------
  result.toggles = [];
  if (TOGGLE_AT >= 0 && TOGGLE_AT < SECONDS) {
    await sleep(Math.max(0, TOGGLE_AT * 1000 - (Date.now() - armWall)));
    const snap = () =>
      page.evaluate((p) => {
        const boxes = [...document.querySelectorAll(`section.project[data-project="${CSS.escape(p)}"] pre.job-out`)].map((o) => o.dataset.out);
        return {
          expanded: state.expandedProjects.has(p),
          detailKeys: [...state.detailEls.keys()].filter((k) => k.startsWith(`${p}::`)).length,
          boxes,
          stored: Object.keys(state.outScrolls).length,
          missingStored: boxes.filter((id) => !state.outScrolls[id]),
          unpinned: Object.entries(state.outPinned).filter(([, v]) => v === false).map(([k]) => k),
        };
      }, PROJECT);
    for (let c = 0; c < CYCLES; c += 1) {
      for (const phase of ["collapse", "expand"]) {
        const t = Date.now() - armWall;
        try {
          const before = await snap();
          await page.click(`.project-head[data-toggle-project="${PROJECT}"]`, { timeout: 5000, force: true });
          await sleep(700);
          const after = await snap();
          result.toggles.push({ cycle: c, phase, t, before, after });
          log(`cycle ${c} ${phase} t+${t}ms: ${before.boxes.length} -> ${after.boxes.length} box(es), ${after.missingStored.length} with no stored place`);
        } catch (e) {
          result.toggles.push({ cycle: c, phase, t, error: String((e && e.message) || e).slice(0, 200) });
        }
        await sleep(phase === "collapse" ? 2600 : Math.max(1200, TOGGLE_EVERY - 3300));
      }
    }
  }

  await sleep(Math.max(0, SECONDS * 1000 - (Date.now() - armWall)));
  await page.evaluate(() => window.__frEnd());
  const dump = await page.evaluate(() => {
    const R = window.__fr;
    return { armAt: R.armAt, endAt: R.endAt, frames: R.frames, boxes: R.boxes, ops: R.ops, sse: R.sse, errors: R.errors };
  });
  result.windowMs = Math.round(dump.endAt - dump.armAt);

  // ---- self-test AFTER the window: can this sampler see a jump at all? ----------------------------------------------
  const selftest = await page.evaluate(async () => {
    const nap = (ms) => new Promise((r) => setTimeout(r, ms));
    const frames = (n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
    const boxes = [...document.querySelectorAll("pre.job-out")].filter((o) => o.scrollHeight - o.clientHeight > 40);
    const el = boxes.find((o) => (typeof consolePinned === "function" ? consolePinned(o.dataset.out) : true)) || boxes[0];
    if (!el) return { ok: false, why: "no overflowing console to drive" };
    const max = el.scrollHeight - el.clientHeight;
    el.scrollTop = Math.max(0, max - 140);
    await frames(2);
    const parked = el.scrollTop;
    const attempts = [];
    for (let k = 0; k < 3; k += 1) {
      el.scrollTop = 0;
      const sync = el.scrollTop;
      const seen = [];
      for (let i = 0; i < 5; i += 1) {
        await frames(1);
        seen.push(el.scrollTop);
      }
      await nap(45);
      el.scrollTop = parked;
      await frames(2);
      attempts.push({ sync, frames: seen });
    }
    const sect = el.closest("section.project");
    const reap = [];
    if (sect && sect.parentNode) {
      for (let k = 0; k < 2; k += 1) {
        el.scrollTop = parked;
        await frames(2);
        const before = el.scrollTop;
        sect.parentNode.appendChild(sect);
        const sync = el.scrollTop;
        const seen = [];
        for (let i = 0; i < 3; i += 1) {
          await frames(1);
          seen.push(el.scrollTop);
        }
        reap.push({ before, sync, frames: seen });
        el.scrollTop = el.scrollHeight;
        await frames(2);
      }
    }
    return { ok: true, id: el.dataset.out, max, parked, attempts, reap };
  });
  result.selftest = selftest;

  const a = (result.analysis = analyze(dump, result.toggles));
  log(`frames ${dump.frames} in ${result.windowMs} ms (${(dump.frames / (result.windowMs / 1000)).toFixed(1)} fps), ${Object.keys(a.boxes).length} console box(es)`);
  for (const [id, b] of Object.entries(a.boxes)) {
    log(`  ${id} thread=${b.thread} frames ${b.frames} max ${b.max} at0 ${b.atTop} (UNPARKED ${b.atTopPinned}) offTail(pinned) ${b.offTailPinned} drops ${b.drops} nodes ${b.nodes}`);
    for (const f of b.firstPaint) log(`      node ${f.uid} first paint t+${f.t} top ${f.top} / max ${f.max} pin ${f.pin}`);
  }
  log(`  sse: ${JSON.stringify(a.sse)}`);
  log(`  moves: ${a.rebuilds.slice(0, 6).map((r) => `${r.key} x${r.n}`).join(" | ")}`);
  for (const e of a.expansions) {
    log(`  expand #${e.index} t+${e.t}ms rebuilt ${e.consoles.length} console(s)`);
    for (const c of e.consoles) log(`    ${c.id} first frame +${c.ms}ms top ${c.top} / max ${c.max} pin ${c.pin}, ${c.at0} frame(s) at 0${c.builtBy ? `, built by ${c.builtBy}` : ""}`);
  }
  log(`  HOPS (unparked console painted at 0): ${a.episodes.length}`);
  for (const e of a.episodes) log(`    ${e.box} thread=${e.thread} t+${e.startT}ms ${e.frames} frame(s) max ${e.max} prevTop ${e.prevTop} born ${e.born} by ${e.op || "?"} (+${e.opDtMs}ms) sse ${e.sse || "?"}`);
  log(`  self-test ${JSON.stringify(selftest)}`);
  const selfTestSaw = selftest.ok && (selftest.reap || []).some((r) => r.frames.some((v) => v <= 2)) && selftest.attempts.some((x) => x.frames.some((v) => v <= 2));
  if (JSON_OUT) {
    mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true });
    writeFileSync(JSON_OUT, JSON.stringify({ ...result, raw: dump }, null, 1));
    log(`wrote ${JSON_OUT}`);
  }
  if (!selfTestSaw) {
    log("nothing measured: the self-test never saw a planted jump in this browser");
    exitCode = 2;
  } else {
    exitCode = a.episodes.length ? 1 : 0;
  }
} catch (e) {
  result.fatal = String((e && e.stack) || e).slice(0, 1500);
  log("FATAL", result.fatal);
  if (JSON_OUT) {
    mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true });
    writeFileSync(JSON_OUT, JSON.stringify(result, null, 1));
  }
  exitCode = 2;
} finally {
  await browser.close().catch(() => {});
}
log(`EXIT ${exitCode} — ${exitCode === 0 ? "measured, no frame painted an unparked console at 0" : exitCode === 1 ? "measured, an unparked console WAS painted at 0" : "nothing measured"}`);
process.exit(exitCode);
