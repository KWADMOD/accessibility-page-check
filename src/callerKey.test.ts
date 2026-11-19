import { test } from "node:test";
import assert from "node:assert/strict";
import { callerKeyFor } from "./callerKey.js";

test("IPv4 callers get one bucket per address", () => {
  assert.equal(callerKeyFor("203.0.113.7"), "203.0.113.7");
  assert.notEqual(callerKeyFor("203.0.113.7"), callerKeyFor("203.0.113.8"));
});

// The review's concern: a host rotating through addresses in its own /64 must share one bucket.
test("IPv6 callers in the same /64 share a bucket, however the address is written", () => {
  const a = callerKeyFor("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
  assert.equal(callerKeyFor("2001:db8:1:2:1111:2222:3333:4444"), a);
  assert.equal(callerKeyFor("2001:0DB8:0001:0002::1"), a);
  assert.equal(callerKeyFor("2001:db8:1:2::"), a);
  assert.equal(a, "v6:2001:db8:1:2");
  // A different /64 is a different caller.
  assert.notEqual(callerKeyFor("2001:db8:1:3::1"), a);
  assert.notEqual(callerKeyFor("2001:db8:2:2::1"), a);
});

test("an IPv4 address written as IPv6 is the same caller as the plain IPv4 form", () => {
  assert.equal(callerKeyFor("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(callerKeyFor("::ffff:cb00:7107"), "203.0.113.7");
  // Two different mapped callers must not collapse into one bucket.
  assert.notEqual(callerKeyFor("::ffff:203.0.113.7"), callerKeyFor("::ffff:203.0.113.8"));
});

test("short forms, zone ids and loopback are handled", () => {
  assert.equal(callerKeyFor("::1"), "v6:0:0:0:0");
  assert.equal(callerKeyFor("fe80::1%eth0"), "v6:fe80:0:0:0");
  assert.equal(callerKeyFor("1:2:3:4:5:6:7:8"), "v6:1:2:3:4");
});

test("a missing or unreadable address still gets a key and never throws", () => {
  assert.equal(callerKeyFor(null), "unknown");
  assert.equal(callerKeyFor(undefined), "unknown");
  assert.equal(callerKeyFor("   "), "unknown");
  assert.equal(callerKeyFor("not:an:address"), "not:an:address");
  assert.equal(callerKeyFor("1::2::3"), "1::2::3");
  assert.equal(callerKeyFor("::ffff:999.1.1.1"), "::ffff:999.1.1.1");
});
