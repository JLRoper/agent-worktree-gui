// The board's assistant.
//
// Two layers, deliberately:
//
//   1. A sentry that runs in this process on its own clock, over the job summaries the panel already
//      holds. It costs nothing and it is always awake. Its whole job is to turn "something looks off"
//      into a small, specific claim with evidence attached: the same terminal call five times, the same
//      error four times, two agents in one tree, a question nobody answered.
//   2. One Hermes thread the reader talks to, which is a normal agent card (console, reply box, steer)
//      rendered inside the floating assistant panel. It is woken with a digest when a rule says so, or
//      when the reader asks it something.
//
// The sentry never acts on a worker by itself. Every action it can take is a *draft* until the reader
// sets a more aggressive autonomy, and an approval is never answerable from here at all - that boundary
// is the gateway's, and this module does not have a code path for it.
//
// The scratchpad (watches, standing rules, freeform notes, the journal) is one JSON file beside the job
// store, so it survives a restart, and a second panel instance with its own config keeps its own.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { completionEvidence, renderCompletionNotice, terminalKey, wordForStatus } from "./completion.js";

// A fixed thread id, not a generated one: the panel has to find this conversation again after a
// restart (and after a jobs-file reset), and a name derived from the first prompt would not survive
// either. It is still just a Hermes session id like any other.
export const ASSISTANT_THREAD = "panel-assistant";

// Rule ids, the one-line description the page shows, and the escalation each one starts at.
//   log    journal only - the page never shows it
//   alert  the assistant's badge and alerts list
//   wake   alert, plus the assistant is handed a digest and asked what it thinks (rate limited)
//   act    wake, and the assistant may send a reply when it produces one (still gated by autonomy)
export const RULE_DEFS = {
  loop: { label: "Same call repeating", hint: "the same tool with the same input, over and over in one turn", default: "alert" },
  errorloop: { label: "Same error repeating", hint: "identical failing output several times in one turn", default: "alert" },
  quiet: { label: "No new output", hint: "a running turn has produced nothing for a while - a long build looks the same, so this is quiet by default", default: "log" },
  approval: { label: "Parked on approval", hint: "a flagged command has been waiting on you for longer than the threshold", default: "alert" },
  question: { label: "Worker asked you something", hint: "a turn parked on the clarify tool, or ended on a question in prose — answered from a standing rule when one fits, drafted, or left for you", default: "alert" },
  noevidence: { label: "Done with no evidence", hint: "an implementation-sounding turn finished without touching a file and without a deliverable", default: "log" },
  collision: { label: "Two agents in one tree", hint: "two live turns share a worktree", default: "alert" },
  context: { label: "Context nearly full", hint: "a live turn is close to its context ceiling", default: "log" },
  repeat: { label: "Same failure across turns", hint: "a thread has come back to the same failure in consecutive turns — a reply or a steer that did not change the outcome", default: "alert" },
  leftover: { label: "Uncommitted work in a finished tree", hint: "a worker ended and its worktree still holds modified or untracked files — commits not on main are the normal state until you merge them, so they are context, not a trigger", default: "alert" },
  child: { label: "Subagent with no activity", hint: "a delegated child has written nothing for a while — say \"no activity\", never \"hung\": a long tool call looks the same", default: "alert" },
  // Alert, not wake, on purpose: a panel restart rewrites every running job as `interrupted` in one pass, so a wake
  // default would spend the whole `maxWakesPerHour` budget (6) on a single restart. The reader raises it per rule in
  // Settings when a cut-off turn is worth the assistant's opinion.
  interrupted: { label: "Turn ended interrupted", hint: "a turn stopped without finishing — usually a panel restart; check whether its work is already committed or merged before reviving it", default: "alert" },
  // A watch is the reader explicitly asking to be told; an alert alone is a notice nobody reads. A watch that
  // expires or finishes therefore wakes the assistant by default, which then reports what it sees.
  watch: { label: "Watch finished or overdue", hint: "something you asked the assistant to keep an eye on has finished or run past its deadline", default: "wake" },
};

// What to ask the assistant for when a rule wakes it. "Say what you make of it" produced replies that restated
// the alert; each rule now carries the one thing worth doing about it.
const WAKE_HINTS = {
  watch: "look at that worker's latest output: if it is still moving say what it is doing, if it has finished say how it ended, and if it looks stuck say what you would steer it with.",
  loop: "say what it is repeating and what you would change; a TO line drafts the steer.",
  errorloop: "say what the failure is and what you would try; a TO line drafts the steer.",
  approval: "say what the command does in one line. Do not answer the approval — that stays on the agent's own card.",
  question: "draft the answer with TO only if your rules or notes cover it; otherwise say what you would send.",
  collision: "say which tree they share and which one you would move.",
  quiet: "say whether it looks stalled or just slow, and what you would check.",
  context: "say whether it is worth finishing this turn or starting a fresh one.",
  noevidence: "say what evidence is missing and what you would ask the worker for.",
  repeat: "say what keeps failing and what you would change; a TO line drafts the steer, and if the fix belongs somewhere else, SPAWN a worker for it.",
  leftover: "say what is left in that tree and what you would do with it — commit it, merge it, or drop it; SPAWN IN that directory starts a worker on it if it needs finishing.",
  child: "say what the child was doing and whether you would wait or have its parent called off; you cannot reach a child directly, only through its parent.",
  interrupted: "say whether that turn's work is already committed or merged, and whether the thread needs its one resume; a TO line drafts the revive.",
};

export const ESCALATIONS = ["log", "alert", "wake", "act"];
export const AUTONOMY = ["draft", "auto-safe", "auto"];
export const SPAWN_MODES = ["off", "ask", "auto"];

const DEFAULTS = {
  enabled: true,
  // draft: nothing is ever sent to a worker without a click.
  // auto-safe: a reply the ASSISTANT itself wrote is sent; rule-derived drafts are still drafts.
  // auto: any draft this module has text for is sent.
  autonomy: "draft",
  // Creating a worktree and starting a worker is a bigger act than replying, so it has its own switch:
  // off - it may not propose one; ask - a SPAWN line becomes a card you confirm; auto - it starts at once.
  spawn: "ask",
  model: "",
  // Where the assistant's own turns run. It does no work in a directory, but the gateway refuses a run
  // without an existing cwd, so it gets one of its own instead of borrowing a project checkout that may be
  // gone (a live panel failed every turn with "cwd is not an existing directory"). Empty means: a folder
  // beside the job store, created on demand.
  cwd: "",
  seconds: 5,
  repeatLimit: 3,
  quietSeconds: 240,
  approvalSeconds: 120,
  contextPercent: 90,
  // How recently a turn must have ended for its leftover work to be worth mentioning, and how long a delegated
  // child may be silent before it is worth a look.
  leftoverMinutes: 15,
  childQuietSeconds: 300,
  // How many consecutive turns of one thread must end on the same failure before that is worth saying.
  repeatTurns: 3,
  maxWakesPerHour: 6,
  // A rule that has fired for a subject does not fire again for it inside this window.
  rearmSeconds: 900,
  rules: Object.fromEntries(Object.entries(RULE_DEFS).map(([id, def]) => [id, def.default])),
};

const ALERT_CAP = 80;
const JOURNAL_CAP = 300;
const LINE_CAP = 8000;
const MAX_LINES = 60;

const clip = (s, n = 160) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const nowIso = () => new Date().toISOString();
const normPath = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

// ---------------------------------------------------------------------------------------------
// Reading a turn's console the way a person would

// "💻 terminal · npm test" -> { tool: "terminal", input: "npm test" }
const TOOL_RE = /^\s*\S+\s+([A-Za-z][\w.-]*)\s*(?:·\s*([\s\S]*))?$/;
export function parseToolLine(line) {
  if (!line || line.kind !== "tool") return null;
  const text = String(line.text || "");
  const m = TOOL_RE.exec(text);
  if (!m) return null;
  return { tool: m[1].toLowerCase(), input: clip(m[2] || "", 180), at: Number(line.at) || 0 };
}

function toolSigs(lines) {
  const out = [];
  for (const l of lines || []) {
    const t = parseToolLine(l);
    if (t) out.push({ ...t, key: `${t.tool}|${t.input}` });
  }
  return out;
}

// The same call with the same input, N times. Read-only helpers are held to a higher bar: reading one
// file twice is ordinary, reading it six times is a loop with extra steps.
const READONLY = new Set(["read_file", "search_files", "skills_list", "skill_view", "todo_list"]);
export function detectRepeat(lines, limit = 3) {
  const counts = new Map();
  for (const s of toolSigs(lines)) {
    const cur = counts.get(s.key) || { ...s, count: 0, firstAt: 0, lastAt: 0, indexes: [] };
    cur.count += 1;
    cur.firstAt = cur.firstAt || s.at;
    cur.lastAt = s.at || cur.lastAt;
    counts.set(s.key, cur);
  }
  let best = null;
  for (const c of counts.values()) {
    const bar = READONLY.has(c.tool) ? limit + 2 : limit;
    if (c.count >= bar && (!best || c.count > best.count)) best = c;
  }
  return best;
}

// A → B → C → A → B → C, where no single call repeats enough to be caught above.
export function detectCycle(lines, { minRepeats = 3, maxLen = 4 } = {}) {
  const keys = toolSigs(lines).map((s) => s.key);
  if (keys.length < 6) return null;
  for (let len = 2; len <= maxLen; len += 1) {
    const tail = keys.slice(-len);
    if (new Set(tail).size < 2) continue; // one call repeated is detectRepeat's case
    let repeats = 0;
    for (let end = keys.length; end - len >= 0; end -= len) {
      const seg = keys.slice(end - len, end);
      if (seg.join(">") !== tail.join(">")) break;
      repeats += 1;
    }
    if (repeats >= minRepeats) {
      const calls = toolSigs(lines).slice(-len);
      return { repeats, len, calls };
    }
  }
  return null;
}

// A tool result that failed. Two shapes on the wire: terminal output carries "(exit 1)" (or "(error: …)"), and any
// tool whose result came back with the error flag gets it in the result HEADER — "  ↳ terminal · error". The header
// is the only signal when the result preview is empty, which is common for a command that wrote nothing.
export function isFailureLine(text) {
  const t = String(text || "");
  if (/\(exit\s+[1-9]\d*\)|\(error:|^error:/i.test(t)) return true;
  return /^\s*↳\s+/.test(t) && /·\s*error\s*$/i.test(t);
}

// Identical failure output. Terminal results carry "(exit 1)"; anything else that says error: counts.
export function detectErrorRepeat(lines, limit = 3) {
  const counts = new Map();
  for (const l of lines || []) {
    if (l.kind !== "tool-out") continue;
    const text = String(l.text || "");
    if (!isFailureLine(text)) continue;
    // Digits are usually a line number or a duration; the shape of the failure is what repeats.
    const key = clip(text.replace(/\d+/g, "#").replace(/\s+/g, " ").trim(), 180);
    if (!key) continue;
    const cur = counts.get(key) || { key, count: 0, at: 0 };
    cur.count += 1;
    cur.at = Number(l.at) || cur.at;
    counts.set(key, cur);
  }
  let best = null;
  for (const c of counts.values()) if (c.count >= limit && (!best || c.count > best.count)) best = c;
  return best;
}

// Where a turn ended up when it failed: the call that produced the last failing result, plus the failing line with
// its numbers masked. "npm test · Tests failed: 2" from three turns in a row is the same place; "npm test" alone
// would collide with every command that exits non-zero.
export function turnFailure(j) {
  const lines = j?.lines || [];
  let call = null;
  let failure = null;
  for (const l of lines) {
    const t = parseToolLine(l);
    if (t) {
      call = `${t.tool}|${t.input}`;
      continue;
    }
    if (l.kind !== "tool-out") continue;
    const text = String(l.text || "");
    if (!isFailureLine(text)) continue;
    failure = { call, text };
  }
  if (failure) {
    const detail = failure.text
      .replace(/\(exit\s+\d+\)/i, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\d+/g, "#");
    return `fail:${failure.call || "?"}|${clip(detail, 120)}`;
  }
  // A turn that ended badly with no failing line: the call it kept repeating is the same place.
  if (["failed", "cancelled", "interrupted"].includes(String(j?.status))) {
    const rep = detectRepeat(lines, 2);
    if (rep) return `call:${rep.key}`;
  }
  return null;
}

// A turn that ended on a question: the last prose paragraph asks something, or the whole answer is
// short and ends with a question mark. Deliberately conservative - a question mark mid-paragraph is
// usually rhetoric, and waking the reader for that is worse than missing one.
const ASK_RE = /\b(should i|shall i|do you want|would you like|which (?:one|option|approach|way)|can you (?:confirm|clarify|tell me)|let me know (?:if|whether|which)|your call|confirm (?:whether|which)|go ahead\?)/i;
export function looksLikeQuestion(answer) {
  const text = String(answer || "").trim();
  if (!text) return null;
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const tail = paras.slice(-2).join(" ").trim();
  const last = clip(tail, 400);
  const endsAsk = /[?]\s*["')\]]*\s*$/.test(tail);
  const saysAsk = ASK_RE.test(tail);
  if (!endsAsk && !saysAsk) return null;
  return { text: last, endsAsk, saysAsk };
}

// A turn that sounds like work but left no trace of work. "Evidence" here is a tool that can change
// something plus any file deliverable; a pure answer to a question is not supposed to have any.
const WORK_WORDS = /\b(implement|add|build|create|fix|refactor|change|update|migrate|write|remove|rename|wire|port|patch|test|debug)\b/i;
const WRITE_TOOLS = new Set(["write_file", "patch", "terminal", "execute_code", "skill_manage", "cronjob_manage", "browser_exec", "delegate_task"]);
export function looksLikeBareWork(prompt, lines, artifacts) {
  if (!WORK_WORDS.test(String(prompt || ""))) return null;
  if (Array.isArray(artifacts) && artifacts.length) return null;
  const called = new Set(toolSigs(lines).map((s) => s.tool));
  for (const t of called) if (WRITE_TOOLS.has(t)) return null;
  return { tools: [...called] };
}

// Standing rules are the assistant's only source of confidence that is not a guess: a rule the reader
// wrote down that shares real words with the question. Two shared content words is the bar.
const STOP = new Set("the a an and or of to in on for with from by is are was were be been do does did i you we they it this that my your our their if then than as at not no yes can could should would will shall please let me know what which who when where why how about into over under".split(" "));
// Two-letter words count: "QA", "CI", "DB", "UI" are exactly the words a rule about a choice turns on, and a
// tokenizer that drops them silently loses the match. The stopword list above is what keeps prose out.
const words = (s) => new Set(String(s || "").toLowerCase().match(/[a-z][a-z0-9_.-]+/g)?.filter((w) => !STOP.has(w)) || []);
export function matchRule(question, rules) {
  const q = words(question);
  let best = null;
  for (const r of rules || []) {
    const rw = words(r.text);
    let shared = 0;
    for (const w of rw) if (q.has(w)) shared += 1;
    if (shared >= 2 && (!best || shared > best.shared)) best = { rule: r, shared };
  }
  return best;
}

// A standing rule that names one of the offered choices is a confident answer: the rule says "deploy to QA" and the
// tool offers "QA" as a choice, so sending that choice is exactly what the reader would have clicked. Anything less
// — a rule about the topic, or a choice that appears alongside a second one in the same rule — stays a draft.
export function pickChoice(question, rules) {
  const rule = matchRule(String(question?.question || ""), rules)?.rule || null;
  if (!rule) return null;
  const choices = Array.isArray(question?.choices) ? question.choices : [];
  if (!choices.length) return null;
  const hits = choices.filter((c) => {
    const needle = String(c).replace(/\s*\(Recommended\)\s*$/i, "").trim().toLowerCase();
    if (!needle) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(String(rule.text));
  });
  return hits.length === 1 ? { rule, choice: hits[0] } : null;
}

// Lines the assistant writes at the end of its reply are how it acts on the board. It has no tool for
// this: the panel reads these three prefixes and does the rest, so what it can do is exactly what is
// written down here.
export function parseActions(text) {
  const out = { to: [], watch: [], note: [], spawn: [], rule: [] };
  for (const line of String(text || "").split(/\r?\n/)) {
    const to = /^\s*TO\s+([A-Za-z0-9._:-]+)\s*:\s*(.+)$/.exec(line);
    if (to) {
      out.to.push({ thread: to[1], text: clip(to[2], 2000) });
      continue;
    }
    // SPAWN <project> | <prompt>   or   SPAWN IN <directory> | <prompt>
    // The pipe is the separator on purpose: a project may be a Windows path (`C:/…`), so a colon there
    // cannot also be the field break.
    const sp = /^\s*SPAWN\s+(.+?)\s*\|\s*(.+)$/i.exec(line);
    if (sp) {
      let target = sp[1].trim().replace(/^["']|["']$/g, "");
      let existing = false;
      const inside = /^IN\s+(.+)$/i.exec(target);
      if (inside) {
        existing = true;
        target = inside[1].trim().replace(/^["']|["']$/g, "");
      }
      out.spawn.push({ target, existing, prompt: clip(sp[2], 2000) });
      continue;
    }
    const w = /^\s*WATCH\s+([A-Za-z0-9._:-]+)\s*:\s*([^|]+?)\s*(?:\|\s*(\d+)\s*(?:m|min|minutes?)?\s*)?$/i.exec(line);
    if (w) {
      out.watch.push({ thread: w[1], title: clip(w[2], 140), minutes: w[3] ? Number(w[3]) : null });
      continue;
    }
    const n = /^\s*NOTE\s*:\s*(.+)$/i.exec(line);
    if (n) {
      out.note.push(clip(n[1], 500));
      continue;
    }
    // RULE: <text> — a standing rule the assistant may add for itself. Three separators, because a model
    // writes this line three ways: "RULE: x", "RULE - x", "RULE x". \b keeps "RULES ..." from matching.
    const ru = /^\s*RULE\b\s*(?:[:–—-]\s*)?(.+)$/i.exec(line);
    if (ru) out.rule.push(clip(ru[1], 400));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
export class Assistant {
  constructor({ config = {}, jobs, getProjects = () => [], getRows = () => [], getChildren = () => ({}), spawner = null, onEvent = () => {}, onLog = () => {} } = {}) {
    this.config = config;
    this.jobs = jobs;
    // What the assistant may cut a worktree in, and the one function that can do it. Both are injected:
    // this module decides WHEN, the server owns HOW (the project registry, the gateway probe, `git worktree add`).
    this.getProjects = getProjects;
    // Scanned worktree rows (dirty files, commits ahead, verdict) and the delegated children of live threads.
    // Both come from the panel's own findings rather than a second git or sqlite implementation.
    this.getRows = getRows;
    this.getChildren = getChildren;
    this.spawner = spawner;
    this.onEvent = onEvent;
    this.onLog = onLog;
    const dir = path.dirname(config.jobsFile || path.join(config.defaultCwd || process.cwd(), "logs", "jobs.json"));
    this.file = config.assistantFile || path.join(dir, "assistant.json");
    this.settings = { ...DEFAULTS, ...(config.assistant && typeof config.assistant === "object" ? stripConfig(config.assistant) : {}), rules: { ...DEFAULTS.rules } };
    this.notes = "";
    this.rules = [];
    this.watches = [];
    this.alerts = [];
    this.journal = [];
    this.wakes = [];
    this.pendingWake = [];
    this.wakeTimer = null;
    // Turns whose written actions have already been carried out. A finished turn is re-emitted whenever its
    // Hermes title lands (`sweepTitles`) or the panel reloads the job store, and re-reading its SPAWN/TO/NOTE
    // lines then would start a second worker or re-open a card the reader already answered.
    this.harvested = new Set();
    // thread -> the terminal result already handed to the assistant. One finish is one wake, however many
    // rules notice it (see `terminalClaim`).
    this.terminalWakes = new Map();
    this.persistTimer = null;
    this.dirty = false;
    this.timer = null;
    this.lastTickAt = 0;
    // The last reason the configured working directory could not be used, if it could not.
    this.cwdError = null;
    // One resume per process: a restart must not become a turn every time the watchdog runs. `resumedTurn`
    // remembers that a wake actually went out, so the panel does not call a clean restart "resumed".
    this.resumed = false;
    this.resumedTurn = null;
    this.migrated = false;
    this.load();
    if (this.migrated) this.persist();
  }

  // ---- storage ------------------------------------------------------------------------------

  load() {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      const s = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
      this.settings = {
        ...this.settings,
        ...pickSettings(s),
        rules: { ...DEFAULTS.rules, ...(s.rules && typeof s.rules === "object" ? pickRules(s.rules) : {}) },
      };
      // A persisted setting shadows the default forever, so a default that changes has to travel to existing
      // files explicitly. v2: `watch` started at "alert" and now starts at "wake" — a file written before that
      // change still carrying the old default is moved with it, once. (Someone who deliberately chose "alert"
      // is indistinguishable from someone who never chose; the setting is one select away.)
      if (Number(raw.version || 1) < 2 && this.settings.rules.watch === "alert") {
        this.settings.rules.watch = "wake";
        this.migrated = true;
      }
      this.notes = typeof raw.notes === "string" ? raw.notes.slice(0, LINE_CAP) : "";
      this.rules = Array.isArray(raw.rules) ? raw.rules.filter((r) => r && typeof r.text === "string").slice(-40) : [];
      this.watches = Array.isArray(raw.watches) ? raw.watches.filter((w) => w && w.id && w.thread).slice(-40) : [];
      this.alerts = Array.isArray(raw.alerts) ? raw.alerts.filter((a) => a && a.id && a.rule).slice(-ALERT_CAP) : [];
      this.journal = Array.isArray(raw.journal) ? raw.journal.filter(Boolean).slice(-JOURNAL_CAP) : [];
      this.harvested = new Set(Array.isArray(raw.harvested) ? raw.harvested.filter((x) => typeof x === "string").slice(-50) : []);
      // A restart must not re-announce a finish: the thread's terminal result is remembered, not re-derived.
      this.terminalWakes = new Map(
        Array.isArray(raw.terminalWakes) ? raw.terminalWakes.filter((e) => Array.isArray(e) && e.length === 2).slice(-100) : [],
      );
    } catch (err) {
      this.onLog(`assistant: could not read ${this.file} (${String((err && err.message) || err)}) — starting empty`);
    }
  }

  persist() {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.writeNow();
    }, 400);
    this.persistTimer.unref?.();
  }

  writeNow() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const body = JSON.stringify(
        {
          // 2: `watch` escalates to wake by default (see load()).
          version: 2,
          savedAt: nowIso(),
          settings: this.settings,
          notes: this.notes,
          rules: this.rules,
          watches: this.watches,
          alerts: this.alerts.slice(-ALERT_CAP),
          journal: this.journal.slice(-JOURNAL_CAP),
          harvested: [...this.harvested].slice(-50),
          terminalWakes: [...this.terminalWakes].slice(-100),
        },
        null,
        1,
      );
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, body);
      renameSync(tmp, this.file);
    } catch (err) {
      this.onLog(`assistant: could not write ${this.file}: ${String((err && err.message) || err)}`);
    }
  }

  // ---- what the page sees ---------------------------------------------------------------------

  state() {
    const now = Date.now();
    const cut = now - 3600_000;
    this.wakes = this.wakes.filter((t) => t > cut);
    return {
      thread: ASSISTANT_THREAD,
      enabled: this.settings.enabled,
      settings: this.settings,
      ruleDefs: RULE_DEFS,
      escalations: ESCALATIONS,
      autonomy: AUTONOMY,
      spawnModes: SPAWN_MODES,
      rules: this.rules,
      watches: this.watches,
      notes: this.notes,
      alerts: this.alerts.filter((a) => a.status === "open").sort((a, b) => String(b.at).localeCompare(String(a.at))),
      journal: this.journal.slice(-40).reverse(),
      running: this.assistantLive(),
      // The panel shows this instead of guessing: a sentry whose clock has stopped is otherwise
      // indistinguishable from a board with nothing wrong on it.
      health: {
        timerAlive: Boolean(this.timer),
        lastTickAt: this.lastTickAt || null,
        everySeconds: Math.max(2, num(this.settings.seconds, 5)),
        resumed: Boolean(this.resumedTurn),
      },
      wakes: { lastHour: this.wakes.length, limit: this.settings.maxWakesPerHour },
      wakePending: this.pendingWake.length,
      digest: this.digest(),
      at: now,
    };
  }

  emit() {
    this.onEvent({ type: "assistant", assistant: this.state() });
  }

  journalAdd(kind, thread, text) {
    this.journal.push({ at: nowIso(), kind, thread: thread || null, text: clip(text, 500) });
    if (this.journal.length > JOURNAL_CAP) this.journal.splice(0, this.journal.length - JOURNAL_CAP);
    this.persist();
  }

  // ---- the clock ----------------------------------------------------------------------------

  start() {
    if (this.timer) return;
    const every = Math.max(2, num(this.settings.seconds, 5)) * 1000;
    this.timer = setInterval(() => this.tick(), every);
    this.timer.unref?.();
    // One pass shortly after boot, so a restart does not sit silent for a full interval while the
    // board already has something stuck in it.
    setTimeout(() => this.tick(), 2500).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // The watchdog's half. `tick()` catches its own errors, but a cleared timer, a throw while scheduling or
  // a clock that silently stopped is invisible from inside — so the server calls this from its own interval,
  // outside the sentry, and it repairs instead of reporting. Cheap: a field read unless something is wrong.
  supervise() {
    if (!this.settings.enabled) return { timer: Boolean(this.timer), restarted: false, stale: false };
    const every = Math.max(2, num(this.settings.seconds, 5)) * 1000;
    let restarted = false;
    if (!this.timer) {
      this.start();
      restarted = true;
      this.journalAdd("watchdog", null, "the sentry clock was not running; restarted it");
    }
    const stale = this.lastTickAt > 0 && Date.now() - this.lastTickAt > Math.max(15_000, every * 3);
    if (stale) {
      this.journalAdd("watchdog", null, `the sentry had not ticked for ${minutes(Date.now() - this.lastTickAt)}; ran a pass`);
      this.tick();
    }
    // Its own turn is the one job the sentry never looks at — `evaluate()` skips the assistant thread. A
    // hung turn is therefore worse than a hung worker: `assistantLive()` is true, so every future wake sits
    // in `pendingWake` behind it. Stop a turn that has produced nothing for four quiet-windows and hand the
    // board back to a fresh one; the queued wake goes out when the stop lands.
    let stalled = null;
    const mine = this.jobs.list().find((j) => j.thread === ASSISTANT_THREAD && isLive(j));
    if (mine) {
      const lastLine = (mine.lines || []).slice(-1)[0];
      const quiet = Date.now() - (lastLine?.at || Date.parse(mine.startedAt || nowIso()));
      const limit = Math.max(300_000, this.settings.quietSeconds * 1000 * 4);
      if (quiet > limit) {
        stalled = mine.id;
        this.journalAdd("stalled", ASSISTANT_THREAD, `turn ${mine.id} produced nothing for ${minutes(quiet)}; stopping it so the board is not blocked`);
        Promise.resolve(this.jobs.stop?.(mine.id)).catch((err) =>
          this.journalAdd("stalled", ASSISTANT_THREAD, `could not stop turn ${mine.id}: ${String((err && err.message) || err)}`),
        );
        this.wake(`your last turn produced nothing for ${minutes(quiet)} and was stopped — say where it had got to, and whether anything on the board needs a look now`, null, "resume");
      }
    }
    return { timer: Boolean(this.timer), restarted, stale, stalled };
  }

  // A restart is the one moment nothing else notices: `jobs.load()` turns every running job into
  // `interrupted`, including the assistant's own turn, and the sentry only ever looks at *worker* threads.
  // So on boot, if the assistant died mid-thought, wake it once with that fact. A clean restart (its last
  // turn finished) costs nothing — no speculative turn, no tokens.
  resumeAfterRestart() {
    if (!this.settings.enabled || this.resumed) return null;
    this.resumed = true;
    const mine = this.jobs.list().filter((j) => j.thread === ASSISTANT_THREAD);
    // `list()` is newest-first on this board (the store sorts for the page), so the newest turn is found by
    // its clock, not by its position — taking the last element picked the oldest turn and resumed nothing.
    const last = mine.reduce((a, b) => (!a || Date.parse(b.startedAt || 0) > Date.parse(a.startedAt || 0) ? b : a), null);
    if (!last || last.status !== "interrupted") return null;
    const age = minutes(Date.now() - Date.parse(last.startedAt || nowIso()));
    this.resumedTurn = last.id;
    this.journalAdd("resumed", ASSISTANT_THREAD, `the panel restarted while turn ${last.id} was running${age ? ` (started ${age} earlier)` : ""}`);
    this.wake(
      `the panel restarted while your last turn was still running${age ? ` (started ${age} earlier)` : ""} — say where you had got to, and whether anything on the board needs a look now that it is back`,
      null,
      "resume",
    );
    return last.id;
  }

  tick() {
    this.lastTickAt = Date.now();
    try {
      const list = this.jobs.list();
      if (this.settings.enabled) {
        this.evaluate(list);
        this.checkWatches(list);
      }
    } catch (err) {
      this.onLog(`assistant: tick failed: ${String((err && err.message) || err)}`);
    }
    this.writeNow();
  }

  // ---- rules --------------------------------------------------------------------------------

  // Escalation for a rule, and whether an alert is wanted at all.
  //
  // `notice` is the completion payload — what the run produced — which rides in the wake text but not in the
  // alert list, where evidence is one line per chip and the reader is not going to scroll a 16KB report.
  // `terminal` names the thread's terminal result when this alert IS one, so one finish cannot wake the
  // assistant twice (see `terminalClaim`).
  fired(rule, subject, { thread = null, turnId = null, title, detail, evidence = [], severity = "warn", draft = null, parked = false, choices = [], requestId = null, multiSelect = false, notice = "", terminal = null } = {}) {
    const level = this.settings.rules[rule] || RULE_DEFS[rule]?.default || "alert";
    if (level === "log") {
      this.journalAdd(rule, thread, detail || title);
      return null;
    }
    const key = `${rule}|${subject}`;
    const now = Date.now();
    const recent = this.alerts.find((a) => a.key === key && (a.status === "open" || now - Date.parse(a.at) < this.settings.rearmSeconds * 1000));
    if (recent) return null;
    const alert = {
      id: randomUUID().slice(0, 8),
      key,
      rule,
      severity,
      thread,
      turnId,
      title,
      detail,
      evidence,
      at: nowIso(),
      status: "open",
      level,
      draft,
      // A question the run is parked on: answering it needs the clarify endpoint, not a reply.
      parked: Boolean(parked),
      choices: Array.isArray(choices) ? choices : [],
      requestId: requestId || null,
      multiSelect: Boolean(multiSelect),
    };
    this.alerts.push(alert);
    if (this.alerts.length > ALERT_CAP) this.alerts.splice(0, this.alerts.length - ALERT_CAP);
    this.journalAdd(rule, thread, detail || title);
    this.persist();
    if (level === "wake" || level === "act") {
      // One terminal wake per thread's finish: a worker's terminal result is a single event on this board, and
      // two rules can see the same one — a watch closing and a turn cut off mid-flight are the same finish. The
      // claim is taken HERE, where the wake is decided, so a rule the reader left at `alert` never spends it,
      // and the second rule's alert still lands in the list with its payload.
      if (!terminal || this.terminalClaim(terminal.thread, terminal.key)) {
        this.wake(`[${rule}] ${title}${detail ? ` — ${detail}` : ""}${notice ? `\n${notice}` : ""}`, alert.id, rule);
      } else {
        this.journalAdd("wake-once", thread, `${clip(title, 120)} — that finish had already been handed over, so this alert is not another wake`);
      }
    }
    this.emit();
    return alert;
  }

  // One terminal wake per thread's finish, remembered across restarts. The key names the TURN and the moment it
  // ended, so a later turn of the same thread (a reply, a revive) is a new terminal event and does wake again,
  // while the same turn seen by a second rule — or re-seen after a restart — never does.
  terminalClaim(thread, key) {
    const t = String(thread || "");
    if (!t || !key) return true; // nothing to claim against: an alert with no turn is not a terminal notice
    if (this.terminalWakes.get(t) === key) return false;
    this.terminalWakes.set(t, String(key));
    if (this.terminalWakes.size > 200) this.terminalWakes = new Map([...this.terminalWakes].slice(-100));
    this.persist();
    return true;
  }

  evaluate(list) {
    const workers = list.filter((j) => j.thread !== ASSISTANT_THREAD);
    const live = workers.filter(isLive);
    const now = Date.now();

    for (const j of live) {
      const lines = (j.lines || []).slice(-MAX_LINES);
      const label = nameOf(j);
      const age = now - Date.parse(j.startedAt || nowIso());

      const rep = detectRepeat(lines, this.settings.repeatLimit);
      const cycle = rep ? null : detectCycle(lines);
      if (rep || cycle) {
        const what = rep
          ? `${rep.tool} · ${clip(rep.input, 90)}`
          : cycle.calls.map((c) => c.tool).join(" → ");
        const count = rep ? rep.count : cycle.repeats;
        this.fired("loop", `${j.thread}|${j.id}|${what}`, {
          thread: j.thread,
          turnId: j.id,
          title: rep ? `${rep.tool} called ${count}× with the same input` : `${cycle.len}-call cycle repeated ${count}×`,
          detail: `${label}: ${what}`,
          evidence: [
            { label: "repeats", value: String(count) },
            { label: "in this turn", value: `${minutes(age)}` },
            { label: "call", value: clip(what, 140) },
          ],
          severity: "warn",
        });
      }

      const err = detectErrorRepeat(lines, this.settings.repeatLimit);
      if (err) {
        this.fired("errorloop", `${j.thread}|${j.id}|${err.key}`, {
          thread: j.thread,
          turnId: j.id,
          title: `the same failure ${err.count}×`,
          detail: `${label}: ${err.key}`,
          evidence: [
            { label: "repeats", value: String(err.count) },
            { label: "failure", value: clip(err.key, 140) },
          ],
          severity: "bad",
        });
      }

      const lastLineAt = lines.length ? Number(lines[lines.length - 1].at) || age : 0;
      const quietFor = lastLineAt ? now - lastLineAt : age;
      if (j.status === "running" && !j.question && quietFor >= this.settings.quietSeconds * 1000) {
        this.fired("quiet", `${j.thread}|${j.id}|${Math.floor(quietFor / 60000)}`, {
          thread: j.thread,
          turnId: j.id,
          title: `no new output for ${minutes(quietFor)}`,
          detail: `${label} is still marked running but has printed nothing new. A long build looks exactly like this.`,
          evidence: [
            { label: "last line", value: lines.length ? clip(lines[lines.length - 1].text, 120) : "(none yet)" },
            { label: "silent for", value: minutes(quietFor) },
          ],
          severity: "info",
        });
      }

      if (j.approval) {
        const at = Date.parse(j.approval.at || j.approval.requestedAt || j.startedAt || nowIso());
        const waited = now - at;
        if (waited >= this.settings.approvalSeconds * 1000) {
          this.fired("approval", `${j.thread}|${j.id}|${clip(j.approval.command || "", 80)}`, {
            thread: j.thread,
            turnId: j.id,
            title: `parked on approval for ${minutes(waited)}`,
            detail: `${label} is waiting on: ${clip(j.approval.command || j.approval.description || "(no command shown)", 160)}`,
            evidence: [
              { label: "waiting", value: minutes(waited) },
              { label: "command", value: clip(j.approval.command || "", 160) },
            ],
            severity: "bad",
          });
        }
      }

      // A turn parked on the clarify tool is blocked on a person exactly like an approval, and unlike a
      // question in prose this one holds the run open until somebody answers it. A standing rule that
      // names one of the offered choices answers it outright; anything else is put in front of the
      // reader with the box one click away. Keyed per request, so a long wait is one alert, not a tick each.
      if (j.question) {
        const waited = now - Date.parse(j.question.at || j.startedAt || nowIso());
        const pick = pickChoice(j.question, this.rules);
        const hit = pick ? pick.rule : matchRule(j.question.question, this.rules)?.rule || null;
        const choices = Array.isArray(j.question.choices) ? j.question.choices : [];
        const draft = {
          thread: j.thread,
          text: pick ? pick.choice : hit ? hit.text : "",
          confidence: pick ? "rule+choice" : hit ? "rule" : "none",
          source: pick ? `standing rule → “${clip(pick.choice, 60)}”` : hit ? "standing rule" : "needs you",
        };
        const subject = `${j.thread}|${j.id}|parked|${j.question.requestId || ""}`;
        const alert = this.fired("question", subject, {
          thread: j.thread,
          turnId: j.id,
          parked: true,
          choices,
          requestId: j.question.requestId || null,
          multiSelect: Boolean(j.question.multiSelect),
          title: `waiting on your answer: ${clip(j.question.question, 70)}`,
          detail: `${label} is parked on a question · waiting ${minutes(waited)} · ${choices.length ? `${choices.length} choices` : "free text"}`,
          evidence: [
            ...(choices.length
              ? [{ label: "choices", value: clip(choices.map((c) => String(c).replace(/\s*\(Recommended\)\s*$/i, "")).join(" · "), 200) }]
              : []),
            { label: "waiting", value: minutes(waited) },
          ],
          severity: "warn",
          draft,
        });
        // One alert per request id. A rule written while it is open still takes effect: the alert found
        // again here is the same question, so its draft is refreshed instead of a second alert appearing.
        const open = alert || this.alerts.find((a) => a.key === `question|${subject}` && a.status === "open") || null;
        if (open && (open.draft?.text !== draft.text || open.draft?.confidence !== draft.confidence)) {
          open.draft = draft;
          open.choices = choices;
          open.multiSelect = Boolean(j.question.multiSelect);
          this.persist();
          this.emit();
        }
        // Auto autonomy only sends what a standing rule named outright. A draft stays a draft: the
        // whole point of the confidence flag is that nothing guesses at a person's intent. `autoTried`
        // makes one attempt per alert, so a refusal cannot become a tick-by-tick retry.
        if (open && pick && this.settings.autonomy === "auto" && !open.autoTried) {
          open.autoTried = true;
          this.jobs
            .answerQuestion(j.id, pick.choice)
            .then((r) => {
              if (!r.ok) return this.journalAdd("answer-failed", j.thread, r.error || "the gateway refused the answer");
              open.status = "answered";
              open.closedAt = nowIso();
              open.answer = clip(pick.choice, 200);
              this.journalAdd("answered-question", j.thread, `“${clip(pick.choice, 120)}” from a standing rule`);
              this.persist();
              this.emit();
            })
            .catch((err) => this.journalAdd("answer-failed", j.thread, String((err && err.message) || err)));
        }
      }

      const pct = Number(j.stats?.context_percent);
      if (Number.isFinite(pct) && pct >= this.settings.contextPercent) {
        this.fired("context", `${j.thread}|${j.id}|${Math.round(pct)}`, {
          thread: j.thread,
          turnId: j.id,
          title: `context at ${Math.round(pct)}%`,
          detail: `${label} is close to its context ceiling — the next turn will compress or truncate.`,
          evidence: [{ label: "context", value: `${Math.round(pct)}%` }],
          severity: "info",
        });
      }
    }

    // A parked-question alert lives only as long as the question does. Answered on the card, on another
    // surface, withdrawn by a stop or timed out, it closes here with nothing to click — the same rule the
    // card's own box follows, so the float never offers an answer to a prompt that is already gone.
    {
      const byId = new Map(workers.map((j) => [j.id, j]));
      for (const a of this.alerts) {
        if (a.status !== "open" || !a.parked) continue;
        const job = byId.get(a.turnId);
        const still = Boolean(job?.question) && (!a.requestId || job.question.requestId === a.requestId);
        if (still) continue;
        a.status = "answered";
        a.closedAt = nowIso();
        this.journalAdd("question-closed", a.thread, `“${clip(a.title, 120)}” was answered or withdrawn`);
        this.persist();
      }
    }

    // Two live turns in one tree. Keyed on the pair, so the alert is one per collision, not one per tick.
    const byTree = new Map();
    for (const j of live) {
      const tree = normPath(j.ownerPath || j.cwd || "");
      if (!tree) continue;
      byTree.set(tree, [...(byTree.get(tree) || []), j]);
    }
    for (const [tree, group] of byTree) {
      if (group.length < 2) continue;
      // Two turns of one thread are that agent's own queue, not two agents in one tree.
      if (new Set(group.map((j) => j.thread)).size < 2) continue;
      const threads = group.map((j) => j.thread).sort();
      this.fired("collision", threads.join("+"), {
        thread: group[0].thread,
        title: `${group.length} agents live in one tree`,
        detail: `${group.map(nameOf).join(" · ")} are all working in ${tree}`,
        evidence: group.map((j) => ({ label: nameOf(j), value: j.thread })),
        severity: "warn",
      });
    }

    // Turns that ended a moment ago: the question and the bare-work checks are about a finish, and a
    // finish older than the window was already seen (or belongs to a previous run of the panel).
    for (const j of workers) {
      if (isLive(j)) continue;
      const ended = Date.parse(j.endedAt || 0);
      if (!ended || now - ended > 15 * 60_000) continue;
      const answer = lastProse(j.lines);
      const q = looksLikeQuestion(answer);
      if (q) {
        const hit = matchRule(q.text, this.rules);
        this.fired("question", `${j.thread}|${j.id}|${q.text.slice(0, 60)}`, {
          thread: j.thread,
          turnId: j.id,
          title: hit ? "asked something a standing rule covers" : "asked you a question",
          detail: `${nameOf(j)}: “${clip(q.text, 220)}”`,
          evidence: [
            { label: "answer", value: clip(answer, 220) },
            hit ? { label: "standing rule", value: clip(hit.rule.text, 160) } : { label: "no rule", value: "nothing written down covers this" },
          ],
          severity: hit ? "info" : "warn",
          draft: hit
            ? { thread: j.thread, text: hit.rule.text, confidence: "rule", source: "standing rule" }
            : { thread: j.thread, text: "", confidence: "none", source: "needs you" },
        });
      }
      const bare = looksLikeBareWork(j.prompt, j.lines, j.artifacts);
      if (bare && j.status === "done") {
        this.fired("noevidence", `${j.thread}|${j.id}`, {
          thread: j.thread,
          turnId: j.id,
          title: "finished with no evidence",
          detail: `${nameOf(j)} ended as done without writing a file or running anything — the answer is the only artifact.`,
          evidence: [
            { label: "tools used", value: bare.tools.length ? bare.tools.join(", ") : "none" },
            { label: "deliverables", value: "0 files" },
          ],
          severity: "info",
        });
      }
    }

    // A worker that finished and left its work sitting in the tree. The board already carries MERGE STATE per row;
    // this is the assistant noticing for a reader who is not looking at that row — which is how a finished agent's
    // uncommitted docs sat there until something else mentioned them.
    const rows = this.getRows();
    if (rows.length) {
      const byPath = new Map();
      for (const r of rows) byPath.set(normPath(r.path), r);
      for (const j of workers) {
        if (isLive(j)) continue;
        // Same rule as a watch: a job the panel stopped tracking still ended, on its last line.
        const ended = endedAtMs(j);
        if (!ended || now - ended > this.settings.leftoverMinutes * 60_000) continue;
        // The tree has to exist to hold anything. A deleted worktree leaves an empty directory behind, and git
        // run inside it answers for the *parent* repository (branch main, the reader's dirty files), which is
        // how a worker whose tree was gone was reported as leaving the reader's two untracked files behind.
        const treePath = j.worktreePath || j.ownerPath || j.cwd || "";
        if (!treePath || !existsSync(treePath)) continue;
        const row = byPath.get(normPath(treePath));
        if (!row) continue;
        // A thread running in the base checkout is not a worker with a tree of its own: its "uncommitted work"
        // is the reader's own working copy, and the files in it may predate the turn by weeks. That produced
        // "finished with uncommitted work — 2 untracked — branch main" for files the agent never touched, which
        // reads as an accusation. Leftover work is a worktree fact, so only worktree jobs are judged by it.
        if (j.baseCheckout) continue;
        if (!j.worktreePath && j.projectPath && normPath(row.path) === normPath(j.projectPath)) continue;
        const dirty = (row.dirtyFiles || []).length;
        const untracked = (row.untrackedFiles || []).length;
        const ahead = Number(row.ahead) || 0;
        // Uncommitted work is the signal. A branch carrying commits that are not on main is the normal state of an
        // agent's tree until the reader merges it — that is what the board's MERGE STATE is for, and alerting on it
        // would fire for every worker that ever committed anything.
        if (!dirty && !untracked) continue;
        const bits = [dirty ? `${dirty} modified` : null, untracked ? `${untracked} untracked` : null].filter(Boolean);
        this.fired("leftover", `${j.thread}|${dirty}|${untracked}`, {
          thread: j.thread,
          turnId: j.id,
          title: `${nameOf(j)} finished with uncommitted work`,
          detail:
            `${bits.join(" · ")} — ${row.branch ? `branch ${row.branch}` : clip(row.path, 100)}` +
            `${ahead ? ` · ${ahead} commit${ahead === 1 ? "" : "s"} not on main` : ""}${/MERGED|ON MAIN/i.test(String(row.verdict || "")) ? "" : ` · ${row.verdict || "not merged"}`}`,
          evidence: [
            { label: "tree", value: clip(row.path, 120) },
            { label: "left", value: bits.join(" · ") },
            { label: "verdict", value: String(row.verdict || "unknown") },
          ],
          severity: "warn",
        });
      }
    }

    // The same failure coming back turn after turn. `loop` sees one turn; this is the thread — the reader replied, the
    // agent tried again, and landed in the same place. Consecutive is the point: a turn that comes back clean breaks
    // the streak, because that is a reply that did change the outcome.
    const byThread = new Map();
    for (const j of workers) {
      const list = byThread.get(j.thread) || [];
      list.push(j);
      byThread.set(j.thread, list);
    }
    for (const [thread, turns] of byThread) {
      if (turns.length < this.settings.repeatTurns) continue;
      const ordered = turns
        .slice()
        .sort((a, b) => (Number(a.turn) || 0) - (Number(b.turn) || 0))
        .slice(-8);
      let sig = null;
      let streak = 0;
      let firstTurn = null;
      for (const t of ordered) {
        if (isLive(t)) continue; // a running turn has not finished failing yet
        const f = turnFailure(t);
        if (!f) {
          sig = null;
          streak = 0;
          firstTurn = null;
          continue;
        }
        if (f === sig) streak += 1;
        else {
          sig = f;
          streak = 1;
          firstTurn = t;
        }
      }
      if (!sig || streak < this.settings.repeatTurns) continue;
      const last = ordered[ordered.length - 1];
      const what = sig.replace(/^(fail|call):/, "").replace(/\|$/, "");
      this.fired("repeat", `${thread}|${sig}`, {
        thread,
        turnId: last?.id || null,
        title: `the same failure in ${streak} turns in a row`,
        detail: `${nameOf(last)} keeps ending on: ${clip(what, 200)}`,
        evidence: [
          { label: "turns", value: String(streak) },
          { label: "since", value: firstTurn?.turn ? `turn ${firstTurn.turn}` : "" },
          { label: "failure", value: clip(what, 160) },
        ],
        severity: "warn",
      });
    }

    // A turn cut off mid-flight. `jobs.load()` rewrites every running job as `interrupted` when the panel restarts,
    // so this is usually a restart rather than a worker that failed — and one restart stamps all of them at once.
    // Only a thread's LATEST turn is news: an interrupted turn a later turn has since taken over was dealt with by
    // that turn (a resume), and reporting it would hand the reader a restart's whole history as new findings.
    // "Latest" is the newest start time — see `newerTurn` for why `turn` cannot be trusted for that.
    const latestTurn = new Map();
    for (const j of workers) {
      const prev = latestTurn.get(j.thread);
      if (!prev || newerTurn(j, prev)) latestTurn.set(j.thread, j);
    }
    for (const [thread, j] of latestTurn) {
      if (j.status !== "interrupted") continue;
      // Same rule as a finish: the payload is only worth filing once the tree facts have landed.
      if (j.tree?.pending && now - Number(j.tree.at || now) < 30_000) continue;
      const stopped = endedAtMs(j);
      // The same payload a finish carries: a turn that stopped mid-flight is exactly the case where the
      // assistant has to know what the run had produced and whether that work is on the branch already.
      const payload = j.completion || null;
      const word = payload?.word || "interrupted";
      this.fired("interrupted", thread, {
        thread,
        turnId: j.id,
        title: `${nameOf(j)} did not finish`,
        detail:
          `${nameOf(j)} ended ${word} rather than finished${payload?.reason ? ` — ${payload.reason}` : " — usually a panel restart"}.` +
          " Check whether that turn's work is already committed or merged before reviving it.",
        evidence: [
          { label: "turn", value: j.id },
          { label: "endedAt", value: j.endedAt || "none — the panel restarted mid-run" },
          { label: "last activity", value: stopped ? `${minutes(now - stopped)} ago` : "unknown" },
          ...completionEvidence(payload),
        ],
        severity: "warn",
        notice: payload ? renderCompletionNotice(payload) : "",
        // The finish this alert is about, claimed once: if a watch on the same thread already woke the
        // assistant about this terminal result, this is an alert and a journal line, not a second wake.
        terminal: { thread, key: terminalKey(j) },
      });
    }

    // Delegated children. The gateway never puts a child's work on the parent's stream, so a child that has gone
    // quiet is invisible on the card. "No activity for 6m" is the honest wording: a long tool call looks identical.
    let roster = {};
    try {
      roster = this.getChildren() || {};
    } catch {
      roster = {};
    }
    const parentName = new Map(workers.map((j) => [j.thread, nameOf(j)]));
    for (const [parent, kids] of Object.entries(roster)) {
      // Only children of a thread this board is showing: the gateway store holds a day of sessions, including the
      // CLI's own, and the assistant watches this board.
      if (!parentName.has(parent)) continue;
      for (const k of Array.isArray(kids) ? kids : []) {
        if (!k || !k.running) continue;
        const silent = now - (Number(k.lastSeen) || now);
        if (silent < this.settings.childQuietSeconds * 1000) continue;
        this.fired("child", `${parent}|${k.id}`, {
          thread: parent,
          turnId: null,
          title: `subagent has produced nothing for ${minutes(silent)}`,
          detail: `${clip(k.title, 90)} (delegated by ${parentName.get(parent) || parent})${k.preview ? ` — last: ${clip(k.preview, 120)}` : ""}`,
          evidence: [
            { label: "child", value: clip(k.title, 100) },
            { label: "silent", value: minutes(silent) },
            { label: "messages", value: String(k.msgs || 0) },
          ],
          severity: "warn",
        });
      }
    }
  }

  checkWatches(list) {
    if (!this.watches.length) return;
    const now = Date.now();
    for (const w of this.watches) {
      if (w.state === "done") continue;
      const turns = list.filter((j) => j.thread === w.thread).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
      const latest = turns[0];
      const since = Date.parse(w.at || 0);
      const live = turns.some(isLive);
      // A turn is over when it ended — and also when the panel stopped watching it. A restart mid-run leaves the
      // job `interrupted` with no `endedAt`, and a watch on it used to sit at "watching" forever.
      const endedMs = endedAtMs(latest);
      const finished = Boolean(latest) && endedMs > since && !live;
      if (finished) {
        // A finish whose tree facts are still being measured is filed on the NEXT pass, not this one: a notice
        // that says "commits not measured" is worse than one that arrives three seconds later saying what is
        // actually in the tree. `tree.pending` is cleared by the measurement, and a measurement stuck past 30s
        // (a git call that will not answer) files it anyway rather than leaving the watch open forever. The
        // watch is left OPEN here, so nothing is lost — the next pass is the one that files it.
        if (latest.tree?.pending && now - Number(latest.tree.at || now) < 30_000) continue;
        w.state = "done";
        w.doneAt = nowIso();
        // What it produced, not just that it stopped. A watch is the reader asking to be told, and the notice
        // now carries the payload the run left behind: how it ended and on whose authority, how long it took,
        // where it worked, whether it left anything to merge, its last words, and the report it wrote if it
        // wrote one. `latest.completion` is built by the job store from the run's terminal result; a turn from
        // a store written before that existed still gets its status word mapped into the three the notice uses.
        const payload = latest.completion || null;
        const word = payload?.word || wordForStatus(latest.status);
        this.fired("watch", `${w.id}|finished`, {
          thread: w.thread,
          turnId: latest.id,
          title: `watch finished: ${clip(w.title, 90)}`,
          detail: `${nameOf(latest)} ended ${word}${payload?.reason ? ` — ${payload.reason}` : ""}${w.doneWhen ? ` — was watching for: ${clip(w.doneWhen, 120)}` : ""}`,
          evidence: [
            { label: "watching", value: clip(w.title, 140) },
            { label: "last line", value: clip(lastLine(latest), 140) },
            ...completionEvidence(payload),
          ],
          severity: word === "normal" ? "info" : "warn",
          notice: payload ? renderCompletionNotice(payload) : "",
          // One thread, one terminal wake: a second rule seeing this same finish does not wake again, and a
          // run merely sitting at its prompt (still live, nothing new) never reaches this branch at all.
          terminal: { thread: w.thread, key: terminalKey(latest) },
        });
        this.persist();
        continue;
      }
      if (w.minutes && now > since + Number(w.minutes) * 60_000 && live && w.state !== "alerted") {
        w.state = "alerted";
        w.alertedAt = nowIso();
        this.fired("watch", `${w.id}|overdue`, {
          thread: w.thread,
          title: `watch overdue: ${clip(w.title, 90)}`,
          detail: `${nameOf(latest)} is still running ${minutes(now - since)} after you asked to keep an eye on it.`,
          evidence: [
            { label: "watching", value: clip(w.title, 140) },
            { label: "deadline", value: `${w.minutes}m` },
            { label: "running for", value: minutes(now - since) },
          ],
          severity: "warn",
        });
        this.persist();
      }
    }
  }

  // ---- the assistant thread -----------------------------------------------------------------

  assistantLive() {
    return this.jobs.list().some((j) => j.thread === ASSISTANT_THREAD && isLive(j));
  }

  nameFor(thread) {
    const j = this.jobs.list().find((x) => x.thread === thread);
    return j ? nameOf(j) : thread;
  }

  // The board, compressed. This is what the assistant is handed on every turn: it is the difference
  // between "an assistant" and "a model with an opinion".
  digest() {
    const list = this.jobs.list().filter((j) => j.thread !== ASSISTANT_THREAD);
    const live = list.filter(isLive);
    const recent = list.filter((j) => !isLive(j)).slice(0, 5);
    const rows = [];
    for (const j of live.slice(0, 10)) {
      const sig = toolSigs(j.lines || []).slice(-3).map((s) => `${s.tool}${s.input ? `(${clip(s.input, 40)})` : ""}`).join(" → ");
      rows.push(
        `- ${nameOf(j)} [${j.thread}] ${j.status} ${minutes(Date.now() - Date.parse(j.startedAt || nowIso()))} · ` +
          `asked: ${clip(j.prompt, 100)}${sig ? ` · last calls: ${sig}` : ""}${j.approval ? ` · PARKED on: ${clip(j.approval.command, 80)}` : ""}`,
      );
    }
    for (const j of recent) rows.push(`- ${nameOf(j)} [${j.thread}] ${j.status} ${clip(j.prompt, 90)}`);
    if (!rows.length) rows.push("- (no agents on the board)");
    // A spawn that failed is the one fact the assistant cannot infer from the board: nothing appeared, so a
    // small model reads that as "still starting" and tells the reader it queued one. Say it outright.
    const failed = this.journal.filter((j) => j.kind === "spawn-failed" && Date.now() - Date.parse(j.at) < 15 * 60_000).slice(-3);
    if (failed.length) {
      rows.push("");
      rows.push("Spawn attempts that FAILED — do not tell the reader a worktree was queued or started:");
      for (const f of failed) rows.push(`- ${minutes(Date.now() - Date.parse(f.at))} ago: ${clip(f.text, 140)}`);
    }
    return rows.join("\n");
  }

  // What the assistant is told about itself. Kept short: it runs on a small model on purpose, and a
  // preamble that grows into a briefing is a preamble nobody reads.
  preamble() {
    const s = this.settings;
    const projects = this.getProjects().slice(0, 40);
    const spawnLine =
      s.spawn === "off"
        ? "You cannot create a worktree or start a worker in this panel — it is switched off. If asked, say so plainly and do not promise it."
        : s.spawn === "ask"
          ? "You can create a worktree and start a worker: write a SPAWN line, and it appears as a card the reader confirms with one click. Say that the card is ready rather than that the work has started."
          : "You can create a worktree and start a worker: write a SPAWN line and it starts immediately. Say that it has started, and give the worker's thread when the panel reports it.";
    const lines = [
      "You are the assistant watching this panel's agent board. You are not one of the workers, and you do not",
      "do work in a worktree yourself. Your job: notice when an agent is stuck, looping or waiting on a person;",
      "answer a worker's question only when the answer is written down below; when asked to get something done,",
      "start a worker to do it. Otherwise say what you would send and leave it to the reader. Keep replies short.",
      `Autonomy: ${s.autonomy === "draft" ? "draft only — nothing you write is sent to a worker until the reader clicks Send" : s.autonomy === "auto-safe" ? "auto-safe — a reply you mark TO a worker is sent; rule-derived drafts are not" : "auto — a draft with text is sent without waiting"}.`,
      spawnLine,
      "",
      ...(s.spawn === "off"
        ? []
        : [
            "Projects you can SPAWN in (name · path):",
            ...(projects.length ? projects.map((p) => `- ${p.name} · ${String(p.path).replace(/\\/g, "/")}`) : ["(none discovered yet)"]),
            "",
          ]),
      "Standing rules (written by the reader, plus any you added — trust these over your own guesses):",
      ...(this.rules.length ? this.rules.slice(-12).map((r, i) => `${i + 1}. ${clip(r.text, 200)}`) : ["(none written down yet)"]),
      "",
      `Scratchpad${this.notes ? "" : " (empty)"}:`,
      ...(this.notes ? [clip(this.notes, 1200)] : []),
      "",
      "Watches you are keeping:",
      ...(this.watches.filter((w) => w.state !== "done").length
        ? this.watches.filter((w) => w.state !== "done").slice(-10).map((w) => `- [${w.thread}] ${clip(w.title, 120)}${w.minutes ? ` · deadline ${w.minutes}m` : ""}${w.state === "alerted" ? " · overdue" : ""}`)
        : ["(none)"]),
      "",
      "The board right now:",
      this.digest(),
      "",
      "To act, end your reply with plain lines in exactly these shapes — the panel reads them and does the rest:",
      "TO <thread>: <the reply text to that worker>",
      "WATCH <thread>: <what to watch for> | <minutes, optional>",
      "NOTE: <something to remember in your scratchpad>",
      "RULE: <a standing answer you are sure of — it is saved as a rule you and the reader both use>",
      ...(s.spawn === "off"
        ? []
        : [
            "SPAWN <project name> | <what the new worker should do>",
            "SPAWN IN <directory, worktree directory name, or branch> | <what the worker should do in that tree>     (no new worktree)",
          ]),
      "A standing rule is how you answer a worker without guessing. Write one when a decision will come up again (for example: deploy to QA, never PROD), not to record something you noticed once — that is what NOTE is for. You may add rules, and you may not edit or delete the reader's; they can delete yours in the Scratchpad tab, where assistant-written rules are marked.",
      "Never write that you ran a command or changed a file; you only read this board, talk, and start workers when allowed.",
    ];
    return lines.join("\n");
  }

  // The gateway requires a real cwd on every run, and this thread does no file work: it gets a folder of its
  // own (default: beside the job store), created on demand, so it never borrows a project checkout that may
  // have been deleted. That failure — "cwd is not an existing directory", HTTP 400 — refused every turn on a
  // live panel and only showed on the card after the model had already been asked.
  ensureCwd() {
    const wanted = path.resolve(String(this.settings.cwd || this.config.assistantCwd || path.join(path.dirname(this.file), "assistant-cwd")));
    try {
      mkdirSync(wanted, { recursive: true });
      if (!statSync(wanted).isDirectory()) throw new Error("not a directory");
      this.cwdError = null;
      return wanted;
    } catch (err) {
      this.cwdError = String((err && err.message) || err);
      const fallback = [this.config.defaultCwd, tmpdir()]
        .filter(Boolean)
        .map((p) => path.resolve(String(p)))
        .find((p) => {
          try {
            return statSync(p).isDirectory();
          } catch {
            return false;
          }
        });
      this.onLog(`assistant: cwd ${wanted} is unusable (${this.cwdError}); using ${fallback || process.cwd()}`);
      return fallback || process.cwd();
    }
  }

  async say(text, { origin = null, display = null } = {}) {
    const prompt = String(text || "").trim();
    if (!prompt) throw new Error("text is required");
    if (!this.settings.enabled) throw new Error("the assistant is switched off in settings");
    if (this.assistantLive()) throw new Error("the assistant is still thinking about the last message");
    const turn = this.jobs.list().filter((j) => j.thread === ASSISTANT_THREAD).length;
    const job = await this.jobs.create({
      // `prompt` is what the run receives; `displayPrompt` is the shorter line the card shows, used by a wake
      // whose full text is a digest the reader does not need to read twice.
      prompt,
      displayPrompt: display || null,
      // The board digest and the scratchpad ride in the input, not in the prompt the card shows: the
      // reader asked a question, not for a copy of the assistant's context.
      preamble: this.preamble(),
      thread: ASSISTANT_THREAD,
      reply: turn > 0,
      // `worktree: false` is what keeps a tree from being cut; `existing` is left false because that flag is
      // the card's "in existing worktree" claim, and this thread has no worktree at all.
      worktree: false,
      // It reads the board; it is not asked to work in a directory, so the cwd sentence stays out of its prompt.
      anchorCwd: false,
      cwd: this.ensureCwd(),
      ownerPath: null,
      model: this.settings.model || null,
      budget: 900,
      maxTurns: 12,
      origin,
    });
    this.journalAdd("said", null, origin?.reason ? `woken: ${origin.reason}` : clip(prompt, 120));
    this.emit();
    return job;
  }

  // A wake is coalesced: while a turn is live the reasons queue up, and when it ends they go as one
  // message. Four wakes in one minute is one thought, not four.
  wake(reason, alertId = null, rule = null) {
    if (!this.settings.enabled) return;
    const cut = Date.now() - 3600_000;
    this.wakes = this.wakes.filter((t) => t > cut);
    if (this.wakes.length >= this.settings.maxWakesPerHour) {
      this.journalAdd("wake-suppressed", null, `rate limit reached (${this.settings.maxWakesPerHour}/h): ${reason}`);
      return;
    }
    this.pendingWake.push({ reason, alertId, rule });
    // Wakes fired by one sentry pass are one thought: two watches on the same worker finish in the same tick, and
    // two assistant turns answering that one event is noise. 150 ms is long enough to collect the pass and short
    // enough that nobody waits for it.
    if (this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      void this.flushWake();
    }, 150);
    this.wakeTimer.unref?.();
  }

  async flushWake() {
    if (!this.pendingWake.length) return;
    if (this.assistantLive()) return; // the end of that turn flushes it
    const batch = this.pendingWake.splice(0);
    this.wakes.push(Date.now());
    // One instruction per rule in the batch, not one per alert: four overdue watches ask the same question.
    const rules = [...new Set(batch.map((b) => b.rule).filter(Boolean))];
    const hint = clip(rules.map((r) => WAKE_HINTS[r]).filter(Boolean).join(" "), 500);
    const text =
      `${batch.length === 1 ? "One thing on the board needs a look:" : `${batch.length} things on the board need a look:`}\n` +
      batch.map((b) => `- ${b.reason}`).join("\n") +
      `\n\n${hint ? `${hint} ` : "Say what you make of it. "}If a worker asked something and the answer is in your rules or notes, draft it with TO <thread>: <text>.`;
    try {
      await this.say(text, {
        origin: { kind: "assistant-wake", reason: clip(batch.map((b) => b.reason).join(" · "), 300), alerts: batch.map((b) => b.alertId).filter(Boolean) },
        display: `watch: ${clip(batch[0].reason, 160)}`,
      });
    } catch (err) {
      this.journalAdd("wake-failed", null, String((err && err.message) || err));
    }
  }

  // Called from the job event stream: the end of one of the assistant's own turns is when its written
  // actions are carried out, and when a queued wake goes out.
  observe(evt) {
    if (!evt) return;
    if (evt.type === "job" && evt.job?.thread === ASSISTANT_THREAD && !isLive(evt.job)) {
      this.harvest(evt.job);
      void this.flushWake();
      this.emit();
    }
  }

  // The assistant's answer is prose plus, maybe, command lines. Only the command lines are actions.
  harvest(job) {
    // One turn, one harvest: see `harvested` in the constructor. The mark is taken before any action runs, so a
    // crash mid-way cannot replay the same spawn on the next start either.
    if (!job?.id || this.harvested.has(job.id)) return;
    const answer = lastProse(job.lines);
    if (!answer) return;
    this.harvested.add(job.id);
    if (this.harvested.size > 50) this.harvested = new Set([...this.harvested].slice(-50));
    this.persist();
    const actions = parseActions(answer);
    if (!actions.to.length && !actions.watch.length && !actions.note.length && !actions.spawn.length && !actions.rule.length) return;
    for (const note of actions.note) {
      this.notes = `${this.notes}${this.notes ? "\n" : ""}- ${note}`.slice(-LINE_CAP);
      this.journalAdd("note", null, note);
    }
    // A rule the assistant writes for itself. The reader's rules are still the reader's: this can add, not
    // edit or delete, and the Scratchpad tab marks which is which. Capped at 40 with the oldest trimmed by
    // addRule, so an agent that keeps restating itself cannot crowd out the reader's own answers.
    for (const text of actions.rule) {
      if (this.rules.length >= 40) {
        this.journalAdd("rule-skipped", null, `the scratchpad already holds 40 rules: ${clip(text, 120)}`);
        continue;
      }
      this.addRule(text, "assistant");
    }
    for (const w of actions.watch) {
      if (!this.jobs.firstOfThread(w.thread)) continue;
      this.addWatch({ thread: w.thread, title: w.title, minutes: w.minutes }, "assistant");
    }
    for (const to of actions.to) {
      const first = this.jobs.firstOfThread(to.thread);
      if (!first) {
        this.journalAdd("draft-skipped", to.thread, "no such thread on the board");
        continue;
      }
      const auto = this.settings.autonomy === "auto" || this.settings.autonomy === "auto-safe";
      if (auto) {
        this.answerThread(to.thread, to.text, { source: "assistant", autonomy: this.settings.autonomy })
          .then((j) => this.journalAdd("sent", to.thread, `assistant replied (job ${j.id})`))
          .catch((err) => this.journalAdd("send-failed", to.thread, String((err && err.message) || err)));
        continue;
      }
      this.alerts.push({
        id: randomUUID().slice(0, 8),
        key: `draft|${to.thread}|${to.text.slice(0, 50)}`,
        rule: "question",
        severity: "info",
        thread: to.thread,
        turnId: null,
        title: "the assistant drafted a reply",
        detail: `to ${this.nameFor(to.thread)}: “${clip(to.text, 200)}”`,
        evidence: [{ label: "draft", value: clip(to.text, 300) }],
        at: nowIso(),
        status: "open",
        level: "alert",
        draft: { thread: to.thread, text: to.text, confidence: "assistant", source: "assistant" },
      });
      this.journalAdd("draft", to.thread, clip(to.text, 160));
    }
    for (const sp of actions.spawn) {
      if (this.settings.spawn === "off") {
        this.journalAdd("spawn-skipped", null, `creating worktrees is switched off: ${clip(sp.prompt, 120)}`);
        continue;
      }
      if (this.settings.spawn === "ask") {
        this.addSpawnAlert(sp);
        continue;
      }
      this.startSpawn(sp).catch((err) => this.journalAdd("spawn-failed", null, String((err && err.message) || err)));
    }
    this.persist();
    this.emit();
  }

  // ---- starting a worker --------------------------------------------------------------------

  // A project named by the assistant: its name, its path, or a directory inside it. The registry is the
  // authority, so an invented name resolves to nothing and the spawn is refused with that reason.
  resolveProject(target) {
    const t = String(target || "").trim();
    if (!t) return null;
    const key = normPath(t);
    const projects = this.getProjects();
    const byName = projects.find((p) => String(p.name).toLowerCase() === t.toLowerCase());
    if (byName) return byName;
    const byPath = projects.find((p) => normPath(p.path) === key);
    if (byPath) return byPath;
    const inside = projects.find((p) => key.startsWith(`${normPath(p.path)}/`));
    if (inside) return inside;
    const leaf = t.split("/").filter(Boolean).pop() || "";
    return projects.find((p) => String(p.name).toLowerCase() === leaf.toLowerCase()) || null;
  }

  // A SPAWN line in `ask` mode: one card, with everything the reader needs to judge it before any git
  // command runs — the project, where the tree goes, and the exact prompt the worker would get.
  addSpawnAlert(sp) {
    const project = this.resolveProject(sp.target);
    const key = `spawn|${normPath(sp.target)}|${sp.prompt.slice(0, 40)}`;
    const already = this.alerts.find((a) => a.key === key && a.status === "open");
    if (already) return already;
    const where = sp.existing ? "that tree as it is" : "a new worktree under .worktrees/";
    const alert = {
      id: randomUUID().slice(0, 8),
      key,
      rule: "spawn",
      severity: "info",
      thread: null,
      turnId: null,
      title: sp.existing
        ? `start a worker in ${clip(project?.name || sp.target, 60)} (no new worktree)`
        : `create a worktree in ${project?.name || sp.target}`,
      detail: `${where} · the worker is asked: ${clip(sp.prompt, 240)}`,
      evidence: [
        { label: "project", value: project?.name || `${sp.target} (not on the board)` },
        { label: "where", value: where },
        { label: "prompt", value: clip(sp.prompt, 180) },
        { label: "model", value: "gateway default" },
      ],
      at: nowIso(),
      status: "open",
      level: "alert",
      spawn: {
        // The tree the line named, not the project: a card has to start the worker where the reader read that it
        // would. Only a bare project name — the project's own checkout — is rewritten to that checkout's path; a
        // directory, a worktree directory name or a branch stays exactly as written, and the server resolves it
        // against git's worktree list (lib/spawn-target.js) so a renamed tree is still found.
        target: project && normPath(project.name) === normPath(sp.target) ? project.path : String(sp.target),
        project: project?.name || null,
        existing: Boolean(sp.existing),
        prompt: sp.prompt,
      },
    };
    this.alerts.push(alert);
    if (this.alerts.length > ALERT_CAP) this.alerts.splice(0, this.alerts.length - ALERT_CAP);
    this.journalAdd("spawn-draft", null, `${alert.title}: ${clip(sp.prompt, 140)}`);
    this.persist();
    this.emit();
    return alert;
  }

  pendingSpawn(id) {
    const a = this.alerts.find((x) => x.id === id);
    return a && a.status === "open" && a.spawn ? a.spawn : null;
  }

  // Runs it. The server owns what this means (probe the gateway, refuse an unborn HEAD, cut the tree,
  // start the run); this only records the outcome and closes the card.
  async startSpawn(spawn, { alertId = null, source = "reader" } = {}) {
    if (!this.spawner) throw new Error("this panel cannot start agents");
    const spec = { ...(spawn || {}) };
    if (!String(spec.prompt || "").trim()) throw new Error("a spawn needs a prompt");
    // A SPAWN line names a project ("agent-worktree-gui"), a path, or a directory inside one. The server's
    // spawner takes a registry *name* for a new worktree and a real directory for SPAWN IN; a bare name in
    // `target` is not a path, so leaving it there made an ordinary name fail as "unknown project" on the
    // auto path while the same line worked as a card (addSpawnAlert resolves it). Resolve here, once.
    if (!spec.existing && !spec.project) {
      const project = this.resolveProject(spec.target);
      if (!project) throw new Error(`unknown project: ${spec.target}`);
      spec.project = project.name;
    }
    if (spec.existing) {
      // `SPAWN IN <project>` is a directory too: the project's own path is the tree the reader meant.
      const project = this.resolveProject(spec.target);
      if (project && normPath(project.name) === normPath(spec.target)) spec.target = project.path;
    }
    const job = await this.spawner(spec);
    // A name that had to be resolved to a real tree is said ON THE CARD, not only in the journal: the reader
    // judged this card, so which tree it actually started in is this card's answer. The server found it
    // (lib/spawn-target.js) and left it on the run's origin.
    const fit = job?.origin?.resolvedPath ? job.origin : null;
    const a = alertId ? this.alerts.find((x) => x.id === alertId) : null;
    if (a) {
      a.status = "done";
      a.closedAt = nowIso();
      a.startedJob = job?.id || null;
      a.thread = job?.thread || null;
      if (fit) {
        a.detail = `${a.detail || ""}${a.detail ? " · " : ""}${fit.resolvedFrom} no longer exists — started in ${fit.resolvedPath} (matched ${fit.resolvedHow})`;
        a.evidence = [...(a.evidence || []), { label: "resolved to", value: fit.resolvedPath }];
      }
    }
    // A worker it started is a thing it is now watching: the watch is what turns "spawned" into "and here is
    // how it ended", instead of the thread disappearing into a row somewhere on the board.
    if (job?.thread && !this.watches.some((w) => w.thread === job.thread && w.state !== "done")) {
      this.addWatch({ thread: job.thread, title: `spawned: ${clip(spec.prompt, 90)}` }, "assistant");
    }
    this.journalAdd("spawned", job?.thread || null, `${spec.existing ? `in ${fit?.resolvedPath || spec.target}` : `new worktree in ${spec.project || spec.target}`}: ${clip(spec.prompt, 160)} (${source})`);
    this.persist();
    this.emit();
    return job;
  }

  // ---- the reader's actions -----------------------------------------------------------------

  setSettings(patch = {}) {
    this.settings = {
      ...this.settings,
      ...pickSettings(patch, this.settings),
      rules: { ...this.settings.rules, ...pickRules(patch.rules || {}) },
    };
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.start();
    }
    // A working directory is only useful if it exists: create it the moment it is chosen, so the next turn
    // cannot be refused by the gateway for it, and say in the journal whether the fallback was needed.
    if (patch.cwd !== undefined) {
      const dir = this.ensureCwd();
      this.journalAdd("settings", null, `working dir ${dir}${this.cwdError ? ` (fallback: ${this.cwdError})` : ""}`);
    }
    this.journalAdd("settings", null, `autonomy ${this.settings.autonomy} · model ${this.settings.model || "(gateway default)"}`);
    this.persist();
    this.emit();
    return this.settings;
  }

  addRule(text, by = "reader") {
    const t = clip(text, 400);
    if (!t) throw new Error("a rule needs some text");
    if (this.rules.some((r) => r.text === t)) return this.rules;
    // A model restates itself with a word changed ("is interrupted" / "was interrupted"). For rules the
    // assistant wrote, a near-duplicate is a refinement of its own earlier rule, not a second rule: same
    // subject, so replace it. The reader's rules are never touched this way.
    if (by === "assistant") {
      const sig = words(t);
      const near = this.rules.find((r) => {
        if (r.by !== "assistant") return false;
        const other = words(r.text);
        if (!other.size || !sig.size) return false;
        let shared = 0;
        for (const w of sig) if (other.has(w)) shared += 1;
        return shared / (sig.size + other.size - shared) >= 0.75;
      });
      if (near) {
        near.text = t;
        near.at = nowIso();
        this.journalAdd("rule", null, `assistant refined: ${t}`);
        this.persist();
        this.emit();
        return this.rules;
      }
    }
    this.rules.push({ id: randomUUID().slice(0, 8), text: t, at: nowIso(), by });
    this.rules = this.rules.slice(-40);
    this.journalAdd("rule", null, `${by === "assistant" ? "assistant wrote: " : ""}${t}`);
    this.persist();
    this.emit();
    return this.rules;
  }

  removeRule(id) {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.id !== id);
    if (this.rules.length !== before) this.persist();
    this.emit();
    return this.rules;
  }

  addWatch({ thread, title, doneWhen = null, minutes = null } = {}, by = "reader") {
    if (!thread) throw new Error("a watch needs a thread");
    const t = clip(title, 160);
    if (!t) throw new Error("a watch needs something to watch for");
    const watch = {
      id: randomUUID().slice(0, 8),
      thread,
      title: t,
      doneWhen: doneWhen ? clip(doneWhen, 200) : null,
      minutes: minutes ? Math.max(1, Math.min(24 * 60, Number(minutes))) : null,
      at: nowIso(),
      by,
      state: "watching",
    };
    this.watches.push(watch);
    this.watches = this.watches.slice(-40);
    this.journalAdd("watch", thread, t);
    this.persist();
    this.emit();
    return watch;
  }

  removeWatch(id) {
    const before = this.watches.length;
    this.watches = this.watches.filter((w) => w.id !== id);
    if (this.watches.length !== before) this.persist();
    this.emit();
    return this.watches;
  }

  setNotes(text) {
    this.notes = String(text || "").slice(-LINE_CAP);
    this.journalAdd("notes", null, `${this.notes.length} chars`);
    this.persist();
    this.emit();
    return this.notes;
  }

  alertAction(id, action) {
    const a = this.alerts.find((x) => x.id === id);
    if (!a) throw new Error(`unknown alert: ${id}`);
    if (action === "dismiss") {
      a.status = "dismissed";
      a.closedAt = nowIso();
      this.journalAdd("dismissed", a.thread, a.title);
    } else if (action === "ask") {
      this.journalAdd("asked", a.thread, a.title);
      this.wake(`[${a.rule}] ${a.title}${a.detail ? ` — ${a.detail}` : ""}`, a.id);
    } else {
      throw new Error(`unknown action: ${action}`);
    }
    this.persist();
    this.emit();
    return a;
  }

  // Answer a question the run is parked on (the `clarify` tool). This is not a reply: it settles the
  // prompt the gateway is holding, so the turn resumes instead of stacking another turn behind it.
  async answerParked(alertId, answer) {
    const a = this.alerts.find((x) => x.id === alertId);
    if (!a || !a.parked) throw new Error("that alert is not a parked question");
    // A multi-select answer is an array, exactly as the card sends it: the tool decodes the JSON, and
    // flattening it here would answer with one label where the reader ticked three.
    const text = Array.isArray(answer) ? answer.map((x) => String(x)).filter(Boolean) : String(answer ?? "").trim();
    if (Array.isArray(text) ? !text.length : !text) throw new Error("an answer is required");
    const shown = Array.isArray(text) ? text.join(" · ") : text;
    const r = await this.jobs.answerQuestion(a.turnId, text, a.requestId || undefined);
    if (!r.ok) throw new Error(r.error || "the gateway refused the answer");
    a.status = "answered";
    a.closedAt = nowIso();
    a.answer = clip(shown, 200);
    this.journalAdd("answered-question", a.thread, `“${clip(shown, 160)}”`);
    this.persist();
    this.emit();
    return r;
  }

  // Post a reply into a worker's thread. The only way this module can change a worker's course, and it
  // is reached only from an explicit reader action or from an autonomy the reader turned on.
  async answerThread(thread, text, { source = "reader", alertId = null, autonomy = null } = {}) {
    const body = String(text || "").trim();
    if (!body) throw new Error("the reply is empty");
    const first = this.jobs.firstOfThread(thread);
    if (!first) throw new Error(`unknown thread: ${thread}`);
    let dir = first.cwd || this.config.defaultCwd || process.cwd();
    if (first.worktreePath) {
      try {
        if ((await stat(first.worktreePath)).isDirectory()) dir = first.worktreePath;
      } catch {
        /* the tree is gone: fall back to the project the agent started from */
      }
    }
    const job = await this.jobs.create({
      prompt: body,
      thread,
      reply: true,
      resumeDir: dir,
      cwd: dir,
      origin: { kind: "assistant-reply", by: source, autonomy: autonomy || this.settings.autonomy },
      model: this.jobs.modelFor(thread) ?? first.model ?? null,
      budget: first.budget ?? 1800,
      maxTurns: first.maxTurns ?? null,
      ownerPath: first.ownerPath || null,
    });
    const a = alertId ? this.alerts.find((x) => x.id === alertId) : null;
    if (a) {
      a.status = "answered";
      a.closedAt = nowIso();
      a.answeredBy = job.id;
    }
    this.journalAdd(source === "reader" ? "answered" : `answered-${source}`, thread, clip(body, 200));
    this.persist();
    this.emit();
    return job;
  }

  // A draft the reader can send. Kept separate from answerThread so the two-button shape in the panel
  // (Send / Ignore) has one call that only ever drafts.
  draftFor(id) {
    const a = this.alerts.find((x) => x.id === id);
    return a?.draft || null;
  }
}

// ---------------------------------------------------------------------------------------------
function stripConfig(assistant) {
  // config.json may carry a partial `assistant` block; only the known knobs are honoured.
  const { rules, ...rest } = assistant || {};
  return pickSettings(rest);
}

function pickSettings(from = {}, base = DEFAULTS) {
  const out = {};
  if (typeof from.enabled === "boolean") out.enabled = from.enabled;
  if (AUTONOMY.includes(from.autonomy)) out.autonomy = from.autonomy;
  if (SPAWN_MODES.includes(from.spawn)) out.spawn = from.spawn;
  if (typeof from.model === "string") out.model = from.model.slice(0, 120);
  // An absolute path, or empty for the default beside the job store. Not resolved here: `ensureCwd()` does
  // that at the point of use, where the fallback is known.
  if (typeof from.cwd === "string") out.cwd = from.cwd.trim().slice(0, 500);
  for (const [key, lo, hi] of [
    ["seconds", 2, 120],
    ["repeatLimit", 2, 12],
    ["quietSeconds", 30, 3600],
    ["approvalSeconds", 15, 3600],
    ["contextPercent", 50, 100],
    ["leftoverMinutes", 1, 240],
    ["childQuietSeconds", 60, 3600],
    ["repeatTurns", 2, 10],
    ["maxWakesPerHour", 0, 60],
    ["rearmSeconds", 60, 86_400],
  ]) {
    if (from[key] !== undefined && from[key] !== null && from[key] !== "") out[key] = Math.max(lo, Math.min(hi, num(from[key], base[key])));
  }
  return out;
}

function pickRules(rules) {
  const out = {};
  for (const [k, v] of Object.entries(rules || {})) if (RULE_DEFS[k] && ESCALATIONS.includes(v)) out[k] = v;
  return out;
}

const LIVE_STATUS = new Set(["running", "starting", "waiting_for_approval", "queued"]);
function isLive(j) {
  return Boolean(j) && (LIVE_STATUS.has(j.status) || Boolean(j.approval));
}

// When a turn was over. `endedAt` is the answer for a run this panel watched to the end; an `interrupted` job
// (the panel restarted mid-run) has none, and its last line is when it last did anything. 0 means still live.
function endedAtMs(j) {
  if (!j || isLive(j)) return 0;
  const ended = Date.parse(j.endedAt || "");
  if (Number.isFinite(ended) && ended) return ended;
  return Number((j.lines || []).at(-1)?.at) || Date.parse(j.startedAt || "") || 0;
}

// Which of two turns of one thread came last. The clock decides, not `turn`: that number is a sequence over the
// jobs this store still holds (`siblings.length + 1`), so once KEEP_JOBS trims old turns it moves *backwards* — a
// resumed thread can carry a lower number than the interrupted turn it replaced (measured live: a revive got turn 6
// beside an interrupted turn 8, and the interrupted rule went on calling the dead turn the latest one). `turn` is
// only a tiebreaker for two turns that started in the same millisecond.
function newerTurn(a, b) {
  const ta = Date.parse(a?.startedAt || "");
  const tb = Date.parse(b?.startedAt || "");
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta > tb;
  return (Number(a?.turn) || 0) > (Number(b?.turn) || 0);
}

function nameOf(j) {
  const raw = j?.label || j?.title || j?.thread || "agent";
  return clip(String(raw).replace(/^Subagent:\s*/i, ""), 60);
}

function minutes(ms) {
  const m = Math.max(0, Math.round(Number(ms) / 60_000));
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function lastLine(j) {
  for (let i = (j.lines || []).length - 1; i >= 0; i -= 1) {
    const l = j.lines[i];
    if (l.kind === "text" || l.kind === "raw" || l.kind === "dim") {
      if (String(l.text || "").trim()) return String(l.text).trim();
    }
  }
  return "";
}

// The turn's own prose, in order, with tool bookkeeping left out. Streamed deltas grow one line in
// place, so the last text line is the finished paragraph.
function lastProse(lines) {
  for (let i = (lines || []).length - 1; i >= 0; i -= 1) {
    const l = lines[i];
    if (l.kind === "text" && String(l.text || "").trim()) return String(l.text).trim();
  }
  return "";
}
