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
//
// A FOURTH check was added for the defect row 293 names: the lane. The digest derives a lane at read time and prints
// "SKIP: files in use by #286" for a queued row whose file another row's live job holds, while the cut only refused a
// ROW with a live worker or a TREE a live run stood in - a shared file was neither, so GET /api/assistant/spawn-check
// answered ok:true for a row the digest was printing SKIP for, and two workers reached public/style.css on
// 2026-11-24. `liveRowHolders` finds the live rows that claim this row's files, and `laneRefusal` is the ONE sentence
// both the digest and the cut use: the digest prints `SKIP: <that sentence>` and the cut throws exactly it.
// `heldTreeRefusal` is untouched - the lane is a second check beside the per-tree guard, never a replacement.
import { intersectingFiles, normQueueFile } from "./queue-files.js";

export const CHECK_ROW = "row";
export const CHECK_HOLD = "hold";
export const CHECK_WORK = "work";
export const CHECK_LANE = "lane";

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
 * The rows a LIVE job is working, whose files this row also claims. `liveness(row)` answers `{live, thread, jobId,
 * status}` for another row; the caller supplies it because the queue reads liveness from its run record and the cut
 * reads it from the job store, and both feed the ONE predicate below rather than judging the overlap themselves.
 *
 * A row is a candidate only while it reads `running`: a queued or parked row claims a file it is not yet in, and the
 * conflict the digest prints is about the run that is in it. A row whose run has ended is not a holder either, which
 * is the half that lets the row start once the holder settles.
 * @returns {Array<{id:number, title:string|null, thread:string|null, jobId:string|null, status:string|null, files:string[]}>}
 */
export function liveRowHolders({ task = null, rows = [], liveness = null } = {}) {
  const files = Array.isArray(task?.files) ? task.files : [];
  if (!files.length) return [];
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.state !== "running" || Number(row.id) === Number(task.id)) continue;
    const live =
      typeof liveness === "function"
        ? liveness(row)
        : { live: row.stale !== true, thread: row.thread || null, jobId: row.runId || null, status: null };
    if (!live || live.live !== true) continue;
    // The files are taken from THIS row's claim (`files`), because that is the spelling the author wrote and the digest
    // prints. `intersectingFiles` returns the first list's entries, so the digest and the cut name the same string.
    const shared = intersectingFiles(files, row.files);
    if (!shared.length) continue;
    out.push({
      id: Number(row.id),
      title: String(row.title || "").trim() || null,
      thread: String(live.thread || row.thread || "").trim() || null,
      jobId: String(live.jobId || row.runId || "").trim() || null,
      status: String(live.status || "").trim() || null,
      files: shared,
    });
  }
  return out.sort((a, b) => Number(a.id) - Number(b.id));
}

/** The run a holder is on, said the same way in the digest and in the cut. */
const holderRun = (holder) => {
  const job = String(holder?.jobId || "").trim();
  const thread = String(holder?.thread || "").trim();
  const status = String(holder?.status || "").trim();
  const state = status ? `, ${status}` : "";
  if (job && thread) return `job ${job} on thread ${thread}${state}`;
  if (job) return `job ${job}${state}`;
  if (thread) return `thread ${thread}${state}`;
  return `a live run${state}`;
};

const fileNames = (files) =>
  [...new Set((Array.isArray(files) ? files : []).map((f) => String(f ?? "").trim()).filter(Boolean))].join(", ");

/** Whether a recorded exception covers one shared file for one holder. `holder` null on the exception means any. */
const allowCovers = (allows, holder, file) =>
  (Array.isArray(allows) ? allows : []).find(
    (a) =>
      a &&
      String(a.by || "").trim() &&
      String(a.file || "").trim() &&
      intersectingFiles([a.file], [file]).length &&
      (a.holder === null || a.holder === undefined || Number(a.holder) === Number(holder.id)),
  ) || null;

/**
 * The lane: another LIVE job's row claims one of this row's files.
 *
 * This is the ONE predicate. `Assistant#taskRowCheck` calls it for the pre-flight route AND for the cut, so both
 * answer from it; `decorateTasks` calls the same function to build the digest's `skipped` sentence, so the digest's
 * `SKIP:` and the cut's refusal are one sentence and spawn-check cannot answer ok where the digest says SKIP.
 *
 * The refusal names the holder row, the file and THIS row, in the same shape `heldTreeRefusal` names a tree. A
 * recorded exception (`laneAllow` on this row) does NOT stop the overlap being reported: it is returned as
 * `{code: "lane_allowed", allowed: true}` - a note, never a refusal - naming who allowed it and which file. The
 * caller decides what to do with a note (`spawnCheck` sets `ok: true` and carries it in reason/remedy, exactly as it
 * carries the unlanded-tree note).
 *
 * One exception covers one holder and one file. An exception for #286 does not license an overlap with #290, and one
 * for public/style.css does not license lib/assistant.js: that is what makes the record a decision rather than a
 * blanket waiver.
 * @returns {{check:string, code:string, reason:string, remedy:string, allowed?:boolean}|null}
 */
export function laneRefusal({ task = null, holders = [], allows = null } = {}) {
  const list = (Array.isArray(holders) ? holders : []).filter((h) => h && h.id && Array.isArray(h.files) && h.files.length);
  if (!list.length) return null;
  const id = Number(task?.id) || null;
  const row = id ? `#${id}` : "this row";
  const exceptions = Array.isArray(allows) ? allows : Array.isArray(task?.laneAllow) ? task.laneAllow : [];
  let allowed = null;
  for (const holder of list) {
    const files = [...new Set(holder.files.map((f) => String(f ?? "").trim()).filter(Boolean))];
    const held = files.filter((file) => !allowCovers(exceptions, holder, file));
    if (held.length) {
      const names = fileNames(held);
      const one = held.length === 1;
      const wait = holder.jobId ? `job ${holder.jobId}` : holder.thread ? `thread ${holder.thread}` : "that run";
      return {
        check: CHECK_LANE,
        code: "file_busy",
        holder: { id: holder.id, thread: holder.thread || null, jobId: holder.jobId || null, status: holder.status || null },
        files: held,
        reason: `files in use by #${holder.id} (${holderRun(holder)}) - ${row} also claims ${names}, so starting it would put two workers in ${one ? "that file" : "those files"}`,
        remedy: `wait for ${wait} to end and land ${row}, or record an explicit overlap first (queue action allow-overlap, which stores who allowed it and the file)`,
      };
    }
    if (!allowed) {
      const allow = allowCovers(exceptions, holder, files[0]);
      allowed = {
        check: CHECK_LANE,
        code: "lane_allowed",
        allowed: true,
        holder: { id: holder.id, thread: holder.thread || null, jobId: holder.jobId || null, status: holder.status || null },
        files,
        allow: {
          file: allow?.file || normQueueFile(files[0]),
          by: allow?.by || null,
          at: allow?.at || null,
          reason: allow?.reason || null,
          holder: allow && allow.holder !== undefined ? allow.holder : holder.id,
        },
        reason: `files in use by #${holder.id} (${holderRun(holder)}) - the overlap with ${row} on ${fileNames(files)} was allowed by ${allow?.by || "nobody named"}${allow?.at ? ` at ${allow.at}` : ""}${allow?.reason ? `: ${plain(allow.reason, 80)}` : ""}`,
        remedy: `nothing to do: the overlap is recorded on ${row}; clear it with queue action allow-overlap, clear true, file ${allow?.file || files[0]}`,
      };
    }
  }
  return allowed;
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
