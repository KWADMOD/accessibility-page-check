import { describeForLog } from "./logSafety.js";
import type { ScanResult, ScanTarget } from "./targets/types.js";

// One anonymous line per hosted scan, so a misfiring rule or a common refusal shows up in Workers
// Logs without anyone having to report it. Why it exists: the logs otherwise show only that /mcp was
// called, so a rule wrongly flagging every page would stay invisible until a stranger complained.
//
// What it never contains: the page address (requested or after redirects), page text, excerpts or
// finding messages. The privacy text on the connector page describes exactly these fields; change
// both together.

export interface ScanLogEntry {
  event: "scan";
  outcome: "scanned" | "refused";
  target: string;
  /** Wall time of the scan. On Workers the clock only moves during I/O, so this is mostly download time. */
  ms: number;
  /** Only when scanned: problems found in total and per rule id. */
  total?: number;
  byRule?: Record<string, number>;
  /** Only when scanned: how many caveats were attached (for example a script-built page). */
  notes?: number;
  redirected?: boolean;
  /** Only when refused: the error's type and our own message, with any address or host name removed. */
  reason?: string;
}

export function scanLogEntry(target: string, ms: number, outcome: { result?: ScanResult; error?: unknown }): ScanLogEntry {
  if (outcome.result) {
    const byRule: Record<string, number> = {};
    for (const finding of outcome.result.findings) byRule[finding.ruleId] = (byRule[finding.ruleId] ?? 0) + 1;
    return {
      event: "scan",
      outcome: "scanned",
      target,
      ms,
      total: outcome.result.findings.length,
      byRule,
      notes: outcome.result.notes?.length ?? 0,
      redirected: outcome.result.finalUrl !== undefined,
    };
  }
  return { event: "scan", outcome: "refused", target, ms, reason: describeForLog(outcome.error).slice(0, 160) };
}

/**
 * Wraps a scan target so every scan writes one ScanLogEntry. Logging must never break a scan, so a
 * failure to log is swallowed; the scan's own result or error is passed on unchanged.
 */
export function withScanLog(scanner: ScanTarget, log: (line: string) => void = (line) => console.log(line)): ScanTarget {
  return {
    ...scanner,
    async scan(url: string) {
      const started = Date.now();
      const write = (outcome: { result?: ScanResult; error?: unknown }): void => {
        try {
          log(JSON.stringify(scanLogEntry(scanner.id, Date.now() - started, outcome)));
        } catch {
          // Deliberately ignored: a log line is never worth a failed scan.
        }
      };
      try {
        const result = await scanner.scan(url);
        write({ result });
        return result;
      } catch (error) {
        write({ error });
        throw error;
      }
    },
  };
}
