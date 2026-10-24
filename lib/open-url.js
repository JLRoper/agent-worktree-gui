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
