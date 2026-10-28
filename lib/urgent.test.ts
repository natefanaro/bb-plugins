import { test } from "node:test";
import assert from "node:assert/strict";
import { countUrgent, parseWaitSince, urgentHeadroom, urgentThreadIds, urgentWait } from "./urgent.ts";

test("thread ids come from every task's taskThreads; bad rows are skipped", () => {
  const ids = urgentThreadIds([
    { taskThreads: [{ threadId: "thr_a" }, { threadId: "thr_b" }, { threadId: 7 }, { threadId: "x" }, null] },
    { taskThreads: [{ threadId: "thr_a" }, { threadId: "thr_c" }] },
    { taskThreads: "no" },
    null,
    {},
  ]);
  assert.deepEqual([...ids].sort(), ["thr_a", "thr_b", "thr_c"]);
});

const urgent = new Set(["thr_u1", "thr_u2", "thr_u3"]);
const feed = { rows: [
  { id: "thr_u1", busy: true, status: "active" },
  { id: "thr_u2", busy: false, status: "pending" },
  { id: "thr_u3", busy: false, status: "idle" },
  { id: "thr_other", busy: true, status: "active" },
  { id: "thr_other2", busy: false, status: "pending" },
  null,
  { status: "pending" },
] };

test("urgent threads: busy ones are running, pending or queued ones are waiting, idle ones do not count", () => {
  assert.deepEqual(countUrgent(feed, urgent), { running: 1, waiting: 1 });
  assert.deepEqual(countUrgent({ rows: [{ id: "thr_u1", busy: false, status: "queued" }] }, urgent), { running: 0, waiting: 1 });
});

test("a feed that is not shaped as expected counts nothing", () => {
  assert.deepEqual(countUrgent({}, urgent), { running: 0, waiting: 0 });
  assert.deepEqual(countUrgent(null, urgent), { running: 0, waiting: 0 });
});

test("headroom: one slot per urgent thread running or waiting, up to the slots", () => {
  assert.equal(urgentHeadroom({ count: { running: 0, waiting: 0 }, slots: 1, previous: 0 }), 0);
  assert.equal(urgentHeadroom({ count: { running: 0, waiting: 1 }, slots: 1, previous: 0 }), 1);
  assert.equal(urgentHeadroom({ count: { running: 1, waiting: 0 }, slots: 1, previous: 0 }), 1, "a running urgent thread keeps its slot");
  assert.equal(urgentHeadroom({ count: { running: 2, waiting: 3 }, slots: 1, previous: 0 }), 1, "capped at the slots");
  assert.equal(urgentHeadroom({ count: { running: 1, waiting: 1 }, slots: 2, previous: 0 }), 2);
});

test("headroom: slots 0 turns the lane off; an unknown count keeps what is in effect, within the slots", () => {
  assert.equal(urgentHeadroom({ count: { running: 3, waiting: 3 }, slots: 0, previous: 1 }), 0);
  assert.equal(urgentHeadroom({ count: null, slots: 1, previous: 1 }), 1);
  assert.equal(urgentHeadroom({ count: null, slots: 1, previous: 2 }), 1);
  assert.equal(urgentHeadroom({ count: null, slots: 0, previous: 1 }), 0);
});

const H = 3600_000;
test("wait clock: starts when urgent work first waits, keeps its start, clears when none waits", () => {
  const w = { running: 0, waiting: 1 };
  const a = urgentWait(w, 1000, null, 2 * H);
  assert.deepEqual(a, { since: 1000, starved: false });
  const b = urgentWait(w, 1000 + 2 * H - 1, a.since, 2 * H);
  assert.equal(b.starved, false);
  const c = urgentWait(w, 1000 + 2 * H, b.since, 2 * H);
  assert.deepEqual(c, { since: 1000, starved: true });
  assert.deepEqual(urgentWait({ running: 1, waiting: 0 }, 1000 + 3 * H, c.since, 2 * H), { since: null, starved: false });
});

test("wait clock: an unknown count keeps it; a report time of 0 never flags", () => {
  assert.deepEqual(urgentWait(null, 5000, 1000, 2 * H), { since: 1000, starved: false });
  assert.deepEqual(urgentWait(null, 5000, null, 2 * H), { since: null, starved: false });
  assert.deepEqual(urgentWait({ running: 0, waiting: 1 }, 1000 + 9 * H, 1000, 0), { since: 1000, starved: false });
});

test("stored wait start: a positive finite number or none", () => {
  assert.equal(parseWaitSince(1700000000000), 1700000000000);
  assert.equal(parseWaitSince(0), null);
  assert.equal(parseWaitSince(-1), null);
  assert.equal(parseWaitSince("5"), null);
  assert.equal(parseWaitSince(Number.NaN), null);
  assert.equal(parseWaitSince(null), null);
});
