# Accessibility Page Check: a demo Claude connector

This is a demo. It shows that a custom Claude connector can be built quickly and well. It is small on purpose, and it is not a product.

**Important:** Automated checks flag likely problems. They cannot prove a page is accessible, and these results are not evidence of legal compliance.

## What it does

Ask Claude to check a public web page. The connector reads the page's HTML and runs 10 basic checks: 7 WCAG 2.1 A/AA success criteria and 3 best practices. Claude then explains the problems in plain English, worst first, with why each one matters and how to fix it.

It does not check color contrast, keyboard use, video captions, or anything a page builds with JavaScript after it loads.

## Tools

Both tools are read-only. They never change anything on the page you scan.

- `scan_page`: reads one public http or https page and returns the report.
- `list_scan_targets`: lists the scan backends (currently one).

## How to add it to Claude

The connector address is `https://a11y-mcp.joelwatson.com/mcp`. No account or sign-in is needed.

**[Open Claude connector settings](https://claude.ai/customize/connectors)** (you may need to sign in to Claude first), then:

1. Select **Add**, then **Add custom connector**.
2. Enter a name, for example "Accessibility Page Check", and paste the address above. Click **Continue**.
3. If asked about sign-in, choose **No sign-in**. Click **Add**.
4. Start a new chat and ask, for example: "Check https://example.com for accessibility problems."

The free Claude plan allows one custom connector. On a Team or Enterprise plan, an Owner adds it for the organization under [Organization settings > Connectors](https://claude.ai/admin-settings/connectors), and members then turn it on for themselves.

**Using Claude Code?** Run this once in a terminal:

```
claude mcp add --transport http accessibility-check https://a11y-mcp.joelwatson.com/mcp
```

Menu names vary between Claude versions. If you cannot find them, look for the option to add a custom connector.

## Try it on the demo pages

Two small practice pages show what the checks catch. The [before page](https://joelwatson.com/a11y-mcp/demo/before.html) has a problem for each of the 10 checks, and the [after page](https://joelwatson.com/a11y-mcp/demo/after.html) fixes them all. Ask Claude, for example:

- "Check https://joelwatson.com/a11y-mcp/demo/before for accessibility problems."
- "Now check https://joelwatson.com/a11y-mcp/demo/after."

The [demo overview](https://joelwatson.com/a11y-mcp/demo/) explains both pages.

<!-- The prompts use the extensionless addresses on purpose: the site answers .html with a 307 to the
     extensionless path, and a redirect makes every report open with "The address redirected". -->

## Run it on your own computer

The code is open source under the MIT License: [source code on GitHub](https://github.com/KWADMOD/accessibility-page-check). For Claude Desktop, download `accessibility-mcp-demo.mcpb` from the [latest release](https://github.com/KWADMOD/accessibility-page-check/releases/latest), then in Claude Desktop open Settings > Desktop app > Manage (next to Extensions; Settings > Extensions in older versions) > Advanced settings > Install Extension… and choose the file. The README has the full steps, including Claude Code.

## Limits

- Pages up to 2 MB are scanned. Larger pages are refused.
- A page must finish downloading within 10 seconds, and a download that goes 5 seconds without sending anything is dropped.
- Pages nested more than 400 levels deep, with more than 150,000 elements, or with more than 250,000 parts in all (elements, text and comments), are refused.
- One page is scanned per request. If Claude asks for several pages at once, the extra ones are refused; ask for them one at a time.
- Requests are limited to 64 KB. The limits are shared: 40 requests per minute per caller address and 120 per minute in total, each per Cloudflare location. Claude on the web and in the apps reaches the connector through a few shared Anthropic addresses, so many people share the first limit too. Every request Claude sends counts, and a new Claude session sends a few before its first scan. If you see a "too many requests" message, wait a minute and try again.
- Each request gets up to 5 seconds of processing time. A page that needs more fails with an error rather than a plain-English message. A dense 2 MB page needs about a second.
- A few pages can be downloaded at once, so a busy moment can return a "scanner is busy" message. Try again shortly.
- Private, internal and reserved addresses are refused, including after redirects. The connector's own address (`a11y-mcp.joelwatson.com`) is also refused.

## Need an ACR or audit?

This demo runs a few automated checks. A real accessibility review needs manual testing with assistive technology. For an Accessibility Conformance Report (ACR) or an audit, visit [InclusiveByte](https://inclusivebyte.com).

## Support

Questions or problems: [support@joelwatson.com](mailto:support@joelwatson.com)

Think a result is wrong? Email the page address and what looks wrong. Every report says this too, because we keep no record of which pages were scanned and cannot spot a wrong result on our own.

## Privacy

Last updated: 2026-11-18

**What we collect.** You send a page address to the connector through Claude. The request passes through Cloudflare, which hosts the service. The service fetches that page, checks it and returns the result. The page content is not stored, and we keep no database, account or token. Cloudflare, as host, sees the IP address of whoever sends the request. In Claude on the web, desktop and mobile apps that is normally Anthropic's connector service, not you. In Claude Code the request comes straight from your own computer, so Cloudflare sees your IP address. Scan results are returned to Claude, and Anthropic's own terms and privacy policy apply there.

**Logs.** Our code does not record the page address or page content. For each scan it logs one line: whether the page was scanned or refused (and, if refused, the reason in our own words, with any web address or site name removed), how many problems of each kind were found, how many caveats the report carried, whether the page redirected, and how long the scan took. We use these lines to spot a check that misfires. An unexpected error may also be logged as its type and a short message, with any web address or site name removed. Cloudflare, as host, records request details for each call, including the sender's IP address. Cloudflare documents a 7-day retention for Workers Logs on the Workers Paid plan, after which they are deleted.

**Sharing.** We share your data with no one, apart from the services that make it work. The page you ask us to scan receives our request, as any visit would. The other two are:

- Cloudflare, which hosts the service.
- Cloudflare DNS-over-HTTPS, which looks up a page's address to check it is public before fetching it. The page's hostname is sent to it.

**Page text is data.** The service never acts on instructions found in a scanned page.

**Contact.** For privacy questions, use the support contact above.
