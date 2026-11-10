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
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
// Where the panel's state lives, resolved once: the scratchpad and the charter are two of its files.
import { statePaths } from "./paths.js";
// The browser's own attachment line, built and read on this side of the wire: a turn that carried a file has to
// hand it to the worker it spawns, and the one path that may ever be handed on is one inside the attachments
// directory this panel stores uploads in.
import { droppedAttachmentLine, inheritAttachments, inheritanceBlock, parseAttachmentBlock, stripAttachmentLines } from "./attachments.js";
// "Is this directory a tree of its own?" — the question a reply's cwd has to answer before a run is started there.
// The directory a reply runs in used to be a `stat().isDirectory()` test, which a released tree's leftover folder passes.
import { replyTree, treeOnDisk } from "./own-tree.js";
// The run's own directory, not the card's owner field: a card the old attach fallback filed on a parent checkout
// must never be read as working there (lib/job-trees.js has the case). Every "which tree is this run in" answer in
// this file comes from jobTreePath.
import { filedOwnerPath, jobTreePath } from "./job-trees.js";
import {
  AGGRESSIVE,
  AGGRESSIVE_KEYS,
  AGGRESSIVE_RULE_IDS,
  AGGRESSIVE_RULE_LEVEL,
  ALERT_CAP,
  ASK_TEXT_CAP,
  AUTONOMY,
  CHARTER_FILE,
  CLARIFY_REASK_AFTER_MS,
  CLARIFY_REASK_EVERY_MS,
  COMMAND_AUDIT_MODES,
  DEFAULTS,
  ESCALATIONS,
  JOURNAL_CAP,
  MAX_LINES,
  NOTES_CAP,
  RULE_DEFS,
  SETTINGS_SCOPE,
  SPAWN_INTENT_CAP,
  SPAWN_MODES,
  SPAWN_WATCH_MS,
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
// The board's digest as an append-only tail: the message builder, the per-item state token, the transcript file and
// the read tool behind a pointer. `lib/assistant.js` owns WHICH items and WHEN the message is appended; this module
// owns the shape and the comparison, so a test can drive all of it without a panel.
import {
  LIVE_RUNS_LINE,
  appendDigestMessage,
  buildDigestMessage,
  digestPathOf,
  itemStateOf,
  itemTextOf,
  readDigestTail,
  readTurn as readTurnAt,
} from "./assistant/digest-tail.js";
import { looksLikeBareWork, looksLikeQuestion, matchRule, pickChoice } from "./assistant/match.js";
import { actionGrammar, parseActions } from "./assistant/actions.js";
import {
  COMMAND_AUDIT_CAP,
  COMMAND_AUDIT_WINDOW_MS,
  claimLine,
  gaps as auditGaps,
  newAudit,
  scanCommands,
  settleLine,
} from "./assistant/audit.js";
import { CARRIED_CAP, readAssistantFile, writeAssistantFile } from "./assistant/store-file.js";
import { judgeLanded, mergedPr } from "./assistant/landed.js";
// One assistant's own profile — its knobs, its rule levels and its default role prompt — as a file beside its
// charter. This module owns the shape and the writer; the class below owns WHICH assistant a read or a write is for.
import { EMPTY_PROFILE, PROMPT_CAP, dropLegacyDock, pickEscalation, pickProfile, pickPromptBy, pickWakeEvery, profileRelFor, readLegacyDock, readProfileFile, writeProfileFile } from "./assistant/profile.js";
// `charterMetaFor` is aliased at the import: the class has a METHOD of that name (one assistant's meta, resolved
// from its own file), and two identical names in one module is how a call meant for the helper ends up reading
// Assistant #1's charter while asking about Assistant #2's. The alias makes which one is meant unambiguous.
import { appendCharterEntry, charterMetaFor as charterMetaOf, readCharterFile, writeCharterFile } from "./assistant/charter-file.js";
// One assistant's scratchpad, beside its charter. #1's notes stay the `notes` string in assistant.json (unmigrated,
// see ./assistant/profile.js for the same rule); every other assistant owns notes.md, read and written by that
// assistant's turn only.
import { appendNoteLine, fitNotesText, notesRelFor, readNotesFile, seedNotesFile, writeNotesFile } from "./assistant/notes-file.js";
import { CHARTER_MAX_CHARS, appendEntry, seedCharter } from "./charter.js";
// The role library (a named charter with one line of remit) and the assistant records (a thread plus the role it
// runs). Both are read at boot, and both treat the FILE as the authority: a second surface can edit a role's
// charter while this process is up, exactly as it can edit Assistant #1's.
import {
  ASSISTANT_AGENT_MANAGER_ID,
  ASSISTANT_DIRECTOR_ID,
  ASSISTANT_DIRECTOR_WAKE_MINUTES,
  RETIRED_ROLE_IDS,
  createRole,
  deleteRole as deleteRoleFrom,
  findRole,
  readRolesFile,
  roleMeta,
  rolesMeta as rolesMetaOf,
  writeRole,
} from "./roles.js";
import {
  ASSISTANT_MAX,
  PRIMARY_ASSISTANT,
  assistantsRunning,
  repointRetiredRoles,
  PRIMARY_THREAD,
  RULE_MAX,
  assistantNumber,
  charterRelFor,
  findAssistant,
  isAssistantId,
  nextAssistantRecord,
  pickAssistantName,
  readAssistantsFile,
  restartedThreadFor,
  threadFor,
  threadGenOf,
  writeAssistantsFile,
} from "./assistants.js";
import { commitsLine, completionEvidence, durationText, renderCompletionNotice, terminalKey, wordForStatus } from "./completion.js";
import { MESSAGE_CAP, MESSAGE_KINDS, MESSAGE_TEXT_CAP, MESSAGE_WINDOW_DAYS, buildMessages } from "./assistant/messages.js";
// One assistant's task queue: its own file beside its charter and settings, the transitions, the derived flags
// (stale / conflict) and the compact digest a wake's preamble carries. The file path is resolved HERE because it
// hangs off the charter's directory; everything else lives in ./assistant/queue.js.
import {
  addTask,
  currentThread,
  deleteTask,
  decorateTasks,
  editTask,
  holdIsTestable,
  linkTaskRun,
  normHold,
  queueCounts,
  queueDigest,
  queuePathOf,
  readQueueFile,
  adoptTask,
  reassignTask,
  reorderTasks,
  runIdOfJob,
  runOfTask,
  setTaskState,
  settleTasks,
  taskThreads,
  TASK_DETAIL_MAX,
  TASK_HOLD_KINDS,
  TASK_TITLE_MAX,
  writeQueueFile,
} from "./assistant/queue.js";
// The standing rules: the reader's written answers, their cap and the assistant's refinement of its own. The
// LIST's decisions live in ./assistant/rules.js; the two stores those lists sit in (assistant.json and an extra
// assistant's record) stay here, so each method below is the delegation and the module makes the journal, the
// charter entry and the persist on this instance. The list's own API is re-exported at the top of this file, as
// ./assistant/queue.js's constants are from their module, so no import site moves.
import {
  addRuleForRecord,
  addRuleToAssistant,
  briefingRules,
  removeRuleForRecord,
  removeRuleFromAssistant,
  rulesOfAssistant,
  seedEveryAssistantRules,
  seedRulesForRecord,
} from "./assistant/rules.js";
// The prompt's budget: the caps the briefing's sections are reserved against, and the three-turn model the
// Settings -> Prompt tab draws. The constants live beside the rules' own clip so the builder and the picture
// cannot disagree; `promptBudget` below only MEASURES the built text and hands it here.
import {
  PROJECTS_BRIEFING_MAX,
  RULE_BRIEFING_CHARS,
  WATCHES_BRIEFING_MAX,
  WATCH_TEXT_CHARS,
  promptBudgetModel,
} from "./assistant/prompt-budget.js";
// Consolidation: what a rule list becomes when the assistant tidies it under the reader's grant. The LIST's
// decisions - which rules may merge, which may be dropped, which may leave the every-turn tier, what the role
// prompt may say - live in ./assistant/consolidate.js; this class owns the grant on the record, the snapshot
// directory, and the one write each store gets when the pass applies.
import {
  CONSOLIDATION_DIR,
  consolidatePlan,
  grantConsolidation,
  grantOf,
  revokeConsolidation,
  snapshotConsolidation,
} from "./assistant/consolidate.js";
// The wake queue: what a set of wakes becomes and the one turn a batch turns into. The four fields the queue
// lives in (`pendingWake`, `wakeTimer`, `wakes`, `forceSweepFor`) stay on this class, because `state()`, the reset
// route and every harness read them off the instance; the DECISIONS - the budget class, the coalescing window, one
// batch per assistant, the sweep checklist and the words - live in ./assistant/wakes.js. `wake` and `flushWake`
// below are the two delegations, and the module's API is re-exported at the top of this file so no import site
// moves.
import { QUEUE_CADENCE_MINUTES, QUEUE_SWEEP_RULE, flushWakes, wakeAssistant } from "./assistant/wakes.js";
// Putting a task on a pipeline is the queue's write, so it goes through the same door: the transition lives in
// lib/task-pipeline-assign.js (which reads the bundle the window reads), and `queueMutate` below owns the file, the
// journal and the repaint, exactly as it does for `state` and `reassign`.
import { addTaskOnPipeline, assignTaskPipeline, clearTaskPipeline } from "./task-pipeline-assign.js";
// Driving a task through its pipeline is the queue's OTHER clock: `sweepQueues` asks the driver what a settled stage
// means, and this module answers with new rows and the stage starts it wants — never a file write of its own.
import { capWakeLine, driveTaskPipelines, DRIVE_FAULTS, releaseCapPark, renderDecision, restampRoutePark, routingFingerprint } from "./task-pipeline-drive.js";
// The ledger write at the link: the driver's entry learns its thread and job here, in the same record as the row.
import { recordStageDecision, roundOwesAssembly, settleStageRun } from "./task-pipeline.js";
// The bundle is read per assignment (a reader's re-export is the one they expect), through the loader the window uses.
import { readBundle } from "./pipeline-bundle.js";
// A fan-out's aggregate is git work with a pre-flight, so it lives in its own module and the sweep performs it: the
// driver only ever says "this merge is owed" (lib/pipeline-fanout.js rule 4, lib/pipeline-aggregate.js).
import { aggregateBranches } from "./pipeline-aggregate.js";
import { aggregateMessage, aggregateRecord } from "./pipeline-fanout.js";
// A round's assembly is git work too: one branch cut from the round's frozen parent, every stage run's commit
// cherry-picked onto it in visit order (lib/pipeline-assembly.js). The driver says the assembly is owed; this
// performs it and writes the branch on the row, so the landing step has ONE branch.
import { assembleStages, assemblyMessage, assemblyRecord } from "./pipeline-assembly.js";
// ONE name for every tree a round cuts. The parent tree, each stage child and the branch a stage is cut from are the
// same three strings in every process from the ROUND's own slug and tag (lib/stage-tree-name.js), which is what makes
// a re-run at the same visit land on its own name instead of a `-2` beside it.
import { roundNameOf, stageTreeName } from "./stage-tree-name.js";
// The same names read back from the queue record: which tree each one belongs to, for the chart's rows. The
// server stamps them onto rows in snapshot() so a browser that has never typed a name still paints the round's.
import { roundTreeNames } from "./round-tree-names.js";
import { taskTitle } from "./tree-slug.js";
// The waits that belong to a person, and the words an option is offered in, are the JOB STORE's facts: the
// Element room (bottom of this file) reads the same enumeration the card's buttons are drawn from, so "A"
// cannot mean two different things on two surfaces.
import { APPROVAL_CHOICE_LABEL, WAIT_LETTERS, isDestructiveAsk } from "./jobs.js";
// The room id and the bridge's script path, resolved by the module that owns the matrix block's shape.
import { matrixConfig } from "./matrix-bridge.js";

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
// The standing rules: the text cap and the refinement threshold, and the list's own decisions — the duplicate
// check, the assistant's restatement of its own rule, the trade at the cap, the seeding of an extra assistant's
// copy and the resolution of which list belongs to whom. A harness that drives a list directly reads them here.
export {
  RULE_BRIEFING_MAX,
  RULE_REFINE_RATIO,
  RULE_TEXT_MAX,
  addRuleToList,
  briefingRules,
  exactRule,
  refinedRule,
  removeRuleFromList,
  rulesOf,
  seedRulesFrom,
} from "./assistant/rules.js";
// The wake queue: the coalescing window, the budget class and the batch shape, the sweep's checklist, and the
// words a batch is said in. test/queue-sweep.test.js reads the checklist here, at the path the shell has always
// been imported by, and a harness that drives a wake directly reads the rest beside it.
export {
  QUEUE_CADENCE_MINUTES,
  QUEUE_SWEEP_CHECKS,
  QUEUE_SWEEP_RULE,
  WAKE_COALESCE_MS,
  groupWakesByAssistant,
  isSweepBatch,
  isSweepWake,
  wakeHint,
  wakeRules,
  wakeText,
} from "./assistant/wakes.js";

// A fixed thread id, not a generated one: the panel has to find this conversation again after a
// restart (and after a jobs-file reset), and a name derived from the first prompt would not survive
// either. It is still just a Hermes session id like any other.
//
// Assistant #1's thread, and the id every earlier build hard-coded. An assistant created from a role gets the
// next number of its own (`panel-assistant-2`); `threadOf()` is what the code now asks instead of reading this
// constant, and the constant survives for the routes and harnesses that mean THE FIRST assistant specifically.
export const ASSISTANT_THREAD = PRIMARY_THREAD;

// How often the long tier is re-sent to a session whose charter has NOT changed: once every this many turns, as the
// safety net for a model that lost the text anyway (a compaction, a gateway-side rewrite). Every other turn carries a
// one-line marker with the file's sha instead of repeating the whole charter, which is ~20 KB of input per turn for a
// file that changes once in a while. Exported so a test names the interval instead of hard-coding 20 in two places.
export const CHARTER_RESEND_EVERY = 20;

// How long the default settle notice waits for its run's tree to be measured, and how often it looks again. A
// notice that says "commits not measured" cannot answer the one question this notice exists for — whether the
// branch is ready to land — so it waits for the measurement instead, exactly as a watch does (`checkWatches`),
// with the same 30 s ceiling for a git call that will not answer.
const SETTLE_MEASURE_MS = 30_000;
const SETTLE_RETRY_MS = 1_000;

// A plain-object test, local to this module: the fan-out writes read `pipelineRun.trees` and `pipelineRun.fanout`,
// which a hand-edited queue file can carry as anything, so every reader has to answer "is this an object" the same way.
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
// Never keep a settle queued longer than this: the ceiling above is per measurement, and a job the store drops
// from under it (its card aged out) is not worth a notice built from a stale summary.
const SETTLE_QUEUE_MS = 120_000;

// The four checks every queue-sweep wake carries, and the rule it is filed under, are the wake queue's: they live
// in ./assistant/wakes.js with the batch that appends them, and are re-exported below so no import site moves.

// The standing "drive your own queue" directive, carried by EVERY assistant's preamble — #1, #2 and every one the
// reader creates later. It lives in the preamble rather than in a role's charter because a charter is a file each
// assistant owns and may rewrite, so a rule written into one copy is a rule the next assistant never hears; and it is
// not part of the queue DIGEST, which is gated by `queueSweepEveryNWakes` — this is a standing instruction, so a wake
// that skips the digest still hears it.
function queueDirectiveLines(file) {
  return [
    "Your task queue is YOURS — this is a standing instruction for every assistant, not only Assistant #1.",
    ...(file ? [`Yours lives at ${String(file).replace(/\\/g, "/")} beside your charter.`] : []),
    "- Read it on every wake, before anything else. A queued task you have not looked at is the one thing this board will not tell you about.",
    "- Start what can be parallelised: several queued tasks whose files do not overlap are several workers, and they run side by side.",
    "- When a SPAWN answers a task, name it on the line: `SPAWN #<id> <project> | …` (or `SPAWN IN #<id> <tree> | …`). The panel writes that row — running, with the worker's thread and tree — at the moment it cuts the job, so the row cannot read as queued under a live worker. A row that already has a live worker is refused by name, and so is a `SPAWN IN` into a tree a live run already holds: check the digest's LIVE RUNS before you write one, and name a free tree or wait.",
    "- Never leave a queued task you could be doing. If it is blocked, park it with the reason; if it can be started, start it.",
    "- Mark a task done only when its PR reads MERGED. A done row that never landed is a lie the next wake inherits.",
    "- Never file work into another assistant's queue. A task belongs to the assistant whose page created it, and the only way work changes hands is an explicit reassign — made by the reader, or by the assistant that owns it.",
  ];
}

// ---------------------------------------------------------------------------------------------
export class Assistant {
  constructor({ config = {}, jobs, getProjects = () => [], getRows = () => [], getChildren = () => ({}), spawner = null, locks = null, onEvent = () => {}, onLog = () => {}, onRestart = null, now = null } = {}) {
    this.config = config;
    this.jobs = jobs;
    // The clock the two spawn watchdogs read, and nothing else. Injected so the 2-minute escalations can be
    // driven without a wall-clock sleep; absent, it is the real clock. Every other rule keeps `Date.now()`,
    // because a test that shifted the whole sentry would have to fabricate every other rule's timing too.
    this.clock = typeof now === "function" ? now : () => Date.now();
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
    // The reader's per-tree OWNER store (lib/locks.js `owners`), injected rather than imported: this module decides
    // WHICH assistant a run belongs to, the server owns where that answer is kept. Absence answers null, which is
    // Assistant #1 -- the same absence the row's owner cell draws.
    this.locks = locks || null;
    this.onEvent = onEvent;
    this.onLog = onLog;
    // Both files are state, and lib/paths.js owns where state lives: the scratchpad and the continuity file sit
    // beside the job store, which is inside the panel's data directory and never inside a checkout. Computing that
    // here from `config.jobsFile` again is how two answers to one question drift apart.
    const own = statePaths(config);
    this.file = own.assistantFile;
    // The one directory this panel stores a reader's uploads in (POST /api/attachments). A SPAWN inherits a path
    // only from inside it — see `spawnInheritance` — so this is the boundary, and it is resolved the same way the
    // upload route resolves it rather than from a second reading of config.json.
    this.attachmentsDir = own.attachmentsDir;
    // The continuity file, beside its scratchpad for the same reason. Seeded on first boot from the rules and
    // notes that store already holds (see `loadCharter`).
    this.charterFile = own.charterFile;
    // The role library and the assistant records. The charter above is Assistant #1's own copy; a role holds the
    // same kind of text under a name and a remit, and an extra assistant gets a copy of the role it was made from.
    this.rolesFile = own.rolesFile;
    this.assistantsFile = own.assistantsFile;
    this.roles = [];
    this.assistants = [];
    this.rolesSeeded = false;
    this.assistantsSeeded = false;
    // The retired role ids this boot's library still carries (lib/roles.js `readRolesFile` answers them). `retireRoles`
    // re-points the roster off each and then deletes it; empty on a store that has already been upgraded.
    this.retiredRoleIds = [];
    // One settings file per assistant, beside that assistant's charter (./assistant/profile.js). Read through
    // `profileOf`, which caches the read: the page asks for every assistant's knobs on a board repaint, and a
    // preamble is built once per turn, so a second read of a file nothing changed buys nothing. `profileErrors`
    // is what the boot log carries when a file could not be read, rather than an assistant that silently looks
    // untouched.
    this.profiles = new Map();
    this.profileErrors = new Map();
    // The chart's round names, per queue file: extracted once per file version rather than on every board poll
    // (lib/round-tree-names.js, read by `roundNames`). Keyed by the file the names came from.
    this.roundNameCache = new Map();
    // The per-assistant frames a previous build's files still carry (lib/assistant/profile.js `readLegacyDock`).
    // Filled by `loadProfiles`, emptied by `retireDockField`, and served only so the page can migrate the value
    // into the panel's own `dockMode` — the pane's geometry never reads it.
    this.dockLegacy = {};
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
    // Wakes a reset dropped are re-derivable from the board, and the first sentry pass after a reset must be allowed
    // to say so even when the hourly sweep budget is spent: the reset adds this assistant's id here and `wake()`
    // spends the flag on that assistant's next sweep. One-shot, runtime only — a restart does not need it.
    this.forceSweepFor = new Set();
    // Turns whose written actions have already been carried out. A finished turn is re-emitted whenever its
    // Hermes title lands (`sweepTitles`) or the panel reloads the job store, and re-reading its SPAWN/TO/NOTE
    // lines then would start a second worker or re-open a card the reader already answered.
    this.harvested = new Set();
    // The carried-line ledger: one record per QUEUE or MESSAGE line whose carrying has already been decided, keyed
    // by the turn that wrote it and the line's place in that turn (`<job id>|queue|<index>`). `harvested` above is
    // the fast path and a WINDOW — 50 ids, evicted in harvest order — so a re-read of an aged-out turn runs every
    // one of its lines again: that is how five texts became eighteen rows and two real turns on 2026-11-07. This
    // list is the durable half. A QUEUE line also writes its key into the row it filed, so the row can answer even
    // when this list has been pruned or restored from an older copy; MESSAGE has no row, so this is its only record
    // (see `carryKeyFor` / `carriedLine` / `noteCarriedLine`).
    this.carriedLines = [];
    // The per-turn command ledger: what each of the assistant's turns wrote, and what the panel did with each
    // line. Persisted, because the turn it most needs to reconcile is the one a restart cut in half.
    this.commandAudits = [];
    // The spawn watchdog: one timer per open spawn card, and the deadline each one is counting to. A card in
    // `ask` mode changes nothing on the board — no job, no thread, no row — so nothing else in the panel can
    // notice that it is still sitting there; this is the part that looks.
    this.spawnTimers = new Map();
    this.spawnWatchMs = SPAWN_WATCH_MS;
    // Every SPAWN line a turn has written, and what became of it (`card`, `job`, `skipped`, `failed`, `lost`, or
    // null while the outcome is still owed). The panel's newer watchdog escalates from the card's own deadline
    // (spawnTimers below); the intent list is the durable record beside it.
    this.spawnIntents = [];
    // Which finished turns the board scan has already read, and the signature it read them at, so a five-second
    // pass does not re-parse every turn of the assistant's own history. Memory only: a parsing cache, not state.
    this.spawnScanned = new Map();
    // The moment this process started. The board scan never re-litigates a turn that ended before it, or a
    // panel that has been up for a week would alert about history on every restart.
    this.bootedAt = this.nowMs();
    // thread -> the terminal result already handed to the assistant. One finish is one wake, however many
    // rules notice it (see `terminalClaim`).
    this.terminalWakes = new Map();
    // The settles already taken up, by terminal key. A settled card is re-emitted several times — once as the run
    // ends, again when its tree measurement lands, again when a title arrives or the store reloads — and only the
    // first is news. In memory only: a card that settled before this process started is history, not a notice
    // (`noteSettle` refuses it), so there is nothing here worth surviving a restart.
    this.settleSeen = new Map();
    // The settles the QUEUE sweep has already answered, by `${assistant}|${job id}`. A settled card is re-emitted
    // several times (the tree measurement, a title landing, a reload), and the sweep is one wake per settle — the
    // job id is the identity the row asked to de-duplicate on. Memory only, for the same reason `settleSeen` is: a
    // finish that predates this process is history, not a sweep.
    this.queueSweepSeen = new Set();
    // The queue's clock, per assistant: the last moment a live run of that assistant's was seen, or the queue was
    // taken for a look. The idle failsafe reads it, and so does the queue's own cadence in `checkCadence` (an
    // assistant with no standing interval and a non-empty queue), which is why it is one map and not two: a queue
    // that was just swept must not be swept again by the other clock. A missing entry reads as the boot, so a
    // panel that comes up to a quiet board counts its N minutes from here rather than from the epoch. Memory only:
    // a restart is a new look at the board.
    this.queueIdleAt = new Map();
    // The standing wake's clock, per assistant: when that assistant's last cadence turn went out (or when it was
    // last seen live, which is the clock). Separate from `queueIdleAt` because the two answer different questions:
    // the failsafe asks "is there work left with nothing running", the cadence asks "has this job had its look".
    // Memory only, like the one above — a restart is a fresh twenty minutes.
    this.cadenceAt = new Map();
    // The failed runs the EXITED rule has already taken up, by terminal key. A card at EXITED is re-emitted as its
    // tree is measured, as a title lands and on every reload, and only the transition is news; this is the same
    // memory-only record `settleSeen` is for, kept apart because the two rules are separately tunable.
    this.exitSeen = new Set();
    // Settles whose notice is waiting for their tree to be measured, keyed by job id. `flushSettles` sends
    // everything that is ready as ONE wake, so four runs ending together is one thought rather than four.
    this.pendingSettles = new Map();
    this.settleTimer = null;
    // How many wakes each assistant has had since this process started. The queue digest is gated on this
    // (`queueSweepEveryNWakes`): 2 (the default) shows it on one wake in two, 1 on every wake, N on one wake in N.
    // A reader's own message is not a wake, so it always carries the queue — the person asking a question should not
    // have to wait for the sweep.
    this.queueWakeTicks = new Map();
    // The long tier's send record: per ASSISTANT, the sha of the charter bytes last sent in full and how many turns
    // this session has built (`charterBriefing`). Session-scoped on purpose — a restart is a new session, and its first
    // turn gets the whole charter again, which is what a model that just lost its context needs.
    this.charterSends = new Map();
    // The board tail's comparison cursor: per ASSISTANT, the last message appended to its digest transcript. Filled
    // at boot from the files (`loadDigestTails`), moved by every appended message, and DELETED by a role restart or a
    // hard restart — a new thread has no transcript above it, so its first message must carry every row's text.
    this.boardSigs = new Map();
    // The retry clock, as a field for the same reason `spawnWatchMs` is one: a test cannot wait a second.
    this.settleRetryMs = SETTLE_RETRY_MS;
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
    // Roles and assistants before the charter: the preamble reads the role a turn belongs to, and the Role tab is
    // the only place a reader can see either. A boot that skipped them is a panel whose assistant has no job title.
    this.loadRoles();
    this.loadAssistants();
    // The retirement of a role id an old store still carries. It runs after BOTH reads because the delete refuses
    // while an assistant names the role, and the re-point is what makes that refusal pass.
    this.retireRoles();
    // The per-assistant tiers that used to be one shared field each: the standing rules copied into every other
    // assistant's record, and the pad seeded once from the text the panel kept before the split. Both passes are
    // create-only — #1's store is not written, an existing record is not re-copied, an existing notes.md is not
    // touched — so a restart changes nothing.
    this.loadAssistantRules();
    this.loadNotes();
    this.loadProfiles();
    // The queue is a NEW store for every assistant, #1 included, so it is seeded here rather than migrated: one
    // empty document per assistant, at the path the tab and the preamble both resolve from this class.
    this.loadQueues();
    // The digest transcript is read AFTER the roster: it is one file per assistant, and the cursor it fills is keyed
    // by the record's id. A boot that skipped this would hand every assistant's first turn after a panel restart a
    // message with no `previous` - every row carrying its text again - when the thread above it already has it.
    this.loadDigestTails();
    this.loadCharter();
    if (this.migrated) this.persist();
    // A card armed before this process started keeps its deadline: a restart clears every setTimeout, so each
    // open spawn card is re-armed from the record ON the card. Overdue ones fire on the next turn of the event
    // loop, which is after the composition root has finished wiring this panel.
    this.rearmSpawnWatches();
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
    this.carriedLines = out.carriedLines || [];
    this.commandAudits = out.commandAudits || [];
    // The debt a restart interrupted: a SPAWN line whose card or job never landed is still owed, and the
    // watchdog judges it against the clock it was recorded on, not against this boot.
    this.spawnIntents = out.spawnIntents || [];
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
      carriedLines: this.carriedLines,
      commandAudits: this.commandAudits,
      spawnIntents: this.spawnIntents,
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
    const { text, ...meta } = charterMetaOf(this.charterFile, { seeded: this.charterSeeded });
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
  //
  // WHOSE file it lands in is `assistantId`, and it used to be missing: this wrote `this.charterFile` (Assistant
  // #1's) for every turn, so a CHARTER: line from #5 was appended to #1's charter — the file the panel shows as
  // #1's — while #5's own charter never moved. The target now resolves from the assistant that is SPEAKING (the
  // harvest's `who`). Assistant #1 keeps this class's path and cached text, byte for byte; every other
  // assistant's entry goes to the file `charterPathOf` resolves for IT. An id the roster does not hold is
  // refused rather than written to #1's file, because a typo must not become another assistant's entry.
  appendCharter(text, { by = "assistant", kind = "", assistantId = PRIMARY_ASSISTANT } = {}) {
    const rec = this.assistants.find((a) => a.id === String(assistantId || ""));
    if (!rec) {
      this.journalAdd("charter-failed", null, `no such assistant: ${assistantId}`);
      return { written: false, chars: 0 };
    }
    if (rec.id !== PRIMARY_ASSISTANT) return this.appendCharterFor(rec, text, { by, kind });
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

  // One extra assistant's entry, into that assistant's OWN file. The text is read from ITS file on every append —
  // never the class's `this.charter`, which is #1's — and a file that is missing is CREATED first: from the role
  // the assistant runs (exactly what `createAssistant` and `charterTextFor` seed it with), or, when the role is
  // gone, from the plain seed with its own rules and pad. Falling back to #1's copy is the bug this path exists
  // to close, so a missing file is never a reason to read the primary's. A refusal is journalled against the
  // assistant's thread, which is what the journal's second column means.
  appendCharterFor(rec, text, { by = "assistant", kind = "" } = {}) {
    const file = this.charterPathOf(rec);
    let before = "";
    if (existsSync(file)) {
      const read = readCharterFile(file, {});
      if (read.error) {
        this.journalAdd("charter-failed", rec.threadId, `${rec.name}: could not read ${file}: ${read.error}`);
        return { written: false, chars: 0 };
      }
      before = read.text;
    } else {
      before = String(this.charterTextFor(rec.id) || "");
      if (!existsSync(file)) {
        before = seedCharter({ rules: this.rulesFor(rec.id), notes: this.notesFor(rec.id), panelDir: path.dirname(this.file) });
        try {
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, before);
        } catch (err) {
          this.journalAdd("charter-failed", rec.threadId, `${rec.name}: could not create ${file}: ${reasonOf(err)}`);
          return { written: false, chars: 0 };
        }
        this.onLog(`assistant: created the missing ${file} from ${rec.name}'s own rules and pad before appending its entry (${before.length} chars)`);
      }
    }
    const out = appendCharterEntry(file, before, text, { by, kind });
    if (out.reason === "full") {
      this.journalAdd("charter-full", rec.threadId, `${rec.name}: entry not written (${out.chars}/${CHARTER_MAX_CHARS} chars): ${clip(text, 120)}`);
      return { written: false, chars: out.chars };
    }
    if (out.reason === "write-failed") {
      this.journalAdd("charter-failed", rec.threadId, `${rec.name}: could not write ${file}: ${out.error}`);
      return { written: false, chars: out.chars };
    }
    this.journalAdd("charter", rec.threadId, `${rec.name}: charter entry: ${clip(text, 160)}`);
    this.emit();
    return { written: true, chars: out.text.length };
  }

  // What rides in the preamble. The long tier is sent WHOLE on the first turn of a session, whenever the file's bytes
  // move, and every CHARTER_RESEND_EVERY turns as a safety net; on every other turn ONE line carries the sha and says
  // the tier is unchanged and withheld. Before this, the whole 20 KB file went out on every single turn — a turn cost
  // ~20 KB of input to repeat text the model had already read, and the file changes rarely.
  //
  // The file is the source of truth (the reader edits it in the tab and may edit it on disk), so it is read once per
  // turn and the sha is taken from those same bytes: the marker can only claim "unchanged" about a file that was just
  // read. `charterSends` is keyed per assistant — one assistant's send record must never decide another's turn.
  //
  // It takes the ASSISTANT now, not the class's one charter: an assistant's charter is its own copy, and a
  // briefing built from whichever copy happened to be loaded is exactly how a second assistant is handed the first
  // one's memory. The label names the role, so a turn can tell which job it is doing.
  // The charter's TEXT, without touching the send record: `mode: "full"` is what a due turn carries, `"marker"` is
  // the one-line stand-in, and `"auto"` is neither (it is not used here). `charterBriefing` is the only caller that
  // advances the record; the Prompt tab asks this for both shapes so its two diagrams describe ONE file.
  charterLines(id = PRIMARY_ASSISTANT, { mode = "full", raw = null, sha = null } = {}) {
    const rec = this.assistantRecord(id);
    const role = this.roleOf(rec);
    const file = this.charterPathOf(rec).replace(/\\/g, "/");
    const label = `role ${role ? role.name : "(none)"}`;
    const body = raw === null ? String(this.charterTextFor(rec?.id) || "") : String(raw);
    const text = body.trim();
    const digest = sha || createHash("sha256").update(body).digest("hex").slice(0, 12);
    if (!text) return [`Charter (the long tier — nothing written down yet; ${label}; sha256:${digest}):`];
    if (mode === "marker") {
      // ONE line, and the SAME line on every withheld turn — no turn number in it — so two turns of one unchanged file
      // read identically and a test can compare them. `sha` claims what was last SENT, not what was last seen.
      return [
        `Charter — the long tier is unchanged and withheld this turn (sha256:${digest}, ${text.length} chars; ${label}; ${file}). It is sent in full on the first turn of a session, whenever these bytes change, and every ${CHARTER_RESEND_EVERY} turns; the short tier above — standing rules, notes, and the queue digest on its own sweep — is never withheld by it.`,
      ];
    }
    if (text.length <= CHARTER_MAX_CHARS) return [`Charter — the long tier, read in full this turn (${label}; ${file}; sha256:${digest}):`, text];
    return [
      `Charter — sent in full this turn, clipped here at ${CHARTER_MAX_CHARS} of ${text.length} chars (${label}; ${file}; sha256:${digest}):`,
      `${text.slice(0, CHARTER_MAX_CHARS - 200)}…`,
      "[clipped: the file is over the cap — prune the oldest changelog entries]",
    ];
  }

  charterBriefing(id = PRIMARY_ASSISTANT) {
    const rec = this.assistantRecord(id);
    const raw = String(this.charterTextFor(rec?.id) || "");
    const text = raw.trim();
    // The RAW bytes are what the marker tracks, not the trimmed text: a file that only gained a trailing newline is
    // still a changed file, and this is the one value a reader can reproduce with `sha256sum` on the same path.
    const sha = createHash("sha256").update(raw).digest("hex").slice(0, 12);
    const key = String(rec?.id || id || PRIMARY_ASSISTANT);
    const sent = this.charterSends.get(key) || { sha: null, turn: 0 };
    const turn = sent.turn + 1;
    sent.turn = turn;
    this.charterSends.set(key, sent);
    if (!text) {
      sent.sha = sha;
      return this.charterLines(id, { mode: "full", raw, sha });
    }
    const due = turn === 1 || sent.sha !== sha || turn % CHARTER_RESEND_EVERY === 0;
    if (due) sent.sha = sha;
    // `sent.turn` is left as the turn count; `sha` is not touched on a marker, because the marker claims what was
    // last SENT, not what was last seen.
    return this.charterLines(id, { mode: due ? "full" : "marker", raw, sha });
  }

  // ---- roles and assistants: a charter with a name, and the thread that runs it ------------------

  // Read the role library. A missing file is seeded once with every built-in role (lib/roles.js owns the seeds, and
  // `data/roles/*.md` are the charters); a library written before a built-in existed gets it APPENDED by id; and a
  // library written under a RETIRED id has that record renamed in place on the way in. All three are idempotent, so
  // a second boot adds and renames nothing and a reader's edit under an existing id is never regenerated. A library
  // that cannot be read is reported and left empty rather than failing the boot.
  loadRoles() {
    const out = readRolesFile(this.rolesFile, { at: new Date() });
    if (out.error) this.onLog(`assistant: could not read ${this.rolesFile} (${out.error}) — no roles this turn`);
    this.roles = out.roles;
    const added = Array.isArray(out.added) ? out.added : [];
    const renamed = Array.isArray(out.renamed) ? out.renamed : [];
    // Every retired id this boot has to deal with: the ones RENAMED in place (the assistants naming them still have to
    // be re-pointed) and the ones still in the list, which is a store carrying TWO records for one job. Both are
    // handled by `retireRoles` after the roster has been read — never before, because a role delete refuses while an
    // assistant names the role, and the re-point is what turns that refusal into a delete.
    this.retiredRoleIds = [...new Set([...renamed.map((mv) => mv.from), ...(Array.isArray(out.retired) ? out.retired : [])])];
    if (out.seeded) {
      this.rolesSeeded = true;
      this.onLog(`assistant: seeded ${this.rolesFile} with ${this.roles.length} roles (${this.roles.map((r) => `"${r.name}" ${r.charter.length} chars`).join(", ")})`);
      this.journalAdd("role", null, `seeded the role library with ${this.roles.map((r) => `"${r.name}"`).join(" and ")} from data/roles/`);
    } else if (added.length) {
      this.onLog(`assistant: ${this.rolesFile} predates ${added.map((r) => `"${r.name}"`).join(", ")} — registered the built-in role${added.length === 1 ? "" : "s"} without touching the others`);
      this.journalAdd("role", null, `registered the built-in role${added.length === 1 ? "" : "s"} ${added.map((r) => `"${r.name}" (${r.id})`).join(", ")} in ${this.rolesFile.replace(/\\/g, "/")}`);
    }
    for (const mv of renamed) {
      const role = findRole(this.roles, mv.to);
      this.onLog(`assistant: role "${role?.name || mv.to}" moved from the retired id ${mv.from} to ${mv.to} (its charter is untouched, ${role?.charter.length ?? 0} chars)`);
      this.journalAdd("role", null, `the ${role?.name || mv.to} role was renamed in place from ${mv.from} to ${mv.to} — the same name, remit, prompt and charter bytes`);
    }
    return this.roles;
  }

  // Read the assistant records. The first one is seeded here and only ever named by this file: its settings,
  // rules, scratchpad and charter stay in assistant.json and assistant-charter.md, where they already were.
  loadAssistants() {
    const out = readAssistantsFile(this.assistantsFile, { at: new Date() });
    if (out.error) this.onLog(`assistant: could not read ${this.assistantsFile} (${out.error}) — only Assistant #1 this turn`);
    this.assistants = out.assistants;
    if (out.seeded) {
      this.assistantsSeeded = true;
      this.onLog(`assistant: seeded ${this.assistantsFile} with Assistant #1 (thread ${PRIMARY_THREAD})`);
    }
    return this.assistants;
  }

  /**
   * The retirement pass, run once at boot AFTER both stores are read: re-point every assistant off a retired role id,
   * then delete the retired record — and the delete's own refusal is the guard that keeps the order honest.
   *
   * A record still naming the role is refused by `deleteRole` (`role-in-use`), so a roster write that failed, or a
   * hand-edited file that grew a fourth assistant overnight, leaves the role in the library with a log line rather
   * than an assistant whose `roleOf` resolves nothing. The run is idempotent: a store already upgraded has no
   * retired id, so nothing is re-pointed, nothing is deleted and nothing is written.
   * @returns {{repointed: object[], deleted: object[], refused: object[]}} what moved, what went, and what the
   *   delete refused (with the assistants that still named it).
   */
  retireRoles() {
    const retired = Array.isArray(this.retiredRoleIds) ? this.retiredRoleIds : [];
    if (!retired.length) return { repointed: [], deleted: [], refused: [] };
    const map = {};
    for (const id of retired) if (RETIRED_ROLE_IDS[id]) map[id] = RETIRED_ROLE_IDS[id];
    let repointed = [];
    try {
      repointed = repointRetiredRoles(this.assistantsFile, this.assistants, map);
    } catch (e) {
      // The roster could not be written. The delete below then refuses by name (the records still hold the retired
      // id), which is the safe end state: a role kept in the library, an assistant still resolving it, one log line.
      this.onLog(`assistant: could not re-point the roster off the retired role id${retired.length === 1 ? "" : "s"} ${retired.join(", ")} — ${String((e && e.message) || e)}`);
    }
    for (const mv of repointed) {
      const rec = findAssistant(this.assistants, mv.id);
      this.onLog(`assistant: ${rec?.name || mv.id} now runs ${mv.to} (re-pointed from the retired role id ${mv.from})`);
      this.journalAdd("role", rec?.threadId || null, `${rec?.name || mv.id} was re-pointed from the retired role id ${mv.from} to ${mv.to}; its own copy of the charter is untouched`);
    }
    const deleted = [];
    const refused = [];
    for (const id of retired) {
      // The roster is read AFTER the re-point on purpose: the guard has to judge the file as it now stands.
      const holders = assistantsRunning(this.assistants, id);
      try {
        const out = deleteRoleFrom(this.rolesFile, this.roles, id, { heldBy: holders });
        deleted.push(out.deleted);
        this.onLog(`assistant: deleted the retired role "${out.deleted.name}" (${out.deleted.id}) from ${this.rolesFile} — no assistant names it`);
        this.journalAdd("role", null, `deleted the retired ${out.deleted.name} role (${out.deleted.id}) — ${this.roles.length} role${this.roles.length === 1 ? "" : "s"} left in the library`);
      } catch (e) {
        if (e && e.code === "role-unknown") continue; // nothing left to delete: the rename already took it
        refused.push({ id, code: (e && e.code) || "error", heldBy: (e && e.heldBy) || holders, error: String((e && e.message) || e) });
        this.onLog(`assistant: kept the retired role ${id} — ${String((e && e.message) || e)}`);
      }
    }
    if (repointed.length || deleted.length) this.emit();
    return { repointed, deleted, refused };
  }

  // ---- the shared tiers, copied once into each other assistant -----------------------------------
  //
  // Before the split the standing rules and the scratchpad were ONE field each, and every turn read that one
  // value. The records a panel already holds therefore start with no rules and no pad file of their own; these
  // two passes give each of them a COPY of what the panel had, exactly once. Neither touches Assistant #1's
  // store: its rules stay the `rules` array in assistant.json and its pad stays the `notes` string.

  /** Copy Assistant #1's standing rules onto ONE record. Idempotent: a record already stamped is left alone. */
  seedRulesFor(rec) {
    return seedRulesForRecord(this, rec);
  }

  /** Every other assistant's rule set, one boot pass. A record already stamped keeps whatever it has now. */
  loadAssistantRules() {
    return seedEveryAssistantRules(this);
  }

  /**
   * Every other assistant's pad, one boot pass, seeded from the CURRENT shared text. `seedNotesFile` creates a
   * missing file and leaves an existing one byte-identical, so this is idempotent and a pad the reader emptied
   * stays empty. Assistant #1 has no file: its pad is the `notes` string loaded from assistant.json.
   */
  loadNotes() {
    for (const rec of this.assistants) {
      if (rec.id === PRIMARY_ASSISTANT) continue;
      const file = this.notesPathOf(rec);
      if (!file) continue;
      const out = seedNotesFile(file, this.notes);
      if (out.error) this.onLog(`assistant: could not seed ${rec.name}'s pad at ${file} (${out.error})`);
      else if (out.seeded) this.onLog(`assistant: seeded ${rec.name}'s pad from Assistant #1's notes (${out.chars} chars, once)`);
    }
    return this.assistants;
  }

  /** One assistant's standing rules. #1 answers the store's own array; an extra one answers its record's copy. */
  rulesFor(id = PRIMARY_ASSISTANT) {
    return rulesOfAssistant(this, id);
  }

  rolesList() {
    return rolesMetaOf(this.roles);
  }

  // ---- one assistant's own settings: its file, its knobs ----------------------------------------
  //
  // Assistant #1's knobs are `this.settings` and live in assistant.json, exactly as they did before a second
  // assistant existed; nothing here moves them. Every OTHER assistant owns a file beside its charter
  // (`state/assistants/assistant-N/settings.json`), and every read of "what are THIS assistant's settings" goes
  // through `settingsFor`, so a turn, a card and the page cannot disagree about which assistant they describe.
  // #1 may carry that file too, but only for the fields assistant.json has never held — its default role prompt
  // and its escalation list — so its own store stays byte-identical until the reader uses the new fields.
  loadProfiles() {
    // THE RETIRED FRAME, read once, here: `dock` was one assistant's own field until the pane became the panel's
    // single choice, so a file written by the older build may still carry it. Nothing in a turn reads it, the
    // profiles no longer keep it, and this map is what the page's one-time migration reads before the General
    // route writes the panel key. `retireDockField` empties it and takes the key out of every file.
    this.dockLegacy = {};
    for (const rec of this.assistants) {
      this.readProfile(rec);
      const dock = readLegacyDock(this.profilePathOf(rec));
      if (dock) this.dockLegacy[rec.id] = dock;
    }
    return this.profiles;
  }

  /** Where one assistant's settings file lives: beside its charter, resolved from the state directory every read. */
  profilePathOf(record) {
    const rec = record || this.assistantRecord();
    if (!rec) return null;
    return path.join(path.dirname(this.charterFile), profileRelFor(rec.id));
  }

  // ---- one assistant's scratchpad -------------------------------------------------------------
  //
  // The notes are the short tier: the lines a turn is told on EVERY wake, so they are the part of an assistant's
  // memory most worth keeping apart. Assistant #1's is the `notes` string in assistant.json — the field it has
  // always had, unmigrated, exactly as its settings stay there — and every other assistant owns
  // `state/assistants/<id>/notes.md` beside its charter. The file, its cap and its writer live in
  // ./assistant/notes-file.js; this class owns WHICH assistant a read or a write is for, and nothing else.

  /**
   * Where one assistant's pad lives. Assistant #1 has no file of its own — its notes are a field in its store — so
   * it answers null, and every caller reads that as "use `this.notes`".
   */
  notesPathOf(record) {
    const rec = record || this.assistantRecord();
    if (!rec || rec.id === PRIMARY_ASSISTANT) return null;
    return path.join(path.dirname(this.charterFile), notesRelFor(rec.id));
  }

  /**
   * The pad text ONE assistant's turn reads. #1 answers the store's string; an extra assistant reads its own file,
   * which was seeded once from that string when the split landed and is its own from then on.
   */
  notesFor(id = PRIMARY_ASSISTANT) {
    const rec = this.assistantRecord(id);
    if (!rec || rec.id === PRIMARY_ASSISTANT) return this.notes;
    const file = this.notesPathOf(rec);
    const out = readNotesFile(file);
    if (out.error) this.onLog(`assistant: could not read ${file} (${out.error}) — ${rec.name}'s pad is empty this turn`);
    return out.text;
  }

  /**
   * The Pad tab's one read: the text, the file it came from, and whether that file exists. #1 answers the store's
   * own path with `file: false`, because its notes are a field in assistant.json rather than a file beside it —
   * the pane says where the text is kept, and saying "notes.md" about a field that is not in one would be a lie.
   */
  notesPayloadFor(id = PRIMARY_ASSISTANT) {
    // Resolve only a real id: `assistantRecord` falls back to Assistant #1 for a name it does not hold, and a stale
    // tab asking for `assistant-9` must get "no such assistant", never #1's pad under someone else's name.
    const wanted = String(id ?? "").trim();
    const rec = wanted ? this.assistants.find((a) => a.id === wanted) : this.assistantRecord(PRIMARY_ASSISTANT);
    if (!rec) throw Object.assign(new Error(`no such assistant: ${id}`), { code: "assistant-unknown" });
    const slash = (p) => String(p || "").replace(/\\/g, "/");
    if (rec.id === PRIMARY_ASSISTANT) {
      return {
        assistantId: rec.id,
        name: rec.name,
        notes: this.notes,
        path: slash(this.file),
        file: false,
        exists: true,
        chars: this.notes.length,
        cap: NOTES_CAP,
        error: null,
      };
    }
    const file = this.notesPathOf(rec);
    const out = readNotesFile(file);
    return {
      assistantId: rec.id,
      name: rec.name,
      notes: out.text,
      path: slash(file),
      file: true,
      exists: out.exists,
      chars: out.chars,
      cap: NOTES_CAP,
      error: out.error,
    };
  }

  /**
   * One NOTE line, into the pad of the assistant whose turn wrote it. #1 appends to the store's string exactly as it
   * always has (same cap, same tail); an extra assistant reads its own file, appends and writes it back. This is the
   * harvest's half of the split: a NOTE in #3's turn lands in #3's pad alone.
   */
  appendNote(id, note) {
    // A pad has exactly ONE owner, so an id the roster does not hold is refused rather than resolved to #1 the way
    // `assistantRecord`'s fallback would: a typo in a spawn stamp must not write one assistant's NOTE into another
    // assistant's memory, and a pad write that guessed its owner would be worse than a journalled refusal.
    const wanted = String(id ?? "").trim();
    const rec = wanted ? this.assistants.find((a) => a.id === wanted) : this.assistantRecord(PRIMARY_ASSISTANT);
    if (!rec) throw Object.assign(new Error(`no such assistant: ${id} — the note was not written`), { code: "assistant-unknown" });
    if (rec.id === PRIMARY_ASSISTANT) {
      // #1's pad is the store's string, capped at what a turn reads: the OLDEST lines go, never the newest.
      this.notes = fitNotesText(`${this.notes}${this.notes ? "\n" : ""}- ${note}`);
      return this.notes;
    }
    const file = this.notesPathOf(rec);
    const out = appendNoteLine(file, note);
    if (out.error || !out.appended) throw new Error(`could not write ${file}: ${out.error || "the line did not land"}`);
    return out.text;
  }

  readProfile(record) {
    const rec = record || this.assistantRecord();
    if (!rec) return { ...EMPTY_PROFILE };
    const file = this.profilePathOf(rec);
    const out = readProfileFile(file);
    if (out.error) {
      this.profileErrors.set(rec.id, out.error);
      this.onLog(`assistant: could not read ${file} (${out.error}) — ${rec.name} keeps the panel's defaults`);
    } else {
      this.profileErrors.delete(rec.id);
    }
    this.profiles.set(rec.id, out.profile);
    return out.profile;
  }

  /**
   * One assistant's profile, cached. The file is the authority and is re-read on every boot; a hand edit therefore
   * lands on a restart, the way assistant.json's own edits do, rather than being half-read by two panes at once.
   */
  profileOf(id = PRIMARY_ASSISTANT) {
    const rec = this.assistantRecord(id);
    if (!rec) return { ...EMPTY_PROFILE };
    if (!this.profiles.has(rec.id)) this.readProfile(rec);
    return this.profiles.get(rec.id) || { ...EMPTY_PROFILE };
  }

  /** The file path the page shows beside the prompt. */
  profileMetaOf(id = PRIMARY_ASSISTANT) {
    const rec = this.assistantRecord(id);
    if (!rec) return null;
    const file = this.profilePathOf(rec);
    const profile = this.profileOf(rec.id);
    return {
      path: String(file).replace(/\\/g, "/"),
      exists: existsSync(file),
      error: this.profileErrors.get(rec.id) || null,
      promptChars: String(profile.prompt || "").length,
      promptCap: PROMPT_CAP,
      // Who wrote the prompt riding this assistant's turns: the reader's own, or a consolidation's. The tab says
      // so beside the size, because "prompt" alone cannot tell a saved contract from a summary a pass produced.
      promptBy: profile.promptBy || null,
      promptAt: profile.promptAt || null,
      promptFrom: Array.isArray(profile.promptFrom) ? profile.promptFrom.slice() : [],
      // The standing wake this assistant was given, in minutes (0 = none). It is in the ROLE tab's read because
      // it is a property of the job the role describes, even though the sentry is what reads it.
      wakeEveryMinutes: pickWakeEvery(profile.wakeEveryMinutes),
    };
  }

  // ---- one assistant's task queue ------------------------------------------------------------
  //
  // The queue is per assistant and lives BESIDE its settings and its charter: state/assistants/<id>/queue.json. #1 is
  // not special here — there was never a queue to migrate, so its file sits at the same path as everyone else's. The
  // schema, the transitions and the derived flags live in ./assistant/queue.js; this class owns WHERE the file is and
  // the read-modify-write that journals and repaints.

  /** Where one assistant's queue file lives. The state directory is `this.file`'s own — never the charter's dirname. */
  queuePathOf(record) {
    const rec = record || this.assistantRecord();
    if (!rec) return null;
    return queuePathOf(path.dirname(this.file), rec.id);
  }

  /**
   * Every display name a round gives one of its trees, keyed by the normalised path a row carries
   * (lib/round-tree-names.js). A READ: nothing is written and nothing is journalled. It runs on every /api/state
   * poll, so each queue is parsed again only when its file changed: the queues are large and most polls have no
   * news. A queue that is gone is skipped rather than cached, and a file read the next time it appears.
   */
  roundNames() {
    const out = new Map();
    for (const rec of this.assistants) {
      const file = this.queuePathOf(rec);
      if (!file) continue;
      let stamp = "absent";
      try {
        const st = statSync(file);
        stamp = `${st.mtimeMs}:${st.size}`;
      } catch {
        /* no queue file yet: this assistant names no tree */
      }
      if (stamp === "absent") {
        this.roundNameCache.delete(file);
        continue;
      }
      const cached = this.roundNameCache.get(file);
      let names = cached && cached.stamp === stamp ? cached.names : null;
      if (!names) {
        names = [...roundTreeNames(readQueueFile(file).tasks)];
        this.roundNameCache.set(file, { stamp, names });
      }
      for (const [treePath, name] of names) {
        const prev = out.get(treePath);
        // The same rule the module applies inside one queue: a dated task beats an undated one, and the newest
        // id wins when both are dated. Two assistants naming one tree is the collision the driver refuses; this
        // just keeps the paint deterministic.
        if (prev && prev.taskId != null && (name.taskId == null || name.taskId <= prev.taskId)) continue;
        out.set(treePath, name);
      }
    }
    return out;
  }

  /** Everything a queue read needs from the board: the runs by thread and the scanned row for a worktree. */
  queueContext() {
    const jobs = typeof this.jobs?.list === "function" ? this.jobs.list() : [];
    const rows = typeof this.getRows === "function" ? this.getRows() : [];
    const byPath = new Map();
    for (const r of rows) {
      const key = normPath(r?.path);
      if (key && !byPath.has(key)) byPath.set(key, r);
    }
    return {
      jobs,
      rows,
      isLive: (thread) => jobs.some((j) => String(j.thread || "") === String(thread || "") && isLive(j)),
      rowFor: (task) => {
        const key = normPath(task?.worktree);
        return key ? byPath.get(key) || null : null;
      },
    };
  }

  /**
   * One assistant's queue, decorated and counted. A read: nothing is written and nothing is journalled. The tab and
   * the preamble both come through here, so a task reads the same in both places — a second decoration with its own
   * rules is how the tab and the digest start disagreeing about which task is stale.
   */
  queueView(id = PRIMARY_ASSISTANT) {
    const rec = this.assistantRecord(id);
    if (!rec) throw Object.assign(new Error(`no such assistant: ${id}`), { code: "assistant-unknown" });
    const file = this.queuePathOf(rec);
    const out = readQueueFile(file);
    if (out.error) this.onLog(`assistant: could not read ${file} (${out.error}) — ${rec.name}'s queue reads empty this time`);
    const ctx = this.queueContext();
    // `jobs` rides in as well as `isLive`: a row names its RUN now, and the running/stale verdict is that run's status,
    // not the thread's. Without the store a row with a run id could only be guessed at, and the tab would disagree with
    // the digest about which row is live.
    const tasks = decorateTasks(out.tasks, { isLive: ctx.isLive, rowFor: ctx.rowFor, jobs: ctx.jobs });
    const s = this.settingsFor(rec.id);
    return {
      assistantId: rec.id,
      name: rec.name,
      thread: rec.threadId,
      file: String(file).replace(/\\/g, "/"),
      found: out.found,
      error: out.error || null,
      tasks,
      counts: queueCounts(tasks),
      digest: queueDigest(out.tasks, { size: s.queueDigestSize, isLive: ctx.isLive, rowFor: ctx.rowFor, jobs: ctx.jobs }),
    };
  }

  /**
   * The compact queue digest a wake's preamble carries. Empty when the assistant's queue is empty. The digest's own
   * first line is the header ("Your task queue (N queued ...)"), so this adds the blank line and nothing else — a
   * second label above it read as two headings over one list.
   */
  queueBriefing(id = PRIMARY_ASSISTANT) {
    const view = this.queueView(id);
    if (!view.digest.length) return [];
    return ["", ...view.digest];
  }

  /**
   * The Assistant Director's half of the preamble: EVERY assistant's queue, plus the three conditions the job
   * exists to find, already computed. A director that had to open six files (or six tabs) to learn which queue holds
   * the dead run would spend its turn reading instead of routing, and the panel's own preamble is the only carrier
   * a turn has.
   *
   * The rows are the SAME decorated digest the owning assistant reads (`queueDigest` + `decorateTasks`), so a row
   * cannot read `LIVE` here and `STALE` on its own tab. Each assistant's block names its role and what it holds, and
   * a queue with no open rows is SAID rather than omitted: "empty" is a fact the director is asked to check.
   *
   * The signals are deliberately short and de-duplicated by the digest's own facts — one line per condition, naming
   * the queue, the row and the evidence. The director still has to judge; the briefing does not decide for it.
   */
  crossQueueBriefing(selfId = PRIMARY_ASSISTANT) {
    const ctx = this.queueContext();
    const now = this.nowMs();
    const lines = ["", "Every assistant's queue (the whole panel, not only your own):"];
    const signals = [];
    for (const rec of this.roster()) {
      const who = String(rec.id || PRIMARY_ASSISTANT);
      const roleName = this.roleNameOf(rec) || "Assistant";
      const own = who === String(selfId) ? " (your own)" : "";
      const out = readQueueFile(this.queuePathOf(rec));
      if (out.error) {
        lines.push(`- ${rec.name} — ${roleName}${own}: its queue could not be read (${clip(out.error, 160)}) — treat it as unknown, not empty.`);
        continue;
      }
      const digest = queueDigest(out.tasks, {
        // A queue digest is a summary, not the file: eight queued rows per assistant is enough to route by, and the
        // owning assistant reads its own queue in full on its own turn.
        size: 8,
        isLive: ctx.isLive,
        rowFor: ctx.rowFor,
        jobs: ctx.jobs,
        label: `${rec.name} — ${roleName}${own}`,
      });
      if (!digest.length) {
        lines.push(`- ${rec.name} — ${roleName}${own}: queue empty (0 open rows).`);
        continue;
      }
      lines.push(...digest);
      const open = decorateTasks(out.tasks, { isLive: ctx.isLive, rowFor: ctx.rowFor, jobs: ctx.jobs }).filter((t) => t.state !== "done");
      // Which projects and trees this assistant is holding. A row's tree is in the digest; its PROJECT is the word
      // that makes a queue comparable to the board, and this is where the director reads it.
      const holds = [];
      for (const t of open) {
        const place = String(t.project || "").trim() || String(t.worktree || "").trim();
        if (place && !holds.includes(place)) holds.push(place);
      }
      if (holds.length) lines.push(`  holds: ${holds.slice(0, 8).map((h) => clip(h, 100)).join(", ")}${holds.length > 8 ? ` … +${holds.length - 8}` : ""}`);
      for (const t of open) {
        if (t.state === "running" && t.stale) {
          signals.push(`- ${rec.name} #${t.id} — running, but ${t.staleWhy || "its thread has no live run"} (tree ${clip(t.worktree || "none", 80)}): the run died.`);
        }
        if (t.state === "parked") {
          const since = Date.parse(String(t.hold?.since || ""));
          const age = Number.isFinite(since) ? Math.max(0, Math.round((now - since) / 60_000)) : null;
          if (age !== null && age >= 60) {
            signals.push(`- ${rec.name} #${t.id} — parked ${age} min on ${t.hold?.kind || "a manual hold"}${t.hold?.value ? ` ${clip(t.hold.value, 60)}` : ""}${t.reason ? `: ${clip(t.reason, 100)}` : ""}.`);
          }
        }
        if (t.state === "queued" && !t.conflict && !t.waitingOn) {
          signals.push(`- ${rec.name} #${t.id} — queued and startable${t.project ? ` in ${clip(t.project, 40)}` : ""}: ${clip(t.title, 100)}.`);
        }
      }
    }
    lines.push("", "Signals for this pass (judge each one, do not re-read it as a to-do list):");
    lines.push(
      ...(signals.length
        ? signals.slice(0, 24)
        : ["- none: every open row is live, validly held, or cleanly queued."]),
    );
    if (signals.length > 24) lines.push(`- … and ${signals.length - 24} more: the queues above carry them.`);
    return lines;
  }

  /**
   * Whether THIS turn carries the queue digest. A wake is gated by `queueSweepEveryNWakes`; a turn the reader asked for
   * always carries it, because the person waiting for an answer should not be told the queue is not due yet. The gate
   * counts wakes only, so a reader's message neither spends nor resets the count.
   */
  queueDigestForTurn(id = PRIMARY_ASSISTANT, origin = null) {
    if (origin?.kind !== "assistant-wake") return true;
    return this.queueDigestDue(id);
  }

  /**
   * Whether this wake should carry the digest. `queueSweepEveryNWakes` is the knob: 2 (the default) means one wake
   * in two, 1 means every wake, N means one wake in N. Only wakes count — a reader's own message is not a sweep, and
   * the person asking a question should not be told to wait for one.
   */
  queueDigestDue(id = PRIMARY_ASSISTANT) {
    const s = this.settingsFor(id);
    const n = Math.max(1, Math.min(20, Number(s.queueSweepEveryNWakes) || 2));
    const key = String(this.assistantRecord(id)?.id || id);
    const tick = (this.queueWakeTicks.get(key) || 0) + 1;
    this.queueWakeTicks.set(key, tick);
    return n === 1 || tick % n === 0;
  }

  // The board's turn gate used to live here: `boardForTurn` sent a full digest on four kinds of turn and a one-line
  // marker on every other sweep. The digest is an append-only tail now (see `digest` further down, and
  // lib/assistant/digest-tail.js): one small message per turn, a state token per item, and no text for a row that
  // has not moved. There is nothing left for a gate to save, so the gate is gone and every turn appends one message.

  /**
   * Eager completion on the sentry's clock. Every running task whose thread has no live run is settled by the facts
   * the board already holds: a landed tree becomes done by "panel"; a failed run goes back to queued with attempts+1
   * and the reason; a done-but-unmerged run stays running and STALE for the assistant to judge. A task nobody is
   * running is never invented into a completion.
   *
   * A task ON a pipeline is driven here first (lib/task-pipeline-drive.js): its stage's run settles the STAGE, the
   * row is written forward to the next one, and — when the reader has allowed unattended starts — the front row's
   * stage is started as a turn. The settle below still judges every row it always judged, which is what keeps a row
   * with no pipeline on exactly the path it had before the driver existed.
   */
  sweepQueues() {
    const ctx = this.queueContext();
    // One read of the bundle for the whole pass: every queue is driven against the same file the window draws from,
    // and a reader who re-exports it while the panel runs gets the new graph on the next tick. A refused bundle is
    // passed as null, which the driver reports as `unresolved` — never as "the assistant decides".
    const source = readBundle(this.config.pipelineBundleFile);
    const bundle = source.ok ? source.bundle : null;
    const at = new Date(this.nowMs());
    // Every queue is READ before any is driven: a tree is a directory on the disk, and the claim on it is global
    // (lib/task-pipeline-drive.js §3.5), so one row's start has to see the other queue's rows too.
    const queues = [];
    for (const rec of this.assistants) {
      const file = this.queuePathOf(rec);
      const out = readQueueFile(file);
      if (out.found) queues.push({ rec, file, out });
    }
    const claims = queues.flatMap((q) => q.out.tasks);
    // One git read per tree per pass, and only for the rows a stage is about to start or settle on: the driver asks,
    // so a pass over quiet rows costs no subprocess at all (§7.3).
    const factsCache = new Map();
    const treeOf = (treePath) => this.treeFactsOf(treePath, factsCache);
    let wrote = 0;
    for (const { rec, file, out } of queues) {
      const settings = this.settingsFor(rec.id);
      const driven = driveTaskPipelines(out.tasks, {
        bundle,
        jobs: ctx.jobs,
        isLive: ctx.isLive,
        at,
        // The reader's own switch: `auto` is the one that says "start it at once", and `ask`/`off` are the two that
        // say a person decides. The driver advances a settled row either way; it only STARTS one when this is true.
        unattended: String(settings.spawn || "") === "auto",
        claims,
        treeOf,
        // …and the panel's wait book, because a stage whose run was cut is HELD there: the timer reads that settle and
        // the driver is the fallback (lib/task-pipeline-drive.js rule 2a). A store built by a test has no book, which is
        // exactly "no hold" — the driver then behaves as it did before the hold existed.
        waitFor: (treePath) => (typeof this.jobs?.pipelineRecordFor === "function" ? (this.jobs.pipelineRecordFor(treePath) || {}).pipelineWait || null : null),
        // …and the panel's last READ of the pull request at that tree's stage. The timer is the reader; this is the
        // same stamped fact (lib/jobs.js `reviewReadFor`), so a stage whose exit is the reviewer's answer leaves by the
        // edge the read chose - and a DECLINED pull request ends the walk instead of entering the stage after it.
        reviewOf: ({ tree, stage, run }) =>
          typeof this.jobs?.reviewReadFor === "function"
            ? this.jobs.reviewReadFor(tree, stage && stage.id, { pipeline: (run && run.pipeline) || null, enteredAt: (run && run.enteredAt) || null })
            : null,
      });
      const { tasks, changed: settled } = settleTasks(driven.tasks, {
        jobs: ctx.jobs,
        rowFor: ctx.rowFor,
        isLive: ctx.isLive,
        at,
        by: "panel",
      });
      const changed = [...driven.changed, ...settled];
      // A pass that only ASKS for a start still has to write: the request is recorded on the row (`startingAt`) and
      // the stage run's entry beside it, and the next pass reads them there rather than starting the same stage twice.
      // A pass that only SETTLED a stage run — the last stage, or a verdict that ended the loop — writes too: the
      // ledger entry is the record of that run, and a row the settle then judges on its own is read from this file.
      if (changed.length || driven.starts.length || (Array.isArray(driven.settled) && driven.settled.length)) {
        try {
          writeQueueFile(file, tasks, out.nextId);
        } catch (err) {
          this.onLog(`assistant: could not settle ${file} (${reasonOf(err)})`);
          continue;
        }
        for (const c of changed) {
          const what = c.stage ? `${c.from} → ${c.to} at ${c.stage}` : c.to === "done" ? "done" : "back in the queue";
          this.journalAdd("queue", c.thread, `#${c.id} ${clip(c.title, 90)} — ${what} by the panel: ${c.why}`);
        }
        // A CAP PARK WAKES THE READER. It is the one stop with no world-state behind it, so instead of the row waiting,
        // silent, for a person to send `pipeline-release {release: "cap"}`, the reader's own assistant is handed ONE
        // line: the cap, what each stage's visit count was, and the verdict the gate read on the way in. The row still
        // parks — the panel does not quietly extend a bound it just enforced — and the release stays the answer.
        // `pipelinecap` is an EVENT rule (not in SWEEP_WAKE_RULES), so the hour's budget cannot drop it.
        for (const c of changed) {
          if (c.code !== DRIVE_FAULTS.CAP) continue;
          const capped = tasks.find((t) => Number(t.id) === Number(c.id)) || null;
          const cappedRun = isObject(capped && capped.pipelineRun) ? capped.pipelineRun : null;
          const wait = isObject(cappedRun && cappedRun.waitingFor) ? cappedRun.waitingFor : null;
          const line = capWakeLine({
            id: c.id,
            title: c.title,
            pipeline: cappedRun ? cappedRun.pipeline : null,
            stage: c.stage,
            edge: wait ? wait.edge : null,
            limit: wait ? wait.limit : null,
            used: wait ? wait.used : 0,
            visits: wait ? wait.visits : null,
            verdict: wait ? wait.verdict : null,
          });
          const sent = this.wake(line, null, "pipelinecap", { assistantId: rec.id });
          if (sent && sent.queued) this.journalAdd("pipeline-cap", null, `#${c.id} ${clip(c.title, 90)} — the reader was woken: ${line}`);
        }
        wrote += changed.length;
      }
      // The CUT comes before any start, and is its own step (§3.2): the assistant cuts the tree, writes the path on
      // the row and journals it; the next pass finds the tree and asks for the stage's worker. A cut with no start is
      // a row with a tree and no thread — visible, named by `pipelineRun.tree`, and re-startable.
      for (const request of driven.ensureTree) {
        // One cut per row and stage in flight. The sweep is faster than `git worktree add`, so a second pass that sees
        // the same request must not cut a second directory: the in-process claim covers the window, and a restart in
        // the middle of it is the orphan the design names and cannot close (§7.1).
        const key = `${rec.id}:${request.taskId}:${request.stage}`;
        this.cuttingTrees = this.cuttingTrees instanceof Set ? this.cuttingTrees : new Set();
        if (this.cuttingTrees.has(key)) continue;
        this.cuttingTrees.add(key);
        Promise.resolve()
          .then(() => this.cutPipelineTree(rec.id, request))
          .catch((err) => this.onLog(`assistant: could not cut a tree for #${request.taskId} (${reasonOf(err)})`))
          .finally(() => this.cuttingTrees.delete(key));
      }
      // A fan-out's aggregate: the join's tree is already cut and the lanes are pinned, so the one merge is performed
      // here, before any worker for that stage is asked for. Its refusal parks the row with the conflicting paths.
      for (const request of driven.aggregates) {
        const key = `${rec.id}:${request.taskId}:${request.stage}:aggregate`;
        this.cuttingTrees = this.cuttingTrees instanceof Set ? this.cuttingTrees : new Set();
        if (this.cuttingTrees.has(key)) continue;
        this.cuttingTrees.add(key);
        Promise.resolve()
          .then(() => this.aggregatePipelineStage(rec.id, request))
          .catch((err) => this.onLog(`assistant: could not aggregate #${request.taskId} (${reasonOf(err)})`))
          .finally(() => this.cuttingTrees.delete(key));
      }
      // A per-stage round's assembly: the pipeline is over and its stage commits sit on their own branches. One
      // branch is cut from the round's frozen parent and every stage is picked onto it, so the landing step has one
      // branch. Its refusal parks the row with the paths two stages changed on the same lines.
      for (const request of driven.assemblies || []) {
        const key = `${rec.id}:${request.taskId}:${request.stage}:assembly`;
        this.cuttingTrees = this.cuttingTrees instanceof Set ? this.cuttingTrees : new Set();
        if (this.cuttingTrees.has(key)) continue;
        this.cuttingTrees.add(key);
        Promise.resolve()
          .then(() => this.assemblePipelineRound(rec.id, request))
          .catch((err) => this.onLog(`assistant: could not assemble #${request.taskId} (${reasonOf(err)})`))
          .finally(() => this.cuttingTrees.delete(key));
      }
      // The starts come AFTER the write: the row has to read as the stage it is being started in before the cut
      // links a thread to it, or the link would land on the stage it just left.
      for (const start of driven.starts) {
        this.journalAdd("pipeline", null, `#${start.taskId} ${clip(start.title, 90)} — starting ${start.stage} (${start.position} of ${start.count}) of ${start.pipeline} in ${start.target}${start.visit > 1 ? ` — visit ${start.visit}` : ""}`);
        Promise.resolve()
          .then(() =>
            this.startSpawn(
              {
                target: start.target,
                existing: true,
                project: start.project,
                prompt: start.prompt,
                taskId: start.taskId,
                assistantId: rec.id,
                // The landing the stage's artifact earns, carried from the driver to the run body: `local` for a
                // stage with no pull request to open, `pr` for one that lands by PR. It rides the spec, not the
                // prompt, so the spawner stays ignorant of stage semantics and `lib/jobs.js` renders one paragraph.
                remoteWrite: start.remoteWrite || null,
                // The branch the stage runs in, so the paragraph can name the ref to commit on (a run in a tree the
                // panel did not cut in this call has no `j.branch` of its own until the tree is measured).
                branch: (start.tree && start.tree.branch) || null,
              },
              { source: "pipeline", assistantId: rec.id },
            ),
          )
          .catch((err) => {
            const reason = `starting ${start.stage} (${start.position} of ${start.count}) of ${start.pipeline} failed — ${reasonOf(err)}`;
            // A stage that cannot be started is a decision, not a retry: the row parks with the sentence, and the
            // next tick does not ask for the same worker again.
            const parked = this.parkPipelineStart(rec.id, start.taskId, { stage: start.stage, reason });
            if (!parked) this.journalAdd("pipeline-failed", null, `#${start.taskId} ${start.stage} of ${start.pipeline} — ${reasonOf(err)}: nothing was started, and the row still reads queued`);
          });
      }
      for (const note of driven.notes) {
        // A start that is in flight is a state, not a fault: it is on the row and the next tick reads it there, so it
        // is not written to the panel's log every few seconds while the spawner catches up.
        if (note.code === DRIVE_FAULTS.STARTING) continue;
        this.onLog(`assistant: pipeline #${note.id} — ${note.code}: ${note.reason}`);
      }
    }
    if (wrote) this.emit();
    return wrote;
  }

  /**
   * The ONE advance the panel's timer owns: a pipeline row held in the wait book on a stage whose run has settled.
   * `lib/jobs.js` `sweepPipelineWaits` clears the hold and calls this; the queue's own tick calls the same driver and is
   * the fallback (rule 2a of lib/task-pipeline-drive.js). Both doors are safe because reading a settle is idempotent:
   * the driver writes its decision on the stage run it read, so a second pass over an advanced row does nothing.
   *
   * The answer is what the SWEEP needs to say: did the row move, where to, and (when it did not) the driver's own reason.
   * A tree with no row is a refusal — never a silent success — because a hold naming a tree nobody works in is a record a
   * person has to fix, not a tick that quietly deletes it.
   * @returns {{ok: boolean, moved?: boolean, from?: string|null, to?: string|null, state?: string, why?: string|null, error?: string}}
   */
  advancePipelineTree(tree) {
    const key = normPath(tree);
    if (!key) return { ok: false, error: "the hold names no tree to advance" };
    const before = this.pipelineRowIn(key);
    if (!before) return { ok: false, error: `no queue row works in ${tree}` };
    this.sweepQueues();
    const after = this.pipelineRowIn(key);
    if (!after) return { ok: true, moved: true, from: before.pipelineRun ? before.pipelineRun.stage : null, to: null, state: "gone" };
    const from = before.pipelineRun ? before.pipelineRun.stage : null;
    const to = after.pipelineRun ? after.pipelineRun.stage : null;
    const moved = to !== from || String(after.state || "") !== String(before.state || "");
    return { ok: true, moved, from, to, state: after.state || null, why: after.reason || null, taskId: after.id };
  }

  /** The row that works in one normalised tree, from whichever queue holds it. A read: nothing is written or journalled. */
  pipelineRowIn(key) {
    if (!key) return null;
    for (const rec of this.assistants || []) {
      const out = readQueueFile(this.queuePathOf(rec));
      if (!out.found) continue;
      const hit = (out.tasks || []).find((t) => normPath(t?.worktree) === key || normPath(t?.pipelineRun?.tree?.path) === key);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * The HEAD, branch and dirty count of one tree, for the INPUTS block a stage's prompt carries (§5.2 rule 4). A
   * read: it never resets, stashes or cleans — the dirty state is the work the next stage was hired to finish. Cached
   * per pass by the caller, because one tree can be asked about twice in a sweep and `git status` is the cost.
   *
   * `commit` is the FULL sha: the driver pins a stage's handoff to it, and an abbreviated sha is a display form that
   * could name two commits. `head` stays the short one the block prints.
   * @returns {{head: string, commit: string, branch: string, dirty: number}|null} null when git cannot answer (not a repo, no HEAD)
   */
  treeFactsOf(treePath, cache = null) {
    const key = String(treePath || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (!key) return null;
    if (cache && cache.has(key)) return cache.get(key);
    let facts = null;
    try {
      const run = (args) => execFileSync("git", ["-C", treePath, ...args], { encoding: "utf8", timeout: 5000, windowsHide: true }).trim();
      const commit = run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
      const head = run(["rev-parse", "--short", "HEAD"]);
      const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
      const dirty = run(["status", "--porcelain"]).split("\u000a").filter((line) => line.trim()).length;
      facts = { head, ...(/^[0-9a-f]{40,64}$/i.test(commit) ? { commit: commit.toLowerCase() } : {}), branch, dirty };
    } catch {
      facts = null;
    }
    if (cache) cache.set(key, facts);
    return facts;
  }

  /**
   * Cut the one tree a pipeline row works in, before any stage starts (§3.2). The driver asks (`ensureTree`); this
   * performs it through the job store's own `makeWorktree`, writes `pipelineRun.tree` on the row, and journals it. No
   * worker is started here: the next pass finds the tree and asks for the stage's start, which is why every stage start
   * is `existing: true` — one code path, whether it is the first stage or the tenth.
   *
   * A cut that fails parks the row with the cut's own sentence: the row is not left queued to be re-cut on the next
   * tick, and the failure is a decision a person can read. A host with no cutter (a Jobs built by a test) journals and
   * leaves the row as it is — the row stays `queued` at its stage, which is visible and recoverable.
   * @returns {Promise<object|null>} the row carrying its new tree, or null
   */
  async cutPipelineTree(who, { taskId, pipeline = null, stage = null, prompt = "", project = null, base = null, parent = null, role = "row", plans = null, branches = null, stageName = null, position = null, visit = null } = {}) {
    const rec = this.assistantRecord(who);
    if (!rec) return null;
    const id = Number(taskId);
    const file = this.queuePathOf(rec);
    const out = readQueueFile(file);
    const task = out.tasks.find((t) => Number(t.id) === id) || null;
    if (!task || task.state !== "queued") return null;
    const run = task.pipelineRun;
    if (!run || (stage && String(run.stage || "") !== String(stage))) return null; // the row moved while the cut was pending
    if (typeof this.jobs?.makeWorktree !== "function") {
      this.journalAdd("pipeline-failed", null, `#${id} ${stage || run.stage} — this host has no tree cutter, so the stage waits in the project it names`);
      return null;
    }
    const target = this.resolveProject(project || task.project);
    if (!target) {
      const reason = `#${id} is on ${run.pipeline} · ${run.stage} and names project ${JSON.stringify(String(project || task.project || ""))}, which the registry does not hold — there is nowhere to cut its tree`;
      return this.parkPipelineStart(who, id, { stage: run.stage, reason });
    }
    const stageId = String(stage || run.stage || "").trim() || null;
    // A fan-out's cut names its BASE. `role` says what the tree is for: `lane`, `join` and a chain `stage` are
    // workspace-per-stage, and `row`/`fork` keep the row's one tree. A `from` that does not resolve is git's own error
    // and parks the row below. `parent` is the branch the commit came from — recorded on the tree even when the cut is
    // pinned to a sha, because the worktree chart nests a stage tree under that branch's row (lib/parents.js).
    const roundParent = String(parent ?? "").trim() || null;
    const title = String(task.title || prompt || "").trim();
    const at = () => new Date(this.nowMs()).toISOString();
    const recordedRound = isObject(run.round) ? run.round : null;
    // THE ROUND'S PARENT TREE, cut before the round's first stage and only then: a real worktree on
    // `.worktrees/<task-slug>-<tag>` (branch `wtgui/<task-slug>-<tag>`), cut from origin/main. It is the branch every
    // stage child is cut from and the branch the assembly lands on, so a round has ONE line of descent a reader can
    // follow in the chart instead of N stage trees hanging off the checkout. A block (a fan-out) is excluded: its
    // join tree is the landing branch, and a parent tree nothing reads would be a directory nobody works in.
    let round = recordedRound;
    if (!round && !String(base ?? "").trim() && !plans) {
      const chosen = roundNameOf(null, { title: task.title || taskTitle(title), tag: randomUUID().slice(0, 6) });
      const named = stageTreeName(chosen, null, 1);
      let root;
      try {
        // `remote` is the ref it is CUT from (`origin/main`). NO `parent` is named: the round is not cut from a local
        // branch, so its cut records no chart parent and the round's row draws BESIDE main, with its stage trees
        // under it (docs/task-pipeline.md). Naming `main` here is what nested every round under the checkout's row.
        root = await this.jobs.makeWorktree(target.path, title, { project: target.name, name: named, remote: "main", round: true });
      } catch (err) {
        const reason = `cutting the round's parent tree for ${run.pipeline} · ${run.stage} in ${target.name} failed - ${reasonOf(err)}: nothing was started, and the row stays at its stage`;
        return this.parkPipelineStart(who, id, { stage: run.stage, reason });
      }
      const sha = root.startSha || (this.treeFactsOf(root.path) || {}).commit || null;
      round = { parentPath: root.path, parent: root.branch, slug: chosen.slug, tag: chosen.tag, base: root.startRef || null, sha, display: named.display, at: at(), by: "panel" };
      this.journalAdd(
        "pipeline",
        null,
        `#${id} ${clip(title, 90)} - round parent tree cut at ${root.path} (branch ${root.branch}) from ${root.startRef || "the checkout"}, no worker started`,
      );
    }
    // THE STAGE'S OWN TREE, cut from the round's branch tip: one name for the whole round (lib/stage-tree-name.js),
    // so the directory says which stage and which visit it is, and a re-run of this visit asks for the same one.
    const name = round && (round.slug || round.tag) ? stageTreeName(round, { id: stageId, name: stageName || stageId, position }, visit ?? 1) : null;
    let made;
    try {
      made = await this.jobs.makeWorktree(target.path, title, {
        project: target.name,
        from: round ? round.parent : base || null,
        parent: round ? round.parent : roundParent,
        name,
        round: false,
      });
    } catch (err) {
      const reason = `cutting ${role === "lane" ? "a lane tree" : role === "join" ? "the aggregate tree" : role === "stage" ? "a stage tree" : "a tree"} for ${run.pipeline} · ${run.stage} in ${target.name} failed — ${reasonOf(err)}: nothing was started, and the row stays at its stage`;
      return this.parkPipelineStart(who, id, { stage: run.stage, reason });
    }
    // Re-read after the cut: it took a moment, and the row may have moved (a reader assigned another stage, a requeue
    // changed the attempt). The tree is written only on the row this cut was asked for.
    const now = readQueueFile(file);
    const fresh = now.tasks.find((t) => Number(t.id) === id) || null;
    if (!fresh || fresh.state !== "queued") return null;
    const freshRun = fresh.pipelineRun;
    if (!freshRun || (stage && String(freshRun.stage || "") !== String(stage))) return null;
    const tree = { path: made.path, branch: made.branch, startSha: made.startSha || null, parent: made.parentName || null, parentPath: (round && round.parentPath) || null, cutAt: at(), by: "panel", ...(name ? { display: name.display, tag: name.tag, position: name.position, stageName: name.stageName } : {}) };
    // EVERY stage tree is recorded under its stage id, including the first one (`row`) and a fan-out's `fork`: that map
    // is what a later pass reads to know this stage already has its workspace, and what `treeClaims` reads to keep two
    // rows out of one directory.
    const trees = stageId ? { ...(isObject(freshRun.trees) ? freshRun.trees : {}), [stageId]: tree } : freshRun.trees;
    // The base is the ONE fact about a block that cannot be derived from the bundle, so it is stored at the first cut:
    // the cut's own start sha (a pipeline-start fan-out's first lane supplies it) or the fork's settled commit.
    const fanout = plans
      ? {
          base: String((freshRun.fanout && freshRun.fanout.base) || made.startSha || base || "").trim() || null,
          fork: plans.fork || null,
          lanes: Array.isArray(plans.lanes) ? plans.lanes : [],
          join: plans.join || null,
        }
      : freshRun.fanout;
    // THE ROUND, recorded at the run's FIRST cut and never again: the parent tree this round was cut from, its branch,
    // and the commit it resolved to. Every later stage tree is cut from that branch, and the assembly lands on it, so a
    // commit that lands on origin/main after the round began cannot reach any tree of this round.
    //
    // Two cuts still record the round WITHOUT a parent tree, exactly as before it existed: a fan-out's fork (the block
    // has its own base and its join tree is the landing branch) and a cut whose start ref was a sha. Neither has an
    // assembly to land on the parent tree, so neither cuts one.
    const legacyRound = round || (made.startSha ? { parent: roundParent || made.parentName || null, sha: made.startSha, at: at(), by: "panel" } : null);
    const keptRound = isObject(freshRun.round) ? freshRun.round : legacyRound;
    // The row's landing branch. For a round with a parent tree it IS that tree - the branch the assembly lands on and
    // the one the landing step pushes. A fan-out's join keeps its aggregate, and a row's first tree keeps its own.
    const rowTree = keptRound && keptRound.parentPath
      ? {
          path: keptRound.parentPath,
          branch: keptRound.parent,
          startSha: keptRound.sha || null,
          parent: keptRound.base || null,
          display: keptRound.display || null,
          cutAt: keptRound.at || null,
          by: "panel",
        }
      : tree;
    const nextRun = {
      ...freshRun,
      // A stage's own tree is never promoted to the row's landing branch (lib/pipeline-fanout.js rule 5): the round's
      // parent tree is, and a fan-out's aggregate is, and a row's first tree is when there is neither.
      ...(keptRound && keptRound.parentPath ? { tree: rowTree } : role === "join" || role === "row" || role === "fork" ? { tree } : {}),
      ...(trees ? { trees } : {}),
      ...(fanout ? { fanout } : {}),
      ...(keptRound ? { round: keptRound } : {}),
    };
    const next = now.tasks.map((t) => (Number(t.id) === id ? { ...t, pipelineRun: nextRun } : t));
    try {
      writeQueueFile(file, next, now.nextId);
    } catch (err) {
      this.onLog(`assistant: could not write the tree for #${id} (${reasonOf(err)}) — the cut stands and the row does not name it`);
      return null;
    }
    const kind = role === "lane" ? "lane tree" : role === "join" ? "aggregate tree" : role === "stage" ? "stage tree" : "tree";
    this.journalAdd(
      "pipeline",
      null,
      `#${id} ${clip(fresh.title, 90)} — ${kind} cut at ${tree.path} (branch ${tree.branch})${base ? ` from base ${String(base).slice(0, 12)}` : ""}, no worker started`,
    );
    this.emit();
    const written = { ...fresh, pipelineRun: nextRun };
    // The join's tree is cut and then merged in the same step: the aggregate is what makes its workspace, and a worker
    // must never see the tree before its inputs are in it (lib/pipeline-fanout.js rule 4).
    if (role === "join") {
      const aggregated = this.aggregatePipelineStage(who, { taskId: id, stage: stageId, tree: tree.path, base: nextRun.fanout ? nextRun.fanout.base : base, branches });
      // The merge is recorded, so the join's start is the same handoff: ask for it now, not on a timer.
      if (aggregated) this.handOffFromTree(id);
      return aggregated || written;
    }
    this.handOffFromTree(id);
    return written;
  }

  /**
   * THE HANDOFF AT THE CUT'S END. The round-6 fix fires at the run's END — a settle stamps the hold and calls the
   * sweep at once — and nothing fired at the CUT's end, so after `git worktree add` the first stage waited for the next
   * queue tick. Round 6 measured 0.853 s because the panel was idle; round 7 measured 3 m 04.5 s, because a panel
   * restart was queued two seconds after the cut and the boot's blocking project sweep held the event loop (the
   * account is docs/reports/cut-to-first-stage-2026-11-09.md).
   *
   * Asking here removes the structural half: the tree is written on the row, the row is queued, and the pass below has
   * everything it needs. The sweep is idempotent (a stage start already asked for is guarded by `startingAt`), so a
   * handoff that finds nothing to start costs one read and changes nothing.
   */
  handOffFromTree(taskId) {
    try {
      this.sweepQueues();
    } catch (err) {
      // A handoff that fails is not a lost row: the marker is written and the next tick asks again. Saying so is what
      // keeps a silent 3-minute wait from looking like the panel having nothing to do.
      this.onLog(`assistant: the stage whose tree was just cut (#${taskId}) was not started here — the next sweep will ask again: ${reasonOf(err)}`);
    }
  }

  /**
   * Perform the ONE merge a fan-out owes (lib/pipeline-fanout.js rule 4): pre-flight every lane over the object
   * database, then one octopus commit in the aggregate tree. Answers the row it wrote, or the parked row.
   *
   * A conflict is a PARK, not a retry: two lanes wrote the same path, which is exactly what the model forbids, and a
   * person decides which one is right. Nothing is merged when the pre-flight refuses — the "half-merged tree" this
   * step exists to prevent. Stage branches are local only: this never pushes and names no remote.
   * @returns {object|null} the row carrying `merge`, or the parked row
   */
  aggregatePipelineStage(who, { taskId, stage = null, tree = null, base = null, branches = null } = {}) {
    const rec = this.assistantRecord(who);
    if (!rec || !tree) return null;
    const id = Number(taskId);
    const file = this.queuePathOf(rec);
    const out = readQueueFile(file);
    const task = out.tasks.find((t) => Number(t.id) === id) || null;
    if (!task) return null;
    const run = task.pipelineRun;
    if (!run) return null;
    const stageId = String(stage || run.stage || "").trim();
    if (!stageId || String(run.stage || "") !== stageId) return null; // the row moved while the cut was pending
    const lanes = Array.isArray(branches) ? branches : [];
    const at = new Date(this.nowMs()).toISOString();
    const result = aggregateBranches({
      tree,
      base,
      branches: lanes,
      message: aggregateMessage({ id: run.pipeline }, { join: stageId }, lanes, base),
      at,
    });
    if (!result.ok) {
      // One renderer for the sentence: the row's reason, the journal line and the stage run read the same facts, and a
      // conflict's paths are IN those facts (the driver's `renderDecision` prints them).
      const fact = {
        kind: "aggregate",
        base: base || null,
        tree,
        branches: lanes.map((b) => ({ stage: b.stage, branch: b.branch, commit: b.commit })),
        conflicts: result.conflicts || [],
        reason: result.reason || null,
        stage: stageId,
        pipeline: run.pipeline,
      };
      return this.parkPipelineStart(who, id, {
        stage: stageId,
        reason: renderDecision(fact),
        code: result.code || DRIVE_FAULTS.CONFLICT,
        fact,
      });
    }
    const merge = aggregateRecord({ commit: result.commit, base, branches: lanes, at, tree: { path: tree }, verified: Boolean(result.verified) });
    const settled = settleStageRun({ ...task }, { stage: stageId, merge });
    const next = out.tasks.map((t) => (Number(t.id) === id ? settled : t));
    try {
      writeQueueFile(file, next, out.nextId);
    } catch (err) {
      this.onLog(`assistant: could not write the aggregate for #${id} (${reasonOf(err)}) — the merge stands and the row does not name it`);
      return null;
    }
    this.journalAdd(
      "pipeline",
      null,
      `#${id} ${clip(task.title, 90)} — ${result.alreadyMerged ? "aggregate already in place" : `aggregate merged ${String(result.commit || "").slice(0, 12)}`} for ${stageId}: ${lanes.length} stage branch${lanes.length === 1 ? "" : "es"} (${lanes.map((b) => b.stage).join(", ")})${result.verified ? ", pre-flight tree verified" : ""}`,
    );
    this.emit();
    return settled;
  }

  /**
   * Perform the ONE branch a finished per-stage round owes (lib/pipeline-assembly.js): cut a worktree at the round's
   * frozen parent, cherry-pick every stage run's commit in visit order, write `pipelineRun.assembly` and promote the
   * branch to the row's `tree` - so the landing step has ONE branch to push and merge instead of the first stage's
   * tree plus siblings nothing merges. Answers the row it wrote, or the parked row.
   *
   * A conflict is a PARK: two stages changed the same lines of one path, and the documented rule (the later stage wins
   * a shared path) stops where git stops. Nothing is picked onto a branch that would be left half-built - the
   * assembler aborts the pick, and the directory and its branch are removed rather than left as an orphan. Stage
   * branches are local only: this never pushes and names no remote.
   * @returns {object|null} the row carrying `assembly`, or the parked row
   */
  async assemblePipelineRound(who, { taskId, stage = null, base = null, parent = null, parentPath = null, stages = null, title = null, project = null } = {}) {
    const rec = this.assistantRecord(who);
    if (!rec) return null;
    const id = Number(taskId);
    const file = this.queuePathOf(rec);
    const out = readQueueFile(file);
    const task = out.tasks.find((t) => Number(t.id) === id) || null;
    const run = isObject(task && task.pipelineRun) ? task.pipelineRun : null;
    const roundRecord = isObject(run && run.round) ? run.round : null;
    const baseSha = String(base ?? "").trim();
    const entries = Array.isArray(stages) ? stages : [];
    // HOW MANY COMMITS A ROUND OWES ITS BRANCH, read from the same fact the plan reads (lib/task-pipeline-drive.js
    // `assemblyPlanOf`): a round with a PARENT TREE needs one entry, because the parent tree is the branch that lands
    // and a single stage's own branch is not. A record written before the parent tree existed keeps the older rule,
    // where the first stage's own tree WAS the landing branch, so one entry there is the whole round and is no request.
    const minimum = String((roundRecord && roundRecord.parentPath) || "").trim() ? 1 : 2;
    if (!task || !run || !baseSha || entries.length < minimum) return null;
    const stageId = String(stage || run.stage || "").trim() || null;
    // ONE assembly per round. The record on the row is the proof it happened; a second branch for the same frozen
    // parent would be a second landing candidate for work that already has one (the same rule the fan-out's merge
    // record carries).
    if (isObject(run.assembly) && String(run.assembly.base || "") === baseSha && String(run.assembly.commit || "")) return task;

    const park = (why, { code = DRIVE_FAULTS.ASSEMBLY, fact = null } = {}) => {
      const now = readQueueFile(file);
      const fresh = now.tasks.find((t) => Number(t.id) === id) || null;
      if (!fresh) return null;
      const parked = setTaskState(now.tasks, id, "parked", { by: "panel", at: new Date(this.nowMs()), reason: why, hold: { kind: "manual" } });
      if (!parked) return null;
      const decision = {
        by: "panel",
        trigger: "assembly",
        code,
        at: new Date(this.nowMs()).toISOString(),
        fact: isObject(fact) ? { ...fact, reason: why } : { kind: "assembly", base: baseSha, reason: why, stage: stageId, pipeline: run.pipeline },
        reason: why,
      };
      const decided = recordStageDecision(parked.task, decision);
      const tasks = parked.tasks.map((t) => (Number(t.id) === id ? decided : t));
      try {
        writeQueueFile(file, tasks, now.nextId);
      } catch (err) {
        this.onLog(`assistant: could not park #${id} after a refused assembly (${reasonOf(err)})`);
        return null;
      }
      this.journalAdd("queue", null, `#${id} ${clip(fresh.title, 90)} — parked by the panel: ${why}`);
      this.emit();
      return decided;
    };

    if (typeof this.jobs?.makeWorktree !== "function") {
      this.journalAdd("pipeline-failed", null, `#${id} ${stageId || "assembly"} — this host has no tree cutter, so the round's ${entries.length} stage branches stay unassembled and the row waits at its last stage`);
      return null;
    }
    const target = this.resolveProject(project || task.project);
    if (!target) {
      return park(`#${id} is on ${run.pipeline} and names project ${JSON.stringify(String(project || task.project || ""))}, which the registry does not hold — there is nowhere to cut the round's assembly branch`);
    }
    const parentBranch = String(parent ?? "").trim() || null;
    // THE ROUND'S PARENT TREE IS THE ASSEMBLY'S TREE. A round cut its parent from origin/main before its first stage
    // (lib/stage-tree-name.js names it); that tree is still at the round's frozen parent, on the branch every stage was
    // cut from, and it is where the stage commits are picked - no second cut, and the branch that lands is the one the
    // round began on. A record written before the parent tree existed (`no round.parentPath`) keeps the old cut.
    const ownsTree = String(parentPath ?? (roundRecord && roundRecord.parentPath) ?? "").trim() || null;
    let made;
    if (ownsTree) {
      const facts = this.treeFactsOf(ownsTree);
      if (!facts) {
        return park(
          `the round's parent tree ${ownsTree} is not there any more: the stage commits have nowhere to be picked onto, and a fresh branch here would be a second landing candidate for one round`,
          { fact: { kind: "assembly", base: baseSha, branch: parentBranch, tree: ownsTree, stages: entries.map((entry) => ({ stage: entry.stage, visit: entry.visit, branch: entry.branch || null, commit: entry.commit })), conflicts: [], reason: null, stage: stageId, pipeline: run.pipeline } },
        );
      }
      made = { path: ownsTree, branch: facts.branch || parentBranch, startSha: baseSha, owned: true };
    } else {
      try {
        made = await this.jobs.makeWorktree(target.path, String(title || task.title || "").trim(), { project: target.name, from: baseSha, parent: parentBranch });
      } catch (err) {
        const fact = { kind: "assembly", base: baseSha, branch: null, tree: null, stages: entries.map((entry) => ({ stage: entry.stage, visit: entry.visit, branch: entry.branch || null, commit: entry.commit })), conflicts: [], reason: null, stage: stageId, pipeline: run.pipeline };
        return park(`cutting the assembly branch for ${run.pipeline} · ${stageId || "?"} in ${target.name} failed - ${reasonOf(err)}: nothing was assembled, and the stage branches are unchanged`, { fact });
      }
    }
    const at = new Date(this.nowMs()).toISOString();
    const result = assembleStages({ tree: made.path, base: baseSha, stages: entries, message: assemblyMessage({ id: run.pipeline }, entries, baseSha), at });
    if (!result.ok) {
      // The assembler aborted the stopped pick, so the worktree is back at the round's parent and clean. A tree this
      // step CUT for the assembly is removed rather than left as a cut nobody's record names; the round's own parent
      // tree is never removed - it is the row's landing branch, and the park names it.
      if (!made.owned) this.discardAssemblyTree(target.path, made);
      const fact = {
        kind: "assembly",
        base: baseSha,
        branch: made.branch,
        tree: made.path,
        stages: entries.map((entry) => ({ stage: entry.stage, visit: entry.visit, branch: entry.branch || null, commit: entry.commit })),
        conflictStage: result.stage || null,
        conflicts: result.conflicts || [],
        reason: result.reason || null,
        stage: stageId,
        pipeline: run.pipeline,
      };
      return park(renderDecision(fact), { code: result.code || DRIVE_FAULTS.ASSEMBLY, fact });
    }

    const record = assemblyRecord({
      commit: result.commit,
      base: baseSha,
      branch: made.branch,
      path: made.path,
      stages: result.stages,
      skipped: result.skipped,
      verified: result.verified,
      paths: result.paths,
      at,
    });
    const treeRecord = { path: made.path, branch: made.branch, startSha: baseSha, parent: parentBranch, cutAt: at, by: "panel" };
    // Re-read after the picks: they took a moment, and the row may have moved. The assembly is written only on the row
    // that still holds the round it was asked for.
    const now = readQueueFile(file);
    const fresh = now.tasks.find((t) => Number(t.id) === id) || null;
    if (!fresh || !isObject(fresh.pipelineRun)) return null;
    const nextRun = { ...fresh.pipelineRun, tree: treeRecord, assembly: record };
    // `worktree` follows the branch that lands: the row's PR verdict (and any landing turn) is read from the tree the
    // work is actually on, which is no longer the last stage's own.
    const next = now.tasks.map((t) => (Number(t.id) === id ? { ...t, worktree: made.path, pipelineRun: nextRun } : t));
    try {
      writeQueueFile(file, next, now.nextId);
    } catch (err) {
      this.onLog(`assistant: could not write the assembly for #${id} (${reasonOf(err)}) — the branch stands and the row does not name it`);
      return null;
    }
    this.journalAdd(
      "pipeline",
      null,
      `#${id} ${clip(fresh.title, 90)} — assembly ${String(result.commit || "").slice(0, 12)} on ${made.branch}: ${result.stages.length} stage commit${result.stages.length === 1 ? "" : "s"} of ${run.pipeline} picked in visit order (${result.stages.map((entry) => entry.stage).join(", ")}) from ${baseSha.slice(0, 12)}${result.verified ? ", every stage's paths verified" : ""}${result.skipped.length ? `, ${result.skipped.length} stage${result.skipped.length === 1 ? "" : "s"} skipped (${result.skipped.map((entry) => entry.stage).join(", ")})` : ""} — the branch that lands`,
    );
    this.emit();
    this.handOffFromTree(id);
    return { ...fresh, worktree: made.path, pipelineRun: nextRun };
  }

  /**
   * Remove an assembly worktree whose picks were refused. Best effort and never fatal: the park carries the reason and
   * the paths, so a directory that survived is a directory a person can inspect rather than a row that cannot be read.
   */
  discardAssemblyTree(repoDir, made) {
    const treePath = isObject(made) && String(made.path || "").trim();
    const branch = isObject(made) && String(made.branch || "").trim();
    if (!treePath) return;
    const run = (args) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8", timeout: 60_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    try {
      run(["worktree", "remove", "--force", treePath]);
    } catch (err) {
      this.onLog(`assistant: the refused assembly tree ${treePath} could not be removed (${reasonOf(err)}) — it is left for a look`);
      return;
    }
    if (!branch) return;
    try {
      run(["branch", "-D", branch]);
    } catch (err) {
      this.onLog(`assistant: the refused assembly branch ${branch} could not be deleted (${reasonOf(err)})`);
    }
  }

  /**
   * The two parks a stage can hold that only the READER can release (§6.4). `cap` resets the loop edge's crossing
   * count — without it a requeue re-parks on the very next pass, because the count is compared as `used + 1 > limit`
   * and a requeue never touches it. `route` re-stamps the routing fingerprint at the current stage, acknowledging a
   * deliberate re-export row by row. Both write a reader decision on the stage run and return the row to `queued`.
   * The write itself is `queueMutate`'s `pipeline-release` action, so the file, the journal and the repaint stay in
   * one place.
   * @returns {{ok: boolean, task?: object, reason?: string, error?: string}}
   */
  releasePipelinePark(who, { id, release = "cap", route = null } = {}) {
    try {
      return this.queueMutate(who, "pipeline-release", { id, release, route }, { by: "reader" });
    } catch (err) {
      return { ok: false, error: reasonOf(err) };
    }
  }

  /**
   * One write to one assistant's queue. The route module asks; this owns the file, the journal and the repaint, so
   * there is one place a task changes rather than a route and a tab each editing a JSON file. An unknown action is a
   * refusal, not a silent no-op.
   */
  queueMutate(id = PRIMARY_ASSISTANT, action = "", payload = {}, { by = "reader", carriedKey = null } = {}) {
    const rec = this.assistantRecord(id);
    if (!rec) throw Object.assign(new Error(`no such assistant: ${id}`), { code: "assistant-unknown" });
    const file = this.queuePathOf(rec);
    const out = readQueueFile(file);
    // The operations in ./assistant/queue.js are PURE — each returns the array it changed — so every branch below
    // has to adopt that return value. Writing `tasks` without doing so silently discards the change: the file would
    // be rewritten byte-identical and the route would answer "ok" for an edit nobody kept.
    let tasks = out.tasks.slice();
    let nextId = out.nextId;
    let result = null;
    let line = "";
    // A Move writes TWO files, so the tail needs the target's own pre-move snapshot: a failed source write has to put
    // the target back exactly as it was, or the task is in both queues (or neither) and the answer says nothing about it.
    let movedTo = null;
    let moveTarget = null;
    switch (String(action || "")) {
      case "add": {
        // A row can be FILED ONTO A STAGE. `add` used to write the row and `pipeline` write the stage, which was two
        // acts on the round-7 row 38 m 38 s apart, with a crash between them leaving a queued row that names no stage
        // and no stamp to prove the gap. One call now does both, and `createdAt` and `enteredAt` are the same instant
        // because both are stamped from this call's clock: one row, one write, one journal line.
        const onStage = String(payload.pipeline || "").trim();
        const added = onStage
          ? addTaskOnPipeline(tasks, payload, {
              by,
              at: new Date(this.nowMs()),
              nextId,
              carriedKey,
              source: readBundle(this.config.pipelineBundleFile),
              pipeline: payload.pipeline,
              stage: payload.stage,
            })
          : addTask(tasks, payload, { by, nextId, carriedKey });
        // The row already stands for this turn line: the line was carried out once and is being carried again by a
        // re-read of an aged-out turn. Nothing is written and nothing is journalled as an add — the caller says why
        // in its own terms, and the row it names is returned so the answer points at the work that exists.
        if (added.duplicate) return { ok: true, action, duplicate: true, task: added.task, queue: this.queueView(rec.id) };
        tasks = added.tasks;
        result = added.task;
        nextId = added.nextId;
        // The journal line says the stage when there is one, so a reader of the log sees the filing and the stage as
        // ONE act rather than two lines a crash could sit between.
        const filed = result.pipelineRun;
        line = `added #${result.id} ${clip(result.title, 90)}${
          isObject(filed) ? ` on ${String(filed.pipeline || "").trim()} · ${String(filed.stage || "").trim()}` : ""
        }`;
        break;
      }
      case "edit": {
        const edited = editTask(tasks, payload.id, payload);
        if (!edited) return { ok: false, error: `no task #${payload.id} in ${rec.name}'s queue` };
        tasks = edited.tasks;
        result = edited.task;
        line = `edited #${result.id} ${clip(result.title, 90)}`;
        break;
      }
      case "state": {
        // A LIVE ROUND'S ROW IS THE DRIVER'S (docs/task-pipeline.md, "What the last stage does, and what stays open").
        // A round with a parent tree lands from ONE assembled branch, and until that branch is on the record the row
        // holds N stage branches and no branch a landing step could push. A `done` written here would close it on a
        // single stage's verdict - measured as row 51 of the 2026-11-09 round report, where the assistant's own turn
        // closed a one-stage round whose only commit was on the stage tree. The driver asks for the assembly first and
        // settles the row itself; `parked` is still there for a round that has to stop instead.
        if (String(payload.state || "").trim() === "done") {
          const closing = tasks.find((t) => Number(t.id) === Number(payload.id)) || null;
          if (closing && roundOwesAssembly(closing)) {
            const on = String(closing.pipelineRun?.round?.parent || "").trim() || "its parent tree";
            return {
              ok: false,
              error: `#${closing.id} is a live round: its stage branches are not assembled onto ${on} yet, so a done write would close a row with nothing to land - the driver settles it after the assembly, and a round that has to stop is parked, not closed`,
            };
          }
        }
        // A typed hold has to reach `setTaskState` or the park is written blind: the route used to hand over `by` and
        // `reason` alone, so `hold` was dropped between the POST and the file and a row parked on a thread read back
        // with no hold at all — the same row the sweep then never tests, because there is nothing to test.
        //
        // Three shapes, and they mean different things: ABSENT keeps whatever the row already carries (the two-step
        // park `edit` then `state` depends on it); `null`/`""` clears; anything else is normalized here and refused
        // with a sentence rather than silently stored as nothing.
        let hold;
        if (payload.hold !== undefined) {
          hold = payload.hold === null || payload.hold === "" ? null : normHold(payload.hold);
          if (payload.hold !== null && payload.hold !== "" && !hold) {
            const e = new Error(`a hold needs a kind (${TASK_HOLD_KINDS.join(", ")}) and a value — got ${JSON.stringify(payload.hold)}`);
            e.code = "queue-hold";
            throw e;
          }
        }
        // A `thread` or `job` hold is TESTED before the park is written (a hold already false is refused), and that
        // test reads the board: with no `isLive`/`jobs` it would run against an empty store and call every live run
        // dead. `task` and `path` holds are judged from the queue and the filesystem, so they need nothing from here.
        const ctx = hold && (hold.kind === "thread" || hold.kind === "job") ? this.queueContext() : null;
        const moved = setTaskState(tasks, payload.id, payload.state, {
          by,
          reason: payload.reason,
          hold,
          ...(ctx ? { isLive: ctx.isLive, jobs: ctx.jobs } : {}),
        });
        if (!moved) return { ok: false, error: `no task #${payload.id} in ${rec.name}'s queue` };
        tasks = moved.tasks;
        result = moved.task;
        line = moved.changed
          ? `#${result.id} ${clip(result.title, 90)} → ${result.state}${result.hold ? ` on ${result.hold.kind} ${result.hold.value}` : ""}`
          : `#${result.id} was already ${result.state}`;
        break;
      }
      case "reassign": {
        const owner = String(payload.owner || payload.to || "").trim();
        // An EXACT lookup, not assistantRecord(): that one falls back to Assistant #1 for an id it does not know, so a
        // typo in a Move would file the task into #1's queue and report success.
        const target = findAssistant(this.assistants, owner);
        if (!target) return { ok: false, error: `no such assistant: ${owner || "(none)"}` };
        // A Move hands the task to ANOTHER assistant's queue: the record leaves this file and enters the target's with
        // an id that file has never used. Recording only a new owner left the task sitting in the queue whose page it
        // was created on, so the assistant it was "moved to" never saw it and the one it left still carried it.
        if (target.id === rec.id) {
          return { ok: false, error: `${rec.name} already carries #${payload.id} — Move hands it to a different assistant` };
        }
        // `from: rec.id` — the queue this file belongs to — so the record names both ends of the hand-over even for a
        // task that was filed before it carried an owner.
        const moved = reassignTask(tasks, payload.id, target.id, { by, from: rec.id });
        if (!moved) return { ok: false, error: `no task #${payload.id} in ${rec.name}'s queue` };
        const targetFile = this.queuePathOf(target);
        const targetOut = readQueueFile(targetFile);
        const adopted = adoptTask(targetOut.tasks, moved.task, { nextId: targetOut.nextId });
        if (!adopted) return { ok: false, error: `#${payload.id} could not be filed in ${target.name}'s queue` };
        // The target is written FIRST: if that write fails, nothing has moved and the source file is untouched.
        try {
          writeQueueFile(targetFile, adopted.tasks, adopted.nextId);
        } catch (err) {
          return { ok: false, error: String((err && err.message) || err) };
        }
        moveTarget = { file: targetFile, tasks: targetOut.tasks, nextId: targetOut.nextId };
        movedTo = target;
        tasks = tasks.filter((t) => Number(t.id) !== Number(payload.id));
        result = adopted.task;
        line = `#${moved.task.id} ${clip(moved.task.title, 90)} moved to ${target.name} as #${result.id}`;
        break;
      }
      case "pipeline": {
        // Putting a task on a pipeline, moving its stage, or clearing it back to assistant-decides. The bundle is read
        // HERE, per write, from the same `config.pipelineBundleFile` the window reads: a reader who re-exported it while
        // the panel runs assigns against the file they can see, and a bundle that is missing refuses the write with a
        // sentence rather than filing a stage nothing can resolve.
        if (payload.clear === true) {
          const cleared = clearTaskPipeline(tasks, payload.id);
          if (!cleared) return { ok: false, error: `no task #${payload.id} in ${rec.name}'s queue` };
          tasks = cleared.tasks;
          result = cleared.task;
          line = cleared.changed
            ? `#${result.id} ${clip(result.title, 90)} cleared to assistant-decides — the default path`
            : `#${result.id} was already on the default path`;
          break;
        }
        const assigned = assignTaskPipeline(tasks, payload.id, {
          pipeline: payload.pipeline,
          stage: payload.stage,
          source: readBundle(this.config.pipelineBundleFile),
          at: new Date(this.nowMs()),
        });
        if (!assigned) return { ok: false, error: `no task #${payload.id} in ${rec.name}'s queue` };
        tasks = assigned.tasks;
        result = assigned.task;
        line = assigned.changed
          ? `#${result.id} ${clip(result.title, 90)} → pipeline ${result.pipelineRun.pipeline} at ${result.pipelineRun.stage} (entered ${result.pipelineRun.enteredAt})`
          : `#${result.id} was already on ${result.pipelineRun.pipeline} at ${result.pipelineRun.stage} — the stamp was not rewritten`;
        break;
      }
      case "pipeline-release": {
        // The two releases a stage park can need (§6.4), both the reader's: a CAP park is otherwise unreleasable — a
        // requeue alone leaves `crossings[edge]` where it was, and the next pass compares `used + 1 > limit` and
        // re-parks in one tick. A ROUTE park is released by re-stamping the fingerprint at the stage the row is in.
        const task = tasks.find((t) => Number(t.id) === Number(payload.id)) || null;
        if (!task) return { ok: false, error: `no task #${payload.id} in ${rec.name}'s queue` };
        if (!task.pipelineRun) return { ok: false, error: `#${task.id} is not on a pipeline — there is no stage park to release` };
        const at = new Date(this.nowMs());
        const release = String(payload.release || "cap");
        let released = null;
        if (release === "cap") {
          released = releaseCapPark(task, { at: at.toISOString() });
        } else if (release === "route") {
          const source = readBundle(this.config.pipelineBundleFile);
          const bundle = source.ok ? source.bundle : null;
          const pipeline = bundle ? (bundle.pipelines || []).find((p) => p.id === String(task.pipelineRun.pipeline || "")) : null;
          const fingerprint = String(payload.route || "").trim() || (pipeline ? routingFingerprint(pipeline) : null);
          if (!fingerprint) return { ok: false, error: `#${task.id}'s pipeline cannot be read from the bundle, so there is no fingerprint to re-stamp` };
          released = restampRoutePark(task, { route: fingerprint, at: at.toISOString() });
        } else {
          return { ok: false, error: `unknown release ${JSON.stringify(release)} — use cap or route` };
        }
        if (!released) return { ok: false, error: `#${task.id} is not parked on a ${release} the panel can release` };
        const queued = setTaskState(tasks, task.id, "queued", { by, reason: released.reason, at });
        if (!queued) return { ok: false, error: `#${task.id} could not be returned to queued` };
        // `released.task` carries the reset count and the decision; `queued.task` carries the state. One write, both.
        tasks = queued.tasks.map((t) => (Number(t.id) === Number(task.id) ? { ...t, pipelineRun: released.task.pipelineRun } : t));
        result = tasks.find((t) => Number(t.id) === Number(task.id)) || null;
        line = `#${task.id} ${clip(task.title, 90)} — ${released.reason}`;
        break;
      }
      case "delete": {
        const gone = deleteTask(tasks, payload.id);
        if (!gone) return { ok: false, error: `no task #${payload.id} in ${rec.name}'s queue` };
        tasks = gone.tasks;
        result = gone.task;
        line = `deleted #${result.id} ${clip(result.title, 90)}`;
        break;
      }
      case "reorder": {
        // The pane's drag: the WHOLE list as the reader arranged it, applied here and written once below. A refusal
        // (an id that is not in this queue, a list that crosses a state bucket, a row dragged above the row it holds
        // for) throws with `queue-order`, so the route answers 400 with the sentence and the file is untouched.
        const moved = reorderTasks(tasks, payload.ids ?? payload.order);
        tasks = moved.tasks;
        result = null;
        line = moved.changed
          ? `reordered ${moved.order.length} rows: ${moved.order.slice(0, 12).map((n) => `#${n}`).join(", ")}${moved.order.length > 12 ? " …" : ""}`
          : `the order did not move (${moved.order.length} rows)`;
        break;
      }
      default:
        return { ok: false, error: `unknown queue action: ${action || "(none)"}` };
    }
    try {
      writeQueueFile(file, tasks, nextId);
    } catch (err) {
      // The task is already in the target's file; take it back out so a Move is all-or-nothing rather than a row that
      // exists in two queues and is counted twice.
      if (moveTarget) {
        try {
          writeQueueFile(moveTarget.file, moveTarget.tasks, moveTarget.nextId);
        } catch {
          /* the answer below is the failure the caller acts on; a rollback that failed leaves a visible duplicate */
        }
      }
      return { ok: false, error: String((err && err.message) || err) };
    }
    this.journalAdd("queue", rec.threadId, `${rec.name}: ${line} — by ${by}`);
    if (movedTo) this.journalAdd("queue", movedTo.threadId, `${movedTo.name}: #${result.id} ${clip(result.title, 90)} arrived from ${rec.name} — by ${by}`);
    this.emit();
    // `movedTo` is the target's queue view: the page caches it in one answer instead of re-reading a pane the reader is
    // not looking at, and a script can prove where the task landed without a second request.
    return { ok: true, action, task: result, queue: this.queueView(rec.id), ...(movedTo ? { movedTo: this.queueView(movedTo.id) } : {}) };
  }

  /**
   * The queue row a SPAWN names, checked before anything is cut. A task id means a row in the queue of the assistant
   * carrying the line out — ids are per file, so "#4" in Assistant #2's queue is not Assistant #1's #4 — and the
   * refusals are said in the line's own terms: no such row, a row that already finished, a row that belongs to
   * another assistant. A PARKED row is refused too: the park is a hold somebody put there, and a SPAWN is not the
   * thing that releases it. Every message names the id, because the line's author is the one who has to fix it.
   * @returns {string|null} the reason to refuse with, or null when the row can be linked
   */
  spawnTaskRefusal(who, taskId) {
    const id = Number(taskId);
    if (!Number.isFinite(id) || id <= 0) return null;
    const rec = this.assistantRecord(who);
    if (!rec) return `task #${id} cannot be linked: this panel has no assistant ${who}`;
    const out = readQueueFile(this.queuePathOf(rec));
    const task = out.tasks.find((t) => Number(t.id) === id) || null;
    if (!task) {
      // A foreign id is worth naming: it is the mistake this check exists for, and "no such task" would send its
      // author looking for a typo instead of the other assistant's queue.
      const other = (this.assistants || []).find(
        (a) => String(a.id) !== String(rec.id) && readQueueFile(this.queuePathOf(a)).tasks.some((t) => Number(t.id) === id),
      );
      return other
        ? `task #${id} is in ${other.name}'s queue, not ${rec.name}'s — an id names a row in the queue of the assistant carrying the line out`
        : `no task #${id} in ${rec.name}'s queue — a SPAWN can only link a row that exists there`;
    }
    if (task.state === "done") {
      return `task #${id} is done (${clip(task.title, 60)}) — a finished task is not started again; requeue it first if the work really has to run`;
    }
    if (task.state === "parked") {
      return `task #${id} is parked${task.reason ? ` — ${clip(task.reason, 100)}` : ""}; a park is a hold, so a SPAWN cannot start it`;
    }
    // A row that already has a live worker is the duplicate this check exists to stop a beat later than a state
    // word can: a SPAWN can be written the moment the row reads `running` (or after a requeue that left the old
    // run going), and a second cut for it puts two agents on the same files. The holding thread is named because
    // it is the one place the author can go and look — its console is the work already in flight.
    const thread = currentThread(task);
    const live = thread ? this.jobs.list().find((j) => String(j.thread || "") === thread && isLive(j)) || null : null;
    if (live) {
      return `task #${id} already has a live run (job ${live.id} on thread ${thread}, ${live.status}) — a second dispatch would put two workers on the same files; wait for it to end or steer it`;
    }
    return null;
  }

  /**
   * The write a SPAWN owes the row it named, made at the cut: thread, worktree, project, running and startedAt in ONE record
   * and one file write, so the row never needs the follow-up `edit` + `state` pair an assistant used to have to
   * remember — and often did not, which left a live worker under a row reading `queued`. A spawner that came back
   * with no thread is not linked: a `running` row with no thread is the phantom the queue's own STALE flag exists to
   * name, and this write would be inventing it.
   */
  linkSpawnTask(who, taskId, job, { project = null, at = new Date(this.nowMs()) } = {}) {
    const id = Number(taskId);
    if (!Number.isFinite(id) || id <= 0) return null;
    const thread = String(job?.thread || "").trim();
    if (!thread) {
      this.journalAdd("spawn-queue-unlinked", null, `#${id}: the run came back with no thread, so its queue row was left as it was — there is nothing to link it to`);
      return null;
    }
    const rec = this.assistantRecord(who);
    if (!rec) return null;
    const file = this.queuePathOf(rec);
    const out = readQueueFile(file);
    const tree = String(jobTreePath(job) || "");
    // Which project the row is about, written at the same moment as the tree: the spawn spec resolved it before
    // anything was cut (`spec.project`, from `SPAWN #12 <project>`), a real spawner also stamps the job, and a
    // `SPAWN IN <tree>` names neither — for that one the tree itself is the answer, resolved against the registry.
    const name =
      String(job?.project || job?.origin?.project || project || "").trim() ||
      String(this.resolveProject(tree)?.name || "").trim() ||
      "";
    const linked = linkTaskRun(out.tasks, id, { thread, worktree: tree || null, project: name || null, runId: runIdOfJob(job), at });
    if (!linked) {
      this.journalAdd("spawn-queue-unlinked", thread, `#${id} is no longer in ${rec.name}'s queue — the worker started, but there is no row left to link`);
      return null;
    }
    // The stage run learns its thread and job at the LINK, which is the first moment the panel knows them (§2.2). The
    // ledger entry is the one the driver created when it asked for the start; filling it in is part of the same record
    // and the same write, so a restart between the start and the link still names the attempt.
    const queuedRun = linked.task.pipelineRun;
    const stamped = queuedRun && queuedRun.stage ? settleStageRun(linked.task, { thread, job: job?.id || null }) : linked.task;
    const written = linked.tasks.map((t) => (Number(t.id) === id ? stamped : t));
    try {
      writeQueueFile(file, written, out.nextId);
    } catch (err) {
      this.journalAdd("spawn-queue-unlinked", thread, `#${id} could not be linked to ${thread}: ${reasonOf(err)} — the worker is running and the row still reads as it did`);
      this.onLog(`assistant: could not link queue task #${id} to ${thread} (${reasonOf(err)})`);
      return null;
    }
    this.journalAdd("queue", rec.threadId, `#${id} ${clip(linked.task.title, 90)} — linked to ${thread} in ${tree || "(no tree)"} by the SPAWN that cut it`);
    // THE CUT IS THE HOLD. The row's stage now has a run, and the panel's own book is where that is written down: the
    // tree's pipeline record carries `{kind: "run", stage, job, thread}`, so the row's condition is durable rather than
    // inferred, the timer reads the settle and advances the stage, and a second owner (the driver's own pass) can see
    // the row is held. Best-effort: a book that refuses is a row without a hold and a log line, never a lost link.
    const heldRun = stamped && isObject(stamped.pipelineRun) ? stamped.pipelineRun : null;
    if (heldRun && String(heldRun.stage || "").trim()) {
      try {
        this.jobs?.holdPipelineStageRun?.({
          tree: tree || null,
          pipeline: heldRun.pipeline || null,
          stage: heldRun.stage,
          visit: heldRun.visits ? heldRun.visits[heldRun.stage] : null,
          thread,
          job: job?.id || null,
          branch: job?.branch || null,
          at: new Date(this.nowMs()).toISOString(),
        });
      } catch (e) {
        this.onLog(`assistant: could not hold #${id} on ${heldRun.stage} in the wait book (${reasonOf(e)})`);
      }
    }
    this.emit();
    return linked.task;
  }

  /**
   * The write a RESUME owes the row it belongs to: a new run on a thread a queue row already names.
   *
   * A reply continues the same agent — same thread, same tree — so nothing about the row's thread changes. What
   * changes is WHICH run is doing the work, and without this write the row would keep naming the attempt that failed
   * while its retry carried the work: exactly the defect the cut's link closes (`linkSpawnTask`), one door over,
   * because a verdict read off the thread slug cannot tell two records on that thread apart.
   *
   * ONE row is written, not every row that shares the thread. A resume is one row's retry: a row whose own run is
   * still live is somebody else's record on that thread, and giving it this run id would make two rows claim one run
   * — the phantom-on-paper version of the bug this field removes. So the candidates are the open rows on that thread
   * whose named run is over (or which name none at all), and the oldest of those takes the id. Nothing about the
   * row's STATE is written: a park is the reader's decision and a done row is closed, so only the run id moves.
   *
   * Best-effort, like every queue write from a run: a file that refuses is a journal line, never a run that failed
   * to start.
   * @returns {{assistantId: string, id: number, runId: string}|null} the row that was written
   */
  linkResumedRun(thread, job) {
    const thr = String(thread || job?.thread || "").trim();
    const runId = runIdOfJob(job);
    if (!thr || !runId) return null;
    const jobs = typeof this.jobs?.list === "function" ? this.jobs.list() || [] : [];
    for (const rec of this.assistants || []) {
      let file = null;
      try {
        file = this.queuePathOf(rec);
      } catch {
        file = null;
      }
      if (!file) continue;
      const out = readQueueFile(file);
      if (!out.found || !out.tasks.length) continue;
      const candidates = out.tasks
        .filter((t) => {
          if (t.state === "done" || !taskThreads(t).includes(thr)) return false;
          if (t.runId === runId) return false; // already names this run: nothing to write
          if (!t.runId) return true; // no run id is exactly the row this write is evidence for
          // …and a row whose named run is STILL live is another record's row, not this run's.
          const run = runOfTask(t, jobs);
          return !(run && isLive(run));
        })
        .sort((a, b) => Number(a.id) - Number(b.id));
      const target = candidates[0] || null;
      if (!target) continue;
      const tasks = out.tasks.map((t) => (Number(t.id) === Number(target.id) ? { ...t, runId } : t));
      try {
        writeQueueFile(file, tasks, out.nextId);
      } catch (err) {
        this.journalAdd("queue-run-unlinked", thr, `#${target.id} could not be linked to run ${runId}: ${reasonOf(err)} — the resume is running and the row still names what it did`);
        this.onLog(`assistant: could not link queue task #${target.id} to run ${runId} (${reasonOf(err)})`);
        return null;
      }
      this.journalAdd("queue", rec.threadId, `#${target.id} ${clip(target.title, 90)} — the resume on ${thr} now carries run ${runId}`);
      this.emit();
      return { assistantId: rec.id, id: target.id, runId };
    }
    return null;
  }

  /**
   * The other half of a stage start that never happened: the driver asked for a worker for #id at `stage`, the
   * spawner refused, and the row is still queued at that stage — so the row parks with the sentence instead of asking
   * again on the next tick. A park is a decision, and a start that cannot be made is one. The stage is checked
   * because the row may have moved between the request and the refusal: a failure about a stage the row has left is
   * not a reason to park the stage it is in.
   * @returns {object|null} the parked task, or null when there was nothing to park
   */
  parkPipelineStart(who, taskId, { stage = null, reason = "", code = null, fact = null } = {}) {
    const rec = this.assistantRecord(who);
    if (!rec) return null;
    const file = this.queuePathOf(rec);
    const out = readQueueFile(file);
    const task = out.tasks.find((t) => Number(t.id) === Number(taskId)) || null;
    if (!task || task.state !== "queued") return null;
    const run = task.pipelineRun;
    if (stage && run && String(run.stage || "") !== String(stage)) return null;
    const why = String(reason || "the stage's worker could not be started");
    // A refused start is a decision, and it is written with the code the driver uses for it: the row's sentence, the
    // journal line and the stage run all read the same fact (§6.2), so "why did nothing start" is answerable later.
    // The caller may NAME the code and the fact — a fan-out's conflict is not a spawn refusal, and its paths belong in
    // the structured record rather than only in the sentence (lib/pipeline-aggregate.js).
    const decision = {
      by: "panel",
      trigger: "start-refused",
      code: code || DRIVE_FAULTS.START_REFUSED,
      at: new Date(this.nowMs()).toISOString(),
      fact: isObject(fact) ? { ...fact, reason: why } : { kind: "spawn", reason: why, stage: run ? run.stage : null, pipeline: run ? run.pipeline : null },
      reason: why,
    };
    const parked = setTaskState(out.tasks, taskId, "parked", { by: "panel", reason: why, at: new Date(this.nowMs()), hold: { kind: "manual" } });
    if (!parked) return null;
    const decided = recordStageDecision(parked.task, decision);
    const tasks = parked.tasks.map((t) => (Number(t.id) === Number(taskId) ? decided : t));
    try {
      writeQueueFile(file, tasks, out.nextId);
    } catch (err) {
      this.onLog(`assistant: could not park #${taskId} after a refused start (${reasonOf(err)})`);
      return null;
    }
    this.journalAdd("queue", null, `#${taskId} ${clip(task.title, 90)} — parked by the panel: ${why}`);
    this.emit();
    return decided;
  }

  /**
   * The row a replayed SPAWN already linked, if it did: a task with a current thread AND a worktree is the record
   * that a cut happened for it. The run is looked up in the job store so the debt can carry the tree and branch
   * `settleSpawnIntent` records; a job the store no longer holds still answers with the row's own tree, because the
   * row is the evidence this replay needs (it exists, and it is linked).
   */
  spawnTaskLinked(who, taskId, { since = 0 } = {}) {
    const rec = this.assistantRecord(who);
    if (!rec) return null;
    const out = readQueueFile(this.queuePathOf(rec));
    const task = out.tasks.find((t) => Number(t.id) === Number(taskId)) || null;
    if (!task) return null;
    const thread = currentThread(task);
    if (!thread || !task.worktree) return null;
    // The row was linked by the cut THIS line made only when it started no earlier than the line was first
    // recorded. A row linked before that belongs to an earlier line, and a new SPAWN naming it means a new run.
    const started = Date.parse(String(task.startedAt || "")) || 0;
    if (since && started && started < since) return null;
    const jobs = typeof this.jobs?.list === "function" ? this.jobs.list() : [];
    const job = jobs.find((j) => String(j.thread || "") === thread) || null;
    return { task, thread, job: job || { cwd: task.worktree } };
  }

  /**
   * Seed a queue file for every assistant at boot. The brief asks for a store "for every assistant including #1", and
   * a file that only appears on the first write makes "where is my queue?" a question with no answer. Best-effort: a
   * read-only data directory must not stop the panel booting.
   */
  loadQueues() {
    for (const rec of this.assistants) {
      const file = this.queuePathOf(rec);
      try {
        if (!existsSync(file)) writeQueueFile(file, [], 1);
      } catch (err) {
        this.onLog(`assistant: could not seed ${file} (${reasonOf(err)}) — its queue starts when the first task does`);
      }
    }
    return this.assistants.length;
  }

  /**
   * The settings in force for ONE assistant. #1 answers with the class's own live settings — the object every sentry
   * pass, wake and turn has always read — so nothing about the first assistant changes. An extra assistant answers
   * with the built-in defaults overlaid with its own file: a knob it never chose is at its default, never at
   * Assistant #1's value, which is the whole point of the item that asked for this.
   */
  settingsFor(id = PRIMARY_ASSISTANT) {
    const rec = this.assistantRecord(id);
    if (!rec || rec.id === PRIMARY_ASSISTANT) return this.settings;
    const profile = this.profileOf(rec.id);
    return {
      ...DEFAULTS,
      ...pickSettings(profile.settings || {}, DEFAULTS),
      rules: { ...DEFAULTS.rules, ...pickRules(profile.rules || {}) },
    };
  }

  /**
   * Which assistant owns a thread: the authority for what a finished turn of that thread may do. A thread a hard
   * restart left behind is still that assistant's — a late settle on it must be filed as this assistant's, not as a
   * worker's that happens to have an odd name.
   */
  assistantIdForThread(thread) {
    const t = String(thread || "");
    return (
      this.assistants.find((a) => a.threadId === t || (Array.isArray(a.previousThreads) && a.previousThreads.includes(t)))?.id || null
    );
  }

  /**
   * Which assistant a WATCH belongs to, resolved at READ time and never written back.
   *
   * A watch created since the split carries its own stamp (`assistantId`, written by the turn or the tab that made
   * it). The ones written before it have none — the list was one unowned panel-wide array — so the THREAD answers:
   * a watch on an assistant's own thread is that assistant's, and anything else is Assistant #1's, because every
   * watch was #1's before a second assistant existed. The store is deliberately NOT rewritten: the legacy list is
   * the record of what was watched, and a boot that stamped forty old records would make this indistinguishable
   * from a migration.
   */
  watchOwnerOf(watch) {
    const stamped = String(watch?.assistantId || "").trim();
    if (stamped && this.assistants.some((a) => a.id === stamped)) return stamped;
    return this.assistantIdForThread(watch?.thread) || PRIMARY_ASSISTANT;
  }

  /** One assistant's watches, in the store's own order (oldest first, as `slice(-10)` reads them). */
  watchesFor(id = PRIMARY_ASSISTANT) {
    return this.watches.filter((w) => this.watchOwnerOf(w) === id);
  }

  /**
   * Which assistant an ALERT belongs to, resolved at READ time and never written back.
   *
   * Every alert fired since the split carries its own `assistantId` (see `fired()`), #1's too. The records written
   * before that have none — the list was one panel-wide array — so the THREAD answers, exactly as it does for a
   * watch: an alert about an assistant's own turn is that assistant's, and anything else is Assistant #1's, because
   * every alert was #1's before a second assistant existed. A spawn card has no thread (nothing runs yet), so its
   * own ask carries the stamp in `spawn.assistantId`; that is the next rung. The store is deliberately NOT rewritten:
   * stamping forty old records at boot would make this indistinguishable from a migration, and this is a read.
   */
  alertOwnerOf(alert) {
    const stamped = String(alert?.assistantId || "").trim();
    if (stamped && this.assistants.some((a) => a.id === stamped)) return stamped;
    const asked = String(alert?.spawn?.assistantId || "").trim();
    return this.assistantIdForThread(alert?.thread) || (asked && this.assistants.some((a) => a.id === asked) ? asked : null) || PRIMARY_ASSISTANT;
  }

  /**
   * The panel project a tree stands in, by path: the tree itself or a directory under the project's checkout.
   * The owner store is keyed `<project>::<the tree's six-hex tag>` (lib/locks.js `ownerKey`), so a lookup that
   * guessed the project would miss the record and quietly read Assistant #1.
   */
  projectNameFor(treePath) {
    const p = normPath(treePath || "");
    if (!p) return null;
    let best = null;
    for (const pr of this.getProjects() || []) {
      const root = normPath(pr?.path || "");
      if (!root) continue;
      if (p === root || p.startsWith(`${root}/`)) {
        if (!best || root.length > best.root.length) best = { root, name: pr.name };
      }
    }
    return best ? best.name : null;
  }

  /**
   * The tree's owner as the reader set it, or null when no tree was ever moved off Assistant #1. An id that is no
   * longer on the board answers null too, exactly as the row's own fallback does: a run must never be handed to an
   * assistant this panel has no thread, settings or queue for.
   */
  ownerOfTree({ path: treePath = null, project = null, branch = null } = {}) {
    if (!this.locks || !treePath) return null;
    const name = String(project || "").trim() || this.projectNameFor(treePath);
    if (!name) return null;
    let stored = null;
    try {
      stored = this.locks.owner({ project: name, path: treePath, branch: branch || null });
    } catch {
      return null; // a store that cannot answer must not invent an owner
    }
    const id = String(stored || "").trim();
    if (!id) return null;
    return this.assistants.some((a) => a.id === id) ? id : null;
  }

  /**
   * Which assistant a RUN belongs to -- the routing answer `fired()`, `noteSettle()` and `wake()` ask, decided in
   * ONE place.
   *
   * Three answers, in order, and the order is the feature:
   *   1. the THREAD, when it is an assistant's own -- its turns are its own by definition;
   *   2. the TREE the run stands in, when the reader handed that tree to another assistant (`locks.owners`, keyed on
   *      the six-hex tag a rename keeps). This outranks the run's stamp, because a handover is meant to take the
   *      tree's runs with it, including the ones that started before the reader pressed it;
   *   3. the run's own STAMP (`job.assistantId`), written when an assistant started it.
   * Nothing answers -> null, and every caller reads that as Assistant #1: every run was #1's before a second
   * assistant existed, and a worker thread belongs to no assistant at all.
   */
  assistantIdForJob(job) {
    const byThread = this.assistantIdForThread(job?.thread);
    if (byThread) return byThread;
    const tree = jobTreePath(job) || null;
    const byOwner = this.ownerOfTree({ path: tree, project: job?.project || job?.origin?.project || null, branch: job?.branch || null });
    if (byOwner) return byOwner;
    const stamped = String(job?.assistantId || "").trim();
    return stamped && this.assistants.some((a) => a.id === stamped) ? stamped : null;
  }

  /**
   * THE ROSTER, in ladder order: assistant-1 first, then upward by number. The record file's own order is not the
   * promise — a store edited by hand can list #3 before #2 — and the ladder's whole rule is "walk from #1 upward".
   * A panel whose assistant file could not be read answers with Assistant #1's thread, so a wake still has a door.
   */
  roster() {
    const list = this.assistants.filter((a) => a && a.id);
    if (!list.length) return [{ id: PRIMARY_ASSISTANT, name: "Assistant #1", threadId: ASSISTANT_THREAD }];
    return [...list].sort((a, b) => (Number(assistantNumber(a.id)) || 0) - (Number(assistantNumber(b.id)) || 0));
  }

  /**
   * One assistant's health, for the wake ladder: the newest run on ITS OWN thread, and whether that run failed.
   *
   * The thread is the boundary on purpose. A worker's failed run says nothing about whether the assistant can answer
   * a wake — it says something about that worker — so only the assistant's own turns are read. A store that cannot
   * answer is treated as having no runs rather than as a failure: the ladder must not invent a dead assistant out of
   * a read that threw.
   *
   * A run is failed when the store's status says `failed` OR its outcome word does. The two can disagree — a run the
   * gateway completed with a non-zero exit code is `done` on the card and `failed` in its own result — and the
   * outcome is the run's own verdict. `reason` is that verdict's sentence (or the card's error), which the journal
   * line quotes so a reader can see WHY the board routed around an assistant.
   */
  runHealthFor(record, list = null) {
    const rec = record || null;
    if (!rec) return null;
    let board = list;
    if (!Array.isArray(board)) {
      try {
        board = this.jobs.list() || [];
      } catch {
        board = [];
      }
    }
    const thread = String(rec.threadId || "");
    let last = null;
    for (const j of board) {
      if (!j || String(j.thread || "") !== thread) continue;
      if (!last || newerTurn(j, last)) last = j;
    }
    const base = { id: rec.id, name: rec.name || rec.id, thread, job: null, failed: false, reason: "" };
    // NO run is an eligible assistant: "never ran" is not "failed", and a brand-new assistant must be a candidate.
    if (!last) return base;
    const status = String(last.status || "");
    const outcome = last.outcome && typeof last.outcome === "object" ? last.outcome : null;
    const failed = status === "failed" || String(outcome?.word || "") === "failed";
    const reason = String(outcome?.reason || last.error || (failed ? `the run ended as ${status || "failed"}` : ""));
    return { ...base, job: last, failed, reason };
  }

  /**
   * THE WAKE LADDER: which assistant hears a wake.
   *
   * `preferred` is who the caller MEANS — the tree's owner, the assistant the run belongs to, an explicit id. The
   * rules, in order:
   *   1. the preferred assistant, when its own last run is not `failed` (the owner is preferred, not forced);
   *   2. otherwise the roster walked from Assistant #1 upward, taking the first assistant whose last run is not
   *      `failed` — a run that never ran is eligible;
   *   3. when EVERY assistant's last run failed, the preferred assistant (else #1) keeps the wake. A wake is news
   *      about a run; dropping it because the whole board is having a bad day loses the news with nothing said. The
   *      answer carries `fallback: true` so the journal can say nobody was healthy.
   *
   * `skipped` is every failed assistant the ladder passed over, in roster order, each with its reason. `failed`
   * carries them all (including the one that had to keep a fallback wake), for that journal line.
   */
  wakeTarget(preferred = null) {
    const asked = String(preferred || "").trim() || PRIMARY_ASSISTANT;
    let board = [];
    try {
      board = this.jobs.list() || [];
    } catch {
      board = [];
    }
    const health = this.roster()
      .map((rec) => this.runHealthFor(rec, board))
      .filter(Boolean);
    const want = health.find((h) => h.id === asked) || null;
    const chosen = want && !want.failed ? want : health.find((h) => !h.failed) || null;
    const who = chosen ? chosen.id : want ? want.id : health[0]?.id || PRIMARY_ASSISTANT;
    const failed = health.filter((h) => h.failed);
    return {
      who,
      asked,
      chosen: Boolean(chosen),
      fallback: !chosen,
      skipped: chosen ? failed.filter((h) => h.id !== who) : failed,
      failed,
      health,
    };
  }

  /**
   * One journal line per routed wake: which assistant received it, and which were skipped because their own last run
   * failed — with each skip's reason. A fallback wake says plainly that nobody was healthy, so a reader never has to
   * infer from a wake alone that the board routed around a dead assistant.
   */
  journalWakeRoute(route, thread = null) {
    const label = (h) => `${h.name || h.id}${h.reason ? ` (${clip(h.reason, 100)})` : ""}`;
    const whoName = route.health.find((h) => h.id === route.who)?.name || route.who;
    const skipped = route.skipped.map(label);
    const text = route.fallback
      ? `${whoName} kept the wake though NOBODY was healthy — every assistant's last run failed: ${route.failed.map(label).join("; ") || "none recorded"}`
      : `${whoName} took the wake${skipped.length ? ` — skipped as failed: ${skipped.join("; ")}` : " — no assistant was skipped as failed"}`;
    this.journalAdd("wake-route", thread, text);
    return text;
  }

  /**
   * ONE ASSISTANT'S NAME. A rename is a LABEL and nothing else: the record keeps its `assistant-N` id, so nothing this
   * writes can move the queue file, the thread, the charter path or the state directory — every one of those is
   * derived from the id, and the only store touched here is the assistants file `createAssistant` and `pickRole`
   * already own (never the queue, never a profile, never a charter).
   *
   * The text is trimmed and capped at ASSISTANT_NAME_MAX. An empty (or whitespace-only) name is REFUSED with a message
   * rather than answered as a no-op: a Save that changes nothing and says nothing reads as a rename that did not stick.
   * Duplicates are fine — two assistants may share a name, and the id is what tells them apart.
   */
  renameAssistant(id = PRIMARY_ASSISTANT, rawName = "") {
    const wanted = String(id || "").trim() || PRIMARY_ASSISTANT;
    // Deliberately NOT `assistantRecord`: that falls back to Assistant #1, and a rename aimed at an id this panel does
    // not have must be refused, not filed onto #1's record.
    const rec = this.assistants.find((a) => a.id === wanted) || null;
    if (!rec) throw Object.assign(new Error(`no such assistant: ${wanted}`), { code: "assistant-unknown" });
    const name = pickAssistantName(rawName);
    if (!name) {
      throw Object.assign(new Error("a name cannot be empty — type one, or press Cancel to keep the current name"), {
        code: "name-invalid",
      });
    }
    const before = rec.name;
    const changed = name !== before;
    if (changed) {
      rec.name = name;
      writeAssistantsFile(this.assistantsFile, this.assistants);
      this.journalAdd(
        "assistant",
        rec.threadId,
        `${before} is now called ${name} — the id stays ${rec.id}, so its queue, thread, charter and state directory do not move`,
      );
      this.emit();
    }
    return { target: { id: rec.id, name: rec.name, threadId: rec.threadId }, before, changed };
  }

  /**
   * One assistant's knobs, written to its own file. #1 keeps the route, the file and the aggressive-mode refusals it
   * has always had; an extra assistant gets the same validation on its own profile, and only the keys the reader set
   * are stored, so an untouched knob keeps following its default instead of freezing today's number.
   */
  setSettingsFor(id = PRIMARY_ASSISTANT, patch = {}) {
    const rec = this.assistantRecord(id);
    if (!rec) throw Object.assign(new Error(`no such assistant: ${id}`), { code: "assistant-unknown" });
    if (rec.id === PRIMARY_ASSISTANT) return this.setSettings(patch);
    const current = this.settingsFor(rec.id);
    const accepted = {};
    for (const [k, v] of Object.entries(patch || {})) {
      if (k === "rules" || k === "assistantId" || k === "id") continue;
      accepted[k] = v;
    }
    const picked = pickSettings(accepted, current);
    const pickedRules = pickRules((patch && patch.rules) || {});
    const profile = this.profileOf(rec.id);
    const stored = {
      settings: { ...(profile.settings || {}), ...picked },
      rules: { ...(profile.rules || {}), ...pickedRules },
      prompt: profile.prompt,
      escalateTo: profile.escalateTo || [],
      // Carried whole: `writeProfileFile` writes the file from what it is handed, and a knob saved from this route
      // must not quietly stop the assistant's standing wake.
      wakeEveryMinutes: profile.wakeEveryMinutes || 0,
    };
    const out = writeProfileFile(this.profilePathOf(rec), stored);
    if (out.error) {
      this.journalAdd("settings-failed", rec.threadId, `could not write ${this.profilePathOf(rec)}: ${out.error}`);
      throw Object.assign(new Error(`could not write ${rec.name}'s settings: ${out.error}`), { code: "profile-write-failed" });
    }
    this.profiles.set(rec.id, stored);
    this.journalAdd("settings", rec.threadId, `${rec.name}: autonomy ${stored.settings.autonomy ?? current.autonomy} · model ${stored.settings.model || "(gateway default)"}`);
    this.emit();
    return this.settingsFor(rec.id);
  }

  /**
   * One assistant's default role prompt and its escalation list — the fields that are not knobs. #1 writes only
   * these keys (its knobs belong to assistant.json); an extra assistant writes them beside its own knobs. Nothing
   * is inferred: a field the caller leaves out keeps what the file holds. The two whitelists the Role tab used to
   * save are gone: the SPAWN switch is the only gate, and the tree a line cuts belongs to the assistant whose turn
   * wrote it.
   *
   * The pane's FRAME used to be here too. It is not any assistant's field any more: one `dockMode` in the panel's
   * own config.json draws every assistant's pane, saved through /api/settings/general. A patch that still names
   * `dock` is ignored here rather than written back into a file this build no longer reads it from.
   */
  saveProfile(id = PRIMARY_ASSISTANT, patch = {}) {
    const rec = this.assistantRecord(id);
    if (!rec) throw Object.assign(new Error(`no such assistant: ${id}`), { code: "assistant-unknown" });
    const profile = this.profileOf(rec.id);
    // A prompt the reader saves is the reader's, unless the CALLER says who wrote it: a consolidation pass sets the
    // assistant's own prompt and stamps `promptBy: "assistant"` through this same writer, which is what lets the
    // pass's own refusal (never overwrite a reader's prompt) read a fact instead of an inference. The reader's save
    // CLEARS the stamp: absence is the reader's, and the file stays the shape it always had.
    const promptMoved = patch.prompt !== undefined && String(patch.prompt ?? "") !== String(profile.prompt ?? "");
    const promptBy = patch.promptBy !== undefined ? pickPromptBy(patch.promptBy) : promptMoved ? null : profile.promptBy || null;
    const next = {
      ...profile,
      prompt: patch.prompt === undefined ? profile.prompt : String(patch.prompt ?? "").slice(0, PROMPT_CAP),
      promptBy,
      promptAt: patch.promptAt !== undefined ? patch.promptAt : promptMoved ? null : profile.promptAt || null,
      promptFrom: patch.promptFrom !== undefined ? patch.promptFrom.slice(0, 40) : promptMoved ? [] : profile.promptFrom || [],
      // The ordered list of assistants this one would hand a subject to. An assistant is never on its own list, and
      // an id this panel does not have is dropped: the pane offers the records the server sent, and this is defence
      // against a hand edit rather than the only gate. Order is the reader's and is never sorted.
      escalateTo:
        patch.escalateTo === undefined
          ? profile.escalateTo.slice()
          : pickEscalation(patch.escalateTo, rec.id).filter((x) => this.assistants.some((a) => a.id === x)),
      // The standing wake is not edited from this route — it comes from the role at creation — but it is carried
      // through every save of the file, because a save writes the whole profile and a dropped key is a stopped clock.
      wakeEveryMinutes: pickWakeEvery(profile.wakeEveryMinutes),
    };
    const promptFields = {
      prompt: next.prompt,
      promptBy: next.promptBy,
      promptAt: next.promptAt,
      promptFrom: next.promptFrom,
    };
    const body =
      rec.id === PRIMARY_ASSISTANT
        ? { ...promptFields, escalateTo: next.escalateTo, wakeEveryMinutes: next.wakeEveryMinutes }
        : { settings: next.settings || {}, rules: next.rules || {}, ...promptFields, escalateTo: next.escalateTo, wakeEveryMinutes: next.wakeEveryMinutes };
    const out = writeProfileFile(this.profilePathOf(rec), body);
    if (out.error) {
      this.journalAdd("profile-failed", rec.threadId, `could not write ${this.profilePathOf(rec)}: ${out.error}`);
      throw Object.assign(new Error(`could not write ${rec.name}'s settings: ${out.error}`), { code: "profile-write-failed" });
    }
    this.profiles.set(rec.id, next);
    if (patch.prompt !== undefined) {
      this.journalAdd(
        "profile",
        rec.threadId,
        next.prompt
          ? `${rec.name}: default role prompt saved (${next.prompt.length} chars) — it rides on every turn, including the first after a restart`
          : `${rec.name}: default role prompt cleared`,
      );
    }
    if (patch.escalateTo !== undefined) {
      this.journalAdd(
        "profile",
        rec.threadId,
        next.escalateTo.length
          ? `${rec.name}: escalation list ${next.escalateTo.join(" -> ")} (stored; nothing acts on it yet)`
          : `${rec.name}: escalation list cleared`,
      );
    }
    // The frame was the reader's own display choice; it is the PANEL's now (one `dockMode` in config.json), so this
    // route has nothing to journal about it, and a stale `dock` in a patch is ignored rather than written.
    this.emit();
    return { profile: this.profileMetaOf(rec.id), target: { id: rec.id, name: rec.name, threadId: rec.threadId } };
  }

  /**
   * RETIRE the per-assistant frame. Called by the General route that writes the panel's one `dockMode`: every
   * assistant's settings file loses the `dock` key a previous build may still carry, because a second copy of a
   * panel-wide choice is a value that can disagree with the panel — the exact thing the move exists to end.
   * Returns what each file held, so the route can name whose value was dropped; a file that held nothing but the
   * frame is deleted rather than left behind empty (lib/assistant/profile.js `dropLegacyDock`).
   */
  retireDockField() {
    const dropped = [];
    for (const rec of this.assistants) {
      const res = dropLegacyDock(this.profilePathOf(rec));
      if (res.error) {
        this.journalAdd("profile-failed", rec.threadId, `could not drop the retired pane frame from ${this.profilePathOf(rec)}: ${res.error}`);
        continue;
      }
      if (!res.had) continue;
      dropped.push({ id: rec.id, name: rec.name, dock: res.had });
      this.journalAdd("profile", rec.threadId, `${rec.name}: the per-assistant pane frame (${res.had}) is retired — Settings → General draws the panel's one frame`);
    }
    this.dockLegacy = {};
    if (dropped.length) this.emit();
    return dropped;
  }

  // The record an id names, with #1 as the fallback: every caller that does not care about assistants (the sentry,
  // the restart resume) keeps meaning the first one without having to say so.
  assistantRecord(id = PRIMARY_ASSISTANT) {
    return findAssistant(this.assistants, String(id || "")) || findAssistant(this.assistants, PRIMARY_ASSISTANT);
  }

  /**
   * Resolve a Director's spelling of an assistant: `assistant-2`, `#2`, `2`, `Assistant #2`, or the record's own
   * name. Unlike `assistantRecord` this NEVER falls back to #1 — a typo in a QUEUE line must be refused, not filed
   * into Assistant #1's queue and reported as a success. Returns null when nothing answers.
   */
  assistantRef(ref) {
    const raw = String(ref || "").trim();
    if (!raw) return null;
    const exact = this.assistants.find((a) => String(a.id) === raw);
    if (exact) return exact;
    const numbered = /^(?:assistant\s*)?#?\s*(\d+)$/i.exec(raw);
    if (numbered) return this.assistants.find((a) => String(a.id) === `assistant-${Number(numbered[1])}`) || null;
    const lower = raw.toLowerCase();
    return this.assistants.find((a) => String(a.name || "").trim().toLowerCase() === lower) || null;
  }

  roleOf(record) {
    const rec = record || this.assistantRecord();
    return findRole(this.roles, rec?.roleId) || (rec?.id === PRIMARY_ASSISTANT ? findRole(this.roles, ASSISTANT_AGENT_MANAGER_ID) || this.roles[0] : null);
  }

  // A ROLE's own name — "Manager", not "Agent Manager" and not "Manager 1": the leading "Agent " is the fleet's
  // word for it and the number belongs to the assistant, so the detail's "Controlled by: Assistant #1 — Manager"
  // bullet reads one name and one role. `roleLabelOf` builds the numbered label ON TOP of this one, so the cell's
  // tooltip and the bullet can never disagree about what the role is called.
  roleNameOf(record) {
    const rec = record || null;
    if (!rec) return null;
    const role = this.roleOf(rec);
    return String(role?.name || "").replace(/^agent\s+/i, "").trim() || "Assistant";
  }

  // The label a reader sees for an assistant's ROLE — "Manager 1", "Manager 2" — never the raw id and never the
  // assistant's own name. It is `roleNameOf` plus the assistant's position among the assistants running that same
  // role. Assistant #1 is the first Manager, so the default owner's label reads "Manager 1" without anything being
  // stored; a role named "Reviewer" labels its team "Reviewer 1", "Reviewer 2". An id no record answers for falls
  // back to "Assistant N" so a stale owner is labelled rather than drawn as a blank cell.
  roleLabelOf(record) {
    const rec = record || null;
    if (!rec) return null;
    const base = this.roleNameOf(rec);
    const team = this.assistants.filter((a) => String(a.roleId || "") === String(rec.roleId || ""));
    const at = team.findIndex((a) => String(a.id) === String(rec.id));
    const n = at >= 0 ? at + 1 : Number(assistantNumber(rec.id)) || 1;
    return `${base || "Assistant"} ${n}`;
  }

  /**
   * Every assistant thread on the board: what the worker rules must skip, and what a plain reply must refuse.
   * The threads a hard restart left behind are included — they are still THIS assistant's turns, and a card on one of
   * them must never be counted as a worker's or be answered as one. `threadOf()` is the one that answers "where its
   * next turn runs"; this answers "which threads are not workers".
   */
  assistantThreads() {
    return this.assistants.flatMap((a) => [a.threadId, ...(Array.isArray(a.previousThreads) ? a.previousThreads : [])]).filter(Boolean);
  }

  isAssistantThread(thread) {
    return this.assistantThreads().includes(String(thread || ""));
  }

  threadOf(id = PRIMARY_ASSISTANT) {
    const rec = this.assistantRecord(id);
    return rec ? rec.threadId : threadFor(id);
  }

  /**
   * Where an assistant's charter lives. #1's is the panel's own `charterFile` — the route, the file and the seed
   * are untouched — and an extra assistant's sits under `assistants/<id>/charter.md` beside it. Resolved from the
   * state directory every time rather than stored absolutely: a reader who moves their data directory takes every
   * assistant's charter with them.
   */
  charterPathOf(record) {
    const rec = record || this.assistantRecord();
    if (!rec || rec.id === PRIMARY_ASSISTANT) return this.charterFile;
    return path.join(path.dirname(this.charterFile), rec.charterRel || charterRelFor(rec.id));
  }

  // The text of one assistant's charter. #1 goes through `loadCharter` exactly as before; a copy that went missing
  // is re-made from its role rather than leaving that assistant with no long tier at all.
  charterTextFor(id = PRIMARY_ASSISTANT) {
    const rec = this.assistantRecord(id);
    if (!rec || rec.id === PRIMARY_ASSISTANT) return this.loadCharter();
    const file = this.charterPathOf(rec);
    if (!existsSync(file)) {
      const role = this.roleOf(rec);
      if (!role) return "";
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, role.charter);
        this.onLog(`assistant: ${file} was missing — re-seeded it from the ${role.name} role (${role.charter.length} chars)`);
        return role.charter;
      } catch (err) {
        this.onLog(`assistant: could not re-seed ${file} (${reasonOf(err)})`);
        return "";
      }
    }
    const out = readCharterFile(file, {});
    if (out.error) {
      this.onLog(`assistant: could not read ${file} (${out.error}) — that charter is empty this turn`);
      return "";
    }
    return out.text;
  }

  /**
   * Path, size, age and the cap for one assistant's charter. One read, so the numbers describe the same bytes.
   * #1's meta comes from the class's own `charterMeta()`; every other assistant's is read from ITS file through the
   * aliased helper. The method name is deliberately the same as the helper's — it is the per-assistant entry point the
   * rest of the class asks — and the alias above is what keeps the two apart.
   */
  charterMetaFor(id = PRIMARY_ASSISTANT) {
    const rec = this.assistantRecord(id);
    if (!rec || rec.id === PRIMARY_ASSISTANT) return this.charterMeta();
    const { text, ...meta } = charterMetaOf(this.charterPathOf(rec), { seeded: false });
    return meta;
  }

  charterPayloadFor(id = PRIMARY_ASSISTANT) {
    const meta = this.charterMetaFor(id);
    return { ...meta, text: String(this.charterTextFor(id) || "") };
  }

  /**
   * Everything the Role tab needs for one assistant: which role it runs, the roles it can run, its own charter
   * (with the text — this is the one route that carries 20 KB, fetched when the tab opens, never on the poll), and
   * whether that text is still the role's own or an edit of it.
   */
  rolePayload(id = PRIMARY_ASSISTANT) {
    const rec = this.assistantRecord(id);
    if (!rec) throw Object.assign(new Error(`no such assistant: ${id}`), { code: "assistant-unknown" });
    const role = this.roleOf(rec);
    const charter = this.charterPayloadFor(rec.id);
    // One read for the three profile fields below, not three: they describe one file, and a preamble built from
    // two different reads of it is how a pane shows a prompt its own turn would not run on.
    const own = this.profileOf(rec.id);
    return {
      // `target`, not `assistant`: every route answers with the whole assistant STATE under that key, and a record
      // of the same name inside this payload would be silently overwritten by `{ ...payload, assistant: state() }`.
      target: { id: rec.id, name: rec.name, roleId: rec.roleId, threadId: rec.threadId },
      role: role ? { id: role.id, name: role.name, description: role.description } : null,
      roles: this.rolesList(),
      charter,
      // "You are running the role as written" and "you edited a copy" are different states, and only the second
      // one should offer re-adopting the role's text.
      sameAsRole: Boolean(role) && String(charter.text) === String(role.charter),
      // The field that is NOT the charter: the default role prompt this assistant runs on (saved here, read back on
      // every turn and after a restart). It travels with the pane's one read, so the box opens showing what is on
      // disk rather than an empty field the reader might overwrite. The two whitelists this payload used to carry
      // are gone — the SPAWN switch is the only gate, and a tree's owner is stamped at spawn.
      prompt: String(own.prompt || ""),
      // The standing wake the Role tab shows beside the remit: the interval is part of the job the role describes,
      // and the tab has to be able to say "wakes every 20 minutes" without a second read. 0 = no cadence.
      wakeEveryMinutes: pickWakeEvery(own.wakeEveryMinutes),
      profile: this.profileMetaOf(rec.id),
    };
  }

  // ONE role's own text, by id — what the Role tab reads when its picker moves. `rolePayload` above carries every
  // role's name, description and size but never their text (that is 20 KB per role on a read the poll would
  // repeat); this is the per-pick read that does carry it — the ROLE's prompt and charter, not an assistant's copy.
  // `mtime` is the role's own `updatedAt` in ms, which the editor sends back with Save so a role that moved under
  // the reader refuses the write instead of discarding it.
  roleCharterPayload(roleId) {
    const role = findRole(this.roles, String(roleId || ""));
    if (!role) throw Object.assign(new Error(`no such role: ${roleId}`), { code: "role-unknown" });
    const mtime = new Date(role.updatedAt || 0).getTime();
    return {
      role: roleMeta(role),
      text: String(role.charter ?? ""),
      prompt: String(role.prompt ?? ""),
      cap: CHARTER_MAX_CHARS,
      mtime: Number.isFinite(mtime) && mtime > 0 ? mtime : null,
    };
  }

  // The reader's save of ONE role from the Role tab: its name, the one line that says what it is for, the short
  // instruction its turns begin with, and the long charter — one write, because they describe one job. The cap and
  // the stale-save refusal are lib/roles.js's, the same two every role's charter has always had.
  saveRole({ roleId, name, description, prompt, text, expectMtime = null } = {}) {
    const role = writeRole(this.rolesFile, this.roles, String(roleId || ""), { name, description, prompt, charter: text }, { expectMtime });
    this.journalAdd("role", null, `${role.name} role saved (${role.charter.length} chars, ${role.prompt.length} prompt)`);
    this.emit();
    return { ...this.roleCharterPayload(role.id), roles: this.rolesList() };
  }

  // The reader's save of ONE assistant's charter. #1 keeps the route and the file it always had; any other
  // assistant's save goes through the same writer, so the 20,000-character cap and the stale-save refusal are the
  // same two refusals with the same two codes on every copy.
  setCharterFor(id, text, by = "reader", { expectMtime = null } = {}) {
    const rec = this.assistantRecord(id);
    if (!rec) throw Object.assign(new Error(`no such assistant: ${id}`), { code: "assistant-unknown" });
    if (rec.id === PRIMARY_ASSISTANT) return this.setCharter(text, by, { expectMtime });
    writeCharterFile(this.charterPathOf(rec), text, { expectMtime });
    this.journalAdd("charter", rec.threadId, `${rec.name}'s charter saved by ${by} (${String(text ?? "").length} chars)`);
    this.emit();
    return this.charterPayloadFor(rec.id);
  }

  // The reader picks a role for an assistant. `adopt` copies the role's charter into that assistant's own copy —
  // replacing whatever it held — which is why the tab asks for it as its own press and the server never infers it.
  pickRole(id, roleId, { adopt = false } = {}) {
    const rec = this.assistantRecord(id);
    if (!rec) throw Object.assign(new Error(`no such assistant: ${id}`), { code: "assistant-unknown" });
    const role = findRole(this.roles, String(roleId || ""));
    if (!role) throw Object.assign(new Error(`no such role: ${roleId}`), { code: "role-unknown" });
    rec.roleId = role.id;
    writeAssistantsFile(this.assistantsFile, this.assistants);
    // A pick is a change of JOB, so a role that carries a standing wake hands it to this assistant if it has none.
    // `wakeEveryMinutes` is preserved on every save, so a reader's own number is never overwritten by a pick.
    this.ensureCadenceFor(rec, role);
    if (adopt) this.setCharterFor(rec.id, role.charter, "role picker");
    this.journalAdd("role", rec.threadId, `${rec.name} now runs the ${role.name} role${adopt ? " — its charter was replaced with the role's" : ""}`);
    this.emit();
    return this.rolePayload(rec.id);
  }

  /**
   * Restart ONE assistant's turn context, and nothing else. A role change is exactly the change the panel's
   * session-scoped send records cannot see: the charter long tier is this assistant's OWN copy, so an unchanged file
   * would be withheld on the next turn under the NEW role's name. Dropping this id's three records — the charter's
   * send record, the board digest's signature and the queue digest's wake tick — makes that assistant's next turn the
   * first turn of a session again: the full charter (labelled with the role its record now carries), the full board
   * and the full queue. Another assistant's records are untouched, and the panel, the gateway and the sentry clock are
   * never restarted — this is a turn-context restart, not a process one.
   *
   * `cleared` names what was actually dropped so the reader is told what the press did; a fresh session has nothing
   * sent yet and says that instead of claiming a rebuild it did not need.
   */
  restartRole(id = PRIMARY_ASSISTANT) {
    const rec = this.assistantRecord(id);
    if (!rec) throw Object.assign(new Error(`no such assistant: ${id}`), { code: "assistant-unknown" });
    const role = this.roleOf(rec);
    const cleared = [];
    if (this.charterSends.delete(rec.id)) cleared.push("charter");
    if (this.boardSigs.delete(rec.id)) cleared.push("board");
    if (this.queueWakeTicks.delete(rec.id)) cleared.push("queue");
    const roleName = role?.name || "(none)";
    const sent = cleared.length ? ` (${cleared.join(", ")} sent in full again)` : " (nothing had been sent yet this session)";
    this.journalAdd("role-restart", rec.threadId, `${rec.name}: turn context restarted — its next turn is built from the ${roleName} role${sent}`);
    this.emit();
    return {
      target: { id: rec.id, name: rec.name, roleId: rec.roleId, threadId: rec.threadId },
      role: role ? { id: role.id, name: role.name } : null,
      cleared,
      live: this.assistantLive(rec.id),
    };
  }

  /**
   * HARD RESTART of ONE assistant: it leaves the thread it has been carrying and starts a fresh one.
   *
   * The mechanism is the thread id, because the thread id IS the gateway's session id: `Jobs.create` posts
   * `session_id: thread`, so this assistant's next turn asks for a session that does not exist yet — no history, no
   * carried conversation — and the panel starts drawing that thread's card from scratch. The old thread is remembered
   * in `previousThreads` (the message board and the ownership reads keep naming its turns as this assistant's), and
   * nothing is deleted: its transcript, queue, watches, charter, rules, settings and alerts all stay.
   *
   * The three session-recall records are dropped too, so the first turn of the new session is a first turn in every
   * sense — the full charter, the full board and the full queue. No other assistant's thread or recall is touched, and
   * the panel and the gateway are never restarted.
   *
   * A live turn blocks it: moving the thread under an executing run would orphan that run on a thread nothing will
   * read again, so the caller gets `assistant-live` and can stop the turn first.
   */
  hardRestart(id = PRIMARY_ASSISTANT, { by = "reader" } = {}) {
    const wanted = String(id || PRIMARY_ASSISTANT);
    // An EXACT record, not `assistantRecord()`: that one falls back to #1, so a typo in an id would hard-restart the
    // assistant the reader did not name.
    const rec = findAssistant(this.assistants, wanted);
    if (!rec) throw Object.assign(new Error(`no such assistant: ${wanted}`), { code: "assistant-unknown" });
    if (this.assistantLive(rec.id)) {
      throw Object.assign(
        new Error(`${rec.name} has a turn still running — stop it first; a hard restart never moves the thread under a live run`),
        { code: "assistant-live" },
      );
    }
    const base = threadFor(rec.id);
    const previous = String(rec.threadId || base);
    const gen = threadGenOf(previous, base) || 1;
    // Every thread any assistant has used is taken. A generation is chosen, never assumed free: the same id may be a
    // leftover of an earlier restart, or a hand-edited record's.
    const taken = new Set(this.assistants.flatMap((a) => [a.threadId, ...(Array.isArray(a.previousThreads) ? a.previousThreads : [])]));
    let g = gen + 1;
    let next = restartedThreadFor(base, g);
    while (taken.has(next) && g < gen + 100) {
      g += 1;
      next = restartedThreadFor(base, g);
    }
    const before = { threadId: rec.threadId, previousThreads: Array.isArray(rec.previousThreads) ? rec.previousThreads.slice() : undefined };
    rec.threadId = next;
    rec.previousThreads = [previous, ...(Array.isArray(rec.previousThreads) ? rec.previousThreads : [])]
      .filter((t, i, arr) => t && t !== next && arr.indexOf(t) === i)
      .slice(0, 5);
    try {
      writeAssistantsFile(this.assistantsFile, this.assistants);
    } catch (err) {
      // The record is the source the next turn reads, so a failed write puts it back: an in-memory move with no file
      // behind it would evaporate on the next boot and read as a press that undid itself.
      rec.threadId = before.threadId;
      if (before.previousThreads) rec.previousThreads = before.previousThreads;
      else delete rec.previousThreads;
      throw err;
    }

    const cleared = [];
    if (this.charterSends.delete(rec.id)) cleared.push("charter");
    if (this.boardSigs.delete(rec.id)) cleared.push("board");
    if (this.queueWakeTicks.delete(rec.id)) cleared.push("queue");
    const sent = cleared.length ? ` (${cleared.join(", ")} sent in full again)` : "";
    this.journalAdd(
      "hard-restart",
      next,
      `${rec.name}: hard restart by ${by} — thread ${previous} → ${next}; its next turn is the first turn of a new session${sent}. The panel and the gateway were not restarted.`,
    );
    this.emit();
    return {
      target: { id: rec.id, name: rec.name, threadId: next, previousThread: previous },
      cleared,
      keeps: ["queue", "watches", "charter", "rules", "settings", "alerts", "transcript"],
      panelRestarted: false,
      gatewayRestarted: false,
    };
  }

  /**
   * The standing wake a role hands its assistant, written only when that assistant has none. One field, one write,
   * and never a second timer: the sentry reads `wakeEveryMinutes` from the profile (see `checkCadence`). Assistant
   * #1's file carries only the profile fields (its knobs stay in assistant.json), so the body is branched the same
   * way `saveProfile` branches it — an extra assistant's settings and rules must survive this write.
   */
  ensureCadenceFor(rec, role) {
    if (!rec || role?.id !== ASSISTANT_DIRECTOR_ID) return false;
    const profile = this.profileOf(rec.id);
    if (pickWakeEvery(profile.wakeEveryMinutes)) return false;
    const next = { ...profile, wakeEveryMinutes: ASSISTANT_DIRECTOR_WAKE_MINUTES };
    const body =
      rec.id === PRIMARY_ASSISTANT
        ? { prompt: next.prompt, escalateTo: next.escalateTo, wakeEveryMinutes: next.wakeEveryMinutes }
        : { settings: next.settings || {}, rules: next.rules || {}, prompt: next.prompt, escalateTo: next.escalateTo, wakeEveryMinutes: next.wakeEveryMinutes };
    const out = writeProfileFile(this.profilePathOf(rec), body);
    if (out.error) {
      this.onLog(`assistant: could not write ${rec.name}'s profile (${out.error}) — it has no standing wake until the file is writable`);
      return false;
    }
    this.profiles.set(rec.id, pickProfile(body));
    this.journalAdd("role", rec.threadId, `${rec.name}: standing wake every ${ASSISTANT_DIRECTOR_WAKE_MINUTES} minutes (from the ${role.name} role)`);
    return true;
  }

  /**
   * A new assistant from a role: the next number, its own thread, its own RULES and its own COPY of the role's
   * charter. The copy is the whole point — two assistants on one role are two jobs with two memories, so editing
   * #2's charter must not change one byte of what #1 is told.
   */
  createAssistant({ roleId = "", name = "" } = {}) {
    const role = findRole(this.roles, String(roleId || "")) || this.roleOf(this.assistantRecord());
    if (!role) throw Object.assign(new Error("there is no role to create an assistant from"), { code: "role-unknown" });
    if (this.assistants.length >= ASSISTANT_MAX) {
      throw Object.assign(new Error(`this panel holds ${ASSISTANT_MAX} assistants already`), { code: "assistant-full" });
    }
    const rec = nextAssistantRecord({ assistants: this.assistants, role });
    if (String(name || "").trim()) rec.name = clip(String(name).trim(), 60);
    // Its rules are a COPY of the standing rules the reader has written so far, taken now and owned by this record
    // from here: a rule added to #2 later is #2's, and nothing this assistant does can move #1's list.
    this.seedRulesFor(rec);
    const file = this.charterPathOf(rec);
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, role.charter);
    } catch (err) {
      const e = new Error(`could not write ${file}: ${reasonOf(err)}`);
      e.code = "charter-write-failed";
      throw e;
    }
    this.assistants.push(rec);
    writeAssistantsFile(this.assistantsFile, this.assistants);
    // The Director's job carries its own clock and its own prohibition, and both are written ONCE, as the
    // assistant's profile: `wakeEveryMinutes: 20` is what the sentry reads (there is no second timer), and
    // `spawn: "off"` is what makes "never start a worker" a gate rather than a sentence in a charter the model
    // might forget. Every other role keeps the profile it always had — none at all until the reader saves one.
    if (role.id === ASSISTANT_DIRECTOR_ID) {
      const seed = {
        settings: { spawn: "off" },
        rules: {},
        prompt: "",
        escalateTo: [],
        wakeEveryMinutes: ASSISTANT_DIRECTOR_WAKE_MINUTES,
      };
      const out = writeProfileFile(this.profilePathOf(rec), seed);
      if (out.error) {
        this.onLog(`assistant: could not write ${rec.name}'s profile (${out.error}) — it has no standing wake until the file is writable`);
      } else {
        this.profiles.set(rec.id, pickProfile(seed));
      }
    }
    // Its queue is seeded HERE, not left for the first write: every assistant has one file at the path the tab, the
    // wake directive and the digest read, and a store that only appears after the first task leaves "where is its
    // queue?" unanswered. loadQueues() does this for the assistants a boot finds; this is the same store for one the
    // reader creates while the panel is running. Best-effort like that pass — a read-only data directory must not
    // refuse a new assistant.
    try {
      writeQueueFile(this.queuePathOf(rec), [], 1);
    } catch (err) {
      this.onLog(`assistant: could not seed ${rec.name}'s queue (${reasonOf(err)}) — it starts when the first task does`);
    }
    // Its pad, seeded ONCE from Assistant #1's current notes: the text every assistant used to share is what this
    // one starts from, and `seedNotesFile` never overwrites a file that exists. From here the pad is this
    // assistant's own — a NOTE in #2's turn lands only in it.
    try {
      const pad = seedNotesFile(this.notesPathOf(rec), this.notes);
      if (pad.error) this.onLog(`assistant: could not seed ${rec.name}'s pad (${pad.error}) — it starts when the first NOTE lands`);
    } catch (err) {
      this.onLog(`assistant: could not seed ${rec.name}'s pad (${reasonOf(err)}) — it starts when the first NOTE lands`);
    }
    this.journalAdd(
      "assistant",
      rec.threadId,
      `created ${rec.name} from the ${role.name} role — thread ${rec.threadId}, its own charter at ${file.replace(/\\/g, "/")}`,
    );
    this.emit();
    return { created: rec, role: { id: role.id, name: role.name, description: role.description }, roles: this.rolesList() };
  }

  // One assistant's rules. #1's are the class's own list in assistant.json; the others keep theirs on their
  // record, because there is no second assistant.json and a rule list is three fields, not a store. The list's
  // decisions are ./assistant/rules.js's; these two are the record routing and the write-back.
  addRuleFor(id, text, by = "reader") {
    return addRuleForRecord(this, id, text, by);
  }

  removeRuleFor(id, ruleId) {
    return removeRuleForRecord(this, id, ruleId);
  }

  // ---- consolidation: the reader's grant, and the pass it lets run ------------------------------
  //
  // The reader grants it once on the assistant record; the assistant then runs ONE pass over its list, its charter
  // and its role prompt. The rule-level refusals are ./assistant/consolidate.js's; this section is the grant, the
  // snapshot the pass must write before anything else, and one write per store after it.

  /** Where a pass's BEFORE snapshot lands: `<logsDir>/rule-consolidations`, beside the pass it makes reversible. */
  consolidationDir() {
    const base = this.config?.logsDir || path.dirname(this.file);
    return path.join(base, CONSOLIDATION_DIR);
  }

  /** The reader's grant on one assistant, in the shape the page and the route read. */
  consolidationGrantFor(id = PRIMARY_ASSISTANT) {
    const rec = this.assistantRecord(id);
    if (!rec) throw Object.assign(new Error(`no such assistant: ${id}`), { code: "assistant-unknown" });
    return grantOf(rec);
  }

  /**
   * The reader's grant, on or off. Stamped `by: "reader"` so a pass can tell a granted record from a hand-edited
   * one, and journaled because a standing permission changing is exactly what the long tier is for.
   */
  setConsolidationGrant(id = PRIMARY_ASSISTANT, granted = false) {
    const rec = this.assistantRecord(id);
    if (!rec) throw Object.assign(new Error(`no such assistant: ${id}`), { code: "assistant-unknown" });
    const before = grantOf(rec);
    const after = granted ? grantConsolidation(rec, { at: nowIso() }) : revokeConsolidation(rec);
    writeAssistantsFile(this.assistantsFile, this.assistants);
    this.journalAdd(
      "rule",
      rec.threadId,
      granted
        ? `${rec.name}: the reader granted rule consolidation - a pass may merge, drop, move a rule into the charter and set the role prompt until it is taken back`
        : `${rec.name}: the reader took the consolidation grant back - a pass may no longer write`,
    );
    this.emit();
    return { ...after, changed: before.granted !== after.granted };
  }

  /**
   * One consolidation pass. `dryRun` validates and reports without writing anything, which is what the reader sees
   * before applying a plan; a real pass writes the snapshot FIRST, then one write per store, then the journal.
   *
   * The grant is read here rather than handed in, so a caller cannot pass `granted: true` around the reader's
   * answer: the only door onto a write is a record carrying `consolidate: { by: "reader" }`.
   *
   * @returns the report plus the new values, and the snapshot path a real pass wrote.
   */
  consolidateRulesFor(id = PRIMARY_ASSISTANT, { plan, dryRun = false } = {}) {
    const rec = this.assistantRecord(id);
    if (!rec) throw Object.assign(new Error(`no such assistant: ${id}`), { code: "assistant-unknown" });
    const rules = this.rulesFor(rec.id);
    const charter = String(this.charterTextFor(rec.id) || "");
    const own = this.profileOf(rec.id);
    const at = nowIso();
    const granted = grantOf(rec).granted;
    const out = consolidatePlan({ rules, charter, prompt: own.prompt || "", promptBy: own.promptBy || null, plan, granted, dryRun, at });
    if (dryRun) {
      return { dryRun: true, snapshot: null, rules: out.rules, prompt: out.prompt, ...out.report };
    }
    // 1. THE SNAPSHOT, before any write. A pass that cannot be undone is a pass that does not run.
    const snap = snapshotConsolidation({
      dir: this.consolidationDir(),
      assistantId: rec.id,
      at,
      rules,
      charter,
      prompt: own.prompt || "",
      promptBy: own.promptBy || null,
      plan,
    });
    // 2. The list, one write: #1's store through the class's debounced writer, an extra assistant's own record.
    if (rec.id === PRIMARY_ASSISTANT) {
      this.rules = out.rules;
      this.persist();
    } else {
      rec.rules = out.rules;
      writeAssistantsFile(this.assistantsFile, this.assistants);
    }
    // 3. The charter: the entries a `charter` op moved, then one summary naming the counts and the snapshot. Both
    //    are built in memory and written once, and a full charter refuses the summary rather than losing an entry.
    const summary =
      `rule consolidation: kept ${out.report.counts.kept}, rewritten ${out.report.counts.rewritten}, ` +
      `merged ${out.report.counts.merged}, dropped ${out.report.counts.dropped}, ` +
      `moved to the charter ${out.report.counts.chartered}, absorbed into the role prompt ${out.report.counts.prompted}; ` +
      `${out.report.before.rules} rules before, ${out.report.after.rules} after; snapshot ${String(snap.path).replace(/\\/g, "/")}`;
    const appended = appendEntry(out.charter, summary, { at: new Date(at), by: "panel", kind: "rules" });
    const nextCharter = appended === out.charter ? out.charter : appended;
    if (nextCharter !== charter) writeCharterFile(this.charterPathOf(rec), nextCharter);
    if (appended === out.charter) {
      this.journalAdd("charter-full", rec.threadId, "the consolidation summary was not written: the charter is at its cap");
    }
    // 4. The role prompt, through the profile writer, stamped as the assistant's own (the refusal that protects a
    //    reader's prompt is what makes that stamp matter).
    if (out.prompt !== (own.prompt || "")) {
      this.saveProfile(rec.id, { prompt: out.prompt, promptBy: "assistant", promptAt: out.promptAt, promptFrom: out.promptFrom });
    }
    // 5. The journal: one line per op, then the pass and its snapshot.
    for (const op of out.report.ops) {
      this.journalAdd(
        "rule",
        rec.threadId,
        `${rec.name}: consolidation ${op.op} ${op.ids.join(", ")}${op.id && op.id !== op.ids[0] ? ` -> ${op.id}` : ""}`,
      );
    }
    this.journalAdd(
      "rule",
      rec.threadId,
      `${rec.name}: consolidation pass wrote ${out.report.after.rules} rules (${out.report.before.rules} before), charter ${out.report.charterChars} chars, prompt ${out.report.promptChars} chars; snapshot ${String(snap.path).replace(/\\/g, "/")}`,
    );
    this.emit();
    return { dryRun: false, snapshot: snap.path, rules: out.rules, charter: nextCharter, prompt: out.prompt, ...out.report };
  }

  /** A new role, copied from an existing one (or from the text handed in), for the picker to offer. */
  createRole({ name, description = "", prompt = "", from = "", charter = "" } = {}) {
    const role = createRole(this.rolesFile, this.roles, { name, description, prompt, from, charter });
    this.journalAdd("role", null, `created the ${role.name} role (${role.charter.length} chars)`);
    this.emit();
    return { role: roleMeta(role), roles: this.rolesList() };
  }

  // What the page shows for every assistant: who it is, the role it runs, its own thread, its own rules, and the
  // size of its own charter. Never the charter TEXT — a 20 KB body re-sent on every board event is a cost nobody
  // asked for; the Role tab fetches the one it is looking at.
  assistantList(primaryCharter = null) {
    const primary = primaryCharter || this.charterMeta();
    return this.assistants.map((rec) => ({
      id: rec.id,
      name: rec.name,
      roleId: rec.roleId,
      roleName: this.roleOf(rec)?.name || "",
      // The role label the row and the detail line read — "Manager 1", never the raw `assistant-1`. Additive: an
      // entry gains a field and moves nothing, and the page resolves an owner id through this list rather than
      // string-matching an id into a sentence.
      roleLabel: this.roleLabelOf(rec),
      threadId: rec.threadId,
      // What this assistant used to run on, newest first: a hard restart moves it to a fresh thread and this is how
      // the pane can say "was panel-assistant" without the page keeping its own history.
      previousThreads: Array.isArray(rec.previousThreads) ? rec.previousThreads.slice() : [],
      rules: this.rulesFor(rec.id),
      // The reader's consolidation grant, so the tab can draw the switch from the same read as the list: a page
      // that guessed it would show "Apply" on a record no pass may write.
      consolidate: grantOf(rec),
      charter: rec.id === PRIMARY_ASSISTANT ? primary : this.charterMetaFor(rec.id),
      // The standing wake, for the tab's own intro line: "it wakes every 20 minutes" is a fact about the assistant,
      // and the reader should not have to open the Role tab to learn it.
      wakeEveryMinutes: pickWakeEvery(this.profileOf(rec.id).wakeEveryMinutes),
      // Its settings file, its default role prompt's size and its two lists — metadata only, and only for an EXTRA
      // assistant: #1's own payload keeps the exact shape it had before any of this existed (its Role tab reads its
      // prompt and lists from the role route, which always carried per-assistant fields).
      ...(rec.id === PRIMARY_ASSISTANT ? {} : { profile: this.profileMetaOf(rec.id) }),
      live: this.jobs.list().some((j) => j.thread === rec.threadId && isLive(j)),
    }));
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
    // #1's charter is read once and shared by the two fields below that describe it (the charter row the old tab
    // reads and the assistant's own entry in the list) — one stat and one read, not two of each per board event.
    const charterMeta = this.charterMeta();
    return {
      // The thread #1's turns run on NOW: the fixed id until a hard restart moves it, and the new one after — the
      // page's fallback for "which thread is the board's own assistant" has to follow the record, not the spelling.
      thread: this.threadOf(PRIMARY_ASSISTANT),
      // Which assistant this class's own sentry and turns belong to: the first one. The list below is every
      // assistant the float can show; only #1 has a sentry, a scratchpad and a journal behind it.
      assistantId: PRIMARY_ASSISTANT,
      enabled: this.settings.enabled,
      settings: this.settings,
      // Every OTHER assistant's settings, resolved from its own file. #1's stay under `settings` above — the key,
      // the shape and the values every existing caller reads — so the first assistant's payload gains a key and
      // moves nothing. Omitted entirely on a panel that has only Assistant #1, which is what keeps a single-assistant
      // panel's `/api/assistant` answer byte-identical to the one it gave before any of this existed.
      ...(this.assistants.some((a) => a.id !== PRIMARY_ASSISTANT)
        ? { assistantSettings: Object.fromEntries(this.assistants.filter((a) => a.id !== PRIMARY_ASSISTANT).map((a) => [a.id, this.settingsFor(a.id)])) }
        : {}),
      ruleDefs: RULE_DEFS,
      escalations: ESCALATIONS,
      autonomy: AUTONOMY,
      spawnModes: SPAWN_MODES,
      // The command audit's three modes, so the Settings row renders the same list the server validates against.
      commandAuditModes: COMMAND_AUDIT_MODES,
      // Which pane owns each knob, from the one table that decides it (lib/assistant/config.js). The Watchdog tab and
      // an assistant's Settings tab are drawn from THIS, so the split cannot drift from the store: a key the page
      // rendered in both panes would be two controls for one value. `settings` itself is untouched - #1's payload
      // gains a key here and moves nothing.
      settingScope: SETTINGS_SCOPE,
      // Each assistant's escalation list, from its own file. Stored and ordered; nothing reads it yet, so it changes
      // no wake and hands nothing over. An empty list is the normal state and is drawn as one.
      escalateTo: Object.fromEntries(this.assistants.map((a) => [a.id, (this.profileOf(a.id).escalateTo || []).slice()])),
      // THE RETIRED PER-ASSISTANT FRAME, and only until the migration has run. The pane's frame is the PANEL's own
      // setting now (`settings.dockMode`, out of config.json), and the page reads that one key for every
      // assistant's pane. This map is what a file written by the older build still carries — what the page's
      // one-time migration reads — and it is empty on a panel that never had one and for ever after the General
      // route has written the panel key (`retireDockField`).
      dock: { ...(this.dockLegacy || {}) },
      // The aggressive-mode toggle: whether the profile is holding the settings, which controls it holds,
      // and how many saved values a switch-off will put back (and how many absent keys it will delete).
      aggressive: this.aggressiveState(),
      rules: this.rules,
      // Every watch, each with the assistant it belongs to RESOLVED for this answer. The resolution is a read, not
      // a write: a legacy record with no owner is still stored exactly as it was (see `watchOwnerOf`), and the page
      // groups the Watches tab on this field. #1's own records gain the field here too — one list, one owner per
      // row, is what lets the tab say whose watch it is instead of guessing from the thread.
      watches: this.watches.map((w) => ({ ...w, assistantId: this.watchOwnerOf(w) })),
      notes: this.notes,
      // The pad cap, so the Pad tab can say "n/1,200" without a second copy of the number in public/.
      notesCap: NOTES_CAP,
      charter: charterMeta,
      // The role library and the assistants that run from it. Metadata only: a charter is up to 20 KB and the board
      // repaints on every event, so the Role tab fetches the text of the one it is showing.
      roles: this.rolesList(),
      assistants: this.assistantList(charterMeta),
      // Every open alert, each with the assistant it belongs to RESOLVED for this answer — the same shape the watches
      // list above uses. A record fired since the split already says so; a legacy one has no stamp, and the resolution
      // is a READ (`alertOwnerOf`): the store keeps exactly what it holds, and the page can filter on one field
      // without guessing from the thread or from the spawn card's own ask.
      alerts: this.alerts
        .filter((a) => a.status === "open")
        .sort((a, b) => String(b.at).localeCompare(String(a.at)))
        .map((a) => ({ ...a, assistantId: this.alertOwnerOf(a) })),
      // Spawn cards are counted apart from that list. They are the reader's own pending act rather than a
      // notice — one press either cuts a worktree or does nothing — and a card that never became a worker is
      // invisible everywhere else on the board, so it gets its own number on its own badge.
      spawnCards: this.spawnCardState(),
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
      // The SWEEP budget, named for what it covers: this is the class the hourly cap may refuse, and the page says so
      // ("sweep wakes / hour") so nobody reads it as a cap on events.
      sweeps: { lastHour: wakes.length, limit: this.settings.maxWakesPerHour },
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
      assistantThread: this.threadOf(PRIMARY_ASSISTANT),
      // Every assistant's own thread, for the group labels: an entry filed under `panel-assistant-2` is that
      // assistant's turn, not a worker's thread with an odd name. The threads a hard restart left behind stay in
      // the list — the transcript on them is still this assistant's, and its age is what makes the board readable.
      assistantThreads: this.assistantThreads(),
      // WHOSE message this is: the run's own stamp first (the assistant that started it), then the thread's owner,
      // then Assistant #1 — the order the split's brief states, and the same #1 fallback every other legacy read
      // uses. A stamp naming an assistant this panel does not hold is not an owner.
      ownerOf: (job, thread) => {
        const stamped = String(job?.assistantId || "").trim();
        if (stamped && this.assistants.some((a) => a.id === stamped)) return stamped;
        return this.assistantIdForThread(thread) || PRIMARY_ASSISTANT;
      },
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

  // Milliseconds since the epoch on the injected clock (see the constructor). The spawn watchdogs are its only
  // readers: they are the two facts this module judges in minutes, and the two a test has to move.
  nowMs() {
    const t = Number(this.clock());
    return Number.isFinite(t) ? t : Date.now();
  }

  // An alert's `at`, on the same clock the watchdogs judge it by. Production reads Date.now either way; a test
  // that moves the clock moves the timestamp with it, so "two minutes old" means one thing in this module.
  atIso() {
    return new Date(this.nowMs()).toISOString();
  }

  // ---- the clock ----------------------------------------------------------------------------

  start() {
    if (this.timer) return;
    const every = Math.max(2, num(this.settings.seconds, 5)) * 1000;
    this.timer = setInterval(() => this.tick(), every);
    this.timer.unref?.();
    // A card whose deadline was recorded by an earlier process is armed again here, before the first pass:
    // the panel may boot with the sentry switched off, and a spawn card is the one thing that must not wait
    // for a clock the reader turned off.
    this.rearmSpawnWatches();
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
    // EVERY assistant's own turn is the one job the sentry never looks at — `evaluate()` skips every assistant
    // thread, not one. A hung turn is therefore worse than a hung worker: `assistantLive()` is true for it, so every
    // future wake for THAT assistant sits in `pendingWake` behind it. Each assistant's turn is judged at ITS OWN
    // quiet window and stopped when it has produced nothing for four of them; the queued wake goes out when the stop
    // lands. Scanning only Assistant #1's thread was how #2 and up could hang for ever with nobody to notice.
    let stalled = null;
    const stalledTurns = [];
    const board = (() => {
      try {
        return this.jobs.list() || [];
      } catch {
        return []; // a store that cannot answer is a pass with nothing to judge, not a crash in the watchdog
      }
    })();
    for (const rec of this.roster()) {
      const mine = board.find((j) => j && String(j.thread || "") === String(rec.threadId) && isLive(j));
      if (!mine) continue;
      const lastLine = (mine.lines || []).slice(-1)[0];
      // The turn's clock. A card with no line AND no readable start has nothing to measure: falling back to `now`
      // invented a fresh clock, so a hung turn read as busy for ever and the watchdog never fired. Such a card is left
      // unjudged (the pass has no fact to judge it by), never given a start it did not have.
      const lineAt = typeof lastLine?.at === "number" ? lastLine.at : Date.parse(lastLine?.at || "") || 0;
      const startAt = Date.parse(mine.startedAt || "");
      if (!lineAt && !Number.isFinite(startAt)) continue;
      const quiet = Date.now() - (lineAt || startAt);
      const limit = Math.max(300_000, num(this.settingsFor(rec.id).quietSeconds, this.settings.quietSeconds) * 1000 * 4);
      if (!(quiet > limit)) continue;
      if (!stalled) stalled = mine.id;
      stalledTurns.push({ assistantId: rec.id, thread: rec.threadId, turnId: mine.id });
      this.journalAdd(
        "stalled",
        rec.threadId,
        `${rec.name || rec.id}'s turn ${mine.id} produced nothing for ${minutes(quiet)}; stopping it so the board is not blocked`,
      );
      Promise.resolve(this.jobs.stop?.(mine.id)).catch((err) =>
        this.journalAdd("stalled", rec.threadId, `could not stop turn ${mine.id}: ${String((err && err.message) || err)}`),
      );
      this.wake(
        `your last turn produced nothing for ${minutes(quiet)} and was stopped — say where it had got to, and whether anything on the board needs a look now`,
        null,
        "resume",
        // The turn that stalled is THIS assistant's, so the resume is addressed to it; the ladder still moves it if
        // that assistant's last run reads failed by the time it is queued.
        { assistantId: rec.id },
      );
    }
    return { timer: Boolean(this.timer), restarted, stale, stalled, stalledTurns };
  }

  // A restart is the one moment nothing else notices: `jobs.load()` leaves a live card running until the gateway
  // has been asked, and the sentry only ever looks at *worker* threads. So on boot — and again once the boot
  // reconcile has an answer — if the assistant died mid-thought, wake it once with that fact. A clean restart (its
  // last turn finished) costs nothing, and a card still waiting for the gateway does not spend the one resume.
  resumeAfterRestart() {
    if (!this.settings.enabled || this.resumed) return null;
    // The thread #1's turns run on NOW: after a hard restart the old thread's interrupted card is history, and
    // resuming it would wake the assistant about work it has deliberately left behind.
    const thread = this.threadOf(PRIMARY_ASSISTANT);
    const mine = this.jobs.list().filter((j) => j.thread === thread);
    // `list()` is newest-first on this board (the store sorts for the page), so the newest turn is found by
    // its clock, not by its position — taking the last element picked the oldest turn and resumed nothing.
    const last = mine.reduce((a, b) => (!a || Date.parse(b.startedAt || 0) > Date.parse(a.startedAt || 0) ? b : a), null);
    // `running` is not a verdict: a restored card waiting for the gateway may still come back re-attached. Do not
    // spend the one resume on it — the post-reconcile call asks again, and only a settled `interrupted` wakes.
    if (!last || last.status !== "interrupted") return null;
    this.resumed = true;
    const age = minutes(Date.now() - Date.parse(last.startedAt || ""));
    this.resumedTurn = last.id;
    this.journalAdd("resumed", thread, `the panel restarted while turn ${last.id} was running${age ? ` (started ${age} earlier)` : ""}`);
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
  async wakeAfterRestart(interrupted = [], { target = "gateway", proof = null, reason = "", requested = null, detected = false, recordId = null, reattached = [] } = {}) {
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
          // `stage: "restart"` is the pid that never moved: the gateway that answered was never restarted, so
          // pointing the reader at the provider key would send them to look at the wrong thing.
          : proof.stage === "restart"
            ? `  proof FAILED: ${proof.reason || "the gateway process never changed"} — the gateway the board is talking to is the one it was talking to before, so nothing was restarted.`
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
    // The digest this wake carries is built when the turn starts, and it advertises every debt still owed. A
    // restart is exactly when those debts are looked at again, so the settle has to happen BEFORE the wake rather
    // than on the next sentry pass: on the 0.59.0 boot the pass settled three debts at 10:44:58 and the wake's own
    // turn still cut two trees at 10:45:08 from a digest that had already been read. `force` because a pass the
    // previous process ran 30 seconds before this boot must not throttle the one that matters.
    try {
      const skipped = await this.skipLandedReplays({ force: true });
      if (skipped.length) {
        lines.push(
          `  ${skipped.length} owed SPAWN line${skipped.length === 1 ? "" : "s"} settled before this wake — nothing was started for ${skipped.map((it) => it.turnId || "an unknown turn").join(", ")}.`,
        );
      }
    } catch (err) {
      this.onLog(`assistant: could not settle the spawn debt before the restart wake: ${String((err && err.message) || err)}`);
    }
    this.persist();
    this.emit();
    this.wake(lines.join("\n"), null, "restart", { force: true });
    return { target, ids, proof: proof || null, interrupted: list.length, reattached: resumedList.length, at: nowIso(), recordId };
  }
  tick() {
    this.lastTickAt = Date.now();
    try {
      const list = this.jobs.list();
      // One sentry, and it runs while ANY assistant is switched on: a board whose #1 is off but whose #2 is working
      // must still notice that #2's tree settled. Each rule below judges a run at the settings of the assistant that
      // owns it (see `evaluate`).
      if (this.assistants.some((a) => this.settingsFor(a.id).enabled)) {
        this.evaluate(list);
        this.checkWatches(list);
        // A turn of the assistant's own that nothing harvested (a restart mid-turn) is reconciled here, on the
        // sentry's own clock, from the lines the job store still holds.
        void this.checkCommandAudit(list).catch((err) =>
          this.onLog(`assistant: command audit failed: ${String((err && err.message) || err)}`),
        );
        // Before the spawn debt is escalated, settle the debts whose work already landed: a brief replayed onto a
        // tree main already holds is the boot that starts the same job twice. One git read per owed line, bounded
        // and throttled; it never starts anything. See `skipLandedReplays`.
        void this.skipLandedReplays().catch((err) =>
          this.onLog(`assistant: the landed-replay check failed: ${String((err && err.message) || err)}`),
        );
        // The third pass, and the only one about a claim the board cannot show: a SPAWN line that has become
        // neither a worker nor a card. See `checkSpawns`.
        this.checkSpawns(list);
        // The queue's quiet half: nothing of this assistant's has run for `queueIdleMinutes`, and its queue still
        // holds work. The settle trigger only fires when something ENDS; this is the failsafe for the row nothing
        // will ever settle. Its own catch, because a queue file that cannot be read must not stop the pass above.
        try {
          this.checkQueueIdle(this.nowMs(), list);
        } catch (err) {
          this.onLog(`assistant: the queue failsafe failed: ${String((err && err.message) || err)}`);
        }
        // The standing wake, for the assistants whose profile carries an interval (the Assistant Director's twenty
        // minutes). Same sentry, same clock: this is a read of the profile, not a second timer. Its own catch so a
        // cadence that cannot be read does not stop the rules above.
        try {
          this.checkCadence(this.nowMs());
        } catch (err) {
          this.onLog(`assistant: the cadence check failed: ${String((err && err.message) || err)}`);
        }
      }
      // Outside the `enabled` block on purpose: a spawn card on the board is a promise the panel made to the
      // reader, and "the assistant is switched off in Settings" is not a reason to let one sit unreported.
      this.checkSpawnWatches();
    } catch (err) {
      this.onLog(`assistant: tick failed: ${String((err && err.message) || err)}`);
    }
    // Eager completion is bookkeeping about what the board already holds, not a wake: a task whose thread settled
    // and whose PR reads MERGED is finished whether or not the sentry is switched on. It journals what it changed
    // and repaints the tab, and it never starts anything. See `sweepQueues`.
    //
    // Its own try, OUTSIDE the pass above, on purpose. Those are the reader's RULES; this is the board's bookkeeping.
    // A rule that throws used to take the sweep down with it — the one catch swallowed both, so every hold that had
    // stopped being true stayed parked until the next boot. A release is the one thing the tick can always afford:
    // a failed rule is logged, and the parked rows still go back.
    try {
      this.sweepQueues();
    } catch (err) {
      this.onLog(`assistant: the queue sweep failed: ${String((err && err.message) || err)}`);
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
  // `forceWake` exempts this alert's wake from the hourly budget. Only a settle asks for it: that notice is the
  // board's own news and no other rule carries it, so the budget must not be able to drop it.
  fired(rule, subject, { thread = null, turnId = null, title, detail, evidence = [], severity = "warn", draft = null, parked = false, choices = [], requestId = null, multiSelect = false, notice = "", terminal = null, forceWake = false, job = null, assistantId = null } = {}) {
    // Whose rules judge this alert and whose thread hears its wake. A caller that has the RUN hands it over, which is
    // the only way an alert about a worker in Assistant #2's tree can reach #2: `thread` alone is a worker thread and
    // belongs to no assistant at all. Without either hint the answer is #1, as every alert was before this.
    const owner = String(assistantId || "").trim() || (job ? this.assistantIdForJob(job) : null) || this.assistantIdForThread(thread) || PRIMARY_ASSISTANT;
    // The RULES are the run's assistant's: the level it set for this rule is about its own work. The RECEIVER is the
    // ladder's answer (`wakeTarget`): an alert stamped for a failed assistant routed its ASK press, and its wake, into
    // a thread that could not answer — the wake died at that thread's door. `wake()` asks the ladder again at the door,
    // so a roster that changed in between still gets the same guarantee.
    const route = this.wakeTarget(owner);
    const who = route.who;
    const settings = this.settingsFor(owner);
    const level = settings.rules[rule] || RULE_DEFS[rule]?.default || "alert";
    if (level === "log") {
      this.journalAdd(rule, thread, detail || title);
      return null;
    }
    const key = `${rule}|${subject}`;
    const now = this.nowMs();
    const recent = this.alerts.find((a) => a.key === key && (a.status === "open" || now - Date.parse(a.at) < settings.rearmSeconds * 1000));
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
      at: this.atIso(),
      status: "open",
      level,
      // WHICH assistant this alert is for, stamped at FIRE time for every alert — Assistant #1's included. It used to
      // be written only for an extra assistant, which left #1's alerts indistinguishable from the legacy records that
      // predate the split; the Alerts tab, its count and the spawn strip are filtered on this field, so #1 has to be
      // as nameable as #2.
      //
      // The OWNER, not the receiver: `who` is where the ladder routed the wake, and an alert about #2's failed turn
      // that #1 had to take is still #2's alert — the same answer a legacy record gets from its thread. The wake above
      // is routed by `wake()` again at its door, so this stamp never decides which thread hears it.
      assistantId: owner,
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
        const sent = this.wake(`[${rule}] ${title}${detail ? ` — ${detail}` : ""}${notice ? `\n${notice}` : ""}`, alert.id, rule, { force: forceWake, assistantId: who });
        // A REFUSED wake is not a delivery, so it must not keep the claim. `wake()` refuses at its own door (the
        // hourly budget for a sweep, an assistant switched off) and never queues anything; leaving the claim taken
        // made the next pass read this finish as already handed over and journal `wake-once` instead of waking —
        // the completion lost with no turn ever started (#69). Give back only the claim this finish made: a newer
        // turn's key on the same thread is not this caller's to erase.
        if (terminal && sent && sent.queued === false && (sent.refused === "budget" || sent.refused === "disabled")) {
          this.releaseTerminalClaim(terminal.thread, terminal.key);
        }
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

  // The other half of `terminalClaim`: a wake that was refused never handed the finish over, so the claim it took
  // has to go back or the next attempt reads the finish as delivered. Keyed exactly, so a later turn's claim on the
  // same thread survives a refusal that belongs to an earlier one.
  releaseTerminalClaim(thread, key) {
    const t = String(thread || "");
    const k = String(key || "");
    if (!t || !k || this.terminalWakes.get(t) !== k) return false;
    this.terminalWakes.delete(t);
    this.persist();
    return true;
  }

  // `now` is a parameter so a sweep can be driven at a chosen instant — the quiet rule's key is built from the run's
  // own silence, and proving that one unchanged run raises one alert needs two sweeps either side of a minute
  // boundary without waiting out the minute.
  evaluate(list, now = Date.now()) {
    const workers = list.filter((j) => !this.isAssistantThread(j.thread));
    const live = workers.filter(isLive);

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
          job: j,
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
          job: j,
          title: `the same failure ${err.count}×`,
          detail: `${label}: ${err.key}`,
          evidence: [
            { label: "repeats", value: String(err.count) },
            { label: "failure", value: clip(err.key, 140) },
          ],
          severity: "bad",
        });
      }

      // `age` moves with every sweep, so it can never be part of the subject: a last line with no
      // timestamp (the revive path pushes one) used to fall back to it, the key changed on every
      // pass, and the rearm dedupe in `fired()` could never match - one stuck run re-fired this
      // rule every sweep and, at `wake`, started a turn each time. A silence is identified by where
      // it started: the last line's own timestamp when it has one, the run's start when it does not.
      const lineAt = Number(lines.length ? lines[lines.length - 1].at : 0);
      const quietSince = Number.isFinite(lineAt) && lineAt > 0 ? lineAt : Date.parse(j.startedAt || "") || 0;
      const quietFor = quietSince ? now - quietSince : age;
      if (j.status === "running" && !j.question && quietFor >= this.settings.quietSeconds * 1000) {
        // The subject is the SILENCE, not the clock. Keyed on `Math.floor(quietFor / 60000)` it changed every
        // minute, so one unchanged run raised a fresh alert on the next sweep after each boundary and a `wake`
        // rule turned that into a second turn's worth of noise for the same fact (measured: 33m and 34m for one
        // run, same last line both times). Thread + turn + run id + the point the silence started - the run's own
        // last-output timestamp, or its start when that line carries none - is one silence however many sweeps see
        // it, and a genuinely new quiet period starts somewhere else.
        this.fired("quiet", `${j.thread}|${j.id}|${j.runId || ""}|${quietSince}`, {
          thread: j.thread,
          turnId: j.id,
          job: j,
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
            job: j,
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
          job: j,
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

        // ---- asked again, on the clock -------------------------------------------------------
        // A parked question is either answered or it is not; nothing about the run will change on its own,
        // so the panel keeps asking. Anchored to the LAST ask — the question's own `at` for the first
        // repeat, then the last re-ask — and never to a turn or to a sweep, so a five-second sentry
        // produces one reminder an hour rather than three hundred. `reaskQuestion` moves the count on the
        // wait the card and the room message already hold; this alert is that same entry, edited in place.
        const parkedAt = Date.parse(j.question.at || j.startedAt || "") || now;
        const lastAsk = Date.parse(open?.lastAskedAt || "") || parkedAt;
        // An answer on its way to the gateway is not an unanswered question: the marker is written by
        // Jobs.answerQuestion before its first await, and re-publishing here would tell the reader to
        // answer what they just answered (and move the count on a question that is about to close).
        const answering = this.jobs.questionAnswerInFlight?.(j.id, j.question.requestId) || false;
        if (open && !answering && now - parkedAt >= CLARIFY_REASK_AFTER_MS && now - lastAsk >= CLARIFY_REASK_EVERY_MS) {
          const askedAgain = this.jobs.reaskQuestion?.(j.id, j.question.requestId) || null;
          if (askedAgain) {
            // `asks` counts the question itself: 1 is the first ask, 2 the first re-ask. The title is left
            // alone so the alert's identity does not move; what moves is the count, the detail line, and
            // `at` — the entry is RAISED again, so it goes back to the top of the newest-first list the
            // reader scans. That is the re-ask: the same entry, back in front of them, saying how often.
            open.asks = (Number(open.asks) || 1) + 1;
            open.at = this.atIso();
            open.lastAskedAt = open.at;
            open.detail = `${label} is parked on a question · waiting ${minutes(waited)} · asked again (${open.asks}×, still nothing)`;
            this.journalAdd(
              "question-reask",
              j.thread,
              `“${clip(j.question.question, 120)}” — asked again (${open.asks}× over ${minutes(waited)})`,
            );
            this.persist();
            this.emit();
            // A wake is the READER's setting, not this clock's: `question` ships at `alert`, and a rule set
            // to `wake`/`act` gets one reminder an hour. `question` is not in SWEEP_WAKE_RULES, so when it
            // does wake, the hourly budget cannot refuse it. The level is read from the run's OWNER, the
            // same assistant `fired()` read it from above.
            const owner = this.assistantIdForJob(j);
            const level = this.settingsFor(owner).rules.question || RULE_DEFS.question?.default || "alert";
            if (level === "wake" || level === "act") {
              this.wake(
                `[question] still waiting on your answer: ${clip(j.question.question, 90)} — ${label} has been parked ${minutes(waited)}, asked again (${open.asks}×)`,
                open.id,
                "question",
                { assistantId: owner },
              );
            }
          }
        }

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
          job: j,
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
      const tree = normPath(jobTreePath(j) || "");
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
        job: group[0],
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
          job: j,
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
          job: j,
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
        const treePath = jobTreePath(j) || "";
        if (!treePath || !existsSync(treePath)) continue;
        // …and a path that is not a WORKTREE any more holds none of this worker's work. The panel evicts a tree and
        // leaves the empty directory behind; `git -C` inside it does not fail, it walks UP to the primary checkout
        // and answers with the reader's own branch and files — that is how "2 modified · 4 untracked — branch main"
        // was reported as a leftover for a tree that had been gone for hours. A row left in the store from before
        // the scan learned to refuse those paths must not resurrect it either, so the folder itself is asked
        // (lib/own-tree.js `treeOnDisk`) and the scan's own refusal is read as well. A husk is "tree gone (evicted,
        // directory left behind)", never a leftover.
        if (!treeOnDisk(treePath).there) continue;
        // …and a tree a LIVE run now occupies is not this worker's leftover any more. The sweep re-checks the
        // tree at sweep time, so a SPAWN IN into a just-finished tree read that new agent's own edits as the old
        // worker's abandoned work — observed four times on one tree, the counts rising 1 modified → 2 modified →
        // 2 modified + 1 untracked → 2 modified + 2 untracked as the second agent worked. `runningJobs()` is the
        // predicate: a tree a live run's cwd holds raises no leftover, which is the check standing rule 16 asks a
        // reader to make before re-issuing work into a tree. A tree no live run holds alerts exactly as before.
        if (this.jobs?.runInTree?.(treePath)) continue;
        const row = byPath.get(normPath(treePath));
        if (!row) continue;
        // The scan already answered the same question the line above asks (lib/scan.js sets `released` when the path
        // is not a tree of its own). Its row carries no counts, but a row written before that guard existed can
        // still be in the store, so both answers are required before a leftover is claimed.
        if (row.released) continue;
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
          job: j,
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
        job: last || null,
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

    // A run that has settled failed — the card's EXITED chip. The status is the run's own (the store's), never the
    // page's DOM, and `checkExit` takes each terminal key once; the threshold and the repair check live there. The
    // sweep is what makes the rule work even when the float is closed, and what picks the run up after a reload.
    for (const j of workers) {
      if (j.status !== "failed") continue;
      this.checkExit(j, now, workers);
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
        job: j,
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
      // WHOSE notice this is, read ONCE per watch and above BOTH branches below. A watch stamped with an owner is
      // that assistant's, and its notice goes there — the reader asked THAT assistant to keep an eye on the thread. An
      // unstamped (legacy) record keeps the routing it always had, which `fired` derives from the run's tree and then
      // its thread: a legacy watch on a worker in Assistant #2's tree still reaches #2. Read here rather than inside the
      // finished branch because the OVERDUE branch fires a notice too, and a `const` declared in the first branch is not
      // in scope in the second: every overdue watch threw `noticeFor is not defined` and filed nothing.
      const noticeFor = String(w.assistantId || "").trim() ? this.watchOwnerOf(w) : null;
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
          job: latest,
          ...(noticeFor ? { assistantId: noticeFor } : {}),
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
          job: latest || null,
          ...(noticeFor ? { assistantId: noticeFor } : {}),
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

  // ---- the default settle notice ------------------------------------------------------------
  //
  // A worker's run settling is the board's news, and it used to be nobody's: a run that ended `done` changed only
  // its row, because the sentry woke the assistant on watches and on trouble (a restart, a loop, silence, a
  // question) and never on a clean completion. Landed-ready work then sat unlanded until the reader happened to
  // look. A clean run now wakes the assistant once as it settles, with the completion payload — its final message
  // included — so the landing judgement is made on evidence instead of on the card's colour. The `failed` half is
  // the separate `exited` rule (`checkExit` below): same payload, different judgement, and a threshold of its own.
  //
  // Three ways that could become noise, and the guardrail for each:
  //   * the assistant's own turn is a run too, and waking on it would answer every wake with another wake,
  //     forever. The assistant's runs are marked at creation (`assistant: true`) AND carry `ASSISTANT_THREAD`, so
  //     the identification survives a thread constant that moves later.
  //   * a settled card is emitted several times (the tree measurement, a title landing, a reload) and several runs
  //     can settle at once. One terminal key is one settle, and everything ready at a flush is ONE alert and ONE
  //     wake.
  //   * a watch on that thread is the reader asking to be told. Its notice is the one they asked for, so the
  //     default one stays silent: one run never produces two notices.

  // A run of the assistant's own: marked at creation (`assistant: true`) AND carrying a thread one of the assistant
  // records names, so the identification survives a thread constant that moves later — and covers Assistant #2's
  // turns, which are the assistant's own too and must never be judged as a worker that stopped.
  isOwnRun(job) {
    return Boolean(job && (job.assistant === true || this.isAssistantThread(job.thread)));
  }

  // A run of a worker has ended `done`. Returns the terminal key it accepted, or null when there is nothing to
  // notice. A `failed` run is the `exited` rule's, below: it needs the thread's next turn rather than a landing
  // judgement, and keeping the two rules apart is what lets a reader tune them separately.
  noteSettle(job) {
    if (!job) return null;
    // The run is judged at ITS assistant's settings: a settle in Assistant #2's tree is news for #2 whether or not
    // #1 is switched on, and #1 being off must not silence it.
    if (!this.settingsFor(this.assistantIdForJob(job) || PRIMARY_ASSISTANT).enabled) return null;
    const status = String(job.status || "");
    // `done` only. `failed` is `checkExit`; `cancelled`/`interrupted` are the gateway's or the panel's own stop,
    // which the `interrupted` rule already reports with its own reasoning, and a live card has nothing to announce.
    if (status !== "done") return null;
    if (this.isOwnRun(job)) return null;
    const key = terminalKey(job);
    if (!key) return null;
    // A card that ended before this process started is the store's history. The panel boots holding every card it
    // had, and a sweep that re-emits one (a title arriving, a reload, the boot measurement) is not a fresh finish.
    const ended = Date.parse(job.endedAt || "");
    if (!Number.isFinite(ended) || ended < this.bootedAt) return null;
    if (this.settleSeen.has(key)) return null;
    this.settleSeen.set(key, Date.now());
    if (this.settleSeen.size > 400) this.settleSeen = new Map([...this.settleSeen].slice(-200));
    this.pendingSettles.set(String(job.id || key), { id: String(job.id || key), summary: job, at: Date.now() });
    this.armSettleFlush();
    return key;
  }

  armSettleFlush(delay = 150) {
    if (this.settleTimer) return;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.flushSettles();
    }, delay);
    this.settleTimer.unref?.();
  }

  // One pass over the settles waiting for their tree facts, and one notice for all of them. The 150 ms collection
  // is the same idea as `wake`'s: several runs ending together is one thing to read, not four.
  //
  // The job is re-read from the store rather than taken from the event's summary: the settle event is emitted
  // BEFORE the tree is measured (`jobs.settle`), and it is the measurement that writes the completion payload the
  // notice quotes. A notice that says "commits not measured" cannot answer whether a branch is ready to land.
  flushSettles(now = Date.now()) {
    if (!this.pendingSettles.size) return null;
    let fresh = new Map();
    try {
      for (const j of this.jobs.list() || []) if (j && j.id) fresh.set(String(j.id), j);
    } catch {
      fresh = new Map();
    }
    const ready = [];
    // The settles whose run was carrying a row of the same assistant's queue: they get the sweep as well as the
    // notice, and the sweep is fired AFTER the notice so the landing judgement leads the turn. Collected here,
    // before the watch check below, because a watch covering the thread is the reader's notice — it is not a
    // reason for the QUEUE to go unswept.
    const swept = [];
    let retry = false;
    for (const [id, held] of this.pendingSettles) {
      const job = fresh.get(id) || held.summary;
      const measuring = job.tree?.pending && now - Number(job.tree.at || held.at) < SETTLE_MEASURE_MS;
      if (measuring && now - held.at < SETTLE_QUEUE_MS) {
        retry = true;
        continue;
      }
      this.pendingSettles.delete(id);
      // Whose news this is decides whether it is news at all: one assistant switched off must not swallow another's
      // settle, and a queue that dropped the whole batch because #1 was off is how #2 never heard its own run end.
      const who = this.assistantIdForJob(job) || PRIMARY_ASSISTANT;
      if (!this.settingsFor(who).enabled) continue;
      // The queue's trigger, taken for the run's OWN assistant before any of the notice's silence rules below:
      // a watched settle, or one whose notice the batch already handled, is still a settle that carried a row.
      if (this.queueRowForJob(who, job)) swept.push({ job, who });
      // A watch on this thread is the reader's own notice, and it is about to say the same thing. Recording the
      // settle above is what keeps the re-emit that follows the watch from firing it afterwards.
      if (this.watches.some((w) => w.thread === job.thread && w.state !== "done")) {
        this.journalAdd("settle-watch", job.thread || null, `${nameOf(job)} settled — a watch covers this thread, so its notice is the watch's and this one stays unsent`);
        continue;
      }
      ready.push(job);
    }
    if (retry) this.armSettleFlush(this.settleRetryMs);
    // The notice first, then the sweep. Both are `wake()` calls in the same tick, so the panel's 150 ms coalescing
    // hands the assistant ONE turn carrying both bullets — one settle is one wake even when it is two rules.
    const filed = ready.length ? this.fireSettles(ready) : null;
    const sweeps = swept.map(({ job, who }) => this.fireQueueSweep(job, who)).filter(Boolean);
    if (filed) return filed;
    return sweeps.length ? (sweeps.length > 1 ? sweeps : sweeps[0]) : null;
  }

  // The one alert (and so the one wake) for everything that settled in a flush.
  fireSettles(runs) {
    // One alert per ASSISTANT. A settle is news for the assistant that OWNS the tree it happened in, and a batch that
    // mixed two assistants' runs would be one wake on one thread about another assistant's work -- which is exactly
    // how a second assistant's tree settled in silence while Assistant #1 was handed the report and the next turn.
    const byWho = new Map();
    for (const job of runs) {
      const who = this.assistantIdForJob(job) || PRIMARY_ASSISTANT;
      if (!byWho.has(who)) byWho.set(who, []);
      byWho.get(who).push(job);
    }
    const filed = [];
    for (const [who, group] of byWho) {
      const alert = this.fireSettleGroup(group, who);
      if (alert) filed.push(alert);
    }
    return filed.length > 1 ? filed : filed[0] || null;
  }

  // One assistant's half of a settle batch: the rule LEVEL is its own, the alert is stamped with it, and the wake
  // goes to its thread.
  fireSettleGroup(runs, who = PRIMARY_ASSISTANT) {
    const level = this.settingsFor(who).rules.settle || RULE_DEFS.settle?.default || "alert";
    // The claim is taken where the WAKE is decided, exactly as `fired` does it for a terminal alert: a rule the
    // reader left at `alert` or `log` never spends it, so a watch closing later can still be the one that wakes.
    const walked = [];
    for (const job of runs) {
      if ((level === "wake" || level === "act") && !this.terminalClaim(job.thread, terminalKey(job))) continue;
      walked.push(job);
    }
    if (!walked.length) return null;
    const payloadOf = (j) => j.completion || null;
    const wordOf = (j) => payloadOf(j)?.word || wordForStatus(j.status);
    const one = walked.length === 1 ? walked[0] : null;
    const title = one
      ? `${nameOf(one)} ended ${wordOf(one)}`
      : `${walked.length} runs settled: ${clip(walked.map((j) => `${nameOf(j)} ${wordOf(j)}`).join(", "), 220)}`;
    // The wake reads `[rule] title — detail`, so the detail carries only what the title does not: why it ended that
    // way and what the branch now holds. One run repeats nothing; a batch has to name each of them.
    const detail = one
      ? clip(`${payloadOf(one)?.reason ? `${payloadOf(one).reason} — ` : ""}${payloadOf(one) ? commitsLine(payloadOf(one)) : "commits not measured"}`, 600)
      : clip(
          walked
            .map((j) => {
              const p = payloadOf(j);
              return `${nameOf(j)} ended ${wordOf(j)}${p?.reason ? ` — ${p.reason}` : ""}; ${p ? commitsLine(p) : "commits not measured"}`;
            })
            .join(" · "),
          900,
        );
    // The notice is the thing the assistant decides on: the worker's own final message, what its tree holds, and
    // the report it wrote, once per run. This is the same payload a watch carries, for the same reason — kept
    // verbatim (a clip would flatten the block's own lines into one unreadable sentence).
    const noticeText = walked
      .map((j) => (payloadOf(j) ? renderCompletionNotice(payloadOf(j)) : `completion — ${nameOf(j)} ended ${wordOf(j)} (no payload was measured)`))
      .join("\n\n");
    const notice = noticeText.length > 16_000 ? `${noticeText.slice(0, 16_000)}\n… (the batch's remaining payload was cut)` : noticeText;
    const evidence = one
      ? completionEvidence(payloadOf(one))
      : walked.map((j) => ({
          label: clip(nameOf(j), 40),
          value: clip(`${wordOf(j)}${payloadOf(j) ? ` · ${commitsLine(payloadOf(j))}` : ""}`, 140),
        }));
    return this.fired("settle", walked.map((j) => j.id).join(","), {
      thread: one ? one.thread : null,
      turnId: one ? one.id : null,
      title,
      detail,
      evidence,
      severity: walked.some((j) => wordOf(j) !== "normal") ? "warn" : "info",
      notice,
      // A settle is exempt from the hourly wake budget. That budget exists to stop a noisy board spending every
      // turn, and every rule it gates (quiet, loop, failure-streak, watch) has a sibling notice or a later sweep
      // that carries the same fact. A run's finish is a single event with no second chance: left budgeted it was
      // refused with `wake-suppressed: rate limit reached`, so a settle was dropped and nobody saw it. The failed
      // run is exempt for the same reason; `checkExit` is where that one goes out.
      forceWake: true,
      // Whose news this is: the tree's owner, or the run's stamp. The wake, the rule level and the alert's own
      // `assistantId` all follow from this one line.
      assistantId: who,
    });
  }

  // ---- the queue sweep ------------------------------------------------------------------------
  //
  // A finished run answers two different questions and used to answer only the first: `settle` asks "is this
  // branch ready to land", and nothing asked "does the row that run carried now read true". So a worker could end
  // `done` under a row still reading `running`, and a queued row's work could land under a row nobody closed, until
  // a person read the tab. These four methods are the queue's half: whose row a settled run was carrying, the
  // sweep that settle owes, and the failsafe for the row nothing will ever settle.

  /**
   * The row of THIS assistant's queue a run was carrying, or null. The link is the THREAD the cut wrote
   * (`linkTaskRun`): `threads` holds every agent that has carried the row, so a re-queued row whose latest run is
   * this one still answers, and the worktree is the fallback for a row whose thread the store has since forgotten
   * (a tree re-run on a new thread is still the same row). A row already `done` answers null: its work has been
   * closed by someone, and waking the assistant to sweep a queue that no longer holds it is noise.
   */
  queueRowForJob(who, job) {
    if (!job) return null;
    const rec = this.assistantRecord(who);
    if (!rec) return null;
    let out = null;
    try {
      out = readQueueFile(this.queuePathOf(rec));
    } catch {
      return null; // a queue that cannot be read is not evidence that a row exists
    }
    const open = (out.tasks || []).filter((t) => String(t.state || "") !== "done");
    if (!open.length) return null;
    const thread = String(job.thread || "").trim();
    if (thread) {
      const byThread = open.find((t) => taskThreads(t).includes(thread));
      if (byThread) return byThread;
    }
    const tree = normPath(jobTreePath(job));
    return tree ? open.find((t) => normPath(t.worktree) === tree) || null : null;
  }

  /**
   * The rows of one assistant's queue that still need a decision (queued, running or parked). A read.
   *
   * A MANUAL PARK IS NOT OPEN WORK. `manual` is the one hold with nothing the panel can test (`queue.js`
   * `holdState`): no thread, job, row or path becomes false, so nothing will ever end it and no sweep can act on
   * it. Counting it as open made the idle failsafe and the queue's own look fire every `queueIdleMinutes` on a
   * queue whose only rows were the reader's parks, each turn spending a run to answer that the queue is clean. A
   * park that NAMES something (a blocker row, a thread, a job, a path) stays open: that is the row a sweep can
   * still unpark, which is the half of the four checks a park exists for.
   */
  openQueueRows(who) {
    const rec = this.assistantRecord(who);
    if (!rec) return [];
    try {
      return (readQueueFile(this.queuePathOf(rec)).tasks || []).filter(
        (t) => String(t.state || "") !== "done" && (String(t.state || "") !== "parked" || holdIsTestable(t.hold)),
      );
    } catch {
      return [];
    }
  }

  /**
   * The sweep one settle owes: a run that carried a row of this assistant's queue ended `done`. One sweep per
   * settle, keyed on the settle's JOB ID — not on the terminal key, because the row asked for the job id and a
   * re-emitted card (its tree measurement, a title landing, a reload) must not read as a second finish.
   *
   * A `failed` run is not this rule's: it has the `exited` assessment, and the row is judged there (or by the idle
   * failsafe once the failure has stopped anything from running). The run's final message is NOT restated here —
   * the settle notice in the same turn carries it, and a sweep that repeats a 16 KB payload is a turn spent
   * reading rather than sweeping.
   */
  fireQueueSweep(job, who = PRIMARY_ASSISTANT) {
    if (!job?.id) return null;
    const key = `${who}|${job.id}`;
    if (this.queueSweepSeen.has(key)) return null;
    const task = this.queueRowForJob(who, job);
    if (!task) return null;
    this.queueSweepSeen.add(key);
    if (this.queueSweepSeen.size > 400) this.queueSweepSeen = new Set([...this.queueSweepSeen].slice(-200));
    const payload = job.completion || null;
    const word = payload?.word || wordForStatus(job.status);
    return this.fired(QUEUE_SWEEP_RULE, `settle|${key}`, {
      thread: job.thread,
      turnId: job.id,
      job,
      title: `#${task.id} ${clip(task.title, 70)} — the run on its row settled`,
      detail: `${nameOf(job)} ended ${word}; ${payload ? commitsLine(payload) : "commits not measured"} — sweep the queue`,
      evidence: [
        { label: `#${task.id}`, value: clip(`${task.state} · ${task.title}`, 140) },
        ...(payload ? completionEvidence(payload).slice(0, 3) : []),
      ],
      severity: "info",
      // Whose news this is: the run's own assistant. Its rule level, its wake, its queue.
      assistantId: who,
    });
  }

  /**
   * The idle failsafe, on the sentry's clock. `settle` can only fire when something ENDS; this is for the board
   * that has gone quiet with work left on it — a blocked row whose blocker closed somewhere else, a SPAWN line
   * that never became a run, a row whose worker died before the panel saw it. For each assistant: no live run of
   * its own for `queueIdleMinutes` (default 30) AND a queue that still holds an open row is one sweep, and the
   * clock restarts so the cadence is N minutes rather than every pass.
   *
   * Three facts this method exists to keep:
   *   - a run that IS live is the clock. The failsafe cannot open a second turn on a thread that already has one,
   *     and a board with a worker going has not gone quiet;
   *   - 0 turns the TIMER off (the settle trigger is the rule's level, not this clock), and an assistant whose
   *     queue has nothing open is not woken to be told it is empty — the clock resets instead;
   *   - it is an EVENT, not a sweep (`queueIdleMinutes` is not in `SWEEP_WAKE_RULES`), so the hourly wake budget
   *     cannot drop the one notice whose whole job is to happen when nothing else does.
   *
   * `now` and `list` are parameters so a test can drive it at a chosen instant and with a chosen board, exactly as
   * `evaluate` takes its own clock.
   */
  checkQueueIdle(now = Date.now(), list = null) {
    const minutes = Math.max(0, Number(this.settings.queueIdleMinutes) || 0);
    if (!minutes) return null; // 0 is "the timer is off"
    let jobs = list;
    if (!jobs) {
      try {
        jobs = this.jobs.list() || [];
      } catch {
        jobs = [];
      }
    }
    // Which assistant each live run belongs to, asked once per pass: `assistantIdForJob` reads the owner store, and
    // a per-assistant loop over every card would ask it once per card per assistant.
    const live = jobs.filter(isLive).map((j) => this.assistantIdForJob(j) || PRIMARY_ASSISTANT);
    const out = [];
    for (const rec of this.roster()) {
      const who = String(rec.id || PRIMARY_ASSISTANT);
      if (!this.settingsFor(who).enabled) continue;
      if (live.includes(who)) {
        // A live run is the clock: the moment it is seen, the window starts again from it.
        this.queueIdleAt.set(who, now);
        continue;
      }
      if (!this.queueIdleAt.has(who)) this.queueIdleAt.set(who, this.bootedAt);
      const since = this.queueIdleAt.get(who);
      if (now - since < minutes * 60_000) continue;
      const open = this.openQueueRows(who);
      // The window is taken either way: a queue with nothing open is not "quiet with work left", and waking on it
      // every N minutes would be a timer for a tab that is already correct.
      this.queueIdleAt.set(who, now);
      if (!open.length) continue;
      const alert = this.fired(QUEUE_SWEEP_RULE, `idle|${who}|${new Date(now).toISOString()}`, {
        thread: rec.threadId || null,
        title: `nothing has run for ${minutes} min — ${open.length} row${open.length === 1 ? "" : "s"} still open`,
        detail: `no live run of ${rec.name || who} for ${minutes} mi${minutes === 1 ? "nute" : "nutes"}; its queue holds ${open.map((t) => `#${t.id}`).join(", ")} — sweep it before the board goes any quieter`,
        evidence: open.slice(0, 8).map((t) => ({ label: `#${t.id}`, value: clip(`${t.state} · ${t.title}`, 140) })),
        severity: "info",
        assistantId: who,
      });
      if (alert) out.push(alert);
    }
    return out.length ? (out.length > 1 ? out : out[0]) : null;
  }

  /**
   * The standing wake, on the sentry's own clock. Two things can supply an assistant's interval: its profile's
   * `wakeEveryMinutes` (the Assistant Director's twenty minutes, and the job of READING every queue whether or not
   * one holds anything), and the queue itself. The interval lives in the profile (lib/assistant/profile.js) and this
   * method is the only reader of it, so there is no second timer to drift from the sentry or to survive an assistant
   * that was removed.
   *
   * A NON-EMPTY QUEUE IS ITS OWN CADENCE. A queue sweep used to be armed only by a run SETTLING, and a settle is a
   * door that opens only when something ends: an assistant that holds a queued row and has nothing of its own
   * running (never woken yet, or every run already over) had nothing to open it, so the row was never read. The
   * queue is therefore a clock of its own: an open row gives the assistant `queueIdleMinutes` (or
   * `QUEUE_CADENCE_MINUTES` when that failsafe is switched off), and the wake carries the queuesweep rule, so the
   * four checks come with it.
   *
   * Facts this method keeps:
   *   - a live turn of that assistant IS the clock: the cadence cannot open a second turn on a thread that has one,
   *     and the moment it is seen the window starts again from it;
   *   - 0 is off for the STANDING look, and an assistant that has never been given a number is not woken to be told
   *     nothing is happening. It does not silence the queue's own look, because a queue with work in it must never
   *     have no clock at all;
   *   - the clock resets when the wake goes out, so the cadence is every N minutes rather than every pass;
   *   - the queue file is read only once the window has elapsed, so the sentry's five-second pass costs nothing
   *     between looks.
   *
   * `now` is a parameter so a test can drive it at a chosen instant, exactly as `checkQueueIdle` takes its own clock.
   */
  checkCadence(now = this.nowMs()) {
    const out = [];
    // The reader's window for the idle failsafe, which is also the queue's window here. 0 turns the failsafe off,
    // and the floor under it is the queue's own default: the two knobs then cannot leave a queue with no clock.
    const idle = Math.max(0, Number(this.settings.queueIdleMinutes) || 0);
    for (const rec of this.roster()) {
      const who = String(rec.id || PRIMARY_ASSISTANT);
      const every = Number(this.profileOf(who).wakeEveryMinutes) || 0;
      if (!this.settingsFor(who).enabled) continue;
      if (this.assistantLive(who)) {
        // A turn is running: it is this assistant's own look, in progress. Both clocks start again from its end.
        this.cadenceAt.set(who, now);
        this.queueIdleAt.set(who, now);
        continue;
      }
      if (every) {
        if (!this.cadenceAt.has(who)) this.cadenceAt.set(who, this.bootedAt);
        if (now - this.cadenceAt.get(who) < every * 60_000) continue;
        this.cadenceAt.set(who, now);
        const reason =
          `[cadence] the ${every}-minute look — read every assistant's queue before anything else: a running row with no live job, ` +
          `a row parked past an hour, and a queued row nobody has started are the three to act on`;
        const sent = this.wake(reason, null, "cadence", { assistantId: who, exact: true });
        // A refused wake (switched off in between, or a budget the reader set to 0) is not a delivery, so it must
        // not be recorded as one. The clock still moved: the next pass is the next attempt, not a burst of retries.
        if (sent?.queued) {
          this.journalAdd("cadence", rec.threadId || null, `${every}-minute look queued for ${rec.name || who}`);
          out.push({ assistantId: who, minutes: every });
        }
        continue;
      }
      // THE QUEUE'S OWN LOOK, for an assistant with no standing interval. It shares `queueIdleAt` with the idle
      // failsafe deliberately: both answer "when did this queue last get read", both take the window before
      // reading, and the one that reaches it first is the turn - so a queue with the failsafe on is not swept
      // twice, and the sentry's five-second pass reads no queue file between looks.
      const minutes = idle || QUEUE_CADENCE_MINUTES;
      if (!this.queueIdleAt.has(who)) this.queueIdleAt.set(who, this.bootedAt);
      if (now - this.queueIdleAt.get(who) < minutes * 60_000) continue;
      this.queueIdleAt.set(who, now);
      const open = this.openQueueRows(who);
      if (!open.length) continue;
      // The queue's look is the queuesweep rule's, so the reader's own level for that rule decides the wake: a
      // sweep left at `alert` stays an alert on the board rather than becoming a turn every half hour.
      // `queuesweep` is an EVENT - it is not in SWEEP_WAKE_RULES - so the hourly budget cannot refuse the one wake
      // a stuck queue depends on.
      const level = this.settingsFor(who).rules[QUEUE_SWEEP_RULE] || RULE_DEFS[QUEUE_SWEEP_RULE]?.default || "wake";
      if (level !== "wake" && level !== "act") continue;
      const rows = open.slice(0, 6).map((t) => `#${t.id} ${t.state}`);
      const more = open.length > rows.length ? ` and ${open.length - rows.length} more` : "";
      const reason =
        `[cadence] the queue's own look — ${open.length} row${open.length === 1 ? "" : "s"} open (${rows.join(", ")}${more}) ` +
        `and nothing of ${rec.name || who}'s running, so no settle will wake it: a queued row nobody has started is the one to act on`;
      const sent = this.wake(reason, null, QUEUE_SWEEP_RULE, { assistantId: who });
      if (sent?.queued) {
        this.journalAdd("cadence", rec.threadId || null, `the queue's own look queued for ${rec.name || who} (${open.length} open)`);
        out.push({ assistantId: who, minutes, queue: open.length });
      }
    }
    return out.length ? (out.length > 1 ? out : out[0]) : null;
  }

  // A run that settled `failed`: the card's EXITED chip. This is the `exited` rule's detector, and it is a
  // STATUS check on the run the store holds — never a read of the page's DOM — so it works with the float closed,
  // after a reload and on a panel whose browser is not running at all.
  //
  // The transition is one terminal key: a failed card is re-emitted as its tree is measured, as a title lands and
  // on every reload, and `exitSeen` keeps all of those to the first sighting. A newer run on the same thread is a
  // repair that took the failure over: the card's EXITED is then history, and the repair's own end is what gets
  // reported. The threshold (`exitedSeconds`, default 30) is measured from the run's own `endedAt` — not from when
  // this process noticed it — so a restart does not restart the clock; the tree measurement is given the settle's
  // own ceiling before the notice is built from what is there. `0` wakes on the transition itself.
  checkExit(job, now = Date.now(), list = null) {
    if (!job || String(job.status || "") !== "failed") return null;
    const who = this.assistantIdForJob(job) || PRIMARY_ASSISTANT;
    if (!this.settingsFor(who).enabled) return null;
    if (this.isOwnRun(job)) return null;
    const key = terminalKey(job);
    if (!key || this.exitSeen.has(key)) return null;
    const ended = endedAtMs(job);
    if (!ended || ended < this.bootedAt) return null;
    // A newer run on the thread is a repair. It may be live (a repair turn on its way) or already finished; either
    // way the EXITED card is no longer the thread's latest word.
    let others = list;
    if (!others) {
      try {
        others = this.jobs.list() || [];
      } catch {
        others = [];
      }
    }
    let latest = null;
    for (const other of others) {
      if (!other || other.thread !== job.thread || other.id === job.id) continue;
      if (!newerTurn(other, job)) continue;
      if (!latest || newerTurn(other, latest)) latest = other;
    }
    if (latest) {
      this.exitSeen.add(key);
      return null;
    }
    // The tree facts are part of the notice; wait for the measurement, with the same ceiling the settle uses.
    if (job.tree?.pending && now - Number(job.tree.at || ended) < SETTLE_MEASURE_MS) return null;
    if (now - ended < Math.max(0, Number(this.settings.exitedSeconds) || 0) * 1000) return null;
    this.exitSeen.add(key);
    const payload = job.completion || null;
    const exitedFor = durationText(now - ended) || "a moment";
    const reason = payload?.reason ? `${payload.reason} — ` : "";
    return this.fired("exited", key, {
      thread: job.thread,
      turnId: job.id,
      job,
      title: `${nameOf(job)} is EXITED`,
      detail: `${reason}${exitedFor} at EXITED · ${payload ? commitsLine(payload) : "commits not measured"}`,
      evidence: [
        { label: "EXITED", value: `${exitedFor} (threshold ${this.settings.exitedSeconds}s)` },
        ...completionEvidence(payload),
      ],
      severity: "warn",
      notice: payload ? renderCompletionNotice(payload) : "",
      // One run's terminal result is one wake: a watch that already woke the assistant about this finish leaves
      // this alert filed and journalled, not a second turn.
      terminal: { thread: job.thread, key },
      forceWake: true,
    });
  }

  // ---- the assistant thread -----------------------------------------------------------------

  assistantLive(id = PRIMARY_ASSISTANT) {
    const thread = this.threadOf(id);
    return this.jobs.list().some((j) => j.thread === thread && isLive(j));
  }

  nameFor(thread) {
    const j = this.jobs.list().find((x) => x.thread === thread);
    return j ? nameOf(j) : thread;
  }

  // The board, as a TAIL: one small message per turn, appended to the assistant's transcript and handed to the run.
  //
  // WHAT IT WAS. The block this replaces was rebuilt in full on every turn it was due: every live run and the five
  // most recent, each with its prompt, its tree and its last tool calls, plus the panel's own notices. On a busy
  // board that is about 8 KB, and it was read again on the next sweep whether or not a row had moved. A block that
  // is rewritten every turn cannot say what CHANGED - it only says what is.
  //
  // WHAT IT IS NOW. One message per turn, one row per item: the item's stable id, a state token over the facts an
  // assistant acts on, the moment that state began, and a pointer at the sending turn (`assistant/thread/turn`). A
  // row whose token is new carries the item's one-line text; an unchanged row carries the same four fields and no
  // text, because the message that first carried that token is still above it in the transcript. The full text -
  // what the sending turn ended on, and its last few tool calls - is not in the digest at all: `readTurn(pointer)`
  // (lib/assistant/digest-tail.js) answers that on demand, which is what lets an assistant act on what moved and
  // fetch the words behind one row when it needs them.
  //
  // ONE MESSAGE, ONE TURN. `buildBoardTail` builds the message without writing it, `say()` appends it once the run
  // exists, and that pair is the contract: a turn that never started appends nothing. `boardForTurn` is the same
  // two steps for a caller that is itself a turn (a test, a tool).
  //
  // The panel's standing notices (a failed spawn, a card nobody pressed, a command the panel did not carry out)
  // ride below the rows: they are the board's own alarms, not items, and they keep their exact words because the
  // next turn has to be able to act on them.

  /** Where one assistant's digest transcript lives: beside its queue, its charter and its settings. */
  digestPathFor(rec) {
    return digestPathOf(path.dirname(this.file), rec?.id || PRIMARY_ASSISTANT);
  }

  /** Read every assistant's transcript at boot, so the first turn of a process continues the tail it left. */
  loadDigestTails() {
    for (const rec of this.assistants) {
      const messages = readDigestTail(this.digestPathFor(rec));
      const last = messages[messages.length - 1];
      if (last) this.boardSigs.set(String(rec.id), { message: last });
    }
    return this.boardSigs;
  }

  /** The next message, built and NOT written. The comparison cursor is this assistant's last message. */
  buildBoardTail(assistantId = PRIMARY_ASSISTANT) {
    const rec = this.assistantRecord(assistantId);
    const key = String(rec?.id || assistantId);
    const items = this.digestItems(key);
    const message = buildDigestMessage({
      items,
      at: this.atIso(),
      previous: this.boardSigs.get(key)?.message || null,
      // An empty board is a fact no row can carry: say it in the head, where the standing warning goes, so a turn
      // reading a tail with no rows is told the board is empty rather than left to infer it from silence.
      head: items.length ? this.digestHead() : ["- (no agents on the board)"],
      flags: this.digestNotices(),
    });
    return { message, text: message.text };
  }

  /** Append exactly one message, and move the cursor to it. */
  appendBoardTail(assistantId, message) {
    const rec = this.assistantRecord(assistantId);
    const key = String(rec?.id || assistantId);
    appendDigestMessage(this.digestPathFor(rec), message);
    this.boardSigs.set(key, { message });
    return message;
  }

  /**
   * One turn's board: the message is built, appended and returned. `origin` is every caller's existing argument
   * and is no longer read: the gate it fed existed to avoid resending a board that had not moved, and a tail
   * answers a board that has not moved with rows that carry no text.
   */
  boardForTurn(id = PRIMARY_ASSISTANT, origin = null) {
    const { message } = this.buildBoardTail(id);
    this.appendBoardTail(id, message);
    return message.text;
  }

  /**
   * The board's tail as the next turn would carry it, read-only: `state()` and the Prompt tab ask this and nothing
   * is appended. A real turn goes through `boardForTurn`, or through `say`, which is the same pair around the
   * create.
   */
  digest(assistantId = PRIMARY_ASSISTANT) {
    return this.buildBoardTail(assistantId).text;
  }

  /**
   * The READ TOOL behind a digest row's pointer: the sending turn's final message and its last few tool calls.
   *
   * It answers the turn the pointer NAMES, never the newest turn of that thread. That is the whole reason a row
   * carries a pointer rather than its text: a message can name the turn that sent an item three turns ago, and an
   * answer from "the latest" would be a different (and wrong) turn. A pointer whose thread does not match the
   * turn's own thread is refused rather than answered with a guess.
   */
  readTurn(pointer, { calls = 3 } = {}) {
    return readTurnAt(pointer, { jobs: this.jobs, calls });
  }

  /** One assistant's digest transcript, oldest first, as the page and the digest route read it. Read-only. */
  digestTail(assistantId = PRIMARY_ASSISTANT) {
    return readDigestTail(this.digestPathFor(this.assistantRecord(assistantId)));
  }

  /**
   * The items: the live runs and the five most recent, as the board has always listed them. A pointer names the
   * assistant turn that sent the run when the harvest wrote one at the cut (`origin.turnId`). A run the reader
   * started has no sending turn, so its pointer names the run itself, and the read tool still answers with that
   * turn rather than with the newest one on its thread.
   */
  digestItems(assistantId = PRIMARY_ASSISTANT) {
    const list = this.jobs.list().filter((j) => !this.isAssistantThread(j.thread));
    const live = list.filter(isLive);
    const recent = list.filter((j) => !isLive(j)).slice(0, 5);
    return [...live.slice(0, 10), ...recent].map((j) => this.digestItem(j, assistantId));
  }

  digestItem(j, assistantId = PRIMARY_ASSISTANT) {
    const sending = j.origin?.turnId ? String(j.origin.turnId) : null;
    return {
      id: String(j.id),
      state: itemStateOf(j),
      pointer: {
        assistant: j.assistantId || assistantId,
        thread: sending
          ? String(j.origin.turnThread || j.origin?.thread || this.threadOf(j.assistantId || assistantId))
          : String(j.thread || j.assistantId || assistantId),
        turn: sending || String(j.id),
      },
      text: itemTextOf(j, { now: this.nowMs() }),
    };
  }

  /** The one standing warning that belongs above the rows: the board is not a chat room. */
  digestHead() {
    const live = this.jobs.list().filter((j) => !this.isAssistantThread(j.thread) && isLive(j));
    const turning = live.filter((j) => j.status === "running" || j.status === "starting");
    return turning.length ? [LIVE_RUNS_LINE] : [];
  }

  /**
   * The panel's notices, as blocks, each only when it has something to say. These are not items and carry no token:
   * they are the board's alarms, and they are the one part of the digest a small model must not have to infer.
   */
  digestNotices() {
    const now = this.nowMs();
    const recent = (j) => now - Date.parse(j.at) < 15 * 60_000;
    const blocks = [];

    // A spawn that failed is the one fact the assistant cannot infer from the board: nothing appeared, so a small
    // model reads that as "still starting" and tells the reader it queued one. Say it outright.
    const failed = this.journal.filter((j) => j.kind === "spawn-failed" && recent(j)).slice(-3);
    if (failed.length) {
      blocks.push(
        [
          "Spawn attempts that FAILED - do not tell the reader a worktree was queued or started:",
          ...failed.map((f) => `- ${minutes(now - Date.parse(f.at))} ago: ${clip(f.text, 140)}`),
        ].join("\n"),
      );
    }
    // One step earlier than a failure: the card exists, the panel asked, and nothing was started. Nothing appeared
    // on the board either, so without this line the assistant reads the silence as "queued".
    const unstarted = this.journal.filter((j) => j.kind === "spawn-unstarted" && recent(j)).slice(-3);
    if (unstarted.length) {
      blocks.push(
        [
          "Spawn cards the reader has NOT started - do not tell the reader a worktree was queued or started:",
          ...unstarted.map((f) => `- ${minutes(now - Date.parse(f.at))} ago: ${clip(f.text, 140)}`),
        ].join("\n"),
      );
    }
    // One step further back than either: a command line the panel read and never carried out. The board cannot show
    // it, because nothing happened; a turn that wrote "TO ..." and had it dropped reads its own prose and believes
    // it acted.
    const unactioned = this.journal.filter((j) => (j.kind === "command-unactioned" || j.kind === "command-unparsed") && recent(j)).slice(-3);
    if (unactioned.length) {
      blocks.push(
        [
          "Command lines the panel did NOT carry out - do not report these as done, and say what is still owed:",
          ...unactioned.map((f) => `- ${minutes(now - Date.parse(f.at))} ago: ${clip(f.text, 140)}`),
        ].join("\n"),
      );
    }
    // The claim the board cannot show: a spawn card is a worker that has NOT started. Nothing on any agent's card
    // says so, because there is no job to draw.
    const cards = this.alerts.filter((a) => a.status === "open" && a.spawn);
    if (cards.length) {
      blocks.push(
        [
          `SPAWN CARDS WAITING FOR A CLICK (${cards.length}) - nothing has started; do not say a worker is running:`,
          ...cards.slice(-8).map((a) => {
            const wait = minutes(now - (Date.parse(a.at) || now));
            return `- card ${a.id} \u00b7 waiting ${wait} \u00b7 turn ${a.spawn.turnId || "unknown"} \u00b7 ${clip(a.title, 70)} \u00b7 asked: ${clip(a.spawn.prompt, 60)}`;
          }),
        ].join("\n"),
      );
    }
    // A line that produced neither a card nor a job. This is the charter's open question, and the one failure a
    // model cannot see anywhere else on the board.
    const lost = this.spawnIntents.filter((it) => it.outcome === "lost");
    if (lost.length) {
      blocks.push(
        [
          "SPAWN LINES THAT PRODUCED NOTHING - the turn wrote them and no worker and no card exists:",
          ...lost.slice(-5).map(
            (it) => `- turn ${it.turnId || "unknown"} \u00b7 ${it.existing ? "SPAWN IN" : "SPAWN"} ${clip(it.target, 60)} \u00b7 asked: ${clip(it.prompt, 60)}`,
          ),
        ].join("\n"),
      );
    }
    // A refusal the panel wrote at the cut. It is the one failure the board makes look like success: nothing was
    // started, so there is no card, no thread and no tree to draw.
    const refused = this.journal.filter((j) => j.kind === "spawn-refused" && recent(j)).slice(-3);
    if (refused.length) {
      blocks.push(
        [
          "SPAWN LINES THE PANEL REFUSED at the cut - nothing was started, and the row or the tree is still held:",
          ...refused.map((f) => `- ${minutes(now - Date.parse(f.at))} ago: ${clip(f.text, 160)}`),
        ].join("\n"),
      );
    }
    return blocks;
  }

  // What the assistant is told about itself, in the two halves a turn is built from.
  //
  // `before`, `directive` and `after` are the STANDING text: it does not depend on what moved this minute, and it is
  // the same bytes on every turn of a session (a rule edit, a settings change, a new project or a charter save moves
  // it). `turn` is the one gated block: the queue digest this wake carries, or nothing. `preamble()` is both halves
  // joined in the order a turn reads them, for every caller and test that asks for the whole briefing. `say()` hands
  // them to `jobs.create` SEPARATELY: the standing half becomes the run's system text (`instructions` on the POST) and
  // the turn half is appended to the question, which is what keeps the standing briefing out of the thread's
  // transcript on every wake.
  //
  // It is built for ONE assistant: the role it runs, its own rules and its own charter. That is the whole reason
  // the method takes an id — a preamble assembled from the class's fields would hand Assistant #2 whatever
  // Assistant #1 happens to hold, which is the mistake this feature exists to prevent.
  briefingParts(assistantId = PRIMARY_ASSISTANT, { queue = true, board = null, standing = true, changing = true } = {}) {
    const rec = this.assistantRecord(assistantId);
    // THIS assistant's own settings: autonomy, spawn mode, model and the rest are per assistant, and a preamble
    // built from the class's one object would tell Assistant #2 it may spawn at Assistant #1's setting.
    const s = this.settingsFor(rec?.id);
    const role = this.roleOf(rec);
    const rules = this.rulesFor(rec?.id);
    // WHICH twelve of them a turn is shown: the reader's hold their own places and the assistant's fill only what
    // is left, so a model that keeps writing rules for itself cannot push the reader's answers out of the window.
    const shownRules = briefingRules(rules);
    // THIS assistant's own scratchpad and its own watches. Both used to be the panel's one string and one unowned
    // list, so every assistant's turn read the same clipped notes and saw watches it never set — the defect this
    // block is split for. #1 reads its store's string and its own resolved watches, exactly as before.
    const notes = this.notesFor(rec?.id);
    const keeping = this.watchesFor(rec?.id).filter((w) => w.state !== "done");
    // One read of the profile for the default role prompt. There is no whitelist any more: the SPAWN switch is the
    // only gate, so this list is simply what the panel knows exists, capped to keep the preamble short.
    const own = this.profileOf(rec?.id);
    const known = this.getProjects();
    const projects = known.slice(0, 40);
    const hidden = known.length - projects.length;
    const spawnLine =
      s.spawn === "off"
        ? "You cannot create a worktree or start a worker in this panel — it is switched off. If asked, say so plainly and do not promise it."
        : s.spawn === "ask"
          ? "You can create a worktree and start a worker: write a SPAWN line, and it appears as a card the reader confirms with one click. Say that the card is ready rather than that the work has started."
          : "You can create a worktree and start a worker: write a SPAWN line and it starts immediately. Say that it has started, and give the worker's thread when the panel reports it.";
    // The Director's job is a different job, and its preamble says so in its own words rather than reusing the
    // manager's "start a worker to do it". It reads EVERY queue (the cross-queue briefing below), and its two
    // powers are the only lines it may write to change another assistant's work. `spawn: off` in its profile is
    // what makes the boundary a gate; this branch is what makes the turn know why.
    const director = role?.id === ASSISTANT_DIRECTOR_ID;
    // BUILD EACH HALF ONLY WHEN IT IS ASKED FOR, because rendering it advances a counter: `charterBriefing` bumps the
    // charter's send record and `boardForTurn` (at the call site) bumps the board's sweep tick. Rendering either twice
    // in one turn would record the first send and then hand the SAME turn the marker for text the model never saw.
    // `systemBriefing` passes `changing: false` (the system block is the constant half and carries neither),
    // `turnBriefing` passes `standing: false`, and only `preamble()` asks for both.
    // THE SECTIONS, NAMED, so the Prompt tab can draw what the turn is built from without a second
    // copy of these words. `before` is their concatenation, byte for byte; the names are the tab's
    // labels (lib/assistant/prompt-budget.js owns the labels and the caps).
    const identity = !standing ? [] : [
      director
        ? `You are ${rec.name}, the Assistant Director of this panel's board. You direct the other assistants; you are not a worker and you do not`
        : rec && rec.id !== PRIMARY_ASSISTANT
          ? `You are ${rec.name}, the assistant watching this panel's agent board. You are not one of the workers, and you do not`
          : "You are the assistant watching this panel's agent board. You are not one of the workers, and you do not",
      ...(director
        ? [
            "do work in a worktree yourself, and you never start a worker. Your job: wake every 20 minutes, read every",
            "assistant's queue before anything else, find the dead run, the row parked past an hour and the work nobody",
            "has started, then file the next action with the assistant that should carry it — or say the queues are clean.",
            "You have two powers and no more: QUEUE (a row in another assistant's queue) and MESSAGE (a turn on that",
            "assistant's thread). Say which assistant you chose and why. Keep replies short.",
          ]
        : [
            "do work in a worktree yourself. Your job: notice when an agent is stuck, looping or waiting on a person;",
            "answer a worker's question only when the answer is written down below; when asked to get something done,",
            "start a worker to do it. Otherwise say what you would send and leave it to the reader. Keep replies short.",
          ]),
    ];
    // The job title, in the reader's own words: a role is what makes two assistants different, and a turn that
    // cannot say which one it is running is a turn that answers the wrong assistant's question.
    const roleLine = !standing || !role ? [] : [`Your role: ${role.name} — ${role.description}`];
    // The short instruction a turn begins with. An assistant's own prompt (a file beside its charter) wins when
    // it has one; otherwise the PROMPT ON ITS ROLE is what rides, so a role's prompt is live for every assistant
    // that runs it rather than a field only a new assistant would ever see.
    const promptLines = !standing ? [] : String(own.prompt || "").trim()
      ? ["", "Your default role prompt (saved for this assistant — this is what you run on):", String(own.prompt)]
      : String(role?.prompt || "").trim()
        ? ["", `Your role's prompt (saved with the ${role.name} role — this is what you run on):`, String(role.prompt)]
        : [];
    const before = !standing ? [] : [...identity, ...roleLine, ...promptLines];
    // The queue's STANDING half — the directive, and the file it names. It never says a digest is coming: a wake
    // that skips the digest still carries this, and a sentence promising text that is not there is a lie the next
    // turn inherits. The directive is the first thing a turn reads, so it sits directly after the role prompt.
    const directive = !standing ? [] : [
      "",
      ...(director
        ? [
            "Read EVERY assistant's queue before the board, before the alerts and before anything you remember. The cross-queue briefing, when this turn carries it, is all of them, with the dead, parked and startable rows already marked. Your own queue is a log of what you directed, not a list of work for you.",
          ]
        : queueDirectiveLines(this.queuePathOf(rec))),
    ];
    // The TURN's half - the only part of the briefing that changes between turns, appended to the question rather
    // than to the standing text. It carries the queue digest when the wake's gate says it is due, the board's tail
    // message (one per turn) and the charter (its text or its marker).
    //
    // WHY THE BOARD AND THE CHARTER RIDE HERE AND NOT IN THE SYSTEM BLOCK: a provider's prefix cache reuses only the
    // bytes a request shares with the previous one, up to the first that moved, and a request is the system text
    // followed by the thread. The board appends a message every turn and the charter changes every
    // `CHARTER_RESEND_EVERY` turns, so while either sits at the head of the system text the prefix changes on a
    // schedule and nothing after it can be reused - measured on a live assistant thread, the first call of a turn
    // read 1,536 of 326,319 prompt tokens from cache (0.5%). Appended after the thread, a change costs only the
    // bytes it adds.
    const queueSection = !changing || !queue
      ? []
      : director
        ? this.crossQueueBriefing(rec?.id)
        : [
            "",
            "Read your queue first — before the board, before anything else. It is the list of work that is yours, and the digest below is its top.",
            ...this.queueBriefing(rec?.id),
          ];
    const boardSection = !changing ? [] : ["", "The board tail (one message this turn):", board || this.digest(rec?.id)];
    const charterSection = !changing ? [] : ["", ...this.charterBriefing(rec?.id)];
    const turn = [...queueSection, ...boardSection, ...charterSection];
    // ---- the standing half continued: everything that describes the job and the tools, and nothing that moves ----
    const restart = !standing ? [] : [
      "",
      // A restart is the case this block exists for. The panel keeps its runs in the gateway and re-attaches them
      // when it comes back, so a thread the queue names may be live even though this turn never saw it start — and
      // the digest's STALE is a fact about the job store, not about the gateway. The route is named because the
      // assistant can read it: /api/jobs is the panel's own answer for which threads have a run.
      "A restart re-attaches runs: the panel keeps its runs in the gateway and puts them back on their threads when it comes back, so a thread this queue names may already be live. Check /api/jobs for the threads the queue names before starting anything — a second run on the same files is the defect this block exists to prevent.",
      "",
      ...(director
        ? [
            "Your QUEUE and MESSAGE lines are not drafts: they are carried out when this turn ends. Autonomy describes replies to workers, which you do not write.",
          ]
        : [
            `Autonomy: ${s.autonomy === "draft" ? "draft only — nothing you write is sent to a worker until the reader clicks Send" : s.autonomy === "auto-safe" ? "auto-safe — a reply you mark TO a worker is sent; rule-derived drafts are not" : "auto — a draft with text is sent without waiting"}.`,
          ]),
      spawnLine,
      ...(director
        ? [
            "One turn per thread: never MESSAGE an assistant whose thread is live — the message would be refused, and the",
            "queue is where the news belongs until it finishes. Write nothing and let it end.",
          ]
        : [
            "One run per thread, one worker per tree: never write a TO line to a thread the digest lists as LIVE \u2014 a reply",
            "starts a SECOND run on the same files rather than steering the one that is going. Write nothing and let it finish.",
          ]),
      "",
    ];
    const projectsSection = !standing || s.spawn === "off" ? [] : [
      "Projects you can SPAWN in (name · path):",
      ...(projects.length ? projects.map((p) => `- ${p.name} · ${String(p.path).replace(/\\/g, "/")}`) : ["(none discovered yet)"]),
      ...(hidden > 0
        ? [`(${hidden} more project${hidden === 1 ? " exists" : "s exist"} on this panel — the list above stops at ${PROJECTS_BRIEFING_MAX} to keep this preamble short; you may spawn in any of them by name)`]
        : []),
      "",
    ];
    const rulesSection = !standing ? [] : [
      "Standing rules (written by the reader, plus any you added — trust these over your own guesses):",
      ...(shownRules.rules.length
        ? [
            ...shownRules.rules.map((r, i) => `${i + 1}. ${clip(r.text, RULE_BRIEFING_CHARS)}`),
            // The list is a window, not the whole store, and a turn that cannot see how much is behind it would
            // read twelve rules as every rule the reader has written.
            ...(shownRules.leftOut
              ? [`(${shownRules.leftOut} older rule${shownRules.leftOut === 1 ? "" : "s"} left out to fit the twelve)`]
              : []),
          ]
        : ["(none written down yet)"]),
    ];
    const notesSection = !standing ? [] : [
      "",
      `Notes${notes ? "" : " (empty)"}:`,
      // The clip is `NOTES_CAP` (lib/assistant/config.js) and is written as its number here: the pad's own test,
      // test/assistant-notes-cap.test.js, pins this line to the constant so the store cap and what a turn reads
      // cannot drift apart. The Prompt tab's budget reads the same constant.
      ...(notes ? [clip(notes, 1200)] : []),
    ];
    const watchesSection = !standing ? [] : [
      "",
      "Watches you are keeping:",
      ...(keeping.length
        ? keeping.slice(-WATCHES_BRIEFING_MAX).map((w) => `- [${w.thread}] ${clip(w.title, WATCH_TEXT_CHARS)}${w.minutes ? ` · deadline ${w.minutes}m` : ""}${w.state === "alerted" ? " · overdue" : ""}`)
        : ["(none)"]),
    ];
    // The board is the SECOND thing a turn reads and it is NOT standing text: the queue is what it may act on and
    // the board is what it may comment on, but the board appends a message every turn, and a block that grows at the
    // head of the system text is a prefix cache miss for every token of the thread behind it. It rides the turn half
    // (`turn` above); the grammar that talks about it, and the one line that explains a row, stay here.
    const grammarSection = !standing ? [] : [
      "",
      // One line, not a second charter. The reader switched this on in the header, and when it asks why the
      // assistant is being so talkative this sentence is the answer it can give back.
      ...(this.aggressive.on
        ? [
            "Aggressive mode is ON — the reader switched it on in its Settings tab. Spend the extra tokens: check every live card on every pass, keep each agent moving toward a done spot, and keep pushing until the fleet is waiting on something outside this board. That is why you are being woken so often; if the reader asks why you are so talkative, this is the reason, and you should say so plainly rather than blame the board.",
            "",
          ]
        : []),
      // The board's shape, once for the whole session: a tail is only readable if the row is. `tok` is the row's
      // state, so two rows with the same `tok` are the same news; `send` is the turn the row came from, and that
      // turn's final message and last tool calls are what the panel's read tool answers by that pointer.
      "The board arrives as a TAIL, one message a turn. A row is `#<id> tok=<state> at=<stamp> send=<assistant>/<thread>/<turn>`: a row whose tok differs from the message above it is the only kind with news, a row whose tok is the same is carried for the count, and only a changed row carries its text. The words behind a row live in the turn `send` names - the panel reads that turn back by its pointer - so do not expect the digest to repeat a prompt you did not just watch change.",
      "",
      ...actionGrammar(s, { director, consolidate: grantOf(rec).granted, assistantId: rec?.id || "" }),
    ];
    const closeSection = !standing ? [] : [
      "The charter is the long tier of your memory: the reasoning behind the rules, written down so a compaction cannot take it — read in full when this turn carries it, otherwise the marker in this turn's text names the sha of the text that was last sent and says it is unchanged. Add an entry when a standing answer changes or a long task closes, naming what changed — the panel dates it and prunes the oldest entries over the cap. Do not restate the board in it; that is the notes and the journal.",
      director
        ? "Never write that you ran a command or changed a file; you only read the queues and the board, file rows and message assistants — nothing else."
        : "Never write that you ran a command or changed a file; you only read this board, talk, and start workers when allowed.",
    ];
    const after = !standing ? [] : [...restart, ...projectsSection, ...rulesSection, ...notesSection, ...watchesSection, ...grammarSection, ...closeSection];
    // The named view of the same arrays. Every array above is concatenated in this order into `before`,
    // `directive`, `turn` and `after`, so a section here can never be text the turn does not carry; the Prompt tab
    // measures THESE rather than slicing the joined string back apart.
    const sections = [
      { key: "identity", half: "system", lines: identity },
      { key: "role", half: "system", lines: roleLine },
      { key: "prompt", half: "system", lines: promptLines },
      { key: "directive", half: "system", lines: directive },
      { key: "rest", half: "system", lines: restart },
      { key: "projects", half: "system", lines: projectsSection },
      { key: "rules", half: "system", lines: rulesSection },
      { key: "notes", half: "system", lines: notesSection },
      { key: "watches", half: "system", lines: watchesSection },
      { key: "grammar", half: "system", lines: grammarSection },
      { key: "close", half: "system", lines: closeSection },
      { key: "queue", half: "turn", lines: queueSection },
      { key: "board", half: "turn", lines: boardSection },
      { key: "charter", half: "turn", lines: charterSection },
    ];
    return { before, directive, turn, after, sections };
  }

  /**
   * The standing briefing, as the run's SYSTEM text: the role, its rules, the charter's place, the projects it may
   * spawn in and the action grammar. None of it depends on the question, and none of it moves on a schedule: it changes
   * only when the reader (or the assistant) edits a rule, the scratchpad, a watch, the role or the projects.
   *
   * THAT IS THE POINT OF THE SPLIT, and it is a caching one. `instructions` is the head of every request's prompt, and
   * a provider's prefix cache reuses only the bytes a request shares with the one before it. While the board's and the
   * charter's markers lived here they changed the head on a schedule - the board's message every turn, the charter
   * every `CHARTER_RESEND_EVERY` turns - so the whole thread behind them was re-read uncached on those turns. They
   * ride the turn half now (see `briefingParts`), and this method returns the same bytes turn after turn, which is
   * what makes the prefix reusable.
   *
   * It is NOT appended to the thread. `jobs.create` sends it as `instructions` on POST /v1/runs, which the gateway
   * applies as the run's ephemeral system prompt and never writes into the session's transcript, so a later turn does
   * not re-read it as a user message and a compaction does not re-ingest it.
   */
  systemBriefing(assistantId = PRIMARY_ASSISTANT) {
    const parts = this.briefingParts(assistantId, { queue: false, changing: false });
    return [...parts.before, ...parts.directive, ...parts.after].join("\n").trim();
  }

  /**
   * What this turn appends to the thread: the queue digest when the wake's gate says it is due, the board (its full
   * digest or its one-line marker) and the charter (its text or its marker). Not the standing text: nothing that does
   * not change between turns is repeated here, and nothing that changes between turns is left in the system block.
   */
  turnBriefing(assistantId = PRIMARY_ASSISTANT, { queue = true, board = null } = {}) {
    // `standing: false` on purpose: the turn half must not render (or advance) the standing half. See the note in
    // `briefingParts` about the two counters.
    const parts = this.briefingParts(assistantId, { queue, board, standing: false });
    return this.clipTurnBriefing(parts.turn.join("\n").trim(), assistantId);
  }

  /**
   * The turn half, cut to this assistant's `briefingBudgetChars`.
   *
   * A turn is the only text that costs anything per wake, and the cost is the whole request's input: measured on a
   * live panel the API calls ran p50 123,786 input tokens with p90 253,442, and each one is re-read on every call of
   * the turn. The budget is a CEILING, not a target — a turn that fits is sent byte for byte, so a panel with the
   * knob at 0 behaves exactly as before.
   *
   * The cut keeps the HEAD: the queue digest is the list of work the turn may act on, and it is written first (see
   * `briefingParts`), so a cut at a line boundary keeps the queue and drops the board's tail and the charter. The
   * sentence appended in its place says the text was cut and where the number lives, so a turn that answers "the
   * board is not in my preamble" has the reason in its own words instead of guessing. The marker is counted in the
   * budget: an over-budget turn never grows by explaining itself.
   */
  clipTurnBriefing(text, assistantId = PRIMARY_ASSISTANT) {
    const budget = Math.max(0, Number(this.settingsFor(assistantId).briefingBudgetChars) || 0);
    if (budget <= 0 || text.length <= budget) return text;
    const note = `\n(briefing cut at ${budget} chars — the queue is above this line; the board and charter below the cut were not sent. Settings → General → turn briefing budget.)`;
    const room = Math.max(0, budget - note.length);
    const head = text.slice(0, room);
    const at = head.lastIndexOf("\n");
    const kept = at > room * 0.6 ? head.slice(0, at) : head;
    return `${kept.trimEnd()}${note}`;
  }

  /**
   * The whole briefing in the order a turn reads it: the standing text, then the queue digest. This is the string the
   * page and the tests have always asked for, and it is what a turn would carry if it were appended whole. `say()`
   * does not use it: it hands the two halves to `jobs.create` separately (see `systemBriefing` / `turnBriefing`).
   */
  preamble(assistantId = PRIMARY_ASSISTANT, { queue = true, board = null } = {}) {
    const parts = this.briefingParts(assistantId, { queue, board });
    return [...parts.before, ...parts.directive, ...parts.turn, ...parts.after].join("\n").trim();
  }

  /**
   * The prompt as a budget: the measured size of every section this assistant's next turn carries, plus the three
   * turns the Settings -> Prompt tab draws (first of a session, ordinary, fourth wake). Read-only: it builds the
   * standing half with `changing: false` (so neither the charter's send record nor the board's sweep tick moves),
   * measures the turn blocks `say()` would build, and hands the numbers to ./assistant/prompt-budget.js, which owns
   * every cap. A picture of the prompt that advanced a counter would make the next real turn a marker for text
   * nobody had been sent.
   */
  promptBudget(assistantId = PRIMARY_ASSISTANT) {
    const rec = this.assistantRecord(assistantId);
    const s = this.settingsFor(rec?.id);
    const parts = this.briefingParts(assistantId, { queue: false, changing: false, standing: true });
    const chars = (lines) => (Array.isArray(lines) ? lines.join("\n").length : 0);

    // The queue block, exactly as `briefingParts` writes it for an ordinary assistant: the read-first line and the
    // digest. An empty queue is no block at all - there is nothing to gate.
    const queue = this.queueBriefing(rec?.id);
    const queueBlock = queue.length
      ? ["", "Read your queue first - before the board, before anything else. It is the list of work that is yours, and the digest below is its top.", ...queue]
      : [];
    // The board is the SAME block on every turn now: one tail message, read-only here (`digest` appends nothing), so
    // the three pictures differ only in the queue gate and the charter's marker. There is no board gate to draw.
    const boardBlock = (text) => ["", "The board tail (one message this turn):", text];
    const board = boardBlock(this.digest(rec?.id));
    const charterFullLines = ["", ...this.charterLines(rec?.id, { mode: "full" })];
    const charterMarkerLines = ["", ...this.charterLines(rec?.id, { mode: "marker" })];
    // The same concatenation the builder performs, measured whole: the sections above exclude the
    // newlines that join them, and the outer box in the picture is the prompt, not the sum of its parts.
    const text = (lines) => (Array.isArray(lines) ? lines.join("\n").trim() : "");
    const systemText = text([...parts.before, ...parts.directive, ...parts.after]);
    const firstTurn = text([...queueBlock, ...board, ...charterFullLines]);
    const ordinaryTurn = text([...board, ...charterMarkerLines]);
    const fourthTurn = text([...queueBlock, ...board, ...charterMarkerLines]);

    return promptBudgetModel({
      system: parts.sections.filter((section) => section.half === "system").map((section) => ({ key: section.key, chars: chars(section.lines) })),
      turn: {
        queue: chars(queueBlock),
        queueEmpty: queue.length === 0,
        boardFull: chars(board),
        // Both names carry the same size on purpose: the tail rides every turn, and the model keeps the pair so a
        // reader of the picture is told "the same block every turn" rather than a marker that no longer exists.
        boardMarker: chars(board),
        charterFull: chars(charterFullLines),
        charterMarker: chars(charterMarkerLines),
      },
      actual: {
        first: { system: systemText.length, turn: firstTurn.length, total: systemText.length + firstTurn.length },
        ordinary: { system: systemText.length, turn: ordinaryTurn.length, total: systemText.length + ordinaryTurn.length },
        fourth: { system: systemText.length, turn: fourthTurn.length, total: systemText.length + fourthTurn.length },
      },
      gates: {
        queueRows: s.queueDigestSize,
        queueWakes: s.queueSweepEveryNWakes,
      },
    });
  }

  // The gateway requires a real cwd on every run, and this thread does no file work: it gets a folder of its
  // own (default: beside the job store), created on demand, so it never borrows a project checkout that may
  // have been deleted. That failure — "cwd is not an existing directory", HTTP 400 — refused every turn on a
  // live panel and only showed on the card after the model had already been asked.
  ensureCwd(assistantId = PRIMARY_ASSISTANT) {
    const s = this.settingsFor(assistantId);
    const wanted = path.resolve(String(s.cwd || this.config.assistantCwd || path.join(path.dirname(this.file), "assistant-cwd")));
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

  // `assistantId` is which assistant is being spoken to. It defaults to the first, so every existing caller — the
  // board's reply route, a wake, a script — keeps meaning the assistant the panel has always had, while a second
  // assistant's turn runs on ITS thread with ITS own preamble.
  // `attachments` / `attachmentDropped` are the files this turn is to carry, as the caller believes them:
  // the names a MESSAGE line claimed, the list a steer recorded, the block the page appended. They are NOT
  // trusted — the gate below is the same `inheritAttachments` a SPAWN passes through, and the block the run
  // receives is BUILT here from what it kept. `attachmentDropped` is separate only so a caller can say
  // "this one was already refused, say it again" without pretending it is an inheritance.
  async say(text, { origin = null, display = null, assistantId = PRIMARY_ASSISTANT, attachments = [], attachmentDropped = [] } = {}) {
    const prompt = String(text || "").trim();
    if (!prompt) throw new Error("text is required");
    // THE GATE, once, at the one point every assistant turn is created: the board's reply route, a wake and a
    // MESSAGE line all come through here, so no caller can put a file on a turn the panel never stored. Only a
    // path inside config.attachmentsDir survives, and a path it refuses is NAMED in the run's input, on the
    // card and in the journal — a hand-over that silently drops a file is the defect this replaces.
    const gated = inheritAttachments(
      [...(Array.isArray(attachments) ? attachments : []), ...(Array.isArray(attachmentDropped) ? attachmentDropped : [])],
      this.attachmentsDir,
    );
    const inherited = gated.keep;
    const refused = gated.dropped;
    const rec = this.assistantRecord(assistantId);
    // THIS assistant's settings, not the panel's one object: its own switch, its own model and its own working
    // directory. #1 resolves to `this.settings` exactly as before, so its path through here is unchanged.
    const s = this.settingsFor(rec?.id);
    if (!s.enabled) throw new Error("the assistant is switched off in settings");
    const thread = rec ? rec.threadId : PRIMARY_THREAD;
    if (this.assistantLive(rec?.id)) throw new Error("the assistant is still thinking about the last message");
    const turn = this.jobs.list().filter((j) => j.thread === thread).length;
    // Two reads decide the turn's shape, and each is taken ONCE.
    //   `queueDue` is whether THIS wake carries the queue digest (`queueSweepEveryNWakes`; a reader's turn always
    //   does).
    //   `board` is this turn's digest TAIL: built now, and APPENDED only after the run exists, so a create that
    //   throws does not leave a message in the transcript for a turn that never happened. One turn, one message.
    const queueDue = this.queueDigestForTurn(rec?.id, origin);
    const board = this.buildBoardTail(rec?.id);
    const job = await this.jobs.create({
      // `prompt` is what the run receives; `displayPrompt` is the shorter line the card shows, used by a wake
      // whose full text is a digest the reader does not need to read twice.
      prompt,
      displayPrompt: display || null,
      // The turn's own text, appended to the question: the queue digest when this wake's gate says it is due, and the
      // two blocks that move on a schedule - the board and the charter. Everything that does NOT move rides in
      // `system` below, where it is not re-appended; everything that DOES move rides here, after the thread, so a
      // change costs only the bytes it adds instead of invalidating the cache for the whole thread behind it.
      preamble: this.turnBriefing(rec?.id, { queue: queueDue, board: board.text }),
      // The standing briefing, sent as the run's SYSTEM text (`instructions` on POST /v1/runs). The gateway applies
      // it as the ephemeral system prompt and never writes it into the transcript, which is the whole point: the same
      // 11 KB would otherwise be a new user message on every wake, re-read by every later call and re-ingested by
      // every compaction. It carries nothing that moves, so it is the same bytes on every turn of a session, which is
      // what a provider's prefix cache needs to reuse the thread that follows it.
      system: this.systemBriefing(rec?.id),
      thread,
      reply: turn > 0,
      // Marked on the card itself: the settle wake reads this to know it must never wake on its own turn.
      assistant: true,
      // Whose turn it is, on the JOB: `/api/jobs` then answers "which assistant is this thread" from the store rather
      // than from the thread's spelling, and a card can name its own assistant without a lookup table.
      assistantId: rec?.id || PRIMARY_ASSISTANT,
      // `worktree: false` is what keeps a tree from being cut; `existing` is left false because that flag is
      // the card's "in existing worktree" claim, and this thread has no worktree at all.
      worktree: false,
      // It reads the board; it is not asked to work in a directory, so the cwd sentence stays out of its prompt.
      anchorCwd: false,
      cwd: this.ensureCwd(rec?.id),
      ownerPath: null,
      model: s.model || null,
      budget: 900,
      maxTurns: 12,
      origin,
      // The verified files ride on the turn's OWN record, so the card draws the same chips any other turn
      // does, and in the run's input as the page's own block — appended after the words, the way the page
      // appends it to a message. Both are empty for a turn that carried nothing, which is what keeps that
      // turn's request byte for byte what it was.
      attachments: inherited,
      attachmentBlock: inheritanceBlock(inherited, refused, this.attachmentsDir),
      // A refused path is said on the card too, not only in the input: the reader judges the turn, and a
      // file that was named and then vanished is exactly the kind of thing to find out here rather than later.
      notes: refused.map((a) => `⇢ ${droppedAttachmentLine(a, this.attachmentsDir)}`),
    });
    // ONE MESSAGE, ONE TURN. The tail was built before the create and is appended here, after it: the turn really
    // exists, so the transcript cannot grow a message for a create that threw. Nothing else appends to this file.
    this.appendBoardTail(rec?.id, board.message);
    // The line carries the thread it was said on, not null: the journal is ONE combined list, and a message board
    // that attributes each line to an assistant needs the thread's owner. Null here meant every `said` line read
    // as Assistant #1's, including the turns of every other assistant.
    this.journalAdd("said", thread, origin?.reason ? `woken: ${origin.reason}` : clip(prompt, 120));
    // What the turn was handed, and what it was not — on the RECEIVER's thread, because that is where the
    // reader and the receiving assistant look for it. Same wording as a SPAWN's inheritance, same reason: an
    // assistant that meant to pass a file on has to be able to find out whether it arrived.
    if (inherited.length) {
      this.journalAdd(
        "attachments",
        thread,
        `inherited ${inherited.length} attachment${inherited.length === 1 ? "" : "s"} from the turn: ${inherited.map((a) => a.name).join(", ")}`,
      );
    }
    for (const a of refused) this.journalAdd("attachment-dropped", thread, droppedAttachmentLine(a, this.attachmentsDir));
    this.emit();
    return job;
  }

  // The queue's decisions - the budget class, the coalescing window, one batch per assistant, the sweep block
  // and the words a batch is said in - are ./assistant/wakes.js's. What stays here is the STATE they decide
  // from (`pendingWake`, `wakeTimer`, `wakes`, `forceSweepFor`), because `state()`, the reset route and every
  // harness read it off the instance.
  wake(reason, alertId = null, rule = null, opts = {}) {
    return wakeAssistant(this, reason, alertId, rule, opts);
  }

  async flushWake() {
    return flushWakes(this);
  }
  // Called from the job event stream: the end of one of the assistant's own turns is when its written
  // actions are carried out, and when a queued wake goes out.
  observe(evt) {
    if (!evt) return;
    // A worker's run settling is the board's default news: the run that ends `done` with no watch on its thread
    // used to change only its row, so landed-ready work sat unlanded. Taken from the same event stream the cards
    // read, so nothing here can see more than the board shows (see `noteSettle` for the three guardrails).
    // A `failed` run is the `exited` rule's, and the event is its transition: `checkExit` fires at once when the
    // threshold is 0 and otherwise leaves it to the sentry, which measures the threshold from `endedAt`.
    if (evt.type === "job") {
      this.noteSettle(evt.job);
      if (evt.job?.status === "failed") this.checkExit(evt.job);
    }
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
    // Every assistant's finished turn is harvested, and as ITS OWN turn: `applyActions` resolves `who` from the
    // job and judges the SPAWN/TO/NOTE lines at that assistant's settings, so #2's lines are carried out as #2's
    // and never read as #1's. A worker's run is not an assistant thread and is still never harvested.
    if (evt.type === "job" && this.isAssistantThread(evt.job?.thread) && !isLive(evt.job)) {
      // The harvest reads the turn and carries out what it wrote; it must never throw back into the store's
      // event stream, because the job that follows this one would then be the one nobody sees. A turn whose
      // actions could not be read at all says so in the journal rather than going quiet.
      try {
        void this.harvest(evt.job);
      } catch (err) {
        this.journalAdd("harvest-failed", evt.job.id, `this turn's actions were not read — ${reasonOf(err)}`);
      }
      // A turn of the assistant's own has just ended, so every COMPLETE chip ask THAT assistant was handed has
      // been read: the next press on that card is a new question rather than a duplicate of one nobody has looked
      // at yet. The ledger is keyed per assistant (`askAboutComplete`), and only the owner's turn clears its keys:
      // clearing the whole map here threw away an ask another assistant had been handed and had not read.
      const who = this.assistantIdForThread(evt.job.thread) || PRIMARY_ASSISTANT;
      for (const key of [...this.completeAsks.keys()]) {
        if (key.startsWith(`${who}|`)) this.completeAsks.delete(key);
      }
      void this.flushWake();
      this.emit();
    }
  }

  // ---- the carried-line ledger -------------------------------------------------------------------------
  // A QUEUE or MESSAGE line is keyed by the turn that wrote it and its place among that turn's lines of the same
  // kind. `parseActions` keeps no line index, and the occurrence order IS the index: a re-read of the same stored
  // turn parses the same text in the same order, so it computes the same keys. Nothing here depends on what this
  // process remembers — the QUEUE side writes its key into the row it filed, and the MESSAGE side's record is
  // persisted in assistant.json — because the thing that failed was exactly an in-memory window (`harvested`,
  // capped at 50, evicted in harvest order). Measured on the 19:05 boot: five texts, eighteen extra rows, two
  // extra real turns, every one of them a line whose turn had left that window.
  carryKeyFor(job, kind, index) {
    const turn = String(job?.id || "").trim();
    if (!turn) return null;
    return `${turn}|${String(kind || "").trim()}|${Math.max(0, Number(index) || 0)}`;
  }

  carriedLine(key) {
    if (!key) return null;
    return this.carriedLines.find((x) => x && x.key === key) || null;
  }

  // `outcome` is settled on the SAME record: null means "recorded before the line ran" (a MESSAGE that was written
  // down before it was sent, so a crash in between leaves it carried rather than re-sendable), `filed`/`sent` mean
  // the work exists, and `refused` is a line whose carrying was decided against. Every one of them blocks a second
  // carry: a re-read is not a retry, and the author's next turn writes a new line if the work still needs doing.
  noteCarriedLine(key, { kind, who = null, job = null, target = null, outcome = null, ref = null } = {}) {
    if (!key) return null;
    let item = this.carriedLine(key);
    if (!item) {
      item = {
        key,
        kind: String(kind || "").trim() || "queue",
        who: who ? String(who) : null,
        turnId: job?.id ? String(job.id) : null,
        target: target ? String(target) : null,
        at: nowIso(),
        outcome: null,
        ref: null,
      };
      this.carriedLines.push(item);
      if (this.carriedLines.length > CARRIED_CAP) this.carriedLines.splice(0, this.carriedLines.length - CARRIED_CAP);
    }
    if (outcome) item.outcome = String(outcome);
    if (ref !== null && ref !== undefined) item.ref = ref;
    // On disk at once, not on the 400 ms debounce: the record's whole job is to answer a process that starts after
    // this one, and a MESSAGE sent in between two boots is a turn somebody has to read.
    this.persist();
    this.writeNow();
    return item;
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
    // The ledger is opened BEFORE the "nothing to do" return below, and that order is load-bearing: a turn whose
    // only command lines were near misses has no actions at all, and it is exactly the turn the old path forgot
    // about. Opening it also writes the `command-unparsed` lines, the one record a dropped line can leave.
    const audit = this.openAudit(job, answer);
    // EVERY kind the grammar can produce is listed here, and MESSAGE/QUEUE are why it is spelled out rather than
    // counted: a turn whose only line is `MESSAGE #2 | …` used to return here as "nothing to do" — the Director's
    // message was read, audited and never sent. A kind added to `parseActions` belongs in this list on the same day.
    if (
      !actions.to.length && !actions.watch.length && !actions.note.length &&
      !actions.spawn.length && !actions.rule.length && !actions.charter.length && !actions.restart.length &&
      !actions.todo.length && !actions.queue.length && !actions.message.length
    ) {
      if (audit) this.settleAudit(audit);
      return;
    }
    return this.applyActions(job, actions, audit);
  }

  // Everything a parse did, carried out, with each line's outcome written onto the turn's ledger as it happens.
  //
  // Split from `harvest` for one reason: `commandAudit: enforce` replays the lines nothing accounted for, and a
  // replay has to go through the SAME path or it is a second implementation with its own holes. Every action
  // claims its line before it runs (`claimLine`) and settles it applied or refused where the outcome is decided —
  // inside the body when the body knows (a busy thread, a missing worktree), through `carry`'s failure callback
  // when it throws. A line left `pending` is a line the panel lost, and the audit names it.
  applyActions(job, actions, audit = null) {
    const carried = [];
    // Whose turn this is, and therefore WHICH settings the lines below are judged at: autonomy, the spawn switch, the
    // whitelists and the command audit belong to the assistant that wrote them. #1's thread resolves to
    // PRIMARY_ASSISTANT, whose settings ARE `this.settings`, so its path through here is unchanged.
    // The run's own assistant: its thread when it is an assistant's turn, else the tree's owner or the stamp its
    // spawner wrote. A WORKER turn has no assistant thread at all, so `assistantIdForThread` alone answered #1 for
    // every line a second assistant's worker ever wrote.
    const who = this.assistantIdForJob(job) || PRIMARY_ASSISTANT;
    const turnSettings = this.settingsFor(who);
    // The Assistant Director is the one role whose vocabulary differs: it may file rows and message assistants
    // (QUEUE / MESSAGE), and it may not talk to a worker (TO) or start one (SPAWN — also off in its profile). The
    // grammar does not offer those lines to it; this is the second half, so a line written anyway is refused out
    // loud rather than carried out as if the role had no boundary.
    const director = this.roleOf(this.assistantRecord(who))?.id === ASSISTANT_DIRECTOR_ID;
    const mark = (kind) => (audit ? claimLine(audit, kind) : null);
    for (const note of actions.note) {
      const line = mark("note");
      carried.push(
        this.carry("note-failed", null, `NOTE: ${clip(note, 100)}`, () => {
          // The pad of the assistant whose turn wrote the line: #1's string in its store, an extra assistant's own
          // notes.md. A NOTE in #3's turn is #3's alone — it used to land in the one string every assistant read.
          this.appendNote(who, note);
          this.journalAdd("note", null, note);
          settleLine(line, "applied");
        }, () => settleLine(line, "refused")),
      );
    }
    // A rule the assistant writes for itself. The reader's rules are still the reader's: this can add, not
    // edit or delete, and the Notes tab marks which is which. Capped at 40 with the OLDEST rule the
    // assistant wrote trimmed by `addRule` — a reader's rule is never the one that makes room, so an agent that
    // keeps restating itself cannot crowd out the reader's own answers.
    for (const text of actions.rule) {
      const line = mark("rule");
      carried.push(
        this.carry("rule-failed", null, `RULE: ${clip(text, 100)}`, () => {
          try {
            this.addRule(text, "assistant");
          } catch (err) {
            if (!err || err.code !== "rule-full") throw err;
            // Full, and every rule in it is the reader's: there is nothing of the assistant's own to trade, so
            // the line is refused BY NAME rather than dropping one of the reader's to fit it.
            this.journalAdd("rule-skipped", null, `the scratchpad holds ${RULE_MAX} rules and none the assistant wrote: ${clip(text, 120)}`);
            settleLine(line, "refused");
            return;
          }
          settleLine(line, "applied");
        }, () => settleLine(line, "refused")),
      );
    }
    // CHARTER: lines — the assistant's own way to write the long tier. Nothing to gate: it writes its own
    // file, and an entry that cannot fit is reported in the journal rather than dropped in silence. WHOSE file:
    // the assistant whose turn wrote the line (`who`), so #5's entry lands in #5's charter and not in #1's.
    for (const entry of actions.charter) {
      const line = mark("charter");
      carried.push(
        this.carry("charter-failed", null, `CHARTER: ${clip(entry, 100)}`, () => {
          // `written:false` has already journalled why (charter-full / charter-failed): that is a refusal, and the
          // ledger has to say the same thing rather than record the call.
          const out = this.appendCharter(entry, { by: "assistant", kind: "entry", assistantId: who });
          settleLine(line, out && out.written ? "applied" : "refused");
        }, () => settleLine(line, "refused")),
      );
    }
    for (const w of actions.watch) {
      const line = mark("watch");
      carried.push(
        this.carry("watch-failed", w.thread, `WATCH ${w.thread}`, () => {
          if (!this.jobs.firstOfThread(w.thread)) {
            // A watch on a thread that is not on the board is a line that could not be carried out, and saying
            // so is the difference between a dropped action and an action that never existed.
            this.journalAdd("watch-skipped", w.thread, "no such thread on the board");
            settleLine(line, "refused");
            return;
          }
          this.addWatch({ thread: w.thread, title: w.title, minutes: w.minutes, assistantId: who }, "assistant");
          settleLine(line, "applied");
        }, () => settleLine(line, "refused")),
      );
    }
    for (const to of actions.to) {
      const line = mark("to");
      if (director) {
        this.journalAdd(
          "to-refused",
          to.thread,
          `the Assistant Director does not reply to a worker (${clip(to.text, 120)}) — talk to the assistant that owns the row with MESSAGE <assistant> | <text>`,
        );
        settleLine(line, "refused");
        continue;
      }
      carried.push(
        this.carry("send-failed", to.thread, `TO ${to.thread}: ${clip(to.text, 100)}`, () => {
          const first = this.jobs.firstOfThread(to.thread);
          if (!first) {
            this.journalAdd("draft-skipped", to.thread, "no such thread on the board");
            settleLine(line, "refused");
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
            // A refusal the journal already carries is ACCOUNTED FOR: the audit must not call a held TO a lost
            // one, or every busy thread would raise a card about work the panel deliberately did not do.
            settleLine(line, "refused");
            return;
          }
          const auto = turnSettings.autonomy === "auto" || turnSettings.autonomy === "auto-safe";
          if (auto) {
            // A send that resolves without a job did not reach the worker: the line stays unaccounted so the
            // audit names it, instead of being called applied because the promise came back.
            return this.answerThread(to.thread, to.text, { source: "assistant", autonomy: turnSettings.autonomy })
              .then((j) => {
                if (!j?.id) return;
                settleLine(line, "applied");
                this.journalAdd("sent", to.thread, `assistant replied (job ${j.id})`);
              })
              .catch((err) => {
                // A reply into a released tree is refused by NAME where it is decided (answerThread), so the journal
                // already carries the tree and the checkout it would have run in. Swallowing it here keeps that one
                // refusal one line — `carry`'s generic send-failed would say the same thing a second time — and the
                // line is still accounted, so the audit does not call a deliberate refusal a lost action.
                if (err?.code !== "tree_released") throw err;
                settleLine(line, "refused");
              });
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
            // Fired by THIS turn, so the draft card belongs to the assistant that wrote it — #1 included.
            assistantId: who,
            draft: { thread: to.thread, text: to.text, confidence: "assistant", source: "assistant" },
          });
          this.journalAdd("draft", to.thread, clip(to.text, 160));
          // A draft the reader can send IS the outcome of a TO at `draft` autonomy: the panel did its part.
          settleLine(line, "applied");
        }, () => settleLine(line, "refused")),
      );
    }
    // ---- the Director's two powers -----------------------------------------------------------------------
    // Both are gated on the ROLE, not on a setting: the Director is created with `spawn: off` and no TO line in its
    // grammar, and these two loops are the only place either line can change another assistant's work. A line from
    // any other role is refused by name — the vocabulary is per job, and an assistant that has not been given the
    // job has not been given its powers.
    const directorTarget = (ref, kind = "queue") => {
      const target = this.assistantRef(ref);
      if (!target) {
        this.journalAdd(`${kind}-refused`, null, `no assistant answers to "${clip(ref, 60)}" — name it assistant-2, #2, 2 or its record name`);
        return null;
      }
      if (String(target.id) === String(who)) {
        this.journalAdd(`${kind}-refused`, target.threadId, "that assistant is this turn's own — a director files work into ANOTHER assistant's queue");
        return null;
      }
      return target;
    };
    for (let qi = 0; qi < actions.queue.length; qi += 1) {
      const q = actions.queue[qi];
      const line = mark("queue");
      // The key this line is filed under, computed from the turn and the line's place in it — stable across every
      // re-read of the same stored turn, which is what makes it the idempotency the row needs.
      const key = this.carryKeyFor(job, "queue", qi);
      if (!director) {
        this.journalAdd(
          "queue-refused",
          job.thread,
          `only the Assistant Director may file a row into another assistant's queue: “QUEUE ${q.assistant} | ${clip(q.text, 120)}”`,
        );
        settleLine(line, "refused");
        continue;
      }
      carried.push(
        this.carry("queue-failed", null, `QUEUE ${q.assistant}: ${clip(q.text, 100)}`, () => {
          const target = directorTarget(q.assistant);
          if (!target) {
            settleLine(line, "refused");
            return;
          }
          // A line already carried out once is not filed a second time. This is the re-read the turn-id mark cannot
          // stop: `harvested` holds 50 ids and evicts in harvest order, so a stored Director reply older than that
          // window is read as never harvested, and every QUEUE line in it used to become a brand new row (measured:
          // #268/#269/#270 re-filed six times each over one afternoon).
          const before = this.carriedLine(key);
          if (before) {
            const where = before.ref ? `row #${before.ref}` : "a row it already filed";
            this.journalAdd(
              "queue-replay-refused",
              target.threadId,
              `QUEUE ${target.name}: it was already carried out once (${where}), so this line was not filed again — write a new QUEUE line if the work still needs doing`,
            );
            settleLine(line, "refused");
            return;
          }
          const text = String(q.text || "").trim();
          const title = clip(text, TASK_TITLE_MAX);
          const detail = text.length > title.length ? clip(text, TASK_DETAIL_MAX) : "";
          const out = this.queueMutate(target.id, "add", { title, detail }, { by: who, carriedKey: key });
          if (out && out.duplicate) {
            // The ROW answered, not the ledger: it carries the key of the line that filed it, so a ledger that was
            // pruned, or restored from an older copy, cannot make the panel file this text a second time.
            this.noteCarriedLine(key, { kind: "queue", who, job, target: target.id, outcome: "filed", ref: out.task.id });
            this.journalAdd(
              "queue-replay-refused",
              target.threadId,
              `QUEUE ${target.name}: it was already carried out once (row #${out.task.id}), so this line was not filed again — write a new QUEUE line if the work still needs doing`,
            );
            settleLine(line, "refused");
            return;
          }
          if (!out || out.ok === false) {
            this.journalAdd("queue-refused", target.threadId, `nothing was filed in ${target.name}'s queue — ${(out && out.error) || "the queue refused the row"}`);
            settleLine(line, "refused");
            return;
          }
          // The ledger record is written AFTER the row exists, because the row is the durable half: a crash between
          // the two leaves a row that answers the next re-read, and a record with no row would be a refusal of work
          // nobody can point at.
          this.noteCarriedLine(key, { kind: "queue", who, job, target: target.id, outcome: "filed", ref: out.task.id });
          // Two journal lines for one landing, each on the thread it is about: the TARGET's says what it was
          // handed (row id and title first, because a record is read for "what is this row"), and the Director's
          // own says what it sent. They are JOURNAL lines rather than card lines: a target that has never run has
          // no turn for a console to sit in. The journal is the record; the assistant's card does not echo them.
          this.journalAdd(
            "queue-landed",
            target.threadId,
            `#${out.task.id} ${clip(out.task.title, 120)} — filed in this queue by the Assistant Director`,
          );
          this.journalAdd(
            "queue-sent",
            job.thread,
            `QUEUE ${target.name} | #${out.task.id} ${clip(out.task.title, 100)} — filed`,
          );
          settleLine(line, "applied");
        }, () => settleLine(line, "refused")),
      );
    }
    for (let mi = 0; mi < actions.message.length; mi += 1) {
      const m = actions.message[mi];
      const line = mark("message");
      const key = this.carryKeyFor(job, "message", mi);
      if (!director) {
        this.journalAdd(
          "message-refused",
          job.thread,
          `only the Assistant Director may message another assistant: “MESSAGE ${m.assistant} | ${clip(m.text, 120)}”`,
        );
        settleLine(line, "refused");
        continue;
      }
      carried.push(
        this.carry("message-failed", null, `MESSAGE ${m.assistant}: ${clip(m.text, 100)}`, () => {
          const target = directorTarget(m.assistant, "message");
          if (!target) {
            settleLine(line, "refused");
            return;
          }
          // A message already sent from this turn is not sent again. There is no row to write the key into (a
          // MESSAGE creates a job, not a queue row), so the ledger is the record — and the 19:05 boot is why it
          // exists: two replies were re-sent and started two real turns on Assistant #2 exactly like a fresh
          // Director turn would.
          const before = this.carriedLine(key);
          if (before) {
            this.journalAdd(
              "message-replay-refused",
              target.threadId,
              `MESSAGE ${target.name}: it was already carried out once (${before.outcome || "recorded before it was sent"}${before.ref ? ` job ${before.ref}` : ""}), so this line was not sent again — write a new MESSAGE line if it still needs saying`,
            );
            settleLine(line, "refused");
            return;
          }
          const sender = this.assistantRecord(who);
          const senderName = sender?.name || who;
          // The files the sender's turn holds — its own record, the page's block on its prompt, and any
          // Attachment: line this message wrote — through the SAME gate a SPAWN uses. The written text comes
          // back with the panel's format taken out of it, so what travels is the sentence plus a block the
          // panel built from paths it stored, never a path another assistant typed.
          const files = this.messageInheritance(job, m.text);
          const words = String(files.text || "").trim();
          if (!words) {
            this.journalAdd(
              "message-refused",
              target.threadId,
              `${target.name} was not messaged — the line is only an Attachment: line, and a message needs words`,
            );
            settleLine(line, "refused");
            return;
          }
          // Written to disk BEFORE the turn starts and settled when the send comes back: a restart in between leaves
          // "this line was carried" rather than a message the next boot sends a second time.
          this.noteCarriedLine(key, { kind: "message", who, job, target: target.id });
          return this.say(`[${senderName} → you] ${words}`, {
            // The sender's own name and id ride on the origin beside the card's line, so the chip draws the name the
            // sender writes under rather than a thread's spelling of it — and a renamed assistant keeps the name the
            // message was sent with. `thread` is where it was written, which the chip's tooltip names.
            origin: { kind: "assistant-message", from: who, name: senderName, id: sender?.id || who, thread: sender?.threadId || null, reason: clip(files.text, 300) },
            display: `message from ${senderName}: ${clip(files.text, 160)}`,
            assistantId: target.id,
            // Already split by the gate; `say` runs it once more over both lists before anything is sent.
            attachments: files.keep,
            attachmentDropped: files.dropped,
          })
            .then((j) => {
              if (!j?.id) return;
              this.noteCarriedLine(key, { kind: "message", who, job, target: target.id, outcome: "sent", ref: j.id });
              this.journalAdd("messaged", target.threadId, `${target.name} was sent a message by the Assistant Director (job ${j.id}) — ${clip(m.text, 120)}`);
              // …and the same line on the SENDER's thread: the Director's own log has to show what it sent, or
              // its card reads as prose with no record of the two powers it used. Emitted here because this
              // promise lands after `applyActions`'s own emit, and the page would otherwise wait for an unrelated
              // event to draw the line.
              this.journalAdd("message-sent", job.thread, `MESSAGE ${target.name} | ${clip(m.text, 120)} — sent`);
              this.emit();
              settleLine(line, "applied");
            })
            .catch((err) => {
              // A live thread is a refusal with a next step, not a delivery: say so and leave the line accounted,
              // so the audit does not call a deliberate "not now" a lost action. The record stays too — a re-read
              // of this turn is not a retry, and the Director's next turn writes a new line if it still matters.
              this.noteCarriedLine(key, { kind: "message", who, job, target: target.id, outcome: "refused" });
              this.journalAdd("message-refused", target.threadId, `${target.name} was not messaged — ${reasonOf(err)}`);
              settleLine(line, "refused");
            });
        }, () => settleLine(line, "refused")),
      );
    }
    // ---- TODO lines: the worktree's own list ---------------------------------------------------------------
    // A `TODO IN <tree> | …` line names its own tree and is applied here. A `TODO …` line written UNDER a SPAWN
    // line belongs to the tree that SPAWN starts (that is how a card's acceptance items are seeded: one TODO line
    // per item, under the SPAWN). A TODO line with NEITHER is refused out loud — never guessed onto some tree,
    // because the wrong tree is a list the reader will believe.
    // Every TODO line is CLAIMED first, in the order it was written, so each one ends with an outcome even when
    // the SPAWN it rides is refused: a TODO that reached no tree is a refusal, and it used to be silence.
    const todoLines = actions.todo.map(() => mark("todo"));
    const todoBySpawn = new Map();
    for (let i = 0; i < actions.todo.length; i += 1) {
      const t = actions.todo[i];
      if (t.target) continue; // handled on its own, below
      if (t.spawn === null || t.spawn === undefined) {
        this.journalAdd(
          "todo-skipped",
          job.thread,
          `“${clip(t.raw || t.text || "TODO", 120)}” — a TODO line has to name a worktree: write it under the SPAWN line it belongs to, or name one with \`TODO IN <tree> | …\``,
        );
        settleLine(todoLines[i], "refused");
        continue;
      }
      const idx = Number(t.spawn);
      if (!todoBySpawn.has(idx)) todoBySpawn.set(idx, []);
      todoBySpawn.get(idx).push({ t, line: todoLines[i] });
    }
    // The TODO lines one SPAWN carries. They reach a tree only if the spawn does, so they are settled WITH it:
    // applied when it is, refused when it is, and left unaccounted when it produces no run and says nothing.
    const todosFor = (idx) => {
      const keep = [];
      for (const row of todoBySpawn.get(idx) || []) {
        if (row.t.op === "add" && !row.t.error && String(row.t.text || "").trim()) {
          keep.push(row);
          continue;
        }
        // `TODO DONE 3` under a SPAWN names no tree of its own, so there is no list to resolve the id against.
        // It used to be filtered out silently; that is a refusal and it says so.
        this.journalAdd("todo-skipped", job.thread, `“${clip(row.t.raw || row.t.text || "TODO", 120)}” — only a plain \`TODO <text>\` seeds a tree from the SPAWN above it`);
        settleLine(row.line, "refused");
      }
      return { texts: keep.map((r) => String(r.t.text)), lines: keep.map((r) => r.line) };
    };
    // A TODO line that names a tree itself: resolved by the store (a path, a directory name, a branch, a tag or a
    // thread), and every outcome journalled — applied or refused, with the reason. One result per line, in the
    // order they were written, which is what makes a per-line ledger honest.
    const explicitTodo = actions.todo.map((t, i) => ({ t, line: todoLines[i] })).filter((x) => x.t.target);
    if (explicitTodo.length && this.todos) {
      carried.push(
        this.carry("todo-failed", job.thread, `TODO IN (${explicitTodo.length} line${explicitTodo.length === 1 ? "" : "s"})`, () => {
          const results = this.todos.applyLines({ lines: explicitTodo.map((x) => x.t), by: "assistant", from: "assistant" });
          for (let i = 0; i < explicitTodo.length; i += 1) {
            const r = results[i] || { ok: false, error: "the TODO store returned no result for this line" };
            if (r.ok) {
              this.journalAdd("todo", job.thread, `#${r.item?.id ?? r.id} ${r.op} in ${r.key}: ${clip(r.item?.text || r.text || "", 120)}`);
              settleLine(explicitTodo[i].line, "applied");
            } else {
              this.journalAdd("todo-refused", job.thread, `${clip(r.raw || r.text || "", 120)} — ${r.error}`);
              settleLine(explicitTodo[i].line, "refused");
            }
          }
          if (results.some((r) => r.ok)) this.todosChanged?.();
        }, () => { for (const x of explicitTodo) settleLine(x.line, "refused"); }),
      );
    } else if (explicitTodo.length) {
      // No store wired: a line that cannot be applied is refused out loud, not dropped.
      for (const x of explicitTodo) {
        this.journalAdd("todo-refused", job.thread, `${clip(x.t.raw || x.t.text || "", 120)} — this panel has no TODO store wired`);
        settleLine(x.line, "refused");
      }
    }
    for (let idx = 0; idx < actions.spawn.length; idx += 1) {
      const sp = actions.spawn[idx];
      const { texts, lines: todoSet } = todosFor(idx);
      const what = `${sp.existing ? "SPAWN IN" : "SPAWN"} ${clip(sp.target, 80)}`;
      const line = mark("spawn");
      const settleTodos = (outcome) => { for (const l of todoSet) settleLine(l, outcome); };
      // The debt is taken BEFORE the line runs and written to disk at once: every way out of the block below
      // settles it — a card, a job, an explicit skip, a refusal — and the only way it stays owed is a line that
      // produced nothing, which the watchdog escalates two minutes later (see `checkSpawns`). The audit's
      // `settleLine` and this record answer different questions: the audit asks whether the line was CARRIED
      // OUT, the intent asks whether anything EXISTS behind it, and a card at `ask` mode is applied-but-not-started.
      const intentsBefore = new Set(this.spawnIntents.map((x) => x.id));
      const intent = this.noteSpawnIntent(job, sp);
      // A line the panel has seen before is a replay; a line it has just seen is work that has not been cut for
      // yet, even when the row it names is already linked by something else.
      const replayedLine = Boolean(intent && intentsBefore.has(intent.id));
      // A line the panel has already carried out once is not carried out a second time. `noteSpawnIntent` is keyed
      // by turn + target + prompt, so an item it RETURNS rather than creates is the SAME SPAWN line coming round
      // again — which is what a boot does when it re-reads one of the assistant's old turns (the `harvested` mark
      // is capped at 50 turn ids, so the oldest fall out and read as never harvested). The debt's own `outcome` is
      // the record that it was carried: a `landed` one was settled because its work is on main, a `job`/`card`/
      // `failed`/`skipped` one because the line already ran. Measured on the 0.59.0 boot: the pass journalled
      // "replay skipped: already landed" for `065afb5b` at 10:44:58.691, and the same record was carried out again
      // at 10:45:08 (job 6f092a51, a fresh tree cut from df3b95d) — the skip was booked, then simply ignored here.
      const settledBefore = intent ? String(intent.outcome || "") : "";
      // A replay of a SPAWN that already cut its tree: the line was recorded before (an owed debt, or one the
      // watchdog called lost while nobody was looking), but its row already names the worker's thread and worktree
      // — the write that proves a cut happened. Re-linking settles the debt against that run instead of cutting a
      // second tree for a task that is already being worked. This is the replay the task id exists for: without it
      // there is nothing on the line that can tell the panel the work it is about to start is its own earlier cut.
      if (replayedLine && intent?.taskId && (!settledBefore || settledBefore === "lost")) {
        const linked = this.spawnTaskLinked(who, intent.taskId, { since: Number(intent.at) || 0 });
        if (linked) {
          this.journalAdd(
            "spawn-replay-relinked",
            linked.thread,
            `${what}: row #${intent.taskId} already names ${linked.thread}${linked.task.worktree ? ` in ${linked.task.worktree}` : ""}, so the line was re-linked rather than carried out again — nothing was cut`,
          );
          this.settleSpawnIntent(intent, "job", { jobThread: linked.thread, job: linked.job });
          settleLine(line, "applied");
          settleTodos("applied");
          continue;
        }
      }
      // A line the panel already settled is not carried out again — that is the duplicate this refusal exists to
      // stop. A `lost` debt whose row names a run was answered by the re-link above; a lost one that names nothing
      // stays refused until its work is judged landed.
      if (settledBefore) {
        const why =
          settledBefore === "landed"
            ? `already landed — ${intent.landedWhy || "its work is already on main"}`
            : `it was already carried out once (${settledBefore})`;
        this.journalAdd(
          "spawn-replay-refused",
          null,
          `${what}: ${why}, so this line was not carried out again${intent.jobThread ? ` (it went to ${intent.jobThread})` : ""} — write a new SPAWN line if the work still needs doing`,
        );
        settleLine(line, "refused");
        settleTodos("refused");
        continue;
      }
      // The row this line names is checked BEFORE a card exists and before a tree is cut. A missing, finished or
      // foreign id is refused out loud and nothing starts; the debt is settled as `skipped` rather than left owed,
      // or the watchdog would report the refusal two minutes later as a line that produced nothing.
      const named = Number(sp?.taskId) > 0 ? Number(sp.taskId) : null;
      if (named) {
        const refusal = this.spawnTaskRefusal(who, named);
        if (refusal) {
          this.journalAdd("spawn-refused", null, `${what}: ${refusal} — nothing was cut`);
          this.settleSpawnIntent(intent, "skipped");
          settleLine(line, "refused");
          settleTodos("refused");
          continue;
        }
      }
      // What this line hands the worker it starts: the turn's attachments, verified against the panel's own
      // attachments directory, plus the prompt with any Attachment: line the assistant wrote itself taken out
      // (see `spawnInheritance`). A turn that carried nothing comes back with the prompt unchanged and an empty
      // block, so the child's request is the one it always was.
      const inherit = this.spawnInheritance(job, sp);
      const spec = {
        ...sp,
        prompt: inherit.prompt,
        attachments: inherit.keep,
        attachmentDropped: inherit.dropped,
      };
      carried.push(
        this.carry("spawn-failed", null, `${what}: ${clip(sp.prompt, 80)}`, () => {
          // The spawn switch is the only gate now: the whitelists are gone, so a SPAWN line is judged by
          // `spawn: off` / `ask` / `auto` and nothing else. A card the reader presses is still re-checked below.
          if (turnSettings.spawn === "off") {
            this.journalAdd("spawn-skipped", null, `creating worktrees is switched off: ${clip(sp.prompt, 120)}`);
            this.settleSpawnIntent(intent, "skipped");
            settleLine(line, "refused");
            settleTodos("refused");
            return;
          }
          if (turnSettings.spawn === "ask") {
            const card = this.addSpawnAlert({ ...spec, todos: texts }, { turn: { id: job.id, thread: job.thread }, assistantId: who });
            this.settleSpawnIntent(intent, "card", { alertId: card?.id || null });
            settleLine(line, "applied");
            settleTodos("applied");
            return;
          }
          // A SPAWN that comes back with no run is the case this audit exists for: a worktree was asked for and
          // nothing exists. The line stays unaccounted and the audit names it, rather than reading "no exception"
          // as "started" — and the intent stays owed, so the spawn watchdog names it too.
          // `turn` is the SENDING turn: the assistant turn whose reply wrote this SPAWN line. It rides the run's
          // origin, which is what lets a digest row name the turn that sent the work (the row's `send` pointer) and
          // the read tool answer with that turn's final message rather than the newest one on the thread.
          return this.startSpawn({ ...spec, todos: texts, turn: { id: job.id, thread: job.thread } }, { source: "assistant", assistantId: who }).then((j) => {
            if (!j?.id) return;
            this.settleSpawnIntent(intent, "job", { jobThread: j?.thread || null, job: j });
            settleLine(line, "applied");
            settleTodos("applied");
          });
        }, () => { this.settleSpawnIntent(intent, "failed"); settleLine(line, "refused"); settleTodos("refused"); }),
      );
    }
    // RESTART is the one action that acts on this panel's own process: it is QUEUED here and never
    // run inside this turn, because this turn is a run in the gateway a restart would kill. A refusal
    // (no provider key, or one already queued) is written to the journal, not raised.
    for (const rs of actions.restart) {
      const line = mark("restart");
      if (director) {
        this.journalAdd("restart-refused", job.thread, `the Assistant Director does not restart the ${rs.target || "panel"}: a restart kills live turns, including the one reading this reply`);
        settleLine(line, "refused");
        continue;
      }
      if (typeof this.onRestart !== "function") {
        this.journalAdd("restart-skipped", job.thread, `this panel has no restart action wired: RESTART ${rs.target}`);
        settleLine(line, "refused");
        continue;
      }
      try {
        const rec = this.onRestart({ target: rs.target, reason: rs.reason, waitFor: job.thread, requestedBy: "assistant" });
        this.journalAdd("restart-queued", job.thread, `${rs.target} restart queued (${rec.id}) — it runs once this turn has ended${rs.reason ? `: ${clip(rs.reason, 120)}` : ""}`);
        settleLine(line, "applied");
      } catch (e) {
        this.journalAdd("restart-refused", job.thread, `RESTART ${rs.target} refused: ${String((e && e.message) || e)}`);
        settleLine(line, "refused");
      }
    }
    this.persist();
    this.emit();
    // One promise for the whole turn, so a caller can wait for the replies and spawns it started. Nothing here
    // can reject: every action reports its own failure as a journal line, which is the only reason the harvest
    // is safe to run from the job event stream.
    const all = Promise.allSettled(carried);
    if (!audit) return all;
    // The reconciliation waits for the async half: a TO sent or a SPAWN started settles after the loop, and a
    // count taken now would call every one of them unactioned.
    return all.then((results) => {
      try {
        this.settleAudit(audit);
      } catch (err) {
        this.journalAdd("command-audit-failed", job.thread, `turn ${job.id}: the command audit could not reconcile this turn — ${reasonOf(err)}`);
      }
      return results;
    });
  }

  // One written action, carried out on its own. What one line does is never another line's business: a SPAWN
  // that cannot start, a TO whose thread lookup throws and a WATCH that names nothing are three independent
  // outcomes, and the lines that can still be carried out are. A sync throw, a rejected promise and a refusal
  // all come back as one journal line naming the line and the reason, and the next action runs either way —
  // an injected handler that throws (the spawner, the project registry, the job store) used to abort the rest
  // of the harvest with nothing written down at all.
  carry(failKind, thread, what, fn, onFail = null) {
    const failed = (err) => {
      // A refusal the panel already wrote to the journal — a SPAWN refused at the cut because the row or the tree
      // already holds a live run — is not written a second time as a generic failure. One refusal is one line, and
      // the specific line is the one that names the holding thread.
      if (!err?.journalled) this.journalAdd(failKind, thread, `${what} — ${reasonOf(err)}`);
      // The caller's own bookkeeping (a SPAWN line's debt, settled as `failed`) runs AFTER the journal line, so
      // a throw in it can never swallow the reason the line did not happen.
      try {
        onFail?.(err);
      } catch {
        /* the journal line above is the record; a failed settle is not a second failure */
      }
    };
    try {
      const out = fn();
      if (out && typeof out.then === "function") return out.catch(failed);
      return out;
    } catch (err) {
      failed(err);
      return null;
    }
  }

  // ---- the per-turn command audit ----------------------------------------------------------
  //
  // What the assistant WROTE against what the panel DID. Seven of the eight kinds already journal their refusals
  // line by line (a busy TO, a TODO id that does not exist, a WATCH with no such thread, a RESTART with no key), so
  // this is not a second vocabulary and not a second set of checks: it reconciles the two counts and names the
  // turn where the second one is short. `../assistant/audit.js` holds the ledger and the comparison.
  //
  // Two holes are all it takes to make the counts disagree, and both are shared by every kind:
  //   - a line that begins with a known prefix and misses its regex is dropped with no journal line at all, so
  //     the ledger records it as unparsed and writes `command-unparsed` for it;
  //   - `harvest` only runs when a turn ENDS, so a restart mid-turn carried out nothing and said nothing. The
  //     parsed side is read from the turn's own lines, which outlive this process in the job store.
  //
  // `settings.commandAudit` decides what happens with a disagreement: off reads nothing at all, report raises the
  // red card and writes the journal line the digest reads, enforce also replays the unaccounted lines once.

  // One switch for the whole panel: `commandAudit` is a WATCHDOG knob (see SETTINGS_SCOPE in
  // ./assistant/config.js), so the mode that decides whether a turn is reconciled is the panel's own, whichever
  // assistant's thread the turn ran on. Resolved per THREAD it answered "off" for every assistant but #1, whose
  // profile never carries the knob, so a killed #2 turn was skipped even once the sweep found it.
  auditMode() {
    const mode = String(this.settings.commandAudit || "off");
    return COMMAND_AUDIT_MODES.includes(mode) ? mode : "off";
  }

  findAudit(turnId) {
    if (!turnId) return null;
    return this.commandAudits.find((a) => a.turn === String(turnId)) || null;
  }

  // Open — or hand back — the ledger for one turn. Reading the turn's own lines rather than the reply in hand is
  // what makes this work for a turn THIS process never saw end: after a restart the lines are still in the job
  // store, and the parsed side is what the next pass compares against.
  openAudit(job, answer = turnProse(job?.lines)) {
    if (this.auditMode() === "off" || !job?.id) return null;
    const turn = String(job.id);
    const existing = this.findAudit(turn);
    if (existing) return existing;
    const entries = scanCommands(answer);
    if (!entries.length) return null;
    const audit = newAudit(job, entries);
    this.commandAudits.push(audit);
    if (this.commandAudits.length > COMMAND_AUDIT_CAP) this.commandAudits.splice(0, this.commandAudits.length - COMMAND_AUDIT_CAP);
    // A line the grammar could not read is the one shape that used to vanish entirely. Say it as its own journal
    // line — the turn, the kind and the line — so it is captured rather than skipped.
    for (const e of entries) {
      if (e.parsed) continue;
      this.journalAdd(
        "command-unparsed",
        job.thread || null,
        `turn ${turn}: ${e.kind} did not match its grammar, so nothing was done with it — “${clip(e.line, 140)}”`,
      );
    }
    this.persist();
    return audit;
  }

  // The reconciliation. Called when a harvest's actions have all settled, and by every sentry pass — which is how
  // a turn nothing ever harvested (a restart mid-turn) is looked at at all.
  settleAudit(audit) {
    if (!audit) return [];
    // The audit is the panel's one switch (SETTINGS_SCOPE puts `commandAudit` in the watchdog half), so every
    // assistant's turn is reconciled at the same mode. The THREAD below still decides whose card this is and whose
    // settings the replayed lines run under; it never decides whether the reconciliation happens.
    const mode = this.auditMode();
    if (mode === "off") return [];
    const found = auditGaps(audit);
    if (!found.length) {
      // A gap that got closed (an enforce replay that landed) takes its card with it: a red card about work that
      // is now done is a warning nobody can act on, and the reader learns to ignore the colour.
      const open = this.alerts.filter((a) => a.status === "open" && a.rule === "unactioned" && a.turnId === audit.turn);
      for (const card of open) {
        card.status = "done";
        card.closedAt = nowIso();
        this.journalAdd("command-settled", audit.thread || null, `turn ${audit.turn}: ${card.kind || "the gap"} is accounted for now — the card is closed`);
      }
      if (open.length) {
        this.persist();
        this.emit();
      }
      return [];
    }
    const raised = [];
    for (const gap of found) raised.push(this.reportCommandGap(audit, gap));
    // Enforce: the lines nothing accounts for are carried out once, on the NEXT pass — never inside this one,
    // which may still have its own actions in flight.
    if (mode === "enforce" && !audit.replayedAt) audit.replay = { at: nowIso() };
    this.persist();
    this.emit();
    return raised;
  }

  // The red card, and the journal line the digest reads back. One card per turn and kind, so a second pass or a
  // second process cannot stack another; it is rewritten in place when the counts move (enforce replaying a line
  // of it, say) rather than duplicated.
  reportCommandGap(audit, gap) {
    const key = `unactioned|${audit.turn}|${gap.kind}`;
    const shown = gap.lines.slice(0, 2).map((l) => `“${clip(l, 120)}”`).join(" · ");
    const detail = `turn ${audit.turn}: ${gap.missing} of ${gap.parsed} ${gap.kind} line${gap.parsed === 1 ? "" : "s"} were read and never carried out — ${shown}`;
    const evidence = [
      { label: "turn", value: audit.turn },
      { label: "kind", value: gap.kind },
      { label: "missing", value: `${gap.missing} of ${gap.parsed}` },
      { label: "lines", value: gap.lines.join(" · ") },
    ];
    let card = this.alerts.find((a) => a.key === key && a.status === "open");
    if (!card) {
      card = {
        id: randomUUID().slice(0, 8),
        key,
        rule: "unactioned",
        severity: "bad",
        thread: audit.thread || null,
        turnId: audit.turn,
        kind: gap.kind,
        title: `turn ${audit.turn} · ${gap.kind}: ${gap.missing} command line${gap.missing === 1 ? "" : "s"} never carried out`,
        detail,
        evidence,
        at: nowIso(),
        status: "open",
        level: "alert",
        // The turn this ledger reconciles decides the owner: an assistant's own turn is its alert, #1 included.
        assistantId: this.assistantIdForThread(audit.thread) || PRIMARY_ASSISTANT,
      };
      this.alerts.push(card);
      if (this.alerts.length > ALERT_CAP) this.alerts.splice(0, this.alerts.length - ALERT_CAP);
    } else {
      card.detail = detail;
      card.evidence = evidence;
      card.title = `turn ${audit.turn} · ${gap.kind}: ${gap.missing} command line${gap.missing === 1 ? "" : "s"} never carried out`;
    }
    // Once per count, not once per pass: a SPAWN that keeps returning no run must not write the same line every
    // five seconds, and the card above already carries the current number.
    const said = Number(audit.reported?.[gap.kind] || 0);
    if (said !== gap.missing) {
      audit.reported = { ...(audit.reported || {}), [gap.kind]: gap.missing };
      this.journalAdd(
        "command-unactioned",
        audit.thread || null,
        `${gap.kind} — ${gap.missing} of ${gap.parsed} line${gap.parsed === 1 ? "" : "s"} in turn ${audit.turn} were never carried out: ${shown}`,
      );
    }
    audit.reportedAt = nowIso();
    return card;
  }

  // Every sentry pass: a turn of ANY assistant's own that this process never harvested still has its lines in the
  // job store, so its ledger can be opened and reconciled here. That is the restart-mid-turn path: `harvest` only
  // ever runs when a turn ends, and a turn the panel restarted never ended. The filter is the assistant thread
  // SET, not `ASSISTANT_THREAD`: a turn a restart cut in half on #2's thread is #2's turn, and reading only #1's
  // skipped it, and the QUEUE line it had written, for every assistant the panel ever created. The set includes
  // the threads a hard restart left behind, because those are still that assistant's turns.
  async checkCommandAudit(list = this.jobs.list(), now = Date.now()) {
    if (this.auditMode() === "off") return [];
    const threads = new Set(this.assistantThreads());
    const out = [];
    for (const job of list || []) {
      if (!job?.id || isLive(job) || !threads.has(String(job.thread || ""))) continue;
      let audit = this.findAudit(job.id);
      if (!audit) {
        // A turn this process already harvested has no ledger only when the audit was off (or did not exist) when
        // it ran; its zero applied count is history, not a hole.
        if (this.harvested.has(job.id)) continue;
        const ended = endedAtMs(job);
        if (!ended || now - ended > COMMAND_AUDIT_WINDOW_MS) continue;
        audit = this.openAudit(job, turnProse(job.lines));
        if (!audit) continue;
      }
      if (audit.replay && !audit.replayedAt) {
        const replayed = await this.replayAudit(audit);
        if (replayed) out.push(replayed);
        continue;
      }
      // The same route `harvest` takes, so the enforce arm and the card are one decision in one place.
      out.push(...this.settleAudit(audit));
    }
    this.writeNow();
    return out.filter(Boolean);
  }

  // `commandAudit: enforce` — carry the lines nothing accounts for a second time, ONCE. Only those lines: an
  // action that already ran is never re-run, or enforce would send every TO on the turn twice.
  async replayAudit(audit) {
    audit.replay = null;
    audit.replayedAt = nowIso();
    const missing = (audit.lines || []).filter((l) => l.parsed && l.outcome !== "applied" && l.outcome !== "refused");
    if (!missing.length) {
      this.persist();
      return null;
    }
    for (const l of missing) l.outcome = null;
    const text = missing.map((l) => l.line).join("\n");
    this.journalAdd(
      "command-replay",
      audit.thread || null,
      `turn ${audit.turn}: replaying ${missing.length} command line${missing.length === 1 ? "" : "s"} the panel never carried out`,
    );
    const job = { id: audit.turn, thread: audit.thread || ASSISTANT_THREAD, lines: [] };
    return this.applyActions(job, parseActions(text), audit);
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

  // ---- the spawn debt ------------------------------------------------------------------------
  //
  // A SPAWN line is a claim about the future, and the board can only show claims that came true: a worker has a
  // card, a card has a Start button. Two failures fall between those, and both were silent until this pass.
  //
  //   1. The line became a CARD and nobody clicked it. Four of those sat open for an evening (19:54, 19:57,
  //      19:58, 20:00) behind a badge number, and the reader concluded the agents had failed to spawn.
  //   2. The line became NOTHING: no job, no card, no journal entry — the charter's open question, and the
  //      reason a debt is written to disk before a line is carried out.
  //
  // Nothing here starts anything. The card is the reader's click; the watchdog only makes waiting and vanishing
  // impossible to miss.

  // One record per SPAWN line, keyed by turn + target + prompt so the harvest and the board scan cannot record
  // the same line twice. `outcome` starts null — owed — and becomes card | job | skipped | failed | lost.
  noteSpawnIntent(job, sp, at = null) {
    const target = String(sp?.target || "");
    const prompt = clip(sp?.prompt || "", 240);
    const turnId = job?.id ? String(job.id) : null;
    const existing = this.spawnIntents.find(
      (x) => x.turnId === turnId && x.target === target && x.prompt.slice(0, 80) === prompt.slice(0, 80),
    );
    if (existing) return existing;
    const item = {
      id: randomUUID().slice(0, 8),
      turnId,
      thread: job?.thread || ASSISTANT_THREAD,
      at: Number(at) || this.nowMs(),
      target,
      existing: Boolean(sp?.existing),
      // WHICH queue row this line is carrying out, when it named one. The id rides the debt so a boot that
      // replays the same line can ask the row whether it is already linked and re-link instead of cutting a
      // second tree for work that is already running.
      taskId: Number(sp?.taskId) > 0 ? Number(sp.taskId) : null,
      prompt,
      outcome: null,
      alertId: null,
      jobThread: null,
      reportedAt: null,
    };
    this.spawnIntents.push(item);
    if (this.spawnIntents.length > SPAWN_INTENT_CAP) this.spawnIntents.splice(0, this.spawnIntents.length - SPAWN_INTENT_CAP);
    // On disk BEFORE the line is carried out, not after: a restart in between must leave the debt visible
    // rather than a turn that reads as harvested with nothing in it.
    this.persist();
    this.writeNow();
    return item;
  }

  settleSpawnIntent(item, outcome, { alertId = null, jobThread = null, job = null } = {}) {
    if (!item) return null;
    item.outcome = outcome;
    if (alertId) item.alertId = alertId;
    if (jobThread) item.jobThread = jobThread;
    // Where the brief actually went, recorded on the debt itself. A replay at boot has to ask whether THAT tree's
    // work landed, and the job is the only thing that knows the tree and the branch — reading them back off the
    // board later means guessing which of a project's trees the line meant.
    if (job) {
      const tree = String(job.cwd || job.tree?.path || "").trim();
      if (tree) item.tree = tree;
      const branch = String(job.branch || job.branchName || "").trim();
      if (branch) item.branch = branch;
    }
    this.persist();
    return item;
  }

  // ---- the replay a boot must NOT make ---------------------------------------------------------
  //
  // A SPAWN debt that is still owed (or already reported lost) is a line the next turn is invited to carry out
  // again: that is the replay. The failure it causes is a boot that restarts a brief whose work is already on main —
  // another worker on the same job, another harvest, and the same restart asked for again. So before a lost intent
  // can be replayed, its own tree answers one question: has this brief's work already landed?
  //
  // The answer is patch-id / tree equality against main, never "ahead by N" (see ./assistant/landed.js), and the
  // three skips are: the tree is gone, the work is on main, or the PR reads MERGED. A skip is settled as "landed"
  // with the evidence in the journal, so the digest stops advertising it and nothing starts.
  // "Gone" is not only a missing path: a `.worktrees/` entry removed while its EMPTY directory stayed behind
  // still passes `existsSync`, and git there answers for the PRIMARY checkout — so landed.js asks whether the
  // directory is a tree of its own (./own-tree.js) before it asks git anything.
  async skipLandedReplays({ now = Date.now(), force = false } = {}) {
    if (!force && this.landedCheckAt && now - this.landedCheckAt < 60_000) return [];
    const candidates = this.spawnIntents.filter((it) => !it.outcome || it.outcome === "lost");
    if (!candidates.length) return [];
    if (this.landedChecking) return [];
    this.landedChecking = true;
    this.landedCheckAt = now;
    const out = [];
    try {
      for (const it of candidates.slice(-8)) {
        const project = this.resolveProject(it.target);
        const tree = String(it.tree || (it.existing ? it.target : "") || "").trim();
        let verdict;
        try {
          verdict = await judgeLanded({ tree: tree || null, branch: it.branch || null });
          // A tree with work main does not hold is only a skip when its PR says it landed: a squash-merge rewrites
          // the patch, so `git cherry` cannot see it and the PR is the record that can.
          if (!verdict.landed && !verdict.gone) {
            const head = verdict.branch || it.branch || null;
            const pr = head ? await mergedPr(tree || project?.path || null, head) : null;
            if (pr) verdict = { ...verdict, landed: true, why: `its PR${pr.number ? ` #${pr.number}` : ""} reads MERGED`, evidence: "pr" };
          }
        } catch (e) {
          // A git or gh failure is not evidence of landing: leave the debt exactly as it was and say nothing.
          this.onLog(`assistant: could not judge spawn ${it.id} against main: ${String((e && e.message) || e)}`);
          continue;
        }
        // `gone` is a skip in its own right — the verdict ./assistant/landed.js returns when the debt's tree is
        // missing, or is a leftover directory whose git answers for the PRIMARY checkout. Settling it is the whole
        // point: before this, `gone` was computed, then dropped here, so the debt stayed owed and every boot
        // re-advertised it. Nothing can be replayed into a tree that is not there.
        if (!verdict.landed && !verdict.gone) continue;
        it.outcome = "landed";
        it.landedAt = nowIso();
        it.landedWhy = clip(verdict.why, 240);
        const what = `${it.existing ? "SPAWN IN" : "SPAWN"} ${clip(it.target || "(no target)", 60)}`;
        this.journalAdd(
          "replay-skipped",
          it.thread || null,
          `replay skipped: already landed — ${what} was owed for turn ${it.turnId || "unknown"}, and ${verdict.why}, so nothing was started${verdict.branch && verdict.base ? ` (${verdict.branch} against ${verdict.base})` : ""}`,
        );
        out.push(it);
        // One write per skip: a crash between two of them leaves the rest owed and they are judged again on the
        // next pass, which is the safe direction.
        this.persist();
        this.writeNow();
      }
    } finally {
      this.landedChecking = false;
    }
    if (out.length) {
      this.persist();
      this.emit();
    }
    return out;
  }

  // The two watchdogs, both on the injected clock. Called from `tick()`, so a card that sat unclicked and a line
  // that produced nothing are found by the sentry's own pass instead of by the reader noticing.
  checkSpawns(list = []) {
    const now = this.nowMs();

    // (1) A card still open after the window. One escalation per card: `idleAlertedAt` rides in the persisted
    // alert, so a restart does not shout twice and a reader who dismisses the escalation is not nagged hourly.
    for (const a of this.alerts) {
      if (a.status !== "open" || !a.spawn || a.idleAlertedAt) continue;
      const at = Date.parse(a.at || "") || 0;
      if (!at || now - at < SPAWN_WATCH_MS) continue;
      const prompt = String(a.spawn.prompt || "");
      const turn = a.spawn.turnId || null;
      const detail = `turn ${turn || "unknown"} proposed “${clip(prompt, 60)}” — the card has waited ${minutes(now - at)} for a click and nothing has started.`;
      this.fired("spawnidle", a.id, {
        thread: a.spawn.thread || null,
        turnId: turn,
        title: "spawn card unclicked for 2m",
        detail,
        evidence: [
          { label: "turn", value: turn || "unknown" },
          { label: "prompt", value: clip(prompt, 60) },
          { label: "waiting", value: minutes(now - at) },
          { label: "card", value: a.id },
        ],
        severity: "warn",
      });
      a.idleAlertedAt = new Date(now).toISOString();
      this.persist();
    }

    // (2) A line that became nothing. The harvest records the debt before it carries the line out; this scan is
    // the other half — a turn whose SPAWN line the harvest never read at all, because the stream can deliver
    // the last paragraph after the job was marked done and the turn is then marked harvested with the line
    // still only in its console. Re-reading is safe: `noteSpawnIntent` returns the record it already has.
    //
    // Only turns that ended inside this process's own watch: a panel up for a week would otherwise alert about
    // a week of history on every restart. The grace covers a restart in the two minutes a debt may still settle.
    const turns = (list || [])
      .filter((j) => j && j.thread === ASSISTANT_THREAD && !isLive(j))
      .map((j) => ({ j, ended: endedAtMs(j) }))
      .filter((x) => x.ended && x.ended >= this.bootedAt - SPAWN_WATCH_MS && now - x.ended >= SPAWN_WATCH_MS)
      .sort((a, b) => b.ended - a.ended)
      .slice(0, 20);
    for (const { j, ended } of turns) {
      // A turn whose console has not moved since the last read is not re-parsed on every five-second pass.
      const sig = `${(j.lines || []).length}|${(j.lines || []).slice(-1)[0]?.at || 0}`;
      if (this.spawnScanned.get(j.id) === sig) continue;
      this.spawnScanned.set(j.id, sig);
      if (this.spawnScanned.size > 80) this.spawnScanned = new Map([...this.spawnScanned].slice(-40));
      let acts = null;
      try {
        acts = parseActions(turnProse(j.lines));
      } catch {
        acts = null;
      }
      for (const sp of acts?.spawn || []) this.noteSpawnIntent(j, sp, ended);
    }

    // A debt older than the window with no outcome: the line is lost, and saying so is the whole point.
    for (const it of this.spawnIntents) {
      if (it.outcome) continue;
      if (now - Number(it.at || 0) < SPAWN_WATCH_MS) continue;
      const what = `${it.existing ? "SPAWN IN" : "SPAWN"} ${clip(it.target || "(no target)", 60)}`;
      const detail = `turn ${it.turnId || "unknown"} wrote ${what} and neither a worker nor a card exists for it ${minutes(now - it.at)} later`;
      this.fired("spawnlost", it.id, {
        thread: it.thread || null,
        turnId: it.turnId || null,
        title: "a SPAWN line produced nothing",
        detail: `${detail} — it asked for “${clip(it.prompt, 60)}”.`,
        evidence: [
          { label: "turn", value: it.turnId || "unknown" },
          { label: "line", value: what },
          { label: "prompt", value: clip(it.prompt, 60) },
          { label: "waiting", value: minutes(now - it.at) },
        ],
        severity: "bad",
      });
      it.outcome = "lost";
      it.reportedAt = new Date(now).toISOString();
      this.persist();
    }
  }

  // ---- the files a turn holds, and the two lines that hand them on -------------------------------
  //
  // The chain this closes: the reader drops a file on the reply box, POST /api/attachments stores it
  // under config.attachmentsDir and answers with its ABSOLUTE PATH, the page appends `Attachment: <path>
  // — read_file it before answering.` to the reader's message, and the assistant reads that message and
  // writes a SPAWN line. The worker it started used to get the brief and nothing else: a file the reader
  // attached "for the worker" reached the assistant and stopped there. This is the middle.
  //
  // A MESSAGE line is the second door out of the same turn, and it carried words only — an assistant's own
  // attachments stopped at the assistant. Both lines now read the same three sources through this one gate.
  //
  // THREE SOURCES, ONE ANSWER. A turn's attachments are the ones the store recorded on it (a reply and a
  // steer both carry a list), the ones the page appended to the message the turn was started with, and
  // the ones the line being read wrote itself. All three are text or records somebody else produced, so
  // all three go through the same gate before anything is handed on.
  //
  // THE BOUNDARY, and it is not negotiable: only a path INSIDE config.attachmentsDir may be inherited.
  // Every other path is dropped — and said, in the receiver's input, on its card and in the journal —
  // because a line must never be able to hand anything an arbitrary file by writing `Attachment: <path>`
  // in its own text. That is also why the written line's own Attachment: lines are STRIPPED and rebuilt
  // rather than trusted: the block the receiver gets is the panel's, made of paths the panel stored, so a
  // line an assistant wrote cannot smuggle a path past the gate by dressing it up in the browser's own
  // format. `written` is that line's text, and it comes back with those lines taken out; nothing else in
  // it is touched.
  turnInheritance(job, written = "") {
    const dir = this.attachmentsDir;
    const recorded = inheritAttachments(job?.attachments, dir);
    const message = inheritAttachments(parseAttachmentBlock(job?.prompt || ""), dir);
    const claimedText = stripAttachmentLines(String(written ?? ""));
    const claimed = inheritAttachments(claimedText.found, dir);
    const merge = (...lists) => {
      const seen = new Set();
      const out = [];
      for (const a of lists.flat()) {
        const key = String(a?.path || "").toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(a);
      }
      return out;
    };
    return {
      // The text with the writing line's own Attachment: lines gone, everything else byte for byte as written.
      text: claimedText.text,
      // What the turn claims, split by the gate. `say` and `startSpawn` run the same gate again over the
      // lists before anything is written or sent, so a spec that reached them some other way (the
      // /api/assistant/spawn route takes one) cannot skip it.
      keep: merge(recorded.keep, message.keep, claimed.keep),
      dropped: merge(recorded.dropped, message.dropped, claimed.dropped),
    };
  }

  // A SPAWN line: the prompt the child is given, and the files (and refusals) it carries.
  spawnInheritance(job, sp) {
    const turn = this.turnInheritance(job, sp?.prompt);
    return { prompt: turn.text, keep: turn.keep, dropped: turn.dropped };
  }

  // ---- the files a MESSAGE line hands on ----------------------------------------------------------
  //
  // A MESSAGE line was the one hand-over in the grammar that carried words only: the Director's turn was
  // handed an image, and the assistant it messaged — and the worker that assistant then starts — never saw
  // the file, because `say()` was called with the sentence and nothing else. The same three sources a SPAWN
  // reads are the answer here, through the same gate, for the same reason: an assistant messaging an
  // assistant is the panel handing a file on, and only a path the panel stored may be handed on.
  //
  // The written text comes back stripped of its own Attachment: lines, so the receiver's prompt carries the
  // panel's block (built at `say`, from verified paths) and never a line another assistant typed into the
  // message. A line that is ONLY such a line has no words left, and the caller refuses it by name.
  messageInheritance(job, text) {
    return this.turnInheritance(job, text);
  }

  // A SPAWN line in `ask` mode: one card, with everything the reader needs to judge it before any git
  // command runs — the project, where the tree goes, and the exact prompt the worker would get.
  addSpawnAlert(sp, { turn = null, assistantId = PRIMARY_ASSISTANT } = {}) {
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
        // The reader attached a file to the message this line came from: the card says the worker will be handed
        // it, because that is part of what the reader is judging.
        ...(Array.isArray(sp.attachments) && sp.attachments.length
          ? [{ label: "attachments", value: sp.attachments.map((a) => a.name).join(", ").slice(0, 160) }]
          : []),
        { label: "model", value: "gateway default" },
      ],
      at: this.atIso(),
      status: "open",
      level: "alert",
      // WHICH assistant proposed this card, stamped for #1 as well (the spawn strip is filtered on it). The record
      // inside `spawn` keeps its own rule — only an extra assistant is stamped there, because the press path reads a
      // missing stamp as #1 — but this alert is the row the page draws, so it always names its owner.
      assistantId: String(assistantId || PRIMARY_ASSISTANT),
      // Which turn proposed this card. The head shows the assistant's own thread when it is set, and the
      // watchdog names the turn when the card sits unclicked — the difference between "a worker I meant to
      // start" and "four cards from one evening".
      turnId: turn?.id || null,
      spawn: {
        // The tree the line named, not the project: a card has to start the worker where the reader read that it
        // would. Only a bare project name — the project's own checkout — is rewritten to that checkout's path; a
        // directory, a worktree directory name or a branch stays exactly as written, and the server resolves it
        // against git's worktree list (lib/spawn-target.js) so a renamed tree is still found.
        target: project && normPath(project.name) === normPath(sp.target) ? project.path : String(sp.target),
        project: project?.name || null,
        existing: Boolean(sp.existing),
        prompt: sp.prompt,
        // The queue row the line named, if any. A card is a detour: the row is linked when the press actually
        // cuts the job, not when the assistant wrote the line, so the id has to travel with the card.
        taskId: Number(sp?.taskId) > 0 ? Number(sp.taskId) : null,
        turnId: turn?.id || null,
        thread: turn?.thread || null,
        // WHICH assistant proposed this card. A card is pressed by the reader, possibly much later, and the press
        // must be judged at the settings of the assistant that asked for it — its spawn switch and its whitelists.
        // Stamped ONLY for an extra assistant: a card Assistant #1 makes stays byte-identical to the record the panel
        // wrote before assistants had settings of their own, and the press path reads a missing stamp as #1.
        ...(String(assistantId || PRIMARY_ASSISTANT) === PRIMARY_ASSISTANT ? {} : { assistantId: String(assistantId) }),
        // The TODO lines the assistant wrote under this SPAWN: they are the tree's list, and they are seeded when the
        // card is actually started (this alert is the ask-mode detour — nothing has been cut yet, so there is no tree
        // to key them on).
        todos: Array.isArray(sp.todos) ? sp.todos.map(String) : [],
        // The files this SPAWN hands the worker, and the ones it refused. A card is a detour, not a different act:
        // the press has to start the same run the auto path would have, so both lists travel WITH the card — and
        // `startSpawn` puts them through the gate again on the press, the way it does for any spec.
        attachments: Array.isArray(sp.attachments) ? sp.attachments : [],
        attachmentDropped: Array.isArray(sp.attachmentDropped) ? sp.attachmentDropped : [],
      },
    };
    this.alerts.push(alert);
    if (this.alerts.length > ALERT_CAP) this.alerts.splice(0, this.alerts.length - ALERT_CAP);
    this.journalAdd("spawn-draft", null, `${alert.title}: ${clip(sp.prompt, 140)}`);
    // The card now exists and nothing else does: no job, no thread, no row. Arm the one check that will look
    // at it again (see the spawn watchdog below).
    this.armSpawnWatch(alert);
    this.persist();
    this.emit();
    return alert;
  }

  /**
   * Make a tree this assistant started in its own, once, and only when nobody else owns it. The reader's existing
   * answer always wins -- a handover is theirs to undo -- and Assistant #1 needs no record, because absence IS #1.
   * A tree the panel cannot place in a project has no owner key, so nothing is written and the run's own stamp still
   * routes its wakes.
   */
  claimTreeFor(job, assistantId) {
    const tree = jobTreePath(job) || null;
    const who = String(assistantId || "").trim();
    if (!this.locks || !tree || !who) return null;
    const project = job?.project || job?.origin?.project || this.projectNameFor(tree);
    if (!project) return null;
    const had = this.ownerOfTree({ path: tree, project, branch: job?.branch || null });
    if (had) return { ok: true, key: null, owner: had, changed: false };
    if (who === PRIMARY_ASSISTANT) return null;
    const out = this.locks.setOwner({ project, path: tree, branch: job?.branch || null }, who);
    if (out?.ok && out.changed) {
      this.journalAdd("spawned", job?.thread || null, `${tree} is ${who}'s worktree now -- its wakes go to that assistant`);
      this.persist();
    }
    return out;
  }

  pendingSpawn(id) {
    const a = this.alerts.find((x) => x.id === id);
    return a && a.status === "open" && a.spawn ? a.spawn : null;
  }

  // Runs it. The server owns what this means (probe the gateway, refuse an unborn HEAD, cut the tree,
  // start the run); this only records the outcome and closes the card.
  async startSpawn(spawn, { alertId = null, source = "reader", assistantId = null } = {}) {
    if (!this.spawner) throw new Error("this panel cannot start agents");
    const spec = { ...(spawn || {}) };
    if (!String(spec.prompt || "").trim()) throw new Error("a spawn needs a prompt");
    // Whose card this is: the assistant that proposed it, or — for a card with no stamp, and for every SPAWN the
    // panel starts without a card — Assistant #1. There is no whitelist to re-check: the SPAWN switch was the only
    // gate, and it was checked where the line was read.
    const who = String(spec.assistantId || assistantId || PRIMARY_ASSISTANT);
    // The stamp travels WITH the spec: the run carries it (`job.assistantId`), which is what the job store shows
    // and what `assistantIdForJob` reads for a tree nobody has handed anywhere. It is a copy of an id the card
    // already held, not a new claim.
    spec.assistantId = who;
    // The row this SPAWN carries out, if it named one: checked HERE, before anything is cut, because a card is
    // pressed later than it was written and the row may have finished, moved or vanished in between. A refusal
    // throws before the spawner runs, so nothing is cut and no run is started.
    const taskId = Number(spec.taskId) > 0 ? Number(spec.taskId) : null;
    spec.taskId = taskId;
    // What this line is, in the terms the journal and the digest read: the form (SPAWN / SPAWN IN), the row it
    // names when it names one, and the target. One string, so a refusal written here and one written by the
    // harvest cannot describe two different lines.
    const what = `${spec.existing ? "SPAWN IN" : "SPAWN"}${taskId ? ` #${taskId}` : ""} ${clip(spec.target || spec.project || "(no target)", 80)}`;
    if (taskId) {
      const refusal = this.spawnTaskRefusal(who, taskId);
      if (refusal) {
        // Journaled HERE as well as at the harvest: a card the reader presses and the /api/assistant/spawn route
        // arrive without passing the harvest's pre-check, and an assistant that cannot see its own refused
        // duplicate re-writes the same line on the next wake. One line, naming the row and the reason.
        this.journalAdd("spawn-refused", null, `${what}: ${refusal} — nothing was cut`);
        throw Object.assign(new Error(refusal), { code: "spawn-task", journalled: true });
      }
    }
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
    // THE GATE, asked once more, here, because this is the one point every way of starting a worker passes through:
    // the harvest's SPAWN line, a card the reader pressed, and the /api/assistant/spawn route that takes a spec from
    // a caller. A path outside the panel's attachments directory is never inherited, whatever named it — and the
    // block the child's input carries is BUILT HERE from the verified list, so a block that arrived on the spec
    // cannot smuggle a path past this line either.
    const claimed = [
      ...(Array.isArray(spec.attachments) ? spec.attachments : []),
      ...(Array.isArray(spec.attachmentDropped) ? spec.attachmentDropped : []),
    ];
    const gated = inheritAttachments(claimed, this.attachmentsDir);
    const inherited = gated.keep;
    const refused = gated.dropped;
    spec.attachments = inherited;
    spec.attachmentBlock = inheritanceBlock(inherited, refused, this.attachmentsDir);
    spec.attachmentNotes = refused.map((a) => `⇢ ${droppedAttachmentLine(a, this.attachmentsDir)}`);
    let job;
    try {
      job = await this.spawner(spec);
    } catch (e) {
      // The spawner's own refusal at the cut: the tree already holds a live run (lib/jobs.js `create`). It is
      // written to the journal before it is rethrown, so the assistant reads its own duplicate on the next wake
      // instead of inferring it from a board that did not move; `journalled` is what keeps `carry` from writing
      // the same refusal a second time as a generic `spawn-failed`.
      if (e?.code === "tree_busy") {
        this.journalAdd("spawn-refused", e.holder?.thread || null, `${what}: ${e.message} — nothing was cut`);
        e.journalled = true;
      }
      throw e;
    }
    // A spawner that resolves with no run started nothing: no tree was cut, no row was linked and there is no watch
    // to add. Returning here leaves the SPAWN line unaccounted, which is exactly what the command audit and the spawn
    // watchdog exist to name. Reading `.cwd` off the missing run used to throw instead, and `carry` booked the line
    // as a REFUSAL, so a SPAWN that produced nothing was counted as accounted for by both of them.
    if (!job?.id) return null;
    // The row that asked for this run, written AT the cut: thread, worktree, running and startedAt in one record,
    // so there is no follow-up edit to remember and no window in which a live worker sits under a row reading
    // `queued`. A link that cannot be written is journalled rather than thrown: the worker exists, and a refused
    // line here would invite a second one.
    if (taskId) this.linkSpawnTask(who, taskId, job, { project: spec.project || null });
    // The files this worker was handed go on ITS OWN record, through the one attachment writer the store has — the
    // same call a steer makes, so the child's card draws the same chips the reader's turn does and a restart keeps
    // them. The input already names them (the spawner put `attachmentBlock` in the run's request); this is the
    // record, and it is written here rather than in the spawner so an injected spawner cannot skip it.
    if (inherited.length && job?.id && typeof this.jobs?.addAttachments === "function") {
      this.jobs.addAttachments(job.id, inherited);
    }
    // The tree this run just got is THIS assistant's: a worker #2 started in a tree nobody had moved is the whole of
    // "Assistant #2 owns its own run", and writing the owner here is what makes the row's owner cell and the wake
    // routing agree without the reader pressing anything.
    this.claimTreeFor(job, who);
    // A name that had to be resolved to a real tree is said ON THE CARD, not only in the journal: the reader
    // judged this card, so which tree it actually started in is this card's answer. The server found it
    // (lib/spawn-target.js) and left it on the run's origin.
    const fit = job?.origin?.resolvedPath ? job.origin : null;
    const a = alertId ? this.alerts.find((x) => x.id === alertId) : null;
    // The reader pressed Start: whatever the watchdog was going to say about this card, it has an answer now.
    if (a) this.disarmSpawnWatch(a.id);
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
    // how it ended", instead of the thread disappearing into a row somewhere on the board. The watch is stamped with
    // the assistant whose turn spawned it (`who`), so it appears in THAT assistant's list and nobody else's.
    if (job?.thread && !this.watches.some((w) => w.thread === job.thread && w.state !== "done")) {
      this.addWatch({ thread: job.thread, title: `spawned: ${clip(spec.prompt, 90)}`, assistantId: who }, "assistant");
    }
    this.journalAdd("spawned", job?.thread || null, `${spec.existing ? `in ${fit?.resolvedPath || spec.target}` : `new worktree in ${spec.project || spec.target}`}: ${clip(spec.prompt, 160)} (${source})`);
    // What the worker was handed, and what it was not. Both are journal lines rather than a note on the card alone:
    // the assistant reads this journal on its next wake, and a file it meant to pass on that never arrived is
    // exactly the kind of thing it has to be able to find out without asking the reader.
    if (inherited.length) {
      this.journalAdd(
        "attachments",
        job?.thread || null,
        `inherited ${inherited.length} attachment${inherited.length === 1 ? "" : "s"} from the turn: ${inherited.map((a) => a.name).join(", ")}`,
      );
    }
    for (const a of Array.isArray(spec.attachmentNotes) ? spec.attachmentNotes : []) {
      this.journalAdd("attachment-dropped", job?.thread || null, String(a).replace(/^⇢\s*/, ""));
    }
    this.persist();
    this.emit();
    return job;
  }

  // ---- the spawn watchdog ----------------------------------------------------------------------
  //
  // A spawn card is the one thing this panel creates that changes nothing else: a SPAWN line at `ask` produces
  // an alert and stops. No job, no thread, no row, no git command. Every other view of the board is honest
  // about that — there is simply nothing to show — so a card nobody pressed used to sit in the alerts list for
  // as long as the reader did not look, and the assistant found out only when it was asked.
  //
  // The watchdog is one timer per card, plus the same question asked on every sentry pass, because a setTimeout
  // does not survive a restart. When the deadline passes it looks for a run that belongs to the card and there
  // are only two answers: one exists, so the card is closed against it without a word; or none does, and the
  // card is named out loud, counted on its own badge and written to the journal the assistant reads.

  // The path this card is about, in words the reader can act on. A new-worktree card has no tree yet, so it
  // names the tree that would be cut; a SPAWN IN names the directory (or the branch, when that is what the
  // assistant wrote).
  spawnTreePath(spawn = {}) {
    const raw = String(spawn.target || "").trim();
    const project = this.resolveProject(raw);
    if (!spawn.existing) {
      const root = project ? String(project.path).replace(/\\/g, "/") : raw || "(unknown project)";
      return `${root}/.worktrees/<the tree this card creates>`;
    }
    if (project && normPath(project.name) === normPath(raw)) return String(project.path).replace(/\\/g, "/");
    return raw || "(no directory)";
  }

  // Is there a run for this card? A card that was never started has no job and no thread, so the job store is
  // the only place that can say otherwise. Three links are evidence, in order of how much they prove: the run
  // the panel recorded on the card, the thread the card (or the SPAWN IN line) names, and a run standing in the
  // tree the card is about. Anything else is somebody else's work — a job in the project's own checkout is NOT
  // this card's run, which is the false positive that would make the whole watchdog worthless.
  jobForSpawn(spawn = {}, alert = null) {
    const list = typeof this.jobs?.list === "function" ? this.jobs.list() : [];
    if (!Array.isArray(list) || !list.length) return null;
    // "running or already finished": a cancelled or refused run is not a worker that exists.
    const standing = (j) => Boolean(j) && !/cancel/i.test(String(j.status || ""));
    const tracked = alert?.startedJob ? list.find((j) => j.id === alert.startedJob) : null;
    if (standing(tracked)) return tracked;
    const thread = String(alert?.thread || spawn.thread || "").trim();
    if (thread) {
      const byThread = list.find((j) => j.thread === thread);
      if (standing(byThread)) return byThread;
    }
    const tail = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop() || "";
    const want = new Set([spawn.target, spawn.cwd].filter(Boolean).map(normPath));
    const treesOf = (j) => [j.cwd, j.ownerPath, j.worktreePath].filter(Boolean).map(normPath);
    const project = this.resolveProject(spawn.target);
    const root = project ? normPath(project.path) : null;
    const prompt = String(spawn.prompt || "").replace(/\s+/g, " ").trim();
    return (
      list.find((j) => {
        if (!standing(j)) return false;
        const trees = treesOf(j);
        // The tree the card names — by full path, by directory name, or by the branch a SPAWN IN may write
        // instead of a path (lib/spawn-target.js resolves all three; so does this).
        if (trees.some((p) => want.has(p))) return true;
        if (spawn.existing) {
          if (j.branch && String(j.branch) === String(spawn.target || "")) return true;
          return trees.some((p) => tail(p) === normPath(spawn.target));
        }
        // A card that would cut a tree has no tree yet. The run that belongs to it is the same ask, running
        // somewhere under that project's `.worktrees/` — the project's own checkout excluded, because every
        // other worker in that project names it too.
        if (!root || !prompt) return false;
        if (String(j.prompt || "").replace(/\s+/g, " ").trim() !== prompt) return false;
        return trees.some((p) => p.startsWith(`${root}/.worktrees/`));
      }) || null
    );
  }

  // What the page's own spawn badge reads: how many cards are waiting on the reader, how many of those the
  // watchdog has already named, and when the soonest one is due.
  //
  // `byAssistant` is the same three numbers per owner, resolved through `alertOwnerOf`, because the strip and the
  // badge can be narrowed to one assistant: a panel-wide total would put #2's cards back on #1's strip the moment
  // the page had no rows of its own to count.
  spawnCardState() {
    const open = this.alerts.filter((a) => a.status === "open" && a.spawn);
    const due = open.map((a) => Date.parse(a.spawnWatch?.dueAt || "") || 0).filter(Boolean).sort((a, b) => a - b);
    const byAssistant = {};
    for (const a of open) {
      const id = this.alertOwnerOf(a);
      const row = (byAssistant[id] ||= { open: 0, unstarted: 0, nextDueAt: null });
      row.open += 1;
      if (a.stuck) row.unstarted += 1;
      const dueAt = Date.parse(a.spawnWatch?.dueAt || "") || 0;
      if (dueAt && (!row.nextDueAt || dueAt < row.nextDueAt)) row.nextDueAt = dueAt;
    }
    return {
      open: open.length,
      unstarted: open.filter((a) => a.stuck).length,
      nextDueAt: due.length ? due[0] : null,
      autoStart: Boolean(this.settings.spawnAutoStart),
      byAssistant,
    };
  }

  armSpawnWatch(alert) {
    if (!alert?.id || !alert.spawn || alert.status !== "open") return null;
    // The deadline is recorded ON the card as well as in a timer: a restart clears every setTimeout, and a card
    // that was seconds from being reported would otherwise go quiet for good.
    const armedAt = alert.spawnWatch?.armedAt || nowIso();
    const from = Date.parse(armedAt) || Date.now();
    alert.spawnWatch = {
      ...(alert.spawnWatch || {}),
      armedAt: new Date(from).toISOString(),
      dueAt: new Date(from + this.spawnWatchMs).toISOString(),
      reportedAt: alert.spawnWatch?.reportedAt || null,
      autoTriedAt: alert.spawnWatch?.autoTriedAt || null,
    };
    this.armSpawnTimer(alert);
    this.persist();
    return alert.spawnWatch;
  }

  armSpawnTimer(alert) {
    const id = alert?.id;
    const dueAt = Date.parse(alert?.spawnWatch?.dueAt || "");
    if (!id || !Number.isFinite(dueAt)) return;
    this.disarmSpawnWatch(id);
    const timer = setTimeout(() => {
      this.spawnTimers.delete(id);
      try {
        this.expireSpawnWatch(id);
      } catch (err) {
        this.onLog(`assistant: spawn watchdog failed: ${String((err && err.message) || err)}`);
      }
    }, Math.max(0, dueAt - Date.now()));
    timer.unref?.();
    this.spawnTimers.set(id, timer);
  }

  disarmSpawnWatch(id) {
    const timer = this.spawnTimers.get(id);
    if (timer) clearTimeout(timer);
    this.spawnTimers.delete(id);
  }

  // Re-arm every open card from its own record. Called on boot and by `checkSpawnWatches` when a timer has been
  // lost some other way; it decides nothing, so it is safe at any moment.
  rearmSpawnWatches() {
    for (const alert of this.alerts) {
      if (alert.status !== "open" || !alert.spawn) continue;
      if (!alert.spawnWatch?.dueAt || alert.spawnWatch.reportedAt) continue;
      if (this.spawnTimers.has(alert.id)) continue;
      this.armSpawnTimer(alert);
    }
  }

  // The clock, asked the same question every sentry pass: a deadline kept only in a setTimeout is a deadline a
  // restart can lose. Cheap — a field read per open spawn card.
  checkSpawnWatches(now = Date.now()) {
    for (const alert of this.alerts) {
      if (alert.status !== "open" || !alert.spawn) {
        if (this.spawnTimers.has(alert.id)) this.disarmSpawnWatch(alert.id);
        continue;
      }
      if (!alert.spawnWatch?.dueAt || alert.spawnWatch.reportedAt) continue;
      const dueAt = Date.parse(alert.spawnWatch.dueAt) || 0;
      if (!dueAt) continue;
      if (dueAt <= now) this.expireSpawnWatch(alert.id);
      else if (!this.spawnTimers.has(alert.id)) this.armSpawnTimer(alert);
    }
  }

  // The deadline has passed. Two answers, and only one of them needs the reader.
  expireSpawnWatch(id) {
    const alert = this.alerts.find((a) => a.id === id);
    this.disarmSpawnWatch(id);
    // A card the reader dismissed or started is not a pending spawn; one already reported is not news; and a
    // card the reader cancelled must never be revived by this.
    if (!alert || alert.status !== "open" || !alert.spawn) return null;
    if (!alert.spawnWatch?.dueAt || alert.spawnWatch.reportedAt) return null;
    const job = this.jobForSpawn(alert.spawn, alert);
    if (job) return this.markSpawnStarted(alert, job);
    // The switch says "start the pending spawn", not "keep trying": the attempt is recorded BEFORE it is made,
    // so a throw, a refusal or a gateway that is down cannot become a second press on the next pass.
    if (this.settings.spawnAutoStart && !alert.spawnWatch.autoTriedAt) {
      alert.spawnWatch = { ...alert.spawnWatch, autoTriedAt: nowIso() };
      this.persist();
      return this.autoStartSpawn(alert);
    }
    return this.reportSpawnUnstarted(alert);
  }

  // One attempt, through the SAME path the Start button takes, so it cannot skip the gateway probe, the
  // unborn-HEAD refusal, or the card's own bookkeeping. A refusal is a journal line and a loud card, never a
  // second try.
  autoStartSpawn(alert) {
    const waited = minutes((Date.parse(alert.spawnWatch.dueAt) || Date.now()) - (Date.parse(alert.spawnWatch.armedAt) || Date.now()));
    this.journalAdd("spawn-auto", null, `${alert.title} — no run after ${waited}, so auto-start is starting it once`);
    this.emit();
    return Promise.resolve()
      .then(() => this.startSpawn({ ...alert.spawn }, { alertId: alert.id, source: "auto-start" }))
      .catch((err) => {
        this.journalAdd("spawn-failed", null, `auto-start refused for ${alert.title} — ${reasonOf(err)}: nothing was started`);
        this.reportSpawnUnstarted(alert, { autoFailed: reasonOf(err) });
        return null;
      });
  }

  // The card has no run and its deadline has passed: say so where the reader is looking, count it on the spawn
  // badge, and write the line the assistant reads. Once per card — `reportedAt` is what keeps the second pass,
  // or the second process, silent.
  reportSpawnUnstarted(alert, { autoFailed = "" } = {}) {
    if (!alert || alert.spawnWatch?.reportedAt) return alert;
    const ageMs = Math.max(0, Date.now() - (Date.parse(alert.at) || Date.now()));
    const tree = this.spawnTreePath(alert.spawn);
    const age = minutes(ageMs);
    alert.spawnWatch = { ...(alert.spawnWatch || {}), reportedAt: nowIso() };
    alert.stuck = true;
    alert.stuckAt = alert.spawnWatch.reportedAt;
    alert.severity = "bad";
    alert.detail = `${alert.detail || ""}${alert.detail ? " · " : ""}NEVER STARTED — the card is ${age} old and there is no run in ${tree}${autoFailed ? ` (auto-start refused: ${clip(autoFailed, 120)})` : ""}`;
    alert.evidence = [...(alert.evidence || []), { label: "card age", value: age }, { label: "tree", value: tree }, { label: "run", value: "none" }];
    this.journalAdd("spawn-unstarted", alert.thread, `${alert.title} — no run ${age} after the card appeared, in ${tree}: ${clip(alert.spawn?.prompt, 120)}`);
    this.persist();
    this.emit();
    return alert;
  }

  // A run exists after all: the card is closed against it the way a press on its own button would have closed
  // it, and the reader is told nothing. A worker that exists is not news, and a warning about one that was
  // never actually missing is the kind of noise that teaches a reader to ignore the badge.
  markSpawnStarted(alert, job) {
    this.disarmSpawnWatch(alert.id);
    alert.status = "done";
    alert.closedAt = nowIso();
    alert.startedJob = job.id || alert.startedJob || null;
    alert.thread = job.thread || alert.thread || null;
    alert.spawnWatch = { ...(alert.spawnWatch || {}), settledAt: alert.closedAt, settledBy: "watchdog" };
    this.journalAdd("spawn-started", alert.thread, `${alert.title} — a run already exists (${job.id || job.thread || "no id"}), so the card was closed without a word`);
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

  // The aggressive-mode toggle. It returns what happened rather than a bare boolean, because both no-ops have to say
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
      this.journalAdd("settings", null, `refused ${refused.length} change${refused.length === 1 ? "" : "s"} — aggressive mode holds ${refused.join(", ")} (switch it off in its Settings tab to change them)`);
    }
    this.persist();
    this.emit();
    return this.settings;
  }

  // The two doors onto #1's list. The decisions — the 400-character text, the duplicate check, the assistant's
  // refinement of its OWN earlier rule, the oldest-assistant-rule trade at the cap — are ./assistant/rules.js's;
  // the journal, the charter entry, the persist and the emit are made there on this instance, so the text a
  // reader sees in the journal is unchanged.
  addRule(text, by = "reader") {
    return addRuleToAssistant(this, text, by);
  }

  removeRule(id) {
    return removeRuleFromAssistant(this, id);
  }

  addWatch({ thread, title, doneWhen = null, minutes = null, assistantId = null } = {}, by = "reader") {
    if (!thread) throw new Error("a watch needs a thread");
    const t = clip(title, 160);
    if (!t) throw new Error("a watch needs something to watch for");
    // WHOSE watch this is, stamped at creation from the turn (or the tab) that made it: an assistant's own turn
    // passes its id, and the reader's Watches tab passes the assistant it is showing. An id the roster does not
    // hold is dropped rather than written — the stamp is a claim about a real assistant, not a free field. Assistant
    // #1's records keep the shape every earlier build wrote (no stamp at all, resolved to #1 by `watchOwnerOf`), so
    // its list stays byte-identical and a legacy record and a new one read the same.
    const asked = String(assistantId || "").trim() || this.assistantIdForThread(thread);
    const owner = asked && this.assistants.some((a) => a.id === asked) ? asked : null;
    const watch = {
      id: randomUUID().slice(0, 8),
      thread,
      title: t,
      doneWhen: doneWhen ? clip(doneWhen, 200) : null,
      minutes: minutes ? Math.max(1, Math.min(24 * 60, Number(minutes))) : null,
      at: nowIso(),
      by,
      ...(owner && owner !== PRIMARY_ASSISTANT ? { assistantId: owner } : {}),
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
    // The reader save, and it is REFUSED over the cap rather than trimmed: the cap is exactly what a turn reads,
    // so a longer pad is bytes nobody sees, and trimming a paste silently drops the part the reader was looking at.
    const body = String(text || "");
    if (body.length > NOTES_CAP) {
      throw Object.assign(
        new Error(`the notes are ${body.length} characters and the cap is ${NOTES_CAP} — a turn reads only ${NOTES_CAP}; prune the oldest lines and save again`),
        { code: "notes-too-long" },
      );
    }
    this.notes = body;
    this.journalAdd("notes", null, `${this.notes.length} chars`);
    this.persist();
    this.emit();
    return this.notes;
  }

  /**
   * The Pad tab's save, for the assistant the reader is looking at. #1 goes through `setNotes` exactly as before;
   * an extra assistant's save writes its own notes.md and nothing else — assistant.json is not touched, so one
   * assistant's pad can never rewrite another's.
   */
  setNotesFor(id, text) {
    const wanted = String(id ?? "").trim();
    const rec = wanted ? this.assistants.find((a) => a.id === wanted) : this.assistantRecord(PRIMARY_ASSISTANT);
    if (!rec) throw Object.assign(new Error(`no such assistant: ${id}`), { code: "assistant-unknown" });
    if (rec.id === PRIMARY_ASSISTANT) {
      this.setNotes(text);
      return this.notesPayloadFor(rec.id);
    }
    const file = this.notesPathOf(rec);
    const out = writeNotesFile(file, text);
    if (out.error) {
      this.journalAdd("notes-failed", rec.threadId, `could not write ${file}: ${out.error}`);
      this.emit();
      throw new Error(out.error);
    }
    this.journalAdd("notes", rec.threadId, `${rec.name}'s pad saved (${out.chars} chars)`);
    this.emit();
    return this.notesPayloadFor(rec.id);
  }

  alertAction(id, action) {
    const a = this.alerts.find((x) => x.id === id);
    if (!a) throw new Error(`unknown alert: ${id}`);
    if (action === "dismiss") {
      a.status = "dismissed";
      a.closedAt = nowIso();
      // Cancelled is final: the spawn watchdog's timer is cleared here, and even if one were lost the card is
      // no longer `open`, so a dismissed card can never be auto-started later.
      this.disarmSpawnWatch(a.id);
      if (a.spawn) a.spawnWatch = { ...(a.spawnWatch || {}), cancelledAt: a.closedAt };
      this.journalAdd("dismissed", a.thread, a.title);
    } else if (action === "ask") {
      this.journalAdd("asked", a.thread, a.title);
      // Whose turn answers this: the assistant the alert was filed for, else the assistant that owns the run behind
      // it, else the alert's own thread. A hand-edited store that names nobody still lands on Assistant #1.
      const run = a.turnId ? this.jobs.get(a.turnId) : null;
      this.wake(`[${a.rule}] ${a.title}${a.detail ? ` — ${a.detail}` : ""}`, a.id, null, {
        assistantId: a.assistantId || this.assistantIdForJob(run) || null,
      });
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
    // The ledger is per ASSISTANT as well as per card: the turn that reads an ask is the turn of the assistant
    // the ask was routed to, and `observe` clears only that assistant's keys. A bare job id let any finished
    // assistant turn clear an ask it never read.
    const who = this.assistantIdForJob(job) || PRIMARY_ASSISTANT;
    const key = `${who}|${String(job.id || id)}`;
    const already = this.completeAsks.get(key);
    if (already) {
      // The same finished turn, asked twice, before the assistant has turned on the first ask: one thought, queued once.
      this.journalAdd("asked-complete", job.thread || null, `already queued at ${already} — nothing was queued twice`);
      this.persist();
      this.emit();
      return { ok: true, queued: false, duplicate: true, at: already, thread: job.thread || null };
    }
    const text = this.completeAskText(job);
    const wake = this.wake(text, null, "complete", { assistantId: who });
    if (!wake?.queued) {
      const reason = wake?.refused === "disabled"
        ? "the board assistant is switched off in Settings, so nothing was queued — switch it back on and press COMPLETE again"
        : `the assistant's wake budget is spent (${wake?.limit ?? this.settingsFor(who).maxWakesPerHour}/hour), so nothing was queued — raise it in Settings, or press COMPLETE again once the hour rolls over`;
      this.journalAdd("ask-refused", job.thread || null, reason);
      this.persist();
      this.emit();
      return { ok: true, queued: false, refused: wake?.refused || "refused", reason, thread: job.thread || null };
    }
    const at = nowIso();
    this.completeAsks.set(key, at);
    // Bounded like every other thing this module keeps: the map is cleared when that assistant's turn ends, so this
    // only trims a reader pressing COMPLETE across many cards without a turn in between.
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
      `worktree: ${jobTreePath(job) || "not recorded"}`,
      `branch: ${job.branch || tree.branch || "not recorded"}`,
      `run: ${job.runId || "not recorded"}`,
      measured,
      report,
      ``,
      `Judge whether this really is complete — on the evidence, not on the agent having said "done": are those commits actually on main (or in a PR that will get there), what state is that PR in, and does the report say what it proved and what it admits it did not?`,
      `Then say what still has to happen for that worktree or project — the merge, the claim nobody proved, the work left in the tree — and who owns it.`,
    ].join("\n");
    // NOT `clip`: that collapses every run of whitespace, which folds this list into one line and loses the one field
    // per line the assistant reads it as. ASK_TEXT_CAP is a length guard only, so the paragraph breaks survive it.
    return text.length > ASK_TEXT_CAP ? text.slice(0, ASK_TEXT_CAP) : text;
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
    // WHERE this reply runs: the tree the thread was created for, and only while that is still a tree of its own.
    // `stat().isDirectory()` said yes to the empty folder a release leaves behind — where every `git` call walks up
    // to the project's PRIMARY checkout — and fell back to the record's `cwd` when the folder was gone, which is the
    // same dead path. Both started a run whose cwd was not its own tree (the 0.62.1 boot: job 5ba56bf1, a TO line
    // replayed at thread wtgui-prove-two-assistants-running-4f046, released hours earlier). A refusal is journalled
    // by NAME with the tree and the checkout the run would have worked in, because the alternative is a reply that
    // silently edits the reader's own checkout. See ../own-tree.js.
    const tree = await replyTree(first);
    if (!tree.ok) {
      this.journalAdd(
        "reply-tree-refused",
        thread,
        `reply into ${thread} refused: ${tree.refusal} — nothing was sent and no run was started. A resume is not a new tree: open a new agent in a real worktree if its work still needs doing`,
      );
      const err = new Error(`${tree.refusal} — nothing was sent and no run was started. A resume is not a new tree.`);
      err.code = "tree_released";
      err.tree = tree.named;
      err.checkout = tree.instead || tree.outer || null;
      throw err;
    }
    const dir = tree.dir;
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
      // The tree the CARD is filed under, not the raw owner record: a card the old attach fallback filed on a
      // parent checkout must not hand that parent down to its replies (lib/job-trees.js `filedOwnerPath`).
      ownerPath: filedOwnerPath(first) || null,
    });
    // The row this reply is the resume of, if a queue row names that thread: the run id moves on the row here, at the
    // one moment it exists. A file that cannot be written is journalled by `linkResumedRun` and never fails the turn.
    this.linkResumedRun(thread, job);
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

// =====================================================================================================
// The Element room: every wait on a person, carried by the ONE bridge already running
// =====================================================================================================
//
// The Matrix bridge is a separate Python program and it already owns the protocol: the login, the E2EE room,
// the sync loop, the Hermes worker behind it. Nothing here speaks Matrix, starts a second client or writes a
// second pid file — the panel reuses the process it already supervises, through the two file-shaped channels
// that program exposes:
//
//   outbox.txt   the bridge polls it every few seconds, sends its whole text as ONE message and renames it to
//                outbox.sent. Writing that file IS sending; that is the entire outbound protocol.
//   its stdout   the panel spawned the bridge with `<logsDir>/matrix-bridge.log` as its stdout, and the
//                bridge prints every message it receives as `[HH:MM:SS] <- <room>: <body>`. Reading the new
//                lines of that log IS receiving.
//
// What travels is ONLY a wait a person can answer — a clarify card, a run's approval, the panel's own
// permission box — carrying its lettered options, plus an answer to a question the room asked. No stream, no
// status, no journal line: a room that narrates is a room nobody reads.
//
// The COUNT is the other half of the design. One message per wait, keyed by the wait's own key, so a repaint
// or a restart cannot send a second copy; when the wait resolves the same record is edited in place — its
// `text` gains the outcome — and nothing is re-sent. A send that fails becomes a record the Gateway block
// draws, never a swallowed error, and Retry re-sends THAT record rather than making another one.

const ELEMENT_MESSAGE_CAP = 80;
const ELEMENT_FAIL_CAP = 20;
// What the Bridge tab may show of the room. The panel keeps the last few INBOUND lines it read from the bridge
// log and nothing more: a room transcript is not this panel's record to keep, and "never a full transcript" is a
// property of the store, not a rule the page is trusted to follow. Outbound records already have their own cap.
const ELEMENT_INBOUND_CAP = 20;
const ELEMENT_INBOUND_TEXT = 280;
// How long the bridge gets to drain its outbox, and how long a new message waits for the previous one to go.
// A bridge mid-turn can be slow; the message says so rather than pretending it was delivered.
const ELEMENT_DRAIN_MS = 25_000;
const ELEMENT_OUTBOX_MS = 30_000;
const ELEMENT_POLL_MS = 150;

const elementIso = (ms) => new Date(Number.isFinite(Number(ms)) ? Number(ms) : Date.now()).toISOString();

// The text of one wait, built from the record alone. Two properties are this function's whole job: every
// option the card offers appears WITH its letter, and a destructive option says so in the message — because
// nothing else is sent for this wait, a second warning could only be a second copy.
export function waitText(msg = {}) {
  const out = [];
  const kind = msg.kind === "approval" ? "approval" : msg.kind === "permission" ? "permission" : "question";
  out.push(`⧉ WTGUI ${kind}${msg.n ? ` · wait ${msg.n}` : ""}${msg.title ? ` · ${msg.title}` : ""}`);
  if (msg.where) out.push(String(msg.where));
  // A re-ask is the panel asking again about THIS prompt, never a second question: the count rides in
  // the one message and nothing else is sent for it.
  if (Number(msg.reasks) > 0) out.push(`↻ asked again ${Number(msg.reasks)}× — still unanswered`);
  out.push("");
  if (msg.prompt) out.push(kind === "approval" ? `$ ${msg.prompt}` : String(msg.prompt));
  else out.push("(no prompt text)");
  const choices = Array.isArray(msg.choices) ? msg.choices : [];
  if (choices.length) {
    out.push("");
    for (const c of choices) out.push(`  ${c.letter}. ${c.label}${c.destructive ? "   ⚠ destructive" : ""}`);
    out.push("");
    out.push(`Reply with one letter — ${choices.map((c) => c.letter).join(" or ")}. The panel presses that option.`);
    if (choices.some((c) => c.destructive)) {
      out.push("A destructive option needs a second word: reply its letter, then reply go. Nothing runs on the letter alone.");
    }
    if (Number(msg.n) > 0) out.push(`More than one wait can be open at once — prefix its number to be exact (${msg.n}${choices[0].letter}).`);
  } else {
    out.push("");
    out.push("Reply with your answer — the panel types it into the question.");
  }
  out.push("");
  out.push(`one message per ${kind} — the panel sends nothing else about this one.`);
  if (msg.status === "awaiting-go" && msg.pending) {
    out.push("");
    out.push(`⏳ ${msg.pending.letter}. ${msg.pending.label} chosen — reply go to run it, or cancel.`);
  }
  if (["answered", "closed", "resolved"].includes(msg.status)) {
    out.push("");
    out.push(`${msg.status === "answered" ? "✓" : "✕"} ${msg.resolution || "resolved"}`);
  }
  if (msg.send && msg.send.error) {
    out.push("");
    out.push(`⚠ NOT DELIVERED: ${msg.send.error}`);
  }
  if (msg.applyError) {
    out.push("");
    out.push(`⚠ the panel could not apply the answer: ${msg.applyError}`);
  }
  return out.join("\n");
}

// The bridge's two file channels, as one object. Injected so a test can point them at a scratch directory
// and run the whole loop with no Matrix credentials and no Python at all.
export function createBridgeChannel({ config = {}, outboxPath = null, logPath = null, status = null, clock = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let matrix = { scriptPath: "", roomId: "" };
  try {
    matrix = matrixConfig(config.matrix);
  } catch {
    /* an unreadable config is a channel with no paths; every send then says so */
  }
  let defaults = { matrixLogFile: "" };
  try {
    defaults = statePaths(config);
  } catch {
    /* the same: the caller may have named both paths itself */
  }
  const outbox = String(outboxPath || process.env.BRIDGE_OUTBOX || (matrix.scriptPath ? path.join(path.dirname(matrix.scriptPath), "outbox.txt") : "")).trim();
  const log = String(logPath || defaults.matrixLogFile || "").trim();
  const now = () => Number(clock()) || Date.now();
  const stateOf = () => {
    try {
      return typeof status === "function" ? status() : null;
    } catch {
      return null;
    }
  };
  const sentFile = () => (/\.txt$/i.test(outbox) ? outbox.replace(/\.txt$/i, ".sent") : `${outbox}.sent`);

  return {
    paths: () => ({ outbox: outbox || null, log: log || null }),
    status: () => ({ ...(stateOf() || {}), outbox: outbox || null, log: log || null }),

    // One message per call, and the call does not return until the bridge has taken it: `outbox.txt` existing
    // after a write means the previous text has not gone yet, and writing over it would merge two waits into
    // one message. A timeout is a failure the block draws, not a retry that might duplicate it.
    async send(text) {
      const body = String(text == null ? "" : text).trim();
      if (!body) return { ok: false, error: "an empty message is not sent" };
      if (!outbox) return { ok: false, error: "no outbox path — matrix.scriptPath is empty, so the bridge's outbox cannot be found" };
      const s = stateOf();
      if (s && s.running === false) {
        return {
          ok: false,
          error: `the Matrix bridge is not running${s.stalePid ? ` (a stale pid file names ${s.stalePid})` : ""} — nothing was written, because a file written now would go out whenever it next starts`,
        };
      }
      const untilClear = now() + ELEMENT_OUTBOX_MS;
      while (existsSync(outbox) && now() < untilClear) await sleep(ELEMENT_POLL_MS);
      if (existsSync(outbox)) {
        return { ok: false, error: `the bridge has not drained ${outbox} within ${Math.round(ELEMENT_OUTBOX_MS / 1000)}s — this message was NOT written, so two waits cannot become one message` };
      }
      try {
        mkdirSync(path.dirname(outbox), { recursive: true });
        const tmp = `${outbox}.${process.pid}.${now()}.tmp`;
        writeFileSync(tmp, body, "utf8");
        renameSync(tmp, outbox);
      } catch (e) {
        return { ok: false, error: `could not write ${outbox}: ${String((e && e.message) || e)}` };
      }
      const until = now() + ELEMENT_DRAIN_MS;
      while (now() < until) {
        if (!existsSync(outbox)) return { ok: true, at: elementIso(now()) };
        let sent = "";
        try {
          sent = readFileSync(sentFile(), "utf8");
        } catch {
          sent = "";
        }
        if (sent.trim() === body) return { ok: true, at: elementIso(now()), note: "delivered (read from outbox.sent)" };
        await sleep(ELEMENT_POLL_MS);
      }
      return { ok: false, error: `the bridge did not pick the message up within ${Math.round(ELEMENT_DRAIN_MS / 1000)}s — it is in ${outbox}, undelivered` };
    },

    // Every `<- ` line after `offset`, and the offset a next read should start from. Only WHOLE lines are
    // consumed, and a log that shrank (the bridge truncates its own at 5 MB) restarts from the top rather
    // than waiting for a byte position that no longer exists.
    read(offset = 0) {
      if (!log) return { offset: Number(offset) || 0, entries: [] };
      let text = "";
      try {
        text = readFileSync(log, "utf8");
      } catch {
        return { offset: Number(offset) || 0, entries: [] };
      }
      const buf = Buffer.from(text, "utf8");
      let start = Number(offset) || 0;
      if (start < 0 || start > buf.length) start = 0;
      const slice = buf.subarray(start).toString("utf8");
      const cut = slice.lastIndexOf("\n");
      if (cut < 0) return { offset: start, entries: [] };
      const whole = slice.slice(0, cut + 1);
      const entries = [];
      let cur = null;
      for (const raw of whole.split("\n")) {
        const line = raw.charCodeAt(raw.length - 1) === 13 ? raw.slice(0, -1) : raw;
        const m = /^\[(\d{1,2}:\d{2}:\d{2})\]\s*<-\s*(.+?):\s?(.*)$/.exec(line);
        if (m) {
          cur = { at: m[1], room: m[2], text: m[3] };
          entries.push(cur);
          continue;
        }
        if (/^\[/.test(line)) {
          cur = null; // any other log line ends the message it followed
          continue;
        }
        if (cur && line.trim()) cur.text += `\n${line}`; // a multi-line message continues under its own head
      }
      return { offset: start + Buffer.byteLength(whole, "utf8"), entries };
    },
  };
}

export class ElementChannel {
  constructor({ config = {}, jobs = null, approvals = null, assistant = null, bridge = null, getProjects = () => [], getRows = () => [], onLog = () => {}, onEvent = () => {}, clock = () => Date.now(), stateFile = null } = {}) {
    this.config = config;
    this.jobs = jobs;
    // The panel's own permission box (lib/approvals.js): an approval waiting on a human that did not come from
    // a run's gateway. Same letters, same `once/deny` vocabulary, different control call.
    this.approvals = approvals;
    // The Assistant itself, for the two queue doors (`queueView` / `queueMutate`) — filing work goes through the
    // panel's OWN add semantics, never a second writer of queue.json.
    this.assistant = assistant;
    this.getProjects = getProjects;
    this.getRows = getRows;
    this.onLog = onLog;
    this.onEvent = typeof onEvent === "function" ? onEvent : () => {};
    this.clock = clock;
    const own = statePaths(config);
    this.file = stateFile || path.join(path.dirname(own.assistantFile), "element.json");
    this.bridge = bridge || createBridgeChannel({ config, clock });
    this.messages = [];
    this.failures = [];
    // The last few lines the panel HEARD, not a transcript: text clipped, count capped. `inbox` below is the
    // log cursor (offset, entries, last text); this is the small list the Bridge tab's Messages section draws.
    this.inbound = [];
    this.inbox = { offset: 0, at: null, entries: 0, lastText: null };
    this.seq = 0;
    this.busy = null;
    // One send at a time, in order: the bridge's outbox holds one message, so two waits discovered in the same
    // pass must go out as two messages, never as one merged text.
    this.queue = Promise.resolve();
    this.load();
  }

  // The room the bridge talks in, as the panel's config names it. Empty means nothing can be sent — a message
  // written into the outbox with no room would go out whenever somebody configured one.
  roomId() {
    try {
      return String(matrixConfig(this.config.matrix).roomId || "").trim();
    } catch {
      return "";
    }
  }

  // ---- storage ---------------------------------------------------------------------------------------

  load() {
    try {
      const doc = JSON.parse(readFileSync(this.file, "utf8"));
      this.messages = Array.isArray(doc.messages) ? doc.messages.filter((m) => m && m.id) : [];
      this.failures = Array.isArray(doc.failures) ? doc.failures.slice(-ELEMENT_FAIL_CAP) : [];
      this.inbound = Array.isArray(doc.inbound)
        ? doc.inbound.filter((m) => m && typeof m.text === "string").slice(-ELEMENT_INBOUND_CAP)
        : [];
      const box = doc.inbox && typeof doc.inbox === "object" ? doc.inbox : {};
      this.inbox = { offset: Number(box.offset) || 0, at: box.at || null, entries: Number(box.entries) || 0, lastText: box.lastText || null };
      this.seq = Number(doc.seq) || this.messages.reduce((n, m) => Math.max(n, Number(m.n) || 0), 0);
      // Nothing is re-sent on load: a record whose send failed is `unsent`, and only the block's Retry (or a new
      // wait, which is a different key) moves it. A restart is not a second copy.
    } catch {
      /* no file yet: an empty record, and the first pass decides what goes out */
    }
  }

  save() {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ version: 1, seq: this.seq, messages: this.messages, failures: this.failures, inbound: this.inbound, inbox: this.inbox }, null, 2)}\n`, "utf8");
      renameSync(tmp, this.file);
    } catch (e) {
      this.onLog(`element: could not write ${this.file}: ${String((e && e.message) || e)}`);
    }
  }

  // ---- the pass --------------------------------------------------------------------------------------

  // Serialised: the server's clock may fire while a previous pass is still waiting for the bridge to drain,
  // and two passes over one wait would be two messages.
  sweep() {
    if (this.busy) return this.busy;
    this.busy = this.pass().finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  async pass() {
    const waits = this.waits();
    const live = new Set(waits.map((w) => w.key));
    let moved = false;
    // 1. every wait nobody has seen yet goes out, exactly once.
    for (const w of waits) {
      if (this.messages.some((m) => m.id === w.key)) continue;
      const msg = this.messageFor(w);
      this.messages.push(msg);
      this.trim();
      moved = true;
      await this.deliver(msg);
    }
    // 2. a wait the panel no longer holds is closed IN PLACE: one record, its text edited, nothing sent.
    //    A wait it STILL holds keeps its record too — a re-ask (a question asked again, an hour later)
    //    moves the count on that one record, never a second message. See `Jobs.reaskQuestion`.
    for (const m of this.messages) {
      if (!["open", "awaiting-go", "unsent", "held"].includes(m.status)) continue;
      if (!live.has(m.id)) {
        this.close(m);
        moved = true;
        continue;
      }
      const w = waits.find((x) => x.key === m.id);
      const n = Number(w?.reasks) || 0;
      if (n !== Number(m.reasks || 0)) {
        m.reasks = n;
        moved = true;
      }
    }
    const heard = await this.listen();
    if (moved || heard) {
      this.save();
      this.onEvent({ type: "element", element: this.state() });
    }
    return this.state();
  }

  // Every wait on a person this panel is holding, from the two places it can hold one.
  waits() {
    const out = [];
    if (this.jobs && typeof this.jobs.waitingOnPerson === "function") {
      try {
        out.push(...(this.jobs.waitingOnPerson() || []));
      } catch (e) {
        this.onLog(`element: could not read the board's waits: ${String((e && e.message) || e)}`);
      }
    }
    if (this.approvals && typeof this.approvals.list === "function") {
      let list = [];
      try {
        list = this.approvals.list() || [];
      } catch {
        list = [];
      }
      for (const r of list) {
        if (!r || !r.id) continue;
        const harms = isDestructiveAsk(r.command);
        out.push({
          key: `permission:${r.id}`,
          kind: "permission",
          jobId: String(r.id),
          thread: r.thread || null,
          requestId: String(r.id),
          title: String(r.description || r.command || "the panel's permission box").slice(0, 160),
          where: String(r.surface || ""),
          prompt: String(r.command || r.description || ""),
          multiSelect: false,
          at: r.receivedAt || null,
          deadline: Number(r.deadline) || null,
          choices: (Array.isArray(r.allowed) ? r.allowed : ["once", "deny"]).map((value, i) => ({
            letter: WAIT_LETTERS[i] || "",
            value,
            label: APPROVAL_CHOICE_LABEL[value] || value,
            destructive: harms && value !== "deny",
          })),
        });
      }
    }
    return out;
  }

  messageFor(w) {
    this.seq += 1;
    return {
      id: w.key,
      n: this.seq,
      kind: w.kind,
      jobId: w.jobId,
      thread: w.thread || null,
      requestId: w.requestId || null,
      title: w.title || "",
      where: w.where || "",
      prompt: w.prompt || "",
      choices: (w.choices || []).map((c) => ({ ...c })),
      multiSelect: Boolean(w.multiSelect),
      // Carried so a Retry after a failed send tells the truth about how often this question has been
      // asked; the send itself happens once, at reasks=0. See `waitText`.
      reasks: Number(w.reasks) || 0,
      at: w.at || elementIso(this.clock()),
      editedAt: null,
      status: "open",
      resolution: null,
      pending: null,
      send: null,
      sentAt: null,
      applyError: null,
    };
  }

  trim() {
    if (this.messages.length <= ELEMENT_MESSAGE_CAP) return;
    const keep = new Set(["open", "awaiting-go", "unsent", "held"]);
    let over = this.messages.length - ELEMENT_MESSAGE_CAP;
    this.messages = this.messages.filter((m) => {
      if (over <= 0 || keep.has(m.status)) return true;
      over -= 1;
      return false;
    });
  }

  // ---- out ------------------------------------------------------------------------------------------

  sendText(text) {
    const run = async () => {
      try {
        return await this.bridge.send(text);
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  async deliver(msg) {
    if (!this.roomId()) {
      msg.status = "held";
      msg.send = { ok: null, at: elementIso(this.clock()), error: null, note: "no room is configured (matrix.roomId is empty) — nothing was sent" };
      return msg;
    }
    const out = await this.sendText(waitText(msg));
    msg.sentAt = elementIso(this.clock());
    msg.send = { ok: Boolean(out && out.ok), at: msg.sentAt, error: out && out.ok ? null : String((out && out.error) || "the bridge refused the message") };
    if (msg.send.ok) {
      msg.status = "open";
      this.onLog(`element: wait ${msg.n} sent (${msg.kind}) — ${String(msg.title || "").slice(0, 80)}`);
    } else {
      msg.status = "unsent";
      this.fail(msg, msg.send.error, "send");
    }
    return msg;
  }

  fail(msg, error, kind) {
    const text = String(error || "failed");
    this.failures.push({ at: elementIso(this.clock()), kind, id: (msg && msg.id) || null, n: (msg && msg.n) || null, title: (msg && msg.title) || "", error: text });
    if (this.failures.length > ELEMENT_FAIL_CAP) this.failures.splice(0, this.failures.length - ELEMENT_FAIL_CAP);
    this.onLog(`element: ${kind} FAILED${msg && msg.n ? ` for wait ${msg.n}` : ""}: ${text}`);
  }

  // The wait ended without this channel: answered on the card, withdrawn, timed out, or answered somewhere else.
  // The record is CLOSED, not deleted, and its text gains the outcome — the panel's half of "edited in place".
  close(m) {
    const job = this.jobFor(m.jobId);
    let resolution = "";
    if (m.kind === "approval") {
      const done = job && job.approvalDone;
      if (done && done.choice) resolution = `${done.choice === "deny" ? "denied" : `allowed (${done.choice})`}${done.command ? `: ${String(done.command).slice(0, 140)}` : ""}`;
    } else if (m.kind === "clarify") {
      const done = job && job.questionDone;
      if (done && done.answer) resolution = `answered on the board: ${String(done.answer).slice(0, 200)}`;
      else if (done && done.closed) resolution = "closed — answered elsewhere, withdrawn, or timed out";
    } else if (m.kind === "permission" && this.approvals && typeof this.approvals.status === "function") {
      try {
        const st = this.approvals.status(m.jobId);
        if (st && st.status === "answered") resolution = `answered on the board: ${st.choice}`;
      } catch {
        /* no record is the same as no sentence */
      }
    }
    m.status = "closed";
    m.resolution = resolution || "closed — the panel no longer holds this request";
    m.pending = null;
    m.editedAt = elementIso(this.clock());
  }

  jobFor(id) {
    if (!this.jobs) return null;
    try {
      if (typeof this.jobs.get === "function") {
        const one = this.jobs.get(String(id || ""));
        if (one) return one;
      }
      if (typeof this.jobs.list === "function") return (this.jobs.list() || []).find((j) => String(j.id) === String(id)) || null;
    } catch {
      /* a store that cannot answer is no sentence, not a crash */
    }
    return null;
  }

  // ---- in -------------------------------------------------------------------------------------------

  async listen() {
    if (!this.bridge || typeof this.bridge.read !== "function") return false;
    const out = this.bridge.read(this.inbox.offset);
    if (!out) return false;
    const before = this.inbox.offset;
    this.inbox.offset = Number(out.offset) || 0;
    const entries = Array.isArray(out.entries) ? out.entries : [];
    for (const e of entries) {
      this.inbox.entries += 1;
      this.inbox.at = e.at || this.inbox.at;
      this.inbox.lastText = String((e && e.text) || "").slice(0, 200);
      // The panel's own receipt time, the bridge's time-of-day beside it, and at most 280 characters —
      // this list is a recent-events view, not the room's transcript.
      const heard = String((e && e.text) || "");
      this.inbound.push({
        at: elementIso(this.clock()),
        bridgeAt: (e && e.at) || null,
        room: String((e && e.room) || "").slice(0, 80),
        text: heard.slice(0, ELEMENT_INBOUND_TEXT),
        clipped: heard.length > ELEMENT_INBOUND_TEXT,
      });
      if (this.inbound.length > ELEMENT_INBOUND_CAP) this.inbound.splice(0, this.inbound.length - ELEMENT_INBOUND_CAP);
      try {
        await this.hear(e);
      } catch (err) {
        this.onLog(`element: could not handle a room message: ${String((err && err.message) || err)}`);
      }
    }
    return entries.length > 0 || before !== this.inbox.offset;
  }

  // One message from the room. The order is the whole policy: the destructive confirmation first, then a
  // letter, then an answer to an open question, then the two queue doors, then silence. Nothing here sends a
  // message the room did not ask for.
  async hear(entry) {
    const text = String((entry && entry.text) || "").trim();
    if (!text) return false;
    this.onLog(`element: room -> ${text.slice(0, 120)}`);
    const armed = this.messages.filter((m) => m.status === "awaiting-go" && m.pending);
    if (/^go[.!]?$/i.test(text)) {
      if (!armed.length) return false;
      await this.applyChoice(armed[armed.length - 1], { ...armed[armed.length - 1].pending, destructive: true });
      return true;
    }
    if (/^(cancel|stop|never ?mind|abort|no)[.!]?$/i.test(text)) {
      if (!armed.length) return false;
      for (const m of armed) {
        m.pending = null;
        m.status = "open";
        m.editedAt = elementIso(this.clock());
      }
      this.save();
      this.onEvent({ type: "element", element: this.state() });
      this.onLog("element: the armed choice was cancelled");
      return true;
    }
    // A letter, optionally prefixed with the wait number ("3B") so two open waits are never ambiguous.
    const pick = /^(?:#?(\d+)[\s.:-]+)?([a-z])[.)]?$/i.exec(text);
    if (pick) {
      const n = pick[1] ? Number(pick[1]) : null;
      const letter = pick[2].toUpperCase();
      const open = this.messages.filter((m) => m.status === "open" && (n == null || Number(m.n) === n));
      const msg = [...open].reverse().find((m) => (m.choices || []).some((c) => c.letter === letter)) || null;
      if (!msg) return false;
      return this.choose(msg, letter);
    }
    // An open-ended question on the board: the text IS the answer the card's typed box would post.
    const open = this.messages.filter((m) => m.status === "open" && m.kind === "clarify" && !(m.choices || []).length);
    if (open.length) {
      await this.applyChoice(open[open.length - 1], { letter: "", value: text, label: text.slice(0, 80), destructive: false });
      return true;
    }
    if (await this.fileTask(text)) return true;
    if (await this.answerQueue(text)) return true;
    return false;
  }

  async choose(msg, letter) {
    const choice = (msg.choices || []).find((c) => c.letter === letter);
    if (!choice) return false;
    if (choice.destructive) {
      // The letter is REMEMBERED, not acted on: a destructive option runs only after `go`, and the arming is
      // written into the same record — a second message asking for confirmation would be a second copy.
      msg.pending = { letter: choice.letter, value: choice.value, label: choice.label };
      msg.status = "awaiting-go";
      msg.editedAt = elementIso(this.clock());
      this.save();
      this.onEvent({ type: "element", element: this.state() });
      this.onLog(`element: wait ${msg.n} armed ${choice.letter}. ${choice.label} — nothing runs until "go"`);
      return true;
    }
    await this.applyChoice(msg, choice);
    return true;
  }

  // The one door from a letter to the panel's own control call: the same method the card's button posts, with
  // the same request id, so a reply cannot answer anything a press could not.
  async applyChoice(msg, choice) {
    let out;
    try {
      if (msg.kind === "permission" && this.approvals) out = this.approvals.answer(msg.jobId, choice.value, "element");
      else if (msg.kind === "approval" && this.jobs) out = await this.jobs.approve(msg.jobId, choice.value, msg.requestId);
      else if (msg.kind === "clarify" && this.jobs) out = await this.jobs.answerQuestion(msg.jobId, msg.multiSelect ? [choice.value] : choice.value, msg.requestId);
      else out = { ok: false, error: `nothing on this panel answers a ${msg.kind} wait` };
    } catch (e) {
      out = { ok: false, error: String((e && e.message) || e) };
    }
    if (out && out.ok) {
      msg.status = "answered";
      msg.pending = null;
      msg.applyError = null;
      msg.resolution = `${choice.letter ? `${choice.letter}. ` : ""}${choice.label} — applied as the card's own press`;
      msg.editedAt = elementIso(this.clock());
      this.onLog(`element: wait ${msg.n} answered from the room — ${msg.resolution}`);
    } else {
      const error = String((out && out.error) || "the panel refused the answer");
      msg.applyError = error;
      msg.editedAt = elementIso(this.clock());
      this.fail(msg, error, "apply");
    }
    this.save();
    this.onEvent({ type: "element", element: this.state() });
    return out;
  }

  // ---- the two queue doors ---------------------------------------------------------------------------

  // Which assistant the line names: "assistant 2", "Assistant #2", its own name, or a bare "#2" after a
  // preposition. Null when it names none — filing into "the queue" without saying whose is not a filing.
  queueTarget(text) {
    const list = Array.isArray(this.assistant && this.assistant.assistants) ? this.assistant.assistants : [];
    const byNumber = /\bassistant\s*#?\s*(\d+)\b/i.exec(text) || /\b(?:for|to|into)\s+#\s*(\d+)\b/i.exec(text);
    if (byNumber) {
      const rec = list.find((a) => assistantNumber(a.id) === byNumber[1]);
      if (rec) return rec;
    }
    const lower = String(text || "").toLowerCase();
    for (const rec of list) {
      const name = String(rec.name || "").toLowerCase();
      if (name && lower.includes(name)) return rec;
    }
    return null;
  }

  // A filename is REAL only when it is on disk under one of this board's project roots (or one of its
  // worktrees). That is what keeps the queue's lane derivation honest: a lane is named by a file two rows
  // share, and a made-up path would invent one nobody can open.
  realFiles(text) {
    const roots = [];
    for (const p of (typeof this.getProjects === "function" ? this.getProjects() || [] : [])) {
      const dir = String((p && (p.path || p.root)) || "").trim();
      if (dir) roots.push(dir);
    }
    for (const r of (typeof this.getRows === "function" ? this.getRows() || [] : [])) {
      const dir = String((r && r.path) || "").trim();
      if (dir) roots.push(dir);
    }
    const out = [];
    const re = /([A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)*\.[A-Za-z0-9]{1,6})\b/g;
    for (const m of String(text || "").matchAll(re)) {
      const token = m[1].replace(/\\/g, "/").replace(/^\.\//, "");
      if (out.some((f) => f.file.toLowerCase() === token.toLowerCase())) continue;
      for (const root of roots) {
        let isFile = false;
        try {
          isFile = statSync(path.isAbsolute(token) ? token : path.join(root, token)).isFile();
        } catch {
          isFile = false;
        }
        if (!isFile) continue;
        out.push({ file: token, project: path.basename(root.replace(/[\\/]+$/, "")) || null });
        break;
      }
    }
    return out.slice(0, 8);
  }

  // "file <title> in lib/x.js into assistant 2" / "add <title> to #2's queue" / "assistant 2: <title>".
  // The panel's OWN add semantics do the writing (`queueMutate("add")`), so the id, the journal line, the
  // validation and the lane rules are the ones the Queue tab gets.
  async fileTask(text) {
    if (!this.assistant || typeof this.assistant.queueMutate !== "function") return false;
    const target = this.queueTarget(text);
    if (!target) return false;
    const colon = /^\s*(?:file\s+|add\s+|queue\s+)?assistant\s*#?\s*(\d+)\s*(?:'s\s+queue\s*)?:\s*(.+)$/i.exec(text);
    const lead = /^\s*(?:file|add|queue)\b(.*)$/i.exec(text);
    if (!colon && !lead) return false;
    let body = colon ? colon[2] : lead[1];
    body = String(body || "")
      .replace(/\s+(?:in|into|to|on|for)\s+(?:assistant\s*#?\s*\d+(?:'s)?(?:\s+queue)?|#\s*\d+(?:'s)?(?:\s+queue)?|(?:the\s+)?queue\s+of\s+assistant\s*#?\s*\d+)\b.*$/i, "")
      .replace(/^\s*(?:that|this)\s+/i, "")
      .trim();
    const files = this.realFiles(text);
    let title = body;
    for (const f of files) title = title.split(f.file).join(" ");
    // "…in lib/x.js" leaves a preposition dangling once the path is taken out: it belongs to the file, not the title.
    title = title
      .replace(/\s+(?:in|at|from|under|for|of|on|to|inside)\s*$/i, "")
      .replace(/\s+/g, " ")
      .replace(/[\s,;:.·-]+$/, "")
      .trim();
    if (!title) {
      await this.reply(`Not filed: a task needs a title — say it as \`file <what> into assistant ${assistantNumber(target.id)}\`.`);
      return true;
    }
    let out;
    try {
      out = this.assistant.queueMutate(
        target.id,
        "add",
        { title, files: files.map((f) => f.file), project: files[0] ? files[0].project : null, detail: `filed from the room: ${String(text).slice(0, 300)}` },
        { by: "element" },
      );
    } catch (e) {
      this.fail(null, String((e && e.message) || e), "queue");
      await this.reply(`Not filed: ${String((e && e.message) || e)}`);
      return true;
    }
    if (!out || !out.ok) {
      await this.reply(`Not filed: ${(out && out.error) || "the queue refused it"}`);
      return true;
    }
    const lane = out.task && out.task.files && out.task.files.length ? ` · lane ${out.task.files[0]}` : " · no file claimed, so no lane";
    await this.reply(`Filed #${out.task.id} in ${target.name}'s queue — ${String(out.task.title).slice(0, 100)}${lane}`);
    return true;
  }

  // An open-ended question about a queue. Answered only when the line is a question about one, and only with
  // what the panel already holds — the same `queueView` the Queue tab draws.
  async answerQueue(text) {
    if (!this.assistant || typeof this.assistant.queueView !== "function") return false;
    if (!/\b(queue|backlog|task list|to-?do)\b/i.test(text)) return false;
    const asking = /\?/.test(text) || /\b(what|what's|whats|show|list|how many|anything|status|read|tell me|anything)\b/i.test(text);
    if (!asking) return false;
    const rec = this.queueTarget(text) || this.targetById(PRIMARY_ASSISTANT);
    if (!rec) return false;
    let view;
    try {
      view = this.assistant.queueView(rec.id);
    } catch (e) {
      await this.reply(`I could not read ${rec.name}'s queue: ${String((e && e.message) || e)}`);
      return true;
    }
    await this.reply(this.queueText(view));
    return true;
  }

  targetById(id) {
    const list = Array.isArray(this.assistant && this.assistant.assistants) ? this.assistant.assistants : [];
    return list.find((a) => String(a.id) === String(id)) || null;
  }

  queueText(view) {
    const tasks = Array.isArray(view.tasks) ? view.tasks : [];
    const open = tasks.filter((t) => t.state !== "done");
    const lines = [`${view.name || "Assistant"}'s queue — ${open.length} open, ${tasks.length} row${tasks.length === 1 ? "" : "s"}`];
    if (!open.length) lines.push("· nothing open");
    for (const t of open.slice(0, 10)) {
      const bits = [`#${t.id} ${t.state}`, String(t.title || "").slice(0, 80)];
      if (Array.isArray(t.files) && t.files.length) bits.push(t.files.join(", "));
      if (t.laneHead) bits.push("lane head");
      else if (t.waitingOn) bits.push(`waiting on #${t.waitingOn.id}`);
      else if (t.lane) bits.push(`lane ${t.lane} after #${t.laneHeadId}`);
      if (t.stale) bits.push("stale");
      lines.push(`· ${bits.join(" · ")}`);
    }
    if (open.length > 10) lines.push(`· …and ${open.length - 10} more`);
    return lines.join("\n");
  }

  async reply(text) {
    const out = await this.sendText(text);
    if (!out || !out.ok) this.fail(null, (out && out.error) || "the reply was not sent", "reply");
    else this.onLog(`element: -> ${String(text).slice(0, 120)}`);
    return out;
  }

  // ---- the panel's read ------------------------------------------------------------------------------

  // The block's answer: what is open, what was answered, and every send that failed. `text` is the record's
  // CURRENT body — the one that was sent, with the outcome edited into it.
  state() {
    const paths = (this.bridge && typeof this.bridge.paths === "function" && this.bridge.paths()) || {};
    let status = null;
    try {
      status = this.bridge && typeof this.bridge.status === "function" ? this.bridge.status() : null;
    } catch {
      status = null;
    }
    const open = this.messages.filter((m) => ["open", "awaiting-go", "unsent", "held"].includes(m.status));
    // The last message that actually left, and the last line that actually arrived. "Successful" is the
    // record's own `send.ok`, never the status word: a held message was never sent, and a closed one may have
    // failed before it was closed. The timestamps are what the Bridge tab's Connection section draws.
    const sentOk = this.messages
      .filter((m) => m && m.send && m.send.ok === true && m.sentAt)
      .sort((a, b) => String(a.sentAt).localeCompare(String(b.sentAt)));
    const lastSent = sentOk.length ? sentOk[sentOk.length - 1] : null;
    const lastHeard = this.inbound.length ? this.inbound[this.inbound.length - 1] : null;
    return {
      at: elementIso(this.clock()),
      room: this.roomId(),
      file: this.file,
      bridge: { ...(status || {}), outbox: paths.outbox || null, log: paths.log || null },
      counts: {
        open: open.length,
        answered: this.messages.filter((m) => m.status === "answered").length,
        closed: this.messages.filter((m) => m.status === "closed").length,
        failed: this.failures.length,
        inbound: this.inbox.entries,
        inboundKept: this.inbound.length,
      },
      // The last few lines heard, newest first. Capped in the STORE (ELEMENT_INBOUND_CAP and
      // ELEMENT_INBOUND_TEXT), so a page that asked for more still could not receive a transcript.
      inbound: this.inbound.slice(-10).reverse(),
      activity: {
        lastSentAt: lastSent ? lastSent.sentAt : null,
        lastSentId: lastSent ? lastSent.id : null,
        lastSentN: lastSent ? lastSent.n : null,
        lastReceivedAt: lastHeard ? lastHeard.at : null,
        lastReceivedBridgeAt: lastHeard ? lastHeard.bridgeAt : null,
      },
      messages: this.messages
        .slice(-10)
        .reverse()
        .map((m) => ({
          id: m.id,
          n: m.n,
          kind: m.kind,
          status: m.status,
          title: m.title,
          where: m.where,
          prompt: m.prompt,
          choices: m.choices,
          multiSelect: m.multiSelect,
          at: m.at,
          editedAt: m.editedAt,
          resolution: m.resolution,
          send: m.send,
          applyError: m.applyError,
          text: waitText(m),
        })),
      failures: this.failures.slice(-10).reverse(),
      inbox: { ...this.inbox },
    };
  }

  // Re-send the record that failed — the same one, so a press here can never become a second copy in the room.
  async retry(id = null) {
    const targets = this.messages.filter((m) => (id ? m.id === id : ["unsent", "held"].includes(m.status)));
    for (const m of targets) await this.deliver(m);
    if (targets.length) {
      this.save();
      this.onEvent({ type: "element", element: this.state() });
    }
    return { retried: targets.length, element: this.state() };
  }
}
