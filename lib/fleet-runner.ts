// Fleet mode: one executor per connected host, each on its own readings, range and stored state, ticked in turn so one host takes the account's quota pace step.
// The server gives it the sources; it keeps no bb dependency, so a test can run a whole round with fakes.
import { createExecutor, type CoachSettings, type Deps, type Executor, type QuotaTurn, type Tick } from "./executor.ts";
import { fleetMode, parseHostLimitsChecked, prefixedStore, profileFor, stepOrder, type HostProfile, type KvStore } from "./fleet.ts";
import type { HostReadings } from "./host-contract.ts";
import type { HostCfg, LimitCfg } from "./io.ts";
import type { LogLine } from "./decision-log.ts";

export interface FleetDeps {
  settings(): Promise<CoachSettings & { hostLimits?: string }>;
  limits: Deps["limits"];
  usage(): Promise<unknown>;
  /** One host's own load and memory, read on that host. Throws when it cannot be read. */
  readings(hostId: string): Promise<HostReadings>;
  now(): number;
  store: KvStore;
  appendLog(line: LogLine): void;
  warn(message: string): void;
  /**
   * Run at the start of every applied round (not a status round), before any host is ticked. The server uses it to end a single-host Turbo left from before fleet mode: nothing ticks the single-host executor any more, so it would never end and its overall cap raise would never be restored.
   * A failure is warned about and the round carries on.
   */
  beforeRound?(): Promise<void>;
}

export interface HostResult {
  host: string;
  hostId: string;
  /** The tick, or null when the host's tick did not run. */
  tick: Tick | null;
  /** Why the tick did not run (readings or limits unreadable). The host is held: nothing is written on a guess. */
  error: string | null;
  /** The range this host is held to. */
  profile: HostProfile;
}

export interface Fleet {
  /** Tick every connected host in turn. With `apply` false it changes nothing. Returns one result per connected host, in the order they were stepped. */
  round(apply: boolean): Promise<HostResult[]>;
  /** The results of the last round, by host id (applied rounds only record what they ran; a status round does not replace them). */
  last(): HostResult[];
}

interface Ctx {
  profile: HostProfile;
  readings: Promise<HostReadings>;
  usage: Promise<unknown>;
}

export async function createFleet(d: FleetDeps): Promise<Fleet> {
  const execs = new Map<string, { exec: Executor; ctx: Ctx }>();
  // One object for all hosts, reset at the start of each round: the first host to take the quota pace step sets it.
  const turn: QuotaTurn = { takenBy: null };
  let lastResults: HostResult[] = [];
  // Rounds run one at a time: the scheduled round, `tick` and `status` share the quota step and each host's executor, so two overlapping rounds could both take the step or overwrite each other.
  let queue: Promise<unknown> = Promise.resolve();
  // The last bad hostLimits text reported, so the same mistake is logged once, not every five minutes.
  let reportedBad = "";

  async function executorFor(h: HostCfg): Promise<{ exec: Executor; ctx: Ctx }> {
    const have = execs.get(h.id);
    if (have) return have;
    const ctx: Ctx = { profile: { min: 1, max: 1 }, readings: Promise.reject(new Error("not read")), usage: Promise.resolve(null) };
    ctx.readings.catch(() => { /* replaced before use */ });
    const deps: Deps = {
      // The host and its range are this host's own. The opencode and urgent lanes are single-host features: they are off here.
      settings: async () => ({ ...(await d.settings()), host: h.id, minLimit: ctx.profile.min, maxLimit: ctx.profile.max, opencodeSlots: 0, urgentSlots: 0 }),
      limits: d.limits,
      usage: () => ctx.usage,
      opencodeRunning: async () => 0,
      urgent: async () => ({ running: 0, waiting: 0 }),
      memory: async () => (await ctx.readings).memory,
      load: async () => {
        const r = await ctx.readings;
        return { load1: r.load1, cpus: r.cpus };
      },
      now: d.now,
      store: prefixedStore(d.store, h.id),
      appendLog: d.appendLog,
      warn: d.warn,
      quotaTurn: turn,
    };
    const made = { exec: await createExecutor(deps), ctx };
    execs.set(h.id, made);
    return made;
  }

  async function runRound(apply: boolean): Promise<HostResult[]> {
    // Only an applied round hands over: `status` must change nothing, and ending a Turbo restores the cap.
    if (apply && d.beforeRound) {
      try { await d.beforeRound(); } catch (e) { d.warn(`before the round: ${e instanceof Error ? e.message : String(e)}`); }
    }
    const s = await d.settings();
    const cfg: LimitCfg = await d.limits.get();
    const connected = cfg.hosts.filter((h) => h.status === "connected");
    const defaults: HostProfile = { min: Math.max(1, Math.floor(s.minLimit)), max: 0 };
    defaults.max = Math.max(defaults.min, Math.floor(s.maxLimit));
    const { profiles, dropped } = parseHostLimitsChecked(s.hostLimits);
    const bad = dropped.join(",");
    if (bad !== reportedBad) {
      reportedBad = bad;
      if (dropped.length > 0) d.warn(`hostLimits: ignored ${dropped.length} bad entr${dropped.length === 1 ? "y" : "ies"} (${dropped.map((x) => JSON.stringify(x)).join(", ")}); each must be name:min-max with 1 <= min <= max <= 64`);
    }
    const rows = connected.map((h) => {
      const profile = profileFor(h.name, profiles, defaults);
      return { h, profile, name: h.name, effectiveLimit: h.effectiveLimit, min: profile.min };
    });
    turn.takenBy = null;
    // One usage read for the whole round, so every host sees the same quota. Every host's readings are started at once: they take a few seconds each.
    const usage = d.usage();
    usage.catch(() => { /* surfaced by each host's tick, which treats unknown quota as no signal */ });
    const readings = new Map(rows.map((r) => [r.h.id, d.readings(r.h.id)]));
    for (const p of readings.values()) p.catch(() => { /* surfaced by that host's tick */ });

    const results: HostResult[] = [];
    for (const r of stepOrder(rows)) {
      const made = await executorFor(r.h);
      made.ctx.profile = r.profile;
      made.ctx.readings = readings.get(r.h.id) as Promise<HostReadings>;
      made.ctx.usage = usage;
      try {
        results.push({ host: r.h.name, hostId: r.h.id, tick: await made.exec.tick(apply), error: null, profile: r.profile });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        made.exec.setLastError(error);
        d.warn(`${r.h.name}: not stepped: ${error}`);
        results.push({ host: r.h.name, hostId: r.h.id, tick: null, error, profile: r.profile });
      }
    }
    if (apply) lastResults = results;
    return results;
  }

  /** One round at a time: a round that arrives while another runs waits for it. A failed round does not block the next. */
  function round(apply: boolean): Promise<HostResult[]> {
    const run = queue.then(() => runRound(apply));
    queue = run.catch(() => undefined);
    return run;
  }

  return { round, last: () => lastResults };
}

export { fleetMode };
