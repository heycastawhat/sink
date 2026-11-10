/** HTML to readable text (for HTML-only emails) and to markdown (for clipped pages). */

const PAGE_TEXT_CHARS = 8000;

const NAMED: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** HTML entities to text, in one pass so "&amp;lt;" stays "&lt;". Out-of-range code points are dropped, not thrown. */
const decode = (s: string) =>
  s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (all, dec: string, hex: string, name: string) => {
    if (name) return NAMED[name.toLowerCase()] ?? all;
    const n = dec ? Number(dec) : parseInt(hex, 16);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  });

/** Title, description and readable text of an HTML document. */
export function pageText(html: string): string {
  const meta = (name: string) =>
    html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, "i"))?.[1] ??
    html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, "i"))?.[1];
  const title = meta("og:title") ?? html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
  const description = meta("og:description") ?? meta("description");
  const main = html.match(/<(article|main)[\s>][\s\S]*?<\/\1>/i)?.[0] ?? html.match(/<body[\s>][\s\S]*<\/body>/i)?.[0] ?? html;
  const body = main
    .replace(/<(script|style|noscript|svg|nav|header|footer|form)[\s>][\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|br|tr|section)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const clean = (s: string) =>
    decode(s)
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n");
  return [title && `Title: ${clean(title)}`, description && `Description: ${clean(description)}`, clean(body)]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, PAGE_TEXT_CHARS);
}

type Dom = {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  previousSibling: Dom | null;
  nextSibling: Dom | null;
  textContent: string | null;
  childNodes: ArrayLike<Dom>;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): ArrayLike<Dom>;
};

const SKIPPED = new Set(["script", "style", "noscript", "svg", "iframe", "form", "button", "select", "textarea", "template"]);
const BLOCKS = new Set(["p", "div", "section", "article", "main", "figure", "figcaption", "header", "address", "details", "summary", "dl", "dt", "dd"]);

// A page's text is literal, so whatever Sink or Obsidian would read as markup in it is escaped: a stray `%%` would hide
// the rest of the note, `[ ]` would add a todo, `[[x]]` a link and `#word` a tag.
const literal = (t: string) =>
  t
    .replace(/[\\`*[\]]|(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, "\\$&")
    .replace(/%%/g, "%\\%")
    .replace(/(^|\s)#(?=[\p{L}\p{N}_])/gu, "$1\\#");
// The same for what a paragraph starts with: a heading, list item or quote marker.
const leading = (t: string) => t.replace(/^(#{1,6}|[-+>]|\d+[.)])(?=\s|$)/, (m) => m.replace(/[#\-+>.)]/, "\\$&"));
/** A run of backticks longer than any inside `code`, so the code can't close its own fence. */
const ticks = (code: string, min: number) => "`".repeat(Math.max(min, ...Array.from(code.matchAll(/`+/g), (m) => m[0].length + 1)));

const BREAKS = /^(p|div|section|article|main|figure|figcaption|h[1-6]|ul|ol|li|pre|table|blockquote|hr|br)$/i;

/** A parsed DOM subtree as markdown, with links and images made absolute against `base`. Only http(s) and mailto links survive. */
export function htmlToMarkdown(root: Dom, base: string): string {
  const absolute = (raw: string | null, schemes = /^(https?|mailto):$/) => {
    // No address isn't this page's address: `<a name="top">` is an anchor, `<img>` without src shows nothing.
    if (!raw?.trim()) return null;
    try {
      const u = new URL(raw.trim(), base);
      return schemes.test(u.protocol) ? u.href.replace(/\(/g, "%28").replace(/\)/g, "%29") : null;
    } catch {
      return null;
    }
  };
  const kids = (n: Dom): string => Array.from(n.childNodes, walk).join("");
  const wrap = (n: Dom, mark: string) => {
    const inner = kids(n);
    return inner.trim() ? inner.replace(/^(\s*)(.*?)(\s*)$/s, `$1${mark}$2${mark}$3`) : inner;
  };
  const cell = (n: Dom) => kids(n).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();

  function walk(n: Dom): string {
    if (n.nodeType === 3) {
      const t = (n.nodeValue ?? "").replace(/\s+/g, " ");
      // Spacing next to a block (or at the edge of a container) is layout, not content.
      return t === " " && [n.previousSibling, n.nextSibling].some((s) => !s || (s.nodeType === 1 && BREAKS.test(s.nodeName))) ? "" : literal(t);
    }
    if (n.nodeType !== 1) return "";
    const tag = n.nodeName.toLowerCase();
    if (SKIPPED.has(tag)) return "";
    if (/^h[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${kids(n).replace(/\s+/g, " ").trim()}\n\n`;
    if (tag === "p") return `\n\n${leading(kids(n).trim())}\n\n`;
    if (BLOCKS.has(tag)) return `\n\n${kids(n).trim()}\n\n`;
    switch (tag) {
      case "br":
        return "\n";
      case "hr":
        return "\n\n---\n\n";
      case "strong":
      case "b":
        return wrap(n, "**");
      case "em":
      case "i":
        return wrap(n, "*");
      case "code": {
        const code = (n.textContent ?? "").replace(/\n/g, " ");
        if (!code.trim()) return "";
        const fence = ticks(code, 1);
        const pad = /^`|`$/.test(code) ? " " : "";
        return `${fence}${pad}${code}${pad}${fence}`;
      }
      case "pre": {
        const code = (n.textContent ?? "").replace(/\n$/, "");
        const fence = ticks(code, 3);
        return `\n\n${fence}\n${code}\n${fence}\n\n`;
      }
      case "a": {
        const text = kids(n);
        const href = absolute(n.getAttribute("href"));
        return href && text.trim() ? text.replace(/^(\s*)(.*?)(\s*)$/s, `$1[$2](${href})$3`) : text;
      }
      case "img": {
        const src = absolute(n.getAttribute("src") ?? n.getAttribute("data-src"), /^https?:$/);
        return src ? `![${(n.getAttribute("alt") ?? "").replace(/[\[\]\n]/g, " ").trim()}](${src})` : "";
      }
      case "blockquote":
        return `\n\n${kids(n).trim().replace(/^/gm, "> ")}\n\n`;
      case "ul":
      case "ol": {
        // A list put straight inside a list (no <li> around it, as many pages do) belongs to the item before it.
        const items: string[] = [];
        for (const c of Array.from(n.childNodes)) {
          const name = c.nodeName.toLowerCase();
          if (name === "li") items.push(kids(c));
          else if ((name === "ul" || name === "ol") && items.length) items[items.length - 1] += `\n${walk(c).trim()}`;
        }
        const lines = items.map((item, i) => {
          const bullet = tag === "ol" ? `${i + 1}. ` : "- ";
          return bullet + item.trim().replace(/\n{2,}(?=(?:- |\d+\. ))/g, "\n").replace(/\n/g, "\n" + " ".repeat(bullet.length));
        });
        return `\n\n${lines.join("\n")}\n\n`;
      }
      case "table": {
        const rows = Array.from(n.querySelectorAll("tr"), (tr) => Array.from(tr.querySelectorAll("th,td"), cell));
        const width = Math.max(0, ...rows.map((r) => r.length));
        if (!width) return "";
        const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
        return `\n\n${[line(rows[0]!), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n")}\n\n`;
      }
      default:
        return kids(n);
    }
  }

  return walk(root).replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}
