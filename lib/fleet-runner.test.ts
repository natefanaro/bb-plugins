import { test } from "node:test";
import assert from "node:assert/strict";
import { createFleet, type FleetDeps } from "./fleet-runner.ts";
import type { LimitCfg } from "./io.ts";
import type { LogLine } from "./decision-log.ts";
import type { HostReadings } from "./host-contract.ts";

const MIN = 60_000;
const WEEK_MS = 7 * 24 * 3600_000;
const T0 = Date.parse("2026-10-27T12:00:00Z");

interface FHost {
  id: string;
  name: string;
  limit: number | null;
  connected?: boolean;
  cpus: number;
  /** CPU load per core on that host. */
  load: number;
  memory?: { swapUsedPct: number | null; freePct: number | null; pageoutsPerSec: number | null };
  /** Make that host's readings fail. */
  fail?: boolean;
}

const MINI = (over: Partial<FHost> = {}): FHost => ({ id: "h_mini", name: "macmini", limit: 3, cpus: 10, load: 0.7, ...over });
const STUDIO = (over: Partial<FHost> = {}): FHost => ({ id: "h_studio", name: "macstudio", limit: 6, cpus: 24, load: 0.7, ...over });

function setup(hosts: FHost[], over: { settings?: Record<string, unknown>; quota?: { used: number; elapsed: number } | null; seed?: boolean; readDelayMs?: number; beforeRound?: () => Promise<void> } = {}) {
  let now = T0;
  const writes: { hostId: string; limit: number }[] = [];
  const logs: LogLine[] = [];
  const warns: string[] = [];
  const store = new Map<string, unknown>();
  const reads: string[] = [];
  let outstanding = 0;
  let peakOutstanding = 0;
  const cfg = (): LimitCfg => ({ globalLimit: 32, hostOverrides: [], hosts: hosts.map((h) => ({ id: h.id, name: h.name, status: h.connected === false ? "disconnected" : "connected", effectiveLimit: h.limit })) });
  const settings = { enabled: true, host: "", minLimit: 1, maxLimit: 8, overrideBackoffMinutes: 120, swapHotPercent: 70, memFreeMinPercent: 15, reserveFiveHour: 0, reserveWeek: 0, ...over.settings };
  const quota = over.quota === undefined ? { used: 60, elapsed: 44 } : over.quota;
  const deps: FleetDeps = {
    settings: async () => settings as never,
    limits: {
      get: async () => cfg(),
      set: async (_c, hostId, limit) => { writes.push({ hostId, limit }); const h = hosts.find((x) => x.id === hostId); if (h) h.limit = limit; return cfg(); },
      restore: async () => cfg(),
    },
    usage: async () => (quota === null ? null : { machines: [{ providers: [{ providerId: "claude-code", usage: { windows: [{ label: "Weekly limit", usedPercent: quota.used, resetsAt: new Date(now + ((100 - quota.elapsed) / 100) * WEEK_MS).toISOString() }] } }] }] }),
    readings: async (hostId): Promise<HostReadings> => {
      reads.push(hostId);
      outstanding++;
      peakOutstanding = Math.max(peakOutstanding, outstanding);
      if (over.readDelayMs) await new Promise((r) => setTimeout(r, over.readDelayMs));
      outstanding--;
      const h = hosts.find((x) => x.id === hostId)!;
      if (h.fail) throw new Error(`${h.name} unreachable`);
      return { load1: h.load * h.cpus, cpus: h.cpus, memory: h.memory ?? { swapUsedPct: 30, freePct: 60, pageoutsPerSec: 0 } };
    },
    now: () => now,
    store: { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); }, delete: async (k) => { store.delete(k); } },
    appendLog: (l) => { logs.push(l); },
    warn: (m) => { warns.push(m); },
    ...(over.beforeRound ? { beforeRound: over.beforeRound } : {}),
  };
  // Open each host's gate, as a host that has been running under Coach would have.
  if (over.seed !== false) for (const h of hosts) store.set(`fleet:${h.id}:override`, { lastSet: h.limit, pausedUntil: 0 });
  return { deps, writes, logs, warns, store, reads, hosts, peak: () => peakOutstanding, advance: (ms: number) => { now += ms; } };
}

const by = (writes: { hostId: string; limit: number }[], id: string) => writes.filter((w) => w.hostId === id).map((w) => w.limit);

test("a round ticks every connected host and returns one result each, the host with the most room first", async () => {
  const w = setup([MINI(), STUDIO()], { quota: null });
  const fleet = await createFleet(w.deps);
  const r = await fleet.round(true);
  assert.deepEqual(r.map((x) => x.host), ["macstudio", "macmini"], "the studio is 6 above its min, the mini 2");
  assert.ok(r.every((x) => x.tick !== null && x.error === null));
});

test("each host decides on its own readings: a hot mini steps down while an idle studio steps up", async () => {
  const w = setup([MINI({ load: 1.2 }), STUDIO({ load: 0.2 })], { quota: null });
  const fleet = await createFleet(w.deps);
  await fleet.round(true);
  assert.deepEqual(by(w.writes, "h_mini"), [2], "CPU hot on the mini");
  assert.deepEqual(by(w.writes, "h_studio"), [7], "CPU idle on the studio");
});

test("memory is per host: pressure on the studio does not step the mini", async () => {
  const w = setup([MINI(), STUDIO({ memory: { swapUsedPct: 90, freePct: 8, pageoutsPerSec: 400 } })], { quota: null });
  const fleet = await createFleet(w.deps);
  const r = await fleet.round(true);
  assert.deepEqual(by(w.writes, "h_studio"), [5]);
  assert.deepEqual(by(w.writes, "h_mini"), []);
  assert.match(r.find((x) => x.host === "macstudio")!.tick!.why, /^memory pressure/);
});

test("the quota is one pool: on a pace step down only the first host steps, the other holds and says so", async () => {
  const w = setup([MINI(), STUDIO()]); // weekly 60% used vs 44% elapsed, CPU in the middle band
  const fleet = await createFleet(w.deps);
  const r = await fleet.round(true);
  assert.deepEqual(by(w.writes, "h_studio"), [5], "the host with most room takes the step");
  assert.deepEqual(by(w.writes, "h_mini"), []);
  assert.match(r.find((x) => x.host === "macmini")!.tick!.why, /^hold: quota step taken on macstudio this tick/);
});

test("the next round starts fresh: the step is taken again", async () => {
  const w = setup([MINI(), STUDIO()]);
  const fleet = await createFleet(w.deps);
  await fleet.round(true);
  w.advance(5 * MIN);
  await fleet.round(true);
  assert.deepEqual(by(w.writes, "h_studio"), [5, 4], "one pace step per round, as a single host takes one per tick");
});

test("quota near its cap drops every host to its own minimum", async () => {
  const w = setup([MINI(), STUDIO()], { quota: { used: 92, elapsed: 80 }, settings: { hostLimits: "macstudio:3-12" } });
  const fleet = await createFleet(w.deps);
  await fleet.round(true);
  assert.deepEqual(by(w.writes, "h_studio"), [3], "the studio's own minimum");
  assert.deepEqual(by(w.writes, "h_mini"), [1], "the default minimum");
});

test("Interactive reserve in fleet mode: every host drops to its own minimum, with the lanes off", async () => {
  const w = setup([MINI(), STUDIO()], { quota: { used: 60, elapsed: 44 }, settings: { hostLimits: "macstudio:3-12", reserveWeek: 1, reserveWeekMargin: 10, opencodeSlots: 1, urgentSlots: 1 } });
  const fleet = await createFleet(w.deps);
  const results = await fleet.round(true);
  assert.deepEqual(by(w.writes, "h_studio"), [3], "the studio's own minimum");
  assert.deepEqual(by(w.writes, "h_mini"), [1], "the default minimum");
  for (const r of results) { assert.match(r.tick?.why ?? "", /^Interactive reserve: week 60% used/); assert.equal(r.tick?.headroom, 0, "no opencode headroom"); assert.equal(r.tick?.urgentHeadroom, 0, "no urgent headroom"); }
});

test("each host is held to its own range from hostLimits: both idle and at their own maximum, nothing is written", async () => {
  const w = setup([MINI({ limit: 8, load: 0.1 }), STUDIO({ limit: 12, load: 0.1 })], { quota: null, settings: { hostLimits: "macstudio:2-12" } });
  const fleet = await createFleet(w.deps);
  const r = await fleet.round(true);
  assert.deepEqual(w.writes, [], "studio 12 is its maximum, mini 8 is the default maximum");
  assert.deepEqual(r.map((x) => [x.host, x.profile]), [["macstudio", { min: 2, max: 12 }], ["macmini", { min: 1, max: 8 }]]);
});

test("a host below its own maximum steps up to it (the studio above the default maximum), the other stays at the default", async () => {
  const w = setup([MINI({ limit: 8, load: 0.1 }), STUDIO({ limit: 10, load: 0.1 })], { quota: null, settings: { hostLimits: "macstudio:2-12" } });
  const fleet = await createFleet(w.deps);
  await fleet.round(true);
  assert.deepEqual(by(w.writes, "h_studio"), [11], "11 is above the default maximum of 8, within the studio's own 12");
  assert.deepEqual(by(w.writes, "h_mini"), []);
});

test("a host whose readings fail is held with the reason; the other host still steps", async () => {
  const w = setup([MINI({ fail: true }), STUDIO({ load: 0.2 })], { quota: null });
  const fleet = await createFleet(w.deps);
  const r = await fleet.round(true);
  const mini = r.find((x) => x.host === "macmini")!;
  assert.equal(mini.tick, null);
  assert.match(mini.error ?? "", /macmini unreachable/);
  assert.deepEqual(by(w.writes, "h_mini"), [], "nothing is written on a guess");
  assert.deepEqual(by(w.writes, "h_studio"), [7]);
  assert.ok(w.warns.some((m) => /macmini: not stepped: macmini unreachable/.test(m)));
});

test("every host's stored state is under its own key, and the single-host keys are untouched", async () => {
  const w = setup([MINI(), STUDIO()], { quota: null });
  w.store.set("override", { lastSet: 99, pausedUntil: 0 });
  const fleet = await createFleet(w.deps);
  await fleet.round(true);
  assert.deepEqual(w.store.get("override"), { lastSet: 99, pausedUntil: 0 });
  assert.ok(w.store.has("fleet:h_mini:override"));
  assert.ok(w.store.has("fleet:h_studio:override"));
});

test("a status round reads and plans but writes and stores nothing, and does not replace the last applied results", async () => {
  const w = setup([MINI({ load: 0.2 }), STUDIO({ load: 0.2 })], { quota: null });
  const fleet = await createFleet(w.deps);
  const before = JSON.stringify([...w.store.entries()]);
  const r = await fleet.round(false);
  assert.equal(r.length, 2);
  assert.deepEqual(w.writes, []);
  assert.equal(JSON.stringify([...w.store.entries()]), before);
  assert.equal(w.logs.length, 0);
  assert.deepEqual(fleet.last(), []);
  await fleet.round(true);
  assert.equal(fleet.last().length, 2);
});

test("the opencode and urgent lanes are off in fleet mode: the host limit is Claude's alone", async () => {
  const w = setup([MINI({ load: 0.2 })], { quota: null, settings: { opencodeSlots: 1, urgentSlots: 1 } });
  const fleet = await createFleet(w.deps);
  const r = await fleet.round(true);
  assert.equal(r[0].tick!.headroom, 0);
  assert.equal(r[0].tick!.urgent, null);
  assert.deepEqual(by(w.writes, "h_mini"), [4]);
});

test("hosts that are not connected are left out, and a host that joins later is picked up", async () => {
  const hosts = [MINI(), STUDIO({ connected: false })];
  const w = setup(hosts, { quota: null });
  const fleet = await createFleet(w.deps);
  assert.deepEqual((await fleet.round(true)).map((x) => x.host), ["macmini"]);
  hosts[1].connected = true;
  hosts[1].limit = 5;
  w.deps.store.set("fleet:h_studio:override", { lastSet: 5, pausedUntil: 0 });
  w.advance(5 * MIN);
  assert.deepEqual((await fleet.round(true)).map((x) => x.host).sort(), ["macmini", "macstudio"]);
});

test("a manual change on one host backs that host off and leaves the other alone", async () => {
  const w = setup([MINI({ load: 0.2 }), STUDIO({ load: 0.2 })], { quota: null });
  const fleet = await createFleet(w.deps);
  w.hosts[0].limit = 2; // someone sets the mini by hand; Coach last set 3
  await fleet.round(true);
  assert.deepEqual(by(w.writes, "h_mini"), [], "the mini is backing off the manual change");
  assert.deepEqual(by(w.writes, "h_studio"), [7]);
});

test("each host's readings are read once per round", async () => {
  const w = setup([MINI(), STUDIO()], { quota: null });
  const fleet = await createFleet(w.deps);
  await fleet.round(true);
  assert.deepEqual([...w.reads].sort(), ["h_mini", "h_studio"]);
});

test("the log names each host", async () => {
  const w = setup([MINI({ load: 0.2 }), STUDIO({ load: 0.2 })], { quota: null });
  const fleet = await createFleet(w.deps);
  await fleet.round(true);
  assert.deepEqual(w.logs.map((l) => (l as { host: string }).host).sort(), ["macmini", "macstudio"]);
});

test("rounds are serialized: two that arrive together run one after the other, so the quota step is taken once per round", async () => {
  const w = setup([MINI(), STUDIO()], { readDelayMs: 20 }); // weekly pace ahead, CPU in the middle band
  const fleet = await createFleet(w.deps);
  const [a, b] = await Promise.all([fleet.round(true), fleet.round(true)]);
  assert.ok(w.peak() <= 2, `at most one round's readings in flight at a time (saw ${w.peak()})`);
  assert.deepEqual(by(w.writes, "h_studio"), [5, 4], "one pace step per round, both by the host with most room");
  assert.deepEqual(by(w.writes, "h_mini"), [], "the other host never took a step");
  assert.equal(a.length, 2);
  assert.equal(b.length, 2);
});

test("a status round that arrives during a scheduled round waits for it and does not disturb it", async () => {
  const w = setup([MINI(), STUDIO()], { readDelayMs: 20 });
  const fleet = await createFleet(w.deps);
  const scheduled = fleet.round(true);
  const status = fleet.round(false);
  await Promise.all([scheduled, status]);
  assert.ok(w.peak() <= 2);
  assert.deepEqual(by(w.writes, "h_studio"), [5], "only the applied round wrote");
  assert.deepEqual(by(w.writes, "h_mini"), []);
});

test("a round that fails does not block the next one", async () => {
  const w = setup([MINI(), STUDIO()], { quota: null });
  let broken = true;
  const get = w.deps.limits.get;
  w.deps.limits.get = async () => { if (broken) throw new Error("limits down"); return get(); };
  const fleet = await createFleet(w.deps);
  await assert.rejects(fleet.round(true), /limits down/);
  broken = false;
  assert.equal((await fleet.round(true)).length, 2);
});

test("the before-round hook runs first in every round; a failing hook is warned about and the round carries on", async () => {
  const order: string[] = [];
  let fail = false;
  const w = setup([MINI({ load: 0.2 })], { quota: null, beforeRound: async () => { order.push("hook"); if (fail) throw new Error("could not end Turbo"); } });
  const get = w.deps.limits.get;
  w.deps.limits.get = async () => { order.push("limits"); return get(); };
  const fleet = await createFleet(w.deps);
  await fleet.round(true);
  assert.equal(order[0], "hook");
  assert.ok(order.indexOf("hook") < order.indexOf("limits"));
  fail = true;
  w.advance(5 * MIN);
  const r = await fleet.round(true);
  assert.equal(r.length, 1, "the round still ran");
  assert.ok(w.warns.some((m) => /before the round: could not end Turbo/.test(m)));
});

test("a bad hostLimits entry is logged once, with the entry, and the good ones still apply", async () => {
  const w = setup([MINI(), STUDIO()], { quota: null, settings: { hostLimits: "macstudio:2-12,bogus,macmini:9-3" } });
  const fleet = await createFleet(w.deps);
  const r = await fleet.round(true);
  const msgs = w.warns.filter((m) => m.startsWith("hostLimits:"));
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /ignored 2 bad entries \("bogus", "macmini:9-3"\)/);
  assert.deepEqual(r.find((x) => x.host === "macstudio")!.profile, { min: 2, max: 12 });
  w.advance(5 * MIN);
  await fleet.round(true);
  assert.equal(w.warns.filter((m) => m.startsWith("hostLimits:")).length, 1, "the same mistake is not logged every round");
});

test("a changed bad hostLimits is logged again, and a good one logs nothing", async () => {
  const w = setup([MINI(), STUDIO()], { quota: null, settings: { hostLimits: "bad" } });
  const fleet = await createFleet(w.deps);
  await fleet.round(true);
  (w.deps.settings as unknown) = async () => ({ enabled: true, host: "", minLimit: 1, maxLimit: 8, overrideBackoffMinutes: 120, swapHotPercent: 70, memFreeMinPercent: 15, reserveFiveHour: 0, reserveWeek: 0, hostLimits: "worse:0-0" });
  w.advance(5 * MIN);
  await fleet.round(true);
  assert.equal(w.warns.filter((m) => m.startsWith("hostLimits:")).length, 2);
  const ok = setup([MINI(), STUDIO()], { quota: null, settings: { hostLimits: "macstudio:2-12" } });
  await (await createFleet(ok.deps)).round(true);
  assert.equal(ok.warns.filter((m) => m.startsWith("hostLimits:")).length, 0);
});

test("a status round does not run the hook, so a left-over Turbo is left alone; an applied round ends it", async () => {
  // A real hook, not a no-op: it ends the Turbo and restores the cap, as the server's does.
  const state = { turbo: true, cap: 6 };
  let calls = 0;
  const w = setup([MINI({ load: 0.2 })], { quota: null, beforeRound: async () => { calls++; if (state.turbo) { state.turbo = false; state.cap = 4; } } });
  const fleet = await createFleet(w.deps);
  await fleet.round(false);
  assert.equal(calls, 0);
  assert.deepEqual(state, { turbo: true, cap: 6 }, "status changed nothing");
  await fleet.round(true);
  assert.equal(calls, 1);
  assert.deepEqual(state, { turbo: false, cap: 4 }, "the applied round handed over");
});
