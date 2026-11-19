import { test } from "node:test";
import assert from "node:assert/strict";
import v8 from "node:v8";
import vm from "node:vm";
import { analyzePage, runChecks, summarize } from "./checks.js";

const ids = (html: string) => runChecks(html).map((f) => f.ruleId);

test("a clean page has no findings", () => {
  const html = `<html lang="en"><head><title>Home</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body><h1>Hi</h1><h2>Sub</h2><img src="a.png" alt="A cat"><a href="/x">Read more</a>
    <label for="e">Email</label><input id="e" type="email"><button>Send</button></body></html>`;
  assert.deepEqual(ids(html), []);
});

test("flags missing lang and title", () => {
  const found = ids("<html><head></head><body><h1>x</h1></body></html>");
  assert.ok(found.includes("html-lang"));
  assert.ok(found.includes("page-title"));
});

test("flags images without alt but allows empty alt", () => {
  assert.ok(ids(`<html lang="en"><title>t</title><body><h1>x</h1><img src="a.png"></body></html>`).includes("img-alt"));
  assert.ok(!ids(`<html lang="en"><title>t</title><body><h1>x</h1><img src="a.png" alt=""></body></html>`).includes("img-alt"));
});

test("flags nameless links and buttons", () => {
  const found = ids(`<html lang="en"><title>t</title><body><h1>x</h1><a href="/"></a><button></button></body></html>`);
  assert.ok(found.includes("link-name"));
  assert.ok(found.includes("button-name"));
});

test("accepts a link named by an inner image alt", () => {
  assert.ok(!ids(`<html lang="en"><title>t</title><body><h1>x</h1><a href="/"><img src="l.png" alt="Home"></a></body></html>`).includes("link-name"));
});

test("flags unlabeled inputs but not wrapped or aria-labelled ones", () => {
  const bad = ids(`<html lang="en"><title>t</title><body><h1>x</h1><input type="text"></body></html>`);
  assert.ok(bad.includes("form-label"));
  const ok = ids(`<html lang="en"><title>t</title><body><h1>x</h1><label>Name <input type="text"></label><input aria-label="Q" type="text"></body></html>`);
  assert.ok(!ok.includes("form-label"));
});

test("flags skipped heading levels and a missing h1", () => {
  const found = ids(`<html lang="en"><title>t</title><body><h2>a</h2><h4>b</h4></body></html>`);
  assert.ok(found.includes("heading-h1"));
  assert.ok(found.includes("heading-order"));
});

test("flags a viewport that blocks zoom", () => {
  assert.ok(ids(`<html lang="en"><title>t</title><head><meta name="viewport" content="width=device-width, user-scalable=no"></head><body><h1>x</h1></body></html>`).includes("meta-viewport-zoom"));
});

test("summarize counts by severity", () => {
  const s = summarize(runChecks(`<html><body><img src="a.png"></body></html>`));
  assert.equal(s.critical, 1);
  assert.equal(s.total, s.critical + s.serious + s.moderate + s.minor);
});

import { TooDeeplyNestedError, TooManyElementsError } from "./nestingGuard.js";

const wrap = (body: string) => `<html lang="en"><head><title>t</title></head><body><h1>x</h1>${body}</body></html>`;

test("icon links and buttons named on an inner element are not flagged", () => {
  const html = wrap(`<a href="/"><svg role="img" aria-label="Home"></svg></a>
    <button><svg role="img" aria-label="Close"></svg></button>
    <a href="/b"><span aria-hidden="true"></span><span class="sr-only">Basket</span></a>`);
  assert.deepEqual(ids(html), []);
});

test("an icon link with no name anywhere is still flagged", () => {
  assert.deepEqual(ids(wrap(`<a href="/"><svg role="img"></svg></a>`)), ["link-name"]);
  assert.deepEqual(ids(wrap(`<a href="/"><img src="l.png" alt=""></a>`)), ["link-name"]);
});

// Review finding: a name on a hidden inner element was accepted, so the classic unnamed icon
// link (Font Awesome style, aria-hidden icon with a title) came back clean. axe flags all of these.
test("a name on a hidden inner element does not name the link or button", () => {
  assert.deepEqual(ids(wrap(`<a href="/cart"><i class="fa fa-cart" aria-hidden="true" title="Cart"></i></a>`)), ["link-name"]);
  assert.deepEqual(ids(wrap(`<a href="/"><svg hidden aria-label="Home"></svg></a>`)), ["link-name"]);
  assert.deepEqual(ids(wrap(`<button><svg aria-hidden="true" aria-label="Menu"></svg></button>`)), ["button-name"]);
  assert.deepEqual(ids(wrap(`<a href="/x"><span style="display:none">Menu</span></a>`)), ["link-name"]);
  assert.deepEqual(ids(wrap(`<a href="/x"><span style="display: none"><img src="i.png" alt="Menu"></span></a>`)), ["link-name"]);
  // A visible name next to the hidden icon still counts.
  assert.deepEqual(ids(wrap(`<a href="/cart"><i aria-hidden="true" title="Cart"></i> Cart</a>`)), []);
  assert.deepEqual(ids(wrap(`<button><svg aria-hidden="true"></svg><span class="sr-only">Menu</span></button>`)), []);
});

test("images marked decorative are not flagged, but unmarked ones are", () => {
  assert.deepEqual(ids(wrap(`<img src="a.png" role="none"><img src="b.png" role="presentation"><img src="c.png" aria-hidden="true">`)), []);
  assert.deepEqual(ids(wrap(`<img src="a.png" aria-hidden="false">`)), ["img-alt"]);
});

test("an image button needs alt text", () => {
  assert.deepEqual(ids(wrap(`<input type="image" src="go.png">`)), ["img-alt"]);
  assert.deepEqual(ids(wrap(`<input type="image" src="go.png" alt="Search">`)), []);
});

test("thousands of labelled fields are checked in well under a second", () => {
  // This page took 11 seconds at 3,000 fields when every input searched every label.
  const fields = Array.from({ length: 12000 }, (_, i) => `<label for="i${i}">Field ${i}</label><input id="i${i}">`).join("");
  const started = Date.now();
  assert.deepEqual(ids(wrap(fields)), []);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started}ms`);
});

test("one unlabelled field among many labelled ones is still found", () => {
  const fields = Array.from({ length: 500 }, (_, i) => `<label for="i${i}">F</label><input id="i${i}">`).join("");
  assert.deepEqual(ids(wrap(fields + `<input id="lonely">`)), ["form-label"]);
});

test("analyzePage still analyses HTML nested hundreds of levels deep", () => {
  const deep = `<html lang="en"><title>t</title><body><h1>x</h1>${"<div>".repeat(350)}<a href="/x"></a>${"</div>".repeat(350)}</body></html>`;
  const { findings } = analyzePage(deep);
  assert.deepEqual(findings.map((f) => f.ruleId), ["link-name"]);
});

test("links and fields removed from the tab order and hidden from screen readers are not reported", () => {
  // Markup patterns from apple.com and react.dev: duplicate links hidden on purpose.
  const html = wrap(`<a class="tile-link" href="/a" aria-hidden="true" tabindex="-1"></a>
    <a data-hover="Thumbnail" href="/b" aria-hidden="true" tabindex="-1"><span></span></a>
    <a href="/c" aria-hidden="TRUE" tabindex="-1"></a>
    <div aria-hidden="true"><img src="x.png"></div>
    <div hidden><a href="/d"></a><button></button><input></div>`);
  assert.deepEqual(ids(html), []);
});

test("an unnamed element hidden from screen readers but still reachable by keyboard is reported", () => {
  // A keyboard user can land on these while a screen reader skips them: a real failure, not a hidden one.
  assert.deepEqual(ids(wrap(`<div aria-hidden="true"><a href="/x"></a></div>`)), ["link-name"]);
  assert.deepEqual(ids(wrap(`<div aria-hidden="true"><button></button></div>`)), ["button-name"]);
  assert.deepEqual(ids(wrap(`<div aria-hidden="true"><input></div>`)), ["form-label"]);
  assert.deepEqual(ids(wrap(`<a href="/a" aria-hidden="false" tabindex="-1"></a>`)), ["link-name"]);
  assert.deepEqual(ids(wrap(`<a href="/c" tabindex="-1"></a>`)), ["link-name"]);
});

test("a closed dialog is not scanned but an open one is", () => {
  // wikipedia.org ships a closed <dialog> containing an unnamed icon button.
  assert.deepEqual(ids(wrap(`<dialog><button><svg></svg></button></dialog>`)), []);
  assert.deepEqual(ids(wrap(`<dialog open><button><svg></svg></button></dialog>`)), ["button-name"]);
});

test("headings nobody can reach do not change the outline", () => {
  assert.deepEqual(ids(wrap(`<h1>a</h1><div hidden><h4>x</h4></div><h2>b</h2>`)), []);
  assert.deepEqual(ids(wrap(`<h1>a</h1><dialog><h4>x</h4></dialog><h2>b</h2>`)), []);
  assert.deepEqual(ids(wrap(`<h1>a</h1><div aria-hidden="true"><h5>x</h5></div><h2>b</h2>`)), []);
  // A hidden h1 does not count as the page's h1.
  // (wrap() already supplies a visible h1, so build this page by hand.)
  assert.deepEqual(ids(`<html lang="en"><head><title>t</title></head><body><div hidden><h1>x</h1></div><h2>b</h2></body></html>`), ["heading-h1"]);
  // A visible skip is still found.
  assert.deepEqual(ids(wrap(`<h4>x</h4>`)), ["heading-order"]);
});

test("script, style and hidden text do not give a link or button a name", () => {
  assert.deepEqual(ids(wrap(`<a href="/x"><script>var x = 1</script></a>`)), ["link-name"]);
  assert.deepEqual(ids(wrap(`<button><style>.a { color: red }</style></button>`)), ["button-name"]);
  assert.deepEqual(ids(wrap(`<a href="/x"><span hidden>Go</span></a>`)), ["link-name"]);
  assert.deepEqual(ids(wrap(`<a href="/x"><span aria-hidden="true">Go</span></a>`)), ["link-name"]);
  // Real visible text still names it, even next to a script.
  assert.deepEqual(ids(wrap(`<a href="/x">Go<script>var x = 1</script></a>`)), []);
});

test("an empty label or an aria-labelledby that points nowhere names nothing", () => {
  assert.deepEqual(ids(wrap(`<label for="q"></label><input id="q">`)), ["form-label"]);
  assert.deepEqual(ids(wrap(`<label><input></label>`)), ["form-label"]);
  assert.deepEqual(ids(wrap(`<label><select><option>One</option></select></label>`)), ["form-label"]);
  assert.deepEqual(ids(wrap(`<input aria-labelledby="nope">`)), ["form-label"]);
  assert.deepEqual(ids(wrap(`<a href="/x" aria-labelledby="nope"></a>`)), ["link-name"]);
  assert.deepEqual(ids(wrap(`<span id="e"></span><a href="/x" aria-labelledby="e"></a>`)), ["link-name"]);
});

test("real labels and aria-labelledby targets still work", () => {
  assert.deepEqual(ids(wrap(`<label for="q">Search</label><input id="q">`)), []);
  assert.deepEqual(ids(wrap(`<label>Email <input></label>`)), []);
  assert.deepEqual(ids(wrap(`<label><img src="e.png" alt="Email"><input></label>`)), []);
  assert.deepEqual(ids(wrap(`<span id="n">Name</span><input aria-labelledby="n">`)), []);
  assert.deepEqual(ids(wrap(`<span id="n" hidden>Close</span><button aria-labelledby="n"></button>`)), []);
});

test("one label wrapping thousands of unnamed inputs is analysed in under a second", () => {
  // This page (14 KB) took about 30 s at 2,000 inputs when each input re-read the whole label.
  const inputs = "<input>".repeat(2000);
  const started = Date.now();
  const found = ids(wrap(`<label>${inputs}</label>`));
  assert.equal(found.length, 2000);
  assert.ok(found.every((id) => id === "form-label"));
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
});

test("many controls pointing at one aria-labelledby target are analysed quickly", () => {
  const buttons = '<button aria-labelledby="n"></button>'.repeat(3000);
  const started = Date.now();
  assert.deepEqual(ids(wrap(`<span id="n">Close</span>${buttons}`)), []);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started}ms`);
});

test("an aria-labelledby target named by an inner image alt or its own title names the control", () => {
  assert.deepEqual(ids(wrap(`<span id="n"><img src="x.png" alt="Close"></span><button aria-labelledby="n"></button>`)), []);
  assert.deepEqual(ids(wrap(`<span id="n" title="Close"></span><button aria-labelledby="n"></button>`)), []);
  assert.deepEqual(ids(wrap(`<span id="n"><img src="x.png" alt="Email"></span><input aria-labelledby="n">`)), []);
  // An empty alt is decorative and names nothing.
  assert.deepEqual(ids(wrap(`<span id="n"><img src="x.png" alt=""></span><button aria-labelledby="n"></button>`)), ["button-name"]);
  assert.deepEqual(ids(wrap(`<span id="n" title=" "></span><button aria-labelledby="n"></button>`)), ["button-name"]);
});

test("a title on the label itself does not label its field, but a title on the field does", () => {
  // Other scanners do not accept a label's own title, so neither do we.
  assert.deepEqual(ids(wrap(`<label for="q" title="Search"></label><input id="q">`)), ["form-label"]);
  assert.deepEqual(ids(wrap(`<label title="Search"><input></label>`)), ["form-label"]);
  assert.deepEqual(ids(wrap(`<label for="q"></label><input id="q" title="Search">`)), []);
});

test("an aria-labelledby target that is itself an image with alt names the control", () => {
  assert.deepEqual(ids(wrap(`<img id="n" src="x.png" alt="Close"><button aria-labelledby="n"></button>`)), []);
  assert.deepEqual(ids(wrap(`<img id="n" src="x.png" alt=""><button aria-labelledby="n"></button>`)), ["button-name"]);
  assert.deepEqual(ids(wrap(`<img id="n" src="x.png"><button aria-labelledby="n"></button>`)), ["img-alt", "button-name"]);
});

test("an image alt inside a hidden or aria-hidden child names nothing", () => {
  assert.deepEqual(ids(wrap(`<span id="n"><img src="x.png" alt="Close" aria-hidden="true"></span><button aria-labelledby="n"></button>`)), ["button-name"]);
  assert.deepEqual(ids(wrap(`<span id="n"><span hidden><img src="x.png" alt="Close"></span></span><button aria-labelledby="n"></button>`)), ["button-name"]);
  assert.deepEqual(ids(wrap(`<button><span aria-hidden="true"><img src="x.png" alt="Close"></span></button>`)), ["button-name"]);
  assert.deepEqual(ids(wrap(`<a href="/x"><img src="x.png" alt="Home" hidden></a>`)), ["link-name"]);
  assert.deepEqual(ids(wrap(`<label><img src="e.png" alt="Email" aria-hidden="true"><input></label>`)), ["form-label"]);
  // A visible image next to a hidden one still names it, and a hidden ancestor of the
  // control itself is not this check's business (the control is skipped as unreachable).
  assert.deepEqual(ids(wrap(`<button><img src="x.png" alt="Close"><img src="y.png" alt="x" hidden></button>`)), []);
  assert.deepEqual(ids(wrap(`<div aria-hidden="true"><a href="/x" tabindex="-1"><img src="x.png" alt="Home"></a></div>`)), []);
});

test("analyzePage refuses a 2,000-deep page quickly, before parsing", () => {
  const deep = `<html lang="en"><title>t</title><body>${"<div>".repeat(2000)}x${"</div>".repeat(2000)}</body></html>`;
  const started = Date.now();
  assert.throws(() => analyzePage(deep), TooDeeplyNestedError);
  assert.ok(Date.now() - started < 200, `took ${Date.now() - started}ms`);
});

// htmlparser2 builds no implied <head> or <body>, so these rules must not rely on them.
test("page-title works with and without an explicit head, and ignores svg titles", () => {
  const has = (html: string) => runChecks(html).some((f) => f.ruleId === "page-title");
  assert.equal(has(`<html lang="en"><head><title>Hi</title></head><body><h1>x</h1></body></html>`), false);
  assert.equal(has(`<html lang="en"><title>Hi</title><body><h1>x</h1></body></html>`), false);
  assert.equal(has(`<html lang="en"><body><svg><title>Logo</title></svg><h1>x</h1></body></html>`), true);
  assert.equal(has(`<html lang="en"><head><title> </title></head><body></body></html>`), true);
});

test("detectLimits reads text from a fragment that has no body tag", async () => {
  const { detectLimits } = await import("./checks.js");
  const longText = "A paragraph of readable words. ".repeat(10);
  assert.deepEqual(detectLimits(`<p>${longText}</p><script src="a.js"></script>`), []);
});

// ---- Fixes from the pre-launch review ----

const page = (body: string) => `<html lang="en"><head><title>t</title></head><body><h1>x</h1>${body}</body></html>`;

test("content inside <template> and <noscript> is not scanned", () => {
  // Lazy-loading plugins duplicate every image in a <noscript>; counting both doubled the problems.
  assert.deepEqual(ids(page(`<template><img src="a"><button></button></template><noscript><img src="b"></noscript>`)), []);
  // The same elements outside them are still found.
  assert.deepEqual(ids(page(`<img src="a"><button></button>`)).sort(), ["button-name", "img-alt"]);
});

test("an image named by aria-label, aria-labelledby or title is not missing alt text", () => {
  assert.deepEqual(ids(page(`<img src="a" aria-label="Team photo"><img src="b" title="Logo">`)), []);
  assert.deepEqual(ids(page(`<span id="cap">Our team</span><img src="a" aria-labelledby="cap">`)), []);
  // An aria-labelledby that points nowhere names nothing.
  assert.deepEqual(ids(page(`<img src="a" aria-labelledby="missing">`)), ["img-alt"]);
  assert.deepEqual(ids(page(`<input type="image" src="go.png" aria-label="Go">`)), []);
});

test("custom buttons and input buttons need a name", () => {
  assert.deepEqual(ids(page(`<div role="button" tabindex="0"></div>`)), ["button-name"]);
  assert.deepEqual(ids(page(`<div role="button" tabindex="0">Open menu</div><span role="BUTTON" aria-label="Close"></span>`)), []);
  assert.deepEqual(ids(page(`<input type="button">`)), ["button-name"]);
  assert.deepEqual(ids(page(`<input type="button" value="Save"><input type="submit"><input type="reset"><input type="button" aria-label="Go">`)), []);
  // A real link or button with role="button" is reported once, not twice.
  assert.deepEqual(ids(page(`<a href="/x" role="button"></a>`)), ["link-name"]);
  assert.deepEqual(ids(page(`<button role="button"></button>`)), ["button-name"]);
});

test("inline display:none hides an element from the checks, like [hidden]", () => {
  assert.deepEqual(ids(page(`<div style="color:red; display : none"><img src="a"><button></button></div>`)), []);
  assert.deepEqual(ids(page(`<div style="display:block"><img src="a"></div>`)), ["img-alt"]);
  assert.deepEqual(ids(page(`<div style="display:none !important"><img src="a"></div>`)), []);
  // Only the whole value "none" hides: a longer value that merely starts with it does not.
  assert.deepEqual(ids(page(`<div style="display:none-ish"><img src="a"></div>`)), ["img-alt"]);
});

test("hidden-ancestor checks stay correct deep in the tree", () => {
  const open = "<div>".repeat(200);
  const close = "</div>".repeat(200);
  assert.deepEqual(ids(page(`<div hidden>${open}<img src="a">${close}</div>`)), []);
  assert.deepEqual(ids(page(`<div aria-hidden="true">${open}<img src="a">${close}</div>`)), []);
  assert.deepEqual(ids(page(`${open}<img src="a">${close}`)), ["img-alt"]);
});

// ---- Speed: every input below once cost seconds or minutes (measured in the review) ----

// Timing bound: the slowest of these takes under 0.7 s here, so 4 s is a margin of about six times for
// slower hardware. It is a tripwire for the order-of-magnitude blowups the reviews found (5 to 45 s), not
// a measurement. What each case must DO is asserted structurally as well, so a case cannot pass by
// being refused when it should have been analysed, or the reverse.
function runCase(label: string, html: string, expected: "refused" | "analysed", limitMs = 4000): void {
  const started = performance.now();
  let outcome: "refused" | "analysed" = "analysed";
  try {
    analyzePage(html);
  } catch (error) {
    if (!(error instanceof TooDeeplyNestedError || error instanceof TooManyElementsError)) throw error;
    outcome = "refused";
  }
  const elapsed = performance.now() - started;
  assert.equal(outcome, expected, `${label} was ${outcome}, expected ${expected}`);
  assert.ok(elapsed < limitMs, `${label} took ${elapsed.toFixed(0)} ms, limit ${limitMs} ms`);
}

test("hostile pages that once took seconds are refused quickly", () => {
  const cases: Array<[string, string]> = [
    ["1400 divs and 2000 headings", "<div>".repeat(1400) + "<h2>x</h2>".repeat(2000)],
    ["1400 divs and 3000 links", "<div>".repeat(1400) + "<a href=x></a>".repeat(3000)],
    ['"<" in every attribute', '<h2 title="<">'.repeat(5000)],
    ["<div/> x 3000 and headings", "<div/>".repeat(3000) + "<h2>x</h2>".repeat(2000)],
    // Found by the second review: each hid its tags from the old estimate.
    ["short comment then 100,000 tags", "<!-->" + "<i>".repeat(100000)],
    ["self-closed script then 100,000 tags", "<script/>" + "<i>".repeat(100000)],
    ["foreignObject then self-closed divs", "<svg><foreignObject>" + "<div/>".repeat(100000)],
    ["stray </br> closers past the element cap", "</br>".repeat(400000)],
    // Third review: declarations and comments were not counted, so 2 MB of them built a 74 MB tree.
    ["2 MB of <!a> declarations", "<!a>".repeat(500000)],
    ["2 MB of empty comments", "<!---->".repeat(300000)],
  ];
  for (const [label, html] of cases) runCase(label, html, "refused", 1500);
});

test("large pages inside the limits are analysed, not refused, and stay fast", () => {
  const cases: Array<[string, string]> = [
    ["399 deep, 20,000 links", "<div>".repeat(399) + "<a href=x></a>".repeat(20000)],
    // cheerio's find() is quadratic in the child count; these have one huge parent.
    ["one link, 100,000 empty children", "<a href=x>" + "<i></i>".repeat(100000) + "</a>"],
    ["one label, 20,000 inputs", "<label>" + "<input>".repeat(20000) + "</label>"],
    // Nested links around lots of markup re-read the same content once per level.
    ["399 nested links, 140,000 elements", "<a href=x>".repeat(399) + "<i></i>".repeat(140000) + "</a>".repeat(399)],
    // 20,000 top-level siblings: every top-level query used to be quadratic.
    ["20,000 top-level siblings", "<div><p>hello <a href='/x'>link</a> <img src=a alt=b> <input id=i> <label for=i>L</label></p></div>".repeat(20000)],
    // Second review: closest("label") per control cost controls x depth (5.8 s, 18.7 s).
    ["395 deep, 60,000 inputs", "<div>".repeat(395) + "<input>".repeat(60000)],
    ["395 deep, 30,000 label and input pairs", "<div>".repeat(395) + "<label for=x><input id=x></label>".repeat(30000)],
    // Second review: detectLimits used cheerio remove() on a wide parent (15 s and 45 s).
    ["body with 100,000 style elements", "<body>" + "<style></style>".repeat(100000)],
    ["100,000 top-level style elements", "<style></style>".repeat(100000)],
  ];
  for (const [label, html] of cases) runCase(label, html, "analysed");
});

test("many deep titles do not make the page-title check slow", () => {
  // Third review: $("title").not("body title, svg title") walked every title's ancestors (about 2 s).
  runCase("395 deep, 140,000 titles", "<div>".repeat(395) + "<title></title>".repeat(140000) + "</div>".repeat(395), "analysed", 1500);
});

test("excerpts of a huge attribute do not keep the attribute in memory", () => {
  // Third review: excerpts escaped the whole 2 MB attribute before cutting it, and the 160-character
  // slice kept the escaped 12 MB string alive; 14 nested links held about 170 MB, enough to kill a
  // 128 MB Worker isolate. gc() is reached through the V8 flag so the retained size can be measured.
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as () => void;
  const html =
    '<a href="">'.repeat(14) + "<span hidden data-x='" + '"'.repeat(2_000_000) + "'></span>" + "</a>".repeat(14);
  gc();
  const before = process.memoryUsage().heapUsed;
  const started = performance.now();
  const result = analyzePage(html);
  const elapsed = performance.now() - started;
  gc();
  const retainedMb = (process.memoryUsage().heapUsed - before) / 1e6;
  assert.ok(result.findings.length >= 14, "the nested unnamed links are still reported");
  assert.ok(result.findings.every((f) => (f.snippet ?? "").length <= 163), "excerpts stay short");
  assert.ok(retainedMb < 20, `findings kept ${retainedMb.toFixed(0)} MB alive`);
  assert.ok(elapsed < 1500, `took ${elapsed.toFixed(0)} ms`);
});

test("a page with too many elements is refused with a plain message", () => {
  assert.throws(() => analyzePage("<i></i>".repeat(200000)), /too many elements/);
});

test("many self-closed icons inside one svg do not count as nesting", () => {
  const icon = `<svg>${'<path d="M0 0"/>'.repeat(2000)}</svg>`;
  assert.doesNotThrow(() => analyzePage(page(icon.repeat(3))));
});

// ---- Rule accuracy against axe (review of 18 real pages and 56 edge cases) ----

test("ARIA headings count, and aria-level sets the level", () => {
  // Page builders emit role="heading"; it was ignored, so pages got a false "no h1".
  assert.deepEqual(ids(wrap(`<div role="heading" aria-level="1">Main</div><h2>Sub</h2>`).replace("<h1>x</h1>", "")), []);
  assert.deepEqual(ids(wrap(`<h2 aria-level="1">Main</h2><h2>Sub</h2>`).replace("<h1>x</h1>", "")), []);
  // role="heading" with no aria-level is level 2.
  assert.deepEqual(ids(wrap(`<div role="heading">Sub</div><h3>Deeper</h3>`)), []);
  assert.deepEqual(ids(wrap(`<div role="heading">Sub</div><h4>Too deep</h4>`)), ["heading-order"]);
  // An h1 given another role is not a heading, so it does not supply the h1.
  assert.deepEqual(ids(wrap(`<h1 role="presentation">Logo</h1><h2>Sub</h2>`).replace("<h1>x</h1>", "")), ["heading-h1"]);
});

test("a heading-order finding names the heading that jumped", () => {
  const findings = runChecks(wrap(`<h2>a</h2><h5>Jumped here</h5>`));
  const jump = findings.find((f) => f.ruleId === "heading-order");
  assert.match(jump?.snippet ?? "", /<h5>Jumped here<\/h5>/);
});

test("a field named only by its placeholder is reported apart from an unlabelled one", () => {
  const findings = runChecks(wrap(`<input type="search" placeholder="Search"><input type="text">`));
  assert.deepEqual(findings.map((f) => [f.ruleId, f.severity]), [["placeholder-label", "moderate"], ["form-label", "critical"]]);
  // A blank placeholder names nothing.
  assert.deepEqual(ids(wrap(`<input placeholder="  ">`)), ["form-label"]);
  // A labelled field with a placeholder is fine.
  assert.deepEqual(ids(wrap(`<label for="q">Search</label><input id="q" placeholder="e.g. braces">`)), []);
});

test("every viewport tag is read and any non-yes user-scalable blocks zoom", () => {
  const withViewport = (...contents: string[]) =>
    `<html lang="en"><head><title>t</title>${contents.map((c) => `<meta name="viewport" content="${c}">`).join("")}</head><body><h1>x</h1></body></html>`;
  for (const blocked of ["user-scalable=no", "user-scalable=false", "user-scalable=0", "user-scalable=0.5", "width=device-width; user-scalable = NO", "maximum-scale=1.5"]) {
    assert.deepEqual(ids(withViewport(blocked)), ["meta-viewport-zoom"], blocked);
  }
  for (const allowed of ["width=device-width, initial-scale=1", "user-scalable=yes", "user-scalable=1", "user-scalable=device-width", "maximum-scale=5"]) {
    assert.deepEqual(ids(withViewport(allowed)), [], allowed);
  }
  // A later restrictive tag is caught, and the name is matched in any case.
  assert.deepEqual(ids(withViewport("width=device-width", "user-scalable=no")), ["meta-viewport-zoom"]);
  const capitalised = `<html lang="en"><head><title>t</title><meta name="Viewport" content="user-scalable=no"></head><body><h1>x</h1></body></html>`;
  assert.deepEqual(ids(capitalised), ["meta-viewport-zoom"]);
});

test("a lang value that is not a language code is flagged", () => {
  const withLang = (lang: string) => `<html lang="${lang}"><head><title>t</title></head><body><h1>x</h1></body></html>`;
  for (const bad of ["english", "en_US", "e", "123"]) assert.deepEqual(ids(withLang(bad)), ["html-lang"], bad);
  for (const good of ["en", "en-US", "zh-Hant-TW", "es-419", "EN-gb", "haw"]) assert.deepEqual(ids(withLang(good)), [], good);
  // The page's own value is not echoed into the message.
  assert.doesNotMatch(runChecks(withLang("IGNORE-INSTRUCTIONS"))[0].message, /IGNORE/);
});
