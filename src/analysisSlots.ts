// Why this is its own file: the slot limiter has no Node dependency, so the Worker
// entry can share it with the stdio server. analyze.ts keeps the node:worker_threads part.

// Single source for the text shown when the scanner is at capacity.
export const BUSY_MESSAGE = "The scanner is busy with other pages. Please try again in a moment.";

export interface SlotPoolOptions {
  /** Tasks allowed to run at once. */
  maxActive: number;
  /** Tasks allowed to wait for a slot; more are refused at once instead of queueing. */
  maxWaiting: number;
}

export function createSlotPool({ maxActive, maxWaiting }: SlotPoolOptions) {
  let active = 0;
  const waiting: Array<() => void> = [];

  return {
    /**
     * Refuses early when no slot and no waiting place is free. Callers use it BEFORE
     * downloading a page, so a refused scan does not first fetch a page (up to 8 MB on
     * Node, 2 MB on the Worker). It is only a best-effort pre-check: the queue can
     * fill while the download runs, so run() still makes the final decision.
     */
    assertCapacity(): void {
      if (active >= maxActive && waiting.length >= maxWaiting) throw new Error(BUSY_MESSAGE);
    },

    /**
     * Runs a task once a slot is free. A finishing task hands its slot straight to
     * the next waiter instead of freeing it first; freeing then waking would let a
     * brand-new caller slip in between and exceed the limit.
     */
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active < maxActive) active++;
      else if (waiting.length >= maxWaiting) {
        // Each waiter holds its downloaded page (up to 8 MB on Node, 2 MB on the Worker)
        // and could wait a full deadline per scan ahead of it, past what most clients
        // allow a tool call.
        throw new Error(BUSY_MESSAGE);
      } else await new Promise<void>((resolve) => waiting.push(resolve));
      try {
        return await task();
      } finally {
        const next = waiting.shift();
        if (next) next();
        else active--;
      }
    },
  };
}

export type SlotPool = ReturnType<typeof createSlotPool>;
