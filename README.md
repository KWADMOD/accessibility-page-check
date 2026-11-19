# accessibility-mcp-demo

Ask Claude to check a web page for accessibility problems and get back a plain-English answer: what is wrong, why it matters to real people, and how to fix it, worst problems first.

This is a small working example of a custom Claude connector (an MCP server): Claude gets a new ability, here "scan a page for likely accessibility problems, mostly WCAG 2.1 A/AA failures", and uses it in conversation.

> **Read this first.** Automated checks flag likely problems. They cannot prove a page is accessible, and the results are not evidence of legal compliance. This demo runs 10 basic checks; a real accessibility review also needs manual testing.

## Use the hosted connector

The scanner also runs as a public, no-sign-in connector at `https://a11y-mcp.joelwatson.com/mcp`. It goes live once deployed; until then, use the local install below.

1. In Claude, open Settings and go to Connectors.
2. Add a custom connector (menu names vary; look for that option).
3. Paste the URL above and save, then start a new chat and ask Claude to check a page.

This is a demo. Hosted limits: pages up to 2 MB, pages nested deeper than 400 levels or with more than 150,000 elements (250,000 nodes counting text and comments) are refused, one page per request, request bodies up to 64 KB, shared rate limits of 40 requests per minute per caller address and 120 per minute in total, each per Cloudflare location (Claude's apps reach the connector through a few shared Anthropic addresses, so many people share the per-caller limit; every MCP request counts, and a new Claude session uses a few before its first scan), 5 seconds of CPU per request, and one analysis at a time. Need an ACR or audit? See [InclusiveByte](https://inclusivebyte.com). Docs and privacy text: `docs/connector-page.md`.

## Run it locally

**Easiest: install the bundle in Claude Desktop.** Download `accessibility-mcp-demo.mcpb` from the [latest release](https://github.com/KWADMOD/accessibility-page-check/releases/latest).
1. In Claude Desktop open Settings, click the search box at the top left and type `extension`, then open the Extensions result. (Menu names vary between versions, so searching is the reliable way to find it.)
2. Drag the `.mcpb` file onto that page, or choose Install Extension.
3. Claude shows a preview of the extension. Click Install. Two warnings are normal here. The extension is unsigned, and Claude shows "access to everything on your computer" for every extension that runs on your machine. This one only fetches the public pages you ask about, refuses private and internal addresses, and stores nothing.
4. Check that the extension is switched on, then start a new chat.

**Or build it yourself** (needs [Node.js](https://nodejs.org/) 22.12 or newer and a copy of this folder; `npm install` is the slow part, a few minutes):

**1. Build it** (once), in PowerShell:
```powershell
cd path\to\accessibility-mcp-demo
npm install
npm run build
```

**2. Add it to Claude.**

*Claude Desktop:* open Settings, then Developer, then Edit Config. That opens the right `claude_desktop_config.json` wherever your install keeps it (the folder differs between a Microsoft Store install and a direct download). Add this, save, then restart Claude Desktop. Use the real path to `dist\index.js`, with doubled backslashes:
```json
{
  "mcpServers": {
    "accessibility-demo": {
      "command": "node",
      "args": ["C:\\path\\to\\accessibility-mcp-demo\\dist\\index.js"]
    }
  }
}
```

*Claude Code:*
```powershell
claude mcp add --scope user accessibility-demo -- node C:\path\to\accessibility-mcp-demo\dist\index.js
```

**3. Ask Claude.** For example:
- "Check https://example.com for accessibility problems."
- "Scan this page and tell me the three things I should fix first, in plain English."
- "Which of those fixes would help screen reader users most?"

**Not working?**
- Quit Claude Desktop completely (not just close the window) and start it again after editing the config.
- Check the path in `args` is the real location of `dist\index.js` and that you ran `npm run build`. Running `node dist\index.js` in PowerShell should print `accessibility-mcp-demo running on stdio`; press Ctrl+C to stop it.
- Check the JSON is valid: a missing comma or single backslashes in the path will stop Claude reading the file.
- In Claude Desktop, Settings, then Developer lists your local servers, and one that failed to start is marked as failed.
- If a report says "9 automated checks", or names no version after "built-in checker", Claude is still running an older install. Remove the extension (or server) and install the current `.mcpb` or rebuild; every report names the version that produced it.
- In Claude Code, `--scope user` makes the server available in every folder; without it the server only exists in the folder where you ran the command. Start a new session after adding it.

## What you get back

Real output from the built-in checker, on a small deliberately flawed page (abridged to the first two of ten problems):

```text
ACCESSIBILITY SCAN: https://acme-dental.example/
Scanned 2026-11-18T09:30:00.000Z with the built-in checker v0.2.2 (10 automated checks: 7 WCAG 2.1 A/AA criteria and 3 best practices).

RESULT: 10 kinds of problem, 13 places in total (6 critical, 4 serious, 3 moderate).

PROBLEMS, WORST FIRST
1. Images are missing alt text [critical] - 4 places
   WCAG 1.1.1 (Non-text Content)
   Why it matters: People using screen readers get no description of the image, or hear the file name read aloud.
   How to fix: Add alt text that says what the image is for. If it is purely decorative, use an empty alt="".
   Examples from the page:
     <untrusted_page_excerpt_k3f9x2q7>‹img src="/team.jpg"›</untrusted_page_excerpt_k3f9x2q7>
     ...

2. Buttons have no readable name [critical] - 1 place
   ...

WHAT THIS SCAN DOES NOT CHECK
- Color contrast between text and background
- Keyboard use: tab order, focus visibility and keyboard traps
- Content added by JavaScript after the page loads
...

Think a result is wrong? Email support@joelwatson.com with the page address and what looks wrong.

IMPORTANT: Automated checks flag likely problems. They cannot prove a page is accessible, and these results are not evidence of legal compliance.
```

Claude then explains this in its own words and answers follow-up questions.

## Tools
- `scan_page { url, target? }`: reads one public http or https page and returns the report above. If you leave off `https://`, it is added.
- `list_scan_targets`: lists the scan backends (currently one).

Both tools are read-only. The hosted connector and the local server offer the same two tools.

## Rules checked
Ten checks: html-lang, page-title, img-alt, link-name, button-name, form-label, placeholder-label, heading-h1, heading-order, meta-viewport-zoom. Seven map to a WCAG 2.1 A/AA success criterion. **placeholder-label**, **heading-h1** and **heading-order** are best practices, and the report labels them that way: a field named only by its placeholder does have a name, but the text vanishes when someone types (it supports 3.3.2), and WCAG does not require an h1 or strictly stepped heading levels. Headings are read as assistive technology reads them: `role="heading"` counts and `aria-level` sets the level. The heading-h1 check only runs on a page that has headings. html-lang also flags a value that is not a language code (`lang="english"`), and meta-viewport-zoom reads every viewport tag and treats any `user-scalable` value other than yes (or 1 or more) as blocking zoom. Content inside `<template>` and `<noscript>`, and elements hidden with the `hidden` attribute or an inline `display:none`, is not scanned. Links, buttons and fields inside `aria-hidden` are still checked unless they are also out of the tab order (`tabindex="-1"`), because a keyboard user can still reach them. A name on a hidden part of a link or button (for example an `aria-hidden` icon with a `title`) does not count, as in the accessible-name rules. A custom button (`role="button"`) and `<input type="button">` need a name like any other button, and an image named by `aria-label`, `aria-labelledby` or `title` is not reported as missing alt text.

## What it cannot see
It reads the raw HTML of the single page you give it. It does not check color contrast, keyboard use, video captions, or anything a page builds with JavaScript after loading. If a page looks mostly script-built, the report says so, because a "clean" result there would be misleading. A result with no problems means only that these 10 checks found none.

Two known limits of the name checks. A few uncommon ways of naming a control are not recognised (a button named through `aria-labelledby` by an input's `value`, or by an element whose only name is an inner `aria-label`), so such a control can be reported as unnamed when it is fine.

## Safety
- Only public http and https pages are scanned. Addresses on private or internal networks (localhost, home and office networks, cloud metadata) are refused, including after redirects.
- Downloading a page, redirects included, is capped at 15 seconds and 8 MB locally (10 seconds and 2 MB on the hosted connector). A download that receives no data for 5 seconds is dropped, so a site that sends a few bytes at a time cannot hold a download slot for the whole deadline. Pages nested deeper than 400 levels, or with more than 150,000 elements or 200,000 nodes in all (elements plus comments and declarations), are refused (checked before parsing and again on the parsed tree), locally and hosted. Locally, analyzing it is capped at a further 20 seconds and a memory limit, and at most two pages are analyzed at once, so one unusual page cannot stall or exhaust the server. If more than a few scans are waiting, new ones are refused with a "busy" message instead of queueing.
- The hosted connector also refuses its own address (`a11y-mcp.joelwatson.com`; other sites, including joelwatson.com, can be scanned), looks up addresses through Cloudflare DNS-over-HTTPS and checks them on every redirect hop, caps request bodies at 64 KB, runs at most one scan per request (a JSON-RPC batch of several scans gets one), allows 40 requests per minute per caller address and 120 per minute in total, each per Cloudflare location (every MCP request counts, including the few a new Claude session sends before its first scan; IPv6 callers are grouped by /64, and a caller over its own limit is stopped without using up the shared one, although an attacker spread across many networks can still use up the shared limit), and downloads at most four pages at a time per instance (a busy instance says "scanner is busy"). Analysis itself is synchronous, one page at a time.
- The hosted connector caps CPU time at 5 seconds per request. A page that needs more than that fails with an error instead of a friendly refusal. The densest 2 MB pages tested use about one second.
- Our code stores nothing and needs no account or token. On the hosted connector, each scan writes one anonymous log line (scanned or refused and why, the count per rule, timing; never the page address or text), and Cloudflare (the host) keeps request logs for a limited time; see the privacy text. Because no address is kept, every report asks the reader to email support@joelwatson.com if a result looks wrong. The server only reads pages; it never acts on what a page says.
- Text copied from a scanned page is wrapped in `<untrusted_page_excerpt_…>` tags and flagged to Claude as data, because a hostile page could contain text written to look like instructions. Each report adds a new random code to the tag name (for example `untrusted_page_excerpt_k3f9x2q7`) and names that code, so a page, which is fetched before the code exists, cannot write a matching closing tag. Excerpts are also cut to 120 characters, every angle bracket and bracket look-alike in them becomes a quote mark (‹ ›), and copies of the tag name are removed. The tags are still a convention that helps Claude tell data from instructions, not a guarantee.

## Scan targets
| id | Status | Notes |
|---|---|---|
| `local` | Working, default | Built-in checker. No account or third-party terms involved. |

Scan backends are swappable; see "Adding a target" below.

## For developers
```powershell
npm install
npm test        # compile, then run all tests (includes an end-to-end check of the server over stdio)
npm run build
npm start       # stdio MCP server, dist\index.js
npm run worker:check   # dry-run the Cloudflare Worker build
npm run worker:dev     # run the Worker locally
```

Layout: `src/mcpServer.ts` (tools, shared by both builds), `src/index.ts` (stdio entry), `src/report.ts` and `src/ruleInfo.ts` (plain-English output), `src/checks.ts` (the rules), `src/nestingGuard.ts` and `src/domWalk.ts` (size and depth limits, hidden-element survey), `src/safeFetch.ts` and `src/urlSafety.ts` (network safety), `src/targets/` (swappable backends), `src/worker.ts`, `src/scanLog.ts` and `src/web/` (the Cloudflare Worker and its anonymous scan log).

### Adding a target
Create a file in `src/targets/` that exports a `ScanTarget`, then add it to `src/targets/registry.ts`.

### Dependencies (all permissive)
@modelcontextprotocol/sdk (MIT), zod (MIT), cheerio (MIT), typescript (Apache-2.0), @types/node (MIT), wrangler (MIT OR Apache-2.0, dev only, for building and deploying the Worker), @anthropic-ai/mcpb (MIT, dev only, for packing the .mcpb bundle). htmlparser2 (MIT) is also named directly now; cheerio already installs it.

## License
MIT
