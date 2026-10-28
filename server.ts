// bb-plugin-concurrency-coach: every 5 minutes, step the host thread limit up or down from CPU load and Claude plan quota pace. No model calls. Turbo holds a chosen limit for a time box; it is set from the CLI or the panel.
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { parseUsage, type Signals } from "./lib/policy.ts";
import { getLimits, getUsage, opencodeRunning, readMemory, urgentCount, restoreLimits, setHostLimit, type HostCfg, type LimitCfg } from "./lib/io.ts";
import { memoryHot } from "./lib/memory.ts";
import { tuningFrom } from "./lib/tuning.ts";
import { weekProjected } from "./lib/policy.ts";
import { appendDecision, formatDecision, logFile, readDecisions, type TurboEvent } from "./lib/decision-log.ts";
import { history, lastDecision, loadLevel, paceState, reasonSentence, topCpuName, weekPaceState } from "./lib/panel.ts";
import { createExecutor, type Tick } from "./lib/executor.ts";
import {
  parseTurbo, quotaNear, raisesCap, startTurbo, turboCapRestore, turboEndReason, turboMemoryEndReason, turboSentence, turboStartBlock, turboStep, turboSuggested,
  TURBO_DEFAULT_MS, TURBO_MAX_LIMIT, TURBO_MAX_MS, type Turbo,
} from "./lib/turbo.ts";
import { coachRpcContract, type PanelView, type TurboView } from "./lib/contract.ts";
import { parseTurboChoices, type TurboChoice } from "./lib/turbo-choices.ts";
import { turboCli } from "./lib/turbo-cli.ts";
import { explainLimit } from "./lib/explain.ts";
import { createFleet, type HostResult } from "./lib/fleet-runner.ts";
import { fleetMode, parseHostLimits, profileFor } from "./lib/fleet.ts";
import { hostContract } from "./lib/host-contract.ts";

const execFileP = promisify(execFile);

/** Used projected to the reset at the current rate, in percent; null without a usable elapsed share (the same floor as the policy). */
const projectedOf = (used: number | null, elapsed: number | null): number | null => (used === null || elapsed === null ? null : weekProjected(used, elapsed));

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    enabled: { type: "boolean", label: "Adjust the limit automatically", default: true },
    host: { type: "string", label: "Host name (blank = the only connected host)", default: "" },
    minLimit: { type: "number", label: "Minimum threads", default: 2 },
    maxLimit: { type: "number", label: "Maximum threads", default: 8 },
    overrideBackoffMinutes: { type: "number", label: "Back off this many minutes after a manual limit change", default: 120 },
    swapHotPercent: { type: "number", label: "Swap used (percent) that counts as memory pressure", default: 70 },
    memFreeMinPercent: { type: "number", label: "Free memory (percent) below which memory counts as pressure", default: 15 },
    // The policy tunables. Each default is the value the plugin shipped with.
    hotLoad: { type: "number", label: "CPU load per core above which the limit steps down", default: 0.85 },
    idleLoad: { type: "number", label: "CPU load per core below which the limit steps up", default: 0.5 },
    quotaFiveHourNear: { type: "number", label: "5-hour use (percent) at which the limit drops to the minimum", default: 92 },
    quotaWeekNear: { type: "number", label: "Weekly use (percent) at which the limit drops to the minimum", default: 90 },
    slackFiveHour: { type: "number", label: "5-hour use may run this many points ahead of time elapsed", default: 25 },
    slackWeek: { type: "number", label: "Weekly use may run this many points ahead of time elapsed", default: 6 },
    raiseSlackWeek: { type: "number", label: "Weekly use points ahead of time elapsed that hold raising", default: 3 },
    pageoutHotPerSec: { type: "number", label: "Page-outs per second that count as thrashing (with swap)", default: 100 },
    opencodeSlots: { type: "number", label: "opencode threads that get one slot of headroom each (0 turns it off)", default: 1 },
    opencodeCountsAgainstLimit: { type: "boolean", label: "opencode threads take Claude capacity (no headroom)", default: false },
    // Turbo: the duration buttons, and the swap line that ends it.
    turboChoices: { type: "string", label: "Turbo duration buttons, in minutes, comma separated (up to 6, each 1 to 720)", default: "30,60,120" },
    turboAllowUntilOff: { type: "boolean", label: "Offer Turbo \"until off\" (no time box)", default: true },
    turboSwapEndPercent: { type: "number", label: "Extra: swap used (percent) at which Turbo ends, on top of memory pressure (0 = off; otherwise 50 to 100)", default: 0 },
    // The urgent lane: threads whose task has priority urgent get reserved slots above the paced limit.
    urgentSlots: { type: "number", label: "Slots reserved above the paced limit for urgent threads (0 turns the lane off; up to 5)", default: 1 },
    urgentReportMinutes: { type: "number", label: "Minutes urgent work may wait before the panel and log flag it (0 = never)", default: 120 },
    // Several hosts: each host's own range. Used when the host setting is blank and more than one host is connected.
    hostLimits: { type: "string", label: "Per-host limit ranges when every connected host is managed, such as macstudio:2-12,macmini:1-6 (hosts not listed use the minimum and maximum above)", default: "" },
  });

  // The executor holds the back-off and Turbo (kept in plugin storage) and carries out each tick. See lib/executor.ts.
  const exec = await createExecutor({
    settings: () => settings.get(),
    limits: { get: getLimits, set: setHostLimit, restore: restoreLimits },
    usage: getUsage,
    opencodeRunning,
    urgent: urgentCount,
    memory: readMemory,
    load: () => ({ load1: os.loadavg()[0], cpus: os.cpus().length || 1 }),
    now: () => Date.now(),
    store: { get: (key) => bb.storage.kv.get(key), set: (key, value) => bb.storage.kv.set(key, value), delete: (key) => bb.storage.kv.delete(key) },
    appendLog: (line) => appendDecision(logFile(), line),
    warn: (message) => bb.log.warn(message),
  });

  // Every connected host, when the host setting is blank and more than one is connected: one executor per host on that host's own readings (the host entry), kept apart from the single-host state.
  const hostClient = bb.hosts.experimental_client({ contract: hostContract });
  const fleet = await createFleet({
    settings: () => settings.get(),
    limits: { get: getLimits, set: setHostLimit, restore: restoreLimits },
    usage: getUsage,
    readings: (hostId) => hostClient.call("readings", null, { hostId, timeoutMs: 30_000 }),
    now: () => Date.now(),
    store: { get: (key) => bb.storage.kv.get(key), set: (key, value) => bb.storage.kv.set(key, value), delete: (key) => bb.storage.kv.delete(key) },
    appendLog: (l) => appendDecision(logFile(), l),
    warn: (message) => bb.log.warn(message),
    // A Turbo started in single-host mode is never ticked once fleet mode runs: end it first, which also restores the overall cap it raised.
    beforeRound: async () => { await exec.endTurbo("scheduler", "fleet mode started: Turbo is single-host"); },
  });
  /** Fleet mode now? An unreadable limit configuration is left to the single-host path, which reports it. */
  async function inFleetMode(): Promise<boolean> {
    try {
      const s = await settings.get();
      const cfg = await getLimits();
      return fleetMode(s.host, cfg.hosts.filter((h) => h.status === "connected").length);
    } catch { return false; }
  }

  const line = (t: Tick) =>
    `${t.host}: ${t.cur} -> ${t.next}${t.applied ? " (applied)" : t.next === t.cur ? "" : " (dry run)"}  ${t.why}\n` +
    `load/cpu ${t.signals.loadRatio.toFixed(2)}  free memory ${t.signals.memory?.reading.freePct ?? "?"}%  swap ${t.signals.memory?.reading.swapUsedPct ?? "?"}%  paging out ${t.signals.memory?.reading.pageoutsPerSec ?? "?"}/s  5h ${t.signals.fiveHourUsed ?? "?"}% (${t.signals.fiveHourElapsed ?? "?"}% elapsed)  week ${t.signals.weekUsed ?? "?"}%`;

  /** Turbo as the panel and RPC see it. Ends it on the same rules as the scheduler, without writing. */
  function turboView(turbo: Turbo | null, now: number, weekResetsAt: number | null, near: boolean, manual: boolean, memoryReason: string | null, choices: TurboChoice[], memoryEndPercent: number): TurboView {
    const active = turbo !== null && turboEndReason(turbo, now, weekResetsAt, near, manual, memoryReason) === null ? turbo : null;
    return {
      active: active !== null,
      limit: active?.limit ?? null,
      until: active !== null && !active.untilOff ? new Date(active.until).toISOString() : null,
      startedBy: active?.by ?? null,
      suggested: false,
      untilOff: active !== null && active.untilOff,
      choices,
      memoryEndPercent,
      // A start now would end at once, so the buttons are held back with this reason.
      blockedReason: active === null ? turboStartBlock(now, weekResetsAt, near, memoryReason) : null,
    };
  }
  /** The Turbo duration buttons from the settings. */
  async function turboChoices(): Promise<TurboChoice[]> {
    const s = await settings.get();
    return parseTurboChoices(s.turboChoices, s.turboAllowUntilOff);
  }

  /** One line per host for the CLI: the tick, or why the host was not stepped. */
  const fleetLines = (results: HostResult[]) =>
    results.length === 0 ? "no connected hosts" : results.map((r) => (r.tick !== null ? line(r.tick) : `${r.host}: not stepped: ${r.error}`)).join("\n");

  bb.background.schedule("adjust", "*/5 * * * *", async () => {
    if (!(await settings.get()).enabled) return;
    if (await inFleetMode()) {
      const results = await fleet.round(true);
      // The round carries on past a host it cannot read; it fails only when no host could be stepped.
      if (results.length > 0 && results.every((r) => r.error !== null)) throw new Error(`no host could be stepped: ${results.map((r) => `${r.host}: ${r.error}`).join("; ")}`);
      return;
    }
    try { await exec.tick(true); } catch (e) { exec.setLastError(String(e)); throw e; }
  });

  /** Read-only snapshot for the panel. Reads the same sources the scheduler reads; changes nothing. */
  async function panel(): Promise<PanelView> {
    const s = await settings.get();
    const tuning = tuningFrom(s);
    const now = Date.now();
    const min = Math.max(1, Math.floor(s.minLimit)), max = Math.max(min, Math.floor(s.maxLimit));
    const loadRatio = os.loadavg()[0] / (os.cpus().length || 1);
    let error: string | null = null;
    let host: string | null = null;
    let current: number | null = null;
    let globalLimit: number | null = null;
    let panelCfg: LimitCfg | null = null;
    try {
      const cfg = await getLimits();
      panelCfg = cfg;
      globalLimit = cfg.globalLimit;
      const connected = cfg.hosts.filter((h) => h.status === "connected");
      const h = s.host ? connected.find((x) => x.name === s.host || x.id === s.host) : connected.length === 1 ? connected[0] : undefined;
      if (h) { host = h.name; current = h.effectiveLimit; }
    } catch (e) { error = String(e); }
    let usage: ReturnType<typeof parseUsage> = { fiveHourUsed: null, fiveHourElapsed: null, weekUsed: null, weekElapsed: null, weekResetsAt: null };
    try { usage = parseUsage(await getUsage(), now); } catch { /* quota unknown */ }
    // Running = threads occupying a slot now (starting or active, hidden included), uncapped. Queued = queued messages the concurrency limit is holding (the limit exposes no count of its own).
    let running: number | null = null;
    let queued: number | null = null;
    let gaveUp: number | null = null;
    try {
      running = (await bb.sdk.threads.listRunning()).length;
    } catch { /* thread count unavailable */ }
    try {
      const held = await bb.sdk.threads.queue.list({ waitHolder: "plugin:concurrency-limit" });
      queued = held.filter((r) => r.state === "waiting" || r.state === "failed_retrying").length;
      gaveUp = held.filter((r) => r.state === "failed_exhausted").length;
    } catch { /* queue unavailable */ }
    const records = readDecisions(logFile(), 2000);
    const last = lastDecision(records);
    const near = quotaNear({ weekUsed: usage.weekUsed, fiveHourUsed: usage.fiveHourUsed }, tuning);
    const { override, turbo } = exec.state();
    const manual = turbo !== null && current !== null && turboStep(override.lastSet, current, turbo.limit).kind === "manual";
    // Fast read for the panel: swap and free memory now, and the paging rate from the last tick (null until a tick has run since the plugin loaded).
    const fresh = await readMemory({ paging: false });
    const memory = { ...fresh, pageoutsPerSec: exec.last()?.signals.memory?.reading.pageoutsPerSec ?? null };
    const fleetOn = panelCfg !== null && fleetMode(s.host, panelCfg.hosts.filter((h) => h.status === "connected").length);
    const turboNow = turboView(turbo, now, usage.weekResetsAt, near, manual, turboMemoryEndReason(memory, { swapHotPercent: s.swapHotPercent, memFreeMinPercent: s.memFreeMinPercent, pageoutHotPerSec: tuning.pageoutHotPerSec }, tuning.turboSwapEndPercent), parseTurboChoices(s.turboChoices, s.turboAllowUntilOff), tuning.turboSwapEndPercent);
    turboNow.suggested = !turboNow.active && turboSuggested(usage.weekUsed, usage.weekElapsed, usage.weekResetsAt, now);
    // Turbo holds one host's limit; with every host managed there is no single host to hold, so the buttons are held back with the reason.
    if (fleetOn && !turboNow.active) turboNow.blockedReason = "Turbo is single-host: set the host setting to one host";
    let topCpu: PanelView["topCpu"] = null;
    try {
      // The full process list is ~220 KB and grows with the machine; a small buffer made the call fail and the panel show "Not available".
      const { stdout } = await execFileP("ps", ["-Ao", "pcpu,comm", "-r"], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 });
      topCpu = topCpuName(stdout);
    } catch { /* process list unavailable */ }
    // What limits the limit now: the same signals the scheduler reads, against Claude's own limit (the host limit without the opencode headroom).
    const claudeNow = current === null ? min : current - exec.state().headroom;
    const explainSingle = explainLimit(
      { cur: claudeNow, min, max, loadRatio, ...usage, memory: { reading: memory, thresholds: { swapHotPercent: s.swapHotPercent, memFreeMinPercent: s.memFreeMinPercent, pageoutHotPerSec: tuning.pageoutHotPerSec } }, tuning },
      turboNow.active,
    );
    const hostCount = panelCfg === null ? 0 : panelCfg.hosts.filter((h) => h.status === "connected").length;
    const explain = fleetOn ? { cause: "none" as const, line: `Managing ${hostCount} hosts, each on its own load and memory; one host takes the quota pace step each round.` } : explainSingle;
    // Every connected host with its range and its last tick, when all are managed.
    let fleetView: PanelView["fleet"] = null;
    if (fleetOn && panelCfg !== null) {
      const profiles = parseHostLimits(s.hostLimits);
      const results = new Map(fleet.last().map((r) => [r.hostId, r]));
      fleetView = {
        hosts: panelCfg.hosts.filter((h) => h.status === "connected").map((h) => {
          const profile = profileFor(h.name, profiles, { min, max });
          const r = results.get(h.id);
          const sig = r?.tick?.signals;
          return {
            name: h.name,
            current: h.effectiveLimit,
            min: profile.min,
            max: profile.max,
            load: sig?.loadRatio ?? null,
            freePct: sig?.memory?.reading.freePct ?? null,
            swapUsedPct: sig?.memory?.reading.swapUsedPct ?? null,
            why: r?.tick?.why ?? null,
            error: r?.error ?? null,
          };
        }),
      };
    }
    const backingOff = override.pausedUntil > now;
    const activeTurbo = turboNow.active && turbo !== null ? turbo : null;
    return {
      generatedAt: now,
      host,
      error,
      limit: {
        current,
        min,
        max,
        globalLimit,
        claude: current === null ? null : current - exec.state().headroom,
        opencode: {
          // The opencode part of the headroom: the total less the urgent lane's slots.
          headroom: exec.state().headroom - exec.state().urgentHeadroom,
          running: exec.last()?.opencodeRunning ?? null,
          slots: tuning.opencodeSlots,
          countsAgainstLimit: s.opencodeCountsAgainstLimit === true,
          warning: (exec.last()?.opencodeRunning ?? 0) > tuning.opencodeSlots && tuning.opencodeSlots > 0 && s.opencodeCountsAgainstLimit !== true
            ? `${exec.last()?.opencodeRunning} opencode threads running; ${tuning.opencodeSlots} slot${tuning.opencodeSlots === 1 ? "" : "s"}. The extra use Claude capacity.`
            : null,
        },
        urgent: {
          slots: tuning.urgentSlots,
          headroom: exec.state().urgentHeadroom,
          running: exec.last()?.urgent?.running ?? null,
          waiting: exec.last()?.urgent?.waiting ?? null,
          waitingSince: exec.state().urgentSince === null ? null : new Date(exec.state().urgentSince as number).toISOString(),
          starved: exec.last()?.urgentStarved ?? false,
          reportMinutes: tuning.urgentReportMinutes,
          unreadable: exec.last()?.urgentUnreadable ?? false,
        },
      },
      threads: { running, queued, gaveUp },
      why: {
        sentence: activeTurbo !== null ? turboSentence(activeTurbo) : reasonSentence(last, override.pausedUntil, now),
        decidedAt: last?.decidedAt ?? null,
        backingOff,
        backOffMinutesLeft: backingOff ? Math.ceil((override.pausedUntil - now) / 60_000) : 0,
        explain,
        detail: last === null ? null : {
          applied: last.record.applied,
          cur: last.record.cur,
          next: last.record.next,
          load: last.record.load ?? null,
          fiveHour: { used: last.record.fiveHourUsed ?? null, elapsed: last.record.fiveHourElapsed ?? null },
          week: { used: last.record.weekUsed ?? null, elapsed: last.record.weekElapsed ?? null },
          memory: last.record.memory ?? null,
        },
      },
      turbo: turboNow,
      inputs: {
        load: { ratio: loadRatio, level: loadLevel(loadRatio, tuning), idle: tuning.idleLoad, hot: tuning.hotLoad },
        memory: { swapUsedPct: memory.swapUsedPct, freePct: memory.freePct, pageoutsPerSec: memory.pageoutsPerSec, hot: memoryHot(memory, { swapHotPercent: s.swapHotPercent, memFreeMinPercent: s.memFreeMinPercent, pageoutHotPerSec: tuning.pageoutHotPerSec }), swapHotPercent: s.swapHotPercent, memFreeMinPercent: s.memFreeMinPercent },
        fiveHour: { used: usage.fiveHourUsed, elapsed: usage.fiveHourElapsed, projected: projectedOf(usage.fiveHourUsed, usage.fiveHourElapsed), state: paceState(usage.fiveHourUsed, usage.fiveHourElapsed, tuning.slackFiveHour) },
        week: { used: usage.weekUsed, elapsed: usage.weekElapsed, projected: projectedOf(usage.weekUsed, usage.weekElapsed), state: weekPaceState(usage.weekUsed, usage.weekElapsed, tuning.slackWeek) },
      },
      history: history(records, now, 24 * 3600_000),
      topCpu,
      fleet: fleetView,
    };
  }

  bb.rpc.register(coachRpcContract, {
    panel,
    turboStart: async ({ limit, minutes, untilOff }) => {
      const s = await settings.get();
      if (untilOff === true && s.turboAllowUntilOff === false) throw new Error("Turbo until off is turned off in the settings");
      await exec.startTurboFrom("panel", limit ?? undefined, untilOff === true ? null : minutes === null ? undefined : minutes * 60_000);
      return turboView(exec.state().turbo, Date.now(), null, false, false, null, await turboChoices(), tuningFrom(s).turboSwapEndPercent);
    },
    turboStop: async () => {
      await exec.endTurbo("panel", "turned off from the panel");
      const s = await settings.get();
      return turboView(exec.state().turbo, Date.now(), null, false, false, null, await turboChoices(), tuningFrom(s).turboSwapEndPercent);
    },
  });

  bb.cli.register(
    defineCli({
      name: "concurrency-coach",
      summary: "Scale the host thread limit from CPU load and Claude quota use",
      commands: {
        status: cliCommand({
          summary: "Show what Concurrency Coach would do now (changes nothing)",
          options: { json: { type: "boolean", description: "Print JSON" } },
          async run(input) {
            if (await inFleetMode()) {
              const results = await fleet.round(false);
              return { exitCode: 0, stdout: input.options.json ? JSON.stringify({ hosts: results.map((r) => ({ host: r.host, error: r.error, tick: r.tick })), lastScheduled: fleet.last().map((r) => ({ host: r.host, tick: r.tick, error: r.error })) }, null, 2) : fleetLines(results) };
            }
            const t = await exec.tick(false);
            return { exitCode: 0, stdout: input.options.json ? JSON.stringify({ ...t, lastScheduled: exec.last() }, null, 2) : line(t) };
          },
        }),
        tick: cliCommand({
          summary: "Run one adjustment now and apply it",
          async run() {
            if (await inFleetMode()) return { exitCode: 0, stdout: fleetLines(await fleet.round(true)) };
            return { exitCode: 0, stdout: line(await exec.tick(true)) };
          },
        }),
        turbo: turboCli({
          startTurboFrom: (by, limit, durationMs) => exec.startTurboFrom(by, limit, durationMs),
          endTurbo: (by, reason) => exec.endTurbo(by, reason),
          allowUntilOff: async () => (await settings.get()).turboAllowUntilOff !== false,
          cores: os.cpus().length,
        }),
        log: cliCommand({
          summary: "Show the most recent logged decisions and Turbo events, oldest first",
          options: { last: { type: "integer", min: 1, max: 500, default: 20, description: "How many entries to show" } },
          async run(input) {
            const rows = readDecisions(logFile(), input.options.last ?? 20);
            return { exitCode: 0, stdout: rows.length ? rows.map(formatDecision).join("\n") : "no decisions logged yet" };
          },
        }),
      },
    }),
  );
}
