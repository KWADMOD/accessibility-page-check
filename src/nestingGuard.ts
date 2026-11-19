import { Parser } from "htmlparser2";

/**
 * Refuses absurdly nested or absurdly large HTML before the page is built into a tree.
 *
 * Why this exists: the HTML parser recurses once per nesting level, every per-element
 * ancestor walk in the checks costs more the deeper the page is, and the parser's own open-element
 * stack gets slower with depth. In Node we could kill a worker thread; a Cloudflare Worker has no
 * thread to kill, so the page must be turned away up front. Real pages nest a few dozen levels
 * (the deepest real page checked reached about 60), so the limits sit far above anything legitimate.
 *
 * How: the page is run through htmlparser2's own Parser with callbacks that only count, and the
 * run stops the moment a limit is passed. Counting with the real parser means the count matches
 * the real tree by construction. An earlier version imitated the parser with a hand-written scanner,
 * and six kinds of input made the two disagree (a short "<!-->" comment, "<script/>", foreign
 * content, stray "</br>" and "</p>" closers), each letting a quadratic page through. Because the run
 * aborts at depth 400, the parser's depth-sensitive cost can never get large either.
 */

/** Deepest nesting we are willing to analyze. */
export const MAX_NESTING_DEPTH = 400;

/**
 * Most elements we will analyze. Real pages have a few thousand (a very long article can
 * reach about 50,000); a 2 MB page of bare tags can have half a million, which the parser
 * would turn into hundreds of megabytes of objects.
 */
export const MAX_ELEMENTS = 150_000;

/**
 * Most tree nodes of any kind: elements, text, comments, <!...> and <?...> declarations and CDATA
 * sections. Each becomes an object in the tree, and memory follows the node count, not the element
 * count: 2 MB of "<!a>" built 524,000 nodes (74 MB), and once those were capped, putting a text
 * node after each one still doubled the tree (78 MB for a 1.5 MB page). 250,000 nodes is about
 * 60 MB of tree at worst. A long real article has well under 100,000 nodes in all.
 */
export const MAX_NODES = 250_000;

export class TooManyElementsError extends Error {
  constructor() {
    super("This page has too many elements to analyze, so it was not scanned.");
    this.name = "TooManyElementsError";
  }
}

export class TooDeeplyNestedError extends Error {
  constructor() {
    super("This page is nested too deeply to analyze, so it was not scanned.");
    this.name = "TooDeeplyNestedError";
  }
}

/**
 * Parses `html` with counting callbacks only (no tree is built) and returns the deepest nesting and
 * the element count. Throws TooDeeplyNestedError or TooManyElementsError as soon as a limit is passed,
 * so the work done is bounded by the limits, not by how hostile the page is.
 *
 * The options are the ones cheerio/slim uses for HTML (htmlparser2 defaults), so this sees the
 * same elements the later parse will build.
 */
export function measureStructure(html: string): { depth: number; elements: number; nodes: number } {
  let depth = 0;
  let maxDepth = 0;
  let elements = 0;
  let others = 0;
  // Mirrors how domhandler (the tree builder cheerio uses) merges callbacks into nodes: the parser
  // can report one run of text, or one comment, in several pieces, and they become a single node
  // unless something else came in between. A differential test checks the count against the tree.
  let last: "text" | "comment" | null = null;
  const countNodes = (count: number): void => {
    others += count;
    if (elements + others > MAX_NODES) throw new TooManyElementsError();
  };
  const parser = new Parser({
    ontext() {
      if (last !== "text") countNodes(1);
      last = "text";
    },
    oncomment() {
      if (last !== "comment") countNodes(1);
      last = "comment";
    },
    oncommentend() {
      last = null;
    },
    oncdatastart() {
      // A CDATA section is two nodes: the section and the text node inside it, which later text joins.
      countNodes(2);
      last = "text";
    },
    oncdataend() {
      last = null;
    },
    onprocessinginstruction() {
      countNodes(1);
      last = null;
    },
    onopentag() {
      last = null;
      elements++;
      depth++;
      if (depth > maxDepth) maxDepth = depth;
      // Checked here, inside the callback, so the parser stops right away instead of finishing the page.
      if (depth > MAX_NESTING_DEPTH) throw new TooDeeplyNestedError();
      if (elements > MAX_ELEMENTS || elements + others > MAX_NODES) throw new TooManyElementsError();
    },
    onclosetag() {
      last = null;
      // The parser calls this for every element it opens, including void and self-closed ones
      // and elements it closes by itself at the end of the input, so the count always balances.
      depth--;
    },
  });
  parser.write(html);
  parser.end();
  return { depth: maxDepth, elements, nodes: elements + others };
}

/** Throws when the page is deeper than MAX_NESTING_DEPTH, has more than MAX_ELEMENTS elements or more than MAX_NODES nodes. */
export function assertNotTooDeep(html: string): void {
  measureStructure(html);
}
