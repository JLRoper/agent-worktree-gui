# An initiative's notes: an append-only memory, with links as one row

Row 319, the MODEL half. The UI that draws the log is row 320 and is not touched here: `public/` is exactly as
`main` left it. What this branch adds is the record, the three routes that write it, and the one line an assistant
writes to log a note on a piece of work.

## What this does, file by file

**`lib/initiatives.js`**

- `notes` is a field on every initiative record: `[{ id, at, by, kind, text, url?, host?, label?, editedAt?, editedBy? }]`,
  oldest first on disk. `pickInitiative` reads it through a new `pickNote`, and `create` writes `notes: []`.
- `notesFor(id)` returns the log newest first, the same rule and reason as `historyFor`.
- `findForRef(ref)` resolves an initiative by id or by its exact (case-insensitive) title, and refuses an ambiguous
  title by name. This is what the assistant line names.
- `addNote({ initiative, text, url?, label?, by })`, `editNote({ initiative, note, text?, label?, by })` and
  `deleteNote({ initiative, note, by })` are the three writes, all in the file's own `{ ok: false, error }` style.
- New constants beside `TITLE_MAX`: `NOTE_TEXT_MAX` 1000, `NOTE_LABEL_MAX` 80, `NOTE_URL_MAX` 2048, `NOTES_MAX` 200,
  `NOTE_HOSTS`. New helpers `noteUrlOf`, `noteHostOf`, `noteUrlKey`, `newNoteId`.

**`routes/initiatives.js`**

- `POST /api/initiatives/notes/add` `{ id, text, url?, label?, by? }` - 201 with the note and the whole document.
- `POST /api/initiatives/notes/edit` `{ id, note, text?, label?, by? }` - 200.
- `POST /api/initiatives/notes/delete` `{ id, note, by? }` - 200 with the entry that was removed.
- `GET /api/initiatives` now carries `notes` (newest first) and `noteCount` on every active initiative, and the note
  caps beside the title's and the description's in `caps`.
- `POST /api/initiatives/update` is untouched: it still edits the title and the description only.

**`lib/assistant/actions.js`, `lib/assistant/audit.js`, `lib/assistant.js`, `server.js`**

- One typed line: `INITIATIVE NOTE <initiative id or title> | <what to remember>`. It parses as its own kind
  (`initiativeNote`), is counted by the turn's command ledger, and is carried by `applyActions` through the SAME
  store the routes write, attributed to the assistant whose turn wrote it.
- `Assistant` takes the store as an injected `initiatives`, the way it already takes `locks`; `server.js` passes the
  one store the initiatives tab writes.
- The preamble's grammar block gains the line and one standing sentence: an initiative's notes are where work that
  outlives a tree is remembered - the ticket id, the PR, the version, the decision.

## The shape, and the reasons for it

**Why an append-only log on the initiative, not a field on a tree.** A worktree is cut, landed and removed; the
ticket that started it, the PR that shipped a slice, the version it first went out in and the decision that closed a
fork all outlive that tree. The initiative is the record that outlives the trees, so the memory is written there.

**Why `id` and `at` are the panel's.** The reader and an assistant both write this log. An entry whose key or time
came from the caller could be duplicated, backdated or repeated on a retry; minting both here makes every entry
unique and ordered by the panel's own clock.

**Why `by` is on every entry.** Two kinds of writer share the log. Six weeks later "we decided X" is worth much less
than "assistant-2 decided X", and the reader's own entries should be distinguishable from an agent's without opening
a transcript.

**Why links are a kind rather than prose.** The reader keeps Jira, Bitbucket and GitHub references per initiative,
and those are the references he needs to click. A note whose whole text is one http(s) URL is stored as
`kind: "link"` with `url` and `host`. The host is read from the URL's HOSTNAME (`jira`, `bitbucket`, `github`,
`other`) and never from its path: a wiki page at `/jira-notes` is not a Jira reference. The host is recomputed on
every read, so a hand-edited file cannot claim one. Words around a URL stay prose - guessing between "a reference"
and "a sentence that mentions one" is how a link ends up unclickable.

**Why dedupe by URL.** Five copies of one ticket is noise, not memory. The key drops the fragment and a trailing
slash and keeps the query (a filtered board is a different view), so the two spellings a browser copies are one key.
A duplicate answers `changed: false` with the row that already holds it, and does not overwrite the reader's label.

**Why the caps refuse instead of clipping.** The title and the description clip because they are summaries the
reader can see being cut. A note is memory: silently dropping the tail of a remembered decision is worse than a
refusal that names the cap and the size. A full log refuses and says to delete one; the oldest entry is never
dropped to make room.

**Why a note does not touch `updatedAt`, `order` or the history.** The notes are a log BESIDE the record, not an
edit of its words. If logging a ticket id bumped `updatedAt`, the card would jump to the top of the reader's ordered
list (that field is the fallback sort) and the history would fill with "edit" events about a change nobody made to
the map.

**Why an edit keeps the author.** An edit adds `editedAt`/`editedBy` beside `at`/`by` rather than replacing them.
Who logged an entry and who last changed its words are two different facts.

**Why the note routes never ask the permission tier.** The tier governs the map - what worktree belongs to what
initiative. A note is memory on a record the reader already has, and the assistant half logs notes at the end of
turns. A question per note would make the log useless exactly where it matters. The actor is on the entry and in the
panel's log line, so an unasked change is still a recorded one.

**What happens to an archived initiative's notes.** They stay on the record and Restore brings them back unchanged;
the archived card carries `noteCount` but draws no log. Adding a note to an archived initiative is allowed - memory
is not membership - and the route does not refuse it.

## Proofs

| What the brief asked | Command | What it answered |
| --- | --- | --- |
| add / edit / delete round-trip, through the store and the route | `node --test test/initiatives-notes.test.js` (15 tests) | 15 pass, 0 fail |
| the three hosts, dedupe, caps, 404, reload, assistant attribution | same file | 15 pass, 0 fail |
| the wire half: add/edit/delete, three hosts, dedupe, caps, 404 | `node --test test/initiatives-route.test.js` (17 tests) | 17 pass, 0 fail |
| the tier never parks a note (control: the words ask at the same level) | same file, last test | 202 for the edit, 201 for the note, `asked: false` |
| no regression in the initiatives family | `node --test --test-concurrency=2 test/initiatives-store.test.js test/initiatives-order-archive.test.js test/initiative-fold.test.js test/initiative-history.test.js test/initiative-permissions.test.js test/initiative-tasks.test.js test/assistant-director.test.js test/command-audit.test.js test/harvest-gate.test.js` | 104 pass, 0 fail |
| no regression in the prompt/grammar family | `node --test --test-concurrency=3 test/assistant-preamble.test.js test/prompt-budget.test.js test/assistant-notes-cap.test.js test/assistant-system-briefing.test.js test/assistant-command-card.test.js test/assistant-digest.test.js test/assistant-rules-briefing.test.js` | 59 pass, 0 fail |

The full suite (`npm test`) is the one final sweep and its result is recorded in the pull request.

## What was not done, on purpose

- **`public/` is untouched.** The log's UI is row 320; a second live row holds that file.
- **No history event for a note.** The history vocabulary is closed to the four map changes, and a note is not one.
- **No archive refusal for notes.** The liveness rule is about waves and tasks; notes are not open work.
- **No edit of a note's `by` or `at`.** A caller cannot rewrite who an entry is from.

## Verify by hand

```
cd "<the root of this checkout>"
node --test test/initiatives-notes.test.js test/initiatives-route.test.js
```

On a running panel, with the store's path from the panel config:

```
curl -s -X POST http://127.0.0.1:7331/api/initiatives/notes/add -H "x-panel-token: <token>" \
  -H "content-type: application/json" \
  -d '{"id":"<initiative id>","text":"https://jira.prog.sefl.com/browse/DMR-39015","label":"the ticket"}'
```

The answer's `note.host` is `jira`, `kind` is `link`; post the same URL again and `changed` is `false` while
`initiative.notes` still holds one row.
