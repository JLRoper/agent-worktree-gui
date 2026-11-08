// The wake queue: what a set of wakes becomes, and the one turn a batch turns into.
//
// A wake is a REASON and a RULE, never a message. `wake(reason, alertId, rule)` decides whether this one may go
// out (that assistant's switch, the hour's budget for the sentry's sweeps), stamps it onto the instance's
// `pendingWake` and lets the coalescing timer take it from there. Four wakes in one minute are one thought, not
// four, so the queue is not a list of messages to send: it is a list of things to say ONCE, together, when the
// turn that is already running ends.
//
// The four fields the queue lives in stay on the Assistant - `pendingWake`, `wakeTimer`, `wakes` and
// `forceSweepFor` - because they are the state rather than the decision: `state()` ships the two counts,
// lib/assistant/reset.js drops one assistant's queued wakes and clears the one shared timer, and every harness
// that drives a wake reads them off the instance. What lives HERE is every decision the queue makes:
//
//   · the BUDGET CLASS. `SWEEP_WAKE_RULES` names the conditions the sentry POLLS for, and only those may be
//     refused by `maxWakesPerHour`. A rule the list does not name - a run settling, a worker asking a question,
//     a watch finishing, a restart, a reader's own press - is an EVENT: one fact, no second chance, and never
//     droppable (`isSweepWake`). A rule added later defaults to event for exactly that reason.
//   · the ONE-SHOT BUDGET EXCEPTION. A reset that drops an assistant's queued sweeps lets its next sweep through
//     even at the cap: the condition is still true or it is not, and the board is what re-raises it.
//     `reset.js` raises `forceSweepFor` and this module is the one place that spends it.
//   · the COALESCING WINDOW, 150 ms: long enough to collect one sentry pass (two watches on the same worker
//     finish in the same tick) and short enough that nobody waits for it.
//   · ONE BATCH PER ASSISTANT (`groupWakesByAssistant`). A batch is a turn of ONE thread, and the thread is
//     decided by the wake's own `assistantId`. A single batch for the whole board is how every wake once went to
//     Assistant #1 while a second assistant's trees settled in silence.
//   · the SPEND (`isSweepBatch`). Only a batch that is ALL sweeps spends the hour. An event is never refused, so
//     counting it would let a busy afternoon of settles and exits starve the sentry's own sweeps; a mixed batch
//     carries at least one event, which the budget may not refuse, so it does not spend either.
//   · the WORDS (`wakeText`): one instruction per rule in the batch rather than one per alert (four overdue
//     watches ask the same question), the per-rule hints `WAKE_HINTS` keeps, and the queue sweep's four checks
//     appended WHOLE rather than clipped into the hint - a 500-character hint that ended mid-sentence would leave
//     a turn with "running rows against..." and no rest.
//
// The class keeps the two method names every caller uses - `wake` and `flushWake` - each a one-line delegation,
// and this module makes the same calls on the instance the class would have made itself: `wakeTarget`,
// `settingsFor`, `journalWakeRoute`, `assistantLive`, `say`, `journalAdd`. Same journal lines, same timer, same
// one turn per batch. It is the ./rules.js split read the other way round: rules.js owns what a LIST becomes,
// this owns what a QUEUE becomes.
//
// Nothing here reads a store, spawns a turn or talks HTTP.
import { PRIMARY_ASSISTANT } from "../assistants.js";
import { SWEEP_WAKE_RULES, WAKE_HINTS } from "./config.js";
import { clip } from "./read.js";

// The rule the queue sweep's wake is filed under. Named as a constant because three places mean this one sweep:
// the settle/idle rules that fire it (lib/assistant.js), the checklist below, and the digest gate that treats a
// sweep differently from an event.
export const QUEUE_SWEEP_RULE = "queuesweep";

// The four checks every queue-sweep wake carries, in the order row #99 lays them down. A wake that only says
// "mind the queue" becomes a vibe - three different turns would do three different things - so the sweep hands
// over the same list every time: what to read first, then the three questions a row's STATE answers, then the one
// thing the sweep has to end with.
//
// The three checks exist because each state's word can lie. A `running` row with no job behind it is stale (the
// panel's own STALE flag is the same fact, but a stale row still needs a decision); a `queued` row whose work has
// already landed is a claim, not a fact, because a parallel worker routinely finishes the work without closing the
// row; and a `parked` row whose named blocker closed is waiting for nobody. The last line is what keeps a sweep
// honest: it ends in a start, or in the words "the queue is clean".
export const QUEUE_SWEEP_CHECKS = [
  "Sweep your queue now, in this order:",
  "1. Read the queue first — every open row, not only the one this wake names.",
  "2. Every RUNNING row: does /api/jobs hold a live job for its thread? If not it is stale — requeue it, or mark it done if its deliverable is already on main.",
  "3. Every QUEUED row: is its deliverable already on main? Parallel workers routinely finish a row's work without closing the row, so a queued row is a claim, not a fact.",
  "4. Every PARKED row: is the row it names as its blocker done? If so unpark it to queued — a SPAWN naming a parked row is refused, so a row left parked is a row nothing starts.",
  "Then start what can be started, or say plainly that the queue is clean.",
].join("\n");

// How long a wake waits for the rest of its sentry pass before the batch goes out. Short: it is a coalescing
// window, not a schedule - a wake already waited for the turn in front of it.
export const WAKE_COALESCE_MS = 150;

/** Whether this rule is one of the sentry's SWEEPS, and so the only class the hour's budget may refuse. */
export function isSweepWake(rule) {
  return Boolean(rule) && SWEEP_WAKE_RULES.has(rule);
}

/**
 * The queue split into one batch per assistant, in arrival order. A batch is a turn of ONE thread, so the thread
 * is decided here: the entry's own `assistantId`, and #1 when a caller named nobody. The map is keyed by id and
 * keeps first-seen order, so two assistants' batches go out in the order their first wake arrived.
 *
 * @returns {Map<string, object[]>}
 */
export function groupWakesByAssistant(pending = []) {
  const byAssistant = new Map();
  for (const w of Array.isArray(pending) ? pending : []) {
    const who = String(w.assistantId || "").trim() || PRIMARY_ASSISTANT;
    if (!byAssistant.has(who)) byAssistant.set(who, []);
    byAssistant.get(who).push(w);
  }
  return byAssistant;
}

/** Whether a whole batch is the sentry's own sweeps - the one class that spends the hour's budget. */
export function isSweepBatch(batch = []) {
  const list = Array.isArray(batch) ? batch : [];
  return list.length > 0 && list.every((b) => isSweepWake(b.rule));
}

/** The rules a batch names, deduplicated in order: four overdue watches ask the same question. */
export function wakeRules(batch = []) {
  const list = Array.isArray(batch) ? batch : [];
  return [...new Set(list.map((b) => b.rule).filter(Boolean))];
}

/**
 * The hint a batch carries: one line per rule it names, joined and clipped. `WAKE_HINTS` is the vocabulary
 * (lib/assistant/config.js), and a rule with no hint is simply not described - the reason lines still say what
 * happened.
 */
export function wakeHint(rules = []) {
  const list = Array.isArray(rules) ? rules : [];
  return clip(
    list
      .map((r) => WAKE_HINTS[r])
      .filter(Boolean)
      .join(" "),
    500,
  );
}

/**
 * The words one batch is said in: the count, one line per reason, then the hint (or "say what you make of it")
 * and the TO line that lets an assistant answer a worker that asked something. The queue sweep's checklist is
 * appended WHOLE, under its own blank line, and only for a batch that names it.
 */
export function wakeText(batch = []) {
  const list = Array.isArray(batch) ? batch : [];
  const rules = wakeRules(list);
  const hint = wakeHint(rules);
  const sweepBlock = rules.includes(QUEUE_SWEEP_RULE) ? `\n\n${QUEUE_SWEEP_CHECKS}` : "";
  return (
    `${list.length === 1 ? "One thing on the board needs a look:" : `${list.length} things on the board need a look:`}\n` +
    list.map((b) => `- ${b.reason}`).join("\n") +
    `\n\n${hint ? `${hint} ` : "Say what you make of it. "}If a worker asked something and the answer is in your rules or notes, draft it with TO <thread>: <text>.${sweepBlock}`
  );
}

// ---- the doors the Assistant's methods delegate to ---------------------------------------------

/**
 * `Assistant#wake`. A wake is coalesced: while a turn is live the reasons queue up, and when it ends they go as
 * one message. Four wakes in one minute is one thought, not four.
 *
 * It answers with what the queue decided. Every existing caller is fire-and-forget and ignores it; the one caller
 * that cannot is a press the reader can see (the COMPLETE chip), because a refusal has to reach the card as a
 * verdict rather than as a pill claiming an ask that never left the panel.
 */
export function wakeAssistant(assistant, reason, alertId = null, rule = null, { force = false, assistantId = null, exact = false } = {}) {
  // WHICH assistant hears this is THE LADDER's answer (`wakeTarget`), not the caller's word taken on trust. A
  // caller that knows names who it MEANS - the tree's owner, the run's assistant - and the owner keeps the wake
  // whenever its own last run is not failed. But a wake addressed to a failed assistant used to be accepted here
  // and then die at the door, so the roster is walked from #1 upward for the first assistant whose last run is not
  // failed; every assistant failed means the intended one keeps it anyway, with the journal saying nobody was
  // healthy. Its own switch and its own budget are read, not #1's: a wake is a turn of THAT thread.
  //
  // `exact` is the one exception, and only the cadence uses it: a standing wake belongs to the JOB that carries
  // the interval, so the director's twenty-minute pass must not be walked onto #1 because the director's last
  // turn failed. The route is still journalled (with nobody skipped), so the delivery is as visible as any other.
  const asked = String(assistantId || "").trim();
  const route =
    exact && asked
      ? { who: asked, asked, chosen: true, fallback: false, skipped: [], failed: [], health: [{ id: asked, name: assistant.assistantRecord(asked)?.name || asked }] }
      : assistant.wakeTarget(assistantId);
  const who = route.who;
  const s = assistant.settingsFor(who);
  if (!s.enabled) return { queued: false, refused: "disabled", assistantId: who };
  const cut = Date.now() - 3600_000;
  assistant.wakes = assistant.wakes.filter((t) => t > cut);
  // The budget is for the sentry's SWEEPS - the conditions it polls for (quiet, loop, leftover, child, ...) - and
  // never for an EVENT: a run settling or exiting, a worker parking on an approval or asking a question, a watch
  // finishing, a restart, or a reader's own press. An event is a single fact with no second chance, and a busy hour
  // used to drop it (`rate limit reached (6/h)` - settles and exits among the casualties). `rule` is the class:
  // `SWEEP_WAKE_RULES` lists the sweeps, so a rule added later defaults to event and cannot silently become
  // droppable. `force` stays for a caller that must outrank even a sweep's budget.
  const isSweep = isSweepWake(rule);
  // A reset just dropped this assistant's queued sweeps, so the first one after it is allowed through even at the
  // hourly cap: the condition is still true or it is not, and the board is what re-raises it.
  const forcedSweep = isSweep && assistant.forceSweepFor.has(who);
  if (!force && !forcedSweep && isSweep && assistant.wakes.length >= s.maxWakesPerHour) {
    assistant.journalAdd("wake-suppressed", null, `rate limit reached (${s.maxWakesPerHour}/h): ${reason}`);
    return { queued: false, refused: "budget", limit: s.maxWakesPerHour, assistantId: who };
  }
  if (forcedSweep) assistant.forceSweepFor.delete(who);
  assistant.pendingWake.push({ reason, alertId, rule, assistantId: who, at: Date.now() });
  // One line per ROUTED wake: who took it and which assistants were passed over as failed, with each reason. A
  // refused wake (switched off, budget) is not routed, so it does not write one.
  assistant.journalWakeRoute(route, assistant.threadOf(who));
  // Wakes fired by one sentry pass are one thought: two watches on the same worker finish in the same tick, and
  // two assistant turns answering that one event is noise. 150 ms is long enough to collect the pass and short
  // enough that nobody waits for it.
  if (assistant.wakeTimer) return { queued: true, pending: assistant.pendingWake.length, coalesced: true };
  assistant.wakeTimer = setTimeout(() => {
    assistant.wakeTimer = null;
    void assistant.flushWake();
  }, WAKE_COALESCE_MS);
  assistant.wakeTimer.unref?.();
  return { queued: true, pending: assistant.pendingWake.length, coalesced: false };
}

/**
 * `Assistant#flushWake`. One batch per assistant, each said on its own thread:
 *
 *   - a turn already live on that assistant's thread is this batch's predecessor; the batch is left queued for
 *     that turn's end to flush, because a second run on one thread is the defect this check prevents. The other
 *     assistants' batches still go - one assistant being busy is not the board's answer;
 *   - only an all-sweep batch spends the hour (see `isSweepBatch`);
 *   - the text is `wakeText`, so the words are the queue's and not this function's.
 */
export async function flushWakes(assistant) {
  if (!assistant.pendingWake.length) return;
  // One batch PER ASSISTANT, and the thread is decided here (`groupWakesByAssistant`).
  const byAssistant = groupWakesByAssistant(assistant.pendingWake.splice(0));
  for (const [who, batch] of byAssistant) {
    // A turn already running on that thread is this wake's predecessor: leaving the batch queued lets the END of
    // that turn flush it, and a second run on one thread is the defect this check exists to prevent. The other
    // assistants' batches are still flushed -- one assistant being busy is not the board's answer.
    if (assistant.assistantLive(who)) {
      assistant.pendingWake.push(...batch);
      continue;
    }
    // Only a SWEEP spends the hour's budget. An event is never refused, so counting it would let a busy afternoon of
    // settles and exits starve the sentry's own sweeps for the rest of the hour. A batch is one class or the other:
    // a mixed batch carries at least one event, which the budget may not refuse, so it does not spend either.
    if (isSweepBatch(batch)) assistant.wakes.push(Date.now());
    // One instruction per rule in the batch, not one per alert: four overdue watches ask the same question.
    const text = wakeText(batch);
    try {
      await assistant.say(text, {
        // `event` is the wake's class, handed to the turn so a digest gate can treat an event differently from a
        // sweep: an event turn always sees the board, a sweep may wait its turn.
        origin: { kind: "assistant-wake", event: !isSweepBatch(batch), reason: clip(batch.map((b) => b.reason).join(" · "), 300), alerts: batch.map((b) => b.alertId).filter(Boolean) },
        display: `watch: ${clip(batch[0].reason, 160)}`,
        // The wake is a turn of THIS assistant's thread: its preamble, its queue digest and its settings, not #1's.
        assistantId: who,
      });
    } catch (err) {
      assistant.journalAdd("wake-failed", null, String((err && err.message) || err));
    }
  }
}
