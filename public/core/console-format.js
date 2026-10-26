// core/console-format.js — how a console draws a file: a framed diff window for a unified diff, a code box
// for any other file dump. One classifier, one builder, and every console uses them.
//
// WHY ONE RENDERER
//
// A console is built in three places and they all end up in the same <pre class="job-out">: the live stream
// (appendJobLine appends a line, or re-renders the whole burst through toolGroupHtml), the session store
// (storedHtml prints the rows a tool actually returned, which on this gateway is where a patch's diff comes
// from — the run stream's preview is routinely empty for patch/write_file), and the fallback path in
// toolGroupHtml for a burst whose call lines were trimmed away. A turn is also drawn twice while it is pinned
// (its own console and the "@pin" copy) and a third time inside the assistant's float, because that float
// carries the same agent card. A second renderer would mean four chances to disagree about what a diff looks
// like, so the classification and the markup live here and the callers only hand over lines.
//
// WHAT IT CLASSIFIES, AND FROM WHAT
//
// Only the TEXT of a line, at render time. No line model gained a field, no server work happens, and the only
// context the classifier sees is the run of lines it was handed plus the tool the run came from. That is
// enough, because a unified diff is a shape: headers, then hunks, then lines that begin with "-", "+" or a
// space. Everything below is a rule about that shape.
//
// CONSERVATIVE BY CONSTRUCTION — the rules that keep ordinary output plain
//
//   - Only a tool's own output is classified at all (kind "tool-out", or "store" for a stored row). A call
//     line, the agent's sentences (kind "text"), the panel's own notes ("dim", "raw") and the run protocol
//     ("cmd", "init", "result") are never eligible: prose stays prose by construction, not by a heuristic.
//   - "--- x" is a file header ONLY when the next line is "+++ y", or when a "diff --git" line already
//     opened the block. Real consoles are full of "--- thread: ... | id: ..." and "--- count ---" headings,
//     and a lone "--- " is a heading far more often than it is a diff.
//   - A mode string ("-rw-r--r-- 1 jacob ...") is an `ls` listing, never a removed line, and is only ever
//     considered outside an open diff, where a removal that happens to look like a mode string is a removal.
//   - A run with no hunk header needs BOTH a "-" line and a "+" line AND an adjacent change block (a run of
//     "-" lines immediately followed by a run of "+" lines). A bulleted list, a `git diff --stat`, a shell
//     transcript and an error dump all fail one of those.
//   - A note line ("… 12 more line(s)", "… result truncated by the gateway") always ends a run.
//   - A truly empty line ends a diff block. Inside a file body it is content, so a code box keeps it.
//
// PURE AND DETERMINISTIC
//
// consoleClassify() is text in, class out: same rows, same classes, no clock, no DOM, no state carried between
// calls. Nothing reshuffles on a re-render or a refresh, and a rebuild of a burst (which happens on every new
// tool line while the block is open) re-derives exactly what was there before. The one piece of reader state
// this module renders — whether a code box is open — is passed in by the caller, never read here.
//
// THE PAIRING RULE, AND WHY IT IS A BLOCK
//
// A hunk's changed lines are rendered as two sides: the LEFT holds the after (new) lines, the RIGHT the before
// (old) ones — the reader asked for the new side first, so a modification reads as "what it is now" on the left
// and "what it was" on the right. A change block (a run of "-" lines immediately followed by a run of "+"
// lines) pairs index by index, so the i-th removal sits on the same row as the i-th addition and both read as
// one modification: the left half green, the right half yellow. A "-" left over after pairing is a pure removal
// (red, drawn full width because there is no after half to sit beside); a "+" is always green and sits on the
// LEFT with an empty right cell, so the columns still line up with the rows above and below. Pairing a single
// "-" only with the "+" immediately after it would leave a two-for-two change reading as "one modification, one
// deletion, one addition", which is not what the diff says.
//
// A paired row is therefore written after-then-before, which is the opposite of the diff's own order. The
// read-back a burst rebuild runs (groupLines, in public/app.js) reads a row carrying data-lpair in the reverse
// order, so a rebuild re-derives the lines the console was handed rather than the order they were drawn in:
// read the other way round, a pair re-classifies as a lone addition plus a lone removal and the change redraws
// as two rows.
//
// A HUNK THE PREVIEW CUT SHORT
//
// The gateway's live stream carries a preview of a tool result, not all of it, and the panel says so with a note
// line. When that note lands while a diff is open, the frame draws it INSIDE itself at the cut edge, as a "cut"
// row: the hunk above it is not the whole change, and the row says so in words instead of letting two lines read
// as a finished hunk. The rest of such a result is not in these lines — the console asks the session store for
// what the tool actually returned (public/app.js), and falls back to the cut row when the store has nothing.
//
// A RESULT THE PANEL ITSELF FOLDED
//
// One cap down is the panel's own: with the gateway's preview cap lifted the whole result arrives, and the card
// keeps its head (40 lines, 400 characters a line — lib/jobs/console-lines.js) so that a 5,000-line read cannot
// evict every other line of the card through the console's 600-line ring buffer. That fold ends with its own
// sentence ("… 214 lines hidden — click to read"), which this module draws as a BUTTON: the click fetches the
// whole stored row (one row, uncapped) and the card re-renders it in place. The two notes are never confused —
// each says which cap cut it, and each appears only when its cap really cut something.
//
// WHAT IT REACHES OUT FOR
//
//   tailPath  — the code box's header shows the last few segments of the file (dom-format.js, loaded first)
//   esc       — every line goes through the same escaper the console has always used
//   linkifyText — a URL in a diff line or a file body stays clickable, exactly as before

// ---- classification (pure) ----------------------------------------------------------------------------

// A line the gateway or the panel added under a result. It is never part of a diff or a file body, and it
// always ends a run: "… 12 more line(s)" printed inside a hunk would read as a hunk line.
const CF_NOTE_RE = /^\s*(?:…|\.\.\.)\s/;
// The one note that means the DATA stopped rather than that the panel folded a tail: the gateway's own sentence
// for a preview it cut ("… result truncated by the gateway — the live stream carries a preview of a tool
// result, not all of it"). A hunk such a line lands in is not complete, so the frame has to say so.
const CF_CUT_RE = /truncated by the gateway/;
// The panel's OWN fold, whose click reads the rest of the result out of the session store: "… 214 lines hidden —
// click to read" (and "… 12 lines hidden, 3 lines shortened — click to read" when the head also wore this
// panel's 400-character line cap). The sentence is built on the server (lib/jobs/console-lines.js,
// foldNoteText) and matched here; a note this does not recognise is a fold whose rest cannot be reached, which
// is why a harness asserts the two agree.
const CF_FOLD_RE = /^\s*(?:…|\.\.\.)\s+\d+ lines?(?: hidden| shortened)(?:, \d+ lines? shortened)? — click to read\s*$/;
// jobs.json written before that wording existed says "… 12 more line(s)": the same open edge, so the same
// affordance. New notes never take this shape.
const CF_FOLD_LEGACY_RE = /^\s*(?:…|\.\.\.)\s+\d+ more line\(s\)\s*$/;
// The sentence itself, so the two worlds cannot drift: the server pushes exactly this text.
function foldNoteText({ hidden = 0, shortened = 0 } = {}) {
  const bits = [];
  if (hidden > 0) bits.push(`${hidden} line${hidden === 1 ? "" : "s"} hidden`);
  if (shortened > 0) bits.push(`${shortened} line${shortened === 1 ? "" : "s"} shortened`);
  return bits.length ? `… ${bits.join(", ")} — click to read` : "";
}
// A global, like consoleClassify and consoleFileOutput: public/app.js asks it before deciding whether the lines it
// was handed are all there is of a result.
function consoleCutNote(text) {
  return CF_NOTE_RE.test(text) && CF_CUT_RE.test(text);
}
// …and this one before deciding whether the rest of a result is one click away.
function consoleFoldNote(text) {
  const t = String(text ?? "");
  return CF_FOLD_RE.test(t) || CF_FOLD_LEGACY_RE.test(t);
}
// `ls -l`, `dir`, `stat`: a mode string. The leading "-" is the trap this exists for.
const CF_MODE_RE = /^[-dlbcps][rwxSsTt-]{9}[.+]?(?:\s|$)/;
const CF_GIT_HEAD_RE = /^diff --(?:git|cc|combined) /;
const CF_GIT_META_RE =
  /^(?:index [0-9a-f]{4,}\.\.[0-9a-f]{4,}(?: \d{6})?|old mode \d{6}|new mode \d{6}|new file mode \d{6}|deleted file mode \d{6}|(?:rename|copy) (?:from|to) .+|similarity index \d+%|dissimilarity index \d+%|Binary files .+ differ|GIT binary patch)$/;
// "@@ -168,10 +168,37 @@" and "@@ -25,0 +26 @@ import { ... }" both end in @@ and carry a range.
const CF_HUNK_RE = /^@{2,}[^@]*@{2,}/;
const CF_FILE_PLUS_RE = /^\+\+\+ \S/;
const CF_FILE_MINUS_RE = /^--- \S/;
const CF_BODY_RE = /^[-+ ]/;
// A result header ("  ↳ patch · 3.27s") leads with a space, exactly like a context line, so a body run has to
// be told about it: it is a label for the output under it, never a line of the output. It ends a run.
const CF_RESULT_HEAD_RE = /^\s*↳\s*\S/;
// A batch the gateway folded into one summary line ("cat x + 3 commands") is not one file's body.
const CF_BATCH_TAIL_RE = / \+\s*\d+\s+commands?\s*$/i;
// The tools whose whole output is a file (or a file's worth of text).
const CF_FILE_TOOLS = new Set(["read_file", "write_file", "cat", "bat", "type", "less", "more", "head", "tail", "view"]);
// A shell call that prints a file: cat/head/tail/type/less/more/bat, or `sed -n '1,50p' file`.
const CF_PRINT_CMD_RE = /^(?:cat|bat|type|less|more|head|tail)\s+(.+)$/;
const CF_SED_PRINT_RE = /^sed\s+-n\s+['"]?[\d,$]+p['"]?\s+(\S.*)$/;
// How many lines a run needs before it is worth a code box. One line is not a file being printed, and folding
// it away would hide the whole result behind a header for no gain.
const CF_CODE_MIN_LINES = 2;

const CF_DIFF_CLASSES = new Set(["githead", "fileminus", "fileplus", "hunk", "ctx", "del", "mod", "add", "cut"]);
// A body line of a hunk, before pairing: "-" removed, "+" added, " " context.
const CF_BODY_CLASS = { "-": "del", "+": "add", " ": "ctx" };

const cfText = (row) => String((row && row.text) != null ? row.text : "").replace(/\r+$/, "");
// Only a tool's output is eligible. A call line, a sentence, a panel note: never classified, so their colours
// and their spacing are untouched by anything in this file.
const cfEligible = (row) => {
  const kind = String((row && row.kind) || "");
  return kind === "tool-out" || kind === "store";
};

function cfHunkHead(text) {
  return CF_HUNK_RE.test(text) && /[+-]\d/.test(text);
}
function cfBodyClass(text) {
  const first = text.charAt(0);
  return CF_BODY_CLASS[first] || "";
}
// A line that ends a run of body lines: not body-shaped at all, a note, a result header, or a diff header
// that must be classified as a header rather than as the body line it resembles ("--- a/x" starts with "-",
// so it looks like a removal to anything that only reads the first character).
function cfBreaksRun(text) {
  return (
    !CF_BODY_RE.test(text) ||
    CF_NOTE_RE.test(text) ||
    CF_RESULT_HEAD_RE.test(text) ||
    CF_GIT_HEAD_RE.test(text) ||
    CF_GIT_META_RE.test(text) ||
    CF_FILE_PLUS_RE.test(text) ||
    CF_FILE_MINUS_RE.test(text) ||
    cfHunkHead(text)
  );
}
// A body run with no header at all: every line body-shaped, at least one removal and one addition, and at
// least one change block (a removal run immediately followed by an addition run). The change block is what a
// bulleted list and a `git diff --stat` cannot fake.
function cfHeaderlessRun(texts) {
  if (texts.length < 2) return false;
  let minus = 0;
  let plus = 0;
  let block = false;
  let run = "";
  for (const t of texts) {
    if (cfBreaksRun(t) || CF_MODE_RE.test(t)) return false;
    const c = cfBodyClass(t);
    if (c === "del") minus++;
    else if (c === "add") plus++;
    if (c === "add" && run === "del") block = true;
    if (c) run = c;
  }
  return minus > 0 && plus > 0 && block;
}

/**
 * Classify a run of console lines. Pure: same rows in, same classes out.
 * @param rows - [{ kind, text }] in the order the console draws them.
 * @param opts.fileOutput - the run is a file's body (the caller knows the tool), so its non-diff lines are
 *   candidates for a code box.
 * @returns {{ classes: string[], pair: (number|null)[] }} classes: "plain" | "code" | "githead" | "fileminus"
 *   | "fileplus" | "hunk" | "ctx" | "del" | "mod" | "add". pair: for a "mod", the index of its "+" partner;
 *   for a "+" that is a partner, the index of its "-" (so the renderer emits each row exactly once).
 */
function consoleClassify(rows, { fileOutput = false } = {}) {
  const n = Array.isArray(rows) ? rows.length : 0;
  const text = new Array(n);
  const cls = new Array(n).fill("plain");
  const pair = new Array(n).fill(null);
  const live = new Array(n);
  for (let i = 0; i < n; i++) {
    text[i] = cfText(rows[i]);
    live[i] = cfEligible(rows[i]);
  }
  // Pass 1: the diff. `inDiff` is open from a header or a hunk until a line that is not part of one.
  let inDiff = false;
  for (let i = 0; i < n; i++) {
    if (!live[i]) {
      inDiff = false;
      continue;
    }
    const t = text[i];
    // A preview the gateway cut, landing inside an open hunk: it belongs to that hunk as its cut edge, and it
    // still ends the run — nothing after it is part of the same change.
    if (inDiff && consoleCutNote(t)) {
      cls[i] = "cut";
      inDiff = false;
      continue;
    }
    // A blank context line in a unified diff is a single space, so only a line with nothing on it ends the
    // block: treating " " as empty cut every hunk that had a blank line in it.
    if (t === "" || CF_NOTE_RE.test(t) || CF_RESULT_HEAD_RE.test(t)) {
      inDiff = false;
      continue;
    }
    if (cfHunkHead(t)) {
      cls[i] = "hunk";
      inDiff = true;
      continue;
    }
    if (CF_GIT_HEAD_RE.test(t) || CF_GIT_META_RE.test(t)) {
      cls[i] = "githead";
      inDiff = true;
      continue;
    }
    if (CF_FILE_PLUS_RE.test(t)) {
      cls[i] = "fileplus";
      inDiff = true;
      continue;
    }
    if (CF_FILE_MINUS_RE.test(t) && (inDiff || CF_FILE_PLUS_RE.test(text[i + 1] || ""))) {
      cls[i] = "fileminus";
      inDiff = true;
      continue;
    }
    if (inDiff && CF_BODY_RE.test(t)) {
      cls[i] = cfBodyClass(t) || "plain";
      continue;
    }
    // No header: a body run stands on its own shape alone.
    if (!inDiff && CF_BODY_RE.test(t) && !cfBreaksRun(t)) {
      let end = i;
      while (end < n && live[end] && !cfBreaksRun(text[end])) end++;
      if (cfHeaderlessRun(text.slice(i, end))) {
        for (let k = i; k < end; k++) cls[k] = cfBodyClass(text[k]) || "plain";
        i = end - 1;
        continue;
      }
    }
    inDiff = false;
  }
  // Pass 2: pairing. A change block is a run of "-" immediately followed by a run of "+"; they pair index by
  // index, and whatever is left over on either side stands alone.
  for (let i = 0; i < n; i++) {
    if (cls[i] !== "del") continue;
    let d = i;
    while (d < n && cls[d] === "del") d++;
    let a = d;
    while (a < n && cls[a] === "add") a++;
    const pairs = Math.min(d - i, a - d);
    for (let k = 0; k < pairs; k++) {
      cls[i + k] = "mod";
      pair[i + k] = d + k;
      pair[d + k] = i + k;
    }
    i = a - 1;
  }
  // Pass 3: the code box. A maximal run of eligible, unclassified lines inside a file's output, two or more
  // lines long (empty lines included: they are content in a file). A note ends the run.
  if (fileOutput) {
    for (let i = 0; i < n; i++) {
      if (!live[i] || cls[i] !== "plain" || CF_NOTE_RE.test(text[i]) || CF_RESULT_HEAD_RE.test(text[i])) continue;
      let end = i;
      let solid = 0;
      while (end < n && live[end] && cls[end] === "plain" && !CF_NOTE_RE.test(text[end]) && !CF_RESULT_HEAD_RE.test(text[end])) {
        if (text[end].trim()) solid++;
        end++;
      }
      if (solid >= CF_CODE_MIN_LINES) for (let k = i; k < end; k++) cls[k] = "code";
      i = end - 1;
    }
  }
  return { classes: cls, pair };
}

// The classes, and nothing else: the shape a harness can assert on without reading markup.
function consoleLineClasses(rows, opts) {
  return consoleClassify(rows, opts).classes;
}

/**
 * Does this call's output print a file, and which one? Text in, label out — the caller passes the tool name
 * and the call line's argument (the panel's call lines read "📖 read_file · <arg>").
 * @returns {{ file: string } | null} null means: leave this result's lines exactly as they were.
 */
function consoleFileOutput(tool, arg) {
  const name = String(tool || "").trim();
  const a = String(arg || "").trim();
  if (CF_FILE_TOOLS.has(name)) return { file: a };
  if (name !== "terminal" && name !== "read_terminal") return null;
  if (!a || CF_BATCH_TAIL_RE.test(a)) return null;
  const m = CF_PRINT_CMD_RE.exec(a) || CF_SED_PRINT_RE.exec(a);
  if (!m) return null;
  const toks = m[1].trim().split(/\s+/);
  const last = toks[toks.length - 1] || "";
  // The last token is the file when it looks like one: a path, or a name with an extension. Anything else
  // (a flag, a word, a pipe) means this command is not a bare file print.
  if (!/[\\/.]/.test(last) || /^-/.test(last)) return null;
  return { file: last };
}

// ---- rendering ---------------------------------------------------------------------------------------

const cfEsc = (s) => (typeof esc === "function" ? esc(s) : String(s ?? ""));
const cfLink = (s) => (typeof linkifyText === "function" ? linkifyText(s) : cfEsc(s));
// One console line, whatever block it lands in. data-ltext/data-lkind are how a burst rebuild reads its lines
// back out of the DOM (groupLines): the cell's own text, never the rendered text of a link or a clock. `shown`
// overrides only what the reader sees — the chrome of a diff window shortens a path, and the line the console
// drew stays in data-ltext.
function cfLine(row, extra = "", shown = null) {
  const kind = String((row && row.kind) || "tool-out");
  const lid = row && row.lid != null && row.lid !== "" ? ` data-lid="${cfEsc(row.lid)}"` : "";
  const body = shown == null ? cfLink(cfText(row)) : cfEsc(shown);
  return `<div class="jl jl-${cfEsc(kind)}${extra ? ` ${extra}` : ""}" data-ltext="${cfEsc(cfText(row))}" data-lkind="${cfEsc(kind)}"${lid}>${body}</div>`;
}
// A window's labels: the file headers, the hunk line and the git/mode lines. They stay console lines (so a
// rebuild keeps them) but they are the frame's own chrome, not rows of the change: the two file headers name the
// same file, so each shows its own sign and the file's tail instead of two full paths, and the hunk line shows
// the range it always did.
function cfLabel(row, cls) {
  const tone = cls === "hunk" ? "is-hunk" : cls === "fileplus" ? "is-plus" : cls === "fileminus" ? "is-minus" : "is-meta";
  const text = cfText(row);
  const short = cls === "fileplus" || cls === "fileminus" ? `${text.slice(0, 3)} ${cfTailPath(cfDiffFile(row))}` : null;
  return cfLine(row, `df-label ${tone}`, short);
}
const cfTailPath = (p) => (typeof tailPath === "function" ? tailPath(p, 3) : String(p || ""));
function cfDiffFile(row) {
  return cfText(row)
    .replace(/^[-+]{3}\s+/, "")
    .replace(/^[ab]\//, "")
    .split("\t")[0]
    .trim();
}

// The cut edge of a hunk the gateway's preview stopped in the middle of. The panel's own note stays a console
// line (a rebuild has to read it back, and it is the sentence that names the cause); the words beside it say what
// the reader is looking at and where the rest of the result can be read.
const CF_CUT_HINT =
  " — cut here: the gateway's live preview stops mid-hunk, so this is NOT the whole change. The rest of this " +
  "result is in this call's stored output (open its own row) or in the worker's report file.";
function cfCutRow(row) {
  const kind = cfEsc(String((row && row.kind) || "tool-out"));
  return (
    `<div class="jl jl-${kind} df-label df-cut" data-ltext="${cfEsc(cfText(row))}" data-lkind="${kind}">` +
    `${cfLink(cfText(row))}<span class="df-cut-hint">${cfEsc(CF_CUT_HINT)}</span></div>`
  );
}

// The panel's own fold, drawn as the thing it is: an open edge with a click behind it. The card keeps a result's
// head in its console (a 5,000-line read pushed there whole would evict every other line the card had — the ring
// buffer is 600 lines), and the rest of it is in the session store. The note stays a console line (data-ltext on
// the row, so a burst rebuild reads it back exactly as before) and the button inside it carries which result to
// fetch: the turn, the tool and which of that turn's rows this is. Without those (a caller that cannot say) the
// sentence is drawn plain — an honest note with no promise behind it.
function cfFoldRow(row, fold) {
  const kind = cfEsc(String((row && row.kind) || "tool-out"));
  const text = cfText(row);
  const open = `<div class="jl jl-${kind} jl-fold" data-ltext="${cfEsc(text)}" data-lkind="${kind}">`;
  if (!fold || !fold.tool || fold.turn == null || fold.row == null) return `${open}${cfLink(text)}</div>`;
  const title =
    `this panel keeps a result's first ${fold.head > 0 ? fold.head : 40} lines on the card — ` +
    `the whole stored result is one click away`;
  return (
    `${open}<button type="button" class="fold-read" data-tool-fold="1" data-fold-turn="${cfEsc(String(fold.turn))}"` +
    ` data-fold-tool="${cfEsc(String(fold.tool))}" data-fold-row="${cfEsc(String(fold.row))}" title="${cfEsc(title)}">` +
    `${cfLink(text)}</button></div>`
  );
}

// One framed diff window: the identifiers as a chrome strip on top, then the two sides. Every row is its own
// two-column grid, so a modification's halves sit on one line, a lone addition leaves the right cell empty and a
// cut row spans the window's width.
function cfDiffWindow(labels, body, classes, pair, file) {
  const hasFileHead = labels.some((l) => classes[l.i] === "fileplus" || classes[l.i] === "fileminus");
  // Panel chrome, not a console line: no `jl` class and no data-ltext, so a burst rebuild does not read this
  // label back as a line of the diff (it did, and the next rebuild drew the file name as a body line).
  const carried =
    file && !hasFileHead
      ? `<div class="df-label df-lab-path is-meta">${cfEsc(cfTailPath(file))}</div>`
      : "";
  const head = `<div class="df-head">${carried}${labels.map((l) => cfLabel(l.row, classes[l.i])).join("")}</div>`;
  const rows = [];
  for (const b of body) {
    const c = classes[b.i];
    if (c === "ctx") {
      rows.push(`<div class="df-row">${cfLine(b.row, "df-c is-ctx")}</div>`);
      continue;
    }
    if (c === "cut") {
      rows.push(cfCutRow(b.row));
      continue;
    }
    if (c === "mod") {
      // The after half is drawn first: the new side is the LEFT one. data-lpair is what the read-back reads the
      // row back in the diff's own order by (see the module header).
      const at = pair[b.i];
      const after = at == null ? null : body.find((x) => x.i === at);
      rows.push(`<div class="df-row" data-lpair="1">${after ? cfLine(after.row, "df-c is-add") : ""}${cfLine(b.row, "df-c is-mod")}</div>`);
      continue;
    }
    if (c === "add") {
      // The right half of a pair was already drawn with it; a lone addition sits on the LEFT, with an empty
      // right cell so its column still lines up with the rows above and below.
      if (pair[b.i] != null) continue;
      rows.push(`<div class="df-row">${cfLine(b.row, "df-c is-add")}<div class="df-c is-gap" aria-hidden="true"></div></div>`);
      continue;
    }
    if (c === "del") rows.push(`<div class="df-row">${cfLine(b.row, "df-c is-del")}</div>`);
  }
  const bodyHtml = rows.length ? `<div class="df-body">${rows.join("")}</div>` : "";
  return `<div class="df-win">${head}${bodyHtml}</div>`;
}

// A run of diff lines becomes one window per hunk: the headers before a hunk are that window's labels, and
// the file they name is carried into the next window, so hunk 2 of a file still says which file it is.
function cfDiffHtml(rows, classes, pair, from, to) {
  const out = [];
  let labels = [];
  let body = [];
  let open = false;
  let file = "";
  const emit = () => {
    if (!open) return;
    if (labels.length || body.length) out.push(cfDiffWindow(labels, body, classes, pair, file));
    labels = [];
    body = [];
    open = false;
  };
  for (let i = from; i < to; i++) {
    const c = classes[i];
    if (c === "hunk") {
      // A hunk with no body yet still belongs to the headers before it: only close a window that drew lines.
      if (open && body.length) emit();
      open = true;
      labels.push({ i, row: rows[i] });
      continue;
    }
    if (c === "githead" || c === "fileminus" || c === "fileplus") {
      // A header after body lines belongs to the next file, so it starts a window of its own.
      if (open && body.length) emit();
      open = true;
      labels.push({ i, row: rows[i] });
      if (c === "fileplus" || (c === "fileminus" && !file)) file = cfDiffFile(rows[i]);
      continue;
    }
    open = true;
    body.push({ i, row: rows[i] });
  }
  emit();
  return out.join("");
}

/**
 * The console's file renderer. Rows in, HTML out.
 * @param rows - [{ kind, text, lid }] in draw order.
 * @param opts.tool - the tool this run came from ("" when the caller cannot know).
 * @param opts.arg - that call's argument, for a code box's header.
 * @param opts.codeOpen - a Set of code-box keys the reader has opened; the caller owns it (this stays pure).
 * @param opts.codeKey - the prefix a code box's key is built from (stable across a rebuild).
 */
function consoleBodyHtml(rows, opts = {}) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const n = list.length;
  if (!n) return "";
  const tool = String(opts.tool || "");
  const arg = String(opts.arg || "");
  const file = consoleFileOutput(tool, arg);
  const { classes, pair } = consoleClassify(list, { fileOutput: Boolean(file) });
  const open = opts.codeOpen && typeof opts.codeOpen.has === "function" ? opts.codeOpen : null;
  const out = [];
  let i = 0;
  while (i < n) {
    if (CF_DIFF_CLASSES.has(classes[i])) {
      let end = i;
      while (end < n && CF_DIFF_CLASSES.has(classes[end])) end++;
      out.push(cfDiffHtml(list, classes, pair, i, end));
      i = end;
      continue;
    }
    if (classes[i] === "code") {
      let end = i;
      while (end < n && classes[end] === "code") end++;
      out.push(cfCodeBox(list.slice(i, end), i, file, opts, open));
      i = end;
      continue;
    }
    // The panel's own fold, as the button that opens it (opts.fold says which result it is).
    if (consoleFoldNote(cfText(list[i]))) {
      out.push(cfFoldRow(list[i], opts.fold));
      i++;
      continue;
    }
    out.push(cfLine(list[i]));
    i++;
  }
  return out.join("");
}

function cfCodeBox(rows, at, file, opts, open) {
  const key = `${String(opts.codeKey || "")}|${at}`;
  const isOpen = Boolean(open && open.has(key));
  const name = file && file.file ? cfTailPath(file.file) : "";
  const what = name ? `${cfEsc(opts.tool || "output")} · ${cfEsc(name)}` : cfEsc(opts.tool || "output");
  const count = `${rows.length} line${rows.length === 1 ? "" : "s"}`;
  const title = file && file.file ? ` title="${cfEsc(file.file)}"` : "";
  return (
    `<div class="code-box${isOpen ? " is-open" : ""}">` +
    `<button type="button" class="code-head" data-code-fold="1" data-code-key="${cfEsc(key)}" aria-expanded="${isOpen ? "true" : "false"}"${title}>` +
    `<span class="code-caret">${isOpen ? "▾" : "▸"}</span><span class="code-what">${what}</span>` +
    `<span class="code-n">${count}</span><span class="code-hint">click to read</span></button>` +
    `<div class="code-body"${isOpen ? "" : " hidden"}>${rows.map((r) => cfLine(r)).join("")}</div>` +
    `</div>`
  );
}

window.WMApp = window.WMApp || {};
window.WMApp.core = window.WMApp.core || {};
// Published for the harnesses and for the later steps of the public/ split; app.js calls the bare names.
window.WMApp.core.consoleFormat = {
  classify: consoleClassify,
  lineClasses: consoleLineClasses,
  bodyHtml: consoleBodyHtml,
  fileOutput: consoleFileOutput,
  // Was this preview cut by the gateway? The console asks before it decides whether the lines it was handed are
  // all there is of a result, so the wording of the note lives here and nowhere else.
  cutNote: consoleCutNote,
  // …and was the rest of it folded by THIS panel? Same question, one cap down: the answer is what turns the note
  // into the button that fetches the whole stored result.
  foldNote: consoleFoldNote,
  // The fold note's own sentence, shared so the server's push (lib/jobs/console-lines.js) and this matcher cannot
  // drift apart — a harness drives both against the same string.
  foldText: foldNoteText,
};
