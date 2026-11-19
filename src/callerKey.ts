// Turns the caller's address into the key for the per-caller rate limit.
//
// Why not the raw address: one IPv6 host normally owns a whole /64 (2^64 addresses), so a caller that
// rotates through addresses in its own /64 would get a fresh bucket every time and drain the shared
// one for everybody. Grouping IPv6 callers by their /64 gives each such host one bucket. IPv4 callers
// stay one bucket per address.

const HEXTET = /^[0-9a-f]{1,4}$/;

/** Expands an IPv6 address to eight hextets (lowercase hex, no leading zeros), or null if it is not valid. */
function expandIPv6(address: string): string[] | null {
  let text = address.split("%")[0]; // a zone id is not part of the address
  // An embedded IPv4 tail ("::ffff:1.2.3.4") stands for two hextets.
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    if ([a, b, c, d].some((part) => part > 255)) return null;
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  let groups: string[];
  if (halves.length === 1) {
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null; // "::" must stand for at least one group
    groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  }
  if (groups.length !== 8 || !groups.every((group) => HEXTET.test(group))) return null;
  return groups.map((group) => parseInt(group, 16).toString(16));
}

export function callerKeyFor(address: string | null | undefined): string {
  const ip = (address ?? "").trim().toLowerCase();
  if (!ip) return "unknown";
  if (!ip.includes(":")) return ip; // IPv4
  const groups = expandIPv6(ip);
  // Not parseable: keep the text itself rather than lumping every odd value into one bucket.
  if (!groups) return ip;
  // An IPv4 address written as IPv6 ("::ffff:1.2.3.4") is still one IPv4 caller.
  if (groups.slice(0, 5).every((group) => group === "0") && groups[5] === "ffff") {
    const high = parseInt(groups[6], 16);
    const low = parseInt(groups[7], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return `v6:${groups.slice(0, 4).join(":")}`;
}
