// Hermes HTTP Runs API transport for agent supervision.
//
// Implements the Transport interface for the Hermes gateway's Runs API.
// Extracted from lib/jobs.js to support multiple agent backends (Claude CLI, etc).

import { Transport } from "./transport.js";
import path from "node:path";

const TERMINAL_RUN = new Set(["completed", "failed", "cancelled", "interrupted"]);

export class HermesTransport extends Transport {
  constructor(opts = {}) {
    super(opts);
    this.jobs = opts.jobs; // reference back to Jobs instance for calling consume, emit, push, etc
    this.apiUrl = opts.apiUrl || "http://127.0.0.1:8642";
    this.apiKey = opts.apiKey || null;
  }

  headers(extra = {}) {
    const h = { "Content-Type": "application/json", ...extra };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  // Probe gateway reachability and capabilities
  async probe({ fresh = false } = {}) {
    const now = Date.now();
    const transport = {
      url: this.apiUrl,
      reachable: null,
      checkedAt: 0,
      keyed: Boolean(this.apiKey),
      capabilities: null,
      error: null,
    };

    if (!fresh && this._lastProbe && now - this._lastProbe.checkedAt < 15_000) {
      return this._lastProbe;
    }

    if (!this.apiKey) {
      transport.reachable = false;
      transport.checkedAt = now;
      transport.keyed = false;
      transport.error = "no API_SERVER_KEY";
      this._lastProbe = transport;
      return transport;
    }

    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(`${this.apiUrl}/v1/capabilities`, {
        headers: this.headers(),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const caps = await res.json();
      const features = caps.features || {};
      transport.reachable = true;
      transport.checkedAt = now;
      transport.keyed = true;
      transport.error = null;
      transport.capabilities = {
        runs: Boolean(features.run_submission),
        events: Boolean(features.run_events_sse),
        steer: Boolean(features.run_steer),
        stop: Boolean(features.run_stop),
        approval: Boolean(features.run_approval_response),
        runCwd: Boolean(features.run_cwd),
        runBudget: Boolean(features.run_budget),
        maxTurns: Boolean(features.max_turns),
        version: caps.version || null,
      };
    } catch (e) {
      transport.reachable = false;
      transport.checkedAt = now;
      transport.keyed = true;
      transport.error = String((e && e.message) || e);
    }

    this._lastProbe = transport;
    return transport;
  }

  // Spawn a new run on the gateway
  async createRun(j, opts = {}) {
    // j is the job object from Jobs.create(), already initialized
    // opts includes prompt, cwd, thread, model, maxTurns, budget
    const cwd = opts.cwd;
    const prompt = opts.prompt;
    const thread = opts.thread;

    const body = { input: prompt, session_id: thread, cwd };
    if (opts.model) body.model = String(opts.model);
    if (opts.maxTurns) body.max_turns = Number(opts.maxTurns);
    if (opts.budget) body.run_budget = Number(opts.budget);

    this.onLog(`run ${j.id}: session ${thread} cwd ${cwd}`);

    let res;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20_000);
      res = await fetch(`${this.apiUrl}/v1/runs`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(t);
    } catch (e) {
      const why = e?.name === "AbortError"
        ? "the gateway did not answer within 20s"
        : String((e && e.message) || e);
      j.status = "failed";
      j.error = `cannot reach the Hermes gateway at ${this.apiUrl}: ${why}`;
      j.endedAt = new Date().toISOString();
      this.jobs.push(j, { kind: "raw", text: j.error });
      this.jobs.emit(j);
      throw new Error(j.error);
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
      j.error = `gateway refused the run (HTTP ${res.status})${detail ? `: ${String(detail).slice(0, 300)}` : ""}`;
      j.endedAt = new Date().toISOString();
      this.jobs.push(j, { kind: "raw", text: j.error });
      this.jobs.emit(j);
      throw new Error(j.error);
    }

    const accepted = await res.json().catch(() => ({}));
    j.runId = accepted.run_id || null;
    if (!j.runId) {
      j.status = "failed";
      j.error = "gateway accepted the request but returned no run_id";
      j.endedAt = new Date().toISOString();
      this.jobs.emit(j);
      throw new Error(j.error);
    }

    j.status = "running";
    this.jobs.push(j, { kind: "init", text: `run ${j.runId} · session ${thread} · cwd ${cwd}` });
    j.baseOutput = this.jobs.sessionOutput(j.thread);
    j.statsTimer = setInterval(() => this.jobs.refreshStats(j), 4_000);
    this.jobs.refreshStats(j);
    this.jobs.emit(j);

    // Set up timer for run timeout
    j.timer = setTimeout(() => {
      if (j.status === "running") {
        j.error = `killed: exceeded ${this.jobs.maxRuntimeSeconds}s panel cap`;
        void this.stop(j);
      }
    }, (this.jobs.maxRuntimeSeconds || 3600) * 1000);

    // Set up poller as backstop
    j.poller = setInterval(() => void this.poll(j), 15_000);

    // Start following the event stream
    void this.follow(j);

    return j;
  }

  // Subscribe to the run's event stream
  async follow(j) {
    if (!j.runId) return;
    const ctrl = new AbortController();
    j.ctrl = ctrl;
    try {
      const res = await fetch(`${this.apiUrl}/v1/runs/${j.runId}/events`, {
        headers: {
          Accept: "text/event-stream",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
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
        // SSE frames are separated by blank line
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
      if (!ctrl.signal.aborted) {
        this.onLog(`run ${j.id}: event stream ended (${String((e && e.message) || e)})`);
      }
    }
    await this.poll(j);
  }

  // Check run status
  async poll(j) {
    if (!j.runId || (j.status !== "running" && j.status !== "starting")) return;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(`${this.apiUrl}/v1/runs/${j.runId}`, {
        headers: this.headers(),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!res.ok) return;
      const run = await res.json();
      // Keep execution generation for control calls
      if (Number.isFinite(Number(run.execution_generation)) && Number(run.execution_generation) > 0) {
        j.executionGeneration = Number(run.execution_generation);
      }
      if (TERMINAL_RUN.has(run.status)) {
        this.jobs.scanTurnUrls(j);
        // Format the result line
        const tk = run?.usage || {};
        const bits = [
          `run ${run.status}`,
          tk.total_tokens ? `tokens ${tk.total_tokens} (in ${tk.input_tokens ?? "?"} / out ${tk.output_tokens ?? "?"})` : null,
          run?.pending_steer ? `pending steer: ${String(run.pending_steer).slice(0, 120)}` : null,
        ].filter(Boolean);
        this.jobs.push(j, { kind: "result", text: bits.join(" · ") });
        this.jobs.settle(j, run.status, run);
      }
    } catch {
      /* next poll tries again */
    }
  }

  // Send steering message
  async steer(j, text) {
    const clean = String(text ?? "").trim();
    if (!clean) return { ok: false, error: "steer text is required" };
    if (j.status !== "running" || !j.runId) {
      return { ok: false, error: `run is not running (${j.status})` };
    }
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      const res = await fetch(`${this.apiUrl}/v1/runs/${j.runId}/steer`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ input: clean }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          ok: false,
          error: body?.error?.message || body?.message || `HTTP ${res.status}`,
          code: body?.error?.code || body?.code || null,
        };
      }
      this.jobs.push(j, { kind: "dim", text: `⇢ steer sent: ${clean.slice(0, 200)}` });
      return { ok: true, accepted: Boolean(body.accepted), runId: j.runId };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // Get control context (prompt ID, generation) for approval/clarify
  async controlContext(j, kind = "approval") {
    const out = { promptId: null, generation: Number(j?.executionGeneration) || 0 };
    if (!j?.runId) return out;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(`${this.apiUrl}/v1/runs/${j.runId}`, {
        headers: this.headers(),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return out;
      const run = await res.json();
      const gen = Number(run.execution_generation);
      if (Number.isFinite(gen) && gen > 0) {
        out.generation = gen;
        j.executionGeneration = gen;
      }
      const pending = Array.isArray(run.pending_controls) ? run.pending_controls : [];
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
      /* control call will report what is wrong */
    }
    return out;
  }

  // Answer an approval
  async approve(j, choice, requestId) {
    const pick = String(choice || "").trim().toLowerCase();
    const offered = j.approval?.choices || [];
    if (!offered.includes(pick)) {
      return { ok: false, error: `choice must be one of: ${offered.join(", ") || "once, deny"}` };
    }
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
      const res = await fetch(`${this.apiUrl}/v1/runs/${j.runId}/approval`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        const code = out?.error?.code || out?.code || null;
        // Retry once on generation changes
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
            const retry = await fetch(`${this.apiUrl}/v1/runs/${j.runId}/approval`, {
              method: "POST",
              headers: this.headers(),
              body: JSON.stringify(body),
            });
            const out2 = await retry.json().catch(() => ({}));
            if (retry.ok) {
              this.jobs.push(j, { kind: "dim", text: `⇢ approval answered from the panel: ${pick}` });
              j.approvalDone = { choice: pick, command: j.approval?.command || "", at: new Date().toISOString() };
              j.approval = null;
              this.jobs.emit(j);
              return { ok: true, choice: pick, resolved: out2.resolved ?? null };
            }
            return {
              ok: false,
              error: out2?.error?.message || out2?.message || `HTTP ${retry.status}`,
              code: out2?.error?.code || out2?.code || null,
            };
          }
        }
        return { ok: false, error: out?.error?.message || out?.message || `HTTP ${res.status}`, code };
      }
      this.jobs.push(j, { kind: "dim", text: `⇢ approval answered from the panel: ${pick}` });
      j.approvalDone = { choice: pick, command: j.approval?.command || "", at: new Date().toISOString() };
      j.approval = null;
      this.jobs.emit(j);
      return { ok: true, choice: pick, resolved: out.resolved ?? null };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // Answer a clarify question
  async clarify(j, answer, requestId) {
    const multi = Array.isArray(answer);
    const text = (multi ? JSON.stringify(answer.map((a) => String(a))) : String(answer ?? "")).trim();
    if (!text) return { ok: false, error: "an answer is required" };
    if (text.length > 16384) {
      return { ok: false, error: "that answer is longer than the gateway accepts (16384 characters)" };
    }
    const shown = multi ? JSON.parse(text).join(" · ") : text;
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
        fetch(`${this.apiUrl}/v1/runs/${j.runId}/clarify`, {
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
              return {
                ok: false,
                error: out?.error?.message || out?.message || `HTTP ${retry.status}`,
                code: out?.error?.code || out?.code || null,
              };
            }
            return this.noteAnswered(j, shown);
          }
        }
        return { ok: false, error: out?.error?.message || out?.message || `HTTP ${res.status}`, code };
      }
      return this.noteAnswered(j, shown);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  noteAnswered(j, shown) {
    this.jobs.push(j, { kind: "dim", text: `⇢ answered the agent's question: ${String(shown).slice(0, 240)}` });
    j.questionDone = { answer: String(shown), at: new Date().toISOString() };
    j.question = null;
    this.jobs.emit(j);
    return { ok: true, runId: j.runId, answer: shown };
  }

  // Interrupt the run
  async stop(j) {
    if (!j.runId || j.status !== "running") return false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      await fetch(`${this.apiUrl}/v1/runs/${j.runId}/stop`, {
        method: "POST",
        headers: this.headers(),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      this.jobs.push(j, { kind: "raw", text: "stop requested — the turn ends at its next safe point" });
      return true;
    } catch {
      return false;
    }
  }
}
