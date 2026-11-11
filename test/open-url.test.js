// /api/open-url hands a URL to the operating system. The old opener was `cmd.exe /c start "" <url>`,
// which made cmd the parser of a string the caller controls. These assert the mechanism: no
// interpreter, and the URL stays one argument.
//
// The second half is a DELIVERED FILE, which is a different opener: the reader's registered browser,
// then rundll32's FileProtocolHandler, then explorer.exe - in that order and no other. Measured before
// the fix: the store's forward-slash path made explorer.exe answer 1 and open nothing at all, while the
// same file with backslashes opened the reader's browser.
//
// Every fixture below is built from a repo-relative root at run time. A test that names a folder on the
// machine that wrote it only runs on that machine (tools/absolute-paths.mjs refuses the drive letter, and
// it is right to): where a browser is installed is a fact about a machine, not about this resolver.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import {
  exeFromCommand,
  fileOpenerLadder,
  fileUrlFor,
  openFileWith,
  openerFor,
  regValue,
  resolveDefaultBrowser,
  safeUrl,
} from "../lib/open-url.js";
import { post, startPanel } from "../tools/panel-testkit.mjs";

// A URL that is also a command injection if anything re-parses it as a command line.
const HOSTILE = "http://127.0.0.1:9/?a=1&calc.exe&b=2";

test("windows opens with explorer.exe, and never cmd.exe", () => {
  const { bin, args } = openerFor(HOSTILE, "win32");
  assert.equal(bin, "explorer.exe");
  assert.doesNotMatch(bin, /cmd(\.exe)?$/i, "cmd.exe re-parses its command line: a URL must never reach it");
});

test("the URL is one argv element on every platform", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    const { args } = openerFor(HOSTILE, platform);
    assert.equal(args.length, 1, `${platform}: the URL must not be split into extra arguments`);
    assert.equal(args[0], HOSTILE, `${platform}: the whole URL is the argument, metacharacters included`);
  }
});

test("only http(s) leaves the server, and the refusal keeps its two sentences", () => {
  assert.equal(safeUrl("https://example.com/a?b=1&c=2").url, "https://example.com/a?b=1&c=2");
  assert.equal(safeUrl("file:///C:/Windows/System32/calc.exe").error, "only http(s) links can be opened");
  assert.equal(safeUrl("javascript:alert(1)").error, "only http(s) links can be opened");
  assert.equal(safeUrl("not a url").error, "not a URL");
});

test("the route refuses the same URL the opener would", async (t) => {
  const panel = await startPanel();
  t.after(() => panel.stop());
  const r = await post(panel.base, "/api/open-url", { body: { url: "file:///C:/Windows/System32/calc.exe" } });
  assert.equal(r.status, 400);
  assert.equal(r.json?.error, "only http(s) links can be opened");
});

// ---- a delivered file -----------------------------------------------------------------------------------------

const HTTP_CHOICE = "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice";
const HTTPS_CHOICE = "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice";

// The delivered report's folder, and the install paths a profile can register for a browser: two with a space
// in the path, one without - which is what `shell\open\command` quotes. Both are built at run time.
const REPORTS = path.resolve("docs", "reports");
const URL_ROOT = `file:///${REPORTS.replaceAll("\\", "/")}`;
const report = (name) => path.join(REPORTS, name);
const CHROME = path.join(REPORTS, "Google", "Chrome", "Application", "chrome.exe");
const EDGE = path.join(REPORTS, "Microsoft", "Edge", "Application", "msedge.exe");
const FIREFOX = path.join(REPORTS, "Mozilla Firefox", "firefox.exe");

// A registry that answers exactly the keys a case names, and null for everything else - which is what
// `reg query` does for a key that is not there.
function registry(rules) {
  return (key, value) => {
    const full = value ? `${key}|${value}` : key;
    return Object.prototype.hasOwnProperty.call(rules, full) ? rules[full] : null;
  };
}

// The listing `reg query <key> /v ProgId` prints, in shape: leading spaces, the type, the value.
function listing(name, value) {
  return [`HKEY_CURRENT_USER\\${name}`, `    ${name}    REG_SZ    ${value}`, ""].join(String.fromCharCode(10));
}

// The listing `reg query <class>\\shell\\open\\command /ve` prints: an unnamed (Default) value.
function commandListing(command) {
  return ["HKEY_CLASSES_ROOT\\shell\\open\\command", `    (Default)    REG_SZ    ${command}`, ""].join(String.fromCharCode(10));
}

// One registration: the UserChoice naming a ProgID, and that ProgID's own open command.
function registration(progId, command, { scheme = "http", perUser = false } = {}) {
  const choice = scheme === "https" ? HTTPS_CHOICE : HTTP_CHOICE;
  const root = perUser ? "HKCU\\Software\\Classes\\" : "HKCR\\";
  return registry({
    [`${choice}|ProgId`]: listing("UserChoice", progId),
    [`${root}${progId}\\shell\\open\\command`]: commandListing(command),
  });
}

test("a ProgID's open command yields its executable, and not the command's own arguments", () => {
  assert.equal(exeFromCommand(`"${EDGE}" --single-argument %1`), EDGE, "the quoted path is the executable");
  assert.equal(exeFromCommand(`${CHROME} %1`), CHROME, "unquoted is legal in the registry and ends at the first space");
  // A per-user install may spell its root as a variable, and the environment is what expands it.
  assert.equal(
    exeFromCommand("%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe %1", { LOCALAPPDATA: path.join(REPORTS, "Local") }),
    path.join(REPORTS, "Local", "Google", "Chrome", "Application", "chrome.exe"),
  );
  assert.equal(exeFromCommand(""), null);
  assert.equal(exeFromCommand('"unterminated'), null);
});

test("regValue reads the one value out of a query listing, and null when the key is absent", () => {
  assert.equal(regValue(listing("UserChoice", "MSEdgeHTM")), "MSEdgeHTM");
  assert.equal(regValue(commandListing(`"${CHROME}" --single-argument %1`)), `"${CHROME}" --single-argument %1`);
  assert.equal(regValue(null), null);
  assert.equal(regValue("ERROR: The system was unable to find the specified registry key or value."), null);
});

// One case per registered ProgID a machine can carry: the two Windows spellings, and a third that is none of
// them - the resolver must not be a whitelist of two names, it must read what the profile registered.
for (const [progId, exe] of [
  ["ChromeHTML", CHROME],
  ["MSEdgeHTM", EDGE],
  ["FirefoxHTML-308046B0AF4A39CB", FIREFOX],
]) {
  test(`the resolver takes ${progId} and maps it to the executable its own command names`, () => {
    const read = registration(progId, `"${exe}" --single-argument %1`);
    const found = resolveDefaultBrowser({ platform: "win32", env: {}, read, exists: (p) => p === exe });
    assert.deepEqual(found, { progId, bin: exe });
  });
}

test("a ProgID the profile did not register does not resolve, and the caller falls back", () => {
  // http names a ProgID whose open command is missing entirely.
  const noCommand = registry({ [`${HTTP_CHOICE}|ProgId`]: listing("UserChoice", "MSEdgeHTM") });
  assert.equal(resolveDefaultBrowser({ platform: "win32", env: {}, read: noCommand, exists: () => true }), null);

  // ...and one whose command names an executable that is not on this machine any more.
  const gone = registration("ChromeHTML", `"${CHROME}" --single-argument %1`);
  assert.equal(resolveDefaultBrowser({ platform: "win32", env: {}, read: gone, exists: () => false }), null);

  // ...while the SAME registration resolves the moment that executable is there: the null above is the
  // missing file, not a resolver that never answers.
  assert.deepEqual(resolveDefaultBrowser({ platform: "win32", env: {}, read: gone, exists: (p) => p === CHROME }), {
    progId: "ChromeHTML",
    bin: CHROME,
  });

  // No UserChoice at all - a profile that has never chosen a browser.
  assert.equal(resolveDefaultBrowser({ platform: "win32", env: {}, read: () => null, exists: () => true }), null);
});

test("https is read when http has no UserChoice, and HKCU's per-user class wins over HKCR", () => {
  const viaHttps = registration("MSEdgeHTM", `"${EDGE}" --single-argument %1`, { scheme: "https" });
  assert.deepEqual(resolveDefaultBrowser({ platform: "win32", env: {}, read: viaHttps, exists: (p) => p === EDGE }), {
    progId: "MSEdgeHTM",
    bin: EDGE,
  });

  const stale = path.join(REPORTS, "Stale", "chrome.exe");
  const perUser = registry({
    [`${HTTP_CHOICE}|ProgId`]: listing("UserChoice", "ChromeHTML"),
    ["HKCU\\Software\\Classes\\ChromeHTML\\shell\\open\\command"]: commandListing(`"${CHROME}" --single-argument %1`),
    ["HKCR\\ChromeHTML\\shell\\open\\command"]: commandListing(`"${stale}" --single-argument %1`),
  });
  assert.equal(
    resolveDefaultBrowser({ platform: "win32", env: {}, read: perUser, exists: (p) => p === CHROME }).bin,
    CHROME,
    "a per-user install is what the profile registered, so its command is the one to read",
  );
});

test("a local path becomes a file:/// URL: drive letter, forward slashes, spaces and non-ASCII encoded", () => {
  // The drive-letter form, asserted without naming a drive in this file: file:/// then `<letter>:` then a slash.
  assert.match(`${URL_ROOT}/report.html`, /^file:\/\/\/[A-Za-z]:\//);
  assert.equal(fileUrlFor(report("report.html")), `${URL_ROOT}/report.html`);
  // Both spellings of the same path are one URL: the store keeps forward slashes, Node hands back slashes.
  assert.equal(fileUrlFor(REPORTS.replaceAll("\\", "/") + "/report.html"), `${URL_ROOT}/report.html`);
  assert.equal(fileUrlFor(report("a b.html")), `${URL_ROOT}/a%20b.html`, "a space is percent-encoded");
  assert.equal(fileUrlFor(report("café-résumé.html")), `${URL_ROOT}/caf%C3%A9-r%C3%A9sum%C3%A9.html`, "non-ASCII is UTF-8 percent-encoded");
  // `#` and `%` are the two characters that would change WHICH file the URL names.
  assert.equal(fileUrlFor(report("x#y.html")), `${URL_ROOT}/x%23y.html`);
  assert.equal(fileUrlFor(report("100%.html")), `${URL_ROOT}/100%25.html`);
  assert.equal(fileUrlFor(""), null);
});

test("the ladder is the registered browser, then rundll32 FileProtocolHandler, then explorer.exe", () => {
  const read = registration("ChromeHTML", `"${CHROME}" --single-argument %1`);
  const steps = fileOpenerLadder(report("report.html"), { platform: "win32", env: {}, read, exists: (p) => p === CHROME });
  assert.deepEqual(steps.map((s) => s.bin), [CHROME, "rundll32.exe", "explorer.exe"]);
  assert.deepEqual(steps.map((s) => s.via), ["default browser", "rundll32 FileProtocolHandler", "explorer.exe"]);
  assert.equal(steps[0].progId, "ChromeHTML", "the answer names the ProgID that was registered");
  // The URL, and only the URL: no shell template, no --single-argument, one argv element.
  assert.deepEqual(steps[0].args, [`${URL_ROOT}/report.html`]);
  assert.deepEqual(steps[1].args, ["url.dll,FileProtocolHandler", `${URL_ROOT}/report.html`]);
  assert.deepEqual(steps[2].args, [`${URL_ROOT}/report.html`]);
  for (const s of steps) assert.doesNotMatch(s.bin, /^(cmd|powershell|wscript|cscript)/i, "no interpreter is in the ladder");
});

test("with no browser resolved the ladder starts at rundll32, and explorer.exe is still last", () => {
  const steps = fileOpenerLadder(report("report.html"), { platform: "win32", env: {}, read: () => null, exists: () => false });
  assert.deepEqual(steps.map((s) => s.bin), ["rundll32.exe", "explorer.exe"]);
});

test("an ampersand and a space in a file name stay characters in ONE argv element", () => {
  const target = report("AT&T report.html");
  const steps = fileOpenerLadder(target, { platform: "win32", env: {}, read: () => null, exists: () => false });
  const first = steps[0];
  assert.equal(first.args.length, 2, "rundll32 takes its entry point plus the URL");
  assert.equal(first.args[1], `${URL_ROOT}/AT&T%20report.html`, "& is legal in a path, so it is not escaped; the space is");
  assert.equal(first.args[1].split("&").length, 2, "the & never arrives as a second argument: nothing parses this URL");
  // The same file with a resolved browser is exactly one argument.
  const read = registration("ChromeHTML", `"${CHROME}" --single-argument %1`);
  const one = fileOpenerLadder(target, { platform: "win32", env: {}, read, exists: (p) => p === CHROME });
  assert.equal(one[0].args.length, 1);
  assert.equal(one[0].args[0], `${URL_ROOT}/AT&T%20report.html`);
});

// A child stub that answers the two events a real spawn does: `spawn` when the process started, `error`
// when it could not (ENOENT for a browser that was moved).
function fakeChild(started, message) {
  const child = new EventEmitter();
  child.unref = () => {};
  setImmediate(() => (started ? child.emit("spawn") : child.emit("error", new Error(message))));
  return child;
}

test("a launcher that cannot start hands over to the next, and the answer names the fallback", async () => {
  const read = registration("ChromeHTML", `"${CHROME}" --single-argument %1`);
  const seen = [];
  const out = await openFileWith(report("report.html"), {
    platform: "win32",
    env: {},
    read,
    exists: (p) => p === CHROME,
    spawn: (bin, args) => {
      seen.push([bin, args]);
      return fakeChild(bin !== CHROME, "spawn chrome.exe ENOENT");
    },
  });
  assert.deepEqual(seen.map((s) => s[0]), [CHROME, "rundll32.exe"], "the next step is the first fallback, not the last");
  assert.equal(out.ok, true);
  assert.equal(out.bin, "rundll32.exe");
  assert.equal(out.via, "rundll32 FileProtocolHandler");
  assert.equal(out.fallback, 1, "the reader is told a fallback fired, and which one");
  assert.deepEqual(out.tried.map((t) => [t.bin, t.ok]), [[CHROME, false], ["rundll32.exe", true]]);
  assert.equal(out.url, `${URL_ROOT}/report.html`);
});

test("every launcher failing is reported with each reason, never as a silent success", async () => {
  const out = await openFileWith(report("report.html"), {
    platform: "win32",
    env: {},
    read: () => null,
    exists: () => false,
    spawn: (bin) => fakeChild(false, `spawn ${bin} ENOENT`),
  });
  assert.equal(out.ok, false);
  assert.deepEqual(out.tried.map((t) => t.bin), ["rundll32.exe", "explorer.exe"]);
  assert.match(out.error, /rundll32\.exe: spawn rundll32\.exe ENOENT/);
  assert.match(out.error, /explorer\.exe: spawn explorer\.exe ENOENT/);
});
