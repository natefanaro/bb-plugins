// The urgent lane: threads whose task has priority urgent get one reserved slot above Claude's paced limit, so a pace hold never starves a release blocker.
// Pure. The executor adds this headroom to the host limit the same way it adds the opencode headroom.

/** Thread ids attached to tasks, from `bb tasks show --json` outputs (`taskThreads[].threadId`). Rows that are not shaped as expected are skipped. */
export function urgentThreadIds(shows: unknown[]): Set<string> {
  const ids = new Set<string>();
  for (const show of shows) {
    const rows = (show as { taskThreads?: unknown } | null)?.taskThreads;
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      const id = (r as { threadId?: unknown } | null)?.threadId;
      if (typeof id === "string" && id.startsWith("thr_")) ids.add(id);
    }
  }
  return ids;
}

export interface UrgentCount {
  /** Urgent threads running now. */
  running: number;
  /** Urgent threads waiting behind the limit (queued, not yet running). */
  waiting: number;
}

/**
 * Urgent threads in an `agent-tv status --json` feed: rows whose id is in `urgent` and that are busy (running) or queued (status pending or queued, busy false: waiting behind the limit).
 * Idle rows and rows not shaped as expected are not counted.
 */
export function countUrgent(feed: unknown, urgent: Set<string>): UrgentCount {
  const rows = (feed as { rows?: unknown } | null)?.rows;
  const out: UrgentCount = { running: 0, waiting: 0 };
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    if (typeof r !== "object" || r === null) continue;
    const row = r as { id?: unknown; busy?: unknown; status?: unknown };
    if (typeof row.id !== "string" || !urgent.has(row.id)) continue;
    if (row.busy === true) out.running++;
    else if (row.status === "pending" || row.status === "queued") out.waiting++;
  }
  return out;
}

export interface UrgentInput {
  /** Urgent threads now, or null when they could not be read. */
  count: UrgentCount | null;
  /** The urgentSlots setting. 0 turns the lane off. */
  slots: number;
  /** The urgent headroom in effect on the host now. Kept when the count is unknown. */
  previous: number;
}

/** One slot per urgent thread that is running or waiting, up to the slots. An unknown count keeps what is in effect (within the slots). */
export function urgentHeadroom(i: UrgentInput): number {
  if (i.slots <= 0) return 0;
  if (i.count === null) return Math.min(i.previous, i.slots);
  return Math.min(i.count.running + i.count.waiting, i.slots);
}

export interface UrgentWait {
  /** Epoch ms since urgent work has been waiting without a break, or null when none waits. */
  since: number | null;
  /** True when it has waited at least `reportMs`. */
  starved: boolean;
}

/** How long urgent work has been waiting. An unknown count keeps the clock as it was; no waiting work clears it. `reportMs` of 0 never flags. */
export function urgentWait(count: UrgentCount | null, now: number, since: number | null, reportMs: number): UrgentWait {
  const next = count === null ? since : count.waiting > 0 ? (since ?? now) : null;
  return { since: next, starved: reportMs > 0 && next !== null && now - next >= reportMs };
}

/** The stored wait start: a finite number or none. */
export function parseWaitSince(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;
}
