// Cut 2 of four for public/board/console.js, card 9 of docs/reports/module-separation-2026-11-28.html's split plan.
// The plan named two runs for this cut, 74-1,005 and 1,553-2,276, and this file holds them in that order. A classic
// script, loaded by public/index.html after /board/console.js and before app.js.
//
// WHAT MOVED, BYTE FOR BYTE: the gateway wait line, a reasoning row's first section and its dots, the thinking rows
// (thinkLid/thinkSection/thinkRowHtml/patchThinkRow and the fit), one console line (lineHtml) and the tool-burst
// groups, the fold lookups, the tool-group repaint, and then - from the second run - the docked sub-console and its
// colour and margin, reasoning-first pacing, the result row head, the console row text, the markdown prose and the
// raw view with its focus and fence controls.
//
// The page's own globals are unchanged. Every top-level `function` here is a `window` property under its own name, and
// every top-level `const`/`let` a binding in the one global lexical environment console.js and app.js read, so not one
// call site changes: the names console.js no longer declares are still page globals, declared here.

// ---- gateway wait line
// A run's stream can be empty for a minute while the gateway starts it - measured on run_1ab0c80b: POST at 15:09:01,
// the first event of ANY kind at 15:10:24, and in between the card's head said "no events yet · 56s" while its BODY
// said nothing at all. That is why a live run read as a dead panel. lib/jobs.js pushes one dim line into the body at
// subscribe, marked `wait: "gateway"`; this draws it with an age that ticks IN PLACE (the card's one-second
// `tickLiveClocks`, public/app.js), and past PULSE_SILENT_SECONDS it states the silence plainly. The claim is the
// GATEWAY's - this panel holds the run's stream and has taken no event off it - and never what the model is doing.
// The row stops waiting when the same line comes back as a `set` from lib/jobs.js (noteFirstEvent / noteNoEventAtSettle),
// so there is never a second row about one wait.
const GW_WAIT_STARTED = "run started - the gateway has sent nothing yet · ";
const GW_WAIT_SILENT = "the run is still live - the gateway has sent nothing for ";

function waitAgeSecs(at) {
  return Math.max(0, (Date.now() - (Number(at) || Date.now())) / 1000);
}

// The sentence the row says now, with the age at its END so the ticker rewrites one slot and the words stay put.
function waitLineWords(secs) {
  return secs >= PULSE_SILENT_SECONDS ? GW_WAIT_SILENT : GW_WAIT_STARTED;
}

function waitLineHtml(l) {
  const secs = waitAgeSecs(l.at);
  return `<span data-gwait-label>${esc(waitLineWords(secs))}</span><span data-gwait-age>${esc(fmtSeconds(secs))}</span>`;
}
// ---- end gateway wait line

// ---- reasoning: one row of the same stream ----------------------------------------------------------
// A thought is a console line, not a pane above it. Two writers put rows here and they must agree on
// what one row IS: the run's own live preview (a `thinkOnly` frame, appended while it grows) and the
// settled read of lib/thinking.js blocks (merged into the record by `at`). Both name the row
// `think:<at>`, so an append, a repaint and a store read all address the same node, and when the store
// read replaces the previews it removes those rows rather than drawing the same thought twice.
//
// The row is DIM, and MINIMIZED it shows only the thought's FIRST SECTION - everything up to the first blank line -
// ending in four dots whenever anything is hidden (queue row #292). A press opens it in place and shows every
// paragraph with no dots. The markup carries the whole thought in `data-ltext` (a copy of the record still finds it);
// what is DRAWN is the section, not the whole block. While thought is still arriving the row carries its own
// "thinking" mark INSIDE the console output, with the age the card's clock ticks from the block's `at` - a reader
// looking at the stream can tell a thought still being written from one that has finished.
const thinkOpenRows = new Set(); // lid -> the reader opened this thought

function thinkLid(at) {
  return `think:${Number(at) || 0}`;
}

// ---- a thought's first section, and the dots that say more is hidden ----------------------------------------------
// The reader's rule: the delimiter is a BLANK LINE - two consecutive newlines, with spaces or tabs allowed on the
// empty line - and the minimized row is the first section, not the first four lines of everything. The four-line lid
// STAYS as a second bound for a first section that is itself longer than the clip, so the minimized form is whichever
// ends first, and the lid cuts at a word boundary rather than inside a word.
//
// The dots are appended to the same text run (an inline span inside `.think-text`, never a block of its own), so they
// cannot add a line, and a thought that is fully shown carries none.
//
// The shapes that would otherwise bite, and what each one does here:
//   * CRLF ("p1", then a blank CRLF line, then "p2"): the CR belongs to the line terminator, so the blank line is blank.
//   * a lone newline ("p1\np2"): one line break is not a blank line, so the section continues.
//   * a blank line carrying spaces ("p1\n   \np2"): blank, so it delimits.
//   * leading blank lines ("\n\np1"): skipped, so the first section is p1 and never an empty string.
//   * trailing blank lines ("p1\n\n"): nothing is hidden after them, so the row carries no dots.
//   * a blank line inside a fenced code block: NOT a delimiter. The section runs through the fence, so a cut can never
//     show an opening fence with no close. A fence that never closes leaves the section running to the end of the
//     thought, which is the only cut the parser can make without breaking it.
const THINK_DOTS = "....";
const THINK_FENCE_OPEN_RE = /^\s{0,3}(`{3,}|~{3,})/;
const THINK_FENCE_CLOSE_RE = /^\s{0,3}(`{3,}|~{3,})\s*$/;

// One line of `s` at `at`, and where the next one starts. A line ends at a newline, and a CR just before it belongs
// to the terminator rather than to the content, so a CRLF blank line reads blank.
function thinkLineAt(s, at) {
  const nl = s.indexOf("\n", at);
  const end = nl < 0 ? s.length : nl;
  const text = s.slice(at, end);
  return { start: at, end, text: text.endsWith("\r") ? text.slice(0, -1) : text };
}

// The thought's first section: `head` is everything from its first non-blank line to the first blank line outside a
// fence (trailing whitespace dropped, so the dots sit on the last line of the paragraph), and `hidden` says whether
// any non-blank text follows it.
function thinkSection(text) {
  const s = String(text ?? "");
  let at = 0;
  let start = -1;
  let cut = -1;
  let fence = "";
  while (at <= s.length) {
    const line = thinkLineAt(s, at);
    const blank = !line.text.trim();
    if (start < 0) {
      if (blank) {
        if (line.end >= s.length) break;
        at = line.end + 1;
        continue;
      }
      start = line.start;
    }
    if (fence) {
      const close = THINK_FENCE_CLOSE_RE.exec(line.text);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = "";
    } else if (blank) {
      cut = line.start;
      break;
    } else {
      const open = THINK_FENCE_OPEN_RE.exec(line.text);
      if (open) fence = open[1];
    }
    if (line.end >= s.length) break;
    at = line.end + 1;
  }
  if (start < 0) return { head: "", hidden: false };
  const head = s.slice(start, cut < 0 ? s.length : cut).replace(/\s+$/, "");
  const hidden = cut >= 0 && /\S/.test(s.slice(cut));
  return { head, hidden };
}

// What the `.think-text` box draws: the visible words, then the dots inside the same run when anything is hidden.
function thinkBoxHtml(head, dots) {
  return linkifyText(head) + (dots ? `<span class="think-more">${THINK_DOTS}</span>` : "");
}

// The lid's height in px, read from the box's own `max-height` (a card's Ctrl+wheel zoom moves it with the console).
function thinkLidPx(box) {
  const h = parseFloat(getComputedStyle(box).maxHeight);
  return Number.isFinite(h) && h > 0 ? h : 0;
}

// The largest word-boundary prefix of `head` that fits the four-line lid WITH the dots, or null when the whole thing
// fits and nothing is hidden by the lid.
//
// THE MEASUREMENT IS OFF THE ROW THE READER IS LOOKING AT. This used to write each candidate into the row's own box and
// read its scrollHeight back. It cannot paint between those writes (one task, one frame), but the write was still the
// whole thought in the folded box: every frame the page was handed a NEW version of the card - a state frame, a
// rebuild, the sweep - drew the row from its source and this function's candidates then held the full section until
// the next delta put the cut back. That is the flash the reader reported: a folded row that shows the whole thought
// and re-folds in under 100 ms, on every reasoning event.
//
// So the measurement happens on a hidden sibling of the box (`thinkProbe`): the same width, the same font and leading,
// no lid on it, out of flow and invisible. The row's own box is only ever written with the answer.
function thinkLidCut(row, box, head, limit) {
  const probe = thinkProbe(box);
  const width = probe._w;
  const fits = (s) => {
    probe.textContent = s + THINK_DOTS;
    return probe.getBoundingClientRect().height <= limit + 1;
  };
  // The cut is remembered against the exact prefix it cut AND the width it was cut at: a thought only grows, so the
  // four-line cut of its first paragraph does not move as more words arrive, but a card that changed width has to be
  // measured again.
  const cached = row._thinkCut;
  if (cached && cached.limit === limit && cached.w === width && head.length >= cached.cut && head.slice(0, cached.cut) === cached.head) return cached.cut;
  if (fits(head)) {
    row._thinkCut = null;
    return null;
  }
  let lo = 0;
  let hi = head.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(head.slice(0, mid))) lo = mid;
    else hi = mid - 1;
  }
  let shown = head.slice(0, lo);
  let cut = shown.length;
  while (cut > 0 && !/\s/.test(head[cut - 1])) cut -= 1;
  shown = head.slice(0, cut).replace(/\s+$/, "");
  if (!shown) {
    // A first section with no break inside the lid - one very long token. Four lines of it cannot end in dots without
    // cutting it, so the first word is shown whole even though it overflows; the never-cut-a-word rule wins.
    const stop = head.search(/\s/);
    shown = stop < 0 ? head : head.slice(0, stop);
  }
  row._thinkCut = { limit, w: width, cut: shown.length, head: shown };
  return row._thinkCut.cut;
}

// The measuring surface a folded row's cut is found on: ONE hidden box on <body>, styled with the same computed text
// properties as the row's box, so a candidate is measured at this console's own width and font without writing it into
// the row. It is not a child of the row: a hidden sibling inside the console would still join the console's
// `textContent`, so a copy of the block or a search over it would find a thought twice.
//
// The properties are copied rather than inherited from a class, because the box's font is the card's (`--term-size`
// moves with Console size and a Ctrl+wheel zoom) and its wrapping is the console's. The copy is skipped while the
// signature holds, so a delta costs one compare and no style write.
const THINK_MEASURE_PROPS = Object.freeze([
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "white-space",
  "word-break",
  "overflow-wrap",
  "text-indent",
  "tab-size",
  "direction",
]);
let thinkMeasureBox = null;
function thinkProbe(box) {
  if (!thinkMeasureBox || !thinkMeasureBox.isConnected) {
    const host = document.createElement("div");
    host.className = "think-measure";
    host.setAttribute("aria-hidden", "true");
    const span = document.createElement("span");
    span.className = "think-measure-text";
    host.appendChild(span);
    document.body.appendChild(host);
    thinkMeasureBox = span;
    thinkMeasureBox._sig = "";
  }
  const cs = getComputedStyle(box);
  const width = box.clientWidth;
  const sig = `${width}|${cs.fontSize}|${cs.lineHeight}|${cs.fontFamily}|${cs.fontWeight}|${cs.fontStyle}|${cs.letterSpacing}|${cs.wordSpacing}|${cs.whiteSpace}|${cs.wordBreak}|${cs.overflowWrap}|${cs.textIndent}|${cs.tabSize}|${cs.direction}`;
  if (thinkMeasureBox._sig !== sig) {
    for (const prop of THINK_MEASURE_PROPS) thinkMeasureBox.style.setProperty(prop, cs.getPropertyValue(prop));
    thinkMeasureBox.style.width = `${width}px`;
    thinkMeasureBox._sig = sig;
    thinkMeasureBox._w = width;
  }
  return thinkMeasureBox;
}

// Draw one row from the thought it holds: the whole thought when it is open, the first section plus dots when it is
// minimized. `_drawn` stays the SOURCE text (that is what drawRowText's high-water mark compares), never the summary.
// The row's box is written ONCE, with what may be shown: a folded row is never handed its source text, so a card that
// repaints mid-stream cannot paint the whole thought into the four lines the reader is looking at.
function fitThinkRow(row) {
  if (!row || !row.dataset || !row.dataset.thinkRow) return false;
  const box = row.querySelector(":scope > .think-text");
  if (!box) return false;
  watchThinkOpen(row);
  const full = String(row.dataset.ltext ?? "");
  const open = row.classList.contains("is-open");
  let shown = full;
  let dots = false;
  if (!open) {
    const sec = thinkSection(full);
    shown = sec.head;
    dots = sec.hidden;
    const limit = thinkLidPx(box);
    // A row in a collapsed card has no width to measure yet; the sweep finishes it once it is on screen.
    if (limit > 0 && box.getClientRects().length) {
      const cut = thinkLidCut(row, box, shown, limit);
      if (cut != null) {
        shown = shown.slice(0, cut);
        dots = true;
      }
    }
  }
  const html = thinkBoxHtml(shown, dots);
  if (box.innerHTML !== html) box.innerHTML = html;
  row._drawn = full;
  return true;
}

// Draw every folded row of a card (or console) that has just been built from markup. The cut is a MEASUREMENT, so
// markup cannot carry it: a card drawn again holds its rows at their source until something fits them, which is what
// left a folded row over its lid for the frames after a repaint. Every path that rebuilds a card calls this in the
// same task as the write, so the repaint and its fit are one frame.
function fitThinkRows(root) {
  // A card (element), the document (the 1200 ms sweep) and a fragment (a card built off-page) are all roots a
  // repaint hands this function; only an element can be a row itself.
  if (!root || (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11)) return 0;
  const rows = root.nodeType === 1 && root.matches?.(".jl-think[data-think-row]") ? [root] : [...(root.querySelectorAll?.(".jl-think[data-think-row]") || [])];
  let n = 0;
  for (const row of rows) if (fitThinkRow(row)) n += 1;
  return n;
}

// The sweep that finishes rows the draw could not measure: a card that was collapsed when the thought arrived, a
// console that changed width, a zoom. It rewrites only a box whose words differ, so a settled row costs one compare.
function sweepThinkLids() {
  if (typeof document === "undefined" || document.hidden) return;
  fitThinkRows(document);
}

// The markup of one thinking row. `sep` is the stream's blank line above a piece (wtStream.pieces).
//
// A FOLDED row's markup is provisional: it carries the first section, and the four-line cut is a measurement, so the
// row is finished by fitThinkRow() - the append path does it as the row lands, and every path that rebuilds a card
// does it in the same task through fitThinkRows(). Until then the box holds the source section and the CSS lid is the
// only bound on it, which is exactly why the rebuild paths must not be allowed to paint in between.
function thinkRowHtml(l, sep = "") {
  const lid = String(l.lid ?? thinkLid(l.at));
  const text = String(l.text ?? "");
  const live = Boolean(l.live);
  const open = thinkOpenRows.has(lid);
  const from = Number(l.at) || Date.now();
  const sec = open ? null : thinkSection(text);
  const body = open ? linkifyText(text) : thinkBoxHtml(sec.head, sec.hidden);
  return `<div class="jl jl-think think-row${sep ? ` ${esc(sep)}` : ""}${open ? " is-open" : ""}" data-lid="${esc(lid)}" data-ltext="${esc(text)}" data-lkind="think" data-think-row="1" role="button" tabindex="0" aria-expanded="${open ? "true" : "false"}" title="${live ? "what the agent is thinking now" : "click to read the whole thought"}"><span class="think-text">${body}</span>${live ? `<span class="think-live" data-think-live="1"><span class="think-dot" aria-hidden="true"></span>thinking <span class="jl-live" data-live-from="${from}">${liveSuffix(from)}</span></span>` : ""}</div>`;
}

// Patch a row whose thought grew, or whose thought stopped. The text and the mark are the only things
// that move; the node, its open state and the reader's selection inside it stay where they are.
function patchThinkRow(el, l) {
  const lid = String(l.lid ?? thinkLid(l.at));
  const text = String(l.text ?? "");
  let box = el.querySelector(":scope > .think-text");
  if (!box) {
    // The box is where the four-line clip lives and what the live mark sits beside. A row WITHOUT it (one an older
    // paint flattened) would be drawn with no clip at all, so it is put back rather than written over.
    box = document.createElement("span");
    box.className = "think-text";
    el.insertBefore(box, el.firstChild);
  }
  el.dataset.ltext = text;
  // The row's high-water mark is the SOURCE, not the summary: `_drawn` is what drawRowText compares and appends from,
  // and a patch and a paint are two writers of one row that must agree about what has already been drawn.
  el._drawn = text;
  // A streamed delta NEVER decides whether the row is open. The reader's press owns `is-open` (app.js) and
  // thinkOpenRows is its record, so a row the reader opened stays open with no class write per token, and a row they
  // left folded cannot be opened by words arriving. The compare is a repair for a row a paint left out of step, and
  // it writes nothing in the steady state.
  const open = thinkOpenRows.has(lid);
  if (el.classList.contains("is-open") !== open) {
    el.classList.toggle("is-open", open);
    el.setAttribute("aria-expanded", open ? "true" : "false");
  }
  const mark = el.querySelector(":scope > [data-think-live]");
  if (l.live && !mark) {
    const from = Number(l.at) || Date.now();
    el.insertAdjacentHTML(
      "beforeend",
      `<span class="think-live" data-think-live="1"><span class="think-dot" aria-hidden="true"></span>thinking <span class="jl-live" data-live-from="${from}">${liveSuffix(from)}</span></span>`,
    );
  } else if (!l.live && mark) mark.remove();
  el.title = l.live ? "what the agent is thinking now" : "click to read the whole thought";
  fitThinkRow(el);
}

// The press that opens or closes a row lives in app.js (it also holds the console's place), and its handler can finish
// after any listener this file adds - so the row's OWN class is the signal, not the event. A MutationObserver on the
// row's class draws the new state the moment app.js has set it. One observer per row, attached by the first fit that
// sees the row; a row in a collapsed card is attached by sweepThinkLids.
const thinkOpenObserver =
  typeof MutationObserver === "function"
    ? new MutationObserver((entries) => {
        for (const e of entries) fitThinkRow(e.target);
      })
    : null;

function watchThinkOpen(row) {
  if (thinkOpenObserver && !row._thinkWatched) {
    thinkOpenObserver.observe(row, { attributes: true, attributeFilter: ["class"] });
    row._thinkWatched = true;
  }
}

if (typeof document !== "undefined" && document && typeof setInterval === "function") setInterval(sweepThinkLids, 1200);
// ---- end a thought's first section ---------------------------------------------------------------------------------
// ---- end reasoning rows ------------------------------------------------------------------------------

// One console line. data-ltext/data-lkind carry the line itself rather than what it renders to, because a
// burst rebuild reads the lines back out of the DOM (groupLines): a link, a running clock or a diff window's
// markup must not change what the next render believes the line said.
function lineHtml(l, live = "", cls = "") {
  const kind = l.kind || "raw";
  // A thinking row is not prose and is never typed here: the live preview already arrives in chunks, and
  // the settled store blocks carry their own pace (paceThinkBlock feeds the same queue under this lid).
  if (kind === "think") return thinkRowHtml(l, cls);
  // A line the stream is still revealing is drawn up to what may be shown NOW, not up to the wire's whole text:
  // a repaint mid-paragraph (a scan, a pinned copy, the 3s result sweep) must not jump the console ahead of the
  // words the reader is watching arrive. Every other line — history, a tool line, reasoning — is drawn whole.
  const shown = typedShown(l);
  const text = shown == null ? l.text : shown;
  // The agent's own words are the one kind drawn as markdown (core/console-markdown.js): the markers it writes
  // are meant to be shapes. A tool line, a panel note and the run protocol keep the plain escaped line they have
  // always had — a diff's "+ added" is not a list item. Both paths escape first; neither ever injects HTML.
  const waiting = l.wait === "gateway";
  const body = waiting ? waitLineHtml(l) : consoleMdIsProse(kind) ? consoleMdInline(text) : linkifyText(text);
  return `<div class="jl jl-${esc(kind)}${waiting ? " jl-gwait" : ""}${cls ? ` ${cls}` : ""}" data-lid="${esc(l.lid ?? "")}" data-ltext="${esc(l.text ?? "")}" data-lkind="${esc(kind)}"${waiting ? ` data-gwait="${Number(l.at) || Date.now()}"` : ""}>${body}${live}</div>`;
}

// A run of tool calls with nothing said in between is one burst. The console draws it as one row per tool with a
// tally and the input of the last call - what the agent is doing, not every instance of it - while the full lines
// stay one click away. Text ends the burst: the next tool call starts a fresh tally at that point in the transcript.
function burstGroups(lines) {
  const out = [];
  let burst = null;
  for (const l of lines) {
    if (l.kind === "tool" || l.kind === "tool-out") {
      if (!burst) {
        burst = { group: true, lines: [] };
        out.push(burst);
      }
      burst.lines.push(l);
    } else {
      burst = null;
      out.push({ group: false, line: l });
    }
  }
  return out;
}

// One row per tool name: how many times, the input of the most recent call, and whether it is still running.
function toolBurstRows(lines) {
  const rows = new Map();
  for (const l of lines) {
    const text = String(l.text || "");
    if (l.kind === "tool") {
      const m = TOOL_START_RE.exec(text);
      if (!m) continue;
      const name = m[1];
      const sep = text.indexOf(" · ");
      const g = /^(\p{Extended_Pictographic}[\uFE0F\u200D]*)\s*/u.exec(text);
      const row = rows.get(name) || { name, glyph: (g && g[1]) || "⚡", count: 0, done: 0, last: "", at: null, duration: null };
      row.count += 1;
      row.last = sep >= 0 ? text.slice(sep + 3) : "";
      row.at = Number(l.at) || Date.now();
      rows.set(name, row);
    } else if (l.kind === "tool-out") {
      const m = TOOL_DONE_RE.exec(text);
      if (!m) continue;
      const row = rows.get(m[1]);
      if (!row) continue;
      row.done += 1;
      const d = /·\s*([\d.]+)s/.exec(text);
      if (d) row.duration = Number(d[1]);
    }
  }
  return [...rows.values()];
}

// A call plus the output it produced, so one tool's rows can be opened on their own. A result block starts at the
// "↳ name" line and runs until the next call or result; the plain lines belong to the result above them.
function burstSegments(lines) {
  const out = [];
  let cur = null;
  for (const l of lines) {
    const text = String(l.text || "");
    if (l.kind === "tool") {
      const m = TOOL_START_RE.exec(text);
      cur = { tool: m ? m[1] : "", lines: [l] };
      out.push(cur);
    } else if (l.kind === "tool-out") {
      const m = TOOL_DONE_RE.exec(text);
      if (m) {
        cur = { tool: m[1], lines: [l] };
        out.push(cur);
      } else if (cur) {
        cur.lines.push(l);
      } else {
        cur = { tool: "", lines: [l] };
        out.push(cur);
      }
    }
  }
  return out;
}

// Every line of a group, from the live model when we have it and from the DOM when the group came from a full render.
function groupLines(grp) {
  if (grp._burst) return grp._burst;
  // Read the console lines back out of the DOM - but not the panel's own additions to a block: stored output, the
  // notes under it and an opened batch are all drawn UNDER a line, so counting them inflates the line tally and
  // turns them into console lines of their own on the next rebuild (an opened batch was re-absorbed as five
  // summaries that then satisfied "the preview carried this result").
  const read = (d) => {
    // The line's own text, not the rendered text: a diff window draws one row per change and a code box
    // holds its lines folded, and neither may cost the rebuild a line or invent one (the carried file label
    // is not a .jl for exactly that reason).
    const line = {
      kind: d.dataset.lkind || (d.className.match(/jl-([a-z-]+)/) || [])[1] || "raw",
      text: d.dataset.ltext != null ? d.dataset.ltext : d.textContent,
      // …and the id the row was drawn with, because it is what the next update looks the row up by: the live
      // append replaces a growing line's text through `[data-lid]`, and `paintTypedLines` finishes a half-typed one
      // the same way. A rebuild that read this back without it handed every row it redrew an empty id, so the
      // identity did not survive the group being re-cut.
      lid: d.dataset.lid || undefined,
    };
    // …and which result a fold note names travels with it too: the sentence cannot say it (that is what the
    // stamp on the line is for), and a rebuild that lost it would put the reader back in front of "click to
    // read" with nothing to click. Read from the button the note was already drawn as.
    const btn = d.querySelector ? d.querySelector("[data-tool-fold]") : null;
    if (btn) line.fold = { tool: btn.dataset.foldTool || "", row: Math.max(0, Number(btn.dataset.foldRow) || 0) };
    return line;
  };
  const out = [];
  const sources = new Map();
  for (const d of grp.querySelectorAll(".tgrp-body .jl, .tgrp-body .code-box[data-code-source]")) {
    const box = d.closest(".code-box[data-code-source]");
    if (box) {
      if (!sources.has(box)) {
        let lines = null;
        try { lines = JSON.parse(box.dataset.codeSource); } catch { /* a damaged attribute falls back to the DOM */ }
        sources.set(box, Array.isArray(lines) ? lines : null);
      }
      const lines = sources.get(box);
      if (lines) {
        if (d === box) out.push(...lines);
        continue;
      }
      if (d === box) continue;
    }
    if (d.classList.contains("jl-store") || d.classList.contains("jl-note") || d.classList.contains("jl-panel")) continue;
    // A stream row is the record of BOTH the call and the result that answered it: neither is drawn as a line of
    // its own (the row says the tool, the target and the time), so both halves travel on the row — data-ltext for
    // the call, data-lresult for the result header the console used to draw under it. Read them back as the two
    // lines they are: without the header a rebuild loses the call's time, and `storeOffsetsBefore` (which counts
    // result headers) hands the NEXT burst the wrong starting row for its stored output.
    if (d.dataset && d.dataset.lresult) {
      out.push(read(d), {
        kind: "tool-out",
        text: d.dataset.lresult,
        at: Number(d.dataset.lrat) || undefined,
        lid: d.dataset.lrld || undefined,
      });
      continue;
    }
    // A modification is drawn with its AFTER line first (the reader asked for the new side on the left), which is
    // the opposite of the order the diff had it in. A rebuild re-derives the diff from these lines, and a pair
    // read back the other way round re-classifies as a lone addition plus a lone removal - every modification
    // redrawn as two rows. So a row carrying data-lpair is read back in the diff's own order.
    const row = d.parentElement;
    const cells = row && row.dataset && row.dataset.lpair === "1" ? [...row.children] : null;
    if (cells && cells.length === 2) {
      if (d === cells[0]) continue; // read with its partner, below
      out.push(read(cells[1]), read(cells[0]));
      continue;
    }
    out.push(read(d));
  }
  return out;
}

// How many result lines of each tool the bursts already in this console have drawn. That count is where the NEXT
// burst's pairing starts (see data-gofs): a turn holds several bursts of the same tool, and each one owns its own
// slice of the store's rows.
function storeOffsetsBefore(consoleEl, except) {
  const seen = {};
  for (const g of consoleEl.querySelectorAll(".tgrp")) {
    if (g === except) continue;
    for (const l of groupLines(g)) {
      if (l.kind !== "tool-out") continue;
      const m = TOOL_DONE_RE.exec(String(l.text || ""));
      if (m) seen[m[1]] = (seen[m[1]] || 0) + 1;
    }
  }
  return seen;
}

// How many result blocks the console drew for one tool: each one is a call's output, and the session store has
// one row for each of them, so this is also how many rows to ask for.
function resultBlocksFor(lines, tool) {
  return (lines || []).filter((l) => {
    if (l.kind !== "tool-out") return false;
    const m = TOOL_DONE_RE.exec(String(l.text || ""));
    return Boolean(m) && m[1] === tool;
  }).length;
}

// Rebuild the group the reader has open, wherever it is on the board: the element that asked for the results may
// have been replaced by a repaint while the request was in flight, so aim by the group's stable state key.
function repaintToolGroup(grp) {
  if (!grp || !grp.dataset) return;
  // One turn can be drawn twice (the pinned card and its paged copy), so the lookup stays inside the console that
  // owns this group. The state key is the stable identity and wins; the group key is only a fallback, because the
  // index in it shifts when a long turn is trimmed to its last 300 lines.
  const scope = grp.closest("pre.job-out") || document;
  const gkey = grp.dataset.gstate || "";
  const key = grp.dataset.tgrp || "";
  const live =
    (gkey && scope.querySelector(`.tgrp[data-gstate="${CSS.escape(gkey)}"]`)) ||
    (key && scope.querySelector(`.tgrp[data-tgrp="${CSS.escape(key)}"]`));
  if (!live) return;
  const bodyEl = live.querySelector(".tgrp-body");
  rebuildToolGroup(live, { filter: live.dataset.filter || "", open: bodyEl ? !bodyEl.hidden : true });
}

// Ask the panel server for this turn's stored results for one tool. The live stream's preview is often empty,
// so this is where "↳ patch" turns into the thing the tool actually returned.
//
// A turn that is still running keeps producing results: a fetch taken when the reader opened the block saw one
// patch while the burst ended with five, and every later call kept an empty header - so an entry cached while the
// turn is live expires (five seconds) instead of answering for the rest of the turn. An entry taken while live is
// also refetched ONCE after the turn ends: the last results of a turn land within a second of its endedAt, and
// freezing the mid-run answer is how a finished turn shows three "no output recorded" where the output exists.
async function ensureToolStore(turnId, tool, grp = null) {
  const cacheKey = `${turnId}|${tool}`;
  if (!turnId || !tool || !state.jobs.has(turnId)) return;
  if (state.toolStorePending.has(cacheKey)) return;
  const job = state.jobs.get(turnId);
  const live = turnLive(job);
  const have = state.toolStore.get(cacheKey);
  if (have && !(have.live && !live) && (!live || Date.now() - have.at < 5000)) return;
  // One row per result line the WHOLE TURN drew for this tool, because the entry is shared by every burst in the
  // turn: sizing it to the group that happened to fetch first cut the later bursts off at that group's count, and
  // the missing rows read as "no output recorded". A fold note names its result by that result's index over the
  // whole turn, so the read covers up to the furthest row this turn's own notes name as well — the head above
  // such a note is only checkable against its own row if the row is in hand.
  const turnLines = jobLines(turnId);
  const stamped = stampedRowFor(turnLines, tool);
  const n = Math.min(60, Math.max(4, resultBlocksFor(turnLines, tool) + 1, stamped == null ? 0 : stamped + 1));
  let changed = false;
  state.toolStorePending.add(cacheKey);
  try {
    const q = new URLSearchParams({
      thread: job.thread || job.id,
      tool,
      n: String(n),
      from: String(Date.parse(job.startedAt || "") || 0),
      to: String(Date.parse(job.endedAt || "") || 0),
    });
    const r = await apiFetch(`/api/tool-results?${q}`, {}, { timeoutMs: 15000 });
    // apiFetch does not throw on a 4xx/5xx: a refusal parsed as `{results: []}` would be cached as "the store has
    // nothing", and every call in the block would say so for good.
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    const results = Array.isArray(d.results) ? d.results : [];
    changed = JSON.stringify(results) !== JSON.stringify(have ? have.results : null);
    state.toolStore.set(cacheKey, { at: Date.now(), live, results });
    // One entry per (turn, tool) the reader ever opened; a long-lived tab must not keep them all.
    while (state.toolStore.size > 300) state.toolStore.delete(state.toolStore.keys().next().value);
  } catch {
    // Left uncached on purpose: a failed read is not an answer, and the next open retries it.
  } finally {
    state.toolStorePending.delete(cacheKey);
  }
  // Only a real change is worth a repaint: rebuilding the block detaches its text nodes, and a reader dragging
  // across a diff loses the selection when it happens on every sweep.
  if (changed) repaintToolGroup(grp);
}

// The panel's fold, opened: the whole stored text of one result, drawn in place of the note that offered it.
//
// This is the DOM being handed the rest of a result, never the job's own lines: the console's ring buffer
// (jobs.js MAX_LINES = 600) is what a big result would evict, and a result the reader asked to see is not
// something the card has to keep — it is one click away again after any repaint.
//
// The box it is drawn in is OPEN: the reader pressed "click to read" on the note, so a second press to unfold what
// they just asked for would read as the panel ignoring them. That is the one box that is open by default, which is
// why it keeps the boxes the reader SHUT (state.codeBoxShut) where every other box keeps the ones they opened.
const READ_CODE_OPEN = { openByDefault: true, has: (key) => !state.codeBoxShut.has(key) };
function wholeStoredHtml(got, tool = "", arg = "", boxKey = "", codeOpen = READ_CODE_OPEN) {
  const LF = String.fromCharCode(10);
  const all = String((got && got.text) || "").split(LF);
  if (!all.some((l) => l.trim())) return `<div class="jl jl-dim jl-note">  the stored result has no text</div>`;
  return (
    consoleBodyHtml(all.map((l) => ({ kind: "store", text: l })), { tool, arg, codeOpen, codeKey: boxKey, whole: true }) +
    (got.truncated ? `<div class="jl jl-dim jl-note">… this stored result was cut as well</div>` : "")
  );
}

// Which result a fold belongs to, and how many of them the opened tab may hold. The row is the pairing the burst
// already uses (the i-th result line of this tool in this turn is the store's i-th row for it), so the number the
// note was drawn with is the number the fetch asks for.
const foldKey = (turnId, tool, row) => `${turnId}|${tool}|${row}`;
const fullForFold = (fold) => state.foldRows.get(foldKey(fold.turn, fold.tool, fold.row));
const FOLD_ROWS_MAX = 12;

// Which row of the store a fold note names. The stronger of two facts wins, and the per-burst cursor is only
// the last resort.
//
// The store indexes a tool's results over the WHOLE TURN (lib/tool-results.js: one row at `OFFSET row`, ordered
// by the turn's clock window), while the console's own lines are a trimmed window of that turn — 600 lines in
// memory, the last 120 served — so a position inside the console is NOT that number. Measured: the clickable
// note in burst `9658fe9e#2` named `row=0` while the store's row 0 for `terminal` is the turn's opening recon
// command (799 chars, 14 lines), a different result entirely, so the click read back the wrong text.
//
//   * the head the panel kept. The console lines drawn above a note ARE the first lines of the stored row: one
//     fold, one `unwrapToolText` (lib/jobs/console-lines.js pushes the head, lib/tool-results.js reads the store
//     back through the same unwrapping), 40 lines on both sides. So once the burst has read its tool's rows, the
//     note names the row those lines came from — and that row can be checked against its own text.
//   * the row the server stamped on the note (`line.fold`): this result's index among the turn's results for
//     that tool, counted at the event (lib/jobs.js `withResultRow`). The only handle a burst the window trimmed
//     of its call line has, and right whenever the panel saw every result of the turn.
const HEAD_LINES = 40; // MAX_TOOL_LINES in lib/jobs/console-lines.js: the head the panel keeps of a result
const LF = String.fromCharCode(10);
// A line as it compares: no trailing newline, no trailing blanks. The panel trims trailing whitespace on the
// console side of nothing, but a diff's context lines and a store row's may differ by exactly that.
const foldLineText = (l) => String((l && l.text) != null ? l.text : l || "").replace(/\s+$/, "");
const storeRowsFor = (turnId, tool) => state.toolStore.get(`${turnId}|${tool}`)?.results || null;

// The store row a head of console lines came from: the row whose text carries those lines, in order, inside the
// head the panel kept (the row's first 40 lines). `prefer` is the row the note's own stamp named — checked
// first, so a note whose stamp is right keeps naming exactly that row (two results whose heads read the same,
// the same command run twice, are told apart by it), and one whose stamp drifted is repaired to the row the
// lines really came from.
function rowForHead(rows, head, prefer = null) {
  const H = (Array.isArray(head) ? head : []).map(foldLineText).filter((t) => t.trim());
  if (!H.length || !Array.isArray(rows) || !rows.length) return null;
  const hits = [];
  for (let i = 0; i < rows.length; i++) {
    const R = foldLineText(rows[i]).split(LF);
    for (let j = 0; j + H.length <= R.length && j <= HEAD_LINES; j++) {
      if (H.every((h, k) => R[j + k].startsWith(h))) {
        hits.push({ i, j });
        break;
      }
    }
  }
  if (!hits.length) return null;
  const wanted = hits.find((h) => h.i === prefer);
  if (wanted) return wanted.i;
  // A head that starts the row is the stronger reading than one that ends in the middle of it (which is what a
  // trimmed window leaves behind), so a j = 0 match wins over a later row's suffix match.
  const best = hits.reduce((a, b) => (b.j < a.j ? b : a));
  return best.i;
}

// The fold context a note is drawn with: the turn, the tool it belongs to, and the row of the store it names.
// `tool` is what the caller knows from the burst (a result header named it); the note's own stamp wins when the
// window trimmed that away. `cursor` is the burst's pairing, for a line written before the stamp existed.
function foldForNote({ turnId, tool = "", note = null, head = [], cursor = null }) {
  const stamped = note && note.fold ? note.fold : null;
  const which = String((stamped && stamped.tool) || tool || "");
  // No tool anywhere: a note written before the stamp existed, in a burst the window trimmed of its call line.
  // The head over it still does not answer for one tool only, so ask whichever of THIS turn's tool reads is in
  // hand which row those lines came from — the answer names the tool as well as the row.
  if (!which) return foldByHeadAnyTool(turnId, head);
  const prefer = stamped && stamped.row != null ? Math.max(0, Number(stamped.row) || 0) : null;
  const byHead = rowForHead(storeRowsFor(turnId, which), head, prefer);
  const row = byHead != null ? byHead : prefer != null ? prefer : cursor;
  if (row == null) return null;
  return { turn: turnId, tool: which, row: Math.max(0, Number(row) || 0) };
}

// Which of this turn's tools a head of console lines came from, across the store reads the card has in hand
// (the same reads every burst of the turn shares). Only ever consulted for a note that can name no tool of its
// own; the first read whose rows carry the head is the answer.
function foldByHeadAnyTool(turnId, head) {
  const prefix = `${turnId}|`;
  for (const [key, entry] of state.toolStore) {
    if (!key.startsWith(prefix) || !entry || !Array.isArray(entry.results) || !entry.results.length) continue;
    const row = rowForHead(entry.results, head, null);
    if (row != null) return { turn: turnId, tool: key.slice(prefix.length), row: Math.max(0, Number(row) || 0) };
  }
  return null;
}

// Every note's fold context in a list of console lines, keyed by the note line itself. Where the lines are drawn
// in one go (a burst the window trimmed of its call line, so no segment names its own tool), each note is still
// resolved from its stamp and the head above it — bounded to the head's own length, because a note ends the head
// the panel kept.
function noteFolds(turnId, lines) {
  const folds = new Map();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l || l.kind !== "tool-out" || !consoleFoldNote(String(l.text || ""))) continue;
    const fold = foldForNote({ turnId, note: l, head: lines.slice(Math.max(0, i - HEAD_LINES), i) });
    if (fold) folds.set(l, fold);
  }
  return folds;
}

// The tools a burst's store read has to cover: the ones its call lines name, plus any a fold note inside it
// names. A burst the window trimmed of its call line has no rows to count, and the note is the only thing left
// that says which result it folds.
function burstStoreTools(lines) {
  const out = new Set(toolBurstRows(lines).map((r) => r.name));
  for (const l of lines) if (l && l.fold && l.fold.tool) out.add(String(l.fold.tool));
  return [...out].filter(Boolean);
}

// The furthest row this turn's own notes name for one tool: the store read that pairs a burst asks for the rows
// its result lines need, and one more result than that when a note names a later one (the head above the note
// has to be checkable against the row it claims).
function stampedRowFor(lines, tool) {
  let out = null;
  for (const l of lines || []) {
    if (!l || !l.fold || String(l.fold.tool || "") !== tool || l.fold.row == null) continue;
    const row = Math.max(0, Number(l.fold.row) || 0);
    if (out == null || row > out) out = row;
  }
  return out;
}

// The reader clicked the fold: read that one row out of the session store — whole, not the store reader's own
// 6,000-character display cut — and let the card redraw the burst with it. The request carries the turn's own
// window, exactly like the store fetch a burst makes, because the store is queried by time
// (lib/tool-results.js) and the turn's clock is the only thing that says which rows are its.
async function expandToolFold(btn) {
  const grp = btn.closest(".tgrp");
  // The button carries the turn it was drawn for (data-fold-turn). The burst's own key is the same number, but a
  // burst the window trimmed of its call line is drawn as bare console lines — no `.tgrp` to read it from — and
  // the note there is still a control the reader can press.
  const turnId = String(btn.dataset.foldTurn || (grp && grp.dataset.tgrp) || "").split("#")[0];
  const tool = btn.dataset.foldTool || "";
  const row = Math.max(0, Number(btn.dataset.foldRow) || 0);
  if (!turnId || !tool) return false;
  const job = state.jobs.get(turnId);
  if (!job) return true;
  const key = foldKey(turnId, tool, row);
  // The press is the reader asking for this result, so the console holds still while it arrives (Settings > Agent
  // cards, off by default): the answer lands under the note that was pressed, not at the bottom of the console.
  holdConsoleFor(btn);
  const rememberOpen = () => {
    state.codeBoxOpen.add(btn.dataset.codeKey || `result|${turnId}|${tool}|${row}`);
    while (state.codeBoxOpen.size > 500) state.codeBoxOpen.delete(state.codeBoxOpen.values().next().value);
  };
  if (state.foldRows.has(key)) {
    rememberOpen();
    if (grp) repaintToolGroup(grp);
    return true;
  }
  const q = new URLSearchParams({
    thread: job.thread || job.id,
    tool,
    row: String(row),
    full: "1",
    n: "1",
    from: String(Date.parse(job.startedAt || "") || 0),
    to: String(Date.parse(job.endedAt || "") || 0),
  });
  const hint = btn.querySelector(".code-hint");
  const say = (text) => { if (hint) hint.textContent = text; else btn.textContent = text; };
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  say("reading the stored result…");
  let pending = null;
  try {
    pending = state.foldPending.get(key);
    if (!pending) {
      pending = (async () => {
        const r = await apiFetch(`/api/tool-results?${q}`, {}, { timeoutMs: 15000 });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        return Array.isArray(d.results) ? d.results[0] : null;
      })();
      state.foldPending.set(key, pending);
    }
    const got = await pending;
    if (!got || !String(got.text || "").trim()) {
      // A missing or empty copy is not a full result. Keep the preview, and leave the header retryable.
      say(got ? "the stored result has no text — click to retry" : "the session store has no copy of this result — click to retry");
      return true;
    }
    state.foldRows.set(key, got);
    rememberOpen();
    // Retire closed cached results first. Evicting one the reader still has open would shrink it on a repaint.
    for (const held of state.foldRows.keys()) {
      if (state.foldRows.size <= FOLD_ROWS_MAX) break;
      if (!state.codeBoxOpen.has(`result|${held}`)) state.foldRows.delete(held);
    }
    if (grp) repaintToolGroup(grp);
    else {
      // No burst wrapper to repaint: a burst the window trimmed of its call lines is drawn as bare console lines.
      // The whole stored row goes in the note's own place — the same markup the next full repaint draws there
      // (trimmedBurstHtml), so the answer is on the card now rather than at the next paint.
      const rowEl = btn.closest(".jl-fold");
      const holder = document.createElement("div");
      holder.innerHTML = wholeStoredHtml(got, tool, "", `${turnId}|${tool}`);
      if (rowEl && rowEl.parentElement && holder.firstChild) rowEl.replaceWith(...holder.childNodes);
    }
  } catch {
    say("the session store could not be read; click to retry");
  } finally {
    if (state.foldPending.get(key) === pending) state.foldPending.delete(key);
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
  }
  return true;
}

// The calls behind a "+ N commands" batch: the run stream only carries the gateway's summary of a parallel batch, so
// this asks the panel server to read the session transcript and then re-renders the burst open with them in it.
async function loadBatchCalls(btn) {
  const grp = btn.closest(".tgrp");
  if (!grp) return;
  // The batch is about to be drawn open under this button, so the console holds its place rather than sliding down
  // to the end of the list that arrives (Settings > Agent cards, off by default).
  holdConsoleFor(btn);
  const gkey = btn.dataset.batchKey || grp.dataset.gstate || "";
  const tool = btn.dataset.batchTool || "";
  const want = Number(btn.dataset.batchN) || 4;
  const key = grp.dataset.tgrp || "";
  const turnId = String(key).split("#")[0];
  // The card's thread, so the server can find the session whose transcript holds the batch - and the turn's own
  // start, so it reads THAT turn's batch rather than the newest one in the session.
  const job = state.jobs.get(turnId);
  const thread = job?.thread || turnId;
  const since = job?.startedAt ? Date.parse(job.startedAt) || 0 : 0;
  btn.disabled = true;
  btn.textContent = "reading the transcript…";
  let calls = [];
  try {
    // The summary prints the calls it did NOT show, so the batch ran want+1 of them: that count is what picks the
    // right message out of the transcript.
    const first = btn.dataset.batchFirst || "";
    const q = new URLSearchParams({ thread, tool, n: String(Math.max(2, want + 1)), want: String(want + 1), since: String(since), first });
    const r = await apiFetch(`/api/tool-calls?${q}`, {}, { timeoutMs: 15000 });
    const d = await r.json().catch(() => ({}));
    calls = Array.isArray(d.calls) ? d.calls : [];
    if (!r.ok && d.error) throw new Error(d.error);
  } catch (e) {
    showBanner(`could not read the batch: ${e.message}`);
  }
  if (calls.length) {
    state.batchCalls.set(`${gkey}|${tool}`, calls);
    // One entry per burst the reader opened; a long-lived tab should not keep every one of them forever.
    while (state.batchCalls.size > 300) state.batchCalls.delete(state.batchCalls.keys().next().value);
  } else {
    showBanner(`the session transcript has no record of this ${tool} batch yet`);
  }
  const live = document.querySelector(`.tgrp[data-gstate="${CSS.escape(gkey)}"]`) || grp;
  if (live?.isConnected) rebuildToolGroup(live, { filter: live.dataset.filter || "", open: true });
}

function rebuildToolGroup(grp, { filter = "", open = false } = {}) {
  const key = grp.dataset.tgrp || "";
  const lines = groupLines(grp);
  // The anchor is the burst's own identity and travels on the node: lines read back out of the DOM carry no
  // timestamp, so without it a rebuild re-keyed the group from the first line's text and the reader's open
  // state was remembered under one key while the next repaint looked it up under another.
  const anchor = grp.dataset.gat || "";
  let gofs = null;
  try {
    gofs = grp.dataset.gofs ? JSON.parse(grp.dataset.gofs) : null;
  } catch {
    gofs = null;
  }
  const gkey = grp.dataset.gstate || toolGroupStateKey(key, lines, anchor);
  // The click is the new truth, so record it before rendering: toolGroupHtml prefers the remembered state, and
  // otherwise it would faithfully put back the state the reader just changed.
  if (toolGroupDropsState(open, filter, grp.dataset.gdefault === "open")) state.toolGroupOpen.delete(gkey);
  else state.toolGroupOpen.set(gkey, { open, filter });
  const holder = document.createElement("div");
  // A piece of a stream stays a piece of a stream: rebuilding it condensed (a store read landing, a batch opened,
  // the rollup refreshed) would put the folded group back under a card whose whole point is that nothing is folded.
  // The blank line it was drawn with is part of the piece too, so the rebuild keeps it rather than losing it until
  // the next full repaint.
  holder.innerHTML = toolGroupHtml(lines, key, filter, open, anchor, gofs, grp.dataset.gflat === "1" ? { flat: true, sep: grp.classList.contains("jl-sep") } : {});
  const fresh = holder.firstElementChild;
  if (!fresh) return;
  fresh._burst = lines;
  grp.replaceWith(fresh);
  rememberToolGroup(fresh);
}

// ---- the docked console ---------------------------------------------------------------------------------
// A child's console, drawn in the card's transcript idiom. The panel cannot stream a child (its tools run on its
// own session), so this is a read of its messages - a poll while it is open and the child is still out.
//
// THE MESSAGE ARRIVES AS ONE LINE. lib/subagents.js hands over the stored assistant message as it was written, with
// its newlines still inside that string, and markdown is a property of a RUN of lines. Made into real console lines
// here, a heading, a bullet list and a fence in a child's answer become those shapes; left as one line, they are a
// paragraph with the source punctuation printed in it, which is what the docked console used to do.

// A message's own newlines, as console lines. A tool line keeps its shape: its leading spaces are the output's
// indentation, not a block marker.
function subConsoleLines(lines) {
  const out = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    const kind = (line && line.kind) || "raw";
    const text = line && line.text != null ? String(line.text) : "";
    if (!consoleMdIsProse(kind) || !text.includes("\n")) {
      out.push(line);
      continue;
    }
    // lib/subagents.js has already stripped carriage returns from the stored message, so the newline alone is the
    // line break here.
    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i += 1) {
      out.push({ ...(line || {}), text: parts[i], lid: line && line.lid != null ? `${line.lid}.${i}` : (line && line.lid) });
    }
  }
  return out;
}

// The console's parts in draw order: a run of prose is ONE block (a list, a heading, a fence, or a paragraph of
// several lines), a run of tool lines is one burst, and a panel note is its own plain row. The burst tally is the
// card console's own (burstGroups), so the two consoles condense a run of tools the same way.
function subConsoleParts(lines) {
  const parts = [];
  let prose = null;
  const flush = () => {
    if (prose) parts.push({ prose });
    prose = null;
  };
  for (const item of burstGroups(lines)) {
    if (item.group) {
      flush();
      parts.push({ tools: item.lines });
      continue;
    }
    if (consoleMdIsProse(item.line.kind)) {
      if (!prose) prose = [];
      prose.push(item.line);
      continue;
    }
    flush();
    parts.push({ line: item.line });
  }
  flush();
  return parts;
}

function subConsoleBodyHtml(lines, id) {
  return subConsoleParts(subConsoleLines(lines))
    .map((part, gi) => {
      if (part.prose) return consoleMdHtml(part.prose);
      if (part.tools) return toolGroupHtml(part.tools, `${id}#${gi}`, "", false, "", null, toolGroupsOn() ? {} : { flat: true });
      return lineHtml(part.line);
    })
    .join("");
}

// ---- the console's colour and margin ------------------------------------------------------------------
// Two view preferences, saved in this browser the way the card's tool groups are (wtgui.*). The colour is the NAME
// of a design token, never a hex: the palette lives in style.css, and Settings > Panel contrast rewrites those
// tokens, so a hex here would be the one surface that ignored the reader's contrast setting.
const SUB_CONSOLE_FG_KEY = "wtgui.subConsoleFg";
const SUB_CONSOLE_MARGIN_KEY = "wtgui.subConsoleMargin";
const SUB_CONSOLE_FG = ["text", "dim", "green", "amber", "blue", "violet"];
// The margin steps are the box's own left indent: 36 px is where the console has always sat under the sub-row, 18
// tucks it in, 0 lines it up with the row's own text, and 54 gives a long message room to breathe.
const SUB_CONSOLE_MARGIN = [36, 18, 0, 54];

function subConsoleFg() {
  try {
    const v = localStorage.getItem(SUB_CONSOLE_FG_KEY);
    return SUB_CONSOLE_FG.includes(v) ? v : "text";
  } catch {
    return "text"; // private mode: the console keeps the colour it always had
  }
}
function subConsoleMargin() {
  try {
    const n = Number(localStorage.getItem(SUB_CONSOLE_MARGIN_KEY));
    return SUB_CONSOLE_MARGIN.includes(n) ? n : 36;
  } catch {
    return 36;
  }
}
function setSubConsoleFg(name) {
  try {
    localStorage.setItem(SUB_CONSOLE_FG_KEY, name);
  } catch {
    /* the choice just will not persist */
  }
}
function setSubConsoleMargin(px) {
  try {
    localStorage.setItem(SUB_CONSOLE_MARGIN_KEY, String(px));
  } catch {
    /* same */
  }
}

function subConsoleToolsHtml() {
  const fg = subConsoleFg();
  const margin = subConsoleMargin();
  return (
    `<div class="sub-console-tools" role="group" aria-label="console appearance">` +
    `<button type="button" class="sub-tool" data-sub-console-color="1" aria-label="console text colour: ${esc(fg)}" title="change the console's text colour (${esc(fg)})">` +
    `<span class="sub-swatch" aria-hidden="true"></span>colour</button>` +
    `<button type="button" class="sub-tool" data-sub-console-margin="1" aria-label="console left margin: ${margin} pixels" title="change the console's left margin (${margin}px)">margin ${margin}</button>` +
    `</div>`
  );
}

// One frame for every state of the box. The two controls ride above the scroller, so they stay put while the reader
// reads; the colour is one custom property drawn from the palette (`--sub-console-fg: var(--violet)`), never a hex;
// and the wrapper carries the margin, so the control moves the whole box off the sub-row's indent.
function subConsoleFrame(id, body) {
  const fg = subConsoleFg();
  const margin = subConsoleMargin();
  return (
    `<div class="sub-console-wrap" style="margin-left:${margin}px; --sub-console-fg: var(--${esc(fg)})">` +
    subConsoleToolsHtml() +
    `<div class="sub-console mono" data-sub-console-box="${esc(id)}">${body}</div>` +
    `</div>`
  );
}

function subConsoleHtml(id) {
  const c = state.subConsoles.get(id);
  if (!c || c.loading) return subConsoleFrame(id, `<div class="jl jl-dim">reading this subagent…</div>`);
  if (!c.lines.length) return subConsoleFrame(id, `<div class="jl jl-dim">nothing on its console yet</div>`);
  return subConsoleFrame(id, subConsoleBodyHtml(c.lines, id));
}

// A press cycles the closed list, writes it to this browser and repaints the ONE box it was pressed in. The strip's
// own signature does not carry these two, so paintSubagents would leave the box alone and the control would look
// dead until the next roster poll.
function cycleSubConsoleFg() {
  const i = SUB_CONSOLE_FG.indexOf(subConsoleFg());
  setSubConsoleFg(SUB_CONSOLE_FG[(i + 1) % SUB_CONSOLE_FG.length]);
}
function cycleSubConsoleMargin() {
  const i = SUB_CONSOLE_MARGIN.indexOf(subConsoleMargin());
  setSubConsoleMargin(SUB_CONSOLE_MARGIN[(i + 1) % SUB_CONSOLE_MARGIN.length]);
}
function applySubConsoleLook(wrap) {
  if (!wrap || !wrap.style) return;
  const fg = subConsoleFg();
  const margin = subConsoleMargin();
  wrap.style.marginLeft = `${margin}px`;
  if (wrap.style.setProperty) wrap.style.setProperty("--sub-console-fg", `var(--${fg})`);
  const color = wrap.querySelector("[data-sub-console-color]");
  if (color) {
    color.setAttribute("aria-label", `console text colour: ${fg}`);
    color.title = `change the console's text colour (${fg})`;
  }
  const marginBtn = wrap.querySelector("[data-sub-console-margin]");
  if (marginBtn) {
    marginBtn.setAttribute("aria-label", `console left margin: ${margin} pixels`);
    marginBtn.title = `change the console's left margin (${margin}px)`;
    marginBtn.textContent = `margin ${margin}`;
  }
}
// ---- end the docked console

// The two controls, registered here because this is the console's own surface (app.js's delegation owns the cards).
// Capture phase, so the press never reaches the sub-row that opened the console.
if (typeof document !== "undefined" && document.addEventListener) {
  document.addEventListener(
    "click",
    (e) => {
      const color = e.target && e.target.closest && e.target.closest("[data-sub-console-color]");
      const margin = e.target && e.target.closest && e.target.closest("[data-sub-console-margin]");
      if (!color && !margin) return;
      e.preventDefault();
      e.stopPropagation();
      const wrap = (color || margin).closest(".sub-console-wrap");
      if (color) cycleSubConsoleFg();
      else cycleSubConsoleMargin();
      applySubConsoleLook(wrap);
    },
    true,
  );
}

function bumpSubRead(id) {
  state.subConsoleReads.set(id, (state.subConsoleReads.get(id) || 0) + 1);
}

async function loadSubConsole(id) {
  let entry = { lines: [], running: true, loading: false };
  try {
    const r = await apiFetch(`/api/subagents/console?session=${encodeURIComponent(id)}`);
    if (r.ok) {
      const d = await r.json();
      entry = { lines: Array.isArray(d.lines) ? d.lines : [], running: Boolean(d.running), loading: false };
    } else {
      entry.lines = [{ kind: "dim", text: "could not read this subagent's session" }];
    }
  } catch {
    entry.lines = [{ kind: "dim", text: "could not read this subagent's session" }];
  }
  state.subConsoles.set(id, entry);
  bumpSubRead(id);
  paintSubagents();
}

function toggleSubs(key) {
  if (!key) return;
  if (state.collapsedSubs.has(key)) state.collapsedSubs.delete(key);
  else state.collapsedSubs.add(key);
  paintSubagents();
}

async function toggleSubConsole(id) {
  if (!id) return;
  if (state.openSubConsole.has(id)) {
    state.openSubConsole.delete(id);
    state.subConsoles.delete(id);
  } else {
    state.openSubConsole.add(id);
    state.subConsoles.set(id, { lines: [], running: true, loading: true });
    bumpSubRead(id);
    paintSubagents();
    await loadSubConsole(id);
    return;
  }
  paintSubagents();
}

// ---- reasoning first: a tool's lines wait for everything in front of them --------------------------------------
// A reply's reasoning, its prose and the rows of a skill's result are all written at the reader's words-a-second, and
// the tool call that follows one of them (and its output) is whole lines on the wire, so left alone it lands while
// the text above it is still being written - the answer before the question, a card in the middle of a sentence. This
// holds those frames (core/type-stream.js createReasoningHold: in order, a whole job's queue at once) until two things
// are true: the store has been read again since the call arrived - the reasoning is written to the store a moment
// AFTER its tool call is on the stream, and only a read finds it - and nothing ahead of the call in the stream's own
// (at, seq) order is owed a WORD (typeStream.pendingBefore - a segment whose remaining text is whitespace is
// complete, so the unit is the word, never the character). The kind of segment makes no difference any more:
// a paragraph of prose and a row of a paced skill result hold a call exactly as a thought does.
//
// "Ahead" stops at the last tool result already in the console (reasoningFloor): a segment stamped behind a line the
// reader has already been handed cannot be in front of a call that follows it, so it is not waited for. That is also
// what keeps a late reasoning block - one whose own stamp precedes a call already on screen - from stranding a hold:
// it is either behind that floor, or it is still in the stream's queue and is typed by the same clock until it is
// complete, so the hold ends by itself and never has to wait out MAX_HOLD_MS.
//
// Only while there is something to wait for AND a reader watching it: the words/s setting is on (0 keeps the console
// exactly as the run sent it), the turn is live, the tab is visible, and the reasoning is on screen - the stream draws
// it as rows of the console, so it is on screen whenever the card's 🧠 is on.
const REASONING_READ_WAIT_MS = 2000; // a store read that has not answered by now is not worth holding a console for
const REASONING_READ_COOLDOWN_MS = 250; // one read serves a whole burst of calls

function reasoningShown(turn) {
  const thread = turn.thread || turn.id;
  return thinkingOn(thread);
}

function reasoningWants(evt) {
  const kind = evt?.line?.kind;
  if (kind !== "tool" && kind !== "tool-out") return false;
  if (!state.typeStream || !state.typeStream.rate()) return false;
  const turn = state.jobs.get(String(evt.id));
  return Boolean(turn) && turnLive(turn) && reasoningShown(turn);
}

// The moment of the last tool result already in the console: the thoughts newer than it are the ones a call is about
// to follow. 0 (a turn with no result yet) counts every thought of the turn.
function reasoningFloor(job) {
  const lines = jobLines(String(job));
  for (let k = lines.length - 1; k >= 0; k--) if (lines[k]?.kind === "tool-out") return Number(lines[k].at) || 0;
  return 0;
}

// The order decides, never the kind of segment: a call or a result waits while any segment stamped before it - a
// thought, a paragraph of the agent's own prose, one row of a paced skill result - is still owed a word. The
// stream answers that from its own queue (typeStream.pendingBefore), so this page keeps no second ordering. A frame
// the stream has no stamp for has no place in that order, and is drawn when it arrives.
function reasoningBusy(job, evt) {
  const rec = state.reasoningReads.get(job);
  if (rec && !rec.done && Date.now() - rec.at < REASONING_READ_WAIT_MS) return true;
  return Boolean(state.typeStream?.pendingBefore(job, Number(evt?.line?.at), reasoningFloor(job)));
}

// A call, or the header of a result, is the cue to look at the store again. A read already in flight may have been
// answered before the store held this reply, so a cue waits for it and asks once more (loadThinkingAfter).
function reasoningStart(job, evt) {
  const line = evt?.line || {};
  const cue = line.kind === "tool" || (line.kind === "tool-out" && TOOL_DONE_RE.test(String(line.text || "")));
  if (!cue) return;
  const prev = state.reasoningReads.get(job);
  if (prev && Date.now() - prev.at < REASONING_READ_COOLDOWN_MS) return;
  const turn = state.jobs.get(job);
  if (!turn) return;
  const rec = { at: Date.now(), done: false };
  state.reasoningReads.set(job, rec);
  loadThinkingAfter(turn)
    .catch(() => {})
    .finally(() => {
      rec.done = true;
    });
}

// Reasoning types out on the same stream, at the same words/s the prose uses — it is the same reading. A block is
// fed the first time the panel sees it while its turn is live AND it is the newest thought that turn has, and every
// re-read of the store feeds it again so a block that grew keeps flowing. Returns the prefix to draw, or null when
// this block is drawn whole (history, a hidden tab, rate 0, or the turn has settled and the flush already released it).
//
// WHY ONLY THE NEWEST. Every path that draws a card hands this function the turn's WHOLE block list in one pass, and
// the toggle is one of them: pressing 🧠 on a running turn paints the blocks for the first time, so with no gate the
// stream's first frame for each was the block's entire text, queued to be typed - the turn's reasoning replayed from
// its first word over output the reader was already looking at (a live window holds tens of blocks and >100 kB of
// reasoning on this box). The newest thought is the live edge, the one still being written, so it keeps its clock;
// everything above it is history and paints whole.
//
// THE TWO BRANCHES MUST NOT DISAGREE. A block that has been fed always draws the PACER'S prefix — never its whole
// text — because the two are not the same string: a live turn's reasoning runs to 100 kB and more per turn (measured:
// 58 blocks / 183 kB on this box), so the prefix the clock has reached is a small fraction of the wire's text. Drawing
// the whole text in one branch and the prefix in the other makes the block COLLAPSE back to a few words and type them
// out again the moment the branches swap — a settled turn that is revived, a tab that comes back into view. And the
// moment there is no flow to show (a settled turn, a hidden tab) the rest is released at once, so the block ends on
// the wire's whole text instead of on a prefix nobody is left to write.
function thinkIsNewest(turn, block) {
  const blocks = state.thinkCache.get(turn.id)?.blocks || [];
  if (!blocks.length) return true; // nothing to compare against: this block is all the turn has been read as
  let newest = 0;
  for (const b of blocks) {
    const at = Number(b.at) || 0;
    if (at > newest) newest = at;
  }
  return (Number(block.at) || 0) === newest;
}

function paceThinkBlock(turn, block) {
  const P = state.typeStream;
  if (!P || !block) return null;
  const lid = `think:${block.at}`;
  const flowing = !document.hidden && turnLive(turn);
  // A block the stream has never held: history draws it whole, and on a live turn only the newest thought is written
  // (see above). A block the stream DOES hold is not history any more, whatever the status or the store says now.
  if (!state.thinkFed.has(lid) && (!flowing || !thinkIsNewest(turn, block))) return null;
  state.thinkFed.add(lid);
  // The thought joins the SAME queue as the answer's words and the tool records, stamped with the moment its first
  // delta arrived: that stamp is what keeps it in front of the call it introduced instead of behind it.
  const shown = P.feed(lid, String(turn.id), String(block.text ?? ""), { kind: "think", at: Number(block.at) || 0 });
  if (!flowing) return P.flush(lid) ?? shown;
  return shown;
}

// A SKILL'S RESULT is written like prose and reasoning are. Its lines join the stream as they join a console,
// and every row a console draws asks `typedShown` (core/console-format.js's hook) how much of itself it may show, so
// the lines of a skill type out at the reader's words-a-second inside the result's box — and walk in at their
// lines-a-second, because the gate in front of this already holds every line. Which results those are is
// wtType.isPacedTool; every other tool's result is drawn whole, exactly as before.
//
// A result's lines arrive together, behind the "↳ tool" header that names it, so the tool a body line belongs to is
// the nearest header above it in its burst. The header itself, the panel's fold note and the gateway's own notes
// are not words of the result and are never typed.
function resultToolOf(lines, line) {
  for (let k = lines.length - 1; k >= 0; k--) {
    const l = lines[k];
    if (!l || l === line) continue;
    if (l.kind === "tool") return "";
    if (l.kind !== "tool-out") continue;
    const m = TOOL_DONE_RE.exec(String(l.text || ""));
    if (m) return m[1];
  }
  return "";
}

function paceResultLine(lines, line, jobId) {
  if (!state.typeStream || !globalThis.wtType || line.kind !== "tool-out" || line.lid == null) return;
  const text = String(line.text ?? "");
  if (TOOL_DONE_RE.test(text) || consoleFoldNote(text) || /^\s*(?:…|\.\.\.)\s/.test(text)) return;
  if (!globalThis.wtType.isPacedTool(resultToolOf(lines, line))) return;
  // Only the head of the result is typed; the tail lands with the burst (see RESULT_PACED_ROWS).
  if (!shouldPaceResultRow(lines, line)) return;
  typedText(line, jobId);
}

// ---- result row head
// How many rows of one result are typed, and no more. A skill's result arrives as one row per line, and handing all
// forty to the stream made every tick write every row that had grown: one second carried 296 row writes, and the two
// seconds of that burst were 61% of a streamed window's writes (docs/console-redraw-spam.html). The head is what a
// reader watches arrive; past a handful of rows the typing is a delay rather than a reveal, so the rest of a long
// result is drawn at once. Six is a whole short result and the head of a SKILL.md.
const RESULT_PACED_ROWS = 6;

// Which row of its result this line is, counting from the call's own header (0 = the first line under it). Another
// call's header ends the count, so two results in one burst type the head of each.
function resultRowIndex(lines, line) {
  let n = 0;
  for (let k = lines.length - 1; k >= 0; k--) {
    const l = lines[k];
    if (!l || l === line) continue;
    if (l.kind === "tool") return n;
    if (l.kind === "tool-out") n += 1;
  }
  return n;
}

function shouldPaceResultRow(lines, line, cap = RESULT_PACED_ROWS) {
  return resultRowIndex(lines, line) < cap;
}
// ---- end result row head

// The words of a line that may be drawn now: the live append asks for them, and every render path asks too, so a
// repaint mid-paragraph draws the same prefix the console is showing instead of jumping to the wire's whole text.
function typedText(line, jobId) {
  const P = state.typeStream;
  const full = String(line?.text ?? "");
  if (!P || line?.lid == null) return full;
  // The wire's text reaches the stream whether or not anybody is looking. A hidden tab has no flow to show — the frame
  // is drawn whole and held whole — but the stream still has to be TOLD the rest of the line. It used to be skipped
  // while hidden, so a paragraph that was mid-type when the reader left stayed at the text it had then; every repaint
  // after they came back drew that prefix over the whole line, and the console showed "This" for a paragraph that
  // starts "This branch was added to main as version 0.47.0." until the card was reloaded from the store.
  const shown = P.feed(String(line.lid), String(jobId ?? ""), full, {
    kind: line.kind,
    at: line.at,
    // The console's own rows are capped: a result the wire handed over in full must not be revealed for a minute
    // (cause 7). A reasoning block keeps its deliberate reveal.
    cap: line.kind !== "think",
  });
  if (document.hidden) {
    P.flush(String(line.lid));
    return full;
  }
  return shown;
}

function typedShown(line) {
  const P = state.typeStream;
  if (!P || !line || line.lid == null) return null;
  // The record's own text goes with the question, so a repaint may only draw a prefix of THAT line (see
  // core/type-stream.js shownFor). A line with no text of its own — a reasoning row holds its words elsewhere — asks
  // with nothing, and the stream answers for itself, exactly as it did before.
  const rec = line.text;
  return P.shownFor(String(line.lid), rec == null ? undefined : String(rec));
}

// ---- console row text
// One row's visible text, written the cheapest way that is still correct.
//
// A growing line only ever gains characters at its end, and assigning innerHTML for them re-parses the whole row and
// replaces every text node in it — which is what took a selection out of the line every 40 ms while it typed. The tail
// is appended to the row's own text node instead, so the nodes the reader is selecting in stay where they are and a
// tick costs the delta rather than the line.
//
// The innerHTML path remains the correct one in three cases, and each is checked rather than assumed:
//   * the row no longer starts with what is drawn (the wire rewrote the line, or a trim moved it);
//   * the line carries a URL: linkifyText has to turn it into an anchor, and a URL appended as text would stay
//     unclickable for the rest of the turn;
//   * the row already has an element child (an anchor, a live-clock span): appending would put the tail after it.
const ROW_URL_RE = /https?:\/\//i;

function rowTakesTail(el, next) {
  if (typeof el._drawn !== "string" || !next.startsWith(el._drawn)) return false;
  if (el.childElementCount) return false;
  if (ROW_URL_RE.test(next)) return false;
  return !el.lastChild || el.lastChild.nodeType === 3;
}

// True when the row changed, so a caller knows the pane did not move for nothing.
function drawRowText(el, text) {
  const next = String(text ?? "");
  if (el._drawn === next) return false;
  // A THINKING row keeps its own `.think-text` box: that box is what the four-line clip is on, and the live mark is
  // its sibling. The row's innerHTML would flatten the box and the row would be drawn with no clip at all - a whole
  // thought of italic over the console - and it would take the "still thinking" mark with it. So a paint writes the
  // box, exactly where the row's own writer (patchThinkRow) writes it.
  const think = el.dataset && el.dataset.thinkRow ? el.querySelector(":scope > .think-text") : null;
  if (think) {
    // The box draws the thought's FIRST SECTION plus dots while the row is minimized, and the whole thought while it
    // is open (fitThinkRow owns that rule, and the lid's measured cut); a paint only hands it the source text.
    el.dataset.ltext = next;
    fitThinkRow(el);
    el._drawn = next;
    return true;
  }
  // A command card's prompt is drawn row by row like any other text, and the three dots that end its fold are cut into
  // one of those rows: the row has to be whole again BEFORE it is drawn, or the new words land after the dots and the
  // dots end up in the middle of a sentence. So the card is put back first (its own nodes, not a re-render), and the
  // frame after the draw marks it again from the text it now holds. The answer is remembered per row once the row is
  // in the page: 11000 draws a window is 11000 ancestor walks otherwise, and a row does not change cards.
  let card = el._cmdCard;
  if (card === undefined) {
    const found = el.closest ? el.closest(".code-box.is-cmd") : null;
    // Remembered once the row is in the page. A row drawn before it is inserted would cache "not in a card" forever.
    if (el.isConnected) el._cmdCard = found;
    card = found;
  }
  if (card) {
    clearCommandFoldMark(card);
    scheduleCommandFoldMark(card);
  }
  // A prose row draws MARKDOWN (core/console-markdown.js). The cheap tail-append below is still correct for a
  // growing paragraph that has no marker in the part that just arrived; once a marker lands — `**`, a backtick, an
  // underscore, a link's `[` — the row is rendered again, because the tail may be a marker that closes one already
  // on screen. Only this one row is re-parsed; the console and its other blocks are untouched.
  if (el.dataset && el.dataset.lkind === "text" && MD_MARK_RE.test(next.slice(String(el._drawn ?? "").length))) {
    el.innerHTML = consoleMdInline(next);
    el._drawn = next;
    return true;
  }
  if (rowTakesTail(el, next)) {
    // Grow the text node that is already at the end of the row: a new node per tick would leave a hundred siblings
    // behind for one line, and the reader's selection can sit inside this one and survive.
    const last = el.lastChild;
    const tail = next.slice(el._drawn.length);
    if (last && last.nodeType === 3 && typeof last.appendData === "function") last.appendData(tail);
    else el.appendChild(document.createTextNode(tail));
  } else el.innerHTML = linkifyText(next);
  el._drawn = next;
  return true;
}
// One character that can begin a markdown marker. A row with none of them in the arriving part is still plain
// text, which is what keeps a fast stream cheap.
const MD_MARK_RE = /[*_`[]/;

// ---- markdown prose, appended one line at a time -------------------------------------------------------------
// A live turn must not be repainted per token: each line is APPENDED, and this works out which block it belongs
// to (a paragraph, a list, a fence) and puts it there. core/console-markdown.js decides the shape; this does the
// DOM. A repaint (turnBody) renders the same run through consoleMdHtml, so a live console and its repaint agree
// about where a paragraph, a list and a fence begin and end.
function startMdBlock(plan, sep) {
  const holder = document.createElement("div");
  holder.innerHTML = consoleMdOpenHtml(plan);
  const block = holder.firstElementChild;
  if (block && sep) block.classList.add("jl-sep");
  return block;
}
function appendFenceRow(md, line) {
  const body = md.el.querySelector(".md-fence-body");
  if (!body) return;
  body.insertAdjacentHTML("beforeend", consoleMdAppendRow(line, "fence"));
  const n = body.children.length;
  md.el.dataset.mdLines = String(n);
  const count = md.el.querySelector(".md-fence-n");
  if (count) count.textContent = `${n} line${n === 1 ? "" : "s"}`;
}
// The closing fence. Past the fold the well arrives FOLDED, with the same head a repaint draws, so a fence that
// grew while the turn streamed ends in the shape the next repaint will give it.
function finishFence(md) {
  if (!md || md.type !== "fence" || !md.el) return;
  const body = md.el.querySelector(".md-fence-body");
  const n = body ? body.children.length : 0;
  md.el.dataset.mdLines = String(n);
  md.el.classList.remove("is-open");
  if (n <= CONSOLE_MD_FENCE_FOLD) return;
  md.el.classList.add("is-folded");
  const head = md.el.querySelector(".md-fence-head");
  if (!head) return;
  const holder = document.createElement("div");
  holder.innerHTML = consoleMdFenceHead(md.lang, n);
  head.replaceWith(holder.firstElementChild);
  if (body) body.hidden = true;
}
function appendProseLine(out, line, streaming, shown = null) {
  const prev = out._md || null;
  const plan = consoleMdPlan(prev, line);
  if (plan.action === "break") {
    out._md = null;
    return null;
  }
  if (plan.action === "close") {
    finishFence(prev);
    out._md = null;
    return null;
  }
  if (plan.action === "code" && prev) {
    appendFenceRow(prev, line);
    return prev.el;
  }
  if (prev && (plan.action === "line" || plan.action === "item")) {
    prev.el.insertAdjacentHTML("beforeend", consoleMdAppendRow(line, prev.type, { textOf: () => shown }));
    return prev.el;
  }
  const block = startMdBlock(plan, streaming && Boolean(out.lastElementChild));
  out.appendChild(block);
  out._md = { type: plan.type, ordered: Boolean(plan.ordered), lang: plan.lang || "", open: Boolean(plan.open), el: block };
  // An OPENING fence is a delimiter, not a line of the well: the block is the fence, and the next lines are its
  // code. (Drawn as a row it would sit inside the body it just opened, which is the shape a repaint never makes.)
  if (plan.type === "fence") return block;
  block.insertAdjacentHTML("beforeend", consoleMdAppendRow(line, plan.type, { textOf: () => shown }));
  return block;
}

// ---- the raw view, and the focus control ---------------------------------------------------------------
// A turn's raw bytes: the console is handed text, never markup, so the reader who needs the source gets every
// line exactly as the agent sent it (core/console-markdown.js, consoleMdRawText). `textContent` is the whole
// safety story here — a `<` in the output is a character, not a tag.
function consoleRawLines(out) {
  const id = String(out.dataset.out || "").replace(/@pin$/, "");
  return jobLines(id).filter((l) => !isBookkeeping(l));
}
function paintRawConsole(out) {
  // The attribute is NOT `data-md-raw`: that one is the reader's button, and a console carrying it would answer its
  // own selector — a click anywhere on the output would toggle the view it is showing.
  if (out.dataset.rawView !== "1") out._mdHtml = out.innerHTML;
  out.dataset.rawView = "1";
  out._md = null;
  out._wait = null;
  // The RAW text is not what the store would draw, so the next store read must repaint rather than trust a signature
  // taken from the view that was on screen before this toggle.
  out._paintSig = null;
  out._drawnVer = null;
  out.textContent = consoleMdRawText(consoleRawLines(out));
  grew(out);
  const wrap = out.closest(".out-wrap");
  if (wrap) wrap.classList.add("is-raw");
}
function restoreRenderedConsole(out) {
  delete out.dataset.rawView;
  out._md = null;
  out._paintSig = null;
  out._drawnVer = null;
  if (typeof out._mdHtml === "string") {
    out.innerHTML = out._mdHtml;
    delete out._mdHtml;
    out._wait = out.querySelector(":scope > [data-wait]");
    grew(out);
    // The rows are fresh nodes: forget what the previous ones had been drawn with, so the next append renders
    // rather than appending half a line to a node this page no longer holds.
    for (const row of out.querySelectorAll("[data-lid]")) delete row._drawn;
    // The open block is deliberately NOT recovered here: the lines that follow the toggle start the next block,
    // which is the paragraph break a repaint would put there anyway. Joining the restored last paragraph would
    // splice a sentence into one that had already been read.
  }
  const wrap = out.closest(".out-wrap");
  if (wrap) wrap.classList.remove("is-raw");
}
function paintConsoleModes(out) {
  const wrap = out && out.closest ? out.closest(".out-wrap") : null;
  if (!wrap) return;
  const id = String(out.dataset.out || "").replace(/@pin$/, "");
  const focus = state.consoleFocus.has(id);
  wrap.classList.toggle("is-focus", focus);
  const focusBtn = wrap.querySelector("[data-md-focus]");
  if (focusBtn) {
    focusBtn.setAttribute("aria-pressed", focus ? "true" : "false");
    focusBtn.classList.toggle("is-on", focus);
  }
  const rawBtn = wrap.querySelector("[data-md-raw]");
  const raw = state.consoleRaw.has(id);
  if (rawBtn) rawBtn.setAttribute("aria-pressed", raw ? "true" : "false");
  // The two views are applied to a console that was just placed, so a repaint keeps what the reader asked for.
  if (raw && out.dataset.rawView !== "1") paintRawConsole(out);
  else if (!raw && out.dataset.rawView === "1") restoreRenderedConsole(out);
}

// Every console showing this turn — the card's own and the pinned copy — is the same reader choice: a toggle is
// applied to each of them at once, so the pinned strip cannot keep showing the other view.
function consoleCopies(btn) {
  const wrap = btn.closest(".out-wrap");
  const box = wrap && wrap.querySelector("pre.job-out");
  if (!box) return { id: "", boxes: [] };
  const id = String(box.dataset.out || "").replace(/@pin$/, "");
  const boxes = placedNodes("pre.job-out").filter((el) => String(el.dataset.out || "").replace(/@pin$/, "") === id);
  return { id, boxes: boxes.length ? boxes : [box] };
}
function toggleConsoleRaw(btn) {
  const { id, boxes } = consoleCopies(btn);
  if (!id) return;
  const on = !state.consoleRaw.has(id);
  if (on) state.consoleRaw.add(id);
  else state.consoleRaw.delete(id);
  for (const box of boxes) {
    const wrap = box.closest(".out-wrap");
    const control = wrap && wrap.querySelector("[data-md-raw]");
    if (on) paintRawConsole(box);
    else restoreRenderedConsole(box);
    if (!control) continue;
    control.setAttribute("aria-pressed", on ? "true" : "false");
    control.classList.toggle("is-on", on);
    control.textContent = on ? "rendered" : "raw";
    control.title = on ? "back to the rendered view (markdown, links, fences)" : "show this turn's text exactly as it arrived, markdown and all";
  }
}
function toggleConsoleFocus(btn) {
  const { id, boxes } = consoleCopies(btn);
  if (!id) return;
  const on = !state.consoleFocus.has(id);
  if (on) state.consoleFocus.add(id);
  else state.consoleFocus.delete(id);
  for (const box of boxes) {
    const wrap = box.closest(".out-wrap");
    if (!wrap) continue;
    wrap.classList.toggle("is-focus", on);
    const control = wrap.querySelector("[data-md-focus]");
    if (control) {
      control.setAttribute("aria-pressed", on ? "true" : "false");
      control.classList.toggle("is-on", on);
      control.title = on ? "show the tool rows again" : "hide the tool rows: read the prose, the errors and the final message";
    }
  }
}
// A fence past the fold: the head's button opens and shuts that one well. Its own line count is the label, and
// the caret says which way it points.
function toggleConsoleFence(btn) {
  const well = btn.closest(".md-fence");
  const body = well && well.querySelector(".md-fence-body");
  if (!body) return;
  const open = body.hidden;
  body.hidden = !open;
  well.classList.toggle("is-folded", !open);
  const n = Number(well.dataset.mdLines) || body.children.length;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  btn.textContent = open ? "collapse" : `show ${n} line${n === 1 ? "" : "s"}`;
  const caret = well.querySelector(".md-fence-caret");
  if (caret) caret.textContent = open ? "\u25be" : "\u25b8";
}
// ---- end markdown prose
// ---- end console row text
