import { parentPort, workerData } from "node:worker_threads";
import { analyzePage } from "./checks.js";

// Runs inside a worker thread (see analyze.ts). Parsing HTML is synchronous and
// its cost can explode on hostile input, so it must never run on the thread that
// answers MCP requests. Any failure is sent back as a message so the parent can
// turn it into a plain sentence.

try {
  const result = analyzePage(workerData as string);
  parentPort?.postMessage({ ok: true, ...result });
} catch (error) {
  parentPort?.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
}
