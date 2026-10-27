// The Turbo duration choices the panel offers. Each is a setting; the defaults are 30 min, 1 h and 2 h, plus "until off".
// Pure and browser-safe (no node imports).
import { TURBO_MAX_MS } from "./turbo.ts";

export interface TurboChoice {
  /** Minutes the time box lasts. Null means until it is turned off. */
  minutes: number | null;
  label: string;
}

export const DEFAULT_TURBO_MINUTES = [30, 60, 120];
const MAX_CHOICES = 6;
const MAX_MINUTES = TURBO_MAX_MS / 60_000;

/** "30 min", "1 h", "1 h 30 min". */
export function minutesLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/**
 * The choices from the settings. `raw` is a comma-separated list of minutes, such as "30,60,120".
 * Each entry must be a whole number from 1 to 720 (the 12 h cap); a bad entry is dropped, the rest are sorted and de-duplicated, and at most six are kept.
 * If nothing valid is left, the defaults apply. "Until off" is added last when `allowUntilOff` is true.
 */
export function parseTurboChoices(raw: unknown, allowUntilOff: boolean): TurboChoice[] {
  const parsed = typeof raw === "string"
    ? raw.split(",").map((p) => p.trim()).filter((p) => /^\d+$/.test(p)).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= MAX_MINUTES)
    : [];
  const minutes = [...new Set(parsed.length > 0 ? parsed : DEFAULT_TURBO_MINUTES)].sort((a, b) => a - b).slice(0, MAX_CHOICES);
  const choices: TurboChoice[] = minutes.map((m) => ({ minutes: m, label: minutesLabel(m) }));
  if (allowUntilOff) choices.push({ minutes: null, label: "Until off" });
  return choices;
}
