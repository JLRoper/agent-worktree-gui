// Where a run's work actually is — one answer, read by every guard that used to guess from `ownerPath`.
//
// A job carries three paths:
//   cwd          the directory the turn was handed (`…/.worktrees/<name>`, or a subdirectory of it)
//   worktreePath the tree the panel CUT for the run
//   ownerPath    the tree the card is filed under
//
// The three agree in the normal case and disagree exactly when something went wrong. Job 24695761 is the case this
// module exists for: its cwd was `.../.worktrees/take-the-surface-the-task-brief-names-856f1f`, the board had no row
// for that tree, and the attach fallback wrote the project's own checkout — the folder that CONTAINS the tree — into
// `ownerPath`. Every guard that asked "which tree is this run in" with
// `ownerPath || cwd` then answered the project's own checkout: the card was filed on the main row, a merge in
// flight on the main checkout would have matched it, the leftover sweep would have read the reader's own dirty
// files as the worker's, and the row's "safe to remove" arithmetic was about a tree the run was never in.
//
// So the rule is: the run's OWN DIRECTORY decides, and a `.worktrees/<name>` directory names the tree at that path no
// matter what the owner record says. `ownerPath` is only believed when it is the tree a subdirectory belongs to
// (a `SPAWN IN …/lib` is still the tree) — it is never believed when it is an ancestor of a run sitting in a
// worktree of it, because that is a parent row, and the card does not belong there.
//
// The resolve step below is the other half: a run whose tree has no ROW is matched against `git worktree list`, so
// the card attaches to the real tree (creating the row) instead of falling to the unattached list.

const norm = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
const key = (p) => norm(p).toLowerCase();

/** A path as the board stores it: forward slashes, no trailing separator. */
export function cleanPath(p) {
  return norm(p);
}

/** Is `child` the same directory as `parent`, or inside it? Case-insensitive, separator-normalised. */
export function isInsidePath(parent, child) {
  const p = key(parent);
  const c = key(child);
  if (!p || !c) return false;
  return c === p || c.startsWith(`${p}/`);
}

/**
 * The worktree a directory names when it sits inside a `.worktrees` folder: `<checkout>/.worktrees/<name>`.
 * Null for every other path. This is the panel's own layout (lib/jobs.js cuts there, and so does every spawn), so a
 * cwd under it is the tree itself even when the tree's row has not been written yet.
 */
export function worktreeRootIn(dir) {
  const m = /^(.*?)\/\.worktrees\/([^/]+)(?:\/|$)/i.exec(norm(dir));
  return m ? `${m[1]}/.worktrees/${m[2]}` : null;
}

/**
 * The tree a run's work is in. cwd first, because that is the directory the turn was actually handed; the owner
 * record can be a parent row and must not win over it. See the header for the case this rule is written for.
 */
export function jobTreePath(job = {}) {
  const cwd = norm(job.cwd);
  const owner = norm(job.ownerPath);
  const cut = norm(job.worktreePath);
  const root = worktreeRootIn(cwd);
  if (root) return root;
  // A cwd that is not itself a tree (a subdirectory — SPAWN IN …/lib) belongs to the tree the owner names.
  if (owner && cwd && isInsidePath(owner, cwd)) return owner;
  return cwd || cut || owner || null;
}

/**
 * The tree the CARD is filed under. This is the recorded owner, EXCEPT that an owner which merely contains a run
 * sitting in `.worktrees/<name>` is replaced by that tree: the same fact as jobTreePath, expressed for the field the
 * page files by. A deliberate re-point to a sibling tree is left alone — the rule is about parent rows, not about
 * the reader's own choice.
 */
export function filedOwnerPath(job = {}) {
  const owner = norm(job.ownerPath);
  if (!owner) return null; // nothing was recorded, so nothing is claimed: an unattached card stays unattached
  const run = jobTreePath(job);
  if (run && worktreeRootIn(run) && key(owner) !== key(run) && isInsidePath(owner, run)) return run;
  return owner;
}

/** The project whose checkout contains `dir` — the longest matching path, or null. */
export function projectForTree(dir, projects = []) {
  const want = key(dir);
  if (!want) return null;
  let best = null;
  for (const project of Array.isArray(projects) ? projects : []) {
    const root = key(project?.path);
    if (!root) continue;
    if (want !== root && !want.startsWith(`${root}/`)) continue;
    if (!best || root.length > key(best.path).length) best = project;
  }
  return best;
}

/**
 * Which row a job's tree should land on, asked of git when the board has no row for it.
 *
 * `listWorktrees(projectPath)` is the same `git worktree list` the scanner reconciles from (lib/project.js). One
 * match is the tree, several are an ambiguity this refuses honestly, and none keeps the job unattached rather than
 * inventing a row. Everything is a READ: adopting the row is the caller's act.
 *
 * Returns `{ ok, path, project, how, why }`.
 */
export async function resolveJobTree({ job = {}, projects = [], listWorktrees = null } = {}) {
  const wanted = jobTreePath(job);
  if (!wanted) return { ok: false, path: null, project: null, how: null, why: "the run recorded no directory" };
  const project = projectForTree(wanted, projects);
  if (!project) {
    return { ok: false, path: null, project: null, how: null, why: `${wanted} is not inside any project the board knows` };
  }
  if (typeof listWorktrees !== "function") {
    return { ok: false, path: null, project, how: null, why: "this panel has no worktree reader" };
  }
  let listed = [];
  try {
    listed = (await listWorktrees(project.path)) || [];
  } catch (e) {
    return { ok: false, path: null, project, how: null, why: `git worktree list failed for ${project.name}: ${String((e && e.message) || e)}` };
  }
  const roots = listed.map((t) => norm(t?.path)).filter(Boolean);
  // A run inside `.worktrees/<name>` is in THAT tree or in nothing. `git worktree list` also names the project's own
  // checkout, which CONTAINS the wanted path, so a deepest-prefix match would answer the checkout — the parent-row
  // lie this module exists to prevent, arriving through the back door.
  const root = worktreeRootIn(wanted);
  if (root) {
    const at = roots.find((r) => key(r) === key(root));
    if (!at) {
      return {
        ok: false,
        path: null,
        project,
        how: null,
        why: `git worktree list for ${project.name} does not name a tree at ${root}`,
        listed: roots.length,
      };
    }
    return { ok: true, path: at, project, how: "worktree-list", why: "", listed: roots.length };
  }
  // The deepest listed tree that contains the run's directory is the tree it is in. An exact match is depth-max by
  // construction; a subdirectory resolves to the tree above it.
  let hit = null;
  for (const listedRoot of roots) {
    if (!isInsidePath(listedRoot, wanted)) continue;
    if (!hit || listedRoot.length > hit.length) hit = listedRoot;
  }
  if (!hit) {
    return {
      ok: false,
      path: null,
      project,
      how: null,
      why: `git worktree list for ${project.name} does not name a tree at ${wanted}`,
      listed: roots.length,
    };
  }
  return { ok: true, path: hit, project, how: key(hit) === key(wanted) ? "worktree-list" : "worktree-list-subdir", why: "", listed: roots.length };
}

/**
 * What an attach press means for one job and one asked path.
 *
 *   allow    — the reader is re-pointing the card at a tree of its own choosing, or the run is not in a worktree at
 *              all; the asked path is used as it stands.
 *   redirect — the asked path CONTAINS the run's own `.worktrees/<name>` tree (the parent-row fallback). The real
 *              tree is returned, so the caller can create/claim its row and file the card there.
 *   refuse   — the asked path is the parent of a run sitting in a worktree git does not list (or `ok:false` from
 *              `resolveJobTree`): there is no real row to claim, so the press must say the row is missing rather
 *              than quietly file the card on the checkout.
 */
export function attachMeaning({ job = {}, asked = "", resolved = null } = {}) {
  const run = jobTreePath(job);
  const root = worktreeRootIn(run);
  if (!root) return { action: "allow", path: norm(asked), why: "" };
  if (!isInsidePath(asked, root)) return { action: "allow", path: norm(asked), why: "" };
  if (resolved?.ok) {
    const path = norm(resolved.path);
    return { action: key(path) === key(asked) ? "allow" : "redirect", path, why: "" };
  }
  return {
    action: "refuse",
    path: null,
    why:
      `the row for ${root} is missing — the run's directory is inside that worktree, ` +
      `${norm(asked) || "the project checkout"} is only the checkout that contains it, and ${resolved?.why || "git does not list the tree"}`,
  };
}
