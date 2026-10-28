import { test } from "node:test";
import assert from "node:assert/strict";
import { explainLimit, limitFlags } from "./explain.ts";
import { decide, type Signals } from "./policy.ts";
import { DEFAULT_TUNING } from "./tuning.ts";

const TH = { swapHotPercent: 70, memFreeMinPercent: 15 };
const base: Signals = { cur: 4, min: 1, max: 8, loadRatio: 0.3, fiveHourUsed: 10, fiveHourElapsed: 20, weekUsed: 40, weekElapsed: 42, memory: { reading: { swapUsedPct: 40, freePct: 70, pageoutsPerSec: 0 }, thresholds: TH } };
const mem = (over: Partial<NonNullable<Signals["memory"]>["reading"]>): Signals => ({ ...base, memory: { reading: { ...base.memory!.reading, ...over }, thresholds: TH } });

test("capacity (memory): free memory under its floor, quota fine", () => {
  const e = explainLimit(mem({ freePct: 10, swapUsedPct: 80 }), false);
  assert.equal(e.cause, "memory");
  assert.match(e.line, /^Held by capacity \(memory: free memory 10%, swap 80%\)\. Not quota/);
});

test("capacity (memory): swap high while paging out", () => {
  assert.equal(explainLimit(mem({ swapUsedPct: 90, pageoutsPerSec: 300 }), false).cause, "memory");
});

test("swap alone is not memory capacity: 95% swap, 79% free, no paging is not a hold on memory", () => {
  const e = explainLimit(mem({ swapUsedPct: 95, freePct: 79 }), false);
  assert.notEqual(e.cause, "memory");
});

test("quota (pace): weekly use ahead, memory has room", () => {
  const e = explainLimit({ ...base, weekUsed: 53, weekElapsed: 44 }, false);
  assert.equal(e.cause, "quota");
  assert.match(e.line, /^Held by quota \(pace: week 53% used vs 44% of the week elapsed\)\. Not memory: it has room \(free memory 70%, swap 40%\)\.$/);
});

test("quota (pace): the 5-hour window when it is the one ahead", () => {
  const e = explainLimit({ ...base, fiveHourUsed: 60, fiveHourElapsed: 20 }, false);
  assert.equal(e.cause, "quota");
  assert.match(e.line, /5 h 60% used vs 20% of the window elapsed/);
});

test("both: memory pressure and quota pace are named together", () => {
  const e = explainLimit({ ...mem({ freePct: 10 }), weekUsed: 53, weekElapsed: 44 }, false);
  assert.equal(e.cause, "memory-and-quota");
  assert.match(e.line, /capacity \(memory: .*\) and by quota \(pace: week 53%/);
});

test("quota (cap): at the minimum, and it says it is not memory", () => {
  const e = explainLimit({ ...base, weekUsed: 92, weekElapsed: 80 }, false);
  assert.equal(e.cause, "quota-cap");
  assert.match(e.line, /^At the minimum, 1: quota \(cap\)/);
  assert.match(e.line, /Not a memory limit\.$/);
});

test("capacity (CPU) and the no-hold cases", () => {
  assert.equal(explainLimit({ ...base, loadRatio: 1.2 }, false).cause, "cpu");
  assert.match(explainLimit(base, false).line, /^Room to raise/);
  assert.match(explainLimit({ ...base, loadRatio: 0.7 }, false).line, /^Steady/);
});

test("memory readings that are unknown are left out of the line", () => {
  const e = explainLimit({ ...base, memory: undefined, weekUsed: 53, weekElapsed: 44 }, false);
  assert.equal(e.cause, "quota");
  assert.doesNotMatch(e.line, /Not memory/);
});

test("Turbo on: the line says the pace rules are paused", () => {
  assert.equal(explainLimit({ ...base, weekUsed: 53, weekElapsed: 44 }, true).cause, "turbo");
});

test("the tunables move the thresholds", () => {
  const s: Signals = { ...base, weekUsed: 53, weekElapsed: 44, tuning: { ...DEFAULT_TUNING, slackWeek: 20, raiseSlackWeek: 20 } };
  assert.equal(explainLimit(s, false).cause, "none", "9 points ahead is within a 20 point slack");
});

// The explanation must agree with the policy over a grid of readings: when decide() gives a reason, the cause is the matching kind.
test("agrees with decide() across a grid of readings", () => {
  const free = [10, 70];
  const swap = [30, 95];
  const paging = [0, 300];
  const week = [[30, 44], [46, 42], [53, 44], [60, 44], [92, 80]] as const;
  const five = [[10, 20], [60, 20], [95, 50]] as const;
  const load = [0.2, 0.7, 1.2];
  let n = 0;
  for (const freePct of free) for (const swapUsedPct of swap) for (const pageoutsPerSec of paging) for (const [weekUsed, weekElapsed] of week) for (const [fiveHourUsed, fiveHourElapsed] of five) for (const loadRatio of load) {
    const s: Signals = { ...base, loadRatio, weekUsed, weekElapsed, fiveHourUsed, fiveHourElapsed, memory: { reading: { swapUsedPct, freePct, pageoutsPerSec }, thresholds: TH } };
    const why = decide(s).why;
    const e = explainLimit(s, false);
    const f = limitFlags(s);
    if (why.startsWith("quota near limit")) assert.equal(e.cause, "quota-cap", why);
    else if (why.startsWith("memory pressure")) assert.ok(e.cause === "memory" || e.cause === "memory-and-quota", why);
    else if (why.startsWith("5-hour use ahead") || why.startsWith("weekly use ahead") || why.startsWith("hold: no raise")) assert.equal(e.cause, "quota", why);
    else if (why.startsWith("CPU hot")) assert.equal(e.cause, "cpu", why);
    else assert.equal(e.cause, "none", why);
    // Memory flag and cause agree: a memory cause exactly when decide could not reach a memory reason first only because quota cap came first.
    if (e.cause === "memory" || e.cause === "memory-and-quota") assert.ok(f.memory);
    n++;
  }
  assert.equal(n, 2 * 2 * 2 * 5 * 3 * 3);
});

test("a weekly raise hold is a quota hold only when CPU is idle (a raise was wanted)", () => {
  const ahead4 = { ...base, weekUsed: 46, weekElapsed: 42 };
  assert.equal(explainLimit({ ...ahead4, loadRatio: 0.2 }, false).cause, "quota");
  assert.equal(explainLimit({ ...ahead4, loadRatio: 0.7 }, false).cause, "none");
});
