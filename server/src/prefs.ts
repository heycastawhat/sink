import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { z } from "zod";
import { requireFullScope, type AuthEnv } from "./auth";

/** Settings that follow an account between browsers. Each is checked here, so a client can't store anything else. */
const prefsBody = z
  .object({
    layout: z.enum(["classic", "keep", "split", "tabs"]),
    layoutChosen: z.boolean(),
  })
  .partial()
  .strict();

export function prefRoutes(db: Database) {
  const app = new Hono<AuthEnv>();
  const read = () =>
    Object.fromEntries(
      db.query<{ key: string; value: string }, []>("SELECT key, value FROM prefs").all().map((r) => [r.key, JSON.parse(r.value)]),
    );
  app.use("/prefs", requireFullScope);
  app.get("/prefs", (c) => c.json(read()));
  app.patch("/prefs", async (c) => {
    const body = prefsBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid prefs" }, 400);
    const set = db.query("INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
    db.transaction(() => {
      for (const [k, v] of Object.entries(body.data)) set.run(k, JSON.stringify(v));
    })();
    return c.json(read());
  });
  return app;
}
