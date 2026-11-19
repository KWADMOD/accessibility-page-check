// Why this exists: scan_page fetches whatever URL it is given. Without a check, a
// prompt (or a scanned page that tries to steer Claude) could point it at
// localhost, a router, an office intranet or a cloud metadata service
// (169.254.169.254) and read the answer back. We only scan public web pages, so
// every address that is not publicly routable is refused.

/** Thrown when a URL resolves to a private, loopback, link-local or reserved address. */
export class BlockedAddressError extends Error {
  constructor() {
    super("That address is on a private or internal network, so it was not scanned. Only public web pages can be scanned.");
    this.name = "BlockedAddressError";
  }
}

// IPv4 ranges that are not public internet destinations.
const IPV4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, includes cloud metadata services
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // deprecated 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, includes broadcast
];

// IPv6 equivalents. IPv4-mapped (::ffff:0:0/96), NAT64 and 6to4 addresses are
// blocked outright because each can smuggle an IPv4 target past a v6-only check.
const IPV6_BLOCKED: Array<[string, number]> = [
  ["::", 96], // unspecified plus deprecated IPv4-compatible (::7f00:1 is 127.0.0.1)
  ["100::", 64], // discard-only
  ["2001::", 23], // IETF protocol assignments: includes Teredo (embeds an IPv4 address), benchmarking and ORCHID
  ["::1", 128], // loopback
  ["::ffff:0:0", 96], // IPv4-mapped
  ["64:ff9b::", 96], // NAT64
  ["64:ff9b:1::", 48], // local-use NAT64 (RFC 8215), the same smuggling route
  ["2002::", 16], // 6to4
  ["2001:db8::", 32], // documentation
  ["3fff::", 20], // documentation (RFC 9637)
  ["5f00::", 16], // segment-routing SIDs (RFC 9602), not public destinations
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
];

// Why hand-written parsing: this file is shared with the Cloudflare Worker, which
// has no node:net (BlockList, isIP). IPv4 becomes a 32-bit number and IPv6 a 128-bit
// bigint, so a range check is one mask-and-compare.

/** Parses dotted-quad IPv4 strictly: four decimal parts, 0-255, no leading zeros. */
function parseIPv4(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    // Leading zeros are refused because some stacks read them as octal; refusing is the safe side.
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** Parses an IPv6 literal (with `::` and an optional embedded IPv4 tail) into a 128-bit bigint. */
function parseIPv6(text: string): bigint | null {
  // Zone ids ("fe80::1%eth0") and brackets fail this character check, so they are refused.
  // This deliberately differs from node:net, which accepted a zone id: refusing is the safer
  // default, and neither URLs nor DNS answers can carry one, so no real scan is affected.
  if (!/^[0-9a-fA-F:.]+$/.test(text) || !text.includes(":")) return null;
  let head = text;
  let tail = "";
  const doubleColon = text.indexOf("::");
  if (doubleColon !== -1) {
    if (text.indexOf("::", doubleColon + 1) !== -1) return null; // ":::" or a second "::"
    head = text.slice(0, doubleColon);
    tail = text.slice(doubleColon + 2);
  }
  const toGroups = (section: string): string[] | null => (section === "" ? [] : section.split(":"));
  const headGroups = toGroups(head);
  const tailGroups = toGroups(tail);
  if (!headGroups || !tailGroups) return null;
  const all = doubleColon === -1 ? headGroups : [...headGroups, ...tailGroups];

  // An embedded IPv4 tail (::ffff:1.2.3.4) is only valid as the very last group.
  const words: number[] = [];
  for (let i = 0; i < all.length; i++) {
    const group = all[i];
    if (group.includes(".")) {
      // `all` omits the zeros that "::" stands for, so also require the group to be last
      // in the text itself: "127.0.0.1::" must not pass as if the IPv4 were the tail.
      if (i !== all.length - 1 || (doubleColon !== -1 && tailGroups.length === 0)) return null;
      const v4 = parseIPv4(group);
      if (v4 === null) return null;
      words.push(Math.floor(v4 / 65536), v4 % 65536);
    } else {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      words.push(parseInt(group, 16));
    }
  }

  let headCount = words.length;
  let tailCount = 0;
  if (doubleColon !== -1) {
    // Count words contributed by each side so the zero fill goes in the right place.
    const count = (groups: string[]) => groups.reduce((n, g) => n + (g.includes(".") ? 2 : 1), 0);
    headCount = count(headGroups);
    tailCount = count(tailGroups);
    // "::" must stand for at least one group of zeros.
    if (headCount + tailCount > 7) return null;
  } else if (words.length !== 8) {
    return null;
  }

  const full = [...words.slice(0, headCount), ...new Array(8 - headCount - tailCount).fill(0), ...words.slice(headCount)];
  return full.reduce((acc, word) => (acc << 16n) | BigInt(word), 0n);
}

// A range compiled once: the network address divided into blocks of `size`, so a
// check is one division (IPv4) or one shift (IPv6) per range, with no parsing per call.
interface Range4 { block: number; size: number }
interface Range6 { block: bigint; shift: bigint }

function invalidRange(net: string, prefix: number): Error {
  return new Error(`Blocked-range table entry ${net}/${prefix} is not valid.`);
}

/**
 * Compiles the IPv4 table. Throws on any bad entry instead of skipping it: a skipped
 * entry would silently un-block that range, so a typo must stop the module loading.
 */
export function compileIPv4Ranges(entries: Array<[string, number]>): Range4[] {
  return entries.map(([net, prefix]) => {
    const base = parseIPv4(net);
    if (base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw invalidRange(net, prefix);
    const size = 2 ** (32 - prefix);
    return { block: Math.floor(base / size), size };
  });
}

/** Compiles the IPv6 table, throwing on any bad entry for the same reason as IPv4. */
export function compileIPv6Ranges(entries: Array<[string, number]>): Range6[] {
  return entries.map(([net, prefix]) => {
    const base = parseIPv6(net);
    if (base === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 128) throw invalidRange(net, prefix);
    const shift = BigInt(128 - prefix);
    return { block: base >> shift, shift };
  });
}

const IPV4_RANGES = compileIPv4Ranges(IPV4_BLOCKED);
const IPV6_RANGES = compileIPv6Ranges(IPV6_BLOCKED);

/** True when the IP literal is not safe to scan. Anything that is not an IP is refused. */
export function isBlockedAddress(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4 !== null) return IPV4_RANGES.some(({ block, size }) => Math.floor(v4 / size) === block);
  const v6 = parseIPv6(address);
  if (v6 !== null) return IPV6_RANGES.some(({ block, shift }) => v6 >> shift === block);
  return true;
}

/** True when the text is an IPv4 or IPv6 literal (replaces node:net isIP for callers). */
export function isIpLiteral(address: string): boolean {
  return parseIPv4(address) !== null || parseIPv6(address) !== null;
}

/**
 * People (and Claude) often type "example.com" without a scheme. Add https://
 * rather than failing, but leave real schemes alone so "file:" and
 * "javascript:" still get the clear "only http and https" refusal.
 */
export function normalizeUserUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes("://")) return trimmed;
  // "name:" with a non-digit after it is a scheme (mailto:, javascript:); "host:3000" is a port.
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/** URL.hostname keeps the brackets on IPv6 literals; bare literal parsing does not accept them. */
export function bareHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}
