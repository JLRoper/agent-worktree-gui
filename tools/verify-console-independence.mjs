// Is a live console independent of everything else on the board?
//
//   node tools/verify-console-independence.mjs                  # every layout, 45 s window each (~7 min)
//   node tools/verify-console-independence.mjs --only siblings  # one layout: one | siblings | projects | folders
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
//
// WHAT IT ASSERTS, per layout
//   (1) hops: no console that overflows is painted at scrollTop <= 2 in any frame of the window (a reader who never
//       scrolled it). Zero, not "few": the repair arrives 4-400 ms later, and that gap IS the flicker.
//   (2) the run measured something: every console overflowed, the ranking really moved a section (or a folder) at least
//       3 times, and the page raised no error.
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
function pageInit() {
  const T0 = performance.now();
  const now = () => Math.round((performance.now() - T0) * 10) / 10;
  const R = { hops: [], moves: [], reorder: { calls: 0, sectionMoves: 0, folderMoves: 0 }, errors: [], frames: 0, overflowAt: null, armN: 0, stopped: false };
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
    for (const el of document.querySelectorAll("pre.job-out")) {
      const top = Math.round(el.scrollTop);
      const max = Math.round(el.scrollHeight - el.clientHeight);
      const out = el.dataset.out || "";
      if (max > 20) {
        seen.add(out);
        if (R.armN && R.overflowAt == null && seen.size >= R.armN) R.overflowAt = t;
      }
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
      if (n.nodeType === 1 && n.matches && n.matches("pre.job-out")) return true;
      if (n.querySelector && n.querySelector("pre.job-out")) return true;
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
    return true;
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
  for (const c of spec.cards) if (c.branch) git(["worktree", "add", "-q", "-b", c.branch, cardCwd(c)], path.join(roots[0], c.project));

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
  const out = { name, desc: spec.desc, failures: [], notMeasured: [], hops: [], rank: null, consoles: 0, errors: [] };
  try {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
    page.on("pageerror", (e) => out.errors.push(String((e && e.message) || e).slice(0, 200)));
    await page.addInitScript(pageInit);
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
    out.consoles = spawned.length;
    await page.evaluate((n) => window.__arm(n), spawned.length);
    const t0 = Date.now();
    await page.waitForFunction(() => window.__rec.overflowAt != null, null, { timeout: MAX_WAIT_MS, polling: 250 }).catch(() => {});
    const overflowAt = await page.evaluate(() => window.__rec.overflowAt);
    if (overflowAt == null) {
      out.notMeasured.push(`the consoles did not all overflow within ${Math.round(MAX_WAIT_MS / 1000)} s`);
      return out;
    }
    log(name, `${spawned.length} console(s) overflowing after ${Math.round((Date.now() - t0) / 1000)} s; measuring ${SECONDS} s`);
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
      const mv = rec.moves.filter((m) => m.t <= h.t && h.t - m.t < 120 && /reorder|sweep|placeRow|renderProjectRows|renderJobs|applySnapshot|renderAll|pinOpen/i.test(m.by)).slice(-1)[0];
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
    if (rec.reorder.sectionMoves + rec.reorder.folderMoves < MIN_RANK_MOVES) {
      out.notMeasured.push(`the ranking moved a section/folder only ${rec.reorder.sectionMoves + rec.reorder.folderMoves}x (< ${MIN_RANK_MOVES}); nothing was there to survive`);
    }
    if (out.hops.length) out.failures.push(`${out.hops.length} painted hop(s)`);
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
  const rank = r.rank ? `${r.rank.sectionMoves} section move(s), ${r.rank.folderMoves} folder move(s) in ${r.rank.calls} reorderProjects call(s)` : "no ranking data";
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
    for (const [c, n] of Object.entries(causes).sort((a, b) => b[1] - a[1])) console.log(`             ${String(n).padStart(3)}x  ${c}`);
    for (const h of r.hops.slice(0, 5)) console.log(`             t=${Math.round(h.t)}ms console ${h.out} at ${h.top} (max ${h.max}), ${h.frames} frame(s)`);
  }
  if (r.premise) console.log(`             sensitivity: raw re-append took a console from ${r.premise.before ?? "?"} to ${r.premise.after ?? "?"} (hop test says ${r.premise.ok ? "hop" : "no hop"})`);
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
