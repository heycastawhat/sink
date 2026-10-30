import type { Database } from "bun:sqlite";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { Hono } from "hono";
import { z } from "zod";
import { newId, now } from "./db";
import type { Oidc } from "./oidc";
import { clientIp, rateLimit } from "./ratelimit";

export const SESSION_COOKIE = "sink_session";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

// Pending logins: OIDC round-trips (state) and Android hand-back codes both expire quickly.
const PENDING_TTL_MS = 10 * 60 * 1000;
const HANDBACK_TTL_MS = 2 * 60 * 1000;
const MAX_PENDING = 500;
export const ANDROID_REDIRECT = "nz.joshp.sink://auth";

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function randomString(bytes = 32): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

export function s256(verifier: string): string {
  return new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");
}

export class Auth {
  constructor(private db: Database) {}

  /** A new token; with `ttlMs` it stops working after that long (OAuth access tokens), else it lasts until revoked. */
  issueToken(deviceName: string, subject: string, scope: Scope = "full", ttlMs?: number): string {
    const token = "sink_" + randomString();
    this.db
      .query("INSERT INTO tokens (id, name, token_hash, created_at, subject, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(newId(), deviceName, sha256(token), now(), subject, scope, ttlMs ? now() + ttlMs : null);
    return token;
  }

  /** The token's id and scope, or null if it isn't one of ours. */
  check(token: string): { id: string; scope: Scope } | null {
    const row = this.db
      .query<{ id: string; scope: Scope }, [string, number]>(
        "SELECT id, scope FROM tokens WHERE token_hash = ? AND (expires_at IS NULL OR expires_at > ?)",
      )
      .get(sha256(token), now());
    if (!row) return null;
    this.db.query("UPDATE tokens SET last_used_at = ? WHERE id = ?").run(now(), row.id);
    return row;
  }

  verify(token: string): string | null {
    return this.check(token)?.id ?? null;
  }

  subjectOf(tokenId: string): string | null {
    return this.db.query<{ subject: string | null }, [string]>("SELECT subject FROM tokens WHERE id = ?").get(tokenId)?.subject ?? null;
  }

  revoke(tokenId: string) {
    this.db.query("DELETE FROM tokens WHERE id = ?").run(tokenId);
  }

  listTokens() {
    return this.db
      .query("SELECT id, name, subject, scope, created_at, last_used_at FROM tokens ORDER BY created_at DESC")
      .all();
  }
}

export type Scope = "full" | "mcp";
export type AuthEnv = { Variables: { tokenId: string; scope: Scope } };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Bearer token or the web session cookie. A cookie-carrying request that changes something must come from Sink's own
 * page: SameSite=Lax still lets sibling subdomains (same site, different origin) post as the user.
 */
export function requireAuth(auth: Auth, publicUrls: string[]): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const header = c.req.header("authorization");
    const bearer = header?.startsWith("Bearer ") ? header.slice(7) : null;
    const token = bearer ?? getCookie(c, SESSION_COOKIE);
    const found = token ? auth.check(token) : null;
    if (!found) return c.json({ error: "unauthorized" }, 401);
    if (!bearer && !SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header("origin");
      const sameOrigin = c.req.header("sec-fetch-site") === "same-origin";
      if (!sameOrigin && !(origin && publicUrls.includes(origin))) return c.json({ error: "cross-origin request refused" }, 403);
    }
    c.set("tokenId", found.id);
    c.set("scope", found.scope);
    await next();
  };
}

/** Routes an assistant (MCP) token may not use. */
export const requireFullScope: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (c.get("scope") !== "full") return c.json({ error: "not allowed with this token" }, 403);
  await next();
};

/** The origin the browser used, honouring the Cloudflare tunnel's forwarded headers. */
export function requestOrigin(c: Context): string {
  const url = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? url.host;
  return `${proto}://${host}`;
}

type Pending = {
  verifier: string;
  nonce: string;
  origin: string;
  client: "web" | "android";
  device: string;
  appChallenge?: string;
  // Web: same-origin path to land on after signing in (e.g. back to an OAuth consent page).
  next?: string;
  created: number;
};

type Handback = { challenge: string; device: string; subject: string; created: number };

const startQuery = z.object({
  client: z.enum(["web", "android"]).default("web"),
  device: z.string().max(100).optional(),
  // Android: S256 of a verifier only the app holds, so an intercepted hand-back code is useless.
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
  // A local path only: "/x", never "//host" or "/\host", so it can't become an open redirect.
  next: z.string().max(2000).regex(/^\/(?![\/\\])/).optional(),
});

const exchangeBody = z.object({
  code: z.string().min(20).max(100),
  verifier: z.string().min(43).max(128),
});

export function authRoutes(auth: Auth, oidc: Oidc, opts: { secureCookies: boolean; publicUrls: string[] }) {
  const app = new Hono<AuthEnv>();
  const pending = new Map<string, Pending>();
  const handbacks = new Map<string, Handback>();

  const sweep = () => {
    const t = now();
    for (const [k, v] of pending) if (t - v.created > PENDING_TTL_MS) pending.delete(k);
    for (const [k, v] of handbacks) if (t - v.created > HANDBACK_TTL_MS) handbacks.delete(k);
    // Anyone can start a login; a flood of them drops the oldest instead of growing without end.
    for (const map of [pending, handbacks] as Map<string, unknown>[]) {
      while (map.size > MAX_PENDING) map.delete(map.keys().next().value!);
    }
  };
  const authed = requireAuth(auth, opts.publicUrls);

  // Only redirect back to origins we were told about, never to an arbitrary Host header.
  const allowedOrigin = (c: Context) => {
    const origin = requestOrigin(c);
    return opts.publicUrls.includes(origin) ? origin : opts.publicUrls[0]!;
  };

  // Anyone can start a login; a cap per caller keeps one client from crowding out real sign-ins.
  const logins = rateLimit(30, 10 * 60_000);

  app.get("/oidc/start", async (c) => {
    if (!logins(clientIp(c))) return c.text("Too many sign-in attempts. Try again in a few minutes.", 429);
    sweep();
    const q = startQuery.safeParse(c.req.query());
    if (!q.success) return c.json({ error: "invalid query" }, 400);
    if (q.data.client === "android" && !q.data.challenge) return c.json({ error: "missing challenge" }, 400);

    const state = randomString();
    const entry: Pending = {
      verifier: randomString(48),
      nonce: randomString(),
      origin: allowedOrigin(c),
      client: q.data.client,
      device: q.data.device ?? (q.data.client === "android" ? "Android" : "Web"),
      appChallenge: q.data.challenge,
      next: q.data.next,
      created: now(),
    };
    pending.set(state, entry);
    const url = await oidc.authorizeUrl({
      redirectUri: `${entry.origin}/api/auth/oidc/callback`,
      state,
      nonce: entry.nonce,
      challenge: s256(entry.verifier),
    });
    return c.redirect(url, 302);
  });

  app.get("/oidc/callback", async (c) => {
    const state = c.req.query("state") ?? "";
    const entry = pending.get(state);
    pending.delete(state);
    const fail = (msg: string, status: 400 | 403 | 502 = 400) =>
      c.html(`<!doctype html><meta name=viewport content="width=device-width"><title>Sink</title>
<body style="font-family:system-ui;padding:32px"><h2>Couldn't sign in</h2><p>${msg}</p><p><a href="/">Back</a></p>`, status);

    if (!entry || now() - entry.created > PENDING_TTL_MS) return fail("That sign-in link expired. Try again.");
    const error = c.req.query("error");
    if (error) return fail(`The sign-in provider said: ${Bun.escapeHTML(c.req.query("error_description") ?? error)}`, 403);
    const code = c.req.query("code");
    if (!code) return fail("No code in the response.");

    let identity;
    try {
      identity = await oidc.exchange({
        code,
        redirectUri: `${entry.origin}/api/auth/oidc/callback`,
        verifier: entry.verifier,
        nonce: entry.nonce,
      });
    } catch (err) {
      console.warn(`[auth] oidc exchange failed: ${(err as Error).message}`);
      return fail("The sign-in provider didn't accept the login.", 502);
    }
    if (!oidc.allowed(identity)) {
      console.warn(`[auth] rejected ${identity.username ?? identity.sub}`);
      return fail("This account isn't allowed to use Sink.", 403);
    }

    if (entry.client === "android") {
      const handback = randomString();
      handbacks.set(handback, { challenge: entry.appChallenge!, device: entry.device, subject: identity.sub, created: now() });
      return c.redirect(`${ANDROID_REDIRECT}?code=${handback}`, 302);
    }

    const token = auth.issueToken(entry.device, identity.sub);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: opts.secureCookies || entry.origin.startsWith("https://"),
      // Lax so the cookie survives the redirect back from the sign-in provider.
      sameSite: "Lax",
      path: "/",
      maxAge: COOKIE_MAX_AGE,
    });
    return c.redirect(`${entry.origin}${entry.next ?? "/"}`, 302);
  });

  // Android swaps the one-time hand-back code (plus its PKCE verifier) for a device token.
  app.post("/oidc/exchange", async (c) => {
    sweep();
    const body = exchangeBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    const entry = handbacks.get(body.data.code);
    handbacks.delete(body.data.code);
    if (!entry || s256(body.data.verifier) !== entry.challenge) return c.json({ error: "invalid or expired code" }, 400);
    return c.json({ ok: true, token: auth.issueToken(entry.device, entry.subject) });
  });

  app.post("/logout", authed, (c) => {
    auth.revoke(c.get("tokenId"));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // Before sign-in: what the login button should say.
  app.get("/info", (c) => c.json({ provider: oidc.name }));

  app.get("/me", authed, (c) => c.json({ ok: true, tokenId: c.get("tokenId") }));

  app.get("/tokens", authed, requireFullScope, (c) => c.json({ tokens: auth.listTokens() }));

  // Named tokens for other clients (an MCP client like Claude Code); same account as the caller.
  // Tokens made here are for MCP clients like Claude Code, so they get the assistant scope.
  app.post("/tokens", authed, requireFullScope, async (c) => {
    const parsed = z.object({ name: z.string().trim().min(1).max(60) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);
    const subject = auth.subjectOf(c.get("tokenId")) ?? "";
    return c.json({ token: auth.issueToken(parsed.data.name, subject, "mcp") }, 201);
  });

  app.delete("/tokens/:id", authed, requireFullScope, (c) => {
    auth.revoke(c.req.param("id"));
    return c.json({ ok: true });
  });

  return app;
}
