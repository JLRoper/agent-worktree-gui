// The names a round gives its own trees, read from the queue task that cut them.
//
// WHY. The chart's row title came from the reader's browser (`state.treeNames`, localStorage `wtgui.treenames`)
// and then from the agent's own title. A round's parent tree has no worker in it when it is cut, and a stage
// child's agent names itself from the work it did, not from the document that sent it, so a fresh browser has
// nothing to draw and the row falls back to the directory name. The queue task knows: `pipelineRun.round` names
// the parent cut and `pipelineRun.trees` names every stage child, and both were written at the cut with the
// display `stageTreeName` derived. This module is that READ - tasks in, one name per tree out.
//
// PURE. No clock, no file, no state: the server collects the tasks from every assistant's queue in snapshot() and
// stamps the answer onto each row as `row.round` (server.js `withRoundNames` / `rowExtras`, so both the snapshot and a
// live `row` frame carry it); the page paints `row.round.display` (public/app.js, `treeTitleOf`). A tree a record
// names with no display at all answers `display: null`, and the page then paints the directory name - a fact about
// the disk, not a name somebody typed into one browser.
import { stageDisplayName } from "./stage-tree-name.js";

const text = (value) => (typeof value === "string" ? value.trim() : "");
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
// The same key the panel uses for a tree everywhere else: separators to `/`, no trailing slash, case folded.
// Exported because the row overlay in server.js must look a tree up with the SAME key this map was built with; two
// copies of this line would let a `\` or a trailing `/` put a name on the wrong row.
export const roundTreeKey = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const norm = roundTreeKey;
const whole = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// One entry per tree, keyed by the normalised path a row carries. The NEWEST task wins when two records name one
// tree: a requeued row is the current owner, and a tree's name should follow the row that is driving it now.
//
// A round's parent is `pipelineRun.round.parentPath`; a record written before parent trees existed has no
// `parentPath`, and its `pipelineRun.tree` (or the task's `worktree`) is the one tree the round began in - read it
// as the parent rather than dropping the name. Every stage child comes from `pipelineRun.trees`, with the display
// the cut wrote, or - for a record that carries the stage's own words and position but no display - the same
// `Stage <n>: <name>` words `stageTreeName` would have written.
//
// `parentPath` on an entry is the GROUPING, and it is read from the same record as the name for the same reason: the
// chart's edge used to arrive only with a scanned row (`row.parent`, from the parent book through lib/scan.js), so a
// row discovered at boot carried no edge until its scan landed - and a stage tree the parent book never recorded had
// none at all - while the name was overlaid on every snapshot. A round's parent tree has no parent (it is a sibling
// of the checkout's own row); every stage child hangs under the round's parent tree. A tree that records its own
// `parentPath` wins over the round's: a re-homed stage keeps the edge its cut wrote.
export function roundTreeNames(tasks = []) {
  const out = new Map();
  const put = (path, entry) => {
    const key = norm(path);
    if (!key) return;
    const prev = out.get(key);
    // Unknown ids (a hand-written record) never displace a record the panel can date; equal ids keep the first,
    // which is the parent entry a task writes before its children.
    if (prev && prev.taskId != null && entry.taskId == null) return;
    if (prev && entry.taskId != null && prev.taskId != null && entry.taskId <= prev.taskId) return;
    out.set(key, entry);
  };
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const run = isObject(task && task.pipelineRun) ? task.pipelineRun : null;
    const round = run && isObject(run.round) ? run.round : null;
    // Only a round names its trees. A task with a pipeline and no round is the default path, whose tree is named
    // by the row it stands on; stamping the task title there would rename a tree nobody asked about.
    if (!round) continue;
    const title = text(task.title);
    const taskId = Number.isFinite(Number(task.id)) && Number(task.id) > 0 ? Number(task.id) : null;
    const parentPath = text(round.parentPath) || text(run.tree && run.tree.path) || text(task.worktree);
    const roundPath = text(round.parentPath) || null;
    put(parentPath, {
      display: title || text(round.display) || text(round.slug) || null,
      role: "parent",
      stage: null,
      position: null,
      parentPath: null,
      taskId,
      title: title || null,
    });
    const trees = isObject(run.trees) ? run.trees : {};
    for (const [stageId, tree] of Object.entries(trees)) {
      if (!isObject(tree)) continue;
      const position = whole(tree.position);
      // A child's words are DERIVED from its stage name and its position, which is what the cut recorded beside the
      // name it used (`stageTreeName` returns `stageName` and `position` for exactly this read). The stored `display`
      // is the fallback for a record written before those two fields existed - the same words, but read from the
      // name the cut wrote rather than recomputed.
      const display = stageDisplayName({ position, name: tree.stageName }) || text(tree.display) || null;
      put(tree.path, {
        display,
        role: "stage",
        stage: text(stageId) || null,
        position,
        parentPath: text(tree.parentPath) || roundPath,
        taskId,
        title: title || null,
      });
    }
  }
  return out;
}
