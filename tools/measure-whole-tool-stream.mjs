// What a REAL tool result costs the panel's card — before and after the two caps are lifted.
//
//   node tools/measure-whole-tool-stream.mjs
//   node tools/measure-whole-tool-stream.mjs --db C:/Users/Jacob/AppData/Local/hermes/state.db --rows 4
//
// WHY
//
// Two caps stand between a tool result and the reader, and each has to be measured on real data or the answer is
// a guess:
//
//   * the gateway's preview cap — gateway/platforms/api_server_runs.py, `_DEFAULT_TOOL_COMPLETED_PREVIEW_MAX_CHARS`
//     (500) raised/removed by HERMES_RUN_PREVIEW_CHARS (0 = the whole payload). What the panel RECEIVES.
//   * the panel's own fold — lib/jobs/console-lines.js (MAX_TOOL_LINES 40, MAX_TOOL_LINE_CHARS 400) against the
//     console's ring buffer (lib/jobs.js MAX_LINES 600). What the panel KEEPS.
//
// It reads $HERMES_HOME/state.db READ-ONLY (never a write, never a run) and prints, for the largest stored tool
// result and for ordinary ones: the stored bytes, the bytes the panel would receive at each cap, the console lines
// the panel pushes for that, and whether the ring buffer survives it. `tools/measure-tool-output-cap.mjs --runs`
// is the other half — that one measures the live gateway's actual cap with a real run.
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { linesForEvent } from "../lib/jobs/console-lines.js";

const argv = process.argv.slice(2);
const valueOf = (flag, fallback = null) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const ROWS = Math.max(1, Number(valueOf("--rows", 3)));

function hermesHome() {
  const env = process.env.HERMES_HOME;
  return env && !env.startsWith("/") ? env : path.join(process.env.LOCALAPPDATA || os.homedir(), "hermes");
}
const dbPath = valueOf("--db", path.join(hermesHome(), "state.db"));
if (!existsSync(dbPath)) {
  console.error(`no state.db at ${dbPath}`);
  process.exit(1);
}

// The gateway's own cut, mirrored from api_server_runs.py:119-120 (`preview[: limit - 3] + "..."`, and no cut at
// all when the limit is 0 or negative). tools/measure-tool-output-cap.mjs proves the live side.
const gatewayPreview = (payload, limit) => (limit <= 0 || payload.length <= limit ? payload : payload.slice(0, limit - 3) + "...");

// The console lines the panel pushes into a job for one tool.completed event — the shipped translator, not a model
// of it. This is what the ring buffer (600 lines) has to hold.
const panelLines = (tool, preview) => linesForEvent({ event: "tool.completed", tool, preview, duration: 1.2, error: false });

const db = new DatabaseSync(dbPath, { readOnly: true });
let shapes = [];
try {
  // Sizes first, contents second: a store this size holds rows far bigger than the ones being reported, and there
  // is no reason to pull them into memory to find out.
  shapes = db
    .prepare(
      `select id, session_id, tool_name, length(content) as bytes
         from messages
        where role = 'tool' and tool_name is not null and content is not null and length(content) > 0
        order by length(content) desc
        limit 200`,
    )
    .all();
} catch (err) {
  console.error(`could not read that store: ${err?.message || err}`);
  process.exit(1);
}
if (!shapes.length) {
  db.close();
  console.error("no tool rows in that store");
  process.exit(1);
}

// The largest row, plus ordinary ones around 40 kB (the size a plain file read lands at) so the numbers are not
// carried by one outlier.
const largest = shapes[0];
const ordinary = shapes
  .filter((r) => r.bytes >= 20_000 && r.bytes <= 64_000)
  .sort((a, b) => Math.abs(a.bytes - 40_000) - Math.abs(b.bytes - 40_000))
  .slice(0, ROWS - 1);
const pick = [largest, ...ordinary];
let rows = [];
try {
  const get = db.prepare("select content from messages where id = ?");
  rows = pick.map((s) => ({ ...s, content: String(get.get(s.id)?.content || "") }));
} finally {
  db.close();
}
const CAPS = [
  { label: "500 (gateway default)", limit: 500 },
  { label: "20000 (the user env before this card)", limit: 20_000 },
  { label: "0 — HERMES_RUN_PREVIEW_CHARS=0", limit: 0 },
];

// --volume: the same store's totals, which is the other half of the answer — "is streaming all of it affordable?"
function volumeReport() {
  const db2 = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const agg = db2
      .prepare(
        `select count(*) as n, sum(length(content)) as bytes,
                sum(case when length(content) > 500 then 1 else 0 end) as over500,
                sum(case when length(content) > 500 then length(content) else 0 end) as bytes_over500
           from messages where role = 'tool' and content is not null and length(content) > 0`,
      )
      .get();
    const perSession = db2
      .prepare(
        `select session_id, count(*) as n, sum(length(content)) as bytes
           from messages where role = 'tool' and content is not null and length(content) > 0
          group by session_id order by bytes desc limit 5`,
      )
      .all();
    const n = Number(agg.n) || 0;
    const bytes = Number(agg.bytes) || 0;
    const over = Number(agg.over500) || 0;
    const overBytes = Number(agg.bytes_over500) || 0;
    console.log(`${n} stored tool results, ${(bytes / 1024 / 1024).toFixed(1)} MB in total, mean ${(bytes / n / 1024).toFixed(1)} kB`);
    console.log(`${((100 * over) / n).toFixed(0)}% of them are longer than 500 characters, and those hold ${((100 * overBytes) / bytes).toFixed(0)}% of the bytes`);
    console.log("");
    console.log("The five heaviest SESSIONS (the closest thing the store has to \"what one turn's tools returned\"):");
    for (const s of perSession) console.log(`  ${String(s.session_id).slice(0, 28).padEnd(30)} ${String(s.n).padStart(5)} results  ${(s.bytes / 1024).toFixed(0).padStart(7)} kB`);
    const perSessionBytes = Number(perSession[0]?.bytes) || 0;
    const perSessionN = Number(perSession[0]?.n) || 1;
    console.log("");
    console.log(`Streaming the whole of one session's results is ~${(perSessionBytes / 1024).toFixed(0)} kB over loopback, over ${perSessionN} tool events.`);
    console.log(`Fifteen runs at that weight is ~${((15 * perSessionBytes) / 1024 / 1024).toFixed(1)} MB across the whole fleet, spread over the runs' own minutes.`);
    console.log("That is not what bounds the panel: the wire is cheap. What bounds it is the console's ring buffer");
    console.log("(600 lines per job) — one 5,000-line result pushed through it would evict the rest of the card, which");
    console.log("is why the fold keeps 40 lines and the rest is one click away (the row read back on demand).");
  } finally {
    db2.close();
  }
}

if (argv.includes("--volume")) {
  volumeReport();
  process.exit(0);
}

console.log(`store: ${dbPath}   (${rows.length ? `${rows.length} rows read` : "nothing"}; read-only)`);
console.log("");
for (const row of rows) {
  console.log(`${row.tool_name} · session ${String(row.session_id).slice(0, 12)}… · ${row.bytes} bytes of stored result`);
  for (const cap of CAPS) {
    const preview = gatewayPreview(row.content, cap.limit);
    const lines = panelLines(row.tool_name, preview);
    const kind = cap.limit <= 0 ? "the whole payload" : cap.limit === 500 ? "220 bytes off the top of a file read" : "still 5× the fold's head";
    console.log(
      `  cap ${cap.label.padEnd(38)} receives ${String(preview.length).padStart(7)} bytes  ` +
        `(${((100 * preview.length) / row.bytes).toFixed(1)}% of the result)  ` +
        `→ ${String(lines.length).padStart(3)} console lines  ` +
        `${lines.length <= 600 ? "ring buffer survives" : "RING BUFFER EVICTS"}   [${kind}]`,
    );
  }
  const whole = panelLines(row.tool_name, gatewayPreview(row.content, 0));
  const note = whole.at(-1).text;
  console.log(`  the card keeps ${whole.length - 2} head lines of it and ends with: ${note}`);
  console.log("");
}
console.log("The panel RECEIVES the whole result and KEEPS 40 lines of it (plus the fold note), whatever the size:");
console.log("the click reads the one stored row back out of state.db — uncapped, one row, on demand.");
