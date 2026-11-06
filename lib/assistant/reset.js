// The assistant reset: the control-plane call that makes a fenced assistant answerable again.
//
// Design: docs/research/assistant-reset-design.md (PR 394). The measured endpoint table it stands on:
// docs/research/gateway-fence-endpoints.md; the id map and the "0 lost turns" report: assistant-session-fence.md.
//
// The one fact this module exists for: an `unknown` admission is settled ONLY by
// `POST /v1/runs/{run_id}/resolve-unknown` with BOTH `admission_id` and `execution_generation`, and those two values
// are read from a fresh `GET /v1/runs/{id}` inside the same request — never from the card's cached generation, which
// can be behind (the fence doc watched 1 -> 3 -> 4 across one session).
// `POST /v1/runs/{id}/stop` is NOT the acknowledgement: on an unknown admission it answers 409 `unknown_execution` and leaves the fence standing, so this
// module never uses it on the fence. It IS used on the QUEUED runs behind the fence — a queued row is cancellable, and cancelling that backlog
// before the clear is what stops one resolve from replaying every stale turn at once. A test asserts both: no stop on the head, one per queued row.
//
// Naming: an admission is named through a card's run, or — when no card names it — through the admission store's own
// `request_id`, which is a run id, verified by a GET that must read `unknown` for that exact `admission_id`. A name is
// never inferred from a session id: the gateway has no session-keyed resolve (a session id in the run slot is 404).
//
// What it clears: every unknown admission on this assistant's session it can name — through a card's run, or, when
// no card names it, through the admission store's own `request_id` verified against a fresh GET — every
// `pendingWake` entry routed to this assistant, every watch this assistant owns.
// What it keeps: the queue and its spawn debts, the scratchpad (notes, rules, journal, alerts, harvested, command
// audits), the charter, the thread id and the transcript. Local clearing happens ONLY after a store re-read shows no
// unknown row for the session — gateway first, local second. A half-reset that deleted the evidence of a fence it did
// not clear is the failure mode the order exists to prevent.
//
// The route is `POST /api/assistants/:id/reset`, a factory in the shape of `createQueueRoutes`: it own the path
// match, the body, the refusals and the wire envelope, and takes the transport helpers from the composition root so
// a test can drive it with stubs and a real Assistant over a temp directory.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PRIMARY_ASSISTANT } from "../assistants.js";
import { hermesHome } from "../hermes-runtime.js";
import { unknownAdmissions } from "./reset-store.js";

export const RESET_ROUTE = /^\/api\/assistants\/([^/]+)\/reset$/;
// The gateway's own words. `started` and `running` are the two statuses that mean a turn is EXECUTING; a non-empty
// `pending_controls` means it is parked on an approval/clarify, which is also live work. `queued` is deliberately
// absent: a queued run is admitted work BEHIND the fence, and refusing on it would make the reset permanently
// refused by the very fence it exists to clear (design §3.5).
export const EXECUTING_RUN_STATUSES = Object.freeze(["started", "running"]);
const KNOWN_FIELDS = new Set(["dryRun", "reason"]);
const RUN_TIMEOUT_MS = 8_000;
const RESOLVE_TIMEOUT_MS = 10_000;
const REASON_MAX = 300;

const text = (value) => (typeof value === "string" ? value.trim() : "");
const clip = (value, max) => {
  const s = String(value ?? "");
  return s.length > max ? s.slice(0, max) : s;
};
// A generation is a positive integer on the wire. `Number(null)` is 0 and `Number("")` is 0, so a missing value must
// be checked for nullishness first — a body built with 0 would be a 400 the gateway cannot explain.
const generationOf = (run) =>
  run && run.execution_generation != null && Number.isFinite(Number(run.execution_generation)) && Number(run.execution_generation) > 0
    ? Number(run.execution_generation)
    : null;

/** A wake entry routed to one assistant. Entries are routed at enqueue, so `assistantId` is the exact filter; a
 * legacy entry with no stamp belongs to Assistant #1, exactly as `flushWake` reads it. */
export const wakeOwnerOf = (entry) => String(entry?.assistantId || "").trim() || PRIMARY_ASSISTANT;

/** Is this gateway answer a run that is still executing? Per run, from the gateway's answer — never from the card's
 * local status, which counts `starting`/`waiting` and would refuse on a queued card. */
export function isExecutingRun(run) {
  if (!run) return false;
  if (EXECUTING_RUN_STATUSES.includes(String(run.status || ""))) return true;
  return Array.isArray(run.pending_controls) && run.pending_controls.length > 0;
}

/** The gateway's error code out of one of its envelopes: `{error:{code,message}}`, `{code,error}`, or null. */
function gatewayCode(body) {
  const err = body && typeof body === "object" ? body.error : null;
  if (err && typeof err === "object") return text(err.code) || text(err.message) || null;
  if (typeof err === "string") return err;
  return body && typeof body === "object" ? text(body.code) || text(body.message) || null : null;
}

async function answerOf(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * The gateway calls this route makes. `assistant.jobs` is the panel's run supervisor: its `api.url` is the gateway
 * and its `headers()` carries the API_SERVER_KEY. A test injects a fake with the same two methods, so the resolve
 * body and the number of GETs are asserted without a socket.
 */
export function gatewayClient(assistant) {
  const base = String(assistant?.jobs?.api?.url || "").replace(/\/+$/, "");
  const headers = () => (typeof assistant?.jobs?.headers === "function" ? assistant.jobs.headers() : { "Content-Type": "application/json" });

  async function getRun(runId) {
    const id = String(runId || "");
    if (!id) return { ok: false, status: 0, code: "invalid_params", error: "a run id is required" };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), RUN_TIMEOUT_MS);
    try {
      const res = await fetch(`${base}/v1/runs/${encodeURIComponent(id)}`, { headers: headers(), signal: ctrl.signal });
      const body = await answerOf(res);
      if (!res.ok) {
        return { ok: false, status: res.status, code: gatewayCode(body) || `http_${res.status}`, error: text(body?.error?.message) || `the gateway answered HTTP ${res.status}` };
      }
      if (!body || typeof body !== "object") return { ok: false, status: res.status, code: "invalid_params", error: "the gateway answered a run body that is not an object" };
      return { ok: true, status: res.status, run: body, code: null, error: null };
    } catch (err) {
      return { ok: false, status: 0, code: "transport", error: `could not reach the gateway for run ${id}: ${String((err && err.message) || err)}` };
    } finally {
      clearTimeout(t);
    }
  }

  // The clear. The body is EXACTLY the two keys the gateway accepts (a third key is 400 invalid_params), and the
  // exact body is retried ONCE on a transport error only — the resolve is idempotent on the exact body (fence doc
  // row #12), and a 409 stale_generation/not_found is a failed row, not something a retry can repair.
  async function resolveUnknown(runId, body) {
    const id = String(runId || "");
    const payload = JSON.stringify({ admission_id: String(body?.admission_id || ""), execution_generation: Number(body?.execution_generation) });
    let last = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), RESOLVE_TIMEOUT_MS);
      try {
        const res = await fetch(`${base}/v1/runs/${encodeURIComponent(id)}/resolve-unknown`, {
          method: "POST",
          headers: headers(),
          body: payload,
          signal: ctrl.signal,
        });
        const answer = await answerOf(res);
        if (!res.ok) {
          return { ok: false, status: res.status, code: gatewayCode(answer) || `http_${res.status}`, error: text(answer?.error?.message) || `the gateway answered HTTP ${res.status} to the resolve`, receipt: null };
        }
        return { ok: true, status: res.status, code: null, error: null, receipt: answer };
      } catch (err) {
        last = err;
      } finally {
        clearTimeout(t);
      }
    }
    return { ok: false, status: 0, code: "transport", error: `could not reach the gateway to resolve run ${id}: ${String((last && last.message) || last)}`, receipt: null };
  }

  // The backlog behind the fence. A queued run is cancellable — the store's `cancel_session_input` turns it
  // terminal/cancelled — while the `unknown` head is the one row a stop refuses (409). Cancelling first is what
  // stops a clear from replaying every stale turn the panel posted while it could not know the session was dead:
  // measured on this box, one clear released ten of them on Assistant #3 and six on Assistant #1, which ran as six
  // completed turns whose cards had been written off minutes earlier. 404 is the state being asked for (no such run
  // is not running); any other refusal is reported and does not stop the resolve.
  async function stopRun(runId) {
    const id = String(runId || "");
    if (!id) return { ok: false, status: 0, code: "invalid_params", error: "a run id is required" };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), RUN_TIMEOUT_MS);
    try {
      const res = await fetch(`${base}/v1/runs/${encodeURIComponent(id)}/stop`, { method: "POST", headers: headers(), signal: ctrl.signal });
      const body = await answerOf(res);
      if (res.status === 404) return { ok: true, status: 404, code: null, error: null, already: true };
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          code: gatewayCode(body) || `http_${res.status}`,
          error: text(body?.error?.message) || `the gateway answered HTTP ${res.status} to the stop`,
          already: false,
        };
      }
      return { ok: true, status: res.status, code: null, error: null, already: false };
    } catch (err) {
      return { ok: false, status: 0, code: "transport", error: `could not reach the gateway to stop run ${id}: ${String((err && err.message) || err)}`, already: false };
    } finally {
      clearTimeout(t);
    }
  }

  return { base, getRun, resolveUnknown, stopRun };
}

/** What this endpoint can see of one assistant's fences, wakes and watches, and what it would keep. Every row is the
 * row that was read: the dry run's whole job is "exactly what would be cleared", and a count cannot be checked
 * against the store. */
export async function enumerateReset({ assistant, rec, gateway, dbPath, now = Date.now() }) {
  const id = String(rec.id);
  const threadId = String(rec.threadId);
  const store = unknownAdmissions(dbPath, threadId);
  const cards = (assistant.jobs.list() || []).filter((j) => j && String(j.thread || "") === threadId && j.runId);

  // The gateway's answer per run id, never the card's cached status or generation. One answer per id: the fallback
  // naming path below can ask about a run a card already named, and two GETs inside one enumeration could disagree.
  const answers = new Map();
  const probe = async (runId) => {
    const key = String(runId || "");
    if (!answers.has(key)) answers.set(key, await gateway.getRun(key));
    return answers.get(key);
  };
  const probed = [];
  for (const card of cards) {
    const answer = await probe(card.runId);
    probed.push({ card, answer, run: answer.ok ? answer.run : null });
  }

  const live = probed
    .filter((p) => p.run && isExecutingRun(p.run))
    .map((p) => ({
      runId: String(p.card.runId),
      status: String(p.run.status || ""),
      pendingControls: Array.isArray(p.run.pending_controls) ? p.run.pending_controls.length : 0,
      card: { id: p.card.id, status: p.card.status || null, startedAt: p.card.startedAt || null },
    }));
  const queued = probed
    .filter((p) => p.run && String(p.run.status || "") === "queued")
    .map((p) => ({
      runId: String(p.card.runId),
      executionGeneration: generationOf(p.run),
      card: p.card.id,
    }));
  const unreadable = probed
    .filter((p) => !p.run)
    .map((p) => ({
      runId: String(p.card.runId),
      card: p.card.id,
      status: p.answer.status || null,
      code: p.answer.code || null,
      error: p.answer.error || null,
    }));
  const unknownRuns = probed.filter((p) => p.run && String(p.run.status || "") === "unknown");

  // §3.3 step 5: a store row with a card whose run still answers `unknown` is clearable. The row's own generation is
  // evidence only — the POST uses the fresh GET's value.
  //
  // The fallback half, for a row no card names: the admissions store also holds the `request_id` the turn was
  // admitted under, and that is a run id the gateway still answers for long after the card is gone. The name is
  // VERIFIED, never guessed — the GET must return `status: "unknown"` AND this row's own `admission_id` — and any
  // other answer (a 404, another status, another admission) leaves the row unnameable with the reason the check
  // refused, so the existing `fence_unclearable` copy still stands. Nothing is POSTed here: a GET has no side
  // effect, and the real call re-reads the same id before it sends anything.
  async function nameByStoreRequest(row) {
    const runId = String(row.requestId || "");
    if (!runId) {
      return { refusal: "no_request_id", reason: "the fence row carries no request id, so there is no run to ask" };
    }
    const answer = await probe(runId);
    if (!answer.ok) {
      return {
        refusal: answer.status === 404 ? "run_not_found" : "run_unreadable",
        reason:
          answer.status === 404
            ? `the store's request id ${runId} is gone from the gateway (404)`
            : `the gateway did not answer for the store's request id ${runId} (${answer.code || `HTTP ${answer.status || 0}`})`,
      };
    }
    const run = answer.run;
    const admissionId = String(run.admission_id || "");
    if (admissionId !== String(row.admissionId)) {
      return {
        refusal: "admission_mismatch",
        reason: `the run at the store's request id ${runId} owns ${admissionId || "no admission"}, not ${row.admissionId}`,
      };
    }
    // A verified run that is executing is the same refusal a card's executing run earns: a reset never touches a
    // live turn. `queued` is excluded on purpose — see EXECUTING_RUN_STATUSES.
    if (isExecutingRun(run)) {
      live.push({
        runId,
        status: String(run.status || ""),
        pendingControls: Array.isArray(run.pending_controls) ? run.pending_controls.length : 0,
        card: null,
        namedBy: "store-request-id",
      });
      return { refusal: "run_executing", reason: `the run at the store's request id ${runId} is executing (${String(run.status || "no status")})` };
    }
    const status = String(run.status || "");
    if (status !== "unknown") {
      if (status === "queued") queued.push({ runId, executionGeneration: generationOf(run), card: null });
      return { refusal: "not_unknown", reason: `the run at the store's request id ${runId} now reads ${status || "no status"}, not unknown` };
    }
    return {
      admission: {
        runId,
        admissionId,
        executionGeneration: generationOf(run),
        card: null,
        evidence: { runStatus: "unknown", storeGeneration: row.generation, answers: [], namedBy: "store-request-id", requestId: runId },
        action: "resolve-unknown",
      },
    };
  }

  const admissions = [];
  const unnameable = [];
  for (const row of store.rows || []) {
    const hit = unknownRuns.find((p) => String(p.run.admission_id || "") === String(row.admissionId));
    if (hit) {
      admissions.push({
        runId: String(hit.card.runId),
        admissionId: String(hit.run.admission_id || row.admissionId),
        executionGeneration: generationOf(hit.run),
        card: { id: hit.card.id, status: hit.card.status || null, startedAt: hit.card.startedAt || null },
        evidence: {
          runStatus: String(hit.run.status || "unknown"),
          storeGeneration: row.generation,
          answers: (Array.isArray(hit.card.unknownAnswers) ? hit.card.unknownAnswers : []).map((a) => [Number(a.at) || null, String(a.runStatus || a.http || "")]),
          namedBy: "card",
        },
        action: "resolve-unknown",
      });
      continue;
    }
    const named = await nameByStoreRequest(row);
    if (named.admission) {
      admissions.push(named.admission);
      continue;
    }
    unnameable.push({
      admissionId: row.admissionId,
      generation: row.generation,
      seq: row.seq,
      ownerEpoch: row.ownerEpoch,
      threadId: row.threadId,
      requestId: row.requestId || null,
      refusal: named.refusal,
      reason: named.reason,
    });
  }

  const wakes = (assistant.pendingWake || [])
    .filter((w) => wakeOwnerOf(w) === id)
    .map((w) => ({
      reason: w.reason || "",
      rule: w.rule || null,
      assistantId: id,
      at: Number.isFinite(Number(w.at)) ? Number(w.at) : null,
      ageMs: Number.isFinite(Number(w.at)) ? Math.max(0, now - Number(w.at)) : null,
    }));
  const watches = (assistant.watchesFor ? assistant.watchesFor(id) : []).map((w) => ({
    id: w.id,
    thread: w.thread,
    title: w.title,
    at: w.at,
    state: w.state,
  }));

  // The keep counts. Reads only: nothing here writes a queue, a note, a rule or the charter.
  const queue = assistant.queueView ? assistant.queueView(id) : { tasks: [] };
  const notes = assistant.notesFor ? String(assistant.notesFor(id) || "") : String(assistant.notes || "");
  const rules = assistant.rulesFor ? assistant.rulesFor(id) || [] : [];
  const alerts = Array.isArray(assistant.alerts) ? assistant.alerts.filter((a) => (assistant.alertOwnerOf ? assistant.alertOwnerOf(a) : id) === id).length : 0;
  const charter = charterOf(assistant, id);
  const keep = {
    queue: { rows: Array.isArray(queue.tasks) ? queue.tasks.length : 0 },
    scratchpad: { notes: notes.length, rules: rules.length, journal: Array.isArray(assistant.journal) ? assistant.journal.length : 0, alerts },
    charter: { chars: charter.chars, sha: charter.sha },
  };

  let verdict = "clean";
  if (store.ok && store.rows.length > 0) verdict = unnameable.length > 0 ? "blocked" : "clearable";
  return {
    assistant: { id, name: rec.name, threadId },
    store,
    admissions,
    unnameable,
    queued,
    unreadable,
    live,
    wakes,
    watches,
    keep,
    verdict,
    stillFenced: Boolean(store.ok && store.rows.length > 0),
  };
}

/** The charter's size and a short sha of its raw bytes. A read; a missing file reports 0 chars and the empty hash
 * rather than seeding anything, because a dry run must not write. */
function charterOf(assistant, id) {
  let meta = {};
  try {
    meta = assistant.charterMetaFor ? assistant.charterMetaFor(id) || {} : {};
  } catch {
    meta = {};
  }
  let raw = "";
  try {
    if (meta.path && meta.exists) raw = readFileSync(meta.path, "utf8");
  } catch {
    raw = "";
  }
  return { chars: Number(meta.chars) || raw.length, sha: createHash("sha256").update(raw).digest("hex").slice(0, 12) };
}

/**
 * Drop this assistant's local state, after the gateway has settled every admission the reset named.
 *
 * Only `pendingWake` entries routed to THIS assistant go; another assistant's batch survives, and the one shared
 * `wakeTimer` is cleared ONLY when nothing is left queued — clearing it with another assistant's entries still
 * waiting would silently park that assistant's wake. `wakes` (the hourly sweep ledger), `terminalWakes` and
 * `restartWakes` (dedupe keys) are never touched: a reset is not a restart and must not make one report twice.
 * Watches are filtered by `watchOwnerOf`, on whatever thread they were placed. Every dropped wake is journalled with
 * its reason, rule and age; one `reset` line closes the entry.
 */
export function clearAssistantLocal({ assistant, rec, settled = 0, cancelled = 0, reason = "", now = Date.now() }) {
  const id = String(rec.id);
  const threadId = String(rec.threadId);
  const keptWakes = [];
  const droppedWakes = [];
  for (const w of assistant.pendingWake || []) {
    const owner = wakeOwnerOf(w);
    if (owner !== id) {
      keptWakes.push(w);
      continue;
    }
    const ageMs = Number.isFinite(Number(w.at)) ? Math.max(0, now - Number(w.at)) : null;
    droppedWakes.push({ reason: w.reason || "", rule: w.rule || null, assistantId: id, at: Number.isFinite(Number(w.at)) ? Number(w.at) : null, ageMs });
    const age = ageMs == null ? "" : `, ${Math.max(0, Math.round(ageMs / 60_000))}m old`;
    assistant.journalAdd?.("wake-dropped", threadId, `dropped a queued wake: ${clip(w.reason || "(no reason)", 180)} (rule ${w.rule || "event"}${age})`);
  }
  assistant.pendingWake = keptWakes;
  if (!keptWakes.length && assistant.wakeTimer) {
    clearTimeout(assistant.wakeTimer);
    assistant.wakeTimer = null;
  }

  const keptWatches = [];
  const droppedWatches = [];
  for (const w of assistant.watches || []) {
    const owner = assistant.watchOwnerOf ? assistant.watchOwnerOf(w) : id;
    if (owner !== id) {
      keptWatches.push(w);
      continue;
    }
    droppedWatches.push({ id: w.id, thread: w.thread, title: w.title, at: w.at, state: w.state });
  }
  assistant.watches = keptWatches;
  // The dropped wakes are re-derivable; the next sweep may say so even at the hourly cap.
  assistant.forceSweepFor?.add(id);

  assistant.journalAdd?.(
    "reset",
    threadId,
    `${rec.name} reset: ${settled ? `${settled} admission(s) settled (interrupted; the projection now reads cancelled), ` : ""}` +
      `${cancelled ? `${cancelled} queued turn(s) cancelled so the clear does not replay them, ` : ""}` +
      `${droppedWatches.length} watch(es) dropped, ${droppedWakes.length} wake(s) dropped${reason ? ` — ${reason}` : ""}`,
  );
  assistant.persist?.();
  assistant.emit?.();
  return { wakes: droppedWakes, watches: droppedWatches };
}

/**
 * The whole reset, dry or real, in the design's order: single-flight (the route owns it), enumerate, refuse, resolve,
 * re-read, clear locally, respond. `dryRun` removes only the mutating POST and the local clearing; the GETs are the
 * same, because a GET has no side effect.
 */
export async function runReset({ assistant, rec, gateway, dbPath, dryRun = false, reason = "", now = Date.now() }) {
  const enumerated = await enumerateReset({ assistant, rec, gateway, dbPath, now });
  const base = {
    dryRun: Boolean(dryRun),
    assistant: enumerated.assistant,
    block: { unnameable: enumerated.unnameable, queued: enumerated.queued, unreadable: enumerated.unreadable },
    verdict: enumerated.verdict,
    stillFenced: enumerated.stillFenced,
  };

  if (!enumerated.store.ok) {
    return {
      status: 500,
      body: {
        ok: false,
        ...base,
        code: "store_unreadable",
        error: `could not read the session store for ${rec.threadId}: ${enumerated.store.error}. Nothing was cleared.`,
      },
    };
  }

  if (enumerated.live.length) {
    const run = enumerated.live[0];
    const started = Date.parse(run.card?.startedAt || "");
    const age = Number.isFinite(started) ? ` · started ${Math.max(0, Math.round((now - started) / 60_000))}m ago` : "";
    return {
      status: 409,
      body: {
        ok: false,
        code: "assistant_live",
        error: `not reset — ${rec.name} has a run still executing (${run.runId}${age}). Wait for it or stop it on its card; a reset never touches an executing turn.`,
        runId: run.runId,
        thread: rec.threadId,
        assistant: enumerated.assistant,
        stillFenced: enumerated.stillFenced,
      },
    };
  }

  // Every unknown row on the session unnameable: there is nothing this endpoint can do, and clearing the watches
  // around a fence that is still standing would be a lie (design §3.6). Some-named-some-unnameable is NOT this
  // refusal: the named rows are resolved, the re-read reports incomplete, and nothing local is cleared.
  if (enumerated.store.rows.length > 0 && enumerated.unnameable.length === enumerated.store.rows.length) {
    const first = enumerated.unnameable[0];
    const more = enumerated.unnameable.length > 1 ? ` (and ${enumerated.unnameable.length - 1} more)` : "";
    return {
      status: 409,
      body: {
        ok: false,
        code: "fence_unclearable",
        error:
          `not reset — the fence on ${rec.threadId} is held by an admission no card here names ` +
          `(admission ${first.admissionId} · generation ${first.generation})${more}. This endpoint can only settle an ` +
          `admission through the run that owns it; there is no session-keyed resolve. Nothing would be cleared, ` +
          `including the watches. Continue that session in a terminal: hermes --resume ${rec.threadId}`,
        thread: rec.threadId,
        assistant: enumerated.assistant,
        admissions: enumerated.unnameable,
        stillFenced: true,
      },
    };
  }

  if (dryRun) {
    return {
      status: 200,
      body: {
        ok: true,
        ...base,
        clear: {
          admissions: enumerated.admissions,
          queued: enumerated.queued,
          wakes: enumerated.wakes,
          watches: enumerated.watches,
        },
        keep: enumerated.keep,
      },
    };
  }

  // Gateway first, and the BACKLOG first of all. Every queued run behind the fence is a turn the panel posted while
  // it could not know the session was dead; clearing the head resumes the FIFO, so they would all run at once. Their
  // cards are already written off, so they are cancelled here rather than replayed — a stop on a queued row is a
  // cancellation (`cancel_session_input`), and only an `unknown` row refuses one. A failed cancellation is reported
  // and does not hold the resolve: the fence is still the worse state.
  const cancelled = [];
  if (enumerated.admissions.length && enumerated.queued.length) {
    for (const row of enumerated.queued) {
      const answer = await gateway.stopRun(row.runId);
      cancelled.push({
        runId: row.runId,
        card: row.card ?? null,
        ok: Boolean(answer.ok),
        already: Boolean(answer.already),
        status: answer.status || null,
        code: answer.code || null,
        error: answer.error || null,
      });
    }
  }

  // One fresh GET per candidate, then the resolve built from THAT answer. The enumeration's GET is
  // only the dry run's row; a real call asks again so the generation a slow enumerate read cannot go stale mid-call.
  const receipts = [];
  for (const candidate of enumerated.admissions) {
    const namedBy = candidate.evidence?.namedBy || "card";
    const fresh = await gateway.getRun(candidate.runId);
    if (!fresh.ok) {
      receipts.push({ runId: candidate.runId, admissionId: candidate.admissionId, namedBy, ok: false, status: fresh.status || null, code: fresh.code || "unreadable", error: fresh.error || "the fresh GET failed", receipt: null });
      continue;
    }
    if (String(fresh.run?.status || "") !== "unknown") {
      receipts.push({ runId: candidate.runId, admissionId: candidate.admissionId, namedBy, ok: false, status: fresh.status || null, code: "not_unknown", error: `the run now reads ${String(fresh.run?.status || "no status")}`, receipt: null });
      continue;
    }
    const admissionId = String(fresh.run.admission_id || "");
    const generation = generationOf(fresh.run);
    // The fresh GET is the authority, so the pair is re-pinned here: a run that now names another admission is
    // refused, not resolved (the fallback's whole guarantee is that the admission id on the wire is this row's).
    if (candidate.admissionId && admissionId !== String(candidate.admissionId)) {
      receipts.push({ runId: candidate.runId, admissionId, namedBy, ok: false, status: fresh.status || null, code: "admission_mismatch", error: `the fresh GET names admission ${admissionId || "(none)"}, not ${candidate.admissionId}`, receipt: null });
      continue;
    }
    if (!admissionId || !generation) {
      receipts.push({ runId: candidate.runId, admissionId, namedBy, ok: false, status: fresh.status || null, code: "invalid_params", error: "the fresh GET did not name both admission_id and execution_generation", receipt: null });
      continue;
    }
    const answer = await gateway.resolveUnknown(candidate.runId, { admission_id: admissionId, execution_generation: generation });
    receipts.push({
      runId: candidate.runId,
      admissionId,
      executionGeneration: generation,
      namedBy,
      ok: Boolean(answer.ok),
      status: answer.status || null,
      code: answer.code || null,
      error: answer.error || null,
      receipt: answer.receipt || null,
    });
  }

  // The store is the verdict, not the card and not the receipt. Any row still unknown stops the local half.
  const after = unknownAdmissions(dbPath, rec.threadId);
  const stillFenced = !after.ok || after.rows.length > 0;
  if (stillFenced) {
    return {
      status: 200,
      body: {
        ok: false,
        ...base,
        verdict: "incomplete",
        stillFenced: true,
        cleared: { admissions: receipts.filter((r) => r.ok), cancelled, wakes: [], watches: [] },
        kept: enumerated.keep,
        receipts,
        error:
          `reset INCOMPLETE — ${receipts.filter((r) => r.ok).length} of ${receipts.length} admission(s) cleared; the ` +
          `session is still fenced, so nothing local was cleared (${enumerated.watches.length} watch(es) and ` +
          `${enumerated.wakes.length} wake(s) kept). Re-run to retry the remaining row.` +
          (after.ok ? "" : ` The store re-read itself failed: ${after.error}.`),
      },
    };
  }

  const cleared = clearAssistantLocal({ assistant, rec, settled: receipts.filter((r) => r.ok).length, cancelled: cancelled.filter((c) => c.ok).length, reason, now });
  return {
    status: 200,
    body: {
      ok: true,
      ...base,
      verdict: "clean",
      stillFenced: false,
      cleared: {
        admissions: receipts.filter((r) => r.ok).map(({ receipt, ...row }) => row),
        cancelled,
        wakes: cleared.wakes,
        watches: cleared.watches,
      },
      kept: enumerated.keep,
      receipts,
    },
  };
}

/**
 * `POST /api/assistants/:id/reset`. The first path-param route in the server, so matching is explicit and `false`
 * means "not mine" to the dispatcher. `GET` on the path is 405 (the dry run is a POST with a body, so the read never
 * depends on query-string parsing of a path id). `dryRun` is the only thing that decides whether the gateway is
 * asked to settle anything; `reason` is optional and journalled.
 */
export function createResetRoutes({ assistant, config = {}, sendJson, readBody, authorised, gateway = null, dbPath = null } = {}) {
  if (!assistant) throw new Error("createResetRoutes needs the Assistant instance");
  if (typeof sendJson !== "function" || typeof readBody !== "function" || typeof authorised !== "function") {
    throw new Error("createResetRoutes needs sendJson, readBody and authorised from the server's transport");
  }
  const gw = gateway || gatewayClient(assistant);
  const storePath = dbPath || path.join(hermesHome(), "state.db");
  const inFlight = new Set();

  return async function resetRoutes(req, res, route) {
    const m = RESET_ROUTE.exec(String(route || ""));
    if (!m) return false;
    if (req.method !== "POST") {
      sendJson(res, 405, { error: `${req.method} is not allowed on ${route}` });
      return true;
    }
    if (!authorised(req, config.token)) {
      sendJson(res, 403, { error: "bad or missing x-panel-token" });
      return true;
    }
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      sendJson(res, 400, { error: String((err && err.message) || err) });
      return true;
    }
    const payload = body && typeof body === "object" && !Array.isArray(body) ? body : {};
    const extra = Object.keys(payload).filter((k) => !KNOWN_FIELDS.has(k));
    if (extra.length) {
      sendJson(res, 400, { ok: false, code: "invalid_params", error: `unknown field(s): ${extra.join(", ")} — this route takes dryRun and reason only` });
      return true;
    }
    if ("dryRun" in payload && typeof payload.dryRun !== "boolean") {
      sendJson(res, 400, { ok: false, code: "invalid_params", error: "dryRun must be a boolean" });
      return true;
    }
    let id;
    try {
      id = decodeURIComponent(m[1]);
    } catch {
      id = m[1];
    }
    const rec = (assistant.roster ? assistant.roster() : assistant.assistants || []).find((a) => a && String(a.id) === String(id));
    if (!rec) {
      sendJson(res, 404, { ok: false, code: "assistant-unknown", error: `no such assistant: ${id}` });
      return true;
    }
    const dryRun = payload.dryRun === true;
    const reason = clip(text(payload.reason), REASON_MAX);
    if (!dryRun) {
      if (inFlight.has(id)) {
        sendJson(res, 409, { ok: false, code: "reset_in_progress", error: `not reset — ${rec.name} already has a reset running`, thread: rec.threadId });
        return true;
      }
      inFlight.add(id);
    }
    try {
      const out = await runReset({ assistant, rec, gateway: gw, dbPath: storePath, dryRun, reason });
      sendJson(res, out.status, out.body);
    } catch (err) {
      sendJson(res, 500, { ok: false, code: "reset_failed", error: String((err && err.message) || err) });
    } finally {
      if (!dryRun) inFlight.delete(id);
    }
    return true;
  };
}
