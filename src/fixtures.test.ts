import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createLocalScanner } from "./targets/localScanner.js";

// The demo pages in demo/ are what the README, the docs page and the recording point
// strangers at, so they must keep doing their job: before.html shows every kind of
// problem, after.html and index.html scan clean, nothing links to a missing file, and
// the colours the pages use meet WCAG contrast. These tests stop the pages rotting.

// dist/fixtures.test.js runs from dist/, so the demo folder is one level up.
const DEMO_DIR = fileURLToPath(new URL("../demo/", import.meta.url));
const CONTENT_TYPES: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".svg": "image/svg+xml" };

let server: http.Server;
let scanner: ReturnType<typeof createLocalScanner>;
let base: string;

before(async () => {
  server = http.createServer((req, res) => {
    const name = (req.url ?? "/").split("?")[0].replace(/^\//, "") || "index.html";
    const file = path.join(DEMO_DIR, name);
    // Stay inside demo/ even for odd request paths; this server only exists for the tests.
    if (!file.startsWith(DEMO_DIR) || !existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  scanner = createLocalScanner({ testAllowedHosts: [`127.0.0.1:${port}`] });
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const ALL_RULES = ["button-name", "form-label", "heading-h1", "heading-order", "html-lang", "img-alt", "link-name", "meta-viewport-zoom", "page-title", "placeholder-label"];

test("before.html has every kind of problem the scanner checks for", async () => {
  const result = await scanner.scan(`${base}/before.html`);
  assert.deepEqual([...new Set(result.findings.map((f) => f.ruleId))].sort(), ALL_RULES);
  // Enough readable text that the scan does not add its "almost no text" caveat.
  assert.equal(result.notes, undefined);
});

test("after.html and index.html scan clean, with no caveat about missing text", async () => {
  for (const page of ["after.html", "index.html"]) {
    const result = await scanner.scan(`${base}/${page}`);
    assert.deepEqual(result.findings, [], page);
    assert.equal(result.notes, undefined, page);
  }
});

test("every local link, image and stylesheet in the demo pages points at a file that exists", () => {
  const pages = readdirSync(DEMO_DIR).filter((f) => f.endsWith(".html"));
  assert.ok(pages.length >= 3);
  for (const page of pages) {
    const html = readFileSync(path.join(DEMO_DIR, page), "utf8");
    for (const match of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
      const target = match[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const file = path.join(DEMO_DIR, target.split("#")[0]);
      assert.ok(existsSync(file), `${page} points at missing ${target}`);
    }
  }
});

test("the fixed pages are not left with the problems before.html is meant to show", () => {
  for (const page of ["after.html", "index.html"]) {
    const html = readFileSync(path.join(DEMO_DIR, page), "utf8");
    assert.match(html, /<html lang="en">/, page);
    assert.match(html, /class="skip-link"/, page);
    assert.doesNotMatch(html, /user-scalable\s*=\s*no/i, page);
  }
});

// ---- Colour contrast (WCAG 1.4.3 text 4.5:1, 1.4.11 UI components 3:1) ----

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function cssColours(): Record<string, string> {
  const css = readFileSync(path.join(DEMO_DIR, "demo.css"), "utf8");
  const colours: Record<string, string> = {};
  for (const m of css.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) colours[m[1]] = m[2];
  return colours;
}

test("the demo colours meet WCAG AA contrast", () => {
  const c = cssColours();
  const textPairs: Array<[string, string]> = [
    ["text", "bg"], ["muted", "bg"], ["link", "bg"], ["button-text", "button-bg"],
    ["note-text", "note-bg"], ["link", "note-bg"],
  ];
  // ("link", "bg") above also covers the skip link: link-coloured text on the page background once it slides into view.
  for (const [fg, bg] of textPairs) {
    assert.ok(c[fg] && c[bg], `missing colour token ${fg} or ${bg}`);
    assert.ok(contrast(c[fg], c[bg]) >= 4.5, `${fg} on ${bg} is ${contrast(c[fg], c[bg]).toFixed(2)}:1, needs 4.5:1`);
  }
  // Non-text contrast (1.4.11), 3:1: the email field border, the button edge, the note box border and
  // the focus ring (drawn in the link colour, 3px outside the control, so it sits on the page background).
  for (const [shape, against] of [["field-border", "bg"], ["button-bg", "bg"], ["note-border", "note-bg"], ["link", "bg"]]) {
    assert.ok(contrast(c[shape], c[against]) >= 3, `${shape} on ${against} is ${contrast(c[shape], c[against]).toFixed(2)}:1, needs 3:1`);
  }
});
