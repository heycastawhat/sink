import { Hono } from "hono";
import { z } from "zod";
import { requireFullScope, type Auth, type AuthEnv } from "../auth";
import { matchesEntry, type Oidc } from "../oidc";
import type { Users } from "../users";

// One allowlist entry: `you@example.com`, `email:…`, `user:name` or `sub:…` (see matchesEntry).
const entryBody = z.object({ entry: z.string().trim().min(1).max(200).regex(/^[^\s,]+$/) });

/** The owner's Settings → People: who may sign in, and the accounts that have. */
export function adminRoutes(users: Users, auth: Auth, oidc: Oidc) {
  const app = new Hono<AuthEnv>();
  app.use("*", requireFullScope, async (c, next) => (users.isOwner(c.get("subject")) ? next() : c.json({ error: "not allowed" }, 403)));

  app.get("/users", (c) => c.json({ accounts: users.accounts(), allowed: users.allowed(), configured: oidc.allowlist }));

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
      const id = { sub: a.subject, email: a.email ?? undefined, username: a.username ?? undefined };
      if (a.owner || !matchesEntry(entry, id) || still.some((e) => matchesEntry(e, id))) continue;
      auth.revokeAll(a.subject);
    }
    return c.json({ allowed: users.allowed() });
  });

  return app;
}
