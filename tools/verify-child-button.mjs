// The row's child-cut control, proved from the shipped page — no browser, no panel.
//
//   node tools/verify-child-button.mjs
//
// A LAYOUT claim about a sliced template is proved by string ORDER inside the cell's own template, not by a rendered
// DOM: this file is the regression gate that runs on a box with no Chromium, and it fails the moment the ＋ moves to
// the wrong side of the ⟳, disappears from the branch the project root keeps, or stops posting to the route that
// cuts the tree. The rendered half (a real click on a real row) is driven separately, against a sandbox panel's page.
//
// What it checks, and why each one is not cosmetic:
//   1. ORDER. ＋ is to the LEFT of the ⟳, which is to the left of the ✕. The reader asked for that order, and the
//      three read as one sentence across the row: make another tree from this branch · re-read this one · remove it.
//   2. THE SAME SUPPRESSION BRANCH. All three live inside `${isProjectRoot ? "" : ...}`, so the project's own checkout
//      has no cut control either — a child of the checkout's branch has no roll-up to arrive at, and the route
//      refuses it in the same words.
//   3. NO BRANCH, NO BUTTON. A detached-HEAD row draws nothing: there is no branch to cut from.
//   4. THE ATTRS THE HANDLER READS. data-child-tree (the row key), -project, -path and -branch all ride the button;
//      the handler reads exactly those, so a renamed attribute is a dead control.
//   5. THE HANDLER POSTS THE ROUTE. `cutChildTree` must call /api/worktree/child with the row's project and path, and
//      the delegated listener must answer `[data-child-tree]` — a template with no wiring is the same dead button.
//   6. THE INK IS ITS OWN. `.btn-child-tree` exists in the stylesheet, quiet at rest and coloured on hover, and the
//      actions column is wide enough to hold three controls (74px) rather than clipping the third.
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");

let checks = 0;
let failures = 0;
function ok(label, pass, detail = "") {
  checks += 1;
  if (pass) console.log(`ok    ${label}${detail ? ` — ${detail}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---- 1..4: the cell's template ------------------------------------------------------------------------------------
// The whole actions cell, taken from the row template it lives in. One line, because that is how rowHtml writes it.
const cellAt = src.indexOf('<td class="row-actions">');
const cellEnd = cellAt < 0 ? -1 : src.indexOf("</td>", cellAt);
const cell = cellAt < 0 || cellEnd < 0 ? "" : src.slice(cellAt, cellEnd);
ok("the actions cell is in rowHtml", Boolean(cell), cell ? `${cell.length} chars` : "no `td.row-actions` in public/app.js");

const atChild = cell.indexOf("${childBtn}");
const atRefresh = cell.indexOf("data-refresh-tree=");
const atDelete = cell.indexOf("data-del-tree=");
ok("all three controls are in the cell", atChild >= 0 && atRefresh >= 0 && atDelete >= 0, `child ${atChild}, refresh ${atRefresh}, delete ${atDelete}`);
ok("the cut sits LEFT of the ⟳", atChild >= 0 && atChild < atRefresh, `${atChild} < ${atRefresh}`);
ok("the ⟳ sits left of the ✕", atRefresh >= 0 && atRefresh < atDelete, `${atRefresh} < ${atDelete}`);
ok(
  'the cell opens on the project-root suppression',
  cell.startsWith('<td class="row-actions">${isProjectRoot ? "" : '),
  cell.slice(0, 80),
);

// The button's own ternary: drawn only for a row that HAS a branch, and only for a non-root row. Its template carries
// semicolons inside the tooltip, so the slice ends at the comment that introduces the ✕ rather than at the first `;`.
const btnAt = src.indexOf("const childBtn =");
const btnStop = src.indexOf("// One ✕ per row", btnAt);
const btn = btnAt < 0 || btnStop < 0 ? "" : src.slice(btnAt, btnStop);
ok("the button is built once, from one ternary", Boolean(btn), btn ? btn.split("\n")[0] : "no `const childBtn`");
ok("the project's own checkout draws no cut control", /isProjectRoot \|\| !row\.branch/.test(btn), btn.match(/isProjectRoot[^?]*\?/)?.[0] || "");
ok("a detached row draws no cut control", /!row\.branch/.test(btn));
for (const attr of ["data-child-tree", "data-child-project", "data-child-path", "data-child-branch"]) {
  ok(`the button carries ${attr}`, btn.includes(`${attr}=`));
}
ok("it wears its own class", /class="btn-child-tree"/.test(btn));
ok("its face is a plus the mono stack actually has", /<button[^>]*>\+<\/button>/.test(btn), "ASCII +, not a fallback glyph");
ok("its tooltip says what it cuts and what rolls back", /cut a child worktree off/.test(btn) && /rolls back into/.test(btn));

// ---- 5: the handler, and the listener that reaches it -------------------------------------------------------------
ok("the handler exists", /async function cutChildTree\(btn\)/.test(src));
ok("the handler posts the cut route", /"\/api\/worktree\/child"/.test(src));
ok(
  "it sends the project, the row's path and the name",
  /JSON\.stringify\(\{ project, path, name: String\(asked\)\.trim\(\) \}\)/.test(src),
);
ok(
  "cancel cuts nothing",
  /if \(asked === null\) return;/.test(src),
  "a dismissed prompt must not reach the route",
);
ok("the delegated listener answers the attribute", /e\.target\.closest\("\[data-child-tree\]"\)/.test(src));
const wireAt = src.indexOf('e.target.closest("[data-child-tree]")');
ok(
  "the listener calls the handler and stops the row from toggling",
  wireAt > 0 && /e\.preventDefault\(\);\s*\n\s*void cutChildTree\(childTree\);/.test(src.slice(wireAt, wireAt + 240)),
);
ok("a double click is one tree, not two", /childPresses/.test(src) && /< 3000/.test(src));

// ---- 6: the ink, and the room for three ----------------------------------------------------------------------------
ok("the button has a style of its own", /\.btn-child-tree \{/.test(css));
ok("quiet at rest, lit under the pointer", /tr\.row:hover \.btn-child-tree \{ opacity: 1; \}/.test(css) && /\.btn-child-tree:hover \{/.test(css));
const width = /\.row-actions \{ width: (\d+)px/.exec(css);
ok("the actions column holds three controls", Boolean(width) && Number(width[1]) >= 70, width ? `${width[1]}px` : "no width on .row-actions");

console.log(`\n${checks} checks, ${failures} failed.`);
console.log("static: the shipped template and stylesheet only — the click itself is driven against a sandbox page.");
console.log(failures ? `RESULT: ${failures} FAILED` : "RESULT: ALL PASS");
process.exit(failures ? 1 : 0);
