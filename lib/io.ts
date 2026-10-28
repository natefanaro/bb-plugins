import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { countOpencodeRuns } from "./headroom.ts";
import { countUrgent, type UrgentCount } from "./urgent.ts";
import { createUrgentReader, unscopedEnv, URGENT_READER_DEFAULTS } from "./urgent-reader.ts";

const execFileP = promisify(execFile);
import { NO_MEMORY, PAGING_SAMPLE_SEC, parseFreePct, parsePageoutsPerSec, parseSwapUsage, type MemoryReading } from "./memory.ts";

const USAGE_INPUT = { force: false, machineIds: null, providerIds: ["claude-code"], maxAgeMs: 300_000 };

/** Call another plugin's RPC through the bb CLI (the same path `bb plugin rpc call` takes). */
export function rpc(pluginId: string, method: string, input: unknown, timeoutMs = 20_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-gov-"));
    const file = path.join(dir, "in.json");
    fs.writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
    execFile(process.env.BB_CLI || "bb", ["plugin", "rpc", "call", pluginId, method, "--input-file", file, "--json"], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      fs.rmSync(dir, { recursive: true, force: true });
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
  });
}

export interface HostCfg { id: string; name: string; status: string; effectiveLimit: number | null }
export interface LimitCfg { globalLimit: number | null; hostOverrides: { hostId: string; limit: number | null }[]; hosts: HostCfg[] }

export const getLimits = () => rpc("concurrency-limit", "getConfiguration", null) as Promise<LimitCfg>;
export const getUsage = () => rpc("bb--provider-usage", "getUsage", USAGE_INPUT);

/** Set one host's limit and keep the global cap from undercutting it. Other hosts' overrides are preserved. */
export async function setHostLimit(cfg: LimitCfg, hostId: string, limit: number): Promise<LimitCfg> {
  const overrides = cfg.hostOverrides.filter((o) => o.hostId !== hostId).concat({ hostId, limit });
  const globalLimit = cfg.globalLimit !== null && cfg.globalLimit < limit ? limit : cfg.globalLimit;
  return rpc("concurrency-limit", "setConfiguration", { globalLimit, hostOverrides: overrides }) as Promise<LimitCfg>;
}

/** Write the overall cap and the host overrides together. Used to put the cap back when Turbo ends; the cap may go down here. */
export async function restoreLimits(globalLimit: number | null, hostOverrides: { hostId: string; limit: number | null }[]): Promise<LimitCfg> {
  return rpc("concurrency-limit", "setConfiguration", { globalLimit, hostOverrides }) as Promise<LimitCfg>;
}

/** Swap and free memory from the Mac's own tools. Each reading is null when its command fails: the scheduler then scales on CPU and quota as before. */
export async function readMemory(opts: { paging: boolean } = { paging: true }): Promise<MemoryReading> {
  if (process.platform !== "darwin") return NO_MEMORY;
  const run = (cmd: string, args: string[], timeout = 3000) => new Promise<string | null>((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
  // vm_stat's second sample takes PAGING_SAMPLE_SEC seconds, so it gets a longer timeout.
  // The panel passes paging: false. Its five-second sample would make the page take that long to load; the panel shows the last tick's sample instead.
  const [swap, pressure, paging] = await Promise.all([
    run("sysctl", ["-n", "vm.swapusage"]),
    run("memory_pressure", []),
    opts.paging ? run("vm_stat", ["-c", "2", String(PAGING_SAMPLE_SEC)], (PAGING_SAMPLE_SEC + 5) * 1000) : Promise.resolve(null),
  ]);
  return {
    swapUsedPct: swap === null ? null : parseSwapUsage(swap),
    freePct: pressure === null ? null : parseFreePct(pressure),
    pageoutsPerSec: paging === null ? null : parsePageoutsPerSec(paging, PAGING_SAMPLE_SEC),
  };
}

const BB = () => process.env.BB_CLI || "bb";
let feedMemo: { at: number; value: unknown } | null = null;

/** The agent-tv feed across every project. Kept for ten seconds, so the opencode count and the urgent count in one tick make one call. Throws when it cannot be read. */
async function agentFeed(): Promise<unknown> {
  if (feedMemo !== null && Date.now() - feedMemo.at < 10_000) return feedMemo.value;
  const { stdout } = await execFileP(BB(), ["agent-tv", "status", "--all-projects", "--json"], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  const value = JSON.parse(stdout);
  feedMemo = { at: Date.now(), value };
  return value;
}

/** opencode runs now (busy or queued), from the agent-tv feed across every project. Throws when the feed cannot be read: the executor then keeps the headroom in effect. */
export async function opencodeRunning(): Promise<number> {
  return countOpencodeRuns(await agentFeed());
}

/** `bb` run for the tasks reads: without the calling thread's project scope, so every tracker project is seen. */
const urgentThreadMap = createUrgentReader({
  ...URGENT_READER_DEFAULTS,
  now: () => Date.now(),
  run: async (args) => (await execFileP(BB(), args, { timeout: 15_000, maxBuffer: 8 * 1024 * 1024, env: unscopedEnv(process.env) })).stdout,
});

/**
 * Urgent threads now: threads attached to a task of priority urgent that are running or waiting behind the limit, from the agent feed and the urgent thread map.
 * With no running or waiting thread there is nothing to look up. Throws when the feed or the tasks cannot be read: the executor then keeps the lane as it was and reports it unreadable.
 */
export async function urgentCount(): Promise<UrgentCount> {
  const feed = await agentFeed();
  const rows = ((feed as { rows?: unknown } | null)?.rows ?? []) as { id?: unknown; busy?: unknown; status?: unknown }[];
  const live = rows.some((r) => r !== null && typeof r === "object" && (r.busy === true || r.status === "pending" || r.status === "queued"));
  if (!live) return { running: 0, waiting: 0 };
  return countUrgent(feed, await urgentThreadMap());
}
