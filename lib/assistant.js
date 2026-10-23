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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

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
  question: { label: "Worker asked you something", hint: "a turn ended on a question - answered from a standing rule, drafted, or left for you", default: "alert" },
  noevidence: { label: "Done with no evidence", hint: "an implementation-sounding turn finished without touching a file and without a deliverable", default: "log" },
  collision: { label: "Two agents in one tree", hint: "two live turns share a worktree", default: "alert" },
  context: { label: "Context nearly full", hint: "a live turn is close to its context ceiling", default: "log" },
  watch: { label: "Watch finished or overdue", hint: "something you asked the assistant to keep an eye on has finished or run past its deadline", default: "alert" },
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
  seconds: 5,
  repeatLimit: 3,
  quietSeconds: 240,
  approvalSeconds: 120,
  contextPercent: 90,
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

// Identical failure output. Terminal results carry "(exit 1)"; anything else that says error: counts.
export function detectErrorRepeat(lines, limit = 3) {
  const counts = new Map();
  for (const l of lines || []) {
    if (l.kind !== "tool-out") continue;
    const text = String(l.text || "");
    if (!/\(exit\s+[1-9]\d*\)|\(error:|^error:/i.test(text)) continue;
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
const words = (s) => new Set(String(s || "").toLowerCase().match(/[a-z][a-z0-9_.-]{2,}/g)?.filter((w) => !STOP.has(w)) || []);
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

// Lines the assistant writes at the end of its reply are how it acts on the board. It has no tool for
// this: the panel reads these three prefixes and does the rest, so what it can do is exactly what is
// written down here.
export function parseActions(text) {
  const out = { to: [], watch: [], note: [], spawn: [] };
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
    if (n) out.note.push(clip(n[1], 500));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
export class Assistant {
  constructor({ config = {}, jobs, getProjects = () => [], spawner = null, onEvent = () => {}, onLog = () => {} } = {}) {
    this.config = config;
    this.jobs = jobs;
    // What the assistant may cut a worktree in, and the one function that can do it. Both are injected:
    // this module decides WHEN, the server owns HOW (the project registry, the gateway probe, `git worktree add`).
    this.getProjects = getProjects;
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
    // Turns whose written actions have already been carried out. A finished turn is re-emitted whenever its
    // Hermes title lands (`sweepTitles`) or the panel reloads the job store, and re-reading its SPAWN/TO/NOTE
    // lines then would start a second worker or re-open a card the reader already answered.
    this.harvested = new Set();
    this.persistTimer = null;
    this.dirty = false;
    this.timer = null;
    this.lastTickAt = 0;
    this.load();
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
      this.notes = typeof raw.notes === "string" ? raw.notes.slice(0, LINE_CAP) : "";
      this.rules = Array.isArray(raw.rules) ? raw.rules.filter((r) => r && typeof r.text === "string").slice(-40) : [];
      this.watches = Array.isArray(raw.watches) ? raw.watches.filter((w) => w && w.id && w.thread).slice(-40) : [];
      this.alerts = Array.isArray(raw.alerts) ? raw.alerts.filter((a) => a && a.id && a.rule).slice(-ALERT_CAP) : [];
      this.journal = Array.isArray(raw.journal) ? raw.journal.filter(Boolean).slice(-JOURNAL_CAP) : [];
      this.harvested = new Set(Array.isArray(raw.harvested) ? raw.harvested.filter((x) => typeof x === "string").slice(-50) : []);
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
          version: 1,
          savedAt: nowIso(),
          settings: this.settings,
          notes: this.notes,
          rules: this.rules,
          watches: this.watches,
          alerts: this.alerts.slice(-ALERT_CAP),
          journal: this.journal.slice(-JOURNAL_CAP),
          harvested: [...this.harvested].slice(-50),
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
  fired(rule, subject, { thread = null, turnId = null, title, detail, evidence = [], severity = "warn", draft = null } = {}) {
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
    };
    this.alerts.push(alert);
    if (this.alerts.length > ALERT_CAP) this.alerts.splice(0, this.alerts.length - ALERT_CAP);
    this.journalAdd(rule, thread, detail || title);
    this.persist();
    if (level === "wake" || level === "act") this.wake(`[${rule}] ${title}${detail ? ` — ${detail}` : ""}`, alert.id);
    this.emit();
    return alert;
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
      if (j.status === "running" && quietFor >= this.settings.quietSeconds * 1000) {
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

    // Two live turns in one tree. Keyed on the pair, so the alert is one per collision, not one per tick.
    const byTree = new Map();
    for (const j of live) {
      const tree = normPath(j.ownerPath || j.cwd || "");
      if (!tree) continue;
      byTree.set(tree, [...(byTree.get(tree) || []), j]);
    }
    for (const [tree, group] of byTree) {
      if (group.length < 2) continue;
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
      const finished = latest && latest.endedAt && Date.parse(latest.endedAt) > since && !live;
      if (finished) {
        w.state = "done";
        w.doneAt = nowIso();
        this.fired("watch", `${w.id}|finished`, {
          thread: w.thread,
          title: `watch finished: ${clip(w.title, 90)}`,
          detail: `${nameOf(latest)} ended as ${latest.status}${w.doneWhen ? ` — was watching for: ${clip(w.doneWhen, 120)}` : ""}`,
          evidence: [
            { label: "watching", value: clip(w.title, 140) },
            { label: "outcome", value: latest.status },
            { label: "last line", value: clip(lastLine(latest), 140) },
          ],
          severity: latest.status === "done" ? "info" : "warn",
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
      "Standing rules (the reader's own answers — trust these over your own guesses):",
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
      ...(s.spawn === "off"
        ? []
        : [
            "SPAWN <project name> | <what the new worker should do>",
            "SPAWN IN <directory> | <what the worker should do in that tree>     (no new worktree)",
          ]),
      "Never write that you ran a command or changed a file; you only read this board, talk, and start workers when allowed.",
    ];
    return lines.join("\n");
  }

  async say(text, { origin = null, display = null } = {}) {
    const prompt = String(text || "").trim();
    if (!prompt) throw new Error("text is required");
    if (!this.settings.enabled) throw new Error("the assistant is switched off in settings");
    if (this.assistantLive()) throw new Error("the assistant is still thinking about the last message");
    const turn = this.jobs.list().filter((j) => j.thread === ASSISTANT_THREAD).length;
    const job = await this.jobs.create({
      prompt: display || prompt,
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
      cwd: this.config.defaultCwd || process.cwd(),
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
  wake(reason, alertId = null) {
    if (!this.settings.enabled) return;
    const cut = Date.now() - 3600_000;
    this.wakes = this.wakes.filter((t) => t > cut);
    if (this.wakes.length >= this.settings.maxWakesPerHour) {
      this.journalAdd("wake-suppressed", null, `rate limit reached (${this.settings.maxWakesPerHour}/h): ${reason}`);
      return;
    }
    this.pendingWake.push({ reason, alertId });
    void this.flushWake();
  }

  async flushWake() {
    if (!this.pendingWake.length) return;
    if (this.assistantLive()) return; // the end of that turn flushes it
    const batch = this.pendingWake.splice(0);
    this.wakes.push(Date.now());
    const text =
      `${batch.length === 1 ? "One thing on the board needs a look:" : `${batch.length} things on the board need a look:`}\n` +
      batch.map((b) => `- ${b.reason}`).join("\n") +
      "\n\nSay what you make of it. If a worker asked something and the answer is in your rules or notes, draft it with TO <thread>: <text>.";
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
    if (!actions.to.length && !actions.watch.length && !actions.note.length && !actions.spawn.length) return;
    for (const note of actions.note) {
      this.notes = `${this.notes}${this.notes ? "\n" : ""}- ${note}`.slice(-LINE_CAP);
      this.journalAdd("note", null, note);
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
        target: project?.path || String(sp.target),
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
    const job = await this.spawner(spec);
    const a = alertId ? this.alerts.find((x) => x.id === alertId) : null;
    if (a) {
      a.status = "done";
      a.closedAt = nowIso();
      a.startedJob = job?.id || null;
      a.thread = job?.thread || null;
    }
    // A worker it started is a thing it is now watching: the watch is what turns "spawned" into "and here is
    // how it ended", instead of the thread disappearing into a row somewhere on the board.
    if (job?.thread && !this.watches.some((w) => w.thread === job.thread && w.state !== "done")) {
      this.addWatch({ thread: job.thread, title: `spawned: ${clip(spec.prompt, 90)}` }, "assistant");
    }
    this.journalAdd("spawned", job?.thread || null, `${spec.existing ? `in ${spec.target}` : `new worktree in ${spec.project || spec.target}`}: ${clip(spec.prompt, 160)} (${source})`);
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
    this.journalAdd("settings", null, `autonomy ${this.settings.autonomy} · model ${this.settings.model || "(gateway default)"}`);
    this.persist();
    this.emit();
    return this.settings;
  }

  addRule(text) {
    const t = clip(text, 400);
    if (!t) throw new Error("a rule needs some text");
    if (this.rules.some((r) => r.text === t)) return this.rules;
    this.rules.push({ id: randomUUID().slice(0, 8), text: t, at: nowIso() });
    this.rules = this.rules.slice(-40);
    this.journalAdd("rule", null, t);
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
  for (const [key, lo, hi] of [
    ["seconds", 2, 120],
    ["repeatLimit", 2, 12],
    ["quietSeconds", 30, 3600],
    ["approvalSeconds", 15, 3600],
    ["contextPercent", 50, 100],
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
