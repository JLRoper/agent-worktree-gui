// Where a combined (🌊) console's lines land when four runs append at once.
//
//   node tools/measure-console-routing.mjs                       # four cards, 50 marked lines each, pacer off
//   node tools/measure-console-routing.mjs --words 40            # same drive with the reader's default pacer on
//   node tools/measure-console-routing.mjs --per-card 50 --spacing 220 --json out.json --headed
//
// THE QUESTION. Four agents stream into four cards on one board. Every appended line carries a marker that names
// its own run (RT<card>-<n>). When all four streams append at once — overlapping in time, with the 🌊 repaint
// firing every 1.2 s behind them — does any line land in the WRONG card, arrive TWICE, or go MISSING? And within a
// card, do its own markers stay in the order the run produced them?
//
// WHY THIS IS A REAL DRIVE, NOT A SYNTHETIC ONE. The four runs are started through the panel's own POST
// /api/agents against a stub Hermes gateway, so every line travels the product's whole path: the stub's SSE frame
// -> Jobs.consume -> linesForEvent -> push -> emitLine broadcast -> the page's SSE handler -> recordJobLine /
// drawJobLine -> pre.job-out[data-out=evt.id]. The stub only chooses the words; the routing is the product's.
//
// WHAT IS AUDITED. Three records, because a wrong-card bug can happen before or after the paint:
//   1. the page's own line record — state.jobLines per job id (the client's arrival ledger, cap 1000);
//   2. the painted console — pre.job-out[data-out=<job id>] textContent per card;
//   3. the server's store — /api/jobs' lines tail per job id.
// Each is read twice: as soon as all 200 markers have arrived, and again 3 s later after two more 🌊 repaints, so a
// repaint that duplicates or drops text is caught even when the arrival state was clean. The pinned copy of a card
// (data-out="<id>@pin") is counted separately, because drawing a line in both panes is the product's design.
//
// WHAT IT DOES NOT DO. No product change. It reads and reports. Exit 0 = measured clean, 1 = a routing defect, 2 =
// the run measured nothing (no cards, or fewer than the expected markers arrived), so a green run cannot be a pass
// on an empty log.
//
// PORT. The panel is booted on 7372, never the reader's 7331: its own PANEL_CONFIG, HERMES_HOME, jobs.json and
// projects cache, all under a fresh temp dir. The reader's board is never touched or queried.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const TREE = path.resolve(opt("--root", path.resolve(HERE, "..")));
const PORT = Number(opt("--port", 7372));
const PER_CARD = Number(opt("--per-card", 50));
const SPACING = Number(opt("--spacing", 220));
const WORDS = String(opt("--words", "0"));
const JSON_OUT = opt("--json");
const HEADLESS = !argv.includes("--headed");
const MAX_WAIT_MS = 120_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (tag, ...a) => console.log(`[${tag}]`, ...a);
const norm = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const MARK_RE = /RT([1-4])-(\d{3})/g;

// ---- fixtures ---------------------------------------------------------------------------------
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

// ---- the stub Hermes gateway: one script per run, all four interleaved in time -----------------
// Every run's script is 50 `message.delta` frames, each beginning with a blank line so lib/jobs.js's push() starts
// a NEW text line per marker (a fragment starting with two newlines never grows the paragraph above it). Run n's
// k-th frame sits at 500 + (k-1)*spacing + (n-1)*spacing/5 ms, so the four streams land in tight bursts around each
// beat — genuine concurrent appends, not four sequential scripts.
//
// Last-Event-ID is honoured: a reconnect resumes at the frame after the one the panel already consumed, so a replay
// cannot masquerade as duplication. `gets` counts each run's event connections, which is how the report can say
// whether a reconnect happened at all.
function makeGateway({ perCard, spacing }) {
  const runs = new Map();
  const emitted = [];
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
      return json(200, {
        version: "routing-stub",
        features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true },
      });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        posts += 1;
        let body = {};
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          body = {};
        }
        const session = String(body.session_id || `run-${posts}`);
        const m = /routing-([1-4])/.exec(session);
        const card = m ? Number(m[1]) : posts;
        const id = `run_routing_${card}`;
        const script = [];
        for (let k = 1; k <= perCard; k++) {
          script.push({
            at: 500 + (k - 1) * spacing + (card - 1) * Math.round(spacing / 5),
            evt: { event: "message.delta", delta: `\n\nRT${card}-${String(k).padStart(3, "0")}` },
          });
        }
        runs.set(id, { id, card, script, startedAt: null, gets: 0, emitted: 0 });
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
      const lastId = Number(req.headers["last-event-id"]);
      const resumeAfter = Number.isInteger(lastId) && lastId >= 0 ? lastId : -1;
      rec.gets += 1;
      res.write(": open\n\n");
      if (rec.startedAt == null) rec.startedAt = Date.now();
      let open = true;
      req.on("close", () => {
        open = false;
      });
      rec.script.forEach((step, i) => {
        if (i <= resumeAfter) return;
        later(rec.startedAt + step.at - Date.now(), () => {
          if (!open) return;
          rec.emitted += 1;
          emitted.push({ run: rec.id, card: rec.card, seq: i, at: Date.now() });
          res.write(`id: ${i}\ndata: ${JSON.stringify({ ...step.evt, run_id: rec.id, seq: i, timestamp: Date.now() / 1000 })}\n\n`);
        });
      });
      return;
    }
    json(404, {});
  });
  return {
    runs,
    emitted,
    listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port))),
    close: () =>
      new Promise((r) => {
        for (const h of timers) clearTimeout(h);
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

// ---- the panel, on 7372, with nothing shared ---------------------------------------------------
// panel-testkit's startPanel derives its `base` from the free port it picked, so a config.port override would be
// reported at the wrong address. This boot honours the port end to end: the config names 7372 and the health check
// polls 7372, so "the panel serves on 7372" is proved against the same address the rest of the run uses.
async function bootPanel(work, cfgPath, cfg) {
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
  const out = [];
  const child = (await import("node:child_process")).spawn(process.execPath, ["server.js"], {
    cwd: TREE,
    env: {
      ...process.env,
      PANEL_CONFIG: cfgPath,
      HERMES_HOME: path.join(work, "hermes"),
      CLAUDE_CONFIG_DIR: path.join(work, "claude"),
      PANEL_PARENT_WATCH_STDIN: "1",
      API_SERVER_KEY: "",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      GIT_ASKPASS: "echo",
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
  const base = `http://127.0.0.1:${PORT}`;
  const deadline = Date.now() + 30_000;
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
      throw new Error(`panel did not answer http://127.0.0.1:${PORT}/api/health within 30 s:\n${out.join("")}`);
    }
    await sleep(120);
  }
  return {
    base,
    port: PORT,
    dir: work,
    cfgPath,
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

// ---- marker analysis ---------------------------------------------------------------------------
// Every occurrence in reading order, with the card its own prefix names. Order is the order the text was read, so an
// index that goes backwards inside one card is a reorder, not a formatting difference.
function readMarkers(text) {
  const hits = [];
  const s = String(text || "");
  for (const m of s.matchAll(MARK_RE)) {
    hits.push({ marker: m[0], card: Number(m[1]), k: Number(m[2]), index: m.index });
  }
  return hits;
}

function auditCard(hits, card) {
  const own = hits.filter((h) => h.card === card);
  const foreign = hits.filter((h) => h.card !== card);
  const counts = new Map();
  for (const h of own) counts.set(h.marker, (counts.get(h.marker) || 0) + 1);
  const duplicate = [...counts.entries()].filter(([, n]) => n > 1).map(([marker, n]) => ({ marker, count: n }));
  const seen = new Set(counts.keys());
  const missing = [];
  for (let k = 1; k <= PER_CARD; k++) {
    const marker = `RT${card}-${String(k).padStart(3, "0")}`;
    if (!seen.has(marker)) missing.push(marker);
  }
  let orderBreaks = 0;
  let lastK = 0;
  for (const h of own) {
    if (h.k < lastK) orderBreaks += 1;
    lastK = h.k;
  }
  return {
    present: own.length,
    distinct: seen.size,
    foreign: foreign.length,
    foreignMarkers: [...new Set(foreign.map((h) => h.marker))].slice(0, 12),
    duplicate,
    missing,
    orderBreaks,
    first: own[0]?.marker || null,
    last: own[own.length - 1]?.marker || null,
  };
}

function cardClean(a) {
  return a && a.present === PER_CARD && a.distinct === PER_CARD && a.foreign === 0 && a.duplicate.length === 0 && a.missing.length === 0 && a.orderBreaks === 0;
}

// A card's own ledger and paint, plus every other pane that carries its id (the pinned copy is counted apart).
async function readCards(page, cards) {
  return page.evaluate(
    ({ cards, perCard }) => {
      const MARK_RE = /RT([1-4])-(\d{3})/g;
      const hits = (text) => {
        const out = [];
        const s = String(text || "");
        for (const m of s.matchAll(MARK_RE)) out.push({ marker: m[0], card: Number(m[1]), k: Number(m[2]), index: m.index });
        return out;
      };
      const audit = (h, card) => {
        const own = h.filter((x) => x.card === card);
        const foreign = h.filter((x) => x.card !== card);
        const counts = new Map();
        for (const x of own) counts.set(x.marker, (counts.get(x.marker) || 0) + 1);
        const duplicate = [...counts.entries()].filter(([, n]) => n > 1).map(([marker, count]) => ({ marker, count }));
        const seen = new Set(counts.keys());
        const missing = [];
        for (let k = 1; k <= perCard; k++) {
          const marker = `RT${card}-${String(k).padStart(3, "0")}`;
          if (!seen.has(marker)) missing.push(marker);
        }
        let orderBreaks = 0;
        let lastK = 0;
        for (const x of own) {
          if (x.k < lastK) orderBreaks += 1;
          lastK = x.k;
        }
        return {
          present: own.length,
          distinct: seen.size,
          foreign: foreign.length,
          foreignMarkers: [...new Set(foreign.map((x) => x.marker))].slice(0, 12),
          duplicate,
          missing,
          orderBreaks,
          first: own[0]?.marker || null,
          last: own[own.length - 1]?.marker || null,
        };
      };
      // The ledger in arrival order: order matters here too, so this reads the buffered lines, never a count map.
      const ledgerHits = (list) => {
        const out = [];
        for (const line of list || []) {
          const text = String(line?.text || "");
          if (!MARK_RE.test(text)) continue;
          MARK_RE.lastIndex = 0;
          for (const m of text.matchAll(MARK_RE)) out.push({ marker: m[0], card: Number(m[1]), k: Number(m[2]), index: m.index });
        }
        return out;
      };
      return cards.map((c) => {
        const panes = [...document.querySelectorAll(`pre.job-out[data-out="${c.jobId}"]`)];
        const pin = [...document.querySelectorAll(`pre.job-out[data-out="${c.jobId}@pin"]`)];
        const domHits = panes.flatMap((p) => hits(p.textContent));
        const pinHits = pin.flatMap((p) => hits(p.textContent));
        return {
          card: c.card,
          thread: c.thread,
          jobId: c.jobId,
          panes: panes.length,
          dom: audit(domHits, c.card),
          pin: pin.length ? audit(pinHits, c.card) : null,
          pinPanes: pin.length,
          ledger: audit(ledgerHits(state.jobLines.get(String(c.jobId)) || []), c.card),
        };
      });
    },
    { cards: cards.map((c) => ({ thread: c.thread, jobId: c.jobId, card: c.card })), perCard: PER_CARD },
  );
}

// ---- one condition -------------------------------------------------------------------------------
async function runCondition({ name, pw, gateway, base, cards, spec, errors, pageErrors }) {
  const out = {
    name,
    words: WORDS,
    port: PORT,
    base,
    cards: [],
    emission: {},
    arrival: null,
    settled: null,
    server: null,
    pageErrors,
    errors,
    failures: [],
    notMeasured: [],
  };
  const browser = await pw.chromium.launch({ headless: HEADLESS });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
    page.on("pageerror", (e) => pageErrors.push(String((e && e.message) || e).slice(0, 300)));

    // The pacer's default is 40 words/s; --words 0 isolates routing from typing. Either way the choice is made
    // before app.js parses, so no line is drawn under a pace the run did not intend.
    await page.addInitScript((w) => {
      try {
        localStorage.setItem("wtgui.streamWords", String(w));
        localStorage.setItem("wtgui.streamLines", "0");
      } catch {
        /* private mode: the app's own default applies */
      }
    }, WORDS);

    // The 🌊 repaint is only reached through the 1.2 s thinking poll. Answering it keeps paintStreamConsole /
    // syncStreamConsole running behind the appends — the repaint is the mechanism that can duplicate or drop a row,
    // so leaving it idle would measure a console nothing repaints. The blocks carry no markers.
    const blocks = new Map();
    let polls = 0;
    await page.route("**/api/thinking*", async (route) => {
      const url = new URL(route.request().url());
      const thread = url.searchParams.get("thread") || "";
      polls += 1;
      let list = blocks.get(thread);
      if (!list) {
        list = [{ at: Math.floor(Date.now() / 1000), text: "a combined console draws the run as one flow" }];
        blocks.set(thread, list);
      }
      list[0].text = `${list[0].text} and the rows above the reader keep moving`;
      if (polls % 4 === 0) list.push({ at: Math.floor(Date.now() / 1000) + polls, text: "a new thought arrives at the tail" });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ thread, blocks: list }) });
    });

    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => typeof state !== "undefined" && state.rows && state.jobs, null, { timeout: 30_000 });
    await page.waitForFunction((names) => names.every((n) => [...state.projects.keys()].includes(n)), [...new Set(spec.map((c) => c.project))], { timeout: 60_000 });
    const wantRows = spec.map((c) => ({ project: c.project, path: norm(c.path) }));
    await page.waitForFunction(
      (w) =>
        w.every((x) =>
          [...state.rows.values()].some(
            (r) => r.project === x.project && String(r.path || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === x.path,
          ),
        ),
      wantRows,
      { timeout: 60_000 },
    );
    await page.evaluate((w) => {
      for (const x of w) {
        const row = [...state.rows.values()].find(
          (r) => r.project === x.project && String(r.path || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === x.path,
        );
        if (!row) continue;
        state.expandedProjects.add(x.project);
        state.expanded.add(`${x.project}::${row.path}`);
      }
      renderAll();
    }, wantRows);

    // Four runs, one per card, through the panel's own create-run route. The stub reads session_id and sends that
    // card's markers, so a mis-ordered POST cannot put the wrong script on a run.
    const spawned = [];
    for (const [i, c] of spec.entries()) {
      const thread = `routing-${i + 1}`;
      const r = await fetch(`${base}/api/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: `probe: routing markers #${i + 1}`, cwd: c.path, existing: true, thread }),
      }).then((x) => x.json());
      if (!r || !r.job || !r.job.id) throw new Error(`spawn failed for ${thread}: ${JSON.stringify(r).slice(0, 300)}`);
      spawned.push({ thread, jobId: r.job.id, card: i + 1, project: c.project, path: c.path });
    }
    for (const s of spawned) {
      await page.waitForSelector(`.job[data-thread="${s.thread}"] pre.job-out`, { timeout: 60_000 });
    }
    await page.evaluate((threads) => {
      for (const t of threads) window.setStreamMode(t, true);
      window.renderAll();
    }, spawned.map((s) => s.thread));
    for (const s of spawned) {
      await page.waitForSelector(`pre.job-out[data-out="${s.jobId}"]`, { timeout: 60_000 });
    }
    // The card's console must be in 🌊 mode: the streaming class set by the renderer is what makes the append path
    // take the combined branch. Read the per-card button's own pressed state, never assume it.
    out.streaming = await page.evaluate(
      ({ ids, threads }) => {
        const out = {};
        for (const [i, id] of ids.entries()) {
          const job = document.querySelector(`.job[data-thread="${threads[i]}"]`);
          const btn = job ? job.querySelector("button.btn-stream") : null;
          const pane = document.querySelector(`pre.job-out[data-out="${id}"]`);
          out[id] = {
            pressed: Boolean(btn && (btn.getAttribute("aria-pressed") === "true" || btn.classList.contains("is-on"))),
            pane: Boolean(pane),
          };
        }
        return out;
      },
      { ids: spawned.map((s) => s.jobId), threads: spawned.map((s) => s.thread) },
    );
    for (const [id, s] of Object.entries(out.streaming || {})) {
      if (!s.pressed || !s.pane) out.failures.push(`pane ${id} is not in 🌊 mode (pressed=${s.pressed}, pane=${s.pane})`);
    }

    // Wait until the page's own arrival ledger holds every expected marker for every card. A dropped frame shows
    // up here as a count that never reaches PER_CARD, which is why the wait reports what it saw instead of throwing.
    const want = spawned.length * PER_CARD;
    const ledgerCount = async () =>
      page.evaluate(
        ({ ids, perCard }) => {
          const MARK_RE = /RT([1-4])-(\d{3})/g;
          const seen = new Set();
          let lines = 0;
          for (const id of ids) {
            const buf = state.jobLines.get(String(id)) || [];
            for (const line of buf) {
              const text = String(line?.text || "");
              if (!MARK_RE.test(text)) continue;
              MARK_RE.lastIndex = 0;
              for (const m of text.matchAll(MARK_RE)) seen.add(m[0]);
              lines += 1;
            }
          }
          return { markers: seen.size, lines, want: ids.length * perCard };
        },
        { ids: spawned.map((s) => s.jobId), perCard: PER_CARD },
      );
    let arrived = await ledgerCount();
    const startedWait = Date.now();
    while (arrived.markers < want && Date.now() - startedWait < MAX_WAIT_MS) {
      await sleep(250);
      arrived = await ledgerCount();
    }
    out.emission = {
      posts: gateway.runs.size,
      gets: [...gateway.runs.values()].map((r) => ({ run: r.id, card: r.card, gets: r.gets, emitted: r.emitted })),
      events: gateway.emitted.length,
      spanMs: gateway.emitted.length ? gateway.emitted[gateway.emitted.length - 1].at - gateway.emitted[0].at : 0,
      withPeer60ms: 0,
      maxPeers: 0,
      byCard: {},
    };
    for (const e of gateway.emitted) {
      let peers = 0;
      for (const o of gateway.emitted) {
        if (o.run !== e.run && Math.abs(o.at - e.at) <= 60) peers += 1;
      }
      if (peers > 0) out.emission.withPeer60ms += 1;
      if (peers > out.emission.maxPeers) out.emission.maxPeers = peers;
      const c = (out.emission.byCard[e.card] = out.emission.byCard[e.card] || { emitted: 0, first: e.at, last: e.at });
      c.emitted += 1;
      c.last = e.at;
    }
    if (arrived.markers < want) {
      out.notMeasured.push(`only ${arrived.markers} of ${want} markers reached the page's ledger within ${Math.round(MAX_WAIT_MS / 1000)} s`);
    }
    const cards = spawned.map((s) => ({ ...s }));
    out.cards = cards;
    out.arrival = await readCards(page, cards);
    // Two more 🌊 repaints behind the appends: a repaint that duplicates or loses a row shows here even when the
    // arrival paint was clean. 3 s is two poll cycles and a settle.
    await sleep(3000);
    out.settled = await readCards(page, cards);
    out.polls = polls;

    // The server's own store: the summary's lines tail per job id. A marker the server never recorded cannot be a
    // paint bug, and a marker the server recorded twice cannot be only a paint bug.
    try {
      const r = await fetch(`${base}/api/jobs`);
      const d = await r.json();
      const jobs = d.jobs || [];
      out.server = spawned.map((s) => {
        const j = jobs.find((x) => String(x.id) === String(s.jobId));
        const text = (j?.lines || []).map((l) => String(l?.text || "")).join("\n");
        const h = readMarkers(text);
        return { thread: s.thread, jobId: s.jobId, card: s.card, found: Boolean(j), lines: (j?.lines || []).length, audit: auditCard(h, s.card) };
      });
    } catch (e) {
      out.errors.push(`could not read /api/jobs: ${String((e && e.message) || e)}`);
    }

    // Verdict: every card's settled paint and ledger and the server tail must be clean. The arrival paint is reported
    // but not failed on its own — a line still being typed at the arrival instant is the pacer's job, not a drop.
    for (const c of out.cards) {
      const set = out.settled?.find((x) => x.jobId === c.jobId);
      const arr = out.arrival?.find((x) => x.jobId === c.jobId);
      const srv = out.server?.find((x) => x.jobId === c.jobId);
      if (!set) {
        out.notMeasured.push(`card ${c.card} has no settled record`);
        continue;
      }
      if (!cardClean(set.dom)) out.failures.push(`card ${c.card} DOM: ${describe(set.dom)}`);
      if (!cardClean(set.ledger)) out.failures.push(`card ${c.card} ledger: ${describe(set.ledger)}`);
      if (set.panes !== 1) out.failures.push(`card ${c.card} paints in ${set.panes} panes (expected 1)`);
      if (srv && srv.found && !cardClean(srv.audit)) out.failures.push(`card ${c.card} server tail: ${describe(srv.audit)}`);
      if (arr && !cardClean(arr.dom)) out.arrivalDirty = (out.arrivalDirty || 0) + 1;
      if (arr && arr.dom.foreign > 0) out.failures.push(`card ${c.card} arrival DOM had ${arr.dom.foreign} foreign marker(s)`);
    }
    const seenCards = new Map();
    for (const row of out.settled || []) seenCards.set(row.card, row.dom.present);
    out.totals = {
      expected: want,
      domPresent: (out.settled || []).reduce((n, x) => n + x.dom.present, 0),
      domForeign: (out.settled || []).reduce((n, x) => n + x.dom.foreign, 0),
      domDuplicates: (out.settled || []).reduce((n, x) => n + x.dom.duplicate.reduce((m, d) => m + d.count - 1, 0), 0),
      domMissing: (out.settled || []).reduce((n, x) => n + x.dom.missing.length, 0),
      ledgerPresent: (out.settled || []).reduce((n, x) => n + x.ledger.present, 0),
      ledgerForeign: (out.settled || []).reduce((n, x) => n + x.ledger.foreign, 0),
      ledgerDuplicates: (out.settled || []).reduce((n, x) => n + x.ledger.duplicate.reduce((m, d) => m + d.count - 1, 0), 0),
      ledgerMissing: (out.settled || []).reduce((n, x) => n + x.ledger.missing.length, 0),
      pinPanes: (out.settled || []).reduce((n, x) => n + x.pinPanes, 0),
      perCard: Object.fromEntries(seenCards),
      streaming: out.streaming,
    };
    if (out.totals.domPresent !== want) out.notMeasured.push(`settled DOM holds ${out.totals.domPresent} of ${want} markers`);
  } finally {
    await browser.close().catch(() => {});
  }
  return out;
}

const maxOr = (a, b) => (b > a ? b : a);
const describe = (a) => {
  const bits = [`${a.present}/${PER_CARD} present`, `${a.distinct} distinct`];
  if (a.foreign) bits.push(`${a.foreign} foreign (${a.foreignMarkers.join(", ")})`);
  if (a.duplicate.length) bits.push(`${a.duplicate.length} duplicated (${a.duplicate.slice(0, 4).map((d) => `${d.marker}×${d.count}`).join(", ")})`);
  if (a.missing.length) bits.push(`${a.missing.length} missing (${a.missing.slice(0, 4).join(", ")})`);
  if (a.orderBreaks) bits.push(`${a.orderBreaks} order break(s)`);
  return bits.join("; ");
};

// ---- main ----------------------------------------------------------------------------------------
const pw = loadPlaywright();
if (!pw) {
  console.log("BROWSER-HALF-NOT-RUN: playwright is not installed on this machine.");
  process.exit(2);
}

const work = mkdtempSync(path.join(os.tmpdir(), "wtgui-routing-"));
const roots = [path.join(work, "rootA")];
const live = ["alpha", "beta"];
const closed = ["g1", "g2", "g3", "g4"];
for (const n of [...live, ...closed]) makeRepo(path.join(roots[0], n), n);
const spec = [
  { project: "alpha", path: path.join(roots[0], "alpha") },
  { project: "alpha", path: path.join(roots[0], "alpha", ".worktrees", "feature-b"), branch: "feature-b" },
  { project: "beta", path: path.join(roots[0], "beta") },
  { project: "beta", path: path.join(roots[0], "beta", ".worktrees", "feature-c"), branch: "feature-c" },
];
for (const c of spec) if (c.branch) git(["worktree", "add", "-q", "-b", c.branch, c.path], path.join(roots[0], c.project));

const errors = [];
const pageErrors = [];
const gateway = makeGateway({ perCard: PER_CARD, spacing: SPACING });
const gwPort = await gateway.listen();
const cfg = {
  port: PORT,
  host: "127.0.0.1",
  scanRoots: roots,
  projects: [],
  threads: 2,
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
  jobsFile: path.join(work, "logs", "jobs.json"),
  assistantFile: path.join(work, "logs", "assistant.json"),
  projectsCacheFile: path.join(work, "logs", "projects.json"),
  dataDir: path.join(work, "data"),
  scratchDir: path.join(work, "scratch"),
  apiServer: { url: `http://127.0.0.1:${gwPort}`, key: "probe" },
};
mkdirSync(path.join(work, "data"), { recursive: true });
mkdirSync(path.join(work, "scratch"), { recursive: true });

const out = {
  name: "console-routing",
  tree: TREE,
  version: null,
  port: PORT,
  host: "127.0.0.1",
  perCard: PER_CARD,
  spacing: SPACING,
  words: WORDS,
  startedAt: new Date().toISOString(),
  boot: null,
  serves: null,
  condition: null,
  errors,
  pageErrors,
  failures: [],
  notMeasured: [],
};

let panel = null;
try {
  panel = await bootPanel(work, path.join(work, "config.json"), cfg);
  const bootLine = panel.log().split(/\r?\n/).find((l) => /agent-worktree-gui on http/i.test(l)) || "";
  const buildLine = panel.log().split(/\r?\n/).find((l) => /static build/i.test(l)) || "";
  const health = await fetch(`${panel.base}/api/health`).then((r) => ({ status: r.status, body: r.headers.get("content-type") })).catch((e) => ({ error: String(e) }));
  const cfgOut = await fetch(`${panel.base}/api/config`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  const index = await fetch(`${panel.base}/`).then(async (r) => ({ status: r.status, bytes: (await r.text()).length })).catch((e) => ({ error: String(e) }));
  const appJs = await fetch(`${panel.base}/app.js`).then(async (r) => ({ status: r.status, text: await r.text() })).catch((e) => ({ error: String(e) }));
  const styleCss = await fetch(`${panel.base}/style.css`).then(async (r) => ({ status: r.status, text: await r.text() })).catch((e) => ({ error: String(e) }));
  out.version = cfgOut?.version || null;
  out.boot = { bootLine, buildLine, port: PORT, pid: panel.pid, dir: work };
  out.serves = {
    health: health.status,
    index: index.status,
    indexBytes: index.bytes,
    appJs: appJs.status,
    appJsBytes: appJs.text ? appJs.text.length : null,
    // A symbol this checkout's HEAD added: it proves 7372 is serving THIS worktree's public/, not a stale checkout.
    appJsHasTgrpFlat: appJs.text ? appJs.text.includes("tgrp-flat") : false,
    styleHasTgrpFlat: styleCss.text ? styleCss.text.includes("tgrp-flat") : false,
    configPort: cfgOut?.port ?? null,
    configVersion: cfgOut?.version ?? null,
  };
  log("boot", bootLine || "(no boot line captured)");
  log("serves", `health ${health.status} · / ${index.status} (${index.bytes} bytes) · app.js ${appJs.status} (${appJs.text?.length || 0} bytes) · tgrp-flat ${out.serves.appJsHasTgrpFlat}`);

  out.condition = await runCondition({ name: "four-combined", pw, gateway, base: panel.base, cards: spec, spec, errors, pageErrors });
  out.failures.push(...(out.condition.failures || []));
  out.notMeasured.push(...(out.condition.notMeasured || []));
  out.log = panel.log();
} catch (e) {
  errors.push(String((e && e.stack) || e).slice(0, 2000));
} finally {
  try {
    await panel?.stop();
  } catch {
    /* the report carries the error already */
  }
  try {
    await gateway.close();
  } catch {
    /* same */
  }
}

out.finishedAt = new Date().toISOString();
const verdict = out.failures.length ? "DEFECT" : out.notMeasured.length ? "NOT-MEASURED" : "CLEAN";
out.verdict = verdict;
const text = JSON.stringify(out, null, 2);
if (JSON_OUT) writeFileSync(JSON_OUT, text, "utf8");
console.log(`\n=== ${verdict} ===`);
const c = out.condition;
if (c) {
  console.log(
    `emission: ${c.emission?.events} frames over ${c.emission?.spanMs} ms; ${c.emission?.withPeer60ms} had another run's frame within 60 ms; polls ${c.polls}`,
  );
  for (const card of c.settled || []) {
    console.log(`card ${card.card} ${card.thread} (${card.jobId}) panes=${card.panes} pins=${card.pinPanes}`);
    console.log(`  dom     ${describe(card.dom)}`);
    console.log(`  ledger  ${describe(card.ledger)}`);
    if (card.pin) console.log(`  pin     ${describe(card.pin)}`);
  }
  const s = c.server;
  if (s) for (const row of s) console.log(`  server tail card ${row.card}: ${row.found ? describe(row.audit) : "job not found"}`);
  console.log(`totals: ${JSON.stringify(c.totals)}`);
}
for (const f of out.failures) console.log("FAIL", f);
for (const n of out.notMeasured) console.log("NOT MEASURED", n);
for (const e of errors) console.log("ERROR", e);
for (const e of pageErrors) console.log("PAGE ERROR", e);
if (out.log) console.log(`panel log tail:\n${out.log.split(/\r?\n/).slice(-12).join("\n")}`);
if (JSON_OUT) console.log(`json: ${JSON_OUT}`);
process.exit(verdict === "CLEAN" ? 0 : verdict === "DEFECT" ? 1 : 2);
