// Static + JSON + SSE server for the worktree monitor, plus Stage-1 agent spawning.
// The HTTP layer never runs git: the scheduler scans in worker threads and the
// store holds the results. Spawned agents go through lib/jobs.js.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
// The push-guard record is a few hundred bytes read at boot and written on an install: sync is the honest shape
// for it, and it is the same file the Settings row reports from.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { cpus, homedir, tmpdir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { Pool } from "./lib/pool.js";
// Every helper process this panel starts is registered here: it carries a hard ceiling and dies with its
// scope (a job that settled, a scan, the panel on the way out). See lib/child-tree.js for the leak it ends.
import { panelChildren } from "./lib/child-tree.js";
import { portHolder, refusalLine } from "./lib/port-guard.js";
import { worktreeList, prIndex, prFor } from "./lib/project.js";
import { Store } from "./lib/store.js";
import { Scheduler } from "./lib/scheduler.js";
import { ProjectRegistry } from "./lib/projects.js";
// isLiveJobStatus is main's: the 429 hold asks whether a card's run is live before it re-arms the timer.
// previewRequest is not: this commit moves both previewRequest call sites into lib/features/spawn.js, so
// server.js has no use for the name any more — the import keeps their new name and drops the moved one.
import { Jobs, RELEASE_BRIEF, hermesHome, isLiveJobStatus, makeThreadName } from "./lib/jobs.js";
import { gitIn, scanWorktree, setChildTracker } from "./lib/scan.js";
// "Is this directory a tree of its own?" — asked before a reply is started, because a released tree's leftover
// folder answers every `git` call from the project's primary checkout.
import { replyTree } from "./lib/own-tree.js";
import { mergeLabel, mergePrompt } from "./lib/merge-prompt.js";
import { verifyLabel, verifyPrompt } from "./lib/verify-prompt.js";
import { answerDeletes, answerLine, answeredChecks } from "./lib/verify-landed.js";
import { deleteWorktreeRow } from "./lib/worktree-remove.js";
import { ReleaseRequests, agentCleanupFrom, releaseWorktree, releasesEnabled } from "./lib/worktrees.js";
import { Deliverables } from "./lib/deliverables.js";
import { Hosts, docOf, prListing, proposeMapping, renderTemplate } from "./lib/hosts.js";
// What a worktree is FOR: the definition catalogue (reader-edited over the shipped seed), where each tree stands in
// one, and the ladder that is the only way a tree's kind may change (docs/pipelines.md §1–§3).
import { PIPELINES_VERSION, PIPELINE_KINDS, EXIT_CHECKS, Pipelines, PipelineRecords, presumedPipeline, changePipeline, storeSwitch, validatePipelinesDocument, readPipelinesFile, observeGithubPr, observeBitbucketPr } from "./lib/pipelines.js";
import { TreeNames, describeNaming, tagOf, treeKey, autoNameRefusal, namingState, renameRefusal } from "./lib/tree-names.js";
// One slug rule for a tree's name, shared by the cut (lib/jobs.js `makeWorktree`) and the rename here, so a tree
// cut for a task and a tree renamed after it are spelled the same way: whole words, cut between them.
import { treeSlug } from "./lib/tree-slug.js";
import { WorktreeNaming } from "./lib/worktree-naming.js";
import { DEFAULT_OWNER, Locks, describeLock, rebaseKey, writerLocks } from "./lib/locks.js";
import { rebaseWorktree } from "./lib/rebase.js";
import { ownCopyOf } from "./lib/sync-state.js";
import { DEFAULT_HIDDEN_COLUMNS, chartColumnsFrom } from "./lib/chart-columns.js";
import { createDescriptions } from "./lib/features/descriptions.js";
import { TodoLists, todoSummary } from "./lib/todos.js";import { auditRepo } from "./lib/hermes-worktrees.js";
import { REFRESH_LINES_SHOWN, RefreshJournal, liveRunIn, mergeDelta, normaliseRefreshAgent, parseCommitFiles, todoProposals } from "./lib/refresh-row.js";
import { ParentBook } from "./lib/parents.js";
import { cutChildWorktree } from "./lib/child-worktree.js";
import { Questions, applyPlan, buildPlan, inspectProject, parentWorktreeOf, readPlan, rollGate, rollUp, worktrees as stewardWorktrees, writePlan } from "./lib/steward.js";
import { REASON_REQUIRED, RestartController, providerKeyCheck } from "./lib/restart.js";
import { readPipelineDocument } from "./lib/pipeline-doc.js";
import { Approvals } from "./lib/approvals.js";
import { RemoteWrites, POLICIES, DEFAULT_POLICY, policyFrom, policyForProject, policyLabel, allowPushWithoutAskingFor } from "./lib/remote-writes.js";
import {
  PUSH_CHOICES,
  PUSH_CHOICE_LABELS,
  PUSH_REPOS,
  PUSH_REPO_KEYS,
  DEFAULT_PUSH_CHOICE,
  pushChoiceFrom,
  projectPushRow,
  resolvePushPermissions,
  pushModeFor,
  permissionForPush,
  branchesInPushRefs,
  branchPermission,
  strictestPermission,
  repoKeyForProject,
  legacyDefaults,
} from "./lib/push-permissions.js";
import { installGuard, uninstallGuard, guardState, refreshGuardFiles, normTree } from "./lib/push-guard.js";
import { safeUrl, openerFor, openerForFolder, chromeFor } from "./lib/open-url.js";
import { errorStatus } from "./lib/errors.js";
import { readSkillsIndex } from "./lib/skills.js";
// The Matrix bridge's process lifecycle (start / stop / liveness / one --self-test). The protocol itself is the
// standalone Python program's; this module only ever owns a child process, its pid file and its log.
import { MatrixBridge, matrixBlock, matrixConfig, matrixPatchFrom } from "./lib/matrix-bridge.js";
// The Bridge tab's policy: one markdown file in the panel's state folder, served at /api/matrix/policy and
// carried into the bridge turn by the next reader. It is NOT bridge.env and never sits beside the script.
import { MatrixPolicyStore, matrixPolicyTemplate } from "./lib/matrix-policy.js";
// The bridge's OWN reminders, and the assistants' watches as a READ-ONLY projection of them. The list is the
// panel's (`matrix-reminders.json`); the bridge reads it over GET and carries it into the turn, and the POST route
// here can add, complete, re-word and delete a reminder but can never write a watch (lib/matrix-reminders.js
// `apply` refuses those keys before it touches the file).
import { MatrixRemindersStore } from "./lib/matrix-reminders.js";
import { readPermissions } from "./lib/gateway-permissions.js";
import {
  approvalState, writeApprovalTimeout, APPROVAL_TIMEOUT_MIN, APPROVAL_TIMEOUT_MAX,
  clarifyWindowSeconds, approvalWindowSeconds,
  sessionSettings, writeSessionListLimit, SESSION_LIST_MIN, SESSION_LIST_MAX,
  providerState, writeProviderSettings,
} from "./lib/hermes-config.js";
// The named (URL, key) pairs the Gateway tab applies. The store lives in the panel's state folder and its keys
// never leave this process: Apply reads one here and hands it straight to writeProviderSettings above.
import { listProfiles, saveProfile, deleteProfile, profileWithKey } from "./lib/provider-profiles.js";
import { hermesSessionTail } from "./lib/activity.js";
import { Assistant, ASSISTANT_THREAD, ElementChannel, createBridgeChannel } from "./lib/assistant.js";
// The per-assistant task queue's prefix, cut into routes/ (step 8 of docs/reports/module-map-2026-11-07.html). One
// import and one row in the mount table: the module owns the routes and the wire shape, the Assistant owns the file
// path and the read-modify-write, and this composition root only hands both of them the transport helpers.
import { QUEUE_PATH, createQueueRoutes } from "./routes/assistant-queue.js";
// The delete control's one write: a dry run that names what would go, and the real press that archives the
// assistant and takes it out of the roster. The module owns the refusals and the archive; this file only mounts it.
import { DELETE_PATH, createDeleteRoutes } from "./routes/assistant-delete.js";
// The ticket watch's one route: a door onto `assistant.wake` for the cron poller, which lives outside this process.
import { createTicketWatchRoutes } from "./lib/ticket-watch.js";
// The assistant reset: settle an unknown admission through the gateway, then drop this assistant's queued wakes and
// its own watches. Endpoint only — the control that will press it is a separate change. Mounted beside the queue's
// routes because it is the same assistant's control plane, and the module owns the path match, the refusals and the
// wire envelope.
import { createResetRoutes } from "./lib/assistant/reset.js";
// The task pipeline window's read: a queue row's stages, its current one and the gate that ended the one before it.
// Mounted beside the queue's own routes because it is the same record, read one stage deeper.
import { createPipelineWindowRoutes } from "./lib/pipeline-window.js";
// The pipelines a window's assignment control may offer, read from the same bundle. A read, mounted beside the window.
import { createPipelineCatalogueRoutes } from "./lib/task-pipeline-assign.js";
import { pipelineSourceCatalogue } from "./lib/pipeline-source.js";
// Importing a studio export into that bundle: an APPEND by pipeline id, refusing a duplicate id by name. The write side
// of the loader, mounted with the two reads because all three answer about the one file.
import { createPipelineBundleImportRoutes } from "./lib/pipeline-bundle-import.js";
import { childTranscript, collectPrompt, subagentsFor, subagentRoster } from "./lib/subagents.js";
import { thinkingFor } from "./lib/thinking.js";
import { modelCatalogue, refreshModelCatalogue } from "./lib/hermes-models.js";
import { createSpawn } from "./lib/features/spawn.js";
// What a failed gateway probe MEANS: one sentence, keyed on whether there was a status code, a transport
// error, or no answer at all (a timeout). The spawn card and the two run-start routes quote the same text.
import { gatewayRefusalText } from "./lib/gateway-refusal.js";
// The panel's own directories, and every state path derived from them. Nothing below builds one of those
// paths itself any more: `resolveDirs` answers where, `statePaths` answers which file.
import {
  cleanScratch, ensureDirs, humanBytes, measureSize, migrateState, readMigrationJournal, resolveConfigPath, resolveDirs,
  SCRATCH_MARKER, sizeOf, statePaths,
} from "./lib/paths.js";
// HTTP framing lives in lib/http/: respond.js writes the answer and reads the body, transport.js
// decides who may write and attaches the SSE reader, and static.js serves public/. All three are
// handed the state they used to read by closure.
import { authorised, handleStream, pageCaller } from "./lib/http/transport.js";
import { acceptsGzip, gzip, readBody, readRawBody, sendJson } from "./lib/http/respond.js";
import { serveStatic, PUBLIC_DIR } from "./lib/http/static.js";
import { createBuild } from "./lib/build-version.js";
// The steer refusal's own vocabulary: the page draws its control from this same file, so the route's status split
// and the card's button can never disagree about which of the three refusals happened.
import "./public/core/steerable.js";

const { PARKED: STEER_PARKED, PAST_BOUNDARY: STEER_PAST_BOUNDARY, GONE: STEER_GONE } = globalThis.wtSteerable;

// A file an agent produced is meant to be OPENED, and the shell association may hand a .md to a
// browser. Prefer a text editor: Notepad++ when installed, else Windows' notepad (always present),
// else the platform's text opener. Resolved once — the answer cannot change while the panel runs.
let editorResolver = null;
async function editorFor(target) {
  if (!editorResolver) {
    if (process.platform === "win32") {
      let bin = "notepad.exe";
      let base = [];
      for (const candidate of [
        "C:/Program Files/Notepad++/notepad++.exe",
        "C:/Program Files (x86)/Notepad++/notepad++.exe",
      ]) {
        const isFile = await stat(candidate).then((s) => s.isFile()).catch(() => false);
        if (isFile) {
          bin = candidate;
          break;
        }
      }
      editorResolver = (t) => [bin, [...base, t]];
    } else if (process.platform === "darwin") {
      editorResolver = (t) => ["open", ["-t", t]];
    } else {
      editorResolver = (t) => ["xdg-open", [t]];
    }
  }
  return editorResolver(target);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The vendored mermaid, read once: the flow dialog's Preview is the only reader, and a 2.5 MB file per open would be
// a disk read for bytes that cannot change while the process runs (an upgrade is a new file and a restart).
let MERMAID_ASSET = null;
// The panel's git/gh helpers. Same call shape as `promisify(execFile)`, but tracked: the child is in the
// registry, its timeout is a CEILING for its kind, and the deadline kills the tree rather than the one pid
// — which is what stops a push's pre-push hook (a changelog check taking minutes) outliving the push.
const execP = (bin, args, opts = {}) => panelChildren.exec("panel", bin, args, opts);
// The panel's version is declared once, in package.json: read it here so the page can say which
// build is running without a second copy to keep in step.
const VERSION = await readFile(path.join(HERE, "package.json"), "utf8")
  .then((t) => JSON.parse(t).version || null)
  .catch(() => null);
// The version the CHECKOUT carries NOW, re-read on every request. `VERSION` above is what this process serves and never
// moves; this is what a restart would put into service, and the two being equal is the only "a bounce for nothing".
const packageVersion = () => {
  try {
    return JSON.parse(readFileSync(path.join(HERE, "package.json"), "utf8")).version || null;
  } catch {
    return null;
  }
};

// ---- the checkout's own changelog -------------------------------------------------------------
// Settings → Updates answers "what changed since the build I am running?" from CHANGELOG.md at the panel
// root — the file `npm run changelog` renders from the tags. The file is ~230 KB and the tab draws ten
// releases, so the read stops at the (limit + 1)th release heading: everything below it is history the
// answer would throw away, and a panel that restarted should not parse 251 releases to draw ten.
const CHANGELOG_FILE = "CHANGELOG.md";
const CHANGELOG_DEFAULT = 10;
const CHANGELOG_MAX = 50;
// The one shape `tools/changelog.mjs` writes, and the only one this parses. A file of prose carries no
// heading and is answered as EMPTY, never as a blank box: the two states mean different things to a reader.
const CHANGELOG_HEADING = /^##\s+v(\d+\.\d+\.\d+)\s+—\s+(\d{4}-\d{2}-\d{2})\s+·\s+(\d+)\s+commits?\s*$/;
const CHANGELOG_CHUNK = 64 * 1024;

// A limit the tab asked for: absent is the default, an unreadable one is the default too (never 0, which
// would draw an empty box and read exactly like a file with nothing in it), and past the cap is the cap.
function changelogLimitFrom(value) {
  const raw = value == null ? "" : String(value).trim();
  if (!raw) return CHANGELOG_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return CHANGELOG_DEFAULT;
  return Math.min(CHANGELOG_MAX, Math.max(1, Math.trunc(n)));
}

// Read only the head of the file, in 64 KiB reads. The count is taken over what has arrived so far, so a
// heading split across a chunk boundary is counted one read later — the stop is never EARLIER than the
// (limit + 1)th heading, which is the only direction that matters here.
async function readChangelogHead(file, limit, size) {
  const handle = await open(file, "r");
  try {
    const decoder = new StringDecoder("utf8");
    const buf = Buffer.alloc(CHANGELOG_CHUNK);
    let text = "";
    let read = 0;
    while (read < size) {
      const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, size - read), read);
      if (!bytesRead) break;
      read += bytesRead;
      text += decoder.write(buf.subarray(0, bytesRead));
      if ((text.match(/^##\s+v/gm) || []).length > limit) break;
    }
    return text + decoder.end();
  } finally {
    await handle.close();
  }
}

// One release's body as the tab draws it: the group headings and the bullets, with the commit link's
// markdown reduced to the short sha a reader can say out loud. The sha/compare line immediately under the
// heading is metadata for GitHub's web view, not something the panel repeats.
function changelogBodyLines(body) {
  const out = [];
  for (const raw of body) {
    const line = raw.trim();
    if (!line || line.startsWith("[`")) continue;
    if (line.startsWith("### ")) {
      out.push(`### ${line.slice(4).trim()}`);
      continue;
    }
    if (!/^[-*]\s+/.test(line)) continue;
    out.push(`- ${line.replace(/^[-*]\s+/, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/`/g, "")}`);
  }
  return out;
}

// Newest-first, because the file is written that way and a reader wants the top: the first heading is the
// release the panel serves, the ones below it are what it replaced.
function parseChangelogSections(text, limit) {
  const sections = [];
  let current = null;
  for (const line of text.split("\n")) {
    const heading = CHANGELOG_HEADING.exec(line);
    if (heading) {
      if (current) sections.push(current);
      if (sections.length >= limit) {
        current = null;
        break;
      }
      current = { version: heading[1], date: heading[2], commits: Number(heading[3]), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) sections.push(current);
  return sections.slice(0, limit).map((section) => ({ ...section, lines: changelogBodyLines(section.lines) }));
}
// PANEL_CONFIG lets a second instance run from the same code with its own config and port —
// a sandbox or a demo you can click around in without touching the real one:
//   set PANEL_CONFIG=C:\path\to\panel-config.json && node server.js
//
// Otherwise the file has two homes, and lib/paths.js decides between them: `<dataDir>/config.json` when an
// install has been moved there, else `config.json` beside this checkout — so an existing install keeps
// running untouched, and moving the file is what opts into the new home.
const CONFIG_FILE = resolveConfigPath({ here: HERE });
const CONFIG_PATH = CONFIG_FILE.path;
// The folder the config was read from. It is a PROTECTED path (the clean route must never empty it) and the place a
// second instance keeps its own files, never a place to derive a state file from: that is lib/paths.js's job, and a
// guard in test/paths.test.js fails on any other `path.dirname(CONFIG_PATH)`.
const CONFIG_DIR = path.dirname(CONFIG_PATH);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
// The child supervisor writes through the panel's own log, so a killed helper is one line beside every other
// boot/shutdown line rather than a second stream.
panelChildren.setLog((line) => log(line));
// scan.js runs in worker threads AND here (the board's own reads call scanWorktree directly). The workers set
// their own per-scan tracker; this thread's reads belong to the panel's list, so a shutdown kills them.
setChildTracker(panelChildren, "panel");

// The versioned static bundle: one hash over everything the shell loads, computed here at boot and
// re-read when a file under public/ moves. The shell's asset URLs carry it and GET /api/build
// answers with it — that is how a tab open since yesterday learns the panel changed.
const build = createBuild({ publicDir: PUBLIC_DIR, log });
const buildAtBoot = await build.current();

// The folder a panel with no named scan roots looks at: its own parent, so a bare clone is immediately useful and an
// emptied list still shows a board instead of nothing. Settings → Board writes `scanRoots`; this is what an empty
// list means, and the tab says so rather than leaving a blank board unexplained.
const DEFAULT_SCAN_ROOT = path.dirname(HERE);

// The one normalisation every root goes through — config.json, the write route and discovery all have to agree on
// what "the same folder" is, or a list saved with a trailing slash and checked without one is two roots. Repeated
// slashes are collapsed too (a typed path can carry `//`), EXCEPT a leading `//`, which is a UNC share and not a typo.
const normRoot = (p) =>
  String(p || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, (m, at) => (at === 0 ? "//" : "/"))
    .replace(/\/+$/, "");

// Which roots the board actually walks, and which the file names. `scanRoots` is the EFFECTIVE list every reader in
// this file already uses (discovery, the clone and new-project routes, the boot sweep), so nothing downstream has to
// learn about the fallback; `scanRootsConfigured` is what config.json says (possibly empty) and `scanRootsFallback`
// is the fact the settings tab needs in order to explain an empty list. Declared above loadConfig's CALL, which is
// the only order that matters: the function body reads them when it runs, not when it is defined.
function applyScanRoots(cfg, roots) {
  const configured = (Array.isArray(roots) ? roots : []).map(normRoot).filter(Boolean);
  cfg.scanRootsConfigured = configured;
  cfg.scanRootsFallback = configured.length === 0;
  cfg.scanRoots = configured.length ? configured : [DEFAULT_SCAN_ROOT];
  return cfg;
}

// How many of a project's worktrees its chart draws on first paint. The top-N projection itself is the client's
// (public/app.js `chartTopOrder`: last activity newest first, then by name), because that is where the rows and their
// activity live; this is only the number, kept in the panel's own config.json so it survives a restart and applies
// to every browser. 0 draws every tree.
//
// A value that cannot be read as a number or a count falls back to the DEFAULT rather than to 0: an unreadable
// number must never silently switch a limit off (and Number(null) is 0, so "absent" is handled first).
const CHART_TOP_DEFAULT = 10;
const CHART_TOP_MAX = 5000;
function chartTopCountFrom(value) {
  if (value == null || value === "") return CHART_TOP_DEFAULT;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return CHART_TOP_DEFAULT;
  return Math.min(CHART_TOP_MAX, Math.round(n));
}

// How long a parent the reader collapsed stays a decision about everything under it before the page writes every
// card inside into its remembered fold set (Settings → Board → Collapse cascade). 0 disables the cascade. An
// unreadable value falls back to the DEFAULT rather than to 0, for the same reason the age threshold does: a typo
// must never silently switch a behaviour off (and Number(null) is 0, so "absent" is handled first).
const COLLAPSE_AFTER_DEFAULT = 30;
const COLLAPSE_AFTER_MAX = 3600;
function collapseAfterSecondsFrom(value) {
  if (value == null || value === "") return COLLAPSE_AFTER_DEFAULT;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return COLLAPSE_AFTER_DEFAULT;
  return Math.min(COLLAPSE_AFTER_MAX, Math.round(n));
}

async function loadConfig() {
  // A fresh clone may have no config.json yet: start on defaults and say so, rather than dying.
  let cfg;
  try {
    cfg = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch (e) {
    log(`no readable config.json (${String((e && e.message) || e)}) — using defaults`);
    // Default to the folder the panel itself sits in, so a bare clone is immediately useful. Written as an empty
    // list so the fallback is one code path: an unreadable file and an emptied list mean the same board.
    cfg = {};
  }
  applyScanRoots(cfg, cfg.scanRoots);
  cfg.port = Number(cfg.port) || 7331;
  // Loopback by default. This panel can now spawn agents, so binding it to the LAN
  // would be unauthenticated remote code execution.
  cfg.host = cfg.host || "127.0.0.1";
  // The token that gates writes from other machines comes from the ENVIRONMENT, never from this file.
  // config.json is tracked by git, so a secret in it is a secret in the repository and in every clone of it.
  // PANEL_TOKEN is read once, at boot; if it is missing or empty there is simply no token, and authorised()
  // then REFUSES every non-loopback write rather than letting one through — the door closes when the variable
  // is absent, it does not open. A leftover "token" key in the file is ignored, loudly, so an old secret cannot
  // look like it is doing something.
  const fileToken = typeof cfg.token === "string" ? cfg.token.trim() : "";
  const envToken = String(process.env.PANEL_TOKEN || "").trim();
  cfg.token = envToken || null;
  if (fileToken) {
    log(envToken
      ? 'config.json still has a "token" key — ignoring it: PANEL_TOKEN from the environment wins, so remove the key from the file'
      : 'config.json has a "token" key but no PANEL_TOKEN in the environment — the file\'s token is IGNORED; set PANEL_TOKEN or writes from other machines stay refused');
  }
  cfg.refreshSeconds = Number(cfg.refreshSeconds ?? 30);
  cfg.worktreeSeconds = Number(cfg.worktreeSeconds ?? 5);
  cfg.midSeconds = Number(cfg.midSeconds ?? 30);
  cfg.dormantSeconds = Number(cfg.dormantSeconds ?? 60);
  cfg.slowSeconds = Number(cfg.slowSeconds ?? 60);
  // How long a parent the reader collapsed stays a decision about everything under it: the page holds one timer per
  // collapsed parent, and when it fires every card under that parent is written into the browser's remembered fold
  // set. Server-side like the age threshold below, so it survives a restart and applies to every browser.
  cfg.collapseAfterSeconds = collapseAfterSecondsFrom(cfg.collapseAfterSeconds);
  cfg.fetchSeconds = Number(cfg.fetchSeconds ?? 600);
  cfg.threads = Number(cfg.threads) || Math.max(1, Math.min(4, cpus().length - 1));
  // How many of a project's worktrees its chart draws before the reader opens the rest. Server-side, like scanMode
  // below: it lives in this file so it survives a restart and applies to every browser. The retired
  // `hideOlderThanDays` is NOT read: a file that still carries it keeps to the default (or its own chartTopCount),
  // never to "0", and the settings sentence names the ignored key so the reader can delete it.
  cfg.chartTopCount = chartTopCountFrom(cfg.chartTopCount);
  cfg.hideOlderDaysIgnored = Object.prototype.hasOwnProperty.call(cfg, "hideOlderThanDays");
  // Which of the worktree chart's columns are drawn, also server-side and for the same reason: the reader can hide a
  // column in any browser and every one of them draws the same chart. The stored value is the columns to HIDE, so a
  // column the page adds later starts visible for a reader who has already hidden some; lib/chart-columns.js drops
  // ids it does not know, so a hand-edited typo cannot quietly hide the wrong cell.
  // A config with NO hidden-columns key has never expressed a preference, so it gets DEFAULT_HIDDEN_COLUMNS — empty
  // today, because the owner column hides itself from the rows (public/app.js `ownerMatters`) rather than from a
  // default. A key that is present (even an empty array) IS a preference and is taken as written. Nothing is written
  // for the default: the file stays keyless until the reader moves a switch, which is what "no record migration"
  // means here.
  cfg.hiddenColumns = cfg.hiddenColumns == null ? DEFAULT_HIDDEN_COLUMNS.slice() : chartColumnsFrom(cfg.hiddenColumns);
  cfg.projects = Array.isArray(cfg.projects) ? cfg.projects : [];
  if (!cfg.defaultCwd) cfg.defaultCwd = cfg.projects[0]?.path || process.cwd();
  // "all": keep every project fresh, whether or not anyone is looking at it. "visible": the page reports which
  // project sections are on screen and only those are re-read - with ~100 projects that is most of the git work
  // the board does. The setting lives in this file so it survives a restart and applies to every browser.
  cfg.scanMode = String(cfg.scanMode || "all").toLowerCase() === "visible" ? "visible" : "all";
  // The two-tier gate (lib/tiers.js). A repo whose last commit is older than `tierDays` stops being polled: it
  // is checked by one signal read once an hour, staggered across the hour in `tierBuckets` slices of
  // `tierCheckSeconds` each, and a change (or the reader opening the project) promotes it for one full probe.
  // The knob that decides a repo is old, and the shape of its hour. They live in config.json so a test can run
  // the rotation on seconds instead of waiting for the wall clock; lib/tiers.js owns the arithmetic.
  cfg.tierDays = Math.max(1, Number(cfg.tierDays) || 7);
  cfg.tierBuckets = Math.max(1, Math.floor(Number(cfg.tierBuckets) || 60));
  cfg.tierCheckSeconds = Math.max(1, Number(cfg.tierCheckSeconds) || 60);
  // Whether an agent may take a tree off this disk by itself once the work has landed: Settings → Board → Agents
  // clean up. It is a VETO above every project, so it can only CLOSE the door — a project still needs its own
  // `releaseWorktrees: true` — and a missing key reads as ON, which is what an install written before this row did.
  cfg.agentCleanup = agentCleanupFrom(cfg.agentCleanup);
  // The Matrix bridge the Gateway tab starts. Paths and a room id ONLY: the password lives in bridge.env beside
  // the script, and neither this server nor the page ever reads that file (lib/matrix-bridge.js states the rule
  // and existsSync is the whole of what it does with the path). A missing block normalises to empty strings, so a
  // fresh clone's tab says "not configured" instead of inventing a path that belongs to one machine.
  cfg.matrix = matrixConfig(cfg.matrix);
  // ---- where the panel keeps things ----------------------------------------------------------------
  // Two directories, resolved once, here, by lib/paths.js — and every state file derived from the data one.
  // This used to be eleven separate `path.dirname(CONFIG_PATH)` lines, which put the job store, the assistant,
  // the TODOs, the naming ledger, the labels and the push-guard record INSIDE the checkout: a fresh clone opened
  // on an empty board, a re-clone lost the history, and `git status` could never be trusted to be about the code.
  //
  // `dataDir` is the durable half (default `~/.wag`), `scratchDir` the throwaway half (default `<os tmpdir>/wag`).
  // Explicit `dataDir` / `scratchDir` keys win, then WAG_HOME / WAG_SCRATCH, then those defaults — and the source
  // of each travels with it, so the Settings row can answer "why is my board empty" without a docs hunt.
  //
  // A config that names one of these files itself still wins (that is how a sandbox points at its own store); the
  // rest follow it, which is the behaviour every existing `PANEL_CONFIG` sandbox relies on.
  //
  // A PANEL_CONFIG instance that names no `dataDir` is a second instance, and it keeps its own folder: it resolves
  // to `<dir of its config>/logs` (flat, as it always did) and ignores WAG_HOME / WAG_SCRATCH. Resolving it to the
  // shared `~/.wag` instead would point every verify tool and test sandbox at the reader's live job store.
  const dirs = resolveDirs({ config: cfg, configSource: CONFIG_FILE.source, configDir: CONFIG_DIR });
  cfg.dataDir = dirs.dataDir;
  cfg.dataDirSource = dirs.dataSource;
  cfg.dataLayout = dirs.dataLayout;
  cfg.scratchDir = dirs.scratchDir;
  cfg.scratchDirSource = dirs.scratchSource;
  Object.assign(cfg, statePaths(cfg));
  // The assistant's `assistant` block is an optional set of knobs (mode, model, rule escalations) that the page can
  // also change at runtime. It is not a path, but it is read by the same callers, so it is resolved here too.
  cfg.assistant = cfg.assistant && typeof cfg.assistant === "object" ? cfg.assistant : {};
  // `assistant.cwd` (lib/assistant.js) defaults to `assistant-cwd` beside `assistantFile`, so it follows this store
  // into the data directory with no extra key: state, not source, and never a folder inside the checkout.
  // The locks, the parent book, the steward's plan files (`stewardDir`) and its questions ledger, the model prices, the
  // push-guard record, the host mappings and the branch-parent ledger are state like everything above: lib/paths.js
  // derives every one of them beside the job store, so they follow it into the data directory.
  // `steward.prodBranch` names the one branch a roll-up must never be done inline: production is handed to a worker
  // (or a TO), never merged by editing a tree. null means this project has no such branch.
  cfg.steward = cfg.steward && typeof cfg.steward === "object" ? cfg.steward : {};
  if (!("prodBranch" in cfg.steward)) cfg.steward.prodBranch = null;
  cfg.stewardRefreshSeconds = Number(cfg.stewardRefreshSeconds) > 0 ? Number(cfg.stewardRefreshSeconds) : 300;
  // Where each project's branches and pull requests live (lib/hosts.js). The live file (`hostsFile`) is reader-edited state,
  // so lib/paths.js puts it beside the job store above, and not in projects.json, which the discovery sweep rewrites every
  // pass. The SEED is the opposite: it ships with the code (hosts.seed.json next to this file) and supplies defaults the
  // live file overrides.
  if (!cfg.hostsSeedFile) cfg.hostsSeedFile = path.join(HERE, "hosts.seed.json");
  // The pipeline catalogue's seed is source in exactly the same way: it ships next to this file and supplies the
  // built-in definitions (local / investigate / turnover, and the two hosts' turnover loops) that the reader's
  // pipelines.json overrides per id. lib/paths.js puts the live file beside hosts.json in the state folder.
  if (!cfg.pipelinesSeedFile) cfg.pipelinesSeedFile = path.join(HERE, "pipelines.seed.json");
  // Whether a branch may exist on a REMOTE at all: the setting the reader's permission box writes, and what the
  // installed pre-push guard reads. local-only by default — a value that cannot be read falls back to it rather
  // than to a permissive one.
  cfg.remoteBranchPolicy = policyFrom(cfg.remoteBranchPolicy);
  // How long a parked remote-write question waits before it is denied: the guard's own poll window as well, since
  // the panel hands it this number at install time.
  cfg.remoteWriteSeconds = Number(cfg.remoteWriteSeconds) > 0 ? Math.min(3600, Number(cfg.remoteWriteSeconds)) : 300;
  return cfg;
}

// Write one setting into the panel's own config.json, leaving every other key exactly as it was. Only the key being
// changed is written: dumping the in-memory config would bake computed defaults into the file.
//
// `config.json` is read by more than this writer: the next settings route, a harness, the reader's own editor, and
// a poller beside it. Writing it IN PLACE truncates the file before the new bytes land, so a reader that gets there
// in between parses an empty or half-written file and throws `Unexpected end of JSON input` — a torn read that
// looks like the READER's bug, which is how this class of defect hides. A sibling temp file plus a rename fixes it:
// the rename is atomic on this filesystem precisely because the temp file is in the SAME directory (a different
// directory could be a different volume, and a cross-volume move is a copy), so every reader sees the whole old file
// or the whole new one and never a third thing. The bytes, the key order and the 2-space formatting are unchanged —
// only HOW the file is replaced is.
const CONFIG_WRITE_TRIES = 40;
const CONFIG_WRITE_RETRY_MS = 1;
// The codes Windows reports for "somebody else has this file open": EPERM for the plain concurrent read, EBUSY for a
// handle that cannot be deleted at all, EACCES for a file marked read-only.
const CONFIG_WRITE_BUSY = new Set(["EPERM", "EBUSY", "EACCES"]);

let configWriteSeq = 0;
async function writeConfigAtomic(text) {
  // A name of this process's own, so two saves racing in one panel cannot write the same temp file, and it ends in
  // `.tmp` so a run that dies between the write and the rename leaves something nobody mistakes for the config.
  const tmp = path.join(CONFIG_DIR, `${path.basename(CONFIG_PATH)}.${process.pid}.${++configWriteSeq}.tmp`);
  await writeFile(tmp, text, "utf8");
  // Windows refuses a rename whose DESTINATION another handle is reading, even when that handle is a plain
  // `readFile` — measured on this box, one reader looping over the target refused 244 of 300 replaces, and one handle
  // held open refused all 300, while the same loop against another file refused none. The read it competes with lasts
  // a fraction of a millisecond, so the refusal is TRANSIENT and a bounded retry is what turns it into a save that
  // lands: without it this fix would trade a torn read for a 500 on the save. A reader that holds the file open for
  // good (an editor, a `tail -f`) still exhausts the retries and gets the error, which is the honest answer — the
  // alternative is writing in place again and handing back the torn read. The budget is 40 attempts a millisecond
  // apart: measured under a reader looping over the target, every save landed in ~5-15 ms, and a reader that never
  // lets go costs that route at most ~40 ms before the error.
  let last = null;
  for (let attempt = 0; attempt < CONFIG_WRITE_TRIES; attempt++) {
    try {
      await rename(tmp, CONFIG_PATH);
      return;
    } catch (e) {
      if (!CONFIG_WRITE_BUSY.has(e && e.code)) {
        await unlink(tmp).catch(() => {});
        throw e;
      }
      last = e;
      await new Promise((r) => setTimeout(r, CONFIG_WRITE_RETRY_MS));
    }
  }
  await unlink(tmp).catch(() => {});
  throw last;
}

async function patchPanelConfig(patch) {
  let raw = {};
  try {
    raw = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch {
    raw = {};
  }
  Object.assign(raw, patch);
  await writeConfigAtomic(`${JSON.stringify(raw, null, 2)}\n`);
}

let config = await loadConfig();
// ---- one panel per port, asked before this one touches anything ----------------------------------
// Before the data directory is created, the store migrated or a single job read: a second copy of this panel (or a
// sandbox started on the reader's port) has to stop HERE, not after it has loaded the reader's jobs.json. On Windows
// a 127.0.0.1 bind and a 0.0.0.0 bind share a port without an error, so the listen() below cannot be the guard
// (lib/port-guard.js has the measured case). A predecessor that is still letting go of the port is waited for.
{
  const holder = await portHolder({ port: config.port, host: config.host, waitMs: Number(process.env.PANEL_PORT_WAIT_MS ?? 5000) });
  if (holder) {
    writeSync(1, `${new Date().toISOString().slice(11, 19)} ${refusalLine(holder, config.port)}\n`);
    process.exit(1);
  }
}
// ---- both directories exist before anything writes into them --------------------------------------
// Nothing is created lazily any more: a boot that dies between "store opened" and "attachment saved" used to leave
// a half-made `logs/`, and the next boot could not tell that from a fresh install. `ensureDirs` is `mkdir -p`, so
// two panels racing on one data directory is a no-op rather than a failure.
const madeDirs = ensureDirs(config);
for (const target of madeDirs.made) log(`created ${target}`);
log(`data directory: ${config.dataDir} (${config.dataDirSource}) · scratch directory: ${config.scratchDir} (${config.scratchDirSource})`);
// ---- the one-time move off the checkout -----------------------------------------------------------
// An install that has been running from a checkout keeps its whole history in `<repo>/logs`. The first boot with a
// data directory that holds no store COPIES it across. Never moved, never deleted: a downgrade, a second build, or a
// reader who deliberately points PANEL_CONFIG at the old file all still find what was there. The line names the
// count and the directory so a board that comes up full of last week's cards is explainable from the log alone.
const stateMigration = migrateState({
  dataDir: config.dataDir,
  stateFile: config.jobsFile,
  legacyDir: path.join(CONFIG_DIR, "logs"),
  layout: config.dataLayout,
  onLog: log,
});
// A second instance (PANEL_CONFIG, no dataDir) has nothing to move, and saying so on every sandbox boot is noise.
if (!stateMigration.migrated && stateMigration.reason && stateMigration.reason !== "no job store beside the checkout" && config.dataLayout !== "flat") {
  log(`state migration skipped: ${stateMigration.reason}`);
}
// Start the two size readings in the background so the first /api/state (and the first Settings open) finds a number
// waiting. They are async walks: a scratch folder holding a copied checkout must not hold up the listener.
void measureSize(config.dataDir).catch(() => {});
void measureSize(config.scratchDir).catch(() => {});
// What the data directory's own journal says about where its board came from. Read once, here: the journal only
// changes at boot, and /api/state is polled far too often to read a file for it.
const lastMigration = readMigrationJournal(config.stateDir).slice(-1)[0] || null;
let pool = new Pool(config.threads);
const store = new Store();
// A tree's name is the panel's fact, never git's. The ledger of which trees have a name, who gave it and when
// (lib/tree-names.js) is read before anything can rename a tree and written the moment the panel learns one:
// at the cut for a tree this panel makes, at first sight for a tree that was already there.
const treeNames = new TreeNames({ file: config.treeNamesFile, log });
// Where each project's branches and pull requests live. The file is created on first boot (empty: the defaults are
// hosts.seed.json's) so the reader has something to edit, and lib/hosts.js merges the seed under it per host id and
// per project — a new seed record reaches this install without anybody merging JSON by hand.
const hosts = new Hosts({
  file: config.hostsFile,
  seedFile: config.hostsSeedFile || "hosts.seed.json",
  log: (line) => log(line),
});
const hostsFile = hosts.ensure();
for (const warning of hosts.doc().warnings) log(`hosts: ${warning}`);
// What each tree is FOR. The catalogue is the reader's pipelines.json (created empty on first boot: the defaults are
// pipelines.seed.json's, and a copy of them here would freeze them) merged per id over that seed. A definition that
// fails validation is dropped by id and named here, and the rest of the catalogue still loads; a live file whose
// version is NEWER than this code's is refused whole and the seed is loaded read-only. The per-TREE record of where a
// job stands in a definition is durable state beside push-guard.json, because a review loop outlives the job ring.
const pipelines = new Pipelines({
  file: config.pipelinesFile,
  seedFile: config.pipelinesSeedFile || "pipelines.seed.json",
  log: (line) => log(line),
});
pipelines.ensure();
const pipelineRecords = new PipelineRecords({ file: config.pipelineRecordsFile, log: (line) => log(line) });
// The switch's missing half: §4.1 says the route also starts the new pipeline's first stage as a turn in the same tree
// on the same thread. That needs the prompt renderer and the exit-check evaluator (later tasks), and until it exists a
// switch may NOT write the record: the ladder only climbs, so a rung written with no run behind it is spent forever —
// `since` clocks a stage that never began and no later POST can undo it. Flipped to true in the change that wires the
// turn start, together with a test that a real turn exists.
const PIPELINE_SWITCH_STARTS_TURN = false;
for (const warning of pipelines.doc().warnings) log(`pipelines: ${warning}`);
const registry = new ProjectRegistry({
  getConfig: () => config,
  store,
  onLog: log,
  // Last successful sweep, so a restart opens on the board it had instead of "no git repos found". Resolved by
  // lib/paths.js — it used to default to a path relative to the process cwd, which a sandbox then shared with the
  // live board while its own seeded rows stayed invisible.
  cacheFile: config.projectsCacheFile,
  // Each repo's tier and the signal its hourly gate compares. Beside the projects cache and outside every
  // checkout: it is state, and a restart must resume the hour rather than re-probe the old fleet.
  tierFile: config.tiersFile,
});
let scheduler = new Scheduler({
  config,
  store,
  pool,
  registry,
  hosts,
  getProjects: () => registry.projects,
  panelAgents: () => jobs.agentPaths(),
  panelThreads: () => jobs.panelRunThreads(),
  // Every worktree a listing turns up, before it becomes a row: the naming ledger's seeding (see seedTreeName).
  onWorktreeSeen: (project, tree) => seedTreeName(project, tree),
});

const clients = new Set();

function broadcast(evt) {
  const frame = `event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }
}

// One part of a job event's handling must not be able to take the rest down with it. `broadcast` writes to every
// open SSE client, `adoptFromJob` reads the project registry and the assistant observer runs the finished turn's
// actions — three unrelated jobs on one line, and a throw from any of them would land inside the job store's own
// emit. Say which part failed and carry on.
function guard(what, fn) {
  try {
    return fn();
  } catch (err) {
    log(`${what} failed: ${String((err && err.message) || err)}`);
    return null;
  }
}

// Every row that leaves the panel carries its owner, on BOTH paths a row travels. `withAssistantOwners` overlays the
// rows a snapshot carries, and a `row` frame REPLACES the page's row object wholesale (public/core/sse.js queueRow ->
// placeRow): a tree whose first scan reaches the page before any snapshot has seen it would draw the bare fallback
// name — the chart cell without its "(Manager 1)", the bullet without its "— Manager" — until the next snapshot, and
// a board nobody polls never gets one. Observed as a 2-of-4 flake in tools/verify-chart-columns.mjs.
store.onEvent((evt) => (evt?.type === "row" ? broadcast({ ...evt, row: ownerOnRow(evt.project, evt.row) }) : broadcast(evt)));

// A `-w` agent's worktree exists a few seconds after spawn; adopt it into the board right then so the
// card can be opened under a row instead of waiting for a discovery pass.
const adoptedTrees = new Set();
function adoptFromJob(evt) {
  if (evt?.type !== "job") return;
  const j = evt.job;
  if (!j || !j.worktreePath || adoptedTrees.has(j.worktreePath)) return;
  adoptedTrees.add(j.worktreePath);
  // The tree is created by THIS panel now, so the job knows its project directly — the worktree
  // path alone would not match any project row and the card would sit "unattached" until the next
  // discovery pass.
  const project = registry.projects.find((p) => normPathKey(p.path) === normPathKey(j.projectPath || j.cwd));
  if (!project) return;
  void scheduler.adoptWorktree(project.name, j.worktreePath).catch(() => {});
}
// The restart controller: the queue, the provider-key preflight, the one-terminal-status snapshot, the
// real-turn proof and the single resume wake. Declared before the assistant because the assistant is
// handed its `request` as the one act it cannot perform itself.
let restart = null;
// Declared before the job stream that feeds it: a job event arrives on the same tick as construction, so the release
// sweep is armed here as an optional hook and filled in below, once its store exists.
let scheduleReleaseSweep = null;
// Declared before the job stream that feeds it: a job event arrives on the same tick as construction,
// and the observer is optional until the assistant exists.
let assistant = null;
// Declared before the job stream that feeds it. The naming policy itself is created below, once the ledger and the
// panel's own worktree cut are wired; an event that arrives before then is not lost — the 10-second title sweep
// emits again for any card that still has no name.
let naming = null;
const jobs = new Jobs({
  config,
  // The same supervisor server.js holds: a job that settles kills whatever its turn started, and a shutdown
  // walks one list. A Jobs built by a test passes its own or none.
  children: panelChildren,
  onEvent: (evt) => {
    guard("event broadcast", () => broadcast(evt));
    guard("worktree adopt", () => adoptFromJob(evt));
    // Every event that carries a session title is a chance to give a tree the name its run chose for it — the
    // sweep that emits on the first title, the run's own events, and the settle that follows. The policy (which
    // tree, which run, and the ledger that allows it exactly once) is lib/worktree-naming.js; a rename is never
    // worth failing a job event over, so the whole call is fire-and-forget.
    guard("worktree naming", () => void naming?.consider(evt?.job));
    // A run that just arrived (or changed) is a new chance to learn what a tree was started to do: the earliest
    // brief in a tree is in this store, and a harvest is collapsed into one pass per couple of seconds.
    guard("description harvest", () => descriptions.harvest());
    // A settled turn is the moment a release request can be acted on — and only then: the request was recorded as the
    // run ended, and this sweep is a different pass of this process, never a step inside the run.
    guard("release sweep", () => scheduleReleaseSweep?.());
    guard("assistant observation", () => assistant?.observe(evt));
  },
  onLog: log,
  // Read per question, not once at boot: the file is small and the gateway re-reads it too, so a countdown
  // matches the wait the gateway is actually enforcing.
  clarifyWindow: () => clarifyWindowSeconds(),
  // The same for an approval, which the gateway gives up on at `approvals.timeout`: without it the card kept
  // offering "Allow once" long after the gateway had already denied the command and moved on.
  approvalWindow: () => approvalWindowSeconds(),
});
// Where the work of a card whose run the gateway has forgotten still is: the tree the turn ran in, and the PR its
// branch has. Read from the board's own rows — a scan already carries the PR per branch (lib/scheduler.js), so this
// is a lookup, not a measurement: no git call, no gh call, and nothing the boot reconcile would have to pay per
// card. The manual press is its only caller.
function gonePointers(id) {
  const j = jobs.get(id);
  if (!j) return null;
  const store = scheduler.store;
  const wanted = [j.worktreePath, j.ownerPath, j.cwd].filter(Boolean).map(normPathKey);
  // The rows are the store's, keyed by "<project>::<path>", so the search walks that store's own project names:
  // discovery publishes a project to the registry on its own clock, and a press must not miss a row that is already
  // on the board just because the registry has not named its project yet.
  let found = null;
  for (const name of store.projects.keys()) {
    const hit = (store.rowsFor(name) || []).find((r) => wanted.includes(normPathKey(r.path))) || null;
    if (hit) {
      found = { project: store.projects.get(name), row: hit };
      break;
    }
  }
  const row = found?.row || null;
  const pr = row?.pr || null;
  return {
    worktree: row?.path || j.worktreePath || j.ownerPath || j.cwd || null,
    branch: row?.branch || j.branch || null,
    // The scan's PR index carries the number, the state and the title; the URL is the one form of a pointer the
    // console renders as a link, and it comes from the project's host record — the same template the board's PR cell
    // uses. No host mapping means no URL: the console then shows the PR number and says where the mapping is missing
    // rather than sending the reader to a github.com page that may not exist.
    pr: pr
      ? {
          number: pr.number,
          state: pr.state || null,
          title: pr.title || null,
          url: hosts.linkFor(found?.project || { name: "" }, "pull", { pr: pr.number, branch: row?.branch, sha: row?.head, main: found?.project?.mainBranch }).url || null,
        }
      : null,
  };
}

// Human side of the Hermes approval-transport contract: the plugin presents, the panel answers,
// the host decides. Nothing here can approve anything by itself.
const approvals = new Approvals({ onEvent: broadcast });

// ---- who may put a branch on a remote ------------------------------------------------------------
// The reader's rule: a worktree the panel cuts is LOCAL ONLY unless the work is going to land. The setting
// (`remoteBranchPolicy`) is the standing answer, the permission box is how an exception is granted, and the
// installed pre-push guard is what makes the default hold against a worker's own `git push`. Three surfaces, one
// decision — RemoteWrites owns it, this block is only the wiring.
//
// Which worktrees carry the guard, and when it went in. git holds the hooks path itself; this is the panel's list
// of what it installed, so the Settings row can report it without walking 90 repositories' git dirs.
function readGuardRecord() {
  try {
    const raw = JSON.parse(readFileSync(config.pushGuardFile, "utf8"));
    return raw && typeof raw === "object" && raw.trees ? raw : { version: 1, trees: {} };
  } catch {
    return { version: 1, trees: {} };
  }
}
function writeGuardRecord() {
  try {
    mkdirSync(path.dirname(config.pushGuardFile), { recursive: true });
    writeFileSync(config.pushGuardFile, `${JSON.stringify(guardRecord, null, 2)}\n`, "utf8");
  } catch (e) {
    log(`could not write ${config.pushGuardFile}: ${String((e && e.message) || e)}`);
  }
}
const guardRecord = readGuardRecord();

// The url the guard calls back on. Loopback on purpose: the hook runs on this box, and a loopback request is never
// challenged for the panel token (authorised), so the guard needs no secret of its own.
const guardPanelUrl = () => `http://127.0.0.1:${config.port}`;

// THE POLICY IN FORCE FOR ONE PROJECT. The global `remoteBranchPolicy` is the default for every checkout here; a
// project's own entry in config.json overrides it. That override is not a nicety: this panel and heroes-js LAND by
// pushing a branch and opening a PR, so a blanket local-only would refuse their own landing path, while every other
// repository on this box is local work whose child branches must merge into their parent instead of appearing on a
// shared remote. Unknown names and unreadable values fall back to the global (lib/remote-writes.js `policyForProject`).
//
// The legacy key is still READ (the brief paragraph in lib/jobs.js is built from it, and an install that never
// named the two controls must keep behaving as it did); it no longer DECIDES a push. lib/push-permissions.js is
// the decision, and the two are bridged below by `pushPermissionsForPath`.
const guardPathKey = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
function policyForProjectPath(projectPath, project = null) {
  if (project) return policyForProject(project, config.remoteBranchPolicy);
  const key = guardPathKey(projectPath);
  const found = key ? registry.projects.find((p) => guardPathKey(p.path) === key) || null : null;
  return policyForProject(found, config.remoteBranchPolicy);
}

// The TWO CONTROLS in force for one project: project's own value, else the repository's defaults, else the shipped
// `always-ask`, with `never` absolute and a repo force-override winning over the project's own (lib/push-permissions.js
// `resolvePushPermissions`). Every surface that has to know — the guard's files, the card's selects, the permission
// box, the assistant's endpoint — calls this one function rather than re-deriving precedence.
function projectForPath(projectPath, project = null) {
  if (project) return project;
  const key = guardPathKey(projectPath);
  return key ? registry.projects.find((p) => guardPathKey(p.path) === key) || null : null;
}
function pushPermissionsForPath(projectPath, project = null) {
  return resolvePushPermissions(projectForPath(projectPath, project), config);
}

// The SAME precedence for the legacy boolean (lib/remote-writes.js `allowPushWithoutAskingFor`), kept beside the
// policy resolver because lib/jobs.js reads it when it composes a brief's paragraph.
function allowPushWithoutAskingForPath(projectPath, project = null) {
  return allowPushWithoutAskingFor(projectForPath(projectPath, project), config);
}

// The project a tree belongs to: what a REPLY's brief needs in order to quote the right policy and the right remote.
// The panel's own guard record names the project of every tree it cut; a tree it did not cut sits under its project's
// directory, so the longest project path that prefixes it is the second answer. null = nobody owns it, and the global
// policy applies.
function projectOfTree(dir) {
  const key = guardPathKey(dir);
  if (!key) return null;
  const recorded = guardRecord.trees[normTree(dir)]?.projectPath;
  if (recorded) {
    const hit = registry.projects.find((p) => guardPathKey(p.path) === guardPathKey(recorded));
    if (hit) return hit;
  }
  let best = null;
  for (const p of registry.projects) {
    const pk = guardPathKey(p.path);
    if (pk && (key === pk || key.startsWith(`${pk}/`)) && (!best || pk.length > guardPathKey(best.path).length)) best = p;
  }
  return best;
}

// Install (or refresh) the guard for ONE worktree and remember it. Called the moment the panel cuts a tree, and by
// the Settings button for trees that predate this feature.
async function installGuardFor({ projectPath, worktree, branch = null, landing = false, project = null }) {
  // `project` is the registry record when the caller has it (the spawn path does); a Settings install passes the path
  // alone. Either way the guard's own copy of the policy is the PROJECT's, not the global one.
  const policy = policyForProjectPath(projectPath, project && typeof project === "object" ? project : null);
  // The two controls, resolved for this project and written into the guard's own files. The guard reads those files,
  // not the panel's memory: a push has to be decided with the panel down, and a default it assumed would be a
  // permission nobody granted.
  const push = pushPermissionsForPath(projectPath, project && typeof project === "object" ? project : null);
  const out = await installGuard({
    projectPath,
    worktree,
    panelUrl: guardPanelUrl(),
    timeoutSeconds: config.remoteWriteSeconds,
    policy,
    landing: [...remoteWrites.landing],
    pushPermissions: { newBranches: push.newBranches, existingBranches: push.existingBranches },
    log,
  });
  if (!out.ok) return out;
  // A tree started to LAND is allowed to push by design; recorded on the panel side too, so the guard's own file
  // and this process agree about it.
  if (landing) remoteWrites.markLanding(worktree);
  guardRecord.trees[normTree(worktree)] = {
    tree: normTree(worktree),
    path: cleanPath(worktree),
    project: (project && typeof project === "object" ? project.name : project) || path.basename(projectPath || ""),
    projectPath: cleanPath(projectPath || worktree),
    branch: branch || null,
    landing: Boolean(landing),
    // The policy this tree's guard was actually written with, so the Settings row can never show the global one for a
    // project that overrides it.
    policy,
    // …and the two controls it was written with, for the same reason.
    newBranches: out.newBranches,
    existingBranches: out.existingBranches,
    dir: out.dir,
    at: new Date().toISOString(),
  };
  writeGuardRecord();
  log(`push guard installed: ${cleanPath(worktree)} -> ${out.dir} (new ${out.newBranches}, existing ${out.existingBranches}, policy ${policy}${policy !== config.remoteBranchPolicy ? ` — this project's own, the global is ${config.remoteBranchPolicy}` : ""}${landing ? ", started to land" : ""})`);
  return { ...out, policy };
}

// The panel's own worktree creation (lib/jobs.js calls this) — the one place a spawned tree is cut, so it is the
// one place the guard has to go in.
jobs.afterWorktreeCreate = async ({ repoDir, path: tree, branch, landing }) => {
  try {
    const project = registry.projects.find((p) => normPathKey(p.path) === normPathKey(repoDir));
    // The record, not its name: it carries this project's own `remoteBranchPolicy`, which is what the guard must obey.
    return await installGuardFor({ projectPath: repoDir, worktree: tree, branch, landing, project: project || null });
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
};

// Every guard the panel installed gets the current setting and the current landing list written into it. Cheap: a
// handful of one-word files, one call per project.
async function refreshGuards() {
  const dirs = new Map();
  for (const rec of Object.values(guardRecord.trees)) if (rec?.projectPath) dirs.set(normTree(rec.projectPath), rec.projectPath);
  const landing = [...remoteWrites.landing].map((t) => guardRecord.trees[t]?.path || t);
  const out = [];
  for (const [key, projectPath] of dirs) {
    // Each project's guard gets ITS policy: a settings change of the global must not overwrite a project that
    // carries its own answer, and an "Always allow" click must not turn every other checkout's default off either.
    const policy = policyForProjectPath(projectPath);
    const push = pushPermissionsForPath(projectPath);
    const r = await refreshGuardFiles({ projectPath, panelUrl: guardPanelUrl(), timeoutSeconds: config.remoteWriteSeconds, policy, landing, pushPermissions: { newBranches: push.newBranches, existingBranches: push.existingBranches }, log });
    out.push({ project: key, policy, newBranches: push.newBranches, existingBranches: push.existingBranches, ...r });
  }
  return out;
}

// What the Settings row reports, and what the tests read: which trees carry the guard, what it replaced, and which
// of them were started to land. The record is the panel's own — this is one file read, never a git call per tree.
function guardReport() {
  const trees = Object.values(guardRecord.trees || {});
  const projects = new Set(trees.map((t) => normTree(t.projectPath)).filter(Boolean));
  return {
    file: config.pushGuardFile,
    count: trees.length,
    projects: projects.size,
    landing: [...remoteWrites.landing],
    dirs: [...new Set(trees.map((t) => t.dir).filter(Boolean))],
    latest: trees
      .slice()
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 8)
      .map((t) => ({ tree: t.path, project: t.project, branch: t.branch, landing: Boolean(t.landing), at: t.at })),
  };
}

// Where the two push controls are WRITTEN. Two shapes, because they live in two places:
//
//   * `pushPermissions.repos[<repo>]` — a remote repository's defaults and its force-override, a top-level key, so
//     `patchPanelConfig` can assign it;
//   * `projects[].pushNewBranches` / `projects[].pushExistingBranches` — one project's own answer, inside an array
//     element, which a top-level assignment would replace with a single object. A project the file does not name yet
//     gets a minimal entry — its NAME, and nothing else — rather than a refusal: every project on the board is allowed
//     a row here, discovered or configured.
//
// WHY THE NEW ENTRY CARRIES NO PATH. A `projects[]` row is merged onto the scanned repository BY NAME
// (lib/projects.js: `merged.push({ ...p, ...(explicit.get(name) || {}) })`), so discovery already supplies the path
// of the folder it walked. A path written here is a second copy of that fact — and it is the path of ONE MACHINE, in
// the reader's own config.json, which is meant to travel. It was also what broke this repo's gate: while config.json
// was tracked, tools/absolute-paths.mjs froze it at the six paths it already carried, and the entry this route wrote
// made the seventh, so landing one project's push setting meant deleting the path by hand. The file has since moved
// out of the repo (config.example.json is the template), which makes the entry harmless rather than right.
// An entry that already has a path keeps it: this writer only ever adds the two keys it was asked to set and never
// rewrites the rest of the record.
//
// Both writers write atomically, apply the change to the in-memory config AND the registry record the page draws
// from, then rewrite every installed guard's own copies and broadcast. A guard left reading the old answer is the
// exact defect this feature exists to remove.
const PUSH_KIND_KEY = { new: "newBranches", existing: "existingBranches" };

async function readPanelConfigFile() {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function pushKindOf(kind) {
  return PUSH_KIND_KEY[String(kind || "").trim()] || null;
}

async function setRepoPushSetting(repo, patch, { by = "reader" } = {}) {
  const key = String(repo || "").trim();
  if (!PUSH_REPO_KEYS.includes(key)) {
    return { status: 400, error: `repo must be one of: ${PUSH_REPO_KEYS.join(", ")}` };
  }
  const raw = await readPanelConfigFile();
  const block = raw.pushPermissions && typeof raw.pushPermissions === "object" ? raw.pushPermissions : {};
  const repos = block.repos && typeof block.repos === "object" ? block.repos : {};
  const rec = repos[key] && typeof repos[key] === "object" ? repos[key] : {};
  if (patch.newBranches !== undefined) rec.newBranches = pushChoiceFrom(patch.newBranches, DEFAULT_PUSH_CHOICE);
  if (patch.existingBranches !== undefined) rec.existingBranches = pushChoiceFrom(patch.existingBranches, DEFAULT_PUSH_CHOICE);
  if (typeof patch.force === "boolean") rec.force = patch.force;
  repos[key] = rec;
  block.repos = repos;
  raw.pushPermissions = block;
  try {
    await writeConfigAtomic(`${JSON.stringify(raw, null, 2)}\n`);
  } catch (e) {
    return { status: 500, error: `could not write the setting: ${String((e && e.message) || e)}` };
  }
  config.pushPermissions = block;
  await refreshGuards();
  broadcast({ type: "settings", settings: settingsOut() });
  log(`push controls: repo ${key} -> new ${rec.newBranches || DEFAULT_PUSH_CHOICE}, existing ${rec.existingBranches || DEFAULT_PUSH_CHOICE}${rec.force ? " (force-override ON)" : ""} (by ${by})`);
  return { ok: true, repo: key, record: rec, settings: settingsOut() };
}

async function setProjectPushSetting(name, patch, { by = "reader" } = {}) {
  const project = (registry.projects || []).find((p) => p.name === name) || null;
  if (!project) return { status: 404, error: `unknown project: ${name || "(none)"} — the control names a project on this board` };
  // A disabled select cannot send, but a hand-written request can: refuse rather than store an answer that the
  // repo's force-override would silently discard. A control that looks editable and is not is a lie; so is a save
  // that says "stored" when nothing will read it.
  const resolved = resolvePushPermissions(project, config);
  if (resolved.forced) {
    return {
      status: 409,
      error: `${name}'s push controls are set by ${resolved.repoLabel} (force-override is on) — change that repository's defaults, or turn the force-override off first`,
      settings: settingsOut(),
    };
  }
  const raw = await readPanelConfigFile();
  if (!Array.isArray(raw.projects)) raw.projects = [];
  const existing = raw.projects.find((p) => p && p.name === name) || null;
  // The row is built by ONE rule, in lib/push-permissions.js beside the four values it stores: a row the file already
  // holds keeps every field it has and gains only the keys this request named; a row it does not hold is the project's
  // NAME and those keys, and no path (the scan owns where the repository is, and config.json is gate-frozen at the
  // paths it already carried).
  const entry = projectPushRow(existing, name, patch);
  if (!existing) raw.projects.push(entry);
  try {
    await writeConfigAtomic(`${JSON.stringify(raw, null, 2)}\n`);
  } catch (e) {
    return { status: 500, error: `could not write the setting: ${String((e && e.message) || e)}` };
  }
  // What is in FORCE: the in-memory config (so the next spawn/reply reads it without a restart) and the registry's
  // own record (what settingsOut and the assistant endpoint answer from between discoveries).
  if (!Array.isArray(config.projects)) config.projects = [];
  let live = config.projects.find((p) => p && p.name === name) || null;
  if (!live) {
    // The same shape the file now carries, so the config in memory is the config a restart would boot: the row is a
    // name discovery merges onto the repository it scanned, not a second claim about where that repository lives.
    live = { name };
    config.projects.push(live);
  }
  if (patch.newBranches !== undefined) {
    live.pushNewBranches = entry.pushNewBranches;
    project.pushNewBranches = entry.pushNewBranches;
  }
  if (patch.existingBranches !== undefined) {
    live.pushExistingBranches = entry.pushExistingBranches;
    project.pushExistingBranches = entry.pushExistingBranches;
  }
  await refreshGuards();
  broadcast({ type: "settings", settings: settingsOut() });
  const after = resolvePushPermissions(project, config);
  log(`push controls: project ${name} -> new ${after.newBranches}, existing ${after.existingBranches} (by ${by})`);
  return { ok: true, project: name, resolved: after, settings: settingsOut() };
}

// "Always allow" in the permission box is the same fact as the two controls saying allow-all for the project that
// asked. It writes that project's own answer, not a global one: a grant the reader gave about one tree must not
// open every other checkout on the board. Under a repo force-override the write is stored and REPORTED as not in
// force, so the box cannot claim a grant the resolver will ignore.
async function grantPushControls(request, { by = "reader" } = {}) {
  const name = String(request?.project || "").trim();
  if (!name) {
    return { ok: true, note: "no project named by the request — nothing but the tree's own grant was recorded" };
  }
  const out = await setProjectPushSetting(name, { newBranches: "allow-all", existingBranches: "allow-all" }, { by });
  if (out.error) return { error: out.error };
  return { ok: true, forced: Boolean(out.resolved?.forced), repo: out.resolved?.repo || null };
}

// What the page draws: the four values and their labels, each repository section with its defaults and its
// force-override, and every project's RESOLVED pair. The page never re-derives precedence — a card that decided for
// itself could disagree with the guard that refuses the push.
function pushPermissionsOut() {
  const projects = registry?.projects || [];
  const fallback = legacyDefaults(config);
  const repos = Object.fromEntries(
    PUSH_REPOS.map((r) => {
      const rec = config.pushPermissions?.repos?.[r.key] || {};
      return [
        r.key,
        {
          key: r.key,
          label: r.label,
          newBranches: pushChoiceFrom(rec.newBranches, fallback.newBranches),
          existingBranches: pushChoiceFrom(rec.existingBranches, fallback.existingBranches),
          stated: rec.newBranches !== undefined || rec.existingBranches !== undefined,
          force: rec.force === true,
          projects: projects.filter((p) => repoKeyForProject(p) === r.key).map((p) => p.name).sort((a, b) => a.localeCompare(b)),
        },
      ];
    }),
  );
  return {
    choices: PUSH_CHOICES,
    labels: PUSH_CHOICE_LABELS,
    defaultChoice: DEFAULT_PUSH_CHOICE,
    defaults: fallback,
    repos,
    projects: Object.fromEntries(
      projects.map((p) => {
        const r = resolvePushPermissions(p, config);
        return [
          p.name,
          {
            repo: r.repo,
            repoLabel: r.repoLabel,
            newBranches: r.newBranches,
            existingBranches: r.existingBranches,
            newSource: r.newSource,
            existingSource: r.existingSource,
            forced: r.forced,
            repoNewBranches: r.repoNewBranches,
            repoExistingBranches: r.repoExistingBranches,
            projectNewBranches: r.projectNewBranches,
            projectExistingBranches: r.projectExistingBranches,
          },
        ];
      }),
    ),
  };
}

const remoteWrites = new RemoteWrites({
  getPolicy: () => config.remoteBranchPolicy,
  onEvent: broadcast,
  onLog: log,
  timeoutSeconds: config.remoteWriteSeconds,
  // "Always allow" in the box is the project's own controls saying allow-all (see `grantPushControls`). It used to
  // write a GLOBAL policy, which meant one reader's grant about one tree opened every other checkout on the board.
  onPolicy: (policy, { by, request }) => grantPushControls(request, { by }),
  // A grant reaches the guard's own files too, so a tree the reader allowed does not have to reach the panel to
  // find that out — and a tree started to land keeps its permission across a panel restart.
  onGrant: () => void refreshGuards(),
});

// The proof an AUTO-ALLOWED write really went through: the branch is on the remote. `git ls-remote` is asked a few
// times because the guard reports as it STARTS the push, not after it finishes — the first read can be a second too
// early. A push the chained version gate refused never shows up, so it never becomes a review card.
remoteWrites.setVerifier(async ({ worktree, remote, branch }) => {
  const name = String(branch || "").replace(/^refs\/heads\//, "");
  if (!worktree || !name) return { found: false };
  const rem = String(remote || "origin");
  const deadline = Date.now() + 30_000;
  for (;;) {
    const out = await gitIn(worktree, ["ls-remote", "--heads", rem, `refs/heads/${name}`], 12_000);
    if (out.ok && out.out) {
      const sha = out.out.split(String.fromCharCode(10))[0].split(String.fromCharCode(9))[0].trim();
      if (sha) return { found: true, sha };
    }
    if (Date.now() > deadline) return { found: false };
    await new Promise((r) => setTimeout(r, 2500));
  }
});

// ---- spawning ---------------------------------------------------------------------------
// The New-agent card, its preview and the assistant's spawner all ask the same question, so they
// ask it in one place (lib/features/spawn.js), named `spawnFeature` because node:child_process
// already owns `spawn` in this module. The two answers that go stale are passed as getters:
// /api/reload replaces `config` wholesale, and every registry refresh replaces the project array.
// The board's rows, each carrying the PROJECT it belongs to. The store keys its rows `<project>::<path>`, and one
// reader needs the name ON the row rather than beside it: the assistant's queue card draws the project first in its
// meta line, and a task with no project of its own falls back to its row's. A row that already carries one keeps it.
const rowsWithProject = () =>
  [...store.rows].map(([key, row]) => {
    const at = String(key).indexOf("::");
    return { ...row, project: row.project || (at > 0 ? String(key).slice(0, at) : null) };
  });

const spawnFeature = createSpawn({
  getConfig: () => config,
  getProjects: () => registry.projects,
  jobs,
  // The rows the scanner already wrote, read at the cut: before a tree is made, the spawner asks whether the
  // project already holds an unfinished tree carrying this task (lib/spawn-reuse.js). The same rows the assistant
  // reads, so the cut and the digest cannot be told two different stories about one tree.
  getRows: rowsWithProject,
});

// ---- the reader's locks ---------------------------------------------------------------------------------------
// A worktree or a branch the reader has locked (lib/locks.js): the one record here that is the reader's and not
// git's, persisted under logs/ so it survives a restart, and consulted before ANY delete touches a tree. The row
// wears it as an emoji, so an agent reading the board sees the lock without opening anything.
const locks = new Locks({ file: config.locksFile, log });

// The sentry + the assistant's own thread. It reads the same job summaries the page does, so nothing
// here can see more than the board shows; its own clock is `settings.seconds`. `spawner` is the one act it
// can perform beyond talk: a worker, in a worktree the panel cuts, exactly the way the New-agent card does.
assistant = new Assistant({
  config,
  jobs,
  getProjects: () => registry.projects,
  // The rows the scanner already produced (dirty files, commits ahead, verdict) — no second git pass — and the
  // delegated children the gateway keeps in `state.db`, which never reach a parent's run stream. Each row carries the
  // project it belongs to (see rowsWithProject), because the queue card draws that name.
  getRows: rowsWithProject,
  getChildren: () => subagentRoster({ dbPath: path.join(hermesHome(), "state.db") }),
  spawner: spawnFeature.assistantSpawnRun,
  // The reader's per-tree owner store: WHO wakes on a tree is decided from this same record the row's owner cell
  // draws (lib/assistant.js `assistantIdForJob`), so the two cannot disagree.
  locks,
  // The one act this module cannot perform itself: a RESTART line's gateway/panel restart, queued by
  // the controller and run only once the turn that asked for it has ended.
  onRestart: (spec) => restart.request(spec),
  onEvent: broadcast,
  onLog: log,
});
// The assistant's own working directory, created before the first turn so it cannot be refused by the
// gateway: this thread does no file work, and borrowing a project checkout is what broke a live panel when
// that checkout had been deleted. Logged once, so the path is never a mystery in the boot log.
log(`assistant cwd: ${assistant.ensureCwd()}`);
assistant.start();

// ---- the route prefixes cut out of this chain, mounted from one table ------------------------------------------
// Step 8 of docs/reports/module-map-2026-11-07.html moves one prefix at a time into routes/, so a prefix is a ROW here
// rather than another branch in the request chain below. A mount answers for its own paths and says `false` for
// anything else, and the loop at the top of the handler asks each row in turn. The queue is the first row; the next cut
// adds its row beside it and changes nothing else.
const PREFIX_MOUNTS = [
  // The per-assistant task queue (routes/assistant-queue.js). The factory takes the Assistant, which owns each queue's
  // file and its read-modify-write, and the transport helpers this file already imports.
  { prefix: QUEUE_PATH, handles: createQueueRoutes({ assistant, config, sendJson, readBody, authorised }) },
  // Deleting one assistant (routes/assistant-delete.js). The dry run and the real press are one handler; the
  // module refuses on live work, archives the four files and writes the roster before the directory goes.
  { prefix: DELETE_PATH, handles: createDeleteRoutes({ assistant, config, sendJson, readBody, authorised }) },
];
// The reset's route: the gateway client, the store path and the single-flight map live in that module; this file only
// hands the same transport helpers to it and mounts it below.
const resetRoutes = createResetRoutes({ assistant, config, sendJson, readBody, authorised });
// The ticket watch's raise path: `POST /api/ticket-watch/wake` is a DOOR onto `assistant.wake` — the ladder the
// sentry, the COMPLETE chip and an alert hand-over all use — because a cron process cannot call an object inside
// this one. The module owns the path match, the refusals and the answer; nothing else here knows it exists.
const ticketWatchRoutes = createTicketWatchRoutes({ assistant, config, sendJson, readBody, authorised });

// The window one queue row opens: the task's pipeline, stage by stage. Same Assistant, same transport; a GET that
// writes nothing, and a refusal carried as a value so the dialog can draw the reason.
const pipelineWindowRoutes = createPipelineWindowRoutes({ assistant, config, sendJson });
// What the window's assignment control offers: the bundle's pipelines and their stages, in order. A read of the same
// file the window resolves against, so the control cannot offer a stage the window would then call unresolved.
const pipelineCatalogueRoutes = createPipelineCatalogueRoutes({ config, sendJson });
// …and the import that appends to that same file: a studio export goes in beside what is already there, a duplicate
// pipeline id is refused by name, and the merged document is re-read by the loader before it is written.
const pipelineBundleImportRoutes = createPipelineBundleImportRoutes({ config, sendJson, readBody });

// ---- restarting the gateway, or this panel ---------------------------------------------
// Everything that touches the outside world is injectable (lib/restart.js), which is what lets
// tools/verify-restart.mjs prove the queueing, the health wait and the resume without bouncing the
// live gateway or the live panel.
restart = new RestartController({
  config,
  jobs,
  assistant,
  home: hermesHome(),
  // The version THIS boot serves. It is read once above, before the file could be bumped on disk: `packageVersion`
  // hands in the file as it stands at request time, and a restart is refused only when the two are the same version.
  version: VERSION,
  packageVersion,
  hermesBin: config.hermesBin || null,
  credentials: () => jobs.api,
  log,
  onState: (state) => broadcast({ type: "restart", restart: state }),
  // A panel restart exits through the same path a signal uses, so the replacement can bind the port.
  shutdown: (code) => shutdown(code),
});
// The sentry cannot report its own clock stopping, and a restart leaves its last turn `interrupted` with
// nobody to notice: both are the server's business. The watchdog repairs the timer from outside (its own
// tick() only catches throws), and the resume wakes the assistant once if the restart cut a turn in half.
assistant.resumeAfterRestart();
setInterval(() => {
  try {
    const h = assistant.supervise();
    if (h.restarted || h.stale) log(`assistant watchdog: ${h.restarted ? "timer restarted" : ""}${h.restarted && h.stale ? " · " : ""}${h.stale ? "stale pass ran" : ""}`);
  } catch (err) {
    log(`assistant watchdog: ${String((err && err.message) || err)}`);
  }
}, 10_000).unref?.();

// A panel restarted by its own restart action left a record: the replacement waits for the gateway,
// proves it with ONE REAL TURN (never with the port), and only then wakes the assistant once with
// the completion payload of everything the restart interrupted. A clean boot has no record and costs
// nothing.
setTimeout(() => {
  void restart.resumePending().catch((e) => log(`restart resume failed: ${String((e && e.message) || e)}`));
}, 3_000).unref?.();

// A gateway restart nobody asked for. Runs stop reporting while the panel is still up: their streams
// dropped and the gateway no longer knows the run ids. Every run it lost is given ONE terminal status
// (interrupted, with the restart recorded as what ended it) and the same single resume wake the panel
// fires for a restart it did ask for. Swept here rather than in the sentry: the sentry owns no network
// call, and this is the only place that can see a run stop reporting.
let sweepingOrphans = false;
setInterval(() => {
  if (sweepingOrphans || !assistant) return;
  sweepingOrphans = true;
  void jobs
    .sweepOrphanedRuns()
    .then((lost) => {
      if (!lost.length) return;
      log(`gateway restart detected: ${lost.length} run(s) stopped reporting (${lost.map((j) => j.id).join(", ")})`);
      assistant.wakeAfterRestart(lost, {
        target: "gateway",
        detected: true,
        reason: "the gateway was restarted and the panel did not ask for it",
      });
    })
    .catch((e) => log(`orphan sweep failed: ${String((e && e.message) || e)}`))
    .finally(() => {
      sweepingOrphans = false;
    });
}, 15_000).unref?.();

// The installed guards read their policy from files of their own, so a config.json edited by hand while the panel
// was down is mirrored into them once at boot. Silent when nothing is installed, which is the case on a fresh clone.
setTimeout(() => {
  void refreshGuards()
    .then((out) => {
      const refreshed = out.filter((o) => o && o.ok);
      if (refreshed.length) log(`push guard: ${refreshed.length} project(s) refreshed at boot (policy ${config.remoteBranchPolicy})`);
    })
    .catch((e) => log(`push guard refresh failed at boot: ${String((e && e.message) || e)}`));
}, 4_000).unref?.();
const settingsOut = () => ({
  version: VERSION,
  refreshSeconds: config.refreshSeconds,
  worktreeSeconds: config.worktreeSeconds,
  midSeconds: config.midSeconds,
  dormantSeconds: config.dormantSeconds,
  liveSeconds: config.liveSeconds,
  slowSeconds: config.slowSeconds,
  // How long a parent collapsed by the reader keeps its cards as they were before every one of them is written into
  // the page's remembered fold set. 0 disables the cascade. It travels with every snapshot for the same reason the
  // age threshold does: the timer that reads it is the page's own, and a tab opened before the number moved has to
  // agree with the file.
  collapseAfterSeconds: config.collapseAfterSeconds,
  fetchSeconds: config.fetchSeconds,
  liveMinutes: config.liveMinutes ?? 5,
  // How many of a project's worktrees its chart draws before the reader opens the rest. It travels with every
  // snapshot for the same reason the collapse cascade does: the count decides which rows are in the DOM, and a tab
  // opened before the number moved has to agree with the file. `hideOlderDaysIgnored` is the retired age key's
  // presence, so the settings sentence can name it instead of ignoring the reader's file in silence.
  chartTopCount: config.chartTopCount,
  hideOlderDaysIgnored: config.hideOlderDaysIgnored === true,
  // The chart's hidden columns travel with every snapshot for the same reason the age threshold does: the table's
  // header and rows are built from this list, and a page that opened before the setting moved has to agree with it.
  hiddenColumns: config.hiddenColumns,
  // The turn budget is the assistant's own knob, but the General tab paints it beside the scan numbers, so one
  // answer carries all three: the live value when the assistant exists, zero (off) before it is built.
  briefingBudgetChars: Number((assistant && assistant.settings && assistant.settings.briefingBudgetChars) || 0),
  threads: config.threads,
  host: config.host,
  defaultCwd: config.defaultCwd,
  worktreeSource: String(config.discovery?.worktreeSource || "git").toLowerCase(),
  scanMode: config.scanMode === "visible" ? "visible" : "all",
  // The tier gate's own numbers travel with every snapshot: the page's All/7d button is a VIEW of the server's
  // tier, so its label and its sentence have to read the window the server actually applies, not a second 7
  // written into the client.
  tierDays: config.tierDays,
  tierBuckets: config.tierBuckets,
  tierCheckSeconds: config.tierCheckSeconds,
  // Which folders the board scans, as config.json states them, plus whether the fallback is the one in force. It
  // travels with every snapshot for the same reason the column list does: the Settings list is drawn from this fact,
  // and a tab opened before another browser (or a hand edit) moved it has to agree with the file.
  scanRootsConfigured: config.scanRootsConfigured || [],
  scanRootsFallback: config.scanRootsFallback === true,
  // The folder an empty list means, named rather than derived on the page: the Settings tab says which folder is
  // scanned instead, and a page that worked it out for itself could name a different one after a move.
  scanRootsFallbackPath: DEFAULT_SCAN_ROOT,
  scanVisible: scheduler ? scheduler.visibilityReport() : null,
  // Whether a branch may exist on a remote at all. It travels with every snapshot because the Settings row, the
  // spawn card's default and the permission box all read the same fact — and the guard's own copy of it is written
  // from here too, so a hook cannot be reading a different policy than the page shows.
  remoteBranchPolicy: config.remoteBranchPolicy,
  remoteBranchPolicyLabel: policyLabel(config.remoteBranchPolicy),
  // The policy actually in force per project, because the global is only the default: a project's own entry in
  // config.json (this panel, heroes-js) overrides it, and the page must be able to say which repo is which.
  remoteBranchPolicies: Object.fromEntries(
    (registry?.projects || []).map((p) => [p.name, policyForProject(p, config.remoteBranchPolicy)]),
  ),
  // The TWO push controls: one for a new branch, one for an existing one, each one of
  // allow-all / allow-name-gate / always-ask / never. `pushPermissions` carries the four values, every repository
  // section, and every project's resolved pair; the page draws the card's selects and the Settings → Repo tab from
  // it and never re-derives precedence. The legacy `remoteBranchPolicy` below is still READ for the brief paragraph
  // (lib/jobs.js) and reported by the Permissions tab, but it no longer decides a push.
  pushPermissions: pushPermissionsOut(),
  remoteWriteSeconds: config.remoteWriteSeconds,
  // Whether an agent may take a worktree off the disk by itself once its work has landed, and which projects that
  // would actually apply to. The switch is the board's veto; the list is the projects that carry their own
  // `releaseWorktrees` grant. Both travel with the snapshot so the Settings row can say what is really in force
  // instead of implying that "on" means every repository is open.
  agentCleanup: agentCleanupFrom(config.agentCleanup),
  releaseProjects: (registry?.projects || []).filter((p) => releasesEnabled(p)).map((p) => p.name),
  spawnEnabled: true,
});

// ---- which folders the board scans ------------------------------------------------------------------------------
// `scanRoots` is the one setting the board is literally made of: every git repo under these folders is a project, and
// the page draws one card per folder. Until this route existed it could only be changed by editing config.json and
// restarting, which is why the board could only ever draw the one card the file happened to name.
//
// The answer carries BOTH lists on purpose. `scanRoots` is what discovery walks (the fallback included), while
// `scanRootsConfigured` is what the file says and `scanRootsFallback` says the file names none — an empty board with
// no explanation reads as a bug, and the Settings tab needs the second pair to say which folder is being scanned
// instead. `scanRootsDetail` is per-row existence, so a folder that has been moved or deleted since it was added says
// so in the list rather than vanishing into a silent empty card.
async function scanRootsOut() {
  const detail = [];
  for (const p of config.scanRootsConfigured || []) {
    let exists = false;
    try {
      exists = (await stat(p)).isDirectory();
    } catch {
      exists = false;
    }
    detail.push({ path: p, exists });
  }
  return {
    scanRoots: config.scanRoots || [],
    scanRootsConfigured: config.scanRootsConfigured || [],
    scanRootsFallback: config.scanRootsFallback === true,
    scanRootsFallbackPath: DEFAULT_SCAN_ROOT,
    scanRootsDetail: detail,
  };
}

// Every entry is checked, not just the new one: the route REPLACES the list, so a body is the whole truth about what
// the board will scan. Each refusal names the entry it is about — "invalid scan root" over a list of five folders
// leaves the reader guessing which one, and the reader here is a person typing paths.
async function readScanRootsBody(body) {
  const raw = body?.roots;
  if (!Array.isArray(raw)) return { error: "roots must be an array of folder paths (send [] to scan the panel's own parent folder)" };
  const out = [];
  const seen = new Map();
  for (const entry of raw) {
    const given = String(entry ?? "").trim();
    if (!given) continue; // a blank row in the list is not an error, it is a row nobody filled in
    const p = normRoot(given);
    if (!path.isAbsolute(p)) {
      return { error: `${given} is not an absolute path — name the whole folder, starting at the drive or the root` };
    }
    let st;
    try {
      st = await stat(p);
    } catch {
      return { error: `no such folder: ${given}` };
    }
    if (!st.isDirectory()) return { error: `${given} is not a folder — it is a file, and only folders can be scanned` };
    // Windows paths are case-insensitive and both slash forms are in use on this box, so "the same folder" is the
    // normalised, lowercased path. A duplicate is refused rather than silently collapsed: the list is short enough to
    // read, and a row that quietly disappears when the reader adds it again is worse than a sentence.
    const key = p.toLowerCase();
    if (seen.has(key)) return { error: `${given} is already in the list (as ${seen.get(key)})` };
    seen.set(key, p);
    out.push(p);
  }
  return { roots: out };
}

// The Matrix bridge the Gateway tab owns. One instance, constructed once: the pid file, the log and the last
// `--self-test` are facts about THIS process's child, so a second object would be a second truth. Its boot spawn
// is fired from the listen callback below, once the port is bound — the panel comes up first, and a bridge that
// cannot start surfaces as `state().boot` on the Gateway tab rather than in a log line nobody reads.
const matrixBridge = new MatrixBridge({ config, onLog: log });

// The policy the Bridge tab edits and the bridge turn carries. One store, one file, one precedence rule
// (panel text > WTGUI_MATRIX_POLICY > the template); `statePaths` derives the file so a sandbox and a real
// install cannot disagree about where it lives. It never touches bridge.env.
const matrixPolicy = new MatrixPolicyStore({
  file: statePaths(config).matrixPolicyFile,
  env: process.env,
  template: matrixPolicyTemplate(),
});

// The bridge's reminders, beside that policy and distinct from it: the policy is how it speaks, this is what it
// was asked to remember. `watches` is a GETTER over the Assistant's own list, so the read-only view is current on
// every request; nothing in this store can write it, and the route refuses a body that asks it to.
const matrixReminders = new MatrixRemindersStore({
  file: statePaths(config).matrixRemindersFile,
  watches: () => assistant?.watches || [],
});

// ---- the Element room: every wait on a person, over the bridge above -----------------------------------------
// The panel's third surface for a human decision, and the only one that is not this page. A clarify card, a run's
// approval and the permission box above all go out through the bridge that is ALREADY running — its `outbox.txt`
// for what leaves, its own stdout log for what arrives — and the letter that comes back is applied through the
// same control call the card's button posts. One message per wait, edited in place as it resolves; a send that
// fails is a record on the Gateway tab's Element block instead of a log line nobody reads.
//
// The channel is handed the SAME `matrixBridge.state()` the Gateway tab draws, so "the bridge is running" means
// one thing on this panel: the OS's verdict on the pid the panel recorded, never the existence of a file.
const element = new ElementChannel({
  config,
  jobs,
  approvals,
  assistant,
  getProjects: () => registry.projects,
  getRows: rowsWithProject,
  bridge: createBridgeChannel({ config, status: () => matrixBridge.state() }),
  onLog: log,
  onEvent: broadcast,
});
// One pass every few seconds: the waits that appeared go out, the ones that resolved close in place, and the
// room's replies are read. The module serialises its own passes, so a slow send delays the next pass rather
// than producing a second message; a failure is logged and the block still shows the record.
setInterval(() => {
  void element.sweep().catch((e) => log(`element: sweep failed: ${String((e && e.message) || e)}`));
}, 3_000).unref?.();

const normPathKey = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// ---- renaming a worktree ---------------------------------------------------------------------
// A tree is cut from the prompt, so its name is the prompt: cut at 24 characters, usually mid-word, and about what the
// reader typed rather than what the agent worked out it was doing. Renaming it is the directory and the branch plus
// the panel's own bookkeeping - the jobs that ran there (a run's body carries its cwd), the store's row, and the row
// the board draws.
//
// A tree is named ONCE, and the record of that (who, when — lib/tree-names.js, constructed above) is what stops a
// name churning. There are exactly two ways a name is written: the automatic half (`once: true`, from the run that
// CUT the tree, the moment its session title first exists) and the deliberate half (the ✎ in the row, i.e.
// a reader asking), which may replace a name because replacing a name is the point of it. A tree the panel found
// rather than cut is seeded under the name it was found with and is never the automatic half's to move. Either way
// the six-hex tag is kept and the 409 stands while an agent is running in the tree.
//
// Seeding is what makes the first of those safe. Every tree the panel enumerates and has never recorded is written
// down under its CURRENT name, attributed to the panel, before a run can be offered the chance to rename it: the
// fleet that existed when the ledger shipped has no entry, and "no entry" used to read exactly like "a tree waiting
// for its one name" — so nothing but the job's own `existing` flag stood between those trees and a rename, and a flag
// set wrong moved a tree the reader considers fixed.
function seedTreeName(project, tree) {
  try {
    const dir = String(tree?.path || "").replace(/\\/g, "/").replace(/\/+$/, "");
    if (!dir) return false;
    // The project's own checkout is not a tree the panel names, and `renameWorktree` refuses it by this same
    // comparison. A record for it would also put "named by the panel" on the one row whose name is the folder's.
    if (normPathKey(project?.path) && normPathKey(project.path) === normPathKey(dir)) return false;
    const name = path.basename(dir);
    const branch = String(tree?.branch || "").replace(/^refs\/heads\//, "") || null;
    const key = treeKey({ project: project?.name, path: dir, branch });
    const rec = treeNames.seed(key, {
      name,
      dir,
      branch,
      tag: tagOf(dir) || tagOf(branch) || null,
      by: "the panel",
      how: "seeded — this tree was already here the first time the panel listed it, so its name is the one it had",
      at: new Date().toISOString(),
    });
    if (rec) log(`tree-names: seeded ${project?.name || "?"}::${name} as it was found — this name is fixed`);
    return Boolean(rec);
  } catch (e) {
    log(`tree-names: could not seed ${tree?.path || "a tree"}: ${String((e && e.message) || e)}`);
    return false;
  }
}

// One `git worktree list` per project at boot, so the fleet that predates the ledger is written down before the
// first job event is considered for naming. Bounded in time and width, and it never rejects: a project whose git
// cannot answer is seeded by its own discovery pass instead, which calls the same hook on every listing.
async function seedTreeNamesAtBoot({ timeoutMs = 30_000, width = 4 } = {}) {
  const started = Date.now();
  const projects = (registry.projects || []).slice();
  let next = 0;
  let seeded = 0;
  const lane = async () => {
    while (next < projects.length && Date.now() - started < timeoutMs) {
      const project = projects[next++];
      if (!project?.path) continue;
      try {
        const trees = await worktreeList(project.path);
        for (const t of trees) if (seedTreeName(project, t)) seeded += 1;
      } catch {
        /* no answer from git here: discovery will seed this project's trees on its next listing */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(width, projects.length)) }, lane));
  if (seeded) log(`tree-names: ${seeded} tree(s) had no record and now do — their names are fixed from here`);
  else log(`tree-names: ${treeNames.size} tree(s) on record, nothing to seed at boot`);
  return seeded;
}

// Started here, before the job store is constructed: a restored run's event can name a tree the moment the store
// loads, and that must not beat the seeding. WorktreeNaming awaits this before it decides anything.
const treeNamesReady = seedTreeNamesAtBoot();

// Where every tree the panel cuts was cut from (lib/parents.js), and the ledger of trees nobody can place. Both are
// read by the /api/state row through the scheduler's scan context, so the board and the steward never disagree.
const parents = new ParentBook({ file: config.parentsFile, onLog: log });
const questions = new Questions({ file: config.stewardQuestionsFile });

const descriptions = createDescriptions({
  getConfig: () => config,
  // The RAW maps, not list()/rowsFor(): the earliest brief in a tree needs `prompt` and `startedAt`,
  // which those projections trim on purpose.
  getJobs: () => jobs.jobs,
  getRows: () => store.rows,
  normPathKey,
  snapshot,
  broadcast,
  guard,
  log,
});

// The trees this panel may NAME — a path, a directory name, a branch, a six-hex tag, a thread. Read per question, never
// captured: a rename moves a row and every store that answers a name must see the new one. Shared by the TODO store
// and the release store (lib/worktrees.js), so both resolve a slug against exactly the same list.
function panelTrees() {
  const out = [];
  const seen = new Set();
  for (const p of registry.projects || []) {
    const key = `${p.name}::${normPathKey(p.path)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ project: p.name, path: String(p.path || "").replace(/\\/g, "/"), branch: null });
  }
  for (const [rowKey, row] of store.rows) {
    const project = String(rowKey).split("::")[0];
    const n = `${project}::${normPathKey(row.path)}`;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push({ project, path: String(row.path || "").replace(/\\/g, "/"), branch: row.branch || null });
  }
  return out;
}

// ---- a turn on an existing thread, and the stage timer's wake -------------------------------------------------------
// A reply continues the SAME agent: same thread, same tree, same model, and the same paragraph about where that tree's
// branch goes. The stage timer's wake is that turn too (docs/pipelines.md §6), so both go through this one function —
// a wake that went through a second copy of the reply path would be a turn with a different tree, model or landing
// paragraph than a reader's reply. `{status, body}` is exactly what the route sends.
async function startThreadReply({ thread = "", text = "", displayPrompt = null, origin = null, model = undefined, budget = undefined, maxTurns = undefined, yolo = undefined } = {}) {
  const said = String(text || "").trim();
  if (!said) return { status: 400, body: { error: "reply text is required" } };
  const first = jobs.firstOfThread(String(thread || ""));
  if (!first) return { status: 404, body: { error: `unknown thread: ${thread}` } };

  // Run where the agent actually is: the tree that agent was created for, and only while that is still a tree of its
  // own. This used to be a `stat(…).isDirectory()` test with a fall back to `first.cwd` — the same dead path — which
  // is how a reply started a run in a released tree whose shell then worked in the PRIMARY checkout (0.62.1 boot: job
  // 5ba56bf1). 409 is the shape the busy-thread refusal already uses: the request is well formed, it just cannot run
  // in that tree. See lib/own-tree.js.
  const tree = await replyTree(first);
  if (!tree.ok) {
    return {
      status: 409,
      body: {
        error: `${first.thread}: ${tree.refusal} — nothing was sent and no run was started. A resume is not a new tree.`,
        code: "tree_released",
        tree: tree.named,
        checkout: tree.instead || tree.outer || null,
      },
    };
  }
  const dir = tree.dir;
  const home = projectOfTree(dir);
  const job = await jobs.create({
    prompt: said,
    displayPrompt: displayPrompt ? String(displayPrompt) : null,
    thread: first.thread,
    reply: true,
    // Set when the panel is delivering subagent results, or when the stage timer's wake caused this turn: the card
    // says what caused it.
    origin,
    resumeDir: dir,
    cwd: dir,
    // A model picked on the card wins; otherwise the thread's own choice, then whatever the first turn used.
    model: model ?? jobs.modelFor(first.thread) ?? first.model,
    budget: budget ?? first.budget ?? 1800,
    maxTurns: maxTurns ?? first.maxTurns,
    yolo: yolo ?? first.yolo,
    // A reply continues the SAME agent, so it keeps the tree that agent was created for.
    ownerPath: first.ownerPath || null,
    // …and the paragraph about where that tree's branch goes has to quote the policy of ITS project, and its remote,
    // the way the spawn did. A reply that carried neither fell back to the global default and told a worker in a
    // project that ALLOWS pushes that a push "will park and then fail".
    branchPolicy: policyForProjectPath(home?.path || dir, home),
    // …and whether this project's per-remote switch means that paragraph should say the push is not asked about.
    allowPushWithoutAsking: allowPushWithoutAskingForPath(home?.path || dir, home).enabled,
    remote: home?.remote || null,
  });
  // A delivery turn closes the offer on the turn it answers, for every reader and every reload.
  if (origin && origin.fromTurn) jobs.markCollected(origin.fromTurn, job.id);
  return { status: 202, body: { job } };
}

// ---- the stage timer: the host read, the wake, and the one ticker ---------------------------------------------------
// A waiting stage costs a host read and, when there is something to answer, one short turn. Nothing here holds a run
// slot, sleeps or polls in a loop: the record's own `every` (1h → 2h → 4h) is the clock, and a tick that finds no due
// record is one walk of the tree book.

// What the PR says, for one due wait. The PR is found by the branch stored WITH the wait (lib/pipelines.js
// `reviewWaitFor`), through the same index the board's PR cell uses; the state and the comments are the host's own
// answer, normalised to the one observation shape by lib/pipelines.js. Every failure is `{ok:false, why}` — never an
// empty PR, which would read as "nothing arrived" and back a reviewer off for hours on a response we could not parse.
async function readReviewForPipelineWait({ tree, record, stage, wait }) {
  const project = projectOfTree(tree);
  if (!project) return { ok: false, why: `${tree} is not inside a known project, so the PR its branch has cannot be read` };
  const branch = String(wait?.branch || "").trim();
  if (!branch) return { ok: false, why: "the wait record names no branch, so its pull request cannot be found" };
  let pr = null;
  try {
    const index = await prIndex(project, 60, hosts);
    pr = prFor(index, branch, { tip: await jobs.headSha(tree), base: project.mainBranch });
  } catch (error) {
    return { ok: false, why: `the PR list for ${project.name} could not be read (${String((error && error.message) || error)})` };
  }
  if (!pr || pr.number == null) return { ok: false, why: `no pull request for ${branch} in ${project.name}` };

  const listing = prListing(docOf(hosts), project);
  if (!listing.url) return { ok: false, why: listing.why || `host "${project.host || "?"}" has no pull-request endpoint` };
  const coords = listing.coordinates || {};
  try {
    if (listing.transport === "gh") {
      if (!coords.owner || !coords.repo) return { ok: false, why: `gh needs owner and repo coordinates, the host record supplies ${JSON.stringify(coords)}` };
      const { stdout } = await execP(
        "gh",
        ["pr", "view", String(pr.number), "--json", "state,headRefOid,reviewRequests,reviews,comments", "--repo", `${coords.owner}/${coords.repo}`],
        { cwd: project.path, timeout: 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      );
      return observeGithubPr(JSON.parse(stdout || "{}"), { number: pr.number });
    }
    const token = listing.tokenEnv ? process.env[listing.tokenEnv] : null;
    if (!token) return { ok: false, why: `no token in ${listing.tokenEnv || "(api.tokenEnv is not set)"} — the pull request cannot be read` };
    const values = { base: listing.mapping?.base, projectKey: coords.projectKey, repoSlug: coords.repoSlug, pr: pr.number };
    const base = renderTemplate("{base}/rest/api/1.0/projects/{projectKey}/repos/{repoSlug}/pull-requests/{pr}", values);
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    const [recordRes, activitiesRes] = await Promise.all([
      fetch(base, { headers, signal: AbortSignal.timeout(20000) }),
      fetch(`${base}/activities?limit=100`, { headers, signal: AbortSignal.timeout(20000) }),
    ]);
    if (!recordRes.ok) return { ok: false, why: `HTTP ${recordRes.status} from ${base}` };
    if (!activitiesRes.ok) return { ok: false, why: `HTTP ${activitiesRes.status} from ${base}/activities` };
    return observeBitbucketPr(await recordRes.json(), await activitiesRes.json());
  } catch (error) {
    return { ok: false, why: `the pull request could not be read: ${String((error && error.message) || error)}` };
  }
}

// The holes a stage's prompt is rendered with (§1.4, the closed list). Everything here is read from the tree and its
// project; `pr` and `sha` come from the read that caused the advance. `desc`/`ticket` are NOT invented: a stage that
// needs one of them refuses to start (lib/pipelines.js `renderPrompt`) and the log names the hole, which is the rule
// for every rendered prompt in this panel.
function pipelinePromptValues({ tree, record, stage, next, observation, wait }) {
  const project = projectOfTree(tree) || {};
  const listing = project.name ? prListing(docOf(hosts), project) : { id: null };
  return {
    tree,
    branch: String(wait?.branch || "").trim() || null,
    main: project.mainBranch || null,
    project: project.name || null,
    remote: project.remote || null,
    host: listing.id || project.host || null,
    pr: observation?.pr?.number ?? null,
    sha: observation?.pr?.headRefOid || null,
    lastSeen: String(wait?.lastSeen || record?.since || "").trim() || null,
  };
}

// The wake: the reply path above, and a refusal is a value the sweep logs rather than a 500. The turn is marked as
// caused by the stage timer, so a card that seems to answer itself says who did it.
async function wakePipelineThread({ thread, text, displayPrompt, reason }) {
  if (!thread) return { ok: false, code: "no-thread", error: "the wait record names no thread — there is nothing on the board to wake" };
  try {
    const out = await startThreadReply({ thread, text, displayPrompt, origin: { pipelineWait: true, reason: String(reason || "") } });
    if (out.status !== 202) return { ok: false, code: out.body?.code || `http-${out.status}`, error: String(out.body?.error || "") };
    return { ok: true, job: out.body.job };
  } catch (error) {
    return { ok: false, code: "threw", error: String((error && error.message) || error) };
  }
}

// ONE interval for every waiting tree — never one timer per tree, the way the scheduler drives the scans. A minute is
// fine grain: the record's own `every` is the real clock, and a tick that finds nothing is a walk of the tree book. The
// timer is unref'd, so it never keeps the process (or a test) alive on its own.
const PIPELINE_WAIT_TICK_MS = 60 * 1000;
let pipelineWaitTimer = null;
async function tickPipelineWaits({ now = Date.now() } = {}) {
  try {
    const out = await jobs.sweepPipelineWaits({
      now,
      readReview: readReviewForPipelineWait,
      wake: wakePipelineThread,
      promptValues: pipelinePromptValues,
      // The second kind of wait: a stage's own run, held in the book by the cut. The sweep reads the job store and, once
      // the run is no longer live, hands the row to the ONE advance seam — the assistant's pipeline driver, the same one
      // the queue tick runs, so the graph rules (a cap, a gate, a refusal) are never re-implemented here.
      advance: (item) => (assistant && typeof assistant.advancePipelineTree === "function" ? assistant.advancePipelineTree(item.tree) : { ok: false, error: "no pipeline driver is attached — the hold was cleared and nothing advanced" }),
    });
    if (out.checked || out.errors.length) {
      log(
        `pipeline waits: ${out.checked} due — ${out.advanced} advanced, ${out.woke} woke, ${out.held} held, ${out.rescheduled} rescheduled, ${out.closed} closed, ${out.refused} refused` +
          `${out.errors.length ? `, ${out.errors.length} error(s): ${out.errors.map((e) => e.error).join("; ")}` : ""}`,
      );
    }
    return out;
  } catch (error) {
    log(`pipeline wait tick failed: ${String((error && error.message) || error)}`);
    return null;
  }
}

function startPipelineWaitTicker() {
  if (pipelineWaitTimer) return;
  pipelineWaitTimer = setInterval(() => void tickPipelineWaits(), PIPELINE_WAIT_TICK_MS);
  if (typeof pipelineWaitTimer.unref === "function") pipelineWaitTimer.unref();
  log(`pipeline waits: one ticker every ${PIPELINE_WAIT_TICK_MS / 1000}s — a waiting stage costs a host read, never a parked run`);
}

function stopPipelineWaitTicker() {
  if (!pipelineWaitTimer) return;
  clearInterval(pipelineWaitTimer);
  pipelineWaitTimer = null;
}

// ---- the TODO list of each worktree --------------------------------------------------------------------------------
// Written by the assistant (a `TODO <text>` line, normally under the SPAWN that starts the work), kept current by
// every agent in the tree (a run's FINAL message is harvested when it settles), and read by the row. ONE store for
// the whole panel, keyed the way the row already is (`keyOf(project, path)` — `${project}::${path}` in
// public/app.js), and never a file inside the worktree: it is state, not source, and a file in the tree would be git
// noise and a merge conflict. Every writer goes through this one Node process, so the store is its own lock.
const todos = new TodoLists({
  file: config.todosFile,
  log,
  trees: panelTrees,
  // …and the job store, so a THREAD can name its tree (that is how the assistant points a TODO line at a card).
  jobs: () => jobs,
});
// The two writers that need the store: lib/jobs.js prepends the list to a worker's brief and harvests the run's own
// last words; the assistant seeds a tree and keeps the list honest against what a worker actually did.
jobs.todos = todos;
// The parent book: the panel records every tree it cuts (lib/jobs.js), the scheduler hands the answer to each scan so
// the row carries it, and the steward + the UNMERGED chip read it from there.
jobs.parents = parents;
// The pipeline record book: the cut writes `{id: "local", stage: "work", …}` into it before the run is posted, a
// switch rewrites it through POST /api/worktree/pipeline, and every card reads its tree's entry back.
jobs.pipelineRecords = pipelineRecords;
// …and the catalogue, because a stage timer has to read the stage's EXIT before it can know the stage is waiting on a
// reviewer at all (lib/jobs.js `registerPipelineWait`). Injected here rather than imported there: lib/jobs.js owns no
// catalogue file, the same way it owns no worktree.
jobs.pipelines = pipelines;
scheduler.parents = parents;
if (assistant) {
  assistant.todos = todos;
  // …and the one thing the assistant cannot do itself: tell the page a list moved. The assistant's own TODO lines are
  // applied inside its harvest, which has no SSE handle of its own.
  assistant.todosChanged = broadcastTodos;
}

// ---- what each row's own reconcile found ---------------------------------------------------------------------------
// The journal the row's ⟳ writes: one line per action ("verdict MERGED -> UNMERGED", "0 -> 3 ahead", "1 item looks
// closed"), kept per row beside the stores above. The row's detail reads the newest few from the snapshot, so a click
// leaves a record the reader can come back to instead of a flash that is gone in a second.
const refreshLog = new RefreshJournal({ file: config.refreshFile, log });

// ---- the release requests a finished worker leaves behind ------------------------------------------------------------
// A worker can never remove its own tree: its cwd is inside it, and on Windows an open handle keeps the directory
// busy. So it asks — ONE `RELEASE <tree> | <why it is finished>` line in its FINAL message — and lib/jobs.js records
// the request here as the turn ends, against the tree's row. `sweepReleases()` below is the ONLY thing that acts on
// one, after the run settled, and lib/worktrees.js refuses unless every gate passes on evidence this process measured
// itself (clean tree, PR MERGED, nothing the landed commit does not already contain, no job still holding it). No path
// inside a run reaches the executor, so an agent cannot evict the tree it is standing in.
const releases = new ReleaseRequests({ file: config.releasesFile, log, trees: panelTrees });
jobs.releases = releases;
// The paragraph that tells a worker it MAY ask for its tree (lib/jobs.js RELEASE_BRIEF), handed over only for a
// project whose `releaseWorktrees` is on: telling a worker about a marker the panel would refuse at its first gate is
// a paragraph of noise, and one that reads as an instruction the board will not honour.
jobs.releaseBrief = (opts) => {
  // The board's veto first: with it off no prompt carries the paragraph at all, so a worker is never told about
  // a marker the executor would refuse.
  if (!agentCleanupFrom(config.agentCleanup)) return "";
  const record = (registry.projects || []).find((p) => p.name === opts?.project) || null;
  return releasesEnabled(record) ? RELEASE_BRIEF : "";
};

// ---- the deliverables every agent on this panel handed back ---------------------------------------------------------
// `DELIVER <link|file|image> <target> | <title>` in a run's FINAL message, read at settle by `Jobs.measureTree` via
// `Jobs.harvestDeliverables` (lib/deliverables.js holds the grammar, the store and the cap). Read by the board's
// DELIVERABLES button through the two routes below; the store is handed `panelTrees` for the same reason the TODO and
// release stores are, and here it does one visible thing: a row's project/tree/branch are re-resolved at read time by
// the six-hex tag, so an auto-rename moves the row with the tree instead of leaving it pointing at a name that is gone.
const deliverables = new Deliverables({ file: config.deliverablesFile, log, trees: panelTrees });
jobs.deliverables = deliverables;
// One SSE frame per delivery, so a list open in another tab (or this one) gains its row without a reload. The frame is
// a summary only — the page re-reads the store — and it is wired here so the store never learns what a socket is.
deliverables.onChange = (entry) =>
  broadcast({ type: "deliverable", seq: entry.seq, kind: entry.kind, title: entry.title, at: entry.at });

// ---- what a deliverable's Open control can open, and as what ----------------------------------------------------
// One classification, decided HERE and used by both routes, so the page and the server cannot disagree about what a
// click means:
//
//   link           → the URL. A tab in the reader's own browser: the panel never fetches it, never asks whether it
//                    answered, and never launches a browser for it. `chromeFor` is reached only when the page reports
//                    that the tab was blocked — the one host the panel still acts for.
//   served path    → a file under this panel's `public/`, which HAS a URL on the panel. Also a tab.
//   file in a repo → no URL at all, so the browser cannot render it: the existing route hands it to the OS default
//                    handler, which is the opener it has always used.
//   nothing else   → refused, and the reason is said on the card. No second route, no second opener.
//
// `href` is the one field the page needs: the tab's URL, or null when there is no tab. No path is ever turned into a
// URL on the page, and the page never sends a path back.
function deliverableHref(entry) {
  if (!entry || !entry.target) return null;
  if (entry.kind === "link") {
    try {
      const url = new URL(String(entry.target));
      return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
    } catch {
      return null;
    }
  }
  const abs = path.resolve(String(entry.target));
  const rel = path.relative(PUBLIC_DIR, abs);
  // `..` out of the served root, or the root itself, is not a URL of ours. The file is stat'ed HERE as well: a
  // served file that is gone must not become a tab to a 404 — the route's own 404 sentence is what the card shows.
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  try {
    if (!statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  return `/${rel.split(path.sep).map(encodeURIComponent).join("/")}`;
}

// The repository a delivered file belongs to: the TREE the store recorded for it, which is the checkout the panel
// measured when the run settled, and the same base `resolveTarget` resolved a relative target against. A path outside
// it is refused — a deliverable is the file an agent put in its own tree, never an arbitrary file on the machine.
// A record with no tree (older than the field, or hand-written) falls back to the nearest checkout above the file;
// a worktree carries a `.git` FILE and a clone a `.git` DIRECTORY, and both are a repo.
function deliverableRepoRoot(entry) {
  const tree = String((entry && entry.treePath) || "").replace(/\/+$/, "");
  if (tree) return tree;
  let dir = path.dirname(String((entry && entry.target) || ""));
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// Is `target` the root or under it? Case-folded with forward slashes, the house `pathKey` rule: this panel runs on
// Windows, where one folder has two spellings, and a boundary that can be dodged by capitalisation is not one.
function insideRepo(target, root) {
  const a = path.resolve(String(target || "")).replace(/\\/g, "/").toLowerCase();
  const b = path.resolve(String(root || "")).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  if (!b) return false;
  return a === b || a.startsWith(`${b}/`);
}
// One sentence for a console line: whitespace collapsed, and cut where the panel always cuts (a trailing ellipsis, so
// a truncated sentence never reads as a finished one).
const oneLine = (s, n = 200) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// What the row carries: the tree, when it was asked for, by which run, why, and the executor's answer — `removed`, or
// `refused: <the gate that said no>`. A tree nobody has asked about carries no `release` field at all.
function withReleases(snap) {
  for (const project of snap.projects || []) {
    for (const row of project.worktrees || []) {
      const rec = releases.forRow(project.name, row.path);
      if (!rec) {
        delete row.release;
        continue;
      }
      row.release = rec;
    }
  }
  return snap;
}

// The executor's clock. One pass at a time, a pass shortly after any turn settles, and a slow tick for a request that
// arrived while the panel was busy — a `removed` or `refused:` outcome is final, so a pass only ever looks at requests
// nothing has answered yet. The gates come first, so a request with the project's switch off is refused here and
// nothing on disk is touched.
let releaseSweepBusy = false;
async function sweepReleases(reason = "tick") {
  if (releaseSweepBusy) return [];
  const pending = releases.pending();
  if (!pending.length) return [];
  releaseSweepBusy = true;
  const done = [];
  try {
    for (const request of pending) {
      const project = scheduler.getProjects().find((p) => p.name === request.project) || projectOfTree(request.path);
      if (!project) {
        releases.finish(request.key, { outcome: `refused: no project owns ${request.path}` });
        done.push({ request, outcome: `refused: no project owns ${request.path}` });
        continue;
      }
      const row = scheduler.store.rowsFor(project.name).find((r) => normPathKey(r.path) === normPathKey(request.path)) || null;
      let out = null;
      try {
        out = await releaseWorktree({ project, request, row, jobs, locks, log, cleanup: config.agentCleanup });
      } catch (e) {
        out = { ok: false, outcome: `refused: the executor failed — ${String((e && e.message) || e)}`, detail: "", steps: [] };
      }
      releases.finish(request.key, { outcome: out.outcome, detail: out.detail, steps: out.steps });
      // One line on the card that asked, so the sentence outlives the row it was written on. `panel:` is the panel's
      // own voice in the console, next to the `⇢ RELEASE requested` line the request left there.
      const asked = request.runId ? jobs.get(request.runId) : null;
      if (asked) {
        jobs.push(asked, {
          kind: out.ok ? "dim" : "raw",
          text: `panel: release of ${request.path} — ${out.outcome}${out.detail && !out.ok ? ` (${oneLine(out.detail, 200)})` : ""}`,
        });
        jobs.emit(asked);
      }
      done.push({ request, outcome: out.outcome, ok: Boolean(out.ok) });
      log(`release ${request.path}: ${out.outcome}${reason ? ` (${reason})` : ""}`);
    }
  } finally {
    releaseSweepBusy = false;
    if (done.length) {
      broadcast({ type: "snapshot", data: snapshot() });
      for (const item of done) {
        // The row of a removed tree is left for the next scan to drop (it drops a row whose folder is gone); a refusal
        // keeps its row, because that row is where the reader reads why.
        if (item.ok) log(`release ${item.request.path}: the row goes on the next scan`);
      }
    }
  }
  return done;
}

// The hook the job stream calls, collapsed into one pass per couple of seconds: a turn emits many events and only the
// settle matters.
let releaseSweepTimer = null;
scheduleReleaseSweep = (delayMs = 2000) => {
  if (releaseSweepTimer) return;
  releaseSweepTimer = setTimeout(() => {
    releaseSweepTimer = null;
    void sweepReleases("turn settled").catch(() => {});
  }, Math.max(0, Number(delayMs) || 0));
  if (releaseSweepTimer.unref) releaseSweepTimer.unref();
};

// What the row's own ⟳ found last time travels with the snapshot too, newest first: a click's record is read from here,
// so a reload comes back to the same journal instead of losing it with the page.
function withRefreshJournal(snap) {
  for (const project of snap.projects || []) {
    for (const row of project.worktrees || []) {
      const key = store.rowKey(project.name, row.path);
      const lines = refreshLog.recent(key, REFRESH_LINES_SHOWN);
      if (!lines.length) delete row.refreshJournal;
      else row.refreshJournal = lines;
    }
  }
  return snap;
}

// The list travels with the snapshot the way a description does: the row carries the counts, the OLDEST incomplete
// item (the one thing the collapsed strip reads) and the items themselves. A tree with no list carries no `todo`
// field at all, so the section is simply absent rather than an empty box.
function withTodos(snap) {
  for (const project of snap.projects || []) {
    for (const row of project.worktrees || []) {
      const rec = todos.forRow(project.name, row.path);
      if (!rec) {
        delete row.todo;
        continue;
      }
      row.todo = rec;
    }
  }
  return snap;
}

// A list that changed is a row that changed: the same full snapshot the description harvest sends, so the strip
// repaints without waiting for the next scan to happen to mention that row.
function broadcastTodos() {
  broadcast({ type: "snapshot", data: snapshot() });
}

// What the page says after a reader's own press. It names the item and the id, because the id is what the assistant
// and every worker are told to write, and a press that says nothing is a press the reader cannot trust.
function todoSay(op, item) {
  if (!item) return null;
  const id = `#${item.id}`;
  if (op === "add") return `added ${id}: ${item.text}`;
  if (op === "edit") return `${id} rewritten`;
  if (op === "note") return item.note ? `${id} note saved` : `${id} note cleared`;
  if (op === "files") return `${id} files ${item.files?.length ? `set to ${item.files.join(", ")}` : "cleared"}`;
  if (item.status === "done") return `${id} done`;
  if (item.status === "dropped") return `${id} dropped`;
  if (item.status === "doing") return `${id} claimed — doing`;
  return `${id} reopened`;
}

// The two events that can add what a harvest needs — a row written by a scan, a job arriving or changing — plus one
// pass at boot, because a panel started over a store whose trees were all scanned long ago has no row event coming.
store.onEvent((evt) => {
  if (evt?.type === "row") descriptions.harvest();
});
descriptions.harvest(2500);

function worktreeDirName(name, tag) {
  // The same rule the cut uses (lib/tree-slug.js): whole words, cut between them. An empty name still yields an
  // empty directory name, which the callers read as "nothing to rename to".
  const slug = String(name ?? "").trim() ? treeSlug(name) : "";
  return slug ? `${slug}-${tag}` : "";
}

// The main checkout of a repository is the one whose git dir IS the repository (`.git`), not a link into another
// tree's (`.git/worktrees/<name>`). Asked of git rather than inferred from a path, so a checkout reached by a
// different spelling, or a project whose registry path is not the top of the repo, is still recognised as main.
async function isMainCheckout(dir) {
  const gitDir = await execP("git", ["-C", dir, "rev-parse", "--absolute-git-dir"], { timeout: 20_000, windowsHide: true })
    .then((r) => String(r.stdout || "").trim())
    .catch(() => "");
  return Boolean(gitDir) && normPathKey(path.dirname(gitDir)) === normPathKey(dir);
}

async function renameWorktree({ projectName, target, name, by = null, how = null, once = false, run = null }) {
  const project = scheduler.getProjects().find((p) => p.name === projectName);
  if (!project) return { error: `unknown project: ${projectName}`, status: 404 };
  const oldPath = path.resolve(String(target || ""));
  // The project's own checkout is the parent of every tree cut from it and its name is the folder's name: renaming it
  // would rename the project itself. Matched the way every other path comparison here is (case- and slash-insensitive,
  // because the page, the registry and a scan spell the same directory differently), and again against git so a
  // checkout reached by another spelling still cannot be moved.
  if (normPathKey(oldPath) === normPathKey(project.path) || (await isMainCheckout(oldPath))) {
    return { error: "that is the project's own checkout, not a worktree — its name is the project folder's", status: 400 };
  }
  const row = scheduler.store.rowsFor(projectName).find((r) => path.resolve(r.path) === oldPath);
  if (!row) return { error: `not a worktree row of ${projectName}: ${oldPath}`, status: 404 };
  // A rename keys the naming ledger on the six-hex tag and keeps that tag as the one part of the name it does not
  // rebuild, so a directory carrying none has no identity to rename by — lib/tree-names.js `renameRefusal` has the
  // full reason. Refused here, before anything is claimed or moved, for the automatic half and the deliberate one
  // alike. The old code invented a tag for a bare name, which gave the tree a second identity and a ledger record
  // keyed on a path the rename then moved out from under itself.
  const refusal = renameRefusal(oldPath);
  if (refusal) return { error: refusal, status: 400 };
  const base = path.basename(oldPath);
  // Keep the six-hex tag: it is what tells two trees named alike apart, and it makes a repeated rename a no-op
  // instead of a second suffix. `tagOf` also reads a directory that IS six hex, which is the tag being named.
  const tag = tagOf(base);
  // The tag is also the tree's identity for the naming ledger, and it is the same key before and after a rename —
  // which is exactly what the old in-memory Set of paths could not say, its key going stale the moment the first
  // rename landed. This is the automatic path asking (`once`), so the LEDGER decides: only the run that cut this tree
  // may give it its one name, only until one lands, and a tree that was seeded (found, not cut) or already named has
  // an entry that can never qualify. `job.existing` is never consulted — a flag set wrong is how a tree the reader
  // considers fixed got moved.
  const key = treeKey({ project: projectName, path: oldPath });
  if (once) {
    const named = treeNames.get(key);
    const refusal = autoNameRefusal(named, run);
    if (refusal) {
      return {
        ok: true,
        unchanged: true,
        skipped: refusal,
        named,
        path: oldPath.replace(/\\/g, "/"),
        branch: row.branch || null,
        jobs: 0,
      };
    }
  }
  // ---- the name belongs to the work once there is work --------------------------------------------
  // A tree is named BEFORE its work exists, and that is a rule now rather than a hope. Two gates, both read from git
  // rather than from the store (the store is a scan behind, and a rename is the irreversible half of this):
  //
  //   * the branch is published — it exists on the project's remote. A remote branch and any PR are keyed on the
  //     name, so moving it silently detaches the row from both. Refused even for the row's ✎; the reader can
  //     still rename it themselves.
  //   * the automatic half (`once`) stops at the branch's first own commit. Measured on this board: one tree's
  //     rename landed 95 seconds AFTER its second commit, leaving a directory named one thing and a branch named
  //     another, and 12 of 180 rows sit in that split state. After the first commit the name is part of the work.
  const branchNow = await execP("git", ["-C", oldPath, "symbolic-ref", "--short", "HEAD"], { timeout: 20_000, windowsHide: true })
    .then((r) => String(r.stdout || "").trim())
    .catch(() => "");
  if (project.remote && branchNow) {
    const published = await execP("git", ["-C", project.path, "rev-parse", "--verify", "--quiet", `refs/remotes/${project.remote}/${branchNow}`], { timeout: 20_000, windowsHide: true })
      .then((r) => Boolean(String(r.stdout || "").trim()))
      .catch(() => false);
    if (published) {
      return {
        error: `${branchNow} is already on the remote (${project.remote}/${branchNow}) — its name is published, so the panel will not move it. Rename it yourself with \`git branch -m\` if it really has to change.`,
        status: 409,
      };
    }
  }
  if (once && branchNow) {
    const baseRef = project.remote ? `${project.remote}/${project.mainBranch}` : project.mainBranch || null;
    const ahead = baseRef
      ? await execP("git", ["-C", oldPath, "rev-list", "--count", `${baseRef}..HEAD`], { timeout: 30_000, windowsHide: true })
          .then((r) => Number.parseInt(String(r.stdout || "").trim(), 10))
          .catch(() => Number.NaN)
      : Number.NaN;
    // Unknown is not zero: a branch whose base cannot be read is one the panel cannot prove is empty.
    if (!Number.isFinite(ahead) || ahead > 0) {
      const why = Number.isFinite(ahead)
        ? `the branch already carries ${ahead} commit${ahead === 1 ? "" : "s"} of its own`
        : "the branch's base could not be read, so it cannot be proved to carry no work";
      // Written down, not merely returned: the sweeper asks again after every restart, and a tree this rule spared
      // must not be offered a new name each time. `skipped` keeps it off the board's `named` line — the tree was not
      // renamed, so it must not claim it was (`withTreeNames`).
      const skippedRec = treeNames.record(key, {
        name: base,
        dir: base,
        branch: branchNow,
        tag,
        by: by || "the panel",
        how: `${why} — the name stays`,
        at: new Date().toISOString(),
        skipped: true,
        claimedOnly: false,
        from: base,
      });
      log(`naming ${oldPath}: refused — ${why}; a tree is named before its work is committed, not after`);
      return {
        ok: true,
        unchanged: true,
        skipped: `${why} — a tree is named before its work is committed, not after`,
        named: skippedRec,
        path: oldPath.replace(/\\/g, "/"),
        branch: branchNow,
        jobs: 0,
      };
    }
  }
  const wanted = String(name || "").trim().replace(new RegExp(`-${tag}$`, "i"), "");
  const dirName = worktreeDirName(wanted, tag);
  if (!dirName) return { error: "a name is required", status: 400 };
  const newPath = path.join(project.path, ".worktrees", dirName);
  if (path.resolve(newPath) === oldPath) {
    // Already called that, so there is nothing to move — but the name still has to be settled here, or the automatic
    // half would keep trying the same rename for the rest of the tree's life. Written through settle() so the entry
    // stops being "a cut tree waiting for its one name" whatever it was before.
    const named = treeNames.settle(key, {
      name: dirName,
      dir: dirName,
      branch: row.branch || null,
      tag,
      by: by || "the panel",
      how: how || "already its name",
      at: new Date().toISOString(),
    });
    return { ok: true, unchanged: true, path: oldPath.replace(/\\/g, "/"), branch: row.branch || null, jobs: 0, named };
  }
  const taken = await stat(newPath)
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (taken) {
    // The automatic half spends its one chance HERE rather than trying the same taken name on every later event: the
    // tree is settled under the name it already has, and the row says why. The reader's own rename does not settle
    // anything — a 409 leaves the tree exactly as eligible as it was, and it stays that way until it is renamed.
    if (once) {
      const named = treeNames.settle(key, {
        name: base,
        dir: base,
        branch: row.branch || null,
        tag,
        by: "the panel",
        how: `left under its first name — ${dirName} was already taken`,
        at: new Date().toISOString(),
        collision: true,
        moved: false,
      });
      return {
        ok: true,
        unchanged: true,
        collision: true,
        path: oldPath.replace(/\\/g, "/"),
        branch: row.branch || null,
        jobs: 0,
        named,
        warning: `${dirName} already exists — the tree keeps its first name`,
      };
    }
    return { error: `${dirName} already exists`, status: 409 };
  }
  // A running agent holds the tree as its cwd, and git refuses to move a worktree something is standing in.
  const busy = jobs
    .list()
    .find(
      (j) =>
        isLiveJobStatus(j.status) &&
        [j.cwd, j.ownerPath, j.worktreePath].filter(Boolean).some((p) => path.resolve(p) === oldPath),
    );
  if (busy) return { error: `an agent is running in that worktree (${busy.id}) — stop it first`, status: 409 };
  // Claim it BEFORE the git work, and only for the automatic half: two events of one turn settle within a second of
  // each other, and both of them would otherwise find a tree whose one name has not landed yet. The claim keeps the
  // cut marker (so the tree is still this run's to name if the git work dies with the process) and is settled below
  // once something lands, so a tree is never frozen under a name it did not get.
  if (once) {
    treeNames.record(key, {
      name: dirName,
      dir: dirName,
      branch: row.branch || null,
      tag,
      by: by || "the panel",
      how: how || "the automatic rename",
      at: new Date().toISOString(),
      cut: true,
      cutRun: run || null,
      claimedOnly: true,
      // A claim is a real attempt at a name: clear any earlier `skipped` mark, or a tree that was spared once
      // would keep claiming it had been named and hide its own name from the board.
      skipped: false,
    });
  }
  // The branch the tree is actually on, read BEFORE the directory is moved: after `worktree move` the old path is
  // gone, so the same question asked there can only fall back to the store — and a row that discovery has not
  // scanned yet has no branch at all, which left the directory renamed and the branch behind. Git is the authority
  // and it is asked while it can still answer.
  const oldBranch = await execP("git", ["-C", oldPath, "symbolic-ref", "--short", "HEAD"], { timeout: 20_000, windowsHide: true })
    .then((r) => String(r.stdout || "").trim())
    .catch(() => row.branch || null);
  // Windows will not rename a directory that any process has open, and an agent's shell lives in its tree long after
  // its turn ends — so the directory move is best-effort and the branch rename is the part that lands. Both halves
  // are retried: a file indexer, a scan worker or a ref lock holds one of them for a moment, and one retry each is
  // what keeps a transient lock from leaving a tree's name and its branch disagreeing.
  let moved = false;
  let whyNot = "";
  for (let attempt = 0; attempt < 3 && !moved; attempt += 1) {
    try {
      await execP("git", ["-C", project.path, "worktree", "move", oldPath, newPath], { timeout: 90_000, windowsHide: true });
      moved = true;
    } catch (e) {
      whyNot =
        String((e && e.message) || e)
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
          .pop() || "the directory is held open";
      if (attempt < 2) await new Promise((r) => setTimeout(r, 250));
    }
  }
  const newBranch = `wtgui/${dirName}`;
  let branchRenamed = false;
  if (oldBranch && oldBranch !== newBranch) {
    // A scan running in a worker thread can hold a ref lock for a moment ("cannot lock ref"), and the whole point of
    // this is a name: try again, longer than a scan's tick, before giving up on the branch half.
    for (let attempt = 0; attempt < 6 && !branchRenamed; attempt += 1) {
      try {
        await execP("git", ["-C", project.path, "branch", "-m", oldBranch, newBranch], { timeout: 30_000, windowsHide: true });
        branchRenamed = true;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
  const finalPath = moved ? newPath : oldPath;
  // A locked BRANCH follows its own rename. `git branch -m` keeps the branch's identity — its history and its ref —
  // so a branch the reader locked is the SAME branch under a new name. Leaving the lock on the old name would
  // silently unprotect a turnover branch the moment the panel auto-named a tree on it, which is exactly the case
  // the branch scope exists for. Tied to `branchRenamed`, not to `moved`: the branch half lands on its own when a
  // process holds the directory open, and the protection has to follow whichever half moved.
  const heldBranch = oldBranch ? locks.branchEntry(projectName, oldBranch) : null;
  if (branchRenamed && heldBranch) {
    locks.setBranch(projectName, oldBranch, false);
    locks.setBranch(projectName, newBranch, true, { by: heldBranch.by || "the reader", path: finalPath });
    log(`branch lock follows the rename: ${oldBranch} -> ${newBranch}`);
  }
  if (moved) {
    // A locked tree stays locked when it moves. The lock is keyed by the directory (lib/locks.js), so a rename would
    // otherwise unlock a tree nobody asked to unlock — the old key goes and the new path carries the same record.
    const held = locks.treeEntry(projectName, row.path);
    if (held) {
      locks.setTree(projectName, row.path, false);
      locks.setTree(projectName, finalPath, true, { by: held.by || "the reader", branch: branchRenamed ? newBranch : held.branch || oldBranch });
      log(`lock follows the rename: ${row.path} -> ${finalPath.replace(/\\/g, "/")}`);
    }
    // The owner needs no line here, and that is the point of its key: `ownerKey` reads the tree's six-hex tag, which
    // a rename keeps, so the owner the reader set is the same entry before and after this function runs. A path-keyed
    // owner would have to be moved here and would still be orphaned by the panel's other rename paths.
    scheduler.store.dropRow(projectName, row.path);
    broadcast({ type: "drop", project: projectName, path: row.path });
  }
  // Nothing of the rename landed (the directory is held open AND the branch would not move): hand the tree back as the
  // cut tree it still is, rather than leaving a claim on a name it never got. Handing it back to the CUT state (not
  // forgetting it) keeps "this run cut it, nobody has named it" intact: a later event of the same run may try again,
  // and a seed — which would fix the name for good — can never slip in behind it.
  if (!moved && !branchRenamed) {
    if (once) {
      treeNames.record(key, {
        name: base,
        dir: base,
        branch: oldBranch || row.branch || null,
        tag,
        by: "the panel",
        how: "cut for this run — its one name did not land, so it is still this run's to give",
        at: new Date().toISOString(),
        cut: true,
        cutRun: run || null,
        claimedOnly: false,
      });
    }
    // Said out loud: a rename that did not land is the one case a reader (or a harness) cannot see from the board, and
    // the reason is otherwise only in the code.
    log(`naming ${oldPath}: the directory would not move (${whyNot}) and the branch would not move either — nothing was renamed`);
    const scanned = await scheduler.scanOne(project, finalPath.replace(/\\/g, "/"), "full").catch(() => null);
    return {
      ok: true,
      moved: false,
      path: finalPath.replace(/\\/g, "/"),
      branch: (scanned && scanned.branch) || oldBranch,
      branchRenamed: false,
      jobs: 0,
      warning: `the directory keeps its old name (${whyNot})`,
    };
  }
  // Read the renamed tree in now, not on its next scan: the store's branch name is what the next rename reads, and the
  // board should show the new name in the same breath as the banner.
  const scanned = await scheduler.scanOne(project, finalPath.replace(/\\/g, "/"), "full").catch(() => null);
  const finalBranch = (scanned && scanned.branch) || (branchRenamed ? newBranch : oldBranch);
  // Every record the panel keeps about the tree follows the move — the paths AND the branch name, in the job, the
  // measured tree and the completion payload alike (lib/jobs.js `repointPath`). Done HERE rather than at the top of
  // the function because the branch the tree actually ended up on is only known once it has been read back: passing
  // the old name would have left `branch` spelling a ref git no longer has, which is half of what the panel's own
  // dogfood run found on a renamed tree's earlier turn.
  const repointed = jobs.repointPath(oldPath, finalPath, { branch: finalBranch, oldBranch });
  // The record follows the tree: a name with no tag gets one here (rename keeps a tag, and makes one when the tree
  // had none), so the key changes with the name and the old one is dropped. settle() — not record() — is the write
  // that says the name is final: it clears the cut marker so no later event, and no later run, can give this tree
  // another one.
  const keyAfter = treeKey({ project: projectName, path: finalPath });
  if (keyAfter !== key) treeNames.forget(key);
  const named = treeNames.settle(keyAfter, {
    name: path.basename(finalPath),
    dir: path.basename(finalPath),
    branch: finalBranch || null,
    tag: tagOf(finalPath) || tag,
    by: by || "the panel",
    how: how || `renamed after “${wanted}”`,
    at: new Date().toISOString(),
    moved,
    from: base,
    claimedOnly: false,
    // A rename that actually landed is the tree's name: clear any `skipped` mark left by an earlier refusal.
    skipped: false,
  });
  return {
    ok: true,
    moved,
    path: finalPath.replace(/\\/g, "/"),
    branch: finalBranch,
    branchRenamed,
    jobs: repointed,
    named,
    warning: moved ? null : `the directory keeps its old name (${whyNot})`,
  };
}

// A tree is named from the prompt, and Hermes names the session from the work itself a moment later ("Fix delete
// worktree button not removing directory"). The reader wants the tree to take that name the moment the session is
// first named — not at the end of a later turn — so the policy is asked on every job event that carries a title.
// ONCE PER TREE, and that "once" is the ledger rather than a hope (lib/tree-names.js): the panel records the tree at
// the cut with the id of the run that cut it, only that record is eligible, and a rename settles it. A tree that was
// already here is seeded under the name it was found with and never enters this path at all.
naming = new WorktreeNaming({
  ledger: treeNames,
  // The project a tree belongs to, by path — the same lookup the board uses to place a row.
  projectForPath: (p) => spawnFeature.projectForPath(p),
  // The title from the event's own summary (jobs.summary carries it), falling back to the session store for an event
  // that arrived before Hermes wrote the name — the 10-second sweep emits again as soon as it has one.
  titleFor: (job) => job.title || jobs.sessionInfoFor(job.thread).title,
  // A tree a live run is standing in cannot be moved by git, so the attempt waits for the settle rather than fail.
  // All three of a card's tree fields are asked: `ownerPath || cwd` missed a live run whose owner was recorded
  // elsewhere and whose cwd was the tree, which is a tree moved under a working agent — the other half of what the
  // policy's own settle gate now refuses outright.
  isBusy: (dir) =>
    jobs.list().some(
      (x) =>
        isLiveJobStatus(x.status) &&
        [x.ownerPath, x.worktreePath, x.cwd].filter(Boolean).some((p) => normPathKey(p) === normPathKey(dir)),
    ),
  rename: (args) => renameWorktree(args),
  log,
  // The boot backfill: a tree that was here before this process must be written down before any restored run's
  // title is considered, or "no entry" would let it through.
  ready: treeNamesReady,
});

// An earlier turn's record outlives its tree's name: the panel renames a tree once, and a job written before that
// rename keeps the path and branch it was written with unless something moves them. The rename itself repoints every
// record it can see (lib/jobs.js `repointPath`, called from renameWorktree); this pass is for the records it could
// not see — a card restored over a tree an earlier process renamed, or a tree moved by another tool. Each dead
// reference is resolved through the naming ledger by the six-hex tag a rename keeps, and a record nothing can place
// is marked so the card says the tree was renamed instead of quoting a directory that is gone. Run once, after the
// boot seeding has written the fleet down: before that the ledger has no entry for a tree it is about to seed.
function resolveThroughNamingLedger({ path: gone, branch, projectPath }) {
  const project = spawnFeature.projectForPath(gone) || spawnFeature.projectForPath(projectPath) || null;
  if (!project?.name || !project.path) return null;
  const rec = treeNames.forTree({ project: project.name, path: gone, branch });
  // A cut record is a tree waiting for its one name, not a name it has: nothing to resolve to.
  if (!rec || namingState(rec) !== "named") return null;
  const dir = String(rec.dir || "").trim();
  const name = String(rec.name || "").trim();
  const at = (p) => (p && existsSync(p) ? p.replace(/\\/g, "/").replace(/\/+$/, "") : null);
  const found =
    at(path.isAbsolute(dir) ? dir : "") ||
    at(name ? path.join(project.path, ".worktrees", name) : "") ||
    at(dir ? path.join(project.path, ".worktrees", dir) : "") ||
    at(dir ? path.join(project.path, dir) : "");
  return found ? { path: found, branch: rec.branch || branch || null } : null;
}

void treeNamesReady
  .then(() => {
    const out = jobs.reconcileTreeRecords({ resolve: resolveThroughNamingLedger });
    if (out.moved || out.unresolved) {
      log(
        `tree-names: ${out.moved} job record(s) repointed to their tree's current name, ` +
          `${out.unresolved} left saying the tree was renamed (their path is gone and the ledger cannot place it)`,
      );
    }
  })
  .catch(() => {});

// The cut half of the ledger, called by lib/jobs.js around `git worktree add`: BEFORE the directory exists the tree is
// recorded as this run's to name, and if git then fails the record is handed back. Injected here because the ledger
// and the project registry are this file's, and lib/jobs.js must stay usable without either.
jobs.naming = {
  cut: ({ repoDir, path: tree, branch, tag, run, thread }) => {
    const project = registry.projects.find((p) => normPathKey(p.path) === normPathKey(repoDir));
    if (!project?.name) return null; // not a project the panel watches: discovery will seed it instead
    const key = treeKey({ project: project.name, path: tree, branch });
    const rec = treeNames.claimCut(key, {
      name: path.basename(tree),
      dir: path.basename(tree),
      branch: branch || null,
      tag: tag || tagOf(tree) || null,
      by: `run ${run || "?"} (${thread || "?"})`,
      how: "cut by this panel — its one name is the run's to give",
      at: new Date().toISOString(),
      cutRun: run || null,
      cutThread: thread || null,
    });
    if (rec?.cut) log(`tree-names: ${project.name}::${path.basename(tree)} is cut for run ${run || "?"} — one name allowed`);
    return rec;
  },
  release: ({ repoDir, path: tree, tag, run }) => {
    const project = registry.projects.find((p) => normPathKey(p.path) === normPathKey(repoDir));
    if (!project?.name) return false;
    const key = treeKey({ project: project.name, path: tree });
    // Only the record THIS cut wrote is withdrawn: a tree that already had one (seeded, named, cut by another run)
    // is not this run's to erase, and a failed `git worktree add` must not leave a claim on a directory nobody made.
    const rec = treeNames.get(key);
    if (!rec?.cut || (rec.cutRun && run && String(rec.cutRun) !== String(run))) return false;
    return treeNames.forget(key);
  },
};

// Rows are written by the scheduler, so their copy of the panel-agent state is as old as that
// row's last scan (45-90s on a big fleet). Overlay it at snapshot time: a turn starting or
// finishing is known here immediately, and the row must not keep claiming "done" meanwhile.
function withLiveAgents(snap) {
  const agents = jobs.agentPaths();
  if (!agents.size) return snap;
  for (const project of snap.projects || []) {
    for (const row of project.worktrees || []) {
      const mine = agents.get(normPathKey(row.path));
      if (!mine) continue;
      row.panelAgent = mine;
      row.signals = { ...(row.signals || {}), panel: { on: mine.running > 0, running: mine.running, total: mine.total, threads: mine.threads } };
      // The stored row may already name this reason from its last scan; replace it, never stack it.
      const base = String(row.liveWhy || "").replace(/panel-agent\(\d+\)/g, "").trim();
      if (mine.running > 0) {
        row.live = true;
        row.lastAliveAt = new Date().toISOString();
        row.liveWhy = `${base ? `${base} ` : ""}panel-agent(${mine.running})`;
      } else {
        // A turn just finished. The row the scan wrote may still say live because the agent WAS
        // running then; drop that reason now and let the other signals decide.
        const s = row.signals || {};
        const other = Boolean(s.hermes?.on || s.claude?.on || s.board?.on || s.ports?.on || s.files?.on);
        if (!other) {
          row.live = false;
          row.liveWhy = base || "no session, board entry, port or file edit";
        } else {
          row.liveWhy = base;
        }
      }
    }
  }
  return snap;
}

// The reader's lock travels with the snapshot the way the naming ledger does: git knows nothing about it, the
// scanner must not have to, and the row is where it has to be visible. A row with no `lock` is unlocked — absence is
// the default, so an unlocked row costs nothing on the wire and a store that cannot be read cannot make a tree look
// protected. `tree` and `branch` are independent bits: the row draws one toggle for each, and `by` says which one
// refused a delete.
function withLocks(snap) {
  for (const project of snap.projects || []) {
    for (const row of project.worktrees || []) {
      const lock = locks.check({ project: project.name, path: row.path, branch: row.branch });
      if (!lock.locked) {
        delete row.lock;
        continue;
      }
      row.lock = {
        tree: lock.tree,
        // `branch` is the branch's NAME and `branchLocked` is the boolean; a row that merely HAS a branch must not
        // read as a locked one. The row draws one toggle per bit and names the branch in its tooltip.
        branch: lock.branch,
        branchLocked: lock.branchLocked,
        locked: true,
        by: lock.by,
        at: lock.at,
        reason: lock.reason,
        line: describeLock(lock.by === "branch" ? { at: lock.at, by: lock.branchBy } : { at: lock.at, by: lock.treeBy }, lock.by === "branch" ? "branch" : "worktree"),
      };
    }
  }
  return snap;
}

// Who owns a tree: the assistant whose ROLE LABEL the row's bullet list draws and whose optional chart column says
// "Manager 1". Stored beside the lock (lib/locks.js `owners`) for the same reason — it is the panel's own answer about
// a directory git knows nothing about — and overlaid here for the same reason the lock is: the scanner reads git, this
// reads the panel's store.
//
// Three rules, all of them readable from these two functions:
//
//   * the STORE holds an id and nothing else, and the ID is `<project>::<the tree's six-hex tag>` — not the path and
//     not the branch, both of which the panel itself rewrites when it renames a tree (lib/locks.js `ownerKey`);
//   * the NAME, the numbered LABEL and the ROLE are all resolved here, on every read, from the records the board
//     holds: the cell's text is the assistant's own name ("Assistant #1"), its tooltip carries the numbered role
//     label ("Manager 1") and the detail's bullet reads "<name> — <role>" ("Assistant #1 — Manager"). Renaming a
//     role therefore renames every surface without touching one byte of the store, and a role label can never be
//     mistaken for the assistant's name;
//   * ABSENCE is Assistant #1, so a tree nobody moved carries no record and a store written before owners existed
//     needs no migration. An owner that is no longer on the board falls back to #1 TOO, and says so: the row keeps
//     `stored` (the id the reader gave it) and a `fallback` sentence, because a silent fallback is the reader's
//     setting appearing to have been ignored.
//
// THE ROUTING ANSWER, not just the cell's: `locks` is injected into the Assistant, and `assistantIdForJob` reads this
// same store to decide whose wake a settled run is and whose settings judge it (`lib/assistant.js`). One store, one
// answer — a row that says "Assistant #2" and a wake that lands on #1 is the defect this wiring closes.
function ownerFields(rec) {
  // A record missing entirely still answers with the default owner's name rather than an empty string: a row is
  // never drawn from nothing, and the cell must not be the one place a dash appears. The label and the role stay
  // empty there — inventing "Manager 1" for a board that has no records would state a role nothing answered for.
  if (!rec) return { id: DEFAULT_OWNER, name: "Assistant #1", label: "", role: "" };
  return { id: rec.id, name: rec.name, label: assistant.roleLabelOf(rec) || "", role: assistant.roleNameOf(rec) || "" };
}

function assistantForRow(projectName, row) {
  const stored = locks.owner({ project: projectName, path: row.path, branch: row.branch });
  const wanted = stored || DEFAULT_OWNER;
  const rec = assistant.assistants.find((a) => a.id === wanted) || null;
  if (rec) return ownerFields(rec);
  // The default owner itself must always answer; a store that has lost #1 (a hand-edited file) still draws a name
  // rather than an empty cell.
  const first = assistant.assistants.find((a) => a.id === DEFAULT_OWNER) || null;
  if (!stored) return ownerFields(first);
  // The stored owner is gone: the row keeps the id the reader gave it AND the sentence that says who owns the tree
  // now, so the fallback is explained on the surfaces rather than silently reading like the reader's own choice.
  return {
    ...ownerFields(first),
    stored,
    fallback: `${stored} is not on the board any more, so ${first?.name || "Assistant #1"} controls this worktree until you set an owner again`,
  };
}

function withAssistantOwners(snap) {
  for (const project of snap.projects || []) {
    for (const row of project.worktrees || []) row.assistant = assistantForRow(project.name, row);
  }
  return snap;
}

// The same overlay for the other two ways a row reaches a browser: the store's per-row event (the scanner's own row,
// which knows nothing about owners) and the reconcile route's answer. `assistant` is constructed after the store
// listener that calls this, and a row event can only come from a scan, so the null check is a guard, not a path.
function ownerOnRow(projectName, row) {
  if (!row || !assistant) return row;
  return { ...row, assistant: assistantForRow(projectName, row) };
}

// What the panel itself knows about a tree's name — who gave it and when — is in no git repository, so it travels
// with the snapshot the way the live agent state does. A row that carries `named` is a row the automatic rename
// will never touch again; one without it is a tree still waiting for the run that will name it.
function withTreeNames(snap) {
  for (const project of snap.projects || []) {
    for (const row of project.worktrees || []) {
      const rec = treeNames.forTree({ project: project.name, path: row.path, branch: row.branch });
      // A cut record is a tree waiting for its one name, not a tree that has one: the row must not claim a name
      // nobody has given it yet (the tooltip is the only place this shows, and it would say "named by run …").
      // A `skipped` record says the panel looked and LEFT THE NAME ALONE (the branch already carried its own
      // commits): it is written so the title sweep stops asking, not because a name landed, so the row must not
      // claim to have been named either. The ledger keeps the reason for anyone reading the file.
      // A cut tree's record can still carry the title the automatic half DECLINED (it promised a PR, a commit, a
      // merge). That is not a name, but it is why the tree keeps the name it was cut with, so the row carries it
      // separately — the ✎ tooltip says it was offered and turned down, and no `named` line is invented for it.
      if (rec && namingState(rec) === "cut" && rec.offered?.title) {
        row.nameOffer = {
          title: rec.offered.title,
          why: rec.offered.why || "",
          at: rec.offered.at || null,
          line: describeNaming(rec),
        };
      } else {
        delete row.nameOffer;
      }
      if (!rec || namingState(rec) === "cut" || rec.skipped) {
        delete row.named;
        continue;
      }
      row.named = {
        name: rec.name || null,
        by: rec.by || null,
        at: rec.at || null,
        how: rec.how || null,
        claimedOnly: Boolean(rec.claimedOnly),
        line: describeNaming(rec),
      };
    }
  }
  return snap;
}

// ---- the two directories the panel keeps its things in ---------------------------------------------
// The page shows these, with their sizes, and offers to open either or to empty the scratch one. Both numbers come
// from lib/paths.js's cached walk (10 s), so a board polled every few seconds never pays for a fresh stat of the
// attachments folder; `at` says how old the reading is rather than the page pretending it is live.
function pathsInfo() {
  const data = sizeOf(config.dataDir);
  const scratch = sizeOf(config.scratchDir);
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  return {
    dataDir: config.dataDir,
    dataSource: config.dataDirSource,
    // `split` (state/, attachments/, logs/ inside) or `flat` (a PANEL_CONFIG instance's own folder).
    dataLayout: config.dataLayout,
    dataBytes: data.bytes,
    dataFiles: data.files,
    // null until the first background walk lands, so the row says "measuring…" instead of a false "0 B".
    dataMeasuredAt: iso(data.at),
    scratchDir: config.scratchDir,
    scratchSource: config.scratchDirSource,
    scratchBytes: scratch.bytes,
    scratchFiles: scratch.files,
    scratchDirs: scratch.dirs,
    scratchMeasuredAt: iso(scratch.at),
    // Whether Clean scratch will work at all: it refuses a folder the panel did not make (paths.js, SCRATCH_MARKER).
    scratchMarked: existsSync(path.join(config.scratchDir, SCRATCH_MARKER)),
    // Where the pieces sit, so the row can say "the job store is under state/" without the reader guessing.
    stateDir: config.stateDir,
    attachmentsDir: config.attachmentsDir,
    logsDir: config.logsDir,
    // Where this board's history came from, from the data directory's own journal — so it is still answerable on
    // every later boot. `thisBoot` is true only on the boot that did the copy.
    migrated: lastMigration
      ? { files: (lastMigration.copied || []).length, from: lastMigration.from, to: lastMigration.to, at: lastMigration.at, thisBoot: stateMigration.migrated }
      : null,
    at: iso(data.at || Date.now()),
  };
}

// ---- the steward's own reads ------------------------------------------------------------------------------------
// One project, re-read from git and classified: the parent book is refreshed first, because a plan that guessed a
// different parent from the board would be two answers to one question, and the row is the one the reader is looking
// at. Cost is a handful of git calls per local branch, which is why nothing here runs on a scan tick.
async function stewardProject(name) {
  const project = (registry.projects || []).find((p) => p.name === name) || null;
  if (!project) return { status: 404, error: `unknown project: ${name || "(none)"}` };
  const rows = store.rowsFor(project.name) || [];
  const branches = rows.map((r) => r.branch).filter(Boolean);
  await parents.refresh({ project: project.name, repoDir: project.path, mainBranch: project.mainBranch, branches });
  const map = new Map();
  for (const rec of parents.state(project.name)) map.set(rec.branch, rec);
  const entries = await inspectProject({ project: project.name, repoDir: project.path, rows, parents: map, mainBranch: project.mainBranch });
  const plan = buildPlan({ project: project.name, repoDir: project.path, entries, questions: questions.list(project.name), mainBranch: project.mainBranch });
  return { project, rows, map, entries, plan };
}

function snapshot() {
  const snap = withRefreshJournal(
    withReleases(
      withTodos(
        descriptions.withDescriptions(
          withLocks(
            withTreeNames(
              withLiveAgents({
                ...store.snapshot({ settings: settingsOut() }),
                paths: pathsInfo(),
                jobs: jobs.list(),
                approvals: approvals.list(),
                // The panel's own permission requests (a push a worker's guard parked, a merge the panel itself wants to
                // write to a remote for). They ride with the snapshot the way the CLI-transport approvals do, so a reload
                // comes back to the same open question instead of losing it.
                remoteWrites: remoteWrites.state(),
                // The assistant's own state travels with the snapshot: its scratchpad, its open alerts and its
                // thread id, so a reload comes back to the same conversation and the same watches.
                assistant: assistant.state(),
                // Where the board's links go: the host records a reader can choose from, plus what each project resolves to
                // right now. One object, because the header's chip and the Discover strip must read the same answer.
                hosts: { ...hosts.state(), projects: Object.fromEntries(registry.projects.map((p) => [p.name, hosts.view(p)])) },
                skipped: registry.skipped,
                scanRoots: config.scanRoots || [],
                spawn: {
                  // Spawning is no longer "is there a hermes.exe on this box": it is "is the gateway's api_server
                  // reachable and keyed". The panel probes and reports, instead of assuming.
                  transport: jobs.transportInfo(),
                  defaultCwd: config.defaultCwd,
                  maxRuntimeSeconds: jobs.maxRuntimeSeconds,
                  projects: registry.projects.map((p) => ({ name: p.name, path: p.path, activityAt: p.activityAt || null, empty: Boolean(p.empty) })),
                },
              }),
            ),
          ),
        ),
      ),
    ),
  );
  // The owner rides the snapshot like the lock does: one more per-row field the page can read without a second call.
  return withAssistantOwners(snap);
}

const heartbeat = setInterval(() => {
  const payload = { at: new Date().toISOString(), stats: scheduler.stats, pool: { inFlight: pool.inFlight, queued: pool.queued } };
  for (const res of clients) {
    try {
      res.write(`event: heartbeat\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch {
      clients.delete(res);
    }
  }
}, 5000);

// ---- the model menu's prices, kept warm without ever blocking a read ---------------------------
// The dropdown reads a cache file and nothing else, so the one thing that can refresh it is a
// gateway call, and that call re-fetches every provider's live list. It is therefore deliberately
// rare: at most one attempt per process minute, and only while the panel has no prices at all or has
// not regenerated them for over a week. A press in Settings (POST /api/models/refresh) is the
// deliberate path and is never throttled.
const MODEL_PRICING_WARM_MS = 7 * 24 * 60 * 60 * 1000;
let modelPricingWarm = null; // the in-flight warm, so a burst of page loads starts exactly one
let modelPricingWarmTriedAt = 0;
function warmModelPrices(cfg, catalogue) {
  if (modelPricingWarm) return;
  const ageSeconds = catalogue?.pricingAge;
  const stale = !Number.isFinite(ageSeconds) || ageSeconds * 1000 > MODEL_PRICING_WARM_MS;
  if (!stale || Date.now() - modelPricingWarmTriedAt < 60_000) return;
  modelPricingWarmTriedAt = Date.now();
  modelPricingWarm = refreshModelCatalogue({
    home: hermesHome(),
    pricingFile: cfg.modelPricingFile,
    api: jobs.api,
    log,
  })
    .catch((e) => log(`model prices: the background warm failed — ${String((e && e.message) || e)}`))
    .finally(() => {
      modelPricingWarm = null;
    });
}

const cleanPath = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "");

// Removing a worktree's folder - the Recycle Bin attempt, the retry for a folder a process still holds, and
// the question of whether the panel itself is what holds it - lives in lib/worktree-remove.js with the rest of
// the act, because the answer a CHECKING agent gives ends in the same removal.

// The Hermes sessions the scheduler attributes to one worktree row — the same attribution the row's
// own "Hermes session open here but idle" claim is built from, so this list can never offer a session
// the row does not already say it has.
async function sessionsForRow(target) {
  const roots = await scheduler.sessionRoots();
  return roots.get(cleanPath(target).toLowerCase()) || [];
}

// ---- the double-check agent a row's ⟳ may offer ----------------------------------------------
// The cheap pass can see that a verdict moved, that a commit's words match an open TODO item, or that a description no
// longer names the branch — it cannot READ the tree. This is the one agent that can: it starts IN that worktree, with
// the panel's own refusal rules (gateway usable, tree is a checkout, nothing live already holding it), and its brief is
// the three questions the row could not answer by itself. The TODO block and the "Work in …" sentence are appended by
// lib/jobs.js, so the list it must reconcile is the one with the ids the panel reads back.
function refreshAgentPrompt(project, row, evidence = []) {
  const base = row.baseRef || project.mainBranch || "the base branch";
  return [
    `Double-check this worktree's row on the board. The panel's ⟳ re-read the tree a moment ago and found: ${evidence.length ? evidence.join(" · ") : "nothing that moved"}.`,
    "",
    "Read the tree yourself and answer three questions. Do not take the row's word for any of them.",
    `1. MERGE STATE — run \`git status --porcelain=v2 --branch\` and \`git log --oneline ${base}..HEAD\` (and \`git cherry ${base} HEAD\` if it helps). Say whether the row's verdict (${row.verdict || "unknown"}) and its ahead/behind counts are right, and whether anything is modified or untracked.`,
    "2. TODO — the list in your brief is this tree's. Close ONLY the items your own reading of the commits and the files those commits touched actually finishes, and write them as `TODO DONE <id>` on their own line in your final message. Add anything the tree shows is still missing as `TODO ADD <text>`. Never close an item you cannot point at a commit or a file for.",
    "3. DESCRIPTION — the row says what this branch was started to do. Answer in one line whether that is still true of the work in the tree, and what it should say if it is not. Do not rewrite it in any file; the panel owns that text.",
    "",
    "Change nothing else: no commits, no push, no merge, and no edits beyond what a TODO item is about. Finish with the three answers, then your TODO lines.",
  ].join("\n");
}

// Start it. Every gate is re-answered here rather than trusted from the click: the row is still a row, nothing live holds
// the tree, and the gateway is usable.
async function startRowRefreshAgent(project, row, evidence = []) {
  const busy = liveRunIn(jobs.list(), row.path, { isLive: isLiveJobStatus });
  if (busy) return { ok: false, status: 409, error: `an agent is running in that worktree (${busy.id})` };
  const prompt = refreshAgentPrompt(project, row, evidence);
  try {
    const job = await spawnFeature.assistantSpawnRun({
      prompt,
      existing: true,
      target: row.path,
      project: project.name,
      origin: { kind: "row-refresh", project: project.name, path: row.path, evidence: evidence.slice(0, 8) },
    });
    log(`row refresh: started ${job.thread || job.id} in ${row.path} to double-check its TODO, description and merge state`);
    return { ok: true, job };
  } catch (e) {
    return { ok: false, status: 400, error: String((e && e.message) || e) };
  }
}

const bootConfigJson = JSON.stringify(config);
let bootPassCanSatisfyReload = true;
let bootPassFinishedAt = 0;
let resolveBootPass;
const bootPass = new Promise((r) => {
  resolveBootPass = r;
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const route = url.pathname;
  if (req.method === "POST" && route !== "/api/reload") {
    bootPassCanSatisfyReload = false;
  }
  try {
    // ---- the prefixes mounted from the table above ------------------------------------------------
    // One module owns each prefix's routes, its transitions and its wire shape (routes/assistant-queue.js for the
    // queue); this handler asks the table first because each mount's own guard is a string compare. A path that does
    // not start with a row's prefix cannot be that row's, so the skip is a fast path and not a rule; `false` means
    // "not mine" and falls through to the board.
    for (const mount of PREFIX_MOUNTS) {
      if (!route.startsWith(mount.prefix)) continue;
      if (await mount.handles(req, res, route, url)) return;
    }
    // …and the ticket watch's one door, beside the queue's routes: it wakes the assistant that owns a ticket list.
    if (await ticketWatchRoutes(req, res, route, url)) return;

    // The assistant reset's control-plane write: `POST /api/assistants/:id/reset`, dry or real. The module owns the
    // path match, the 409 refusals, the resolve-unknown loop and the local clearing; this handler only asks it first,
    // exactly as it asks the queue's routes.
    if (await resetRoutes(req, res, route, url)) return;

    // The task pipeline window's own read, beside the queue's routes: one row's stages, resolved against the bundle.
    if (await pipelineWindowRoutes(req, res, route, url)) return;

    // …and the catalogue its assignment control draws: the bundle's pipelines, their stages in order.
    if (await pipelineCatalogueRoutes(req, res, route, url)) return;

    // …and the one write that changes it: a studio export appended to the bundle by pipeline id.
    if (await pipelineBundleImportRoutes(req, res, route, url)) return;

    if (route === "/api/health") {
      return sendJson(res, 200, { ok: true, host: config.host, projects: registry.projects.map((p) => p.name), settings: settingsOut(), clients: clients.size });
    }

    // The build this process is serving: the page carries the version it loaded with, polls this,
    // and offers (or takes) a reload when the two part company. A read, like every other GET here.
    if (route === "/api/build" && req.method === "GET") {
      return sendJson(res, 200, await build.info());
    }

    // The checkout's own changelog: what Settings → Updates draws under the build row. One file at the panel
    // root, read only as far as the tab needs, and the limit is the tab's — capped so a hand-edited URL cannot
    // ask the server to format all 251 releases. The THREE states are distinct on purpose: `ok` (headings
    // parsed), `empty` (the file is there and carries none) and `missing` (there is no file) are different
    // things to a reader, and a blank box says none of them.
    if (route === "/api/changelog" && req.method === "GET") {
      const limit = changelogLimitFrom(url.searchParams.get("limit"));
      const file = path.join(HERE, CHANGELOG_FILE);
      const answer = (state, reason, info = null, sections = []) => ({
        file: CHANGELOG_FILE,
        path: file,
        limit,
        cap: CHANGELOG_MAX,
        serving: VERSION,
        state,
        reason: reason || null,
        mtime: info ? info.mtime.toISOString() : null,
        size: info ? info.size : null,
        sections,
      });
      let info;
      try {
        info = await stat(file);
      } catch (e) {
        const missing = e && e.code === "ENOENT";
        return sendJson(
          res,
          200,
          answer(
            missing ? "missing" : "unreadable",
            missing
              ? `${CHANGELOG_FILE} is not in the panel's root (${HERE})`
              : `cannot read ${CHANGELOG_FILE}: ${String((e && e.message) || e)}`,
          ),
        );
      }
      let sections = [];
      try {
        sections = parseChangelogSections(await readChangelogHead(file, limit, info.size), limit);
      } catch (e) {
        return sendJson(res, 200, answer("unreadable", `cannot read ${CHANGELOG_FILE}: ${String((e && e.message) || e)}`, info));
      }
      const reason = sections.length
        ? null
        : `${CHANGELOG_FILE} is ${info.size} bytes and carries no "## vX.Y.Z — date · N commits" heading`;
      return sendJson(res, 200, answer(sections.length ? "ok" : "empty", reason, info, sections));
    }

    if (route === "/api/config") {
      return sendJson(res, 200, {
        ...settingsOut(),
        ...(await scanRootsOut()),
        projects: registry.projects.map((p) => ({ name: p.name, path: p.path, remote: p.remote, mainBranch: p.mainBranch, activityAt: p.activityAt || null })),
      });
    }

    // ---- the one Hermes setting the panel can change ------------------------------------
    // approvals.timeout is the gateway's clock, not the panel's: the gate that waits for the answer
    // runs inside the process executing the turn. It lives in <HERMES_HOME>/config.yaml, so this
    // reads and writes there rather than config.json, and it refuses when the gateway is another
    // machine. Read on demand — it is opened from Settings, never folded into the 30 s snapshot.
    // ---- how many sessions the CLI's picker shows ------------------------------------------
    // `sessions.list_limit`, read by the local CLI patch. The store itself is not capped — this
    // reports what it actually holds, so "only ten are kept" is answerable — and `patched: false`
    // means the installed CLI has no patch (a `hermes update` replaced it), which makes the value
    // in config.yaml inert. Saying that is the point: a setting that quietly does nothing is worse
    // than no setting.
    if (route === "/api/settings/sessions" && req.method === "GET") {
      return sendJson(res, 200, await sessionSettings());
    }

    // ---- where these agents' skills are absorbed from ------------------------------------------
    // The Skills tab's whole answer, and the one read in Settings that opens more than one file: every
    // root Hermes reads skills from (the profile's own `skills/`, a junctioned directory as its own
    // source, `skills.create_dir`, `skills.external_dirs`, a trusted project's `.hermes/skills`), the
    // name and description out of each SKILL.md, and the gateway's `GET /v1/skills` for what a run is
    // actually SERVED. Read on demand — the tab is the only caller — so a skill added a minute ago is
    // there the next time it is opened, and a gateway that cannot answer is a reason in the payload
    // rather than a failed request.
    if (route === "/api/settings/skills" && req.method === "GET") {
      return sendJson(
        res,
        200,
        await readSkillsIndex({
          home: hermesHome(),
          projects: registry.projects.map((p) => ({ name: p.name, path: p.path })),
          gateway: { url: jobs.api.url, key: jobs.api.key },
        }),
      );
    }

    // ---- what permissions are in force, and where each one comes from ----------------------------
    // The Permissions tab's whole answer: the five config.yaml blocks the gateway actually reads
    // (parsed at request time, every row carrying its own file:line), the gateway's advertised
    // surface (a 401 is "not exposed, needs a token", never a guess at the features), and this
    // panel's remote-write layer — config.json's policy and lib/remote-writes.js's grants.
    // Read on demand, so the tab reports the file as it is now rather than a snapshot from boot.
    if (route === "/api/settings/permissions" && req.method === "GET") {
      return sendJson(
        res,
        200,
        await readPermissions({
          home: hermesHome(),
          // THIS instance's config, as this process resolved it at boot — never `path.join(HERE, "config.json")`,
          // which is the checkout's file and is what a PANEL_CONFIG sandbox used to have reported back to it.
          panelConfigPath: CONFIG_PATH,
          modulePath: path.join(HERE, "lib", "remote-writes.js"),
          gateway: { url: jobs.api.url, key: jobs.api.key },
        }),
      );
    }

    // ---- the pipeline catalogue ------------------------------------------------------------------
    // The Pipeline tab's whole answer: the merged catalogue — the reader's pipelines.json over the shipped seed —
    // with its provenance (both file paths), the version it was written with, and every refusal the loader made.
    // A file whose version is newer than this panel's is refused whole (the seed is in force read-only); a
    // definition that fails validation is dropped by id and named. The FULL definitions travel here, not the
    // summary /api/state carries: the tab edits stages and prompts, and a summary would make it guess.
    if (route === "/api/pipelines" && req.method === "GET") {
      const doc = pipelines.doc({ fresh: true });
      return sendJson(res, 200, {
        file: doc.file,
        seedFile: doc.seedFile,
        version: doc.version,
        supported: PIPELINES_VERSION,
        kinds: PIPELINE_KINDS,
        exitChecks: EXIT_CHECKS,
        readOnly: doc.readOnly,
        refused: doc.refused,
        warnings: doc.warnings,
        dropped: doc.dropped,
        pipelines: doc.pipelines,
        // The OTHER pipeline list this panel holds: the PDL bundle a task is put on, read through the one module the
        // queue picker reads (lib/pipeline-source.js). The ladder above says what a TREE may do with a branch and the
        // PDL pipelines below say what a TASK is carried through; the tab draws both and names which is which. A
        // bundle that is missing or refused is carried here as its own value, never blamed on the ladder.
        pdl: pipelineSourceCatalogue(config),
      });
    }

    // ---- one pipeline document, read for the map's `?doc=` -----------------------------------------
    // public/pipeline-map.html draws a document it did not build, but a page served on this origin cannot fetch the
    // factory on :8090 (no CORS header) — so the reader's own panel does the read and hands the page the bytes with
    // the sha256 its provenance line must name. Loopback only: see lib/pipeline-doc.js for why that is the line.
    if (route === "/api/pipeline-doc" && req.method === "GET") {
      const read = await readPipelineDocument(url.searchParams.get("url"));
      return sendJson(res, read.status, read.body);
    }

    // ---- the vendored mermaid, for the flow dialog's Preview -----------------------------------------
    // public/pipeline-map.html INLINES mermaid (it is one file that must open with no network at all). The panel
    // cannot: 2.5 MB of script in the shell would be parsed on every boot. The dialog's Preview loads this route on
    // its first open instead, and it serves the SAME vendored bytes the map page inlines. The URL carries the mermaid
    // version, so an upgrade is a different URL rather than new bytes behind an old cached one.
    if (route === "/vendor/mermaid.min.js" && req.method === "GET") {
      let body = MERMAID_ASSET;
      if (!body) {
        try {
          body = MERMAID_ASSET = await readFile(path.join(HERE, "tools", "vendor", "mermaid.min.js"));
        } catch (e) {
          log(`vendored mermaid could not be read: ${String((e && e.message) || e)}`);
          return sendJson(res, 404, { ok: false, error: "the vendored mermaid is not in this checkout (tools/vendor/mermaid.min.js)" });
        }
      }
      const head = {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
        Vary: "Accept-Encoding",
      };
      if (body.length > 2048 && acceptsGzip(req)) {
        const gz = gzip(body);
        res.writeHead(200, { ...head, "Content-Encoding": "gzip", "Content-Length": gz.length });
        return res.end(gz);
      }
      res.writeHead(200, { ...head, "Content-Length": body.length });
      return res.end(body);
    }

    // Replace the live catalogue. The document is the pipelines.json shape: `{version, note, pipelines}`. A version
    // newer than this panel's is refused whole (409), exactly as the loader would refuse it on the next read. Every
    // definition is validated with validatePipeline and its findings come back UNALTERED under `findings`, so the
    // tab can show each sentence beside the field it belongs to. Nothing is written when any definition is
    // refused: a half-saved catalogue is the one state the loader's drop-by-id rule exists to prevent.
    //
    // A document may carry ONE definition (the tab's save sends only the pipeline it edited): the body's pipelines
    // are merged over the live file's own, so an edit to one id never silently deletes the reader's other edits.
    // The seed's definitions are not copied in — the live file holds only the reader's, and the seed still supplies
    // everything it supplies.
    if (route === "/api/pipelines" && req.method === "PUT") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return sendJson(res, 400, { error: "a pipeline document is required (a JSON object)" });
      }
      const version = Number(body.version);
      if (Number.isFinite(version) && version > PIPELINES_VERSION) {
        return sendJson(res, 409, {
          error: `the document is version ${version}, newer than this panel's ${PIPELINES_VERSION} — it is refused whole, not half-parsed`,
          refused: { version, supported: PIPELINES_VERSION, why: `the document names version ${version}, newer than this panel's ${PIPELINES_VERSION}` },
        });
      }
      const live = readPipelinesFile(config.pipelinesFile);
      if (live.refused) {
        return sendJson(res, 409, {
          error: `the live pipelines.json is refused whole: ${live.refused.why}`,
          refused: live.refused,
        });
      }
      const incoming = Array.isArray(body.pipelines)
        ? Object.fromEntries(body.pipelines.filter((rec) => rec && typeof rec === "object").map((rec) => [String(rec.id ?? "").trim(), rec]))
        : body.pipelines && typeof body.pipelines === "object"
          ? body.pipelines
          : {};
      const merged = { ...(live.pipelines || {}), ...incoming };
      // The document the reader is asking to put in force is the WHOLE catalogue — the seed's definitions, the live
      // file's and this edit — so a `next` pointing at a seed definition is not reported as unknown. Only the live
      // file's definitions and the edit are WRITTEN; the seed still supplies its own.
      const inForce = { ...(pipelines.doc({ fresh: true }).pipelines || {}), ...incoming };
      const document = { version: PIPELINES_VERSION, pipelines: inForce };
      if (body.note) document.note = body.note;
      const { errors } = validatePipelinesDocument(document);
      if (errors.length) {
        return sendJson(res, 422, {
          error: `the pipeline document was refused: ${errors.length} finding${errors.length === 1 ? "" : "s"}`,
          findings: errors,
        });
      }
      const saved = pipelines.save({ version: PIPELINES_VERSION, pipelines: merged, ...(body.note ? { note: body.note } : {}) });
      if (!saved.ok) return sendJson(res, 500, { error: saved.error });
      log(`pipelines: saved ${saved.file} — ${Object.keys(merged).length} definition(s) in force`);
      const doc = pipelines.doc({ fresh: true });
      return sendJson(res, 200, {
        ok: true,
        file: saved.file,
        state: {
          file: doc.file,
          seedFile: doc.seedFile,
          version: doc.version,
          supported: PIPELINES_VERSION,
          kinds: PIPELINE_KINDS,
          exitChecks: EXIT_CHECKS,
          readOnly: doc.readOnly,
          refused: doc.refused,
          warnings: doc.warnings,
          dropped: doc.dropped,
          pipelines: doc.pipelines,
        },
      });
    }

    if (route === "/api/settings/sessions" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const state = await sessionSettings();
      if (!state.editable) return sendJson(res, 409, { ...state, error: state.reason || "not editable" });
      const limit = Number(body.listLimit ?? body.limit);
      if (!Number.isInteger(limit) || limit < SESSION_LIST_MIN || limit > SESSION_LIST_MAX) {
        return sendJson(res, 400, {
          ...state,
          error: `the session list must be a whole number between ${SESSION_LIST_MIN} and ${SESSION_LIST_MAX}`,
        });
      }
      try {
        writeSessionListLimit(limit);
      } catch (e) {
        return sendJson(res, 500, { ...state, error: String((e && e.message) || e) });
      }
      log(`sessions.list_limit = ${limit} written to ${state.configPath}`);
      return sendJson(res, 200, {
        ...(await sessionSettings()),
        written: true,
        // The CLI reads config at start-up of each invocation, so the next /sessions uses it.
        note: "saved — the next hermes session's /sessions and /resume use it",
      });
    }

    if (route === "/api/settings/approvals" && req.method === "GET") {
      return sendJson(res, 200, approvalState({ gatewayUrl: jobs.api.url }));
    }

    if (route === "/api/settings/approvals" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const state = approvalState({ gatewayUrl: jobs.api.url });
      if (!state.editable) return sendJson(res, 409, { ...state, error: state.reason || "not editable" });
      const seconds = Number(body.timeoutSeconds ?? body.timeout);
      if (!Number.isInteger(seconds) || seconds < APPROVAL_TIMEOUT_MIN || seconds > APPROVAL_TIMEOUT_MAX) {
        return sendJson(res, 400, {
          ...state,
          error: `the approval window must be a whole number of seconds between ${APPROVAL_TIMEOUT_MIN} and ${APPROVAL_TIMEOUT_MAX}`,
        });
      }
      try {
        writeApprovalTimeout(seconds);
      } catch (e) {
        return sendJson(res, 500, { ...state, error: String((e && e.message) || e) });
      }
      log(`approvals.timeout = ${seconds}s written to ${state.configPath}`);
      return sendJson(res, 200, {
        ...approvalState({ gatewayUrl: jobs.api.url }),
        written: true,
        // Hermes re-reads config.yaml when the file signature changes and reads this per request,
        // so the next prompt uses the new window without restarting the gateway.
        note: "saved",
      });
    }

    // The provider endpoint every run talks to: OpenRouter's URL and the key it authenticates with. The
    // key itself never leaves this process - GET reports whether one is set, where it came from and its
    // last four characters; POST writes into config.yaml's model block (the file the gateway re-reads).
    if (route === "/api/settings/provider" && req.method === "GET") {
      return sendJson(res, 200, providerState());
    }

    if (route === "/api/settings/provider" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const state = providerState();
      if (!state.editable) return sendJson(res, 409, { ...state, error: state.reason || "not editable" });
      try {
        const wrote = writeProviderSettings({
          baseUrl: body.baseUrl,
          apiKey: body.apiKey,
          clearKey: Boolean(body.clearKey),
        });
        const what = [wrote.wroteUrl ? "model.base_url" : null, wrote.wroteKey ? "model.api_key" : null, wrote.clearedKey ? "model.api_key removed" : null]
          .filter(Boolean)
          .join(", ");
        log(`${what || "provider settings"} written to ${wrote.configPath}`);
        return sendJson(res, 200, {
          ...providerState(),
          written: true,
          note: "saved — the next run uses it; a run already in flight keeps the endpoint and key it started with",
        });
      } catch (e) {
        return sendJson(res, 400, { ...providerState(), error: String((e && e.message) || e) });
      }
    }

    // ---- the saved provider profiles: a named (URL, key) pair ------------------------------
    // One store, four answers, and one rule that shapes all of them: a key is written here and applied here, and
    // no answer carries it back. What a list row says about a key is whether it is set and its last four — the
    // same sentence the config.yaml field already speaks. Apply is server-side for exactly that reason: the
    // browser names a profile, this process reads the key out of the state file and hands it to
    // writeProviderSettings, so the secret is never in a request body or in a response.
    // The path is lib/paths.js's (statePaths.providerProfilesFile, assigned onto this config at boot), never a
    // literal built here: it must stay inside the panel's own state folder and outside every checkout.
    const profilesFile = config.providerProfilesFile;

    if (route === "/api/settings/provider/profiles" && req.method === "GET") {
      return sendJson(res, 200, listProfiles({ file: profilesFile }));
    }

    if (route === "/api/settings/provider/profiles" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      try {
        const saved = saveProfile({ file: profilesFile, id: body.id || null, name: body.name, baseUrl: body.baseUrl, apiKey: body.apiKey });
        log(`provider profile ${saved.created ? "saved" : "updated"}: "${saved.profile.name}" (${saved.profile.baseUrl}) in ${profilesFile}`);
        return sendJson(res, 200, {
          ...listProfiles({ file: profilesFile }),
          saved: saved.profile,
          note: saved.created
            ? `profile "${saved.profile.name}" saved — its key stays in the panel's own state folder, never in the repository`
            : `profile "${saved.profile.name}" updated${body.apiKey ? "" : " — the stored key was kept because the key box was empty"}`,
        });
      } catch (e) {
        return sendJson(res, Number(e.status) || 400, { ...listProfiles({ file: profilesFile }), error: String((e && e.message) || e) });
      }
    }

    if (route === "/api/settings/provider/profiles/delete" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      try {
        const dropped = deleteProfile({ file: profilesFile, id: body.id });
        if (!dropped) {
          return sendJson(res, 404, { ...listProfiles({ file: profilesFile }), error: `no profile with id ${String(body.id || "(none)")}` });
        }
        log(`provider profile deleted: "${dropped.removed.name}" — its stored key was removed with it, from ${profilesFile}`);
        return sendJson(res, 200, {
          ...listProfiles({ file: profilesFile }),
          removed: dropped.removed,
          note: `profile "${dropped.removed.name}" deleted, and the key it held with it`,
        });
      } catch (e) {
        return sendJson(res, Number(e.status) || 400, { ...listProfiles({ file: profilesFile }), error: String((e && e.message) || e) });
      }
    }

    // Apply writes the chosen pair through the SAME function the URL/key rows use, so there is one writer of
    // model.base_url and model.api_key in this process and one set of checks on the way in.
    if (route === "/api/settings/provider/apply" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const state = providerState();
      if (!state.editable) return sendJson(res, 409, { ...state, error: state.reason || "not editable" });
      const profile = profileWithKey({ file: profilesFile, id: body.id });
      if (!profile) {
        return sendJson(res, 404, { ...providerState(), error: `no saved profile with id ${String(body.id || "(none)")}` });
      }
      if (!profile.apiKey) {
        return sendJson(res, 400, { ...providerState(), error: `profile "${profile.name}" holds no key — open it and press Edit with a key in the box` });
      }
      try {
        const wrote = writeProviderSettings({ baseUrl: profile.baseUrl, apiKey: profile.apiKey });
        log(`provider profile applied: "${profile.name}" (${profile.baseUrl}) -> ${wrote.configPath}`);
        return sendJson(res, 200, {
          ...providerState(),
          applied: { id: profile.id, name: profile.name, baseUrl: profile.baseUrl },
          written: true,
          note: `profile "${profile.name}" applied — the next run uses it; a run already in flight keeps the endpoint and key it started with`,
        });
      } catch (e) {
        return sendJson(res, 400, { ...providerState(), error: String((e && e.message) || e) });
      }
    }

    // ---- the Matrix bridge: a process this panel starts and stops ------------------------------
    // The bridge is a standalone Python program (Matrix sync + E2EE + the Hermes CLI), with its credentials in
    // bridge.env beside it. These routes are the whole of the panel's involvement. Nothing here opens that
    // file: `credentialsPresent` is whether it exists, and no answer carries a value from it.
    //
    // Liveness is the OS's answer for the pid this panel recorded, never the pid file's existence — a record
    // outlives the process it names (a crash, a reboot), and a stale one must never read as a running bot.
    if (route === "/api/settings/matrix" && req.method === "GET") {
      return sendJson(res, 200, matrixBridge.state());
    }

    // The four fields beside Start/Stop write through here. It accepts ONLY the keys lib/matrix-bridge.js names
    // (scriptPath, pythonPath, roomId, autoStart) and writes ONLY those into config.json's `matrix` block — a
    // `password` in the body is ignored and has nowhere to reappear, because the answer is the GET shape and the
    // written block is the whitelist. An empty roomId is saved as "no room set": start and self-test refuse loudly
    // rather than launching the bridge into nothing.
    if (route === "/api/settings/matrix" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const { values, error } = matrixPatchFrom(body);
      if (error) return sendJson(res, 400, { ...matrixBridge.state(), error });
      const next = matrixBlock(config.matrix, values);
      try {
        await patchPanelConfig({ matrix: next });
      } catch (e) {
        return sendJson(res, 500, { ...matrixBridge.state(), error: `could not write config.json: ${String((e && e.message) || e)}` });
      }
      // The running panel answers from the same object the file now holds: a GET straight after the save reads the
      // new room, and the next boot spawn uses it too.
      config.matrix = next;
      log(`matrix bridge settings saved: script ${next.scriptPath || "(none)"} | interpreter ${next.pythonPath || "(none)"} | room ${next.roomId || "(none)"} | auto-start ${next.autoStart ? "on" : "off"}`);
      return sendJson(res, 200, {
        ...matrixBridge.state(),
        note: `saved — ${next.roomId ? `room ${next.roomId}` : "no room set, so Start and Run self-test will refuse"} · auto-start ${next.autoStart ? "on" : "off"}`,
      });
    }

    if (route === "/api/settings/matrix/start" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const out = await matrixBridge.start();
      const { status, ...body } = out;
      return sendJson(res, Number(status) || 200, body);
    }

    if (route === "/api/settings/matrix/stop" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const out = await matrixBridge.stop();
      const { status, ...body } = out;
      return sendJson(res, Number(status) || 200, body);
    }

    if (route === "/api/settings/matrix/test" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      // The self-test's own answer is the `ok`/`output`/`exitCode` triple the bridge defines; the state rides
      // along so the page can repaint the dot and the log from one response.
      const result = await matrixBridge.selfTest();
      return sendJson(res, 200, { ...matrixBridge.state(), ...result });
    }

    // ---- the Bridge tab's one read -------------------------------------------------------------------
    // Everything the tab draws, in one answer: the process state (with bridge.env's PATH, never a value from
    // it), the Element channel's recent messages and failures, the policy, and a FRESH gateway probe. One
    // request means the four sections cannot disagree about the moment they describe.
    if (route === "/api/matrix/status" && req.method === "GET") {
      await jobs.probe();
      return sendJson(res, 200, {
        at: new Date().toISOString(),
        bridge: matrixBridge.state(),
        element: element.state(),
        policy: matrixPolicy.payload(),
        // The bridge's reminders and the read-only watches view ride in the same answer, so the pane draws the
        // connection, the policy and the list it keeps from one moment instead of four.
        reminders: matrixReminders.payload(),
        gateway: jobs.transportInfo(),
      });
    }

    // The policy store the next row consumes. GET carries the effective text (panel > environment default >
    // template), its path, its mtime and its size against the cap. POST replaces the panel's whole copy; the
    // mtime the page read travels with it, so a write made in between is a 409 rather than a lost edit, and
    // over the cap is a 413 with the numbers in it.
    if (route === "/api/matrix/policy" && req.method === "GET") {
      return sendJson(res, 200, matrixPolicy.payload());
    }

    if (route === "/api/matrix/policy" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return sendJson(res, 400, { error: "send a JSON object with a string `text` — that is the whole policy" });
      }
      try {
        return sendJson(res, 200, matrixPolicy.save(body.text, { expectMtime: body.expectMtime }));
      } catch (e) {
        const code = (e && e.code) === "policy-too-long" ? 413 : (e && e.code) === "policy-stale" ? 409 : 400;
        return sendJson(res, code, { error: String((e && e.message) || e), ...matrixPolicy.payload() });
      }
    }

    // The bridge's OWN reminder list, beside the policy and deliberately a different file: the policy is how the
    // bridge speaks, these are things the reader asked it to remember. Distinct from an assistant's watches, which
    // are a THREAD plus a state and wake an assistant — a reminder has neither. GET is one answer: the reminders,
    // their counts, and the assistants' watches as a READ-ONLY projection (`watchesReadOnly`, and `readOnly` on
    // every row). POST is the page's write — add, complete, reopen, re-word, delete — and `MatrixRemindersStore.apply`
    // refuses any body naming a watch field BEFORE it touches the file, so this route can never become a second
    // writer for lib/assistant.js's list. 413 the list is full · 404 that id is gone · 400 every other refusal,
    // the read-only one included: a bad body is not a missing permission.
    if (route === "/api/matrix/reminders" && req.method === "GET") {
      return sendJson(res, 200, matrixReminders.payload());
    }

    if (route === "/api/matrix/reminders" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return sendJson(res, 400, {
          ...matrixReminders.payload(),
          error: 'send a JSON object — { "text": "…" } to add, { id, done: true } to complete, { id, remove: true } to delete',
        });
      }
      try {
        return sendJson(res, 200, matrixReminders.apply(body));
      } catch (e) {
        const code = (e && e.code) === "reminders-full" ? 413 : (e && e.code) === "reminder-not-found" ? 404 : 400;
        return sendJson(res, code, { ...matrixReminders.payload(), error: String((e && e.message) || e) });
      }
    }

    // The models the New-agent form offers. Read from the gateway home, not from the run stream: the
    // provider's live list is what Hermes itself fetched, and a stale one is reported as stale rather
    // than presented as truth. Each row also carries the in/out price per Mtok and the 0-10 coding
    // rating the shipped CLI picker shows — read from this panel's own cache file and NOT fetched
    // here, so opening the menu can never wait on a cold endpoint.
    if (route === "/api/models" && req.method === "GET") {
      const catalogue = modelCatalogue({ home: hermesHome(), pricingFile: config.modelPricingFile });
      warmModelPrices(config, catalogue); // fire and forget: the answer above is file-only
      return sendJson(res, 200, catalogue);
    }

    // Regenerate the menu rather than re-read it. The gateway re-fetches every authenticated
    // provider's live /v1/models list and persists it — the same file `hermes model --refresh`
    // writes, and the file the menu above lists from — and the panel then rebuilds its price/rating
    // cache from that answer, having deleted its own copy first. Both files' row counts and mtimes
    // come back with the reply, because "the press did something" is otherwise indistinguishable
    // from "the page re-read the same bytes".
    if (route === "/api/models/refresh" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      try {
        const result = await refreshModelCatalogue({
          home: hermesHome(),
          pricingFile: config.modelPricingFile,
          api: jobs.api,
          log,
        });
        return sendJson(res, 200, result);
      } catch (e) {
        return sendJson(res, 502, { error: String((e && e.message) || e), ...((e && e.partial) || {}) });
      }
    }

    // ---- the assistant: a sentry over this board, and one thread the reader talks to ----------------
    // Every read is free of side effects; every write is authorised like the rest of the panel and
    // returns the whole assistant state so the float repaints from one answer instead of guessing.
    if (route === "/api/assistant" && req.method === "GET") {
      return sendJson(res, 200, assistant.state());
    }

    // The message board between the assistant and the agents. Deliberately NOT part of the polled state:
    // it is the whole seven-day conversation, it is only read while its tab is open, and it is built from
    // the job store and the journal on every request (no cache to prune). The cap and the window travel
    // with the answer, so the tab can say which one it is up against.
    if (route === "/api/assistant/messages" && req.method === "GET") {
      const q = new URL(req.url, "http://127.0.0.1").searchParams;
      const days = Number(q.get("days"));
      const cap = Number(q.get("cap"));
      return sendJson(res, 200, {
        messages: assistant.messages({
          ...(Number.isFinite(days) && days > 0 ? { days: Math.min(30, days) } : {}),
          ...(Number.isFinite(cap) && cap > 0 ? { cap: Math.min(2000, Math.round(cap)) } : {}),
        }),
      });
    }

    // The continuity file — the long tier of the assistant's memory, injected into every turn. GET carries
    // the text (the polled state carries only its path, size and mtime, so a 20 KB body is not re-sent on
    // every board event); PUT replaces it whole. Too big is its own status: the module raises the cap
    // refusal with the numbers in it, and 413 says "prune it" rather than "something broke".
    if (route === "/api/assistant/charter" && req.method === "GET") {
      return sendJson(res, 200, { charter: assistant.charterPayload(), assistant: assistant.state() });
    }
    if (route === "/api/assistant/charter" && req.method === "PUT") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: String((e && e.message) || e) });
      }
      try {
        const charter = assistant.setCharter(body.text, "reader", { expectMtime: body.expectMtime });
        return sendJson(res, 200, { charter, assistant: assistant.state() });
      } catch (e) {
        // 413 prune it · 409 someone else wrote it since you read it · 400 anything else.
        const code = (e && e.code) === "charter-too-long" ? 413 : (e && e.code) === "charter-stale" ? 409 : 400;
        return sendJson(res, code, { error: String((e && e.message) || e) });
      }
    }

    // ---- roles and assistants --------------------------------------------------------------------------
    // A role is {id, name, description, charter}: the job title, one line of remit, and the long tier that used
    // to belong to the panel's one assistant. `assistantId` says WHICH assistant's role and charter this is —
    // #1 by default, so every old caller keeps meaning the assistant the panel has always had.
    //
    // The library's read, by the name the brief uses (`GET /api/roles`). Metadata only: name, one line of remit and
    // the charter's size — never the text. The Role tab fetches the one charter it is showing through
    // /api/assistant/role/charter, and a list that carried six 20 KB bodies would be 120 KB on every poll.
    if (route === "/api/roles" && req.method === "GET") {
      return sendJson(res, 200, { roles: assistant.rolesList(), count: assistant.roles.length });
    }
    //
    // This is the one assistant route that carries charter TEXT, and it is fetched when the Role tab opens:
    // the polled state above carries sizes and paths only. The cap (413) and the stale save (409) are the same
    // two refusals the charter route raises, because a role's charter and an assistant's copy are written by the
    // same hand.
    if (route === "/api/assistant/role" && req.method === "GET") {
      const q = new URL(req.url, "http://127.0.0.1").searchParams;
      try {
        return sendJson(res, 200, { ...assistant.rolePayload(q.get("assistantId") || undefined), assistant: assistant.state() });
      } catch (e) {
        return sendJson(res, 404, { error: String((e && e.message) || e) });
      }
    }
    if (route === "/api/assistant/role" && req.method === "PUT") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        return sendJson(res, 400, { error: String((e && e.message) || e) });
      }
      try {
        const charter = assistant.setCharterFor(body.assistantId, body.text, "reader", { expectMtime: body.expectMtime });
        return sendJson(res, 200, { charter, ...assistant.rolePayload(body.assistantId), assistant: assistant.state() });
      } catch (e) {
        const code = (e && e.code) === "charter-too-long" ? 413 : (e && e.code) === "charter-stale" ? 409 : 400;
        return sendJson(res, code, { error: String((e && e.message) || e) });
      }
    }
    // ONE role's OWN charter text, by id: the Role tab changes its box to this text when the picker changes, and
    // the tab must not carry it around in state. GET because it changes nothing — the pick is still its own press
    // and Save still writes the ASSISTANT's copy, which is a different file.
    if (route === "/api/assistant/role/charter" && req.method === "GET") {
      const q = new URL(req.url, "http://127.0.0.1").searchParams;
      try {
        return sendJson(res, 200, assistant.roleCharterPayload(q.get("roleId")));
      } catch (e) {
        const code = (e && e.code) === "role-unknown" ? 404 : 400;
        return sendJson(res, code, { error: String((e && e.message) || e) });
      }
    }
    // Picking a role changes the job title; `adopt` also replaces that assistant's copy of the charter with the
    // role's text. Two presses in the tab, one route: the server never decides to overwrite a reader's edit.
    if (route === "/api/assistant/role/pick" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      try {
        const out = assistant.pickRole(body.assistantId, body.roleId, { adopt: Boolean(body.adopt) });
        return sendJson(res, 200, { ...out, assistant: assistant.state() });
      } catch (e) {
        return sendJson(res, (e && e.code) === "role-unknown" ? 404 : 400, { error: String((e && e.message) || e) });
      }
    }
    // A restart of ONE assistant's turn context: its NEXT turn is rebuilt from the role its record already carries —
    // the charter, the board digest and the queue digest go in full again — with no panel restart and no gateway call.
    // A POST because it changes state, and the whole assistant state rides back so the pane repaints from one answer.
    if (route === "/api/assistant/role/restart" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      try {
        const out = assistant.restartRole(body.assistantId);
        return sendJson(res, 200, { ...out, assistant: assistant.state() });
      } catch (e) {
        return sendJson(res, (e && e.code) === "assistant-unknown" ? 404 : 400, { error: String((e && e.message) || e) });
      }
    }
    // A HARD RESTART of ONE assistant: it moves to a fresh Hermes thread — a new session id, so its next turn carries
    // none of the conversation it has been having — and drops that assistant's session-recall records, so the first
    // turn of the new session sends the charter, the board and the queue in full. The panel and the gateway are not
    // restarted, and no other assistant's thread moves. 409 when a turn is still running: the thread must not move
    // under a live run. The whole assistant state rides back, the way every other assistant route answers, so the
    // pane repaints from one truth.
    if (route === "/api/assistant/hard-restart" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      try {
        const out = assistant.hardRestart(body.assistantId || undefined);
        return sendJson(res, 200, { ...out, assistant: assistant.state() });
      } catch (e) {
        const code = e && e.code;
        return sendJson(res, code === "assistant-unknown" ? 404 : code === "assistant-live" ? 409 : 400, {
          ...(code ? { code } : {}),
          error: String((e && e.message) || e),
        });
      }
    }
    // One assistant's own profile: the default role prompt it runs on and the escalation list it would hand a
    // subject to (stored; nothing acts on it yet). One route for both fields because they are one file beside that
    // assistant's charter — a save of either writes that file whole, and a field left out of the body keeps what the
    // file already holds. `assistantId` defaults to #1, whose file carries only these keys (its knobs stay in
    // assistant.json). The two whitelists this route used to carry are gone: the SPAWN switch is the only gate, and
    // a tree's owner is the assistant whose turn wrote the SPAWN.
    if (route === "/api/assistant/profile" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      try {
        const out = assistant.saveProfile(body.assistantId || undefined, {
          prompt: body.prompt,
          // The ordered escalation list. Stored and inert: the route carries it because it is one field of the same
          // per-assistant file, and nothing in the wake path reads it yet.
          escalateTo: body.escalateTo,
          // The frame that assistant's pane is drawn in, saved in the same file. The page reads it back from the
          // state this answer carries and re-frames the open panel, so the switch needs no reload.
          dock: body.dock,
        });
        return sendJson(res, 200, { ...out, assistant: assistant.state() });
      } catch (e) {
        const code = (e && e.code) === "assistant-unknown" ? 404 : (e && e.code) === "profile-write-failed" ? 500 : 400;
        return sendJson(res, code, { error: String((e && e.message) || e) });
      }
    }
    if (route === "/api/assistant/roles" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      try {
        const out = assistant.createRole({ name: body.name, description: body.description, from: body.from, charter: body.charter });
        return sendJson(res, 201, { ...out, assistant: assistant.state() });
      } catch (e) {
        return sendJson(res, 400, { error: String((e && e.message) || e) });
      }
    }
    // "New assistant from this role": the next number, its own thread, its own rules and its own copy of the
    // role's charter. It starts no turn — the reader talks to it in its own tab, and the first message starts one.
    if (route === "/api/assistant/assistants" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      try {
        const out = assistant.createAssistant({ roleId: body.roleId, name: body.name });
        return sendJson(res, 201, { ...out, assistant: assistant.state() });
      } catch (e) {
        const code = (e && e.code) === "assistant-full" ? 409 : (e && e.code) === "role-unknown" ? 404 : 400;
        return sendJson(res, code, { error: String((e && e.message) || e) });
      }
    }

    // A message from the reader. The board digest and the scratchpad are attached to the run's input by
    // the module, so the card shows the sentence the reader typed.
    if (route === "/api/assistant/say" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const text = String(body.text || "").trim();
      if (!text) return sendJson(res, 400, { error: "text is required" });
      try {
        const job = await assistant.say(text, { assistantId: body.assistantId });
        return sendJson(res, 202, { job, assistant: assistant.state() });
      } catch (e) {
        return sendJson(res, 409, { error: String((e && e.message) || e) });
      }
    }

    if (route === "/api/assistant/settings" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      // Which assistant these knobs belong to. No `assistantId` means Assistant #1 — the route, the file and the
      // answer the page's own Settings pane has always posted to, unchanged; any other id is that assistant's own
      // profile file, beside its charter.
      const { assistantId, id, name, ...patch } = body || {};
      try {
        // A rename rides the SAME route the pane already posts its knobs to: the name belongs to the assistant's
        // RECORD (the store create/pick-role own), not to its settings profile, and writing it here is what keeps one
        // assistant settings tab from needing a second endpoint. It is checked FIRST, so a refused name leaves every
        // knob in the body unwritten.
        const renamed = name === undefined ? null : assistant.renameAssistant(assistantId || id || undefined, name);
        // A rename-only POST must not rewrite (or, on a profile with an absent key, freeze) the knobs beside it.
        const settings = Object.keys(patch).length
          ? assistant.setSettingsFor(assistantId || id || undefined, patch)
          : assistant.settingsFor(assistantId || id || undefined);
        return sendJson(res, 200, { settings, renamed, assistant: assistant.state() });
      } catch (e) {
        const code =
          (e && e.code) === "assistant-unknown" ? 404 : (e && e.code) === "profile-write-failed" ? 500 : 400;
        return sendJson(res, code, { error: String((e && e.message) || e) });
      }
    }

    // The header's aggressive-mode toggle. One route for one button: `on` is the requested state and the answer
    // says whether anything changed — pressing it twice, or switching off a mode that was never on, comes back
    // changed:false with a reason instead of silently pretending it did something. The whole assistant state
    // rides with the answer so the float repaints from one response.
    if (route === "/api/assistant/aggressive" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const wanted = body.on === undefined ? !assistant.aggressive.on : Boolean(body.on);
      const out = assistant.setAggressive(wanted);
      return sendJson(res, 200, { ...out, settings: assistant.settings, assistant: assistant.state() });
    }

    // Dismiss an alert, or hand it to the assistant (one digest, rate limited). Nothing here answers an
    // approval: that stays on the agent's own card, where the gateway validates the choice.
    if (route === "/api/assistant/alert" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      try {
        const alert = assistant.alertAction(String(body.id || ""), String(body.action || ""));
        return sendJson(res, 200, { alert, assistant: assistant.state() });
      } catch (e) {
        return sendJson(res, 400, { error: String((e && e.message) || e) });
      }
    }

    // The reader pressing Send on a draft: the one path that posts into a worker's thread by hand.
    if (route === "/api/assistant/answer" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      try {
        const job = await assistant.answerThread(String(body.thread || ""), body.text, {
          source: "reader",
          alertId: body.alertId ? String(body.alertId) : null,
        });
        return sendJson(res, 202, { job, assistant: assistant.state() });
      } catch (e) {
        // 409 for a worker that is already turning: the request was well-formed and understood, and the answer is
        // "not now" (the code a steer that missed the last tool boundary already gets). 400 for everything else.
        return sendJson(res, (e && e.code) === "thread_busy" ? 409 : 400, { error: String((e && e.message) || e) });
      }
    }

    // The Element room's read. One pass of the channel is already on its own clock, so this is a pure read: what
    // is open, what the panel sent (its CURRENT text, outcome included), and every send that failed. The Gateway
    // tab's block polls this, and it is the only surface that shows a swallowed-looking failure.
    if (route === "/api/assistant/element" && req.method === "GET") {
      return sendJson(res, 200, element.state());
    }
    // Re-send the record whose send failed. The SAME record — a press here can never become a second copy in
    // the room, which is what a "resend everything" button would do.
    if (route === "/api/assistant/element/retry" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      try {
        const out = await element.retry(body && body.id ? String(body.id) : null);
        return sendJson(res, 200, out);
      } catch (e) {
        return sendJson(res, 400, { error: String((e && e.message) || e) });
      }
    }

    // Answer a question the run is parked on (the `clarify` tool). Not a reply: it settles the prompt the
    // gateway is holding, so the turn resumes where it stopped.
    if (route === "/api/assistant/answer-question" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      try {
        const result = await assistant.answerParked(String(body.id || ""), body.answer);
        broadcast({ type: "jobs", jobs: jobs.list() });
        return sendJson(res, 200, { result, assistant: assistant.state() });
      } catch (e) {
        return sendJson(res, 400, { error: String((e && e.message) || e) });
      }
    }

    // Create a worktree (or use a directory that already exists) and start a worker. `{id}` confirms a spawn
    // card the assistant proposed; the spec form is the same act without a card. Both go through the one
    // spawner, so neither can skip the gateway probe or the unborn-HEAD refusal.
    if (route === "/api/assistant/spawn" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      try {
        const spec = body.id ? assistant.pendingSpawn(String(body.id)) : body;
        if (!spec) throw new Error(`no pending spawn with id ${body.id}`);
        const job = await assistant.startSpawn(spec, { alertId: body.id ? String(body.id) : null });
        broadcast({ type: "jobs", jobs: jobs.list() });
        return sendJson(res, 202, { job, assistant: assistant.state() });
      } catch (e) {
        return sendJson(res, 400, { error: String((e && e.message) || e) });
      }
    }

    if (route === "/api/assistant/watch" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      try {
        const watch = assistant.addWatch(body, "reader");
        return sendJson(res, 201, { watch, assistant: assistant.state() });
      } catch (e) {
        return sendJson(res, 400, { error: String((e && e.message) || e) });
      }
    }
    if (route === "/api/assistant/watch/remove" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      return sendJson(res, 200, { watches: assistant.removeWatch(String(body.id || "")), assistant: assistant.state() });
    }

    if (route === "/api/assistant/rule" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      try {
        const rules = assistant.addRuleFor(body.assistantId, body.text);
        return sendJson(res, 201, { rules, assistant: assistant.state() });
      } catch (e) {
        return sendJson(res, 400, { error: String((e && e.message) || e) });
      }
    }
    if (route === "/api/assistant/rule/remove" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      return sendJson(res, 200, { rules: assistant.removeRuleFor(body.assistantId, String(body.id || "")), assistant: assistant.state() });
    }

    // The scratchpad of ONE assistant. GET carries the text (the polled state carries Assistant #1's string only —
    // an extra assistant's pad is a file, and the Pad tab reads it when the reader opens the tab); POST is the
    // reader's save. `assistantId` says whose pad, #1 by default, so every old caller keeps meaning the assistant the
    // panel has always had. A save in #2's pane writes #2's notes.md and nothing else.
    if (route === "/api/assistant/notes" && req.method === "GET") {
      const q = new URL(req.url, "http://127.0.0.1").searchParams;
      try {
        return sendJson(res, 200, { ...assistant.notesPayloadFor(q.get("assistantId") || undefined), assistant: assistant.state() });
      } catch (e) {
        return sendJson(res, 404, { error: String((e && e.message) || e) });
      }
    }
    if (route === "/api/assistant/notes" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      try {
        const notes = assistant.setNotesFor(body.assistantId, body.text);
        return sendJson(res, 200, { ...notes, assistant: assistant.state() });
      } catch (e) {
        return sendJson(res, 400, { error: String((e && e.message) || e) });
      }
    }

    // One sentry pass on demand. Used by the page after a change that should be judged at once, and by
    // the verification probes instead of waiting for the clock.
    if (route === "/api/assistant/check" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      assistant.tick();
      return sendJson(res, 200, { assistant: assistant.state() });
    }

    // The reader's lock, toggled from the row's emoji (lib/locks.js). `scope` says which lock the press is about —
    // "tree" for this worktree, "branch" for the branch it is on and every worktree cut from that branch later — and
    // `locked` omitted means flip. The answer carries the checked state so the button can paint what the server now
    // holds rather than what the page hoped; every open board repaints from the snapshot the write broadcasts.
    if (route === "/api/worktree/lock" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const projectName = String(body.project || "").trim();
      const project = scheduler.getProjects().find((p) => p.name === projectName);
      if (!project) return sendJson(res, 404, { error: `unknown project: ${projectName}` });
      const scope = String(body.scope || "tree").toLowerCase() === "branch" ? "branch" : "tree";
      // The row is the authority for both halves: its path is the key git and the store use, and its branch is what a
      // branch lock is about. A path the caller names that is not this project's row is refused rather than locked,
      // so a typo cannot protect a directory nobody is looking at.
      const asked = body.path ? normPathKey(body.path) : null;
      const row = asked ? scheduler.store.rowsFor(projectName).find((r) => normPathKey(r.path) === asked) : null;
      if (asked && !row) return sendJson(res, 404, { error: `not a worktree row of ${projectName}: ${body.path}` });
      if (!asked && scope === "tree") return sendJson(res, 400, { error: "a worktree path is required to lock a worktree" });
      const branch = scope === "branch" ? String(body.branch || row?.branch || "").trim() : row?.branch || null;
      if (scope === "branch" && !branch) return sendJson(res, 400, { error: "this row has no branch to lock" });
      const out = locks.toggle({
        project: projectName,
        path: row?.path || String(body.path || ""),
        branch,
        scope,
        locked: body.locked === undefined ? null : Boolean(body.locked),
      });
      if (!out.ok) return sendJson(res, 400, { error: out.error || "the lock could not be changed" });
      const lock = locks.check({ project: projectName, path: row?.path || String(body.path || ""), branch: row?.branch || branch });
      const what = scope === "branch" ? `branch ${branch}` : `worktree ${row?.name || path.basename(String(row?.path || body.path || ""))}`;
      log(`lock ${out.locked ? "set" : "cleared"} on ${what} in ${projectName}${out.locked ? " — deletes are refused until it is removed" : ""}`);
      broadcast({ type: "snapshot", data: snapshot() });
      return sendJson(res, 200, {
        ok: true,
        scope,
        locked: Boolean(out.locked),
        lock,
        say: out.locked ? `🔒 ${what} is locked — nothing may delete it until you unlock it` : `🔓 ${what} is unlocked`,
      });
    }

    // Who owns a worktree: the assistant whose NAME the optional chart column draws ("Assistant #1"), whose role
    // label rides in that cell's tooltip and whose bullet list reads "Controlled by: Assistant #1 — Manager". Same
    // shape as the two settings routes above — the reader names a row and one value,
    // and the answer carries the stored result back — because this is the same kind of fact: the panel's own,
    // per-tree, persisted beside the lock (lib/locks.js) and DISPLAY ONLY. Nothing in fired()/wake()/noteSettle
    // reads it in this PR.
    //
    // THE READER'S OWN PRESS IS THE ONLY CALLER, and that is a rule about this route rather than a convention:
    // the owner is what will decide who wakes on this tree in the routing PR, so an agent must never be able to
    // reassign the tree it is working in. A loopback panel has no user accounts, so the gate is the page's own
    // request shape — `pageCaller` below. A browser attaches `Origin` to every same-origin POST and a page script
    // cannot set it (it is a forbidden header name), while a run's own `curl`/`fetch` from a shell sends none. A
    // request without a same-origin Origin is refused with a sentence and the store does not move. Nothing in the
    // assistant's action grammar (lib/assistant/actions.js) can write this either: "make Assistant #2 own that
    // worktree" is not a line an assistant can end its turn with, so a run has no route here at all.
    //
    // The default owner is Assistant #1 and absence is how that is represented, so setting #1 CLEARS the entry
    // rather than writing a record that means what the absent key already means. The id must name a real assistant:
    // a typo would otherwise store an owner the row could not name, and the next read would quietly show Assistant #1
    // with no trace of the mistake.
    if (route === "/api/worktree/assistant" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      if (!pageCaller(req)) {
        return sendJson(res, 403, {
          error:
            "the worktree's owner is the reader's to set: this write is made from the board page, and a request with no same-origin Origin is refused",
        });
      }
      const body = await readBody(req).catch(() => ({}));
      const projectName = String(body.project || "").trim();
      const project = scheduler.getProjects().find((p) => p.name === projectName);
      if (!project) return sendJson(res, 404, { error: `unknown project: ${projectName}` });
      const asked = body.path ? normPathKey(body.path) : null;
      const row = asked ? scheduler.store.rowsFor(projectName).find((r) => normPathKey(r.path) === asked) : null;
      if (!row) return sendJson(res, 404, { error: `not a worktree row of ${projectName}: ${body.path || "(none)"}` });
      const id = String(body.assistant ?? body.assistantId ?? "").trim();
      if (!id) return sendJson(res, 400, { error: "an assistant id is required — one of the ids /api/assistant lists" });
      const rec = assistant.assistants.find((a) => a.id === id);
      if (!rec) return sendJson(res, 404, { error: `no such assistant: ${id}` });
      const out = locks.setOwner({ project: projectName, path: row.path, branch: row.branch }, id === DEFAULT_OWNER ? null : id);
      if (!out || !out.ok) return sendJson(res, 400, { error: "the owner could not be changed" });
      const fields = ownerFields(rec);
      const what = row.name || path.basename(String(row.path || ""));
      log(`owner ${projectName}: ${what} -> ${fields.name} (${fields.label || "no role label"}, ${rec.id})`);
      // A settings-like write: every open board redraws the row's bullet list and column from this snapshot.
      broadcast({ type: "snapshot", data: snapshot() });
      return sendJson(res, 200, {
        ok: true,
        assistant: fields,
        // The SAME shape the snapshot carries, fallback sentence included, so a caller that paints the answer and a
        // board that paints the next snapshot cannot disagree about the row.
        row: { ...row, assistant: assistantForRow(projectName, row) },
      });
    }

    // Handing a WORKTREE from one assistant to another. The same store as the row's owner control, with the two
    // things a hand-over needs and a plain set does not: it names the owner it is taking the tree FROM (so a stale
    // press cannot move a tree that has already changed hands), and it answers with both ends and the routing that
    // follows the flip — the wake a run in that tree now raises, and the row's own new owner cell.
    //
    // The reader's press is the only caller, for the reason the row's control gives: an agent must never be able to
    // reassign the tree it is working in. `from` is how a reader's board that has gone stale is told so instead of
    // overwriting somebody else's answer; omitting it is the deliberate "whatever it is now" move.
    if (route === "/api/worktree/transfer" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      if (!pageCaller(req)) {
        return sendJson(res, 403, {
          error:
            "a worktree changes hands only from the board page: this write is the reader's, and a request with no same-origin Origin is refused",
        });
      }
      const body = await readBody(req).catch(() => ({}));
      const projectName = String(body.project || "").trim();
      const project = scheduler.getProjects().find((p) => p.name === projectName);
      if (!project) return sendJson(res, 404, { error: `unknown project: ${projectName}` });
      const asked = body.path ? normPathKey(body.path) : null;
      const row = asked ? scheduler.store.rowsFor(projectName).find((r) => normPathKey(r.path) === asked) : null;
      if (!row) return sendJson(res, 404, { error: `not a worktree row of ${projectName}: ${body.path || "(none)"}` });
      const to = String(body.to ?? body.assistant ?? body.assistantId ?? "").trim();
      if (!to) return sendJson(res, 400, { error: "an assistant id is required in `to` — one of the ids /api/assistant lists" });
      const rec = assistant.assistants.find((a) => a.id === to);
      if (!rec) return sendJson(res, 404, { error: `no such assistant: ${to}` });
      const before = assistantForRow(projectName, row);
      const from = String(body.from ?? "").trim();
      // The stale press is refused rather than obeyed: the answer carries whose tree it actually is.
      if (from && from !== before.id) {
        return sendJson(res, 409, {
          error: `${row.name || path.basename(String(row.path || ""))} is ${before.name}'s, not ${from}'s — nothing was changed`,
          from: before.id,
          to: rec.id,
          owner: before,
        });
      }
      const what = row.name || path.basename(String(row.path || ""));
      if (before.id === rec.id) {
        // Already theirs. A second press is an answer, not an error, and the routing it describes is the same one.
        return sendJson(res, 200, {
          ok: true,
          changed: false,
          from: before.id,
          to: rec.id,
          owner: ownerFields(rec),
          row: { ...row, assistant: assistantForRow(projectName, row) },
        });
      }
      // The id is written EXACTLY as asked, Assistant #1 included. The row's own control keeps "absence is #1" (it is
      // a preference, and the default needs no record); a hand-over is the routing DECISION, and a decision that hands
      // a tree back must be able to say so — left absent, the next run started in the tree by the assistant that had it
      // would still carry its stamp and route to it, and the hand-back would be invisible to every wake.
      const out = locks.setOwner({ project: projectName, path: row.path, branch: row.branch }, rec.id);
      if (!out || !out.ok) return sendJson(res, 400, { error: "the owner could not be changed" });
      const fields = ownerFields(rec);
      log(`handover ${projectName}: ${what} ${before.name} (${before.id}) -> ${fields.name} (${rec.id})`);
      // A settings-like write: every open board redraws the row's owner cell and its bullet list from this snapshot.
      broadcast({ type: "snapshot", data: snapshot() });
      return sendJson(res, 200, {
        ok: true,
        changed: true,
        from: before.id,
        fromOwner: before,
        to: rec.id,
        owner: fields,
        // What the flip means for the work already in that tree: the runs it holds are this assistant's now, so the
        // next settle raises a wake on ITS thread and its settings judge them. Said here so a caller does not have to
        // know `assistantIdForJob`'s order to know what it just did.
        wake: { assistantId: rec.id, thread: rec.threadId },
        row: { ...row, assistant: assistantForRow(projectName, row) },
      });
    }

    if (route === "/api/state" || route === "/api/audit") {
      return sendJson(res, 200, snapshot());
    }

    // ---- the panel's own folders, acted on only when the reader asks -------------------------------------
    // Settings > Data shows the data and scratch directories with their sizes (both ride in /api/state as
    // `paths`). These two routes are the only things that touch them: one opens a folder, one empties the
    // scratch directory. Both are writes, so both are authorised.
    if (route === "/api/paths/open" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const which = String(body.which || "data").trim().toLowerCase();
      const target = which === "data" ? config.dataDir : which === "scratch" ? config.scratchDir : which === "logs" ? config.logsDir : null;
      if (!target) return sendJson(res, 400, { error: `unknown folder “${which}” — one of data, scratch, logs` });
      // Created before it is opened: the button says "open the folder", and a folder that exists but is empty is
      // a better answer than "there is no such folder" on a panel that has simply not written anything yet.
      try {
        ensureDirs(config);
      } catch (e) {
        return sendJson(res, 500, { error: `could not create ${target}: ${String((e && e.message) || e)}` });
      }
      const { bin, args, error } = openerForFolder(target);
      if (error) return sendJson(res, 400, { error });
      try {
        // Detached, exactly like /api/open-url: explorer.exe reports an exit code before the window is up, so the
        // spawn is the only thing this route can honestly report on.
        const child = spawn(bin, args, { detached: true, stdio: "ignore", windowsHide: true });
        child.on("error", (e) => log(`could not open ${target}: ${String((e && e.message) || e)}`));
        child.unref();
      } catch (e) {
        return sendJson(res, 500, { error: String((e && e.message) || e) });
      }
      return sendJson(res, 200, { ok: true, which, path: target, opened: bin });
    }

    // Empty the scratch directory. Three things REFUSE the whole clean, none of them a partial one: a folder the panel
    // did not make or one that holds its own state/checkout/projects (paths.js, `scratchProblem` and the marker file),
    // and a live run that is working in it or was told to write in it — on Windows the delete would half-fail under a
    // process holding the files, and the agent would be left with a tree that no longer adds up. The refusal names the
    // reason, and the reader fixes the setting, stops the run, or cleans it by hand.
    if (route === "/api/scratch/clean" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const out = await cleanScratch({
        scratchDir: config.scratchDir,
        jobs: jobs.list(),
        dataDir: config.dataDir,
        home: homedir(),
        // Everything a mistyped scratchDir could be an ancestor of: this checkout, the config's folder, the panel's own
        // state, its default working folder, the scan roots and every project the registry knows.
        keep: [
          HERE, CONFIG_DIR, config.stateDir, config.attachmentsDir, config.logsDir, config.defaultCwd,
          ...(Array.isArray(config.scanRoots) ? config.scanRoots : []),
          ...registry.projects.map((p) => p.path),
        ],
      });
      if (!out.ok) {
        log(`scratch NOT cleaned: ${out.error}`);
        return sendJson(res, out.refused ? 409 : 500, { ...out, freed: "0 B", paths: pathsInfo() });
      }
      sizeOf(config.scratchDir, { fresh: true });
      const freed = humanBytes(out.freedBytes);
      log(
        `scratch cleaned: freed ${freed} (${out.removedFiles} file(s), ${out.removedDirs} folder(s)) from ${config.scratchDir}` +
          `${out.leftBehind ? ` — ${out.leftBehind} entr${out.leftBehind === 1 ? "y" : "ies"} could not be removed (still open)` : ""}`,
      );
      // Every open Settings tab repaints from this: the size in the row has to move with the press.
      broadcast({ type: "snapshot", data: snapshot() });
      return sendJson(res, 200, { ...out, freed, paths: pathsInfo() });
    }

    // On-demand cleanup audit for ONE project, straight from `hermes worktree list --json`:
    // linked trees, externally-registered trees (with locked/missing), and a keep/reap verdict
    // with a reason for every local branch. ~6s per repo, so it is never polled — the UI (or a
    // script) asks for one project when it wants the detail /api/state deliberately omits.
    if (route === "/api/cleanup" && req.method === "GET") {
      const name = url.searchParams.get("project");
      const target = registry.projects.find((p) => p.name === name) || null;
      if (!target) return sendJson(res, 404, { error: `unknown project: ${name || "(none)"}` });
      const t0 = Date.now();
      try {
        // The job store decides what is LIVE, whatever git says about the tree: a run's own cwd (and the tree the
        // panel cut for it) is handed to the audit so a working agent's tree can never be offered as deletable. It
        // is read here, per request, and never cached with the audit — a run that started a second ago counts.
        const liveCwds = jobs.runningJobs().flatMap((j) => [j.cwd, j.worktreePath, j.ownerPath]).filter(Boolean);
        const audit = await auditRepo(target.path, { config, force: url.searchParams.get("fresh") === "1", liveCwds });
        return sendJson(res, 200, { project: target.name, path: target.path, tookMs: Date.now() - t0, ...audit });
      } catch (e) {
        return sendJson(res, 502, { project: target.name, path: target.path, tookMs: Date.now() - t0, error: String((e && e.message) || e) });
      }
    }

    // ---- where a project's branches and PRs live ---------------------------------------------------------------
    // The mapping is data (logs/hosts.json + hosts.seed.json), so the page needs to read it and the reader needs a way
    // to fill one in without hand-editing JSON. Three routes: the whole mapping, a PROPOSAL read off the project's
    // own remote (never written), and the confirm that writes it. The proposal is separate from the write on purpose:
    // nothing here guesses a host into the file, and a mapping the reader did not confirm is not a mapping.
    if (route === "/api/hosts" && req.method === "GET") {
      const doc = hosts.doc({ fresh: true });
      return sendJson(res, 200, {
        ...hosts.state(),
        warnings: doc.warnings,
        projects: Object.fromEntries(registry.projects.map((p) => [p.name, hosts.view(p)])),
      });
    }

    if (route === "/api/hosts/propose" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const project = registry.projects.find((p) => p.name === String(body.project || "").trim());
      if (!project) return sendJson(res, 404, { error: `unknown project: ${body.project || "(none)"}` });
      let remoteUrl = "";
      if (project.remote) {
        const r = await gitIn(project.path, ["remote", "get-url", project.remote], 15000);
        remoteUrl = r.ok ? String(r.out || "").trim() : "";
      }
      const proposal = proposeMapping(hosts.doc({ fresh: true }), project, remoteUrl);
      return sendJson(res, 200, { project: project.name, remote: project.remote || null, proposal, current: hosts.view(project) });
    }

    if (route === "/api/hosts/mapping" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const project = registry.projects.find((p) => p.name === String(body.project || "").trim());
      if (!project) return sendJson(res, 404, { error: `unknown project: ${body.project || "(none)"}` });
      const doc = hosts.doc({ fresh: true });
      const hostId = String(body.host || "").trim();
      if (!doc.hosts[hostId]) {
        return sendJson(res, 400, { error: `unknown host "${hostId}" — known hosts: ${Object.keys(doc.hosts).join(", ") || "(none)"}` });
      }
      // Coordinates arrive as an object, or as the one line a reader types: "owner/repo" for github, "PROJECTKEY/slug"
      // for a Bitbucket project. The second form is parsed here so the page does not have to know the kind.
      let coordinates = body.coordinates;
      if (typeof coordinates === "string") {
        const [first, second] = coordinates.split(/[\/,\s]+/).filter(Boolean);
        coordinates = doc.hosts[hostId].kind === "bitbucket-server" ? { projectKey: first, repoSlug: second } : { owner: first, repo: second };
      }
      try {
        hosts.save(project.name, { host: hostId, coordinates: coordinates || null });
      } catch (e) {
        return sendJson(res, 400, { error: String((e && e.message) || e) });
      }
      const view = hosts.view(project);
      log(`hosts: ${project.name} mapped to ${hostId}${view.links?.repo ? ` (${view.links.repo})` : ""}`);
      // The rows carry their link as a scan result, so the board repaints on the next pass; this event lets the page
      // show the new chip at once, and a resync from the page refreshes the rows.
      broadcast({ type: "hosts", hosts: hosts.state() });
      return sendJson(res, 200, { ok: true, project: project.name, mapping: view, file: hostsFile.file || null });
    }

    // ---- the steward: every local branch of one project, classified --------------------------------------------
    // Stage 3 of this feature, and it ACTS ON NOTHING. GET answers the last plan file; POST re-reads the repo and
    // writes a fresh one (the .md the reader can open, the .json the page reads). The plan says what it would delete,
    // what it would roll and what it needs the reader to answer.
    if (route === "/api/steward" && req.method === "GET") {
      const name = String(url.searchParams.get("project") || "").trim();
      const plan = name ? readPlan(config.stewardDir, name) : null;
      if (!plan) return sendJson(res, 404, { error: `no plan yet for ${name || "(no project)"} — POST /api/steward to write one` });
      return sendJson(res, 200, { ...plan, parents: parents.state(name) });
    }

    if (route === "/api/steward" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const name = String(body.project || "").trim();
      const out = await stewardProject(name);
      if (out.error) return sendJson(res, out.status || 400, { error: out.error });
      const written = writePlan(config.stewardDir, out.plan);
      log(`steward: ${name} — ${out.plan.counts.total} branch(es): ${out.plan.counts.delete} to delete, ${out.plan.counts.roll} to roll, ${out.plan.counts.ask} need an answer → ${written.md}`);
      return sendJson(res, 200, { ...out.plan, file: written.md, text: written.text, parents: parents.state(name) });
    }

    // The only writer. A dry run is the default: `confirm: true` alone is not enough — the body must name the plan
    // the reader was looking at (`planAt`), and the entries are re-read from git before anything is touched.
    if (route === "/api/steward/apply" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const name = String(body.project || "").trim();
      const out = await stewardProject(name);
      if (out.error) return sendJson(res, out.status || 400, { error: out.error });
      const file = readPlan(config.stewardDir, name);
      const listing = await stewardWorktrees(out.project.path);
      const result = await applyPlan({
        plan: file,
        fresh: out.plan,
        expectedAt: body.planAt ? String(body.planAt) : null,
        repoDir: out.project.path,
        trees: listing.trees,
        dryRun: body.dryRun !== false && body.confirm !== true,
        confirm: body.confirm === true,
        prodBranch: config.steward.prodBranch,
        onLog: log,
      });
      if (!result.ok) return sendJson(res, 409, result);
      if (result.dryRun) log(`steward apply (dry run): ${name} — ${result.delete.length} would be deleted, ${result.roll.length} would be rolled`);
      else {
        log(`steward apply: ${name} — deleted ${result.deleted.length}, rolled ${result.rolled.length}, refused ${result.refused.length}`);
        broadcast({ type: "snapshot", data: snapshot() });
      }
      return sendJson(res, 200, result);
    }

    // ---- cutting a child worktree off a row's own branch --------------------------------------------------------
    // The roll-up's other half, and the reason it exists: `rollUp` merges a child into the branch it was cut from,
    // inside THAT branch's worktree — so a parent which is a worktree branch has to exist. The only cut the panel
    // had (`jobs.makeWorktree`) starts from the project checkout's HEAD, i.e. it makes children of main, and main is
    // the one target a roll-up may never use. This cuts from the ROW's branch instead, and writes the cut down in
    // both books a parent is read from, so the child is `parentSource: "cut"` — the only source a roll may act on.
    //
    // One press, one tree: nothing is started in it, no branch is pushed, and the row's own work is not touched
    // (`git worktree add` writes a new index and a new branch, never the parent's files). A name is optional; the
    // panel derives one from the parent's branch and always keeps its own -<hex6> tag, which is every later
    // rename's identity.
    if (route === "/api/worktree/child" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const project = (registry.projects || []).find((p) => p.name === String(body.project || "").trim()) || null;
      if (!project) return sendJson(res, 404, { error: `unknown project: ${body.project || "(none)"}` });
      const row = store.rowsFor(project.name).find((r) => normPathKey(r.path) === normPathKey(body.path)) || null;
      if (!row) return sendJson(res, 404, { error: `no row for ${body.path || "(no path)"} in ${project.name}` });
      // The project's own checkout is a row, but it is not a worktree and its branch is the landing branch a child
      // would have no roll-up to arrive at. The button is not drawn there either; this is the same answer for a
      // script.
      if (normPathKey(row.path) === normPathKey(project.path)) {
        return sendJson(res, 409, { error: `refused: ${project.path} is the project's own checkout, not a worktree — start that work from the New-agent card` });
      }
      if (!row.branch) return sendJson(res, 409, { error: `refused: ${row.path} is on a detached HEAD, so there is no branch to cut from` });
      const out = await cutChildWorktree({
        repoDir: project.path,
        parentBranch: row.branch,
        mainBranch: project.mainBranch || null,
        name: body.name ? String(body.name).slice(0, 60) : "",
      });
      if (!out.ok) return sendJson(res, 409, { error: out.error, parent: row.branch, path: row.path });
      // The two records a parent is read from, and the naming ledger's one line. Nothing here may fail the cut: the
      // tree exists and git's answer is the truth; a book that cannot be read back is a child shown as a guess
      // rather than a child that was never made, which is the safe direction.
      try {
        parents.record({
          project: project.name,
          branch: out.branch,
          path: out.path,
          startRef: row.branch,
          startSha: out.parentSha,
          by: `the reader (＋ a child of ${row.branch} from its row)`,
        });
      } catch (e) {
        log(`child: ${out.branch} was cut but its parent record failed (${String((e && e.message) || e)})`);
      }
      try {
        jobs.rememberParent(out.path, out.branch, row.branch);
      } catch {
        /* the landing paragraph falls back to git's upstream for this tree; nothing about the cut depends on it */
      }
      // The rung. §3 is unconditional — every tree is `local` at cut time, whichever cut path made it — so the second
      // cut path writes the same record `makeWorktree` writes, through the same writer, at the same moment the landing
      // parent goes down. It cannot fail a cut that has already happened, and it must not claim one either: a book
      // that refused the write (unreadable, full, locked) answers null here, the log says the tree has no rung, and
      // the answer carries that null rather than a record nobody could read back.
      let pipeline = null;
      try {
        pipeline = jobs.recordCutPipeline(out.path);
      } catch (e) {
        log(`child: ${out.branch} was cut but its pipeline record failed (${String((e && e.message) || e)})`);
      }
      if (!pipeline) log(`child: ${out.branch} was cut but its pipeline record was refused — the tree has no rung, and this answer does not claim one`);
      try {
        treeNames.settle(treeKey({ project: project.name, path: out.path, branch: out.branch }), {
          name: out.name,
          dir: out.path,
          branch: out.branch,
          tag: out.tag,
          by: `the reader (＋ a child of ${row.branch})`,
          how: `cut from ${row.branch} by the row's ＋ — this name is the one it was created with`,
          at: new Date().toISOString(),
        });
      } catch {
        /* the ledger is a guard: an unrecorded name is one a later run's title may replace, never a failed cut */
      }
      // Boarded now rather than on the next discovery pass (slowSeconds is minutes away), so the child is a row the
      // reader can press straight away. Same door a spawn's tree comes through.
      await scheduler.adoptWorktree(project.name, out.path).catch(() => false);
      log(`child: cut ${out.branch} from ${row.branch} at ${out.path} (${project.name})`);
      broadcast({ type: "snapshot", data: snapshot() });
      return sendJson(res, 200, {
        ...out,
        pipeline,
        project: project.name,
        row: store.rowsFor(project.name).find((r) => normPathKey(r.path) === normPathKey(out.path)) || null,
      });
    }

    // ---- rolling one child into its parent ---------------------------------------------------------------------
    // The UNMERGED chip's first outcome. The merge happens inside the PARENT's own worktree, serialised per parent
    // branch (lib/locks.js), and is refused outright when the parent is master/main, when the parent is a guess rather
    // than a recorded cut, or when the parent branch is the project's production branch (that is a worker's or a TO's
    // job, never a merge run from here).
    if (route === "/api/worktree/rollup" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const project = (registry.projects || []).find((p) => p.name === String(body.project || "").trim()) || null;
      if (!project) return sendJson(res, 404, { error: `unknown project: ${body.project || "(none)"}` });
      const row = store.rowsFor(project.name).find((r) => normPathKey(r.path) === normPathKey(body.path)) || null;
      if (!row) return sendJson(res, 404, { error: `no row for ${body.path || "(no path)"} in ${project.name}` });
      const rec = parents.get(project.name, row.branch) || null;
      const parentBranch = String(body.parent || rec?.parent || "").trim();
      // One gate, shared with lib/steward.js, so the chip and the steward cannot disagree about what may be written.
      // The parent named by the request must be the parent on record: a body cannot promote a row to a rollable one.
      if (parentBranch && rec && rec.parent && parentBranch !== rec.parent) {
        return sendJson(res, 409, { error: `refused: ${parentBranch} is not ${row.branch || "this branch"}'s recorded parent (${rec.parent})` });
      }
      const listing = await stewardWorktrees(project.path);
      const parentWorktree = parentWorktreeOf(listing.trees, parentBranch);
      const gate = rollGate({ parentBranch, parentSource: rec?.parentSource || "unknown", mainBranch: project.mainBranch, prodBranch: config.steward.prodBranch, parentWorktree });
      if (!gate.ok) return sendJson(res, 409, gate);
      if (body.confirm !== true) {
        return sendJson(res, 428, { error: `nothing was rolled: confirming starts a merge into ${parentBranch} in its own worktree`, parent: parentBranch, branch: row.branch, preview: true });
      }
      const out = await rollUp({
        repoDir: project.path,
        parentBranch,
        parentWorktree,
        childBranch: row.branch,
        mainBranch: project.mainBranch,
        prodBranch: config.steward.prodBranch,
        parentSource: rec?.parentSource || "unknown",
        dryRun: body.dryRun === true,
      });
      if (!out.ok) return sendJson(res, 409, out);
      log(`rollup: ${row.branch} → ${parentBranch} in ${project.name} (${out.method}${out.sha ? ` ${out.sha}` : ""})`);
      broadcast({ type: "snapshot", data: snapshot() });
      return sendJson(res, 200, out);
    }

    // ---- rebasing one child onto the newest commit of the branch it was cut from ----------------------------------
    // The UNMERGED chip's rebase outcome, and the ONE action in that chooser that is not an agent: `git rebase` is a
    // single deterministic command whose outcome git reports itself, so the panel runs it here — no run, no gateway,
    // no bill. It writes exactly one branch: the one checked out in this worktree. The parent, the base branch and the
    // remote are untouched, so this route never reaches the remote-write box. `lib/rebase.js` picks the target by
    // proof (the commits a replay would move must belong to this branch alone) and aborts a conflicted replay back to
    // the state it started from. `{dryRun: true}` answers with the plan and writes nothing.
    if (route === "/api/worktree/rebase" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const asked = String(body.path || "").trim();
      if (!asked) return sendJson(res, 400, { error: "path is required" });
      // Forward slashes, the spelling every row on the board already carries: `store.rowKey` is the raw string, so a
      // backslashed path here would name a DIFFERENT row — and `scanOne`'s "must stay deleted" guard would then
      // return the row it just read without storing it, leaving the board on the pre-rebase tip. The rename route
      // spells its path the same way, for the same reason.
      const worktree = path.resolve(asked).replace(/\\/g, "/");
      const info = await stat(worktree).catch(() => null);
      if (!info || !info.isDirectory()) return sendJson(res, 404, { error: `no such directory: ${worktree}` });
      // The same resolution every worktree route does: the row's project is the hint and git's worktree list is the
      // proof the hint is real. A tree can live anywhere, so a path outside the project root is not an error.
      let project = spawnFeature.projectForPath(worktree) || registry.projects.find((p) => normPathKey(p.path) === normPathKey(worktree));
      if (!project) {
        const hinted = registry.projects.find((p) => p.name === String(body.project || "").trim());
        if (hinted) {
          const listed = await worktreeList(hinted.path).catch(() => []);
          if (listed.some((w) => normPathKey(w.path) === normPathKey(worktree))) project = hinted;
        }
      }
      if (!project) return sendJson(res, 400, { error: `${worktree} is not inside a known project, and is not one of its worktrees` });
      const base = String(project.mainBranch || "");
      if (!base) return sendJson(res, 400, { error: `${project.name} has no base branch to measure the branch against` });
      const remote = project.remote || null;
      const baseRef = remote ? `${remote}/${base}` : base;
      const row = await scanWorktree(worktree, { remoteRef: baseRef, mainBranch: base }, "fast");
      if (row.error) return sendJson(res, 400, { error: row.error });
      const preview = { project: project.name, base, baseRef, remote, branch: row.branch, worktree: worktree.replace(/\\/g, "/") };
      if (row.branch === base) {
        return sendJson(res, 409, { error: `${path.basename(worktree)} is on ${base} itself — there is no branch of its own to replay`, ...preview });
      }
      const dirty = Number(row.dirty) || 0;
      const untracked = Number(row.untracked) || 0;
      if (dirty || untracked) {
        return sendJson(res, 409, {
          error: `the tree is not clean (${dirty} modified, ${untracked} untracked) — a rebase would either refuse to start or carry somebody's unfinished work through the replay, so commit or stash first`,
          ...preview,
        });
      }
      // The reader's lock is a "not this tree" that outlives the process, and a replay rewrites the branch it names.
      const lock = locks.check({ project: project.name, path: worktree, branch: row.branch });
      if (lock.locked) return sendJson(res, 409, { error: `nothing was rebased: ${lock.reason}`, lock, ...preview });
      if (row.ahead === 0) return sendJson(res, 409, { error: `${row.branch} has no commits of its own off ${baseRef} — a replay would have nothing to move`, ...preview });
      // One replay per branch at a time: a second would drive the same index while the first is half-applied.
      const out = await writerLocks
        .with(
          rebaseKey(project.path, row.branch),
          () => rebaseWorktree({ worktree, branch: row.branch, parent: row.parent || null, baseRef, mainBranch: base, dryRun: body.dryRun === true, log }),
          { holder: `rebase ${row.branch}`, waitMs: 60000 },
        )
        .catch((e) => ({ ok: false, refused: "busy", error: String((e && e.message) || e) }));
      if (!out.ok) return sendJson(res, 409, { ...out, ...preview });
      // A dry run wrote nothing, so there is nothing to re-read and no replay to log: its answer is the plan. Sending
      // it here also keeps a second read of the same tree out of flight for the real press to queue behind.
      if (body.dryRun === true) {
        return sendJson(res, 200, {
          ...out,
          ...preview,
          published: Boolean(ownCopyOf(row)),
          row: store.rowsFor(project.name).find((r) => normPathKey(r.path) === normPathKey(worktree)) || null,
        });
      }
      log(`rebase: ${row.branch} onto ${out.target} (${out.fromShort} -> ${out.toShort}, ${out.replayed} commit(s) replayed)`);
      // The board is a scan behind, and the whole point of the control is that the row shows the new tip: read this
      // one tree now (the same claim the next-read ring makes) instead of leaving a fresh replay looking un-rebased.
      // Waiting for the path to fall idle first is not politeness: `pool.run` DEDUPES per path, so a read issued while
      // a scan of this tree is still running would join that PRE-replay read and answer with the old tip. Any scan that
      // starts once the path is idle reads the replay, whoever asked for it, so the wait is bounded rather than a race.
      for (let waited = 0; waited < 30 && scheduler.pool.isBusy(worktree); waited += 1) {
        await new Promise((r) => setTimeout(r, 150));
      }
      {
        // The scheduler's own record of the project, not this route's: `ctxFor` reads the fetch/scan settings off it.
        const scanProject = scheduler.getProjects().find((p) => p.name === project.name) || project;
        scheduler.lastFast.set(`${project.name}::${worktree}`, Date.now());
        await scheduler.scanOne(scanProject, worktree, "full").catch(() => null);
      }
      broadcast({ type: "snapshot", data: snapshot() });
      // A branch with its own copy on the remote has just rewritten shas that copy still holds: the next push needs
      // `--force-with-lease`, and the page's banner says so rather than letting the Ahead / Behind column look wrong.
      return sendJson(res, 200, { ...out, ...preview, published: Boolean(ownCopyOf(row)), row: store.rowsFor(project.name).find((r) => normPathKey(r.path) === normPathKey(worktree)) || null });
    }

    // "Where should this go?" — the chip's third outcome, and the only thing it does: write the question down and
    // start nothing. It lands in the ledger the steward's plan reads, so the next plan lists it under "needs you".
    if (route === "/api/worktree/parent-question" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const project = (registry.projects || []).find((p) => p.name === String(body.project || "").trim()) || null;
      if (!project) return sendJson(res, 404, { error: `unknown project: ${body.project || "(none)"}` });
      const row = store.rowsFor(project.name).find((r) => normPathKey(r.path) === normPathKey(body.path)) || null;
      const question = questions.ask({
        project: project.name,
        path: body.path || row?.path || "",
        branch: body.branch || row?.branch || null,
        note: String(body.note || "").slice(0, 300),
        by: String(body.by || "the reader").slice(0, 80),
      });
      log(`steward: question recorded for ${question.branch || question.path} in ${project.name} — nothing was started`);
      return sendJson(res, 202, { ok: true, question, started: false });
    }

    // ---- the one way a tree's pipeline changes ---------------------------------------------------------------
    // POST {path, id}: which definition a tree is on. The route re-reads the tree's own record from disk (a chip's
    // menu is a claim, not a fact), refuses an id the catalogue does not hold, and applies the ladder strictly
    // upwards: a downgrade or a sideways swap is a 409 with the sentence and nothing is written. The record's schema
    // is §3's — `{id, stage, since, history[]}` — and the history entry records the transition, not just the position.
    //
    // NOT here yet: starting the new pipeline's first stage as a turn (§4.1). It needs the prompt renderer and the
    // exit-check evaluator, which are later tasks — and because the ladder only climbs, writing the rung without
    // starting the run would spend a tree's one upward move on a stage that never began. So until the turn start
    // exists the route refuses the switch (501) BEFORE the record is written, and the ladder stays honest.
    if (route === "/api/worktree/pipeline" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const tree = String(body.path || "").trim();
      if (!tree) return sendJson(res, 400, { error: "a worktree path is required (the row's own path)" });
      const id = String(body.id || "").trim();
      if (!id) return sendJson(res, 400, { error: "a pipeline id is required" });
      const doc = pipelines.doc({ fresh: true });
      const def = doc.pipelines[id] || null;
      if (!def) {
        const dropped = doc.dropped.find((d) => d.id === id) || null;
        return sendJson(res, 404, {
          error: dropped
            ? `pipeline "${id}" is in the catalogue but was dropped: ${dropped.why}`
            : `no pipeline "${id}" in the catalogue (${Object.keys(doc.pipelines).join(", ") || "none loaded"})`,
          dropped,
          refused: doc.refused || null,
        });
      }
      // `from` is the record ON DISK. A tree cut before pipelines has none, and it is LOCAL — that is what the panel
      // did with it — so it is read as local rather than refused. A record naming a definition the catalogue no
      // longer holds cannot be judged on the ladder at all, and guessing its rung is exactly the silent downgrade
      // this rule exists to prevent, so it is refused.
      const current = pipelineRecords.get(tree, { fresh: true }) || presumedPipeline();
      let fromKind = "";
      if (current.id) {
        const fromDef = doc.pipelines[current.id] || null;
        if (fromDef) fromKind = String(fromDef.kind || "");
        else if (current.id === "local") fromKind = "local";
      } else {
        fromKind = "local";
      }
      if (!fromKind) {
        return sendJson(res, 409, {
          error: `this tree's record names "${current.id}", which is not in the catalogue — the change cannot be judged on the ladder, and guessing its kind would be the silent downgrade this rule exists to prevent`,
          code: "unknown-current",
          pipeline: current,
        });
      }
      const toKind = String(def.kind || "");
      const at = new Date().toISOString();
      const stage = Array.isArray(def.stages) && def.stages.length ? String(def.stages[0].id || "") || null : null;
      const out = changePipeline(current, { fromKind, toKind, id, stage, by: "reader", why: `the reader chose ${id}`, at });
      if (!out.ok) {
        log(`pipeline: refused ${tree} ${current.id || "(none)"} -> ${id}: ${out.error}`);
        return sendJson(res, 409, { error: out.error, code: out.code, from: current.id || null, fromKind, to: id, toKind, pipeline: current });
      }
      // The switch cannot start the work it would record, so it is refused and NOTHING is written: a rung on the
      // one-way ladder with no run behind it is a tree that is permanently a turnover, clocking a stage that never
      // began, and a second POST cannot undo it. 501 rather than 409: the request is valid and the climb is allowed
      // by the ladder — the missing piece is the turn start this route does not yet have. 500 is the same refusal for
      // a book that cannot be written: either answer means the record did not move, so neither is a 200 with a record.
      const answer = storeSwitch(pipelineRecords, tree, out.pipeline, { turnStart: PIPELINE_SWITCH_STARTS_TURN });
      if (answer.status !== 200) {
        const error =
          answer.code === "no-turn-start"
            ? "the pipeline switch is not yet wired to a turn start, so nothing was recorded and this tree is unchanged — the record will only move when the switch can start the pipeline's first stage"
            : `the switch to "${id}" was not stored: the pipeline record for this tree could not be written, so nothing changed and the tree is still ${current.id || "local"}`;
        log(`pipeline: ${answer.status} for ${tree} ${current.id || "(none)"} -> ${id}: ${answer.code} — nothing was recorded`);
        return sendJson(res, answer.status, {
          error,
          code: answer.code,
          path: tree,
          from: current.id || null,
          fromKind,
          id,
          toKind,
          stage,
          pipeline: current,
        });
      }
      // The durable file first, then every live card in that tree: a card can never disagree with the record.
      const touched = jobs.applyPipeline(tree, answer.pipeline);
      log(`pipeline: ${tree} ${current.id || "(none)"} ${fromKind} -> ${id} ${toKind} (stage ${stage || "?"}) — ${touched.cards.length} card(s) updated`);
      return sendJson(res, 200, {
        ok: true,
        path: tree,
        from: current.id || null,
        fromKind,
        id,
        toKind,
        stage,
        pipeline: answer.pipeline,
        cards: touched.cards,
      });
    }

    if (route === "/api/parents" && req.method === "GET") {
      const name = String(url.searchParams.get("project") || "").trim();
      return sendJson(res, 200, { project: name || null, parents: parents.state(name || null) });
    }

    if (route === "/api/stats") {
      return sendJson(res, 200, {
        scheduler: scheduler.stats,
        pool: { size: pool.size, inFlight: pool.inFlight, queued: pool.queued, completed: pool.completed },
        store: store.stats,
        jobs: { total: jobs.jobs.size, running: jobs.list().filter((j) => j.status === "running").length },
        clients: clients.size,
      });
    }

    if (route === "/api/jobs" && req.method === "GET") {
      await jobs.probe();
      return sendJson(res, 200, { jobs: jobs.list(), transport: jobs.transportInfo(), defaultCwd: config.defaultCwd });
    }

    // Every deliverable this panel has recorded, newest first: `{version, cap, kept, nextSeq, seenSeq, seenAt,
    // unseenCount, at, entries}`. READ-ONLY and NOT token-gated — the same convention as GET /api/jobs above. A read
    // changes nothing, and a board opened on another machine has to be able to paint the list; the two writes beside
    // it (the seen watermark and the open) are the ones that carry a token. `seenSeq`/`unseenCount` come out of the
    // store's own record — the badge counts rows above the watermark and a GET never walks the list to do it.
    if (route === "/api/deliverables" && req.method === "GET") {
      const list = deliverables.list();
      // One field added per row, and the only one the Open control reads: the URL a tab can open, or null. It is
      // decided here because this process is the one that knows what it serves and what a repo is.
      return sendJson(res, 200, { ...list, entries: list.entries.map((e) => ({ ...e, href: deliverableHref(e) })) });
    }

    // ---- approvals: the human side of the Hermes approval-transport contract ---------------
    // The plugin (~/.hermes/plugins/worktree-panel) presents a redacted request here and polls
    // GET /api/approvals/<id>; the panel only records the human's choice. Policy, timeout and
    // fail-closed enforcement stay in Hermes.
    if (route === "/api/approvals" && req.method === "GET") {
      return sendJson(res, 200, { pending: approvals.list() });
    }

    if (route === "/api/approvals" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      try {
        const request = approvals.present(body || {});
        log(`approval requested (${request.id}): ${request.command.slice(0, 90)}`);
        return sendJson(res, 202, { ok: true, id: request.id, allowed: request.allowed, timeoutSeconds: request.timeoutSeconds });
      } catch (e) {
        return sendJson(res, 400, { error: String((e && e.message) || e) });
      }
    }

    if (route === "/api/approvals/answer" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const r = approvals.answer(body.id, body.choice, body.by || "ui");
      return sendJson(res, r.ok ? 200 : 409, r);
    }

    if (route.startsWith("/api/approvals/") && req.method === "GET") {
      const id = decodeURIComponent(route.slice("/api/approvals/".length));
      return sendJson(res, 200, approvals.status(id));
    }

    // ---- the TODO list of one worktree -------------------------------------------------------------------------
    // Read on demand (the row carries its own copy in /api/state; this is for the expanded strip's journal and for a
    // check that wants the whole list), and written by the reader's own buttons. Every write is stamped
    // `by: "reader"` and every refusal comes back WITH its reason — the page says it rather than looking like a
    // press that did nothing.
    if (route === "/api/todos" && req.method === "GET") {
      const key = todos.keyFor({ project: url.searchParams.get("project"), path: url.searchParams.get("path") || url.searchParams.get("tree") });
      if (!key) return sendJson(res, 400, { error: "a worktree is required: pass project and path (the row's own key)" });
      const rec = todos.list(key);
      return sendJson(res, 200, { key, list: rec ? { project: rec.project, path: rec.path, items: rec.items, proposal: rec.proposal || [], journal: rec.journal } : null, summary: todos.summary(key) });
    }

    if (route === "/api/todos" && req.method === "POST") {
      if (!authorised(req)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const op = String(body?.op || "").toLowerCase();
      const args = {
        project: body?.project || null,
        path: body?.path || null,
        id: body?.id === undefined || body?.id === null || body?.id === "" ? null : Number(body.id),
        text: body?.text ?? "",
        note: body?.note ?? null,
        files: Array.isArray(body?.files) ? body.files : null,
        by: "reader",
        owner: null,
        from: "reader",
      };
      let r;
      if (op === "add") r = todos.write({ ...args, op: "add" });
      else if (op === "edit") r = todos.write({ ...args, op: "edit" });
      else if (op === "note") r = todos.write({ ...args, op: "note" });
      else if (op === "files") r = todos.write({ ...args, op: "files" });
      else if (["done", "doing", "drop", "dropped", "reopen", "todo"].includes(op)) r = todos.setStatus({ ...args, op });
      else r = { ok: false, error: `unknown todo op “${op || "(none)"}” — one of add, edit, note, done, doing, drop, reopen` };
      if (r.ok) broadcastTodos();
      return sendJson(res, r.ok ? 200 : 400, {
        ok: Boolean(r.ok),
        error: r.error || null,
        message: r.ok ? todoSay(op, r.item) : null,
        key: r.key || null,
        summary: r.key ? todos.summary(r.key) : null,
        journal: r.list ? r.list.journal.slice(-6) : [],
      });
    }

    // ---- who may put a branch on a remote ------------------------------------------------------------
    // The page's own view of it: what is parked, what the setting is, and which trees carry the guard.
    if (route === "/api/remote-write/state" && req.method === "GET") {
      return sendJson(res, 200, {
        ...remoteWrites.state(),
        policies: POLICIES,
        defaultPolicy: DEFAULT_POLICY,
        configPath: CONFIG_PATH,
        guards: guardReport(),
      });
    }

    // WHAT WOULD A PUSH MEET? The two controls resolved for ONE checkout, in the shape an assistant can read without
    // knowing config.json exists. `?path=` names the tree (a subdirectory of a project resolves to the project that
    // owns it, the same longest-prefix rule the reply brief uses), `?project=` names a row; `?branch=` names the ref
    // and `?new=1` says it does not exist on the remote yet. Without a branch the answer reports both controls, and
    // `ask` is true when EITHER of them would park — the safe reading for a caller that has not said which it means.
    if (route === "/api/remote-write/allow-push" && req.method === "GET") {
      const asked = String(url.searchParams.get("path") || url.searchParams.get("worktree") || "").trim();
      const named = String(url.searchParams.get("project") || "").trim();
      const project = (named ? (registry.projects || []).find((p) => p.name === named) || null : null) || (asked ? projectOfTree(asked) : null);
      const branch = String(url.searchParams.get("branch") || "").trim();
      const isNew = url.searchParams.get("new") === "1" || url.searchParams.get("new") === "true";
      const answer = resolvePushPermissions(project || {}, config);
      const answered = branch ? permissionForPush(answer, { branch, isNew }) : pushModeFor(answer);
      const remote = String(project?.remote || "");
      const where = project?.name ? `${project.name}${asked ? ` (${cleanPath(asked)})` : ""}` : asked ? cleanPath(asked) : "";
      return sendJson(res, 200, {
        ok: true,
        path: cleanPath(asked || project?.path || "") || null,
        project: project?.name || null,
        remote: remote || null,
        repo: answer.repo,
        repoLabel: answer.repoLabel,
        forced: answer.forced,
        newBranches: answer.newBranches,
        existingBranches: answer.existingBranches,
        newSource: answer.newSource,
        existingSource: answer.existingSource,
        branch: branch || null,
        isNew: Boolean(branch) && isNew,
        // What the assistant may DO, not only what the settings say: allow = go ahead, ask = clarify first,
        // refuse = do not push at all and do not offer the box.
        permission: answered,
        ask: answered === "ask",
        denied: answered === "refuse",
        say:
          answered === "refuse"
            ? `A push from ${where || "that checkout"} is refused outright by its push control (never) — nothing may be pushed there, and no permission box is offered.`
            : answered === "allow"
              ? `A push from ${where || "that checkout"} to ${remote || "its remote"} goes through without a question${branch ? ` for ${branch}` : ""}. It is a permission, not an instruction — push only when the work is meant to land.`
              : `A push from ${where || "that checkout"} parks on the reader's permission box. Ask the reader with a clarify, or report the branch instead.`,
      });
    }

    // THE GUARD REPORTING A WRITE IT ALREADY ALLOWED. When the guard's own policy file says `allow` (or the tree is
    // marked landing) the hook returns before /request, so this is the only way the panel hears about a push nobody
    // was asked about. Best effort on the hook's side — 2 s and a swallowed exit status — because a panel that is
    // down must never hold up a push its policy already permits. Nothing is drawn here: the record is confirmed
    // against the remote and only then broadcast as a review card.
    if (route === "/api/remote-write/report" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const worktree = String(body.worktree || "");
      const branch = String(body.branch || "");
      const found = spawnFeature.projectForPath(worktree);
      const remote = String(body.remote || "") || found?.remote || "";
      const rec = remoteWrites.review({
        kind: "push",
        worktree,
        project: found?.name || "",
        branch,
        remote,
        refs: String(body.refs || ""),
        why: String(body.why || "the policy in this tree allows remote writes without asking"),
        command: `git push ${remote || "<remote>"} ${branch || "<branch>"}   — from ${cleanPath(worktree)} (allowed without asking)`,
      });
      return sendJson(res, 200, { ok: true, id: rec.id });
    }

    // THE GUARD ASKING. A worktree whose push control says always-ask (or name-gate and the name does not pass)
    // reaches here (lib/push-guard.js writes the hook that calls it) and this is what draws the permission box.
    // Three answers, and the hook reads them off the body:
    //   allowed:true          — go ahead (the control allows it, the tree was started to land, or a grant stands)
    //   refused:true          — no, and no question to ask (the control is never)
    //   id + deadline         — a question is parked in the dock; the hook polls the status route for the answer
    if (route === "/api/remote-write/request" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const worktree = String(body.worktree || "");
      // The project that owns this tree decides, from ITS two controls: a new branch and an existing one can carry
      // different answers, and a push of several refs is decided by the strictest of them.
      const found = spawnFeature.projectForPath(worktree);
      const policy = policyForProject(found, config.remoteBranchPolicy);
      const push = resolvePushPermissions(found || {}, config);
      const listed = branchesInPushRefs(body.refs);
      const pushed = listed.length
        ? listed
        : [{ branch: String(body.branch || ""), isNew: body.isNew === true }];
      const mode = strictestPermission(pushed.map((b) => permissionForPush(push, b)));
      const decision = remoteWrites.decision(worktree, policy, { pushMode: mode });
      if (decision.allowed) {
        // A one-shot grant is spent by the write it was given for.
        if (decision.consume) remoteWrites.spend(worktree);
        // A write NOBODY WAS ASKED ABOUT is still a write somebody made. It comes back as a review card once the
        // remote confirms it (remoteWrites.setVerifier), with Keep and one named Unwind: the reader's stated
        // preference is to see what a standing permission did, not only what it was asked about.
        remoteWrites.review({
          kind: "push",
          worktree,
          project: found?.name || "",
          branch: String(body.branch || ""),
          remote: String(body.remote || "") || found?.remote || "",
          refs: String(body.refs || ""),
          why: decision.why,
          command: `git push ${String(body.remote || "origin")} ${String(body.branch || "<branch>")}   — from ${cleanPath(worktree)}`,
        });
        return sendJson(res, 200, { allowed: true, why: decision.why, permission: mode, newBranches: push.newBranches, existingBranches: push.existingBranches, repo: push.repo, forced: push.forced, policy });
      }
      if (!decision.ask) {
        log(`remote write refused without asking: ${cleanPath(worktree)} (${decision.why}, ${push.repo} new ${push.newBranches} / existing ${push.existingBranches})`);
        return sendJson(res, 200, { allowed: false, refused: true, why: decision.why, permission: mode, newBranches: push.newBranches, existingBranches: push.existingBranches, repo: push.repo, forced: push.forced, policy });
      }
      const remote = String(body.remote || "") || found?.remote || "";
      const branch = String(body.branch || "");
      const req0 = remoteWrites.request({
        kind: "push",
        worktree,
        project: found?.name || "",
        branch,
        remote,
        refs: String(body.refs || ""),
        title: `${path.basename(worktree || "") || worktree} wants to push`,
        command: `git push ${remote || "<remote>"} ${branch || "<branch>"}   — from ${cleanPath(worktree)}${body.remoteUrl ? ` (${String(body.remoteUrl).slice(0, 120)})` : ""}`,
        description: "a worker is trying to put a branch on the remote, and this project's push control says to ask. Nothing is pushed until you answer, and Deny leaves the remote untouched.",
      });
      return sendJson(res, 200, {
        allowed: false,
        id: req0.id,
        deadline: req0.deadline,
        timeoutSeconds: req0.timeoutSeconds,
        policy,
        why: `${policy === "local-only" ? "local only" : policy} — this push is parked on your permission box`,
      });
    }

    // What the parked hook long-polls. A request nobody answered reads as `deny` once its window closes.
    if (route === "/api/remote-write/status" && req.method === "GET") {
      const id = url.searchParams.get("id") || "";
      const st = remoteWrites.status(id);
      // The one-shot grant is handed to the hook that asked for it: it is spent as soon as the hook has been told,
      // so a second push cannot ride the same answer.
      if (st.status === "answered" && st.choice === "once") remoteWrites.spend(remoteWrites.treeOfDecision(id));
      return sendJson(res, 200, st);
    }

    // The reader's answer, from the panel's own permission box. Same four choices, same semantics as an approval:
    // once / this session / always (which IS the setting) / deny. Anything the question was parked on is resumed
    // here — the panel's own merge flow starts only after a yes.
    if (route === "/api/remote-write/answer" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const id = String(body.id || "");
      // Read the resumable action BEFORE the answer clears the request, and never twice: a second press finds
      // nothing to run.
      const resume = remoteWrites.takeResume(id);
      const out = remoteWrites.answer(id, body.choice, { by: body.by || "reader" });
      if (!out.ok) return sendJson(res, 409, out);
      let resumed = null;
      if (resume && out.choice !== "deny") {
        try {
          resumed = await resume();
          log(`remote-write ${id}: the granted write was resumed (${resumed?.status || "ok"})`);
        } catch (e) {
          resumed = { status: 500, error: String((e && e.message) || e) };
          log(`remote-write ${id}: resuming the granted write failed — ${resumed.error}`);
        }
      }
      return sendJson(res, 200, { ...out, resumed, state: remoteWrites.state() });
    }

    // KEEP an auto-allowed write: the record goes, the write stands. Nothing is run.
    if (route === "/api/remote-write/review" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const out = remoteWrites.keepReview(String(body.id || ""));
      return sendJson(res, out.ok ? 200 : 404, out);
    }

    // UNWIND an auto-allowed write, and the only place an inverse is ever run. The page sends the record's ID and
    // nothing else: the command is the record's own (`unwindFor` built it when the remote confirmed the write), so a
    // client cannot name a command here. A remote branch delete is its own confirmation — the button the reader
    // pressed spelled it out — and nothing else is runnable: a write with no safe inverse only ever offers a drafted
    // message, which the reader sends (or does not). Nothing auto-executes.
    if (route === "/api/remote-write/unwind" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const id = String(body.id || "");
      const rec = remoteWrites.reviewFor(id);
      if (!rec) return sendJson(res, 404, { error: "unknown review — nothing to unwind" });
      const plan = rec.unwind || remoteWrites.unwindFor(rec);
      if (!plan || plan.type !== "delete-branch") {
        return sendJson(res, 409, { error: "that write has no safe inverse — the card offers a message to the agent instead", unwind: plan });
      }
      const worktree = String(rec.worktree || "");
      const remote = String(rec.remote || "");
      const branch = String(rec.branch || "").replace(/^refs\/heads\//, "");
      const tree = await stat(worktree).catch(() => null);
      if (!tree || !tree.isDirectory()) {
        return sendJson(res, 409, { error: `cannot unwind: ${worktree || "(no tree)"} is not a directory any more` });
      }
      const remotes = await gitIn(worktree, ["remote"], 10000);
      const names = remotes.ok ? remotes.out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
      if (!names.includes(remote)) {
        return sendJson(res, 409, { error: `cannot unwind: ${remote || "(no remote)"} is not a remote of that tree (${names.join(", ") || "none"})` });
      }
      // The record's own `unwindFor` already refused a protected or unshaped branch; this is the second fence, on the
      // value that is about to be passed to git, so a hand-edited record cannot turn the delete into something else.
      if (!branch.includes("/") || /^(main|master|trunk|develop|development|release|head|next)$/i.test(branch)) {
        return sendJson(res, 409, { error: `refusing to delete ${remote}/${branch}: that is not a feature branch` });
      }
      try {
        // WTGUI_PUSH_GRANT is the guard's own documented bypass, used deliberately: the reader pressed a button that
        // named this delete, and a permission box asking the panel to allow the panel would be a loop, not a check.
        // The delete is the ONLY command this route runs, from the record's branch and remote and nothing in the body.
        const run = await execP("git", ["-C", worktree, "push", remote, "--delete", branch], {
          timeout: 60_000,
          windowsHide: true,
          env: { ...process.env, WTGUI_PUSH_GRANT: "1", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "echo" },
        });
        const text = `${run.stdout || ""}\n${run.stderr || ""}`.split(String.fromCharCode(10)).map((s) => s.trim()).filter(Boolean).join(" · ");
        const out = remoteWrites.markUnwound(id, { did: plan.label });
        log(`remote-write review ${id}: unwound — ${plan.command}: ${text || "no output"}`);
        return sendJson(res, 200, { ok: true, review: out ? remoteWrites.publicReview(out) : null, did: plan.label });
      } catch (e) {
        const text = `${e.stdout || ""}\n${e.stderr || ""}`.split(String.fromCharCode(10)).map((s) => s.trim()).filter(Boolean).join(" · ");
        // A branch that is already gone is the outcome the reader asked for, not a failure to dress up as one.
        if (/remote ref does not exist|does not exist|unable to delete/i.test(text)) {
          const out = remoteWrites.markUnwound(id, { did: plan.label, alreadyGone: true });
          log(`remote-write review ${id}: ${remote}/${branch} was already gone — nothing to delete`);
          return sendJson(res, 200, { ok: true, alreadyGone: true, review: out ? remoteWrites.publicReview(out) : null, did: plan.label });
        }
        log(`remote-write review ${id}: the delete of ${remote}/${branch} failed — ${text || String((e && e.message) || e)}`);
        return sendJson(res, 502, { error: `the delete failed: ${text || String((e && e.message) || e)}` });
      }
    }

    // ONE PROJECT'S TWO CONTROLS. The card's selects and the Settings → Repo tab both write here, one kind at a
    // time. The value must be one of the four — anything else is a 400 rather than a guess — and a project under a
    // repo force-override is a 409 naming the repository, because that select is rendered disabled and a hand-written
    // request must not slip past the same rule the page shows.
    if (route === "/api/settings/push-project" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const name = String(body.project || "").trim();
      const kind = pushKindOf(body.kind);
      if (!kind) return sendJson(res, 400, { error: "kind must be new or existing", settings: settingsOut() });
      if (!PUSH_CHOICES.includes(String(body.value || "").trim().toLowerCase())) {
        return sendJson(res, 400, { error: `value must be one of: ${PUSH_CHOICES.join(", ")}`, settings: settingsOut() });
      }
      const out = await setProjectPushSetting(name, { [kind]: body.value }, { by: "the project card" });
      if (out.error) return sendJson(res, out.status || 500, { error: out.error, settings: settingsOut() });
      return sendJson(res, 200, { ok: true, project: name, resolved: out.resolved, settings: settingsOut(), note: `saved — ${name}: ${kind === "newBranches" ? "new" : "existing"} branches ${out.resolved[kind]}` });
    }

    // ONE REMOTE REPOSITORY'S DEFAULTS (and its force-override). A repo section edits BOTH controls and the toggle
    // through this route, because they are one record in config.json and two writers would be two chances to lose a
    // key. The answer carries the settings again so every open tab repaints from the server's copy.
    if (route === "/api/settings/push-repo" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const repo = String(body.repo || "").trim();
      const patch = {};
      if (body.kind !== undefined || body.value !== undefined) {
        const kind = pushKindOf(body.kind);
        if (!kind) return sendJson(res, 400, { error: "kind must be new or existing", settings: settingsOut() });
        if (!PUSH_CHOICES.includes(String(body.value || "").trim().toLowerCase())) {
          return sendJson(res, 400, { error: `value must be one of: ${PUSH_CHOICES.join(", ")}`, settings: settingsOut() });
        }
        patch[kind] = body.value;
      }
      if (body.force !== undefined) {
        if (typeof body.force !== "boolean") return sendJson(res, 400, { error: "force must be true or false", settings: settingsOut() });
        patch.force = body.force;
      }
      if (!Object.keys(patch).length) return sendJson(res, 400, { error: "nothing to save: send kind+value, force, or both", settings: settingsOut() });
      const out = await setRepoPushSetting(repo, patch, { by: "the Settings → Repo tab" });
      if (out.error) return sendJson(res, out.status || 500, { error: out.error, settings: settingsOut() });
      return sendJson(res, 200, { ok: true, repo, record: out.record, settings: settingsOut(), note: `${repo}: ${out.record.force ? "force-override ON — this repository's values win for every project in it" : "each project's own values win"}` });
    }

    // Put the guard in (or take it out of) the worktrees of a project, or in every local-only tree the board
    // knows. The automatic path is the panel's own worktree creation; this is the deliberate one, for trees that
    // were cut before the guard existed.
    if (route === "/api/remote-write/guard" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const action = String(body.action || "install").toLowerCase();
      const one = String(body.path || "").trim();
      if (action === "remove") {
        if (!one) return sendJson(res, 400, { error: "path is required to remove the guard" });
        const out = await uninstallGuard({ worktree: path.resolve(one), log });
        delete guardRecord.trees[normTree(one)];
        writeGuardRecord();
        return sendJson(res, out.ok ? 200 : 500, { ...out, guards: guardReport() });
      }
      const targets = [];
      if (one) {
        targets.push({ tree: path.resolve(one), projectPath: null });
      } else if (String(body.project || "").trim()) {
        const project = registry.projects.find((p) => p.name === String(body.project).trim());
        if (!project) return sendJson(res, 404, { error: `unknown project: ${body.project}` });
        for (const row of scheduler.store.rowsFor(project.name)) targets.push({ tree: row.path, projectPath: project.path, project: project.name, branch: row.branch });
      } else {
        // Every LOCAL-ONLY tree the board holds: a branch that exists on the remote is not one of these, and the
        // project's own checkout is never touched (the reader pushes there himself).
        for (const project of registry.projects) {
          for (const row of scheduler.store.rowsFor(project.name)) {
            if (normPathKey(row.path) === normPathKey(project.path)) continue;
            if (row.remoteBranch === "exists") continue;
            targets.push({ tree: row.path, projectPath: project.path, project: project.name, branch: row.branch });
          }
        }
      }
      const done = [];
      for (const t of targets) {
        if (!t.projectPath) {
          const proj = spawnFeature.projectForPath(t.tree);
          t.projectPath = proj?.path || t.tree;
          t.project = proj?.name || null;
        }
        // Idempotent, and never a reason to fail the request: one tree that cannot take a hooks path (a directory
        // held open, a git dir that is not there) is reported and the rest carry on.
        const out = await installGuardFor({ projectPath: t.projectPath, worktree: t.tree, branch: t.branch, project: t.project }).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
        done.push({ tree: cleanPath(t.tree), ok: Boolean(out.ok), error: out.error || null, dir: out.dir || null, shims: out.shims || [] });
      }
      log(`push guard: install asked for ${done.length} worktree(s), ${done.filter((d) => d.ok).length} ok`);
      return sendJson(res, 200, { ok: true, installed: done.filter((d) => d.ok).length, failed: done.filter((d) => !d.ok).length, trees: done, guards: guardReport() });
    }
    // Preview the exact request that would be sent — the confirm affordance.
    if (route === "/api/agents/preview" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      return sendJson(res, 200, await spawnFeature.previewPayload(body));
    }

    if (route === "/api/agents" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      // Which project, and which directory: the directory is the ground truth, so a stale project
      // picker is corrected here, before anything downstream reads it.
      const aimed = spawnFeature.targetForSpawn(body);
      if (!aimed.ok) return sendJson(res, 400, { error: aimed.error });
      if (aimed.project !== undefined) body.project = aimed.project;
      if (body.dryRun) return sendJson(res, 200, spawnFeature.dryRunPayload(body, aimed.target));
      // Refuse before promising a job: a stopped gateway or a missing key is the answer to "why did
      // nothing happen", not a card that says "starting" forever.
      const linked = await spawnFeature.linkSpawn(body, aimed.target, aimed.cwdProject);
      if (!linked.ok) return sendJson(res, linked.status, linked.payload);
      const job = await jobs.create({ ...body, ...linked.fields });      return sendJson(res, 202, { job });
    }

    // Continue a conversation: same named thread, no new worktree, run where the agent is.
    // A repo with no commits cannot host a worktree (there is no HEAD to branch from), and the spawn
    // refuses with that reason. This is the one-line fix that reason asks for: an EMPTY commit, so no
    // file is invented for the repo, and never a push — the commit stays local.
    if (route === "/api/repo/first-commit" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const target = path.resolve(String(body.path || "").trim());
      const info = await stat(target).catch(() => null);
      if (!info || !info.isDirectory()) return sendJson(res, 404, { error: `no such directory: ${target}` });
      const repoCheck = await gitIn(target, ["rev-parse", "--git-dir"], 15000);
      if (!repoCheck.ok) return sendJson(res, 400, { error: `${target} is not a git repository` });
      const head = await gitIn(target, ["rev-parse", "--verify", "--quiet", "HEAD"], 15000);
      if (head.ok) {
        const sha = await gitIn(target, ["rev-parse", "--short", "HEAD"], 10000);
        return sendJson(res, 409, { error: `${target} already has commits (${String(sha.out || "").trim()})`, alreadyCommitted: true });
      }
      const message = String(body.message || "Initial commit").slice(0, 200);
      const args = ["commit", "--allow-empty", "-m", message];
      let made = await gitIn(target, args, 30000);
      if (!made.ok && /tell me who you are|unable to auto-detect email|empty ident|Please tell me who/i.test(String(made.err || made.out || ""))) {
        // No identity configured on this machine: a local bot identity keeps the commit local and
        // attributable instead of failing on a prompt no one can answer.
        made = await gitIn(target, ["-c", "user.name=Hermes Panel", "-c", "user.email=panel@localhost", ...args], 30000);
      }
      if (!made.ok) return sendJson(res, 400, { error: String(made.err || made.out || "git commit failed").slice(0, 400) });
      const sha = await gitIn(target, ["rev-parse", "--short", "HEAD"], 10000);
      log(`first commit made in ${target} (${String(sha.out || "").trim()}) — local only, nothing pushed`);
      // The registry still has this repo down as empty, and a full rediscovery takes a sweep. The reader
      // is looking at a disabled spawn button and the very warning this fixed, so flip the one fact that
      // changed right here; the background refresh fills in the rest (head, branch) when it lands.
      const proj = registry.projects.find((x) => normPathKey(x.path) === normPathKey(target));
      if (proj) {
        proj.empty = false;
        registry.saveCache();
      }
      void registry.refresh();
      return sendJson(res, 201, { ok: true, path: target, sha: String(sha.out || "").trim(), message });
    }

    // A pasted or dropped document is stored on disk and its ABSOLUTE path goes into the prompt. The
    // gateway's runs API has no attachment field, but the agent has file tools — and an absolute path
    // is independent of the run's cwd, which this gateway does not honour anyway.
    if (route === "/api/attachments" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const LIMIT = 25 * 1024 * 1024;
      let bytes;
      try {
        bytes = await readRawBody(req, LIMIT);
      } catch (e) {
        return sendJson(res, e.tooLarge ? 413 : 400, { error: String(e.message || e) });
      }
      if (!bytes || !bytes.length) return sendJson(res, 400, { error: "empty attachment" });
      let name = "";
      try {
        name = decodeURIComponent(String(req.headers["x-filename"] || "").replace(/\+/g, " "));
      } catch {
        name = "";
      }
      name = path.basename(name || "pasted-file").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 120) || "pasted-file";
      // Under the data directory, never inside the checkout: an attachment is state the panel keeps, and its
      // absolute path is what goes into the run's prompt (lib/paths.js owns the default).
      const dir = config.attachmentsDir;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const target = path.join(dir, `${stamp}-${name}`);
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(target, bytes);
      } catch (e) {
        return sendJson(res, 500, { error: `could not store the attachment: ${String((e && e.message) || e)}` });
      }
      const type = String(req.headers["content-type"] || "application/octet-stream");
      log(`attachment stored (${bytes.length} bytes): ${target}`);
      return sendJson(res, 201, { path: target.replace(/\\/g, "/"), name, bytes: bytes.length, type });
    }

    if (route === "/api/threads/model" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const thread = String(body.thread || "").trim();
      if (!thread) return sendJson(res, 400, { error: "thread is required" });
      return sendJson(res, 200, jobs.setThreadModel(thread, body.model));
    }

    if (route === "/api/threads/context" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const thread = String(body.thread || "").trim();
      if (!thread) return sendJson(res, 400, { error: "thread is required" });
      return sendJson(res, 200, jobs.setThreadContext(thread, body.limit));
    }

    if (route === "/api/agents/reply" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const text = String(body.text || "").trim();
      if (!text) return sendJson(res, 400, { error: "reply text is required" });
      // The assistant's thread is answered through its own route: the scratchpad and the board digest ride
      // with the turn, and a plain reply here would start a turn that has neither. Every assistant's thread is
      // named here, not just the first one's — a second assistant answered through this route would run with no
      // preamble and no role at all.
      const assistantThread = assistant ? assistant.isAssistantThread(String(body.thread || "")) : String(body.thread || "") === ASSISTANT_THREAD;
      if (assistantThread) {
        return sendJson(res, 400, { error: "the assistant's thread is answered through /api/assistant/say" });
      }
      const origin = body.origin && typeof body.origin === "object" ? body.origin : null;
      // The turn itself is `startThreadReply`, shared with the stage timer's wake: a wake that went through a second
      // copy of this path would be a turn with a different tree, model or landing paragraph than a reader's reply.
      const out = await startThreadReply({
        thread: String(body.thread || ""),
        text,
        origin,
        model: body.model,
        budget: body.budget,
        maxTurns: body.maxTurns,
        yolo: body.yolo,
      });
      return sendJson(res, out.status, out.body);
    }

    if (route === "/api/jobs/cancel" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      return sendJson(res, 200, { ok: jobs.cancel(String(body.id || "")) });
    }

    // Steer a turn that is already running: the text is injected at the agent's next tool boundary,
    // so it can change course without ending the turn. 409 means it crossed the last boundary.
    if (route === "/api/jobs/steer" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const r = await jobs.steer(String(body.id || ""), body.text ?? body.input);
      // A steer lands inside the turn that is already running, so its documents belong to that turn's
      // card rather than to a new one.
      if (r.ok && Array.isArray(body.attachments) && body.attachments.length) jobs.addAttachments(String(body.id || ""), body.attachments);
      // One status per case, and the body's `reason` says which: 409 for a run that EXISTS and will not take a steer
      // right now (parked on an approval, or past its last tool boundary), 404 for a run the gateway no longer has
      // (the row has already been settled in this same answer), and 400 only for a request this route cannot act on
      // at all (no such card, no text, a card that is not running).
      const why = String(r.reason || "");
      const refused =
        why === STEER_PARKED ||
        why === STEER_PAST_BOUNDARY ||
        ["run_not_accepting_steer", "steer_not_accepted", "run_parked_on_approval"].includes(String(r.code || "")) ||
        Number(r.gatewayStatus) === 409;
      const status = r.ok ? 200 : why === STEER_GONE ? 404 : refused ? 409 : 400;
      return sendJson(res, status, r);
    }

    // The NOT-RUNNABLE chip's press: ask the gateway about ONE interrupted card's run and take the same decision
    // the boot reconcile takes (lib/jobs.js settleRestoredRun — one implementation, not two). The pointers are
    // looked up only here, because only this answer leaves the reader with nothing left to click: a run the gateway
    // has forgotten settles as interrupted, and the card has to name the tree the work is in and its PR.
    if (route === "/api/jobs/reattach" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const id = String(body?.id || "").trim();
      const r = await jobs.reattachNow(id, { pointers: gonePointers(id) });
      // 400 for a card this route cannot ask about at all (unknown, no run id, not interrupted), and for a gateway
      // that will not answer: the press is a question the panel understood and cannot settle, and the card keeps its
      // verdict. A decision always comes back as 200 with the card it left behind.
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    // The press on a finished card's COMPLETE chip: queue ONE ask for the board assistant and send nothing to the
    // agent. It goes through the assistant's own wake queue — the path an alert handed over uses — and never through
    // /api/assistant/say, which starts a turn at once and would talk over a run already in flight. The answer carries
    // what the queue decided, so the chip can say the ask landed or say why it did not; a card this route cannot ask
    // about (unknown, or no longer `done`) is a 400 with the reason.
    if (route === "/api/jobs/ask-complete" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      try {
        return sendJson(res, 200, assistant.askAboutComplete(String(body?.id || "").trim()));
      } catch (e) {
        return sendJson(res, 400, { error: String((e && e.message) || e), ok: false });
      }
    }

    // Answer a parked run's approval. The gateway validates the choice a second time, so a stale
    // card cannot widen what the host allows.
    if (route === "/api/jobs/approve" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const r = await jobs.approve(String(body.id || ""), body.choice, body.requestId ?? body.request_id);
      // 409 for "there is nothing to answer any more" — the gateway's own verdict on a prompt it has let go, and
      // the panel's on one whose window closed (`gone`), so a client can tell it from a malformed request.
      // `answer_in_flight` is a conflict too: the first press owns the answer, and this one changed nothing.
      return sendJson(res, r.ok ? 200 : r.gone || r.code === "approval_not_pending" || r.code === "answer_in_flight" ? 409 : 400, r);
    }

    // Answer a question the agent's `clarify` tool is blocked on. Same fence as an approval: the
    // gateway re-validates the prompt id against the run's pending controls and its execution
    // generation, so a stale card cannot answer a question that has already been settled.
    if (route === "/api/jobs/answer" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const r = await jobs.answerQuestion(String(body.id || ""), body.answer, body.requestId ?? body.request_id);
      // `answer_in_flight` is the single-flight fence refusing a second press for a question the first one is
      // already answering: a conflict, not a malformed body.
      return sendJson(res, r.ok ? 200 : r.code === "approval_not_pending" || r.code === "answer_in_flight" ? 409 : 400, r);
    }

    // ---- reviving a conversation the panel no longer has a card for -------------------------
    // A session outlives the panel's job store: the conversation lives in the gateway, so a reset
    // store (or a ✕) leaves the row still saying "Hermes session open here but idle" with nothing to
    // click. These turn that claim into a list, and put ONE back on the board when the reader picks
    // it — never automatically, because a tree accumulates every session ever run in it and the
    // board must not refill with all of them at once.
    if (route === "/api/thinking" && req.method === "GET") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const thread = String(url.searchParams.get("thread") || "").trim();
      if (!thread) return sendJson(res, 400, { error: "thread is required" });
      const from = Number(url.searchParams.get("from"));
      const to = Number(url.searchParams.get("to"));
      // `error` rides along so the card can tell "the store could not be read" from "this turn recorded nothing":
      // an empty `blocks` on a failed read would blank a live block that has text (see lib/thinking.js).
      const read = thinkingFor(thread, {
        dbPath: path.join(hermesHome(), "state.db"),
        from: Number.isFinite(from) ? from : null,
        to: Number.isFinite(to) && to > 0 ? to : null,
      });
      return sendJson(res, 200, { thread, blocks: read.blocks, error: read.error });
    }

    if (route === "/api/tool-results" && req.method === "GET") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const thread = String(url.searchParams.get("thread") || "").trim();
      const tool = String(url.searchParams.get("tool") || "").trim();
      const from = Number(url.searchParams.get("from")) || 0;
      const to = Number(url.searchParams.get("to")) || 0;
      // How many results the console is about to draw: a burst of six calls needs six, not a default of eight
      // that silently stops halfway through a longer run.
      const limit = Math.max(1, Math.min(60, Number(url.searchParams.get("n")) || 20));
      // One row, exactly as stored, for the console's fold: `row` picks which of the turn's results (the order the
      // console paired them in) and `full=1` lifts the store reader's own 6,000-character display cap. Without
      // them this is the array the burst pairing reads; with them it is the whole text behind one folded result.
      const rowParam = url.searchParams.get("row");
      const index = rowParam === null ? null : Math.max(0, Number(rowParam) || 0);
      const full = url.searchParams.get("full") === "1";
      if (!thread || !tool) return sendJson(res, 400, { error: "thread and tool are required" });
      const { toolResults } = await import("./lib/tool-results.js");
      // `full=1` reads the row exactly as it was stored (maxChars 0 = no cap); without it the store reader's own
      // 6,000-character display cap applies to every row of the array.
      const results = toolResults({
        dbPath: path.join(hermesHome(), "state.db"), sessionId: thread, tool, from, to, limit, index,
        ...(full ? { maxChars: 0 } : {}),
      });
      return sendJson(res, 200, { thread, tool, results });
    }

    if (route === "/api/subagents/collect" && req.method === "GET") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const thread = String(url.searchParams.get("thread") || "").trim();
      if (!thread) return sendJson(res, 400, { error: "thread is required" });
      const from = Number(url.searchParams.get("from"));
      const to = Number(url.searchParams.get("to"));
      const out = collectPrompt(thread, {
        dbPath: path.join(hermesHome(), "state.db"),
        from: Number.isFinite(from) ? from : 0,
        to: Number.isFinite(to) ? to : 0,
      });
      if (!out) return sendJson(res, 404, { error: "could not read that session's subagents" });
      return sendJson(res, 200, out);
    }

    if (route === "/api/subagents/console" && req.method === "GET") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const session = String(url.searchParams.get("session") || "").trim();
      if (!session) return sendJson(res, 400, { error: "session is required" });
      const out = childTranscript(session, { dbPath: path.join(hermesHome(), "state.db") });
      if (!out) return sendJson(res, 404, { error: "no such session" });
      return sendJson(res, 200, out);
    }

    // The calls behind a "+ N commands" batch. The run stream only carries the gateway's summary of a parallel
    // batch; each call and its arguments are in the session transcript, so they are read back on demand - only
    // when the reader actually asks what the other commands were.
    if (route === "/api/tool-calls" && req.method === "GET") {
      // Same rule as the child-console read: this returns transcript text, so it is behind the panel token when one
      // is configured.
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const thread = String(url.searchParams.get("thread") || "").trim();
      const tool = String(url.searchParams.get("tool") || "").trim();
      const limit = Math.max(1, Math.min(20, Number(url.searchParams.get("n")) || 8));
      // "+ 3 commands" is four calls: the count is how the right batch is found among the session's messages.
      const want = Math.max(0, Math.min(40, Number(url.searchParams.get("want")) || 0));
      // The turn's start, in ms: the batch belongs to that turn, not to whichever one ran most recently. `first` is
      // the call the summary printed, which pins the search to this batch inside the turn.
      const sinceMs = Number(url.searchParams.get("since")) || 0;
      const first = String(url.searchParams.get("first") || "").slice(0, 120);
      if (!thread || !tool) return sendJson(res, 400, { error: "thread and tool are required" });
      const job = jobs.firstOfThread(thread);
      const sessionId = job && job.sessionId;
      if (!sessionId) return sendJson(res, 404, { error: `no session recorded for ${thread}`, calls: [] });
      const { recentToolCalls } = await import("./lib/tool-calls.js");
      const calls = recentToolCalls({
        dbPath: path.join(hermesHome(), "state.db"),
        sessionId,
        tool,
        limit,
        want,
        first,
        // Whole seconds, with a minute of slack: a turn's first message can be written a moment before the panel's
        // own startedAt stamp.
        since: sinceMs ? Math.max(0, Math.floor(sinceMs / 1000) - 60) : 0,
      });
      return sendJson(res, 200, { thread, session: sessionId, tool, calls });
    }

    if (route === "/api/subagents" && req.method === "GET") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const thread = String(url.searchParams.get("thread") || "").trim();
      // Children the run delegated: their sessions, their state and the last thing each one did. Polled while a
      // card is working, because the gateway does not put a child's work on the parent's event stream.
      const dbPath = path.join(hermesHome(), "state.db");
      return thread
        ? sendJson(res, 200, { thread, subagents: subagentsFor(thread, { dbPath }) })
        : sendJson(res, 200, { roster: subagentRoster({ dbPath }) });
    }

    if (route === "/api/sessions" && req.method === "GET") {
      const target = cleanPath(url.searchParams.get("path"));
      if (!target) return sendJson(res, 400, { error: "path is required" });
      const mine = await sessionsForRow(target);
      const onBoard = new Set(jobs.list().map((j) => j.thread));
      return sendJson(res, 200, {
        path: target,
        sessions: mine.map((s) => ({
          id: s.id,
          title: s.title || null,
          matched: s.matched || null,
          lastActivityAt: s.lastActivityAt || null,
          onBoard: onBoard.has(s.id),
        })),
      });
    }

    if (route === "/api/sessions/revive" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const sessionId = String(body.sessionId || "").trim();
      const target = cleanPath(body.path);
      if (!sessionId) return sendJson(res, 400, { error: "sessionId is required" });
      if (!target) return sendJson(res, 400, { error: "path is required" });
      // Never take the pair on trust: the session must be one the store attributes to THIS row, or a
      // stale tab could file any conversation anywhere on the board.
      const mine = await sessionsForRow(target);
      const session = mine.find((s) => s.id === sessionId);
      if (!session) return sendJson(res, 404, { error: `no open session ${sessionId} in ${target}` });
      if (jobs.firstOfThread(sessionId)) return sendJson(res, 409, { error: "that session already has a card on the board" });
      // The last exchange, so the revived card reads as the conversation it brings back.
      const tail = await hermesSessionTail(sessionId, 2).catch(() => []);
      const owner = registry.projects
        .filter((p) => {
          const b = normPathKey(p.path);
          const t = normPathKey(target);
          return t === b || t.startsWith(`${b}/`);
        })
        .sort((a, b) => normPathKey(b.path).length - normPathKey(a.path).length)[0] || null;
      const out = jobs.revive({
        thread: sessionId,
        ownerPath: target,
        projectPath: owner ? owner.path : null,
        cwd: target,
        title: session.title || null,
        // The card is dated by the conversation, not by the click: "last active 40m ago" is the
        // useful fact about a session that was idle before the reader revived it.
        at: session.lastActivityAt || null,
        tail,
      });
      if (!out.ok) return sendJson(res, 409, out);
      log(`revived session ${sessionId} under ${target}`);
      return sendJson(res, 200, out);
    }

    if (route === "/api/jobs/attach" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const thread = String(body.thread || "").trim();
      const target = String(body.path || "").trim();
      if (!thread) return sendJson(res, 400, { error: "thread is required" });
      if (!jobs.firstOfThread(thread)) return sendJson(res, 404, { error: `unknown thread: ${thread}` });
      // detach: the agent goes back to the unattached workspace.
      if (body.detach === true || !target) {
        const r = jobs.setOwner(thread, null);
        broadcast({ type: "jobs", jobs: jobs.list() });
        return sendJson(res, 200, { ok: true, ownerPath: null, turns: r.turns, jobs: jobs.list() });
      }
      try {
        if (!(await stat(target)).isDirectory()) return sendJson(res, 400, { error: `${target} is not a directory` });
      } catch {
        return sendJson(res, 400, { error: `${target} does not exist` });
      }
      // Only a real worktree can own an agent, and only at its root — a subdirectory or a plain
      // folder would file the agent somewhere no row can ever show.
      const isWt = await gitIn(target, ["rev-parse", "--is-inside-work-tree"]);
      const top = await gitIn(target, ["rev-parse", "--show-toplevel"]);
      const normTarget = path.resolve(target).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      const normTop = String(top.out || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
      if (!isWt.ok || isWt.out !== "true" || normTop !== normTarget) {
        return sendJson(res, 400, { error: `${target} is not the root of a git worktree` });
      }
      const r = jobs.setOwner(thread, target);
      broadcast({ type: "jobs", jobs: jobs.list() });
      return sendJson(res, 200, { ok: true, ownerPath: r.ownerPath, turns: r.turns, jobs: jobs.list() });
    }

    if (route === "/api/jobs/label" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const thread = String(body.thread || "").trim();
      if (!thread) return sendJson(res, 400, { error: "thread is required" });
      if (!jobs.firstOfThread(thread)) return sendJson(res, 404, { error: `unknown thread: ${thread}` });
      // A panel-side display name only. The Hermes thread id stays the identity (it is what resumes
      // the session), so renaming can never orphan a conversation.
      const label = jobs.setLabel(thread, body.label);
      if (!label.ok) return sendJson(res, 400, { error: label.error });
      return sendJson(res, 200, { ok: true, thread, label: label.label, jobs: jobs.list() });
    }

    if (route === "/api/jobs/clear" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const thread = String(body.thread || "").trim();
      if (thread) {
        // Forget one conversation only. Refused while it is working: cancelling is a deliberate,
        // separate action, and a "clear" that silently killed a turn would be a trap.
        const r = jobs.clearThread(thread);
        if (!r.ok) {
          return sendJson(res, 409, { error: `a turn is still running in this agent — cancel it first`, running: r.running });
        }
        broadcast({ type: "jobs", jobs: jobs.list() });
        return sendJson(res, 200, { ok: true, removed: r.removed, jobs: jobs.list() });
      }
      jobs.clearFinished();
      broadcast({ type: "jobs", jobs: jobs.list() });
      return sendJson(res, 200, { ok: true, jobs: jobs.list() });
    }

    // The reader opened a project section. That is a promotion signal in its own right (lib/tiers.js): an old
    // repo is re-probed once and its rows re-read, instead of waiting for its next hourly slice. The read runs in
    // the background (the page repaints from the SSE row frames), so this answers at once with whether one began.
    if (route === "/api/project/open" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const name = String(body.project || "").trim();
      const project = (registry?.projects || []).find((p) => p.name === name);
      if (!project) return sendJson(res, 404, { error: `no project called '${name}'` });
      const tier = scheduler.projectTier(project);
      if (tier === "recent") return sendJson(res, 200, { ok: true, project: name, tier, promoting: false });
      void scheduler
        .openProject(name)
        .catch((e) => log(`tier: opening ${name} failed: ${String((e && e.message) || e)}`));
      return sendJson(res, 200, { ok: true, project: name, tier, promoting: true });
    }

    if (route === "/api/refresh" && req.method === "POST") {
      // Every POST goes through authorised(): with the panel reachable off this machine, "this route
      // forgot to check" is not a thing the next route should be able to repeat. Loopback is exempt, so
      // the local board is unaffected.
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      await scheduler.fastPass();
      return sendJson(res, 200, { ok: true });
    }

    // Which project sections the page can see right now. Sent when the set changes and as a heartbeat; in
    // scanMode "visible" it is what the scheduler reads instead of the whole fleet. It writes the scheduler's
    // visible set, so it is a write like any other: a route does not get to decide that the panel token does
    // not apply to it.
    if (route === "/api/visible" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const known = new Set(registry.projects.map((p) => p.name));
      const names = (Array.isArray(body.projects) ? body.projects : [])
        .map((n) => String(n || "").trim())
        .filter((n) => known.has(n));
      scheduler.noteVisible(names);
      return sendJson(res, 200, { ok: true, visible: names.length, mode: config.scanMode });
    }

    // Refresh everything, or only what is on screen. Server-side: the scans happen here, so the choice has to
    // outlive a tab and apply to whichever browser is open.
    if (route === "/api/settings/scan" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const mode = String(body.mode || "").toLowerCase() === "visible" ? "visible" : "all";
      try {
        await patchPanelConfig({ scanMode: mode });
      } catch (e) {
        return sendJson(res, 500, { error: `could not write config.json: ${String((e && e.message) || e)}` });
      }
      config.scanMode = mode;
      scheduler.cfg.scanMode = mode;
      // Switching back to "all" must not wait for the visibility heartbeat to lapse.
      if (mode === "all") scheduler.noteVisible(null);
      log(`scan mode: ${mode}`);
      broadcast({ type: "snapshot", data: snapshot() });
      return sendJson(res, 200, { ok: true, mode, settings: settingsOut() });
    }

    // Which folders the board scans, as a WRITE. The body is the whole list (`{ roots: [...] }`), because the tab
    // edits a list rather than adding to a file behind the reader's back: remove a folder and it stops being scanned.
    // Every entry must be an absolute path to an existing folder, duplicates are refused, and an empty list is allowed
    // — it means the fallback (the folder this panel sits in), which the answer names so the page can say so.
    //
    // Discovery is re-run BEFORE the answer goes out. That is the half that makes the list useful without a restart:
    // the project registry walks the new roots, the store learns the projects under them, and the snapshot broadcast
    // after it repaints the board with one card per folder. A discovery that throws is logged, not turned into a 500:
    // the file is already written, and the next sweep will read it.
    if (route === "/api/settings/scan-roots" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const checked = await readScanRootsBody(body);
      if (checked.error) return sendJson(res, 400, { error: checked.error, ...(await scanRootsOut()) });
      try {
        await patchPanelConfig({ scanRoots: checked.roots });
      } catch (e) {
        return sendJson(res, 500, { error: `could not write config.json: ${String((e && e.message) || e)}`, ...(await scanRootsOut()) });
      }
      applyScanRoots(config, checked.roots);
      log(
        `scan roots: ${config.scanRootsConfigured.length ? config.scanRootsConfigured.join(", ") : `(none named — scanning ${DEFAULT_SCAN_ROOT})`}`,
      );
      let projects = null;
      try {
        projects = (await registry.refresh({ after: true })).length;
      } catch (e) {
        log(`discovery after the scan-roots write failed: ${String((e && e.message) || e)}`);
      }
      broadcast({ type: "snapshot", data: snapshot() });
      return sendJson(res, 200, { ok: true, projects, ...(await scanRootsOut()) });
    }

    // Whether an agent may take its own tree off this disk once the work has landed: Settings → Board → Agents
    // clean up. Server-side like the two rows above, because this process is what hands out the RELEASE paragraph
    // and what sweeps the release executor — so the switch has to outlive a tab and apply to every browser.
    //
    // It is a VETO: on leaves each project's own `releaseWorktrees` grant deciding, so pressing it on never opens a
    // delete; off closes every project at once. Only a literal boolean in the body is written — a body that names
    // no `agentCleanup` writes OFF, because a delete permission that is assumed is not one.
    if (route === "/api/settings/cleanup" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const allowed = body.agentCleanup === true;
      try {
        await patchPanelConfig({ agentCleanup: allowed });
      } catch (e) {
        return sendJson(res, 500, { error: `could not write config.json: ${String((e && e.message) || e)}` });
      }
      config.agentCleanup = allowed;
      log(`agent cleanup: ${allowed ? "on — a project's own releaseWorktrees grant decides" : "off — no worktree is removed automatically"}`);
      broadcast({ type: "settings", settings: settingsOut() });
      return sendJson(res, 200, { ok: true, agentCleanup: allowed, settings: settingsOut() });
    }

    // How many worktrees a project's chart draws before its arrow lists the rest, so the board can open on the top
    // of each chart. Server-side for the same reason the refresh mode is: the number goes into this panel's own
    // config.json, so it survives a restart and applies to whichever browser is open — and it is the config.json the
    // reader edits by hand. `count: 0` draws every tree.
    if (route === "/api/settings/chart-top" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const count = chartTopCountFrom(body.count);
      try {
        await patchPanelConfig({ chartTopCount: count });
      } catch (e) {
        return sendJson(res, 500, { error: `could not write config.json: ${String((e && e.message) || e)}` });
      }
      config.chartTopCount = count;
      log(`chart: ${count ? `the top ${count} worktree${count === 1 ? "" : "s"} drawn (the chart's arrow shows the rest)` : "every worktree drawn"}`);
      broadcast({ type: "snapshot", data: snapshot() });
      return sendJson(res, 200, { ok: true, count, settings: settingsOut() });
    }

    // How long a parent the reader collapsed keeps the cards under it as they were before the page writes every one
    // of them into its remembered fold set. Server-side like the age threshold above: the number goes into this
    // panel's own config.json, so it survives a restart and applies to whichever browser is open. `seconds: 0`
    // disables the cascade — a collapsed parent then leaves its children's folds alone, which is what the panel did
    // before this row existed.
    if (route === "/api/settings/collapse-after" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const seconds = collapseAfterSecondsFrom(body.seconds);
      try {
        await patchPanelConfig({ collapseAfterSeconds: seconds });
      } catch (e) {
        return sendJson(res, 500, { error: `could not write config.json: ${String((e && e.message) || e)}` });
      }
      config.collapseAfterSeconds = seconds;
      log(`collapse cascade: ${seconds ? `a parent collapsed for ${seconds}s minimizes every card under it` : "off — a collapsed parent leaves its cards as they are"}`);
      broadcast({ type: "settings", settings: settingsOut() });
      return sendJson(res, 200, { ok: true, seconds, settings: settingsOut() });
    }

    // ---- Settings → General: what the panel costs the machine -------------------------------------
    // Three numbers that were config.json-only until now, and one route for all three because they are one
    // surface: how many git scans run at once (`threads`), how often a row is re-read (`worktreeSeconds`), and the
    // ceiling on what one assistant turn appends (`briefingBudgetChars`, stored on the assistant, not here).
    //
    // `threads` and `worktreeSeconds` are the spawn knobs. Measured on this machine, a CreateProcess costs 0.6-4.7s
    // under the endpoint agent, and the scan pool was running five of them continuously beside every agent tool
    // call; a panel at 5s x 5 workers is the load the fleet's own commands then queue behind. The route applies
    // both LIVE: a new pool replaces the old one (the scheduler takes the reference, and the retired pool closes
    // its workers once their scan returns), and the cadence is written into the scheduler's own cfg, so no restart
    // is needed and nothing on the board is dropped.
    //
    // `briefingBudgetChars` rides the assistant's OWN settings route (/api/assistant/settings) because it belongs
    // to that file; this route names it only so one Save can carry all three. It is forwarded there and reported
    // back in the same answer, and a refused value leaves the other two unwritten only when it is refused first.
    if (route === "/api/settings/general" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const int = (value, lo, hi) => {
        const n = Number(value);
        if (!Number.isFinite(n)) return null;
        const rounded = Math.round(n);
        return rounded < lo || rounded > hi ? null : rounded;
      };
      const threads = body.threads === undefined ? config.threads : int(body.threads, 1, 16);
      const worktreeSeconds = body.worktreeSeconds === undefined ? config.worktreeSeconds : int(body.worktreeSeconds, 5, 120);
      const budget = body.briefingBudgetChars === undefined ? null : int(body.briefingBudgetChars, 0, 40_000);
      if (threads === null) return sendJson(res, 400, { error: "scan workers must be a whole number from 1 to 16" });
      if (worktreeSeconds === null) return sendJson(res, 400, { error: "row refresh must be a whole number of seconds from 5 to 120" });
      if (body.briefingBudgetChars !== undefined && budget === null) {
        return sendJson(res, 400, { error: "the turn briefing budget must be a whole number of characters from 0 (off) to 40000" });
      }
      const patch = {};
      if (threads !== config.threads) patch.threads = threads;
      if (worktreeSeconds !== config.worktreeSeconds) patch.worktreeSeconds = worktreeSeconds;
      if (Object.keys(patch).length) {
        try {
          await patchPanelConfig(patch);
        } catch (e) {
          return sendJson(res, 500, { error: `could not write config.json: ${String((e && e.message) || e)}` });
        }
      }
      if (patch.worktreeSeconds !== undefined) {
        config.worktreeSeconds = worktreeSeconds;
        if (scheduler && scheduler.cfg) scheduler.cfg.worktreeSeconds = worktreeSeconds;
        log(`row refresh: every ${worktreeSeconds}s`);
      }
      if (patch.threads !== undefined) {
        config.threads = threads;
        const retired = pool;
        pool = new Pool(threads);
        if (scheduler) scheduler.pool = pool;
        // RETIRE, never close: this route runs while the fleet is being scanned, and `close()` terminates workers
        // mid-scan. The retiring pool refuses its queue (the next pass re-requests those rows) and lets the scans it
        // holds finish before its threads go.
        retired.retire();
        log(`scan workers: ${threads} (the pool was rebuilt live; the old one retires when its scans settle)`);
      }
      let settings = settingsOut();
      if (budget !== null) {
        try {
          const saved = assistant.setSettingsFor(undefined, { briefingBudgetChars: budget });
          settings = { ...settings, briefingBudgetChars: saved.briefingBudgetChars };
          log(`turn briefing budget: ${budget ? `${budget} chars` : "off — a turn is sent whole"}`);
        } catch (e) {
          return sendJson(res, 400, { error: String((e && e.message) || e) });
        }
      }
      broadcast({ type: "settings", settings: settingsOut() });
      return sendJson(res, 200, { ok: true, settings });
    }

    // Which of the worktree chart's columns are drawn. Server-side like the age threshold above: the list goes into
    // this panel's own config.json, so it survives a restart and applies to whichever browser is open. The body names
    // the columns to HIDE, not the ones to show, so a column added to the chart later arrives visible for every
    // reader; lib/chart-columns.js is the one place that decides which ids are real.
    if (route === "/api/settings/columns" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const hidden = chartColumnsFrom(body.hidden);
      try {
        await patchPanelConfig({ hiddenColumns: hidden });
      } catch (e) {
        return sendJson(res, 500, { error: `could not write config.json: ${String((e && e.message) || e)}` });
      }
      config.hiddenColumns = hidden;
      log(`chart columns: ${hidden.length ? `${hidden.join(", ")} hidden` : "all drawn"}`);
      // `settings`, not a snapshot: the page has to rebuild the tables (a hidden column is a missing cell in every
      // row), and that is what the settings handler does for every open tab.
      broadcast({ type: "settings", settings: settingsOut() });
      return sendJson(res, 200, { ok: true, hidden, settings: settingsOut() });
    }

    // Open a link from an agent's console in the OS default browser. Only http(s) gets through, and the
    // URL is handed to the opener as a single argv element: no shell, no `cmd.exe /c start`, so a query
    // string cannot become a second command. See lib/open-url.js for what that cost before.
    if (route === "/api/open-url" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const { url, error } = safeUrl(body.url);
      if (!url) return sendJson(res, 400, { error });
      const { bin, args } = openerFor(url);
      try {
        // Detached: the browser outlives this request, and its exit code says nothing about whether a
        // page opened. A spawn failure is the only failure this route can honestly report.
        const child = spawn(bin, args, { detached: true, stdio: "ignore", windowsHide: true });
        child.on("error", (e) => log(`could not open ${url}: ${String((e && e.message) || e)}`));
        child.unref();
      } catch (e) {
        return sendJson(res, 500, { error: String((e && e.message) || e) });
      }
      return sendJson(res, 200, { ok: true, url });
    }

    // "The reader has seen the list up to `seq`" — the ONE watermark, and the only write the badge needs. The
    // popover's open and the badge's dismiss both POST here, so there is one mechanism and two doors. `seq` comes
    // from the page but only ever names a row the store already has: the store clamps it to its newest `seq`, refuses
    // a non-integer, and only moves the watermark forward. The answer is the watermark plus what is left, so a page
    // paints from the POST without a second GET.
    if (route === "/api/deliverables/seen" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const seen = deliverables.markSeen(body.seq);
      if (seen.error) return sendJson(res, 400, { error: seen.error });
      return sendJson(res, 200, { ok: true, seenSeq: seen.seenSeq, seenAt: seen.seenAt, unseenCount: seen.unseenCount, moved: seen.moved });
    }

    // Open ONE recorded deliverable, by the `seq` the page sent back and nothing else. The target comes out of the
    // store — never out of the request — so a stray string from a page cannot launch an arbitrary file, which is the
    // same rule the artifact delete below follows. The token is passed to `authorised`, not omitted: the one-argument
    // form refuses every off-machine write even when the request carries a correct `x-panel-token`, so a reader on
    // another machine got a 403 that read like a bad token (the review's M1).
    if (route === "/api/deliverables/open" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const entry = deliverables.get(body.seq);
      if (!entry) {
        const asked = body.seq === undefined || body.seq === null || String(body.seq).trim() === "" ? "" : ` ${body.seq}`;
        return sendJson(res, 404, {
          error: `no deliverable${asked} on this panel — the list was pruned, or this page is older than the store`,
        });
      }
      // Detached, exactly like /api/open-url: neither explorer.exe nor a detached Chrome reports an exit code that
      // means anything, so the route answers from the spawn and not from the child.
      const launch = (bin, args) => {
        const child = spawn(bin, args, { detached: true, stdio: "ignore", windowsHide: true });
        child.on("error", (e) => log(`could not open deliverable ${entry.seq} (${entry.target}): ${String((e && e.message) || e)}`));
        child.unref();
      };
      const href = deliverableHref(entry);

      if (entry.kind === "link") {
        // A link has a URL, so the reader's own browser opens it and this route launches nothing: the page opens the
        // tab in the click, which is the only way a popup is not blocked. What comes back is the URL — never a
        // guess about whether it answers, because the panel does not fetch a URL on the reader's behalf.
        if (!href) {
          return sendJson(res, 400, {
            error: `only http(s) links can be opened — “${oneLine(entry.target, 120)}” is not one`,
          });
        }
        if (body.mode !== "launch") {
          return sendJson(res, 200, { ok: true, kind: "link", target: entry.target, open: "tab", url: href });
        }
        // The page's tab was blocked (a host that refuses target=_blank). Chrome when this machine has one, the OS
        // default browser when it does not: a missing Chrome must never become a missing deliverable. This is the one
        // case the panel still launches a browser for a link, and `href` above has already proved it is an http(s)
        // URL — what is handed over is a URL, not a command line.
        try {
          const found = chromeFor(entry.target);
          const { bin, args } = found || openerFor(entry.target);
          launch(bin, args);
          return sendJson(res, 200, { ok: true, kind: "link", target: entry.target, open: "launch", opener: path.basename(bin), chrome: Boolean(found) });
        } catch (e) {
          return sendJson(res, 500, { error: String((e && e.message) || e) });
        }
      }

      // A file or an image, judged by what the filesystem says NOW and in this order: gone, then not-a-file, then
      // outside the repo, then whether the panel has a URL for it. Every one of those is a refusal the card states,
      // so none of them may launch anything first.
      const info = await stat(entry.target).catch(() => null);
      if (!info) {
        // What was recorded is what is opened: the store's own absolute path. A file that has since been moved or
        // deleted stamps `missingAt` (so the row says `gone` on the next read) and answers 404 with the sentence that
        // says when it was last seen.
        deliverables.markMissing(entry.seq);
        return sendJson(res, 404, {
          error: `no such file: ${entry.target} — it was there when ${entry.agent || "an agent"} delivered it (${entry.at}); it has since been moved or deleted`,
        });
      }
      if (!info.isFile()) {
        // NOT markMissing: a directory is not a file that vanished. Stamping it `gone` hid a real folder behind a
        // dead row (measured: the row said `gone` for a directory that was there the whole time).
        return sendJson(res, 400, {
          error: `that is a directory, not a file: ${entry.target} — the panel opens files and links, not folders`,
        });
      }
      deliverables.clearMissing(entry.seq); // a restored file is not `gone` any more
      if (href) {
        // The panel serves this file, so it has a URL and the browser opens it in a tab. What the panel serves of its
        // own public/ is not a path the boundary below is holding back; the page normally opens it straight from the
        // list's `href`, and this answer is for a caller that asked. It spawns nothing.
        return sendJson(res, 200, { ok: true, kind: entry.kind, target: entry.target, open: "tab", url: href, bytes: info.size });
      }
      // Everything else is a file on disk, and the panel opens one only inside the tree that delivered it.
      const repo = deliverableRepoRoot(entry);
      if (!repo || !insideRepo(entry.target, repo)) {
        return sendJson(res, 403, {
          error: `outside the repo: ${entry.target} — ${repo ? `it is not inside ${repo}` : "it is inside no git checkout"}; a deliverable is the file an agent put in its own tree`,
        });
      }
      // No URL: the browser cannot render it, so the OS default handler is what opens it — the existing route, and
      // the only opener left for a file the panel does not serve.
      try {
        const { bin, args } = openerFor(entry.target);
        launch(bin, args);
        return sendJson(res, 200, { ok: true, kind: entry.kind, target: entry.target, open: "handler", opener: path.basename(bin), bytes: info.size });
      } catch (e) {
        return sendJson(res, 500, { error: String((e && e.message) || e) });
      }
    }

    // Delete a deliverable. The confirmation lives in the UI; this only acts on a path or URL the panel
    // itself recorded, so a stray string from the page can never delete an arbitrary file.
    if (route === "/api/jobs/artifact/delete" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const key = String(body.key || body.path || body.url || "").trim();
      const hit = jobs.findArtifact(key);
      if (!hit) return sendJson(res, 404, { error: `not a recorded deliverable: ${key}` });
      let removedFile = false;
      if (hit.artifact.kind !== "url" && hit.artifact.path) {
        try {
          await unlink(hit.artifact.path);
          removedFile = true;
        } catch (e) {
          // Already gone is the same outcome for the reader; anything else is worth reporting.
          if (e.code !== "ENOENT") return sendJson(res, 500, { error: String((e && e.message) || e) });
        }
      }
      jobs.removeArtifact(hit.job, key);
      return sendJson(res, 200, { ok: true, removedFile, kind: hit.artifact.kind || "file" });
    }

    // Remove a worktree from the board: the directory goes to the Windows Recycle Bin (recoverable), then git's
    // own bookkeeping is pruned. Never the project's own checkout, never a tree with a live agent, never a locked
    // tree. The act itself is lib/worktree-remove.js, because the answer a CHECKING agent gives (LANDED: YES) ends in
    // the same removal and has to pass through the same guards - the lock, the live-agent check and what git still
    // lists are enforced there, so a second caller cannot arrive one guard short of this one.
    if (route === "/api/worktree/delete" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const projectName = String(body.project || "").trim();
      const target = path.resolve(String(body.path || "").trim());
      const project = scheduler.getProjects().find((p) => p.name === projectName);
      if (!project) return sendJson(res, 404, { error: `unknown project: ${projectName}` });
      const row = scheduler.store.rowsFor(projectName).find((r) => path.resolve(r.path) === target);
      if (!row) return sendJson(res, 404, { error: `not a worktree row of ${projectName}: ${target}` });
      const out = await deleteWorktreeRow({ project, row, target, jobs, locks, onLog: log });
      if (!out.ok) return sendJson(res, out.status || 500, { error: out.error, lock: out.lock || undefined });
      // Drop by the path the STORE knows, not by `path.resolve(target)`: rows are keyed by the scanned path with
      // forward slashes, so a resolved Windows path is a different key and the row survived its own deletion.
      scheduler.store.dropRow(projectName, row.path);
      // A snapshot only refreshes the rows it carries - it never retracts one - so the removal needs its own event
      // or the row sits on every open board for a worktree that no longer exists.
      broadcast({ type: "drop", project: projectName, path: row.path });
      broadcast({ type: "snapshot", data: snapshot() });
      return sendJson(res, 200, out);
    }

    // Open a file an agent produced for the reader. Not a URL: a real path, opened in an editor.
    if (route === "/api/open-path" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const target = path.resolve(String(body.path || "").trim());
      const info = await stat(target).catch(() => null);
      if (!info || !info.isFile()) return sendJson(res, 404, { error: `no such file: ${target}` });
      const [bin, args] = await editorFor(target);
      try {
        // Detached, and no waiting: an editor stays open until the reader closes it, so an execFile
        // callback would hold this response (and the browser) hostage for the whole editing session.
        // windowsHide belongs with detached: a detached child is the one Windows gives its own console,
        // so leaving it out here is a console window appearing next to the editor (and off a .cmd shim,
        // the cmd.exe that hosts it).
        const child = spawn(bin, args, { detached: true, stdio: "ignore", windowsHide: true });
        child.on("error", () => {});
        child.unref();
      } catch (e) {
        return sendJson(res, 500, { error: String((e && e.message) || e) });
      }
      return sendJson(res, 200, { ok: true, path: target, editor: path.basename(bin) });
    }

    // One worktree, read now — the next-read ring on a row is a button. Refused while that row is
    // already being read: two scans of one worktree at once is exactly what the pool prevents.
    //
    // `reconcile: true` is the row's own ⟳, and asks for the same read ONE DEPTH DEEPER: the tree is read with the
    // network answers (heads, PRs, upstreams), then its TODO list is reconciled against the commits the branch now
    // carries and the files those commits touched (a PROPOSAL beside the list, never a close), its description is
    // re-derived only when that is empty or demonstrably stale, and one journal line per action is kept with the row.
    // One route with two depths, not a second refresh endpoint: the ring's cheap read is untouched, and there is
    // nothing here for a later change to keep in step.
    if (route === "/api/refresh/row" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const projectName = String(body.project || "").trim();
      const rowPath = String(body.path || "").trim();
      const project = scheduler.getProjects().find((p) => p.name === projectName);
      if (!project) return sendJson(res, 404, { error: `unknown project: ${projectName}` });
      const row = scheduler.store.rowsFor(projectName).find((r) => r.path === rowPath);
      if (!row) return sendJson(res, 404, { error: `unknown row: ${rowPath}` });
      if (scheduler.pool.isBusy(rowPath)) return sendJson(res, 409, { error: "that row is already being read" });
      const reconcile = Boolean(body.reconcile);
      // The facts BEFORE the read: what moved is the whole point of the reconcile's answer, and `putRow` replaces
      // the row object, so nothing here can be read afterwards.
      const before = reconcile
        ? {
            verdict: row.verdict,
            ahead: row.ahead,
            behind: row.behind,
            dirty: row.dirty,
            untracked: row.untracked,
            cherryPlus: row.cherryPlus,
            cherryMinus: row.cherryMinus,
            head: row.head,
            branch: row.branch,
            pr: row.pr ? { number: row.pr.number, state: row.pr.state } : null,
          }
        : null;
      // Claim the slot, or the timer will scan it again the moment this finishes.
      scheduler.lastFast.set(`${projectName}::${rowPath}`, Date.now());
      if (!reconcile) {
        const merged = await scheduler.scanOne(project, rowPath, "full");
        return sendJson(res, 200, { ok: true, row: merged });
      }
      const after = await scheduler.fullScan(project, rowPath);
      if (!after) return sendJson(res, 409, { error: "that row could not be read just now — try again" });

      const lines = [];
      // (1) MERGE STATE — one line per fact that actually moved.
      const delta = mergeDelta(before, after);
      lines.push(...(delta.length ? delta : ["re-read, nothing moved"]));

      // What the tree now holds, read once: the commits off the base and the files they touched. Both halves of the
      // TODO reconcile want it, and the description's staleness test reads the same subjects.
      const base = after.baseRef || project.mainBranch || null;
      let tree = { commits: [], subjects: [], touched: [] };
      if (base) {
        const gitlog = await gitIn(after.path, ["log", "--name-only", "--format=%h %s", "-60", `${base}..HEAD`], 20_000);
        if (gitlog.ok) tree = parseCommitFiles(gitlog.out);
      }

      // (2) TODO — propose closures from the commits and from the files those commits touched. Nothing is applied:
      // the proposal rides on the list (`row.todo.proposal`) and the row's badge says how many items look closed.
      let proposed = { ok: false, changed: false, proposals: [] };
      const list = todos.forRow(project.name, after.path, { journal: 0 });
      if (list?.items?.length) {
        const proposals = todoProposals({ items: list.items, subjects: tree.subjects, touchedFiles: tree.touched });
        proposed = todos.propose({ project: project.name, path: after.path, proposals, by: "panel" });
        lines.push(
          proposals.length
            ? `TODO ${proposals.length} item${proposals.length === 1 ? "" : "s"} look closed — nothing marked done (${proposals.map((p) => `#${p.id}`).join(" ")})`
            : "TODO no open item is named by this tree's commits or touched files",
        );
      } else {
        lines.push("TODO nothing written down for this tree — nothing to reconcile");
      }

      // (3) DESCRIPTION — lib/descriptions.js owns the text and the "never overwrite the reader's" rule; this asks it
      // to re-derive from the earliest run still in the store, and it writes only if the record is missing or
      // demonstrably stale against the commits above.
      const desc = descriptions.refreshTree({ project: project.name, path: after.path, branch: after.branch, commits: tree.subjects });
      lines.push(`description ${desc.wrote ? `re-derived — ${desc.why}` : desc.why}`);

      // (4) THE AGENT PASS — offered, started or refused. `off|ask|auto`, defaulting to `ask`; a mismatch is what makes
      // it worth an agent at all, and a live run already holding the tree is a refusal rather than a second worker.
      const mode = normaliseRefreshAgent(body.refreshAgent);
      const mismatch = delta.length > 0 || proposed.proposals.length > 0 || Boolean(desc.stale) || desc.wrote;
      const busy = liveRunIn(jobs.list(), after.path, { isLive: isLiveJobStatus });
      const agent = { mode, mismatch, offered: false, started: null, refused: null };
      if (mode === "off") lines.push("agent pass off (setting: off) — the cheap pass is all this refresh does");
      else if (!mismatch) lines.push("agent pass not needed — the cheap pass found nothing to double-check");
      else if (busy) {
        agent.refused = `an agent is running in that worktree (${busy.id})`;
        lines.push(`agent pass refused — ${agent.refused}`);
      } else if (mode === "auto") {
        const started = await startRowRefreshAgent(project, after, delta);
        if (started.ok) {
          agent.started = { id: started.job.id, thread: started.job.thread || null };
          lines.push(`agent started in this worktree — ${started.job.thread || started.job.id} (setting: auto)`);
        } else {
          agent.refused = started.error;
          lines.push(`agent pass could not start — ${started.error}`);
        }
      } else {
        agent.offered = true;
        lines.push("agent pass offered — one card under the row starts it (setting: ask)");
      }

      // (5) JOURNAL — one line per action, kept with the row and shipped back with it.
      const rowKey = store.rowKey(project.name, after.path);
      refreshLog.append({ key: rowKey, project: project.name, path: after.path, lines });

      // The row as the page should draw it now: the store's own row plus the things that ride with the snapshot.
      const out = { ...after };
      const todoNow = todos.forRow(project.name, after.path);
      if (todoNow) out.todo = todoNow;
      else delete out.todo;
      const descRec = descriptions.descriptions.forTree({ project: project.name, path: after.path, branch: after.branch });
      if (descRec?.text) out.description = { text: descRec.text, from: descRec.from || null, at: descRec.at || null, by: descRec.by || null };
      else delete out.description;
      out.refreshJournal = refreshLog.recent(rowKey, REFRESH_LINES_SHOWN);
      // Every open board agrees with the click, not only the tab that made it.
      broadcast({ type: "row", project: project.name, row: ownerOnRow(project.name, out), changed: true });

      log(`row reconcile: ${project.name} ${after.path} — ${lines.join(" · ")}`);
      return sendJson(res, 200, {
        ok: true,
        project: project.name,
        path: after.path,
        row: out,
        journal: lines,
        changed: delta.length > 0,
        mismatch,
        todo: { proposals: proposed.proposals || [], changed: Boolean(proposed.changed), ok: Boolean(proposed.ok) },
        description: { wrote: Boolean(desc.wrote), why: desc.why, stale: Boolean(desc.stale), text: out.description?.text || null },
        agent,
      });
    }

    // The offer card's button: start the double-check agent the ⟳ offered. Not a refresh route — it spawns, which is
    // why it is its own path under the row it belongs to (the way /api/worktree/verify-landed is). It re-answers every
    // gate the reconcile did (the row is still there, nothing live holds the tree, the gateway is usable), so a card
    // that sat on the page for a minute cannot start a run in a tree that no longer needs one.
    if (route === "/api/refresh/row/agent" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const asked = String(body.path || "").trim();
      if (!asked) return sendJson(res, 400, { error: "path is required" });
      const target = path.resolve(asked);
      const project = body.project ? scheduler.getProjects().find((p) => p.name === String(body.project).trim()) : null;
      const row =
        (project ? scheduler.store.rowsFor(project.name) : []).find((r) => path.resolve(r.path) === target) ||
        scheduler.getProjects().map((p) => scheduler.store.rowsFor(p.name).find((r) => path.resolve(r.path) === target)).find(Boolean);
      if (!row) return sendJson(res, 404, { error: `not a worktree row: ${target}` });
      const owner = project || scheduler.getProjects().find((p) => scheduler.store.rowsFor(p.name).includes(row));
      if (!owner) return sendJson(res, 404, { error: `no project owns ${target}` });
      const evidence = Array.isArray(body.evidence) ? body.evidence.map(String).slice(0, 8) : [];
      const started = await startRowRefreshAgent(owner, row, evidence);
      if (!started.ok) return sendJson(res, started.status || 400, { error: started.error });
      const rowKey = store.rowKey(owner.name, row.path);
      const say = `agent started in ${row.name} — ${started.job.thread || started.job.id}`;
      refreshLog.append({ key: rowKey, project: owner.name, path: row.path, lines: [say] });
      broadcast({ type: "snapshot", data: snapshot() });
      return sendJson(res, 202, { ok: true, job: started.job, say });
    }

    // The UNMERGED chip's button: start the merge agent for one worktree. The board's verdict is a scan behind and
    // a half-finished tree is the one thing that must never be merged, so every fact the button's enabled state
    // claims is re-read here, from git, before a run exists. The prompt is lib/merge-prompt.js (the script the agent
    // is held to); `dryRun` hands it back for a preview without starting anything.
    if (route === "/api/worktree/merge" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const asked = String(body.path || "").trim();
      if (!asked) return sendJson(res, 400, { error: "path is required" });
      const worktree = path.resolve(asked);
      const info = await stat(worktree).catch(() => null);
      if (!info || !info.isDirectory()) return sendJson(res, 404, { error: `no such directory: ${worktree}` });
      // A worktree can live anywhere (`git worktree add ../tree`), so a path outside the project's own root is not an
      // error by itself: the row's project is the hint, and git's own worktree list is the proof that the hint is real.
      let project = spawnFeature.projectForPath(worktree) || registry.projects.find((p) => normPathKey(p.path) === normPathKey(worktree));
      let trees = project ? await worktreeList(project.path).catch(() => []) : [];
      if (!project) {
        const hinted = registry.projects.find((p) => p.name === String(body.project || "").trim());
        if (hinted) {
          const listed = await worktreeList(hinted.path).catch(() => []);
          if (listed.some((w) => normPathKey(w.path) === normPathKey(worktree))) {
            project = hinted;
            trees = listed;
          }
        }
      }
      if (!project) return sendJson(res, 400, { error: `${worktree} is not inside a known project, and is not one of its worktrees` });
      const base = String(project.mainBranch || "");
      if (!base) return sendJson(res, 400, { error: `${project.name} has no base branch (no main/master and no remote default) to merge into` });
      const remote = project.remote || null;
      const baseRef = remote ? `${remote}/${base}` : base;
      const row = await scanWorktree(worktree, { remoteRef: baseRef, mainBranch: base }, "fast");
      if (row.error) return sendJson(res, 400, { error: row.error });
      if (row.branch === base) return sendJson(res, 409, { error: `${path.basename(worktree)} is on ${base} itself — there is nothing to land` });
      if (row.ahead === null) return sendJson(res, 409, { error: `cannot count commits against ${baseRef} in this worktree — is the base ref there?` });
      if (row.ahead === 0) return sendJson(res, 409, { error: `${row.branch} has no commits off ${base} — nothing to land` });
      const dirty = Number(row.dirty) || 0;
      const untracked = Number(row.untracked) || 0;
      if (dirty || untracked) {
        return sendJson(res, 409, {
          error: `the tree is not clean (${dirty} modified, ${untracked} untracked) — commit or stash them first, so a merge cannot carry someone else's work`,
        });
      }
      const label = mergeLabel(base);
      // One merge agent per worktree: a second would race the first over the same base branch.
      const live = jobs
        .list()
        .find((j) => isLiveJobStatus(j.status) && normPathKey(j.ownerPath || j.cwd) === normPathKey(worktree) && String(j.label || "").startsWith("MERGING into "));
      if (live) return sendJson(res, 409, { error: `an agent is already merging this worktree (${live.label || live.thread})` });
      const list = await gitIn(worktree, ["log", "--oneline", "-20", `${baseRef}..HEAD`], 20000);
      const commitList = list.ok ? list.out.split("\n").filter(Boolean) : [];
      // Where the base branch is actually checked out — normally the project's own checkout, but the worktree list
      // read above is the only thing that knows, and merging into a branch that is checked out elsewhere needs that
      // directory.
      const root = (trees.find((w) => w.branch === base) || trees[0] || { path: project.path }).path;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      // The reader's lock goes into the agent's own script, not just into the board: a merge agent's last phase is
      // cleanup, and that is exactly where a locked tree must not be touched. The delete route refuses it too — this
      // is so the agent never tries and then reports a failure it cannot understand.
      const lock = locks.check({ project: project.name, path: worktree, branch: row.branch });
      const prompt = mergePrompt({
        project: project.name,
        worktree,
        root,
        branch: row.branch,
        base,
        remote,
        baseRef,
        ahead: row.ahead,
        commits: commitList,
        stamp,
        locked: lock.locked ? lock : null,
        panelPort: config.port,
        // Where this branch lands — the doctrine of the project's host (logs/hosts.json), not a shape chosen here. A
        // project with no mapping hands over null, and the prompt says so instead of inventing a PR.
        host: hosts.landing(project, { branch: row.branch }),
      });
      const thread = makeThreadName(`${label} ${project.name}`);
      const preview = { project: project.name, base, baseRef, remote, branch: row.branch, ahead: row.ahead, root, worktree: worktree.replace(/\\/g, "/"), label, thread, prompt, lock: lock.locked ? lock : null };
      if (body.dryRun) return sendJson(res, 200, { dryRun: true, ...preview });
      // The whole start, as its own function, because a local-only panel may have to PARK it on the reader's
      // permission box first and run it the moment they say yes. The one thing the merge agent does that touches
      // the world outside this box is PHASE 4's push, so that is the panel's own remote write and it asks first.
      const startMerge = async () => {
        const transport = await jobs.probe();
        if (!transport.reachable || !transport.capabilities?.runs) {
          return { status: 503, body: { error: gatewayRefusalText(transport, jobs.api.url), ...preview, prompt: undefined } };
        }
        const top = await gitIn(worktree, ["rev-parse", "--show-toplevel"], 15000);
        const ownerPath = top.ok && top.out ? top.out : worktree;
        // `remoteWrite: "land"` is what tells lib/jobs.js this worker MAY push and names the landing step: the
        // merge prompt says so in every phase, and the brief line must not contradict it.
        const job = await jobs.create({ prompt, thread, cwd: worktree, existing: true, ownerPath, project: project.name, remoteWrite: "land", remote, baseBranch: base });
        // The card is named for the job it is doing before it draws: the label survives the thread for good, and it
        // is what the route above reads back to refuse a second merge agent in the same tree.
        jobs.setLabel(job.thread, label);
        if (job.status === "failed") return { status: 502, body: { error: job.error || "the run could not be started", job, ...preview, prompt: undefined } };
        log(`merge ${row.branch} -> ${base} in ${project.name}: job ${job.id} (${job.status})`);
        return { status: 202, body: { job, ...preview } };
      };
      // The MERGE flow asks under this project's two controls too: its last phase pushes the BASE branch, which is an
      // EXISTING branch, so the existing-branch control is the one that decides. `never` refuses the start outright
      // (no box), `always-ask` parks it, and allow/name-gate start it.
      const mergePush = resolvePushPermissions(project, config);
      const decision = remoteWrites.decision(worktree, policyForProject(project, config.remoteBranchPolicy), {
        pushMode: permissionForPush(mergePush, { branch: base, isNew: false }),
      });
      if (decision.allowed) {
        // A one-shot grant is spent by the write it was granted for.
        if (decision.consume) remoteWrites.spend(worktree);
        const out = await startMerge();
        return sendJson(res, out.status, out.body);
      }
      if (!decision.ask) {
        return sendJson(res, 403, {
          error: `nothing was started: ${decision.why}. The merge agent pushes the base branch as its last phase, so the panel will not start one while remote writes are refused.`,
          ...preview,
          prompt: undefined,
        });
      }
      // Local only (the default): park it on the permission box. Answering Allow starts the merge; Deny starts
      // nothing at all, which is the difference between asking and telling.
      const parked = remoteWrites.request({
        kind: "merge",
        worktree,
        project: project.name,
        branch: row.branch,
        remote,
        title: `${label} — ${project.name}`,
        command: `git push ${remote || "<remote>"} ${base}   (PHASE 4 of ${label}, in ${root} — the merge itself is only staged first)`,
        description:
          "the panel's OWN merge flow, which pushes the base branch once the branch has landed and the tests pass. Allow starts the merge agent; Deny starts nothing and touches neither tree.",
        timeoutSeconds: config.remoteWriteSeconds,
        resume: async () => {
          const out = await startMerge();
          if (out.status >= 400) log(`remote-write ${parked.id}: the granted merge could not start — ${out.body?.error || out.status}`);
          // The page finds the new card through the ordinary job events this emits.
          broadcast({ type: "jobs", jobs: jobs.list() });
          return out;
        },
      });
      log(`merge ${row.branch} -> ${base} in ${project.name}: parked on the permission box (${parked.id}) — the setting is local-only`);
      return sendJson(res, 202, { pending: { id: parked.id, deadline: parked.deadline, timeoutSeconds: parked.timeoutSeconds, kind: "merge" }, ...preview, prompt: undefined });
    }

    // The UNMERGED chip's fourth outcome: an agent that CHECKS the branch against the base, because the commit count
    // cannot answer it. A squash, a rebase or a hand-rewritten patch leaves the branch carrying commits of its own
    // while the base holds the change under another sha, so "is it on main?" is a question about CONTENT, and
    // lib/verify-prompt.js is the script that answers it from the content itself (a reverse-apply of the branch's own
    // patch to a pristine export of the base).
    //
    // The run writes nothing to either branch, so it does NOT pass through the remote-write box: the only act that
    // follows its answer is the panel's own delete - on LANDED: YES, through the same lib/worktree-remove.js the ✕
    // uses, so a locked tree, a tree with a live agent and a tree with uncommitted work are all still refused.
    // `dryRun` hands the script back without starting anything, the way the merge route does.
    if (route === "/api/worktree/verify-landed" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const asked = String(body.path || "").trim();
      if (!asked) return sendJson(res, 400, { error: "path is required" });
      const worktree = path.resolve(asked);
      const info = await stat(worktree).catch(() => null);
      if (!info || !info.isDirectory()) return sendJson(res, 404, { error: `no such directory: ${worktree}` });
      // The same resolution the merge route does, for the same reason: a worktree can live anywhere, so the row's
      // project is the hint and git's own worktree list is the proof that the hint is real.
      let project = spawnFeature.projectForPath(worktree) || registry.projects.find((p) => normPathKey(p.path) === normPathKey(worktree));
      let trees = project ? await worktreeList(project.path).catch(() => []) : [];
      if (!project) {
        const hinted = registry.projects.find((p) => p.name === String(body.project || "").trim());
        if (hinted) {
          const listed = await worktreeList(hinted.path).catch(() => []);
          if (listed.some((w) => normPathKey(w.path) === normPathKey(worktree))) {
            project = hinted;
            trees = listed;
          }
        }
      }
      if (!project) return sendJson(res, 400, { error: `${worktree} is not inside a known project, and is not one of its worktrees` });
      const base = String(project.mainBranch || "");
      if (!base) return sendJson(res, 400, { error: `${project.name} has no base branch (no main/master and no remote default) to check against` });
      const remote = project.remote || null;
      const baseRef = remote ? `${remote}/${base}` : base;
      const row = await scanWorktree(worktree, { remoteRef: baseRef, mainBranch: base }, "fast");
      if (row.error) return sendJson(res, 400, { error: row.error });
      if (row.branch === base) return sendJson(res, 409, { error: `${path.basename(worktree)} is on ${base} itself - there is nothing to check` });
      if (row.ahead === null) return sendJson(res, 409, { error: `cannot count commits against ${baseRef} in this worktree - is the base ref there?` });
      if (row.ahead === 0) return sendJson(res, 409, { error: `${row.branch} has no commits off ${base} - there is nothing to check` });
      const label = verifyLabel(base);
      // One check agent per worktree: a second would spend the gateway's run on the answer the first one is writing.
      const running = jobs
        .list()
        .find((j) => isLiveJobStatus(j.status) && normPathKey(j.ownerPath || j.cwd) === normPathKey(worktree) && String(j.label || "").startsWith("CHECKING "));
      if (running) return sendJson(res, 409, { error: `an agent is already checking this worktree (${running.label || running.thread})` });
      const list = await gitIn(worktree, ["log", "--oneline", "-20", `${baseRef}..HEAD`], 20000);
      const commitList = list.ok ? list.out.split("\n").filter(Boolean) : [];
      const root = (trees.find((w) => w.branch === base) || trees[0] || { path: project.path }).path;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const lock = locks.check({ project: project.name, path: worktree, branch: row.branch });
      const prompt = verifyPrompt({
        project: project.name,
        worktree,
        root,
        branch: row.branch,
        base,
        baseRef,
        remote,
        ahead: row.ahead,
        commits: commitList,
        stamp,
        // What the board knows, so the agent reads a clean tree rather than trusting this line: the panel will refuse
        // the delete for a dirty tree, and the report has to say so before the reader wonders why nothing moved.
        dirty: row.dirty,
        untracked: row.untracked,
        locked: lock.locked ? lock : null,
        panelPort: config.port,
        scratchBase: tmpdir(),
      });
      const thread = makeThreadName(`${label} ${project.name}`);
      const preview = { project: project.name, base, baseRef, remote, branch: row.branch, ahead: row.ahead, root, worktree: worktree.replace(/\\/g, "/"), label, thread, prompt, lock: lock.locked ? lock : null };
      if (body.dryRun) return sendJson(res, 200, { dryRun: true, ...preview });
      const transport = await jobs.probe();
      if (!transport.reachable || !transport.capabilities?.runs) {
        return sendJson(res, 503, { error: gatewayRefusalText(transport, jobs.api.url), ...preview, prompt: undefined });
      }
      const top = await gitIn(worktree, ["rev-parse", "--show-toplevel"], 15000);
      const ownerPath = top.ok && top.out ? top.out : worktree;
      // `remoteWrite: "none"` is the promise this run makes: a check reads, so the landing paragraphs stay out of its
      // brief and no push guard is installed for a push it must never make.
      const job = await jobs.create({ prompt, thread, cwd: worktree, existing: true, ownerPath, project: project.name, remoteWrite: "none" });
      // The label is what the sweep reads the answer back from, so it is set before the card draws.
      jobs.setLabel(job.thread, label);
      if (job.status === "failed") return sendJson(res, 502, { error: job.error || "the run could not be started", job, ...preview, prompt: undefined });
      log(`check ${row.branch} against ${base} in ${project.name}: job ${job.id} (${job.status})`);
      return sendJson(res, 202, { job, ...preview });
    }

    // Give a worktree a name of its own: the directory and its branch. The row is looked up by path, and the whole
    // operation refuses while an agent is running in the tree - see renameWorktree().
    //
    // This is the DELIBERATE half: it renames whenever the reader asks, including a tree the automatic half has
    // already named (replacing a name is the point), and it writes down who asked and when - the naming ledger's
    // record is what stops every later automatic rename of this tree.
    if (route === "/api/worktree/rename" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      const out = await renameWorktree({
        projectName: String(body.project || "").trim(),
        target: String(body.path || "").trim(),
        name: String(body.name || "").trim(),
        by: String(body.by || "").trim().slice(0, 80) || "the reader",
        how: String(body.how || "").trim().slice(0, 160) || "renamed from the row",
      });
      if (out.error) return sendJson(res, out.status || 500, { error: out.error });
      return sendJson(res, 200, { ...out, name: path.basename(out.path), namedLine: describeNaming(out.named) });
    }

    // Clone a GitHub repo over SSH into ONE of the configured scan roots — what the folder
    // accordion's "+" uses: the root is the folder you clicked, the name is the repo
    // (`name` or `owner/name`). The destination is inside that root and must not exist yet.
    // Responds as soon as git finishes; discovery picks the new repo up on the next pass (the
    // refresh below is deliberately not awaited — probing 94 repos would stall the response).
    if (route === "/api/clone" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
      const rootNorm = norm(body.root);
      const roots = (config.scanRoots || []).map(norm).filter(Boolean);
      if (!rootNorm || !roots.some((r) => r.toLowerCase() === rootNorm.toLowerCase())) {
        return sendJson(res, 400, { error: `root must be one of scanRoots: ${rootNorm || "(none)"}` });
      }
      // Only a plain repo name, optionally prefixed by an owner: no paths, no `..`, no URLs.
      const m = /^(?:([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/)?([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(String(body.name || "").trim());
      if (!m) return sendJson(res, 400, { error: `not a repo name: ${String(body.name || "").trim()}` });
      const owner = m[1] || String(config.cloneOwner || "JLRoper");
      const repo = m[2];
      const url = `git@github.com:${owner}/${repo}.git`;
      const dest = path.join(rootNorm, repo);
      try {
        await stat(dest);
        return sendJson(res, 409, { error: `${dest} already exists`, dest });
      } catch {
        /* good: nothing there yet */
      }
      const t0 = Date.now();
      const r = await gitIn(rootNorm, ["clone", "--no-single-branch", url, dest], 300000);
      if (!r.ok) {
        return sendJson(res, 502, { error: String(r.err || r.out || "git clone failed").split("\n").slice(-4).join(" "), url, dest, tookMs: Date.now() - t0 });
      }
      log(`cloned ${url} -> ${dest} (${Date.now() - t0}ms)`);
      void registry
        .refresh()
        .then(() => broadcast({ type: "snapshot", data: snapshot() }))
        .catch(() => {});
      return sendJson(res, 200, { ok: true, url, dest, tookMs: Date.now() - t0 });
    }

    // Create a NEW local git project inside ONE of the configured scan roots — the second action in
    // the folder accordion's "+" row, beside the clone. Nothing is fetched, cloned or pushed: `git
    // init` on `main` plus ONE commit, because a repo with an unborn HEAD scans as NO BASE REF and
    // every spawn off it is refused until something is committed.
    if (route === "/api/project/new" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req);
      const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
      const rootNorm = norm(body.root);
      const roots = (config.scanRoots || []).map(norm).filter(Boolean);
      if (!rootNorm || !roots.some((r) => r.toLowerCase() === rootNorm.toLowerCase())) {
        return sendJson(res, 400, { error: `root must be one of scanRoots: ${rootNorm || "(none)"}` });
      }
      // ONE path segment with the same charset /api/clone accepts for a repo — no `owner/`, no
      // separators, no URL. A leading dot is refused too, which is what keeps `.` and `..` from
      // resolving the destination out of the scan root.
      const name = String(body.name || "").trim();
      if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith(".")) {
        return sendJson(res, 400, { error: `not a project name: ${name || "(none)"}` });
      }
      const dest = path.join(rootNorm, name);
      try {
        await stat(dest);
        return sendJson(res, 409, { error: `${dest} already exists`, dest });
      } catch {
        /* good: nothing there yet */
      }
      const t0 = Date.now();
      const made = await gitIn(rootNorm, ["init", "-q", "-b", "main", dest], 30000);
      if (!made.ok) {
        return sendJson(res, 502, { error: String(made.err || made.out || "git init failed").split("\n").slice(-4).join(" "), dest });
      }
      // ONE commit, written here rather than left to the reader: HEAD and refs/heads/main both have
      // to exist, or the board reads NO BASE REF and the project's first spawn is refused.
      try {
        await writeFile(path.join(dest, "README.md"), `# ${name}\n\nA new local git project, created from the panel's folder **+**.\n`, "utf8");
        await gitIn(dest, ["add", "README.md"], 15000);
        const args = ["commit", "-q", "--no-gpg-sign", "-m", `Initial commit — ${name}`];
        let commit = await gitIn(dest, args, 30000);
        if (!commit.ok && /tell me who you are|unable to auto-detect email|empty ident|Please tell me who/i.test(String(commit.err || commit.out || ""))) {
          // No identity on this machine: a local bot identity keeps the commit attributable instead
          // of failing on a prompt no one can answer (the /api/repo/first-commit fallback).
          commit = await gitIn(dest, ["-c", "user.name=Hermes Panel", "-c", "user.email=panel@localhost", ...args], 30000);
        }
        if (!commit.ok) throw new Error(String(commit.err || commit.out || "git commit failed").split("\n").slice(-4).join(" "));
      } catch (e) {
        // Never leave a half-made project behind: an inited folder with no commit is exactly the
        // NO BASE REF state this route exists to avoid, so it goes before the refusal does.
        await rm(dest, { recursive: true, force: true }).catch(() => {});
        return sendJson(res, 502, { error: `could not make the first commit: ${String(e.message || e)}`, dest });
      }
      const sha = String((await gitIn(dest, ["rev-parse", "--short", "HEAD"], 10000)).out || "").trim();
      log(`new project ${dest} on main (${sha}) — local only, nothing pushed`);
      void registry
        .refresh()
        .then(() => broadcast({ type: "snapshot", data: snapshot() }))
        .catch(() => {});
      return sendJson(res, 201, { ok: true, dest, branch: "main", sha, tookMs: Date.now() - t0 });
    }

    if (route === "/api/fetch" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      await readBody(req).catch(() => ({}));
      // Fire and forget: a sweep across every project is minutes of git work, and the button must not
      // hold the request open for it. Rows update over SSE as each fetch lands.
      void scheduler
        .fetchPass({ force: true })
        .then(() => scheduler.fullPass())
        .catch(() => {});
      return sendJson(res, 200, { ok: true, started: true });
    }

    if (route === "/api/reload" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      await readBody(req).catch(() => ({}));
      const canReuseBoot = bootPassCanSatisfyReload && (!bootPassFinishedAt || Date.now() - bootPassFinishedAt < 1500);
      bootPassCanSatisfyReload = false;
      const nextConfig = await loadConfig();
      if (canReuseBoot && JSON.stringify(nextConfig) === bootConfigJson) {
        await bootPass;
      } else {
        await bootPass;
        config = nextConfig;
        scheduler.stop();
        pool.close();
        pool = new Pool(config.threads);
        scheduler = new Scheduler({ config, store, pool, registry, getProjects: () => registry.projects, panelAgents: () => jobs.agentPaths(), panelThreads: () => jobs.panelRunThreads(), onWorktreeSeen: (project, tree) => seedTreeName(project, tree) });
        await registry.refresh();
        await scheduler.start();
      }
      void sweepCheckedLandings();
      void sweepReleases("reload").catch(() => {});
      broadcast({ type: "snapshot", data: snapshot() });
      return sendJson(res, 200, { ok: true, projects: config.projects.map((p) => p.name) });
    }

    // ---- restarting the gateway or this panel --------------------------------------------
    // An operator action, answerable from an assistant turn: the request returns at once and the action
    // runs only once the requesting turn has ended, because restarting the gateway synchronously kills
    // the very turn that asked for it. The preflight is synchronous, so a missing provider key is
    // refused here rather than discovered after the new process is up and every run is dying.
    if (route === "/api/restart" && req.method === "GET") {
      return sendJson(res, 200, restart.state());
    }

    if (route === "/api/restart" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      // The HTTP boundary refuses a null or missing reason, so no such entry can reach the queue and later be
      // written into restart.json as `"reason": null`. The controller refuses it too — this is the boundary half,
      // worded once in lib/restart.js so the two cannot drift.
      if (body.reason === null || body.reason === undefined || typeof body.reason !== "string" || !body.reason.trim()) {
        return sendJson(res, 400, { ok: false, error: REASON_REQUIRED, restart: restart.state() });
      }
      try {
        const record = restart.request({ target: body.target, reason: body.reason, waitFor: body.waitFor || body.thread });
        log(`restart queued: ${record.target} (${record.id}) — ${record.thread ? `it runs once ${record.thread} has no turn running` : "nothing was named to wait for, so it starts now"}`);
        return sendJson(res, 202, { ok: true, restart: record, provider: record.provider, assistant: assistant.state() });
      } catch (e) {
        return sendJson(res, Number(e.status) || 400, { ok: false, error: String((e && e.message) || e), restart: restart.state() });
      }
    }

    // A queued restart the reader has changed their mind about. Same page gate as the POST above, and the same
    // shape of answer: 200 with the queue that remains, or 404 when the id is not one this panel is holding. A
    // cancel is only ever about a WAIT — a restart already running answers 409 and is left alone.
    if (route === "/api/restart/cancel" && req.method === "POST") {
      if (!authorised(req, config.token)) return sendJson(res, 403, { error: "bad or missing x-panel-token" });
      const body = await readBody(req).catch(() => ({}));
      try {
        const dropped = restart.cancel(body.id || body.restartId);
        if (!dropped) {
          return sendJson(res, 404, { ok: false, error: `no queued restart with id ${String(body.id || body.restartId || "(none)")}`, restart: restart.state() });
        }
        log(`restart cancelled: ${dropped.target} (${dropped.id}) — it was still waiting, and it will not run`);
        return sendJson(res, 200, { ok: true, cancelled: { id: dropped.id, target: dropped.target }, queue: dropped.queue, restart: restart.state() });
      } catch (e) {
        return sendJson(res, Number(e.status) || 400, { ok: false, error: String((e && e.message) || e), restart: restart.state() });
      }
    }

    if (route === "/api/stream") return handleStream(req, res, { clients, snapshot });

    return serveStatic(req, res, route, build);
  } catch (e) {
    // The answer may already be on the wire (a static file half-written, an SSE client that died
    // mid-write). sendJson there throws ERR_HTTP_HEADERS_SENT *inside* the catch, which rejects the
    // async handler - an unhandled rejection from a routine client disconnect, and a possible exit.
    if (res.headersSent) {
      log(`${req.method} ${route} failed after the headers were sent: ${String((e && e.message) || e)}`);
      return res.destroy();
    }
    // A caller's mistake is one the handler named (HttpError). Everything else is a bug in this
    // process: 500 and a log line, instead of the 400 that used to make it invisible.
    const status = errorStatus(e);
    const detail = String((e && e.message) || e);
    if (status >= 500) log(`${req.method} ${route} failed (${status}): ${detail}${e?.stack ? `\n${e.stack}` : ""}`);
    return sendJson(res, status, { error: status >= 500 ? `the panel could not answer that: ${detail}` : detail });
  }
});

// ---- legacy trees get a parent, slowly ---------------------------------------------------------------------------
// A tree the panel did not cut has no record, so its parent is reconstructed (lib/parents.js): from the branch's own
// reflog when git still has the creation line, and from the ticket id in its name when it does not. That is git work
// per unresolved branch, it changes only when somebody branches or merges, and a reconstruction can never drive a
// write — so it runs on its own slow clock over the trees the board is actually showing, never on a scan tick, and
// never in the boot path (the board must come up before this).
let parentsWarmAt = 0;
async function warmParents() {
  if (Date.now() - parentsWarmAt < config.stewardRefreshSeconds * 1000) return;
  // A pass with nothing to look at must not spend the whole window: the first one fires 20 s in, and on a slow boot
  // discovery has not finished by then, so a pass that returned here after setting the clock left every legacy tree
  // reading "unknown" for the next five minutes. The configured projects are known at boot, so they are the fallback.
  const projects = (registry.projects?.length ? registry.projects : config.projects) || [];
  if (!projects.length) return;
  parentsWarmAt = Date.now();
  let learned = 0;
  let guessed = 0;
  for (const project of projects) {
    // The whole REPO, never the rows the board happens to be showing: this pass exists to fill in every legacy tree,
    // and a board that has only scanned the project's own checkout so far used to hand it [`master`] — one branch,
    // resolved, window spent, and every other tree still reading "unknown" five minutes later. `refresh()` starts from
    // the repo's own branch list anyway; what it skips cheaply is the branches it already has an answer for.
    try {
      const out = await parents.refresh({ project: project.name, repoDir: project.path, mainBranch: project.mainBranch });
      learned += out.learned || 0;
      guessed += parents.state(project.name).filter((r) => r.parentSource === "backfilled").length;
    } catch (e) {
      log(`parent backfill for ${project.name} failed: ${String((e && e.message) || e)}`);
    }
  }
  if (learned) log(`parents: ${learned} branch(es) resolved (${guessed} backfilled guess(es) in total — a guess never drives a write)`);
}
// ---- the CHECKING agent's answer, acted on -------------------------------------------------------------------
// A check run is read-only, so its answer is the whole product: on LANDED: YES the panel does the one thing that
// answer is for and moves the tree to the Recycle Bin, through the ✕'s own act (lib/worktree-remove.js) so the
// reader's lock, a live agent and the project's own checkout still refuse it. Every other word - PARTIAL, NO,
// SUPERSEDED, or no readable line at all - leaves the tree exactly where it is and the card says which word it read.
//
// A pass over the JOB STORE rather than a callback on the run that answered: a panel restarted between the answer and
// the delete still acts on it, and the store is what survives a restart. `checkedAnswers` keeps one answer to one
// delete per process, and lib/verify-landed.js bounds how old an answer may be before it is history rather than an
// instruction.
const checkedAnswers = new Set();
// Answers whose tree the board has not re-adopted yet. Not `acted`: the answer is still good, and the next tick may
// find the row. Only the one log line is deduped.
const pendingChecked = new Set();
let sweepingChecked = false;
async function sweepCheckedLandings() {
  if (sweepingChecked) return;
  sweepingChecked = true;
  try {
    // The summary `jobs.list()` hands back has no `finalMessage` (the card store drops it), so each candidate is
    // enriched from the LIVE job first: the answer is the last line of a message the completion payload may have
    // truncated from the start.
    const rows = jobs.list().map((s) => ({ ...s, finalMessage: jobs.get(s.id)?.finalMessage || s.completion?.final?.text || "" }));
    for (const { job, answer } of answeredChecks(rows, { acted: checkedAnswers })) {
      const live = jobs.get(job.id);
      const tree = job.ownerPath || job.cwd || "";
      const project = (tree && spawnFeature.projectForPath(tree)) || null;
      const row = project ? store.rowsFor(project.name).find((r) => normPathKey(r.path) === normPathKey(tree)) : null;
      const base = String(project?.mainBranch || "main");
      const say = (text) => {
        if (live) jobs.push(live, { kind: "raw", text });
      };
      if (!answerDeletes(answer)) {
        // PARTIAL, NO, SUPERSEDED: the answer has done its whole job (nothing was deleted) and is spent.
        checkedAnswers.add(job.id);
        say(answerLine(answer, { base }));
        log(`check ${job.id}: answered LANDED: ${answer.verdict} for ${row?.branch || tree || "(no tree)"} - nothing was deleted`);
        continue;
      }
      // The reader's own veto (Settings → Board → Agents clean up) outranks a check agent's YES. It is spent here
      // rather than held: an answer that said "landed" is not a standing instruction, so turning the switch back on
      // must never delete a tree the reader has been reading in the meantime.
      if (!agentCleanupFrom(config.agentCleanup)) {
        checkedAnswers.add(job.id);
        say(`panel: LANDED: ${answer.verdict} - nothing was deleted: agent cleanup is off in Settings → Board → Agents clean up, so this tree is yours to remove`);
        log(`check ${job.id}: LANDED: ${answer.verdict} for ${row?.branch || tree || "(no tree)"} - agent cleanup is off, so nothing was deleted`);
        continue;
      }
      // A YES is only spent when it is ACTED on. Until then the answer is still good and the next tick may find the
      // tree: the boot pass runs 6 s in, and a discovery pass over a loaded box takes longer than that, so `project`
      // (and then `row`) can both be null for a tree that is about to appear. Marking it acted first is what lost a
      // LANDED: YES for good — the sweep that was supposed to wait for the scan never looked at it again. The age
      // window in lib/verify-landed.js retires an answer whose tree never comes back, and the one log line says so.
      if (!project || !row) {
        if (!pendingChecked.has(job.id)) {
          pendingChecked.add(job.id);
          log(`check ${job.id}: LANDED: YES, but ${tree} is not on the board yet - waiting for the scan`);
        }
        continue;
      }
      checkedAnswers.add(job.id);
      const out = await deleteWorktreeRow({ project, row, target: row.path, jobs, locks, onLog: log });
      if (!out.ok) {
        say(answerLine(answer, { base, error: out.error }));
        log(`check ${job.id}: LANDED: YES for ${row.branch}, but ${row.path} was not deleted - ${out.error}`);
        continue;
      }
      store.dropRow(project.name, row.path);
      broadcast({ type: "drop", project: project.name, path: row.path });
      broadcast({ type: "snapshot", data: snapshot() });
      say(answerLine(answer, { base, deleted: true }));
      log(`check ${job.id}: LANDED: YES for ${row.branch} - removed ${row.path} (recycled: ${out.recycled ? "yes" : "no"})`);
    }
  } catch (e) {
    log(`checked-landing sweep failed: ${String((e && e.message) || e)}`);
  } finally {
    sweepingChecked = false;
  }
}
setInterval(() => void sweepCheckedLandings(), 10_000).unref?.();
// One pass shortly after boot, so an answer a restart interrupted is acted on without waiting for the first tick.
setTimeout(() => void sweepCheckedLandings(), 6_000).unref?.();

setInterval(() => void warmParents(), Math.max(30_000, config.stewardRefreshSeconds * 500));
// First pass 20s in: late enough that the board is up (the boot pass is local git only), early enough that a legacy
// tree stops reading "unknown" within one screen of the panel opening.
setTimeout(() => void warmParents(), 20_000).unref?.();

// The release executor's own clock (lib/worktrees.js, swept above). A request is normally acted on a couple of seconds
// after the turn that wrote it settles; this tick is for one that arrived while the panel was busy, and the boot pass
// for one a restart interrupted. Zero pending requests cost one pass over a Map and no subprocess at all.
setInterval(() => void sweepReleases("tick").catch(() => {}), 60_000).unref?.();
setTimeout(() => void sweepReleases("boot").catch(() => {}), 12_000).unref?.();

server.keepAliveTimeout = 60_000;
server.headersTimeout = 65_000;
// The same address and port held by anything else (the case the boot probe cannot see: a listener that came up in
// the moment since) is a refusal in words, not an unhandled 'error' event and a stack trace.
const onListenError = (e) => {
  if (e && e.code === "EADDRINUSE") {
    writeSync(1, `${new Date().toISOString().slice(11, 19)} ${refusalLine(config.host, config.port)} (EADDRINUSE)\n`);
    process.exit(1);
  }
  throw e;
};
server.once("error", onListenError);
server.listen(config.port, config.host, () => {
  server.off("error", onListenError);
  log(`agent-worktree-gui on http://${config.host}:${config.port}`);
  // The bridge's boot spawn (matrix.autoStart, on by default) — fired, never awaited: the panel must come up even
  // when the bridge cannot, and a failure is kept in state().boot for the Gateway tab instead of ending a
  // background promise in silence.
  void matrixBridge.autoStart().then((boot) => {
    if (boot && boot.note) log(`matrix bridge at boot: ${boot.note}`);
  }).catch((e) => log(`matrix bridge auto-start threw: ${String((e && e.message) || e)}`));
  log(`static build ${buildAtBoot.version || "(unversioned)"} — ${Object.keys(buildAtBoot.files).length} file(s) hashed; the shell is no-store, its assets carry ?v= and are cached hard`);
  // Binding off loopback is a deliberate act, so say out loud what it opens and whether the token that
  // guards it is there at all. Reads are still open to anyone who can reach the port.
  if (!["127.0.0.1", "localhost", "::1"].includes(String(config.host).toLowerCase())) {
    log(config.token
      ? "reachable off this machine: writes from other hosts need x-panel-token (the PANEL_TOKEN value; open the panel with ?token=… once); reads stay open"
      : "WARNING reachable off this machine with NO PANEL_TOKEN in the environment — writes from other hosts are refused until one is set");
  }
  log(`projects: ${config.projects.map((p) => p.name).join(", ") || "(none)"} | threads: ${config.threads} | fast ${config.worktreeSeconds}s / full ${config.slowSeconds}s`);
  log(`agent transport: ${jobs.api.url} (key ${jobs.api.key ? "loaded" : "MISSING"}) | default cwd ${config.defaultCwd}`);
  void jobs.probe({ fresh: true }).then(async (t) => {
    if (!t.reachable) {
      // The sentence says which failure this was: a probe that timed out is not a gateway that refused, and
      // "until the gateway is back" was a wrong sentence for a slow answer.
      log(`agent transport ${t.timedOut ? "SLOW" : "UNREACHABLE"}: ${gatewayRefusalText(t, jobs.api.url)} - spawns will be refused until it answers`);
      return; // nothing to ask: a restored turn stays live and pending, and the orphan sweep asks again
    }
    log(`agent transport ready: hermes ${t.capabilities?.version || "?"} · runs ${t.capabilities?.runs ? "yes" : "no"} · steer ${t.capabilities?.steer ? "yes" : "no"} · per-run cwd ${t.capabilities?.runCwd ? "advertised (a run's tools still start in the gateway's directory — measured 2026-10-27)" : "NO (stock gateway — agents run in the gateway's directory)"}`);
    // What the gateway did with the turns this panel lost in a restart. `load()` stamps them `interrupted`
    // without asking, and a run that finished in the meantime must not keep reading "may still be live".
    try {
      const settled = await jobs.reconcileRestored();
      if (settled.length) log(`reconciled ${settled.length} turn(s) a restart cut off: ${settled.join(", ")}`);
    } catch (e) {
      log(`reconcile of restored turns failed: ${String((e && e.message) || e)}`);
    }
    // The assistant's own turn: the boot check found it `running`, so only now — with the reconcile's answer in
    // hand — can a turn the gateway has lost be reported. One resume, and only for a settled `interrupted`.
    try {
      assistant?.resumeAfterRestart?.();
    } catch (e) {
      log(`assistant resume after the reconcile failed: ${String((e && e.message) || e)}`);
    }
    // ...and the runs the reconcile could not give back to a live card because the gateway answering now is
    // not the process that was issued them. A run lives in one process's memory: a card stamped with an older
    // gateway identity is a turn nobody here can watch, and one nobody has told the gateway to stop — nine of
    // those once held every concurrency slot with their session_turn_leases never released. A stop is asked for
    // on each (404/409 tolerated), after the reconcile, so nothing it re-attached is touched.
    try {
      const stopped = await jobs.stopStaleRuns();
      if (stopped.length) log(`asked the gateway to stop ${stopped.length} run(s) this panel inherited from an earlier gateway: ${stopped.map((a) => `${a.runId || a.jobId}${a.already ? " (already gone)" : a.ok ? "" : ` (failed: ${a.error})`}`).join(", ")}`);
    } catch (e) {
      log(`stopping the runs inherited from an earlier gateway failed: ${String((e && e.message) || e)}`);
    }
  });
});

// Seed the store from the last known project list BEFORE anything slow.
// `/api/state` with zero projects for the ~25s its first sweep takes, which the page renders as
// "No git repos found under scanRoots" — the board vanished and came back a minute later.
// When no project list is cached yet (first boot or a sandbox pointed at a throwaway scanRoot),
// discover first so the boot pass scans the repos under scanRoots instead of running an empty pass.
const hadSeededProjects = registry.projects.length > 0;
try {
  if (!hadSeededProjects && (config.scanRoots || []).length) {
    await registry.refresh().catch((e) => log(`project discovery failed: ${String((e && e.message) || e)}`));
  }
  for (const p of registry.projects) store.ensureProject(p);
  if (!config.defaultCwd) config.defaultCwd = registry.projects[0]?.path || process.cwd();
  await scheduler.start();
  // The stage timer's ticker (docs/pipelines.md §6): one interval for every waiting tree, started after the first
  // sweep so a boot that is still reading git does not also read a host. A wait registered before this restart is due
  // here too — it is in the tree book, not in the process.
  startPipelineWaitTicker();
  void sweepCheckedLandings();
  void sweepReleases("boot").catch(() => {});
  // The sweep that finds repos created since the last run is not a boot dependency when a cached project
  // list was already seeded: it runs behind the first scan pass, and new projects appear when it lands.
  if (hadSeededProjects) {
    void registry.refresh().catch((e) => log(`project discovery failed: ${String((e && e.message) || e)}`));
  }
} finally {
  bootPassFinishedAt = Date.now();
  resolveBootPass();
}

// The exit path, shared by a signal and a panel restart: the replacement has to be able to bind the
// port, so nothing waits on the SSE clients beyond the same two seconds this always allowed.
function shutdown(code = 0) {
  log(`shutting down (exit ${code})`);
  // Every helper this panel started dies with it, tree and all: a scan's git, a push's hook, a check agent's
  // helper. Before the pool and the listener go, so nothing is left writing into a tree that is about to be
  // released. `killAllSync` on `exit` is the backstop for an exit that never reaches here.
  try {
    const killed = panelChildren.killAll("the panel is shutting down");
    if (killed) log(`child processes killed on shutdown: ${killed}`);
  } catch (e) {
    log(`child process cleanup failed: ${String((e && e.message) || e)}`);
  }
  try {
    scheduler.stop();
  } catch {
    /* an already-stopped scheduler is not a failure */
  }
  stopPipelineWaitTicker();
  clearInterval(heartbeat);
  try {
    pool.close();
  } catch {
    /* ...nor is a closed pool */
  }
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 2000).unref?.();
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => shutdown(0));
}
// A path out of the process that never reaches shutdown() (a thrown boot, `process.exit` from a route): the
// registry gets one synchronous sweep so a helper cannot outlive the panel it was started for.
process.once("exit", () => {
  try {
    panelChildren.killAllSync("process exit");
  } catch {
    /* nothing may throw on the way out */
  }
});
if (process.env.PANEL_PARENT_WATCH_STDIN === "1") {
  process.stdin.resume();
  process.stdin.on("end", () => shutdown(0));
  process.stdin.on("close", () => shutdown(0));
  process.stdin.on("error", () => shutdown(0));
}
