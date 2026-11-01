// Is a live console independent of everything else on the board?
//
//   node tools/verify-console-independence.mjs                  # every layout, 45 s window each (~11 min)
//   node tools/verify-console-independence.mjs --only siblings  # one layout: one | siblings | projects | folders | cards | subs
//   node tools/verify-console-independence.mjs --seconds 90     # a longer window per layout
//   node tools/verify-console-independence.mjs --root <dir>     # serve another checkout (an export of an older build)
//   node tools/verify-console-independence.mjs --headed         # a window instead of headless Chromium
//
// THE CLAIM. A console follows its newest line until the reader scrolls it. Nothing that happens ELSEWHERE on the board
// - a closed project changing rank, another worktree being re-ranked, a second console streaming at the same moment -
// may put it anywhere else for even ONE painted frame. ("They should be completely independent.")
//
// WHAT IT GUARDS (docs/console-scroll-hop.md). appendChild on a node that is already attached is a remove-then-insert, and
// the browser gives every scroll box inside the node scrollTop 0. reorderProjects() did that to every section of a folder
// (and to every folder) whenever ANY one of them changed rank, so every open console snapped to its first line in the same
// frame and was pulled back by the next live line or the 400 ms sweep: "top and back down, flickering" - and with two
// consoles streaming, BOTH go in the same frame, which reads as something switching between them.
//
// WHAT IS DRIVEN (nothing synthetic reaches the page)
//   * a throwaway panel of its own (tools/panel-testkit.mjs: spare port, own PANEL_CONFIG / HERMES_HOME / jobs.json,
//     API_SERVER_KEY empty), serving the chosen checkout, so the reader's panel on 7331 is never touched
//   * a stub Runs API that plays plain text over real SSE, one word every 75 ms per run; the cards are spawned through
//     the panel's own POST /api/agents and every line reaches the page as a `jobline` frame from the panel's own server
//   * a churn driver that touches a file in a CLOSED project every 4 s, which is what makes the folder's ranking move on
//     a real board of a hundred repos: without it the ranking never moves and there is nothing to survive
//   * a page-side recorder: a requestAnimationFrame sampler over every `pre.job-out` (what a frame can paint), the DOM
//     primitives that move a subtree carrying a console (with the page function that called them), and the page's own
//     reorderProjects() wrapped to count how often the ranking really moved a section or a folder
//
// LAYOUTS
//   one       ONE streaming console                                        (control: is a single console ever reset?)
//   siblings  TWO consoles, two sibling worktree rows of ONE project       (the reader's board: four sessions, one repo)
//   projects  TWO consoles in TWO projects of one folder
//   folders   TWO consoles in one project of one folder, while two OTHER folders swap rank
//   cards     TWO live cards in ONE worktree row that swap places, with Stabilize reordering off - the one setting under
//             which the panel is ALLOWED to move an open card: literally "something switching between them"
//   subs      TWO sessions in sibling rows, each with a running SUBAGENT whose own console the reader has opened under
//             its card: the roster poll re-reads both children, and one child's read must not rebuild, or put back at its
//             first line, the other session's console. The poll is the page's own; only its two endpoints are answered here
//   rebuild   TWO live consoles in one row whose own DETAIL a file in its worktree rebuilds, with one console parked by
//             the reader, and a third agent in a row that stays shut until the window is open - so one rebuild has to
//             BUILD a card: a console with the whole history in it, no old node to measure and no remembered place. That
//             is docs/console-rebuild-built-card.md; before the fix it was painted at its first line for two frames.
//
// WHAT IT ASSERTS, per layout
//   (1) hops: no console that overflows is painted at scrollTop <= 2 in any frame of the window (a reader who never
//       scrolled it). Zero, not "few": the repair arrives 4-400 ms later, and that gap IS the flicker.
//   (2) the run measured something: every console overflowed, the ranking really moved a section (or a folder) at least
//       3 times - in `cards`, two cards really swapped places at least 3 times - and the page raised no error.
//   (3) the recorder can see the fault: after the window, a RAW re-append of an open section (what the old code did)
//       resets a console to 0 in this browser and the recorder's own test calls it a hop. A clean run on a browser
//       that cannot reproduce the fault proves nothing, so that is exit 2, not a pass.
//
// Exit codes: 0 every layout held; 1 a console was reset (or the page erred); 2 the run did not measure what it claims
// (no Playwright, consoles never overflowed, the ranking never moved, the premise did not hold).
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadPlaywright, notRun } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const SECONDS = Number(opt("--seconds", 45));
const ONLY = opt("--only");
const HEADLESS = !argv.includes("--headed");
const MAX_WAIT_MS = 150_000;
const MIN_RANK_MOVES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (tag, ...a) => console.log(`[${tag}]`, ...a);

const LAYOUTS = {
  one: { desc: "ONE streaming console", cards: [{ project: "alpha" }], folders: 1 },
  siblings: { desc: "TWO consoles in sibling worktree rows of ONE project", cards: [{ project: "alpha" }, { project: "alpha", branch: "feature-b" }], folders: 1 },
  projects: { desc: "TWO consoles in TWO projects of one folder", cards: [{ project: "alpha" }, { project: "beta" }], folders: 1 },
  folders: { desc: "TWO consoles in one project while two OTHER folders swap rank", cards: [{ project: "alpha" }, { project: "alpha", branch: "feature-b" }], folders: 3 },
  // The one setting under which the panel may move an OPEN card: with Stabilize reordering off a row's cards are
  // re-ranked on every clock tick, and two live cards in one worktree row are the pair that swap places. The swap is
  // forced here (the page's stored order is flipped every 4 s and its own reorderAgentCards() acts on it), because the
  // ranking only flips a pair when their rates cross by its margin - which a real pair does and a stub pair does not.
  cards: { desc: "TWO live cards in ONE worktree row swapping places (Stabilize reordering off)", cards: [{ project: "alpha" }, { project: "alpha" }], folders: 1, swap: true },
  // A session that delegates shows its children under its console, and the reader can open a child's own console
  // there. The roster poll re-reads every open child that is still running and repaints the strips: one child's read
  // is the other session's business only if the page makes it so.
  subs: { desc: "TWO sessions, each with a running subagent whose console is open", cards: [{ project: "alpha" }, { project: "alpha", branch: "feature-b" }], folders: 1, subs: true },
  // A row's detail is rebuilt whenever a field it draws changes - the row gaining a file, its verdict moving. placeRow
  // then carries every card through a fresh agent slot, and the browser gives every scroll box in a moved subtree
  // scrollTop 0 with no write. This is the layout for the reader's report ("every card rebuild jumps a console to the
  // top"): a file appearing in the row's OWN worktree is the panel's own news, and the consoles have to survive it.
  // Two cards in the row so a move has another console to get wrong, and a THIRD agent in a second row that stays
  // closed until the window is open - the row the reader opens then has a card a rebuild has to BUILD, with the whole
  // history in it and no old node to measure.
  rebuild: { desc: "TWO live consoles in a row whose own detail a new file rebuilds", cards: [{ project: "alpha" }, { project: "alpha" }], extra: [{ project: "alpha", branch: "feature-b" }], folders: 1, rebuild: true },
};

// ---- the stub Hermes gateway: plain text, one word per 75 ms, over real SSE ---------------------------------------------
const WORDS = `the console is a fixed height box and its content is longer than the box
a repaint that patches the row extends the words and moves nothing else
keeping the newest line in view means scrolling to the bottom after every growth
a reader who has scrolled up is a reader the panel must not touch
the sweep runs on its own clock whether or not the wire is moving
a card that keeps its node keeps the reader's place in it`.split(/\s+/).filter(Boolean);

function script(seed, lenMs) {
  const out = [];
  let t = 300;
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
      return json(200, { version: "independence-stub", features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true } });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      req.resume();
      req.on("end", () => {
        posts += 1;
        const id = `run_indep_${posts}`;
        runs.set(id, { id, startedAt: null, script: script(posts === 1 ? 0 : 37, lenMs) });
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

// ---- the page-side recorder -------------------------------------------------------------------------------------------
function pageInit(opts) {
  try {
    // Stabilize reordering is the reader's own setting; off means a list may re-sort under an open card.
    if (opts && opts.stabilizeOff) localStorage.setItem("wtgui.stabilize", "0");
  } catch {
    /* storage may be unavailable */
  }
  const T0 = performance.now();
  const now = () => Math.round((performance.now() - T0) * 10) / 10;
  const R = { hops: [], moves: [], reorder: { calls: 0, sectionMoves: 0, folderMoves: 0, cardCalls: 0, cardMoves: 0, stripPaints: 0, stripRebuilds: 0, fillCalls: 0, fresh: 0 }, errors: [], frames: 0, overflowAt: null, armN: 0, stopped: false };
  window.__rec = R;
  window.__now = now;
  window.addEventListener("error", (e) => R.errors.push(String((e && e.message) || e)));
  window.addEventListener("unhandledrejection", (e) => R.errors.push(`unhandledrejection: ${String((e && e.reason && (e.reason.message || e.reason)) || "")}`));

  // The page's own caller, innermost first: the init script's wrappers are not page files and are skipped.
  const pageStack = (max) => {
    const out = [];
    for (const line of String(new Error().stack || "").split("\n").slice(1)) {
      const m = /^\s*at\s+(?:(.*?)\s+\()?(.*?):(\d+):(\d+)\)?\s*$/.exec(line);
      if (!m || !/\/(app|assistant)\.js|\/core\//.test(m[2])) continue;
      out.push(String(m[1] || "<anon>").replace(/^async\s+/, "").replace(/^(?:new\s+)?(?:Object|Array|Promise|Window|Node|Element|HTMLElement)\./, ""));
      if (out.length >= max) break;
    }
    return out.join(" < ");
  };
  const desc = (n) => {
    if (!n || n.nodeType !== 1) return n ? n.nodeName : "";
    const cn = typeof n.className === "string" ? n.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".") : "";
    const d = n.dataset || {};
    const id = d.project ? `[${d.project}]` : d.root ? "[folder]" : "";
    return `${n.tagName.toLowerCase()}${cn ? `.${cn}` : ""}${id}`;
  };

  // The hop test: one definition, used by the sampler AND by the sensitivity check below.
  const isHop = (top, max) => top <= 2 && max > 20;
  window.__isHop = isHop;

  // What a frame can paint: one record per episode (consecutive hop frames of one node), with its length in frames.
  const inHop = new Map();
  const seen = new Set();
  const sample = () => {
    if (R.stopped) return;
    R.frames += 1;
    const t = now();
    for (const el of document.querySelectorAll("pre.job-out, .sub-console")) {
      const top = Math.round(el.scrollTop);
      const max = Math.round(el.scrollHeight - el.clientHeight);
      const out = el.dataset.out || el.dataset.subConsoleBox || "";
      if (max > 20) {
        seen.add(out);
        if (R.armN && R.overflowAt == null && seen.size >= R.armN) R.overflowAt = t;
      }
      if (max > (R.maxDepth || 0)) R.maxDepth = max;
      const open = inHop.get(el);
      if (R.overflowAt != null && isHop(top, max)) {
        if (open) open.frames += 1;
        else {
          const rec = { t, out, top, max, frames: 1 };
          inHop.set(el, rec);
          R.hops.push(rec);
        }
      } else if (open) {
        open.endT = t;
        inHop.delete(el);
      }
    }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
  window.__arm = (n) => {
    R.armN = n;
  };

  // The DOM primitives, filtered to subtrees that carry a console. The outs are read BEFORE the op (a fragment is empty
  // after it); no geometry is read here, because a layout read while a subtree is detached manufactures the clamp.
  const carries = (nodes) => {
    for (const n of nodes) {
      if (!n || (n.nodeType !== 1 && n.nodeType !== 11)) continue;
      if (n.nodeType === 1 && n.matches && n.matches("pre.job-out, .sub-console")) return true;
      if (n.querySelector && n.querySelector("pre.job-out, .sub-console")) return true;
    }
    return false;
  };
  const wrap = (proto, name, pick) => {
    const orig = proto[name];
    if (typeof orig !== "function" || orig.__m) return;
    const w = function () {
      let host = null;
      let nodes = [];
      let carry = false;
      let attached = false;
      try {
        const p = pick(this, arguments);
        host = p[0];
        nodes = Array.from(p[1] || []);
        carry = carries(nodes);
        attached = nodes.some((n) => n && n.nodeType === 1 && n.isConnected);
      } catch {
        /* never break the page */
      }
      const r = orig.apply(this, arguments);
      try {
        if (carry && R.moves.length < 3000) R.moves.push({ t: now(), op: name, attached, host: desc(host), node: desc(nodes.find((n) => n && n.nodeType === 1)), by: pageStack(4) });
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
  // The subagent strips are rebuilt with `outerHTML =`, which is none of the primitives above.
  const outer = Object.getOwnPropertyDescriptor(Element.prototype, "outerHTML");
  if (outer && outer.set && !outer.set.__m) {
    const set = function (v) {
      let carry = false;
      let host = null;
      try {
        carry = Boolean(this.querySelector && this.querySelector(".sub-console")) || Boolean(this.matches && this.matches(".sub-console"));
        host = this.parentNode;
      } catch {
        /* never break the page */
      }
      const node = desc(this);
      outer.set.call(this, v);
      try {
        if (carry && R.moves.length < 3000) R.moves.push({ t: now(), op: "outerHTML", attached: true, host: desc(host), node, by: pageStack(4) });
      } catch {
        /* ignore */
      }
    };
    set.__m = true;
    Object.defineProperty(Element.prototype, "outerHTML", { ...outer, set });
  }

  // After app.js has defined its functions: count how often the ranking really moved a section or a folder.
  window.__instrument = () => {
    const orig = window.reorderProjects;
    if (typeof orig !== "function" || orig.__c) return false;
    const orderOf = (sel, key) => [...document.querySelectorAll(sel)].map((e) => e.dataset[key]).join("|");
    const c = function () {
      const s0 = orderOf("section.project", "project");
      const f0 = orderOf("section.root-group", "root");
      const r = orig.apply(this, arguments);
      R.reorder.calls += 1;
      if (orderOf("section.project", "project") !== s0) R.reorder.sectionMoves += 1;
      if (orderOf("section.root-group", "root") !== f0) R.reorder.folderMoves += 1;
      return r;
    };
    c.__c = true;
    window.reorderProjects = c;
    const origSubs = window.paintSubagents;
    if (typeof origSubs === "function" && !origSubs.__c) {
      const cs = function () {
        const before = new Set(document.querySelectorAll(".sub-console"));
        const r = origSubs.apply(this, arguments);
        R.reorder.stripPaints += 1;
        for (const el of document.querySelectorAll(".sub-console")) {
          if (!before.has(el)) {
            R.reorder.stripRebuilds += 1;
            break;
          }
        }
        return r;
      };
      cs.__c = true;
      window.paintSubagents = cs;
    }
    // The cards of every row, in the order they are on screen.
    const cardsOf = () =>
      [...document.querySelectorAll(".agents-block")]
        .map((b) => [...b.children].filter((el) => el.classList && el.classList.contains("job") && el.dataset.thread).map((el) => el.dataset.thread).join(","))
        .join("|");
    const origCards = window.reorderAgentCards;
    if (typeof origCards === "function" && !origCards.__c) {
      const cc = function () {
        const before = cardsOf();
        const r = origCards.apply(this, arguments);
        R.reorder.cardCalls += 1;
        if (cardsOf() !== before) R.reorder.cardMoves += 1;
        return r;
      };
      cc.__c = true;
      window.reorderAgentCards = cc;
    }
    // A detail rebuild: fillAgentSlots() moves a row's cards into a fresh detail, and a thread with no old card is
    // BUILT there - a console that never had a node to measure and starts at its first line. Counted separately,
    // because "the rebuild never ran" and "the rebuild built a card" are different answers about a clean run.
    const origFill = window.fillAgentSlots;
    if (typeof origFill === "function" && !origFill.__c) {
      const cf = function (root, reuse) {
        // A card BUILT by this rebuild is a slot with no card to carry into it. A console node that was carried in is
        // not "fresh" just because it was outside the document (the old detail) when the call started.
        const slots = root ? [...root.querySelectorAll("[data-agent-slot]")] : [];
        const carried = slots.filter((s) => reuse && reuse.has(s.dataset.agentSlot)).length;
        const made = slots.length - carried;
        const r = origFill.apply(this, arguments);
        R.reorder.fillCalls += 1;
        R.reorder.fresh += made;
        R.reorder.fillLog = R.reorder.fillLog || [];
        if (R.reorder.fillLog.length < 40) R.reorder.fillLog.push({ t: now(), by: pageStack(3), reuse: carried, fresh: made });
        return r;
      };
      cf.__c = true;
      window.fillAgentSlots = cf;
    }
    return true;
  };
  // Flip the stored order of every row's cards and let the page's own reorderAgentCards() act on it.
  window.__startSwaps = (everyMs) => {
    let flip = false;
    return setInterval(() => {
      if (R.stopped) return;
      flip = !flip;
      for (const [key, dEl] of state.detailEls) {
        const block = dEl.querySelector(".agents-block");
        if (!block) continue;
        const threads = [...block.children].filter((el) => el.classList.contains("job") && el.dataset.thread).map((el) => el.dataset.thread).sort();
        if (threads.length < 2) continue;
        state.rankOrder.set(`agents:${key}`, flip ? threads : threads.slice().reverse());
        reorderAgentCards(state.rows.get(key).project);
      }
    }, everyMs);
  };
  // The measured window can start later than the arm: a layout that has to wait for a DEEP console, a parked reader or
  // a card that a rebuild must build discards what happened while setting that up, so its frames are not the finding.
  window.__restartWindow = () => {
    R.overflowAt = now();
    R.hops.length = 0;
    R.moves.length = 0;
    R.reorder.fillCalls = 0;
    R.reorder.fresh = 0;
    inHop.clear();
  };
  window.__stop = () => {
    R.stopped = true;
  };
}

// ---- fixtures ----------------------------------------------------------------------------------------------------------
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

async function runLayout(name, spec, pw, startPanel) {
  const work = mkdtempSync(path.join(os.tmpdir(), "wtgui-indep-"));
  const roots = [path.join(work, "rootA")];
  if (spec.folders > 1) roots.push(path.join(work, "rootB"), path.join(work, "rootC"));
  const live = ["alpha", "beta"];
  const closedA = ["g1", "g2", "g3", "g4"];
  for (const n of [...live, ...closedA]) makeRepo(path.join(roots[0], n), n);
  const closed = closedA.map((n) => path.join(roots[0], n));
  if (spec.folders > 1) {
    // Two more folders, each with closed projects only. Their projects take turns being touched, so the two folders
    // swap rank while the folder holding the open consoles has to keep its place.
    for (const [i, r] of roots.slice(1).entries()) for (const n of [`f${i}a`, `f${i}b`]) makeRepo(path.join(r, n), n);
    closed.length = 0;
    for (const r of roots.slice(1)) for (const n of readdirSync(r)) closed.push(path.join(r, n));
  }
  const cardCwd = (c) => (c.branch ? path.join(roots[0], c.project, ".worktrees", c.branch) : path.join(roots[0], c.project));
  // `extra` cards are spawned too, but their rows are NOT opened with the board: one of them is the row the reader
  // opens during the window, whose card a rebuild has to build from nothing.
  const extraCards = spec.extra || [];
  for (const c of [...spec.cards, ...extraCards]) if (c.branch) git(["worktree", "add", "-q", "-b", c.branch, cardCwd(c)], path.join(roots[0], c.project));

  const gw = makeGateway(420_000);
  const gwPort = await gw.listen();
  const sandbox = await startPanel({
    dir: work,
    config: {
      scanRoots: roots,
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
      defaultCwd: roots[0],
      apiServer: { url: `http://127.0.0.1:${gwPort}`, key: "probe" },
    },
    env: { API_SERVER_KEY: "" },
  });
  const browser = await pw.chromium.launch({ headless: HEADLESS });
  let touch = null;
  let openTimer = null;
  const out = { name, desc: spec.desc, failures: [], notMeasured: [], hops: [], rank: null, consoles: 0, errors: [] };
  try {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
    page.on("pageerror", (e) => out.errors.push(String((e && e.message) || e).slice(0, 200)));
    await page.addInitScript(pageInit, { stabilizeOff: Boolean(spec.swap) });
    await page.goto(sandbox.base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state.rows && state.jobs, null, { timeout: 30_000 });
    await page.waitForFunction((names) => names.every((n) => [...state.projects.keys()].includes(n)), [...new Set(spec.cards.map((c) => c.project))], { timeout: 60_000 });
    await page.evaluate(() => window.__instrument());
    // A card is owned by a row, so the sibling worktree has to be listed before its run is spawned.
    const wantRows = spec.cards.map((c) => ({ project: c.project, path: norm(cardCwd(c)) }));
    await page.waitForFunction(
      (w) => w.every((x) => [...state.rows.values()].some((r) => r.project === x.project && String(r.path || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === x.path)),
      wantRows,
      { timeout: 60_000 },
    );
    const spawned = [];
    for (const [i, c] of spec.cards.entries()) {
      const thread = `indep-${name}-${i + 1}`;
      const r = await fetch(`${sandbox.base}/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: `probe: stream plain text #${i + 1}`, cwd: cardCwd(c), existing: true, thread }),
      }).then((x) => x.json());
      if (!r || !r.job) throw new Error(`spawn failed for ${JSON.stringify(c)}: ${JSON.stringify(r).slice(0, 300)}`);
      spawned.push({ thread, job: r.job.id });
    }
    // A second row's agent, streaming from the same moment, whose row stays shut: nothing draws its card until the
    // rebuild that opens the row, and that card's console is built with the whole history and no old node to measure.
    const extraSpawned = [];
    for (const [i, c] of extraCards.entries()) {
      const thread = `indep-${name}-next-${i + 1}`;
      const r = await fetch(`${sandbox.base}/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: `probe: a card a rebuild has to build #${i + 1}`, cwd: cardCwd(c), existing: true, thread }),
      }).then((x) => x.json());
      if (!r || !r.job) throw new Error(`spawn failed for extra ${JSON.stringify(c)}: ${JSON.stringify(r).slice(0, 300)}`);
      extraSpawned.push({ thread, job: r.job.id, cwd: cardCwd(c) });
    }
    out.extra = extraSpawned.length;
    const startTouch = () => {
      if (touch) return;
      touch = setInterval(() => {
        if (spec.rebuild) {
          // A file in the row's OWN worktree. The panel's next scan sends that row again, placeRow sees a field it
          // draws changed and rebuilds its detail - the reader's own board doing the thing that jumps their consoles.
          try {
            writeFileSync(path.join(roots[0], "alpha", `probe-${Date.now()}.txt`), "activity\n");
          } catch {
            /* the next tick writes another */
          }
          return;
        }
        const pick = closed[Math.floor(Date.now() / 4000) % closed.length];
        try {
          writeFileSync(path.join(pick, `probe-${Date.now()}.txt`), "activity\n");
        } catch {
          /* the next tick picks another */
        }
      }, spec.rebuild ? 3000 : 4000);
      touch.unref?.();
    };
    // A rebuild layout starts its clock with the window: a touch before the reader is parked would rebuild the very
    // detail the park is being taken in, and the park (a wheel on a node that is gone) would not stick.
    if (!spec.rebuild) startTouch();
    await page.waitForFunction((threads) => threads.every((t) => [...state.jobs.values()].some((j) => (j.thread || j.id) === t)), spawned.map((s) => s.thread), { timeout: 60_000 });
    // The reader has these projects and rows open: that is what a console on screen means.
    await page.evaluate((w) => {
      for (const x of w) {
        const row = [...state.rows.values()].find((r) => r.project === x.project && String(r.path || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === x.path);
        if (!row) continue;
        state.expandedProjects.add(x.project);
        state.expanded.add(`${x.project}::${row.path}`);
      }
      renderAll();
    }, wantRows);
    for (const s of spawned) await page.waitForSelector(`.job[data-thread="${s.thread}"] pre.job-out`, { timeout: 45_000 });
    if (spec.subs) {
      // The panel reads children from the agent's own store, which a sandbox does not have: answer the poll's two
      // endpoints (the roster, and one child's console) and let the page's own code do everything else - the 5 s poll,
      // the re-read of every open child that is still out, the strip repaint.
      const born = Date.now();
      const childOf = (thread) => `child-of-${thread}`;
      await page.route("**/api/subagents**", (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/api/subagents/console")) {
          const id = url.searchParams.get("session") || "";
          const n = 60 + Math.floor((Date.now() - born) / 2500) * 4; // a child that is still writing
          return route.fulfill({ json: { running: true, lines: Array.from({ length: n }, (_, i) => ({ kind: "raw", text: `${id} line ${i}`, lid: `${id}:${i}` })) } });
        }
        if (url.pathname.endsWith("/api/subagents")) {
          const roster = {};
          for (const s of spawned) {
            roster[s.thread] = [{ id: childOf(s.thread), title: `review for ${s.thread}`, running: true, startedAt: born + 500, endedAt: null, lastSeen: Date.now(), hung: false, msgs: 3, preview: null }];
          }
          return route.fulfill({ json: { roster } });
        }
        return route.continue();
      });
      for (const s of spawned) {
        const row = `.sub-row[data-sub-console="${childOf(s.thread)}"]`;
        await page.waitForSelector(row, { timeout: 30_000 });
        await page.click(row);
      }
      for (const s of spawned) await page.waitForSelector(`.sub-console[data-sub-console-box="${childOf(s.thread)}"]`, { timeout: 30_000 });
    }
    out.consoles = spawned.length * (spec.subs ? 2 : 1);
    await page.evaluate((n) => window.__arm(n), out.consoles);
    const t0 = Date.now();
    // A parked console needs somewhere to park: a box 30 px deep has no scrollback to take away, and a wheel over it
    // moves nothing, which would make the park (and therefore every "did it move" claim) vacuous.
    const needDepth = spec.rebuild ? 300 : 0;
    await page
      .waitForFunction((need) => window.__rec.overflowAt != null && (window.__rec.maxDepth || 0) >= need, needDepth, { timeout: MAX_WAIT_MS, polling: 250 })
      .catch(() => {});
    let overflowAt = await page.evaluate(() => window.__rec.overflowAt);
    if (overflowAt == null) {
      out.notMeasured.push(`the consoles did not all overflow within ${Math.round(MAX_WAIT_MS / 1000)} s`);
      return out;
    }
    log(name, `${out.consoles} console(s) overflowing after ${Math.round((Date.now() - t0) / 1000)} s; measuring ${SECONDS} s`);
    if (spec.swap) await page.evaluate(() => window.__startSwaps(4000));
    // A row that is still shut, whose agent has been streaming since the board loaded: the reader opens it DURING the
    // window, and the card that row needs has never existed. That is the "created in that same rebuild" half of the
    // report - the console the caller's capture map cannot have an entry for.
    const shutRow = async () => {
      const c = extraCards[0];
      if (!c) return null;
      const found = await page.evaluate((want) => {
        const row = [...state.rows.values()].find(
          (r) => r.project === want.project && String(r.path || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase().endsWith(want.branch),
        );
        if (!row) return null;
        const key = `${row.project}::${row.path}`;
        state.expanded.add(key);
        renderProjectRows(row.project);
        return { key, cards: [...(state.detailEls.get(key)?.querySelectorAll(".job[data-thread]") || [])].length };
      }, { project: c.project, branch: String(c.branch) });
      return found;
    };
    if (spec.rebuild) {
      // The reader parks one console well above its tail with a real wheel, and leaves it alone. If any console may be
      // painted at its first line it must not be this one.
      for (let attempt = 0; attempt < 4; attempt++) {
        const spot = await page.evaluate(() => {
          const el = [...document.querySelectorAll("pre.job-out")].find((o) => o.scrollHeight - o.clientHeight > 260);
          if (!el) return null;
          el.scrollIntoView({ block: "center" });
          const r = el.getBoundingClientRect();
          return { id: el.dataset.out, x: Math.round(r.x + 30), y: Math.round(r.y + 30), max: Math.round(el.scrollHeight - el.clientHeight) };
        });
        if (!spot) break;
        await page.mouse.move(spot.x, spot.y);
        // A wheel of a third of the box: far enough off the tail that the page records a real park, short of the top so
        // a box painted at 0 is never the reader's own doing.
        await page.mouse.wheel(0, -Math.max(40, Math.min(140, Math.floor(spot.max / 3))));
        await sleep(600);
        const held = await page.evaluate((id) => {
          const rec = state.outScrolls[id];
          return { pin: state.outPinned[id], top: rec ? Math.round(rec.top) : null, atBottom: rec ? rec.atBottom : null };
        }, spot.id);
        out.park = { ...spot, ...held };
        if (held.pin === false && held.top >= 60) break;
      }
      if (!out.park || out.park.pin !== false) out.notMeasured.push(`the reader's park did not stick (${JSON.stringify(out.park)})`);
      // Everything above was setup: the window this layout is judged on starts now, with the reader parked and a row
      // still shut. The touches (and the rebuilds they cause) start here too, so none of the setup is counted.
      overflowAt = await page.evaluate(() => {
        window.__restartWindow();
        return window.__rec.overflowAt;
      });
      startTouch();
      openTimer = setTimeout(() => {
        void shutRow().then((r) => {
          out.opened = r;
        });
      }, Math.max(3000, Math.min(8000, Math.round((SECONDS * 1000) / 4))));
    }
    for (;;) {
      const t = await page.evaluate(() => window.__now());
      if (t >= overflowAt + SECONDS * 1000) break;
      await sleep(Math.min(1000, overflowAt + SECONDS * 1000 - t));
    }
    const rec = await page.evaluate(() => {
      window.__stop();
      return { hops: window.__rec.hops, moves: window.__rec.moves, reorder: window.__rec.reorder, errors: window.__rec.errors, frames: window.__rec.frames };
    });
    out.rank = rec.reorder;
    out.errors.push(...rec.errors.map((e) => String(e).slice(0, 200)));
    out.hops = rec.hops.map((h) => {
      // the console-carrying DOM move that landed just before the frame that painted it
      const mv = rec.moves.filter((m) => m.t <= h.t && h.t - m.t < 120 && /reorder|sweep|placeRow|renderProjectRows|renderJobs|applySnapshot|renderAll|pinOpen|paintSubagents/i.test(m.by)).slice(-1)[0];
      return { ...h, cause: mv ? `${mv.by.split(" < ")[0] || "?"} | ${mv.op} | ${mv.node}` : "no DOM move within 120 ms" };
    });
    // (3) can the recorder see the fault in this browser? A raw re-append of an open section, in one task.
    const premise = await page.evaluate(() => {
      const el = [...document.querySelectorAll("pre.job-out")].find((o) => o.scrollHeight - o.clientHeight > 20 && o.closest("section.project"));
      if (!el) return { ok: false, why: "no overflowing console inside a section" };
      const sec = el.closest("section.project");
      const before = Math.round(el.scrollTop);
      const maxBefore = Math.round(el.scrollHeight - el.clientHeight);
      sec.parentNode.appendChild(sec);
      const after = Math.round(el.scrollTop);
      const maxAfter = Math.round(el.scrollHeight - el.clientHeight);
      return { ok: before > 20 && after <= 2 && window.__isHop(after, maxAfter), before, after, maxBefore, maxAfter };
    });
    out.premise = premise;
    if (!premise.ok) out.notMeasured.push(`a raw re-append of an open section did not reset a console here (${JSON.stringify(premise)}), so this browser cannot show the fault`);
    const moved = spec.rebuild
      ? rec.reorder.fillCalls
      : spec.swap
        ? rec.reorder.cardMoves
        : spec.subs
          ? rec.reorder.stripPaints
          : rec.reorder.sectionMoves + rec.reorder.folderMoves;
    if (moved < MIN_RANK_MOVES) {
      out.notMeasured.push(
        `${spec.rebuild ? "a row detail was rebuilt through fillAgentSlots" : spec.swap ? "the cards swapped places" : spec.subs ? "the subagent strips were repainted" : "the ranking moved a section/folder"} only ${moved}x (< ${MIN_RANK_MOVES}); nothing was there to survive`,
      );
    }
    // The other half of the rebuild: one of those rebuilds has to have BUILT a card, or the console with no old node
    // (the one this layout exists for) was never on the page and a clean result says nothing about it.
    if (spec.rebuild && rec.reorder.fresh < 1) {
      out.notMeasured.push("no rebuild created a card, so the console with no old node to measure was never exercised");
    }
    if (spec.rebuild && (!out.opened || !out.opened.cards)) {
      out.notMeasured.push(`the row that was still shut was never opened (${JSON.stringify(out.opened)})`);
    }
    if (out.hops.length) out.failures.push(`${out.hops.length} painted hop(s)`);
    if (out.errors.length) out.failures.push(`${out.errors.length} page error(s): ${out.errors[0]}`);
    return out;
  } finally {
    if (touch) clearInterval(touch);
    if (openTimer) clearTimeout(openTimer);
    await browser.close().catch(() => {});
    await gw.close().catch(() => {});
    await sandbox.stop().catch(() => {});
    rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  }
}

// ---- main --------------------------------------------------------------------------------------------------------------
const pw = loadPlaywright({ root: TREE });
if (!pw) {
  console.log(notRun("tools/verify-console-independence.mjs", "Playwright is not installed here (set PANEL_PLAYWRIGHT_ROOT to a directory that has node_modules/playwright)"));
  process.exit(2);
}
const { startPanel } = await import(pathToFileURL(path.join(TREE, "tools", "panel-testkit.mjs")).href);
const names = Object.keys(LAYOUTS).filter((n) => !ONLY || n === ONLY);
if (!names.length) {
  console.log(`unknown layout ${ONLY}; one of ${Object.keys(LAYOUTS).join(", ")}`);
  process.exit(2);
}
console.log(`console independence on ${TREE} (${SECONDS} s window per layout)`);
const results = [];
for (const name of names) {
  try {
    results.push(await runLayout(name, LAYOUTS[name], pw, startPanel));
  } catch (e) {
    results.push({ name, desc: LAYOUTS[name].desc, failures: [], notMeasured: [`the run broke: ${String((e && e.stack) || e).split("\n").slice(0, 3).join(" / ")}`], hops: [], rank: null, consoles: 0, errors: [] });
  }
}

let red = 0;
let blind = 0;
console.log("");
for (const r of results) {
  const rank = r.rank
    ? `${r.rank.sectionMoves} section move(s), ${r.rank.folderMoves} folder move(s) in ${r.rank.calls} reorderProjects call(s); ${r.rank.cardMoves} card swap(s) in ${r.rank.cardCalls} reorderAgentCards call(s); ${r.rank.stripRebuilds} of ${r.rank.stripPaints} strip repaint(s) replaced a sub-console; ${r.rank.fillCalls || 0} detail rebuild(s) moved cards through fillAgentSlots, ${r.rank.fresh || 0} console(s) built by one`
    : "no ranking data";
  const verdict = r.notMeasured.length ? "NOT MEASURED" : r.failures.length ? "FAIL" : "PASS";
  if (verdict === "FAIL") red += 1;
  if (verdict === "NOT MEASURED") blind += 1;
  console.log(`${verdict.padEnd(12)} ${r.name.padEnd(9)} ${r.desc}`);
  console.log(`             ${r.consoles} console(s); ${rank}; ${r.hops.length} painted hop(s)`);
  for (const f of r.failures) console.log(`             - ${f}`);
  for (const f of r.notMeasured) console.log(`             ? ${f}`);
  const frames = new Map();
  for (const h of r.hops) frames.set(Math.round(h.t), (frames.get(Math.round(h.t)) || 0) + 1);
  const causes = {};
  for (const h of r.hops) causes[h.cause] = (causes[h.cause] || 0) + 1;
  if (r.hops.length) {
    console.log(`             ${frames.size} distinct frame(s), ${[...frames.values()].filter((n) => n > 1).length} with more than one console at the top`);
    const per = {};
    for (const h of r.hops) per[h.out] = (per[h.out] || 0) + 1;
    console.log(`             per console: ${Object.entries(per).map(([k, n]) => `${k} ${n}`).join(", ")}`);
    for (const [c, n] of Object.entries(causes).sort((a, b) => b[1] - a[1])) console.log(`             ${String(n).padStart(3)}x  ${c}`);
    for (const h of r.hops.slice(0, 5)) console.log(`             t=${Math.round(h.t)}ms console ${h.out} at ${h.top} (max ${h.max}), ${h.frames} frame(s)`);
  }
  if (r.premise) console.log(`             sensitivity: raw re-append took a console from ${r.premise.before ?? "?"} to ${r.premise.after ?? "?"} (hop test says ${r.premise.ok ? "hop" : "no hop"})`);
  if (r.park) console.log(`             the reader's park: console ${r.park.id} at ${r.park.top} of ${r.park.max} (max), pin ${r.park.pin}, atBottom ${r.park.atBottom}`);
  for (const f of (r.rank && r.rank.fillLog) || []) console.log(`             fill t=${Math.round(f.t)}ms reuse ${f.reuse} fresh ${f.fresh} by ${String(f.by).slice(0, 120)}`);
}
console.log("");
if (red) {
  console.log(`FAIL  ${red} of ${results.length} layout(s) reset a console that nobody scrolled`);
  process.exit(1);
}
if (blind) {
  console.log(`NOT MEASURED  ${blind} of ${results.length} layout(s) did not measure what they claim - a pass here would be a pass on nothing`);
  process.exit(2);
}
console.log(`PASS  ${results.length} layout(s): no console left the bottom of its own box while the board re-ranked around it`);
process.exit(0);
