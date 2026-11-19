import type { DomNode } from "./domWalk.js";

// Short HTML excerpts for findings.
//
// Why not cheerio's $.html(element): it writes the element's whole subtree, and the report
// keeps only the first 160 characters. A link wrapping half a megabyte of markup, or 400
// nested links around the same markup, made every finding serialize that markup again.
// Here writing stops once the budget is spent.

const VOID_TAGS = new Set([
  "area", "base", "basefont", "br", "col", "command", "embed", "frame", "hr", "img", "input",
  "isindex", "keygen", "link", "meta", "param", "source", "track", "wbr",
]);

const escapeText = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (value: string): string => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/**
 * A fresh copy of a short string. V8 represents `big.slice(a, b)` as a pointer into `big`, so a
 * 160-character excerpt cut from a 2 MB attribute kept the whole 2 MB (12 MB once escaped) alive
 * for as long as the finding lived; 14 nested links sharing one such attribute held about 170 MB
 * and would kill a 128 MB Worker isolate. Splitting and rejoining forces a new, independent string.
 */
const detach = (text: string): string => text.split("").join("");

/** The element's HTML, cut to about `max` characters with "..." when there was more. */
export function excerptOf(node: DomNode, max: number): string {
  const parts: string[] = [];
  let length = 0;
  let truncated = false;

  // Page text is cut to what the budget can still take BEFORE it is escaped or copied, so the
  // cost of an excerpt never depends on how long a text node or attribute value is. One extra
  // character is kept so the budget still overflows and the excerpt is marked as cut.
  const room = (text: string): string => text.slice(0, Math.max(0, max - length + 1));

  // Returns false once the budget is spent so callers stop writing.
  const write = (text: string): boolean => {
    parts.push(text);
    length += text.length;
    if (length > max) truncated = true;
    return !truncated;
  };

  const visit = (current: DomNode): boolean => {
    if (current.type === "text") {
      // Script and style bodies are raw text in HTML; everything else is escaped.
      const raw = current.parent?.name === "script" || current.parent?.name === "style";
      const data = room(current.data ?? "");
      return write(raw ? data : escapeText(data));
    }
    if (current.type === "comment") return write("<!--") && write(room(current.data ?? "")) && write("-->");
    if (current.type !== "tag" && current.type !== "script" && current.type !== "style") return true;

    const name = room(current.name ?? "");
    if (!write(`<${name}`)) return false;
    // Attributes are written one at a time so a page with thousands of them, or one huge value,
    // stops costing anything once the budget is spent.
    for (const [key, value] of Object.entries(current.attribs ?? {})) {
      if (!write(` ${room(key)}="`)) return false;
      if (!write(escapeAttribute(room(value)))) return false;
      if (!write(`"`)) return false;
    }
    if (!write(">")) return false;
    if (VOID_TAGS.has(name)) return true;
    for (const child of current.children ?? []) {
      if (!visit(child)) return false;
    }
    return write(`</${name}>`);
  };

  visit(node);
  const text = parts.join("");
  return detach(truncated ? `${text.slice(0, max)}...` : text);
}
