// The `bb concurrency-coach turbo` command. Kept out of server.ts so a test can run it through the SDK's own option parser.
import { cliCommand } from "@get-bb/plugin-sdk";
import { TURBO_DEFAULT_MS, TURBO_MAX_LIMIT, TURBO_MAX_MS, turboSentence, type Turbo } from "./turbo.ts";

export interface TurboCliDeps {
  startTurboFrom(by: "cli", limit: number | undefined, durationMs: number | null | undefined): Promise<{ turbo: Turbo; capRaised: boolean }>;
  endTurbo(by: "cli", reason: string): Promise<boolean>;
  /** The turboAllowUntilOff setting. */
  allowUntilOff(): Promise<boolean>;
  /** CPU cores, for the "more threads than cores" note. */
  cores: number;
}

export function turboCli(deps: TurboCliDeps) {
  return cliCommand({
    summary: "Hold a chosen limit for a time box (default maxLimit for 2h, or --until-off), or `turbo off` to end it",
    description: "Turbo writes the limit at once and ignores the CPU-hot rule. A manual limit change ends it, and so does memory pressure. If the limit is above the overall cap, the cap is raised until Turbo ends. A limit above maxLimit, or above the core count, runs more threads than usual. It is not started when the quota or memory already says it would end.",
    positionals: [{ name: "action", description: "off ends Turbo", required: false }],
    options: {
      limit: { type: "integer", min: 1, max: TURBO_MAX_LIMIT, description: `Limit to hold (default maxLimit). Above maxLimit or the core count runs more threads than usual; the most is ${TURBO_MAX_LIMIT}` },
      for: { type: "duration", defaultUnit: "h", min: 60_000, max: TURBO_MAX_MS, default: TURBO_DEFAULT_MS, description: "How long Turbo runs, e.g. 2h or 90m (default 2h, most 12h)" },
      "until-off": { type: "boolean", description: "Run until `turbo off`, with no time box. The quota cap, memory pressure, the weekly reset and a manual limit change still end it" },
    },
    async run(input) {
      if (input.positionals.action === "off") {
        const ended = await deps.endTurbo("cli", "turned off from the CLI");
        return { exitCode: 0, stdout: ended ? "Turbo off." : "Turbo was not on." };
      }
      if (input.positionals.action !== undefined) {
        return { exitCode: 1, stderr: "Usage:\n  bb concurrency-coach turbo [--limit N] [--for 2h | --until-off]\n  bb concurrency-coach turbo off" };
      }
      const untilOff = input.options["until-off"] === true;
      if (untilOff && !(await deps.allowUntilOff())) return { exitCode: 1, stderr: "Turbo until off is turned off in the settings (turboAllowUntilOff)." };
      try {
        const { turbo: t, capRaised } = await deps.startTurboFrom("cli", input.options.limit, untilOff ? null : input.options.for);
        const notes = [
          capRaised ? `The overall cap is raised from ${t.globalBefore ?? "none"} until Turbo ends.` : "",
          t.limit > deps.cores ? `The limit is above the ${deps.cores} cores: more threads than cores.` : "",
          "It ends early at the weekly reset, if the quota nears its cap, under memory pressure, or on a manual limit change.",
        ].filter((n) => n !== "");
        return { exitCode: 0, stdout: [turboSentence(t), ...notes].join(" ") };
      } catch (e) {
        return { exitCode: 1, stderr: e instanceof Error ? e.message : String(e) };
      }
    },
  });
}
