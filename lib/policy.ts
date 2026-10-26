// Pure scaling policy: given the current limit and signals, pick the next limit. One step per tick.
import { memoryHot, memorySentence, type MemoryReading, type MemoryThresholds } from "./memory.ts";
import { DEFAULT_TUNING, type Tuning } from "./tuning.ts";

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
  /** The tunables. Undefined = the shipped defaults, so existing callers and tests are unchanged. */
  tuning?: Tuning;
}
export interface Decision { next: number; why: string }

// The shipped defaults, kept under their old names for callers that read them directly. The policy reads the tuning from the signals.
export const HOT = DEFAULT_TUNING.hotLoad;
export const IDLE = DEFAULT_TUNING.idleLoad;
export const PACE_SLACK_PTS = DEFAULT_TUNING.slackFiveHour;
export const WEEK_SLACK_PTS = DEFAULT_TUNING.slackWeek;
export const WEEK_RAISE_SLACK_PTS = DEFAULT_TUNING.raiseSlackWeek;
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
  const t = s.tuning ?? DEFAULT_TUNING;
  if ((s.weekUsed ?? 0) >= t.quotaWeekNear || (s.fiveHourUsed ?? 0) >= t.quotaFiveHourNear)
    return { next: s.min, why: `quota near limit (5h ${s.fiveHourUsed ?? "?"}%, week ${s.weekUsed ?? "?"}%)` };
  // Memory pressure comes before CPU: a thrashing host is slow whatever its load. This also blocks raising the limit.
  if (s.memory && memoryHot(s.memory.reading, { ...s.memory.thresholds, pageoutHotPerSec: t.pageoutHotPerSec }))
    return { next: clamp(s.cur - 1), why: `memory pressure (${memorySentence(s.memory.reading)})` };
  if (s.fiveHourUsed !== null && s.fiveHourElapsed !== null && s.fiveHourUsed > s.fiveHourElapsed + t.slackFiveHour)
    return { next: clamp(s.cur - 1), why: `5-hour use ahead of time elapsed (${s.fiveHourUsed}% used, ${s.fiveHourElapsed}% elapsed)` };
  // Weekly rules only run once the week has elapsed past the floor. Unknown weekly figures are no signal.
  const week = s.weekUsed !== null && s.weekElapsed !== null && s.weekElapsed >= WEEK_MIN_ELAPSED ? { used: s.weekUsed, elapsed: s.weekElapsed } : null;
  const projected = week ? weekProjected(week.used, week.elapsed) : null;
  const weekDetail = week && projected !== null ? `${week.used}% used, ${week.elapsed}% elapsed, projected ${Math.round(projected)}% by reset` : "";
  if (week && week.used > week.elapsed + t.slackWeek)
    return { next: clamp(s.cur - 1), why: `weekly use ahead of time elapsed (${weekDetail})` };
  if (s.loadRatio > t.hotLoad) return { next: clamp(s.cur - 1), why: `CPU hot (load/cpu ${s.loadRatio.toFixed(2)})` };
  if (s.loadRatio < t.idleLoad) {
    // Raising waits until weekly use is back within the raise slack of elapsed. The reason gives the sustainable limit at the current burn: cur * 100 / projected.
    if (week && week.used > week.elapsed + t.raiseSlackWeek) {
      const sustainable = projected !== null && projected > 100 ? Math.max(s.min, Math.floor((s.cur * 100) / projected)) : s.cur;
      return { next: clamp(s.cur), why: `hold: no raise while weekly use is more than ${t.raiseSlackWeek} points ahead of time elapsed (${weekDetail}); sustainable limit ${sustainable}` };
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
