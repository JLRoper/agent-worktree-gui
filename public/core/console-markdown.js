// core/console-markdown.js — the console's PROSE, drawn as the markdown it already is.
//
// THE PROBLEM THIS SOLVES
//
// An agent writes `**PR #279 MERGED**`, `` `origin/main` `` and `***emphasis***`, and the console printed the
// punctuation: one grey wall where every marker sits on screen as a character. The output area is a <pre> of
// escaped text (public/app.js, `pre.job-out`), and escaping is right — the agent's words are DATA, never HTML —
// but escaping alone leaves the markup visible. This module turns the *agents' own sentences* into the shapes
// they meant (bold, italic, inline code, a fenced block, a heading, a list, a link) while keeping the safety
// rule that made escaping necessary in the first place.
//
// ESCAPE FIRST, THEN A CLOSED SUBSET. NEVER HTML FROM THE AGENT.
//
// Every string is escaped with the page's own escaper (core/dom-format.js `esc`: & < > " ') BEFORE any marker
// is looked at, and every tag this file emits is one it wrote itself — <strong>, <em>, <code>, <a>, a div for a
// block. There is no path by which a "<script>" or an "onerror=" in agent output becomes markup: by the time
// the marker rules run, those characters are already `&lt;script&gt;`. The subset is deliberately small and
// closed: **bold**, __bold__, *italic*, _italic_, ***both***, `inline code`, ``` fences, #..###### headings,
// - / * / + and 1. lists, [text](url), and a bare URL that stays clickable exactly as it always was.
//
// WHAT IS NOT RENDERED, ON PURPOSE
//
//   - No raw HTML, no entities from the agent, no `style=`/`class=` passthrough.
//   - No tables, no blockquotes, no images, no reference links, no setext headings, no nested lists. An agent
//     that writes them gets its own text back, plainly — which is the honest answer for a shape this file does
//     not claim to know.
//   - An UNPAIRED marker stays literal: `**still open` is printed as `**still open`, not swallowed. A half
//     sentence mid-stream therefore reads as the words, and turns into bold the moment the closing marker
//     arrives. (Nothing here rewrites the text to hide an unfinished marker.)
//   - Only prose is rendered. Tool call rows, tool output, the panel's own notes ("dim", "raw") and the run
//     protocol are never handed to `consoleMdInline`: a diff line beginning "+" is not a list item, and a
//     tool's JSON is not markdown. The caller decides which kinds are prose (`consoleMdIsProse`).
//
// THE BLOCK SHAPES, AND WHY THEY ARE BLOCKS
//
// A paragraph, a list, a heading and a fenced block are properties of a RUN of lines, not of one line: the
// fence's body is the lines under it, and a list is several items. So a run of prose lines is parsed into
// blocks (`consoleMdBlocks`) and each block is emitted as one wrapper with the source lines still inside it as
// `.jl` rows carrying `data-ltext`/`data-lkind`/`data-lid` — the same attributes every console line has, so
// nothing in the page that reads a console back out of the DOM (a burst rebuild, the stream's `[data-lid]`
// lookup, the copy button) has to learn a second shape. Only the wrapper and the row's inner HTML are new.
//
// A FENCE IS A WELL, NOT A WALL. Its head names the language (or "text") and counts the lines in it; past
// fifteen lines it arrives FOLDED, because a 200-line build log pasted into a card is not the reading surface —
// the reader opens it when they want it. Fifteen is the one number (`CONSOLE_MD_FENCE_FOLD`), used by the
// renderer and by the harness.
//
// THE RAW VIEW IS THE TURN'S OWN BYTES
//
// `consoleMdRawText(lines)` is the exact text the console was handed — every line, in order, joined by one
// newline, with nothing rendered and nothing invented. public/app.js paints it into the console verbatim
// (`textContent`, so even a `<` stays a `<`), which is what makes "show me the text as it arrived" a promise
// the page can keep for any turn, rendered or not.
//
// PURE, AND DRIVEN FROM TWO PLACES
//
// Everything here is text in, markup/decision out: no DOM, no clock, no state, no reader preferences. The page
// renders a whole run with `consoleMdHtml` (a repaint) and appends one line at a time while a turn streams with
// `consoleMdPlan` (what this line does to the block that is open) — one parser, two callers, so a live console
// and its repaint cannot disagree about where a fence ends.

// A fenced block longer than this arrives folded. The reader opens it; nothing is hidden that the head's own
// count does not name.
const CONSOLE_MD_FENCE_FOLD = 15;

// ---- escaping ----------------------------------------------------------------------------------------

const cmEsc = (s) =>
  typeof esc === "function"
    ? esc(s)
    : String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// A markdown link's target, and a bare URL. Both anchor through the panel's own open-url route, exactly like
// the links the console has always drawn: the host is what makes the click land in the OS browser rather than
// navigating the page.
const CM_URL_RE = /https?:\/\/[^\s<>"'`\u001b]+/g;

function cmAnchor(url, label) {
  return (
    `<a class="out-link" href="${url}" target="_blank" rel="noreferrer noopener" data-open-url="${url}" title="open in your browser">` +
    `${label}</a>`
  );
}
// Sentence punctuation after a URL belongs to the sentence, not to the link (the same rule linkifyText uses).
function cmTrimUrl(raw) {
  let url = raw;
  let tail = "";
  while (url && /[.,;:!?)\]]$/.test(url)) {
    tail = url.slice(-1) + tail;
    url = url.slice(0, -1);
  }
  const host = url.replace(/^https?:\/\//, "").split(/[/:?#]/)[0].toLowerCase();
  const plausible = host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(".");
  return plausible ? { url, tail } : null;
}

// ---- inline ------------------------------------------------------------------------------------------

// A code span opens with a RUN of backticks and closes with a run of the SAME length, so
// `` `render-projects.js:690-705` `` is one span whose content is `render-projects.js:690-705` rather than two
// one-space spans with the path left bare between them. A run with no closer stays literal, which is what keeps
// a half-typed line readable while it streams.
function cmBacktickRunEnd(s, from, n) {
  let i = from;
  while (i < s.length) {
    if (s[i] !== "`") {
      i += 1;
      continue;
    }
    let j = i;
    while (s[j] === "`") j += 1;
    if (j - i === n) return i;
    i = j;
  }
  return -1;
}

function cmLiftCode(s, hold) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] !== "`") {
      out += s[i];
      i += 1;
      continue;
    }
    let n = 0;
    while (s[i + n] === "`") n += 1;
    const end = cmBacktickRunEnd(s, i + n, n);
    if (end < 0) {
      out += s.slice(i, i + n);
      i += n;
      continue;
    }
    let code = s.slice(i + n, end);
    // CommonMark's one-space padding rule: `` `x` `` is code for "`x`", not for " `x` ".
    if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
    out += hold(`<code class="md-code">${code}</code>`);
    i = end + n;
  }
  return out;
}

// Every tag this file emits is one it wrote itself, so re-opening them across a line break is safe: a <strong>
// that opened on one line is closed before that row ends and opened again on the next. That is what makes a bold
// spanning a line break bold on BOTH rows instead of an unpaired marker on each.
const CM_TAG_RE = /<(\/?)([a-zA-Z][\w-]*)[^>]*>/g;
function cmRows(html) {
  const chunks = String(html).split("\n");
  const open = [];
  const rows = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    let row = i === 0 ? "" : open.map((tag) => `<${tag}>`).join("");
    row += chunk;
    CM_TAG_RE.lastIndex = 0;
    let m;
    while ((m = CM_TAG_RE.exec(chunk))) {
      const tag = m[2].toLowerCase();
      if (m[1] === "/") {
        const at = open.lastIndexOf(tag);
        if (at >= 0) open.splice(at, 1);
      } else if (!m[0].endsWith("/>")) {
        open.push(tag);
      }
    }
    for (let k = open.length - 1; k >= 0; k -= 1) row += `</${open[k]}>`;
    rows.push(row);
  }
  return rows;
}

// The inline subset, over ONE line or a RUN of lines. Code spans, links and bare URLs are lifted out first (they
// do not span a line break), then emphasis is applied to the whole run, so a marker that opens on one line and
// closes on the next is one run rather than an unpaired marker on each. The result is split back into one string
// per source line, with every tag still open at a break closed and re-opened.
function consoleMdInlineLines(texts) {
  const held = [];
  const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
  const src = (Array.isArray(texts) ? texts : [texts]).map((text) => String(text ?? ""));
  const lifted = src.map((text) => {
    let s = cmEsc(text);
    // `code` first: nothing inside a code span is a marker.
    s = cmLiftCode(s, hold);
    // [text](url): the label is rendered, and the url is shown beside it when it differs - a reader deciding
    // whether to click wants to see where the words point.
    s = s.replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, (_m, label, url) => {
      const shown = consoleMdInlineLabel(label);
      return hold(cmAnchor(url, shown) + (label.trim() === url ? "" : `<span class="md-link-url">${url}</span>`));
    });
    // A bare URL stays clickable, as it always was.
    s = s.replace(CM_URL_RE, (raw) => {
      const hit = cmTrimUrl(raw);
      return hit ? hold(cmAnchor(hit.url, hit.url) + hit.tail) : raw;
    });
    return s;
  });
  let s = lifted.join("\n");
  // ***both***, **bold**, *italic* - longest marker first, so `***x***` never reads as bold-then-literal. The
  // content may cross a line break; `cmRows` puts the rows back together.
  s = s.replace(/\*\*\*([^*]+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  s = s.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\w*])\*([^*]+?)\*(?![\w*])/g, "$1<em>$2</em>");
  s = s.replace(/___([^_]+?)___/g, "<strong><em>$1</em></strong>");
  s = s.replace(/__([^_]+?)__/g, "<strong>$1</strong>");
  // `snake_case_name` is an identifier, not emphasis: an opening `_` must not follow a word character, and a
  // closing one must not precede one.
  s = s.replace(/(^|[^\w_])_([^_]+?)_(?![^\w_])/g, "$1<em>$2</em>");
  return cmRows(s).map((row) => row.replace(/\u0000(\d+)\u0000/g, (_m, i) => held[Number(i)] || ""));
}

function consoleMdInline(text) {
  // One string in, one string out: the rows of a multi-line input are joined back with the newlines they had,
  // because a caller that hands this one string (a stored message) owns the line breaks.
  return consoleMdInlineLines([text]).join("\n");
}
// A link's label is a label: bold and italic inside it still work, but a link inside a link does not.
function consoleMdInlineLabel(label) {
  let s = String(label ?? "");
  s = s.replace(/`([^`\n]+)`/g, '<code class="md-code">$1</code>');
  s = s.replace(/\*\*\*([^*\n]+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\w*])\*([^*\n]+?)\*(?![\w*])/g, "$1<em>$2</em>");
  return s;
}
// ---- block shapes ------------------------------------------------------------------------------------

// ```lang (three or more backticks, or tildes), and a closing fence that carries no language.
const CM_FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*([\w.+#-]*)\s*$/;
const CM_HEAD_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const CM_UL_RE = /^\s{0,3}[-*+]\s+(.*)$/;
const CM_OL_RE = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const CM_BLANK_RE = /^\s*$/;

// Only the agent's own words are prose. A tool call, a tool's output, the panel's notes and the run protocol
// keep the plain console line they have always been — see the module header.
function consoleMdIsProse(kind) {
  const k = String(kind || "");
  return k === "text" || k === "final";
}

// ---- the assistant's command lines --------------------------------------------------------------------
// A reply's command lines (`QUEUE assistant-3 | ...`, `SPAWN IN <tree> | ...`) are not prose to be wrapped in a
// paragraph: each is ONE card, drawn by the module public/core/console-format.js publishes (`commandCard`), which is
// the same frame a tool's result is drawn in. A caller that wants them asks with `cards` - the agent card's
// transcript does (public/render-jobs.js hands the turn's scope and the reader's open book) - and every other
// caller, the console's own live append included, keeps the paragraph it has always drawn.
//
// A card is drawn only once the whole line is on screen: a head that appeared while the line was still being typed
// would claim a command the reader cannot read yet. So the block is decided from the line's own text, and the typed
// renderer draws a plain row until the visible prefix is the whole line.
function cmConsoleFormat() {
  const core = globalThis.WMApp && globalThis.WMApp.core;
  return core && core.consoleFormat ? core.consoleFormat : null;
}

function cmIsCommandLine(text, opts) {
  if (!opts || !opts.cards) return false;
  const cf = cmConsoleFormat();
  return Boolean(cf && typeof cf.commandLine === "function" && cf.commandLine(text));
}

function cmCommandCard(line, opts, i, bullets = null) {
  if (!opts || !opts.cards) return "";
  const cf = cmConsoleFormat();
  if (!cf || typeof cf.commandCard !== "function") return "";
  const lid = line && line.lid != null && line.lid !== "" ? String(line.lid) : null;
  // The key the reader's open state is kept under: the line's own id when it has one (it survives a repaint and a
  // window that drops the lines above it), its index in the run when it does not. `bullets` is a SPAWN's own TODOs,
  // folded into its card (see cmFoldCommandBlocks): the card draws them between its head and its body.
  return String(
    cf.commandCard(cmText(line), {
      ...opts.cards,
      ref: lid == null ? i : lid,
      lid,
      lineKind: String((line && line.kind) || "text"),
      ...(Array.isArray(bullets) && bullets.length ? { bullets } : {}),
    }) || "",
  );
}

// A SPAWN's own TODO lines are that card's bullets, not four more cards. The rule lives in
// public/core/assistant-command.js (`foldSpawnTodos`, reached through the frame's `commandFold` seam), so the
// transcript and the Messages pane cannot disagree about which TODO belongs to which SPAWN. A command block that is
// one of those bullets is DROPPED from the run: the block above it carries it, and drawing both would be the defect
// this fold exists to stop. Only a caller that asked for cards (the agent card's transcript) takes this path; the
// console's own live append keeps every row it always drew.
function cmFoldCommandBlocks(blocks, opts) {
  if (!opts || !opts.cards) return blocks;
  const cf = cmConsoleFormat();
  if (!cf || typeof cf.commandFold !== "function") return blocks;
  // Prose and fence blocks answer with an empty text on purpose: they neither own nor are a TODO, and a SPAWN's
  // ownership is not broken by a sentence between it and its items.
  const plan = cf.commandFold(blocks.map((b) => ({ text: b.type === "cmd" && b.lines[0] ? cmText(b.lines[0]) : "" })));
  const out = [];
  blocks.forEach((b, i) => {
    if (b.type !== "cmd") {
      out.push(b);
      return;
    }
    const p = plan[i] || {};
    if (p.folded) return;
    out.push(Array.isArray(p.todos) && p.todos.length ? { ...b, todos: p.todos } : b);
  });
  return out;
}

const cmText = (line) => String((line && line.text) != null ? line.text : "").replace(/\r+$/, "");

// ---- physical lines ----------------------------------------------------------------------------------
// A console line can carry several PHYSICAL lines inside its own text. lib/jobs.js keeps ONE open line per
// paragraph and grows it in place, and a gateway may hand a whole answer over in a single delta - so the line a
// turn's record holds is one string with blank lines, bullets, headings and fences in it (job 6073fb2a holds a
// 4,446-character answer that way). Markdown is a property of a RUN of physical lines, so the run is expanded
// HERE, before the parser sees it.
//
// Without this the parser read the string as one paragraph, and every block renderer then indexed the per-line
// output of consoleMdInlineLines() with the index of the STORE line it came from: `inner[0]` was drawn and every
// row after it was dropped, which is a console that stops after the opening sentence while data-ltext still holds
// the whole answer.
//
// The expansion is IDEMPOTENT (a segment carries no newline) and it keeps the turn's own words: each segment's
// `data-ltext` is its own physical line, so the rows read back joined by a newline are the stored string exactly.
// Ids stay addressable: the first segment keeps the store line's own `lid`, so a line that grows a newline later
// updates the row already on screen, and the ones after it are `lid.1`, `lid.2`...
function consoleMdPhysicalLines(lines) {
  const out = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    if (!line) continue;
    const text = cmText(line);
    if (!consoleMdIsProse(line.kind) || !text.includes("\n")) {
      out.push(line);
      continue;
    }
    const base = line.lid == null || line.lid === "" ? null : String(line.lid);
    text.split("\n").forEach((part, i) => {
      const seg = { ...line, text: part, ...(base == null || i === 0 ? {} : { lid: `${base}.${i}` }) };
      Object.defineProperty(seg, "_cmLine", { value: line, enumerable: false });
      Object.defineProperty(seg, "_cmRow", { value: i, enumerable: false });
      out.push(seg);
    });
  }
  return out;
}

// A run of prose lines, as blocks. Pure: same lines in, same blocks out, no reader state.
//   { type: "para" | "list" | "head" | "fence", lines: [...] }
//   list:  ordered (boolean)
//   head:  level (1..6)
//   fence: lang (string), open (the closing fence has not arrived yet), code (boolean — this block is code)
//   cmd:   one command line, drawn as its own card (only when the caller asked with `opts.cards`)
function consoleMdBlocks(lines, opts = {}) {
  const list = consoleMdPhysicalLines(lines).filter(Boolean);
  const out = [];
  let cur = null;
  const flush = () => {
    if (cur) out.push(cur);
    cur = null;
  };
  for (const line of list) {
    const text = cmText(line);
    // Inside a fence every line is content, including one that looks like a heading, a list or a blank line:
    // the only thing that ends it is its own closing fence.
    if (cur && cur.type === "fence" && cur.open) {
      if (CM_FENCE_RE.test(text)) {
        cur.open = false;
        continue;
      }
      cur.lines.push(line);
      continue;
    }
    if (CM_BLANK_RE.test(text)) {
      flush();
      continue;
    }
    // A command line is a block of its own, and the one block drawn as a card. Checked before every other shape:
    // nothing about it is a paragraph, a heading or a fence, and it ends whatever run was open above it.
    if (cmIsCommandLine(text, opts)) {
      flush();
      out.push({ type: "cmd", lines: [line] });
      continue;
    }
    const fence = CM_FENCE_RE.exec(text);
    if (fence) {
      flush();
      cur = { type: "fence", lang: fence[2] || "", open: true, lines: [], code: true };
      continue;
    }
    const head = CM_HEAD_RE.exec(text);
    if (head) {
      flush();
      cur = { type: "head", level: head[1].length, lines: [line] };
      continue;
    }
    const ul = CM_UL_RE.exec(text);
    const ol = CM_OL_RE.exec(text);
    if (ul || ol) {
      const ordered = Boolean(ol);
      if (!cur || cur.type !== "list" || cur.ordered !== ordered) {
        flush();
        cur = { type: "list", ordered, lines: [] };
      }
      cur.lines.push(line);
      continue;
    }
    if (!cur || cur.type !== "para") {
      flush();
      cur = { type: "para", lines: [] };
    }
    cur.lines.push(line);
  }
  flush();
  return cmFoldCommandBlocks(out, opts);
}

// ---- markup ------------------------------------------------------------------------------------------

// One console line. `data-ltext`/`data-lkind`/`data-lid` are the console's contract with every reader of the
// DOM (see the module header), and they carry the SOURCE line — never the rendered text of a link or a bold
// run — so a rebuild reads back exactly what the turn said.
function consoleMdRow(line, { cls = "", inner = null, attrs = "" } = {}) {
  const kind = String((line && line.kind) || "text");
  const lid = line && line.lid != null && line.lid !== "" ? ` data-lid="${cmEsc(line.lid)}"` : "";
  const body = inner != null ? inner : consoleMdInline(cmText(line));
  return (
    `<div class="jl jl-${cmEsc(kind)} md-l${cls ? ` ${cls}` : ""}"` +
    ` data-ltext="${cmEsc(cmText(line))}" data-lkind="${cmEsc(kind)}"${lid}${attrs}>${body}</div>`
  );
}

// A fence's head: the language, the count, and — past the fold — the button that opens it. The button is a real
// <button> so a keyboard reaches it, and `aria-expanded` says what pressing it will do.
function consoleMdFenceHead(lang, n) {
  const label = lang || "text";
  const folded = n > CONSOLE_MD_FENCE_FOLD;
  const count = `${n} line${n === 1 ? "" : "s"}`;
  const button = folded
    ? `<button type="button" class="md-fence-btn" data-md-fence="1" aria-expanded="false" title="read the ${count} in this block">show ${count}</button>`
    : "";
  return (
    `<div class="md-fence-head"><span class="md-fence-caret" aria-hidden="true">${folded ? "\u25b8" : "\u25be"}</span>` +
    `<span class="md-fence-lang">${cmEsc(label)}</span><span class="md-fence-n">${count}</span>${button}</div>`
  );
}
const cmFenceHead = (block) => consoleMdFenceHead(block.lang, block.lines.length);

function cmFenceHtml(block, rowOpts) {
  const n = block.lines.length;
  // A fence still arriving is drawn open: the reader watches it fill. Only a finished, over-long one is folded.
  const folded = !block.open && n > CONSOLE_MD_FENCE_FOLD;
  const body = block.lines.map((line) => consoleMdRow(line, { ...rowOpts, cls: "md-code-l", inner: cmEsc(cmText(line)) })).join("");
  return (
    `<div class="md-block md-fence${folded ? " is-folded" : ""}" data-md-block="fence"` +
    ` data-md-lang="${cmEsc(block.lang || "text")}" data-md-lines="${n}">` +
    cmFenceHead(block) +
    `<div class="md-fence-body"${folded ? " hidden" : ""}>${body}</div></div>`
  );
}

// One block's markup. A paragraph is a run of console rows with the spacing above and below it; a list row
// carries its own marker (the source line keeps its "- " in data-ltext, so a rebuild is exact).
function consoleMdBlockHtml(block, opts = {}) {
  const rowOpts = opts.rowOpts || {};
  // A command line's card IS the block: no `.md-block` wrapper, because the card is a frame of its own (the same one
  // a result is drawn in) and a wrapper would only add margins around margins.
  if (block.type === "cmd") return cmCommandCard(block.lines[0], opts, Number(opts.index) || 0, block.todos);
  if (block.type === "fence") return cmFenceHtml(block, rowOpts);
  if (block.type === "head") {
    // The `##` is the marker, not the sentence: data-ltext keeps the source line whole, the row shows the words.
    const m = CM_HEAD_RE.exec(cmText(block.lines[0]));
    return (
      `<div class="md-block md-head" data-md-block="head" data-md-level="${block.level}">` +
      consoleMdRow(block.lines[0], { ...rowOpts, cls: `md-head-l md-h${block.level}`, inner: consoleMdInline(m ? m[2] : cmText(block.lines[0])) }) +
      `</div>`
    );
  }
  if (block.type === "list") {
    const rests = block.lines.map((line) => {
      const text = cmText(line);
      const m = CM_OL_RE.exec(text) || CM_UL_RE.exec(text);
      return m ? (block.ordered ? m[2] : m[1]) : text;
    });
    // One run, so a bold that opens on one item and closes on the next is bold on both (see consoleMdInlineLines).
    const inner = consoleMdInlineLines(rests);
    const rows = block.lines.map((line, i) => {
      const text = cmText(line);
      const m = CM_OL_RE.exec(text) || CM_UL_RE.exec(text);
      const marker = block.ordered && m ? `${m[1]}.` : "\u2022";
      return consoleMdRow(line, {
        ...rowOpts,
        cls: "md-li",
        inner: `<span class="md-marker" aria-hidden="true">${cmEsc(marker)}</span><span class="md-li-t">${inner[i]}</span>`,
      });
    });
    return `<div class="md-block md-list" data-md-block="list"${block.ordered ? ' data-md-ordered="1"' : ""}>${rows.join("")}</div>`;
  }
  const inner = consoleMdInlineLines(block.lines.map(cmText));
  const rows = block.lines.map((line, i) => consoleMdRow(line, { ...rowOpts, inner: inner[i] })).join("");
  return `<div class="md-block md-para" data-md-block="para">${rows}</div>`;
}

/**
 * A run of prose lines, as markup.
 * @param lines - [{ kind, text, lid }] in draw order.
 * @param opts.sep - put the stream's blank line (`jl-sep`) on the first block (the console sets every piece of
 *   one stream apart from the piece above it; a repaint must not lose it).
 * @param opts.textOf - the visible text for a line, for a caller with a drawn stream: (line) => string|null.
 */
function consoleMdHtml(lines, opts = {}) {
  // The run is expanded into its PHYSICAL lines first (see consoleMdPhysicalLines): a store line that carries
  // several blocks is drawn as those blocks, and the stream's prefix of that line is shared out the same way.
  const list = consoleMdPhysicalLines(Array.isArray(lines) ? lines.filter(Boolean) : []);
  if (!list.length) return "";
  const ask = typeof opts.textOf === "function" ? opts.textOf : null;
  const textOf = ask
    ? (line) => {
        const parent = line._cmLine || line;
        const shown = ask(parent);
        if (shown == null || parent === line) return shown;
        // The stream answers for the STORE line; this row is one physical line of it, so it takes the same index
        // from the prefix. A row the prefix has not reached yet is empty rather than whole.
        const rows = String(shown).split("\n");
        return line._cmRow < rows.length ? rows[line._cmRow] : "";
      }
    : null;
  const blocks = consoleMdBlocks(list, opts);
  return blocks
    .map((block, i) => {
      // A typed run is drawn up to the words that may be shown now, row by row: the same blocks, the same
      // fence head, only each row's inner HTML is the visible prefix instead of the whole line.
      const html = textOf ? consoleMdTypedBlockHtml(block, textOf, opts, i) : consoleMdBlockHtml(block, { cards: opts.cards, index: i });
      return i === 0 && opts.sep ? `<div class="md-sep ${opts.sep}"></div>${html}` : html;
    })
    .join("");
}

// The typed variant: every row's inner HTML is the stream's visible prefix, rendered inline. Nothing else
// changes — the block, the fence and its head are the same shapes.
function consoleMdTypedBlockHtml(block, textOf, opts = {}, index = 0) {
  const shownOf = (line) => {
    const shown = textOf(line);
    return shown == null ? cmText(line) : String(shown);
  };
  if (block.type === "cmd") {
    // The card waits for the whole line (see cmCommandCard): until the stream has released the last character, the
    // line is the plain row it was while it was being written.
    const line = block.lines[0];
    if (shownOf(line) !== cmText(line)) return consoleMdRow(line, { inner: consoleMdInline(shownOf(line)) });
    return cmCommandCard(line, opts, index, block.todos);
  }
  if (block.type === "fence") {
    const n = block.lines.length;
    const folded = !block.open && n > CONSOLE_MD_FENCE_FOLD;
    const body = block.lines.map((line) => consoleMdRow(line, { cls: "md-code-l", inner: cmEsc(cmText(line)) })).join("");
    return (
      `<div class="md-block md-fence${folded ? " is-folded" : ""}" data-md-block="fence" data-md-lang="${cmEsc(block.lang || "text")}" data-md-lines="${n}">` +
      cmFenceHead(block) +
      `<div class="md-fence-body"${folded ? " hidden" : ""}>${body}</div></div>`
    );
  }
  if (block.type === "head") {
    const shown = shownOf(block.lines[0]).replace(/^\s{0,3}#{1,6}\s+/, "");
    return (
      `<div class="md-block md-head" data-md-block="head" data-md-level="${block.level}">` +
      consoleMdRow(block.lines[0], { cls: `md-head-l md-h${block.level}`, inner: consoleMdInline(shown) }) +
      `</div>`
    );
  }
  if (block.type === "list") {
    const shownTexts = block.lines.map((line) => shownOf(line).replace(/^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+/, ""));
    const inner = consoleMdInlineLines(shownTexts);
    const items = block.lines.map((line, i) => {
      const text = cmText(line);
      const m = CM_OL_RE.exec(text) || CM_UL_RE.exec(text);
      const ordered = Boolean(CM_OL_RE.exec(text));
      const marker = ordered && m ? `${m[1]}.` : "\u2022";
      // The marker is drawn by this row; the source line still carries it, so the visible text strips the same
      // prefix the parser matched (a typed prefix may not include it yet, which leaves the words alone).
      return consoleMdRow(line, {
        cls: "md-li",
        inner: `<span class="md-marker" aria-hidden="true">${cmEsc(marker)}</span><span class="md-li-t">${inner[i]}</span>`,
      });
    });
    return `<div class="md-block md-list" data-md-block="list"${block.ordered ? ' data-md-ordered="1"' : ""}>${items.join("")}</div>`;
  }
  const inner = consoleMdInlineLines(block.lines.map(shownOf));
  return `<div class="md-block md-para" data-md-block="para">${block.lines.map((line, i) => consoleMdRow(line, { inner: inner[i] })).join("")}</div>`;
}

// ---- the live append path ------------------------------------------------------------------------------

// What one arriving line does to the block that is open. The page holds the DOM; this decides the shape, from
// the same rules `consoleMdBlocks` uses for a repaint, so the two cannot disagree about where a fence ends.
//   { action: "line" }   — another line of the open paragraph
//   { action: "item" }   — another item of the open list
//   { action: "code" }   — a line of the open fence
//   { action: "close" }  — the closing fence: finalise the open fence, draw nothing
//   { action: "break" }  — a blank line: close the open block, draw nothing
//   { action: "new", type, ordered?, lang?, open? } — start a block
function consoleMdPlan(prev, line) {
  const text = cmText(line);
  if (prev && prev.type === "fence" && prev.open) {
    if (CM_FENCE_RE.test(text)) return { action: "close" };
    return { action: "code" };
  }
  if (CM_BLANK_RE.test(text)) return { action: "break" };
  const fence = CM_FENCE_RE.exec(text);
  if (fence) return { action: "new", type: "fence", lang: fence[2] || "", open: true };
  if (CM_HEAD_RE.test(text)) return { action: "new", type: "head" };
  const ul = CM_UL_RE.exec(text);
  const ol = CM_OL_RE.exec(text);
  if (ul || ol) {
    const ordered = Boolean(ol);
    if (prev && prev.type === "list" && prev.ordered === ordered) return { action: "item" };
    return { action: "new", type: "list", ordered };
  }
  if (prev && prev.type === "para") return { action: "line" };
  return { action: "new", type: "para" };
}

// The opening markup of a block the append path is starting, and the row markup for a line inside one. Kept
// here so the live console and a repaint emit the same classes.
function consoleMdOpenHtml(plan) {
  if (plan.type === "fence") {
    return (
      `<div class="md-block md-fence is-open" data-md-block="fence" data-md-lang="${cmEsc(plan.lang || "text")}" data-md-lines="0">` +
      `<div class="md-fence-head"><span class="md-fence-caret" aria-hidden="true">\u25be</span>` +
      `<span class="md-fence-lang">${cmEsc(plan.lang || "text")}</span><span class="md-fence-n">0 lines</span></div>` +
      `<div class="md-fence-body"></div></div>`
    );
  }
  if (plan.type === "list") {
    return `<div class="md-block md-list" data-md-block="list"${plan.ordered ? ' data-md-ordered="1"' : ""}></div>`;
  }
  if (plan.type === "head") return `<div class="md-block md-head" data-md-block="head"></div>`;
  return `<div class="md-block md-para" data-md-block="para"></div>`;
}

// One line's markup, as the append path needs it: inside a paragraph, a list item, a heading, or a fence's code.
function consoleMdAppendRow(line, type, opts = {}) {
  const text = cmText(line);
  // A caller with a drawn stream answers for a line that is still being typed; `null` means it has nothing to say
  // about this one (it has not been queued, or the whole line may be shown), and the line is drawn whole.
  const shown = typeof opts.textOf === "function" ? opts.textOf(line) : null;
  const visible = shown == null ? text : String(shown);
  if (type === "fence") return consoleMdRow(line, { cls: "md-code-l", inner: cmEsc(text) });
  if (type === "list") {
    const m = CM_OL_RE.exec(text) || CM_UL_RE.exec(text);
    const ordered = Boolean(CM_OL_RE.exec(text));
    const marker = ordered && m ? `${m[1]}.` : "\u2022";
    return consoleMdRow(line, {
      cls: "md-li",
      inner: `<span class="md-marker" aria-hidden="true">${cmEsc(marker)}</span><span class="md-li-t">${consoleMdInline(visible)}</span>`,
    });
  }
  if (type === "head") {
    return consoleMdRow(line, { cls: "md-head-l", inner: consoleMdInline(visible.replace(/^\s{0,3}#{1,6}\s+/, "")) });
  }
  return consoleMdRow(line, { inner: consoleMdInline(visible) });
}

// ---- the raw view -------------------------------------------------------------------------------------

// The turn's own bytes: every line, in order, one newline between them, nothing rendered and nothing added.
// public/app.js writes this with textContent, so the reader gets the text exactly as the agent sent it.
function consoleMdRawText(lines) {
  return (Array.isArray(lines) ? lines.filter(Boolean) : []).map((line) => cmText(line)).join("\n");
}

window.WMApp = window.WMApp || {};
window.WMApp.core = window.WMApp.core || {};
// Published the way core/console-format.js is: the page calls the bare names, harnesses read the namespace.
window.WMApp.core.consoleMarkdown = {
  inline: consoleMdInline,
  blocks: consoleMdBlocks,
  physicalLines: consoleMdPhysicalLines,
  isProse: consoleMdIsProse,
  blockHtml: consoleMdBlockHtml,
  html: consoleMdHtml,
  plan: consoleMdPlan,
  openHtml: consoleMdOpenHtml,
  appendRow: consoleMdAppendRow,
  fenceHead: consoleMdFenceHead,
  rawText: consoleMdRawText,
  isProse: consoleMdIsProse,
  fenceFold: CONSOLE_MD_FENCE_FOLD,
};
