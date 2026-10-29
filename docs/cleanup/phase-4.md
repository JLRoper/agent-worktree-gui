# Phase 4 — the remaining libs

Status: pending. Last, and deliberately so: every item here is a split, and a split done before
the correctness work lands would move the code the fixes point at.

- [ ] **C — `lib/jobs.js` → three modules** (1,988 lines now, review said 622): `lib/hermes-cli.js`
      (argv/env/binary contract), `lib/job-stream.js` (ANSI, `parseLine`, the paragraph-merging
      `push` — pure, and the single most intricate function in the repo), `lib/job-store.js`
      (persistence + labels), leaving `lib/jobs.js` as the runner. #10's tests then cover the
      stream without a class.
- [ ] **D — `lib/activity.js` → probes** (`probes/{ports,pids,board,memo}.js`,
      `hermes/sessions.js` for both sqlite reads + attribution, `signals.js` for the composite).
      Keep `memo`: the single-flight promise sharing is what stopped the ~100-process `tasklist`
      storm and must not be lost in the move.
- [ ] **E — `lib/verdict.js`.** Verdict policy is spread over `lib/scan.js` (classification),
      `lib/store.js` `putRow` (fast-merge rules) and `lib/scheduler.js` `intervalFor` (staleness).
      A store that owns classification policy is where the next verdict bug hides. After this,
      `tools/verify-verdicts.mjs` validates one module.
- [ ] **F — the click-handler table.** 28 `closest()` branches in one delegated listener, ordered
      semantically (controls before the head-fold guard). Replace with a table walked once per
      click; the fold guard stays last, as data. Do this last — every branch needs a judgement.
- [ ] **G — the written contract.** `lib/contract.js` with JSDoc typedefs for `Job`, `Row`,
      `Project`, `Snapshot`, imported type-only by both sides. Optional later: `tsc --checkJs
      --noEmit`, still no runtime dependency.

Do not "fix": `public/style.css` (cascade order is load-bearing), `lib/pool.js`,
`lib/approvals.js`, `lib/project.js`, `lib/scan-worker.js`, or the measured performance work
(single-flight `memo`, gzip, signature-guarded re-render, SSE overlay, tiered scan cadence).

Blocked by: Phases 1–3, and by any in-flight feature in `lib/jobs.js`.
