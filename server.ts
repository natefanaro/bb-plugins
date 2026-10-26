// bb-plugin-concurrency-coach: every 5 minutes, step the host thread limit up or down from CPU load and Claude plan quota pace. No model calls. Turbo holds a chosen limit for a time box; it is set from the CLI or the panel.
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { parseUsage, type Signals } from "./lib/policy.ts";
import { getLimits, getUsage, readMemory, restoreLimits, setHostLimit, type HostCfg, type LimitCfg } from "./lib/io.ts";
import { memoryHot } from "./lib/memory.ts";
import { appendDecision, formatDecision, logFile, readDecisions, type TurboEvent } from "./lib/decision-log.ts";
import { history, lastDecision, loadLevel, paceState, reasonSentence, topCpuName, weekPaceState } from "./lib/panel.ts";
import { createExecutor, type Tick } from "./lib/executor.ts";
import {
  parseTurbo, quotaNear, raisesCap, startTurbo, turboCapRestore, turboEndReason, turboSentence, turboStep, turboSuggested,
  TURBO_DEFAULT_MS, TURBO_MAX_LIMIT, TURBO_MAX_MS, type Turbo,
} from "./lib/turbo.ts";
import { coachRpcContract, type PanelView, type TurboView } from "./lib/contract.ts";

const execFileP = promisify(execFile);

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    enabled: { type: "boolean", label: "Adjust the limit automatically", default: true },
    host: { type: "string", label: "Host name (blank = the only connected host)", default: "" },
    minLimit: { type: "number", label: "Minimum threads", default: 2 },
    maxLimit: { type: "number", label: "Maximum threads", default: 8 },
    overrideBackoffMinutes: { type: "number", label: "Back off this many minutes after a manual limit change", default: 120 },
    swapHotPercent: { type: "number", label: "Swap used (percent) that counts as memory pressure", default: 70 },
    memFreeMinPercent: { type: "number", label: "Free memory (percent) below which memory counts as pressure", default: 15 },
  });

  // The executor holds the back-off and Turbo (kept in plugin storage) and carries out each tick. See lib/executor.ts.
  const exec = await createExecutor({
    settings: () => settings.get(),
    limits: { get: getLimits, set: setHostLimit, restore: restoreLimits },
    usage: getUsage,
    memory: readMemory,
    load: () => ({ load1: os.loadavg()[0], cpus: os.cpus().length || 1 }),
    now: () => Date.now(),
    store: { get: (key) => bb.storage.kv.get(key), set: (key, value) => bb.storage.kv.set(key, value), delete: (key) => bb.storage.kv.delete(key) },
    appendLog: (line) => appendDecision(logFile(), line),
    warn: (message) => bb.log.warn(message),
  });

  const line = (t: Tick) =>
    `${t.host}: ${t.cur} -> ${t.next}${t.applied ? " (applied)" : t.next === t.cur ? "" : " (dry run)"}  ${t.why}\n` +
    `load/cpu ${t.signals.loadRatio.toFixed(2)}  free memory ${t.signals.memory?.reading.freePct ?? "?"}%  swap ${t.signals.memory?.reading.swapUsedPct ?? "?"}%  paging out ${t.signals.memory?.reading.pageoutsPerSec ?? "?"}/s  5h ${t.signals.fiveHourUsed ?? "?"}% (${t.signals.fiveHourElapsed ?? "?"}% elapsed)  week ${t.signals.weekUsed ?? "?"}%`;

  /** Turbo as the panel and RPC see it. Ends it on the same rules as the scheduler, without writing. */
  function turboView(turbo: Turbo | null, now: number, weekResetsAt: number | null, near: boolean, manual: boolean): TurboView {
    const active = turbo !== null && turboEndReason(turbo, now, weekResetsAt, near, manual) === null ? turbo : null;
    return {
      active: active !== null,
      limit: active?.limit ?? null,
      until: active ? new Date(active.until).toISOString() : null,
      startedBy: active?.by ?? null,
      suggested: false,
    };
  }

  bb.background.schedule("adjust", "*/5 * * * *", async () => {
    if (!(await settings.get()).enabled) return;
    try { await exec.tick(true); } catch (e) { exec.setLastError(String(e)); throw e; }
  });

  /** Read-only snapshot for the panel. Reads the same sources the scheduler reads; changes nothing. */
  async function panel(): Promise<PanelView> {
    const s = await settings.get();
    const now = Date.now();
    const min = Math.max(1, Math.floor(s.minLimit)), max = Math.max(min, Math.floor(s.maxLimit));
    const loadRatio = os.loadavg()[0] / (os.cpus().length || 1);
    let error: string | null = null;
    let host: string | null = null;
    let current: number | null = null;
    let globalLimit: number | null = null;
    try {
      const cfg = await getLimits();
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
    const near = quotaNear({ weekUsed: usage.weekUsed, fiveHourUsed: usage.fiveHourUsed });
    const { override, turbo } = exec.state();
    const manual = turbo !== null && current !== null && turboStep(override.lastSet, current, turbo.limit).kind === "manual";
    const turboNow = turboView(turbo, now, usage.weekResetsAt, near, manual);
    turboNow.suggested = !turboNow.active && turboSuggested(usage.weekUsed, usage.weekElapsed, usage.weekResetsAt, now);
    let topCpu: PanelView["topCpu"] = null;
    try {
      // The full process list is ~220 KB and grows with the machine; a small buffer made the call fail and the panel show "Not available".
      const { stdout } = await execFileP("ps", ["-Ao", "pcpu,comm", "-r"], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 });
      topCpu = topCpuName(stdout);
    } catch { /* process list unavailable */ }
    // Fast read for the panel: swap and free memory now, and the paging rate from the last tick (null until a tick has run since the plugin loaded).
    const fresh = await readMemory({ paging: false });
    const memory = { ...fresh, pageoutsPerSec: exec.last()?.signals.memory?.reading.pageoutsPerSec ?? null };
    const backingOff = override.pausedUntil > now;
    const activeTurbo = turboNow.active && turbo !== null ? turbo : null;
    return {
      generatedAt: now,
      host,
      error,
      limit: { current, min, max, globalLimit },
      threads: { running, queued, gaveUp },
      why: {
        sentence: activeTurbo !== null ? turboSentence(activeTurbo) : reasonSentence(last, override.pausedUntil, now),
        decidedAt: last?.decidedAt ?? null,
        backingOff,
        backOffMinutesLeft: backingOff ? Math.ceil((override.pausedUntil - now) / 60_000) : 0,
      },
      turbo: turboNow,
      inputs: {
        load: { ratio: loadRatio, level: loadLevel(loadRatio) },
        memory: { swapUsedPct: memory.swapUsedPct, freePct: memory.freePct, pageoutsPerSec: memory.pageoutsPerSec, hot: memoryHot(memory, { swapHotPercent: s.swapHotPercent, memFreeMinPercent: s.memFreeMinPercent }), swapHotPercent: s.swapHotPercent, memFreeMinPercent: s.memFreeMinPercent },
        fiveHour: { used: usage.fiveHourUsed, elapsed: usage.fiveHourElapsed, state: paceState(usage.fiveHourUsed, usage.fiveHourElapsed) },
        week: { used: usage.weekUsed, elapsed: usage.weekElapsed, state: weekPaceState(usage.weekUsed, usage.weekElapsed) },
      },
      history: history(records, now, 24 * 3600_000),
      topCpu,
    };
  }

  bb.rpc.register(coachRpcContract, {
    panel,
    turboStart: async ({ limit, minutes }) => {
      await exec.startTurboFrom("panel", limit ?? undefined, minutes === null ? undefined : minutes * 60_000);
      return turboView(exec.state().turbo, Date.now(), null, false, false);
    },
    turboStop: async () => {
      await exec.endTurbo("panel", "turned off from the panel");
      return turboView(exec.state().turbo, Date.now(), null, false, false);
    },
  });

  bb.cli.register(
    defineCli({
      name: "concurrency-coach",
      summary: "Scale the host thread limit from CPU load and Claude quota pace",
      commands: {
        status: cliCommand({
          summary: "Show what Concurrency Coach would do now (changes nothing)",
          options: { json: { type: "boolean", description: "Print JSON" } },
          async run(input) {
            const t = await exec.tick(false);
            return { exitCode: 0, stdout: input.options.json ? JSON.stringify({ ...t, lastScheduled: exec.last() }, null, 2) : line(t) };
          },
        }),
        tick: cliCommand({
          summary: "Run one adjustment now and apply it",
          async run() {
            return { exitCode: 0, stdout: line(await exec.tick(true)) };
          },
        }),
        turbo: cliCommand({
          summary: "Hold a chosen limit for a time box (default maxLimit for 2h), or `turbo off` to end it",
          description: "Turbo writes the limit at once and ignores the CPU-hot rule. A manual limit change ends it. If the limit is above the overall cap, the cap is raised until Turbo ends. A limit above maxLimit, or above the core count, runs more threads than usual.",
          positionals: [{ name: "action", description: "off ends Turbo", required: false }],
          options: {
            limit: { type: "integer", min: 1, max: TURBO_MAX_LIMIT, description: `Limit to hold (default maxLimit). Above maxLimit or the core count runs more threads than usual; the most is ${TURBO_MAX_LIMIT}` },
            for: { type: "duration", defaultUnit: "h", min: 60_000, max: TURBO_MAX_MS, default: TURBO_DEFAULT_MS, description: "How long Turbo runs, e.g. 2h or 90m (default 2h, most 12h)" },
          },
          async run(input) {
            if (input.positionals.action === "off") {
              const ended = await exec.endTurbo("cli", "turned off from the CLI");
              return { exitCode: 0, stdout: ended ? "Turbo off." : "Turbo was not on." };
            }
            if (input.positionals.action !== undefined) {
              return { exitCode: 1, stderr: "Usage:\n  bb concurrency-coach turbo [--limit N] [--for 2h]\n  bb concurrency-coach turbo off" };
            }
            const { turbo: t, capRaised } = await exec.startTurboFrom("cli", input.options.limit, input.options.for);
            const notes = [
              capRaised ? `The overall cap is raised from ${t.globalBefore ?? "none"} until Turbo ends.` : "",
              t.limit > os.cpus().length ? `The limit is above the ${os.cpus().length} cores: more threads than cores.` : "",
              "It ends early at the weekly reset, if the quota nears its cap, or on a manual limit change.",
            ].filter((n) => n !== "");
            return { exitCode: 0, stdout: [turboSentence(t), ...notes].join(" ") };
          },
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
