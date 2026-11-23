// ---- what a stream push has to say, once the reader already has the board ------------------------
// A full snapshot is ~4.4 MB on a board of 185 projects: every project row, every job transcript, the assistant,
// the settings. It is the right frame for a FIRST load - the page has nothing yet - and it is what the stream used
// to push after every write as well, because every one of the ~25 write sites called `broadcastSnapshot()`. Measured
// on the live panel: a `todo` edit sent 4.29 MB to every open tab, of which 1.95 MB was project rows the tab already
// held and 2.03 MB was job transcripts that had not changed at all.
//
// This module answers the narrow question that removes the repetition: given the state a client already has and the
// state now, what is the smallest frame that takes it from one to the other? It is pure - no store, no socket, no
// clock of its own - so a test can drive it with two literals, and it returns `null` when nothing changed at all so
// a push that would say nothing sends nothing.
//
// THE SHAPE, and why it is this shape. A delta is not "the snapshot minus a field"; it is the panes that changed
// plus the rows and cards that changed:
//
//   { delta: true, generatedAt,
//     assistant, approvals, remoteWrites, settings, hosts, paths, treeList, spawn, skipped, scanRoots, stats,
//                                                                   // only the keys whose value moved
//     projects: [{ name, added?, <project fields that moved> }],    // never `worktrees` - rows travel below
//     rows:     [{ project, row }],                                 // the rows whose content moved, whole
//     jobs:     [ <summary> ],                                      // the job cards whose content moved, whole
//     droppedRows:    [{ project, path }],
//     droppedProjects: [name],
//     droppedJobs:    [id] }
//
// A row that DID move travels whole rather than field by field: the page replaces a row object wholesale when a
// `row` frame arrives (public/render-projects.js placeRow), so a half row would be drawn as a row with holes. A job
// card travels whole for the same reason - `updateJob` merges one card, exactly as a `job` frame does.
//
// AGE, AND WHY IT IS NOT A CHANGE. Every todo item carries `ageMs`, computed as `now - at` at build time, and the
// board frame and the full snapshot are two builds a few hundred ms apart - so every row with a todo item differs
// between them by that one derived number and nothing else (measured: 189 of 190 such rows). Comparing it would
// re-send 900 KB of unchanged todo lists on every attach, so the comparison normalises it. The page's ages stay
// current another way: each row is re-read by the scanner on its own clock and arrives as a `row` frame, which is
// where a fresh age comes from, and a full /api/state read (the page's own anti-entropy) refreshes every row.
const AGE_FIELD = "ageMs";

// A value as a string that ignores the derived age. Two values with the same fingerprint are the same to a reader.
function fingerprint(value) {
  if (value === undefined) return "undefined";
  return JSON.stringify(value, (key, v) => (key === AGE_FIELD ? 0 : v));
}

// The identity a row's print is kept under. Local to this module (the wire carries project + path, or a whole row),
// so it never has to match the page's own key format.
const rowKey = (project, path) => `${project}::${path}`;

/** One row's print: what a client would have to be told before its row is out of date. */
export function rowFingerprint(row) {
  return fingerprint(row);
}

/** Every row's print in a snapshot, keyed the way `snapshotDelta`'s `printOf` expects. */
export function snapshotRowPrints(snapshot) {
  const out = new Map();
  for (const project of (snapshot && Array.isArray(snapshot.projects) ? snapshot.projects : [])) {
    for (const row of (Array.isArray(project.worktrees) ? project.worktrees : [])) out.set(rowKey(project.name, row.path), fingerprint(row));
  }
  return out;
}

// The smallest frame that takes a client from `prev` to `next`, or null when it is already there.
//
// `prev` may be null (a client that has nothing yet): every pane, every project field and every row is then part
// of the answer. That case is still legal and still smaller than the full frame for one reason only - the client
// that asked for it already applied the board frame (projects, settings, hosts, tree list), so what is left is the
// decorators. See lib/http/transport.js.
//
// `printOf` (optional) is the ledger of row prints the clients ACTUALLY HOLD - the last row each path was told, from
// a snapshot frame, a delta or a `row` frame of its own. A row whose print is unchanged has already reached the
// client by another route and is not sent again: on a board being scanned, that is what keeps a push to the one row
// an edit touched instead of the few hundred a scan re-read in the same minute. Without it the comparison falls back
// to `prev`'s rows, which is correct but re-sends everything a scan has said since the last push.
export function snapshotDelta(prev, next, { printOf = null } = {}) {
  if (!next || typeof next !== "object") return null;
  const out = { delta: true, generatedAt: next.generatedAt || new Date().toISOString() };
  let changed = false;

  // The panes. `projects` and `jobs` are the two handled structurally below; generatedAt is the frame's own stamp.
  for (const key of Object.keys(next)) {
    if (key === "projects" || key === "jobs" || key === "generatedAt") continue;
    if (!prev || fingerprint(prev[key]) !== fingerprint(next[key])) {
      out[key] = next[key];
      changed = true;
    }
  }

  const before = new Map();
  for (const project of prev && Array.isArray(prev.projects) ? prev.projects : []) before.set(project.name, project);
  const after = new Map();
  for (const project of Array.isArray(next.projects) ? next.projects : []) after.set(project.name, project);

  const projects = [];
  const rows = [];
  const droppedRows = [];
  for (const [name, project] of after) {
    const old = before.get(name) || null;
    // The project's own fields (its totals, its activity, its empty flag): `worktrees` is the row list and travels
    // as rows, so it is neither compared nor copied here.
    const fields = { name };
    let touched = false;
    for (const key of Object.keys(project)) {
      if (key === "worktrees" || key === "name") continue;
      if (!old || fingerprint(old[key]) !== fingerprint(project[key])) {
        fields[key] = project[key];
        touched = true;
      }
    }
    const oldRows = new Map();
    for (const row of old && Array.isArray(old.worktrees) ? old.worktrees : []) oldRows.set(row.path, row);
    const newRows = new Map();
    for (const row of Array.isArray(project.worktrees) ? project.worktrees : []) newRows.set(row.path, row);
    for (const [path, row] of newRows) {
      const print = fingerprint(row);
      const held = printOf ? printOf.get(rowKey(name, path)) : undefined;
      const was = held !== undefined ? held : oldRows.has(path) ? fingerprint(oldRows.get(path)) : null;
      if (was !== print) rows.push({ project: name, row });
    }
    for (const path of oldRows.keys()) {
      if (newRows.has(path)) continue;
      droppedRows.push({ project: name, path });
      touched = true;
    }
    // A project the client has never been told about: its section has to be BUILT, not merged, so the flag travels
    // (the page answers it with renderAll). Its rows are all in `rows`, because every one of them is new.
    if (!old) {
      fields.added = true;
      touched = true;
    }
    if (touched) projects.push(fields);
  }

  // THE JOB PANE, ONE CARD AT A TIME. `jobs` is a list of summaries the page replaces wholesale, so a push that
  // carried it would re-send every transcript on the board (1.13 MB measured on 74 cards) to say that one todo item
  // moved. The summaries travel as the changed ones only, the same way rows do; the page's own `job` frame already
  // merges one card, so this is a shape it can apply without a rebuild.
  if (Array.isArray(next.jobs)) {
    const beforeJobs = new Map();
    for (const job of prev && Array.isArray(prev.jobs) ? prev.jobs : []) beforeJobs.set(job.id, job);
    const afterJobs = new Map();
    for (const job of next.jobs) afterJobs.set(job.id, job);
    const jobList = [];
    for (const [id, job] of afterJobs) {
      const was = beforeJobs.get(id);
      if (!was || fingerprint(was) !== fingerprint(job)) jobList.push(job);
    }
    const goneJobs = [...beforeJobs.keys()].filter((id) => !afterJobs.has(id));
    if (jobList.length) {
      out.jobs = jobList;
      changed = true;
    }
    if (goneJobs.length) {
      out.droppedJobs = goneJobs;
      changed = true;
    }
  }

  const gone = [...before.keys()].filter((name) => !after.has(name));

  // A row the tab was TOLD about (by a row frame the last push never knew of) that the new state no longer has: it
  // has to be named, or the page keeps a row nothing will ever repaint. `drop` frames normally carry this; the ledger
  // is the belt to that brace, and a drop for a row already gone is a no-op on the page.
  if (printOf) {
    const sent = new Set(droppedRows.map((d) => rowKey(d.project, d.path)));
    for (const [name, project] of after) {
      for (const row of Array.isArray(project.worktrees) ? project.worktrees : []) sent.add(rowKey(name, row.path));
    }
    for (const key of printOf.keys()) {
      if (sent.has(key)) continue;
      const at = key.indexOf("::");
      droppedRows.push({ project: key.slice(0, at), path: key.slice(at + 2) });
    }
  }
  if (gone.length) {
    out.droppedProjects = gone;
    changed = true;
  }
  if (projects.length) {
    out.projects = projects;
    changed = true;
  }
  if (rows.length) {
    out.rows = rows;
    changed = true;
  }
  if (droppedRows.length) {
    out.droppedRows = droppedRows;
    changed = true;
  }
  if (gone.length) {
    out.droppedProjects = gone;
    changed = true;
  }
  return changed ? out : null;
}
