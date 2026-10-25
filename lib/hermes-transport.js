// Hermes HTTP Runs API transport.
//
// Everything in this file talks to the Hermes gateway over HTTP: probing it, posting a run, holding its SSE
// stream, polling its status, and the control calls (steer, approval, clarify, stop). The job state machine
// stays in Jobs; this class only moves bytes and feeds what comes back through `jobs.consume()` / `jobs.settle()`.
// Moved here from lib/jobs.js with no behaviour change (2b), so the bodies read exactly as they did there.

import path from "node:path";
import { Transport } from "./transport.js";
import { runRefusal, runResultLine } from "./jobs.js";

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
        },
      };
    } catch (e) {
      this.state = { ...this.state, reachable: false, checkedAt: now, keyed: true, error: String((e && e.message) || e) };
    }
    return this.state;
  }

  // Post the run for a job Jobs has already set up (record, tree, base commit), then start watching it.
  // Returns the job's summary, failed or running.
  async create(j, { prompt, opts = {}, thread, cwd }) {
    const jobs = this.jobs;
    // The Runs API has no working-directory field on this gateway: `cwd` rides in the body for one that
    // honours it, but the agent is in fact started in the gateway's own directory, and its system prompt says
    // so ("Current working directory: <gateway cwd>"). Measured: a run asked for
    // C:/ProjectDevelopment/email-multi/.kilo/worktrees/que-monitor-k8s answered `pwd` with /c/Users/roper.
    // So the directory travels in the prompt as well - the one channel the run definitely reads - and the
    // agent is told to cd once and to use absolute paths.
    const where = typeof cwd === "string" && path.isAbsolute(cwd) ? cwd.split("\\").join("/").replace(/\/+$/, "") : null;
    // `anchorCwd: false` is for a turn that is not meant to work in a directory at all (the panel's own
    // assistant reads the board, it never runs a command there), so the sentence would be a lie in its prompt.
    const anchored = where && opts.anchorCwd !== false
      ? `${prompt}\n\nWork in ${where} — run \`cd "${where}"\` before your first terminal command, and use absolute paths under it for file tools; the agent host may have started you in a different directory.`
      : prompt;
    // Context the panel supplies on the turn's behalf rides in the input, ahead of the prompt: the card must
    // show what the reader (or the sentry) said, not a copy of the scratchpad.
    const pre = opts.preamble ? `${String(opts.preamble).trim()}\n\n---\n\n` : "";
    const body = { input: pre + anchored, session_id: thread, cwd };
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
        text: `⇢ asked to work in ${where} — this gateway's Runs API has no cwd field, so the prompt tells the agent to cd there`,
      });
    }
    if (pre) jobs.push(j, { kind: "dim", text: "⇢ assistant context attached — scratchpad, watches and the board digest ride with this turn" });
    jobs.onLog(`run ${j.id}: session ${thread} cwd ${cwd}`);

    let res;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20_000);
      res = await fetch(`${this.api.url}/v1/runs`, { method: "POST", headers: this.headers(), body: JSON.stringify(body), signal: ctrl.signal });
      clearTimeout(t);
    } catch (e) {
      const why = e?.name === "AbortError" ? "the gateway did not answer within 20s" : String((e && e.message) || e);
      j.status = "failed";
      j.error = `cannot reach the Hermes gateway at ${this.api.url}: ${why}`;
      j.endedAt = new Date().toISOString();
      jobs.push(j, { kind: "raw", text: j.error });
      jobs.finalise(j);
      jobs.emit(j);
      return jobs.summary(j);
    }

    if (!res.ok) {
      let detail = "";
      try {
        const err = await res.json();
        detail = err?.error?.message || err?.message || JSON.stringify(err).slice(0, 300);
      } catch {
        detail = await res.text().catch(() => "");
      }
      j.status = "failed";
      // 409 + permission_denied is the gateway's surface rule, not a fault: session_api_turn.py refuses an API
      // turn in any session whose source is not api_server/bot_room, and a revived session came from the CLI.
      // Say what to do about it instead of repeating the code.
      j.error = runRefusal(res.status, detail, { thread, revived: Boolean(j.revived) }) ||
        `gateway refused the run (HTTP ${res.status})${detail ? `: ${String(detail).slice(0, 300)}` : ""}`;
      j.endedAt = new Date().toISOString();
      jobs.push(j, { kind: "raw", text: j.error });
      jobs.finalise(j);
      jobs.emit(j);
      return jobs.summary(j);
    }

    const accepted = await res.json().catch(() => ({}));
    j.runId = accepted.run_id || null;
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

    void this.follow(j);
    return jobs.summary(j);
  }

  // Subscribe to the run's event stream. A dropped stream is not a lost run: `poll` keeps asking the
  // status endpoint until the run reaches a terminal state.
  async follow(j) {
    const ctrl = new AbortController();
    j.ctrl = ctrl;
    // Whether this panel currently holds the run's event stream. A gateway restart drops it, and the
    // sweep in `sweepOrphanedRuns` reads this before deciding a run is alive or lost.
    j.streamOpen = true;
    try {
      const res = await fetch(`${this.api.url}/v1/runs/${j.runId}/events`, {
        headers: { Accept: "text/event-stream", ...(this.api.key ? { Authorization: `Bearer ${this.api.key}` } : {}) },
        signal: ctrl.signal,
      });
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
          const data = frame
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("");
          if (!data) continue;
          let evt;
          try {
            evt = JSON.parse(data);
          } catch {
            continue;
          }
          this.jobs.consume(j, evt);
        }
      }
    } catch (e) {
      if (!ctrl.signal.aborted) this.jobs.onLog(`run ${j.id}: event stream ended (${String((e && e.message) || e)})`);
    }
    j.streamOpen = false;
    await this.poll(j);
  }

  // Ask the status endpoint for the truth and settle on it. Covers a stream that never opened and a
  // terminal event that was missed, so a card cannot stay "running" forever.
  async poll(j) {
    if (!j.runId || (j.status !== "running" && j.status !== "starting")) return;
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
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      const res = await fetch(`${this.api.url}/v1/runs/${j.runId}/steer`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ input: clean }),
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
