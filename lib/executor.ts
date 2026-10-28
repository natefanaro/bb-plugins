// The tick executor: reads the host and the signals, plans the tick (lib/tick.ts), and carries the plan out. Holds the manual-change back-off and Turbo, and keeps both in plugin storage.
// Everything it touches comes in through `Deps`, so tests can run it against a fake host and a fake store, and reload it with the same store.
import { decide, parseUsage, type Signals } from "./policy.ts";
import { baselineAfterWrite, gate, NO_OVERRIDE, parseOverride, type OverrideState } from "./override.ts";
import type { LogLine } from "./decision-log.ts";
import type { HostCfg, LimitCfg } from "./io.ts";
import { planTick } from "./tick.ts";
import { NO_MEMORY, type MemoryReading } from "./memory.ts";
import { tuningFrom, type Tuning } from "./tuning.ts";
import { opencodeHeadroom, parseHeadroom } from "./headroom.ts";
import { parseWaitSince, urgentHeadroom, urgentWait, type UrgentCount } from "./urgent.ts";
import {
  parseTurbo, quotaNear, raisesCap, startTurbo, turboCapRestore, turboEndReason, turboMemoryEndReason, turboSentence, turboStartBlock, turboStep, TURBO_DEFAULT_MS, type Turbo,
} from "./turbo.ts";

export interface CoachSettings extends Partial<Tuning> {
  enabled: boolean;
  /** True: opencode threads take Claude capacity (no headroom). */
  opencodeCountsAgainstLimit?: boolean;
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
  /** Busy opencode threads now (providerId acp-opencode), or null when the count cannot be read. */
  opencodeRunning(): Promise<number | null>;
  /** Urgent threads now (their task has priority urgent): running and waiting behind the limit. Null when it cannot be read. */
  urgent(): Promise<UrgentCount | null>;
  memory(): Promise<MemoryReading>;
  /** 1-minute load average and the CPU count of the governed host. A remote host answers asynchronously; a failed read throws and the tick for that host does not run. */
  load(): { load1: number; cpus: number } | Promise<{ load1: number; cpus: number }>;
  now(): number;
  store: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void> };
  /** Append one decision or Turbo line to the log. May throw; the executor reports that and carries on. */
  appendLog(line: LogLine): void;
  warn(message: string): void;
  /** Shared by the hosts of one round when several are managed: the first host to take the quota-pace step down sets `takenBy`, and the rest hold. Absent for a single host. */
  quotaTurn?: QuotaTurn;
}

export interface QuotaTurn { takenBy: string | null }

export interface Tick { applied: boolean; host: string; cur: number; next: number; why: string; signals: Signals; error?: string; opencodeRunning: number | null; headroom: number;
  /** Urgent threads now, the slots of the urgent lane in effect, and when urgent work first waited (null when none waits). */
  urgent: UrgentCount | null; urgentHeadroom: number; urgentSince: number | null; urgentStarved: boolean;
  /** The urgent lane is on but its count could not be read this tick; the lane stays as it was. */
  urgentUnreadable: boolean }

export interface Executor {
  tick(apply: boolean): Promise<Tick>;
  startTurboFrom(by: "cli" | "panel", limit: number | undefined, durationMs: number | null | undefined): Promise<{ turbo: Turbo; capRaised: boolean }>;
  endTurbo(by: "cli" | "panel" | "scheduler", reason: string): Promise<boolean>;
  /** The stored back-off and Turbo as the executor holds them. */
  state(): { override: OverrideState; turbo: Turbo | null; headroom: number; urgentHeadroom: number; urgentSince: number | null };
  last(): Tick | null;
  setLastError(error: string): void;
}

export async function createExecutor(deps: Deps): Promise<Executor> {
  let override: OverrideState = parseOverride(await deps.store.get("override")) ?? NO_OVERRIDE;
  let turbo: Turbo | null = parseTurbo(await deps.store.get("turbo"));
  // The opencode headroom on the host now (a whole number). Kept apart from Claude's paced limit, so pacing never sees it.
  let headroom: number = parseHeadroom(await deps.store.get("headroom"));
  // The urgent lane's part of that headroom, and when urgent work first began waiting.
  let urgentLane: number = Math.min(parseHeadroom(await deps.store.get("urgentHeadroom")), headroom);
  let waitSince: number | null = parseWaitSince(await deps.store.get("urgentWaitSince"));
  let last: Tick | null = null;

  /** Store the total headroom (opencode + urgent) and the urgent part of it. The total stays under the old key, so an older build still reads it. */
  async function setHeadroom(next: number, urgent = 0): Promise<void> {
    const u = Math.min(urgent, next);
    if (next !== headroom) { headroom = next; await deps.store.set("headroom", next); }
    if (u !== urgentLane) { urgentLane = u; await deps.store.set("urgentHeadroom", u); }
  }

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
    await setHeadroom(0);
    logTurbo({ by, action: "end", reason: reason + capNote });
    return true;
  }

  /** Start Turbo. The start writes the limit now; it is an explicit instruction, not a scheduled tick. Starting over an active Turbo keeps that Turbo's cap state. A null duration runs until Turbo is turned off; undefined is the default time box. */
  async function startTurboFrom(by: "cli" | "panel", limit: number | undefined, durationMs: number | null | undefined): Promise<{ turbo: Turbo; capRaised: boolean }> {
    const s = await deps.settings();
    const cfg = await deps.limits.get();
    const host = pickHost(cfg, s.host);
    const max = Math.max(Math.max(1, Math.floor(s.minLimit)), Math.floor(s.maxLimit));
    const want = limit ?? max;
    // Refuse a start that would end on the next tick: the same quota and memory rules the tick applies. An unreadable figure is not a signal.
    const tuning = tuningFrom(s);
    let usage: ReturnType<typeof parseUsage> = { fiveHourUsed: null, fiveHourElapsed: null, weekUsed: null, weekElapsed: null, weekResetsAt: null };
    try { usage = parseUsage(await deps.usage(), deps.now()); } catch { /* quota unknown */ }
    let reading: MemoryReading = NO_MEMORY;
    try { reading = await deps.memory(); } catch { /* memory unknown */ }
    const block = turboStartBlock(
      deps.now(),
      usage.weekResetsAt,
      quotaNear(usage, tuning),
      turboMemoryEndReason(reading, { swapHotPercent: s.swapHotPercent, memFreeMinPercent: s.memFreeMinPercent, pageoutHotPerSec: tuning.pageoutHotPerSec }, tuning.turboSwapEndPercent),
    );
    if (block !== null) throw new Error(`Turbo not started: ${block}`);
    const prior = turbo;
    const globalBefore = prior !== null ? prior.globalBefore : cfg.globalLimit;
    const capRaised = (prior !== null && prior.globalRaised) || raisesCap(cfg.globalLimit, want);
    const t = startTurbo(deps.now(), want, durationMs === undefined ? TURBO_DEFAULT_MS : durationMs, by, host.id, globalBefore, capRaised);
    const cur = host.effectiveLimit ?? max;
    await saveTurbo(t);
    logTurbo({ by, action: "start", limit: t.limit, ...(t.untilOff ? {} : { until: new Date(t.until).toISOString() }) });
    const landed = t.limit !== cur ? await writeLimit(cfg, host.id, t.limit) : cur;
    override = { ...override, lastSet: baselineAfterWrite(t.limit, landed) };
    await persistOverride();
    await setHeadroom(0);
    return { turbo: t, capRaised };
  }

  async function tick(apply: boolean): Promise<Tick> {
    const s = await deps.settings();
    const cfg = await deps.limits.get();
    const host = pickHost(cfg, s.host);
    const min = Math.max(1, Math.floor(s.minLimit)), max = Math.max(min, Math.floor(s.maxLimit));
    const cur = host.effectiveLimit ?? max;
    const { load1, cpus } = await deps.load();
    let usage: ReturnType<typeof parseUsage> = { fiveHourUsed: null, fiveHourElapsed: null, weekUsed: null, weekElapsed: null, weekResetsAt: null };
    try { usage = parseUsage(await deps.usage(), deps.now()); } catch { /* quota unknown: scale on CPU alone */ }
    let memory: MemoryReading = NO_MEMORY;
    try { memory = await deps.memory(); } catch { /* memory unknown: not a signal */ }
    const tuning = tuningFrom(s);
    const thresholds = { swapHotPercent: s.swapHotPercent, memFreeMinPercent: s.memFreeMinPercent, pageoutHotPerSec: tuning.pageoutHotPerSec };
    const now = deps.now();
    // The opencode count only matters when it can add headroom. A failed read keeps the headroom in effect.
    const countsOpencode = tuning.opencodeSlots > 0 && s.opencodeCountsAgainstLimit !== true;
    let opencodeCount: number | null = null;
    if (countsOpencode) { try { opencodeCount = await deps.opencodeRunning(); } catch { opencodeCount = null; } }
    // The urgent count only matters when the lane is on. A failed read keeps the lane as it was.
    let urgentCount: UrgentCount | null = null;
    if (tuning.urgentSlots > 0) { try { urgentCount = await deps.urgent(); } catch { urgentCount = null; } }
    const urgentUnreadable = tuning.urgentSlots > 0 && urgentCount === null;
    // A manual change makes the host limit a Claude-scale value: its headroom is dropped.
    const manualChange = override.lastSet !== null && cur !== override.lastSet;
    const storedHeadroom = manualChange ? 0 : headroom;
    const storedUrgent = manualChange ? 0 : Math.min(urgentLane, storedHeadroom);
    // Claude's paced limit is the host limit without the headroom. Pacing and the quota rules see only this.
    const claudeCur = cur - storedHeadroom;
    const signals: Signals = { cur: claudeCur, min, max, loadRatio: load1 / cpus, ...usage, memory: { reading: memory, thresholds }, tuning };
    // Turbo ends at the quota cap, under memory pressure, on a manual change, at the weekly reset, or when its time box runs out.
    const turboManual = turbo !== null && turboStep(override.lastSet, cur, turbo.limit).kind === "manual";
    const endReason = turbo === null ? null : turboEndReason(turbo, now, usage.weekResetsAt, quotaNear(signals, tuning), turboManual, turboMemoryEndReason(memory, thresholds, tuning.turboSwapEndPercent));
    const g = gate(override, cur, now, Math.max(0, s.overrideBackoffMinutes) * 60_000);
    // Turbo plans on the exact host limit; everything else plans on Claude's paced limit.
    const decision = decide({ ...signals, cur: turbo !== null ? cur : claudeCur, ...(deps.quotaTurn?.takenBy ? { quotaStepTaken: deps.quotaTurn.takenBy } : {}) });
    const plan = planTick({ apply, cur: turbo !== null ? cur : claudeCur, turbo, endReason, lastSet: override.lastSet, decision, gate: g });
    // The first host that steps down on the quota pace in this round takes the step for the account. Status ticks and backed-off hosts do not take it.
    if (apply && plan.kind === "normal" && g.apply && deps.quotaTurn && deps.quotaTurn.takenBy === null && (decision.kind === "quota-5h" || decision.kind === "quota-week") && decision.next < claudeCur) {
      deps.quotaTurn.takenBy = host.name;
    }

    // A tick that ends Turbo restores first, then writes nothing; the next tick decides from fresh readings.
    if (plan.kind === "turbo-ended") {
      await endTurbo("scheduler", plan.reason);
      // A manual change that ended Turbo is recorded and backed off in this same tick, not the next one.
      if (apply && plan.reason === "manual limit change") {
        override = g.state;
        await persistOverride();
      }
    }

    // The host limit to write. Turbo writes its exact limit. Otherwise it is Claude's target plus the opencode headroom, and nothing while backing off.
    const plan0 = opencodeHeadroom({ running: opencodeCount, slots: tuning.opencodeSlots, countsAgainstLimit: s.opencodeCountsAgainstLimit === true, previous: storedHeadroom - storedUrgent });
    const urgentWanted = turbo !== null ? 0 : urgentHeadroom({ count: urgentCount, slots: tuning.urgentSlots, previous: storedUrgent });
    const newHeadroom = turbo !== null ? 0 : plan0.headroom + urgentWanted;
    let write: number | null = plan.write;
    if (plan.kind === "normal" && apply && g.apply) {
      const hostTarget = Math.min((plan.write ?? claudeCur) + newHeadroom, max + newHeadroom);
      write = hostTarget !== cur ? hostTarget : null;
    }
    let applied = false;
    let landed: number | undefined;
    if (write !== null) {
      landed = await writeLimit(cfg, host.id, write);
      applied = true;
      let storeHeadroom = turbo !== null ? 0 : newHeadroom;
      if (plan.kind === "normal" && apply && g.apply && landed !== undefined) {
        // The overall cap can clamp the write. Store only the headroom that landed above Claude's target, so Claude's limit is not read low. An unknown landed value keeps the requested headroom.
        const claudeWritten = Math.min(plan.write ?? claudeCur, max);
        storeHeadroom = Math.max(0, Math.min(newHeadroom, landed - claudeWritten));
      }
      // When the cap clamps the headroom, the urgent slot is kept first and the opencode slots take what is left.
      await setHeadroom(storeHeadroom, Math.min(urgentWanted, storeHeadroom));
    } else if (manualChange) {
      // No write after a manual change: the host limit is Claude-scale now, so no headroom is in effect.
      await setHeadroom(0);
    } else if (apply && plan.kind === "normal" && g.apply) {
      // The host already sits at Claude's target plus the new headroom, so only the split changes (for example when opencode finishes).
      await setHeadroom(newHeadroom, urgentWanted);
    }
    // The headroom in effect now (a Turbo end in this tick has already cleared it), and Claude's limit from the host limit.
    const headroomNow = headroom;
    const claudeNow = (landed ?? write ?? cur) - headroomNow;

    // Only applied ticks commit override state; status (apply=false) changes nothing.
    if (apply && plan.kind === "turbo") {
      if (plan.step === "baseline") override = { ...override, lastSet: cur };
      else if (plan.step === "write") override = { ...override, lastSet: applied ? baselineAfterWrite(write ?? cur, landed) : cur };
      else override = { ...override, lastSet: cur };
    } else if (apply && plan.kind === "normal") {
      override = g.state;
      if (g.apply) override = { ...override, lastSet: applied ? baselineAfterWrite(write ?? cur, landed) : cur };
    }

    // How long urgent work has waited. Status ticks read it but change nothing.
    const wait = urgentWait(tuning.urgentSlots > 0 ? urgentCount : { running: 0, waiting: 0 }, now, waitSince, tuning.urgentReportMinutes * 60_000);
    if (apply && wait.since !== waitSince) {
      waitSince = wait.since;
      if (wait.since === null) await deps.store.delete("urgentWaitSince");
      else await deps.store.set("urgentWaitSince", wait.since);
    }
    // The reason says Claude, opencode and urgent only when a lane is in play, so decisions with no lane read as before.
    const warn = plan0.warn;
    const urgentShown = Math.min(urgentLane, headroomNow);
    const opencodeShown = headroomNow - urgentShown;
    const laneNote = headroomNow > 0 || warn !== null
      ? ` · Claude ${claudeNow}${opencodeShown > 0 || warn !== null ? ` + opencode ${opencodeShown}` : ""}${urgentShown > 0 ? ` + urgent ${urgentShown}` : ""}${warn !== null ? ` (${warn})` : ""}`
      : "";
    const waitNote = wait.starved && wait.since !== null ? ` · urgent work has waited ${Math.floor((now - wait.since) / 3600_000)} h ${Math.floor(((now - wait.since) % 3600_000) / 60_000)} min` : "";
    const unreadableNote = urgentUnreadable ? " · urgent: unreadable" : "";
    const why = `${plan.why}${laneNote}${waitNote}${unreadableNote}`;
    const next = plan.kind === "turbo" ? plan.next : plan.next + headroomNow;
    last = { applied, host: host.name, cur, next, why, signals, opencodeRunning: opencodeCount, headroom: headroomNow, urgent: tuning.urgentSlots > 0 ? urgentCount : null, urgentHeadroom: urgentShown, urgentSince: wait.since, urgentStarved: wait.starved, urgentUnreadable };
    if (apply) {
      await persistOverride();
      try {
        deps.appendLog({ t: new Date(now).toISOString(), host: host.name, cur, next, applied, why, load: signals.loadRatio, fiveHourUsed: signals.fiveHourUsed, fiveHourElapsed: signals.fiveHourElapsed, weekUsed: signals.weekUsed, weekElapsed: signals.weekElapsed, memory: { swapUsedPct: memory.swapUsedPct, freePct: memory.freePct, pageoutsPerSec: memory.pageoutsPerSec }, override, turbo: plan.kind === "turbo", opencodeRunning: opencodeCount, headroom: headroomNow, ...(tuning.urgentSlots > 0 ? { urgentRunning: urgentCount?.running ?? null, urgentWaiting: urgentCount?.waiting ?? null, urgentHeadroom: urgentShown, ...(urgentUnreadable ? { urgentUnreadable: true } : {}) } : {}) });
      } catch (e) { deps.warn(`decision log not written: ${String(e)}`); }
    }
    return last;
  }

  return {
    tick,
    startTurboFrom,
    endTurbo,
    state: () => ({ override, turbo, headroom, urgentHeadroom: Math.min(urgentLane, headroom), urgentSince: waitSince }),
    last: () => last,
    setLastError: (error: string) => { last = { ...(last as Tick), error }; },
  };
}
