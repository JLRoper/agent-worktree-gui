// Unit tests for lib/gateway-permissions.js — the reader behind the Permissions tab.
//
// The point of the module is that it reports what a file says TODAY, with the line each value sits on,
// and that a source it cannot read becomes a sentence instead of a guess. So these tests build a real
// config.yaml fixture and assert line numbers against the text they wrote, not against a snapshot.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BLOCKS,
  REMOTE_WRITES_PATH,
  panelConfigFile,
  parseYamlBlock,
  readPermissions,
  remotePolicySource,
  remoteWritesSource,
} from "../lib/gateway-permissions.js";
import { policyFrom } from "../lib/remote-writes.js";
import { ROOT, startPanel } from "../tools/panel-testkit.mjs";

const lineOf = (text, needle, from = 0) => {
  const lines = String(text).split("\n");
  for (let i = from; i < lines.length; i += 1) if (lines[i].includes(needle)) return i + 1;
  return null;
};

const byKey = (result) => Object.fromEntries(result.sources.map((source) => [source.key, source]));

const FIXTURE = `# a config.yaml fixture, written for this test only
tool_loop_guardrails:
  warnings_enabled: true
  warn_after:
    exact_failure: 2
  hard_stop:
    enabled: false
platform_toolsets:
  cli: [hermes-cli]
  telegram:
    - hermes-telegram
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
    },
    {
      "name": "beta"
    }
  ]
}`;

const MODULE_TEXT = readFileSync(REMOTE_WRITES_PATH, "utf8");

const withFixture = async (fn, { text = FIXTURE, panelText = PANEL_CONFIG } = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), "gwperm-"));
  const configPath = path.join(dir, "config.yaml");
  const panelConfigPath = path.join(dir, "config.json");
  writeFileSync(configPath, text);
  writeFileSync(panelConfigPath, panelText);
  try {
    return await fn({ dir, configPath, panelConfigPath });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const read = (paths, extra = {}) =>
  readPermissions({
    configPath: paths.configPath,
    panelConfigPath: paths.panelConfigPath,
    panelConfigText: PANEL_CONFIG,
    moduleText: MODULE_TEXT,
    gateway: { url: "" },
    ...extra,
  });

test("reads all five blocks with the line each value sits on", async () => {
  await withFixture(async (paths) => {
    const result = await read(paths);
    const sources = byKey(result);

    assert.equal(result.sources.length, 8, "five YAML sources, the gateway, the policy and the module");
    assert.deepEqual(
      BLOCKS.map((block) => block.key),
      ["approvals", "command_allowlist", "tool_loop_guardrails", "platform_toolsets", "code_execution"],
    );

    // approvals: a plain map, each row carrying its own line.
    const approvals = sources.approvals;
    assert.equal(approvals.status, "ok");
    assert.equal(approvals.source, `${paths.configPath}:${lineOf(FIXTURE, "approvals:")}`);
    assert.equal(approvals.rows.find((row) => row.name === "timeout").value, "600");
    assert.equal(approvals.rows.find((row) => row.name === "timeout").source, `${paths.configPath}:${lineOf(FIXTURE, "  timeout: 600")}`);
    assert.equal(approvals.rows.find((row) => row.name === "mode").value, "manual");

    // command_allowlist: a list, order preserved, each pattern its own row.
    const allow = sources.command_allowlist;
    assert.equal(allow.status, "ok");
    assert.deepEqual(
      allow.rows.map((row) => row.name),
      ["force push", "recursive delete", "script execution via heredoc"],
    );
    assert.deepEqual(
      allow.rows.map((row) => row.value),
      ["always ask", "always ask", "always ask"],
    );
    assert.equal(allow.rows[0].source, `${paths.configPath}:${lineOf(FIXTURE, "- force push")}`);

    // tool_loop_guardrails: nested maps flatten to dotted names and keep the leaf's line.
    const guard = sources.tool_loop_guardrails;
    const exact = guard.rows.find((row) => row.name === "warn_after.exact_failure");
    assert.equal(exact.value, "2");
    assert.equal(exact.line, lineOf(FIXTURE, "exact_failure: 2"));
    assert.equal(guard.rows.find((row) => row.name === "hard_stop.enabled").value, "false");

    // platform_toolsets: one row per platform, an inline list and a block list both read.
    const toolsets = sources.platform_toolsets;
    assert.equal(toolsets.rows.find((row) => row.name === "cli").value, "hermes-cli");
    assert.equal(toolsets.rows.find((row) => row.name === "telegram").value, "hermes-telegram");
    assert.equal(toolsets.rows.find((row) => row.name === "api_server").value, "hermes-api-server, clarify");

    // code_execution: two scalars, one row each.
    const exec = sources.code_execution;
    assert.equal(exec.rows.find((row) => row.name === "timeout").value, "300");
    assert.equal(exec.rows.find((row) => row.name === "max_tool_calls").value, "50");

    // The gateway has no URL in this call, so it is reported as unreadable rather than guessed at.
    assert.equal(sources.gateway.status, "unreadable");
    assert.match(sources.gateway.reason, /no gateway URL/);
    assert.equal(sources.gateway.rows.length, 0);

    // config.json's policy and the project that overrides it.
    const policy = sources.remoteBranchPolicy;
    assert.equal(policy.rows[0].name, "global");
    assert.equal(policy.rows[0].value, "local-only");
    assert.equal(policy.rows[0].source, `${paths.panelConfigPath}:${lineOf(PANEL_CONFIG, '"remoteBranchPolicy"')}`);
    assert.equal(policy.rows[1].name, "projects.alpha");
    assert.equal(policy.rows[1].value, "allow");
    assert.equal(policy.rows[2].name, "projects.beta");
    assert.equal(policy.rows[2].value, "(inherits the global policy)");

    // lib/remote-writes.js's own layer, read from the real module.
    const grants = sources["remote-writes"];
    assert.equal(grants.status, "ok");
    assert.equal(grants.rows.length, 6);
    assert.equal(grants.rows.find((row) => row.name === "grant choices").value, "once / session / always / deny");
    assert.match(grants.rows.find((row) => row.name === "permission window").value, /300 s/);
    for (const row of grants.rows) {
      assert.match(row.source, new RegExp(`^${REMOTE_WRITES_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\d+$`), row.name);
    }

    assert.equal(result.counts.sources, 8);
    assert.equal(result.counts.unreadable, 1);
    assert.ok(result.counts.rows > 20);
    assert.ok(result.checkedAt);
  });
});

test("a missing config.yaml leaves every YAML source unreadable and names the path", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gwperm-missing-"));
  const missing = path.join(dir, "config.yaml");
  try {
    const result = await readPermissions({
      configPath: missing,
      panelConfigText: PANEL_CONFIG,
      panelConfigPath: path.join(dir, "config.json"),
      moduleText: MODULE_TEXT,
      gateway: { url: "" },
    });
    const sources = byKey(result);
    for (const block of BLOCKS) {
      assert.equal(sources[block.key].status, "unreadable", block.key);
      assert.match(sources[block.key].reason, /not found/, block.key);
      assert.deepEqual(sources[block.key].rows, [], block.key);
    }
    assert.equal(result.configFile.status, "unreadable");
    assert.equal(result.counts.unreadable, 6, "five YAML sources and the gateway");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed block is reported with its line, and the other blocks still read", async () => {
  const broken = `# broken on purpose
approvals:
  timeout: "600
  mode: manual
code_execution:
  timeout: 300
`;
  await withFixture(
    async (paths) => {
      const result = await readPermissions({
        configPath: paths.configPath,
        panelConfigText: PANEL_CONFIG,
        panelConfigPath: paths.panelConfigPath,
        moduleText: MODULE_TEXT,
        gateway: { url: "" },
      });
      const sources = byKey(result);
      assert.equal(sources.approvals.status, "malformed");
      assert.match(sources.approvals.reason, /^line \d+: an unterminated quoted value$/);
      assert.deepEqual(sources.approvals.rows, []);
      assert.equal(sources.code_execution.status, "ok");
      assert.equal(sources.code_execution.rows.find((row) => row.name === "timeout").value, "300");
    },
    { text: broken },
  );
});

test("a list block holding a map is malformed rather than half-read", async () => {
  const broken = `command_allowlist:
  force push: true
  recursive delete: true
`;
  await withFixture(
    async (paths) => {
      const result = await readPermissions({
        configPath: paths.configPath,
        panelConfigText: PANEL_CONFIG,
        panelConfigPath: paths.panelConfigPath,
        moduleText: MODULE_TEXT,
        gateway: { url: "" },
      });
      const allow = byKey(result).command_allowlist;
      assert.equal(allow.status, "malformed");
      assert.match(allow.reason, /expected a list, found a map/);
      assert.equal(allow.rows.length, 0);
    },
    { text: broken },
  );
});

test("a block that is not in the file is missing, not empty", async () => {
  const without = FIXTURE.replace(/code_execution:\n  timeout: 300\n  max_tool_calls: 50\n/, "");
  await withFixture(
    async (paths) => {
      const result = await readPermissions({
        configPath: paths.configPath,
        panelConfigText: PANEL_CONFIG,
        panelConfigPath: paths.panelConfigPath,
        moduleText: MODULE_TEXT,
        gateway: { url: "" },
      });
      const exec = byKey(result).code_execution;
      assert.equal(exec.status, "missing");
      assert.match(exec.reason, /no top-level `code_execution:` block/);
      assert.equal(exec.line, null);
      assert.equal(exec.rows.length, 0);
    },
    { text: without },
  );
});

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));

test("a 401 from the gateway says not exposed, needs a token — and guesses no features", async () => {
  const server = createServer((req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "unauthorized" } }));
  });
  const url = await listen(server);
  try {
    const result = await readPermissions({
      configPath: "C:/nowhere/config.yaml",
      panelConfigText: PANEL_CONFIG,
      moduleText: MODULE_TEXT,
      gateway: { url },
    });
    const gateway = byKey(result).gateway;
    assert.equal(gateway.status, "unauthorized");
    assert.match(gateway.reason, /not exposed, needs a token/);
    assert.equal(gateway.endpoint, `${url}/v1/capabilities`);
    assert.equal(gateway.source, `${url}/v1/capabilities`);
    assert.deepEqual(gateway.rows, [], "401 must not invent rows");
  } finally {
    server.close();
  }
});

test("the gateway's features become rows whose source is the endpoint", async () => {
  const server = createServer((req, res) => {
    assert.equal(req.url, "/v1/capabilities");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ version: "9.9.9", features: { run_submission: true, steer: false } }));
  });
  const url = await listen(server);
  try {
    const result = await readPermissions({
      configPath: "C:/nowhere/config.yaml",
      panelConfigText: PANEL_CONFIG,
      moduleText: MODULE_TEXT,
      gateway: { url, key: "test-key" },
    });
    const gateway = byKey(result).gateway;
    assert.equal(gateway.status, "ok");
    assert.deepEqual(
      gateway.rows.map((row) => [row.name, row.value]),
      [["version", "9.9.9"], ["run_submission", "yes"], ["steer", "no"]],
    );
    for (const row of gateway.rows) assert.equal(row.source, `${url}/v1/capabilities`);
  } finally {
    server.close();
  }
});

test("an unreachable gateway is reported, not thrown", async () => {
  const result = await readPermissions({
    configPath: "C:/nowhere/config.yaml",
    panelConfigText: PANEL_CONFIG,
    moduleText: MODULE_TEXT,
    gateway: { url: "http://127.0.0.1:1" },
    timeoutMs: 250,
    fetchImpl: async () => {
      const error = new Error("connect ECONNREFUSED 127.0.0.1:1");
      throw error;
    },
  });
  const gateway = byKey(result).gateway;
  assert.equal(gateway.status, "unreachable");
  assert.match(gateway.reason, /cannot reach the gateway/);
  assert.equal(gateway.rows.length, 0);
});

test("config.json's malformed JSON is a reason, not a policy guess", async () => {
  await withFixture(
    async (paths) => {
      const result = await readPermissions({
        configPath: paths.configPath,
        panelConfigPath: paths.panelConfigPath,
        panelConfigText: "{oops",
        moduleText: MODULE_TEXT,
        gateway: { url: "" },
      });
      const policy = byKey(result).remoteBranchPolicy;
      assert.equal(policy.status, "malformed");
      assert.match(policy.reason, /not valid JSON/);
      assert.equal(policy.rows.length, 0);
    },
    { text: FIXTURE },
  );
});

// ---- which config.json: THIS instance's, by the rule the server booted with ----------------------
// A sandbox panel booted on its own PANEL_CONFIG used to have the CHECKOUT's policy reported back to it, because
// lib/gateway-permissions.js derived the path itself (`path.resolve(HERE, "..", "config.json")`) while the rest of
// the server asked lib/paths.js. These boot real servers, so they fail on that second copy of the rule.
const checkoutConfigPath = path.join(ROOT, "config.json");
const checkoutText = readFileSync(checkoutConfigPath, "utf8");
const checkoutPolicy = policyFrom(JSON.parse(checkoutText).remoteBranchPolicy);
const policyOf = (body) => (body?.sources || []).find((source) => source.key === "remoteBranchPolicy");
const readPolicyRoute = async (panel) =>
  policyOf(await (await fetch(`${panel.base}/api/settings/permissions`)).json());

test("a panel booted on PANEL_CONFIG reports that config's remoteBranchPolicy", async () => {
  // A value the checkout's file does not carry, so the payload itself says which file was read.
  const distinctive = ["deny", "allow"].find((policy) => policy !== checkoutPolicy);
  const panel = await startPanel({
    config: { assistant: { enabled: false }, remoteBranchPolicy: distinctive, projects: [] },
  });
  try {
    const policy = await readPolicyRoute(panel);
    const ownText = readFileSync(panel.configPath, "utf8");
    assert.equal(policy.status, "ok");
    assert.equal(policy.file, panel.configPath, "the chip names the file the panel is actually running on");
    assert.equal(policy.configSource, "PANEL_CONFIG");
    assert.equal(policy.rows[0].value, distinctive, "and the value is that file's policy");
    assert.equal(
      policy.source,
      `${panel.configPath}:${lineOf(ownText, '"remoteBranchPolicy"')}`,
      "with the line that value sits on in that file",
    );
  } finally {
    await panel.stop();
  }
});

test("the checkout's policy is never shown to a panel booted on its own config.json", async () => {
  const distinctive = ["deny", "allow"].find((policy) => policy !== checkoutPolicy);
  const panel = await startPanel({
    config: { assistant: { enabled: false }, remoteBranchPolicy: distinctive, projects: [] },
  });
  try {
    const body = await (await fetch(`${panel.base}/api/settings/permissions`)).json();
    const policy = policyOf(body);
    assert.notEqual(checkoutPolicy, distinctive, "premise: the two files carry different policies");
    assert.equal(policy.rows[0].value, distinctive);
    assert.notEqual(policy.rows[0].value, checkoutPolicy, "the checkout's value is not what the tab reports");
    // Nor may any chip name the checkout's file: a row sourced to it is the checkout's answer wearing this
    // panel's prefix, whatever the value beside it says.
    const named = body.sources
      .flatMap((source) => [source.file, source.source, ...(source.rows || []).map((row) => row.source)])
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());
    const checkoutKey = checkoutConfigPath.toLowerCase().replace(/\//g, "\\");
    assert.ok(
      named.every((value) => !value.startsWith(checkoutKey)),
      `no source may name ${checkoutConfigPath}; got ${JSON.stringify(named.filter((v) => v.startsWith(checkoutKey)))}`,
    );
    assert.equal(body.panelConfig.path, panel.configPath, "and the payload says which config it read");
    assert.equal(body.panelConfig.source, "PANEL_CONFIG");
  } finally {
    await panel.stop();
  }
});

test("a default boot, with no PANEL_CONFIG, still reads the checkout's config.json", async () => {
  // The default install listens on config.json's own port (7331), which the reader's panel already holds, so this
  // asserts the rule the boot applies rather than binding a second listener on that port: the resolution the server
  // performs, then the read of the file it names. `home` is a throwaway profile with no moved config to find.
  const home = mkdtempSync(path.join(tmpdir(), "gwperm-default-"));
  try {
    const file = panelConfigFile({ env: {}, home });
    assert.equal(file.path, checkoutConfigPath);
    assert.equal(file.source, "checkout");
    const result = await readPermissions({
      configPath: path.join(home, "hermes", "config.yaml"),
      panelEnv: {},
      panelHome: home,
      moduleText: MODULE_TEXT,
      gateway: { url: "" },
    });
    const policy = byKey(result).remoteBranchPolicy;
    assert.equal(policy.file, checkoutConfigPath);
    assert.equal(policy.configSource, "checkout");
    assert.equal(policy.rows[0].value, checkoutPolicy, "the checkout's own policy, read from its own file");
    assert.equal(
      policy.source,
      `${checkoutConfigPath}:${lineOf(checkoutText, '"remoteBranchPolicy"')}`,
      "with the line it sits on in the checkout's file",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a panel config that cannot be read is a status and a reason, never a fallback", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gwperm-unreadable-"));
  try {
    const checkoutCopy = path.join(dir, "config.json");
    writeFileSync(checkoutCopy, PANEL_CONFIG);
    const configured = path.join(dir, "sandbox.json");
    // The configured path is gone, the checkout's copy IS readable: the value must still not be borrowed from it,
    // because the chip under it names the configured file.
    const borrowed = remotePolicySource({ panelConfigPath: configured, checkoutConfigPath: checkoutCopy });
    assert.equal(borrowed.status, "unreadable");
    assert.deepEqual(borrowed.rows, []);
    assert.match(borrowed.reason, /not found/);
    assert.match(borrowed.reason, /was not used instead/);
    // Neither readable: both paths are named, with what each answered.
    const neither = remotePolicySource({
      panelConfigPath: configured,
      checkoutConfigPath: path.join(dir, "also-gone.json"),
    });
    assert.equal(neither.status, "unreadable");
    assert.match(neither.reason, /sandbox\.json/);
    assert.match(neither.reason, /also-gone\.json/);
    assert.deepEqual(neither.rows, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing lib/remote-writes.js is unreadable and says so", () => {
  const source = remoteWritesSource({ modulePath: "C:/nowhere/remote-writes.js", moduleText: null });
  assert.equal(source.status, "unreadable");
  assert.match(source.reason, /not found/);
});

test("parseYamlBlock strips comments outside quotes and keeps apostrophes in plain scalars", () => {
  const lines = [
    "approvals:",
    "  mode: manual # the reader's own note",
    "  note: \"the reader's file\"",
    "  flag: false",
  ];
  const root = parseYamlBlock(lines, 0);
  const byName = Object.fromEntries(root.children.map((entry) => [entry.key, entry]));
  assert.equal(byName.mode.value, "manual");
  assert.equal(byName.note.value, '"the reader\'s file"');
  assert.equal(byName.flag.value, "false");
});

test("parseYamlBlock refuses a duplicate key with the line", () => {
  const lines = ["approvals:", "  timeout: 600", "  timeout: 300"];
  assert.throws(
    () => parseYamlBlock(lines, 0),
    (error) => error.name === "BlockParseError" && error.line === 3 && /duplicate key/.test(error.message),
  );
});
