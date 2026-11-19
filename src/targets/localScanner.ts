import { analyzeInWorker, assertAnalysisCapacity } from "../analyze.js";
import { summarize } from "../checks.js";
import { fetchPublicHtml, type SafeFetchOptions } from "../safeFetch.js";
import { LOCAL_SCANNER_DESCRIPTION } from "./localDescription.js";
import type { ScanResult, ScanTarget } from "./types.js";

// Default target: fetches the page itself and runs our own checks. It needs no
// third-party account, so the demo works without anyone else's terms of service.
// All network safety (private-address block, size cap, timeout, redirects) lives
// in safeFetch.ts so it can be tested on its own.

/**
 * A factory so tests can reach a local server through the same code path real
 * scans use. The tool never passes options: the default scanner below is the only
 * one the registry knows about.
 */
export function createLocalScanner(fetchOptions: SafeFetchOptions = {}): ScanTarget {
  return {
    id: "local",
    description: LOCAL_SCANNER_DESCRIPTION,
    async scan(url: string): Promise<ScanResult> {
      // Refuse before downloading if the analysis queue is already full.
      assertAnalysisCapacity();
      const { html, requestedUrl, finalUrl } = await fetchPublicHtml(url, fetchOptions);
      // In a worker with a deadline: see analyze.ts for why parsing must not run on the main thread.
      const { findings, notes } = await analyzeInWorker(html);
      const result: ScanResult = { targetId: "local", url: requestedUrl, scannedAt: new Date().toISOString(), findings, summary: summarize(findings) };
      // Only reported when a redirect happened, so the user knows which page was really checked.
      if (finalUrl !== requestedUrl) result.finalUrl = finalUrl;
      if (notes.length > 0) result.notes = notes;
      return result;
    },
  };
}

export const localScanner: ScanTarget = createLocalScanner();
