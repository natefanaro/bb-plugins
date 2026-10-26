// Memory readings and the memory-pressure rule. Pure parsing and level only; the server runs the commands and passes their output here.
// Free memory is the primary signal. macOS keeps swap after a spike and does not give it back, so swap alone is not pressure: swap counts only while the host is paging out.
export interface MemoryReading {
  /** Swap in use as a percent of the swap total, or null when unknown. */
  swapUsedPct: number | null;
  /** System-wide free memory percent, or null when unknown. */
  freePct: number | null;
  /** Pages written out to swap per second over the sample, or null when unknown. */
  pageoutsPerSec: number | null;
}

export const NO_MEMORY: MemoryReading = { swapUsedPct: null, freePct: null, pageoutsPerSec: null };

/** Seconds over which `vm_stat -c 2 5` takes its second sample. */
export const PAGING_SAMPLE_SEC = 5;
/** Page-outs per second at or above which swap counts as thrashing. Page-ins are not counted: a healthy Mac pages in at several hundred per second. */
export const PAGEOUT_HOT_PER_SEC = 100;

export interface MemoryThresholds { swapHotPercent: number; memFreeMinPercent: number }

/** Parse `sysctl -n vm.swapusage`: "total = 23552.00M  used = 21849.56M  free = 1702.44M  (encrypted)". */
export function parseSwapUsage(stdout: string): number | null {
  const m = /total\s*=\s*([\d.]+)([KMGT])\s+used\s*=\s*([\d.]+)([KMGT])/.exec(stdout);
  if (!m) return null;
  const unit: Record<string, number> = { K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024 };
  const total = Number(m[1]) * unit[m[2]];
  const used = Number(m[3]) * unit[m[4]];
  if (!(total > 0) || !Number.isFinite(used)) return null;
  return Math.min(100, Math.round((used / total) * 100));
}

/** Parse `memory_pressure` output: "System-wide memory free percentage: 74%". */
export function parseFreePct(stdout: string): number | null {
  const m = /System-wide memory free percentage:\s*(\d+)%/.exec(stdout);
  return m ? Number(m[1]) : null;
}

/**
 * Parse `vm_stat -c 2 5`: a header row of column names, then two data rows. The first row is since boot; the second is the 5-second sample, so its
 * "pageout" column is the page-outs in that interval. Returns page-outs per second, or null when the columns are missing.
 */
export function parsePageoutsPerSec(stdout: string, intervalSec = PAGING_SAMPLE_SEC): number | null {
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const header = lines.findIndex((l) => /\bpageouts?\b/.test(l) && /\bpageins\b/.test(l));
  if (header < 0) return null;
  const cols = lines[header].split(/\s+/);
  const col = cols.indexOf("pageout") >= 0 ? cols.indexOf("pageout") : cols.indexOf("pageouts");
  const sample = lines[header + 2];
  if (col < 0 || sample === undefined) return null;
  const v = Number(sample.split(/\s+/)[col]);
  return Number.isFinite(v) && v >= 0 ? v / intervalSec : null;
}

/** Free memory below its floor is pressure. */
export function freeMemoryLow(r: MemoryReading, t: MemoryThresholds): boolean {
  return r.freePct !== null && r.freePct < t.memFreeMinPercent;
}

/** Swap counts as pressure only with active paging out: swap at or above its threshold AND page-outs at or above PAGEOUT_HOT_PER_SEC. */
export function swapThrashing(r: MemoryReading, t: MemoryThresholds): boolean {
  return r.swapUsedPct !== null && r.swapUsedPct >= t.swapHotPercent && r.pageoutsPerSec !== null && r.pageoutsPerSec >= PAGEOUT_HOT_PER_SEC;
}

/** Memory is hot when free memory is low, or swap is thrashing. Unknown readings are not hot. */
export function memoryHot(r: MemoryReading, t: MemoryThresholds): boolean {
  return freeMemoryLow(r, t) || swapThrashing(r, t);
}

/** Plain words for the reason and the panel, e.g. "free memory 14%, swap 95%, paging out 120/s". Unknown parts are left out. */
export function memorySentence(r: MemoryReading): string {
  const parts: string[] = [];
  if (r.freePct !== null) parts.push(`free memory ${r.freePct}%`);
  if (r.swapUsedPct !== null) parts.push(`swap ${r.swapUsedPct}%`);
  if (r.pageoutsPerSec !== null) parts.push(`paging out ${Math.round(r.pageoutsPerSec)}/s`);
  return parts.join(", ");
}
