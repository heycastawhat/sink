import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const PAGE_TEXT_CHARS = 8000;

/** Pages fetched for the user only: no LAN, loopback or link-local hosts, so a URL can't reach thonk's neighbours. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("only http(s) pages");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  for (const a of addresses) {
    if (
      /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(a) ||
      /^(::1?$|f[cd]|fe80|::ffff:(127|10|192\.168)\.)/i.test(a)
    ) {
      throw new Error("not a public address");
    }
  }
  return url;
}

export type FetchPublicOptions = {
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  checkUrl?: (url: string) => Promise<URL>;
};

/** GET that follows redirects by hand so every hop gets the public-address check. */
export async function fetchPublic(raw: string, opts: FetchPublicOptions = {}): Promise<Response> {
  const { fetchImpl = fetch, checkUrl = assertPublicUrl, headers } = opts;
  let url = await checkUrl(raw);
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(20_000), headers });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = await checkUrl(new URL(res.headers.get("location")!, url).toString());
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}

const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));

/** Title, description and readable text of a web page, for saving a bare link. */
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

/** Reads a public page as text; null when it isn't HTML. */
export async function readPage(raw: string, opts: FetchPublicOptions = {}): Promise<string | null> {
  const res = await fetchPublic(raw, {
    ...opts,
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; Sink/1.0; +self-hosted)",
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-NZ,en;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`page returned HTTP ${res.status}`);
  if (!/html/i.test(res.headers.get("content-type") ?? "text/html")) return null;
  if (Number(res.headers.get("content-length") ?? 0) > MAX_PAGE_BYTES) throw new Error("page too large");
  return pageText((await res.text()).slice(0, MAX_PAGE_BYTES)) || null;
}
