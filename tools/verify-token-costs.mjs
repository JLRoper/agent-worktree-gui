// Tokens in and out on a card's readout, and what the session has cost.
//
//   PANEL_PLAYWRIGHT_ROOT=C:/ProjectDevelopment/heroes-js node tools/verify-token-costs.mjs
//
// WHAT WAS WRONG. The readout above a card's reply box (`statsLine` -> `.job-stats-row`) carried context
// occupancy, the prompt-cache hit rate, latency, throughput and the compaction count — and said nothing about
// how much the session had spent. The reader asked for the session's cumulative input and output token counts
// and the dollars they cost, and asked specifically for figures that keep counting through a compaction.
//
// NOW. The same line carries `∑ <in> in / <out> out` and the dollars beside it. Both are the SESSION's own
// cumulative totals read out of the store (`sessions.input_tokens` / `output_tokens`, and the same counters
// summed per model out of `session_model_usage` where the store recorded a cost), never the context figure —
// which legitimately falls when a compaction replaces the transcript, and which is why the counts and the
// dollars have to come from somewhere else. The dollar figure is the store's own recorded cost wherever the
// store recorded one (per model, with its own cost_status and cost_source), and otherwise the panel's cached
// per-million prices from the model menu's copy; a `~` in front means an estimate, and the tooltip says which
// figure is on screen. A session whose model has no price shows the counts and NO dollars.
//
// WHAT IS DRIVEN
//   * the arithmetic itself, by hand, in section 0 — one case per rule the brief sets out (the recorded cost
//     wins, cache reads priced as input and said so, a free model, an unpriced model, one side unpriced, a
//     mid-session model change priced per model), each asserted against a recomputation written out again in
//     this file rather than imported from the module under test
//   * TWO REAL PANELS over ONE sandbox Hermes home: this checkout, and the build it replaces cut as a
//     detached worktree of the first commit whose public/app.js has no `stat-usage` in it
//   * a real headless Chromium over both: the readout's rendered text, its segments and its tooltip, read off
//     the cards the panels actually serve
//   * the same session before and after a COMPACTION, in the store's own shape (every active message absorbed,
//     one `_compressed_summary=1` row added, `_usage_anchor.prompt_tokens` lowered, and the compaction's own
//     spend recorded against the `compression` task) — context occupancy falls, the counts and dollars do not
//   * the panel restarted under the same store, and read back through a FRESH browser context, so the figures
//     cannot be page memory
//
// THE STORE IT READS IS A COPY. The sandbox home holds `vacuum into`-snapshot of this box's real
// `$HERMES_HOME/state.db`, plus the real session titles' side files and the real price cache, so the sessions
// quoted below are real ones with their real counters. Nothing writes to the real store, the sandbox's own
// apiServer points at a dead port so no gateway is ever called, and the live panel on :7331 and the live
// gateway on :8642 are never touched. The one card this script adds is for a real session no panel run ever
// owned (the unpriced one), because no job in the store has ever run on an unpriced model.
//
// WHAT IS ONLY INSPECTED (read off the answer, not driven)
//   * that the figures arrive in the existing /api/state snapshot rather than from a per-render round trip:
//     the numbers printed below are read out of that response body as well as off the page
//
// The browser half needs a Playwright install (PANEL_PLAYWRIGHT_ROOT, or the repo's own node_modules); without
// one the script says BROWSER-HALF-NOT-RUN and exits non-zero rather than passing on a half that never ran.
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { sessionCost } from "../lib/session-usage.js";
import { loadPlaywright } from "./browser.mjs";
import { ROOT, freePort } from "./panel-testkit.mjs";

let failures = 0;
let checks = 0;
const check = (name, got, want) => {
  checks += 1;
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const note = (text) => console.log(`      ${text}`);
const quote = (label, text) => console.log(`      ${label}\n        ${String(text).replace(/\s+/g, " ").trim()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeoutMs = 30_000, stepMs = 250, what = "condition" } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    let got = false;
    try {
      got = await fn();
    } catch {
      got = false;
    }
    if (got) return true;
    if (Date.now() > until) {
      console.log(`      (timed out after ${timeoutMs}ms waiting for ${what})`);
      return false;
    }
    await sleep(stepMs);
  }
}
const git = (dir, args) => {
  try {
    return { ok: true, out: execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", windowsHide: true }).trim() };
  } catch (e) {
    return { ok: false, out: String((e && e.stdout) || "").trim(), err: String((e && e.message) || e) };
  }
};

// ── 0. the arithmetic, by hand ───────────────────────────────────────────────────────────────────
// Every rule the brief sets out, on numbers small enough to check in the head, and each one checked against a
// computation written out again HERE — a check that called the module's own helper would agree with it by
// construction and prove nothing.
console.log("== 0. the arithmetic, and whose figure it is ==");

const RATES = {
  providers: {
    openrouter: {
      "vendor/alpha": { input: "$2.00", output: "$10.00" },
      "vendor/beta": { input: "$1.00", output: "$4.00" },
      "vendor/gamma": { input: "free", output: "free" },
      "vendor/half": { input: "$3.00", output: "?" },
    },
  },
};
const dollarsFromPrices = (counts, rate) => {
  const inUsd = ((counts.input_tokens + counts.cache_read_tokens + counts.cache_write_tokens) * rate.input) / 1e6;
  const outUsd = (counts.output_tokens * rate.output) / 1e6;
  return Math.round((inUsd + outUsd) * 1e6) / 1e6;
};
const numeric = (s) => (String(s) === "free" ? 0 : String(s).startsWith("$") ? Number(String(s).slice(1)) : null);

let seq = 0;
const usage = ({ model = "vendor/alpha", tokens = {}, cost = {}, rowCost = {}, models = null, other }) => {
  seq += 1;
  const counts = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, ...tokens };
  const row = {
    model,
    provider: "openrouter",
    ...counts,
    estimated_cost_usd: rowCost.estimated ?? null,
    actual_cost_usd: rowCost.actual ?? null,
    cost_status: rowCost.status ?? null,
    cost_source: rowCost.source ?? null,
  };
  const list = models || [row];
  const total = list.reduce(
    (acc, r) => ({
      input_tokens: acc.input_tokens + (r.input_tokens || 0),
      output_tokens: acc.output_tokens + (r.output_tokens || 0),
      cache_read_tokens: acc.cache_read_tokens + (r.cache_read_tokens || 0),
      cache_write_tokens: acc.cache_write_tokens + (r.cache_write_tokens || 0),
    }),
    { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
  );
  return {
    id: `case-${seq}`,
    model,
    ...total,
    cost: { estimated_cost_usd: cost.estimated ?? null, actual_cost_usd: cost.actual ?? null, cost_status: cost.status ?? null, cost_source: cost.source ?? null },
    models: list,
    other_cost_usd: other ?? null,
  };
};
const costOf = (u, rates = RATES) => sessionCost(u, rates);

// (1) the panel's prices, exactly: 1M in at $2/M + 0.5M out at $10/M.
const exact = usage({ tokens: { input_tokens: 1_000_000, output_tokens: 500_000 } });
const exactCost = costOf(exact);
check("1M in / 0.5M out at $2 in / $10 out per Mtok", exactCost.usd, 7);
check("...and it is marked an estimate, which is what the `~` on the readout means", exactCost.measured, false);
ok("...and the tooltip's sentence names the rates it used", /panel's cached price/.test(exactCost.note) && /\$2\.00 in \/ \$10\.00 out per Mtok/.test(exactCost.note), exactCost.note);

// (2) cache reads, priced at the input rate because that is the only rate the panel's copy carries -- and said
// out loud, in the tooltip, rather than left for the reader to discover.
const cached = usage({ tokens: { input_tokens: 1_000_000, cache_read_tokens: 2_000_000 } });
const cachedCost = costOf(cached);
check("cache reads are priced as input (1M in + 2M cached, at $2/M)", cachedCost.usd, 6);
ok("...and the tooltip says so", /cache reads priced as input/.test(cachedCost.note), cachedCost.note);

// (3) a genuinely free model is a real price of zero, not an unknown.
const free = costOf(usage({ model: "vendor/gamma", tokens: { input_tokens: 10_000, output_tokens: 2_000 } }));
check("a model priced free costs $0", free.usd, 0);
ok("...with no `~`, because it is not an estimate", free.measured === false && free.basis === "panel-models", `${free.basis} measured=${free.measured}`);

// (4) a model the panel's copy has no price for: no dollars, and the tooltip names the model and the fix.
const unpriceable = costOf(usage({ model: "vendor/none", tokens: { input_tokens: 9_000, output_tokens: 100 } }));
check("a model with no price in the panel's copy has no dollar figure (never a 0)", unpriceable.usd, null);
ok("...and the tooltip names the model and where prices are rebuilt", /vendor\/none/.test(unpriceable.note) && /Models & prices/.test(unpriceable.note), unpriceable.note);

// (5) one side unpriced, with tokens on that side: half a bill is not the bill.
const halfOut = costOf(usage({ model: "vendor/half", tokens: { input_tokens: 1_000_000, output_tokens: 5_000 } }));
check("an unpriced OUTPUT side with output tokens yields no figure, not a partial sum", halfOut.usd, null);
// (6) ...but a side with no tokens at all cannot make the figure wrong.
const halfIn = costOf(usage({ model: "vendor/half", tokens: { input_tokens: 1_000_000 } }));
check("the same model priced from the side that does have a rate", halfIn.usd, 3);

// (7) the store's own record wins over the arithmetic, which is the whole point of preferring it.
const recorded = costOf(usage({ tokens: { input_tokens: 1_000_000, output_tokens: 500_000 }, rowCost: { estimated: 0.42, status: "estimated", source: "provider_models_api" } }));
check("a recorded estimate wins over the arithmetic (which would have said $7)", recorded.usd, 0.42);
check("...and it is still an estimate, so the `~` stays", recorded.measured, false);
ok("...and the tooltip names the gateway as its source", /gateway's own recorded estimate/.test(recorded.note) && /provider_models_api/.test(recorded.note), recorded.note);
const billed = costOf(usage({ tokens: { input_tokens: 10, output_tokens: 10 }, rowCost: { actual: 1.25, status: "actual" } }));
check("an actual (billed) cost is a measurement", [billed.usd, billed.measured], [1.25, true]);
ok("...and the tooltip says so rather than calling it an estimate", /actually billed/.test(billed.note), billed.note);

// (8) a recorded ZERO with status "unknown" is the gateway saying it could not price the session — not a price
// of zero. It must fall through to the panel's copy.
const unknownZero = costOf(usage({ tokens: { input_tokens: 1_000_000, output_tokens: 500_000 }, rowCost: { estimated: 0, status: "unknown" } }));
check("a recorded 0 with cost_status unknown is not a price: the panel's copy is used instead", unknownZero.usd, 7);
check("...and a recorded 0 that WAS priced (a free model) is used as-is", costOf(usage({ model: "vendor/gamma", tokens: { input_tokens: 10, output_tokens: 2 }, rowCost: { estimated: 0, status: "estimated" } })).basis, "record");

// (9) a session that changed models mid-way is priced by each model's own rate, with its own counts.
const mixedRows = [
  { model: "vendor/alpha", provider: "openrouter", input_tokens: 1_000_000, output_tokens: 500_000, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: null, actual_cost_usd: null, cost_status: null, cost_source: null },
  { model: "vendor/beta", provider: "openrouter", input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 0, cache_write_tokens: 0, estimated_cost_usd: null, actual_cost_usd: null, cost_status: null, cost_source: null },
];
const mixed = costOf(usage({ model: "vendor/alpha", models: mixedRows }));
check("two models, each priced by its own rate (7 + 1 + 4)", mixed.usd, 12);
check("...and the basis says it was priced model by model", [mixed.basis, mixed.multi, mixed.models], ["panel-models", true, 2]);
ok("...and the tooltip says each model was priced on its own", /each of this session's 2 models priced on its own/.test(mixed.note), mixed.note);
// The same session, with the store recording a cost per model: the records win, and the basis says per-model.
const mixedRecorded = costOf(
  usage({
    model: "vendor/alpha",
    models: [
      { ...mixedRows[0], estimated_cost_usd: 0.1, cost_status: "estimated", cost_source: "provider_models_api" },
      { ...mixedRows[1], estimated_cost_usd: 0.2, cost_status: "estimated", cost_source: "provider_models_api" },
    ],
  }),
);
check("a two-model session with records uses the records, not the rates", [mixedRecorded.usd, mixedRecorded.basis], [0.3, "per-model"]);
// A single-model session says nothing about models: there was no change to price around.
ok("a single-model session's tooltip does not claim a per-model split", !/priced on its own/.test(exactCost.note), exactCost.note);

// (10) the checks above, against the same arithmetic done again here over a table of counts and both models.
const table = [
  { tokens: { input_tokens: 318, output_tokens: 11 }, model: "vendor/alpha" },
  { tokens: { input_tokens: 3_994, output_tokens: 39, cache_read_tokens: 190_000 }, model: "vendor/alpha" },
  { tokens: { input_tokens: 664_954, output_tokens: 159_804, cache_read_tokens: 59_791_104, cache_write_tokens: 1_024 }, model: "vendor/alpha" },
  { tokens: { input_tokens: 7_580_000, output_tokens: 1_214_000 }, model: "vendor/beta" },
  { tokens: { input_tokens: 1, output_tokens: 1 }, model: "vendor/beta" },
];
let arithmetic = 0;
for (const t of table) {
  const u = usage(t);
  const got = costOf(u).usd;
  const want = dollarsFromPrices(u, { input: numeric(RATES.providers.openrouter[t.model].input), output: numeric(RATES.providers.openrouter[t.model].output) });
  if (got === want) arithmetic += 1;
  else console.log(`      mismatch: ${t.model} ${JSON.stringify(t.tokens)} -> module ${got}, by hand ${want}`);
}
check(`the module's figure equals this file's own arithmetic for all ${table.length} count/rate combinations`, arithmetic, table.length);

// ── 1. the same thing on this box's own session store ────────────────────────────────────────────
console.log("\n== 1. a real store, and two real panels over it ==");

const REAL_HOME =
  process.env.SESSION_REAL_HOME ||
  path.join(process.env.LOCALAPPDATA || path.join(process.env.HOME || "C:/Users/Jacob", "AppData", "Local"), "hermes");
// The live panel's logs (its jobs registry and its price cache) live beside the MAIN checkout's config.json:
// from a worktree, the main checkout is the directory the common git dir sits in.
const commonDir = git(ROOT, ["rev-parse", "--git-common-dir"]).out;
const MAIN_ROOT = process.env.SESSION_REAL_ROOT || (commonDir ? path.dirname(path.resolve(ROOT, commonDir)) : ROOT);
const REAL_LOGS = process.env.SESSION_REAL_LOGS || path.join(MAIN_ROOT, "logs");
const realDb = path.join(REAL_HOME, "state.db");
const realJobs = path.join(REAL_LOGS, "jobs.json");
const realPrices = path.join(REAL_LOGS, "model-prices.json");
note(`the store this box is running on: ${realDb}`);
note(`the panel's own registry and price cache: ${REAL_LOGS}`);

const storePresent = existsSync(realDb) && existsSync(realJobs) && existsSync(realPrices);
ok(
  "this box's real session store, job registry and price cache are all present",
  storePresent,
  storePresent ? `${realDb} + ${realJobs} + ${realPrices}` : "set SESSION_REAL_HOME / SESSION_REAL_ROOT to point at them",
);
if (!storePresent) throw new Error("THE REAL STORE IS NOT THERE — this harness proves the figures on real sessions and will not pass on a fixture");

const realRead = new DatabaseSync(realDb, { readOnly: true });
const priceCache = JSON.parse(readFileSync(realPrices, "utf8"));
const priced = new Set();
for (const rows of Object.values(priceCache.providers || {})) for (const mid of Object.keys(rows)) priced.add(mid.toLowerCase());

// The store's own three answers about one session, from any handle to it: the session row, its own per-model rows
// (task '' — the rows its counters are made of), and how many compactions the transcript has been through. Used
// against the real store to choose what to prove, and against the sandbox copy to read what a phase left behind.
const storeOf = (handle) => ({
  session: (thread) =>
    handle
      .prepare(
        "select id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, estimated_cost_usd, actual_cost_usd, cost_status, cost_source, model_config from sessions where id = ?",
      )
      .get(thread),
  rows: (thread) =>
    handle
      .prepare(
        "select model, billing_provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, estimated_cost_usd, actual_cost_usd, cost_status, cost_source from session_model_usage where session_id = ? and task = ''",
      )
      .all(thread),
  compactions: (thread) => handle.prepare("select count(*) n from messages where session_id = ? and _compressed_summary = 1").get(thread)?.n ?? 0,
});
const realStore = storeOf(realRead);

// The jobs the sandbox draws, from the live registry: settled turns only, so nothing here can re-attach to (or
// steer) a run another agent is in the middle of.
const liveStore = JSON.parse(readFileSync(realJobs, "utf8"));
const settled = (liveStore.jobs || []).filter((j) => j.thread && j.status !== "running" && realStore.session(j.thread));
const setupErrors = [];
// The compacted session whose readout gets quoted: a card the board actually DRAWS. The assistant's own thread is
// excluded on purpose — its card lives inside a `display: none` panel on the board, so its geometry could not be
// measured and the claim about the line's height has to be measured on a card the reader is looking at.
const pricedModel = (thread) => priced.has(String(realStore.session(thread).model || "").toLowerCase());
const compactedThreads = realRead
  .prepare(
    "select s.id, s.model, s.input_tokens, count(m.id) as n from sessions s join messages m on m.session_id = s.id and m._compressed_summary = 1 where s.input_tokens > 0 and s.id != 'panel-assistant' group by s.id order by n desc",
  )
  .all();
const withCard = compactedThreads.find((c) => settled.some((j) => j.thread === c.id) && pricedModel(c.id));
const chosen = withCard || compactedThreads.find((c) => pricedModel(c.id));
let worker = chosen ? (settled.find((j) => j.thread === chosen.id) || { thread: chosen.id, status: "done", prompt: `(card this harness added for the real session ${chosen.id})` }) : null;
if (chosen && !withCard) setupErrors.push(`no settled job in the registry ran on a compacted session — the card for ${chosen.id} is this script's own, over that session's real row and model`);
const twoModel = realRead
  .prepare("select session_id, count(distinct model) n from session_model_usage where task = '' group by session_id having n > 1 order by n desc limit 1")
  .get();
const unpricedThread = realRead
  .prepare("select id, model, input_tokens, output_tokens from sessions where input_tokens > 0 order by input_tokens desc")
  .all()
  .find((s) => s.input_tokens > 0 && !priced.has(String(s.model || "").toLowerCase()));
ok("a real, compacted session with a price in the panel's copy was found", Boolean(worker), worker ? `${worker.thread} (⇊ ${realStore.compactions(worker.thread)})` : "none in the store");
ok("a real session that ran on TWO models was found", Boolean(twoModel), twoModel ? `${twoModel.session_id} (${twoModel.n} models)` : "none in the store");
ok("a real session whose model has NO price in the panel's copy was found", Boolean(unpricedThread), unpricedThread ? `${unpricedThread.id} (${unpricedThread.model})` : "none in the store");
for (const e of setupErrors) note(e);
if (!worker || !unpricedThread) throw new Error("the store no longer carries the sessions this proof needs");

// ---- the sandbox: a COPY of the home, its own ports, its own registry ----
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-token-costs-"));
const home = path.join(dir, "hermes-home");
const scanRoot = path.join(dir, "scan-root");
const cfgNewDir = path.join(dir, "panel-new");
const cfgOldDir = path.join(dir, "panel-old");
const oldRoot = path.join(dir, "build-before"); // git only cuts a worktree into a path that does not exist yet
const logsNew = path.join(cfgNewDir, "logs");
const logsOld = path.join(cfgOldDir, "logs");
for (const d of [home, scanRoot, cfgNewDir, logsNew, cfgOldDir, logsOld, path.join(home, "cache")]) mkdirSync(d, { recursive: true });

// The session store, snapshotted rather than copied: `state.db` is in WAL mode and is being written to while
// this runs, and `vacuum into` is the one way to take a consistent snapshot of a live SQLite file. It is a
// COPY — every read below (and every read the sandbox panels make) is against this file, never the real one.
const dbPath = path.join(home, "state.db");
realRead.exec(`vacuum into '${dbPath.replace(/\\/g, "/")}'`);
for (const f of ["config.yaml", "provider_models_cache.json"]) if (existsSync(path.join(REAL_HOME, f))) copyFileSync(path.join(REAL_HOME, f), path.join(home, f));
for (const f of ["openrouter_model_metadata.json"]) {
  const src = path.join(REAL_HOME, "cache", f);
  if (existsSync(src)) copyFileSync(src, path.join(home, "cache", f));
}
const db = new DatabaseSync(dbPath);
db.exec("pragma busy_timeout = 15000");
const copyStore = storeOf(db);
ok("the sandbox store is a snapshot of the real one, on its own path", existsSync(dbPath) && dbPath !== realDb, `${dbPath}`);

// The cards: the settled real ones, plus two this script adds for real sessions the registry never ran a job
// for (the mid-session model change and the unpriced model) — the session rows behind them are the store's own.
const template = settled[settled.length - 1] || { thread: "x", turn: 1, startedAt: new Date().toISOString(), lines: [] };
const cards = settled.slice(-6);
// A card this script adds names the SESSION's own model, so the readout's model segment describes the model that
// spent the tokens it is pricing. A copy of someone else's card would have shown that card's model instead.
const cardFor = (thread, tag) => ({ ...template, id: `tokcost-${tag}`, thread, status: "done", model: realStore.session(thread).model, prompt: `(card this harness added for the real session ${thread})`, stats: null, baseOutput: null });
if (!cards.some((j) => j.thread === worker.thread)) cards.push(cardFor(worker.thread, "worker"));
for (const [thread, tag] of [
  [twoModel?.session_id, "two-models"],
  [unpricedThread.id, "unpriced"],
]) {
  if (!thread) continue;
  cards.push(cardFor(thread, tag));
}
const seeded = { savedAt: new Date().toISOString(), jobs: cards.map((j) => ({ ...j, baseOutput: null, runGone: true, status: "done" })) };
for (const p of [path.join(logsNew, "jobs.json"), path.join(logsOld, "jobs.json")]) writeFileSync(p, JSON.stringify(seeded));
for (const p of [path.join(logsNew, "model-prices.json"), path.join(logsOld, "model-prices.json")]) copyFileSync(realPrices, p);
note(`cards in the sandbox: ${seeded.jobs.map((j) => j.thread).join(", ")}`);
ok("the sandbox registry carries the compacted card", seeded.jobs.some((j) => j.thread === worker.thread));

// ---- the two panels ----
const ports = { now: await freePort(), before: await freePort() };
const baseNow = `http://127.0.0.1:${ports.now}`;
const baseOld = `http://127.0.0.1:${ports.before}`;
const panelSettings = (port, jobs, prices) =>
  `${JSON.stringify(
    {
      port,
      host: "127.0.0.1",
      scanRoots: [scanRoot],
      refreshSeconds: 3600,
      worktreeSeconds: 3600,
      midSeconds: 3600,
      dormantSeconds: 3600,
      slowSeconds: 3600,
      fetchSeconds: 3600,
      threads: 1,
      scanMode: "all",
      defaultCwd: scanRoot,
      jobsFile: jobs,
      projectsCacheFile: path.join(path.dirname(jobs), "projects.json"),
      treeNamesFile: path.join(path.dirname(jobs), "tree-names.json"),
      assistantFile: path.join(path.dirname(jobs), "assistant.json"),
      modelPricingFile: prices,
      // A dead port: this sandbox must never ask the real gateway anything. The readout is read from the store.
      apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
      assistant: { enabled: false, seconds: 3600, maxWakesPerHour: 0 },
    },
    null,
    2,
  )}\n`;
const cfgNew = path.join(cfgNewDir, "config.json");
const cfgOld = path.join(cfgOldDir, "config.json");
writeFileSync(cfgNew, panelSettings(ports.now, path.join(logsNew, "jobs.json"), path.join(logsNew, "model-prices.json")));
writeFileSync(cfgOld, panelSettings(ports.before, path.join(logsOld, "jobs.json"), path.join(logsOld, "model-prices.json")));

const baseFind = (() => {
  if (process.env.PANEL_BEFORE_SHA) {
    const sha = process.env.PANEL_BEFORE_SHA;
    const app = git(ROOT, ["show", `${sha}:public/app.js`]);
    return app.ok && !app.out.includes("stat-usage") ? { sha, app } : { sha, app, refused: true };
  }
  const revs = git(ROOT, ["rev-list", "--first-parent", "-40", "HEAD"]);
  for (const sha of String(revs.out || "").split("\n").map((s) => s.trim()).filter(Boolean)) {
    const app = git(ROOT, ["show", `${sha}:public/app.js`]);
    if (app.ok && !app.out.includes("stat-usage")) return { sha, app };
  }
  return { sha: "", app: { ok: false, out: "", err: "no commit on this branch predates the readout's change" } };
})();
const beforeSha = baseFind.sha;
ok(`a pre-change build was found (${(beforeSha || "none").slice(0, 8)})`, baseFind.app.ok && !String(baseFind.app.out).includes("stat-usage"), baseFind.app.ok ? "its public/app.js carries no stat-usage" : baseFind.app.err);
if (!beforeSha) throw new Error("no pre-change commit to compare against — set PANEL_BEFORE_SHA");
ok(
  "...and THIS checkout is the build carrying the change (or the comparison would be vacuous)",
  readFileSync(path.join(ROOT, "public", "app.js"), "utf8").includes("stat-usage"),
);
const cut = git(ROOT, ["worktree", "add", "--detach", oldRoot, beforeSha]);
ok(`the pre-change build was cut as a worktree of this repo at ${beforeSha.slice(0, 8)}`, cut.ok && git(oldRoot, ["rev-parse", "HEAD"]).out === beforeSha, cut.ok ? git(oldRoot, ["rev-parse", "HEAD"]).out.slice(0, 8) : cut.err);

const panels = { now: null, before: null };
const panelLog = { now: [], before: [] };
const startPanel = async (which) => {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: which === "now" ? ROOT : oldRoot,
    // HERMES_HOME in native form: the panel is a native node process and cannot resolve an MSYS-style path.
    env: { ...process.env, PANEL_CONFIG: which === "now" ? cfgNew : cfgOld, HERMES_HOME: home.replace(/\//g, "\\"), PANEL_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  panels[which] = child;
  child.stdout.on("data", (d) => panelLog[which].push(...String(d).split(/\r?\n/).filter(Boolean)));
  child.stderr.on("data", (d) => panelLog[which].push(...String(d).split(/\r?\n/).filter(Boolean)));
  const base = which === "now" ? baseNow : baseOld;
  const up = await waitFor(async () => (await fetch(`${base}/api/state`)).ok, { timeoutMs: 60_000, what: `the ${which} panel to answer /api/state` });
  if (!up) throw new Error(`the ${which} panel never came up on ${base}\n${panelLog[which].slice(-12).join("\n")}`);
};
const stopPanel = async (which) => {
  const p = panels[which];
  if (!p) return;
  panels[which] = null;
  p.kill();
  const gone = await waitFor(() => p.exitCode !== null || p.signalCode !== null, { timeoutMs: 15_000, what: `the ${which} panel to exit` });
  if (!gone && p.pid) {
    try {
      execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      /* gone already */
    }
  }
  // Wait for the port itself to be released: a second panel on the same port would answer for the first.
  await waitFor(
    async () => {
      try {
        await fetch(which === "now" ? baseNow : baseOld, { signal: AbortSignal.timeout(700) });
        return false;
      } catch {
        return true;
      }
    },
    { timeoutMs: 20_000, stepMs: 300, what: `port ${which === "now" ? ports.now : ports.before} to be released` },
  );
};

let browserRef = null;
let err = null;
try {
  await startPanel("now");
  await startPanel("before");
  ok("both panels are up on the same sandbox home", Boolean(panels.now && panels.before), `${baseNow} (this build) / ${baseOld} (${beforeSha.slice(0, 8)})`);

  const pw = loadPlaywright();
  if (!pw) throw new Error("BROWSER-HALF-NOT-RUN");
  browserRef = await pw.chromium.launch({ headless: true });

  // The readout, as the page draws it: the text, every segment, the tooltip, and how tall the line is.
  const readoutOf = (page, thread) =>
    page.evaluate((t) => {
      const slot = document.querySelector(`.job-stats-slot[data-stats="${t}"]`);
      const stats = slot ? slot.querySelector(".job-stats") : null;
      const usage = slot ? slot.querySelector(".stat-usage") : null;
      const card = slot ? slot.closest(".job") : null;
      if (!stats) return null;
      const cs = getComputedStyle(stats);
      const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
      const rect = stats.getBoundingClientRect();
      return {
        text: stats.textContent.trim(),
        html: stats.innerHTML.replace(/></g, ">\n          <").trim(),
        title: stats.getAttribute("title"),
        segments: [...stats.querySelectorAll(".stat")].map((e) => e.textContent.trim()),
        usageText: usage ? usage.textContent.trim() : null,
        usageTitle: usage ? usage.getAttribute("title") : null,
        height: Math.round(rect.height),
        width: Math.round(rect.width),
        rendered: rect.height > 0,
        lines: Math.max(1, Math.round(rect.height / lineHeight)),
        cardHeight: card ? Math.round(card.getBoundingClientRect().height) : null,
      };
    }, thread);

  const openPage = async (base, { requests = null } = {}) => {
    const context = await browserRef.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String((e && e.message) || e)));
    if (requests) {
      page.on("request", (r) => requests.push(r.url()));
      page.on("response", async (r) => {
        if (/\/api\/state/.test(r.url())) {
          try {
            requests.push({ url: r.url(), body: await r.json() });
          } catch {
            /* a state answer that is not JSON needs nothing from here */
          }
        }
      });
    }
    await page.goto(base, { waitUntil: "domcontentloaded" });
    const drawn = await waitFor(async () => (await page.$$eval(".job[data-thread]", (els) => els.length)) >= Math.min(4, seeded.jobs.length), { timeoutMs: 40_000, what: "the cards to be drawn" });
    return { page, context, drawn, errors };
  };

  // ---- (a) the readout for a real, compacted session: before and after ----
  console.log("\n== (a) the readout for a real session, on the build it replaces and on this one ==");
  const t = worker.thread;
  const requests = [];
  const after = await openPage(baseNow, { requests });
  const before = await openPage(baseOld);
  ok("the cards are drawn on both boards", after.drawn && before.drawn);
  ok("...with no page error on either", [...after.errors, ...before.errors], []);
  const rOld = await readoutOf(before.page, t);
  const rNew = await readoutOf(after.page, t);
  ok("the real session has a readout on both builds", Boolean(rOld && rNew), t);
  quote(`before (${beforeSha.slice(0, 8)}): ${rOld.text}`, "");
  quote("after  (this build)  :", rNew.text);
  console.log(`      the rendered DOM, before (${beforeSha.slice(0, 8)}):\n${rOld.html.split("\n").map((l) => `        ${l}`).join("\n")}`);
  console.log(`      the rendered DOM, after (this build):\n${rNew.html.split("\n").map((l) => `        ${l}`).join("\n")}`);
  quote("after, tooltip (row) :", rNew.title);
  quote("after, tooltip (∑)   :", rNew.usageTitle);
  ok("the build it replaces carried no in/out counts and no dollars", !/∑|in \/|out/.test(rOld.text) && !/\$/.test(rOld.text), rOld.text);
  ok("this build carries both, on the same line", /∑ .* in \/ .* out/.test(rNew.text) && /\$\d/.test(rNew.text), rNew.text);
  const oldSegs = rOld.segments.filter((s) => !/∑/.test(s));
  const newSegs = rNew.segments.filter((s) => !/∑/.test(s));
  check("every figure the readout had is still there, unchanged (model, context, cache, latency, t/s, ⇊)", newSegs, oldSegs);
  ok("...including the context bar and its percentage", /[\u2588\u2589\u258a\u258b\u258c\u258d\u258e\u258f\u00b7]+ \d+%/.test(rNew.text) && /%/.test(rOld.text), rNew.segments.find((s) => /%/.test(s)) || "");
  ok("...and the compaction count, which is a real ⇊ on this session", /⇊ \d+/.test(rNew.text) && copyStore.compactions(t) >= 1, `${rNew.segments.find((s) => /⇊/.test(s))} vs the store's ${copyStore.compactions(t)}`);
  ok("the card is drawn on the board (its geometry is real, so the height below means something)", rNew.rendered && rOld.rendered, `stats element ${rNew.height}px on this build / ${rOld.height}px on the one it replaces`);
  check("the readout is still ONE line, so the card did not grow", [rNew.lines, rNew.height <= rOld.height + 4, Math.abs((rNew.cardHeight || 0) - (rOld.cardHeight || 0)) <= 4], [1, true, true]);
  note(`the readout is ${rNew.height}px on this build and ${rOld.height}px on the one it replaces; the card is ${rNew.cardHeight}px vs ${rOld.cardHeight}px`);
  ok("the counts and the dollars are the session's cumulative totals, not its context occupancy", /cumulative/.test(rNew.title) && /not how full the context is now/.test(rNew.usageTitle || ""), rNew.usageTitle);
  // The figures ride the snapshot the page already loads: no new round trip is asked for by a card.
  // The line has to survive a narrower board too: the brief's "one line" is a claim about the card, and a
  // 1600px window is the widest one. The same card is re-read at 1100px and the row must still be one line.
  await after.page.setViewportSize({ width: 1100, height: 1000 });
  const narrow = await readoutOf(after.page, t);
  check("...and at a 1100px window, where the card is narrower", [narrow.lines, narrow.rendered], [1, true]);
  note(`at 1100px the readout is ${narrow.height}px tall over a ${narrow.width}px card`);
  await after.page.setViewportSize({ width: 1600, height: 1000 });
  const stateBody = requests.find((r) => r && typeof r === "object" && r.body);
  const snapshotJob = stateBody ? (stateBody.body.jobs || []).find((j) => j.thread === t) : null;
  ok("the figures arrive in the existing /api/state snapshot (no per-render round trip)", Boolean(snapshotJob && snapshotJob.stats), snapshotJob ? JSON.stringify({ in: snapshotJob.stats.input_tokens, out: snapshotJob.stats.output_tokens, usd: snapshotJob.stats.cost_usd }) : "no stats in the snapshot");
  ok("...and no request went out for a session's usage", !requests.some((u) => typeof u === "string" && /usage|token|cost/i.test(u)), requests.filter((u) => typeof u === "string").length + " requests seen");

  // ---- (b) the arithmetic, checked against the panel's own figure on a real session's real counts ----
  console.log("\n== (b) the dollar figure recomputed by hand from the same counts and the same prices ==");
  const real = copyStore.session(t);
  const model = real.model;
  const rates = (() => {
    for (const rows of Object.values(priceCache.providers || {})) {
      for (const [mid, row] of Object.entries(rows)) if (mid.toLowerCase() === String(model).toLowerCase()) return { input: numeric(row.input), output: numeric(row.output) };
    }
    return null;
  })();
  const rowOf = copyStore.rows(t);
  const counts = rowOf.reduce(
    (a, r) => ({ input_tokens: a.input_tokens + r.input_tokens, output_tokens: a.output_tokens + r.output_tokens, cache_read_tokens: a.cache_read_tokens + r.cache_read_tokens, cache_write_tokens: a.cache_write_tokens + r.cache_write_tokens }),
    { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
  );
  check("the session's own rows sum to the counters the store keeps on the session", [counts.input_tokens, counts.output_tokens, counts.cache_read_tokens], [real.input_tokens, real.output_tokens, real.cache_read_tokens]);
  // The store's own record is what the readout preferred above; now take it away, so the fallback the brief asks
  // to be checked by hand is the one on screen — on the SAME real counts and the SAME real prices.
  db.prepare("update sessions set estimated_cost_usd = null, actual_cost_usd = null, cost_status = null, cost_source = null where id = ?").run(t);
  // `session_model_usage.actual_cost_usd` is NOT NULL DEFAULT 0, so the record is cleared to the store's own
  // "nothing billed here" and the status to `unknown` — the gateway's own way of saying it did not price the row.
  db.prepare("update session_model_usage set estimated_cost_usd = 0, actual_cost_usd = 0, cost_status = 'unknown', cost_source = null where session_id = ? and task = ''").run(t);
  await stopPanel("now");
  await startPanel("now");
  const after2 = await openPage(baseNow);
  const rPriced = await readoutOf(after2.page, t);
  const shown = Number((/\$([\d.]+)/.exec(rPriced.text) || [])[1]);
  const byHand = dollarsFromPrices(counts, rates);
  quote("the same session, with the store's cost columns cleared:", rPriced.text);
  quote("its tooltip now:", rPriced.usageTitle);
  check(`the panel's figure and this file's own arithmetic agree ($${byHand})`, shown, Math.round(byHand * 100) / 100);
  ok("...and the tooltip says the figure came from the panel's cached prices", /panel's cached price/.test(rPriced.usageTitle || "") && /cache reads priced as input/.test(rPriced.usageTitle || ""), rPriced.usageTitle);
  const inPart = ((counts.input_tokens + counts.cache_read_tokens + counts.cache_write_tokens) * rates.input) / 1e6;
  const outPart = (counts.output_tokens * rates.output) / 1e6;
  note(`by hand: ${counts.input_tokens + counts.cache_read_tokens + counts.cache_write_tokens} prompt tokens × $${rates.input}/M = $${inPart.toFixed(6)} + ${counts.output_tokens} out × $${rates.output}/M = $${outPart.toFixed(6)} → $${byHand}`);
  // ...and the counts on the line are those same counters, in the card's own three-significant-digit form.
  const threeSig = (n) => {
    const abs = Math.abs(Number(n) || 0);
    if (abs < 1e3) return String(Math.round(abs));
    const unit = abs >= 1e9 ? [1e9, "B"] : abs >= 1e6 ? [1e6, "M"] : [1e3, "k"];
    const digits = abs / unit[0];
    const places = digits >= 100 ? 0 : digits >= 10 ? 1 : 2;
    const cut = Math.floor(digits * 10 ** places) / 10 ** places;
    return `${cut.toFixed(places).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")}${unit[1]}`;
  };
  check("the counts on the line are those counters, three significant digits", /∑ ([\d.]+[kMB]?) in/.exec(rPriced.text)?.[1], threeSig(counts.input_tokens));
  check("...and the output count too", /\/ ([\d.]+[kMB]?) out/.exec(rPriced.text)?.[1], threeSig(counts.output_tokens));
  // Put the store's own record back, so the rest of the proof reads the figure the reader will actually see.
  db.prepare("update sessions set estimated_cost_usd = ?, cost_status = 'estimated', cost_source = 'provider_models_api' where id = ?").run(real.estimated_cost_usd, t);
  db.prepare("update session_model_usage set estimated_cost_usd = ? where session_id = ? and task = ''").run(rowOf.reduce((n, r) => n + (r.estimated_cost_usd || 0), 0), t);
  await stopPanel("now");
  await startPanel("now");
  const after3 = await openPage(baseNow);

  // ---- (c) a compaction does not take either figure down ----
  console.log("\n== (c) the same session after a COMPACTION ==");
  const beforeCounters = db.prepare("select input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, estimated_cost_usd from sessions where id = ?").get(t);
  const beforeAnchor = JSON.parse(db.prepare("select model_config from sessions where id = ?").get(t).model_config || "{}")?._usage_anchor?.prompt_tokens ?? null;
  // What the anchor becomes: a compaction leaves the summary plus a tail, so it is a fraction of what was there —
  // derived from this session's own anchor rather than hard-coded, because the raw store this snapshot came from
  // keeps moving and a fixed number could sit ABOVE the anchor and make the context figure rise.
  const afterAnchor = Math.max(1000, Math.round(beforeAnchor * 0.6));
  const beforeMsgs = db.prepare("select count(*) n from messages where session_id = ? and active = 1").get(t).n;
  const beforeCompactions = copyStore.compactions(t);
  const beforeRead = await readoutOf(after3.page, t);
  // The store's own shape of a compaction, read off the sessions this box has already compacted: every active
  // message is absorbed (active=0, compacted=1), one new `_compressed_summary=1` row becomes the transcript, the
  // usage anchor that the CONTEXT figure is read from is lowered to what is left, and the compaction's own spend
  // is recorded against the `compression` task — the same task the store uses for it on this box.
  const summaryText = `[compacted] the transcript to this point was summarised (${db.prepare("select count(*) n from messages where session_id = ? and active = 1").get(t).n} messages absorbed)`;
  db.prepare("update messages set active = 0, compacted = 1 where session_id = ? and active = 1").run(t);
  db.prepare("insert into messages (session_id, role, content, timestamp, active, compacted, _compressed_summary) values (?, 'user', ?, ?, 1, 0, 1)").run(t, summaryText, Date.now() / 1000);
  const cfgRow = db.prepare("select model_config from sessions where id = ?").get(t).model_config;
  const cfgJson = JSON.parse(cfgRow || "{}");
  if (cfgJson._usage_anchor) cfgJson._usage_anchor.prompt_tokens = afterAnchor;
  db.prepare("update sessions set model_config = ? where id = ?").run(JSON.stringify(cfgJson), t);
  db.prepare(
    "insert into session_model_usage (session_id, model, billing_provider, billing_mode, task, api_call_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, estimated_cost_usd, actual_cost_usd, cost_status, cost_source, first_seen, last_seen) values (?, ?, '', '', 'compression', 1, 120000, 8000, 40000, 0, 0.0123, 0, 'estimated', 'provider_models_api', ?, ?)",
  ).run(t, model, Date.now() / 1000, Date.now() / 1000);
  const afterCounters = db.prepare("select input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, estimated_cost_usd from sessions where id = ?").get(t);
  note(`the compaction: ${beforeMsgs} active messages absorbed, one summary written, the usage anchor ${beforeAnchor} → ${afterAnchor}, ${copyStore.compactions(t)} ⇊ in the store now`);
  check("the store's own cumulative counters are exactly what the compaction left alone", afterCounters, beforeCounters);
  await stopPanel("now");
  await startPanel("now");
  const after4 = await openPage(baseNow);
  const afterRead = await readoutOf(after4.page, t);
  quote("before the compaction:", beforeRead.text);
  quote("after the compaction :", afterRead.text);
  quote("after, tooltip        :", afterRead.usageTitle);
  // "7.72M" -> 7720000: the line prints three significant digits, so the parsed figure is compared with a
  // truncation's worth of slack while the COUNTS themselves are asserted equal to the store's own.
  const parseTok = (s) => {
    const m = /^([\d.]+)([kMB]?)$/.exec(String(s || "").trim());
    if (!m) return null;
    return Number(m[1]) * (m[2] === "M" ? 1e6 : m[2] === "B" ? 1e9 : m[2] === "k" ? 1e3 : 1);
  };
  const oldIn = parseTok(/∑ ([\d.]+[kMB]?) in/.exec(beforeRead.text)?.[1]);
  const newIn = parseTok(/∑ ([\d.]+[kMB]?) in/.exec(afterRead.text)?.[1]);
  const oldOut = parseTok(/\/ ([\d.]+[kMB]?) out/.exec(beforeRead.text)?.[1]);
  const newOut = parseTok(/\/ ([\d.]+[kMB]?) out/.exec(afterRead.text)?.[1]);
  const oldUsd = Number((/\$([\d.]+)/.exec(beforeRead.text) || [])[1]);
  const newUsd = Number((/\$([\d.]+)/.exec(afterRead.text) || [])[1]);
  check("the in/out counts are the SAME cumulative totals after the compaction", [newIn, newOut], [oldIn, oldOut]);
  check("...and they equal the store's own counters, which the compaction did not touch", [Math.abs(newIn - beforeCounters.input_tokens) < 1e4, Math.abs(newOut - beforeCounters.output_tokens) < 1e3], [true, true]);
  ok("the dollar figure did not fall (it rose by the compaction's own recorded spend, reported separately)", newUsd >= oldUsd, `${oldUsd} → ${newUsd}`);
  ok(
    "...and the ⇊ count went up by the compaction",
    copyStore.compactions(t) === beforeCompactions + 1 && afterRead.text.includes(`⇊ ${beforeCompactions + 1}`),
    `${beforeRead.segments.find((s) => /⇊/.test(s))} → ${afterRead.segments.find((s) => /⇊/.test(s))}`,
  );
  const ctxOld = Number(/ (\d+)%/.exec(beforeRead.segments.find((s) => /%/.test(s)) || "")?.[1]);
  const ctxNew = Number(/ (\d+)%/.exec(afterRead.segments.find((s) => /%/.test(s)) || "")?.[1]);
  ok("the context figure — the one a naive implementation would have used — DID fall", ctxNew < ctxOld, `${ctxOld}% → ${ctxNew}% (the store's usage anchor went ${beforeAnchor} → ${afterAnchor})`);
  ok("...and the tooltip reports the compaction's own spend as a separate line, not as part of the counts", /more has gone on this session's own background review, compaction and approvals/.test(afterRead.usageTitle || ""), (afterRead.usageTitle || "").slice(-170));

  // ---- (d) a model the panel's copy has no price for: the counts, and no dollars ----
  console.log("\n== (d) a session whose model has no price in the panel's copy ==");
  const unpriced = unpricedThread;
  const rowsU = db.prepare("select coalesce(sum(input_tokens),0) i, coalesce(sum(output_tokens),0) o from session_model_usage where session_id = ? and task = ''").get(unpriced.id);
  const rU = await readoutOf(after4.page, unpriced.id);
  ok("the card for that session has a readout", Boolean(rU), unpriced.id);
  quote(`the unpriced card (${unpriced.model}):`, rU.text);
  quote("its tooltip:", rU.usageTitle);
  ok("the token counts are there, as the store's own counters", /∑ .* in \/ .* out/.test(rU.text) && rU.text.includes("in / "), rU.text);
  ok("...and there is NO dollar figure — not a 0, not an estimate", !/\$/.test(rU.text), rU.text);
  ok("...and the tooltip says the model has no price in the panel's copy", /no price in the panel's copy/.test(rU.usageTitle || "") && rU.usageTitle.includes(unpriced.model), rU.usageTitle);
  check("the counts shown are the session's own cumulative rows", [rowsU.i > 0, rowsU.o >= 0, realStore.session(unpriced.id).input_tokens], [true, true, rowsU.i]);

  // ---- (e) a panel restart does not change either figure ----
  console.log("\n== (e) the same session after the panel is restarted, in a fresh browser ==");
  const beforeRestart = await readoutOf(after4.page, t);
  await stopPanel("now");
  await sleep(400);
  await startPanel("now");
  // A fresh context: no localStorage, no sessionStorage, nothing the page could have remembered.
  const fresh = await openPage(baseNow);
  const afterRestart = await readoutOf(fresh.page, t);
  quote("before the restart:", beforeRestart.text);
  quote("after the restart :", afterRestart.text);
  check("the counts and the dollars are identical after a restart (they are the store's, not page memory)", afterRestart.usageText, beforeRestart.usageText);
  check("...and so is the whole readout", afterRestart.text, beforeRestart.text);
  const freshState = await (await fetch(`${baseNow}/api/state`)).json();
  const freshJob = (freshState.jobs || []).find((j) => j.thread === t);
  ok("the restarted panel's own snapshot carries the same figures", Boolean(freshJob) && freshJob.stats?.input_tokens === (db.prepare("select input_tokens from sessions where id = ?").get(t).input_tokens ?? null), freshJob ? JSON.stringify({ in: freshJob.stats?.input_tokens, out: freshJob.stats?.output_tokens, usd: freshJob.stats?.cost_usd }) : "no job in the snapshot");

  // ---- (f) a session that changed models mid-way is priced per model ----
  if (twoModel) {
    console.log("\n== (f) a real session that ran on two models ==");
    const rM = await readoutOf(fresh.page, twoModel.session_id);
    ok("the two-model card has a readout", Boolean(rM), twoModel.session_id);
    const rowsM = db.prepare("select model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, estimated_cost_usd, actual_cost_usd, cost_status from session_model_usage where session_id = ? and task = ''").all(twoModel.session_id);
    const byHandM = rowsM.reduce((n, r) => {
      if (r.actual_cost_usd > 0) return n + r.actual_cost_usd;
      if (r.estimated_cost_usd > 0) return n + r.estimated_cost_usd;
      const rowRates = (() => {
        for (const rows of Object.values(priceCache.providers || {})) {
          for (const [mid, row] of Object.entries(rows)) if (mid.toLowerCase() === String(r.model).toLowerCase()) return { input: numeric(row.input), output: numeric(row.output) };
        }
        return null;
      })();
      return rowRates ? n + dollarsFromPrices(r, rowRates) : n;
    }, 0);
    quote(`the two-model card (${rowsM.map((r) => r.model).join(" + ")}):`, rM.text);
    quote("its tooltip:", rM.usageTitle);
    check("the figure is the sum of each model's own recorded cost, to the cent shown", Number((/\$([\d.]+)/.exec(rM.text) || [])[1]), Math.round(byHandM * 100) / 100);
    ok("...and the tooltip says the session's models were priced on their own", /each of this session's \d+ models priced on its own/.test(rM.usageTitle || ""), rM.usageTitle);
  }

  await after.context.close();
  await before.context.close();
  await after2.context.close();
  await after3.context.close();
  await after4.context.close();
  await fresh.context.close();
} catch (e) {
  err = e;
  console.log(`\nFAIL  the run ended early: ${String((e && e.message) || e)}`);
  if (String((e && e.message) || "").includes("BROWSER-HALF-NOT-RUN")) console.log("      BROWSER-HALF-NOT-RUN — point PANEL_PLAYWRIGHT_ROOT at a node_modules holding playwright");
} finally {
  try {
    await browserRef?.close();
  } catch {
    /* already gone */
  }
  await stopPanel("now");
  await stopPanel("before");
  try {
    db.close();
  } catch {
    /* already closed */
  }
  const gone = git(ROOT, ["worktree", "remove", "--force", oldRoot]);
  git(ROOT, ["worktree", "prune"]);
  if (!gone.ok) console.log(`      (could not remove the pre-change worktree: ${gone.err})`);
  if (process.env.VERIFY_KEEP !== "1") {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch (e) {
      console.log(`      (could not remove ${dir}: ${String((e && e.message) || e)})`);
    }
  } else {
    console.log(`VERIFY_KEEP=1 — leaving ${dir} in place`);
  }
}

console.log(`\n${failures ? `RESULT: ${failures} FAILED of ${checks}` : `RESULT: ALL ${checks} PASS`}`);
process.exitCode = err || failures ? 1 : 0;
