import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { callerKeyFor } from "./callerKey.js";
import { describeForLog } from "./logSafety.js";
import { createMcpServer } from "./mcpServer.js";
import { withScanLog } from "./scanLog.js";
import { createRegistry } from "./targets/registry.js";
import type { ScanTarget } from "./targets/types.js";
import { createWebScanner } from "./web/webScanner.js";

// The Cloudflare Worker entry: a public, authless, stateless Streamable HTTP MCP
// endpoint. Web-standard APIs only. It must never import index.ts, analyze.ts,
// safeFetch.ts or localScanner.ts, because those reach node: (a test enforces it).

export interface Env {
  /** Cost ceiling for the whole endpoint (one shared bucket per Cloudflare location). */
  MCP_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
  /** Fairness limit, one bucket per caller address, so one noisy caller cannot use up the shared one. */
  MCP_IP_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
  DOCS_URL: string;
  /**
   * The Worker's own hostname, the only host refused by name. Not the whole zone:
   * global_fetch_strictly_public already sends other same-zone fetches through
   * Cloudflare's front door like any public request, and the demo pages may live on
   * joelwatson.com, which must stay scannable.
   */
  SELF_HOSTNAME: string;
}

const MAX_BODY_BYTES = 64 * 1024;
const RATE_LIMIT_MESSAGE = "The scanner is getting a lot of requests right now. Please try again in a minute.";

// Retry-After matches the limiters' 60-second period, so well-behaved clients back off instead of hammering.
const rateLimited = (): Response => jsonRpcError(429, -32000, RATE_LIMIT_MESSAGE, { "retry-after": "60" });

function jsonRpcError(status: number, code: number, message: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

export const ONE_SCAN_MESSAGE = "Only one page can be scanned per request. Please scan pages one at a time.";

/**
 * Lets one request start at most one scan. The rate limiters charge per HTTP request, but a
 * JSON-RPC batch (up to 100 calls in one POST) made the SDK run every scan_page in it: one token
 * bought six scans, filled every download slot in the isolate, and could run six dense analyses
 * against one 5 s CPU budget. Claude's clients never batch (MCP 2025-06-18 removed batching),
 * so the cap costs real users nothing. Wrapping the scanner, rather than refusing arrays, also
 * covers any other way one request might carry several calls.
 */
function oneScanPerRequest(scanner: ScanTarget): ScanTarget {
  let used = false;
  return {
    ...scanner,
    scan(url: string) {
      if (used) return Promise.reject(new Error(ONE_SCAN_MESSAGE));
      used = true;
      return scanner.scan(url);
    },
  };
}

export function createHandler(deps: { scanner?: ScanTarget } = {}): { fetch(request: Request, env: Env): Promise<Response> } {
  // Built on the first request because SELF_HOSTNAME lives in the per-request env, then
  // reused. The scan pool belongs to the scanner, so one scanner per isolate is what
  // bounds memory: a scanner per request would give every request its own free slot.
  // Not keyed by env: Worker vars are fixed for a deployed version, so SELF_HOSTNAME never changes.
  let cachedScanner: ScanTarget | undefined;
  const scannerFor = (env: Env): ScanTarget => {
    if (deps.scanner) return deps.scanner;
    cachedScanner ??= createWebScanner({ blockedHostnames: [env.SELF_HOSTNAME] });
    return cachedScanner;
  };

  async function handleMcp(request: Request, env: Env): Promise<Response> {
    // Two limits, checked before any body read or parsing so a flood costs almost nothing.
    // Per caller first: a flooder is turned away by its own bucket and never touches the shared
    // one, so it cannot lock everyone else out. Behind Anthropic's connector proxy many people
    // share one address, so this bucket is deliberately roomy; the shared bucket is the cost ceiling.
    // IPv6 callers are grouped by /64 (see callerKey.ts), or rotating addresses would dodge the limit.
    const callerKey = callerKeyFor(request.headers.get("cf-connecting-ip"));
    const perCaller = await env.MCP_IP_LIMITER.limit({ key: callerKey });
    if (!perCaller.success) return rateLimited();
    const { success } = await env.MCP_LIMITER.limit({ key: "mcp" });
    if (!success) return rateLimited();

    // Stateless: a new server and transport per request, so nothing is shared between callers.
    // Scans are logged anonymously (scanLog.ts); a refused second scan in a batch is not a scan and is not logged.
    const server = createMcpServer(createRegistry(oneScanPerRequest(withScanLog(scannerFor(env)))));
    // The transport enforces the body cap itself: it checks content-length, then counts
    // streamed bytes and stops reading past the limit (413). Buffering the body here
    // first would let a chunked, header-less POST fill a 128 MB isolate.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: MAX_BODY_BYTES,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  }

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      try {
        const { pathname } = new URL(request.url);
        if (pathname === "/mcp") {
          if (request.method === "POST") return await handleMcp(request, env);
          return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
        }
        if (pathname === "/" && request.method === "GET") return Response.redirect(env.DOCS_URL, 302);
        return new Response("Not Found", { status: 404 });
      } catch (error) {
        // Logged in full for the operator, but the caller only gets a generic body: no stack, no paths.
        console.error("Unhandled Worker error:", describeForLog(error));
        return jsonRpcError(500, -32603, "Internal error");
      }
    },
  };
}

export default createHandler();
