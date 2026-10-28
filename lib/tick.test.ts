import { test } from "node:test";
import assert from "node:assert/strict";
import { planTick, type PlanInput } from "./tick.ts";
import type { Gate } from "./override.ts";
import type { Turbo } from "./turbo.ts";

const T0 = Date.parse("2026-10-24T13:00:00Z");
const HOST = "host_1";

function turbo(over: Partial<Turbo> = {}): Turbo {
  return { startedAt: T0, until: T0 + 3600_000, untilOff: false, limit: 6, by: "cli", hostId: HOST, globalBefore: 4, globalRaised: true, ...over };
}
const open: Gate = { apply: true, state: { lastSet: 4, pausedUntil: 0 }, why: null };
const held: Gate = { apply: false, state: { lastSet: 4, pausedUntil: T0 + 60_000 }, why: "manual limit change: backing off, 1 min left" };

function input(over: Partial<PlanInput> = {}): PlanInput {
  return { apply: true, cur: 4, turbo: null, endReason: null, lastSet: 4, decision: { next: 5, why: "CPU idle (load/cpu 0.2)", kind: "raise" }, gate: open, ...over };
}

test("end then write in one tick: the tick that ends Turbo writes nothing (the restore is not overwritten)", () => {
  // Turbo at 6 with the cap raised from 4; the weekly reset ends it; the CPU rule would want 5.
  const p = planTick(input({ turbo: turbo(), endReason: "weekly quota reset", cur: 6, lastSet: 6, decision: { next: 5, why: "CPU idle", kind: "raise" } }));
  assert.equal(p.kind, "turbo-ended");
  assert.equal(p.write, null);
  assert.match(p.why, /Turbo ended: weekly quota reset\. The next tick decides\./);
});

test("the turbo-ended plan writes nothing for any end reason, including the quota cap and a manual change", () => {
  for (const reason of ["quota near limit", "manual limit change", "time box ended"]) {
    const p = planTick(input({ turbo: turbo(), endReason: reason, cur: 6, lastSet: 6 }));
    assert.equal(p.kind, "turbo-ended");
    assert.equal(p.write, null, reason);
  }
});

test("status never ends Turbo and never writes, even when Turbo would end", () => {
  const p = planTick(input({ apply: false, turbo: turbo(), endReason: "time box ended", cur: 6, lastSet: 6 }));
  assert.notEqual(p.kind, "turbo-ended", "status does not end Turbo");
  assert.equal(p.write, null);
});

test("a Turbo write goes to the chosen limit on an applied tick and is a plan only for status", () => {
  const p = planTick(input({ turbo: turbo(), endReason: null, cur: 4, lastSet: 4 }));
  assert.deepEqual(p, { kind: "turbo", step: "write", next: 6, why: p.kind === "turbo" ? p.why : "", write: 6 });
  const status = planTick(input({ apply: false, turbo: turbo(), endReason: null, cur: 4, lastSet: 4 }));
  assert.equal(status.write, null);
  assert.equal(status.kind === "turbo" ? status.next : null, 6);
});

test("Turbo holds when its limit is in place, and records the baseline with no history", () => {
  assert.equal(planTick(input({ turbo: turbo(), cur: 6, lastSet: 6 })).write, null);
  const base = planTick(input({ turbo: turbo(), cur: 3, lastSet: null }));
  assert.equal(base.kind === "turbo" ? base.step : null, "baseline");
  assert.equal(base.write, null, "the first tick after a restart records and does not write");
});

test("Turbo ignores the CPU rule and the back-off gate while it runs", () => {
  const p = planTick(input({ turbo: turbo(), cur: 4, lastSet: 4, gate: held, decision: { next: 3, why: "CPU hot", kind: "cpu-hot" } }));
  assert.equal(p.kind, "turbo");
  assert.equal(p.write, 6);
});

test("off: the scheduler's rule writes through the back-off gate", () => {
  const p = planTick(input({ cur: 4, decision: { next: 5, why: "CPU idle", kind: "raise" } }));
  assert.deepEqual(p, { kind: "normal", next: 5, why: "CPU idle", write: 5 });
});

test("off: a held back-off writes nothing and shows its reason", () => {
  const p = planTick(input({ cur: 4, gate: held, decision: { next: 5, why: "CPU idle", kind: "raise" } }));
  assert.equal(p.write, null);
  assert.equal(p.next, 4);
  assert.equal(p.why, held.why);
});

test("off: status changes nothing", () => {
  const p = planTick(input({ apply: false, cur: 4, decision: { next: 5, why: "CPU idle", kind: "raise" } }));
  assert.equal(p.write, null);
  assert.equal(p.next, 5, "shows the rule's choice");
});
