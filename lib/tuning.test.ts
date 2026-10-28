import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TUNING, tuningFrom } from "./tuning.ts";

test("the defaults are the values the plugin shipped with", () => {
  assert.deepEqual(DEFAULT_TUNING, { hotLoad: 0.85, idleLoad: 0.5, quotaFiveHourNear: 92, quotaWeekNear: 90, slackFiveHour: 25, slackWeek: 6, raiseSlackWeek: 3, pageoutHotPerSec: 100, opencodeSlots: 1, turboSwapEndPercent: 0, urgentSlots: 1, urgentReportMinutes: 120, reserveFiveHour: 60, reserveWeek: 1, reserveWeekMargin: 10 });
});
test("tuningFrom takes the settings and falls back to the default for a missing or non-numeric value", () => {
  assert.deepEqual(tuningFrom({}), DEFAULT_TUNING);
  assert.equal(tuningFrom({ hotLoad: 0.7, slackWeek: "x" as unknown as number }).hotLoad, 0.7);
  assert.equal(tuningFrom({ slackWeek: "x" as unknown as number }).slackWeek, DEFAULT_TUNING.slackWeek);
  assert.equal(tuningFrom({ pageoutHotPerSec: Number.NaN }).pageoutHotPerSec, 100);
});

test("a quota threshold of 0 or above 100 falls back to its default; 1 and 100 are kept", () => {
  assert.equal(tuningFrom({ quotaWeekNear: 0 }).quotaWeekNear, 90, "0 would pin the limit to min");
  assert.equal(tuningFrom({ quotaWeekNear: 101 }).quotaWeekNear, 90);
  assert.equal(tuningFrom({ quotaFiveHourNear: -5 }).quotaFiveHourNear, 92);
  assert.equal(tuningFrom({ quotaWeekNear: 1 }).quotaWeekNear, 1);
  assert.equal(tuningFrom({ quotaWeekNear: 100 }).quotaWeekNear, 100);
});
test("slacks are 0 to 100: negatives and above 100 fall back; 0 is kept", () => {
  assert.equal(tuningFrom({ slackFiveHour: -1 }).slackFiveHour, 25);
  assert.equal(tuningFrom({ slackWeek: 101 }).slackWeek, 6);
  assert.equal(tuningFrom({ raiseSlackWeek: 0 }).raiseSlackWeek, 0);
});
test("loads must be above 0; a bad load falls back to its own default", () => {
  assert.equal(tuningFrom({ hotLoad: 0 }).hotLoad, 0.85);
  assert.equal(tuningFrom({ idleLoad: -0.2 }).idleLoad, 0.5);
  assert.equal(tuningFrom({ hotLoad: 1.2 }).hotLoad, 1.2, "a valid load above 1 is kept");
});
test("non-finite and non-numeric values fall back, per value", () => {
  assert.equal(tuningFrom({ hotLoad: Number.POSITIVE_INFINITY }).hotLoad, 0.85);
  assert.equal(tuningFrom({ slackWeek: Number.NaN }).slackWeek, 6);
  assert.equal(tuningFrom({ pageoutHotPerSec: "100" as unknown as number }).pageoutHotPerSec, 100);
  assert.equal(tuningFrom({ pageoutHotPerSec: -1 }).pageoutHotPerSec, 100);
  assert.equal(tuningFrom({ pageoutHotPerSec: 0 }).pageoutHotPerSec, 0, "0 page-outs is a valid setting");
});
test("idle load must stay below hot load: idle falls back first, then hot if still not below", () => {
  assert.deepEqual([tuningFrom({ hotLoad: 0.6, idleLoad: 0.7 }).hotLoad, tuningFrom({ hotLoad: 0.6, idleLoad: 0.7 }).idleLoad], [0.6, 0.5], "idle back to its default 0.5, which is below 0.6");
  const t = tuningFrom({ hotLoad: 0.4, idleLoad: 0.7 });
  assert.equal(t.idleLoad, 0.5);
  assert.equal(t.hotLoad, 0.85, "0.5 is not below 0.4, so hot falls back");
  assert.ok(tuningFrom({ hotLoad: 0.3, idleLoad: 0.2 }).idleLoad < tuningFrom({ hotLoad: 0.3, idleLoad: 0.2 }).hotLoad);
});
test("opencodeSlots is a whole number 0 to 10; anything else falls back to 1; 0 is kept (feature off)", () => {
  assert.equal(tuningFrom({ opencodeSlots: 0 }).opencodeSlots, 0);
  assert.equal(tuningFrom({ opencodeSlots: 10 }).opencodeSlots, 10);
  assert.equal(tuningFrom({ opencodeSlots: 2.5 }).opencodeSlots, 1);
  assert.equal(tuningFrom({ opencodeSlots: -1 }).opencodeSlots, 1);
  assert.equal(tuningFrom({ opencodeSlots: 11 }).opencodeSlots, 1);
  assert.equal(tuningFrom({ opencodeSlots: "2" as unknown as number }).opencodeSlots, 1);
});

test("turboSwapEndPercent is 0 (off, the default) or 50 to 100; anything else falls back to 0", () => {
  assert.equal(tuningFrom({ turboSwapEndPercent: 0 }).turboSwapEndPercent, 0);
  assert.equal(tuningFrom({ turboSwapEndPercent: 50 }).turboSwapEndPercent, 50);
  assert.equal(tuningFrom({ turboSwapEndPercent: 100 }).turboSwapEndPercent, 100);
  assert.equal(tuningFrom({ turboSwapEndPercent: 10 }).turboSwapEndPercent, 0);
  assert.equal(tuningFrom({ turboSwapEndPercent: 101 }).turboSwapEndPercent, 0);
  assert.equal(tuningFrom({ turboSwapEndPercent: Number.NaN }).turboSwapEndPercent, 0);
  assert.equal(tuningFrom({ turboSwapEndPercent: "90" }).turboSwapEndPercent, 0);
  assert.equal(tuningFrom({}).turboSwapEndPercent, 0);
});

test("urgentSlots is a whole number 0 to 5 (0 turns the lane off); anything else falls back to 1", () => {
  assert.equal(tuningFrom({ urgentSlots: 0 }).urgentSlots, 0);
  assert.equal(tuningFrom({ urgentSlots: 5 }).urgentSlots, 5);
  assert.equal(tuningFrom({ urgentSlots: 6 }).urgentSlots, 1);
  assert.equal(tuningFrom({ urgentSlots: 1.5 }).urgentSlots, 1);
  assert.equal(tuningFrom({ urgentSlots: -1 }).urgentSlots, 1);
  assert.equal(tuningFrom({ urgentSlots: "2" }).urgentSlots, 1);
});

test("urgentReportMinutes is a whole number 0 to 1440 (0 never flags); anything else falls back to 120", () => {
  assert.equal(tuningFrom({ urgentReportMinutes: 0 }).urgentReportMinutes, 0);
  assert.equal(tuningFrom({ urgentReportMinutes: 1440 }).urgentReportMinutes, 1440);
  assert.equal(tuningFrom({ urgentReportMinutes: 1441 }).urgentReportMinutes, 120);
  assert.equal(tuningFrom({ urgentReportMinutes: 30.5 }).urgentReportMinutes, 120);
  assert.equal(tuningFrom({ urgentReportMinutes: Number.NaN }).urgentReportMinutes, 120);
});

test("the reserve tunables: 0 turns the 5-hour share off, bad values fall back", () => {
  assert.equal(tuningFrom({ reserveFiveHour: 0 }).reserveFiveHour, 0);
  assert.equal(tuningFrom({ reserveFiveHour: 101 }).reserveFiveHour, 60);
  assert.equal(tuningFrom({ reserveWeek: 2 }).reserveWeek, 1);
  assert.equal(tuningFrom({ reserveWeek: 0 }).reserveWeek, 0);
  assert.equal(tuningFrom({ reserveWeekMargin: -1 }).reserveWeekMargin, 10);
});
