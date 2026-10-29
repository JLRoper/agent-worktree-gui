// The message board between the assistant and the agents: what it sent them, and what they sent back.
//
// This is a VIEW, not a log. Everything below is derived, on the spot, from records the panel already
// keeps, and nothing here writes anything:
//
//   * the job store (`logs/jobs.json`, read through `Jobs.list()`/`Jobs.get()`): every job the assistant
//     started carries an `origin` — `assistant-spawn`, `assistant-wake`, `assistant-reply` — and the
//     message itself is that job's `prompt`. A reply the READER's own click sent has `origin: null`, and
//     is attributed to the reader rather than to the assistant's words.
//   * the same record, read the other way: `completion` (the word the run ended on and why), the run's
//     own last words (`finalMessage`, or the tail of its transcript), a parked `question` and its answer
//     (`questionDone`), and a report path out of `completion.report` or `artifacts`/`attachments`.
//   * the assistant's journal (`logs/assistant.json`): its own message kinds — `said`, `spawned`,
//     `asked`, `answered-question`, `question`, `question-closed`.
//
// THE MERGE RULE, and the reason it is this way
//
// The job store is the PRIMARY source: it holds the message text, the direction, the ending and the
// answer, and the journal line about the same act is a second, poorer record of it. So a journal line of
// a message kind is FOLDED into the job record that recorded the same fact (`coveredBy`, below) and is
// shown on its own only when no such job is still in the store — which is the honest reading of a store
// that keeps roughly its last eighty jobs. An entry that had to come from the journal says so, because a
// reader looking at it is looking at the only copy the panel still holds.
//
// The window is seven days, computed from each entry's own timestamp, and nothing here is cached: the
// caller reads it per request. The payload is capped (`MESSAGE_CAP` entries, `MESSAGE_TEXT_CAP` chars of
// text each) and says so when the cap bites, so the tab can never ship an unbounded body to the page.
import { lastWords } from "../completion.js";

export const MESSAGE_WINDOW_DAYS = 7;
// "A few hundred is plenty for 7 days on this board" — the cap is on ENTRIES, and the newest are kept.
export const MESSAGE_CAP = 300;
// Per-entry text cap. A brief runs to a few thousand characters; past this the entry is clipped and says
// it was clipped, so one enormous prompt cannot make the payload unbounded on its own.
export const MESSAGE_TEXT_CAP = 4000;

const DAY_MS = 86_400_000;
const LIVE_STATUS = new Set(["running", "starting", "waiting_for_approval", "queued"]);
// A journal line and the job record it belongs to are written in the same breath: `say()` journals
// immediately after `create()`, and `startSpawn`'s line lands a few seconds later (it waits for the
// worktree). The spawn line is not time-matched at all — a spawned thread IS its job (see `coveredBy`).
const SAME_TICK_MS = 60_000;
// The rules that fire AFTER a turn ended (`question`, `question-closed`) are evaluated on the sentry's
// clock and only for a turn that ended inside the same window, so the fact they record is on a job whose
// end (or whose answer) sits in that window, at or before the line.
const AFTER_TURN_MS = 900_000;

// The vocabulary, in one table: what each kind means, which way it points and who wrote it. The page
// renders `label`, so a new kind shows up there without a second list to keep in step.
export const MESSAGE_KINDS = {
  spawn: { dir: "out", from: "assistant", label: "spawn", hint: "the assistant started this worker, and this is what it was told" },
  wake: { dir: "out", from: "assistant", label: "wake", hint: "the board woke the assistant about this thread" },
  reply: { dir: "out", from: "assistant", label: "reply", hint: "a message sent into this thread" },
  answer: { dir: "out", from: "panel", label: "answer", hint: "the answer to the question this run was parked on — sent from the panel, by your press or by a standing rule" },
  said: { dir: "out", from: "assistant", label: "said", hint: "a turn in the assistant's own thread" },
  asked: { dir: "out", from: "assistant", label: "asked", hint: "the assistant was asked to look at this thread" },
  final: { dir: "in", from: "agent", label: "final message", hint: "what the worker ended on, and how its run ended" },
  question: { dir: "in", from: "agent", label: "question", hint: "the worker stopped to ask something" },
  "question-closed": { dir: "in", from: "agent", label: "question closed", hint: "that question was answered or withdrawn" },
};

const SLASH = String.fromCharCode(92);
// Paths as this panel writes them: forward slashes, no trailing one.
export const fwd = (p) => String(p || "").replaceAll(SLASH, "/").replace(/\/+$/, "");
const msOf = (v) => {
  const t = typeof v === "number" ? v : Date.parse(String(v ?? ""));
  return Number.isFinite(t) ? t : null;
};
const isoOf = (t) => new Date(t).toISOString();
const cut = (s, n) => (String(s ?? "").length > n ? String(s).slice(0, n) : String(s ?? ""));
const leafPath = (p, keep = 2) => fwd(p).split("/").filter(Boolean).slice(-keep).join("/");
const firstLine = (s, n = 160) => cut(String(s ?? "").replace(/\s+/g, " ").trim(), n);

// A job's display name, the same words the card uses.
const nameOf = (s) => firstLine(String(s?.label || s?.title || s?.thread || "agent").replace(/^Subagent:\s*/i, ""), 60);

// ---- what a job holds, read the other way ---------------------------------------------------------

// The report path, if the record carries one. The panel's own resolution (`completion.report`, from
// lib/completion.js) is the first answer; a `.md` under `.agentboard/` (or one whose name says report)
// among the run's produced files is the second. The report TEXT is deliberately not carried: it runs to
// 12 KB and this payload is bounded.
function reportFor(s) {
  const known = s?.completion?.report;
  if (known && known.path) {
    const bytes = Number(known.bytes);
    return { path: fwd(known.path), bytes: Number.isFinite(bytes) ? bytes : null, from: "the panel's own resolution" };
  }
  for (const a of [...(s?.artifacts || []), ...(s?.attachments || [])]) {
    const raw = a && (a.path || a.url);
    if (!raw || typeof raw !== "string") continue;
    const file = fwd(raw);
    if (!/\.md$/i.test(file)) continue;
    const leaf = file.split("/").pop() || "";
    if (!/\.agentboard\//i.test(file) && !/report/i.test(leaf)) continue;
    const bytes = Number(a.bytes);
    return { path: file, bytes: Number.isFinite(bytes) ? bytes : null, from: "the run's produced files" };
  }
  return null;
}

// The question a run was parked on. While it is parked the record holds it whole; once it is answered
// the question TEXT is gone from the job (jobs.js nulls it and keeps `questionDone`), so it is recovered
// from the transcript line the panel wrote when the agent stopped ("❓ question asked: …"), or from the
// parked alert the sentry raised about it. If neither is still held, the entry says the question itself
// is no longer recorded rather than inventing one.
const QUESTION_LINE = /^\s*❓\s*question asked:\s*/;
function questionText(s, alerts) {
  for (const l of s?.lines || []) {
    const t = String(l?.text || "");
    if (QUESTION_LINE.test(t)) return { text: t.replace(QUESTION_LINE, "").trim(), at: msOf(l.at) };
  }
  const alert = (alerts || []).find((a) => a && a.parked && a.turnId && a.turnId === s?.id);
  if (alert && alert.title) return { text: String(alert.title).replace(/^waiting on your answer:\s*/i, "").trim(), at: msOf(alert.at) };
  return { text: "", at: null };
}

function questionFor(s, alerts) {
  const live = s?.question;
  if (live) {
    return {
      text: String(live.question || ""),
      choices: (Array.isArray(live.choices) ? live.choices : []).map(String),
      multiSelect: Boolean(live.multiSelect),
      at: msOf(live.at) ?? msOf(s.startedAt),
      answered: false,
      withdrawn: false,
      answer: "",
      recovered: false,
    };
  }
  const done = s?.questionDone;
  if (!done) return null;
  const answer = String(done.answer || "").trim();
  const recovered = questionText(s, alerts);
  return {
    text: recovered.text,
    choices: [],
    multiSelect: false,
    at: recovered.at ?? msOf(done.at) ?? msOf(s.startedAt),
    answered: Boolean(answer),
    // `closed: true` with no answer is the panel saying the question left without one: withdrawn by a
    // stop, timed out, or answered on another surface. That is not the same as an answer, and it is not
    // the same as a question nobody answered either.
    withdrawn: !answer,
    answer,
    recovered: Boolean(recovered.text),
  };
}

// A parked question about this thread that the sentry raised and then closed: the journal's own record,
// used when the job that held the question is no longer in the store.
function completionOf(s) {
  const c = s?.completion;
  if (!c) return null;
  const commits = c.commits && Number.isFinite(Number(c.commits.count)) ? Number(c.commits.count) : null;
  return {
    word: String(c.word || ""),
    reason: String(c.reason || ""),
    duration: String(c.duration || ""),
    branch: c.branch ? String(c.branch) : null,
    worktree: c.worktree ? fwd(c.worktree) : null,
    commits,
    treeExists: c.treeExists === false ? false : c.treeExists === true ? true : null,
    treeNote: String(c.treeNote || ""),
  };
}

// The thread a wake belongs to. A wake is a turn in the assistant's OWN thread, but what it was woken
// ABOUT is the conversation it belongs in: the wake carries the alert ids it was fired from, and an
// alert names the thread it is about. A wake that names no thread (a restart wake, say) stays in the
// assistant's own thread, which is where it happened.
function wakeThread(origin, alerts, fallback) {
  const ids = Array.isArray(origin?.alerts) ? origin.alerts : [];
  for (const id of ids) {
    const a = (alerts || []).find((x) => x && x.id === id);
    if (a && a.thread) return a.thread;
  }
  return fallback;
}

// ---- the journal, folded --------------------------------------------------------------------------

const MESSAGE_JOURNAL_KINDS = new Set(["said", "spawned", "asked", "answered-question", "question", "question-closed"]);

const anyWithin = (times, at, window, { before = false } = {}) =>
  (times || []).some((t) => (before ? t <= at && at - t <= window : Math.abs(t - at) <= window));

// Which journal lines the job store already accounts for. One rule per kind, each stated in terms of the
// fact the line records — never "the same thread, roughly the same time", which would fold a line into an
// unrelated job:
//
//   spawned            a spawned thread IS its job: any job on that thread that the assistant started.
//   said / asked       the job `say()` created for that line, on the assistant's own thread (written in
//                      the same breath, so the start time is at or just before the line).
//   answered-question  a job on that thread whose answer is recorded at or before the line.
//   question           a job on that thread that ended, or was parked on a question, at or before the
//                      line — the two ways the sentry raises this rule.
//   question-closed    a job on that thread whose question was settled at or before the line.
function coveredBy(line, at, index) {
  const t = line.thread || null;
  switch (line.kind) {
    case "spawned":
      return index.spawnThreads.has(t);
    case "said":
    case "asked":
      return anyWithin(index.starts.get(index.assistantThread), at, SAME_TICK_MS, { before: true });
    case "answered-question":
      return anyWithin(index.answered.get(t), at, AFTER_TURN_MS, { before: true });
    case "question":
      return anyWithin(index.ended.get(t), at, AFTER_TURN_MS, { before: true }) || anyWithin(index.parked.get(t), at, AFTER_TURN_MS, { before: true });
    case "question-closed":
      return anyWithin(index.answered.get(t), at, AFTER_TURN_MS, { before: true });
    default:
      return false;
  }
}

// What a journal line means once it is shown on its own. `said` is the assistant's own thread: the line
// is either a wake's reason ("woken: …") or the reader's own message, and the recorded text says which.
function journalEntry(line, i, { assistantThread }) {
  const at = msOf(line.at);
  const text = cut(line.text, MESSAGE_TEXT_CAP);
  const thread = line.thread || (line.kind === "said" || line.kind === "asked" ? assistantThread : null);
  const base = { id: `journal:${i}`, at: isoOf(at), thread, text, source: "journal", kind: line.kind };
  if (line.kind === "spawned") return { ...base, dir: "out", from: "assistant", kind: "spawn" };
  if (line.kind === "asked") return { ...base, dir: "out", from: "assistant", kind: "asked" };
  if (line.kind === "answered-question") return { ...base, dir: "out", from: "panel", kind: "answer" };
  if (line.kind === "said") {
    const woken = /^woken:/i.test(text);
    return { ...base, dir: "out", from: woken ? "assistant" : "you", kind: "said" };
  }
  return { ...base, dir: "in", from: "agent" };
}

// ---- the board ------------------------------------------------------------------------------------

/**
 * Build the message board, as the tab reads it.
 *
 * @param summaries - `Jobs.list()`: the job summaries the board already holds.
 * @param records - `(id) => raw job | null`: the store's own record, for the one field the summary drops
 *   (the run's `finalMessage`). Optional; a missing record only costs the last-word fallback.
 * @param journal - the assistant's journal entries ({at, kind, thread, text}).
 * @param alerts - the assistant's alerts, for the thread a wake was about and a parked question's text.
 * @param assistantThread - the assistant's own thread id.
 * @param now - the clock, in ms (injected so the window is testable).
 * @param days / cap / textCap - the window and the two caps.
 * @returns {{at, windowDays, since, cap, textCap, total, shown, capped, dropped, counts, groups, threads}}
 */
export function buildMessages({
  summaries = [],
  records = () => null,
  journal = [],
  alerts = [],
  assistantThread = "panel-assistant",
  now = Date.now(),
  days = MESSAGE_WINDOW_DAYS,
  cap = MESSAGE_CAP,
  textCap = MESSAGE_TEXT_CAP,
} = {}) {
  const since = now - Math.max(1, days) * DAY_MS;
  const inWindow = (t) => t !== null && t >= since && t <= now + 60_000; // a clock a minute ahead is not a reason to hide a message

  // The index the journal fold reads: per thread, the times the store can account for.
  const index = {
    assistantThread,
    spawnThreads: new Set(),
    starts: new Map(),
    ended: new Map(),
    parked: new Map(),
    answered: new Map(),
  };
  const push = (map, thread, t) => {
    if (t === null || !thread) return;
    map.set(thread, [...(map.get(thread) || []), t]);
  };

  const entries = [];
  const threadInfo = new Map();
  const noteThread = (thread, s, at) => {
    if (!thread) return;
    const cur = threadInfo.get(thread) || { thread, name: null, project: null, worktree: null, branch: null, assistant: thread === assistantThread, newest: 0, count: 0 };
    if (s && (!cur.name || at >= cur.newest)) {
      cur.name = thread === assistantThread ? "the assistant" : nameOf(s);
      cur.project = s.projectPath ? leafPath(s.projectPath, 1) : cur.project;
      cur.worktree = s.worktreePath ? fwd(s.worktreePath) : cur.worktree;
      cur.branch = s.branch || cur.branch;
    }
    cur.newest = Math.max(cur.newest, at);
    threadInfo.set(thread, cur);
  };

  for (const s of summaries) {
    const at = msOf(s?.startedAt);
    if (at === null) continue;
    const origin = s.origin && typeof s.origin === "object" ? s.origin : null;
    const kind = origin?.kind || null;
    const thread = s.thread || null;
    const onAssistant = thread === assistantThread;
    let out;
    if (kind === "assistant-spawn") out = { dir: "out", from: "assistant", kind: "spawn", thread };
    else if (kind === "assistant-wake") out = { dir: "out", from: "assistant", kind: "wake", thread: wakeThread(origin, alerts, thread) };
    else if (kind === "assistant-reply") out = { dir: "out", from: origin.by === "reader" ? "you" : "assistant", kind: "reply", thread };
    // No origin at all: nobody but the reader starts a turn this way. On the assistant's own thread it is
    // the reader talking to the assistant; on a worker's thread it is the reader's own click on that
    // card, and it is the reader's message — never the assistant's words.
    else if (onAssistant) out = { dir: "out", from: "you", kind: "said", thread };
    else out = { dir: "out", from: "you", kind: s.reply ? "reply" : "spawn", thread };

    const wakeReason = kind === "assistant-wake" ? String(origin.reason || "").trim() : "";
    const outText = wakeReason || String(s.prompt || "");
    entries.push({
      id: `job:${s.id}:out`,
      at: isoOf(at),
      atMs: at,
      dir: out.dir,
      from: out.from,
      kind: out.kind,
      thread: out.thread,
      text: cut(outText, textCap),
      clipped: outText.length > textCap,
      source: "job",
      job: s.id,
      run: s.runId || null,
      status: s.status || null,
      live: LIVE_STATUS.has(String(s.status || "")),
      name: nameOf(s),
      project: s.projectPath ? leafPath(s.projectPath, 1) : null,
      worktree: s.worktreePath ? fwd(s.worktreePath) : s.ownerPath ? fwd(s.ownerPath) : null,
      branch: s.branch || null,
      // A wake's own thread is where it ran; the thread it was woken about is where it is filed, and a
      // reader has to be told which of the two they are looking at.
      ranIn: thread,
    });
    noteThread(out.thread, s, at);
    if (thread) push(index.starts, thread, at);
    if (kind === "assistant-spawn" && thread) index.spawnThreads.add(thread);

    // ---- and what came back -------------------------------------------------------------------
    const ended = !LIVE_STATUS.has(String(s.status || ""));
    const endedAt = ended ? (msOf(s.endedAt) ?? msOf((s.lines || []).at?.(-1)?.at) ?? at) : null;
    if (ended && endedAt !== null) {
      const rec = (() => {
        try {
          return records(s.id) || null;
        } catch {
          return null;
        }
      })();
      const words = lastWords({ finalMessage: rec?.finalMessage || "", lines: s.lines || [] });
      const completion = completionOf(s);
      const report = reportFor(s);
      entries.push({
        id: `job:${s.id}:in`,
        at: isoOf(endedAt),
        atMs: endedAt,
        dir: "in",
        from: "agent",
        kind: "final",
        thread,
        text: cut(words.text, textCap),
        clipped: words.text.length > textCap,
        source: "job",
        job: s.id,
        status: s.status || null,
        // What the words are: the run's own final message, or the tail of its transcript when it published
        // none. A run that left neither says so rather than reading as an empty answer.
        wordsFrom: words.source,
        empty: !String(words.text || "").trim(),
        name: nameOf(s),
        completion,
        report,
      });
      if (endedAt !== null) push(index.ended, thread, endedAt);
    }

    const question = questionFor(s, alerts);
    if (question && question.at !== null && inWindow(question.at)) {
      entries.push({
        id: `job:${s.id}:q`,
        at: isoOf(question.at),
        atMs: question.at,
        dir: "in",
        from: "agent",
        kind: "question",
        thread,
        text: cut(question.text, textCap),
        source: "job",
        job: s.id,
        status: s.status || null,
        live: LIVE_STATUS.has(String(s.status || "")),
        name: nameOf(s),
        question: {
          choices: question.choices,
          multiSelect: question.multiSelect,
          answered: question.answered,
          withdrawn: question.withdrawn,
          answer: cut(question.answer, 1000),
          recovered: question.recovered,
        },
      });
      noteThread(thread, s, question.at);
      push(index.parked, thread, question.at);
    }
    if (s.questionDone) {
      const answeredAt = msOf(s.questionDone.at);
      if (answeredAt !== null && inWindow(answeredAt)) {
        const answer = String(s.questionDone.answer || "").trim();
        entries.push({
          id: `job:${s.id}:a`,
          at: isoOf(answeredAt),
          atMs: answeredAt,
          dir: "out",
          from: "panel",
          kind: "answer",
          thread,
          // An answer with no text is not an empty answer: the question left without one (a stop, a
          // timeout, or an answer given on another surface), and the entry says which.
          text: answer ? cut(answer, textCap) : "",
          source: "job",
          job: s.id,
          status: s.status || null,
          name: nameOf(s),
          withdrawn: !answer,
        });
        noteThread(thread, s, answeredAt);
        push(index.answered, thread, answeredAt);
      }
    }
  }

  // ---- the journal's own message kinds, where the store no longer accounts for them -----------------
  (journal || []).forEach((line, i) => {
    if (!line || !MESSAGE_JOURNAL_KINDS.has(line.kind)) return;
    const at = msOf(line.at);
    if (at === null || !inWindow(at)) return;
    if (coveredBy(line, at, index)) return;
    const e = journalEntry(line, i, { assistantThread });
    if (e.thread) {
      entries.push({ ...e, atMs: at, name: e.thread === assistantThread ? "the assistant" : e.thread });
      noteThread(e.thread, null, at);
    } else {
      // A journal line that names no thread and is not a `said` line: it is still the assistant's own
      // record, so it is filed under the assistant's thread rather than dropped.
      entries.push({ ...e, thread: assistantThread, atMs: at, name: "the assistant" });
      noteThread(assistantThread, null, at);
    }
  });

  // ---- the window, the cap, and the shape the tab reads --------------------------------------------
  // Every entry is judged on its OWN timestamp: nothing older than the window is shown, whatever record
  // it came from, and the boundary is not the file's or the run's age.
  const ordered = entries
    .filter((e) => inWindow(e.atMs))
    .sort((a, b) => b.atMs - a.atMs || String(a.id).localeCompare(String(b.id)));
  const shown = ordered.slice(0, Math.max(1, cap));
  const dropped = ordered.length - shown.length;
  const groups = new Map();
  for (const e of shown) {
    const key = e.thread || "";
    const g = groups.get(key) || {
      thread: e.thread,
      name: (threadInfo.get(key) || {}).name || (e.thread === assistantThread ? "the assistant" : e.thread),
      project: (threadInfo.get(key) || {}).project || null,
      worktree: (threadInfo.get(key) || {}).worktree || null,
      branch: (threadInfo.get(key) || {}).branch || null,
      assistant: e.thread === assistantThread,
      entries: [],
      newest: 0,
      oldest: 0,
    };
    g.entries.push(e);
    g.newest = Math.max(g.newest, e.atMs);
    g.oldest = g.oldest ? Math.min(g.oldest, e.atMs) : e.atMs;
    groups.set(key, g);
  }
  // Inside a thread oldest → newest, so an exchange reads as a conversation; the threads themselves with
  // the newest activity first, so the live work is at the top.
  const list = [...groups.values()]
    .map((g) => {
      g.entries.sort((a, b) => a.atMs - b.atMs || String(a.id).localeCompare(String(b.id)));
      g.count = g.entries.length;
      g.newestIso = isoOf(g.newest);
      g.oldestIso = isoOf(g.oldest);
      for (const e of g.entries) delete e.atMs;
      return g;
    })
    .sort((a, b) => b.newest - a.newest || String(a.name).localeCompare(String(b.name)));

  const flat = list.flatMap((g) => g.entries);
  return {
    at: isoOf(now),
    windowDays: Math.max(1, days),
    since: isoOf(since),
    cap: Math.max(1, cap),
    textCap,
    // The vocabulary, once: the page renders each entry's `label` and `hint` from here, so a kind added
    // below shows up in the tab without a second list in public/assistant.js to keep in step.
    kinds: MESSAGE_KINDS,
    total: ordered.length,
    shown: flat.length,
    capped: dropped > 0,
    dropped,
    counts: {
      out: flat.filter((e) => e.dir === "out").length,
      in: flat.filter((e) => e.dir === "in").length,
      threads: list.length,
      jobs: summaries.length,
      journal: (journal || []).length,
      fromJournal: flat.filter((e) => e.source === "journal").length,
    },
    groups: list,
  };
}
