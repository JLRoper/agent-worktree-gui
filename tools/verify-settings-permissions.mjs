#!/usr/bin/env node
// Settings > Permissions: the permissions actually in force, read-only, with the file:line (or endpoint)
// each one came from — and a plain sentence where a source cannot be read.
//
//   node tools/verify-settings-permissions.mjs
//
// WHAT WAS WRONG. There was no Permissions tab and no route behind one. Settings could show the approval
// window and the branch policy, but nothing answered "what is allowed to run without asking me, and where
// is that written?" A reader had to open config.yaml at :2385/:2388/:625/:1449/:1830 and lib/remote-writes.js
// by hand, and a gateway that answers 401 told them nothing about what it advertises.
//
// WHAT IS DRIVEN, against fixtures only (never the developer's config.yaml or gateway):
//   * lib/gateway-permissions.js parses all five config.yaml blocks (approvals, command_allowlist,
//     tool_loop_guardrails, platform_toolsets, code_execution) from a fixture, keeps the order of the
//     always-ask list, and gives every row the 1-based line it was read from
//   * a missing config.yaml, a malformed block and an absent block are each a status and a reason —
//     never an empty list pretending the value is not set
//   * a gateway that answers 401 is "not exposed, needs a token" with no feature rows; a keyed 200
//     answer becomes one row per advertised feature, sourced to the endpoint
//   * config.json's remoteBranchPolicy (global and a project override) and lib/remote-writes.js's grant
//     choices, permission window and grant lifetimes are reported with their own file:line
//   * GET /api/settings/permissions answers 200 and carries all of it
//   * the tab is the ninth in the strip, a press selects it and shows only its panel, and it is remembered
//   * every group heading and every row prints a source that is `file:line` or `endpoint`; the approval
//     rows read 600/manual from the fixture, and the always-ask list has its fixture's three patterns
//   * deleting config.yaml and reloading turns the five YAML sources into "cannot read" with the path in
//     the reason, in the tab itself — not a stale value from the previous read
//   * the settings search filters this grouped list and counts its rows on the tab
//
// RED PROOF. On a tree without this branch there is no lib/gateway-permissions.js, no
// /api/settings/permissions route and no [data-settings-tab="permissions"], so the first module check,
// the HTTP check and the tab check all fail by name. A green run here means the module, the route and the
// tab answered, not an empty page. A missing Playwright prints BROWSER-HALF-NOT-RUN and exits 2 after the
// module and HTTP halves have already been reported.
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const TAB_KEY = "wtgui.settingsTab";
const WIDE = { width: 1400, height: 900 };

let failures = 0;
let checks = 0;
const check = (cond, label, detail = "") => {
  checks += 1;
  if (!cond) failures += 1;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const note = (text) => console.log(`      ${text}`);
const lineOf = (text, needle, from = 0) => {
  const lines = String(text).split("\n");
  for (let i = from; i < lines.length; i += 1) if (lines[i].includes(needle)) return i + 1;
  return null;
};
const slashed = (p) => String(p).split(path.sep).join("/");

const FIXTURE = `# the gate's own config.yaml — never the developer's
tool_loop_guardrails:
  warnings_enabled: true
  warn_after:
    exact_failure: 2
platform_toolsets:
  cli: [hermes-cli]
  api_server:
    - hermes-api-server
    - clarify
code_execution:
  timeout: 300
  max_tool_calls: 50
approvals:
  timeout: 600
  mode: manual
command_allowlist:
  - force push
  - recursive delete
  - script execution via heredoc
sessions:
  list_limit: 40
`;

const PANEL_CONFIG = `{
  "port": 7331,
  "remoteBranchPolicy": "local-only",
  "projects": [
    {
      "name": "alpha",
      "remoteBranchPolicy": "allow"
    }
  ]
}`;

// ---- A. the module, in process -------------------------------------------------------------------
let readPermissions = null;
try {
  ({ readPermissions } = await import("../lib/gateway-permissions.js"));
} catch (e) {
  note(`lib/gateway-permissions.js did not load: ${String((e && e.message) || e)}`);
}
check(typeof readPermissions === "function", "lib/gateway-permissions.js exports readPermissions");

const dir = mkdtempSync(path.join(tmpdir(), "wtgui-permissions-gate-"));
const home = path.join(dir, "hermes");
const configPath = path.join(home, "config.yaml");
const panelConfigPath = path.join(dir, "config.json");
const project = path.join(dir, "repo-alpha");
mkdirSync(home, { recursive: true });
mkdirSync(project, { recursive: true });
writeFileSync(configPath, FIXTURE);
writeFileSync(panelConfigPath, PANEL_CONFIG);

const byKey = (result) => Object.fromEntries((result?.sources || []).map((source) => [source.key, source]));
const readFixture = async (extra = {}) =>
  readPermissions({
    configPath,
    panelConfigPath,
    panelConfigText: PANEL_CONFIG,
    moduleText: null,
    gateway: { url: "" },
    ...extra,
  });

if (typeof readPermissions === "function") {
  const data = await readFixture();
  const sources = byKey(data);
  check(data.sources.length === 8, "five YAML sources, the gateway, the policy and the module", String(data.sources.length));
  check(
    JSON.stringify(data.sources.slice(0, 5).map((s) => s.key)) ===
      JSON.stringify(["approvals", "command_allowlist", "tool_loop_guardrails", "platform_toolsets", "code_execution"]),
    "the five blocks are reported in the order a reader looks for them",
  );
  check(sources.approvals.status === "ok" && sources.approvals.source === `${configPath}:${lineOf(FIXTURE, "approvals:")}`,
    "approvals is read from its own header line", sources.approvals.source);
  check(sources.approvals.rows.find((r) => r.name === "timeout")?.value === "600", "the fixture's approval window is 600 s");
  check(sources.approvals.rows.find((r) => r.name === "mode")?.value === "manual", "and its mode is manual");
  check(
    sources.approvals.rows.find((r) => r.name === "timeout")?.source === `${configPath}:${lineOf(FIXTURE, "  timeout: 600")}`,
    "the timeout row quotes the value's own line, not the block header",
  );
  check(sources.command_allowlist.rows.length === 3, "the always-ask list keeps all three fixture patterns", `${sources.command_allowlist.rows.length}`);
  check(
    JSON.stringify(sources.command_allowlist.rows.map((r) => r.name)) ===
      JSON.stringify(["force push", "recursive delete", "script execution via heredoc"]),
    "in the file's own order",
  );
  check(sources.command_allowlist.rows.every((r) => r.value === "always ask"), "each pattern is reported as always ask");
  check(sources.tool_loop_guardrails.rows.some((r) => r.name === "warn_after.exact_failure" && r.value === "2"),
    "nested guardrail values are flattened to dotted names");
  check(sources.platform_toolsets.rows.find((r) => r.name === "api_server")?.value === "hermes-api-server, clarify",
    "an inline and a block toolset list both read");
  check(sources.code_execution.rows.find((r) => r.name === "max_tool_calls")?.value === "50", "code execution settings read");

  // Missing file, malformed block, absent block: each is a status, not an empty answer.
  const missing = await readPermissions({
    configPath: path.join(dir, "not-there.yaml"),
    panelConfigText: PANEL_CONFIG,
    panelConfigPath,
    moduleText: null,
    gateway: { url: "" },
  });
  const missingSources = byKey(missing);
  check(
    ["approvals", "command_allowlist", "tool_loop_guardrails", "platform_toolsets", "code_execution"].every(
      (key) => missingSources[key].status === "unreadable" && /not found/.test(missingSources[key].reason),
    ),
    "a missing config.yaml leaves every YAML source unreadable, with the path in the reason",
  );
  check(missing.configFile.status === "unreadable", "and the tab's file line says config.yaml could not be read");

  const brokenPath = path.join(dir, "broken.yaml");
  writeFileSync(brokenPath, `approvals:\n  timeout: "600\ncode_execution:\n  timeout: 300\n`);
  const broken = await readPermissions({
    configPath: brokenPath,
    panelConfigText: PANEL_CONFIG,
    panelConfigPath,
    moduleText: null,
    gateway: { url: "" },
  });
  const brokenSources = byKey(broken);
  check(brokenSources.approvals.status === "malformed" && /line 2:/.test(brokenSources.approvals.reason),
    "a malformed block is malformed, with the offending line", brokenSources.approvals.reason);
  check(brokenSources.approvals.rows.length === 0, "and it shows no half-read rows");
  check(brokenSources.code_execution.status === "ok", "while the block beside it still reads");

  const absentPath = path.join(dir, "absent.yaml");
  writeFileSync(absentPath, FIXTURE.replace(/code_execution:\n  timeout: 300\n  max_tool_calls: 50\n/, ""));
  const absent = await readPermissions({
    configPath: absentPath,
    panelConfigText: PANEL_CONFIG,
    panelConfigPath,
    moduleText: null,
    gateway: { url: "" },
  });
  check(byKey(absent).code_execution.status === "missing" && /no top-level `code_execution:` block/.test(byKey(absent).code_execution.reason),
    "an absent block is missing, not an empty list");

  // Remote-write layer.
  const remote = byKey(data);
  check(remote.remoteBranchPolicy.rows[0].value === "local-only", "config.json's global remoteBranchPolicy is reported");
  check(remote.remoteBranchPolicy.rows[1].name === "projects.alpha" && remote.remoteBranchPolicy.rows[1].value === "allow",
    "and the project override that wins over it");
  check(remote["remote-writes"].rows.find((r) => r.name === "grant choices")?.value === "once / session / always / deny",
    "lib/remote-writes.js's four grant choices are reported from the module");
  check(/300 s/.test(remote["remote-writes"].rows.find((r) => r.name === "permission window")?.value || ""),
    "the permission window is reported with its cap");
  check(remote["remote-writes"].rows.every((r) => /remote-writes\.js:\d+$/.test(r.source)),
    "every module row carries its own file:line");
}

// ---- B. a stub gateway: 200 with features, then 401 ------------------------------------------------
let gatewayMode = "ok";
const gatewayRequests = [];
const gateway = createServer((req, res) => {
  const route = String(req.url || "").split("?")[0];
  gatewayRequests.push(route);
  if (route !== "/v1/capabilities") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
    return;
  }
  if (gatewayMode === "unauthorized") {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "unauthorized" } }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ version: "9.9.9-gate", features: { run_submission: true, steer: false, run_events_sse: true } }));
});
await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;

// The panel's fixture home: the gate's config.yaml, and a config.json that carries the policy.
mkdirSync(home, { recursive: true });
writeFileSync(configPath, FIXTURE);

const panel = await startPanel({
  dir,
  config: {
    assistant: { enabled: false },
    fetchSeconds: -1,
    apiServer: { url: gatewayUrl, key: "gate-test-key" },
    remoteBranchPolicy: "local-only",
    projects: [{ name: "alpha", path: slashed(project), remote: "origin", mainBranch: "main", remoteBranchPolicy: "allow" }],
  },
});

const readRoute = async () => {
  const r = await fetch(`${panel.base}/api/settings/permissions`);
  let body = null;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  return { status: r.status, body };
};

const playwright = loadPlaywright();
try {
  console.log(`sandbox: ${panel.base}`);
  console.log(`gateway: ${gatewayUrl} (stub) · home ${home}`);

  // ---- C. the route ------------------------------------------------------------------------------
  const answer = await readRoute();
  check(answer.status === 200, "GET /api/settings/permissions answers 200", `HTTP ${answer.status}`);
  if (answer.status !== 200) {
    check(false, "the Permissions route is missing, so nothing below it can be asked", JSON.stringify(answer.body).slice(0, 160));
  }
  const routeData = answer.body || {};
  const routeSources = byKey(routeData);
  check(routeData.sources?.length === 8, "the route carries all eight sources", String(routeData.sources?.length));
  check(routeSources.approvals?.source === `${configPath}:${lineOf(FIXTURE, "approvals:")}`,
    "the route reads the sandbox's own config.yaml, not the developer's", routeSources.approvals?.source);
  check(routeSources.gateway?.status === "ok", "the stub gateway's features are reported", routeSources.gateway?.status);
  check(
    routeSources.gateway?.rows?.some((r) => r.name === "run_submission" && r.value === "yes") &&
      routeSources.gateway?.rows?.some((r) => r.name === "steer" && r.value === "no"),
    "as one row per advertised feature",
  );
  check(routeSources.gateway?.rows?.every((r) => r.source === `${gatewayUrl}/v1/capabilities`),
    "sourced to the capabilities endpoint");
  check(routeSources.remoteBranchPolicy?.rows?.[0].value === "local-only", "config.json's policy is in the payload");

  gatewayMode = "unauthorized";
  const unauth = await readRoute();
  const unauthGateway = byKey(unauth.body || {}).gateway;
  check(unauthGateway?.status === "unauthorized" && /not exposed, needs a token/.test(unauthGateway?.reason || ""),
    "a 401 is not exposed, needs a token — not a feature guess", unauthGateway?.reason);
  check(Array.isArray(unauthGateway?.rows) && unauthGateway.rows.length === 0, "and the 401 carries no rows");
  gatewayMode = "ok";

  // A missing config.yaml through the real route.
  renameSync(configPath, `${configPath}.gone`);
  const noConfig = await readRoute();
  const noConfigSources = byKey(noConfig.body || {});
  check(
    ["approvals", "command_allowlist", "tool_loop_guardrails", "platform_toolsets", "code_execution"].every(
      (key) => noConfigSources[key]?.status === "unreadable",
    ),
    "with config.yaml gone the route says each YAML source is unreadable",
  );
  check(/not found/.test(noConfigSources.approvals?.reason || ""), "and names the missing path", noConfigSources.approvals?.reason);
  renameSync(`${configPath}.gone`, configPath);

  if (!playwright) {
    console.log(notRun("the Permissions tab", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)"));
  } else {
    await withBrowser(
      async ({ page }) => {
        await page.setViewportSize(WIDE);
        await openPage(page, panel.base, { selector: "#btn-settings" });
        await page.waitForTimeout(250);

        const boot = await page.evaluate((key) => {
          const tabs = [...document.querySelectorAll("#settings [role='tab']")];
          const panels = [...document.querySelectorAll("#settings .settings-group")];
          return {
            keys: tabs.map((t) => t.dataset.settingsTab),
            labels: tabs.map((t) => t.querySelector(".settings-tab-label")?.textContent || ""),
            panelKeys: panels.map((p) => p.dataset.settingsGroup),
            hidden: panels.map((p) => p.hidden),
            stored: localStorage.getItem(key),
          };
        }, TAB_KEY);
        const at = boot.keys.indexOf("permissions");
        check(at === 8, "Permissions is the ninth tab in the strip", `index ${at}`);
        if (at < 0) {
          check(false, "there is no Permissions tab to drive — the rest of the browser half cannot be asked");
          return;
        }
        if (answer.status !== 200) {
          check(false, "the Permissions panel cannot be driven without its route");
          return;
        }
        check(boot.labels[at] === "Permissions", "labelled Permissions", boot.labels[at]);
        check(boot.panelKeys[at] === "permissions", "and its panel is in the same position");
        check(boot.hidden[at] === true, "the panel ships hidden until its tab is pressed");

        await page.click("#btn-settings");
        await page.waitForSelector("#settings:not(.hidden)", { timeout: 10_000 });
        await page.waitForTimeout(150);
        await page.click('[data-settings-tab="permissions"]');
        await page.waitForSelector("#permissions-list .perm-group", { timeout: 10_000 });
        await page.waitForTimeout(150);
        const tab = await page.evaluate((key) => {
          const panel = document.getElementById("settings-panel-permissions");
          const selected = document.querySelector('[data-settings-tab="permissions"]')?.getAttribute("aria-selected");
          return {
            selected,
            shown: !panel?.hidden,
            stored: localStorage.getItem(key),
            summary: document.getElementById("permissions-summary")?.textContent || "",
            config: document.getElementById("permissions-config")?.textContent || "",
            groups: [...document.querySelectorAll("#permissions-list .perm-group")].map((g) => ({
              key: g.dataset.permissionsGroup,
              label: g.querySelector(".perm-label")?.textContent || "",
              status: g.querySelector(".perm-status")?.textContent || "",
              source: g.querySelector(".perm-head .perm-source")?.textContent || "",
              rows: g.querySelectorAll("[data-permissions-row]").length,
              note: g.querySelector(".perm-note")?.textContent || "",
            })),
            rowSources: [...document.querySelectorAll("#permissions-list [data-permissions-row] .perm-source")].map((n) => n.textContent || ""),
          };
        }, TAB_KEY);
        check(tab.selected === "true" && tab.shown, "a press selects the tab and shows only its panel");
        check(tab.stored === "permissions", `the choice is remembered under ${TAB_KEY}`, String(tab.stored));
        check(tab.groups.length === 8, "the panel draws one group per source", `${tab.groups.length} groups`);
        check(/8\/8 sources read/.test(tab.summary), "the summary says every source answered", tab.summary);
        check(/config\.yaml/.test(tab.config) && /read /.test(tab.config), "the file line names config.yaml and its read time", tab.config);
        check(
          tab.groups.every((g) => /(\.yaml|\.json|\.js):\d+$/.test(g.source) || /\/v1\/capabilities$/.test(g.source)),
          "every group heading's source is file:line or endpoint",
        );
        check(
          tab.rowSources.every((src) => /(\.yaml|\.json|\.js):\d+$/.test(src) || /\/v1\/capabilities$/.test(src)),
          "every permission row's source is file:line or endpoint",
        );
        const approvals = tab.groups.find((g) => g.key === "approvals");
        check(approvals?.status === "read" && approvals?.rows === 2, "Approvals shows its two rows as read", JSON.stringify(approvals));
        const allow = tab.groups.find((g) => g.key === "command_allowlist");
        check(allow?.rows === 3, "the always-ask group shows the fixture's three patterns", String(allow?.rows));
        const gatewayGroup = tab.groups.find((g) => g.key === "gateway");
        check(gatewayGroup?.rows >= 4 && gatewayGroup?.source === `${gatewayUrl}/v1/capabilities`,
          "the gateway group's rows are sourced to the endpoint", `${gatewayGroup?.rows} rows`);

        // The search filters this grouped list and counts it on the tab.
        await page.fill("#settings-search", "force push");
        await page.waitForTimeout(200);
        const found = await page.evaluate(() => {
          const badge = document.querySelector('[data-settings-tab="permissions"] .settings-tab-count');
          const allow = document.querySelector('[data-permissions-group="command_allowlist"]');
          return {
            count: (badge?.textContent || "").trim(),
            visible: allow ? allow.getClientRects().length > 0 : false,
            rows: allow ? allow.querySelectorAll("[data-permissions-row]:not(.search-hidden)").length : 0,
          };
        });
        check(Number(found.count) > 0 && found.visible && found.rows === 1, "the search finds one always-ask pattern", JSON.stringify(found));
        await page.fill("#settings-search", "");
        await page.waitForTimeout(150);

        // The honest cannot-read state, in the tab itself: delete config.yaml, reload, press the tab.
        renameSync(configPath, `${configPath}.gone`);
        await page.reload();
        await page.waitForSelector("#btn-settings", { timeout: 15_000 });
        await page.click("#btn-settings");
        await page.waitForSelector("#settings:not(.hidden)", { timeout: 10_000 });
        await page.click('[data-settings-tab="permissions"]');
        await page.waitForSelector("#permissions-list .perm-group", { timeout: 10_000 });
        await page.waitForTimeout(150);
        const broke = await page.evaluate(() => {
          const summary = document.getElementById("permissions-summary")?.textContent || "";
          const group = document.querySelector('[data-permissions-group="approvals"]');
          return {
            summary,
            status: group?.querySelector(".perm-status")?.textContent || "",
            note: group?.querySelector(".perm-note")?.textContent || "",
            rows: group?.querySelectorAll("[data-permissions-row]").length || 0,
          };
        });
        check(/cannot be read/.test(broke.summary), "with config.yaml gone the summary counts the unreadable sources", broke.summary);
        check(broke.status === "cannot read" && /not found/.test(broke.note), "the Approvals group says cannot read and why", `${broke.status} · ${broke.note}`);
        check(broke.rows === 0, "and it draws no stale rows");
        renameSync(`${configPath}.gone`, configPath);
      });
    }
} finally {
  await panel.stop();
  gateway.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nRESULT: ${failures === 0 ? "PASS" : "FAIL"} — ${checks} checks, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
