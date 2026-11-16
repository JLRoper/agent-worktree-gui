# The worker brief's report-card paragraph

`REPORT_BRIEF` in `lib/jobs.js` is the paragraph that tells every worker what a finding looks like when it is handed
over. It rides the assembled brief of a tree run beside `CLARIFY_LINKS_BRIEF` and `PAGE_BRIEF`, and it is off for a
turn with `anchorCwd: false` (the board assistant's own reads), the same structural gate the other paragraphs use.

## What it says

- Research, reviews, audits and measurements are written as a self-contained `.html` under `docs/reports/`, with the
  evidence inline and `file:line` citations - a page that opens on its own, with no server, no build step and no
  dependence on the transcript it came from.
- The report is declared on a `clarify` card as a `links` entry with an absolute `path` and a label that says what it
  is, so the card draws an anchor the reader can open instead of a path they have to copy out of a sentence.
- The recommended next steps become that card's choices, in the order the agent recommends them.
- A report with no card is a report nobody reads: the report and the decision arrive together or the finding waits in
  a directory.

## Why it was missing, and why a brief paragraph

The brief already said how to hand over a deliverable (`DELIVER_BRIEF`) and how to put a link on a question
(`CLARIFY_LINKS_BRIEF`), and the panel already owned the open route (`lib/open-url.js`, `POST /api/open-file` and
`POST /api/open-url`, described to workers in `PAGE_BRIEF`). None of those says that a piece of work IS a report.
So an audit or a measurement arrived as prose in the chat: nothing the reader could reopen, search, cite, or act on
from one place, and no decision attached to it.

It is a brief paragraph rather than a project rule for the reason `docs/worker-brief-git-remotes.md` records: the
paragraph is appended unconditionally for every tree run, so it reaches every project's workers without a rules save,
a config edit or a per-project runbook. `reportBrief` on the `Jobs` instance is the override, the same shape as
`gitBrief` and `linksBrief`.

## Assistant-level turns get the same standard from the standing rules

A turn with `anchorCwd: false` is the board assistant reading the board, not an agent in a tree: it has no
`docs/reports/` to write into, so the paragraph would be a lie in its prompt and it does not carry it. The same
standard reaches that turn through the assistant's STANDING RULES, which ride its preamble
(`lib/assistant/rules.js`, `briefingRules`), rather than through the brief. The standing rules are the reader's list
and the assistant's own additions to it; a report standard written there is what an assistant-level turn reads, and
this paragraph is not duplicated into that channel.

## Proof

`test/report-brief.test.js` reads the body a stub Runs API actually received and asserts three things:

1. a tree run carries the paragraph exactly once (`countOf(body, HEADING) === 1`), with the `docs/reports/` page,
   the inline evidence and `file:line` citations, the labelled `links` entry, the choices in the agent's order, and
   the "a report with no card is a report nobody reads" rule;
2. an assistant turn (`anchorCwd: false`) carries neither the heading nor the text;
3. the brief still renders in the other tree-run modes - a run in an existing tree and a landing turn - with the
   paragraph and the paragraphs beside it, and with no interpolation junk.

## Adding another paragraph

The shape is the settled one: an exported constant joined with newlines, a `this.<name>Brief?.(opts) ?? CONSTANT`
line in the assembly, gated on `where && opts.anchorCwd !== false`, and a splice in the `anchored` template. Keep it
to the length and voice of `REPORT_BRIEF` and `TERMINAL_BRIEF`: this text rides every worker turn forever, so it
earns its lines.
