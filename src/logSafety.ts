/**
 * What goes into Workers Logs for an unexpected error: its name and message with web addresses
 * blanked out. The message of a failed fetch can contain the page the user asked about, and the
 * privacy text promises scanned addresses are not kept; a stack trace adds nothing the name does not.
 */
export function describeForLog(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  // Bare host names too ("getaddrinfo ENOTFOUND client-site.example"), not only full addresses.
  const withoutAddresses = message
    .replace(/https?:\/\/\S+/gi, "[address removed]")
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi, "[host removed]");
  return `${name}: ${withoutAddresses.slice(0, 300)}`;
}
