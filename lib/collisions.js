// COLLISIONS: two live runs in one project stepping on the same work, detected two-sided and carried as evidence.
//
// WHY THIS EXISTS. The board already knows, per row, what each tree is touching: its dirty files, its untracked
// files, and (on a live row) the files its own commits change since the branch it was cut from. What it never did was
// put two rows side by side. Two workers in one project can therefore write the same file, or one can be landing into
// the branch the other is still working on top of, and the first sign of it is a merge conflict or a lost edit - long
// after the reader could have ruled on it. This module answers ONE question, for every pair of live rows in a
// project: are these two touching the same work, and what is the evidence?
//
// THE EVIDENCE IS THE ANSWER, never a bare flag. Every pair names the shared paths it found, because "two workers are
// colliding" with no paths is a claim a reader cannot check and an assistant cannot act on. Two relations can produce
// a pair, and a third may only add context to one:
//
//   shared-file       both trees are touching a path the other is touching (dirty, untracked, or in a commit of its
//                     own since its parent). This is the ordinary two-workers-one-file case.
//   sibling           both trees were cut from the SAME parent branch and each has COMMITTED a change to the same
//                     path. Two children of one parent land into that parent, so the file is a conflict waiting in
//                     the drop zone both of them write to. This holds for ANY shared parent, not only a turnover
//                     branch: two branches cut from main that both change one file are one pair, not two unrelated
//                     collisions with main.
//   merge-target      one tree's BRANCH is the branch the other tree merges into (the other row's `parent`). This is
//                     CONTEXT and is never a reason on its own: a tree cut from main always has the primary checkout
//                     on main as its merge target, and filing on that alone is noise - four rows were filed that way
//                     in one night and every one was the reader's own checkout. The relation is added only to a pair
//                     that already names a shared file, so the sentence can say which way the work flows.
//
// ONE ORDER FOR A PAIR. `a` is always the side whose tree IDENTITY sorts first - the six-hex tag the panel's own
// rename keeps (lib/tree-names.js), the normalised path for a tree that carries none - so the same two trees produce
// the same record with the same sides whichever order the rows arrive in, across a rename, a rescan, a restart or a
// pair detected from the other side. A ruling stored as `pick: "a"` therefore keeps naming the same tree even when
// the directory under it has been renamed.
//
// MOST PAIRS SETTLE THEMSELVES. The order that makes the merge harder is git's question, not the reader's: the probe
// in `lib/collision-merge.js` asks `merge-tree` in both directions against the pair's two tips, `settleCollision` below
// turns the two answers into an order (exactly one clean direction names it; both clean is decided by the reader's own
// tie-break), and the sweep stores that as an automatic ruling through the same record a reader's ruling uses. Only a
// pair whose TWO directions conflict is still a card.
//
// WHO IS LIVE. A run's own activity is the scan's `live` flag (lib/scan.js: the newest of its last commit and its
// dirty files' mtimes, inside `liveMinutes`). A row that is not live is not a candidate: a dormant tree holding a
// file is not a worker stepping on anybody. This is deliberately the same flag the row draws, so a row that reads
// "quiet" can never be part of a collision the reader is told is live.
//
// THE COLLISION LINE. A worker can also see one coming before any scan does: it is about to run a migration another
// tree just changed, it is rewriting a fixture a sibling is rewriting. One line in its FINAL message says so -
//
//   COLLISION <the other tree: its path, directory name or branch> | <what you see coming, and the files>
//
// - parsed like QUEUE and MESSAGE (a leading marker, the pipe as the field break, so the text may contain anything),
// and filed against the REPORTING worker's tree. A note whose target resolves to another row of the same project is
// a reported collision and goes through the same resolution as a detected one.
//
// RESOLVED BY ABSENCE. A note whose target resolves to NO row and to NO live agent is not a question: there is no
// second side to order, so no ruling exists that the reader could give, and holding it on the Human button asks for a
// ruling nobody can make. It is recorded as `absent` - a VERDICT, kept with the words the worker wrote and the answer
// the board gave, drawn as settled and counted resolved by the chip. Only a target that names something ALIVE (a live
// run's tree, even one whose row is not written yet) still reaches the reader, because that is the one case where a
// person can see what the board cannot.
//
//
// THIS FILE IS THE ENTRY POINT, and the two halves are their own modules. The detection half - the vocabulary, the
// reason, the version line and the merge question, everything that answers "are these two colliding and in which
// order" - is `lib/collision-detect.js`, pure of git, jobs, HTTP and the store; the only thing it reads off the disk is
// a directory listing, when an untracked path is a directory and the files beneath it are the evidence (`filesUnder`).
// The store - `CollisionBook`, its one JSON document, `countStates`, and the readers that fold, order and upgrade a
// record - is `lib/collision-book.js`. Every name either half exports is re-exported below under the name importers
// have always read it by, so no import site moved when the pieces did. `lib/collision-flow.js` owns the sweep that
// files queue rows and escalates, `lib/collision-merge.js` owns the git probe, server.js owns the store instance and
// the snapshot overlay, and public/core/review-lane.js owns the Human rotation's arithmetic - each reads this module's
// one answer rather than re-deriving it.

// The exported names are unchanged on purpose: server.js, lib/collision-flow.js, lib/collision-merge.js, lib/jobs.js,
// routes/collisions.js and the six collision tests read them from here, and two of the names below (`stoodDownOf`,
// `treeIdentityOf`) have no reader at all today - they were exported before the move and stay exported after it.
export {
  COLLISION_VERSION,
  COLLISION_KEEP,
  COLLISION_FILES_CAP,
  COLLISION_NOTE_CAP,
  COLLISION_TARGET_CAP,
  COLLISION_RELATION_CAP,
  COLLISION_PASSES,
  COLLISION_PASS_MS,
  COLLISION_RESOLVED_KEEP_MS,
  COLLISION_STATES,
  COLLISION_RULES,
  ruleLabelOf,
  ruleOfRuling,
  relationOfRecord,
  reasonOf,
  COLLISION_LAND_RECHECK_MS,
  COLLISION_FACT_CAP,
  COLLISION_VERSION_CAP,
  normCollisionPath,
  treeIdentityOf,
  pairKey,
  reorderSides,
  filingKey,
  TASK_OPEN_STATES,
  taskOpen,
  sideTaskOf,
  owningTaskFor,
  sideOf,
  finishedSides,
  TOUCHED_DIR_CAP,
  filesUnder,
  touchedOf,
  isLiveRow,
  VERSION_CARRIERS,
  isVersionCarrier,
  versionInText,
  textWithoutVersion,
  compareVersionText,
  classifyVersionOnly,
  detectCollisions,
  parseCollisionLines,
  brokenCollisionLines,
  resolveCollisionTarget,
  relationSentence,
  targetTaskId,
  resolveCounterpart,
  targetNamesLiveAgent,
  reportAtOf,
  stateOf,
  waitingOf,
  deterministicPick,
  mergeComparedNothing,
  settleCollision,
  mayAskReader,
  stoodDownOf,
} from "./collision-detect.js";

// THE STORE is `lib/collision-book.js`: one JSON document beside the other per-row stores, the class every surface
// asks one question of, and the two counts the chip and a test read. Re-exported here under the same names, so an
// importer still reads `CollisionBook` and `countStates` from this path.
export { CollisionBook, countStates } from "./collision-book.js";
