// The DELIVERABLES list: everything every agent on this panel handed back, in one durable list.
//
// A worker cannot paint the panel. It writes ONE line in its FINAL message —
//
//     DELIVER <link|file|image> <target> | <title>
//
// — and the panel reads it at settle, on the same seam that already reads TODO and RELEASE
// (`Jobs.measureTree` → `Jobs.harvestDeliverables`). The worker never learns a path, an id or an API: parsing,
// validation, dedupe, ordering, storage and the opening are the panel's. That is the whole point of the grammar —
// a marker nobody told the model about is a grammar nobody can use, and an HTTP route a worker could reach would be
// a second surface to guard.
//
// Four rules are this module's argument:
//
//   1. A target is validated NOW, not later: a file must stat as a file, an image must carry an image suffix, a link
//      must be http(s). A delivery the panel cannot open is refused OUT LOUD on the card (one `⚠` line), never
//      stored and never dropped in silence — a silently refused marker is the failure this feature exists to end.
//   2. One row per TARGET. `seq` is the identity the page sends back, so a repeat updates its row in place and a
//      popover open across the update still points at the same row. The dedupe key is DERIVED from the entry, not
//      stored, so a hand-edited record cannot invent a second spelling of one key.
//   3. A repeat that changes nothing writes nothing. A thread of replies each repeating the marker is not ten
//      deliveries, and the row must not climb to the top of the list every turn.
//   4. The list is capped and pruned ON WRITE. A cap of 200 rows is bounded work for the popover; "every deliverable
//      forever" would make it a second job store. Pruning forgets a ROW — the file stays on disk, and the footer says so.
//   5. "SEEN" IS ONE PERSISTED WATERMARK, not a per-page flag. `seenSeq` (with `seenAt`) sits beside the entries in
//      the same file, so the header badge counts what arrived AFTER it and a restart cannot resurrect a cleared one.
//      It only ever moves forward; `markSeen()` is the single door, and the popover's open and the badge's dismiss
//      both come through it. There is no second store and no per-entry `seen` flag to disagree with it.
//
// The file is `deliverables.json` in the state folder beside `jobs.json` (lib/paths.js owns that spelling), never
// inside a checkout: it is state, not source. One Node process writes it, so the store is its own lock, and every
// write goes through a temp file + rename so a reader never sees half a list.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tagOf } from "./tree-names.js";

export const DELIVER_VERSION = 1;
// What the footer reads and what the file is trimmed to. A cap is the only thing that keeps "everything ever
// delivered" from growing without a bound; the row is forgotten, never the file.
export const DELIVER_KEEP = 200;
export const DELIVER_TITLE_CAP = 160;
export const DELIVER_TARGET_CAP = 1024;
export const DELIVER_KINDS = ["link", "file", "image"];
export const IMAGE_SUFFIXES = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"];

const nowIso = (now = Date.now()) => new Date(now).toISOString();
const oneLine = (s, n = 200) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const slash = (p) => String(p ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
const lastSegment = (p) => String(p || "").split("/").filter(Boolean).pop() || "";
// One pair of surrounding quotes or backticks, so a path with spaces can be written the way a shell would want it and
// still mean the path. Nothing else is stripped: the pipe delimits the target, so no punctuation heuristic is needed
// and a URL's own trailing `/`, `?a=1` or `#frag` survives byte for byte.
const unquote = (s) => String(s ?? "").trim().replace(/^["'`]|["'`]$/g, "").trim();
const isPlaceholder = (s) => /^<[^<>]*>$/.test(String(s ?? "").trim());

// ---- the grammar ---------------------------------------------------------------------------------------------------
// The pure half: text in, markers out, nothing here knowing about the panel. The shape is `parseReleaseLines`' own
// (`lib/worktrees.js`): a line that starts with the marker and cannot be read comes back with `error` set rather
// than being dropped, so the caller can say it on the card.
//
// A line whose kind / target / title slot is a single `<…>` placeholder is a TEMPLATE ECHO, not a delivery: the brief
// prints `syntax: DELIVER <link|file|image> <target> | <title>`, and a model repeating the paragraph it was handed
// must not paint a warning on an otherwise good turn. It is ignored, not refused.
export function parseDeliverLines(text) {
  const out = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    // Exactly `parseReleaseLines`' rule: the word must end at `DELIVER`, so `DELIVERED` is not a marker, and a
    // Markdown fence line (`\`\`\`DELIVER …`) is not one either because the backticks are part of the line.
    if (!/^DELIVER\b/i.test(line)) continue;
    const body = line.replace(/^DELIVER\b/i, "").trim();
    if (!body) {
      out.push({
        kind: null,
        target: null,
        title: "",
        raw: line,
        error: "a DELIVER line needs `<link|file|image> <target> | <title>`",
      });
      continue;
    }
    // `<kind>` is the first word and it is the ONLY word that is not free text — which is what lets a target contain
    // spaces with no quoting. Parsed before the pipe, so a placeholder echo (`DELIVER <link|file|image> …`, whose first
    // pipe is INSIDE the placeholder) is recognised instead of being read as a malformed kind.
    const head = body.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    const kindWord = head ? head[1] : "";
    if (isPlaceholder(kindWord)) continue;
    const kind = kindWord.toLowerCase();
    if (!DELIVER_KINDS.includes(kind)) {
      out.push({ kind: null, target: null, title: "", raw: line, error: `“${oneLine(kindWord, 40)}” is not one of link / file / image` });
      continue;
    }
    const rest = (head?.[2] || "").trim();
    // The pipe is the one separator: a Windows path carries colons and spaces, and a link carries `:` and `//`, so
    // neither can also be the field break. Split on the FIRST pipe; a title may well contain another one.
    const at = rest.indexOf("|");
    if (at < 0) {
      out.push({ kind, target: null, title: "", raw: line, error: "DELIVER needs `| <title>` after the target" });
      continue;
    }
    const target = unquote(rest.slice(0, at));
    const title = oneLine(rest.slice(at + 1), DELIVER_TITLE_CAP);
    if (isPlaceholder(target) || isPlaceholder(title)) continue;
    if (!target) {
      out.push({ kind, target: null, title: "", raw: line, error: "DELIVER names no target" });
      continue;
    }
    if (!title) {
      out.push({ kind, target, title: "", raw: line, error: "DELIVER names no title — say what the reader should do with it, in a few words" });
      continue;
    }
    out.push({ kind, target, title, raw: line, error: null });
  }
  return out;
}

// The key a target dedupes on, DERIVED from the entry it is asked about: `link:<the normalised URL>` or
// `file:<lower-cased, forward-slashed absolute path>`. An image shares the `file:` space on purpose — the same bytes
// delivered once as `file` and once as `image` are one deliverable, not two rows for one thing.
export function dedupeKey(entry) {
  if (!entry || !entry.target) return "";
  if (entry.kind === "link") return `link:${String(entry.target).trim()}`;
  return `file:${slash(entry.target).toLowerCase()}`;
}

// A target resolved against the tree this measure pass located, and validated by what the filesystem says NOW.
// Returns `{target, bytes, mtimeMs}` or `{error}`; it never throws, because the settle path has no try/catch and a
// stat that throws inside it would be an unhandled rejection in `measureTree`.
export function resolveTarget({ kind, target, job = {}, tree = null }) {
  const written = String(target ?? "").trim();
  if (kind === "link") {
    let parsed;
    try {
      parsed = new URL(written);
    } catch {
      return { error: `“${oneLine(written, 120)}” is not a URL — a link needs http:// or https://` };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { error: `only http(s) links can be delivered (got “${parsed.protocol}”)` };
    }
    return { target: parsed.toString(), bytes: null, mtimeMs: null };
  }
  // A file or an image. The tree this pass measured is the base, and the job's recorded paths are only the fallback
  // for a run with no tree at all: the job fields are set once at creation and go stale the moment the panel
  // auto-names a finished tree, which is exactly when `docs/report.html` would be refused while the file sat one
  // directory over (the review's B2). The refusal names the directory that was used, so the reader can see which.
  const base = slash(tree?.path || job.worktreePath || job.ownerPath || job.cwd || "");
  let abs;
  try {
    const looksAbsolute = /^[a-z]:\//i.test(written) || path.isAbsolute(written);
    abs = slash(looksAbsolute ? path.resolve(written) : base ? path.resolve(base, written) : path.resolve(written));
  } catch {
    return { error: `that target cannot be resolved: ${oneLine(written, 120)}` };
  }
  if (kind === "image" && !IMAGE_SUFFIXES.includes(path.extname(abs).toLowerCase())) {
    return { error: `an image must end in .png / .jpg / .jpeg / .gif / .webp / .bmp / .svg — deliver it as a “file” if it is not one` };
  }
  if (abs.length > DELIVER_TARGET_CAP) {
    return { error: `the target is ${abs.length} characters; the panel keeps at most ${DELIVER_TARGET_CAP}` };
  }
  let info;
  try {
    info = statSync(abs);
  } catch {
    return { error: `no such file: ${abs} — resolved from “${oneLine(written, 200)}” against ${base || "the panel's own directory"}` };
  }
  if (info.isDirectory()) return { error: `that is a directory, not a file: ${abs}` };
  if (!info.isFile()) return { error: `that is not a regular file: ${abs}` };
  // Rounded: `mtimeMs` is fractional on Windows, and the repeat signature (§4.3) compares two reads of it, so the
  // number that is written to JSON has to be the number a later `stat` produces.
  return { target: abs, bytes: info.size, mtimeMs: Math.round(info.mtimeMs) };
}

const byNewest = (a, b) => String(b.at).localeCompare(String(a.at)) || Number(b.seq) - Number(a.seq);

// One entry read back from the file, or null when it cannot address or describe anything. A single unusable record
// is dropped and logged by `load()`; the rest of the list survives, because one bad hand-edit is not a reason to
// lose 199 good rows.
function normaliseEntry(e) {
  if (!e || typeof e !== "object") return null;
  const seq = Number(e.seq);
  const kind = String(e.kind || "").toLowerCase();
  const target = String(e.target || "").trim();
  const at = String(e.at || "").trim();
  if (!Number.isInteger(seq) || seq <= 0) return null;
  if (!DELIVER_KINDS.includes(kind) || !target || !at) return null;
  if (!Number.isFinite(new Date(at).getTime())) return null;
  const bytes = e.bytes === null || e.bytes === undefined ? null : Number(e.bytes);
  const mtimeMs = e.mtimeMs === null || e.mtimeMs === undefined ? null : Number(e.mtimeMs);
  return {
    seq,
    kind,
    target,
    title: oneLine(e.title, DELIVER_TITLE_CAP),
    at,
    project: e.project || null,
    treePath: e.treePath ? slash(e.treePath) : null,
    branch: e.branch || null,
    tag: e.tag || null,
    jobId: e.jobId || null,
    thread: e.thread || null,
    turn: Number.isInteger(e.turn) ? e.turn : null,
    agent: e.agent || null,
    bytes: Number.isFinite(bytes) ? bytes : null,
    mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : null,
    missingAt: e.missingAt || null,
  };
}

// A row as the LIST paints it: `project`/`treePath`/`branch` are re-resolved against the panel's trees AT READ TIME,
// matching the six-hex tag first (the one part of a name an auto-rename keeps) and then the exact path. That is what
// makes "a rename moves the row with the tree" a behaviour rather than a sentence; a tree that is gone leaves the
// stored values standing, so a row whose worktree was removed still says where it came from.
function resolveRow(entry, trees) {
  if (!trees || !trees.length) return { ...entry };
  const tag = entry.tag || null;
  const wantPath = String(entry.treePath || "").toLowerCase();
  const hit =
    (tag ? trees.find((t) => t && t.path && (tagOf(t.branch || "") === tag || tagOf(lastSegment(t.path)) === tag)) : null) ||
    (wantPath ? trees.find((t) => t && t.path && String(t.path).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === wantPath) : null) ||
    null;
  if (!hit) return { ...entry };
  return {
    ...entry,
    project: hit.project || entry.project,
    treePath: slash(hit.path) || entry.treePath,
    branch: hit.branch || entry.branch,
  };
}

export class Deliverables {
  // `trees` is the panel's own provider (`panelTrees` in server.js), handed over exactly as TodoLists and
  // ReleaseRequests get it, and here it has the stated job above.
  constructor({ file = null, log = () => {}, trees = null, now = () => Date.now() } = {}) {
    this.file = file;
    this.log = log;
    this.treesProvider = trees;
    this.now = now;
    this.entries = [];
    // The persisted "the reader has seen the list up to here" watermark. Loaded from the file, never derived from the
    // page: a restart, a second tab and a refreshed page all read the SAME number.
    this.seenSeq = 0;
    this.seenAt = null;
    this.unseenCount = 0;
    this.nextSeq = 1;
    this.loaded = false;
    this.corrupt = false;
    this.error = null;
    this.onChange = null;
  }

  get size() {
    this.load();
    return this.entries.length;
  }

  trees() {
    try {
      return (this.treesProvider ? this.treesProvider() : []) || [];
    } catch {
      return [];
    }
  }

  // Lazy, then cached — the first GET or the first harvest reads the file. A file that cannot be parsed is REMEMBERED
  // and moved aside at the next write, so `deliverables.json.corrupt-*` holds the evidence instead of being
  // overwritten by the first delivery after the fault.
  load() {
    if (this.loaded) return this;
    this.loaded = true;
    if (!this.file || !existsSync(this.file)) return this;
    let raw;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (err) {
      this.corrupt = true;
      this.log(`deliverables: could not read ${this.file} (${String((err && err.message) || err)}) — starting empty; the file is moved aside at the next write`);
      return this;
    }
    const listed = Array.isArray(raw?.entries) ? raw.entries : [];
    const kept = [];
    for (const e of listed) {
      const entry = normaliseEntry(e);
      if (!entry) {
        this.log(`deliverables: dropped an unreadable entry (${e && e.seq !== undefined ? `seq ${e.seq}` : "no seq"}) from ${this.file}`);
        continue;
      }
      kept.push(entry);
    }
    // Sorted and capped IN MEMORY only: a file written by a build with a larger cap is brought to this one on the
    // next boot, and the FILE itself is rewritten at the next delivery, not here.
    kept.sort(byNewest);
    this.entries = kept.slice(0, DELIVER_KEEP);
    const maxSeq = this.entries.reduce((n, e) => Math.max(n, e.seq), 0);
    const stored = Number(raw?.nextSeq);
    // A hand-edited or older file can never hand a live `seq` out twice — the same rule `TodoLists.nextId` follows.
    this.nextSeq = Math.max(Number.isFinite(stored) && stored > 0 ? stored : 1, maxSeq + 1);
    // The watermark, read from the SAME record as the entries. Clamped to the newest row: a hand-edited or older file
    // can claim a number that no row carries, and "everything up to 9999 is seen" would then silently clear a badge
    // forever. `seenAt` is kept only when it is a real timestamp, and only beside a watermark that exists.
    const storedSeen = Number(raw?.seenSeq);
    this.seenSeq = Number.isInteger(storedSeen) && storedSeen > 0 ? Math.min(storedSeen, maxSeq) : 0;
    this.seenAt =
      this.seenSeq > 0 && typeof raw?.seenAt === "string" && Number.isFinite(new Date(raw.seenAt).getTime()) ? raw.seenAt : null;
    this.recount();
    return this;
  }

  // The one derived number the page reads: rows ABOVE the watermark. Recomputed on load, on a write and on a delivery
  // — never inside a GET — so a request costs a field read and the count can never drift from the rows it counts.
  recount() {
    this.unseenCount = this.entries.reduce((n, e) => n + (Number(e.seq) > this.seenSeq ? 1 : 0), 0);
    return this.unseenCount;
  }

  save() {
    if (!this.file) return false;
    this.load();
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      if (this.corrupt) this.moveCorrupt();
      const kept = [...this.entries].sort(byNewest).slice(0, DELIVER_KEEP);
      this.entries = kept; // memory and file agree, so a pruned row cannot come back on the next read
      this.recount();
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(
        tmp,
        `${JSON.stringify({ version: DELIVER_VERSION, savedAt: nowIso(this.now()), nextSeq: this.nextSeq, seenSeq: this.seenSeq, seenAt: this.seenAt, entries: kept }, null, 2)}\n`,
        "utf8",
      );
      renameSync(tmp, this.file); // atomic: a reader never sees half a file
      this.error = null;
      return true;
    } catch (err) {
      this.error = String((err && err.message) || err);
      this.log(`deliverables: could not write ${this.file} (${this.error})`);
      return false; // record() reports saved:false and the harvest leaves its mark unset, so the next pass retries
    }
  }

  moveCorrupt() {
    try {
      renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      this.log(`deliverables: ${this.file} was not readable — moved aside`);
    } catch (err) {
      this.log(`deliverables: could not move ${this.file} aside (${String((err && err.message) || err)}) — writing over it`);
    }
    this.corrupt = false;
  }

  // The page's read: the §7.1 shape, newest first, with the cap and the count a footer needs — plus the watermark the
  // badge counts from. `unseenCount` is the STORED value (recounted on every write), never a walk of the list per GET.
  list() {
    this.load();
    const trees = this.trees();
    const entries = this.entries.map((e) => resolveRow(e, trees));
    return {
      version: DELIVER_VERSION,
      cap: DELIVER_KEEP,
      kept: entries.length,
      nextSeq: this.nextSeq,
      seenSeq: this.seenSeq,
      seenAt: this.seenAt,
      unseenCount: this.unseenCount,
      at: nowIso(),
      entries,
    };
  }

  // "The reader has seen the list up to `seq`." ONE watermark and one direction: a later number than the current one
  // moves it; an older one is a no-op that still answers with the truth. `seq` is clamped to the newest row, so a page
  // cannot claim a future it was never given and a store with no rows never records a watermark. The popover's open
  // and the badge's dismiss both come here — one mechanism, two doors, never a second store.
  markSeen(seq, { now = null } = {}) {
    this.load();
    const want = Number(seq);
    if (!Number.isInteger(want) || want < 0) {
      return {
        error: "`seq` must be the integer a deliverable's row carries",
        seenSeq: this.seenSeq,
        seenAt: this.seenAt,
        unseenCount: this.unseenCount,
        moved: false,
        saved: true,
      };
    }
    const newest = this.entries.reduce((n, e) => Math.max(n, Number(e.seq) || 0), 0);
    const target = Math.min(want, newest);
    const moved = target > this.seenSeq;
    if (moved) {
      this.seenSeq = target;
      this.seenAt = nowIso(now ?? this.now());
      this.recount();
    }
    const saved = moved ? this.save() : true;
    return { seenSeq: this.seenSeq, seenAt: this.seenAt, unseenCount: this.unseenCount, moved, saved };
  }

  // What the open route acts on: the STORE's own row, by the `seq` the page sent back. Nothing else — a page can
  // name a number, never a path.
  get(seq) {
    this.load();
    const want = Number(seq);
    if (!Number.isInteger(want)) return null;
    return this.entries.find((e) => e.seq === want) || null;
  }

  // A click found the file gone. The stamp is what makes the second click honest: the row says `gone` instead of
  // pretending, and the list does not accumulate dead rows that look alive. Cleared the next time the file is there.
  markMissing(seq) {
    const entry = this.get(seq);
    if (!entry) return null;
    if (!entry.missingAt) {
      entry.missingAt = nowIso(this.now());
      this.save();
    }
    return entry;
  }

  clearMissing(seq) {
    const entry = this.get(seq);
    if (!entry) return null;
    if (entry.missingAt) {
      entry.missingAt = null;
      this.save();
    }
    return entry;
  }

  // One settled run's final message. The impure half: resolve and stat each target, upsert, write, and hand back the
  // console lines the card shows. It is written never to throw — every failure is an `error` on a returned object —
  // because its caller is the settle seam and an exception there is an unhandled rejection in `measureTree`.
  record({ job = {}, tree = null, finalText = "", agent = null, now = null } = {}) {
    this.load();
    const at = nowIso(now ?? this.now());
    const out = { parsed: 0, added: 0, updated: 0, refused: [], lines: [], saved: true, error: null };
    const markers = parseDeliverLines(finalText);
    out.parsed = markers.length;
    if (!markers.length) return out;
    const touched = [];
    const jobId = job.id || null;
    for (const mark of markers) {
      if (mark.error) {
        out.refused.push({ raw: mark.raw, error: mark.error });
        out.lines.push({ kind: "raw", text: `⚠ DELIVER was NOT recorded — ${mark.error}` });
        continue;
      }
      const hit = resolveTarget({ kind: mark.kind, target: mark.target, job, tree });
      if (hit.error) {
        out.refused.push({ raw: mark.raw, error: hit.error });
        out.lines.push({ kind: "raw", text: `⚠ DELIVER was NOT recorded — ${hit.error}` });
        continue;
      }
      const key = dedupeKey({ kind: mark.kind, target: hit.target });
      const existing = this.entries.find((e) => dedupeKey(e) === key) || null;

      if (!existing) {
        const entry = {
          seq: this.nextSeq++,
          kind: mark.kind,
          target: hit.target,
          title: mark.title,
          at,
          project: job.project || null,
          // Where it came from, stored as of harvest: a row whose tree is later removed still says where it was.
          treePath: slash(tree?.path || job.worktreePath || job.ownerPath || "") || null,
          branch: tree?.branch || job.branch || null,
          tag: tagOf(tree?.branch || job.branch || "") || tagOf(lastSegment(tree?.path || job.worktreePath || "")) || null,
          jobId,
          thread: job.thread || null,
          turn: Number.isInteger(job.turn) ? job.turn : null,
          agent: agent || null,
          bytes: hit.bytes,
          mtimeMs: hit.mtimeMs,
          missingAt: null,
        };
        this.entries.push(entry);
        this.entries.sort(byNewest);
        out.added += 1;
        touched.push(entry);
        out.lines.push({ kind: "dim", text: `⇢ DELIVER ${mark.kind} recorded: ${oneLine(mark.title, 120)}` });
        continue;
      }

      // A repeat. The SAME run writing the line twice (or a second pass re-reading one message) may only correct the
      // title: `at`, `jobId` and the row's place are untouched, because the delivery happened when it happened.
      if (jobId && existing.jobId === jobId) {
        if (existing.title !== mark.title) {
          existing.title = mark.title;
          out.updated += 1;
          touched.push(existing);
          out.lines.push({ kind: "dim", text: `⇢ DELIVER ${existing.kind} updated: ${oneLine(mark.title, 120)}` });
        }
        continue;
      }

      // A DIFFERENT run. It is a delivery only if the thing changed: the signature is mtime + size for a file/image
      // and the normalised URL for a link, and the title has to change too. A reply that merely echoes the marker is
      // not a new delivery — which is what keeps a thread of replies from bumping one report to the top every turn.
      const sameThing =
        existing.kind === "link"
          ? existing.target === hit.target
          : existing.mtimeMs === hit.mtimeMs && existing.bytes === hit.bytes;
      if (sameThing && existing.title === mark.title) continue;

      Object.assign(existing, {
        title: mark.title,
        at,
        jobId,
        thread: job.thread || existing.thread,
        turn: Number.isInteger(job.turn) ? job.turn : existing.turn,
        agent: agent || existing.agent,
        branch: tree?.branch || job.branch || existing.branch,
        bytes: hit.bytes,
        mtimeMs: hit.mtimeMs,
      });
      this.entries.sort(byNewest);
      out.updated += 1;
      touched.push(existing);
      out.lines.push({ kind: "dim", text: `⇢ DELIVER ${existing.kind} updated: ${oneLine(mark.title, 120)}` });
    }

    // The count the badge reads is derived from memory, so it moves with the rows whether or not the write landed.
    this.recount();

    // A write is the ONLY thing that grows the file, so a message that changed nothing does not write. A store whose
    // last write failed retries even with nothing new: the rows it accepted are in memory, and the next pass is the
    // one that puts them on disk.
    if (out.added + out.updated > 0 || this.error) {
      out.saved = this.save();
      out.error = out.saved ? null : this.error;
    }
    if (out.saved !== false) {
      for (const entry of touched) {
        try {
          this.onChange?.(entry);
        } catch {
          /* a listener (an SSE broadcast) must never break the settle path */
        }
      }
    }
    return out;
  }
}
