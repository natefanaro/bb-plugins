// Fake-host tests for the tick executor: a simulated host limit and overall cap, an in-memory plugin store that survives a "reload", and a log.
// They check the order of the tick (end Turbo, then write nothing), status never writing, and the manual-change back-off surviving a reload.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createExecutor, type Deps, type CoachSettings } from "./executor.ts";
import type { LogLine } from "./decision-log.ts";
import type { LimitCfg } from "./io.ts";
import type { MemoryReading } from "./memory.ts";
import type { UrgentCount } from "./urgent.ts";

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
  /** Urgent threads the fake feed reports, or null for an unreadable one. */
  urgent: UrgentCount | null;
  /** The host's name, for tests that run several hosts. */
  name: string;
}

function world(over: Partial<World> = {}): World {
  return {
    limit: 4,
    globalLimit: 8,
    opencode: 0,
    urgent: { running: 0, waiting: 0 },
    name: "macmini",
    writes: [],
    restores: 0,
    now: T0,
    load1: 0.3, // 0.03 per core: CPU idle, so the scheduler's rule steps up
    cpus: 10,
    memory: { swapUsedPct: 20, freePct: 60, pageoutsPerSec: 0 },
    logs: [],
    warns: [],
    store: new Map(),
    settings: { enabled: true, host: "", minLimit: 1, maxLimit: 8, overrideBackoffMinutes: WINDOW_MIN, swapHotPercent: 70, memFreeMinPercent: 15, reserveFiveHour: 0, reserveWeek: 0 },
    ...over,
  };
}

function cfg(w: World): LimitCfg {
  return {
    globalLimit: w.globalLimit,
    hostOverrides: [{ hostId: "h1", limit: w.limit }],
    hosts: [{ id: "h1", name: w.name, status: "connected", effectiveLimit: w.limit }],
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
    urgent: async () => w.urgent,
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
  w.now = e.state().turbo!.until! + MIN;
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
test("opencode: an overall cap that clamps the write stores only the headroom that landed", async () => {
  // Claude paces 4 -> 5 and asks the host for 5 + 1 = 6, but the overall cap is 5: the host lands on 5.
  const w = world({ limit: 4, globalLimit: 5, opencode: 1 });
  w.store.set("override", { lastSet: 4, pausedUntil: 0 });
  const d = deps(w);
  d.limits.set = async (_c, _hostId, limit) => {
    w.writes.push(limit);
    w.limit = Math.min(limit, w.globalLimit); // the cap clamps the write
    return cfg(w);
  };
  const e = await createExecutor(d);
  const t = await e.tick(true);
  assert.deepEqual(w.writes, [6]);
  assert.equal(w.limit, 5, "the host landed on 5");
  assert.equal(e.state().headroom, 0, "no headroom landed above Claude's 5");
  assert.equal(t.headroom, 0);
  assert.doesNotMatch((w.logs[0] as { why: string }).why, /opencode/, "the reason does not claim a slot that did not land");
  // Claude's limit is not read low: with no headroom stored, the host's 5 is Claude's 5 on the next tick.
  idleTick(w);
  await e.tick(true);
  assert.equal(e.state().headroom, 0);
});

// --- Turbo durations, memory pressure and the start check.
const HOT_MEM = { swapUsedPct: 80, freePct: 10, pageoutsPerSec: 0 };
const CALM_HIGH_SWAP = { swapUsedPct: 95, freePct: 79, pageoutsPerSec: 0 };
const weekUsage = (usedPercent: number) => ({ machines: [{ providers: [{ providerId: "claude-code", usage: { windows: [{ label: "Weekly limit", usedPercent, resetsAt: new Date(Date.parse("2026-10-20T00:00:00Z") + 5 * 24 * 3600_000).toISOString() }] } }] }] });

test("turbo: the default time box is unchanged (2 h) when no duration is given", async () => {
  const w = world({ limit: 4, globalLimit: 8 });
  const e = await createExecutor(deps(w));
  await e.tick(true);
  await e.startTurboFrom("panel", 6, undefined);
  assert.equal(e.state().turbo!.until, w.now + 2 * 60 * MIN);
  assert.equal(e.state().turbo!.untilOff, false);
});
test("turbo until off: stored with a numeric far-future time box, and held past 24 h", async () => {
  const w = world({ limit: 4, globalLimit: 8 });
  const e = await createExecutor(deps(w));
  await e.tick(true);
  await e.startTurboFrom("panel", 6, null);
  const t = e.state().turbo!;
  assert.equal(t.untilOff, true);
  assert.equal(typeof t.until, "number");
  assert.equal(typeof (w.store.get("turbo") as { until: unknown }).until, "number", "a rollback can still read the stored record");
  w.now += 24 * 60 * MIN;
  const tick = await e.tick(true);
  assert.notEqual(e.state().turbo, null, "still on after 24 h");
  assert.equal(tick.applied, false);
  assert.ok(w.logs.some((l) => "kind" in l && l.kind === "turbo" && l.action === "start" && l.until === undefined));
});
test("turbo: memory pressure (free memory under 15%) ends it in that tick, with no write over the restore", async () => {
  const w = world({ limit: 4, globalLimit: 4 });
  const e = await createExecutor(deps(w));
  await e.tick(true);
  await e.startTurboFrom("panel", 6, null);
  const writesBefore = w.writes.length;
  w.memory = HOT_MEM;
  w.now += 5 * MIN;
  const t = await e.tick(true);
  assert.equal(e.state().turbo, null, "Turbo ended");
  assert.equal(w.writes.length, writesBefore, "no write in the tick that ends Turbo");
  assert.equal(w.globalLimit, 4, "the cap is restored");
  assert.ok(w.logs.some((l) => "kind" in l && l.kind === "turbo" && l.action === "end" && /memory pressure \(free memory 10%/.test(l.reason ?? "")));
  assert.equal(t.applied, false);
});
test("turbo: a calm host sitting at 95% swap with 79% free does not end it (swap alone is not pressure)", async () => {
  const w = world({ limit: 4, globalLimit: 8 });
  const e = await createExecutor(deps(w));
  await e.tick(true);
  await e.startTurboFrom("panel", 6, null);
  w.memory = CALM_HIGH_SWAP;
  w.now += 5 * MIN;
  await e.tick(true);
  assert.notEqual(e.state().turbo, null);
});
test("turbo: the optional raw swap line (turboSwapEndPercent 95) ends it on a calm host", async () => {
  const w = world({ limit: 4, globalLimit: 8, settings: { ...world().settings, turboSwapEndPercent: 95 } });
  const e = await createExecutor(deps(w));
  await e.tick(true);
  await e.startTurboFrom("panel", 6, null);
  w.memory = CALM_HIGH_SWAP;
  w.now += 5 * MIN;
  await e.tick(true);
  assert.equal(e.state().turbo, null);
  assert.ok(w.logs.some((l) => "kind" in l && l.kind === "turbo" && l.action === "end" && /Turbo swap end line/.test(l.reason ?? "")));
});
test("turbo: a bad turboSwapEndPercent falls back to off", async () => {
  const w = world({ limit: 4, globalLimit: 8, settings: { ...world().settings, turboSwapEndPercent: 10 } });
  const e = await createExecutor(deps(w));
  await e.tick(true);
  await e.startTurboFrom("panel", 6, null);
  w.memory = CALM_HIGH_SWAP;
  w.now += 5 * MIN;
  await e.tick(true);
  assert.notEqual(e.state().turbo, null);
});
test("turbo start is refused under memory pressure: nothing is written or stored", async () => {
  const w = world({ limit: 4, globalLimit: 8, memory: HOT_MEM });
  const e = await createExecutor(deps(w));
  await e.tick(true);
  const writesBefore = w.writes.length;
  await assert.rejects(e.startTurboFrom("panel", 6, 30 * MIN), /^Error: Turbo not started: memory pressure \(free memory 10%/);
  assert.equal(w.writes.length, writesBefore);
  assert.equal(e.state().turbo, null);
  assert.equal(w.store.has("turbo"), false);
  assert.equal(w.globalLimit, 8, "the cap is not raised");
});
test("turbo start is refused when the quota is near its cap", async () => {
  const w = world({ limit: 4, globalLimit: 8 });
  const d = deps(w);
  d.usage = async () => weekUsage(95);
  const e = await createExecutor(d);
  await e.tick(true);
  await assert.rejects(e.startTurboFrom("cli", 6, undefined), /^Error: Turbo not started: quota near limit/);
  assert.equal(e.state().turbo, null);
});
test("turbo start is not blocked by unreadable quota or memory", async () => {
  const w = world({ limit: 4, globalLimit: 8 });
  const d = deps(w);
  d.usage = async () => { throw new Error("usage down"); };
  d.memory = async () => { throw new Error("memory down"); };
  const e = await createExecutor(d);
  await e.tick(true);
  await e.startTurboFrom("cli", 6, undefined);
  assert.notEqual(e.state().turbo, null);
});
test("turbo start is not blocked by high swap alone", async () => {
  const w = world({ limit: 4, globalLimit: 8, memory: CALM_HIGH_SWAP });
  const e = await createExecutor(deps(w));
  await e.tick(true);
  await e.startTurboFrom("panel", 6, 30 * MIN);
  assert.notEqual(e.state().turbo, null);
});

// --- The urgent lane: threads whose task is urgent get slots above Claude's paced limit.
const openGate = (w: World) => w.store.set("override", { lastSet: 4, pausedUntil: 0 });

test("urgent: none waiting or running, the decision, the write and the reason are as before", async () => {
  const w = world({ limit: 4 });
  openGate(w);
  const e = await createExecutor(deps(w));
  await e.tick(true);
  assert.deepEqual(w.writes, [5]);
  assert.doesNotMatch((w.logs[0] as { why: string }).why, /urgent/);
  assert.equal(e.state().urgentHeadroom, 0);
});
test("urgent: one waiting gets a slot above Claude's pace; Claude's decision is unchanged", async () => {
  const w = world({ limit: 4, urgent: { running: 0, waiting: 1 } });
  openGate(w);
  const e = await createExecutor(deps(w));
  const t = await e.tick(true);
  assert.deepEqual(w.writes, [6], "Claude 5 + urgent 1");
  assert.equal(e.state().headroom, 1);
  assert.equal(e.state().urgentHeadroom, 1);
  assert.equal(t.urgentHeadroom, 1);
  assert.match((w.logs[0] as { why: string }).why, /Claude 5 \+ urgent 1/);
  assert.doesNotMatch((w.logs[0] as { why: string }).why, /opencode/);
  assert.equal(w.store.get("headroom"), 1, "the total stays under the old key");
  assert.equal(w.store.get("urgentHeadroom"), 1);
  // Next tick: Claude's paced limit is the host limit minus the lane (5), so it steps to 6 and the host to 7.
  idleTick(w);
  await e.tick(true);
  assert.deepEqual(w.writes, [6, 7]);
});
test("urgent: a running urgent thread keeps its slot", async () => {
  const w = world({ limit: 4, urgent: { running: 1, waiting: 0 } });
  openGate(w);
  const e = await createExecutor(deps(w));
  await e.tick(true);
  assert.deepEqual(w.writes, [6]);
});
test("urgent: two waiting with one slot is capped at one", async () => {
  const w = world({ limit: 4, urgent: { running: 0, waiting: 2 } });
  openGate(w);
  const e = await createExecutor(deps(w));
  await e.tick(true);
  assert.deepEqual(w.writes, [6]);
});
test("urgent: both lanes add up, and the reason names both", async () => {
  const w = world({ limit: 4, opencode: 1, urgent: { running: 0, waiting: 1 } });
  openGate(w);
  const e = await createExecutor(deps(w));
  await e.tick(true);
  assert.deepEqual(w.writes, [7], "Claude 5 + opencode 1 + urgent 1");
  assert.equal(e.state().headroom, 2);
  assert.equal(e.state().urgentHeadroom, 1);
  assert.match((w.logs[0] as { why: string }).why, /Claude 5 \+ opencode 1 \+ urgent 1/);
});
test("urgent: urgentSlots 0 turns the lane off and the feed is not read", async () => {
  const w = world({ limit: 4, urgent: { running: 0, waiting: 3 }, settings: { ...world().settings, urgentSlots: 0 } });
  openGate(w);
  let reads = 0;
  const d = deps(w);
  d.urgent = async () => { reads++; return w.urgent; };
  const e = await createExecutor(d);
  await e.tick(true);
  assert.deepEqual(w.writes, [5]);
  assert.equal(reads, 0);
});
test("urgent: a bad urgentSlots falls back to one slot", async () => {
  const w = world({ limit: 4, urgent: { running: 0, waiting: 1 }, settings: { ...world().settings, urgentSlots: 99 } });
  openGate(w);
  const e = await createExecutor(deps(w));
  await e.tick(true);
  assert.deepEqual(w.writes, [6]);
});
test("urgent: when the urgent work is gone the slot is dropped without moving the host limit", async () => {
  const w = world({ limit: 4, urgent: { running: 0, waiting: 1 } });
  openGate(w);
  const e = await createExecutor(deps(w));
  await e.tick(true); // host 6, lane 1
  w.urgent = { running: 0, waiting: 0 };
  w.load1 = 4; // CPU in the middle band: Claude holds at 5
  w.now += 5 * MIN;
  await e.tick(true);
  assert.deepEqual(w.writes, [6], "no write: the host stays at 6");
  assert.equal(e.state().urgentHeadroom, 0);
  assert.equal(e.state().headroom, 0, "the split changed: 6 is now Claude's");
});
test("urgent: an unreadable count keeps the lane as it was", async () => {
  const w = world({ limit: 4, urgent: { running: 0, waiting: 1 } });
  openGate(w);
  const e = await createExecutor(deps(w));
  await e.tick(true);
  w.urgent = null;
  w.load1 = 4;
  w.now += 5 * MIN;
  await e.tick(true);
  assert.equal(e.state().urgentHeadroom, 1);
});
test("urgent: a count that throws keeps the lane as it was", async () => {
  const w = world({ limit: 4, urgent: { running: 0, waiting: 1 } });
  openGate(w);
  const d = deps(w);
  const e = await createExecutor(d);
  await e.tick(true);
  d.urgent = async () => { throw new Error("tasks down"); };
  w.load1 = 4;
  w.now += 5 * MIN;
  await e.tick(true);
  assert.equal(e.state().urgentHeadroom, 1);
});
test("urgent: Turbo writes its exact limit with no lane; a manual change drops the lane", async () => {
  const w = world({ limit: 4, globalLimit: 8, urgent: { running: 0, waiting: 1 } });
  openGate(w);
  const e = await createExecutor(deps(w));
  await e.tick(true); // host 6, lane 1
  await e.startTurboFrom("cli", 7, undefined);
  assert.equal(e.state().headroom, 0);
  assert.equal(e.state().urgentHeadroom, 0);
  await e.endTurbo("cli", "off");
  const w2 = world({ limit: 4, urgent: { running: 0, waiting: 1 } });
  openGate(w2);
  const e2 = await createExecutor(deps(w2));
  await e2.tick(true);
  w2.limit = 3; // set by hand
  w2.now += 5 * MIN;
  await e2.tick(true);
  assert.equal(e2.state().urgentHeadroom, 0);
  assert.equal(e2.state().headroom, 0);
});
test("urgent: when the overall cap clamps the write, the urgent slot is kept before the opencode slot", async () => {
  // Claude 5, opencode 1, urgent 1 asks for 7; the cap lands 6: one slot above Claude, and it is the urgent one.
  const w = world({ limit: 4, globalLimit: 6, opencode: 1, urgent: { running: 0, waiting: 1 } });
  openGate(w);
  const d = deps(w);
  d.limits.set = async (_c, _id, limit) => { w.writes.push(limit); w.limit = Math.min(limit, w.globalLimit); return cfg(w); };
  const e = await createExecutor(d);
  await e.tick(true);
  assert.equal(w.limit, 6);
  assert.equal(e.state().headroom, 1);
  assert.equal(e.state().urgentHeadroom, 1);
});
test("urgent: the lane survives a reload", async () => {
  const w = world({ limit: 4, urgent: { running: 0, waiting: 1 } });
  openGate(w);
  await (await createExecutor(deps(w))).tick(true);
  const reloaded = await createExecutor(deps(w));
  assert.equal(reloaded.state().headroom, 1);
  assert.equal(reloaded.state().urgentHeadroom, 1);
});
test("urgent: a record from an older build (total headroom only) reads as all opencode", async () => {
  const w = world({ limit: 6, opencode: 1 });
  w.store.set("override", { lastSet: 6, pausedUntil: 0 });
  w.store.set("headroom", 1);
  const e = await createExecutor(deps(w));
  assert.equal(e.state().urgentHeadroom, 0);
  await e.tick(true);
  assert.equal(e.state().headroom, 1);
});
test("urgent: the decision log carries the urgent figures only when the lane is on", async () => {
  const w = world({ limit: 4, urgent: { running: 1, waiting: 2 } });
  openGate(w);
  const e = await createExecutor(deps(w));
  await e.tick(true);
  const rec = w.logs[0] as { urgentRunning?: number; urgentWaiting?: number; urgentHeadroom?: number };
  assert.deepEqual([rec.urgentRunning, rec.urgentWaiting, rec.urgentHeadroom], [1, 2, 1]);
  const w2 = world({ limit: 4, settings: { ...world().settings, urgentSlots: 0 } });
  openGate(w2);
  await (await createExecutor(deps(w2))).tick(true);
  assert.equal("urgentWaiting" in (w2.logs[0] as object), false);
});

const URGENT_WAIT_MIN = 120;
test("urgent: work waiting at least urgentReportMinutes is flagged starved in the reason and the tick", async () => {
  const w = world({ limit: 4, urgent: { running: 0, waiting: 1 } });
  openGate(w);
  const e = await createExecutor(deps(w));
  let t = await e.tick(true);
  assert.equal(t.urgentStarved, false);
  assert.equal(t.urgentSince, w.now);
  w.now += (URGENT_WAIT_MIN - 5) * MIN;
  t = await e.tick(true);
  assert.equal(t.urgentStarved, false, "just under the report time");
  w.now += 5 * MIN;
  t = await e.tick(true);
  assert.equal(t.urgentStarved, true);
  assert.match(t.why, /urgent work has waited 2 h 0 min/);
});
test("urgent: the wait clock clears when nothing waits, and survives a reload", async () => {
  const w = world({ limit: 4, urgent: { running: 0, waiting: 1 } });
  openGate(w);
  const e = await createExecutor(deps(w));
  await e.tick(true);
  const since = w.now;
  w.now += 60 * MIN;
  const reloaded = await createExecutor(deps(w));
  assert.equal(reloaded.state().urgentSince, since, "stored across a reload");
  w.urgent = { running: 1, waiting: 0 };
  w.now += 5 * MIN;
  const t = await reloaded.tick(true);
  assert.equal(t.urgentSince, null);
  assert.equal(w.store.has("urgentWaitSince"), false);
});
test("urgent: urgentReportMinutes 0 never flags", async () => {
  const w = world({ limit: 4, urgent: { running: 0, waiting: 1 }, settings: { ...world().settings, urgentReportMinutes: 0 } });
  openGate(w);
  const e = await createExecutor(deps(w));
  await e.tick(true);
  w.now += 24 * 60 * MIN;
  const t = await e.tick(true);
  assert.equal(t.urgentStarved, false);
});
test("urgent: status (apply false) reads the lane but stores and logs nothing", async () => {
  const w = world({ limit: 4, urgent: { running: 0, waiting: 1 } });
  openGate(w);
  const before = JSON.stringify([...w.store.entries()]);
  const e = await createExecutor(deps(w));
  await e.tick(false);
  assert.equal(JSON.stringify([...w.store.entries()]), before);
  assert.deepEqual(w.writes, []);
  assert.equal(w.logs.length, 0);
});

test("urgent: an unreadable count is shown in the reason, the tick and the log, and the lane keeps its state", async () => {
  const w = world({ limit: 4, urgent: { running: 0, waiting: 1 } });
  openGate(w);
  const d = deps(w);
  const e = await createExecutor(d);
  await e.tick(true);
  assert.equal(e.state().urgentHeadroom, 1);
  d.urgent = async () => { throw new Error("project_ambiguous"); };
  w.load1 = 4;
  w.now += 5 * MIN;
  const t = await e.tick(true);
  assert.equal(t.urgentUnreadable, true);
  assert.match(t.why, /urgent: unreadable$/);
  assert.equal(e.state().urgentHeadroom, 1, "the lane keeps its last state");
  const rec = w.logs[w.logs.length - 1] as { urgentUnreadable?: boolean };
  assert.equal(rec.urgentUnreadable, true);
});
test("urgent: a null count counts as unreadable too, and a readable one does not", async () => {
  const w = world({ limit: 4, urgent: null });
  openGate(w);
  const e = await createExecutor(deps(w));
  assert.equal((await e.tick(true)).urgentUnreadable, true);
  w.urgent = { running: 0, waiting: 0 };
  w.now += 5 * MIN;
  const t = await e.tick(true);
  assert.equal(t.urgentUnreadable, false);
  assert.doesNotMatch(t.why, /unreadable/);
});
test("urgent: with the lane off nothing is unreadable", async () => {
  const w = world({ limit: 4, urgent: null, settings: { ...world().settings, urgentSlots: 0 } });
  openGate(w);
  const e = await createExecutor(deps(w));
  const t = await e.tick(true);
  assert.equal(t.urgentUnreadable, false);
  assert.equal("urgentUnreadable" in (w.logs[0] as object), false);
});

// --- Several hosts: one pace step per round for the account's quota, each host on its own readings.
const WEEK_MS = 7 * 24 * 3600_000;
/** Weekly use of `used` percent with `elapsed` percent of the week gone, as the provider-usage output the parser reads. */
const weekAt = (w: World, used: number, elapsed: number) => ({ machines: [{ providers: [{ providerId: "claude-code", usage: { windows: [{ label: "Weekly limit", usedPercent: used, resetsAt: new Date(w.now + ((100 - elapsed) / 100) * WEEK_MS).toISOString() }] } }] }] });

function fleetPair(over: { a?: Partial<World>; b?: Partial<World> } = {}) {
  const a = world({ name: "macmini", limit: 4, ...over.a });
  const b = world({ name: "macstudio", limit: 4, ...over.b });
  a.load1 = over.a?.load1 ?? 4; b.load1 = over.b?.load1 ?? 4; // CPU in the middle band unless a test says otherwise
  for (const w of [a, b]) w.store.set("override", { lastSet: w.limit, pausedUntil: 0 });
  const turn = { takenBy: null as string | null };
  const da = deps(a); da.quotaTurn = turn; da.usage = async () => weekAt(a, 60, 44);
  const db = deps(b); db.quotaTurn = turn; db.usage = async () => weekAt(b, 60, 44);
  return { a, b, da, db, turn };
}

test("fleet: two hosts on the same pace signal: the first steps down, the second holds and says why", async () => {
  const { a, b, da, db, turn } = fleetPair();
  const ea = await createExecutor(da);
  const eb = await createExecutor(db);
  await ea.tick(true);
  const t = await eb.tick(true);
  assert.deepEqual(a.writes, [3]);
  assert.deepEqual(b.writes, [], "the second host does not step on the same quota");
  assert.equal(turn.takenBy, "macmini");
  assert.match(t.why, /^hold: quota step taken on macmini this tick \(weekly use ahead of time elapsed/);
});

test("fleet: the next round starts fresh, so the other host can take the step", async () => {
  const { a, b, da, db, turn } = fleetPair();
  const ea = await createExecutor(da);
  const eb = await createExecutor(db);
  await ea.tick(true);
  await eb.tick(true);
  turn.takenBy = null; // a new round
  a.now += 5 * MIN; b.now += 5 * MIN;
  await eb.tick(true);
  assert.deepEqual(b.writes, [3]);
});

test("fleet: a host's own CPU-hot step still happens when the quota step went elsewhere", async () => {
  const { a, b, da, db } = fleetPair({ b: { load1: 9 } });
  const ea = await createExecutor(da);
  const eb = await createExecutor(db);
  await ea.tick(true);
  await eb.tick(true);
  assert.deepEqual(a.writes, [3]);
  assert.deepEqual(b.writes, [3], "b is hot on its own load: it steps for that, not for the quota step a took");
  assert.match((b.logs[0] as { why: string }).why, /^CPU hot/);
});

test("fleet: quota near its cap drops every host to its minimum, whatever the quota step", async () => {
  const { a, b, da, db, turn } = fleetPair();
  da.usage = async () => weekAt(a, 92, 80);
  db.usage = async () => weekAt(b, 92, 80);
  turn.takenBy = "macmini";
  const eb = await createExecutor(db);
  await eb.tick(true);
  assert.deepEqual(b.writes, [1]);
});

test("fleet: a host in its back-off does not take the quota step, so the next host does", async () => {
  const { a, b, da, db, turn } = fleetPair();
  a.store.set("override", { lastSet: 4, pausedUntil: a.now + 60 * MIN }); // a is backing off a manual change
  const ea = await createExecutor(da);
  const eb = await createExecutor(db);
  await ea.tick(true);
  assert.equal(turn.takenBy, null);
  await eb.tick(true);
  assert.deepEqual(a.writes, []);
  assert.deepEqual(b.writes, [3]);
  assert.equal(turn.takenBy, "macstudio");
});

test("fleet: a status tick does not take the quota step", async () => {
  const { a, da, turn } = fleetPair();
  const ea = await createExecutor(da);
  await ea.tick(false);
  assert.equal(turn.takenBy, null);
  assert.deepEqual(a.writes, []);
});

test("single host: with no quotaTurn the pace step is taken as before", async () => {
  const w = world({ limit: 4 });
  w.store.set("override", { lastSet: 4, pausedUntil: 0 });
  w.load1 = 4;
  const d = deps(w);
  d.usage = async () => weekAt(w, 60, 44);
  await (await createExecutor(d)).tick(true);
  assert.deepEqual(w.writes, [3]);
});

test("a load reading may be asynchronous", async () => {
  const w = world({ limit: 4 });
  w.store.set("override", { lastSet: 4, pausedUntil: 0 });
  const d = deps(w);
  d.load = async () => { await new Promise((r) => setTimeout(r, 5)); return { load1: 0.2 * 24, cpus: 24 }; };
  await (await createExecutor(d)).tick(true);
  assert.deepEqual(w.writes, [5], "idle on a 24-core host: 0.2 per core");
});

test("a load reading that fails stops that host's tick and writes nothing", async () => {
  const w = world({ limit: 4 });
  w.store.set("override", { lastSet: 4, pausedUntil: 0 });
  const d = deps(w);
  d.load = async () => { throw new Error("host unreachable"); };
  const e = await createExecutor(d);
  await assert.rejects(e.tick(true), /host unreachable/);
  assert.deepEqual(w.writes, []);
  assert.equal(w.logs.length, 0);
});

test("a single-host Turbo that raised the cap ends with the cap restored even when several hosts are connected (fleet mode handover)", async () => {
  const w = world({ limit: 6, globalLimit: 6 });
  const t0 = w.now;
  w.store.set("turbo", { startedAt: t0 - 10 * MIN, until: t0 + 60 * MIN, untilOff: false, limit: 6, by: "cli", hostId: "h1", globalBefore: 4, globalRaised: true });
  w.store.set("override", { lastSet: 6, pausedUntil: 0 });
  const d = deps(w);
  // Fleet mode: the host setting is blank, so the single-host path would refuse to pick a host.
  d.settings = async () => ({ ...w.settings, host: "" });
  const e = await createExecutor(d);
  assert.notEqual(e.state().turbo, null);
  assert.equal(await e.endTurbo("scheduler", "fleet mode started: Turbo is single-host"), true);
  assert.equal(e.state().turbo, null);
  assert.equal(w.store.has("turbo"), false);
  assert.equal(w.restores, 1, "the overall cap raise is restored");
  assert.equal(w.globalLimit, 4);
  assert.ok(w.logs.some((l) => "kind" in l && l.kind === "turbo" && l.action === "end" && /fleet mode started/.test(l.reason ?? "") && /overall cap restored to 4/.test(l.reason ?? "")));
  assert.equal(await e.endTurbo("scheduler", "again"), false, "a second call is a no-op");
});

test("Interactive reserve: every host drops to its minimum on the reserve, whatever the quota step", async () => {
  const { a, b, da, db } = fleetPair();
  for (const d of [da, db]) { const s = d.settings; d.settings = async () => ({ ...(await s()), reserveFiveHour: 60, reserveWeek: 1, reserveWeekMargin: 10 }); }
  const ea = await createExecutor(da);
  const eb = await createExecutor(db);
  const ta = await ea.tick(true);
  const tb = await eb.tick(true);
  assert.deepEqual([a.writes, b.writes], [[1], [1]]);
  assert.match(ta.why, /^Interactive reserve: week 60% used, agents' share ends at 34%/);
  assert.match(tb.why, /^Interactive reserve:/);
});
