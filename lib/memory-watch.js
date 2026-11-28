// One heap high-water sentinel for the panel process.
//
// The panel serves a large fleet from one V8 heap. When a retained structure starts growing, the first symptom
// used to be a fatal OOM four hours in (2026-11-28: 3944 MB heap, exit 134) with nothing in the log naming what
// held the memory. This watches `heapUsed` on a slow clock and writes exactly ONE warning when it first crosses
// the mark, naming the largest retained structure the caller can measure. It never restarts, kills, or otherwise
// acts on the process — the next climb is meant to be READ, not pre-empted.
export const HIGH_WATER_BYTES = 1.5 * 1024 ** 3;
const MB = 1024 * 1024;

export function createMemoryWatch({
  thresholdBytes = HIGH_WATER_BYTES,
  memory = () => process.memoryUsage(),
  retained = () => ({}),
  warn = () => {},
} = {}) {
  let warned = false;
  let last = null;
  return {
    get warned() {
      return warned;
    },
    // Returns true only on the call that crosses the mark. Every later call is a no-op for logging.
    check() {
      const usage = memory() || {};
      const heapUsed = Number(usage.heapUsed) || 0;
      last = {
        heapUsed,
        heapTotal: Number(usage.heapTotal) || 0,
        rss: Number(usage.rss) || 0,
      };
      if (warned || heapUsed < thresholdBytes) return false;
      warned = true;
      let biggest = null;
      const sizes = retained() || {};
      for (const [name, value] of Object.entries(sizes)) {
        if (typeof value !== "number" || !Number.isFinite(value)) continue;
        if (!biggest || value > biggest.value) biggest = { name, value };
      }
      const where = biggest ? `; largest retained structure: ${biggest.name} (${biggest.value})` : "";
      warn(
        `memory high-water: heapUsed ${Math.round(heapUsed / MB)} MB crossed the ${Math.round(thresholdBytes / MB)} MB mark${where}`,
      );
      return true;
    },
    stats() {
      return {
        thresholdBytes,
        warned,
        heapUsed: last ? last.heapUsed : null,
        heapTotal: last ? last.heapTotal : null,
        rss: last ? last.rss : null,
      };
    },
  };
}
