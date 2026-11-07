// What one assistant turn appends to its thread, and what it costs per API call.
//
//   node tools/verify-append-tax.mjs
//
// HARNESS: LIVE GATE
// The assistant's standing briefing used to ride in the run's INPUT as a user message: `jobs.create()` prepended
// `Assistant.preamble()` to the question (`pre + anchored`), so every wake wrote ~18.5 KB into the thread's
// transcript. That text is not paid once. Every later API call in the session re-reads it (as cache), and every
// compaction re-ingests it as uncached input, which is the append tax.
//
// This tool measures the turn the panel actually creates, on a COPY of this box's live assistant state, and prints:
//
//   * the turn's appended input (what `jobs.create()` would put in `input`), in bytes and in the gateway's own
//     rough token estimate (ceil(UTF-8 bytes / 4), agent/model_metadata.py:CHARS_PER_TOKEN);
//   * the standing text the turn sends as SYSTEM text (`instructions` on the run body), when the tree has that
//     split; on a tree without it there is no system block and the whole briefing is appended;
//   * the share of the briefing that rides in the transcript, over a run of sweep wakes;
//   * this box's own store reading: uncached `input_tokens` per API call over the assistant threads (read-only).
//
// It is a MEASUREMENT AND A GATE. On a tree that still appends the standing briefing it prints the before shape and
// exits 1, which is where the before number comes from. On a tree that sends the standing blocks as system text and
// keeps only the queue digest with the question, the same run prints the after shape and exits 0, and the turn's
// appended input must be under half of the full briefing it used to carry.
//
// The live panel is never touched: the state is copied to a temp directory, the job store is a capture stub, and
// no gateway is called. Nothing is written to ~/.wag.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Assistant } from "../lib/assistant.js";
import { PRIMARY_ASSISTANT } from "../lib/assistants.js";

const HOME = process.env.WAG_HOME || path.join(os.homedir(), ".wag");
const LIVE_STATE = path.join(HOME, "state");
const LIVE_DB =
  process.env.SESSION_REAL_HOME ||
  path.join(process.env.LOCALAPPDATA || path.join(process.env.HOME || "", "AppData", "Local"), "hermes", "state.db");

const bytes = (s) => Buffer.byteLength(String(s || ""), "utf8");
const fmt = (n) => Number(n).toLocaleString("en-US");

let failures = 0;
const check = (name, cond, extra = "") => {
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};

if (!existsSync(path.join(LIVE_STATE, "jobs.json"))) {
  console.error(`no live panel state at ${LIVE_STATE} (set WAG_HOME)`);
  process.exit(2);
}

const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-append-tax-"));
const state = path.join(dir, "state");
try {
  // A copy, not the live store: the tool builds turns, and a turn persists a charter send record and a board
  // signature. The copy keeps that out of the reader's panel.
  cpSync(LIVE_STATE, state, { recursive: true });
  const jobsFile = path.join(state, "jobs.json");
  const store = JSON.parse(readFileSync(jobsFile, "utf8"));
  const liveJobs = (store.jobs || []).filter((j) => j.status !== "running");
  const projectsFile = path.join(state, "projects.json");
  const projects = existsSync(projectsFile) ? JSON.parse(readFileSync(projectsFile, "utf8")).projects || [] : [];

  const created = [];
  const jobs = {
    list: () => liveJobs,
    firstOfThread: (thread) => liveJobs.find((j) => j.thread === thread) || null,
    create: async (body) => {
      created.push(body);
      return { id: `probe-${created.length}`, thread: body.thread, ...body };
    },
    push: () => {},
  };
  const assistant = new Assistant({
    config: { jobsFile },
    jobs,
    getProjects: () => projects,
    getRows: () => [],
    getChildren: () => ({}),
    onLog: () => {},
  });

  console.log("== the turn this tree builds, on a copy of this box's assistant state ==");
  console.log(`      live state copied from ${LIVE_STATE}`);

  // A sweep wake, eight times: the gate on the queue digest and the board digest is a COUNT, and one turn only ever
  // shows one side of it. The question is the median the audit measured (167 chars).
  const question = "Sweep your queue. Nothing needs a decision; say what you make of the board in one line.";
  for (let i = 0; i < 8; i += 1) {
    await assistant.say(question, { origin: { kind: "assistant-wake", rule: "queuesweep", reason: "sweep" } });
  }
  if (created.length !== 8) throw new Error(`expected 8 created turns, got ${created.length}`);

  // `jobs.create()` builds the request as `pre + anchored`; the assistant turn has no cwd anchor, so the input is
  // the separator, the briefing it is handed, and the question. `system` is the run's `instructions` block.
  const sep = "\n\n---\n\n";
  const rows = created.map((body, i) => {
    const appended = body.preamble ? `${String(body.preamble).trim()}${sep}${body.prompt}` : String(body.prompt);
    const system = body.system ? String(body.system) : "";
    return { turn: i + 1, appended: bytes(appended), system: bytes(system), hasDigest: /Your task queue \(/.test(appended), hasRules: /Standing rules/.test(appended) };
  });

  const ordinary = rows.slice(1); // turn 1 of a session carries the charter in full; every later sweep is the steady shape
  const avgAppended = Math.round(ordinary.reduce((n, r) => n + r.appended, 0) / ordinary.length);
  const avgSystem = Math.round(ordinary.reduce((n, r) => n + r.system, 0) / ordinary.length);
  const first = rows[0];
  const fullBriefing = ordinary[0].system + ordinary[0].appended;
  const meanAppended = Math.round(rows.reduce((n, r) => n + r.appended, 0) / rows.length);

  console.log("");
  console.log("  turn | appended to the thread | sent as system text | queue digest in the turn | rules in the turn");
  for (const r of rows) {
    console.log(
      `  ${String(r.turn).padStart(4)} | ${fmt(r.appended).padStart(21)} B | ${fmt(r.system).padStart(19)} B | ${r.hasDigest ? "yes" : "no ".padEnd(23)} | ${r.hasRules ? "yes" : "no"}`,
    );
  }
  console.log("");
  console.log(`  ordinary sweep (turns 2-8): ${fmt(avgAppended)} B appended (${fmt(Math.ceil(avgAppended / 4))} est. tokens), ${fmt(avgSystem)} B as system text`);
  console.log(`  first turn of a session: ${fmt(first.appended)} B appended, ${fmt(first.system)} B as system text (the charter is sent whole)`);
  console.log(`  all eight turns: ${fmt(meanAppended)} B appended on average`);
  console.log(`  digest carried on ${rows.filter((r) => r.hasDigest).length} of ${rows.length} wakes`);
  console.log(`  ordinary turn's appended share of its briefing: ${((avgAppended / fullBriefing) * 100).toFixed(1)}%`);

  // ---- the store's own figure: uncached input per API call on the assistant threads ----
  console.log("");
  console.log("== the gateway's counters for the assistant threads (read-only) ==");
  if (existsSync(LIVE_DB)) {
    const db = new DatabaseSync(LIVE_DB, { readOnly: true });
    const row = db
      .prepare("select coalesce(sum(input_tokens),0) inp, coalesce(sum(cache_read_tokens),0) cr, coalesce(sum(api_call_count),0) calls from sessions where id like 'panel-assistant%'")
      .get();
    db.close();
    const perCall = row.calls ? row.inp / row.calls : 0;
    console.log(`      sessions panel-assistant%: ${fmt(row.inp)} uncached input tokens over ${fmt(row.calls)} API calls`);
    console.log(`      uncached input per API call: ${fmt(Math.round(perCall))}`);
    console.log(`      cache reads: ${fmt(row.cr)} tokens (${((row.cr / (row.inp + row.cr)) * 100).toFixed(1)}% of prompt tokens)`);
  } else {
    console.log(`      no store at ${LIVE_DB}; skipped`);
  }

  // ---- the gate ----
  console.log("");
  console.log("== the gate ==");
  const hasSplit = typeof assistant.systemBriefing === "function" && typeof assistant.turnBriefing === "function";
  check(
    "the standing briefing is sent as system text, not appended to the thread",
    hasSplit && rows.every((r) => r.system > 0 && !r.hasRules),
    hasSplit ? `${fmt(avgSystem)} B per turn as instructions` : "no system block on this tree: the whole briefing is appended",
  );
  check(
    "the per-turn input is the queue digest with the question, not the standing text",
    rows.every((r) => !r.hasRules),
    rows.some((r) => r.hasRules) ? "the standing rules are still in the user message" : "the standing rules ride in the system block",
  );
  check(
    "the turn's appended input is under half the briefing it used to carry",
    avgAppended * 2 < fullBriefing,
    `${fmt(avgAppended)} B of ${fmt(fullBriefing)} B (${((avgAppended / fullBriefing) * 100).toFixed(1)}%)`,
  );
  const digestWakes = rows.filter((r) => r.hasDigest).length;
  check("the queue digest is gated to one wake in two", digestWakes === 4, `${digestWakes} of ${rows.length} wakes carry it`);
  const full = rows[0];
  check("the first turn of a session still carries the whole standing briefing", full.system > 0 && full.appended > 0, `${fmt(full.system)} B system + ${fmt(full.appended)} B turn`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.exit(failures ? 1 : 0);
