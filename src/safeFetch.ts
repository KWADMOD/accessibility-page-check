import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { pipeline, type Readable } from "node:stream";
import zlib from "node:zlib";
import {
  FETCH_TIMEOUT_MS,
  MAX_REDIRECTS,
  STALL_TIMEOUT_MS,
  StalledDownloadError,
  PageTooLargeError,
  USER_AGENT,
  assertScannableUrl,
  decodeBody,
  describeError,
  describeMediaType,
  describeStatus,
  nonHtmlError,
  parseUserUrl,
  resolveRedirect,
  tooManyRedirectsError,
  type FetchedPage,
} from "./fetchMessages.js";
import { BlockedAddressError, bareHostname, isBlockedAddress, isIpLiteral } from "./urlSafety.js";

// Re-exported so existing importers keep working after the move.
export { FETCH_TIMEOUT_MS, describeError, describeMediaType, describeStatus, type FetchedPage };

// Fetches one public HTML page with hard limits. We use node:http/https rather
// than fetch() for two reasons: (1) the DNS lookup hook lets us validate the
// exact address the socket will connect to, which closes the gap where a name
// resolves to a public address when checked and a private one when connected
// (DNS rebinding); (2) the body is read as a stream, so the size cap really
// stops the download instead of firing after it finished.

// 8 MB, because real single-file sites (joelwatson.com is ~3 MB of HTML) exceed a 2 MB cap.
export const MAX_HTML_BYTES = 8 * 1024 * 1024;

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /**
   * For automated tests only, never wired to the tool or an env var. Lists exact
   * "host:port" values (as URL.host prints them) that skip the private-address
   * check. It is per host, not global, so a test can still prove that a redirect
   * from an allowed host to a private address is refused.
   */
  testAllowedHosts?: string[];
  /** How long the body may go without a byte before the download is dropped. For tests; the default is STALL_TIMEOUT_MS. */
  stallTimeoutMs?: number;
}

// Refuses private addresses at connect time, for every hostname.
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "", 4);
    if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address))) {
      return callback(new BlockedAddressError(), "", 4);
    }
    if (options.all) return callback(null, addresses, 4);
    return callback(null, addresses[0].address, addresses[0].family);
  });
};

/**
 * Our own agents instead of Node's global ones. With NODE_USE_ENV_PROXY and HTTP(S)_PROXY set (common
 * on corporate machines), the global agents send requests through the proxy. guardedLookup then only
 * sees the proxy's address and the proxy resolves the real host itself, so an intranet hostname was
 * fetched and the private-address check never ran. Agents we create never read the proxy settings.
 */
const HTTP_AGENT = new http.Agent();
const HTTPS_AGENT = new https.Agent();

function requestOnce(target: URL, signal: AbortSignal, hostIsAllowed: boolean): Promise<http.IncomingMessage> {
  const host = bareHostname(target);
  // IP literals skip the DNS hook, so they are checked here.
  if (!hostIsAllowed && isIpLiteral(host) && isBlockedAddress(host)) {
    return Promise.reject(new BlockedAddressError());
  }
  const client = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      target,
      {
        method: "GET",
        signal,
        agent: target.protocol === "https:" ? HTTPS_AGENT : HTTP_AGENT,
        lookup: hostIsAllowed ? undefined : guardedLookup,
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml",
          "accept-encoding": "gzip, deflate, br",
        },
      },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
}

type Decoder = zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress;

function decoderFor(encoding: string): Decoder | null {
  switch (encoding) {
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "deflate":
      return zlib.createInflate();
    case "br":
      return zlib.createBrotliDecompress();
    default:
      return null;
  }
}

/**
 * One decoder per coding listed in Content-Encoding, in the order they must be undone: the
 * header lists the order they were applied ("gzip, br" means gzip first, then br), so the
 * last one is removed first. "identity" means none. An unknown coding gives no decoders
 * at all, as before, so the bytes are read untouched rather than half-decoded.
 */
// Real servers use one coding, rarely two. Each extra decoder is another stream to keep alive, and a
// header of a few thousand "gzip" values made one scan run for over a minute, far past its 15 s deadline.
const MAX_CONTENT_CODINGS = 2;

function decodersFor(header: string | undefined): Decoder[] {
  const codings = (header ?? "")
    .toLowerCase()
    .split(",")
    .map((coding) => coding.trim())
    .filter((coding) => coding !== "" && coding !== "identity");
  if (codings.length > MAX_CONTENT_CODINGS) {
    throw new Error("The server compressed that page in an unusual way, so it was not scanned.");
  }
  const decoders: Decoder[] = [];
  for (const coding of codings.reverse()) {
    const decoder = decoderFor(coding);
    if (!decoder) {
      for (const made of decoders) made.destroy();
      return [];
    }
    decoders.push(decoder);
  }
  return decoders;
}

async function readCapped(res: http.IncomingMessage, maxBytes: number, signal: AbortSignal, stallMs: number): Promise<Buffer> {
  let decoders: Decoder[];
  try {
    decoders = decodersFor(res.headers["content-encoding"]);
  } catch (error) {
    res.destroy(); // refusing the page: do not leave its response half-read
    throw error;
  }
  let source: Readable = res;
  if (decoders.length > 0) {
    // pipeline (not .pipe) so an abort or error on the response destroys every
    // decoder too. With .pipe the decoder never finished, and a stalled gzip
    // body hung past the timeout. Errors reach us through the iteration below.
    pipeline([res, ...decoders], () => undefined);
    // When the scan deadline fires, tear the whole chain down. Aborting the request does not do it once
    // the response has already arrived, so a stack of decoders kept running past the deadline.
    const teardown = () => {
      res.destroy();
      for (const decoder of decoders) decoder.destroy();
    };
    if (signal.aborted) teardown();
    else signal.addEventListener("abort", teardown, { once: true });
    source = decoders[decoders.length - 1];
  }
  const chunks: Buffer[] = [];
  let total = 0;
  // A timer that restarts on every chunk: if it ever runs out, nothing has arrived for stallMs. The whole
  // chain is destroyed so the loop below ends, and the stall (not the resulting stream error) is reported.
  let stalled = false;
  let stallTimer: NodeJS.Timeout | undefined;
  const armStallTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      res.destroy();
      source.destroy();
    }, stallMs);
  };
  armStallTimer();
  try {
    // The cap applies to decompressed bytes, so a small compressed bomb cannot slip past.
    for await (const chunk of source) {
      armStallTimer();
      total += (chunk as Buffer).length;
      if (total > maxBytes) {
        res.destroy();
        source.destroy();
        throw new PageTooLargeError(maxBytes);
      }
      chunks.push(chunk as Buffer);
    }
  } catch (error) {
    if (stalled) throw new StalledDownloadError();
    throw error;
  } finally {
    clearTimeout(stallTimer);
  }
  // Destroying a stream can end the loop quietly instead of throwing.
  if (stalled) throw new StalledDownloadError();
  return Buffer.concat(chunks);
}

export async function fetchPublicHtml(url: string, options: SafeFetchOptions = {}): Promise<FetchedPage> {
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_HTML_BYTES;
  const allowedHosts = options.testAllowedHosts ?? [];

  let current = parseUserUrl(url);

  const requestedUrl = current.toString();

  // One deadline covers the whole scan, redirects and body included.
  const signal = AbortSignal.timeout(timeoutMs);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertScannableUrl(current);

    let res: http.IncomingMessage;
    try {
      res = await requestOnce(current, signal, allowedHosts.includes(current.host));
    } catch (error) {
      throw describeError(error, timeoutMs, signal);
    }

    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.destroy();
      // Each redirect target is re-checked on the next loop pass, so a public
      // page cannot bounce the scanner onto an internal address.
      current = resolveRedirect(res.headers.location, current);
      continue;
    }
    if (status < 200 || status >= 300) {
      res.destroy();
      throw new Error(describeStatus(status));
    }

    const contentType = res.headers["content-type"] ?? "";
    const typeError = nonHtmlError(contentType);
    if (typeError) {
      res.destroy();
      throw typeError;
    }

    try {
      const body = await readCapped(res, maxBytes, signal, options.stallTimeoutMs ?? STALL_TIMEOUT_MS);
      return { html: decodeBody(body, contentType), requestedUrl, finalUrl: current.toString() };
    } catch (error) {
      // Keep our own size-cap message; translate everything else.
      if (error instanceof PageTooLargeError || error instanceof StalledDownloadError) throw error;
      throw describeError(error, timeoutMs, signal);
    }
  }
  throw tooManyRedirectsError();
}
