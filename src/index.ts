import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcpServer.js";
import { localScanner } from "./targets/localScanner.js";
import { createRegistry } from "./targets/registry.js";
import type { TargetRegistry } from "./targets/types.js";

// stdout carries the MCP protocol, so anything we log must go to stderr.

// SCAN_TARGET picks the default backend when a call names none. It is read here,
// not in the shared registry, because process.env does not exist on Workers.
const base = createRegistry(localScanner);
const registry: TargetRegistry = {
  listTargets: () => base.listTargets(),
  getTarget: (id) => base.getTarget(id ?? process.env.SCAN_TARGET ?? undefined),
};
const server = createMcpServer(registry);

// A stray error must not end the server in the middle of a recording or a
// buyer's trial. Log it to stderr and keep serving.
process.on("uncaughtException", (error) => console.error("Uncaught exception:", error));
process.on("unhandledRejection", (reason) => console.error("Unhandled rejection:", reason));

try {
  await server.connect(new StdioServerTransport());
  console.error("accessibility-mcp-demo running on stdio");
} catch (error) {
  console.error("Failed to start server:", error);
  process.exit(1);
}
