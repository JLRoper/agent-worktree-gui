// The Collisions history's pure half: what a record IS to a reader, the order it takes, the filter, and the honest cap.
//
// The popup (public/collision-history.js) owns the DOM, the fetch and the geometry. Everything a test wants to pin down
// without a browser lives here, in the same shape as public/core/clarify-history.js: one global object, no DOM and no
// clock except the one passed in.
//
// WHY A RECORD HAS A STATE OF ITS OWN. The store (lib/collisions.js) knows four states a record can be in - assistants,
// reader, ruled, superseded, absent - and the reader cares about five things:
//
//   waiting     the pair is handed to a person and nobody has ruled. The header badge counts THESE, nothing else.
//   queued      still in the assistants' pass: a notice sits in one or both queues and the panel has not asked anybody.
//   ruled       settled, by git's merge answer, by the reader's standing order (older cut, fewer commits, branch name),
//               by the version line, or by a person. The record says WHICH, and that is the reason field.
//   superseded  a landing carried one side into main after the pair was stamped. History, naming the commit.
//   absent      a verdict: no second side lives, so no order exists for a person to give. History, naming why.
//
// THE BADGE IS `isWaiting`, ONE PREDICATE. A record with a side whose own queue task is done or parked is not waiting
// either (lib/collisions.js `finishedSides`): the work it was about has been laid down. Every count and every list in
// this file reads that one function, so the number on the button and the rows it opens cannot disagree.
//
// THE FILTER NAMES THE THREE THINGS A READER SEARCHES BY: the row (a tree's directory, path or task number), the
// branch, and the file. Every token typed must be found somewhere in the record's own text, so "lib/x.js worker-two"
// narrows to the one pair that names both. Nothing is derived from the record that the record does not carry.
(function (root) {
  "use strict";

  /** Rows drawn before the reader asks for the rest. The footer names the total either way. */
  const RENDER_CAP = 50;
  const STATES = ["waiting", "queued", "ruled", "superseded", "absent"];

  // THE RULES, in the words the panel prints. The ids are the store's own (`lib/collisions.js` COLLISION_RULES):
  // a record settled by the older cut says `older-cut`, and this is the one place the reader is told what that meant.
  const RULES = {
    "git-one-direction": "git: one merge direction is clean",
    "older-cut": "older cut first",
    "fewer-commits": "fewer commits first",
    "branch-name": "branch name breaks the tie",
    "pair-order": "the pair's own order",
    "nothing-committed": "git had nothing to compare",
    "merge-unknown": "git could not answer",
    "both-conflict": "both merge directions conflict",
    "version-line": "the version line is the land order",
    reader: "your ruling",
    none: "no rule can pick",
  };

  const asMs = (v) => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    const t = Date.parse(String(v || ""));
    return Number.isFinite(t) ? t : 0;
  };

  function ruleLabel(rule) {
    const id = String(rule || "").trim();
    return RULES[id] || (id ? id : "no rule on record");
  }

  /** The name a side is printed by: its directory, its branch, or the words it was reported with. */
  function sideName(side, fallback) {
    return String(side?.name || side?.branch || fallback || "a tree");
  }

  /** Does this record have a side whose own task is finished? Then it is not waiting on anybody. */
  function stoodByTask(rec) {
    return Array.isArray(rec?.stoodByTask) ? rec.stoodByTask : [];
  }

  /**
   * IS THIS PAIR WAITING ON A PERSON? The one predicate behind the badge, the list's top group and the ruling presses.
   * A record that reaches here already carries the store's `waiting` flag; the fallback is the same rule read off the
   * fields, so a hand-built fixture and the route answer alike.
   */
  function isWaiting(rec) {
    if (typeof rec?.waiting === "boolean") return rec.waiting;
    if (rec?.superseded || rec?.absent || rec?.ruling) return false;
    if (String(rec?.state || "") !== "reader") return false;
    return stoodByTask(rec).length === 0;
  }

  /** The five states a row can read as, in the order a reader meets them. */
  function stateOf(rec) {
    if (String(rec?.state || "") === "superseded" || rec?.superseded) return "superseded";
    if (String(rec?.state || "") === "absent" || rec?.absent) return "absent";
    if (isWaiting(rec)) return "waiting";
    if (String(rec?.state || "") === "ruled" || rec?.ruling) return "ruled";
    return "queued";
  }

  /** Both names, as the row's title: "worker-one and worker-two". */
  function pairText(rec) {
    return `${sideName(rec?.a, "one tree")} and ${sideName(rec?.b, rec?.bTarget || "the other side")}`;
  }

  /** The reason's own id, from a record the store settled or a record whose answer is still the panel's guess. */
  function ruleOf(rec) {
    if (rec?.ruling?.rule) return String(rec.ruling.rule);
    if (rec?.reason?.rule) return String(rec.reason.rule);
    if (rec?.ruling) return rec.ruling.auto ? "git-one-direction" : "reader";
    return rec?.reason?.would?.rule ? String(rec.reason.would.rule) : "none";
  }

  /** Which side the ruling names: its name and path, from the ruling or from the reason's pick. */
  function pickOf(rec) {
    const pick = rec?.ruling?.pick === "b" ? "b" : rec?.ruling?.pick === "a" ? "a" : rec?.reason?.pick === "b" ? "b" : rec?.reason?.pick === "a" ? "a" : null;
    if (!pick) return null;
    const side = pick === "a" ? rec?.a : rec?.b;
    return {
      pick,
      name: side?.name || (pick === "a" ? rec?.ruling?.name : null) || null,
      path: side?.path || (pick === "a" ? rec?.ruling?.path : null) || null,
    };
  }

  /** Who settled it: "you", "auto", or "" while nobody has. */
  function byOf(rec) {
    if (rec?.ruling) return rec.ruling.auto ? "auto" : "you";
    return "";
  }

  /**
   * ONE LINE FOR THE ROW: who settled the pair, which rule did it, and - while it is still waiting - which side the
   * panel would put first if nobody ruled. Never prose assembled at the call site: the popup, the test and any report
   * read the same sentence.
   */
  function reasonLine(rec) {
    const state = stateOf(rec);
    const first = pickOf(rec);
    const rule = ruleOf(rec);
    if (state === "waiting" || state === "queued") {
      const would = rec?.reason?.would || null;
      const lead = state === "waiting" ? "waiting on you" : "in the assistants' pass";
      if (would && would.pick) {
        return `${lead} · if nobody rules: ${would.name || (would.pick === "a" ? sideName(rec?.a) : sideName(rec?.b))} would go first (${ruleLabel(would.rule || rule)})`;
      }
      if (would) return `${lead} · if nobody rules: nothing can pick (${ruleLabel(would.rule || rule)})`;
      // A reported note is waiting because of the report's own verdict, not because a rule declined: say that.
      if (rec?.readerWhy) return `${lead} · ${String(rec.readerWhy)}`;
      return `${lead} · ${ruleLabel(rule)}`;
    }
    if (state === "ruled") {
      return `${byOf(rec) || "settled"} · ${first?.name || "one side"} goes first · ${ruleLabel(rule)}`;
    }
    if (state === "superseded") {
      const short = rec?.superseded?.short || String(rec?.superseded?.commit || "").slice(0, 12);
      return `history · landed${short ? ` in ${short}` : ""}${rule ? ` · was ${ruleLabel(rule)}` : ""}`;
    }
    if (state === "absent") return `history · ${rec?.absent?.why || "no second side lives, so nothing was ruled"}`;
    return `in the assistants' pass · ${ruleLabel(rule)}`;
  }

  /** The long form of the reason, for a row's title: the record's own sentence, never a second paraphrase. */
  function reasonDetail(rec) {
    const reason = rec?.reason && typeof rec.reason === "object" ? rec.reason : {};
    const would = reason.would && typeof reason.would === "object" ? reason.would : null;
    const bits = [];
    if (would?.reason) bits.push(would.reason);
    else if (reason.reason) bits.push(String(reason.reason));
    if (reason.note) bits.push(`you wrote: ${String(reason.note)}`);
    if (reason.relationSentence) bits.push(String(reason.relationSentence));
    const settlement = rec?.settlement && typeof rec.settlement === "object" ? rec.settlement : null;
    if (settlement?.at) bits.push(`settled ${ageText({ askedAt: settlement.at })}`);
    return bits.join(" · ");
  }

  /** The files the pair shares, as the record carries them. */
  function filesOf(rec) {
    return (Array.isArray(rec?.files) ? rec.files : []).filter(Boolean);
  }

  /** "3 files", or "no shared file" as an answer rather than a blank. */
  function filesText(rec) {
    const files = filesOf(rec);
    if (!files.length) return "no shared file";
    return `${files.length} file${files.length === 1 ? "" : "s"}`;
  }

  /** The relation that caused the pair, in the store's own words (lib/collisions.js `relationSentence`). */
  function relationText(rec) {
    const rels = Array.isArray(rec?.relations) ? rec.relations : [];
    const bits = [];
    for (const rel of rels) {
      if (!rel) continue;
      if (rel.kind === "shared-file") bits.push(`${(rel.files || []).length || filesOf(rec).length} shared file${((rel.files || []).length || filesOf(rec).length) === 1 ? "" : "s"}`);
      else if (rel.kind === "sibling" || rel.kind === "sibling-turnover") bits.push(`${(rel.files || []).length} file${(rel.files || []).length === 1 ? "" : "s"} both changed under ${rel.parent}`);
      else if (rel.kind === "merge-target") bits.push(`${rel.branch || "one branch"} lands into ${rel.target}`);
    }
    return bits.join("; ");
  }

  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  /** "16m", "2h", "3d". */
  function spanText(ms) {
    const n = Math.max(0, Number(ms) || 0);
    if (n < MIN) return "moments";
    if (n < HOUR) return `${Math.max(1, Math.round(n / MIN))}m`;
    if (n < DAY) return `${Math.round(n / HOUR)}h`;
    return `${Math.round(n / DAY)}d`;
  }

  function ageText(rec, now = Date.now()) {
    const at = asMs(rec?.askedAt || rec?.firstAt);
    if (!at) return "";
    const ms = Math.max(0, Number(now) - at);
    if (ms < MIN) return "just now";
    return `${spanText(ms)} ago`;
  }

  /**
   * THE FILTER: every token typed must appear in the record's own text. Row, branch, file and task number are all in
   * the haystack, so "worker-two", "wtgui/worker-two" and "lib/shared.js" each narrow to the pair that names them, and
   * two tokens narrow further. Case folded, and no field is inferred.
   */
  function haystackOf(rec) {
    const bits = [];
    for (const side of [rec?.a, rec?.b]) {
      if (!side) continue;
      bits.push(side.path, side.name, side.branch, side.task?.name);
      if (side.taskId) bits.push(String(side.taskId), `#${side.taskId}`, `task ${side.taskId}`);
    }
    if (rec?.bTarget) bits.push(rec.bTarget);
    for (const file of filesOf(rec)) bits.push(file);
    for (const rel of Array.isArray(rec?.relations) ? rec.relations : []) {
      if (!rel) continue;
      bits.push(rel.kind, rel.parent, rel.branch, rel.target);
      for (const file of Array.isArray(rel.files) ? rel.files : []) bits.push(file);
    }
    const reason = rec?.reason && typeof rec.reason === "object" ? rec.reason : {};
    bits.push(reason.rule, reason.label, reason.note, reason.pickName, reason.would?.rule, reason.would?.name);
    bits.push(rec?.ruling?.rule, rec?.ruling?.note, rec?.ruling?.name);
    bits.push(rec?.absent?.why, rec?.absent?.target, rec?.superseded?.short, rec?.superseded?.commit);
    bits.push(rec?.project);
    return bits.filter((b) => b != null && String(b).trim()).join(" ").toLowerCase();
  }

  /** Does one record answer this filter text? Every whitespace-separated token must be found. */
  function matches(rec, query) {
    const tokens = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return true;
    const hay = haystackOf(rec);
    return tokens.every((token) => hay.includes(token));
  }

  /** The records that answer a filter, in the popup's own order. */
  function filterRecords(records, query) {
    return order((Array.isArray(records) ? records : []).filter((rec) => rec && typeof rec === "object" && matches(rec, query)));
  }

  /**
   * THE ORDER, one answer for every surface. The pairs waiting on a person come first, oldest first - the oldest
   * unanswered decision is the one most likely to be the one that is stuck - and everything settled follows newest
   * first, because history is read from the last thing that happened backwards.
   */
  function order(records) {
    const rank = (rec) => {
      const state = stateOf(rec);
      return state === "waiting" ? 0 : state === "queued" ? 1 : 2;
    };
    return (Array.isArray(records) ? records : [])
      .filter((rec) => rec && typeof rec === "object")
      .slice()
      .sort((a, b) => {
        const r = rank(a) - rank(b);
        if (r) return r;
        if (rank(a) < 2) return asMs(a.firstAt) - asMs(b.firstAt) || String(a.key || "").localeCompare(String(b.key || ""));
        return asMs(b.lastAt || b.superseded?.at) - asMs(a.lastAt || a.superseded?.at) || String(a.key || "").localeCompare(String(b.key || ""));
      });
  }

  /** How many records are waiting on a person: the header badge's number. */
  function countWaiting(records) {
    return (Array.isArray(records) ? records : []).filter(isWaiting).length;
  }

  /** The page of rows the popup draws, with the honest total. `limit` is a render cap, never a filter. */
  function capOf(records, limit = RENDER_CAP) {
    const all = order(records);
    const total = all.length;
    const n = Number(limit);
    const want = Number.isFinite(n) && n > 0 ? Math.floor(n) : RENDER_CAP;
    const rows = all.slice(0, want);
    return { rows, total, shown: rows.length, more: total > rows.length, foot: footText(rows.length, total) };
  }

  /** "showing 50 of 137", "showing all 12", or the empty sentence - no silent truncation either way. */
  function footText(shown, total) {
    const s = Math.max(0, Number(shown) || 0);
    const t = Math.max(0, Number(total) || 0);
    if (!t) return "no collision has been seen on this board yet";
    if (s >= t) return `showing all ${t}`;
    return `showing ${s} of ${t}`;
  }

  /** What the header button says about its count, in one sentence. Zero is said out loud, never left blank. */
  function badgeText(n) {
    const count = Math.max(0, Number(n) || 0);
    if (!count) return "nothing is waiting on you";
    return `${count} collision${count === 1 ? "" : "s"} waiting on you`;
  }

  root.wtCollisionHistory = {
    RENDER_CAP,
    STATES,
    RULES,
    ruleLabel,
    ruleOf,
    byOf,
    pickOf,
    sideName,
    pairText,
    isWaiting,
    stateOf,
    stoodByTask,
    reasonLine,
    reasonDetail,
    filesOf,
    filesText,
    relationText,
    spanText,
    ageText,
    haystackOf,
    matches,
    filterRecords,
    order,
    countWaiting,
    capOf,
    footText,
    badgeText,
  };
})(typeof window !== "undefined" ? window : globalThis);
