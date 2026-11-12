// Opening a link in the OS default browser without letting a command interpreter see it.
//
// This route used to run `cmd.exe /c start "" <url>`. execFile avoids a shell, but cmd.exe re-parses
// its own command line, and Node's Windows quoting leaves `&` alone because the C runtime rules do
// not require quotes around it — so `https://x/?a=1&calc.exe` reached cmd as two commands. Validating
// the URL cannot fix that: `&` is legal inside a query string, and percent-encoding it changes the URL
// the browser is asked to open.
//
// So no interpreter at all: the URL travels as one CreateProcess argument. `explorer.exe` is the
// shell's own URL opener on Windows (it hands the string to ShellExecute, which picks the default
// browser), `open` does the same on macOS, `xdg-open` elsewhere. None of the three reads a command
// line as a script.
//
// explorer.exe reports an exit code before the browser has started, so a caller must answer from the
// spawn, not from the child's exit: waiting on it would report a failure for a link that opened.
//
// What THIS module opens, and what it must not: a link (http/https, above), a folder, and - further down -
// a delivered local file. The file is the one case explorer.exe got wrong; the reasoning is beside
// `fileOpenerLadder`.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Returns { url, error }: exactly one is null. The two messages are the ones the page already shows.
export function safeUrl(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw || "").trim());
  } catch {
    return { url: null, error: "not a URL" };
  }
  // A URL object accepts `file:`, `javascript:` and custom schemes; this hands a string to the
  // operating system, so only the two protocols a console link can mean are allowed through.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { url: null, error: "only http(s) links can be opened" };
  }
  return { url: parsed.toString(), error: null };
}

// One argv element, no shell. `platform` is a parameter so the Windows path is testable off Windows.
export function openerFor(url, platform = process.platform) {
  if (platform === "win32") return { bin: "explorer.exe", args: [url] };
  if (platform === "darwin") return { bin: "open", args: [url] };
  return { bin: "xdg-open", args: [url] };
}

// Chrome, for a DELIVERED LINK only (a file or an image already has `openerFor`, and that is ShellExecute — the
// program this machine uses for that suffix). A link delivered to a research agent's own dev server belongs in a
// real browser with the reader's session, not in whatever owns `.html` this month.
//
// `null` when no Chrome is found, and the CALLER falls back to `openerFor`: a missing Chrome must not become a
// missing deliverable. The route's answer says `chrome: false`, which the page turns into one banner line.
//
// No flags: Chrome reuses its window and opens a tab, so the reader keeps the session he had. The candidates are
// files, checked with `exists` (injectable, so the off-Windows branch is testable); elsewhere the binary is looked up
// on PATH by the OS itself, which is a spawn concern and not a file test.
export function chromeFor(url, { platform = process.platform, env = process.env, exists = existsSync } = {}) {
  const target = String(url || "");
  if (!target) return null;
  const candidates = [];
  if (platform === "win32") {
    if (env.CHROME_PATH) candidates.push(env.CHROME_PATH);
    if (env.ProgramFiles) candidates.push(path.join(env.ProgramFiles, "Google/Chrome/Application/chrome.exe"));
    if (env["ProgramFiles(x86)"]) candidates.push(path.join(env["ProgramFiles(x86)"], "Google/Chrome/Application/chrome.exe"));
    if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"));
    for (const bin of candidates) {
      try {
        if (bin && exists(bin)) return { bin, args: [target] };
      } catch {
        /* an unreadable candidate is not a found one */
      }
    }
    return null;
  }
  if (platform === "darwin") {
    const bin = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    try {
      return exists(bin) ? { bin, args: [target] } : null;
    } catch {
      return null;
    }
  }
  return { bin: "google-chrome", args: [target] };
}

// The same three launchers open a FOLDER, and the same rule applies: one argv element, no interpreter in
// between. A directory that does not exist is a 400 at the route, never a shell that says so.
export function openerForFolder(target, platform = process.platform) {
  const dir = String(target || "");
  if (!dir) return { bin: null, args: [], error: "no folder to open" };
  return { ...openerFor(dir, platform), error: null };
}

// ---- a DELIVERED FILE, handed to the browser this machine actually uses ----------------------------------
// `openerFor` above is right for a folder and for a link: `explorer.exe` hands the string to ShellExecute.
// It is wrong for a local file, and the fault was measurable rather than theoretical: the store keeps its
// paths with forward slashes, explorer.exe answers 1 for that spelling and opens nothing at all, while the
// same file with backslashes opens the reader's browser. No exit code is reportable either, so the card said
// `opened report.html with explorer.exe` over a window that never appeared.
//
// So a file is opened three ways, in this order and no other:
//   1. the browser this machine is REGISTERED to use for a web page, resolved from the registry;
//   2. `rundll32.exe url.dll,FileProtocolHandler <file:///...>` - the shell's own protocol handler;
//   3. `explorer.exe <file:///...>` - the opener this route has always used.
// Each step gets ONE argv element and no interpreter: an `&` in a file name is a character in a path, and
// nothing between here and the browser parses a command line.

// ---- what a target is relative TO -----------------------------------------------------------------------
// A target from a card is absolute (it names its own root: a drive letter, a leading slash, a UNC share) or it is
// relative to SOMETHING. That something is the asking turn's own tree, and only the card knows it - it rides the
// question record as `base` and the POST body beside the path.
//
// The rule this replaces was a guess: `path.resolve(raw)` resolves against THIS PROCESS'S cwd, which is the panel's
// own checkout, and the route tried every project root in turn. Measured on a real card: the reader clicked
// `docs/reports/rebuild-phase_status.html`, the run that asked was in `.worktrees/report-one`, and the panel went
// looking in the project's checkout and answered "no such file" for a file that was sitting in that run's tree.
//
// So a relative target with no base is an ERROR, not a default. Guessing can open the wrong file, which is worse
// than saying which half is missing.
export function resolveFileTarget(target, base = "") {
  const raw = String(target || "").trim();
  if (!raw) return { path: null, error: "no file to open" };
  if (path.isAbsolute(raw)) return { path: path.resolve(raw), error: null };
  const root = String(base || "").trim();
  if (!root) {
    return { path: null, error: `relative path with no base: ${raw} - the card has to say which tree it is relative to` };
  }
  if (!path.isAbsolute(root)) {
    return { path: null, error: `the base is not an absolute path: ${root}` };
  }
  return { path: path.resolve(root, raw), error: null };
}

// A local path as a file:/// URL: forward slashes, the drive letter in the authority position (three
// separators, then `C:`), spaces and every non-ASCII character percent-encoded (UTF-8), and `#`/`%` escaped so
// a file name cannot turn into a fragment or an escape. Node's own pathToFileURL is that conversion and is the
// one Windows agrees with.
// `&` is legal in a path and stays literal: it is inert because the URL is one argv element, and encoding
// it would ask the browser for a different file name than the one on disk.
// `base` is the tree a relative target belongs to; a relative target with no base resolves to null (see above).
export function fileUrlFor(target, base = "") {
  const resolved = resolveFileTarget(target, base);
  if (resolved.error) return null;
  return pathToFileURL(resolved.path).href;
}

// `reg query` is how Windows hands a key to a process that is not a shell: it is an executable with argv,
// not an interpreter reading a string. A missing key answers null, never an exception.
function readRegistry(key, value = null) {
  try {
    const args = ["query", key];
    if (value) args.push("/v", value);
    else args.push("/ve");
    const out = execFileSync("reg.exe", args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return String(out || "");
  } catch {
    return null;
  }
}

// The one value out of a `reg query` listing: `    ProgId    REG_SZ    MSEdgeHTM` -> `MSEdgeHTM`. A
// REG_EXPAND_SZ is read as its unexpanded text; `exeFromCommand` expands the variables it can name.
export function regValue(text) {
  // Line endings are split without a regex escape: this file is read on Windows, where the listing
  // reg.exe prints carries CRLF, and an escape written into the source has more ways to be wrong than
  // a character code does.
  const lines = String(text || "").replaceAll(String.fromCharCode(13), "").split(String.fromCharCode(10));
  for (const line of lines) {
    const m = line.match(/^\s+(.+?)\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/);
    if (m) return m[2].trim() || null;
  }
  return null;
}

export function exeFromCommand(command, env = process.env) {
  const cmd = String(command || "").trim();
  if (!cmd) return null;
  let exe;
  if (cmd.startsWith('"')) {
    const end = cmd.indexOf('"', 1);
    if (end < 0) return null;
    exe = cmd.slice(1, end);
  } else {
    const space = cmd.search(/\s/);
    exe = space < 0 ? cmd : cmd.slice(0, space);
  }
  exe = exe.replace(/%([^%]+)%/g, (all, name) => (env && env[name]) || all).trim();
  return exe || null;
}

// The browser this machine is registered to use for a web page, and the executable that ProgID names.
// Windows keeps that answer in HKCU ...\UrlAssociations\<scheme>\UserChoice's `ProgId` - the same value the
// Settings app writes - and the ProgID's own open command in HKCU\Software\Classes (a per-user install) or
// HKCR (a machine-wide one). Nothing here knows an install path: `ChromeHTML` and `MSEdgeHTM` are the two
// common spellings, and a third one (a Beta channel, Firefox, a portable build) resolves the same way as
// long as its command names an executable that exists.
//
// `null` when nothing resolves, and the CALLER falls back down the ladder: an unregistered machine must not
// become an unopenable deliverable.
export function resolveDefaultBrowser({ platform = process.platform, env = process.env, exists = existsSync, read = readRegistry } = {}) {
  if (platform !== "win32") return null;
  const choices = [
    "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice",
    "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice",
  ];
  for (const key of choices) {
    const progId = regValue(read(key, "ProgId"));
    if (!progId) continue;
    for (const root of ["HKCU\\Software\\Classes\\", "HKCR\\"]) {
      const exe = exeFromCommand(regValue(read(`${root}${progId}\\shell\\open\\command`)), env);
      if (!exe) continue;
      try {
        if (exists(exe)) return { progId, bin: exe };
      } catch {
        /* an unreadable path is not a found browser */
      }
    }
  }
  return null;
}

// The three launchers for a delivered file, in order, each with the SAME file:/// URL as its single
// argument. Pure: the route walks this list, so the order is asserted here rather than in a comment.
export function fileOpenerLadder(target, { platform = process.platform, env = process.env, exists = existsSync, read = readRegistry, base = "" } = {}) {
  const url = fileUrlFor(target, base);
  if (!url) return [];
  if (platform !== "win32") {
    return [{ ...openerFor(url, platform), via: platform === "darwin" ? "open" : "xdg-open", url }];
  }
  // `rundll32` and `explorer` are named bare: both live in %SystemRoot%\System32, which the OS resolves
  // for a spawn. Only the browser needs a path, because its install root is a choice this machine made.
  const steps = [];
  const browser = resolveDefaultBrowser({ platform, env, exists, read });
  if (browser) steps.push({ bin: browser.bin, args: [url], via: "default browser", progId: browser.progId, url });
  steps.push({ bin: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url], via: "rundll32 FileProtocolHandler", url });
  steps.push({ bin: "explorer.exe", args: [url], via: "explorer.exe", url });
  return steps;
}

// The name a reader would recognise for a browser executable: the machine's registry says `chrome.exe` and the card
// should say `Google Chrome`. Only the four channels an SEFL machine actually runs are spelled out; anything else
// (a portable build, a browser installed after this list was written) is named by its own file, which is still true.
// `null` in, "" out - the caller then says "your browser", which is what an unknown one is.
const BROWSER_LABELS = {
  "chrome.exe": "Google Chrome",
  "msedge.exe": "Microsoft Edge",
  "firefox.exe": "Firefox",
  "brave.exe": "Brave",
  "opera.exe": "Opera",
  "vivaldi.exe": "Vivaldi",
};

export function browserLabel(bin) {
  const base = String(bin || "").replace(/\\/g, "/").split("/").pop().toLowerCase();
  if (!base) return "";
  if (BROWSER_LABELS[base]) return BROWSER_LABELS[base];
  const stem = base.replace(/\.exe$/i, "");
  return stem ? stem.charAt(0).toUpperCase() + stem.slice(1) : "";
}

// ---- one open per file per five minutes ---------------------------------------------------------------
// The reader gets a fresh Edge window from two places, and this is the first: every "prove the page" click asked
// the OS for the file again, so the registered browser started a second window for a file it was already showing.
// A page opened twice in five minutes is one window; the second answer is a REUSE, not a spawn.
//
// THE KEY IS THE RESOLVED PATH, never the string the caller handed over. `docs/reports/x.html` sent with a base and
// the same path written out from the drive root are one file, and `./x/../reports/x.html` is that file again: keying
// on the raw string would let a caller walk around the book mark by spelling the path differently. `resolveFileTarget`
// is the one resolver (absolute as given, relative against the card's base, error otherwise), so the key is its answer.
// On win32 the key is lower-cased because the filesystem is case-insensitive - `Report.HTML` and `report.html` are
// one file there, and two entries for it would be two windows. A symlink or an 8.3 short name is a DIFFERENT key:
// `realpath` would be a disk call on every open, and the panel has already stat'ed the file by the time it gets
// here. That limit is stated rather than hidden.
export const REUSE_WINDOW_MS = 5 * 60_000;

const openedRecently = new Map(); // key -> { at, bin, via, progId, url, fallback }

export function openedFileKey(resolvedPath, { platform = process.platform } = {}) {
  const abs = path.resolve(String(resolvedPath || ""));
  return platform === "win32" ? abs.toLowerCase() : abs;
}

// The book mark, emptied. Every openFileWith caller in a test process shares this module, so a test that opens one
// file twice on purpose (two spawns, or a failure then a retry) starts from here instead of inheriting a neighbour's
// window.
export function forgetOpenedFiles() {
  openedRecently.clear();
}

// ---- FOCUS: the decision, with its reasons ----------------------------------------------------------------
// A reuse does NOT try to raise the window that already holds the file, and it says so. On Windows this process
// cannot raise an existing TAB honestly:
//   * the reader's registered browser exposes no debug port - that is exactly what a scratch `--user-data-dir` was
//     for, and giving the panel one would mean launching a second browser to hold it, which is the defect;
//   * relaunching the browser "to bring it forward" opens another tab or another window (Chrome and Edge both add a
//     tab for a URL; the skill that told agents to do this says so), so it is the bug wearing a focus's clothes;
//   * matching a window by title and calling SetForegroundWindow can raise the reader's OWN window with the same
//     page, or a console, and it steals focus while the reader is typing - a claim about the screen made from a
//     guess.
// A silent no-op would be worse than silence only if it claimed a window, so the answer carries `opened: false`,
// `reused: true`, `focus: "none"` and this reason (`focusWhy`). The field stays in the shape so a platform that CAN
// do it (a later, measured attempt) has somewhere to land without a second return type.
const FOCUS_NONE_WHY =
  "no focus attempted: Windows has no way to raise the tab already showing this file without a scratch profile or a title search that can raise the wrong window, and a second window is the defect";

export function focusExistingFile() {
  return { attempted: false, focus: "none", why: FOCUS_NONE_WHY };
}

// Walk that ladder and stop at the first step that actually STARTS. A spawn that fails fires `error`
// before `spawn` (ENOENT for a browser that was moved, EACCES for one this process may not start), so the
// answer is which step started - not a guess about whether a window appeared, which no spawn can report.
// `spawn` is injected so the ladder is provable without launching anything; the route passes Node's own.
// `now` and `reuseMs` are the clock and the window: the default is five minutes of wall clock, and a test proves the
// expiry by moving `now` rather than sleeping. `reuseMs: 0` turns the book mark off for a caller that wants every
// call to spawn.
export async function openFileWith(target, { spawn: launch, log = () => {}, now = Date.now, reuseMs = REUSE_WINDOW_MS, ...opts } = {}) {
  // The base is resolved BEFORE the ladder is built: a relative target with no base has no URL to hand anyone, and
  // the reason it does not is the sentence the reader needs ("the card has to say which tree"), not "no file to open".
  const resolved = resolveFileTarget(target, opts.base);
  if (resolved.error) return { ok: false, tried: [], url: null, error: resolved.error };
  const key = openedFileKey(resolved.path, opts);
  const at = typeof now === "function" ? Number(now()) || Date.now() : Number(now) || Date.now();
  // Expired entries go before the lookup, so the Map cannot grow for the life of the process: one file opened once
  // is one entry that is gone by the next open after its window. The window measures the OPEN, not the last reuse -
  // a file asked for repeatedly is still a fresh spawn after five minutes, which is what lets a reader see a page
  // that has since been rewritten.
  for (const [seenKey, seen] of openedRecently) {
    if (at - seen.at >= REUSE_WINDOW_MS) openedRecently.delete(seenKey);
  }
  const remembered = reuseMs > 0 ? openedRecently.get(key) : null;
  if (remembered && at - remembered.at < reuseMs) {
    const focus = focusExistingFile(resolved.path, opts);
    return {
      // `opened: false` is the fact the card needs: nothing was launched this time. `ok` is still true because the
      // file IS in front of the reader - the first open is what put it there - and a caller that only reads `ok`
      // (an older caller) behaves exactly as before instead of reporting a failure for a page that is already up.
      ok: true,
      opened: false,
      reused: true,
      key,
      path: resolved.path,
      bin: remembered.bin,
      via: remembered.via,
      progId: remembered.progId || null,
      fallback: remembered.fallback,
      url: remembered.url,
      ageMs: Math.max(0, at - remembered.at),
      focus: focus.focus,
      focusWhy: focus.why,
      tried: [],
    };
  }
  const steps = fileOpenerLadder(resolved.path, opts);
  const tried = [];
  if (!steps.length) return { ok: false, tried, url: null, error: "no file to open" };
  for (const step of steps) {
    const started = await new Promise((resolve) => {
      let done = false;
      let child;
      try {
        child = launch(step.bin, step.args, { detached: true, stdio: "ignore", windowsHide: true });
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e) });
        return;
      }
      if (!child || typeof child.once !== "function") {
        resolve({ ok: true });
        return;
      }
      child.once("spawn", () => {
        if (done) return;
        done = true;
        try {
          child.unref();
        } catch {
          /* an already-exited child is not a failure to launch */
        }
        resolve({ ok: true });
      });
      child.once("error", (e) => {
        if (done) return;
        done = true;
        resolve({ ok: false, error: String((e && e.message) || e) });
      });
    });
    tried.push({ bin: step.bin, via: step.via, ok: started.ok, error: started.error });
    if (started.ok) {
      // Only a spawn that STARTED is remembered: a failed ladder (a moved browser, a permission refusal) must not
      // make the next click answer "already open" for a window that never appeared.
      if (reuseMs > 0) {
        openedRecently.set(key, { at, bin: step.bin, via: step.via, progId: step.progId || null, url: step.url, fallback: tried.length - 1 });
      }
      // A fresh open needs no focus story: the window it just started is the one in front. `focus` is still answered
      // so the route's shape does not change with the branch, and `focusWhy` is empty rather than explaining a
      // decision nothing had to make.
      return {
        ok: true,
        // The two words a caller can tell apart: this call opened it, and a later one may not.
        opened: true,
        reused: false,
        key,
        path: resolved.path,
        bin: step.bin,
        via: step.via,
        progId: step.progId || null,
        url: step.url,
        ageMs: 0,
        focus: "none",
        focusWhy: "",
        // How many launchers this answer cost: 0 means the resolved browser took it, 1 and 2 name the
        // fallback the reader is told about.
        fallback: tried.length - 1,
        tried,
      };
    }
    log(`could not open ${target} with ${step.bin}: ${started.error}`);
  }
  return { ok: false, opened: false, reused: false, tried, url: steps[steps.length - 1].url, error: tried.map((t) => `${t.bin}: ${t.error}`).join("; ") };
}

