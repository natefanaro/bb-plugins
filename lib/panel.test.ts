import { test } from "node:test";
import assert from "node:assert/strict";
import { history, lastDecision, loadLevel, paceState, reasonSentence, topCpuName, weekPaceState } from "./panel.ts";
import type { DecisionRecord } from "./decision-log.ts";

const NOW = Date.parse("2026-10-24T18:00:00Z");
const MIN = 60_000;

function rec(minAgo: number, over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    t: new Date(NOW - minAgo * MIN).toISOString(), host: "macmini", cur: 4, next: 4, applied: true, why: "hold",
    load: 0.6, fiveHourUsed: 20, fiveHourElapsed: 30, weekUsed: 60, override: { lastSet: 4, pausedUntil: 0 }, ...over,
  };
}

test("load level uses the same 0.5 and 0.85 thresholds as the scheduler", () => {
  assert.equal(loadLevel(0.49), "idle");
  assert.equal(loadLevel(0.5), "ok");
  assert.equal(loadLevel(0.85), "ok");
  assert.equal(loadLevel(0.86), "hot");
});

test("pace is ahead only past the slack, behind otherwise, unknown when a figure is missing", () => {
  assert.equal(paceState(70, 30), "ahead");
  assert.equal(paceState(55, 30), "behind", "exactly at the 25-point slack is not ahead");
  assert.equal(paceState(46, 40, 6), "behind", "weekly: 6 points is the edge");
  assert.equal(paceState(47, 40, 6), "ahead");
  assert.equal(weekPaceState(46, 40), "behind");
  assert.equal(weekPaceState(47, 40), "ahead");
  assert.equal(weekPaceState(20, 4), "unknown", "below the 5% weekly floor the panel shows unknown, as the policy gives no signal");
  assert.equal(weekPaceState(20, 5), "ahead", "the floor itself counts");
  assert.equal(weekPaceState(null, 40), "unknown");
  assert.equal(paceState(null, 30), "unknown");
  assert.equal(paceState(70, null), "unknown");
});

test("reason sentence: capitalised, with a full stop, and a manual back-off replaces the last reason with minutes left", () => {
  assert.equal(reasonSentence({ why: "CPU hot (load/cpu 1.55)" }, 0, NOW), "CPU hot (load/cpu 1.55).");
  assert.equal(reasonSentence({ why: "hold." }, 0, NOW), "Hold.");
  assert.equal(reasonSentence(null, 0, NOW), "No decision yet since Pacer started.");
  assert.equal(
    reasonSentence({ why: "CPU hot" }, NOW + 47 * MIN, NOW),
    "Backing off after a manual limit change: 47 min left.",
  );
  assert.equal(reasonSentence({ why: "CPU hot" }, NOW - MIN, NOW), "CPU hot.", "a back-off that has ended does not show");
});

test("history: 24 h window, oldest first, limit left in place each tick, changes marked with their reason", () => {
  const records = [
    rec(30, { cur: 4, next: 3, applied: true, why: "CPU hot" }),
    rec(25, { cur: 3, next: 3, applied: true, why: "hold" }),
    rec(20, { cur: 3, next: 3, applied: false, why: "manual limit change (3 -> 1): backing off 120 min" }),
    rec(10, { cur: 1, next: 1, applied: false, why: "manual limit change: backing off" }),
    rec(60 * 25, { cur: 9, next: 8, applied: true, why: "too old" }),
  ];
  const h = history(records, NOW, 24 * 60 * MIN);
  assert.equal(h.windowSec, 24 * 3600);
  assert.deepEqual(h.points.map((p) => p.limit), [3, 3, 3, 1], "the old record is outside the window");
  assert.equal(h.points[0].ageSec, 30 * 60);
  assert.deepEqual(h.changes, [{ ageSec: 30 * 60, from: 4, to: 3, why: "CPU hot" }]);
});

test("history ignores records with bad timestamps and records in the future", () => {
  const records = [rec(5), { ...rec(5), t: "not a date" }, { ...rec(-5) }];
  assert.equal(history(records, NOW, 24 * 60 * MIN).points.length, 1);
});

test("last decision is the newest by timestamp, not the last line of the file", () => {
  const records = [rec(5, { why: "newest" }), rec(30, { why: "older" }), rec(12, { why: "middle" })];
  const last = lastDecision(records);
  assert.equal(last?.why, "newest");
  assert.equal(last?.decidedAt, records[0].t);
});

test("last decision skips records with bad timestamps and is null when there are none", () => {
  assert.equal(lastDecision([]), null);
  assert.equal(lastDecision([{ ...rec(1), t: "not a date" }]), null);
  assert.equal(lastDecision([{ ...rec(1), t: "not a date" }, rec(9, { why: "ok" })])?.why, "ok");
});

test("top CPU: the first process by name, path stripped, arguments never shown", () => {
  const ps = "  %CPU COMM\n 266.3 /System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine\n 113.0 /opt/homebrew/opt/openjdk/bin/java\n";
  assert.deepEqual(topCpuName(ps), { name: "com.apple.Virtualization.VirtualMachine", cpuPct: 266.3 });
  assert.equal(topCpuName("  %CPU COMM\n"), null);
  assert.equal(topCpuName(""), null);
});

import { paceTone } from "./pace.ts";
const pace = (state: "ahead" | "behind" | "unknown") => ({ state });
test("paceTone: ahead on either window is red", () => {
  assert.deepEqual(paceTone({ fiveHour: pace("ahead"), week: pace("behind"), memory: { hot: false } }), { tone: "ahead", label: "ahead of pace" });
  assert.deepEqual(paceTone({ fiveHour: pace("behind"), week: pace("ahead"), memory: { hot: false } }), { tone: "ahead", label: "ahead of pace" });
});
test("paceTone: memory pressure is red and named first, even when quota is fine", () => {
  assert.deepEqual(paceTone({ fiveHour: pace("behind"), week: pace("behind"), memory: { hot: true } }), { tone: "ahead", label: "memory pressure" });
});
test("paceTone: within pace is the primary tone; no reading is muted", () => {
  assert.deepEqual(paceTone({ fiveHour: pace("behind"), week: pace("unknown"), memory: { hot: false } }), { tone: "within", label: "within pace" });
  assert.deepEqual(paceTone({ fiveHour: pace("unknown"), week: pace("unknown"), memory: { hot: false } }), { tone: "unknown", label: "no quota reading" });
});
