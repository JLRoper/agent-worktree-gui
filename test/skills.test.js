// lib/skills.js: every place an agent's skills are absorbed from, and what is in each of them.
//
// The mechanics this pins, one per trap:
//
//   1. a junctioned directory inside the profile's `skills/` is its OWN source — with the target it points at —
//      and the parent does not list its skills a second time (dedupe is by realpath, so a copy reached by any
//      other route loses to the first source that claimed it);
//   2. a root that is not there, and a project checkout Hermes will not read, are SOURCES WITH A REASON rather
//      than silent gaps — "0 skills" on a directory that exists and "0 skills" on one that does not are
//      different answers;
//   3. `name` and `description` come out of the SKILL.md frontmatter (quoted, plain or folded), falling back to
//      the directory name and the first line of prose the way Hermes does, so the list agrees with the index the
//      agent loads;
//   4. the gateway's `GET /v1/skills` is merged in: a row it does not serve says so, a name it serves that no
//      root carries becomes a row of its own, and a gateway that cannot answer leaves every row unverified
//      instead of claiming either.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseSkillText, readSkillsConfig, readSkillsIndex, skillSources } from "../lib/skills.js";

const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

function sandbox(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wtgui-skills-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const write = (file, body) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body, "utf8");
};

const skill = (root, name, front = `name: ${name}\ndescription: ${name} does a thing.\n`) =>
  write(path.join(root, name, "SKILL.md"), `---\n${front}---\n\nbody text\n`);

// A stub gateway: one answer per case, and a log of what it was asked.
async function stubGateway(t, answer) {
  const server = createServer((req, res) => {
    if (req.url.split("?")[0] !== "/v1/skills") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(answer.status || 200, { "content-type": "application/json" });
    res.end(JSON.stringify(answer.body ?? {}));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test("SKILL.md frontmatter: plain, quoted, folded, and the fallbacks Hermes uses", () => {
  const plain = parseSkillText("---\nname: alpha\ndescription: A plain line.\n---\nbody\n");
  assert.equal(plain.name, "alpha");
  assert.equal(plain.description, "A plain line.");

  const quoted = parseSkillText(`---\nname: "beta"\ndescription: 'A quoted line.'\n---\n`);
  assert.equal(quoted.name, "beta", "quotes are stripped from a name");
  assert.equal(quoted.description, "A quoted line.", "and from a description");

  const folded = parseSkillText("---\nname: gamma\ndescription: >\n  One long\n  sentence.\n---\n");
  assert.equal(folded.description, "One long sentence.", "a folded block is joined into one line");

  const described = parseSkillText("---\nname: delta\n---\n\nFirst line of prose.\nSecond.\n");
  assert.equal(described.description, null, "the frontmatter reader reports what the file says, not a guess");
  assert.equal(described.name, "delta");
  assert.match(described.body, /^\s*First line of prose\./, "and hands the body back for the caller's fallback");

  const bare = parseSkillText("# A heading\n\nProse here.\n");
  assert.equal(bare.name, null, "no frontmatter at all leaves the name to the caller");
  assert.equal(bare.description, null, "and the description to the body fallback");
});

test("a SKILL.md with no description is listed by its first line of prose, and no name by its directory", async (t) => {
  const dir = sandbox(t);
  const home = path.join(dir, "hermes");
  write(path.join(home, "skills", "prose-only", "SKILL.md"), "---\nname: prose-only\n---\n# Heading\n\nThe first line says it.\n");
  write(path.join(home, "skills", "nameless", "SKILL.md"), "---\ndescription: Named by its folder.\n---\n");
  const index = await readSkillsIndex({ home, configText: "", projects: [] });
  assert.equal(index.skills.find((s) => s.name === "prose-only").description, "The first line says it.",
    "Hermes reads the first non-heading body line, and this list must agree with the index the agent loads");
  assert.equal(index.skills.find((s) => s.name === "nameless").description, "Named by its folder.");
  assert.ok(index.skills.some((s) => s.name === "nameless"), "the directory name stands in for a missing name");
});

test("the skills block: create_dir, external_dirs and trusted_project_dirs, relative to HERMES_HOME", () => {
  const home = path.join(os.tmpdir(), "home-a");
  const config = readSkillsConfig(
    [
      "skills:",
      "  # comments and blank lines are skipped, not parsed",
      "  create_dir: new-skills",
      "  external_dirs:",
      "    - shared",
      "    - 'C:/elsewhere/team'",
      "    - missing-but-listed",
      "  trusted_project_dirs:",
      "    - C:/ProjectDevelopment/demo",
      "  project_discovery: true",
      "",
    ].join("\n"),
    { home },
  );
  assert.equal(config.createDir, path.resolve(home, "new-skills"), "a relative create_dir resolves against HERMES_HOME");
  assert.deepEqual(config.externalDirs, [
    path.resolve(home, "shared"),
    path.resolve("C:/elsewhere/team"),
    path.resolve(home, "missing-but-listed"),
  ], "every external entry is kept, quotes and all — whether it exists is the walk's question");
  assert.deepEqual(config.trustedProjectDirs, [path.resolve("C:/ProjectDevelopment/demo")]);
  assert.equal(config.projectDiscovery, true);

  const none = readSkillsConfig("model:\n  base_url: x\n", { home });
  assert.equal(none.createDir, null);
  assert.deepEqual(none.externalDirs, [], "no skills block is no sources, not a crash");
  assert.deepEqual(none.trustedProjectDirs, []);
});

test("sources: the profile always, configured roots when set, a project only when it carries the dir", (t) => {
  const dir = sandbox(t);
  const home = path.join(dir, "hermes");
  const trusted = path.join(dir, "repo-trusted");
  const untrusted = path.join(dir, "repo-untrusted");
  skill(path.join(trusted, ".hermes", "skills"), "eta", "name: eta\ndescription: Trusted project skill.\n");
  skill(path.join(untrusted, ".hermes", "skills"), "theta", "name: theta\ndescription: Untrusted project skill.\n");
  write(path.join(home, "config.yaml"), [
    "skills:",
    "  external_dirs:",
    `    - ${path.join(dir, "shared").replace(/\\/g, "/")}`,
    "  trusted_project_dirs:",
    `    - ${trusted.replace(/\\/g, "/")}`,
    "",
  ].join("\n"));

  const sources = skillSources({
    home,
    skills: readSkillsConfig("", { home }),
    projects: [
      { name: "trusted", path: trusted },
      { name: "untrusted", path: untrusted },
    ],
  });
  assert.deepEqual(sources.map((s) => s.key), ["profile", "project:trusted:.hermes/skills", "project:untrusted:.hermes/skills"],
    "no create_dir and no external_dirs in that text, so the profile and the two projects with a dir are the roots");
  const untrustedSource = sources.find((s) => s.key.startsWith("project:untrusted"));
  assert.equal(untrustedSource.status, "ignored");
  assert.match(untrustedSource.reason, /trusted_project_dirs/, "the reason names the config key that decides it");
});

test("a junction inside the profile is its own source, with its target, and its skills are listed once", async (t) => {
  const dir = sandbox(t);
  const home = path.join(dir, "hermes");
  const skills = path.join(home, "skills");
  skill(skills, "alpha", "name: alpha\ndescription: Profile skill.\n");
  write(path.join(skills, "cat", "beta", "SKILL.md"), "---\nname: beta\ndescription: Categorised skill.\n---\n");
  const team = path.join(dir, "team-skills");
  skill(team, "delta", "name: delta\ndescription: Team skill.\n");
  skill(team, "echo", "name: echo\ndescription: Another team skill.\n");
  symlinkSync(team, path.join(skills, "sefl"), LINK_TYPE);

  const index = await readSkillsIndex({ home, configText: "", projects: [] });
  const link = index.sources.find((s) => s.kind === "link");
  assert.ok(link, "the junction is a source of its own");
  assert.equal(link.key, "link:sefl");
  assert.equal(link.label, "sefl");
  assert.equal(link.isLink, true);
  assert.equal(link.target, path.resolve(team), "and it records what it points at");
  assert.equal(link.count, 2, "both team skills are read from it");

  const profile = index.sources.find((s) => s.key === "profile");
  assert.equal(profile.count, 2, "the profile's own skills only — the walk does not descend into the link");
  assert.equal(index.counts.skills, 4, "four skills in total, each listed once");
  assert.deepEqual(index.duplicates, [], "nothing was dropped as a duplicate, because nothing was walked twice");

  const delta = index.skills.find((s) => s.name === "delta");
  assert.equal(delta.source, "link:sefl");
  assert.equal(delta.isLink, true, "a row reached through a link says so");
  assert.equal(delta.category, "sefl", "and keeps the category its position in the tree gives it, as Hermes reads it");
  assert.ok(delta.path.startsWith(skills), "the path is the one the agent's own tree names, not the target's");
  assert.equal(delta.realPath, path.resolve(path.join(team, "delta", "SKILL.md")));

  const alpha = index.skills.find((s) => s.name === "alpha");
  assert.equal(alpha.isLink, false, "a plain skill is not a link");
  assert.equal(alpha.category, null, "a skill at the top of the root has no category");
  const beta = index.skills.find((s) => s.name === "beta");
  assert.equal(beta.category, "cat");
  assert.deepEqual(index.skills.map((s) => s.name), ["alpha", "beta", "delta", "echo"], "category, then name, within a source");
});

test("the same target listed twice is deduped by realpath, and the first source keeps it", async (t) => {
  const dir = sandbox(t);
  const home = path.join(dir, "hermes");
  const skills = path.join(home, "skills");
  mkdirSync(skills, { recursive: true });
  const team = path.join(dir, "team-skills");
  skill(team, "delta", "name: delta\ndescription: Team skill.\n");
  symlinkSync(team, path.join(skills, "sefl"), LINK_TYPE);
  const configText = ["skills:", "  external_dirs:", `    - ${team.replace(/\\/g, "/")}`, ""].join("\n");

  const index = await readSkillsIndex({ home, configText, projects: [] });
  assert.equal(index.counts.skills, 1, "one skill, not two copies of the same file");
  assert.equal(index.skills[0].source, "link:sefl", "the link claimed it first");
  const external = index.sources.find((s) => s.kind === "external");
  assert.equal(external.count, 0, "the external source that points at the same target holds nothing");
  assert.equal(index.counts.duplicates, 1, "and the copy it would have added is counted as a duplicate");
  assert.equal(index.duplicates[0].name, "delta");
  assert.equal(index.duplicates[0].keptBy, "link:sefl");
});

test("a root that is not there, and a source Hermes ignores, both say why", async (t) => {
  const dir = sandbox(t);
  const home = path.join(dir, "hermes");
  mkdirSync(path.join(home, "skills"), { recursive: true });
  const missing = path.join(dir, "not-there");
  const project = path.join(dir, "repo");
  skill(path.join(project, ".hermes", "skills"), "theta", "name: theta\ndescription: Not loaded.\n");
  const configText = ["skills:", "  external_dirs:", `    - ${missing.replace(/\\/g, "/")}`, ""].join("\n");

  const index = await readSkillsIndex({ home, configText, projects: [{ name: "repo", path: project }] });
  const external = index.sources.find((s) => s.kind === "external");
  assert.equal(external.status, "missing");
  assert.equal(external.reason, "this directory does not exist", "the missing dir is a reason, not a silent zero");
  const ignored = index.sources.find((s) => s.kind === "project");
  assert.equal(ignored.status, "ignored");
  assert.equal(ignored.count, 0);
  assert.match(ignored.reason, /trusted_project_dirs/);
  assert.equal(index.skills.some((s) => s.name === "theta"), false, "an ignored source contributes no rows");
});

test("the gateway's answer is merged: served, not served, gateway-only", async (t) => {
  const dir = sandbox(t);
  const home = path.join(dir, "hermes");
  const skills = path.join(home, "skills");
  skill(skills, "alpha", "name: alpha\ndescription: Served.\n");
  skill(skills, "hidden", "name: hidden\ndescription: Not served.\n");
  const url = await stubGateway(t, {
    body: {
      object: "list",
      data: [
        { name: "alpha", description: "Served.", category: null },
        { name: "plugin:maker", description: "A plugin's own skill.", category: "plugin" },
      ],
    },
  });

  const index = await readSkillsIndex({ home, configText: "", projects: [], gateway: { url, key: "k" } });
  assert.equal(index.gateway.ok, true);
  assert.equal(index.gateway.count, 2);
  assert.equal(index.skills.find((s) => s.name === "alpha").served, true);
  assert.equal(index.skills.find((s) => s.name === "hidden").served, false, "a row the gateway does not serve says so");
  const plugin = index.skills.find((s) => s.name === "plugin:maker");
  assert.ok(plugin, "a name the gateway serves and no root carries is still a row");
  assert.equal(plugin.source, "gateway");
  assert.equal(plugin.path, null, "there is no file to point at, and the row says nothing rather than guessing");
  assert.equal(index.counts.gatewayOnly, 1);
  assert.equal(index.counts.served, 2, "alpha and the plugin skill");
  assert.equal(index.counts.unserved, 1);
  assert.equal(index.counts.unknown, 0);
});

test("a gateway that cannot answer leaves every row unverified, with the reason", async (t) => {
  const dir = sandbox(t);
  const home = path.join(dir, "hermes");
  skill(path.join(home, "skills"), "alpha", "name: alpha\ndescription: x\n");
  const url = await stubGateway(t, { status: 500, body: { error: { message: "Failed to enumerate skills" } } });

  const index = await readSkillsIndex({ home, configText: "", projects: [], gateway: { url, key: "k" } });
  assert.equal(index.gateway.ok, false);
  assert.equal(index.gateway.status, 500);
  assert.match(index.gateway.reason, /Failed to enumerate skills/, "the gateway's own words are the reason");
  assert.equal(index.skills[0].served, null, "unverified is neither served nor not served");
  assert.equal(index.counts.served, null);
  assert.equal(index.counts.unknown, 1);

  const refused = await readSkillsIndex({ home, configText: "", projects: [], gateway: { url: "http://127.0.0.1:9/none" } });
  assert.equal(refused.gateway.ok, false);
  assert.match(refused.gateway.reason, /cannot reach the gateway|did not answer/, "an unreachable gateway is a reason too");
  assert.equal(refused.counts.unknown, refused.skills.length);
});
