// The contract between the server entry and the host entry (host.ts), which runs on every enrolled machine and reports that machine's own load and memory.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const readingsSchema = z.object({
  /** 1-minute load average on that machine. */
  load1: z.number(),
  /** CPU count on that machine. */
  cpus: z.number().int().min(1),
  memory: z.object({
    swapUsedPct: z.number().nullable(),
    freePct: z.number().nullable(),
    pageoutsPerSec: z.number().nullable(),
  }),
});
export type HostReadings = z.infer<typeof readingsSchema>;

export const hostContract = defineRpcContract({
  readings: { input: z.null(), output: readingsSchema },
});
