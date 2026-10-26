// Decision log: one JSONL line per applied tick and one per Turbo start or end, rotated at a size cap. Lines hold numbers, reason text, the override state and who started or ended Turbo. No account data and no tokens.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LOG_CAP_BYTES = 1_000_000;

export interface DecisionRecord {
  t: string;
  host: string;
  cur: number;
  next: number;
  applied: boolean;
  why: string;
  load: number;
  fiveHourUsed: number | null;
  fiveHourElapsed: number | null;
  weekUsed: number | null;
  override: { lastSet: number | null; pausedUntil: number };
  /** True when the tick was made under an active Turbo (lines written before Turbo have no field). */
  turbo?: boolean;
}

/** A Turbo start or end. `by` is who started it (start) or who ended it (end): the CLI, the panel, or the scheduler when the quota cap, the weekly reset or the time box ended it. */
export interface TurboEvent {
  t: string;
  kind: "turbo";
  action: "start" | "end";
  by: "cli" | "panel" | "scheduler";
  limit?: number;
  until?: string;
  reason?: string;
}

export type LogLine = DecisionRecord | TurboEvent;

export function isTick(line: LogLine): line is DecisionRecord {
  return (line as TurboEvent).kind !== "turbo";
}

/** Same convention as tower-usage: ~/.bb-studio, overridable for tests. */
export function logFile(): string {
  const dir = process.env.CONCURRENCY_PACER_DIR || path.join(os.homedir(), ".bb-studio", "concurrency-pacer");
  return path.join(dir, "decisions.jsonl");
}

/** Append one line. When the file has reached the cap, it moves to `<file>.1` (replacing the old one) and a new file starts. */
export function appendDecision(file: string, rec: LogLine, capBytes = LOG_CAP_BYTES): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let size = 0;
  try { size = fs.statSync(file).size; } catch { /* no file yet */ }
  if (size >= capBytes) fs.renameSync(file, `${file}.1`);
  fs.appendFileSync(file, JSON.stringify(rec) + "\n", { mode: 0o600 });
}

function readLines(file: string): string[] {
  try { return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== ""); } catch { return []; }
}

/** The last `last` lines, oldest first, from the rotated file and the current one. Malformed lines are skipped. */
export function readDecisions(file: string, last: number): LogLine[] {
  const lines = [...readLines(`${file}.1`), ...readLines(file)];
  const out: LogLine[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < last; i--) {
    try { out.unshift(JSON.parse(lines[i]) as LogLine); } catch { /* skip a torn line */ }
  }
  return out;
}

/** One human line: time, then the tick's change, applied or not, and the reason; or the Turbo start or end and who did it. */
export function formatDecision(line: LogLine): string {
  if (!isTick(line)) {
    if (line.action === "start") {
      return `${line.t}  turbo started by ${line.by}: limit ${line.limit ?? "?"} until ${line.until ?? "?"}`;
    }
    return `${line.t}  turbo ended by ${line.by}${line.reason ? `: ${line.reason}` : ""}`;
  }
  const change = line.next === line.cur ? `${line.cur}` : `${line.cur} -> ${line.next}`;
  const what = line.applied ? "applied" : line.next === line.cur ? "held" : "not applied";
  return `${line.t}  ${line.host}: ${change} (${what})${line.turbo ? " [turbo]" : ""}  ${line.why}`;
}
