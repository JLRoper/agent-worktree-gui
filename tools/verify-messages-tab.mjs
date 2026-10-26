// The Messages tab: the message board between the assistant and the agents.
//
//   node tools/verify-messages-tab.mjs
//   PANEL_PLAYWRIGHT_ROOT=C:/ProjectDevelopment/heroes-js node tools/verify-messages-tab.mjs
//
// The tab is a VIEW over records the panel already keeps, so the first thing that has to be true is that
// the view agrees with the records exactly: the same entries, in the same order, attributed to the same
// direction and the same kind. Everything below is one of those facts, and the counts are asserted rather
// than eyeballed:
//
//   (b) a fixture store and journal produce an exactly known number of entries (13 in fixture A, stated
//       below) — the module's count and the tab's rendered count must both be that number
//   (c) one thread carries a spawn, a wake, a reply, a parked question that was answered, the answer, and
//       a completed run: all six, each with its own direction and kind, and the two the reader's own
//       click started are attributed to the reader, not to the assistant's words
//   (d) an entry 8 days old is absent and one 6 days old is present — the boundary is computed from each
//       entry's own timestamp
//   (e) a long outbound message is truncated with a working expander, and a report path is copyable and
//       openable through the panel's own open
//   (f) a job the reader's own click started is never presented as the assistant's words
//   (g) the payload stays bounded with a large fixture, and the cap is stated in the UI when it bites
//   (h) the window is stated out loud, and an empty tab says it is empty of MESSAGES rather than of agents
//
// WHAT IS DRIVEN, AND WHAT IS ONLY INSPECTED
//
//   driven  the merge, against fabricated stores, with the counts asserted from the fixture (this is the
//           half that proves the view agrees with the records)
//   driven  three real panel instances on their own scratch ports, each with its own store: fixture A
//           (the conversation), fixture B (the large fixture, for the cap), and an empty one — read over
//           HTTP, and then driven in a real browser with real clicks
//   driven  the tab in the browser: the strip, the round trip away and back, the three chips, the
//           expander, the report path's open, the entry count, and the absence of the 8-day entry
//   inspected  the CSS (that the two directions are styled differently) — every direction assertion below
//           is on TEXT and on the accessibility label, so the colour is decoration and not the fact
//
// The live panel on 7331 is never touched: every instance here is its own port, its own store and its own
// throwaway HERMES_HOME. The browser half needs a Playwright install; without one the script says
// BROWSER-HALF-NOT-RUN and exits 2 rather than passing on a half that never ran.
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMessages, MESSAGE_CAP, MESSAGE_WINDOW_DAYS } from "../lib/assistant/messages.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const require = createRequire(import.meta.url);
const LIVE = String(process.env.PANEL_URL || "").replace(/\/+$/, "");

let failures = 0;
let checks = 0;
let browserRef = null;
const check = (name, got, want) => {
  checks += 1;
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (!same) failures += 1;
  console.log(`${same ? "PASS" : "FAIL"}  ${name}${same ? `: ${JSON.stringify(got)}` : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond, extra = "") => {
  checks += 1;
  if (cond) console.log(`PASS  ${name}${extra ? `: ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
};
const eq = check;
const note = (t) => console.log(`      ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// ---- fixture A: one conversation, exactly countable ----------------------------------------------
//
// Threads: the worker's (a spawn, a wake about it, a reply, a reply the READER sent, a parked question
// that was answered, and two finished turns), the assistant's own, and one that only the journal still
// knows. Nothing here is invented for the tab: every field is one the panel writes (lib/jobs.js,
// lib/assistant.js).
const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const THREAD = "wtgui-messages-demo-abc123";
const ASSISTANT = "panel-assistant";
const GONE = "wtgui-gone-999999";
const REPORT = "C:/dev/demo/.agentboard/settlers-reports/wtgui-messages-demo-abc123.md";
const LONG_PROMPT =
  "MESSAGES TAB, acceptance first. This outbound message is deliberately longer than the pane's reading " +
  "length so the expander has something to reveal: it is the brief a worker was handed, and the reader " +
  "needs to be able to read all of it without leaving the tab. ".repeat(3);
const QUESTION_TEXT = "Which of these two shapes should the export take?";

const jobA = (over = {}) => ({
  id: over.id,
  thread: over.thread || THREAD,
  status: "done",
  prompt: over.prompt || "do the thing",
  reply: Boolean(over.reply),
  startedAt: over.startedAt,
  endedAt: over.endedAt ?? null,
  origin: over.origin ?? null,
  lines: over.lines || [],
  artifacts: over.artifacts || [],
  attachments: over.attachments || [],
  completion: over.completion || null,
  finalMessage: over.finalMessage ?? null,
  question: over.question || null,
  questionDone: over.questionDone || null,
  // Every job the panel creates carries these (lib/jobs.js `create`), so the fixture carries them too:
  // they are what names the thread's project and tree on the tab.
  projectPath: "C:/dev/demo",
  worktreePath: "C:/dev/demo/.worktrees/messages-demo",
  branch: "wtgui/messages-demo",
});

const FIXTURE_A_JOBS = [
  // (d) the 8-day-old spawn: the same thread, older than the window, and it must not be rendered.
  jobA({ id: "a-old", startedAt: iso(8 * DAY), endedAt: iso(8 * DAY - HOUR), origin: { kind: "assistant-spawn", project: "demo" }, prompt: "an eight-day-old brief" }),
  // the conversation's first turn: the spawn, and the finished run that came back
  jobA({
    id: "a-spawn",
    startedAt: iso(6 * DAY),
    endedAt: iso(6 * DAY - HOUR),
    origin: { kind: "assistant-spawn", project: "demo" },
    prompt: LONG_PROMPT,
    finalMessage: "Done — the export is written and the report is on disk.",
    completion: { word: "normal", reason: "", duration: "1h02m", branch: "wtgui/messages-demo", worktree: "C:/dev/demo/.worktrees/messages-demo", commits: { count: 2, base: "main", subjects: ["x", "y"] }, treeExists: true, treeNote: "" },
    artifacts: [{ kind: "file", path: REPORT, bytes: 2048 }],
  }),
  // the wake the board raised ABOUT this thread (it runs in the assistant's own thread)
  jobA({
    id: "a-wake",
    thread: ASSISTANT,
    startedAt: iso(3 * DAY),
    endedAt: iso(3 * DAY - 2 * MIN),
    origin: { kind: "assistant-wake", reason: "[watch] watch finished: the export worker ended normal", alerts: ["al-wake"] },
    prompt: "watch: [watch] watch finished: the export worker",
    finalMessage: "That one finished cleanly.",
  }),
  // the assistant's reply into the worker's thread, and what came back
  jobA({ id: "a-reply", startedAt: iso(2 * DAY), endedAt: iso(2 * DAY - 5 * MIN), origin: { kind: "assistant-reply", by: "assistant", autonomy: "auto" }, prompt: "Add the CSV header, then re-run it.", finalMessage: "Added." }),
  // the parked question, and the answer the panel sent back. The real store holds it exactly this way
  // once it is answered: `question` is null, `questionDone` carries the answer, and the transcript line
  // the panel wrote when the agent stopped is what still names the question.
  jobA({
    id: "a-question",
    startedAt: iso(1 * DAY),
    endedAt: iso(1 * DAY - 20 * MIN),
    origin: { kind: "assistant-reply", by: "assistant" },
    prompt: "Which shape should the export take?",
    finalMessage: "Exported both shapes.",
    lines: [{ kind: "raw", text: `❓ question asked: ${QUESTION_TEXT}`, at: NOW - 1 * DAY + 1 * MIN }],
    questionDone: { answer: "Take option 1", at: iso(1 * DAY - 10 * MIN) },
  }),
  // (f) the reader's own click on the card: origin null, and it must read as the reader's message
  jobA({ id: "a-reader", reply: true, startedAt: iso(12 * HOUR), endedAt: iso(11 * HOUR), origin: null, prompt: "Actually make it TSV, not CSV.", finalMessage: "Switched to TSV." }),
  // the assistant's own thread, where the reader talks to it
  jobA({ id: "a-said", thread: ASSISTANT, reply: true, startedAt: iso(30 * MIN), endedAt: iso(28 * MIN), origin: null, prompt: "What is on the board right now?", finalMessage: "One worker finished; nothing is waiting on you." }),
];

const FIXTURE_A_JOURNAL = [
  // these four record facts the job store still holds, so they must be FOLDED (and not shown twice)
  { at: iso(3 * DAY), kind: "said", thread: null, text: "woken: [watch] watch finished: the export worker ended normal" },
  { at: iso(6 * DAY - 1 * MIN), kind: "spawned", thread: THREAD, text: "new worktree in demo: MESSAGES TAB, acceptance first" },
  { at: iso(1 * DAY - 10 * MIN), kind: "answered-question", thread: THREAD, text: "“Take option 1” from a standing rule" },
  { at: iso(1 * DAY - 11 * MIN), kind: "question-closed", thread: THREAD, text: "“waiting on your answer: Which of these two shapes…” was answered or withdrawn" },
  { at: iso(30 * MIN), kind: "said", thread: null, text: "What is on the board right now?" },
  // …and this one records a thread the job store no longer holds at all: it is shown on its own, and it
  // says where it came from.
  { at: iso(4 * DAY), kind: "question", thread: GONE, text: "a worker that is gone is parked on a question · waiting <1m · 2 choices" },
  // a non-message kind is not part of this view at all
  { at: iso(2 * HOUR), kind: "loop", thread: THREAD, text: "the same call five times" },
];

const FIXTURE_A_ALERTS = [{ id: "al-wake", rule: "watch", thread: THREAD, title: "the export worker finished", status: "answered", parked: false, at: iso(3 * DAY) }];

// ---- fixture B: large enough that the cap bites --------------------------------------------------
const FIXTURE_B_JOBS = [];
for (let i = 0; i < 80; i += 1) {
  FIXTURE_B_JOBS.push(
    jobA({
      id: `b-${i}`,
      thread: `wtgui-bulk-${String(i).padStart(6, "0")}`,
      startedAt: iso(2 * DAY + i * MIN),
      endedAt: iso(2 * DAY + i * MIN - 5 * MIN),
      origin: { kind: "assistant-spawn", project: "demo" },
      prompt: `bulk brief ${i}`,
      finalMessage: `bulk answer ${i}`,
    }),
  );
}
const FIXTURE_B_JOURNAL = [];
for (let t = 0; t < 30; t += 1) {
  for (let n = 0; n < 10; n += 1) {
    FIXTURE_B_JOURNAL.push({ at: iso(1 * DAY + (t * 10 + n) * MIN), kind: "question", thread: `wtgui-journal-only-${t}`, text: `journal-only question ${t}/${n}` });
  }
}
// 80 jobs x (one outbound + one inbound) + 300 journal lines the store cannot account for = 460 entries,
// of which the view shows the newest 300.
const FIXTURE_B_EXPECTED_TOTAL = 80 * 2 + 300;
const FIXTURE_B_EXPECTED_SHOWN = MESSAGE_CAP;

// ---- the merge, against the fixtures, with no panel in the way -----------------------------------
console.log("the merge: fixture A, entry by entry");
{
  const board = buildMessages({
    summaries: FIXTURE_A_JOBS,
    records: (id) => FIXTURE_A_JOBS.find((j) => j.id === id) || null,
    journal: FIXTURE_A_JOURNAL,
    alerts: FIXTURE_A_ALERTS,
    assistantThread: ASSISTANT,
    now: NOW,
  });
  const flat = board.groups.flatMap((g) => g.entries);
  note(`the fixture is ${FIXTURE_A_JOBS.length} jobs and ${FIXTURE_A_JOURNAL.length} journal lines; the view built ${board.total} entries in ${board.counts.threads} threads (${board.counts.out} sent, ${board.counts.in} received)`);
  for (const g of board.groups) note(`  ${g.thread}: ${g.entries.map((e) => `${e.dir}/${e.kind}`).join(" ")}`);
  // (b) the count, stated before it is asserted: 7 sent + 8 received.
  //    sent (7): the wake, the spawn, the assistant's reply into the thread, the reply that STARTED the
  //          turn which then parked on a question, the answer to that question, the reader's own reply,
  //          and the reader's message to the assistant on its own thread
  //    received (8): the finished run (6d), the finished reply, the finished question turn, the finished
  //          reader's reply, the parked question, the assistant's own turn's final message, the wake's
  //          own turn's final message, and the one thread only the journal still knows
  eq("(b) the fixture produces exactly 15 entries", board.total, 15);
  eq("(b) …7 of them sent", board.counts.out, 7);
  eq("(b) …8 of them received", board.counts.in, 8);
  eq("(b) …in 3 threads", board.counts.threads, 3);
  eq("(b) …and the window is the seven days the brief names", board.windowDays, MESSAGE_WINDOW_DAYS);
  eq("(b) …with nothing capped at this size", [board.capped, board.shown, board.dropped], [false, 15, 0]);

  // (c) the worker's thread, in the order a conversation reads in.
  const worker = board.groups.find((g) => g.thread === THREAD);
  const shape = worker.entries.map((e) => `${e.dir}/${e.kind}/${e.from}`);
  eq("(c) the worker's thread reads oldest → newest, with every kind attributed", shape, [
    "out/spawn/assistant",
    "in/final/agent",
    "out/wake/assistant",
    "out/reply/assistant",
    "in/final/agent",
    "out/reply/assistant",
    "in/question/agent",
    "out/answer/panel",
    "in/final/agent",
    "out/reply/you",
    "in/final/agent",
  ]);
  const spawn = worker.entries[0];
  ok("(c) the spawn carries the brief the worker was handed", spawn.text.startsWith("MESSAGES TAB, acceptance first."), `${spawn.text.length} chars`);
  const wake = worker.entries[2];
  eq("(c) the wake is filed under the thread it was woken ABOUT", [wake.thread, wake.ranIn], [THREAD, ASSISTANT]);
  ok("(c) …and carries the reason the board woke it", /watch finished: the export worker ended normal/.test(wake.text), wake.text);
  const question = worker.entries[6];
  eq("(c) the parked question is inbound, with its choices answered", [question.dir, question.kind, question.question.answered, question.question.answer], ["in", "question", true, "Take option 1"]);
  ok("(c) …and the question itself is recovered from the transcript line", question.text === QUESTION_TEXT, question.text);
  const answer = worker.entries[7];
  eq("(c) the answer is outbound, from the panel", [answer.dir, answer.from, answer.text], ["out", "panel", "Take option 1"]);
  const completed = worker.entries[1];
  eq("(c) the completed run carries the word it ended on", [completed.dir, completed.kind, completed.completion.word], ["in", "final", "normal"]);
  eq("(c) …the reason when there is one, and what it left behind", [completed.completion.duration, completed.completion.commits], ["1h02m", 2]);
  ok("(c) …and the report path the record holds", completed.report && completed.report.path === REPORT, JSON.stringify(completed.report));
  ok("(c) …and what the worker actually said", /the export is written/.test(completed.text), completed.text);

  // (f) the reader's own click
  const reader = worker.entries.find((e) => e.text.startsWith("Actually make it TSV"));
  eq("(f) the reader's own reply is attributed to the reader", [reader.dir, reader.kind, reader.from], ["out", "reply", "you"]);
  ok("(f) …and it is not the assistant's words anywhere in its record", reader.from !== "assistant" && !/assistant/i.test(reader.from), reader.from);

  // (d) the window, computed from each entry's own timestamp
  ok("(d) nothing 8 days old is in the view", !flat.some((e) => Date.parse(e.at) < NOW - 8 * DAY), flat.map((e) => e.at).join(", "));
  ok("(d) the 6-day-old spawn is present", flat.some((e) => e.job === "a-spawn" && e.kind === "spawn"));
  ok("(d) the 8-day-old job's entry is absent", !flat.some((e) => e.job === "a-old"));
  const age = Math.round((NOW - Date.parse(flat.find((e) => e.job === "a-spawn" && e.kind === "spawn").at)) / DAY);
  eq("(d) …and it is six days old, measured", age, 6);

  // the fold: the journal's second copies of facts the store holds are not shown twice
  eq("(b) the four journal lines the store accounts for are folded, and the one it cannot is shown", board.counts.fromJournal, 1);
  const fromJournal = flat.find((e) => e.source === "journal");
  eq("(b) …that one is the thread the store no longer holds", fromJournal.thread, GONE);
  ok("(b) …and it says so, rather than pretending to be a job record", fromJournal.source === "journal");
  ok("(b) no journal line for a fact the store holds is rendered", !flat.some((e) => e.source === "journal" && e.thread === THREAD));

  // the assistant's own thread is a conversation too, and it is labelled as such
  const own = board.groups.find((g) => g.thread === ASSISTANT);
  eq("(h) the assistant's own thread is its own group", [own.assistant, own.entries.map((e) => `${e.dir}/${e.kind}/${e.from}`)], [true, ["in/final/agent", "out/said/you", "in/final/agent"]]);
  eq("(h) …and the threads are ordered newest activity first", board.groups.map((g) => g.thread), [ASSISTANT, THREAD, GONE]);
}

console.log("\nthe merge: the cap, on fixture B");
{
  const board = buildMessages({
    summaries: FIXTURE_B_JOBS,
    records: () => null,
    journal: FIXTURE_B_JOURNAL,
    alerts: [],
    assistantThread: ASSISTANT,
    now: NOW,
  });
  eq("(g) the large fixture builds the expected number of entries", board.total, FIXTURE_B_EXPECTED_TOTAL);
  eq("(g) …and the view shows the newest 300 of them", [board.shown, board.capped, board.dropped], [FIXTURE_B_EXPECTED_SHOWN, true, FIXTURE_B_EXPECTED_TOTAL - FIXTURE_B_EXPECTED_SHOWN]);
  const bytes = JSON.stringify(board).length;
  ok("(g) …so the payload is bounded even with 460 entries behind it", bytes < 400_000, `${bytes} bytes for ${board.total} entries`);
  ok("(g) …and it says which cap it hit", board.cap === MESSAGE_CAP && board.total > board.cap, `cap ${board.cap}`);
  const empty = buildMessages({ summaries: [], records: () => null, journal: [], alerts: [], assistantThread: ASSISTANT, now: NOW });
  eq("(h) an empty pair of stores says so without inventing entries", [empty.total, empty.shown, empty.groups.length, empty.windowDays], [0, 0, 0, 7]);
}

// ---- the panel: a scratch instance per fixture ---------------------------------------------------
const instances = [];
async function startPanel({ slug, jobs, journal, alerts = [] }) {
  const dir = mkdtempSync(path.join(tmpdir(), `wtgui-messages-${slug}-`));
  const logs = path.join(dir, "logs");
  const scanRoot = path.join(dir, "scan-root");
  const home = path.join(dir, "hermes-home");
  for (const d of [logs, scanRoot, home]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(logs, "jobs.json"), JSON.stringify({ savedAt: new Date().toISOString(), jobs }));
  writeFileSync(
    path.join(logs, "assistant.json"),
    JSON.stringify({ version: 2, savedAt: new Date().toISOString(), settings: { enabled: false }, notes: "", rules: [], watches: [], alerts, journal }, null, 1),
  );
  const port = await freePort();
  const configPath = path.join(dir, "config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        port,
        host: "127.0.0.1",
        scanRoots: [scanRoot],
        defaultCwd: scanRoot,
        jobsFile: path.join(logs, "jobs.json"),
        assistantFile: path.join(logs, "assistant.json"),
        projectsCacheFile: path.join(logs, "projects.json"),
        treeNamesFile: path.join(logs, "tree-names.json"),
        // Nothing this script drives may reach a gateway: no fixture starts a run.
        apiServer: { url: "http://127.0.0.1:9", key: "sandbox-key" },
        assistant: { enabled: false, seconds: 3600, maxWakesPerHour: 0 },
        refreshSeconds: 3600,
        worktreeSeconds: 3600,
        midSeconds: 3600,
        dormantSeconds: 3600,
        slowSeconds: 3600,
        fetchSeconds: 3600,
      },
      null,
      2,
    )}\n`,
  );
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PANEL_CONFIG: configPath, HERMES_HOME: home, PANEL_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const log = [];
  child.stdout.on("data", (d) => log.push(...String(d).split(/\r?\n/).filter(Boolean)));
  child.stderr.on("data", (d) => log.push(...String(d).split(/\r?\n/).filter(Boolean)));
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 200 && !up; i += 1) {
    try {
      up = (await fetch(`${base}/api/health`)).ok;
    } catch {
      /* not listening yet */
    }
    if (!up) await sleep(100);
  }
  const inst = { slug, dir, base, child, log, up };
  instances.push(inst);
  ok(`${slug}: the scratch instance answers on ${base} — its own port, never 7331`, up, up ? "" : log.slice(-8).join(" | "));
  return inst;
}
async function stopPanels() {
  for (const inst of instances) {
    const p = inst.child;
    p.kill();
    for (let i = 0; i < 40 && p.exitCode === null && p.signalCode === null; i += 1) await sleep(100);
    if (p.exitCode === null && p.signalCode === null && p.pid) {
      try {
        execFileSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } catch {
        /* already gone */
      }
    }
    rmSync(inst.dir, { recursive: true, force: true });
  }
  instances.length = 0;
}

console.log("\nGET /api/assistant/messages, over a real instance with fixture A in its store");
let panelA = null;
let panelB = null;
let panelEmpty = null;
try {
  panelA = await startPanel({ slug: "a", jobs: FIXTURE_A_JOBS, journal: FIXTURE_A_JOURNAL, alerts: FIXTURE_A_ALERTS });
  if (panelA.up) {
    const r = await fetch(`${panelA.base}/api/assistant/messages`);
    const body = await r.json();
    const m = body.messages;
    eq("(b) the route answers 200", r.status, 200);
    eq("(b) …with the same 15 entries the fixture counts", [m.total, m.counts.out, m.counts.in, m.counts.threads], [15, 7, 8, 3]);
    eq("(b) …the same order, thread by thread", m.groups.map((g) => [g.thread, g.entries.map((e) => e.kind)]), [
      [ASSISTANT, ["final", "said", "final"]],
      [THREAD, ["spawn", "final", "wake", "reply", "final", "reply", "question", "answer", "final", "reply", "final"]],
      [GONE, ["question"]],
    ]);
    ok("(h) the window and the cap travel with the answer", m.windowDays === 7 && m.cap === MESSAGE_CAP && typeof m.since === "string", `${m.windowDays} days, cap ${m.cap}, since ${m.since}`);
    ok("(b) the vocabulary the page renders is in the answer too", m.kinds && m.kinds.spawn && m.kinds.spawn.label === "spawn");
    ok("(e) the long brief arrives whole, so the pane's expander has the rest to reveal", m.groups.find((g) => g.thread === THREAD).entries[0].text.length > 340, `${m.groups.find((g) => g.thread === THREAD).entries[0].text.length} chars`);
    ok("(c) the report path rides on the entry that finished", m.groups.find((g) => g.thread === THREAD).entries[1].report.path === REPORT);
    // The state the page polls must NOT carry the board: it is re-sent on every board event.
    const state = await (await fetch(`${panelA.base}/api/state`)).json();
    ok("(g) the polled state does not carry the board (a 300-entry body on every event)", !("messages" in (state.assistant || {})), Object.keys(state.assistant || {}).join(", ").slice(0, 120));
  }

  panelB = await startPanel({ slug: "b", jobs: FIXTURE_B_JOBS, journal: FIXTURE_B_JOURNAL });
  if (panelB.up) {
    const t0 = Date.now();
    const r = await fetch(`${panelB.base}/api/assistant/messages`);
    const raw = await r.text();
    const m = JSON.parse(raw).messages;
    // One line short of the module's own count, and for a reason worth knowing: the panel seeds its
    // charter on first boot, and a journal already at its 300-line cap loses its oldest line to that entry.
    const expected = FIXTURE_B_EXPECTED_TOTAL - 1;
    eq("(g) the large fixture's route answer is capped too", [m.total, m.shown, m.capped], [expected, MESSAGE_CAP, true]);
    eq("(g) …with the journal at its own cap (the panel's charter seed displaced one line)", m.counts.journal, 300);
    ok("(g) …the payload stays bounded (measured, not asserted from the cap alone)", raw.length < 400_000, `${raw.length} bytes in ${Date.now() - t0}ms for ${m.total} entries`);
    eq("(g) …and the cap it hit is named in the answer", m.cap, MESSAGE_CAP);
    // A cap the reader can lower is what makes the bite reachable without a 460-entry store.
    const small = await (await fetch(`${panelB.base}/api/assistant/messages?cap=5`)).json();
    eq("(g) the route's own cap argument is honoured and still stated", [small.messages.shown, small.messages.capped, small.messages.dropped, small.messages.total], [5, true, expected - 5, expected]);
  }

  panelEmpty = await startPanel({ slug: "empty", jobs: [], journal: [] });
  if (panelEmpty.up) {
    const m = (await (await fetch(`${panelEmpty.base}/api/assistant/messages`)).json()).messages;
    eq("(h) an empty store answers with an empty window, not an error", [m.total, m.shown, m.groups.length], [0, 0, 0]);
  }
} catch (err) {
  ok("the panel half ran", false, String((err && err.message) || err));
}

// ---- the browser half ----------------------------------------------------------------------------
function loadPlaywright() {
  const roots = [process.env.PANEL_PLAYWRIGHT_ROOT, process.env.PLAYWRIGHT_ROOT, ROOT, process.cwd()].filter(Boolean);
  for (const root of roots) {
    try {
      return require(path.join(root, "node_modules", "playwright"));
    } catch {
      /* not there */
    }
    try {
      return require(root);
    } catch {
      /* not there */
    }
  }
  try {
    return require("playwright");
  } catch {
    return null;
  }
}

const tabSel = '#as-tabs [data-as-tab="messages"]';
const paneSel = "#as-messages";

async function openFloat(page, base) {
  await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#assistant:not([hidden])", { timeout: 20_000 });
}

async function browserPhase(pw) {
  const browser = await pw.chromium.launch({ headless: true });
  browserRef = browser;
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  // The float remembers whether it was open; a fresh context has never opened it. Everything else is the
  // shipped page, unmodified: no stubbed fetch, no fabricated state.
  await context.addInitScript(() => {
    try {
      localStorage.setItem("wm.assistantOpen", "1");
      localStorage.setItem("wm.assistantTab", "alerts");
    } catch {
      /* storage off: the checks below would then have to click the tab themselves */
    }
  });
  // The report path's copy control is the panel's own (navigator.clipboard with its textarea fallback), and
  // Chromium denies the clipboard to an insecure origin unless it is granted: grant it, so "copyable" is
  // proved by reading the clipboard back rather than by the button merely not throwing.
  for (const inst of [panelA, panelB, panelEmpty]) {
    if (!inst || !inst.up) continue;
    try {
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: inst.base });
    } catch {
      /* older Chromium: the copy check below then reports what it got */
    }
  }
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e.message || e)));

  if (panelA && panelA.up) {
    await openFloat(page, panelA.base);
    // (a) the strip, in the same idiom as its neighbours
    const tabs = await page.$$eval("#as-tabs button", (els) =>
      els.map((el) => ({ tab: el.dataset.asTab, text: el.textContent.trim(), title: el.getAttribute("title") || "" })),
    );
    const mine = tabs.find((t) => t.tab === "messages");
    ok("(a) the tab is in the float's strip, in the same idiom as the others", Boolean(mine) && tabs.length === 7, JSON.stringify(tabs.map((t) => t.tab)));
    ok("(a) …labelled Messages, with a title that says what it is", mine && mine.text === "Messages" && /message board/i.test(mine.title), mine && mine.title);
    const classes = await page.$$eval("#as-tabs button", (els) => els.map((el) => el.className));
    eq("(a) …and no class of its own (only the open tab is marked)", [...new Set(classes)].sort(), ["", "is-on"]);

    // (a) switching to it and away must not disturb the tab that was open. The float opens on Alerts here.
    await page.click('#as-tabs [data-as-tab="alerts"]');
    await page.waitForSelector('#as-alerts:not(.hidden)');
    const alertsBefore = await page.$eval("#as-alerts", (el) => el.innerHTML);
    const alertCount = await page.$$eval("#as-alerts .as-alert", (els) => els.length);

    await page.click(tabSel);
    await page.waitForSelector(`${paneSel} .as-msg-thread`, { timeout: 20_000 });
    eq("(a) the messages pane is the visible one", await page.$eval(paneSel, (el) => !el.classList.contains("hidden")), true);
    eq("(a) …and the alerts pane is hidden, not emptied", await page.$eval("#as-alerts", (el) => [el.classList.contains("hidden"), el.innerHTML.length > 0]), [true, true]);

    // (b) the count the tab renders, against the count the fixture states
    const rendered = await page.$$eval(`${paneSel} .as-msg`, (els) => els.length);
    eq("(b) the tab renders the same 15 entries the fixture counts", rendered, 15);
    const barText = await page.$eval(`${paneSel} .as-msg-bar`, (el) => el.textContent.replace(/\s+/g, " ").trim());
    ok("(h) …and says the window out loud", /the last 7 days/.test(barText) && /15 entr/.test(barText) && /7 sent/.test(barText) && /8 received/.test(barText), barText);
    const windowTitle = await page.$eval(`${paneSel} .as-msg-window`, (el) => el.getAttribute("title") || "");
    ok("(h) …with the boundary explained on hover", /own timestamp/.test(windowTitle), windowTitle);

    // the threads, newest activity first, and the order inside one of them
    const groups = await page.$$eval(`${paneSel} .as-msg-thread`, (els) =>
      els.map((el) => ({
        thread: el.querySelector(".as-thread")?.dataset.asOpen,
        entries: [...el.querySelectorAll(".as-msg")].map((e) => `${e.dataset.dir}/${e.querySelector(".as-msg-kind").textContent}`),
      })),
    );
    eq("(b) the rendered order matches the store, thread by thread", groups.map((g) => g.thread), [ASSISTANT, THREAD, GONE]);
    eq("(b) …and the conversation inside the worker's thread reads oldest → newest", groups[1].entries, ["out/spawn", "in/final message", "out/wake", "out/reply", "in/final message", "out/reply", "in/question", "out/answer", "in/final message", "out/reply", "in/final message"]);
    const headText = await page.$$eval(
      `${paneSel} .as-msg-thread`,
      (els, thread) => {
        const g = els.find((el) => el.querySelector(".as-thread")?.dataset.asOpen === thread);
        return g ? g.querySelector(".as-msg-thread-head").textContent.replace(/\s+/g, " ").trim() : "";
      },
      THREAD,
    );
    ok("(2) the thread's head names the project and how much is in it", /demo/.test(headText) && /11 messages/.test(headText), headText);

    // (d) the 8-day entry is absent from the DOM and the 6-day one is on it
    const bodyText = await page.$eval(paneSel, (el) => el.textContent);
    ok("(d) the 8-day-old brief is not on the page", !bodyText.includes("an eight-day-old brief"));
    ok("(d) the 6-day-old brief is", bodyText.includes("MESSAGES TAB, acceptance first."));

    // (1) direction is unmistakable in the text and in the accessibility tree
    const dirs = await page.$$eval(`${paneSel} .as-msg`, (els) =>
      els.map((el) => ({
        text: el.querySelector(".as-msg-dir").textContent,
        aria: el.getAttribute("aria-label") || "",
        kind: el.querySelector(".as-msg-kind").textContent,
      })),
    );
    const outEntry = dirs.find((d) => d.text.startsWith("assistant → "));
    const inEntry = dirs.find((d) => d.text.endsWith(" → assistant"));
    ok("(1) a sent entry names the direction in words", outEntry && outEntry.text === `assistant → ${THREAD}`, outEntry && outEntry.text);
    ok("(1) a received entry names it the other way round", inEntry && inEntry.text === `${THREAD} → assistant`, inEntry && inEntry.text);
    ok("(1) …and the same direction is in the accessibility label", outEntry && outEntry.aria.startsWith(`assistant → ${THREAD}, spawn,`), outEntry && outEntry.aria);
    ok("(1) …with the kind in both", outEntry && outEntry.aria.includes("spawn") && inEntry && inEntry.aria.includes("final message"), `${outEntry?.aria} | ${inEntry?.aria}`);
    const readerEntry = dirs.find((d) => d.text === `you → ${THREAD}`);
    ok("(f) the reader's own reply reads as the reader's, in words and in the a11y tree", Boolean(readerEntry) && readerEntry.aria.startsWith(`you → ${THREAD}, reply,`), readerEntry && readerEntry.aria);
    const wakeEntry = dirs.find((d) => d.kind === "wake");
    ok("(1) a wake is named as a wake, not as a generic send", Boolean(wakeEntry), JSON.stringify(wakeEntry));

    // relative times with the absolute on hover
    const time = await page.$eval(`${paneSel} .as-msg .as-ago`, (el) => ({ text: el.textContent, title: el.getAttribute("title") }));
    ok("(5) entries show a relative age with the absolute time on hover", /^(\d+[smhd]) ago$/.test(time.text) && /\d{4}/.test(time.title || ""), JSON.stringify(time));

    // (e) the expander
    const long = await page.$eval(`${paneSel} .as-msg[data-msg="job:a-spawn:out"] .as-msg-text`, (el) => el.textContent.length);
    const moreBtn = `${paneSel} .as-msg[data-msg="job:a-spawn:out"] [data-as-msg-more]`;
    ok("(e) a long outbound message is truncated", long > 0 && long <= 321, `${long} chars shown`);
    await page.click(moreBtn);
    const expanded = await page.$eval(`${paneSel} .as-msg[data-msg="job:a-spawn:out"] .as-msg-text`, (el) => el.textContent.length);
    const expandedAria = await page.$eval(moreBtn, (el) => el.getAttribute("aria-expanded"));
    ok("(e) …and the expander reveals the rest of it", expanded > long, `${long} → ${expanded} chars`);
    eq("(e) …saying so in the accessibility tree", expandedAria, "true");
    await page.click(moreBtn);
    eq("(e) …and folding it back up again", await page.$eval(`${paneSel} .as-msg[data-msg="job:a-spawn:out"] .as-msg-text`, (el) => el.textContent.length), long);

    // (e) the report path: copyable, and openable through the panel's own open
    const report = await page.$eval(`${paneSel} .as-msg-report`, (el) => ({
      path: el.querySelector(".as-msg-path")?.dataset.openPath,
      copy: el.querySelector(".as-msg-copy")?.dataset.copyPath,
      shown: el.querySelector(".as-msg-path")?.textContent,
    }));
    eq("(e) the report path is on the entry, whole, as an openable path", [report.path, report.copy], [REPORT, REPORT]);
    ok("(e) …and it is shown as the path itself, not a label", report.shown === REPORT, report.shown);
    const posts = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("/api/open-path")) posts.push(r.postData() || "");
    });
    // The fixture's report file does not exist on this box, so the panel answers 404 and opens nothing:
    // what is being proved is the REQUEST the control makes, not that an editor was launched.
    await page.click(`${paneSel} .as-msg-report .as-msg-path`);
    await sleep(400);
    ok("(e) clicking it asks the panel to open exactly that file", posts.length === 1 && posts[0].includes("wtgui-messages-demo-abc123.md"), JSON.stringify(posts));
    await page.click(`${paneSel} .as-msg-report .as-msg-copy`);
    await sleep(300);
    const copied = await page.$eval(`${paneSel} .as-msg-report .as-msg-copy`, (el) => el.textContent.trim());
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
    eq("(e) the copy control copies the path itself", [copied, clip], ["copied", REPORT]);

    // (c) the three chips, All by default, each filtering one direction
    const chipState = await page.$$eval(`${paneSel} .as-msg-chips button`, (els) => els.map((el) => [el.dataset.asMsgdir, el.textContent.trim(), el.getAttribute("aria-pressed")]));
    eq("(6) three chips, All first and on by default", chipState.map((c) => c[0]), ["all", "out", "in"]);
    eq("(6) …labelled All, Sent, Received, with their counts", chipState.map((c) => c[1].split(" ")[0]), ["All", "Sent", "Received"]);
    eq("(6) …and All is the one pressed", chipState.map((c) => c[2]), ["true", "false", "false"]);
    await page.click(`${paneSel} [data-as-msgdir="out"]`);
    const sent = await page.$$eval(`${paneSel} .as-msg`, (els) => els.map((e) => e.dataset.dir));
    eq("(6) Sent shows exactly the seven outbound entries", sent.length, 7);
    ok("(6) …and nothing received is among them", sent.every((d) => d === "out"), sent.join(","));
    await page.click(`${paneSel} [data-as-msgdir="in"]`);
    const got = await page.$$eval(`${paneSel} .as-msg`, (els) => els.map((e) => e.dataset.dir));
    eq("(6) Received shows exactly the eight inbound ones", got.length, 8);
    ok("(6) …and nothing sent is among them", got.every((d) => d === "in"), got.join(","));
    await page.click(`${paneSel} [data-as-msgdir="all"]`);
    eq("(6) All puts the conversation back together", await page.$$eval(`${paneSel} .as-msg`, (els) => els.length), 15);

    // the journal's own entry is marked as the only copy the panel still holds
    const src = await page.$$eval(`${paneSel} .as-msg-src`, (els) => els.map((el) => el.textContent.trim()));
    eq("(8) an entry only the journal still holds is marked as such", src, ["from the journal"]);
    const goneText = await page.$eval(`${paneSel} .as-msg-thread:last-child .as-msg .as-msg-text`, (el) => el.textContent);
    ok("(8) …and it carries the journal's own words", /parked on a question/.test(goneText), goneText);

    // (a) …and the round trip away and back leaves the other tab exactly as it was
    await page.click('#as-tabs [data-as-tab="alerts"]');
    await page.waitForSelector('#as-alerts:not(.hidden)');
    const alertsAfter = await page.$eval("#as-alerts", (el) => el.innerHTML);
    const alertCountAfter = await page.$$eval("#as-alerts .as-alert", (els) => els.length);
    ok("(a) coming back to Alerts shows the tab that was open, unchanged", alertsAfter === alertsBefore, `${alertsBefore.length} → ${alertsAfter.length} chars`);
    eq("(a) …with the same alerts on it", alertCountAfter, alertCount);
    eq("(a) …and Messages is the hidden one again", await page.$eval(paneSel, (el) => el.classList.contains("hidden")), true);
    await page.click(tabSel);
    await page.waitForSelector(`${paneSel} .as-msg-thread`);
    eq("(a) going back to Messages still renders the whole board", await page.$$eval(`${paneSel} .as-msg`, (els) => els.length), 15);
  }

  if (panelB && panelB.up) {
    const page2 = await context.newPage();
    page2.on("pageerror", (e) => pageErrors.push(String(e.message || e)));
    await openFloat(page2, panelB.base);
    await page2.click(tabSel);
    await page2.waitForSelector(`${paneSel} .as-msg-thread`, { timeout: 30_000 });
    const capText = await page2.$eval(`${paneSel} .as-msg-cap`, (el) => el.textContent.replace(/\s+/g, " ").trim());
    ok("(g) the tab says the cap bit, with the numbers", /newest 300 of 459/.test(capText) && /300-entry cap/.test(capText), capText);
    eq("(g) …and renders the capped number of entries", await page2.$$eval(`${paneSel} .as-msg`, (els) => els.length), MESSAGE_CAP);
    await page2.close();
  }

  if (panelEmpty && panelEmpty.up) {
    const page3 = await context.newPage();
    page3.on("pageerror", (e) => pageErrors.push(String(e.message || e)));
    await openFloat(page3, panelEmpty.base);
    await page3.click(tabSel);
    await page3.waitForSelector(`${paneSel} .as-empty`, { timeout: 20_000 });
    const emptyText = await page3.$eval(`${paneSel} .as-empty`, (el) => el.textContent.replace(/\s+/g, " ").trim());
    ok("(h) an empty tab names the window and says an empty tab is not an empty board", /Nothing in the last 7 days/.test(emptyText) && /not an empty board/.test(emptyText), emptyText);
    eq("(h) …with no entries rendered", await page3.$$eval(`${paneSel} .as-msg`, (els) => els.length), 0);
    await page3.close();
  }

  ok("no page error was raised while driving the tab", pageErrors.length === 0, pageErrors.join(" | "));
  await context.close();
  await browser.close();
  browserRef = null;
}

console.log("\nthe tab in a real browser, over those instances");
const pw = loadPlaywright();
if (!pw) {
  console.log("BROWSER-HALF-NOT-RUN — no Playwright install found; point PANEL_PLAYWRIGHT_ROOT at a directory holding node_modules/playwright");
  failures += 1;
  checks += 1;
} else {
  try {
    await browserPhase(pw);
  } catch (err) {
    ok("the browser half ran", false, String((err && err.stack) || err));
  } finally {
    if (browserRef) {
      try {
        await browserRef.close();
      } catch {
        /* already closed */
      }
    }
    browserRef = null;
  }
}

await stopPanels();
console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} message-board checks passed`);
process.exitCode = failures ? 1 : 0;
