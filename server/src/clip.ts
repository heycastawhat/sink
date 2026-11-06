import { Readability } from "@mozilla/readability";
import { lookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { parseHTML } from "linkedom";
import { htmlToMarkdown, pageText } from "./html";

/** A clip that can't be done, with the status the API answers with. The message is safe to show the caller. */
export class ClipError extends Error {
  constructor(
    public status: 400 | 413 | 415 | 422 | 502,
    message: string,
  ) {
    super(message);
  }
}

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15_000;

// Anything that isn't the public internet: this server sits inside someone's network, so a clip must not reach it.
const internal = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) internal.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 128], ["::1", 128], ["64:ff9b::", 96], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) {
  internal.addSubnet(net, bits, "ipv6");
}
// BlockList reads ::ffff:a.b.c.d as the IPv4 address, so mapped addresses are covered by the IPv4 rules.
const blocked = (address: string) => internal.check(address, address.includes(":") ? "ipv6" : "ipv4");
const notAllowed = () => new ClipError(400, "that address isn't allowed");

/** One GET with no cookies or credentials. `allowHost` is a test-only host exempt from the check. DNS answers are checked as the socket connects, so they can't change after the check. */
const get = (url: URL, allowHost: string | undefined, signal: AbortSignal) =>
  new Promise<http.IncomingMessage>((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const exempt = host === allowHost;
    if (!exempt && isIP(host) && blocked(host)) return reject(notAllowed());
    const req = (url.protocol === "https:" ? https : http).request(
      url,
      {
        signal,
        headers: { "user-agent": "Mozilla/5.0 (compatible; Sink web clipper)", accept: "text/html,application/xhtml+xml", "accept-encoding": "identity" },
        lookup: ((name: string, _opts: unknown, cb: Function) =>
          lookup(name, { all: true }, (err, addresses) => {
            if (err) return cb(err, []);
            if (!exempt && addresses.some((a) => blocked(a.address))) return cb(notAllowed(), []);
            cb(null, addresses);
          })) as any,
      },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });

/** The HTML at `input` and the URL it ended up at. Redirects are followed by hand so every hop is checked. */
export async function fetchPage(input: string, allowHost?: string): Promise<{ html: string; url: string }> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ClipError(400, "that isn't a valid URL");
  }
  try {
    for (let hops = 0; ; hops++) {
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new ClipError(400, "only http and https links can be clipped");
      const res = await get(url, allowHost, signal);
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.destroy();
        if (hops >= MAX_REDIRECTS) throw new ClipError(502, "too many redirects");
        url = new URL(location, url);
        continue;
      }
      const type = res.headers["content-type"] ?? "";
      if (status < 200 || status >= 300) throw new ClipError(502, `the page answered HTTP ${status}`);
      if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(type)) throw new ClipError(415, "that link isn't a web page");
      if (Number(res.headers["content-length"] ?? 0) > MAX_BYTES) throw new ClipError(413, "that page is too large");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of res) {
        size += chunk.length;
        if (size > MAX_BYTES) throw new ClipError(413, "that page is too large");
        chunks.push(chunk);
      }
      const charset = /charset=["']?([\w-]+)/i.exec(type)?.[1];
      const decoder = (() => {
        try {
          return new TextDecoder(charset as "utf-8");
        } catch {
          return new TextDecoder();
        }
      })();
      return { html: decoder.decode(Buffer.concat(chunks)), url: url.href };
    }
  } catch (err) {
    if (err instanceof ClipError) throw err;
    // Not the underlying error: its message would tell the caller which internal hosts and ports answer.
    throw new ClipError(502, signal.aborted ? "the page took too long to load" : "couldn't fetch that page");
  }
}

/** The page's main article as a title and markdown. Falls back to the page's plain text when nothing looks like an article. */
export function extractArticle(html: string, url: string): { title: string; markdown: string } {
  const { document } = parseHTML(html);
  const pageTitle = document.title?.trim();
  const article = new Readability(document as any).parse();
  const title = (article?.title || pageTitle || new URL(url).hostname).replace(/\s+/g, " ").trim();
  let markdown = article?.content
    ? htmlToMarkdown(parseHTML(`<html><body>${article.content}</body></html>`).document.body as any, url)
    : pageText(html).replace(/^Title: .*\n*/, "");
  // Readability usually drops the page's own h1; when it kept one, the note's title line replaces it.
  const first = markdown.match(/^# (.*)\n*/);
  if (first && first[1]!.trim().toLowerCase() === title.toLowerCase()) markdown = markdown.slice(first[0].length);
  return { title, markdown };
}
