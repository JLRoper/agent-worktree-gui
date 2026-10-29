# What “N lines hidden — click to read” means

Investigation of the tool-output notices shown in the supplied screenshot, against source snapshot
`fdc13c40b413c8ed918f4a309775b939677d0eac`. This change documents existing behavior; it changes no runtime code.

## Answer

Yes: each notice refers to the same tool result as the preview box immediately above it. However, N is the number
of additional output lines omitted after the retained preview, not the number hidden by collapsing that box.

The screenshot shows three `skill_view output` boxes with `40 lines` in their headers. Under the normal panel fold:

| Preview lines | Notice | Preview plus omitted lines |
|---|---|---|
| 40 | 24 lines hidden | 64 |
| 40 | 63 lines hidden | 103 |
| 40 | 30 lines hidden | 70 |

These are logical output-text lines, not wrapped screen rows. The totals above explain the displayed counters;
the original session-store rows from the screenshot were not inspected.

## Two controls with the same “click to read” wording

The box header toggles the visibility of text already held in that box. On a long result, that is the first
40 lines, not the complete result. Opening the header does not fetch the hidden tail.

The separate note under the box fetches the complete stored text of that result, including the first 40 lines,
not just the omitted tail. It identifies one result by turn, tool and row, requests `full=1`, and does not rerun
the tool. The route lifts its usual 6,000-character display cap for this request.

For the retained-preview path shown here, the renderer leaves the original preview box alone and replaces the note
with a second, expanded box labeled `skill_view output · full result`. The original box does not actually unfold
or acquire extra lines. If both boxes are open, the first 40 lines appear in both. The visible card therefore grows,
although its underlying console ring buffer is unchanged. The full-result box can be folded separately.

There is also a stored-result fallback for an empty live preview; that path can replace its capped stored preview
with the full result. It should not be confused with the retained live-preview path above.

## Code evidence

| Responsibility | Source at the investigation snapshot |
|---|---|
| Keep 40 lines, shorten preview lines at 400 characters, count the omitted lines, and stamp the result identity | [lib/jobs/console-lines.js](../lib/jobs/console-lines.js), lines 16–17 and 62–92 |
| Draw the notice outside the preview, with its turn/tool/row on the button | [public/core/console-format.js](../public/core/console-format.js), lines 425–436 and 568–584 |
| Fetch one stored row on a notice click | [public/app.js](../public/app.js), lines 1577–1633 and 13417–13425 |
| Retain the preview and append the full-result box where the note was | [public/app.js](../public/app.js), lines 2075–2091 |
| Draw fetched results open and label them “full result” | [public/app.js](../public/app.js), lines 1439–1447; [public/core/console-format.js](../public/core/console-format.js), lines 611–623 and 677–683 |
| Empty-preview stored fallback uses the whole result once fetched | [public/app.js](../public/app.js), lines 1957–1966 and 2092–2095 |
| Select one row and disable the store reader’s display cap | [server.js](../server.js), lines 2959–2982; [lib/tool-results.js](../lib/tool-results.js), lines 21–58 |
| Box-header click only toggles visibility and remembered fold state | [public/app.js](../public/app.js), lines 13465–13493 |

## Verification

`node --test test/console-output-box.test.js`: 19 tests passed, 0 failed.

`FOLD_NOTE_PHASES=jobs node tools/verify-fold-note-parity.mjs`: 12 checks passed. This executes the server’s
result counter and the real SQLite store reader; the browser phase was deliberately not run.

A Node VM probe loaded the shipped console renderer plus the actual `toolGroupHtml` and `expandToolFold` source,
with a fixture store response. All six cases passed: 64-, 103- and 70-line results in condensed and one-stream
modes. Each began with one folded 40-line box; after the notice click each had the unchanged folded 40-line box
and a separate open full-result box of the corresponding total. Each request named one row with `full=1&n=1`,
the note disappeared, and the input console buffer was unchanged. This was a source-level execution, not a browser
or a measurement of the user’s live panel.

`npm test`: 380 tests passed, 0 failed. No live panel was restarted or modified.
