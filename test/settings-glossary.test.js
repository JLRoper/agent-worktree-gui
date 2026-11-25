// The Settings glossary: the two worktree kinds and the four project chips, explained where their controls live.
//
// The settings panel is static markup, so this reads it the way the reader does: the General tab carries a short
// index, the Repo tab carries what T and R mean and what a lift changes plus the turnover/rules/cleanup chips, and
// the Board tab carries the board chip. Four facts are the ones a wrong build would lose, and each is asserted as a
// sentence rather than a word: R is LOCAL ONLY until lifted, the lift goes through POST /api/worktree/kind-lift, a
// lifted tree keeps its R with a tick, and a lift does not beat a repository's never. The blocks are also checked
// for the shape that makes them readable: each follows its heading row, no block is a tab, and the prose carries no
// long dash that would break its own layout.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");

const panel = (key) => {
  const start = html.indexOf(`data-settings-group="${key}"`);
  assert.ok(start > 0, `the ${key} panel must exist`);
  const next = html.indexOf('<div class="settings-group', start + 10);
  return html.slice(start, next > 0 ? next : undefined);
};
const block = (id) => {
  const start = html.indexOf(`id="${id}"`);
  assert.ok(start > 0, `#${id} must exist`);
  // The block's own div: from its opening tag to the closing tag of the same element, which no sibling opens inside.
  const end = html.indexOf("</div>", html.indexOf("</dl>", start));
  return html.slice(html.lastIndexOf("<div", start), end + 6);
};
const words = (chunk) => chunk.replace(/<[^>]+>/g, " ").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/\s+/g, " ").trim();

const general = panel("general");
const repo = panel("repo");
const board = panel("board");

test("the General tab carries the short index, and it points at the two tabs that explain the parts", () => {
  assert.match(general, /id="glossary-index-row"/, "the index has a heading row of its own");
  const index = block("settings-glossary-index");
  const said = words(index);
  assert.match(said, /turnover child/);
  assert.match(said, /research tree/);
  assert.match(said, /turnover: rules: cleanup:/);
  assert.match(said, /board:/);
  assert.match(said, /Settings > Repo, under Worktree kinds/, "the kinds point at Repo");
  assert.match(said, /Settings > Repo, under The project chips/, "the three chips point at Repo");
  assert.match(said, /Settings > Board, under The board chip/, "the board chip points at Board");
  assert.match(said, /index/i, "the block says what it is");
});

test("the Repo tab explains T and R, and what a lift does and does not change", () => {
  assert.match(repo, /id="kinds-heading"/, "the kinds have a heading row");
  const kinds = words(block("settings-glossary-kinds"));
  assert.match(kinds, /turnover child/);
  assert.match(kinds, /has a destination on the remote/);
  assert.match(kinds, /research tree/);
  assert.match(kinds, /main, master, trunk, develop/, "the main parent is spelled out");
  assert.match(kinds, /LOCAL ONLY/);
  assert.match(kinds, /refuses a push from it/, "the refusal is named");
  assert.match(kinds, /POST \/api\/worktree\/kind-lift/, "the lift's route is named");
  assert.match(kinds, /keeps its R with a tick/, "a lifted tree keeps its kind mark");
  assert.match(kinds, /The kind stays research/, "the kind is never rewritten");
  assert.match(kinds, /What a lift does not do/);
  assert.match(kinds, /does not beat a repository's never/, "never outranks a lift");
  assert.match(kinds, /does not skip the branch-name gate/);
  assert.match(kinds, /does not turn the tree into a turnover child/);
  assert.match(kinds, /No push is made, no branch or commit moves/, "a lift moves nothing");
});

test("the Repo tab explains the turnover, rules and cleanup chips, and nothing more", () => {
  assert.match(repo, /id="chips-heading"/, "the chips have a heading row");
  const chips = words(block("settings-glossary-chips"));
  for (const chip of ["turnover:", "rules:", "cleanup:"]) assert.match(chips, new RegExp(chip.replace(":", "\\:")), `${chip} is explained`);
  assert.match(chips, /the checkout's own branch/);
  assert.match(chips, /local turnover branch - ask if none exist/);
  assert.match(chips, /merges back into it locally, with no push and no pull request/);
  assert.match(chips, /drawn at zero too/, "the rules chip is drawn even at zero");
  assert.match(chips, /first line first/, "the rules are read in order");
  assert.match(chips, /Reads every worktree of the project and plans a sweep/);
  assert.match(chips, /The first press removes nothing/);
  assert.match(chips, /A second press applies the plan/);
  assert.match(chips, /merges the branches that still hold work into a local child/);
  assert.match(chips, /never touches a locked tree/, "the locks and live jobs are named");
  assert.doesNotMatch(block("settings-glossary-chips"), /<dt>board:/, "the board chip is Board's, not a second copy here");
});

test("the Board tab explains the board chip: live PIDs and the stale count", () => {
  assert.match(board, /id="board-chip-heading"/, "the board chip has a heading row");
  const said = words(block("settings-glossary-board-chip"));
  assert.match(said, /\.agentboard/);
  assert.match(said, /PID is alive right now/);
  assert.match(said, /stale count/);
  assert.match(said, /The claims are not locks/);
});

test("each block follows the heading row that names it, and no block is a tab", () => {
  for (const [row, id] of [
    ["glossary-index-row", "settings-glossary-index"],
    ["kinds-heading", "settings-glossary-kinds"],
    ["chips-heading", "settings-glossary-chips"],
    ["board-chip-heading", "settings-glossary-board-chip"],
  ]) {
    assert.match(
      html,
      new RegExp(`<div class="settings-row[^"]*" id="${row}"[\\s\\S]*?<\\/div>\\s*<div class="settings-glossary" id="${id}"`),
      `${id} sits directly under ${row}, so the settings search shows and hides them together`,
    );
  }
  for (const id of ["settings-glossary-index", "settings-glossary-kinds", "settings-glossary-chips", "settings-glossary-board-chip"]) {
    assert.doesNotMatch(block(id), /data-settings-tab|role="tab"/, `${id} adds no tab`);
  }
  // The strip lost the Human tab with its button: thirteen tabs and thirteen panels, the glossary inside three of them.
  assert.equal(html.split('data-settings-tab="').length - 1, 13, "thirteen tabs");
  assert.equal(html.split('role="tabpanel"').length - 1, 13, "thirteen panels");
});

test("the three tab titles name the blocks they now carry", () => {
  const title = (key) => (html.match(new RegExp(`data-settings-tab="${key}"[^>]*title="([^"]+)"`)) || [])[1] || "";
  assert.match(title("general"), /index to the two row kinds and the four project chips/);
  assert.match(title("repo"), /Worktree kinds/);
  assert.match(title("repo"), /The project chips/);
  assert.match(title("board"), /board: chip/);
});

test("the prose is plain-punctuated and the CSS is one glossary block", () => {
  for (const id of ["settings-glossary-index", "settings-glossary-kinds", "settings-glossary-chips", "settings-glossary-board-chip"]) {
    assert.doesNotMatch(block(id), /[\u2013\u2014]/, `${id} uses plain hyphens, never an en or em dash`);
  }
  const rule = css.match(/\n\.settings-glossary \{([^}]*)\}/);
  assert.ok(rule, "the glossary has its own rule");
  assert.match(rule[1], /font-size:\s*12px/, "the prose reads at the panel's own size");
  assert.match(rule[1], /overflow-wrap:\s*anywhere/, "a long route wraps instead of widening the window");
  assert.match(rule[1], /border-left/, "the block reads as attached to the row above");
  assert.match(css, /\n\.settings-glossary dt \{/, "the terms are drawn as terms");
  assert.match(css, /\n\.settings-glossary dd \{/, "and the answers as answers");
  // Every selector this branch adds is under the one class, so nothing else in the stylesheet moves.
  const added = css.split("/* ---- Settings > the row glossary")[1]?.split("/* ---- Settings > Prompt")[0] || "";
  assert.ok(added.length > 200, "the glossary block is contiguous in the stylesheet");
  for (const line of added.split("\n").filter((l) => l.trim().endsWith("{") || l.trim().endsWith("}"))) {
    if (!line.includes("{") || line.trim().startsWith("/*")) continue;
    assert.match(line, /\.settings-glossary/, `every added selector is the glossary's: ${line.trim()}`);
  }
});
