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
// THE READS AND THE WRITES ARE THEIR OWN FILES. routes/initiatives-read.js holds the fold the tab draws
// (initiativesView) and the liveness the archive refusal names (archiveBlockers); routes/initiatives-write.js holds the
// tag registry, the GET and every POST/PATCH/DELETE. This file is the prefix's entry point: the path constants, the
// read's memo, the composition of the two halves, and the one delegation its callers reach.
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

// The store's tree-path normaliser, the one name this file still reads from it: the board row lookup keys on it below.
import { normTreePath } from "../lib/initiatives.js";
import { initiativeTierFrom } from "../lib/initiative-permissions.js";
// The wave store's own names: the member rows are keyed the way the fold keys them, and the two evidence reads size
// the gates this file's evidence reader asks for.
import { taskWithOwner, waveEvidenceNeeds, waveFileExistsPaths } from "../lib/waves.js";
// The queue FILE, not the decorated view: the memo's membership key reads the row's own fields (see waveStoreKey).
import { readQueueFile } from "../lib/assistant/queue.js";
// The read's cache is a file beside the store (see cachedView): the tab's first read after a restart must not wait on
// the evidence join.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
// The read's own phase clock (off unless the request asks with `?profile=1`): a seam times itself so a slow answer can
// be cut at the seam that is slow rather than at the total.
import { timeAsync, timeSync } from "../lib/read-profile.js";
// The read half (the fold and the blockers) and the write half, one file each; this file composes them.
import { archiveBlockers, initiativesView, nameOf } from "./initiatives-read.js";
import { createInitiativeWrites } from "./initiatives-write.js";
// THE FOLD AND THE BLOCKERS KEEP THEIR OLD ADDRESS FOR CALLERS. server.js and the tests import them from here, so the
// parent re-exports what it no longer declares.
export { archiveBlockers, initiativesView };

/** The one path this prefix answers, and the row the mount table in server.js matches on. */
export const INITIATIVES_PATH = "/api/initiatives";
/** The board's tag registry, under the same prefix: `/api/initiatives/tags` (GET/POST/PATCH/DELETE). */
export const TAGS_PATH = `${INITIATIVES_PATH}/tags`;

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
