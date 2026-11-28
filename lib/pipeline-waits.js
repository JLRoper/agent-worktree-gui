// PIPELINE WAITS: the wait mechanic that must not be a sleeping worker - the reviewer's wait and the stage's own run,
// held as a record on the tree and re-checked by the panel (docs/pipelines.md §6).
//
// Split out of `lib/pipelines.js`, which keeps the catalogue, the live file, the per-project defaults and the
// tree-keyed record. This half is pure too: every function takes `now`, so a test drives an hour of waiting in no
// time, and nothing here sleeps, polls in a loop or holds a run slot. Every name it publishes is re-exported by
// `lib/pipelines.js` under the name importers have always read it by, so no import site moved when the wait did.
//
// TWO KINDS, ONE BOOK. A REVIEW wait is a stage whose exit is the reviewer's answer (`pr-comments`, `pr-approved`,
// `reviewers-exact`): the answer may take a day, and the run's hard cap would turn a healthy wait into a failed card,
// so the turn ends and the PANEL waits - one record on the tree (`pipelineWait`), one ticker that asks which records
// are due, one host read per due record, and a wake on the same thread. A RUN wait is the stage's own worker: the row
// is held keyed to that run (`{kind: "run", stage, job, thread}`), and the panel - not a parked row - reads the
// settle and advances the stage. `waitKind` tells them apart, and a record written before the kinds existed is the
// reviewer's, because that is what every wait the panel could write then was.
//
// The two host payloads are normalised here as well (`observeGithubPr` / `observeBitbucketPr`, both through
// `observePullRequest`), so the wait's decision is testable without a network. `clean` and `isObject` were private in
// the parent; they are imported here and deliberately not exported from the parent's re-export list.
import { clean, isObject } from "./pipeline-validate.js";

// ---- §6: the wait mechanic that must not be a sleeping worker ---------------------------------------------------
// A stage whose exit is the REVIEWER's answer cannot end when its turn ends: the answer may take a day, and the run's
// hard cap (`jobMaxRuntimeSeconds`) would turn a healthy wait into a failed card. So the turn ends and the PANEL
// waits: a record on the tree (`pipelineWait`), one ticker that asks which records are due, one host read per due
// record, and a wake on the same thread when there is something to answer. Nothing here sleeps, polls in a loop or
// holds a run slot — every function below is pure and takes `now`, so a test drives an hour of waiting in no time.

// The three exits that are the reviewer's to answer. `pr-comments` is the wait stage's own (an activity newer than
// `lastSeen`), `pr-approved` is the approval at the head, and `reviewers-exact` is the reviewer set the PR must
// carry. A stage exiting on anything else is the worker's own progress and never registers a wait: `pr-merged` on a
// merge stage is not a reviewer's answer, and a wait on it would wake a thread to do what the worker already did.
export const REVIEW_WAIT_CHECKS = ["pr-comments", "pr-approved", "reviewers-exact"];

// 1h → 2h → 4h, capped. hosts.seed.json's own advice (poll a Bitbucket PR hourly, not more often) is the floor.
export const WAIT_FIRST_MS = 60 * 60 * 1000;
export const WAIT_MAX_MS = 4 * 60 * 60 * 1000;
// A silence this long gets ONE status wake, so a quiet card does not read as dead and the reader can decide.
export const QUIET_WAKE_AFTER_MS = 6 * 60 * 60 * 1000;
// A claim older than this, with no run behind it, is reclaimed: a crash between the claim and the wake is the one
// failure this has to survive, and the alternative is a tree nobody ever wakes again.
export const WAIT_CLAIM_GRACE_MS = 10 * 60 * 1000;

// ---- the SECOND kind of wait: the stage's own RUN ----------------------------------------------------------------
// The reviewer's wait above is one thing a stage can be waiting on; the other is the stage's own worker. A pipeline row
// whose stage has a live run is held in the same book, keyed to that run (`{kind: "run", stage, job, thread}`), so the
// row's condition is a durable fact instead of an inference, and the panel — not a parked row and not a helpful
// assistant — reads the settle and advances the stage. The wait's clock is the run's own status: a run wait is due
// whenever the sweep asks, and the answer is one job-store read, not a host call.
export const RUN_WAIT_KIND = "run";
export const REVIEW_WAIT_KIND = "review";

// How long the book keeps FIRST REFUSAL on the advance once the run it holds has settled. The panel's ticker is a
// minute; three of them is enough for a live timer to be the owner, and after that the driver's own pass advances the
// row — a ticker that died must not leave a settled row waiting for a clock nobody restarts.
export const HOLD_OWNER_MS = 3 * 60 * 1000;

// `run`, `review`, or null. A wait written before the kinds existed is the reviewer's: every wait the panel could
// write then was one, and reading it as anything else would change a record's meaning by re-reading it.
export function waitKind(wait) {
  const kind = clean(wait && wait.kind);
  if (kind === RUN_WAIT_KIND || kind === REVIEW_WAIT_KIND) return kind;
  if (!isObject(wait)) return null;
  return clean(wait.check) || clean(wait.stage) ? REVIEW_WAIT_KIND : null;
}

export function isRunWait(wait) {
  return waitKind(wait) === RUN_WAIT_KIND;
}

// The hold a pipeline stage's CUT writes: the row's stage, and the run that is working it. `job` and `thread` are both
// kept because the panel can be restarted between the cut and the sweep: the card is the live answer, the thread is
// the one the row's current turn is on, and a hold that names neither is not a hold (there is nothing to wait on).
export function stageRunWaitFor(stage, { pipeline = null, visit = null, thread = null, job = null, branch = null, at = new Date().toISOString() } = {}) {
  const id = clean(stage);
  if (!id) return null;
  const heldJob = clean(job) || null;
  const heldThread = clean(thread) || null;
  if (!heldJob && !heldThread) return null;
  const n = Number(visit);
  return {
    kind: RUN_WAIT_KIND,
    stage: id,
    pipeline: clean(pipeline) || null,
    visit: Number.isInteger(n) && n > 0 ? n : null,
    job: heldJob,
    thread: heldThread,
    branch: clean(branch) || null,
    at,
    since: at,
    // Stamped by the settle, not by the cut: the driver's fallback measures "the book has first refusal" from the
    // moment the run ended, and a stage that ran for two hours would otherwise be an ownerless row before it settled.
    settledAt: null,
    claimedAt: null,
  };
}

// The stamp the book's first refusal runs from: the settle when the run has ended, the cut when it has not.
export function holdOwnerFrom(wait) {
  const stamp = msOfStamp(wait && (wait.settledAt || wait.at));
  return stamp == null ? null : stamp + HOLD_OWNER_MS;
}

const stampOfMs = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
// The hosts stamp their records two ways: an ISO string (GitHub, and the fixture payloads this module's tests were
// written on) and the epoch-millisecond NUMBER Bitbucket Server actually sends in `createdDate` and `approvedAt`.
// `Date.parse("1794276394495")` is NaN, so a live comment was dropped as "no comment carries a timestamp yet" while
// the same payload written as ISO advanced the wait. Read both, answer ISO or null.
const hostStamp = (value) => {
  if (value == null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? new Date(value).toISOString() : null;
  const parsed = Date.parse(String(value));
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  const numeric = Number(value);
  return Number.isFinite(numeric) ? new Date(numeric).toISOString() : null;
};
const msOfStamp = (value) => {
  const ms = Date.parse(String(value ?? ""));
  return Number.isFinite(ms) ? ms : null;
};

// Is this stage's exit the reviewer's answer? The seed of a `pipelineWait`, or null for a stage that ends on its own
// work. `thread` is stored WITH the wait because the wake is a turn on the same thread, and the job store keeps only
// 80 conversations — a review loop outlives the card that started it, and a wait that cannot name its thread is a
// wait whose wake has nowhere to go.
//
// TWO DOCUMENTS, ONE FACT. A ladder definition states the review exit on the STAGE (`stage.exit.check`); a PDL document
// states it on the GATE after the stage (`verified_by`), because a PDL stage declares an artifact, not an exit. Both
// name the same closed vocabulary, and both are read through `reviewExitOf`, so a tree record's rung and a queue
// row's PDL document register the SAME wait, take the SAME rail edge (lib/task-pipeline-drive.js `edgeOutOf`) and pay
// the SAME cap. A stage whose document names neither registers nothing: the panel does not infer a reviewer from the
// stage's title.
export function reviewWaitFor(stage, { at = new Date().toISOString(), lastSeen = null, thread = null, branch = null, pipeline = null, gate = null } = {}) {
  const exit = reviewExitOf(stage, gate);
  const check = clean(exit && exit.check);
  if (!REVIEW_WAIT_CHECKS.includes(check)) return null;
  const pipelineId = clean(isObject(pipeline) ? pipeline.id : pipeline);
  const gateId = clean(gate && gate.id);
  return {
    stage: clean(stage.id) || null,
    check,
    who: check === "reviewers-exact" && Array.isArray(exit.who) ? exit.who.map((w) => clean(w)).filter(Boolean) : [],
    // The document the stage was read from, when it is not the tree record's own rung. A PDL row's tree is cut
    // `local` and never moves, so the wait is the durable place that names the document its stage belongs to; a
    // ladder row leaves this absent and the record's `id` answers.
    ...(pipelineId ? { pipeline: pipelineId } : {}),
    ...(gateId ? { gate: gateId } : {}),
    thread: clean(thread) || null,
    // The branch the PR was opened from, stored with the wait: the host read an hour from now has no job record left
    // to ask (the ring keeps 80 conversations) and no git call to pay for, and a PR found by the wrong name is worse
    // than no PR at all.
    branch: clean(branch) || null,
    // `since` is when the wait BEGAN (the quiet-wake clock); `at` is the last check, and every past one moves it.
    since: at,
    at,
    every: WAIT_FIRST_MS,
    attempts: 0,
    lastSeen: clean(lastSeen) || null,
    quietWakeSent: false,
    claimedAt: null,
  };
}

// The gate that ends a PDL stage: `after` names the stage, and `verified_by` names the check that closes it. Only a
// gate naming one of the reviewer's three checks is the stage's review fact; a gate the document ROUTES
// (`decision.routes`) is the document's own two-outcome decision and is left to the verdict block, the same rule
// `reviewEdgeOutOf` applies on the rail.
export function reviewGateFor(pipeline, stageId) {
  const at = clean(stageId);
  if (!at) return null;
  const gates = pipeline && Array.isArray(pipeline.gates) ? pipeline.gates : [];
  return (
    gates.find(
      (gate) =>
        clean(gate && gate.after) === at &&
        REVIEW_WAIT_CHECKS.includes(clean(gate && (gate.verifiedBy || gate.verified_by))) &&
        !isObject(gate.decision && gate.decision.routes),
    ) || null
  );
}

// The review fact itself: the stage's own `exit` where the definition carries one, else the gate after it. One reader,
// so the wait's registration (`lib/jobs.js` `registerPipelineWait`) and its re-check (`readReviewExit`) cannot read two
// different checks out of one stage.
export function reviewExitOf(stage, gate = null) {
  const exit = isObject(stage) ? stage.exit : null;
  if (isObject(exit) && REVIEW_WAIT_CHECKS.includes(clean(exit.check))) return exit;
  const check = clean(gate && (gate.verifiedBy || gate.verified_by));
  if (REVIEW_WAIT_CHECKS.includes(check)) return { check, who: Array.isArray(gate.who) ? gate.who.map((w) => clean(w)).filter(Boolean) : [] };
  return null;
}

// When the record is next due: its last check plus its own interval. A record that cannot answer is due now rather
// than never — a wait nobody re-checks is the sleeping worker this whole section replaces.
export function waitDueAt(wait) {
  const at = msOfStamp(wait?.at);
  const every = Number(wait?.every);
  if (at == null) return null;
  return at + (Number.isFinite(every) && every > 0 ? every : WAIT_FIRST_MS);
}

export function waitIsDue(wait, { now = Date.now() } = {}) {
  // A run hold's clock is the run, not the calendar: the sweep asks the job store, and a hold is always worth that one
  // read. A tick that finds the card still live is a sentence in the summary, not a wake and not a host call.
  if (isRunWait(wait)) return true;
  const due = waitDueAt(wait);
  return due == null ? false : now >= due;
}

// Claim a due record before a wake is started, the way `terminalClaim` stops a second settle wake. Two panels, two
// ticks in the same second and a restart between the read and the run all meet here: the second claim is refused
// with the sentence the card would show, and a claim nobody acted on expires on its own.
export function claimWait(wait, { now = Date.now() } = {}) {
  if (!isObject(wait)) return { ok: false, why: "there is no wait record to claim", wait: null };
  const claimed = msOfStamp(wait.claimedAt);
  if (claimed != null && now - claimed < WAIT_CLAIM_GRACE_MS) {
    return {
      ok: false,
      why: `this wait was claimed at ${new Date(claimed).toISOString()} and that claim is under ${Math.round(WAIT_CLAIM_GRACE_MS / 60000)} minutes old — a second tick, a second panel or a restart cannot wake the same thread twice`,
      wait,
    };
  }
  return { ok: true, why: "", wait: { ...wait, claimedAt: stampOfMs(now) } };
}

// What the PR says, against one exit check. Fail-closed in the document's own rule: a host that is down, a token that
// is missing and a PR that cannot be found all answer "cannot tell", and the stage STAYS where it is. `advanced` is
// the exit; `closed` is the PR ending without answering (merged or closed), which ends the wait quietly rather than
// backing off forever against a PR nobody will comment on again.
export function readReviewExit(exit, observation, { lastSeen = null } = {}) {
  const check = clean(exit && exit.check);
  if (!REVIEW_WAIT_CHECKS.includes(check)) {
    return { ok: false, advanced: false, closed: null, cannotTell: true, seen: null, why: `${JSON.stringify(exit?.check)} is not a review exit` };
  }
  if (!isObject(observation) || observation.ok !== true || !isObject(observation.pr)) {
    const why = clean(observation?.why) || "the pull request could not be read";
    return { ok: false, advanced: false, closed: null, cannotTell: true, seen: null, why: `${why} — a check that cannot be read does not exit the stage` };
  }
  const pr = observation.pr;
  const state = clean(pr.state).toUpperCase();
  if (state === "MERGED") return { ok: true, advanced: false, closed: "merged", cannotTell: false, seen: null, why: "the pull request is MERGED — there is nothing left for a reviewer to answer" };
  if (state === "DECLINED" || state === "CLOSED") {
    return { ok: true, advanced: false, closed: "declined", cannotTell: false, seen: null, why: `the pull request is ${state} — a reviewer's answer cannot arrive on it` };
  }

  if (check === "pr-comments") {
    if (!Array.isArray(pr.comments)) return { ok: false, advanced: false, closed: null, cannotTell: true, seen: null, why: "the host answered without a comments list, so nothing can be newer than lastSeen" };
    // The `lastSeen` the check reads is the WAIT record's (the moment the stage last read the PR), and the exit's own
    // parameter only when the record carries none: the seed's wait stage states `pr-comments` and nothing else, and a
    // stage that must restate its own clock in the definition would be a second place to keep it wrong.
    const seenFrom = msOfStamp(lastSeen != null && String(lastSeen).trim() ? lastSeen : exit.lastSeen);
    let newest = null;
    let at = null;
    for (const c of pr.comments) {
      const ms = msOfStamp(c && c.at);
      if (ms == null) continue;
      if (newest == null || ms > newest) {
        newest = ms;
        at = c.at;
      }
    }
    if (newest == null) return { ok: true, advanced: false, closed: null, cannotTell: false, seen: null, why: "no comment carries a timestamp yet" };
    // A `lastSeen` that is absent or unreadable is not a licence to call every comment new: the stage's own entry
    // stamp is the fallback, and with neither the answer is "cannot tell".
    if (seenFrom == null) return { ok: false, advanced: false, closed: null, cannotTell: true, seen: at, why: "the stage has no readable lastSeen, so \"newer than lastSeen\" cannot be answered" };
    if (newest > seenFrom) return { ok: true, advanced: true, closed: null, cannotTell: false, seen: at, why: `a comment arrived at ${at}, after ${new Date(seenFrom).toISOString()}` };
    return { ok: true, advanced: false, closed: null, cannotTell: false, seen: at, why: `nothing newer than ${new Date(seenFrom).toISOString()}` };
  }

  if (check === "pr-approved") {
    const head = clean(pr.headRefOid);
    if (!head) return { ok: false, advanced: false, closed: null, cannotTell: true, seen: null, why: "the host answered without the PR's head commit, so \"approved at this head\" cannot be answered" };
    if (!Array.isArray(pr.approvals)) return { ok: false, advanced: false, closed: null, cannotTell: true, seen: null, why: "the host answered without an approvals list" };
    for (const a of pr.approvals) {
      if (clean(a && a.commit) !== head) continue;
      return { ok: true, advanced: true, closed: null, cannotTell: false, seen: clean(a.at) || null, why: `${clean(a.by) || "a reviewer"} approved ${head.slice(0, 8)}` };
    }
    return { ok: true, advanced: false, closed: null, cannotTell: false, seen: null, why: `no approval of the head ${head.slice(0, 8)} yet` };
  }

  // reviewers-exact: the reviewer set equals `who`, no more and no fewer (§1.3).
  if (!Array.isArray(pr.reviewers)) return { ok: false, advanced: false, closed: null, cannotTell: true, seen: null, why: "the host answered without a reviewer list" };
  const who = Array.isArray(exit.who) ? exit.who.map((w) => clean(w).toLowerCase()).filter(Boolean).sort() : [];
  const got = pr.reviewers.map((r) => clean(r && typeof r === "object" ? r.name || r.displayName : r).toLowerCase()).filter(Boolean).sort();
  if (!who.length) return { ok: false, advanced: false, closed: null, cannotTell: true, seen: null, why: "the stage's exit names no reviewers, so a set cannot be compared" };
  const advanced = who.length === got.length && who.every((w, i) => w === got[i]);
  return {
    ok: true,
    advanced,
    closed: null,
    cannotTell: false,
    seen: null,
    why: advanced ? `the reviewer set is exactly [${who.join(", ")}]` : `the reviewer set is [${got.join(", ")}], not exactly [${who.join(", ")}]`,
  };
}

// The panel's own read, stamped on the tree's record. `readReviewExit` answers for one instant, and the wait is then
// settled (and, for a pull request that has ENDED, cleared) - but the answer is the fact the two owners of one advance
// have to agree about: the timer reads the PR, the driver moves the row. Without a durable copy the driver takes the
// rail edge the moment a run ends, before any read exists, which is how a DECLINED pull request became a merge stage.
// `state` is the host's own word (DECLINED, CLOSED, MERGED, OPEN), `advanced` and `closed` are the read's outcomes, and
// `at` is the clock it was read at, so a read from an earlier visit of the same stage can be told apart from this one.
export function reviewReadOf(wait, observation, outcome, { at = new Date().toISOString() } = {}) {
  const pr = isObject(observation) && isObject(observation.pr) ? observation.pr : null;
  return {
    stage: clean(wait && wait.stage) || null,
    check: clean(wait && wait.check) || null,
    pipeline: clean(wait && wait.pipeline) || null,
    number: pr && pr.number != null ? pr.number : null,
    state: clean(pr && pr.state).toUpperCase() || null,
    advanced: Boolean(outcome && outcome.advanced === true),
    closed: clean(outcome && outcome.closed) || null,
    cannotTell: Boolean(outcome && (outcome.cannotTell || outcome.ok === false)),
    seen: clean(outcome && outcome.seen) || null,
    why: clean(outcome && outcome.why) || null,
    at,
  };
}

// What the next wait is, or the advance. The document's clock: nothing arrived → `attempts` climbs and `every`
// doubles (capped at 4h); a long silence → one status wake, THEN the same backoff (not a heartbeat); the PR ended →
// the wait is closed; the exit matched → the wait is gone and the stage advances.
export function settleWait(wait, { now = Date.now(), outcome = null } = {}) {
  const at = stampOfMs(now);
  if (!isObject(wait) || !isObject(outcome)) return { ok: false, advance: false, quiet: false, wait: null, why: "settleWait needs a wait record and the read's outcome" };
  if (outcome.closed) return { ok: true, advance: false, quiet: false, wait: null, why: clean(outcome.why) || `the wait is closed (${outcome.closed})` };
  if (outcome.advanced) return { ok: true, advance: true, quiet: false, wait: null, why: clean(outcome.why) || "the exit matched" };
  const every = Math.min(WAIT_MAX_MS, Math.max(WAIT_FIRST_MS, Number(wait.every) || WAIT_FIRST_MS) * 2);
  const since = msOfStamp(wait.since) ?? msOfStamp(wait.at) ?? now;
  const quiet = !wait.quietWakeSent && now - since >= QUIET_WAKE_AFTER_MS;
  return {
    ok: true,
    advance: false,
    quiet,
    wait: {
      ...wait,
      at,
      every,
      attempts: (Number(wait.attempts) || 0) + 1,
      lastSeen: clean(outcome.seen) || clean(wait.lastSeen) || null,
      claimedAt: null,
      quietWakeSent: Boolean(wait.quietWakeSent) || quiet,
    },
    why: clean(outcome.why),
  };
}

// ---- the host observations, normalised here so the decision above is testable without a network -------------------
// The PR's own state, its reviewers and what has arrived on it, in the one shape `readReviewExit` reads. Two hosts,
// two payloads, one observation: `{ok, pr: {number, state, headRefOid, reviewers, comments, approvals}}`. A payload
// this module does not recognise is a REFUSAL (`ok:false`), never an empty PR — an empty PR reads as "nothing has
// arrived" and would back a quiet reviewer off for hours on a response the panel simply could not parse.
export function observePullRequest({ number = null, state = null, headRefOid = null, reviewers = null, comments = null, approvals = null } = {}) {
  if (!clean(state)) return { ok: false, pr: null, why: "the host answered without the pull request's state" };
  return {
    ok: true,
    pr: {
      number: number == null ? null : number,
      state: clean(state).toUpperCase(),
      headRefOid: clean(headRefOid) || null,
      reviewers: Array.isArray(reviewers) ? reviewers : [],
      comments: Array.isArray(comments) ? comments : [],
      approvals: Array.isArray(approvals) ? approvals : [],
    },
    why: "",
  };
}

// `gh pr view <n> --json state,headRefOid,reviewRequests,reviews,comments`. A review counts as an approval only when
// its state says so AND it names the commit it reviewed — an approval at an older commit is not an approval of the
// head, which is the rule the wait stage exists for.
export function observeGithubPr(json, { number = null } = {}) {
  if (!isObject(json)) return { ok: false, pr: null, why: "the gh answer is not a JSON object" };
  const reviews = Array.isArray(json.reviews) ? json.reviews : [];
  const comments = [
    ...(Array.isArray(json.comments) ? json.comments : []).map((c) => ({ id: c?.id ?? null, at: c?.createdAt ?? null, author: c?.author?.login ?? null, kind: "comment" })),
    ...reviews.map((r) => ({ id: r?.id ?? null, at: r?.submittedAt ?? null, author: r?.author?.login ?? null, kind: "review" })),
  ].filter((c) => clean(c.at));
  const approvals = reviews
    .filter((r) => clean(r?.state).toUpperCase() === "APPROVED")
    .map((r) => ({ commit: clean(r?.commit?.oid) || null, at: clean(r?.submittedAt) || null, by: clean(r?.author?.login) || null }));
  // Who the PR was ASKED of: a requested reviewer who has not answered yet is still a reviewer the PR carries. A team
  // request is named by `slug`; the exit's `who` names the group, so both are carried.
  const reviewers = (Array.isArray(json.reviewRequests) ? json.reviewRequests : [])
    .map((r) => clean(r?.login) || clean(r?.slug) || clean(r?.name))
    .filter(Boolean);
  for (const r of reviews) {
    const name = clean(r?.author?.login);
    if (name && !reviewers.includes(name)) reviewers.push(name);
  }
  return observePullRequest({ number: json.number ?? number, state: json.state, headRefOid: json.headRefOid, reviewers, comments, approvals });
}

// Bitbucket Server: one PR record (`fromRef.latestCommit`, `reviewers[]` with `lastReviewedCommit`/`approved`) plus
// its activities page (`values[]` with `action`, `createdDate`, `comment`). The activities carry comment text and the
// review events; the approval's COMMIT comes from the reviewer record, which is the only place the host names it.
export function observeBitbucketPr(prRecord, activities) {
  if (!isObject(prRecord)) return { ok: false, pr: null, why: "the host answered without a pull request record" };
  const values = Array.isArray(activities?.values) ? activities.values : Array.isArray(activities) ? activities : null;
  if (!values) return { ok: false, pr: null, why: "the host answered without an activities page" };
  // Bitbucket's reviewer is `{user: {name, displayName, slug}, role, approved, ...}`; the older fixture shape put the
  // name at the top. Read the real shape FIRST, then the fixture's, so neither host payload is a silent empty list.
  const who = (r) =>
    clean(r?.user?.name) || clean(r?.user?.displayName) || clean(r?.user?.slug) ||
    clean(r?.name) || clean(r?.displayName) || clean(r?.slug);
  const reviewers = (Array.isArray(prRecord.reviewers) ? prRecord.reviewers : [])
    .map(who)
    .filter(Boolean);
  const approvals = (Array.isArray(prRecord.reviewers) ? prRecord.reviewers : [])
    .filter((r) => r && r.approved === true)
    .map((r) => ({ commit: clean(r.lastReviewedCommit) || null, at: hostStamp(r.approvedAt), by: who(r) || null }));
  const comments = values
    .filter((a) => clean(a?.action).toUpperCase() === "COMMENTED" || (a?.comment && clean(a.action).toUpperCase() !== "DELETED"))
    .map((a) => ({ id: a?.comment?.id ?? a?.id ?? null, at: hostStamp(a?.createdDate), author: clean(a?.user?.name) || clean(a?.user?.displayName) || null, kind: "comment" }))
    .filter((c) => clean(c.at));
  return observePullRequest({
    number: prRecord.id ?? null,
    state: prRecord.state,
    headRefOid: prRecord.fromRef?.latestCommit ?? null,
    reviewers,
    comments,
    approvals,
  });
}
