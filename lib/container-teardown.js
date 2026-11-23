// Containers a run started are the panel's to clean up, not the worker's to remember.
//
// A turn ends; what it started does not. The panel already supervises PROCESSES - lib/child-tree.js kills a run's
// helper tree at its settle - and a container is the one thing that walks out of that scope: it belongs to the
// Docker daemon, not to the run's process tree, so `docker run -d` outlives the shell that made it by design.
//
// THE CONVENTION IS TWO LABELS and nothing else about how a container is named. The panel's own docker usage stays
// where it is: lib/merge-prompt.js asks a merge run for `docker compose -p wtgui-merge-<stamp>` and tears that
// project down with `docker compose down`, and this file does not rename it or add a second pattern beside it. A
// name is for the reader; a LABEL is what the panel can read back, so this is the half that makes a container
// findable whoever created it and whatever the project was called:
//
//   wag.worktree=<the tree's absolute path, forward slashes, no trailing slash>   <- the teardown key
//   wag.row=<the queue row it is working for, digits only>                        <- for the reader, never the key
//
// A container with the tree label and no row label is still found and still removed; the row is only what a refusal
// prints so a person can see whose container it is.
//
// THREE READERS, and each one is a function below:
//   * the SETTLE (lib/jobs.js's one call): every container carrying an ENDING tree's label is stopped and removed,
//     unless another live run is still in that tree (the tree is not ending while a sibling is in it);
//   * the PANEL ACTION (routes/containers.js): the same teardown on demand, for a tree somebody names;
//   * the CLOSE GATE (lib/assistant.js's queue `state` door): a row whose tree still has a labelled container
//     RUNNING is refused, unless the close reason names it and says why it is kept.
//
// WHAT IT CANNOT DO, stated so nobody reads a green proof as a lock: a container started without the label is
// invisible here, and that is why the brief paragraph (containerBriefFor) is half of the feature - the label is
// written where the container is created, or not at all. A daemon that is down fails OPEN at the close gate (a
// close is never blocked by a docker that cannot answer) and is a LOG LINE at the settle, remembered for a minute
// so a down daemon does not cost a process spawn per turn.
//
// Everything here is keyed on the panel's ONE tree spelling (lib/push-guard.js normTree): forward slashes, no
// trailing slash, lower case, and the MSYS `/c/...` form folded onto the drive-letter one. Two spellings of one tree
// would be two keys, and the label match would silently miss the container it was meant to find.
import { execFile, execFileSync } from "node:child_process";

import { normTree } from "./push-guard.js";

export const LABEL_TREE = "wag.worktree";
export const LABEL_ROW = "wag.row";

/** The route the refusal points at, kept here so the sentence and the mount cannot drift apart. */
export const TEARDOWN_TREE_ACTION = "POST /api/containers/teardown";

// A daemon call is local; 8 s is a ceiling for a wedged Desktop VM, never a wait anybody should see.
export const DOCKER_TIMEOUT_MS = 8_000;
// The gate runs on a synchronous door (a queue write), so it carries a tighter ceiling.
export const DOCKER_SYNC_TIMEOUT_MS = 4_000;
// How long a failing daemon is remembered. Long enough that a turn loop does not spawn `docker` per settle, short
// enough that starting Docker Desktop is noticed within a minute.
export const DAEMON_BACKOFF_MS = 60_000;

let daemonDownUntil = 0;
let daemonDownWhy = "";

const nowMs = () => Date.now();
const firstLine = (text) => String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] || "";
const shortId = (id) => String(id || "").slice(0, 12);

/** The label VALUE for a tree: absolute, forward slashes, no trailing slash. Case is left as the caller wrote it. */
export function labelTree(tree) {
  return String(tree ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Whether two spellings name the same tree, by the panel's one spelling. */
export function sameTree(a, b) {
  const one = normTree(a);
  return Boolean(one) && one === normTree(b);
}

/** Remember a daemon that will not answer, and say whether this was the first failure of the window. */
export function noteDaemonDown(error, now = nowMs()) {
  const fresh = now >= daemonDownUntil;
  if (fresh) daemonDownUntil = now + DAEMON_BACKOFF_MS;
  daemonDownWhy = firstLine(error) || "docker did not answer";
  return fresh;
}

/** Is the daemon still inside the window a failure opened? */
export function daemonDown(now = nowMs()) {
  return now < daemonDownUntil;
}

/** Why the daemon is being skipped (for a log line or a route's error). */
export function daemonDownReason() {
  return daemonDownWhy;
}

/** Test seam: forget a remembered failure (the real daemon came back, a probe wants a fresh read). */
export function resetDaemonState() {
  daemonDownUntil = 0;
  daemonDownWhy = "";
}

/**
 * `docker inspect` output -> the containers this panel cares about.
 *
 * The daemon prints an array; every field is read defensively because this is another program's JSON. An entry with
 * no Id is dropped: an id is the only thing that can be stopped or removed, so an entry without one is not a
 * container this module can act on.
 */
export function parseInspect(text) {
  let list;
  try {
    list = JSON.parse(String(text || ""));
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .map((rec) => {
      const labels = (rec && rec.Config && rec.Config.Labels) || {};
      return {
        id: String(rec?.Id || ""),
        name: String(rec?.Name || "").replace(/^\//, ""),
        running: rec?.State?.Running === true,
        tree: String(labels[LABEL_TREE] || ""),
        row: String(labels[LABEL_ROW] || ""),
      };
    })
    .filter((c) => c.id);
}

/** The containers whose tree label is this tree, in the panel's spelling. A sibling path is not this tree. */
export function labelledFor(containers, tree) {
  const want = normTree(tree);
  if (!want) return [];
  return (containers || []).filter((c) => normTree(c.tree) === want);
}

/**
 * What a teardown would do, decided before anything is touched: running ones are stopped, every matched one is
 * removed, and nothing outside the match is named at all.
 */
export function teardownPlan(containers, tree) {
  const matched = labelledFor(containers, tree);
  const stop = matched.filter((c) => c.running).map((c) => c.id);
  const remove = matched.map((c) => c.id);
  return { matched, stop, remove };
}

const givesName = (reason, c) => {
  const said = String(reason || "").toLowerCase();
  const name = String(c.name || "").toLowerCase();
  const id = String(c.id || "").toLowerCase();
  if (name && said.includes(name)) return true;
  if (!id) return false;
  return said.includes(id) || (id.length > 12 && said.includes(shortId(id)));
};

// What is left of a reason once the container names and ids are taken out of it. "web-269" is a name; "kept
// web-269 for the demo" says why. A word shorter than two characters is punctuation or an article, not a reason.
const wordingLeft = (reason, containers) => {
  let said = String(reason || "").toLowerCase();
  for (const c of containers) {
    for (const token of [c.name, c.id, shortId(c.id)]) {
      if (token) said = said.split(String(token).toLowerCase()).join(" ");
    }
  }
  return said
    .split(/[^a-z0-9]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2).length;
};

/**
 * The close gate's decision, pure: null when the close may go through, or the sentence that refuses it.
 *
 * A row closes only when its tree has no labelled container RUNNING, or when the reason names every running one and
 * says something beyond the names. A stopped container is not a reason to refuse: it is not holding a port, and the
 * settle teardown removes it on the next run anyway.
 */
export function closeRefusal({ task = null, reason = "", containers = [], tree = null } = {}) {
  const target = tree || task?.worktree || "";
  const running = labelledFor(containers, target).filter((c) => c.running);
  if (!running.length) return null;
  const unnamed = running.filter((c) => !givesName(reason, c));
  const wording = wordingLeft(reason, running);
  if (!unnamed.length && wording >= 1) return null;
  const who = running
    .map((c) => `${c.name || shortId(c.id)}${c.row ? ` (row ${c.row})` : ""}`)
    .join(", ");
  const many = running.length === 1 ? "" : "s";
  const label = `#${task?.id ?? "this row"}`;
  if (unnamed.length) {
    return (
      `${label} cannot close while ${running.length} labelled container${many} still run${running.length === 1 ? "s" : ""}: ${who}. ` +
      `Stop and remove ${running.length === 1 ? "it" : "them"} first (${TEARDOWN_TREE_ACTION} with {"tree": "${labelTree(target)}"}), ` +
      `or name ${running.length === 1 ? "it" : "every one of them"} in the reason, with why it is kept.`
    );
  }
  return (
    `${label} names ${running.length === 1 ? "the container" : "the containers"} (${who}) but not why ${running.length === 1 ? "it is" : "they are"} kept. ` +
    `Add the reason to the close sentence, or stop and remove ${running.length === 1 ? "it" : "them"} first (${TEARDOWN_TREE_ACTION} with {"tree": "${labelTree(target)}"}).`
  );
}

/** The paragraph a tree run's brief carries. It is the write half of the whole feature: no label, no teardown. */
export function containerBriefFor({ tree = "", row = null } = {}) {
  const value = labelTree(tree) || "<your tree's absolute path>";
  const digits = String(row ?? "").replace(/[^0-9]/g, "");
  const rowValue = digits || "<the queue row this brief names, digits only>";
  return [
    "CONTAINERS - a container you start outlives your turn, so it has to be findable without you: every container you start carries the panel's two labels, and every `docker run` starts it with `--rm`.",
    `  docker run -d --rm --label wag.worktree=${value} --label wag.row=${rowValue} ...`,
    "`wag.worktree` is the teardown key: this run's tree, absolute, forward slashes, no trailing slash. `wag.row` is the queue row you are working for (digits; leave it off a run with no row). A `docker compose` service carries the same two labels in its `labels:` block - the panel reads labels, not names or compose project names, so a name alone is invisible to it.",
    "The panel stops and removes every container carrying your tree's label when this run settles, and it refuses to close your row while one is still running unless the close reason names it and says why it is kept. `--rm` is the habit; the label is the contract.",
  ].join("\n");
}

/** The real runner: one `docker` call, never a shell string. Resolves an object so callers never catch a spawn error. */
export function runDocker(args, { timeout = DOCKER_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile("docker", args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) {
        const said = firstLine(stderr) || firstLine(err.message) || "docker failed";
        resolve({ ok: false, error: said, timedOut: Boolean(err.killed) });
        return;
      }
      resolve({ ok: true, out: String(stdout || "") });
    });
  });
}

/** The synchronous runner the close gate needs: the queue write is a synchronous door and has to decide now. */
export function runDockerSync(args, { timeout = DOCKER_SYNC_TIMEOUT_MS } = {}) {
  try {
    const out = execFileSync("docker", args, { timeout, windowsHide: true, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out: String(out || "") };
  } catch (e) {
    const said = firstLine(e?.stderr ? String(e.stderr) : "") || firstLine(e?.message) || "docker failed";
    return { ok: false, error: said, timedOut: Boolean(e?.killed) };
  }
}

const psArgs = (all) => ["ps", ...(all ? ["-a"] : []), "-q", "--filter", `label=${LABEL_TREE}`];

/**
 * Every labelled container the daemon has, or only the running ones.
 *
 * TWO CALLS: `docker ps` names the ids that carry the label key, and `docker inspect` reads the label VALUES and the
 * running state. `docker ps --format` can print a label in newer daemons, but a format this module has to trust per
 * version is a silent empty answer on the one version it is wrong on; inspect is the same on every daemon.
 */
export async function listLabelled({ run = runDocker, all = true } = {}) {
  const ps = await run(psArgs(all));
  if (!ps.ok) return { ok: false, error: ps.error || "docker ps failed", containers: [] };
  const ids = String(ps.out || "").split(/\s+/).filter(Boolean);
  if (!ids.length) return { ok: true, containers: [] };
  const inspected = await run(["inspect", ...ids]);
  if (!inspected.ok) return { ok: false, error: inspected.error || "docker inspect failed", containers: [] };
  return { ok: true, containers: parseInspect(inspected.out) };
}

/** The same read, synchronously, for the close gate. */
export function listLabelledSync({ runSync = runDockerSync, all = false } = {}) {
  const ps = runSync(psArgs(all));
  if (!ps.ok) return { ok: false, error: ps.error || "docker ps failed", containers: [] };
  const ids = String(ps.out || "").split(/\s+/).filter(Boolean);
  if (!ids.length) return { ok: true, containers: [] };
  const inspected = runSync(["inspect", ...ids]);
  if (!inspected.ok) return { ok: false, error: inspected.error || "docker inspect failed", containers: [] };
  return { ok: true, containers: parseInspect(inspected.out) };
}

/**
 * Stop and remove every container carrying this tree's label, then READ THE DAEMON BACK and report what is left.
 *
 * The read-back is the point: "docker rm" answering 0 is a successful call, not a removed container, and the one
 * container that survives (a restart policy, a wedged daemon) is exactly the one the reader has to know about.
 */
export async function teardownTree(tree, { run = runDocker, log = () => {}, now = nowMs } = {}) {
  const target = labelTree(tree);
  const out = { ok: false, tree: target, containers: [], stopped: [], removed: [], left: [], error: null };
  if (!normTree(target)) {
    out.error = "a tree path is required - the teardown key is wag.worktree=<the tree>";
    return out;
  }
  if (daemonDown(now())) {
    out.error = `docker is not answering: ${daemonDownReason() || "unknown error"}`;
    return out;
  }
  const found = await listLabelled({ run });
  if (!found.ok) {
    if (noteDaemonDown(found.error, now())) log(`containers: ${found.error} - teardown for ${target} skipped for a minute`);
    out.error = found.error;
    return out;
  }
  const plan = teardownPlan(found.containers, target);
  out.containers = plan.matched.map((c) => ({ id: c.id, name: c.name, running: c.running, row: c.row }));
  if (!plan.matched.length) return { ...out, ok: true };
  const nameOf = (id) => {
    const hit = plan.matched.find((c) => c.id === id);
    return hit ? hit.name || shortId(hit.id) : shortId(id);
  };
  if (plan.stop.length) {
    const stopped = await run(["stop", ...plan.stop]);
    if (!stopped.ok && !/no such container/i.test(stopped.error || "")) {
      out.error = `docker stop failed: ${stopped.error}`;
      log(`containers: teardown for ${target} could not stop ${plan.stop.length} container(s): ${stopped.error}`);
      return out;
    }
    out.stopped = plan.stop.map(nameOf);
  }
  const removed = await run(["rm", "-f", ...plan.remove]);
  if (!removed.ok && !/no such container/i.test(removed.error || "")) {
    out.error = `docker rm failed: ${removed.error}`;
    log(`containers: teardown for ${target} could not remove ${plan.remove.length} container(s): ${removed.error}`);
    return out;
  }
  out.removed = plan.remove.map(nameOf);
  const after = await listLabelled({ run });
  if (!after.ok) {
    // The removal was asked for and answered; only the proof is missing. Say that plainly instead of claiming it.
    out.error = `containers were removed but the read-back failed: ${after.error}`;
    out.left = [];
    log(`containers: teardown for ${target} could not read back: ${after.error}`);
    return out;
  }
  const alive = new Set(after.containers.map((c) => c.id));
  out.left = plan.matched.filter((c) => alive.has(c.id)).map((c) => c.name || shortId(c.id));
  out.ok = out.left.length === 0;
  if (!out.ok) out.error = `${out.left.length} container(s) survived the teardown: ${out.left.join(", ")}`;
  log(
    `containers: ${target}: stopped ${out.stopped.length}, removed ${out.removed.length}${out.left.length ? `, LEFT ${out.left.join(", ")}` : ""}`,
  );
  return out;
}

/**
 * The settle's door. A tree that still has a live run in it is not an ENDING tree: a sibling turn is still working
 * there and its containers are its own, so the teardown waits for the settle that ends the last run.
 */
export async function teardownSettledTree({ tree = null, liveInTree = false, run = runDocker, log = () => {}, now = nowMs } = {}) {
  const target = labelTree(tree);
  if (!normTree(target)) return null;
  if (liveInTree) {
    log(`containers: ${target} still has a live run in it - its labelled containers stay`);
    return null;
  }
  try {
    return await teardownTree(target, { run, log, now });
  } catch (e) {
    log(`containers: teardown for ${target} threw: ${String((e && e.message) || e)}`);
    return null;
  }
}

/**
 * The close gate's door: a synchronous read (the queue write must decide now), the pure refusal, and a daemon that
 * fails OPEN - a docker that cannot answer must never stop a reader closing a row.
 */
export function closeGate({ task = null, reason = "", tree = null, runSync = runDockerSync, log = () => {}, now = nowMs } = {}) {
  const target = tree || task?.worktree || "";
  if (!normTree(target)) return null;
  if (daemonDown(now())) return null;
  try {
    const listed = listLabelledSync({ runSync });
    if (!listed.ok) {
      if (noteDaemonDown(listed.error, now())) log(`containers: ${listed.error} - close gate for ${labelTree(target)} skipped for a minute`);
      return null;
    }
    return closeRefusal({ task, reason, containers: listed.containers, tree: target });
  } catch (e) {
    log(`containers: close gate for ${labelTree(target)} threw: ${String((e && e.message) || e)}`);
    return null;
  }
}
