/**
 * The one place the release version lives in code. The server reports it to MCP clients and the
 * fetchers send it in the user agent. package.json and bundle/manifest.json carry the same number,
 * and version.test.ts fails if any of them drift apart.
 *
 * Why it matters: on 2026-11-18 a Claude Desktop install still ran the 2026-11-17 bundle, and both
 * builds called themselves 0.1.0, so nothing showed that the install was stale. Bump this (and the
 * two JSON files) whenever the checks, the report or the safety limits change.
 */
export const VERSION = "0.2.2";
