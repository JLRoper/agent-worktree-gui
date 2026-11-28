// The initiatives read: the fold the tab draws and the liveness the archive refusal names.
//
// WHY THIS FILE EXISTS. routes/initiatives.js answers the prefix: it holds the path constants, the read's memo, the
// composition of the two halves and the one delegation its callers reach. The two things that decide the SHAPE of that
// answer are here, so a read-shape change and a write change are no longer the same file:
//
//   initiativesView  folds the store, every assistant's queue and the wave lane into the document the tab draws;
//   archiveBlockers  names what under an initiative is still open, which is the archive refusal's whole sentence.
//
// Both are pure: every seam (which project a path belongs to, what the board row says, the evidence behind a gate) is a
// function handed in by the composition root, so a fixture can run the fold without a server.
//
// THE MOVE IS VERBATIM. The code below is routes/initiatives.js lines 94-436 of the b4f88ad9 blob, byte for byte (343
// lines, sha256 3296a0418243f855f9dc707f40d1587852c0fb9bb3720e4da2ba149013f27bda): the read half left that file in row
// 516 and nothing in it was reworded. nameOf rides out with the fold it serves and is published for the parent's write
// composition, which names a tree in the move question; the fold and the blockers are re-exported by the parent, so
// every caller still imports routes/initiatives.js.

import { DESCRIPTION_MAX, NOTE_LABEL_MAX, NOTE_TEXT_MAX, NOTE_URL_MAX, NOTES_MAX, TITLE_MAX, normTreePath } from "../lib/initiatives.js";
// The board's tag registry: its store's view, the caps the tab prints and the id a card carries. The read joins the two
// stores by id here (and only here), so a card never stores a word the registry could have renamed.
import { TAG_DESCRIPTION_MAX, TAG_IDENT_MAX, TAG_IDENT_MIN, TAG_NAME_MAX, tagsView } from "../lib/initiative-tags.js";
import { initiativeTierInfo, INITIATIVE_TIER_INFO } from "../lib/initiative-permissions.js";
import { WAVE_GATE_CHOICES, taskWithOwner, waveIsOpen, waveLane, waveMemberOpen } from "../lib/waves.js";
// The thread a row is on NOW, which is the last one it was carried by (lib/assistant/queue.js `currentThread`): the
// task fold names the run and the thread the same way the queue tab does, from the row itself.
import { currentThread } from "../lib/assistant/queue.js";
// The read's own phase clock (off unless the request asks with `?profile=1`): a seam times itself so a slow answer can
// be cut at the seam that is slow rather than at the total.
import { timeSync } from "../lib/read-profile.js";

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

// THE PARENT'S WRITE COMPOSITION NAMES A TREE, so this helper keeps its one other reader reachable. It is not part of
// the prefix's export surface: routes/initiatives.js passes it to createInitiativeWrites and publishes nothing new.
export { nameOf };
