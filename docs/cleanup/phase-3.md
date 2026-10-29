# Phase 3 — client structure

Status: pending. `public/app.js` is 11,710 lines now (the review sized it at 3,389), and it is
still one classic script with one mutable `state` object and no modules.

- [ ] **A — native ES modules, leaf first, move-only commits.** `js/state.js`, `js/format.js`,
      `js/paths.js` (the same file as `public/shared/paths.js` from #6), `js/storage.js`,
      `js/api.js`, `js/html.js`, then `js/render/*`, then `js/events.js`, `js/settings.js`,
      `js/main.js`. One `<script type="module" src="/js/main.js">`. No bundler, no transpiler.
      Order matters: leaves first so every commit is reviewable on its own.
- [ ] **#5a — the escaping `html` template.** One tagged template that escapes by default and
      takes `raw()` as the explicit opt-out; it replaces ~30 hand-written `esc(...)` sites. No
      escaping hole was found — this is prevention, not a patch.
- [ ] **#5b — `paintCard(thread, viewModel)`** for agent cards, diffing a view model instead of
      re-serialising HTML. This is what removes `conversationSignature`'s hand-maintained field
      list, and with it the class of bug the rename feature already hit once.

Blocked by: Phase 1's #6 (the shared paths module) and #2 (the fetch wrapper, which is the thing
`js/api.js` is extracted from). Do not start the render layers until the leaves are moved.
