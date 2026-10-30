import type { Context } from "hono";

/**
 * A per-client cap on how often something can be done: at most `max` times per `windowMs` for each key (usually the
 * caller's IP). For endpoints anyone can call without signing in, so one client can't use them up for everyone.
 */
export function rateLimit(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (key: string, at = Date.now()): boolean => {
    const recent = (hits.get(key) ?? []).filter((t) => at - t < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(at);
    hits.delete(key);
    hits.set(key, recent);
    // Forget the least recently seen clients rather than grow without end.
    while (hits.size > 10_000) hits.delete(hits.keys().next().value!);
    return true;
  };
}

/** The caller's IP: Cloudflare's header when behind its tunnel, else the first forwarded hop, else one shared key. */
export function clientIp(c: Context): string {
  return c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "direct";
}
