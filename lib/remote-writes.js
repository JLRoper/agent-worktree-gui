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
// The four answers the permission box offers, in the order the page draws them. Exported because the
// Permissions tab reports them and must move with this list rather than carry a copy of it.
import { resolvePushPermissions } from "./push-permissions.js";

export const GRANT_CHOICES = ["once", "session", "always", "deny"];
const CHOICES = new Set(GRANT_CHOICES);


// A parked request waits this long, and no longer than the cap: the guard polls for the answer, and a
// permission nobody answered must expire rather than hold a write open. The Permissions tab reports
// both numbers from here.
export const DEFAULT_GRANT_TIMEOUT_SECONDS = 300;
export const MAX_GRANT_TIMEOUT_SECONDS = 3600;

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

// A write that the SETTING allows goes through without a question — and, until this, without a record. The reader
// asked to see those too: a permission nobody is shown is indistinguishable from one nobody needed. So an
// auto-allowed write comes back as a REVIEW card once the panel can prove it landed (git ls-remote), with Keep and
// one named Unwind. The review is only ever a receipt plus the exact inverse the PANEL would run; nothing in it is
// executed on arrival.
const REVIEW_TTL_MS = 10 * 60_000;
// A branch with no slash is somebody's main line by convention, and the base branch of a landing merge is not a
// branch to offer to delete over the wire. Only a feature-shaped branch gets the delete inverse.
const PROTECTED_BRANCHES = new Set(["main", "master", "trunk", "develop", "development", "release", "head", "next"]);

export function policyFrom(value, fallback = DEFAULT_POLICY) {
  const v = String(value ?? "").trim().toLowerCase();
  if (POLICIES.includes(v)) return v;
  // A value that cannot be read must never silently open the door: an unknown string falls back to the DEFAULT,
  // which is the closed one.
  return POLICIES.includes(String(fallback || "").toLowerCase()) ? String(fallback).toLowerCase() : DEFAULT_POLICY;
}

// The policy in force for ONE project: its own `remoteBranchPolicy` (config.json's `projects[]`) overrides the
// global, and an unreadable value falls back to the global rather than inventing one. This exists because the
// global is not the last word about every repository: this panel and heroes-js land by pushing a branch and opening
// a PR, so a blanket local-only would break their own landing path, while every other checkout here is local work.
export function policyForProject(project, globalPolicy = DEFAULT_POLICY) {
  const own = String(project?.remoteBranchPolicy ?? "").trim().toLowerCase();
  if (POLICIES.includes(own)) return own;
  return policyFrom(globalPolicy);
}

// ---- may this remote be pushed WITHOUT ASKING first? -------------------------------------------------------------
// The question the two four-way controls answer (lib/push-permissions.js) is per PROJECT and per branch KIND, not
// a boolean: `allow-name-gate` allows a turnover branch and asks about anything else. This boolean is the one they
// cannot express, and it survives only because lib/jobs.js (a file this landing does not touch) reads a boolean to
// decide whether its brief paragraph says ASK or ALLOWED-WITHOUT-ASKING. It means exactly "both kinds go through
// with no gate at all"; a name-gate project reads false here and the guard still allows the branch it should —
// the brief's paragraph leans towards asking, which is the safe side of that imprecision.
export const DEFAULT_ALLOW_PUSH_WITHOUT_ASKING = false;

export function allowPushWithoutAskingFor(project, gate = {}) {
  const resolved = resolvePushPermissions(project, gate);
  const denied = resolved.newBranches === "never" || resolved.existingBranches === "never";
  const enabled = !denied && resolved.newBranches === "allow-all" && resolved.existingBranches === "allow-all";
  const source = resolved.forced ? "repo" : resolved.newSource;
  return { enabled, stated: enabled, source, policy: policyForProject(project, gate?.remoteBranchPolicy), denied, resolved };
}

// The switch buys "do not ask me", never "push on your own": it answers the permission question only, so it is not
// narrowed by branch shape here — the branch policy and the LANDING paragraph still decide whether a push happens.

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
  constructor({ getPolicy = () => DEFAULT_POLICY, onEvent = () => {}, onLog = () => {}, timeoutSeconds = DEFAULT_GRANT_TIMEOUT_SECONDS, onPolicy = null, onGrant = null } = {}) {
    this.getPolicy = getPolicy;
    this.onEvent = onEvent;
    this.log = onLog;
    this.onPolicy = onPolicy;
    this.onGrant = onGrant;
    this.timeoutSeconds = Number(timeoutSeconds) > 0 ? Math.min(MAX_GRANT_TIMEOUT_SECONDS, Number(timeoutSeconds)) : DEFAULT_GRANT_TIMEOUT_SECONDS;
    this.pending = new Map(); // id -> request
    this.decisions = new Map(); // id -> { choice, at, by }
    // A grant that lasts the panel's own lifetime, per worktree. "Allow for this session" is exactly this and
    // nothing more: it is in memory, so a restart asks again.
    this.session = new Set(); // normKey(worktree)
    this.once = new Map(); // normKey(worktree) -> at (a grant that one write consumes)
    this.landing = new Set(); // normKey(worktree) of trees started to LAND — they push by design
    // id -> a write that went through WITHOUT a question, once the remote confirms it: { id, kind, worktree,
    // project, branch, remote, refs, command, why, at, state, confirmed, sha, unwind }. The page draws one card
    // each; the panel owns the inverse in `unwind`, so a page can name a record and never a command.
    this.reviews = new Map();
    this.verify = null; // setVerifier(): how the panel proves a reported write landed (git ls-remote, in server.js)
    this.timer = setInterval(() => this.sweep(), 5000);
    if (this.timer.unref) this.timer.unref();
  }

  policy() {
    return policyFrom(this.getPolicy());
  }

  // Why a write from this worktree is or is not allowed right now, in one word plus the reason, so both the guard
  // and the panel's own paths can act on the same answer instead of each deciding for itself.
  //
  // `allowPushWithoutAsking` is the legacy boolean (lib/remote-writes.js `allowPushWithoutAskingFor`), already
  // resolved for the tree's project. `pushMode` is the new answer and wins: it is "allow", "ask" or "refuse" from
  // lib/push-permissions.js `pushModeFor`, which knows the branch and whether it is new. A "refuse" is absolute and
  // is returned before the policy, the grants and the landing mark are consulted; "ask" skips the three policy
  // values (they are the model this replaced) and falls through to the grants the reader has already given.
  decision(worktree, policyOverride = null, { allowPushWithoutAsking = false, pushMode = null, kindRefusal = null } = {}) {
    // The policy in force for THIS tree: a project may carry its own (lib/remote-writes.js `policyForProject`), and
    // the panel passes it here so a tree in a repo that lands by PR is not decided by another repo's setting.
    const policy = policyOverride ? policyFrom(policyOverride, this.policy()) : this.policy();
    const key = normKey(worktree);
    // A recorded LOCAL-ONLY kind is the first word, before any control, grant or landing mark: the sentence names the
    // tree and the kind, and only the reader's own lift clears it (the record is where that answer lives).
    if (kindRefusal) return { allowed: false, why: kindRefusal, ask: false };
    if (pushMode === "refuse") return { allowed: false, why: "the push control for this branch is never", ask: false };
    if (pushMode === "allow") return { allowed: true, why: "the push control allows this branch without asking", ask: false };
    if (pushMode !== "ask") {
      if (policy === "allow") return { allowed: true, why: "the setting allows remote writes" };
      if (policy === "deny") return { allowed: false, why: "the setting refuses remote writes outright", ask: false };
      if (allowPushWithoutAsking === true) return { allowed: true, why: "this remote's push controls allow it without asking", ask: false };
    }
    if (key && this.landing.has(key)) return { allowed: true, why: "this tree was started to land", ask: false };
    if (key && this.session.has(key)) return { allowed: true, why: "allowed for this session", ask: false };
    if (key && this.once.has(key)) return { allowed: true, why: "allowed once", ask: false, consume: true };
    return { allowed: false, why: pushMode === "ask" ? "the push control for this branch says always ask" : "this tree is local only", ask: true };
  }

  // The hook and the merge flow both call this. Returning `consume: true` means the caller is taking the one-shot
  // grant: it must call `spend()` when it actually pushes, or a refused push would eat the reader's answer.
  spend(worktree) {
    const key = normKey(worktree);
    if (key) this.once.delete(key);
  }

  // ---- the writes nobody was asked about ----------------------------------------------------------------
  // How the panel proves a reported write landed. lib/remote-writes.js owns no git, so server.js hands in the
  // reader (git ls-remote): `{found, sha}`. Without one, every report is treated as unconfirmed and dropped.
  setVerifier(fn) {
    this.verify = typeof fn === "function" ? fn : null;
  }

  // A write the guard is STARTING without asking (its own policy file says `allow`, or the tree is marked landing, so
  // it returns before the request route ever runs), or one this panel allowed from a standing grant. Nothing is
  // drawn yet: the record is confirmed against the remote first, and only a write that really landed is broadcast —
  // a review card for a push that never left the box would be its own false record. The route or hook gets its id
  // back at once; the confirmation runs on its own clock.
  review(input = {}) {
    const id = `rwv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const rec = {
      id,
      kind: String(input.kind || "push"),
      worktree: String(input.worktree || ""),
      project: String(input.project || ""),
      branch: String(input.branch || ""),
      remote: String(input.remote || ""),
      refs: String(input.refs || "").slice(0, 600),
      command: String(input.command || ""),
      why: String(input.why || ""),
      at: Date.now(),
      state: "checking",
      confirmed: false,
      sha: "",
      unwind: null,
    };
    this.reviews.set(id, rec);
    this.log(`remote-write review ${id}: ${rec.command || rec.kind} from ${rec.worktree || "(no tree)"} went through without asking — confirming on the remote`);
    const settle = (out) => {
      const live = this.reviews.get(id);
      if (!live || live.state !== "checking") return;
      if (!out || !out.found) {
        this.reviews.delete(id);
        this.log(`remote-write review ${id}: the remote does not show ${rec.remote}/${rec.branch} — nothing ran, so there is nothing to review`);
        return;
      }
      live.state = "ran";
      live.confirmed = true;
      live.sha = String(out.sha || "");
      live.at = Date.now();
      live.unwind = this.unwindFor(live);
      this.onEvent({ type: "remote-write-review", review: this.publicReview(live) });
      this.log(`remote-write review ${id}: confirmed ${rec.remote}/${rec.branch} at ${live.sha || "?"} — the reader has Keep / ${live.unwind.type}`);
    };
    if (!this.verify) {
      settle(null);
      return rec;
    }
    // Asked NOW, not on the next tick: the read of the remote starts while the push is still finishing, which is the
    // whole reason the verifier retries. A verifier that throws synchronously is a failed read, not a crash.
    let proof;
    try {
      proof = Promise.resolve(this.verify(rec));
    } catch (e) {
      proof = Promise.reject(e);
    }
    proof
      .then(settle)
      .catch((e) => {
        this.log(`remote-write review ${id}: could not read the remote (${String((e && e.message) || e)}) — no card is drawn`);
        settle(null);
      });
    return rec;
  }

  // What "Unwind" would do, NAMED EXACTLY. A push of a feature-shaped branch has one safe inverse — delete that one
  // remote branch — and because the button names it, the click is its own confirmation. Everything else (a base
  // branch, a merge flow, a write with no branch, one the remote does not show) has NO safe inverse, and there the
  // offer is a message to the agent: never a command this panel would run on somebody's behalf.
  unwindFor(rec) {
    const branch = String(rec?.branch || "").trim();
    const remote = String(rec?.remote || "").trim();
    const name = branch.replace(/^refs\/heads\//, "");
    const deletable =
      rec?.confirmed &&
      rec?.kind === "push" &&
      Boolean(name) &&
      Boolean(remote) &&
      name.includes("/") &&
      !PROTECTED_BRANCHES.has(name.toLowerCase());
    if (deletable) {
      return {
        type: "delete-branch",
        label: `delete remote branch ${remote}/${name}`,
        command: `git push ${remote} --delete ${name}`,
      };
    }
    return {
      type: "message",
      label: "draft a message to the agent",
      text:
        `You were allowed to ${rec?.kind === "merge" ? "start a merge" : `push ${name || "a branch"}`} without being asked` +
        `${rec?.why ? ` (${rec.why})` : ""}. Please say what that ${rec?.kind === "merge" ? "merge" : "push"} carried, and do not repeat it until I say so.`,
    };
  }

  reviewFor(id) {
    return this.reviews.get(String(id)) || null;
  }

  // Keep: the write stands and the record goes. The page draws the dismissal at once; this is the server's copy.
  keepReview(id) {
    const key = String(id);
    if (!this.reviews.has(key)) return { ok: false, error: "unknown review" };
    this.reviews.delete(key);
    this.onEvent({ type: "remote-write-review-done", id: key, action: "keep" });
    this.log(`remote-write review ${key}: kept by the reader`);
    return { ok: true };
  }

  // The panel ran the record's own inverse (server.js does the git, and only ever for `delete-branch`). The record
  // becomes the receipt of the undo and is broadcast again, so every open page says the same thing.
  markUnwound(id, { did = "", alreadyGone = false, error = "" } = {}) {
    const key = String(id);
    const rec = this.reviews.get(key);
    if (!rec) return null;
    if (error) return null;
    rec.state = "unwound";
    rec.unwoundAt = Date.now();
    rec.at = Date.now(); // a fresh receipt: the 90 s on the page starts at the undo, not at the push
    rec.did = String(did || rec.unwind?.label || "");
    rec.alreadyGone = Boolean(alreadyGone);
    this.onEvent({ type: "remote-write-review-done", id: key, action: "unwind", review: this.publicReview(rec) });
    return rec;
  }

  publicReview(rec) {
    return {
      id: rec.id,
      kind: rec.kind,
      worktree: rec.worktree,
      project: rec.project,
      branch: rec.branch,
      remote: rec.remote,
      refs: rec.refs,
      command: rec.command,
      why: rec.why,
      at: rec.at,
      state: rec.state,
      confirmed: rec.confirmed,
      sha: rec.sha,
      unwind: rec.unwind,
      did: rec.did || "",
      alreadyGone: Boolean(rec.alreadyGone),
    };
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
    const timeoutSeconds = Number(input.timeoutSeconds) > 0 ? Math.min(MAX_GRANT_TIMEOUT_SECONDS, Number(input.timeoutSeconds)) : this.timeoutSeconds;
    const allowed = (Array.isArray(input.allowed) && input.allowed.length ? input.allowed : GRANT_CHOICES)
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
    this.onEvent({ type: "remote-write-answered", id: key, choice: clean, why, kind: req.kind, worktree: req.worktree, branch: req.branch });
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
      this.onEvent({ type: "remote-write-answered", id, choice: "deny", expired: true, why: "no answer inside the window", kind: req.kind, worktree: req.worktree, branch: req.branch });
      this.log(`remote-write ${id}: nobody answered inside ${req.timeoutSeconds}s — denied`);
    }
    // A review nobody kept is a record, not a fixture: it ages out of the panel's own memory on this clock. The
    // page ages the drawn card much sooner (90 s); this bound is only so a long-lived panel does not accumulate them.
    for (const [id, r] of this.reviews) if (now - (Number(r.at) || 0) > REVIEW_TTL_MS) this.reviews.delete(id);
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
      // The receipts of writes the setting allowed, so a reload inside their window comes back to the same card.
      reviews: [...this.reviews.values()].filter((r) => r.state !== "checking").map((r) => this.publicReview(r)),
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
