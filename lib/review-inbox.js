// The REVIEW LANE: the delivery a finished run handed back, and whether the reader has checked it.
//
// WHY IT EXISTS. A row that finishes with something to read is the row that gets forgotten: the branch is merged,
// the tree is clean, the agent is quiet, and the report it wrote is never opened. This module is the one record that
// answers "what did that run leave me, and have I looked at it yet" - stored beside the panel's other per-row state
// (lib/paths.js `reviewsFile`, never inside a worktree), carried on the row by server.js's `withReviews`, and drawn
// by the row's result card (public/board-scaffold.js `reviewBlockHtml`).
//
// THE DELIVERY IS INFERRED, NOT DECLARED. A worker is handed no new verb: the panel reads what it already has at the
// one seam where a run's own words are already harvested (lib/jobs.js `harvestReview`, beside the TODO, RELEASE and
// DELIVER harvests):
//
//   * the run's FINAL message - the first line worth reading is the one-line summary, the first
//     `docs/reports/*.html` path it names is the report, and the lines under a "Next steps" heading are the chips;
//   * the row's CLOSE REASON - the outcome word and its reason (`done`, `interrupted`, `an exit code`) - which
//     stands in for the summary when a run ended without a final word.
//
// Nothing is required: a delivery with no report path and no next steps is a normal delivery (a summary and
// nothing else), and a run with neither a final message nor a reason records nothing at all. The alternative - one
// optional `delivery` field on the row-close action - was considered and refused: it changes the worker brief and
// every close call site to carry a field the panel can already derive. See the PR for that argument in full.
//
// THE STATE IS ONE WORD PER DELIVERY, and it is a ROW's, not a thread's:
//
//   awaiting   recorded at the run's close, `reviewedAt: null`. The row carries the amber marker and the header
//              counts it.
//   reviewed   the reader pressed Reviewed (or Mark all reviewed). The marker clears, the card stays - with the
//              delivery still readable and the age of the check - because the point is the record, not the nag.
//
// A NEWER CLOSE WITH A DELIVERY REPLACES the entry and clears the reviewed stamp: the thing to check is the new
// result, not the old one. A close that produces nothing (a chat turn with no final word) leaves the entry exactly
// as it was, so a row cannot lose its review marker because somebody said "thanks" in it afterwards.
//
// An unanswered card costs nothing. There is no waiter, no timeout and no state the run depends on: the delivery is
// written after the run has settled, and a reader who never presses Reviewed leaves the row amber and counted.
// That is the whole of the "unanswered" behaviour - see test/review-inbox.test.js.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const REVIEW_VERSION = 1;
// One entry per worktree, so the list is bounded by the fleet and not by the runs. A cap is still there: a row that
// stops being a worktree must not keep its delivery forever.
export const REVIEW_KEEP = 400;
export const REVIEW_SUMMARY_CAP = 220;
export const REVIEW_STEP_CAP = 160;
export const REVIEW_NEXT_CAP = 4;
export const REVIEW_REPORTS_CAP = 4;

// Rows are keyed with forward slashes and no trailing slash (lib/scan.js), and Windows paths are
// case-insensitive, so the key here is normalised the same way lib/locks.js and lib/todos.js normalise theirs.
export const normReviewPath = (p) =>
  String(p ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();

// THE KEY IS THE TREE PATH, and only the tree path. A worktree is unique across the fleet, while the PROJECT a
// run was started for is not on the job record at all (lib/jobs.js never persists `project`), and a delivery that
// waited for one would never be recorded. It also makes the lane's own rule fall out for free: a row that is
// archived or deleted stops being a row, so its delivery stops being counted, and the project on the entry stays a
// display hint that can be corrected without orphaning a record.
export function reviewKey(_project, treePath) {
  const p = normReviewPath(treePath);
  return p || null;
}

const oneLine = (s, n = REVIEW_SUMMARY_CAP) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const nowIso = (now = Date.now()) => new Date(now).toISOString();
// A marker line is the panel's own grammar, never a summary: a final message that starts with its TODO lines
// would otherwise be summarised as "TODO DONE 3".
const MARKER_RE = /^(TODO|DELIVER|RELEASE)\b/i;
const HEADING_RE = /^#{0,6}\s*next steps\b\s*:?\s*$/i;
const ANY_HEADING_RE = /^#{1,6}\s+\S/;
const BULLET_RE = /^\s*(?:[-*+•]|\d+[.)])\s+(.*)$/;
const CHECKBOX_RE = /^\[[ xX]\]\s*/;

// ---- the pure half: text in, a delivery out ----------------------------------------------------------------
// `docs/reports/<file>.html` is the anchor the prompt asks for, and a path may be written bare, in backticks or
// absolute. One regex finds a path, the first one wins (a report is one page, not a list), and the rest are kept
// only so a test can prove the choice is the FIRST and not the last.
const REPORT_RE = /((?:[A-Za-z]:)?[^\s`"'<>|()[\]{}]*docs[\\/]reports[\\/][^\s`"'<>|()[\]{}]+\.html)/gi;

export function findReports(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text ?? "").matchAll(REPORT_RE)) {
    const found = String(m[1] || "").replace(/\\/g, "/").replace(/^[.,;:]+/, "");
    if (!found) continue;
    const key = found.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(found);
    if (out.length >= REVIEW_REPORTS_CAP) break;
  }
  return out;
}

// The lines under a "Next steps" heading, up to four. The heading is its own line (it may be `## Next steps`),
// bullets are `-`, `*`, `+`, `•` or `1.`, and the list ends at the next heading or at the first line that is
// neither a bullet nor blank once the list has started. A checkbox marker (`- [ ] do it`) is stripped.
export function findNextSteps(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const start = lines.findIndex((l) => HEADING_RE.test(l.trim()));
  if (start < 0) return [];
  const out = [];
  let began = false;
  for (let i = start + 1; i < lines.length && out.length < REVIEW_NEXT_CAP; i += 1) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) {
      if (began) {
        // A blank line ends the list unless the next non-blank line is another bullet; look ahead once.
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j += 1;
        if (j < lines.length && BULLET_RE.test(lines[j])) continue;
        break;
      }
      continue;
    }
    if (ANY_HEADING_RE.test(line) || HEADING_RE.test(line)) break;
    const bullet = BULLET_RE.exec(raw);
    if (!bullet) {
      if (began) break;
      continue;
    }
    const step = clip(bullet[1].replace(CHECKBOX_RE, ""), REVIEW_STEP_CAP);
    if (!step) continue;
    began = true;
    out.push(step);
  }
  return out;
}

// The first line of a final message that says something. The panel's own marker lines (TODO/DELIVER/RELEASE) are
// the brief's grammar coming back and never the summary; a heading is structure, not a sentence.
export function firstLine(text) {
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw
      .trim()
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[*_`~]+|[*_`~]+$/g, "")
      .trim();
    if (!line) continue;
    if (MARKER_RE.test(line)) continue;
    if (HEADING_RE.test(raw.trim())) continue;
    return clip(line, REVIEW_SUMMARY_CAP);
  }
  return "";
}

// One delivery, or null when the run left nothing to check. `reason` is the row's close reason: the outcome word
// and whatever the run said about it - used only when the final message has no line worth reading.
export function parseDelivery({ text = "", reason = "" } = {}) {
  const said = String(text ?? "");
  const why = oneLine(reason, REVIEW_SUMMARY_CAP);
  const summary = firstLine(said) || why;
  if (!summary) return null;
  const reports = findReports(said);
  return {
    summary,
    report: reports[0] || null,
    reports,
    next: findNextSteps(said),
    from: firstLine(said) ? "the run's final message" : "the row's close reason",
  };
}

// The close reason a job carries: its outcome word, then the sentence beside it. `done` on its own is not worth
// recording; `done - 12 files changed` or `failed - exit 3` is.
export function closeReason(job = {}) {
  const word = String(job?.outcome?.word || job?.status || "").trim();
  const why = String(job?.outcome?.reason || job?.error || "").trim();
  if (!word && !why) return "";
  return [word, why].filter(Boolean).join(" - ");
}

// ---- the store -----------------------------------------------------------------------------------------------
export class ReviewInbox {
  constructor({ file = null, log = () => {}, now = () => Date.now() } = {}) {
    this.file = file;
    this.log = log;
    this.now = now;
    this.entries = new Map(); // key -> entry
    this.loaded = false;
  }

  load() {
    if (this.loaded) return this;
    this.loaded = true;
    if (!this.file) return this;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      const rows = raw && typeof raw === "object" && Array.isArray(raw.entries) ? raw.entries : [];
      for (const rec of rows) {
        if (!rec || typeof rec !== "object") continue;
        const key = normReviewPath(rec.path || rec.key);
        if (!key || !String(rec.summary || "").trim()) continue;
        this.entries.set(key, {
          key,
          // A display hint only (the key is the path): a record written before the project was known keeps null.
          project: rec.project ? String(rec.project) : null,
          path: key,
          runId: rec.runId || null,
          thread: rec.thread || null,
          at: rec.at || null,
          summary: clip(rec.summary, REVIEW_SUMMARY_CAP),
          report: rec.report ? String(rec.report) : null,
          next: (Array.isArray(rec.next) ? rec.next : []).filter((s) => String(s || "").trim()).slice(0, REVIEW_NEXT_CAP).map((s) => clip(s, REVIEW_STEP_CAP)),
          reviewedAt: rec.reviewedAt || null,
          reviewedBy: rec.reviewedBy || null,
        });
      }
    } catch (err) {
      if (existsSync(this.file)) this.log(`reviews: could not read ${this.file} (${String((err && err.message) || err)}) - starting empty`);
    }
    return this;
  }

  // Temp file + rename, like every other store in this panel: a reader never sees half a list, and a crash mid-write
  // leaves the previous one in place.
  save() {
    if (!this.file) return { ok: false, error: "no reviews file is configured" };
    this.load();
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const entries = [...this.entries.values()].slice(-REVIEW_KEEP);
      const tmp = `${this.file}.tmp-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify({ version: REVIEW_VERSION, savedAt: nowIso(this.now()), entries }, null, 2)}\n`, "utf8");
      renameSync(tmp, this.file);
      return { ok: true, file: this.file, entries: entries.length };
    } catch (err) {
      const error = String((err && err.message) || err);
      this.log(`reviews: could not write ${this.file} (${error})`);
      return { ok: false, error };
    }
  }

  /**
   * A finished run's delivery, against the row it closed in.
   *
   * Returns `{ saved, entry, line, skipped }` and never throws: the caller is the settle seam, where an exception
   * would be an unhandled rejection. `saved: false` with `skipped` set is the ordinary "this run left nothing to
   * check" answer, not a failure.
   */
  record({ project = null, path: treePath = null, runId = null, thread = null, text = "", reason = "", at = null } = {}) {
    this.load();
    const key = reviewKey(project, treePath);
    if (!key) return { saved: false, skipped: "no row", error: "a delivery needs the project and the tree path" };
    const parsed = parseDelivery({ text, reason });
    if (!parsed) return { saved: false, skipped: "nothing to check", parsed: null };
    const entry = {
      key,
      // The project is whatever the caller knows; the record stands without it, because the key is the tree path.
      project: project ? String(project) : null,
      path: key,
      runId: runId ? String(runId) : null,
      thread: thread ? String(thread) : null,
      at: at || nowIso(this.now()),
      summary: parsed.summary,
      report: parsed.report,
      next: parsed.next,
      reviewedAt: null,
      reviewedBy: null,
    };
    this.entries.set(key, entry);
    const wrote = this.save();
    if (!wrote.ok) {
      // The store is memory-first: the entry stands for this process and the write is reported, exactly as the
      // TODO store reports one. The caller says so on the card.
      return { saved: false, entry, parsed, error: wrote.error };
    }
    const line = `⇢ result ready for review: ${entry.summary}${entry.report ? ` · ${entry.report}` : ""}`;
    // A socket hint, wired by server.js: the store never learns what a socket is.
    try {
      this.onChange?.(entry);
    } catch {
      /* a listener's error is not a delivery's failure */
    }
    return { saved: true, entry, parsed, line };
  }

  // The row's own delivery. A key that was never recorded answers null - absence is "nothing to check", which is
  // also what a store that cannot be read must say (never a false amber).
  forRow(project, treePath) {
    this.load();
    const key = reviewKey(project, treePath);
    if (!key) return null;
    const entry = this.entries.get(key);
    if (!entry) return null;
    return { ...entry, next: [...entry.next], reports: entry.report ? [entry.report] : [], awaiting: !entry.reviewedAt };
  }

  // The reader's own press. Idempotent: a second press is an answer, not an error, and it does not move the stamp.
  markReviewed({ project = null, path: treePath = null, by = "reader" } = {}) {
    this.load();
    const key = reviewKey(project, treePath);
    if (!key) return { ok: false, changed: false, error: "a worktree is required: pass the row's path" };
    const entry = this.entries.get(key);
    if (!entry) return { ok: false, changed: false, error: `no delivery is waiting for review on ${String(treePath || "(none)")}` };
    if (entry.reviewedAt) return { ok: true, changed: false, entry: { ...entry }, say: `already reviewed ${entry.reviewedAt}` };
    entry.reviewedAt = nowIso(this.now());
    entry.reviewedBy = String(by || "reader");
    const wrote = this.save();
    return { ok: true, changed: true, entry: { ...entry }, say: `reviewed: ${entry.summary}`, error: wrote.ok ? null : wrote.error };
  }

  // Every row that is waiting, in one press. Deliberately not a loop of markReviewed: one write, one stamp for the
  // set, so a bulk press cannot half-succeed and leave the board in two states.
  markAll({ by = "reader", now = null } = {}) {
    this.load();
    const stamp = now || nowIso(this.now());
    let n = 0;
    for (const entry of this.entries.values()) {
      if (entry.reviewedAt) continue;
      entry.reviewedAt = stamp;
      entry.reviewedBy = String(by || "reader");
      n += 1;
    }
    if (!n) return { ok: true, changed: 0, say: "nothing was waiting for review" };
    const wrote = this.save();
    return { ok: true, changed: n, say: `marked ${n} delivery${n === 1 ? "" : "s"} reviewed`, error: wrote.ok ? null : wrote.error };
  }

  // One row stopped being a row: its delivery goes with it. This is called from the store's own `drop` event, which is
  // the only COMPLETE statement that a tree is gone - a sweep over "the rows visible right now" is not, because a scan
  // emits partial sets while it walks, and deleting against one of those throws away the delivery the reader is coming
  // back for. A drop names the row, so nothing has to be guessed and nothing else can be lost.
  forget({ project = null, path: treePath = null } = {}) {
    this.load();
    const key = reviewKey(project, treePath);
    if (!key || !this.entries.has(key)) return { removed: 0, kept: this.entries.size, skipped: "no delivery on that row" };
    this.entries.delete(key);
    const wrote = this.save();
    return { removed: 1, kept: this.entries.size, error: wrote.ok ? null : wrote.error };
  }

  awaiting() {
    this.load();
    const out = [];
    for (const entry of this.entries.values()) if (!entry.reviewedAt) out.push({ ...entry });
    return out;
  }

  count() {
    return this.awaiting().length;
  }

  // What GET /api/review answers, and what a test reads: the whole record, newest first, plus the count.
  state() {
    this.load();
    const entries = [...this.entries.values()]
      .map((e) => ({ ...e, awaiting: !e.reviewedAt }))
      .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
    return { count: entries.filter((e) => e.awaiting).length, total: entries.length, entries };
  }
}
