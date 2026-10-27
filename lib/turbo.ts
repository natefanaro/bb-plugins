// Turbo: an override that holds the limit at a chosen value and ignores the CPU-hot rule. It ends at its time box (or never, when started "until off"), at the weekly quota reset, at the quota cap, when swap reaches the memory end line, and when the limit is changed by hand. Pure: the caller passes the clock, the stored state and the limit readings.
import { memoryHot, memorySentence, type MemoryReading, type MemoryThresholds } from "./memory.ts";
import { DEFAULT_TUNING, type Tuning } from "./tuning.ts";

export const TURBO_DEFAULT_MS = 2 * 3600_000;
export const TURBO_MAX_MS = 12 * 3600_000;
/** An until-off Turbo stores this far-future time box, so an older build that only knows time boxes still reads the record (and still restores the cap) after a rollback. */
export const TURBO_UNTIL_OFF_MS = 10 * 365 * 24 * 3600_000;
export const TURBO_MAX_LIMIT = 16;
export const SUGGEST_WINDOW_MS = 3 * 3600_000;
export const SUGGEST_SLACK_PTS = 10;

export interface Turbo {
  startedAt: number;
  /** Epoch ms the time box ends. For an until-off Turbo this is a far-future value and the clock never ends it. */
  until: number;
  /** True when started "until off": no time box; the quota cap, memory pressure, the weekly reset and a manual change still end it. */
  untilOff: boolean;
  limit: number;
  by: "cli" | "panel";
  /** The host Turbo holds. */
  hostId: string;
  /** The overall cap before Turbo started. Turbo raises it when its limit is above it, and restores it at the end. */
  globalBefore: number | null;
  globalRaised: boolean;
}

/** Accepts only the stored shape. Anything else is no Turbo, so a damaged record cannot pin the limit. */
export function parseTurbo(raw: unknown): Turbo | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const { startedAt, until, limit, by, hostId, globalBefore, globalRaised } = r;
  if (typeof startedAt !== "number" || typeof limit !== "number") return null;
  // A record from the first until-off build stored a null time box: read it as until off, with the far-future time box.
  const nullUntil = until === null;
  if (!nullUntil && typeof until !== "number") return null;
  const flag = r.untilOff;
  if (flag !== undefined && typeof flag !== "boolean") return null;
  const untilOff = nullUntil || flag === true;
  const endsAt = nullUntil ? startedAt + TURBO_UNTIL_OFF_MS : (until as number);
  if (!Number.isInteger(limit) || limit < 1 || limit > TURBO_MAX_LIMIT) return null;
  if (endsAt <= startedAt || (by !== "cli" && by !== "panel")) return null;
  if (typeof hostId !== "string" || hostId === "") return null;
  if (globalBefore !== null && typeof globalBefore !== "number") return null;
  if (typeof globalRaised !== "boolean") return null;
  return { startedAt, until: endsAt, untilOff, limit, by, hostId, globalBefore: globalBefore as number | null, globalRaised };
}

/** Builds a new Turbo. A null duration runs until it is turned off (stored with a far-future time box). Throws on bad input; the CLI and the RPC both pass through here. */
export function startTurbo(
  now: number,
  limit: number,
  durationMs: number | null,
  by: "cli" | "panel",
  hostId: string,
  globalBefore: number | null,
  globalRaised: boolean,
): Turbo {
  if (!Number.isInteger(limit) || limit < 1 || limit > TURBO_MAX_LIMIT) throw new Error(`limit must be a whole number from 1 to ${TURBO_MAX_LIMIT}`);
  if (durationMs !== null && (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > TURBO_MAX_MS)) throw new Error("duration must be more than 0 and at most 12h");
  return { startedAt: now, until: now + (durationMs === null ? TURBO_UNTIL_OFF_MS : durationMs), untilOff: durationMs === null, limit, by, hostId, globalBefore, globalRaised };
}

/** Whether a start at this limit raises the overall cap: the cap is set and below the limit. A cap that is not set (null) is never raised. */
export function raisesCap(globalLimit: number | null, limit: number): boolean {
  return globalLimit !== null && globalLimit < limit;
}

/** The quota-cap rule, shared with the scheduler: week at quotaWeekNear (default 90%) or five-hour at quotaFiveHourNear (default 92%). */
export function quotaNear(s: { weekUsed: number | null; fiveHourUsed: number | null }, t: Pick<Tuning, "quotaWeekNear" | "quotaFiveHourNear"> = DEFAULT_TUNING): boolean {
  return (s.weekUsed ?? 0) >= t.quotaWeekNear || (s.fiveHourUsed ?? 0) >= t.quotaFiveHourNear;
}

export type TurboStep =
  | { kind: "baseline" }
  | { kind: "manual" }
  | { kind: "write"; limit: number }
  | { kind: "hold" };

/**
 * What Turbo does on a tick. No baseline yet (first tick after a restart): record the limit and do not write, as the back-off gate does.
 * A limit that is not the value Coach last set was changed by someone else: end Turbo; never overwrite it.
 * Otherwise write the chosen limit when the last write has not reached it; hold when it has.
 */
export function turboStep(lastSet: number | null, cur: number, limit: number): TurboStep {
  if (lastSet === null) return { kind: "baseline" };
  if (cur !== lastSet) return { kind: "manual" };
  if (lastSet !== limit) return { kind: "write", limit };
  return { kind: "hold" };
}

/**
 * Why Turbo should end now, or null while it runs. Order: quota cap, memory, manual change, weekly reset, time box (never, for "until off").
 * `memoryReason` is the reason from turboMemoryEndReason, or null when memory is fine. An early "off" is not decided here; the caller ends it directly.
 */
export function turboEndReason(t: Turbo, now: number, weekResetsAt: number | null, nearCap: boolean, manual: boolean, memoryReason: string | null = null): string | null {
  if (nearCap) return "quota near limit";
  if (memoryReason !== null) return memoryReason;
  if (manual) return "manual limit change";
  if (weekResetsAt !== null && now >= weekResetsAt) return "weekly quota reset";
  if (!t.untilOff && now >= t.until) return "time box ended";
  return null;
}

/**
 * Memory ends Turbo when the host is under real memory pressure: free memory under its floor, or swap high while paging out (the scheduler's own memory rule, which Turbo otherwise skips).
 * Swap alone is not pressure: macOS keeps swap after a spike. A raw swap line (`swapEndPercent`, 0 = off) is an optional extra on top. Unreadable figures are not a signal.
 */
export function turboMemoryEndReason(reading: MemoryReading, thresholds: MemoryThresholds, swapEndPercent: number): string | null {
  if (memoryHot(reading, thresholds)) return `memory pressure (${memorySentence(reading)})`;
  if (swapEndPercent > 0 && reading.swapUsedPct !== null && reading.swapUsedPct >= swapEndPercent) return `swap at ${reading.swapUsedPct}%, the Turbo swap end line (${swapEndPercent}%)`;
  return null;
}

/** Why a Turbo start would end at once (so it is refused), or null when it can run. The same rules as turboEndReason, minus the ones a new Turbo cannot meet (manual change, time box). */
export function turboStartBlock(now: number, weekResetsAt: number | null, nearCap: boolean, memoryReason: string | null): string | null {
  const probe: Turbo = { startedAt: now, until: now + TURBO_MAX_MS, untilOff: false, limit: 1, by: "cli", hostId: "probe", globalBefore: null, globalRaised: false };
  return turboEndReason(probe, now, weekResetsAt, nearCap, false, memoryReason);
}

/** The overall cap and the host's override to write when Turbo ends: the cap goes back to its value before Turbo, and the host's limit cannot stay above it. */
export function turboCapRestore(
  cfg: { globalLimit: number | null; hostOverrides: { hostId: string; limit: number | null }[] },
  t: Turbo,
): { globalLimit: number | null; hostOverrides: { hostId: string; limit: number | null }[] } {
  const globalLimit = t.globalBefore;
  const hostOverrides = cfg.hostOverrides.map((o) => {
    if (o.hostId !== t.hostId || o.limit === null || globalLimit === null) return o;
    return { hostId: o.hostId, limit: Math.min(o.limit, globalLimit) };
  });
  return { globalLimit, hostOverrides };
}

/** Suggest Turbo when weekly use is behind the week's elapsed time by more than the slack, with three hours or less to the reset. */
export function turboSuggested(weekUsed: number | null, weekElapsed: number | null, weekResetsAt: number | null, now: number): boolean {
  if (weekUsed === null || weekElapsed === null || weekResetsAt === null) return false;
  const left = weekResetsAt - now;
  return left > 0 && left <= SUGGEST_WINDOW_MS && weekUsed < weekElapsed - SUGGEST_SLACK_PTS;
}

export function turboSentence(t: Turbo): string {
  if (t.untilOff) return `Turbo on: limit ${t.limit} until you turn it off, started by ${t.by}.`;
  const until = new Date(t.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `Turbo on: limit ${t.limit} until ${until}, started by ${t.by}.`;
}
