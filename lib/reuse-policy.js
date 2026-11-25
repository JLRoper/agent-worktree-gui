// The worktree REUSE POLICY (queue row 323): three cases, and only two of them are reuse.
//
//   1. DISRUPTION RECOVERY. A run was cut off and the assistant needs that agent working again. It re-attaches
//      the EXISTING agent in its own tree (a reply continues the same thread and session). When re-attach is
//      impossible the NEW agent goes in the SAME tree, and that is allowed on exactly two conditions, both
//      enforced rather than assumed:
//        - the old run resolves DEAD through the runs API: an explicit terminal status, never a missing run
//          (a 404 is the gateway forgetting a run, not the run ending) and never the card's own stale word;
//        - the new agent's brief says work already exists in that tree from a previous run and must be read
//          before anything is overwritten (`priorWorkBrief`).
//      There is NO clean-tree requirement, and this module does not invent one: a disrupted tree is dirty with
//      the previous run's work by definition. Refusing it would be a rule nobody asked for.
//
//   2. STAGE PING-PONG. A coder and a reviewer in a capped loop hold TWO trees. The coder pushes to the shared
//      repo (usually a local git remote) and the reviewer reads that branch from its own tree, so its reports
//      stay isolated. git refuses two worktrees on ONE branch, so each round the reviewer cuts a PER-ROUND
//      REVIEW BRANCH from the coder's branch in its own tree, which is also what lets it commit notes and
//      fixups. The round is anchored on the SHA the review branch was cut from, so a later coder rebase cannot
//      silently move what was reviewed. Neither tree is the other's duplicate, and a second agent in the
//      REVIEWER's tree is not a second agent in the coder's.
//
//   3. NOT REUSE. A landed or finished tree handed to an UNRELATED new row. That is the defect row 313 hit: it
//      was cut into row 296's landed tree, reviewed itself against a stale base (its branch read 32 commits
//      ahead and had to be reset) and silently inherited that tree's initiative attachment. A new row cuts a
//      FRESH tree from current HEAD and inherits no attachment. A cut aimed at a landed tree is REFUSED by name
//      when it carries a queue row, and WARNED by name when it does not.
//
// What this module can and cannot prove. The DEAD verdict is the runs API's own answer (GET /v1/runs/<id>
// ending completed, failed, cancelled or interrupted); a 404 and an unreadable answer are both "not dead", so
// the panel refuses rather than pretending. The review branch's ANCESTRY is a git fact this module cannot
// read: it takes the coder's branch and SHA from the caller and refuses a form git itself would refuse (the
// same branch in two worktrees). The anchor is written into the branch name and into the brief, so a round
// says what it actually reviewed instead of claiming a review of whatever HEAD happens to be.
//
// Everything here is pure: rows and job summaries in, a decision out. The one network read (the runs API) is
// the caller's, in lib/jobs.js and lib/assistant.js, and both feed it into `runVerdict` here so the cut and the
// pre-flight read the same answer.
import { CHECK_HOLD, heldTreeRefusal } from "./spawn-check.js";

export const CHECK_LANDED = "landed";
export const CHECK_STAGE = "stage";

// The three cases, and the fresh cut that is none of them.
export const REUSE_CASES = Object.freeze({
  DISRUPTION: "disruption",
  STAGE: "stage",
  NOT_REUSE: "not-reuse",
  FRESH: "fresh",
});

// The runs API's terminal states. This is the ONLY thing that makes an old run DEAD.
export const DEAD_RUN_STATUS = new Set(["completed", "failed", "cancelled", "interrupted"]);

const norm = (p) =>
  String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
const clean = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").trim();
const treeLabel = (tree) => clean(tree) || "that tree";
const lower = (s) => String(s ?? "").trim().toLowerCase();

/**
 * What the runs API's answer means for a re-issue. `run` is `{ runId, read, gone, status }` as
 * `Jobs#runStateOf` returns it; `null` is "the API was not asked". Only an explicit terminal status is DEAD:
 * a 404 is the gateway forgetting the run, and an unreadable or statusless answer proves nothing.
 * @returns {{dead:boolean, status:string, why:string}}
 */
export function runVerdict(run = null) {
  const id = String(run?.runId || run?.id || "").trim();
  const status = lower(run?.status);
  const name = id ? `run ${id}` : "the run";
  if (!run || run.read !== true) {
    if (run?.gone === true) {
      return { dead: false, status: "", why: `the runs API has no ${name} (404) - a missing run is not evidence the old one ended` };
    }
    return { dead: false, status: "", why: `the runs API could not be read for ${name}` };
  }
  if (!status) return { dead: false, status: "", why: `the runs API answered no status for ${name}` };
  if (DEAD_RUN_STATUS.has(status)) return { dead: true, status, why: `the runs API says ${name} is ${status}` };
  return { dead: false, status, why: `the runs API says ${name} is ${status}` };
}

/**
 * The refusal a re-issue into a held tree meets, or null when it may go ahead.
 *
 * null means one of: no live card stands in the tree (nothing to ask about), or the card's run resolved DEAD
 * through the runs API. A card with no run id cannot be proved dead, so it keeps the ordinary held-tree
 * refusal (`heldTreeRefusal`, the sentence `jobs.create` always threw) rather than inventing a softer one.
 * @returns {{check:string, code:string, reason:string, remedy:string}|null}
 */
export function reissueRefusal({ tree = "", holder = null, run = null } = {}) {
  if (!holder || !holder.id) return null;
  if (!String(holder.runId || "").trim()) return heldTreeRefusal({ tree, holder });
  // The holder names the run even when the caller's read failed, so the message can name it too.
  const verdict = runVerdict(run || { runId: String(holder.runId).trim(), read: false, gone: false, status: "" });
  if (verdict.dead) return null;
  const where = holder.thread ? `job ${holder.id} on thread ${holder.thread}` : `job ${holder.id}`;
  const state = lower(holder.status) || "running";
  const runId = String(holder.runId).trim();
  const gone = run?.gone === true;
  const reason = `the worktree ${treeLabel(tree)} already has a live run (${where}, ${state}) and ${verdict.why} - a re-issue into the same tree needs that run DEAD`;
  const remedy = gone
    ? `settle the unknown run first (Settings > Gateway > Reset assistant, or POST /v1/runs/${runId}/resolve-unknown), then re-issue into the same tree`
    : `wait for job ${holder.id} on thread ${holder.thread || "(unknown)"} to end and re-issue then, steer it, or name a free tree`;
  return { check: CHECK_HOLD, code: gone ? "tree_run_unknown" : "tree_live_run", reason, remedy };
}

/**
 * The paragraph the NEW agent's brief carries when it is put into a tree a previous run already worked in.
 * It is the second enforced condition of the disruption case, so it is built here rather than left to a caller
 * to remember. It never asks for a clean tree: the work it names is supposed to be there.
 */
export function priorWorkBrief({ tree = "", holder = null, run = null } = {}) {
  if (!holder || !holder.id) return "";
  const verdict = runVerdict(run);
  const where = treeLabel(tree);
  const job = `job ${holder.id}${holder.thread ? ` on thread ${holder.thread}` : ""}`;
  const ended = verdict.status ? `ended ${verdict.status} per the runs API` : "is no longer running";
  return [
    `REUSE ON A DISRUPTION: work already exists in ${where} from a previous run (${job}, ${ended}).`,
    "Read it before you overwrite anything: run `git log --oneline -20`, `git status`, and read this tree's TODO list, then continue that work rather than replacing it.",
    "Nothing here asks for a clean tree: the files and commits you find are the previous run's work and they stay.",
  ].join(" ");
}

// ---- case 2: the coder/reviewer pair --------------------------------------------------------------------------

export const REVIEW_BRANCH_PREFIX = "review/";
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const REVIEW_RE = /^review\/(.+)-r(\d+)-([0-9a-f]{7,40})$/i;

/**
 * The per-round review branch name, and the anchor it records. The caller supplies the coder's branch and the
 * SHA it stands at NOW; the anchor is the commit the round reviews, so a later coder rebase cannot move it.
 * A call with no anchor is refused rather than given a name with a made-up SHA.
 * @returns {{ok:true, branch:string, anchor:string, round:number, coderBranch:string}|{ok:false, error:string}}
 */
export function reviewRoundName({ coderBranch = "", coderSha = "", round = 1 } = {}) {
  const branch = String(coderBranch || "").trim().replace(/^refs\/heads\//, "");
  const sha = String(coderSha || "").trim();
  const n = Number(round);
  if (!branch) {
    return { ok: false, error: "a review round needs the coder's branch: the per-round branch is cut from it, never from main" };
  }
  if (!SHA_RE.test(sha)) {
    return {
      ok: false,
      error: `a review round needs an anchor SHA (7 to 40 hex characters) - got ${JSON.stringify(String(coderSha ?? ""))}; the round is anchored on the commit the review branch is cut from, so a coder rebase cannot move what was reviewed`,
    };
  }
  if (!Number.isFinite(n) || n < 1) {
    return { ok: false, error: `a review round is a whole number from 1 - got ${JSON.stringify(String(round ?? ""))}` };
  }
  const slug =
    branch
      .replace(/^wtgui\//, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "coder";
  const at = Math.trunc(n);
  return {
    ok: true,
    branch: `${REVIEW_BRANCH_PREFIX}${slug}-r${at}-${sha.slice(0, 7).toLowerCase()}`,
    anchor: sha.toLowerCase(),
    round: at,
    coderBranch: branch,
  };
}

/** The round a branch name records, or null when it is not a per-round review branch. */
export function reviewRoundOf(branch = "") {
  const m = REVIEW_RE.exec(String(branch || "").trim().replace(/^refs\/heads\//, ""));
  if (!m) return null;
  return { round: Number(m[2]), anchor: m[3].toLowerCase(), coderSlug: m[1] };
}

/**
 * The refusal for the one shape git itself refuses: both stages on ONE branch in two worktrees. The panel can
 * read this from the names it was handed, and it is the reason the reviewer gets a review branch at all.
 */
export function sameBranchRefusal({ coderBranch = "", reviewerBranch = "", coderTree = "", reviewerTree = "" } = {}) {
  const c = String(coderBranch || "").trim();
  const r = String(reviewerBranch || "").trim();
  if (!c || !r || lower(c) !== lower(r)) return null;
  const who = clean(reviewerTree) ? `the reviewer's tree ${clean(reviewerTree)}` : "the reviewer's tree";
  const other = clean(coderTree) ? `the coder's tree ${clean(coderTree)}` : "the coder's tree";
  return {
    check: CHECK_STAGE,
    code: "stage_same_branch",
    reason: `${who} and ${other} would both stand on ${r} - git refuses two worktrees on one branch, so the reviewer cannot take the coder's branch`,
    remedy: `cut a per-round review branch from ${r} in the reviewer's tree (${REVIEW_BRANCH_PREFIX}<slug>-r<N>-<sha7>), anchored on the SHA it was cut from`,
  };
}

/**
 * Whether two board rows are the coder and reviewer of ONE stage loop, from the board's own facts: the
 * reviewer's branch is a per-round review branch, and the board already records its parent as the coder's
 * branch. Two rows that do not answer both questions are not a pair, and nothing is guessed.
 * @returns {null|{pair:false, code:string, reason:string}|{pair:true, case:string, lineage:string, round:number, anchor:string, coder:object, reviewer:object}}
 */
export function stagePair({ coder = null, reviewer = null } = {}) {
  const c = coder && (coder.branch || coder.path) ? coder : null;
  const r = reviewer && (reviewer.branch || reviewer.path) ? reviewer : null;
  if (!c || !r) return null;
  if (norm(c.path) && norm(c.path) === norm(r.path)) {
    return {
      pair: false,
      code: "stage_same_tree",
      reason: `one tree cannot be both stages: ${clean(c.path) || "that tree"} is named as the coder's tree and the reviewer's`,
    };
  }
  const round = reviewRoundOf(r.branch);
  if (!round) return null;
  const lineage = String(r.parent || "").trim();
  if (!lineage || !c.branch || lower(lineage) !== lower(c.branch)) return null;
  return {
    pair: true,
    case: REUSE_CASES.STAGE,
    lineage: c.branch,
    round: round.round,
    anchor: round.anchor,
    coder: { path: clean(c.path), branch: String(c.branch).trim() },
    reviewer: { path: clean(r.path), branch: String(r.branch).trim() },
  };
}

/** The same classification when the caller has the rows and the row in hand. */
export function stagePairFor({ row = null, rows = [] } = {}) {
  if (!row) return null;
  const coder =
    (Array.isArray(rows) ? rows : []).find(
      (r) => r && r !== row && String(r.branch || "").trim() && lower(r.branch) === lower(row.parent),
    ) || null;
  if (!coder) return null;
  return stagePair({ coder, reviewer: row });
}

/** What the board says about a pair, on the row or the card: two trees on one lineage, neither the other. */
export function stagePairNote(pair = null) {
  if (!pair?.pair) return "";
  return `this tree is the reviewer's in a stage loop with the coder's tree ${pair.coder.path} (${pair.coder.branch}): ${pair.reviewer.branch} is round ${pair.round} anchored at ${pair.anchor}, so the two trees share one lineage and neither is the other's duplicate`;
}

/** The paragraph the reviewer's brief carries, so the round is cut and anchored the way case 2 requires. */
export function stageReviewBrief(pair = null) {
  if (!pair?.pair) return "";
  return [
    "STAGE LOOP - THIS TREE IS THE REVIEWER'S.",
    `The coder works in ${pair.coder.path} on ${pair.coder.branch} and pushes that branch to the shared repo (usually a local git remote).`,
    `Do not check out ${pair.coder.branch} in this tree: git refuses two worktrees on one branch, and that is why your round gets its own.`,
    `Each round, cut a PER-ROUND REVIEW BRANCH here from the coder's branch - ${pair.reviewer.branch} is round ${pair.round} anchored at ${pair.anchor} - and commit your notes and fixups on it.`,
    `Anchor every round on the SHA you cut it from and say that SHA in your report, so a coder rebase cannot move what you reviewed.`,
  ].join(" ");
}

// ---- case 3: a landed tree cannot take an unrelated new row ----------------------------------------------------

/**
 * The board's own reading of a FINISHED tree: its branch is merged into the project's base (MERGED, ON MAIN,
 * ON BASE) or carries nothing of its own (NO COMMITS). A cheap scan that has not measured a verdict is not
 * landed, and this returns null for it rather than guessing.
 */
export function landedTreeOf(row = null) {
  if (!row) return null;
  // The board spells a verdict in capitals and then repeats it in parentheses (`MERGED (3 commits)`), so the
  // decision is read from the capitals and the MESSAGE keeps the row's own spelling - a reader should not be shown
  // `MERGED (3 COMMITS)` because a message builder uppercased a word it only had to compare.
  const said = String(row.verdict || "").trim();
  const verdict = said.toUpperCase();
  const ahead = Number(row.ahead);
  const landed = verdict.startsWith("MERGED") || verdict === "ON MAIN" || verdict === "ON BASE";
  const finished = landed || verdict === "NO COMMITS" || verdict === "NO COMMITS?";
  if (!finished) return null;
  return {
    path: clean(row.path),
    branch: String(row.branch || "").trim() || null,
    verdict: said || null,
    ahead: Number.isFinite(ahead) ? ahead : null,
    landed,
  };
}

/**
 * The cut aimed at a finished tree. A cut that carries a queue row is REFUSED (the row 313 defect); one that
 * carries none is WARNED, because a person may deliberately re-enter a tree they know, and the message has to
 * name what they are entering. Both name the tree, the branch and the verdict, and both say that the tree's
 * initiative attachment belongs to the tree, not to this run.
 * @returns {{refusal:object|null, note:string}}
 */
export function landedTreeCut({ row = null, taskId = null, mainBranch = "main", projectPath = null } = {}) {
  const tree = landedTreeOf(row);
  if (!tree) return { refusal: null, note: "" };
  // The project's own CHECKOUT is not a finished worktree to hand anywhere: it is the tree every new one is cut from,
  // it reads `ON MAIN` by definition, and "run in place" is a choice the panel has always allowed. `unfinishedTree`
  // draws the same line for the reuse recommendation, and this one must not refuse what that one offers.
  if (projectPath && norm(tree.path) === norm(projectPath)) return { refusal: null, note: "" };
  const id = Number(taskId);
  const named = Number.isFinite(id) && id > 0 ? `row #${id}` : "a new row";
  const base = String(mainBranch || "main").trim() || "main";
  const ahead = tree.ahead === null ? "" : `, ${tree.ahead} commit${tree.ahead === 1 ? "" : "s"} ahead of ${base}`;
  const reason = `the tree ${tree.path || "(unnamed)"} is already finished (${tree.verdict}${tree.branch ? `, branch ${tree.branch}` : ""}${ahead}) - a cut here would start ${named} against a stale base and inherit that tree's initiative attachment, which it never earned`;
  const remedy = `cut ${named} a FRESH tree from ${base} at current HEAD (write the SPAWN without IN) and leave the finished tree alone`;
  if (Number.isFinite(id) && id > 0) return { refusal: { check: CHECK_LANDED, code: "tree_landed", reason, remedy }, note: "" };
  return {
    refusal: null,
    note: `${reason}. No queue row is carried, so this is a warning rather than a refusal: the tree's initiative attachment is not this run's`,
  };
}
