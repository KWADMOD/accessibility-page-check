import * as cheerio from "cheerio/slim";
import { loadPage, makeSubtreeSearch, surveyTree, type DomNode } from "./domWalk.js";
import { excerptOf } from "./snippet.js";
import { assertNotTooDeep } from "./nestingGuard.js";
import type { Finding, ScanResult, Severity } from "./targets/types.js";

// Pure HTML-in, findings-out checks. No network access here so they are easy to
// unit test. These cover a small, well-understood subset of WCAG 2.1 A/AA; an
// automated check cannot prove a page is accessible, only flag likely failures.

const SNIPPET_MAX = 160;

function snippetOf(el: Parameters<cheerio.CheerioAPI>[0]): string {
  return excerptOf(el as unknown as DomNode, SNIPPET_MAX);
}

// A BCP 47 language tag in its common shapes: a 2-3 letter language, then optional subtags
// (en, en-US, zh-Hant-TW, es-419). Catches lang="english" and lang="en_US", which screen readers ignore.
const VALID_LANG = /^[a-z]{2,3}(-[a-z0-9]{1,8})*$/i;

/**
 * The level a screen reader announces, or null when the element is not a heading. An <hN> keeps its
 * level unless aria-level says otherwise; role="heading" without aria-level is level 2 (the ARIA
 * default); an <hN> given any other role, including none/presentation, is not a heading.
 */
function headingLevel(tagName: string, role: string | undefined, ariaLevel: string | undefined): number | null {
  const roles = (role ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const nativeLevel = /^h[1-6]$/i.test(tagName) ? Number(tagName.slice(1)) : null;
  // The first role is the one used (later ones are fallbacks).
  if (roles.length > 0 && roles[0] !== "heading") return null;
  const level = Number((ariaLevel ?? "").trim());
  if ((ariaLevel ?? "").trim() !== "" && Number.isInteger(level) && level >= 1) return level;
  return nativeLevel ?? 2;
}

/**
 * Whether a viewport content value stops pinch-zoom. Browsers read user-scalable as a number:
 * "yes" is 1, "device-width"/"device-height" are 10, any other word ("no", "false") is 0, and a
 * value between -1 and 1 disables zoom. A maximum-scale below 2 caps zoom under the 200% in 1.4.4.
 */
function blocksZoom(content: string): boolean {
  for (const part of content.toLowerCase().split(/[,;]/)) {
    const [rawKey, rawValue = ""] = part.split("=");
    const key = rawKey.trim();
    const value = rawValue.trim();
    if (key === "user-scalable") {
      const named: Record<string, number> = { yes: 1, "device-width": 10, "device-height": 10 };
      const asNumber = value === "" ? Number.NaN : Number(value);
      const scalable = named[value] ?? (Number.isNaN(asNumber) ? 0 : asNumber);
      if (scalable > -1 && scalable < 1) return true;
    }
    if (key === "maximum-scale" && value !== "" && Number(value) < 2) return true;
  }
  return false;
}

export function runChecks(html: string): Finding[] {
  return checkTree(loadPage(html));
}

function checkTree($: cheerio.CheerioAPI): Finding[] {
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);
  // Measures the real tree first and refuses one that is too deep or too big, so the
  // checks below never run on a page that would make them slow.
  const tree = surveyTree($.root()[0] as unknown as DomNode);

  // 3.1.1: screen readers pick the pronunciation language from <html lang>. A value that is not a
  // language code (lang="english", lang="en_US") is ignored by them just like a missing one, so it is
  // flagged too, as axe does. The value itself is page text, so it is not repeated in the message.
  const lang = ($("html").attr("lang") ?? "").trim();
  if (!lang) {
    add({ ruleId: "html-lang", severity: "serious", wcag: "3.1.1", message: "The <html> element has no lang attribute." });
  } else if (!VALID_LANG.test(lang)) {
    add({ ruleId: "html-lang", severity: "serious", wcag: "3.1.1", message: "The <html> lang attribute is not a valid language code (for example en or en-US)." });
  }

  // 2.4.2: the title is the first thing a screen reader announces.
  // htmlparser2 (cheerio/slim) does not build an implied <head>, so match a title in the head or
  // directly under <html>/the root, and skip <svg><title> and anything inside <body>.
  // Found in surveyTree's single pass; a selector here walked every title's ancestors (seconds on a deep page).
  if (!(tree.pageTitle ? $(tree.pageTitle as never).text() : "").trim()) {
    add({ ruleId: "page-title", severity: "serious", wcag: "2.4.2", message: "The page has no title, or the title is empty." });
  }

  // Which elements can be skipped without hiding a real problem:
  //  - Not rendered at all ([hidden], or a <dialog> that is not open): nobody
  //    reaches it, so a missing name there is not a problem (wikipedia.org has a
  //    closed dialog with an unnamed button).
  //  - Images inside aria-hidden="true": the author marked them as decorative.
  //  - Links, buttons and fields inside aria-hidden="true" ONLY when they are also
  //    out of the tab order with tabindex="-1". Sites do exactly this for duplicate
  //    links (apple.com and react.dev have dozens). Without tabindex="-1" a
  //    keyboard user can still land on the element while screen readers skip it,
  //    which is a real failure we must not hide.
  // Answered from one top-down pass (see domWalk.ts) instead of a selector per element:
  // walking the ancestors of every element made a deep page cost seconds.
  type El = Parameters<cheerio.CheerioAPI>[0];
  const nodeOf = (el: El): DomNode => el as unknown as DomNode;
  const notRendered = (el: El): boolean => tree.notRendered.has(nodeOf(el));
  const insideAriaHidden = (el: El): boolean => tree.ariaHidden.has(nodeOf(el));
  const hiddenFromAssistiveTech = (el: El): boolean => notRendered(el) || insideAriaHidden(el);
  const unreachable = (el: El): boolean =>
    notRendered(el) || (insideAriaHidden(el) && ($(el).attr("tabindex") ?? "").trim() === "-1");

  // Text a person or screen reader would actually get from an element. A plain .text()
  // also returns script and style contents and text inside hidden children, which made
  // `<a><script>x</script></a>` look named. Each question is a memoized subtree search
  // (see makeSubtreeSearch) so nested links and wide containers stay linear.
  const NON_TEXT_TAGS = new Set(["script", "style", "template", "noscript"]);
  const FORM_CONTROL_TAGS = new Set(["input", "select", "textarea", "button"]);
  const isTextNode = (node: DomNode): boolean => node.type === "text" && (node.data ?? "").trim().length > 0;
  // Hidden ([hidden], aria-hidden, inline display:none) children and non-text elements name nothing.
  const visibleTextBelow = makeSubtreeSearch((node) => {
    if (isTextNode(node)) return "found";
    return NON_TEXT_TAGS.has(node.name ?? "") || tree.selfHidden.has(node) ? "skip" : "continue";
  });
  // Same, but form controls are ignored too: reading a <label> that wraps a field must not count the field.
  const visibleTextBelowControls = makeSubtreeSearch((node) => {
    if (isTextNode(node)) return "found";
    const name = node.name ?? "";
    return NON_TEXT_TAGS.has(name) || tree.selfHidden.has(node) || FORM_CONTROL_TAGS.has(name) ? "skip" : "continue";
  });
  const hasVisibleText = (el: El, skipControls = false): boolean =>
    (skipControls ? visibleTextBelowControls : visibleTextBelow)(nodeOf(el));
  // A target's text for aria-labelledby: hidden children still count (a hidden target is a normal way to build names).
  const targetTextBelow = makeSubtreeSearch((node) =>
    isTextNode(node) ? "found" : NON_TEXT_TAGS.has(node.name ?? "") ? "skip" : "continue",
  );
  // Only images a person or screen reader can reach count: an alt on an image inside a
  // hidden or aria-hidden child names nothing. `el` itself being hidden is the callers' business.
  const imageAltBelow = makeSubtreeSearch((node) => {
    if (tree.selfHidden.has(node)) return "skip";
    return node.name === "img" && (node.attribs?.alt ?? "").trim().length > 0 ? "found" : "continue";
  });
  const hasImageAlt = (el: El): boolean => imageAltBelow(nodeOf(el));

  // aria-labelledby only names an element if an id it lists exists and has text
  // (hidden targets are allowed: that is a normal way to build names).
  const byId = new Map<string, El>();
  $("[id]").each((_, el) => {
    const id = $(el).attr("id") ?? "";
    if (id && !byId.has(id)) byId.set(id, el);
  });
  // Cached per id: many controls can point at one target, and re-cloning a big
  // target for each of them is the same quadratic trap as the label check below.
  const targetNamesCache = new Map<string, boolean>();
  const targetHasName = (id: string): boolean => {
    const cached = targetNamesCache.get(id);
    if (cached !== undefined) return cached;
    const target = byId.get(id);
    let named = false;
    if (target) {
      // Hidden children still count here: a hidden target is a normal way to build names.
      const hasText = targetTextBelow(nodeOf(target));
      // An inner <img alt="Close"> or the target's own title is a real name, the same
      // as it would be on the control itself.
      named =
        hasText ||
        !!($(target).attr("aria-label") ?? "").trim() ||
        !!($(target).attr("title") ?? "").trim() ||
        hasImageAlt(target) ||
        // The target can itself be the image: <img id="n" alt="Close">.
        ($(target).is("img") && ($(target).attr("alt") ?? "").trim().length > 0);
    }
    targetNamesCache.set(id, named);
    return named;
  };
  const labelledByResolves = (el: El): boolean =>
    ($(el).attr("aria-labelledby") ?? "").split(/\s+/).filter(Boolean).some(targetHasName);
  const hasOwnName = (el: El): boolean =>
    !!($(el).attr("aria-label") ?? "").trim() || labelledByResolves(el) || !!($(el).attr("title") ?? "").trim();

  // 1.1.1: alt may be empty (decorative) but must exist, unless another name is given:
  // aria-label, aria-labelledby and title are accepted by the criterion and by other scanners.
  $("img").each((_, el) => {
    // role="presentation"/"none" marks an image as decorative on purpose.
    const role = ($(el).attr("role") ?? "").toLowerCase();
    if ($(el).attr("alt") === undefined && role !== "presentation" && role !== "none" && !hasOwnName(el) && !hiddenFromAssistiveTech(el)) {
      add({ ruleId: "img-alt", severity: "critical", wcag: "1.1.1", message: "Image has no alt attribute.", snippet: snippetOf(el) });
    }
  });
  // An image button needs alt text for the same reason an image does. It reports
  // under img-alt (same criterion) so the rule count and wording stay unchanged.
  $('input[type="image"]').each((_, el) => {
    const named = ($(el).attr("alt") ?? "").trim().length > 0 || hasOwnName(el);
    if (!named && !unreachable(el)) {
      add({ ruleId: "img-alt", severity: "critical", wcag: "1.1.1", message: "Image button has no alt text.", snippet: snippetOf(el) });
    }
  });

  // Icon buttons often put the name on an inner element, e.g. <svg role="img" aria-label="Close">.
  // A hidden inner element names nothing: <a><i aria-hidden="true" title="Cart"></i></a> is the
  // unnamed icon link this rule exists to catch (axe flags it; the accessible-name algorithm skips
  // hidden nodes), so hidden children and everything under them are skipped.
  const namedElementBelow = makeSubtreeSearch((node) => {
    if (tree.selfHidden.has(node)) return "skip";
    const attribs = node.attribs;
    const mayBeNamed = !!attribs && ("aria-label" in attribs || "aria-labelledby" in attribs || "title" in attribs);
    return mayBeNamed && hasOwnName(node as unknown as El) ? "found" : "continue";
  });

  // 2.4.4 / 4.1.2: links and buttons need a name from text, ARIA or an inner image alt.
  const hasName = (el: El): boolean =>
    hasVisibleText(el) ||
    hasOwnName(el) ||
    hasImageAlt(el) ||
    namedElementBelow(nodeOf(el));

  $("a[href]").each((_, el) => {
    if (!hasName(el) && !unreachable(el)) {
      add({ ruleId: "link-name", severity: "serious", wcag: "2.4.4", message: "Link has no accessible name.", snippet: snippetOf(el) });
    }
  });
  // Also custom buttons (role="button" on a div or span). Links and real buttons are
  // excluded here because the selectors above already cover them.
  $('button, [role="button" i]:not(button, a[href], input)').each((_, el) => {
    if (!hasName(el) && !unreachable(el)) {
      add({ ruleId: "button-name", severity: "critical", wcag: "4.1.2", message: "Button has no accessible name.", snippet: snippetOf(el) });
    }
  });
  // <input type="button"> is named by its value (submit and reset have built-in names).
  $('input[type="button" i]').each((_, el) => {
    const named = ($(el).attr("value") ?? "").trim().length > 0 || hasOwnName(el);
    if (!named && !unreachable(el)) {
      add({ ruleId: "button-name", severity: "critical", wcag: "4.1.2", message: "Button has no accessible name.", snippet: snippetOf(el) });
    }
  });

  // 1.3.1 / 3.3.2: every form control needs a programmatic label.
  // Collected once: searching every label for every input is quadratic, and a
  // page with a few thousand fields froze the server for many seconds.
  // An empty label names nothing, so only labels with text (or an image alt) count.
  // Cached per label element: one <label> wrapping thousands of inputs is asked
  // about once per input, and recomputing its text each time took minutes
  // (2,000 unnamed inputs in one label took about 30 s).
  const labelTextCache = new Map<El, boolean>();
  const labelHasText = (label: El): boolean => {
    const cached = labelTextCache.get(label);
    if (cached !== undefined) return cached;
    // A title on the <label> itself is deliberately NOT counted: other scanners (axe,
    // WAVE) do not accept it, and a missed unlabeled field would be worse than a false alarm.
    const has = hasVisibleText(label, true) || hasImageAlt(label);
    labelTextCache.set(label, has);
    return has;
  };
  // A plain loop: cheerio's .map() copies its whole result for every item (quadratic on big pages).
  const labelledIds = new Set<string>();
  // The label an element sits inside, found by walking up the parent links. Not $(el).closest("label"):
  // that compiles and runs a selector at every ancestor, so 20,000 fields at depth 395 took 5.8 s.
  // The walk is at most as long as the page is deep, which the guard has capped.
  const nearestLabel = (el: El): El | null => {
    for (let node = nodeOf(el).parent; node; node = node.parent) {
      if (node.name === "label") return node as unknown as El;
    }
    return null;
  };
  $("label[for]").each((_, l) => {
    if (labelHasText(l)) labelledIds.add($(l).attr("for") ?? "");
  });
  $("input, select, textarea").each((_, el) => {
    const type = ($(el).attr("type") ?? "text").toLowerCase();
    if (["hidden", "submit", "button", "reset", "image"].includes(type) || unreachable(el)) return;
    const id = $(el).attr("id");
    const wrapper = nearestLabel(el);
    const labelled =
      hasOwnName(el) || (wrapper !== null && labelHasText(wrapper)) || (!!id && labelledIds.has(id));
    if (labelled) return;
    // Placeholder text does give a field an accessible name (axe and Lighthouse accept it), but it
    // vanishes as soon as someone types and is often too faint to read, so it is reported apart, at a
    // lower severity, instead of as "no label", which a site owner would rightly dispute.
    if (($(el).attr("placeholder") ?? "").trim()) {
      add({ ruleId: "placeholder-label", severity: "moderate", wcag: "3.3.2", message: "Form field is labelled only by its placeholder text.", snippet: snippetOf(el) });
    } else {
      add({ ruleId: "form-label", severity: "critical", wcag: "1.3.1", message: "Form control has no associated label.", snippet: snippetOf(el) });
    }
  });

  // 1.3.1: headings give screen-reader users a page outline; skipped levels break it.
  // Headings nobody can reach (hidden, closed dialog, aria-hidden) are not part of
  // the outline, so they must neither create a "skipped level" nor supply the h1.
  // Headings are read the way assistive technology reads them: role="heading" counts (page builders
  // emit it), aria-level overrides the tag's level, and an <h1>-<h6> given another role is not a heading.
  const headings: Array<{ el: El; level: number }> = [];
  $('h1, h2, h3, h4, h5, h6, [role="heading" i]').each((_, el) => {
    if (hiddenFromAssistiveTech(el)) return;
    const level = headingLevel(el.tagName, $(el).attr("role"), $(el).attr("aria-level"));
    if (level !== null) headings.push({ el, level });
  });
  const levels = headings.map((h) => h.level);
  if (levels.length > 0 && !levels.includes(1)) {
    add({ ruleId: "heading-h1", severity: "moderate", wcag: "1.3.1", message: "The page has headings but no h1." });
  }
  for (let i = 1; i < headings.length; i++) {
    if (levels[i] - levels[i - 1] > 1) {
      // The snippet says which heading jumped: a page can have several identical "h2 to h6" jumps.
      add({ ruleId: "heading-order", severity: "moderate", wcag: "1.3.1", message: `Heading level jumps from h${levels[i - 1]} to h${levels[i]}.`, snippet: snippetOf(headings[i].el) });
    }
  }

  // 1.4.4: blocking pinch-zoom locks out low-vision users. Every viewport tag is read (a later one
  // can be the restrictive one) and the name is matched in any case, as browsers do.
  const viewportBlocksZoom = $("meta[name]")
    .toArray()
    .some((el) => ($(el).attr("name") ?? "").trim().toLowerCase() === "viewport" && blocksZoom($(el).attr("content") ?? ""));
  if (viewportBlocksZoom) {
    add({ ruleId: "meta-viewport-zoom", severity: "serious", wcag: "1.4.4", message: "The viewport meta tag blocks or limits zoom." });
  }

  return findings;
}

/**
 * Cautions about how much a scan of this HTML can be trusted. We read the raw
 * HTML only, so a page that builds itself with JavaScript (an empty shell plus
 * scripts) would otherwise come back "clean" and look like a pass.
 */
// Elements whose contents are not readable page text: scripts, styles, <noscript> fallbacks
// ("please enable JavaScript") and inert templates.
const NOT_PAGE_TEXT = new Set(["script", "style", "noscript", "template"]);
// Without a <body> (htmlparser2 does not invent one for fragments) the whole document is read, minus
// the <head> and <title>, which are not page text either.
const NOT_PAGE_TEXT_NO_BODY = new Set([...NOT_PAGE_TEXT, "title", "head"]);
const TEXT_LENGTH_CAP = 200;

/**
 * Length of the readable text under `roots` once runs of whitespace count as one space and the
 * ends are trimmed, stopping early at TEXT_LENGTH_CAP (callers only compare against 40 and 150).
 * A walk, not cheerio's remove(): removing thousands of sibling <style> elements one by one shifts
 * the parent's child list each time, which took 15 s for 100,000 of them.
 */
function readableTextLength(roots: DomNode[], skipped: Set<string>): number {
  let length = 0;
  let pendingSpace = false;
  const stack: DomNode[] = [];
  for (let i = roots.length - 1; i >= 0; i--) stack.push(roots[i]);
  while (stack.length > 0 && length < TEXT_LENGTH_CAP) {
    const node = stack.pop()!;
    if (node.type === "text") {
      for (const ch of node.data ?? "") {
        if (/\s/.test(ch)) {
          pendingSpace = length > 0;
        } else {
          if (pendingSpace) length++;
          pendingSpace = false;
          length++;
          if (length >= TEXT_LENGTH_CAP) break;
        }
      }
    } else if (node.name === undefined || !skipped.has(node.name)) {
      const kids = node.children ?? [];
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
  }
  return length;
}

function limitsOf($: cheerio.CheerioAPI): string[] {
  const scriptCount = $("script").length;
  // $("body") selects every <body>, as the old code did.
  const bodies = $("body").toArray() as unknown as DomNode[];
  const textLength = bodies.length > 0
    ? readableTextLength(bodies, NOT_PAGE_TEXT)
    : readableTextLength([$.root()[0] as unknown as DomNode], NOT_PAGE_TEXT_NO_BODY);
  const notes: string[] = [];
  if (textLength < 150 && scriptCount > 0) {
    notes.push(
      "This page has almost no text in its raw HTML but loads scripts, so it probably builds its content with JavaScript. This tool reads the raw HTML only, so these results may miss most of the real page and should not be read as a pass.",
    );
  } else if (textLength < 40) {
    notes.push("This page has almost no readable text, so there was very little to check.");
  }
  return notes;
}

export function detectLimits(html: string): string[] {
  return limitsOf(loadPage(html));
}

/**
 * Runs the checks and the limits check together and turns parser stack
 * overflows (absurdly nested HTML) into messages instead of a failed scan.
 * A limits failure only costs us the caveat, so it becomes a note; a checks
 * failure means there is no result, so it becomes a plain error.
 */
export function analyzePage(html: string): { findings: Finding[]; notes: string[] } {
  // Turn away hostile nesting once, before the page is built into a tree: the parser would overflow
  // the stack or burn memory, and a Worker has no thread to kill.
  assertNotTooDeep(html);
  // One tree for both questions. Neither reads the page by changing it, so they can share it.
  let $: cheerio.CheerioAPI;
  try {
    $ = loadPage(html);
  } catch (error) {
    if (error instanceof RangeError) throw new Error("This page's HTML is nested too deeply to check.");
    throw error;
  }
  let findings: Finding[];
  try {
    findings = checkTree($);
  } catch (error) {
    if (error instanceof RangeError) throw new Error("This page's HTML is nested too deeply to check.");
    throw error;
  }
  let notes: string[];
  try {
    notes = limitsOf($);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    notes = ["This page's HTML is nested very deeply, so it could not be assessed for script-built content. Treat a short list of problems with caution."];
  }
  return { findings, notes };
}

export function summarize(findings: Finding[]): ScanResult["summary"] {
  const summary: Record<Severity, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const f of findings) summary[f.severity] += 1;
  return { ...summary, total: findings.length };
}
