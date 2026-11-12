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
  forgetOpenedFiles,
  openFileWith,
  openedFileKey,
  openerFor,
  regValue,
  resolveDefaultBrowser,
  REUSE_WINDOW_MS,
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
  forgetOpenedFiles();
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
  forgetOpenedFiles();
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

// ---- one window per file, for five minutes ---------------------------------------------------------------------
// The reader's complaint was a fresh Edge window for every "proved" page. The route now remembers the file it opened,
// keyed on the RESOLVED path, and answers a second open inside the window with `reused: true` instead of spawning
// again. These prove the book mark at the seam the route uses: an injected spawn that records every launch, and an
// injected clock, so the expiry is a number rather than a five-minute wait and no window is ever opened.

// The ladder a machine with no registered browser walks: rundll32 first, explorer.exe behind it. `answered` decides
// whether a launch STARTS or fails, so the failure path can be proved without a real browser.
function recordingSpawn(seen, answered = () => true) {
  return (bin, args) => {
    seen.push({ bin, args });
    return fakeChild(answered(bin), `spawn ${bin} ENOENT`);
  };
}

const plainLadder = { platform: "win32", env: {}, read: () => null, exists: () => false };

test("two opens of one file spawn once, and the second says it was a reuse rather than an open", async () => {
  forgetOpenedFiles();
  const seen = [];
  const spawn = recordingSpawn(seen);
  let clock = 1_000_000;
  const first = await openFileWith(report("report.html"), { ...plainLadder, spawn, now: () => clock });
  assert.equal(first.opened, true, "the first open is an open");
  assert.equal(first.reused, false);
  assert.equal(first.ageMs, 0);
  assert.equal(seen.length, 1, "the ladder stopped at the first launcher that started");

  clock += 60_000;
  // The SAME file spelled as a relative path against its own tree: the key is the resolved path, so this is the one
  // file the first call opened.
  const second = await openFileWith("./report.html", { ...plainLadder, base: REPORTS, spawn, now: () => clock });
  assert.equal(seen.length, 1, "a repeat inside five minutes must not spawn a second window");
  assert.equal(second.ok, true, "the file is still open, so the answer is not a failure");
  assert.equal(second.reused, true, "the caller can tell a reuse from an open");
  assert.equal(second.opened, false, "and it must not claim to have opened anything");
  assert.equal(second.key, first.key, "one resolved path, one key");
  assert.equal(second.ageMs, 60_000, "the answer says how long ago the open that put it on screen was");
  assert.equal(second.bin, first.bin, "the remembered launcher is named, so the row can say whose window it is");
  assert.equal(second.url, first.url);
  assert.deepEqual(second.tried, [], "nothing was tried this time");
  // The focus decision, as a fact a caller can read: no attempt was made, and the reason is in the answer rather than
  // in a comment the page cannot see.
  assert.equal(second.focus, "none");
  assert.match(second.focusWhy, /no focus attempted/, "a reuse says it did not try to raise the window");
  assert.match(second.focusWhy, /second window is the defect/, "and why: raising it would mean the window this fix removes");
  assert.equal(first.focusWhy, "", "a fresh open has no focus story to tell");
});

test("a different file still spawns", async () => {
  forgetOpenedFiles();
  const seen = [];
  const spawn = recordingSpawn(seen);
  let clock = 1_000_000;
  const one = await openFileWith(report("one.html"), { ...plainLadder, spawn, now: () => clock });
  assert.equal(one.opened, true);
  clock += 1_000;
  const two = await openFileWith(report("two.html"), { ...plainLadder, spawn, now: () => clock });
  assert.equal(two.opened, true, "another file is another window");
  assert.equal(two.reused, false);
  assert.notEqual(two.key, one.key);
  assert.equal(seen.length, 2);
});

test("the five-minute window expires, and the next open spawns again", async () => {
  forgetOpenedFiles();
  const seen = [];
  const spawn = recordingSpawn(seen);
  const openedAt = 5_000_000;
  await openFileWith(report("report.html"), { ...plainLadder, spawn, now: () => openedAt });
  const inside = await openFileWith(report("report.html"), { ...plainLadder, spawn, now: () => openedAt + REUSE_WINDOW_MS - 1 });
  assert.equal(inside.reused, true, "one millisecond inside the window is still a reuse");
  assert.equal(seen.length, 1);
  const after = await openFileWith(report("report.html"), { ...plainLadder, spawn, now: () => openedAt + REUSE_WINDOW_MS });
  assert.equal(after.reused, false, "the window measured from the OPEN has closed");
  assert.equal(after.opened, true, "so a reader who is looking at a rewritten page gets the new one");
  assert.equal(seen.length, 2);
});

test("a failed ladder is not remembered, so a retry still spawns", async () => {
  forgetOpenedFiles();
  const seen = [];
  const failing = recordingSpawn(seen, () => false);
  const failed = await openFileWith(report("report.html"), { ...plainLadder, spawn: failing, now: () => 1_000 });
  assert.equal(failed.ok, false);
  assert.equal(failed.reused, false);
  const retried = await openFileWith(report("report.html"), { ...plainLadder, spawn: recordingSpawn(seen), now: () => 2_000 });
  assert.equal(retried.opened, true, "a window that never appeared must not be remembered as open");
  assert.equal(retried.reused, false);
});

test("the key is the resolved path, lower-cased on Windows, never the string that was handed over", () => {
  const abs = path.resolve(REPORTS, "report.html");
  assert.equal(openedFileKey(abs, { platform: "win32" }), abs.toLowerCase(), "NTFS is case-insensitive, so two spellings are one file");
  assert.equal(openedFileKey(`${REPORTS}/./x/../report.html`, { platform: "win32" }), abs.toLowerCase(), "a dot segment is resolved away");
  assert.equal(openedFileKey(abs, { platform: "linux" }), abs, "a case-sensitive filesystem keeps the case it was given");
});
