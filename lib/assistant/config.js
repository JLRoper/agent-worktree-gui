// The assistant's contract with the reader: every knob it can set, the rule table the page renders, and the
// one place that decides what a valid setting is.
//
// Nothing here reads state, opens a file or looks at a job. The constructor runs `stripConfig` over the
// config file's `assistant` block, `load`/`setSettings` run `pickSettings`/`pickRules` over what is on disk
// or on the wire, and `state()` hands `ruleDefs`/`escalations`/`autonomy`/`spawnModes` to the page. A knob's
// bounds, its default and the words the page uses for it are one decision, so they live in one file.
//
// This module imports nothing on purpose: every clamp below is arithmetic. lib/assistant.js imports these
// names back and re-exports the four the page and the harnesses read directly.

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
  leftover: { label: "Uncommitted work in a finished tree", hint: "a worker ended and its worktree still holds modified or untracked files and no live run holds it — commits not on main are the normal state until you merge them, so they are context, not a trigger", default: "alert" },
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
export const WAKE_HINTS = {
  watch: "look at that worker's latest output: if it is still moving say what it is doing, if it has finished say how it ended, and if it looks stuck say what you would steer it with.",
  loop: "say what it is repeating and what you would change; a TO line drafts the steer.",
  errorloop: "say what the failure is and what you would try; a TO line drafts the steer.",
  approval: "say what the command does in one line. Do not answer the approval — that stays on the agent's own card.",
  question: "draft the answer with TO only if your rules or notes cover it; otherwise say what you would send.",
  collision: "say which tree they share and which one you would move.",
  restart: "say where each interrupted run had got to and whether its work still needs picking up.",
  quiet: "say whether it looks stalled or just slow, and what you would check.",
  context: "say whether it is worth finishing this turn or starting a fresh one.",
  noevidence: "say what evidence is missing and what you would ask the worker for.",
  repeat: "say what keeps failing and what you would change; a TO line drafts the steer, and if the fix belongs somewhere else, SPAWN a worker for it.",
  leftover: "say what is left in that tree and what you would do with it — commit it, merge it, or drop it; SPAWN IN that directory starts a worker on it if it needs finishing.",
  child: "say what the child was doing and whether you would wait or have its parent called off; you cannot reach a child directly, only through its parent.",
  interrupted: "say whether that turn's work is already committed or merged, and whether the thread needs its one resume; a TO line drafts the revive.",
  // Not a rule of its own: this hint rides with the ask the reader queues by pressing the COMPLETE chip on a finished card
  // (`askAboutComplete`). It is the one thing worth doing about that press, in the assistant's own terms.
  complete: "judge the claim on the evidence — the commits really on main, the PR's state, what the report says it proved and what it admits it did not — not on the agent saying done; then say what is still owed to that worktree and who owns it.",
};

export const ESCALATIONS = ["log", "alert", "wake", "act"];
export const AUTONOMY = ["draft", "auto-safe", "auto"];
export const SPAWN_MODES = ["off", "ask", "auto"];

export const DEFAULTS = {
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

export const ALERT_CAP = 80;
export const JOURNAL_CAP = 300;
export const LINE_CAP = 8000;
// The continuity file: the long tier of the assistant's memory, beside the job store like the scratchpad.
export const CHARTER_FILE = "assistant-charter.md";
export const MAX_LINES = 60;
// Clamping is reading a number off a config file or off the page's own request: anything that is not one
// falls back to the knob's base, which is why every bound in `pickSettings` goes through it.
export const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

export function stripConfig(assistant) {
  // config.json may carry a partial `assistant` block; only the known knobs are honoured.
  const { rules, ...rest } = assistant || {};
  return pickSettings(rest);
}

export function pickSettings(from = {}, base = DEFAULTS) {
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

export function pickRules(rules) {
  const out = {};
  for (const [k, v] of Object.entries(rules || {})) if (RULE_DEFS[k] && ESCALATIONS.includes(v)) out[k] = v;
  return out;
}

// ------------------------------------------------------------------------------------------------
// The aggressive assistant profile: what the header's "⚡ Aggressive" toggle holds while it is on.
//
// Every number here is a bound `pickSettings` itself enforces, so nothing the profile writes can be
// discarded on the way to disk: the wake budget is the top of [0, 60], and each detection window is the end
// of its own range that notices SOONER (the sentry looks twice as often, and calls something quiet, parked,
// looping, full, stale or silent at the first moment the rule allows).
//
// `enabled` is in the profile on purpose and is the one knob the reader did not name: a mode whose whole
// point is that the assistant wakes on everything is meaningless with the sentry switched off, so switching
// aggressive on switches the sentry on. It is remembered like every other key, so turning aggressive off
// puts a switched-off assistant back to switched off.
//
// Two rules are worth a word, because the profile overrides a default that was chosen deliberately:
//   interrupted - ships at `alert` ON PURPOSE (a panel restart rewrites every running job as `interrupted` in
//     one pass, so a wake default would spend the whole hourly budget on one restart). Aggressive mode is the
//     reader saying "spend it": every rule goes to the top rung, and this one is why the mode costs tokens.
//   watch - already `wake` (a watch is the reader explicitly asking to be told, so an alert alone would be a
//     notice nobody reads). The profile takes it to `act` like the rest, which only adds the reply it may
//     already send when autonomy allows.
export const AGGRESSIVE = {
  enabled: true,
  autonomy: "auto",
  spawn: "auto",
  seconds: 2,
  repeatLimit: 2,
  quietSeconds: 30,
  approvalSeconds: 15,
  contextPercent: 50,
  leftoverMinutes: 1,
  childQuietSeconds: 60,
  repeatTurns: 2,
  maxWakesPerHour: 60,
  rearmSeconds: 60,
};
// The top rung: `wake`, plus the assistant may send a reply when it produces one (still gated by autonomy).
export const AGGRESSIVE_RULE_LEVEL = "act";
// The knobs and rule ids the profile writes, in the order the Settings tab shows them. Derived, never typed
// out again: a rule added to RULE_DEFS is held by the profile the moment it exists.
export const AGGRESSIVE_KEYS = Object.keys(AGGRESSIVE);
export const AGGRESSIVE_RULE_IDS = Object.keys(RULE_DEFS);
