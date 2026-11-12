# email-multi

Email REST service: a Jersey/JAX-RS WAR (`email-web`) over `email-service`, with `email-api`, `email-core`,
`email-lib`, `email-dal`, `email-handler`, `email-app` and `email-batch-handler` in `settings.gradle`.

Repository `IT/email-multi` on `git.sefl.com` (host record `sefl-bitbucket`). The default branch is `master`.

## Landing and turnover

Work reaches `master` through a Bitbucket pull request from the turnover branch. The turnover branch in flight is
`20261023_1120_DMR-41419_sefreightBizParity`, carried by PR #9.

**One worktree per rollup, cut from the turnover branch.** A rollup is a change set rolled up into the turnover
branch; it gets its own tree cut from `20261023_1120_DMR-41419_sefreightBizParity`, never the shared
`work-on-the-first-branch-55f84d` tree. That tree carries the turnover branch's own work (its branch
`wtgui/work-on-the-first-branch-55f84d` tracks `origin/20261023_1120_DMR-41419_sefreightBizParity`), so a rollup
started there shares an index with work already in flight and its fast-forward cannot be made twice.

| rollup | worktree | branch | PR | proof |
|---|---|---|---|---|
| Angus mail change set (DMR-41419) | `implement-this-plan-incr-fb6b1a` | `20261023_1120_DMR-41419_sefreightBizParity` | #9 | `1ee05bfa04f4099032d65a9eedd1cfe3ba80e9b8` |

The proof, recorded 2026-11-09: `git ls-remote origin refs/heads/20261023_1120_DMR-41419_sefreightBizParity` read
`1ee05bfa04f4099032d65a9eedd1cfe3ba80e9b8`; the local branch in `implement-this-plan-incr-fb6b1a` was at `d8280f9`
and was fast-forwarded to that sha with `git merge --ff-only origin/20261023_1120_DMR-41419_sefreightBizParity`,
after which the tree read clean.

## Deployment

| step | command | note |
|---|---|---|
| build the WAR | `./gradlew :email-web:build -x test` | the artifact is `email-web/build/libs/email-web-<version>.war` |
| start the local container | `./gradlew :email-web:startTestContainer` | container `email-web-apache-tomcat`, Tomcat on `http://localhost:8080` |
| stop the local container | `./gradlew :email-web:stopTestContainer` | |

A container can get stuck serving a stale exploded WAR: delete `/usr/share/tomcat/webapps/email-web/` inside it
and restart Tomcat. Jenkins has no Docker and runs `integrationTest`; the Docker-backed endpoint tests are
`src/manualTest` and are run by hand.

## Testing

| command | covers | needs |
|---|---|---|
| `./gradlew :email-service:test` | unit tests | nothing |
| `./gradlew :email-service:integrationTest` | integration tests | real Oracle, Kafka and SMTP; no Docker, so Jenkins can run it |
| `./gradlew :email-service:manualTest` | `ManualTest_EmailService_Endpoints` against a live endpoint | the local container up |
| `./gradlew :email-lib:manualTest --tests "*<ClassName>*"` | one manual test class | whatever that class needs |

### Running commands

These apply to every terminal call a worker makes here, not only to the tests above.

- Never poll a build inside one terminal call. Make ONE bounded request per call (`curl -m 8`), print the build state, and either re-check on the next turn or hand the wait to a background process or the panel's watcher. A sleep-poll loop is what turned a 1 s request into a measured 152.2 s call.
- Do not wrap a command in `bash -lc` when the binary can be run directly: login-shell startup costs 1,616 ms on this host against 115 ms for the command itself, and 3,060 ms inside an already-running MSYS shell.
- Bound every remote read: `--request-timeout 8` to `10` s on kubectl and `-m 8` to `10` on curl, not 30 to 60.
- Leave the pre-execution guard alone: its steady state is sub-millisecond per call, and its 30 s is a fail-closed ceiling, not a cost. Do not edit `terminal_tool.py` to make a call faster.
- On this host `jenkins.prog.sefl.com` and `cscvk3smgmt.prog.sefl.com` currently fail DNS with `no such host` in 0.4 to 0.6 s. Read the resolver error before blaming your command.

### Showing the reader a page

- A page is proved by a test or a headless capture, never by a browser window thrown at the reader.
- A page the reader has to look at goes through the panel's own open route (`POST /api/open-file`, or the anchor a
  clarify card draws) or one plain tab. No `--new-window`, and never a scratch `--user-data-dir` of your own.
- A scratch-profile browser you start is closed before the run settles, or reused for the next page. Nothing you
  launched may still be running when the turn ends.

## Runtime and config

The public prefix is not the Tomcat context: Apache rewrites `/email-service/...` to `/email-web/api/...`, so
`POST /email-service/que` is the same resource as `POST http://<tomcat>:8080/email-web/api/que`.

| environment | base URL |
|---|---|
| local | `http://localhost:8080/email-web` |
| prog | `https://emailservice.prog.sefl.com` |
| prod | `https://emailservice.sefl.com` |

- `POST /que` writes an `EMAIL_QUE` row (platform `K`) for the Kubernetes dispatch handler; `POST /que/bypass`
  sends immediately and is the endpoint to use when queued delivery is impacted; `POST /email` is deprecated but
  shares the same immediate-send handler.
- The OpenAPI document is `https://emailservice.prog.sefl.com/email-service/openapi.json` through Apache, or
  `/email-web/api/openapi.json` Tomcat-direct. `swagger-ui.html` fetches the Apache path, so it 404s when served
  from `:8080` and asked for the spec.
- `email_att` no longer carries `IMAGE_UNIQUE_ID`, `IMAGE_TYPE` or `IMAGE_DOMAIN`; the live column list and the
  dev Oracle coordinates are in the project's own `.kilo/PROJECT-CONTEXT.md`.
