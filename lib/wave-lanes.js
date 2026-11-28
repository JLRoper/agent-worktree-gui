// THE LANES INSIDE A WAVE: the read that derives them, the clash that refuses them, and the join that closes them in
// ONE commit. This is the half of lib/waves.js a lane change edits; lib/waves.js imports it and re-exports every name
// it published before the cut (row 509, module-separation report entry #13), so no import site moved and the module's
// surface is unchanged.
//
// WHAT IT IS MADE OF. The section below states the three rules a lane obeys - derived on every read and never stored
// on the wave, a lane set that shares a tree refused rather than isolated, and a close that is one commit naming every
// lane - and the dependencies are the modules that already own those rules: the queue's file-intersection rule
// (lib/assistant/queue.js), the aggregate's one-commit merge and its message (lib/pipeline-aggregate.js,
// lib/pipeline-fanout.js), and the fan-out's isolation word. Nothing here restates them.
//
// THE MEMBER WORDS LIVE HERE BECAUSE THE LANE FOLD READS THEM FIRST. `clip`, `namedAbandon`, `waveMemberClosed` and
// `waveMemberOpen` are the vocabulary a member's own record is read with: a lane's state is its members' states, and
// the store and the gate read that stayed in lib/waves.js ask the same questions. They are exported here and imported
// there - the one direction that keeps the two files acyclic - and they are the same functions they were.
//
// WHAT IT DOES NOT DO. Nothing here schedules, advances or switches anything: `waveLanes` folds the members' records,
// `readWaveLane` answers whether a lane can be pinned, and `joinWaveLanes` runs only when a caller supplies a tree, a
// base and the lanes it read.
import { TASK_LANE_MAX, TASK_STATES, intersectingFiles } from "./assistant/queue.js";
import { aggregateBranches } from "./pipeline-aggregate.js";
import { aggregateMessage, aggregateRecord, ISOLATION_PER_STAGE } from "./pipeline-fanout.js";

// A string clipped to a cap. The one shape both halves write with: a lane clips its own name to the queue's lane cap,
// and the store clips a title, an actor and a wave id. Exported for lib/waves.js and never re-exported from there - it
// was not on that module's surface before the cut, so this cut adds it to neither.
export const clip = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n) : t;
};

// A member abandoned for a NAMED reason, or null. `abandoned` without a reason is a status word, and a status word
// cannot close a gate: namedAbandon answers null for it and the caller answers cannot tell.
export const namedAbandon = (m) => {
  const raw = m && m.abandoned;
  const reason = typeof raw === "string" ? raw : String(raw && raw.reason ? raw.reason : "");
  const cleaned = reason.replace(/\s+/g, " ").trim();
  return cleaned ? { reason: clip(cleaned, 240), at: raw && typeof raw === "object" ? raw.at || null : null, by: raw && typeof raw === "object" ? raw.by || null : null } : null;
};

/**
 * A MEMBER IS CLOSED when its row reads done, or when a person abandoned it for a named reason - the fold's own
 * definition of finished work (`deriveWaveState` in lib/waves.js closes a wave on exactly this test). Exported
 * because the initiatives tab asks the same question of a whole initiative before it archives one: two ideas of
 * "open" in one panel would archive work somebody is still doing, so the archive refusal in routes/initiatives.js
 * reads THIS function, never its own copy of the rule.
 */
export const waveMemberClosed = (member) => Boolean(member) && (member.state === "done" || Boolean(namedAbandon(member)));
export const waveMemberOpen = (member) => Boolean(member) && !waveMemberClosed(member);

// ---- lanes inside a wave ------------------------------------------------------------------------------------------
// A LANE is a set of the wave's members that touch a common file, or a set a member names on its own record, and it
// runs beside the wave's other lanes rather than after them. Three rules decide this section:
//
//   1. A LANE IS DERIVED, NEVER STORED ON THE WAVE. The wave record has no `lanes` field (pickWave drops one a reader
//      writes by hand), because a lane list on the wave would be the second copy of a fact the members already carry.
//      A member that names a lane keeps that name; the rows that name none are grouped by the file rule the queue
//      already applies (lib/assistant/queue.js `intersectingFiles`: two rows that claim a common file are one lane,
//      because one of them waits for the other), and the rows that share a file with nobody are the UNLANED lane.
//      When every member lands in that one lane the wave holds ONE IMPLICIT LANE: today's wave, folded and drawn
//      exactly as it was, with nothing new on the record and no join owed.
//   2. A LANE SET THAT SHARES A TREE IS REFUSED. A lane runs in its own trees and never a sibling's
//      (lib/pipeline-fanout.js rule 2: one lane, one tree), so two lanes naming one tree cannot be isolated. This
//      module does not repeat the rule, it reads the members' trees and refuses the set with the lanes and the tree.
//   3. THE JOIN IS ONE COMMIT, AND ITS MESSAGE NAMES THE LANE SET. `joinWaveLanes` hands the lanes' PINNED commits to
//      lib/pipeline-aggregate.js, which pre-flights every lane over the object database and then builds ONE commit
//      with one parent per lane; the message is the aggregate's own builder, with the wave's id where a pipeline
//      names its join stage. A pin is a commit AND a blob (lib/stage-pin.js, through lib/wave-evidence.js): this repo
//      squashes, so the landed sha is rewritten, and the blob is the half of the pin that still names what landed.
//
// NOTHING HERE SCHEDULES. A lane set is read on every read and a join runs only when a caller supplies a tree, a base
// and the lanes it read. There is no timer, no automatic advance and no switch.
//
// The label a lane of members that name none is drawn and merged under. A file path is a lane's own name; this word is
// the one the panel adds, and it says exactly what those members did: none of them named a lane.
export const WAVE_LANE_UNLANED = "unlaned";
// A lane folds to one of the queue's own four states. It is a word about its members, never a stored field.
export const WAVE_LANE_STATES = Object.freeze([...TASK_STATES]);

// A path key: the same normalisation the queue gives a claimed file, so a lane named `lib/X.js` and a member claiming
// `.\lib\x.js` land in one lane rather than two. `text` is also the gate read's trimmer (lib/waves.js), which is why it
// is exported here and imported there.
export const text = (value) => String(value ?? "").trim();
const normPath = (value) =>
  String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();
const byMemberId = (a, b) => (Number(a?.id) || 0) - (Number(b?.id) || 0) || String(a?.id ?? "").localeCompare(String(b?.id ?? ""));

/**
 * The lane a member's OWN record names, or null. A row written before lanes existed names none, and the derivation
 * below groups it by the files it claims instead - a member is never given a lane the wave invented for it.
 */
export function waveLaneNamed(member) {
  const raw = member && member.lane != null ? String(member.lane) : "";
  const name = raw.replace(/\s+/g, " ").trim();
  return name ? clip(name, TASK_LANE_MAX) : null;
}

// A lane's state, folded from its members: a running member holds the lane, a parked one that nobody abandoned for a
// named reason parks it, every member closed makes it done, and anything else is queued. Never stored.
function waveLaneStateOf(members) {
  const list = Array.isArray(members) ? members : [];
  if (list.some((m) => m && m.state === "running")) return "running";
  if (list.some((m) => m && m.state === "parked" && !namedAbandon(m))) return "parked";
  if (list.length && list.every(waveMemberClosed)) return "done";
  return "queued";
}

// The members that owe the join a pin: one that ran (done or parked), or one already given a tree. A queued member
// that never got a tree owes nothing - the design lets a wave close with a member still queued for a follow-up.
const waveLaneOwes = (member) =>
  Boolean(member) && (Boolean(String(member.worktree || "").trim()) || member.state === "done" || member.state === "parked");

/**
 * One lane's read: can this lane be named as a thing that ran, and in which trees? It never throws, and the answer a
 * caller must not mistake for a pass is `ok: false` - a member that ran and names no tree makes the lane unpinnable,
 * and "cannot tell" is a first-class answer here exactly as it is on a gate.
 */
export function readWaveLane(lane) {
  const record = lane && typeof lane === "object" ? lane : {};
  const members = Array.isArray(record.members) ? record.members : [];
  const label = String(record.label || record.name || WAVE_LANE_UNLANED);
  if (!members.length) return { ok: false, cannotTell: true, trees: [], why: `lane ${label} has no member` };
  const owed = members.filter((m) => waveLaneOwes(m));
  const blind = owed.filter((m) => !String(m.worktree || "").trim());
  if (blind.length) {
    const ids = blind.map((m) => `#${m.id ?? "?"}`).join(", ");
    return {
      ok: false,
      cannotTell: true,
      trees: [],
      why: `${ids} ${blind.length === 1 ? "has" : "have"} run but ${blind.length === 1 ? "names" : "name"} no tree, so lane ${label} cannot be pinned to what it produced`,
    };
  }
  const trees = [...new Set(owed.map((m) => String(m.worktree).trim()).filter(Boolean))];
  return { ok: true, cannotTell: false, trees, why: `lane ${label} names ${trees.length} tree${trees.length === 1 ? "" : "s"}` };
}

/**
 * The groups of members that claim a common file, each named by the lowest path the group shares. The intersection
 * rule is the queue's own (`intersectingFiles`); what is added here is only the GROUPING - a disjoint set per lane -
 * so the wave and the queue cannot end up with two ideas of which rows touch one file. A group of one is not a lane
 * of its own: it comes back with no name and the caller puts it in the unlaned lane.
 */
function waveFileLanes(members) {
  const list = Array.isArray(members) ? members : [];
  const claiming = list.filter((m) => Array.isArray(m.files) && m.files.length);
  const alone = list.filter((m) => !(Array.isArray(m.files) && m.files.length)).map((m) => ({ name: null, members: [m] }));
  if (claiming.length < 2) return [...claiming.map((m) => ({ name: null, members: [m] })), ...alone];
  const parent = new Map(claiming.map((m) => [m, m]));
  const label = new Map();
  const rootOf = (m) => {
    let at = m;
    while (parent.get(at) !== at) at = parent.get(at);
    return at;
  };
  const join = (a, b, shared) => {
    const ra = rootOf(a);
    const rb = rootOf(b);
    const best = [...shared, label.get(ra), label.get(rb)].filter(Boolean).sort()[0] || null;
    if (ra === rb) {
      label.set(ra, best);
      return;
    }
    parent.set(rb, ra);
    label.set(ra, best);
  };
  for (let i = 0; i < claiming.length; i += 1) {
    for (let j = i + 1; j < claiming.length; j += 1) {
      const shared = intersectingFiles(claiming[i].files, claiming[j].files).map(normPath).filter(Boolean).sort();
      if (shared.length) join(claiming[i], claiming[j], shared);
    }
  }
  const groups = new Map();
  for (const member of claiming) {
    const root = rootOf(member);
    if (!groups.has(root)) groups.set(root, { name: label.get(root) || null, members: [] });
    groups.get(root).members.push(member);
  }
  return [...groups.values(), ...alone];
}

// The one refusal a lane set can earn: two lanes that name one tree. A definite fact about the record, so a wave
// answers `blocked` on it rather than cannot tell - the reader is not blind, the lane set is wrong.
function waveLaneClash(lanes) {
  const holder = new Map();
  const clashes = [];
  for (const lane of lanes) {
    for (const tree of lane.trees) {
      const key = normPath(tree);
      if (!key) continue;
      const held = holder.get(key);
      if (!held) {
        holder.set(key, lane);
        continue;
      }
      if (held.key === lane.key) continue;
      clashes.push({ tree, lanes: [held.label, lane.label] });
    }
  }
  const unique = [];
  for (const clash of clashes) if (!unique.some((c) => c.tree === clash.tree)) unique.push(clash);
  if (!unique.length) return null;
  const sentence = "two lanes that share a tree can read each other's files, which is the one thing a lane exists to prevent";
  const first = unique[0];
  const why =
    unique.length === 1
      ? `lane ${first.lanes[0]} and lane ${first.lanes[1]} share the tree ${first.tree} - ${sentence}`
      : `${unique.length} trees are held by two lanes (${unique
          .slice(0, 3)
          .map((c) => `${c.tree}: ${c.lanes.join(" + ")}`)
          .join("; ")}${unique.length > 3 ? `, and ${unique.length - 3} more` : ""}) - ${sentence}`;
  return { trees: unique.map((c) => c.tree), lanes: unique.flatMap((c) => c.lanes), why };
}

/**
 * The wave's lanes, DERIVED from its members on every read. `{lanes, count, implicit, joinOwed, isolation, refused}`:
 * `implicit` says the wave holds the one lane the panel made up (today's wave), `joinOwed` says two or more lanes are
 * held so a close is a join, and `refused` is the lane set's own sentence when two lanes share a tree.
 */
export function waveLanes(members = [], { readLane = readWaveLane } = {}) {
  const list = (Array.isArray(members) ? members : []).filter((m) => m && typeof m === "object");
  // A member that NAMES a lane keeps it: the name is its own record's, never the wave's.
  const buckets = new Map();
  const free = [];
  for (const member of list) {
    const name = waveLaneNamed(member);
    if (!name) {
      free.push(member);
      continue;
    }
    const key = normPath(name) || name;
    if (!buckets.has(key)) buckets.set(key, { name, members: [] });
    buckets.get(key).members.push(member);
  }
  // A member that names none is grouped by the queue's file rule; one that shares a file with nobody is unlaned.
  const unlaned = [];
  for (const group of waveFileLanes(free)) {
    if (group.members.length < 2 || !group.name) {
      unlaned.push(...group.members);
      continue;
    }
    const key = normPath(group.name) || group.name;
    if (!buckets.has(key)) buckets.set(key, { name: group.name, members: [] });
    buckets.get(key).members.push(...group.members);
  }
  if (unlaned.length) {
    if (!buckets.has(WAVE_LANE_UNLANED)) buckets.set(WAVE_LANE_UNLANED, { name: null, members: [] });
    buckets.get(WAVE_LANE_UNLANED).members.push(...unlaned);
  }
  // Named lanes in path order, the unlaned lane last: a wave's lane set reads the same on every request.
  const keys = [...buckets.keys()].sort((a, b) => (a === WAVE_LANE_UNLANED ? 1 : b === WAVE_LANE_UNLANED ? -1 : a.localeCompare(b)));
  const lanes = keys.map((key) => {
    const bucket = buckets.get(key);
    const own = bucket.members.slice().sort(byMemberId);
    const lane = {
      key,
      name: bucket.name || null,
      label: bucket.name || WAVE_LANE_UNLANED,
      state: waveLaneStateOf(own),
      memberIds: own.map((m) => (m.id == null ? null : m.id)).filter((id) => id !== null),
      members: own,
      trees: [...new Set(own.map((m) => String(m.worktree || "").trim()).filter(Boolean))],
      files: [...new Set(own.flatMap((m) => (Array.isArray(m.files) ? m.files : [])).map((f) => String(f).trim()).filter(Boolean))],
    };
    return { ...lane, read: readLane(lane) };
  });
  return {
    lanes,
    count: lanes.length,
    implicit: lanes.length === 1 && !lanes[0].name,
    joinOwed: lanes.length >= 2,
    // The model every lane runs under is the fan-out's own word, so a reader of the lane set reads the same isolation
    // a per-stage pipeline names rather than a second dialect for one idea.
    isolation: ISOLATION_PER_STAGE,
    refused: waveLaneClash(lanes),
  };
}

/**
 * CLOSE A WAVE: join its lanes in ONE commit.
 *
 * The caller supplies the tree to merge into and its base, because a wave owns no tree (rule 1); the lanes are the
 * ones a read derived, each carrying what it settles at: either the pins `readWaveLanePins` answered (`pins`, the
 * shape lib/wave-evidence.js returns, so the two compose with no glue) or its members each with a `pin`
 * naming their commit. The merge is lib/pipeline-aggregate.js's own: every lane pre-flighted over the object database
 * first, then ONE commit with one parent per lane, verified against the tree the pre-flight produced. A conflict is a
 * refusal that names the paths, not a half-made merge.
 *
 * `aggregate` is the merge itself, taken as an argument so a test can answer every shape without a repository. The
 * function refuses rather than guessing: a wave with one lane has nothing to join, a lane with no pinned commit
 * cannot be merged by a branch name (lib/stage-pin.js rule 1), and a lane with nothing that ran cannot be named.
 */
export function joinWaveLanes({ wave, lanes = [], tree = null, base = null, aggregate = aggregateBranches, at = null } = {}) {
  const record = wave && typeof wave === "object" ? wave : null;
  const waveId = record ? String(record.id || "").trim() : "";
  const refuse = (code, reason) => ({
    ok: false,
    code,
    merged: false,
    alreadyMerged: false,
    commit: null,
    tree: null,
    written: null,
    verified: false,
    conflicts: [],
    parents: 0,
    checkedOut: false,
    wave: waveId || null,
    lanes: [],
    branches: [],
    message: null,
    record: null,
    reason,
  });
  if (!waveId) return refuse("wave-join-input", "there is no wave to name the join");
  const set = (Array.isArray(lanes) ? lanes : []).filter((lane) => lane && typeof lane === "object");
  if (set.length < 2) {
    return refuse(
      "wave-join-input",
      `wave ${waveId} holds ${set.length || "no"} lane${set.length === 1 ? "" : "s"} - a join is owed by two or more, and a single lane would be a commit that changes nothing`,
    );
  }
  const where = String(tree || "").trim();
  if (!where) return refuse("wave-join-input", `wave ${waveId}'s join needs the tree to merge into: a wave owns no tree, so the caller names one`);
  const perLane = set.map((lane) => {
    const label = String(lane.label || lane.name || WAVE_LANE_UNLANED);
    // Two shapes, one meaning: a lane may carry the pins `readWaveLanePins` answered, or its own members each with a
    // pin. A member with neither is unpinned, and an unpinned lane is a refusal rather than a merge from a branch.
    const pins = lane.pins && Array.isArray(lane.pins.members) ? lane.pins.members : null;
    const rows = pins
      ? pins.map((pin) => ({ id: pin && pin.member, tree: text(pin && pin.tree), commit: text(pin && pin.commit), ok: !pin || pin.ok !== false, why: text(pin && pin.why) }))
      : (Array.isArray(lane.members) ? lane.members : []).map((member) => {
          const pin = member && member.pin && typeof member.pin === "object" ? member.pin : null;
          return {
            id: member && member.id != null ? member.id : "?",
            tree: text(member && (member.worktree || member.tree)),
            commit: text(pin && pin.commit),
            ok: Boolean(pin && text(pin.commit)),
            why: "",
          };
        });
    const items = [];
    const unpinned = [];
    for (const row of rows) {
      // A pin that was READ and answered `ok: false` is not a pin: the commit may resolve while the file it claimed
      // does not, and merging it would land a lane whose content the panel could not name.
      if (!row.ok || !row.commit || !row.tree) {
        unpinned.push({ text: `${label} #${row.id == null ? "?" : row.id}`, why: row.why });
        continue;
      }
      items.push({ stage: `${label} #${row.id}`, branch: row.tree, commit: row.commit });
    }
    return { label, items, unpinned };
  });
  const unpinned = perLane.flatMap((lane) => lane.unpinned);
  if (unpinned.length) {
    const first = unpinned[0];
    return refuse(
      "wave-join-input",
      `${unpinned.map((row) => row.text).join(", ")} ${unpinned.length === 1 ? "has" : "have"} no pin that reads${first.why ? `: ${first.why}` : " - no commit and no tree were named"} - a lane is merged by the commit it settled at, never by the branch it happens to carry (lib/stage-pin.js rule 1)`,
    );
  }
  const empty = perLane.filter((lane) => !lane.items.length).map((lane) => lane.label);
  if (empty.length) {
    return refuse("wave-join-input", `${empty.join(", ")} ${empty.length === 1 ? "names" : "name"} nothing that ran, so ${empty.length === 1 ? "it cannot" : "they cannot"} be named in the join`);
  }
  const branches = perLane.flatMap((lane) => lane.items);
  const message = aggregateMessage({ id: waveId }, { join: waveId }, branches, base);
  let result;
  try {
    result = aggregate({ tree: where, base, branches, message, at });
  } catch (error) {
    return refuse("wave-join", `the aggregate threw: ${String((error && error.message) || error)}`);
  }
  const wrote =
    result && result.ok && result.merged
      ? aggregateRecord({ commit: result.commit, base, branches, at, tree: { path: where }, verified: Boolean(result.verified) })
      : null;
  return {
    ok: Boolean(result && result.ok),
    code: (result && result.code) || null,
    merged: Boolean(result && result.merged),
    alreadyMerged: Boolean(result && result.alreadyMerged),
    commit: (result && result.commit) || null,
    tree: (result && result.tree) || null,
    written: (result && result.written) || null,
    verified: Boolean(result && result.verified),
    conflicts: result && Array.isArray(result.conflicts) ? result.conflicts : [],
    parents: result && Number.isFinite(result.parents) ? result.parents : null,
    checkedOut: Boolean(result && result.checkedOut),
    wave: waveId,
    lanes: perLane.map((lane) => lane.label),
    branches,
    message,
    record: wrote,
    reason: (result && result.reason) || null,
  };
}
