import type { Database } from "bun:sqlite";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { newId, now } from "./db";

const HOUR = 60 * 60 * 1000;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
// Ignore jitter: only a real drop (over 1%) is worth a notification.
const DROP_RATIO = 0.99;

export type Price = { price: number; currency: string | null };

export type PriceWatch = {
  capture_id: string;
  url: string;
  currency: string | null;
  first_price: number | null;
  last_price: number | null;
  lowest_price: number | null;
  last_checked_at: number | null;
  last_error: string | null;
  created_at: number;
};

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[^\d.]/g, "")) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** schema.org offers can be one offer, a list, or an AggregateOffer with lowPrice. */
function fromOffers(offers: unknown): Price | null {
  for (const o of [offers].flat()) {
    if (!o || typeof o !== "object") continue;
    const offer = o as Record<string, unknown>;
    const spec = offer.priceSpecification as Record<string, unknown> | undefined;
    const price = num(offer.price) ?? num(offer.lowPrice) ?? num(spec?.price);
    if (price) return { price, currency: (offer.priceCurrency ?? spec?.priceCurrency ?? null) as string | null };
  }
  return null;
}

function fromJsonLd(node: unknown): Price | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = fromJsonLd(n);
      if (hit) return hit;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  const types = [obj["@type"]].flat().map(String);
  if (types.some((t) => /Product|Offer/i.test(t))) {
    const hit = types.some((t) => /Offer/i.test(t)) ? fromOffers(obj) : fromOffers(obj.offers);
    if (hit) return hit;
  }
  return fromJsonLd(obj["@graph"]);
}

/** The page's own declared price: JSON-LD first, then product meta tags, then itemprop microdata. */
export function extractPrice(html: string): Price | null {
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const hit = fromJsonLd(JSON.parse(m[1]!.trim()));
      if (hit) return hit;
    } catch {
      /* broken JSON-LD is common; try the next block */
    }
  }
  const meta = (name: string) =>
    html.match(new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${name}["'][^>]+content=["']([^"']+)["']`, "i"))?.[1] ??
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name|itemprop)=["']${name}["']`, "i"))?.[1];
  const metaPrice = num(meta("product:price:amount") ?? meta("og:price:amount") ?? meta("price"));
  if (metaPrice) return { price: metaPrice, currency: meta("product:price:currency") ?? meta("og:price:currency") ?? meta("priceCurrency") ?? null };
  const micro = html.match(/itemprop=["']price["'][^>]*content=["']([^"']+)["']/i)?.[1];
  if (num(micro)) return { price: num(micro)!, currency: html.match(/itemprop=["']priceCurrency["'][^>]*content=["']([^"']+)["']/i)?.[1] ?? null };
  return null;
}

/** Shop pages only: no LAN, loopback or link-local hosts, so a URL in a screenshot can't reach thonk's neighbours. */
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

export class PriceWatcher {
  private timer: Timer | undefined;
  private busy = false;

  constructor(
    private db: Database,
    private intervalMs = 12 * HOUR,
    private fetchImpl: typeof fetch = fetch,
    private checkUrl: (url: string) => Promise<URL> = assertPublicUrl,
  ) {}

  // Polls often so a new watch gets its first check within a minute; the due query is cheap.
  start(pollMs = 60 * 1000) {
    this.timer = setInterval(() => void this.tick(), pollMs);
    void this.tick();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Checks a few watches that are due. Returns how many were checked. */
  async tick(at = now()): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      const due = this.db
        .query<PriceWatch & { title: string | null }, [number]>(
          `SELECT w.*, c.title FROM price_watches w JOIN captures c ON c.id = w.capture_id
           WHERE w.next_check_at <= ? AND c.deleted_at IS NULL ORDER BY w.next_check_at LIMIT 5`,
        )
        .all(at);
      for (const w of due) await this.check(w, at);
      return due.length;
    } finally {
      this.busy = false;
    }
  }

  private async check(w: PriceWatch & { title: string | null }, at: number) {
    // Spread checks out so watches made together don't all hit at once next time.
    const next = at + this.intervalMs + Math.floor(Math.random() * HOUR);
    try {
      const found = await this.fetchPrice(w.url);
      if (!found) throw new Error("no price found on the page");
      const currency = found.currency ?? w.currency;
      const dropped = w.last_price !== null && found.price < w.last_price * DROP_RATIO;
      this.db.transaction(() => {
        this.db.query("INSERT INTO price_points (capture_id, at, price) VALUES (?, ?, ?)").run(w.capture_id, at, found.price);
        this.db
          .query(
            `UPDATE price_watches SET currency = ?, first_price = COALESCE(first_price, ?), last_price = ?,
               lowest_price = MIN(COALESCE(lowest_price, ?), ?), last_checked_at = ?, next_check_at = ?, last_error = NULL
             WHERE capture_id = ?`,
          )
          .run(currency, found.price, found.price, found.price, found.price, at, next, w.capture_id);
        if (dropped) {
          const fmt = (p: number) => `${currency ? `${currency} ` : "$"}${p.toFixed(2)}`;
          this.db
            .query(
              `INSERT INTO actions (id, capture_id, type, label, payload, state, created_at)
               VALUES (?, ?, 'price_drop', ?, ?, 'suggested', ?)`,
            )
            .run(
              newId(),
              w.capture_id,
              `Price dropped to ${fmt(found.price)} (was ${fmt(w.last_price!)})`,
              JSON.stringify({ url: w.url, price: found.price, previous: w.last_price, currency }),
              at,
            );
        }
      })();
    } catch (err) {
      this.db
        .query("UPDATE price_watches SET last_checked_at = ?, next_check_at = ?, last_error = ? WHERE capture_id = ?")
        .run(at, next, (err as Error).message.slice(0, 200), w.capture_id);
    }
  }

  private async fetchPrice(raw: string): Promise<Price | null> {
    // Follow redirects by hand so every hop gets the public-address check.
    let url = await this.checkUrl(raw);
    for (let hop = 0; hop < 5; hop++) {
      const res = await this.fetchImpl(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; SinkPriceWatch/1.0; +self-hosted)",
          accept: "text/html,application/xhtml+xml",
          "accept-language": "en-NZ,en;q=0.8",
        },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        url = await this.checkUrl(new URL(res.headers.get("location")!, url).toString());
        continue;
      }
      if (!res.ok) throw new Error(`page returned HTTP ${res.status}`);
      const length = Number(res.headers.get("content-length") ?? 0);
      if (length > MAX_PAGE_BYTES) throw new Error("page too large");
      const html = (await res.text()).slice(0, MAX_PAGE_BYTES);
      return extractPrice(html);
    }
    throw new Error("too many redirects");
  }
}

/** The page to watch: where the assistant captured it, else the first link the AI found. */
export function watchUrl(row: { source_url?: unknown; entities: string }): string | null {
  if (typeof row.source_url === "string" && /^https?:\/\//.test(row.source_url)) return row.source_url;
  const urls = (JSON.parse(row.entities) as Record<string, string[]>).urls ?? [];
  return urls.find((u) => /^https?:\/\//.test(u)) ?? null;
}
