import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, parseUsage, weekProjected } from "./policy.ts";

const base = { cur: 4, min: 1, max: 8, loadRatio: 0.7, fiveHourUsed: 30, fiveHourElapsed: 40, weekUsed: 30, weekElapsed: 40 };

test("holds in the middle band", () => assert.equal(decide(base).next, 4));
test("steps up when CPU is idle", () => assert.equal(decide({ ...base, loadRatio: 0.2 }).next, 5));
test("steps down when CPU is hot", () => assert.equal(decide({ ...base, loadRatio: 0.95 }).next, 3));
test("never exceeds max or goes below min", () => {
  assert.equal(decide({ ...base, cur: 8, loadRatio: 0.1 }).next, 8);
  assert.equal(decide({ ...base, cur: 1, loadRatio: 0.99 }).next, 1);
});
test("drops to min near the quota limit", () => {
  assert.equal(decide({ ...base, weekUsed: 91 }).next, 1);
  assert.equal(decide({ ...base, fiveHourUsed: 93, fiveHourElapsed: 95 }).next, 1);
});
test("steps down when 5-hour use is ahead of time elapsed, even if CPU is idle", () => {
  const d = decide({ ...base, loadRatio: 0.1, fiveHourUsed: 70, fiveHourElapsed: 30 });
  assert.equal(d.next, 3);
  assert.match(d.why, /5-hour use ahead of time elapsed/);
});
test("unknown quota does not block scaling up", () => assert.equal(decide({ ...base, loadRatio: 0.1, fiveHourUsed: null, fiveHourElapsed: null, weekUsed: null, weekElapsed: null }).next, 5));

test("weekly use ahead of time elapsed steps down, even if CPU is idle and the 5-hour window is fine", () => {
  const d = decide({ ...base, loadRatio: 0.1, weekUsed: 70, weekElapsed: 30 });
  assert.equal(d.next, 3);
  assert.match(d.why, /weekly use ahead of time elapsed \(70% used, 30% elapsed, projected 233% by reset\)/);
});
test("weekly behind pace does not step down (CPU hot still steps down; no weekly reason)", () => {
  const d = decide({ ...base, weekUsed: 30, weekElapsed: 60 });
  assert.equal(d.next, 4);
  assert.equal(d.why, "hold");
});
test("weekly slack is 6 points: exactly at the edge does not step down, one past does", () => {
  assert.equal(decide({ ...base, weekUsed: 46, weekElapsed: 40 }).next, 4);
  assert.equal(decide({ ...base, weekUsed: 47, weekElapsed: 40 }).next, 3);
});
test("weekly pace rule waits for the first 5% of the week (no thrash in the first hours)", () => {
  assert.equal(decide({ ...base, loadRatio: 0.1, weekUsed: 20, weekElapsed: 4 }).next, 5);
  assert.equal(decide({ ...base, loadRatio: 0.1, weekUsed: 20, weekElapsed: 5 }).next, 3);
});
test("weekly over slack steps down one per tick, down to min", () => {
  let cur = 6;
  const seen: number[] = [];
  for (let i = 0; i < 6; i++) {
    cur = decide({ ...base, cur, loadRatio: 0.7, weekUsed: 70, weekElapsed: 30 }).next;
    seen.push(cur);
  }
  assert.deepEqual(seen, [5, 4, 3, 2, 1, 1]);
});
test("weekly raise gate is 3 points: at or within 3 ahead of elapsed raises, more than 3 holds", () => {
  assert.equal(decide({ ...base, cur: 4, loadRatio: 0.1, weekUsed: 40, weekElapsed: 40 }).next, 5);
  assert.equal(decide({ ...base, cur: 4, loadRatio: 0.1, weekUsed: 41, weekElapsed: 40 }).next, 5);
  assert.equal(decide({ ...base, cur: 4, loadRatio: 0.1, weekUsed: 43, weekElapsed: 40 }).next, 5);
  const hold = decide({ ...base, cur: 4, loadRatio: 0.1, weekUsed: 44, weekElapsed: 40 });
  assert.equal(hold.next, 4);
  assert.equal(hold.why, "hold: no raise while weekly use is more than 3 points ahead of time elapsed (44% used, 40% elapsed, projected 110% by reset); sustainable limit 3");
});
test("weekly raise gate does not step down: over the 6-point slack steps down, between 3 and 6 only holds", () => {
  assert.equal(decide({ ...base, cur: 4, loadRatio: 0.7, weekUsed: 46, weekElapsed: 40 }).next, 4);
  assert.equal(decide({ ...base, cur: 4, loadRatio: 0.7, weekUsed: 47, weekElapsed: 40 }).next, 3);
});
test("weekly 5-point ahead with CPU idle holds at the current limit, reason gives the sustainable limit", () => {
  const d = decide({ ...base, cur: 6, loadRatio: 0.1, weekUsed: 44, weekElapsed: 39 });
  assert.equal(d.next, 6);
  assert.match(d.why, /no raise while weekly use is more than 3 points ahead of time elapsed \(44% used, 39% elapsed, projected 113% by reset\); sustainable limit 5/);
});
test("weekly raise gate with the limit at min holds at min", () => {
  assert.equal(decide({ ...base, cur: 1, min: 1, loadRatio: 0.1, weekUsed: 44, weekElapsed: 40 }).next, 1);
});
test("unknown or under-floor weekly figures never hold the raise", () => {
  assert.equal(decide({ ...base, cur: 4, loadRatio: 0.1, weekUsed: 44, weekElapsed: 4 }).next, 5);
});
test("the first-day example: 21% used with 8% elapsed steps down with the numbers in the reason", () => {
  const d = decide({ ...base, loadRatio: 0.7, weekUsed: 21, weekElapsed: 8 });
  assert.equal(d.next, 3);
  assert.equal(d.why, "weekly use ahead of time elapsed (21% used, 8% elapsed, projected 263% by reset)");
});
test("weekProjected: used over elapsed, null under the floor", () => {
  assert.equal(weekProjected(30, 60), 50);
  assert.equal(weekProjected(10, 4), null);
});
test("weekly unknown (used or elapsed missing) is no signal", () => {
  assert.equal(decide({ ...base, weekUsed: null, weekElapsed: 10 }).next, 4);
  assert.equal(decide({ ...base, weekUsed: 70, weekElapsed: null }).next, 4);
});
test("weekly pace and CPU hot both point down: one step, reason names the first rule that fires", () => {
  const d = decide({ ...base, loadRatio: 0.95, weekUsed: 70, weekElapsed: 30 });
  assert.equal(d.next, 3);
  assert.match(d.why, /weekly use ahead of time elapsed/);
});

const NOW = Date.parse("2026-10-21T10:00:00Z");
test("parses the observed getUsage shape", () => {
  const raw = { machines: [{ providers: [{ providerId: "claude-code", usage: { windows: [
    { label: "Five-hour limit", usedPercent: 27, resetsAt: "2026-10-21T13:29:59.813Z" },
    { label: "Weekly limit", usedPercent: 37, resetsAt: "2026-10-24T20:59:59Z" },
    { label: "Weekly · Fable", usedPercent: 0, resetsAt: "2026-10-24T21:00:00Z" },
  ] } }] }] };
  const u = parseUsage(raw, NOW);
  assert.equal(u.fiveHourUsed, 27);
  assert.equal(u.weekUsed, 37);
  assert.equal(u.fiveHourElapsed, 30); // 3.5h left of 5h => 30% elapsed
  assert.equal(u.weekElapsed, 51); // 83h left of 168h => 49% left, 51% elapsed
  assert.equal(u.weekResetsAt, Date.parse("2026-10-24T20:59:59Z"));
});
test("weekly window without a reset time has no elapsed signal", () => {
  const raw = { machines: [{ providers: [{ providerId: "claude-code", usage: { windows: [{ label: "Weekly limit", usedPercent: 37 }] } }] }] };
  const u = parseUsage(raw, NOW);
  assert.equal(u.weekUsed, 37);
  assert.equal(u.weekElapsed, null);
});
test("tolerates empty or odd input", () => assert.deepEqual(parseUsage(null, NOW), { fiveHourUsed: null, fiveHourElapsed: null, weekUsed: null, weekElapsed: null, weekResetsAt: null }));

import { DEFAULT_TUNING } from "./tuning.ts";
test("the default tuning gives the same decision as no tuning, on a spread of signals", () => {
  const samples = [
    { ...base, loadRatio: 0.1 },
    { ...base, loadRatio: 0.95 },
    { ...base, loadRatio: 0.7, weekUsed: 70, weekElapsed: 30 },
    { ...base, loadRatio: 0.1, fiveHourUsed: 93, fiveHourElapsed: 95 },
    { ...base, loadRatio: 0.1, weekUsed: 44, weekElapsed: 40 },
  ];
  for (const s of samples) assert.deepEqual(decide({ ...s, tuning: DEFAULT_TUNING }), decide(s));
});
test("a changed tunable changes the decision: hotLoad 0.7 steps down at 0.75", () => {
  assert.equal(decide({ ...base, loadRatio: 0.75 }).next, 4, "default 0.85: hold");
  assert.equal(decide({ ...base, loadRatio: 0.75, tuning: { ...DEFAULT_TUNING, hotLoad: 0.7 } }).next, 3);
});
test("a changed quota threshold moves the drop to the minimum", () => {
  assert.doesNotMatch(decide({ ...base, weekUsed: 85 }).why, /quota near limit/, "default 90: not near the limit");
  assert.equal(decide({ ...base, weekUsed: 85, tuning: { ...DEFAULT_TUNING, quotaWeekNear: 80 } }).next, 1);
  assert.match(decide({ ...base, weekUsed: 85, tuning: { ...DEFAULT_TUNING, quotaWeekNear: 80 } }).why, /quota near limit/);
});

// --- Decision kinds, and the quota step a fleet takes one host at a time.
const hotMemory = { reading: { swapUsedPct: 80, freePct: 10, pageoutsPerSec: 0 }, thresholds: { swapHotPercent: 70, memFreeMinPercent: 15 } };
const weekAhead = { ...base, weekUsed: 60, weekElapsed: 44 };
const fiveAhead = { ...base, loadRatio: 0.1, fiveHourUsed: 70, fiveHourElapsed: 30 };

test("each rule names its kind", () => {
  assert.equal(decide(base).kind, "hold");
  assert.equal(decide({ ...base, loadRatio: 0.2 }).kind, "raise");
  assert.equal(decide({ ...base, loadRatio: 0.95 }).kind, "cpu-hot");
  assert.equal(decide({ ...base, weekUsed: 91 }).kind, "quota-cap");
  assert.equal(decide({ ...base, memory: hotMemory }).kind, "memory");
  assert.equal(decide(fiveAhead).kind, "quota-5h");
  assert.equal(decide(weekAhead).kind, "quota-week");
  assert.equal(decide({ ...base, loadRatio: 0.2, weekUsed: 46, weekElapsed: 42 }).kind, "hold-week");
});

test("quotaStepTaken: a host holds instead of taking a second pace step on the same quota", () => {
  const d = decide({ ...weekAhead, quotaStepTaken: "macstudio" });
  assert.equal(d.next, 4, "no step");
  assert.equal(d.kind, "hold");
  assert.match(d.why, /^hold: quota step taken on macstudio this tick \(weekly use ahead of time elapsed/);
  const f = decide({ ...fiveAhead, quotaStepTaken: "macstudio" });
  assert.equal(f.next, 4);
  assert.match(f.why, /quota step taken on macstudio this tick \(5-hour use ahead/);
});

test("quotaStepTaken: the host's own CPU rule still applies, and it does not raise while the quota is ahead", () => {
  const hot = decide({ ...weekAhead, loadRatio: 0.95, quotaStepTaken: "macstudio" });
  assert.equal(hot.next, 3);
  assert.equal(hot.kind, "cpu-hot");
  const idle = decide({ ...weekAhead, loadRatio: 0.1, quotaStepTaken: "macstudio" });
  assert.equal(idle.next, 4, "an idle host does not raise on a quota that is ahead");
  assert.equal(idle.kind, "hold");
});

test("quotaStepTaken does not hold the rules that are not the shared pace step", () => {
  const taken = { quotaStepTaken: "macstudio" };
  assert.equal(decide({ ...base, weekUsed: 91, ...taken }).next, 1, "near the quota cap every host drops to its minimum");
  assert.equal(decide({ ...base, memory: hotMemory, ...taken }).next, 3, "memory pressure is this host's own");
  assert.equal(decide({ ...base, loadRatio: 0.95, ...taken }).next, 3, "CPU hot is this host's own");
});

test("without quotaStepTaken the decisions are as before", () => {
  assert.equal(decide(weekAhead).next, 3);
  assert.equal(decide(fiveAhead).next, 3);
  assert.match(decide(weekAhead).why, /^weekly use ahead of time elapsed/);
});
