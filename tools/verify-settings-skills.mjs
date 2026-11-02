#!/usr/bin/env node
// Settings > Skills: every place an agent's skills are absorbed from, organised by source and then by category, and
// every skill those places hold — read only, with the gateway's own answer for what a run is actually served.
//
//   node tools/verify-settings-skills.mjs
//
// WHAT WAS WRONG. There was no such tab and no such route. Settings had seven groups and none of them said where a
// skill comes from: the profile's `skills/` directory holds category folders, top-level skills AND a JUNCTION
// (`skills/sefl` -> the team's own repository), so a naive walk lists the team's skills twice with nothing to say
// which copy a row is. And the disk is only half the truth — `GET /v1/skills` on the gateway reports what a run is
// actually served (shadowing, disabled names and platform gates resolved), which a filesystem walk cannot know.
// When the tab landed it rendered ONE flat list: every row printed its whole absolute path, the only grouping was a
// single "PROFILE" heading, and the categories that exist on disk were invisible.
//
// WHAT IS DRIVEN, over HTTP and in a real Chromium, all against a sandbox panel with a fixture HERMES_HOME, a
// junctioned root, a project carrying its own skills and a STUB gateway (never the developer's):
//   * GET /api/settings/skills answers the sources in order — profile first, then the junction as its own source
//     with the target it points at — and lists each skill ONCE (realpath dedupe), with name, description,
//     category, source, path, rel and is-link on every row
//   * a configured root that is not on disk is a source with a reason; a project checkout Hermes will not read is
//     `ignored`, with the config key that decides it named in the reason, and contributes no rows
//   * the gateway's answer is merged: a row it does not serve says so, a name it serves and no root carries becomes
//     a Gateway row, and a gateway answering 500 leaves every row UNVERIFIED with its own words as the reason
//   * the tab is in the strip (eighth, between Gateway and Updates), a press selects it, shows only its panel and
//     remembers it, and the tab comes back after a reload before the panel is opened
//   * the list is grouped TWICE — one foldable heading per source, one per category inside it — with the count of
//     the rows under it on every heading, the uncategorised bucket first and each bucket name-sorted
//     case-insensitively, and the source order the route answered
//   * a row prints name, description and the path RELATIVE to its source's base, and carries the whole absolute
//     path in its tooltip — the absolute path is never the drawn text
//   * the folds persist: a source with more than six categories starts CLOSED and one with six or fewer starts
//     open, a press flips it, and the choice survives a reload through localStorage `wtgui.skillsGroups`
//   * the settings search filters this list by name, by description and by CATEGORY, the heading counts follow the
//     filtered set, a match inside a folded group is opened and revealed, and clearing the box restores the counts
//     and the reader's own folds
//   * a failing gateway is ONE banner line plus a quiet mark on each row — the word "unverified" is not stamped
//     onto every row, and no row is ever said to be served on an answer that never came
//   * the panel holds no setting control at all: the only buttons in it are its own fold headings
//
// RED PROOF. Run this file in a `git archive` export of 0.65.0 and it fails on its first two checks — there is no
// `/api/settings/skills` route and no `[data-settings-tab="skills"]` — so a green run here means the tab and the
// route answered, not an empty page. A missing Playwright prints BROWSER-HALF-NOT-RUN and exits 2 after the HTTP
// half has already been reported, rather than passing a half that never ran.
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPlaywright, notRun, openPage, withBrowser } from "./browser.mjs";
import { startPanel } from "./panel-testkit.mjs";

const WIDE = { width: 1400, height: 900 };
const TAB_KEY = "wtgui.settingsTab";
const GROUPS_KEY = "wtgui.skillsGroups";
const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";

let failures = 0;
let checks = 0;
const check = (cond, label, detail = "") => {
  checks += 1;
  if (!cond) failures += 1;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};
const note = (text) => console.log(`      ${text}`);

// ---- the fixture: a Hermes home with two roots, a junction, a project with skills, and a stub gateway ----------
const dir = mkdtempSync(path.join(tmpdir(), "wtgui-skills-gate-"));
const home = path.join(dir, "hermes");
const skills = path.join(home, "skills");
const team = path.join(dir, "team-skills");
const project = path.join(dir, "repo-with-skills");
const otherProject = path.join(dir, "repo-untrusted");
const created = path.join(home, "new-skills");
const missing = path.join(dir, "not-a-root");

const write = (file, body) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body, "utf8");
};
const writeSkill = (root, folder, name, description) =>
  write(path.join(root, folder, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`);

writeSkill(skills, "alpha", "alpha", "The windmill skill: a description no name search would find.");
writeSkill(skills, "hidden", "hidden", "This one the gateway does not serve.");
writeSkill(path.join(skills, "grouper"), "beta", "beta", "A skill in a category folder.");
writeSkill(team, "delta", "delta", "A team skill behind the junction.");
writeSkill(created, "epsilon", "epsilon", "A skill in the create directory.");
writeSkill(path.join(project, ".hermes", "skills"), "eta", "eta", "A trusted project's own skill.");
writeSkill(path.join(otherProject, ".hermes", "skills"), "theta", "theta", "An untrusted project's skill.");
// A source with MORE THAN SIX categories: its category folds start closed. grp1 holds three rows on purpose, in an
// order the file system does not sort, so the list's own name sort can be read off the DOM.
writeSkill(path.join(created, "grp1"), "zulu", "Zulu", "Third by name, first in the directory.");
writeSkill(path.join(created, "grp1"), "mid", "MiddleSkill", "Second by name.");
writeSkill(path.join(created, "grp1"), "alpha2", "alphabet", "First by name, last in the directory.");
for (const n of [2, 3, 4, 5, 6, 7]) writeSkill(path.join(created, `grp${n}`), `s${n}`, `grp${n}skill`, `Category ${n}'s only skill.`);
symlinkSync(team, path.join(skills, "team"), LINK_TYPE);

// Every skill on disk except `hidden`, plus the plugin's own name: the stub gateway's answer.
const SERVED = ["alpha", "beta", "delta", "epsilon", "eta", "Zulu", "MiddleSkill", "alphabet", "grp2skill", "grp3skill", "grp4skill", "grp5skill", "grp6skill", "grp7skill", "plugin:maker"];

const slashed = (p) => String(p).split(path.sep).join("/");
write(path.join(home, "config.yaml"), [
  "skills:",
  "  create_dir: new-skills",
  "  external_dirs:",
  `    - ${slashed(missing)}`,
  "  trusted_project_dirs:",
  `    - ${slashed(project)}`,
  "",
].join("\n"));

// The stub gateway. It is the only thing this panel may talk to: the real one on 8642 would make the gate depend on
// the developer's own install (and its /v1/skills is broken on some builds).
const servedAnswer = {
  status: 200,
  body: {
    object: "list",
    data: SERVED.map((name) => ({
      name,
      description: `${name} from the gateway`,
      category: name === "plugin:maker" ? "plugin" : null,
    })),
  },
};
let gatewayAnswer = servedAnswer;
const gatewayRequests = [];
const gateway = createServer((req, res) => {
  const route = String(req.url || "").split("?")[0];
  gatewayRequests.push(route);
  if (route !== "/v1/skills") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
    return;
  }
  res.writeHead(gatewayAnswer.status, { "content-type": "application/json" });
  res.end(JSON.stringify(gatewayAnswer.body));
});
await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;

const panel = await startPanel({
  dir,
  config: {
    assistant: { enabled: false },
    apiServer: { url: gatewayUrl, key: "gate-test-key" },
    projects: [
      { name: "with-skills", path: slashed(project), remote: "origin", mainBranch: "main", worktreePolicy: "local-only" },
      { name: "untrusted", path: slashed(otherProject), remote: "origin", mainBranch: "main", worktreePolicy: "local-only" },
    ],
  },
});

const readRoute = async () => {
  const r = await fetch(`${panel.base}/api/settings/skills`);
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

  // ---- A. the route: sources in order, the junction its own source, every skill once -------------------------
  const answer = await readRoute();
  check(answer.status === 200, "GET /api/settings/skills answers 200", `HTTP ${answer.status}`);
  const data = answer.body || {};
  if (answer.status !== 200) {
    check(false, "the Skills inventory route is missing, so nothing below it can be asked", JSON.stringify(data).slice(0, 160));
  }
  const sources = Array.isArray(data.sources) ? data.sources : [];
  const rows = Array.isArray(data.skills) ? data.skills : [];
  const byName = (name) => rows.find((s) => s.name === name);
  check(sources.length >= 4, "the route enumerates more than one root", sources.map((s) => s.key).join(", "));
  check(sources[0]?.key === "profile", "the profile's own skills/ is the first source", sources[0]?.key);
  const link = sources.find((s) => s.kind === "link");
  check(Boolean(link), "the junctioned folder is a source of its own");
  check(link && link.isLink === true && path.resolve(link.target || "") === path.resolve(team),
    "and it carries the target it points at", `${link?.label} -> ${link?.target}`);
  check(link && link.count === 1 && byName("delta")?.source === link.key,
    "its skill is listed under it", `count ${link?.count}`);

  // Every row carries the fields the tab draws — including `rel`, the short path it prints.
  const fields = ["name", "description", "source", "path", "rel", "isLink"];
  const badRow = rows.find((s) => fields.some((f) => s[f] === undefined) || (s.source !== "gateway" && !s.path));
  check(!badRow, "every row carries name, description, source, category, path, rel and is-link", badRow ? JSON.stringify(badRow).slice(0, 160) : `${rows.length} rows`);
  check(rows.every((s) => s.category === null || typeof s.category === "string"), "category is a string or an explicit null");
  check(byName("beta")?.category === "grouper", "a category folder is the row's category", byName("beta")?.category);
  check(byName("delta")?.category === "team" && byName("delta")?.isLink === true,
    "a skill behind the junction keeps its category and says it is a link", `${byName("delta")?.category}/${byName("delta")?.isLink}`);
  check(byName("delta")?.path?.startsWith(skills), "and its path is the one the agent's own tree names, not the target's", byName("delta")?.path);
  check(byName("alpha")?.isLink === false, "a plain skill is not a link");
  check(byName("alpha")?.rel === "alpha/SKILL.md" && byName("beta")?.rel === "grouper/beta/SKILL.md",
    "rel is the path relative to the source's own base", `${byName("alpha")?.rel} · ${byName("beta")?.rel}`);
  check(byName("plugin:maker")?.rel === null, "a gateway-only row has no base to be relative to, and says null");
  check(data.counts?.duplicates === 0 && Array.isArray(data.duplicates) && data.duplicates.length === 0,
    "no skill is listed twice — the walk did not descend into the junction", `${data.counts?.duplicates} duplicates`);
  check(data.counts?.skills === rows.filter((s) => s.source !== "gateway").length,
    "the count of skills on disk is the number of disk rows", `${data.counts?.skills}`);

  // ---- B. sources that cannot answer say why -----------------------------------------------------------------
  const missingSource = sources.find((s) => path.resolve(s.path) === path.resolve(missing));
  check(missingSource?.status === "missing" && /does not exist/.test(missingSource.reason || ""),
    "a configured root that is not there is a source with the reason", `${missingSource?.status}: ${missingSource?.reason}`);
  const ignored = sources.find((s) => s.kind === "project" && /untrusted/.test(s.key));
  check(ignored?.status === "ignored" && /trusted_project_dirs/.test(ignored.reason || ""),
    "an untrusted project's skills are listed as ignored, naming the key that decides it", `${ignored?.status}: ${ignored?.reason}`);
  check(ignored?.count === 0 && !byName("theta"), "and it contributes no rows");
  const trusted = sources.find((s) => s.kind === "project" && /with-skills/.test(s.key));
  check(trusted?.status === "ok" && byName("eta")?.source === trusted.key,
    "a trusted project's own skills are a source like any other", `${trusted?.status}`);

  // ---- C. the gateway's answer is merged in ------------------------------------------------------------------
  check(data.gateway?.ok === true && data.gateway?.count === SERVED.length, "the gateway's answer is merged in", JSON.stringify(data.gateway));
  check(byName("alpha")?.served === true, "a skill the gateway serves is marked served");
  check(byName("hidden")?.served === false, "a skill it does not serve is marked not served");
  const plugin = byName("plugin:maker");
  check(plugin?.source === "gateway" && plugin?.path === null && plugin?.served === true,
    "a name it serves that no root carries is a Gateway row with no path", `${plugin?.name} path ${plugin?.path}`);
  check(data.counts?.served === 15 && data.counts?.unserved === 1 && data.counts?.gatewayOnly === 1,
    "the counts add up: 15 served, 1 not served, 1 gateway-only",
    `${data.counts?.served}/${data.counts?.unserved}/${data.counts?.gatewayOnly}`);

  // A gateway answering 500 is a REASON, not a failed request, and it must not claim anything about any row.
  gatewayAnswer = { status: 500, body: { error: { message: "Failed to enumerate skills" } } };
  const broken = await readRoute();
  check(broken.status === 200, "the route still answers 200 when the gateway fails", `HTTP ${broken.status}`);
  check(broken.body?.gateway?.ok === false && /Failed to enumerate skills/.test(broken.body?.gateway?.reason || ""),
    "the gateway's own words are the reason it could not answer", broken.body?.gateway?.reason);
  check(broken.body?.skills?.every((s) => s.served === null), "every row is UNVERIFIED, not 'not served'");
  check(broken.body?.counts?.unknown === broken.body?.skills?.length && broken.body?.counts?.served === null,
    "and the counts say unknown rather than zero served", JSON.stringify(broken.body?.counts));
  gatewayAnswer = servedAnswer;

  if (!playwright) {
    console.log(`\n${notRun("the Skills tab", "playwright is not installed (set PANEL_PLAYWRIGHT_ROOT)")}`);
    console.log(`HTTP half: ${checks - failures}/${checks} checks passed`);
    console.log(`sandbox kept: ${dir}`);
    await panel.stop();
    gateway.close();
    process.exit(2);
  }

  // ---- D. the tab, in the strip ------------------------------------------------------------------------------
  await withBrowser(
    async ({ page, pageErrors }) => {
      await page.setViewportSize(WIDE);
      await openPage(page, panel.base, { selector: "#btn-settings" });
      await page.waitForTimeout(300);

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
      const at = boot.keys.indexOf("skills");
      check(at >= 0, "the strip carries a Skills tab", boot.keys.join(","));
      check(boot.labels[at] === "Skills", "labelled Skills", boot.labels[at]);
      check(at === boot.keys.indexOf("gateway") + 1, "it sits where the skills live — after Gateway", `index ${at}`);
      check(boot.panelKeys.length === boot.keys.length && boot.hidden.filter((h) => !h).length === 1,
        "one panel ships drawn and the rest hidden", `${boot.hidden.filter((h) => !h).length} drawn of ${boot.panelKeys.length}`);
      check(boot.panelKeys[at] === "skills" && boot.hidden[at] === true, "the Skills panel is one of the hidden ones", boot.panelKeys.join(","));
      if (at < 0) {
        check(false, "there is no Skills tab at all — this page predates the tab, and nothing below can be driven");
        return;
      }

      // ---- E. a press selects it, and the choice survives a reload --------------------------------------------
      await page.click("#btn-settings");
      await page.waitForSelector("#settings:not(.hidden)", { timeout: 10_000 });
      await page.click('[data-settings-tab="skills"]');
      await page.waitForSelector('[data-settings-group="skills"]:not([hidden])', { timeout: 10_000 });
      await page.waitForTimeout(250);
      const onSkills = await page.evaluate((key) => ({
        selected: [...document.querySelectorAll("#settings [role='tab']")].filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.dataset.settingsTab),
        shown: [...document.querySelectorAll("#settings .settings-group")].filter((p) => p.getClientRects().length > 0).map((p) => p.dataset.settingsGroup),
        stored: localStorage.getItem(key),
      }), TAB_KEY);
      check(JSON.stringify(onSkills.selected) === JSON.stringify(["skills"]), "a press selects the Skills tab", onSkills.selected.join(","));
      check(JSON.stringify(onSkills.shown) === JSON.stringify(["skills"]), "and only its panel is drawn", onSkills.shown.join(","));
      check(onSkills.stored === "skills", `the choice is remembered under ${TAB_KEY}`, String(onSkills.stored));

      // ---- F. the drawn list: two levels of grouping, a count on every heading, a short path on every row -----
      await page.waitForSelector("#settings-panel-skills .skills-skill", { timeout: 15_000 }).catch(() => {});
      const drawn = await page.evaluate(() => {
        const panelEl = document.getElementById("settings-panel-skills");
        const text = (node) => (node ? node.innerText.replace(/\s+/g, " ").trim() : "");
        const groups = [...panelEl.querySelectorAll(".skills-srcgroup")].map((g) => ({
          key: g.dataset.skillsSourceGroup,
          label: text(g.querySelector(".skills-source-name")),
          count: text(g.querySelector(".skills-source-count")),
          expanded: g.querySelector(".skills-source")?.getAttribute("aria-expanded"),
          bodyHidden: Boolean(g.querySelector(".skills-srcbody")?.hidden),
          cats: [...g.querySelectorAll(".skills-catgroup")].map((c) => ({
            key: c.dataset.skillsCatGroup,
            label: text(c.querySelector(".skills-cat-name")),
            count: text(c.querySelector(".skills-cat-count")),
            expanded: c.querySelector(".skills-cathead")?.getAttribute("aria-expanded"),
            bodyHidden: Boolean(c.querySelector(".skills-catbody")?.hidden),
            rows: [...c.querySelectorAll(".skills-skill")].map((r) => r.dataset.skill),
          })),
        }));
        const rows = [...panelEl.querySelectorAll(".skills-skill")].map((r) => {
          const detail = r.nextElementSibling;
          return {
            name: text(r.querySelector(".skills-name")),
            source: r.dataset.skillsSource,
            cat: r.dataset.skillsCat,
            text: text(r),
            title: r.getAttribute("title") || "",
            detail: text(detail),
            pathText: text(detail?.querySelector(".skills-path")),
            pathTitle: detail?.querySelector(".skills-path")?.getAttribute("title") || "",
          };
        });
        return {
          summary: document.getElementById("skills-summary")?.textContent || "",
          gatewayLine: document.getElementById("skills-gateway")?.textContent || "",
          groups,
          rows,
          heads: [...panelEl.querySelectorAll(".skills-source")].map(text),
          sourcePaths: [...panelEl.querySelectorAll(".skills-source-path")].map(text),
          buttons: [...panelEl.querySelectorAll("button")].map((b) => ({ cls: b.className || "", fold: b.hasAttribute("data-skills-fold-source") })),
          inputs: panelEl.querySelectorAll("input, select, textarea").length,
          marks: panelEl.querySelectorAll("[data-skills-mark]").length,
          catHeads: panelEl.querySelectorAll(".skills-cathead").length,
        };
      });
      check(drawn.rows.length === rows.length, "one row per skill the route returned", `${drawn.rows.length} drawn vs ${rows.length} returned`);
      const drawnNames = drawn.rows.map((r) => r.name).sort();
      check(JSON.stringify(drawnNames) === JSON.stringify(rows.map((r) => r.name).sort()), "the same skills, by name", drawnNames.join(","));
      check(drawn.rows.every((r) => r.text.includes(r.name) && r.detail.length > r.pathText.length),
        "each row shows its name on the identity line, with a description and path below it", drawn.rows[0]?.text);
      check(Boolean(drawn.rows.find((r) => r.name === "alpha")?.detail.match(/windmill/)),
        "and the line under it carries the description", (drawn.rows.find((r) => r.name === "alpha")?.detail || "").slice(0, 80));
      check(drawn.rows.find((r) => r.name === "delta")?.text.includes("link"), "a row behind the junction says link");
      check(drawn.rows.find((r) => r.name === "hidden")?.text.includes("not served"), "a row the gateway does not serve says so");
      check(drawn.rows.find((r) => r.name === "plugin:maker")?.source === "gateway", "the gateway-only skill is drawn under Gateway");

      // Two levels: every source in the route's order, plus the gateway's own, then categories inside it.
      const expected = [...sources.map((s) => s.key), "gateway"];
      check(JSON.stringify(drawn.groups.map((g) => g.key)) === JSON.stringify(expected),
        "one group per source, in the route's order, then the gateway's own", drawn.groups.map((g) => g.key).join(","));
      check(drawn.catHeads === drawn.groups.reduce((n, g) => n + g.cats.length, 0),
        "every category the source holds has its own heading", `${drawn.catHeads} category headings`);
      const countMismatch = drawn.groups.find((g) => {
        const want = rows.filter((r) => (g.key === "gateway" ? r.source === "gateway" : r.source === g.key)).length;
        const sum = g.cats.reduce((n, c) => n + Number(c.count), 0);
        return g.count !== String(want) || sum !== want;
      });
      check(!countMismatch, "every source heading counts its rows, and its categories add up to it",
        countMismatch ? `${countMismatch.key}: ${countMismatch.count} vs ${countMismatch.cats.map((c) => c.count).join("+")}` : `${drawn.groups.length} groups`);
      const profileGroup = drawn.groups.find((g) => g.key === "profile");
      check(JSON.stringify(profileGroup?.cats.map((c) => c.key)) === JSON.stringify(["", "grouper"]),
        "a source's categories come from its rows, with an explicit bucket for the skills at its top",
        profileGroup?.cats.map((c) => `${c.key || "(top)"}:${c.count}`).join(" "));
      check(profileGroup?.cats[0]?.key === "" && profileGroup?.cats[0]?.count === "2" && profileGroup?.cats[1]?.count === "1",
        "the uncategorised bucket comes first and every category counts its own rows", profileGroup?.cats.map((c) => `${c.key || "(top)"}:${c.count}`).join(" "));
      const createGroup = drawn.groups.find((g) => g.key === "create");
      check(createGroup?.cats.find((c) => c.key === "grp1")?.rows.join(",") === "alphabet,MiddleSkill,Zulu",
        "rows inside a group are sorted by name, case-insensitively", createGroup?.cats.find((c) => c.key === "grp1")?.rows.join(","));

      // The short path is what is DRAWN; the whole absolute path is the tooltip.
      const relativeBad = drawn.rows.find((r) => {
        const routeRow = rows.find((s) => s.name === r.name && s.source === r.source);
        if (!routeRow) return true;
        if (routeRow.rel) {
          return r.pathText !== routeRow.rel || r.pathText.includes(routeRow.path) || !r.title.includes(routeRow.path);
        }
        return routeRow.path === null && r.pathText.includes(String(skills));
      });
      check(!relativeBad, "each row prints the path relative to its source's base, with the whole path in the tooltip",
        relativeBad ? `${relativeBad.name}: ${relativeBad.pathText}` : (drawn.rows.find((r) => r.name === "beta")?.pathText || ""));
      check(drawn.rows.find((r) => r.name === "beta")?.pathText === "grouper/beta/SKILL.md",
        "a categorised row's short path keeps its category folder", drawn.rows.find((r) => r.name === "beta")?.pathText);
      check(drawn.rows.find((r) => r.name === "plugin:maker")?.pathText.startsWith("no SKILL.md"),
        "a gateway-only row says there is no file instead of inventing one", drawn.rows.find((r) => r.name === "plugin:maker")?.pathText);

      check(drawn.heads.length === sources.length + 1, "one heading per source, plus the gateway's own", `${drawn.heads.length} headings for ${sources.length} sources`);
      check(drawn.sourcePaths.some((p) => /->|→/.test(p) && p.includes("team-skills")), "the junction's heading line names its target",
        drawn.sourcePaths.find((p) => p.includes("team-skills")));
      check(drawn.sourcePaths.some((p) => /does not exist/.test(p)), "an unreadable source draws its reason on the heading line",
        drawn.sourcePaths.find((p) => /does not exist/.test(p)));
      check(drawn.inputs === 0 && drawn.buttons.every((b) => b.fold),
        "the only controls are the fold headings — the tab is otherwise read only",
        `${drawn.buttons.length} buttons, ${drawn.buttons.filter((b) => !b.fold).length} not a fold, ${drawn.inputs} inputs`);
      check(drawn.marks === 0, "an answered gateway puts no unknown mark on any row", `${drawn.marks} marks`);
      check(/^16 skills · \d+ sources/.test(drawn.summary) && /served/.test(drawn.summary), "the summary counts the rows", drawn.summary);
      check(drawn.gatewayLine.includes(gatewayUrl) && /\/v1\/skills/.test(drawn.gatewayLine),
        "and the line under it is the gateway's own answer", drawn.gatewayLine);

      // Defaults: a source opens; a source with six or fewer categories opens them too; more than six folds them.
      check(profileGroup?.expanded === "true" && profileGroup?.bodyHidden === false
        && profileGroup?.cats.every((c) => c.expanded === "true" && c.bodyHidden === false),
        "a source with six or fewer categories starts open, and so do its categories",
        `${profileGroup?.cats.length} categories`);
      check(createGroup?.expanded === "true" && createGroup?.bodyHidden === false
        && createGroup?.cats.length === 8 && createGroup?.cats.every((c) => c.expanded === "false" && c.bodyHidden === true),
        "a source with more than six categories starts with its category folds closed",
        `${createGroup?.cats.length} categories`);
      const storedAtBoot = await page.evaluate((key) => localStorage.getItem(key), GROUPS_KEY);
      check(storedAtBoot === null, "the defaults are not written to storage — only a press is",
        String(storedAtBoot));
      if (!profileGroup || !createGroup) {
        check(false, "the list is not grouped into foldable sources — nothing below this can be driven");
        return;
      }

      // ---- G. the folds persist through localStorage ----------------------------------------------------------
      const groupState = (sourceKey, catKey) =>
        page.evaluate(([s, c]) => {
          const g = [...document.querySelectorAll("#settings-panel-skills .skills-srcgroup")].find((x) => x.dataset.skillsSourceGroup === s);
          if (!g) return null;
          if (c === null) {
            return { expanded: g.querySelector(".skills-source")?.getAttribute("aria-expanded"), hidden: Boolean(g.querySelector(".skills-srcbody")?.hidden), shown: g.getClientRects().length > 0 };
          }
          const k = [...g.querySelectorAll(".skills-catgroup")].find((x) => x.dataset.skillsCatGroup === c);
          return { expanded: k?.querySelector(".skills-cathead")?.getAttribute("aria-expanded"), hidden: Boolean(k?.querySelector(".skills-catbody")?.hidden), shown: Boolean(k) };
        }, [sourceKey, catKey]);
      const foldsStored = () =>
        page.evaluate((key) => {
          try {
            return JSON.parse(localStorage.getItem(key) || "null");
          } catch {
            return "unparsable";
          }
        }, GROUPS_KEY);
      const openSkillsTab = async () => {
        const open = await page.evaluate(() => !document.getElementById("settings").classList.contains("hidden"));
        if (!open) await page.click("#btn-settings");
        await page.waitForSelector("#settings:not(.hidden)", { timeout: 10_000 });
        const selected = await page.evaluate(() => document.querySelector('[data-settings-tab="skills"]')?.getAttribute("aria-selected") === "true");
        if (!selected) await page.click('[data-settings-tab="skills"]');
        await page.waitForSelector('[data-settings-group="skills"]:not([hidden])', { timeout: 10_000 });
        await page.waitForSelector("#settings-panel-skills .skills-skill", { timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(150);
      };

      await page.click('#settings-panel-skills .skills-srcgroup[data-skills-source-group="create"] .skills-source');
      const opened = await groupState("create", null);
      const afterOpen = await foldsStored();
      check(opened?.expanded === "false" && opened?.hidden === true, "a press closes a source that was open", `${opened?.expanded}/${opened?.hidden}`);
      check(afterOpen?.create?.open === false && !afterOpen?.profile, `the press is written to localStorage ${GROUPS_KEY}`, JSON.stringify(afterOpen));

      await page.click('#settings-panel-skills .skills-srcgroup[data-skills-source-group="profile"] .skills-catgroup[data-skills-cat-group="grouper"] .skills-cathead');
      const catClosed = await groupState("profile", "grouper");
      const afterCat = await foldsStored();
      check(catClosed?.expanded === "false" && catClosed?.hidden === true, "a press closes a category", `${catClosed?.expanded}/${catClosed?.hidden}`);
      check(afterCat?.profile?.cats?.grouper === false && afterCat?.create?.open === false,
        "both choices are remembered, and they do not erase each other", JSON.stringify(afterCat));

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("#btn-settings", { timeout: 30_000 });
      await page.waitForTimeout(400);
      await openSkillsTab();
      const afterReload = { create: await groupState("create", null), grouper: await groupState("profile", "grouper") };
      check(afterReload.create?.expanded === "false" && afterReload.create?.hidden === true,
        "after a reload the source is still closed", `${afterReload.create?.expanded}/${afterReload.create?.hidden}`);
      check(afterReload.grouper?.expanded === "false" && afterReload.grouper?.hidden === true,
        "and the category is still closed", `${afterReload.grouper?.expanded}/${afterReload.grouper?.hidden}`);

      // Flip both back, then drop the record: the defaults have to come back, not a remembered flip.
      await page.click('#settings-panel-skills .skills-srcgroup[data-skills-source-group="create"] .skills-source');
      await page.click('#settings-panel-skills .skills-srcgroup[data-skills-source-group="profile"] .skills-catgroup[data-skills-cat-group="grouper"] .skills-cathead');
      const flipped = await foldsStored();
      check(flipped?.create?.open === true && flipped?.profile?.cats?.grouper === true,
        "a second press flips each fold back", JSON.stringify(flipped));
      await page.evaluate((key) => localStorage.removeItem(key), GROUPS_KEY);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("#btn-settings", { timeout: 30_000 });
      await page.waitForTimeout(400);
      await openSkillsTab();
      const defaultsAgain = { create: await groupState("create", null), grouper: await groupState("profile", "grouper") };
      check(defaultsAgain.create?.expanded === "true" && defaultsAgain.create?.hidden === false,
        "with no record the source falls back to its default (open)", `${defaultsAgain.create?.expanded}`);
      check(defaultsAgain.grouper?.expanded === "true" && defaultsAgain.grouper?.hidden === false,
        "and so does the category (open, because the source has few categories)", `${defaultsAgain.grouper?.expanded}`);

      // ---- H. the filter: name, description, CATEGORY, and the counts follow it -------------------------------
      const filterState = () =>
        page.evaluate(() => {
          const panelEl = document.getElementById("settings-panel-skills");
          const visible = [...panelEl.querySelectorAll(".skills-skill")].filter((r) => r.getClientRects().length > 0).map((r) => r.dataset.skill);
          const badge = [...document.querySelectorAll("#settings [role='tab']")].find((t) => t.getAttribute("aria-selected") === "true")?.querySelector(".settings-tab-count");
          const groupOf = (key) => [...panelEl.querySelectorAll(".skills-srcgroup")].find((g) => g.dataset.skillsSourceGroup === key);
          const create = groupOf("create");
          return {
            visible,
            badge: (badge?.textContent || "").trim(),
            badgeShown: Boolean(badge) && !badge.hidden,
            createCount: (create?.querySelector(".skills-source-count")?.textContent || "").trim(),
            createShown: Boolean(create) && create.getClientRects().length > 0,
            grp3Count: ([...create?.querySelectorAll(".skills-catgroup") || []].find((c) => c.dataset.skillsCatGroup === "grp3")?.querySelector(".skills-cat-count")?.textContent || "").trim(),
            grp3Body: Boolean([...create?.querySelectorAll(".skills-catgroup") || []].find((c) => c.dataset.skillsCatGroup === "grp3")?.querySelector(".skills-catbody")?.hidden) === false,
            grp4Hidden: [...create?.querySelectorAll(".skills-catgroup") || []].find((c) => c.dataset.skillsCatGroup === "grp4")?.classList.contains("search-hidden"),
            profileShown: Boolean(groupOf("profile")) && groupOf("profile").getClientRects().length > 0,
            totalRows: panelEl.querySelectorAll(".skills-skill").length,
            hiddenRows: panelEl.querySelectorAll(".skills-skill.search-hidden").length,
          };
        });

      await page.click("#settings-search");
      await page.keyboard.type("grp3skill");
      await page.waitForTimeout(300);
      const byNameFilter = await filterState();
      check(JSON.stringify(byNameFilter.visible) === JSON.stringify(["grp3skill"]),
        "a skill name filters the list to that skill", byNameFilter.visible.join(","));
      check(byNameFilter.badge === "1" && byNameFilter.badgeShown, "the tab's own count is the rows that answer", byNameFilter.badge);
      check(byNameFilter.createShown && byNameFilter.createCount === "1",
        "a match inside a collapsed source opens the source and counts 1 on it", `${byNameFilter.createCount} shown ${byNameFilter.createShown}`);
      check(byNameFilter.grp3Count === "1" && byNameFilter.grp3Body,
        "and the category that holds it is opened with its own count", `${byNameFilter.grp3Count}`);
      check(byNameFilter.profileShown === false, "a source that answers nothing is hidden outright");
      check(byNameFilter.grp4Hidden === true, "a category that answers nothing is hidden outright");

      await page.fill("#settings-search", "grouper");
      await page.waitForTimeout(250);
      const byCategory = await filterState();
      check(JSON.stringify(byCategory.visible) === JSON.stringify(["beta"]),
        "a CATEGORY name filters the list to the skills in it", byCategory.visible.join(","));
      check(byCategory.badge === "1", "and the count follows the filtered set", byCategory.badge);

      await page.fill("#settings-search", "windmill");
      await page.waitForTimeout(250);
      const byDescription = await filterState();
      check(JSON.stringify(byDescription.visible) === JSON.stringify(["alpha"]),
        "a word in a DESCRIPTION finds the row and reveals the Skills tab", byDescription.visible.join(","));

      await page.click("#btn-settings-search-clear");
      await page.waitForTimeout(300);
      const clearedFilter = await filterState();
      const restoredCounts = await page.evaluate(() => {
        const panelEl = document.getElementById("settings-panel-skills");
        const groupOf = (key) => [...panelEl.querySelectorAll(".skills-srcgroup")].find((g) => g.dataset.skillsSourceGroup === key);
        const create = groupOf("create");
        return {
          create: (create?.querySelector(".skills-source-count")?.textContent || "").trim(),
          profile: (groupOf("profile")?.querySelector(".skills-source-count")?.textContent || "").trim(),
          createHidden: Boolean(create?.querySelector(".skills-srcbody")?.hidden),
          createCats: [...create?.querySelectorAll(".skills-catbody") || []].every((b) => b.hidden),
        };
      });
      check(clearedFilter.hiddenRows === 0 && clearedFilter.totalRows === rows.length,
        "clearing the box un-filters and un-hides every row", `${clearedFilter.totalRows}/${rows.length} rows, ${clearedFilter.hiddenRows} hidden`);
      check(clearedFilter.visible.length === 6,
        "and the reader's own folds come back — the six rows in open groups, none added",
        clearedFilter.visible.join(","));
      check(restoredCounts.create === "10" && restoredCounts.profile === "3",
        "and the heading counts go back to the whole set", `${restoredCounts.create}/${restoredCounts.profile}`);
      check(restoredCounts.createHidden === false && restoredCounts.createCats === true,
        "the source is open again with its eight categories folded, exactly as the default left them",
        `${restoredCounts.createHidden}/${restoredCounts.createCats}`);

      // ---- I. nothing is hidden by a leftover query after the panel is reopened -------------------------------
      await page.click('[data-settings-tab="display"]');
      await page.click("#settings-search");
      await page.keyboard.type("windmill");
      await page.waitForTimeout(250);
      const searched = await page.evaluate(() => {
        const active = [...document.querySelectorAll("#settings [role='tab']")].find((t) => t.getAttribute("aria-selected") === "true");
        const row = [...document.querySelectorAll("#settings-panel-skills .skills-skill")].find((r) => r.dataset.skill === "alpha");
        return {
          tab: active?.dataset.settingsTab || "",
          alphaShown: Boolean(row) && row.getClientRects().length > 0,
        };
      });
      check(searched.tab === "skills", "a word in a DESCRIPTION reveals the Skills tab", searched.tab);
      check(searched.alphaShown, "and the row that carries it is on screen");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      const cleared = await page.evaluate(() => {
        const rowsOnPage = [...document.querySelectorAll("#settings-panel-skills .skills-skill")];
        return {
          tab: [...document.querySelectorAll("#settings [role='tab']")].find((t) => t.getAttribute("aria-selected") === "true")?.dataset.settingsTab || "",
          rows: rowsOnPage.length,
          filtered: rowsOnPage.filter((r) => r.classList.contains("search-hidden")).length,
          detailsStillHidden: document.querySelectorAll("#settings-panel-skills .skills-detail.search-hidden").length,
        };
      });
      check(cleared.tab === "display", "Esc clears the box and goes back to the reader's own tab", cleared.tab);
      check(cleared.rows === rows.length && cleared.filtered === 0 && cleared.detailsStillHidden === 0,
        "with no row left filtered — every skill and its detail line is back the next time the tab is opened",
        `${cleared.rows}/${rows.length} rows, ${cleared.filtered} filtered, ${cleared.detailsStillHidden} details hidden`);

      // ---- J. the tab is the one painted after a reload, before the panel is opened --------------------------
      await page.click('[data-settings-tab="skills"]');
      await page.waitForTimeout(150);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("#btn-settings", { timeout: 30_000 });
      await page.waitForTimeout(400);
      const reloaded = await page.evaluate(() => {
        const tabs = [...document.querySelectorAll("#settings [role='tab']")];
        const panels = [...document.querySelectorAll("#settings .settings-group")];
        return {
          selected: tabs.filter((t) => t.getAttribute("aria-selected") === "true").map((t) => t.dataset.settingsTab),
          visible: panels.filter((p) => !p.hidden).map((p) => p.dataset.settingsGroup),
          open: !document.getElementById("settings").classList.contains("hidden"),
        };
      });
      check(JSON.stringify(reloaded.selected) === JSON.stringify(["skills"]), "after a reload the Skills tab is still selected", reloaded.selected.join(","));
      check(JSON.stringify(reloaded.visible) === JSON.stringify(["skills"]), "and its panel is the one painted at load", reloaded.visible.join(","));
      check(!reloaded.open, "read from the strip while the window was still closed");

      // ---- K. a failing gateway is ONE banner plus a quiet mark, and claims nothing --------------------------
      gatewayAnswer = { status: 500, body: { error: { message: "Failed to enumerate skills" } } };
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("#btn-settings", { timeout: 30_000 });
      await page.waitForTimeout(500);
      await page.click("#btn-settings");
      await page.waitForSelector("#settings:not(.hidden)", { timeout: 10_000 });
      await page.click('[data-settings-tab="skills"]');
      await page.waitForSelector("#settings-panel-skills .skills-skill", { timeout: 15_000 }).catch(() => {});
      const failing = await page.evaluate(() => {
        const panelEl = document.getElementById("settings-panel-skills");
        const gatewayEl = document.getElementById("skills-gateway");
        const style = gatewayEl ? getComputedStyle(gatewayEl) : null;
        const drawnRows = [...panelEl.querySelectorAll(".skills-skill")];
        return {
          summary: document.getElementById("skills-summary")?.textContent || "",
          gatewayLine: gatewayEl?.textContent || "",
          bad: Boolean(gatewayEl?.classList.contains("bad")),
          oneLine: Boolean(style) && style.whiteSpace === "nowrap" && style.textOverflow === "ellipsis",
          bannerBoxes: gatewayEl ? gatewayEl.getClientRects().length : 0,
          unsent: panelEl.querySelectorAll(".skills-chip.unsent").length,
          marks: panelEl.querySelectorAll("[data-skills-mark]").length,
          rows: drawnRows.length,
          wordOnRows: drawnRows.filter((r) => /unverified/i.test(`${r.innerText} ${r.getAttribute("title") || ""}`)).length,
        };
      });
      check(/unverified/.test(failing.summary), "with the gateway down the summary says the rows are unverified", failing.summary);
      check(/Failed to enumerate skills/.test(failing.gatewayLine) && failing.bad, "and the gateway line carries its own reason", failing.gatewayLine);
      check(/no row below can be said to be served/.test(failing.gatewayLine), "the banner refuses to claim any row is served");
      check(failing.oneLine && failing.bannerBoxes === 1, "the banner stays ONE line at the top of the tab", `${failing.oneLine}`);
      check(failing.unsent === 0, "no row is branded 'not served' on an answer that never came", `${failing.unsent} marked`);
      check(failing.marks === failing.rows, "each row carries one quiet unknown mark instead of a repeated word", `${failing.marks}/${failing.rows}`);
      check(failing.wordOnRows === 0, "and not one row repeats 'unverified' in the list", `${failing.wordOnRows} rows`);
      check(failing.rows > 0, "the disk half is still drawn", `${failing.rows} rows`);
      gatewayAnswer = servedAnswer;

      check(gatewayRequests.length > 0, "the panel talked to the stub gateway, never the developer's", `${gatewayRequests.length} requests`);
      check(pageErrors.length === 0, "no uncaught page errors", pageErrors.join(" | "));
    },
    { viewport: WIDE, deviceScaleFactor: 1 },
  );
} finally {
  await panel.stop();
  gateway.close();
}

console.log(`\n${failures === 0 ? "OK" : "FAILED"}  ${checks - failures}/${checks} checks passed`);
console.log(`sandbox: ${dir}`);
process.exit(failures === 0 ? 0 : 1);
