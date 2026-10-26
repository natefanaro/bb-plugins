// The tick executor: reads the host and the signals, plans the tick (lib/tick.ts), and carries the plan out. Holds the manual-change back-off and Turbo, and keeps both in plugin storage.
// Everything it touches comes in through `Deps`, so tests can run it against a fake host and a fake store, and reload it with the same store.
import { decide, parseUsage, type Signals } from "./policy.ts";
import { baselineAfterWrite, gate, NO_OVERRIDE, parseOverride, type OverrideState } from "./override.ts";
import type { LogLine } from "./decision-log.ts";
import type { HostCfg, LimitCfg } from "./io.ts";
import { planTick } from "./tick.ts";
import { NO_MEMORY, type MemoryReading } from "./memory.ts";
import { tuningFrom, type Tuning } from "./tuning.ts";
import {
  parseTurbo, quotaNear, raisesCap, startTurbo, turboCapRestore, turboEndReason, turboSentence, turboStep, TURBO_DEFAULT_MS, type Turbo,
} from "./turbo.ts";

export interface CoachSettings extends Partial<Tuning> {
  enabled: boolean;
  host: string;
  minLimit: number;
  maxLimit: number;
  overrideBackoffMinutes: number;
  swapHotPercent: number;
  memFreeMinPercent: number;
}

export interface Deps {
  settings(): Promise<CoachSettings>;
  limits: {
    get(): Promise<LimitCfg>;
    set(cfg: LimitCfg, hostId: string, limit: number): Promise<LimitCfg>;
    restore(globalLimit: number | null, hostOverrides: { hostId: string; limit: number | null }[]): Promise<LimitCfg>;
  };
  usage(): Promise<unknown>;
  memory(): Promise<MemoryReading>;
  /** 1-minute load average and the CPU count. */
  load(): { load1: number; cpus: number };
  now(): number;
  store: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void> };
  /** Append one decision or Turbo line to the log. May throw; the executor reports that and carries on. */
  appendLog(line: LogLine): void;
  warn(message: string): void;
}

export interface Tick { applied: boolean; host: string; cur: number; next: number; why: string; signals: Signals; error?: string }

export interface Executor {
  tick(apply: boolean): Promise<Tick>;
  startTurboFrom(by: "cli" | "panel", limit: number | undefined, durationMs: number | undefined): Promise<{ turbo: Turbo; capRaised: boolean }>;
  endTurbo(by: "cli" | "panel" | "scheduler", reason: string): Promise<boolean>;
  /** The stored back-off and Turbo as the executor holds them. */
  state(): { override: OverrideState; turbo: Turbo | null };
  last(): Tick | null;
  setLastError(error: string): void;
}

export async function createExecutor(deps: Deps): Promise<Executor> {
  let override: OverrideState = parseOverride(await deps.store.get("override")) ?? NO_OVERRIDE;
  let turbo: Turbo | null = parseTurbo(await deps.store.get("turbo"));
  let last: Tick | null = null;

  async function persistOverride(): Promise<void> {
    await deps.store.set("override", override);
  }

  async function saveTurbo(next: Turbo | null): Promise<void> {
    turbo = next;
    if (next === null) await deps.store.delete("turbo");
    else await deps.store.set("turbo", next);
  }

  function logTurbo(event: { by: "cli" | "panel" | "scheduler"; action: "start" | "end"; limit?: number; until?: string; reason?: string }): void {
    try { deps.appendLog({ t: new Date(deps.now()).toISOString(), kind: "turbo", ...event }); }
    catch (e) { deps.warn(`turbo event not logged: ${String(e)}`); }
  }

  /** The host the settings pick: the named one, or the only connected one. */
  function pickHost(cfg: LimitCfg, hostSetting: string): HostCfg {
    const connected = cfg.hosts.filter((h) => h.status === "connected");
    const host: HostCfg | undefined = hostSetting ? connected.find((h) => h.name === hostSetting || h.id === hostSetting) : connected.length === 1 ? connected[0] : undefined;
    if (!host) throw new Error(hostSetting ? `host "${hostSetting}" is not connected` : `set the host setting: ${connected.length} hosts are connected`);
    return host;
  }

  /** One write of the host limit. Returns the value the host reports back, when it does. */
  async function writeLimit(cfg: LimitCfg, hostId: string, limit: number): Promise<number | undefined> {
    const after = await deps.limits.set(cfg, hostId, limit);
    return (after?.hosts ?? []).find((h) => h.id === hostId)?.effectiveLimit ?? undefined;
  }

  /**
   * End Turbo. If it raised the overall cap, put the cap back and keep the host's override under it.
   * After a cap restore, the baseline becomes the host limit the restore left, so the restore is not read as a manual change.
   * A manual change ends Turbo with the back-off still to come, so the baseline is left alone.
   */
  async function endTurbo(by: "cli" | "panel" | "scheduler", reason: string): Promise<boolean> {
    if (turbo === null) return false;
    const ended = turbo;
    await saveTurbo(null);
    let capNote = "";
    let restoredHost: number | undefined;
    if (ended.globalRaised) {
      try {
        const cfg = await deps.limits.get();
        const r = turboCapRestore(cfg, ended);
        const after = await deps.limits.restore(r.globalLimit, r.hostOverrides);
        restoredHost = (after?.hosts ?? []).find((h) => h.id === ended.hostId)?.effectiveLimit ?? undefined;
        capNote = `; overall cap restored to ${r.globalLimit ?? "none"}`;
      } catch (e) {
        deps.warn(`overall cap not restored: ${String(e)}`);
        capNote = "; overall cap NOT restored (see log)";
      }
    }
    if (restoredHost !== undefined && reason !== "manual limit change") override = { ...override, lastSet: restoredHost };
    await persistOverride();
    logTurbo({ by, action: "end", reason: reason + capNote });
    return true;
  }

  /** Start Turbo. The start writes the limit now; it is an explicit instruction, not a scheduled tick. Starting over an active Turbo keeps that Turbo's cap state. */
  async function startTurboFrom(by: "cli" | "panel", limit: number | undefined, durationMs: number | undefined): Promise<{ turbo: Turbo; capRaised: boolean }> {
    const s = await deps.settings();
    const cfg = await deps.limits.get();
    const host = pickHost(cfg, s.host);
    const max = Math.max(Math.max(1, Math.floor(s.minLimit)), Math.floor(s.maxLimit));
    const want = limit ?? max;
    const prior = turbo;
    const globalBefore = prior !== null ? prior.globalBefore : cfg.globalLimit;
    const capRaised = (prior !== null && prior.globalRaised) || raisesCap(cfg.globalLimit, want);
    const t = startTurbo(deps.now(), want, durationMs ?? TURBO_DEFAULT_MS, by, host.id, globalBefore, capRaised);
    const cur = host.effectiveLimit ?? max;
    await saveTurbo(t);
    logTurbo({ by, action: "start", limit: t.limit, until: new Date(t.until).toISOString() });
    const landed = t.limit !== cur ? await writeLimit(cfg, host.id, t.limit) : cur;
    override = { ...override, lastSet: baselineAfterWrite(t.limit, landed) };
    await persistOverride();
    return { turbo: t, capRaised };
  }

  async function tick(apply: boolean): Promise<Tick> {
    const s = await deps.settings();
    const cfg = await deps.limits.get();
    const host = pickHost(cfg, s.host);
    const min = Math.max(1, Math.floor(s.minLimit)), max = Math.max(min, Math.floor(s.maxLimit));
    const cur = host.effectiveLimit ?? max;
    const { load1, cpus } = deps.load();
    let usage: ReturnType<typeof parseUsage> = { fiveHourUsed: null, fiveHourElapsed: null, weekUsed: null, weekElapsed: null, weekResetsAt: null };
    try { usage = parseUsage(await deps.usage(), deps.now()); } catch { /* quota unknown: scale on CPU alone */ }
    let memory: MemoryReading = NO_MEMORY;
    try { memory = await deps.memory(); } catch { /* memory unknown: not a signal */ }
    const tuning = tuningFrom(s);
    const thresholds = { swapHotPercent: s.swapHotPercent, memFreeMinPercent: s.memFreeMinPercent, pageoutHotPerSec: tuning.pageoutHotPerSec };
    const signals: Signals = { cur, min, max, loadRatio: load1 / cpus, ...usage, memory: { reading: memory, thresholds }, tuning };
    const now = deps.now();
    // Turbo ends at the quota cap, on a manual change, at the weekly reset, or when its time box runs out.
    const manual = turbo !== null && turboStep(override.lastSet, cur, turbo.limit).kind === "manual";
    const endReason = turbo === null ? null : turboEndReason(turbo, now, usage.weekResetsAt, quotaNear(signals, tuning), manual);
    const g = gate(override, cur, now, Math.max(0, s.overrideBackoffMinutes) * 60_000);
    const plan = planTick({ apply, cur, turbo, endReason, lastSet: override.lastSet, decision: decide(signals), gate: g });

    // A tick that ends Turbo restores first, then writes nothing; the next tick decides from fresh readings.
    if (plan.kind === "turbo-ended") {
      await endTurbo("scheduler", plan.reason);
      // A manual change that ended Turbo is recorded and backed off in this same tick, not the next one.
      if (apply && plan.reason === "manual limit change") {
        override = g.state;
        await persistOverride();
      }
    }

    let applied = false;
    let landed: number | undefined;
    if (plan.write !== null) {
      landed = await writeLimit(cfg, host.id, plan.write);
      applied = true;
    }
    // Only applied ticks commit override state; status (apply=false) changes nothing.
    if (apply && plan.kind === "turbo") {
      if (plan.step === "baseline") override = { ...override, lastSet: cur };
      else if (plan.step === "write") override = { ...override, lastSet: applied ? baselineAfterWrite(plan.write ?? cur, landed) : cur };
      else override = { ...override, lastSet: cur };
    } else if (apply && plan.kind === "normal") {
      override = g.state;
      if (g.apply) override = { ...override, lastSet: applied ? baselineAfterWrite(plan.write ?? cur, landed) : cur };
    }
    last = { applied, host: host.name, cur, next: plan.next, why: plan.why, signals };
    if (apply) {
      await persistOverride();
      try {
        deps.appendLog({ t: new Date(now).toISOString(), host: host.name, cur, next: plan.next, applied, why: plan.why, load: signals.loadRatio, fiveHourUsed: signals.fiveHourUsed, fiveHourElapsed: signals.fiveHourElapsed, weekUsed: signals.weekUsed, weekElapsed: signals.weekElapsed, memory: { swapUsedPct: memory.swapUsedPct, freePct: memory.freePct, pageoutsPerSec: memory.pageoutsPerSec }, override, turbo: plan.kind === "turbo" });
      } catch (e) { deps.warn(`decision log not written: ${String(e)}`); }
    }
    return last;
  }

  return {
    tick,
    startTurboFrom,
    endTurbo,
    state: () => ({ override, turbo }),
    last: () => last,
    setLastError: (error: string) => { last = { ...(last as Tick), error }; },
  };
}
