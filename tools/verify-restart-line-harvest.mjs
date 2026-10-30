// A RESTART line written under a paragraph that quotes it is DROPPED, and this proves it on a sandbox panel.
//
//   node tools/verify-restart-line-harvest.mjs
//
// THE INCIDENT. On 2026-10-26 two assistant turns each ended with a bare `RESTART panel` line. Both turns'
// other action lines were carried out (their NOTEs are in the journal at 07:49:30Z and 07:50:48Z) and the
// RESTART line went nowhere: no `restart-queued`, no `restart-refused`, no `restart-skipped`, no restart
// record, and the listener pid never changed. The lines were not refused — they were never READ.
//
// WHAT ACTUALLY HAPPENED is one condition in `turnProse` (lib/assistant/read.js), the function the harvest
// reads a finished turn's prose with. Its dedup — for a paragraph the run stream resent — is
// `blocks[i].includes(t) || t.includes(blocks[i])`, i.e. either block CONTAINING the other anywhere, even
// mid-sentence. An action line is short and quotable, and the assistant quoted it in the prose of both
// turns: "…press RESTART panel in the panel…" and "…hence the RESTART panel queued this turn…". So the
// paragraph was taken for a resend of the action line and REPLACED it in the joined prose. Both shapes are
// exercised here, verbatim from the two live turns.
//
// WHAT THIS HARNESS DOES. It cuts a sandbox of the panel (its own tree, its own PANEL_CONFIG, its own port,
// its own stores, its own HERMES_HOME with a dummy provider key in .env) and boots it for real, in front of a
// stub gateway. It then asks the panel — through its own route, /api/assistant/say — for a turn whose reply
// has the live shape, and waits for the restart to REALLY HAPPEN: the panel exits, the same port comes back
// up under a new pid, the record says a panel restart was asked for by the assistant and resumed with a real
// proof turn. Nothing here restarts the live panel or the gateway on :7331/:8642, and nothing here writes
// into the live checkout: the sandbox is a copy, and only the copy is bounced.
//
// Before the fix this fails at section 1 (the unit shapes) and at section 2 (no restart ever lands); after
// it, both pass and the restart's own record proves the new process answered a real turn.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const { parseActions, turnProse } = await import("../lib/assistant.js");
const { PROOF_PROMPT } = await import("../lib/restart.js");

let failures = 0;
let checks = 0;
const check = (name, got, want) => {
  checks += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, timeoutMs = 20_000, stepMs = 100) => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const got = await Promise.resolve().then(fn).catch(() => null);
    if (got) return got;
    if (Date.now() > until) return null;
    await sleep(stepMs);
  }
};

// ---- the reply, in the two shapes the live turns actually wrote --------------------------------------------
// Verbatim from the store: turn 3018d5e0 (07:49:20Z) and turn cee6d6dc (07:50:21Z). In both, the turn wrote
// exactly one RESTART action line, and both turns are in the panel's own `harvested` set — the harvest ran.
const SHAPE_NOTE_AFTER = [
  "The fast-forward card finished clean — 2m 07s, exit 0, nothing committed because it only moves the checkout.",
  "Its most useful paragraph is the split between the two halves, and it is exactly the reason the restart is now due.",
  "RESTART panel",
  "NOTE: PR #57's fast-forward card finished clean (2m07s, exit 0): checkout 3470b18 → 4480cf2 by --ff-only. TWO HALVES: the front-end half is live; the server-side half is not — hence the RESTART panel queued this turn.",
];
const SHAPE_PROSE_BEFORE = [
  "The hero-resource-pickup card finished and landed — that closes the ask you gave it.",
  "If it does not take a second time, the mechanism itself is the problem rather than the timing, and the cleanest fallback is yours: press RESTART panel in the panel, or say the word and I will have one worker run the stop/start pair as a one-off.",
  "RESTART panel",
  "NOTE: The queued RESTART panel from the previous turn did NOT take: the listener is still the old pid.",
];

let sandbox = null;
let stub = null;
let panel = null;
let replaced = null;
let boardReader = null;

try {
  console.log("\n1. the two live reply shapes, through the harvest's own two functions");

  for (const [label, paragraphs] of [["a NOTE written under the line", SHAPE_NOTE_AFTER], ["a paragraph that quotes the line", SHAPE_PROSE_BEFORE]]) {
    const lines = paragraphs.map((text) => ({ kind: "text", text, at: Date.now() }));
    const prose = turnProse(lines);
    const acts = parseActions(prose);
    ok(`${label}: the turn really wrote a RESTART action line`, /^\s*RESTART\s+(?:the\s+)?panel\s*$/m.test(lines.map((l) => l.text).join("\n")));
    ok(`…and turnProse still hands it to the parser`, /^\s*RESTART\s+(?:the\s+)?panel\s*$/m.test(prose), `prose lost it; ${prose.length} chars`);
    check(`…so parseActions sees one panel restart`, acts.restart, [{ target: "panel", reason: "" }]);
    ok(`…and the NOTE in the same turn is still read`, acts.note.length === 1);
  }

  // A paragraph the stream resent in full is still read once: the dedup this fix keeps.
  const resent = turnProse([
    { kind: "text", text: "prose\n\nSPAWN alpha | one", at: 1 },
    { kind: "text", text: "prose\n\nSPAWN alpha | one\n\nNOTE: last", at: 2 },
  ]);
  check("a block resent in full still replaces the earlier one", resent.split("prose").length - 1, 1);
  check("…so its action is counted once", parseActions(resent).spawn.length, 1);

  console.log("\n2. a sandbox panel, asked for a restart through its own route");
  sandbox = mkdtempSync(path.join(tmpdir(), "wtgui-restart-line-"));
  const panelRoot = path.join(sandbox, "panel");
  const homeDir = path.join(sandbox, "hermes-home");
  const scanRoot = path.join(sandbox, "scan");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(scanRoot, { recursive: true });
  // A copy of THIS tree, so the sandbox bounces a copy and never the live checkout. `panel-restart.cjs`
  // derives the server path, the pid file and the logs from the server's own directory, so the copy's logs
  // are the only ones any of this can write to. The filter is applied to the path RELATIVE to the tree: the
  // tree itself lives under a `.worktrees/` directory, and matching the absolute path would copy nothing.
  const SKIP = new Set([".git", "node_modules", ".worktrees", "logs"]);
  cpSync(ROOT, panelRoot, {
    recursive: true,
    filter: (src) => !path.relative(ROOT, src).split(/[/\\]/).some((part) => SKIP.has(part)),
  });
  // The preflight wants a provider key NAME with a value in $HERMES_HOME/.env. Never a real key: nothing here
  // reaches a provider, and the value is a placeholder on purpose.
  writeFileSync(path.join(homeDir, ".env"), "OPENROUTER_API_KEY=sandbox-placeholder-not-a-real-key\n");
  mkdirSync(path.join(panelRoot, "logs"), { recursive: true });

  // ---- a stub gateway: the panel's runs, and the restart's own proof turn ----------------------------------
  const runs = new Map();
  const requests = [];
  let seq = 0;
  let reply = SHAPE_NOTE_AFTER;
  const stubServer = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    requests.push(`${req.method} ${url.pathname}`);
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") : {};
      if (url.pathname === "/v1/capabilities") {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ version: "stub", features: { run_submission: true, run_events_sse: true } }));
        return;
      }
      if (url.pathname === "/v1/runs" && req.method === "POST") {
        const input = String(body.input || "");
        const isProof = input.trim().startsWith(PROOF_PROMPT.slice(0, 24));
        const id = `run_${++seq}`;
        runs.set(id, { id, session: body.session_id || "", input, proof: isProof, status: isProof ? "completed" : "running", output: isProof ? "PANEL-RESTART-OK" : "" });
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ run_id: id }));
        return;
      }
      const stream = /^\/v1\/runs\/([^/]+)\/events$/.exec(url.pathname);
      if (stream) {
        const run = runs.get(stream[1]);
        requests.push(`  ↑ stream opened for ${stream[1]}`);
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        if (!run) return res.end();
        // An assistant turn's reply arrives the way the live stream carries it: one paragraph per fragment,
        // each after the first opening with the blank line that starts a new text line.
        const paragraphs = run.session === "panel-assistant" ? reply : ["Acknowledged."];
        const frames = paragraphs.map((p, i) => ({ event: "message.delta", delta: i === 0 ? p : `\n\n${p}` }));
        frames.push({ event: "run.completed", output: paragraphs.join("\n\n"), usage: { total_tokens: 10, input_tokens: 8, output_tokens: 2 } });
        let i = 0;
        const timer = setInterval(() => {
          if (i >= frames.length) {
            clearInterval(timer);
            res.end();
            requests.push(`  ✓ stream ended for ${stream[1]} after ${frames.length} frames`);
            return;
          }
          res.write(`data: ${JSON.stringify(frames[i++])}\n\n`);
        }, 5);
        // The timer stops with the RESPONSE, never with the request: an IncomingMessage's 'close' fires as
        // soon as the request itself is complete, so clearing on it kills the stream before its first frame.
        res.on("close", () => clearInterval(timer));
        return;
      }
      const one = /^\/v1\/runs\/([^/]+)$/.exec(url.pathname);
      if (one && req.method === "GET") {
        const run = runs.get(one[1]);
        if (!run) {
          res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "Run not found", code: "run_not_found" } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ run_id: run.id, status: run.status, output: run.output }));
        return;
      }
      if (/\/v1\/runs\/[^/]+\/(steer|stop|approval|clarify)$/.test(url.pathname)) {
        res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "no such route", code: "not_found" } }));
    });
  });
  await new Promise((open) => stubServer.listen(0, "127.0.0.1", open));
  const stubUrl = `http://127.0.0.1:${stubServer.address().port}`;
  stub = stubServer;

  // A free port for the sandbox panel: bound and released here, then bound by the panel.
  const probe = createServer();
  await new Promise((open) => probe.listen(0, "127.0.0.1", open));
  const panelPort = probe.address().port;
  await new Promise((close) => probe.close(close));

  const configPath = path.join(panelRoot, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        port: panelPort,
        host: "127.0.0.1",
        scanRoots: [scanRoot],
        projects: [],
        defaultCwd: scanRoot,
        hideOlderThanDays: 0,
        apiServer: { url: stubUrl, key: "stub-key" },
        assistant: { enabled: true, autonomy: "draft", spawn: "off", seconds: 5 },
      },
      null,
      2,
    ),
  );

  const panelEnv = { ...process.env, PANEL_CONFIG: configPath, HERMES_HOME: homeDir };
  delete panelEnv.PANEL_TOKEN;
  panel = spawn(process.execPath, [path.join(panelRoot, "server.js")], {
    cwd: panelRoot,
    env: panelEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const outLog = [];
  panel.stdout.on("data", (d) => outLog.push(String(d)));
  panel.stderr.on("data", (d) => outLog.push(String(d)));
  const firstPid = panel.pid;

  const getConfig = async () => {
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/config`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  };
  const up = await waitFor(getConfig, 30_000);
  ok("the sandbox panel is up on its own port", Boolean(up), `pid ${firstPid}, port ${panelPort}; log tail: ${outLog.join("").slice(-400)}`);
  check("…and it is the process this harness started", panel.pid, firstPid);
  // The assistant has to be ON, or nothing harvests the turn at all (lib/assistant.js `observe` → `harvest`).
  const assistantState = up ? await fetch(`http://127.0.0.1:${panelPort}/api/assistant`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json()).catch(() => null) : null;
  ok("…with the assistant switched on, which is what harvests a turn", assistantState?.settings?.enabled === true, JSON.stringify(assistantState?.settings));

  // The reader's own browser: the board is open on this panel. That matters for more than realism — the
  // panel's exit path closes its HTTP server, which waits for an open SSE client, so the process lives out
  // the debounce on both stores (400 ms for the assistant, 700 ms for the job list) before it goes. Measured
  // live: that is exactly why the 07:45 restart's own `restart-queued` line survived on disk.
  let board = await fetch(`http://127.0.0.1:${panelPort}/api/stream`, {
    headers: { Accept: "text/event-stream" },
    signal: AbortSignal.timeout(120_000),
  }).catch(() => null);
  if (board?.body) {
    boardReader = board.body.getReader();
    board = null;
    void (async () => {
      try {
        for (;;) {
          const { done } = await boardReader.read();
          if (done) return;
        }
      } catch {
        /* the panel it was reading from is gone; that is the point of the restart */
      }
    })();
  }
  const health = await waitFor(
    () => fetch(`http://127.0.0.1:${panelPort}/api/health`, { signal: AbortSignal.timeout(1500) }).then((r) => (r.ok ? r.json() : null)),
    10_000,
  );
  check("…and the board is open on it, the way the reader's browser is", health?.clients, 1);

  // ---- the turn, through the panel's own route -------------------------------------------------------------
  // A panel that never came up must report FAILs rather than throw: every step below tolerates an absent
  // panel, so the harness still prints what it managed to measure.
  const said = await fetch(`http://127.0.0.1:${panelPort}/api/assistant/say`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "The fast-forward card finished — tell me what is left before PR #57 is live." }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  check("the panel accepted the ask", said?.status, 202);
  const turn = said ? (await said.json().catch(() => ({}))).job : null;
  ok("…as a turn of the assistant's own", turn?.thread === "panel-assistant", JSON.stringify(turn?.thread));

  // Wait for the turn to settle — the harvest runs at the end of it.
  const journalPath = path.join(panelRoot, "logs", "assistant.json");
  const jobsPath = path.join(panelRoot, "logs", "jobs.json");
  const recordPath = path.join(panelRoot, "logs", "restart.json");
  const journal = (kind) => {
    try {
      const store = JSON.parse(readFileSync(journalPath, "utf8"));
      return (store.journal || []).filter((e) => e.kind === kind);
    } catch {
      return [];
    }
  };
  // `said` is written when the turn STARTS, so the wait is on the turn's own terminal status in the job
  // store: the harvest runs from the job event that carries it.
  const turnSettled = await waitFor(() => {
    const store = JSON.parse(readFileSync(jobsPath, "utf8"));
    const j = (store.jobs || []).find((x) => x.id === turn?.id);
    return j && j.status !== "running" && j.status !== "starting" ? j : null;
  }, 30_000);
  ok("the assistant's own turn ran against the stub gateway and settled", Boolean(turnSettled), `turn ${turn?.id}, status ${turnSettled?.status}`);
  check("…as one completed turn on the board", turnSettled?.status, "done");
  // The harvest ran: the NOTE written in the same reply is read and applied. It is the live evidence this
  // card is built on — the turn's other action lines landed while the RESTART line went nowhere.
  const noted = await waitFor(() => journal("note").length, 15_000);
  ok("the harvest ran — the NOTE in the same reply was read", Boolean(noted), `no note in ${journalPath}`);
  // When the turn does not settle, the panel's own log is the only thing that says why.
  const logTail = outLog.join("").split(/\r?\n/).filter((l) => /run |gateway|POST|events|error|Error/.test(l)).slice(-12);
  if (!turnSettled) console.log(`        stub gateway saw:\n${requests.map((l) => `          ${l}`).join("\n")}\n        panel log:\n${outLog.join("").split(/\r?\n/).slice(-14).map((l) => `          ${l}`).join("\n")}`);
  if (process.env.DEBUG_SANDBOX) console.log(`        sandbox kept at ${sandbox}`);

  // ---- the restart, or the drop ----------------------------------------------------------------------------
  // The panel queues the restart only after the turn has ended, and the record is written just before the
  // process exits. Everything below is the sandbox's own files and its own port.
  const newPid = await waitFor(() => {
    try {
      const pid = Number(readFileSync(path.join(panelRoot, "logs", "server.pid"), "utf8").trim());
      return pid && pid !== firstPid ? pid : null;
    } catch {
      return null;
    }
  }, 45_000, 200);

  const queued = journal("restart-queued");
  const refused = journal("restart-refused");
  const skipped = journal("restart-skipped");
  const record = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, "utf8")) : null;

  console.log("        journal, this turn:");
  for (const e of journal("said").slice(-1).concat(journal("restart-queued"), journal("restart-refused"), journal("restart-skipped"), journal("note").slice(-1))) {
    console.log(`          ${e.kind} — ${String(e.text).slice(0, 110)}`);
  }
  console.log(`        restart record: ${record ? JSON.stringify({ id: record.id, target: record.target, requestedBy: record.requestedBy, runningIds: record.runningIds, resumedAt: record.resumedAt }) : "(none written)"}`);

  check("the RESTART line was harvested", queued.length, 1);
  ok("…and was neither refused nor reported unwired", refused.length === 0 && skipped.length === 0, JSON.stringify([...refused, ...skipped].map((e) => e.text)));
  ok("the panel wrote its restart record", Boolean(record), `no ${recordPath}`);
  check("…for a panel restart asked for by the assistant", [record?.target, record?.requestedBy], ["panel", "assistant"]);
  ok("…and then REALLY replaced itself: a new pid owns the port", Boolean(newPid), `pid ${firstPid} still owns ${panelPort}: no new process was ever started`);

  // The old process is gone, and the port is answered by the replacement.
  if (newPid) {
    let oldAlive = true;
    try {
      process.kill(firstPid, 0);
    } catch {
      oldAlive = false;
    }
    ok("the outgoing panel exited", !oldAlive, `pid ${firstPid} is still running`);
    const back = await waitFor(getConfig, 30_000);
    ok("the same port came back up under the new process", Boolean(back), `port ${panelPort} did not answer again`);
    // The replacement's own boot proves the gateway with one real turn and marks the record resumed.
    const resumed = await waitFor(() => {
      try {
        const rec = JSON.parse(readFileSync(recordPath, "utf8"));
        return rec.resumedAt ? rec : null;
      } catch {
        return null;
      }
    }, 60_000, 300);
    ok("the replacement resumed the record", Boolean(resumed), `resumedAt never set; log tail: ${outLog.join("").slice(-400)}`);
    check("…with a real proof turn the gateway answered", [resumed?.proof?.ok, resumed?.proof?.output], [true, "PANEL-RESTART-OK"]);
  }

  replaced = newPid;
} finally {
  // ---- cleanup: the sandbox only. The live panel, the live gateway and every other worktree are untouched.
  const kill = (pid) => {
    if (!pid) return;
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
  };
  kill(replaced);
  kill(panel?.pid);
  if (panel?.pid) await sleep(300);
  kill(replaced);
  try {
    await boardReader?.cancel();
  } catch {
    /* the stream ended with the panel */
  }
  try {
    stub?.closeAllConnections?.();
    stub?.close();
  } catch {
    /* nothing to close */
  }
  if (sandbox && !process.env.DEBUG_SANDBOX) {
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {
      /* the OS owns its temp dir */
    }
  }
}

console.log(`\n${checks} checks, ${failures ? `${failures} FAILED` : "all passed"}`);
process.exit(failures ? 1 : 0);
