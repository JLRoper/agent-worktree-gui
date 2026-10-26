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
import { existsSync, mkdirSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  AGGRESSIVE,
  AGGRESSIVE_KEYS,
  AGGRESSIVE_RULE_IDS,
  AGGRESSIVE_RULE_LEVEL,
  ALERT_CAP,
  AUTONOMY,
  CHARTER_FILE,
  DEFAULTS,
  ESCALATIONS,
  JOURNAL_CAP,
  LINE_CAP,
  MAX_LINES,
  RULE_DEFS,
  SPAWN_MODES,
  WAKE_HINTS,
  num,
  pickRules,
  pickSettings,
  stripConfig,
} from "./assistant/config.js";
import {
  clip,
  detectCycle,
  detectErrorRepeat,
  detectRepeat,
  endedAtMs,
  isFailureLine,
  isLive,
  lastLine,
  lastProse,
  minutes,
  nameOf,
  newerTurn,
  normPath,
  nowIso,
  parseToolLine,
  reasonOf,
  toolSigs,
  treeTail,
  turnFailure,
  turnProse,
} from "./assistant/read.js";
import { looksLikeBareWork, looksLikeQuestion, matchRule, pickChoice, words } from "./assistant/match.js";
import { actionGrammar, parseActions } from "./assistant/actions.js";
import { readAssistantFile, writeAssistantFile } from "./assistant/store-file.js";
import { appendCharterEntry, charterMetaFor, readCharterFile, writeCharterFile } from "./assistant/charter-file.js";
import { CHARTER_MAX_CHARS } from "./charter.js";
import { completionEvidence, durationText, renderCompletionNotice, terminalKey, wordForStatus } from "./completion.js";
import { MESSAGE_CAP, MESSAGE_KINDS, MESSAGE_TEXT_CAP, MESSAGE_WINDOW_DAYS, buildMessages } from "./assistant/messages.js";

// THIS file is the path every harness and the page import: `lib/assistant.js`. Each module the shell was
// split into keeps being re-exported from here under the name it was read by, so no import site moves when a
// piece does:
//   - the page's contract - `RULE_DEFS` and the three vocabularies, which `state()` ships to the client;
//   - the detection primitives tools/verify-assistant.mjs drives directly, and its two judgements;
//   - `turnProse`, which tools/verify-action-harvest.mjs reads a turn's prose with;
//   - `parseActions`, read by every harness that drives a finished turn into a board outcome.
export { AUTONOMY, ESCALATIONS, RULE_DEFS, SPAWN_MODES };
export { detectCycle, detectErrorRepeat, detectRepeat, isFailureLine, parseToolLine, turnProse, turnFailure };
export { looksLikeQuestion, matchRule };
export { parseActions };
// The message board: the window, the caps and the vocabulary the tab reads, and the merge itself, which a
// harness can drive with a fabricated store and journal (tools/verify-messages-tab.mjs does exactly that).
export { MESSAGE_CAP, MESSAGE_KINDS, MESSAGE_TEXT_CAP, MESSAGE_WINDOW_DAYS, buildMessages };

// A fixed thread id, not a generated one: the panel has to find this conversation again after a
// restart (and after a jobs-file reset), and a name derived from the first prompt would not survive
// either. It is still just a Hermes session id like any other.
export const ASSISTANT_THREAD = "panel-assistant";

// ---------------------------------------------------------------------------------------------
export class Assistant {
  constructor({ config = {}, jobs, getProjects = () => [], getRows = () => [], getChildren = () => ({}), spawner = null, onEvent = () => {}, onLog = () => {}, onRestart = null } = {}) {
    this.config = config;
    this.jobs = jobs;
    // What the assistant may cut a worktree in, and the one function that can do it. Both are injected:
    // this module decides WHEN, the server owns HOW (the project registry, the gateway probe, `git worktree add`).
    this.getProjects = getProjects;
    // Scanned worktree rows (dirty files, commits ahead, verdict) and the delegated children of live threads.
    // Both come from the panel's own findings rather than a second git or sqlite implementation.
    this.getRows = getRows;
    this.getChildren = getChildren;
    // The one act this module cannot perform itself: `request()` on the server's restart controller,
    // handed the RESTART lines a finished turn wrote (see `harvest`).
    this.onRestart = typeof onRestart === "function" ? onRestart : null;
    this.spawner = spawner;
    this.onEvent = onEvent;
    this.onLog = onLog;
    const dir = path.dirname(config.jobsFile || path.join(config.defaultCwd || process.cwd(), "logs", "jobs.json"));
    this.file = config.assistantFile || path.join(dir, "assistant.json");
    // The continuity file, beside the job store like everything else the assistant owns. Seeded on first
    // boot from the rules and notes that store already holds (see `loadCharter`).
    this.charterFile = config.charterFile || path.join(dir, CHARTER_FILE);
    // The base is what the panel boots with: the built-in defaults, with config.json's optional `assistant`
    // block over them. It is kept beside the live settings because "absent" needs somewhere to fall back to
    // when aggressive mode deletes a key it recorded as absent — the value to use is the base's, not whatever
    // the profile wrote.
    this.baseSettings = { ...DEFAULTS, ...(config.assistant && typeof config.assistant === "object" ? stripConfig(config.assistant) : {}), rules: { ...DEFAULTS.rules } };
    this.settings = { ...this.baseSettings };
    // Which knobs the persisted file actually carries. An absent key stays absent through a write, so it keeps
    // falling back to the base instead of being frozen at whatever the default was the day it was first seen.
    // A first boot has nothing on disk and therefore nothing explicit: the file records what the reader sets,
    // not a copy of today's defaults.
    this.settingsExplicit = { settings: new Set(), rules: new Set() };
    // Aggressive mode's own record. `saved` holds, for every key the profile writes, whether it existed before
    // and exactly what it was; a key that did not exist is `{ present: false }` and is DELETED again on the way
    // out. It is read from and written to assistant.json, so a restart between the two presses changes nothing.
    this.aggressive = { on: false, at: null, saved: { settings: {}, rules: {} }, incomplete: false };
    this.notes = "";
    this.charter = "";
    this.charterSeeded = false;
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
    // The COMPLETE chip's asks, keyed by the card's job id: an ask the assistant has not turned on yet. It is how a
    // second press says "already queued" instead of queueing the same question twice, and it is cleared when a turn of
    // the assistant's own ends — at that point the ask has been read, and a later press is a new question.
    this.completeAsks = new Map();
    this.persistTimer = null;
    this.dirty = false;
    this.timer = null;
    // The restart keys already reported, so one restart is one wake even across a panel reload. A
    // restart the panel did not ask for (lib/jobs.js `sweepOrphanedRuns`) claims the same set.
    this.restartWakes = new Set();
    this.lastTickAt = 0;
    // The last reason the configured working directory could not be used, if it could not.
    this.cwdError = null;
    // One resume per process: a restart must not become a turn every time the watchdog runs. `resumedTurn`
    // remembers that a wake actually went out, so the panel does not call a clean restart "resumed".
    this.resumed = false;
    this.resumedTurn = null;
    this.migrated = false;
    this.load();
    this.loadCharter();
    if (this.migrated) this.persist();
  }

  // ---- storage ------------------------------------------------------------------------------

  load() {
    // The file's shape, its caps and the v1->v2 migration live in ./assistant/store-file.js. What stays here
    // is the fields themselves: `load` applies what came back to the fields this object owns, and `persist`
    // (below) is the debounce over them. Splitting the fields from the writer is how you get two writers.
    const out = readAssistantFile(this.file, { base: this.settings });
    if (out.error) {
      this.onLog(`assistant: could not read ${this.file} (${out.error}) — starting empty`);
      return;
    }
    if (!out.found) return;
    this.settings = out.settings;
    // The keys the file itself carries: the ones a write puts back, and the ones "absent" means absent for.
    this.settingsExplicit = {
      settings: new Set(out.present?.settings || []),
      rules: new Set(out.present?.rules || []),
    };
    // Aggressive mode's record, read from the same file. It outlives the page on purpose: the next press of the
    // toggle restores from THIS, whether or not the panel restarted in between.
    this.aggressive = out.aggressive || { on: false, at: null, saved: { settings: {}, rules: {} }, incomplete: false };
    this.notes = out.notes;
    this.rules = out.rules;
    this.watches = out.watches;
    this.alerts = out.alerts;
    this.journal = out.journal;
    this.harvested = out.harvested;
    this.terminalWakes = out.terminalWakes;
    this.restartWakes = out.restartWakes;
    this.migrated = out.migrated;
    // The mode was on when the panel stopped: put the profile back over the loaded settings so every held knob
    // reads as the aggressive value again. The record is NOT re-taken — that would capture the aggressive values
    // as the reader's own — and a partly hand-edited file is repaired rather than left half-aggressive.
    if (this.aggressive.on) this.applyAggressiveProfile();
    if (this.aggressive.incomplete) {
      this.journalAdd(
        "aggressive",
        null,
        "aggressive mode is on but its saved settings were unreadable or empty — switching it off will restore defaults, not your own values",
      );
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
    // Only the knobs the file already carries, plus the ones the reader or the profile has set. A knob nobody
    // ever chose stays absent so it keeps following its default; writing every resolved value would freeze
    // today's defaults into the file and quietly defeat "an absent key falls back to its default".
    const settings = { rules: {} };
    for (const key of this.settingsExplicit.settings) settings[key] = this.settings[key];
    for (const id of this.settingsExplicit.rules) settings.rules[id] = this.settings.rules[id];
    // The whole snapshot, one writer: the file gets the fields this object holds, capped the same way they
    // were capped on the way in, and the caller only has to report a failure.
    const out = writeAssistantFile(this.file, {
      settings,
      aggressive: this.aggressiveSnapshot(),
      notes: this.notes,
      rules: this.rules,
      watches: this.watches,
      alerts: this.alerts,
      journal: this.journal,
      harvested: this.harvested,
      terminalWakes: this.terminalWakes,
      restartWakes: this.restartWakes,
    });
    if (out.error) this.onLog(`assistant: could not write ${this.file}: ${out.error}`);
  }

  // ---- the charter: the long tier of its memory ------------------------------------------------

  // Read from disk rather than cached at boot, and re-read on every turn: the reader edits this file in the
  // Charter tab and may edit it on disk, so the file is the source of truth and a stale copy in memory is a
  // briefing nobody wrote. A missing file is seeded once, from what the scratchpad already holds, so a panel
  // that has been running for weeks does not start the long tier empty.
  loadCharter() {
    const out = readCharterFile(this.charterFile, {
      seed: { rules: this.rules, notes: this.notes, panelDir: path.dirname(this.file) },
    });
    if (out.error) {
      this.charter = "";
      this.onLog(`assistant: could not read ${this.charterFile} (${out.error}) — the charter is empty this turn`);
      return this.charter;
    }
    this.charter = out.text;
    if (out.seeded) {
      this.charterSeeded = true;
      this.onLog(`assistant: seeded ${this.charterFile} from ${path.basename(this.file)} (${out.chars} chars)`);
      this.journalAdd("charter", null, `seeded the charter from the scratchpad (${out.chars} chars)`);
    }
    return this.charter;
  }

  // What the page shows beside the box: the path, when it was last written, how big it is against the cap.
  // One read, so `chars` and `mtime` describe the same bytes rather than two moments.
  charterMeta() {
    const { text, ...meta } = charterMetaFor(this.charterFile, { seeded: this.charterSeeded });
    if (meta.exists) this.charter = text;
    return meta;
  }

  charterPayload() {
    return { ...this.charterMeta(), text: String(this.charter || "") };
  }

  // The reader's save, or a PUT. The cap and the mtime guard are enforced in ./assistant/charter-file.js, so
  // the tab, a script and any future surface all get the same refusal with the same numbers, and the two
  // codes the route maps to 409/413 travel with it.
  setCharter(text, by = "reader", { expectMtime = null } = {}) {
    this.charter = writeCharterFile(this.charterFile, text, { expectMtime });
    this.charterSeeded = false;
    this.journalAdd("charter", null, `charter saved by ${by} (${this.charter.length} chars)`);
    this.emit();
    return this.charterPayload();
  }

  // One dated entry — from a CHARTER: line, or from a standing rule changing. Over the cap the OLDEST entries
  // go first (lib/charter.js). A file whose prose alone is over the cap is left untouched and the refusal is
  // written to the journal: dropping the reader's own words is not this method's call.
  appendCharter(text, { by = "assistant", kind = "" } = {}) {
    if (!String(this.charter || "").trim()) this.loadCharter();
    const out = appendCharterEntry(this.charterFile, String(this.charter || ""), text, { by, kind });
    if (out.reason === "full") {
      this.journalAdd("charter-full", null, `entry not written (${out.chars}/${CHARTER_MAX_CHARS} chars): ${clip(text, 120)}`);
      return { written: false, chars: out.chars };
    }
    if (out.reason === "write-failed") {
      this.journalAdd("charter-failed", null, `could not write ${this.charterFile}: ${out.error}`);
      return { written: false, chars: out.chars };
    }
    this.charter = out.text;
    this.journalAdd("charter", null, `charter entry: ${clip(text, 160)}`);
    this.emit();
    return { written: true, chars: out.text.length };
  }

  // What rides in the preamble. The whole file: the point of the long tier is that it arrives whole, and the
  // cap is what bounds the cost of that. A hand-edited file over the cap is clipped here and named as clipped.
  charterBriefing() {
    // Re-read here rather than trusting the copy in memory: the file is the source of truth, the reader edits
    // it in the tab and may edit it on disk, and the briefing is built once per turn — so one read per turn is
    // the price of the turn seeing what the file actually says.
    this.loadCharter();
    const text = String(this.charter || "").trim();
    if (!text) return ["Charter (the long tier — nothing written down yet):"];
    if (text.length <= CHARTER_MAX_CHARS) return [`Charter — the long tier, read in full on every turn (${this.charterFile.replace(/\\/g, "/")}):`, text];
    return [
      `Charter — read on every turn, clipped here at ${CHARTER_MAX_CHARS} of ${text.length} chars (${this.charterFile.replace(/\\/g, "/")}):`,
      `${text.slice(0, CHARTER_MAX_CHARS - 200)}…`,
      "[clipped: the file is over the cap — prune the oldest changelog entries]",
    ];
  }

  // ---- what the page sees ---------------------------------------------------------------------

  state() {
    const now = Date.now();
    const cut = now - 3600_000;
    // The wake budget the page reads, filtered into a LOCAL: `wake()` prunes this list the same way before it
    // checks the budget, and it is the only thing that ever adds to it, so pruning here again bought nothing
    // and cost the page's own getter its read-only contract - a caller that only wanted a snapshot moved the
    // state the next budget check saw.
    const wakes = this.wakes.filter((t) => t > cut);
    return {
      thread: ASSISTANT_THREAD,
      enabled: this.settings.enabled,
      settings: this.settings,
      ruleDefs: RULE_DEFS,
      escalations: ESCALATIONS,
      autonomy: AUTONOMY,
      spawnModes: SPAWN_MODES,
      // The header's toggle: whether the aggressive profile is holding the settings, which controls it holds,
      // and how many saved values a switch-off will put back (and how many absent keys it will delete).
      aggressive: this.aggressiveState(),
      rules: this.rules,
      watches: this.watches,
      notes: this.notes,
      charter: this.charterMeta(),
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
      wakes: { lastHour: wakes.length, limit: this.settings.maxWakesPerHour },
      wakePending: this.pendingWake.length,
      digest: this.digest(),
      // Whether this gateway build can deliver a `clarify` question at all. The assistant's own turns
      // and every worker the panel starts post through the same body (`Jobs.create`), which tells a run
      // to ask in prose once a refusal has been observed — so the page can say WHY the board's agents
      // ask in prose instead of drawing a box that can never appear. null = nothing observed yet.
      clarify: this.jobs?.clarify?.state?.() || null,
      at: now,
    };
  }

  emit() {
    this.onEvent({ type: "assistant", assistant: this.state() });
  }

  // The message board between this assistant and the agents — what it sent them and what they sent back.
  // A read, built per request from the two stores this panel already keeps (the job store and the
  // assistant's own journal), so there is no second log to drift from the first and nothing to prune: an
  // entry's own timestamp decides the window. The merge, the fold and the caps live in
  // ./assistant/messages.js; this method is only what those need from this object.
  messages({ days = MESSAGE_WINDOW_DAYS, cap = MESSAGE_CAP, textCap = MESSAGE_TEXT_CAP, now = Date.now() } = {}) {
    return buildMessages({
      summaries: typeof this.jobs?.list === "function" ? this.jobs.list() : [],
      // The store's own record, for the one field the summary drops: the run's `finalMessage`.
      records: (id) => (typeof this.jobs?.get === "function" ? this.jobs.get(id) : null),
      journal: this.journal,
      alerts: this.alerts,
      assistantThread: ASSISTANT_THREAD,
      now,
      days,
      cap,
      textCap,
    });
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

  // The single wake a restart fires. The panel's own action and a restart the panel merely noticed
  // both come through here, so a restart is one thought on the board rather than one per interrupted
  // run. The completion payload of everything it interrupted rides in the text. The `interrupted`
  // rule is left to file its own alert, but its terminal claim is taken first, so the same finish
  // cannot wake the board a second time.
  wakeAfterRestart(interrupted = [], { target = "gateway", proof = null, reason = "", requested = null, detected = false, recordId = null, reattached = [] } = {}) {
    if (!this.settings.enabled) return null;
    const list = (interrupted || []).filter(Boolean);
    // Runs the restart cut the panel off from that the gateway STILL HAD: the boot reconcile re-attached to
    // them, so their cards are running again and their outcomes arrive on their own. They are not interrupted
    // turns, and a wake that stayed silent about them would read as if they had vanished.
    const resumedList = (reattached || []).filter(Boolean);
    const ids = list.map((j) => String(j.id || "")).filter(Boolean).sort();
    const key = `restart|${target}|${ids.join(",")}|${proof?.runId || ""}`;
    if (this.restartWakes.has(key)) {
      this.journalAdd("restart-resume", null, "the same restart was already reported — not a second wake");
      return null;
    }
    for (const j of list) this.terminalClaim(j.thread, terminalKey(j));
    this.restartWakes.add(key);
    if (this.restartWakes.size > 25) this.restartWakes = new Set([...this.restartWakes].slice(-25));
    const lines = [];
    lines.push(
      detected
        ? `restart — the ${target} restarted and this panel did not ask for it${reason ? `: ${clip(reason, 160)}` : ""}`
        : `restart — the ${target} was restarted from this panel${requested ? ` (${requested})` : ""}${reason ? `: ${clip(reason, 160)}` : ""}`,
    );
    if (proof) {
      lines.push(
        proof.ok
          ? `  proof: one real turn through the gateway completed in ${durationText(proof.ms)} (run ${proof.runId}${proof.status ? `, ${proof.status}` : ""})${proof.output ? ` — it answered: ${clip(proof.output, 160)}` : ""}`
          : `  proof FAILED: no real turn through the gateway — ${proof.reason || proof.stage || "unknown"}. Its port may answer while every run still dies; check the provider key in the gateway's .env.`,
      );
    }
    if (!list.length) lines.push(resumedList.length ? "  nothing was interrupted." : "  nothing was interrupted: no run was still going when it stopped.");
    else lines.push(`  ${list.length} run${list.length === 1 ? "" : "s"} interrupted; the completion payload of each follows.`);
    if (resumedList.length) {
      const what = resumedList.length === 1
        ? "1 run the restart cut this panel off from was still going in the gateway"
        : `${resumedList.length} runs the restart cut this panel off from were still going in the gateway`;
      lines.push(`  ${what}, so the panel re-attached and can steer again: ${resumedList.map((j) => `${j.id}${j.runId ? ` (run ${j.runId})` : ""}`).join(", ")} — nothing was interrupted there, and the outcome of each will be reported when it ends.`);
    }
    for (const j of list) {
      const payload = j.completion || null;
      lines.push(payload ? renderCompletionNotice(payload) : `completion — ${j.thread || j.id || "a run"} ended interrupted (no payload was measured)`);
    }
    lines.push("");
    lines.push(
      list.length
        ? "Say where each interrupted run had got to and whether anything of its work still needs picking up: an interrupted run never finished, and its tree may hold the commit it made before it stopped."
        : resumedList.length
          ? "A run the restart did not kill is still going: do not report it as stopped, and leave it to finish — its outcome will be reported when the run ends."
          : "Say whether anything on the board needs a look now that it is back.",
    );
    this.persist();
    this.emit();
    this.wake(lines.join("\n"), null, "restart", { force: true });
    return { target, ids, proof: proof || null, interrupted: list.length, reattached: resumedList.length, at: nowIso(), recordId };
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
        // …and a tree a LIVE run now occupies is not this worker's leftover any more. The sweep re-checks the
        // tree at sweep time, so a SPAWN IN into a just-finished tree read that new agent's own edits as the old
        // worker's abandoned work — observed four times on one tree, the counts rising 1 modified → 2 modified →
        // 2 modified + 1 untracked → 2 modified + 2 untracked as the second agent worked. `runningJobs()` is the
        // predicate: a tree a live run's cwd holds raises no leftover, which is the check standing rule 16 asks a
        // reader to make before re-issuing work into a tree. A tree no live run holds alerts exactly as before.
        if (this.jobs?.runInTree?.(treePath)) continue;
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
    // ONE RUN PER THREAD, one worker per tree, stated next to the threads it applies to: this list is what the
    // assistant actually reads, and a small model that reads "worker X is running" as an invitation to answer it is
    // how two TO lines and three runs on one worktree happened.
    const turning = live.filter((j) => j.status === "running" || j.status === "starting");
    if (turning.length) {
      rows.push(
        "LIVE RUNS \u2014 one run per thread, one worker per tree. Do NOT write a TO line to any of these: a reply is not a " +
          "steer, it starts a SECOND run on the same files. Do not start a worker in the tree one of them is in either. " +
          "Write nothing and let each finish.",
      );
    }
    for (const j of live.slice(0, 10)) {
      const sig = toolSigs(j.lines || []).slice(-3).map((s) => `${s.tool}${s.input ? `(${clip(s.input, 40)})` : ""}`).join(" → ");
      rows.push(
        `- ${nameOf(j)} [${j.thread}] ${j.status} ${minutes(Date.now() - Date.parse(j.startedAt || nowIso()))} · ` +
          `tree ${clip(treeTail(j), 60)} · asked: ${clip(j.prompt, 100)}${sig ? ` · last calls: ${sig}` : ""}${j.approval ? ` · PARKED on: ${clip(j.approval.command, 80)}` : ""}`,
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
      "One run per thread, one worker per tree: never write a TO line to a thread the digest lists as LIVE \u2014 a reply",
      "starts a SECOND run on the same files rather than steering the one that is going. Write nothing and let it finish.",
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
      // The long tier, in full: the rules above are clipped to 200 characters each and only the last 12
      // ride along, so the reasoning behind them has to arrive some other way. This is that way.
      ...this.charterBriefing(),
      "",
      "Watches you are keeping:",
      ...(this.watches.filter((w) => w.state !== "done").length
        ? this.watches.filter((w) => w.state !== "done").slice(-10).map((w) => `- [${w.thread}] ${clip(w.title, 120)}${w.minutes ? ` · deadline ${w.minutes}m` : ""}${w.state === "alerted" ? " · overdue" : ""}`)
        : ["(none)"]),
      "",
      // One line, not a second charter. The reader switched this on in the header, and when it asks why the
      // assistant is being so talkative this sentence is the answer it can give back.
      ...(this.aggressive.on
        ? [
            "Aggressive mode is ON — the reader switched it on in the header. Spend the extra tokens: check every live card on every pass, keep each agent moving toward a done spot, and keep pushing until the fleet is waiting on something outside this board. That is why you are being woken so often; if the reader asks why you are so talkative, this is the reason, and you should say so plainly rather than blame the board.",
            "",
          ]
        : []),
      "The board right now:",
      this.digest(),
      "",
      ...actionGrammar(s),
      "The charter above is the long tier of your memory: the reasoning behind the rules, written down so a compaction cannot take it. Add an entry when a standing answer changes or a long task closes, naming what changed — the panel dates it and prunes the oldest entries over the cap. Do not restate the board in it; that is the scratchpad and the journal.",
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
  // It answers with what the queue decided. Every existing caller is fire-and-forget and ignores it; the one caller
  // that cannot is a press the reader can see (the COMPLETE chip), because a refusal has to reach the card as a verdict
  // rather than as a pill claiming an ask that never left the panel.
  wake(reason, alertId = null, rule = null, { force = false } = {}) {
    if (!this.settings.enabled) return { queued: false, refused: "disabled" };
    const cut = Date.now() - 3600_000;
    this.wakes = this.wakes.filter((t) => t > cut);
    // `force` is for the one wake a restart fires: an operator action must not be dropped by the
    // hourly budget whose job is to stop a noisy board from spending every turn.
    if (!force && this.wakes.length >= this.settings.maxWakesPerHour) {
      this.journalAdd("wake-suppressed", null, `rate limit reached (${this.settings.maxWakesPerHour}/h): ${reason}`);
      return { queued: false, refused: "budget", limit: this.settings.maxWakesPerHour };
    }
    this.pendingWake.push({ reason, alertId, rule });
    // Wakes fired by one sentry pass are one thought: two watches on the same worker finish in the same tick, and
    // two assistant turns answering that one event is noise. 150 ms is long enough to collect the pass and short
    // enough that nobody waits for it.
    if (this.wakeTimer) return { queued: true, pending: this.pendingWake.length, coalesced: true };
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      void this.flushWake();
    }, 150);
    this.wakeTimer.unref?.();
    return { queued: true, pending: this.pendingWake.length, coalesced: false };
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
    // The gateway build cannot deliver a clarify question — learned from a run's own stream rather than
    // from configuration (lib/clarify.js). Say it once in the journal: the board's agents will start
    // asking in prose, and a reader deserves the reason instead of a puzzle. The reader's own rules
    // still answer what they can; this only explains why no box appeared.
    if (evt.type === "job" && evt.job?.clarifyUnavailable && !this.clarifyNoted) {
      this.clarifyNoted = true;
      this.journalAdd(
        "clarify-unavailable",
        evt.job.thread || null,
        "this gateway build refuses the clarify tool — agents are told to ask in prose until it is upgraded (docs/clarify-over-the-runs-api.md)",
      );
    }
    if (evt.type === "job" && evt.job?.thread === ASSISTANT_THREAD && !isLive(evt.job)) {
      // The harvest reads the turn and carries out what it wrote; it must never throw back into the store's
      // event stream, because the job that follows this one would then be the one nobody sees. A turn whose
      // actions could not be read at all says so in the journal rather than going quiet.
      try {
        void this.harvest(evt.job);
      } catch (err) {
        this.journalAdd("harvest-failed", evt.job.id, `this turn's actions were not read — ${reasonOf(err)}`);
      }
      // A turn of the assistant's own has just ended, so every COMPLETE chip ask it was handed has been read: the next
      // press on that card is a new question rather than a duplicate of one nobody has looked at yet.
      if (this.completeAsks.size) this.completeAsks.clear();
      void this.flushWake();
      this.emit();
    }
  }

  // The assistant's answer is prose plus, maybe, command lines. Only the command lines are actions, and every
  // one of them is read: a turn writes its SPAWN, its TO, its NOTE and its RULE on separate lines, and the run
  // stream opens a text line per paragraph, so the whole reply — not the paragraph it ended on — is what the
  // action lines have to be read from. Reading the last paragraph alone (which is what `lastProse` returns)
  // carried out whatever the turn put last and silently dropped everything above it: measured on the live
  // panel, a SPAWN and a TO vanished with no job, no alert and no journal line while the NOTE under them
  // applied normally.
  harvest(job) {
    // One turn, one harvest: see `harvested` in the constructor. The mark is taken before any action runs, so a
    // crash mid-way cannot replay the same spawn on the next start either.
    if (!job?.id || this.harvested.has(job.id)) return;
    const answer = turnProse(job.lines);
    if (!answer) return;
    this.harvested.add(job.id);
    if (this.harvested.size > 50) this.harvested = new Set([...this.harvested].slice(-50));
    this.persist();
    const actions = parseActions(answer);
    if (
      !actions.to.length && !actions.watch.length && !actions.note.length &&
      !actions.spawn.length && !actions.rule.length && !actions.charter.length && !actions.restart.length
    ) {
      return;
    }
    const carried = [];
    for (const note of actions.note) {
      carried.push(
        this.carry("note-failed", null, `NOTE: ${clip(note, 100)}`, () => {
          this.notes = `${this.notes}${this.notes ? "\n" : ""}- ${note}`.slice(-LINE_CAP);
          this.journalAdd("note", null, note);
        }),
      );
    }
    // A rule the assistant writes for itself. The reader's rules are still the reader's: this can add, not
    // edit or delete, and the Scratchpad tab marks which is which. Capped at 40 with the oldest trimmed by
    // addRule, so an agent that keeps restating itself cannot crowd out the reader's own answers.
    for (const text of actions.rule) {
      carried.push(
        this.carry("rule-failed", null, `RULE: ${clip(text, 100)}`, () => {
          if (this.rules.length >= 40) {
            this.journalAdd("rule-skipped", null, `the scratchpad already holds 40 rules: ${clip(text, 120)}`);
            return;
          }
          this.addRule(text, "assistant");
        }),
      );
    }
    // CHARTER: lines — the assistant's own way to write the long tier. Nothing to gate: it writes its own
    // file, and an entry that cannot fit is reported in the journal rather than dropped in silence.
    for (const entry of actions.charter) {
      carried.push(
        this.carry("charter-failed", null, `CHARTER: ${clip(entry, 100)}`, () => {
          this.appendCharter(entry, { by: "assistant", kind: "entry" });
        }),
      );
    }
    for (const w of actions.watch) {
      carried.push(
        this.carry("watch-failed", w.thread, `WATCH ${w.thread}`, () => {
          if (!this.jobs.firstOfThread(w.thread)) {
            // A watch on a thread that is not on the board is a line that could not be carried out, and saying
            // so is the difference between a dropped action and an action that never existed.
            this.journalAdd("watch-skipped", w.thread, "no such thread on the board");
            return;
          }
          this.addWatch({ thread: w.thread, title: w.title, minutes: w.minutes }, "assistant");
        }),
      );
    }
    for (const to of actions.to) {
      carried.push(
        this.carry("send-failed", to.thread, `TO ${to.thread}: ${clip(to.text, 100)}`, () => {
          const first = this.jobs.firstOfThread(to.thread);
          if (!first) {
            this.journalAdd("draft-skipped", to.thread, "no such thread on the board");
            return;
          }
          // ONE RUN PER THREAD, one worker per tree. Checked before EITHER branch: a draft the reader can send is the
          // same loaded gun one press later, and the damage this prevents is two agents editing one tree. Nothing is
          // written and the journal says why, so the reader sees the TO was refused rather than lost.
          const busy = this.jobs.busyFor(to.thread);
          if (busy.held) {
            this.journalAdd(
              "to-skipped",
              to.thread,
              `${busy.where === "thread" ? "that thread" : "that worktree"} already has a live run (${busy.by
                .map((b) => `${b.id} ${b.thread} ${b.status}`)
                .join(", ")}) \u2014 nothing was sent, and nothing should be until it ends: \u201c${clip(to.text, 140)}\u201d`,
            );
            return;
          }
          const auto = this.settings.autonomy === "auto" || this.settings.autonomy === "auto-safe";
          if (auto) {
            return this.answerThread(to.thread, to.text, { source: "assistant", autonomy: this.settings.autonomy })
              .then((j) => this.journalAdd("sent", to.thread, `assistant replied (job ${j.id})`));
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
        }),
      );
    }
    // ---- TODO lines: the worktree's own list ---------------------------------------------------------------
    // A `TODO IN <tree> | …` line names its own tree and is applied here. A `TODO …` line written UNDER a SPAWN
    // line belongs to the tree that SPAWN starts (that is how a card's acceptance items are seeded: one TODO line
    // per item, under the SPAWN). A TODO line with NEITHER is refused out loud — never guessed onto some tree,
    // because the wrong tree is a list the reader will believe.
    const todoBySpawn = new Map();
    const todoLoose = [];
    for (const t of actions.todo) {
      if (t.target) continue; // handled on its own, below
      if (t.spawn === null || t.spawn === undefined) todoLoose.push(t);
      else {
        const idx = Number(t.spawn);
        if (!todoBySpawn.has(idx)) todoBySpawn.set(idx, []);
        todoBySpawn.get(idx).push(t);
      }
    }
    const todosFor = (idx) =>
      (todoBySpawn.get(idx) || [])
        .filter((t) => t.op === "add" && !t.error && String(t.text || "").trim())
        .map((t) => String(t.text));
    // A TODO line that names a tree itself: resolved by the store (a path, a directory name, a branch, a tag or a
    // thread), and every outcome journalled — applied or refused, with the reason.
    const explicitTodo = actions.todo.filter((t) => t.target);
    if (explicitTodo.length && this.todos) {
      carried.push(
        this.carry("todo-failed", job.thread, `TODO IN (${explicitTodo.length} line${explicitTodo.length === 1 ? "" : "s"})`, () => {
          const results = this.todos.applyLines({ lines: explicitTodo, by: "assistant", from: "assistant" });
          for (const r of results) {
            if (r.ok) this.journalAdd("todo", job.thread, `#${r.item?.id ?? r.id} ${r.op} in ${r.key}: ${clip(r.item?.text || r.text || "", 120)}`);
            else this.journalAdd("todo-refused", job.thread, `${clip(r.raw || r.text || "", 120)} — ${r.error}`);
          }
          if (results.some((r) => r.ok)) this.todosChanged?.();
        }),
      );
    }
    for (const t of todoLoose) {
      this.journalAdd(
        "todo-skipped",
        job.thread,
        `“${clip(t.raw || t.text || "TODO", 120)}” — a TODO line has to name a worktree: write it under the SPAWN line it belongs to, or name one with \`TODO IN <tree> | …\``,
      );
    }
    for (const sp of actions.spawn) {
      const idx = actions.spawn.indexOf(sp);
      const texts = todosFor(idx);
      const what = `${sp.existing ? "SPAWN IN" : "SPAWN"} ${clip(sp.target, 80)}`;
      carried.push(
        this.carry("spawn-failed", null, `${what}: ${clip(sp.prompt, 80)}`, () => {
          if (this.settings.spawn === "off") {
            this.journalAdd("spawn-skipped", null, `creating worktrees is switched off: ${clip(sp.prompt, 120)}`);
            return;
          }
          if (this.settings.spawn === "ask") {
            this.addSpawnAlert({ ...sp, todos: texts });
            return;
          }
          return this.startSpawn({ ...sp, todos: texts }, { source: "assistant" });
        }),
      );
    }
    // RESTART is the one action that acts on this panel's own process: it is QUEUED here and never
    // run inside this turn, because this turn is a run in the gateway a restart would kill. A refusal
    // (no provider key, or one already queued) is written to the journal, not raised.
    for (const rs of actions.restart) {
      if (typeof this.onRestart !== "function") {
        this.journalAdd("restart-skipped", job.thread, `this panel has no restart action wired: RESTART ${rs.target}`);
        continue;
      }
      try {
        const rec = this.onRestart({ target: rs.target, reason: rs.reason, waitFor: job.thread, requestedBy: "assistant" });
        this.journalAdd("restart-queued", job.thread, `${rs.target} restart queued (${rec.id}) — it runs once this turn has ended${rs.reason ? `: ${clip(rs.reason, 120)}` : ""}`);
      } catch (e) {
        this.journalAdd("restart-refused", job.thread, `RESTART ${rs.target} refused: ${String((e && e.message) || e)}`);
      }
    }
    this.persist();
    this.emit();
    // One promise for the whole turn, so a caller can wait for the replies and spawns it started. Nothing here
    // can reject: every action reports its own failure as a journal line, which is the only reason the harvest
    // is safe to run from the job event stream.
    return Promise.allSettled(carried);
  }

  // One written action, carried out on its own. What one line does is never another line's business: a SPAWN
  // that cannot start, a TO whose thread lookup throws and a WATCH that names nothing are three independent
  // outcomes, and the lines that can still be carried out are. A sync throw, a rejected promise and a refusal
  // all come back as one journal line naming the line and the reason, and the next action runs either way —
  // an injected handler that throws (the spawner, the project registry, the job store) used to abort the rest
  // of the harvest with nothing written down at all.
  carry(failKind, thread, what, fn) {
    const failed = (err) => this.journalAdd(failKind, thread, `${what} — ${reasonOf(err)}`);
    try {
      const out = fn();
      if (out && typeof out.then === "function") return out.catch(failed);
      return out;
    } catch (err) {
      failed(err);
      return null;
    }
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
        // The TODO lines the assistant wrote under this SPAWN: they are the tree's list, and they are seeded when the
        // card is actually started (this alert is the ask-mode detour — nothing has been cut yet, so there is no tree
        // to key them on).
        todos: Array.isArray(sp.todos) ? sp.todos.map(String) : [],
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

  // ---- aggressive mode -------------------------------------------------------------------------

  // The profile as it is written: the knobs from AGGRESSIVE plus every rule at the top rung. Built here so the
  // page can show what the mode holds without carrying a second copy of the table.
  aggressiveProfile() {
    return { ...AGGRESSIVE, rules: Object.fromEntries(AGGRESSIVE_RULE_IDS.map((id) => [id, AGGRESSIVE_RULE_LEVEL])) };
  }

  // What the page needs to draw the toggle and grey the controls the mode holds. Not the saved values: those
  // are the reader's, they stay in the store, and the page only needs to know how many will come back.
  aggressiveState() {
    const saved = this.aggressive.saved || { settings: {}, rules: {} };
    let present = 0;
    let absent = 0;
    for (const key of AGGRESSIVE_KEYS) {
      if (saved.settings[key] && saved.settings[key].present) present += 1;
      else absent += 1;
    }
    for (const id of AGGRESSIVE_RULE_IDS) {
      if (saved.rules[id] && saved.rules[id].present) present += 1;
      else absent += 1;
    }
    return {
      on: Boolean(this.aggressive.on),
      at: this.aggressive.at || null,
      holds: { settings: AGGRESSIVE_KEYS.slice(), rules: AGGRESSIVE_RULE_IDS.slice() },
      profile: this.aggressiveProfile(),
      // How many of the reader's own values a switch-off brings back, and how many absent keys it deletes
      // again. Deliberately NOT called `saved`: the record itself (with the values) lives in the store, and one
      // name for two different things is how a caller ends up reading counts as if they were settings.
      restore: { present, absent, total: present + absent },
      incomplete: Boolean(this.aggressive.incomplete),
    };
  }

  // What goes to disk. `{ on: false }` and nothing else is the honest empty state: there is nothing to restore.
  aggressiveSnapshot() {
    const a = this.aggressive;
    if (!a || !a.on) return { on: false };
    return { on: true, at: a.at || nowIso(), saved: a.saved || { settings: {}, rules: {} } };
  }

  // Write the profile over the live settings. NO recording: that belongs to setAggressive and only to the press
  // that turns the mode ON. Called again on load when the mode was on when the panel stopped, so a file whose
  // settings drifted still shows the aggressive values for the controls the mode holds.
  applyAggressiveProfile() {
    this.settings = {
      ...this.settings,
      ...pickSettings(AGGRESSIVE, this.settings),
      rules: { ...this.settings.rules, ...Object.fromEntries(AGGRESSIVE_RULE_IDS.map((id) => [id, AGGRESSIVE_RULE_LEVEL])) },
    };
    for (const key of AGGRESSIVE_KEYS) this.settingsExplicit.settings.add(key);
    for (const id of AGGRESSIVE_RULE_IDS) this.settingsExplicit.rules.add(id);
  }

  // Put back exactly what the record holds: the old value where there was one, and — where there was NOT — no
  // key at all, so the knob follows its default again instead of staying frozen at whatever the default was the
  // day the button was pressed. Anything the record does not cover is left alone. A restored value goes back
  // through the same validator as every other setting, so a hand-edited file cannot put an illegal one in place.
  restoreAggressive() {
    const rec = this.aggressive.saved || { settings: {}, rules: {} };
    const settings = { ...this.settings };
    const rules = { ...this.settings.rules };
    let restored = 0;
    let dropped = 0;
    for (const key of AGGRESSIVE_KEYS) {
      const r = rec.settings[key];
      const back = r && r.present ? pickSettings({ [key]: r.value }, this.baseSettings) : {};
      if (r && r.present && back[key] !== undefined) {
        settings[key] = back[key];
        this.settingsExplicit.settings.add(key);
        restored += 1;
      } else {
        settings[key] = this.baseSettings[key];
        this.settingsExplicit.settings.delete(key);
        dropped += 1;
      }
    }
    for (const id of AGGRESSIVE_RULE_IDS) {
      const r = rec.rules[id];
      const back = r && r.present ? pickRules({ [id]: r.value })[id] : undefined;
      if (back !== undefined) {
        rules[id] = back;
        this.settingsExplicit.rules.add(id);
        restored += 1;
      } else {
        rules[id] = this.baseSettings.rules[id];
        this.settingsExplicit.rules.delete(id);
        dropped += 1;
      }
    }
    this.settings = { ...settings, rules };
    this.aggressive = { on: false, at: null, saved: { settings: {}, rules: {} }, incomplete: false };
    return { restored, dropped };
  }

  // The header's toggle. It returns what happened rather than a bare boolean, because both no-ops have to say
  // so: pressing ON twice must not re-record (that would capture the aggressive values as the reader's own),
  // and pressing OFF when the mode was never on has nothing to restore and must say that, not pretend.
  setAggressive(on = !this.aggressive.on) {
    const want = Boolean(on);
    const was = Boolean(this.aggressive.on);
    if (want === was) {
      const reason = want
        ? "aggressive mode is already on — its saved settings are still the ones from the first press"
        : "aggressive mode is not on — there is nothing to restore";
      this.journalAdd("aggressive", null, `no change: ${reason}`);
      return { changed: false, on: was, reason, aggressive: this.aggressiveState() };
    }
    const result = { changed: true, on: want };
    if (want) {
      // Record BEFORE writing: the record is the only thing that lets the next press put things back, and once
      // the profile is over the settings the old values are gone. A key the file never carried is recorded as
      // absent — with no value — so switch-off deletes it again rather than freezing today's default.
      const saved = { settings: {}, rules: {} };
      let absent = 0;
      for (const key of AGGRESSIVE_KEYS) {
        const present = this.settingsExplicit.settings.has(key);
        saved.settings[key] = present ? { present: true, value: this.settings[key] } : { present: false };
        if (!present) absent += 1;
      }
      for (const id of AGGRESSIVE_RULE_IDS) {
        const present = this.settingsExplicit.rules.has(id);
        saved.rules[id] = present ? { present: true, value: this.settings.rules[id] } : { present: false };
        if (!present) absent += 1;
      }
      this.aggressive = { on: true, at: nowIso(), saved, incomplete: false };
      this.applyAggressiveProfile();
      const total = AGGRESSIVE_KEYS.length + AGGRESSIVE_RULE_IDS.length;
      this.journalAdd(
        "aggressive",
        null,
        `on — ${AGGRESSIVE_KEYS.length} knobs and ${AGGRESSIVE_RULE_IDS.length} rules at their most aggressive values; ${total - absent} recorded with the value they held, ${absent} recorded as absent and deleted again on switch-off`,
      );
    } else {
      const { restored, dropped } = this.restoreAggressive();
      this.journalAdd("aggressive", null, `off — restored ${restored} settings to your own values, deleted ${dropped} that were absent before the mode went on`);
      result.restored = restored;
      result.dropped = dropped;
    }
    this.restartSentry();
    this.persist();
    this.emit();
    result.aggressive = this.aggressiveState();
    return result;
  }

  // The knobs and rules the profile is holding. `setSettings` refuses a write to one of these while the mode is
  // on (the page greys them out, but a POST, a script or a second tab must not quietly move one), and the page
  // reads the same lists to know exactly which controls to disable.
  aggressiveHolds() {
    if (!this.aggressive.on) return { settings: new Set(), rules: new Set() };
    return { settings: new Set(AGGRESSIVE_KEYS), rules: new Set(AGGRESSIVE_RULE_IDS) };
  }

  // Rebuild the sentry's interval: the cadence lives in the timer, so changing `seconds` — or switching the
  // sentry on — has to replace it. A sentry the settings leave switched off stays stopped.
  restartSentry() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.settings.enabled) this.start();
  }

  // ---- the reader's actions -----------------------------------------------------------------

  setSettings(patch = {}) {
    // While aggressive mode is on, the knobs and rules it holds are not the reader's to change. The page
    // disables them; this refuses the same write if it arrives anyway, and reports what it dropped so the
    // caller can say why a value did not move.
    const holds = this.aggressiveHolds();
    const accepted = {};
    const refused = [];
    for (const [k, v] of Object.entries(patch || {})) {
      if (k === "rules") continue;
      if (holds.settings.has(k)) refused.push(k);
      else accepted[k] = v;
    }
    const acceptedRules = {};
    for (const [k, v] of Object.entries((patch && patch.rules) || {})) {
      if (holds.rules.has(k)) refused.push(`rules.${k}`);
      else acceptedRules[k] = v;
    }
    const picked = pickSettings(accepted, this.settings);
    const pickedRules = pickRules(acceptedRules);
    this.settings = {
      ...this.settings,
      ...picked,
      rules: { ...this.settings.rules, ...pickedRules },
    };
    // A knob the reader sets by hand is theirs from now on: it has to be written back, or the next restart
    // would drop it and the change would look like it never happened.
    for (const key of Object.keys(picked)) this.settingsExplicit.settings.add(key);
    for (const id of Object.keys(pickedRules)) this.settingsExplicit.rules.add(id);
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
    if (refused.length) {
      this.journalAdd("settings", null, `refused ${refused.length} change${refused.length === 1 ? "" : "s"} — aggressive mode holds ${refused.join(", ")} (switch it off in the header to change them)`);
    }
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
        this.appendCharter(`the assistant refined a standing rule: ${t}`, { by: "panel", kind: "rule" });
        this.persist();
        this.emit();
        return this.rules;
      }
    }
    this.rules.push({ id: randomUUID().slice(0, 8), text: t, at: nowIso(), by });
    this.rules = this.rules.slice(-40);
    this.journalAdd("rule", null, `${by === "assistant" ? "assistant wrote: " : ""}${t}`);
    // A standing answer changing is exactly what the charter is for: the reasoning goes there, dated.
    this.appendCharter(`${by === "assistant" ? "the assistant" : "the reader"} added a standing rule: ${t}`, { by: "panel", kind: "rule" });
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

  // The COMPLETE chip's press, on a card whose latest turn is `done`. One message, QUEUED for the assistant through the
  // same wake queue an alert handed over uses (`alertAction(id, "ask")` lands in the same `wake`) — never `say()`, which
  // starts a turn at once and would talk over a run already in flight — and never a message to the worker: a finished
  // agent is not resumed by this press. The answer says what the queue decided, because the chip shows the reader whether
  // the ask landed, and a refusal (a disabled assistant, the hourly budget) must reach the card as a refusal.
  askAboutComplete(id) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`unknown card: ${id}`);
    const status = String(job.status || "");
    if (status !== "done") throw new Error(`that card's latest turn is ${status || "unknown"}, not done — there is nothing finished on it to check`);
    const key = String(job.id || id);
    const already = this.completeAsks.get(key);
    if (already) {
      // The same finished turn, asked twice, before the assistant has turned on the first ask: one thought, queued once.
      this.journalAdd("asked-complete", job.thread || null, `already queued at ${already} — nothing was queued twice`);
      this.persist();
      this.emit();
      return { ok: true, queued: false, duplicate: true, at: already, thread: job.thread || null };
    }
    const text = this.completeAskText(job);
    const wake = this.wake(text, null, "complete");
    if (!wake?.queued) {
      const reason = wake?.refused === "disabled"
        ? "the board assistant is switched off in Settings, so nothing was queued — switch it back on and press COMPLETE again"
        : `the assistant's wake budget is spent (${wake?.limit ?? this.settings.maxWakesPerHour}/hour), so nothing was queued — raise it in Settings, or press COMPLETE again once the hour rolls over`;
      this.journalAdd("ask-refused", job.thread || null, reason);
      this.persist();
      this.emit();
      return { ok: true, queued: false, refused: wake?.refused || "refused", reason, thread: job.thread || null };
    }
    const at = nowIso();
    this.completeAsks.set(key, at);
    // Bounded like every other thing this module keeps: the map is cleared when an assistant turn ends, so this only
    // trims a reader pressing COMPLETE across many cards without a turn in between.
    if (this.completeAsks.size > 40) this.completeAsks = new Map([...this.completeAsks].slice(-40));
    this.journalAdd("asked-complete", job.thread || null, clip(text, 220));
    this.persist();
    this.emit();
    return { ok: true, queued: true, duplicate: false, at, thread: job.thread || null, text };
  }

  // What the assistant is handed when the reader presses COMPLETE. It has to stand on its own: by the time the turn runs,
  // nothing else of that moment is on the board. The card, the tree, the branch, the run, the panel's own measurement of
  // what the turn left behind and where its report is — then the two things to answer, and who asked and how.
  completeAskText(job = {}) {
    const c = job.completion || {};
    const tree = job.tree || {};
    const measured = c.commits
      ? `the panel measured: left ${c.commits.count} commit${c.commits.count === 1 ? "" : "s"} not on ${c.commits.base || "the base"}${c.commits.subjects?.length ? ` — ${c.commits.subjects.slice(0, 3).join(" · ")}` : ""}`
      : c.treeNote
        ? `the panel measured: commits not measured (${c.treeNote})`
        : `the panel measured nothing about the tree this turn worked in`;
    const report = c.report?.path ? `its report: ${c.report.path}` : `no report file was found for this run`;
    const text = [
      `[complete] a finished card on the board says it is done, and the reader pressed its COMPLETE chip — this ask is that press, queued for you. Nothing was sent to the agent that finished.`,
      ``,
      `thread: ${job.thread || "not recorded"}`,
      `worktree: ${job.worktreePath || job.ownerPath || job.cwd || "not recorded"}`,
      `branch: ${job.branch || tree.branch || "not recorded"}`,
      `run: ${job.runId || "not recorded"}`,
      measured,
      report,
      ``,
      `Judge whether this really is complete — on the evidence, not on the agent having said "done": are those commits actually on main (or in a PR that will get there), what state is that PR in, and does the report say what it proved and what it admits it did not?`,
      `Then say what still has to happen for that worktree or project — the merge, the claim nobody proved, the work left in the tree — and who owns it.`,
    ].join("\n");
    // NOT `clip`: that collapses every run of whitespace, which folds this list into one line and loses the one field
    // per line the assistant reads it as. LINE_CAP is a length guard only, so the paragraph breaks survive it.
    return text.length > LINE_CAP ? text.slice(0, LINE_CAP) : text;
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
    // The backstop for every caller of this method \u2014 the assistant's own TO, the reader pressing Send on a draft,
    // and whatever comes next. A run is never posted into a worker that is already turning (see Jobs.busyFor): that
    // is how one thread ends up with three runs editing the same files. A refusal is a decision, not a failure, so it
    // carries a code the route answers with a conflict and the panel can say out loud.
    const hold = this.jobs.busyFor(thread);
    if (hold.held) {
      const err = new Error(
        `${hold.where === "thread" ? "that thread" : "that worktree"} already has a live run (${hold.by
          .map((b) => `${b.id} ${b.thread} ${b.status}`)
          .join(", ")}) \u2014 a reply would start a second run on the same files, so nothing was sent. Steer the running turn instead, or wait for it to end.`,
      );
      err.code = "thread_busy";
      throw err;
    }
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
