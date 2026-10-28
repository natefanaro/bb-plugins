// bb-plugin-concurrency-coach host entry: runs on each enrolled machine and answers with that machine's own load and memory, so Coach can manage every connected host on its own readings.
import os from "node:os";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./lib/host-contract.ts";
import { readMemory } from "./lib/io.ts";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    readings: async () => ({
      load1: os.loadavg()[0],
      cpus: os.cpus().length || 1,
      memory: await readMemory({ paging: true }),
    }),
  },
});
