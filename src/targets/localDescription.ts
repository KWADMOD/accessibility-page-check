// Shared by the Node and Worker "local" targets so tool output reads the same in
// both runtimes. Its own file because localScanner.ts pulls in node:worker_threads
// and the Worker bundle must not.
export const LOCAL_SCANNER_DESCRIPTION =
  "Built-in checker: fetches the page and tests a core subset of WCAG 2.1 A/AA rules. No account needed.";
