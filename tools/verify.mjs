#!/usr/bin/env node
// One runner for this repo's verification harnesses.
//
// WHY. The harnesses are programs, not a framework: each one boots what it needs, prints what it measured and exits
// non-zero when its claim failed. That is the right shape for an argument, and the wrong shape for a fleet of 120 —
// there was no way to ask "what is there?", "run the three about the branch column", or "which one is red?" without
// remembering file names and running them one at a time. This owns the three answers, and nothing else: a harness
// keeps its own output, its own sandbox and its own exit code.
//
// Every harness also DECLARES what it is, on a `// HARNESS: LIVE GATE` or `// HARNESS: FROZEN EVIDENCE` line in its
// own header, and this runner is what reads that declaration: `--list` prints it, and a FROZEN EVIDENCE one is named
// and skipped rather than run as a gate. See `stateOf` below for why.
//
//   node tools/verify.mjs --list                 what there is, with the first line of each file and its state
//   node tools/verify.mjs --all                  every harness, one child at a time (--jobs <n> for n at once)
//   node tools/verify.mjs --only branch          the harnesses whose name contains "branch"
//   node tools/verify.mjs --only pr --all        (--all is implied by a selector; both is harmless)
//
//   --dir <path>        scan another directory (the test for this runner uses it)
//   --timeout <ms>      per harness, default 15 minutes — a browser harness on a loaded machine is slow
//   --jobs, -j <n>      run up to <n> harnesses at once (default 1, capped at 16). Each harness already owns its
//                       own sandbox and port, so the wall clock is the only thing they share; two that pin the SAME
//                       fixed port still collide, which is why this is opt-in rather than the default. Progress
//                       lines interleave once n > 1 — a `PASS` still names its own harness.
//   --json              one JSON object on stdout instead of the table
//   --quiet             do not echo a failing harness's last lines
//
// Exit codes: 0 every selected harness passed; 1 at least one failed, timed out or was killed; 2 nothing selected.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const DEFAULT_TIMEOUT = 15 * 60 * 1000;
const TAIL_LINES = 12;

function parseArgs(argv) {
  const opt = { dirs: [HERE, path.join(REPO, "harness")], explicitDirs: false, timeout: DEFAULT_TIMEOUT, jobs: 1, json: false, quiet: false, list: false, all: false, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--list") opt.list = true;
    else if (a === "--all") opt.all = true;
    else if (a === "--json") opt.json = true;
    else if (a === "--quiet") opt.quiet = true;
    else if (a === "--only") opt.only = String(argv[(i += 1)] || "");
    else if (a === "--dir") {
      // --dir means "scan exactly these": a caller pointing at a fixture folder does not also want the 120 real
      // harnesses, and a selector like --only ok would otherwise match a name it never meant (verify-token-costs).
      if (!opt.explicitDirs) {
        opt.dirs = [];
        opt.explicitDirs = true;
      }
      opt.dirs.push(path.resolve(String(argv[(i += 1)] || ".")));
    }
    else if (a === "--timeout") opt.timeout = Math.max(1000, Number(argv[(i += 1)]) || DEFAULT_TIMEOUT);
    else if (a === "--jobs" || a === "-j") opt.jobs = Math.max(1, Math.min(16, Number(argv[(i += 1)]) || 1));
    else if (a === "--help" || a === "-h") opt.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opt;
}

// A harness is `verify-<subject>.mjs` beside this file, or `verify.mjs` one directory down (harness/<lane>/).
// Deliberately not recursive: a tools/ tree that grows a runner must not start running a scratch folder.
export function discover(dir) {
  const found = [];
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isFile() && /^verify-.+\.mjs$/.test(entry.name)) found.push(path.join(dir, entry.name));
    else if (entry.isDirectory()) {
      const nested = path.join(dir, entry.name, "verify.mjs");
      try {
        if (statSync(nested).isFile()) found.push(nested);
      } catch {
        /* no verify.mjs there */
      }
    }
  }
  return found;
}

// EVERY HARNESS DECLARES WHAT IT IS, in its own header, and this is the one thing that reads the declaration:
//
//   // HARNESS: LIVE GATE        it tracks main, it is wired into this repo's gate list (a `verify:*` script in
//                              package.json) and `test/harness.test.js` holds it to that.
//   // HARNESS: FROZEN EVIDENCE  a record of one commit, named in the header — historical, and NEVER to be run as
//                              a gate. It is reported and skipped here rather than run, because a stale harness's
//                              red is not evidence of a regression and its green is not evidence of a fix.
//
// WHY THE RUNNER READS IT. A decision written only in a file `--all` walks past without looking is a rumour: two
// harnesses rotted against main for a week and nothing could tell the difference between their red and a real
// break. A frozen one is now SKIPPED (and said so, in the table and in --json) instead of being measured as if it
// meant something today. An undeclared harness is still run, exactly as before, so a new file needs no ceremony to
// work — what the line buys is the state, not permission.
export function stateOf(file) {
  let head;
  try {
    head = readFileSync(file, "utf8").split(/\n/).slice(0, 40).join("\n");
  } catch {
    return "";
  }
  if (/^\/\/\s*HARNESS:\s*FROZEN EVIDENCE\b/m.test(head)) return "FROZEN EVIDENCE";
  if (/^\/\/\s*HARNESS:\s*LIVE GATE\b/m.test(head)) return "LIVE GATE";
  return "";
}

// The file's own one-line summary: its first `//` line that is prose, not a usage example or a shebang.
function summaryOf(file) {
  try {
    const text = readFileSync(file, "utf8");
    const line = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.startsWith("//") && !/^\/\/\s*(node|PANEL_|SCRATCH|\s*$)/.test(l) && l.length > 8);
    return line ? line.replace(/^\/\/\s*/, "").slice(0, 110) : "";
  } catch {
    return "";
  }
}

function runOne(file, { timeout, quiet }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [file], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const out = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    const keep = (chunk) => {
      out.push(String(chunk));
      if (out.length > 400) out.splice(0, out.length - 400);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ file, code: null, signal: null, ms: Date.now() - started, timedOut: false, tail: [String(e.message)], ok: false });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const lines = out.join("").split(/\r?\n/).filter(Boolean);
      const ok = !timedOut && code === 0;
      resolve({
        file,
        code,
        signal,
        ms: Date.now() - started,
        timedOut,
        tail: quiet && ok ? [] : lines.slice(-TAIL_LINES),
        ok,
      });
    });
  });
}

async function main() {
  let opt;
  try {
    opt = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e.message || e));
    return 2;
  }
  if (opt.help) {
    console.log("node tools/verify.mjs --list | --all | --only <substr> [--dir <path>] [--timeout <ms>] [--jobs <n>] [--json] [--quiet]");
    return 0;
  }
  const files = [...new Set(opt.dirs.flatMap((d) => {
    try {
      return discover(d);
    } catch {
      return [];
    }
  }))].sort();
  const selected = opt.only ? files.filter((f) => path.basename(path.dirname(f)).toLowerCase().includes(opt.only.toLowerCase()) || path.basename(f).toLowerCase().includes(opt.only.toLowerCase())) : files;
  const rel = (f) => path.relative(REPO, f).replace(/\\/g, "/");

  if (opt.list || (!opt.all && !opt.only)) {
    if (opt.json) {
      console.log(JSON.stringify(selected.map((f) => ({ name: rel(f), state: stateOf(f), summary: summaryOf(f) })), null, 1));
      return selected.length ? 0 : 2;
    }
    for (const f of selected) {
      const name = rel(f);
      const summary = summaryOf(f);
      const state = stateOf(f);
      console.log(summary ? `${name}\n    ${summary}${state ? `   [${state}]` : ""}` : `${name}${state ? `   [${state}]` : ""}`);
    }
    console.log(`\n${selected.length} harness${selected.length === 1 ? "" : "es"} in ${opt.dirs.map((d) => path.relative(REPO, d) || ".").join(", ")}${opt.only ? ` matching "${opt.only}"` : ""} — run one with --only <substr>, all with --all`);
    return selected.length ? 0 : 2;
  }

  if (!selected.length) {
    console.error(`no harness matches${opt.only ? ` "${opt.only}"` : ""} in ${opt.dirs.join(", ")}`);
    return 2;
  }

  // A FROZEN EVIDENCE harness says so in its own header, and that means this: it is a record of one commit, not a
  // claim about main. Running it as a gate is the rot this runner exists to prevent, so it is NAMED in the table and
  // SKIPPED — never counted as a pass, never counted as a failure. A selector that reaches only frozen artefacts has
  // measured nothing, which is exit 2 the way an unmatched selector is, and not a green run.
  const frozen = selected.filter((f) => stateOf(f) === "FROZEN EVIDENCE");
  const runnable = selected.filter((f) => stateOf(f) !== "FROZEN EVIDENCE");

  if (!runnable.length) {
    console.error(`no harness to run${opt.only ? ` for "${opt.only}"` : ""}: ${frozen.map(rel).join(", ")} ${frozen.length === 1 ? "is" : "are"} FROZEN EVIDENCE (historical, never a gate)`);
    return 2;
  }

  // One lane per job, each taking the next unclaimed harness. `results` is indexed, so the table, the summary and
  // the --json payload stay in discovery order however the children finish.
  const results = new Array(runnable.length);
  let nextIdx = 0;
  const lane = async () => {
    for (;;) {
      const idx = nextIdx++;
      if (idx >= runnable.length) return;
      const file = runnable[idx];
      const name = rel(file);
      if (!opt.json) process.stdout.write(`… ${name}\n`);
      const result = await runOne(file, opt);
      results[idx] = { ...result, name };
      if (!opt.json) {
        const verdict = result.timedOut ? "TIMEOUT" : result.ok ? "PASS" : "FAIL";
        const secs = (result.ms / 1000).toFixed(1);
        console.log(`  ${verdict}  ${name}  ${secs}s${result.ok ? "" : `  (exit ${result.code ?? result.signal})`}`);
        if (!result.ok) for (const line of result.tail) console.log(`    | ${line}`);
      }
    }
  };
  // A frozen artefact is named before the table so a reader sees it beside the results, not instead of them.
  if (!opt.json && frozen.length) {
    for (const f of frozen) console.log(`  FROZEN  ${rel(f)}  — FROZEN EVIDENCE: historical, not run as a gate`);
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opt.jobs, runnable.length)) }, lane));

  const failed = results.filter((r) => !r.ok);
  if (opt.json) {
    console.log(
      JSON.stringify({ ran: results.length, failed: failed.length, frozen: frozen.map(rel), results: results.map(({ tail, ...r }) => r) }, null, 1),
    );
  } else {
    console.log(
      `\n${results.length - failed.length}/${results.length} passed${failed.length ? `, ${failed.length} failed: ${failed.map((f) => f.name).join(", ")}` : ""}` +
        `${frozen.length ? ` · ${frozen.length} frozen (not run): ${frozen.map(rel).join(", ")}` : ""}`,
    );
  }
  return failed.length ? 1 : 0;
}

// Run the runner only when this file IS the command. `test/harness.test.js` imports `discover` and `stateOf` to hold
// the family to its own declarations, and a module that ran itself on import would print the whole fleet into that
// test's output — and set its exit code — for asking a question.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) process.exitCode = await main();
