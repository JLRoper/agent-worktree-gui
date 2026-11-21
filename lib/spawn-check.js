// The checks a SPAWN meets at the cut, in ONE place, so the pre-flight route and the cut itself cannot disagree.
//
// A SPAWN line is a claim about the future, and until now the panel only answered it after the line was written:
// on 2026-11-21 a SPAWN naming parked row 184 was refused with "task #184 is parked" AFTER the assistant had
// already told the reader the run had started, and the same evening two SPAWNs went into trees that still held
// somebody else's unlanded commits. The refusal was right both times and arrived too late. GET
// /api/assistant/spawn-check asks the same questions before the line is written, and this module is where those
// questions live, so the route's answer is the cut's answer by construction rather than by a copy that can drift.
//
// Three checks, and each is the SAME function the cut refuses with:
//
//   row   the id the line names - a row that does not exist in this assistant's queue, a row in another
//         assistant's queue, a row that finished, a PARKED row (a park is a hold somebody put there, and a SPAWN
//         is not the thing that releases it), or a row whose run is still live. `rowRefusal` is the body of
//         Assistant#spawnTaskRefusal, and lib/assistant.js calls it for the cut.
//   hold  the tree the line names - a live run standing in it. `heldTreeRefusal` is the sentence lib/jobs.js
//         `create` refuses a second cut on, over the holder `liveJobsInTree` already found.
//   work  the tree still holds work of its own: commits its branch carries that the base does not, or uncommitted
//         files. This one is NOT a refusal - the cut allows it, may even reuse that tree on purpose (see
//         lib/spawn-reuse.js) - but it is reported, because a worker put into a tree nobody has landed is how two
//         SPAWNs ended up editing the same unlanded work.
//
// Every refusal names the FIX as well as the obstacle: the queue action that unparks the row, the job id and
// thread to wait for, the branch and commit count to land. A reason with no remedy reads as a dead end, and the
// assistant that could only say "task #184 is parked" to the reader had no way to say what would unstick it.
//
// Everything here is pure: rows and job summaries in, an answer out. Nothing here starts anything, writes anything
// or grants anything; the route that calls it is as read-only as this module.

export const CHECK_ROW = "row";
export const CHECK_HOLD = "hold";
export const CHECK_WORK = "work";

// A check's answer is `null` when nothing is wrong, else { check, code, reason, remedy }. The reason is the
// obstacle in the panel's own words (lowercase, no final stop, so it reads inside a longer sentence); the remedy
// is the fix as a sentence of its own.
const commitsOf = (n) => `${n} unlanded commit${n === 1 ? "" : "s"}`;

const plain = (text, max) => {
  const value = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
};

const treeLabel = (tree) =>
  String(tree ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .trim() || "that tree";

/** The one sentence a thrown refusal uses, so the cut and the route read the same words. */
export function sentenceOf(check) {
  if (!check) return "";
  const reason = String(check.reason || "")
    .trim()
    .replace(/\.$/, "");
  const remedy = String(check.remedy || "").trim();
  if (!reason) return remedy;
  if (!remedy) return `${reason}.`;
  return `${reason}. ${/\.$/.test(remedy) ? remedy : `${remedy}.`}`;
}

/**
 * The row a SPAWN names, refused in the line's own terms. `thread` and `live` are what the caller found on the
 * row's current thread (the live job, or null); `otherName` is the assistant whose queue holds the id when this
 * one does not, which is a different mistake from a typo and is worth naming.
 * @returns {{check:string, code:string, reason:string, remedy:string}|null}
 */
export function rowRefusal({ tasks = [], taskId, assistantName = "", otherName = null, thread = null, live = null } = {}) {
  const id = Number(taskId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const task = (Array.isArray(tasks) ? tasks : []).find((t) => Number(t.id) === id) || null;
  if (!task) {
    if (otherName) {
      return {
        check: CHECK_ROW,
        code: "task-foreign",
        reason: `task #${id} is in ${otherName}'s queue, not ${assistantName}'s - an id names a row in the queue of the assistant carrying the line out`,
        remedy: `write the SPAWN on ${otherName}'s thread, or move the row over first (queue action reassign to ${assistantName})`,
      };
    }
    return {
      check: CHECK_ROW,
      code: "task-missing",
      reason: `no task #${id} in ${assistantName}'s queue - a SPAWN can only link a row that exists there`,
      remedy: `file the row first (queue action add), or write the SPAWN without #${id} if it is meant to stand alone`,
    };
  }
  if (task.state === "done") {
    return {
      check: CHECK_ROW,
      code: "task-done",
      reason: `task #${id} is done (${plain(task.title, 60)}) - a finished task is not started again`,
      remedy: `requeue it first (queue action state queued with a reason) if the work really has to run again`,
    };
  }
  if (task.state === "parked") {
    return {
      check: CHECK_ROW,
      code: "task-parked",
      reason: `task #${id} is parked${task.reason ? ` (${plain(task.reason, 100)})` : ""} - a park is a hold, and a SPAWN is not the thing that releases it`,
      remedy: `unpark it first: queue action state queued with a reason, then write the SPAWN`,
    };
  }
  if (live) {
    return {
      check: CHECK_ROW,
      code: "task-live",
      reason: `task #${id} already has a live run (job ${live.id} on thread ${thread}, ${live.status}) - a second dispatch would put two workers on the same files`,
      remedy: `wait for job ${live.id} on thread ${thread} to end, or steer it`,
    };
  }
  return null;
}

/**
 * The tree a SPAWN names, held by a live run. `holder` is a job summary (id, thread, status), the one
 * `liveJobsInTree` finds for this path at the cut. `branch`/`commits` are the scanned row's own facts when the
 * caller has them; they are added as evidence, never as a second decision.
 * @returns {{check:string, code:string, reason:string, remedy:string}|null}
 */
export function heldTreeRefusal({ tree = "", holder = null, branch = null, commits = 0 } = {}) {
  if (!holder || !holder.id) return null;
  const count = Number(commits) || 0;
  const unlanded = branch && count > 0 ? `, and its branch ${branch} also carries ${commitsOf(count)}` : "";
  return {
    check: CHECK_HOLD,
    code: "tree_busy",
    reason: `the worktree ${treeLabel(tree)} already has a live run (${holder.id} on thread ${holder.thread}, ${holder.status}) - a second worker in that tree would edit the same files${unlanded}`,
    remedy: `wait for job ${holder.id} on thread ${holder.thread} to end, steer it, or name a free tree`,
  };
}

/**
 * The tree holds work of its own. Not a refusal: the cut allows it and may reuse the tree deliberately. It is
 * reported so the author knows what a worker would be standing in before the line is written, and it names the
 * branch and how many commits, which is the only way to say which work has to land first.
 * @returns {{check:string, code:string, reason:string, remedy:string}|null}
 */
export function heldTreeWork({ path = "", branch = null, commits = 0, dirty = 0, mainBranch = "main" } = {}) {
  const count = Number(commits) || 0;
  const files = Number(dirty) || 0;
  if (count <= 0 && files <= 0) return null;
  const parts = [];
  if (count > 0) parts.push(`its branch ${branch || "(detached)"} carries ${commitsOf(count)} that ${mainBranch} does not have`);
  if (files > 0) parts.push(`${files} uncommitted file${files === 1 ? "" : "s"}`);
  const fix =
    count > 0
      ? `land ${branch || "that branch"} first, or name a free tree - a worker started here would edit work nobody has landed`
      : `commit or discard those files first, or name a free tree - a worker started here would edit work nobody has landed`;
  return {
    check: CHECK_WORK,
    code: "tree-unlanded",
    reason: `the tree ${treeLabel(path)} still holds work of its own: ${parts.join(", and ")}`,
    remedy: fix,
  };
}
