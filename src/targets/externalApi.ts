import type { ScanResult, ScanTarget } from "./types.js";

// Placeholder for a third-party scan API target. It stays disabled on purpose:
// the provider's terms need written permission for this use, and until that
// exists this target refuses to run, so no call to their API can happen by accident.
//
// It is also `hidden`: the provider must not be named anywhere a stranger can read
// (tool listings, errors, README, the shipped bundle) until permission is granted,
// so the id, description and error text below are deliberately generic.

export const externalApi: ScanTarget = {
  id: "external-api",
  description: "Disabled scan target.",
  hidden: true,
  async scan(): Promise<ScanResult> {
    throw new Error("This scan target is disabled. Use the 'local' target.");
  },
};
