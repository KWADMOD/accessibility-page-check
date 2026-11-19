import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "./registry.js";
import { localScanner } from "./localScanner.js";
import type { ScanTarget } from "./types.js";

const registry = createRegistry(localScanner);

test("public listing shows only the local target", () => {
  assert.deepEqual(registry.listTargets().map((t) => t.id), ["local"]);
  assert.ok(!JSON.stringify(registry.listTargets()).toLowerCase().includes("external"));
});

test("the disabled target still refuses to run, with no provider named in the message", async () => {
  await assert.rejects(registry.getTarget("external-api").scan("https://example.com"), (error: Error) => {
    assert.match(error.message, /disabled/);
    assert.ok(!/external|api/i.test(error.message));
    return true;
  });
});

test("unknown target error lists only public targets", () => {
  assert.throws(() => registry.getTarget("nope"), (error: Error) => /Available: local\./.test(error.message) && !/external/i.test(error.message));
});

test("getTarget with no id returns the injected default target", () => {
  const fake: ScanTarget = { id: "fake", description: "test double", scan: async () => { throw new Error("unused"); } };
  assert.equal(createRegistry(fake).getTarget(), fake);
  assert.equal(registry.getTarget(), localScanner);
});
