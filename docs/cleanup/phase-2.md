# Phase 2 — server structure

Status: blocked on the current feature work in `server.js`. The review is explicit: do not begin
this while a feature is mid-flight in that file, because a route-table refactor interleaved with a
feature produces a diff nobody can review.

- [ ] **#4, route-table form.** `HttpError` already exists (Phase 0) so the outer catch is honest;
      this phase moves the decision to every route. Each route declares `auth = true` by default,
      which is what makes #3 structural instead of four remembered lines.
- [ ] **#3, fixed by design.** No route can forget `authorised(req)` because no route calls it by
      hand any more.
- [ ] **B — the split.** `lib/http.js` (`sendJson`/gzip, `readBody`, `staticFile`, `HttpError`),
      `lib/live.js` (SSE clients, `broadcast`, `handleStream`, `snapshot`, `withLiveAgents`),
      `lib/routes/{state,agents,jobs,repos,approvals}.js`, and `server.js` down to imports,
      construct, wire, listen.
      *Drift:* the review sized `server.js` at 659 lines with 22 route checks. It is 1,960 lines
      with 66 checks now, so the split is ~3× the work it describes. Re-plan before starting.

Invariant to keep: GETs stay unauthenticated on loopback. The problem was never that GETs are
open; it is that the decision was made per route by omission.

Blocked by: Phase 1 (#7 in particular — the composition-root ordering is the seam the split
cuts along) and the end of the current `server.js` feature.
