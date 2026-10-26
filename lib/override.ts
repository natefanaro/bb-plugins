// Manual-override guard: if the host limit no longer matches what Pacer last set, someone changed it by hand. Back off for a window instead of overwriting it. Pure: the caller passes the clock and keeps the state.
export interface OverrideState {
  /** The limit Pacer last wrote, or null before its first write. */
  lastSet: number | null;
  /** Epoch ms until which Pacer does not write. 0 = not paused. */
  pausedUntil: number;
}
export interface Gate { apply: boolean; state: OverrideState; why: string | null }

export const NO_OVERRIDE: OverrideState = { lastSet: null, pausedUntil: 0 };

/** Accepts only the stored shape. Anything else is no state (the first tick then records a baseline), so a damaged record cannot pin the limit or the back-off. */
export function parseOverride(raw: unknown): OverrideState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { lastSet, pausedUntil } = raw as Record<string, unknown>;
  if (lastSet !== null && (!Number.isInteger(lastSet) || (lastSet as number) < 1)) return null;
  if (typeof pausedUntil !== "number" || !Number.isFinite(pausedUntil) || pausedUntil < 0) return null;
  return { lastSet: lastSet as number | null, pausedUntil };
}

/**
 * Decide whether this tick may write. `cur` is the host limit read this tick.
 * `state` is the state to keep after this tick, whether or not it writes; the caller commits it only on scheduled and CLI-applied ticks.
 */
export function gate(state: OverrideState, cur: number, now: number, windowMs: number): Gate {
  // No baseline yet (the first tick ever, or no usable stored state): record what is there and do not write over it.
  if (state.lastSet === null) return { apply: false, state: { lastSet: cur, pausedUntil: 0 }, why: `first tick: recorded ${cur} as the baseline, not writing this tick` };
  // Any change to the limit is manual. Keep the window where it is, but track the latest value so the tick after the window sees no change.
  if (cur !== state.lastSet) {
    if (now < state.pausedUntil) {
      const mins = Math.ceil((state.pausedUntil - now) / 60_000);
      return { apply: false, state: { lastSet: cur, pausedUntil: state.pausedUntil }, why: `manual limit change: backing off, ${mins} min left` };
    }
    return { apply: false, state: { lastSet: cur, pausedUntil: now + windowMs }, why: `manual limit change (${state.lastSet} -> ${cur}): backing off ${Math.round(windowMs / 60_000)} min` };
  }
  if (now < state.pausedUntil) {
    const mins = Math.ceil((state.pausedUntil - now) / 60_000);
    return { apply: false, state, why: `manual limit change: backing off, ${mins} min left` };
  }
  return { apply: true, state, why: null };
}

/**
 * The baseline to record after a write: the limit the host reports back after the write (the same value the next tick reads as `cur`),
 * or the requested value when the response has no read-back. Recording the requested value when the host lands elsewhere (a global cap, a clamp)
 * would make the next tick read a change Pacer did not make and start a back-off.
 */
export function baselineAfterWrite(requested: number, landed: number | null | undefined): number {
  return landed ?? requested;
}
