// The settings prefix: the Settings panel's twenty-six answers, lifted out of server.js's if-chain.
//
// Step 8 of docs/reports/module-map-2026-11-08.html moves one route prefix at a time into routes/, mounted from the
// PREFIX_MOUNTS table. routes/assistant-queue.js and routes/assistant-delete.js were the two rows cut out of lib/
// modules; routes/state.js was the first lifted out of server.js's own chain, routes/jobs.js the second,
// routes/pipelines.js the third, and this is the fourth and last. The twenty-six blocks below stood in that chain, in
// three runs with other routes between them, and they stand here in the same order, with the same literals, the same
// status codes and the same body sentences.
//
//   GET  /api/settings/sessions           the CLI's list limit, and whether the installed patch reads it.
//   GET  /api/settings/skills             every root a SKILL.md is read from, and what the gateway serves.
//   GET  /api/settings/permissions        the five config.yaml blocks in force, each one's file:line, the gateway's
//                                         surface and this panel's remote-write layer.
//   POST /api/settings/sessions           {listLimit|limit} - the one Hermes setting the CLI's picker obeys.
//   GET  /api/settings/approvals          approvals.timeout, and whether this panel may write it.
//   POST /api/settings/approvals          {timeoutSeconds|timeout} - the window a parked approval waits.
//   GET  /api/settings/provider           the endpoint every run talks to; never the key itself.
//   POST /api/settings/provider           {baseUrl?, apiKey?, clearKey?} - config.yaml's model block.
//   GET  /api/settings/provider/profiles  the saved (URL, key) pairs; each key is "set" and its last four.
//   POST /api/settings/provider/profiles  {id?, name, baseUrl, apiKey?} - save or update one pair.
//   POST /api/settings/provider/profiles/delete  {id} - delete one pair, and the key it held.
//   POST /api/settings/provider/apply     {id} - write a saved pair through the same writer the rows use.
//   GET  /api/settings/matrix             the bridge's process state.
//   POST /api/settings/matrix             {scriptPath?, pythonPath?, roomId?, autoStart?} - the whitelisted block.
//   POST /api/settings/matrix/start       start the bridge process.
//   POST /api/settings/matrix/stop        stop it.
//   POST /api/settings/matrix/test        one --self-test, with the state beside it.
//   POST /api/settings/push-project       {project, kind, value} - one project's two push controls.
//   POST /api/settings/push-repo          {repo, kind?, value?, force?} - one repository's defaults and override.
//   POST /api/settings/scan               {mode} - refresh everything, or only what is on screen.
//   POST /api/settings/scan-roots         {roots} - the folders the board scans, as a whole list.
//   POST /api/settings/cleanup            {agentCleanup} - the board's veto on an agent releasing its own tree.
//   POST /api/settings/chart-top          {count} - how many trees a project's chart draws before its arrow.
//   POST /api/settings/collapse-after     {seconds} - how long a collapsed parent keeps its children's folds.
//   GET  /api/settings/prompt-budget    the prompt's sections, caps and the three turns the Prompt tab draws.
//   POST /api/settings/general            {threads?, worktreeSeconds?, briefingBudgetChars?} - the scan knobs.
//   POST /api/settings/columns            {hidden} - which of the chart's columns are not drawn.
//
// The seam is the live config and the composition root's own facts. `getConfig` is a FUNCTION rather than the object
// boot handed in, because these routes both read the config and write it back (`config.agentCleanup = allowed`) and
// POST /api/reload REPLACES the object: a captured copy would answer from the boot's values and then report a save
// that never reached the object the page reads. Everything else travels in beside it: `jobs` and `registry` for the
// gateway and the project list, `assistant` for the turn budget, `scheduler` for the scan mode and the row cadence,
// `matrixBridge` for the bridge's process, `broadcast` and `snapshot` for the repaint a save makes, `settingsOut` for
// the shape the page paints, `log`, `patchPanelConfig`, the two push setters, the scan-root readers, the two config
// normalisers, `rebuildPool` for the one live swap, and the two paths the Permissions read names. The transport
// helpers are the ones server.js imports from lib/http/respond.js; this module imports no HTTP layer and defines none
// of sendJson, readBody or authorised, so a test can drive a route with a recorder and the wire bytes are the ones
// lib/http/respond.js writes.
//
// Every path is an exact compare - the mount table's prefix test is only what decides whether this file is asked at
// all - and a path or method this file does not answer falls through (`return false`) to the rest of server.js's
// chain, which is where the unmatched method answered before the cut, so `PUT /api/settings/sessions` is still the
// chain's own 404 rather than a 405 invented here.

import path from "node:path";
import { PUSH_CHOICES } from "../lib/push-permissions.js";
import {
  approvalState, writeApprovalTimeout, APPROVAL_TIMEOUT_MIN, APPROVAL_TIMEOUT_MAX,
  sessionSettings, writeSessionListLimit, SESSION_LIST_MIN, SESSION_LIST_MAX,
  providerState, writeProviderSettings,
} from "../lib/hermes-config.js";
import { listProfiles, saveProfile, deleteProfile, profileWithKey } from "../lib/provider-profiles.js";
import { matrixBlock, matrixPatchFrom } from "../lib/matrix-bridge.js";
import { readSkillsIndex } from "../lib/skills.js";
import { readPermissions } from "../lib/gateway-permissions.js";
import { chartColumnsFrom } from "../lib/chart-columns.js";
// Where config.yaml and the skill roots live: the same function the CLI patch and the gateway client read, so the
// Permissions tab and the Skills tab report on the home a run actually uses rather than a guessed one.
import { hermesHome } from "../lib/jobs.js";
// The assistant pane's frame vocabulary: the same validator the config loader uses, so a save cannot put a frame
// into config.json that the next boot would refuse.
import { DOCK_MODES, pickDock } from "../lib/assistant/config.js";

/** The prefix every path below sits under, and the row the mount table in server.js matches on. */
export const SETTINGS_PATH = "/api/settings";

export function createSettingsRoutes({
  getConfig,
  jobs,
  registry,
  assistant,
  scheduler,
  matrixBridge,
  broadcast,
  snapshot,
  settingsOut,
  log,
  patchPanelConfig,
  pushKindOf,
  setProjectPushSetting,
  setRepoPushSetting,
  readScanRootsBody,
  scanRootsOut,
  applyScanRoots,
  chartTopCountFrom,
  collapseAfterSecondsFrom,
  rebuildPool,
  CONFIG_PATH,
  HERE,
  DEFAULT_SCAN_ROOT,
  sendJson,
  readBody,
  authorised,
} = {}) {
  // Every value below is a seam this module does not own, and a missing one is a boot-time error rather than a 500 on
  // the first Settings open. The name in the message is the one the composition root forgot.
  const functions = {
    getConfig, broadcast, snapshot, settingsOut, log, patchPanelConfig, pushKindOf, setProjectPushSetting,
    setRepoPushSetting, readScanRootsBody, scanRootsOut, applyScanRoots, chartTopCountFrom,
    collapseAfterSecondsFrom, rebuildPool, sendJson, readBody, authorised,
  };
  for (const [name, fn] of Object.entries(functions)) {
    if (typeof fn !== "function") throw new Error(`createSettingsRoutes needs ${name} from the composition root`);
  }
  const values = { jobs, registry, scheduler, assistant, matrixBridge, DEFAULT_SCAN_ROOT };
  for (const [name, value] of Object.entries(values)) {
    if (!value) throw new Error(`createSettingsRoutes needs ${name} from the composition root`);
  }

  return async function settingsRoutes(req, res, route) {
    // The LIVE config, asked for once per request: these routes read it and write it back (`config.agentCleanup =
    // allowed` after the file is written), and POST /api/reload REPLACES the object. A copy captured at boot would
    // answer from the boot's values and then report a save that never reached the object settingsOut() paints.
    const config = getConfig();

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
      sendJson(res, 200, await sessionSettings());
      return true;
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
      sendJson(
        res,
        200,
        await readSkillsIndex({
          home: hermesHome(),
          projects: registry.projects.map((p) => ({ name: p.name, path: p.path })),
          gateway: { url: jobs.api.url, key: jobs.api.key },
        }),
      );
      return true;
    }

    // ---- what permissions are in force, and where each one comes from ----------------------------
    // The Permissions tab's whole answer: the five config.yaml blocks the gateway actually reads
    // (parsed at request time, every row carrying its own file:line), the gateway's advertised
    // surface (a 401 is "not exposed, needs a token", never a guess at the features), and this
    // panel's remote-write layer — config.json's policy and lib/remote-writes.js's grants.
    // Read on demand, so the tab reports the file as it is now rather than a snapshot from boot.
    if (route === "/api/settings/permissions" && req.method === "GET") {
      sendJson(
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
      return true;
    }

    if (route === "/api/settings/sessions" && req.method === "POST") {
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      const body = await readBody(req);
      const state = await sessionSettings();
      if (!state.editable) {
        sendJson(res, 409, { ...state, error: state.reason || "not editable" });
        return true;
      }
      const limit = Number(body.listLimit ?? body.limit);
      if (!Number.isInteger(limit) || limit < SESSION_LIST_MIN || limit > SESSION_LIST_MAX) {
        sendJson(res, 400, {
          ...state,
          error: `the session list must be a whole number between ${SESSION_LIST_MIN} and ${SESSION_LIST_MAX}`,
        });
        return true;
      }
      try {
        writeSessionListLimit(limit);
      } catch (e) {
        sendJson(res, 500, { ...state, error: String((e && e.message) || e) });
        return true;
      }
      log(`sessions.list_limit = ${limit} written to ${state.configPath}`);
      sendJson(res, 200, {
        ...(await sessionSettings()),
        written: true,
        // The CLI reads config at start-up of each invocation, so the next /sessions uses it.
        note: "saved — the next hermes session's /sessions and /resume use it",
      });
      return true;
    }

    if (route === "/api/settings/approvals" && req.method === "GET") {
      sendJson(res, 200, approvalState({ gatewayUrl: jobs.api.url }));
      return true;
    }

    if (route === "/api/settings/approvals" && req.method === "POST") {
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      const body = await readBody(req);
      const state = approvalState({ gatewayUrl: jobs.api.url });
      if (!state.editable) {
        sendJson(res, 409, { ...state, error: state.reason || "not editable" });
        return true;
      }
      const seconds = Number(body.timeoutSeconds ?? body.timeout);
      if (!Number.isInteger(seconds) || seconds < APPROVAL_TIMEOUT_MIN || seconds > APPROVAL_TIMEOUT_MAX) {
        sendJson(res, 400, {
          ...state,
          error: `the approval window must be a whole number of seconds between ${APPROVAL_TIMEOUT_MIN} and ${APPROVAL_TIMEOUT_MAX}`,
        });
        return true;
      }
      try {
        writeApprovalTimeout(seconds);
      } catch (e) {
        sendJson(res, 500, { ...state, error: String((e && e.message) || e) });
        return true;
      }
      log(`approvals.timeout = ${seconds}s written to ${state.configPath}`);
      sendJson(res, 200, {
        ...approvalState({ gatewayUrl: jobs.api.url }),
        written: true,
        // Hermes re-reads config.yaml when the file signature changes and reads this per request,
        // so the next prompt uses the new window without restarting the gateway.
        note: "saved",
      });
      return true;
    }

    // The provider endpoint every run talks to: OpenRouter's URL and the key it authenticates with. The
    // key itself never leaves this process - GET reports whether one is set, where it came from and its
    // last four characters; POST writes into config.yaml's model block (the file the gateway re-reads).
    if (route === "/api/settings/provider" && req.method === "GET") {
      sendJson(res, 200, providerState());
      return true;
    }

    if (route === "/api/settings/provider" && req.method === "POST") {
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      const body = await readBody(req).catch(() => ({}));
      const state = providerState();
      if (!state.editable) {
        sendJson(res, 409, { ...state, error: state.reason || "not editable" });
        return true;
      }
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
        sendJson(res, 200, {
          ...providerState(),
          written: true,
          note: "saved — the next run uses it; a run already in flight keeps the endpoint and key it started with",
        });
        return true;
      } catch (e) {
        sendJson(res, 400, { ...providerState(), error: String((e && e.message) || e) });
        return true;
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
      sendJson(res, 200, listProfiles({ file: profilesFile }));
      return true;
    }

    if (route === "/api/settings/provider/profiles" && req.method === "POST") {
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      const body = await readBody(req).catch(() => ({}));
      try {
        const saved = saveProfile({ file: profilesFile, id: body.id || null, name: body.name, baseUrl: body.baseUrl, apiKey: body.apiKey });
        log(`provider profile ${saved.created ? "saved" : "updated"}: "${saved.profile.name}" (${saved.profile.baseUrl}) in ${profilesFile}`);
        sendJson(res, 200, {
          ...listProfiles({ file: profilesFile }),
          saved: saved.profile,
          note: saved.created
            ? `profile "${saved.profile.name}" saved — its key stays in the panel's own state folder, never in the repository`
            : `profile "${saved.profile.name}" updated${body.apiKey ? "" : " — the stored key was kept because the key box was empty"}`,
        });
        return true;
      } catch (e) {
        sendJson(res, Number(e.status) || 400, { ...listProfiles({ file: profilesFile }), error: String((e && e.message) || e) });
        return true;
      }
    }

    if (route === "/api/settings/provider/profiles/delete" && req.method === "POST") {
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      const body = await readBody(req).catch(() => ({}));
      try {
        const dropped = deleteProfile({ file: profilesFile, id: body.id });
        if (!dropped) {
          sendJson(res, 404, { ...listProfiles({ file: profilesFile }), error: `no profile with id ${String(body.id || "(none)")}` });
          return true;
        }
        log(`provider profile deleted: "${dropped.removed.name}" — its stored key was removed with it, from ${profilesFile}`);
        sendJson(res, 200, {
          ...listProfiles({ file: profilesFile }),
          removed: dropped.removed,
          note: `profile "${dropped.removed.name}" deleted, and the key it held with it`,
        });
        return true;
      } catch (e) {
        sendJson(res, Number(e.status) || 400, { ...listProfiles({ file: profilesFile }), error: String((e && e.message) || e) });
        return true;
      }
    }

    // Apply writes the chosen pair through the SAME function the URL/key rows use, so there is one writer of
    // model.base_url and model.api_key in this process and one set of checks on the way in.
    if (route === "/api/settings/provider/apply" && req.method === "POST") {
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      const body = await readBody(req).catch(() => ({}));
      const state = providerState();
      if (!state.editable) {
        sendJson(res, 409, { ...state, error: state.reason || "not editable" });
        return true;
      }
      const profile = profileWithKey({ file: profilesFile, id: body.id });
      if (!profile) {
        sendJson(res, 404, { ...providerState(), error: `no saved profile with id ${String(body.id || "(none)")}` });
        return true;
      }
      if (!profile.apiKey) {
        sendJson(res, 400, { ...providerState(), error: `profile "${profile.name}" holds no key — open it and press Edit with a key in the box` });
        return true;
      }
      try {
        const wrote = writeProviderSettings({ baseUrl: profile.baseUrl, apiKey: profile.apiKey });
        log(`provider profile applied: "${profile.name}" (${profile.baseUrl}) -> ${wrote.configPath}`);
        sendJson(res, 200, {
          ...providerState(),
          applied: { id: profile.id, name: profile.name, baseUrl: profile.baseUrl },
          written: true,
          note: `profile "${profile.name}" applied — the next run uses it; a run already in flight keeps the endpoint and key it started with`,
        });
        return true;
      } catch (e) {
        sendJson(res, 400, { ...providerState(), error: String((e && e.message) || e) });
        return true;
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
      sendJson(res, 200, matrixBridge.state());
      return true;
    }

    // The four fields beside Start/Stop write through here. It accepts ONLY the keys lib/matrix-bridge.js names
    // (scriptPath, pythonPath, roomId, autoStart) and writes ONLY those into config.json's `matrix` block — a
    // `password` in the body is ignored and has nowhere to reappear, because the answer is the GET shape and the
    // written block is the whitelist. An empty roomId is saved as "no room set": start and self-test refuse loudly
    // rather than launching the bridge into nothing.
    if (route === "/api/settings/matrix" && req.method === "POST") {
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      const body = await readBody(req).catch(() => ({}));
      const { values, error } = matrixPatchFrom(body);
      if (error) {
        sendJson(res, 400, { ...matrixBridge.state(), error });
        return true;
      }
      const next = matrixBlock(config.matrix, values);
      try {
        await patchPanelConfig({ matrix: next });
      } catch (e) {
        sendJson(res, 500, { ...matrixBridge.state(), error: `could not write config.json: ${String((e && e.message) || e)}` });
        return true;
      }
      // The running panel answers from the same object the file now holds: a GET straight after the save reads the
      // new room, and the next boot spawn uses it too.
      config.matrix = next;
      log(`matrix bridge settings saved: script ${next.scriptPath || "(none)"} | interpreter ${next.pythonPath || "(none)"} | room ${next.roomId || "(none)"} | auto-start ${next.autoStart ? "on" : "off"}`);
      sendJson(res, 200, {
        ...matrixBridge.state(),
        note: `saved — ${next.roomId ? `room ${next.roomId}` : "no room set, so Start and Run self-test will refuse"} · auto-start ${next.autoStart ? "on" : "off"}`,
      });
      return true;
    }

    if (route === "/api/settings/matrix/start" && req.method === "POST") {
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      const out = await matrixBridge.start();
      const { status, ...body } = out;
      sendJson(res, Number(status) || 200, body);
      return true;
    }

    if (route === "/api/settings/matrix/stop" && req.method === "POST") {
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      const out = await matrixBridge.stop();
      const { status, ...body } = out;
      sendJson(res, Number(status) || 200, body);
      return true;
    }

    if (route === "/api/settings/matrix/test" && req.method === "POST") {
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      // The self-test's own answer is the `ok`/`output`/`exitCode` triple the bridge defines; the state rides
      // along so the page can repaint the dot and the log from one response.
      const result = await matrixBridge.selfTest();
      sendJson(res, 200, { ...matrixBridge.state(), ...result });
      return true;
    }

    // ONE PROJECT'S TWO CONTROLS. The card's selects and the Settings → Repo tab both write here, one kind at a
    // time. The value must be one of the four — anything else is a 400 rather than a guess — and a project under a
    // repo force-override is a 409 naming the repository, because that select is rendered disabled and a hand-written
    // request must not slip past the same rule the page shows.
    if (route === "/api/settings/push-project" && req.method === "POST") {
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      const body = await readBody(req).catch(() => ({}));
      const name = String(body.project || "").trim();
      const kind = pushKindOf(body.kind);
      if (!kind) {
        sendJson(res, 400, { error: "kind must be new or existing", settings: settingsOut() });
        return true;
      }
      if (!PUSH_CHOICES.includes(String(body.value || "").trim().toLowerCase())) {
        sendJson(res, 400, { error: `value must be one of: ${PUSH_CHOICES.join(", ")}`, settings: settingsOut() });
        return true;
      }
      const out = await setProjectPushSetting(name, { [kind]: body.value }, { by: "the project card" });
      if (out.error) {
        sendJson(res, out.status || 500, { error: out.error, settings: settingsOut() });
        return true;
      }
      sendJson(res, 200, { ok: true, project: name, resolved: out.resolved, settings: settingsOut(), note: `saved — ${name}: ${kind === "newBranches" ? "new" : "existing"} branches ${out.resolved[kind]}` });
      return true;
    }

    // ONE REMOTE REPOSITORY'S DEFAULTS (and its force-override). A repo section edits BOTH controls and the toggle
    // through this route, because they are one record in config.json and two writers would be two chances to lose a
    // key. The answer carries the settings again so every open tab repaints from the server's copy.
    if (route === "/api/settings/push-repo" && req.method === "POST") {
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      const body = await readBody(req).catch(() => ({}));
      const repo = String(body.repo || "").trim();
      const patch = {};
      if (body.kind !== undefined || body.value !== undefined) {
        const kind = pushKindOf(body.kind);
        if (!kind) {
          sendJson(res, 400, { error: "kind must be new or existing", settings: settingsOut() });
          return true;
        }
        if (!PUSH_CHOICES.includes(String(body.value || "").trim().toLowerCase())) {
          sendJson(res, 400, { error: `value must be one of: ${PUSH_CHOICES.join(", ")}`, settings: settingsOut() });
          return true;
        }
        patch[kind] = body.value;
      }
      if (body.force !== undefined) {
        if (typeof body.force !== "boolean") {
          sendJson(res, 400, { error: "force must be true or false", settings: settingsOut() });
          return true;
        }
        patch.force = body.force;
      }
      if (!Object.keys(patch).length) {
        sendJson(res, 400, { error: "nothing to save: send kind+value, force, or both", settings: settingsOut() });
        return true;
      }
      const out = await setRepoPushSetting(repo, patch, { by: "the Settings → Repo tab" });
      if (out.error) {
        sendJson(res, out.status || 500, { error: out.error, settings: settingsOut() });
        return true;
      }
      sendJson(res, 200, { ok: true, repo, record: out.record, settings: settingsOut(), note: `${repo}: ${out.record.force ? "force-override ON — this repository's values win for every project in it" : "each project's own values win"}` });
      return true;
    }

    // Refresh everything, or only what is on screen. Server-side: the scans happen here, so the choice has to
    // outlive a tab and apply to whichever browser is open.
    if (route === "/api/settings/scan" && req.method === "POST") {
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      const body = await readBody(req).catch(() => ({}));
      const mode = String(body.mode || "").toLowerCase() === "visible" ? "visible" : "all";
      try {
        await patchPanelConfig({ scanMode: mode });
      } catch (e) {
        sendJson(res, 500, { error: `could not write config.json: ${String((e && e.message) || e)}` });
        return true;
      }
      config.scanMode = mode;
      scheduler.cfg.scanMode = mode;
      // Switching back to "all" must not wait for the visibility heartbeat to lapse.
      if (mode === "all") scheduler.noteVisible(null);
      log(`scan mode: ${mode}`);
      broadcast({ type: "snapshot", data: snapshot() });
      sendJson(res, 200, { ok: true, mode, settings: settingsOut() });
      return true;
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
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      const body = await readBody(req).catch(() => ({}));
      const checked = await readScanRootsBody(body);
      if (checked.error) {
        sendJson(res, 400, { error: checked.error, ...(await scanRootsOut()) });
        return true;
      }
      try {
        await patchPanelConfig({ scanRoots: checked.roots });
      } catch (e) {
        sendJson(res, 500, { error: `could not write config.json: ${String((e && e.message) || e)}`, ...(await scanRootsOut()) });
        return true;
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
      sendJson(res, 200, { ok: true, projects, ...(await scanRootsOut()) });
      return true;
    }

    // Whether an agent may take its own tree off this disk once the work has landed: Settings → Board → Agents
    // clean up. Server-side like the two rows above, because this process is what hands out the RELEASE paragraph
    // and what sweeps the release executor — so the switch has to outlive a tab and apply to every browser.
    //
    // It is a VETO: on leaves each project's own `releaseWorktrees` grant deciding, so pressing it on never opens a
    // delete; off closes every project at once. Only a literal boolean in the body is written — a body that names
    // no `agentCleanup` writes OFF, because a delete permission that is assumed is not one.
    if (route === "/api/settings/cleanup" && req.method === "POST") {
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      const body = await readBody(req).catch(() => ({}));
      const allowed = body.agentCleanup === true;
      try {
        await patchPanelConfig({ agentCleanup: allowed });
      } catch (e) {
        sendJson(res, 500, { error: `could not write config.json: ${String((e && e.message) || e)}` });
        return true;
      }
      config.agentCleanup = allowed;
      log(`agent cleanup: ${allowed ? "on — a project's own releaseWorktrees grant decides" : "off — no worktree is removed automatically"}`);
      broadcast({ type: "settings", settings: settingsOut() });
      sendJson(res, 200, { ok: true, agentCleanup: allowed, settings: settingsOut() });
      return true;
    }

    // How many worktrees a project's chart draws before its arrow lists the rest, so the board can open on the top
    // of each chart. Server-side for the same reason the refresh mode is: the number goes into this panel's own
    // config.json, so it survives a restart and applies to whichever browser is open — and it is the config.json the
    // reader edits by hand. `count: 0` draws every tree.
    if (route === "/api/settings/chart-top" && req.method === "POST") {
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      const body = await readBody(req).catch(() => ({}));
      const count = chartTopCountFrom(body.count);
      try {
        await patchPanelConfig({ chartTopCount: count });
      } catch (e) {
        sendJson(res, 500, { error: `could not write config.json: ${String((e && e.message) || e)}` });
        return true;
      }
      config.chartTopCount = count;
      log(`chart: ${count ? `the top ${count} worktree${count === 1 ? "" : "s"} drawn (the chart's arrow shows the rest)` : "every worktree drawn"}`);
      broadcast({ type: "snapshot", data: snapshot() });
      sendJson(res, 200, { ok: true, count, settings: settingsOut() });
      return true;
    }

    // How long a parent the reader collapsed keeps the cards under it as they were before the page writes every one
    // of them into its remembered fold set. Server-side like the age threshold above: the number goes into this
    // panel's own config.json, so it survives a restart and applies to whichever browser is open. `seconds: 0`
    // disables the cascade — a collapsed parent then leaves its children's folds alone, which is what the panel did
    // before this row existed.
    if (route === "/api/settings/collapse-after" && req.method === "POST") {
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      const body = await readBody(req).catch(() => ({}));
      const seconds = collapseAfterSecondsFrom(body.seconds);
      try {
        await patchPanelConfig({ collapseAfterSeconds: seconds });
      } catch (e) {
        sendJson(res, 500, { error: `could not write config.json: ${String((e && e.message) || e)}` });
        return true;
      }
      config.collapseAfterSeconds = seconds;
      log(`collapse cascade: ${seconds ? `a parent collapsed for ${seconds}s minimizes every card under it` : "off — a collapsed parent leaves its cards as they are"}`);
      broadcast({ type: "settings", settings: settingsOut() });
      sendJson(res, 200, { ok: true, seconds, settings: settingsOut() });
      return true;
    }

    // ---- the prompt's own budget, for the Prompt tab ------------------------------------------
    // Read on demand: it measures the assistant's NEXT turn, so the answer is stale the moment a rule,
    // a note, a watch, a project or the charter changes. `promptBudget()` is READ-ONLY - it does not
    // advance the charter's send record or the board's sweep tick - so opening the tab cannot make the
    // next real turn a marker for text nobody was sent. The caps and the section table live in
    // lib/assistant/prompt-budget.js, which the briefing builder itself imports.
    if (route === "/api/settings/prompt-budget" && req.method === "GET") {
      try {
        sendJson(res, 200, assistant.promptBudget());
      } catch (err) {
        sendJson(res, 500, { error: `the prompt budget could not be measured: ${(err && err.message) || String(err)}` });
      }
      return true;
    }

    // ---- Settings → General: what the panel costs the machine -------------------------------------
    // Three numbers that were config.json-only until now, and one route for all three because they are one
    // surface: how many git scans run at once (`threads`), how often a row is re-read (`worktreeSeconds`), and the
    // ceiling on what one assistant turn appends (`briefingBudgetChars`, stored on the assistant, not here). The
    // fourth field is not a number: `dockMode` is the assistant pane's frame, one choice for every assistant, which
    // became the panel's when it moved out of each assistant's own Settings pane.
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
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
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
      // THE PANE'S FRAME, one choice for every assistant's pane. `pickDock(value, null)` is the validator: anything
      // that is not one of the two modes is refused here, by name, rather than written and read back as a default.
      const dockAsked = body.dockMode !== undefined;
      const dockMode = dockAsked ? pickDock(body.dockMode, null) : config.dockMode;
      if (threads === null) {
        sendJson(res, 400, { error: "scan workers must be a whole number from 1 to 16" });
        return true;
      }
      if (worktreeSeconds === null) {
        sendJson(res, 400, { error: "row refresh must be a whole number of seconds from 5 to 120" });
        return true;
      }
      if (dockAsked && dockMode === null) {
        sendJson(res, 400, { error: `the assistant pane must be ${DOCK_MODES.join(" or ")}` });
        return true;
      }
      if (body.briefingBudgetChars !== undefined && budget === null) {
        sendJson(res, 400, { error: "the turn briefing budget must be a whole number of characters from 0 (off) to 40000" });
        return true;
      }
      const patch = {};
      if (threads !== config.threads) patch.threads = threads;
      if (worktreeSeconds !== config.worktreeSeconds) patch.worktreeSeconds = worktreeSeconds;
      if (dockAsked && dockMode !== config.dockMode) patch.dockMode = dockMode;
      if (Object.keys(patch).length) {
        try {
          await patchPanelConfig(patch);
        } catch (e) {
          sendJson(res, 500, { error: `could not write config.json: ${String((e && e.message) || e)}` });
          return true;
        }
      }
      if (patch.worktreeSeconds !== undefined) {
        config.worktreeSeconds = worktreeSeconds;
        if (scheduler && scheduler.cfg) scheduler.cfg.worktreeSeconds = worktreeSeconds;
        log(`row refresh: every ${worktreeSeconds}s`);
      }
      if (patch.threads !== undefined) {
        config.threads = threads;
        // The swap is the composition root's: `pool` is a binding in server.js and the scheduler holds its
        // reference, so this route asks for it by name. RETIRE, never close: the save runs while the fleet is being
        // scanned, and `close()` would terminate workers mid-scan.
        rebuildPool(threads);
        log(`scan workers: ${threads} (the pool was rebuilt live; the old one retires when its scans settle)`);
      }
      if (patch.dockMode !== undefined) {
        config.dockMode = dockMode;
        // THE PER-ASSISTANT KEY IS RETIRED IN THE SAME BREATH. A second copy of a panel-wide choice is a value that
        // can disagree with the panel — the thing this move exists to end — so every assistant's file loses the
        // `dock` key as soon as the panel's own key exists. `from` is the assistant the PAGE was showing, which is
        // the value the one-time migration adopted; it is not a write, only the name in the log line.
        const dropped = assistant.retireDockField();
        const cameFrom = assistant.assistants.find((a) => a.id === String(body.from || "")) || null;
        log(
          `pane frame: ${dockMode} — the panel's one frame${cameFrom ? `, taken from ${cameFrom.name} (the assistant the panel was showing)` : ""}${
            dropped.length ? `; ${dropped.length} per-assistant value${dropped.length === 1 ? "" : "s"} retired` : ""
          }`,
        );
      }
      let settings = settingsOut();
      if (budget !== null) {
        try {
          const saved = assistant.setSettingsFor(undefined, { briefingBudgetChars: budget });
          settings = { ...settings, briefingBudgetChars: saved.briefingBudgetChars };
          log(`turn briefing budget: ${budget ? `${budget} chars` : "off — a turn is sent whole"}`);
        } catch (e) {
          sendJson(res, 400, { error: String((e && e.message) || e) });
          return true;
        }
      }
      broadcast({ type: "settings", settings: settingsOut() });
      sendJson(res, 200, { ok: true, settings });
      return true;
    }

    // Which of the worktree chart's columns are drawn. Server-side like the age threshold above: the list goes into
    // this panel's own config.json, so it survives a restart and applies to whichever browser is open. The body names
    // the columns to HIDE, not the ones to show, so a column added to the chart later arrives visible for every
    // reader; lib/chart-columns.js is the one place that decides which ids are real.
    if (route === "/api/settings/columns" && req.method === "POST") {
      if (!authorised(req, config.token)) {
        sendJson(res, 403, { error: "bad or missing x-panel-token" });
        return true;
      }
      const body = await readBody(req).catch(() => ({}));
      const hidden = chartColumnsFrom(body.hidden);
      try {
        await patchPanelConfig({ hiddenColumns: hidden });
      } catch (e) {
        sendJson(res, 500, { error: `could not write config.json: ${String((e && e.message) || e)}` });
        return true;
      }
      config.hiddenColumns = hidden;
      log(`chart columns: ${hidden.length ? `${hidden.join(", ")} hidden` : "all drawn"}`);
      // `settings`, not a snapshot: the page has to rebuild the tables (a hidden column is a missing cell in every
      // row), and that is what the settings handler does for every open tab.
      broadcast({ type: "settings", settings: settingsOut() });
      sendJson(res, 200, { ok: true, hidden, settings: settingsOut() });
      return true;
    }

    // A path or method this file does not answer is not its own: `false` hands the request back to the rest of
    // server.js's chain, which is where it was answered before the cut.
    return false;
  };
}
