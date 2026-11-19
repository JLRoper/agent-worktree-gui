// The initiatives: one tab's read, the two writes a reader or an assistant may make freely, and the one write that
// has to ask first.
//
//   GET  /api/initiatives              the store, every initiative with its projects and worktrees, and the assistants
//                                      that have worked on it (counts and recency)
//   POST /api/initiatives              { title, description } - create
//   POST /api/initiatives/update       { id, title?, description? } - edit the words only
//   POST /api/initiatives/move         { tree, initiative, action: "add"|"remove" } - PARKS A QUESTION, changes nothing
//
// WHY MEMBERSHIP IS A QUESTION AND THE WORDS ARE NOT. A title and a description are text the reader is looking at, and
// asking about a typo would be noise. Which worktrees are behind a piece of work is the reader's own map of the board,
// and no agent gets to re-file it behind his back: the move route hands the change to the panel's permission box
// (lib/remote-writes.js `request`) and the panel makes it only when the reader answers. The resume closure is where
// the store is written, so a Deny (or a box nobody answered inside its window) leaves the map exactly as it was.
//
// THE STORE IS REFUSED, NOT REPAIRED. Every write answers 409 with lib/initiatives.js's own sentence when the file
// exists and cannot be read, and the move route checks that BEFORE parking a question: a card whose answer could only
// fail is worse than no card. The read carries the same status (`readable`, `error`, `file`) so the tab can say it.
import { DESCRIPTION_MAX, TITLE_MAX, normTreePath } from "../lib/initiatives.js";

/** The one path this prefix answers, and the row the mount table in server.js matches on. */
export const INITIATIVES_PATH = "/api/initiatives";

const nameOf = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean).pop() || String(p || "");

// The instant an assistant last did something with this initiative, as ISO: a running row is "now" (it IS working),
// otherwise the newest stamp the queue keeps. Absent is a row with no clock, which sorts last and says nothing.
function lastTouched(task, nowMs) {
  if (!task) return null;
  if (task.state === "running") return new Date(nowMs).toISOString();
  const stamps = [task.doneAt, task.startedAt, task.createdAt].filter(Boolean).map((s) => String(s));
  if (!stamps.length) return null;
  stamps.sort();
  return stamps[stamps.length - 1];
}

/**
 * The whole tab's document, built from the store plus the two things only the composition root knows: which project a
 * path belongs to, and what the board's row for it says. Pure enough to run over a fixture: every seam is a function.
 */
export function initiativesView({ initiatives, projectForPath, rowFor, assistants = [], queueFor = () => null, now = Date.now() }) {
  const status = initiatives.statusOf();
  const list = initiatives.initiativeList();
  const board = assistants.map((rec) => {
    let view = null;
    try {
      view = queueFor(rec.id);
    } catch {
      view = null; // a queue that cannot be read is an empty one for this tab; its own pane still reports the error
    }
    return { rec, tasks: Array.isArray(view?.tasks) ? view.tasks : [] };
  });
  const out = list.map((init) => {
    const trees = initiatives.treesFor(init.id).map((rec) => {
      const found = projectForPath(rec.path) || null;
      const project = String(found?.name || "").trim();
      const row = project ? rowFor(project, rec.path) : null;
      return {
        key: rec.key,
        path: rec.path,
        name: String(row?.round?.display || row?.name || nameOf(rec.path)),
        branch: String(row?.branch || ""),
        project,
        // A tree that is no longer on the board (removed, or outside every scan root) still belongs to the initiative:
        // the tab shows it dimmed with its path, and the reader can take it out. Hiding it would strand the record.
        missing: !row,
        at: rec.at,
        by: rec.by,
      };
    });
    const byProject = new Map();
    for (const tree of trees) {
      const name = tree.project || "(outside every project)";
      if (!byProject.has(name)) byProject.set(name, []);
      byProject.get(name).push(tree);
    }
    const projects = [...byProject.entries()]
      .map(([name, rows]) => ({ name, trees: rows.sort((a, b) => a.name.localeCompare(b.name)) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const treeKeys = new Set(trees.map((t) => t.key));
    const people = [];
    for (const { rec, tasks } of board) {
      const mine = tasks.filter((t) => t.worktree && treeKeys.has(normTreePath(t.worktree)));
      if (!mine.length) continue;
      const counts = { queued: 0, running: 0, done: 0, parked: 0 };
      let lastAt = null;
      for (const task of mine) {
        // Four states, one pass, one queue read: queued is counted here with the other three, so the strip's first
        // chip cannot come from a second read that disagrees with the rest of it.
        if (task.state === "queued") counts.queued += 1;
        else if (task.state === "running") counts.running += 1;
        else if (task.state === "done") counts.done += 1;
        else if (task.state === "parked") counts.parked += 1;
        const at = lastTouched(task, now);
        if (at && (!lastAt || at > lastAt)) lastAt = at;
      }
      people.push({
        id: rec.id,
        name: String(rec.name || rec.id),
        thread: String(rec.threadId || ""),
        counts,
        tasks: mine.length,
        lastAt,
      });
    }
    // How recently it worked on THIS initiative: newest first, a row with no clock after the ones that have one.
    people.sort((a, b) => String(b.lastAt || "").localeCompare(String(a.lastAt || "")) || a.name.localeCompare(b.name));
    return {
      id: init.id,
      title: init.title,
      description: init.description,
      createdAt: init.createdAt,
      updatedAt: init.updatedAt,
      updatedBy: init.updatedBy,
      projects,
      projectCount: projects.length,
      treeCount: trees.length,
      assistants: people,
      assistantCount: people.length,
    };
  });
  return {
    at: new Date(now).toISOString(),
    file: status.file,
    found: status.found,
    readable: status.readable,
    error: status.error,
    caps: { title: TITLE_MAX, description: DESCRIPTION_MAX },
    initiatives: out,
  };
}

export function createInitiativesRoutes({
  initiatives,
  remoteWrites,
  getConfig,
  registry,
  store,
  assistant,
  projectForPath,
  sendJson,
  readBody,
  authorised,
  // Called after a write the tab should see at once (create, edit, an answered move): the composition root invalidates
  // the board snapshot and broadcasts it, so a chart chip appears the moment a membership changes rather than on the
  // next unrelated repaint. Defaulted so a fixture can drive the routes without a server.
  onChange = () => {},
  log = () => {},
} = {}) {
  if (!initiatives) throw new Error("createInitiativesRoutes needs the Initiatives store");
  if (!remoteWrites) throw new Error("createInitiativesRoutes needs RemoteWrites for the move question");
  if (typeof getConfig !== "function") throw new Error("createInitiativesRoutes needs getConfig from the composition root");
  if (typeof projectForPath !== "function") throw new Error("createInitiativesRoutes needs projectForPath from the composition root");
  if (typeof sendJson !== "function" || typeof readBody !== "function" || typeof authorised !== "function") {
    throw new Error("createInitiativesRoutes needs sendJson, readBody and authorised from the server's transport");
  }

  const rowFor = (project, treePath) => {
    const key = normTreePath(treePath);
    const rows = typeof store?.rowsFor === "function" ? store.rowsFor(project) || [] : [];
    return rows.find((r) => normTreePath(r.path) === key) || null;
  };
  const view = () =>
    initiativesView({
      initiatives,
      projectForPath,
      rowFor,
      assistants: Array.isArray(assistant?.assistants) ? assistant.assistants : [],
      queueFor: (id) => (typeof assistant?.queueView === "function" ? assistant.queueView(id) : null),
    });

  return async function initiativesRoutes(req, res, route, url) {
    if (route !== INITIATIVES_PATH && !route.startsWith(`${INITIATIVES_PATH}/`)) return false;
    const config = getConfig() || {};
    const params = url?.searchParams || new URL(req.url || "/", "http://127.0.0.1").searchParams;

    // One read, at the bare path: the whole document the tab draws. Every other route on this prefix is a write.
    if (req.method === "GET") {
      if (route !== INITIATIVES_PATH) {
        sendJson(res, 405, { error: `GET is not allowed on ${route}` });
        return true;
      }
      sendJson(res, 200, view());
      return true;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: `${req.method} is not allowed on ${route}` });
      return true;
    }
    if (!authorised(req, config.token)) {
      sendJson(res, 403, { error: "bad or missing x-panel-token" });
      return true;
    }
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      sendJson(res, 400, { error: String((err && err.message) || err) });
      return true;
    }
    const payload = body && typeof body === "object" ? body : {};

    // ---- create ----------------------------------------------------------------------------------------------------
    if (route === INITIATIVES_PATH) {
      const out = initiatives.create({ title: payload.title, description: payload.description, by: payload.by || "reader" });
      if (!out.ok) {
        sendJson(res, out.refused === "unreadable" ? 409 : 400, out);
        return true;
      }
      log(`initiatives: "${out.initiative.title}" created (${out.initiative.id})`);
      onChange("created");
      sendJson(res, 201, { ok: true, initiative: out.initiative, ...view() });
      return true;
    }

    // ---- edit the words ---------------------------------------------------------------------------------------------
    if (route === `${INITIATIVES_PATH}/update`) {
      const out = initiatives.update({
        id: payload.id,
        title: payload.title,
        description: payload.description,
        by: payload.by || "reader",
      });
      if (!out.ok) {
        sendJson(res, out.refused === "unreadable" ? 409 : 400, out);
        return true;
      }
      onChange("edited");
      sendJson(res, 200, { ok: true, initiative: out.initiative, ...view() });
      return true;
    }

    // ---- the one write that asks ------------------------------------------------------------------------------------
    if (route === `${INITIATIVES_PATH}/move`) {
      const tree = String(payload.tree || payload.path || "").trim();
      const initiativeId = String(payload.initiative || payload.initiativeId || "").trim();
      const action = String(payload.action || "add").trim().toLowerCase();
      if (!tree) {
        sendJson(res, 400, { error: "a move needs the worktree's path" });
        return true;
      }
      if (action !== "add" && action !== "remove") {
        sendJson(res, 400, { error: `a move is add or remove, not ${action || "(none)"}` });
        return true;
      }
      // The store is re-read before the question: an unreadable file is a 409 now, not a card whose only answer is a
      // failure, and a membership that is already what was asked for changes nothing and asks nothing.
      const status = initiatives.statusOf();
      if (!status.readable) {
        sendJson(res, 409, {
          refused: "unreadable",
          file: status.file,
          error: `${status.file || "the initiative store"} could not be read (${status.error || "unknown error"}) - it was NOT overwritten. Fix or move that file, then try again: every initiative on the board lives in it.`,
        });
        return true;
      }
      const rec = initiatives.initiativeById(initiativeId);
      if (!rec) {
        sendJson(res, 404, { error: `no such initiative: ${initiativeId || "(none)"}` });
        return true;
      }
      const has = initiatives.forTree(tree).some((i) => i.id === rec.id);
      if ((action === "add" && has) || (action === "remove" && !has)) {
        sendJson(res, 200, {
          ok: true,
          changed: false,
          initiative: { id: rec.id, title: rec.title },
          tree,
          note: action === "add" ? "that worktree is already in this initiative" : "that worktree is not in this initiative",
          ...view(),
        });
        return true;
      }
      const project = String(projectForPath(tree)?.name || "");
      const title = `${action === "add" ? "Add" : "Remove"} ${nameOf(tree)} ${action === "add" ? "to" : "from"} "${rec.title}"`;
      const request = remoteWrites.request({
        kind: "initiative",
        worktree: tree,
        project,
        title,
        command: `${action} ${tree.replace(/\\/g, "/")} ${action === "add" ? "to" : "from"} initiative "${rec.title}"`,
        description:
          "an initiative is your map of the work an assistant's task is only a proposal about: nothing changes until you answer. Deny leaves the map exactly as it is.",
        allowed: ["once", "deny"],
        // The answer is permission for THIS change, not a remote write: no push grant may be left behind by it.
        grants: false,
        resume: () => {
          const out = initiatives.move({ tree, initiative: rec.id, action, by: payload.by || "reader" });
          if (out.ok && out.changed) onChange("moved");
          return out;
        },
      });
      log(`initiatives: asked (${request.id}) to ${action} ${tree.replace(/\\/g, "/")} ${action === "add" ? "to" : "from"} "${rec.title}"`);
      sendJson(res, 202, {
        ok: true,
        asked: true,
        id: request.id,
        deadline: request.deadline,
        timeoutSeconds: request.timeoutSeconds,
        initiative: { id: rec.id, title: rec.title },
        tree,
        action,
        note: "the question is in the dock, bottom right - the tree moves when you answer it",
      });
      return true;
    }

    sendJson(res, 404, { error: `no such initiatives route: ${route}` });
    return true;
  };
}
