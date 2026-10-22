import { z } from "zod";

const discoverySchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
});

const tokenSchema = z.object({ id_token: z.string() });

const claimsSchema = z.object({
  iss: z.string(),
  sub: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  nonce: z.string().optional(),
  email: z.string().optional(),
  preferred_username: z.string().optional(),
  groups: z.array(z.string()).optional(),
});

export type Identity = { sub: string; email?: string; username?: string; groups: string[] };

export type OidcConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  // Optional extra gate on top of authentik's own application policies.
  allowedUsers: string[];
  allowedGroups: string[];
};

/**
 * Authorization code flow with PKCE against authentik (or any OIDC provider).
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

  private discover() {
    this.discovery ??= (async () => {
      const url = this.cfg.issuer.replace(/\/?$/, "/") + ".well-known/openid-configuration";
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`discovery failed: HTTP ${res.status}`);
      return discoverySchema.parse(await res.json());
    })().catch((err) => {
      // Don't cache failures; authentik might just be restarting.
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
    const res = await this.fetchImpl(d.token_endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: "Basic " + btoa(`${encodeURIComponent(this.cfg.clientId)}:${encodeURIComponent(this.cfg.clientSecret)}`),
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: p.code,
        redirect_uri: p.redirectUri,
        code_verifier: p.verifier,
      }),
    });
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

    return { sub: claims.sub, email: claims.email, username: claims.preferred_username, groups: claims.groups ?? [] };
  }

  allowed(id: Identity): boolean {
    const { allowedUsers, allowedGroups } = this.cfg;
    if (!allowedUsers.length && !allowedGroups.length) return true;
    const names = [id.sub, id.email, id.username].filter(Boolean).map((s) => s!.toLowerCase());
    return (
      allowedUsers.some((u) => names.includes(u.toLowerCase())) ||
      allowedGroups.some((g) => id.groups.includes(g))
    );
  }
}
