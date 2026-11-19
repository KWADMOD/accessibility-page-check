import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import { FETCH_TIMEOUT_MS, STALL_TIMEOUT_MS, USER_AGENT, decodeBody, describeError } from "./fetchMessages.js";
import { describeForLog } from "./logSafety.js";
import { fetchPublicHtml } from "./safeFetch.js";
import { isBlockedAddress } from "./urlSafety.js";
import { WEB_FETCH_TIMEOUT_MS, dohResolver, fetchPublicHtmlWeb } from "./web/webFetch.js";

// Small fixes from the pre-launch review, each pinned by a test.

test("raw system error codes become plain sentences", () => {
  const withCode = (code: string) => Object.assign(new Error(`connect ${code} 1.2.3.4:443`), { code });
  assert.match(describeError(withCode("ETIMEDOUT"), 15000).message, /did not answer in time/);
  assert.match(describeError(withCode("EPROTO"), 15000).message, /secure \(HTTPS\) connection/);
  assert.match(describeError(withCode("ERR_SSL_WRONG_VERSION_NUMBER"), 15000).message, /secure \(HTTPS\) connection/);
  assert.match(describeError(withCode("EMFILE"), 15000).message, /network problem/);
  // Node reports "every address failed" as an AggregateError with an empty message.
  const aggregate = Object.assign(new AggregateError([], ""), { code: undefined });
  assert.match(describeError(aggregate, 15000).message, /Could not connect/);
  assert.match(describeError(new Error("   "), 15000).message, /Could not connect/);
  // Our own readable errors pass through untouched.
  const ours = new Error("The page is larger than 8 MB, so it was not scanned.");
  assert.equal(describeError(ours, 15000), ours);
  // The code itself never reaches the reader.
  assert.doesNotMatch(describeError(withCode("EMFILE"), 15000).message, /EMFILE/);
});

test("IPv6 ranges that can smuggle an IPv4 target are blocked", () => {
  assert.equal(isBlockedAddress("64:ff9b:1::7f00:1"), true, "local-use NAT64 (RFC 8215)");
  assert.equal(isBlockedAddress("2001:2::1"), true, "benchmarking, inside 2001::/23");
  assert.equal(isBlockedAddress("2001:1::1"), true, "inside 2001::/23");
  assert.equal(isBlockedAddress("2001:10::1"), true, "ORCHID, inside 2001::/23");
  assert.equal(isBlockedAddress("3fff::1"), true, "documentation range RFC 9637");
  assert.equal(isBlockedAddress("3fff:fff::1"), true);
  assert.equal(isBlockedAddress("5f00::1"), true, "SRv6 SIDs");
  // Just past the block, and ordinary public space, stay reachable.
  assert.equal(isBlockedAddress("2001:200::1"), false);
  assert.equal(isBlockedAddress("2606:4700:4700::1111"), false);
});

test("the user agent tells a site owner what this is and where to read about it", () => {
  assert.match(USER_AGENT, /^accessibility-mcp-demo\/\d+\.\d+\.\d+ /);
  assert.match(USER_AGENT, /https:\/\/joelwatson\.com\/a11y-mcp\//);
});

test("pages are decoded by byte-order mark, then header, then meta tag, then UTF-8", () => {
  const encode = (text: string, label: "latin1" | "utf8") => new Uint8Array(Buffer.from(text, label));
  const cafe = (charsetBit: string) => `<html><head>${charsetBit}</head><body>café “quoted”</body></html>`;
  // windows-1252 with only a <meta> declaration (no header): the curly quotes need 1252, not Latin-1 or UTF-8.
  const cp1252 = Uint8Array.from([...Buffer.from(cafe('<meta charset="windows-1252">').replace(/[“”]/g, "?"), "latin1")]);
  assert.match(decodeBody(cp1252, "text/html"), /café/);
  // The header beats the meta tag when both exist and disagree.
  assert.match(decodeBody(encode(cafe('<meta charset="utf-8">'), "latin1"), "text/html; charset=iso-8859-1"), /café/);
  // The http-equiv form.
  assert.match(decodeBody(encode(cafe('<meta http-equiv="Content-Type" content="text/html; charset=ISO-8859-1">'), "latin1"), ""), /café/);
  // UTF-16 with a byte-order mark, which decoded as garbage before.
  const utf16 = Uint8Array.from([0xff, 0xfe, ...Buffer.from("<p>café</p>", "utf16le")]);
  assert.equal(decodeBody(utf16, "text/html"), "<p>café</p>");
  // A <meta> claiming UTF-16 on ASCII-compatible bytes is read as UTF-8, as browsers do, not as garbage.
  assert.equal(decodeBody(encode('<meta charset="utf-16"><p>ok</p>', "utf8"), "text/html"), '<meta charset="utf-16"><p>ok</p>');
  // An unknown label falls through to UTF-8 instead of failing.
  assert.equal(decodeBody(encode("<p>ok</p>", "utf8"), "text/html; charset=klingon"), "<p>ok</p>");
});

test("a log line names the error but not the page that was being scanned", () => {
  const line = describeForLog(new TypeError("Failed to fetch https://private-client.example/secret?token=abc from here"));
  assert.match(line, /^TypeError: /);
  assert.doesNotMatch(line, /private-client|token/);
  assert.match(line, /\[address removed\]/);
  assert.doesNotMatch(describeForLog(new Error("x".repeat(5000))), /x{301}/);
  assert.equal(describeForLog("plain string"), "string: plain string");
});

test("the DNS-over-HTTPS lookup is handed the scan deadline so it can be cancelled", async () => {
  const seen: Array<AbortSignal | null | undefined> = [];
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(init?.signal);
    return new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: "93.184.216.34" }] }), { status: 200 });
  }) as typeof fetch;
  const controller = new AbortController();
  const addresses = await dohResolver(fakeFetch)("example.com", controller.signal);
  assert.deepEqual(addresses, ["93.184.216.34", "93.184.216.34"]);
  assert.equal(seen.length, 2, "one query for A, one for AAAA");
  assert.ok(seen.every((signal) => signal === controller.signal));
});

// A server that stacks two codings ("gzip, br" means gzip first, then brotli on top).
test("a page with two stacked Content-Encoding values is decoded", async () => {
  const html = `<html lang="en"><head><title>Stacked</title></head><body><h1>Hello</h1></body></html>`;
  const body = zlib.brotliCompressSync(zlib.gzipSync(html));
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip, br" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const page = await fetchPublicHtml(`http://127.0.0.1:${port}/`, { testAllowedHosts: [`127.0.0.1:${port}`] });
    assert.equal(page.html, html);
  } finally {
    server.close();
  }
});

// A server listing thousands of codings made one scan run for over a minute (the deadline is 15 s).
test("more than two stacked Content-Encoding values are refused quickly", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html", "content-encoding": Array(3000).fill("gzip").join(",") });
    res.end(zlib.gzipSync("<html></html>"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const started = Date.now();
    await assert.rejects(
      fetchPublicHtml(`http://127.0.0.1:${port}/`, { testAllowedHosts: [`127.0.0.1:${port}`] }),
      /compressed that page in an unusual way/,
    );
    assert.ok(Date.now() - started < 2000);
  } finally {
    server.close();
  }
});

test("a stalled gzip body is cut off at the deadline and its decoders are torn down", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip, gzip" });
    res.write(zlib.gzipSync(zlib.gzipSync("<html>")).subarray(0, 10)); // a partial body, then silence
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const started = Date.now();
    await assert.rejects(
      fetchPublicHtml(`http://127.0.0.1:${port}/`, { testAllowedHosts: [`127.0.0.1:${port}`], timeoutMs: 600 }),
      /did not finish loading within 0.6 seconds/,
    );
    assert.ok(Date.now() - started < 3000, "the deadline must not be overrun");
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

// ---- Stall timeout: a site that sends a few bytes and then goes quiet must not hold a download slot ----

const stallHtml = `<html lang="en"><head><title>Slow</title></head><body><h1>Hello</h1></body></html>`;

test("a download that goes quiet partway through is dropped long before the overall deadline (Node)", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.write(stallHtml.slice(0, 20)); // a few bytes, then silence
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const started = Date.now();
    await assert.rejects(
      fetchPublicHtml(`http://127.0.0.1:${port}/`, { testAllowedHosts: [`127.0.0.1:${port}`], stallTimeoutMs: 300 }),
      /stopped sending data partway through/,
    );
    // The overall deadline is 15 s; the stall must end it in a fraction of that.
    assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("a slow but steady download is not mistaken for a stalled one (Node)", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    // One piece every 100 ms for about a second: slower than normal, but never quiet for 400 ms.
    const pieces = stallHtml.match(/.{1,10}/g) ?? [];
    let i = 0;
    const timer = setInterval(() => {
      if (i < pieces.length) res.write(pieces[i++]);
      else {
        clearInterval(timer);
        res.end();
      }
    }, 100);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const page = await fetchPublicHtml(`http://127.0.0.1:${port}/`, { testAllowedHosts: [`127.0.0.1:${port}`], stallTimeoutMs: 400 });
    assert.equal(page.html, stallHtml);
  } finally {
    server.close();
  }
});

// A response whose body gives the pieces it is told to, then either ends or goes silent.
function streamedPage(pieces: string[], endAfter: boolean, gapMs = 0): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i < pieces.length) {
        if (gapMs) await new Promise((resolve) => setTimeout(resolve, gapMs));
        controller.enqueue(encoder.encode(pieces[i++]));
      } else if (endAfter) {
        controller.close();
      } else {
        await new Promise(() => undefined); // never another byte
      }
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}
const publicResolver = async () => ["93.184.216.34"];

test("a download that goes quiet partway through is dropped (Worker)", async () => {
  const fetchImpl = (async () => streamedPage([stallHtml.slice(0, 20)], false)) as typeof fetch;
  const started = Date.now();
  await assert.rejects(
    fetchPublicHtmlWeb("https://slow.example/", { fetchImpl, resolver: publicResolver, stallTimeoutMs: 250 }),
    /stopped sending data partway through/,
  );
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});

test("a slow but steady download is not dropped (Worker)", async () => {
  const pieces = stallHtml.match(/.{1,10}/g) ?? [];
  const fetchImpl = (async () => streamedPage(pieces, true, 60)) as typeof fetch;
  const page = await fetchPublicHtmlWeb("https://steady.example/", { fetchImpl, resolver: publicResolver, stallTimeoutMs: 400 });
  assert.equal(page.html, stallHtml);
});

test("the hosted connector waits less overall than the local server, and the stall limit is shorter still", () => {
  assert.equal(WEB_FETCH_TIMEOUT_MS, 10_000);
  assert.equal(STALL_TIMEOUT_MS, 5_000);
  assert.ok(STALL_TIMEOUT_MS < WEB_FETCH_TIMEOUT_MS && WEB_FETCH_TIMEOUT_MS < FETCH_TIMEOUT_MS);
});
