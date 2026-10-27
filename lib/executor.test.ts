// Fake-host tests for the tick executor: a simulated host limit and overall cap, an in-memory plugin store that survives a "reload", and a log.
// They check the order of the tick (end Turbo, then write nothing), status never writing, and the manual-change back-off surviving a reload.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createExecutor, type Deps, type CoachSettings } from "./executor.ts";
import type { LogLine } from "./decision-log.ts";
import type { LimitCfg } from "./io.ts";
import type { MemoryReading } from "./memory.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-10-24T22:00:00Z");
const WINDOW_MIN = 120;

interface World {
  limit: number;
  globalLimit: number;
  writes: number[];
  restores: number;
  now: number;
  load1: number;
  cpus: number;
  memory: MemoryReading;
  logs: LogLine[];
  warns: string[];
  store: Map<string, unknown>;
  settings: CoachSettings;
  /** Busy opencode threads the fake feed reports, or null for an unreadable feed. */
  opencode: number | null;
}

function world(over: Partial<World> = {}): World {
  return {
    limit: 4,
    globalLimit: 8,
    opencode: 0,
    writes: [],
    restores: 0,
    now: T0,
    load1: 0.3, // 0.03 per core: CPU idle, so the scheduler's rule steps up
    cpus: 10,
    memory: { swapUsedPct: 20, freePct: 60, pageoutsPerSec: 0 },
    logs: [],
    warns: [],
    store: new Map(),
    settings: { enabled: true, host: "", minLimit: 1, maxLimit: 8, overrideBackoffMinutes: WINDOW_MIN, swapHotPercent: 70, memFreeMinPercent: 15 },
    ...over,
  };
}

function cfg(w: World): LimitCfg {
  return {
    globalLimit: w.globalLimit,
    hostOverrides: [{ hostId: "h1", limit: w.limit }],
    hosts: [{ id: "h1", name: "macmini", status: "connected", effectiveLimit: w.limit }],
  };
}

/** The deps a Coach process would have. Passing the same `w` (and so the same store) to a new executor is a reload. */
function deps(w: World): Deps {
  return {
    settings: async () => w.settings,
    limits: {
      get: async () => cfg(w),
      set: async (_c, _hostId, limit) => {
        w.writes.push(limit);
        w.limit = limit;
        if (limit > w.globalLimit) w.globalLimit = limit; // the host raises the cap when a host limit is above it
        return cfg(w);
      },
      restore: async (globalLimit) => {
        w.restores++;
        if (globalLimit !== null) w.globalLimit = globalLimit;
        w.limit = Math.min(w.limit, w.globalLimit); // the host limit cannot stay above the restored cap
        return cfg(w);
      },
    },
    usage: async () => null, // quota unknown: the CPU rule and the memory rule are what is tested here
    opencodeRunning: async () => w.opencode,
    memory: async () => w.memory,
    load: () => ({ load1: w.load1, cpus: w.cpus }),
    now: () => w.now,
    store: {
      get: async (k) => (w.store.has(k) ? JSON.parse(JSON.stringify(w.store.get(k))) : undefined),
      set: async (k, v) => { w.store.set(k, JSON.parse(JSON.stringify(v))); },
      delete: async (k) => { w.store.delete(k); },
    },
    appendLog: (line) => { w.logs.push(line); },
    warn: (m) => { w.warns.push(m); },
  };
}

test("status never writes, persists, or logs, even when the rule would raise the limit", async () => {
  const w = world({ limit: 4 });
  w.store.set("override", { lastSet: 4, pausedUntil: 0 }); // the gate is open
  const before = JSON.stringify([...w.store.entries()]);
  const e = await createExecutor(deps(w));
  const t = await e.tick(false);
  assert.equal(t.applied, false);
  assert.equal(t.next, 5, "shows the rule's choice");
  assert.deepEqual(w.writes, []);
  assert.equal(JSON.stringify([...w.store.entries()]), before, "nothing stored");
  assert.deepEqual(w.logs, []);
});

test("first tick records the baseline and does not write; the next applied tick writes", async () => {
  const w = world({ limit: 4 });
  const e = await createExecutor(deps(w));
  const first = await e.tick(true);
  assert.equal(first.applied, false);
  assert.deepEqual(w.writes, []);
  assert.deepEqual(w.store.get("override"), { lastSet: 4, pausedUntil: 0 }, "baseline is persisted");
  w.now += 5 * MIN;
  await e.tick(true);
  assert.deepEqual(w.writes, [5]);
});

test("manual change, then reload: the back-off holds across the reload and ends on time", async () => {
  const w = world({ limit: 4 });
  const first = await createExecutor(deps(w));
  await first.tick(true); // baseline 4, persisted
  w.now += 5 * MIN;
  await first.tick(true); // writes 5 (the rule): lastSet 5, persisted
  assert.deepEqual(w.writes, [5]);

  // the operator sets the limit by hand to 2, while Coach is still running.
  w.limit = 2;
  w.now += 5 * MIN;
  await first.tick(true);
  assert.deepEqual(w.writes, [5], "the manual change is not overwritten");
  const backedOff = w.store.get("override") as { lastSet: number; pausedUntil: number };
  assert.equal(backedOff.lastSet, 2);
  assert.equal(backedOff.pausedUntil, w.now + WINDOW_MIN * MIN, "the back-off window is stored");

  // Reload: a new executor on the same store and the same host.
  const reloaded = await createExecutor(deps(w));
  assert.deepEqual(reloaded.state().override, backedOff, "the stored back-off is read back");
  w.now += 5 * MIN;
  const during = await reloaded.tick(true);
  assert.deepEqual(w.writes, [5], "no write while the back-off runs after the reload");
  assert.match(during.why, /backing off/);
  assert.equal(w.limit, 2);

  // After the window the reloaded executor decides again, from the manual value.
  w.now = backedOff.pausedUntil + MIN;
  await reloaded.tick(true);
  assert.deepEqual(w.writes, [5, 3], "resumes from the manual value once the window ends");
});

test("control: a reload that loses the stored back-off takes the manual value as the baseline and writes over it", async () => {
  // This is the failure the stored back-off fixes. The test pins it so that a regression to in-memory state is caught.
  const w = world({ limit: 4 });
  const first = await createExecutor(deps(w));
  await first.tick(true);
  w.now += 5 * MIN;
  await first.tick(true); // writes 5
  w.limit = 2; // manual
  w.store.clear(); // as if the storage were gone
  const reloaded = await createExecutor(deps(w));
  w.now += 5 * MIN;
  await reloaded.tick(true);
  assert.deepEqual(w.writes, [5], "the manual value becomes the baseline, no write");
  w.now += 5 * MIN;
  await reloaded.tick(true);
  assert.deepEqual(w.writes, [5, 3], "and the next tick writes over it");
});

test("end-then-write: the tick that ends Turbo restores the cap and writes nothing; the next tick decides fresh", async () => {
  const w = world({ limit: 4, globalLimit: 4 });
  const e = await createExecutor(deps(w));
  await e.tick(true); // baseline 4
  await e.startTurboFrom("cli", 6, 2 * 60 * MIN);
  assert.deepEqual(w.writes, [6], "Turbo writes at once");
  assert.equal(w.globalLimit, 6, "the cap is raised for Turbo");

  // The time box runs out. The tick that ends Turbo must not write over the restore.
  w.now = e.state().turbo!.until + MIN;
  const writesBefore = w.writes.length;
  const ended = await e.tick(true);
  assert.equal(ended.applied, false);
  assert.equal(w.writes.length, writesBefore, "no write in the tick that ends Turbo");
  assert.equal(w.restores, 1, "the cap is restored in that tick");
  assert.equal(w.globalLimit, 4);
  assert.equal(w.limit, 4, "the host limit is brought back under the restored cap");
  assert.equal(e.state().turbo, null, "Turbo is cleared from storage");
  assert.equal(w.store.has("turbo"), false);
  assert.ok(w.logs.some((l) => "kind" in l && l.kind === "turbo" && l.action === "end" && /overall cap restored to 4/.test(l.reason ?? "")));

  // The next tick reads fresh values and decides: idle CPU steps up from the restored 4.
  w.now += 5 * MIN;
  await e.tick(true);
  assert.deepEqual(w.writes.slice(writesBefore), [5]);
});

test("a manual change ends Turbo and is backed off in the same tick, with no write over it", async () => {
  const w = world({ limit: 4, globalLimit: 4 });
  const e = await createExecutor(deps(w));
  await e.tick(true);
  await e.startTurboFrom("cli", 6, 2 * 60 * MIN);
  w.limit = 3; // the operator changes the limit by hand during Turbo
  w.now += 5 * MIN;
  const writesBefore = w.writes.length;
  await e.tick(true);
  assert.equal(w.writes.length, writesBefore, "Turbo does not write over the manual change");
  assert.equal(e.state().turbo, null);
  assert.equal(e.state().override.lastSet, 3, "the manual value is the baseline");
  assert.ok(e.state().override.pausedUntil > w.now, "the back-off starts in this tick");
  const again = await e.tick(true);
  assert.equal(w.writes.length, writesBefore, "the next tick still backs off");
  assert.match(again.why, /backing off/);
});

test("a stored back-off that is not valid is no state: the first tick records a baseline", async () => {
  const w = world({ limit: 4 });
  w.store.set("override", { lastSet: 0, pausedUntil: 0 }); // damaged
  const e = await createExecutor(deps(w));
  await e.tick(true);
  assert.deepEqual(w.writes, []);
  assert.deepEqual(w.store.get("override"), { lastSet: 4, pausedUntil: 0 });
});

test("swap high with free memory high and no paging is not pressure: the host can still go up", async () => {
  const w = world({ limit: 4, memory: { swapUsedPct: 95, freePct: 76, pageoutsPerSec: 0 } });
  w.store.set("override", { lastSet: 4, pausedUntil: 0 });
  const e = await createExecutor(deps(w));
  await e.tick(true);
  assert.deepEqual(w.writes, [5]);
});

test("low free memory steps the limit down even when CPU is idle, and never raises it", async () => {
  const w = world({ limit: 4, memory: { swapUsedPct: 40, freePct: 9, pageoutsPerSec: 0 } });
  w.store.set("override", { lastSet: 4, pausedUntil: 0 });
  const e = await createExecutor(deps(w));
  const t = await e.tick(true);
  assert.deepEqual(w.writes, [3]);
  assert.match(t.why, /memory pressure/);
});

test("a memory read that throws is not a signal: scaling is as before", async () => {
  const w = world({ limit: 4 });
  w.store.set("override", { lastSet: 4, pausedUntil: 0 });
  const d = deps(w);
  const e = await createExecutor({ ...d, memory: async () => { throw new Error("no vm_stat"); } });
  await e.tick(true);
  assert.deepEqual(w.writes, [5]);
});

// --- opencode headroom. The host limit is Claude's paced limit plus one slot per running opencode thread, up to opencodeSlots.

const idleTick = (w: World) => { w.now += 5 * MIN; };
test("opencode: none running, the decision is the same as before (no headroom, no opencode note)", async () => {
  const w = world({ limit: 4, opencode: 0 });
  w.store.set("override", { lastSet: 4, pausedUntil: 0 });
  const e = await createExecutor(deps(w));
  await e.tick(true);
  assert.deepEqual(w.writes, [5]);
  assert.equal(e.state().headroom, 0);
  assert.doesNotMatch((w.logs[0] as { why: string }).why, /opencode/);
});
test("opencode: one running with one slot: Claude's decision is unchanged and the host gets one slot of headroom", async () => {
  const w = world({ limit: 4, opencode: 1 });
  w.store.set("override", { lastSet: 4, pausedUntil: 0 });
  const e = await createExecutor(deps(w));
  const t = await e.tick(true);
  assert.deepEqual(w.writes, [6], "Claude 5 + opencode 1");
  assert.equal(e.state().headroom, 1);
  assert.equal(t.headroom, 1);
  assert.match((w.logs[0] as { why: string }).why, /Claude 5 \+ opencode 1/);
  // Next tick: Claude's paced limit is the host limit minus the headroom (5), so the decision steps Claude to 6 and the host to 7.
  idleTick(w);
  await e.tick(true);
  assert.deepEqual(w.writes, [6, 7]);
});
test("opencode: two running with one slot: headroom capped at one, and the warning is in the reason", async () => {
  const w = world({ limit: 4, opencode: 2 });
  w.store.set("override", { lastSet: 4, pausedUntil: 0 });
  const e = await createExecutor(deps(w));
  await e.tick(true);
  assert.deepEqual(w.writes, [6]);
  assert.equal(e.state().headroom, 1);
  assert.match((w.logs[0] as { why: string }).why, /2 opencode runs, more than opencodeSlots 1/);
});
test("opencode: two running with two slots: both get headroom, no warning", async () => {
  const w = world({ limit: 4, opencode: 2, settings: { ...world().settings, opencodeSlots: 2 } });
  w.store.set("override", { lastSet: 4, pausedUntil: 0 });
  const e = await createExecutor(deps(w));
  await e.tick(true);
  assert.deepEqual(w.writes, [7]);
  assert.doesNotMatch((w.logs[0] as { why: string }).why, /more than opencodeSlots/);
});
test("opencode: feature off (opencodeSlots 0) writes as before, whatever is running", async () => {
  const w = world({ limit: 4, opencode: 3, settings: { ...world().settings, opencodeSlots: 0 } });
  w.store.set("override", { lastSet: 4, pausedUntil: 0 });
  const e = await createExecutor(deps(w));
  await e.tick(true);
  assert.deepEqual(w.writes, [5]);
  assert.equal(e.state().headroom, 0);
});
test("opencode counts against the limit: no headroom is added", async () => {
  const w = world({ limit: 4, opencode: 1, settings: { ...world().settings, opencodeCountsAgainstLimit: true } });
  w.store.set("override", { lastSet: 4, pausedUntil: 0 });
  const e = await createExecutor(deps(w));
  await e.tick(true);
  assert.deepEqual(w.writes, [5]);
});
test("opencode: a bad opencodeSlots setting falls back to its default of one slot", async () => {
  const w = world({ limit: 4, opencode: 1, settings: { ...world().settings, opencodeSlots: 99 } });
  w.store.set("override", { lastSet: 4, pausedUntil: 0 });
  const e = await createExecutor(deps(w));
  await e.tick(true);
  assert.deepEqual(w.writes, [6], "99 is out of range, so one slot");
});
test("opencode: when the runs finish, the headroom is dropped without moving the host limit", async () => {
  const w = world({ limit: 4, opencode: 1 });
  w.store.set("override", { lastSet: 4, pausedUntil: 0 });
  const e = await createExecutor(deps(w));
  await e.tick(true); // host 6 = Claude 5 + 1
  w.opencode = 0;
  idleTick(w);
  await e.tick(true); // Claude 5 -> 6 with no headroom: host stays 6
  assert.deepEqual(w.writes, [6], "no write: the host already sits at the target");
  assert.equal(e.state().headroom, 0, "the headroom is now zero");
});
test("opencode: an unknown count keeps the headroom in effect", async () => {
  const w = world({ limit: 4, opencode: 1 });
  w.store.set("override", { lastSet: 4, pausedUntil: 0 });
  const e = await createExecutor(deps(w));
  await e.tick(true); // host 6
  w.opencode = null;
  idleTick(w);
  await e.tick(true);
  assert.equal(e.state().headroom, 1, "kept");
  assert.deepEqual(w.writes, [6, 7], "Claude 5 -> 6, plus the kept slot");
});
test("opencode: Turbo writes its exact limit with no headroom", async () => {
  const w = world({ limit: 4, globalLimit: 4, opencode: 1 });
  w.store.set("override", { lastSet: 4, pausedUntil: 0 });
  const e = await createExecutor(deps(w));
  await e.startTurboFrom("cli", 6, 2 * 60 * MIN);
  assert.equal(e.state().headroom, 0);
  idleTick(w);
  await e.tick(true);
  assert.deepEqual(w.writes, [6], "held at the Turbo limit, no slot added");
});
test("opencode: a manual change drops the headroom and backs off", async () => {
  const w = world({ limit: 4, opencode: 1 });
  w.store.set("override", { lastSet: 4, pausedUntil: 0 });
  const e = await createExecutor(deps(w));
  await e.tick(true); // host 6, headroom 1
  w.limit = 3; // the operator sets the host limit by hand
  idleTick(w);
  await e.tick(true);
  assert.equal(e.state().headroom, 0);
  assert.deepEqual(w.writes, [6], "no write over the manual value");
});
test("opencode: the headroom survives a reload, and the next write keeps Claude's pacing", async () => {
  const w = world({ limit: 4, opencode: 1 });
  w.store.set("override", { lastSet: 4, pausedUntil: 0 });
  const first = await createExecutor(deps(w));
  await first.tick(true); // host 6, headroom 1
  const reloaded = await createExecutor(deps(w));
  assert.equal(reloaded.state().headroom, 1, "read back from the store");
  idleTick(w);
  await reloaded.tick(true);
  assert.deepEqual(w.writes, [6, 7], "Claude 5 -> 6 plus one slot");
});
