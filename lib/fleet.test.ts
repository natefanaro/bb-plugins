import { test } from "node:test";
import assert from "node:assert/strict";
import { fleetMode, parseHostLimits, parseHostLimitsChecked, prefixedStore, profileFor, stepOrder, type KvStore } from "./fleet.ts";

test("host profiles: name:min-max, comma separated, names case-insensitive", () => {
  const p = parseHostLimits("macstudio:2-12, MacMini:1-6");
  assert.deepEqual(p.get("macstudio"), { min: 2, max: 12 });
  assert.deepEqual(p.get("macmini"), { min: 1, max: 6 });
});

test("host profiles: a bad entry is dropped, the rest kept", () => {
  const p = parseHostLimits("macstudio:2-12,bad,macmini:5-3,x:0-4,y:1-65,z:a-b,:1-2,ok:1-1");
  assert.deepEqual([...p.keys()].sort(), ["macstudio", "ok"]);
});

test("host profiles: a non-string or empty setting is no profiles; a later entry wins", () => {
  assert.equal(parseHostLimits(undefined).size, 0);
  assert.equal(parseHostLimits(7).size, 0);
  assert.equal(parseHostLimits("").size, 0);
  assert.deepEqual(parseHostLimits("a:1-2,a:3-4").get("a"), { min: 3, max: 4 });
});

test("a host without a profile uses the defaults", () => {
  const p = parseHostLimits("macstudio:2-12");
  assert.deepEqual(profileFor("macmini", p, { min: 2, max: 8 }), { min: 2, max: 8 });
  assert.deepEqual(profileFor("MacStudio", p, { min: 2, max: 8 }), { min: 2, max: 12 });
});

test("fleet mode only where Coach used to fail: host blank and more than one connected", () => {
  assert.equal(fleetMode("", 2), true);
  assert.equal(fleetMode("  ", 3), true);
  assert.equal(fleetMode("", 1), false, "one host: single-host mode");
  assert.equal(fleetMode("", 0), false);
  assert.equal(fleetMode("macmini", 2), false, "host set: single-host mode, unchanged");
});

test("step order: the host furthest above its minimum first, ties by name, unknown limits last", () => {
  const hosts = [
    { name: "b", effectiveLimit: 3, min: 1 },
    { name: "a", effectiveLimit: 3, min: 1 },
    { name: "studio", effectiveLimit: 6, min: 2 },
    { name: "x", effectiveLimit: null, min: 1 },
    { name: "low", effectiveLimit: 1, min: 1 },
  ];
  assert.deepEqual(stepOrder(hosts).map((h) => h.name), ["studio", "a", "b", "low", "x"]);
});

test("step order does not change its input", () => {
  const hosts = [{ name: "b", effectiveLimit: 1, min: 1 }, { name: "a", effectiveLimit: 5, min: 1 }];
  stepOrder(hosts);
  assert.deepEqual(hosts.map((h) => h.name), ["b", "a"]);
});

test("each host's stored state is under its own prefix, apart from other hosts and the single-host keys", async () => {
  const m = new Map<string, unknown>();
  const kv: KvStore = { get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } };
  const a = prefixedStore(kv, "host_a");
  const b = prefixedStore(kv, "host_b");
  await a.set("override", 1);
  await b.set("override", 2);
  await kv.set("override", 0);
  assert.equal(await a.get("override"), 1);
  assert.equal(await b.get("override"), 2);
  assert.equal(await kv.get("override"), 0, "the single-host key is untouched");
  assert.deepEqual([...m.keys()].sort(), ["fleet:host_a:override", "fleet:host_b:override", "override"]);
  await a.delete("override");
  assert.equal(await a.get("override"), undefined);
  assert.equal(await b.get("override"), 2);
});

test("the checked parse reports each dropped entry, trimmed, and keeps the good ones", () => {
  const { profiles, dropped } = parseHostLimitsChecked("macstudio:2-12 , bad, macmini:5-3,ok:1-1,,x:0-4");
  assert.deepEqual([...profiles.keys()].sort(), ["macstudio", "ok"]);
  assert.deepEqual(dropped, ["bad", "macmini:5-3", "x:0-4"]);
});

test("nothing is dropped from an empty, blank or non-string setting", () => {
  assert.deepEqual(parseHostLimitsChecked("").dropped, []);
  assert.deepEqual(parseHostLimitsChecked(" , ,").dropped, []);
  assert.deepEqual(parseHostLimitsChecked(undefined).dropped, []);
});
