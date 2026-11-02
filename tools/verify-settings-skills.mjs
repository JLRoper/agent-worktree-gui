#!/usr/bin/env node
// Settings > Skills: every place an agent's skills are absorbed from, organised by source, and every skill those
// places hold — read only, with the gateway's own answer for what a run is actually served.
//
//   node tools/verify-settings-skills.mjs
//
// WHAT WAS WRONG. There was no such tab and no such route. Settings had seven groups and none of them said where a
// skill comes from: the profile's `skills/` directory holds category folders, top-level skills AND a JUNCTION
// (`skills/sefl` -> the team's own repository), so a naive walk lists the team's skills twice with nothing to say
// which copy a row is. And the disk is only half the truth — `GET /v1/skills` on the gateway reports what a run is
// actually served (shadowing, disabled names and platform gates resolved), which a filesystem walk cannot know.
//
// WHAT IS DRIVEN, over HTTP and in a real Chromium, all against a sandbox panel with a fixture HERMES_HOME, a
// junctioned root, a project carrying its own skills and a STUB gateway (never the developer's):
//   * GET /api/settings/skills answers the sources in order — profile first, then the junction as its own source
//     with the target it points at — and lists each skill ONCE (realpath dedupe), with name, description,
//     category, source, path and is-link on every row
//   * a configured root that is not on disk is a source with a reason; a project checkout Hermes will not read is
//     `ignored`, with the config key that decides it named in the reason, and contributes no rows
//   * the gateway's answer is merged: a row it does not serve says so, a name it serves and no root carries becomes
//     a Gateway row, and a gateway answering 500 leaves every row UNVERIFIED with its own words as the reason
//   * the tab is in the strip (eighth, between Gateway and Updates), a press selects it, shows only its panel and
//     remembers it, and the tab comes back after a reload before the panel is opened
//   * the drawn rows match the route's answer one for one, each with its identity line and its description+path
//     line, and the panel holds NO control at all — there is nothing to edit because this is an inventory
//   * the settings search reaches a skill by a word in its DESCRIPTION as well as by its name, and reveals the tab
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
symlinkSync(team, path.join(skills, "team"), LINK_TYPE);

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
    data: ["alpha", "beta", "delta", "epsilon", "eta", "plugin:maker"].map((name) => ({
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
  const sourceOf = (key) => sources.find((s) => s.key === key);
  check(sources.length >= 4, "the route enumerates more than one root", sources.map((s) => s.key).join(", "));
  check(sources[0]?.key === "profile", "the profile's own skills/ is the first source", sources[0]?.key);
  const link = sources.find((s) => s.kind === "link");
  check(Boolean(link), "the junctioned folder is a source of its own");
  check(link && link.isLink === true && path.resolve(link.target || "") === path.resolve(team),
    "and it carries the target it points at", `${link?.label} -> ${link?.target}`);
  check(link && link.count === 1 && byName("delta")?.source === link.key,
    "its skill is listed under it", `count ${link?.count}`);

  // Every row carries the six fields the tab draws.
  const fields = ["name", "description", "source", "path", "isLink"];
  const badRow = rows.find((s) => fields.some((f) => s[f] === undefined) || (s.source !== "gateway" && !s.path));
  check(!badRow, "every row carries name, description, source, category, path and is-link", badRow ? JSON.stringify(badRow).slice(0, 160) : `${rows.length} rows`);
  check(rows.every((s) => s.category === null || typeof s.category === "string"), "category is a string or an explicit null");
  check(byName("beta")?.category === "grouper", "a category folder is the row's category", byName("beta")?.category);
  check(byName("delta")?.category === "team" && byName("delta")?.isLink === true,
    "a skill behind the junction keeps its category and says it is a link", `${byName("delta")?.category}/${byName("delta")?.isLink}`);
  check(byName("delta")?.path?.startsWith(skills), "and its path is the one the agent's own tree names, not the target's", byName("delta")?.path);
  check(byName("alpha")?.isLink === false, "a plain skill is not a link");
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
  check(data.gateway?.ok === true && data.gateway?.count === 6, "the gateway's answer is merged in", JSON.stringify(data.gateway));
  check(byName("alpha")?.served === true, "a skill the gateway serves is marked served");
  check(byName("hidden")?.served === false, "a skill it does not serve is marked not served");
  const plugin = byName("plugin:maker");
  check(plugin?.source === "gateway" && plugin?.path === null && plugin?.served === true,
    "a name it serves that no root carries is a Gateway row with no path", `${plugin?.name} path ${plugin?.path}`);
  check(data.counts?.served === 6 && data.counts?.unserved === 1 && data.counts?.gatewayOnly === 1,
    "the counts add up: 6 served, 1 not served, 1 gateway-only",
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
        const strip = document.getElementById("settings-tabs");
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

      // ---- F. the rows on screen are the route's rows ---------------------------------------------------------
      await page.waitForSelector("#settings-panel-skills .skills-skill", { timeout: 15_000 }).catch(() => {});
      const drawn = await page.evaluate(() => {
        const panelEl = document.getElementById("settings-panel-skills");
        const rows = [...panelEl.querySelectorAll(".skills-skill")];
        const detailFor = (name) => panelEl.querySelector(`.skills-detail[data-skill="${name}"]`)?.innerText;
        return {
          summary: document.getElementById("skills-summary")?.textContent || "",
          gatewayLine: document.getElementById("skills-gateway")?.textContent || "",
          rows: rows.map((r) => ({
            name: r.querySelector(".skills-name")?.textContent || "",
            source: r.dataset.skillsSource,
            text: r.innerText.replace(/\s+/g, " ").trim(),
          })),
          details: Object.fromEntries([...panelEl.querySelectorAll(".skills-detail")].map((d) => [d.dataset.skill || "", d.innerText.replace(/\s+/g, " ").trim()])),
          heads: [...panelEl.querySelectorAll(".skills-source")].map((h) => h.innerText.replace(/\s+/g, " ").trim()),
          sourcePaths: [...panelEl.querySelectorAll(".skills-source-path")].map((p) => p.innerText.replace(/\s+/g, " ").trim()),
          controls: panelEl.querySelectorAll("input, button, select, textarea").length,
          chips: [...panelEl.querySelectorAll(".skills-chip")].map((c) => c.textContent),
          bad: panelEl.querySelectorAll(".skills-source-path.bad").length,
        };
      });
      check(drawn.rows.length === rows.length, "one row per skill the route returned", `${drawn.rows.length} drawn vs ${rows.length} returned`);
      const drawnNames = drawn.rows.map((r) => r.name).sort();
      check(JSON.stringify(drawnNames) === JSON.stringify(rows.map((r) => r.name).sort()), "the same skills, by name", drawnNames.join(","));
      check(drawn.rows.every((r) => r.text.includes(r.name) && r.text.length > r.name.length), "each row shows its name and its own source/category chips",
        drawn.rows[0]?.text);
      check(Boolean(drawn.details.alpha) && /windmill/.test(drawn.details.alpha || "") && /SKILL\.md/.test(drawn.details.alpha || ""),
        "and the line under it carries the description and the path", (drawn.details.alpha || "").slice(0, 80));
      check(drawn.rows.find((r) => r.name === "delta")?.text.includes("link"), "a row behind the junction says link");
      check(drawn.rows.find((r) => r.name === "hidden")?.text.includes("not served"), "a row the gateway does not serve says so");
      check(drawn.rows.find((r) => r.name === "plugin:maker")?.source === "gateway", "the gateway-only skill is drawn under Gateway");
      check(drawn.heads.length === sources.length + 1, "one heading per source, plus the gateway's own", `${drawn.heads.length} headings for ${sources.length} sources`);
      check(drawn.sourcePaths.some((p) => /->|→/.test(p) && p.includes("team-skills")), "the junction's heading line names its target",
        drawn.sourcePaths.find((p) => p.includes("team-skills")));
      check(drawn.bad >= 1 && drawn.sourcePaths.some((p) => /does not exist/.test(p)), "an unreadable source draws its reason on the heading line",
        drawn.sourcePaths.find((p) => /does not exist/.test(p)));
      check(drawn.controls === 0, "the panel holds NO control — the tab is read only", `${drawn.controls} controls`);
      check(/^7 skills · \d+ sources/.test(drawn.summary) && /unverified|served/.test(drawn.summary), "the summary counts the rows", drawn.summary);
      check(drawn.gatewayLine.includes(gatewayUrl) && /\/v1\/skills/.test(drawn.gatewayLine),
        "and the line under it is the gateway's own answer", drawn.gatewayLine);

      // ---- G. the search reaches a skill by its description, and reveals the tab ------------------------------
      await page.click('[data-settings-tab="display"]');
      await page.click("#settings-search");
      await page.keyboard.type("windmill");
      await page.waitForTimeout(300);
      const searched = await page.evaluate(() => {
        const active = [...document.querySelectorAll("#settings [role='tab']")].find((t) => t.getAttribute("aria-selected") === "true");
        const row = [...document.querySelectorAll("#settings-panel-skills .skills-skill")].find((r) => r.dataset.skill === "alpha");
        const badge = active?.querySelector(".settings-tab-count");
        return {
          tab: active?.dataset.settingsTab || "",
          alphaShown: Boolean(row) && row.getClientRects().length > 0,
          count: (badge?.textContent || "").trim(),
          badgeShown: Boolean(badge) && !badge.hidden,
          visible: [...document.querySelectorAll("#settings-panel-skills .skills-skill")].filter((r) => r.getClientRects().length > 0).length,
        };
      });
      check(searched.tab === "skills", "a word in a DESCRIPTION reveals the Skills tab", searched.tab);
      check(searched.alphaShown, "and the row that carries it is on screen");
      check(searched.count === "1" && searched.visible === 1, "the tab's own count is the rows left on screen", `${searched.count} counted, ${searched.visible} visible`);
      check(searched.badgeShown, "the badge is on the tab while the query is on");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      const cleared = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("#settings-panel-skills .skills-skill")];
        return {
          tab: [...document.querySelectorAll("#settings [role='tab']")].find((t) => t.getAttribute("aria-selected") === "true")?.dataset.settingsTab || "",
          rows: rows.length,
          filtered: rows.filter((r) => r.classList.contains("search-hidden")).length,
          detailsStillHidden: document.querySelectorAll("#settings-panel-skills .skills-detail.search-hidden").length,
        };
      });
      check(cleared.tab === "display", "Esc clears the box and goes back to the reader's own tab", cleared.tab);
      check(cleared.rows === drawn.rows.length && cleared.filtered === 0 && cleared.detailsStillHidden === 0,
        "with no row left filtered — every skill and its detail line is back the next time the tab is opened",
        `${cleared.rows}/${drawn.rows.length} rows, ${cleared.filtered} filtered, ${cleared.detailsStillHidden} details hidden`);

      // ---- H. the tab is the one painted after a reload, before the panel is opened ---------------------------
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

      // ---- I. a failing gateway says why in the tab, and claims nothing --------------------------------------
      gatewayAnswer = { status: 500, body: { error: { message: "Failed to enumerate skills" } } };
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("#btn-settings", { timeout: 30_000 });
      await page.waitForTimeout(500);
      await page.click("#btn-settings");
      await page.waitForSelector("#settings:not(.hidden)", { timeout: 10_000 });
      await page.click('[data-settings-tab="skills"]');
      await page.waitForSelector("#settings-panel-skills .skills-skill", { timeout: 15_000 }).catch(() => {});
      const failing = await page.evaluate(() => ({
        summary: document.getElementById("skills-summary")?.textContent || "",
        gatewayLine: document.getElementById("skills-gateway")?.textContent || "",
        bad: document.getElementById("skills-gateway")?.classList.contains("bad"),
        unsent: document.querySelectorAll("#settings-panel-skills .skills-chip.unsent").length,
        rows: document.querySelectorAll("#settings-panel-skills .skills-skill").length,
      }));
      check(/unverified/.test(failing.summary), "with the gateway down the summary says the rows are unverified", failing.summary);
      check(/Failed to enumerate skills/.test(failing.gatewayLine) && failing.bad, "and the gateway line carries its own reason", failing.gatewayLine);
      check(failing.unsent === 0, "no row is branded 'not served' on an answer that never came", `${failing.unsent} marked`);
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
