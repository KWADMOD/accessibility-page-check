import { createSlotPool, type SlotPool } from "../analysisSlots.js";
import { analyzePage, summarize } from "../checks.js";
import { LOCAL_SCANNER_DESCRIPTION } from "../targets/localDescription.js";
import type { ScanResult, ScanTarget } from "../targets/types.js";
import { fetchPublicHtmlWeb, type WebFetchOptions } from "./webFetch.js";

// The Worker's scan target. It mirrors localScanner.ts but has no worker thread to
// move parsing into, so analysis runs in the request itself.

/**
 * The slot pool limits DOWNLOADS, not analysis.
 *
 * Why not analysis: analyzePage is synchronous, so two analyses can never overlap inside one isolate,
 * and a second limit on it would bound nothing. What does overlap is waiting for the network, and
 * that is where an earlier single slot was a weakness: the slot covered the whole download (up to
 * 15 s of wall time and almost no CPU), so three slow-drip pages from one attacker kept everyone
 * else routed to that isolate waiting for up to 45 s. The deadline is now 10 s and a download that
 * receives nothing for 5 s is dropped (see webFetch.ts), which shrinks the window further.
 *
 * Why a limit at all: concurrent requests can share one 128 MB isolate. A download in flight holds
 * up to 2 MB of page plus its decoded copy, and one parse of a 2 MB page retains about 46 MB, so
 * four downloads at once (about 24 MB) plus one parse stays well inside it. Two more may wait for a
 * slot; beyond that callers get the shared busy message.
 */
export function createWebScanner(
  fetchOptions: WebFetchOptions = {},
  // Created once per scanner, not per scan, or the limit would never be shared.
  pool: SlotPool = createSlotPool({ maxActive: 4, maxWaiting: 2 }),
): ScanTarget {
  return {
    id: "local",
    description: LOCAL_SCANNER_DESCRIPTION,
    async scan(url: string): Promise<ScanResult> {
      // Refuse before downloading when the queue is full.
      pool.assertCapacity();
      // Only the download holds a slot. A waiting scan has not fetched anything yet, so a full queue
      // never holds pages, and the slot is free again before the (synchronous) analysis starts.
      const { html, requestedUrl, finalUrl } = await pool.run(() => fetchPublicHtmlWeb(url, fetchOptions));
      // Throws TooDeeplyNestedError or TooManyElementsError before a tree is built when the page is hostile.
      const { findings, notes } = analyzePage(html);
      const result: ScanResult = { targetId: "local", url: requestedUrl, scannedAt: new Date().toISOString(), findings, summary: summarize(findings) };
      // Only reported when a redirect happened, so the user knows which page was really checked.
      if (finalUrl !== requestedUrl) result.finalUrl = finalUrl;
      if (notes.length > 0) result.notes = notes;
      return result;
    },
  };
}
