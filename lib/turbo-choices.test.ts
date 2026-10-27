import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTurboChoices, minutesLabel } from "./turbo-choices.ts";

const mins = (raw: unknown, allow = false) => parseTurboChoices(raw, allow).map((c) => c.minutes);

test("defaults: 30 min, 1 h, 2 h, then until off", () => {
  assert.deepEqual(parseTurboChoices("30,60,120", true), [
    { minutes: 30, label: "30 min" },
    { minutes: 60, label: "1 h" },
    { minutes: 120, label: "2 h" },
    { minutes: null, label: "Until off" },
  ]);
});

test("until off is left out when the setting turns it off", () => {
  assert.deepEqual(mins("30,60,120", false), [30, 60, 120]);
});

test("custom minutes are kept, sorted and de-duplicated", () => {
  assert.deepEqual(mins("90, 15,45,15"), [15, 45, 90]);
});

test("bad entries are dropped one at a time", () => {
  assert.deepEqual(mins("30,abc,0,721,-5,1.5,60"), [30, 60]);
});

test("nothing valid, or a wrong type, falls back to the defaults", () => {
  assert.deepEqual(mins("nope"), [30, 60, 120]);
  assert.deepEqual(mins(""), [30, 60, 120]);
  assert.deepEqual(mins(undefined), [30, 60, 120]);
  assert.deepEqual(mins(60), [30, 60, 120]);
});

test("at most six buttons are kept, the shortest", () => {
  assert.deepEqual(mins("1,2,3,4,5,6,7,8"), [1, 2, 3, 4, 5, 6]);
});

test("720 minutes (the 12 h cap) is allowed", () => {
  assert.deepEqual(mins("720"), [720]);
});

test("labels", () => {
  assert.equal(minutesLabel(45), "45 min");
  assert.equal(minutesLabel(60), "1 h");
  assert.equal(minutesLabel(90), "1 h 30 min");
  assert.equal(minutesLabel(720), "12 h");
});
