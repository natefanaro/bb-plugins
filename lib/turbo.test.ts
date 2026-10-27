import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTurbo, quotaNear, raisesCap, startTurbo, turboCapRestore, turboEndReason, turboMemoryEndReason, turboSentence, turboStartBlock, TURBO_UNTIL_OFF_MS, turboStep, turboSuggested, TURBO_DEFAULT_MS, type Turbo } from "./turbo.ts";

const MIN = 60_000;
const H = 3600_000;
const T0 = Date.parse("2026-10-24T19:00:00Z");
const HOST = "host_1";

function turbo(over: Partial<Turbo> = {}): Turbo {
  return { startedAt: T0, until: T0 + H, untilOff: false, limit: 6, by: "cli", hostId: HOST, globalBefore: null, globalRaised: false, ...over };
}

test("start: until is now plus the time box; the limit, starter, host and cap state are kept", () => {
  const t = startTurbo(T0, 6, TURBO_DEFAULT_MS, "cli", HOST, 4, true);
  assert.deepEqual(t, { startedAt: T0, until: T0 + 2 * H, untilOff: false, limit: 6, by: "cli", hostId: HOST, globalBefore: 4, globalRaised: true });
});

test("start rejects a limit outside 1..16, a non-whole limit, and a bad duration", () => {
  assert.throws(() => startTurbo(T0, 0, H, "cli", HOST, null, false));
  assert.throws(() => startTurbo(T0, 17, H, "panel", HOST, null, false));
  assert.throws(() => startTurbo(T0, 2.5, H, "cli", HOST, null, false));
  assert.throws(() => startTurbo(T0, 3, 0, "cli", HOST, null, false));
  assert.throws(() => startTurbo(T0, 3, 13 * H, "cli", HOST, null, false));
});

test("a cap is raised only when it is set and below the limit", () => {
  assert.equal(raisesCap(4, 6), true);
  assert.equal(raisesCap(6, 6), false);
  assert.equal(raisesCap(8, 6), false);
  assert.equal(raisesCap(null, 16), false, "no cap set: nothing to raise");
});

test("restart: a stored Turbo parses back and is still running at a later time (state survives a reload)", () => {
  const stored = JSON.parse(JSON.stringify(turbo({ by: "panel", globalBefore: 4, globalRaised: true }))) as unknown;
  const back = parseTurbo(stored);
  assert.deepEqual(back, turbo({ by: "panel", globalBefore: 4, globalRaised: true }));
  assert.equal(turboEndReason(back as Turbo, T0 + 30 * MIN, null, false, false), null, "still running after a restart");
});

test("a damaged stored record is no Turbo, so it cannot pin the limit", () => {
  assert.equal(parseTurbo(null), null);
  assert.equal(parseTurbo("on"), null);
  assert.equal(parseTurbo({ ...turbo(), limit: 0 }), null);
  assert.equal(parseTurbo({ ...turbo(), limit: 99 }), null);
  assert.equal(parseTurbo({ ...turbo(), limit: 2.5 }), null);
  assert.equal(parseTurbo({ ...turbo(), by: "someone" }), null);
  assert.equal(parseTurbo({ ...turbo(), until: T0 }), null, "an empty time box is not Turbo");
  assert.equal(parseTurbo({ ...turbo(), hostId: "" }), null, "no host, no Turbo");
  assert.equal(parseTurbo({ ...turbo(), globalRaised: "yes" }), null);
});

test("expiry: runs until the time box ends, then ends by itself", () => {
  assert.equal(turboEndReason(turbo(), T0 + H - 1, null, false, false), null);
  assert.equal(turboEndReason(turbo(), T0 + H, null, false, false), "time box ended");
});

test("quota cap: near the cap ends Turbo at once, whatever the time box says", () => {
  assert.equal(turboEndReason(turbo(), T0 + MIN, null, true, false), "quota near limit");
});

test("weekly reset ends Turbo before its time box if the reset comes first", () => {
  const t = turbo({ until: T0 + 2 * H });
  const reset = T0 + 90 * MIN;
  assert.equal(turboEndReason(t, reset - 1, reset, false, false), null);
  assert.equal(turboEndReason(t, reset, reset, false, false), "weekly quota reset");
});

test("a manual limit change ends Turbo, and the cap and quota reasons come first", () => {
  assert.equal(turboEndReason(turbo(), T0 + MIN, null, false, true), "manual limit change");
  assert.equal(turboEndReason(turbo(), T0 + MIN, null, true, true), "quota near limit");
});

test("manual lower during Turbo: the step is manual, so Turbo ends and nothing is written", () => {
  // Turbo holds 6; someone sets the limit to 2 by hand (cur 2, last set by Coach 6).
  assert.deepEqual(turboStep(6, 2, 6), { kind: "manual" });
});

test("Turbo's own write does not count as manual: after it lands, cur equals the value Coach last set", () => {
  // Turbo wrote 6 and the host landed at 6.
  assert.deepEqual(turboStep(6, 6, 6), { kind: "hold" });
  // Turbo wrote 6, the host landed at 5 (a cap): the landed value is the baseline, so this is not manual and Turbo keeps trying.
  assert.deepEqual(turboStep(5, 5, 6), { kind: "write", limit: 6 });
});

test("first tick with no baseline records the limit; it is never treated as a manual change", () => {
  assert.deepEqual(turboStep(null, 2, 6), { kind: "baseline" });
});

test("a Turbo whose limit is not yet in place writes it", () => {
  assert.deepEqual(turboStep(3, 3, 6), { kind: "write", limit: 6 });
});

test("cap restore: the overall cap goes back to its value before Turbo, and the host's override cannot stay above it", () => {
  const cfg = { globalLimit: 16, hostOverrides: [{ hostId: HOST, limit: 16 }, { hostId: "other", limit: 9 }] };
  const restored = turboCapRestore(cfg, turbo({ globalBefore: 4, globalRaised: true }));
  assert.equal(restored.globalLimit, 4);
  assert.deepEqual(restored.hostOverrides, [{ hostId: HOST, limit: 4 }, { hostId: "other", limit: 9 }]);
});

test("cap restore: a cap that was not set goes back to not set, and the host override is kept", () => {
  const cfg = { globalLimit: 6, hostOverrides: [{ hostId: HOST, limit: 6 }] };
  const restored = turboCapRestore(cfg, turbo({ globalBefore: null, globalRaised: false }));
  assert.equal(restored.globalLimit, null);
  assert.deepEqual(restored.hostOverrides, [{ hostId: HOST, limit: 6 }]);
});

test("quota cap is the same rule the scheduler uses: week at 90, five-hour at 92", () => {
  assert.equal(quotaNear({ weekUsed: 90, fiveHourUsed: 0 }), true);
  assert.equal(quotaNear({ weekUsed: 89, fiveHourUsed: 0 }), false);
  assert.equal(quotaNear({ weekUsed: null, fiveHourUsed: 92 }), true);
  assert.equal(quotaNear({ weekUsed: null, fiveHourUsed: null }), false);
});

test("suggestion: weekly use more than 10 points behind the week's elapsed time, with 3 h or less to reset", () => {
  const reset = T0 + 2 * H;
  assert.equal(turboSuggested(60, 75, reset, T0), true, "15 points behind, 2 h left");
  assert.equal(turboSuggested(65, 75, reset, T0), false, "exactly 10 behind is not enough");
  assert.equal(turboSuggested(60, 75, T0 + 5 * H, T0), false, "more than 3 h left");
  assert.equal(turboSuggested(60, 75, reset, reset), false, "after the reset there is nothing left to suggest for");
  assert.equal(turboSuggested(null, 75, reset, T0), false, "unknown weekly use is no signal");
});

test("sentence names the limit, the end time and who started it", () => {
  assert.match(turboSentence(turbo({ by: "panel" })), /^Turbo on: limit 6 until .+, started by panel\.$/);
});

test("start with a null duration runs until turned off, stored with a far-future numeric time box", () => {
  const t = startTurbo(T0, 6, null, "panel", HOST, null, false);
  assert.equal(t.untilOff, true);
  assert.equal(t.until, T0 + TURBO_UNTIL_OFF_MS);
  assert.equal(typeof t.until, "number", "an older build that only knows time boxes can still read the record");
  assert.deepEqual(parseTurbo(JSON.parse(JSON.stringify(t))), t, "survives storage");
});

test("a stored record without the untilOff flag is a time-boxed Turbo; a bad flag or time box is no Turbo", () => {
  const { untilOff: _drop, ...old } = turbo();
  assert.deepEqual(parseTurbo(old), turbo());
  assert.equal(parseTurbo({ ...turbo(), untilOff: "yes" }), null);
  assert.equal(parseTurbo({ ...turbo(), until: undefined }), null);
  assert.equal(parseTurbo({ ...turbo(), until: "soon" }), null);
});

test("a record from the first until-off build (null time box) reads as until off", () => {
  const { untilOff: _drop, ...old } = turbo();
  const t = parseTurbo({ ...old, until: null });
  assert.equal(t?.untilOff, true);
  assert.equal(t?.until, T0 + TURBO_UNTIL_OFF_MS);
});

test("until off never ends by the clock, but the other end rules still apply", () => {
  const t = turbo({ until: T0 + TURBO_UNTIL_OFF_MS, untilOff: true });
  assert.equal(turboEndReason(t, T0 + 100 * H, null, false, false), null, "a time box would have ended long ago");
  assert.equal(turboEndReason(t, T0 + 100 * H, null, true, false), "quota near limit");
  assert.equal(turboEndReason(t, T0 + 100 * H, null, false, true), "manual limit change");
  assert.equal(turboEndReason(t, T0 + H, T0 + H, false, false), "weekly quota reset");
});

const HOT_MEMORY = { swapUsedPct: 80, freePct: 10, pageoutsPerSec: 0 };
const CALM_HIGH_SWAP = { swapUsedPct: 95, freePct: 79, pageoutsPerSec: 0 };
const TH = { swapHotPercent: 70, memFreeMinPercent: 15, pageoutHotPerSec: 100 };

test("memory pressure ends Turbo: free memory low, or swap high while paging out", () => {
  assert.match(turboMemoryEndReason(HOT_MEMORY, TH, 0) ?? "", /^memory pressure \(free memory 10%/);
  assert.match(turboMemoryEndReason({ swapUsedPct: 90, freePct: 60, pageoutsPerSec: 200 }, TH, 0) ?? "", /^memory pressure/);
});

test("swap alone is not pressure: a calm host at 95% swap with 79% free does not end Turbo", () => {
  assert.equal(turboMemoryEndReason(CALM_HIGH_SWAP, TH, 0), null);
  assert.equal(turboMemoryEndReason({ swapUsedPct: 95, freePct: 79, pageoutsPerSec: 5 }, TH, 0), null);
});

test("the optional raw swap line ends Turbo at or above it; 0 leaves it off; unreadable figures do not end it", () => {
  assert.match(turboMemoryEndReason(CALM_HIGH_SWAP, TH, 95) ?? "", /^swap at 95%, the Turbo swap end line \(95%\)$/);
  assert.equal(turboMemoryEndReason({ ...CALM_HIGH_SWAP, swapUsedPct: 94 }, TH, 95), null);
  assert.equal(turboMemoryEndReason({ swapUsedPct: null, freePct: null, pageoutsPerSec: null }, TH, 95), null);
});

test("a memory reason ends Turbo after the quota cap and before a manual change", () => {
  const why = "memory pressure (free memory 10%)";
  assert.equal(turboEndReason(turbo(), T0 + MIN, null, false, false, why), why);
  assert.equal(turboEndReason(turbo(), T0 + MIN, null, true, false, why), "quota near limit");
  assert.equal(turboEndReason(turbo(), T0 + MIN, null, false, true, why), why);
  assert.equal(turboEndReason(turbo(), T0 + MIN, null, false, false, null), null);
});

test("a start is blocked when an end condition already holds, with that reason", () => {
  assert.equal(turboStartBlock(T0, null, false, null), null);
  assert.equal(turboStartBlock(T0, null, true, null), "quota near limit");
  assert.equal(turboStartBlock(T0, null, false, "memory pressure (free memory 10%)"), "memory pressure (free memory 10%)");
  assert.equal(turboStartBlock(T0, T0 - 1, false, null), "weekly quota reset");
  assert.equal(turboStartBlock(T0, T0 + H, false, null), null, "a reset still ahead does not block");
});

test("the sentence says so when there is no time box", () => {
  assert.equal(turboSentence(turbo({ until: T0 + TURBO_UNTIL_OFF_MS, untilOff: true })), "Turbo on: limit 6 until you turn it off, started by cli.");
});
