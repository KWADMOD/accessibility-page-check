import {
  FETCH_TIMEOUT_MS,
  STALL_TIMEOUT_MS,
  StalledDownloadError,
  ConnectionLostError,
  MAX_REDIRECTS,
  OwnAddressError,
  PageTooLargeError,
  assertScannableUrl,
  USER_AGENT,
  decodeBody,
  describeError,
  describeWebFetchError,
  describeStatus,
  nonHtmlError,
  parseUserUrl,
  resolveRedirect,
  tooManyRedirectsError,
  type FetchedPage,
} from "../fetchMessages.js";
import { BlockedAddressError, bareHostname, isBlockedAddress, isIpLiteral } from "../urlSafety.js";

// The Worker's only network path. It mirrors safeFetch.ts (same limits, same
// messages) using web-standard APIs only, because Workers have no node:http and
// no DNS lookup hook. Without that hook we cannot pin the address the socket
// connects to, so instead every hop resolves the hostname over DNS-over-HTTPS
// first and refuses it if any answer is private. Messages and per-hop checks come
// from fetchMessages.ts, shared with safeFetch.ts, so both runtimes say the same thing.

// 2 MB, lower than the Node 8 MB cap, because a Worker has 128 MB of memory for
// the fetch, the parse and the report together.
export const WEB_MAX_HTML_BYTES = 2 * 1024 * 1024;

/** `signal` is the scan deadline: a lookup still running when it fires is cancelled, not abandoned. */
/**
 * The hosted connector gives up on a site sooner than the local server does (10 s, not 15 s). A
 * download holds one of a few shared slots, so a long wait costs other callers more here, and
 * a page that has not arrived in ten seconds is not one a chat would wait for anyway.
 */
export const WEB_FETCH_TIMEOUT_MS = 10_000;

export type Resolver = (hostname: string, signal?: AbortSignal) => Promise<string[]>;

export interface WebFetchOptions {
  fetchImpl?: typeof fetch;
  resolver?: Resolver;
  maxBytes?: number;
  timeoutMs?: number;
  /** How long the body may go without a byte before the download is dropped. For tests; the default is STALL_TIMEOUT_MS. */
  stallTimeoutMs?: number;
  /** Hostnames (and their subdomains) never fetched, e.g. the Worker's own hostname, so a scan cannot call back into it. */
  blockedHostnames?: string[];
}

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const DNS_TYPE_A = 1;
const DNS_TYPE_AAAA = 28;

/** The same "could not find that site" sentence describeError gives for ENOTFOUND, so wording cannot drift. */
function notFoundError(): Error {
  return describeError({ code: "ENOTFOUND" }, FETCH_TIMEOUT_MS);
}

/** Resolves A and AAAA records through Cloudflare's DNS-over-HTTPS JSON API. Any failed lookup reads as "not found". */
export function dohResolver(fetchImpl: typeof fetch = fetch): Resolver {
  const query = async (hostname: string, type: "A" | "AAAA", signal?: AbortSignal): Promise<string[]> => {
    let answer: { Status?: number; Answer?: Array<{ type?: number; data?: string }> };
    try {
      const response = await fetchImpl(`${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`, {
        headers: { accept: "application/dns-json" },
        signal,
      });
      if (!response.ok) throw notFoundError();
      answer = await response.json();
    } catch {
      // A DoH outage, an HTTP error and unparseable JSON all leave us without a
      // trustworthy address list, so the scan is refused rather than guessed at.
      throw notFoundError();
    }
    // Status 0 is NOERROR; anything else (3 is NXDOMAIN, 2 is SERVFAIL) is a failed lookup.
    if (answer?.Status !== 0) throw notFoundError();
    // CNAME entries (type 5) are skipped: the resolver already followed them, and
    // the addresses they point at appear as their own A/AAAA entries.
    return (answer.Answer ?? [])
      .filter((entry) => (entry.type === DNS_TYPE_A || entry.type === DNS_TYPE_AAAA) && typeof entry.data === "string")
      .map((entry) => entry.data as string);
  };
  return async (hostname, signal) => {
    const [v4, v6] = await Promise.all([query(hostname, "A", signal), query(hostname, "AAAA", signal)]);
    return [...v4, ...v6];
  };
}

/** Equal to an entry, or a subdomain of it ("." boundary), ignoring case and a trailing dot. */
function isBlockedHostname(hostname: string, blockedHostnames: string[]): boolean {
  // Strip every trailing dot, not just one: "host.." must not slip past the check.
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  return blockedHostnames.some((raw) => {
    const entry = raw.toLowerCase().replace(/\.+$/, "");
    return entry !== "" && (host === entry || host.endsWith(`.${entry}`));
  });
}

/** Rejects when the signal fires, so a resolver with no signal of its own still obeys the scan deadline. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Checks the host of one hop. Throws OwnAddressError, BlockedAddressError, or the not-found message for an empty answer. */
async function assertPublicHost(target: URL, resolver: Resolver, blockedHostnames: string[], signal: AbortSignal): Promise<void> {
  const host = bareHostname(target);
  // Before DNS, so the Worker's own hostname is refused even though it resolves to public addresses.
  if (isBlockedHostname(host, blockedHostnames)) throw new OwnAddressError();
  if (isIpLiteral(host)) {
    if (isBlockedAddress(host)) throw new BlockedAddressError();
    return;
  }
  const addresses = await untilAborted(resolver(host, signal), signal);
  if (addresses.length === 0) throw notFoundError();
  // Refuse if any answer is private: fetch() may connect to whichever one it likes.
  if (addresses.some((address) => isBlockedAddress(address))) throw new BlockedAddressError();
}

/** Best-effort discard of a body we will not read; a failure here changes nothing for the user. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already closed or errored: nothing left to release.
  }
}

/** One read from the body, failing with StalledDownloadError if nothing arrives within stallMs. */
async function readWithStall(reader: ReadableStreamDefaultReader<Uint8Array>, stallMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StalledDownloadError()), stallMs);
  });
  try {
    return await Promise.race([reader.read(), stalled]);
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(response: Response, maxBytes: number, stallMs: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await discardBody(response);
    throw new PageTooLargeError(maxBytes);
  }
  if (!response.body) return new Uint8Array(0);

  // Workers and Node fetch decompress gzip/br for us, so these are decompressed
  // bytes. That is the number that matters: a small compressed page can expand far
  // past the cap, and content-length (the compressed size) would not catch it.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await readWithStall(reader, stallMs);
    } catch (error) {
      // Release the connection; a stalled body would otherwise stay open until the deadline.
      await reader.cancel().catch(() => undefined);
      // The stream itself failing (a bare TypeError on the Worker) is a lost connection. Only this
      // read is translated, so a bug elsewhere in our code is still reported as unexpected.
      throw error instanceof TypeError ? new ConnectionLostError() : error;
    }
    const { done, value } = result;
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new PageTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function fetchPublicHtmlWeb(url: string, options: WebFetchOptions = {}): Promise<FetchedPage> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolver = options.resolver ?? dohResolver(fetchImpl);
  const maxBytes = options.maxBytes ?? WEB_MAX_HTML_BYTES;
  const timeoutMs = options.timeoutMs ?? WEB_FETCH_TIMEOUT_MS;
  const blockedHostnames = options.blockedHostnames ?? [];

  let current = parseUserUrl(url);
  const requestedUrl = current.toString();

  // One deadline covers the whole scan: DNS, redirects and body included.
  const signal = AbortSignal.timeout(timeoutMs);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertScannableUrl(current);

    let response: Response;
    try {
      // Re-checked on every hop, so a public page cannot bounce the scanner onto an internal address.
      await assertPublicHost(current, resolver, blockedHostnames, signal);
    } catch (error) {
      throw describeError(error, timeoutMs, signal);
    }
    try {
      response = await fetchImpl(current.toString(), {
        method: "GET",
        // Manual, so each redirect target passes assertPublicHost before it is requested.
        redirect: "manual",
        signal,
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml",
        },
      });
    } catch (error) {
      // Only fetch() itself is in this block, so a TypeError here is a network failure, not our bug.
      throw describeWebFetchError(error, timeoutMs, signal);
    }

    const status = response.status;
    const location = response.headers.get("location");
    if (status >= 300 && status < 400 && location) {
      await discardBody(response);
      current = resolveRedirect(location, current);
      continue;
    }
    if (status < 200 || status >= 300) {
      await discardBody(response);
      throw new Error(describeStatus(status));
    }

    const contentType = response.headers.get("content-type") ?? "";
    const typeError = nonHtmlError(contentType);
    if (typeError) {
      await discardBody(response);
      throw typeError;
    }

    let body: Uint8Array;
    try {
      body = await readCapped(response, maxBytes, options.stallTimeoutMs ?? STALL_TIMEOUT_MS);
    } catch (error) {
      // Keep our own size-cap and stall messages. A lost connection is reported as such unless the
      // deadline is what cut the stream, in which case describeError gives the time-limit message.
      if (error instanceof PageTooLargeError || error instanceof StalledDownloadError) throw error;
      if (error instanceof ConnectionLostError && !signal.aborted) throw error;
      throw describeError(error, timeoutMs, signal);
    }
    // Outside the try on purpose: a bug in decoding must surface as an unexpected error, not as a network one.
    return { html: decodeBody(body, contentType), requestedUrl, finalUrl: current.toString() };
  }
  throw tooManyRedirectsError();
}
