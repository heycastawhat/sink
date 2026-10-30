/** HTML to readable text, for HTML-only emails. */

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
