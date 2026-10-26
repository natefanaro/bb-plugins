// One tick's plan: what to write, whether Turbo ends, and what the reason says. Pure: the server gathers the readings and carries the plan out.
// A tick that ends Turbo writes nothing. Its readings are from before the restore, so the next tick decides from fresh ones.
import type { Decision } from "./policy.ts";
import type { Gate } from "./override.ts";
import { turboStep, turboSentence, type Turbo } from "./turbo.ts";

export interface PlanInput {
  apply: boolean;
  cur: number;
  /** Turbo as stored, or null. */
  turbo: Turbo | null;
  /** Why Turbo should end now (from turboEndReason), or null while it runs. */
  endReason: string | null;
  /** The value Pacer last set, or null before its first write. */
  lastSet: number | null;
  decision: Decision;
  gate: Gate;
}

export type Plan =
  /** An applied tick that ends Turbo: the caller ends it, writes nothing, and the next tick decides. */
  | { kind: "turbo-ended"; reason: string; next: number; why: string; write: null }
  /** Turbo is on. `write` is the limit to write, or null to hold. `baseline` records the limit without writing. */
  | { kind: "turbo"; step: "baseline" | "write" | "hold"; next: number; why: string; write: number | null }
  /** Turbo is off: the scheduler's rule through the back-off gate. */
  | { kind: "normal"; next: number; why: string; write: number | null };

export function planTick(i: PlanInput): Plan {
  if (i.turbo !== null && i.endReason !== null && i.apply) {
    return { kind: "turbo-ended", reason: i.endReason, next: i.cur, why: `Turbo ended: ${i.endReason}. The next tick decides.`, write: null };
  }
  if (i.turbo !== null && i.endReason === null) {
    // Status (apply=false) never writes and never commits; it still shows the plan.
    const step = turboStep(i.lastSet, i.cur, i.turbo.limit);
    if (step.kind === "baseline") return { kind: "turbo", step: "baseline", next: i.cur, why: "Turbo: recorded the limit as the baseline, not writing this tick", write: null };
    if (step.kind === "write") return { kind: "turbo", step: "write", next: step.limit, why: turboSentence(i.turbo), write: i.apply ? step.limit : null };
    // "manual" cannot reach here: a manual change ends Turbo above. Hold covers the rest.
    return { kind: "turbo", step: "hold", next: i.cur, why: turboSentence(i.turbo), write: null };
  }
  const { decision: d, gate: g } = i;
  const wantWrite = i.apply && g.apply && d.next !== i.cur;
  return { kind: "normal", next: g.apply ? d.next : i.cur, why: g.why ?? d.why, write: wantWrite ? d.next : null };
}
