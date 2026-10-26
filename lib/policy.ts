// Pure scaling policy: given the current limit and signals, pick the next limit. One step per tick.
import { memoryHot, memorySentence, type MemoryReading, type MemoryThresholds } from "./memory.ts";

export interface Signals {
  cur: number;
  min: number;
  max: number;
  /** 1-minute load average divided by CPU count. */
  loadRatio: number;
  /** Plan five-hour window: percent used and percent of the window elapsed. null = unknown. */
  fiveHourUsed: number | null;
  fiveHourElapsed: number | null;
  /** Plan weekly window: percent used and percent of the week elapsed. null = unknown (no signal). */
  weekUsed: number | null;
  weekElapsed: number | null;
  /** Swap and free-memory readings with their thresholds. Undefined = no memory signal (CPU and quota only). */
  memory?: { reading: MemoryReading; thresholds: MemoryThresholds };
}
export interface Decision { next: number; why: string }

export const HOT = 0.85;
export const IDLE = 0.5;
export const PACE_SLACK_PTS = 25;
/** Weekly use may run this many points ahead of the week's elapsed time before the limit steps down. */
export const WEEK_SLACK_PTS = 6;
/** Weekly use more than this many points ahead of elapsed blocks raising. Stateless: raising resumes as soon as use is back within the points. */
export const WEEK_RAISE_SLACK_PTS = 3;
/** Below this share of the week elapsed there is no weekly signal, so the first hours do not thrash the limit. */
export const WEEK_MIN_ELAPSED = 5;
export const WEEK_MS = 7 * 24 * 3600_000;

/** Weekly use projected to the reset at the current burn rate, in percent of the weekly cap. Null without a usable elapsed share. */
export function weekProjected(used: number, elapsed: number): number | null {
  if (elapsed < WEEK_MIN_ELAPSED) return null;
  return (used / elapsed) * 100;
}

export function decide(s: Signals): Decision {
  const clamp = (n: number) => Math.max(s.min, Math.min(s.max, n));
  if ((s.weekUsed ?? 0) >= 90 || (s.fiveHourUsed ?? 0) >= 92)
    return { next: s.min, why: `quota near limit (5h ${s.fiveHourUsed ?? "?"}%, week ${s.weekUsed ?? "?"}%)` };
  // Memory pressure comes before CPU: a thrashing host is slow whatever its load. This also blocks raising the limit.
  if (s.memory && memoryHot(s.memory.reading, s.memory.thresholds))
    return { next: clamp(s.cur - 1), why: `memory pressure (${memorySentence(s.memory.reading)})` };
  if (s.fiveHourUsed !== null && s.fiveHourElapsed !== null && s.fiveHourUsed > s.fiveHourElapsed + PACE_SLACK_PTS)
    return { next: clamp(s.cur - 1), why: `burning ahead of pace (${s.fiveHourUsed}% used, ${s.fiveHourElapsed}% elapsed)` };
  // Weekly rules only run once the week has elapsed past the floor. Unknown weekly figures are no signal.
  const week = s.weekUsed !== null && s.weekElapsed !== null && s.weekElapsed >= WEEK_MIN_ELAPSED ? { used: s.weekUsed, elapsed: s.weekElapsed } : null;
  const projected = week ? weekProjected(week.used, week.elapsed) : null;
  const weekDetail = week && projected !== null ? `${week.used}% used, ${week.elapsed}% elapsed, projected ${Math.round(projected)}% by reset` : "";
  if (week && week.used > week.elapsed + WEEK_SLACK_PTS)
    return { next: clamp(s.cur - 1), why: `burning ahead of weekly pace (${weekDetail})` };
  if (s.loadRatio > HOT) return { next: clamp(s.cur - 1), why: `CPU hot (load/cpu ${s.loadRatio.toFixed(2)})` };
  if (s.loadRatio < IDLE) {
    // Raising waits until weekly use is back within the raise slack of elapsed. The reason gives the sustainable limit at the current burn: cur * 100 / projected.
    if (week && week.used > week.elapsed + WEEK_RAISE_SLACK_PTS) {
      const sustainable = projected !== null && projected > 100 ? Math.max(s.min, Math.floor((s.cur * 100) / projected)) : s.cur;
      return { next: clamp(s.cur), why: `hold: no raise while week is more than ${WEEK_RAISE_SLACK_PTS} points ahead of pace (${weekDetail}); sustainable limit ${sustainable}` };
    }
    return { next: clamp(s.cur + 1), why: `CPU idle (load/cpu ${s.loadRatio.toFixed(2)})` };
  }
  return { next: clamp(s.cur), why: "hold" };
}

interface Window { label?: string; usedPercent?: number; resetsAt?: string }
/** Read the Claude Code five-hour and weekly windows out of the provider-usage getUsage output. */
export function parseUsage(raw: unknown, now: number): Pick<Signals, "fiveHourUsed" | "fiveHourElapsed" | "weekUsed" | "weekElapsed"> & { weekResetsAt: number | null } {
  const out = { fiveHourUsed: null as number | null, fiveHourElapsed: null as number | null, weekUsed: null as number | null, weekElapsed: null as number | null, weekResetsAt: null as number | null };
  const machines = (raw as { machines?: { providers?: { providerId?: string; usage?: { windows?: Window[] } }[] }[] } | null)?.machines ?? [];
  for (const m of machines) for (const p of m.providers ?? []) {
    if (p.providerId !== "claude-code") continue;
    for (const w of p.usage?.windows ?? []) {
      const label = (w.label ?? "").toLowerCase();
      if (typeof w.usedPercent !== "number") continue;
      if (/five|session/.test(label) && out.fiveHourUsed === null) {
        out.fiveHourUsed = w.usedPercent;
        const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
        if (!Number.isNaN(reset)) out.fiveHourElapsed = Math.round(Math.max(0, Math.min(100, 100 - ((reset - now) / (5 * 3600_000)) * 100)));
      } else if (/^weekly limit|^week/.test(label) && !label.includes("·") && out.weekUsed === null) {
        out.weekUsed = w.usedPercent;
        const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
        if (!Number.isNaN(reset)) {
          out.weekElapsed = Math.round(Math.max(0, Math.min(100, 100 - ((reset - now) / WEEK_MS) * 100)));
          out.weekResetsAt = reset;
        }
      }
    }
  }
  return out;
}
