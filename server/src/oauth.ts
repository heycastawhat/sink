import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { Auth, SESSION_COOKIE, requestOrigin, s256, type AuthEnv } from "./auth";
import { now } from "./db";

/**
 * OAuth 2.1 authorization server for MCP connectors (claude.ai, ChatGPT, Poke, …): metadata discovery
 * (RFC 8414 / 9728), dynamic client registration (RFC 7591), code + PKCE S256, refresh tokens.
 * Signing in is the normal OIDC login; access tokens are ordinary Sink tokens, revocable from the web.
 */

const MAX_CLIENTS = 100;
const CODE_TTL_MS = 5 * 60 * 1000;
const CONSENT_TTL_MS = 10 * 60 * 1000;
const SCOPE = "sink";

type Client = { id: string; name: string; redirect_uris: string; secret_hash: string | null };
type Consent = { clientId: string; redirectUri: string; challenge: string; state?: string; created: number };
type Code = { clientId: string; redirectUri: string; challenge: string; subject: string; created: number };

const sha256 = (v: string) => new Bun.CryptoHasher("sha256").update(v).digest("hex");
const random = (bytes = 32) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
const esc = (s: string) => Bun.escapeHTML(s);

/** https anywhere, plain http only back to this machine (native apps, Claude Code). */
function redirectAllowed(uri: string) {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

const registerBody = z.object({
  redirect_uris: z.array(z.string().max(2000)).min(1).max(10),
  client_name: z.string().max(100).optional(),
  token_endpoint_auth_method: z.enum(["none", "client_secret_post", "client_secret_basic"]).optional(),
});

export function oauthRoutes(db: Database, auth: Auth, publicUrls: string[]) {
  const app = new Hono<AuthEnv>();
  const consents = new Map<string, Consent>();
  const codes = new Map<string, Code>();

  const sweep = () => {
    const t = now();
    for (const [k, v] of consents) if (t - v.created > CONSENT_TTL_MS) consents.delete(k);
    for (const [k, v] of codes) if (t - v.created > CODE_TTL_MS) codes.delete(k);
  };

  // Same rule as login: only origins Sink was told about, never an arbitrary Host header.
  const origin = (c: Context) => {
    const o = requestOrigin(c);
    return publicUrls.includes(o) ? o : publicUrls[0]!;
  };

  const getClient = (id: string) => db.query<Client, [string]>("SELECT * FROM oauth_clients WHERE id = ?").get(id);

  const tokenError = (c: Context, error: string, description: string, status: 400 | 401 = 400) =>
    c.json({ error, error_description: description }, status, { "cache-control": "no-store" });

  /** The signed-in browser's account, from the normal web session cookie. */
  const sessionSubject = (c: Context) => {
    const token = getCookie(c, SESSION_COOKIE);
    const tokenId = token ? auth.verify(token) : null;
    return tokenId ? auth.subjectOf(tokenId) : null;
  };

  app.get("/.well-known/oauth-authorization-server", (c) => {
    const o = origin(c);
    return c.json({
      issuer: o,
      authorization_endpoint: `${o}/oauth/authorize`,
      token_endpoint: `${o}/oauth/token`,
      registration_endpoint: `${o}/oauth/register`,
      revocation_endpoint: `${o}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: [SCOPE],
    });
  });

  // Served at the bare path and the /mcp-suffixed one; clients try either.
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    app.get(path, (c) => {
      const o = origin(c);
      return c.json({ resource: `${o}/mcp`, authorization_servers: [o], bearer_methods_supported: ["header"], scopes_supported: [SCOPE] });
    });
  }

  app.post("/oauth/register", async (c) => {
    // Registration is open by design (MCP clients self-register), so keep it from piling up: clients that never got
    // a token go after a day, and there's a ceiling.
    db.query("DELETE FROM oauth_clients WHERE created_at < ? AND id NOT IN (SELECT client_id FROM oauth_refresh)").run(now() - 86_400_000);
    if (db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM oauth_clients").get()!.n >= MAX_CLIENTS) {
      return c.json({ error: "temporarily_unavailable", error_description: "too many registered clients" }, 429);
    }
    const parsed = registerBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return tokenError(c, "invalid_client_metadata", "expected redirect_uris");
    const b = parsed.data;
    const bad = b.redirect_uris.find((u) => !redirectAllowed(u));
    if (bad) return tokenError(c, "invalid_redirect_uri", `not allowed: ${bad}`);

    const id = `mcp_${random(16)}`;
    const method = b.token_endpoint_auth_method ?? "none";
    const secret = method === "none" ? null : random();
    db.query("INSERT INTO oauth_clients (id, name, redirect_uris, secret_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(
      id,
      b.client_name?.trim() || "MCP client",
      JSON.stringify(b.redirect_uris),
      secret ? sha256(secret) : null,
      now(),
    );
    return c.json(
      {
        client_id: id,
        ...(secret && { client_secret: secret, client_secret_expires_at: 0 }),
        client_id_issued_at: Math.floor(now() / 1000),
        client_name: b.client_name ?? "MCP client",
        redirect_uris: b.redirect_uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: method,
      },
      201,
    );
  });

  const page = (title: string, body: string, status: 200 | 400 = 200) =>
    new Response(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Sink</title>
<style>
  :root { color-scheme: light dark; --bg:#fdf7ff; --card:#f3edf7; --fg:#1d1b20; --muted:#49454f; --primary:#6750a4; --on-primary:#fff; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141218; --card:#211f26; --fg:#e6e0e9; --muted:#cac4d0; --primary:#d0bcff; --on-primary:#381e72; } }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, sans-serif; padding:16px; box-sizing:border-box; }
  .card { background:var(--card); border-radius:28px; padding:28px; max-width:420px; width:100%; box-sizing:border-box; }
  h1 { font-size:24px; margin:0 0 8px; font-weight:500; }
  p { color:var(--muted); margin:0 0 16px; }
  ul { color:var(--muted); padding-left:20px; margin:0 0 20px; }
  .row { display:flex; gap:12px; justify-content:flex-end; flex-wrap:wrap; }
  button { font:inherit; font-weight:500; border:0; border-radius:20px; padding:10px 22px; cursor:pointer; }
  .allow { background:var(--primary); color:var(--on-primary); }
  .deny { background:transparent; color:var(--primary); }
  code { font-size:13px; word-break:break-all; }
</style>
<div class="card">${body}</div></html>`,
      { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" } },
    );

  app.get("/oauth/authorize", (c) => {
    sweep();
    const q = c.req.query();
    const client = q.client_id ? getClient(q.client_id) : null;
    // Without a known client and an exact registered redirect URI, never redirect anywhere.
    if (!client) return page("Unknown app", "<h1>Unknown app</h1><p>This app isn't registered with Sink. Try adding the connector again.</p>", 400);
    const uris = JSON.parse(client.redirect_uris) as string[];
    const redirectUri = q.redirect_uri ?? (uris.length === 1 ? uris[0]! : "");
    if (!uris.includes(redirectUri)) return page("Bad redirect", "<h1>Bad redirect</h1><p>The app asked to return somewhere it didn't register.</p>", 400);

    const back = (params: Record<string, string>) => {
      const u = new URL(redirectUri);
      for (const [k, v] of Object.entries({ ...params, ...(q.state && { state: q.state }) })) u.searchParams.set(k, v);
      return c.redirect(u.toString(), 302);
    };
    if (q.response_type !== "code") return back({ error: "unsupported_response_type" });
    if (!q.code_challenge || q.code_challenge_method !== "S256") {
      return back({ error: "invalid_request", error_description: "PKCE with S256 is required" });
    }

    if (!sessionSubject(c)) {
      const here = `/oauth/authorize?${new URLSearchParams(q)}`;
      return c.redirect(`/api/auth/oidc/start?client=web&next=${encodeURIComponent(here)}`, 302);
    }

    const id = random();
    consents.set(id, { clientId: client.id, redirectUri, challenge: q.code_challenge, state: q.state, created: now() });
    const host = new URL(redirectUri).host;
    return page(
      "Allow access",
      `<h1>Allow ${esc(client.name)} to use your Sink?</h1>
<p>It will be able to:</p>
<ul><li>search and read your notes</li><li>create notes and replace their text</li><li>see and add todos</li></ul>
<p>You'll go back to <code>${esc(host)}</code>. Revoke it any time in Sink's Settings.</p>
<form method="post" action="/oauth/authorize" class="row">
  <input type="hidden" name="request" value="${id}">
  <button class="deny" name="decision" value="deny">Cancel</button>
  <button class="allow" name="decision" value="allow" autofocus>Allow</button>
</form>`,
    );
  });

  // The session cookie is SameSite=Lax, so a cross-site form can't post here as the user.
  app.post("/oauth/authorize", async (c) => {
    sweep();
    const form = await c.req.parseBody();
    const request = typeof form.request === "string" ? form.request : "";
    const consent = consents.get(request);
    consents.delete(request);
    if (!consent) return page("Expired", "<h1>That took too long</h1><p>Start connecting again from the app.</p>", 400);
    const subject = sessionSubject(c);
    if (!subject) return page("Signed out", "<h1>Signed out</h1><p>Sign in to Sink and connect again.</p>", 400);

    const u = new URL(consent.redirectUri);
    if (consent.state) u.searchParams.set("state", consent.state);
    if (form.decision !== "allow") {
      u.searchParams.set("error", "access_denied");
      return c.redirect(u.toString(), 302);
    }
    const code = random();
    codes.set(code, { clientId: consent.clientId, redirectUri: consent.redirectUri, challenge: consent.challenge, subject, created: now() });
    u.searchParams.set("code", code);
    return c.redirect(u.toString(), 302);
  });

  /** client_secret_basic, client_secret_post, or a public client with just its id. */
  function clientCredentials(c: Context, form: Record<string, unknown>) {
    const basic = c.req.header("authorization")?.match(/^Basic (.+)$/i)?.[1];
    if (basic) {
      const [id, secret] = Buffer.from(basic, "base64").toString().split(":").map(decodeURIComponent);
      return { id: id ?? "", secret: secret ?? null };
    }
    return { id: String(form.client_id ?? ""), secret: typeof form.client_secret === "string" ? form.client_secret : null };
  }

  function issue(clientId: string, clientName: string, subject: string) {
    const access = auth.issueToken(`${clientName} (MCP)`, subject, "mcp");
    const tokenId = auth.verify(access)!;
    const refresh = `sinkr_${random()}`;
    db.query("INSERT INTO oauth_refresh (token_hash, token_id, client_id, created_at) VALUES (?, ?, ?, ?)").run(
      sha256(refresh),
      tokenId,
      clientId,
      now(),
    );
    return { access_token: access, token_type: "Bearer", refresh_token: refresh, scope: SCOPE };
  }

  app.post("/oauth/token", async (c) => {
    sweep();
    const form = await c.req.parseBody();
    const creds = clientCredentials(c, form);
    const client = getClient(creds.id);
    if (!client) return tokenError(c, "invalid_client", "unknown client", 401);
    if (client.secret_hash && (!creds.secret || sha256(creds.secret) !== client.secret_hash)) {
      return tokenError(c, "invalid_client", "bad client secret", 401);
    }
    const ok = (body: object) => c.json(body, 200, { "cache-control": "no-store" });

    if (form.grant_type === "authorization_code") {
      const code = String(form.code ?? "");
      const entry = codes.get(code);
      codes.delete(code);
      if (!entry || entry.clientId !== client.id) return tokenError(c, "invalid_grant", "code expired or not for this client");
      if (form.redirect_uri !== undefined && form.redirect_uri !== entry.redirectUri) return tokenError(c, "invalid_grant", "redirect_uri mismatch");
      if (typeof form.code_verifier !== "string" || s256(form.code_verifier) !== entry.challenge) {
        return tokenError(c, "invalid_grant", "PKCE verification failed");
      }
      return ok(issue(client.id, client.name, entry.subject));
    }

    if (form.grant_type === "refresh_token") {
      const row = db
        .query<{ token_id: string; client_id: string }, [string]>("SELECT token_id, client_id FROM oauth_refresh WHERE token_hash = ?")
        .get(sha256(String(form.refresh_token ?? "")));
      if (!row || row.client_id !== client.id) return tokenError(c, "invalid_grant", "unknown refresh token");
      const subject = auth.subjectOf(row.token_id);
      if (subject === null) return tokenError(c, "invalid_grant", "access was revoked");
      // Rotate: the old access token and its refresh token stop working.
      auth.revoke(row.token_id);
      return ok(issue(client.id, client.name, subject));
    }

    return tokenError(c, "unsupported_grant_type", "use authorization_code or refresh_token");
  });

  // RFC 7009: always 200, whether or not the token existed.
  app.post("/oauth/revoke", async (c) => {
    const form = await c.req.parseBody();
    const token = String(form.token ?? "");
    const refresh = db.query<{ token_id: string }, [string]>("SELECT token_id FROM oauth_refresh WHERE token_hash = ?").get(sha256(token));
    const tokenId = refresh?.token_id ?? auth.verify(token);
    if (tokenId) auth.revoke(tokenId);
    return c.body(null, 200);
  });

  return app;
}
