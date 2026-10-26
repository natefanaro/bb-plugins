import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendDecision, formatDecision, isTick, readDecisions, type DecisionRecord } from "./decision-log.ts";

function tmpFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pacer-log-")), "decisions.jsonl");
}
function rec(i: number, over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    t: `2026-10-24T13:${String(i).padStart(2, "0")}:00.000Z`, host: "macmini", cur: 6, next: 5, applied: true, why: `step ${i}`,
    load: 2.1, fiveHourUsed: 20, fiveHourElapsed: 30, weekUsed: 60, override: { lastSet: 5, pausedUntil: 0 }, ...over,
  };
}

test("appends one JSON line per record with owner-only permissions", () => {
  const f = tmpFile();
  appendDecision(f, rec(1));
  appendDecision(f, rec(2));
  const lines = fs.readFileSync(f, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).why, "step 2");
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
});

test("readDecisions returns the last N, oldest first", () => {
  const f = tmpFile();
  for (let i = 1; i <= 5; i++) appendDecision(f, rec(i));
  assert.deepEqual(readDecisions(f, 2).filter(isTick).map((r) => r.why), ["step 4", "step 5"]);
  assert.equal(readDecisions(f, 50).length, 5);
});

test("missing log reads as empty", () => {
  assert.deepEqual(readDecisions(path.join(os.tmpdir(), "no-such-pacer-log", "x.jsonl"), 10), []);
});

test("rotates at the cap: the old file moves to .1 and reads still span both", () => {
  const f = tmpFile();
  const cap = 400;
  for (let i = 1; i <= 8; i++) appendDecision(f, rec(i), cap);
  assert.ok(fs.existsSync(`${f}.1`), "rotated file exists");
  assert.ok(fs.statSync(f).size < cap + 300, "current file restarted after rotation");
  const whys = readDecisions(f, 100).filter(isTick).map((r) => Number(r.why.split(" ")[1]));
  assert.equal(whys.at(-1), 8, "newest record is last");
  assert.ok(whys.every((n, i) => i === 0 || n === whys[i - 1] + 1), "records stay in order with no gaps");
});

test("rotation keeps one generation: the second rotation replaces .1 and holds whole records", () => {
  const f = tmpFile();
  const cap = 200;
  for (let i = 1; i <= 30; i++) appendDecision(f, rec(i), cap);
  for (const line of fs.readFileSync(`${f}.1`, "utf8").trim().split("\n")) assert.doesNotThrow(() => JSON.parse(line));
  assert.equal((readDecisions(f, 1).filter(isTick).at(-1)?.why), "step 30");
  assert.ok(!fs.existsSync(`${f}.2`));
});

test("a torn or malformed line is skipped, not fatal", () => {
  const f = tmpFile();
  appendDecision(f, rec(1));
  fs.appendFileSync(f, "{not json\n");
  appendDecision(f, rec(2));
  assert.deepEqual(readDecisions(f, 10).filter(isTick).map((r) => r.why), ["step 1", "step 2"]);
});

test("formatDecision shows the change, applied state and reason, including a manual-change back-off", () => {
  assert.equal(formatDecision(rec(3)), "2026-10-24T13:03:00.000Z  macmini: 6 -> 5 (applied)  step 3");
  assert.match(formatDecision(rec(4, { applied: false, next: 6, why: "manual limit change (5 -> 1): backing off 120 min" })), /6 \(held\)  manual limit change \(5 -> 1\)/);
  assert.match(formatDecision(rec(5, { applied: false, why: "first tick: recorded 6 as the baseline" })), /6 -> 5 \(not applied\)/);
});

test("turbo start and end are written to the same log with who started and ended it", () => {
  const f = tmpFile();
  appendDecision(f, { t: "2026-10-24T19:00:00.000Z", kind: "turbo", action: "start", by: "panel", limit: 6, until: "2026-10-24T21:00:00.000Z" });
  appendDecision(f, rec(1));
  appendDecision(f, { t: "2026-10-24T20:10:00.000Z", kind: "turbo", action: "end", by: "cli", reason: "turned off" });
  const lines = readDecisions(f, 10);
  assert.equal(lines.length, 3);
  assert.equal(formatDecision(lines[0]), "2026-10-24T19:00:00.000Z  turbo started by panel: limit 6 until 2026-10-24T21:00:00.000Z");
  assert.equal(formatDecision(lines[2]), "2026-10-24T20:10:00.000Z  turbo ended by cli: turned off");
});

test("a tick made under Turbo is marked; ticks without the field read as before", () => {
  const plain = formatDecision(rec(2));
  assert.doesNotMatch(plain, /\[turbo\]/);
  assert.match(formatDecision(rec(2, { turbo: true, why: "turbo" })), /\[turbo\]  turbo$/);
});
