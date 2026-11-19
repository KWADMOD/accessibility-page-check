import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DISCLAIMER } from "./report.js";
import type { ScanTarget } from "./targets/types.js";
import { ONE_SCAN_MESSAGE, createHandler, type Env } from "./worker.js";

// No network: the stub scanner answers, and the 127.0.0.1 test is refused before any fetch.
const DOCS_URL = "https://joelwatson.com/a11y-mcp/";
function makeEnv(success = true, perCallerSuccess = true): Env {
  return {
    MCP_LIMITER: { limit: async () => ({ success }) },
    MCP_IP_LIMITER: { limit: async () => ({ success: perCallerSuccess }) },
    DOCS_URL,
    SELF_HOSTNAME: "a11y-mcp.joelwatson.com",
  };
}
const stubScanner: ScanTarget = {
  id: "local",
  description: "stub",
  async scan(url: string) {
    return { targetId: "local", url, scannedAt: new Date().toISOString(), findings: [], summary: { critical: 0, serious: 0, moderate: 0, minor: 0, total: 0 } };
  },
};

function post(body: string, path = "/mcp"): Request {
  return new Request(`https://a11y-mcp.joelwatson.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body,
  });
}
const rpc = (method: string, params: unknown = {}, id = 1) => JSON.stringify({ jsonrpc: "2.0", id, method, params });

test("initialize returns the server info", async () => {
  const res = await createHandler({ scanner: stubScanner }).fetch(
    post(rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } })),
    makeEnv(),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { result: { serverInfo: { name: string } } };
  assert.equal(body.result.serverInfo.name, "accessibility-mcp-demo");
});

test("tools/list shows both tools with titles and readOnlyHint", async () => {
  const res = await createHandler({ scanner: stubScanner }).fetch(post(rpc("tools/list")), makeEnv());
  assert.equal(res.status, 200);
  const body = (await res.json()) as { result: { tools: { name: string; title: string; annotations: { readOnlyHint: boolean } }[] } };
  assert.deepEqual(body.result.tools.map((t) => t.name).sort(), ["list_scan_targets", "scan_page"]);
  for (const tool of body.result.tools) {
    assert.ok(tool.title);
    assert.equal(tool.annotations.readOnlyHint, true);
  }
});

test("scan_page of a literal private IP is refused by the real default scanner", async () => {
  const res = await createHandler().fetch(post(rpc("tools/call", { name: "scan_page", arguments: { url: "http://127.0.0.1/" } })), makeEnv());
  const body = (await res.json()) as { result: { isError: boolean; content: { text: string }[] } };
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /private or internal network/);
});

test("scan_page through a stub scanner includes the disclaimer", async () => {
  const res = await createHandler({ scanner: stubScanner }).fetch(post(rpc("tools/call", { name: "scan_page", arguments: { url: "https://ok.test/" } })), makeEnv());
  const body = (await res.json()) as { result: { content: { text: string }[] } };
  assert.ok(body.result.content[0].text.includes(DISCLAIMER));
});

test("a failed rate limit returns 429 with a JSON-RPC error", async () => {
  const limiterCalls: Array<{ key: string }> = [];
  const env: Env = { ...makeEnv(false), MCP_LIMITER: { limit: async (options) => (limiterCalls.push(options), { success: false }) } };
  const res = await createHandler({ scanner: stubScanner }).fetch(post(rpc("tools/list")), env);
  assert.equal(res.status, 429);
  assert.deepEqual(limiterCalls, [{ key: "mcp" }]);
  assert.equal(res.headers.get("retry-after"), "60");
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const body = (await res.json()) as { jsonrpc: string; error: { code: number; message: string }; id: null };
  assert.equal(body.error.code, -32000);
  assert.equal(body.error.message, "The scanner is getting a lot of requests right now. Please try again in a minute.");
  assert.equal(body.id, null);
});

// The review's concern: one caller sending 60 requests a minute must not lock everyone else out.
test("a caller over its own limit is refused without touching the shared bucket", async () => {
  const sharedCalls: Array<{ key: string }> = [];
  const callerCalls: Array<{ key: string }> = [];
  const env: Env = {
    ...makeEnv(),
    MCP_LIMITER: { limit: async (o) => (sharedCalls.push(o), { success: true }) },
    MCP_IP_LIMITER: { limit: async (o) => (callerCalls.push(o), { success: false }) },
  };
  const req = post(rpc("tools/list"));
  req.headers.set("cf-connecting-ip", "203.0.113.7");
  const res = await createHandler({ scanner: stubScanner }).fetch(req, env);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "60");
  assert.deepEqual(callerCalls, [{ key: "203.0.113.7" }]);
  assert.deepEqual(sharedCalls, [], "a flooder must not use up the shared bucket");
});

test("callers are keyed by address, and a missing address shares one key instead of failing", async () => {
  const callerCalls: Array<{ key: string }> = [];
  const env: Env = { ...makeEnv(), MCP_IP_LIMITER: { limit: async (o) => (callerCalls.push(o), { success: true }) } };
  const withIp = post(rpc("tools/list"));
  withIp.headers.set("cf-connecting-ip", "198.51.100.9");
  await createHandler({ scanner: stubScanner }).fetch(withIp, env);
  await createHandler({ scanner: stubScanner }).fetch(post(rpc("tools/list")), env);
  assert.deepEqual(callerCalls, [{ key: "198.51.100.9" }, { key: "unknown" }]);
});

test("the rate limit runs before the body-size check", async () => {
  const res = await createHandler({ scanner: stubScanner }).fetch(post("x".repeat(70_000)), makeEnv(false));
  assert.equal(res.status, 429);
});

test("a 70 KB body is refused with 413", async () => {
  const res = await createHandler({ scanner: stubScanner }).fetch(post("x".repeat(70_000)), makeEnv());
  assert.equal(res.status, 413);
});

test("a body over the cap is refused even when content-length is missing", async () => {
  const req = post("x".repeat(70_000));
  req.headers.delete("content-length");
  assert.equal(req.headers.get("content-length"), null);
  const res = await createHandler({ scanner: stubScanner }).fetch(req, makeEnv());
  assert.equal(res.status, 413);
});

test("a body over the cap is refused when content-length lies", async () => {
  const req = new Request("https://a11y-mcp.joelwatson.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "content-length": "10" },
    body: "x".repeat(70_000),
  });
  const res = await createHandler({ scanner: stubScanner }).fetch(req, makeEnv());
  assert.equal(res.status, 413);
});

test("a streamed body with no content-length is refused without being read to the end", async () => {
  let pulls = 0;
  const chunk = new TextEncoder().encode("x".repeat(16_384));
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      // Would yield 1 GB if read to the end.
      if (pulls <= 65_536) controller.enqueue(chunk);
      else controller.close();
    },
  });
  const req = new Request("https://a11y-mcp.joelwatson.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body,
    duplex: "half",
  } as RequestInit);
  assert.equal(req.headers.get("content-length"), null);
  const res = await createHandler({ scanner: stubScanner }).fetch(req, makeEnv());
  assert.equal(res.status, 413);
  const json = (await res.json()) as { error: { code: number; message: string } };
  assert.equal(json.error.code, -32000);
  assert.match(json.error.message, /Payload Too Large/);
  assert.ok(pulls < 100, `stream was read ${pulls} times`);
});

test("scan_page refuses the Worker's own hostname (SELF_HOSTNAME wiring)", async () => {
  const res = await createHandler().fetch(post(rpc("tools/call", { name: "scan_page", arguments: { url: "https://a11y-mcp.joelwatson.com/" } })), makeEnv());
  const body = (await res.json()) as { result: { isError: boolean; content: { text: string }[] } };
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /This connector does not scan its own address./);
});

test("GET and DELETE on /mcp are 405 with Allow: POST", async () => {
  for (const method of ["GET", "DELETE"]) {
    const res = await createHandler({ scanner: stubScanner }).fetch(new Request("https://a11y-mcp.joelwatson.com/mcp", { method }), makeEnv());
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST");
  }
});

test("a JSON-RPC batch is answered as an array without crashing", async () => {
  const res = await createHandler({ scanner: stubScanner }).fetch(post(`[${rpc("tools/list", {}, 1)},${rpc("tools/list", {}, 2)}]`), makeEnv());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body) && body.length === 2);
});

test("a batch of scan_page calls starts only one scan", async () => {
  // Review finding: one rate-limit token bought six scans and filled every download slot.
  let scans = 0;
  const counting = { ...stubScanner, scan: async (url: string) => { scans++; return stubScanner.scan(url); } };
  const calls = Array.from({ length: 20 }, (_, i) => rpc("tools/call", { name: "scan_page", arguments: { url: "https://example.com/" } }, i + 1));
  const res = await createHandler({ scanner: counting }).fetch(post(`[${calls.join(",")}]`), makeEnv());
  assert.equal(res.status, 200);
  assert.equal(scans, 1);
  const body = (await res.json()) as Array<{ result: { isError?: boolean; content: Array<{ text: string }> } }>;
  const refused = body.filter((r) => r.result.isError && r.result.content[0].text === ONE_SCAN_MESSAGE);
  assert.equal(refused.length, 19);
});

test("GET / redirects to the docs page", async () => {
  const res = await createHandler({ scanner: stubScanner }).fetch(new Request("https://a11y-mcp.joelwatson.com/"), makeEnv());
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), DOCS_URL);
});

test("unknown paths are 404", async () => {
  const res = await createHandler({ scanner: stubScanner }).fetch(new Request("https://a11y-mcp.joelwatson.com/x"), makeEnv());
  assert.equal(res.status, 404);
});

test("an unexpected exception gives a generic 500 with no stack", async () => {
  const env = { ...makeEnv(), MCP_LIMITER: { limit: async () => { throw new Error("boom at C:\secret\path"); } } };
  const res = await createHandler({ scanner: stubScanner }).fetch(post(rpc("tools/list")), env);
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  assert.ok(!text.includes("boom"));
});

// The Worker runtime has no node: modules, so nothing worker.ts reaches may import one.
test("worker.ts's relative import graph never imports node:", () => {
  const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const seen = new Set<string>();
  const offenders: string[] = [];
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    if (/from\s+["']node:/.test(source) || /import\s*\(\s*["']node:/.test(source)) offenders.push(file);
    for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      const target = resolve(dirname(file), match[1].replace(/\.js$/, ".ts"));
      assert.ok(existsSync(target), `unresolved import ${match[1]} in ${file}`);
      visit(target);
    }
  };
  visit(resolve(srcDir, "worker.ts"));
  assert.ok(seen.size > 5, "the walk should reach the scanner and checks");
  assert.deepEqual(offenders, []);
});

test("a hosted scan writes exactly one anonymous log line", async () => {
  // The batch's 19 refused calls are not scans, so they add no lines; the line never holds the address.
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: unknown) => { lines.push(String(line)); };
  try {
    const calls = Array.from({ length: 3 }, (_, i) => rpc("tools/call", { name: "scan_page", arguments: { url: "https://private-client.example/secret" } }, i + 1));
    const res = await createHandler({ scanner: stubScanner }).fetch(post(`[${calls.join(",")}]`), makeEnv());
    assert.equal(res.status, 200);
  } finally {
    console.log = original;
  }
  const scanLines = lines.filter((l) => l.includes('"event":"scan"'));
  assert.equal(scanLines.length, 1);
  assert.equal(JSON.parse(scanLines[0]).outcome, "scanned");
  assert.doesNotMatch(scanLines[0], /private-client|secret/);
});
