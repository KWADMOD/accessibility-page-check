import { test } from "node:test";
import assert from "node:assert/strict";
import { OwnAddressError, PageTooLargeError, describeMediaType, describeStatus } from "../fetchMessages.js";
import { BlockedAddressError } from "../urlSafety.js";
import { dohResolver, fetchPublicHtmlWeb, WEB_MAX_HTML_BYTES, type Resolver, type WebFetchOptions } from "./webFetch.js";

// No test touches the network: every case injects a fake fetchImpl and resolver.
// The fakes record what was asked so tests can prove a refusal happened before any request.

const PUBLIC_IP = "93.184.216.34";
const NOT_FOUND = "That web address could not be found. Check the spelling of the domain.";
const TOO_LARGE = "The page is larger than 2 MB, so it was not scanned.";

type Route = (url: URL) => Response;

function fakeNetwork(route: Route, addresses: Record<string, string[]> = {}) {
  const fetched: string[] = [];
  const resolved: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(init?.redirect, "manual", "every hop must use manual redirects");
    const url = new URL(String(input));
    fetched.push(url.toString());
    return route(url);
  }) as typeof fetch;
  const resolver: Resolver = async (hostname) => {
    resolved.push(hostname);
    return addresses[hostname] ?? [PUBLIC_IP];
  };
  const options: WebFetchOptions = { fetchImpl, resolver };
  return { fetched, resolved, options };
}

const html = (body: string, contentType = "text/html; charset=utf-8") =>
  new Response(body, { status: 200, headers: { "content-type": contentType } });
const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });

test("a literal private IP is refused before any request", async () => {
  const net = fakeNetwork(() => html("x"));
  await assert.rejects(fetchPublicHtmlWeb("http://127.0.0.1/", net.options), BlockedAddressError);
  assert.deepEqual(net.fetched, []);
  assert.deepEqual(net.resolved, [], "literal IPs skip the resolver");
});

test("a hostname with any private answer is refused", async () => {
  const net = fakeNetwork(() => html("x"), { "mixed.example": [PUBLIC_IP, "10.0.0.5"] });
  await assert.rejects(fetchPublicHtmlWeb("https://mixed.example/", net.options), BlockedAddressError);
  assert.deepEqual(net.fetched, []);
});

test("a hostname with no answers reads as not found", async () => {
  const net = fakeNetwork(() => html("x"), { "empty.example": [] });
  await assert.rejects(fetchPublicHtmlWeb("https://empty.example/", net.options), { message: NOT_FOUND });
  assert.deepEqual(net.fetched, []);
});

test("a redirect to cloud metadata is refused on the next hop", async () => {
  const net = fakeNetwork(() => redirect("http://169.254.169.254/latest/meta-data/"));
  await assert.rejects(fetchPublicHtmlWeb("https://example.com/", net.options), BlockedAddressError);
  assert.deepEqual(net.fetched, ["https://example.com/"]);
});

const OWN_ADDRESS = "This connector does not scan its own address.";

test("a redirect to a blocked hostname is refused before DNS, with its own message", async () => {
  const net = fakeNetwork(() => redirect("https://a11y-mcp.joelwatson.com/"));
  const options = { ...net.options, blockedHostnames: ["a11y-mcp.joelwatson.com"] };
  await assert.rejects(fetchPublicHtmlWeb("https://example.com/", options), (error: unknown) => {
    assert.ok(error instanceof OwnAddressError);
    assert.equal((error as Error).message, OWN_ADDRESS);
    return true;
  });
  assert.deepEqual(net.fetched, ["https://example.com/"]);
  assert.deepEqual(net.resolved, ["example.com"], "the blocked host is never looked up");
});

test("blocked hostnames match exactly or on a dot boundary, ignoring case and a trailing dot", async () => {
  const net = fakeNetwork(() => html("<title>ok</title>"));
  const options = { ...net.options, blockedHostnames: ["JoelWatson.com"] };
  await assert.rejects(fetchPublicHtmlWeb("https://joelwatson.com./", options), { message: OWN_ADDRESS });
  await assert.rejects(fetchPublicHtmlWeb("https://JOELWATSON.COM../", options), { message: OWN_ADDRESS });
  await assert.rejects(fetchPublicHtmlWeb("https://A11Y.JOELWATSON.COM/", options), { message: OWN_ADDRESS });
  // "notjoelwatson.com" shares the suffix but is a different domain.
  const page = await fetchPublicHtmlWeb("https://notjoelwatson.com/", options);
  assert.equal(page.html, "<title>ok</title>");
});

// The Worker blocks only its own hostname. The parent zone must stay scannable:
// the demo pages may live on joelwatson.com.
test("blocking the Worker's hostname leaves the parent domain scannable", async () => {
  const net = fakeNetwork(() => html("<title>demo</title>"));
  const options = { ...net.options, blockedHostnames: ["a11y-mcp.joelwatson.com"] };
  const page = await fetchPublicHtmlWeb("https://joelwatson.com/", options);
  assert.equal(page.html, "<title>demo</title>");
  assert.deepEqual(net.fetched, ["https://joelwatson.com/"]);
});

test("more than five redirects are refused", async () => {
  let n = 0;
  const net = fakeNetwork(() => redirect(`/hop${++n}`));
  await assert.rejects(fetchPublicHtmlWeb("https://example.com/", net.options), {
    message: "The page redirected more than 5 times, so it was not scanned.",
  });
  assert.equal(net.fetched.length, 6);
});

test("only http and https are scanned", async () => {
  const net = fakeNetwork(() => html("x"));
  await assert.rejects(fetchPublicHtmlWeb("ftp://x", net.options), { message: "Only http and https URLs can be scanned." });
  assert.deepEqual(net.fetched, []);
});

test("URLs with credentials are refused", async () => {
  const net = fakeNetwork(() => html("x"));
  await assert.rejects(fetchPublicHtmlWeb("https://user:pw@example.com/", net.options), {
    message: "URLs that contain a username or password are not scanned.",
  });
});

test("an oversized content-length is refused without reading the body", async () => {
  let pulled = false;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled = true;
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const net = fakeNetwork(() => new Response(body, { headers: { "content-type": "text/html", "content-length": "3000000" } }));
  await assert.rejects(fetchPublicHtmlWeb("https://example.com/", net.options), { message: TOO_LARGE });
  assert.equal(pulled, false, "the body must not be read");
  assert.equal(cancelled, true, "the body must be cancelled");
});

test("a streamed body that passes the cap is stopped", async () => {
  const chunk = new Uint8Array(64 * 1024).fill(0x61);
  let sent = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (sent >= 3 * 1024 * 1024) return controller.close();
        sent += chunk.length;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const net = fakeNetwork(() => new Response(body, { headers: { "content-type": "text/html" } }));
  await assert.rejects(fetchPublicHtmlWeb("https://example.com/", net.options), (error: unknown) => {
    assert.ok(error instanceof PageTooLargeError);
    assert.equal((error as Error).message, TOO_LARGE);
    return true;
  });
  assert.equal(cancelled, true);
  assert.ok(sent < 3 * 1024 * 1024, "reading stopped before the whole body arrived");
  assert.equal(WEB_MAX_HTML_BYTES, 2 * 1024 * 1024);
});

test("a non-HTML media type is refused with the shared message", async () => {
  const net = fakeNetwork(() => html("%PDF", "application/pdf"));
  await assert.rejects(fetchPublicHtmlWeb("https://example.com/doc", net.options), {
    message: `That address does not return a web page (it returned ${describeMediaType("application/pdf")}), so it was not scanned.`,
  });
});

test("the declared charset is used to decode the body", async () => {
  const bytes = new Uint8Array([0x93, 0x68, 0x69, 0x94]);
  const net = fakeNetwork(() => new Response(bytes, { headers: { "content-type": "text/html; charset=windows-1252" } }));
  const page = await fetchPublicHtmlWeb("https://example.com/", net.options);
  assert.equal(page.html, "“hi”");
});

test("an error status uses describeStatus", async () => {
  const net = fakeNetwork(() => new Response("nope", { status: 404 }));
  await assert.rejects(fetchPublicHtmlWeb("https://example.com/missing", net.options), { message: describeStatus(404) });
});

test("a redirect without a location uses describeStatus", async () => {
  const net = fakeNetwork(() => new Response(null, { status: 302 }));
  await assert.rejects(fetchPublicHtmlWeb("https://example.com/", net.options), { message: describeStatus(302) });
});

test("a redirect sets finalUrl and requestedUrl keeps the normalized input", async () => {
  const net = fakeNetwork((url) => (url.pathname === "/start" ? redirect("/final", 301) : html("<title>done</title>")));
  const page = await fetchPublicHtmlWeb("example.com/start", net.options);
  assert.equal(page.requestedUrl, "https://example.com/start");
  assert.equal(page.finalUrl, "https://example.com/final");
  assert.equal(page.html, "<title>done</title>");
});

test("the deadline covers a request that never answers", async () => {
  const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as typeof fetch;
  await assert.rejects(fetchPublicHtmlWeb("https://example.com/", { fetchImpl, resolver: async () => [PUBLIC_IP], timeoutMs: 50 }), {
    message: "The page did not finish loading within 0.05 seconds.",
  });
});

test("dohResolver keeps A and AAAA answers, skips CNAMEs and treats NXDOMAIN as not found", async () => {
  const requests: Array<{ url: URL; accept: string | null }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, accept: new Headers(init?.headers).get("accept") });
    const name = url.searchParams.get("name");
    const type = url.searchParams.get("type");
    if (name === "missing.example") return Response.json({ Status: 3 });
    if (type === "A") {
      return Response.json({
        Status: 0,
        Answer: [
          { name, type: 5, data: "target.example." },
          { name: "target.example.", type: 1, data: PUBLIC_IP },
        ],
      });
    }
    return Response.json({ Status: 0, Answer: [{ name: "target.example.", type: 28, data: "2606:2800:220:1::" }] });
  }) as typeof fetch;

  const resolver = dohResolver(fetchImpl);
  assert.deepEqual((await resolver("www.example")).sort(), ["2606:2800:220:1::", PUBLIC_IP].sort());
  assert.deepEqual(requests.map((r) => r.url.searchParams.get("type")).sort(), ["A", "AAAA"]);
  for (const r of requests) {
    assert.equal(r.url.origin + r.url.pathname, "https://cloudflare-dns.com/dns-query");
    assert.equal(r.accept, "application/dns-json");
  }
  await assert.rejects(resolver("missing.example"), { message: NOT_FOUND });
});

test("dohResolver treats an HTTP error or bad JSON as not found", async () => {
  const httpError = dohResolver((async () => new Response("busy", { status: 503 })) as typeof fetch);
  await assert.rejects(httpError("example.com"), { message: NOT_FOUND });
  const badJson = dohResolver((async () => new Response("not json", { status: 200 })) as typeof fetch);
  await assert.rejects(badJson("example.com"), { message: NOT_FOUND });
});

// Cloudflare edge codes describe the scanned site's origin, not the page, so they
// reuse the plain connection and certificate sentences instead of "HTTP 52x".
test("Cloudflare edge statuses read as connection or certificate problems", () => {
  for (const status of [522, 523, 524]) {
    assert.equal(describeStatus(status), "Could not connect to that server.", `status ${status}`);
  }
  for (const status of [525, 526]) {
    assert.equal(describeStatus(status), "The site's HTTPS certificate could not be verified, so it was not scanned.", `status ${status}`);
  }
  assert.equal(describeStatus(520), "The page returned HTTP 520, so there was nothing to scan.");
});

// Review finding: on the Worker a refused or reset connection rejects with a bare TypeError, which the
// tool layer treats as an internal bug ("Something unexpected went wrong") and logs as unexpected.
test("a network failure in fetch() reads as a plain connect message, not an internal error", async () => {
  const options: WebFetchOptions = {
    resolver: async () => [PUBLIC_IP],
    fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch,
  };
  const error = await fetchPublicHtmlWeb("https://example.com/", options).then(
    () => assert.fail("expected a rejection"),
    (e: unknown) => e,
  );
  assert.ok(error instanceof Error && !(error instanceof TypeError), "must not stay a TypeError");
  assert.equal((error as Error).message, "Could not connect to that server.");
});

test("a connection lost while reading the page says so in plain words", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("<html>"));
      controller.error(new TypeError("Network connection lost."));
    },
  });
  const net = fakeNetwork(() => new Response(body, { status: 200, headers: { "content-type": "text/html" } }));
  const error = await fetchPublicHtmlWeb("https://example.com/", net.options).then(
    () => assert.fail("expected a rejection"),
    (e: unknown) => e,
  );
  assert.ok(error instanceof Error && !(error instanceof TypeError));
  assert.equal((error as Error).message, "The connection to that site was lost before the page finished loading.");
});
