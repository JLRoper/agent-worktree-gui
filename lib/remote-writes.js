// Who is allowed to put a branch on a REMOTE, and the permission box that grants it.
//
// The reader's rule: a worktree the panel cuts exists locally unless the work is going to land. Most of what this
// panel starts is research or a browser probe, and a remote branch per probe clutters a repository other people
// share. So local-only is the DEFAULT, and the exception is a grant the reader gives on purpose — never a default
// anybody has to remember to turn off.
//
// This module is the policy half: it holds the setting's three values, the grants the reader's answers produce,
// and the pending questions themselves. It owns no git and no UI: the panel's own remote-writing paths
// (the merge flow, POST /api/worktree/merge) and the installed pre-push hook both ask it, and the page draws
// whatever it reports. Anything it cannot hear back about inside its window is DENIED — the same fail-closed
// rule the approval transport uses, because a permission that is assumed is not a permission.
const CHOICES = new Set(["once", "session", "always", "deny"]);

// What the setting governs is whether a branch may exist on a remote at all, so the names say exactly that:
//
//   local-only (default) every branch stays local. A remote write is REFUSED unless the reader grants it through
//                        the permission box — the box can be requested by the panel's own merge flow or by the
//                        installed pre-push guard, and once granted the write goes through.
//   allow                the reader has granted it standing: remote writes go through without asking. This is what
//                        "Always allow" in the box writes, so the box and the setting are the same fact.
//   deny                 never, and do not even ask: the guard refuses without offering a choice. For a repository
//                        nobody should push to from this box (a mirror, somebody else's checkout).
export const POLICIES = ["local-only", "allow", "deny"];
export const DEFAULT_POLICY = "local-only";

export function policyFrom(value, fallback = DEFAULT_POLICY) {
  const v = String(value ?? "").trim().toLowerCase();
  if (POLICIES.includes(v)) return v;
  // A value that cannot be read must never silently open the door: an unknown string falls back to the DEFAULT,
  // which is the closed one.
  return POLICIES.includes(String(fallback || "").toLowerCase()) ? String(fallback).toLowerCase() : DEFAULT_POLICY;
}

export function policyLabel(policy) {
  const p = policyFrom(policy);
  if (p === "allow") return "remote writes allowed";
  if (p === "deny") return "refused outright";
  return "local only unless you allow it";
}

const normKey = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// Keyed on the worktree, because that is what the reader answers about: "this tree may push" is a decision about
// one piece of work, not about the repository or the box.
export class RemoteWrites {
  // `onEvent` carries what the page draws ({ type: "remote-write", request } / { type: "remote-write-answered", ... });
  // `getPolicy` is read at every decision so a settings change takes effect on the next write, with no restart.
  // `onPolicy`/`onGrant` are how a grant the reader gives here reaches the two places that hold a copy of the
  // answer: the panel's config.json ("Always allow" IS the setting) and the installed guard's own state file.
  constructor({ getPolicy = () => DEFAULT_POLICY, onEvent = () => {}, onLog = () => {}, timeoutSeconds = 300, onPolicy = null, onGrant = null } = {}) {
    this.getPolicy = getPolicy;
    this.onEvent = onEvent;
    this.log = onLog;
    this.onPolicy = onPolicy;
    this.onGrant = onGrant;
    this.timeoutSeconds = Number(timeoutSeconds) > 0 ? Number(timeoutSeconds) : 300;
    this.pending = new Map(); // id -> request
    this.decisions = new Map(); // id -> { choice, at, by }
    // A grant that lasts the panel's own lifetime, per worktree. "Allow for this session" is exactly this and
    // nothing more: it is in memory, so a restart asks again.
    this.session = new Set(); // normKey(worktree)
    this.once = new Map(); // normKey(worktree) -> at (a grant that one write consumes)
    this.landing = new Set(); // normKey(worktree) of trees started to LAND — they push by design
    this.timer = setInterval(() => this.sweep(), 5000);
    if (this.timer.unref) this.timer.unref();
  }

  policy() {
    return policyFrom(this.getPolicy());
  }

  // Why a write from this worktree is or is not allowed right now, in one word plus the reason, so both the guard
  // and the panel's own paths can act on the same answer instead of each deciding for itself.
  decision(worktree) {
    const policy = this.policy();
    const key = normKey(worktree);
    if (policy === "allow") return { allowed: true, why: "the setting allows remote writes" };
    if (policy === "deny") return { allowed: false, why: "the setting refuses remote writes outright", ask: false };
    if (key && this.landing.has(key)) return { allowed: true, why: "this tree was started to land", ask: false };
    if (key && this.session.has(key)) return { allowed: true, why: "allowed for this session", ask: false };
    if (key && this.once.has(key)) return { allowed: true, why: "allowed once", ask: false, consume: true };
    return { allowed: false, why: "this tree is local only", ask: true };
  }

  // The hook and the merge flow both call this. Returning `consume: true` means the caller is taking the one-shot
  // grant: it must call `spend()` when it actually pushes, or a refused push would eat the reader's answer.
  spend(worktree) {
    const key = normKey(worktree);
    if (key) this.once.delete(key);
  }

  // Which tree a settled request was about — the guard polls after the request has left `pending`, and the
  // one-shot grant it was given has to be spent against that tree.
  treeOfDecision(id) {
    return this.decisions.get(String(id))?.worktree || "";
  }

  markLanding(worktree) {
    const key = normKey(worktree);
    if (!key) return;
    this.landing.add(key);
    this.onEvent({ type: "remote-write-state", state: this.state() });
  }

  unmarkLanding(worktree) {
    const key = normKey(worktree);
    if (!key) return;
    if (this.landing.delete(key)) this.onEvent({ type: "remote-write-state", state: this.state() });
  }

  // A question, parked until the reader answers or the window closes. `kind` says WHAT would be written
  // ("push" from the guard, "merge" from the panel's own flow), and `resume` is what the panel does when the
  // answer is a yes — kept in the process, never in the store: a permission request that outlives the process
  // cannot be answered, and pretending otherwise would leave a button that does nothing.
  request(input = {}) {
    const worktree = String(input.worktree || "");
    const id = String(input.id || "").trim() || `rw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const timeoutSeconds = Number(input.timeoutSeconds) > 0 ? Math.min(3600, Number(input.timeoutSeconds)) : this.timeoutSeconds;
    const allowed = (Array.isArray(input.allowed) && input.allowed.length ? input.allowed : ["once", "session", "always", "deny"])
      .map((c) => String(c).toLowerCase())
      .filter((c) => CHOICES.has(c));
    const request = {
      id,
      kind: String(input.kind || "push"),
      worktree,
      project: String(input.project || ""),
      branch: String(input.branch || ""),
      remote: String(input.remote || ""),
      refs: String(input.refs || "").slice(0, 600),
      title: String(input.title || ""),
      command: String(input.command || ""),
      description: String(input.description || ""),
      allowed: allowed.length ? allowed : ["once", "deny"],
      timeoutSeconds,
      at: new Date().toISOString(),
      // The page draws the same deadline + countdown the in-card approval box does; the guard gives up 5 s
      // earlier so its refusal is its own message rather than a race with the panel's sweep.
      deadline: Date.now() + Math.max(1, timeoutSeconds - 5) * 1000,
      resume: typeof input.resume === "function" ? input.resume : null,
    };
    this.pending.set(id, request);
    this.decisions.delete(id);
    this.onEvent({ type: "remote-write", request: this.publicRequest(request) });
    this.log(`remote-write ${id}: ${request.kind} from ${worktree || "(no tree)"} on ${request.branch || "?"} — waiting on the reader`);
    return request;
  }

  // What the guard polls. A request nobody answered reads as "deny" once its window has gone: the write must not
  // sit parked forever waiting for a click that is never coming.
  status(id) {
    const key = String(id);
    const req = this.pending.get(key);
    if (req) return { status: "pending", choice: null, deadline: req.deadline, timeoutSeconds: req.timeoutSeconds };
    const d = this.decisions.get(key);
    if (d) return { status: "answered", choice: d.choice, at: new Date(d.at).toISOString(), why: d.why || "" };
    return { status: "unknown", choice: null };
  }

  // The reader's answer. `allow` is applied HERE, so the two surfaces that ask (the hook and the panel's own merge
  // flow) cannot disagree about what was granted.
  answer(id, choice, { by = "reader" } = {}) {
    const key = String(id);
    const req = this.pending.get(key);
    if (!req) {
      const d = this.decisions.get(key);
      return { ok: false, error: d ? "that request was already answered" : "unknown or already-resolved request", settled: Boolean(d) };
    }
    const clean = String(choice || "").toLowerCase();
    if (!req.allowed.includes(clean)) return { ok: false, error: `${clean || "(none)"} is not one of the choices offered: ${req.allowed.join(", ")}` };
    const tree = normKey(req.worktree);
    let why = "denied by the reader";
    if (clean === "once") {
      if (tree) this.once.set(tree, Date.now());
      why = "allowed once";
    } else if (clean === "session") {
      if (tree) this.session.add(tree);
      why = "allowed for this session";
    } else if (clean === "always") {
      // "Always allow" is the SETTING, not a private list: the reader asked for remote writes to be permitted from
      // now on, and a fact that only lives in this process would be one they have to give again after a restart.
      why = "always allowed — the setting now permits remote writes";
      const out = this.onPolicy ? this.onPolicy("allow", { by, request: req }) : null;
      if (out && out.error) return { ok: false, error: out.error };
    }
    this.pending.delete(key);
    // `worktree` travels with the decision: the guard polls the status route AFTER the request has left `pending`,
    // and the one-shot grant it was just given has to be spent against the right tree.
    this.decisions.set(key, { choice: clean, at: Date.now(), by, why, worktree: req.worktree || "" });
    if (this.decisions.size > 60) {
      const cut = Date.now() - 10 * 60_000;
      for (const [k, d] of this.decisions) if (d.at < cut) this.decisions.delete(k);
    }
    // The installed guard keeps its own copy of the answer (its state file), so a tree the reader just allowed
    // does not have to reach the panel to find that out.
    if (this.onGrant) {
      try {
        this.onGrant({ request: req, choice: clean });
      } catch (e) {
        this.log(`remote-write ${key}: could not write the guard's copy of the grant (${String((e && e.message) || e)})`);
      }
    }
    this.onEvent({ type: "remote-write-answered", id: key, choice: clean, why, kind: req.kind, worktree: req.worktree });
    this.log(`remote-write ${key}: ${clean} (${why})`);
    return { ok: true, choice: clean, why, request: this.publicRequest(req) };
  }

  // Nothing answered by the deadline is a denial. The guard is told, the box is taken off the page, and the record
  // says the reader never decided — the same shape the approval transport uses.
  sweep() {
    const now = Date.now();
    for (const [id, req] of this.pending) {
      if (now < req.deadline) continue;
      this.pending.delete(id);
      this.decisions.set(id, { choice: "deny", at: now, by: "timeout", why: "no answer inside the window" });
      this.onEvent({ type: "remote-write-answered", id, choice: "deny", expired: true, why: "no answer inside the window", kind: req.kind, worktree: req.worktree });
      this.log(`remote-write ${id}: nobody answered inside ${req.timeoutSeconds}s — denied`);
    }
  }

  // What the guard writes into `<hooks>/state.json` and what GET /api/remote-write/state answers: the same facts,
  // so a hook and the page can never disagree about which trees are allowed to write.
  state() {
    return {
      policy: this.policy(),
      label: policyLabel(this.policy()),
      timeoutSeconds: this.timeoutSeconds,
      session: [...this.session],
      once: [...this.once.keys()],
      landing: [...this.landing],
      pending: [...this.pending.values()].map((r) => this.publicRequest(r)),
    };
  }

  publicRequest(req) {
    return {
      id: req.id,
      kind: req.kind,
      worktree: req.worktree,
      project: req.project,
      branch: req.branch,
      remote: req.remote,
      refs: req.refs,
      title: req.title,
      command: req.command,
      description: req.description,
      allowed: req.allowed,
      at: req.at,
      deadline: req.deadline,
      timeoutSeconds: req.timeoutSeconds,
    };
  }

  list() {
    return [...this.pending.values()].map((r) => this.publicRequest(r));
  }

  // A pending merge is resumed by the answer, so the panel needs the request itself (its `resume`) and not the
  // public copy. Kept here rather than handed around the server, so a resumed action cannot be run twice.
  takeResume(id) {
    const req = this.pending.get(String(id)) || null;
    return req ? req.resume : null;
  }

  stop() {
    clearInterval(this.timer);
  }
}
