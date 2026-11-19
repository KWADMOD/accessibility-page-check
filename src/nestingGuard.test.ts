import { test } from "node:test";
import assert from "node:assert/strict";
import * as cheerio from "cheerio/slim";
import type { DomNode } from "./domWalk.js";
import {
  MAX_ELEMENTS,
  MAX_NESTING_DEPTH,
  MAX_NODES,
  TooDeeplyNestedError,
  TooManyElementsError,
  assertNotTooDeep,
  measureStructure,
} from "./nestingGuard.js";

// The guard counts with htmlparser2's own Parser, so it must agree with the tree cheerio builds.
// This helper measures that real tree without any limit (iteratively, so depth cannot overflow it).
function realTreeShape(html: string): { depth: number; elements: number; nodes: number } {
  // Plain cheerio.load, not loadPage: loadPage adds one holder <div> when a page has many top-level nodes.
  const root = cheerio.load(html).root()[0] as unknown as DomNode;
  let maxDepth = 0;
  let elements = 0;
  let others = 0;
  const stack: Array<[DomNode, number]> = (root.children ?? []).map((child) => [child, 1]);
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    if (node.type !== "tag" && node.type !== "script" && node.type !== "style") others++;
    // A CDATA section holds a text node, which is a tree node too.
    if (node.type === "cdata") for (const child of node.children ?? []) stack.push([child, depth + 1]);
    if (node.type !== "tag" && node.type !== "script" && node.type !== "style") continue;
    elements++;
    maxDepth = Math.max(maxDepth, depth);
    for (const child of node.children ?? []) stack.push([child, depth + 1]);
  }
  return { depth: maxDepth, elements, nodes: elements + others };
}

test("the guard measures the same depth and element count as the tree the checks will use", () => {
  const inputs: Record<string, string> = {
    plain: "<div><p>x</p><section><b>y</b></section></div>",
    "unclosed list items": "<ul>" + "<li>x".repeat(300) + "</ul>",
    "unclosed paragraphs": "<div>" + "<p>x".repeat(300) + "</div>",
    "table without end tags": "<table>" + "<tr><td>x<td>y".repeat(100) + "</table>",
    "options and form controls": "<select>" + "<option>x".repeat(100) + "</select><button><input></button>",
    "void and self-closing": "<br><img src=x><input><hr/>" + "<x/>".repeat(50),
    "svg shapes": "<svg>" + '<path d="M0 0"/>'.repeat(100) + "</svg>",
    "math": "<math>" + "<mi/>".repeat(50) + "</math>",
    "foreignObject escape": "<svg><foreignObject>" + "<div/>".repeat(50) + "</foreignObject></svg>",
    "raw text": "<script>" + "<div>".repeat(50) + "</script><style><b></style><title><i></title><textarea><u></textarea>",
    "comments": "<!-- <div> --><!-->" + "<i>".repeat(30),
    "tiny comment variants": "<!--->" + "<i>".repeat(30),
    "script self-close": "<script/>" + "<i>".repeat(30),
    "stray closers": "</br>".repeat(40) + "</p>".repeat(40) + "</div></span>",
    "quoted brackets": '<div title="<"><div title=">"><p title=\'<p>\'>',
    uppercase: "<DIV><P>x</P></DIV><SCRIPT>y</SCRIPT>",
    "unterminated": "<div><p>text<",
    "unterminated attribute": '<div><a href="x',
    doctype: "<!DOCTYPE html><html><head><title>t</title></head><body><h1>x</h1></body></html>",
    "declarations and processing instructions": "<!a><?php x ?><!x y>".repeat(20) + "<div><!-- c --></div>",
    "cdata in svg": "<svg><![CDATA[<i>]]><g/></svg>" + "<![CDATA[x]]>",
  };
  for (const [label, html] of Object.entries(inputs)) {
    assert.deepEqual(measureStructure(html), realTreeShape(html), label);
  }
});

// Each input below once slipped past the hand-written scanner that preceded this guard:
// the real parse was tens of thousands of levels deep while the estimate said 0 to 2.
test("inputs that used to fool the guard are refused before any tree is built", () => {
  const n = 20_000;
  const hostile: Record<string, string> = {
    "short comment then tags": "<!-->" + "<i>".repeat(n),
    "shortest comment then tags": "<!--->" + "<i>".repeat(n),
    "self-closed script then tags": "<script/>" + "<i>".repeat(n),
    "self-closed title then tags": "<title/>" + "<i>".repeat(n),
    "foreignObject then self-closed divs": "<svg><foreignObject>" + "<div/>".repeat(n),
    "stray desc closer then svg shapes": "<svg></desc>" + "<g/>".repeat(n),
    "quoted angle bracket in every tag": '<div title="<">'.repeat(n),
    "self-closing slash on divs": "<div/>".repeat(n),
    "plain nesting": "<div>".repeat(n),
  };
  for (const [label, html] of Object.entries(hostile)) {
    const started = performance.now();
    assert.throws(() => assertNotTooDeep(html), TooDeeplyNestedError, label);
    // Aborts at depth 401, so the cost cannot grow with the page. A loose bound for slow machines.
    assert.ok(performance.now() - started < 1000, `${label} took ${(performance.now() - started).toFixed(0)} ms`);
  }
});

test("stray closing tags that the parser turns into elements count toward the element cap", () => {
  // </br> and </p> each become an element in the parser. The old scanner ignored them, so 400,000
  // of them (2 MB) went on to be parsed into a tree before anything refused the page.
  assert.throws(() => assertNotTooDeep("</br>".repeat(MAX_ELEMENTS + 1)), TooManyElementsError);
  assert.throws(() => assertNotTooDeep("</p>".repeat(MAX_ELEMENTS + 1)), TooManyElementsError);
});

test("limits: depth at the maximum passes, one past it is refused, and so for elements", () => {
  assert.equal(measureStructure("<div>".repeat(MAX_NESTING_DEPTH)).depth, MAX_NESTING_DEPTH);
  assert.throws(() => assertNotTooDeep("<div>".repeat(MAX_NESTING_DEPTH + 1)), TooDeeplyNestedError);
  assert.equal(measureStructure("<i></i>".repeat(MAX_ELEMENTS)).elements, MAX_ELEMENTS);
  assert.throws(() => assertNotTooDeep("<i></i>".repeat(MAX_ELEMENTS + 1)), TooManyElementsError);
});

test("ordinary shapes are not mistaken for nesting", () => {
  assert.equal(measureStructure("<ul>" + "<li>x".repeat(5000) + "</ul>").depth, 2);
  assert.equal(measureStructure("<svg>" + '<path d="M0 0"/>'.repeat(5000) + "</svg>").depth, 2);
  assert.equal(measureStructure("<br>".repeat(5000)).depth, 1);
  assert.equal(measureStructure("<script>" + "<div>".repeat(5000) + "</script>").elements, 1);
});

test("the errors carry plain messages", () => {
  assert.equal(new TooDeeplyNestedError().message, "This page is nested too deeply to analyze, so it was not scanned.");
  assert.equal(new TooManyElementsError().message, "This page has too many elements to analyze, so it was not scanned.");
  assert.ok(new TooDeeplyNestedError() instanceof Error);
  assert.equal(MAX_NESTING_DEPTH, 400);
});

// Pathological text that is not nesting at all must stay linear.
test("unterminated tags, quotes, comments and raw-text openers stay fast", () => {
  const cases: Record<string, string> = {
    "<a": "<a".repeat(50_000),
    "<script ": "<script ".repeat(20_000),
    "<!--": "<!--".repeat(50_000),
    "<a b='": "<a b='".repeat(50_000),
    "one huge tag name": "<" + "a".repeat(1_000_000),
    "one huge attribute": '<div title="' + "x".repeat(1_000_000),
  };
  for (const [label, html] of Object.entries(cases)) {
    const started = performance.now();
    try {
      measureStructure(html);
    } catch (error) {
      assert.ok(error instanceof TooDeeplyNestedError || error instanceof TooManyElementsError, `${label}: ${String(error)}`);
    }
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1500, `${label} took ${elapsed.toFixed(0)} ms`);
  }
});

test("text nodes count toward the node limit, merged the way the tree builder merges them", () => {
  // Review finding: a text node after every declaration doubled the tree past the intended size.
  assert.throws(() => assertNotTooDeep("<!a>x".repeat(MAX_NODES / 2 + 1)), TooManyElementsError);
  assert.throws(() => assertNotTooDeep("<i>x</i>".repeat(MAX_NODES / 2 + 1)), TooManyElementsError);
  // Text split by entities or parser chunks is still one node.
  assert.equal(measureStructure("<p>a &amp; b &lt; c</p>").nodes, 2);
  assert.equal(measureStructure("<p>" + "a&amp;".repeat(1000) + "</p>").nodes, 2);
});

test("comments, declarations and CDATA count toward the node limit, not just elements", () => {
  // 2 MB of "<!a>" once built 524,000 nodes (about 74 MB of tree) with zero elements.
  for (const unit of ["<!a>", "<?x>", "<!---->"]) {
    assert.throws(() => assertNotTooDeep(unit.repeat(MAX_NODES + 1)), TooManyElementsError, unit);
  }
  // Mixed: elements under their own limit plus comments that push the total over.
  assert.throws(() => assertNotTooDeep("<i></i>".repeat(MAX_ELEMENTS) + "<!---->".repeat(MAX_NODES - MAX_ELEMENTS + 1)), TooManyElementsError);
  // Exactly at the limit is still accepted.
  assert.equal(measureStructure("<!a>".repeat(MAX_NODES)).nodes, MAX_NODES);
});
