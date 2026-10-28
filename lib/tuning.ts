// The tunables the policy reads. Each one is a setting; the defaults are the values the plugin shipped with, so changing nothing changes nothing.
// Pure and browser-safe (no node imports).
export interface Tuning {
  /** 1-minute load per core above which the limit steps down. */
  hotLoad: number;
  /** 1-minute load per core below which the limit steps up. */
  idleLoad: number;
  /** 5-hour use (percent) at or above which the limit drops to the minimum. */
  quotaFiveHourNear: number;
  /** Weekly use (percent) at or above which the limit drops to the minimum. */
  quotaWeekNear: number;
  /** Points 5-hour use may run ahead of the window's elapsed time before the limit steps down. */
  slackFiveHour: number;
  /** Points weekly use may run ahead of the week's elapsed time before the limit steps down. */
  slackWeek: number;
  /** Points weekly use may run ahead before raising is held. */
  raiseSlackWeek: number;
  /** Page-outs per second at or above which swap counts as thrashing. */
  pageoutHotPerSec: number;
  /** How many opencode threads may run with one slot of host headroom each. 0 turns the feature off. */
  opencodeSlots: number;
  /** Optional extra: swap used (percent) at or above which Turbo ends, on top of the memory-pressure rule. 0 (the default) leaves it off. */
  turboSwapEndPercent: number;
  /** Slots reserved above the paced limit for threads whose task is urgent. 0 turns the lane off. */
  urgentSlots: number;
  /** Minutes urgent work may wait before it is flagged as starved. 0 never flags. */
  urgentReportMinutes: number;
  /** Interactive reserve: the most of the 5-hour window (percent used) agents may use. At or above it the limit holds at the minimum. 0 turns the 5-hour reserve off. */
  reserveFiveHour: number;
  /** Interactive reserve on the week: 1 on, 0 off. */
  reserveWeek: number;
  /** Points below the week's pace (percent of the week elapsed) that agents' weekly use may reach before the reserve holds the limit at the minimum. */
  reserveWeekMargin: number;
}

export const DEFAULT_TUNING: Tuning = {
  hotLoad: 0.85,
  idleLoad: 0.5,
  quotaFiveHourNear: 92,
  quotaWeekNear: 90,
  slackFiveHour: 25,
  slackWeek: 6,
  raiseSlackWeek: 3,
  pageoutHotPerSec: 100,
  opencodeSlots: 1,
  turboSwapEndPercent: 0,
  urgentSlots: 1,
  urgentReportMinutes: 120,
  reserveFiveHour: 60,
  reserveWeek: 1,
  reserveWeekMargin: 10,
};

/** Each tunable's range. A value outside it, or not a finite number, falls back to its default. Percent thresholds are 1 to 100 (0 would pin the limit to the minimum), except the Turbo swap end line, which is 0 (off) or 50 to 100; slacks are 0 to 100; loads are above 0; page-outs are 0 or more. */
const VALID: Record<keyof Tuning, (v: number) => boolean> = {
  hotLoad: (v) => v > 0,
  idleLoad: (v) => v > 0,
  quotaFiveHourNear: (v) => v >= 1 && v <= 100,
  quotaWeekNear: (v) => v >= 1 && v <= 100,
  slackFiveHour: (v) => v >= 0 && v <= 100,
  slackWeek: (v) => v >= 0 && v <= 100,
  raiseSlackWeek: (v) => v >= 0 && v <= 100,
  pageoutHotPerSec: (v) => v >= 0,
  opencodeSlots: (v) => Number.isInteger(v) && v >= 0 && v <= 10,
  turboSwapEndPercent: (v) => v === 0 || (v >= 50 && v <= 100),
  urgentSlots: (v) => Number.isInteger(v) && v >= 0 && v <= 5,
  urgentReportMinutes: (v) => Number.isInteger(v) && v >= 0 && v <= 1440,
  reserveFiveHour: (v) => v === 0 || (v >= 1 && v <= 100),
  reserveWeek: (v) => v === 0 || v === 1,
  reserveWeekMargin: (v) => v >= 0 && v <= 100,
};

/**
 * The tunables from the settings, each checked against its range (a bad value falls back to its default, one value at a time).
 * Idle load must stay below hot load: if it does not, idle falls back to its default, and if that is still not below hot, hot falls back too.
 */
export function tuningFrom(s: Partial<Record<keyof Tuning, unknown>>): Tuning {
  const pick = (k: keyof Tuning): number => {
    const v = s[k];
    return typeof v === "number" && Number.isFinite(v) && VALID[k](v) ? v : DEFAULT_TUNING[k];
  };
  const t: Tuning = {
    hotLoad: pick("hotLoad"),
    idleLoad: pick("idleLoad"),
    quotaFiveHourNear: pick("quotaFiveHourNear"),
    quotaWeekNear: pick("quotaWeekNear"),
    slackFiveHour: pick("slackFiveHour"),
    slackWeek: pick("slackWeek"),
    raiseSlackWeek: pick("raiseSlackWeek"),
    pageoutHotPerSec: pick("pageoutHotPerSec"),
    opencodeSlots: pick("opencodeSlots"),
    turboSwapEndPercent: pick("turboSwapEndPercent"),
    urgentSlots: pick("urgentSlots"),
    urgentReportMinutes: pick("urgentReportMinutes"),
    reserveFiveHour: pick("reserveFiveHour"),
    reserveWeek: pick("reserveWeek"),
    reserveWeekMargin: pick("reserveWeekMargin"),
  };
  if (!(t.idleLoad < t.hotLoad)) {
    t.idleLoad = DEFAULT_TUNING.idleLoad;
    if (!(t.idleLoad < t.hotLoad)) t.hotLoad = DEFAULT_TUNING.hotLoad;
  }
  return t;
}
