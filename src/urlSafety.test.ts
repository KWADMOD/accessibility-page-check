import { test } from "node:test";
import assert from "node:assert/strict";
import { compileIPv4Ranges, compileIPv6Ranges, isBlockedAddress, isIpLiteral, normalizeUserUrl } from "./urlSafety.js";

// A typo in a blocked-range table must stop the module loading, never silently un-block a range.
test("a malformed blocked-range entry throws instead of being skipped", () => {
  assert.throws(() => compileIPv4Ranges([["10.0.0.0", 8], ["192.168.0.256", 16]]), /192\.168\.0\.256/);
  assert.throws(() => compileIPv4Ranges([["10.0.0.0", 33]]), /10\.0\.0\.0/);
  assert.throws(() => compileIPv6Ranges([["fc00:::", 7]]), /fc00:::/);
  assert.throws(() => compileIPv6Ranges([["fe80::", 129]]), /fe80::/);
  assert.equal(compileIPv4Ranges([["10.0.0.0", 8]]).length, 1);
  assert.equal(compileIPv6Ranges([["fe80::", 10]]).length, 1);
});

test("adds https:// to bare domains but leaves real schemes alone", () => {
  assert.equal(normalizeUserUrl("  example.com/about "), "https://example.com/about");
  assert.equal(normalizeUserUrl("localhost:3000"), "https://localhost:3000");
  assert.equal(normalizeUserUrl("http://example.com"), "http://example.com");
  assert.equal(normalizeUserUrl("file:///C:/x"), "file:///C:/x");
  assert.equal(normalizeUserUrl("javascript:alert(1)"), "javascript:alert(1)");
  assert.equal(normalizeUserUrl("mailto:a@b.c"), "mailto:a@b.c");
});

test("blocks loopback, private, link-local and metadata addresses", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "192.88.99.1", "100.64.0.1", "0.0.0.0", "224.0.0.1"]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
});

test("blocks IPv6 loopback, unique-local, link-local and mapped IPv4", () => {
  for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::7f00:1", "::7f00:1", "2001::1", "100::1"]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
});

test("allows ordinary public addresses", () => {
  for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111"]) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test("treats anything that is not an IP literal as blocked", () => {
  assert.equal(isBlockedAddress("not-an-ip"), true);
});

test("matches the expected block decisions for the runtime-neutral matcher", () => {
  const blocked = ["0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.31.255.255", "192.168.1.1", "::1", "::ffff:10.0.0.1", "::ffff:8.8.8.8", "::7f00:1", "64:ff9b::808:808", "2002::1", "fd00::1", "fe80::1", "ff02::1", "not-an-ip"];
  for (const ip of blocked) assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"]) assert.equal(isBlockedAddress(ip), false, ip);
});

// Malformed literals must be refused (treated as not-an-IP), never parsed leniently.
test("refuses malformed IP literals", () => {
  for (const bad of ["", "1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4", "1.2.3.-4", "::g", ":::", "1::2::3", "1:2:3:4:5:6:7:8:9", "[::1]", "1.2.3.4/8", "1.2.3.4::", "127.0.0.1::", "1:1.2.3.4::"]) {
    assert.equal(isBlockedAddress(bad), true, bad);
    assert.equal(isIpLiteral(bad), false, bad);
  }
});

// The Worker bundle cannot import node: modules, so the shared core must stay free of them.
// Reads the TypeScript sources (not dist) so the check does not depend on build output.
test("shared core modules import nothing from node:", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const file of ["urlSafety", "checks", "report", "mcpServer", "analysisSlots", "fetchMessages"]) {
    const source = await readFile(new URL(`../src/${file}.ts`, import.meta.url), "utf8");
    assert.ok(!/from\s+["']node:/.test(source), `src/${file}.ts imports a node: module`);
  }
});

// Deliberate difference from node:net, which accepted zone ids: they are refused as non-IP.
test("IPv6 literals with a zone id are blocked", () => {
  for (const ip of ["fe80::1%eth0", "2606:4700::1111%1"]) assert.equal(isBlockedAddress(ip), true, ip);
});
