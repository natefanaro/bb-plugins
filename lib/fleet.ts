// Managing every connected host: per-host profiles, the mode, the order hosts are stepped in, and each host's own stored state. Pure.

export interface HostProfile { min: number; max: number }

const MAX_HOST_LIMIT = 64;

/**
 * Per-host limit ranges from the `hostLimits` setting: "macstudio:2-12, macmini:1-6". A host not listed uses the plugin's minLimit and maxLimit.
 * An entry is dropped when its name is empty, or its range is not whole numbers with 1 <= min <= max <= 64. Names match without regard to case. Later entries win.
 */
export function parseHostLimits(raw: unknown): Map<string, HostProfile> {
  return parseHostLimitsChecked(raw).profiles;
}

/** The same parse, and the entries it dropped (trimmed text), so a bad setting can be reported instead of ignored silently. */
export function parseHostLimitsChecked(raw: unknown): { profiles: Map<string, HostProfile>; dropped: string[] } {
  const profiles = new Map<string, HostProfile>();
  const dropped: string[] = [];
  if (typeof raw !== "string") return { profiles, dropped };
  for (const part of raw.split(",")) {
    if (part.trim() === "") continue;
    const m = /^\s*([^:\s][^:]*?)\s*:\s*(\d+)\s*-\s*(\d+)\s*$/.exec(part);
    const min = m === null ? 0 : Number(m[2]);
    const max = m === null ? 0 : Number(m[3]);
    if (m === null || min < 1 || max < min || max > MAX_HOST_LIMIT) { dropped.push(part.trim()); continue; }
    profiles.set(m[1].toLowerCase(), { min, max });
  }
  return { profiles, dropped };
}

/** The range for a host: its own profile if it has one, else the defaults. */
export function profileFor(name: string, profiles: Map<string, HostProfile>, defaults: HostProfile): HostProfile {
  return profiles.get(name.toLowerCase()) ?? defaults;
}

/**
 * Fleet mode: the `host` setting is blank and more than one host is connected. That is the case Coach used to refuse ("set the host setting").
 * With `host` set, or one connected host, Coach is in single-host mode and behaves as it always has.
 */
export function fleetMode(hostSetting: string, connectedCount: number): boolean {
  return hostSetting.trim() === "" && connectedCount > 1;
}

export interface Rankable { name: string; effectiveLimit: number | null; min: number }

/**
 * The order hosts are stepped in each round: the host furthest above its own minimum first, so it is the one that takes the account's quota pace step down.
 * Ties go by name. A host whose limit is unknown goes last.
 */
export function stepOrder<T extends Rankable>(hosts: T[]): T[] {
  const room = (h: T) => (h.effectiveLimit === null ? Number.NEGATIVE_INFINITY : h.effectiveLimit - h.min);
  return [...hosts].sort((a, b) => room(b) - room(a) || a.name.localeCompare(b.name));
}

export interface KvStore { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void> }

/** A store whose keys carry a per-host prefix, so each host keeps its own back-off, Turbo and headroom apart from every other host and from the single-host keys. */
export function prefixedStore(store: KvStore, hostId: string): KvStore {
  const k = (key: string) => `fleet:${hostId}:${key}`;
  return { get: (key) => store.get(k(key)), set: (key, value) => store.set(k(key), value), delete: (key) => store.delete(k(key)) };
}
