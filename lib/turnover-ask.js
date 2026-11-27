// THE ASK AT THE CUT: what the panel does when a project's turnover policy puts the feature's new branch on the
// permission card.
//
// MEASURED (job 2dc01973): `lib/jobs.js makeWorktree` raised the card and threw, `create()` recorded the throw as a
// FAILED RUN, and the queue row was linked to that run and requeued 0.5 s later reading "the run ended failed with no
// final message". Nothing was cut, no tree and no commits existed, the card the message named was already gone from
// `/api/approvals`, and the row sat queued with nothing left to resume.
//
// The ask is not a failure, so this module carries the three halves that make the card the row's continuation:
//
//   permissionStateOf   the ONE read of a permission record's state, for the queue's `permission` hold;
//   resumeRowAfterAsk   an ALLOWED record restarts the SAME row as a fresh cut, through the ordinary spawner;
//   allowTurnoverAsk    the container is cut, joined to the project's list, and that row restarted under it.
//
// A deny and an expiry need no code on the answer path: the record stops being pending, the row's hold reads false and
// `settleTasks` (lib/assistant/queue.js) returns it to `queued` with the record's own reason. That is why no answer -
// yes, no or silence - can turn into a failed run.
//
// The module owns no HTTP and no git of its own: `jobs.cutTurnoverTreeFor` cuts, `assistant.startSpawn` starts, and the
// composition root hands both in. A test drives the real function over a fabricated project and a real queue file.
import { readQueueFile } from "./assistant/queue.js";

/** The code `makeWorktree` throws an ask with, and the one `create()` turns into `{ asked: true }` instead of a failure. */
export const TURNOVER_ASK_CODE = "turnover-ask";

/** The answer sentence a row's reason gets when an allowed record restarts it. */
export const ASK_ALLOWED_REASON = "the turnover branch was allowed - the cut starts again on this row";

/**
 * One permission record's state, in the four facts a hold and a reason need.
 *
 *   { pending: true }                                  the question is still on the panel: the row waits
 *   { pending: false, expired, choice, by, why }       it was answered, denied or swept: the row is released
 *
 * Three shapes of `status` are read, because they are three different facts: `pending` (still open), `answered` (a
 * decision, `by: "timeout"` when nobody answered inside the window) and `unknown` (the record is gone - the panel was
 * restarted, or it was swept before this row was read). The last one is an EXPIRY, not a hold: a record nothing can
 * answer must never keep a row parked for ever.
 */
export function permissionStateOf(status) {
  const s = status && typeof status === "object" ? status : {};
  const state = String(s.status || "").trim().toLowerCase();
  if (state === "pending") return { pending: true, choice: null, expired: false, by: null, why: "waiting for your answer" };
  if (state === "answered") {
    const by = String(s.by || "").trim() || null;
    const why = String(s.why || "").trim();
    const expired = by === "timeout" || /no answer inside the window/i.test(why);
    return { pending: false, choice: String(s.choice || "").trim() || null, expired, by, why };
  }
  return {
    pending: false,
    choice: null,
    expired: true,
    by: null,
    why: "the permission record is gone - the panel was restarted, or the question was swept",
  };
}

/**
 * Which assistant's queue holds one row id. The row is the panel's record of the work, not any one assistant's: an
 * allowed card must restart the queue that actually carries the id, and a second assistant's queue can hold the same
 * number (each queue numbers its own rows).
 *
 * @returns {{id: string, name: string, task: object}|null}
 */
export function queueOwnerOf(assistant, rowId) {
  const id = Number(rowId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const records = Array.isArray(assistant?.assistants) ? assistant.assistants : [];
  for (const rec of records) {
    if (!rec) continue;
    let out = null;
    try {
      out = readQueueFile(assistant.queuePathOf(rec));
    } catch {
      out = null;
    }
    const task = (out?.tasks || []).find((t) => Number(t?.id) === id) || null;
    if (task) return { id: String(rec.id), name: String(rec.name || rec.id), task };
  }
  return null;
}

/**
 * An allowed card restarts the SAME row as a fresh cut.
 *
 * The park is a hold, and a SPAWN is not what releases a hold (lib/spawn-check.js refuses a parked row by name), so the
 * row is moved back to `queued` first - with the answer as its reason - and only then handed to the ordinary spawner.
 * That order matters: `startSpawn` refuses a parked row before anything is cut, so a resume that skipped the release
 * would do nothing at all and the card would close on an empty board.
 *
 * `prompt` is the text the first cut was asked with. It travels with the permission record for the life of the record,
 * which is the life of this process; a record that outlived it cannot be answered either. The row's own detail is the
 * fallback only for a caller that could not hand the text over.
 *
 * @returns {{ok: boolean, row: number|null, job?: string|null, thread?: string|null, skipped?: boolean, error?: string}}
 */
export async function resumeRowAfterAsk({ assistant, rowId, project = "", prompt = "", todos = [] } = {}) {
  const id = Number(rowId);
  if (!Number.isFinite(id) || id <= 0) {
    return { ok: false, skipped: true, row: null, error: "the cut named no queue row, so there is nothing to restart" };
  }
  if (!assistant || typeof assistant.startSpawn !== "function") {
    return { ok: false, row: id, error: "this panel cannot start agents, so the answered row cannot be restarted here" };
  }
  const owner = queueOwnerOf(assistant, id);
  if (!owner) return { ok: false, row: id, error: `row #${id} is not in any queue - it was moved or deleted while the card waited` };
  const text = String(prompt || "").trim() || String(owner.task.detail || "").trim() || String(owner.task.title || "").trim();
  if (!text) return { ok: false, row: id, error: `row #${id} carries no text to cut a tree from` };
  let freed = null;
  try {
    freed = assistant.queueMutate(owner.id, "state", { id, state: "queued", reason: ASK_ALLOWED_REASON }, { by: "panel" });
  } catch (e) {
    return { ok: false, row: id, error: `#${id} could not be released from its park: ${String((e && e.message) || e)}` };
  }
  if (!freed || freed.ok === false) return { ok: false, row: id, error: (freed && freed.error) || `#${id} could not be released from its park` };
  const spec = { target: String(project || "").trim(), project: String(project || "").trim() || null, existing: false, taskId: id, assistantId: owner.id, prompt: text };
  if (Array.isArray(todos) && todos.length) spec.todos = todos.map(String);
  try {
    const job = await assistant.startSpawn(spec, { source: "turnover-allow", assistantId: owner.id });
    if (!job?.id) return { ok: false, row: id, error: `#${id} was released, but the cut started nothing` };
    return { ok: true, row: id, job: job.id, thread: job.thread || null };
  } catch (e) {
    // A refused start leaves the row QUEUED with the refusal as its reason, not failed: the release already happened and
    // the work is still there to start by hand.
    try {
      assistant.queueMutate(owner.id, "state", { id, state: "queued", reason: `the allowed cut could not start: ${String((e && e.message) || e)}` }, { by: "panel" });
    } catch {
      /* the row keeps the release reason it already carries */
    }
    return { ok: false, row: id, error: String((e && e.message) || e) };
  }
}

/**
 * The ALLOW half of a turnover ask: cut the feature's container, join it to the project's list, then resume the row as
 * the fresh implementation cut the card was asked about.
 *
 * `remember` is the composition root's writer (`rememberTurnoverBranch` in server.js): the branch has to be on the
 * project's record BEFORE the row is restarted, because the restart's own cut reads that record to answer `reuse` and
 * cut the child from the container. `repoDir`/`mainBranch` come from the project record for the same reason - this
 * module never reads the registry.
 */
export async function allowTurnoverAsk({
  assistant,
  jobs,
  repoDir = "",
  project = "",
  mainBranch = null,
  key = "",
  branch = "",
  rowId = null,
  prompt = "",
  todos = [],
  remember = null,
} = {}) {
  if (!jobs || typeof jobs.cutTurnoverTreeFor !== "function") {
    return { ok: false, error: "this panel cannot cut a turnover tree" };
  }
  const made = await jobs.cutTurnoverTreeFor({
    repoDir,
    project,
    branch,
    base: String(mainBranch || "main").trim() || "main",
    mainBranch: mainBranch || null,
    key,
  });
  if (!made?.ok) return { ok: false, made, error: String(made?.error || `the feature's turnover tree could not be cut`) };
  if (typeof remember === "function") {
    try {
      await remember(made.branch || branch, key);
    } catch (e) {
      // A list that could not be written must not stop the child: the container stands, and the next cut for the key
      // asks again rather than the card doing nothing.
      return { ok: false, made, error: `the container ${made.branch || branch} was cut, but the project's list did not take it: ${String((e && e.message) || e)}` };
    }
  }
  const started = await resumeRowAfterAsk({ assistant, rowId, project, prompt, todos });
  return { ok: Boolean(started.ok), made, started, error: started.ok ? "" : started.error || "" };
}
