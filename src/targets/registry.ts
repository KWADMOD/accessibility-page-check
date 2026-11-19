import { externalApi } from "./externalApi.js";
import type { ScanTarget, TargetRegistry } from "./types.js";

/**
 * Builds the registry around an injected default target. The default is passed in
 * (not imported) so the Worker build can supply its own scanner without pulling
 * in the Node-only local one. Adding a vendor later means adding one file and one
 * entry here.
 */
export function createRegistry(defaultTarget: ScanTarget): TargetRegistry {
  const targets: ScanTarget[] = [defaultTarget, externalApi];
  const listTargets = (): ScanTarget[] => targets.filter((t) => !t.hidden); // hidden (disabled, unpublished) targets are left out

  return {
    listTargets,
    getTarget(id?: string): ScanTarget {
      if (id === undefined) return defaultTarget;
      // Looks in the full list so a hidden target still resolves and refuses to run,
      // instead of being reported as unknown.
      const target = targets.find((t) => t.id === id);
      if (!target) throw new Error(`Unknown scan target '${id}'. Available: ${listTargets().map((t) => t.id).join(", ")}.`);
      return target;
    },
  };
}
