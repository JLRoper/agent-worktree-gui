// Does a console keep moving after the reader stops scrolling? One box, no input, thirty seconds.
//
//   node tools/measure-console-drift.mjs                    # headless, panel on 7381, ~2 min
//   node tools/measure-console-drift.mjs --headed            # a real window instead of headless Chromium
//   node tools/measure-console-drift.mjs --seconds 45        # a longer quiet window (default 30)
//   node tools/measure-console-drift.mjs --no-small          # skip the near-the-bottom second window
//   node tools/measure-console-drift.mjs --json <path>       # keep the raw capture beside the printed table
//   node tools/measure-console-drift.mjs --work <dir>        # use this sandbox folder instead of a temp one
//   node tools/measure-console-drift.mjs --keep              # leave the sandbox (config, store, panel log) behind
//   node tools/measure-console-drift.mjs --port 7381         # the port is fixed at 7381; 7331 is refused
//
// WHAT THIS ANSWERS
//   The reader scrolls a console up with the wheel, lets go, and reads. Does the box stay where they left it while
//   three agents keep streaming (thinking + both console views), or does something keep moving it? The tool records,
//   for a fixed 30 s window after the wheel is released and with NO input of any kind:
//     * every scrollTop change on the box: from -> to, the distance, and the caller (app.js:line) of the write that
//       asked for it, resolved from the page's own stack at the moment of the write;
//     * every scrollHeight change: growth (lines arriving), shrink (a window trimming rows), the distance, and the
//       DOM write behind it (its op and caller) plus the nearest instrumented render call;
//     * the same two numbers for every other console on the board, which is what makes the zero meaningful: if no
//       other box is writing either, an idle window proves nothing;
//     * the box's page position (getBoundingClientRect().top), because a card above it growing moves what the reader
//       is looking at without touching either of the two numbers above;
//     * input events (wheel/pointer/key/mouse/touch), counted rather than assumed: the window is only quiet if that
//       count is 0.
//
//   Then it repeats the window with the reader parked INSIDE the panel's own 40 px forgiveness band (the box within
//   one line of the bottom), because the code that decides "follow the newest line or leave the reader alone" treats
//   those two positions differently, and only a second window can show which of the two numbers moved.
//
// WHAT IT DRIVES (nothing synthetic reaches the page)
//   * its own panel on 127.0.0.1:7381 — NEVER the reading panel on 7331: own PANEL_CONFIG, jobs/projects cache,
//     HERMES_HOME, assistant off, API_SERVER_KEY empty. The port is checked before boot and again after (the served
//     /app.js is hashed against this tree's public/app.js, so the numbers name the file they were measured on).
//   * a stub Runs API playing a fixed reply over real SSE for each run: a word pair every 90 ms, a paragraph break
//     every ~55 words, and a tool burst every ~9 s. lib/jobs.js coalesces them at 120 ms into one growing line,
//     exactly as it does for a real gateway.
//   * a `<sandbox>/hermes/state.db` that grows a reasoning row every 2 s for each parent (the thinking block) and a
//     text row every 1.8 s for each child (the second console view, read back by /api/subagents/console).
//   * the page's own clocks, untouched: the pacer (public/core/type-stream.js), the 1.2 s thinking sweep, the 400 ms
//     stick interval, `syncStreamConsole`, `paintThink`, `drawJobLine`, `paintTypedLines`, `setScroll`.
//
// THE BOARD IT MEASURES ON (three cards, five writers)
//   drift-a  condensed card: 🧠 thinking block above the console, and a running child whose console is open under it
//   drift-b  the same shape (so the target card is not the only one of its kind)
//   drift-c  the 🌊 one-stream renderer: reasoning rows inside the console instead of a block above it
//   So both console renderers are writing at once (condensed + one-stream) and two cards carry BOTH console views
//   (the card's own `pre.job-out` and its child's `pre.sub-console`). The box under test is drift-a's console.
//
// EXIT CODES
//   0  the measurement is valid and the box under test did not move in the far window (the near window's snap-back,
//      when it happens, is printed as a finding with its caller, not as a red run: it is the panel's 40 px rule)
//   1  the box under test moved with no input while the reader was parked well away from the bottom
//   2  the run did not drive what it measures (no stream, no thinking block, no console rows, no child console, a
//      page error, a panel not on 7381, or a served app.js that is not this tree's)
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
const opt = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const PORT = Number(opt("--port", "7381"));
const SECONDS = Number(opt("--seconds", "30"));
const HEADLESS = !argv.includes("--headed");
const KEEP = argv.includes("--keep");
const SMALL = !argv.includes("--no-small");
const JSON_OUT = opt("--json");
const WORK = opt("--work");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;

// The port is the one part of the setup a reader is told to trust: 7381 is this tool's own panel, 7331 is the
// reader's board and is never touched. Refuse rather than quietly land somewhere else.
if (PORT === 7331 || !(PORT > 1024 && PORT < 65536)) {
  console.log(`--port must be a free port other than the reading panel's 7331 (got ${PORT})`);
  process.exit(2);
}

// ---- the board ----------------------------------------------------------------------------------------------------
// Two condensed cards (a thinking block above the console, a child console under it) and one one-stream card, so both
// console renderers are writing while the reader scrolls. The child of each condensed card is what makes the second
// console view a live writer rather than a label.
const CARDS = [
  { thread: "drift-a", mode: "condensed", child: "drift-a-child", salt: "alpha" },
  { thread: "drift-b", mode: "condensed", child: "drift-b-child", salt: "beta" },
  { thread: "drift-c", mode: "stream", child: null, salt: "gamma" },
];
const TARGET = CARDS[0];
const TARGET_BOX = `${TARGET.thread}/console`;

const WORDS = `the console grows a line at a time while the turn is still running
a row that keeps its node keeps the selection inside it
the pacer releases words on its own clock and rewrites the row in place
keeping the newest line in view means scrolling to the bottom after every growth
a reader who has scrolled up is a reader the panel must not touch
the sweep runs on its own clock whether or not the wire is moving
the reasoning block is read from the store and drawn above the console
a rebuilt card hands the reader's position back from the height it had before
the tool burst replaces the whole group once per arriving line`.split(/\s+/).filter(Boolean);

const TOOL_ROWS = Array.from({ length: 40 }, (_, i) => `${String(i + 1).padStart(3, " ")}  ${WORDS[i % WORDS.length]} ${WORDS[(i + 3) % WORDS.length]}`).join("\n");

// A fixed script per run: same words, same cadence, same burst instants, so two runs of this tool are comparable
// without a capture diff. It never completes — a completed run rebuilds the card, and a card rebuild is a different
// question from "does the box move while it is being written to".
function scriptFor(salt, untilMs) {
  const steps = [];
  let i = 0;
  let para = 0;
  for (let t = 300; t < untilMs; t += 90) {
    const chunk = [WORDS[i % WORDS.length], WORDS[(i + 1) % WORDS.length]];
    i += 2;
    para += 2;
    // Words inside a paragraph, a break every ~55: the shape a real console receives. A line per delta would grow the
    // box a row at a time and never exercise the row that is being rewritten in place.
    const lead = para >= 55 ? "\n\n" : " ";
    if (lead === "\n\n") para = 0;
    steps.push({ at: t, evt: { event: "message.delta", delta: `${lead}${chunk.join(" ")} ${salt} ` } });
  }
  for (let t = 6000, n = 0; t < untilMs; t += 9000, n += 1) {
    steps.push({ at: t, evt: { event: "tool.started", tool: n % 2 ? "read_file" : "grep", preview: `probe/${salt}/file-${n}.js` } });
    steps.push({ at: t + 1200, evt: { event: "tool.completed", tool: n % 2 ? "read_file" : "grep", duration: 1.2, preview: TOOL_ROWS } });
  }
  return steps.sort((a, b) => a.at - b.at);
}

// ---- the stub Runs API ---------------------------------------------------------------------------------------------
function makeGateway(untilMs) {
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
      return json(200, {
        version: "console-drift-stub",
        features: { run_submission: true, run_events_sse: true, run_steer: true, run_stop: true, run_approval_response: true, run_cwd: true },
      });
    }
    if (url.pathname === "/v1/runs" && req.method === "POST") {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        state.posts += 1;
        const card = CARDS[(state.posts - 1) % CARDS.length];
        const id = `run_drift_${state.posts}`;
        state.runs.set(id, { id, status: "running", output: "", startedAt: null, script: scriptFor(card.salt, untilMs) });
        json(200, { run_id: id, status: "running" });
      });
      return;
    }
    const one = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
    if (one && req.method === "GET") {
      const rec = state.runs.get(one[1]);
      if (!rec) return json(404, { error: { message: "Run not found", code: "run_not_found" } });
      return json(200, { run_id: rec.id, status: rec.status, output: rec.output, usage: { total_tokens: 9000, input_tokens: 8100, output_tokens: 900 } });
    }
    const ev = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (ev && req.method === "GET") {
      const rec = state.runs.get(ev[1]);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      if (!rec) return res.end();
      res.write(": open\n\n");
      if (rec.startedAt == null) rec.startedAt = Date.now();
      const from = Number(req.headers["last-event-id"] ?? url.searchParams.get("last_seq") ?? -1) + 1;
      let open = true;
      req.on("close", () => {
        open = false;
      });
      rec.script.forEach((step, i) => {
        if (i < from) return;
        later(rec.startedAt + step.at - Date.now(), () => {
          if (!open) return;
          res.write(`id: ${i}\ndata: ${JSON.stringify({ ...step.evt, run_id: rec.id, seq: i, timestamp: Date.now() / 1000 })}\n\n`);
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

// ---- the store the panel reads ------------------------------------------------------------------------------------
// Every column any panel reader selects, so a read that this instrument did not think of is a real answer rather
// than a thrown query. `reasoning_content` is the thinking block; the children's `content` rows are the second
// console view.
const REASONING = [
  "The reader has stopped scrolling, so anything that moves the box now is the panel's own writer and not the wheel. The question is which writer, and the answer has to come from the page's stack at the moment of the write.",
  "Two console renderers are live on this board: the condensed card with a thinking block above its console, and the one-stream card whose reasoning rows are console rows. Both are being written while the box under test is read.",
  "A console the reader has taken over is unpinned, and the code that follows the newest line has a second, softer test: a box within about forty pixels of the bottom is treated as following whether or not it is pinned. That band is the interesting one.",
  "The console is capped at a fixed height, so its scrollHeight grows while its clientHeight does not. Growth alone moves nothing; only a write to scrollTop moves what the reader is looking at.",
  "A card rebuilt above the box moves the box down the page without touching its scrollTop or its scrollHeight. That is a third number and it belongs in the report, clearly separated from the two asked for.",
  "A child's console is written by a poll of the store, not by the run's own stream, so it is a second console on the same card that keeps growing while the parent console is being read.",
];
const CHILD_TEXT = [
  "reading the tree the parent asked about",
  "found the file the parent named and opened it",
  "the call returned more rows than expected",
  "narrowing the search to the one directory",
  "the second read agrees with the first",
  "writing the line the parent will read back",
];

function seedStore(dir, threads) {
  mkdirSync(path.join(dir, "hermes"), { recursive: true });
  const db = new DatabaseSync(path.join(dir, "hermes", "state.db"));
  db.exec(`
    create table if not exists sessions (
      id text primary key, source text not null, started_at real not null, ended_at real,
      parent_session_id text, model text, cwd text, title text, message_count integer default 0,
      tool_call_count integer default 0, last_activity_at real, model_config text,
      input_tokens integer default 0, output_tokens integer default 0, cache_read_tokens integer default 0,
      cache_write_tokens integer default 0, api_call_count integer default 0, billing_provider text,
      estimated_cost_usd real, actual_cost_usd real, cost_status text, cost_source text
    );
    create table if not exists messages (
      id integer primary key autoincrement, session_id text not null, role text not null,
      content text, timestamp real not null, reasoning text, reasoning_content text, tool_name text,
      tool_call_id text, tool_calls text, token_count integer, finish_reason text
    );
  `);
  const ins = db.prepare(
    "insert or replace into sessions (id, source, started_at, ended_at, parent_session_id, model, cwd, title, message_count, last_activity_at, model_config) values (?,?,?,?,?,?,?,?,?,?,?)",
  );
  const now = Date.now() / 1000;
  for (const c of threads) {
    ins.run(c.thread, c.mode === "stream" ? "probe-stream" : "probe", now, null, null, "probe/model", ROOT, `console drift probe · ${c.thread}`, 0, now, "{}");
    if (c.child) {
      ins.run(c.child, "subagent", now, null, c.thread, "probe/model", ROOT, `Subagent: read ${c.thread}'s tree`, 0, now, JSON.stringify({ _delegate_from: c.thread }));
    }
  }
  db.close();
}

// One writer per surface, on the store's own clock. `kind` decides which column is filled: a reasoning row grows the
// thinking block (or the one-stream console's think rows), a child row grows the child's console.
function makeWriter(dir, { kind, session, every }) {
  const st = { on: false, timer: null, n: 0 };
  const write = () => {
    if (!st.on) return;
    const n = st.n++;
    try {
      const db = new DatabaseSync(path.join(dir, "hermes", "state.db"));
      const t = Date.now() / 1000;
      if (kind === "reasoning") {
        const text = `${REASONING[n % REASONING.length]} (${n + 1})`;
        db.prepare("insert into messages (session_id, role, content, timestamp, reasoning_content) values (?,?,?,?,?)").run(session, "assistant", "…", t, text);
      } else {
        const text = `${CHILD_TEXT[n % CHILD_TEXT.length]} (${n + 1})`;
        db.prepare("insert into messages (session_id, role, content, timestamp) values (?,?,?,?)").run(session, "assistant", text, t);
        db.prepare("update sessions set message_count = message_count + 1, last_activity_at = ? where id = ?").run(t, session);
      }
      db.close();
    } catch {
      /* a locked store is a read the caller retries on its next poll */
    }
    st.timer = setTimeout(write, every);
  };
  return {
    start() {
      if (st.on) return;
      st.on = true;
      write();
    },
    stop() {
      st.on = false;
      clearTimeout(st.timer);
    },
    count: () => st.n,
  };
}

// ---- the panel on 7381 --------------------------------------------------------------------------------------------
// tools/panel-testkit.mjs picks its own port and reports the base it read; this run has to answer on 7381 and has to
// be able to say which file that port served, so the boot and the hash check live here.
async function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function startPanel(port, dir, config, env) {
  if (!(await portFree(port))) throw new Error(`port ${port} is already in use — this run needs its own panel on ${port}`);
  const cfgPath = path.join(dir, "config.json");
  const cfg = {
    port,
    host: "127.0.0.1",
    scanRoots: [path.join(dir, "empty-root")],
    threads: 1,
    worktreeSeconds: 60,
    midSeconds: 60,
    dormantSeconds: 60,
    slowSeconds: 60,
    refreshSeconds: 60,
    fetchSeconds: 60,
    projects: [],
    jobsFile: path.join(dir, "logs", "jobs.json"),
    assistantFile: path.join(dir, "logs", "assistant.json"),
    projectsCacheFile: path.join(dir, "logs", "projects.json"),
    ...config,
  };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
  const out = [];
  const child = (await import("node:child_process")).spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PANEL_CONFIG: cfgPath,
      HERMES_HOME: path.join(dir, "hermes"),
      CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
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
  child.on("exit", (code, signal) => (exited = { code, signal }));
  const base = `http://127.0.0.1:${port}`;
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
      throw new Error(`panel did not answer ${base}/api/health within 30 s:\n${out.join("")}`);
    }
    await sleep(100);
  }
  return {
    base,
    port,
    dir,
    configPath: cfgPath,
    log: () => out.join(""),
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

// ---- the page-side recorder ---------------------------------------------------------------------------------------
// Installed before app.js. It records; it never decides. Geometry is read in ONE place — the per-frame sampler — because
// a layout read inside a write wrapper can manufacture or hide the clamp being investigated.
function pageInit(opts) {
  const threads = opts.threads || [];
  try {
    localStorage.setItem("wtgui.autoCollect", "0");
    for (const c of threads) {
      localStorage.setItem(`wtgui.think.${c.thread}`, "1");
      localStorage.setItem(`wtgui.stream.${c.thread}`, c.mode === "stream" ? "1" : "0");
      localStorage.setItem(`wtgui.think.${c.child || c.thread}`, "1");
    }
  } catch {
    /* storage may be unavailable */
  }

  const T0 = performance.now();
  const now = () => Math.round((performance.now() - T0) * 10) / 10;
  const rr = (n) => Math.round(Number(n) * 100) / 100;
  const CAP = 24000;
  const R = { marks: [], writes: [], changes: [], dom: [], calls: [], inputs: [], scrollEvents: [], queries: [], errors: [], frames: 0, firstFrame: null, lastFrame: null, dropped: 0 };
  window.__p = R;
  window.addEventListener("error", (e) => R.errors.push(String((e && e.message) || e)));
  const push = (arr, rec) => {
    if (arr.length >= CAP) {
      R.dropped += 1;
      return;
    }
    arr.push(rec);
  };

  // `app.js?v=0.40.1:6597:21` -> `app.js:6597`. The version query is part of the URL and would otherwise hide the
  // line; a frame from the injected script has no .js and is dropped.
  const one = (line) => {
    const m = /([\w.@-]+\.js)(?:\?[^:\s)]*)?:(\d+):(\d+)/.exec(line);
    return m ? `${m[1].split("/").pop()}:${m[2]}` : "";
  };
  const frames = (n = 4) => {
    const lines = String(new Error().stack || "").split("\n").slice(1);
    const out = [];
    for (const l of lines) {
      const f = one(l);
      if (!f) continue;
      if (out[out.length - 1] === f) continue;
      out.push(f);
      if (out.length >= n) break;
    }
    return out;
  };

  const kindOf = (el) =>
    el.matches?.("pre.job-out") ? "console" : el.classList?.contains("think-body") ? "think" : el.classList?.contains("sub-console") ? "sub" : "";
  const labelOf = (el, kind) => {
    const card = el.closest?.(".job[data-thread]");
    const thread = card?.dataset?.thread || el.closest?.("[data-subs-turn]")?.dataset?.subsTurn || "?";
    return `${thread}/${kind}`;
  };
  const boxOf = (el) => {
    if (!el || el.nodeType !== 1) return null;
    const k = kindOf(el);
    return k ? labelOf(el, k) : null;
  };
  const boxInside = (node) => {
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    if (!el) return null;
    const own = boxOf(el);
    if (own) return own;
    const host = el.closest?.("pre.job-out, .think-body, .sub-console");
    return host ? boxOf(host) : null;
  };

  // -- every write to a box's scrollTop, and what asked for it. No geometry read here on purpose: reading
  // scrollHeight inside the setter forces the layout the write was about to land on.
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  if (desc && desc.set) {
    Object.defineProperty(Element.prototype, "scrollTop", {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set(v) {
        const box = boxOf(this);
        if (box) push(R.writes, { t: now(), box, asked: Math.round(Number(v) || 0), st: frames(5).join(" <- ") });
        return desc.set.call(this, v);
      },
    });
  }
  // The paths that move a box without touching scrollTop: scrollIntoView on a row inside it, or scrollTo/scrollBy.
  for (const name of ["scrollIntoView", "scrollTo", "scrollBy"]) {
    const orig = Element.prototype[name];
    if (typeof orig !== "function") continue;
    Element.prototype[name] = function () {
      const box = boxOf(this) || boxInside(this);
      if (box) push(R.writes, { t: now(), box, asked: name === "scrollIntoView" ? -1 : Math.round(Number(arguments[1] ?? arguments[0] ?? 0) || 0), st: `${name} ${frames(5).join(" <- ")}` });
      return orig.apply(this, arguments);
    };
  }

  // -- the DOM writes behind a scrollHeight change: an appended tail (the reveal), a rewritten row (the pacer or the
  // poll), a row added (drawJobLine), a row removed (a window trim).
  const note = (box, op) => {
    if (box) push(R.dom, { t: now(), box, op, st: frames(6).join(" <- ") });
  };
  const innerDesc = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
  if (innerDesc && innerDesc.set) {
    Object.defineProperty(Element.prototype, "innerHTML", {
      configurable: true,
      enumerable: innerDesc.enumerable,
      get: innerDesc.get,
      set(v) {
        const box = boxOf(this) || boxInside(this);
        if (box) note(box, "innerHTML");
        return innerDesc.set.call(this, v);
      },
    });
  }
  const appendData = CharacterData.prototype.appendData;
  if (typeof appendData === "function") {
    CharacterData.prototype.appendData = function () {
      const box = boxInside(this);
      if (box) note(box, "appendData");
      return appendData.apply(this, arguments);
    };
  }
  for (const [proto, name] of [
    [Node.prototype, "appendChild"],
    [Node.prototype, "insertBefore"],
    [Element.prototype, "append"],
    [Element.prototype, "replaceChildren"],
    [Element.prototype, "replaceWith"],
    [Element.prototype, "remove"],
  ]) {
    const orig = proto[name];
    if (typeof orig !== "function") continue;
    proto[name] = function () {
      const box = name === "remove" ? boxInside(this) : boxInside(this) || boxInside(arguments[0]);
      if (box) note(box, name);
      return orig.apply(this, arguments);
    };
  }

  // -- the page's own render entry points, so a change can be named by the function that was running as well as by
  // the DOM primitive. Element arguments are labelled; arguments that are ids or lids are left alone (no geometry).
  window.__instrument = () => {
    const out = [];
    const names = ["paintTypedLines", "drawJobLine", "paintThink", "paintStreamConsole", "syncStreamConsole", "renderConversation", "paintSubagents", "loadSubConsole", "stickConsole", "stickThinkBody", "stickSubConsole", "restoreScrolls", "applyStoredScrolls", "settleScrolls", "placeRow", "applySnapshot", "renderJobs", "scrollThreadToBottom", "setScroll"];
    for (const name of names) {
      const orig = window[name];
      if (typeof orig !== "function" || orig.__i) continue;
      const w = function () {
        if (R.calls.length < CAP) {
          const a0 = arguments[0];
          const box = a0 && a0.nodeType === 1 ? boxOf(a0) || boxInside(a0) : null;
          push(R.calls, { t: now(), name, box: box || "", st: frames(4).join(" <- ") });
        }
        return orig.apply(this, arguments);
      };
      w.__i = true;
      window[name] = w;
      out.push(name);
    }
    return out;
  };

  // -- input, counted. A window with a wheel or a key in it is not a quiet window, and the count is what says so.
  for (const ev of ["wheel", "keydown", "pointerdown", "mousedown", "touchstart"]) {
    window.addEventListener(
      ev,
      (e) => {
        const box = e.target && e.target.closest ? boxOf(e.target.closest("pre.job-out, .think-body, .sub-console")) : null;
        push(R.inputs, { t: now(), ev, box: box || "", dy: ev === "wheel" ? Math.round(Number(e.deltaY) || 0) : 0 });
      },
      { capture: true, passive: true },
    );
  }
  document.addEventListener(
    "scroll",
    (e) => {
      const el = e.target;
      const box = el && el.nodeType === 1 ? boxOf(el) : null;
      if (!box) return;
      if (R.scrollEvents.length < CAP) R.scrollEvents.push({ t: now(), box, trusted: e.isTrusted ? 1 : 0 });
    },
    true,
  );

  // -- the one place geometry is read: once per frame, for every box on the board.
  const prev = new Map();
  // The pin is the panel's own answer to "does this box follow its newest line", and it is what every writer below
  // consults. Sampled per frame so a flip can be placed against the input that caused it.
  const pins = new Map();
  const frameFn = () => {
    const t = now();
    if (R.firstFrame == null) R.firstFrame = t;
    R.lastFrame = t;
    R.frames += 1;
    for (const el of document.querySelectorAll("pre.job-out, .think-body, .sub-console")) {
      const box = boxOf(el);
      if (!box) continue;
      const top = el.scrollTop;
      const sh = el.scrollHeight;
      const ch = el.clientHeight;
      const rectTop = el.getBoundingClientRect().top;
      const p = prev.get(box);
      if (!p) {
        prev.set(box, { top, sh, ch, rectTop });
        push(R.changes, { t, box, f: "first", from: 0, to: Math.round(top), d: Math.round(top), sh: Math.round(sh), ch: Math.round(ch), rectTop: rr(rectTop) });
        continue;
      }
      if (p.top !== top) {
        const w = R.writes.filter((x) => x.box === box && x.t <= t && t - x.t <= 120).slice(-1)[0] || null;
        push(R.changes, { t, box, f: "top", from: Math.round(p.top), to: Math.round(top), d: Math.round(top - p.top), sh: Math.round(sh), ch: Math.round(ch), rectTop: rr(rectTop), dt: w ? Math.round((t - w.t) * 10) / 10 : null, w: w ? w.st : "no page write (layout/clamp)" });
      }
      if (p.sh !== sh) {
        const w = R.dom.filter((x) => x.box === box && x.t <= t && t - x.t <= 150).slice(-1)[0] || null;
        push(R.changes, { t, box, f: "sh", from: Math.round(p.sh), to: Math.round(sh), d: Math.round(sh - p.sh), top: Math.round(top), ch: Math.round(ch), rectTop: rr(rectTop), dt: w ? Math.round((t - w.t) * 10) / 10 : null, w: w ? `${w.op} ${w.st}` : "no page write" });
      }
      if (Math.abs(rectTop - p.rectTop) >= 1) {
        push(R.changes, { t, box, f: "rect", from: rr(p.rectTop), to: rr(rectTop), d: rr(rectTop - p.rectTop), top: Math.round(top), sh: Math.round(sh), ch: Math.round(ch) });
      }
      if (el.matches("pre.job-out") && el.dataset.out) {
        let pin = null;
        try {
          pin = state.outPinned[el.dataset.out] !== false;
        } catch {
          /* state is not up yet */
        }
        if (pin != null) {
          const was = pins.get(box);
          if (was != null && was !== pin) push(R.changes, { t, box, f: "pin", from: was ? 1 : 0, to: pin ? 1 : 0, d: pin ? 1 : -1, gap: Math.round(sh - top - ch), top: Math.round(top), w: "" });
          pins.set(box, pin);
        }
      }
      p.top = top;
      p.sh = sh;
      p.ch = ch;
      p.rectTop = rectTop;
    }
    requestAnimationFrame(frameFn);
  };
  requestAnimationFrame(frameFn);

  window.__probe = {
    now,
    mark(name) {
      const m = { name, t: now() };
      R.marks.push(m);
      return m.t;
    },
    boxState(thread, kind) {
      const card = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"]`);
      const el = card ? card.querySelector(kind === "think" ? ".think-body" : kind === "sub" ? "pre.sub-console" : "pre.job-out") : null;
      if (!el) return null;
      return {
        box: `${thread}/${kind}`,
        top: Math.round(el.scrollTop),
        sh: Math.round(el.scrollHeight),
        ch: Math.round(el.clientHeight),
        gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
        out: el.dataset.out || "",
        pinned: kind === "console" ? state.outPinned[el.dataset.out] !== false : null,
      };
    },
    overview() {
      return {
        boxes: [...document.querySelectorAll("pre.job-out, .think-body, .sub-console")].map((el) => {
          const k = kindOf(el);
          if (!k) return null;
          return { box: labelOf(el, k), out: el.dataset.out || el.dataset.subConsoleBox || "", rows: el.children.length, top: Math.round(el.scrollTop), sh: Math.round(el.scrollHeight), ch: Math.round(el.clientHeight), text: el.textContent.length };
        }).filter(Boolean),
        cards: [...document.querySelectorAll(".job[data-thread]")].map((c) => ({ thread: c.dataset.thread, think: Boolean(c.querySelector("details.think")), blocks: c.querySelectorAll(".think-block:not(.think-empty)").length, consoles: c.querySelectorAll("pre.job-out").length, subs: c.querySelectorAll("pre.sub-console").length })),
      };
    },
    dump() {
      return R;
    },
  };
}

// ---- playwright ---------------------------------------------------------------------------------------------------
function loadPlaywright() {
  for (const root of [process.env.PANEL_PLAYWRIGHT_ROOT, process.env.PLAYWRIGHT_ROOT, ROOT, process.cwd(), "C:/Users/roper/AppData/Roaming/npm/node_modules"].filter(Boolean)) {
    for (const p of [path.join(root, "node_modules", "playwright"), path.join(root, "playwright"), root]) {
      try {
        return require(p);
      } catch {
        /* not there */
      }
    }
  }
  try {
    return require("playwright");
  } catch {
    return null;
  }
}

function git(args, cwd = ROOT) {
  return execFileSync("git", ["-c", "user.name=probe", "-c", "user.email=probe@localhost", ...args], { cwd, stdio: "pipe", encoding: "utf8" }).trim();
}

// Poll the page for a condition, printing what it saw on the way out so a timeout says which half was missing.
async function until(page, fn, arg, { timeout = 40_000, what = "condition", step = 250 } = {}) {
  const end = Date.now() + timeout;
  let last = null;
  for (;;) {
    last = await page.evaluate(fn, arg).catch(() => null);
    if (last) return last;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}; last read: ${JSON.stringify(last)}`);
    await sleep(step);
  }
}

// ---- the measurement ----------------------------------------------------------------------------------------------
const pw = loadPlaywright();
if (!pw) {
  console.log("SKIP  playwright is not installed here (set PLAYWRIGHT_ROOT to a node_modules directory that has it)");
  process.exit(0);
}

const work = WORK ? path.resolve(WORK) : mkdtempSync(path.join(os.tmpdir(), "wtgui-drift-"));
mkdirSync(work, { recursive: true });
mkdirSync(path.join(work, "empty-root"), { recursive: true });
const repo = path.join(work, "repo");
mkdirSync(repo, { recursive: true });
if (!existsSync(path.join(repo, ".git"))) {
  git(["init", "-q", "-b", "main"], repo);
  writeFileSync(path.join(repo, "README.md"), "# console drift probe\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "first"], repo);
}
seedStore(work, CARDS);

const HEAD_SHA = git(["rev-parse", "HEAD"]);
const appOnDisk = readFileSync(path.join(ROOT, "public", "app.js"));
const appSha = createHash("sha256").update(appOnDisk).digest("hex");

const gw = makeGateway(260_000);
const gwPort = await gw.listen();
const panel = await startPanel(PORT, work, {
  scanRoots: [path.join(work, "empty-root")],
  refreshSeconds: 3600,
  worktreeSeconds: 3600,
  midSeconds: 3600,
  dormantSeconds: 3600,
  slowSeconds: 3600,
  fetchSeconds: -1,
  assistant: { enabled: false },
  remoteBranchPolicy: "local-only",
  defaultCwd: repo,
  apiServer: { url: `http://127.0.0.1:${gwPort}`, key: "probe" },
});

const writers = [];
const errors = [];
let ctx = null;
let capture = null;
let exit = 0;
try {
  // The port is the promise; the file behind it is the evidence.
  const rootRes = await fetch(`${panel.base}/`);
  const rootHtml = await rootRes.text();
  const served = await fetch(`${panel.base}/app.js`).then((r) => r.text());
  const servedSha = createHash("sha256").update(served).digest("hex");
  const health = await fetch(`${panel.base}/api/health`).then((r) => r.json()).catch(() => null);
  const servedStatus = { root: rootRes.status, bytesRoot: rootHtml.length, bytesApp: served.length, title: (/<title>([^<]*)<\/title>/i.exec(rootHtml) || [])[1] || "" };
  console.log(`\n-- panel: ${panel.base} (port ${PORT}, never 7331)`);
  console.log(`   GET / -> ${rootRes.status} (${rootHtml.length} bytes, title "${servedStatus.title}")   GET /app.js -> 200 (${served.length} bytes)`);
  console.log(`   app.js served: sha256 ${servedSha.slice(0, 16)}…  on disk: ${appSha.slice(0, 16)}…  match: ${servedSha === appSha}`);
  console.log(`   git HEAD: ${HEAD_SHA.slice(0, 12)}  health: ${JSON.stringify(health)}`);
  if (servedSha !== appSha) throw new Error(`the panel on ${PORT} is serving a different public/app.js (${servedSha.slice(0, 12)} vs ${appSha.slice(0, 12)}) — the numbers would not name this tree`);

  const profile = path.join(work, "profile");
  mkdirSync(profile, { recursive: true });
  ctx = await pw.chromium.launchPersistentContext(profile, { headless: HEADLESS, viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String((e && e.message) || e)));
  await page.addInitScript(pageInit, { threads: CARDS });
  await page.goto(panel.base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof state !== "undefined" && state.jobs, null, { timeout: 30_000 });
  const instrumented = await page.evaluate(() => window.__instrument());

  // Three runs, one at a time so a card's order on the board is the order they were started in.
  const spawned = [];
  for (const c of CARDS) {
    const r = await fetch(`${panel.base}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: `probe: stream a fixed reply for ${c.thread}`, cwd: repo, existing: true, thread: c.thread }),
    }).then((x) => x.json());
    if (!r || !r.job) throw new Error(`spawn failed for ${c.thread}: ${JSON.stringify(r)}`);
    spawned.push({ thread: c.thread, job: r.job.id });
  }
  for (const c of CARDS) {
    const reasoning = makeWriter(work, { kind: "reasoning", session: c.thread, every: 2000 });
    reasoning.start();
    writers.push(reasoning);
    if (c.child) {
      const child = makeWriter(work, { kind: "child", session: c.child, every: 1800 });
      child.start();
      writers.push(child);
    }
  }
  await page.waitForSelector(`.job[data-thread="${TARGET.thread}"] pre.job-out`, { timeout: 30_000 });
  for (const c of CARDS) await page.waitForSelector(`.job[data-thread="${c.thread}"] pre.job-out`, { timeout: 30_000 });

  // Open each child's console the way the reader does, once the roster has the child.
  const opened = await until(
    page,
    (children) => {
      const got = [];
      for (const id of children) {
        if (!state.openSubConsole.has(id)) {
          if (typeof toggleSubConsole === "function") void toggleSubConsole(id);
        }
        got.push((state.subConsoles.get(id)?.lines || []).length);
      }
      return got.every((n) => n > 2) ? got : null;
    },
    CARDS.filter((c) => c.child).map((c) => c.child),
    { timeout: 60_000, what: "both child consoles to open with rows", step: 700 },
  );

  // Warm: the target console is overflowing, a thinking block has drawn blocks, the child consoles have lines.
  const warm = await until(
    page,
    (t) => {
      const card = document.querySelector(`.job[data-thread="${CSS.escape(t.thread)}"]`);
      const out = card?.querySelector("pre.job-out");
      const blocks = card?.querySelectorAll(".think-block:not(.think-empty)") || [];
      const ownSub = card?.querySelector("pre.sub-console");
      const anySub = document.querySelector("pre.sub-console");
      const overflow = out ? out.scrollHeight - out.clientHeight : 0;
      if (!out || overflow < 240 || blocks.length < 2 || !ownSub || !anySub) return null;
      if (ownSub.children.length < 3 || anySub.children.length < 3) return null;
      return { overflow, blocks: blocks.length, subRows: ownSub.children.length, rows: out.children.length, gap: Math.round(out.scrollHeight - out.scrollTop - out.clientHeight) };
    },
    { thread: TARGET.thread },
    { timeout: 60_000, what: "the card to be warm (overflowing console, 2+ thinking blocks, a child console with rows)", step: 500 },
  );

  // The bottom of the box, measured rather than assumed: the console's content is thousands of pixels tall and one
  // wheel notch is ~140, so "scroll down a bit" is not a way to reach it.
  const toBottom = async () => {
    for (let i = 0; i < 16; i += 1) {
      const gap = await page.evaluate((thread) => {
        const el = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"] pre.job-out`);
        return el ? Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) : null;
      }, TARGET.thread);
      if (gap != null && gap <= 8) return gap;
      await page.mouse.wheel(0, 1600);
      await sleep(90);
    }
    return page.evaluate((thread) => {
      const el = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"] pre.job-out`);
      return el ? Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) : null;
    }, TARGET.thread);
  };

  // Put the box in the viewport BEFORE the wheel (a page scroll, not an input event), then aim inside one stretch.
  const aim = async () => {
    await page.evaluate((thread) => {
      const el = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"] pre.job-out`);
      if (el) el.scrollIntoView({ block: "center" });
    }, TARGET.thread);
    await sleep(500);
    return page.evaluate((thread) => {
      const el = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"] pre.job-out`);
      const r = el.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2);
      // Below the middle: the "to the newest line" chip is centred in the wrapper and would take the hit.
      const y = Math.round(r.top + r.height * 0.8);
      const hit = document.elementFromPoint(x, y);
      return { x, y, hit: hit ? `${hit.tagName.toLowerCase()}.${hit.className}` : "none", inBox: Boolean(hit && hit.closest("pre.job-out") === el), top: Math.round(el.scrollTop), gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight), view: { top: Math.round(r.top), h: Math.round(r.height) } };
    }, TARGET.thread);
  };
  const wheel = async (dy, times = 1, gapMs = 90) => {
    for (let i = 0; i < times; i += 1) {
      await page.mouse.wheel(0, dy);
      await sleep(gapMs);
    }
  };
  // The wheel's own tail: Chromium animates a wheel scroll, so "released" means the box's scrollTop stopped moving
  // on its own. scrollHeight is not part of this: it grows every 90 ms by design and would never settle.
  const settle = async () => {
    let last = null;
    let stable = 0;
    for (let i = 0; i < 25; i += 1) {
      const s = await page.evaluate((thread) => {
        const el = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"] pre.job-out`);
        return el ? { top: Math.round(el.scrollTop), gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) } : null;
      }, TARGET.thread);
      if (last && s && s.top === last.top) stable += 1;
      else stable = 0;
      if (stable >= 2) return { ...s, settledAfter: i * 120 };
      last = s;
      await sleep(120);
    }
    return { ...(last || {}), settledAfter: "did not stop" };
  };

  // ---- window 1: far up the box, the reader reading history
  const w1 = { name: "far", seconds: SECONDS };
  await page.evaluate(() => window.__probe.mark("warm"));
  const start1 = await page.evaluate((thread) => window.__probe.boxState(thread, "console"), TARGET.thread);
  await page.mouse.move(0, 0);
  await sleep(300);
  const aim1 = await aim();
  if (!aim1.inBox) throw new Error(`the wheel would not land on the console: elementFromPoint is ${aim1.hit}`);
  const beforeScroll = await page.evaluate((thread) => window.__probe.mark(`wheel-start:${thread}`), TARGET.thread);
  await page.mouse.move(aim1.x, aim1.y);
  await wheel(-140, 6, 80);
  const settled1 = await settle();
  const rel1 = await page.evaluate((thread) => {
    const t = window.__probe.mark("release:far");
    return { t, box: window.__probe.boxState(thread, "console") };
  }, TARGET.thread);
  await sleep(Math.round(SECONDS * 1000));
  const end1 = await page.evaluate((thread) => ({ t: window.__probe.mark("end:far"), box: window.__probe.boxState(thread, "console") }), TARGET.thread);
  w1.aim = aim1;
  w1.settled = settled1;
  w1.release = rel1;
  w1.end = end1;
  w1.before = start1;
  w1.wheelAt = beforeScroll;

  // ---- window 2: the reader parked inside the panel's own ~40 px forgiveness band
  let w2 = null;
  if (SMALL) {
    await page.evaluate((thread) => {
      const el = document.querySelector(`.job[data-thread="${CSS.escape(thread)}"] pre.job-out`);
      if (el) el.scrollIntoView({ block: "center" });
    }, TARGET.thread);
    await sleep(400);
    const aim2 = await aim();
    if (!aim2.inBox) throw new Error(`the wheel would not land on the console for the near window: elementFromPoint is ${aim2.hit}`);
    await page.mouse.move(aim2.x, aim2.y);
    const gapAtBottom = await toBottom(); // a wheel down re-pins, which is the reader's own "back to now"
    const upAt = await page.evaluate(() => window.__probe.mark("wheel-up:near"));
    await page.mouse.wheel(0, -24); // then up by about one line: inside the 40 px band, and unpinned
    // One frame, so the wheel's own delta is already painted and the window starts from where the reader left the
    // box. Waiting for the box to STOP would wait past the very movement this window exists to catch: the panel's
    // re-stick can land inside a single 40 ms pacer tick.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    const rel2 = await page.evaluate((thread) => ({ t: window.__probe.mark("release:near"), box: window.__probe.boxState(thread, "console") }), TARGET.thread);
    await sleep(Math.round(SECONDS * 1000));
    const end2 = await page.evaluate((thread) => ({ t: window.__probe.mark("end:near"), box: window.__probe.boxState(thread, "console") }), TARGET.thread);
    w2 = { name: "near", seconds: SECONDS, aim: aim2, wheelUpAt: upAt, gapAtBottom, release: rel2, end: end2 };
  }

  // The burst the stub keeps sending is enough to keep every console writing through both windows; nothing is
  // changed on the page for the dump.
  capture = await page.evaluate(() => window.__probe.dump());
  capture.overview = await page.evaluate(() => window.__probe.overview());
  capture.windows = { far: w1, near: w2 };
  capture.warm = warm;
  capture.opened = opened;
  capture.instrumented = instrumented;
  capture.errors = errors;
  capture.panel = { base: panel.base, port: PORT, servedSha, appSha, head: HEAD_SHA, health, servedStatus };
} finally {
  for (const w of writers) w?.stop?.();
  await ctx?.close().catch(() => {});
  await gw.close().catch(() => {});
  await panel.stop().catch(() => {});
}

// ---- reading the capture -------------------------------------------------------------------------------------------
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const firstLineOf = (st) => String(st || "").split(" <- ")[0] || "";

function windowOf(name) {
  const w = name === "far" ? capture.windows.far : capture.windows.near;
  if (!w) return null;
  return { from: w.release.t, to: w.end.t, secs: (w.end.t - w.release.t) / 1000, meta: w };
}

function analyse(name, box) {
  const win = windowOf(name);
  if (!win) return null;
  const changes = capture.changes.filter((c) => c.box === box && c.t >= win.from && c.t <= win.to);
  const writes = capture.writes.filter((c) => c.box === box && c.t >= win.from && c.t <= win.to);
  const inputs = capture.inputs.filter((c) => c.t >= win.from && c.t <= win.to);
  const scrollEvents = capture.scrollEvents.filter((c) => c.box === box && c.t >= win.from && c.t <= win.to);
  const tops = changes.filter((c) => c.f === "top");
  const shs = changes.filter((c) => c.f === "sh");
  const rects = changes.filter((c) => c.f === "rect");
  const pinChanges = changes.filter((c) => c.f === "pin");
  const writers = new Map();
  for (const c of shs) {
    const key = firstLineOf(c.w) || "no page write";
    const rec = writers.get(key) || { key, n: 0, px: 0, sample: c.w };
    rec.n += 1;
    rec.px += Math.abs(c.d || 0);
    writers.set(key, rec);
  }
  const topWriters = new Map();
  for (const c of tops) {
    const key = firstLineOf(c.w) || "no page write";
    const rec = topWriters.get(key) || { key, n: 0, px: 0, sample: c.w };
    rec.n += 1;
    rec.px += Math.abs(c.d || 0);
    topWriters.set(key, rec);
  }
  return {
    window: name,
    seconds: r1(win.secs),
    frames: capture.frames,
    fps: r1((capture.lastFrame - capture.firstFrame) / 1000),
    release: win.meta.release.box,
    end: win.meta.end.box,
    settled: win.meta.settled || null,
    before: win.meta.before || null,
    gapAtBottom: win.meta.gapAtBottom ?? null,
    aim: win.meta.aim,
    topChanges: tops.length,
    topNet: Math.round(sum(tops.map((c) => c.d))),
    topAbs: Math.round(sum(tops.map((c) => Math.abs(c.d)))),
    topMax: tops.length ? Math.max(...tops.map((c) => Math.abs(c.d))) : 0,
    topEvents: tops.map((c) => ({ t: r1(c.t - win.from), d: c.d, from: c.from, to: c.to, w: c.w, dt: c.dt })),
    shChanges: shs.length,
    shNet: Math.round(sum(shs.map((c) => c.d))),
    shAbs: Math.round(sum(shs.map((c) => Math.abs(c.d)))),
    shMin: shs.length ? Math.min(...shs.map((c) => c.d)) : 0,
    shMax: shs.length ? Math.max(...shs.map((c) => c.d)) : 0,
    shWriters: [...writers.values()].sort((a, b) => b.n - a.n),
    shEvents: shs.map((c) => ({ t: r1(c.t - win.from), d: c.d, from: c.from, to: c.to, w: c.w, dt: c.dt })),
    topWriters: [...topWriters.values()].sort((a, b) => b.n - a.n),
    writes: writes.length,
    inputs: inputs.length,
    inputKinds: [...new Set(inputs.map((i) => i.ev))],
    scrollEvents: scrollEvents.length,
    scrollTrusted: scrollEvents.filter((s) => s.trusted).length,
    pinChanges: pinChanges.length,
    pinEvents: pinChanges.map((c) => ({ t: r1(c.t - win.from), to: c.to, gap: c.gap })),
    rectChanges: rects.length,
    rectAbs: Math.round(sum(rects.map((c) => Math.abs(c.d)))),
    rectMax: rects.length ? Math.max(...rects.map((c) => Math.abs(c.d))) : 0,
    rectNet: Math.round(sum(rects.map((c) => c.d))),
    gapRelease: win.meta.release.box ? win.meta.release.box.gap : null,
    gapEnd: win.meta.end.box ? win.meta.end.box.gap : null,
    shRelease: win.meta.release.box ? win.meta.release.box.sh : null,
    chRelease: win.meta.release.box ? win.meta.release.box.ch : null,
    shEnd: win.meta.end.box ? win.meta.end.box.sh : null,
    topRelease: win.meta.release.box ? win.meta.release.box.top : null,
    topEnd: win.meta.end.box ? win.meta.end.box.top : null,
    pinnedRelease: win.meta.release.box ? win.meta.release.box.pinned : null,
    pinnedEnd: win.meta.end.box ? win.meta.end.box.pinned : null,
  };
}

// Every other box on the board, in the same window: the control that says the board was busy, not idle.
function others(name) {
  const win = windowOf(name);
  if (!win) return [];
  const byBox = new Map();
  for (const c of capture.changes.filter((x) => x.t >= win.from && x.t <= win.to && x.f !== "first")) {
    const rec = byBox.get(c.box) || { box: c.box, top: 0, sh: 0, rect: 0, writer: "" };
    if (c.f === "top") rec.top += 1;
    if (c.f === "sh") {
      rec.sh += 1;
      if (!rec.writer) rec.writer = firstLineOf(c.w);
    }
    if (c.f === "rect") rec.rect += 1;
    byBox.set(c.box, rec);
  }
  return [...byBox.values()].sort((a, b) => b.sh - a.sh);
}

function printWindow(a) {
  console.log(`\n== window "${a.window}": ${a.seconds}s after the wheel was released (box ${TARGET_BOX})`);
  console.log(`   release: top ${a.topRelease}, content ${a.shRelease} px in a ${a.chRelease} px box, gap ${a.gapRelease} px, pinned=${a.pinnedRelease}`);
  console.log(`   end    : top ${a.topEnd}, content ${a.shEnd} px, gap ${a.gapEnd} px, pinned=${a.pinnedEnd}`);
  console.log(`   before the wheel: ${JSON.stringify(a.before)}`);
  console.log(`   settle: ${JSON.stringify(a.settled)}   frames ${a.frames} (~${a.fps} fps)   input events ${a.inputs}${a.inputs ? ` (${a.inputKinds.join(",")})` : ""}   scroll events ${a.scrollEvents} (trusted ${a.scrollTrusted})`);
  console.log(`   scrollTop : ${a.topChanges} changes, net ${a.topNet >= 0 ? "+" : ""}${a.topNet} px, total ${a.topAbs} px, largest ${a.topMax} px, ${a.writes} writes`);
  for (const w of a.topWriters) console.log(`      ${String(w.n).padStart(3)} x  ${w.px >= 0 ? "+" : ""}${w.px} px  ${w.key}   [${w.sample}]`);
  console.log(`   scrollHeight: ${a.shChanges} changes, net ${a.shNet >= 0 ? "+" : ""}${a.shNet} px (min ${a.shMin}, max ${a.shMax}), by writer:`);
  for (const w of a.shWriters) console.log(`      ${String(w.n).padStart(3)} x  ${w.px} px  ${w.key}   [${w.sample}]`);
  console.log(`   page position: ${a.rectChanges} changes, net ${a.rectNet >= 0 ? "+" : ""}${a.rectNet} px, largest ${a.rectMax} px (not scrollTop)`);
  if (a.pinEvents.length) {
    console.log(`   pin flips: ${a.pinEvents.map((p) => `+${p.t}ms -> ${p.to ? "pinned" : "unpinned"} (gap ${p.gap})`).join(", ")}`);
  }
  if (a.topEvents.length) {
    console.log(`   every scrollTop change:`);
    for (const e of a.topEvents) console.log(`      +${String(e.t).padStart(7)}ms  ${e.d >= 0 ? "+" : ""}${e.d} px  ${e.from} -> ${e.to}   ${e.w}${e.dt != null ? ` (write ${e.dt} ms earlier)` : ""}`);
  }
  if (a.shEvents.length) {
    const cuts = a.shEvents.slice(0, 6);
    console.log(`   first scrollHeight changes:`);
    for (const e of cuts) console.log(`      +${String(e.t).padStart(7)}ms  ${e.d >= 0 ? "+" : ""}${e.d} px  ${e.from} -> ${e.to}   ${e.w}${e.dt != null ? ` (${e.dt} ms after the write)` : ""}`);
  }
  for (const o of others(a.window)) {
    if (o.box === TARGET_BOX) continue;
    console.log(`   other: ${o.box.padEnd(22)} scrollTop changes ${String(o.top).padStart(4)}  scrollHeight changes ${String(o.sh).padStart(4)}  page moves ${o.rect}`);
  }
}

const far = analyse("far", TARGET_BOX);
const near = capture.windows.near ? analyse("near", TARGET_BOX) : null;

console.log(`\n== the board`);
console.log(`   cards: ${capture.overview.cards.map((c) => `${c.thread}[think=${c.think ? c.blocks : "no"} consoles=${c.consoles} subconsoles=${c.subs}]`).join("  ")}`);
console.log(`   boxes: ${capture.overview.boxes.map((b) => `${b.box}(${b.rows} rows, ${b.sh}/${b.ch}px, ${b.text} chars)`).join("  ")}`);
console.log(`   warm gate: ${JSON.stringify(capture.warm)}`);
console.log(`   instrumented: ${capture.instrumented.join(", ")}`);

printWindow(far);
if (near) printWindow(near);

// ---- the verdict --------------------------------------------------------------------------------------------------
const checks = [];
const add = (name, got, want, ok) => checks.push({ name, got, want, ok });

const driven =
  capture.overview.cards.length >= 2 &&
  capture.overview.cards.filter((c) => c.think && c.blocks > 0).length >= 2 &&
  capture.overview.cards.filter((c) => c.think && c.blocks > 0 && c.subs > 0).length >= 2 &&
  capture.overview.cards.some((c) => c.consoles > 0) &&
  capture.overview.boxes.filter((b) => b.box.endsWith("/console")).length >= 3 &&
  far.gapRelease > 40;
add(
  "the board was driven",
  { cards: capture.overview.cards.length, blocks: capture.overview.cards.filter((c) => c.think && c.blocks > 0).length, dualConsoleCards: capture.overview.cards.filter((c) => c.think && c.blocks > 0 && c.subs > 0).length, consoles: capture.overview.boxes.filter((b) => b.box.endsWith("/console")).length, gapAtRelease: far.gapRelease },
  "2+ cards with a thinking block, 2+ of them with both console views, 3 consoles writing, the box >40 px from its bottom",
  driven,
);
add("no input reached the page during the far window", far.inputs, 0, far.inputs === 0);
add("the panel answered on 7381", `${capture.panel.base}`, `http://127.0.0.1:${PORT}`, capture.panel.base === `http://127.0.0.1:${PORT}` && PORT !== 7331);
add("the port served this tree's app.js", `${capture.panel.servedSha.slice(0, 12)} vs ${capture.panel.appSha.slice(0, 12)}`, "identical", capture.panel.servedSha === capture.panel.appSha);
if (near) add("no input reached the page during the near window", near.inputs, 0, near.inputs === 0);
if (near) add("the near window really parked the box inside the ~40 px band", { gapAtRelease: near.gapRelease }, "0 < gap <= 45 px", near.gapRelease > 0 && near.gapRelease <= 45);
add("the board kept writing while the reader read", far.shChanges + (near ? near.shChanges : 0), "> 0", far.shChanges + (near ? near.shChanges : 0) > 0);
const pageErr = capture.errors.length;
add("no page errors", pageErr, 0, pageErr === 0);
const farDrift = far.topChanges;
add("the far box did not move with no input", `${far.topChanges} changes, ${far.topAbs} px`, "0 changes", farDrift === 0);

for (const c of checks) {
  if (c.ok) console.log(`PASS  ${c.name}: ${typeof c.got === "string" ? c.got : JSON.stringify(c.got)}`);
  else console.log(`FAIL  ${c.name}\n        got  ${typeof c.got === "string" ? c.got : JSON.stringify(c.got)}\n        want ${c.want}`);
}
const nearSnap = near ? near.topAbs : 0;
console.log(
  `\n== verdict: the box ${farDrift ? `MOVED ${far.topAbs} px over ${far.topChanges} change(s) with no input while parked ${far.gapRelease} px up` : `held still (0 px of scrollTop movement) for ${far.seconds}s while parked ${far.gapRelease} px up, and its content grew ${far.shNet} px`}` +
    `${near ? `; parked ${near.gapRelease} px from the bottom it moved ${nearSnap} px` : ""}`,
);
if (!driven || pageErr) exit = 2;
else if (farDrift) exit = 1;

if (JSON_OUT) {
  mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), tool: "tools/measure-console-drift.mjs", sha: HEAD_SHA, appSha, port: PORT, seconds: SECONDS, far, near, others: { far: others("far"), near: capture.windows.near ? others("near") : [] }, checks, panel: capture.panel, warm: capture.warm, overview: capture.overview, windows: capture.windows, counts: { writes: capture.writes.length, dom: capture.dom.length, changes: capture.changes.length, calls: capture.calls.length, inputs: capture.inputs.length, scrollEvents: capture.scrollEvents.length, frames: capture.frames, dropped: capture.dropped }, capture }, null, 1));
  console.log(`   capture: ${JSON_OUT}`);
}
if (!KEEP && !JSON_OUT && !WORK) rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
else console.log(`   sandbox: ${work}`);
process.exitCode = exit;
