// The initiatives: one tab's read, the writes a reader or an assistant may make, and the permission tier that decides
// which of them asks first.
//
//   GET  /api/initiatives              the store, every active initiative with its projects, worktrees and history, and
//                                      the assistants that have worked on it (counts and recency); plus the archived
//                                      records in their own list, which nothing else in the panel reads
//   POST /api/initiatives              { title, description } - create
//   POST /api/initiatives/update       { id, title?, description? } - edit the words only
//   POST /api/initiatives/move         { tree, initiative, action: "add"|"remove" } - attach or detach, unless the
//                                      tier says this change has to ask
//   POST /api/initiatives/reorder      { id, to, by? } - move one ACTIVE initiative to a 1-based position, immediately.
//                                      ITS OWN PATH ON PURPOSE: `/move` above means a TREE, and a reorder posted there
//                                      would detach a worktree. `to` is the index in the list the tab draws, the same
//                                      contract as POST /api/waves/move, and the answer is the whole document the next
//                                      GET would answer, so the tab and the store cannot disagree about the order.
//   POST /api/initiatives/archive      { id, by? } - put one away, REFUSED while anything under it is open. The refusal
//                                      names the blocking rows (`blocked`: wave/task id and title) and reads its liveness
//                                      from the wave fold (archiveBlockers below), not from a second opinion.
//   POST /api/initiatives/restore      { id, by? } - put it back at the position it was archived with
//
// WHY THE TIER IS A SETTING AND NOT FOUR ROUTES. The reader's question is "how often do I want to be interrupted about
// this map", and the answer is one of four levels (lib/initiative-permissions.js). The level decides ONLY whether the
// panel parks the question: the card, its wording, its once/deny answer and the resume closure are the same at every
// level, so moving the setting changes how often the reader is asked, not what a change does. At the levels that do
// not ask, the change is made at once and written into the initiative's history with the actor and the time, so an
// unasked change is still a recorded one.
//
// THE STORE IS REFUSED, NOT REPAIRED. Every write answers 409 with lib/initiatives.js's own sentence when the file
// exists and cannot be read, and that check runs BEFORE a question is parked: a card whose answer could only fail is
// worse than no card. The read carries the same status (`readable`, `error`, `file`) so the tab can say it.
import { DESCRIPTION_MAX, TITLE_MAX, normTreePath } from "../lib/initiatives.js";
import { initiativeAsks, initiativeTierFrom, initiativeTierInfo, INITIATIVE_TIER_INFO } from "../lib/initiative-permissions.js";
import { WAVE_GATE_CHOICES, taskWithOwner, waveEvidenceNeeds, waveFileExistsPaths, waveIsOpen, waveLane, waveMemberOpen } from "../lib/waves.js";
// The thread a row is on NOW, which is the last one it was carried by (lib/assistant/queue.js `currentThread`): the
// task fold names the run and the thread the same way the queue tab does, from the row itself.
import { currentThread } from "../lib/assistant/queue.js";
// The read's cache is a file beside the store (see cachedView): the tab's first read after a restart must not wait on
// the evidence join.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
// The read's own phase clock (off unless the request asks with `?profile=1`): a seam times itself so a slow answer can
// be cut at the seam that is slow rather than at the total.
import { profileReport, timeAsync, timeSync, withProfile } from "../lib/read-profile.js";

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

// One queue row, as the assistant's fold draws it. EVERY FIELD IS THE ROW'S OWN or the queue read's decoration of it:
// id, title, state, thread and run id come from the queue file, and the pull request comes from the row the queue
// read was decorated against (`task.row.pr`, lib/assistant/queue.js). Nothing here reads a branch name: a task with no
// worktree is not on any initiative's trees, and a branch that LOOKS like a tree is not a link.
//
// `runId` is drawn only while the row is live. A done row keeps the run it finished on in its file, and printing that
// beside "done" would read as a run still going; the fold says the run only when the state says it is running.
// The PR's page comes from the board row's own `prUrl` - absent when the panel could not resolve one, so the fold
// draws plain text rather than a dead link, the same rule the branch chip follows.
function taskRowOf(task, nowMs, rowFor) {
  const pr = task?.row?.pr && typeof task.row.pr === "object" ? task.row.pr : null;
  const number = pr && Number(pr.number) > 0 ? Number(pr.number) : null;
  let url = null;
  let prState = pr ? String(pr.state || "") : "";
  if (number) {
    const row = rowFor(String(task.project || task.row?.project || ""), task.worktree);
    url = row?.prUrl || null;
    // The row's own pr may be the only one with a state (a decorated row carries both, but a fixture need not).
    if (!prState && row?.pr?.state) prState = String(row.pr.state);
  }
  return {
    id: task.id,
    title: String(task.title || ""),
    state: String(task.state || ""),
    thread: String(currentThread(task) || ""),
    runId: task.state === "running" ? String(task.runId || "") : "",
    pr: number ? { number, state: prState, url } : null,
    at: lastTouched(task, nowMs),
    // THE NAMED ABANDONMENT, passed through as the row keeps it: the archive refusal reads it with the wave fold's own
    // liveness rule (lib/waves.js `waveMemberOpen`), and a task a person abandoned for a written reason is closed work.
    // No other surface reads it from here, so it is carried for the refusal rather than drawn.
    abandoned: task && task.abandoned ? task.abandoned : null,
  };
}


/**
 * The whole tab's document, built from the store plus the two things only the composition root knows: which project a
 * path belongs to, and what the board's row for it says. Pure enough to run over a fixture: every seam is a function.
 */
export function initiativesView({ initiatives, projectForPath, rowFor, assistants = [], queueFor = () => null, now = Date.now(), tier = null, waves = null, templateExists = null, evidenceFor = null, boardTasks = null, ownerLabel = null }) {
  const status = initiatives.statusOf();
  const list = initiatives.initiativeList();
  // The archived records, read once: the tab's Archived view and the counts. A store handed in by a fixture that
  // predates archive answers no list, and the view draws an empty one rather than failing.
  const archivedList = typeof initiatives.archivedList === "function" ? initiatives.archivedList() : [];
  const level = initiativeTierInfo(tier);
  const board = timeSync("fold.queues", () =>
    assistants.map((rec) => {
      let view = null;
      try {
        view = queueFor(rec.id);
      } catch {
        view = null; // a queue that cannot be read is an empty one for this tab; its own pane still reports the error
      }
      // THE OWNER IS STAMPED WHERE THE QUEUE IS READ (lib/waves.js `taskWithOwner`): every assistant numbers its own
      // tasks from one, so a wave member can only name and open the right queue when its row carries the id. The
      // label is the Assistant's own role label, the one the worktree column's owner chip draws, and the caller
      // supplies it because this fold holds no Assistant.
      const label = typeof ownerLabel === "function" ? ownerLabel(rec) : "";
      return { rec, tasks: (Array.isArray(view?.tasks) ? view.tasks : []).map((task) => taskWithOwner(task, rec, label)) };
    }),
  );
  // Every assistant's rows, flattened once: a wave's members are the tasks that NAME it, from any project (decision
  // 2, 2026-11-21), so the fold must not filter them by this initiative's tree keys the way the assistant strips do.
  // The route may hand the SAME objects it gathered evidence for, so a member's evidence key and its fold key cannot
  // be built from two different reads of one row.
  const waveTasks = Array.isArray(boardTasks) ? boardTasks : board.flatMap((b) => b.tasks);
  const waveStatus = waves && typeof waves.statusOf === "function" ? waves.statusOf() : null;
  // The trees behind one initiative, and the projects they fall into: the fold the open card draws, and the only part
  // of it an ARCHIVED card needs (its counts). One function, so an archived card and an active one cannot disagree
  // about how many worktrees a put-away initiative still owns - which is what proves Restore loses nothing.
  const foldTrees = (init) =>
    timeSync("fold.trees", () =>
      initiatives.treesFor(init.id).map((rec) => {
        const found = projectForPath(rec.path) || null;
        const project = String(found?.name || "").trim();
        const row = project ? rowFor(project, rec.path) : null;
        return {
          key: rec.key,
          path: rec.path,
          name: String(row?.round?.display || row?.name || nameOf(rec.path)),
          branch: String(row?.branch || ""),
          // The branch's page on the remote, exactly as the board row carries it (decorate -> branchLink). Passed
          // through untouched - the tab draws the SAME link the chart does through public/core/branch-link.js, and a
          // tree whose row has no resolvable page gets null here, so the tab can only draw plain text.
          branchUrl: row?.branchUrl || null,
          branchWhy: String(row?.branchWhy || ""),
          branchLinkFrom: row?.branchLinkFrom || null,
          project,
          // A tree that is no longer on the board (removed, or outside every scan root) still belongs to the initiative:
          // the tab shows it dimmed with its path, and the reader can take it out. Hiding it would strand the record.
          missing: !row,
          at: rec.at,
          by: rec.by,
          // The attachment's own actor and time: what the `own` tier reads, and what the Remove hint names, so a reader
          // can see who put a tree here before deciding to take it out.
          attachedAt: rec.attachedAt || null,
          attachedBy: rec.attachedBy || null,
        };
      }),
    );
  const foldProjects = (trees) => {
    const byProject = new Map();
    for (const tree of trees) {
      const name = tree.project || "(outside every project)";
      if (!byProject.has(name)) byProject.set(name, []);
      byProject.get(name).push(tree);
    }
    return [...byProject.entries()]
      .map(([name, rows]) => ({ name, trees: rows.sort((a, b) => a.name.localeCompare(b.name)) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  };
  const out = list.map((init, at) => {
    const trees = foldTrees(init);
    const projects = foldProjects(trees);
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
        // THE EXACT TASKS, not a count of them. The same `mine` list the counts were taken from, one row each and
        // newest activity first, so the fold that opens under this assistant cannot disagree with the chips beside
        // it. A task whose worktree is not one of this initiative's trees is not in `mine` at all: the link is the
        // row's own `worktree`, never a branch name, so a task with no initiative link cannot appear under one.
        // A tree attached to two initiatives puts the SAME row under both - each initiative's document is built from
        // its own tree keys, and a queue row is one entry in each, never two within one.
        taskRows: mine
          .map((task) => taskRowOf(task, now, rowFor))
          .sort((x, y) => String(y.at || "").localeCompare(String(x.at || "")) || Number(y.id) - Number(x.id)),
        lastAt,
      });
    }
    // How recently it worked on THIS initiative: newest first, a row with no clock after the ones that have one.
    people.sort((a, b) => String(b.lastAt || "").localeCompare(String(a.lastAt || "")) || a.name.localeCompare(b.name));
    // THE WAVE LANE (lib/waves.js): this initiative's waves in position order, each folded with the tasks that name
    // it, its derived state and its gate reads. A read, not a record: nothing here is stored on the initiative, and a
    // wave with no member draws as `empty` rather than as a default membership. Each wave also carries `autoOpen`, the
    // answer for THIS read about the switch on the wave before it - so the tab and GET /api/waves evaluate the auto
    // switch in the same fold, at the same moment, from the same evidence map.
    const lane = waves
      ? timeSync("fold.lanes", () => waveLane({ waves, initiativeId: init.id, tasks: waveTasks, rowFor, templateExists, evidenceFor }))
      : { waves: [], skipped: [], currentId: null };
    return {
      id: init.id,
      title: init.title,
      description: init.description,
      createdAt: init.createdAt,
      updatedAt: init.updatedAt,
      updatedBy: init.updatedBy,
      // The reader's place in the list, and the stored number behind it: the card draws its arrows from this, so the
      // first card's up arrow and the last card's down arrow are disabled by the same read that draws the words.
      // `orderBy` is who moved it last - carried so a caller can prove the write recorded an actor, not drawn.
      position: at + 1,
      order: init.order,
      orderBy: init.orderBy,
      projects,
      projectCount: projects.length,
      treeCount: trees.length,
      assistants: people,
      assistantCount: people.length,
      // The lane's own three facts: the waves, the records the store refused (one sentence each, drawn beside the
      // lane so a bad record is visible rather than silently missing), and which wave the stated order makes current.
      waves: lane.waves,
      waveSkipped: lane.skipped,
      waveCurrentId: lane.currentId,
      // Newest first, so the fold opens on the change the reader is most likely looking for. Every event names its
      // actor and its time: a reader's own press is "you", an assistant's change is the assistant's id. A store the
      // caller handed in without the reader (a fixture with only initiativeList and treesFor) draws no history rather
      // than failing the whole view: the tab is a read, and a read should not depend on a method added later.
      history: typeof initiatives.historyFor === "function" ? initiatives.historyFor(init.id) : [],
    };
  });
  // THE ARCHIVED LIST. Its own array, never mixed into `initiatives`: every count, chip, lane and drive in the panel
  // reads the active list, so an archived initiative is absent from all of them by construction rather than by a filter
  // somebody has to remember. The card needs the same counts the active one shows and the stamp that says who put it
  // away, and nothing else: no lane is folded for it (the archive rule guarantees its waves are closed), so putting a
  // heavy initiative away makes the tab cheaper rather than dearer.
  const archived = archivedList.map((init) => {
    const trees = foldTrees(init);
    const projects = foldProjects(trees);
    return {
      id: init.id,
      title: init.title,
      description: init.description,
      createdAt: init.createdAt,
      updatedAt: init.updatedAt,
      order: init.order,
      archivedAt: init.archivedAt,
      archivedBy: init.archivedBy,
      projects,
      projectCount: projects.length,
      treeCount: trees.length,
    };
  });
  return {
    at: new Date(now).toISOString(),
    file: status.file,
    found: status.found,
    readable: status.readable,
    error: status.error,
    caps: { title: TITLE_MAX, description: DESCRIPTION_MAX },
    // The level in force, so the tab can say which one decides its questions and the settings select has one source.
    // `tiers` is the four labels, so a second surface cannot draw a different list.
    tier: { id: level.id, label: level.label, hint: level.hint },
    tiers: INITIATIVE_TIER_INFO.map((row) => ({ id: row.id, label: row.label, hint: row.hint })),
    // The wave store's own status, so the lane can say "this file cannot be read" without a second request. Null when
    // the composition root handed in no wave store (a fixture that predates waves), which the lane draws as no waves.
    waveStatus: waveStatus
      ? {
          file: waveStatus.file,
          found: waveStatus.found,
          readable: waveStatus.readable,
          error: waveStatus.error,
          // The gate names the tab's one-line form offers (lib/waves.js `WAVE_GATE_CHOICES`). It rides the read the tab
          // already takes, so the picker cannot drift from the door that validates every post (`pickWaveGate`).
          gateChoices: WAVE_GATE_CHOICES,
        }
      : null,
    initiatives: out,
    // What the reader put away, drawn only by the Archived view. Never folded into the list above.
    archived,
    // The two counts the filter draws, taken from the arrays the answer carries so a chip cannot disagree with them.
    counts: { active: out.length, archived: archived.length },
  };
}

/**
 * WHAT STILL HAS TO BE CLOSED BEFORE AN INITIATIVE CAN BE ARCHIVED: every wave the fold reads open, and every task
 * under the initiative that is still live - on one of its trees, or filed into one of its waves from another project.
 *
 * THE LIVENESS RULE IS THE WAVE FOLD'S OWN (lib/waves.js `waveIsOpen` / `waveMemberOpen`), the same pair the wave drive
 * closes a wave with and the lane draws its state from. A second opinion here would let the tab archive work the
 * driver still considers open, which is exactly the "refuse while open" answer the reader gave. `[]` is a clean
 * initiative. Every entry names the row by id and title, because a refusal that says "something is open" is a wall.
 *
 * @param {object} init one initiative as `initiativesView` folds it
 * @returns {Array<{kind: "wave"|"task", id: string|number, title: string, state: string, why: string}>}
 */
export function archiveBlockers(init) {
  const out = [];
  const seen = new Set();
  const addTask = (task, owner) => {
    if (!waveMemberOpen(task)) return;
    const key = `${owner || "?"}:${task.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      kind: "task",
      id: task.id,
      title: String(task.title || ""),
      state: String(task.state || ""),
      why: `#${task.id} "${String(task.title || "")}" reads ${task.state}`,
    });
  };
  for (const wave of Array.isArray(init?.waves) ? init.waves : []) {
    if (waveIsOpen(wave)) {
      out.push({
        kind: "wave",
        id: String(wave.id || ""),
        title: String(wave.title || ""),
        state: String(wave.state || ""),
        why: `wave ${wave.id} "${String(wave.title || "")}"${wave.position ? ` (W${wave.position})` : ""} reads ${wave.state}${wave.stateWhy ? `: ${wave.stateWhy}` : ""}`,
      });
    }
    for (const member of Array.isArray(wave.members) ? wave.members : []) addTask(member, member.assistantId);
  }
  // The tasks on the initiative's own trees, including the ones filed into no wave at all: the tab counts them beside
  // each assistant, so they are work under this initiative whether or not a wave has claimed them.
  for (const person of Array.isArray(init?.assistants) ? init.assistants : []) {
    for (const task of Array.isArray(person.taskRows) ? person.taskRows : []) addTask(task, person.id);
  }
  return out;
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
  // The wave store and its template read (lib/waves.js, routes/waves.js). Optional: a fixture that predates waves
  // still drives this route, and the tab then draws an empty lane rather than failing.
  waves = null,
  templateExists = null,
  // The live evidence behind a wave gate (lib/wave-evidence.js): the pull request read through the host's API and
  // the landing judged by content on origin/main. Supplied by the composition root, which is the only place the host
  // mapping and the project registry live. Absent, thrown, or missing a member, the gate reads cannot tell and blocks.
  waveEvidence = null,
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
  // The level in force is read from the live config on EVERY request, not captured at boot: the settings route writes
  // `config.initiativePermissions`, and a card that still asked under a level the reader has just relaxed would be a
  // setting that only applies after a restart.
  const tierOf = () => initiativeTierFrom(getConfig()?.initiativePermissions);
  // Who is making the change. The page sends nothing and means the reader; an assistant sends its own id, and that id
  // is what the history records and what the `own` tier compares against the attachment's actor.
  const actorOf = (payload) => String(payload?.by || payload?.actor || "").trim() || "reader";
  const unreadable = () => {
    const status = initiatives.statusOf();
    if (status.readable) return null;
    return {
      refused: "unreadable",
      file: status.file,
      error: `${status.file || "the initiative store"} could not be read (${status.error || "unknown error"}) - it was NOT overwritten. Fix or move that file, then try again: every initiative on the board lives in it.`,
    };
  };
  // The members' rows, flattened EXACTLY as initiativesView builds them, so the evidence keys and the fold's member
  // keys are the same strings. Each row goes into the queue read and the evidence read unchanged; `waveMemberKey`
  // reads the task's own id and worktree, never the assistant it came from.
  const waveTasks = () => {
    const out = [];
    for (const rec of Array.isArray(assistant?.assistants) ? assistant.assistants : []) {
      let view = null;
      try {
        view = typeof assistant?.queueView === "function" ? assistant.queueView(rec.id) : null;
      } catch {
        view = null; // its own pane reports the error; a wave read must not fail because one queue did
      }
      for (const task of Array.isArray(view?.tasks) ? view.tasks : []) out.push(taskWithOwner(task, rec, typeof assistant?.roleLabelOf === "function" ? assistant.roleLabelOf(rec) : ""));
    }
    return out;
  };
  // One evidence read per request, shared by every initiative's lane: a Map keyed by waveMemberKey, or null when no
  // reader was supplied or the read threw. Null is cannot-tell for every gate - the fold still paints, the gates
  // never pass. `checks` is the gate vocabulary this answer contains (lib/waves.js `waveEvidenceNeeds`), so the read
  // asks the host and git for the halves a gate here actually consumes and no others.
  const evidenceFor = async (tasks, paths, checks) => {
    if (typeof waveEvidence !== "function") return null;
    try {
      const map = await waveEvidence({ tasks, rowFor, paths, checks });
      if (map instanceof Map) return map;
      log("initiatives: the wave evidence reader answered no map, so every gate reads cannot tell");
    } catch (error) {
      log(`initiatives: the wave evidence read failed, so every gate reads cannot tell: ${String((error && error.message) || error)}`);
    }
    return null;
  };
  // `view` is async because the gates are a live read. It answers the whole document the tab draws; every caller
  // awaits it, so a POST's answer carries the same lane the next GET would.
  const view = async () => {
    const tasks = timeSync("queues", () => waveTasks());
    // Every wave this answer will fold: its gates are what decide which members owe an evidence read, and every
    // artefact path a `file-exists` gate names is read once for the whole answer.
    const records = timeSync("gate-paths", () => (typeof initiatives?.initiativeList === "function" ? initiatives.initiativeList() : []).flatMap((init) => (waves && typeof waves.wavesFor === "function" ? waves.wavesFor(init.id) : [])));
    const needs = timeSync("gate-paths", () => waveEvidenceNeeds(records));
    const paths = timeSync("gate-paths", () => waveFileExistsPaths(records));
    // THE MEMBERS A GATE CAN READ, and no others. A task in no wave, or in a wave whose gates judge its board row,
    // has no evidence a gate here consults: reading it would spend a host call and a git spawn on a field nobody
    // draws. The fold still receives every task (`boardTasks: tasks`), so membership and the lane are unchanged.
    const wanted = new Set(needs.waveIds);
    const members = wanted.size ? tasks.filter((task) => wanted.has(String(task?.waveId ?? ""))) : [];
    const evidence = await timeAsync("evidence", () => evidenceFor(members, paths, needs.checks));
    return timeSync("fold", () =>
      initiativesView({
        initiatives,
        projectForPath,
        rowFor,
        assistants: Array.isArray(assistant?.assistants) ? assistant.assistants : [],
        queueFor: (id) => (typeof assistant?.queueView === "function" ? assistant.queueView(id) : null),
        ownerLabel: (rec) => (typeof assistant?.roleLabelOf === "function" ? assistant.roleLabelOf(rec) : ""),
        tier: tierOf(),
        waves,
        templateExists,
        boardTasks: tasks,
        evidenceFor: (member) => (evidence ? evidence.get(member.key) || null : null),
      }),
    );
  };

  // THE READ ANSWERS AT ONCE AND REBUILDS BEHIND THE READER. The join is the tab's whole document but the expensive
  // part of it is the wave gate evidence (PR reads and landing judgements per member, lib/wave-evidence.js), which
  // measured 25-52s on 2026-11-23 while the panel walked the fleet - longer than the client's 12s timeout, so the tab
  // showed "the panel server did not answer" and never got a first document to cache. The last built document is
  // therefore kept (in memory and on disk beside the store): a read returns it immediately and a stale one schedules a
  // rebuild for the next read. A write still drops it and answers with a fresh build, so a change is never read back
  // from a cache built before it.
  let viewCache = loadViewCache(); // { at, doc }
  let building = null;
  const VIEW_STALE_MS = 2000;

  function viewCacheFile() {
    try {
      return path.join(path.dirname(initiatives.statusOf().file), "initiatives-cache.json");
    } catch {
      return null;
    }
  }
  function loadViewCache() {
    const file = viewCacheFile();
    if (!file || !existsSync(file)) return null;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (raw && raw.doc && Array.isArray(raw.doc.initiatives)) return { at: Number(raw.at) || 0, doc: raw.doc };
    } catch {
      /* a corrupt cache is no cache */
    }
    return null;
  }
  function saveViewCache(entry) {
    const file = viewCacheFile();
    if (!file) return;
    try {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(entry), "utf8");
      renameSync(tmp, file);
    } catch {
      /* the cache is an optimisation; the read still answers */
    }
  }
  function rebuildView() {
    if (building) return building;
    building = (async () => {
      try {
        const doc = await view();
        viewCache = { at: Date.now(), doc };
        saveViewCache(viewCache);
        return doc;
      } finally {
        building = null;
      }
    })();
    return building;
  }
  const cachedView = async () => {
    // A store that has become unreadable is never answered from the cache: `readable: false` and the parser's own
    // sentence are the tab's whole point on that path, and a stale "readable: true" would be a lie the reader would
    // act on. The status check is a stat plus the store's own memoised load, not the join below.
    if (!initiatives.statusOf().readable) {
      viewCache = null;
      return view();
    }
    if (viewCache) {
      if (Date.now() - viewCache.at > VIEW_STALE_MS && !building) {
        void rebuildView().catch(() => {
          /* the next read retries; this one already has a document to answer with */
        });
      }
      return viewCache.doc;
    }
    return rebuildView();
  };
  const dropView = () => {
    viewCache = null;
  };

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
      // THE TAB GETS THE CACHED DOCUMENT; AN OPERATOR ASKING FOR PHASES GETS A REAL BUILD. `?profile=1` is a
      // measurement request (lib/read-profile.js), so it must not be answered from a cache - the phases of a cache hit
      // describe the hit, not the read. The tab never sends it, and the document it draws is the one `cachedView`
      // keeps, with no new key.
      if (String(params.get("profile") || "") === "1") {
        sendJson(
          res,
          200,
          await withProfile(true, async () => {
            const document = await view();
            document.profile = profileReport();
            return document;
          }),
        );
        return true;
      }
      sendJson(res, 200, await cachedView());
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
    // A write is about to change the map: the memoised read must not answer the next GET with the state from before it.
    dropView();

    // ---- create ----------------------------------------------------------------------------------------------------
    if (route === INITIATIVES_PATH) {
      const refused = unreadable();
      if (refused) {
        sendJson(res, 409, refused);
        return true;
      }
      const title = String(payload.title ?? "").replace(/\s+/g, " ").trim();
      if (!title) {
        sendJson(res, 400, { ok: false, error: "an initiative needs a title - one line saying what the work is" });
        return true;
      }
      const by = actorOf(payload);
      // The level decides whether this asks. At `all` it does, and the card names the proposed initiative - there is no
      // tree yet, so the tree line is empty rather than invented. The resume creates it, on the same store the plain
      // path writes, so an answered card and an unasked create cannot diverge.
      if (initiativeAsks(tierOf(), "create", { actor: by })) {
        const request = remoteWrites.request({
          kind: "initiative",
          worktree: "",
          project: "",
          title: `Create initiative "${title.slice(0, TITLE_MAX)}"`,
          command: `create initiative "${title.slice(0, TITLE_MAX)}"`,
          description: `${by === "reader" ? "you are" : `${by} is`} adding an initiative to your map of the work. Nothing is created until you answer; Deny leaves the map exactly as it is.`,
          allowed: ["once", "deny"],
          grants: false,
          resume: () => {
            const out = initiatives.create({ title: payload.title, description: payload.description, by });
            if (out.ok) onChange("created");
            return out;
          },
        });
        log(`initiatives: asked (${request.id}) to create "${title.slice(0, TITLE_MAX)}" as ${by}`);
        sendJson(res, 202, {
          ok: true,
          asked: true,
          id: request.id,
          deadline: request.deadline,
          timeoutSeconds: request.timeoutSeconds,
          action: "create",
          title: title.slice(0, TITLE_MAX),
          tier: tierOf(),
          note: "the question is in the dock, bottom right - the initiative is created when you answer it",
        });
        return true;
      }
      const out = initiatives.create({ title: payload.title, description: payload.description, by });
      if (!out.ok) {
        sendJson(res, out.refused === "unreadable" ? 409 : 400, out);
        return true;
      }
      log(`initiatives: "${out.initiative.title}" created (${out.initiative.id}) by ${by}, not asked (tier ${tierOf()})`);
      onChange("created");
      sendJson(res, 201, { ok: true, asked: false, changed: true, initiative: out.initiative, ...(await rebuildView()) });
      return true;
    }

    // ---- edit the words ---------------------------------------------------------------------------------------------
    if (route === `${INITIATIVES_PATH}/update`) {
      const refused = unreadable();
      if (refused) {
        sendJson(res, 409, refused);
        return true;
      }
      const id = String(payload.id || "").trim();
      const existing = initiatives.initiativeById(id);
      if (!existing) {
        sendJson(res, 404, { error: `no such initiative: ${id || "(none)"}` });
        return true;
      }
      if (payload.title === undefined && payload.description === undefined) {
        sendJson(res, 400, { ok: false, error: "nothing to change: send a title, a description, or both" });
        return true;
      }
      const by = actorOf(payload);
      if (initiativeAsks(tierOf(), "edit", { actor: by })) {
        const bits = [payload.title !== undefined ? "the title" : "", payload.description !== undefined ? "the description" : ""].filter(Boolean);
        const request = remoteWrites.request({
          kind: "initiative",
          worktree: "",
          project: "",
          title: `Edit initiative "${existing.title}"`,
          command: `edit initiative "${existing.title}" (${bits.join(" and ")})`,
          description: `${by === "reader" ? "you are" : `${by} is`} changing the words of an initiative on your map of the work. Nothing changes until you answer; Deny leaves it exactly as it is.`,
          allowed: ["once", "deny"],
          grants: false,
          resume: () => {
            const out = initiatives.update({ id: existing.id, title: payload.title, description: payload.description, by });
            if (out.ok && out.changed !== false) onChange("edited");
            return out;
          },
        });
        log(`initiatives: asked (${request.id}) to edit "${existing.title}" as ${by}`);
        sendJson(res, 202, {
          ok: true,
          asked: true,
          id: request.id,
          deadline: request.deadline,
          timeoutSeconds: request.timeoutSeconds,
          action: "edit",
          initiative: { id: existing.id, title: existing.title },
          tier: tierOf(),
          note: "the question is in the dock, bottom right - the words change when you answer it",
        });
        return true;
      }
      const out = initiatives.update({ id: existing.id, title: payload.title, description: payload.description, by });
      if (!out.ok) {
        sendJson(res, out.refused === "unreadable" ? 409 : 400, out);
        return true;
      }
      if (out.changed !== false) onChange("edited");
      log(`initiatives: "${out.initiative.title}" edited (${out.initiative.id}) by ${by}, not asked (tier ${tierOf()})`);
      sendJson(res, 200, { ok: true, asked: false, changed: out.changed !== false, initiative: out.initiative, ...(await rebuildView()) });
      return true;
    }

    // ---- the reader's order -------------------------------------------------------------------------------------------
    // A REORDER IS NOT A MOVE. `/move` above attaches or detaches a TREE and can park a permission card; this route
    // moves the CARD, saves at once (the reader asked for no Save button), and never asks: the tier is about the map's
    // membership, not about the order the reader keeps his own list in. `to` is 1-based in the ACTIVE list, exactly the
    // waves route's contract, and the answer is the whole document the next GET would answer plus a plain `order` list
    // a caller can assert against without reading the fold.
    if (route === `${INITIATIVES_PATH}/reorder`) {
      const refused = unreadable();
      if (refused) {
        sendJson(res, 409, refused);
        return true;
      }
      const id = String(payload.id || "").trim();
      if (!id) {
        sendJson(res, 400, { ok: false, error: "a reorder needs the initiative id" });
        return true;
      }
      const existing = initiatives.initiativeById(id);
      if (!existing) {
        sendJson(res, 404, { ok: false, error: `no such initiative: ${id}` });
        return true;
      }
      if (existing.archivedAt) {
        sendJson(res, 409, { ok: false, error: `"${existing.title}" is archived - restore it before moving it in the list` });
        return true;
      }
      const by = actorOf(payload);
      const out = initiatives.reorder({ id, to: payload.to, by });
      if (out.notFound) {
        sendJson(res, 404, out);
        return true;
      }
      if (!out.ok) {
        sendJson(res, out.refused === "unreadable" ? 409 : 400, out);
        return true;
      }
      if (out.changed !== false) onChange("reordered");
      const view = await rebuildView();
      log(`initiatives: "${existing.title}" (${id}) moved to position ${out.to} by ${by}${out.changed === false ? " - already there" : ""}`);
      sendJson(res, 200, {
        ok: true,
        asked: false,
        changed: out.changed !== false,
        to: out.to,
        // The new order, plainly: the document below carries the same list folded, and this is the one line a caller
        // can assert a reorder against without reading the fold (the waves route's own answer shape).
        order: view.initiatives.map((init, at) => ({ id: init.id, position: at + 1 })),
        ...view,
      });
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
      // The store is re-read before a question: an unreadable file is a 409 now, not a card whose only answer is a
      // failure, and a membership that is already what was asked for changes nothing and asks nothing.
      const refusedMove = unreadable();
      if (refusedMove) {
        sendJson(res, 409, refusedMove);
        return true;
      }
      const rec = initiatives.initiativeById(initiativeId);
      if (!rec) {
        sendJson(res, 404, { error: `no such initiative: ${initiativeId || "(none)"}` });
        return true;
      }
      // An archived initiative is out of the map: a tree cannot be attached to it or taken out of it until it is back
      // in the list, so its saved membership is exactly what Restore returns.
      if (rec.archivedAt) {
        sendJson(res, 409, { ok: false, error: `"${rec.title}" is archived - restore it before moving a worktree in or out of it` });
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
          ...(await rebuildView()),
        });
        return true;
      }
      const project = String(projectForPath(tree)?.name || "");
      const by = actorOf(payload);
      // WHO PUT THE TREE THERE decides the `own` level, so a detach reads the attachment's actor before it decides
      // whether to ask. An attach has no earlier attachment to judge; the level reads only the action.
      const attachedBy = action === "remove" ? initiatives.attachmentInfo(tree, rec.id)?.by || null : null;
      if (!initiativeAsks(tierOf(), action === "add" ? "attach" : "detach", { actor: by, attachedBy })) {
        const out = initiatives.move({ tree, initiative: rec.id, action, by });
        if (!out.ok) {
          sendJson(res, out.refused === "unreadable" ? 409 : 400, out);
          return true;
        }
        if (out.changed) onChange("moved");
        log(
          `initiatives: ${action === "add" ? "attached" : "detached"} ${tree.replace(/\\/g, "/")} ${action === "add" ? "to" : "from"} "${rec.title}" as ${by}, not asked (tier ${tierOf()})`,
        );
        sendJson(res, 200, {
          ok: true,
          asked: false,
          changed: out.changed !== false,
          initiative: { id: rec.id, title: rec.title },
          tree,
          action,
          ...(await rebuildView()),
        });
        return true;
      }
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
          const out = initiatives.move({ tree, initiative: rec.id, action, by });
          if (out.ok && out.changed) onChange("moved");
          return out;
        },
      });
      log(`initiatives: asked (${request.id}) to ${action} ${tree.replace(/\\/g, "/")} ${action === "add" ? "to" : "from"} "${rec.title}" as ${by}`);
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

    // ---- archive: put it away, but only when nothing under it is open ----------------------------------------------
    // THE REFUSAL IS THE POINT OF THIS ROUTE (the reader's answer 2). The blocking rows are read from the SAME fold
    // the tab draws and the wave drive closes a wave from (archiveBlockers -> lib/waves.js waveIsOpen/waveMemberOpen),
    // built fresh for this request rather than from the memoised read: a task that started a second ago must refuse
    // the archive, and a document up to two seconds old would let it through. The answer names every blocking row by
    // id and title, so the reader knows exactly which card to close.
    if (route === `${INITIATIVES_PATH}/archive`) {
      const refused = unreadable();
      if (refused) {
        sendJson(res, 409, refused);
        return true;
      }
      const id = String(payload.id || "").trim();
      if (!id) {
        sendJson(res, 400, { ok: false, error: "an archive needs the initiative id" });
        return true;
      }
      const existing = initiatives.initiativeById(id);
      if (!existing) {
        sendJson(res, 404, { ok: false, error: `no such initiative: ${id}` });
        return true;
      }
      const by = actorOf(payload);
      if (existing.archivedAt) {
        sendJson(res, 200, { ok: true, asked: false, changed: false, note: `"${existing.title}" is already archived`, ...(await cachedView()) });
        return true;
      }
      // One fresh fold, used twice: its lanes are the rows the refusal names, and the write below is what the answer's
      // document draws. The document that answers is rebuilt after the write, so an archived initiative is absent from
      // the list the tab gets back in the very same breath.
      const fresh = await rebuildView();
      const entry = fresh.initiatives.find((init) => init.id === id) || null;
      if (!entry) {
        sendJson(res, 404, { ok: false, error: `no such initiative: ${id}` });
        return true;
      }
      const blockers = archiveBlockers(entry);
      if (blockers.length) {
        const names = blockers.map((b) => (b.kind === "wave" ? `wave ${b.id} "${b.title}"` : `#${b.id} "${b.title}"`));
        const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join("; ")} and ${names[names.length - 1]}`;
        const error = `"${existing.title}" cannot be archived while ${blockers.length === 1 ? "this is" : "these are"} still open: ${list} - close ${blockers.length === 1 ? "it" : "them"}, then archive again`;
        log(`initiatives: refused to archive "${existing.title}" (${id}) - ${blockers.map((b) => b.why).join("; ")}`);
        sendJson(res, 409, { ok: false, asked: false, changed: false, blocked: blockers, error, initiative: { id, title: existing.title } });
        return true;
      }
      const out = initiatives.archive({ id, by });
      if (!out.ok) {
        sendJson(res, out.refused === "unreadable" ? 409 : 400, out);
        return true;
      }
      if (out.changed) onChange("archived");
      log(`initiatives: archived "${existing.title}" (${id}) by ${by} - no wave or task under it was open`);
      sendJson(res, 200, {
        ok: true,
        asked: false,
        changed: out.changed !== false,
        archived: { id, title: existing.title, archivedAt: out.initiative?.archivedAt || null, archivedBy: out.initiative?.archivedBy || null },
        ...(await rebuildView()),
      });
      return true;
    }

    // ---- restore: back to the place the number names ---------------------------------------------------------------
    if (route === `${INITIATIVES_PATH}/restore`) {
      const refused = unreadable();
      if (refused) {
        sendJson(res, 409, refused);
        return true;
      }
      const id = String(payload.id || "").trim();
      if (!id) {
        sendJson(res, 400, { ok: false, error: "a restore needs the initiative id" });
        return true;
      }
      const existing = initiatives.initiativeById(id);
      if (!existing) {
        sendJson(res, 404, { ok: false, error: `no such initiative: ${id}` });
        return true;
      }
      const by = actorOf(payload);
      const out = initiatives.restore({ id, by });
      if (!out.ok) {
        sendJson(res, out.refused === "unreadable" ? 409 : 400, out);
        return true;
      }
      if (out.changed) onChange("restored");
      const view = await rebuildView();
      const back = view.initiatives.find((init) => init.id === id) || null;
      log(`initiatives: restored "${existing.title}" (${id}) by ${by}${back ? ` at position ${back.position}` : ""}`);
      sendJson(res, 200, {
        ok: true,
        asked: false,
        changed: out.changed !== false,
        restored: { id, title: existing.title, position: back ? back.position : null },
        ...view,
      });
      return true;
    }

    sendJson(res, 404, { error: `no such initiatives route: ${route}` });
    return true;
  };
}
