// Hermes HTTP Runs API transport.
//
// Everything in this file talks to the Hermes gateway over HTTP: probing it, posting a run, holding its SSE
// stream, polling its status, and the control calls (steer, approval, clarify, stop). The job state machine
// stays in Jobs; this class only moves bytes and feeds what comes back through `jobs.consume()` / `jobs.settle()`.
// Moved here from lib/jobs.js with no behaviour change (2b), so the bodies read exactly as they did there.

import path from "node:path";
import { Transport } from "./transport.js";
import {
  fmtWait, frameEvent, isLiveJobStatus, remoteWriteLine, retry429DelayMs, retry429Settings, retryAfterMs, runRefusal, runResultLine,
  STREAM_RETRY_MAX_MS, STREAM_RETRY_MS, todoBlockText,
} from "./jobs.js";
// The sentence a worker gets about where its branch lands, and the scratch line every spawn prompt carries.
import { branchLandingLine } from "./branch-policy.js";
import { scratchLine } from "./paths.js";
import { gatewayIdentity } from "./hermes-runtime.js";

const TERMINAL_RUN = new Set(["completed", "failed", "cancelled", "interrupted"]);

export class HermesTransport extends Transport {
  constructor({ jobs, onLog } = {}) {
    super({ onLog });
    this.jobs = jobs;
    this.state = { url: this.api.url, reachable: null, checkedAt: 0, capabilities: null, error: null, keyed: Boolean(this.api.key) };
  }

  // The same object Jobs holds (server.js hands it to the approval reader), so a key loaded late is seen here too.
  get api() {
    return this.jobs.api;
  }

  headers(extra = {}) {
    const h = { "Content-Type": "application/json", ...extra };
    if (this.api.key) h.Authorization = `Bearer ${this.api.key}`;
    return h;
  }

  // What this transport is, for the settings surface and logs.
  info() {
    return { agent: "hermes", ...this.state };
  }

  // Cheapest possible answer to "can this panel run anything right now?" — the settings surface and
  // the spawn route both ask before promising a job.
  async probe({ fresh = false } = {}) {
    const jobs = this.jobs;
    const now = Date.now();
    if (!fresh && this.state.checkedAt && now - this.state.checkedAt < 15_000) return this.state;
    if (!this.api.key) {
      this.state = { ...this.state, reachable: false, checkedAt: now, keyed: false, error: "no API_SERVER_KEY (add it to the Hermes .env, or apiServer.key in config.json)" };
      return this.state;
    }
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(`${this.api.url}/v1/capabilities`, { headers: this.headers(), signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const caps = await res.json();
      const features = caps.features || {};
      // A different gateway version is a different build, so a refusal observed on the old one is
      // not evidence about this one — the record clears and is re-learned from the next run's events.
      jobs.clarify.noteVersion(caps.version);
      this.state = {
        url: this.api.url,
        reachable: true,
        checkedAt: now,
        keyed: true,
        error: null,
        capabilities: {
          runs: Boolean(features.run_submission),
          events: Boolean(features.run_events_sse),
          steer: Boolean(features.run_steer),
          stop: Boolean(features.run_stop),
          approval: Boolean(features.run_approval_response),
          // The local gateway patch adds these. A stock gateway ignores the fields silently, so the
          // panel says which of them this run will actually honour.
          runCwd: Boolean(features.run_cwd),
          runBudget: Boolean(features.run_budget),
          maxTurns: Boolean(features.max_turns),
          version: caps.version || null,
          // true/false only once a run has proved it either way; null means "not observed yet" and
          // the panel behaves exactly as it did before this check existed. See lib/clarify.js.
          clarify: jobs.clarify.state().available,
        },
      };
    } catch (e) {
      this.state = { ...this.state, reachable: false, checkedAt: now, keyed: true, error: String((e && e.message) || e) };
    }
    return this.state;
  }

  // Post the run for a job Jobs has already set up (record, tree, base commit), then start watching it.
  // Returns the job's summary, failed or running.
  async create(j, { prompt, opts = {}, thread, cwd, cutParent = null, cutPolicy = null }) {
    const jobs = this.jobs;
    // The body carries `cwd` and this gateway ACCEPTS it - it advertises `run_cwd`, validates the directory and
    // binds it per run - but the run's tools still execute in the gateway's own directory. Measured 2026-10-27 on
    // the live gateway: a run posted with cwd .../hermes/cache/scratch/cwd-canary answered `pwd` with
    // /c/Users/roper and its `touch wtgui-cwd-canary.txt` landed in C:/Users/roper (run_71e423e058d84457b79baeb5403a762a).
    // So the directory travels in the prompt as well - the one channel the run definitely reads - and the agent is
    // told to cd once and to use absolute paths. A sentence here that says the field does not exist would be a lie
    // about the wire; what is true is that sending it is not enough.
    const where = typeof cwd === "string" && path.isAbsolute(cwd) ? cwd.split("\\").join("/").replace(/\/+$/, "") : null;
    // ---- the worktree's TODO list, on the way in -----------------------------------------------------------
    // Every run that works in a tree is handed that tree's list — WITH ITS IDS, because an agent cannot mark an item
    // done without knowing which number it is — plus the standing instruction to keep it current: add what it
    // discovers, mark what its own work closes, and RECONCILE THE LIST AGAINST ITS OWN COMMITS before it finishes.
    //
    // `opts.todoSeed` is the assistant's acceptance items for this card (a `TODO <text>` line under its SPAWN):
    // they are written to the list FIRST, so the ids the worker is handed are the ids of its own items.
    //
    // It rides AFTER the "Work in …" sentence, which is what keeps it out of the branch's description
    // (lib/descriptions.js strips that wrapper and everything under it) while still being part of the text the run
    // receives. `j.prompt` — what the card shows and what the description is derived from — stays the reader's own
    // brief.
    let todoHere = null;
    if (jobs.todos && where && opts.anchorCwd !== false) {
      const seed = Array.isArray(opts.todoSeed) ? opts.todoSeed.map((t) => String(t ?? "").trim()).filter(Boolean) : [];
      if (seed.length) {
        const made = jobs.todos.seed({ project: opts.project || null, path: cwd, texts: seed, by: "assistant", from: "spawn" });
        if (made.length) jobs.push(j, { kind: "dim", text: `⇢ seeded this tree's TODO list with ${made.length} item(s) from the brief (ids ${made[0].id}..${made[made.length - 1].id})` });
      }
      todoHere = jobs.todos.forRow(opts.project || null, cwd, { journal: 0 });
    }
    const todoText = where && opts.anchorCwd !== false ? todoBlockText(todoHere, where, opts.project || "") : "";
    // `anchorCwd: false` is for a turn that is not meant to work in a directory at all (the panel's own
    // assistant reads the board, it never runs a command there), so the sentence would be a lie in its prompt —
    // and so would a tree-kind line, since there is no tree. THAT is what keeps this paragraph off the assistant's
    // own runs, and it is structural rather than a flag somebody has to remember: the assistant is the only caller
    // that asks for a turn with no directory, and a turn with no directory has no tree to land.
    //
    // A run started to LAND keeps the landing line it already had (`WILL LAND: … push it and open a pull request`):
    // a merge agent's instruction is the merge script's, and a second paragraph about its parent would contradict it.
    // Every other worker gets the paragraph for the parent of ITS tree, which lib/branch-policy.js renders from the
    // branch the tree was cut from — read at the cut (above), from the panel's cut record, or from git's own
    // upstream. When none of those can name it, `branchLandingLine` returns "" and the blanket LOCAL-ONLY line
    // stands: the fallback is the rule we already had, never a guessed `main`.
    const landing = opts.remoteWrite === "land" || opts.landing === true;
    // No tree (the assistant), a run that is already landing, or one the caller muted: no parent is asked for at all,
    // so those turns pay no git call for a sentence they will not carry.
    const wantsParent = Boolean(where) && opts.anchorCwd !== false && opts.remoteWrite !== "none" && !landing;
    const parentBranch = wantsParent
      ? await jobs.parentBranchFor({ tree: cwd, branch: j.branch || null, known: opts.parentBranch || cutParent })
      : null;
    const parentLine = parentBranch
      ? branchLandingLine({ parent: parentBranch, branch: j.branch || null, policy: opts.branchPolicy || cutPolicy, remote: opts.remote, cwd: where }, where)
      : "";
    const kindLine =
      opts.anchorCwd === false || opts.remoteWrite === "none"
        ? ""
        : landing
          ? remoteWriteLine(opts, where)
          : parentLine || remoteWriteLine(opts, where);
    // Where this run's throwaway files belong, and the habit it replaces. Tagged with the job's own id so two runs
    // never sort their comparisons into the same folder, and stated in the prompt because it is the one channel a
    // run definitely reads (the gateway ignores a run body's `cwd`, see the comment above).
    const scratchText = where && opts.anchorCwd !== false ? scratchLine(jobs.scratchDir, j.id) : "";
    const anchored = where && opts.anchorCwd !== false
      ? `${kindLine}${kindLine ? "\n\n" : ""}${prompt}\n\nWork in ${where} — run \`cd "${where}"\` before your first terminal command, and use absolute paths under it for file tools; the agent host may have started you in a different directory.${scratchText ? `\n${scratchText}` : ""}${todoText ? `\n\n${todoText}` : ""}`
      : prompt;
    // Context the panel supplies on the turn's behalf rides in the input, ahead of the prompt: the card must
    // show what the reader (or the sentry) said, not a copy of the scratchpad.
    const pre = opts.preamble ? `${String(opts.preamble).trim()}\n\n---\n\n` : "";
    // A run on a gateway build that cannot deliver a clarify question is told so in its own input —
    // the one channel a run definitely reads. The hint appears only after a refusal has actually been
    // observed (lib/clarify.js), so a build that works is never lectured and an unknown build keeps
    // the old behaviour. This covers the board assistant's own turn and every worker the panel starts:
    // both post through this one body.
    const clarifyHint = jobs.clarify?.instruction?.() || "";
    const body = { input: pre + anchored + (clarifyHint ? `\n\n${clarifyHint}` : ""), session_id: thread, cwd };
    if (opts.model) body.model = String(opts.model);
    if (opts.maxTurns) body.max_turns = Number(opts.maxTurns);
    if (opts.budget) body.run_budget = Number(opts.budget);

    // A line the spawner wants on the card, ahead of the request: a SPAWN IN name that had to be resolved to a
    // real tree is what this exists for, and the card is where the reader judges where that run went.
    if (opts.note) jobs.push(j, { kind: "dim", text: String(opts.note) });
    jobs.push(j, { kind: "cmd", text: `POST ${this.api.url}/v1/runs · session ${thread} · cwd ${cwd}` });
    if (anchored !== prompt) {
      jobs.push(j, {
        kind: "dim",
        text: `⇢ asked to work in ${where} — this gateway accepts the run's cwd and still starts the tools in its own directory, so the prompt tells the agent to cd there`,
      });
    }
    if (pre) jobs.push(j, { kind: "dim", text: "⇢ assistant context attached — scratchpad, watches and the board digest ride with this turn" });
    jobs.onLog(`run ${j.id}: session ${thread} cwd ${cwd}`);

    // ---- the POST, with the gateway's own backpressure absorbed ------------------------------
    // A 429 from this route is the gateway's concurrent-run cap, not a verdict on the run: it means "no
    // slot right now" (see RETRY_429_DEFAULTS). Marking the turn failed on it threw away a run the gateway
    // would have accepted a second later, so the SAME request is sent again, the turn is held as `waiting`
    // while it waits, and only an exhausted budget is reported as a failure — with the wait and the tries it
    // cost. Nothing else is retried, nothing is re-sent after the reader cancels, and this is never a second
    // turn: one job, one thread, one turn, one worktree and one POST in flight at a time.
    const retry = retry429Settings(jobs.config);
    const held = { attempts: 0, since: Date.now() };
    const readDetail = async (response) => {
      try {
        const err = await response.json();
        return err?.error?.message || err?.message || JSON.stringify(err).slice(0, 300);
      } catch {
        return await response.text().catch(() => "");
      }
    };
    // The reader's cancel wins over the retry, always: a turn they stopped is never sent again, and it stops
    // being held the moment they say so. (No `error` is set — a cancelled turn is a decision, not a fault,
    // and an error here would put the card's retry button on it and read as a failure.)
    const giveUpHeld = () => {
      j.waiting = null;
      j.status = "cancelled";
      jobs.terminate(j, "reader");
      j.endedAt = new Date().toISOString();
      jobs.push(j, { kind: "raw", text: `cancelled while waiting for a run slot — the gateway was at its concurrent-run cap (HTTP 429)${held.attempts > 1 ? ` and this turn was held through ${held.attempts} tries` : ""}; it was not sent again` });
      jobs.finalise(j);
      jobs.emit(j);
      return jobs.summary(j);
    };

    let res = null;
    let refused = null;
    for (;;) {
      held.attempts += 1;
      refused = null;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 20_000);
        res = await fetch(`${this.api.url}/v1/runs`, { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: ctrl.signal });
        clearTimeout(t);
      } catch (e) {
        const why = e?.name === "AbortError" ? "the gateway did not answer within 20s" : String((e && e.message) || e);
        res = null;
        refused = { transport: `cannot reach the Hermes gateway at ${this.api.url}: ${why}` };
        break;
      }
      if (res.status !== 429) break;
      // The 429's own words, read now: the response body is consumed here either way, and the failure that
      // reports an exhausted hold has to carry what the gateway actually said.
      const detail = await readDetail(res);
      refused = { detail, afterMs: retryAfterMs(res.headers) };
      if (held.attempts >= retry.attempts) break;
      if (j.cancelRequested) return giveUpHeld();
      const delay = retry429DelayMs(held.attempts, retry, refused.afterMs);
      j.status = "waiting";
      j.waiting = {
        attempt: held.attempts,
        attempts: retry.attempts,
        waitMs: delay,
        since: new Date(held.since).toISOString(),
        until: new Date(Date.now() + delay).toISOString(),
        retryAfterMs: refused.afterMs,
        reason: refused.detail ? String(refused.detail).slice(0, 200) : "",
      };
      jobs.push(j, {
        kind: "dim",
        text: `⇢ the gateway is at its concurrent-run cap (HTTP 429${refused.detail ? `: ${String(refused.detail).slice(0, 160)}` : ""}) — holding this turn, try ${held.attempts + 1} of ${retry.attempts} in ${fmtWait(delay)}`,
      });
      jobs.onLog(`run ${j.id}: gateway at capacity (429) — holding ${fmtWait(delay)} before try ${held.attempts + 1}/${retry.attempts}`);
      jobs.emit(j);
      await new Promise((r) => setTimeout(r, delay));
      if (j.cancelRequested) return giveUpHeld();
    }
    // Past the hold: either an accepted run, or a refusal to report.
    j.waiting = null;

    if (!res) {
      j.status = "failed";
      j.error = refused.transport;
      j.endedAt = new Date().toISOString();
      jobs.push(j, { kind: "raw", text: j.error });
      jobs.finalise(j);
      jobs.emit(j);
      return jobs.summary(j);
    }

    if (!res.ok) {
      // A 429 that survived the whole hold is STILL backpressure — the gateway was busy the entire time, not
      // broken — so the failure says how long it waited and how many tries it cost. Everything else keeps the
      // sentence it had, verbatim: one POST, one verdict, no retry.
      const detail = res.status === 429
        ? String(refused?.detail || "")
        : await readDetail(res);
      j.status = "failed";
      j.error = res.status === 429
        ? `the gateway was still at its concurrent-run cap (HTTP 429) after ${held.attempts} ${held.attempts === 1 ? "try" : "tries"} over ${fmtWait(Date.now() - held.since)} of holding${detail ? `: ${String(detail).slice(0, 300)}` : ""}`
        // 409 + permission_denied is the gateway's surface rule, not a fault: session_api_turn.py refuses an API
        // turn in any session whose source is not api_server/bot_room, and a revived session came from the CLI.
        // Say what to do about it instead of repeating the code.
        : (runRefusal(res.status, detail, { thread, revived: Boolean(j.revived) }) ||
          `gateway refused the run (HTTP ${res.status})${detail ? `: ${String(detail).slice(0, 300)}` : ""}`);
      j.endedAt = new Date().toISOString();
      jobs.push(j, { kind: "raw", text: j.error });
      jobs.finalise(j);
      jobs.emit(j);
      return jobs.summary(j);
    }

    const accepted = await res.json().catch(() => ({}));
    j.runId = accepted.run_id || null;
    // Which gateway PROCESS took this run. A run lives in one process's memory, so this stamp is the only way a
    // later boot can tell "the gateway still has this" from "this belongs to a gateway that is gone" without
    // guessing from clocks (see `stopStaleRuns`).
    if (j.runId) {
      const identity = gatewayIdentity();
      j.gatewayPid = identity?.pid ?? null;
      j.gatewayStart = identity?.startTime ?? null;
    }
    if (!j.runId) {
      j.status = "failed";
      j.error = "gateway accepted the request but returned no run_id";
      j.endedAt = new Date().toISOString();
      jobs.finalise(j);
      jobs.emit(j);
      return jobs.summary(j);
    }
    j.status = "running";
    jobs.push(j, { kind: "init", text: `run ${j.runId} · session ${thread} · cwd ${cwd}` });
    // The strip reads the session's counters, which are cumulative — so remember where they stood when
    // this turn began. Everything after that point belongs to the turn being watched.
    j.baseOutput = jobs.sessionOutput(j.thread);
    j.statsTimer = setInterval(() => jobs.refreshStats(j), 4_000);
    jobs.refreshStats(j);
    jobs.emit(j);

    jobs.armRuntimeCap(j);

    // Backstop for a silently dead stream: the status endpoint is the truth.
    j.poller = setInterval(() => void this.poll(j), 15_000);

    // Subscribe - unless this gateway says it has no event stream to subscribe to. `run_events_sse` is
    // the capability the stream needs; without it the poll above is the only path, and the card says
    // which one it is on instead of reading a quiet stream as a stalled model.
    if (this.state.capabilities === null) await this.probe();
    if (this.state.capabilities?.events === false) {
      j.streamMode = "poll";
      jobs.push(j, { kind: "dim", text: "this gateway does not advertise run_events_sse - this card is polled every 15s instead of streamed" });
      jobs.emit(j);
      return jobs.summary(j);
    }
    void this.follow(j);
    return jobs.summary(j);
  }

  // Subscribe to the run's event stream. A dropped stream is not a lost run: `poll` keeps asking the
  // status endpoint until the run reaches a terminal state.
  async follow(j) {
    // One subscriber per run. `sweepOrphanedRuns` and `reattachRestored` both put a lost card back on
    // its stream; without this guard the second call would run a second loop over the same run and every
    // event would be printed twice.
    if (j.following) return;
    j.following = true;
    const ctrl = new AbortController();
    j.ctrl = ctrl;
    // Whether this panel currently holds the run's event stream. A gateway restart drops it, and the
    // sweep in `sweepOrphanedRuns` reads this before deciding a run is alive or lost.
    j.streamOpen = true;
    let backoff = STREAM_RETRY_MS;
    try {
      while (isLiveJobStatus(j.status) && !ctrl.signal.aborted) {
        const heard = await this.streamOnce(j, ctrl);
        if (!isLiveJobStatus(j.status) || ctrl.signal.aborted) break;
        // The stream ended on its own: the run may have finished without this panel hearing the
        // terminal event, or the socket dropped. Ask the status endpoint, then subscribe again.
        await this.poll(j);
        if (!isLiveJobStatus(j.status)) break;
        if (heard > 0) backoff = STREAM_RETRY_MS;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, STREAM_RETRY_MAX_MS);
      }
    } finally {
      j.following = false;
      j.streamOpen = false;
    }
  }

  // One connection to a run's events. Returns how many frames it read, which is how `follow` tells a
  // stream that delivered and then ended from one that never came up at all.
  async streamOnce(j, runCtrl) {
    const jobs = this.jobs;
    const ctrl = new AbortController();
    const halt = () => ctrl.abort();
    runCtrl.signal.addEventListener("abort", halt, { once: true });
    let heard = 0;
    try {
      const headers = { Accept: "text/event-stream", ...(this.api.key ? { Authorization: `Bearer ${this.api.key}` } : {}) };
      // Resume, do not replay: the seq of the last event this panel consumed, `-1`-safe.
      if (Number.isInteger(j.lastSeq) && j.lastSeq >= 0) headers["Last-Event-ID"] = String(j.lastSeq);
      const res = await fetch(`${this.api.url}/v1/runs/${j.runId}/events`, { headers, signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error(`events HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line; each frame carries `id:` and `data:` lines.
        let cut;
        while ((cut = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const evt = frameEvent(frame);
          if (!evt) continue;
          heard += 1;
          // consume() advances `j.lastSeq`, so a drop mid-frame resumes at the event it printed.
          jobs.consume(j, evt);
        }
      }
    } catch (e) {
      if (!runCtrl.signal.aborted) jobs.onLog(`run ${j.id}: event stream ended (${String((e && e.message) || e)})`);
    } finally {
      runCtrl.signal.removeEventListener("abort", halt);
    }
    return heard;
  }

  // Ask the status endpoint for the truth and settle on it. Covers a stream that never opened and a
  // terminal event that was missed, so a card cannot stay "running" forever.
  async poll(j) {
    const jobs = this.jobs;
    if (!j.runId || !isLiveJobStatus(j.status)) return;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(`${this.api.url}/v1/runs/${j.runId}`, { headers: this.headers(), signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return;
      const run = await res.json();
      // The session-authority gateway fences its control calls on this number: an approval posted without
      // it is rejected as invalid_params, not as a bad choice. Keep it for every control call.
      if (Number.isFinite(Number(run.execution_generation)) && Number(run.execution_generation) > 0) {
        j.executionGeneration = Number(run.execution_generation);
      }
      if (TERMINAL_RUN.has(run.status)) {
        this.jobs.scanTurnUrls(j);
        this.jobs.push(j, runResultLine(run.status, run));
        this.jobs.settle(j, run.status, run);
      }
    } catch {
      /* the next tick tries again */
    }
  }

  // The run's own answer to "what happened to it", or null when the gateway cannot be asked.
  async runStatus(j) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(`${this.api.url}/v1/runs/${j.runId}`, { headers: this.headers(), signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  // What the gateway says about one run, and whether it says anything at all. `known: false` IS the answer
  // here: the gateway is up and has no record of this run id any more.
  async runProbe(j) {
    if (!j?.runId) return { known: null, reachable: false, error: "this turn has no run id" };
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(`${this.api.url}/v1/runs/${j.runId}`, { headers: this.headers(), signal: ctrl.signal });
      clearTimeout(t);
      if (res.status === 404) return { known: false, reachable: true, status: 404 };
      if (!res.ok) return { known: null, reachable: true, status: res.status };
      return { known: true, reachable: true, run: await res.json() };
    } catch (e) {
      return { known: null, reachable: false, error: String((e && e.message) || e) };
    }
  }

  // The whole reason for this transport: a running turn can be corrected without starting a new one.
  async steer(j, clean) {
    const jobs = this.jobs;
    // The list rides WITH the steer: a worker told to change course is handed its tree's TODO list as it stands now,
    // and the same standing instruction (keep it current, reconcile against your own commits before you finish).
    const carried = `${clean}${jobs.todoTailFor(j)}`;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      const res = await fetch(`${this.api.url}/v1/runs/${j.runId}/steer`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ input: carried }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 409 run_not_accepting_steer: the turn crossed its last tool boundary before this arrived.
        return { ok: false, error: body?.error?.message || body?.message || `HTTP ${res.status}`, code: body?.error?.code || body?.code || null };
      }
      this.jobs.push(j, { kind: "dim", text: `⇢ steer sent: ${clean.slice(0, 200)}` });
      return { ok: true, accepted: Boolean(body.accepted), runId: j.runId };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // What a control call has to carry to be read at all. The session-authority gateway answers `invalid_params`
  // for a body that is not exactly {request_id, execution_generation, choice}, and this gateway's approval.request
  // event names neither the prompt nor the generation - so both come from the run's pending_controls, matched to
  // the card by its command when the run has more than one control parked.
  async controlContext(j, kind = "approval") {
    const out = { promptId: null, generation: Number(j?.executionGeneration) || 0 };
    if (!j?.runId) return out;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(`${this.api.url}/v1/runs/${j.runId}`, { headers: this.headers(), signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) return out;
      const run = await res.json();
      const gen = Number(run.execution_generation);
      if (Number.isFinite(gen) && gen > 0) {
        out.generation = gen;
        j.executionGeneration = gen;
      }
      const pending = Array.isArray(run.pending_controls) ? run.pending_controls : [];
      // A parked run can hold both kinds at once (a clarify from an older tool call, an approval for the
      // next command), so the control a call is about has to be picked by its own kind — an approval body
      // sent with a clarify's prompt id is `invalid_params`, not a helpful error.
      const mine = pending.filter((c) => (c.kind || "approval") === kind);
      const want = kind === "clarify" ? String(j.question?.question || "") : String(j.approval?.command || "");
      const pick = mine.find((c) => want && String((kind === "clarify" ? c.question : c.command) || "") === want) || mine[0];
      if (pick) {
        if (typeof pick.prompt_id === "string" && pick.prompt_id) out.promptId = pick.prompt_id;
        const pg = Number(pick.execution_generation);
        if (Number.isFinite(pg) && pg > 0) {
          out.generation = pg;
          j.executionGeneration = pg;
        }
      }
    } catch {
      /* the control call will report what is wrong with it */
    }
    return out;
  }

  // Post an approval answer Jobs has already validated (offered choice, window still open).
  async approve(j, pick, requestId) {
    const jobs = this.jobs;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      let ctx = await this.controlContext(j);
      let rid = requestId || j.approval?.requestId || ctx.promptId;
      let gen = ctx.generation;
      if (rid && !j.approval?.requestId) j.approval.requestId = rid;
      const body = { choice: pick };
      if (rid) body.request_id = String(rid);
      if (gen) body.execution_generation = gen;
      const res = await fetch(`${this.api.url}/v1/runs/${j.runId}/approval`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = out?.error?.code || out?.code || null;
        // The gateway does not hold this request any more: its window closed, another surface answered it, or a
        // stop withdrew it. That is a verdict, not a retryable failure — the box goes and the reader is told, or
        // they are left clicking a prompt that can never be answered (measured: four clicks at 12:08:46, 12:08:49,
        // 12:08:56 and 12:09:36, every one answered "Run has no pending approval").
        if (code === "approval_not_pending" || code === "approval_not_active") return jobs.approvalGone(j, code);
        // `invalid_params` (a body the authority will not read without a generation) or `stale_generation` (the
        // run moved on since the value we had): ask the run for its current generation and retry once. A card
        // left open across a generation change heals itself instead of showing a code.
        if (code === "invalid_params" || code === "stale_generation") {
          j.executionGeneration = 0;
          ctx = await this.controlContext(j);
          const later = ctx.generation;
          const laterRid = ctx.promptId || rid;
          const moved = (later && later !== gen) || (laterRid && laterRid !== rid);
          if (moved) {
            if (later) body.execution_generation = later;
            if (laterRid) {
              body.request_id = String(laterRid);
              if (j.approval) j.approval.requestId = laterRid;
            }
            const retry = await fetch(`${this.api.url}/v1/runs/${j.runId}/approval`, {
              method: "POST",
              headers: this.headers(),
              body: JSON.stringify(body),
            });
            const out2 = await retry.json().catch(() => ({}));
            if (retry.ok) {
              jobs.push(j, { kind: "dim", text: `⇢ approval answered from the panel: ${pick}` });
              j.approvalDone = { choice: pick, command: j.approval?.command || "", at: new Date().toISOString() };
              j.approval = null;
              jobs.emit(j);
              return { ok: true, choice: pick, resolved: out2.resolved ?? null };
            }
            // The row is gone as well as the generation: same verdict, same handling.
            const late = out2?.error?.code || out2?.code || null;
            if (late === "approval_not_pending" || late === "approval_not_active") return jobs.approvalGone(j, late);
            return { ok: false, error: out2?.error?.message || out2?.message || `HTTP ${retry.status}`, code: late };
          }
        }
        return { ok: false, error: out?.error?.message || out?.message || `HTTP ${res.status}`, code };
      }
      jobs.push(j, { kind: "dim", text: `⇢ approval answered from the panel: ${pick}` });
      // Optimistic: the stream's approval.responded confirms it a moment later.
      j.approvalDone = { choice: pick, command: j.approval?.command || "", at: new Date().toISOString() };
      j.approval = null;
      jobs.emit(j);
      return { ok: true, choice: pick, resolved: out.resolved ?? null };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // Post a clarify answer Jobs has already encoded. The gateway's body is exactly
  // {request_id, execution_generation, answer} on `/v1/runs/{id}/clarify`. Same fence and same self-heal as an
  // approval: a card left open across a generation change re-reads and retries once.
  async clarify(j, text, shown, requestId) {
    const jobs = this.jobs;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      let ctx = await this.controlContext(j, "clarify");
      let rid = requestId || j.question?.requestId || ctx.promptId;
      let gen = ctx.generation;
      if (rid && j.question && !j.question.requestId) j.question.requestId = rid;
      const body = { answer: text };
      if (rid) body.request_id = String(rid);
      if (gen) body.execution_generation = gen;
      const post = () =>
        fetch(`${this.api.url}/v1/runs/${j.runId}/clarify`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      const res = await post();
      clearTimeout(t);
      let out = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = out?.error?.code || out?.code || null;
        if (code === "invalid_params" || code === "stale_generation") {
          j.executionGeneration = 0;
          ctx = await this.controlContext(j, "clarify");
          const later = ctx.generation;
          const laterRid = ctx.promptId || rid;
          const moved = (later && later !== gen) || (laterRid && laterRid !== rid);
          if (moved) {
            if (later) body.execution_generation = later;
            if (laterRid) {
              body.request_id = String(laterRid);
              if (j.question) j.question.requestId = laterRid;
            }
            const retry = await post();
            out = await retry.json().catch(() => ({}));
            if (!retry.ok) {
              return { ok: false, error: out?.error?.message || out?.message || `HTTP ${retry.status}`, code: out?.error?.code || out?.code || null };
            }
            return jobs.noteAnswered(j, shown);
          }
        }
        return { ok: false, error: out?.error?.message || out?.message || `HTTP ${res.status}`, code };
      }
      return jobs.noteAnswered(j, shown);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  async stop(j) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      await fetch(`${this.api.url}/v1/runs/${j.runId}/stop`, { method: "POST", headers: this.headers(), signal: ctrl.signal });
      clearTimeout(t);
      this.jobs.push(j, { kind: "raw", text: "stop requested — the turn ends at its next safe point" });
      return true;
    } catch {
      return false;
    }
  }
}
