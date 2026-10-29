// Taking a worktree off this disk, in the ONE place that does it.
//
// Two callers arrive here: the row's ✕ (POST /api/worktree/delete), and the answer a CHECKING agent gives when the
// branch's own change is already on the base (lib/verify-prompt.js). Every rule about WHETHER a tree may go is in
// `deleteWorktreeRow` too, so a second caller cannot arrive one guard short of the first: the reader's lock, a live
// agent in the tree, and the project's own checkout are refused here rather than in the route.
//
// The order is deliberate, and each step exists because of a bug it fixed:
//   1. the folder goes to the Windows Recycle Bin (recoverable) while git still knows the tree, so a mistaken delete
//      can be undone for as long as Windows keeps it;
//   2. `git worktree remove --force` empties the tree and drops git's own record. Its LAST step is the rmdir, and on
//      Windows that fails whenever a process still has the folder as its working directory - which a worktree
//      routinely is, because the agent that built it, an editor, or a panel started from it is still running. So
//      "failed to delete ...: Permission denied" does NOT mean the worktree survived: by then the files and the
//      record are gone and only an EMPTY folder is left. Treating that error as a failure is what left a row on the
//      board (re-read as a worktree with no branch) while the folder stayed on disk;
//   3. what git still lists is the arbiter. A tree git still reports is still real and the caller must hear a
//      failure; a tree it no longer lists is gone, and only the folder can disagree;
//   4. a folder a process still holds is retried, then kept after the answer until the holder exits - the row goes
//      either way, because it describes a worktree git no longer has.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { worktreeList } from "./project.js";
import { isLiveJobStatus } from "./jobs.js";

const execP = promisify(execFile);

export const cleanPath = (p) => String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const stillThere = (target) => stat(target).then((s) => s.isDirectory()).catch(() => false);

// Whether a path is the panel's own working directory, or inside it: a panel started from a worktree cannot delete
// that worktree while it runs, and "restart the panel" is the only useful thing to say.
export function holdsCwd(target, cwd) {
  const a = cleanPath(target).toLowerCase();
  const b = cleanPath(cwd).toLowerCase();
  return Boolean(b) && (b === a || b.startsWith(`${a}/`));
}

async function removeDirNow(target) {
  try {
    await rm(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  } catch {
    /* held open - the check below is the answer */
  }
  return !(await stillThere(target));
}

function retryDirCleanup(target, { everyMs = 5_000, forMs = 10 * 60_000, onLog = () => {} } = {}) {
  const until = Date.now() + forMs;
  const tick = async () => {
    if (await removeDirNow(target)) {
      onLog(`worktree cleanup: removed the leftover folder ${target}`);
      return;
    }
    if (Date.now() < until) setTimeout(tick, everyMs).unref();
    else onLog(`worktree cleanup: gave up on ${target} - a process still holds it`);
  };
  setTimeout(tick, everyMs).unref();
}

// The filesystem/git half, with no opinion about whether it was allowed: the caller has decided that. Returns the
// facts the response body and the card are built from, and never throws for a removal that half-happened.
export async function removeWorktreeDir({ projectPath, target, platform = process.platform, onLog = () => {} } = {}) {
  const projectDir = String(projectPath || "").trim();
  const tree = path.resolve(String(target || "").trim());
  if (!projectDir || !tree) return { ok: false, status: 400, error: "projectPath and target are required" };

  // Recycle first: a mistaken click is recoverable from the Recycle Bin for as long as Windows keeps it.
  // `git worktree remove --force` is the fallback when the shell cannot reach the Recycle Bin.
  const psCommand =
    "Add-Type -AssemblyName Microsoft.VisualBasic; " +
    `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${tree.replace(/'/g, "''")}','OnlyErrorDialogs','SendToRecycleBin')`;
  // Recorded before anything is deleted: the response should say whether this call removed a directory or merely
  // cleaned up the panel's record of one that was already gone.
  const hadDirectory = await stillThere(tree);
  let recycled = false;
  let recycleError = null;
  if (platform === "win32" && hadDirectory) {
    try {
      await execP("powershell", ["-NoProfile", "-NonInteractive", "-Command", psCommand], { timeout: 90_000, windowsHide: true });
      recycled = !(await stillThere(tree));
      if (!recycled) recycleError = "the Recycle Bin refused it - the directory is still there";
    } catch (e) {
      recycleError = String((e && e.message) || e);
    }
  }
  let gitError = null;
  if (await stillThere(tree)) {
    try {
      await execP("git", ["-C", projectDir, "worktree", "remove", "--force", tree], { timeout: 90_000, windowsHide: true });
    } catch (e) {
      gitError = String((e && e.message) || e);
    }
  }
  await execP("git", ["-C", projectDir, "worktree", "prune"], { timeout: 30_000, windowsHide: true }).catch(() => {});

  const listing = await worktreeList(projectDir).catch(() => null);
  const stillRegistered = listing ? listing.some((w) => path.resolve(w.path) === tree) : null;
  if (stillRegistered === true) {
    // git never let go of it: the worktree is still real, so the row has to stay and the caller has to hear a
    // failure rather than a claim of deletion.
    const why = String(gitError || "git still lists it").trim().split("\n").filter(Boolean).pop();
    return { ok: false, status: 500, error: `could not remove the worktree: ${why}`, recycled, recycleError, gitError, stillRegistered };
  }
  const heldOpen = /failed to delete|Permission denied|being used by another process|EBUSY|EPERM/i.test(String(gitError || ""));
  if (stillRegistered === null && (await stillThere(tree)) && gitError && !heldOpen) {
    // git's listing could not be read AND its removal failed for some other reason: nothing here proves the
    // worktree is gone, so do not pretend it is.
    return { ok: false, status: 500, error: `could not remove the worktree: ${gitError}`, recycled, recycleError, gitError, stillRegistered };
  }

  // Only the folder can disagree now. An empty leftover goes at once; one a process still holds is retried here,
  // then kept after the response until the holder exits - the row goes either way, because it describes a worktree
  // git no longer has.
  let dirLeft = await stillThere(tree);
  for (let i = 0; dirLeft && i < 4; i += 1) {
    dirLeft = !(await removeDirNow(tree));
    if (dirLeft) await sleepMs(600);
  }
  if (dirLeft) retryDirCleanup(tree, { onLog });
  const panelHolds = dirLeft && holdsCwd(tree, process.cwd());

  return {
    ok: true,
    recycled,
    // The Recycle Bin is best effort: when it declined, say why and let the card say the files are gone permanently
    // instead of promising recoverability that does not exist.
    recycleError,
    // Files deleted, git record pruned, row dropped - and the folder itself survived because a process holds it.
    // The panel keeps trying in the background.
    dirLeft,
    panelHolds,
    path: tree,
    // The folder was already gone when this ran: say so rather than pretending we removed it.
    alreadyGone: !hadDirectory,
    gitError,
    stillRegistered,
  };
}

// The whole act for one row: the guards every caller must pass, then the removal. `jobs.list()` is the panel's own
// answer to "is an agent running in that tree"; `locks.check` is the reader's answer to "may anything delete it".
// `platform` is only ever overridden by a test: the Recycle Bin step is Windows' own act and a test that moved its
// fixture there would be filling the reader's Recycle Bin with scratch repos.
export async function deleteWorktreeRow({ project, row, target, jobs, locks, onLog = () => {}, platform = process.platform } = {}) {
  if (!project || !project.path) return { ok: false, status: 404, error: `unknown project: ${project?.name || "(none)"}` };
  if (!row) return { ok: false, status: 404, error: `no worktree row for ${target || "(no path)"} in ${project.name}` };
  const tree = path.resolve(String(target || row.path || "").trim());
  if (path.resolve(project.path) === tree) {
    return { ok: false, status: 400, error: "that is the project's own checkout, not a worktree" };
  }
  // The reader's lock, before anything is even looked at: the row's ✕, a check agent's answer, a script that found
  // this module - every one of them arrives here, and every one of them is refused with the lock named. A silent
  // no-op would read as a broken button, so this is a 409 with the whole sentence (the board banners it).
  const lock = locks?.check ? locks.check({ project: project.name, path: row.path, branch: row.branch }) : { locked: false };
  if (lock.locked) {
    onLog(`worktree delete refused for ${row.path}: ${lock.reason}`);
    return { ok: false, status: 409, error: lock.reason, lock };
  }
  const busy = (jobs?.list?.() || []).find(
    (j) => isLiveJobStatus(j.status) && [j.cwd, j.ownerPath].filter(Boolean).some((p) => path.resolve(p) === tree),
  );
  if (busy) return { ok: false, status: 409, error: `an agent is running in that worktree (${busy.id})` };

  const out = await removeWorktreeDir({ projectPath: project.path, target: tree, onLog, platform });
  if (!out.ok) return out;
  return {
    ...out,
    ok: true,
    name: row.name,
    branch: row.branch || null,
    // The key the panel and its rows use, so the browser can remove the right node. It is the STORE's path, not
    // `path.resolve()`: rows are keyed by the scanned path with forward slashes, and a resolved Windows path is a
    // different key - which is how a row survived its own deletion once already.
    rowPath: row.path,
  };
}
