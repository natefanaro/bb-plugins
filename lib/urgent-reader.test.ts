import { test } from "node:test";
import assert from "node:assert/strict";
import { createUrgentReader, unscopedEnv, URGENT_READER_DEFAULTS } from "./urgent-reader.ts";

const MIN = 60_000;

/** A fake `bb`: three urgent tasks, two of them with threads. Records every call. */
function fake(over: { list?: () => Promise<string>; show?: (key: string) => Promise<string> } = {}) {
  const calls: string[][] = [];
  const tasks = { A: ["thr_a1", "thr_a2"], B: [], C: ["thr_c1"] } as Record<string, string[]>;
  const run = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[1] === "list") return over.list ? over.list() : JSON.stringify({ tasks: Object.keys(tasks).map((key) => ({ key })) });
    const key = args[2];
    return over.show ? over.show(key) : JSON.stringify({ taskThreads: tasks[key].map((threadId) => ({ threadId })) });
  };
  return { run, calls };
}

function reader(f: ReturnType<typeof fake>, clock: { t: number }, over: Partial<typeof URGENT_READER_DEFAULTS> = {}) {
  return createUrgentReader({ ...URGENT_READER_DEFAULTS, ...over, now: () => clock.t, run: f.run });
}

test("the map is every thread attached to an urgent task in todo, in progress or in review", async () => {
  const f = fake();
  const ids = await reader(f, { t: 0 })();
  assert.deepEqual([...ids].sort(), ["thr_a1", "thr_a2", "thr_c1"]);
  const list = f.calls[0];
  assert.deepEqual(list.slice(0, 4), ["tasks", "list", "--priority", "urgent"]);
  assert.ok(list.includes("todo,in_progress,in_review"));
  assert.ok(!list.includes("--active"), "--active keeps only starting or working threads and would miss a waiting one");
  assert.equal(f.calls.filter((c) => c[1] === "show").length, 3);
});

test("the map is reused for the ttl: no second scan within 10 minutes, a rescan after", async () => {
  const f = fake();
  const clock = { t: 0 };
  const read = reader(f, clock);
  await read();
  const first = f.calls.length;
  clock.t = 9 * MIN;
  await read();
  assert.equal(f.calls.length, first, "cached");
  clock.t = 10 * MIN;
  await read();
  assert.ok(f.calls.length > first, "refreshed at the ttl");
});

test("shows run in chunks of the concurrency and every task is read", async () => {
  let inFlight = 0;
  let peak = 0;
  const f = fake({
    list: async () => JSON.stringify({ tasks: Array.from({ length: 12 }, (_, i) => ({ key: `T-${i}` })) }),
    show: async (key) => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return JSON.stringify({ taskThreads: [{ threadId: `thr_${key.replace("-", "")}` }] }); },
  });
  const ids = await reader(f, { t: 0 }, { concurrency: 5 })();
  assert.equal(ids.size, 12);
  assert.ok(peak <= 5, `peak ${peak}`);
  assert.ok(peak > 1, "they do run in parallel");
});

test("at most maxTasks tasks are examined", async () => {
  const f = fake({ list: async () => JSON.stringify({ tasks: Array.from({ length: 60 }, (_, i) => ({ key: `T-${i}` })) }), show: async () => JSON.stringify({ taskThreads: [] }) });
  await reader(f, { t: 0 }, { maxTasks: 40 })();
  assert.equal(f.calls.filter((c) => c[1] === "show").length, 40);
  assert.ok(f.calls[0].includes("40"));
});

test("a list that fails with project_ambiguous makes the read fail, so the lane is reported unreadable", async () => {
  const f = fake({ list: async () => { throw new Error("project_ambiguous: multiple tracker projects are linked to BB project proj_example; pass --project explicitly"); } });
  await assert.rejects(reader(f, { t: 0 })(), /project_ambiguous/);
});

test("a show that fails, or output that is not JSON, makes the read fail", async () => {
  await assert.rejects(reader(fake({ show: async () => { throw new Error("tasks down"); } }), { t: 0 })(), /tasks down/);
  await assert.rejects(reader(fake({ list: async () => "not json" }), { t: 0 })());
});

test("a failed refresh uses the older map for up to 30 minutes, then fails", async () => {
  let broken = false;
  const f = fake({ list: async () => { if (broken) throw new Error("down"); return JSON.stringify({ tasks: [{ key: "A" }] }); } });
  const clock = { t: 0 };
  const read = reader(f, clock);
  assert.deepEqual([...await read()].sort(), ["thr_a1", "thr_a2"]);
  broken = true;
  clock.t = 15 * MIN;
  assert.deepEqual([...await read()].sort(), ["thr_a1", "thr_a2"], "stale map within 30 minutes");
  clock.t = 30 * MIN;
  await assert.rejects(read(), /down/);
});

test("a failed first read is not cached: the next read tries again", async () => {
  let fail = true;
  const f = fake({ list: async () => { if (fail) throw new Error("down"); return JSON.stringify({ tasks: [{ key: "C" }] }); } });
  const read = reader(f, { t: 0 });
  await assert.rejects(read());
  fail = false;
  assert.deepEqual([...await read()], ["thr_c1"]);
});

test("the child's environment drops the project scope and keeps the rest", () => {
  const env = unscopedEnv({ BB_PROJECT_ID: "proj_example", BB_THREAD_ID: "thr_x", BB_ENVIRONMENT_ID: "env_x", BB_THREAD_STORAGE: "/tmp/s", BB_CLI: "/bin/bb", BB_SERVER_URL: "http://127.0.0.1:1", PATH: "/usr/bin", HOME: "/h" });
  assert.deepEqual(env, { BB_CLI: "/bin/bb", BB_SERVER_URL: "http://127.0.0.1:1", PATH: "/usr/bin", HOME: "/h" });
});

test("unscopedEnv does not change the environment it is given", () => {
  const src = { BB_PROJECT_ID: "p", PATH: "/usr/bin" };
  unscopedEnv(src);
  assert.equal(src.BB_PROJECT_ID, "p");
});
