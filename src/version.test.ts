import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { USER_AGENT } from "./fetchMessages.js";
import { formatReport } from "./report.js";
import { VERSION } from "./version.js";

// A Claude Desktop install once kept running the previous day's bundle, and every build called
// itself 0.1.0, so nothing showed it was stale. These tests keep every copy of the version equal,
// and make each report state it, so a stranger's report (or a screenshot of one) shows which build ran.

const readJson = (relative: string) => JSON.parse(readFileSync(new URL(`../${relative}`, import.meta.url), "utf8"));

test("package.json, the bundle manifest and the code carry the same version", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(readJson("package.json").version, VERSION, "package.json");
  assert.equal(readJson("bundle/manifest.json").version, VERSION, "bundle/manifest.json");
  assert.equal(readJson("package-lock.json").version, VERSION, "package-lock.json");
  assert.ok(USER_AGENT.startsWith(`accessibility-mcp-demo/${VERSION} `), "user agent");
});

test("every report names the version that produced it", () => {
  const report = formatReport({
    targetId: "local",
    url: "https://example.com/",
    scannedAt: "2026-11-18T00:00:00.000Z",
    findings: [],
    summary: { critical: 0, serious: 0, moderate: 0, minor: 0, total: 0 },
  });
  assert.match(report, new RegExp(`with the built-in checker v${VERSION.replace(/\./g, "\\.")} \\(`));
});
