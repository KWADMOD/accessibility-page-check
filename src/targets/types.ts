// Shared shapes for every scan target. Keeping the MCP server dependent only on
// this interface is what lets us swap the scan backend (own checker, a vendor
// API) without touching the tool definitions.

export type Severity = "critical" | "serious" | "moderate" | "minor";

export interface Finding {
  ruleId: string;
  severity: Severity;
  /** WCAG 2.1 success criterion this maps to, e.g. "1.1.1". */
  wcag: string;
  message: string;
  /** Trimmed HTML of the offending element, to help locate it. */
  snippet?: string;
}

export interface ScanResult {
  targetId: string;
  url: string;
  /** Set only when the request was redirected: the page that was actually scanned. */
  finalUrl?: string;
  scannedAt: string;
  findings: Finding[];
  /** Caveats about how far to trust this result, e.g. a page that is mostly built by JavaScript. */
  notes?: string[];
  summary: Record<Severity, number> & { total: number };
}

export interface ScanTarget {
  id: string;
  description: string;
  /** Hidden targets are omitted from public listings and error text but still resolve by id. */
  hidden?: boolean;
  scan(url: string): Promise<ScanResult>;
}

/** The set of scan backends a server can offer; built by createRegistry. */
export interface TargetRegistry {
  listTargets(): ScanTarget[];
  getTarget(id?: string): ScanTarget;
}
