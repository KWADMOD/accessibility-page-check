import { test } from "node:test";
import assert from "node:assert/strict";
import { BUSY_MESSAGE, createSlotPool } from "../analysisSlots.js";
import { TooDeeplyNestedError } from "../nestingGuard.js";
import { LOCAL_SCANNER_DESCRIPTION } from "../targets/localDescription.js";
import { localScanner } from "../targets/localScanner.js";
import type { Resolver } from "./webFetch.js";
import { createWebScanner } from "./webScanner.js";

// No real network: every scan injects a fake fetchImpl and resolver.
const resolver: Resolver = async () => ["93.184.216.34"];
const page = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/html" } });
const FLAWED = `<html><body><img src="a.png"></body></html>`;

test("scans a fake page and reports it as the local target", async () => {
  const scanner = createWebScanner({ fetchImpl: (async () => page(FLAWED)) as typeof fetch, resolver });
  const result = await scanner.scan("https://example.com/");
  assert.equal(result.targetId, "local");
  assert.ok(result.findings.length > 0);
  assert.equal(result.summary.total, result.findings.length);
  assert.equal(result.finalUrl, undefined, "no redirect, so no finalUrl");
});

test("id and description match the Node scanner", () => {
  const scanner = createWebScanner();
  assert.equal(scanner.id, localScanner.id);
  assert.equal(scanner.description, localScanner.description);
  assert.equal(scanner.description, LOCAL_SCANNER_DESCRIPTION);
});

test("a full pool is refused before any fetch", async () => {
  let fetchCalls = 0;
  const pool = createSlotPool({ maxActive: 0, maxWaiting: 0 });
  const scanner = createWebScanner({ fetchImpl: (async () => { fetchCalls++; return page(FLAWED); }) as typeof fetch, resolver }, pool);
  await assert.rejects(scanner.scan("https://example.com/"), { message: BUSY_MESSAGE });
  assert.equal(fetchCalls, 0);
});

// The review's concern: one slow site must not stop everybody else, so a download that never
// finishes may hold one slot but not the whole scanner.
test("a download that hangs does not block other scans", async () => {
  let calls = 0;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls++;
    if (calls === 1) {
      // The first site drips forever (until its own deadline aborts it).
      await new Promise<void>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    }
    return page(FLAWED);
  }) as typeof fetch;
  const scanner = createWebScanner({ fetchImpl, resolver, timeoutMs: 5000 });
  const slow = scanner.scan("https://slow.example/");
  slow.catch(() => undefined);
  // Two more scans finish while the first is still hanging.
  const [second, third] = await Promise.all([scanner.scan("https://b.example/"), scanner.scan("https://c.example/")]);
  assert.equal(second.targetId, "local");
  assert.equal(third.targetId, "local");
  assert.equal(calls, 3);
});

test("six concurrent scans are accepted and a seventh is told the scanner is busy", async () => {
  // Responses are released by hand so the test needs no timers.
  const releases: Array<() => void> = [];
  let fetchCalls = 0;
  const fetchImpl = (async () => {
    fetchCalls++;
    await new Promise<void>((resolve) => releases.push(resolve));
    return page(FLAWED);
  }) as typeof fetch;
  const scanner = createWebScanner({ fetchImpl, resolver }); // default pool: 4 downloading + 2 waiting

  const scans = Array.from({ length: 6 }, (_, i) => scanner.scan(`https://${i}.example/`));
  // Let the first four reach their fetch; the other two must still be waiting for a slot.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls, 4, "four scans download at a time");

  await assert.rejects(scanner.scan("https://seventh.example/"), { message: BUSY_MESSAGE });
  assert.equal(fetchCalls, 4, "the refused scan never fetched");

  for (let done = 0; done < 6; done++) {
    while (releases.length === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    releases.shift()!();
  }
  const results = await Promise.all(scans);
  assert.ok(results.every((r) => r.targetId === "local"));
  assert.equal(fetchCalls, 6);
});

test("a 2,000-deep page is refused as too deeply nested", async () => {
  const deep = "<div>".repeat(2000) + "x" + "</div>".repeat(2000);
  const scanner = createWebScanner({ fetchImpl: (async () => page(deep)) as typeof fetch, resolver });
  await assert.rejects(scanner.scan("https://example.com/"), TooDeeplyNestedError);
});

test("a failed scan frees its slot", async () => {
  const scanner = createWebScanner({ fetchImpl: (async () => page("<div>".repeat(2000))) as typeof fetch, resolver });
  for (let i = 0; i < 5; i++) await assert.rejects(scanner.scan("https://example.com/"), TooDeeplyNestedError);
});
