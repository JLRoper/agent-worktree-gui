// The token-cache report, on demand.
//
//   node tools/report-token-cache.mjs                 # last 2 days of %LOCALAPPDATA%\hermes\logs\agent.log
//   node tools/report-token-cache.mjs --days 1        # today only
//   node tools/report-token-cache.mjs --log <file>    # another log
//   node tools/report-token-cache.mjs --json          # machine-readable, same numbers
//
// WHY the shape: lib/token-cache-report.js explains what the numbers are and why they matter (calls x
// context; cache per upstream; folds amortized). This file only finds the log, reads it and prints — the
// parsing, the arithmetic and the text are the library's, so the test drives exactly what a run prints.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseAgentLog, summarize, formatReport } from "../lib/token-cache-report.js";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const value = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : null;
};

if (has("--help") || has("-h")) {
  console.log("usage: node tools/report-token-cache.mjs [--days N] [--log <file>] [--json]");
  process.exit(0);
}

const days = Number(value("--days")) || 2;
const logFile =
  value("--log") || path.join(process.env.HERMES_HOME || path.join(process.env.LOCALAPPDATA || "", "hermes"), "logs", "agent.log");

let text = "";
try {
  text = readFileSync(logFile, "utf8");
} catch (err) {
  console.error(`report-token-cache: cannot read ${logFile}: ${String((err && err.message) || err)}`);
  process.exit(2);
}

const report = summarize(parseAgentLog(text), { days });
if (has("--json")) console.log(JSON.stringify(report, null, 2));
else console.log(formatReport(report));
