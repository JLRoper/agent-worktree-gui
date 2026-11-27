# The board's tags: a registry of ids, chips after the waves chip, and a filter that composes

Row `TASK-371`, the initiative tag concept. An initiative becomes a card you can group by: the reader keeps a small
vocabulary of tags on the board, every card carries as many as it wants, and the pane's top row filters by them
alongside the Active/Archived switch and the archived search.

## What this does, file by file

**`lib/initiative-tags.js`** (new)

- The registry store over `initiative-tags.json` (a sibling of `initiatives.json`): `{ id, ident, name, description,
  color, createdAt }` per tag, oldest first, in a versioned document with an atomic temp-file write.
- `TAG_PALETTE` is the fixed ten: slate, red, amber, olive, green, teal, sky, blue, violet, pink. A tag stores the
  NAME; `public/style.css` owns what each name paints.
- Caps refuse rather than truncate (`validateTag`): the ident is 2-6 letters or digits and unique
  case-insensitively, the name is at most 40, the description at most 200, the colour has to be one of the ten. The
  id and `createdAt` are the panel's - a caller that posts them is ignored.
- The store is refused, not repaired: an unreadable file reports `readable: false` with the sentence and the path,
  every write answers `refused: "unreadable"`, and the bytes are left exactly as they were.
- `remove({ id, confirm, carried })` refuses while `carried` is non-empty and its sentence names the COUNT.

**`lib/initiatives.js`**

- `tagIds` on every initiative record: ids only, deduped, absent read as none. `tagIdsOf` reads a hand-edited file
  forgivingly.
- `tagIdsRefusal(list)` validates a write against the registry: an unknown id is refused BY NAME
  (`no such tag: tag_...`), `undefined` leaves the list alone, `[]` clears it. `create` and `update` take `tagIds`
  through it, so no route can bypass the check.
- `carriersOfTag(id)` is the list a delete's refusal counts (archived records included), and `dropTag({ id })` takes
  the id off every initiative in ONE save - deliberately not an edit of anybody's words, so one press in the
  registry does not write twelve history lines.
- `update`'s history line now names what actually moved: "the title and the description", "the tags", or a list of
  all three.

**`lib/paths.js`**: `initiativeTagsFile`, beside `initiativesFile`.

**`routes/initiatives.js`**

- `GET /api/initiatives/tags` - the registry alone (tags, palette, caps, `identRule`, and the file's status).
- `POST /api/initiatives/tags` `{ ident, name, description?, color? }` - 201.
- `PATCH /api/initiatives/tags` `{ id, ident?, name?, description?, color? }` - the one entry, 200.
- `DELETE /api/initiatives/tags` `{ id, confirm? }` - 409 with `carried` and the count while a card carries it; with
  `confirm: true` the id leaves every initiative first (one save) and then the entry goes.
- THE THREE WRITES ARE THE READER'S ALONE: a `by` that is not `reader` is a 403. An assistant may still APPLY an
  existing tag through the initiative routes.
- `GET /api/initiatives` carries `tags` (the whole registry document) and `tagIds` on every active and archived card,
  plus the tag caps; `POST /api/initiatives` and `/update` accept `tagIds`.
- A registry write drops the tab's cached document, so the next read cannot answer the vocabulary from before it.

**`public/core/initiative-fold.js`**: `TAG_CHIP_FIRST` (3), `tagChips`, `tagFilterMatch`, `tagFilterParse`,
`tagFilterQuery`, `tagFilterFromUrl` - the pure half, with a test beside it.

**`public/assistant.js`**

- `initTagChipsHtml(init, open)`: the first three chips and one `+N`, drawn AFTER the "#N waves" status chip in the
  facts row, on the folded card and the open one (and on an archived card). A press on `+N` lists the rest in a second
  row under the facts, and on a folded card it opens the card in the same press.
- The filter row: one toggle per tag (all pressed at rest), the any/all switch beside them, a visible Clear, and
  Manage tags. The state is saved to the URL query (`initTags=…&initTagMode=all`) and to localStorage
  (`wm.initiativeTagFilter`), read back at load, and Clear restores the default.
- The registry editor: one row per tag with Rename (an inline form) and Delete; a delete's refusal draws the server's
  sentence with a `Delete anyway (N)` control; the create form is the same form with `mode: "new"`.
- The edit form carries an apply picker, and Save sends `tagIds`, so the reader applies tags exactly where the words
  are edited.
- The filter is COMPOSED: the active list is narrowed by tags, the archived list by its search box AND the tags, and
  the "all pressed, any" rest state is NO filter - the whole board, untagged cards included.

**`public/style.css`**: `.init-tag` (a 4px plate with a coloured left spine, mono ident - deliberately not the count
`.chip`'s capsule), the ten swatches, `.init-tag-more`, `.init-tags-rest`, the filter row and the editor.

**`tools/verify-initiative-tags.mjs`** (new, `npm run verify:initiative-tags`): the live gate over the fixture panel -
56 checks, listed below.

## The shape, and the reasons for it

**Why ids, never text.** A rename has to follow every card and every saved filter in one write. That is only possible
if nothing copied the words onto a card: an initiative stores `tagIds`, the registry stores the words, and the tab
joins them at paint time. A paste-time copy would need a migration every time the reader changed his mind about a
name.

**Why the registry is its own file.** The waves store taught this: an initiative write must never rewrite the
vocabulary, and renaming one tag should be one small document rather than a rewrite of every card. It also lets the
unreadable-file rule be per store, so a corrupt registry cannot take the initiative map with it.

**Why the ident is unique case-insensitively.** "SSO" and "sso" as two tags would make the filter mean two things at
once and the chips unreadable at a glance. The ident keeps the case the reader typed; only the uniqueness compares
without it.

**Why a fixed palette rather than a hex.** Ten names are a vocabulary the sheet can paint for a dark theme and re-paint
without a migration. A free hex would let a reader choose an illegible chip and would put colour decisions in a JSON
file.

**Why delete is two-step.** A tag on live cards is a fact about eleven pieces of work; deleting it is not the same
press as deleting an unused one. The refusal names the count and the first three titles, the confirm control repeats
the number, and only `confirm: true` writes. The ids leave the cards BEFORE the entry goes, so a failed second write
leaves an unused tag rather than cards naming a tag nobody can restore.

**Why "all pressed" is no filter.** The row's default has every tag pressed - that is what "ALL selected by default"
means. If that state filtered, the default board would silently hide every untagged initiative. So the rest state is
the whole board by definition, and the any/all switch is a real question only once the reader has pressed something
off (or asked for "all", which is a narrowing even at full selection).

## The proof

- `test/initiative-tags-store.test.js` - 12 tests over the registry and the join: the panel's id and clock, the
  case-insensitive ident, every cap's refusal, the palette, the unreadable file, the forgiving read, ids-not-text, the
  rename, the counted delete and the one-save drop.
- `test/initiative-tags-fold.test.js` - 7 tests: the chip cap and the +N, the filter's any/all/untagged/empty rules,
  the URL record both ways, the card ordering and class contract, and the route's four verbs with the reader-only
  refusal.
- `test/initiative-tags-route.test.js` - 8 tests over a real panel: the four verbs, the reader-only 403s, an assistant
  applying a tag, the rename following the cards, the counted delete with the store byte-identical, and the unreadable
  registry's 409.
- `npm run verify:initiative-tags` - the live gate: 56/56 checks, EXIT=0, zero page errors, and the only refusal the
  page provoked is the delete gate's own 409. Screenshots in `docs/reports/assets/initiative-tags-1.183.0/`.
- The full suite, in two halves (`--test-concurrency=4 --test-timeout=60000`): half A 2088 tests, 2075 pass, 9 fail;
  half B 1918 tests, 1903 pass, 15 fail (four chunks, because this host stalls over ~430 files and half B's third chunk
  printed its complete 722/714/8 block and then refused to exit - the known `test/worktree-assistant.test.js` handle).
  24 failures in all, every one re-checked against a `git archive` of the base commit `151d0e66` on this host, where
  the same tests fail: the initiatives/waves settings read, the waves route's lane, the waves write route, the tree
  cache boot, the paths seed key (`pipelineBundleSeedFile`), the harness wiring (`verify-wave-file-exists.mjs`), the
  junctioned `node_modules` walk, the clean-scratch HTTP route, the gateway permissions press, and the slow
  scan/rebase/round tests. None of them names a file this branch adds or changes.
