import { Worker } from "node:worker_threads";
import { createSlotPool } from "./analysisSlots.js";
import type { Finding } from "./targets/types.js";

// Why a worker: the HTML parser's running time grows roughly with the square of
// how deeply a page is nested (10,000 levels took 0.75 s, 60,000 took 46 s), and
// the download caps do not cover it. A 1 MB hostile page could otherwise freeze
// the whole server. In a worker the analysis has a hard deadline and a memory
// ceiling, and the main thread stays responsive either way.

// 20 s because a legitimate 7 MB page took 6 s here (about half of it parser start-up),
// and a slower machine or an 8 MB page, which the download cap allows, needs headroom.
// The nested-page attack is cut off at this deadline either way.
export const ANALYSIS_TIMEOUT_MS = 20_000;
const MAX_WORKER_HEAP_MB = 1024;

// One 7 MB page raised the process's memory by about 800 MB, and six at once by
// about 4 GB. Claude can request several scans in one turn, so at most this many
// run together and the rest wait their turn. Worst case is then about 2 GB.
export const MAX_CONCURRENT_ANALYSES = 2;

// Scans allowed to wait for a slot; more are refused at once instead of queueing.
export const MAX_WAITING_ANALYSES = 4;

const pool = createSlotPool({ maxActive: MAX_CONCURRENT_ANALYSES, maxWaiting: MAX_WAITING_ANALYSES });

/** Refuses early when the scanner is full; see SlotPool.assertCapacity. */
export const assertAnalysisCapacity = (): void => pool.assertCapacity();

/** Runs a task once an analysis slot is free; see SlotPool.run. */
export const withAnalysisSlot = <T>(task: () => Promise<T>): Promise<T> => pool.run(task);

// The worker script must stay its own file (analysisWorker.js beside this one). If
// the project is ever bundled into a single file, this path breaks unless the
// worker is built as a separate entry point.

export interface Analysis {
  findings: Finding[];
  notes: string[];
}

type WorkerMessage = ({ ok: true } & Analysis) | { ok: false; message: string };

export function analyzeInWorker(html: string, timeoutMs: number = ANALYSIS_TIMEOUT_MS): Promise<Analysis> {
  // The deadline starts when the analysis starts, not while it waits for a slot.
  return withAnalysisSlot(() => runWorker(html, timeoutMs));
}

function runWorker(html: string, timeoutMs: number): Promise<Analysis> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./analysisWorker.js", import.meta.url), {
      workerData: html,
      resourceLimits: { maxOldGenerationSizeMb: MAX_WORKER_HEAP_MB },
    });
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // terminate() also interrupts a parse that is still running.
      void worker.terminate();
      action();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`This page took longer than ${timeoutMs / 1000} seconds to analyze, so it was not scanned. Very large or deeply nested pages can do this.`))),
      timeoutMs,
    );

    worker.once("message", (message: WorkerMessage) =>
      finish(() => (message.ok ? resolve({ findings: message.findings, notes: message.notes }) : reject(new Error(message.message)))),
    );
    worker.once("error", (error: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          error.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? new Error("This page is too large or complex to analyze with the memory available, so it was not scanned.")
            : new Error("The page could not be analyzed."),
        ),
      ),
    );
    worker.once("exit", () => finish(() => reject(new Error("The page analysis stopped unexpectedly, so it was not scanned."))));
  });
}
