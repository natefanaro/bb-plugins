// Reads which threads belong to urgent tasks, from the tasks tracker. Pure apart from the `run` it is given, so tests can fake the CLI.
import { urgentThreadIds } from "./urgent.ts";

/** Variables that scope `bb` to the calling thread's project. A plugin read must see every tracker project, so they are removed from the child's environment (`BB_CLI` and the server address stay). */
const SCOPE_VARS = ["BB_PROJECT_ID", "BB_THREAD_ID", "BB_ENVIRONMENT_ID", "BB_THREAD_STORAGE"];

/** The environment for a `bb tasks` child: the same, without the project scope. With it, `bb tasks list` fails with project_ambiguous when the project links several trackers. */
export function unscopedEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out = { ...env };
  for (const k of SCOPE_VARS) delete out[k];
  return out;
}

export interface UrgentReaderOptions {
  /** Run `bb <args>` and return stdout. Throws on a failure. */
  run(args: string[]): Promise<string>;
  now(): number;
  /** How long the urgent thread map is reused. A thread attached to an urgent task is picked up within this time. */
  ttlMs: number;
  /** How long an older map is still used when a refresh fails. Beyond it the read fails. */
  staleMs: number;
  /** Open urgent tasks examined, at most. */
  maxTasks: number;
  /** `bb tasks show` calls at once. */
  concurrency: number;
}

export const URGENT_READER_DEFAULTS = { ttlMs: 10 * 60_000, staleMs: 30 * 60_000, maxTasks: 40, concurrency: 5 };

/**
 * The urgent thread ids: threads attached to a task of priority urgent that is todo, in progress or in review.
 * `--active` is not used: it keeps only threads that are starting or working, and a thread waiting for a slot is neither, which is the case the lane is for.
 * The map is kept for `ttlMs`; if a refresh fails, a map up to `staleMs` old is used, and an older one makes the read fail.
 */
export function createUrgentReader(o: UrgentReaderOptions): () => Promise<Set<string>> {
  let cached: { at: number; ids: Set<string> } | null = null;

  async function scan(): Promise<Set<string>> {
    const list = JSON.parse(await o.run(["tasks", "list", "--priority", "urgent", "--status", "todo,in_progress,in_review", "--limit", String(o.maxTasks), "--json"])) as { tasks?: { key?: unknown }[] };
    const keys = (list.tasks ?? []).map((t) => t.key).filter((k): k is string => typeof k === "string").slice(0, o.maxTasks);
    const shows: unknown[] = [];
    for (let i = 0; i < keys.length; i += o.concurrency) {
      const chunk = keys.slice(i, i + o.concurrency);
      shows.push(...(await Promise.all(chunk.map(async (key) => JSON.parse(await o.run(["tasks", "show", key, "--json"]))))));
    }
    return urgentThreadIds(shows);
  }

  return async () => {
    const now = o.now();
    if (cached !== null && now - cached.at < o.ttlMs) return cached.ids;
    try {
      const ids = await scan();
      cached = { at: now, ids };
      return ids;
    } catch (e) {
      if (cached !== null && now - cached.at < o.staleMs) return cached.ids;
      throw e;
    }
  };
}
