import { test } from "node:test";
import assert from "node:assert/strict";
import { baselineAfterWrite, gate, NO_OVERRIDE, parseOverride, type OverrideState } from "./override.ts";

const MIN = 60_000;
const WINDOW = 120 * MIN;
const T0 = Date.parse("2026-10-24T13:00:00Z");

test("first tick with no baseline records the limit and does not write over it", () => {
  const g = gate(NO_OVERRIDE, 2, T0, WINDOW);
  assert.equal(g.apply, false);
  assert.deepEqual(g.state, { lastSet: 2, pausedUntil: 0 });
  assert.match(g.why ?? "", /recorded 2 as the baseline/);
});

test("the tick after the baseline is recorded can write", () => {
  const baseline = gate(NO_OVERRIDE, 2, T0, WINDOW).state;
  assert.equal(gate(baseline, 2, T0 + 5 * MIN, WINDOW).apply, true);
});

test("a restart with a manual limit does not overwrite it on the first tick", () => {
  // After a restart the state is NO_OVERRIDE again; the limit the operator set by hand is 1.
  const g = gate(NO_OVERRIDE, 1, T0, WINDOW);
  assert.equal(g.apply, false);
  assert.equal(g.state.lastSet, 1);
});

test("limit still matching what Pacer last set applies", () => {
  const s: OverrideState = { lastSet: 5, pausedUntil: 0 };
  assert.equal(gate(s, 5, T0, WINDOW).apply, true);
});

test("a changed limit is a manual change: no write, back off for the window, baseline is the manual value", () => {
  const s: OverrideState = { lastSet: 5, pausedUntil: 0 };
  const g = gate(s, 1, T0, WINDOW);
  assert.equal(g.apply, false);
  assert.match(g.why ?? "", /manual limit change \(5 -> 1\)/);
  assert.deepEqual(g.state, { lastSet: 1, pausedUntil: T0 + WINDOW });
});

test("during the window, ticks do not write even if the limit matches", () => {
  const paused: OverrideState = { lastSet: 1, pausedUntil: T0 + WINDOW };
  const g = gate(paused, 1, T0 + 30 * MIN, WINDOW);
  assert.equal(g.apply, false);
  assert.match(g.why ?? "", /backing off, 90 min left/);
  assert.deepEqual(g.state, paused);
});

test("after the window, Pacer resumes writing from the manual value", () => {
  const paused: OverrideState = { lastSet: 1, pausedUntil: T0 + WINDOW };
  const g = gate(paused, 1, T0 + WINDOW, WINDOW);
  assert.equal(g.apply, true);
});

test("a second manual change during the window extends nothing: the window stays put", () => {
  const paused: OverrideState = { lastSet: 1, pausedUntil: T0 + WINDOW };
  const g = gate(paused, 4, T0 + 10 * MIN, WINDOW);
  assert.equal(g.apply, false);
  assert.equal(g.state.pausedUntil, T0 + WINDOW);
});

test("a second manual change during the window updates the baseline, so the tick after the window does not see a new change", () => {
  const paused: OverrideState = { lastSet: 1, pausedUntil: T0 + WINDOW };
  const during = gate(paused, 4, T0 + 10 * MIN, WINDOW);
  assert.deepEqual(during.state, { lastSet: 4, pausedUntil: T0 + WINDOW });
  const after = gate(during.state, 4, T0 + WINDOW, WINDOW);
  assert.equal(after.apply, true, "tick after the window writes");
  assert.equal(after.state.pausedUntil, T0 + WINDOW, "no second window started");
});

test("a change after the window ends starts a new window", () => {
  const s: OverrideState = { lastSet: 1, pausedUntil: T0 + WINDOW };
  const g = gate(s, 3, T0 + WINDOW + MIN, WINDOW);
  assert.equal(g.apply, false);
  assert.deepEqual(g.state, { lastSet: 3, pausedUntil: T0 + WINDOW + MIN + WINDOW });
});

test("a window of 0 detects the change and resumes on the next tick", () => {
  const s: OverrideState = { lastSet: 5, pausedUntil: 0 };
  const detected = gate(s, 2, T0, 0);
  assert.equal(detected.apply, false);
  assert.equal(gate(detected.state, 2, T0, 0).apply, true);
});

test("baseline after a write is the limit the host reports back, not the requested value", () => {
  // Requested 5; a global cap lands the host at 4. The next tick reads 4.
  assert.equal(baselineAfterWrite(5, 4), 4);
  assert.equal(baselineAfterWrite(5, 5), 5);
});

test("no read-back in the response falls back to the requested value", () => {
  assert.equal(baselineAfterWrite(5, null), 5);
  assert.equal(baselineAfterWrite(5, undefined), 5);
});

test("a clamped write does not start a back-off on the next tick", () => {
  // Pacer wrote 5, the host landed at 4 and recorded 4 as the baseline. The next tick reads 4.
  const landed: OverrideState = { lastSet: baselineAfterWrite(5, 4), pausedUntil: 0 };
  const next = gate(landed, 4, T0 + 5 * MIN, WINDOW);
  assert.equal(next.apply, true);
  assert.equal(next.state.pausedUntil, 0);
});

test("the old behaviour (baseline = requested value) would have read the clamp as a manual change", () => {
  const requestedBaseline: OverrideState = { lastSet: 5, pausedUntil: 0 };
  const next = gate(requestedBaseline, 4, T0 + 5 * MIN, WINDOW);
  assert.equal(next.apply, false);
  assert.equal(next.state.pausedUntil, T0 + 5 * MIN + WINDOW);
});

test("a stored back-off parses back and still holds after a reload (the window end is wall-clock time)", () => {
  const stored = JSON.parse(JSON.stringify({ lastSet: 3, pausedUntil: T0 + WINDOW })) as unknown;
  const state = parseOverride(stored);
  assert.deepEqual(state, { lastSet: 3, pausedUntil: T0 + WINDOW });
  const during = gate(state as OverrideState, 3, T0 + 30 * MIN, WINDOW);
  assert.equal(during.apply, false, "still backing off after a reload");
  assert.equal(gate(state as OverrideState, 3, T0 + WINDOW, WINDOW).apply, true, "resumes when the window ends");
});

test("a restart with a manual change during downtime backs off, instead of taking the change as the baseline", () => {
  const state = parseOverride({ lastSet: 5, pausedUntil: 0 }) as OverrideState;
  const g = gate(state, 2, T0, WINDOW);
  assert.equal(g.apply, false);
  assert.deepEqual(g.state, { lastSet: 2, pausedUntil: T0 + WINDOW });
});

test("damaged stored back-off is no state: the first tick then records a baseline", () => {
  assert.equal(parseOverride(null), null);
  assert.equal(parseOverride({ lastSet: 0, pausedUntil: 0 }), null);
  assert.equal(parseOverride({ lastSet: 2.5, pausedUntil: 0 }), null);
  assert.equal(parseOverride({ lastSet: 2, pausedUntil: -1 }), null);
  assert.equal(parseOverride({ lastSet: 2, pausedUntil: NaN }), null);
  assert.equal(parseOverride({ lastSet: null, pausedUntil: 0 })?.lastSet, null, "no baseline yet is a valid state");
});
