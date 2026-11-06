import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "../auth";
import { ClipError, extractArticle, fetchPage } from "../clip";
import { VaultError, type Vault } from "../notes";
import { rateLimit } from "../ratelimit";
import { localIso } from "../time";

const clipBody = z.object({ url: z.string().max(2048), folder: z.string().max(1024).default("") });

/** `allowHost` is for tests that serve a page from localhost; nothing in the app's config sets it. */
export function clipRoutes(vault: Vault, timeZone: string, allowHost?: string) {
  const app = new Hono<AuthEnv>();
  // Each clip makes the server fetch an arbitrary site, so cap them per account.
  const allowed = rateLimit(20, 60_000);

  app.post("/clip", async (c) => {
    const body = clipBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    if (!allowed(c.get("subject"))) return c.json({ error: "slow down" }, 429);
    try {
      const page = await fetchPage(body.data.url, allowHost);
      const { title, markdown } = extractArticle(page.html, page.url);
      const content = [
        ["---", `source: ${JSON.stringify(page.url)}`, `clipped: ${localIso(new Date(), timeZone).slice(0, 10)}`, "---"].join("\n"),
        `# ${title}`,
        markdown,
      ]
        .filter(Boolean)
        .join("\n\n") + "\n";
      return c.json(await vault.create(body.data.folder, title, content), 201);
    } catch (err) {
      if (err instanceof ClipError || err instanceof VaultError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  return app;
}
