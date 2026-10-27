import { test } from "node:test";
import assert from "node:assert/strict";
import { defineCli } from "@get-bb/plugin-sdk";
import { turboCli, type TurboCliDeps } from "./turbo-cli.ts";
import { startTurbo, TURBO_DEFAULT_MS } from "./turbo.ts";

const T0 = Date.parse("2026-10-27T12:00:00Z");
const MIN = 60_000;

/** The real `turbo` command run through the SDK's own flag parser, with a fake executor. */
function harness(over: Partial<TurboCliDeps> = {}) {
  const calls: { limit: number | undefined; durationMs: number | null | undefined }[] = [];
  const ends: string[] = [];
  const deps: TurboCliDeps = {
    startTurboFrom: async (_by, limit, durationMs) => {
      calls.push({ limit, durationMs });
      return { turbo: startTurbo(T0, limit ?? 6, durationMs === undefined ? TURBO_DEFAULT_MS : durationMs, "cli", "h1", 4, false), capRaised: false };
    },
    endTurbo: async (_by, reason) => { ends.push(reason); return true; },
    allowUntilOff: async () => true,
    cores: 10,
    ...over,
  };
  const cli = defineCli({ name: "concurrency-coach", summary: "test", commands: { turbo: turboCli(deps) } });
  return { run: (...argv: string[]) => cli.run(["turbo", ...argv], {} as never), calls, ends };
}

test("--until-off starts Turbo with no time box", async () => {
  const h = harness();
  const r = await h.run("--until-off");
  assert.equal(r.exitCode, 0, r.stderr ?? r.stdout);
  assert.deepEqual(h.calls, [{ limit: undefined, durationMs: null }]);
  assert.match(r.stdout ?? "", /until you turn it off/);
});

test("the camelCase spelling is not a flag: --untilOff is an unknown option", async () => {
  const h = harness();
  const r = await h.run("--untilOff");
  assert.notEqual(r.exitCode, 0);
  assert.equal(h.calls.length, 0);
});

test("--for 30m is a 30 minute time box; no flag is the default (undefined)", async () => {
  const a = harness();
  await a.run("--for", "30m");
  assert.equal(a.calls[0].durationMs, 30 * MIN);
  const b = harness();
  await b.run();
  assert.equal(b.calls[0].durationMs, TURBO_DEFAULT_MS, "the parser's default of 2h reaches the executor");
});

test("--limit is passed through", async () => {
  const h = harness();
  await h.run("--limit", "5", "--until-off");
  assert.deepEqual(h.calls, [{ limit: 5, durationMs: null }]);
});

test("--until-off is refused when the setting turns it off", async () => {
  const h = harness({ allowUntilOff: async () => false });
  const r = await h.run("--until-off");
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr ?? "", /turboAllowUntilOff/);
  assert.equal(h.calls.length, 0);
});

test("a refused start prints the reason and exits 1", async () => {
  const h = harness({ startTurboFrom: async () => { throw new Error("Turbo not started: quota near limit"); } });
  const r = await h.run();
  assert.equal(r.exitCode, 1);
  assert.equal(r.stderr, "Turbo not started: quota near limit");
});

test("`turbo off` ends Turbo", async () => {
  const h = harness();
  const r = await h.run("off");
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, "Turbo off.");
  assert.deepEqual(h.ends, ["turned off from the CLI"]);
});

test("--help lists --until-off", async () => {
  const h = harness();
  const r = await h.run("--help");
  assert.match(r.stdout ?? "", /--until-off/);
});
