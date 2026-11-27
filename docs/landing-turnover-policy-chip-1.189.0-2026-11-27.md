# Landing note - the turnover policy select (1.189.0)

## What the reader gets

The project head line's turnover chip opens a bar that already named the branch and the base-ref kind. It now carries
the project's **turnoverPolicy** as a third control, between the kind and the branch: `free`, `ask` or
`one-per-feature`, each drawn with the words `GET /api/project-turnover` answers in `policyLabels`, with the project's
current value selected. Picking a policy saves it at once; there is no save button to press for a one-word answer.

- `public/board-scaffold.js` - `turnoverPolicies`, `turnoverPolicyFor`, `turnoverPolicyLabel`, `turnoverPolicyLine`,
  the select in `turnoverBarHtml`, the read's `policies` / `policyLabels` kept in `state`, and
  `saveProjectTurnoverPolicy`.
- `public/app.js` - the change listener that saves `[data-turnover-policy]`, and the two state keys.
- `public/style.css` - the policy label joins the kind's row rule; its select gets room for the longest label.

## The wire shape, measured

The route accepts a POLICY-ONLY save, so the change sends exactly `{ project, turnoverPolicy }` and no branch list:
`routes/project-turnover.js` treats `turnoverPolicy` as a save of its own and `setProjectTurnover` takes `value ===
undefined` as "leave the branches exactly as they are". Sending `turnoverBranches` unchanged beside it would be a
second copy of the list to validate, and a list save is the path that parks a permission card under `ask` - a policy
is not a branch creation.

The gate asserts the request body the browser actually sent, and reads the list back from both the route and
`config.json` on disk after the change, key included.

## The gate

```
PANEL_SHOTS_DIR=docs/assets/turnover-policy-bar node tools/verify-turnover-policy.mjs
turnover policy: 57 of 57 checks passed; 3 shot(s)
```

What it covers: three projects (free, ask, one-per-feature), the read's own labels and selected value in each; a fake
read whose different labels and value are drawn as answered; the change's POST body; a fake 200 answering `ask` to a
`free` pick, drawn as ask (the redraw comes from the answer, not the pick); a 400 whose sentence - the real route's
own `turnoverPolicy must be one of free, ask, one-per-feature` - is drawn verbatim in the error style while the select
stays on the server's value; the branch list unchanged in the route answer and in the file; and no page errors.

Screenshots, 1440x1100, the chip row and its bar:

- `docs/assets/turnover-policy-bar/turnover-policy-before.png` - alpha's bar on `free`, label and branch beside it.
- `docs/assets/turnover-policy-bar/turnover-policy-after.png` - the same row after the change, on `one per feature`,
  with the bar's line naming the policy it now holds.
- `docs/assets/turnover-policy-bar/turnover-policy-refusal.png` - the 400's sentence in red, branch still shown.

## Focused tests

`node --test` over the files that name or import `public/board-scaffold.js`:

- `board-lookups`, `turnover-row-marker`, `row-chips`, `chart-columns` - 60 pass, 0 fail.
- `cleanup-chip`, `cleanup-drop-all`, `hot-mark`, `review-lane` - 45 pass, 0 fail.
- `console-memory-bounds`, `focus-mode`, `reasoning-delta-pane` - 50 pass, 0 fail.

`test/worktree-assistant.test.js` carries 3 failures and does not return, on this base as on `origin/main` (recorded in
`docs/reports/console-corner-second-defect-2026-11-26.html` and `docs/reports/search-popover-anchor-2026-11-27.html`);
it names no file this landing touches.

## Landing shape

This tree is a child of the local-only turnover branch `20261127_1422_TASK-371_build-the-initiative-tag`. The LANDING
rule for the tree says: merge into that branch LOCALLY, do not push, do not open a pull request, and leave the base
where it is. Version 1.189.0 (minor - a new reader-facing affordance), anchored by a local annotated `v1.189.0` tag on
its bump commit; no tag or changelog is pushed while the base itself has not landed.
