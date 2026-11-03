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
// nothing in the page that reads a console back out of the DOM (a burst rebuild, the pacer's `[data-lid]`
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

// The inline subset, on ONE line. Code spans and links are lifted out before emphasis is applied, so a `*` in a
// URL or a `` ` `` inside bold cannot be read as the wrong marker: the placeholder is a character no rule
// matches, and the finished HTML is put back at the end.
function consoleMdInline(text) {
  const held = [];
  const hold = (html) => `\u0000${held.push(html) - 1}\u0000`;
  let s = cmEsc(text);
  // `code` first: nothing inside a code span is a marker.
  s = s.replace(/`([^`\n]+)`/g, (_m, code) => hold(`<code class="md-code">${code}</code>`));
  // [text](url): the label is rendered, and the url is shown beside it when it differs — a reader deciding
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
  // ***both***, **bold**, *italic* — longest marker first, so `***x***` never reads as bold-then-literal.
  s = s.replace(/\*\*\*([^*\n]+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\w*])\*([^*\n]+?)\*(?![\w*])/g, "$1<em>$2</em>");
  s = s.replace(/___([^_\n]+?)___/g, "<strong><em>$1</em></strong>");
  s = s.replace(/__([^_\n]+?)__/g, "<strong>$1</strong>");
  // `snake_case_name` is an identifier, not emphasis: an opening `_` must not follow a word character, and a
  // closing one must not precede one.
  s = s.replace(/(^|[^\w_])_([^_\n]+?)_(?![\w_])/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => held[Number(i)] || "");
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

const cmText = (line) => String((line && line.text) != null ? line.text : "").replace(/\r+$/, "");

// A run of prose lines, as blocks. Pure: same lines in, same blocks out, no reader state.
//   { type: "para" | "list" | "head" | "fence", lines: [...] }
//   list:  ordered (boolean)
//   head:  level (1..6)
//   fence: lang (string), open (the closing fence has not arrived yet), code (boolean — this block is code)
function consoleMdBlocks(lines) {
  const list = (Array.isArray(lines) ? lines : []).filter(Boolean);
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
  return out;
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
    const rows = block.lines.map((line) => {
      const text = cmText(line);
      const m = CM_OL_RE.exec(text) || CM_UL_RE.exec(text);
      const marker = block.ordered && m ? `${m[1]}.` : "\u2022";
      const rest = m ? (block.ordered ? m[2] : m[1]) : text;
      return consoleMdRow(line, {
        ...rowOpts,
        cls: "md-li",
        inner: `<span class="md-marker" aria-hidden="true">${cmEsc(marker)}</span><span class="md-li-t">${consoleMdInline(rest)}</span>`,
      });
    });
    return `<div class="md-block md-list" data-md-block="list"${block.ordered ? ' data-md-ordered="1"' : ""}>${rows.join("")}</div>`;
  }
  const rows = block.lines.map((line) => consoleMdRow(line, rowOpts)).join("");
  return `<div class="md-block md-para" data-md-block="para">${rows}</div>`;
}

/**
 * A run of prose lines, as markup.
 * @param lines - [{ kind, text, lid }] in draw order.
 * @param opts.sep - put the stream's blank line (`jl-sep`) on the first block (the console sets every piece of
 *   one stream apart from the piece above it; a repaint must not lose it).
 * @param opts.textOf - the visible text for a line, for a caller with a word pacer: (line) => string|null.
 */
function consoleMdHtml(lines, opts = {}) {
  const list = Array.isArray(lines) ? lines.filter(Boolean) : [];
  if (!list.length) return "";
  const textOf = typeof opts.textOf === "function" ? opts.textOf : null;
  const blocks = consoleMdBlocks(list);
  return blocks
    .map((block, i) => {
      // A pacer-typed run is drawn up to the words that may be shown now, row by row: the same blocks, the same
      // fence head, only each row's inner HTML is the visible prefix instead of the whole line.
      const html = textOf ? consoleMdTypedBlockHtml(block, textOf) : consoleMdBlockHtml(block);
      return i === 0 && opts.sep ? `<div class="md-sep ${opts.sep}"></div>${html}` : html;
    })
    .join("");
}

// The typed variant: every row's inner HTML is the pacer's visible prefix, rendered inline. Nothing else
// changes — the block, the fence and its head are the same shapes.
function consoleMdTypedBlockHtml(block, textOf) {
  const shownOf = (line) => {
    const shown = textOf(line);
    return shown == null ? cmText(line) : String(shown);
  };
  const row = (line, opts = {}) => consoleMdRow(line, { ...opts, inner: consoleMdInline(shownOf(line)) });
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
    const items = block.lines.map((line) => {
      const text = cmText(line);
      const m = CM_OL_RE.exec(text) || CM_UL_RE.exec(text);
      const ordered = Boolean(CM_OL_RE.exec(text));
      const marker = ordered && m ? `${m[1]}.` : "\u2022";
      // The marker is drawn by this row; the source line still carries it, so the visible text strips the same
      // prefix the parser matched (a typed prefix may not include it yet, which leaves the words alone).
      const rest = shownOf(line).replace(/^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+/, "");
      return consoleMdRow(line, {
        cls: "md-li",
        inner: `<span class="md-marker" aria-hidden="true">${cmEsc(marker)}</span><span class="md-li-t">${consoleMdInline(rest)}</span>`,
      });
    });
    return `<div class="md-block md-list" data-md-block="list"${block.ordered ? ' data-md-ordered="1"' : ""}>${items.join("")}</div>`;
  }
  return `<div class="md-block md-para" data-md-block="para">${block.lines.map((line) => row(line)).join("")}</div>`;
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
  // A caller with a word pacer answers for a line that is still being typed; `null` means it has nothing to say
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
