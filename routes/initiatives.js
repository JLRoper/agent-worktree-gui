// The initiatives: one tab's read, the writes a reader or an assistant may make, and the permission tier that decides
// which of them asks first.
//
//   GET  /api/initiatives              the store, every active initiative with its projects, worktrees and history, and
//                                      the assistants that have worked on it (counts and recency); plus the archived
//                                      records in their own list, which nothing else in the panel reads
//   POST /api/initiatives              { title, description } - create
//   POST /api/initiatives/update       { id, title?, description? } - edit the words only
//   POST /api/initiatives/notes/add    { id, text, url?, label?, by? } - append one note to the initiative's log
//   POST /api/initiatives/notes/edit   { id, note, text?, label?, by? } - amend one entry's words or a link's label
//   POST /api/initiatives/notes/delete { id, note, by? } - remove one entry
//                                      THE THREE NOTE ROUTES NEVER ASK. The tier governs the map (whose worktrees
//                                      belong to what); a note is memory written on a record the reader already has,
//                                      and the assistant half of this feature logs notes from finished turns. A
//                                      question per note would make the log useless exactly where it matters. Each
//                                      write records its actor on the note itself and in the panel's log.
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
//   GET    /api/initiatives/tags       the board's tag registry (lib/initiative-tags.js): every tag with its id, ident,
//                                      name, description, colour and createdAt, plus the palette and the caps. The tab
//                                      reads the same document inside GET /api/initiatives (`tags`), so the pane needs no
//                                      second request to draw its filter row; this route is for a caller that wants the
//                                      vocabulary alone.
//   POST   /api/initiatives/tags       { ident, name, description?, color? } - create one. 201 with the tag.
//   PATCH  /api/initiatives/tags       { id, ident?, name?, description?, color? } - rename or recolour the ONE entry,
//                                      which is what makes every card and every saved filter follow in one write.
//   DELETE /api/initiatives/tags       { id, confirm? } - delete it. REFUSED (409) while any initiative carries it,
//                                      with the COUNT and the titles in the sentence; `confirm: true` deletes it and
//                                      takes the id off every initiative in one save (Initiatives.dropTag).
//                                      THE THREE REGISTRY WRITES ARE THE READER'S ALONE. An assistant may apply an
//                                      existing tag (initiative create/update `tagIds`) but may not mint, rename or delete
//                                      one: a `by` that is not "reader" is a 403, because the board's vocabulary is the
//                                      reader's to decide and a worker that could rename a tag could silently reorganise
//                                      every filter the reader keeps. None of the three asks the permission tier - the
//                                      tier governs the MAP (which trees belong to what), not the words on the cards.
//
// WHY THE TIER IS A SETTING AND NOT FOUR ROUTES. The reader's question is "how often do I want to be interrupted about
// this map", and the answer is one of four levels (lib/initiative-permissions.js). The level decides ONLY whether the
// panel parks the question: the card, its wording, its once/deny answer and the resume closure are the same at every
// level, so moving the setting changes how often the reader is asked, not what a change does. At the levels that do
// not ask, the change is made at once and written into the initiative's history with the actor and the time, so an
// unasked change is still a recorded one.
//
// THE WRITES ARE THEIR OWN FILE. routes/initiatives-write.js holds the tag registry, the GET the tab draws and every
// POST/PATCH/DELETE this prefix answers, composed below by createInitiativeWrites. This file keeps the fold
// (initiativesView), the archive blockers and the read's memo, and hands them to the dispatcher.
//
// THE STORE IS REFUSED, NOT REPAIRED. Every write answers 409 with lib/initiatives.js's own sentence when the file
// exists and cannot be read, and that check runs BEFORE a question is parked: a card whose answer could only fail is
// worse than no card. The read carries the same status (`readable`, `error`, `file`) so the tab can say it.
//
// THE WAVE STORE IS THE AUTHORITY ON A WAVE, AND THIS TAB'S READ IS A MEMO OF A JOIN. GET /api/waves folds the wave
// store on every request; GET /api/initiatives answers a document kept for a moment and rebuilt behind the reader
// (cachedView). The memo is therefore served only while it was built against the wave store's current file, status and
// `mtimeMs:size` stamp, and while the member rows that can open or close a wave are unchanged: two callers cannot get
// two answers about whether a wave exists, is open, or has become unreadable. When the store moves, this read waits for
// a fresh fold rather than answering a lane the waves route would contradict. Everything else in the join (the board
// rows behind a gate's evidence, the queue rows that name no wave) keeps the memo's small window: those are reads of
// the world, not of the store, and the wave records they decorate are the same ones both routes fold.
import { DESCRIPTION_MAX, NOTE_LABEL_MAX, NOTE_TEXT_MAX, NOTE_URL_MAX, NOTES_MAX, TITLE_MAX, normTreePath } from "../lib/initiatives.js";
// The board's tag registry: its store's view, the caps the tab prints and the id a card carries. The read joins the two
// stores by id here (and only here), so a card never stores a word the registry could have renamed.
import { TAG_DESCRIPTION_MAX, TAG_IDENT_MAX, TAG_IDENT_MIN, TAG_NAME_MAX, tagsView } from "../lib/initiative-tags.js";
import { initiativeTierFrom, initiativeTierInfo, INITIATIVE_TIER_INFO } from "../lib/initiative-permissions.js";
import { WAVE_GATE_CHOICES, taskWithOwner, waveEvidenceNeeds, waveFileExistsPaths, waveIsOpen, waveLane, waveMemberOpen } from "../lib/waves.js";
// The thread a row is on NOW, which is the last one it was carried by (lib/assistant/queue.js `currentThread`): the
// task fold names the run and the thread the same way the queue tab does, from the row itself.
import { currentThread, readQueueFile } from "../lib/assistant/queue.js";
// The read's cache is a file beside the store (see cachedView): the tab's first read after a restart must not wait on
// the evidence join.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
// The read's own phase clock (off unless the request asks with `?profile=1`): a seam times itself so a slow answer can
// be cut at the seam that is slow rather than at the total.
import { timeAsync, timeSync } from "../lib/read-profile.js";
// The write half of this prefix: the tag registry, the writes and the GET, composed below.
import { createInitiativeWrites } from "./initiatives-write.js";

/** The one path this prefix answers, and the row the mount table in server.js matches on. */
export const INITIATIVES_PATH = "/api/initiatives";
/** The board's tag registry, under the same prefix: `/api/initiatives/tags` (GET/POST/PATCH/DELETE). */
export const TAGS_PATH = `${INITIATIVES_PATH}/tags`;

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
export function initiativesView({ initiatives, projectForPath, rowFor, assistants = [], queueFor = () => null, now = Date.now(), tier = null, waves = null, templateExists = null, evidenceFor = null, boardTasks = null, ownerLabel = null, tagStore = null }) {
  const status = initiatives.statusOf();
  const list = initiatives.initiativeList();
  // The archived records, read once: the tab's Archived view and the counts. A store handed in by a fixture that
  // predates archive answers no list, and the view draws an empty one rather than failing.
  const archivedList = typeof initiatives.archivedList === "function" ? initiatives.archivedList() : [];
  const level = initiativeTierInfo(tier);
  // THE BOARD'S TAGS, read once per answer. The registry is the one document every card's ids resolve against; the
  // read hands it over whole (with its status, palette and caps) so the tab's filter row, its manager and its chips
  // are all drawn from the same answer as the cards. `null` when no registry was handed in (a fixture older than
  // tags), which the tab draws as no filter row rather than as "no tags".
  const tagDoc = tagStore && typeof tagStore.statusOf === "function" ? tagsView(tagStore) : null;
  const tagIdsOf = (init) => (Array.isArray(init.tagIds) ? init.tagIds.slice() : []);
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
      // THE NOTE LOG, read with the initiative and newest first, for the same reason the history is: the note just
      // written is the one being looked for. A fixture that predates notes draws an empty log rather than failing.
      notes: typeof initiatives.notesFor === "function" ? initiatives.notesFor(init.id) : [],
      noteCount: typeof initiatives.notesFor === "function" ? initiatives.notesFor(init.id).length : 0,
      // THE TAGS, AS IDS. The words are the registry's (`tags` below), never copied onto a card: a rename follows every
      // card because every card holds an id, and a card can never claim a tag the registry does not have.
      tagIds: tagIdsOf(init),
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
      // The put-away card draws no log - its notes are still on the record and Restore brings them back unchanged -
      // but the count is carried so the tab can say how much memory it is putting away.
      noteCount: typeof initiatives.notesFor === "function" ? initiatives.notesFor(init.id).length : 0,
      // A put-away card keeps its tags: Restore brings back exactly the card that went away, chips and all, and the
      // archived view's tag filter reads these ids.
      tagIds: tagIdsOf(init),
    };
  });
  return {
    at: new Date(now).toISOString(),
    file: status.file,
    found: status.found,
    readable: status.readable,
    error: status.error,
    caps: {
      title: TITLE_MAX,
      description: DESCRIPTION_MAX,
      // The note log's caps, so the form and the store cannot disagree about what a note may be. They REFUSE rather
      // than clip (lib/initiatives.js's header says why), and the tab draws the numbers beside its own counter.
      noteText: NOTE_TEXT_MAX,
      noteLabel: NOTE_LABEL_MAX,
      noteUrl: NOTE_URL_MAX,
      notes: NOTES_MAX,
      // The tag registry's caps, for the same reason: the create form prints them beside its fields and the store
      // refuses on them, so the two cannot disagree about what an ident or a name may be.
      tagIdentMin: TAG_IDENT_MIN,
      tagIdentMax: TAG_IDENT_MAX,
      tagName: TAG_NAME_MAX,
      tagDescription: TAG_DESCRIPTION_MAX,
    },
    // THE BOARD'S TAG REGISTRY (lib/initiative-tags.js): every tag, its palette, its caps and whether the file can be
    // read. Rides the read the tab already takes, so the filter row, the manager and every card are drawn from one
    // answer. Null only for a fixture that handed in no registry.
    tags: tagDoc,
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
  // THE BOARD'S TAG REGISTRY (lib/initiative-tags.js). Optional for a fixture, required for the tag routes: without it
  // GET/POST/PATCH/DELETE /api/initiatives/tags answer 503, and the read's `tags` is null. With it, the read hands the
  // registry over whole and the three writes go through its store.
  tags = null,
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
        tagStore: tags,
        evidenceFor: (member) => (evidence ? evidence.get(member.key) || null : null),
      }),
    );
  };

  // THE WAVE STORE'S KEY: the wave facts a memoised document was built against. The tab's read is a memo (cachedView)
  // and the waves route's read is live, and the two must never answer differently about a wave. The store's identity -
  // its file, whether it can be read, and its `mtimeMs:size` stamp - is the authority, so a document folded against
  // another store state is not an answer to this read. The member rows are in the key for the same reason: a wave's
  // open or closed state is folded from the tasks that name it, and a queue write is not a wave write, so nothing else
  // would notice one. Only rows that NAME a wave are in it: an unrelated task's churn costs no rebuild.
  const waveStoreKey = () => {
    if (!waves || typeof waves.statusOf !== "function") return "no-wave-store";
    const status = waves.statusOf();
    const stamp = typeof waves.stampOf === "function" ? waves.stampOf() : null;
    const members = [];
    for (const rec of Array.isArray(assistant?.assistants) ? assistant.assistants : []) {
      let queue = null;
      // THE QUEUE FILE, NOT THE DECORATED VIEW. `queueView` builds a queue context (every job summarised, every row
      // indexed) and this key is computed on every tab read; the key needs only the row's own fields, and
      // `readQueueFile` answers from its stat cache when nothing moved. Decoration adds the row and the run verdict, it
      // never rewrites `state`, `waveId`, `worktree` or the named abandonment.
      try {
        const file = typeof assistant?.queuePathOf === "function" ? assistant.queuePathOf(rec) : null;
        queue = file ? readQueueFile(file) : null;
      } catch {
        queue = null; // a queue that cannot be read is no wave fact; its own pane reports the error
      }
      for (const task of Array.isArray(queue?.tasks) ? queue.tasks : []) {
        const waveId = String(task?.waveId ?? "").trim();
        if (!waveId) continue;
        members.push(
          `${rec.id}:${task?.id ?? ""}:${waveId}:${String(task?.state || "")}:${task?.worktree ? "tree" : "no-tree"}:${JSON.stringify(task?.abandoned ?? null)}`,
        );
      }
    }
    members.sort();
    return JSON.stringify([status.file, status.found, status.readable, stamp, members]);
  };

  // THE READ ANSWERS AT ONCE AND REBUILDS BEHIND THE READER. The join is the tab's whole document but the expensive
  // part of it is the wave gate evidence (PR reads and landing judgements per member, lib/wave-evidence.js), which
  // measured 25-52s on 2026-11-23 while the panel walked the fleet - longer than the client's 12s timeout, so the tab
  // showed "the panel server did not answer" and never got a first document to cache. The last built document is
  // therefore kept (in memory and on disk beside the store): a read returns it immediately and a stale one schedules a
  // rebuild for the next read. A write still drops it and answers with a fresh build, so a change is never read back
  // from a cache built before it.
  //
  // THE MEMO CARRIES THE WAVE KEY IT WAS BUILT AGAINST (waveStoreKey). A read whose key does not match is answered by
  // a build, not by the memo: the waves route answers the store on every request, and a memo built against a different
  // store - a wave created, edited, removed, or a file that became unreadable - is exactly the pair of answers this
  // row exists to make impossible. The cost is one blocking fold after a wave change, which is the read that would
  // otherwise have shown a wave the other route says is there.
  let viewCache = loadViewCache(); // { at, doc, key }
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
      // A document written before the key existed cannot say which wave store it was built from, so it is loaded with
      // no key and the first read after this version rebuilds instead of answering it. It is rewritten with a key at
      // the end of that build, so the restart's fast answer is lost only once.
      if (raw && raw.doc && Array.isArray(raw.doc.initiatives)) {
        return { at: Number(raw.at) || 0, doc: raw.doc, key: typeof raw.key === "string" ? raw.key : null };
      }
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
  // ONE BUILD, TAKEN AGAINST ONE KEY. The document is folded live and kept only when the wave store (and the member
  // rows in the key) did not move while it was being folded: a document that cannot say which store it was built from
  // is not cached, so the next read rebuilds rather than answering a lane nobody can vouch for.
  function rebuildView(key = waveStoreKey()) {
    if (building) return building;
    building = (async () => {
      try {
        const doc = await view();
        viewCache = waveStoreKey() === key ? { at: Date.now(), doc, key } : null;
        if (viewCache) saveViewCache(viewCache);
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
    // THE WAVE STORE DECIDES WHETHER THIS MEMO IS AN ANSWER. GET /api/waves reads the store on every request; this
    // document is a memo, so it is served only while it was built against the store's current file, status and stamp.
    // When the store has moved the read waits for a fresh build rather than answering a lane the waves route would
    // contradict - the difference is a wave that exists and a tab that says it does not, or a store that is unreadable
    // and a tab that says it is fine.
    const key = waveStoreKey();
    if (viewCache && viewCache.key !== key) viewCache = null;
    if (viewCache) {
      if (Date.now() - viewCache.at > VIEW_STALE_MS && !building) {
        void rebuildView(key).catch(() => {
          /* the next read retries; this one already has a document to answer with */
        });
      }
      return viewCache.doc;
    }
    // A build already in flight was taken against whatever key it was started with. Wait for it, then answer only if
    // the document it left behind is this key's; otherwise fold again. One extra fold after a racing change is cheaper
    // than an answer the waves route disagrees with.
    if (building) {
      await building.catch(() => null);
      if (viewCache && viewCache.key === key) return viewCache.doc;
    }
    return rebuildView(key);
  };
  const dropView = () => {
    viewCache = null;
  };
  // THE WRITES, COMPOSED IN. routes/initiatives-write.js holds the tag registry, every write this prefix accepts and
  // the GET the tab draws; it is handed the store, the tier reader, the transport and the read's memo, so the moved
  // code reads the names it read here and the answer to a write is the document the memo would answer.
  const writes = createInitiativeWrites({
    INITIATIVES_PATH,
    TAGS_PATH,
    initiatives,
    tags,
    remoteWrites,
    projectForPath,
    sendJson,
    readBody,
    authorised,
    onChange,
    log,
    tierOf,
    actorOf,
    unreadable,
    view,
    cachedView,
    rebuildView,
    dropView,
    nameOf,
    archiveBlockers,
  });

  return async function initiativesRoutes(req, res, route, url) {
    if (route !== INITIATIVES_PATH && !route.startsWith(`${INITIATIVES_PATH}/`)) return false;
    const config = getConfig() || {};
    const params = url?.searchParams || new URL(req.url || "/", "http://127.0.0.1").searchParams;
    // The whole prefix answers through the write half: the tag registry, its own method guards, the GET, the body
    // parse and every write. The guard above keeps the prefix this file's; the read is the memo it built.
    return writes(req, res, route, url, config, params);
  };
}
