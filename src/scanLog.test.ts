import { test } from "node:test";
import assert from "node:assert/strict";
import { scanLogEntry, withScanLog } from "./scanLog.js";
import type { ScanResult, ScanTarget } from "./targets/types.js";

// The scan log is how we learn that a rule misfires without anyone writing in. Its promise, repeated
// in the privacy text, is that it never holds the page address, page text or excerpts.

const PAGE = "https://private-client.example/secret-page?token=abc";

const result: ScanResult = {
  targetId: "local",
  url: PAGE,
  finalUrl: "https://private-client.example/moved",
  scannedAt: "2026-11-18T00:00:00.000Z",
  findings: [
    { ruleId: "img-alt", severity: "critical", wcag: "1.1.1", message: "Image has no alt attribute.", snippet: '<img src="/private-client-logo.png">' },
    { ruleId: "img-alt", severity: "critical", wcag: "1.1.1", message: "Image has no alt attribute.", snippet: '<img src="/x.png">' },
    { ruleId: "heading-h1", severity: "moderate", wcag: "1.3.1", message: "The page has headings but no h1." },
  ],
  notes: ["This page appears to build its content with JavaScript."],
  summary: { critical: 2, serious: 0, moderate: 1, minor: 0, total: 3 },
};

test("a scanned page logs counts per rule and nothing from the page", () => {
  const line = JSON.stringify(scanLogEntry("local", 812, { result }));
  assert.deepEqual(JSON.parse(line), {
    event: "scan",
    outcome: "scanned",
    target: "local",
    ms: 812,
    total: 3,
    byRule: { "img-alt": 2, "heading-h1": 1 },
    notes: 1,
    redirected: true,
  });
  assert.doesNotMatch(line, /private-client|secret|token|logo|<img/);
});

test("a refused scan logs why, with addresses and host names removed", () => {
  const entry = scanLogEntry("local", 40, { error: new Error(`getaddrinfo ENOTFOUND private-client.example while fetching ${PAGE}`) });
  assert.equal(entry.outcome, "refused");
  assert.doesNotMatch(entry.reason ?? "", /private-client|secret|token/);
  assert.match(entry.reason ?? "", /^Error: getaddrinfo ENOTFOUND \[host removed\]/);
  // Our own plain messages come through readable.
  const tooBig = scanLogEntry("local", 5, { error: new Error("The page is larger than 2 MB, so it was not scanned.") });
  assert.equal(tooBig.reason, "Error: The page is larger than 2 MB, so it was not scanned.");
});

test("the wrapper logs one line per scan and passes results and errors through unchanged", async () => {
  const lines: string[] = [];
  const ok: ScanTarget = { id: "local", description: "d", scan: async () => result };
  assert.equal(await withScanLog(ok, (l) => lines.push(l)).scan(PAGE), result);
  const failure = new Error("Could not connect to that server.");
  const bad: ScanTarget = { id: "local", description: "d", scan: async () => { throw failure; } };
  await assert.rejects(withScanLog(bad, (l) => lines.push(l)).scan(PAGE), (e) => e === failure);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => JSON.parse(l).outcome), ["scanned", "refused"]);
  for (const line of lines) assert.doesNotMatch(line, /private-client|secret|token/);
});

test("a failure to log never breaks the scan", async () => {
  const ok: ScanTarget = { id: "local", description: "d", scan: async () => result };
  const throwingLog = () => { throw new Error("log sink down"); };
  assert.equal(await withScanLog(ok, throwingLog).scan(PAGE), result);
});
