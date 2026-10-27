import { test } from "node:test";
import assert from "node:assert/strict";
import { opencodeHeadroom, parseHeadroom } from "./headroom.ts";

const base = { slots: 1, countsAgainstLimit: false, previous: 0 };
test("none running: no headroom, no warning", () => {
  assert.deepEqual(opencodeHeadroom({ ...base, running: 0 }), { headroom: 0, warn: null });
});
test("one running with one slot: one slot of headroom", () => {
  assert.deepEqual(opencodeHeadroom({ ...base, running: 1 }), { headroom: 1, warn: null });
});
test("two running with one slot: headroom capped at one, and a warning", () => {
  const p = opencodeHeadroom({ ...base, running: 2 });
  assert.equal(p.headroom, 1);
  assert.match(p.warn ?? "", /2 opencode runs, more than opencodeSlots 1/);
});
test("two running with two slots: both get headroom, no warning", () => {
  assert.deepEqual(opencodeHeadroom({ ...base, slots: 2, running: 2 }), { headroom: 2, warn: null });
});
test("feature disabled (slots 0): no headroom whatever is running", () => {
  assert.deepEqual(opencodeHeadroom({ ...base, slots: 0, running: 3 }), { headroom: 0, warn: null });
});
test("opencode counts against the limit: no headroom", () => {
  assert.deepEqual(opencodeHeadroom({ ...base, countsAgainstLimit: true, running: 1 }), { headroom: 0, warn: null });
});
test("an unknown count keeps the headroom in effect", () => {
  assert.deepEqual(opencodeHeadroom({ ...base, running: null, previous: 1 }), { headroom: 1, warn: null });
});
test("a runs-finished tick drops the headroom to zero", () => {
  assert.equal(opencodeHeadroom({ ...base, running: 0, previous: 1 }).headroom, 0);
});
test("stored headroom: whole numbers of zero or more; anything else is none", () => {
  assert.equal(parseHeadroom(2), 2);
  assert.equal(parseHeadroom(0), 0);
  assert.equal(parseHeadroom(-1), 0);
  assert.equal(parseHeadroom(1.5), 0);
  assert.equal(parseHeadroom(null), 0);
  assert.equal(parseHeadroom("1"), 0);
});

import { countOpencodeRuns } from "./headroom.ts";
test("counts busy or queued acp-opencode threads only", () => {
  const feed = { rows: [
    { id: "a", providerId: "acp-opencode", busy: true, status: "running" },
    { id: "b", providerId: "acp-opencode", busy: false, status: "idle" },
    { id: "c", providerId: "claude-code", busy: true, status: "running" },
    { id: "d", providerId: "acp-opencode", busy: true },
    { id: "f", providerId: "acp-opencode", busy: false, status: "pending" },
    { id: "g", providerId: "acp-opencode", busy: false, status: "queued" },
    { id: "h", providerId: "claude-code", busy: false, status: "pending" },
    null,
    { id: "e" },
  ] };
  assert.equal(countOpencodeRuns(feed), 4);
  assert.equal(countOpencodeRuns({}), 0);
  assert.equal(countOpencodeRuns(null), 0);
});
test("a queued row (busy false, status pending) earns headroom", () => {
  const feed = { rows: [{ id: "queued", providerId: "acp-opencode", busy: false, status: "pending" }] };
  assert.equal(countOpencodeRuns(feed), 1);
  assert.equal(opencodeHeadroom({ slots: 1, countsAgainstLimit: false, previous: 0, running: countOpencodeRuns(feed) }).headroom, 1);
});
