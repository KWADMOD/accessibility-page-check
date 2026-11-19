import { BlockedAddressError, normalizeUserUrl } from "./urlSafety.js";
import { VERSION } from "./version.js";

// Why this is its own file: these limits, plain-English messages and per-hop checks are shared by the
// Node fetcher and the Worker fetcher, and need nothing from node:*.

export const FETCH_TIMEOUT_MS = 15_000;

/**
 * How long a download may go without receiving a single byte before it is dropped. The overall
 * deadline alone lets a site that sends a few bytes at a time (a "slow drip") hold a download slot
 * for the whole deadline while using no CPU, which is how a handful of such pages could keep
 * everyone else waiting. Real sites send continuously, so five quiet seconds means it has stalled.
 */
export const STALL_TIMEOUT_MS = 5_000;

/** The body stopped arriving partway through. Its own class so callers can pass it through untranslated. */
export class StalledDownloadError extends Error {
  constructor() {
    super("The site stopped sending data partway through, so the page was not scanned.");
    this.name = "StalledDownloadError";
  }
}

/**
 * The response body stream failed (on the Worker, a bare TypeError from reader.read()). Raised only
 * around the read itself, so a bug in our own decoding code still surfaces as an unexpected error.
 */
export class ConnectionLostError extends Error {
  constructor() {
    super("The connection to that site was lost before the page finished loading.");
    this.name = "ConnectionLostError";
  }
}

/**
 * Sent with every fetch. The address lets a site owner who sees this in their logs find out
 * what it is and how to ask for it to stop; a bare product name gives them nothing to act on.
 */
export const USER_AGENT = `accessibility-mcp-demo/${VERSION} (read-only accessibility scan; +https://joelwatson.com/a11y-mcp/)`;
export const MAX_REDIRECTS = 5;

export interface FetchedPage {
  html: string;
  /** The address as understood after tidying (scheme added if missing). */
  requestedUrl: string;
  /** The URL actually read, after any redirects. */
  finalUrl: string;
}

/**
 * Refusal for the scanner's own hostname. Its own class and sentence because the
 * Worker's address is public: the private-network sentence would be untrue there.
 * Private IPs keep using BlockedAddressError.
 */
export class OwnAddressError extends Error {
  constructor() {
    super("This connector does not scan its own address.");
    this.name = "OwnAddressError";
  }
}

// OpenSSL / Node codes that mean "the certificate is not trustworthy".
const CERTIFICATE_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_UNTRUSTED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

// Shared so describeError and describeStatus cannot drift apart in wording.
const CERTIFICATE_MESSAGE = "The site's HTTPS certificate could not be verified, so it was not scanned.";
const CONNECT_MESSAGE = "Could not connect to that server.";

/**
 * describeError for a failed fetch() call on the Worker. There a refused, reset or unreachable
 * connection rejects with a plain TypeError that carries no error code, so describeError passed it
 * through and the tool layer, which treats TypeError as an internal bug, showed "Something unexpected
 * went wrong" and logged it as unexpected. Call this only around fetch() itself, where a TypeError is
 * a network failure. The deadline is checked first, exactly as describeError does.
 */
export function describeWebFetchError(error: unknown, timeoutMs: number, signal: AbortSignal): Error {
  if (error instanceof TypeError && !signal.aborted) return new Error(CONNECT_MESSAGE);
  return describeError(error, timeoutMs, signal);
}

/**
 * Turns low-level socket errors into one sentence a non-developer can act on.
 * The deadline is checked first: when it fires, Node reports the aborted socket
 * as ECONNRESET, which would otherwise read as "connection refused".
 */
export function describeError(error: unknown, timeoutMs: number, signal?: AbortSignal): Error {
  if (error instanceof BlockedAddressError || error instanceof OwnAddressError) return error;
  // Structural type instead of NodeJS.ErrnoException so this file needs no Node typings.
  const e = error as { name?: string; code?: string; syscall?: string } | null;
  if (signal?.aborted || e?.name === "AbortError" || e?.name === "TimeoutError" || e?.code === "ABORT_ERR") {
    return new Error(`The page did not finish loading within ${timeoutMs / 1000} seconds.`);
  }
  // Any DNS failure, including malformed names such as an over-long label (EINVAL).
  if (e?.code === "ENOTFOUND" || e?.code === "EAI_AGAIN" || e?.syscall === "getaddrinfo") {
    return new Error("That web address could not be found. Check the spelling of the domain.");
  }
  if (typeof e?.code === "string" && CERTIFICATE_ERROR_CODES.has(e.code)) {
    return new Error(CERTIFICATE_MESSAGE);
  }
  if (e?.code === "ETIMEDOUT" || e?.code === "ESOCKETTIMEDOUT") {
    return new Error(`The server did not answer in time (the limit is ${timeoutMs / 1000} seconds).`);
  }
  if (e?.code === "ECONNREFUSED" || e?.code === "ECONNRESET" || e?.code === "EHOSTUNREACH" || e?.code === "ENETUNREACH" || e?.code === "ECONNABORTED") {
    return new Error(CONNECT_MESSAGE);
  }
  // OpenSSL and TLS failures that are not a certificate problem (no common protocol, bad handshake).
  if (typeof e?.code === "string" && /^(ERR_SSL_|ERR_TLS_|EPROTO$)/.test(e.code)) {
    return new Error("A secure (HTTPS) connection to that site could not be set up, so it was not scanned.");
  }
  // When every address of a site fails, Node reports an AggregateError, often with an empty message.
  if (e?.name === "AggregateError") return new Error(CONNECT_MESSAGE);
  // Any other system error code is jargon to this reader; keep the code out of their way.
  if (typeof e?.code === "string") return new Error("The page could not be fetched because of a network problem.");
  if (error instanceof Error) return error.message.trim() ? error : new Error(CONNECT_MESSAGE);
  return new Error(String(error));
}

// The Content-Type header is written by the scanned server and ends up in an
// error shown to the user, so only well-known types are repeated back. Anything
// else, however it is shaped, is described generically: a hostile server could
// otherwise put a sentence of instructions in the subtype.
const KNOWN_MEDIA_TYPES = /^(application\/(json|pdf|xml|zip|octet-stream|javascript)|text\/(plain|css|xml|csv|javascript)|(image|audio|video)\/[a-z0-9.+-]{1,10})$/;

export function describeMediaType(mediaType: string): string {
  return KNOWN_MEDIA_TYPES.test(mediaType) ? mediaType : "an unrecognized type";
}

/** Plain-English reason for a non-2xx status, since 403/429 usually mean "bots not welcome". */
export function describeStatus(status: number): string {
  if (status === 401 || status === 403) {
    return `The site answered HTTP ${status}, which usually means it blocks automated requests or needs a login. It was not scanned, and this tool does not try to get around that.`;
  }
  // 429 is "too many requests", not a login wall: sites such as google.com answer it to automated
  // visitors from cloud networks. Saying "needs a login" there sent people looking for the wrong fix.
  if (status === 429) {
    return "The site is limiting automated requests (HTTP 429), so it was not scanned. Some sites always answer this to automated scanners; others allow it again later. This tool does not try to get around that.";
  }
  // Cloudflare edge codes: the scanned site sits behind Cloudflare, which could not
  // reach or time out waiting for its origin (522 to 524), or could not validate the
  // origin's certificate (525, 526). 524 also gets the connect sentence: our timeout
  // sentence names our own deadline, which is not the one that fired.
  if (status === 522 || status === 523 || status === 524) return CONNECT_MESSAGE;
  if (status === 525 || status === 526) return CERTIFICATE_MESSAGE;
  if (status === 404 || status === 410) {
    return `The page was not found (HTTP ${status}). Check the address.`;
  }
  return `The page returned HTTP ${status}, so there was nothing to scan.`;
}

// ---- Per-hop checks and body handling shared by safeFetch.ts and web/webFetch.ts.
// Kept here (not in either fetcher) so both runtimes refuse the same things in the
// same words, and nothing here touches node:*, so the Worker can import it.

/** The download passed the size cap. Its own class so callers can keep it untranslated with instanceof. */
export class PageTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`The page is larger than ${Math.round(maxBytes / (1024 * 1024))} MB, so it was not scanned.`);
    this.name = "PageTooLargeError";
  }
}

/** Parses the user's address (adding https:// when no scheme was typed). */
export function parseUserUrl(url: string): URL {
  try {
    return new URL(normalizeUserUrl(url));
  } catch {
    throw new Error("That is not a valid URL. Include the full address, for example https://example.com/page.");
  }
}

/** Refuses a hop that is not plain http(s) or that carries credentials. Run on every hop, redirects included. */
export function assertScannableUrl(target: URL): void {
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("Only http and https URLs can be scanned.");
  }
  if (target.username || target.password) {
    throw new Error("URLs that contain a username or password are not scanned.");
  }
}

/** Resolves a Location header against the current URL; it is checked again as the next hop. */
export function resolveRedirect(location: string, current: URL): URL {
  try {
    return new URL(location, current);
  } catch {
    throw new Error("The page redirected to an address that is not valid.");
  }
}

export function tooManyRedirectsError(): Error {
  return new Error(`The page redirected more than ${MAX_REDIRECTS} times, so it was not scanned.`);
}

/**
 * The refusal for a clearly non-HTML Content-Type, or null when the page may be read.
 * Returned rather than thrown so each fetcher can release its body first. A missing
 * type is allowed, because some servers omit it.
 */
export function nonHtmlError(contentType: string): Error | null {
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  if (!mediaType || mediaType === "text/html" || mediaType === "application/xhtml+xml") return null;
  return new Error(`That address does not return a web page (it returned ${describeMediaType(mediaType)}), so it was not scanned.`);
}

/** Maps a charset label to one TextDecoder accepts, or null when the runtime does not know it. */
function decoderForLabel(label: string): TextDecoder | null {
  try {
    return new TextDecoder(label);
  } catch {
    return null;
  }
}

/**
 * Finds a charset the page declares for itself in its first 1,024 bytes, the way browsers do:
 * <meta charset="..."> or <meta http-equiv="Content-Type" content="...; charset=...">.
 * The bytes are read as Latin-1 only to find the ASCII label; the label is then applied to the real bytes.
 */
function charsetFromMeta(body: Uint8Array): string | null {
  const head = new TextDecoder("latin1").decode(body.subarray(0, 1024));
  return /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head)?.[1] ?? null;
}

/**
 * Decodes the page the way a browser would, in the browser's order: a byte-order mark wins,
 * then the Content-Type header, then a <meta> declaration, then UTF-8 (the web's default).
 * Without the BOM and meta steps a UTF-16 page decoded as garbage and a windows-1252 page with
 * no header showed broken punctuation. Unknown or unsupported labels fall through to the next step.
 */
export function decodeBody(body: Uint8Array, contentType: string): string {
  if (body[0] === 0xff && body[1] === 0xfe) return new TextDecoder("utf-16le").decode(body);
  if (body[0] === 0xfe && body[1] === 0xff) return new TextDecoder("utf-16be").decode(body);
  // A <meta> cannot declare UTF-16: the bytes it sits in are ASCII-compatible, so the declaration itself
  // proves the page is not UTF-16. Browsers read such a page as UTF-8; honouring the label gave garbage
  // that scanned "clean".
  const meta = charsetFromMeta(body);
  const labels = [/charset=["']?([\w.:-]+)/i.exec(contentType)?.[1], meta && /^utf-?16/i.test(meta) ? "utf-8" : meta];
  for (const label of labels) {
    const decoder = label ? decoderForLabel(label) : null;
    if (decoder) return decoder.decode(body);
  }
  return new TextDecoder("utf-8").decode(body);
}
