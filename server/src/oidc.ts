import { z } from "zod";

const discoverySchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
});

const tokenSchema = z.object({ id_token: z.string() });

const claimsSchema = z.object({
  iss: z.string(),
  sub: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  nonce: z.string().optional(),
  email: z.string().optional(),
  // Some providers send "true" as a string.
  email_verified: z.union([z.boolean(), z.string()]).optional(),
  preferred_username: z.string().optional(),
  groups: z.array(z.string()).optional(),
});

export type Identity = { sub: string; email?: string; username?: string; groups: string[] };

export type OidcConfig = {
  issuer: string;
  clientId: string;
  // Empty for a public client (PKCE only).
  clientSecret: string;
  // Who may sign in: sub, preferred_username or verified email; or group names. Empty lists let nobody in,
  // unless allowAnyone is set (only sensible when the provider itself restricts who can use the app).
  allowedUsers: string[];
  allowedGroups: string[];
  allowAnyone: boolean;
  // Provider name for the sign-in button.
  name?: string;
};

/**
 * Authorization code flow with PKCE against any OIDC provider (authentik, Pocket ID, Keycloak, Google, …).
 *
 * The ID token comes straight from the token endpoint over TLS with client authentication,
 * so per OIDC Core 3.1.3.7 we check iss/aud/exp/nonce but don't need to verify its signature.
 */
export class Oidc {
  private discovery: Promise<z.infer<typeof discoverySchema>> | undefined;

  constructor(
    private cfg: OidcConfig,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  get name(): string {
    return this.cfg.name ?? "";
  }

  private discover() {
    this.discovery ??= (async () => {
      const url = this.cfg.issuer.replace(/\/?$/, "/") + ".well-known/openid-configuration";
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`discovery failed: HTTP ${res.status}`);
      return discoverySchema.parse(await res.json());
    })().catch((err) => {
      // Don't cache failures; the provider might just be restarting.
      this.discovery = undefined;
      throw err;
    });
    return this.discovery;
  }

  async authorizeUrl(p: { redirectUri: string; state: string; nonce: string; challenge: string }) {
    const d = await this.discover();
    const url = new URL(d.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.cfg.clientId,
      redirect_uri: p.redirectUri,
      scope: "openid email profile",
      state: p.state,
      nonce: p.nonce,
      code_challenge: p.challenge,
      code_challenge_method: "S256",
    }).toString();
    return url.toString();
  }

  async exchange(p: { code: string; redirectUri: string; verifier: string; nonce: string }): Promise<Identity> {
    const d = await this.discover();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: p.code,
      redirect_uri: p.redirectUri,
      code_verifier: p.verifier,
    });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    // Client secret in a Basic header (the OIDC default), in the body if that's all the provider takes,
    // or not at all for a public client.
    const methods = d.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
    if (!this.cfg.clientSecret) body.set("client_id", this.cfg.clientId);
    else if (!methods.includes("client_secret_basic") && methods.includes("client_secret_post")) {
      body.set("client_id", this.cfg.clientId);
      body.set("client_secret", this.cfg.clientSecret);
    } else {
      headers.authorization = "Basic " + btoa(`${encodeURIComponent(this.cfg.clientId)}:${encodeURIComponent(this.cfg.clientSecret)}`);
    }
    const res = await this.fetchImpl(d.token_endpoint, { method: "POST", signal: AbortSignal.timeout(15_000), headers, body });
    if (!res.ok) throw new Error(`token endpoint: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const { id_token } = tokenSchema.parse(await res.json());

    const payload = id_token.split(".")[1];
    if (!payload) throw new Error("malformed id_token");
    const claims = claimsSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));

    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss.replace(/\/$/, "") !== d.issuer.replace(/\/$/, "")) throw new Error("issuer mismatch");
    if (!audiences.includes(this.cfg.clientId)) throw new Error("audience mismatch");
    if (claims.exp * 1000 < Date.now()) throw new Error("id_token expired");
    if (claims.nonce !== p.nonce) throw new Error("nonce mismatch");

    // An unverified email is just a string the user typed; it can't grant access.
    const verified = claims.email_verified === true || claims.email_verified === "true";
    return {
      sub: claims.sub,
      email: verified ? claims.email : undefined,
      username: claims.preferred_username,
      groups: claims.groups ?? [],
    };
  }

  /**
   * Each allowlist entry matches one kind of claim only, so a username someone picks at the provider can't pose as
   * an email or subject: `you@example.com` / `email:…` = verified email, `user:name` = preferred_username (only safe
   * where usernames are admin-assigned), `sub:…` or anything else = the provider's subject ID.
   */
  allowed(id: Identity): boolean {
    const { allowedUsers, allowedGroups, allowAnyone } = this.cfg;
    if (allowAnyone) return true;
    const lower = (s?: string) => s?.toLowerCase();
    const matches = (entry: string) => {
      const [, kind, value] = /^(email|user|sub):(.*)$/i.exec(entry) ?? [null, entry.includes("@") ? "email" : "sub", entry];
      const want = value!.toLowerCase();
      if (kind!.toLowerCase() === "email") return !!id.email && lower(id.email) === want;
      if (kind!.toLowerCase() === "user") return !!id.username && lower(id.username) === want;
      return id.sub.toLowerCase() === want;
    };
    return allowedUsers.some(matches) || allowedGroups.some((g) => id.groups.includes(g));
  }

}
