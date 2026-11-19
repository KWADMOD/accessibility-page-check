import * as cheerio from "cheerio/slim";
import { MAX_ELEMENTS, MAX_NESTING_DEPTH, MAX_NODES, TooDeeplyNestedError, TooManyElementsError } from "./nestingGuard.js";

// One top-down pass over the parsed tree that records which elements are hidden.
//
// Why this exists: the checks used to ask "is this element inside a hidden or aria-hidden
// ancestor?" with a selector (closest) for every element, and each such call walks the whole
// ancestor chain. A 30 KB page with 1,400 nested divs and 2,000 headings then cost 15 seconds.
// Visiting each node once and remembering the answer makes the same question O(1).
//
// The tree is also measured here, on the real parse result: the pre-parse estimate in
// nestingGuard.ts can be fooled by unusual markup, this cannot.

/** The few fields of a parsed node we read; keeps this file free of the parser's own types. */
export interface DomNode {
  type: string;
  name?: string;
  attribs?: Record<string, string>;
  children?: DomNode[];
  parent?: DomNode | null;
  /** Text of a text node. */
  data?: string;
}

export interface TreeSurvey {
  /** Elements nobody can reach: [hidden], a closed dialog, inline display:none, template, noscript. */
  notRendered: Set<DomNode>;
  /** Elements inside (or being) aria-hidden="true". */
  ariaHidden: Set<DomNode>;
  /**
   * Elements that hide themselves (not their descendants): [hidden], aria-hidden="true" or an
   * inline display:none. Their content names nothing, so a control's name never comes from them.
   */
  selfHidden: Set<DomNode>;
  /**
   * The first <title> in document order that is not inside <body> or <svg>: the page's title.
   * Found here because the selector it replaces ($("title").not("body title, svg title"))
   * walked every title's ancestor chain twice; 140,000 titles 395 levels deep cost about 2 s.
   */
  pageTitle: DomNode | undefined;
}

// Inline style only; a stylesheet rule cannot be seen from raw HTML (listed in NOT_CHECKED).
// Matches only the whole value "none" (optionally "!important"), so "display:none-ish" or a longer value is not hidden.
const DISPLAY_NONE = /(?:^|;)\s*display\s*:\s*none\s*(?:!\s*important\s*)?(?:;|$)/i;

const isElement = (node: DomNode): boolean => node.type === "tag" || node.type === "script" || node.type === "style";

export function surveyTree(root: DomNode): TreeSurvey {
  const notRendered = new Set<DomNode>();
  const ariaHidden = new Set<DomNode>();
  const selfHidden = new Set<DomNode>();

  let pageTitle: DomNode | undefined;

  // Explicit stack, not recursion: a deep page must never be able to overflow ours.
  // Children are pushed in reverse so they are popped in document order (needed for pageTitle).
  type Entry = { node: DomNode; depth: number; notRendered: boolean; ariaHidden: boolean; inBodyOrSvg: boolean };
  const stack: Entry[] = [];
  const pushChildren = (parent: DomNode, entry: Omit<Entry, "node">): void => {
    const children = parent.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i], ...entry });
  };
  pushChildren(root, { depth: 1, notRendered: false, ariaHidden: false, inBodyOrSvg: false });
  let elementCount = 0;
  let nodeCount = 0;

  while (stack.length > 0) {
    const { node, depth, notRendered: nr, ariaHidden: ah, inBodyOrSvg } = stack.pop()!;
    // Every node counts toward the node limit (text, comments and declarations too), as in the guard.
    if (++nodeCount > MAX_NODES + 1) throw new TooManyElementsError();
    if (!isElement(node)) continue;
    // +1 on each limit: loadPage may add one holder <div> that the guard's count does not include.
    if (depth > MAX_NESTING_DEPTH + 1) throw new TooDeeplyNestedError();
    if (++elementCount > MAX_ELEMENTS + 1) throw new TooManyElementsError();

    const attribs = node.attribs ?? {};
    const hasHiddenAttribute = "hidden" in attribs;
    const hasAriaHidden = (attribs["aria-hidden"] ?? "").toLowerCase() === "true";
    const name = node.name ?? "";
    const inlineDisplayNone = DISPLAY_NONE.test(attribs.style ?? "");
    const hereNotRendered =
      nr ||
      hasHiddenAttribute ||
      (name === "dialog" && !("open" in attribs)) ||
      // Their content is not part of the page a person sees: a template is inert and
      // noscript only shows with scripts off (lazy-load plugins duplicate every image there).
      name === "template" ||
      name === "noscript" ||
      inlineDisplayNone;
    const hereAriaHidden = ah || hasAriaHidden;

    if (hasHiddenAttribute || hasAriaHidden || inlineDisplayNone) selfHidden.add(node);
    if (hereNotRendered) notRendered.add(node);
    if (hereAriaHidden) ariaHidden.add(node);
    if (name === "title" && !inBodyOrSvg && pageTitle === undefined) pageTitle = node;

    pushChildren(node, {
      depth: depth + 1,
      notRendered: hereNotRendered,
      ariaHidden: hereAriaHidden,
      inBodyOrSvg: inBodyOrSvg || name === "body" || name === "svg",
    });
  }
  return { notRendered, ariaHidden, selfHidden, pageTitle };
}

/**
 * Parses HTML the way every check expects: cheerio/slim, plus one guard for a quirk.
 *
 * The quirk: cheerio answers every top-level $("selector") by handing css-select the
 * document's direct children, and css-select first removes "subsets" from that list in
 * time quadratic in its length. A normal page has one <html> element there. A fragment
 * with tens of thousands of top-level siblings (no <html>/<body>, which htmlparser2 does
 * not invent) made each of about fifteen queries cost many seconds. Moving such children
 * under one holder <div> keeps queries linear, and changes nothing a selector can see,
 * because every selector here searches descendants.
 */
const MANY_TOP_LEVEL_NODES = 64;

export function loadPage(html: string): cheerio.CheerioAPI {
  const $ = cheerio.load(html);
  const root = $.root()[0] as unknown as DomNode;
  const topLevel = root.children ?? [];
  if (topLevel.length > MANY_TOP_LEVEL_NODES) {
    const holder = $("<div></div>")[0] as unknown as DomNode;
    holder.children = topLevel;
    for (const node of topLevel) node.parent = holder;
    holder.parent = root;
    root.children = [holder];
  }
  return $;
}

/** What a subtree search should do after looking at one node. */
export type Visit = "found" | "skip" | "continue";

/**
 * Builds a "does anything below this node match?" test. `visit` judges one node:
 * "found" ends the search with a yes, "skip" ignores that node and everything under it,
 * "continue" looks at its children. Answers are remembered per node.
 *
 * Why not cheerio's find()/clone()/remove(): on an element with many children they cost
 * time quadratic in the child count (css-select de-duplicates the child list pairwise,
 * removing siblings one by one shifts the array each time), so one link wrapping 100,000
 * empty spans took half a minute.
 * Why remembered: with nested links each outer link would walk everything the inner ones
 * already walked, so 400 nested links around 140,000 elements took 14 seconds. With the
 * memo every node is judged once per test, so the cost is linear however the page nests.
 * Recursion depth is the page's nesting depth, which surveyTree has already capped.
 * The answer for a node does not depend on which element the question started from,
 * so one memo can serve every caller of the same test.
 */
export function makeSubtreeSearch(visit: (node: DomNode) => Visit): (root: DomNode) => boolean {
  const memo = new Map<DomNode, boolean>();
  const anyBelow = (node: DomNode): boolean => {
    const known = memo.get(node);
    if (known !== undefined) return known;
    let result = false;
    for (const child of node.children ?? []) {
      const verdict = visit(child);
      if (verdict === "found" || (verdict === "continue" && anyBelow(child))) {
        result = true;
        break;
      }
    }
    memo.set(node, result);
    return result;
  };
  return anyBelow;
}
