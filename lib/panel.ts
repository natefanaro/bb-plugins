// Data shaping for the read-only panel. Pure: the server gathers the inputs, these functions turn them into what the page shows.
import path from "node:path";
import { HOT, IDLE, PACE_SLACK_PTS, WEEK_MIN_ELAPSED, WEEK_SLACK_PTS } from "./policy.ts";
import { isTick, type DecisionRecord, type LogLine } from "./decision-log.ts";

export type LoadLevel = "idle" | "ok" | "hot";
export type PaceState = "ahead" | "behind" | "unknown";

export function loadLevel(ratio: number): LoadLevel {
  return ratio > HOT ? "hot" : ratio < IDLE ? "idle" : "ok";
}

/** Used vs elapsed for one quota window. Ahead means used runs more than the slack above elapsed; unknown when either figure is missing. */
export function paceState(used: number | null, elapsed: number | null, slack: number = PACE_SLACK_PTS): PaceState {
  if (used === null || elapsed === null) return "unknown";
  return used > elapsed + slack ? "ahead" : "behind";
}

/** Weekly pace for the panel. Unknown below the week floor, the same as the policy, which gives no weekly signal there. */
export function weekPaceState(used: number | null, elapsed: number | null): PaceState {
  if (elapsed !== null && elapsed < WEEK_MIN_ELAPSED) return "unknown";
  return paceState(used, elapsed, WEEK_SLACK_PTS);
}

/** The newest logged decision by its timestamp (not by file order). Records with a bad timestamp are skipped. */
export function lastDecision(lines: LogLine[]): { why: string; decidedAt: string } | null {
  let best: { ts: number; r: DecisionRecord } | null = null;
  for (const r of lines.filter(isTick)) {
    const ts = Date.parse(r.t);
    if (Number.isNaN(ts)) continue;
    if (best === null || ts > best.ts) best = { ts, r };
  }
  return best === null ? null : { why: best.r.why, decidedAt: best.r.t };
}

/** One plain sentence for the last decision's reason. A manual-change back-off overrides it, with minutes left. */
export function reasonSentence(last: Pick<DecisionRecord, "why"> | null, pausedUntil: number, now: number): string {
  if (pausedUntil > now) {
    return `Backing off after a manual limit change: ${Math.ceil((pausedUntil - now) / 60_000)} min left.`;
  }
  if (last === null) return "No decision yet since Pacer started.";
  const text = last.why.trim();
  const sentence = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

export interface HistoryPoint { ageSec: number; limit: number }
export interface HistoryChange { ageSec: number; from: number; to: number; why: string }
export interface History { windowSec: number; points: HistoryPoint[]; changes: HistoryChange[] }

/** The host limit over the window, oldest first. Each tick's limit is what it left in place (the new value if applied, else the old one). Changes are the ticks that moved it. */
export function history(lines: LogLine[], now: number, windowMs: number): History {
  const windowSec = Math.round(windowMs / 1000);
  const rows = lines
    .filter(isTick)
    .map((r) => ({ r, ts: Date.parse(r.t) }))
    .filter(({ ts }) => !Number.isNaN(ts) && ts <= now && now - ts <= windowMs)
    .sort((a, b) => a.ts - b.ts);
  const points: HistoryPoint[] = [];
  const changes: HistoryChange[] = [];
  for (const { r, ts } of rows) {
    const limit = r.applied ? r.next : r.cur;
    points.push({ ageSec: Math.round((now - ts) / 1000), limit });
    if (r.applied && r.next !== r.cur) changes.push({ ageSec: Math.round((now - ts) / 1000), from: r.cur, to: r.next, why: r.why });
  }
  return { windowSec, points, changes };
}

/** The top process by CPU, by name only (no arguments, no paths). `ps -Ao pcpu,comm -r` output. */
export function topCpuName(psOutput: string): { name: string; cpuPct: number } | null {
  const first = psOutput.split("\n").slice(1).find((l) => l.trim() !== "");
  if (first === undefined) return null;
  const m = /^\s*([\d.]+)\s+(.+)$/.exec(first);
  if (m === null) return null;
  const name = path.basename(m[2].trim());
  return name === "" ? null : { name, cpuPct: Number(m[1]) };
}
