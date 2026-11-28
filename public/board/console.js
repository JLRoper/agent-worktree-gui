// The client console's ENTRY POINT, cut out of public/app.js and then cut four ways by the module-separation plan
// (docs/reports/module-separation-2026-11-28.html, card 9). A classic script, evaluated BEFORE app.js
// (public/index.html) because app.js's boot IIFE calls the console's renderers on the first paint.
//
// WHERE THE CONSOLE LIVES NOW. The console is five classic scripts, loaded in this order by public/index.html:
//
//   /board/console.js         this file - the line vocabulary every cut reads: the two tool regexes, the call
//                             argument, the in-flight call and the bookkeeping kinds
//   /board/console-stream.js  the gateway wait line, reasoning and markdown prose, the docked console, the row text
//   /board/console-tools.js   the tool group key, the trimmed group head and the tool-usage group
//   /board/console-rows.js    the writers, the rows by line id, the marching tail, patching and the copy buttons
//   /board/job-line.js        drawJobLine and the job card's own console frame
//
// All four cuts have landed: each cut file's header names what it took, and this file is only what no cut claimed -
// the two tool regexes, the call argument, the in-flight call and the bookkeeping kinds, which every cut reads.
//
// This entry point re-exports nothing and delegates nothing, because a classic script cannot: a top-level
// `function` here IS a `window` property under its own name, and a top-level `const`/`let` a binding in the page's
// one global lexical environment, so a name moved to a cut file is still the same page global read by the same bare
// name. What the load order buys and what it forbids is unchanged:
//   * every top-level `function` in any of the five files is a `window` property under its own name, so an inline
//     handler, a later script and the other board modules read it exactly as they read it before;
//   * every top-level `const`/`let` is a lexical binding in the page's one global lexical environment, which the
//     later app.js reads by bare name;
//   * a name one file does NOT declare (`state`, `esc`, `apiFetch`, `toolGroupsOn`, `paintSubagents`,
//     `typeWordSpeed`, ...) may only be read from inside a function body. At top level app.js has not run yet: the
//     console's own `state.*` initialisations therefore stay in app.js, beside the `state` literal they extend.
//
// Everything that draws a card, a row, a chart, the deliverable list, Settings or the pipeline modal stays in app.js.


// A tool that runs for minutes is the one thing that makes a healthy turn look frozen — a 159 s
// recursive grep did exactly that, and the card showed nothing but the line that started it. Every
// line carries the server's timestamp, so the tool still in flight can grow a live clock.
// Lines lead with the tool's glyph (📖 read_file · path); history written before glyphs leads with ▸,
// so the arrow is optional and the glyph run is skipped before the name is taken.
const TOOL_START_RE = /^(?:▸\s*)?(?:[\p{Extended_Pictographic}\uFE0F\u200D]+\s*)?([^\s·]+)/u;
const TOOL_DONE_RE = /^\s*↳\s*([^\s·]+)/;
// The argument a call line carries ("📖 read_file · docs/map.md"): what the tool was given. The console's own
// rows use it, and a file's code box names the file from it.
const toolCallArg = (text) => {
  const s = String(text || "");
  const sep = s.indexOf(" · ");
  return sep >= 0 ? s.slice(sep + 3) : "";
};

// Index of the started tool call that has no result yet, or -1. Parallel calls interleave, so count
// starts and completions per tool name rather than assuming the last line is the running one.
function inflightToolIndex(lines) {
  const started = new Map();
  const finished = new Map();
  let lastIdx = -1;
  let lastName = null;
  lines.forEach((l, i) => {
    const text = String(l.text || "");
    const start = l.kind === "tool" ? TOOL_START_RE.exec(text) : null;
    if (start) {
      started.set(start[1], (started.get(start[1]) || 0) + 1);
      lastIdx = i;
      lastName = start[1];
      return;
    }
    const done = l.kind === "tool-out" ? TOOL_DONE_RE.exec(text) : null;
    if (done) finished.set(done[1], (finished.get(done[1]) || 0) + 1);
  });
  if (lastIdx < 0 || !lastName) return -1;
  return (started.get(lastName) || 0) > (finished.get(lastName) || 0) ? lastIdx : -1;
}

// The name of the call that has started and not come back - the reason a steer can sit undelivered for minutes.
function inflightToolName(lines) {
  const i = inflightToolIndex(lines);
  if (i < 0) return null;
  const m = TOOL_START_RE.exec(String(lines[i].text || ""));
  return m ? m[1] : null;
}

// The console is what the agent DID, not the run protocol around it. Three lines are bookkeeping: the POST
// that opened the run, the run id echoed back, and the completion summary with the token total. The card
// already states all three — the head carries "turn 2 · done · 26s · 186725 tok" and the foot the outcome —
// so they are stored but not drawn.
const BOOKKEEPING_LINES = new Set(["cmd", "init", "result"]);
function isBookkeeping(l) {
  return Boolean(l && BOOKKEEPING_LINES.has(l.kind));
}
