// The panel's one logger: five levels as incrementing tiers, one shared switch.
//
//   trace 10  <  debug 20  <  info 30  <  warn 40  <  error 50      (the standard pino/bunyan numbers)
//
// A line is emitted when its number is >= the configured level's number, so "info" shows
// info/warn/error and hides debug/trace, and "trace" shows everything. The numbers are what make
// the tiers composable: a caller asks `logger.enabled("debug")` instead of comparing strings.
//
// The panel's lines have always opened with `HH:MM:SS ` and tools/measure-slow-panel.mjs (and
// years of habit) parse INFO lines exactly so — `/^(\d\d:\d\d:\d\d) projects: .../`. INFO
// therefore keeps the bare `HH:MM:SS message` shape and every OTHER level carries its word
// (`HH:MM:SS warn message`), which keeps every existing line reader working while making the new
// severities visible at a glance.
//
// The level comes from config.json (`logging.level`) with WAG_LOG_LEVEL as the environment
// override, and server.js sets it BEFORE the boot prints — a level that hides boot lines has to
// apply before the boot writes them.
//
// One singleton, imported by every module: this file imports nothing, so any module may import it
// without a cycle, and every module used to keep its own copy of the same one-line console.log.
// A level only means something if one switch changes the whole process.

export const LEVELS = Object.freeze({ trace: 10, debug: 20, info: 30, warn: 40, error: 50 });

// The number for a level name, or null for anything else (null, "INFO " with stray space is
// trimmed; unknown words are not guessed at).
export function levelNumber(name) {
  const key = String(name == null ? "" : name).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, key) ? LEVELS[key] : null;
}

// The one reading of a value a hand edit or an environment got wrong: an unrecognised level
// falls back rather than turning logging off or on by accident.
export function parseLevel(value, fallback = "info") {
  const n = levelNumber(value);
  return n == null ? parseLevel(fallback, "info") : String(value).trim().toLowerCase();
}

// console.log's own shape for the non-string arguments the old copies passed through (a number, an
// object, an Error): strings are kept verbatim, everything else is stringified defensively.
function text(part) {
  if (typeof part === "string") return part;
  if (part instanceof Error) return part.stack || String(part);
  if (part === undefined) return "undefined";
  try {
    const s = JSON.stringify(part);
    return s === undefined ? String(part) : s;
  } catch {
    return String(part);
  }
}

const stamp = (now) => now().toISOString().slice(11, 19);

// sink is `(line) => void` — console.log by default; tests pass a collector. now() returns a Date
// so a test can pin the stamp without touching the clock.
export function createLogger({ level = "info", sink = (line) => console.log(line), now = () => new Date() } = {}) {
  let current = parseLevel(level);
  let threshold = LEVELS[current];
  const emit = (name, args) => {
    if (LEVELS[name] < threshold) return false;
    const body = args.map(text).join(" ");
    sink(`${stamp(now)} ${name === "info" ? "" : `${name} `}${body}`);
    return true;
  };
  return {
    levels: LEVELS,
    get level() {
      return current;
    },
    enabled(name) {
      const n = levelNumber(name);
      return n != null && n >= threshold;
    },
    // Returns the level in force afterwards; an unknown name changes nothing.
    setLevel(name) {
      const next = levelNumber(name);
      if (next != null) {
        current = String(name).trim().toLowerCase();
        threshold = next;
      }
      return current;
    },
    error: (...a) => emit("error", a),
    warn: (...a) => emit("warn", a),
    info: (...a) => emit("info", a),
    debug: (...a) => emit("debug", a),
    trace: (...a) => emit("trace", a),
  };
}

// The process-wide instance and its per-level shorthands. server.js calls logger.setLevel(...)
// once at boot; everything else just calls these.
export const logger = createLogger();
export const log = (...a) => logger.info(...a);
export const warn = (...a) => logger.warn(...a);
export const error = (...a) => logger.error(...a);
export const debug = (...a) => logger.debug(...a);
export const trace = (...a) => logger.trace(...a);
