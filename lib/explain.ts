// What is limiting the thread limit, in one line: capacity (memory, CPU) or quota (pace). Pure: it reads the same signals the policy reads.
// The rule checks mirror decide() in policy.ts, and explain.test.ts runs both over a grid so they cannot drift apart.
import { memoryHot, memorySentence } from "./memory.ts";
import { reserveReason, WEEK_MIN_ELAPSED, type Signals } from "./policy.ts";
import { DEFAULT_TUNING } from "./tuning.ts";

export type LimitCause = "quota-cap" | "reserve" | "memory-and-quota" | "memory" | "quota" | "cpu" | "turbo" | "none";
export interface Explanation {
  cause: LimitCause;
  /** One sentence for the panel. */
  line: string;
}

export interface LimitFlags {
  /** Quota near its cap: the limit is at the minimum. */
  quotaCap: boolean;
  /** Nate's reserve reached: the limit holds at the minimum. */
  reserve: boolean;
  /** Memory pressure: free memory under its floor, or swap high while paging out. */
  memory: boolean;
  fiveHourAhead: boolean;
  weekAhead: boolean;
  /** Weekly use is far enough ahead to hold raising (but not to step down). */
  weekHold: boolean;
  cpuHot: boolean;
  cpuIdle: boolean;
}

export function limitFlags(s: Signals): LimitFlags {
  const t = s.tuning ?? DEFAULT_TUNING;
  const week = s.weekUsed !== null && s.weekElapsed !== null && s.weekElapsed >= WEEK_MIN_ELAPSED ? { used: s.weekUsed, elapsed: s.weekElapsed } : null;
  return {
    quotaCap: (s.weekUsed ?? 0) >= t.quotaWeekNear || (s.fiveHourUsed ?? 0) >= t.quotaFiveHourNear,
    reserve: reserveReason(s, t) !== null,
    memory: s.memory !== undefined && memoryHot(s.memory.reading, { ...s.memory.thresholds, pageoutHotPerSec: t.pageoutHotPerSec }),
    fiveHourAhead: s.fiveHourUsed !== null && s.fiveHourElapsed !== null && s.fiveHourUsed > s.fiveHourElapsed + t.slackFiveHour,
    weekAhead: week !== null && week.used > week.elapsed + t.slackWeek,
    weekHold: week !== null && week.used > week.elapsed + t.raiseSlackWeek,
    cpuHot: s.loadRatio > t.hotLoad,
    cpuIdle: s.loadRatio < t.idleLoad,
  };
}

/** The pace figures behind a quota hold, in a few words: the 5-hour window when it is the one ahead, else the week. */
function paceBit(s: Signals, f: LimitFlags): string {
  if (f.fiveHourAhead) return `5 h ${s.fiveHourUsed}% used vs ${s.fiveHourElapsed}% of the window elapsed`;
  return `week ${s.weekUsed}% used vs ${s.weekElapsed}% of the week elapsed`;
}

/** Memory figures as "free memory 34%, swap 95%", or null when nothing was read. */
function memoryBit(s: Signals): string | null {
  const text = s.memory === undefined ? "" : memorySentence({ ...s.memory.reading, pageoutsPerSec: null });
  return text === "" ? null : text;
}

/** Said on the reserve line in fleet mode: the reserve is account-wide, and the lanes that would run above the minimum are off. */
export const FLEET_RESERVE_NOTE = "Fleet mode: every host is at its minimum, and the urgent and opencode lanes are off.";

export function explainLimit(s: Signals, turboOn: boolean, fleet = false): Explanation {
  if (turboOn) return { cause: "turbo", line: "Turbo is holding the limit. Pace and CPU rules are paused; quota near its cap or memory pressure still ends it." };
  const f = limitFlags(s);
  // The weekly raise hold only matters when a raise was wanted (CPU idle); otherwise nothing is being held back by it.
  const pace = f.fiveHourAhead || f.weekAhead || (f.weekHold && f.cpuIdle);
  const mem = memoryBit(s);
  if (f.quotaCap) return { cause: "quota-cap", line: `At the minimum, ${s.min}: quota (cap) is near its limit (5 h ${s.fiveHourUsed ?? "?"}%, week ${s.weekUsed ?? "?"}%). Not a memory limit.` };
  if (f.reserve) return { cause: "reserve", line: `At the minimum, ${s.min}: ${reserveReason(s, s.tuning ?? DEFAULT_TUNING)}. ${fleet ? FLEET_RESERVE_NOTE : "Only the urgent lane runs above it."}` };
  if (f.memory && pace) return { cause: "memory-and-quota", line: `Held by capacity (memory${mem === null ? "" : `: ${mem}`}) and by quota (pace: ${paceBit(s, f)}).` };
  if (f.memory) return { cause: "memory", line: `Held by capacity (memory${mem === null ? "" : `: ${mem}`}). Not quota: quota is within its pace.` };
  if (pace) return { cause: "quota", line: `Held by quota (pace: ${paceBit(s, f)}).${mem === null ? "" : ` Not memory: it has room (${mem}).`}` };
  if (f.cpuHot) return { cause: "cpu", line: `Held by capacity (CPU: load ${s.loadRatio.toFixed(2)} per core). Not memory or quota.` };
  return { cause: "none", line: f.cpuIdle ? "Room to raise: CPU idle, memory and quota within limits." : "Steady: CPU between idle and hot, memory and quota within limits." };
}
