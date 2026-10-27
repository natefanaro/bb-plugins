// opencode headroom: each running opencode thread may add one slot to the host limit, up to opencodeSlots, so it does not take Claude capacity.
// Pure. The executor keeps Claude's paced limit separate and adds this headroom when it writes the host limit.

export interface HeadroomInput {
  /** Busy opencode threads now, or null when the count could not be read. */
  running: number | null;
  slots: number;
  /** True: opencode threads take Claude capacity, so no headroom is added. */
  countsAgainstLimit: boolean;
  /** The headroom in effect on the host now. Kept when the count is unknown. */
  previous: number;
}
export interface HeadroomPlan { headroom: number; warn: string | null }

export function opencodeHeadroom(i: HeadroomInput): HeadroomPlan {
  if (i.slots <= 0 || i.countsAgainstLimit) return { headroom: 0, warn: null };
  if (i.running === null) return { headroom: i.previous, warn: null };
  const headroom = Math.min(i.running, i.slots);
  const warn = i.running > i.slots
    ? `${i.running} opencode runs, more than opencodeSlots ${i.slots}: the extra runs use Claude capacity`
    : null;
  return { headroom, warn };
}

/** The stored headroom: a whole number of zero or more. Anything else is no headroom. */
export function parseHeadroom(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

/** Runs that hold or wait for an opencode slot in an `agent-tv status --json` feed (providerId acp-opencode): busy, or queued behind the limit (status pending or queued). A waiting run has busy false, so busy alone misses it. Idle rows and rows not shaped as expected are not counted. */
export function countOpencodeRuns(feed: unknown): number {
  const rows = (feed as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) return 0;
  return rows.filter((r) => {
    if (typeof r !== "object" || r === null) return false;
    const row = r as { providerId?: unknown; busy?: unknown; status?: unknown };
    if (row.providerId !== "acp-opencode") return false;
    return row.busy === true || row.status === "pending" || row.status === "queued";
  }).length;
}
