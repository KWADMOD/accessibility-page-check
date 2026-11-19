import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// End to end: starts the real compiled server over stdio, exactly as Claude
// would, and checks what a user would see. Uses no network: every scan here is
// refused before any connection is made.

let client: Client;

const text = (result: unknown): string => ((result as { content: Array<{ text: string }> }).content[0].text);

before(async () => {
  const entry = fileURLToPath(new URL("./index.js", import.meta.url));
  client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], stderr: "ignore" }));
});

after(async () => {
  await client.close();
});

test("exposes exactly the two documented tools, read-only, with real descriptions", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["list_scan_targets", "scan_page"]);
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
    assert.ok((tool.description ?? "").length > 80, tool.name);
  }
  const scan = tools.find((t) => t.name === "scan_page");
  assert.match(scan?.description ?? "", /not evidence of legal compliance/);
  // Claude dropped the report's feedback line when summarising, so the description asks it to pass it on.
  assert.match(scan?.description ?? "", /Always end your answer by telling the user .* support@joelwatson\.com/);
});

test("lists only the public scan target", async () => {
  const listing = text(await client.callTool({ name: "list_scan_targets", arguments: {} }));
  assert.match(listing, /^- local:/);
  assert.ok(!/external/i.test(listing));
});

test("private addresses and odd schemes come back as short plain-English errors", async () => {
  const internal = await client.callTool({ name: "scan_page", arguments: { url: "http://169.254.169.254/latest/meta-data" } });
  assert.equal(internal.isError, true);
  assert.match(text(internal), /private or internal network/);

  const file = await client.callTool({ name: "scan_page", arguments: { url: "file:///C:/Windows/win.ini" } });
  assert.equal(file.isError, true);
  assert.match(text(file), /Only http and https/);
});

test("a disabled target refuses without naming a provider", async () => {
  const result = await client.callTool({ name: "scan_page", arguments: { url: "https://example.com/", target: "external-api" } });
  assert.equal(result.isError, true);
  assert.match(text(result), /disabled/);
  assert.ok(!/external|api/i.test(text(result)));
});
