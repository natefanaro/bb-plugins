import { test } from "node:test";
import assert from "node:assert/strict";
import { freeMemoryLow, memoryHot, memorySentence, parseFreePct, parsePageoutsPerSec, parseSwapUsage, swapThrashing, type MemoryReading } from "./memory.ts";
import { decide, type Signals } from "./policy.ts";

const T = { swapHotPercent: 70, memFreeMinPercent: 15 };
const healthy: MemoryReading = { swapUsedPct: 95, freePct: 76, pageoutsPerSec: 0 };

test("parses the observed vm.swapusage shape in M", () => {
  assert.equal(parseSwapUsage("total = 23552.00M  used = 21849.56M  free = 1702.44M  (encrypted)\n"), 93);
});
test("parses swap sizes in G and K", () => {
  assert.equal(parseSwapUsage("total = 4.00G  used = 1.00G  free = 3.00G  (encrypted)"), 25);
  assert.equal(parseSwapUsage("total = 1024.00K  used = 512.00K  free = 512.00K"), 50);
});
test("swap with no total or odd output is unknown", () => {
  assert.equal(parseSwapUsage("total = 0.00M  used = 0.00M  free = 0.00M"), null);
  assert.equal(parseSwapUsage(""), null);
});
test("parses the free memory percentage from memory_pressure", () => {
  assert.equal(parseFreePct("The system has 17179869184 (1048576 pages)\nSystem-wide memory free percentage: 74%\n"), 74);
  assert.equal(parseFreePct("no such line"), null);
});

const VM_STAT = [
  "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
  "    free   active   specul inactive throttle    wired  prgable   faults     copy    0fill reactive   purged file-backed anonymous cmprssed cmprssor  dcomprs   comprs  pageins  pageout  swapins swapouts",
  "    5843   355377     2159   355091        0   165662      940 5688786K  251259K 1708060K 1292076K 68101100      200449    512178   203352   118187 1569202K 1771038K  564807K  1242359  110134K  137519K ",
  "    7113   357407     2885   353716        0   162699     1100    57894     6377     9737        3        6      200955    513053   203754   118499      589      539     5405        0      279        0 ",
].join("\n");
test("page-outs per second come from the second (interval) row", () => {
  assert.equal(parsePageoutsPerSec(VM_STAT, 5), 0);
  const busy = VM_STAT.replace("5405        0", "5405     2500");
  assert.equal(parsePageoutsPerSec(busy, 5), 500);
});
test("page-ins are not read as page-outs", () => {
  assert.equal(parsePageoutsPerSec(VM_STAT.replace("5405", "9999"), 5), 0);
});
test("vm_stat without the paging columns is unknown", () => {
  assert.equal(parsePageoutsPerSec("Mach Virtual Memory Statistics:\nPages free: 1.", 5), null);
});

test("free memory below its floor is pressure", () => {
  assert.equal(freeMemoryLow({ swapUsedPct: 0, freePct: 14, pageoutsPerSec: 0 }, T), true);
  assert.equal(freeMemoryLow({ swapUsedPct: 0, freePct: 15, pageoutsPerSec: 0 }, T), false);
  assert.equal(memoryHot({ swapUsedPct: 10, freePct: 9, pageoutsPerSec: 0 }, T), true);
});
test("swap 95% with free 76% and low paging is NOT hot", () => {
  assert.equal(memoryHot(healthy, T), false);
  assert.equal(memoryHot({ swapUsedPct: 95, freePct: 76, pageoutsPerSec: 30 }, T), false);
});
test("high swap with high paging IS hot", () => {
  assert.equal(memoryHot({ swapUsedPct: 95, freePct: 76, pageoutsPerSec: 300 }, T), true);
  assert.equal(swapThrashing({ swapUsedPct: 95, freePct: 76, pageoutsPerSec: 300 }, T), true);
});
test("paging alone, with swap below its threshold, is not hot", () => {
  assert.equal(memoryHot({ swapUsedPct: 40, freePct: 60, pageoutsPerSec: 500 }, T), false);
});
test("swap at its threshold with paging just under the rate is not hot", () => {
  assert.equal(memoryHot({ swapUsedPct: 70, freePct: 60, pageoutsPerSec: 99 }, T), false);
  assert.equal(memoryHot({ swapUsedPct: 70, freePct: 60, pageoutsPerSec: 100 }, T), true);
});
test("unknown readings are not hot", () => {
  assert.equal(memoryHot({ swapUsedPct: null, freePct: null, pageoutsPerSec: null }, T), false);
  assert.equal(memoryHot({ swapUsedPct: 95, freePct: 76, pageoutsPerSec: null }, T), false, "swap without a paging reading is not pressure");
});
test("the sentence names only the known parts", () => {
  assert.equal(memorySentence({ swapUsedPct: 95, freePct: 14, pageoutsPerSec: 120.4 }), "free memory 14%, swap 95%, paging out 120/s");
  assert.equal(memorySentence({ swapUsedPct: null, freePct: 5, pageoutsPerSec: null }), "free memory 5%");
  assert.equal(memorySentence({ swapUsedPct: null, freePct: null, pageoutsPerSec: null }), "");
});

const base: Signals = { cur: 4, min: 1, max: 8, loadRatio: 0.7, fiveHourUsed: 30, fiveHourElapsed: 40, weekUsed: 30, weekElapsed: 40 };
const low = { reading: { swapUsedPct: 40, freePct: 9, pageoutsPerSec: 0 }, thresholds: T };
const thrash = { reading: { swapUsedPct: 95, freePct: 40, pageoutsPerSec: 300 }, thresholds: T };

test("low free memory steps down even when CPU is idle", () => {
  const d = decide({ ...base, loadRatio: 0.1, memory: low });
  assert.equal(d.next, 3);
  assert.match(d.why, /memory pressure \(free memory 9%, swap 40%, paging out 0\/s\)/);
});
test("swap thrashing steps down and blocks raising the limit", () => {
  assert.equal(decide({ ...base, cur: 2, loadRatio: 0.1, memory: thrash }).next, 1);
});
test("the healthy host (swap 95%, free 76%, low paging) does not hold the limit down", () => {
  assert.equal(decide({ ...base, loadRatio: 0.1, memory: { reading: healthy, thresholds: T } }).next, 5);
});
test("quota near limit still drops to min before memory", () => {
  assert.equal(decide({ ...base, weekUsed: 91, memory: low }).next, 1);
});
test("no memory signal: scaling is as before", () => {
  assert.equal(decide({ ...base, loadRatio: 0.1 }).next, 5);
});
