import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeInWorker } from "./analyze.js";
import { analyzePage } from "./checks.js";
import { SAMPLE_BROKEN_HTML } from "./sampleHtml.js";

test("the worker gives the same answer as analysing directly", async () => {
  assert.deepEqual(await analyzeInWorker(SAMPLE_BROKEN_HTML), analyzePage(SAMPLE_BROKEN_HTML));
});

// The nesting guard now turns hostile depth away before parsing, so the worker never
// sees it: the rejection must be fast and carry the guard's plain message.
test("a pathologically nested page is refused by the nesting guard, not parsed", { timeout: 20000 }, async () => {
  const hostile = `<html lang="en"><title>t</title><body>${"<div>".repeat(200000)}</body></html>`;
  const started = Date.now();
  await assert.rejects(analyzeInWorker(hostile), /nested too deeply to analyze/);
  assert.ok(Date.now() - started < 8000, `took ${Date.now() - started}ms`);
});

// A page just under the element cap with a finding on every element: real work for the worker.
const busyPage = `<html lang="en"><title>t</title><body>${'<a href="/x"><img src="y"></a><p>x</p>'.repeat(49000)}</body></html>`;

// The deadline is the backstop for anything slow that the guard lets through. A 1 ms deadline always
// fires first, whatever the machine: a worker thread cannot even start in that time. That makes the
// test about the deadline mechanism (and its message) instead of about how fast this computer is.
test("a worker that is still running at the deadline is cut off with a plain message", { timeout: 30000 }, async () => {
  const started = Date.now();
  await assert.rejects(analyzeInWorker(busyPage, 1), /took longer than 0.001 seconds to analyze, so it was not scanned/);
  assert.ok(Date.now() - started < 8000, `took ${Date.now() - started}ms`);
  // The slot is free again afterwards: the next analysis runs normally.
  assert.equal((await analyzeInWorker("<html lang=en><title>t</title><h1>x</h1>")).findings.length, 0);
});

// A blocked event loop counts about zero ticks however long the analysis runs, so the bar scales with
// the elapsed time: at least a third of the ticks a free loop would see. On a machine fast enough that
// the analysis ends in under 150 ms there is nothing to measure, and the test says so instead of passing silently.
test("the main thread stays responsive while a worker is busy analyzing", { timeout: 30000 }, async (t) => {
  let ticks = 0;
  const interval = setInterval(() => ticks++, 50);
  const started = Date.now();
  await analyzeInWorker(busyPage, 25000);
  const elapsed = Date.now() - started;
  clearInterval(interval);
  if (elapsed < 150) return t.skip(`analysis finished in ${elapsed}ms, too fast to measure responsiveness`);
  const expected = Math.floor(elapsed / 50);
  assert.ok(ticks >= expected / 3, `only ${ticks} ticks in ${elapsed}ms (a free loop sees about ${expected})`);
});

test("a deeply nested page just under the guard limit is analysed in the worker", { timeout: 30000 }, async () => {
  // Real pages nest a few dozen levels; 350 is far beyond that but still allowed.
  const deep = `<html lang="en"><title>t</title><body><h1>x</h1>${"<div>".repeat(350)}<a href="/x"></a>${"</div>".repeat(350)}</body></html>`;
  const result = await analyzeInWorker(deep);
  assert.deepEqual(result.findings.map((f) => f.ruleId), ["link-name"]);
});

import { MAX_CONCURRENT_ANALYSES, MAX_WAITING_ANALYSES, withAnalysisSlot } from "./analyze.js";

test("never runs more analyses at once than the limit, and runs them all", async () => {
  let running = 0;
  let peak = 0;
  const task = async (n: number) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 30));
    running--;
    return n;
  };
  const total = MAX_CONCURRENT_ANALYSES + MAX_WAITING_ANALYSES;
  const results = await Promise.all(Array.from({ length: total }, (_, n) => withAnalysisSlot(() => task(n))));
  assert.deepEqual(results, Array.from({ length: total }, (_, n) => n));
  assert.equal(peak, MAX_CONCURRENT_ANALYSES);
});

test("scans beyond the waiting limit are refused at once, and the rest still finish", async () => {
  const total = MAX_CONCURRENT_ANALYSES + MAX_WAITING_ANALYSES + 2;
  const outcomes = await Promise.allSettled(
    Array.from({ length: total }, (_, n) => withAnalysisSlot(async () => { await new Promise((r) => setTimeout(r, 30)); return n; })),
  );
  const refused = outcomes.filter((o) => o.status === "rejected");
  assert.equal(refused.length, 2);
  assert.match(String((refused[0] as PromiseRejectedResult).reason), /busy/);
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, total - 2);
  // Slots must all be free again afterwards.
  assert.equal(await withAnalysisSlot(async () => "ok"), "ok");
});

test("a failing task still frees its slot", async () => {
  await assert.rejects(withAnalysisSlot(async () => { throw new Error("boom"); }), /boom/);
  assert.equal(await withAnalysisSlot(async () => "ok"), "ok");
});

import { assertAnalysisCapacity } from "./analyze.js";

test("the capacity pre-check refuses only when slots and the waiting queue are both full", async () => {
  assertAnalysisCapacity(); // idle: fine
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const held = Array.from({ length: MAX_CONCURRENT_ANALYSES + MAX_WAITING_ANALYSES }, () => withAnalysisSlot(() => gate));
  // Slots are taken but there is still room to wait only if the queue is not full; here it is full.
  assert.throws(() => assertAnalysisCapacity(), /busy/);
  release();
  await Promise.all(held);
  assertAnalysisCapacity(); // everything freed again
});
