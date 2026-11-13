// The vocabulary the assistant acts with: the action-line grammar, written once.
//
// These prefixes are a contract with the model. It is told exactly which lines it may write at the end of a
// reply, and the panel reads them back here - so if the prompt is told a shape the parser does not accept,
// the action is silently dropped: no job, no alert, no journal line. That failure mode is why the prose and
// the parser live in one file and are edited together.
//
// `parseActions` is pure, and `actionGrammar` returns the prompt's own statement of the same shapes rather
// than a hand-written copy of it.

import { clip } from "./read.js";
import { parseTodoLines } from "../todos.js";

// A SPAWN line may LEAD with the id of the queue row it is carrying out: `SPAWN #12 <project> | …`,
// `SPAWN IN #12 <directory> | …` (and `SPAWN #12 IN <directory> | …`, which reads the same way). The id is what
// lets the panel write that row at the moment it cuts the job instead of by a follow-up edit the assistant has to
// remember. Bare `12` is accepted beside `#12` for the same reason a hold accepts both: a model writes it either
// way, and an id that parses is an id that can be linked.
const SPAWN_TASK_REF = /^#?(\d+)(?=\s|$)/;

// Split the part of a SPAWN line before its pipe into the target and, when it leads, the task id. The id may lead
// the whole target (`SPAWN #12 IN <dir>`) or follow the marker (`SPAWN IN #12 <dir>`): both say "this line is the
// row", and a parser that accepted one and silently kept the other as part of the directory would cut a tree in a
// path named "#12". A quote pair around the target is stripped exactly where it always was.
//
// `FROM <ref>` is the parent the new tree is cut from (`SPAWN FROM wtgui/roll-up <project>`, and the id may lead it
// either way). The ref is ONE token: git branch names carry `/` but never a space, so the field break is the first
// space after it and the rest is the project as before. `FROM` and `IN` are opposites - one cuts a tree, the other
// starts in one that stands - so a line carrying both is left for the resolver to refuse by name rather than
// half-read here.
function readSpawnTarget(raw) {
  let rest = String(raw ?? "").trim().replace(/^["']|["']$/g, "");
  let taskId = null;
  const lead = SPAWN_TASK_REF.exec(rest);
  if (lead) {
    taskId = Number(lead[1]);
    rest = rest.slice(lead[0].length).trim();
  }
  let existing = false;
  let from = null;
  const fromMatch = /^FROM\s+(\S+)\s+(.+)$/i.exec(rest);
  if (fromMatch && !/^IN\b/i.test(fromMatch[2])) {
    from = fromMatch[1].trim().replace(/^["']|["']$/g, "");
    rest = fromMatch[2].trim();
    if (taskId === null) {
      const after = SPAWN_TASK_REF.exec(rest);
      if (after) {
        taskId = Number(after[1]);
        rest = rest.slice(after[0].length).trim();
      }
    }
  }
  const inside = /^IN\s+(.+)$/i.exec(rest);
  if (inside) {
    existing = true;
    from = null;
    rest = inside[1].trim().replace(/^["']|["']$/g, "");
    if (taskId === null) {
      const after = SPAWN_TASK_REF.exec(rest);
      if (after) {
        taskId = Number(after[1]);
        rest = rest.slice(after[0].length).trim();
      }
    }
  }
  return { target: rest, existing, taskId, from };
}

// Lines the assistant writes at the end of its reply are how it acts on the board. It has no tool for
// this: the panel reads these prefixes and does the rest, so what it can do is exactly what is
// written down here.
export function parseActions(text) {
  const out = { to: [], watch: [], note: [], spawn: [], rule: [], charter: [], restart: [], todo: [], queue: [], message: [] };
  // The worktree a TODO line belongs to when it does not name one itself: the tree of the SPAWN line ABOVE it, which
  // is how the assistant seeds a card's acceptance items ("SPAWN IN <tree> | <brief>" then one TODO per item). Read
  // in line order, because that is the only order the reply has.
  let lastSpawn = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    const to = /^\s*TO\s+([A-Za-z0-9._:-]+)\s*:\s*(.+)$/.exec(line);
    if (to) {
      out.to.push({ thread: to[1], text: clip(to[2], 2000) });
      continue;
    }
    // QUEUE <assistant> | <a row to file in that assistant's queue> — the Assistant Director's first power. The
    // assistant may be named by id (`assistant-2`), by number (`#2` or `2`) or by its record name; the resolver is
    // `Assistant.assistantRef`, and an id it cannot place is a refusal rather than a guess. The pipe is the field
    // break for the same reason SPAWN uses one: the text may contain anything, including a colon.
    const q = /^\s*QUEUE\s+(.+?)\s*\|\s*(.+)$/i.exec(line);
    if (q) {
      out.queue.push({ assistant: clip(q[1].trim(), 80), text: clip(q[2], 2000) });
      continue;
    }
    // MESSAGE <assistant> | <what that assistant needs to know> — the Director's second power: a turn on that
    // assistant's own thread. It is not `TO`, which names a WORKER thread; the two never share a target.
    const msg = /^\s*MESSAGE\s+(.+?)\s*\|\s*(.+)$/i.exec(line);
    if (msg) {
      out.message.push({ assistant: clip(msg[1].trim(), 80), text: clip(msg[2], 2000) });
      continue;
    }
    // SPAWN <project> | <prompt>   or   SPAWN IN <directory> | <prompt>, each optionally led by a task id
    // (`SPAWN #12 <project> | …`, `SPAWN IN #12 <directory> | …`).
    // The pipe is the separator on purpose: a project may be a Windows path (`C:/…`), so a colon there
    // cannot also be the field break.
    const sp = /^\s*SPAWN\s+(.+?)\s*\|\s*(.+)$/i.exec(line);
    if (sp) {
      const target = readSpawnTarget(sp[1]);
      out.spawn.push({ target: target.target, existing: target.existing, prompt: clip(sp[2], 2000), taskId: target.taskId, from: target.from ? clip(target.from, 200) : null });
      lastSpawn = out.spawn.length - 1;
      continue;
    }
    // TODO … — the worktree's own list (lib/todos.js holds the grammar and the store; this only carries it into the
    // assistant's vocabulary). `spawn` is the SPAWN line above it, so a seed lands in the tree that spawn names; a
    // line with its own `IN <tree>` carries that instead.
    if (/^\s*TODO\b/i.test(line)) {
      for (const entry of parseTodoLines(line)) out.todo.push({ ...entry, spawn: entry.target ? null : lastSpawn });
      continue;
    }
    const w = /^\s*WATCH\s+([A-Za-z0-9._:-]+)\s*:\s*([^|]+?)\s*(?:\|\s*(\d+)\s*(?:m|min|minutes?)?\s*)?$/i.exec(line);
    if (w) {
      out.watch.push({ thread: w[1], title: clip(w[2], 140), minutes: w[3] ? Number(w[3]) : null });
      continue;
    }
    const n = /^\s*NOTE\s*:\s*(.+)$/i.exec(line);
    if (n) {
      out.note.push(clip(n[1], 500));
      continue;
    }
    // RULE: <text> — a standing rule the assistant may add for itself. Three separators, because a model
    // writes this line three ways: "RULE: x", "RULE - x", "RULE x". \b keeps "RULES ..." from matching.
    const ru = /^\s*RULE\b\s*(?:[:–—-]\s*)?(.+)$/i.exec(line);
    if (ru) out.rule.push(clip(ru[1], 400));
    // CHARTER: <what changed> — a dated entry for the continuity file. The panel appends it and prunes the
    // oldest entries over the cap; the reasoning behind a rule has nowhere else to live.
    const ch = /^\s*CHARTER\b\s*(?:[:–—-]\s*)?(.+)$/i.exec(line);
    if (ch) out.charter.push(clip(ch[1], 500));
    // RESTART gateway | RESTART panel — the one line that acts on this panel's own process. It maps
    // to POST /api/restart: the panel QUEUES it and runs it only once this turn has ended, because
    // the turn asking for the restart is itself a run inside the gateway. Anything after the word is
    // the reason, kept for the journal.
    const rs = /^\s*RESTART\s+(?:the\s+)?(gateway|panel)\b\s*(.*)$/i.exec(line);
    if (rs) {
      // The pipe is the grammar's separator, not the reason's first character. It used to be handed over with the
      // reason, which is how `RESTART panel | serve 0.67.0 …` queued a reason beginning with "|" — after the panel
      // already served that version. A doubled pipe still begins with one and the controller refuses it by name.
      const why = String(rs[2] || "").replace(/^\s*\|\s*/, "");
      out.restart.push({ target: rs[1].toLowerCase(), reason: clip(why, 200) });
      continue;
    }
    // `RESTART | <why>` names no gateway/panel target. It is still a command attempt, and the controller refuses it
    // with the required shape instead of the line vanishing into the unparsed count.
    const rsNoTarget = /^\s*RESTART\s*\|\s*(.*)$/i.exec(line);
    if (rsNoTarget) {
      out.restart.push({ target: "", reason: clip(rsNoTarget[1], 200) });
      continue;
    }
  }
  return out;
}

// The prompt's statement of the grammar above. It returns LINES, so `preamble()` spreads it into the turn's
// input exactly where the grammar belongs, and it takes the settings because one shape is conditional: with
// `spawn: "off"` the model may not propose a worktree at all, and the prompt has to stop offering it. `director`
// is the second conditional: the Assistant Director's two powers (QUEUE / MESSAGE) are listed for that role and no
// other, and the worker-facing TO and SPAWN shapes are withheld from it — a power the model is not offered is a
// power the parser will not have to refuse.
export function actionGrammar(settings = {}, { director = false, consolidate = false, assistantId = "" } = {}) {
  const s = settings;
  // The consolidation line is OFFERED only when the reader has granted it: a power the model is not offered is a
  // power the route will refuse, and the grant is read from the record rather than assumed from the prompt.
  const self = String(assistantId || "").trim();
  return [
    "To act, end your reply with plain lines in exactly these shapes — the panel reads them and does the rest:",
    ...(director
      ? []
      : ["TO <thread>: <the reply text to that worker>"]),
    ...(director
      ? [
          "QUEUE <assistant> | <a row to file in that assistant's queue — what it should do, in one sentence>",
          "MESSAGE <assistant> | <what that assistant needs to know>     (starts a turn on its own thread)",
          "`<assistant>` is `assistant-2`, `#2`, `2`, or that assistant's name. Every QUEUE and MESSAGE line is preceded by a sentence saying which assistant you chose and why.",
        ]
      : []),
    "WATCH <thread>: <what to watch for> | <minutes, optional>",
    "NOTE: <something to remember in your notes>",
    "CHARTER: <a dated entry for the charter — write one when a standing answer changes or a long task closes>",
    "RULE: <a standing answer you are sure of — it is saved as a rule you and the reader both use>",
    ...(s.spawn === "off" || director
      ? []
      : [
          "SPAWN [<task id>] <project name> | <what the new worker should do>",
          "SPAWN FROM <parent ref> [<task id>] <project name> | <what the new worker should do>     (the new tree is cut from <parent ref> instead of the checkout's branch)",
          "SPAWN IN [<task id>] <directory, worktree directory name, or branch> | <what the worker should do in that tree>     (no new worktree)",
        ]),
    "A SPAWN led by a task id — `SPAWN #12 <project> | …`, `SPAWN IN #12 <tree> | …`, `SPAWN FROM feature/roll-up #12 <project> | …` — is carrying out that row of your own queue: the panel marks it running and ties it to the worker's thread and tree at the cut, so write the id whenever a SPAWN answers a task. With no id the line cuts a tree and links no row.",
    // THE CONTINUATION RULE. A worker's question, a follow-up on work a worker just did, a line a reviewer
    // named: all of them continue a session that already holds the context the answer is about, and a fresh
    // session re-derives it. Measured on this board: a fresh session in the same tree spent 393k input
    // re-deriving a one-line comment the asking thread still had. So the default is TO that thread, and
    // `SPAWN IN` is the gear change - which is also why the second escape names a LARGE context: every turn
    // re-sends the thread's transcript, so reuse stops paying once that transcript is big.
    "Answer a worker's question and continue its work with `TO <its thread>`, not `SPAWN IN` its tree: the asking thread already holds the context the answer is about (the ticket, the file, the drafted text), and a new session in the same tree re-derives all of it. Start a NEW session with `SPAWN IN` only when the work changes gear - a different task, a different tree, a different repo - or when that thread's context is already large, where re-sending its transcript costs more than a fresh read.",
    "`SPAWN FROM` names where the new tree starts: a branch that exists in the project's repo (`SPAWN FROM feature/roll-up agent-worktree-gui | …`), a tag, or a commit. The branch becomes the tree's parent, so the board hangs the tree under it and the worker's landing paragraph rolls the work back into it - the checkout's own branch is not consulted. It always cuts a NEW tree, so it is never combined with `IN`. A ref that resolves to nothing in that repo refuses the line and cuts nothing, so name one you have seen in `git branch -a` rather than one you expect to exist.",
    "TODO <what has to happen>          (adds it to the TODO list of the worktree the SPAWN above names; `TODO IN <directory> | <text>` names the tree itself)",
    "TODO DONE <id> / TODO DROP <id> / TODO DOING <id> / TODO REOPEN <id>     (the id the list is shown with — the leading integer; a reason after it is ignored; `IN <tree> | <id>` for another worktree)",
    "RESTART gateway | <why>        (restart the Hermes gateway — queued until your turn has ended; the reason is required)",
    "RESTART panel | <why>          (restart this panel — queued until your turn has ended; the reason is required)",
    "A standing rule is how you answer a worker without guessing. Write one when a decision will come up again (for example: deploy to QA, never PROD), not to record something you noticed once - that is what NOTE is for. You may add rules; merging, dropping, moving a rule into the charter and setting the role prompt are the consolidation pass's work, and that pass runs only when the reader has granted it.",
    ...(consolidate
      ? [
          `Consolidation is GRANTED for you${self ? ` (${self})` : ""}: you may POST one plan to /api/assistant/consolidate as {"dryRun":true,"plan":{"ops":[...]}} and read the report, then the same call with dryRun:false. Ops are keep, rewrite, merge, drop, charter and prompt, and every rule id in your list must appear in exactly one op. A plan that drops the reader's rule, merges or moves a safety-pinned rule, or overwrites a role prompt the reader wrote is refused by name; a real pass writes a snapshot of the before state first, so a dry run before every apply is the cheap habit.`,
        ]
      : []),
    "The TODO list is the worktree's, not the thread's: every agent in that tree is handed it (with its ids) and told to keep it current, and the reader sees the OLDEST item still open on the row. Seed it when you start work in a tree — one TODO line per acceptance item, under the SPAWN line — and keep it honest afterwards: mark an item done only when something actually closed it, and an id that does not exist is refused out loud rather than ignored.",
    "RESTART is an operator action, not a repair: the panel queues it until your turn has ended, refuses it when the gateway's .env holds no provider key, and refuses a line with no reason — always say what the restart is for, on the same line. Say that a restart was queued — never that the gateway is already back.",
  ];
}
