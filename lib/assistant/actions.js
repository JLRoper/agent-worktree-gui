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

// Lines the assistant writes at the end of its reply are how it acts on the board. It has no tool for
// this: the panel reads these prefixes and does the rest, so what it can do is exactly what is
// written down here.
export function parseActions(text) {
  const out = { to: [], watch: [], note: [], spawn: [], rule: [], charter: [], restart: [] };
  for (const line of String(text || "").split(/\r?\n/)) {
    const to = /^\s*TO\s+([A-Za-z0-9._:-]+)\s*:\s*(.+)$/.exec(line);
    if (to) {
      out.to.push({ thread: to[1], text: clip(to[2], 2000) });
      continue;
    }
    // SPAWN <project> | <prompt>   or   SPAWN IN <directory> | <prompt>
    // The pipe is the separator on purpose: a project may be a Windows path (`C:/…`), so a colon there
    // cannot also be the field break.
    const sp = /^\s*SPAWN\s+(.+?)\s*\|\s*(.+)$/i.exec(line);
    if (sp) {
      let target = sp[1].trim().replace(/^["']|["']$/g, "");
      let existing = false;
      const inside = /^IN\s+(.+)$/i.exec(target);
      if (inside) {
        existing = true;
        target = inside[1].trim().replace(/^["']|["']$/g, "");
      }
      out.spawn.push({ target, existing, prompt: clip(sp[2], 2000) });
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
      out.restart.push({ target: rs[1].toLowerCase(), reason: clip(rs[2] || "", 200) });
      continue;
    }
  }
  return out;
}

// The prompt's statement of the grammar above. It returns LINES, so `preamble()` spreads it into the turn's
// input exactly where the grammar belongs, and it takes the settings because one shape is conditional: with
// `spawn: "off"` the model may not propose a worktree at all, and the prompt has to stop offering it.
export function actionGrammar(settings = {}) {
  const s = settings;
  return [
    "To act, end your reply with plain lines in exactly these shapes — the panel reads them and does the rest:",
    "TO <thread>: <the reply text to that worker>",
    "WATCH <thread>: <what to watch for> | <minutes, optional>",
    "NOTE: <something to remember in your scratchpad>",
    "CHARTER: <a dated entry for the charter — write one when a standing answer changes or a long task closes>",
    "RULE: <a standing answer you are sure of — it is saved as a rule you and the reader both use>",
    ...(s.spawn === "off"
      ? []
      : [
          "SPAWN <project name> | <what the new worker should do>",
          "SPAWN IN <directory, worktree directory name, or branch> | <what the worker should do in that tree>     (no new worktree)",
        ]),
    "RESTART gateway        (restart the Hermes gateway — queued until your turn has ended)",
    "RESTART panel          (restart this panel — queued until your turn has ended)",
    "A standing rule is how you answer a worker without guessing. Write one when a decision will come up again (for example: deploy to QA, never PROD), not to record something you noticed once — that is what NOTE is for. You may add rules, and you may not edit or delete the reader's; they can delete yours in the Scratchpad tab, where assistant-written rules are marked.",
    "RESTART is an operator action, not a repair: the panel queues it until your turn has ended, and refuses it when the gateway's .env holds no provider key. Say that a restart was queued — never that the gateway is already back.",
  ];
}
