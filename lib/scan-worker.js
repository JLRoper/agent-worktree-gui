// Worker thread: one git scan per message, off the main thread.
//
// The git children this thread starts are REAL processes owned by the panel, and terminating this thread
// does not touch them: Node stops the JS, the child keeps running. So the worker keeps its own registry
// (which enforces each call's deadline and kills the tree at it) and reports every pid up to the pool,
// which adopts it into the panel's own list. A scan that times out, or a pool that closes, then kills the
// git the worker left behind.
import { parentPort } from "node:worker_threads";
import { scanWorktree, setChildTracker } from "./scan.js";
import { ChildTree, scopeForScan } from "./child-tree.js";

let currentScan = null;

const children = new ChildTree({
  // Up to the pool: it owns the kill list the panel's settle and shutdown walk.
  onTrack: (entry) => {
    try {
      parentPort.postMessage({ type: "child", scanId: currentScan, pid: entry.pid, label: entry.label });
    } catch {
      /* the port is gone: the thread is being torn down */
    }
  },
  onDone: (entry) => {
    try {
      parentPort.postMessage({ type: "child-done", pid: entry.pid });
    } catch {
      /* the port is gone */
    }
  },
});
setChildTracker(children, scopeForScan("worker"));

parentPort.on("message", async (msg) => {
  currentScan = msg.id ?? null;
  const scope = scopeForScan(currentScan);
  // The tracker's scope is per scan, so this scan's kills cannot reach another scan's git.
  setChildTracker(children, scope);
  // A project's meta and its worktree registry, off the loop that answers requests. Both ride back in one frame so
  // the caller's reconcile does not repeat the `worktree list` the meta job already paid for.
  if (msg.kind === "meta") {
    try {
      const { projectMeta, worktreeList } = await import("./project.js");
      const [meta, trees] = await Promise.all([projectMeta(msg.project), worktreeList(msg.project.path)]);
      parentPort.postMessage({ id: msg.id, ok: true, result: { meta, trees } });
    } catch (e) {
      parentPort.postMessage({ id: msg.id, ok: false, error: String((e && e.message) || e) });
    } finally {
      children.killScope(scope, "the meta job ended");
      currentScan = null;
    }
    return;
  }
  try {
    const row = await scanWorktree(msg.wtPath, msg.ctx || {}, msg.depth || "fast");
    parentPort.postMessage({ id: msg.id, ok: true, row });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, ok: false, error: String((e && e.message) || e) });
  } finally {
    // A scan that ended has no children left by construction (every call is awaited), but a rejected one
    // can have raced its own kill: sweep the scope so the panel's list and the thread's agree.
    children.killScope(scope, "the scan ended");
    currentScan = null;
  }
});
