import type { Database } from "bun:sqlite";
import { generateKeyPairSync, type webcrypto } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { requireFullScope, type AuthEnv } from "./auth";
import { now } from "./db";

/**
 * Todo reminders for browsers, over Web Push (RFC 8030), encrypted per RFC 8291 and signed with VAPID (RFC 8292).
 * The Android app schedules its own alarms; this is only for browsers that turn reminders on in Settings.
 */

export type Vapid = { publicKey: string; privateJwk: webcrypto.JsonWebKey };
export type Subscription = { endpoint: string; p256dh: string; auth: string };
/** Delivers one push; resolves to the push service's HTTP status. */
export type Send = (sub: Subscription, payload: string) => Promise<number>;

const b64u = (b: ArrayBuffer | Uint8Array) => Buffer.from(b as ArrayBuffer).toString("base64url");
const unb64u = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const utf8 = (s: string) => new TextEncoder().encode(s);
type Bytes = Uint8Array<ArrayBuffer>;

/** The server's VAPID key pair, made on first use and kept in the (main) database. */
export function vapidKeys(db: Database): Vapid {
  const get = () => db.query<{ public_key: string; private_jwk: string }, []>("SELECT public_key, private_jwk FROM vapid").get();
  if (!get()) {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pub = publicKey.export({ format: "jwk" });
    const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x!, "base64url"), Buffer.from(pub.y!, "base64url")]);
    db.query("INSERT OR IGNORE INTO vapid (id, public_key, private_jwk) VALUES (1, ?, ?)").run(b64u(raw), JSON.stringify(privateKey.export({ format: "jwk" })));
  }
  const row = get()!;
  return { publicKey: row.public_key, privateJwk: JSON.parse(row.private_jwk) };
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, bits: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bits));
}

/** An aes128gcm body for one subscription. `local` and `salt` are only passed by tests (RFC 8291's example). */
export async function encrypt(payload: string, sub: Subscription, local?: CryptoKeyPair, salt: Bytes = crypto.getRandomValues(new Uint8Array(16))) {
  const ecdh = { name: "ECDH", namedCurve: "P-256" };
  local ??= (await crypto.subtle.generateKey(ecdh, true, ["deriveBits"])) as CryptoKeyPair;
  const uaPublic = unb64u(sub.p256dh);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, ecdh, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(unb64u(sub.auth), shared, Buffer.concat([utf8("WebPush: info\0"), uaPublic, asPublic]), 256);
  const cek = await crypto.subtle.importKey("raw", await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 128), "AES-GCM", false, ["encrypt"]);
  const iv = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 96);
  // One record: the payload then the last-record delimiter (2), no padding.
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cek, Buffer.concat([utf8(payload), Buffer.from([2])]));
  const header = Buffer.alloc(21);
  header.set(salt);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, new Uint8Array(sealed)]);
}

async function vapidHeader(endpoint: string, vapid: Vapid, contact: string) {
  const part = (o: object) => b64u(utf8(JSON.stringify(o)));
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: contact };
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part(claims)}`;
  const key = await crypto.subtle.importKey("jwk", vapid.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(unsigned));
  return `vapid t=${unsigned}.${b64u(sig)}, k=${vapid.publicKey}`;
}

/** The real sender. `contact` (an https URL or mailto:) is who push services can reach about this server. */
export const webPush =
  (vapid: Vapid, contact: string): Send =>
  async (sub, payload) => {
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        authorization: await vapidHeader(sub.endpoint, vapid, contact),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: "3600",
        urgency: "high",
      },
      body: await encrypt(payload, sub),
    });
    return res.status;
  };

const key = z.string().regex(/^[\w-]+=*$/);
const subscribeBody = z.object({
  endpoint: z.string().max(2048).url().startsWith("https://"),
  keys: z.object({
    p256dh: key.refine((k) => unb64u(k).length === 65),
    auth: key.refine((k) => unb64u(k).length === 16),
  }),
});
const unsubscribeBody = z.object({ endpoint: z.string().max(2048) });

/** This account's browsers: the key to subscribe with, subscribe, unsubscribe. Not for assistants' tokens. */
export function pushRoutes(db: Database, publicKey: string) {
  const app = new Hono<AuthEnv>();
  app.use("/push/*", requireFullScope);
  app.get("/push/key", (c) => c.json({ key: publicKey }));
  app.post("/push/subscribe", async (c) => {
    const body = subscribeBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid subscription" }, 400);
    const { endpoint, keys } = body.data;
    db.query(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
    ).run(endpoint, keys.p256dh, keys.auth, now());
    return c.json({ ok: true });
  });
  app.post("/push/unsubscribe", async (c) => {
    const body = unsubscribeBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    db.query("DELETE FROM push_subscriptions WHERE endpoint = ?").run(body.data.endpoint);
    return c.json({ ok: true });
  });
  return app;
}

// Reminders are looked for this far back, so one isn't lost to a restart or to a rescan that finds it a little late,
// without a burst of old ones when the server's been down for a day.
const LOOKBACK_MS = 15 * 60 * 1000;

/**
 * Sends every open todo's reminder that has come due since the last look, once each. A todo is known by its note,
 * text and reminder time, so moving its line doesn't resend it, and re-dating it reminds again at the new time.
 * A browser only hears about reminders due after it subscribed.
 */
export async function sendReminders(dbs: Database[], send: Send, at = Date.now()) {
  for (const db of dbs) {
    db.query("DELETE FROM push_sent WHERE remind_at <= ?").run(at - LOOKBACK_MS);
    const subs = db.query<Subscription & { created_at: number }, []>("SELECT * FROM push_subscriptions").all();
    if (!subs.length) continue;
    const due = db
      .query<{ path: string; line: number; text: string; remind_at: number; note_title: string }, [number, number]>(
        `SELECT t.path, t.line, t.text, t.remind_at, n.title AS note_title FROM todos t JOIN notes n ON n.path = t.path
         WHERE t.status = 'open' AND t.remind_at > ? AND t.remind_at <= ? ORDER BY t.remind_at`,
      )
      .all(at - LOOKBACK_MS, at);
    const gone = new Set<string>();
    for (const t of due) {
      const tag = `${t.path}\n${t.text}\n${t.remind_at}`;
      if (!db.query("INSERT OR IGNORE INTO push_sent (key, remind_at) VALUES (?, ?)").run(tag, t.remind_at).changes) continue;
      const payload = JSON.stringify({ title: t.text || "Todo", body: t.note_title, path: t.path, line: t.line, tag });
      for (const sub of subs) {
        if (sub.created_at >= t.remind_at || gone.has(sub.endpoint)) continue;
        const status = await send(sub, payload).catch((err) => {
          console.warn(`[push] ${new URL(sub.endpoint).host}: ${err.message}`);
          return 0;
        });
        // The browser unsubscribed or the subscription expired.
        if (status === 404 || status === 410) {
          gone.add(sub.endpoint);
          db.query("DELETE FROM push_subscriptions WHERE endpoint = ?").run(sub.endpoint);
        } else if (status >= 400) console.warn(`[push] ${new URL(sub.endpoint).host} answered ${status}`);
      }
    }
  }
}
