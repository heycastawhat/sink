import { Hono } from "hono";
import { z } from "zod";
import { requestOrigin, requireFullScope, type Auth, type AuthEnv } from "../auth";
import { matchesEntry, type Oidc } from "../oidc";
import type { Users } from "../users";
import type { Passkeys } from "../passkeys";

// One allowlist entry: `you@example.com`, `email:…`, `user:name` or `sub:…` (see matchesEntry).
const entryBody = z.object({ entry: z.string().trim().min(1).max(200).regex(/^[^\s,]+$/) });

/** The owner's Settings → People: who may sign in, and the accounts that have. */
export function adminRoutes(users: Users, auth: Auth, oidc: Oidc, passkeys: Passkeys, publicUrls: string[]) {
  const app = new Hono<AuthEnv>();
  app.use("*", requireFullScope, async (c, next) => (users.isOwner(c.get("subject")) ? next() : c.json({ error: "not allowed" }, 403)));

  app.get("/users", (c) =>
    c.json({ accounts: users.accounts(), allowed: users.allowed(), configured: oidc.allowlist, invites: passkeys.invites() }),
  );

  // An invite link for someone without an account at the sign-in provider: they make a passkey with it, once.
  app.post("/invites", async (c) => {
    const body = z.object({ name: z.string().trim().min(1).max(60) }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "give them a name" }, 400);
    const { token, invite } = passkeys.invite(body.data.name);
    const origin = publicUrls.includes(requestOrigin(c)) ? requestOrigin(c) : publicUrls[0];
    return c.json({ ...invite, url: `${origin}/?invite=${token}` }, 201);
  });

  app.delete("/invites/:id", (c) => {
    passkeys.cancelInvite(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/users/allowed", async (c) => {
    const body = entryBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "enter an email, user:name or sub:id" }, 400);
    users.allow(body.data.entry);
    return c.json({ allowed: users.allowed() }, 201);
  });

  // Taking someone off the list also signs them out, unless another entry still lets them in. Their notes stay.
  app.delete("/users/allowed", (c) => {
    const entry = c.req.query("entry") ?? "";
    users.disallow(entry);
    // Someone also in an allowed group can sign back in; groups aren't known until they do.
    const still = [...oidc.allowlist.users, ...users.allowed()];
    for (const a of users.accounts()) {
      // A passkey account's username is just the name on its invite, and passkey sign-in goes by its sub alone.
      const passkey = a.subject.startsWith("passkey:");
      const id = passkey ? { sub: a.subject } : { sub: a.subject, email: a.email ?? undefined, username: a.username ?? undefined };
      if (a.owner || !matchesEntry(entry, id) || still.some((e) => matchesEntry(e, id))) continue;
      auth.revokeAll(a.subject);
    }
    return c.json({ allowed: users.allowed() });
  });

  return app;
}
