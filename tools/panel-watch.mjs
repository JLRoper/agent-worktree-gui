#!/usr/bin/env node
// tools/panel-watch.mjs - one watchdog pass over the board, on a clock, with the decision in lib/panel-watch.js.
//
//   node tools/panel-watch.mjs check                  # one pass; announces only what is news
//   node tools/panel-watch.mjs check --dry-run        # say what it would report, write nothing, announce nothing
//   node tools/panel-watch.mjs check --json           # the pass as data, for a cron log
//   node tools/panel-watch.mjs state                  # the reported set and the counters as saved
//
// WHAT ONE PASS DOES
//
//   1. GET /api/jobs (or read --jobs <fixture>), and read the job STORE (jobs.json, or --store <file>). The two
//      are not the same list: /api/jobs carries runs the panel resurrected from the gateway after the store let
//      them go, and a run the store does not hold has no row, queue entry or repair on the board.
//   2. Hand both to sweepBoard (lib/panel-watch.js). It answers with the lines that are news:
//        - a LIVE failed run (store holds it, no endedAt) says so on every pass, because it is failing now;
//        - a failed run that already ended, or that the store no longer holds, is reported ONCE and then never
//          again - the state file remembers it by id, pruned by recency, never by id order.
//      and a run still marked running past --long-run-minutes (default 55), which is a live condition too.
//   3. POST the block to /api/assistant/say as `Watchdog: <line> | <line>`, the shape the panel's assistant has
//      always been handed, and write the state ONLY after the panel accepted it. A refused announce (409 while
//      a turn is running) leaves the state untouched, so the next pass retries the report instead of losing it.
//
// WHY THIS FILE EXISTS. The watch used to be a script outside this repo whose one-shot set was sorted and then
// truncated to the newest 200 BY ID ORDER. Ids are hex, so every id that sorts low was dropped on each save and
// reported again on the next pass: two runs that had ended hours earlier and were no longer in the job store
// were named in a fresh "Watchdog: FAILED ..." turn every ten minutes. The rule now lives here, beside the code
// it judges, and test/panel-watch.test.js is its contract.
//
// State: <state dir>/panel-watch.json (lib/paths.js resolves the state dir - WAG_HOME, else the data dir), or
// --state <file>. The file is `{version, reported: {<id>: <first reported ISO>}, suppressed, downAt}`.
//
// Exit: 0 a pass that reported nothing, or reported what it should · 1 the panel could not be read or the
// announce failed · 2 a usage error.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LONG_RUN_MINUTES_DEFAULT,
  announceText,
  readWatchState,
  sweepBoard,
  writeWatchState,
} from "../lib/panel-watch.js";
import { resolveDirs, statePaths } from "../lib/paths.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PANEL_PORT_DEFAULT = 7331;
const FETCH_TIMEOUT_MS = 15_000;

const USAGE = `panel-watch - the board's watchdog sweep

  node tools/panel-watch.mjs check [options]        one pass: report what is news, then stop
  node tools/panel-watch.mjs state [--json]         the saved reported set and counters

Options
  --panel <url>            the panel base URL (default: PANEL_URL, else http://127.0.0.1:<config.json port>)
  --jobs <file>            read the job feed from a fixture ({jobs: [...]}, or the array) instead of the panel
  --store <file>           the job store to judge "the store no longer holds it" against (default: jobs.json)
  --state <file>           the state file (default: <state dir>/panel-watch.json)
  --long-run-minutes <n>   a run marked running longer than this is reported (default: ${LONG_RUN_MINUTES_DEFAULT})
  --dry-run                print the pass, write no state, announce nothing
  --json                   print the pass as JSON
  --no-announce            write the state and print, but do not POST to the panel (for a manual pass)
  --quiet                  print nothing when there is nothing to report

Environment: PANEL_URL, PANEL_TOKEN (only needed for a non-loopback panel), WAG_HOME.
Exit: 0 ok · 1 the panel or the announce failed · 2 a usage error.`;

function fail(message, code = 1) {
  process.stderr.write(`panel-watch: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  const takesValue = new Set(["--panel", "--jobs", "--store", "--state", "--long-run-minutes"]);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.flags.help = true;
      continue;
    }
    if (a === "--dry-run") {
      out.flags.dryRun = true;
      continue;
    }
    if (a === "--json") {
      out.flags.json = true;
      continue;
    }
    if (a === "--no-announce") {
      out.flags.noAnnounce = true;
      continue;
    }
    if (a === "--quiet") {
      out.flags.quiet = true;
      continue;
    }
    if (takesValue.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || String(v).startsWith("--")) fail(`usage: ${a} needs a value`, 2);
      out.flags[a.replace(/^--/, "")] = v;
      i += 1;
      continue;
    }
    if (String(a).startsWith("--")) fail(`usage: unknown option ${a}`, 2);
    out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const flag = (name) => args.flags[name];
if (flag("help")) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
const command = String(args._[0] || "check").trim();
if (!["check", "state"].includes(command)) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(command ? 2 : 0);
}

// ---- where things are -----------------------------------------------------------------------------------------
function stateDirOf() {
  const dirs = resolveDirs({ config: {}, env: process.env, home: os.homedir(), tmpdir: os.tmpdir() });
  return statePaths({ dataDir: dirs.dataDir }).stateDir;
}

const STATE_DIR = stateDirOf();
const STATE_FILE = flag("state") ? path.resolve(flag("state")) : path.join(STATE_DIR, "panel-watch.json");

/** The store the panel persists. A fixture path wins; a missing default file reads as "no store handed in". */
function storeFile() {
  if (flag("store")) return path.resolve(flag("store"));
  try {
    return statePaths({ dataDir: resolveDirs({ config: {}, env: process.env, home: os.homedir(), tmpdir: os.tmpdir() }).dataDir }).jobsFile;
  } catch {
    return null;
  }
}

function panelBase() {
  const explicit = flag("panel") || process.env.PANEL_URL;
  if (explicit) return String(explicit).replace(/\/+$/, "");
  let port = PANEL_PORT_DEFAULT;
  try {
    const cfg = JSON.parse(readFileSync(path.join(ROOT, "config.json"), "utf8"));
    if (Number(cfg.port) > 0) port = Number(cfg.port);
  } catch {
    /* no config beside the tool: the default port is the panel's own */
  }
  return `http://127.0.0.1:${port}`;
}

// ---- HTTP -----------------------------------------------------------------------------------------------------
async function panelJson(pathname, { method = "GET", body = null } = {}) {
  const headers = { Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  const token = String(process.env.PANEL_TOKEN || "").trim();
  if (token) headers["x-panel-token"] = token;
  let res;
  try {
    res = await fetch(`${panelBase()}${pathname}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`the panel at ${panelBase()} did not answer: ${String((err && err.message) || err)}`);
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = new Error(`the panel refused ${method} ${pathname}: ${(json && json.error) || text.slice(0, 200) || res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// ---- the pass -------------------------------------------------------------------------------------------------
function readJsonFile(file, what) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    fail(`could not read the ${what} at ${file}: ${String((err && err.message) || err)}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    fail(`the ${what} at ${file} is not JSON: ${String((err && err.message) || err)}`);
  }
}

async function readFeed() {
  if (flag("jobs")) return readJsonFile(path.resolve(flag("jobs")), "job fixture");
  const answer = await panelJson("/api/jobs");
  return { jobs: Array.isArray(answer?.jobs) ? answer.jobs : [] };
}

function readStore() {
  const file = storeFile();
  if (!file) return { store: null, file: null, note: "no job store path could be resolved" };
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { store: null, file, note: `the job store ${file} does not exist` };
    return { store: null, file, note: `could not read the job store ${file}: ${String((err && err.message) || err)}` };
  }
  try {
    return { store: JSON.parse(text), file, note: null };
  } catch (err) {
    return { store: null, file, note: `could not read the job store ${file}: ${String((err && err.message) || err)}` };
  }
}

async function pass({ dryRun = false, noAnnounce = false } = {}) {
  const feed = await readFeed();
  const { store, file: storePath, note: storeNote } = readStore();
  const loaded = readWatchState(STATE_FILE);
  const now = Date.now();
  const minutes = Number(flag("long-run-minutes"));
  const result = sweepBoard({
    jobs: Array.isArray(feed?.jobs) ? feed.jobs : [],
    store,
    state: loaded.state,
    now,
    longRunMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : LONG_RUN_MINUTES_DEFAULT,
  });
  const text = result.alerts.length ? announceText(result.alerts) : "";

  let announced = "nothing to say";
  if (result.alerts.length) {
    if (dryRun) announced = "not sent (dry run)";
    else if (noAnnounce) announced = "not sent (--no-announce)";
    else {
      try {
        await panelJson("/api/assistant/say", { method: "POST", body: { text } });
        announced = "said";
      } catch (err) {
        announced = err && err.status === 409 ? "refused (a turn is already running); nothing recorded, next pass retries" : `failed: ${String((err && err.message) || err)}`;
      }
    }
  }

  // The state is written only when the report LANDED (or when there was nothing to report): recording an alert
  // the assistant never saw would lose it for good.
  const delivered = !result.alerts.length || dryRun || noAnnounce || announced === "said";
  if (!dryRun && delivered) writeWatchState(STATE_FILE, result.state);

  return {
    panel: panelBase(),
    store: storePath,
    storeNote,
    stateFile: STATE_FILE,
    stateError: loaded.error,
    now: new Date(now).toISOString(),
    alerts: result.alerts,
    text,
    counts: result.counts,
    announced,
    saved: !dryRun && delivered,
  };
}

// ---- commands -------------------------------------------------------------------------------------------------
if (command === "state") {
  const loaded = readWatchState(STATE_FILE);
  if (flag("json")) {
    process.stdout.write(`${JSON.stringify({ file: STATE_FILE, ...loaded }, null, 2)}\n`);
  } else {
    process.stdout.write(`panel-watch state: ${STATE_FILE}\n`);
    if (loaded.error) process.stdout.write(`  read: ${loaded.error}\n`);
    const ids = Object.keys(loaded.state.reported);
    process.stdout.write(`  reported: ${ids.length}\n`);
    for (const id of ids.slice(-20)) process.stdout.write(`    ${id}  first reported ${loaded.state.reported[id]}\n`);
    process.stdout.write(`  wake-suppressed seen: ${loaded.state.suppressed}\n`);
    process.stdout.write(`  panel last reported down: ${loaded.state.downAt ? new Date(loaded.state.downAt).toISOString() : "never"}\n`);
  }
  process.exit(0);
}

const dryRun = Boolean(flag("dryRun"));
const noAnnounce = Boolean(flag("noAnnounce"));
let out;
try {
  out = await pass({ dryRun, noAnnounce });
} catch (err) {
  const message = String((err && err.message) || err);
  // A panel that is down is news, once an hour: the same one-shot rule as a dead run, on the same state file.
  const loaded = readWatchState(STATE_FILE);
  const now = Date.now();
  const hourly = now - Number(loaded.state.downAt || 0) > 60 * 60 * 1000;
  if (hourly) {
    loaded.state.downAt = now;
    if (!dryRun) writeWatchState(STATE_FILE, loaded.state);
  }
  if (!flag("quiet") || hourly) process.stdout.write(`PANEL DOWN - ${panelBase()} unreachable: ${message}\n`);
  // Exit 1 only when this pass is the one that reported the outage: a cron that alarms every ten minutes for one
  // dead panel is the same re-report loop this tool exists to stop.
  process.exit(hourly ? 1 : 0);
}

if (flag("json")) {
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
} else if (out.alerts.length) {
  process.stdout.write(`PANEL ${out.panel} needs a look:\n`);
  for (const line of out.alerts) process.stdout.write(` - ${line}\n`);
  process.stdout.write(`announce: ${out.announced}${out.saved ? " (state saved)" : ""}\n`);
} else if (!flag("quiet")) {
  process.stdout.write(`panel-watch: the board is quiet - 0 alerts, ${out.counts.failed} failed run(s) already reported\n`);
}
process.exit(out.alerts.length && out.announced.startsWith("failed:") ? 1 : 0);
