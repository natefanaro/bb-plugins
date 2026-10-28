// Wire contract shared by server.ts (RPC handlers) and app.tsx (panel). The panel reads; its one control is Turbo.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const pace = z.object({
  used: z.number().nullable(),
  elapsed: z.number().nullable(),
  /** Used, projected to the window's reset at the current rate, in percent. Null without a usable elapsed share. */
  projected: z.number().nullable(),
  state: z.enum(["ahead", "behind", "unknown"]),
});

export const turboViewSchema = z.object({
  active: z.boolean(),
  limit: z.number().nullable(),
  /** ISO time the time box ends. Null when Turbo is off. */
  until: z.string().nullable(),
  startedBy: z.enum(["cli", "panel"]).nullable(),
  /** Offer Turbo: weekly use is behind pace with three hours or less to the reset. Only when Turbo is off. */
  suggested: z.boolean(),
  /** True while an active Turbo has no time box: it runs until turned off. */
  untilOff: z.boolean(),
  /** The duration buttons the panel offers (the settings). Minutes null is "until off". */
  choices: z.array(z.object({ minutes: z.number().nullable(), label: z.string() })),
  /** The optional raw swap end line (percent); 0 means it is off. Memory pressure ends Turbo either way. */
  memoryEndPercent: z.number(),
  /** Set when a start now would end at once (quota near its cap, or memory pressure); the buttons are held back. */
  blockedReason: z.string().nullable(),
});

export const panelSchema = z.object({
  generatedAt: z.number(),
  host: z.string().nullable(),
  /** Set when the limit plugin could not be read; the other fields are then best-effort. */
  error: z.string().nullable(),
  limit: z.object({
    /** The host limit now: Claude's paced limit plus the opencode headroom. */
    current: z.number().nullable(),
    min: z.number(),
    max: z.number(),
    globalLimit: z.number().nullable(),
    /** Claude's paced limit (the host limit without the headroom). Null when the host limit is unknown. */
    claude: z.number().nullable(),
    /** The opencode headroom on the host, one slot per running opencode thread up to the slots. */
    opencode: z.object({
      headroom: z.number(),
      running: z.number().nullable(),
      slots: z.number(),
      countsAgainstLimit: z.boolean(),
      /** Plain words when more opencode threads run than the slots; null otherwise. */
      warning: z.string().nullable(),
    }),
    /** The urgent lane: slots reserved above the paced limit for threads whose task has priority urgent. */
    urgent: z.object({
      slots: z.number(),
      /** Urgent slots in effect on the host now. */
      headroom: z.number(),
      running: z.number().nullable(),
      waiting: z.number().nullable(),
      /** ISO time urgent work first began waiting, or null when none waits. */
      waitingSince: z.string().nullable(),
      /** Urgent work has waited at least reportMinutes. */
      starved: z.boolean(),
      reportMinutes: z.number(),
      /** The lane is on but the urgent threads could not be read at the last tick; it kept its last state. */
      unreadable: z.boolean(),
    }),
  }),
  threads: z.object({
    /** Threads occupying a slot now: starting or active, hidden included (bb.sdk.threads.listRunning). Not capped. */
    running: z.number().nullable(),
    /** Queued messages held by the concurrency limit that are still waiting or retrying for a slot. */
    queued: z.number().nullable(),
    /** Queued messages held by the limit that failed after their retries ran out. Not waiting; shown so they are not hidden. */
    gaveUp: z.number().nullable(),
  }),
  why: z.object({
    /** The reason of the newest logged decision, as a sentence. While Turbo is on, its sentence; a manual-change back-off replaces it while it lasts. */
    sentence: z.string(),
    /** When that decision was made (ISO time). Null when nothing is logged yet. */
    decidedAt: z.string().nullable(),
    backingOff: z.boolean(),
    backOffMinutesLeft: z.number(),
    /** What limits the limit right now, in one line: capacity (memory, CPU) or quota (pace). Computed from the current readings, the same ones the policy reads. */
    explain: z.object({ cause: z.enum(["quota-cap", "memory-and-quota", "memory", "quota", "cpu", "turbo", "none"]), line: z.string() }),
    /** The readings the last decision used, for the Coach window. Null when nothing is logged yet. */
    detail: z.object({
      applied: z.boolean(),
      cur: z.number(),
      next: z.number(),
      load: z.number().nullable(),
      fiveHour: z.object({ used: z.number().nullable(), elapsed: z.number().nullable() }),
      week: z.object({ used: z.number().nullable(), elapsed: z.number().nullable() }),
      memory: z.object({ swapUsedPct: z.number().nullable(), freePct: z.number().nullable(), pageoutsPerSec: z.number().nullable() }).nullable(),
    }).nullable(),
  }),
  turbo: turboViewSchema,
  inputs: z.object({
    load: z.object({ ratio: z.number().nullable(), level: z.enum(["idle", "ok", "hot"]).nullable(), /** CPU load per core below which the limit steps up, and above which it steps down (the tunables). */ idle: z.number(), hot: z.number() }),
    memory: z.object({ swapUsedPct: z.number().nullable(), freePct: z.number().nullable(), pageoutsPerSec: z.number().nullable(), hot: z.boolean(), swapHotPercent: z.number(), memFreeMinPercent: z.number() }),
    fiveHour: pace,
    week: pace,
  }),
  history: z.object({
    windowSec: z.number(),
    points: z.array(z.object({ ageSec: z.number(), limit: z.number() })),
    changes: z.array(z.object({ ageSec: z.number(), from: z.number(), to: z.number(), why: z.string() })),
  }),
  topCpu: z.object({ name: z.string(), cpuPct: z.number() }).nullable(),
});

export type PanelView = z.infer<typeof panelSchema>;
export type TurboView = z.infer<typeof turboViewSchema>;

export const coachRpcContract = defineRpcContract({
  panel: {
    input: z.null(),
    output: panelSchema,
  },
  turboStart: {
    input: z.object({
      limit: z.number().int().min(1).max(16).nullable(),
      minutes: z.number().int().min(1).max(720).nullable(),
      /** Run until turned off, instead of a time box. */
      untilOff: z.boolean().optional(),
    }).strict(),
    output: turboViewSchema,
  },
  turboStop: {
    input: z.null(),
    output: turboViewSchema,
  },
});
