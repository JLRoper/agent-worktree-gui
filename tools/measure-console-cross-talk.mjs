// Does one card's console move because ANOTHER card's agent wrote?
//
//   node tools/measure-console-cross-talk.mjs --port 7371 --seconds 60 --json out.json
//   node tools/measure-console-cross-talk.mjs --port 7371 --seconds 8             # a short smoke run
//   node tools/measure-console-cross-talk.mjs --port 7371 --headed                # watch the three cards
//
// WHY THIS TOOL EXISTS. tools/measure-console-writes.mjs answers "what writes a console's scrollTop" on one board and
// ranks the callers. It cannot answer the isolation question: with SEVERAL agents streaming into several combined (🌊)
// consoles at once, how many writes or painted frames move console A because the agent behind console B wrote? The
// unit of that answer is not the caller (the sweep and the patch are the same function for every card) but the CARD:
// which card's console moved, which card's content grew in that frame, and whether the movement was asked for at all.
//
// So this drives three cards in ONE project (three rows: the main checkout and two worktrees) in stream mode, starts
// three stub runs whose words are interleaved on a 25 ms lattice, and records:
//
//   * every `scrollTop` write on every `pre.job-out`, with the value before, the value asked for, the value the browser
//     landed on, the geometry at that instant, the card the box belongs to, and the page callers' `file:line`;
//   * every DOM operation that carries or is applied to a console box, with the card(s) it carried and its caller -
//     this is what lets a move with NO write be attributed to a rebuild of a specific card;
//   * a per-frame snapshot of every console (`scrollTop`, `scrollHeight`, `clientHeight`, pin state, child count, last
//     row length), taken in one rAF loop so the three cards' series share a clock and can be compared frame by frame.
//
// The counts this prints are the answer to the question:
//
//   crossWrites  a write to card A in the same rebuild as a DOM operation that carried card B's console and not A's.
//                (The write and the operation share a page frame above the primitive - placeRow and the restore it
//                runs - are in the same detail row, and are at most 50 ms apart. Proven as same-rebuild coupling, and
//                reported with the caller that wrote it and the operation it followed.)
//   crossFrames  a frame in which card A's scrollTop changed with NO write to A, while A neither grew nor was touched by
//                a DOM operation, and card B's content DID grow (or B's console was rebuilt) in that same frame. That is
//                the browser moving A because B changed size - the isolation defect, counted without a writer to blame.
//   silent       a frame move with no write at all, whatever moved it (own rebuild, own growth, browser clamp). Each is
//                kept with its cause, because `crossFrames` is the subset of these that names another card.
//
// A clean window is only worth something if the instrument can see the defect when it happens. After the window closes
// the tool drives its own self-test (writes past the log, not through the page's gesture): (1) a write to 0 repaired
// 40 ms later through the page's own `setScroll` - both writes must appear with a caller and the frames between them
// must show the box off its bottom; (2) a raw re-append of the console's section, which moves `scrollTop` with NO write
// - the op log must carry the append with its caller and the frames must show 0. Both run AFTER `__endWindow`, so
// nothing they do can reach the counts.
//
// It starts its OWN panel, on its own port (7371 by default) with its own PANEL_CONFIG / HERMES_HOME / jobs.json /
// projects cache. It refuses port 7331 outright: that is the reader's live board and no run of this tool may bind,
// restart, write to or drive it. Exit 0 = measured, 2 = the run measured nothing (a missing browser, a port it could
// not take, no console overflowing, or no write logged), so a green line can never be a pass on an empty log.
//
// No product file is changed by this tool. It reads the page and reports.
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright, notRun } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const PORT = Number(opt("--port", 7371));
const SECONDS = Number(opt("--seconds", 60));
const CARDS = Math.max(2, Number(opt("--cards", 3)));
const JSON_OUT = opt("--json");
const HEADLESS = !argv.includes("--headed");
const PARK = !argv.includes("--no-park");
const MAX_WAIT_MS = 150_000;
const OFF_BOTTOM = 8; // px: "still on its newest line" for this tool
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (tag, ...a) => console.log(`[${tag}]`, ...a);

// ---- the stub Hermes gateway: three interleaved streams over real SSE -----------------------------------------------
// Three scripts on ONE 25 ms lattice (each writes every 75 ms, offset by 25 ms), so whatever the page does with three
// agents at once, it is doing it because three wires are moving - not because one burst arrived between two reads.
const WORDS = `the console is a fixed height box and its content is longer than the box
a repaint that patches the row extends the words and moves nothing else
keeping the newest line in view means scrolling to the bottom after every growth
a reader who has scrolled up is a reader the panel must not touch
the sweep runs on its own clock whether or not the wire is moving
a card that keeps its node keeps the reader's place in it`.split(/\s+/).filter(Boolean);

function script(seed, offsetMs, lenMs) {
  const out = [];
  let t = 300 + offsetMs;
  let i = seed;
  let inLine = 0;
  let lines = 0;
  while (t < lenMs) {
    const w = WORDS[i % WORDS.length];
    i += 1;
    inLine += 1;
    let sep = " ";
    if (inLine >= 11 + (i % 5)) {
      sep = lines % 4 === 3 ? "\n\n" : "\n";
      inLine = 0;
      lines += 1;
    }
    out.push({ at: t, evt: { event: "message.delta", delta: `${w}${sep}` } });
    t += 75;
  }
  return out;
}

function makeGateway(lenMs) {
  const runs = new Map();
  let posts = 0;
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
      return json(200, { version: "cross-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true } });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      req.resume();
      req.on("end", () => {
        posts += 1;
        const id = `run_cross_${posts}`;
        // Offsets 0 / 25 / 50 ms: with a 75 ms cadence the three wires write in strict rotation.
        runs.set(id, { id, startedAt: null, script: script((posts - 1) * 37, (posts - 1) * 25, lenMs) });
        json(200, { run_id: id, status: "running" });
      });
      return;
    }
    const one = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (one && req.method === "GET") {
      const rec = runs.get(one[1]);
      if (!rec) return json(404, { error: { message: "Run not found", code: "run_not_found" } });
      return json(200, { run_id: rec.id, status: "running", output: "", usage: { total_tokens: 9000, input_tokens: 8100, output_tokens: 900 } });
    }
    const ev = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (ev && req.method === "GET") {
      const rec = runs.get(ev[1]);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      if (!rec) return res.end();
      res.write(": open\n\n");
      if (rec.startedAt == null) rec.startedAt = Date.now();
      let open = true;
      req.on("close", () => {
        open = false;
      });
      rec.script.forEach((step, i) => {
        later(rec.startedAt + step.at - Date.now(), () => {
          if (open) res.write(`id: ${i}\ndata: ${JSON.stringify({ ...step.evt, run_id: rec.id, seq: i, timestamp: Date.now() / 1000 })}\n\n`);
        });
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

// ---- the page-side instrument ---------------------------------------------------------------------------------------
// Installed as an init script, i.e. before public/app.js parses, so the first write of the session is recorded and no
// writer can be missed by being early. A console for this note is `pre.job-out` - the ONE box a combined (🌊) card
// scrolls, because its reasoning is drawn as rows inside it.
function pageInit() {
  const T0 = performance.now();
  const now = () => Math.round((performance.now() - T0) * 10) / 10;
  const R = { writes: [], ops: [], frames: [], errors: [], markers: [], writesDropped: 0, opsDropped: 0, stopped: false };
  window.__rec = R;
  window.__now = now;
  window.addEventListener("error", (e) => R.errors.push(String((e && e.message) || e)));
  window.addEventListener("unhandledrejection", (e) => R.errors.push(`unhandledrejection: ${String((e && e.reason && (e.reason.message || e.reason)) || "")}`));

  // The page's own caller chain, innermost first; `fn|file:line` so two callers of the same function stay distinct and
  // no mail-shaped redactor rewrites the separator.
  const pageStack = (max) => {
    const out = [];
    for (const line of String(new Error().stack || "").split("\n").slice(1)) {
      const m = /^\s*at\s+(?:(.*?)\s+\()?(.*?):(\d+):(\d+)\)?\s*$/.exec(line);
      if (!m || !/\/(app|assistant)\.js|\/core\//.test(m[2])) continue;
      const fn = String(m[1] || "<anon>")
        .replace(/^async\s+/, "")
        .replace(/^(?:new\s+)?(?:Object|Array|Promise|Window|Node|Element|HTMLElement)\./, "");
      out.push(`${fn}|${String(m[2]).split("/").pop()}:${m[3]}`);
      if (out.length >= max) break;
    }
    return out.join(" < ");
  };

  // ---- which elements are the combined consoles, and which CARD each belongs to ----
  const kindCache = new WeakMap();
  const boxKind = (el) => {
    if (!el || el.nodeType !== 1) return null;
    let k = kindCache.get(el);
    if (k !== undefined) return k;
    k = el.matches && el.matches("pre.job-out") ? "out" : null;
    kindCache.set(el, k);
    return k;
  };
  // The card is the unit of the question. `data-out` is a TURN id; the card's own identity is `data-thread` on `.job`.
  const cardOf = (el) => {
    const job = el && el.closest ? el.closest(".job[data-thread]") : null;
    return job ? job.dataset.thread || "" : "";
  };
  const outIdOf = (el) => (el && el.dataset && el.dataset.out) || "";
  // The DETAIL a card lives in. Two cards in one detail are rebuilt together by that row's `placeRow`; two cards in two
  // rows are not, even when one `flush` drives both. This is the field that keeps "the same flush" from reading as "the
  // same rebuild".
  const rowOf = (el) => {
    if (!el || el.nodeType !== 1) return "";
    const detail = el.closest && el.closest("tr.detail");
    if (detail) return detail.dataset.detail || "";
    const tr = el.closest && el.closest("tr[data-key]");
    return tr ? tr.dataset.key || "" : "";
  };

  // ---- native accessors, captured before anything is replaced ----
  const EP = Element.prototype;
  const D = {
    scrollTop: Object.getOwnPropertyDescriptor(EP, "scrollTop"),
    scrollHeight: Object.getOwnPropertyDescriptor(EP, "scrollHeight"),
    clientHeight: Object.getOwnPropertyDescriptor(EP, "clientHeight"),
  };
  if (!D.scrollTop || !D.scrollTop.get || !D.scrollTop.set) return;
  const raw = {
    top: (el) => D.scrollTop.get.call(el),
    sh: (el) => D.scrollHeight.get.call(el),
    ch: (el) => D.clientHeight.get.call(el),
  };
  let inGeom = false;
  const geom = (el) => {
    inGeom = true;
    try {
      return { top: raw.top(el), sh: raw.sh(el), ch: raw.ch(el) };
    } finally {
      inGeom = false;
    }
  };

  // ---- DOM operations that carry a console ----
  // `domSeq` is the shared clock a write can be joined to: a write carries the sequence number at the instant it ran,
  // so a write with the same number as an operation is in that operation's task, with no frame in between. It is not a
  // timer and it does not depend on microtask order.
  let domSeq = 0;
  R.domSeq = () => domSeq;
  const carries = (nodes) => {
    for (const n of nodes) {
      if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) continue;
      if (n.nodeType === 1 && n.matches && n.matches("pre.job-out")) return true;
      if (n.querySelector && n.querySelector("pre.job-out")) return true;
    }
    return false;
  };
  const desc = (n) => {
    if (!n || n.nodeType !== 1) return n ? n.nodeName : "";
    const cn = typeof n.className === "string" ? n.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".") : "";
    const d = n.dataset || {};
    const id = d.thread ? `[${String(d.thread).slice(0, 14)}]` : d.out ? `[out:${String(d.out).slice(0, 10)}]` : "";
    return `${n.tagName.toLowerCase()}${cn ? `.${cn}` : ""}${id}`;
  };
  const keysOf = (nodes, host) => {
    const keys = new Set();
    // `deep` for the nodes being inserted: a detail carried into a row carries the card inside it. The HOST is only
    // added when the host IS a console (append a row to it, replace its children) - NOT by descending into it. A
    // `remove` whose host is the project's tbody is not an operation on every card in that tbody, and treating it as
    // one made a row pass look like it carried all three cards.
    const add = (n, deep) => {
      if (!n || n.nodeType !== 1) return;
      if (n.matches && n.matches("pre.job-out")) {
        const k = cardOf(n);
        if (k) keys.add(k);
      }
      if (deep && n.querySelectorAll) for (const b of n.querySelectorAll("pre.job-out")) {
        const k = cardOf(b);
        if (k) keys.add(k);
      }
    };
    for (const n of nodes) add(n, true);
    add(host, false);
    return [...keys];
  };
  const wrap = (proto, name, pick) => {
    const orig = proto[name];
    if (typeof orig !== "function" || orig.__m) return;
    const w = function () {
      let host = null;
      let nodes = [];
      let keys = [];
      try {
        const p = pick(this, arguments);
        host = p[0];
        nodes = Array.from(p[1] || []);
        const carry = carries(nodes) || (host && host.nodeType === 1 && boxKind(host) === "out");
        if (!carry) keys = [];
        else keys = keysOf(nodes, host);
      } catch {
        /* never break the page */
      }
      const r = orig.apply(this, arguments);
      try {
        if (keys.length) {
          domSeq += 1;
          if (R.ops.length < 24_000) {
            R.ops.push({
              t: now(),
              seq: domSeq,
              op: name,
              host: desc(host),
              node: desc(nodes.find((n) => n && n.nodeType === 1)),
              row: rowOf(host) || rowOf(nodes.find((n) => n && n.nodeType === 1)),
              keys: keys.join(","),
              by: pageStack(5),
            });
          } else R.opsDropped += 1;
        }
      } catch {
        /* ignore */
      }
      return r;
    };
    w.__m = true;
    proto[name] = w;
  };
  wrap(Node.prototype, "insertBefore", (s, a) => [s, [a[0]]]);
  wrap(Node.prototype, "appendChild", (s, a) => [s, [a[0]]]);
  wrap(Element.prototype, "after", (s, a) => [s.parentNode, a]);
  wrap(Element.prototype, "before", (s, a) => [s.parentNode, a]);
  wrap(Element.prototype, "append", (s, a) => [s, a]);
  wrap(Element.prototype, "replaceWith", (s, a) => [s.parentNode, [s, ...a]]);
  wrap(Element.prototype, "replaceChildren", (s, a) => [s, [...s.children, ...a]]);
  wrap(Element.prototype, "remove", (s) => [s.parentNode, [s]]);

  // ---- pin state, read from the panel's own memory, never set by this tool ----
  const pinnedNow = (el) => {
    try {
      if (typeof state === "undefined" || !state.outPinned) return true;
      return state.outPinned[outIdOf(el)] !== false;
    } catch {
      return true;
    }
  };

  // ---- the setter: every write, with its caller ----
  Object.defineProperty(EP, "scrollTop", {
    configurable: true,
    enumerable: D.scrollTop.enumerable,
    get: D.scrollTop.get,
    set: function (v) {
      if (boxKind(this) !== "out") {
        D.scrollTop.set.call(this, v);
        return;
      }
      if (R.writes.length > 80_000) {
        R.writesDropped += 1;
        D.scrollTop.set.call(this, v);
        return;
      }
      const t = now();
      const before = geom(this);
      const card = cardOf(this);
      const asked = Number(v);
      const rec = {
        t,
        seq: domSeq,
        card,
        row: rowOf(this),
        out: outIdOf(this),
        from: Math.round(before.top),
        asked: Math.round(asked) || 0,
        sh: Math.round(before.sh),
        ch: Math.round(before.ch),
        max: Math.round(before.sh - before.ch),
        pin: pinnedNow(this),
        conn: this.isConnected,
        dead: !this.isConnected || before.ch === 0,
        by: pageStack(5),
      };
      D.scrollTop.set.call(this, v);
      rec.landed = Math.round(raw.top(this));
      rec.short = rec.max - rec.asked;
      rec.landedShort = rec.max - rec.landed;
      R.writes.push(rec);
    },
  });

  // `scrollTo`/`scrollBy` on a console would move it without touching the property. Nothing in public/app.js uses
  // them on a console today; wrapping them is how the log proves that rather than assuming it.
  for (const name of ["scrollTo", "scrollBy"]) {
    const orig = EP[name];
    if (typeof orig !== "function") continue;
    const w = function () {
      if (boxKind(this) === "out") {
        const g = geom(this);
        R.writes.push({
          t: now(),
          seq: domSeq,
          card: cardOf(this),
          out: outIdOf(this),
          via: name,
          from: Math.round(g.top),
          asked: null,
          sh: Math.round(g.sh),
          ch: Math.round(g.ch),
          max: Math.round(g.sh - g.ch),
          pin: pinnedNow(this),
          conn: this.isConnected,
          dead: !this.isConnected || g.ch === 0,
          by: pageStack(5),
        });
      }
      return orig.apply(this, arguments);
    };
    w.__m = true;
    EP[name] = w;
  }

  // ---- the per-frame series: all three cards on ONE clock ----
  const sample = () => {
    if (R.stopped) return;
    const boxes = {};
    for (const el of document.querySelectorAll("pre.job-out")) {
      const card = cardOf(el);
      if (!card) continue;
      const g = geom(el);
      const last = el.lastElementChild;
      boxes[card] = {
        top: Math.round(g.top),
        sh: Math.round(g.sh),
        ch: Math.round(g.ch),
        pin: pinnedNow(el) ? 1 : 0,
        nodes: el.children.length,
        last: last && last.textContent ? last.textContent.length : 0,
        out: outIdOf(el),
      };
    }
    R.frames.push({ t: now(), seq: domSeq, boxes });
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);

  window.__mark = (name) => R.markers.push({ t: now(), name: String(name) });
  window.__arm = () => {
    R.armAt = now();
  };
  window.__endWindow = () => {
    R.windowEnd = now();
    return R.windowEnd;
  };
  // A move with no write, driven by the tool AFTER the window: (1) a write to 0 repaired 40 ms later through the page's
  // own setScroll (the shape a sub-frame jump takes); (2) a raw re-append of the console's section (the browser's own
  // clamp, which no write explains). If the instrument cannot see these two, a clean window proves nothing.
  window.__selftest = async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const st = { at: now(), steps: [] };
    R.selftest = st;
    // A box already at its first line makes step (1) vacuous, so an off-bottom box wins over one with more room.
    const pick = [...document.querySelectorAll("pre.job-out")]
      .filter((o) => o.scrollHeight - o.clientHeight > 40)
      .sort((a, b) => (b.scrollTop > 40) - (a.scrollTop > 40) || b.scrollHeight - b.clientHeight - (a.scrollHeight - a.clientHeight))[0];
    if (!pick) {
      st.steps.push({ ok: false, why: "no overflowing console" });
      return st;
    }
    st.card = cardOf(pick);
    st.before = Math.round(pick.scrollTop);
    st.maxBefore = Math.round(pick.scrollHeight - pick.clientHeight);
    R.inSelftest = true;
    st.jumpAt = now();
    window.setScroll(pick, 0);
    st.jumped = Math.round(pick.scrollTop);
    await wait(40);
    st.repairAt = now();
    window.setScroll(pick, pick.scrollHeight);
    st.repaired = Math.round(pick.scrollTop);
    R.inSelftest = false;
    st.steps.push({
      ok: st.before > 20 && st.jumped <= 2 && st.repaired > 20 && st.repairAt - st.jumpAt >= 20,
      what: "write to 0, repaired 40 ms later through setScroll",
      before: st.before,
      jumped: st.jumped,
      repaired: st.repaired,
      gapMs: Math.round((st.repairAt - st.jumpAt) * 10) / 10,
    });
    await wait(120);
    const sec = pick.closest("section.project") || pick.closest("section.root-group");
    if (sec && sec.parentNode) {
      st.rawBefore = Math.round(pick.scrollTop);
      st.rawMax = Math.round(pick.scrollHeight - pick.clientHeight);
      st.rawAt = now();
      st.rawFrame0 = R.frames.length;
      sec.parentNode.appendChild(sec);
      st.rawAfter = Math.round(pick.scrollTop);
      // The frame sampler must have SEEN it: the clamp is a value change with no write, so a series that only follows
      // the write log would miss the very move this step exists to prove. Poll for the frame rather than assuming the
      // next rAF lands inside a fixed wait - a throttled or briefly busy page can skip 120 ms of frames and turn a
      // working instrument into a FAIL.
      const zeroDeadline = now() + 2_000;
      while (now() < zeroDeadline) {
        const seen = R.frames.slice(st.rawFrame0).filter((f) => f.boxes[st.card] && f.boxes[st.card].top === 0).length;
        if (seen) {
          // A short tail so the count is a real number of painted frames at 0, not just "one exists".
          await wait(80);
          st.rawZeroFrames = R.frames.slice(st.rawFrame0).filter((f) => f.boxes[st.card] && f.boxes[st.card].top === 0).length;
          break;
        }
        await wait(30);
      }
      window.setScroll(pick, pick.scrollHeight);
      st.steps.push({
        ok: st.rawBefore > 20 && st.rawAfter <= 2 && st.rawZeroFrames > 0,
        what: "raw re-append of the console's section, no write",
        before: st.rawBefore,
        after: st.rawAfter,
        zeroFrames: st.rawZeroFrames,
        max: st.rawMax,
      });
    } else {
      st.steps.push({ ok: false, why: "the console is not inside a section" });
    }
    await wait(80);
    return st;
  };
  window.__stop = () => {
    R.stopped = true;
  };
  window.__dump = () => ({
    writes: R.writes,
    ops: R.ops,
    frames: R.frames,
    errors: R.errors,
    markers: R.markers,
    writesDropped: R.writesDropped,
    opsDropped: R.opsDropped,
    armAt: R.armAt,
    windowEnd: R.windowEnd,
    selftest: R.selftest || null,
  });
}

// ---- fixtures --------------------------------------------------------------------------------------------------------
function git(args, cwd) {
  return execFileSync("git", ["-c", "user.name=probe", "-c", "user.email=probe@localhost", ...args], { cwd, stdio: "pipe", encoding: "utf8" });
}
function makeRepo(dir, name) {
  mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", "main"], dir);
  writeFileSync(path.join(dir, "README.md"), `# ${name}\n`);
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "first"], dir);
}
const norm = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// ---- the panel on a FIXED port ---------------------------------------------------------------------------------------
// tools/panel-testkit.mjs's startPanel asks the OS for a free port and builds its base URL from that answer, so it cannot
// be asked for 7371. This is the same boot with the port named by the caller, plus the two guards the task needs: 7331 is
// refused outright, and a port already in use is a refusal rather than a bind error halfway through a run.
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

async function startPanelOnPort({ port, dir, config, env = {} }) {
  const cfgPath = path.join(dir, "config.json");
  const cfg = {
    port,
    host: "127.0.0.1",
    scanRoots: [],
    threads: 1,
    worktreeSeconds: 60,
    midSeconds: 60,
    dormantSeconds: 60,
    slowSeconds: 60,
    refreshSeconds: 60,
    fetchSeconds: -1,
    projects: [],
    jobsFile: path.join(dir, "logs", "jobs.json"),
    assistantFile: path.join(dir, "logs", "assistant.json"),
    projectsCacheFile: path.join(dir, "logs", "projects.json"),
    ...config,
  };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
  const out = [];
  const child = spawn(process.execPath, ["server.js"], {
    cwd: TREE,
    env: {
      ...process.env,
      PANEL_CONFIG: cfgPath,
      HERMES_HOME: path.join(dir, "hermes"),
      CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
      PANEL_PARENT_WATCH_STDIN: "1",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_ASKPASS: "echo",
      API_SERVER_KEY: "",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdin.on("error", () => {});
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => out.push(d));
  child.stderr.on("data", (d) => out.push(d));
  let exited = null;
  child.on("exit", (code, signal) => {
    exited = { code, signal };
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 25_000;
  for (;;) {
    if (exited) throw new Error(`panel exited before it was ready (${JSON.stringify(exited)}):\n${out.join("")}`);
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`panel did not answer /api/health on ${port} within 25 s:\n${out.join("")}`);
    }
    await sleep(100);
  }
  return {
    base,
    port,
    dir,
    log: () => out.join(""),
    pid: child.pid,
    async stop() {
      if (!exited) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 8_000);
          timer.unref?.();
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
          child.kill();
        });
        if (!exited) child.kill("SIGKILL");
      }
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    },
  };
}

// ---- analysis --------------------------------------------------------------------------------------------------------
// One caller name out of a stack, without its line. `setScroll` is the innermost page frame of EVERY write (it is the
// one function in app.js that writes a console), so the writer is the first frame above it.
const framesOf = (by) => String(by || "").split(" < ").filter(Boolean);
const writerFrame = (by) => {
  const f = framesOf(by);
  for (const x of f) {
    const fn = x.split("|")[0];
    if (fn !== "setScroll" && fn !== "scrollTop") return x;
  }
  return f[0] || "?";
};
const callerOf = (by) => writerFrame(by).split("|")[0] || "?";
const siteOf = (by) => String(writerFrame(by).replace("|", " ") || "?").replace(/\?v=[0-9a-f]+/i, "");
// An operation's caller is its innermost page frame (the DOM primitive itself is the instrument, not a page file).
const opCallerOf = (by) => (framesOf(by)[0] || "?").split("|")[0] || "?";
// The two families that matter when a write follows another card's DOM change. A STREAM paint writes the card that
// grew; a ROW pass rebuilds the detail every card in a row lives in. The difference is the whole answer: one of them is
// another agent's write, the other is a clock.
const STREAM_CALLERS = new Set(["syncStreamConsole", "paintStreamConsole", "appendJobLine", "drawJobLine", "paintTypedLines", "paintThink", "paintToBottom", "paintStreamRows"]);
const ROW_CALLERS = new Set(["placeRow", "renderProjectRows", "flush", "fillAgentSlots", "removeRow", "renderAll", "paintProject", "renderProject", "renderRow"]);
const opFamily = (by) => {
  const c = opCallerOf(by);
  if (STREAM_CALLERS.has(c)) return "stream";
  if (ROW_CALLERS.has(c)) return "row";
  return "other";
};
// Same rebuild: the write and the operation share a page frame above the primitive (placeRow and the restore it runs
// are the same frame), and they are close enough in time that no other task's clock can explain it. This is stricter
// than "the global DOM counter has not moved": that counter stands still between tasks and flagged a write a second
// later as if it belonged to the operation.
const sameRebuild = (writeFrames, writeT, op, row) => {
  if (!(op.t <= writeT) || writeT - op.t > 50) return false;
  if (row && op.row && op.row !== row) return false;
  for (const f of op.frames) if (writeFrames.has(f)) return true;
  return false;
};
// Ops sorted by time, so the few that can share a rebuild with a write are the only ones parsed. A linear scan over
// every op for every write is 10^7 string comparisons on a 60 s window and buys nothing the binary search does not.
function opsInWindow(ops, t0, t1) {
  let lo = 0;
  let hi = ops.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ops[mid].t < t0) lo = mid + 1;
    else hi = mid;
  }
  const out = [];
  for (let i = lo; i < ops.length && ops[i].t <= t1; i += 1) out.push(ops[i]);
  return out;
}

function analyze(cards, rec, meter) {
  const ids = cards.map((c) => c.thread);
  const per = new Map(
    ids.map((t) => [
      t,
      {
        thread: t,
        writes: 0,
        up: 0,
        offPinned: 0,
        dead: 0,
        crossWrites: 0,
        crossStream: 0,
        crossRow: 0,
        crossOther: 0,
        crossOps: new Map(),
        moves: 0,
        silent: 0,
        silentValue: 0,
        crossValue: 0,
        valueCauses: new Map(),
        crossFrames: 0,
        pinnedOffFrames: 0,
        writeCallers: new Map(),
        silentCauses: new Map(),
        crossEvidence: [],
        biggestMove: 0,
        first: null,
        last: null,
      },
    ]),
  );

  // ---- writes ----
  const ops = rec.ops
    .map((o) => ({ ...o, keys: String(o.keys || "").split(",").filter(Boolean), frames: new Set(framesOf(o.by)), family: opFamily(o.by), caller: opCallerOf(o.by) }))
    .sort((a, b) => a.t - b.t);
  for (const w of rec.writes) {
    const row = per.get(w.card);
    if (!row) continue;
    const wFrames = new Set(framesOf(w.by));
    const near = opsInWindow(ops, w.t - 50, w.t);
    for (const k of ["writes"]) row[k] += 1;
    row.first = row.first == null ? w.t : Math.min(row.first, w.t);
    row.last = row.last == null ? w.t : Math.max(row.last, w.t);
    if (w.from - w.asked > 2) row.up += 1;
    if (w.dead) row.dead += 1;
    else if (w.pin && w.landedShort > OFF_BOTTOM) row.offPinned += 1;
    const name = w.via ? `${w.via}` : callerOf(w.by);
    const site = w.via ? `via ${w.via}` : siteOf(w.by);
    let c = row.writeCallers.get(name);
    if (!c) {
      c = { name, sites: new Map(), n: 0, up: 0, offPinned: 0, cross: 0 };
      row.writeCallers.set(name, c);
    }
    c.n += 1;
    c.sites.set(site, (c.sites.get(site) || 0) + 1);
    if (w.from - w.asked > 2) c.up += 1;
    if (!w.dead && w.pin && w.landedShort > OFF_BOTTOM) c.offPinned += 1;
    // Same-rebuild coupling with ANOTHER card: an operation that carried a different card ran in this write's own
    // rebuild (a shared caller frame, milliseconds before), and this write is the restore that followed it.
    const op = near.find((o) => sameRebuild(wFrames, w.t, o, w.row) && !o.keys.includes(w.card) && o.keys.some((k) => per.has(k)));
    if (op) {
      row.crossWrites += 1;
      c.cross += 1;
      const fam = op.family;
      if (fam === "stream") row.crossStream += 1;
      else if (fam === "row") row.crossRow += 1;
      else row.crossOther += 1;
      const on = `${op.caller} ${op.op}`;
      row.crossOps.set(on, (row.crossOps.get(on) || 0) + 1);
      if (row.crossEvidence.length < 12) row.crossEvidence.push({ kind: "write", at: w.t, card: w.card, family: fam, op: op.op, host: op.host, keys: op.keys.join(","), by: w.by, opBy: op.by });
    }
  }

  // ---- the value-level ledger: a move BETWEEN two writes ----
  // A clamp that is repaired inside one task never reaches a frame, but it does show up as the next write's `from`
  // disagreeing with the previous write's `landed` on the same box. This is the count tools/measure-console-writes.mjs
  // reports as "changed with no write", and it is kept separate from the painted count so a silent clamp is not
  // mistaken for a frame that moved.
  for (const t of ids) {
    const row = per.get(t);
    const mine = rec.writes.filter((w) => w.card === t).sort((a, b) => a.t - b.t);
    const lastByOut = new Map();
    for (const w of mine) {
      const prev = lastByOut.get(w.out);
      lastByOut.set(w.out, w);
      if (!prev || prev.landed === w.from) continue;
      row.silentValue += 1;
      const gap = opsInWindow(ops, prev.t, w.t);
      const ownOp = gap.find((o) => o.keys.includes(t));
      const otherOp = gap.find((o) => !o.keys.includes(t) && o.keys.some((k) => per.has(k)));
      const cause = ownOp ? `own layout (${ownOp.caller} ${ownOp.op})` : otherOp ? `cross layout (${otherOp.caller} ${otherOp.op})` : "browser";
      row.valueCauses.set(cause, (row.valueCauses.get(cause) || 0) + 1);
      if (!ownOp && otherOp) row.crossValue += 1;
    }
  }

  // ---- frames ----
  const frames = rec.frames;
  const writesByCard = new Map(ids.map((t) => [t, rec.writes.filter((w) => w.card === t).sort((a, b) => a.t - b.t)]));
  for (let i = 1; i < frames.length; i += 1) {
    const prev = frames[i - 1];
    const cur = frames[i];
    const gapOps = opsInWindow(ops, prev.t + 0.001, cur.t);
    for (const t of ids) {
      const a = prev.boxes[t];
      const b = cur.boxes[t];
      if (!a || !b || b.top === a.top) continue;
      const row = per.get(t);
      row.moves += 1;
      const d = b.top - a.top;
      if (Math.abs(d) > row.biggestMove) row.biggestMove = Math.abs(d);
      // A write in the gap OWNS this move: the value was asked for, so this is not the browser moving the box under a
      // writer. The write itself was already judged above (up / off-pinned / cross).
      const ws = opsInWindow(writesByCard.get(t), prev.t + 0.001, cur.t).filter((w) => !w.dead);
      if (ws.length) continue;
      row.silent += 1;
      const ownOp = gapOps.find((o) => o.keys.includes(t));
      const otherOp = gapOps.find((o) => o.keys.some((k) => k && k !== t));
      const ownGrew = b.sh !== a.sh || b.nodes !== a.nodes || b.last !== a.last;
      const othersGrew = ids.filter((x) => {
        if (x === t) return false;
        const pa = prev.boxes[x];
        const pb = cur.boxes[x];
        return pa && pb && (pb.sh !== pa.sh || pb.nodes !== pa.nodes || pb.last !== pa.last);
      });
      let cause;
      if (ownOp) cause = "own layout";
      else if (ownGrew) cause = "own growth";
      else if (othersGrew.length) cause = `cross growth (${othersGrew.join("+")})`;
      else if (otherOp) cause = "cross layout";
      else cause = "browser";
      row.silentCauses.set(cause, (row.silentCauses.get(cause) || 0) + 1);
      if (cause.startsWith("cross")) {
        row.crossFrames += 1;
        if (row.crossEvidence.length < 12) {
          row.crossEvidence.push({ kind: "frame", at: cur.t, card: t, delta: d, cause, ownOp: ownOp ? `${ownOp.op} ${ownOp.host} by ${ownOp.by}` : "", otherOp: otherOp ? `${otherOp.op} ${otherOp.host} by ${otherOp.by}` : "", others: othersGrew.join(","), sh: [a.sh, b.sh] });
        }
      }
    }
    // A pinned box read off its newest line on this frame: the defect a reader would see.
    for (const t of ids) {
      const b = cur.boxes[t];
      if (!b || !b.pin) continue;
      if (b.sh - b.top - b.ch > OFF_BOTTOM) per.get(t).pinnedOffFrames += 1;
    }
  }

  const out = {
    cards: [],
    totals: { writes: 0, up: 0, offPinned: 0, dead: 0, crossWrites: 0, crossStream: 0, crossRow: 0, crossOther: 0, moves: 0, silent: 0, crossFrames: 0, crossValue: 0, silentValue: 0, pinnedOffFrames: 0, frames: frames.length, ops: rec.ops.length },
  };
  for (const t of ids) {
    const r = per.get(t);
    const callers = [...r.writeCallers.values()]
      .map((c) => ({ name: c.name, n: c.n, up: c.up, off: c.offPinned, cross: c.cross, sites: [...c.sites.entries()].sort((a, b) => b[1] - a[1]).map(([site, n]) => ({ site, n })) }))
      .sort((a, b) => b.n - a.n);
    out.cards.push({
      ...r,
      crossOps: [...r.crossOps.entries()].sort((a, b) => b[1] - a[1]).map(([op, n]) => ({ op, n })),
      valueCauses: [...r.valueCauses.entries()].sort((a, b) => b[1] - a[1]).map(([cause, n]) => ({ cause, n })),
      writeCallers: callers,
      silentCauses: [...r.silentCauses.entries()].sort((a, b) => b[1] - a[1]).map(([cause, n]) => ({ cause, n })),
    });
    for (const k of ["writes", "up", "offPinned", "dead", "crossWrites", "crossStream", "crossRow", "crossOther", "moves", "silent", "silentValue", "crossValue", "crossFrames", "pinnedOffFrames"]) out.totals[k] += r[k];
  }
  out.meter = meter;
  return out;
}

// ---- the classifier's own sensitivity check ---------------------------------------------------------------
// The counts are only worth the classifier behind them. This feeds `analyze` two hand-built windows - one where a write
// on B follows a rebuild that carried A, one where B moves in a frame with no write while A grew - and requires each to
// land in the bucket it names, plus a clean window that must stay at zero. It runs in Node, so it cannot be vacuous
// because a browser refused to reproduce the shape.
function analyzerSelftest() {
  const cards = [{ thread: "A" }, { thread: "B" }];
  const box = (top, sh) => ({ top, sh, ch: 50, pin: 1, nodes: 1, last: 1 });
  const write = (over) => ({ t: 1.5, seq: 1, card: "B", row: "rowB", out: "b", from: 0, asked: 50, sh: 100, ch: 50, max: 50, pin: true, conn: true, dead: false, landed: 50, short: 0, landedShort: 0, by: "setScroll|app.js:1 < restoreScrolls|app.js:2 < placeRow|app.js:3 < flush|app.js:4", ...over });
  const op = { t: 1.4, seq: 1, op: "replaceWith", host: "div.agents-block", node: "div.agent-slot", row: "rowB", keys: "A", by: "fillAgentSlots|app.js:5 < placeRow|app.js:3 < flush|app.js:4" };
  const cross = analyze(cards, { writes: [write()], ops: [op], frames: [{ t: 1, boxes: { A: box(0, 100), B: box(0, 100) } }, { t: 2, boxes: { A: box(0, 100), B: box(50, 100) } }] }, {});
  const frameCross = analyze(cards, { writes: [], ops: [], frames: [{ t: 1, boxes: { A: box(0, 100), B: box(0, 100) } }, { t: 2, boxes: { A: box(0, 160), B: box(40, 100) } }] }, {});
  const clean = analyze(cards, { writes: [], ops: [], frames: [{ t: 1, boxes: { A: box(0, 100), B: box(0, 100) } }, { t: 2, boxes: { A: box(0, 100), B: box(0, 100) } }] }, {});
  return {
    ok: cross.cards[1].crossWrites === 1 && cross.cards[0].crossWrites === 0 && frameCross.cards[1].crossFrames === 1 && clean.totals.crossWrites === 0 && clean.totals.crossFrames === 0,
    crossWrite: cross.cards[1].crossWrites,
    crossFrame: frameCross.cards[1].crossFrames,
    clean: [clean.totals.crossWrites, clean.totals.crossFrames],
  };
}

// ---- one run ---------------------------------------------------------------------------------------------------------
async function run(pw) {
  const work = mkdtempSync(path.join(os.tmpdir(), "wtgui-cross-"));
  const rootA = path.join(work, "rootA");
  const project = "alpha";
  const main = path.join(rootA, project);
  const branches = Array.from({ length: CARDS - 1 }, (_, i) => `feature-${String.fromCharCode(98 + i)}`);
  const rows = [main, ...branches.map((b) => path.join(rootA, project, ".worktrees", b))];
  makeRepo(main, project);
  for (const b of branches) git(["worktree", "add", "-q", "-b", b, path.join(rootA, project, ".worktrees", b)], main);
  // Closed work: a file touched every 4 s keeps the ranking clock alive without adding a card to the measurement.
  const closed = ["g1", "g2"].map((n) => {
    const d = path.join(rootA, n);
    makeRepo(d, n);
    return d;
  });

  const gw = makeGateway(420_000);
  const gwPort = await gw.listen();
  const sandbox = await startPanelOnPort({
    port: PORT,
    dir: work,
    config: {
      scanRoots: [rootA],
      projects: [],
      refreshSeconds: 30,
      worktreeSeconds: 5,
      midSeconds: 45,
      dormantSeconds: 90,
      liveSeconds: 5,
      slowSeconds: 300,
      fetchSeconds: -1,
      assistant: { enabled: false },
      remoteBranchPolicy: "local-only",
      defaultCwd: rootA,
      apiServer: { url: `http://127.0.0.1:${gwPort}`, key: "probe" },
    },
  });
  const meter = { port: PORT, base: sandbox.base, pid: sandbox.pid, health: null, index: null };
  const browser = await pw.chromium.launch({ headless: HEADLESS });
  const out = { measured: false, cards: [], writes: [], ops: [], frames: [], analysis: null, errors: [], failures: [], notMeasured: [], meter };
  let touch = null;
  try {
    // ---- prove the panel serves before anything is driven ----
    const health = await fetch(`${sandbox.base}/api/health`).then((r) => r.json());
    const index = await fetch(`${sandbox.base}/`).then(async (r) => ({ status: r.status, type: r.headers.get("content-type"), body: await r.text() }));
    meter.health = { ok: health.ok, host: health.host, projects: health.projects, settingsVersion: health.settings && health.settings.version };
    meter.index = { status: index.status, type: index.type, bytes: index.body.length, hasApp: /app\.js/.test(index.body), title: (/<title>([^<]*)<\/title>/.exec(index.body) || [])[1] || "" };
    log("panel", `serving ${sandbox.base} (pid ${sandbox.pid}) health=${JSON.stringify(meter.health)} index=${index.status} ${meter.index.bytes} B hasApp=${meter.index.hasApp}`);
    if (index.status !== 200 || !meter.index.hasApp) throw new Error(`the panel did not serve the page on ${PORT} (status ${index.status}, app.js ${meter.index.hasApp})`);

    const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
    page.on("pageerror", (e) => out.errors.push(String((e && e.message) || e).slice(0, 200)));
    await page.addInitScript(pageInit);
    await page.goto(sandbox.base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state.rows && state.jobs, null, { timeout: 30_000 });
    await page.waitForFunction((n) => [...state.projects.keys()].includes(n), project, { timeout: 60_000 });
    const wantRows = rows.map((p) => ({ project, path: norm(p) }));
    await page.waitForFunction(
      (w) =>
        w.every((x) =>
          [...state.rows.values()].some((r) => r.project === x.project && String(r.path || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === x.path),
        ),
      wantRows,
      { timeout: 60_000 },
    );

    const spawned = [];
    for (const [i, p] of rows.entries()) {
      const thread = `cross-${i + 1}-${Date.now().toString(36).slice(-4)}`;
      const r = await fetch(`${sandbox.base}/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: `probe: stream plain text #${i + 1}`, cwd: p, existing: true, thread }),
      }).then((x) => x.json());
      if (!r || !r.job) throw new Error(`spawn failed for ${p}: ${JSON.stringify(r).slice(0, 300)}`);
      spawned.push({ thread, job: r.job.id, cwd: p, row: rows[i] });
    }
    out.cards = spawned.map((s) => ({ thread: s.thread, job: s.job, cwd: s.cwd }));

    // The 5 s liveness/ranking clock needs something to move that is not one of the three cards.
    touch = setInterval(() => {
      const pick = closed[Math.floor(Date.now() / 4000) % closed.length];
      try {
        writeFileSync(path.join(pick, `probe-${Date.now()}.txt`), "activity\n");
      } catch {
        /* the next tick picks another */
      }
    }, 4000);
    touch.unref?.();

    await page.waitForFunction((threads) => threads.every((t) => [...state.jobs.values()].some((j) => (j.thread || j.id) === t)), spawned.map((s) => s.thread), { timeout: 60_000 });
    await page.evaluate((w) => {
      const norm = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      for (const x of w) {
        const row = [...state.rows.values()].find((r) => r.project === x.project && norm(r.path) === x.path);
        if (!row) continue;
        state.expandedProjects.add(x.project);
        state.expanded.add(`${x.project}::${row.path}`);
      }
      renderAll();
    }, wantRows);
    await page.waitForFunction((threads) => threads.every((t) => !!document.querySelector(`.job[data-thread="${CSS.escape(t)}"] pre.job-out`)), spawned.map((s) => s.thread), { timeout: 60_000 });

    // ---- stream mode on all three, and reasoning that grows on every 1.2 s poll ----
    await page.evaluate((threads) => {
      for (const t of threads) window.setStreamMode(t, true);
      window.renderAll();
    }, spawned.map((s) => s.thread));
    const blocks = new Map();
    let polls = 0;
    await page.route("**/api/thinking*", async (route) => {
      const url = new URL(route.request().url());
      const thread = url.searchParams.get("thread") || "";
      polls += 1;
      let list = blocks.get(thread);
      if (!list) {
        list = [{ at: Math.floor(Date.now() / 1000), text: "the console is a fixed height box" }];
        blocks.set(thread, list);
      }
      // The first row is the one above the reader's line, so it is the one that must grow; a new row every fourth poll
      // makes the tail grow too.
      list[0].text = `${list[0].text} and the rows above the reader keep moving`;
      if (polls % 4 === 0) list.push({ at: Math.floor(Date.now() / 1000) + polls, text: "a new thought arrives at the tail" });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ thread, blocks: list }) });
    });

    const overflowed = await page
      .waitForFunction((n) => [...document.querySelectorAll("pre.job-out")].filter((o) => o.scrollHeight - o.clientHeight > 40).length >= n, spawned.length, {
        timeout: MAX_WAIT_MS,
        polling: 250,
      })
      .then(() => true)
      .catch(() => false);
    if (!overflowed) {
      out.notMeasured.push(`the consoles did not all overflow within ${Math.round(MAX_WAIT_MS / 1000)} s`);
      return out;
    }

    // The reader takes one console over. A console the panel keeps for the reader is the only one on which a write
    // from ANOTHER card is visible as a defect: a pinned box is expected to move down as its own agent writes.
    if (PARK) {
      await sleep(1200);
      const box = (await page.$$("pre.job-out"))[0];
      const r = box ? await box.boundingBox().catch(() => null) : null;
      if (r) {
        await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
        await page.mouse.wheel(0, -420);
      }
      out.parkState = await page.evaluate(() => {
        const el = document.querySelector("pre.job-out");
        if (!el) return null;
        const id = el.dataset.out || "";
        return { thread: el.closest(".job[data-thread]")?.dataset.thread || "", pinned: state.outPinned[id] !== false, dist: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight), max: Math.round(el.scrollHeight - el.clientHeight) };
      });
      if (!out.parkState || out.parkState.pinned || out.parkState.dist < 40) {
        out.parkState = await page.evaluate(() => {
          const el = document.querySelector("pre.job-out");
          if (!el) return null;
          el.dispatchEvent(new WheelEvent("wheel", { deltaY: -420, bubbles: true, cancelable: true }));
          el.scrollTop = Math.max(0, el.scrollTop - Math.round(el.clientHeight * 0.8));
          const id = el.dataset.out || "";
          return { thread: el.closest(".job[data-thread]")?.dataset.thread || "", pinned: state.outPinned[id] !== false, dist: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight), max: Math.round(el.scrollHeight - el.clientHeight), via: "dispatched" };
        });
      }
      log("parked", JSON.stringify(out.parkState));
    }

    // Where the cards are at the START of the window: one detail holding several cards is the shape in which a row pass
    // can move a card it does not own, so it is recorded rather than assumed.
    out.domBefore = await page.evaluate(() => [...document.querySelectorAll("tr.detail")].map((d) => ({
      row: d.dataset.detail || "",
      cards: [...d.querySelectorAll(".job[data-thread]")].map((c) => c.dataset.thread),
      consoles: d.querySelectorAll("pre.job-out").length,
    })).filter((d) => d.cards.length));

    // ---- the measured window ----
    await page.evaluate(() => {
      const R = window.__rec;
      R.writes.length = 0;
      R.ops.length = 0;
      R.frames.length = 0;
      window.__arm();
    });
    log("window", `${CARDS} cards streaming, ${SECONDS} s, port ${PORT}${out.parkState ? `, one console parked (${out.parkState.thread})` : ""}`);
    const t0 = Date.now();
    await page.waitForFunction((ms) => window.__now() >= (window.__rec.armAt || 0) + ms, SECONDS * 1000, { timeout: SECONDS * 1000 + 60_000, polling: 500 });
    // Close the window FIRST: the self-test writes to a console, and a write from the tool must never be counted.
    await page.evaluate(() => window.__endWindow());
    const selftest = await page.evaluate(() => window.__selftest());
    const rec = await page.evaluate(() => {
      window.__stop();
      return window.__dump();
    });
    out.selftest = selftest;
    out.windowMs = Date.now() - t0;
    // Where the three consoles actually live. This is evidence for the report, not an assertion: if one detail row holds
    // every card, a row pass over one of them moves all of them, and the numbers below have to be read with that in mind.
    out.dom = await page.evaluate((threads) => {
      const card = (el) => el.closest(".job[data-thread]")?.dataset.thread || "";
      return threads.map((t) => {
        const pre = [...document.querySelectorAll("pre.job-out")].find((p) => card(p) === t);
        if (!pre) return { thread: t, found: false };
        const detail = pre.closest("tr.detail");
        const row = detail?.previousElementSibling;
        return {
          thread: t,
          found: true,
          row: row?.dataset?.key || "",
          detail: detail ? `tr.detail[data-detail="${detail.dataset.detail || ""}"]` : "",
          cardsInDetail: detail ? detail.querySelectorAll(".job[data-thread]").length : 0,
          consolesInDetail: detail ? detail.querySelectorAll("pre.job-out").length : 0,
          agentsBlock: !!pre.closest(".agents-block"),
          max: Math.round(pre.scrollHeight - pre.clientHeight),
          pinned: typeof state !== "undefined" && state.outPinned ? state.outPinned[pre.dataset.out] !== false : null,
        };
      });
    }, out.cards.map((c) => c.thread));
    out.writes = rec.writes.filter((w) => w.t <= rec.windowEnd);
    out.ops = rec.ops.filter((o) => o.t <= rec.windowEnd);
    out.frames = rec.frames.filter((f) => f.t <= rec.windowEnd).map((f) => ({ ...f, boxes: Object.fromEntries(Object.entries(f.boxes).filter(([k]) => out.cards.some((c) => c.thread === k))) }));
    out.writesDropped = rec.writesDropped;
    out.opsDropped = rec.opsDropped;
    out.errors.push(...rec.errors.map((e) => String(e).slice(0, 200)));
    out.analysis = analyze(out.cards, out, { port: PORT, base: sandbox.base, health: meter.health, parkState: out.parkState || null, selftest, windowMs: out.windowMs });
    out.analysis.analyzer = analyzerSelftest();
    out.measured = out.writes.length > 0 && out.frames.length > 0;
    if (!out.measured) out.notMeasured.push("no scrollTop write or frame was recorded against the three cards");
    if (out.errors.length) out.failures.push(`${out.errors.length} page error(s): ${out.errors[0]}`);
    return out;
  } finally {
    if (touch) clearInterval(touch);
    await browser.close().catch(() => {});
    await gw.close().catch(() => {});
    await sandbox.stop().catch(() => {});
    rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  }
}

// ---- main ------------------------------------------------------------------------------------------------------------
if (!Number.isFinite(PORT) || PORT <= 0 || PORT > 65535) {
  console.log(`--port must be a TCP port; got ${JSON.stringify(opt("--port"))}`);
  process.exit(2);
}
if (PORT === 7331) {
  // Not a preference. 7331 is the reader's live board: a run that bound it would fight the panel the reader is working
  // in, and a run that drove it could not claim to have measured a throwaway. 7371 is this tool's own port.
  console.log("refusing --port 7331: that is the reader's live board (this tool measures its own panel, on 7371).");
  process.exit(2);
}
const pw = loadPlaywright({ root: TREE });
if (!pw) {
  console.log(notRun("tools/measure-console-cross-talk.mjs", "Playwright is not installed here (set PANEL_PLAYWRIGHT_ROOT to a directory that has node_modules/playwright)"));
  process.exit(2);
}
if (!(await portFree(PORT))) {
  console.log(`port ${PORT} is already in use; this tool will not share its panel (try --port 7372).`);
  process.exit(2);
}

console.log(`combined-console isolation: ${CARDS} cards, ${SECONDS} s, port ${PORT}, tree ${TREE}`);
let result;
try {
  result = await run(pw);
} catch (e) {
  console.log(`NOT MEASURED  the run broke: ${String((e && e.stack) || e).split("\n").slice(0, 4).join(" / ")}`);
  process.exit(2);
}

const a = result.analysis;
const verdict = result.measured && a ? "MEASURED" : "NOT MEASURED";
console.log("");
console.log(`${verdict.padEnd(12)} ${a ? `${a.totals.frames} frame(s), ${a.totals.writes} write(s), ${a.totals.ops} console op(s)` : "no recording"}`);
for (const f of result.notMeasured) console.log(`             ? ${f}`);
for (const f of result.failures) console.log(`             - ${f}`);
if (a) {
  console.log("");
  console.log("card                 writes   up  offP  dead  cross  moves  frame  value  crossF  cValue  pinOff  biggest");
  for (const c of a.cards) {
    console.log(
      `${String(c.thread).slice(0, 20).padEnd(20)} ${String(c.writes).padStart(6)} ${String(c.up).padStart(4)} ${String(c.offPinned).padStart(5)} ${String(c.dead).padStart(5)} ${String(c.crossWrites).padStart(6)} ${String(c.moves).padStart(6)} ${String(c.silent).padStart(6)} ${String(c.silentValue).padStart(6)} ${String(c.crossFrames).padStart(7)} ${String(c.crossValue).padStart(7)} ${String(c.pinnedOffFrames).padStart(7)} ${String(c.biggestMove).padStart(8)}`);
  }
  const t = a.totals;
  console.log(`${"TOTAL".padEnd(20)} ${String(t.writes).padStart(6)} ${String(t.up).padStart(4)} ${String(t.offPinned).padStart(5)} ${String(t.dead).padStart(5)} ${String(t.crossWrites).padStart(6)} ${String(t.moves).padStart(6)} ${String(t.silent).padStart(6)} ${String(t.silentValue).padStart(6)} ${String(t.crossFrames).padStart(7)} ${String(t.crossValue).padStart(7)} ${String(t.pinnedOffFrames).padStart(7)}`);
  console.log("");
  for (const c of a.cards) {
    console.log(`${c.thread}: writes by caller`);
    for (const w of c.writeCallers) console.log(`   ${String(w.n).padStart(5)}  ${w.name}${w.cross ? `  [cross ${w.cross}]` : ""}   ${w.sites.map((s) => `${s.site} (${s.n})`).join(", ")}`);
    if (c.crossOps.length) console.log(`         cross writes followed: ${c.crossOps.map((o) => `${o.op} ${o.n}`).join(", ")}`);
    if (c.silentCauses.length) console.log(`         silent-frame causes: ${c.silentCauses.map((s) => `${s.cause} ${s.n}`).join(", ")}`);
    if (c.valueCauses.length) console.log(`         value-change causes: ${c.valueCauses.map((s) => `${s.cause} ${s.n}`).join(", ")}`);
  }
  console.log("");
  console.log(`crossWrites ${t.crossWrites} (stream ${t.crossStream} / row ${t.crossRow} / other ${t.crossOther}) · crossFrames ${t.crossFrames}`);
  console.log("  crossWrites = a write to one card right after ANOTHER card's console was rebuilt in the same rebuild");
  console.log("  crossFrames = a painted frame where another card's content grew and this console moved with no write");
  if (result.domBefore) for (const d of result.domBefore) console.log(`  detail at arm: ${d.cards.length} card(s) / ${d.consoles} console(s) [${d.cards.join(", ")}] in ${d.row || "?"}`);
  if (result.dom) for (const d of result.dom) console.log(`  dom ${d.thread}: ${d.found ? `${d.cardsInDetail} card(s) / ${d.consolesInDetail} console(s) in ${d.detail || "no detail"}, max ${d.max}px, pinned ${d.pinned}` : "console not found at dump time"}`);
  console.log(`self-test: ${(result.selftest?.steps || []).map((s) => (s.ok ? "OK" : "FAIL")).join(" / ") || "none"}`);
  if (a.analyzer) console.log(`analyzer self-test: ${a.analyzer.ok ? "OK" : "FAIL"} (crossWrite ${a.analyzer.crossWrite}, crossFrame ${a.analyzer.crossFrame}, clean ${a.analyzer.clean.join("/")})`);
}

if (JSON_OUT) {
  writeFileSync(path.resolve(JSON_OUT), JSON.stringify(result, null, 2), "utf8");
  console.log(`json: ${path.resolve(JSON_OUT)}`);
}
process.exit(result.measured ? 0 : 2);
