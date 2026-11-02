import type { Database } from "bun:sqlite";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { newId, now } from "./db";
import { requestOrigin } from "./auth";
import type { Oidc } from "./oidc";
import type { Users } from "./users";
import { clientIp, rateLimit } from "./ratelimit";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGES = 500;

const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const random = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

export type Invite = { id: string; name: string; created_at: number; expires_at: number };
type Passkey = { id: string; subject: string; public_key: Uint8Array; counter: number; transports: string | null };

/**
 * Passkeys, for people who have no account at the sign-in provider. The owner invites someone by name (Settings →
 * People); the link lets them make a passkey once, which makes their account and puts `sub:passkey:…` on the
 * allowlist, so removing them there works as it does for everyone else.
 */
export class Passkeys {
  constructor(private db: Database) {}

  /** A new invite link's secret; only its hash is kept. */
  invite(name: string): { token: string; invite: Invite } {
    const token = random();
    const invite = { id: sha256(token), name, created_at: now(), expires_at: now() + INVITE_TTL_MS };
    this.db.query("INSERT INTO invites (id, name, created_at, expires_at) VALUES (?, ?, ?, ?)").run(invite.id, name, invite.created_at, invite.expires_at);
    return { token, invite };
  }

  invites(): Invite[] {
    return this.db.query<Invite, [number]>("SELECT * FROM invites WHERE expires_at > ? ORDER BY created_at").all(now());
  }

  cancelInvite(id: string) {
    this.db.query("DELETE FROM invites WHERE id = ?").run(id);
  }

  inviteFor(token: string): Invite | null {
    return this.db.query<Invite, [string, number]>("SELECT * FROM invites WHERE id = ? AND expires_at > ?").get(sha256(token), now());
  }

  any(): boolean {
    return !!this.db.query("SELECT 1 FROM passkeys").get();
  }

  get(id: string): Passkey | null {
    return this.db.query<Passkey, [string]>("SELECT * FROM passkeys WHERE id = ?").get(id);
  }

  add(p: Omit<Passkey, "transports"> & { transports?: string[] }) {
    this.db
      .query("INSERT INTO passkeys (id, subject, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(p.id, p.subject, p.public_key, p.counter, JSON.stringify(p.transports ?? []), now());
  }

  used(id: string, counter: number) {
    this.db.query("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?").run(counter, now(), id);
  }
}

export type SignedIn = { client: "web" | "android"; device: string; challenge?: string; next?: string };

const signInFields = {
  client: z.enum(["web", "android"]).default("web"),
  device: z.string().max(100).optional(),
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
  next: z.string().max(2000).regex(/^\/(?![\/\\])/).optional(),
};
const registerBody = z.object({ flow: z.string(), invite: z.string(), response: z.any(), device: z.string().max(100).optional() });
const loginBody = z.object({ flow: z.string(), response: z.any(), ...signInFields });

/**
 * WebAuthn ceremonies under /api/auth/passkey. `finish` signs the account in the way OIDC does (a cookie, or the
 * Android hand-back) and returns where the page should go next.
 */
export function passkeyRoutes(deps: {
  passkeys: Passkeys;
  users: Users;
  oidc: Oidc;
  publicUrls: string[];
  finish: (c: Context, to: SignedIn, subject: string) => string;
}) {
  const { passkeys, users, oidc, publicUrls, finish } = deps;
  const app = new Hono();
  const challenges = new Map<string, { challenge: string; created: number }>();
  const limited = rateLimit(30, 10 * 60_000);

  const remember = (challenge: string) => {
    const t = now();
    for (const [k, v] of challenges) if (t - v.created > CHALLENGE_TTL_MS) challenges.delete(k);
    while (challenges.size >= MAX_CHALLENGES) challenges.delete(challenges.keys().next().value!);
    const flow = random();
    challenges.set(flow, { challenge, created: t });
    return flow;
  };
  const take = (flow: string) => {
    const entry = challenges.get(flow);
    challenges.delete(flow);
    return entry && now() - entry.created <= CHALLENGE_TTL_MS ? entry.challenge : null;
  };
  // A passkey belongs to one host name, so only the origins Sink was told about.
  const origin = (c: Context) => {
    const o = requestOrigin(c);
    return publicUrls.includes(o) ? { origin: o, rpID: new URL(o).hostname } : null;
  };

  app.use("*", async (c, next) => (limited(clientIp(c)) ? next() : c.json({ error: "too many attempts, try again later" }, 429)));

  app.get("/invite", (c) => {
    const invite = passkeys.inviteFor(c.req.query("token") ?? "");
    return invite ? c.json({ name: invite.name }) : c.json({ error: "this invite has expired or was already used" }, 404);
  });

  app.post("/register/options", async (c) => {
    const body = z.object({ invite: z.string() }).safeParse(await c.req.json().catch(() => null));
    const invite = body.success ? passkeys.inviteFor(body.data.invite) : null;
    const where = origin(c);
    if (!invite || !where) return c.json({ error: "this invite has expired or was already used" }, 404);
    const options = await generateRegistrationOptions({
      rpName: "Sink",
      rpID: where.rpID,
      userName: invite.name,
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    return c.json({ flow: remember(options.challenge), options });
  });

  app.post("/register", async (c) => {
    const body = registerBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    const challenge = take(body.data.flow);
    const invite = passkeys.inviteFor(body.data.invite);
    const where = origin(c);
    if (!challenge || !invite || !where) return c.json({ error: "this invite has expired or was already used" }, 400);
    const result = await verifyRegistrationResponse({
      response: body.data.response,
      expectedChallenge: challenge,
      expectedOrigin: where.origin,
      expectedRPID: where.rpID,
      requireUserVerification: false,
    }).catch(() => null);
    if (!result?.verified) return c.json({ error: "couldn't check that passkey" }, 400);
    const { credential } = result.registrationInfo;
    const subject = `passkey:${newId()}`;
    passkeys.cancelInvite(invite.id);
    passkeys.add({ id: credential.id, subject, public_key: credential.publicKey, counter: credential.counter, transports: credential.transports });
    users.allow(`sub:${subject}`);
    users.seen({ sub: subject, username: invite.name });
    return c.json({ redirect: finish(c, { client: "web", device: body.data.device ?? "Web" }, subject) });
  });

  app.post("/login/options", async (c) => {
    const where = origin(c);
    if (!where) return c.json({ error: "passkeys only work on Sink's own address" }, 400);
    const options = await generateAuthenticationOptions({ rpID: where.rpID, userVerification: "preferred" });
    return c.json({ flow: remember(options.challenge), options });
  });

  app.post("/login", async (c) => {
    const body = loginBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    if (body.data.client === "android" && !body.data.challenge) return c.json({ error: "missing challenge" }, 400);
    const challenge = take(body.data.flow);
    const where = origin(c);
    const key = typeof body.data.response?.id === "string" ? passkeys.get(body.data.response.id) : null;
    if (!challenge || !where || !key) return c.json({ error: "that passkey isn't one Sink knows" }, 400);
    const result = await verifyAuthenticationResponse({
      response: body.data.response,
      expectedChallenge: challenge,
      expectedOrigin: where.origin,
      expectedRPID: where.rpID,
      credential: { id: key.id, publicKey: new Uint8Array(key.public_key), counter: key.counter, transports: JSON.parse(key.transports ?? "[]") },
      requireUserVerification: false,
    }).catch(() => null);
    if (!result?.verified) return c.json({ error: "couldn't check that passkey" }, 400);
    passkeys.used(key.id, result.authenticationInfo.newCounter);
    if (!oidc.allowed({ sub: key.subject, groups: [] }, users.allowed())) return c.json({ error: "This account isn't allowed to use Sink." }, 403);
    users.touch(key.subject);
    const { client, device, challenge: appChallenge, next } = body.data;
    return c.json({ redirect: finish(c, { client, device: device ?? (client === "android" ? "Android" : "Web"), challenge: appChallenge, next }, key.subject) });
  });

  return app;
}
