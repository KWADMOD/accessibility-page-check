import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { formatReport } from "../report.js";
import { MAX_CONCURRENT_ANALYSES, MAX_WAITING_ANALYSES, withAnalysisSlot } from "../analyze.js";
import { createLocalScanner } from "./localScanner.js";

// The whole scan path with nothing mocked: real fetch, worker thread, checks and
// report. The only difference from a live scan is that this server's address is
// allowed, because tests have no public internet to talk to.

let server: http.Server;
let base: string;
let scanner: ReturnType<typeof createLocalScanner>;
let requestCount = 0;

before(async () => {
  server = http.createServer((req, res) => {
    requestCount++;
    if (req.url === "/old") return void res.writeHead(301, { location: "/page" }).end();
    if (req.url === "/shell") {
      return void res.writeHead(200, { "content-type": "text/html" }).end(`<html lang="en"><title>App</title><body><div id="root"></div><script src="/app.js"></script></body></html>`);
    }
    res.writeHead(200, { "content-type": "text/html" }).end(
      `<html><head></head><body><h1>Shop</h1><img src="/a.png"><a href="/x" aria-hidden="true" tabindex="-1"></a><button><svg role="img" aria-label="Close"></svg></button></body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  scanner = createLocalScanner({ testAllowedHosts: [`127.0.0.1:${port}`] });
});

after(() => {
  server.closeAllConnections();
  server.close();
});

test("scans a page end to end and the report shows what matters", async () => {
  const result = await scanner.scan(`${base}/page`);
  assert.deepEqual(result.findings.map((f) => f.ruleId).sort(), ["html-lang", "img-alt", "page-title"]);
  const report = formatReport(result);
  assert.match(report, /Images are missing alt text/);
  assert.match(report, /not evidence of legal compliance/);
  // The hidden duplicate link and the named icon button must not appear.
  assert.ok(!/Links have no readable name|Buttons have no readable name/.test(report));
});

test("reports the page that a redirect led to", async () => {
  const result = await scanner.scan(`${base}/old`);
  assert.equal(result.finalUrl, `${base}/page`);
  assert.match(formatReport(result), /redirected/);
});

test("warns that a script-built page may be mostly unscanned", async () => {
  const result = await scanner.scan(`${base}/shell`);
  assert.equal(result.notes?.length, 1);
  assert.match(formatReport(result), /WARNING: .*JavaScript/);
});

test("a scan is refused before the page is downloaded when the analysis queue is full", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const held = Array.from({ length: MAX_CONCURRENT_ANALYSES + MAX_WAITING_ANALYSES }, () => withAnalysisSlot(() => gate));
  const before = requestCount;
  try {
    await assert.rejects(scanner.scan(`${base}/page`), /busy/);
    // The point of the early check: a refused scan must not cost a download.
    assert.equal(requestCount, before);
  } finally {
    release();
    await Promise.all(held);
  }
  // With the queue free again the same scan goes through and does fetch.
  await scanner.scan(`${base}/page`);
  assert.equal(requestCount, before + 1);
});
